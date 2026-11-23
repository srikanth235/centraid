//! CHECK MY BACKUP, AND THE READ-BACK THAT WITHDRAWS A CLAIM, THROUGH THE CORE'S DOORS AGAINST A
//! REAL GATEWAY (#1188, B6, ruling 18; #1209 §6.2 step 7, §7).
//!
//! Each test states what the check says about one device, by counts and verdicts, never by how
//! long it took. The vault is read before and after: a check never touches it.

mod common;

use centraid_api_proto::core_v1 as wire;
use centraid_media::sealed::Class;
use wire::device_check::{NotRun, Verdict};

use common::*;

fn photos(handle: &centraid_core::Handle, count: usize) -> Vec<Vec<u8>> {
    (0..count)
        .map(|index| {
            let bytes = bytes_of(&format!("a photograph {index}"), 40_000);
            let staged = stage(handle, owned("image/heic", &bytes), &bytes);
            add_asset(handle, &staged, "photo");
            bytes
        })
        .collect()
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

fn originals_backed_up(handle: &centraid_core::Handle) -> bool {
    status(handle)
        .classes
        .iter()
        .find(|class| class.class == wire::BackupClass::Originals as i32)
        .is_some_and(|class| class.backed_up)
}

/// **A BACKUP THAT OPENS SAYS SO, WITH THE FILES IT HOLDS AND THE SAMPLE IT OPENED, AND THE VAULT
/// IS NOT TOUCHED.** The scratch copy is gone afterwards.
#[test]
fn a_backup_that_opens_is_counted_and_the_vault_is_left_alone() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    photos(&phone, 5);
    drain(&phone, at_home());
    let before = rows(&path);

    let answer = check(&phone, at_home_check());
    let device = only(&answer);
    assert_eq!(device.verdict, Verdict::Opens as i32, "{device:?}");
    assert_eq!(device.files_held, 5, "{device:?}");
    assert_eq!(
        device.files_opened, 5,
        "every file is inside the sample: {device:?}"
    );
    assert_eq!((device.files_missing, device.files_damaged), (0, 0));
    assert_eq!(rows(&path), before, "a check never touches the vault");
    assert!(
        originals_backed_up(&phone),
        "an honest check withdraws nothing"
    );
    assert!(
        !phone.plane().scratch_dir().exists()
            || std::fs::read_dir(phone.plane().scratch_dir())
                .expect("lists")
                .next()
                .is_none(),
        "the spare copy is removed on every path out"
    );
}

/// **A DAMAGED CHUNK FAILS THE LINE AND IS OWED AGAIN**: the check names the file, the gateway
/// is told to free the damaged name, every claim for the device is withdrawn, and the next pass
/// sends the chunk again.
#[test]
fn a_damaged_chunk_fails_the_line_and_is_owed_again() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let held = photos(&phone, 3);
    drain(&phone, at_home());
    let chunk = chunk_of(&held[1], 0, Class::Originals);
    gateway
        .spawned
        .corrupt(&vault_id(), &chunk)
        .expect("a bit flips");

    let answer = check(&phone, at_home_check());
    let device = only(&answer);
    assert_eq!(device.verdict, Verdict::DamagedFile as i32, "{device:?}");
    assert_eq!(device.files_damaged, 1, "{device:?}");
    assert!(!originals_backed_up(&phone), "the claim is withdrawn");

    // The next pass is a recovery pass: it frees the damaged name, sends the chunk again, and
    // the check is clean.
    let again = drain(&phone, at_home());
    assert_eq!(again.stopped, wire::DrainStop::Empty as i32, "{again:?}");
    assert!(originals_backed_up(&phone));
    assert_eq!(
        only(&check(&phone, at_home_check())).verdict,
        Verdict::Opens as i32
    );
}

/// **A CHUNK THE GATEWAY LOST IS A MISSING FILE**, counted by name, and sent again.
#[test]
fn a_chunk_the_gateway_lost_is_a_missing_file_and_is_sent_again() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let held = photos(&phone, 3);
    drain(&phone, at_home());
    gateway
        .spawned
        .lose(&vault_id(), &chunk_of(&held[0], 0, Class::Originals))
        .expect("the gateway loses it");

    let device = check(&phone, at_home_check());
    let device = only(&device);
    assert_eq!(device.verdict, Verdict::MissingFiles as i32, "{device:?}");
    assert_eq!(device.files_missing, 1);
    assert!(!originals_backed_up(&phone));
    let commits = gateway.spawned.commit_order().len();
    drain(&phone, at_home());
    assert_eq!(
        gateway.spawned.commit_order().len() - commits,
        1,
        "the lost chunk is the only object sent: nothing else was owed"
    );
    assert_eq!(
        only(&check(&phone, at_home_check())).verdict,
        Verdict::Opens as i32
    );
}

/// **A READ-BACK THAT FINDS A ROTTED CHUNK WITHDRAWS THE CLAIM** (E10): the pass samples what the
/// gateway is said to hold, and the one after it sends the chunk again.
#[test]
fn a_pass_reads_back_a_sample_and_finds_a_chunk_a_gateway_damaged() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let held = photos(&phone, 3);
    drain(&phone, at_home());
    // The first pass of a gateway does not read back until it is whole; this one is.
    let chunk = chunk_of(&held[2], 0, Class::Originals);
    gateway
        .spawned
        .corrupt(&vault_id(), &chunk)
        .expect("a bit flips");

    drain(&phone, quietly());
    assert!(
        !originals_backed_up(&phone),
        "the read-back found it and withdrew the claim"
    );
    let mended = drain(&phone, quietly());
    assert_eq!(mended.stopped, wire::DrainStop::Empty as i32, "{mended:?}");
    assert!(originals_backed_up(&phone));
    assert_eq!(
        only(&check(&phone, at_home_check())).verdict,
        Verdict::Opens as i32
    );
}

/// **A DEVICE THAT CANNOT BE CHECKED SAYS WHY AND IS NO PASS**: a gateway that does not answer, a
/// rule that keeps files off a metered link, and too little room for the spare copy.
#[test]
fn a_device_that_cannot_be_checked_says_why_and_is_no_pass() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    photos(&phone, 2);
    drain(&phone, at_home());

    let metered = check(
        &phone,
        wire::CheckBackupRequest {
            metered: true,
            ..at_home_check()
        },
    );
    assert_eq!(
        only(&metered).not_run,
        NotRun::WaitingForWifi as i32,
        "{metered:?}"
    );

    phone.pretend_free_bytes(Some(0));
    let cramped = check(&phone, at_home_check());
    assert_eq!(
        only(&cramped).not_run,
        NotRun::NeedsSpace as i32,
        "{cramped:?}"
    );
    phone.pretend_free_bytes(None);

    gateway.cable().cut();
    let away = check(&phone, at_home_check());
    assert_eq!(only(&away).not_run, NotRun::DidNotAnswer as i32, "{away:?}");
    gateway.cable().mend();
    assert_eq!(
        only(&check(&phone, at_home_check())).verdict,
        Verdict::Opens as i32
    );
}

/// **A DEVICE NEVER BACKED UP HAS NOTHING TO OPEN.**
#[test]
fn a_device_never_backed_up_has_nothing_to_open() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let answer = check(&phone, at_home_check());
    assert_eq!(
        only(&answer).not_run,
        NotRun::NoBackupYet as i32,
        "{answer:?}"
    );
}
