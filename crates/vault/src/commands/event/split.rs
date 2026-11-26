//! "This and following" (L4): the series splits the RFC 5545 way.
//!
//! The old series' `rule` ends at the day before the split (an `UNTIL` on the last occurrence it
//! keeps, replacing a `COUNT`), and a NEW event starts at the split day with whatever the member
//! changed, a change of timing included. The two halves keep no link: they are two events.
//!
//! What the new half carries over from the old one: its calendar, its words, its guests with their
//! answers, its alerts, its tags and attachments; what the command states replaces it. A `COUNT`
//! is shared out (the new half repeats what the old one had left). The one-day overrides from the
//! split day on move to the new half when the change leaves the days where they were, and are
//! dropped when it moves them (a skipped day that no day of the new series lands on would come
//! back as a plain one). Splitting at the very first day is no split: it is the edit of the whole
//! series.

use serde_json::{Value as Json, json};

use crate::error::{Result, VaultError};
use crate::time::recurrence::{Occurrence, Semantics};
use crate::time::rrule;

use super::commands::{EditInput, apply_edit};
use super::guests;
use super::times::{
    Times, day_start, expand_series, moved_end, occurrence_at, resolve_times, row_of,
};
use super::{NewEvent, found, reminders_held};

/// What the old half has that the new one starts from.
struct Old {
    title: String,
    calendar: String,
    description: Option<String>,
    location: Option<String>,
    place_id: Option<String>,
    url: Option<String>,
    travel_min: Option<i64>,
    status: String,
    busy: bool,
}

fn old_of(connection: &rusqlite::Connection, id: &str) -> Result<Old> {
    Ok(connection.query_row(
        "SELECT e.title, e.parent_id, v.description, v.location, v.place_id, v.url, v.travel_min,
                v.status, v.busy
           FROM event v JOIN entity e ON e.id = v.id WHERE v.id = ?1",
        [id],
        |row| {
            Ok(Old {
                title: row.get(0)?,
                calendar: row.get(1)?,
                description: row.get(2)?,
                location: row.get(3)?,
                place_id: row.get(4)?,
                url: row.get(5)?,
                travel_min: row.get(6)?,
                status: row.get(7)?,
                busy: row.get(8)?,
            })
        },
    )?)
}

/// A rule's `UNTIL` for the last occurrence the old half keeps, in the spelling its timing reads:
/// a day for an all-day series, a wall clock for a floating one, an instant for a zoned one.
fn until_of(timing: Semantics, last: &Occurrence) -> String {
    let digits = |text: &str| -> String {
        text.chars()
            .take_while(|c| *c != '.' && *c != 'Z')
            .filter(char::is_ascii_alphanumeric)
            .collect()
    };
    match timing {
        Semantics::AllDay => digits(last.wall_start.get(..10).unwrap_or(&last.wall_start)),
        Semantics::Floating => {
            let wall = digits(&last.wall_start);
            if wall.len() == 13 {
                format!("{wall}00")
            } else {
                wall
            }
        }
        Semantics::Zoned => format!("{}Z", digits(&last.start)),
    }
}

fn invalid(name: &str, detail: &str) -> VaultError {
    VaultError::InvalidInput {
        name: name.to_owned(),
        detail: detail.to_owned(),
    }
}

/// Split the series at `original_start`; the answer names the event that now starts there.
pub(super) fn split(ctx: &crate::commands::CommandCtx<'_, '_>, input: &EditInput) -> Result<Json> {
    let connection = ctx.connection();
    let id = input.id.as_str();
    let key = input
        .original_start
        .as_deref()
        .ok_or_else(|| invalid("original_start", "a split names the day it begins at"))?;
    let row = row_of(connection, id)?;
    let rule = row
        .rule
        .clone()
        .ok_or_else(|| invalid("id", "a precondition said this event repeats"))?;
    let day = occurrence_at(&row.times, &rule, key).ok_or_else(|| {
        invalid(
            "original_start",
            "a precondition said the series lands there",
        )
    })?;
    let kept = expand_series(&row.times, &rule, &row.times.starts, &day.start, 10_000);
    let Some(last) = kept.last() else {
        // The first day: the whole series is what changes.
        apply_edit(ctx, input)?;
        return Ok(json!({ "id": id, "split": false }));
    };
    let old = old_of(connection, id)?;
    let parsed =
        rrule::inspect(&rule).map_err(|_| invalid("rule", "a precondition said it reads"))?;

    // The new half's times: from the split day, the length the series had, then what is stated.
    let split_starts = day_start(row.times.timing, &day);
    let base = Times {
        starts: split_starts.clone(),
        ends: row
            .times
            .ends
            .as_deref()
            .map(|ends| moved_end(row.times.timing, &row.times.starts, ends, &split_starts)),
        timing: row.times.timing,
        zone: row.times.zone.clone(),
    };
    let after = resolve_times(
        ctx.input.as_object().unwrap_or(&serde_json::Map::new()),
        Some(&base),
    )
    .map_err(|sentence| invalid("starts", &sentence))?;

    // The new half's rule: the one stated, else the old one less what the old half keeps.
    let new_rule = match &input.rule {
        Some(rule) => rule.as_deref().map(rrule::canonicalize),
        None => {
            let mut next = parsed.clone();
            if let Some(count) = next.count {
                next.count = Some((count - i64::try_from(kept.len()).unwrap_or(0)).max(1));
            }
            Some(next.to_canonical())
        }
    };

    // The old half ends the day before.
    let mut ended = parsed;
    ended.count = None;
    ended.until = Some(until_of(row.times.timing, last));
    connection.execute(
        "UPDATE event SET rule = ?2 WHERE id = ?1",
        rusqlite::params![id, ended.to_canonical()],
    )?;
    ctx.touch(id)?;

    let leads: Vec<i64> = match &input.reminders {
        Some(leads) => leads.clone().unwrap_or_default(),
        None => reminders_held(connection, id)?,
    };
    let text = |patch: &Option<Option<String>>, was: &Option<String>| match patch {
        Some(value) => value.clone(),
        None => was.clone(),
    };
    let (description, location, place_id, url) = (
        text(&input.description, &old.description),
        text(&input.location, &old.location).map(|words| words.trim().to_owned()),
        text(&input.place_id, &old.place_id),
        text(&input.url, &old.url),
    );
    let travel_min = match input.travel_min {
        Some(minutes) => minutes,
        None => old.travel_min,
    };
    let title = input.title.as_deref().map_or(old.title.as_str(), str::trim);
    let new_id = found(
        ctx,
        &NewEvent {
            id: None,
            title,
            starts: &after.starts,
            ends: after.ends.as_deref(),
            timing: after.timing,
            zone: after.zone.as_deref(),
            rule: new_rule.as_deref(),
            calendar_id: Some(&old.calendar),
            reminders: &leads,
            description: description.as_deref(),
            location: location.as_deref(),
            place_id: place_id.as_deref(),
            url: url.as_deref(),
            travel_min,
            status: Some(input.status.as_deref().unwrap_or(&old.status)),
            busy: Some(input.busy.unwrap_or(old.busy)),
        },
    )?;

    // Guests: the list stated, else the old half's, answers and all.
    match &input.guests {
        Some(list) => {
            guests::set_guests(ctx, &new_id, list.as_deref().unwrap_or_default())?;
        }
        None => {
            for guest in guests::guests_of(connection, id)? {
                connection.execute(
                    "INSERT INTO event_guest (id, event_id, address, person_id, name, role, status, organizer)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    rusqlite::params![
                        ctx.next_id(),
                        new_id,
                        guest.address,
                        guest.person_id,
                        guest.name,
                        guest.role,
                        guest.status,
                        guest.organizer,
                    ],
                )?;
            }
        }
    }
    // What is hung on the event, not part of its time: its tags and attachments.
    connection.execute(
        "INSERT INTO edge (from_id, rel, to_id, label_id, position, anchor, created_at)
         SELECT ?2, rel, to_id, label_id, position, anchor, ?3 FROM edge
          WHERE from_id = ?1 AND rel IN ('tagged', 'attached')",
        rusqlite::params![id, new_id, ctx.now],
    )?;
    // One-day overrides from the split day on go with the days when they are still the days.
    if input.states_when(ctx) {
        connection.execute(
            "DELETE FROM occurrence WHERE series_id = ?1 AND original_start >= ?2",
            [id, key],
        )?;
    } else {
        connection.execute(
            "UPDATE occurrence SET series_id = ?2 WHERE series_id = ?1 AND original_start >= ?3",
            [id, new_id.as_str(), key],
        )?;
    }
    ctx.touch(&new_id)?;
    Ok(json!({ "id": id, "split": true, "new_id": new_id }))
}
