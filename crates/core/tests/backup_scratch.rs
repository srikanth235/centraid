//! THE SNAPSHOT'S COPY OF THE VAULT (#1188, design 6): taken without holding the vault, kept
//! only as long as it is needed, never copied when nothing changed, and refused with a reason
//! when the phone has no room. Every assertion is a count or a file that is there or is not.

mod common;

use centraid_api_proto::core_v1 as wire;
use common::*;

fn photos(handle: &centraid_core::Handle, count: usize) {
    photos_from(handle, 0, count);
}

fn photos_from(handle: &centraid_core::Handle, first: usize, count: usize) {
    for index in first..first + count {
        let bytes = bytes_of(&format!("a scratch photograph {index}"), 40_000);
        let staged = stage(handle, owned("image/heic", &bytes), &bytes);
        add_asset(handle, &staged, "photo");
    }
}

fn nothing_in(dir: &std::path::Path) {
    let scratch = dir.join("vault.scratch");
    assert!(
        !scratch.exists() || std::fs::read_dir(&scratch).expect("lists").next().is_none(),
        "no plaintext copy of the vault remains in {scratch:?}"
    );
}

/// **A PASS LEAVES NO COPY BEHIND**, whatever it did.
#[test]
fn a_pass_leaves_no_copy_of_the_vault() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    photos(&phone, 3);
    drain(&phone, at_home());
    assert_eq!(phone.copies_taken().0, 1, "one pass, one copy");
    nothing_in(dir.path());
}

/// **A VAULT THAT HAS NOT CHANGED IS NOT COPIED AGAIN**: two passes with no write between them
/// copy zero pages on the second, though the member asked for a snapshot both times.
#[test]
fn a_second_pass_with_no_write_copies_nothing() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    photos(&phone, 3);
    drain(&phone, at_home());
    drain(&phone, at_home());
    let (copies, pages) = phone.copies_taken();
    assert!(copies >= 1 && pages > 0);
    let after_settling = phone.copies_taken();

    let again = drain(&phone, at_home());
    assert_eq!(
        phone.copies_taken(),
        after_settling,
        "an unchanged vault, held whole, is not copied: {again:?}"
    );
    nothing_in(dir.path());

    // A WRITE MAKES THE NEXT PASS COPY AGAIN.
    photos_from(&phone, 1000, 1);
    drain(&phone, at_home());
    assert!(
        phone.copies_taken().0 > after_settling.0,
        "the write is owed"
    );
}

/// **A PHONE WITH NO ROOM SAYS SO, AND LEAVES THE SNAPSHOT OWED.** The reason is a status line,
/// not an empty screen; room mended, the next pass takes the snapshot and the reason goes.
#[test]
fn a_phone_with_no_room_says_so_and_catches_up_when_it_has_some() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let _path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    photos(&phone, 3);

    phone.pretend_free_bytes(Some(1024 * 1024));
    drain(&phone, at_home());
    assert_eq!(phone.copies_taken().0, 0, "no copy was started");
    nothing_in(dir.path());
    assert!(phone.plane().snapshot_owed(), "the snapshot is still owed");
    let stuck = status(&phone);
    assert!(
        waiting(&stuck, wire::WaitReason::NoRoom) > 0,
        "the status says why: {:?}",
        stuck.waiting
    );

    phone.pretend_free_bytes(None);
    drain(&phone, at_home());
    assert_eq!(phone.copies_taken().0, 1);
    let mended = status(&phone);
    assert_eq!(
        waiting(&mended, wire::WaitReason::NoRoom),
        0,
        "{:?}",
        mended.waiting
    );
}

/// **A COPY A CRASH LEFT GOES WHEN THE CORE OPENS.**
#[test]
fn a_copy_a_crash_left_is_gone_at_the_next_open() {
    let dir = tempfile::tempdir().expect("a directory");
    {
        let phone = phone(dir.path());
        phone.close();
    }
    let scratch = dir.path().join("vault.scratch");
    std::fs::create_dir_all(&scratch).expect("makes");
    std::fs::write(scratch.join("snapshot-1-abc.db"), b"the vault in the clear").expect("writes");
    std::fs::write(scratch.join("snapshot-1-abc.db-wal"), b"more of it").expect("writes");
    let reopened = reopen(&dir.path().join("vault.db"));
    nothing_in(dir.path());
    drop(reopened);
}

/// **THE VAULT IS FREE WHILE A COPY RUNS**: a commit lands between two steps of a copy taken the
/// way a pass takes one (the vault held for `source` alone), without waiting for it. The copy is
/// the moment it began; the commit is in the next.
#[test]
fn a_commit_lands_between_steps_of_a_copy_a_pass_would_take() {
    use centraid_vault::backup::snapshot;
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    photos(&phone, 60);
    let source = phone
        .with_vault(|vault| Ok(snapshot::source(vault).expect("a source")))
        .expect("held for the source alone");
    let scratch = dir.path().join("aside");
    let mut landed = 0_u32;
    let (copied, stats) = snapshot::copy_from(&source, &scratch, &mut |step| {
        if landed == 0 {
            // `with_vault` would deadlock here if the copy held the vault.
            photos_from(&phone, 1000, 1);
            landed = step;
        }
        Ok(())
    })
    .expect("copies");
    assert!(
        stats.steps > 1 && landed == 1,
        "{stats:?} landed at {landed}"
    );
    let census_total = |copied: &snapshot::Copied| -> i64 {
        snapshot::describe(
            copied,
            &centraid_vault::backup::naming::BackupKeys::from_root(&[1; 32]),
            &"ab".repeat(32),
            "test",
        )
        .expect("describes")
        .manifest
        .census
        .values()
        .sum()
    };
    let first = census_total(&copied);
    let second = {
        let next = phone
            .with_vault(|vault| {
                snapshot::copy(vault, &dir.path().join("next")).map_err(|error| {
                    centraid_core::CoreError::Invariant {
                        context: error.to_string(),
                    }
                })
            })
            .expect("copies");
        census_total(&next)
    };
    assert!(
        second > first,
        "the commit is in the next copy and not the first: {first} {second}"
    );
}
