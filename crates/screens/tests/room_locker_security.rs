use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_identity::RecoveryPhrase;
use centraid_screens::room::snapshot;
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::json;

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_795_687_200_000;
const ITEM: &str = "01900000-0000-7000-8000-000000000101";
const FIELD: &str = "01900000-0000-7000-8000-000000000102";

fn phone(path: &std::path::Path) -> Handle {
    let seed = RecoveryPhrase::parse(WORDS).expect("phrase").seed();
    let handle = Core::open(
        CoreConfig::new(path.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("locker-security")),
            ),
    )
    .expect("core");
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .expect("founded vault");
    centraid_screens::attach(&handle);
    handle
}

fn room_call(handle: &Handle, kind: wire::room_request::Kind) -> wire::RoomResponse {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("room request")
        .kind
        .expect("response kind");
    match answer {
        wire::response::Kind::Room(response) => response,
        other => panic!("unexpected response: {other:?}"),
    }
}

fn open(handle: &Handle, key: &str, root: bool) -> wire::RoomShown {
    room_call(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            tab: "home".to_owned(),
            root,
            ..Default::default()
        }),
    )
    .shown
    .remove(0)
}

fn tap(handle: &Handle, instance: u64, selector_id: &str) -> wire::RoomResponse {
    room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
                    selector_id: selector_id.to_owned(),
                })),
            }),
        }),
    )
}

fn change_text(
    handle: &Handle,
    instance: u64,
    selector_id: &str,
    value: &str,
) -> wire::RoomResponse {
    room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::Change(wire::RoomChange {
                    selector_id: selector_id.to_owned(),
                    seq: 1,
                    value: Some(wire::room_change::Value::Text(value.to_owned())),
                })),
            }),
        }),
    )
}

fn change_option(
    handle: &Handle,
    instance: u64,
    selector_id: &str,
    value: &str,
) -> wire::RoomResponse {
    room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::Change(wire::RoomChange {
                    selector_id: selector_id.to_owned(),
                    seq: 1,
                    value: Some(wire::room_change::Value::Option(value.to_owned())),
                })),
            }),
        }),
    )
}

fn locker_fields(handle: &Handle) -> Vec<centraid_domain::apps::locker::LockerFieldMeta> {
    let path = handle
        .with_vault(|vault| Ok(vault.path().to_owned()))
        .expect("vault path");
    centraid_domain::read::Reader::open(path)
        .expect("reader")
        .run(
            &centraid_domain::apps::locker::FIELDS_OF_ITEM,
            &centraid_domain::read::Args::new().text("item_id", ITEM),
        )
        .expect("fields read")
        .rows
}

fn answer_owner(handle: &Handle, instance: u64, passed: bool) -> wire::RoomShown {
    answer_owner_with(
        handle,
        instance,
        wire::ShellOwner {
            passed,
            ..Default::default()
        },
    )
}

fn answer_owner_with(handle: &Handle, instance: u64, owner: wire::ShellOwner) -> wire::RoomShown {
    let ask = tap(handle, instance, "wall/unlock");
    let effect = ask
        .effects
        .iter()
        .find(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::OwnerCheck(_))
            )
        })
        .expect("unlock asks the phone owner");
    let response = room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::EffectResult(
                    wire::ShellEffectResult {
                        effect_id: effect.effect_id,
                        outcome: Some(wire::shell_effect_result::Outcome::Owner(owner)),
                    },
                )),
            }),
        }),
    );
    response.shown.into_iter().next().expect("wall rebuilt")
}

fn cancel_owner(handle: &Handle, instance: u64) -> wire::RoomShown {
    let ask = tap(handle, instance, "wall/unlock");
    let effect = ask
        .effects
        .iter()
        .find(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::OwnerCheck(_))
            )
        })
        .expect("unlock asks the phone owner");
    room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::EffectResult(
                    wire::ShellEffectResult {
                        effect_id: effect.effect_id,
                        outcome: Some(wire::shell_effect_result::Outcome::Owner(
                            wire::ShellOwner {
                                cancelled: true,
                                ..Default::default()
                            },
                        )),
                    },
                )),
            }),
        }),
    )
    .shown
    .into_iter()
    .next()
    .expect("cancel leaves wall open")
}

fn seed_item(handle: &Handle) {
    let seed = RecoveryPhrase::parse(WORDS).expect("phrase").seed();
    let key = centraid_identity::derive::restore_vault_keys(&seed, 0)
        .expect("keys")
        .locker;
    let key_id = handle
        .with_vault(|vault| {
            vault
                .locker_generation()
                .map_err(|error| centraid_core::CoreError::InvalidRequest {
                    detail: error.to_string(),
                })
        })
        .expect("locker generation");
    let ciphertext = centraid_vault::custody::locker_key::encrypt_under_locker_key(
        key.as_bytes(),
        &key_id,
        FIELD,
        "correct horse battery staple",
    )
    .expect("sealed value");
    let outcome = handle
        .command(
            "locker.add_item",
            &json!({
                "item_id": ITEM,
                "type": "login",
                "title": "Bank login",
                "fields": [{
                    "field_id": FIELD,
                    "label": "Password",
                    "kind": "sealed",
                    "value": ciphertext,
                    "key_id": key_id
                }]
            }),
            "seed-locker-item",
        )
        .expect("seed command");
    assert_eq!(
        outcome.status,
        centraid_vault::CommandStatus::Executed,
        "{:?}",
        outcome.reason
    );
    let plaintext = handle
        .command(
            "locker.set_field",
            &json!({
                "item_id": ITEM,
                "field_id": "01900000-0000-7000-8000-000000000103",
                "label": "Unsafe",
                "kind": "sealed",
                "value": "plaintext must never be stored"
            }),
            "plaintext-field-refusal",
        )
        .expect("plaintext submission is checked");
    assert_eq!(plaintext.status, centraid_vault::CommandStatus::Failed);
}

#[test]
fn owner_failure_stays_locked_deep_links_are_gated_and_reveal_is_wiped_on_background() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = phone(dir.path());
    seed_item(&handle);

    let deep_link = open(&handle, &format!("locker/item/{ITEM}"), true);
    assert_eq!(deep_link.room.as_ref().expect("room").key, "locker");
    assert!(deep_link.room.as_ref().expect("room").secure);

    let pending_wall = open(&handle, "locker", true);
    let pending = tap(&handle, pending_wall.instance, "wall/unlock");
    let owner_effect_id = pending
        .effects
        .iter()
        .find(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::OwnerCheck(check)) if !check.cancel
            )
        })
        .expect("pending owner check")
        .effect_id;
    let away = room_call(
        &handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: "notes".to_owned(),
            tab: "home".to_owned(),
            ..Default::default()
        }),
    );
    assert!(
        away.secure_epoch > pending.secure_epoch,
        "cancelling a pending owner check advances the secure response epoch"
    );
    assert!(
        away.effects.iter().any(|effect| {
            effect.effect_id != owner_effect_id
                && matches!(
                    effect.kind.as_ref(),
                    Some(wire::shell_effect::Kind::OwnerCheck(check)) if check.cancel
                )
        }),
        "leaving Locker cancels the owner prompt with a fresh id"
    );
    let late = room_call(
        &handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: pending_wall.instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::EffectResult(
                    wire::ShellEffectResult {
                        effect_id: owner_effect_id,
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
    assert!(late.secure_epoch >= away.secure_epoch);
    assert!(
        late.shown.is_empty(),
        "a covered wall ignores the late answer"
    );

    let wall = open(&handle, "locker", true);
    let after_cancel = cancel_owner(&handle, wall.instance);
    assert_eq!(
        handle
            .with_vault(|vault| Ok(vault.locker_failed_unlocks()?.0))
            .expect("failed count after cancel"),
        0,
        "cancel is not a failed unlock",
    );
    let failed = answer_owner(&handle, after_cancel.instance, false);
    assert_eq!(failed.room.as_ref().expect("room").key, "locker");
    assert!(failed.room.as_ref().expect("room").secure);
    assert!(!snapshot::render(failed.room.as_ref().expect("room")).contains("Bank login"));
    assert_eq!(
        handle
            .with_vault(|vault| {
                vault.locker_failed_unlocks().map_err(|error| {
                    centraid_core::CoreError::InvalidRequest {
                        detail: error.to_string(),
                    }
                })
            })
            .expect("persisted report")
            .0,
        1,
    );
    let refused_deep_link = open(&handle, &format!("locker/item/{ITEM}"), true);
    assert_eq!(refused_deep_link.room.as_ref().expect("room").key, "locker");

    let contradictory_wall = open(&handle, "locker", true);
    let contradictory = answer_owner_with(
        &handle,
        contradictory_wall.instance,
        wire::ShellOwner {
            passed: true,
            cancelled: true,
            ..Default::default()
        },
    );
    assert_eq!(contradictory.room.as_ref().expect("room").key, "locker");
    assert_eq!(
        handle
            .with_vault(|vault| Ok(vault.locker_failed_unlocks()?.0))
            .expect("count after contradictory cancellation"),
        1,
        "cancelled owner results neither unlock nor count as a refusal",
    );

    let unlocked_wall = open(&handle, "locker", true);
    let unlocked = answer_owner(&handle, unlocked_wall.instance, true);
    assert!(snapshot::render(unlocked.room.as_ref().expect("room")).contains("Bank login"));

    let item_list = open(&handle, "locker", true);
    let selecting = tap(
        &handle,
        item_list.instance,
        &format!("row/{ITEM}/menu/select"),
    )
    .shown
    .into_iter()
    .next()
    .expect("selection mode");
    let selection = selecting
        .room
        .as_ref()
        .and_then(|room| room.selection.as_ref())
        .expect("Locker selection bar");
    assert!(selection.on);
    let picked = tap(&handle, selecting.instance, &format!("row/{ITEM}"))
        .shown
        .into_iter()
        .next()
        .expect("picked row");
    let selection = picked
        .room
        .as_ref()
        .and_then(|room| room.selection.as_ref())
        .expect("selection bar stays open");
    assert_eq!(selection.count, 1);
    assert!(
        selection
            .actions
            .iter()
            .any(|action| action.label == "Star")
    );
    assert!(
        selection
            .actions
            .iter()
            .any(|action| action.label == "Move to trash")
    );
    tap(&handle, picked.instance, "selection/done");

    let new_field = open(&handle, &format!("locker/item/{ITEM}/field/new"), false);
    change_text(&handle, new_field.instance, "field/label", "Reference");
    change_text(&handle, new_field.instance, "field/value/text", "member-42");
    let secret_kind = change_option(&handle, new_field.instance, "choice/kind", "sealed");
    let secret_kind_room = secret_kind
        .shown
        .iter()
        .find(|shown| shown.instance == new_field.instance)
        .and_then(|shown| shown.room.as_ref())
        .expect("kind change rebuilds the editor");
    let secret_kind_field = match secret_kind_room.state.as_ref() {
        Some(wire::room::State::Ready(ready)) => ready.blocks.iter().find_map(|block| {
            let Some(wire::room_block::Kind::Form(form)) = block.kind.as_ref() else {
                return None;
            };
            form.fields
                .iter()
                .find(|field| field.selector_id == "field/value/sealed")
        }),
        other => panic!("secret editor is ready: {other:?}"),
    }
    .expect("secret value input");
    let Some(wire::room_field::Input::Secret(secret)) = secret_kind_field.input.as_ref() else {
        panic!("sealed field uses a secure input");
    };
    assert!(secret.masked);
    assert!(secret.value.is_empty());
    assert!(secret.reveal_selector_id.is_empty());
    assert!(!format!("{secret_kind:?}").contains("member-42"));
    let empty_secret = tap(&handle, new_field.instance, "form/save");
    assert!(
        empty_secret.shown.iter().any(|shown| shown
            .room
            .as_ref()
            .is_some_and(|room| room.key.ends_with("/field/new"))),
        "switching a plain draft to sealed clears its value and refuses an empty new secret"
    );
    change_option(&handle, new_field.instance, "choice/kind", "text");
    change_text(&handle, new_field.instance, "field/value/text", "member-42");
    let saved = tap(&handle, new_field.instance, "form/save");
    assert!(!saved.shown.is_empty(), "field save returns to the item");
    let added = locker_fields(&handle)
        .into_iter()
        .find(|field| field.label == "Reference")
        .expect("plain field was added");
    assert_eq!(added.value_text.as_deref(), Some("member-42"));

    let manager = open(&handle, &format!("locker/item/{ITEM}/fields"), false);
    let editing = tap(
        &handle,
        manager.instance,
        &format!("field/{}/edit", added.id),
    )
    .shown
    .into_iter()
    .next()
    .expect("field edit form");
    assert_eq!(
        editing.room.as_ref().expect("editor").key,
        format!("locker/item/{ITEM}/field/{}/edit", added.id),
    );
    let changed_form = change_text(
        &handle,
        editing.instance,
        "field/label",
        "Account reference",
    );
    let changed_room = changed_form
        .shown
        .first()
        .and_then(|shown| shown.room.as_ref())
        .unwrap_or_else(|| {
            panic!(
                "field change produced no room for instance {}: {changed_form:?}",
                editing.instance
            )
        });
    assert!(
        snapshot::render(changed_room).contains("Account reference"),
        "edit field change reaches its form",
    );
    let edit_result = tap(&handle, editing.instance, "form/save");
    assert!(
        edit_result.shown[0]
            .room
            .as_ref()
            .is_some_and(|room| room.key.ends_with("/fields")),
        "saving returns to the field list",
    );
    let edited = locker_fields(&handle)
        .into_iter()
        .find(|field| field.id == added.id)
        .expect("field remains after edit");
    assert_eq!(edited.label, "Account reference");
    assert_eq!(edited.value_text.as_deref(), Some("member-42"));
    let manager = open(&handle, &format!("locker/item/{ITEM}/fields"), false);
    tap(
        &handle,
        manager.instance,
        &format!("field/{}/remove", added.id),
    );
    assert!(
        locker_fields(&handle)
            .iter()
            .all(|field| field.id != added.id)
    );

    let manager = open(&handle, &format!("locker/item/{ITEM}/fields"), false);
    let editing_secret = tap(&handle, manager.instance, &format!("field/{FIELD}/edit"))
        .shown
        .into_iter()
        .next()
        .expect("sealed field edit form");
    change_text(
        &handle,
        editing_secret.instance,
        "field/label",
        "Primary password",
    );
    tap(&handle, editing_secret.instance, "form/save");
    let preserved_secret = locker_fields(&handle)
        .into_iter()
        .find(|field| field.id == FIELD)
        .expect("sealed value remains");
    assert_eq!(preserved_secret.kind, "sealed");
    assert_eq!(preserved_secret.label, "Primary password");
    assert!(preserved_secret.value_text.is_none());

    // Sealed values are exact bytes: leading and trailing spaces can be part of
    // a password and must survive the editor -> AAD encryption -> reveal path.
    let manager = open(&handle, &format!("locker/item/{ITEM}/fields"), false);
    let editing_secret = tap(&handle, manager.instance, &format!("field/{FIELD}/edit"))
        .shown
        .into_iter()
        .next()
        .expect("sealed field editor");
    let long_secret = format!("  {}  ", "s".repeat(512));
    assert!(long_secret.len() > 200);
    let typed_secret = change_text(
        &handle,
        editing_secret.instance,
        "field/value/sealed",
        &long_secret,
    );
    let typed_room = typed_secret
        .shown
        .iter()
        .find(|shown| shown.instance == editing_secret.instance)
        .and_then(|shown| shown.room.as_ref())
        .expect("secret edit room is rebuilt");
    let secret_field = match typed_room.state.as_ref() {
        Some(wire::room::State::Ready(ready)) => ready.blocks.iter().find_map(|block| {
            let Some(wire::room_block::Kind::Form(form)) = block.kind.as_ref() else {
                return None;
            };
            form.fields
                .iter()
                .find(|field| field.selector_id == "field/value/sealed")
        }),
        other => panic!("secret editor is ready: {other:?}"),
    }
    .expect("write-only secret field");
    let Some(wire::room_field::Input::Secret(secret)) = secret_field.input.as_ref() else {
        panic!("replacement value uses a secret input");
    };
    assert!(secret.masked);
    assert!(
        secret.value.is_empty(),
        "typed secret is not echoed to the shell"
    );
    assert!(
        secret.reveal_selector_id.is_empty(),
        "write-only input has no reveal action"
    );
    assert!(!format!("{typed_secret:?}").contains(&long_secret));
    tap(&handle, editing_secret.instance, "form/save");

    let manager = open(&handle, &format!("locker/item/{ITEM}/fields"), false);
    let too_long_editor = tap(&handle, manager.instance, &format!("field/{FIELD}/edit"))
        .shown
        .into_iter()
        .next()
        .expect("sealed editor for length validation");
    // A 100 KiB secret exceeds the vault's encrypted-value budget after sealing.
    let too_long = "x".repeat(100 * 1024);
    change_text(
        &handle,
        too_long_editor.instance,
        "field/value/sealed",
        &too_long,
    );
    let refused_length = tap(&handle, too_long_editor.instance, "form/save");
    assert!(refused_length.shown.iter().any(|shown| {
        shown
            .room
            .as_ref()
            .is_some_and(|room| room.key.ends_with(&format!("/field/{FIELD}/edit")))
    }));
    assert!(!format!("{refused_length:?}").contains(&too_long));

    let manager = open(&handle, &format!("locker/item/{ITEM}/fields"), false);
    let draft_editor = tap(&handle, manager.instance, &format!("field/{FIELD}/edit"))
        .shown
        .into_iter()
        .next()
        .expect("sealed editor for background wipe");
    change_text(
        &handle,
        draft_editor.instance,
        "field/value/sealed",
        "unsaved secret draft",
    );
    let background_draft = room_call(
        &handle,
        wire::room_request::Kind::Lifecycle(wire::RoomLifecycle {
            phase: wire::room_lifecycle::Phase::Background as i32,
        }),
    );
    let draft_wall = background_draft
        .shown
        .iter()
        .find(|shown| shown.room.as_ref().is_some_and(|room| room.key == "locker"))
        .expect("background replaces the editor with the locked wall");
    assert!(!format!("{background_draft:?}").contains("unsaved secret draft"));
    let foreground = room_call(
        &handle,
        wire::room_request::Kind::Lifecycle(wire::RoomLifecycle {
            phase: wire::room_lifecycle::Phase::Foreground as i32,
        }),
    );
    let foreground_wall = foreground
        .shown
        .iter()
        .find(|shown| shown.room.as_ref().is_some_and(|room| room.key == "locker"))
        .expect("foreground reconstructs the wall");
    assert_eq!(foreground_wall.secure_epoch, foreground.secure_epoch);
    answer_owner(&handle, draft_wall.instance, true);

    let detail = open(&handle, &format!("locker/item/{ITEM}"), true);
    let locked_detail = detail.room.as_ref().expect("room");
    assert!(locked_detail.secure);
    assert!(!snapshot::render(locked_detail).contains("correct horse battery staple"));
    let revealed = tap(&handle, detail.instance, &format!("field/{FIELD}/reveal"));
    let detail_after_reveal = revealed.shown.into_iter().next().expect("revealed detail");
    assert!(
        snapshot::render(detail_after_reveal.room.as_ref().expect("room")).contains(&long_secret)
    );

    let manager = open(&handle, &format!("locker/item/{ITEM}/fields"), false);
    let cache_edit = tap(&handle, manager.instance, &format!("field/{FIELD}/edit"))
        .shown
        .into_iter()
        .next()
        .expect("edit a field while its previous value is revealed");
    change_text(
        &handle,
        cache_edit.instance,
        "field/value/sealed",
        "replacement secret",
    );
    tap(&handle, cache_edit.instance, "form/save");
    let back_to_detail = tap(&handle, manager.instance, "back");
    let returned_detail = back_to_detail
        .shown
        .into_iter()
        .next()
        .expect("pop returns to the existing detail instance");
    let returned_render = snapshot::render(returned_detail.room.as_ref().expect("detail"));
    assert!(!returned_render.contains(&long_secret));
    assert!(!returned_render.contains("replacement secret"));
    let revealed_updated = tap(
        &handle,
        returned_detail.instance,
        &format!("field/{FIELD}/reveal"),
    );
    let detail_after_reveal = revealed_updated
        .shown
        .into_iter()
        .next()
        .expect("reveal the replacement field");
    assert!(
        snapshot::render(detail_after_reveal.room.as_ref().expect("detail"))
            .contains("replacement secret")
    );
    let copied = tap(
        &handle,
        detail_after_reveal.instance,
        &format!("field/{FIELD}/copy"),
    );
    let copy = copied
        .effects
        .iter()
        .find_map(|effect| match &effect.kind {
            Some(wire::shell_effect::Kind::ClipboardCopy(copy)) => Some(copy),
            _ => None,
        })
        .expect("copy uses the clipboard lease effect");
    assert_eq!(copy.text, "replacement secret");
    assert!(copy.sealed);
    assert_eq!(copy.lease_s, 30);
    let copied_result = room_call(
        &handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: detail_after_reveal.instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::EffectResult(
                    wire::ShellEffectResult {
                        effect_id: copied.effects[0].effect_id,
                        outcome: Some(wire::shell_effect_result::Outcome::Done(wire::ShellDone {})),
                    },
                )),
            }),
        }),
    );
    assert!(
        snapshot::render(
            copied_result.shown[0]
                .room
                .as_ref()
                .expect("copy result room")
        )
        .contains("Copied")
    );
    let vault_path = handle
        .with_vault(|vault| Ok(vault.path().to_owned()))
        .expect("vault path");
    let reader = centraid_domain::read::Reader::open(vault_path).expect("reader");
    let used = reader
        .run(
            &centraid_domain::apps::locker::ITEM_BY_ID,
            &centraid_domain::read::Args::new().text("id", ITEM),
        )
        .expect("last use read");
    assert!(used.rows[0].last_used_at.is_some());

    let locked = tap(&handle, detail_after_reveal.instance, "menu/lock");
    let clear = locked
        .effects
        .iter()
        .find_map(|effect| match &effect.kind {
            Some(wire::shell_effect::Kind::ClipboardCopy(copy)) if copy.clear_owned => Some(copy),
            _ => None,
        })
        .expect("manual Lock clears only the latest Locker-owned clipboard copy");
    assert!(clear.text.is_empty());
    assert!(!clear.owner_vault_id.is_empty());
    let wall = locked.shown.into_iter().next().expect("manual lock wall");
    let pending = tap(&handle, wall.instance, "wall/unlock");
    let owner_effect = pending
        .effects
        .iter()
        .find(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::OwnerCheck(check)) if !check.cancel
            )
        })
        .expect("pending phone check");
    let owner_effect_id = owner_effect.effect_id;
    let background = room_call(
        &handle,
        wire::room_request::Kind::Lifecycle(wire::RoomLifecycle {
            phase: wire::room_lifecycle::Phase::Background as i32,
        }),
    );
    assert!(background.secure_epoch > pending.secure_epoch);
    assert!(
        background
            .shown
            .iter()
            .any(|shown| shown.room.as_ref().is_some_and(|room| room.key == "locker"))
    );
    assert!(
        background.effects.iter().any(|effect| {
            effect.effect_id != owner_effect_id
                && matches!(
                    effect.kind.as_ref(),
                    Some(wire::shell_effect::Kind::OwnerCheck(check)) if check.cancel
                )
        }),
        "background cancels the native owner prompt with a fresh effect id"
    );
    let background_wall = background
        .shown
        .iter()
        .find(|shown| shown.room.as_ref().is_some_and(|room| room.key == "locker"))
        .expect("locked wall");
    assert_eq!(background_wall.secure_epoch, background.secure_epoch);
    let late = room_call(
        &handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: background_wall.instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::EffectResult(
                    wire::ShellEffectResult {
                        effect_id: owner_effect_id,
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
    assert!(late.shown.is_empty(), "late owner success is stale");
    let foreground = room_call(
        &handle,
        wire::room_request::Kind::Lifecycle(wire::RoomLifecycle {
            phase: wire::room_lifecycle::Phase::Foreground as i32,
        }),
    );
    assert_eq!(foreground.secure_epoch, background.secure_epoch);
    let foreground_wall = foreground
        .shown
        .iter()
        .find(|shown| shown.room.as_ref().is_some_and(|room| room.key == "locker"))
        .expect("foreground reconstructs the locked Locker wall");
    assert_eq!(foreground_wall.secure_epoch, foreground.secure_epoch);
    assert!(
        !snapshot::render(foreground_wall.room.as_ref().expect("wall"))
            .contains("correct horse battery staple")
    );
    let stale_after_foreground = room_call(
        &handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: foreground_wall.instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::EffectResult(
                    wire::ShellEffectResult {
                        effect_id: owner_effect_id,
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
    assert!(stale_after_foreground.shown.is_empty());
    let locked_again = open(&handle, &format!("locker/item/{ITEM}"), true);
    assert_eq!(locked_again.room.as_ref().expect("room").key, "locker");
    assert!(
        !snapshot::render(locked_again.room.as_ref().expect("room"))
            .contains("correct horse battery staple")
    );
}
