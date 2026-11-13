//! WHAT A PRESSED BUTTON DOES: a notification's id says what it is about, the
//! verb says what was asked, and the write goes through the one door
//! (`kit::act::act`) exactly as a row's check-off does (`todo::ops`).
//!
//! A write that committed leaves ONE receipt: an `immediate` notification the
//! phone says now ("Task done", the task's title under it) that carries Undo
//! when the core knows an inverse. A repeating task's completion has no Undo:
//! the engine has opened its next occurrence already, and reopening this one
//! would leave two open copies of one series. Undo names the action's actual
//! history change, so later edits to the same fields are never overwritten.

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::{FireZone, parse_civil_ms};

pub use super::receipt::Receipt;
use crate::calendar::routes as calendar_routes;
use crate::catalog::act;
use crate::field::Field;
use crate::kit::act::{self as kit_act, Settled};
use crate::kit::civil;
use crate::kit::stale;
use crate::reminders::routes as reminder_routes;
use crate::screen::Ctx;

/// What a notification's id names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Task { vault: String, task_id: String },
    Event { vault: String, instance_key: String },
    Receipt { vault: String },
}

impl Target {
    /// The vault the notification was made in.
    #[must_use]
    pub fn vault(&self) -> &str {
        match self {
            Self::Task { vault, .. } | Self::Event { vault, .. } | Self::Receipt { vault } => vault,
        }
    }
}

/// Read a notification id: `task|vault|task_id|fire_local`,
/// `event|vault|instance_key|minutes`, `receipt|vault|seq`.
#[must_use]
pub fn parse(id: &str) -> Option<Target> {
    let (kind, rest) = id.split_once('|')?;
    let (vault, tail) = rest.split_once('|')?;
    let vault = vault.to_owned();
    match kind {
        "task" => Some(Target::Task {
            vault,
            task_id: tail.rsplit_once('|')?.0.to_owned(),
        }),
        "event" => Some(Target::Event {
            vault,
            instance_key: tail.rsplit_once('|')?.0.to_owned(),
        }),
        "receipt" => Some(Target::Receipt { vault }),
        _ => None,
    }
}

/// An hour from `now_local`, as the wall clock of `zone` (`YYYY-MM-DDTHH:MM`).
/// The hour is elapsed time: across a spring-forward 01:30 snoozes to 03:30.
/// An autumn overlap's repeated wall clock reads as its earlier instant, so a
/// wall clock that would land before the hour is up moves on by what it lacks.
#[must_use]
pub fn snooze_due(now_local: &str, zone: &str) -> Option<String> {
    let zone = FireZone::named(zone).ok()?;
    let target = parse_civil_ms(now_local, &zone)? + 3_600_000;
    let wall = |ms: i64| {
        let at = zone.zoned_parts(ms);
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}",
            at.year, at.month, at.day, at.hour, at.minute
        )
    };
    let due = wall(target);
    let read = parse_civil_ms(&due, &zone)?;
    if read < target {
        return Some(wall(target + (target - read)));
    }
    Some(due)
}

/// Tomorrow at the task's own time of day, as a wall clock the core places
/// (a nonexistent one is the core's to resolve); a task with no time stays a
/// date.
#[must_use]
pub fn tomorrow_due(today: &str, due_time: &str) -> Option<String> {
    let day = civil::plus_days(today, 1)?;
    Some(if due_time.is_empty() {
        day
    } else {
        format!("{day}T{due_time}")
    })
}

/// What the last read says about a task, enough to answer a button.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskFacts {
    pub title: String,
    pub repeats: bool,
    pub due_time: String,
}

/// What the last read says about an event occurrence, enough to open it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventFacts {
    pub event_id: String,
    pub original_start_local: Option<String>,
    pub day: String,
}

/// The last read, as the answers need it.
#[derive(Clone, Debug, Default)]
pub struct Facts {
    pub today: String,
    pub now_local: String,
    pub tasks: BTreeMap<String, TaskFacts>,
    pub events: BTreeMap<String, EventFacts>,
}

impl Facts {
    #[must_use]
    pub fn of(
        today: &str,
        now_local: &str,
        tasks: &[wire::AgendaTask],
        events: &[wire::AgendaEvent],
    ) -> Self {
        Self {
            today: today.to_owned(),
            now_local: now_local.to_owned(),
            tasks: tasks
                .iter()
                .map(|task| {
                    (
                        task.task_id.clone(),
                        TaskFacts {
                            title: task.title.clone(),
                            repeats: task.repeats,
                            due_time: task.due_time.clone(),
                        },
                    )
                })
                .collect(),
            events: events
                .iter()
                .map(|event| {
                    (
                        event.instance_key.clone(),
                        EventFacts {
                            event_id: event.event_id.clone(),
                            original_start_local: event.original_start_local.clone(),
                            day: event.local_days.first().cloned().unwrap_or_else(|| {
                                event.local_start.get(..10).unwrap_or_default().to_owned()
                            }),
                        },
                    )
                })
                .collect(),
        }
    }
}

/// What one answer came to.
#[derive(Debug)]
pub enum Handled {
    /// It named nothing this phone can act on.
    Ignored,
    /// The write committed: hold this receipt.
    Committed(Box<Receipt>),
    /// The write was refused: no receipt, the set is read again.
    Refused,
    /// Persist the accepted gesture before running this guarded inverse.
    Undo(Box<Receipt>),
    /// Open this.
    Open(Box<wire::Route>),
}

fn key(verb: &str, id: &str) -> String {
    kit_act::key(&["notify", verb, id], kit_act::fresh())
}

fn edit(ctx: &Ctx, task_id: &str, due: String, lead: Field<i64>) -> Settled {
    // undo-exempt: a notification has no status line; its receipt offers the Undo.
    kit_act::act(
        ctx,
        act::reminders::EditTask {
            task_id: task_id.to_owned(),
            due: Field::Is(due),
            remind_before_min: lead,
            ..Default::default()
        },
        &key("edit-task", task_id),
    )
}

/// Whether a valid task button can replace the current receipt. Invalid or foreign
/// notifications must never discard the member's still-live Undo.
pub fn replaces(vault: &str, facts: &Facts, answered: &wire::NotificationAnswered) -> bool {
    let Some(Target::Task {
        vault: target_vault,
        task_id,
    }) = parse(&answered.notification_id)
    else {
        return false;
    };
    if target_vault != vault {
        return false;
    }
    let Some(task) = facts.tasks.get(&task_id) else {
        return false;
    };
    match wire::NotificationVerb::try_from(answered.verb) {
        Ok(wire::NotificationVerb::Done) => true,
        Ok(wire::NotificationVerb::SnoozeHour | wire::NotificationVerb::Tomorrow) => !task.repeats,
        _ => false,
    }
}

/// Answer `answered`, for the vault in front. `held` is the receipt on hold.
pub fn handle(
    ctx: &Ctx,
    vault: &str,
    facts: &Facts,
    held: Option<&Receipt>,
    answered: &wire::NotificationAnswered,
) -> Handled {
    use wire::NotificationVerb as Verb;
    let Some(target) = parse(&answered.notification_id) else {
        return Handled::Ignored;
    };
    // A notification of another vault is not this vault's to act on.
    if target.vault() != vault {
        return Handled::Ignored;
    }
    let Ok(verb) = Verb::try_from(answered.verb) else {
        return Handled::Ignored;
    };
    match (target, verb) {
        (Target::Task { task_id, .. }, Verb::Open) => {
            Handled::Open(Box::new(reminder_routes::task(&task_id)))
        }
        (Target::Event { instance_key, .. }, Verb::Open) => {
            facts
                .events
                .get(&instance_key)
                .map_or(Handled::Ignored, |event| {
                    Handled::Open(Box::new(calendar_routes::event(
                        &event.event_id,
                        &instance_key,
                        event.original_start_local.as_deref(),
                        &event.day,
                    )))
                })
        }
        (Target::Receipt { .. }, Verb::Open) => {
            // ONLY THE RECEIPT STILL HELD NAMES ITS TASK.
            match held.filter(|held| held.notification.notification_id == answered.notification_id)
            {
                Some(held) => Handled::Open(Box::new(reminder_routes::task(&held.task_id))),
                None => Handled::Ignored,
            }
        }
        (Target::Receipt { .. }, Verb::Undo) => {
            let Some(held) =
                held.filter(|held| held.notification.notification_id == answered.notification_id)
            else {
                return Handled::Ignored;
            };
            ctx.now_ms()
                .and_then(|now| held.request_undo(now))
                .map_or(Handled::Ignored, |receipt| Handled::Undo(Box::new(receipt)))
        }
        (Target::Task { vault, task_id }, verb) => {
            let Some(task) = facts.tasks.get(&task_id) else {
                return Handled::Ignored;
            };
            match verb {
                Verb::Done => {
                    let before = stale::read_rev(ctx, &task_id);
                    // undo-exempt: a notification has no status line; its receipt offers the Undo.
                    let settled = kit_act::act(
                        ctx,
                        act::reminders::CompleteTask {
                            task_id: task_id.clone(),
                        },
                        &key("complete-task", &task_id),
                    );
                    // A REPEATING TASK'S COMPLETION HAS NO UNDO: its next occurrence is open already.
                    let seq = if !task.repeats && settled.committed && settled.inverse.is_some() {
                        before.and_then(|before| {
                            stale::read_rev(ctx, &task_id)
                                .filter(|after| before.checked_add(1) == Some(*after))
                        })
                    } else {
                        None
                    };
                    done(ctx, &vault, &task_id, task, settled, Verb::Done as i32, seq)
                }
                // MOVING A REPEATING TASK'S DUE WOULD MOVE THE WHOLE SERIES.
                Verb::SnoozeHour if !task.repeats => {
                    let Some(due) = snooze_due(&facts.now_local, ctx.zone()) else {
                        return Handled::Refused;
                    };
                    let settled = edit(ctx, &task_id, due, Field::Is(0));
                    let seq = inverse_seq(&settled);
                    done(
                        ctx,
                        &vault,
                        &task_id,
                        task,
                        settled,
                        Verb::SnoozeHour as i32,
                        seq,
                    )
                }
                Verb::Tomorrow if !task.repeats => {
                    let Some(due) = tomorrow_due(&facts.today, &task.due_time) else {
                        return Handled::Refused;
                    };
                    let settled = edit(ctx, &task_id, due, Field::Keep);
                    let seq = inverse_seq(&settled);
                    done(
                        ctx,
                        &vault,
                        &task_id,
                        task,
                        settled,
                        Verb::Tomorrow as i32,
                        seq,
                    )
                }
                _ => Handled::Ignored,
            }
        }
        _ => Handled::Ignored,
    }
}

fn done(
    ctx: &Ctx,
    vault: &str,
    task_id: &str,
    task: &TaskFacts,
    settled: Settled,
    verb: i32,
    seq: Option<i64>,
) -> Handled {
    if !settled.committed {
        return Handled::Refused;
    }
    Receipt::made(ctx, vault, task_id, &task.title, verb, seq).map_or(Handled::Refused, |receipt| {
        Handled::Committed(Box::new(receipt))
    })
}

fn inverse_seq(settled: &Settled) -> Option<i64> {
    let inverse = settled.inverse.as_ref()?;
    if inverse.action != act::shell::UndoChange::NAME {
        return None;
    }
    match inverse.input.get("seq")?.kind.as_ref() {
        Some(wire::value::Kind::Integer(seq)) if *seq > 0 => Some(*seq),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
