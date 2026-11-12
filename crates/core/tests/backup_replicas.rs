//! EVERY PAIRED GATEWAY IS A FULL REPLICA (#1188, B1), through the core's doors against
//! real gateways.
//!
//! A pass feeds each gateway that answers, on its own: one being away or full does not starve
//! another, and does not stop the one that is away being fed when it is back. The spool keeps a
//! part for a gateway that still owes it and frees it once none does; the status names the
//! gateway that is behind, and "backed up" is said only when all are current.

mod common;

use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::backup::naming::Name;

use common::*;

fn originals(handle: &centraid_core::Handle, label: &str, count: usize, size: usize) {
    for index in 0..count {
        let bytes = bytes_of(&format!("{label} {index}"), size);
        let staged = stage(handle, owned("image/heic", &bytes), &bytes);
        add_asset(handle, &staged, "photo");
    }
}

fn pair_id(handle: &centraid_core::Handle, gateway: &Gateway) -> String {
    pair(handle, gateway)
        .destination
        .expect("a destination")
        .gateway_id
}

fn row<'a>(status: &'a wire::BackupStatusResponse, id: &str) -> &'a wire::Destination {
    status
        .destinations
        .iter()
        .find(|row| row.gateway_id == id)
        .expect("the gateway is paired")
}

/// **A SECOND GATEWAY IS FED BY THE SAME PASS.** Before, the pass used the first gateway that
/// answered and freed the spool on its acknowledgement, so the second received nothing while
/// the first was up and the status read healthy.
#[test]
fn a_pass_feeds_every_paired_gateway() {
    let (first, second) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let (one, two) = (pair_id(&phone, &first), pair_id(&phone, &second));
    originals(&phone, "a photograph for two gateways", 3, 80_000);

    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    assert_eq!(
        drained.pending_bytes, 0,
        "nothing is left owed: {drained:?}"
    );

    let book = ledger(&path);
    let (held_one, held_two) = (
        book.confirmed_names(&one).expect("reads"),
        book.confirmed_names(&two).expect("reads"),
    );
    assert!(!held_one.is_empty());
    assert_eq!(
        held_one, held_two,
        "the same names are acknowledged at both"
    );
    let on_disk = |gateway: &Gateway| -> BTreeSet<Name> { gateway.held(&vault_id()) };
    assert_eq!(on_disk(&first), held_one, "and held by the first");
    assert_eq!(on_disk(&second), held_two, "and held by the second");
    assert_eq!(
        first.writer(&vault_id()).1,
        second.writer(&vault_id()).1,
        "the same head"
    );

    let backed = status(&phone);
    assert_eq!(backed.content_confirmed, backed.content_total, "{backed:?}");
    for id in [&one, &two] {
        let row = row(&backed, id);
        assert_eq!(
            (row.behind_files, row.records_behind),
            (0, false),
            "{row:?}"
        );
    }
}

/// **A GATEWAY THAT IS AWAY DOES NOT STARVE THE OTHER, AND IS FED WHEN IT IS BACK.** The
/// spool keeps each part for the one that is away; the status names it; nothing reads "backed
/// up" until it has caught up; and once it has, the spool is empty.
#[test]
fn a_gateway_that_is_away_is_waited_for_and_fed_when_it_is_back() {
    let (first, second) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let (one, two) = (pair_id(&phone, &first), pair_id(&phone, &second));
    originals(&phone, "a photograph while a laptop sleeps", 3, 80_000);

    second.cable().cut();
    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    let book = ledger(&path);
    assert!(!book.confirmed_names(&one).expect("reads").is_empty());
    assert!(
        book.confirmed_names(&two).expect("reads").is_empty(),
        "the second took nothing"
    );
    // THE PARTS ARE KEPT FOR THE ONE THAT IS AWAY.
    assert!(
        !book.queued().expect("reads").is_empty(),
        "parts still owed to the second stay queued"
    );
    assert!(drained.pending_bytes > 0, "{drained:?}");

    let behind = status(&phone);
    assert_eq!(
        behind.content_confirmed, 0,
        "not backed up while one is behind: {behind:?}"
    );
    assert_eq!(row(&behind, &one).behind_files, 0);
    assert!(row(&behind, &two).behind_files > 0);
    // WHAT IT OWES IS SAID BY APP, so the screen can name the device and the app.
    let owed: Vec<(&str, u64)> = row(&behind, &two)
        .waiting_apps
        .iter()
        .map(|w| (w.app_id.as_str(), w.files))
        .collect();
    assert_eq!(owed, [("photos", 3)], "{behind:?}");
    assert!(row(&behind, &one).waiting_apps.is_empty());
    assert_eq!(row(&behind, &two).reach, wire::WaitReason::Gateway as i32);
    assert!(
        waiting(&behind, wire::WaitReason::Gateway) > 0,
        "{:?}",
        behind.waiting
    );

    second.cable().mend();
    let caught_up = drain(&phone, quietly());
    assert_eq!(
        caught_up.stopped,
        wire::DrainStop::Empty as i32,
        "{caught_up:?}"
    );
    let book = ledger(&path);
    assert_eq!(
        book.confirmed_names(&one).expect("reads"),
        book.confirmed_names(&two).expect("reads")
    );
    assert!(
        book.queued().expect("reads").is_empty(),
        "nothing is owed any more"
    );
    assert_eq!(caught_up.pending_bytes, 0, "{caught_up:?}");
    let backed = status(&phone);
    assert_eq!(backed.content_confirmed, backed.content_total, "{backed:?}");
    assert_eq!(row(&backed, &two).behind_files, 0);
}

/// **A GATEWAY THAT IS FULL IS NAMED, AND THE OTHER IS STILL FED.** Its answer is its own
/// limit, not an absence.
#[test]
fn a_full_gateway_is_named_while_the_other_is_fed() {
    let (first, second) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let (one, two) = (pair_id(&phone, &first), pair_id(&phone, &second));
    originals(&phone, "a photograph for a full disk", 3, 60_000);

    second.spawned.fill_disk(true);
    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Refused as i32,
        "{drained:?}"
    );
    let book = ledger(&path);
    assert!(
        !book.confirmed_names(&one).expect("reads").is_empty(),
        "the first is fed"
    );
    assert!(book.confirmed_names(&two).expect("reads").is_empty());
    let behind = status(&phone);
    assert_eq!(
        row(&behind, &two).reach,
        wire::WaitReason::Refused as i32,
        "{behind:?}"
    );
    assert_eq!(
        row(&behind, &one).reach,
        wire::WaitReason::Unspecified as i32
    );
    assert!(
        waiting(&behind, wire::WaitReason::Refused) > 0,
        "{:?}",
        behind.waiting
    );

    second.spawned.fill_disk(false);
    let moved = drain(&phone, quietly());
    assert_eq!(moved.stopped, wire::DrainStop::Empty as i32, "{moved:?}");
    let backed = status(&phone);
    assert_eq!(backed.content_confirmed, backed.content_total, "{backed:?}");
    assert!(ledger(&path).queued().expect("reads").is_empty());
}

/// **EACH NAME IS ASKED ONCE A PASS** (#1188, item 12). The same twelve photographs are backed
/// up under a spool that holds two parts (many rounds) and under one that holds them all (one
/// round). Every round used to ask the gateway about every name still not held, again; now the
/// gateway is asked about the same number of names either way.
#[test]
fn a_name_is_asked_of_a_gateway_once_however_many_rounds_the_pass_takes() {
    let asked_under = |ceiling: u64| -> u64 {
        let gateway = gateway();
        let dir = tempfile::tempdir().expect("a directory");
        let phone = phone_with(dir.path(), |config| config.with_spool_ceiling(ceiling));
        pair(&phone, &gateway);
        originals(&phone, "a photograph for many rounds", 12, 80_000);
        let before = gateway.spawned.exists_asked().1;
        let drained = drain(&phone, at_home());
        assert_eq!(
            drained.stopped,
            wire::DrainStop::Empty as i32,
            "{drained:?}"
        );
        let backed = status(&phone);
        assert_eq!(backed.content_confirmed, backed.content_total, "{backed:?}");
        gateway.spawned.exists_asked().1 - before
    };
    assert_eq!(asked_under(170_000), asked_under(64 << 20));
}

/// **EVERY GATEWAY IS FED IN TURN, NOT ONE TO THE END BEFORE THE NEXT** (#1188, item 16). A
/// first gateway that took every round of a pass left a second one nothing when the pass (or
/// the background window) ended early. The spool holds two parts, so the library takes many
/// rounds; the gateways share one commit counter, and the second's first part must land before
/// the first's last.
#[test]
fn the_gateways_are_fed_in_turn_round_by_round() {
    let (first, second) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone_with(dir.path(), |config| config.with_spool_ceiling(170_000));
    pair_id(&phone, &first);
    pair_id(&phone, &second);
    originals(&phone, "a photograph for two gateways in turn", 12, 80_000);

    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    let (one, two) = (first.spawned.commit_order(), second.spawned.commit_order());
    // THE GATEWAYS' COMMITS IN THE ORDER THEY HAPPENED: fed in turn, the sequence changes
    // gateway at nearly every round; fed one to the end first, it changes twice or so.
    let mut merged: Vec<(u64, bool)> = one.iter().map(|at| (*at, true)).collect();
    merged.extend(two.iter().map(|at| (*at, false)));
    merged.sort_unstable();
    let switches = merged
        .windows(2)
        .filter(|pair| pair[0].1 != pair[1].1)
        .count();
    assert!(
        switches >= 8,
        "the gateways were fed one after the other ({switches} changes of gateway): {one:?} then {two:?}"
    );
    assert_eq!(one.len(), two.len(), "both hold the same parts");
}

/// **A REFUSAL KEEPS ITS REASON** (#1188, item 21). A gateway whose disk is full, one that
/// refuses a part as too large and one that is fine are paired; each is read as what it said,
/// with the limit the too-large one crossed, and the fine one is fed all the same.
#[test]
fn a_refusal_is_read_as_the_reason_the_gateway_gave() {
    let (full, large, fine) = (gateway(), gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let (a, b, c) = (
        pair_id(&phone, &full),
        pair_id(&phone, &large),
        pair_id(&phone, &fine),
    );
    originals(&phone, "a photograph for refusals", 3, 60_000);

    full.spawned.fill_disk(true);
    large.spawned.refuse_as_too_large(true);
    drain(&phone, at_home());
    let behind = status(&phone);
    assert_eq!(row(&behind, &a).reach, wire::WaitReason::Refused as i32);
    assert_eq!(row(&behind, &a).refused_limit_bytes, 0);
    assert_eq!(row(&behind, &b).reach, wire::WaitReason::TooLarge as i32);
    assert_eq!(
        row(&behind, &b).refused_limit_bytes,
        centraid_gateway::rules::limits::MAX_OBJECT_BYTES
    );
    assert_eq!(row(&behind, &c).reach, wire::WaitReason::Unspecified as i32);
    assert_eq!(row(&behind, &c).behind_files, 0, "the healthy one is fed");
}

/// **THE OLDEST THING WAITING IS REPORTED** (#1188): a screen warns on an old backlog by
/// subtracting it from now. Nothing waiting reads as absent.
#[test]
fn the_oldest_waiting_item_is_reported() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    assert_eq!(status(&phone).oldest_waiting_ms, None);
    originals(&phone, "a photograph that waits", 2, 60_000);
    let waiting = status(&phone);
    assert!(
        waiting.oldest_waiting_ms.is_some_and(|at| at > 0),
        "{waiting:?}"
    );
    drain(&phone, at_home());
    assert_eq!(status(&phone).oldest_waiting_ms, None);
}

fn pair_id_of(status: &wire::BackupStatusResponse) -> String {
    status.destinations[0].gateway_id.clone()
}
