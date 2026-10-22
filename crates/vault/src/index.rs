//! The one search index, kept by the writer.
//!
//! `search` is a contentless FTS5 table whose rowid is `entity.n`. A command
//! never writes it: it calls `ctx.touch(id)`, and at commit the guard hands
//! every touched id here ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//!
//! A live entity whose kind has a search text gets its row replaced; anything
//! else (trashed, a kind nobody searches, nothing to say) has its row deleted.
//! The search text is [`text_of`], one function over the entity's own row and
//! children, the titles of what labels it (its tags and flags, the lists and
//! albums that hold it, the notebook, folder, project, calendar, category or
//! account it is filed under), and the bodies of the live notes `about` it, so a
//! person is found by what you wrote about them, and by what you wrote about a
//! touch that was `with` them (an interaction's note). A read joins `entity` on
//! `n` for the kind and the trash filter; Locker is not in the index at all.
//!
//! `tests/commitments.rs` rebuilds the index from scratch after a scripted run
//! of every command and compares it with the incremental one, so a command
//! that forgot to touch is red.

use std::collections::{BTreeSet, HashSet};

use centraid_ontology::text::index_words;

use rusqlite::{Connection, OptionalExtension};

use crate::error::Result;
use crate::model::Kind;

mod text;

pub use text::{SEARCHABLE, text_of};

/// Re-index the touched ids, and whatever their text feeds.
///
/// A note's body is part of the text of everything it is `about`, so a touched
/// note brings its targets with it; and of the people a touch it is about was
/// `with`, so it brings those too. A title is part of the text of everything it
/// labels ([`DEPENDENTS`]), so a touched tag, list, project or account brings
/// what it labels.
pub fn reindex(connection: &Connection, touched: &BTreeSet<String>) -> Result<()> {
    let mut work = touched.clone();
    let mut about = connection.prepare_cached(
        "SELECT e.to_id FROM edge e JOIN entity n ON n.id = e.from_id
          WHERE e.from_id = ?1 AND e.rel = 'about' AND n.kind = 'note'",
    )?;
    let mut with = connection
        .prepare_cached("SELECT w.to_id FROM edge w WHERE w.from_id = ?1 AND w.rel = 'with'")?;
    let mut dependents = connection.prepare_cached(DEPENDENTS)?;
    for id in touched {
        work.extend(
            dependents
                .query_map([id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );
        let targets = about
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for target in &targets {
            work.extend(
                with.query_map([target], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            );
        }
        work.extend(targets);
    }
    for id in &work {
        reindex_one(connection, id)?;
    }
    Ok(())
}

/// Whatever a touched entity's title is part of the text of: one parameter, the
/// touched id, and one arm per way a thing is labelled. Each arm is an indexed
/// lookup and answers nothing for an entity that labels nothing, so asking it of
/// every touched id costs a handful of probes.
///
/// A link added or removed (a tag put on a note, a photograph put in an album)
/// is not a touch of the label, so the command that writes the link marks the
/// labelled end for the index itself.
const DEPENDENTS: &str = "\
    SELECT id FROM task WHERE project_id = ?1
    UNION ALL SELECT id FROM task WHERE section_id = ?1
    UNION ALL SELECT id FROM event WHERE place_id = ?1
    UNION ALL SELECT id FROM event WHERE calendar_id = ?1
    UNION ALL SELECT id FROM photo WHERE place_id = ?1
    UNION ALL SELECT id FROM activity WHERE place_id = ?1
    UNION ALL SELECT id FROM activity WHERE type_id = ?1
    UNION ALL SELECT id FROM note WHERE notebook_id = ?1
    UNION ALL SELECT id FROM document WHERE folder_id = ?1
    UNION ALL SELECT id FROM container WHERE parent_id = ?1
    UNION ALL SELECT id FROM txn WHERE category_id = ?1
    UNION ALL SELECT id FROM txn WHERE account_id = ?1
    UNION ALL SELECT from_id FROM edge WHERE to_id = ?1 AND rel = 'tagged'
    UNION ALL SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'contains'
    UNION ALL SELECT from_id FROM edge WHERE label_id = ?1
    UNION ALL SELECT to_id FROM edge WHERE label_id = ?1";

/// Throw the index away and write it again from the rows.
///
/// What the commitment test compares the incremental index with, and what a
/// restored vault with a damaged index would run.
pub fn rebuild(connection: &Connection) -> Result<()> {
    connection.execute("DELETE FROM search", [])?;
    // The word list is rewritten from the rows too: this is where a word an edit
    // dropped finally goes.
    connection.execute("DELETE FROM search_word", [])?;
    let ids = connection
        .prepare("SELECT id FROM entity ORDER BY n")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in &ids {
        reindex_one(connection, id)?;
    }
    // A rebuilt index is a new one, and the planner has statistics of the old.
    optimize(connection);
    Ok(())
}

/// Let SQLite re-analyse the tables whose shape changed enough since they were
/// last analysed (`PRAGMA optimize`), reading at most 1,000 index entries of
/// each so that the cost is bounded however large the vault is.
///
/// Called when a vault closes and when the index is rebuilt. **A failure is
/// ignored**: the statistics are advisory (without them a plan is slower, never
/// wrong), and neither a close nor a rebuild may fail for the sake of them.
pub(crate) fn optimize(connection: &Connection) {
    let _ = connection.execute_batch("PRAGMA analysis_limit = 1000; PRAGMA optimize;");
}

/// Drop one entity's row from the index by its `n`.
fn forget(connection: &Connection, n: i64) -> Result<()> {
    connection.execute("DELETE FROM search WHERE rowid = ?1", [n])?;
    Ok(())
}

/// What a purge does before it deletes the entity, because after it the `n` is
/// not findable: drop its row from the index, and its words from the word list
/// unless some other row still holds them.
///
/// **This is the only place a word leaves the list while the vault runs, and it
/// can only name the words the entity holds now.** The index is contentless, so
/// an edit that drops a word cannot say which word it dropped: the word stays in
/// the list, through a later purge of the entity too, until a [`rebuild`]
/// rewrites the list from the rows. The list is therefore always a superset of
/// the index's own vocabulary and never misses a word the index can find. What a
/// purge asks of the index is its vocabulary after the row is gone
/// (`search_vocab` reflects a delete at once), so a word another row holds is
/// kept.
pub fn purge(connection: &Connection, id: &str) -> Result<()> {
    let row: Option<(i64, String, String)> = connection
        .query_row(
            "SELECT n, kind, title FROM entity WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((n, kind, title)) = row else {
        return Ok(());
    };
    let body = match Kind::parse(&kind) {
        Some(kind) => text_of(connection, id, kind)?.unwrap_or_default(),
        None => String::new(),
    };
    forget(connection, n)?;
    let mut held = connection.prepare_cached("SELECT 1 FROM search_vocab WHERE term = ?1")?;
    let mut drop = connection.prepare_cached("DELETE FROM search_word WHERE word = ?1")?;
    for word in distinct_words(&[&title, &body]) {
        if !held.exists([&word])? {
            drop.execute([&word])?;
        }
    }
    Ok(())
}

/// The words of some texts, in the order they first appear, each once.
fn distinct_words(texts: &[&str]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut words = Vec::new();
    for text in texts {
        for word in index_words(text) {
            if !seen.contains(&word) {
                seen.insert(word.clone());
                words.push(word);
            }
        }
    }
    words
}

/// Add the words of a text just indexed to the list. A word already in the list
/// keeps its number.
fn remember(connection: &Connection, title: &str, body: &str) -> Result<()> {
    let mut add =
        connection.prepare_cached("INSERT OR IGNORE INTO search_word (word) VALUES (?1)")?;
    for word in distinct_words(&[title, body]) {
        add.execute([&word])?;
    }
    Ok(())
}

fn reindex_one(connection: &Connection, id: &str) -> Result<()> {
    let row: Option<(i64, String, String, Option<String>)> = connection
        .query_row(
            "SELECT n, kind, title, deleted_at FROM entity WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    // Gone: the purge that removed it forgot its row.
    let Some((n, kind, title, deleted_at)) = row else {
        return Ok(());
    };
    forget(connection, n)?;
    if deleted_at.is_some() {
        return Ok(());
    }
    let Some(kind) = Kind::parse(&kind) else {
        return Ok(());
    };
    let Some(body) = text_of(connection, id, kind)? else {
        return Ok(());
    };
    if title.trim().is_empty() && body.trim().is_empty() {
        return Ok(());
    }
    connection.execute(
        "INSERT INTO search (rowid, title, body) VALUES (?1, ?2, ?3)",
        rusqlite::params![n, title, body],
    )?;
    remember(connection, &title, &body)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The list a reader filters by and the function the index is written from
    /// are one fact: a kind is in `SEARCHABLE` exactly when `text_of` has an
    /// answer for it.
    #[test]
    fn the_searchable_kinds_are_the_kinds_text_of_answers_for() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = crate::Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault
            .read(|connection| {
                for kind in Kind::ALL {
                    let answered = text_of(connection, "no-such-entity", kind)?.is_some();
                    assert_eq!(answered, SEARCHABLE.contains(&kind), "{}", kind.as_str());
                }
                Ok(())
            })
            .expect("reads");
    }
}
