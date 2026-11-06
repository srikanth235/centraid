//! Agenda's device scheduler. One live read drives replacement plans; a native
//! journal retains snoozes and pending actions until Rust acknowledges them.
//! Plans contain only the current vault and never replay an overdue backlog.
use crate::agenda::notification_status as status;
use crate::catalog::act;
use crate::kit::act as writes;
use crate::strings::task;
use crate::{Ctx, Registry, Screen};
use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::zone::FireZone;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

pub(crate) const NAME: &str = "agenda.notifications";
/// Leave room below iOS's per-app limit of 64 pending requests.
const CAPACITY: usize = 60;
const REFRESH: &str = "notifications.refresh";

/// The persistent viewless service's registration.
pub fn registry() -> Registry {
    Registry::default().with(NAME, |_| Some(Box::new(Service::default())))
}
/// Services survive navigation and vault switches.
pub fn services() -> Vec<wire::Route> {
    vec![wire::Route {
        screen: NAME.to_owned(),
        args: None,
    }]
}

#[derive(Default)]
struct Service {
    started: bool,
    loaded: bool,
    foreground: bool,
    journal_vault: String,
    snoozed: BTreeMap<String, wire::AgendaAlert>,
    pending: BTreeMap<String, wire::AgendaNotificationAction>,
    last: Option<wire::AgendaNotificationSync>,
    status: Option<&'static str>,
}

fn effect(sync: wire::AgendaNotificationSync) -> Vec<wire::Effect> {
    vec![wire::Effect {
        kind: Some(wire::effect::Kind::AgendaNotifications(sync)),
    }]
}

/// The earliest future alerts, with valid snoozes replacing their source.
fn plan(
    alerts: &[wire::AgendaAlert],
    snoozed: &mut BTreeMap<String, wire::AgendaAlert>,
    sources: &[wire::AgendaAlertSource],
    now: i64,
) -> Vec<wire::AgendaAlert> {
    snoozed.retain(|_, snooze| {
        snooze.fire_at_ms > now
            && sources.iter().any(|source| {
                source.entity_id == snooze.entity_id
                    && source.source_stamp == snooze.source_stamp
                    && source.task == snooze.task
            })
    });
    let mut by_id: BTreeMap<_, _> = alerts
        .iter()
        .filter(|alert| alert.fire_at_ms > now)
        .map(|alert| (alert.id.clone(), alert.clone()))
        .collect();
    // A snoozed delivered occurrence need not be among the next bounded candidates.
    for (id, snooze) in snoozed.iter() {
        by_id.insert(id.clone(), snooze.clone());
    }
    let mut scheduled: Vec<_> = by_id.into_values().collect();
    scheduled.sort_by(|a, b| (a.fire_at_ms, &a.id).cmp(&(b.fire_at_ms, &b.id)));
    scheduled.truncate(CAPACITY);
    scheduled
}

impl Service {
    fn tell(&mut self, topic: &'static str, ctx: &Ctx) {
        if self.status == Some(topic) {
            return;
        }
        self.status = Some(topic);
        for screen in [
            crate::agenda::HOME,
            crate::agenda::EVENT,
            crate::agenda::TASK,
            crate::agenda::EDITOR,
        ] {
            ctx.post(
                screen,
                wire::ScreenEvent {
                    kind: Some(wire::screen_event::Kind::Announced(wire::Announced {
                        topic: topic.into(),
                    })),
                },
            );
        }
    }

    fn refresh(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        // Records shelf invalidation even when there is no vault in front yet.
        let holdings = ctx
            .load(wire::LoadRequest {
                app: "shell".into(),
                query: "holdings".into(),
                ..Default::default()
            })
            .ok()
            .and_then(|response| response.answer)
            .and_then(|answer| answer.answer);
        ctx.start_timer(REFRESH, Duration::from_secs(60));
        let Some(wire::app_query_response::Answer::Holdings(holdings)) = holdings else {
            return Vec::new();
        };
        // Shelf bootstrap and the notification journal load run concurrently.
        // An unread shelf is not an empty shelf: preserve its alerts and taps.
        if !holdings.loaded {
            return Vec::new();
        }
        if !self.loaded {
            return effect(wire::AgendaNotificationSync {
                load_only: true,
                ..Default::default()
            });
        }
        let vault = holdings.foreground;
        if self.journal_vault != vault {
            self.snoozed.clear();
        }
        let mut acknowledge = Vec::new();
        for (id, action) in &self.pending {
            if action.vault_id != vault || vault.is_empty() {
                acknowledge.push(id.clone());
            }
        }
        let mut alerts = if vault.is_empty() {
            wire::AgendaAlerts::default()
        } else {
            let reading = ctx.load(wire::LoadRequest {
                app: "agenda".into(),
                query: "notifications".into(),
                ..Default::default()
            });
            match reading.ok().and_then(|r| r.answer).and_then(|r| r.answer) {
                Some(wire::app_query_response::Answer::AgendaAlerts(alerts)) => alerts,
                _ if self.journal_vault == vault => {
                    self.last = None;
                    self.tell(status::FAILED, ctx);
                    return Vec::new(); // retain a valid plan on a failed read
                }
                _ => wire::AgendaAlerts::default(), // a switch always cancels the prior vault
            }
        };
        let mut completed = BTreeSet::new();
        let mut action_failed = false;
        for (id, action) in &self.pending {
            if acknowledge.contains(id) {
                continue;
            }
            let Some(source) = alerts.sources.iter().find(|source| {
                source.entity_id == action.entity_id && source.source_stamp == action.source_stamp
            }) else {
                acknowledge.push(id.clone());
                continue;
            };
            use wire::agenda_notification_action::Kind;
            let accepted = match Kind::try_from(action.kind).unwrap_or(Kind::Unspecified) {
                Kind::Done if source.task => {
                    if completed.contains(&source.entity_id) {
                        acknowledge.push(id.clone());
                        continue;
                    }
                    let settled = writes::act(
                        ctx,
                        act::agenda::CompleteTask {
                            task_id: source.entity_id.clone(),
                        },
                        &format!("notification:{id}"),
                    );
                    if settled.committed {
                        completed.insert(source.entity_id.clone());
                    }
                    action_failed |= !settled.committed;
                    settled.committed
                }
                Kind::Hour | Kind::Tomorrow => {
                    let at = if action.kind == Kind::Hour as i32 {
                        action.at_ms.checked_add(3_600_000)
                    } else {
                        FireZone::named(ctx.zone()).ok().and_then(|zone| {
                            centraid_apps_agenda::notifications::tomorrow(action.at_ms, &zone)
                        })
                    };
                    if let Some(at) = at.filter(|at| *at > alerts.now_ms) {
                        self.snoozed.insert(
                            action.alert_id.clone(),
                            wire::AgendaAlert {
                                id: action.alert_id.clone(),
                                entity_id: source.entity_id.clone(),
                                source_stamp: source.source_stamp.clone(),
                                task: source.task,
                                fire_at_ms: at,
                                title: source.title.clone(),
                                body: task::field_reminder(ctx.locale()),
                            },
                        );
                    }
                    true
                }
                _ => true,
            };
            if accepted {
                acknowledge.push(id.clone());
            }
        }
        if !completed.is_empty() {
            let next = ctx.load(wire::LoadRequest {
                app: "agenda".into(),
                query: "notifications".into(),
                ..Default::default()
            });
            if let Some(wire::app_query_response::Answer::AgendaAlerts(next)) =
                next.ok().and_then(|r| r.answer).and_then(|r| r.answer)
            {
                alerts = next;
            } else {
                action_failed = true;
            }
            // A committed Done already proves these sources are obsolete even
            // if the follow-up read fails. Never reschedule their old alarms.
            alerts
                .alerts
                .retain(|alert| !completed.contains(&alert.entity_id));
            alerts
                .sources
                .retain(|source| !completed.contains(&source.entity_id));
        }
        for id in &acknowledge {
            self.pending.remove(id);
        }
        if action_failed {
            self.tell(status::FAILED, ctx);
        }
        for alert in &mut alerts.alerts {
            alert.body = task::field_reminder(ctx.locale());
        }
        let scheduled = plan(
            &alerts.alerts,
            &mut self.snoozed,
            &alerts.sources,
            alerts.now_ms,
        );
        let sync = wire::AgendaNotificationSync {
            load_only: false,
            vault_id: vault.clone(),
            sources: alerts
                .sources
                .iter()
                .map(|source| wire::AgendaNotificationSource {
                    entity_id: source.entity_id.clone(),
                    source_stamp: source.source_stamp.clone(),
                })
                .collect(),
            ask_permission: self.foreground && !scheduled.is_empty(),
            alerts: scheduled,
            snoozed: self.snoozed.values().cloned().collect(),
            acknowledge,
            channel_label: task::group_reminders(ctx.locale()),
            done_label: task::notification_done(ctx.locale()),
            hour_label: task::notification_hour(ctx.locale()),
            tomorrow_label: task::notification_tomorrow(ctx.locale()),
        };
        self.journal_vault = vault;
        if self.last.as_ref() == Some(&sync) {
            Vec::new()
        } else {
            self.last = Some(sync.clone());
            effect(sync)
        }
    }
}

impl Screen for Service {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::screen_event::Kind as E;
        match event.kind {
            Some(E::Appeared(_)) if !self.started => {
                self.started = true;
                ctx.start_timer(REFRESH, Duration::from_secs(60));
                effect(wire::AgendaNotificationSync {
                    load_only: true,
                    ..Default::default()
                })
            }
            Some(E::EffectResult(result)) => {
                if let Some(wire::effect_result::Outcome::AgendaNotifications(state)) =
                    result.outcome
                {
                    if !self.loaded {
                        self.journal_vault = state.vault_id;
                        self.snoozed = state
                            .snoozed
                            .into_iter()
                            .map(|alert| (alert.id.clone(), alert))
                            .collect();
                        self.loaded = true;
                    }
                    let needed = self
                        .last
                        .as_ref()
                        .is_some_and(|plan| !plan.alerts.is_empty());
                    self.tell(
                        if needed && !state.allowed {
                            status::DENIED
                        } else {
                            status::READY
                        },
                        ctx,
                    );
                    for action in state.pending {
                        self.pending.insert(action.action_id.clone(), action);
                    }
                    self.refresh(ctx)
                } else {
                    self.last = None;
                    self.tell(status::FAILED, ctx);
                    Vec::new()
                }
            }
            Some(E::ScreenOpened(opened)) => {
                if let Some(topic) = self.status {
                    ctx.post(
                        &opened.screen,
                        wire::ScreenEvent {
                            kind: Some(E::Announced(wire::Announced {
                                topic: topic.into(),
                            })),
                        },
                    );
                }
                Vec::new()
            }
            Some(E::Announced(announced)) if announced.topic == status::RETRY => {
                self.last = None;
                self.refresh(ctx)
            }
            Some(E::ShellFact(fact)) => {
                if let Some(wire::shell_fact::Fact::AgendaNotification(action)) = fact.fact {
                    self.pending.insert(action.action_id.clone(), action);
                    self.refresh(ctx)
                } else {
                    Vec::new()
                }
            }
            Some(E::Lifecycle(lifecycle)) => {
                self.foreground = lifecycle.foreground;
                if self.foreground {
                    self.last = None;
                }
                self.refresh(ctx)
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_) | E::TimerFired(_)) => {
                self.refresh(ctx)
            }
            _ => Vec::new(),
        }
    }
    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn alert(id: &str, at: i64) -> wire::AgendaAlert {
        wire::AgendaAlert {
            id: id.into(),
            fire_at_ms: at,
            source_stamp: "revision1".into(),
            ..Default::default()
        }
    }
    #[test]
    fn only_future_alerts_are_sorted_and_capacity_is_shared() {
        let mut alerts: Vec<_> = (0..100).rev().map(|n| alert(&n.to_string(), n)).collect();
        alerts.push(alert("overdue", -100));
        let scheduled = plan(&alerts, &mut BTreeMap::new(), &[], 10);
        assert_eq!(scheduled.len(), CAPACITY);
        assert_eq!(scheduled.first().map(|a| a.fire_at_ms), Some(11));
        assert_eq!(scheduled.last().map(|a| a.fire_at_ms), Some(70));
    }
    #[test]
    fn completion_deletion_and_edits_cancel_snoozes() {
        let source = wire::AgendaAlertSource {
            source_stamp: "revision1".into(),
            ..Default::default()
        };
        let mut snoozed = BTreeMap::from([("a".into(), alert("a", 500))]);
        assert_eq!(
            plan(
                &[alert("a", 1)],
                &mut snoozed,
                std::slice::from_ref(&source),
                10
            )[0]
            .fire_at_ms,
            500
        );
        let mut edited = alert("a", 1);
        edited.source_stamp = "revision2".into();
        assert!(
            plan(
                &[edited],
                &mut snoozed,
                &[wire::AgendaAlertSource {
                    source_stamp: "revision2".into(),
                    ..source
                }],
                10
            )
            .is_empty()
        );
        assert!(snoozed.is_empty());
        snoozed.insert("a".into(), alert("a", 500));
        assert!(plan(&[], &mut snoozed, &[], 10).is_empty());
        assert!(snoozed.is_empty());
    }
}

#[cfg(test)]
#[path = "notifications_tests.rs"]
mod service_tests;
