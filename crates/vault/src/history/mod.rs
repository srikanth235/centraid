//! EVERY RECORD KEEPS ITS EARLIER VALUES: the vault's one history (#1185, principle 5).
//!
//! ## What is kept, and when
//!
//! A commit that changes what a member can see of an entity keeps the entity's state **as it was
//! before the commit**, as one `revision` row (`seq` counts up from one per entity). The state is
//! the entity's own row (its title and its home, `parent_id`), its kind row, and the rows it owns
//! (a person's contact points and dates, an event's guests and reminders, a note's assets, a Locker
//! item's fields), and nothing else (B1: edges, links, a category's budgets and rules, a series'
//! occurrences are outside; see [`shape`]). It is captured at the commit door, never by a command:
//! no command writes history, so no command can forget to. Every revision says who made the
//! change that replaced it ([`Actor`], said by the caller that opened the commit, never inferred
//! from a name) and which grammar it is written in (`revision.shape`, [`SHAPE_VERSION`]).
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
//! `{"entity": {"title", "parent_id"}, "<kind table>": {col: value}, "<child table>": [{col: value}]}`.
//! A key absent from a version was not captured when it was made (an older schema, or a column
//! added since), which a diff reads as "not known", never as a change. The state carries no hash:
//! every blob a version names is a `revision_blob` row ([`BLOB_SLOTS`]: one row of that table
//! says which column, and an app lane adds a row, not code), so the blob collector and the backup
//! read foreign keys alone. A note's words are the one value kept in a cell of their own
//! (`revision.body`, [`CONTENT`]). [`version_state`] puts both back, so there is one state and one
//! place each fact is kept. A commit that leaves a note's words as they
//! were (a title or notebook edit) copies none: that version carries no `note.body`, and a reader
//! takes the words from the next newer version that holds them, else from the note itself. If a
//! later body edit arrives in that quiet session, it starts a new version so the earlier version
//! can still reconstruct the original words without mutating history. Later body saves in the
//! session fold into that new version normally.
//!
//! ## Quiet saves fold with one body-preservation boundary
//!
//! A QUIET save (an editor's autosave, which the caller says it is: `Command::quiet`, never
//! inferred from a name) that continues the session of the newest version writes nothing: that
//! version holds the state before the session began, and the record holds the state now. It
//! continues it when the newest version was itself a quiet save of the same command by the same
//! actor (and origin), no more than [`SESSION_IDLE_MS`] (ten minutes) have passed since the
//! session's last commit, no more than [`SESSION_CAP_MS`] (an hour) since its first, and no sealed
//! cell changed. Any act that offers an Undo is not quiet, so it is a version of its own and ends
//! the session on both sides; a restore is never quiet, whatever its caller said. A fold moves
//! `revision.touched_at` and nothing else. The
//! exception for a note whose newest quiet version elides its body is deliberate: the first later
//! body change starts a new version to preserve the words needed by the earlier state, and
//! subsequent body saves fold into that new version.
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
//! A version names a blob and copies no bytes: its `revision_blob` row is a foreign key into
//! `blob(hash)`, so the bytes live for as long as the record (and its history) does. A restore of a
//! column that points at something that is gone leaves it as it is ([`Restored::kept_current`]).

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
    BLOB_SLOTS, BlobSlot, CONTENT, OMITTED, Part, Role, SHAPE_VERSION, Shape, SlotName, TABLES,
    blob_slot, is_sealed, shape,
};
pub use write::{Kept, keep_overlay, overlay_refusal};

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value as Json;

use crate::canonical::canonical_json;
use crate::error::Result;

/// The scratch table the triggers fill: one row per entity the commit touched, holding its state
/// before the commit (`NULL` for one born or being deleted in it).
pub(crate) const SEEN: &str = "centraid_history_seen";

/// The scratch table the commit-touch triggers fill: every entity whose own row, host row,
/// child row or edge changed in this commit.
pub(crate) const COMMIT_TOUCHED: &str = "centraid_commit_touched";

/// The view of every entity's state now.
pub(crate) const STATE_VIEW: &str = "centraid_entity_state";

/// WHO MADE A COMMIT (B4). Said by the caller that opens the commit (the door a command came
/// through, a follow pass), never inferred from a command's name or from `cause`: it is written
/// to `revision.actor` / `revision.origin_id`, and the database ties the two (a store has an
/// origin, nobody else does).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Actor {
    /// The member, by hand: a command, an edit, a restore.
    #[default]
    Member,
    /// The assistant, acting on the member's confirmed word.
    Assistant,
    /// A followed store: what the origin `origin_id` said, not something the member did.
    Store { origin_id: String },
}

impl Actor {
    /// The `revision.actor` value.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Member => "member",
            Self::Assistant => "assistant",
            Self::Store { .. } => "store",
        }
    }

    /// The `revision.origin_id` value: the origin of a store, nothing otherwise.
    #[must_use]
    pub fn origin_id(&self) -> Option<&str> {
        match self {
            Self::Store { origin_id } => Some(origin_id),
            _ => None,
        }
    }
}

/// What a commit tells the history when it settles: the command that made it (`cause`, kept as a
/// diagnostic and compared for equality only), who acted, and whether it is a quiet save.
#[derive(Debug, Clone)]
pub struct Settling {
    pub cause: String,
    pub actor: Actor,
    pub quiet: bool,
}

/// Entities whose rows changed during a commit, as collected by the TEMP triggers.
#[derive(Debug, Default)]
pub(crate) struct CommitTouched {
    /// Entities whose `updated_at` should be stamped (changed and not born in this commit).
    pub stamp: std::collections::BTreeSet<String>,
    /// Entities owed a search re-index and alert refresh.
    pub reindex: std::collections::BTreeSet<String>,
}

/// Drain `temp.centraid_commit_touched`, returning the entities touched by SQL in this commit.
/// Returns empty when the temp table is not installed yet (e.g. a commit before founding).
pub(crate) fn take_touched(connection: &Connection) -> Result<CommitTouched> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_temp_master WHERE type = 'table' AND name = ?1)",
            [COMMIT_TOUCHED],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !exists {
        return Ok(CommitTouched::default());
    }
    let rows: Vec<(String, bool, bool)> = {
        let mut statement = connection.prepare_cached(&format!(
            "SELECT entity_id, stamp != 0, born != 0 FROM temp.{COMMIT_TOUCHED}"
        ))?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    connection.execute_batch(&format!("DELETE FROM temp.{COMMIT_TOUCHED}"))?;
    let mut out = CommitTouched::default();
    for (id, stamp, born) in rows {
        if stamp && !born {
            out.stamp.insert(id.clone());
        }
        out.reindex.insert(id);
    }
    Ok(out)
}

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
pub(crate) fn settle(connection: &Connection, now: &str, settling: &Settling) -> Result<usize> {
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
        if settling.quiet && folds(connection, &id, &before, &after, now, settling)? {
            continue;
        }
        keep(connection, &id, &before, &after, now, settling)?;
        written += 1;
    }
    Ok(written)
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
/// act that offers one in between has ended the session on both sides) by the same actor (and,
/// for a store, the same origin), the command is not the history's own, no secret was sealed
/// anew, the last commit of the session was at most [`SESSION_IDLE_MS`] ago and its first at most
/// [`SESSION_CAP_MS`] ago. A note body that would become unrecoverable starts a new version; the
/// immutable earlier revision keeps using the newer revision's body as its source. Only
/// `touched_at` moves on the version a save folds into.
pub(crate) fn folds(
    connection: &Connection,
    id: &str,
    before: &str,
    after: &str,
    now: &str,
    settling: &Settling,
) -> Result<bool> {
    type Newest = (
        i64,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        bool,
        bool,
    );
    let newest: Option<Newest> = connection
        .query_row(
            "SELECT seq, at, touched_at, cause, actor, origin_id, autosave, body IS NULL
               FROM revision WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .optional()?;
    let Some((seq, began, touched, newest_cause, actor, origin_id, quiet, body_elided)) = newest
    else {
        return Ok(false);
    };
    let same_actor =
        actor == settling.actor.code() && origin_id.as_deref() == settling.actor.origin_id();
    if !quiet || newest_cause != settling.cause || !same_actor {
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
    if note_body_would_be_lost(before, after, body_elided) {
        return Ok(false);
    }
    connection.execute(
        "UPDATE revision SET touched_at = ?3 WHERE entity_id = ?1 AND seq = ?2",
        rusqlite::params![id, seq, now],
    )?;
    Ok(true)
}

/// A note's body can be elided from a title-only version because the live note still has those
/// words. If a later body edit tried to fold into that session, the body would no longer be live
/// and could not be reconstructed. Keep that edit as a new version instead.
fn note_body_would_be_lost(before: &str, after: &str, body_elided: bool) -> bool {
    if !body_elided {
        return false;
    }
    let parse = |state: &str| serde_json::from_str::<Json>(state).ok();
    let (Some(before), Some(after)) = (parse(before), parse(after)) else {
        return false;
    };
    let (Some(old_body), Some(new_body)) = (
        before.pointer("/note/body").and_then(Json::as_str),
        after.pointer("/note/body").and_then(Json::as_str),
    ) else {
        return false;
    };
    old_body != new_body
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
            let rows: Vec<&Json> = match state.get(part.name) {
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

/// Write one version: `state` is the entity's state as the view spells it, `after` what the
/// commit left. A note's words the commit did not change are not copied (a title-only edit keeps
/// no body): the version carries no `note.body`, and a reader takes the words from the next newer
/// version that holds them, else from the note as it is ([`read::fill_body`]). Every blob the state
/// names leaves the JSON for a `revision_blob` row ([`BLOB_SLOTS`]).
pub(crate) fn keep(
    connection: &Connection,
    id: &str,
    state: &str,
    after: &str,
    now: &str,
    settling: &Settling,
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
    // The note's words come out of the JSON into their own cell.
    let mut body: Option<String> = None;
    for (table, column) in CONTENT {
        let taken = parsed
            .get_mut(*table)
            .and_then(Json::as_object_mut)
            .and_then(|row| row.remove(*column));
        if let Some(Json::String(words)) = taken {
            body = Some(words);
        }
    }
    let blobs = lift_blobs(&mut parsed);
    let seq: i64 = connection
        .prepare_cached("SELECT COALESCE(MAX(seq), 0) + 1 FROM revision WHERE entity_id = ?1")?
        .query_row([id], |row| row.get(0))?;
    connection
        .prepare_cached(
            "INSERT INTO revision (entity_id, seq, at, actor, origin_id, cause, shape, state, body, autosave)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?
        .execute(rusqlite::params![
            id,
            seq,
            now,
            settling.actor.code(),
            settling.actor.origin_id(),
            settling.cause,
            SHAPE_VERSION,
            canonical_json(&parsed)?,
            body,
            settling.quiet,
        ])?;
    let mut claim = connection.prepare_cached(
        "INSERT INTO revision_blob (entity_id, seq, slot, blob, media_type)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for lifted in &blobs {
        claim.execute(rusqlite::params![
            id,
            seq,
            lifted.slot,
            lifted.hash,
            lifted.media_type
        ])?;
    }
    // The words this version replaced are findable, in the same commit that replaced them.
    crate::index::version_kept(connection, id, seq, &parsed, body.as_deref())?;
    Ok(())
}

/// One blob a state named, taken out of it.
struct Lifted {
    slot: String,
    hash: String,
    media_type: Option<String>,
}

/// Take every [`BLOB_SLOTS`] column (and the media type kept beside it) out of a state, so the JSON
/// holds no hash. Returns what was taken, by slot.
fn lift_blobs(state: &mut Json) -> Vec<Lifted> {
    let mut lifted = Vec::new();
    for slot in BLOB_SLOTS {
        let Some(table) = state.get_mut(slot.table) else {
            continue;
        };
        match (slot.slot, table) {
            (SlotName::One(name), Json::Object(row)) => {
                if let Some(taken) = take(row, slot, name) {
                    lifted.push(taken);
                }
            }
            (SlotName::PerRow(prefix), Json::Array(rows)) => {
                for row in rows.iter_mut().filter_map(Json::as_object_mut) {
                    let Some(row_id) = row.get("id").and_then(Json::as_str).map(str::to_owned)
                    else {
                        continue;
                    };
                    if let Some(taken) = take(row, slot, &format!("{prefix}:{row_id}")) {
                        lifted.push(taken);
                    }
                }
            }
            _ => {}
        }
    }
    lifted
}

fn take(row: &mut serde_json::Map<String, Json>, slot: &BlobSlot, name: &str) -> Option<Lifted> {
    // An empty column stays in the state as `null`: it holds no hash, and a restore needs to know
    // the version had none.
    let Some(Json::String(hash)) = row.get(slot.column) else {
        return None;
    };
    let hash = hash.clone();
    row.remove(slot.column);
    let media_type = slot
        .media_type
        .and_then(|column| row.remove(column))
        .and_then(|value| value.as_str().map(str::to_owned));
    Some(Lifted {
        slot: name.to_owned(),
        hash,
        media_type,
    })
}
