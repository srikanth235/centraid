use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_screens::room::snapshot;
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::json;

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_781_517_600_000; // 2026-06-15T10:00:00Z

const CAL_ID: &str = "01900000-0000-7000-8000-000000000101";
const EV_STANDUP: &str = "01900000-0000-7000-8000-000000000102";
const EV_INVITE: &str = "01900000-0000-7000-8000-000000000103";
const LIST_WORK: &str = "01900000-0000-7000-8000-000000000201";
const TASK_TODAY: &str = "01900000-0000-7000-8000-000000000202";
const TASK_OVERDUE: &str = "01900000-0000-7000-8000-000000000203";
const TASK_SUB: &str = "01900000-0000-7000-8000-000000000204";
const TASK_DONE: &str = "01900000-0000-7000-8000-000000000205";
const TASK_INBOX: &str = "01900000-0000-7000-8000-000000000206";
const PERSON_ID: &str = "01900000-0000-7000-8000-000000000301";

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("wave1-rooms")),
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
            ..Default::default()
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

fn option_change(id: &str, seq: u64, value: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Change(wire::RoomChange {
        selector_id: id.to_owned(),
        seq,
        value: Some(wire::room_change::Value::Option(value.to_owned())),
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

fn seed_world(handle: &Handle) {
    cmd(
        handle,
        "container.create",
        json!({ "id": CAL_ID, "kind": "calendar", "title": "Family", "color": "petrol" }),
        "seed-cal",
    );
    cmd(
        handle,
        "person.add",
        json!({ "id": PERSON_ID, "title": "Priya Nair" }),
        "seed-person",
    );
    cmd(
        handle,
        "person.add_date",
        json!({ "id": PERSON_ID, "kind": "birthday", "date": "1990-06-15" }),
        "seed-bday",
    );
    cmd(
        handle,
        "event.propose",
        json!({
            "id": EV_STANDUP,
            "title": "Morning standup",
            "starts": "2026-06-15T09:00",
            "ends": "2026-06-15T09:30",
            "timing": "floating",
            "calendar_id": CAL_ID,
            "location": "Kitchen",
            "rule": "FREQ=WEEKLY",
            "reminders": [15],
            "guests": [{ "person_id": PERSON_ID, "status": "accepted" }]
        }),
        "seed-ev1",
    );
    cmd(
        handle,
        "event.propose",
        json!({
            "id": EV_INVITE,
            "title": "Design review",
            "starts": "2026-06-15T14:00",
            "ends": "2026-06-15T15:00",
            "timing": "floating",
            "calendar_id": CAL_ID,
            "guests": [{ "address": "alex@example.com", "name": "Alex", "status": "needs-action" }],
            "arrived_via": "ics",
            "arrived_label": "invite.ics"
        }),
        "seed-ev2",
    );
    cmd(
        handle,
        "container.create",
        json!({ "id": LIST_WORK, "kind": "task_list", "title": "Work" }),
        "seed-list",
    );
    cmd(
        handle,
        "task.add",
        json!({
            "id": TASK_TODAY,
            "title": "Send invoice",
            "due": "2026-06-15",
            "parent_id": LIST_WORK,
            "priority": 1
        }),
        "seed-task1",
    );
    cmd(
        handle,
        "task.add",
        json!({
            "id": TASK_OVERDUE,
            "title": "Renew passport",
            "due": "2026-06-10",
            "parent_id": LIST_WORK
        }),
        "seed-task2",
    );
    cmd(
        handle,
        "task.add",
        json!({
            "id": TASK_SUB,
            "title": "Attach receipt",
            "parent_id": TASK_TODAY
        }),
        "seed-sub",
    );
    cmd(
        handle,
        "task.add",
        json!({
            "id": TASK_DONE,
            "title": "Book flights",
            "due": "2026-06-14",
            "done_at": "2026-06-14T18:00:00.000Z"
        }),
        "seed-done",
    );
    cmd(
        handle,
        "task.add",
        json!({ "id": TASK_INBOX, "title": "Pay water bill" }),
        "seed-inbox-task",
    );
    cmd(
        handle,
        "flag.set",
        json!({ "flag": "starred", "ids": [TASK_TODAY] }),
        "seed-star",
    );
}

fn room_of(shown: &wire::RoomShown) -> &wire::Room {
    shown.room.as_ref().expect("a room")
}

#[test]
fn calendar_day_grid_needs_reply_detail_ics_and_trash() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = phone(dir.path());
    seed_world(&handle);

    let root = open(&handle, "calendar", "calendar", true);
    snapshot::assert_room("calendar_day", room_of(&root));

    // Switch lens to week and verify D3 persistence.
    let week = send(
        &handle,
        root.instance,
        option_change("choice/view", 1, "week"),
    )
    .remove(0);
    let rendered = snapshot::render(room_of(&week));
    assert!(rendered.contains("calendar_grid week"), "{rendered}");

    // Filter to Needs reply: only Design review remains.
    let filtered = send(&handle, week.instance, tap("filter/needs-reply/item")).remove(0);
    let ftext = snapshot::render(room_of(&filtered));
    assert!(ftext.contains("Design review"), "{ftext}");
    assert!(!ftext.contains("Morning standup"), "{ftext}");

    // Open event detail.
    let detail = open(
        &handle,
        &format!("calendar/event/{EV_STANDUP}"),
        "calendar",
        false,
    );
    snapshot::assert_room("calendar_event_detail", room_of(&detail));

    // Snooze alert from event detail.
    let snoozed = send(&handle, detail.instance, tap("alert/snooze")).remove(0);
    assert!(snapshot::render(room_of(&snoozed)).contains("Snoozed until"));

    // Import .ics flow.
    let import_room = open(&handle, "calendar/import-ics", "calendar", false);
    let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Imported Picnic\r\nDTSTART:20260615T160000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let _ = send(
        &handle,
        import_room.instance,
        text_change("field/ics", 1, ics),
    );
    let imported = send(&handle, import_room.instance, tap("form/save")).remove(0);
    let status = room_of(&imported).status_line.as_ref().expect("status");
    assert_eq!(status.sentence, "Imported 1 event");

    // Trash calendar confirm names held event count.
    let confirm = open(
        &handle,
        &format!("calendar/calendar/{CAL_ID}/trash-confirm"),
        "calendar",
        false,
    );
    let ctext = snapshot::render(room_of(&confirm));
    assert!(ctext.contains("2 events"), "{ctext}");
}

#[test]
fn reminders_smart_lists_subtasks_typed_date_chips_and_holder_confirm() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = phone(dir.path());
    seed_world(&handle);

    cmd(
        &handle,
        "task.edit",
        json!({ "id": TASK_INBOX, "title": "Pay water bill next week" }),
        "edit-inbox-task",
    );
    let versions = open(
        &handle,
        &format!("reminders/task/{TASK_INBOX}/versions"),
        "reminders",
        false,
    );
    assert!(snapshot::render(room_of(&versions)).contains("Restore"));
    let restored = send(&handle, versions.instance, tap("version/1")).remove(0);
    assert_eq!(
        room_of(&restored)
            .status_line
            .as_ref()
            .unwrap()
            .action_label,
        "Undo"
    );
    let restored_task = open(
        &handle,
        &format!("reminders/task/{TASK_INBOX}"),
        "reminders",
        false,
    );
    let restored_text = snapshot::render(room_of(&restored_task));
    assert!(restored_text.contains("Pay water bill"));
    assert!(!restored_text.contains("next week"));

    let root = open(&handle, "reminders", "reminders", true);
    snapshot::assert_room("reminders_today", room_of(&root));
    let root_text = snapshot::render(room_of(&root));
    assert!(root_text.contains("Inbox"));
    assert!(
        root_text.contains("1 open"),
        "only the one open unfiled task counts: {root_text}"
    );
    let inbox = open(&handle, "reminders/inbox", "reminders", false);
    assert!(snapshot::render(room_of(&inbox)).contains("Pay water bill"));
    assert!(!snapshot::render(room_of(&inbox)).contains("Book flights"));

    // Switch to Completed smart list (exercises task_by_done).
    let root = send(&handle, inbox.instance, tap("back")).remove(0);
    let completed = send(
        &handle,
        root.instance,
        option_change("choice/smart", 1, "completed"),
    )
    .remove(0);
    assert!(snapshot::render(room_of(&completed)).contains("Book flights"));

    // Task detail with subtask (one level).
    let detail = open(
        &handle,
        &format!("reminders/task/{TASK_TODAY}"),
        "reminders",
        false,
    );
    snapshot::assert_room("reminders_task_detail", room_of(&detail));

    // Subtask detail must NOT offer "Add subtask" (N5/S6: one level only).
    let sub_detail = open(
        &handle,
        &format!("reminders/task/{TASK_SUB}"),
        "reminders",
        false,
    );
    assert!(!snapshot::render(room_of(&sub_detail)).contains("Add subtask"));

    // Typed date chip on New reminder form (N18).
    let form = open(&handle, "reminders/new", "reminders", false);
    let typed = send(
        &handle,
        form.instance,
        text_change("field/title", 1, "Buy milk tomorrow"),
    )
    .remove(0);
    let ftext = snapshot::render(room_of(&typed));
    assert!(ftext.contains("Buy milk"), "{ftext}");
    assert!(ftext.contains("Tomorrow"), "{ftext}");
    assert!(ftext.contains("Tue 16 Jun"), "{ftext}");

    let ambiguous = send(
        &handle,
        form.instance,
        text_change("field/title", 2, "Pay utilities tomorrow or Friday"),
    )
    .remove(0);
    assert!(snapshot::render(room_of(&ambiguous)).contains("date wording is unclear"));
    let refused = send(&handle, ambiguous.instance, tap("form/save")).remove(0);
    assert!(room_of(&refused).status_line.as_ref().unwrap().refused);

    // A reopened draft keeps the ambiguous-date guard; entering one exact date only previews it.
    let reopened_form = open(&handle, "reminders/new", "reminders", false);
    assert!(snapshot::render(room_of(&reopened_form)).contains("date wording is unclear"));
    let refused = send(&handle, reopened_form.instance, tap("form/save")).remove(0);
    assert!(room_of(&refused).status_line.as_ref().unwrap().refused);
    let preview = send(
        &handle,
        reopened_form.instance,
        text_change("field/due", 1, "2026-06-18"),
    )
    .remove(0);
    let preview_text = snapshot::render(room_of(&preview));
    assert!(
        preview_text.contains("Review before adding"),
        "{preview_text}"
    );
    assert!(preview_text.contains("Add reminder"), "{preview_text}");
    let added = send(&handle, reopened_form.instance, tap("form/save")).remove(0);
    assert_eq!(
        room_of(&added).status_line.as_ref().unwrap().sentence,
        "Reminder added"
    );

    // Holder trash confirm names held task count.
    let confirm = open(
        &handle,
        &format!("reminders/list/{LIST_WORK}/trash-confirm"),
        "reminders",
        false,
    );
    let ctext = snapshot::render(room_of(&confirm));
    assert!(ctext.contains("2 tasks"), "{ctext}");
}

#[test]
fn home_springboard_and_vault_wide_search_with_correction_and_containers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = phone(dir.path());
    seed_world(&handle);

    let home = open(&handle, "home", "home", true);
    snapshot::assert_room("home_springboard", room_of(&home));

    // Open search and search with a 1-letter typo ("standap" -> "standup").
    let opened = send(&handle, home.instance, tap("search")).remove(0);
    let searched = send(
        &handle,
        opened.instance,
        text_change("search", 1, "standap"),
    )
    .remove(0);
    let search_slot = room_of(&searched).search.as_ref().expect("search slot");
    assert!(search_slot.corrected.contains("standup"), "{search_slot:?}");
    assert!(search_slot.ask.is_some());
    assert!(snapshot::render(room_of(&searched)).contains("Morning standup"));

    // Search for a container ("Work") populates RoomSearch.containers.
    let container_search =
        send(&handle, searched.instance, text_change("search", 2, "Work")).remove(0);
    let cslot = room_of(&container_search)
        .search
        .as_ref()
        .expect("search slot");
    assert!(
        cslot.containers.iter().any(|c| c.title == "Work"),
        "{:?}",
        cslot.containers
    );
}

#[test]
fn restore_inverse_undo_restores_edited_event_and_refuses_when_changed_since() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = phone(dir.path());
    seed_world(&handle);

    cmd(
        &handle,
        "event.edit",
        json!({ "id": EV_STANDUP, "title": "Evening standup" }),
        "edit-event-for-version-restore",
    );
    let versions = open(
        &handle,
        &format!("calendar/event/{EV_STANDUP}/versions"),
        "calendar",
        false,
    );
    assert!(snapshot::render(room_of(&versions)).contains("Restore"));
    let restored = send(&handle, versions.instance, tap("version/1")).remove(0);
    assert_eq!(
        room_of(&restored)
            .status_line
            .as_ref()
            .unwrap()
            .action_label,
        "Undo"
    );
    let restored_event = open(
        &handle,
        &format!("calendar/event/{EV_STANDUP}"),
        "calendar",
        false,
    );
    let restored_text = snapshot::render(room_of(&restored_event));
    assert!(restored_text.contains("Morning standup"));
    assert!(!restored_text.contains("Evening standup"));

    // Open event detail, then push edit form, rename it, and save.
    let _detail = open(
        &handle,
        &format!("calendar/event/{EV_STANDUP}"),
        "calendar",
        true,
    );
    let edit = open(
        &handle,
        &format!("calendar/event/{EV_STANDUP}/edit"),
        "calendar",
        false,
    );
    let _ = send(
        &handle,
        edit.instance,
        text_change("field/title", 1, "Evening standup"),
    );
    let saved = send(&handle, edit.instance, tap("form/save")).remove(0);
    assert!(
        snapshot::render(room_of(&saved)).contains("Evening standup"),
        "{}",
        snapshot::render(room_of(&saved))
    );
    let line = room_of(&saved).status_line.as_ref().expect("status line");
    assert!(
        !line.action_selector_id.is_empty(),
        "Restore-inverse edit must offer Undo: {line:?}"
    );

    // Tap Undo directly on the revealed detail room.
    let undone = send(&handle, saved.instance, tap("status/undo")).remove(0);
    let uline = room_of(&undone).status_line.as_ref().expect("undo status");
    assert!(!uline.refused, "{uline:?}");
    assert_eq!(uline.sentence, "Undone");
    assert!(
        snapshot::render(room_of(&undone)).contains("Morning standup"),
        "{}",
        snapshot::render(room_of(&undone))
    );

    // Edit again, then mutate out-of-band so Undo refuses with CHANGED_SINCE.
    let edit2 = open(
        &handle,
        &format!("calendar/event/{EV_STANDUP}/edit"),
        "calendar",
        false,
    );
    let _ = send(
        &handle,
        edit2.instance,
        text_change("field/title", 1, "Late standup"),
    );
    let saved2 = send(&handle, edit2.instance, tap("form/save")).remove(0);
    cmd(
        &handle,
        "event.edit",
        json!({ "id": EV_STANDUP, "title": "Another edit" }),
        "external-edit",
    );
    let refused = send(&handle, saved2.instance, tap("status/undo")).remove(0);
    let rline = room_of(&refused)
        .status_line
        .as_ref()
        .expect("refused status");
    assert!(rline.refused, "{rline:?}");
    assert_eq!(
        rline.sentence,
        "This can no longer be undone: it has changed since."
    );
}
