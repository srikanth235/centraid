//! A late Follow reply from one vault cannot be accepted by the next vault in front.

mod vault_support;

use std::time::{Duration, Instant};

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Handle, vaults::Vaults as _};
use serde_json::json;
use vault_support::{Phone, lay_down, scratch};

fn follow(handle: &Handle, request: wire::FollowRequest) -> wire::FollowResponse {
    match handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Follow(request)),
        })
        .expect("the active vault answers Follow")
        .kind
    {
        Some(wire::response::Kind::Follow(answer)) => answer,
        other => panic!("expected Follow response, received {other:?}"),
    }
}

fn next_contacts_read(handle: &Handle) -> wire::ShellEffect {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let event = handle
            .next_event(left.min(Duration::from_millis(100)))
            .expect("the front event queue stays open");
        let Some(wire::event::Kind::Effect(effect)) = event.and_then(|event| event.kind) else {
            assert!(Instant::now() < deadline, "the contacts read arrives");
            continue;
        };
        if matches!(effect.kind.as_ref(), Some(wire::shell_effect::Kind::StoreRead(read)) if read.system == "contacts")
        {
            return effect;
        }
        assert!(Instant::now() < deadline, "the contacts read arrives");
    }
}

fn snapshot(title: &str) -> String {
    json!({
        "origin": { "ref": "phone", "label": "Phone" },
        "complete": false,
        "records": [{
            "external_id": title,
            "fields": { "title": title }
        }]
    })
    .to_string()
}

fn enrol(handle: &Handle, title: &str) {
    let response = follow(
        handle,
        wire::FollowRequest {
            verb: wire::FollowVerb::Enrol as i32,
            system: "contacts".to_owned(),
            ..Default::default()
        },
    );
    assert_eq!(response.asked, 1);
    let ask = next_contacts_read(handle);
    let pass = follow(
        handle,
        wire::FollowRequest {
            verb: wire::FollowVerb::Pass as i32,
            system: "contacts".to_owned(),
            ask_id: ask.effect_id,
            grant: wire::FollowGrant::Granted as i32,
            input_json: snapshot(title),
            ..Default::default()
        },
    );
    assert!(!pass.declined);
}

fn trigger(handle: &Handle) -> wire::ShellEffect {
    let response = follow(
        handle,
        wire::FollowRequest {
            verb: wire::FollowVerb::Trigger as i32,
            system: "contacts".to_owned(),
            ..Default::default()
        },
    );
    assert_eq!(response.asked, 1);
    next_contacts_read(handle)
}

fn titles(handle: &Handle) -> Vec<String> {
    centraid_domain::read::Reader::open(handle.path())
        .expect("vault reader opens")
        .run(
            &centraid_domain::apps::entity::BY_KIND_RECENT,
            &centraid_domain::read::Args::new().text("kind", "person"),
        )
        .expect("people list is readable")
        .rows
        .into_iter()
        .map(|row| row.title)
        .collect()
}

#[test]
fn a_late_contacts_pass_cannot_cross_vaults_and_returning_reasks() {
    let dir = scratch();
    let a_id = lay_down(&dir, "a", "A");
    let b_id = lay_down(&dir, "b", "B");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.record_index(&a_id, 0);
    phone.record_index(&b_id, 1);
    phone.launch();
    assert!(phone.shelf.bring_to_front(&a_id));
    let front = phone.driver.handle.clone();
    let _a = phone.shelf.core_of(&a_id).expect("A is open");
    let b = phone.shelf.core_of(&b_id).expect("B is open");

    enrol(&front, "A Original");
    assert!(phone.shelf.bring_to_front(&b_id));
    enrol(&front, "B Original");
    let b_old = trigger(&front);

    assert!(phone.shelf.bring_to_front(&a_id));
    let a_late = next_contacts_read(&front);
    assert_ne!(a_late.effect_id, b_old.effect_id);

    assert!(phone.shelf.bring_to_front(&b_id));
    let b_fresh = next_contacts_read(&front);
    assert_ne!(a_late.effect_id, b_fresh.effect_id);
    assert_ne!(b_old.effect_id, b_fresh.effect_id);

    let late = follow(
        &front,
        wire::FollowRequest {
            verb: wire::FollowVerb::Pass as i32,
            system: "contacts".to_owned(),
            ask_id: a_late.effect_id,
            grant: wire::FollowGrant::Granted as i32,
            input_json: snapshot("A Late Reply Must Stay In A"),
            ..Default::default()
        },
    );
    assert!(late.stale, "the reply must not be merged into B");
    assert!(titles(&b).contains(&"B Original".to_owned()));
    assert!(!titles(&b).contains(&"A Late Reply Must Stay In A".to_owned()));
    let b_status = follow(
        &front,
        wire::FollowRequest {
            verb: wire::FollowVerb::Status as i32,
            system: "contacts".to_owned(),
            ..Default::default()
        },
    )
    .status
    .expect("B status is present");
    assert!(
        b_status.asking,
        "the late A result leaves B's fresh ask active"
    );

    assert!(phone.shelf.bring_to_front(&a_id));
    let a_fresh = next_contacts_read(&front);
    assert_ne!(a_late.effect_id, a_fresh.effect_id);
    let a_status = follow(
        &front,
        wire::FollowRequest {
            verb: wire::FollowVerb::Status as i32,
            system: "contacts".to_owned(),
            ..Default::default()
        },
    )
    .status
    .expect("A status is present");
    assert!(
        a_status.asking,
        "returning A has a fresh ask instead of a stuck one"
    );
}
