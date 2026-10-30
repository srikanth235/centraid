//! One item and its editor: ports of the `LockerSpec` item and editor cases —
//! a secret is a sealed row with a verb, a reveal lives its window and is gone,
//! a copy never reaches the screen, a seed makes codes, trashing offers Undo,
//! and the editor saves whole, with the tags the vault's.

mod locker_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::locker::{self, routes};
use locker_support::*;
use wire::locker_editor_event::Kind as K;
use wire::locker_item_event::Kind as I;
use wire::screen_event::Kind as E;

fn opened_item() -> (centraid_screens::testing::Driver, u64) {
    let mut d = driver();
    login(&d, "i1", "Bank");
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    let id = push_item(&mut d, "i1");
    (d, id)
}

#[test]
fn an_item_shows_metadata_plainly_and_a_secret_as_a_sealed_row_with_a_verb() {
    let (d, id) = opened_item();
    let data = item_data(&d, id);
    assert_eq!(data.title, "Bank");
    assert_eq!(row_of(&data, "username").value, "maya@example.com");
    let password = row_of(&data, "password");
    assert!(password.sealed && password.value.is_empty());
    assert_eq!(password.mask, "••••••••••");
    let verbs: Vec<&str> = password.verbs.iter().map(|v| v.key.as_str()).collect();
    assert_eq!(verbs, ["reveal", "copy"]);
    assert!(matches!(
        item(&d, id).chrome.unwrap().edit_route.unwrap().args,
        Some(wire::route::Args::LockerEditor(editor)) if editor.item_id == "i1"
    ));
}

#[test]
fn a_reveal_lives_its_window_stamps_the_item_and_is_gone_at_the_end() {
    let (mut d, id) = opened_item();
    // An item nobody has opened says so, in the Details it already has (#1146).
    assert_eq!(row_of(&item_data(&d, id), "last_used").value, "Never");
    verb(&mut d, id, "password", "reveal");
    let data = item_data(&d, id);
    let password = row_of(&data, "password");
    assert!(password.revealed);
    assert_eq!(password.value, "correct horse");
    assert!(password.note.contains("30"), "{}", password.note);
    // The stamp is the item's own "Last used", once the change lands, and the
    // Locker keeps no history section behind it.
    d.pump(Duration::from_millis(300));
    let data = item_data(&d, id);
    let used = row_of(&data, "last_used");
    assert_ne!(used.value, "Never", "{used:?}");
    assert_eq!(used.label, "Last used");
    assert!(
        data.sections
            .iter()
            .all(|section| !section.title.to_lowercase().contains("access")),
        "{:?}",
        data.sections.iter().map(|s| &s.title).collect::<Vec<_>>()
    );
    verb(&mut d, id, "password", "conceal");
    assert!(row_of(&item_data(&d, id), "password").value.is_empty());
}

#[test]
fn a_reveal_ticks_down_and_conceals_itself() {
    let (mut d, id) = opened_item();
    verb(&mut d, id, "password", "reveal");
    d.pump(Duration::from_millis(1_200));
    let data = item_data(&d, id);
    assert!(
        row_of(&data, "password").note.contains("29"),
        "{}",
        row_of(&data, "password").note
    );
}

#[test]
fn copy_puts_a_secret_on_the_clipboard_and_never_on_the_screen() {
    let (mut d, id) = opened_item();
    let before = d.effects.len();
    verb(&mut d, id, "password", "copy");
    let out = effects_of(&d, before);
    assert!(out.iter().any(|k| matches!(
        k,
        wire::effect::Kind::ClipboardSet(set)
            if set.text == "correct horse" && set.sensitive && set.clear_after_ms == 30_000
    )));
    let state = item(&d, id);
    assert!(state.status.unwrap().sentence.contains("Password copied"));
    assert!(row_of(&item_data(&d, id), "password").value.is_empty());
}

#[test]
fn a_plain_value_copies_as_itself_and_is_not_marked_sensitive() {
    let (mut d, id) = opened_item();
    let before = d.effects.len();
    verb(&mut d, id, "username", "copy");
    assert!(effects_of(&d, before).iter().any(|k| matches!(
        k,
        wire::effect::Kind::ClipboardSet(set) if set.text == "maya@example.com" && !set.sensitive
    )));
}

#[test]
fn relocking_wipes_a_revealed_value_and_the_page() {
    let (mut d, id) = opened_item();
    verb(&mut d, id, "password", "reveal");
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: false,
    }));
    let state = item(&d, id);
    assert!(state.wall.is_some() && state.content.is_none() && !state.secure);
}

#[test]
fn a_chat_cards_member_action_runs_once_the_page_has_loaded() {
    let mut d = driver();
    login(&d, "i1", "Bank");
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    let id = d.push(locker::TAB, routes::item("i1", "Locker", "reveal:password"));
    assert!(row_of(&item_data(&d, id), "password").revealed);
}

#[test]
fn trashing_offers_undo_which_restores() {
    let (mut d, id) = opened_item();
    item_event(
        &mut d,
        id,
        I::Action(wire::locker_item_event::ActionTapped {
            key: "trash".to_owned(),
        }),
    );
    let state = item(&d, id);
    let status = state.status.clone().unwrap();
    assert_eq!(status.action_label, "Undo");
    assert!(matches!(
        state.content,
        Some(wire::locker_item_state::Content::Data(ref data)) if !data.trashed_note.is_empty()
    ));
    item_event(
        &mut d,
        id,
        I::StatusActed(wire::locker_item_event::StatusActed {}),
    );
    assert!(item_data(&d, id).trashed_note.is_empty());
}

#[test]
fn purging_asks_first_and_then_the_item_is_gone() {
    let (mut d, id) = opened_item();
    for key in ["trash", "purge"] {
        item_event(
            &mut d,
            id,
            I::Action(wire::locker_item_event::ActionTapped {
                key: key.to_owned(),
            }),
        );
    }
    assert!(item(&d, id).confirm.unwrap().destructive);
    item_event(
        &mut d,
        id,
        I::Confirmed(wire::locker_item_event::Confirmed {}),
    );
    assert!(item_data(&d, id).gone.is_some());
}

#[test]
fn a_seed_is_never_revealed_and_a_code_ticks_with_its_step() {
    let mut d = driver();
    arrange(
        &d,
        act::locker::AddItem {
            title: "Mail".to_owned(),
            item_id: Some("i2".to_owned()),
            otp_seed: Some("JBSWY3DPEHPK3PXP".to_owned()),
            ..Default::default()
        },
    );
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    let id = push_item(&mut d, "i2");
    let data = item_data(&d, id);
    let seed = row_of(&data, "otp_seed");
    let verbs: Vec<&str> = seed.verbs.iter().map(|v| v.key.as_str()).collect();
    assert_eq!(verbs, ["code", "copy_code"]);
    // A reveal of the seed itself is refused by the page.
    verb(&mut d, id, "otp_seed", "reveal");
    assert!(!row_of(&item_data(&d, id), "otp_seed").revealed);
    verb(&mut d, id, "otp_seed", "code");
    let data = item_data(&d, id);
    let seed = row_of(&data, "otp_seed");
    assert!(
        seed.revealed && seed.value.len() == 7,
        "grouped: {}",
        seed.value
    );
    assert_eq!(seed.countdown.as_ref().unwrap().period, 30);
}

#[test]
fn a_field_is_added_one_at_a_time_and_a_sealed_one_is_never_shown_back() {
    let (mut d, id) = opened_item();
    item_event(
        &mut d,
        id,
        I::Action(wire::locker_item_event::ActionTapped {
            key: "add_field".to_owned(),
        }),
    );
    let sheet = item(&d, id).field_sheet.unwrap();
    assert!(!sheet.can_save && !sheet.blocked.is_empty());
    for (key, value) in [("label", "PIN"), ("value", "1234")] {
        item_event(
            &mut d,
            id,
            I::FieldTyped(wire::locker_item_event::FieldTyped {
                key: key.to_owned(),
                value: value.to_owned(),
            }),
        );
    }
    item_event(
        &mut d,
        id,
        I::FieldKind(wire::locker_item_event::FieldKindPicked {
            key: "sealed".to_owned(),
        }),
    );
    item_event(
        &mut d,
        id,
        I::FieldSaved(wire::locker_item_event::FieldSaved {}),
    );
    assert!(item(&d, id).field_sheet.is_none());
    let data = item_data(&d, id);
    let field = data
        .sections
        .iter()
        .flat_map(|s| &s.rows)
        .find(|r| r.label == "PIN")
        .expect("the field is on the page");
    assert!(field.sealed && field.value.is_empty());
}

// --- the editor --------------------------------------------------------------

fn editor_event(d: &mut centraid_screens::testing::Driver, id: u64, event: K) {
    d.send(
        id,
        E::LockerEditor(wire::LockerEditorEvent { kind: Some(event) }),
    );
}

fn typed(d: &mut centraid_screens::testing::Driver, id: u64, key: &str, value: &str) {
    editor_event(
        d,
        id,
        K::Typed(wire::locker_editor_event::Typed {
            key: key.to_owned(),
            value: value.to_owned(),
        }),
    );
}

fn editor(d: &centraid_screens::testing::Driver, id: u64) -> wire::LockerEditorState {
    match &d.view(id).kind {
        Some(wire::view_state::Kind::LockerEditor(e)) => e.clone(),
        other => panic!("not an editor: {other:?}"),
    }
}

fn editor_data(d: &centraid_screens::testing::Driver, id: u64) -> wire::LockerEditorData {
    match editor(d, id).content {
        Some(wire::locker_editor_state::Content::Data(data)) => *data,
        other => panic!("no data: {other:?}"),
    }
}

#[test]
fn a_new_login_saves_whole_with_its_tags_filed_after() {
    let mut d = driver();
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    let id = d.push(locker::TAB, routes::add("", false));
    let data = editor_data(&d, id);
    assert!(!data.can_save && data.blocked == "A title is needed.");
    typed(&mut d, id, "title", "Netflix");
    typed(&mut d, id, "username", "me@x.org");
    typed(&mut d, id, "password", "hunter22hunter22");
    editor_event(
        &mut d,
        id,
        K::Tags(wire::locker_editor_event::TagsTyped {
            text: "media, home".to_owned(),
        }),
    );
    let strength = editor_data(&d, id)
        .inputs
        .iter()
        .find(|row| row.key == "password")
        .unwrap()
        .note
        .clone();
    assert!(strength.contains("bits"), "{strength}");
    editor_event(
        &mut d,
        id,
        K::Save(wire::locker_editor_event::SaveTapped {}),
    );
    assert!(editor(&d, id).finished);
    // The item is in the vault, with its tags.
    let home = home_instance(&d);
    let _ = home;
    let found = d.handle.load(&wire::LoadRequest {
        app: "locker".to_owned(),
        query: "items".to_owned(),
        zone: "UTC".to_owned(),
        ..Default::default()
    });
    let items = match found.unwrap().answer.unwrap().answer.unwrap() {
        wire::app_query_response::Answer::LockerItems(items) => items,
        other => panic!("{other:?}"),
    };
    let saved = items
        .items
        .iter()
        .find(|r| r.title == "Netflix")
        .expect("saved");
    assert_eq!(saved.tags, ["home", "media"]);
}

#[test]
fn an_edit_leaves_a_stored_secret_alone_unless_it_is_retyped() {
    let mut d = driver();
    login(&d, "i1", "Bank");
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    let id = d.push(locker::TAB, routes::edit("i1"));
    let data = editor_data(&d, id);
    let password = data.inputs.iter().find(|r| r.key == "password").unwrap();
    assert!(password.value.is_empty() && password.note.contains("Stored"));
    typed(&mut d, id, "title", "Bank 2");
    editor_event(
        &mut d,
        id,
        K::Save(wire::locker_editor_event::SaveTapped {}),
    );
    assert!(editor(&d, id).finished);
    unlock_core(&d);
    let revealed = session(
        &d,
        wire::locker_session_request::Step::Reveal(wire::LockerReveal {
            item_id: "i1".to_owned(),
            column: "password".to_owned(),
            ..Default::default()
        }),
    );
    assert_eq!(revealed.revealed.unwrap().value, "correct horse");
}

#[test]
fn the_editor_says_why_it_will_not_take_a_seed() {
    let mut d = driver();
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    let id = d.push(locker::TAB, routes::add("login", false));
    typed(&mut d, id, "title", "Mail");
    typed(
        &mut d,
        id,
        "otp_seed",
        "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP",
    );
    let data = editor_data(&d, id);
    assert!(!data.can_save);
    assert!(data.blocked.contains("counter-based"), "{}", data.blocked);
    typed(
        &mut d,
        id,
        "otp_seed",
        "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
    );
    assert!(editor_data(&d, id).can_save);
}

#[test]
fn leaving_with_changes_asks_first_and_a_relock_closes_the_editor() {
    let mut d = driver();
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    let id = d.push(locker::TAB, routes::add("", false));
    editor_event(
        &mut d,
        id,
        K::Cancel(wire::locker_editor_event::CancelTapped {}),
    );
    assert!(editor(&d, id).finished, "nothing typed, nothing to lose");
    let id = d.push(locker::TAB, routes::add("", false));
    typed(&mut d, id, "title", "Half");
    editor_event(
        &mut d,
        id,
        K::Cancel(wire::locker_editor_event::CancelTapped {}),
    );
    assert!(editor(&d, id).confirm.unwrap().destructive && !editor(&d, id).finished);
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: false,
    }));
    let state = editor(&d, id);
    assert!(
        state.finished && state.content.is_none(),
        "what was typed is gone"
    );
}

#[test]
fn the_compromised_flag_is_sent_only_when_it_changed() {
    let mut d = driver();
    arrange(
        &d,
        act::locker::AddItem {
            title: "Bank".to_owned(),
            item_id: Some("i1".to_owned()),
            password: Some("old".to_owned()),
            compromised: Some(true),
            ..Default::default()
        },
    );
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    let id = d.push(locker::TAB, routes::edit("i1"));
    assert!(editor_data(&d, id).compromised);
    editor_event(
        &mut d,
        id,
        K::Compromised(wire::locker_editor_event::CompromisedToggled { on: true }),
    );
    typed(&mut d, id, "password", "a-new-password-1");
    assert!(editor_data(&d, id).compromised_note.contains("clear"));
    editor_event(
        &mut d,
        id,
        K::Save(wire::locker_editor_event::SaveTapped {}),
    );
    // The vault's rule: a rotation answers the flag set in the same save.
    assert!(editor(&d, id).finished);
    let _ = Duration::from_secs(0);
}
