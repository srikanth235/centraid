//! A person's contact points: a phone, an email, an address, a link, a handle.
//!
//! A point is a row of the person it reaches (it cascades with them), not an
//! entity: it has no trash, no edges and no title of its own. `normalized` is
//! the one key two spellings of the same number share, so a point is never
//! stored twice for a person and a read can say who else holds it. A person
//! holds at most one **preferred** point of a kind, and the index says so.
//!
//! The follower of the phone's contacts keeps a person's points in step through
//! the same rows: [`read`] and [`merge`] are its `points` field, so a point the
//! member added or took away is not undone by the next read of the address book.
//!
//! What kinds of point there are is the `contact_point_kind` lookup, read when a point is saved;
//! no list of them is kept here. The member adds, edits, prefers and reorders points, and
//! [`people_with`] finds who is reached at a number or an address (what a guest's address, an
//! import and a merge ask).

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde_json::{Value as Json, json};

use crate::commands::person::refusal_unless_live_person;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;

/// The one key two spellings of a point share.
#[must_use]
pub fn reach_key(kind: &str, raw: &str) -> String {
    let value = raw.trim();
    match kind {
        "email" => value.to_lowercase(),
        "phone" => {
            let digits: String = value
                .chars()
                .filter(|c| !matches!(c, ' ' | '(' | ')' | '.' | '-'))
                .collect();
            let plus = if value.starts_with('+') { "+" } else { "" };
            format!("{plus}{}", digits.trim_start_matches('+'))
        }
        "handle" => value.trim_start_matches('@').to_lowercase(),
        // An address and a link: runs of whitespace fold to one space.
        _ => value
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase(),
    }
}

/// The sentence a member reads when a point is not one a person could be reached at.
fn invalid(kind: &str, key: &str) -> Option<&'static str> {
    match kind {
        "email" => {
            let valid = key.find('@').is_some_and(|at| {
                let domain = &key[at + 1..];
                at > 0
                    && domain.contains('.')
                    && !domain.starts_with('.')
                    && !domain.ends_with('.')
                    && !domain.contains('@')
                    && !key.contains(char::is_whitespace)
            }) && key.len() <= 320;
            (!valid).then_some("enter a valid email address")
        }
        "phone" => {
            let digits = key.trim_start_matches('+');
            (!(7..=15).contains(&digits.len()) || !digits.chars().all(|c| c.is_ascii_digit()))
                .then_some("enter a phone number with 7 to 15 digits")
        }
        "handle" => {
            let valid = (2..=100).contains(&key.chars().count())
                && key
                    .chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | ':' | '@' | '/' | '-'));
            (!valid).then_some("enter a valid handle")
        }
        _ => (!(3..=500).contains(&key.len())).then_some("enter a complete address"),
    }
}

// ---------------------------------------------------------------------------
// The follower's `points` field
// ---------------------------------------------------------------------------

/// A person's points as the follower states them, in one canonical order.
pub(crate) fn read(connection: &Connection, person: &str) -> Result<Json> {
    let mut statement = connection.prepare_cached(
        "SELECT kind, value, label FROM contact_point WHERE person_id = ?1
          ORDER BY kind, normalized",
    )?;
    let points = statement
        .query_map([person], |row| {
            Ok(json!({
                "kind": row.get::<_, String>(0)?,
                "value": row.get::<_, String>(1)?,
                "label": row.get::<_, Option<String>>(2)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json::Array(points))
}

/// The points a list says, by the key two spellings share.
fn keyed(points: &Json) -> BTreeMap<(String, String), (String, Option<String>)> {
    points
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|point| {
            let kind = point.get("kind")?.as_str()?;
            let value = point.get("value")?.as_str()?.trim();
            let key = reach_key(kind, value);
            (!key.is_empty()).then(|| {
                (
                    (kind.to_owned(), key),
                    (
                        value.to_owned(),
                        point.get("label").and_then(Json::as_str).map(str::to_owned),
                    ),
                )
            })
        })
        .collect()
}

/// A list of points in one form: one entry per key, in key order, a label only
/// when there is one.
pub(crate) fn canon(points: &Json) -> Json {
    Json::Array(
        keyed(points)
            .into_iter()
            .map(|((kind, _), (value, label))| {
                let mut point = json!({ "kind": kind, "value": value });
                if let Some(label) = label {
                    point["label"] = Json::String(label);
                }
                point
            })
            .collect(),
    )
}

/// Make one point what `wants` says (`None`: not there), given whether the person holds it now.
fn put_point(
    ctx: &CommandCtx<'_, '_>,
    person: &str,
    (kind, normalized): &(String, String),
    held: bool,
    wants: Option<&(String, Option<String>)>,
) -> Result<bool> {
    let connection = ctx.connection();
    Ok(match wants {
        None => {
            connection.execute(
                "DELETE FROM contact_point WHERE person_id = ?1 AND kind = ?2 AND normalized = ?3",
                [person, kind, normalized],
            )? > 0
        }
        Some((value, label)) if held => {
            connection.execute(
                "UPDATE contact_point SET value = ?4, label = ?5
                  WHERE person_id = ?1 AND kind = ?2 AND normalized = ?3",
                rusqlite::params![person, kind, normalized, value, label],
            )? > 0
        }
        Some((value, label)) => {
            connection.execute(
                "INSERT OR IGNORE INTO contact_point (id, person_id, kind, value, normalized, label, position)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                         (SELECT COALESCE(MAX(position), 0) + 1 FROM contact_point WHERE person_id = ?2))",
                rusqlite::params![ctx.next_id(), person, kind, value, normalized, label],
            )? > 0
        }
    })
}

/// Make the points what the source last stated (one point, named by its [`items`] key, or all):
/// a point the member removed comes back, one they relabelled or added is put back to the statement
/// or taken off. Returns whether a row changed.
pub(crate) fn take(
    ctx: &CommandCtx<'_, '_>,
    person: &str,
    item: Option<&str>,
    stated: &Json,
) -> Result<bool> {
    let (said, held) = (keyed(stated), keyed(&read(ctx.connection(), person)?));
    let keys: std::collections::BTreeSet<&(String, String)> =
        said.keys().chain(held.keys()).collect();
    let mut changed = false;
    for key in keys {
        if item.is_some_and(|item| format!("{}:{}", key.0, key.1) != item) {
            continue;
        }
        let (mine, wants) = (held.get(key), said.get(key));
        if mine != wants {
            changed |= put_point(ctx, person, key, mine.is_some(), wants)?;
        }
    }
    Ok(changed)
}

/// The points of a canonical list by the key that names each across statements: its kind and
/// reach key.
pub(crate) fn items(points: &Json) -> BTreeMap<String, Json> {
    points
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|point| {
            let kind = point.get("kind")?.as_str()?;
            let value = point.get("value")?.as_str()?;
            Some((format!("{kind}:{}", reach_key(kind, value)), point.clone()))
        })
        .collect()
}

/// A three-way merge of a person's points, **per item** (the follower's rule, one point at a
/// time): a point is `(kind, key)` and its parts are its spelling and its label. A point the
/// member has not changed (the vault holds what the source last stated of it, or holds nothing
/// where the source stated nothing) takes the source's word now: its new spelling or label, its
/// removal, or its addition. A point the member changed (relabelled, respelled, added, or
/// removed) stands as they left it, and keeps whatever the member set on it (preferred,
/// position). `stated` is what the source said last, `None` when it has not spoken for this
/// person before (then every point the member holds stands, and the source only adds the rest).
/// Returns whether a row changed.
pub(crate) fn merge(
    ctx: &CommandCtx<'_, '_>,
    person: &str,
    stated: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let (was, now) = (stated.map(keyed).unwrap_or_default(), keyed(new));
    let held = keyed(&read(connection, person)?);
    let keys: std::collections::BTreeSet<&(String, String)> =
        was.keys().chain(now.keys()).chain(held.keys()).collect();
    let mut changed = false;
    for key in keys {
        let (mine, said, wants) = (held.get(key), was.get(key), now.get(key));
        // The member changed this point: it stands.
        if mine != said || mine == wants {
            continue;
        }
        changed |= put_point(ctx, person, key, mine.is_some(), wants)?;
    }
    Ok(changed)
}

// ---------------------------------------------------------------------------
// The member's two verbs
// ---------------------------------------------------------------------------

fn pre_save(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let person = ctx.required_str("id")?;
    if let Some(sentence) = refusal_unless_live_person(ctx.connection(), person)? {
        return Ok(Some(sentence));
    }
    let (kind, value) = (ctx.required_str("kind")?, ctx.required_str("value")?);
    let known: bool = ctx.connection().query_row(
        "SELECT EXISTS (SELECT 1 FROM vocab WHERE domain = 'contact_point_kind' AND code = ?1)",
        [kind],
        |row| row.get(0),
    )?;
    if !known {
        return Ok(Some(format!("“{kind}” is not a way to reach someone")));
    }
    let key = reach_key(kind, value);
    if let Some(sentence) = invalid(kind, &key) {
        return Ok(Some(sentence.to_owned()));
    }
    let point = ctx.optional_str("point_id");
    if let Some(point) = point {
        let owner: Option<String> = ctx
            .connection()
            .query_row(
                "SELECT person_id FROM contact_point WHERE id = ?1",
                [point],
                |row| row.get(0),
            )
            .ok();
        match owner {
            None => return Ok(Some("there is no contact point with that id".to_owned())),
            Some(owner) if owner != person => {
                return Ok(Some(
                    "that contact point belongs to another person".to_owned(),
                ));
            }
            Some(_) => {}
        }
    }
    let held: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM contact_point
          WHERE person_id = ?1 AND kind = ?2 AND normalized = ?3 AND id <> ?4",
        rusqlite::params![person, kind, key, point.unwrap_or_default()],
        |row| row.get(0),
    )?;
    Ok((held > 0).then(|| "this contact point is already saved".to_owned()))
}

#[derive(serde::Deserialize)]
struct SaveContactPointInput {
    id: String,
    point_id: Option<String>,
    kind: String,
    value: String,
    label: Option<String>,
    preferred: Option<bool>,
}

fn save(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: SaveContactPointInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let person = input.id.as_str();
    let (kind, value) = (input.kind.as_str(), input.value.trim());
    let key = reach_key(kind, value);
    let label = input.label.as_deref().filter(|l| !l.trim().is_empty());
    // An edit that does not say keeps the point as preferred or not as it was.
    let preferred = input.preferred;
    // An edit names the point it changes (the precondition has seen it is this
    // person's); anything else is a new one.
    let point = input.point_id.as_deref();
    let id = point.map_or_else(|| ctx.next_id(), str::to_owned);
    if preferred == Some(true) {
        connection.execute(
            "UPDATE contact_point SET preferred = 0 WHERE person_id = ?1 AND kind = ?2 AND id <> ?3",
            [person, kind, &id],
        )?;
    }
    if point.is_some() {
        // Another kind than the point had: it is no longer preferred among the first kind's.
        connection.execute(
            "UPDATE contact_point SET preferred = CASE WHEN kind <> ?2 THEN 0 ELSE preferred END
              WHERE id = ?1",
            [id.as_str(), kind],
        )?;
        connection.execute(
            "UPDATE contact_point SET kind = ?2, value = ?3, normalized = ?4, label = ?5,
                    preferred = COALESCE(?6, preferred)
              WHERE id = ?1",
            rusqlite::params![id, kind, value, key, label, preferred.map(i64::from)],
        )?;
    } else {
        connection.execute(
            "INSERT INTO contact_point (id, person_id, kind, value, normalized, label, preferred, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                     (SELECT COALESCE(MAX(position), 0) + 1 FROM contact_point WHERE person_id = ?2))",
            rusqlite::params![id, person, kind, value, key, label, i64::from(preferred.unwrap_or(false))],
        )?;
    }
    ctx.touch(person)?;
    Ok(json!({ "point_id": id }))
}

fn pre_remove(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let held: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM contact_point WHERE id = ?1",
        [ctx.required_str("point_id")?],
        |row| row.get(0),
    )?;
    Ok((held == 0).then(|| "there is no contact point with that id".to_owned()))
}

#[derive(serde::Deserialize)]
struct RemoveContactPointInput {
    point_id: String,
}

fn remove(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: RemoveContactPointInput = ctx.parse_input()?;
    let person: String = ctx.connection().query_row(
        "SELECT person_id FROM contact_point WHERE id = ?1",
        [input.point_id.as_str()],
        |row| row.get(0),
    )?;
    ctx.connection().execute(
        "DELETE FROM contact_point WHERE id = ?1",
        [input.point_id.as_str()],
    )?;
    ctx.touch(&person)?;
    Ok(json!({ "id": person }))
}

/// The people reached at this number, address or handle (spellings folded by [`reach_key`]), the
/// ones in the trash left out, in the order they were made: what a guest's address, an import and
/// a merge ask.
///
/// # Errors
/// SQLite's refusal.
pub fn people_with(connection: &Connection, kind: &str, value: &str) -> Result<Vec<String>> {
    let mut statement = connection.prepare_cached(
        "SELECT c.person_id FROM contact_point c JOIN entity e ON e.id = c.person_id
          WHERE c.kind = ?1 AND c.normalized = ?2 AND e.deleted_at IS NULL
          ORDER BY e.created_at, e.id",
    )?;
    Ok(statement
        .query_map([kind, reach_key(kind, value).as_str()], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// The first person reached at an email address.
///
/// # Errors
/// SQLite's refusal.
pub fn person_of_email(connection: &Connection, address: &str) -> Result<Option<String>> {
    Ok(people_with(connection, "email", address)?
        .into_iter()
        .next())
}

fn pre_prefer(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let owner: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT person_id FROM contact_point WHERE id = ?1",
            [ctx.required_str("point_id")?],
            |row| row.get(0),
        )
        .ok();
    match owner {
        None => Ok(Some("there is no contact point with that id".to_owned())),
        Some(person) => refusal_unless_live_person(ctx.connection(), &person),
    }
}

/// Make this the one preferred point of its kind (or, with `preferred: false`, none).
fn prefer(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let point = ctx.required_str("point_id")?;
    let on = ctx
        .input
        .get("preferred")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let (person, kind): (String, String) = ctx.connection().query_row(
        "SELECT person_id, kind FROM contact_point WHERE id = ?1",
        [point],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if on {
        ctx.connection().execute(
            "UPDATE contact_point SET preferred = 0 WHERE person_id = ?1 AND kind = ?2 AND id <> ?3",
            [&person, &kind, point],
        )?;
    }
    ctx.connection().execute(
        "UPDATE contact_point SET preferred = ?2 WHERE id = ?1",
        rusqlite::params![point, i64::from(on)],
    )?;
    ctx.touch(&person)?;
    Ok(json!({ "id": person, "point_id": point }))
}

fn pre_reorder(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let person = ctx.required_str("id")?;
    if let Some(sentence) = refusal_unless_live_person(ctx.connection(), person)? {
        return Ok(Some(sentence));
    }
    let listed: Vec<&str> = ctx.input["order"]
        .as_array()
        .map(|items| items.iter().filter_map(serde_json::Value::as_str).collect())
        .unwrap_or_default();
    let held: std::collections::BTreeSet<String> = ctx
        .connection()
        .prepare_cached("SELECT id FROM contact_point WHERE person_id = ?1")?
        .query_map([person], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let once: std::collections::BTreeSet<&str> = listed.iter().copied().collect();
    Ok((once.len() != listed.len()
        || once.len() != held.len()
        || !listed.iter().all(|id| held.contains(*id)))
    .then(|| "name each of this person's contact points once".to_owned()))
}

/// Put the points in the member's order.
fn reorder(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let person = ctx.required_str("id")?;
    for (place, id) in ctx.input["order"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .enumerate()
    {
        ctx.connection().execute(
            "UPDATE contact_point SET position = ?2 WHERE id = ?1",
            rusqlite::params![id, place as f64 + 1.0],
        )?;
    }
    ctx.touch(person)?;
    Ok(json!({ "id": person }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition::plain(
            "person.save_contact_point",
            "person",
            r#"{
              "type": "object",
              "required": ["id", "kind", "value"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "point_id": { "type": "string", "minLength": 1 },
                "kind": { "type": "string", "minLength": 1 },
                "value": { "type": "string", "minLength": 1, "maxLength": 500 },
                "label": { "type": ["string", "null"], "maxLength": 100 },
                "preferred": { "type": "boolean" }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "point_is_one_a_person_can_be_reached_at",
                check: pre_save,
            }],
            save,
        ),
        CommandDefinition::plain(
            "person.remove_contact_point",
            "person",
            r#"{
              "type": "object",
              "required": ["point_id"],
              "additionalProperties": false,
              "properties": { "point_id": { "type": "string", "minLength": 1 } }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "point_exists",
                check: pre_remove,
            }],
            remove,
        ),
        CommandDefinition::plain(
            "person.prefer_contact_point",
            "person",
            r#"{
              "type": "object",
              "required": ["point_id"],
              "additionalProperties": false,
              "properties": {
                "point_id": { "type": "string", "minLength": 1 },
                "preferred": { "type": "boolean" }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "point_is_a_live_persons",
                check: pre_prefer,
            }],
            prefer,
        ),
        CommandDefinition::plain(
            "person.reorder_contact_points",
            "person",
            r#"{
              "type": "object",
              "required": ["id", "order"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "order": { "type": "array", "items": { "type": "string", "minLength": 1 } }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "order_names_each_point_once",
                check: pre_reorder,
            }],
            reorder,
        ),
    ]
}
