//! The verbs every entity shares: retitle, move, trash, restore, purge, empty the trash.
//!
//! One implementation for every kind that allows it, refusing the kinds it does
//! not serve with a sentence. A kind's own create and edit commands live with
//! its app; these lines are the same for all of them
//! ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//!
//! ## One home
//!
//! Where a row sits is `entity.parent_id` and the kind of what holds it `entity.parent_kind`, for
//! every kind (a note's notebook, a document's folder, an event's calendar, a task's project,
//! section or parent task, a section's project, a project's area, a concept's parent). Which kind
//! may sit in which is the `home_shape` table, whether a kind may sit at the top is
//! `entity_kind.may_be_top`, and a home is never a loop (the `entity_home_is_acyclic` trigger).
//! [`move_home`] is the one path that changes it; [`home_refusal`] says in a sentence what the
//! database would refuse.
//!
//! ## What a trash takes, and what a purge does with what points at an entity
//!
//! - **A holder takes what it holds to the trash with it** and brings it back with it: a
//!   notebook's notes, a folder's documents, a task list's tasks, a calendar's events, a task's
//!   subtasks, an account's lines, a photo or document captured inside an item, and the touches
//!   with or about one person alone (a person's contact points and dates are their own rows and go
//!   with them; their notes, workouts, events, photos, documents, payments and Locker items stay). A row
//!   the trash took has `trashed_by` naming the holder that took it (its direct holder, so nested
//!   holders name each other); a row trashed on its own has none. **No timestamp is compared**:
//!   restoring a holder brings back the rows that name it, and the rows that name those, and
//!   nothing else, so a row trashed on its own earlier stays in the trash.
//! - **A row whose holder is in the trash is not restored on its own** ([`pre_restore`]): it is
//!   inside something that is gone, and the sentence says which holder to restore first. Nothing
//!   is lost and nothing sits visible in a trashed home.
//! - **A purge removes the contents before the holder**: the rows naming it in `trashed_by`, and
//!   theirs in turn. What else pointed at it is [`PURGE_RULES`]: a held row that may sit at the top
//!   moves there, one that needs a home makes the purge refuse with a sentence; a place, an origin
//!   or a copy it was made from is let go; a line or a reading cannot outlive its account or
//!   person.
//! - **A calendar is a holder too**, and the vault's own calendar (the one every vault is
//!   founded with) is never trashed.
//! - **A row past its `purge_at` is emptied by the launch pass**
//!   (`Vault::empty_overdue_trash`) and restores until then.
//! - **`entity.n` is never reused** (the table is `AUTOINCREMENT`): a purged item's row number
//!   is not given to a new one, so a search index never shows a purged item's words under it.

use rusqlite::{Connection, OptionalExtension};

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};
use crate::model::{DEFAULT_CALENDAR_ID, Kind};

/// How long a trashed entity waits before a sweep may purge it.
pub const TRASH_DAYS: i64 = 30;

/// One entity, as the shared verbs see it.
#[derive(Debug, Clone)]
pub(crate) struct Found {
    pub id: String,
    pub kind: Kind,
    pub title: String,
    pub deleted_at: Option<String>,
}

/// The entity with this id, if there is one.
pub(crate) fn find(connection: &Connection, id: &str) -> Result<Option<Found>> {
    let row: Option<(String, String, Option<String>)> = connection
        .query_row(
            "SELECT kind, title, deleted_at FROM entity WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    Ok(row.and_then(|(kind, title, deleted_at)| {
        Kind::parse(&kind).map(|kind| Found {
            id: id.to_owned(),
            kind,
            title,
            deleted_at,
        })
    }))
}

/// The entity, or the sentence a precondition says when there is none.
pub(crate) fn lookup(
    connection: &Connection,
    id: &str,
) -> Result<std::result::Result<Found, String>> {
    Ok(find(connection, id)?.ok_or_else(|| format!("there is nothing with the id `{id}`")))
}

/// The entity, when it is there and not in the trash.
pub(crate) fn lookup_live(
    connection: &Connection,
    id: &str,
) -> Result<std::result::Result<Found, String>> {
    Ok(lookup(connection, id)?.and_then(|found| {
        if found.deleted_at.is_some() {
            Err(format!(
                "“{}” is in the trash; restore it first",
                found.title
            ))
        } else {
            Ok(found)
        }
    }))
}

// ---------------------------------------------------------------------------
// A save that says which revision it replaces (#1185)
// ---------------------------------------------------------------------------

/// The predicate a guarded save is refused with when the record changed since the screen read
/// it. A screen branches on it; the member never sees it.
pub const STALE_REVISION: &str = "stale_revision";

/// The predicate a guarded save is refused with when the record is in the trash.
pub const STALE_TRASHED: &str = "stale_trashed";

/// The revision a save says it replaces, when it says one. Absent is today's behaviour (the
/// assistant, a follow pass and the shared verbs name none).
fn expected_rev(ctx: &CommandCtx<'_, '_>) -> Option<i64> {
    ctx.input
        .get("expected_rev")
        .and_then(serde_json::Value::as_i64)
}

/// The record a guarded save is of: `id`, or `item_id` for Locker's commands, or the one line a
/// command that files many (`ids`) was given. A save of several records names no revision, so
/// none is held to one.
fn subject<'a>(ctx: &'a CommandCtx<'_, '_>) -> Option<&'a str> {
    ctx.optional_str("id")
        .or_else(|| ctx.optional_str("item_id"))
        .or_else(|| match ctx.input.get("ids")?.as_array()?.as_slice() {
            [only] => only.as_str(),
            _ => None,
        })
}

fn stale_trashed(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let (Some(_), Some(id)) = (expected_rev(ctx), subject(ctx)) else {
        return Ok(None);
    };
    Ok(find(ctx.connection(), id)?
        .filter(|found| found.deleted_at.is_some())
        .map(|found| format!("“{}” was moved to the trash", found.title)))
}

fn stale_revision(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let (Some(expected), Some(id)) = (expected_rev(ctx), subject(ctx)) else {
        return Ok(None);
    };
    if find(ctx.connection(), id)?.is_none() {
        return Ok(None);
    }
    Ok((crate::history::head(ctx.connection(), id)? != expected)
        .then(|| "It changed somewhere else since you opened it".to_owned()))
}

/// THE GUARD of a save that names `expected_rev`: refused as [`STALE_TRASHED`] when the record
/// is in the trash and as [`STALE_REVISION`] when its revision is not the one named. Put it
/// first among a command's preconditions; with no `expected_rev` it holds. The command's schema
/// carries the optional `expected_rev` (an integer, 0 or more), and its handler answers
/// [`rev_after`].
pub(crate) const STALE_GUARD: [CommandCondition; 2] = [
    CommandCondition {
        predicate: STALE_TRASHED,
        check: stale_trashed,
    },
    CommandCondition {
        predicate: STALE_REVISION,
        check: stale_revision,
    },
];

/// The revision a guarded save leaves: put in its output as `rev` when the save named one, so
/// the next save names it.
pub(crate) fn rev_after(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<Option<i64>> {
    if expected_rev(ctx).is_none() {
        return Ok(None);
    }
    Ok(Some(crate::history::head_after(
        ctx.connection(),
        id,
        &ctx.now,
        &ctx.settling_as(),
    )?))
}

/// A guarded save's answer: `answer` with `rev` added when the save named an `expected_rev`.
pub(crate) fn with_rev(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    mut answer: serde_json::Value,
) -> Result<serde_json::Value> {
    if let Some(rev) = rev_after(ctx, id)? {
        answer["rev"] = rev.into();
    }
    Ok(answer)
}

/// A handler's view of the same: the entity must be there, because the
/// precondition said so.
pub(crate) fn require(connection: &Connection, id: &str) -> Result<Found> {
    find(connection, id)?.ok_or_else(|| VaultError::Invariant {
        context: format!("`{id}` is not an entity, and a precondition said it was"),
    })
}

/// Whether the vault's self person is this entity: the one person nothing may
/// follow, trash, merge away or purge. Every path that could take the owner
/// asks here, so there is one answer ([#1146](https://github.com/srikanth235/centraid/issues/1146)).
pub(crate) fn is_self(connection: &Connection, id: &str) -> Result<bool> {
    Ok(connection
        .query_row("SELECT self_id = ?1 FROM vault", [id], |row| row.get(0))
        .optional()?
        .unwrap_or(false))
}

pub(crate) fn count(connection: &Connection, sql: &str, id: &str) -> Result<i64> {
    Ok(connection.query_row(sql, [id], |row| row.get(0))?)
}

fn ids(connection: &Connection, sql: &str, id: &str) -> Result<Vec<String>> {
    Ok(connection
        .prepare_cached(sql)?
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// What a holder holds that is still live: the rows in its home, then what a kind holds without a
/// home column. These follow it to the trash.
fn held(connection: &Connection, holder: &Found) -> Result<Vec<String>> {
    // What sits in the holder's home, then what a kind holds without a home column.
    let mut held = ids(
        connection,
        "SELECT id FROM entity WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY n",
        &holder.id,
    )?;
    let more = match holder.kind {
        // An account's lines.
        Kind::Account => Some(
            "SELECT t.id FROM txn t JOIN entity e ON e.id = t.id
              WHERE t.account_id = ?1 AND e.deleted_at IS NULL",
        ),
        // The touches with or about one person and no one else. Everything else joined to them is
        // the member's own and stays (a note, a workout, an event, a task, a document, a line, a
        // photograph, a Locker item): **an allow-list**, so a kind the model learns to join to a
        // person is kept until someone decides otherwise. `depicts` never cascades.
        Kind::Person => Some(
            "SELECT e.from_id FROM edge e JOIN entity f ON f.id = e.from_id
              WHERE e.to_id = ?1 AND e.rel IN ('about', 'with')
                AND f.kind = 'touch' AND f.deleted_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM edge o WHERE o.from_id = e.from_id
                                   AND o.rel IN ('about', 'with') AND o.to_id <> ?1)",
        ),
        _ => None,
    };
    if let Some(sql) = more {
        for id in ids(connection, sql, &holder.id)? {
            if !held.contains(&id) {
                held.push(id);
            }
        }
    }
    Ok(held)
}

/// How many live rows a holder takes to the trash with it: the count a notebook's, folder's,
/// account's or task list's delete confirm names. Zero for a row that holds nothing.
///
/// # Errors
/// SQLite's refusal, or an id that is no entity.
pub fn held_count(connection: &Connection, id: &str) -> Result<i64> {
    let found = require(connection, id)?;
    let mut counted = 0;
    let mut frontier = vec![found];
    while let Some(holder) = frontier.pop() {
        for member in held(connection, &holder)? {
            counted += 1;
            if let Some(member) = find(connection, &member)? {
                frontier.push(member);
            }
        }
    }
    Ok(counted)
}

// ---------------------------------------------------------------------------
// One home (A19)
// ---------------------------------------------------------------------------

/// What a merge does with the rows homed in the one that goes: they are homed in the one that
/// stays (a capture filed inside a person, a tag inside a tag), so the purge that follows detaches
/// nothing. When the survivor itself sits somewhere under the loser it first takes the loser's
/// place, so the home cannot loop. Returns how many rows moved.
///
/// # Errors
/// SQLite's refusal.
pub(crate) fn repoint_homes(ctx: &CommandCtx<'_, '_>, loser: &str, winner: &str) -> Result<usize> {
    let connection = ctx.connection();
    let (parent, parent_kind): (Option<String>, Option<String>) = connection.query_row(
        "SELECT parent_id, parent_kind FROM entity WHERE id = ?1",
        [loser],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let under: bool = connection.query_row(
        "WITH RECURSIVE up(id) AS (
           SELECT parent_id FROM entity WHERE id = ?1
           UNION SELECT e.parent_id FROM entity e JOIN up ON e.id = up.id
            WHERE e.parent_id IS NOT NULL)
         SELECT EXISTS (SELECT 1 FROM up WHERE id = ?2)",
        [winner, loser],
        |row| row.get(0),
    )?;
    if under {
        connection.execute(
            "UPDATE entity SET parent_id = ?2, parent_kind = ?3 WHERE id = ?1",
            rusqlite::params![winner, parent, parent_kind],
        )?;
        ctx.touch(winner)?;
    }
    let moved = ids(
        connection,
        "SELECT id FROM entity WHERE parent_id = ?1 ORDER BY n",
        loser,
    )?;
    connection.execute(
        "UPDATE entity SET parent_id = ?2, parent_kind = (SELECT kind FROM entity WHERE id = ?2)
          WHERE parent_id = ?1",
        [loser, winner],
    )?;
    for id in &moved {
        ctx.touch(id)?;
    }
    Ok(moved.len())
}

/// A sentence when a row of `kind` cannot sit in `parent` (`None`: at the top level): the home is
/// not there or is in the trash, its kind is not one the `home_shape` table allows, the row would
/// end up inside itself, or the kind needs a home and none was named. The database refuses each
/// of these rows too (`entity`'s keys and the `entity_home_is_acyclic` trigger); this says it in
/// a sentence first. `id` is the row being moved, and none for a row about to be made.
pub(crate) fn home_refusal(
    connection: &Connection,
    kind: Kind,
    id: Option<&str>,
    parent: Option<&str>,
) -> Result<Option<String>> {
    let Some(parent_id) = parent else {
        let may_be_top: bool = connection.query_row(
            "SELECT may_be_top FROM entity_kind WHERE code = ?1",
            [kind.as_str()],
            |row| row.get(0),
        )?;
        if may_be_top {
            return Ok(None);
        }
        let homes = ids(
            connection,
            "SELECT home_kind FROM home_shape WHERE kind = ?1 ORDER BY home_kind",
            kind.as_str(),
        )?;
        let homes: Vec<String> = homes
            .iter()
            .map(|home| Kind::parse(home).map_or_else(|| home.clone(), Kind::noun))
            .collect();
        return Ok(Some(format!(
            "a {} belongs in a {}",
            kind.noun(),
            homes.join(" or a ")
        )));
    };
    let parent = match lookup_live(connection, parent_id)? {
        Ok(parent) => parent,
        Err(sentence) => return Ok(Some(sentence)),
    };
    let allowed: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM home_shape WHERE kind = ?1 AND home_kind = ?2)",
        [kind.as_str(), parent.kind.as_str()],
        |row| row.get(0),
    )?;
    if !allowed {
        return Ok(Some(format!(
            "a {} does not go inside a {}",
            kind.noun(),
            parent.kind.noun()
        )));
    }
    let shallow = |kind: &str, home: &str| -> Result<bool> {
        Ok(connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM home_shape WHERE kind = ?1 AND home_kind = ?2 AND shallow = 1)",
            [kind, home],
            |row| row.get(0),
        )?)
    };
    if shallow(kind.as_str(), parent.kind.as_str())? {
        let parent_is_nested: bool = connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM entity p JOIN home_shape h
                              ON h.kind = p.kind AND h.home_kind = p.parent_kind AND h.shallow = 1
                             WHERE p.id = ?1)",
            [parent_id],
            |row| row.get(0),
        )?;
        if parent_is_nested {
            return Ok(Some(format!(
                "“{}” is already a subtask, and a subtask cannot have subtasks of its own",
                parent.title
            )));
        }
        if let Some(id) = id {
            let has_nested: bool = connection.query_row(
                "SELECT EXISTS (SELECT 1 FROM entity c JOIN home_shape h
                                  ON h.kind = c.kind AND h.home_kind = c.parent_kind AND h.shallow = 1
                                 WHERE c.parent_id = ?1 AND c.deleted_at IS NULL)",
                [id],
                |row| row.get(0),
            )?;
            if has_nested {
                return Ok(Some(
                    "a task that has subtasks cannot become a subtask itself".to_owned(),
                ));
            }
        }
    }
    if let Some(id) = id {
        // Climb from the new home: finding the row itself means it would end up inside itself.
        let inside: bool = connection.query_row(
            "WITH RECURSIVE up(id) AS (
               SELECT ?1 UNION SELECT e.parent_id FROM entity e JOIN up ON e.id = up.id
                WHERE e.parent_id IS NOT NULL)
             SELECT EXISTS (SELECT 1 FROM up WHERE id = ?2)",
            [parent_id, id],
            |row| row.get(0),
        )?;
        if inside {
            return Ok(Some(format!("“{}” cannot go inside itself", parent.title)));
        }
    }
    Ok(None)
}

/// THE ONE PATH THAT MOVES A ROW: a note to another notebook, a document to a folder, a task to a
/// section, a container or a concept to another holder, anything to the top level. Whether it may
/// is [`home_refusal`]'s (the database says the same). Returns whether the home changed; a move to
/// where the row already is writes nothing.
pub(crate) fn move_home(ctx: &CommandCtx<'_, '_>, id: &str, parent: Option<&str>) -> Result<bool> {
    let changed = ctx.connection().execute(
        "UPDATE entity
            SET parent_id = ?2, parent_kind = (SELECT kind FROM entity WHERE id = ?2)
          WHERE id = ?1 AND parent_id IS NOT ?2",
        rusqlite::params![id, parent],
    )?;
    if changed > 0 {
        ctx.touch(id)?;
    }
    Ok(changed > 0)
}

fn pre_move(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let found = match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    if is_self(ctx.connection(), &found.id)? {
        return Ok(Some(
            "this is you; a vault cannot do without its owner".to_owned(),
        ));
    }
    home_refusal(
        ctx.connection(),
        found.kind,
        Some(&found.id),
        ctx.optional_str("parent"),
    )
}

#[derive(serde::Deserialize)]
struct MoveInput {
    parent: Option<String>,
}

fn pre_move_each(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    ctx.check_each(pre_move)
}

/// `entity.move`: any row to another home, or to the top level.
fn move_entity(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: MoveInput = ctx.parse_input()?;
    let ids = ctx.target_ids();
    let mut moved = Vec::new();
    for id in &ids {
        if move_home(ctx, id, input.parent.as_deref())? {
            moved.push(id.clone());
        }
    }
    Ok(serde_json::json!({ "id": ids.first(), "moved": !moved.is_empty(), "moved_ids": moved }))
}

// ---------------------------------------------------------------------------
// What a purge does with what points at an entity
// ---------------------------------------------------------------------------

/// What a purge does with a pointer the engine would refuse to delete out from under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurgeRule {
    /// The referrer lets go of its target (the pointer becomes NULL): a photograph's place, the
    /// photograph it was edited from.
    Detach,
    /// The referrer is purged with its target: it cannot outlive it (an account's line, a
    /// person's reading).
    Purge,
    /// The purge refuses with a sentence while the referrer exists ([`purge_refusal`]).
    Refuse,
    /// The origin's follow ends with its target.
    Forget,
    /// What the target held. What the trash took with it is gone first (`trashed_by`). Everything
    /// else still homed in a holder that is in the trash goes too (it is in the trash with it);
    /// a holder that has no trash lets what may sit at the top move there and purges the rest.
    /// A purge is never refused for what its target holds.
    Home,
    /// The referrer's own row goes and nothing else: a split filed under a purged category. A line
    /// left with other parts must still sum to its amount, so Money first files the parts again
    /// under the category's group, or, with no group, drops them all
    /// ([`crate::commands::txn::refile_parts_of`]).
    Drop,
}

/// Every foreign key into an entity (or a kind's table) that deletes nothing itself
/// (`ON DELETE NO ACTION`), and what a purge does about it: `(table, the key's columns as
/// PRAGMA foreign_key_list states them, rule)`.
///
/// `tests/purge_rules.rs` derives the same list from the founded file and requires it equal, so a
/// pointer added to the schema without a purge rule fails there and not in a member's vault.
pub const PURGE_RULES: &[(&str, &str, PurgeRule)] = &[
    ("entity", "parent_id,parent_kind", PurgeRule::Home),
    ("event", "place_id", PurgeRule::Detach),
    ("occurrence", "place_id", PurgeRule::Detach),
    ("origin", "fills,fills_kind", PurgeRule::Forget),
    ("photo", "edited_from", PurgeRule::Detach),
    ("photo", "place_id", PurgeRule::Detach),
    ("reading", "person_id", PurgeRule::Purge),
    ("touch", "place_id", PurgeRule::Detach),
    ("touch", "type_id,type_kind", PurgeRule::Refuse),
    ("txn", "account_id", PurgeRule::Purge),
    ("txn_split", "category_id,category_kind", PurgeRule::Drop),
    ("vault", "self_id,self_kind", PurgeRule::Refuse),
    ("workout", "place_id", PurgeRule::Detach),
    ("workout", "type_id,type_kind", PurgeRule::Refuse),
];

/// A sentence when this is one of the two rows a vault cannot do without: its owner, and the
/// calendar it is founded with. Neither is trashed, purged or merged away.
fn protected(connection: &Connection, found: &Found) -> Result<Option<String>> {
    if is_self(connection, &found.id)? {
        return Ok(Some(
            "this is you; a vault cannot do without its owner".to_owned(),
        ));
    }
    if found.id == DEFAULT_CALENDAR_ID {
        return Ok(Some(
            "this is the calendar every vault is founded with; it cannot be removed".to_owned(),
        ));
    }
    Ok(None)
}

/// A sentence when this kind of entity cannot be purged as it stands.
fn purge_refusal(connection: &Connection, found: &Found) -> Result<Option<String>> {
    if let Some(sentence) = protected(connection, found)? {
        return Ok(Some(sentence));
    }
    for (table, columns, rule) in PURGE_RULES {
        let first = columns.split(',').next().unwrap_or_default();
        match (rule, *table) {
            (PurgeRule::Refuse, "vault") => {}
            (PurgeRule::Refuse, table) => {
                let used = count(
                    connection,
                    &format!("SELECT COUNT(*) FROM {table} WHERE {first} = ?1"),
                    &found.id,
                )?;
                if used > 0 {
                    return Ok(Some(format!(
                        "{used} {} use “{}”; change them first",
                        if used == 1 { "activity" } else { "activities" },
                        found.title
                    )));
                }
            }
            _ => {}
        }
    }
    Ok(None)
}

pub(crate) fn trash_stamp(ctx: &CommandCtx<'_, '_>) -> Result<(String, String)> {
    let at = crate::clock::parse_iso_ms(&ctx.now).ok_or_else(|| VaultError::Invariant {
        context: format!("`{}` is not an instant this vault writes", ctx.now),
    })?;
    Ok((
        ctx.now.clone(),
        crate::clock::format_iso_ms(at + TRASH_DAYS * 86_400_000),
    ))
}

/// Trash one entity at `(deleted_at, purge_at)`; what it holds follows it, each row naming its own
/// holder in `trashed_by`.
///
/// **The owner's person is refused by every path** (a follower's absence, a
/// merge, a member's trash): this is the one place that takes anything to the
/// trash. A member of a holder that is the owner is left where it is.
pub(crate) fn trash_one(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    stamp: &(String, String),
    trashed: &mut Vec<String>,
) -> Result<()> {
    if is_self(ctx.connection(), id)? {
        return Err(VaultError::InvalidInput {
            name: "id".to_owned(),
            detail: "this is you; a vault cannot do without its owner".to_owned(),
        });
    }
    trash_row(ctx, id, None, stamp, trashed)
}

fn trash_row(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    by: Option<&str>,
    stamp: &(String, String),
    trashed: &mut Vec<String>,
) -> Result<()> {
    let found = require(ctx.connection(), id)?;
    ctx.connection().execute(
        "UPDATE entity SET deleted_at = ?2, purge_at = ?3, trashed_by = ?4 WHERE id = ?1",
        rusqlite::params![id, stamp.0, stamp.1, by],
    )?;
    trashed.push(id.to_owned());
    // Only what is still live follows: a row trashed on its own earlier stays what it was, and
    // so stays out of this holder's restore.
    for member in held(ctx.connection(), &found)? {
        if !is_self(ctx.connection(), &member)? {
            trash_row(ctx, &member, Some(id), stamp, trashed)?;
        }
    }
    Ok(())
}

/// Purge one entity, contents first: what the trash took with it (and theirs in turn), then
/// [`PURGE_RULES`] for whatever else pointed at it.
pub(crate) fn purge_one(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    purged: &mut Vec<String>,
) -> Result<()> {
    let connection = ctx.connection();
    let Some(found) = find(connection, id)? else {
        return Ok(());
    };
    for member in ids(
        connection,
        "SELECT id FROM entity WHERE trashed_by = ?1 ORDER BY n DESC",
        id,
    )? {
        purge_one(ctx, &member, purged)?;
    }
    for (table, columns, rule) in PURGE_RULES {
        let first = columns.split(',').next().unwrap_or_default();
        match rule {
            PurgeRule::Detach => {
                let set = columns
                    .split(',')
                    .map(|column| format!("{column} = NULL"))
                    .collect::<Vec<_>>()
                    .join(", ");
                // The host/child auto-touch TEMP triggers stamp `updated_at` and re-index every
                // detached referrer.
                connection.execute(
                    &format!("UPDATE {table} SET {set} WHERE {first} = ?1"),
                    [id],
                )?;
            }
            PurgeRule::Purge => {
                for referrer in ids(
                    connection,
                    &format!("SELECT id FROM {table} WHERE {first} = ?1"),
                    id,
                )? {
                    purge_one(ctx, &referrer, purged)?;
                }
            }
            PurgeRule::Home => {
                // Whatever is still homed here: in the trash with a holder that is in it, so it
                // goes; or, of a holder with no trash, it goes only if it needs a home.
                let held: Vec<String> = connection
                    .prepare(
                        "SELECT e.id FROM entity e JOIN entity_kind k ON k.code = e.kind
                          WHERE e.parent_id = ?1 AND (?2 OR k.may_be_top = 0) ORDER BY e.n DESC",
                    )?
                    .query_map(rusqlite::params![id, found.deleted_at.is_some()], |row| {
                        row.get(0)
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                for held in held {
                    purge_one(ctx, &held, purged)?;
                }
                let detached = ids(connection, "SELECT id FROM entity WHERE parent_id = ?1", id)?;
                connection.execute(
                    "UPDATE entity SET parent_id = NULL, parent_kind = NULL WHERE parent_id = ?1",
                    [id],
                )?;
                for row in &detached {
                    ctx.touch(row)?;
                }
            }
            PurgeRule::Drop => {
                // A line left with other parts must still sum: Money says what becomes of them.
                if *table == "txn_split" {
                    crate::commands::txn::refile_parts_of(ctx, id)?;
                }
                connection.execute(&format!("DELETE FROM {table} WHERE {first} = ?1"), [id])?;
            }
            // WHAT AN ORIGIN FILLS IS THE TARGET OF ITS FOLLOW, for whatever kind it is (an
            // account, a calendar, a folder): the follow stops with it, as `follow.stop` stops
            // one. The sources it kept are forgotten (the rows they named stay the member's own,
            // or are already gone with the target and leave only their tombstones), and the
            // origin goes.
            PurgeRule::Forget => {
                connection.execute(
                    "DELETE FROM source WHERE origin_id IN (SELECT id FROM origin WHERE fills = ?1)",
                    [id],
                )?;
                connection.execute("DELETE FROM origin WHERE fills = ?1", [id])?;
            }
            PurgeRule::Refuse => {}
        }
    }
    // A guest that is only this person has nothing left to be but a row with no address and no
    // person, which the table refuses: those go before the person does, the others let go.
    if found.kind == Kind::Person {
        for event in ids(
            connection,
            "SELECT DISTINCT event_id FROM event_guest WHERE person_id = ?1 AND address IS NULL",
            id,
        )? {
            connection.execute(
                "DELETE FROM event_guest WHERE event_id = ?1 AND person_id = ?2 AND address IS NULL",
                [event.as_str(), id],
            )?;
            ctx.touch(&event)?;
        }
    }
    // An album's cover is a photograph's bytes: once those are purged the cover
    // goes, so the bytes are not held by a picture of something that is gone.
    if found.kind == Kind::Photo {
        connection.execute(
            "UPDATE container SET cover = NULL
              WHERE cover = (SELECT blob FROM photo WHERE id = ?1)",
            [id],
        )?;
    }
    // The people and things a note was about lose its words from their search
    // text; they are not touched, only re-indexed.
    for target in ids(
        connection,
        "SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'about'",
        id,
    )? {
        ctx.mark_for_index(&target);
    }
    // What the purged entity labelled (a tag on things, a list or album that
    // held them, a relation between people) loses its title from their text;
    // the edges go with the entity, so they are named before it goes.
    for labelled in ids(
        connection,
        "SELECT from_id FROM edge WHERE to_id = ?1 AND rel = 'tagged'
         UNION SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'contains'
         UNION SELECT from_id FROM edge WHERE label_id = ?1
         UNION SELECT to_id FROM edge WHERE label_id = ?1",
        id,
    )? {
        ctx.mark_for_index(&labelled);
    }
    // The index forgets the entity FIRST: a purge names the words the entity holds
    // now (`index::purge`), and a Locker item's plain text is its sidecars' rows.
    crate::index::purge(connection, id)?;
    // A Locker item's sidecars are deleted explicitly, in this commit, though
    // they declare ON DELETE CASCADE. A cascade would fire the same `AFTER DELETE` triggers (the
    // commit's touch triggers and the history's rely on that for every other child); the explicit
    // deletes only keep the order plain: sidecars, then the item row, then the entity.
    if found.kind == Kind::LockerItem {
        for table in ["locker_item_field", "locker_item_passkey"] {
            connection.execute(&format!("DELETE FROM {table} WHERE item_id = ?1"), [id])?;
        }
        connection.execute("DELETE FROM locker_item WHERE id = ?1", [id])?;
    }
    connection.execute("DELETE FROM entity WHERE id = ?1", [id])?;
    purged.push(id.to_owned());
    Ok(())
}

const BY_IDS: &str = r#"{
  "type": "object",
  "anyOf": [{ "required": ["id"] }, { "required": ["ids"] }],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "ids": { "type": "array", "minItems": 1, "maxItems": 500,
             "items": { "type": "string", "minLength": 1 } }
  }
}"#;

const BY_ID: &str = r#"{
  "type": "object",
  "required": ["id"],
  "additionalProperties": false,
  "properties": { "id": { "type": "string", "minLength": 1 } }
}"#;

fn pre_retitle(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let found = match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    let title = ctx.required_str("title")?.trim();
    // A kind that carries no title (a reading's is empty: the screen formats the figure).
    let may_be_named: bool = ctx.connection().query_row(
        "SELECT may_be_named FROM entity_kind WHERE code = ?1",
        [found.kind.as_str()],
        |row| row.get(0),
    )?;
    if !may_be_named && !title.is_empty() {
        return Ok(Some(format!("a {} has no name", found.kind.noun())));
    }
    // A photograph may have no title at all; nothing else that is named may.
    if may_be_named && found.kind != Kind::Photo && title.is_empty() {
        return Ok(Some(format!("a {} needs a name", found.kind.noun())));
    }
    Ok(None)
}

#[derive(serde::Deserialize)]
struct RetitleInput {
    id: String,
    title: String,
}

#[derive(serde::Deserialize)]
struct ByIdInput {
    id: String,
}

/// THE ONE PATH THAT RENAMES A ROW: a kind's own edit command that takes a title calls this, so
/// the mentions waiting for the new title resolve ([`crate::commands::note::resolve_waiting`]).
/// Returns whether the title changed.
pub(crate) fn rename(ctx: &CommandCtx<'_, '_>, id: &str, title: &str) -> Result<bool> {
    let changed = ctx.connection().execute(
        "UPDATE entity SET title = ?2 WHERE id = ?1 AND title <> ?2",
        [id, title],
    )?;
    if changed > 0 {
        crate::commands::note::resolve_waiting(ctx, id)?;
    }
    Ok(changed > 0)
}

fn retitle(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: RetitleInput = ctx.parse_input()?;
    let title = input.title.trim();
    rename(ctx, &input.id, title)?;
    with_rev(
        ctx,
        &input.id,
        serde_json::json!({ "id": input.id, "title": title }),
    )
}

fn pre_trash(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let found = match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    if let Some(sentence) = protected(ctx.connection(), &found)? {
        return Ok(Some(sentence));
    }
    Ok((!found.kind.has_trash())
        .then(|| format!("a {} is deleted, not moved to the trash", found.kind.noun())))
}

fn pre_trash_each(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    ctx.check_each(pre_trash)
}

fn trash(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let stamp = trash_stamp(ctx)?;
    let mut trashed = Vec::new();
    for id in ctx.target_ids() {
        // A row an earlier one of the same list already took with it keeps its holder's name.
        if find(ctx.connection(), &id)?.is_some_and(|found| found.deleted_at.is_none()) {
            trash_one(ctx, &id, &stamp, &mut trashed)?;
        }
    }
    Ok(serde_json::json!({ "trashed": trashed, "purge_at": stamp.1 }))
}

fn pre_restore(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let found = match lookup(ctx.connection(), ctx.required_str("id")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    if found.deleted_at.is_none() {
        return Ok(Some(format!("“{}” is not in the trash", found.title)));
    }
    // ONE ITEM COMES OUT OF A TRASHED HOLDER ("I trashed the folder but need this file"): at the
    // top level, where its kind may sit. A kind that needs a home (an event, a section) is not
    // brought back into a trashed one: the holder comes back first.
    // A photograph or document captured inside an item comes back only with the item: alone it
    // would land in the library, where it never was.
    if let Some(title) = trashed_home(ctx.connection(), &found.id)?
        && (!may_be_top(ctx.connection(), found.kind)? || is_capture(ctx.connection(), &found)?)
    {
        return Ok(Some(format!(
            "“{}” is in “{title}”, which is in the trash; restore “{title}” first",
            found.title
        )));
    }
    // THE GRACE WINDOW REFUSES NOTHING. An overdue row is emptied by the pass
    // at launch (`Vault::empty_overdue_trash`); until that pass runs it is a
    // trashed row like any other, and a member who got there first gets it back.
    Ok(None)
}

/// Whether this is a photograph or document filed inside an item (not in a folder).
fn is_capture(connection: &Connection, found: &Found) -> Result<bool> {
    if !matches!(found.kind, Kind::Photo | Kind::Document) {
        return Ok(false);
    }
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM entity e JOIN entity_kind k ON k.code = e.parent_kind
                         WHERE e.id = ?1 AND e.parent_kind NOT IN (SELECT code FROM vocab WHERE domain = 'container_kind'))",
        [&found.id],
        |row| row.get(0),
    )?)
}

/// The title of this row's home when the home is in the trash.
fn trashed_home(connection: &Connection, id: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT h.title FROM entity e JOIN entity h ON h.id = e.parent_id
              WHERE e.id = ?1 AND h.deleted_at IS NOT NULL",
            [id],
            |row| row.get(0),
        )
        .optional()?)
}

fn may_be_top(connection: &Connection, kind: Kind) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT may_be_top FROM entity_kind WHERE code = ?1",
        [kind.as_str()],
        |row| row.get(0),
    )?)
}

/// Bring one entity back from the trash, and what its trash took with it: the rows that name it
/// in `trashed_by`, and the rows that name those. A row trashed on its own names no one and stays.
pub(crate) fn restore_one(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<Vec<String>> {
    let mut restored = Vec::new();
    // Out of a trashed home it comes back at the top level; a live home is where it returns to.
    if trashed_home(ctx.connection(), id)?.is_some() {
        ctx.connection().execute(
            "UPDATE entity SET parent_id = NULL, parent_kind = NULL WHERE id = ?1",
            [id],
        )?;
    }
    restore_row(ctx, id, &mut restored)?;
    Ok(restored)
}

fn restore_row(ctx: &CommandCtx<'_, '_>, id: &str, restored: &mut Vec<String>) -> Result<()> {
    // The rows naming it are read first: clearing `id` does not change them, but the order is
    // the one a reader expects (the holder, then what it held).
    let with_it = ids(
        ctx.connection(),
        "SELECT id FROM entity WHERE trashed_by = ?1 ORDER BY n",
        id,
    )?;
    ctx.connection().execute(
        "UPDATE entity SET deleted_at = NULL, purge_at = NULL, trashed_by = NULL WHERE id = ?1",
        [id],
    )?;
    restored.push(id.to_owned());
    for member in with_it {
        restore_row(ctx, &member, restored)?;
    }
    Ok(())
}

/// `entity.restore`.
fn restore(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let mut restored = Vec::new();
    for id in ctx.target_ids() {
        if find(ctx.connection(), &id)?.is_some_and(|found| found.deleted_at.is_some()) {
            restored.extend(restore_one(ctx, &id)?);
        }
    }
    Ok(serde_json::json!({ "restored": restored }))
}

fn pre_restore_each(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    ctx.check_each(pre_restore)
}

fn pre_purge(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let found = match lookup(ctx.connection(), ctx.required_str("id")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    if let Some(sentence) = protected(ctx.connection(), &found)? {
        return Ok(Some(sentence));
    }
    if found.kind.has_trash() && found.deleted_at.is_none() {
        return Ok(Some(format!(
            "“{}” is not in the trash; move it there first",
            found.title
        )));
    }
    purge_refusal(ctx.connection(), &found)
}

fn purge(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: ByIdInput = ctx.parse_input()?;
    let mut purged = Vec::new();
    purge_one(ctx, &input.id, &mut purged)?;
    // What nothing names any more is released with it: its bytes, and a
    // thumbnail only it had.
    let released = crate::blob::collect(ctx.connection())?;
    // And what it said leaves the search index's pages, not only its rows.
    crate::index::compact(ctx.connection())?;
    Ok(serde_json::json!({ "purged": purged, "released": released }))
}

fn pre_empty(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    for name in ["kind", "with_kind"] {
        let Some(word) = ctx.optional_str(name) else {
            continue;
        };
        match Kind::parse(word) {
            None => {
                return Ok(Some(format!(
                    "`{word}` is not a kind of thing in this vault"
                )));
            }
            Some(kind) if !kind.has_trash() => {
                return Ok(Some(format!("a {} has no trash to empty", kind.noun())));
            }
            Some(_) => {}
        }
    }
    if ctx.optional_str("with_kind").is_some() && ctx.optional_str("kind").is_none() {
        return Ok(Some(
            "`with_kind` names a second kind beside `kind`, which is absent".to_owned(),
        ));
    }
    Ok(None)
}

/// How many trashed rows one read of the pass takes.
const DOOMED_CHUNK: i64 = 64;

#[derive(serde::Deserialize)]
struct EmptyTrashInput {
    kind: Option<String>,
    with_kind: Option<String>,
    due_only: Option<bool>,
    limit: Option<u64>,
    defer_collect: Option<bool>,
}

/// Purge what is in the trash: one kind's (with `with_kind`, a second beside it: a People trash holds people and lists), or every kind's; all of it, or only
/// what has waited out its window; and, with a `limit`, at most that many
/// roots (what went with them is not counted against it), saying `more` when
/// something else is due. What cannot be purged as it stands (a calendar with events of its own,
/// the self person) stays in the trash, and does not stop the rest. With
/// `defer_collect` the bytes nothing names any more are not collected here: the caller of a
/// pass in batches collects once at its end.
fn empty_trash(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: EmptyTrashInput = ctx.parse_input()?;
    let due_only = input.due_only.unwrap_or(false);
    let limit = input.limit.and_then(|limit| usize::try_from(limit).ok());
    let defer_collect = input.defer_collect.unwrap_or(false);
    // A pass that empties only what is overdue trusts the clock only within bounds of the vault's
    // last commit (#1191, V19): otherwise nothing is overdue.
    if due_only
        && !crate::time::recurrence::parse_instant_ms(&ctx.now).map_or(Ok(true), |now_ms| {
            crate::clock::is_credible(ctx.connection(), now_ms)
        })?
    {
        return Ok(serde_json::json!({ "purged": 0, "released": [], "more": false }));
    }
    let kind = input.kind.as_deref();
    let with_kind = input.with_kind.as_deref();
    let mut purged = Vec::new();
    let mut roots = 0usize;
    let mut more = false;
    // The doomed are read in chunks, in the order they went to the trash, so a pass of a few
    // roots reads a few chunks and not the whole trash (a batch of the launch tidy pays for
    // what it purges, not for what is left).
    let mut after: Option<(String, i64)> = None;
    'pass: loop {
        let chunk: Vec<(String, String, i64)> = ctx
            .connection()
            .prepare(
                "SELECT id, deleted_at, n FROM entity
                  WHERE deleted_at IS NOT NULL
                    AND (?1 IS NULL OR kind = ?1 OR kind = ?7)
                    AND (?2 = 0 OR purge_at <= ?3)
                    AND (?4 IS NULL OR (deleted_at, n) > (?4, ?5))
                  ORDER BY deleted_at, n LIMIT ?6",
            )?
            .query_map(
                rusqlite::params![
                    kind,
                    i64::from(due_only),
                    ctx.now,
                    after.as_ref().map(|(at, _)| at),
                    after.as_ref().map_or(0, |(_, n)| *n),
                    DOOMED_CHUNK,
                    with_kind
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?
            .collect::<rusqlite::Result<_>>()?;
        let Some((_, last_at, last_n)) = chunk.last().cloned() else {
            break;
        };
        for (id, _, _) in &chunk {
            // Gone already: it went with a holder purged earlier in this pass.
            let Some(found) = find(ctx.connection(), id)? else {
                continue;
            };
            if purge_refusal(ctx.connection(), &found)?.is_some() {
                continue;
            }
            if limit.is_some_and(|limit| roots >= limit) {
                more = true;
                break 'pass;
            }
            purge_one(ctx, id, &mut purged)?;
            roots += 1;
        }
        after = Some((last_at, last_n));
    }
    // A pass in batches collects once at its end (`defer_collect`): collecting is one walk of
    // every blob, and a batch that paid it each time paid the whole library for a handful of rows.
    let released = if defer_collect {
        Vec::new()
    } else {
        crate::blob::collect(ctx.connection())?
    };
    // A pass in batches merges the search indexes once at its end too
    // ([`crate::Vault::compact_search`]); a pass in one command merges here.
    if !defer_collect && !purged.is_empty() {
        crate::index::compact(ctx.connection())?;
    }
    Ok(serde_json::json!({ "purged": purged.len(), "released": released, "more": more }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition::plain(
            "entity.retitle",
            "entity",
            r#"{
              "type": "object",
              "required": ["id", "title"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "maxLength": 1000 },
                "expected_rev": { "type": "integer", "minimum": 0 }
              }
            }"#,
            Idempotency::Idempotent,
            &[
                STALE_GUARD[0],
                STALE_GUARD[1],
                CommandCondition {
                    predicate: "title_is_changeable",
                    check: pre_retitle,
                },
            ],
            retitle,
        ),
        CommandDefinition::plain(
            "entity.move",
            "entity",
            r#"{
              "type": "object",
              "anyOf": [{ "required": ["id"] }, { "required": ["ids"] }],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "ids": { "type": "array", "minItems": 1, "maxItems": 500,
                         "items": { "type": "string", "minLength": 1 } },
                "parent": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "entity_can_go_there",
                check: pre_move_each,
            }],
            move_entity,
        ),
        CommandDefinition::plain(
            "entity.trash",
            "entity",
            BY_IDS,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "entity_can_be_trashed",
                check: pre_trash_each,
            }],
            trash,
        ),
        CommandDefinition::plain(
            "entity.restore",
            "entity",
            BY_IDS,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "entity_is_in_the_trash",
                check: pre_restore_each,
            }],
            restore,
        ),
        permanent(CommandDefinition::plain(
            "entity.purge",
            "entity",
            BY_ID,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "entity_can_be_purged",
                check: pre_purge,
            }],
            purge,
        )),
        permanent(CommandDefinition::plain(
            "entity.empty_trash",
            "entity",
            r#"{
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "kind": { "type": "string", "minLength": 1 },
                "with_kind": { "type": "string", "minLength": 1 },
                "due_only": { "type": "boolean" },
                "limit": { "type": "integer", "minimum": 1 },
                "defer_collect": { "type": "boolean" }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "kind_has_a_trash",
                check: pre_empty,
            }],
            empty_trash,
        )),
    ]
}

/// A permanent delete is presented the same for every kind: medium risk, and
/// parked for the owner's confirmation on every non-owner-device invocation
/// (#306 d2). It is what Locker's own purge carried; it is now the one level
/// for `entity.purge` and `entity.empty_trash` whatever they remove.
fn permanent(mut definition: CommandDefinition) -> CommandDefinition {
    definition.risk = Risk::Medium;
    definition.confirm = true;
    definition
}
