//! A known vault switch clears the old vault's OS set even when receipt storage is blocked.
mod reminders_support;
mod vault_support;

use centraid_api_proto::core_v1 as wire;
use centraid_core::vaults::Vaults;
use centraid_screens::Screen;
use centraid_screens::agenda::notify;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::testing::{Driver, FakeShell};
use reminders_support::{add, day};
use wire::NotificationVerb as Verb;
use wire::screen_event::Kind as E;

fn raw(d: &Driver, service: &mut dyn Screen, kind: E) -> Vec<wire::Effect> {
    d.with_ctx(|ctx| service.update(wire::ScreenEvent { kind: Some(kind) }, ctx))
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

fn ack(
    d: &Driver,
    service: &mut dyn Screen,
    shell: &mut FakeShell,
    effects: &[wire::Effect],
    op: wire::secret_op::Op,
) -> Vec<wire::Effect> {
    let batch = effects
        .iter()
        .find_map(|effect| match &effect.kind {
            Some(wire::effect::Kind::Secrets(batch)) => Some(batch),
            _ => None,
        })
        .expect("the receipt storage operation");
    assert_eq!(batch.ops.len(), 1);
    assert_eq!(batch.ops[0].op, op as i32);
    let answer = shell.batch(batch);
    raw(
        d,
        service,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(wire::effect_result::Outcome::Secrets(answer)),
        }),
    )
}

fn set(effects: &[wire::Effect]) -> Option<&wire::ScheduleNotifications> {
    effects.iter().find_map(|effect| match &effect.kind {
        Some(wire::effect::Kind::ScheduleNotifications(set)) => Some(set),
        _ => None,
    })
}

fn known_switch(delete_failed: bool, remove_all: bool) {
    let dir = vault_support::scratch();
    let a = vault_support::lay_down(&dir, "a", "First");
    let b = vault_support::lay_down(&dir, "b", "Second");
    let mut phone = vault_support::Phone::on(&dir, None);
    phone.launch();
    assert!(phone.shelf.bring_to_front(&a));
    let tomorrow = day(&phone.driver, 1);
    let task = add(
        &phone.driver,
        act::reminders::AddTask {
            title: "Only the first vault".to_owned(),
            due: Field::Is(format!("{tomorrow}T09:00")),
            remind_before_min: Field::Is(0),
            ..Default::default()
        },
    );
    let mut service = notify::build(&notify::route()).expect("service");
    let appeared = raw(
        &phone.driver,
        &mut *service,
        E::Appeared(Default::default()),
    );
    assert!(
        set(&appeared).is_none(),
        "bootstrap waits for the secret GET"
    );
    let initial = ack(
        &phone.driver,
        &mut *service,
        &mut phone.shell,
        &appeared,
        wire::secret_op::Op::Get,
    );
    assert!(set(&initial).expect("bootstrap set").retain_delivered);
    let reminder = set(&initial)
        .expect("first vault scheduled")
        .all
        .iter()
        .find(|notice| notice.notification_id.contains(&task))
        .expect("our reminder")
        .notification_id
        .clone();
    assert!(reminder.starts_with(&format!("task|{a}|")));
    let saving = raw(&phone.driver, &mut *service, button(&reminder, Verb::Done));
    let completed = ack(
        &phone.driver,
        &mut *service,
        &mut phone.shell,
        &saving,
        wire::secret_op::Op::Set,
    );
    let receipt = set(&completed)
        .expect("receipt scheduled")
        .all
        .iter()
        .find(|notice| notice.immediate)
        .expect("receipt")
        .notification_id
        .clone();
    let intent = raw(&phone.driver, &mut *service, button(&receipt, Verb::Undo));
    let deleting = ack(
        &phone.driver,
        &mut *service,
        &mut phone.shell,
        &intent,
        wire::secret_op::Op::Set,
    );
    assert!(
        set(&deleting).is_none(),
        "accepted Undo waits for secret deletion acknowledgement"
    );
    if delete_failed {
        raw(
            &phone.driver,
            &mut *service,
            E::EffectResult(wire::EffectResult {
                effect_id: 0,
                outcome: Some(wire::effect_result::Outcome::Secrets(wire::SecretBatched {
                    answers: vec![wire::SecretAnswer::default()],
                })),
            }),
        );
    }
    if remove_all {
        assert!(phone.shelf.forget(&b).value);
        assert!(phone.shelf.forget(&a).value);
        assert!(phone.shelf.foreground_id().is_none());
    } else {
        assert!(phone.shelf.bring_to_front(&b));
    }
    let switched = raw(
        &phone.driver,
        &mut *service,
        E::DataChanged(wire::DataChanged {
            tables: vec![centraid_core::vaults::SHELF_TABLE.to_owned()],
        }),
    );
    let cleared =
        set(&switched).expect("a known vault switch clears the old OS set despite blocked storage");
    assert!(
        cleared.all.is_empty(),
        "neither first-vault notices nor its receipt may survive"
    );
    assert!(!cleared.ask_permission);
    assert!(
        !cleared.retain_delivered,
        "the departed vault requires the explicit legacy clear"
    );
}

#[test]
fn a_known_vault_switch_clears_old_notices_while_receipt_deletion_is_pending() {
    known_switch(false, false);
}

#[test]
fn a_known_vault_switch_clears_old_notices_after_receipt_deletion_failed() {
    known_switch(true, false);
}

#[test]
fn removing_the_last_foreground_vault_clears_notices_while_deletion_is_pending() {
    known_switch(false, true);
}

#[test]
fn removing_the_last_foreground_vault_clears_notices_after_deletion_failed() {
    known_switch(true, true);
}
