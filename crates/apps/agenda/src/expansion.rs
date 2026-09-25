//! THE RECURRENCE FOLD — one row per occurrence, and the series' own identity
//! on every one of them (#1020, D-1020-S1, D-1020-S3, D-1020-S4).
//!
//! `queries/upcoming.ts:241`-`:345`. There is **no expander here**: this module
//! calls [`centraid_vault::time::recurrence`], the one engine, and its whole
//! job is the fold around it. A second expander in an app crate is drift
//! ONT-25 with a different name.
//!
//! Four things the fold has to keep, and each has a failure with a history:
//!
//! 1. **An instance carries the SERIES' real `event_id`.** Reschedule, cancel,
//!    RSVP and attach all target the series; a minted per-occurrence id would
//!    make every one of those gestures miss.
//! 2. **`instance_key` and `original_start_local` are the WALL CLOCK.**
//!    `originalStart` is the resolved instant for a zoned series, and keying on
//!    it is what made a stored skip match nothing on three surfaces at once
//!    (#996 R21).
//! 3. **An unsupported rule keeps the anchor.** A free-text RRULE mistake must
//!    not erase the event from the agenda, so a series that expands to nothing
//!    is drawn at its own `dtstart` — visible, once, and not repeating.
//! 4. **[`MAX_TOTAL_INSTANCES`] is enforced DURING the expansion**, across all
//!    series, and it **errors at the size it reaches** rather than returning
//!    what it had (D-1020-D3-12). v0 returns the partial list, which is the
//!    truncation flag again: a short agenda that reads as a whole one.

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_vault::time::occurrence::{self, SeriesType, StoredExceptionRow};
use centraid_vault::time::recurrence::{
    self, ExpandInput, Occurrence, Semantics, parse_instant_ms, shift_temporal,
};
use centraid_vault::time::rrule;
use centraid_vault::time::zone::FireZone;
use serde_json::Value;

use crate::queries::{Attendee, EventRow};

/// Reach back past `from` so still-running multi-day events are not cut off
/// (`upcoming.ts:172`).
pub const SPAN_BUFFER_MS: i64 = 31 * 24 * 60 * 60 * 1000;

/// The ceiling for the open-ended view (no `to`): stops a series expanding a
/// full YEAR per load, nav and doorbell (#404). Month and week views pass their
/// own `to`.
pub const DEFAULT_EXPAND_MS: i64 = 120 * 24 * 60 * 60 * 1000;

/// Across ALL series, per read (`upcoming.ts:185`).
pub const MAX_TOTAL_INSTANCES: usize = 1_500;

/// Per series, per read. v0's `maxInstances: 200` (`upcoming.ts:232`).
pub const MAX_SERIES_INSTANCES: usize = 200;

/// The zone a series with none expands in. **Not a host read**: it is the
/// engine's neutral zone, and a zoned series without a `start_tz` cannot exist
/// — `core_event`'s own CHECK refuses it.
const NEUTRAL_ZONE: &str = "Etc/UTC";

/// The duration a series' occurrences carry, in milliseconds.
///
/// **A floating or all-day series is never read through anybody's zone**: v0
/// parses its wall strings as UTC components so the delta is zone-independent,
/// and so does this.
#[must_use]
pub fn event_duration_ms(event: &EventRow) -> i64 {
    let Some(dtend) = event.dtend.as_deref() else {
        return 0;
    };
    if event.semantics() == Semantics::Zoned {
        let (Some(end), Some(start)) = (parse_instant_ms(dtend), parse_instant_ms(&event.dtstart))
        else {
            return 0;
        };
        return end - start;
    }
    let as_utc = |value: &str| -> Option<i64> {
        let text = if value.contains('T') {
            format!("{value}Z")
        } else {
            format!("{value}T00:00:00Z")
        };
        parse_instant_ms(&text)
    };
    match (as_utc(dtend), as_utc(&event.dtstart)) {
        (Some(end), Some(start)) => end - start,
        _ => 0,
    }
}

/// The anchor occurrence an unsupported rule leaves behind.
fn anchor_of(event: &EventRow) -> Occurrence {
    Occurrence {
        original_start: event.dtstart.clone(),
        start: event.dtstart.clone(),
        wall_start: event.dtstart.clone(),
        overlap: false,
    }
}

/// Expand every recurring row in `rows` into one row per occurrence.
///
/// `range_from` and `range_to` bound the expansion; `exceptions` are the stored
/// `schedule_recurrence_exception` rows for the whole window, read once.
///
/// # Errors
///
/// [`KitError::FanOutExceeded`] when the expansion reaches
/// [`MAX_TOTAL_INSTANCES`]. The bound reports the size it reaches.
pub fn expand_recurring_events(
    rows: Vec<EventRow>,
    range_from: &str,
    range_to: &str,
    exceptions: &[StoredExceptionRow],
) -> KitResult<Vec<EventRow>> {
    let mut out: Vec<EventRow> = Vec::new();
    for event in rows {
        let Some(rule) = event.rrule.clone() else {
            out.push(EventRow {
                is_recurrence_instance: false,
                instance_key: event.event_id.clone(),
                ..event
            });
            continue;
        };
        let duration_ms = event_duration_ms(&event);
        let event_exceptions =
            occurrence::exceptions_of(exceptions, SeriesType::Event, &event.event_id);
        let matcher = occurrence::recurrence_exceptions_of(&event_exceptions);
        let zone = FireZone::named(event.start_tz.as_deref().unwrap_or(NEUTRAL_ZONE)).ok();
        let mut input = ExpandInput::new(&rule, &event.dtstart, range_from, range_to)
            .with_semantics(event.semantics())
            .at_most(MAX_SERIES_INSTANCES);
        input.zone = zone.as_ref();
        let expanded = recurrence::expand(&input);
        // AN UNSUPPORTED RULE KEEPS THE ANCHOR: a free-text RRULE mistake must
        // not erase the event from the agenda.
        let base = if expanded.is_empty() {
            vec![anchor_of(&event)]
        } else {
            expanded
        };
        let instances = recurrence::apply_exceptions(&base, &matcher);
        if instances.is_empty() {
            continue;
        }
        for instance in instances {
            if out.len() >= MAX_TOTAL_INSTANCES {
                return Err(KitError::FanOutExceeded {
                    query: "agenda.upcoming.expansion".to_owned(),
                    cap: MAX_TOTAL_INSTANCES,
                });
            }
            out.push(occurrence_row(
                &event,
                &instance,
                duration_ms,
                &event_exceptions,
            ));
        }
    }
    Ok(out)
}

/// One occurrence, as a row.
fn occurrence_row(
    event: &EventRow,
    instance: &Occurrence,
    duration_ms: i64,
    exceptions: &[occurrence::OccurrenceException],
) -> EventRow {
    // THE OCCURRENCE KEY is the series-local wall clock (#996 R21, ONT-25).
    let key = instance.wall_start.clone();
    let is_anchor = instance.start == event.dtstart;
    let override_value = occurrence::override_at(exceptions, &key);
    let field = |name: &str| -> Option<&Value> { override_value?.get(name) };
    let text =
        |name: &str| -> Option<String> { field(name).and_then(Value::as_str).map(str::to_owned) };
    let dtend = match field("end").and_then(Value::as_str) {
        Some(end) => Some(end.to_owned()),
        None => event
            .dtend
            .as_ref()
            .map(|_| shift_temporal(&instance.start, duration_ms)),
    };
    EventRow {
        summary: text("summary").or_else(|| event.summary.clone()),
        description: text("description").or_else(|| event.description.clone()),
        recurrence_semantics: text("recurrence_semantics")
            .or_else(|| event.recurrence_semantics.clone()),
        calendar_id: text("calendar_id").or_else(|| event.calendar_id.clone()),
        conferencing_uri: text("conferencing_uri").or_else(|| event.conferencing_uri.clone()),
        reminders_json: match field("reminders") {
            Some(reminders) => Some(reminders.to_string()),
            None => event.reminders_json.clone(),
        },
        attendees: match field("attendee_party_ids").and_then(Value::as_array) {
            Some(ids) => ids
                .iter()
                .filter_map(Value::as_str)
                .map(|party_id| overridden_attendee(event, party_id))
                .collect(),
            None => event.attendees.clone(),
        },
        dtstart: instance.start.clone(),
        dtend,
        is_recurrence_instance: !is_anchor,
        instance_key: format!("{}:{key}", event.event_id),
        original_start_local: Some(key),
        recurrence_overlap: Some(instance.overlap),
        ..event.clone()
    }
}

/// An attendee an override names: the one already on the series where there is
/// one, and a bare guest otherwise. **`role` is absent on the fallback**, as it
/// is in v0 — a guest an override introduced has no declared role.
fn overridden_attendee(event: &EventRow, party_id: &str) -> Attendee {
    event
        .attendees
        .iter()
        .find(|guest| guest.party_id == party_id)
        .cloned()
        .unwrap_or_else(|| Attendee {
            attendee_id: Some(party_id.to_owned()),
            party_id: party_id.to_owned(),
            name: "Guest".to_owned(),
            partstat: "needs-action".to_owned(),
            role: None,
            is_you: false,
        })
}

/// THE ONE MEMBER-FACING RECURRENCE SENTENCE, resolved here (#834).
///
/// The row carries the sentence and **never the raw rule**. A second
/// summariser anywhere is the defect `describe` exists to prevent, so this is
/// a call and not a grammar.
#[must_use]
pub fn recurrence_summary(rrule: Option<&str>) -> Option<String> {
    rrule::describe(rrule?)
}
