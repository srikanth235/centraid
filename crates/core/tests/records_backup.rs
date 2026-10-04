//! THE VAULT'S RECORDS — WHAT THE APPS KEEP — THROUGH THE BACKUP PLANE
//! (#1080, the adversarial sweep's S rows).
//!
//! Photographs are files; notes, tasks, documents, the tally and the people
//! a member keeps are rows, and a snapshot is how rows are backed up: the
//! vault copied page for page, its ranges named by their bytes, the head set
//! once every range is acknowledged. These cases write through the apps' own
//! commands and ask what a restore brings back — every row, a consistent
//! moment, what is in the WAL — and when a snapshot is taken, and what the
//! gateway keeps of the snapshots it no longer needs.

mod common;

use std::path::{Path, PathBuf};

use centraid_api_proto::core_v1 as wire;
use centraid_core::Handle;
use centraid_vault::backup::naming::Name;
use centraid_vault::backup::snapshot::Manifest;
use serde_json::json;

use common::*;

/// One command's output, by name and input; `key` makes it idempotent.
fn run(phone: &Handle, name: &str, input: &serde_json::Value, key: &str) -> serde_json::Value {
    command(phone, name, input, key)
}

fn id_of(output: &serde_json::Value, field: &str) -> String {
    output[field]
        .as_str()
        .unwrap_or_else(|| panic!("no {field} in {output}"))
        .to_owned()
}

/// The vault's own calendar and owner, which founding seeds.
fn calendar_and_owner(phone: &Handle) -> (String, String) {
    phone
        .with_vault(|vault| {
            Ok(vault.read(|connection| {
                Ok(centraid_vault::testdoor::the_founded_calendar(connection))
            })?)
        })
        .expect("reads")
        .expect("founding seeds a calendar")
}

/// The manifest of the head this phone set at its gateway.
fn head_manifest(path: &Path) -> (Name, Manifest) {
    let book = ledger(path);
    let id = book.destinations().expect("reads")[0].gateway_id.clone();
    let head = book.head(&id).expect("reads").expect("a head");
    let taken = book
        .snapshots()
        .expect("reads")
        .into_iter()
        .find(|snapshot| snapshot.name == head)
        .expect("this phone took its head");
    (
        head,
        Manifest::from_json(taken.manifest_json.as_bytes()).expect("a manifest"),
    )
}

/// **EVERY APP'S RECORDS COME BACK ROW FOR ROW** (#1080, S1). Notes, tasks,
/// documents, the tally, people, an event and a photograph, each written,
/// edited and deleted through its app's own commands before the pass; a
/// restore onto a new phone holds every table exactly as the phone did.
#[test]
fn every_apps_records_come_back_row_for_row() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let (calendar, me) = calendar_and_owner(&phone);

    // NOTES: three written, one edited, one deleted.
    let notes: Vec<String> = (0..3)
        .map(|index| {
            id_of(
                &run(
                    &phone,
                    "knowledge.create_note",
                    &json!({ "title": format!("Note {index}"), "body_text": format!("body {index}"), "format": "plain" }),
                    &format!("note-{index}"),
                ),
                "note_id",
            )
        })
        .collect();
    run(
        &phone,
        "knowledge.edit_note",
        &json!({ "note_id": notes[0], "body_text": "body 0, edited" }),
        "edit-note-0",
    );
    run(
        &phone,
        "knowledge.delete_note",
        &json!({ "note_id": notes[1] }),
        "delete-note-1",
    );
    // TASKS: three added, one completed, one edited, one deleted.
    let tasks: Vec<String> = (0..3)
        .map(|index| {
            id_of(
                &run(
                    &phone,
                    "schedule.add_task",
                    &json!({ "title": format!("Task {index}") }),
                    &format!("task-{index}"),
                ),
                "task_id",
            )
        })
        .collect();
    run(
        &phone,
        "schedule.set_task_status",
        &json!({ "task_id": tasks[0], "status": "completed" }),
        "complete-task-0",
    );
    run(
        &phone,
        "schedule.edit_task",
        &json!({ "task_id": tasks[1], "title": "Task 1, renamed" }),
        "edit-task-1",
    );
    run(
        &phone,
        "schedule.delete_task",
        &json!({ "task_id": tasks[2] }),
        "delete-task-2",
    );
    // AN EVENT on the calendar founding seeded.
    run(
        &phone,
        "schedule.propose_event",
        &json!({
            "summary": "Dentist", "dtstart": "2026-11-02", "dtend": "2026-11-02",
            "recurrence_semantics": "all-day", "calendar_id": calendar,
        }),
        "event-0",
    );
    // DOCUMENTS: two made, one edited, one trashed.
    let documents: Vec<String> = (0..2)
        .map(|index| {
            id_of(
                &run(
                    &phone,
                    "core.create_text_document",
                    &json!({ "title": format!("Doc {index}"), "body_text": format!("draft {index}") }),
                    &format!("doc-{index}"),
                ),
                "document_id",
            )
        })
        .collect();
    run(
        &phone,
        "core.edit_document",
        &json!({ "document_id": documents[0], "body_text": "draft 0, edited" }),
        "edit-doc-0",
    );
    run(
        &phone,
        "core.trash_document",
        &json!({ "document_id": documents[1] }),
        "trash-doc-1",
    );
    // THE TALLY: two friends, a group, two expenses, one deleted.
    let ana = id_of(
        &run(
            &phone,
            "tally.add_friend",
            &json!({ "name": "Ana" }),
            "friend-ana",
        ),
        "party_id",
    );
    let bo = id_of(
        &run(
            &phone,
            "tally.add_friend",
            &json!({ "name": "Bo" }),
            "friend-bo",
        ),
        "party_id",
    );
    let group = id_of(
        &run(
            &phone,
            "tally.create_group",
            &json!({ "name": "Flat", "icon": "🏠", "currency": "EUR", "member_ids": [ana, bo] }),
            "group-flat",
        ),
        "group_id",
    );
    let expenses: Vec<String> = (0..2)
        .map(|index| {
            id_of(
                &run(
                    &phone,
                    "tally.add_expense",
                    &json!({
                        "group_id": group, "description": format!("Groceries {index}"),
                        "amount_minor": 3_000, "paid_by": me, "category": "food",
                        "spent_on": "2026-10-01",
                        "splits": [
                            { "party_id": me, "share_minor": 1_000 },
                            { "party_id": ana, "share_minor": 1_000 },
                            { "party_id": bo, "share_minor": 1_000 },
                        ],
                    }),
                    &format!("expense-{index}"),
                ),
                "expense_id",
            )
        })
        .collect();
    run(
        &phone,
        "tally.delete_expense",
        &json!({ "expense_id": expenses[1] }),
        "delete-expense-1",
    );
    // PEOPLE: two added, one edited.
    let ray = id_of(
        &run(
            &phone,
            "people.add_person",
            &json!({ "display_name": "Ray", "cadence_days": 0 }),
            "person-ray",
        ),
        "party_id",
    );
    run(
        &phone,
        "people.add_person",
        &json!({ "display_name": "Sol", "cadence_days": 30 }),
        "person-sol",
    );
    run(
        &phone,
        "people.edit_person",
        &json!({ "party_id": ray, "display_name": "Ray", "role": "Grandfather" }),
        "edit-ray",
    );
    // A PHOTOGRAPH, with its thumbnail.
    let photo = bytes_of("a photograph among the records", 40_000);
    let staged = stage(&phone, owned("image/heic", &photo), &photo);
    let thumb = bytes_of("its thumbnail among the records", 3_000);
    stage(&phone, thumb_of(&staged, &thumb), &thumb);
    add_asset(&phone, &staged, "photo");

    let drained = drain(&phone, at_home());
    assert!(drained.acked_at_ms.is_some(), "{drained:?}");
    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    let restored_path = PathBuf::from(&restored.vaults[0].path);
    let (lost, back) = (rows(&path), rows(&restored_path));
    let differing: Vec<&String> = lost
        .keys()
        .chain(back.keys())
        .filter(|table| lost.get(*table) != back.get(*table))
        .collect();
    assert!(differing.is_empty(), "rows differ in {differing:?}");
    for table in [
        "knowledge_note",
        "schedule_task",
        "core_event",
        "core_document",
        "tally_expense",
        "people_profile",
        "media_asset",
    ] {
        assert!(
            lost.get(table).is_some_and(|rows| !rows.is_empty()),
            "{table} holds rows the restore had to bring back"
        );
    }
}

/// **RECORDS WRITTEN AFTER THE LAST SNAPSHOT WAIT FOR THE NEXT ONE; BACK UP
/// NOW TAKES IT** (#1080, S2). A snapshot is taken on a pass the shell asks
/// one of (Back up now, the app leaving the screen, a restore), at a gateway
/// newly paired, and an hour after the last head — not on every pass. Within
/// that hour a note written after the head is in no snapshot, and the
/// status's "records backed up" time is the head's, before the note.
#[test]
fn records_written_after_the_last_snapshot_wait_for_the_next() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let notes = |phone: &Handle| {
        phone
            .with_vault(|vault| {
                Ok(vault.read(|connection| {
                    Ok(centraid_vault::testdoor::note_titles(connection).len())
                })?)
            })
            .expect("counts")
    };
    let headed = |path: &Path| head_manifest(path).1.census.get("knowledge_note").copied();
    run(
        &phone,
        "knowledge.create_note",
        &json!({ "title": "First", "body_text": "before the head", "format": "plain" }),
        "first",
    );
    let first = drain(&phone, at_home());
    let acked = status(&phone).acked_at_ms;
    assert!(acked.is_some() && first.acked_at_ms.is_some());
    assert_eq!(headed(&path), Some(1));

    // A NOTE AFTER THE HEAD, AND AN ORDINARY PASS WITHIN THE HOUR.
    run(
        &phone,
        "knowledge.create_note",
        &json!({ "title": "Second", "body_text": "after the head", "format": "plain" }),
        "second",
    );
    let quiet = drain(&phone, quietly());
    assert!(quiet.acked_at_ms.is_none(), "no snapshot: {quiet:?}");
    assert_eq!(notes(&phone), 2);
    assert_eq!(headed(&path), Some(1), "a restore now brings back one note");
    assert_eq!(
        status(&phone).acked_at_ms,
        acked,
        "the screen's records time is the head's"
    );

    // BACK UP NOW TAKES THE RECORDS IT WAS ASKED TO BACK UP.
    let tapped = drain(
        &phone,
        wire::DrainRequest {
            asked: true,
            ..at_home()
        },
    );
    assert!(tapped.acked_at_ms.is_some(), "{tapped:?}");
    assert_eq!(headed(&path), Some(2));

    // AN HOUR AFTER THE LAST HEAD, AN ORDINARY PASS TAKES ONE. The hour is
    // told to the ledger rather than waited out: its snapshots' times are
    // moved back past it.
    run(
        &phone,
        "knowledge.create_note",
        &json!({ "title": "Third", "body_text": "an hour later", "format": "plain" }),
        "third",
    );
    let book = ledger(&path);
    for snapshot in book.snapshots().expect("reads") {
        book.forget_snapshot(&snapshot.name).expect("forgets");
        book.record_snapshot(
            &snapshot.name,
            snapshot.taken_at_ms - 3_700_000,
            &snapshot.manifest_json,
        )
        .expect("an hour passes");
        if let Some(acked) = snapshot.acked_ms {
            book.ack_snapshot(&snapshot.name, acked)
                .expect("acknowledged");
        }
    }
    let hourly = drain(&phone, quietly());
    assert!(
        hourly.acked_at_ms.is_some(),
        "the hourly snapshot: {hourly:?}"
    );
    assert_eq!(headed(&path), Some(3));
}

/// **A SNAPSHOT ASKED FOR WHILE THE GATEWAY IS AWAY IS TAKEN WHEN IT IS
/// BACK** (#1080, the Android emulator smoke). The app leaving the screen asks
/// for a snapshot; with the laptop asleep that pass reaches nothing and takes
/// none. The next pass is the periodic worker's, which asks for none — and it
/// used to take none, so a note written just before leaving waited for the
/// hour after the last head while passes reached the gateway every window.
#[test]
fn a_snapshot_asked_for_while_the_gateway_sleeps_is_taken_when_it_wakes() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let headed = |path: &Path| head_manifest(path).1.census.get("knowledge_note").copied();
    run(
        &phone,
        "knowledge.create_note",
        &json!({ "title": "First", "body_text": "before the head", "format": "plain" }),
        "first",
    );
    drain(&phone, at_home());
    assert_eq!(headed(&path), Some(1));

    // A NOTE, THEN THE APP LEAVES THE SCREEN WITH THE LAPTOP ASLEEP.
    run(
        &phone,
        "knowledge.create_note",
        &json!({ "title": "Second", "body_text": "written before leaving", "format": "plain" }),
        "second",
    );
    gateway.cable().cut();
    let away = drain(&phone, at_home());
    assert_eq!(away.stopped, wire::DrainStop::Unreachable as i32, "{away:?}");
    assert_eq!(headed(&path), Some(1));

    // AWAKE: THE WORKER'S PASS, WHICH ASKS FOR NO SNAPSHOT, TAKES THE OWED ONE.
    let _awake = gateway.restart();
    let window = drain(&phone, quietly());
    assert!(window.acked_at_ms.is_some(), "the owed snapshot: {window:?}");
    assert_eq!(headed(&path), Some(2), "a restore now brings back both notes");

    // OWED ONCE: the next window is an ordinary one again.
    let next = drain(&phone, quietly());
    assert!(next.acked_at_ms.is_none(), "no second snapshot: {next:?}");
}

/// **A SNAPSHOT TAKEN WHILE THE APPS WRITE IS ONE MOMENT** (#1080, S3). A
/// writer commits notes as fast as it can while passes snapshot; whatever
/// head a restore brings back opens, passes `integrity_check` and
/// `foreign_key_check`, matches its census, and holds exactly the notes
/// written before some moment — never a later note without an earlier one.
#[test]
fn a_snapshot_taken_while_the_apps_write_is_one_moment() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = std::sync::Arc::new(phone(dir.path()));
    pair(&phone, &gateway);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let phone = std::sync::Arc::clone(&phone);
        let stop = std::sync::Arc::clone(&stop);
        std::thread::spawn(move || {
            let mut written = 0_u32;
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                run(
                    &phone,
                    "knowledge.create_note",
                    &json!({
                        "title": format!("n{written:05}"),
                        "body_text": format!("written in order, number {written}"),
                        "format": "plain",
                    }),
                    &format!("racing-{written}"),
                );
                written += 1;
            }
            written
        })
    };
    for _ in 0..4 {
        let drained = drain(&phone, at_home());
        assert!(drained.acked_at_ms.is_some(), "{drained:?}");
    }
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let written = writer.join().expect("the writer");
    assert!(written > 0);

    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    let path = PathBuf::from(&restored.vaults[0].path);
    let report = centraid_vault::backup::restore::restore_check(&path).expect("checks");
    assert!(report.is_clean(), "{report:?}");
    let mut titles: Vec<String> = centraid_vault::Vault::open(&path)
        .expect("opens")
        .read(|connection| Ok(centraid_vault::testdoor::note_titles(connection)))
        .expect("reads");
    titles.sort();
    let expected: Vec<String> = (0..titles.len())
        .map(|index| format!("n{index:05}"))
        .collect();
    assert_eq!(titles, expected, "a prefix of what was written, no gap");
}

/// **WHAT IS IN THE WAL IS IN THE SNAPSHOT** (#1080, S4). Records committed
/// and not yet checkpointed live in `vault.db-wal`; the snapshot reads
/// through it, so a restore brings them back.
#[test]
fn what_is_in_the_wal_is_in_the_snapshot() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    drain(&phone, at_home());
    for index in 0..20 {
        run(
            &phone,
            "knowledge.create_note",
            &json!({ "title": format!("In the WAL {index}"), "body_text": "not checkpointed", "format": "plain" }),
            &format!("wal-{index}"),
        );
    }
    let wal = std::fs::metadata(dir.path().join("vault.db-wal"))
        .map(|meta| meta.len())
        .unwrap_or(0);
    assert!(wal > 0, "the notes are in the WAL");
    let drained = drain(&phone, at_home());
    assert!(drained.acked_at_ms.is_some(), "{drained:?}");
    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    let back = rows(&PathBuf::from(&restored.vaults[0].path));
    assert_eq!(back.get("knowledge_note").map(Vec::len), Some(20));
    assert_eq!(back, rows(&path));
}

/// What a pass killed between moving a snapshot's parts and setting the head
/// leaves: the snapshot taken, described, asked about, spooled and moved
/// through the plane exactly as a pass does — and no `settle`.
fn moved_and_not_settled(phone: &Handle, path: &Path) -> Name {
    let keyring = keys();
    let book = ledger(path);
    let destination = book.destinations().expect("reads").remove(0);
    let runtime = runtime();
    let store = centraid_core::phone::link::GatewayStore::for_destination(
        &destination,
        keyring.vault_id(),
        runtime.handle(),
    )
    .expect("a store");
    let scratch = path.with_extension("scratch");
    let copied = phone
        .with_vault(|vault| {
            Ok(centraid_vault::backup::snapshot::copy(vault, &scratch).expect("copies"))
        })
        .expect("the vault");
    let taken = centraid_vault::backup::snapshot::describe(
        &copied,
        &keyring.backup,
        &keyring.vault_hex(),
        "a pass the phone did not live to finish",
    )
    .expect("describes");
    let planned = centraid_vault::backup::snapshot::plan(&taken, &store).expect("plans");
    centraid_vault::backup::snapshot::confirm_held(
        &taken,
        &planned,
        &book,
        &destination.gateway_id,
        1,
    )
    .expect("confirms");
    let spool = centraid_vault::backup::spool::Spool::open(path.with_extension("spool"))
        .expect("the spool");
    centraid_vault::backup::snapshot::spool(
        &taken,
        &planned,
        &spool,
        &book,
        &keyring.backup,
        u64::MAX,
        1,
    )
    .expect("spools");
    let moved = centraid_vault::backup::mover::move_queue(
        &book,
        &spool,
        &store,
        std::time::Instant::now() + std::time::Duration::from_secs(60),
        &centraid_vault::clock::SystemClock,
    )
    .expect("moves");
    assert_eq!(moved.stopped, centraid_vault::backup::mover::Stop::Empty);
    let _ = std::fs::remove_dir_all(&scratch);
    taken.manifest_name
}

/// **A SNAPSHOT CUT SHORT BETWEEN ITS PARTS AND ITS HEAD** (#1080, S5). The
/// previous head stays the one a restore brings back; the next ordinary pass
/// finishes the cut snapshot — every part of it is acknowledged — and sets
/// it as the head; and the head it superseded is collected.
#[test]
fn a_snapshot_cut_short_before_its_head_is_finished_by_the_next_pass() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    run(
        &phone,
        "knowledge.create_note",
        &json!({ "title": "Headed", "body_text": "in the head", "format": "plain" }),
        "headed",
    );
    drain(&phone, at_home());
    let (previous, previous_manifest) = head_manifest(&path);
    run(
        &phone,
        "knowledge.create_note",
        &json!({ "title": "Cut", "body_text": "in the cut snapshot", "format": "plain" }),
        "cut",
    );
    let cut = moved_and_not_settled(&phone, &path);
    assert_eq!(
        gateway.writer(&vault_id()).1,
        Some(previous),
        "the head did not move"
    );
    drop(phone);

    let phone = reopen(&path);
    let drained = drain(&phone, quietly());
    assert!(
        drained.acked_at_ms.is_some(),
        "the cut snapshot is finished: {drained:?}"
    );
    assert_eq!(gateway.writer(&vault_id()).1, Some(cut), "and is the head");
    let (_, manifest) = head_manifest(&path);
    let held = gateway.held(&vault_id());
    let superseded: Vec<Name> = previous_manifest
        .range_names()
        .difference(&manifest.range_names())
        .filter(|name| held.contains(name))
        .copied()
        .collect();
    assert!(
        superseded.is_empty() && !held.contains(&previous),
        "the superseded head is collected: {superseded:?}"
    );
    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    assert_eq!(rows(&PathBuf::from(&restored.vaults[0].path)), rows(&path));
}

/// **A SNAPSHOT CUT SHORT AND THEN SUPERSEDED LEAKS NOTHING** (#1080, S5).
/// Back up now takes a new snapshot over the cut one; the cut snapshot was
/// never a head and nothing keeps it, so its manifest and the ranges only it
/// named are collected rather than kept forever.
#[test]
fn a_snapshot_cut_short_and_superseded_leaks_nothing() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    drain(&phone, at_home());
    run(
        &phone,
        "knowledge.create_note",
        &json!({ "title": "Cut", "body_text": "in the cut snapshot", "format": "plain" }),
        "cut",
    );
    let cut = moved_and_not_settled(&phone, &path);
    run(
        &phone,
        "knowledge.create_note",
        &json!({ "title": "Later", "body_text": "after the cut", "format": "plain" }),
        "later",
    );
    let tapped = drain(
        &phone,
        wire::DrainRequest {
            asked: true,
            ..at_home()
        },
    );
    assert!(tapped.acked_at_ms.is_some(), "{tapped:?}");
    assert_ne!(gateway.writer(&vault_id()).1, Some(cut));
    assert!(
        !gateway.held(&vault_id()).contains(&cut),
        "the cut snapshot's manifest is collected"
    );
}

/// **MANY SNAPSHOTS: THE GATEWAY KEEPS WHAT RETENTION KEEPS, AND NO MORE**
/// (#1080, S6). Each head drops the one before it on the same day; the ranges
/// only a dropped snapshot named are tombstoned and, past the grace, purged —
/// so the records' storage is bounded by what is kept — and the current head
/// never loses a range it names.
#[test]
fn many_snapshots_keep_the_gateway_bounded() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    for round in 0..6 {
        run(
            &phone,
            "knowledge.create_note",
            &json!({ "title": format!("Round {round}"), "body_text": "x".repeat(4_000), "format": "plain" }),
            &format!("round-{round}"),
        );
        let drained = drain(&phone, at_home());
        assert!(drained.acked_at_ms.is_some(), "round {round}: {drained:?}");
    }
    let (head, manifest) = head_manifest(&path);
    let mut kept = manifest.range_names();
    kept.insert(head);
    let held = gateway.held(&vault_id());
    let extra: Vec<&Name> = held.difference(&kept).collect();
    assert!(
        extra.is_empty(),
        "the gateway holds what no kept snapshot names: {extra:?}"
    );
    assert!(held.is_superset(&kept), "the head lost nothing it names");
    let objects = gateway.objects(&vault_id()).len();
    assert!(objects > held.len(), "what was dropped is tombstoned");

    // PAST THE GRACE, THE PURGE TAKES THE BYTES.
    gateway.spawned.advance_clock(8 * 24 * 60 * 60 * 1000);
    let purged = gateway
        .runtime
        .block_on(gateway.spawned.purge_now())
        .expect("purges");
    assert_eq!(purged as usize, objects - held.len());
    assert_eq!(gateway.objects(&vault_id()).len(), held.len());
    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    assert_eq!(rows(&PathBuf::from(&restored.vaults[0].path)), rows(&path));
}

/// **A FILE IS BACKED UP ONCE ITS BYTES AND ITS ROW ARE** (#1080, S2; the
/// root's simulator repro: "Backed up · All 75 photos and files" while the
/// three newest photographs' rows were in no snapshot, so a restore then
/// would have returned 72). Ordinary passes move a new file's bytes and take
/// no snapshot within the hour; its row reaches the gateway only with the
/// next one. Until then it is not counted as backed up, and Free up space
/// does not offer to delete it from the library: lost with the phone, it
/// would be bytes on a gateway that no restored vault names.
#[test]
fn a_file_is_backed_up_once_its_bytes_and_its_row_are() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    drain(&phone, at_home());

    // A PHOTOGRAPH AND A LIBRARY STILL, MOVED BY AN ORDINARY PASS.
    let photo = bytes_of("a photograph taken after the head", 60_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    add_asset(&phone, &photo_handle, "photo");
    let still = bytes_of("a library still taken after the head", 50_001);
    let still_handle = stage(
        &phone,
        library("image/heic", "lib-new", &still, false),
        &still,
    );
    add_asset(&phone, &still_handle, "photo");
    let quiet = drain(&phone, quietly());
    assert!(quiet.acked_at_ms.is_none(), "no snapshot: {quiet:?}");
    assert!(quiet.confirmed_parts >= 2, "the bytes moved: {quiet:?}");
    let waits = status(&phone);
    assert_eq!(
        (waits.content_confirmed, waits.content_total),
        (0, 2),
        "bytes without a row a restore brings back are not a backup: {:?}",
        waits.waiting
    );
    assert_eq!(
        waiting(&waits, wire::WaitReason::Window),
        2,
        "{:?}",
        waits.waiting
    );
    let releasable = |phone: &Handle| {
        let wire::response::Kind::Releasable(offered) = ask(
            phone,
            wire::request::Kind::Releasable(wire::ReleasableRequest { limit: 10 }),
        ) else {
            panic!("releasable answers");
        };
        offered
    };
    assert!(
        releasable(&phone).items.is_empty(),
        "nothing is offered for deletion before its row is backed up"
    );

    // THE NEXT SNAPSHOT TAKES THE ROWS.
    let tapped = drain(
        &phone,
        wire::DrainRequest {
            asked: true,
            ..at_home()
        },
    );
    assert!(tapped.acked_at_ms.is_some(), "{tapped:?}");
    let backed = status(&phone);
    assert_eq!((backed.content_confirmed, backed.content_total), (2, 2));
    assert!(backed.waiting.is_empty(), "{:?}", backed.waiting);
    assert_eq!(
        releasable(&phone).items.len(),
        1,
        "the still is offered now"
    );
}
