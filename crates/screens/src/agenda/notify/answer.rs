//! WHAT A PRESSED BUTTON DOES: a notification's id says what it is about, the
//! verb says what was asked, and the write goes through the one door
//! (`kit::act::act`) exactly as a row's check-off does (`todo::ops`).
//!
//! A write that committed leaves ONE receipt: an `immediate` notification the
//! phone says now ("Task done", the task's title under it) that carries Undo
//! when the core knows an inverse. A repeating task's completion has no Undo:
//! the engine has opened its next occurrence already, and reopening this one
//! would leave two open copies of one series. A snooze and a move to tomorrow
//! undo by putting the due and the lead back as they were read: the core has no
//! inverse for an edit.

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::{FireZone, parse_civil_ms};

use super::desired::{RECEIPT, THREAD};
use crate::calendar::routes as calendar_routes;
use crate::catalog::act;
use crate::field::Field;
use crate::kit::act::{self as kit_act, Settled};
use crate::kit::civil;
use crate::reminders::routes as reminder_routes;
use crate::screen::Ctx;
use crate::strings::{agenda_notify as words, task as task_words};

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
    /// The due as the member set it, to put back on Undo (the core has no
    /// inverse for an edit).
    pub due: String,
    pub remind_before_min: Option<i64>,
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
                            due: if task.due_local.is_empty() {
                                task.due_day.clone()
                            } else {
                                task.due_local.clone()
                            },
                            remind_before_min: task.remind_before_min,
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

/// The receipt held after a button: what the phone said, and how to undo it.
#[derive(Clone, Debug)]
pub struct Receipt {
    pub notification: wire::PendingNotification,
    pub task_id: String,
    undo: Option<wire::ActRequest>,
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
    /// Undo ran (or was refused): the receipt is dropped.
    Undone,
    /// Open this.
    Open(Box<wire::Route>),
}

fn receipt(
    ctx: &Ctx,
    vault: &str,
    task_id: &str,
    title: &str,
    heading: String,
    undo: Option<wire::ActRequest>,
) -> Receipt {
    let locale = ctx.locale();
    let seq = kit_act::fresh();
    Receipt {
        notification: wire::PendingNotification {
            notification_id: format!("receipt|{vault}|{seq}"),
            fire_local: String::new(),
            zone: ctx.zone().to_owned(),
            fire_at_ms: 0,
            title: heading,
            body: if title.trim().is_empty() {
                task_words::untitled(locale)
            } else {
                title.to_owned()
            },
            category_id: if undo.is_some() {
                RECEIPT.to_owned()
            } else {
                String::new()
            },
            thread_id: THREAD.to_owned(),
            immediate: true,
        },
        task_id: task_id.to_owned(),
        undo,
    }
}

fn key(verb: &str, id: &str) -> String {
    kit_act::key(&["notify", verb, id], kit_act::fresh())
}

/// The edit that puts a task's due and lead back as they were: the core has no
/// inverse for an edit, so the one Undo sends is made from what was read.
fn put_back(task_id: &str, task: &TaskFacts) -> wire::ActRequest {
    act::reminders::EditTask {
        task_id: task_id.to_owned(),
        due: if task.due.is_empty() {
            Field::Clear
        } else {
            Field::Is(task.due.clone())
        },
        remind_before_min: task.remind_before_min.map_or(Field::Clear, Field::Is),
        ..Default::default()
    }
    .request()
}

fn edit(ctx: &Ctx, task_id: &str, due: String, lead: Field<i64>) -> Settled {
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
    let locale = ctx.locale();
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
            if let Some(request) = held.undo.clone() {
                kit_act::act(ctx, request, &key("undo", &held.task_id));
            }
            Handled::Undone
        }
        (Target::Task { vault, task_id }, verb) => {
            let Some(task) = facts.tasks.get(&task_id) else {
                return Handled::Ignored;
            };
            match verb {
                Verb::Done => {
                    let settled = kit_act::act(
                        ctx,
                        act::reminders::CompleteTask {
                            task_id: task_id.clone(),
                        },
                        &key("complete-task", &task_id),
                    );
                    // A REPEATING TASK'S COMPLETION HAS NO UNDO: its next occurrence is open already.
                    let undo = settled
                        .inverse
                        .clone()
                        .filter(|_| !task.repeats)
                        .map(|inverse| wire::ActRequest {
                            app: act::reminders::APP.to_owned(),
                            action: inverse.action,
                            input: inverse.input,
                            invoke_key: String::new(),
                        });
                    done(
                        ctx,
                        &vault,
                        &task_id,
                        task,
                        settled,
                        task_words::task_done(locale),
                        undo,
                    )
                }
                // MOVING A REPEATING TASK'S DUE WOULD MOVE THE WHOLE SERIES.
                Verb::SnoozeHour if !task.repeats => {
                    let Some(due) = snooze_due(&facts.now_local, ctx.zone()) else {
                        return Handled::Refused;
                    };
                    let settled = edit(ctx, &task_id, due, Field::Is(0));
                    done(
                        ctx,
                        &vault,
                        &task_id,
                        task,
                        settled,
                        words::snoozed_hour(locale),
                        Some(put_back(&task_id, task)),
                    )
                }
                Verb::Tomorrow if !task.repeats => {
                    let Some(due) = tomorrow_due(&facts.today, &task.due_time) else {
                        return Handled::Refused;
                    };
                    let settled = edit(ctx, &task_id, due, Field::Keep);
                    done(
                        ctx,
                        &vault,
                        &task_id,
                        task,
                        settled,
                        words::moved_tomorrow(locale),
                        Some(put_back(&task_id, task)),
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
    heading: String,
    undo: Option<wire::ActRequest>,
) -> Handled {
    if !settled.committed {
        return Handled::Refused;
    }
    Handled::Committed(Box::new(receipt(
        ctx,
        vault,
        task_id,
        &task.title,
        heading,
        undo,
    )))
}

#[cfg(test)]
mod tests;
