//! THE VAULT'S RECORDS — WHAT THE APPS KEEP — THROUGH THE BACKUP PLANE
//! (#1080, the adversarial sweep's S rows).
//!
//! Photographs are files; notes, tasks, documents and the people
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
fn head_manifest(path: &Path, gateway: &Gateway) -> (Name, Manifest) {
    let book = state(path);
    let id = book.gateways().expect("reads")[0].gateway_id.clone();
    let head = head_of(path, &id);
    (head, manifest_at(gateway, &head))
}

/// **EVERY APP'S RECORDS COME BACK ROW FOR ROW** (#1080, S1). Notes, tasks,
/// documents, people, an event and a photograph, each written,
/// edited and deleted through its app's own commands before the pass; a
/// restore onto a new phone holds every table exactly as the phone did.
#[test]
fn every_apps_records_come_back_row_for_row() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let (calendar, _owner) = calendar_and_owner(&phone);

    // NOTES: three written, one edited, one deleted.
    let notes: Vec<String> = (0..3)
        .map(|index| {
            id_of(
                &run(
                    &phone,
                    "note.create",
                    &json!({ "title": format!("Note {index}"), "body": format!("body {index}"), "format": "plain" }),
                    &format!("note-{index}"),
                ),
                "id",
            )
        })
        .collect();
    run(
        &phone,
        "note.edit",
        &json!({ "id": notes[0], "body": "body 0, edited" }),
        "edit-note-0",
    );
    run(
        &phone,
        "entity.trash",
        &json!({ "id": notes[1] }),
        "delete-note-1",
    );
    // TASKS: three added, one completed, one edited, one deleted.
    let tasks: Vec<String> = (0..3)
        .map(|index| {
            id_of(
                &run(
                    &phone,
                    "task.add",
                    &json!({ "title": format!("Task {index}") }),
                    &format!("task-{index}"),
                ),
                "id",
            )
        })
        .collect();
    run(
        &phone,
        "task.complete",
        &json!({ "id": tasks[0] }),
        "complete-task-0",
    );
    run(
        &phone,
        "task.edit",
        &json!({ "id": tasks[1], "title": "Task 1, renamed" }),
        "edit-task-1",
    );
    run(
        &phone,
        "entity.trash",
        &json!({ "id": tasks[2] }),
        "delete-task-2",
    );
    // AN EVENT on the calendar founding seeded.
    run(
        &phone,
        "event.propose",
        &json!({
            "title": "Dentist", "starts": "2026-11-02", "ends": "2026-11-02",
            "timing": "all-day", "calendar_id": calendar,
        }),
        "event-0",
    );
    // DOCUMENTS: two made, one edited, one trashed.
    let documents: Vec<String> = (0..2)
        .map(|index| {
            id_of(
                &run(
                    &phone,
                    "document.create_text",
                    &json!({ "title": format!("Doc {index}"), "body_text": format!("draft {index}") }),
                    &format!("doc-{index}"),
                ),
                "id",
            )
        })
        .collect();
    run(
        &phone,
        "document.edit",
        &json!({ "id": documents[0], "body_text": "draft 0, edited" }),
        "edit-doc-0",
    );
    run(
        &phone,
        "entity.trash",
        &json!({ "id": documents[1] }),
        "trash-doc-1",
    );
    // PEOPLE: two added, one edited.
    let ray = id_of(
        &run(
            &phone,
            "person.add",
            &json!({ "title": "Ray", "cadence_days": 0 }),
            "person-ray",
        ),
        "id",
    );
    run(
        &phone,
        "person.add",
        &json!({ "title": "Sol", "cadence_days": 30 }),
        "person-sol",
    );
    run(
        &phone,
        "person.edit",
        &json!({ "id": ray, "title": "Ray", "role": "Grandfather" }),
        "edit-ray",
    );
    // A PHOTOGRAPH, with its thumbnail.
    let photo = bytes_of("a photograph among the records", 40_000);
    let staged = stage(&phone, owned("image/heic", &photo), &photo);
    let thumb = bytes_of("its thumbnail among the records", 3_000);
    add_asset(&phone, &staged, "photo");
    stage(&phone, thumb_of(&staged, &thumb), &thumb);

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
    for table in ["note", "task", "event", "document", "person", "photo"] {
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
    let headed = |path: &Path| head_manifest(path, &gateway).1.census.get("note").copied();
    run(
        &phone,
        "note.create",
        &json!({ "title": "First", "body": "before the head", "format": "plain" }),
        "first",
    );
    let first = drain(&phone, at_home());
    let acked = status(&phone).acked_at_ms;
    assert!(acked.is_some() && first.acked_at_ms.is_some());
    assert_eq!(headed(&path), Some(1));

    // A NOTE AFTER THE HEAD, AND AN ORDINARY PASS WITHIN THE HOUR.
    run(
        &phone,
        "note.create",
        &json!({ "title": "Second", "body": "after the head", "format": "plain" }),
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
        "note.create",
        &json!({ "title": "Third", "body": "an hour later", "format": "plain" }),
        "third",
    );
    let book = state(&path);
    for mut row in book.gateways().expect("reads") {
        row.head_ms = row.head_ms.map(|at| at - 3_700_000);
        row.snapshot_ms = row.snapshot_ms.map(|at| at - 3_700_000);
        book.put_gateway(&row).expect("an hour passes");
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
    let headed = |path: &Path, gw: &Gateway| head_manifest(path, gw).1.census.get("note").copied();
    run(
        &phone,
        "note.create",
        &json!({ "title": "First", "body": "before the head", "format": "plain" }),
        "first",
    );
    drain(&phone, at_home());
    assert_eq!(headed(&path, &gateway), Some(1));

    // A NOTE, THEN THE APP LEAVES THE SCREEN WITH THE LAPTOP ASLEEP.
    run(
        &phone,
        "note.create",
        &json!({ "title": "Second", "body": "written before leaving", "format": "plain" }),
        "second",
    );
    gateway.cable().cut();
    let away = drain(&phone, at_home());
    assert_eq!(
        away.stopped,
        wire::DrainStop::Unreachable as i32,
        "{away:?}"
    );
    assert_eq!(headed(&path, &gateway), Some(1));

    // AWAKE: THE WORKER'S PASS, WHICH ASKS FOR NO SNAPSHOT, TAKES THE OWED ONE.
    let awake = gateway.restart();
    let window = drain(&phone, quietly());
    assert!(
        window.acked_at_ms.is_some(),
        "the owed snapshot: {window:?}"
    );
    assert_eq!(
        headed(&path, &awake),
        Some(2),
        "a restore now brings back both notes"
    );

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
                    "note.create",
                    &json!({
                        "title": format!("n{written:05}"),
                        "body": format!("written in order, number {written}"),
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
            "note.create",
            &json!({ "title": format!("In the WAL {index}"), "body": "not checkpointed", "format": "plain" }),
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
    assert_eq!(back.get("note").map(Vec::len), Some(20));
    assert_eq!(back, rows(&path));
}

/// What a pass killed between moving a snapshot's parts and setting the head
/// leaves: the snapshot taken, described, asked about, spooled and moved
/// through the plane exactly as a pass does — and no `settle`.
fn moved_and_not_settled(phone: &Handle, path: &Path) -> Name {
    let keyring = keys();
    let book = state(path);
    let destination = book.gateways().expect("reads").remove(0);
    let token = phone.plane().tokens()[&destination.gateway_id];
    let runtime = runtime();
    let store = centraid_core::phone::link::GatewayStore::for_gateway(
        &destination,
        token,
        keyring.vault.identity.signing(),
        runtime.handle(),
    )
    .expect("a store");
    let spool = centraid_vault::backup::spool::Spool::open(path.with_extension("spool"))
        .expect("the spool");
    let taken = phone
        .with_vault(|vault| {
            Ok(centraid_vault::backup::snapshot::take(
                vault,
                &keyring.backup,
                &spool,
                u64::MAX,
                &keyring.vault_hex(),
                "a pass the phone did not live to finish",
            )
            .expect("takes"))
        })
        .expect("the vault");
    let planned = centraid_vault::backup::snapshot::plan(&taken, &store).expect("plans");
    centraid_vault::backup::snapshot::spool(
        &taken,
        &[(destination.gateway_id.clone(), planned)],
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
        "note.create",
        &json!({ "title": "Headed", "body": "in the head", "format": "plain" }),
        "headed",
    );
    drain(&phone, at_home());
    let (previous, previous_manifest) = head_manifest(&path, &gateway);
    run(
        &phone,
        "note.create",
        &json!({ "title": "Cut", "body": "in the cut snapshot", "format": "plain" }),
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
    let (_, manifest) = head_manifest(&path, &gateway);
    let held = gateway.held(&vault_id());
    let superseded: Vec<Name> = previous_manifest
        .part_names()
        .difference(&manifest.part_names())
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
        "note.create",
        &json!({ "title": "Cut", "body": "in the cut snapshot", "format": "plain" }),
        "cut",
    );
    let cut = moved_and_not_settled(&phone, &path);
    run(
        &phone,
        "note.create",
        &json!({ "title": "Later", "body": "after the cut", "format": "plain" }),
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
            "note.create",
            &json!({ "title": format!("Round {round}"), "body": "x".repeat(4_000), "format": "plain" }),
            &format!("round-{round}"),
        );
        let drained = drain(&phone, at_home());
        assert!(drained.acked_at_ms.is_some(), "round {round}: {drained:?}");
    }
    let (head, manifest) = head_manifest(&path, &gateway);
    let mut kept = manifest.part_names();
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
    // A HOLD COUNTS ONLY THE TIME THE GATEWAY WAS WATCHING (#1191, E14): the clock moves an
    // hour at a time and the sweep runs after each, as a running gateway's does.
    let mut purged = 0_u64;
    for _ in 0..(8 * 24) {
        gateway.spawned.advance_clock(60 * 60 * 1000);
        purged += gateway
            .runtime
            .block_on(gateway.spawned.purge_now())
            .expect("purges");
    }
    assert_eq!(purged as usize, objects - held.len());
    assert_eq!(gateway.objects(&vault_id()).len(), held.len());
    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    assert_eq!(rows(&PathBuf::from(&restored.vaults[0].path)), rows(&path));
}

/// **A FILE IS BACKED UP ONCE ITS BYTES AND ITS ROW ARE** (#1080, S2; the
/// root's simulator repro: "Backed up · All 75 photos and files" while the
/// three newest photographs' rows were in no snapshot, so a restore then
/// would have returned 72). A file's bytes and its row travel apart — the
/// bytes by name, the row in a snapshot — and until both are a gateway's it is
/// not counted as backed up, and Free up space does not offer to delete it
/// from the library: lost with the phone, it would be bytes on a gateway that
/// no restored vault names.
///
/// A pass that confirms files takes the snapshot their rows need before it
/// answers (R-1080-C15), so the case that still leaves bytes without a row is
/// the one no pass confirmed: the operating system moved them while the app
/// was suspended, and settle recorded it. The next pass takes the snapshot
/// those files owe, first.
#[test]
fn a_file_is_backed_up_once_its_bytes_and_its_row_are() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    drain(&phone, at_home());

    // A PHOTOGRAPH AND A LIBRARY STILL, SEALED ON A METERED LINK UNDER WI-FI
    // ONLY: nothing may cross, and neither may the records.
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
    let sealed = drain(
        &phone,
        wire::DrainRequest {
            metered: true,
            charging: false,
            wants_snapshot: false,
            ..at_home()
        },
    );
    assert!(sealed.acked_at_ms.is_none(), "no snapshot: {sealed:?}");
    assert_eq!(sealed.confirmed_parts, 0, "nothing crossed: {sealed:?}");

    // THE OPERATING SYSTEM MOVES THE BYTES, as it does while the app is
    // suspended; no pass confirmed them, and no snapshot holds their rows.
    assert_eq!(the_os_moves_what_was_handed_off(&phone, &gateway), 2);
    let waits = status(&phone);
    assert_eq!(
        (waits.content_confirmed, waits.content_total),
        (0, 2),
        "bytes without a row a restore brings back are not a backup: {:?}",
        waits.waiting
    );
    assert_eq!(
        waiting(&waits, wire::WaitReason::Wifi),
        2,
        "the snapshot that holds the rows may not cross this link: {:?}",
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

    // THE NEXT PASS TAKES THE ROWS' SNAPSHOT, first: the files the operating
    // system confirmed owe it (R-1080-C15).
    let next = drain(&phone, quietly());
    assert!(next.acked_at_ms.is_some(), "{next:?}");
    let backed = status(&phone);
    assert_eq!((backed.content_confirmed, backed.content_total), (2, 2));
    assert!(backed.waiting.is_empty(), "{:?}", backed.waiting);
    assert_eq!(
        releasable(&phone).items.len(),
        1,
        "the still is offered now"
    );
}

/// **AN UNDO IS NOT UNDONE BY THE NEXT RETENTION PASS** (#1191, E6; B16). Each head on a day
/// drops the one before it, and the gateway holds those deletes for a week. The status names the
/// holds; the member's Undo lifts them, signed by the vault key; and the next snapshots, whose
/// retention would drop the same ones, do not sign a delete for a name the Undo restored.
#[test]
fn an_undo_lifts_the_holds_and_the_next_retention_pass_does_not_delete_them_again() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    for round in 0..4 {
        run(
            &phone,
            "note.create",
            &json!({ "title": format!("Round {round}"), "body": "x".repeat(4_000), "format": "plain" }),
            &format!("round-{round}"),
        );
        let drained = drain(&phone, at_home());
        assert!(drained.acked_at_ms.is_some(), "round {round}: {drained:?}");
    }
    // A PASS LEARNS WHAT THE GATEWAY IS HOLDING, and the status carries it.
    drain(&phone, quietly());
    let held_names = || -> std::collections::BTreeSet<Name> {
        gateway
            .objects(&vault_id())
            .iter()
            .filter(|record| record.hold.is_some())
            .map(|record| Name::from_bytes(*record.name.as_bytes()))
            .collect()
    };
    let before = held_names();
    assert!(!before.is_empty(), "retention dropped snapshots");
    let backed = status(&phone);
    let row = backed
        .destinations
        .iter()
        .find(|row| row.gateway_id == id)
        .expect("paired");
    assert_eq!(row.held_count as usize, before.len(), "{row:?}");
    assert_eq!(row.held_undoable, row.held_count);
    assert!(row.held_purge_at_ms > 0, "{row:?}");

    // THE MEMBER'S UNDO.
    let wire::response::Kind::UndoHeld(undone) = ask(
        &phone,
        wire::request::Kind::UndoHeld(wire::UndoHeldRequest {
            gateway_id: id.clone(),
        }),
    ) else {
        panic!("an undo answers");
    };
    assert_eq!(undone.restored as usize, before.len());
    assert!(held_names().is_empty(), "nothing is held now");

    // THE NEXT SNAPSHOTS' RETENTION WOULD DROP THE SAME ONES AGAIN: it does not.
    for round in 4..6 {
        run(
            &phone,
            "note.create",
            &json!({ "title": format!("Round {round}"), "body": "x".repeat(4_000), "format": "plain" }),
            &format!("round-{round}"),
        );
        drain(&phone, at_home());
    }
    let after = held_names();
    assert!(
        after.is_disjoint(&before),
        "a name the Undo restored is not held again: {:?}",
        after.intersection(&before).collect::<Vec<_>>()
    );
}

/// **THE MANIFEST IS A TREE (E9, B9).** Every leaf the head's root lists is held, and a snapshot
/// after one small write adds one new root, at most one new leaf (a founded vault is one leaf),
/// and the ranges that changed: no leaf is sent twice and the chunk digests ride the leaf.
#[test]
fn the_head_is_a_root_and_leaves_and_a_write_adds_one_root_and_one_leaf() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    run(
        &phone,
        "note.create",
        &json!({ "title": "One", "body": "first", "format": "plain" }),
        "one",
    );
    drain(&phone, at_home());
    let (head, first) = head_manifest(&path, &gateway);
    let held = gateway.held(&vault_id());
    assert!(!first.leaf_names().is_empty());
    for leaf in first.leaf_names() {
        assert!(held.contains(&leaf), "the gateway holds {leaf}");
    }
    assert!(
        first.ranges.iter().all(|range| range.d.len() == 1),
        "every range carries its chunk digest"
    );
    run(
        &phone,
        "note.create",
        &json!({ "title": "Two", "body": "second", "format": "plain" }),
        "two",
    );
    drain(&phone, at_home());
    let (next, second) = head_manifest(&path, &gateway);
    assert_ne!(head, next);
    let now = gateway.held(&vault_id());
    let new_leaves = second
        .leaf_names()
        .into_iter()
        .filter(|leaf| !held.contains(leaf))
        .count();
    assert!(
        new_leaves <= first.leaf_names().len(),
        "one write rewrites at most the leaves it touches: {new_leaves}"
    );
    assert!(now.contains(&next));
}
