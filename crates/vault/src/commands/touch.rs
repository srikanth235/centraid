//! A touch (L1): a call, a message, a meet-up, logged in People.
//!
//! A touch is its own kind of item: its `type_id` is a `touch_kind` concept (`call`, `message`,
//! `met-up`, or any word the member adds), `starts` and `ends` are instants, `place_id` is where
//! it happened and `notes` its words. It is joined `with` each person in it by an `edge`. It
//! spawns no separate note, and its title is its kind's word. **"Last contacted" is computed at
//! read** from the touches ([`last_contacted`]) and is stored nowhere; a person's cadence
//! (`person.cadence_days`) says when they are due ([`due`]).
//!
//! A touch is trashed, restored and deleted for good with the shared `entity` verbs, and its
//! earlier versions are the history's.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::edge::{self, Extras};
use crate::commands::entity::{self, lookup_live};
use crate::commands::person::refusal_unless_live_person;
use crate::commands::tag::{ensure_concept, find_concept};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;
use crate::model::{Kind, Rel};

/// An instant in the clock's one form, or `None` when the text is not one.
fn instant(raw: &str) -> Option<String> {
    crate::time::recurrence::parse_instant_ms(raw).map(crate::clock::format_iso_ms)
}

fn people_of(ctx: &CommandCtx<'_, '_>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    ctx.input
        .get("people")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .filter(|id| seen.insert((*id).to_owned()))
        .map(str::to_owned)
        .collect()
}

/// The touch kind a member's word names: a kind they have by that word, or one the seed gave under
/// its own title (`Met up` is the seeded `met-up`), else a new one of theirs.
fn kind_for(ctx: &CommandCtx<'_, '_>, label: &str) -> Result<String> {
    if let Some(id) = find_concept(ctx.connection(), Kind::TouchKind, label)? {
        return Ok(id);
    }
    let by_title: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT c.id FROM concept c JOIN entity e ON e.id = c.id
              WHERE c.kind = 'touch_kind' AND e.title = ?1 COLLATE NOCASE
              ORDER BY e.created_at, e.id LIMIT 1",
            [label.trim()],
            |row| row.get(0),
        )
        .optional()?;
    match by_title {
        Some(id) => Ok(id),
        None => ensure_concept(ctx, Kind::TouchKind, label),
    }
}

/// A sentence when this is not a live place.
fn place_refusal(connection: &Connection, place: &str) -> Result<Option<String>> {
    Ok(match lookup_live(connection, place)? {
        Err(sentence) => Some(sentence),
        Ok(found) if found.kind != Kind::Place => Some(format!(
            "“{}” is a {}, not a place",
            found.title,
            found.kind.noun()
        )),
        Ok(_) => None,
    })
}

/// The refusals the two verbs share: each person is a live person, the instants are instants and
/// do not run backwards, the place is a place.
fn shared_refusal(ctx: &CommandCtx<'_, '_>, starts: Option<&str>) -> Result<Option<String>> {
    for person in people_of(ctx) {
        if let Some(sentence) = refusal_unless_live_person(ctx.connection(), &person)? {
            return Ok(Some(sentence));
        }
    }
    for key in ["starts", "ends"] {
        if let Some(text) = ctx.optional_str(key)
            && instant(text).is_none()
        {
            return Ok(Some(format!("{text} is not a time")));
        }
    }
    if let (Some(starts), Some(ends)) = (
        starts.and_then(instant),
        ctx.optional_str("ends").and_then(instant),
    ) && ends < starts
    {
        return Ok(Some("a touch cannot end before it starts".to_owned()));
    }
    if let Some(place) = ctx.optional_str("place_id") {
        return place_refusal(ctx.connection(), place);
    }
    Ok(None)
}

fn pre_log(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if crate::model::fold_label(ctx.required_str("kind")?).is_empty() {
        return Ok(Some("say what kind of touch it was".to_owned()));
    }
    if people_of(ctx).is_empty() {
        return Ok(Some("a touch is with someone".to_owned()));
    }
    if let Some(id) = ctx.optional_str("id")
        && entity::find(ctx.connection(), id)?.is_some()
    {
        return Ok(Some(
            "a touch already holds the id this write minted".to_owned(),
        ));
    }
    shared_refusal(ctx, ctx.optional_str("starts"))
}

/// A touch's own start: the instant it says, else now.
fn starts_of(ctx: &CommandCtx<'_, '_>) -> String {
    ctx.optional_str("starts")
        .and_then(instant)
        .unwrap_or_else(|| ctx.now.clone())
}

fn log(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let connection = ctx.connection();
    let kind = kind_for(ctx, ctx.required_str("kind")?)?;
    let title: String =
        connection.query_row("SELECT title FROM entity WHERE id = ?1", [&kind], |row| {
            row.get(0)
        })?;
    let id = match ctx.optional_str("id") {
        Some(id) => {
            ctx.insert_entity_as(id, Kind::Touch, &title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Touch, &title)?,
    };
    connection.execute(
        "INSERT INTO touch (id, type_id, starts, ends, place_id, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            id,
            kind,
            starts_of(ctx),
            ctx.optional_str("ends").and_then(instant),
            ctx.optional_str("place_id"),
            ctx.optional_str("notes")
                .map(str::trim)
                .filter(|notes| !notes.is_empty()),
        ],
    )?;
    for person in people_of(ctx) {
        edge::put(ctx, &id, Rel::With, &person, None, &Extras::default())?;
    }
    Ok(json!({ "id": id, "touch_id": id }))
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let found = match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    if found.kind != Kind::Touch {
        return Ok(Some(format!(
            "“{}” is a {}, not a touch",
            found.title,
            found.kind.noun()
        )));
    }
    if ctx
        .optional_str("kind")
        .is_some_and(|kind| crate::model::fold_label(kind).is_empty())
    {
        return Ok(Some("say what kind of touch it was".to_owned()));
    }
    if ctx.input.get("people").is_some() && people_of(ctx).is_empty() {
        return Ok(Some("a touch is with someone".to_owned()));
    }
    // The end is judged against the start it will have.
    let held_start: String = ctx.connection().query_row(
        "SELECT starts FROM touch WHERE id = ?1",
        [&found.id],
        |row| row.get(0),
    )?;
    let starts = ctx.optional_str("starts").unwrap_or(&held_start);
    if let Some(sentence) = shared_refusal(ctx, Some(starts))? {
        return Ok(Some(sentence));
    }
    // An end already held, kept when only the start moves, must still not run backwards.
    if ctx.input.get("ends").is_none()
        && let Some(start) = ctx.optional_str("starts").and_then(instant)
    {
        let held_end: Option<String> = ctx.connection().query_row(
            "SELECT ends FROM touch WHERE id = ?1",
            [&found.id],
            |row| row.get(0),
        )?;
        if held_end.is_some_and(|end| end < start) {
            return Ok(Some("a touch cannot end before it starts".to_owned()));
        }
    }
    Ok(None)
}

#[derive(serde::Deserialize)]
struct EditInput {
    id: String,
    kind: Option<String>,
    starts: Option<String>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    ends: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    place_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    notes: Option<Option<String>>,
    people: Option<Vec<String>>,
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: EditInput = ctx.parse_input()?;
    let (connection, id) = (ctx.connection(), input.id.as_str());
    if let Some(label) = input.kind.as_deref() {
        let kind = kind_for(ctx, label)?;
        let title: String =
            connection.query_row("SELECT title FROM entity WHERE id = ?1", [&kind], |row| {
                row.get(0)
            })?;
        connection.execute(
            "UPDATE touch SET type_id = ?2 WHERE id = ?1",
            [id, kind.as_str()],
        )?;
        connection.execute(
            "UPDATE entity SET title = ?2 WHERE id = ?1",
            [id, title.as_str()],
        )?;
    }
    if let Some(starts) = input.starts.as_deref().and_then(instant) {
        connection.execute(
            "UPDATE touch SET starts = ?2 WHERE id = ?1",
            [id, starts.as_str()],
        )?;
    }
    if let Some(ends) = input.ends {
        connection.execute(
            "UPDATE touch SET ends = ?2 WHERE id = ?1",
            rusqlite::params![id, ends.as_deref().and_then(instant)],
        )?;
    }
    if let Some(place) = input.place_id {
        connection.execute(
            "UPDATE touch SET place_id = ?2 WHERE id = ?1",
            rusqlite::params![id, place],
        )?;
    }
    if let Some(notes) = input.notes {
        connection.execute(
            "UPDATE touch SET notes = ?2 WHERE id = ?1",
            rusqlite::params![
                id,
                notes
                    .as_deref()
                    .map(str::trim)
                    .filter(|notes| !notes.is_empty())
            ],
        )?;
    }
    if input.people.is_some() {
        let wanted: BTreeSet<String> = people_of(ctx).into_iter().collect();
        let held: BTreeSet<String> = connection
            .prepare_cached("SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'with'")?
            .query_map([id], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for gone in held.difference(&wanted) {
            connection.execute(
                "DELETE FROM edge WHERE from_id = ?1 AND rel = 'with' AND to_id = ?2",
                [id, gone.as_str()],
            )?;
        }
        for new in wanted.difference(&held) {
            edge::put(ctx, id, Rel::With, new, None, &Extras::default())?;
        }
    }
    ctx.touch(id)?;
    entity::with_rev(ctx, id, json!({ "id": id }))
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// A touch as a screen reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct TouchRow {
    pub id: String,
    /// The touch kind's id and its word (`Call`).
    pub kind_id: String,
    pub kind: String,
    pub starts: String,
    pub ends: Option<String>,
    pub place_id: Option<String>,
    pub notes: Option<String>,
    /// The people in it, in name order.
    pub people: Vec<String>,
}

/// The touches `with` a person that are not in the trash, newest first; at most `limit`.
///
/// # Errors
/// SQLite's refusal.
pub fn touches_of(connection: &Connection, person: &str, limit: usize) -> Result<Vec<TouchRow>> {
    let mut statement = connection.prepare_cached(
        "SELECT t.id, t.type_id, k.title, t.starts, t.ends, t.place_id, t.notes
           FROM edge w JOIN touch t ON t.id = w.from_id
           JOIN entity te ON te.id = t.id AND te.deleted_at IS NULL
           JOIN entity k ON k.id = t.type_id
          WHERE w.to_id = ?1 AND w.rel = 'with'
          ORDER BY t.starts DESC, t.id DESC LIMIT ?2",
    )?;
    let mut rows = statement
        .query_map(
            rusqlite::params![person, i64::try_from(limit).unwrap_or(i64::MAX)],
            |row| {
                Ok(TouchRow {
                    id: row.get(0)?,
                    kind_id: row.get(1)?,
                    kind: row.get(2)?,
                    starts: row.get(3)?,
                    ends: row.get(4)?,
                    place_id: row.get(5)?,
                    notes: row.get(6)?,
                    people: Vec::new(),
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut who = connection.prepare_cached(
        "SELECT e.id FROM edge w JOIN entity e ON e.id = w.to_id
          WHERE w.from_id = ?1 AND w.rel = 'with' ORDER BY e.title COLLATE NOCASE, e.id",
    )?;
    for row in &mut rows {
        row.people = who
            .query_map([&row.id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
    }
    Ok(rows)
}

/// WHEN A PERSON WAS LAST CONTACTED, at read: the latest start, at or before `now`, of a touch
/// `with` them that is not in the trash. `None` when they never were.
///
/// # Errors
/// SQLite's refusal.
pub fn last_contacted(connection: &Connection, person: &str, now: &str) -> Result<Option<String>> {
    Ok(connection.query_row(
        "SELECT max(t.starts)
           FROM edge w JOIN touch t ON t.id = w.from_id
           JOIN entity te ON te.id = t.id AND te.deleted_at IS NULL
          WHERE w.to_id = ?1 AND w.rel = 'with' AND t.starts <= ?2",
        [person, now],
        |row| row.get(0),
    )?)
}

/// A person whose cadence says they are due to hear from the member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Due {
    pub person_id: String,
    pub person: String,
    pub cadence_days: i64,
    pub last_contacted: Option<String>,
    /// When they became due: the last touch plus the cadence, or, for someone never contacted,
    /// the day they were added plus it.
    pub due_at: String,
}

/// The people with a cadence who are due at `now`, most overdue first: the in-trash and the owner
/// are not asked about.
///
/// # Errors
/// SQLite's refusal.
pub fn due(connection: &Connection, now: &str) -> Result<Vec<Due>> {
    let mut statement = connection.prepare_cached(
        "SELECT e.id, e.title, p.cadence_days, e.created_at,
                (SELECT max(t.starts) FROM edge w JOIN touch t ON t.id = w.from_id
                   JOIN entity te ON te.id = t.id AND te.deleted_at IS NULL
                  WHERE w.to_id = e.id AND w.rel = 'with' AND t.starts <= ?1)
           FROM person p JOIN entity e ON e.id = p.id
          WHERE p.cadence_days IS NOT NULL AND e.deleted_at IS NULL
            AND e.id IS NOT (SELECT self_id FROM vault)",
    )?;
    let rows = statement
        .query_map([now], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let now_ms = crate::clock::parse_iso_ms(now).unwrap_or(i64::MAX);
    let mut due: Vec<Due> = rows
        .into_iter()
        .filter_map(|(person_id, person, cadence_days, created, last)| {
            let since = last.as_deref().unwrap_or(&created);
            let due_ms =
                crate::clock::parse_iso_ms(since)?.checked_add(cadence_days * 86_400_000)?;
            (due_ms <= now_ms).then(|| Due {
                person_id,
                person,
                cadence_days,
                last_contacted: last,
                due_at: crate::clock::format_iso_ms(due_ms),
            })
        })
        .collect();
    due.sort_by(|a, b| (&a.due_at, &a.person_id).cmp(&(&b.due_at, &b.person_id)));
    Ok(due)
}

/// The touch kinds the member has words for, in name order (what the logging sheet offers).
///
/// # Errors
/// SQLite's refusal.
pub fn kinds(connection: &Connection) -> Result<Vec<(String, String)>> {
    let mut statement = connection.prepare_cached(
        "SELECT e.id, e.title FROM concept c JOIN entity e ON e.id = c.id
          WHERE c.kind = 'touch_kind' AND e.deleted_at IS NULL ORDER BY e.title COLLATE NOCASE, e.id",
    )?;
    Ok(statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

/// The id of the touch kind a word names, when the vault has one.
///
/// # Errors
/// SQLite's refusal.
pub fn kind_named(connection: &Connection, label: &str) -> Result<Option<String>> {
    find_concept(connection, Kind::TouchKind, label)
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition::plain(
            "touch.log",
            "touch",
            r#"{
              "type": "object",
              "required": ["people", "kind"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "people": { "type": "array", "minItems": 1, "maxItems": 100,
                            "items": { "type": "string", "minLength": 1 } },
                "kind": { "type": "string", "minLength": 1, "maxLength": 100 },
                "starts": { "type": "string" },
                "ends": { "type": "string" },
                "place_id": { "type": "string", "minLength": 1 },
                "notes": { "type": "string" }
              }
            }"#,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "touch_is_with_live_people",
                check: pre_log,
            }],
            log,
        ),
        CommandDefinition::plain(
            "touch.edit",
            "touch",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "kind": { "type": "string", "minLength": 1, "maxLength": 100 },
                "starts": { "type": "string" },
                "ends": { "type": ["string", "null"] },
                "place_id": { "type": ["string", "null"] },
                "notes": { "type": ["string", "null"] },
                "people": { "type": "array", "maxItems": 100,
                            "items": { "type": "string", "minLength": 1 } },
                "expected_rev": { "type": "integer", "minimum": 0 }
              }
            }"#,
            Idempotency::Idempotent,
            &[
                entity::STALE_GUARD[0],
                entity::STALE_GUARD[1],
                CommandCondition {
                    predicate: "touch_can_be_edited",
                    check: pre_edit,
                },
            ],
            edit,
        ),
    ]
}
