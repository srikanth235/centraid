use std::path::Path;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::json;

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_795_687_200_000;

fn open(path: &Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the recovery phrase parses")
        .seed();
    Core::open(CoreConfig::new(path).with_seed(seed, 0).with_clock(
        std::sync::Arc::new(FixedClock::at(NOW)),
        std::sync::Arc::new(SeededIds::new("follow-restart")),
    ))
    .expect("the core opens")
}

fn call(handle: &Handle, request: wire::FollowRequest) -> wire::FollowResponse {
    match handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Follow(request)),
        })
        .expect("the core answers")
        .kind
    {
        Some(wire::response::Kind::Follow(response)) => response,
        other => panic!("unexpected response {other:?}"),
    }
}

fn enrol_store(handle: &Handle, system: &str) -> wire::ShellEffect {
    assert_eq!(
        call(
            handle,
            wire::FollowRequest {
                verb: wire::FollowVerb::Enrol as i32,
                system: system.to_owned(),
                ..Default::default()
            }
        )
        .asked,
        1
    );
    match handle
        .next_event(Duration::from_millis(100))
        .expect("the event queue reads")
        .expect("the core asks for a store read")
        .kind
    {
        Some(wire::event::Kind::Effect(effect)) => effect,
        other => panic!("unexpected event {other:?}"),
    }
}

fn enrol(handle: &Handle) -> wire::ShellEffect {
    enrol_store(handle, "contacts")
}

fn drain_events(handle: &Handle) {
    while handle
        .next_event(Duration::ZERO)
        .expect("the event queue reads")
        .is_some()
    {}
}

fn next_effect(handle: &Handle) -> wire::ShellEffect {
    loop {
        let event = handle
            .next_event(Duration::from_millis(100))
            .expect("the event queue reads")
            .expect("the core sends the queued read")
            .kind;
        if let Some(wire::event::Kind::Effect(effect)) = event {
            return effect;
        }
    }
}

fn next_store_read(handle: &Handle, system: &str) -> wire::ShellEffect {
    loop {
        let effect = next_effect(handle);
        if let Some(wire::shell_effect::Kind::StoreRead(read)) = effect.kind.as_ref()
            && read.system == system
        {
            return effect;
        }
    }
}

fn pass(handle: &Handle, ask: &wire::ShellEffect, input_json: String) -> wire::FollowResponse {
    call(
        handle,
        wire::FollowRequest {
            verb: wire::FollowVerb::Pass as i32,
            system: "contacts".to_owned(),
            ask_id: ask.effect_id,
            grant: wire::FollowGrant::Granted as i32,
            input_json,
            ..Default::default()
        },
    )
}

fn snapshot(title: &str) -> String {
    json!({
        "origin": {"ref": "icloud", "label": "iCloud", "device_id": "this-phone"},
        "records": [{
            "external_id": "contact-1",
            "device_id": "this-phone",
            "fields": {"title": title}
        }],
        "complete": false
    })
    .to_string()
}

fn title(handle: &Handle) -> Option<String> {
    let reader = centraid_domain::read::Reader::open(handle.path()).expect("reader opens");
    reader
        .run(
            &centraid_domain::apps::entity::BY_KIND_RECENT,
            &centraid_domain::read::Args::new().text("kind", "person"),
        )
        .expect("the title reads")
        .rows
        .into_iter()
        .find(|row| row.title == "First Name" || row.title == "Updated Name")
        .map(|row| row.title)
}

#[test]
fn the_first_follow_pass_after_a_restart_does_not_replay_the_previous_invoke_key() {
    let dir = tempfile::tempdir().expect("a vault directory");
    let path = dir.path().join("vault.sqlite3");
    {
        let handle = open(&path);
        let ask = enrol(&handle);
        let response = pass(&handle, &ask, snapshot("First Name"));
        assert!(!response.declined);
        assert_eq!(title(&handle).as_deref(), Some("First Name"));
    }
    let handle = open(&path);
    let ask = enrol(&handle);
    let response = pass(&handle, &ask, snapshot("Updated Name"));
    assert!(!response.declined);
    assert_eq!(title(&handle).as_deref(), Some("Updated Name"));
}

#[test]
fn a_failed_merge_clears_asking_and_reports_a_plain_sentence() {
    let dir = tempfile::tempdir().expect("a vault directory");
    let handle = open(&dir.path().join("vault.sqlite3"));
    let ask = enrol(&handle);
    let response = pass(&handle, &ask, "{".to_owned());
    assert!(response.declined);
    assert_eq!(
        response.sentence,
        "The phone store could not be read. Try again."
    );
    let status = call(
        &handle,
        wire::FollowRequest {
            verb: wire::FollowVerb::Status as i32,
            system: "contacts".to_owned(),
            ..Default::default()
        },
    )
    .status
    .expect("the follow status is present");
    assert!(!status.asking);
}

#[test]
fn a_failed_merge_sends_a_queued_ask() {
    let dir = tempfile::tempdir().expect("a vault directory");
    let handle = open(&dir.path().join("vault.sqlite3"));
    let initial = enrol(&handle);
    let first_pass = pass(&handle, &initial, snapshot("First Name"));
    assert!(!first_pass.declined);
    drain_events(&handle);
    assert_eq!(
        call(
            &handle,
            wire::FollowRequest {
                verb: wire::FollowVerb::Trigger as i32,
                system: "contacts".to_owned(),
                ..Default::default()
            }
        )
        .asked,
        1
    );
    let ask = next_effect(&handle);
    assert_eq!(
        call(
            &handle,
            wire::FollowRequest {
                verb: wire::FollowVerb::Trigger as i32,
                system: "contacts".to_owned(),
                ..Default::default()
            }
        )
        .asked,
        0
    );
    let response = pass(&handle, &ask, "{".to_owned());
    assert!(response.declined);
    assert_eq!(response.asked, 1);
    let _queued = next_effect(&handle);
}

#[test]
fn one_calendar_answer_merges_every_snapshot_and_reports_partial_reads() {
    let dir = tempfile::tempdir().expect("a vault directory");
    let handle = open(&dir.path().join("vault.sqlite3"));
    let ask = enrol_store(&handle, "calendar");
    let event = |external_id: &str, title: &str| {
        json!({
            "origin": {
                "ref": format!("calendar:{external_id}"),
                "label": title,
                "color": "teal"
            },
            "records": [{
                "external_id": external_id,
                "fields": {
                    "title": title,
                    "starts": "2026-03-02T09:00:00",
                    "ends": "2026-03-02T10:00:00",
                    "zone": "Europe/Paris"
                }
            }],
            "complete": false
        })
    };
    let response = call(
        &handle,
        wire::FollowRequest {
            verb: wire::FollowVerb::Pass as i32,
            system: "calendar".to_owned(),
            ask_id: ask.effect_id,
            grant: wire::FollowGrant::Limited as i32,
            input_json: json!({ "snapshots": [event("home", "Home"), event("work", "Work")] })
                .to_string(),
            ..Default::default()
        },
    );
    assert!(!response.declined);
    let status = call(
        &handle,
        wire::FollowRequest {
            verb: wire::FollowVerb::Status as i32,
            system: "calendar".to_owned(),
            ..Default::default()
        },
    )
    .status
    .expect("the follow status is present");
    assert!(status.read);
    assert_eq!(status.count, 2);
    assert!(status.incomplete);
    let reader = centraid_domain::read::Reader::open(handle.path()).expect("reader opens");
    let origins = reader
        .run(
            &centraid_domain::apps::entity::FOLLOWED_STORES,
            &centraid_domain::read::Args::new().text("system", "calendar"),
        )
        .expect("followed origins are readable");
    let refs: Vec<_> = origins
        .rows
        .into_iter()
        .map(|origin| origin.r#ref)
        .collect();
    assert!(refs.contains(&"calendar:home".to_owned()));
    assert!(refs.contains(&"calendar:work".to_owned()));
}

#[test]
fn one_reminders_answer_keeps_each_list_origin_and_parent_membership() {
    let dir = tempfile::tempdir().expect("a vault directory");
    let handle = open(&dir.path().join("vault.sqlite3"));
    let ask = enrol_store(&handle, "reminders");
    let list_snapshot = |ref_id: &str, label: &str, external_id: &str, title: &str| {
        json!({
            "origin": {"ref": ref_id, "label": label},
            "records": [{
                "external_id": external_id,
                "fields": {"title": title, "status": "open", "done_at": null}
            }],
            "complete": true
        })
    };
    let response = call(
        &handle,
        wire::FollowRequest {
            verb: wire::FollowVerb::Pass as i32,
            system: "reminders".to_owned(),
            ask_id: ask.effect_id,
            grant: wire::FollowGrant::Granted as i32,
            input_json: json!({
                "snapshots": [
                    list_snapshot("list:work", "Work", "reminder-work", "Send invoice"),
                    list_snapshot("list:home", "Home", "reminder-home", "Buy milk")
                ]
            })
            .to_string(),
            ..Default::default()
        },
    );
    assert!(!response.declined, "{}", response.sentence);
    let status = call(
        &handle,
        wire::FollowRequest {
            verb: wire::FollowVerb::Status as i32,
            system: "reminders".to_owned(),
            ..Default::default()
        },
    )
    .status
    .expect("the follow status is present");
    assert!(status.read);
    assert_eq!(status.count, 2);

    let reader = centraid_domain::read::Reader::open(handle.path()).expect("reader opens");
    let origins = reader
        .run(
            &centraid_domain::apps::entity::FOLLOWED_STORES,
            &centraid_domain::read::Args::new().text("system", "phone_reminders"),
        )
        .expect("reminder origins are readable");
    assert_eq!(origins.rows.len(), 2);
    for origin in origins.rows {
        let list = origin.fills.expect("each origin fills its own list");
        let tasks = reader
            .run(
                &centraid_domain::apps::reminders::IN_LIST,
                &centraid_domain::read::Args::new().text("list_id", &list),
            )
            .expect("list tasks are readable");
        assert_eq!(tasks.rows.len(), 1);
        let expected_title = if origin.r#ref == "list:work" {
            "Send invoice"
        } else {
            "Buy milk"
        };
        assert_eq!(tasks.rows[0].title, expected_title);
    }
}

#[test]
fn camera_roll_pages_merge_then_continue_from_the_committed_cursor() {
    let dir = tempfile::tempdir().expect("a vault directory");
    let handle = open(&dir.path().join("vault.sqlite3"));
    let ask = enrol_store(&handle, "camera_roll");
    let first_page = json!({
        "origin": {"ref": "camera-roll", "label": "Camera roll", "cursor": "page-2"},
        "records": [{
            "external_id": "photo-1",
            "size": 5,
            "fields": {
                "blob": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "media_type": "image/jpeg",
                "taken_at": "2025-07-01T10:00:00.000Z"
            }
        }],
        "complete": false
    });
    let response = call(
        &handle,
        wire::FollowRequest {
            verb: wire::FollowVerb::Pass as i32,
            system: "camera_roll".to_owned(),
            ask_id: ask.effect_id,
            grant: wire::FollowGrant::Granted as i32,
            input_json: first_page.to_string(),
            ..Default::default()
        },
    );
    assert!(!response.declined);
    assert_eq!(response.asked, 1);
    let next = next_store_read(&handle, "camera_roll");
    let read = match next.kind.expect("the next effect has a kind") {
        wire::shell_effect::Kind::StoreRead(read) => read,
        other => panic!("unexpected effect {other:?}"),
    };
    assert_eq!(read.cursor, "page-2");
    let final_page = json!({
        "origin": {"ref": "camera-roll", "label": "Camera roll", "cursor": "done"},
        "records": [],
        "complete": true
    });
    let response = call(
        &handle,
        wire::FollowRequest {
            verb: wire::FollowVerb::Pass as i32,
            system: "camera_roll".to_owned(),
            ask_id: next.effect_id,
            grant: wire::FollowGrant::Granted as i32,
            input_json: final_page.to_string(),
            ..Default::default()
        },
    );
    assert!(!response.declined);
    assert_eq!(response.asked, 0);
    let status = call(
        &handle,
        wire::FollowRequest {
            verb: wire::FollowVerb::Status as i32,
            system: "camera_roll".to_owned(),
            ..Default::default()
        },
    )
    .status
    .expect("the follow status is present");
    assert!(status.enrolled);
    assert!(status.read);
    assert_eq!(status.count, 1);
    assert!(!status.incomplete);
}
