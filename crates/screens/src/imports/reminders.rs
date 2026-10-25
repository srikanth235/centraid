//! REMINDERS → AGENDA'S TO-DO, IN ONE TAP (docs/decisions.md, "Onboarding without sample
//! data", R-ONBOARD-4; the import lane C3 dropped, #1135).
//!
//! The shell reads the open reminders (iOS EventKit; Android has no system source) and
//! answers a [`wire::RemindersSnapshot`]; everything else is decided here. Each open
//! reminder becomes `add-task` with its notes and due day: an ordinary task of the member's, no
//! mark. Duplicates within the read (one title, one due day) are folded.

use std::collections::BTreeSet;

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
                || !seen.insert(format!("{}|{}", title.to_lowercase(), reminder.due))
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

/// Write the read's tasks, one `add-task` each; a refused one is counted and the rest kept.
pub fn run(ctx: &Ctx, reminders: &[wire::PhoneReminder]) -> Outcome {
    let mut outcome = Outcome::default();
    for reminder in tasks(reminders) {
        let key = kit_act::key(
            &["import-reminder", &reminder.title, &reminder.due],
            kit_act::fresh(),
        );
        if kit_act::act(ctx, request(&reminder), &key).committed {
            outcome.added += 1;
        } else {
            outcome.refused += 1;
        }
    }
    outcome
}

/// The one sentence an import ends on.
#[must_use]
pub fn sentence(locale: Locale, outcome: Outcome) -> String {
    match (outcome.added, outcome.refused) {
        (0, 0) => words::import_reminders_none(locale),
        (0, _) => words::import_reminders_failed(locale),
        (1, _) => words::import_reminders_one(locale),
        (added, _) => fill(
            &words::import_reminders_done(locale),
            &[("count", &added.to_string())],
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reminder(title: &str, notes: &str, due: &str) -> wire::PhoneReminder {
        wire::PhoneReminder {
            title: title.to_owned(),
            notes: notes.to_owned(),
            due: due.to_owned(),
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
                    refused: 2
                }
            ),
            "Reminders did not import."
        );
        assert_eq!(
            sentence(
                l,
                Outcome {
                    added: 1,
                    refused: 0
                }
            ),
            "1 task imported"
        );
        assert_eq!(
            sentence(
                l,
                Outcome {
                    added: 4,
                    refused: 1
                }
            ),
            "4 tasks imported"
        );
    }
}
