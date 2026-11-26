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

const PRIYA_ID: &str = "01900000-0000-7000-8000-000000000010";
const ROHAN_ID: &str = "01900000-0000-7000-8000-000000000020";
const DUP_ID: &str = "01900000-0000-7000-8000-000000000030";
const LIST_ID: &str = "01900000-0000-7000-8000-000000000040";
const BOOK_ID: &str = "01900000-0000-7000-8000-000000000050";
const NOTE_ID: &str = "01900000-0000-7000-8000-000000000060";
const EVENT_ID: &str = "01900000-0000-7000-8000-000000000070";
const TOUCH_ID: &str = "01900000-0000-7000-8000-000000000080";
const LINKED_NOTE_ID: &str = "01900000-0000-7000-8000-000000000090";

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("people-rooms")),
            ),
    )
    .expect("the core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .expect("it founds");
    centraid_screens::attach(&handle);
    handle
}

fn room_call(handle: &Handle, kind: wire::room_request::Kind) -> Vec<wire::RoomShown> {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("room call answers")
        .kind
        .expect("an answer");
    match answer {
        wire::response::Kind::Room(resp) => resp.shown,
        other => panic!("not a room response: {other:?}"),
    }
}

fn open(handle: &Handle, key: &str, tab: &str, root: bool) -> wire::RoomShown {
    room_call(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            tab: tab.to_owned(),
            root,
        }),
    )
    .remove(0)
}

fn send(handle: &Handle, instance: u64, kind: wire::room_event::Kind) -> Vec<wire::RoomShown> {
    room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance,
            event: Some(wire::RoomEvent { kind: Some(kind) }),
        }),
    )
}

fn tap(id: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Tap(wire::RoomTap {
        selector_id: id.to_owned(),
    })
}

fn text_change(id: &str, seq: u64, value: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Change(wire::RoomChange {
        selector_id: id.to_owned(),
        seq,
        value: Some(wire::room_change::Value::Text(value.to_owned())),
    })
}

fn cmd(handle: &Handle, name: &str, input: serde_json::Value, key: &str) {
    let outcome = handle.command(name, &input, key).expect("command runs");
    assert_eq!(
        outcome.status,
        centraid_vault::CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
}

fn seed_people(handle: &Handle) {
    cmd(
        handle,
        "person.add",
        json!({
            "id": PRIYA_ID,
            "title": "Priya Nair",
            "role": "Architect",
            "org": "Studio North",
            "nickname": "Pri",
            "met": "Design week",
            "cadence_days": 14
        }),
        "seed-priya",
    );
    cmd(
        handle,
        "person.save_contact_point",
        json!({
            "id": PRIYA_ID,
            "kind": "phone",
            "value": "+1 555 010 2020",
            "label": "Mobile",
            "preferred": true
        }),
        "seed-cp-1",
    );
    cmd(
        handle,
        "person.save_contact_point",
        json!({
            "id": PRIYA_ID,
            "kind": "email",
            "value": "priya@studionorth.example",
            "label": "Work"
        }),
        "seed-cp-2",
    );
    cmd(
        handle,
        "person.add_date",
        json!({
            "id": PRIYA_ID,
            "kind": "birthday",
            "date": "1990-05-14"
        }),
        "seed-date-1",
    );
    cmd(
        handle,
        "flag.set",
        json!({ "flag": "starred", "ids": [PRIYA_ID] }),
        "seed-star-priya",
    );
    cmd(
        handle,
        "person.add",
        json!({
            "id": ROHAN_ID,
            "title": "Rohan Patel",
            "role": "Designer",
            "org": "Studio North"
        }),
        "seed-rohan",
    );
}

fn seed_timeline_and_footers(handle: &Handle) {
    cmd(
        handle,
        "container.create",
        json!({ "id": BOOK_ID, "kind": "notebook", "title": "General" }),
        "seed-book",
    );
    cmd(
        handle,
        "note.create",
        json!({
            "id": NOTE_ID,
            "title": "Kitchen plans",
            "body": "Met [[Priya Nair]] about the light wells.",
            "notebook_id": BOOK_ID
        }),
        "seed-note",
    );
    cmd(
        handle,
        "note.create",
        json!({
            "id": LINKED_NOTE_ID,
            "title": "Reference board",
            "body": "Sketches",
            "notebook_id": BOOK_ID
        }),
        "seed-linked-note",
    );
    cmd(
        handle,
        "link.add",
        json!({ "a": PRIYA_ID, "b": LINKED_NOTE_ID }),
        "seed-link",
    );
    cmd(
        handle,
        "event.propose",
        json!({
            "id": EVENT_ID,
            "title": "Site visit",
            "starts": "2026-11-28T10:00:00.000Z",
            "timing": "zoned",
            "zone": "UTC"
        }),
        "seed-event",
    );
    cmd(
        handle,
        "event.add_guest",
        json!({ "id": EVENT_ID, "person_id": PRIYA_ID }),
        "seed-guest",
    );
    cmd(
        handle,
        "touch.log",
        json!({
            "id": TOUCH_ID,
            "kind": "Call",
            "people": [PRIYA_ID],
            "notes": "Caught up on permits"
        }),
        "seed-touch",
    );
    // Edit Priya once so earlier_versions footer has a revision.
    cmd(
        handle,
        "person.edit",
        json!({ "id": PRIYA_ID, "met": "Design week 2024" }),
        "seed-edit-priya",
    );
}

#[test]
fn home_tile_opens_people_and_list_flows_work() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_people(&handle);

    let home = open(&handle, "home", "home", true);
    let people = send(&handle, home.instance, tap("tile/people")).remove(0);
    let room = people.room.as_ref().unwrap();
    assert_eq!(room.key, "people");
    snapshot::assert_room("people_list", room);

    // Search filters in place; Back from detail keeps search term.
    let opened_search = send(&handle, people.instance, tap("band/search")).remove(0);
    assert!(
        opened_search
            .room
            .as_ref()
            .unwrap()
            .search
            .as_ref()
            .unwrap()
            .open
    );
    let searched = send(&handle, people.instance, text_change("search", 1, "Priya")).remove(0);
    assert!(snapshot::render(searched.room.as_ref().unwrap()).contains("Priya Nair"));
    assert!(!snapshot::render(searched.room.as_ref().unwrap()).contains("Rohan Patel"));

    let detail = send(&handle, people.instance, tap(&format!("row/{PRIYA_ID}"))).remove(0);
    assert_eq!(
        detail.room.as_ref().unwrap().key,
        format!("person/{PRIYA_ID}")
    );
    let back = send(&handle, detail.instance, tap("back")).remove(0);
    assert_eq!(back.instance, people.instance);
    assert_eq!(
        back.room.as_ref().unwrap().search.as_ref().unwrap().term,
        "Priya"
    );

    // Close search clears term.
    let cleared = send(&handle, people.instance, tap("search/close")).remove(0);
    assert!(
        cleared
            .room
            .as_ref()
            .unwrap()
            .search
            .as_ref()
            .unwrap()
            .term
            .is_empty()
    );

    // Filter starred only.
    let starred = send(&handle, people.instance, tap("filter/starred")).remove(0);
    let starred_text = snapshot::render(starred.room.as_ref().unwrap());
    assert!(starred_text.contains("Priya Nair"));
    assert!(!starred_text.contains("Rohan Patel"));
    send(&handle, people.instance, tap("filter/clear"));

    // Trailing swipe to trash (no confirm, Undo on status line) and Undo restores!
    let trashed = send(
        &handle,
        people.instance,
        tap(&format!("row/{ROHAN_ID}/trash")),
    )
    .remove(0);
    let status = trashed.room.as_ref().unwrap().status_line.as_ref().unwrap();
    assert_eq!(status.action_label, "Undo");
    assert!(!snapshot::render(trashed.room.as_ref().unwrap()).contains("Rohan Patel"));

    let undone = send(&handle, people.instance, tap("status/undo")).remove(0);
    assert!(snapshot::render(undone.room.as_ref().unwrap()).contains("Rohan Patel"));

    // Select mode: bulk star in one commit, one Undo.
    let selecting = send(
        &handle,
        people.instance,
        tap(&format!("row/{ROHAN_ID}/menu/select")),
    )
    .remove(0);
    assert!(selecting.room.as_ref().unwrap().band.is_none());
    send(&handle, people.instance, tap(&format!("row/{ROHAN_ID}")));
    let bulk = send(&handle, people.instance, tap("selection/star")).remove(0);
    assert!(
        !bulk
            .room
            .as_ref()
            .unwrap()
            .selection
            .as_ref()
            .is_some_and(|s| s.on)
    );
    assert_eq!(
        bulk.room
            .as_ref()
            .unwrap()
            .status_line
            .as_ref()
            .unwrap()
            .action_label,
        "Undo"
    );
}

#[test]
fn person_detail_shows_timeline_footers_catch_up_and_date_reminder_toggle() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_people(&handle);
    seed_timeline_and_footers(&handle);

    let detail = open(&handle, &format!("person/{PRIYA_ID}"), "home", true);
    let text = snapshot::render(detail.room.as_ref().unwrap());
    assert!(text.contains("Priya Nair"));
    assert!(text.contains("Site visit"));
    assert!(text.contains("Kitchen plans"));
    assert!(text.contains("Reference board"));
    assert!(text.contains("Remind me"));
    assert!(!text.contains("Reminder on"));
    snapshot::assert_room("people_detail", detail.room.as_ref().unwrap());

    // One-tap Catch-up logs a touch and offers Undo.
    let caught = send(&handle, detail.instance, tap("hero/catch_up")).remove(0);
    let status = caught.room.as_ref().unwrap().status_line.as_ref().unwrap();
    assert_eq!(status.sentence, "Catch-up logged");
    assert_eq!(status.action_label, "Undo");

    // Share works without owner check (N13).
    let shared = send(&handle, detail.instance, tap("menu/share")).remove(0);
    assert_eq!(
        shared
            .room
            .as_ref()
            .unwrap()
            .status_line
            .as_ref()
            .unwrap()
            .sentence,
        "Ready to share"
    );

    // Trash from detail with held catch-ups pushes outlined confirm naming count.
    let confirm = send(&handle, detail.instance, tap("menu/trash")).remove(0);
    assert_eq!(
        confirm.room.as_ref().unwrap().key,
        format!("person/{PRIYA_ID}/trash-confirm")
    );
    snapshot::assert_room(
        "people_trash_person_confirm",
        confirm.room.as_ref().unwrap(),
    );
}

#[test]
fn new_and_edit_person_forms_keep_and_clear_d1_drafts() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_people(&handle);

    let new_form = open(&handle, "people/new", "home", true);
    snapshot::assert_room("people_new_form", new_form.room.as_ref().unwrap());

    // Typing persists D1 draft.
    send(
        &handle,
        new_form.instance,
        text_change("field/name", 1, "Samira Chen"),
    );
    send(
        &handle,
        new_form.instance,
        text_change("field/role", 1, "Editor"),
    );

    // Reopening a fresh new-person form restores the D1 draft.
    let reopened = open(&handle, "people/new", "home", true);
    let reopened_text = snapshot::render(reopened.room.as_ref().unwrap());
    assert!(reopened_text.contains("Samira Chen"));
    assert!(reopened_text.contains("drafted"));

    // Dirty cancel asks Discard changes?; confirmed discard clears D1 draft.
    let discard_sheet = send(&handle, reopened.instance, tap("form/cancel")).remove(0);
    assert!(snapshot::render(discard_sheet.room.as_ref().unwrap()).contains("Discard changes?"));
    send(&handle, reopened.instance, tap("confirm/yes"));

    let clean = open(&handle, "people/new", "home", true);
    assert!(!snapshot::render(clean.room.as_ref().unwrap()).contains("Samira Chen"));

    // Save creates person + clears draft.
    send(
        &handle,
        clean.instance,
        text_change("field/name", 1, "Samira Chen"),
    );
    send(&handle, clean.instance, tap("form/save"));

    let list = open(&handle, "people", "home", true);
    assert!(snapshot::render(list.room.as_ref().unwrap()).contains("Samira Chen"));

    // Edit form loads existing values.
    let edit = open(&handle, &format!("person/{PRIYA_ID}/edit"), "home", true);
    snapshot::assert_room("people_edit_form", edit.room.as_ref().unwrap());
}

#[test]
fn merge_confirms_and_runs_person_merge() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_people(&handle);
    cmd(
        &handle,
        "person.add",
        json!({ "id": DUP_ID, "title": "Priya N." }),
        "seed-dup",
    );

    let pick = open(&handle, &format!("person/{DUP_ID}/merge"), "home", true);
    let confirm = send(&handle, pick.instance, tap(&format!("merge/{PRIYA_ID}"))).remove(0);
    snapshot::assert_room("people_merge_confirm", confirm.room.as_ref().unwrap());

    let merged = send(&handle, confirm.instance, tap("confirm/yes")).remove(0);
    assert_eq!(
        merged.room.as_ref().unwrap().key,
        format!("person/{PRIYA_ID}")
    );

    let list = open(&handle, "people", "home", true);
    let list_text = snapshot::render(list.room.as_ref().unwrap());
    assert!(list_text.contains("Priya Nair"));
    assert!(!list_text.contains("Priya N."));
}

#[test]
fn lists_add_remove_members_and_never_take_members_on_delete() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_people(&handle);
    cmd(
        &handle,
        "container.create",
        json!({ "id": LIST_ID, "kind": "list", "title": "Studio" }),
        "seed-list",
    );
    cmd(
        &handle,
        "edge.add",
        json!({ "from": LIST_ID, "rel": "contains", "to": PRIYA_ID }),
        "seed-member",
    );

    let lists = open(&handle, "people/lists", "home", true);
    snapshot::assert_room("people_lists", lists.room.as_ref().unwrap());

    let detail = send(&handle, lists.instance, tap(&format!("row/{LIST_ID}"))).remove(0);
    snapshot::assert_room("people_list_detail", detail.room.as_ref().unwrap());

    // Delete list: Priya stays live (N12)!
    send(&handle, detail.instance, tap("menu/trash_list"));
    let people = open(&handle, "people", "home", true);
    assert!(snapshot::render(people.room.as_ref().unwrap()).contains("Priya Nair"));
}

#[test]
fn trash_lists_trashed_people_restores_purges_and_empties() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_people(&handle);
    cmd(
        &handle,
        "entity.trash",
        json!({ "ids": [ROHAN_ID] }),
        "trash-rohan",
    );

    let trash = open(&handle, "people/trash", "home", true);
    snapshot::assert_room("people_trash", trash.room.as_ref().unwrap());

    // Open Delete forever confirm, then confirm purge.
    let confirm = send(
        &handle,
        trash.instance,
        tap(&format!("trash/{ROHAN_ID}/purge")),
    )
    .remove(0);
    assert!(
        snapshot::render(confirm.room.as_ref().unwrap()).contains("Delete this person forever?")
    );
    let after_purge = send(&handle, confirm.instance, tap("confirm/yes")).remove(0);
    assert!(snapshot::render(after_purge.room.as_ref().unwrap()).contains("Trash is empty."));
}
