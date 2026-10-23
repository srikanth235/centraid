//! Shared arrangement for Locker's Driver tests: a keyed core, items written
//! through the one write, and the owner check answered as a shell would.
#![allow(dead_code)]

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::Keyed;
use centraid_screens::kit::act as kit_act;
use centraid_screens::locker::{self, routes};
use centraid_screens::testing::Driver;
use wire::screen_event::Kind as E;

pub fn driver() -> Driver {
    Driver::keyed(locker::runtime())
}

/// Write through the one write. A write that seals a secret needs the Locker
/// open, so it is opened for the write and relocked after.
pub fn arrange(d: &Driver, request: impl Into<wire::ActRequest>) -> wire::ActResponse {
    let was_open = session(
        d,
        wire::locker_session_request::Step::State(wire::LockerStateAsk {}),
    )
    .state
        == wire::LockerSessionState::Unlocked as i32;
    unlock_core(d);
    let response = arrange_open(d, request);
    if !was_open {
        session(
            d,
            wire::locker_session_request::Step::Relock(wire::LockerRelock {}),
        );
    }
    response
}

fn arrange_open(d: &Driver, request: impl Into<wire::ActRequest>) -> wire::ActResponse {
    let response = d.act(
        request
            .into()
            .keyed(format!("arrange:{}", kit_act::fresh())),
    );
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "arranging was refused: {}",
        response.reason
    );
    response
}

/// The vault's session: a shell asks the core directly, as chat's card does.
pub fn session(
    d: &Driver,
    step: wire::locker_session_request::Step,
) -> wire::LockerSessionResponse {
    d.handle
        .locker_session(&wire::LockerSessionRequest { step: Some(step) })
        .expect("the session answers")
}

pub fn unlock_core(d: &Driver) {
    session(
        d,
        wire::locker_session_request::Step::Unlock(wire::LockerUnlock {}),
    );
}

/// A login with a password the wall protects.
pub fn login(d: &Driver, id: &str, title: &str) {
    arrange(
        d,
        act::locker::AddItem {
            title: title.to_owned(),
            r#type: act::locker::AddItemType::Login,
            item_id: Some(id.to_owned()),
            username: Some("maya@example.com".to_owned()),
            password: Some("correct horse".to_owned()),
            url: Some("example.com".to_owned()),
            ..act::locker::AddItem::default()
        },
    );
}

pub fn passed(biometry: wire::Biometry) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::OwnerChecked(wire::OwnerChecked {
        available: true,
        biometry: biometry as i32,
        outcome: wire::owner_checked::Outcome::Succeeded as i32,
    })
}

pub fn checked(outcome: wire::owner_checked::Outcome) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::OwnerChecked(wire::OwnerChecked {
        available: true,
        biometry: wire::Biometry::Face as i32,
        outcome: outcome as i32,
    })
}

/// Start the runtime, push Locker's home and pass the owner check.
pub fn open_home(d: &mut Driver) -> u64 {
    d.start();
    let home = home_instance(d);
    assert!(
        d.effects
            .iter()
            .any(|e| matches!(e.effect.as_ref().and_then(|e| e.kind.as_ref()), Some(wire::effect::Kind::OwnerCheck(c)) if c.ask)),
        "opening Locker asks the owner check"
    );
    d.answer_effect(passed(wire::Biometry::Face));
    home
}

pub fn home_instance(d: &Driver) -> u64 {
    d.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance
}

pub fn home(d: &Driver, id: u64) -> wire::LockerHomeState {
    match &d.view(id).kind {
        Some(wire::view_state::Kind::LockerHome(home)) => home.clone(),
        other => panic!("not Locker's home: {other:?}"),
    }
}

pub fn home_data(d: &Driver, id: u64) -> wire::LockerHomeData {
    match home(d, id).content {
        Some(wire::locker_home_state::Content::Data(data)) => *data,
        other => panic!("home has no data: {other:?}"),
    }
}

pub fn item(d: &Driver, id: u64) -> wire::LockerItemState {
    match &d.view(id).kind {
        Some(wire::view_state::Kind::LockerItem(item)) => item.clone(),
        other => panic!("not an item: {other:?}"),
    }
}

pub fn item_data(d: &Driver, id: u64) -> wire::LockerItemData {
    match item(d, id).content {
        Some(wire::locker_item_state::Content::Data(data)) => *data,
        other => panic!("item has no data: {other:?}"),
    }
}

pub fn row_of<'a>(data: &'a wire::LockerItemData, key: &str) -> &'a wire::LockerFieldRow {
    data.sections
        .iter()
        .flat_map(|section| &section.rows)
        .find(|row| row.key == key)
        .unwrap_or_else(|| panic!("no row `{key}`"))
}

pub fn home_event(d: &mut Driver, id: u64, event: wire::locker_home_event::Kind) {
    d.send(
        id,
        E::LockerHome(wire::LockerHomeEvent { kind: Some(event) }),
    );
}

pub fn item_event(d: &mut Driver, id: u64, event: wire::locker_item_event::Kind) {
    d.send(
        id,
        E::LockerItem(wire::LockerItemEvent { kind: Some(event) }),
    );
}

pub fn verb(d: &mut Driver, id: u64, key: &str, verb: &str) {
    item_event(
        d,
        id,
        wire::locker_item_event::Kind::Verb(wire::locker_item_event::VerbTapped {
            key: key.to_owned(),
            verb: verb.to_owned(),
        }),
    );
}

pub fn push_item(d: &mut Driver, item_id: &str) -> u64 {
    let id = d.push(locker::TAB, routes::item(item_id, "Locker", ""));
    id
}

pub fn effects_of(d: &Driver, from: usize) -> Vec<wire::effect::Kind> {
    d.effects[from..]
        .iter()
        .filter_map(|request| request.effect.as_ref()?.kind.clone())
        .collect()
}

pub fn pump(d: &mut Driver, wait: Duration) {
    d.pump(wait);
}

pub fn wall_of(d: &Driver, id: u64) -> Option<wire::LockerWall> {
    match &d.view(id).kind {
        Some(wire::view_state::Kind::LockerHome(home)) => home.wall.clone(),
        Some(wire::view_state::Kind::LockerItem(item)) => item.wall.clone(),
        Some(wire::view_state::Kind::LockerEditor(editor)) => editor.wall.clone(),
        Some(wire::view_state::Kind::LockerAccess(access)) => access.wall.clone(),
        Some(wire::view_state::Kind::LockerExport(export)) => export.wall.clone(),
        Some(wire::view_state::Kind::LockerImport(import)) => import.wall.clone(),
        Some(wire::view_state::Kind::LockerLock(lock)) => lock.wall.clone(),
        other => panic!("not a Locker view: {other:?}"),
    }
}
