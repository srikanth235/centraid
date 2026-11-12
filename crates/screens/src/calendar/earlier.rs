//! CALENDAR'S EARLIER VERSIONS: the kit's one earlier-versions screen with Calendar's spec (#1185).
//!
//! An event keeps its title, when it starts and ends (in its own zone, worded as the event page
//! words a time), its place, joining link, repeat, reminders, travel time, availability, notes,
//! calendar and its guests. A version's line is the ones it held, as the page words them: `Design
//! sync · Wed 4 November, 14:00 · Indiranagar office`. A guest is named as the page names one (the
//! names are read with the list, from the people the vault lists; a guest the page no longer knows
//! reads as the page words an unnamed one), with their reply. What the page does not show (status, the time's timing, an
//! occurrence's own overrides) has no words; a version that changed only those reads "Other
//! details".

use centraid_api_proto::core_v1 as wire;
use serde_json::Value;
use wire::app_query_response::Answer;

use super::event::{denied, reminder_label, reply_label, travel_label, zone_title};
use super::event_phone::{Wording, brief, moment};
use crate::catalog::load;
use crate::kit::earlier::{self, EarlierSpec, Field, Look, Names};
use crate::kit::read::{self, Reading};
use crate::kit::schedule::rule_words;
use crate::screen::{Ctx, Screen};
use crate::strings::agenda_event as event_words;
use crate::strings::{agenda as words, agenda_editor as editor_words, fill, shared};

/// Calendar's earlier versions, as the kit's screen takes it.
pub static SPEC: EarlierSpec = EarlierSpec {
    app: "calendar",
    noun: shared::trash_noun_event,
    denied,
    parts,
    know: Some(know),
    gate: None,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    earlier::build(&SPEC, route)
}

/// The names the page gives what a version names by id: its guests, its place and its calendar,
/// as the event is now and everyone the vault lists.
fn know(ctx: &Ctx, event_id: &str) -> Names {
    let reading = read::read(
        ctx,
        load::calendar::Event {
            event_id: event_id.to_owned(),
            instance_key: None,
            original_start_local: None,
        },
        |answer| match answer {
            Answer::AgendaEvent(detail) => Some(detail),
            _ => None,
        },
    );
    let mut names = Names::new();
    // Everyone the vault lists, so a guest taken off since is still named.
    if let Reading::Data(parties) =
        read::read(
            ctx,
            load::calendar::Parties::default(),
            |answer| match answer {
                Answer::AgendaParties(parties) => Some(parties),
                _ => None,
            },
        )
    {
        for party in &parties.parties {
            names.insert(party.party_id.clone(), party.name.clone());
        }
    }
    let Reading::Data(detail) = reading else {
        return names;
    };
    let Some(event) = detail.event.as_ref() else {
        return names;
    };
    for guest in &event.attendees {
        names.insert(guest.party_id.clone(), guest.name.clone());
    }
    // The zone the event keeps its wall clock in, for a time whose zone did not change with it.
    if let Some(zone) = event
        .start_tz
        .as_deref()
        .filter(|_| event.recurrence_semantics.as_deref() == Some("zoned"))
    {
        names.insert(OWN_ZONE.to_owned(), zone.to_owned());
    }
    if let (Some(id), Some(name)) = (&event.location_place_id, &event.location_name) {
        names.insert(id.clone(), name.clone());
    }
    if let (Some(id), Some(name)) = (
        &event.calendar_id,
        detail
            .calendar
            .as_ref()
            .and_then(|calendar| calendar.name.as_ref()),
    ) {
        names.insert(id.clone(), name.clone());
    }
    names
}

/// The key of the event's own zone among [`Names`], which no id can be.
const OWN_ZONE: &str = "event.zone";

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The id a child field names: `attendee[<person>]` and `attendee[<person>].partstat`.
fn guest(field: &Field) -> Option<(&str, Option<&str>)> {
    let rest = field.name.strip_prefix("attendee[")?;
    let (id, column) = rest.split_once(']')?;
    Some((id, column.strip_prefix('.')))
}

/// The reminders' leads in minutes, whether stored as numbers or as `{minutes_before}` objects.
fn leads(value: &Value) -> Vec<i64> {
    let list: Value = match value {
        Value::String(raw) => serde_json::from_str(raw).unwrap_or(Value::Null),
        other => other.clone(),
    };
    list.as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.as_i64()
                        .or_else(|| item.get("minutes_before").and_then(Value::as_i64))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The one line an event's fields read as.
fn parts(look: &Look, fields: &[Field]) -> Vec<String> {
    let locale = look.locale;
    let named = |name: &str| fields.iter().find(|field| field.name == name);
    let own = |name: &str| named(name).and_then(|field| text(&field.value));
    let zone = own("event.zone").or_else(|| look.names.get(OWN_ZONE).cloned());
    let wording = Wording {
        locale,
        cycle: look.cycle,
        device_zone: look.zone,
        event_zone: zone.as_deref(),
    };
    let time = |name: &str| own(name).and_then(|value| moment(wording, zone.as_deref(), &value));
    let when = match (time("event.starts"), time("event.ends")) {
        // The end shares the start's day, and its zone, more often than not: say each once.
        (Some(start), Some(end)) => {
            let zoned = zone
                .as_deref()
                .filter(|zone| *zone != look.zone)
                .map(|zone| format!(", {}", zone_title(locale, zone)));
            let start = zoned
                .as_deref()
                .and_then(|tail| start.strip_suffix(tail))
                .map_or_else(|| start.clone(), str::to_owned);
            let shared = start
                .split_once(", ")
                .map(|(day, _)| format!("{day}, "))
                .and_then(|day| end.strip_prefix(&day).map(str::to_owned));
            Some(format!("{start} – {}", shared.unwrap_or(end)))
        }
        (Some(start), None) => Some(start),
        (None, Some(end)) => Some(fill(&event_words::says_ends(locale), &[("when", &end)])),
        (None, None) => None,
    };
    let mut parts = vec![own("entity.title"), when];
    // A zone changed on its own, with no time beside it to carry it.
    if let Some(zone) = own("event.zone")
        .filter(|zone| zone != look.zone && time("event.starts").or(time("event.ends")).is_none())
    {
        parts.push(Some(zone_title(locale, &zone)));
    }
    parts.push(
        own("event.place_id")
            .and_then(|id| look.names.get(&id).cloned())
            .filter(|name| !name.trim().is_empty()),
    );
    parts.push(own("event.url"));
    parts.push(own("event.rule").map(|rule| rule_words::stored(locale, &rule)));
    parts.push(
        named("event.reminders")
            .map(|field| leads(&field.value))
            .filter(|l| !l.is_empty())
            .map(|leads| {
                leads
                    .iter()
                    .map(|minutes| reminder_label(locale, *minutes))
                    .collect::<Vec<_>>()
                    .join(", ")
            }),
    );
    parts.push(
        named("event.travel_min")
            .and_then(|field| field.value.as_i64())
            .filter(|minutes| *minutes > 0)
            .map(|minutes| travel_label(locale, minutes)),
    );
    parts.push(
        named("event.busy")
            .filter(|field| field.value == Value::Bool(false) || field.value.as_i64() == Some(0))
            .map(|_| editor_words::free(locale)),
    );
    parts.push(own("event.description").map(|notes| brief(&notes)));
    parts.push(
        own("event.calendar_id")
            .and_then(|id| look.names.get(&id).cloned())
            .filter(|name| !name.trim().is_empty()),
    );
    for field in fields {
        let Some((id, column)) = guest(field) else {
            continue;
        };
        // A guest is held when the row is; a column alone names the reply of one that was.
        let reply = match (column, &field.value) {
            (None, Value::Object(row)) => row.get("partstat").and_then(Value::as_str),
            (Some("partstat"), Value::String(state)) => Some(state.as_str()),
            (None, Value::Null) | (Some(_), Value::Null) => continue,
            _ => None,
        };
        if column.is_some() && reply.is_none() {
            continue;
        }
        let name = look
            .names
            .get(id)
            .map(|name| name.trim())
            .filter(|name| !name.is_empty())
            .map_or_else(|| words::calendar_unnamed(locale), str::to_owned);
        parts.push(Some(match reply {
            Some(state) => fill(
                &event_words::guest_spoken(locale),
                &[("name", &name), ("reply", &reply_label(locale, state))],
            ),
            None => name,
        }));
    }
    parts.into_iter().flatten().collect()
}
