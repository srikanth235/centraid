//! REMINDERS → AGENDA'S TO-DO, IN ONE TAP (the import lane C3 dropped, #1135; completed in #1173).
//!
//! The shell reads the reminders (iOS EventKit; Android has no system source) and answers a
//! [`wire::RemindersSnapshot`]; everything else is decided here. Each reminder becomes `add-task`
//! carrying what the app can hold of it:
//!
//! | EventKit | Becomes |
//! |---|---|
//! | title, notes | title, description |
//! | due date, due time, zone | `due` (a day, or `YYYY-MM-DDTHH:MM` floating) and `zone` |
//! | priority 0 / 1..4 / 5 / 6..9 | none / `!!!` (3) / `!!` (2) / `!` (1), see [`priority_of`] |
//! | flagged | the Flag: the task's star (`starred`), stated only when the shell can read the flag |
//! | recurrence rule | `rule` when the vault can expand it; else the task imports without one and the outcome counts it |
//! | alarms | `remind_before_min` from the FIRST alarm only (a relative one is its offset, an absolute one is due minus its date) |
//! | its list (calendar) | a list (project) of that name, made when missing, in the nearest of the eight list colours |
//! | URL | `url` |
//! | completed, completion date | a done task (`done_at`); ONLY when the member turned "Include completed reminders" on |
//!
//! Duplicates within the read (one title, one due day) are folded.

use std::collections::{BTreeSet, HashMap};

use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::rrule;
use serde_json::{Value, json};

use crate::catalog::{act, load};
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::strings::{Locale, fill, imports as import_words, task as words};
use wire::app_query_response::Answer;

/// The keychain key and value that say THIS device follows its Reminders: a habit of the device,
/// as the contacts' and calendar's are, so a restored vault follows nothing until a Connect.
const HABIT_KEY: &str = "agenda_reminders_followed";
const HABIT_VALUE: &[u8] = b"1";

/// Read the habit this device keeps for Reminders.
#[must_use]
pub(crate) fn habit_read() -> wire::Effect {
    habit(wire::keychain_op::Op::Get, Vec::new())
}

/// This device follows its Reminders from now on.
#[must_use]
pub(crate) fn habit_set() -> wire::Effect {
    habit(wire::keychain_op::Op::Set, HABIT_VALUE.to_vec())
}

fn habit(op: wire::keychain_op::Op, value: Vec<u8>) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::Keychain(wire::KeychainOp {
            op: op as i32,
            key: HABIT_KEY.to_owned(),
            value,
        })),
    }
}

/// Whether the keychain's answer says this device follows its Reminders.
#[must_use]
pub(crate) fn followed_in(value: &wire::KeychainValue) -> bool {
    value.found && value.value == HABIT_VALUE
}

/// The read a pass performs: never a permission, and every reminder, completed ones too, so a
/// reminder the phone completed is not mistaken for one it deleted.
#[must_use]
pub(crate) fn read_effect() -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::RemindersRead(wire::RemindersRead {
            ask_permission: false,
            include_completed: true,
        })),
    }
}

/// What one import did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub added: u32,
    pub refused: u32,
    /// Tasks whose repeat rule the vault cannot expand: imported without it.
    pub rules_dropped: u32,
    /// Lists made because a reminder's list had no namesake.
    pub lists_created: u32,
    /// How many reminders the read held.
    pub read: u32,
    /// The vault took at least one list: this device follows from now on.
    pub told: bool,
    /// Tasks the vault doubts (a read that lost most of what it follows).
    pub doubted: u32,
}

/// EventKit's raw priority (0 none, 1..4 high, 5 medium, 6..9 low) as the app's levels: `!!!` (3),
/// `!!` (2), `!` (1), and 0 for none. The vault scale is 0..9; the app writes 1, 2 and 3.
#[must_use]
pub const fn priority_of(raw: i32) -> i64 {
    match raw {
        1..=4 => 3,
        5 => 2,
        6..=9 => 1,
        _ => 0,
    }
}

/// The tasks a read makes: titled, trimmed, one per title and due day. A completed reminder is kept
/// only when `include_completed`.
#[must_use]
pub fn tasks(
    reminders: &[wire::PhoneReminder],
    include_completed: bool,
) -> Vec<wire::PhoneReminder> {
    let mut seen = BTreeSet::new();
    reminders
        .iter()
        .filter(|reminder| include_completed || !reminder.completed)
        .filter_map(|reminder| {
            let title = reminder.title.trim();
            let key = if reminder.phone_id.trim().is_empty() {
                format!("{}|{}", title.to_lowercase(), reminder.due)
            } else {
                format!("id:{}", reminder.phone_id.trim())
            };
            if title.is_empty() || !seen.insert(key) {
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
                url: reminder.url.trim().to_owned(),
                list_title: super::squash(&reminder.list_title),
                rrule: reminder.rrule.trim().to_owned(),
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

/// `HH:MM` out of `HH:MM` or `HH:MM:SS`.
fn clock_of(text: &str) -> Option<&str> {
    let text = text.trim();
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    ((bytes.len() == 5 || bytes.len() == 8)
        && digits(0..2)
        && bytes[2] == b':'
        && digits(3..5)
        && (bytes.len() == 5 || (bytes[5] == b':' && digits(6..8))))
    .then(|| &text[..5])
}

/// A reminder's due as the vault takes it: a day, or a floating wall clock with its zone.
fn due_of(reminder: &wire::PhoneReminder) -> (Option<String>, Option<String>) {
    if reminder.due.is_empty() {
        return (None, None);
    }
    match clock_of(&reminder.due_time) {
        None => (Some(reminder.due.clone()), None),
        Some(clock) => (
            Some(format!("{}T{clock}", reminder.due)),
            Some(reminder.tz.trim().to_owned()).filter(|zone| !zone.is_empty()),
        ),
    }
}

/// The rule the vault takes, `None` when there is none or it cannot be expanded (`dropped`).
fn rule_of(reminder: &wire::PhoneReminder, has_due: bool) -> (Option<String>, bool) {
    let rule = rrule::canonicalize(&reminder.rrule);
    if rule.is_empty() {
        return (None, false);
    }
    if has_due && rrule::inspect(&rule).is_ok() {
        (Some(rule), false)
    } else {
        (None, true)
    }
}

/// The origin's name for a reminder whose phone list is not named: the phone's Reminders app.
const ORIGIN_FALLBACK: &str = "Reminders";

/// One reminder as a `follow-reminders` record's fields (the mapping table of the module doc),
/// and whether its rule was dropped. `status` and `done_at` are always stated together.
#[must_use]
pub fn fields(reminder: &wire::PhoneReminder) -> (serde_json::Map<String, Value>, bool) {
    let (due, zone) = due_of(reminder);
    let (rule, dropped) = rule_of(reminder, due.is_some());
    let text = |value: &str| {
        if value.is_empty() {
            Value::Null
        } else {
            json!(value)
        }
    };
    let mut map = serde_json::Map::new();
    map.insert("title".into(), json!(reminder.title));
    map.insert("description".into(), text(&reminder.notes));
    map.insert(
        "due".into(),
        due.as_deref().map_or(Value::Null, |due| json!(due)),
    );
    map.insert(
        "zone".into(),
        zone.as_deref().map_or(Value::Null, |zone| json!(zone)),
    );
    map.insert("priority".into(), json!(priority_of(reminder.priority)));
    map.insert(
        "rule".into(),
        rule.as_deref().map_or(Value::Null, |rule| json!(rule)),
    );
    map.insert(
        "remind_before_min".into(),
        match (reminder.alarm_minutes_before, &due) {
            (Some(minutes), Some(_)) => json!(minutes),
            _ => Value::Null,
        },
    );
    map.insert("url".into(), text(&reminder.url));
    // The flag is the task's star. A shell that cannot read it states nothing, so a star the
    // member gave the task is never answered with "the phone says not flagged".
    if let Some(flagged) = reminder.flagged {
        map.insert("starred".into(), json!(flagged));
    }
    let done = reminder.completed && !reminder.completed_at.trim().is_empty();
    map.insert("status".into(), json!(if done { "done" } else { "open" }));
    map.insert(
        "done_at".into(),
        if done {
            json!(reminder.completed_at)
        } else {
            Value::Null
        },
    );
    (map, dropped)
}

/// The id a reminder is followed by: the phone's durable id, else its title and due day (a shell
/// that names none still follows, and cannot tell two alike apart).
fn external_id(reminder: &wire::PhoneReminder) -> String {
    if reminder.phone_id.trim().is_empty() {
        format!("title:{}|{}", reminder.title.to_lowercase(), reminder.due)
    } else {
        reminder.phone_id.trim().to_owned()
    }
}

/// The origin a reminder's list is: the phone's list id, else its name.
fn list_ref(reminder: &wire::PhoneReminder) -> String {
    if reminder.list_id.trim().is_empty() {
        format!("list:{}", reminder.list_title.to_lowercase())
    } else {
        reminder.list_id.trim().to_owned()
    }
}

/// The lists the member already has, by lower-cased name.
fn lists_held(ctx: &Ctx) -> Option<HashMap<String, String>> {
    match read::read(
        ctx,
        load::reminders::Projects::default(),
        |answer| match answer {
            Answer::AgendaTaskProjects(projects) => Some(projects),
            _ => None,
        },
    ) {
        Reading::Data(projects) => Some(
            projects
                .projects
                .into_iter()
                .map(|project| (project.name.to_lowercase(), project.project_id))
                .collect(),
        ),
        _ => None,
    }
}

/// The list colour a phone's `#RRGGBB` becomes: the nearest of the eight list colours by hue (a
/// red list is raspberry, a green one petrol, a grey graphite), `None` for no colour.
#[must_use]
pub fn list_color(title: &str, hex: &str) -> Option<String> {
    let hex = hex.trim();
    (!hex.is_empty()).then(|| centraid_design::list_color_key(title, Some(hex)).to_owned())
}

/// The list a reminder belongs to, made when the member has none of that name. `None` when it
/// names no list or the list could not be made (the task then lands in the Inbox).
fn list_for(
    ctx: &Ctx,
    reminder: &wire::PhoneReminder,
    held: &mut Option<HashMap<String, String>>,
    outcome: &mut Outcome,
) -> Option<String> {
    let title = &reminder.list_title;
    let known = held.as_mut()?;
    if title.is_empty() {
        return None;
    }
    if let Some(id) = known.get(&title.to_lowercase()) {
        return Some(id.clone());
    }
    // Nearest of the eight list colours by hue: a red list is raspberry, a green one petrol.
    let color = list_color(title, &reminder.list_color).map_or(Field::Keep, Field::Is);
    let key = kit_act::key(&["import-reminder-list", title], kit_act::fresh());
    let made = kit_act::act(
        ctx,
        act::reminders::CreateProject {
            title: title.clone(),
            color,
            ..act::reminders::CreateProject::default()
        },
        &key,
    );
    let id = made.committed.then(|| made.output_text("id")).flatten()?;
    outcome.lists_created += 1;
    known.insert(title.to_lowercase(), id.clone());
    Some(id)
}

/// Follow the read: one `follow-reminders` per phone list, whose tasks land in the list of that
/// name (made when missing). `complete` says the read held every reminder, completed ones too,
/// so one gone from it is gone from the phone. Both the member's import and the coordinator's
/// pass go through it.
pub fn run(ctx: &Ctx, reminders: &[wire::PhoneReminder], include_completed: bool) -> Outcome {
    let mut outcome = Outcome::default();
    let made = tasks(reminders, include_completed);
    let mut held = lists_held(ctx);
    let mut by_list: Vec<(String, Vec<&wire::PhoneReminder>)> = Vec::new();
    for reminder in &made {
        let key = list_ref(reminder);
        match by_list.iter_mut().find(|(known, _)| *known == key) {
            Some((_, group)) => group.push(reminder),
            None => by_list.push((key, vec![reminder])),
        }
    }
    outcome.read = u32::try_from(made.len()).unwrap_or(u32::MAX);
    for (reference, group) in by_list {
        let first = group[0];
        let project = list_for(ctx, first, &mut held, &mut outcome);
        let mut records = Vec::new();
        for reminder in &group {
            let (map, dropped) = fields(reminder);
            outcome.rules_dropped += u32::from(dropped);
            records.push(json!({ "external_id": external_id(reminder), "fields": map }));
        }
        let label = Some(first.list_title.trim())
            .filter(|title| !title.is_empty())
            .unwrap_or(ORIGIN_FALLBACK);
        let request = act::reminders::FollowReminders {
            origin: json!({ "ref": reference, "label": label, "fills": project }).to_string(),
            records: Value::Array(records).to_string(),
            complete: Some(include_completed),
            since: None,
        };
        let key = kit_act::key(&["follow-reminders", &reference], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        if !settled.committed {
            outcome.refused += u32::try_from(group.len()).unwrap_or(u32::MAX);
            continue;
        }
        outcome.told = true;
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
        outcome.doubted += count("doubted");
    }
    ctx.follows().judged(
        crate::follow::Store::Reminders,
        outcome.doubted,
        !include_completed,
    );
    outcome
}

/// The one sentence an import ends on: how many tasks came in. It ends in its verb, so a made
/// vault's summary can share it with the other imports.
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

/// THE STATUS LINE of a member's own import: the sentence, then what did not go as asked (the
/// refused, the repeat rules dropped) and the lists made.
#[must_use]
pub fn status_line(locale: Locale, outcome: Outcome) -> String {
    let mut parts = vec![sentence(locale, outcome).trim_end_matches('.').to_owned()];
    if outcome.added > 0 && outcome.refused > 0 {
        parts.push(import_words::reminders_refused(
            locale,
            u64::from(outcome.refused),
        ));
    }
    if outcome.rules_dropped > 0 {
        parts.push(import_words::reminders_rules_dropped(
            locale,
            u64::from(outcome.rules_dropped),
        ));
    }
    if outcome.lists_created > 0 {
        parts.push(import_words::reminders_lists_created(
            locale,
            u64::from(outcome.lists_created),
        ));
    }
    if parts.len() == 1 {
        return sentence(locale, outcome);
    }
    format!("{}.", parts.join(". "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reminder(title: &str, notes: &str, due: &str) -> wire::PhoneReminder {
        wire::PhoneReminder {
            title: title.to_owned(),
            notes: notes.to_owned(),
            due: due.to_owned(),
            ..wire::PhoneReminder::default()
        }
    }

    #[test]
    fn a_read_makes_titled_trimmed_tasks_one_per_title_and_due_day() {
        let made = tasks(
            &[
                reminder("  Renew passport ", " bring photos ", "2026-10-13"),
                reminder("renew passport", "", "2026-10-13"),
                reminder("Renew passport", "", "2026-11-01"),
                reminder("   ", "", ""),
                reminder("Call mum", "", "tomorrow"),
            ],
            false,
        );
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
    fn a_flag_is_stated_as_the_star_only_when_the_shell_could_read_it() {
        let stated = |flagged| {
            fields(&wire::PhoneReminder {
                flagged,
                ..reminder("A", "", "")
            })
            .0
        };
        assert_eq!(stated(Some(true)).get("starred"), Some(&json!(true)));
        assert_eq!(stated(Some(false)).get("starred"), Some(&json!(false)));
        assert_eq!(stated(None).get("starred"), None);
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
