//! NO HOLE IN RECOVERY WHEN THE SPOOL LETS GO OF A PART A DEVICE STILL OWES (#1188, B1).
//!
//! A part may leave the spool before every paired device holds it, after a day's wait or when
//! the spool is at its budget. That is safe only because the device stays recorded as owing it
//! and is fed again from the vault when it returns. Each test releases parts, brings the
//! device back, and restores from THAT device alone. The clock is set, never waited on.

mod common;

use centraid_api_proto::core_v1 as wire;
use centraid_core::phone::set_clock_skew_ms;
use centraid_vault::backup::mover::SPOOL_WAIT_MS;

use common::*;

/// The clock skew is the process's, so the tests take turns.
static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn originals(handle: &centraid_core::Handle, label: &str, count: usize, size: usize) {
    for index in 0..count {
        let bytes = bytes_of(&format!("{label} {index}"), size);
        let staged = stage(handle, owned("image/heic", &bytes), &bytes);
        add_asset(handle, &staged, "photo");
    }
}

fn row<'a>(status: &'a wire::BackupStatusResponse, id: &str) -> &'a wire::Destination {
    status
        .destinations
        .iter()
        .find(|row| row.gateway_id == id)
        .expect("the gateway is paired")
}

/// Passes until nothing is owed, a count and not a time: a small spool takes several.
fn until_current(phone: &centraid_core::Handle) {
    for _ in 0..24 {
        drain(phone, at_home());
        if status(phone)
            .destinations
            .iter()
            .all(|row| row.behind_files == 0)
        {
            return;
        }
    }
    panic!("still owed after 24 passes: {:?}", status(phone));
}

/// What a restore from `gateway` alone must bring back: the same files the phone holds.
fn restores_whole(gateway: &Gateway, path: &std::path::Path) {
    let dir = tempfile::tempdir().expect("a directory");
    let restored = restore(dir.path(), gateway);
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    assert!(restored.unclaimed.is_empty(), "{restored:?}");
    let restored_path = std::path::PathBuf::from(&restored.vaults[0].path);
    assert_eq!(
        census(&restored_path),
        census(path),
        "every file the phone holds is in this device's restore"
    );
}

/// **A DEVICE AWAY PAST THE WAIT IS FED IN FULL WHEN IT RETURNS.**
#[test]
fn a_device_away_past_the_wait_still_restores_the_whole_vault() {
    let _turn = TURN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    set_clock_skew_ms(0);
    let (first, second) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let one = pair(&phone, &first).destination.expect("paired").gateway_id;
    let two = pair(&phone, &second)
        .destination
        .expect("paired")
        .gateway_id;
    originals(
        &phone,
        "a photograph while a laptop is away a day",
        3,
        80_000,
    );

    second.cable().cut();
    drain(&phone, at_home());
    assert!(
        !ledger(&path).queued().expect("reads").is_empty(),
        "kept for the one that is away"
    );

    // A DAY AND AN HOUR PASS; THE DEVICE IS STILL AWAY, THE WAIT IS OVER, AND NOTHING READS CURRENT.
    set_clock_skew_ms(SPOOL_WAIT_MS + 60 * 60 * 1000);
    drain(&phone, quietly());
    let released = status(&phone);
    assert_eq!(
        released.content_confirmed, 0,
        "a part let go never reads the away device as current: {released:?}"
    );
    assert!(row(&released, &two).behind_files > 0, "{released:?}");
    assert_eq!(row(&released, &one).behind_files, 0);

    // IT RETURNS AND IS FED AGAIN FROM THE VAULT.
    second.cable().mend();
    let moved = drain(&phone, at_home());
    assert_eq!(moved.stopped, wire::DrainStop::Empty as i32, "{moved:?}");
    let book = ledger(&path);
    assert!(
        book.confirmed_names(&one)
            .expect("reads")
            .is_subset(&book.confirmed_names(&two).expect("reads")),
        "the returned device holds everything the other does"
    );
    let backed = status(&phone);
    assert_eq!(backed.content_confirmed, backed.content_total, "{backed:?}");
    assert_eq!(row(&backed, &two).behind_files, 0);

    set_clock_skew_ms(0);
    restores_whole(&second, &path);
}

/// **THE SAME WHEN THE SPOOL REACHES ITS BUDGET BEFORE THE DAY IS UP.**
#[test]
fn a_spool_at_its_budget_lets_go_without_a_hole() {
    let _turn = TURN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    set_clock_skew_ms(0);
    let (first, second) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone_with(dir.path(), |config| config.with_spool_ceiling(150_000));
    let one = pair(&phone, &first).destination.expect("paired").gateway_id;
    let two = pair(&phone, &second)
        .destination
        .expect("paired")
        .gateway_id;
    originals(&phone, "a photograph into a small spool", 6, 80_000);

    second.cable().cut();
    drain(&phone, at_home());
    let held_by_first = ledger(&path).confirmed_names(&one).expect("reads");
    assert!(!held_by_first.is_empty());
    let behind = status(&phone);
    assert_eq!(behind.content_confirmed, 0, "{behind:?}");
    assert!(row(&behind, &two).behind_files > 0, "{behind:?}");

    second.cable().mend();
    until_current(&phone);
    let backed = status(&phone);
    assert_eq!(backed.content_confirmed, backed.content_total, "{backed:?}");
    assert_eq!(row(&backed, &two).behind_files, 0);

    restores_whole(&second, &path);
    restores_whole(&first, &path);
}
