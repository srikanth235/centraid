//! THE PHONE VERIFIES WHAT A GATEWAY SAYS IT HOLDS (#1188, B4), through the core's doors
//! against a real gateway.
//!
//! A gateway's `exists` and `put` answers are trusted only so far: each pass reads back a small
//! random sample of what a gateway acknowledged and opens it, and the phone remembers the newest
//! head it set at each gateway, so a head that goes backwards (a restored copy of the gateway's
//! own disk) is flagged and then mended by the next head the phone sets.

mod common;

use std::path::Path;

use centraid_api_proto::core_v1 as wire;
use serde_json::json;

use common::*;

fn note(handle: &centraid_core::Handle, title: &str) {
    command(
        handle,
        "note.create",
        &json!({ "title": title, "body": "a note", "format": "plain" }),
        &format!("note:{title}"),
    );
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("makes the directory");
    for entry in std::fs::read_dir(from).expect("lists") {
        let entry = entry.expect("an entry");
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("copies");
        }
    }
}

fn wipe(dir: &Path) {
    for entry in std::fs::read_dir(dir).expect("lists") {
        let path = entry.expect("an entry").path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path).expect("removes");
        } else {
            std::fs::remove_file(&path).expect("removes");
        }
    }
}

/// **A GATEWAY THAT NO LONGER HOLDS WHAT IT ACKNOWLEDGED IS FOUND BY A PASS.** Its `exists` was
/// trusted once; the sample read back finds the damage and the ledger stops confirming the part.
#[test]
fn a_pass_reads_back_a_sample_and_finds_a_part_a_gateway_damaged() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    note(&phone, "something to back up");
    drain(&phone, at_home());
    let _ = (&path, &id);
    let before = gateway.held(&vault_id());
    assert!(!before.is_empty());

    // EVERY OBJECT THE GATEWAY HOLDS LOSES A BIT, so any sample finds one.
    for name in gateway.held(&vault_id()) {
        let wire_name = centraid_gateway::rules::ids::Name::from_bytes(*name.as_bytes());
        gateway
            .spawned
            .corrupt(&vault_id(), &wire_name)
            .expect("damages");
    }
    // THE GATEWAY'S OWN SCRUB NAMES WHAT IS DAMAGED, and the read-back finds the names it no
    // longer serves.
    gateway
        .runtime
        .block_on(gateway.spawned.scrub_now())
        .expect("the scrub runs");
    // THE READ-BACK RUNS BEFORE THE PASS WRITES, so the same pass retakes the snapshot: the
    // damaged names were freed at the gateway (a signed delete frees a damaged name at once) and
    // sent anew.
    let mended = drain(&phone, quietly());
    assert!(
        mended.acked_at_ms.is_some(),
        "the pass that found the damage retook the snapshot: {mended:?}"
    );
    let again = drain(&phone, quietly());
    assert!(
        again.acked_at_ms.is_none() && !phone.plane().snapshot_owed(),
        "nothing found damaged the second time: {again:?}"
    );
    let held = gateway.held(&vault_id());
    assert!(
        before.iter().all(|name| held.contains(name)) || held.len() >= before.len(),
        "what was damaged is held again: {} of {}",
        held.len(),
        before.len()
    );
}

/// **A HEAD THAT GOES BACKWARDS IS FLAGGED, AND MENDED BY THE NEXT HEAD THE PHONE SETS.** The
/// gateway's disk is put back as it was a backup ago; the phone remembers the newest head it set
/// there, says so on the gateway's row, and the pass that may carry the records sets a current
/// head and clears it.
#[test]
fn a_head_that_goes_backwards_is_flagged_until_the_phone_sets_a_current_one() {
    let first = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let id = pair(&phone, &first)
        .destination
        .expect("a destination")
        .gateway_id;
    note(&phone, "before");
    drain(&phone, at_home());

    // THE GATEWAY'S DISK AS IT IS NOW, kept; then another backup moves the head on.
    let Gateway {
        runtime: asleep,
        dir: gateway_dir,
        spawned,
    } = first;
    let addr = spawned.addr;
    asleep.block_on(spawned.shutdown());
    drop(asleep);
    let saved = tempfile::tempdir().expect("a directory");
    copy_dir(gateway_dir.path(), saved.path());
    let rt = runtime();
    let spawned = rt
        .block_on(centraid_gateway::server::harness::spawn_on(
            gateway_dir.path(),
            addr,
        ))
        .expect("the gateway starts again");
    let mut gateway = Gateway {
        runtime: rt,
        dir: gateway_dir,
        spawned,
    };
    note(&phone, "after");
    let moved = drain(&phone, at_home());
    assert!(moved.acked_at_ms.is_some(), "{moved:?}");
    let newest = gateway.writer(&vault_id()).1;

    // PUT BACK AS IT WAS.
    let Gateway {
        runtime: asleep,
        dir: gateway_dir,
        spawned,
    } = gateway;
    asleep.block_on(spawned.shutdown());
    drop(asleep);
    wipe(gateway_dir.path());
    copy_dir(saved.path(), gateway_dir.path());
    let rt = runtime();
    let spawned = rt
        .block_on(centraid_gateway::server::harness::spawn_on(
            gateway_dir.path(),
            addr,
        ))
        .expect("the gateway starts again");
    gateway = Gateway {
        runtime: rt,
        dir: gateway_dir,
        spawned,
    };
    let rolled = gateway.writer(&vault_id()).1;
    assert_ne!(rolled, newest, "the head went back");

    // A PASS THAT MAY NOT CARRY THE RECORDS (a metered link under Wi-Fi only) sees it and
    // cannot mend it: the gateway's row says so.
    let metered = wire::DrainRequest {
        metered: true,
        wants_snapshot: false,
        ..quietly()
    };
    drain(&phone, metered);
    let flagged = status(&phone);
    let row = flagged
        .destinations
        .iter()
        .find(|row| row.gateway_id == id)
        .expect("paired");
    assert!(row.rolled_back, "{row:?}");

    // THE NEXT PASS THAT MAY SETS A CURRENT HEAD, and the flag goes.
    let mended = drain(&phone, quietly());
    assert!(mended.acked_at_ms.is_some(), "{mended:?}");
    let head = gateway.writer(&vault_id()).1;
    assert_ne!(
        head, rolled,
        "the head moved on from the one it was put back to"
    );
    assert_ne!(head, None);
    let after = status(&phone);
    let row = after
        .destinations
        .iter()
        .find(|row| row.gateway_id == id)
        .expect("paired");
    assert!(!row.rolled_back, "{row:?}");
}

/// **B11. A CLOCK SET AHEAD AND CORRECTED DOES NOT HOLD THE HOURLY SNAPSHOT OFF.** A snapshot
/// dated a year ahead used to read as "taken a moment ago" until the real date caught up; it
/// is not believed now, and an ordinary pass takes one.
#[test]
fn a_snapshot_dated_in_the_future_does_not_suppress_the_next_one() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    note(&phone, "first");
    drain(&phone, at_home());
    note(&phone, "second");
    let quiet = drain(&phone, quietly());
    assert!(
        quiet.acked_at_ms.is_none(),
        "within the hour, none: {quiet:?}"
    );

    // THE CLOCK WAS A YEAR AHEAD WHEN THAT SNAPSHOT WAS TAKEN.
    let year = 365 * 24 * 60 * 60 * 1_000_u64;
    let book = state(&path);
    for mut row in book.gateways().expect("reads") {
        row.head_ms = row.head_ms.map(|at| at + year);
        row.snapshot_ms = row.snapshot_ms.map(|at| at + year);
        book.put_gateway(&row).expect("re-dates");
    }
    let next = drain(&phone, quietly());
    assert!(
        next.acked_at_ms.is_some(),
        "a future-dated snapshot is not recent: {next:?}"
    );
}

/// **A GATEWAY THAT LIES ABOUT WHAT IT HOLDS IS FOUND BY THE READ-BACK (#1188, B13).** It loses
/// its files and says `exists` for every name; the phone believes it until a pass reads a sample
/// back. Once the gateway is honest again, the next pass sends the lost parts again.
#[test]
fn a_gateway_that_lies_about_exists_is_found_and_then_refilled() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    note(&phone, "something to back up");
    drain(&phone, at_home());
    let _ = (&path, &id);
    let before = gateway.held(&vault_id());
    assert!(!before.is_empty());

    gateway.spawned.lie_about_exists(true);
    for name in gateway.held(&vault_id()) {
        let wire_name = centraid_gateway::rules::ids::Name::from_bytes(*name.as_bytes());
        gateway
            .spawned
            .lose(&vault_id(), &wire_name)
            .expect("the file is lost");
    }
    // THE READ-BACK IS WHAT FINDS IT: `exists` says held, so a plan believes the gateway and
    // nothing is sealed; the sample reads the bytes and they are not there. The gateway's row says
    // it must be re-sent, which the honest passes below do.
    drain(&phone, quietly());
    let flagged = status(&phone);
    let row = flagged
        .destinations
        .iter()
        .find(|row| row.gateway_id == id)
        .expect("paired");
    assert!(
        row.rolled_back || row.manifest_unreadable,
        "the gateway is marked as having lost what it said it held: {row:?}"
    );

    gateway.spawned.lie_about_exists(false);
    // THE NEXT PASSES RETAKE THE SNAPSHOT against an honest gateway: every range is missing, so
    // every range is sealed and sent again, and the head moves to a manifest the gateway holds.
    for _ in 0..40 {
        drain(&phone, at_home());
        let head = gateway.writer(&vault_id()).1;
        if head.is_some_and(|head| gateway.held(&vault_id()).contains(&head)) {
            break;
        }
    }
    let head = gateway.writer(&vault_id()).1.expect("a head");
    let held = gateway.held(&vault_id());
    assert!(held.contains(&head), "an honest gateway is refilled");
    assert!(
        held.len() >= before.len() - 1,
        "every range came back: {} of {}",
        held.len(),
        before.len()
    );
}

fn record_of(
    gateway: &Gateway,
    name: &centraid_gateway::rules::ids::Name,
) -> Option<centraid_gateway::rules::state::ObjectRecord> {
    gateway
        .objects(&vault_id())
        .into_iter()
        .find(|record| &record.name == name)
}

/// Back up one photograph and a note, twice, so the head's blobs tree names the photograph's part
/// with the digests this phone sealed it with; answers the phone, its vault path, the gateway
/// name of the photograph's only part and the gateway's id.
fn backed_up_photograph(
    gateway: &Gateway,
    dir: &Path,
) -> (
    centraid_core::Handle,
    std::path::PathBuf,
    centraid_gateway::rules::ids::Name,
) {
    let path = dir.join("vault.db");
    let phone = phone(dir);
    pair(&phone, gateway);
    let photo = bytes_of("a photograph the gateway will rot", 70_000);
    let staged = stage(&phone, owned("image/heic", &photo), &photo);
    add_asset(&phone, &staged, "photo");
    drain(&phone, at_home());
    note(
        &phone,
        "a change, so a snapshot that names the photograph is taken",
    );
    drain(
        &phone,
        wire::DrainRequest {
            asked: true,
            ..at_home()
        },
    );
    let object = gateway_name(&staged.content_hash, 0);
    (phone, path, object)
}

/// **A ROTTED ORIGINAL NOBODY SCRUBBED IS FOUND BY THE READ-BACK** (#1191, B13, decision 34): the
/// pass reads a sampled chunk by `Range`, finds it is not the digest the blobs tree recorded, asks
/// the gateway to check that one name, and, when the gateway agrees, frees it by a signed delete
/// and sends the part again. No scrub ran.
#[test]
fn a_rotted_original_is_found_checked_freed_and_sent_again() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let (phone, _path, object) = backed_up_photograph(&gateway, dir.path());
    let before = record_of(&gateway, &object).expect("held");
    gateway
        .spawned
        .corrupt(&vault_id(), &object)
        .expect("the part rots");

    for _ in 0..4 {
        drain(&phone, quietly());
    }
    let counts = gateway
        .runtime
        .block_on(gateway.spawned.scrub_now())
        .expect("the scrub runs");
    assert_eq!(
        counts.corrupt, 0,
        "the part was sent again, sound: {counts:?}"
    );
    assert!(
        record_of(&gateway, &object).is_some_and(|record| record.is_live()),
        "the photograph's part is live again"
    );
    // SEALED AGAIN UNDER A NEW SALT: the bytes differ, so a damaged name that was not freed by a
    // signed delete (the phone's, or the mover's on NAME_TAKEN) would have refused them forever.
    let after = record_of(&gateway, &object).expect("held");
    assert_ne!(
        after.digest, before.digest,
        "the re-sealed part is not the one that rotted"
    );
}

/// **THE READ-BACK AND THE GATEWAY DISAGREE, AND NOTHING IS DELETED** (decision 34): a digest in the
/// blobs tree that is not the part's (a phone that recorded the wrong one) reads as wrong, the
/// gateway hashes the object and says it is intact, and the phone does not delete a sound part.
#[test]
fn a_chunk_the_gateway_calls_intact_is_not_deleted() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let (phone, path, object) = backed_up_photograph(&gateway, dir.path());
    let before = record_of(&gateway, &object).expect("held");
    // THE PHONE'S RECORD OF THE PART'S DIGESTS IS WRONG from here on.
    let book = state(&path);
    book.forget_digests_except(&std::collections::BTreeSet::new())
        .expect("forgets");
    book.record_digests(
        &centraid_vault::backup::naming::Name::from_bytes(*object.as_bytes()),
        &[centraid_media::sealed::ChunkDigest::of(b"not this part")],
    )
    .expect("records");
    drop(book);
    note(&phone, "a snapshot that names the wrong digest");
    for _ in 0..4 {
        drain(
            &phone,
            wire::DrainRequest {
                asked: true,
                ..at_home()
            },
        );
    }
    let after = record_of(&gateway, &object).expect("still held");
    assert!(
        after.is_live()
            && after.digest == before.digest
            && after.stored_at_ms == before.stored_at_ms,
        "a part the gateway calls intact is neither deleted nor replaced: {after:?}"
    );
    // THE RATE SENTENCE NEVER OVERSTATES: the chunk the read-back could not stand behind is in
    // `sample_of` and not in `sample_checked`.
    let status = status(&phone);
    let row = status.destinations.first().expect("a destination");
    assert!(
        row.sample_checked < row.sample_of,
        "an unverified chunk is drawn but not counted: {} of {}",
        row.sample_checked,
        row.sample_of
    );
}
