//! Export, import, the access history, the trash and the wall page: ports of
//! `LockerTransferSpec` and the access and trash cases of `LockerSpec`.

mod locker_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::locker::{self, routes};
use locker_support::*;
use wire::locker_export_event::Kind as X;
use wire::locker_import_event::Kind as I;
use wire::screen_event::Kind as E;

fn export_state(d: &centraid_screens::testing::Driver, id: u64) -> wire::LockerExportState {
    match &d.view(id).kind {
        Some(wire::view_state::Kind::LockerExport(e)) => e.clone(),
        other => panic!("{other:?}"),
    }
}

fn import_state(d: &centraid_screens::testing::Driver, id: u64) -> wire::LockerImportState {
    match &d.view(id).kind {
        Some(wire::view_state::Kind::LockerImport(e)) => e.clone(),
        other => panic!("{other:?}"),
    }
}

fn export_event(d: &mut centraid_screens::testing::Driver, id: u64, kind: X) {
    d.send(
        id,
        E::LockerExport(wire::LockerExportEvent { kind: Some(kind) }),
    );
}

fn ready() -> centraid_screens::testing::Driver {
    let mut d = driver();
    login(&d, "i1", "Bank");
    d.start();
    d.answer_effect(passed(wire::Biometry::Face));
    // The unlock's announcement is the shell's to take; nothing answers it.
    d.effects.clear();
    d
}

#[test]
fn export_asks_three_times_and_the_file_goes_only_to_the_save_sheet() {
    let mut d = ready();
    let id = d.push(locker::TAB, routes::export("Locker"));
    let data = match export_state(&d, id).content {
        Some(wire::locker_export_state::Content::Data(data)) => *data,
        other => panic!("{other:?}"),
    };
    assert_eq!(data.what_value, "1 item, unencrypted");
    assert!(!data.commit_label.is_empty());
    // 1. the confirm names the consequence.
    export_event(&mut d, id, X::Commit(wire::locker_export_event::CommitTapped {}));
    assert!(export_state(&d, id).confirm.unwrap().destructive);
    let before = d.effects.len();
    // 2. the owner check, raised afresh.
    export_event(&mut d, id, X::Confirmed(wire::locker_export_event::Confirmed {}));
    assert!(effects_of(&d, before)
        .iter()
        .any(|k| matches!(k, wire::effect::Kind::OwnerCheck(c) if c.ask)));
    assert_eq!(
        export_state(&d, id).phase,
        wire::locker_export_state::Phase::Checking as i32
    );
    // 3. the core writes the receipt and the file, which goes to the save sheet.
    d.answer_effect(passed(wire::Biometry::Face));
    let saved: Vec<_> = effects_of(&d, 0);
    let file = saved
        .iter()
        .find_map(|k| match k {
            wire::effect::Kind::SaveFile(file) => Some(file.clone()),
            _ => None,
        })
        .expect("the save sheet is asked");
    assert!(String::from_utf8_lossy(&file.content).contains("correct horse"));
    assert_eq!(
        export_state(&d, id).phase,
        wire::locker_export_state::Phase::Saving as i32
    );
    // The save sheet answers: written.
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    let state = export_state(&d, id);
    assert_eq!(state.phase, wire::locker_export_state::Phase::Idle as i32);
    assert_eq!(state.status.unwrap().sentence, "File written. It holds every secret.");
}

#[test]
fn a_cancelled_owner_check_writes_nothing_and_a_dismissed_save_sheet_says_so() {
    let mut d = ready();
    let id = d.push(locker::TAB, routes::export("Locker"));
    export_event(&mut d, id, X::Commit(wire::locker_export_event::CommitTapped {}));
    export_event(&mut d, id, X::Confirmed(wire::locker_export_event::Confirmed {}));
    d.answer_effect(checked(wire::owner_checked::Outcome::Cancelled));
    let state = export_state(&d, id);
    assert_eq!(state.phase, wire::locker_export_state::Phase::Idle as i32);
    assert!(!state.status.unwrap().sentence.is_empty());
    // The access history shows no export.
    export_event(&mut d, id, X::Commit(wire::locker_export_event::CommitTapped {}));
    export_event(&mut d, id, X::Confirmed(wire::locker_export_event::Confirmed {}));
    d.answer_effect(passed(wire::Biometry::Face));
    d.answer_effect(wire::effect_result::Outcome::Failed(wire::EffectFailed {
        reason: "dismissed".to_owned(),
        denied: false,
        cancelled: true,
    }));
    let state = export_state(&d, id);
    assert!(!state.status.unwrap().refused, "a dismissed sheet is not a failure");
}

#[test]
fn import_plans_a_file_row_by_row_and_adds_only_on_publish() {
    let mut d = ready();
    let id = d.push(locker::TAB, routes::import("Locker"));
    let before = d.effects.len();
    d.send(
        id,
        E::LockerImport(wire::LockerImportEvent {
            kind: Some(I::Choose(wire::locker_import_event::ChooseTapped {})),
        }),
    );
    assert!(effects_of(&d, before)
        .iter()
        .any(|k| matches!(k, wire::effect::Kind::PickBytes(_))));
    let csv = "name,url,username,password\nGitHub,https://github.com,dev,s3cret\n";
    d.answer_effect(wire::effect_result::Outcome::BytesPicked(wire::BytesPicked {
        cancelled: false,
        name: "export.csv".to_owned(),
        media_type: "text/csv".to_owned(),
        content: csv.as_bytes().to_vec(),
    }));
    let state = import_state(&d, id);
    assert_eq!(state.phase, wire::locker_import_state::Phase::Planned as i32);
    let data = match state.content {
        Some(wire::locker_import_state::Content::Data(data)) => *data,
        other => panic!("{other:?}"),
    };
    assert_eq!(data.rows.len(), 1);
    assert_eq!(data.file_value, "export.csv");
    assert!(!data.publish_label.is_empty());
    d.send(
        id,
        E::LockerImport(wire::LockerImportEvent {
            kind: Some(I::Publish(wire::locker_import_event::PublishTapped {})),
        }),
    );
    let state = import_state(&d, id);
    assert_eq!(state.phase, wire::locker_import_state::Phase::Published as i32);
    assert!(state.status.unwrap().sentence.starts_with("Added 1"));
}

#[test]
fn a_file_that_is_not_a_password_manager_export_is_refused_in_words() {
    let mut d = ready();
    let id = d.push(locker::TAB, routes::import("Locker"));
    d.send(
        id,
        E::LockerImport(wire::LockerImportEvent {
            kind: Some(I::Choose(wire::locker_import_event::ChooseTapped {})),
        }),
    );
    d.answer_effect(wire::effect_result::Outcome::BytesPicked(wire::BytesPicked {
        cancelled: false,
        name: "x.bin".to_owned(),
        media_type: String::new(),
        content: vec![0, 1, 2, 3],
    }));
    let state = import_state(&d, id);
    assert_eq!(state.phase, wire::locker_import_state::Phase::Idle as i32);
    assert!(state.status.unwrap().refused);
}

#[test]
fn the_access_history_lists_every_receipt_and_never_a_value() {
    let mut d = ready();
    let item = push_item(&mut d, "i1");
    verb(&mut d, item, "password", "reveal");
    let id = d.push(locker::TAB, routes::access());
    d.pump(Duration::from_millis(200));
    let state = match &d.view(id).kind {
        Some(wire::view_state::Kind::LockerAccess(a)) => a.clone(),
        other => panic!("{other:?}"),
    };
    let data = match state.content {
        Some(wire::locker_access_state::Content::Data(data)) => data,
        other => panic!("{other:?}"),
    };
    let rows = data.history.unwrap().rows;
    assert!(rows.iter().any(|r| r.label == "Locker unlocked"));
    assert!(rows.iter().any(|r| r.label.contains("Password revealed") && r.label.contains("Bank")));
    assert!(rows.iter().all(|r| !format!("{r:?}").contains("correct horse")));
}

#[test]
fn the_trash_lists_what_went_and_is_behind_the_lock() {
    let mut d = ready();
    arrange(
        &d,
        centraid_screens::catalog::act::locker::TrashItem {
            locker_item_id: "i1".to_owned(),
        },
    );
    let id = d.push(locker::TAB, routes::trash());
    let view = match &d.view(id).kind {
        Some(wire::view_state::Kind::Trash(t)) => t.clone(),
        other => panic!("{other:?}"),
    };
    let rows = match view.content {
        Some(wire::trash_view::Content::Data(data)) => data.rows,
        other => panic!("{other:?}"),
    };
    assert_eq!(rows[0].title, "Bank");
    assert!(rows[0].meta.contains("Erased"), "{}", rows[0].meta);
    // Locked, the trash says the Locker is locked.
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: false,
    }));
    d.send(
        id,
        E::Trash(wire::TrashEvent {
            kind: Some(wire::trash_event::Kind::Refreshed(
                wire::trash_event::Refreshed {},
            )),
        }),
    );
    let view = match &d.view(id).kind {
        Some(wire::view_state::Kind::Trash(t)) => t.clone(),
        other => panic!("{other:?}"),
    };
    assert!(matches!(
        view.content,
        Some(wire::trash_view::Content::Denied(ref denied)) if denied.title == "Locker is locked."
    ));
}

#[test]
fn the_wall_page_asks_at_once_and_finishes_when_the_locker_opens() {
    let mut d = driver();
    d.start();
    // The home root asked as it opened; its check is not this page's.
    d.effects.clear();
    let id = d.push(locker::TAB, routes::lock());
    let state = |d: &centraid_screens::testing::Driver| match &d.view(id).kind {
        Some(wire::view_state::Kind::LockerLock(l)) => l.clone(),
        other => panic!("{other:?}"),
    };
    assert!(state(&d).wall.is_some() && !state(&d).finished);
    d.answer_effect(passed(wire::Biometry::Face));
    let opened = state(&d);
    assert!(opened.finished && opened.open && opened.wall.is_none());
}
