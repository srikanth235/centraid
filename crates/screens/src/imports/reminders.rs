//! REMINDERS → AGENDA'S TO-DO, IN ONE TAP (the import lane C3 dropped, #1135).
//!
//! The shell reads the open reminders (iOS EventKit; Android has no system source) and
//! answers a [`wire::RemindersSnapshot`]; everything else is decided here. Each open
//! reminder becomes `add-task` with its notes and due day: an ordinary task of the member's, no
//! mark. Duplicates within the read (one title, one due day) are folded.

use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

use centraid_api_proto::core_v1 as wire;

use crate::catalog::act;
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::screen::Ctx;
use crate::strings::{Locale, fill, task as words};

/// What one import did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub added: u32,
    pub refused: u32,
    pub limited: bool,
    pub alarms_omitted: u32,
}

/// The tasks a read makes: titled, trimmed, one per title and due day.
#[must_use]
pub fn tasks(reminders: &[wire::PhoneReminder]) -> Vec<wire::PhoneReminder> {
    let mut seen = BTreeSet::new();
    reminders
        .iter()
        .filter_map(|reminder| {
            let title = reminder.title.trim();
            if title.is_empty()
                || !seen.insert(if reminder.phone_id.is_empty() {
                    format!(
                        "{}|{}|{}",
                        reminder.list_key,
                        title.to_lowercase(),
                        reminder.due
                    )
                } else {
                    format!("{}|{}", reminder.list_key, reminder.phone_id)
                })
            {
                return None;
            }
            Some(wire::PhoneReminder {
                title: title.to_owned(),
                notes: reminder.notes.trim().to_owned(),
                due: if is_day(&reminder.due) {
                    reminder.due.clone()
                } else {
                    String::new()
                },
                ..reminder.clone()
            })
        })
        .collect()
}

fn is_day(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

/// `add-task` for one reminder.
#[must_use]
pub fn request(reminder: &wire::PhoneReminder) -> act::agenda::AddTask {
    act::agenda::AddTask {
        title: reminder.title.clone(),
        description: if reminder.notes.is_empty() {
            Field::Keep
        } else {
            Field::Is(reminder.notes.clone())
        },
        due: if reminder.due.is_empty() {
            Field::Keep
        } else {
            Field::Is(reminder.due.clone())
        },
        ..act::agenda::AddTask::default()
    }
}

/// Stable source records are reimported through the one follower. A list is a
/// project; historical completion is a field, never a "complete now" gesture.
pub fn run(ctx: &Ctx, reminders: &[wire::PhoneReminder]) -> Outcome {
    run_snapshot(
        ctx,
        &wire::RemindersSnapshot {
            reminders: reminders.to_vec(),
            ..Default::default()
        },
    )
}

pub fn run_snapshot(ctx: &Ctx, snapshot: &wire::RemindersSnapshot) -> Outcome {
    let mut outcome = Outcome {
        limited: snapshot.native_hierarchy_unavailable,
        ..Outcome::default()
    };
    let mut lists: BTreeMap<String, Vec<wire::PhoneReminder>> = BTreeMap::new();
    for reminder in tasks(&snapshot.reminders) {
        outcome.alarms_omitted += reminder.unsupported_alarms;
        lists
            .entry(reminder.list_key.clone())
            .or_default()
            .push(reminder);
    }
    for (list, mut reminders) in lists {
        let title = reminders
            .first()
            .map(|r| r.list_title.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| words::view_reminders(ctx.locale()));
        let origin = json!({"ref": format!("reminders:{list}"), "label": title, "device_id": snapshot.device_id});
        // Parents precede their children; a cycle is counted as a refused record.
        let mut ordered = Vec::new();
        let mut seen = BTreeSet::new();
        while !reminders.is_empty() {
            let Some(index) = reminders
                .iter()
                .position(|r| r.parent_phone_id.is_empty() || seen.contains(&r.parent_phone_id))
            else {
                outcome.refused += u32::try_from(reminders.len()).unwrap_or(u32::MAX);
                break;
            };
            let reminder = reminders.remove(index);
            seen.insert(reminder.phone_id.clone());
            ordered.push(reminder);
        }
        let records: Vec<Value> = ordered.iter().map(|reminder| {
            let key = if reminder.phone_id.is_empty() { format!("legacy:{}|{}", reminder.title.to_lowercase(), reminder.due) } else { reminder.phone_id.clone() };
            let due = if reminder.due.is_empty() { None } else if reminder.time.is_empty() { Some(reminder.due.clone()) } else { Some(format!("{}T{}", reminder.due, reminder.time)) };
            let optional = |text: &str| if text.is_empty() { Value::Null } else { json!(text) };
            let priority = match reminder.priority { 1..=4 => 3, 5 => 2, 6..=9 => 1, _ => 0 };
            let mut fields = json!({
                "title": reminder.title, "description": optional(&reminder.notes), "url": optional(&reminder.url),
                "due": due, "zone": optional(&reminder.zone), "priority": priority,
                "rule": optional(&crate::agenda::calendar::rule(&reminder.rule, &reminder.due)),
                "status": if reminder.completed { "done" } else { "open" },
                "done_at": if reminder.completed { optional(&reminder.completed_at) } else { Value::Null },
                "reminders": reminder.alarms_before_min,
            });
            if let Some(flagged) = reminder.flagged { fields["flagged"] = json!(flagged); }
            if !snapshot.native_hierarchy_unavailable { fields["parent_key"] = optional(&reminder.parent_phone_id); }
            json!({"external_id": key, "device_id": if crate::agenda::calendar::is_portable_id(&reminder.phone_id) { Value::Null } else { json!(snapshot.device_id) }, "fields": fields})
        }).collect();
        let request = act::agenda::ImportReminders {
            origin: origin.to_string(),
            records: json!(records).to_string(),
            complete: Some(false),
            since: None,
        }
        .request();
        let settled = kit_act::act(
            ctx,
            request,
            &kit_act::key(&["import-reminders", &list], kit_act::fresh()),
        );
        if !settled.committed {
            outcome.refused += u32::try_from(records.len()).unwrap_or(u32::MAX);
            continue;
        }
        let output: Value = serde_json::from_slice(&settled.output).unwrap_or(Value::Null);
        let count = |name: &str| {
            output
                .get(name)
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0)
        };
        outcome.added += count("added") + count("matched");
        outcome.refused += count("refused");
    }
    outcome
}

/// The one sentence an import ends on.
#[must_use]
pub fn sentence(locale: Locale, outcome: Outcome) -> String {
    let mut sentence = match (outcome.added, outcome.refused) {
        (0, 0) => words::import_reminders_none(locale),
        (0, _) => words::import_reminders_failed(locale),
        (1, _) => words::import_reminders_one(locale),
        (added, _) => fill(
            &words::import_reminders_done(locale),
            &[("count", &added.to_string())],
        ),
    };
    if outcome.limited {
        sentence.push_str(". ");
        sentence.push_str(&words::import_reminders_native_limit(locale));
    }
    if outcome.alarms_omitted > 0 {
        sentence.push_str(". ");
        sentence.push_str(&words::import_reminders_alarm_limit(locale));
    }
    sentence
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reminder(title: &str, notes: &str, due: &str) -> wire::PhoneReminder {
        wire::PhoneReminder {
            title: title.to_owned(),
            notes: notes.to_owned(),
            due: due.to_owned(),
            ..Default::default()
        }
    }

    #[test]
    fn a_read_makes_titled_trimmed_tasks_one_per_title_and_due_day() {
        let made = tasks(&[
            reminder("  Renew passport ", " bring photos ", "2026-10-13"),
            reminder("renew passport", "", "2026-10-13"),
            reminder("Renew passport", "", "2026-11-01"),
            reminder("   ", "", ""),
            reminder("Call mum", "", "tomorrow"),
        ]);
        assert_eq!(
            made,
            vec![
                reminder("Renew passport", "bring photos", "2026-10-13"),
                reminder("Renew passport", "", "2026-11-01"),
                reminder("Call mum", "", ""),
            ]
        );
    }

    #[test]
    fn the_outcome_is_one_sentence() {
        let l = Locale::En;
        assert_eq!(
            sentence(l, Outcome::default()),
            "No open reminders to import"
        );
        assert_eq!(
            sentence(
                l,
                Outcome {
                    added: 0,
                    refused: 2,
                    ..Outcome::default()
                }
            ),
            "Reminders did not import."
        );
        assert_eq!(
            sentence(
                l,
                Outcome {
                    added: 1,
                    refused: 0,
                    ..Outcome::default()
                }
            ),
            "1 task imported"
        );
        assert_eq!(
            sentence(
                l,
                Outcome {
                    added: 4,
                    refused: 1,
                    ..Outcome::default()
                }
            ),
            "4 tasks imported"
        );
    }
}
