//! WHAT AN ITEM SAID BEFORE: the earlier versions' typed text, in `search_past` (#1185).
//!
//! The owner's ruling is that every field a member typed is findable and that note history has
//! no exemption. A kept `revision` holds the entity's state before a commit changed it, so the
//! words a member replaced are still in the vault, and this module puts the typed ones in the
//! index beside the words the item holds now.
//!
//! ## The rows
//!
//! One `search_past` row per kept version whose typed text is not empty, keyed
//! `entity.n << 24 | revision.seq` ([`past_rowid`]): the row names its entity and its version,
//! and every row of an entity is one rowid range ([`forget_entity`]). The index is contentless,
//! so a row is written once, when the version is born, and never rewritten; it goes with the
//! entity's trash or purge, in the same transaction as the change that sent it away.
//!
//! ## What a row holds, and what it does not
//!
//! The typed text of the state ([`EARLIER_COLUMNS`], the same columns the census in
//! `tests/commitments.rs` reaches as `Own` for the live row), the entity's title in the title
//! column, and a note's words from the revision's `body` cell. **A value is indexed where it
//! first appears.** A version holds a table's text only when that table's state differs from the
//! version before it (and its title only when the title does), and a note's `body` cell is
//! already kept only when the commit changed the words (`history::keep`), so an item edited a
//! hundred times in one field carries each distinct value once and not a hundred copies. What a
//! version leaves out is in the version that introduced it or, for what the item still says, in
//! the live row.
//!
//! The text is the item's own. The words that LABEL it (its tags, notebook, calendar) are the
//! live item's, not something that was typed into an earlier version, so a row never holds one.
//!
//! **Only a kind with an Earlier versions page has past rows** ([`EARLIER_KINDS`]): the hit
//! opens that page, where the words can be read. A Locker item has none: its history is sealed
//! (owner decisions D4 and D11), and the plain cells it keeps are no more findable from the past
//! than a sealed one.
//!
//! ## What a reader may ask
//!
//! The door asks `search_past` only for an item that does not match what it says now, and says
//! so on the row ("In an earlier version"): an item that matches both is the live item once.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value as Json;

use crate::error::{Result, VaultError};
use crate::model::Kind;

/// The typed text of an earlier state, by table: a kind's own columns and its children's. Each
/// is a column of the live census (`Reach::Own`), which a test holds.
pub const EARLIER_COLUMNS: &[(&str, &[&str])] = &[
    ("person", &["nickname", "role", "met"]),
    ("contact_point", &["value", "label"]),
    ("place", &["address", "locality"]),
    ("event", &["description", "url"]),
    ("occurrence", &["title", "description", "url"]),
    ("task", &["description", "url"]),
];

/// The bits of the rowid a version's number takes; a version numbered beyond them is not
/// indexed (sixteen million edits of one record).
const SEQ_BITS: u32 = 24;

/// The rowid of one version's row.
#[must_use]
pub fn past_rowid(n: i64, seq: i64) -> Option<i64> {
    (0..(1_i64 << SEQ_BITS))
        .contains(&seq)
        .then_some((n << SEQ_BITS) | seq)
}

/// The kinds that have past rows: the ones with an Earlier versions page to open, where the
/// words a hit matched can be read (note, event, task, person, document, photo, transaction,
/// activity: a workout's page is Health's). A container, a chat thread or a place keeps
/// versions, but no screen lists them, and a hit that opens an item whose past cannot be seen
/// would be a hit the member cannot check. A Locker item has none: its history is sealed (owner
/// decisions D4 and D11).
///
/// An activity has no typed text column of its own (its kind, its place and its times are
/// concepts, links and instants, and a workout's measures are numbers), so its past row holds
/// the title the member gave it, and [`EARLIER_COLUMNS`] has no line for it.
pub const EARLIER_KINDS: [Kind; 8] = [
    Kind::Note,
    Kind::Event,
    Kind::Task,
    Kind::Person,
    Kind::Document,
    Kind::Photo,
    Kind::Txn,
    Kind::Activity,
];

fn has_past(kind: Kind) -> bool {
    EARLIER_KINDS.contains(&kind)
}

/// The title and the text of one version, with only what it introduced: `older` is the version
/// before it, `None` for the first.
#[must_use]
pub fn version_text(state: &Json, older: Option<&Json>, body: Option<&str>) -> (String, String) {
    let title_of = |state: &Json| {
        state
            .pointer("/entity/title")
            .and_then(Json::as_str)
            .map(str::to_owned)
    };
    let title = title_of(state)
        .filter(|title| older.is_none_or(|older| title_of(older).as_ref() != Some(title)))
        .unwrap_or_default();
    let mut lines: Vec<&str> = Vec::new();
    for (table, columns) in EARLIER_COLUMNS {
        let Some(part) = state.get(table) else {
            continue;
        };
        if older.and_then(|older| older.get(table)) == Some(part) {
            continue;
        }
        let rows: Vec<&Json> = match part {
            Json::Array(rows) => rows.iter().collect(),
            row => vec![row],
        };
        for row in rows {
            for column in *columns {
                if let Some(text) = row.get(column).and_then(Json::as_str)
                    && !text.trim().is_empty()
                {
                    lines.push(text);
                }
            }
        }
    }
    if let Some(body) = body.filter(|body| !body.trim().is_empty()) {
        lines.push(body);
    }
    (title, lines.join("\n"))
}

fn parse(text: &str) -> Result<Json> {
    serde_json::from_str(text).map_err(|source| VaultError::Json {
        context: "a revision's state as the index reads it".to_owned(),
        source,
    })
}

/// The entity's row the past index needs: its `n` and its kind, `None` when it is gone, in the
/// trash, or of a kind that has no past rows.
fn eligible(connection: &Connection, id: &str) -> Result<Option<i64>> {
    let row: Option<(i64, String, Option<String>)> = connection
        .query_row(
            "SELECT n, kind, deleted_at FROM entity WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    Ok(row.and_then(|(n, kind, deleted_at)| {
        (deleted_at.is_none() && Kind::parse(&kind).is_some_and(has_past)).then_some(n)
    }))
}

fn write(connection: &Connection, n: i64, seq: i64, title: &str, body: &str) -> Result<()> {
    let Some(rowid) = past_rowid(n, seq) else {
        return Ok(());
    };
    if title.trim().is_empty() && body.trim().is_empty() {
        return Ok(());
    }
    connection
        .prepare_cached("INSERT INTO search_past (rowid, title, body) VALUES (?1, ?2, ?3)")?
        .execute(rusqlite::params![rowid, title, body])?;
    super::remember(connection, title, body)
}

/// A version was just kept (`history::keep`): index its row. `state` is the state as kept (a
/// note's words are in `body`, not in it), `seq` the number it was given.
///
/// # Errors
/// SQLite's refusal.
pub(crate) fn version_kept(
    connection: &Connection,
    id: &str,
    seq: i64,
    state: &Json,
    body: Option<&str>,
) -> Result<()> {
    let Some(n) = eligible(connection, id)? else {
        return Ok(());
    };
    let older: Option<String> = if seq > 1 {
        connection
            .prepare_cached("SELECT state FROM revision WHERE entity_id = ?1 AND seq = ?2")?
            .query_row(rusqlite::params![id, seq - 1], |row| row.get(0))
            .optional()?
    } else {
        None
    };
    let older = older.as_deref().map(parse).transpose()?;
    let (title, text) = version_text(state, older.as_ref(), body);
    write(connection, n, seq, &title, &text)
}

/// Whether the entity has any past row.
fn present(connection: &Connection, n: i64) -> Result<bool> {
    let (low, high) = (n << SEQ_BITS, (n << SEQ_BITS) | ((1 << SEQ_BITS) - 1));
    Ok(connection
        .prepare_cached("SELECT 1 FROM search_past WHERE rowid BETWEEN ?1 AND ?2 LIMIT 1")?
        .exists(rusqlite::params![low, high])?)
}

/// The rows of a live entity are there: written when it has none (it came out of the trash, or
/// the index was thrown away). Work is the entity's own versions, once.
///
/// # Errors
/// SQLite's refusal.
pub(crate) fn ensure(connection: &Connection, id: &str) -> Result<()> {
    let Some(n) = eligible(connection, id)? else {
        return Ok(());
    };
    let has_versions = connection
        .prepare_cached("SELECT 1 FROM revision WHERE entity_id = ?1 LIMIT 1")?
        .exists([id])?;
    if !has_versions || present(connection, n)? {
        return Ok(());
    }
    for (seq, title, text) in texts(connection, id)? {
        write(connection, n, seq, &title, &text)?;
    }
    Ok(())
}

/// Every row of an entity leaves the index (it went to the trash, or is being purged).
///
/// # Errors
/// SQLite's refusal.
pub(crate) fn forget_entity(connection: &Connection, n: i64) -> Result<()> {
    let (low, high) = (n << SEQ_BITS, (n << SEQ_BITS) | ((1 << SEQ_BITS) - 1));
    connection
        .prepare_cached("DELETE FROM search_past WHERE rowid BETWEEN ?1 AND ?2")?
        .execute(rusqlite::params![low, high])?;
    Ok(())
}

/// What each kept version of an entity indexes, oldest first: its number, its title and its text.
fn texts(connection: &Connection, id: &str) -> Result<Vec<(i64, String, String)>> {
    let mut statement = connection.prepare_cached(
        "SELECT seq, state, body FROM revision WHERE entity_id = ?1 ORDER BY seq",
    )?;
    let rows = statement
        .query_map([id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut older: Option<Json> = None;
    let mut out = Vec::with_capacity(rows.len());
    for (seq, state, body) in rows {
        let state = parse(&state)?;
        let (title, text) = version_text(&state, older.as_ref(), body.as_deref());
        out.push((seq, title, text));
        older = Some(state);
    }
    Ok(out)
}

/// The text each earlier version of an item indexes, newest first, for a reader that wants a
/// snippet of a match found in the past. A Locker item has none.
///
/// # Errors
/// SQLite's refusal.
pub fn earlier_texts(connection: &Connection, id: &str) -> Result<Vec<String>> {
    let kind: Option<String> = connection
        .query_row("SELECT kind FROM entity WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?;
    if !kind.as_deref().and_then(Kind::parse).is_some_and(has_past) {
        return Ok(Vec::new());
    }
    Ok(texts(connection, id)?
        .into_iter()
        .rev()
        .map(|(_, title, text)| format!("{title}\n{text}"))
        .collect())
}

/// The words a purged entity's past rows hold, each once.
///
/// # Errors
/// SQLite's refusal.
pub(crate) fn words_of(connection: &Connection, id: &str) -> Result<Vec<String>> {
    let kind: Option<String> = connection
        .query_row("SELECT kind FROM entity WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?;
    if !kind.as_deref().and_then(Kind::parse).is_some_and(has_past) {
        return Ok(Vec::new());
    }
    let mut seen = HashSet::new();
    let mut words = Vec::new();
    for (_, title, text) in texts(connection, id)? {
        for word in super::distinct_words(&[&title, &text]) {
            if seen.insert(word.clone()) {
                words.push(word);
            }
        }
    }
    Ok(words)
}
