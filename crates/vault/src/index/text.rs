//! What each kind is found by: the one function the index is written from.
//!
//! [`text_of`] is the entity's own row and children, then the words that
//! **label** it (the tags and flags on it, the lists and albums that hold it,
//! the notebook, folder, project, section, calendar, account or category it is
//! filed under), then the live notes `about` it. The entity's own title is the
//! index's `title` column and is never in this text.
//!
//! ## The census of text columns
//!
//! Every `TEXT` column of the baseline is one of: the entity's own text, text
//! folded into what it labels, or not indexed. The rule is that a column a
//! member types, or a title that names a group a thing belongs to, is findable
//! through the thing; the table below is checked against the baseline by
//! `every_text_column_is_findable_folded_into_what_it_labels_or_argued_out` in
//! `crates/vault/tests/commitments.rs`, which also holds the table.
//!
//! A renamed or removed labelling entity re-indexes what it labelled:
//! [`crate::index::reindex`] asks the question in the other direction.

use rusqlite::Connection;

use crate::error::Result;
use crate::model::Kind;

/// The kinds a member searches for: every kind [`text_of`] has an answer for.
/// A flag, a calendar, a category or an account is not in the index as itself:
/// its title is part of the text of what it labels, so a member finds a
/// transaction by its category and an event by its calendar. A Locker item is
/// found by its plain fields only ([`text_of`]); a sealed cell is never text.
pub const SEARCHABLE: [Kind; 15] = [
    Kind::Person,
    Kind::Place,
    Kind::Event,
    Kind::Task,
    Kind::Activity,
    Kind::Note,
    Kind::Document,
    Kind::Photo,
    Kind::Txn,
    Kind::Thread,
    Kind::Notebook,
    Kind::Folder,
    Kind::Album,
    Kind::Project,
    Kind::LockerItem,
];

/// The text a kind is found by, beside its title: its own row and children, the
/// words that label it, and the live notes `about` it. `None` is a kind nobody
/// searches. The title is the entity's own and is indexed beside this, never in
/// it.
///
/// Public so a reader that wants a snippet can ask the same question the index
/// was written from: the index is contentless and cannot say which words matched.
///
/// # Errors
/// Whatever SQLite refused.
pub fn text_of(connection: &Connection, id: &str, kind: Kind) -> Result<Option<String>> {
    let own = match kind {
        Kind::Person => joined(
            connection,
            "SELECT nickname FROM person WHERE id = ?1
             UNION ALL SELECT role FROM person WHERE id = ?1
             UNION ALL SELECT met FROM person WHERE id = ?1
             UNION ALL SELECT value FROM contact_point WHERE person_id = ?1
             UNION ALL SELECT label FROM contact_point WHERE person_id = ?1
             UNION ALL SELECT r.title FROM (
                 SELECT label_id FROM edge WHERE rel = 'related' AND from_id = ?1
                 UNION SELECT label_id FROM edge WHERE rel = 'related' AND to_id = ?1) l
               JOIN entity r ON r.id = l.label_id",
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
             UNION ALL SELECT pl.address FROM event v JOIN place pl ON pl.id = v.place_id WHERE v.id = ?1
             UNION ALL SELECT c.title FROM event v JOIN entity c ON c.id = v.calendar_id WHERE v.id = ?1
             UNION ALL SELECT title FROM (
                 SELECT title FROM occurrence WHERE series_id = ?1 AND title IS NOT NULL
                  ORDER BY original_start, scope)
             UNION ALL SELECT description FROM (
                 SELECT description FROM occurrence WHERE series_id = ?1 AND description IS NOT NULL
                  ORDER BY original_start, scope)",
            id,
        )?,
        Kind::Task => joined(
            connection,
            "SELECT description FROM task WHERE id = ?1
             UNION ALL SELECT p.title FROM task t JOIN entity p ON p.id = t.project_id WHERE t.id = ?1
             UNION ALL SELECT s.title FROM task t JOIN entity s ON s.id = t.section_id WHERE t.id = ?1",
            id,
        )?,
        Kind::Activity => joined(
            connection,
            "SELECT k.title FROM activity a JOIN entity k ON k.id = a.type_id WHERE a.id = ?1
             UNION ALL SELECT p.title FROM activity a JOIN entity p ON p.id = a.place_id WHERE a.id = ?1
             UNION ALL SELECT pl.address FROM activity a JOIN place pl ON pl.id = a.place_id WHERE a.id = ?1
             UNION ALL SELECT pl.locality FROM activity a JOIN place pl ON pl.id = a.place_id WHERE a.id = ?1",
            id,
        )?,
        Kind::Note => joined(
            connection,
            "SELECT body FROM note WHERE id = ?1
             UNION ALL SELECT b.title FROM note n JOIN entity b ON b.id = n.notebook_id WHERE n.id = ?1",
            id,
        )?,
        Kind::Document => joined(
            connection,
            "SELECT d.text FROM document c JOIN derivative d ON d.blob = c.blob
              WHERE c.id = ?1 AND d.variant = 'text'
             UNION ALL SELECT f.title FROM document c JOIN entity f ON f.id = c.folder_id
              WHERE c.id = ?1",
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
        Kind::Txn => joined(
            connection,
            "SELECT c.title FROM txn t JOIN entity c ON c.id = t.category_id WHERE t.id = ?1
             UNION ALL SELECT a.title FROM txn t JOIN entity a ON a.id = t.account_id WHERE t.id = ?1",
            id,
        )?,
        Kind::Thread => joined(
            connection,
            "SELECT text FROM message WHERE thread_id = ?1 AND role = 'user' ORDER BY ordinal",
            id,
        )?,
        // A container is found by the container it nests in: a project by its
        // area, a folder or notebook by the one above it.
        Kind::Notebook | Kind::Folder | Kind::Project => joined(
            connection,
            "SELECT p.title FROM container c JOIN entity p ON p.id = c.parent_id WHERE c.id = ?1",
            id,
        )?,
        Kind::Album => String::new(),
        // A Locker item is found by what it shows in the clear: its title (the
        // index's own column), the plain cells below, its aliases and extra
        // addresses, then the tags and notes folded in below like any other
        // kind. **Never a sealed cell** (`SEALED_ITEM_CELLS`), a sealed custom
        // field's `value_sealed`, or a passkey's key: the plaintext gate hunts
        // for each in the index and its word list.
        Kind::LockerItem => joined(
            connection,
            "SELECT username FROM locker_item WHERE id = ?1
             UNION ALL SELECT url FROM locker_item WHERE id = ?1
             UNION ALL SELECT notes FROM locker_item WHERE id = ?1
             UNION ALL SELECT fullname FROM locker_item WHERE id = ?1
             UNION ALL SELECT email FROM locker_item WHERE id = ?1
             UNION ALL SELECT phone FROM locker_item WHERE id = ?1
             UNION ALL SELECT brand FROM locker_item WHERE id = ?1
             UNION ALL SELECT memo FROM locker_item WHERE id = ?1
             UNION ALL SELECT alias FROM (
                 SELECT alias FROM locker_item_alias WHERE item_id = ?1 ORDER BY alias)
             UNION ALL SELECT url FROM (
                 SELECT url FROM locker_item_address WHERE item_id = ?1
                  ORDER BY position, address_id)",
            id,
        )?,
        _ => return Ok(None),
    };
    // Held by a list or an album, and tagged or flagged: the words of the
    // groups it belongs to. Tags and flags are in title order so that the text
    // is the same however the edges were added.
    let held = joined(
        connection,
        "SELECT h.title FROM edge e JOIN entity h ON h.id = e.from_id
          WHERE e.rel = 'contains' AND e.to_id = ?1
          ORDER BY h.title, h.id",
        id,
    )?;
    let labelled = joined(
        connection,
        "SELECT t.title FROM edge e JOIN entity t ON t.id = e.to_id
          WHERE e.rel = 'tagged' AND e.from_id = ?1
          ORDER BY t.title, t.id",
        id,
    )?;
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
        [own, held, labelled, notes, touches]
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
