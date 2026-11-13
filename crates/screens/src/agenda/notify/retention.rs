//! Delivered cards are validated by exact source, independently of the future window.
//! An unavailable read preserves a card; a definite source change cancels it.

use std::collections::{BTreeMap, BTreeSet};

use centraid_api_proto::core_v1 as wire;
use centraid_vault::blob::content_digest;
use wire::app_query_response::Answer;

use super::answer::{self, Facts, Receipt, Target};
use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;

fn digest(parts: &[&str]) -> String {
    let mut bytes = Vec::new();
    for part in parts {
        bytes.extend_from_slice(
            &u64::try_from(part.len())
                .expect("alert field length fits in u64")
                .to_le_bytes(),
        );
        bytes.extend_from_slice(part.as_bytes());
    }
    content_digest(&bytes)
}

/// Only stored alert configuration: no current period, clock, display zone or unrelated edit.
pub(super) fn task_fingerprint(task: &wire::AgendaTask) -> String {
    let lead = task
        .remind_before_min
        .map_or_else(String::new, |n| n.to_string());
    digest(&[
        "task-alert-v1",
        &task.task_id,
        &task.title,
        &task.status,
        task.due_at.as_deref().unwrap_or_default(),
        &lead,
        task.rrule.as_deref().unwrap_or_default(),
        task.recurrence_anchor.as_deref().unwrap_or_default(),
        task.tz.as_deref().unwrap_or_default(),
        task.project_id.as_deref().unwrap_or_default(),
    ])
}

pub(super) fn event_fingerprint(event: &wire::AgendaEvent, minutes: i64) -> String {
    digest(&[
        "event-alert-v1",
        &event.event_id,
        &event.instance_key,
        event.summary.as_deref().unwrap_or_default(),
        event.status.as_deref().unwrap_or_default(),
        &event.dtstart,
        event.dtend.as_deref().unwrap_or_default(),
        event.start_tz.as_deref().unwrap_or_default(),
        event.end_tz.as_deref().unwrap_or_default(),
        event.recurrence_semantics.as_deref().unwrap_or_default(),
        event.rrule.as_deref().unwrap_or_default(),
        event.calendar_id.as_deref().unwrap_or_default(),
        event.location_place_id.as_deref().unwrap_or_default(),
        &minutes.to_string(),
    ])
}

#[derive(Clone)]
enum Source<T> {
    Data(Option<T>),
    Failed,
}

/// Seeded from the bounded future reads; only absent actual delivered/clicked targets read again.
#[derive(Default)]
pub(super) struct Sources {
    tasks: BTreeMap<String, Source<wire::AgendaTask>>,
    events: BTreeMap<String, Source<wire::AgendaEvent>>,
}

impl Sources {
    pub fn of(tasks: &[wire::AgendaTask], events: &[wire::AgendaEvent]) -> Self {
        Self {
            tasks: tasks
                .iter()
                .map(|t| (t.task_id.clone(), Source::Data(Some(t.clone()))))
                .collect(),
            events: events
                .iter()
                .map(|e| (e.instance_key.clone(), Source::Data(Some(e.clone()))))
                .collect(),
        }
    }

    fn task(&mut self, ctx: &Ctx, id: &str) -> Source<wire::AgendaTask> {
        self.tasks
            .entry(id.to_owned())
            .or_insert_with(|| {
                match read::read(
                    ctx,
                    load::reminders::Task {
                        task_id: id.to_owned(),
                    },
                    |answer| match answer {
                        Answer::AgendaTask(detail) => Some(detail.task),
                        _ => None,
                    },
                ) {
                    Reading::Data(task) => Source::Data(task),
                    Reading::Denied(_) | Reading::Failed => Source::Failed,
                }
            })
            .clone()
    }

    fn event(&mut self, ctx: &Ctx, key: &str) -> Source<wire::AgendaEvent> {
        self.events
            .entry(key.to_owned())
            .or_insert_with(|| {
                let event_id = key.split_once(':').map_or(key, |(id, _)| id);
                match read::read(
                    ctx,
                    load::calendar::Event {
                        event_id: event_id.to_owned(),
                        instance_key: Some(key.to_owned()),
                        original_start_local: None,
                    },
                    |answer| match answer {
                        Answer::AgendaEvent(detail) => Some(detail.event),
                        _ => None,
                    },
                ) {
                    Reading::Data(event) => Source::Data(event),
                    Reading::Denied(_) | Reading::Failed => Source::Failed,
                }
            })
            .clone()
    }

    /// Return only definite cancellations. A read failure is not an empty source.
    pub fn cancellations(
        &mut self,
        ctx: &Ctx,
        vault: &str,
        delivered: &BTreeMap<String, String>,
        receipt: Option<&Receipt>,
        now: i64,
    ) -> BTreeSet<String> {
        delivered
            .iter()
            .filter_map(|(id, fingerprint)| {
                let cancel = match answer::parse(id) {
                    Some(target) if target.vault() != vault => true,
                    Some(Target::Task { task_id, .. }) if !task_id.is_empty() => {
                        match self.task(ctx, &task_id) {
                            Source::Failed => false,
                            Source::Data(None) => true,
                            Source::Data(Some(task)) => {
                                !task_eligible(&task)
                                    || !same_fingerprint(fingerprint, &task_fingerprint(&task))
                            }
                        }
                    }
                    Some(Target::Event { instance_key, .. }) if !instance_key.is_empty() => {
                        match event_minutes(id) {
                            None => true,
                            Some(minutes) => match self.event(ctx, &instance_key) {
                                Source::Failed => false,
                                Source::Data(None) => true,
                                Source::Data(Some(event)) => {
                                    !event_eligible(&event, minutes)
                                        || !same_fingerprint(
                                            fingerprint,
                                            &event_fingerprint(&event, minutes),
                                        )
                                }
                            },
                        }
                    }
                    Some(Target::Receipt { .. }) => !receipt.is_some_and(|held| {
                        held.notification.notification_id == *id && held.meta.live(vault, now)
                    }),
                    _ => true,
                };
                cancel.then(|| id.clone())
            })
            .collect()
    }

    /// Cold/past cards can name rows outside the reminders/upcoming window.
    /// Reuse these same exact reads to preserve their existing action/open route.
    pub fn augment_facts(
        &mut self,
        ctx: &Ctx,
        vault: &str,
        facts: &mut Facts,
        answered: &wire::NotificationAnswered,
    ) -> Result<(), ()> {
        match answer::parse(&answered.notification_id) {
            Some(target) if target.vault() != vault => {}
            Some(Target::Task { task_id, .. }) if !facts.tasks.contains_key(&task_id) => {
                match self.task(ctx, &task_id) {
                    Source::Failed => return Err(()),
                    Source::Data(Some(task)) if task_eligible(&task) => {
                        let extra = Facts::of(&facts.today, &facts.now_local, &[task], &[]);
                        facts.tasks.extend(extra.tasks);
                    }
                    Source::Data(_) => {}
                }
            }
            Some(Target::Event { instance_key, .. })
                if !facts.events.contains_key(&instance_key) =>
            {
                match self.event(ctx, &instance_key) {
                    Source::Failed => return Err(()),
                    Source::Data(Some(event))
                        if event_minutes(&answered.notification_id)
                            .is_some_and(|minutes| event_eligible(&event, minutes)) =>
                    {
                        let extra = Facts::of(&facts.today, &facts.now_local, &[], &[event]);
                        facts.events.extend(extra.events);
                    }
                    Source::Data(_) => {}
                }
            }
            _ => {}
        }
        Ok(())
    }
}

fn task_eligible(task: &wire::AgendaTask) -> bool {
    task.status == "open" && task.remind_before_min.is_some() && !task.remind_at_local.is_empty()
}

fn event_minutes(id: &str) -> Option<i64> {
    id.rsplit_once('|')?.1.parse().ok()
}

fn event_eligible(event: &wire::AgendaEvent, minutes: i64) -> bool {
    !event.all_day
        && event.status.as_deref() != Some("cancelled")
        && event.reminders.iter().any(|r| r.minutes_before == minutes)
}

fn same_fingerprint(stored: &str, current: &str) -> bool {
    // Cards posted before this additive field existed have no historical digest.
    // Keep a still-eligible exact source; do not invent aging of that legacy card.
    stored.is_empty() || stored == current
}

#[cfg(test)]
mod tests;
