use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_screens::room::snapshot;
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::json;

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_795_687_200_000;

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the recovery phrase parses")
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("search-fts")),
            ),
    )
    .expect("the core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .expect("the vault is founded");
    centraid_screens::attach(&handle);
    handle
}

fn call(handle: &Handle, kind: wire::room_request::Kind) -> Vec<wire::RoomShown> {
    match handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("the room call answers")
        .kind
    {
        Some(wire::response::Kind::Room(response)) => response.shown,
        other => panic!("unexpected response {other:?}"),
    }
}

fn open(handle: &Handle, key: &str) -> wire::RoomShown {
    call(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            tab: "home".to_owned(),
            root: true,
            ..Default::default()
        }),
    )
    .remove(0)
}

fn send(handle: &Handle, instance: u64, event: wire::room_event::Kind) -> wire::RoomShown {
    let event_detail = format!("{event:?}");
    let response = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(wire::room_request::Kind::Send(wire::RoomSend {
                    instance,
                    event: Some(wire::RoomEvent { kind: Some(event) }),
                })),
            })),
        })
        .expect("the room send answers");
    match response.kind {
        Some(wire::response::Kind::Room(response)) => {
            let detail = format!("{response:?}");
            response
                .shown
                .into_iter()
                .next()
                .unwrap_or_else(|| panic!("send {event_detail} returned no shown room: {detail}"))
        }
        other => panic!("unexpected response {other:?}"),
    }
}

fn tap(selector_id: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Tap(wire::RoomTap {
        selector_id: selector_id.to_owned(),
    })
}

fn command(handle: &Handle, title: &str, body: &str, key: &str) {
    let outcome = handle
        .command("note.create", &json!({"title": title, "body": body}), key)
        .expect("the note is created");
    assert_eq!(outcome.status, centraid_vault::CommandStatus::Executed);
}

fn drain_events(handle: &Handle) {
    while handle
        .next_event(std::time::Duration::ZERO)
        .expect("the event read answers")
        .is_some()
    {}
}

fn search_start(handle: &Handle, term: &str) -> wire::RoomShown {
    let mut home = open(handle, "home");
    if home.room.as_ref().is_some_and(|room| room.key == "welcome") {
        home = send(handle, home.instance, tap("welcome/start"));
    }
    let search_selector = home
        .room
        .as_ref()
        .and_then(|room| room.band.as_ref())
        .map(|band| band.search_selector_id.as_str())
        .expect("Home has a search band");
    let opened = send(handle, home.instance, tap(search_selector));
    let term_selector = opened
        .room
        .as_ref()
        .and_then(|room| room.search.as_ref())
        .map(|search| search.selector_id.as_str())
        .expect("the search field is open");
    send(
        handle,
        opened.instance,
        wire::room_event::Kind::Change(wire::RoomChange {
            selector_id: term_selector.to_owned(),
            seq: 1,
            value: Some(wire::room_change::Value::Text(term.to_owned())),
        }),
    )
}

fn search(handle: &Handle, term: &str) -> String {
    let shown = search_start(handle, term);
    snapshot::render(shown.room.as_ref().expect("Home is shown"))
}

#[test]
fn home_search_uses_fts_across_pages_non_ascii_and_note_bodies() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = phone(dir.path());
    command(
        &handle,
        "Zzz Archive target",
        "lighthouseindex",
        "archive-old-target",
    );
    for index in 0..120 {
        command(
            &handle,
            &format!("Archive {index:03}"),
            "archive body",
            &format!("archive-{index}"),
        );
    }
    command(
        &handle,
        "Façade",
        "A note body has a unique searchable word.",
        "body-only",
    );

    let first = search_start(&handle, "Archive");
    let mut rendered = snapshot::render(first.room.as_ref().expect("Home is shown"));
    assert!(
        !rendered.contains("Zzz Archive target"),
        "the old target fit in page one: {rendered}"
    );
    let instance = first.instance;
    for _ in 0..20 {
        let shown = send(&handle, instance, tap("search/more"));
        rendered = snapshot::render(shown.room.as_ref().expect("Home is shown"));
        if rendered.contains("Zzz Archive target") {
            break;
        }
    }
    assert!(
        rendered.contains("Zzz Archive target"),
        "the created-first title hit is missing after paging: {rendered}"
    );

    let unicode = search(&handle, "façade");
    assert!(
        unicode.contains("Façade"),
        "the non-ASCII hit is missing: {unicode}"
    );

    handle
        .command(
            "workout.log",
            &json!({
                "type": "run",
                "title": "Cardio session",
                "starts": "2026-03-04T07:00:00Z",
                "notes": "strideonlyneedle"
            }),
            "workout-search-fixture",
        )
        .expect("the workout is logged");
    let workout = search(&handle, "strideonlyneedle");
    assert!(
        workout.contains("Cardio session"),
        "the workout hit is missing: {workout}"
    );

    let first_body = search_start(&handle, "lighthouseindex");
    let body = snapshot::render(first_body.room.as_ref().expect("Home is shown"));
    assert!(
        body.contains("Zzz Archive target"),
        "the created-first body-only hit is missing: {body}"
    );
}

#[test]
fn home_search_finds_unindexed_containers_past_a_page_with_unicode_folding() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = phone(dir.path());
    for index in 0..105 {
        handle
            .command(
                "container.create",
                &json!({
                    "kind": "list",
                    "title": format!("List {index:03}")
                }),
                &format!("search-list-{index:03}"),
            )
            .expect("a list is created");
    }
    handle
        .command(
            "container.create",
            &json!({ "kind": "list", "title": "ZZZ Café" }),
            "search-list-cafe",
        )
        .expect("the accent-bearing list is created");

    let shown = search_start(&handle, "cafe");
    let rendered = snapshot::render(shown.room.as_ref().expect("Home is shown"));
    assert!(
        rendered.contains("ZZZ Café"),
        "the paged, Unicode-folded list suggestion is missing: {rendered}"
    );
    assert!(
        !rendered.contains("No results"),
        "Home showed the no-result block despite a list suggestion: {rendered}"
    );
}

#[test]
fn a_raw_deep_link_is_resolved_to_the_registered_item_room() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = phone(dir.path());
    let shown = call(
        &handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            deep_link: "centraid://open/event/event-1".to_owned(),
            tab: "home".to_owned(),
            root: true,
            ..Default::default()
        }),
    )
    .remove(0);
    assert_eq!(
        shown.room.expect("the item room is shown").key,
        "calendar/event/event-1"
    );
}

#[test]
fn home_search_opens_the_exact_item_room_for_a_result() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = phone(dir.path());
    let outcome = handle
        .command(
            "note.create",
            &json!({"title": "Exact route note", "body": ""}),
            "exact-route",
        )
        .expect("the note is created");
    let id = outcome.output["id"].as_str().expect("the note id");
    let home = search_start(&handle, "Exact route");
    let detail = send(&handle, home.instance, tap(&format!("search/hit/{id}")));
    assert_eq!(
        detail.room.expect("the item room opens").key,
        format!("notes/note/{id}")
    );
}

#[test]
fn home_search_finds_only_plain_locker_text_while_locked_and_opens_the_wall() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = phone(dir.path());
    let item = "01900000-0000-7000-8000-000000000801";
    let password_field = centraid_vault::commands::locker::field_id_of(item, "password");
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the recovery phrase parses")
        .seed();
    let key = centraid_identity::derive::restore_vault_keys(&seed, 0)
        .expect("the vault keys derive")
        .locker;
    let key_id = handle
        .with_vault(|vault| {
            vault
                .locker_generation()
                .map_err(|error| centraid_core::CoreError::InvalidRequest {
                    detail: error.to_string(),
                })
        })
        .expect("the key generation is available");
    let cipher = centraid_vault::custody::locker_key::encrypt_under_locker_key(
        key.as_bytes(),
        &key_id,
        &password_field,
        "neverindexedsecretword",
    )
    .expect("the secret is sealed");
    let created = handle
        .command(
            "locker.add_item",
            &json!({
                "item_id": item,
                "type": "login",
                "title": "Public Locker Target",
                "fields": [
                    { "field_key": "username", "value": "plainlockerneedle" },
                    { "field_key": "password", "value": cipher, "key_id": key_id }
                ]
            }),
            "search-locker-fixture",
        )
        .expect("the Locker fixture is created");
    assert_eq!(created.status, centraid_vault::CommandStatus::Executed);

    let shown = search_start(&handle, "plainlockerneedle");
    let rendered = snapshot::render(shown.room.as_ref().expect("Home is shown"));
    assert!(rendered.contains("Public Locker Target"), "{rendered}");
    let wall = send(&handle, shown.instance, tap(&format!("search/hit/{item}")));
    assert_eq!(wall.room.as_ref().unwrap().key, "locker");
    assert!(wall.room.as_ref().unwrap().secure);
    assert!(!snapshot::render(wall.room.as_ref().unwrap()).contains("Public Locker Target"));

    let secret = search(&handle, "neverindexedsecretword");
    assert!(!secret.contains("Public Locker Target"), "{secret}");
}

#[test]
fn ask_from_home_keeps_the_typed_search_term_in_the_new_chat() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = phone(dir.path());
    let home = search_start(&handle, "question about these notes");
    let chat = send(&handle, home.instance, tap("search/ask"));
    assert_eq!(chat.room.as_ref().unwrap().key, "chat");
    assert!(
        snapshot::render(chat.room.as_ref().unwrap())
            .contains("Question: question about these notes"),
        "the typed term should travel into the new chat context"
    );
}

#[test]
fn a_commit_refreshes_an_open_fts_query_so_purged_rows_disappear() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = phone(dir.path());
    let created = handle
        .command(
            "note.create",
            &json!({ "title": "Purgeable search row", "body": "" }),
            "purgeable-search-row",
        )
        .expect("the note is created");
    let id = created.output["id"].as_str().unwrap();
    drain_events(&handle);
    let first = search_start(&handle, "Purgeable");
    assert!(snapshot::render(first.room.as_ref().unwrap()).contains("Purgeable search row"));

    handle
        .command("entity.trash", &json!({ "ids": [id] }), "trash-search-row")
        .expect("the note is trashed");
    handle
        .command("entity.purge", &json!({ "id": id }), "purge-search-row")
        .expect("the note is purged");
    let mut refreshed = None;
    while let Some(event) = handle
        .next_event(std::time::Duration::from_millis(20))
        .unwrap()
    {
        if let Some(wire::event::Kind::Room(shown)) = event.kind
            && shown.instance == first.instance
        {
            refreshed = shown.room;
        }
    }
    let refreshed = refreshed.expect("the changed Home search is pushed");
    let rendered = snapshot::render(&refreshed);
    assert!(
        !rendered.contains("Purgeable search row"),
        "stale result survived: {rendered}"
    );
}
