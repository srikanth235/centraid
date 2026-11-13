//! Keeping a state the member held but never saved (#1185).
//!
//! The commit door writes a version only when a commit replaces a state. A save the vault
//! refused as stale replaces nothing, yet the words behind it are the member's: this keeps them
//! as an earlier version, beside the state the record holds now, so the screen can show the
//! record as the vault has it and the member can still bring their words back with Restore.

use rusqlite::Connection;
use serde_json::{Map, Value as Json};

use super::shape::{CONTENT, is_sealed};
use super::{current_state, head, keep};
use crate::canonical::canonical_json;
use crate::error::Result;

/// What [`keep_overlay`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kept {
    /// The version was written, at this `seq`.
    Version(i64),
    /// The words were the ones the record holds: there is nothing earlier to keep.
    Same,
}

/// The overlay's field for an event's guests: the people it holds, by id. Not a column: a guest is
/// a row of its own (`attendee`), so the list stands for them all; a guest already held keeps their
/// answer, one added is invited and has not answered.
pub const GUESTS: &str = "attendee";

/// The overlay's field for an event's alerts: the minutes before it starts, each once. Not a column:
/// an alert is a row of its own (`reminder`), so the list stands for them all.
pub const ALERTS: &str = "reminder";

/// The overlay's field for what one day of a series changes: the `occurrence` row the day would
/// hold (`original_start`, `scope` and its own columns), put over the day's row if it has one. A
/// day's times, place and words are no field of the event, so the row stands for them all.
pub const DAY: &str = "occurrence";

/// Why a field cannot be kept, or `None` when it can: it must be a `table.column` the entity's
/// state holds (its title, its kind row), not a sealed cell and not the bytes of a document.
fn refusal(state: &Json, name: &str, value: &Json) -> Option<String> {
    if name == GUESTS {
        let held = state.get(GUESTS).is_some_and(Json::is_array);
        let people = value
            .as_array()
            .is_some_and(|people| people.iter().all(Json::is_string));
        return (!(held && people)).then(|| format!("`{name}` is a list of the people it holds"));
    }
    if name == ALERTS {
        let held = state.get(ALERTS).is_some_and(Json::is_array);
        let minutes = value
            .as_array()
            .is_some_and(|list| list.iter().all(|m| m.as_i64().is_some_and(|m| m >= 0)));
        return (!(held && minutes))
            .then(|| format!("`{name}` is a list of minutes before it starts"));
    }
    if name == DAY {
        let held = state.get(DAY).is_some_and(Json::is_array);
        let day = value.as_object().is_some_and(|row| {
            ["original_start", "scope"]
                .iter()
                .all(|key| row.get(*key).is_some_and(Json::is_string))
        });
        return (!(held && day)).then(|| format!("`{name}` is one day of a series it holds"));
    }
    let Some((table, column)) = name.split_once('.') else {
        return Some(format!("`{name}` is not a field of a record"));
    };
    if is_sealed(table, column)
        || CONTENT
            .iter()
            .any(|(t, c, _)| (*t, *c) == (table, column) && *c != "body")
    {
        return Some(format!("`{name}` is not kept this way"));
    }
    let held = state
        .get(table)
        .and_then(Json::as_object)
        .is_some_and(|row| row.contains_key(column));
    (!held).then(|| format!("`{name}` is not a field this record keeps"))
}

/// The first reason an overlay cannot be kept on `id`, or `None`.
///
/// # Errors
/// A database error.
pub fn overlay_refusal(
    connection: &Connection,
    id: &str,
    overlay: &Map<String, Json>,
) -> Result<Option<String>> {
    let Some(state) = current_state(connection, id)? else {
        return Ok(Some(format!("there is nothing with the id `{id}`")));
    };
    Ok(overlay
        .iter()
        .find_map(|(name, value)| refusal(&state, name, value)))
}

/// Keep the record as the member had it: the state it holds now with `overlay`'s fields
/// (`table.column` to value) put over it, written as the newest earlier version. The record
/// itself is not changed. The overlay must have passed [`overlay_refusal`].
///
/// # Errors
/// A database error.
pub fn keep_overlay(
    connection: &Connection,
    id: &str,
    overlay: &Map<String, Json>,
    now: &str,
    cause: &str,
) -> Result<Kept> {
    let Some(now_state) = current_state(connection, id)? else {
        return Ok(Kept::Same);
    };
    let mut held = now_state.clone();
    for (name, value) in overlay {
        if name == GUESTS {
            put_guests(&mut held, value, now);
        } else if name == ALERTS {
            put_alerts(&mut held, value);
        } else if name == DAY {
            put_day(&mut held, value);
        } else if let Some((table, column)) = name.split_once('.')
            && let Some(row) = held.get_mut(table).and_then(Json::as_object_mut)
        {
            row.insert(column.to_owned(), value.clone());
        }
    }
    if held == now_state {
        return Ok(Kept::Same);
    }
    keep(
        connection,
        id,
        &canonical_json(&held)?,
        &canonical_json(&now_state)?,
        now,
        cause,
    )?;
    Ok(Kept::Version(head(connection, id)?))
}

/// Put `people` (ids) over the guests `held` has: the rows of those already held stay as they are,
/// the others are new invitations, in the order the state keeps them (by person).
fn put_guests(held: &mut Json, people: &Json, now: &str) {
    let wanted: std::collections::BTreeSet<&str> = people
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .collect();
    let Some(rows) = held.get_mut(GUESTS).and_then(Json::as_array_mut) else {
        return;
    };
    rows.retain(|row| {
        row.get("to_id")
            .and_then(Json::as_str)
            .is_some_and(|person| wanted.contains(person))
    });
    for person in wanted {
        if !rows
            .iter()
            .any(|row| row.get("to_id").and_then(Json::as_str) == Some(person))
        {
            rows.push(serde_json::json!({
                "anchor": null, "created_at": now, "label_id": null, "position": null,
                "rel": "attendee", "state": "needs-action", "to_id": person,
            }));
        }
    }
    rows.sort_by(|a, b| {
        a.get("to_id")
            .and_then(Json::as_str)
            .cmp(&b.get("to_id").and_then(Json::as_str))
    });
}

/// Put `minutes` over the alerts `held` has, each once, smallest first (the order the state keeps).
fn put_alerts(held: &mut Json, minutes: &Json) {
    let wanted: std::collections::BTreeSet<i64> = minutes
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Json::as_i64)
        .collect();
    if let Some(rows) = held.get_mut(ALERTS).and_then(Json::as_array_mut) {
        *rows = wanted
            .into_iter()
            .map(|minutes| serde_json::json!({ "offset_min": minutes }))
            .collect();
    }
}

/// Put `day` (an `occurrence` row) over the day's row in `held`, or among them when the day has
/// none, in the order the state keeps them (by day, then scope).
fn put_day(held: &mut Json, day: &Json) {
    let key = |row: &Json| {
        ["original_start", "scope"]
            .map(|name| row.get(name).and_then(Json::as_str).map(str::to_owned))
    };
    let Some(rows) = held.get_mut(DAY).and_then(Json::as_array_mut) else {
        return;
    };
    rows.retain(|row| key(row) != key(day));
    rows.push(day.clone());
    rows.sort_by_key(key);
}
