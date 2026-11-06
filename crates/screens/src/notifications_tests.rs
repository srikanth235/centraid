//! Scheduler replay and isolation through its real screen context.
use super::*;
use centraid_core::screens::ScreenCtx;
use centraid_core::vaults::{HeldVault, Vaults};
use centraid_core::{Handle, Result};
use std::cell::{Cell, RefCell};
use std::sync::{Arc, Mutex};

struct Shelf(Mutex<String>);
impl Vaults for Shelf {
    fn foreground_id(&self) -> Option<String> {
        Some(self.0.lock().expect("front").clone())
    }
    fn foreground_core(&self) -> Option<Handle> {
        None
    }
    fn held(&self) -> Vec<HeldVault> {
        Vec::new()
    }
    fn core_of(&self, _: &str) -> Option<Handle> {
        None
    }
    fn awake(&self) -> Vec<Handle> {
        Vec::new()
    }
    fn holdings(&self) -> wire::Holdings {
        wire::Holdings::default()
    }
    fn bring_to_front(&self, id: &str) -> bool {
        *self.0.lock().expect("front") = id.to_owned();
        true
    }
    fn freeze(&self, _: &str, _: &str, _: u64) {}
    fn close_all(&self) {}
}
struct Door {
    shelf: Arc<Shelf>,
    alerts: RefCell<Vec<wire::AgendaAlert>>,
    acts: RefCell<Vec<wire::ActRequest>>,
    sources: RefCell<Option<Vec<wire::AgendaAlertSource>>>,
    refused: Cell<bool>,
    shelf_ready: Cell<bool>,
    deny_writes: Cell<bool>,
    fail_after_write: Cell<bool>,
}
impl Door {
    fn new() -> Self {
        Self {
            shelf: Arc::new(Shelf(Mutex::new("vault-a".into()))),
            alerts: RefCell::new(vec![wire::AgendaAlert {
                id: "alert-a".into(),
                entity_id: "same-task-id".into(),
                fire_at_ms: 10_000,
                source_stamp: "revision1".into(),
                task: true,
                ..Default::default()
            }]),
            acts: RefCell::new(Vec::new()),
            sources: RefCell::new(None),
            refused: Cell::new(false),
            shelf_ready: Cell::new(true),
            deny_writes: Cell::new(false),
            fail_after_write: Cell::new(false),
        }
    }
}
impl ScreenCtx for Door {
    fn load(&self, request: &wire::LoadRequest) -> Result<wire::LoadResponse> {
        if request.query == "holdings" {
            return Ok(wire::LoadResponse {
                answer: Some(wire::AppQueryResponse {
                    answer: Some(wire::app_query_response::Answer::Holdings(wire::Holdings {
                        loaded: self.shelf_ready.get(),
                        foreground: self.shelf.foreground_id().unwrap_or_default(),
                        ..Default::default()
                    })),
                }),
                tables: vec!["shelf".into()],
            });
        }
        if self.refused.get() {
            return Err(centraid_core::CoreError::Unavailable {
                reason: "read failed".into(),
            });
        }
        Ok(wire::LoadResponse {
            answer: Some(wire::AppQueryResponse {
                answer: Some(wire::app_query_response::Answer::AgendaAlerts(
                    wire::AgendaAlerts {
                        now_ms: 1_000,
                        alerts: self.alerts.borrow().clone(),
                        sources: self.sources.borrow().clone().unwrap_or_else(|| {
                            self.alerts
                                .borrow()
                                .iter()
                                .map(|alert| wire::AgendaAlertSource {
                                    entity_id: alert.entity_id.clone(),
                                    source_stamp: alert.source_stamp.clone(),
                                    task: alert.task,
                                    title: alert.title.clone(),
                                })
                                .collect()
                        }),
                    },
                )),
            }),
            tables: vec![
                "task".into(),
                "entity".into(),
                "event".into(),
                "occurrence".into(),
            ],
        })
    }
    fn act(&self, request: &wire::ActRequest) -> Result<wire::ActResponse> {
        self.acts.borrow_mut().push(request.clone());
        if self.deny_writes.get() {
            return Ok(wire::ActResponse {
                status: wire::ActStatus::Refused as i32,
                reason: "The vault moved.".into(),
                ..Default::default()
            });
        }
        self.alerts.borrow_mut().clear();
        self.sources.borrow_mut().take();
        if self.fail_after_write.get() {
            self.refused.set(true);
        }
        Ok(wire::ActResponse {
            status: wire::ActStatus::Executed as i32,
            ..Default::default()
        })
    }
    fn push(&self, _: wire::ScreenUpdate) {}
    fn wake_after(&self, _: Duration) {}
    fn vaults(&self) -> Option<Arc<dyn Vaults>> {
        Some(self.shelf.clone())
    }
}
fn action(kind: wire::agenda_notification_action::Kind) -> wire::AgendaNotificationAction {
    wire::AgendaNotificationAction {
        action_id: "one-gesture".into(),
        vault_id: "vault-a".into(),
        alert_id: "alert-a".into(),
        kind: kind as i32,
        at_ms: 1_000,
        entity_id: "same-task-id".into(),
        source_stamp: "revision1".into(),
    }
}
fn loaded(state: wire::AgendaNotificationState) -> wire::ScreenEvent {
    wire::ScreenEvent {
        kind: Some(wire::screen_event::Kind::EffectResult(wire::EffectResult {
            effect_id: 1,
            outcome: Some(wire::effect_result::Outcome::AgendaNotifications(state)),
        })),
    }
}
fn sync(effects: Vec<wire::Effect>) -> wire::AgendaNotificationSync {
    let Some(wire::effect::Kind::AgendaNotifications(sync)) =
        effects.into_iter().next().and_then(|e| e.kind)
    else {
        panic!("a replacement plan")
    };
    sync
}

#[test]
fn done_commits_with_a_durable_replay_key_and_a_restart_acknowledges_without_writing_again() {
    let door = Door::new();
    let env = crate::Environment::default();
    let ctx = Ctx::new(&door, &env);
    let state = wire::AgendaNotificationState {
        vault_id: "vault-a".into(),
        pending: vec![action(wire::agenda_notification_action::Kind::Done)],
        ..Default::default()
    };
    let first = sync(Service::default().update(loaded(state.clone()), &ctx));
    assert!(first.alerts.is_empty());
    assert_eq!(first.acknowledge, ["one-gesture"]);
    assert_eq!(door.acts.borrow()[0].action, "complete-task");
    assert_eq!(door.acts.borrow()[0].invoke_key, "notification:one-gesture");
    let restarted = sync(Service::default().update(loaded(state), &ctx));
    assert_eq!(restarted.acknowledge, ["one-gesture"]);
    assert_eq!(
        door.acts.borrow().len(),
        1,
        "the entity no longer exists as open work"
    );
}

#[test]
fn a_vault_switch_cancels_old_snoozes_and_discards_old_actions_even_when_entity_ids_match() {
    let door = Door::new();
    door.shelf.bring_to_front("vault-b");
    let env = crate::Environment::default();
    let ctx = Ctx::new(&door, &env);
    let mut snooze = door.alerts.borrow()[0].clone();
    snooze.fire_at_ms = 99_000;
    let plan = sync(Service::default().update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            snoozed: vec![snooze],
            pending: vec![action(wire::agenda_notification_action::Kind::Done)],
            ..Default::default()
        }),
        &ctx,
    ));
    assert_eq!(plan.vault_id, "vault-b");
    assert!(plan.snoozed.is_empty());
    assert_eq!(plan.alerts[0].fire_at_ms, 10_000);
    assert!(door.acts.borrow().is_empty());
    assert_eq!(plan.acknowledge, ["one-gesture"]);
}

#[test]
fn a_snooze_survives_restart_but_an_edit_cancels_it() {
    let door = Door::new();
    let env = crate::Environment::default();
    let ctx = Ctx::new(&door, &env);
    let first = sync(Service::default().update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            pending: vec![action(wire::agenda_notification_action::Kind::Hour)],
            ..Default::default()
        }),
        &ctx,
    ));
    assert_eq!(first.alerts[0].fire_at_ms, 3_601_000);
    assert_eq!(first.snoozed.len(), 1);
    let mut restarted = Service::default();
    let again = sync(restarted.update(
        loaded(wire::AgendaNotificationState {
            vault_id: first.vault_id,
            snoozed: first.snoozed,
            ..Default::default()
        }),
        &ctx,
    ));
    assert_eq!(again.alerts[0].fire_at_ms, 3_601_000);
    door.alerts.borrow_mut()[0].source_stamp = "revision2".into();
    let edited = sync(restarted.refresh(&ctx));
    assert_eq!(edited.alerts[0].fire_at_ms, 10_000);
    assert!(edited.snoozed.is_empty());
}

#[test]
fn a_failed_read_preserves_the_current_plan_but_never_preserves_another_vaults_plan() {
    let door = Door::new();
    let env = crate::Environment::default();
    let ctx = Ctx::new(&door, &env);
    let mut service = Service::default();
    let _ = service.update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            ..Default::default()
        }),
        &ctx,
    );
    door.refused.set(true);
    assert!(service.refresh(&ctx).is_empty());
    door.refused.set(false);
    assert!(
        !service.refresh(&ctx).is_empty(),
        "a recovered read reapplies the previously unchanged plan"
    );
    door.refused.set(true);
    door.shelf.bring_to_front("vault-b");
    let switched = sync(service.refresh(&ctx));
    assert_eq!(switched.vault_id, "vault-b");
    assert!(switched.alerts.is_empty());
    assert!(switched.sources.is_empty());
}

#[test]
fn a_stale_source_action_is_acknowledged_without_touching_the_edited_task() {
    let door = Door::new();
    let env = crate::Environment::default();
    let ctx = Ctx::new(&door, &env);
    door.alerts.borrow_mut()[0].source_stamp = "edited".into();
    let plan = sync(Service::default().update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            pending: vec![action(wire::agenda_notification_action::Kind::Done)],
            ..Default::default()
        }),
        &ctx,
    ));
    assert_eq!(plan.acknowledge, ["one-gesture"]);
    assert!(door.acts.borrow().is_empty());
    assert_eq!(plan.alerts.len(), 1);
}

#[test]
fn permission_denial_has_a_settings_remedy_and_foreground_reapplies_after_a_grant() {
    let door = Door::new();
    let env = crate::Environment::default();
    let ctx = Ctx::new(&door, &env);
    let mut service = Service::default();
    let _ = service.update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            ..Default::default()
        }),
        &ctx,
    );
    let _ = service.update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            allowed: false,
            ..Default::default()
        }),
        &ctx,
    );
    assert_eq!(service.status, Some(status::DENIED));
    let mut shown = status::Status::default();
    shown.hear(status::DENIED);
    assert_eq!(
        shown.view(ctx.locale()).expect("status").action_label,
        "Settings"
    );
    assert!(matches!(
        shown.act(&ctx)[0].kind,
        Some(wire::effect::Kind::VaultCommand(_))
    ));
    let foreground = wire::ScreenEvent {
        kind: Some(wire::screen_event::Kind::Lifecycle(wire::AppLifecycle {
            foreground: true,
        })),
    };
    assert!(!service.update(foreground.clone(), &ctx).is_empty());
    let _ = service.update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            allowed: true,
            ..Default::default()
        }),
        &ctx,
    );
    assert_eq!(service.status, Some(status::READY));
    assert!(
        !service.update(foreground, &ctx).is_empty(),
        "an unchanged plan still reads changed OS permission"
    );
}

#[test]
fn launch_waits_for_the_shelf_before_acknowledging_or_discarding_a_background_tap() {
    let door = Door::new();
    door.shelf_ready.set(false);
    let env = crate::Environment::default();
    let ctx = Ctx::new(&door, &env);
    let mut service = Service::default();
    assert!(
        service
            .update(
                loaded(wire::AgendaNotificationState {
                    vault_id: "vault-a".into(),
                    pending: vec![action(wire::agenda_notification_action::Kind::Done)],
                    ..Default::default()
                }),
                &ctx
            )
            .is_empty()
    );
    assert_eq!(service.pending.len(), 1);
    assert!(door.acts.borrow().is_empty());
    door.shelf_ready.set(true);
    let plan = sync(service.refresh(&ctx));
    assert_eq!(plan.acknowledge, ["one-gesture"]);
    assert_eq!(door.acts.borrow().len(), 1);
}

#[test]
fn a_refused_done_stays_pending_and_exposes_retry_until_the_write_commits() {
    let door = Door::new();
    door.deny_writes.set(true);
    let env = crate::Environment::default();
    let ctx = Ctx::new(&door, &env);
    let mut service = Service::default();
    let first = sync(service.update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            pending: vec![action(wire::agenda_notification_action::Kind::Done)],
            ..Default::default()
        }),
        &ctx,
    ));
    assert!(first.acknowledge.is_empty());
    assert_eq!(service.pending.len(), 1);
    assert_eq!(service.status, Some(status::FAILED));
    door.deny_writes.set(false);
    let retried = sync(service.refresh(&ctx));
    assert_eq!(retried.acknowledge, ["one-gesture"]);
    assert!(service.pending.is_empty());
}

#[test]
fn a_committed_done_cancels_every_source_alarm_even_when_the_follow_up_read_fails() {
    let door = Door::new();
    door.fail_after_write.set(true);
    let mut second = door.alerts.borrow()[0].clone();
    second.id = "another-lead-for-the-same-task".into();
    door.alerts.borrow_mut().push(second);
    let env = crate::Environment::default();
    let ctx = Ctx::new(&door, &env);
    let mut service = Service::default();
    let plan = sync(service.update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            pending: vec![action(wire::agenda_notification_action::Kind::Done)],
            ..Default::default()
        }),
        &ctx,
    ));
    assert_eq!(plan.acknowledge, ["one-gesture"]);
    assert!(plan.alerts.is_empty());
    assert!(plan.sources.is_empty());
    assert_eq!(service.status, Some(status::FAILED));
    assert_eq!(door.acts.borrow().len(), 1);
}

fn only_delivered_source(door: &Door, task: bool) {
    door.alerts.borrow_mut().clear();
    *door.sources.borrow_mut() = Some(vec![wire::AgendaAlertSource {
        entity_id: "same-task-id".into(),
        source_stamp: "revision1".into(),
        task,
        title: "A delivered reminder".into(),
    }]);
}

#[test]
fn a_delivered_task_done_survives_restart_without_a_future_candidate() {
    let door = Door::new();
    only_delivered_source(&door, true);
    let env = crate::Environment::default();
    let ctx = Ctx::new(&door, &env);
    let plan = sync(Service::default().update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            pending: vec![action(wire::agenda_notification_action::Kind::Done)],
            ..Default::default()
        }),
        &ctx,
    ));
    assert_eq!(door.acts.borrow().len(), 1);
    assert_eq!(plan.acknowledge, ["one-gesture"]);
    assert!(plan.alerts.is_empty());
    assert!(plan.sources.is_empty());
}

#[test]
fn a_delivered_event_snoozes_and_restarts_without_remaining_in_the_future_window() {
    let door = Door::new();
    only_delivered_source(&door, false);
    let env = crate::Environment::default();
    let ctx = Ctx::new(&door, &env);
    let first = sync(Service::default().update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            pending: vec![action(wire::agenda_notification_action::Kind::Hour)],
            ..Default::default()
        }),
        &ctx,
    ));
    assert_eq!(first.alerts.len(), 1);
    assert_eq!(first.alerts[0].title, "A delivered reminder");
    assert_eq!(first.alerts[0].fire_at_ms, 3_601_000);
    assert!(!first.alerts[0].task);
    assert_eq!(first.sources[0].source_stamp, "revision1");
    let mut restarted = Service::default();
    let replay = sync(restarted.update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            snoozed: first.snoozed,
            ..Default::default()
        }),
        &ctx,
    ));
    assert_eq!(replay.alerts[0].fire_at_ms, 3_601_000);
    door.sources.borrow_mut().as_mut().unwrap()[0].source_stamp = "edited".into();
    let edited = sync(restarted.refresh(&ctx));
    assert!(edited.alerts.is_empty());
    assert!(edited.snoozed.is_empty());
    assert_eq!(edited.sources[0].source_stamp, "edited");
    assert!(door.acts.borrow().is_empty());
}

#[test]
fn deleting_a_delivered_source_acknowledges_its_stale_action_without_a_write() {
    let door = Door::new();
    only_delivered_source(&door, true);
    door.sources.borrow_mut().as_mut().unwrap().clear();
    let env = crate::Environment::default();
    let ctx = Ctx::new(&door, &env);
    let plan = sync(Service::default().update(
        loaded(wire::AgendaNotificationState {
            vault_id: "vault-a".into(),
            pending: vec![action(wire::agenda_notification_action::Kind::Done)],
            ..Default::default()
        }),
        &ctx,
    ));
    assert_eq!(plan.acknowledge, ["one-gesture"]);
    assert!(plan.sources.is_empty());
    assert!(door.acts.borrow().is_empty());
}
