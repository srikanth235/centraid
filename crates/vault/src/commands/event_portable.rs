//! CALENDAR AS A CALENDAR FILE (#1185): `event.export_ics`, the events of every calendar, of one
//! calendar, or one event (what an event page shares) as one RFC 5545 file. Writes nothing.
//!
//! An event is a VEVENT with its UID, DTSTAMP, times (a date for an all-day event, a wall clock
//! for a floating one, a wall clock in the event's own zone for a zoned one), title, place,
//! notes, link, status, alerts (VALARM) and, for a series, its RRULE with a day the member
//! cancelled as an EXDATE and a day moved or renamed as a VEVENT with the same UID and a
//! RECURRENCE-ID. Not written: guests, the travel allowance, and a change that reaches "this day
//! and every one after it" (a calendar file has no spelling for it short of rewriting the rule).

use rusqlite::Connection;
use serde_json::Value as Json;

use crate::commands::ical::{self, Writer};
use crate::commands::{CommandCtx, CommandDefinition, Idempotency, note};
use crate::error::Result;
use crate::time::recurrence::parse_instant_ms;
use crate::time::rrule;
use crate::time::zone::{FireZone, add_wall_days, parse_wall_iso};

/// One event row, as the export reads it.
struct Event {
    id: String,
    title: String,
    stamp: String,
    starts: String,
    ends: Option<String>,
    timing: String,
    zone: Option<String>,
    rule: Option<String>,
    status: String,
    busy: bool,
    place: Option<String>,
    url: Option<String>,
    reminders: Option<String>,
    description: Option<String>,
}

/// A stored start or end as the property that carries it: `(parameters, value)`.
fn moment(
    timing: &str,
    zone: Option<&str>,
    value: &str,
    end_of_all_day: bool,
) -> Option<(String, String)> {
    match timing {
        "all-day" => {
            let mut wall = parse_wall_iso(value)?;
            if end_of_all_day {
                // The model keeps the LAST day; a calendar file keeps the day after it.
                wall = add_wall_days(wall, 1);
            }
            Some((
                ";VALUE=DATE".to_owned(),
                ical::compact_date(&crate::time::zone::wall_iso(wall, false))?,
            ))
        }
        "floating" => Some((String::new(), ical::compact_wall(parse_wall_iso(value)?))),
        _ => {
            let millis = parse_instant_ms(value)?;
            match zone.and_then(|name| FireZone::named(name).ok()) {
                Some(zone) => Some((
                    format!(";TZID={}", zone.name()),
                    ical::compact_wall(zone.zoned_parts(millis)),
                )),
                None => Some((String::new(), ical::compact_utc_ms(millis))),
            }
        }
    }
}

/// A series-local wall clock key (an `original_start`) as a property: `(parameters, value)`.
fn series_key(timing: &str, zone: Option<&str>, key: &str) -> Option<(String, String)> {
    match timing {
        "all-day" => Some((";VALUE=DATE".to_owned(), ical::compact_date(key)?)),
        "floating" => Some((String::new(), ical::compact_wall(parse_wall_iso(key)?))),
        _ => {
            let wall = ical::compact_wall(parse_wall_iso(key)?);
            Some(match zone {
                Some(name) => (format!(";TZID={name}"), wall),
                None => (String::new(), wall),
            })
        }
    }
}

fn place_text(connection: &Connection, id: &str) -> Option<String> {
    let (title, address): (String, Option<String>) = connection
        .query_row(
            "SELECT e.title, p.address FROM place p JOIN entity e ON e.id = p.id WHERE p.id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    Some(
        match address.filter(|a| !a.trim().is_empty() && *a != title) {
            Some(address) => format!("{title}, {address}"),
            None => title,
        },
    )
}

/// The lines every VEVENT of one event shares, with this day's own times, title and notes.
struct Day<'a> {
    event: &'a Event,
    recurrence_id: Option<(String, String)>,
    timing: &'a str,
    zone: Option<&'a str>,
    starts: &'a str,
    ends: Option<&'a str>,
    title: &'a str,
    description: Option<&'a str>,
    url: Option<&'a str>,
    place: Option<&'a str>,
    series: bool,
}

fn write_day(writer: &mut Writer, exdates: &[(String, String)], day: &Day<'_>) {
    let event = day.event;
    writer.line("BEGIN:VEVENT");
    writer.line(&format!("UID:{}@centraid", event.id));
    writer.line(&format!("DTSTAMP:{}", event.stamp));
    if let Some((params, value)) = &day.recurrence_id {
        writer.line(&format!("RECURRENCE-ID{params}:{value}"));
    }
    if let Some((params, value)) = moment(day.timing, day.zone, day.starts, false) {
        writer.line(&format!("DTSTART{params}:{value}"));
    }
    if let Some((params, value)) = day
        .ends
        .and_then(|ends| moment(day.timing, day.zone, ends, true))
    {
        writer.line(&format!("DTEND{params}:{value}"));
    }
    if day.series
        && let Some(rule) = event.rule.as_deref()
    {
        let line = rrule::rrule_line(rule);
        if !line.is_empty() {
            writer.line(&line);
        }
        for (params, value) in exdates {
            writer.line(&format!("EXDATE{params}:{value}"));
        }
    }
    writer.text("SUMMARY", day.title);
    if let Some(place) = day.place {
        writer.text("LOCATION", place);
    }
    if let Some(notes) = day.description.filter(|d| !d.is_empty()) {
        writer.text("DESCRIPTION", notes);
    }
    if let Some(url) = day.url.filter(|u| !u.trim().is_empty()) {
        writer.line(&format!("URL:{url}"));
    }
    writer.line(&format!(
        "STATUS:{}",
        match event.status.as_str() {
            "tentative" => "TENTATIVE",
            "cancelled" => "CANCELLED",
            _ => "CONFIRMED",
        }
    ));
    writer.line(if event.busy {
        "TRANSP:OPAQUE"
    } else {
        "TRANSP:TRANSPARENT"
    });
    if let Some(Json::Array(alerts)) = event
        .reminders
        .as_deref()
        .and_then(|text| serde_json::from_str::<Json>(text).ok())
    {
        for minutes in alerts.iter().filter_map(Json::as_i64) {
            writer.line("BEGIN:VALARM");
            writer.line("ACTION:DISPLAY");
            writer.text("DESCRIPTION", day.title);
            writer.line(&if minutes == 0 {
                "TRIGGER:PT0S".to_owned()
            } else {
                format!("TRIGGER:-PT{minutes}M")
            });
            writer.line("END:VALARM");
        }
    }
    writer.line("END:VEVENT");
}

fn events(
    connection: &Connection,
    calendar: Option<&str>,
    one: Option<&str>,
) -> Result<Vec<Event>> {
    let mut statement = connection.prepare_cached(
        "SELECT e.id, e.title, e.updated_at, v.starts, v.ends, v.timing, v.zone, v.rule, v.status,
                v.busy, v.place_id, v.url, v.reminders, v.description
           FROM event v JOIN entity e ON e.id = v.id
          WHERE e.kind = 'event' AND e.deleted_at IS NULL
            AND (?1 IS NULL OR v.calendar_id = ?1)
            AND (?2 IS NULL OR e.id = ?2)
          ORDER BY v.starts, e.created_at, e.id",
    )?;
    let rows = statement
        .query_map(rusqlite::params![calendar, one], |row| {
            Ok((
                Event {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    stamp: row.get(2)?,
                    starts: row.get(3)?,
                    ends: row.get(4)?,
                    timing: row.get(5)?,
                    zone: row.get(6)?,
                    rule: row.get(7)?,
                    status: row.get(8)?,
                    busy: row.get::<_, i64>(9)? != 0,
                    place: None,
                    url: row.get(11)?,
                    reminders: row.get(12)?,
                    description: row.get(13)?,
                },
                row.get::<_, Option<String>>(10)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .map(|(mut event, place)| {
            event.place = place.and_then(|id| place_text(connection, &id));
            event.stamp =
                ical::compact_utc(&event.stamp).unwrap_or_else(|| "19700101T000000Z".to_owned());
            event
        })
        .collect())
}

/// One override row of a series: a day moved, renamed or cancelled.
struct Occurrence {
    original_start: String,
    cancelled: bool,
    starts: Option<String>,
    ends: Option<String>,
    timing: Option<String>,
    zone: Option<String>,
    title: Option<String>,
    description: Option<String>,
    url: Option<String>,
    place: Option<String>,
}

fn occurrences(connection: &Connection, series: &str) -> Result<Vec<Occurrence>> {
    let mut statement = connection.prepare_cached(
        "SELECT original_start, cancelled, starts, ends, timing, zone, title, description, url, place_id
           FROM occurrence WHERE series_id = ?1 AND scope = 'occurrence'
          ORDER BY original_start",
    )?;
    let rows = statement
        .query_map([series], |row| {
            Ok((
                Occurrence {
                    original_start: row.get(0)?,
                    cancelled: row.get::<_, i64>(1)? != 0,
                    starts: row.get(2)?,
                    ends: row.get(3)?,
                    timing: row.get(4)?,
                    zone: row.get(5)?,
                    title: row.get(6)?,
                    description: row.get(7)?,
                    url: row.get(8)?,
                    place: None,
                },
                row.get::<_, Option<String>>(9)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .map(|(mut day, place)| {
            day.place = place.and_then(|id| place_text(connection, &id));
            day
        })
        .collect())
}

/// The file's text for these events.
fn file(connection: &Connection, events: &[Event]) -> Result<String> {
    let mut writer = Writer::calendar();
    for event in events {
        let days = if event.rule.is_some() {
            occurrences(connection, &event.id)?
        } else {
            Vec::new()
        };
        let zone = event.zone.as_deref();
        let exdates: Vec<(String, String)> = days
            .iter()
            .filter(|day| day.cancelled)
            .filter_map(|day| series_key(&event.timing, zone, &day.original_start))
            .collect();
        write_day(
            &mut writer,
            &exdates,
            &Day {
                event,
                recurrence_id: None,
                timing: &event.timing,
                zone,
                starts: &event.starts,
                ends: event.ends.as_deref(),
                title: &event.title,
                description: event.description.as_deref(),
                url: event.url.as_deref(),
                place: event.place.as_deref(),
                series: true,
            },
        );
        for day in days.iter().filter(|day| !day.cancelled) {
            let changed = day.starts.is_some()
                || day.title.is_some()
                || day.description.is_some()
                || day.url.is_some()
                || day.place.is_some();
            let Some(recurrence_id) = series_key(&event.timing, zone, &day.original_start) else {
                continue;
            };
            if !changed {
                continue;
            }
            let timing = day.timing.as_deref().unwrap_or(&event.timing);
            let day_zone = if day.timing.is_some() {
                day.zone.as_deref()
            } else {
                zone
            };
            write_day(
                &mut writer,
                &[],
                &Day {
                    event,
                    recurrence_id: Some(recurrence_id),
                    timing,
                    zone: day_zone,
                    starts: day.starts.as_deref().unwrap_or(&day.original_start),
                    ends: day.ends.as_deref().or_else(|| {
                        day.starts
                            .is_none()
                            .then_some(event.ends.as_deref())
                            .flatten()
                    }),
                    title: day.title.as_deref().unwrap_or(&event.title),
                    description: day.description.as_deref().or(event.description.as_deref()),
                    url: day.url.as_deref().or(event.url.as_deref()),
                    place: day.place.as_deref().or(event.place.as_deref()),
                    series: false,
                },
            );
        }
    }
    Ok(writer.finish())
}

/// `event.export_ics`: every calendar's events, one calendar's (`calendar_id`), or one event
/// (`event_id`, what an event page shares) as a calendar file. Writes nothing. Trashed events
/// are not in it.
fn export_ics(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let calendar = ctx.optional_str("calendar_id");
    let one = ctx.optional_str("event_id");
    let mut file_name = "Calendar".to_owned();
    if let Some(id) = one.or(calendar) {
        let title: Option<String> = ctx
            .connection()
            .query_row("SELECT title FROM entity WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .ok();
        file_name = title.map_or_else(|| "Calendar".to_owned(), |t| note::portable_stem(&t));
    }
    let rows = events(ctx.connection(), calendar, one)?;
    let text = file(ctx.connection(), &rows)?;
    Ok(serde_json::json!({
        "name": format!("{file_name}.ics"),
        "media_type": "text/calendar",
        "count": rows.len(),
        "content": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, text),
    }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![CommandDefinition::plain(
        "event.export_ics",
        "event",
        r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "calendar_id": { "type": ["string", "null"] },
            "event_id": { "type": ["string", "null"] }
          }
        }"#,
        Idempotency::Idempotent,
        &[],
        export_ics,
    )]
}
