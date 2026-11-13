//! Independent black-box checks of the cold notification receipt protocol.
mod reminders_support;

use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda::notify;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::testing::{Driver, FakeShell};
use centraid_screens::{Screen, docs};
use centraid_vault::clock::FixedClock;
use reminders_support::*;
use wire::NotificationVerb as Verb;
use wire::screen_event::Kind as E;

const KEY: &str = "notification-receipt";

fn task_of_status(d: &Driver, id: &str) -> String {
    task_of(d, id).status
}

struct Rig {
    d: Driver,
    clock: Arc<FixedClock>,
    service: Box<dyn Screen>,
    shell: FakeShell,
    task: String,
    notice: String,
}

impl Rig {
    fn new() -> Self {
        let clock = Arc::new(FixedClock::frozen());
        let d = Driver::with_runtime_clocked(docs::runtime(), clock.clone());
        let tomorrow = day(&d, 1);
        let task = add(
            &d,
            act::reminders::AddTask {
                title: "Durable action".to_owned(),
                due: Field::Is(format!("{tomorrow}T09:00")),
                remind_before_min: Field::Is(0),
                ..Default::default()
            },
        );
        let mut r = Self {
            d,
            clock,
            service: notify::build(&notify::route()).expect("service"),
            shell: FakeShell::default(),
            task,
            notice: String::new(),
        };
        let effects = r.drive(E::Appeared(Default::default()));
        r.notice = notifications(&effects)
            .into_iter()
            .find(|n| n.notification_id.contains(&r.task))
            .expect("our timed task")
            .notification_id;
        r
    }

    fn raw(&mut self, kind: E) -> Vec<wire::Effect> {
        self.d.with_ctx(|ctx| {
            self.service
                .update(wire::ScreenEvent { kind: Some(kind) }, ctx)
        })
    }

    fn ack(&mut self, answer: wire::SecretBatched) -> Vec<wire::Effect> {
        self.raw(E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(wire::effect_result::Outcome::Secrets(answer)),
        }))
    }

    fn settle(&mut self, mut pending: Vec<wire::Effect>) -> Vec<wire::Effect> {
        let mut output = Vec::new();
        for _ in 0..24 {
            if pending.is_empty() {
                return output;
            }
            let mut next = Vec::new();
            for effect in pending {
                if let Some(wire::effect::Kind::Secrets(batch)) = &effect.kind {
                    let answer = self.shell.batch(batch);
                    next.extend(self.ack(answer));
                } else {
                    output.push(effect);
                }
            }
            pending = next;
        }
        panic!("receipt protocol exceeded its bounded operation count");
    }

    fn drive(&mut self, kind: E) -> Vec<wire::Effect> {
        let effects = self.raw(kind);
        self.settle(effects)
    }

    fn restart(&mut self) -> Vec<wire::Effect> {
        self.service =
            notify::build(&notify::route()).expect("new service, same vault and device store");
        self.drive(E::Appeared(Default::default()))
    }

    fn posted(&mut self, verb: Verb) -> wire::PendingNotification {
        let id = self.notice.clone();
        let effects = self.drive(button(&id, verb));
        notifications(&effects)
            .into_iter()
            .find(|n| n.immediate)
            .expect("receipt")
    }

    fn metadata(&self) -> serde_json::Value {
        serde_json::from_str(self.shell.device.get(KEY).expect("persisted metadata")).expect("JSON")
    }

    fn begin_undo(&mut self, receipt: &str) -> Vec<wire::Effect> {
        let effects = self.raw(button(receipt, Verb::Undo));
        assert!(
            notifications(&effects).is_empty(),
            "no offer before durable intent acknowledgement"
        );
        let batch = secret(&effects, wire::secret_op::Op::Set);
        let answer = self.shell.batch(&batch);
        self.ack(answer)
    }
}

fn button(id: &str, verb: Verb) -> E {
    E::ShellFact(wire::ShellFact {
        fact: Some(wire::shell_fact::Fact::NotificationAnswered(
            wire::NotificationAnswered {
                notification_id: id.to_owned(),
                verb: verb as i32,
                press_id: String::new(),
            },
        )),
    })
}

fn notifications(effects: &[wire::Effect]) -> Vec<wire::PendingNotification> {
    effects
        .iter()
        .filter_map(|e| match &e.kind {
            Some(wire::effect::Kind::ScheduleNotifications(set)) => Some(set.all.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

fn secret(effects: &[wire::Effect], op: wire::secret_op::Op) -> wire::SecretBatch {
    let batch = effects
        .iter()
        .find_map(|e| match &e.kind {
            Some(wire::effect::Kind::Secrets(batch)) => Some(batch.clone()),
            _ => None,
        })
        .expect("one secret operation");
    assert_eq!(batch.ops.len(), 1);
    assert_eq!(batch.ops[0].op, op as i32);
    assert_eq!(batch.ops[0].key, KEY);
    assert_eq!(batch.ops[0].store, wire::SecretStore::Device as i32);
    batch
}

#[test]
fn original_deadline_survives_restart_and_expires_at_the_exact_boundary() {
    let mut r = Rig::new();
    let receipt = r.posted(Verb::Done);
    let original = r.metadata();
    assert_eq!(
        original["expires"].as_i64().unwrap() - original["created"].as_i64().unwrap(),
        600_000
    );
    r.clock.advance_ms(599_999);
    assert!(
        notifications(&r.restart())
            .iter()
            .any(|n| n.notification_id == receipt.notification_id)
    );
    assert_eq!(
        r.metadata(),
        original,
        "restart does not renew the deadline"
    );
    r.clock.advance_ms(1);
    assert!(notifications(&r.restart()).iter().all(|n| !n.immediate));
    assert!(!r.shell.device.contains_key(KEY));
    r.drive(button(&receipt.notification_id, Verb::Undo));
    assert_eq!(task_of_status(&r.d, &r.task), "done");
}

#[test]
fn failed_and_truncated_get_wait_without_consuming_the_cold_undo() {
    for truncated in [false, true] {
        let mut r = Rig::new();
        let receipt = r.posted(Verb::Done);
        r.service = notify::build(&notify::route()).expect("restart");
        let pending = r.raw(E::Appeared(Default::default()));
        secret(&pending, wire::secret_op::Op::Get);
        assert!(
            r.raw(button(&receipt.notification_id, Verb::Undo))
                .is_empty()
        );
        let bad = if truncated {
            wire::SecretBatched { answers: vec![] }
        } else {
            wire::SecretBatched {
                answers: vec![wire::SecretAnswer::default()],
            }
        };
        assert!(notifications(&r.ack(bad)).is_empty());
        assert_eq!(task_of_status(&r.d, &r.task), "done");
        r.drive(E::DataChanged(Default::default()));
        assert_eq!(
            task_of_status(&r.d, &r.task),
            "open",
            "FIFO retained the unprocessed Undo"
        );
    }
}

#[test]
fn failed_effect_get_is_retryable_and_failed_set_never_advertises_undo() {
    let mut r = Rig::new();
    let receipt = r.posted(Verb::Done);
    r.service = notify::build(&notify::route()).expect("restart");
    r.raw(E::Appeared(Default::default()));
    r.raw(button(&receipt.notification_id, Verb::Undo));
    let effects = r.raw(E::EffectResult(wire::EffectResult {
        effect_id: 0,
        outcome: Some(wire::effect_result::Outcome::Failed(
            wire::EffectFailed::default(),
        )),
    }));
    assert!(notifications(&effects).is_empty());
    r.drive(E::DataChanged(Default::default()));
    assert_eq!(task_of_status(&r.d, &r.task), "open");

    for answers in [vec![], vec![wire::SecretAnswer::default()]] {
        let mut r = Rig::new();
        let id = r.notice.clone();
        let pending = r.raw(button(&id, Verb::Done));
        let set = secret(&pending, wire::secret_op::Op::Set);
        // Even a write whose reply failed may have reached storage. Cleanup must remove it.
        drop(r.shell.batch(&set));
        assert!(notifications(&pending).is_empty());
        let effects = r.ack(wire::SecretBatched { answers });
        let effects = r.settle(effects);
        assert!(
            notifications(&effects)
                .iter()
                .all(|n| n.category_id != "receipt")
        );
        assert!(!r.shell.device.contains_key(KEY));
        assert_eq!(task_of_status(&r.d, &r.task), "done");
    }
}

#[test]
fn malformed_or_foreign_metadata_cannot_restore_an_undo() {
    for foreign in [false, true] {
        let mut r = Rig::new();
        let receipt = r.posted(Verb::Done);
        let value = if foreign {
            let mut meta = r.metadata();
            meta["vault"] = "another-vault".into();
            meta["id"] = "receipt|another-vault|123".into();
            meta.to_string()
        } else {
            "{truncated".to_owned()
        };
        r.shell.device.insert(KEY.to_owned(), value);
        assert!(
            notifications(&r.restart())
                .iter()
                .all(|n| n.category_id != "receipt")
        );
        r.drive(button(&receipt.notification_id, Verb::Undo));
        assert_eq!(task_of_status(&r.d, &r.task), "done");
    }
}

#[test]
fn only_the_exact_current_receipt_can_undo_and_a_later_title_is_preserved() {
    let mut r = Rig::new();
    let receipt = r.posted(Verb::Done);
    r.restart();
    let before = r.metadata();
    r.drive(button(&format!("{}7", receipt.notification_id), Verb::Undo));
    assert_eq!(r.metadata(), before);
    assert_eq!(task_of_status(&r.d, &r.task), "done");
    arrange(
        &r.d,
        act::reminders::EditTask {
            task_id: r.task.clone(),
            title: Some("Later title".to_owned()),
            ..Default::default()
        },
    );
    r.drive(button(&receipt.notification_id, Verb::Undo));
    assert_eq!(task_of_status(&r.d, &r.task), "open");
    assert_eq!(task_of(&r.d, &r.task).title, "Later title");
}

#[test]
fn a_later_conflicting_snooze_is_not_overwritten_by_snooze_undo() {
    let mut r = Rig::new();
    let receipt = r.posted(Verb::SnoozeHour);
    let later = format!("{}T18:30", day(&r.d, 2));
    arrange(
        &r.d,
        act::reminders::EditTask {
            task_id: r.task.clone(),
            snoozed_until: Field::Is(format!("{later}:00Z")),
            ..Default::default()
        },
    );
    let before = task_of(&r.d, &r.task);
    r.restart();
    r.drive(button(&receipt.notification_id, Verb::Undo));
    assert_eq!(task_of(&r.d, &r.task), before);
}

#[test]
fn a_replaced_receipt_cannot_undo_either_tasks_later_action() {
    let mut r = Rig::new();
    let first = r.posted(Verb::Done);
    let other = add(
        &r.d,
        act::reminders::AddTask {
            title: "Second durable action".to_owned(),
            due: Field::Is(format!("{}T10:00", day(&r.d, 1))),
            remind_before_min: Field::Is(0),
            ..Default::default()
        },
    );
    let changed = r.drive(E::DataChanged(Default::default()));
    let other_notice = notifications(&changed)
        .into_iter()
        .find(|n| n.notification_id.contains(&other))
        .expect("second task")
        .notification_id;
    let effects = r.drive(button(&other_notice, Verb::Done));
    let second = notifications(&effects)
        .into_iter()
        .find(|n| n.immediate)
        .expect("new receipt");
    assert_ne!(first.notification_id, second.notification_id);
    let current = r.metadata();
    r.restart();
    r.drive(button(&first.notification_id, Verb::Undo));
    assert_eq!(task_of_status(&r.d, &r.task), "done");
    assert_eq!(task_of_status(&r.d, &other), "done");
    assert_eq!(
        r.metadata(),
        current,
        "an old receipt must not erase the current one"
    );
    r.drive(button(&second.notification_id, Verb::Undo));
    assert_eq!(task_of_status(&r.d, &other), "open");
    assert_eq!(task_of_status(&r.d, &r.task), "done");
}

#[test]
fn a_later_status_decision_is_not_overwritten_by_the_old_receipt() {
    let mut r = Rig::new();
    let receipt = r.posted(Verb::Done);
    arrange(
        &r.d,
        act::reminders::ReopenTask {
            task_id: r.task.clone(),
        },
    );
    complete(&r.d, &r.task);
    let before = task_of(&r.d, &r.task);
    r.restart();
    r.drive(button(&receipt.notification_id, Verb::Undo));
    assert_eq!(
        task_of(&r.d, &r.task),
        before,
        "a later Done must remain the member's decision"
    );
}

#[test]
fn committed_undo_and_failed_delete_replay_the_same_key_only_once() {
    let mut r = Rig::new();
    let receipt = r.posted(Verb::Done);
    let pending_delete = r.begin_undo(&receipt.notification_id);
    secret(&pending_delete, wire::secret_op::Op::Delete);
    assert_eq!(task_of_status(&r.d, &r.task), "open");
    r.ack(wire::SecretBatched {
        answers: vec![wire::SecretAnswer::default()],
    });
    complete(&r.d, &r.task);
    let before = task_of(&r.d, &r.task);
    r.restart();
    assert_eq!(
        task_of(&r.d, &r.task),
        before,
        "no second inverse after crash"
    );
    assert!(!r.shell.device.contains_key(KEY));
}

#[test]
fn accepted_intent_crashes_on_either_side_of_inverse_clear_only_after_expiry() {
    for inverse_committed in [false, true] {
        let mut r = Rig::new();
        let receipt = r.posted(Verb::Done);
        if inverse_committed {
            let pending = r.begin_undo(&receipt.notification_id);
            secret(&pending, wire::secret_op::Op::Delete);
        } else {
            let pending = r.raw(button(&receipt.notification_id, Verb::Undo));
            let set = secret(&pending, wire::secret_op::Op::Set);
            drop(r.shell.batch(&set)); // persisted, then process exits before receiving the acknowledgement
            assert_eq!(task_of_status(&r.d, &r.task), "done");
        }
        assert!(r.metadata()["undo_requested_at"].is_i64());
        r.clock.advance_ms(600_000);
        let before = task_of(&r.d, &r.task);
        let effects = r.restart();
        assert_eq!(
            task_of(&r.d, &r.task),
            before,
            "expired acceptance must not apply an inverse"
        );
        assert!(!r.shell.device.contains_key(KEY));
        assert!(notifications(&effects).iter().all(|n| !n.immediate));
    }
}

fn completed(effects: &[wire::Effect]) -> Vec<wire::NotificationAnswered> {
    effects
        .iter()
        .filter_map(|e| match &e.kind {
            Some(wire::effect::Kind::ScheduleNotifications(set)) => {
                Some(set.completed_answers.clone())
            }
            _ => None,
        })
        .flatten()
        .collect()
}

fn os_reply(delivered: Vec<wire::DeliveredNotification>) -> E {
    E::EffectResult(wire::EffectResult {
        effect_id: 0,
        outcome: Some(wire::effect_result::Outcome::NotificationsScheduled(
            wire::NotificationsScheduled {
                permission: wire::NotificationPermission::Granted as i32,
                delivered,
                ..Default::default()
            },
        )),
    })
}

#[test]
fn action_completion_waits_for_receipt_ack_and_undo_completion_waits_for_cleanup_ack() {
    let mut r = Rig::new();
    assert!(
        completed(&r.restart()).is_empty(),
        "bootstrap is not an action acknowledgement"
    );
    let id = r.notice.clone();
    let writing = r.raw(button(&id, Verb::Done));
    assert_eq!(task_of_status(&r.d, &r.task), "done");
    assert!(completed(&writing).is_empty());
    assert!(
        completed(&r.raw(os_reply(Vec::new()))).is_empty(),
        "an unrelated OS schedule cannot complete this write"
    );
    let batch = secret(&writing, wire::secret_op::Op::Set);
    let answer = r.shell.batch(&batch);
    let committed = r.ack(answer);
    assert_eq!(
        completed(&committed),
        vec![wire::NotificationAnswered {
            notification_id: id,
            verb: Verb::Done as i32,
            press_id: String::new(),
        }]
    );
    let receipt = notifications(&committed)
        .into_iter()
        .find(|n| n.immediate)
        .expect("durable receipt");

    let intent = r.raw(button(&receipt.notification_id, Verb::Undo));
    assert!(completed(&intent).is_empty());
    let batch = secret(&intent, wire::secret_op::Op::Set);
    let answer = r.shell.batch(&batch);
    let inverse = r.ack(answer);
    assert_eq!(task_of_status(&r.d, &r.task), "open");
    assert!(
        completed(&inverse).is_empty(),
        "persisted Undo intent is not its terminal acknowledgement"
    );
    assert!(completed(&r.raw(os_reply(Vec::new()))).is_empty());
    let batch = secret(&inverse, wire::secret_op::Op::Delete);
    let answer = r.shell.batch(&batch);
    let cleared = r.ack(answer);
    assert_eq!(
        completed(&cleared),
        vec![wire::NotificationAnswered {
            notification_id: receipt.notification_id,
            verb: Verb::Undo as i32,
            press_id: String::new(),
        }]
    );
    assert!(
        completed(&r.raw(os_reply(Vec::new()))).is_empty(),
        "completion is drained exactly once"
    );
}

#[test]
fn failed_receipt_write_completes_only_after_the_partial_write_is_cleared() {
    let mut r = Rig::new();
    let id = r.notice.clone();
    let writing = r.raw(button(&id, Verb::Done));
    secret(&writing, wire::secret_op::Op::Set);
    let failed = r.ack(wire::SecretBatched::default());
    assert!(completed(&failed).is_empty());
    let batch = secret(&failed, wire::secret_op::Op::Delete);
    let answer = r.shell.batch(&batch);
    let cleared = r.ack(answer);
    assert!(notifications(&cleared).iter().all(|n| !n.immediate));
    assert_eq!(
        completed(&cleared),
        vec![wire::NotificationAnswered {
            notification_id: id,
            verb: Verb::Done as i32,
            press_id: String::new(),
        }]
    );
}

fn past_notice(r: &mut Rig) -> wire::PendingNotification {
    let old_day = day(&r.d, -5);
    arrange(
        &r.d,
        act::reminders::EditTask {
            task_id: r.task.clone(),
            due: Field::Is(format!("{old_day}T09:00")),
            remind_before_min: Field::Is(0),
            ..Default::default()
        },
    );
    let task = task_of(&r.d, &r.task);
    let old_now = format!("{old_day}T00:00");
    let notice = notify::desired(&notify::Inputs {
        vault_id: "",
        zone: "UTC",
        locale: centraid_screens::strings::Locale::En,
        hour_cycle: centraid_screens::kit::civil::HourCycle::H24,
        now_local: &old_now,
        tasks: &[task],
        projects: &[],
        events: &[],
        calendars: &[],
        extra: &[],
        extra_wanted: &[],
    })
    .into_iter()
    .next()
    .expect("the original past reminder");
    let changed = r.drive(E::DataChanged(Default::default()));
    assert!(
        !notifications(&changed)
            .iter()
            .any(|n| n.notification_id == notice.notification_id)
    );
    notice
}

#[test]
fn a_past_delivered_card_outside_the_future_read_can_still_complete_and_undo_its_task() {
    let mut r = Rig::new();
    let notice = past_notice(&mut r);
    let before = task_of(&r.d, &r.task).due_at;
    let receipt = r.drive(button(&notice.notification_id, Verb::Done));
    assert_eq!(task_of_status(&r.d, &r.task), "done");
    assert_eq!(
        completed(&receipt)[0].notification_id,
        notice.notification_id
    );
    let receipt = notifications(&receipt)
        .into_iter()
        .find(|n| n.immediate)
        .expect("receipt for exact past task");
    let undone = r.drive(button(&receipt.notification_id, Verb::Undo));
    assert_eq!(task_of_status(&r.d, &r.task), "open");
    assert_eq!(task_of(&r.d, &r.task).due_at, before);
    assert_eq!(completed(&undone)[0].verb, Verb::Undo as i32);
}

#[test]
fn past_inventory_survives_refresh_and_a_source_change_cancels_once_without_reply_spin() {
    let mut r = Rig::new();
    let notice = past_notice(&mut r);
    let delivered = vec![wire::DeliveredNotification {
        notification_id: notice.notification_id.clone(),
        source_fingerprint: notice.source_fingerprint,
    }];
    assert!(
        r.raw(os_reply(delivered.clone())).is_empty(),
        "a valid delivered card is retained without a future-window repost"
    );
    let refresh = r.drive(E::Lifecycle(wire::AppLifecycle { foreground: true }));
    let set = refresh
        .iter()
        .find_map(|e| match &e.kind {
            Some(wire::effect::Kind::ScheduleNotifications(s)) => Some(s),
            _ => None,
        })
        .expect("foreground reconciliation");
    assert!(set.retain_delivered);
    assert!(set.cancel_delivered_ids.is_empty());
    assert!(
        !set.all
            .iter()
            .any(|n| n.notification_id == notice.notification_id)
    );
    arrange(
        &r.d,
        act::reminders::EditTask {
            task_id: r.task.clone(),
            title: Some("Changed alert".to_owned()),
            ..Default::default()
        },
    );
    let changed = r.drive(E::DataChanged(Default::default()));
    let set = changed
        .iter()
        .find_map(|e| match &e.kind {
            Some(wire::effect::Kind::ScheduleNotifications(s)) => Some(s),
            _ => None,
        })
        .expect("explicit cancellation");
    assert_eq!(set.cancel_delivered_ids, vec![notice.notification_id]);
    assert!(
        r.raw(os_reply(delivered)).is_empty(),
        "identical cancellation reply must not spin"
    );
    assert!(
        r.raw(os_reply(Vec::new())).is_empty(),
        "observing the removal requires no redundant schedule"
    );
}

#[test]
fn an_outbox_replay_keeps_the_original_deadline_and_acks_the_exact_press_id() {
    let mut r = Rig::new();
    let answer = wire::NotificationAnswered {
        notification_id: r.notice.clone(),
        verb: Verb::Done as i32,
        press_id: "original-press".to_owned(),
    };
    let event = || {
        E::ShellFact(wire::ShellFact {
            fact: Some(wire::shell_fact::Fact::NotificationAnswered(answer.clone())),
        })
    };
    let initial = r.drive(event());
    assert_eq!(completed(&initial), vec![answer.clone()]);
    let before = r.metadata();
    let original_receipt = notifications(&initial)
        .into_iter()
        .find(|n| n.immediate)
        .expect("durable receipt");
    r.restart();
    let replayed = r.drive(event());
    assert_eq!(completed(&replayed), vec![answer]);
    assert_eq!(
        r.metadata(),
        before,
        "outbox replay must not renew or replace Undo"
    );
    assert_eq!(
        notifications(&replayed)
            .into_iter()
            .find(|n| n.immediate)
            .expect("same receipt")
            .notification_id,
        original_receipt.notification_id
    );
    assert_eq!(task_of_status(&r.d, &r.task), "done");
    r.drive(button(&original_receipt.notification_id, Verb::Undo));
    assert_eq!(task_of_status(&r.d, &r.task), "open");
}

#[test]
fn snooze_undo_preserves_a_later_unrelated_due_edit() {
    let mut r = Rig::new();
    let original = task_of(&r.d, &r.task);
    let receipt = r.posted(Verb::SnoozeHour);
    assert_eq!(task_of(&r.d, &r.task).due_at, original.due_at);
    let due = format!("{}T18:30", day(&r.d, 2));
    arrange(
        &r.d,
        act::reminders::EditTask {
            task_id: r.task.clone(),
            due: Field::Is(due.clone()),
            ..Default::default()
        },
    );
    r.restart();
    r.drive(button(&receipt.notification_id, Verb::Undo));
    let current = task_of(&r.d, &r.task);
    assert_eq!(current.due_local, due);
    assert_eq!(current.remind_before_min, original.remind_before_min);
    assert_eq!(
        current.remind_at_local, current.due_local,
        "only snooze is reversed; the later due stays"
    );
}

#[test]
fn distinct_outbox_presses_on_one_card_keep_their_exact_completion_ids() {
    let mut r = Rig::new();
    let first = wire::NotificationAnswered {
        notification_id: r.notice.clone(),
        verb: Verb::Done as i32,
        press_id: "first".to_owned(),
    };
    let second = wire::NotificationAnswered {
        notification_id: r.notice.clone(),
        verb: Verb::Open as i32,
        press_id: "second".to_owned(),
    };
    let third = wire::NotificationAnswered {
        press_id: "third".to_owned(),
        ..second.clone()
    };
    let event = |answer| {
        E::ShellFact(wire::ShellFact {
            fact: Some(wire::shell_fact::Fact::NotificationAnswered(answer)),
        })
    };
    let writing = r.raw(event(first.clone()));
    assert!(completed(&writing).is_empty());
    assert!(completed(&r.raw(event(second.clone()))).is_empty());
    assert!(completed(&r.raw(event(third.clone()))).is_empty());
    let batch = secret(&writing, wire::secret_op::Op::Set);
    let answer = r.shell.batch(&batch);
    let acknowledged = r.ack(answer);
    assert_eq!(completed(&acknowledged), vec![first, second, third]);
    assert_eq!(task_of_status(&r.d, &r.task), "done");
}
