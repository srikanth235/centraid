//! Two-way calendar sync, the vault's half: what is OWED to a phone calendar, and `follow.pushed`.
//!
//! The vault stays the only writer of the vault; the phone's calendar store is written by the
//! shell, and only when the core asks. **No queue table**: a push is *derived* at read time from
//! the rows the follower already keeps ([`owed_pushes`]), so a push that fails, or is never
//! answered, is simply owed again at the next pass (C11).
//!
//! A push is owed when the event's calendar is a followed phone calendar the shell reported
//! writable (a calendar not reported is read-only, and so is a Centraid-only one with no origin)
//! and one of:
//!
//! - **update**: the event has a live source and a followed field of the vault differs from what
//!   the source last `stated` (the member edited it here);
//! - **create**: the event is live in the calendar and has NO source row, marked or not (born in
//!   Centraid, or moved in);
//! - **delete**: the event is in the trash and its source is live (`gone_at` empty).
//!
//! A source the phone unlinked keeps its row with `gone_at` set and the event live
//! ([`crate::commands::follow::SystemMap::unlink_mark`]), which is why such an event is not owed a
//! create (C5).
//!
//! ## C12: a restore after a pushed delete re-creates the event on the phone
//!
//! The member trashed a followed event, the shell deleted the phone's copy (C6) and the source was
//! tombstoned; later the member restores it from the trash. The event is theirs again and belongs in
//! its phone calendar, so it must be owed a CREATE again. The mechanism is not a new rule or a new
//! column: **C6 leaves the tombstone in the form a purge leaves**, a source of no row
//! (`entity_id` NULL, the answer to the phone's old id), so a restored event has no source and the
//! derived create above is owed to it. When the shell answers, `follow.pushed` links the NEW id the
//! phone minted by inserting a new source row; the tombstone is never relinked
//! (`source_tombstone_is_final` forbids it), and the next complete read that no longer holds its old
//! record forgets it, as for any tombstone. A restore needs no code of its own and cannot be told
//! from a restore of any other trashed event; what it cannot do is reach the cases that must NOT
//! re-create, because they keep a LINKED source row and so are never "no source": the C5 marker (the
//! phone deleted an event the member had edited: `gone_at` set, the event live) and the follower's
//! own C4 trash, which the record's return undoes.
//!
//! [`pushed`] is `follow.pushed`: the shell's answers. For an item that went through it records
//! what the phone now holds (`stated`), links a created event to the id the phone minted, tombstones
//! a deleted one (C6; C12 for a restore of it), or forgets a delete the phone declined because it
//! had changed (C7). A failed item changes nothing.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value as Json, json};

use crate::commands::entity;
use crate::commands::follow::{self, SYSTEMS, SystemMap};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};

/// The most pushes one page of [`owed_pushes`] carries.
pub const MAX_OWED: usize = 200;

/// How many linked sources one step of the scan reads.
const SCAN_STEP: i64 = 200;

/// What a push does to the phone's calendar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Create,
    Update,
    Delete,
}

impl Op {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

/// One push the phone owes the vault a copy of.
#[derive(Debug, Clone, PartialEq)]
pub struct Owed {
    pub op: Op,
    pub event_id: String,
    /// The phone calendar's origin and the ref the shell knows it by.
    pub origin_id: String,
    pub origin_ref: String,
    /// The phone's id for the event, when it has one (not for a create).
    pub external_id: Option<String>,
    pub device_id: Option<String>,
    /// The followed fields whose vault value differs from what the phone last stated (an update);
    /// every followed field for a create. `overrides` names a change to single days.
    pub changed: Vec<String>,
    /// What the phone last stated (an update and a delete: the shell compares its own copy with
    /// this before it deletes).
    pub stated: Json,
    /// The followed fields as the vault holds them: the title, times, rule, alerts, `overrides`
    /// and the rest. Never the guests, which are not pushed.
    pub fields: Json,
}

/// One page of owed pushes, in event-id order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OwedPage {
    pub items: Vec<Owed>,
    /// Pass this as `after` to read the next page; `None` when nothing is left.
    pub next: Option<String>,
}

/// An event with a live source, as the scan reads it.
struct Linked {
    event_id: String,
    external_id: String,
    device_id: Option<String>,
    stated: Json,
    deleted_at: Option<String>,
}

fn calendar_map() -> Result<&'static SystemMap> {
    SYSTEMS
        .iter()
        .find(|map| map.system == "calendar")
        .ok_or_else(|| VaultError::Invariant {
            context: "the vault follows no calendar".to_owned(),
        })
}

/// The followed fields of an event as a push carries them: every field the vault holds, and the
/// title, without the guests.
fn pushed_fields(connection: &Connection, map: &SystemMap, id: &str) -> Result<Map<String, Json>> {
    let mut fields = follow::current(connection, map, id)?;
    fields.remove("attendees");
    Ok(fields)
}

/// The followed fields whose vault value is not what the phone stated.
fn differing(map: &SystemMap, now: &Map<String, Json>, stated: &Json) -> Vec<String> {
    let mut names: Vec<String> = now
        .keys()
        .filter(|name| name.as_str() != "attendees" && !map.fixed.contains(&name.as_str()))
        .filter(|name| {
            let said = stated.get(name.as_str());
            // A field the phone has never stated, over a blank, is not a change.
            let blank = said.is_none() && now.get(name.as_str()).is_none_or(Json::is_null);
            !blank && !map.agree(name, now.get(name.as_str()), said)
        })
        .cloned()
        .collect();
    names.sort();
    names
}

/// The writable origins' calendars: `(origin id, ref, calendar id)`.
fn writable_origins(
    connection: &Connection,
    writable: &[String],
) -> Result<Vec<(String, String, String)>> {
    let mut found = Vec::new();
    for origin in writable {
        let row: Option<(String, String, String)> = connection
            .query_row(
                "SELECT id, ref, fills FROM origin
                  WHERE id = ?1 AND system = 'calendar' AND fills IS NOT NULL",
                [origin],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        found.extend(row);
    }
    Ok(found)
}

/// The vault's origin ids of the followed phone calendars the shell names by ref (`calendar:<key>`),
/// in the order named; a ref no calendar is followed under is left out. The shell knows its
/// calendars by ref, and the ids [`owed_pushes`] takes are minted.
///
/// # Errors
///
/// A database error.
pub fn origin_ids(connection: &Connection, refs: &[String]) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    for reference in refs {
        let found: Option<String> = connection
            .query_row(
                "SELECT id FROM origin WHERE system = 'calendar' AND ref = ?1
                  ORDER BY created_at, id LIMIT 1",
                [reference],
                |row| row.get(0),
            )
            .optional()?;
        ids.extend(found);
    }
    Ok(ids)
}

/// The pushes owed to the phone calendars among `writable` (origin ids the shell reported
/// writable), after the event `after`, at most `limit` of them (clamped to [`MAX_OWED`]).
///
/// Bounded: it reads the linked sources and the unlinked events of the writable calendars a step at
/// a time, in event-id order, and stops when the page is full, naming where to continue.
///
/// # Errors
///
/// A database error.
pub fn owed_pushes(
    connection: &Connection,
    writable: &[String],
    after: Option<&str>,
    limit: usize,
) -> Result<OwedPage> {
    let limit = limit.clamp(1, MAX_OWED);
    let map = calendar_map()?;
    let origins = writable_origins(connection, writable)?;
    if origins.is_empty() {
        return Ok(OwedPage::default());
    }
    let mut items: Vec<Owed> = Vec::new();
    for (origin_id, origin_ref, calendar_id) in &origins {
        // Updates and deletes: events with a live source of this origin.
        let mut cursor = after.unwrap_or("").to_owned();
        let start = items.len();
        loop {
            let linked: Vec<Linked> = connection
                .prepare(
                    "SELECT s.entity_id, s.external_id, s.device_id, s.stated, e.deleted_at
                       FROM source s JOIN entity e ON e.id = s.entity_id
                      WHERE s.origin_id = ?1 AND s.gone_at IS NULL AND s.entity_id > ?2
                        AND e.kind = 'event'
                      ORDER BY s.entity_id LIMIT ?3",
                )?
                .query_map(rusqlite::params![origin_id, cursor, SCAN_STEP], |row| {
                    let stated: String = row.get(3)?;
                    Ok(Linked {
                        event_id: row.get(0)?,
                        external_id: row.get(1)?,
                        device_id: row.get(2)?,
                        stated: serde_json::from_str(&stated).unwrap_or(Json::Null),
                        deleted_at: row.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            let read = linked.len();
            for Linked {
                event_id,
                external_id,
                device_id,
                stated,
                deleted_at,
            } in linked
            {
                cursor.clone_from(&event_id);
                if deleted_at.is_some() {
                    items.push(Owed {
                        op: Op::Delete,
                        event_id,
                        origin_id: origin_id.clone(),
                        origin_ref: origin_ref.clone(),
                        external_id: Some(external_id),
                        device_id,
                        changed: Vec::new(),
                        stated,
                        fields: Json::Null,
                    });
                    continue;
                }
                let now = pushed_fields(connection, map, &event_id)?;
                let changed = differing(map, &now, &stated);
                if !changed.is_empty() {
                    items.push(Owed {
                        op: Op::Update,
                        event_id,
                        origin_id: origin_id.clone(),
                        origin_ref: origin_ref.clone(),
                        external_id: Some(external_id),
                        device_id,
                        changed,
                        stated,
                        fields: Json::Object(now),
                    });
                }
            }
            // Sources are read in event-id order, so once this origin owes more than a page the
            // rest of its sources sort after the page and need not be read.
            if read < usize::try_from(SCAN_STEP).unwrap_or(usize::MAX)
                || items.len() - start > limit
            {
                break;
            }
        }
        // Creates: live events of the calendar nothing follows, marked or not.
        let unlinked: Vec<String> = connection
            .prepare(
                "SELECT e.id FROM event v JOIN entity e ON e.id = v.id
                  WHERE v.calendar_id = ?1 AND e.deleted_at IS NULL AND v.status <> 'cancelled'
                    AND e.id > ?2
                    AND NOT EXISTS (SELECT 1 FROM source s WHERE s.entity_id = e.id)
                  ORDER BY e.id LIMIT ?3",
            )?
            .query_map(
                rusqlite::params![calendar_id, after.unwrap_or(""), limit as i64 + 1],
                |row| row.get(0),
            )?
            .collect::<rusqlite::Result<_>>()?;
        for event_id in unlinked {
            if entity::is_self(connection, &event_id)? {
                continue;
            }
            let mut now = pushed_fields(connection, map, &event_id)?;
            // No statement to read the days against: a series pushes the days it holds.
            now.insert(
                "overrides".to_owned(),
                crate::commands::event::overrides_held(connection, &event_id)?,
            );
            let mut changed: Vec<String> = now
                .keys()
                .filter(|name| !now[name.as_str()].is_null())
                .cloned()
                .collect();
            changed.sort();
            items.push(Owed {
                op: Op::Create,
                event_id,
                origin_id: origin_id.clone(),
                origin_ref: origin_ref.clone(),
                external_id: None,
                device_id: None,
                changed,
                stated: Json::Null,
                fields: Json::Object(now),
            });
        }
    }
    items.sort_by(|left, right| left.event_id.cmp(&right.event_id));
    let full = items.len() > limit;
    items.truncate(limit);
    let next = if full {
        items.last().map(|last| last.event_id.clone())
    } else {
        None
    };
    Ok(OwedPage { items, next })
}

// ---------------------------------------------------------------------------
// follow.pushed
// ---------------------------------------------------------------------------

struct Answer<'a> {
    event_id: &'a str,
    op: &'a str,
    ok: bool,
    external_id: Option<&'a str>,
    device_id: Option<&'a str>,
    fields: Option<&'a Map<String, Json>>,
    phone_kept: bool,
}

fn answers(input: &Json) -> Vec<Answer<'_>> {
    input
        .get("items")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .map(|item| Answer {
            event_id: item
                .get("event_id")
                .and_then(Json::as_str)
                .unwrap_or_default(),
            op: item.get("op").and_then(Json::as_str).unwrap_or_default(),
            ok: item.get("ok").and_then(Json::as_bool).unwrap_or(false),
            external_id: item
                .get("external_id")
                .and_then(Json::as_str)
                .filter(|id| !id.trim().is_empty()),
            device_id: item
                .get("device_id")
                .and_then(Json::as_str)
                .filter(|id| !id.trim().is_empty()),
            fields: item.get("fields").and_then(Json::as_object),
            phone_kept: item
                .get("phone_kept")
                .and_then(Json::as_bool)
                .unwrap_or(false),
        })
        .collect()
}

fn pre_pushed(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    for answer in answers(&ctx.input) {
        if answer.event_id.trim().is_empty() {
            return Ok(Some("every answer names its event".to_owned()));
        }
        if answer.op == "create" && answer.ok && answer.external_id.is_none() {
            return Ok(Some(
                "a created event needs the id the phone gave it".to_owned(),
            ));
        }
    }
    Ok(None)
}

/// A source of an event: its row id, its origin, whether it is live (`gone_at` empty).
fn source_of(connection: &Connection, event_id: &str) -> Result<Option<(String, Json, bool)>> {
    Ok(connection
        .query_row(
            "SELECT id, stated, gone_at IS NULL FROM source WHERE entity_id = ?1",
            [event_id],
            |row| {
                let stated: String = row.get(1)?;
                Ok((
                    row.get(0)?,
                    serde_json::from_str(&stated).unwrap_or(Json::Null),
                    row.get(2)?,
                ))
            },
        )
        .optional()?)
}

/// What the phone now holds of an event: what it last stated, over which what was pushed (or, with
/// nothing said, what the vault holds) lands.
fn stated_after(
    connection: &Connection,
    map: &SystemMap,
    event_id: &str,
    before: &Json,
    answer: &Answer<'_>,
) -> Result<Json> {
    let mut stated = before.as_object().cloned().unwrap_or_default();
    let pushed = match answer.fields {
        Some(fields) => fields.clone(),
        None => pushed_fields(connection, map, event_id)?,
    };
    for (name, value) in pushed {
        stated.insert(name, value);
    }
    Ok(Json::Object(stated))
}

/// `follow.pushed`: record what the shell wrote to the phone's calendar.
fn pushed(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let connection = ctx.connection();
    let map = calendar_map()?;
    let (mut created, mut updated, mut deleted, mut unlinked, mut failed, mut ignored) =
        (0, 0, 0, 0, 0, 0);
    for answer in answers(&ctx.input) {
        if !answer.ok {
            // C11: nothing changes, so it is owed again.
            failed += 1;
            continue;
        }
        let Some(held) = entity::find(connection, answer.event_id)?
            .filter(|held| held.kind == crate::model::Kind::Event)
        else {
            ignored += 1;
            continue;
        };
        let source = source_of(connection, answer.event_id)?;
        match (answer.op, source) {
            ("create", None) => {
                let calendar: Option<String> = connection
                    .query_row(
                        "SELECT calendar_id FROM event WHERE id = ?1",
                        [answer.event_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let origin: Option<(String, Option<String>)> = match calendar {
                    Some(calendar) => connection
                        .query_row(
                            "SELECT id, device_id FROM origin
                              WHERE system = 'calendar' AND fills = ?1
                              ORDER BY created_at, id LIMIT 1",
                            [calendar],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()?,
                    None => None,
                };
                let (Some((origin, origin_device)), Some(external)) = (origin, answer.external_id)
                else {
                    ignored += 1;
                    continue;
                };
                let device = answer.device_id.map(str::to_owned).or(origin_device);
                let taken: bool = connection.query_row(
                    "SELECT EXISTS (SELECT 1 FROM source WHERE origin_id = ?1 AND external_id = ?2
                                     AND ifnull(device_id, '') = ?3)",
                    rusqlite::params![origin, external, device.as_deref().unwrap_or("")],
                    |row| row.get(0),
                )?;
                if taken {
                    ignored += 1;
                    continue;
                }
                let stated = stated_after(connection, map, answer.event_id, &Json::Null, &answer)?;
                connection.execute(
                    "INSERT INTO source (id, origin_id, system, external_id, device_id,
                                         entity_id, entity_kind, stated, seen_at)
                     VALUES (?1, ?2, 'calendar', ?3, ?4, ?5, 'event', ?6, ?7)",
                    rusqlite::params![
                        ctx.next_id(),
                        origin,
                        external,
                        device,
                        answer.event_id,
                        stated.to_string(),
                        ctx.now
                    ],
                )?;
                created += 1;
            }
            ("update" | "create", Some((source, before, live))) if live => {
                let stated = stated_after(connection, map, answer.event_id, &before, &answer)?;
                connection.execute(
                    "UPDATE source SET stated = ?2, seen_at = ?3 WHERE id = ?1",
                    rusqlite::params![source, stated.to_string(), ctx.now],
                )?;
                updated += 1;
            }
            ("delete", Some((source, _, true))) if held.deleted_at.is_some() => {
                if answer.phone_kept {
                    // C7: the phone changed it since it was stated, so its copy stays there and the
                    // vault forgets the link.
                    connection.execute("DELETE FROM source WHERE id = ?1", [&source])?;
                    unlinked += 1;
                } else {
                    // C6: deleted on the phone. The source becomes a TOMBSTONE of the phone's
                    // old id, the form a purge leaves it in (a source of no row): never owed again,
                    // the phone's returning record is not re-imported over the member's trash, and
                    // an explicit restore of the event later finds it with no source, so a create
                    // is owed again (C12). `UPDATE`, never `REPLACE`.
                    connection.execute(
                        "UPDATE source SET entity_id = NULL, entity_kind = NULL,
                                           gone_at = ?2, seen_at = ?2
                          WHERE id = ?1",
                        [&source, &ctx.now],
                    )?;
                    deleted += 1;
                }
            }
            _ => ignored += 1,
        }
    }
    Ok(json!({
        "created": created,
        "updated": updated,
        "deleted": deleted,
        "unlinked": unlinked,
        "failed": failed,
        "ignored": ignored,
    }))
}

const PUSHED_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["items"],
  "additionalProperties": false,
  "properties": {
    "items": {
      "type": "array",
      "maxItems": 200,
      "items": {
        "type": "object",
        "required": ["event_id", "op", "ok"],
        "additionalProperties": false,
        "properties": {
          "event_id": { "type": "string", "minLength": 1 },
          "op": { "type": "string", "enum": ["create", "update", "delete"] },
          "ok": { "type": "boolean", "description": "Whether the shell did it; a failed item changes nothing." },
          "external_id": { "type": ["string", "null"], "description": "The id the phone gave a created event." },
          "device_id": { "type": ["string", "null"] },
          "fields": { "type": ["object", "null"], "description": "The fields as pushed; the vault's own when none." },
          "phone_kept": { "type": "boolean", "description": "A delete the shell did not do because the phone's copy had changed since it was stated." }
        }
      }
    }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![CommandDefinition::plain(
        "follow.pushed",
        "follow",
        PUSHED_SCHEMA,
        Idempotency::Idempotent,
        &[CommandCondition {
            predicate: "every_answer_names_its_event",
            check: pre_pushed,
        }],
        pushed,
    )]
}
