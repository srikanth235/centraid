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

/// A three-way merge of a person's points: what the source dropped since it last
/// spoke goes, what it added comes, and a point the member added or removed is
/// left as they made it. `stated` is what the source said last, `None` when it
/// has not spoken for this person before (then it only adds). Returns whether a
/// row changed.
pub(crate) fn merge(
    ctx: &CommandCtx<'_, '_>,
    person: &str,
    stated: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let (was, now) = (stated.map(keyed).unwrap_or_default(), keyed(new));
    let mut changed = false;
    for ((kind, key), _) in was.iter().filter(|(key, _)| !now.contains_key(*key)) {
        changed |= connection.execute(
            "DELETE FROM contact_point WHERE person_id = ?1 AND kind = ?2 AND normalized = ?3",
            [person, kind, key],
        )? > 0;
    }
    for ((kind, key), (value, label)) in now.iter().filter(|(key, _)| !was.contains_key(*key)) {
        changed |= connection.execute(
            "INSERT OR IGNORE INTO contact_point (id, person_id, kind, value, normalized, label, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                     (SELECT COALESCE(MAX(position), 0) + 1 FROM contact_point WHERE person_id = ?2))",
            rusqlite::params![ctx.next_id(), person, kind, value, key, label],
        )? > 0;
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

fn save(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let connection = ctx.connection();
    let person = ctx.required_str("id")?;
    let (kind, value) = (ctx.required_str("kind")?, ctx.required_str("value")?.trim());
    let key = reach_key(kind, value);
    let label = ctx.optional_str("label").filter(|l| !l.trim().is_empty());
    let preferred = ctx
        .input
        .get("preferred")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    // An edit names the point it changes (the precondition has seen it is this
    // person's); anything else is a new one.
    let point = ctx.optional_str("point_id");
    let id = point.map_or_else(|| ctx.next_id(), str::to_owned);
    if preferred {
        connection.execute(
            "UPDATE contact_point SET preferred = 0 WHERE person_id = ?1 AND kind = ?2 AND id <> ?3",
            [person, kind, &id],
        )?;
    }
    if point.is_some() {
        connection.execute(
            "UPDATE contact_point SET kind = ?2, value = ?3, normalized = ?4, label = ?5, preferred = ?6
              WHERE id = ?1",
            rusqlite::params![id, kind, value, key, label, i64::from(preferred)],
        )?;
    } else {
        connection.execute(
            "INSERT INTO contact_point (id, person_id, kind, value, normalized, label, preferred, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                     (SELECT COALESCE(MAX(position), 0) + 1 FROM contact_point WHERE person_id = ?2))",
            rusqlite::params![id, person, kind, value, key, label, i64::from(preferred)],
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

fn remove(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let person: String = ctx.connection().query_row(
        "SELECT person_id FROM contact_point WHERE id = ?1",
        [ctx.required_str("point_id")?],
        |row| row.get(0),
    )?;
    ctx.connection().execute(
        "DELETE FROM contact_point WHERE id = ?1",
        [ctx.required_str("point_id")?],
    )?;
    ctx.touch(&person)?;
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
                "kind": { "type": "string", "enum": ["phone", "email", "address", "url", "handle"] },
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
    ]
}
