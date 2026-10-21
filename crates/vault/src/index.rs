//! The one search index, kept by the writer.
//!
//! `search` is a contentless FTS5 table whose rowid is `entity.n`. A command
//! never writes it: it calls `ctx.touch(id)`, and at commit the guard hands
//! every touched id here ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//!
//! A live entity whose kind has a search text gets its row replaced; anything
//! else (trashed, a kind nobody searches, nothing to say) has its row deleted.
//! The search text is [`text_of`], one function over the entity's own row and
//! children, plus the bodies of the live notes `about` it, so a person is found
//! by what you wrote about them, and by what you wrote about a touch that was
//! `with` them (an interaction's note). A read joins `entity` on `n` for the kind and
//! the trash filter; Locker is not in the index at all.
//!
//! `tests/commitments.rs` rebuilds the index from scratch after a scripted run
//! of every command and compares it with the incremental one, so a command
//! that forgot to touch is red.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension};

use crate::error::Result;
use crate::model::Kind;

/// Re-index the touched ids, and whatever their text feeds.
///
/// A note's body is part of the text of everything it is `about`, so a touched
/// note brings its targets with it; and of the people a touch it is about was
/// `with`, so it brings those too.
pub fn reindex(connection: &Connection, touched: &BTreeSet<String>) -> Result<()> {
    let mut work = touched.clone();
    let mut about = connection.prepare_cached(
        "SELECT e.to_id FROM edge e JOIN entity n ON n.id = e.from_id
          WHERE e.from_id = ?1 AND e.rel = 'about' AND n.kind = 'note'",
    )?;
    let mut with = connection
        .prepare_cached("SELECT w.to_id FROM edge w WHERE w.from_id = ?1 AND w.rel = 'with'")?;
    // The words of a task's project and of an event's or a photograph's place
    // are part of its own text: renaming either brings what is filed under it.
    let mut dependents = connection.prepare_cached(
        "SELECT id FROM task WHERE project_id = ?1
         UNION ALL SELECT id FROM event WHERE place_id = ?1
         UNION ALL SELECT id FROM photo WHERE place_id = ?1",
    )?;
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

/// Throw the index away and write it again from the rows.
///
/// What the commitment test compares the incremental index with, and what a
/// restored vault with a damaged index would run.
pub fn rebuild(connection: &Connection) -> Result<()> {
    connection.execute("DELETE FROM search", [])?;
    let ids = connection
        .prepare("SELECT id FROM entity ORDER BY n")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in &ids {
        reindex_one(connection, id)?;
    }
    Ok(())
}

/// Drop one entity's row from the index by its `n`: what a purge does before
/// it deletes the entity, because after it the `n` is not findable.
pub fn forget(connection: &Connection, n: i64) -> Result<()> {
    connection.execute("DELETE FROM search WHERE rowid = ?1", [n])?;
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
    Ok(())
}

/// The kinds a member searches for: every kind [`text_of`] has an answer for.
/// A flag, a calendar, a category or a transaction is not in the index, and
/// Locker is not even an entity.
pub const SEARCHABLE: [Kind; 13] = [
    Kind::Person,
    Kind::Place,
    Kind::Event,
    Kind::Task,
    Kind::Activity,
    Kind::Note,
    Kind::Document,
    Kind::Photo,
    Kind::Thread,
    Kind::Notebook,
    Kind::Folder,
    Kind::Album,
    Kind::Project,
];

/// The text a kind is found by, beside its title: its own row and children, and
/// the live notes `about` it. `None` is a kind nobody searches. The title is the
/// entity's own and is indexed beside this, never in it.
///
/// Public so a reader that wants a snippet can ask the same question the index
/// was written from: the index is contentless and cannot say which words matched.
pub fn text_of(connection: &Connection, id: &str, kind: Kind) -> Result<Option<String>> {
    let own = match kind {
        Kind::Person => joined(
            connection,
            "SELECT nickname FROM person WHERE id = ?1
             UNION ALL SELECT role FROM person WHERE id = ?1
             UNION ALL SELECT met FROM person WHERE id = ?1
             UNION ALL SELECT value FROM contact_point WHERE person_id = ?1
             UNION ALL SELECT label FROM contact_point WHERE person_id = ?1",
            id,
        )?,
        Kind::Place => joined(
            connection,
            "SELECT address FROM place WHERE id = ?1
             UNION ALL SELECT locality FROM place WHERE id = ?1",
            id,
        )?,
        Kind::Event => joined(
            connection,
            "SELECT description FROM event WHERE id = ?1
             UNION ALL SELECT p.title FROM event v JOIN entity p ON p.id = v.place_id WHERE v.id = ?1
             UNION ALL SELECT pl.address FROM event v JOIN place pl ON pl.id = v.place_id WHERE v.id = ?1",
            id,
        )?,
        Kind::Task => joined(
            connection,
            "SELECT description FROM task WHERE id = ?1
             UNION ALL SELECT p.title FROM task t JOIN entity p ON p.id = t.project_id WHERE t.id = ?1",
            id,
        )?,
        Kind::Note => joined(connection, "SELECT body FROM note WHERE id = ?1", id)?,
        Kind::Document => joined(
            connection,
            "SELECT d.text FROM document c JOIN derivative d ON d.blob = c.blob
              WHERE c.id = ?1 AND d.variant = 'text'",
            id,
        )?,
        Kind::Photo => joined(
            connection,
            "SELECT d.text FROM photo c JOIN derivative d ON d.blob = c.blob
              WHERE c.id = ?1 AND d.variant = 'caption'
             UNION ALL SELECT p.title FROM photo v JOIN entity p ON p.id = v.place_id WHERE v.id = ?1
             UNION ALL SELECT pl.address FROM photo v JOIN place pl ON pl.id = v.place_id WHERE v.id = ?1
             UNION ALL SELECT pl.locality FROM photo v JOIN place pl ON pl.id = v.place_id WHERE v.id = ?1",
            id,
        )?,
        Kind::Thread => joined(
            connection,
            "SELECT text FROM message WHERE thread_id = ?1 AND role = 'user' ORDER BY ordinal",
            id,
        )?,
        Kind::Activity | Kind::Notebook | Kind::Folder | Kind::Album | Kind::Project => String::new(),
        _ => return Ok(None),
    };
    let notes = if kind == Kind::Note {
        String::new()
    } else {
        joined(
            connection,
            "SELECT n.body FROM edge e
               JOIN entity ne ON ne.id = e.from_id AND ne.deleted_at IS NULL
               JOIN note n ON n.id = e.from_id
              WHERE e.rel = 'about' AND e.to_id = ?1
              ORDER BY ne.created_at, ne.id",
            id,
        )?
    };
    // A person is also found by what was written about a touch that was with them.
    let touches = if kind == Kind::Person {
        joined(
            connection,
            "SELECT n.body FROM edge w
               JOIN edge e ON e.to_id = w.from_id AND e.rel = 'about'
               JOIN entity ne ON ne.id = e.from_id AND ne.deleted_at IS NULL
               JOIN note n ON n.id = e.from_id
              WHERE w.rel = 'with' AND w.to_id = ?1
              ORDER BY ne.created_at, ne.id",
            id,
        )?
    } else {
        String::new()
    };
    Ok(Some(
        [own, notes, touches]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    ))
}

/// The non-empty text cells of a one-parameter query, one per line.
fn joined(connection: &Connection, sql: &str, id: &str) -> Result<String> {
    let mut statement = connection.prepare_cached(sql)?;
    let cells = statement
        .query_map([id], |row| row.get::<_, Option<String>>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(cells
        .into_iter()
        .flatten()
        .filter(|cell| !cell.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n"))
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
