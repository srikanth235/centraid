//! A foreground vault switch ends Locker sessions in both affected vaults.

mod vault_support;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Handle, rooms::RoomCtx as _, vaults::Vaults as _};
use centraid_screens::room::{RoomRuntime, shell};
use std::time::Duration;
use vault_support::{Phone, lay_down, scratch};

fn call(handle: &Handle, kind: wire::room_request::Kind) -> wire::RoomResponse {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("room request");
    match answer.kind {
        Some(wire::response::Kind::Room(answer)) => answer,
        other => panic!("not a room response: {other:?}"),
    }
}

fn drain_effects(handle: &Handle) -> Vec<wire::ShellEffect> {
    let mut effects = Vec::new();
    while let Ok(Some(event)) = handle.next_event(Duration::ZERO) {
        if let Some(wire::event::Kind::Effect(effect)) = event.kind {
            effects.push(effect);
        }
    }
    effects
}

fn open_locker(handle: &Handle) -> wire::RoomShown {
    let open = || {
        call(
            handle,
            wire::room_request::Kind::Open(wire::RoomOpen {
                key: "locker".to_owned(),
                tab: "home".to_owned(),
                root: true,
                ..Default::default()
            }),
        )
        .shown
        .into_iter()
        .last()
        .expect("RoomOpen returns a shown screen")
    };
    let mut shown = open();
    if shown
        .room
        .as_ref()
        .is_some_and(|room| room.key == "welcome")
    {
        shown = tap(handle, &shown, "welcome/start")
            .shown
            .into_iter()
            .last()
            .expect("starting the introduction opens Home");
        assert_eq!(shown.room.as_ref().unwrap().key, "home");
        shown = open();
    }
    assert_eq!(
        shown.room.as_ref().unwrap().key,
        "locker",
        "RoomOpen should honor the requested Locker route"
    );
    shown
}

fn tap(handle: &Handle, shown: &wire::RoomShown, selector_id: &str) -> wire::RoomResponse {
    call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: shown.instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
                    selector_id: selector_id.to_owned(),
                })),
            }),
        }),
    )
}

fn owner_check(handle: &Handle, shown: &wire::RoomShown, context: &str) -> (wire::RoomShown, u64) {
    let asked = tap(handle, shown, "wall/unlock");
    let effect_id = asked
        .effects
        .iter()
        .find_map(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::OwnerCheck(check)) if !check.cancel
            )
            .then_some(effect.effect_id)
        })
        .unwrap_or_else(|| panic!("{context}: no owner effect in {asked:?}"));
    (shown.clone(), effect_id)
}

fn send_owner_result(
    handle: &Handle,
    shown: &wire::RoomShown,
    effect_id: u64,
) -> wire::RoomResponse {
    call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: shown.instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::EffectResult(
                    wire::ShellEffectResult {
                        effect_id,
                        outcome: Some(wire::shell_effect_result::Outcome::Owner(
                            wire::ShellOwner {
                                passed: true,
                                ..Default::default()
                            },
                        )),
                    },
                )),
            }),
        }),
    )
}

fn answer_owner(handle: &Handle, shown: &wire::RoomShown, effect_id: u64) -> wire::RoomShown {
    send_owner_result(handle, shown, effect_id)
        .shown
        .into_iter()
        .last()
        .expect("owner result rebuilds Locker")
}

#[test]
fn switching_vaults_relocks_both_sides_and_requires_fresh_owner_checks() {
    let dir = scratch();
    let first_id = lay_down(&dir, "first", "First");
    let second_id = lay_down(&dir, "second", "Second");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.record_index(&first_id, 0);
    phone.record_index(&second_id, 1);
    phone.launch();
    assert!(phone.shelf.bring_to_front(&first_id));
    assert_eq!(phone.holdings().foreground, first_id);

    let front = phone.driver.handle.clone();
    front.attach_rooms(std::sync::Arc::new(RoomRuntime::new(shell::registry())));
    let first_scope = front.vault_id();

    let first_core = phone.shelf.core_of(&first_id).expect("first core is open");
    let second_core = phone
        .shelf
        .core_of(&second_id)
        .expect("second core is open");
    assert!(!first_core.locker_unlocked());
    assert!(!second_core.locker_unlocked());

    let first_wall = open_locker(&front);
    let (first_wall, first_ask) = owner_check(&front, &first_wall, "first vault initial unlock");
    let first_unlocked = answer_owner(&front, &first_wall, first_ask);
    assert!(first_core.locker_unlocked());
    let first_epoch = first_unlocked.secure_epoch;

    // A prompt that is still pending when the member changes vault must not
    // unlock either the old child or the new foreground child when its late
    // success arrives.
    first_core
        .locker_lock()
        .expect("the test relocks the first child");
    let pending_wall = open_locker(&front);
    let (pending_wall, pending_ask) =
        owner_check(&front, &pending_wall, "first vault pending switch");

    assert!(phone.shelf.bring_to_front(&second_id));
    let second_scope = front.vault_id();
    assert!(
        !first_core.locker_unlocked(),
        "leaving a vault wipes its Locker session"
    );
    assert!(!second_core.locker_unlocked());
    let boundary_effects = drain_effects(&front);
    assert!(
        boundary_effects.iter().any(|effect| {
            effect.effect_id != pending_ask
                && matches!(
                    effect.kind.as_ref(),
                    Some(wire::shell_effect::Kind::OwnerCheck(check)) if check.cancel
                )
        }),
        "vault switch cancels the old owner prompt with a fresh effect id"
    );
    assert!(
        boundary_effects.iter().any(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::ClipboardCopy(copy))
                    if copy.owner_vault_id == first_scope && copy.clear_owned
            )
        }),
        "vault switch clears only the outgoing vault's owned clipboard: {boundary_effects:?}"
    );
    let late = send_owner_result(&front, &pending_wall, pending_ask);
    assert!(!first_core.locker_unlocked());
    assert!(!second_core.locker_unlocked());
    assert!(late.secure_epoch > first_epoch);

    let second_wall = open_locker(&front);
    let (second_wall, second_ask) = owner_check(&front, &second_wall, "second vault unlock");
    let second_unlocked = answer_owner(&front, &second_wall, second_ask);
    assert!(second_core.locker_unlocked());
    assert!(second_unlocked.secure_epoch > first_epoch);

    assert!(phone.shelf.bring_to_front(&first_id));
    assert!(
        !second_core.locker_unlocked(),
        "the departing second vault is relocked"
    );
    assert!(
        !first_core.locker_unlocked(),
        "returning does not restore the old session"
    );
    let first_wall_again = open_locker(&front);
    let return_effects = drain_effects(&front);
    assert!(
        return_effects.iter().any(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::ClipboardCopy(copy))
                    if copy.owner_vault_id == second_scope && copy.clear_owned
            )
        }),
        "returning to A clears only B's owned clipboard"
    );
    let (first_wall_again, first_ask_again) =
        owner_check(&front, &first_wall_again, "first vault return unlock");
    assert_ne!(
        first_ask_again, first_ask,
        "the first prompt token cannot be replayed"
    );
    let first_unlocked_again = answer_owner(&front, &first_wall_again, first_ask_again);
    assert!(first_core.locker_unlocked());
    assert!(first_unlocked_again.secure_epoch > second_unlocked.secure_epoch);
}

#[test]
fn background_invalidates_pending_owner_result_and_requires_a_new_check() {
    let dir = scratch();
    let first_id = lay_down(&dir, "first", "First");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.record_index(&first_id, 0);
    phone.launch();

    let front = phone.driver.handle.clone();
    front.attach_rooms(std::sync::Arc::new(RoomRuntime::new(shell::registry())));
    let first_core = phone.shelf.core_of(&first_id).expect("first core is open");
    let wall = open_locker(&front);
    let (wall, pending_id) = owner_check(&front, &wall, "background pending unlock");

    let background = call(
        &front,
        wire::room_request::Kind::Lifecycle(wire::RoomLifecycle {
            phase: wire::room_lifecycle::Phase::Background as i32,
        }),
    );
    assert!(!first_core.locker_unlocked());
    assert!(
        background.effects.iter().any(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::OwnerCheck(check)) if check.cancel
            )
        }),
        "background cancels a pending owner prompt"
    );
    assert!(
        !background.effects.iter().any(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::ClipboardCopy(copy)) if copy.clear_owned
            )
        }),
        "background leaves an existing clipboard lease to its normal expiry"
    );
    let epoch_after_background = background
        .shown
        .iter()
        .map(|shown| shown.secure_epoch)
        .max()
        .expect("background returns an authoritative Locker wall");

    // A result from the owner prompt that was visible before backgrounding is
    // late. It must not restore the K-bearing session.
    let late = call(
        &front,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: wall.instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::EffectResult(
                    wire::ShellEffectResult {
                        effect_id: pending_id,
                        outcome: Some(wire::shell_effect_result::Outcome::Owner(
                            wire::ShellOwner {
                                passed: true,
                                ..Default::default()
                            },
                        )),
                    },
                )),
            }),
        }),
    );
    assert!(!first_core.locker_unlocked());
    assert!(late.secure_epoch >= epoch_after_background);

    let foreground = call(
        &front,
        wire::room_request::Kind::Lifecycle(wire::RoomLifecycle {
            phase: wire::room_lifecycle::Phase::Foreground as i32,
        }),
    );
    let foreground_wall = foreground
        .shown
        .into_iter()
        .last()
        .expect("foreground reconstructs the locked wall");
    assert_eq!(foreground_wall.room.as_ref().unwrap().key, "locker");
    let (foreground_wall, fresh_id) =
        owner_check(&front, &foreground_wall, "foreground fresh unlock");
    assert_ne!(fresh_id, pending_id);
    let _ = answer_owner(&front, &foreground_wall, fresh_id);
    assert!(first_core.locker_unlocked());
}
