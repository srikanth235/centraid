//! THE COMMANDS THE EDITOR SAVES THROUGH, built from a draft.
//!
//! Every input is the manifest's own schema (`additionalProperties: false`), so a
//! field it does not name refuses the whole write; the typed catalogue cannot
//! spell one. A clear is `null` ([`Field::Clear`]), a field left alone is absent.
//!
//! ## Time is civil, and the core resolves it
//!
//! A timed event is sent as the wall clock the member picked,
//! `YYYY-MM-DDTHH:MM:00`, with `zone` (the device's, from the Environment): the
//! vault turns the pair into an instant, and a clock the zone skips is refused
//! with the core's sentence. An all-day event is its civil days, the end
//! INCLUSIVE (`agenda.proto`).

use super::draft::{Draft, REMINDER_NONE, guests_changed, rule_of, times_changed};
use crate::catalog::act::agenda as act;
use crate::field::Field;

/// A draft's times as a command states them.
struct Times {
    starts: String,
    ends: String,
    all_day: bool,
    zone: String,
}

impl Times {
    fn of(draft: &Draft, zone: &str) -> Self {
        if draft.all_day {
            Self {
                starts: draft.start_day.clone(),
                ends: draft.end_day.clone(),
                all_day: true,
                zone: String::new(),
            }
        } else {
            Self {
                starts: format!("{}T{}:00", draft.start_day, draft.start_time),
                ends: format!("{}T{}:00", draft.end_day, draft.end_time),
                all_day: false,
                zone: zone.to_owned(),
            }
        }
    }

    fn zone(&self) -> Field<String> {
        if self.all_day {
            Field::Keep
        } else {
            Field::Is(self.zone.clone())
        }
    }
}

/// The minutes before it starts, or `None` for "no reminder".
fn reminder_of(draft: &Draft) -> Option<i64> {
    draft
        .reminder_key
        .parse()
        .ok()
        .filter(|_| draft.reminder_key != REMINDER_NONE)
}

fn reminders(draft: &Draft) -> String {
    reminder_of(draft).map_or_else(|| "[]".to_owned(), |minutes| format!("[{minutes}]"))
}

fn json_list(ids: &[String]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_owned())
}

fn non_blank(text: &str) -> Option<String> {
    Some(text.trim())
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// `propose`: a new event.
#[must_use]
pub fn propose(draft: &Draft, zone: &str) -> act::Propose {
    let times = Times::of(draft, zone);
    act::Propose {
        title: draft.title.trim().to_owned(),
        description: non_blank(&draft.notes).map_or(Field::Keep, Field::Is),
        zone: times.zone(),
        timing: times.all_day.then_some(act::ProposeTiming::AllDay),
        ends: Field::Is(times.ends),
        starts: times.starts,
        calendar_id: Some(draft.calendar_id.clone()),
        attendees: (!draft.guest_ids.is_empty()).then(|| json_list(&draft.guest_ids)),
        rule: rule_of(&draft.repeat_key).map_or(Field::Keep, |rule| Field::Is(rule.to_owned())),
        url: non_blank(&draft.link).map_or(Field::Keep, Field::Is),
        reminders: reminder_of(draft).map_or(Field::Keep, |_| Field::Is(reminders(draft))),
        ..act::Propose::default()
    }
}

/// `edit-event`: the changed fields only. The owner stays on their own invitation:
/// replacing the guest list never drops `owner_ids`.
#[must_use]
pub fn edit_event(
    event_id: &str,
    draft: &Draft,
    base: &Draft,
    zone: &str,
    owner_ids: &[String],
) -> act::EditEvent {
    let mut edit = act::EditEvent {
        event_id: event_id.to_owned(),
        ..act::EditEvent::default()
    };
    if draft.title.trim() != base.title.trim() {
        edit.title = Some(draft.title.trim().to_owned());
    }
    if draft.notes.trim() != base.notes.trim() {
        edit.description = non_blank(&draft.notes).map_or(Field::Clear, Field::Is);
    }
    if times_changed(draft, base) {
        let times = Times::of(draft, zone);
        edit.zone = times.zone();
        edit.timing = times.all_day.then_some(act::EditEventTiming::AllDay);
        edit.ends = Field::Is(times.ends);
        edit.starts = Some(times.starts);
    }
    if draft.repeat_key != base.repeat_key {
        edit.rule =
            rule_of(&draft.repeat_key).map_or(Field::Clear, |rule| Field::Is(rule.to_owned()));
    }
    if draft.calendar_id != base.calendar_id && !draft.calendar_id.is_empty() {
        edit.calendar_id = Some(draft.calendar_id.clone());
    }
    if draft.link.trim() != base.link.trim() {
        edit.url = non_blank(&draft.link).map_or(Field::Clear, Field::Is);
    }
    if draft.reminder_key != base.reminder_key {
        edit.reminders = Field::Is(reminders(draft));
    }
    if guests_changed(draft, base) {
        let mut everyone = owner_ids.to_vec();
        everyone.extend(draft.guest_ids.iter().cloned());
        edit.attendees = Some(json_list(&everyone));
    }
    edit
}

/// `edit-occurrence`, `override`: the day's own times and words, and nothing
/// else. A guest, a reminder, a link or a calendar belongs to the whole event.
#[must_use]
pub fn override_occurrence(
    event_id: &str,
    original_start: &str,
    scope: act::EditOccurrenceScope,
    draft: &Draft,
    base: &Draft,
    zone: &str,
) -> act::EditOccurrence {
    let mut edit = act::EditOccurrence {
        action: act::EditOccurrenceAction::Override,
        event_id: event_id.to_owned(),
        original_start: original_start.to_owned(),
        scope,
        ..act::EditOccurrence::default()
    };
    if times_changed(draft, base) {
        let times = Times::of(draft, zone);
        edit.zone = times.zone();
        edit.timing = times.all_day.then_some(act::EditOccurrenceTiming::AllDay);
        edit.ends = Field::Is(times.ends);
        edit.starts = Some(times.starts);
    }
    if draft.title.trim() != base.title.trim() {
        edit.title = Some(draft.title.trim().to_owned());
    }
    if draft.notes.trim() != base.notes.trim() {
        edit.description = Some(draft.notes.trim().to_owned());
    }
    edit
}

/// `edit-occurrence`, `skip`.
#[must_use]
pub fn skip_occurrence(
    event_id: &str,
    original_start: &str,
    scope: act::EditOccurrenceScope,
) -> act::EditOccurrence {
    act::EditOccurrence {
        action: act::EditOccurrenceAction::Skip,
        event_id: event_id.to_owned(),
        original_start: original_start.to_owned(),
        scope,
        ..act::EditOccurrence::default()
    }
}
