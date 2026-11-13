//! CHECK MY BACKUP, THROUGH THE CORE'S DOOR AGAINST A REAL GATEWAY (#1188, B6, ruling 18).
//!
//! Each test states what the check says about one device, by counts and verdicts, never by how
//! long it took. The vault is read before and after: a check never touches it.

mod common;

use centraid_api_proto::core_v1 as wire;
use wire::device_check::{NotRun, Verdict};

use common::*;

fn photos(handle: &centraid_core::Handle, count: usize) {
    for index in 0..count {
        let bytes = bytes_of(&format!("a photograph {index}"), 40_000);
        let staged = stage(handle, owned("image/heic", &bytes), &bytes);
        add_asset(handle, &staged, "photo");
    }
}

fn check(
    handle: &centraid_core::Handle,
    request: wire::CheckBackupRequest,
) -> wire::CheckBackupResponse {
    match ask(handle, wire::request::Kind::CheckBackup(request)) {
        wire::response::Kind::CheckBackup(answer) => answer,
        other => panic!("not a check answer: {other:?}"),
    }
}

fn at_home_check() -> wire::CheckBackupRequest {
    wire::CheckBackupRequest {
        rule: wire::TransferRule::WifiOnly as i32,
        ..Default::default()
    }
}

fn only(answer: &wire::CheckBackupResponse) -> &wire::DeviceCheck {
    assert_eq!(answer.devices.len(), 1, "{answer:?}");
    &answer.devices[0]
}

/// **A BACKUP THAT OPENS SAYS SO, WITH THE FILES IT HOLDS AND THE SAMPLE IT OPENED, AND THE
/// VAULT IS NOT TOUCHED.**
#[test]
fn a_backup_that_opens_is_counted_and_the_vault_is_left_alone() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    photos(&phone, 5);
    drain(&phone, at_home());
    let held = file_names(&phone).len();
    assert!(held > 0);
    let before = rows(&path);

    let answer = check(&phone, at_home_check());
    let device = only(&answer);
    assert_eq!(device.verdict, Verdict::Opens as i32, "{device:?}");
    assert!(device.files_held >= 5, "{device:?}");
    assert!(
        device.files_opened >= 5,
        "every small file is in the sample: {device:?}"
    );
    assert_eq!(device.files_missing + device.files_damaged, 0);
    assert!(device.snapshot_ms > 0);
    assert_eq!(rows(&path), before, "the vault is as it was");
    let scratch = dir.path().join("vault.scratch");
    assert!(
        !scratch.exists() || std::fs::read_dir(&scratch).expect("lists").next().is_none(),
        "the spare copy is gone"
    );
}

/// **A SAMPLED FILE THAT FAILS IS A FAILURE, AND IS SENT AGAIN BY THE NEXT PASS.**
#[test]
fn a_damaged_file_fails_the_line_and_is_owed_again() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    photos(&phone, 3);
    drain(&phone, at_home());
    for name in file_names(&phone) {
        let wire_name = centraid_gateway::rules::ids::Name::from_bytes(*name.as_bytes());
        gateway
            .spawned
            .corrupt(&vault_id(), &wire_name)
            .expect("damages");
    }
    let confirmed = ledger(&path).confirmed_names(&id).expect("reads").len();

    let answer = check(&phone, at_home_check());
    let device = only(&answer);
    assert_eq!(device.verdict, Verdict::DamagedFile as i32, "{device:?}");
    assert!(device.files_damaged > 0);
    assert!(
        ledger(&path).confirmed_names(&id).expect("reads").len() < confirmed,
        "the damaged files are no longer confirmed, so the next pass sends them again"
    );
    drain(&phone, quietly());
}

/// **A DEVICE THAT DOES NOT ANSWER, A RULE THAT SAYS WAIT, AND A STOP ARE NOT RUN.**
#[test]
fn a_device_that_cannot_be_checked_says_why_and_is_no_pass() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    photos(&phone, 1);
    drain(&phone, at_home());

    let metered = check(
        &phone,
        wire::CheckBackupRequest {
            metered: true,
            ..at_home_check()
        },
    );
    let device = only(&metered);
    assert_eq!(device.verdict, Verdict::NotRun as i32);
    assert_eq!(device.not_run, NotRun::WaitingForWifi as i32);

    gateway.cable().cut();
    let silent = check(&phone, at_home_check());
    let device = only(&silent);
    assert_eq!(device.verdict, Verdict::NotRun as i32, "{device:?}");
    assert_eq!(device.not_run, NotRun::DidNotAnswer as i32);
    gateway.cable().mend();
}

/// **A DEVICE PAIRED AND NEVER BACKED UP HAS NOTHING TO OPEN.**
#[test]
fn a_device_never_backed_up_has_nothing_to_open() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let answer = check(&phone, at_home_check());
    let device = only(&answer);
    assert_eq!(device.verdict, Verdict::NotRun as i32, "{device:?}");
    assert_eq!(device.not_run, NotRun::NoBackupYet as i32);
}
