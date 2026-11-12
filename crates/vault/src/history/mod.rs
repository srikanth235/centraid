//! EVERY RECORD KEEPS ITS EARLIER VALUES: the vault's one history (#1185, principle 5).
//!
//! ## What is kept, and when
//!
//! A commit that changes what a member can see of an entity keeps the entity's state **as it was
//! before the commit**, as one `revision` row (`seq` counts up from one per entity). The state is
//! the entity's own row (its title), its kind row, and the child rows that hang off it (a
//! person's contact points, an event's changed days, a task's sub-rows, a Locker item's plain
//! fields). It is captured at the commit door, never by a command: no command writes history, so
//! no command can forget to.
//!
//! **Before, not after.** The current state already lives in the rows; a history made of the
//! states that were replaced never holds a second copy of what a screen reads, and a creation has
//! no "before", so creating N records writes no history at all. A restore reads the row for the
//! version it wants and writes it back through the same tables an edit writes.
//!
//! ## How the door sees it
//!
//! Temp triggers on this connection (installed once per connection, like the `WITHOUT ROWID`
//! census in [`crate::log::guard`]) fire before the first change to an entity's rows in a commit
//! and record its state in a scratch table: `BEFORE UPDATE`/`DELETE` on the entity's title, its
//! kind row and its child rows, `BEFORE INSERT` on a child row. An entity born in the commit is
//! marked so it is never recorded, and one being deleted is marked so its purge computes nothing.
//! Before `COMMIT` the guard ([`settle`]) reads each recorded state, reads the entity's state now,
//! and writes a `revision` only when the two differ: a commit that moved nothing a member can see
//! (a follow pass that restates what is held, a stamp) writes no history. Trash, restore and
//! purge move `deleted_at`/`purge_at`, which are not captured: a trashed record is the same
//! record, and a purge takes its history with it (`revision.entity_id` cascades).
//!
//! The state is computed by one temp view, generated from the schema ([`Shape`]): every column of
//! a kind's row and its children is captured unless [`OMITTED`] says why not, so a column added
//! to the baseline is kept from its first edit with no code, and a table or kind the
//! classification in [`TABLES`] does not know fails a test.
//!
//! ## The form
//!
//! `revision.state` is the canonical JSON ([`crate::canonical`]) of
//! `{"entity": {"title"}, "<kind table>": {col: value}, "<child table>": [{col: value}]}`. A key
//! absent from a version was not captured when it was made (an older schema, or a column added
//! since), which a diff reads as "not known", never as a change. The one thing a state does not
//! carry inline is the entity's **content** ([`CONTENT`]): a note's words and a document's bytes
//! live in `revision.body` / `revision.blob` / `revision.media_type`, because a blob reference
//! must be a real foreign key for the garbage collector to see it and a note's words are the one
//! value large enough to deserve a cell of their own. [`version_state`] puts them back, so
//! there is one state and one place each fact is kept. A commit that leaves a note's words as they
//! were (a title or notebook edit) copies none: that version carries no `note.body`, and a reader
//! takes the words from the next newer version that holds them, else from the note itself.
//!
//! ## A sitting of autosaves is one version
//!
//! A QUIET save (an editor's autosave, which the caller says it is: `Command::quiet`, never
//! inferred from a name) that continues the session of the newest version writes nothing: that
//! version holds the state before the session began, and the record holds the state now. It
//! continues it when the newest version was itself a quiet save of the same command by the same
//! actor, no more than [`SESSION_IDLE_MS`] (ten minutes) have passed since the session's last
//! commit, no more than [`SESSION_CAP_MS`] (an hour) since its first, the command is not the
//! history's own, and no sealed cell changed. Any act that offers an Undo is not quiet, so it is a
//! version of its own and ends the session on both sides. A fold moves `revision.touched_at` and
//! nothing else.
//!
//! A trashed record offers no "Earlier versions" entry ([`offered`]); its versions are kept and the
//! entry returns with the record.
//!
//! ## Secrets, and bytes
//!
//! **A Locker item's sealed cells are kept SEALED** (owner ruling, #1185): a changed password,
//! card number, CVV, note content, one-time-code seed or sealed custom field comes back with a
//! restore like any other column. What is stored is the `lk1:` ciphertext exactly as the live
//! cell holds it (sealed by the core under the member's key, bound to the row's id and the key
//! generation, both of which are kept beside it), copied inside the commit and never opened here:
//! this crate holds no key, so no plaintext of a secret exists in a `revision` row or anywhere
//! else unsealed. Nothing that reads history shows one either: [`earlier_versions`] answers a
//! changed sealed cell as [`MASK`] (a changed secret is seen to have changed, and that is all), and
//! the only door to a value is the core's Locker session, which opens a version's cell with the
//! key behind the member's unlock ([`crate::Vault::locker_sealed_earlier_cell`]). A passkey is
//! state like the rest, its private key sealed the same way and, as it is live, never shown.
//!
//! A version names a blob by hash and copies no bytes. A document's replaced bytes are kept by
//! the `revision.blob` foreign key for as long as the document lives, as they always were; any
//! other hash a version names (an avatar, a cover) is only text, so the bytes live exactly as
//! long as their ordinary rules keep them, and a restore leaves such a field as it is when the
//! bytes are gone.

mod read;
mod restore;
mod shape;
mod write;

pub use read::{
    Change, Earlier, MASK, Record, Version, Who, changed_since, changes_by, count, current_state,
    earlier_versions, head, head_after, offered, record, titles, version_state,
};
pub use restore::{Restored, Scope, restore_changes, restore_version};
pub use shape::{
    CONTENT, Cell, OMITTED, Part, RELATIONS_OUTSIDE, Role, Shape, TABLES, is_sealed, shape,
};
pub use write::{DAY, Kept, keep_overlay, overlay_refusal};

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value as Json;

use crate::canonical::canonical_json;
use crate::error::Result;

/// The scratch table the triggers fill: one row per entity the commit touched, holding its state
/// before the commit (`NULL` for one born or being deleted in it).
pub(crate) const SEEN: &str = "centraid_history_seen";

/// The view of every entity's state now.
pub(crate) const STATE_VIEW: &str = "centraid_entity_state";

/// Install the history's door on a connection: the scratch table, the state view and the
/// triggers. Idempotent. Tables the schema does not have yet are skipped (a file at an earlier
/// rung is opened before its rungs run).
pub(crate) fn install(connection: &Connection) -> Result<()> {
    let shape = Shape::read(connection)?;
    connection.execute_batch(&shape.install_sql())?;
    Ok(())
}

/// Close the history of a commit: for each entity the commit recorded, keep its earlier state
/// if it is not the state it has now. Called with the body's writes made, before `COMMIT`.
///
/// Returns how many versions were written.
pub(crate) fn settle(
    connection: &Connection,
    now: &str,
    cause: &str,
    quiet: bool,
) -> Result<usize> {
    let seen: Vec<(String, String, Option<String>)> = {
        let mut statement = connection.prepare_cached(&format!(
            "SELECT s.entity_id, s.state,
                    (SELECT v.state FROM temp.{STATE_VIEW} v WHERE v.entity_id = s.entity_id)
               FROM temp.{SEEN} s WHERE s.state IS NOT NULL"
        ))?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    // Cleared whether or not anything is kept: the next commit starts with an empty list.
    connection.execute_batch(&format!("DELETE FROM temp.{SEEN}"))?;
    let mut written = 0;
    for (id, before, after) in seen {
        // An entity that is gone (a purge) has no history to add: its rows go with it.
        let Some(after) = after else { continue };
        if before == after {
            continue;
        }
        if quiet && folds(connection, &id, &before, &after, now, cause)? {
            continue;
        }
        keep_as(connection, &id, &before, &after, now, cause, quiet)?;
        written += 1;
    }
    Ok(written)
}

/// Write one version: `state` is the entity's state as the view spells it, `after` what the
/// commit left. A note's words the commit did not change are not copied (a title-only edit keeps
/// no body): the version carries no `note.body`, and a reader takes the words from the next newer
/// version that holds them, else from the note as it is ([`read::fill_body`]).
pub(crate) fn keep(
    connection: &Connection,
    id: &str,
    state: &str,
    after: &str,
    now: &str,
    cause: &str,
) -> Result<()> {
    keep_as(connection, id, state, after, now, cause, false)
}

/// How long a quiet-save session may sit idle before the next quiet save starts a new version.
pub const SESSION_IDLE_MS: i64 = 10 * 60 * 1000;

/// How long a quiet-save session lasts at most, from its first commit, however steadily the
/// member keeps typing: a long sitting leaves a version at least this often.
pub const SESSION_CAP_MS: i64 = 60 * 60 * 1000;

/// Whether this QUIET save continues the session of the entity's newest version, so it writes
/// no version of its own: that version already holds the state before the session began, and
/// the state now is the entity's own. All of: the newest version was itself written by a quiet
/// save of the same command (so a star, a rename from a menu, a restore, an undo or any other
/// act that offers one in between has ended the session on both sides), it is the same actor
/// (the same cause says so), the command is not the history's own, no secret was sealed anew,
/// the last commit of the session was at most [`SESSION_IDLE_MS`] ago and its first at most
/// [`SESSION_CAP_MS`] ago. A fold moves the version's `touched_at` and nothing else.
fn folds(
    connection: &Connection,
    id: &str,
    before: &str,
    after: &str,
    now: &str,
    cause: &str,
) -> Result<bool> {
    if cause.starts_with("history.") {
        return Ok(false);
    }
    let newest: Option<(i64, String, Option<String>, String, bool)> = connection
        .query_row(
            "SELECT seq, at, touched_at, cause, autosave FROM revision
              WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((seq, began, touched, newest_cause, quiet)) = newest else {
        return Ok(false);
    };
    if !quiet || newest_cause != cause {
        return Ok(false);
    }
    let ms = |text: &str| crate::time::recurrence::parse_instant_ms(text);
    let (Some(at_now), Some(first), Some(last)) = (
        ms(now),
        ms(&began),
        ms(touched.as_deref().unwrap_or(&began)),
    ) else {
        return Ok(false);
    };
    if at_now - last > SESSION_IDLE_MS || at_now - first > SESSION_CAP_MS {
        return Ok(false);
    }
    if sealed_changed(connection, before, after)? {
        return Ok(false);
    }
    connection.execute(
        "UPDATE revision SET touched_at = ?3 WHERE entity_id = ?1 AND seq = ?2",
        rusqlite::params![id, seq, now],
    )?;
    Ok(true)
}

/// Whether a sealed cell (a Locker secret) differs between two states: a changed secret is
/// always a version of its own.
fn sealed_changed(connection: &Connection, before: &str, after: &str) -> Result<bool> {
    let (before, after): (Json, Json) = (
        serde_json::from_str(before).unwrap_or(Json::Null),
        serde_json::from_str(after).unwrap_or(Json::Null),
    );
    let shape = shape::shape(connection)?;
    for part in &shape.parts {
        let sealed: Vec<&String> = part
            .columns
            .iter()
            .filter(|column| shape::is_sealed(part.name, column))
            .collect();
        if sealed.is_empty() {
            continue;
        }
        let cells = |state: &Json| -> Json {
            let rows: Vec<&Json> = match state.get(part.alias) {
                Some(Json::Array(rows)) => rows.iter().collect(),
                Some(row @ Json::Object(_)) => vec![row],
                _ => Vec::new(),
            };
            Json::Array(
                rows.into_iter()
                    .map(|row| {
                        Json::Array(
                            sealed
                                .iter()
                                .map(|column| {
                                    row.get(column.as_str()).cloned().unwrap_or(Json::Null)
                                })
                                .collect(),
                        )
                    })
                    .collect(),
            )
        };
        if cells(&before) != cells(&after) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn keep_as(
    connection: &Connection,
    id: &str,
    state: &str,
    after: &str,
    now: &str,
    cause: &str,
    quiet: bool,
) -> Result<()> {
    let parse = |text: &str| -> Result<Json> {
        serde_json::from_str(text).map_err(|source| crate::error::VaultError::Json {
            context: "an entity's state as the history captured it".to_owned(),
            source,
        })
    };
    let mut parsed = parse(state)?;
    let words_unchanged = {
        let words = |state: &Json| state.pointer("/note/body").cloned();
        let now_words = words(&parse(after)?);
        now_words.is_some() && words(&parsed) == now_words
    };
    if words_unchanged && let Some(row) = parsed.get_mut("note").and_then(Json::as_object_mut) {
        row.remove("body");
    }
    // Content comes out of the JSON and into its own cells.
    let mut cells: [Option<Json>; 3] = [None, None, None];
    for (table, column, cell) in CONTENT.iter() {
        let taken = parsed
            .get_mut(*table)
            .and_then(Json::as_object_mut)
            .and_then(|row| row.remove(*column));
        if let Some(value) = taken.filter(|value| !value.is_null()) {
            cells[cell.index()] = Some(value);
        }
    }
    let text = |index: usize| cells[index].as_ref().and_then(Json::as_str);
    let seq: i64 = connection
        .prepare_cached("SELECT COALESCE(MAX(seq), 0) + 1 FROM revision WHERE entity_id = ?1")?
        .query_row([id], |row| row.get(0))?;
    connection
        .prepare_cached(
            "INSERT INTO revision (entity_id, seq, at, cause, state, body, blob, media_type, autosave)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?
        .execute(rusqlite::params![
            id,
            seq,
            now,
            cause,
            canonical_json(&parsed)?,
            text(0),
            text(1),
            text(2),
            quiet,
        ])?;
    // The words this version replaced are findable, in the same commit that replaced them.
    crate::index::version_kept(connection, id, seq, &parsed, text(0))?;
    Ok(())
}
