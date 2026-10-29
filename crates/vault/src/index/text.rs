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

use rusqlite::{Connection, OptionalExtension};

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
               JOIN entity r ON r.id = l.label_id AND r.deleted_at IS NULL",
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
             UNION ALL SELECT p.title FROM event v JOIN entity p ON p.id = v.place_id AND p.deleted_at IS NULL WHERE v.id = ?1
             UNION ALL SELECT pl.address FROM event v JOIN place pl ON pl.id = v.place_id
               JOIN entity pe ON pe.id = pl.id AND pe.deleted_at IS NULL WHERE v.id = ?1
             UNION ALL SELECT c.title FROM event v JOIN entity c ON c.id = v.calendar_id AND c.deleted_at IS NULL WHERE v.id = ?1
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
             UNION ALL SELECT p.title FROM task t JOIN entity p ON p.id = t.project_id AND p.deleted_at IS NULL WHERE t.id = ?1
             UNION ALL SELECT s.title FROM task t JOIN entity s ON s.id = t.section_id AND s.deleted_at IS NULL WHERE t.id = ?1",
            id,
        )?,
        Kind::Activity => joined(
            connection,
            "SELECT k.title FROM activity a JOIN entity k ON k.id = a.type_id AND k.deleted_at IS NULL WHERE a.id = ?1
             UNION ALL SELECT p.title FROM activity a JOIN entity p ON p.id = a.place_id AND p.deleted_at IS NULL WHERE a.id = ?1
             UNION ALL SELECT pl.address FROM activity a JOIN place pl ON pl.id = a.place_id
               JOIN entity pe ON pe.id = pl.id AND pe.deleted_at IS NULL WHERE a.id = ?1
             UNION ALL SELECT pl.locality FROM activity a JOIN place pl ON pl.id = a.place_id
               JOIN entity pe ON pe.id = pl.id AND pe.deleted_at IS NULL WHERE a.id = ?1",
            id,
        )?,
        Kind::Note => joined(
            connection,
            "SELECT body FROM note WHERE id = ?1
             UNION ALL SELECT b.title FROM note n JOIN entity b ON b.id = n.notebook_id AND b.deleted_at IS NULL WHERE n.id = ?1",
            id,
        )?,
        Kind::Document => joined(
            connection,
            "SELECT d.text FROM document c JOIN derivative d ON d.blob = c.blob
              WHERE c.id = ?1 AND d.variant = 'text'
             UNION ALL SELECT f.title FROM document c JOIN entity f ON f.id = c.folder_id AND f.deleted_at IS NULL
              WHERE c.id = ?1",
            id,
        )?,
        Kind::Photo => joined(
            connection,
            "SELECT d.text FROM photo c JOIN derivative d ON d.blob = c.blob
              WHERE c.id = ?1 AND d.variant = 'caption'
             UNION ALL SELECT p.title FROM photo v JOIN entity p ON p.id = v.place_id AND p.deleted_at IS NULL WHERE v.id = ?1
             UNION ALL SELECT pl.address FROM photo v JOIN place pl ON pl.id = v.place_id
               JOIN entity pe ON pe.id = pl.id AND pe.deleted_at IS NULL WHERE v.id = ?1
             UNION ALL SELECT pl.locality FROM photo v JOIN place pl ON pl.id = v.place_id
               JOIN entity pe ON pe.id = pl.id AND pe.deleted_at IS NULL WHERE v.id = ?1",
            id,
        )?,
        Kind::Txn => joined(
            connection,
            "SELECT c.title FROM txn t JOIN entity c ON c.id = t.category_id AND c.deleted_at IS NULL WHERE t.id = ?1
             UNION ALL SELECT a.title FROM txn t JOIN entity a ON a.id = t.account_id AND a.deleted_at IS NULL WHERE t.id = ?1",
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
            "SELECT p.title FROM container c JOIN entity p ON p.id = c.parent_id AND p.deleted_at IS NULL WHERE c.id = ?1",
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
        "SELECT h.title FROM edge e JOIN entity h ON h.id = e.from_id AND h.deleted_at IS NULL
          WHERE e.rel = 'contains' AND e.to_id = ?1
          ORDER BY h.title, h.id",
        id,
    )?;
    let labelled = joined(
        connection,
        "SELECT t.title FROM edge e JOIN entity t ON t.id = e.to_id AND t.deleted_at IS NULL
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
    // What the kinds that carry a telephone number add: the number's digits
    // alone, so it is found without its punctuation.
    let digits = match kind {
        Kind::Person => phone_digits(
            connection,
            "SELECT value FROM contact_point WHERE person_id = ?1 AND kind = 'phone'",
            id,
        )?,
        Kind::LockerItem => phone_digits(
            connection,
            "SELECT phone FROM locker_item WHERE id = ?1",
            id,
        )?,
        _ => String::new(),
    };
    // A photograph with no title is found by the day it was taken.
    let dated = if kind == Kind::Photo {
        untitled_photo(connection, id)?
            .map(|day| day.words())
            .unwrap_or_default()
    } else {
        String::new()
    };
    Ok(Some(
        [own, dated, digits, held, labelled, notes, touches]
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

/// The digit-only forms of each telephone number a one-parameter query returns,
/// one per line: all the digits, and, for a number written with a leading `+`,
/// the digits after a country code of one, two or three digits. A member types
/// the national part (`5551234` for `+1 (555) 123-4567`) and the index finds
/// words by their start, so the national part has to start a word of its own.
fn phone_digits(connection: &Connection, sql: &str, id: &str) -> Result<String> {
    let mut statement = connection.prepare_cached(sql)?;
    let values = statement
        .query_map([id], |row| row.get::<_, Option<String>>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut forms: Vec<String> = Vec::new();
    for value in values.into_iter().flatten() {
        let digits: String = value.chars().filter(char::is_ascii_digit).collect();
        if digits.len() < MIN_PHONE_DIGITS {
            continue;
        }
        let mut add = |form: &str| {
            if !forms.iter().any(|held| held == form) {
                forms.push(form.to_owned());
            }
        };
        add(&digits);
        if value.trim_start().starts_with('+') {
            for country in 1..=3 {
                if digits.len() >= country + MIN_PHONE_DIGITS {
                    add(&digits[country..]);
                }
            }
        }
    }
    Ok(forms.join("\n"))
}

/// The fewest digits a number needs to have a digit-only form of its own: a
/// shorter run is an extension or a code, found as the words it is written as.
pub const MIN_PHONE_DIGITS: usize = 5;

/// The day an untitled photograph was taken, or `None` for one that has a title.
struct Day {
    taken: Option<(i32, u32, u32)>,
}

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

impl Day {
    /// `Photo · 12 Mar 2026`; `Photo` when no day is known.
    fn label(&self) -> String {
        match self.taken {
            Some((year, month, day)) => {
                format!("Photo · {day} {} {year}", &MONTHS[month as usize - 1][..3])
            }
            None => "Photo".to_owned(),
        }
    }

    /// What the index holds for it: the label's words and the full month name.
    fn words(&self) -> String {
        match self.taken {
            Some((year, month, day)) => format!(
                "{}\n{day} {} {year}",
                self.label(),
                MONTHS[month as usize - 1]
            ),
            None => self.label(),
        }
    }
}

/// The day of a photograph with an empty title; `None` when it has a title.
fn untitled_photo(connection: &Connection, id: &str) -> Result<Option<Day>> {
    let row: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT e.title, p.taken_at FROM photo p JOIN entity e ON e.id = p.id WHERE p.id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row
        .filter(|(title, _)| title.trim().is_empty())
        .map(|(_, taken_at)| Day {
            taken: taken_at.as_deref().and_then(day_of),
        }))
}

/// `(year, month, day)` of the date a stored instant starts with.
fn day_of(text: &str) -> Option<(i32, u32, u32)> {
    let date = text.get(..10)?;
    let mut parts = date.split('-');
    let year = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day = parts.next()?.parse().ok()?;
    ((1..=12).contains(&month) && (1..=31).contains(&day)).then_some((year, month, day))
}

/// The label a search answers an untitled photograph under (`Photo · 12 Mar
/// 2026`), or `None` for any other entity or a photograph that has a title.
/// The door asks it so that every reader of a hit gets a readable row.
///
/// # Errors
/// Whatever SQLite refused.
pub fn untitled_label(connection: &Connection, id: &str, kind: Kind) -> Result<Option<String>> {
    if kind != Kind::Photo {
        return Ok(None);
    }
    Ok(untitled_photo(connection, id)?.map(|day| day.label()))
}
