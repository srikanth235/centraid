//! THE LINES UNDER WHAT THE PHONE SAYS (#1183) on a followed event: the title, the start and the
//! end, the notes, the zone, the repeat, the joining link, availability, the alerts and the guests,
//! each only where the member's value differs from the calendar's, each worded as the page words
//! that field.
//!
//! `timing` has no row of its own (a change of it shows in the time) and a series' `overrides` are
//! judged whole and named nowhere on the page, so neither has a line. A field the calendar states
//! empty (no notes, no repeat, no alert) has none either: there is nothing to quote. A guest the
//! member added has none; one whose reply they changed says what the calendar has, one they took
//! off says the calendar still has them.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::{FireZone, has_zone_designator, parse_civil_ms};
use serde_json::Value;

use crate::calendar::event::{reminder_label, reply_label, zone_title};
use crate::kit::civil::{self, HourCycle};
use crate::kit::follow::{self, Difference, Source};
use crate::kit::schedule::rule_words::{self, long_day};
use crate::strings::{Locale, agenda_editor as editor_words, agenda_event as words, fill};

const DAY: usize = 10;

/// The page's lines, by where they sit.
#[derive(Default)]
pub struct Lines {
    pub title: Option<wire::PhoneSays>,
    pub when: Vec<wire::PhoneSays>,
    pub notes: Option<wire::PhoneSays>,
    pub facts: Vec<wire::PhoneSays>,
    pub guests: Vec<wire::PhoneSays>,
}

/// What the page knows of the phone it is drawn on.
#[derive(Clone, Copy)]
pub struct Wording<'a> {
    pub locale: Locale,
    pub cycle: HourCycle,
    /// The phone's own zone.
    pub device_zone: &'a str,
    /// The zone the event is in, when it has one of its own.
    pub event_zone: Option<&'a str>,
}

/// A stated start or end as the page words a time: the day, then the time or "all day", then the
/// zone where the event keeps one that is not the phone's. `None` for a value that is no time.
pub(crate) fn moment(wording: Wording<'_>, zone: Option<&str>, value: &str) -> Option<String> {
    let Wording {
        locale,
        cycle,
        device_zone,
        ..
    } = wording;
    if value.len() == DAY {
        civil::epoch_day_of(value)?;
        return Some(fill(
            &words::says_all_day(locale),
            &[("day", &long_day(locale, value))],
        ));
    }
    let own = zone.map(str::trim).filter(|zone| !zone.is_empty());
    let local = if has_zone_designator(value) {
        let in_zone = FireZone::named(own.unwrap_or(device_zone)).ok()?;
        let at = in_zone.zoned_parts(parse_civil_ms(value, &in_zone)?);
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}",
            at.year, at.month, at.day, at.hour, at.minute
        )
    } else {
        value.get(..16)?.to_owned()
    };
    let day = long_day(locale, local.get(..DAY)?);
    let time = civil::clock_for(locale, &local, cycle);
    let when = fill(&words::says_at(locale), &[("day", &day), ("time", &time)]);
    Some(match own.filter(|zone| *zone != device_zone) {
        Some(zone) => fill(
            &words::says_zoned(locale),
            &[("when", &when), ("zone", &zone_title(locale, zone))],
        ),
        None => when,
    })
}

/// A guest as the page names one: the name, else the address.
fn guest_name(item: &Value) -> Option<String> {
    item.get("name")
        .and_then(follow::text)
        .or_else(|| item.get("email").and_then(follow::text))
}

#[must_use]
pub fn lines(wording: Wording<'_>, found: &[Difference]) -> Lines {
    let Wording { locale, .. } = wording;
    let says = |field: &str, noun: String, value: String| {
        follow::says(locale, Source::Phone, &value, &noun, field, None)
    };
    let stated_text =
        |field: &str| -> Option<String> { follow::text(&follow::of(found, field)?.stated) };
    // The zone the calendar states, else the event's own: the one a stated instant is read in.
    let zone = stated_text("zone").or_else(|| wording.event_zone.map(str::to_owned));

    let mut when = Vec::new();
    for (field, line) in [
        ("starts", words::says_starts as fn(Locale) -> String),
        ("ends", words::says_ends),
    ] {
        let Some(shown) = stated_text(field).and_then(|v| moment(wording, zone.as_deref(), &v))
        else {
            continue;
        };
        when.push(says(
            field,
            words::says_noun_time(locale),
            fill(&line(locale), &[("when", &shown)]),
        ));
    }

    let mut facts = Vec::new();
    if let Some(zone) = stated_text("zone") {
        facts.push(says(
            "zone",
            words::says_noun_zone(locale),
            zone_title(locale, &zone),
        ));
    }
    if let Some(rule) = stated_text("rule") {
        facts.push(says(
            "rule",
            words::says_noun_repeat(locale),
            rule_words::stored(locale, &rule),
        ));
    }
    if let Some(link) = stated_text("url") {
        facts.push(says("url", words::says_noun_link(locale), link));
    }
    if let Some(difference) = follow::of(found, "busy") {
        let busy = match &difference.stated {
            Value::Bool(busy) => Some(*busy),
            other => other.as_i64().map(|busy| busy != 0),
        };
        if let Some(busy) = busy {
            facts.push(says(
                "busy",
                words::says_noun_availability(locale),
                if busy {
                    editor_words::busy(locale)
                } else {
                    editor_words::free(locale)
                },
            ));
        }
    }
    // The vault states alerts as a list of minutes; a source's older word may be that list as text.
    if let Some(alerts) = follow::of(found, "reminders")
        .and_then(|difference| match &difference.stated {
            Value::Array(list) => Some(list.iter().filter_map(Value::as_i64).collect::<Vec<_>>()),
            other => {
                follow::text(other).and_then(|text| serde_json::from_str::<Vec<i64>>(&text).ok())
            }
        })
        .filter(|alerts| !alerts.is_empty())
    {
        let shown: Vec<String> = centraid_vault::alerts::longest_first(alerts)
            .iter()
            .map(|minutes| reminder_label(locale, *minutes))
            .collect();
        facts.push(says(
            "reminders",
            words::says_noun_alerts(locale),
            shown.join(", "),
        ));
    }

    Lines {
        title: stated_text("title")
            .map(|title| says("title", words::says_noun_title(locale), title)),
        when,
        notes: stated_text("description")
            .map(|notes| says("description", words::says_noun_notes(locale), brief(&notes))),
        facts,
        guests: follow::of(found, "attendees").map_or_else(Vec::new, |guests| {
            follow::item_lines(locale, Source::Phone, guests, |item, guest| {
                let name = guest_name(guest)?;
                // A guest the member took off is named; one whose reply they changed is named
                // with the reply the calendar has.
                let shown = match guest.get("state").and_then(Value::as_str) {
                    Some(state) if item.held.is_some() => fill(
                        &words::guest_spoken(locale),
                        &[("name", &name), ("reply", &reply_label(locale, state))],
                    ),
                    _ => name,
                };
                Some((shown, words::says_noun_guest(locale)))
            })
        }),
    }
}

/// The first line of a note, cut at 80 characters: the line quotes the notes, it does not
/// reprint them.
pub(crate) fn brief(notes: &str) -> String {
    const MOST: usize = 80;
    let first = notes.lines().next().unwrap_or_default().trim();
    if first.chars().count() <= MOST && first.len() == notes.trim().len() {
        return first.to_owned();
    }
    let cut: String = first.chars().take(MOST).collect();
    format!("{}…", cut.trim_end())
}
