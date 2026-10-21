//! The verbs every entity shares: retitle, trash, restore, purge, empty the trash.
//!
//! One implementation for every kind that allows it, refusing the kinds it does
//! not serve with a sentence. A kind's own create and edit commands live with
//! its app; these four lines are the same for all of them
//! ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//!
//! ## What happens to what points at an entity
//!
//! The engine refuses a delete that would leave a pointer dangling (no foreign
//! key to another entity cascades or nulls itself, with two named exceptions),
//! so the command that removes the target decides, per kind, in one place:
//! [`members`] and [`DETACH`].
//!
//! - **A holder takes its members to the trash with it** and brings them back
//!   with it: a notebook's notes, a folder's documents, a project's tasks and
//!   sections, an account's transactions. They are stamped with the holder's own
//!   `deleted_at`, so a restore knows which members went *with* it and which
//!   were already in the trash.
//! - **A purge purges what went with the holder** and moves everything else to
//!   the top level (`DETACH`): a note the member restored on its own is not lost
//!   with its notebook's purge. What cannot live without the holder (a section
//!   without its project, a transaction without its account) is purged.
//! - **A purge refuses with a sentence** when something would lose its meaning:
//!   a calendar with events, an activity kind in use, the self person, a flag.

use rusqlite::{Connection, OptionalExtension};

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::Kind;

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

/// A handler's view of the same: the entity must be there, because the
/// precondition said so.
pub(crate) fn require(connection: &Connection, id: &str) -> Result<Found> {
    find(connection, id)?.ok_or_else(|| VaultError::Invariant {
        context: format!("`{id}` is not an entity, and a precondition said it was"),
    })
}

/// Whether the vault's self person is this entity.
fn is_self(connection: &Connection, id: &str) -> Result<bool> {
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

/// Every member a holder keeps, in the trash or not: what goes to the trash
/// with it and comes back with it.
fn members(connection: &Connection, holder: &Found) -> Result<Vec<String>> {
    let sql = match holder.kind {
        Kind::Notebook => "SELECT id FROM note WHERE notebook_id = ?1",
        Kind::Folder => "SELECT id FROM document WHERE folder_id = ?1",
        Kind::Project => {
            "SELECT id FROM container WHERE parent_id = ?1 AND kind = 'section'
             UNION ALL SELECT id FROM task WHERE project_id = ?1"
        }
        Kind::Account => "SELECT id FROM txn WHERE account_id = ?1",
        _ => return Ok(Vec::new()),
    };
    ids(connection, sql, &holder.id)
}

/// What a purge moves to the top level, because it may outlive its holder:
/// `(holder, referrer's table, the SET clause, the column that points at it)`.
///
/// What cannot outlive the holder is not here: [`purge_one`] purges it.
const DETACH: &[(Kind, &str, &str, &str)] = &[
    (Kind::Notebook, "note", "notebook_id = NULL", "notebook_id"),
    (Kind::Notebook, "container", "parent_id = NULL", "parent_id"),
    (Kind::Folder, "document", "folder_id = NULL", "folder_id"),
    (Kind::Folder, "container", "parent_id = NULL", "parent_id"),
    (Kind::Area, "container", "parent_id = NULL", "parent_id"),
    (
        Kind::Project,
        "task",
        "project_id = NULL, section_id = NULL",
        "project_id",
    ),
    (Kind::Section, "task", "section_id = NULL", "section_id"),
    (Kind::Category, "txn", "category_id = NULL", "category_id"),
    (Kind::Category, "concept", "parent_id = NULL", "parent_id"),
    (Kind::Place, "event", "place_id = NULL", "place_id"),
    (Kind::Place, "activity", "place_id = NULL", "place_id"),
    (Kind::Place, "photo", "place_id = NULL", "place_id"),
    (Kind::Task, "task", "parent_id = NULL", "parent_id"),
    (Kind::Task, "task", "series_id = NULL", "series_id"),
    (Kind::Txn, "txn", "transfer_id = NULL", "transfer_id"),
    (Kind::Photo, "photo", "edited_from = NULL", "edited_from"),
];

/// A sentence when this kind of entity cannot be purged as it stands.
fn purge_refusal(connection: &Connection, found: &Found) -> Result<Option<String>> {
    if is_self(connection, &found.id)? {
        return Ok(Some(
            "this is you; a vault cannot do without its owner".to_owned(),
        ));
    }
    let refusal = match found.kind {
        Kind::Flag => Some("a flag is built in and cannot be removed".to_owned()),
        Kind::Calendar => {
            let events = count(
                connection,
                "SELECT COUNT(*) FROM event WHERE calendar_id = ?1",
                &found.id,
            )?;
            (events > 0).then(|| {
                format!(
                    "{events} event{} still on “{}”; move or delete {} first",
                    if events == 1 { " is" } else { "s are" },
                    found.title,
                    if events == 1 { "it" } else { "them" },
                )
            })
        }
        Kind::WorkoutKind | Kind::ActivityKind => {
            let used = count(
                connection,
                "SELECT COUNT(*) FROM activity WHERE type_id = ?1",
                &found.id,
            )?;
            (used > 0).then(|| {
                format!(
                    "{used} {} use “{}”; change them first",
                    if used == 1 { "activity" } else { "activities" },
                    found.title
                )
            })
        }
        _ => None,
    };
    Ok(refusal)
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

/// Trash one entity at `(deleted_at, purge_at)`; its live members follow it.
pub(crate) fn trash_one(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    stamp: &(String, String),
    trashed: &mut Vec<String>,
) -> Result<()> {
    let found = require(ctx.connection(), id)?;
    ctx.connection().execute(
        "UPDATE entity SET deleted_at = ?2, purge_at = ?3 WHERE id = ?1",
        rusqlite::params![id, stamp.0, stamp.1],
    )?;
    ctx.touch(id)?;
    trashed.push(id.to_owned());
    for member in members(ctx.connection(), &found)? {
        if find(ctx.connection(), &member)?.is_some_and(|m| m.deleted_at.is_none()) {
            trash_one(ctx, &member, stamp, trashed)?;
        }
    }
    Ok(())
}

/// Purge one entity, and whatever went to the trash with it; move the rest of
/// what pointed at it to the top level.
pub(crate) fn purge_one(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    purged: &mut Vec<String>,
) -> Result<()> {
    let connection = ctx.connection();
    let Some(found) = find(connection, id)? else {
        return Ok(());
    };
    // What cannot live without the holder goes with it; what went to the trash
    // with it goes too. Everything else is detached below.
    for member in members(connection, &found)? {
        let Some(m) = find(connection, &member)? else {
            continue;
        };
        let cannot_outlive = matches!(
            (found.kind, m.kind),
            (Kind::Project, Kind::Section) | (Kind::Account, Kind::Txn)
        );
        let went_with = found.deleted_at.is_some() && m.deleted_at == found.deleted_at;
        if cannot_outlive || went_with {
            purge_one(ctx, &member, purged)?;
        }
    }
    for (holder, table, set, column) in DETACH {
        if *holder != found.kind {
            continue;
        }
        let referrers = ids(
            connection,
            &format!("SELECT id FROM {table} WHERE {column} = ?1"),
            id,
        )?;
        connection.execute(
            &format!("UPDATE {table} SET {set} WHERE {column} = ?1"),
            [id],
        )?;
        for referrer in referrers {
            // A container or a concept is an entity too; a row of any of the
            // kind tables is.
            ctx.touch(&referrer)?;
        }
    }
    // The people and things a note was about lose its words from their search
    // text; they are not touched, only re-indexed.
    for target in ids(
        connection,
        "SELECT to_id FROM edge WHERE from_id = ?1 AND rel IN ('about', 'links')",
        id,
    )? {
        ctx.mark_for_index(&target);
    }
    let n: i64 =
        connection.query_row("SELECT n FROM entity WHERE id = ?1", [id], |row| row.get(0))?;
    crate::index::forget(connection, n)?;
    connection.execute("DELETE FROM entity WHERE id = ?1", [id])?;
    purged.push(id.to_owned());
    Ok(())
}

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
    if found.kind == Kind::Flag {
        return Ok(Some("a flag is built in and keeps its name".to_owned()));
    }
    // A photograph may have no title at all; nothing else may.
    if found.kind != Kind::Photo && ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some(format!("a {} needs a name", found.kind.noun())));
    }
    Ok(None)
}

fn retitle(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let title = ctx.required_str("title")?.trim();
    ctx.connection()
        .execute("UPDATE entity SET title = ?2 WHERE id = ?1", [id, title])?;
    ctx.touch(id)?;
    Ok(serde_json::json!({ "id": id, "title": title }))
}

fn pre_trash(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let found = match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    if is_self(ctx.connection(), &found.id)? {
        return Ok(Some(
            "this is you; a vault cannot do without its owner".to_owned(),
        ));
    }
    Ok((!found.kind.has_trash())
        .then(|| format!("a {} is deleted, not moved to the trash", found.kind.noun())))
}

fn trash(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let stamp = trash_stamp(ctx)?;
    let mut trashed = Vec::new();
    trash_one(ctx, ctx.required_str("id")?, &stamp, &mut trashed)?;
    Ok(serde_json::json!({ "trashed": trashed, "purge_at": stamp.1 }))
}

fn pre_restore(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(match lookup(ctx.connection(), ctx.required_str("id")?)? {
        Err(sentence) => Some(sentence),
        Ok(found) => found
            .deleted_at
            .is_none()
            .then(|| format!("“{}” is not in the trash", found.title)),
    })
}

fn restore(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let holder = require(ctx.connection(), id)?;
    let mut restored = Vec::new();
    // The holder's members that went to the trash WITH it come back with it;
    // the ones that were already there stay where they were.
    let with_it: Vec<String> = members(ctx.connection(), &holder)?
        .into_iter()
        .filter(|member| {
            find(ctx.connection(), member)
                .ok()
                .flatten()
                .is_some_and(|m| m.deleted_at == holder.deleted_at)
        })
        .collect();
    for target in std::iter::once(id.to_owned()).chain(with_it) {
        ctx.connection().execute(
            "UPDATE entity SET deleted_at = NULL, purge_at = NULL WHERE id = ?1",
            [&target],
        )?;
        ctx.touch(&target)?;
        restored.push(target);
    }
    Ok(serde_json::json!({ "restored": restored }))
}

fn pre_purge(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let found = match lookup(ctx.connection(), ctx.required_str("id")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    if found.kind.has_trash() && found.deleted_at.is_none() {
        return Ok(Some(format!(
            "“{}” is not in the trash; move it there first",
            found.title
        )));
    }
    purge_refusal(ctx.connection(), &found)
}

fn purge(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let mut purged = Vec::new();
    purge_one(ctx, ctx.required_str("id")?, &mut purged)?;
    Ok(serde_json::json!({ "purged": purged }))
}

fn pre_empty(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(match ctx.optional_str("kind") {
        None => None,
        Some(word) => match Kind::parse(word) {
            None => Some(format!("`{word}` is not a kind of thing in this vault")),
            Some(kind) if !kind.has_trash() => {
                Some(format!("a {} has no trash to empty", kind.noun()))
            }
            Some(_) => None,
        },
    })
}

/// Purge what is in the trash: one kind's, or every kind's; all of it, or only
/// what has waited out its window.
fn empty_trash(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let due_only = ctx
        .input
        .get("due_only")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let kind = ctx.optional_str("kind");
    let doomed: Vec<String> = ctx
        .connection()
        .prepare(
            "SELECT id FROM entity
              WHERE deleted_at IS NOT NULL
                AND (?1 IS NULL OR kind = ?1)
                AND (?2 = 0 OR purge_at <= ?3)
              ORDER BY deleted_at, n",
        )?
        .query_map(
            rusqlite::params![kind, i64::from(due_only), ctx.now],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut purged = Vec::new();
    for id in &doomed {
        if is_self(ctx.connection(), id)? {
            continue;
        }
        purge_one(ctx, id, &mut purged)?;
    }
    Ok(serde_json::json!({ "purged": purged.len() }))
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
                "title": { "type": "string", "maxLength": 1000 }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "title_is_changeable",
                check: pre_retitle,
            }],
            retitle,
        ),
        CommandDefinition::plain(
            "entity.trash",
            "entity",
            BY_ID,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "entity_can_be_trashed",
                check: pre_trash,
            }],
            trash,
        ),
        CommandDefinition::plain(
            "entity.restore",
            "entity",
            BY_ID,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "entity_is_in_the_trash",
                check: pre_restore,
            }],
            restore,
        ),
        CommandDefinition::plain(
            "entity.purge",
            "entity",
            BY_ID,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "entity_can_be_purged",
                check: pre_purge,
            }],
            purge,
        ),
        CommandDefinition::plain(
            "entity.empty_trash",
            "entity",
            r#"{
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "kind": { "type": "string", "minLength": 1 },
                "due_only": { "type": "boolean" }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "kind_has_a_trash",
                check: pre_empty,
            }],
            empty_trash,
        ),
    ]
}
