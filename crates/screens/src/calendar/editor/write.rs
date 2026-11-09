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

use crate::catalog::act::calendar as act_cal;
use crate::field::Field;
use crate::kit::schedule::draft::{
    Draft, alerts_of, guests_changed, rule_for, same_repeat, times_changed,
};

/// How a draft's wall clock is placed in time.
enum Placing {
    /// A day, and no clock.
    AllDay,
    /// A wall clock in a named IANA zone.
    Zoned(String),
    /// A wall clock the same everywhere.
    Floating,
}

/// A draft's times as a command states them.
struct Times {
    starts: String,
    ends: String,
    placing: Placing,
}

impl Times {
    /// A timed draft with no zone is floating by choice: the editor puts the
    /// device's zone in every new timed event.
    fn of(draft: &Draft) -> Self {
        if draft.all_day {
            Self {
                starts: draft.start_day.clone(),
                ends: draft.end_day.clone(),
                placing: Placing::AllDay,
            }
        } else {
            Self {
                starts: format!("{}T{}:00", draft.start_day, draft.start_time),
                ends: format!("{}T{}:00", draft.end_day, draft.end_time),
                placing: if draft.zone.is_empty() {
                    Placing::Floating
                } else {
                    Placing::Zoned(draft.zone.clone())
                },
            }
        }
    }

    /// The zone a command carries: a zoned clock names it, a floating one
    /// clears whatever zone the event had, an all-day event has none to send.
    fn zone(&self, clearing: bool) -> Field<String> {
        match &self.placing {
            Placing::Zoned(zone) => Field::Is(zone.clone()),
            Placing::Floating if clearing => Field::Clear,
            Placing::Floating | Placing::AllDay => Field::Keep,
        }
    }
}

/// The reminders the draft sets: up to two leads, first then second.
fn reminders(draft: &Draft) -> String {
    serde_json::to_string(&alerts_of(draft)).unwrap_or_else(|_| "[]".to_owned())
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
pub fn propose(draft: &Draft) -> act_cal::Propose {
    let times = Times::of(draft);
    act_cal::Propose {
        title: draft.title.trim().to_owned(),
        description: non_blank(&draft.notes).map_or(Field::Keep, Field::Is),
        zone: times.zone(false),
        timing: match times.placing {
            Placing::AllDay => Some(act_cal::ProposeTiming::AllDay),
            Placing::Floating => Some(act_cal::ProposeTiming::Floating),
            Placing::Zoned(_) => None,
        },
        ends: Field::Is(times.ends),
        starts: times.starts,
        calendar_id: Some(draft.calendar_id.clone()),
        attendees: (!draft.guest_ids.is_empty()).then(|| json_list(&draft.guest_ids)),
        rule: rule_for(draft).map_or(Field::Keep, Field::Is),
        url: non_blank(&draft.link).map_or(Field::Keep, Field::Is),
        place_id: non_blank(&draft.place_id).map_or(Field::Keep, Field::Is),
        busy: draft.free.then_some(false),
        travel_min: if draft.travel_min > 0 {
            Field::Is(i64::from(draft.travel_min))
        } else {
            Field::Keep
        },
        reminders: if alerts_of(draft).is_empty() {
            Field::Keep
        } else {
            Field::Is(reminders(draft))
        },
        ..act_cal::Propose::default()
    }
}

/// `edit-event`: the changed fields only. The owner stays on their own invitation:
/// replacing the guest list never drops `owner_ids`.
#[must_use]
pub fn edit_event(
    event_id: &str,
    draft: &Draft,
    base: &Draft,
    owner_ids: &[String],
) -> act_cal::EditEvent {
    let mut edit = act_cal::EditEvent {
        event_id: event_id.to_owned(),
        ..act_cal::EditEvent::default()
    };
    if draft.title.trim() != base.title.trim() {
        edit.title = Some(draft.title.trim().to_owned());
    }
    if draft.notes.trim() != base.notes.trim() {
        edit.description = non_blank(&draft.notes).map_or(Field::Clear, Field::Is);
    }
    if times_changed(draft, base) {
        let times = Times::of(draft);
        edit.zone = times.zone(true);
        edit.timing = match times.placing {
            Placing::AllDay => Some(act_cal::EditEventTiming::AllDay),
            Placing::Floating => Some(act_cal::EditEventTiming::Floating),
            Placing::Zoned(_) => None,
        };
        edit.ends = Field::Is(times.ends);
        edit.starts = Some(times.starts);
    }
    if !same_repeat(draft, base) {
        edit.rule = rule_for(draft).map_or(Field::Clear, Field::Is);
    }
    if draft.place_id != base.place_id {
        edit.place_id = non_blank(&draft.place_id).map_or(Field::Clear, Field::Is);
    }
    if draft.free != base.free {
        edit.busy = Some(!draft.free);
    }
    if draft.travel_min != base.travel_min {
        edit.travel_min = if draft.travel_min > 0 {
            Field::Is(i64::from(draft.travel_min))
        } else {
            Field::Clear
        };
    }
    if draft.calendar_id != base.calendar_id && !draft.calendar_id.is_empty() {
        edit.calendar_id = Some(draft.calendar_id.clone());
    }
    if draft.link.trim() != base.link.trim() {
        edit.url = non_blank(&draft.link).map_or(Field::Clear, Field::Is);
    }
    if draft.reminder_key != base.reminder_key
        || draft.second_reminder_key != base.second_reminder_key
    {
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
    scope: act_cal::EditOccurrenceScope,
    draft: &Draft,
    base: &Draft,
) -> act_cal::EditOccurrence {
    let mut edit = act_cal::EditOccurrence {
        action: act_cal::EditOccurrenceAction::Override,
        event_id: event_id.to_owned(),
        original_start: original_start.to_owned(),
        scope,
        ..act_cal::EditOccurrence::default()
    };
    if times_changed(draft, base) {
        let times = Times::of(draft);
        edit.zone = times.zone(true);
        edit.timing = match times.placing {
            Placing::AllDay => Some(act_cal::EditOccurrenceTiming::AllDay),
            Placing::Floating => Some(act_cal::EditOccurrenceTiming::Floating),
            Placing::Zoned(_) => None,
        };
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
    scope: act_cal::EditOccurrenceScope,
) -> act_cal::EditOccurrence {
    act_cal::EditOccurrence {
        action: act_cal::EditOccurrenceAction::Skip,
        event_id: event_id.to_owned(),
        original_start: original_start.to_owned(),
        scope,
        ..act_cal::EditOccurrence::default()
    }
}
