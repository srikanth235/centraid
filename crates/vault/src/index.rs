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
//! `n` for the kind and the trash filter.
//!
//! A Locker item is in the index by its **plain** text only ([`text_of`]: never
//! a sealed cell, a sealed field's value or a passkey key). Whether a surface
//! offers it is a question for its readers (the assistant's search kinds leave
//! `locker_item` out), not for the index.
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

pub use text::{MIN_PHONE_DIGITS, SEARCHABLE, text_of, untitled_label};

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
    for id in touched {
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
    // What a title is part of the text of is written a bounded piece at a time: a label of
    // thousands (an album trashed) would hold the vault for seconds. The first piece lands in
    // this commit; the rest is owed (`search_owed`), and `reindex_owed` writes it a batch at a
    // time. A reader sees the label's old words on the members still owed until then.
    for id in touched {
        let mut piece = dependents_after(connection, id, "", INLINE_DEPENDENTS + 1)?;
        if piece.len() > INLINE_DEPENDENTS {
            piece.truncate(INLINE_DEPENDENTS);
            connection.execute(
                "INSERT INTO search_owed (id, after) VALUES (?1, ?2)
                 ON CONFLICT (id) DO UPDATE SET after = excluded.after",
                rusqlite::params![id, piece.last().map_or("", String::as_str)],
            )?;
        }
        work.extend(piece);
    }
    for id in &work {
        reindex_one(connection, id)?;
    }
    Ok(())
}

/// How many entities a label's title feeds that one commit re-indexes itself: about 20 ms of the
/// vault, inside the call budget (`crates/core/tests/write_costs.rs` measures it).
pub const INLINE_DEPENDENTS: usize = 50;

/// How many an owed label's batch re-indexes.
pub const OWED_BATCH: usize = INLINE_DEPENDENTS;

/// The ids [`DEPENDENTS`] names for `id` after `after`, in id order, at most `limit`.
fn dependents_after(
    connection: &Connection,
    id: &str,
    after: &str,
    limit: usize,
) -> Result<Vec<String>> {
    // `?1` is the touched id in every arm of the union; `?2` and `?3` bound the piece.
    let sql =
        format!("SELECT DISTINCT dep FROM ({DEPENDENTS}) WHERE dep > ?2 ORDER BY dep LIMIT ?3");
    Ok(connection
        .prepare_cached(&sql)?
        .query_map(
            rusqlite::params![id, after, i64::try_from(limit).unwrap_or(i64::MAX)],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<_>>()?)
}

/// Write the next batch of the search rows a commit left owed; returns how many labels still
/// have members owed.
///
/// # Errors
/// SQLite's refusal.
pub fn reindex_owed(connection: &Connection, limit: usize) -> Result<usize> {
    let next: Option<(String, String)> = connection
        .query_row(
            "SELECT id, after FROM search_owed ORDER BY id LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((id, after)) = next {
        let mut piece = dependents_after(connection, &id, &after, limit + 1)?;
        let finished = piece.len() <= limit;
        piece.truncate(limit);
        for member in &piece {
            reindex_one(connection, member)?;
        }
        match (finished, piece.last()) {
            (false, Some(last)) => {
                connection.execute(
                    "UPDATE search_owed SET after = ?2 WHERE id = ?1",
                    rusqlite::params![id, last],
                )?;
            }
            _ => {
                connection.execute("DELETE FROM search_owed WHERE id = ?1", [&id])?;
            }
        }
    }
    Ok(
        connection.query_row("SELECT count(*) FROM search_owed", [], |row| {
            row.get::<_, i64>(0)
        })? as usize,
    )
}

/// How many labels still have members owed a search row.
///
/// # Errors
/// SQLite's refusal.
pub fn owed(connection: &Connection) -> Result<usize> {
    Ok(
        connection.query_row("SELECT EXISTS (SELECT 1 FROM search_owed)", [], |row| {
            row.get::<_, i64>(0)
        })? as usize,
    )
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
    SELECT id AS dep FROM task WHERE project_id = ?1
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
    connection.execute("DELETE FROM search_owed", [])?;
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
