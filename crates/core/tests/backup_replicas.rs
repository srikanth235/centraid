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

    let _ = (&one, &two);
    let on_disk = |gateway: &Gateway| -> BTreeSet<Name> { gateway.held(&vault_id()) };
    let (held_one, held_two) = (on_disk(&first), on_disk(&second));
    assert!(!held_one.is_empty());
    assert_eq!(held_one, held_two, "the same names are held at both");
    assert!(owed_any(&path).is_empty(), "and nothing is owed to either");
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

    // SEALED OVER A METERED LINK, where nothing crosses: both gateways owe every part.
    drain(
        &phone,
        wire::DrainRequest {
            metered: true,
            ..quietly()
        },
    );
    second.cable().cut();
    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    let _ = &one;
    assert!(!first.held(&vault_id()).is_empty());
    assert!(
        second.held(&vault_id()).is_empty(),
        "the second took nothing"
    );
    // THE PARTS ARE KEPT FOR THE ONE THAT IS AWAY.
    assert!(
        !owed(&path, &two).is_empty(),
        "parts still owed to the second stay in its outbox"
    );
    assert!(owed(&path, &one).is_empty(), "and none to the first");
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
    assert_eq!(first.held(&vault_id()), second.held(&vault_id()));
    assert!(owed_any(&path).is_empty(), "nothing is owed any more");
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
    let _ = &one;
    assert!(!first.held(&vault_id()).is_empty(), "the first is fed");
    assert!(second.held(&vault_id()).is_empty());
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
    assert!(owed_any(&path).is_empty());
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
    // Never before the gateway was paired: a wait starts when there was something to wait for.
    let paired = waiting.destinations[0].paired_at_ms;
    assert!(
        waiting.oldest_waiting_ms.is_some_and(|at| at >= paired),
        "{waiting:?}"
    );
    drain(&phone, at_home());
    assert_eq!(status(&phone).oldest_waiting_ms, None);
}

/// **FORGETTING THE LAST GATEWAY LEAVES NOTHING OF IT** (#1188). Its spooled parts are no one's,
/// so the queue and the spool empty; its refusal, rollback and high-water marks go with it, and
/// pairing it again starts clean.
#[test]
fn forgetting_the_only_gateway_leaves_nothing_queued_and_no_stale_state() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let id = pair_id(&phone, &gateway);
    originals(&phone, "a photograph left in the spool", 3, 60_000);
    gateway.spawned.fill_disk(true);
    drain(&phone, at_home());
    assert!(!owed_any(&path).is_empty(), "parts wait in the spool");
    assert_eq!(
        row(&status(&phone), &id).reach,
        wire::WaitReason::Refused as i32
    );

    forget(&phone, &id);
    assert!(owed_any(&path).is_empty(), "nothing is queued");
    assert!(
        state(&path).gateway(&id).expect("reads").is_none(),
        "and the gateway's row is gone"
    );
    let spooled: u64 = std::fs::read_dir(dir.path().join("vault.spool"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().len() == 64)
                .map(|entry| entry.metadata().map_or(0, |meta| meta.len()))
                .sum()
        })
        .unwrap_or(0);
    assert_eq!(spooled, 0, "nothing is spooled");

    gateway.spawned.fill_disk(false);
    let again = pair_id(&phone, &gateway);
    let after = status(&phone);
    let paired = row(&after, &again);
    assert_eq!(
        paired.reach,
        wire::WaitReason::Unspecified as i32,
        "{paired:?}"
    );
    assert!(!paired.rolled_back, "{paired:?}");
}

/// **ONE GATEWAY'S PROVEN TAKEOVER STOPS THAT GATEWAY ONLY** (#1191, E4, B3). Another phone
/// restores from the words through the first gateway while the second does not answer, so it claims
/// there, and only there (it would claim at every listed gateway that answered, E8). This
/// phone's next pass hears `MOVED` from the first, with a claim the vault key signed above the
/// epoch it holds: it marks that gateway's row and goes on feeding the second, which still takes
/// its writes. The status says another phone has taken over.
#[test]
fn a_takeover_at_one_gateway_stops_the_pass_there_and_the_other_is_still_fed() {
    let (first, second) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let (one, two) = (pair_id(&phone, &first), pair_id(&phone, &second));
    originals(&phone, "before the takeover", 1, 20_000);
    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );

    let elsewhere = tempfile::tempdir().expect("a directory");
    second.cable().cut();
    let restored = restore(elsewhere.path(), &first);
    second.cable().mend();
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    assert_eq!(first.writer(&vault_id()).0, 2, "claimed at the first");
    assert_eq!(second.writer(&vault_id()).0, 1, "and not at the second");

    originals(&phone, "after the takeover", 1, 20_000);
    let drained = drain(&phone, at_home());
    assert_ne!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "the first gateway refused this phone: {drained:?}"
    );
    let book = state(&path);
    assert_eq!(
        book.gateway(&one)
            .expect("reads")
            .expect("paired")
            .moved_epoch,
        Some(2),
        "the first is marked"
    );
    assert_eq!(
        book.gateway(&two)
            .expect("reads")
            .expect("paired")
            .moved_epoch,
        None,
        "the second is not"
    );
    assert!(
        owed(&path, &two).is_empty(),
        "the second took this phone's writes"
    );
    let backed = status(&phone);
    assert!(backed.frozen, "the status says another phone took over");
    assert_eq!(row(&backed, &two).behind_files, 0, "{backed:?}");
}
