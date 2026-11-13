//! THE SNAPSHOT READS THE VAULT UNDER ONE PIN AND WRITES NO COPY OF IT (#1191, B11): taken
//! without holding the vault, sealed as it is read, never walked again when nothing changed,
//! refused with a reason when the phone has no room, and refused outright over a damaged page.
//! Every assertion is a count or a file that is there or is not.

mod common;

use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::pagesource::{self, PinnedPages};
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

/// Every file under `dir` except the vault's own three, with its bytes.
fn others(dir: &std::path::Path) -> Vec<(std::path::PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(&next).expect("lists").flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
            if matches!(
                name.as_deref(),
                Some("vault.db" | "vault.db-wal" | "vault.db-shm")
            ) {
                continue;
            }
            out.push((path.clone(), std::fs::read(&path).unwrap_or_default()));
        }
    }
    out
}

/// **A PASS WRITES NO PLAINTEXT COPY OF THE VAULT** (V21, `no_plaintext_vault_copy_on_disk`
/// against the real pass, not only the reader): after a pass that sealed the whole vault, no
/// file beside the vault's own three holds a page of it, and no scratch directory exists.
#[test]
fn a_pass_writes_no_plaintext_copy_of_the_vault() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    photos(&phone, 3);
    let path = dir.path().join("vault.db");
    let (page_size, pages): (usize, BTreeSet<[u8; 32]>) = {
        let mut pinned = PinnedPages::begin(&path).expect("a pin");
        let page_size = usize::try_from(pinned.page_size()).expect("a size");
        let mut set = BTreeSet::new();
        for index in 0..pinned.range_count() {
            for page in pinned.range(index).expect("a range").chunks(page_size) {
                if page.iter().any(|byte| *byte != 0) {
                    set.insert(*blake3::hash(page).as_bytes());
                }
            }
        }
        pinned.end().expect("ends");
        (page_size, set)
    };
    assert!(
        pages.len() > 16,
        "a founded vault with photographs is many pages"
    );
    drain(&phone, at_home());
    assert_eq!(phone.walks_taken().0, 1, "one pass, one walk");
    assert_eq!(pagesource::live_pins(), 0, "no pin outlives the pass");
    nothing_in(dir.path());
    for (file, bytes) in others(dir.path()) {
        for page in bytes.chunks(page_size).filter(|p| p.len() == page_size) {
            assert!(
                !pages.contains(blake3::hash(page).as_bytes()),
                "{} holds a page of the vault in the clear",
                file.display()
            );
        }
    }
}

/// **A VAULT THAT HAS NOT CHANGED IS NOT WALKED AGAIN**: two passes with no write between them
/// walk nothing on the second, though the member asked for a snapshot both times.
#[test]
fn a_second_pass_with_no_write_walks_nothing() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    photos(&phone, 3);
    drain(&phone, at_home());
    drain(&phone, at_home());
    let (walks, sealed) = phone.walks_taken();
    assert!(walks >= 1 && sealed > 0);
    let after_settling = phone.walks_taken();

    let again = drain(&phone, at_home());
    assert_eq!(
        phone.walks_taken(),
        after_settling,
        "an unchanged vault, held whole, is not walked: {again:?}"
    );
    nothing_in(dir.path());

    // A WRITE MAKES THE NEXT PASS WALK AGAIN, AND SEAL ONLY WHAT CHANGED.
    photos_from(&phone, 1000, 1);
    drain(&phone, at_home());
    let (walks_now, sealed_now) = phone.walks_taken();
    assert!(walks_now > after_settling.0, "the write is owed");
    assert!(
        sealed_now - after_settling.1 < sealed,
        "one write seals fewer ranges ({}) than the whole vault ({sealed})",
        sealed_now - after_settling.1
    );
}

/// **A PHONE WITH NO ROOM SAYS SO, AND LEAVES THE SNAPSHOT OWED.** The reason is a status line,
/// not an empty screen; the spool holds no more than its budget; room mended, the next pass takes
/// the snapshot and the reason goes.
#[test]
fn a_phone_with_no_room_says_so_and_catches_up_when_it_has_some() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    photos(&phone, 3);

    phone.pretend_free_bytes(Some(64 * 1024));
    drain(&phone, at_home());
    let spool =
        centraid_vault::backup::spool::Spool::open(phone.plane().spool_dir()).expect("the spool");
    assert!(
        spool.bytes().expect("sums")
            <= centraid_vault::backup::spool::Spool::budget(64 * 1024)
                .max(centraid_vault::backup::spool::sealed_bound(64 * 1024)),
        "the spool held no more than its budget"
    );
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
    let mended = status(&phone);
    assert_eq!(
        waiting(&mended, wire::WaitReason::NoRoom),
        0,
        "{:?}",
        mended.waiting
    );
    assert!(!phone.plane().snapshot_owed(), "the snapshot was taken");
}

/// **A DIRECTORY A CRASH (OR AN EARLIER BUILD) LEFT GOES WHEN THE CORE OPENS.**
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

/// **A DAMAGED PAGE STOPS A BACKUP PASS** (D1, V21). Eight bytes of a table page of the vault
/// file are overwritten under a core that is running; the next pass finds it on the same pin
/// that read the pages, answers the vault-damaged code, signs no head, queues nothing, and the
/// gateway's head stays where it was.
#[test]
fn a_damaged_page_stops_a_backup_pass() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    photos(&phone, 3);
    drain(&phone, at_home());
    let path = dir.path().join("vault.db");
    let before = first_head(&path);

    // Fold the WAL into the file, then damage a table leaf in it.
    pagesource::fold_wal(&path).expect("folds the WAL into the file");
    let mut bytes = std::fs::read(&path).expect("reads");
    let page_size = {
        let pinned = PinnedPages::begin(&path).expect("a pin");
        let size = usize::try_from(pinned.page_size()).expect("a size");
        pinned.end().expect("ends");
        size
    };
    // THE PAGE OF A TABLE NO PHOTOGRAPH WRITES TO (the founder's row lives in `person`), so the
    // commit below leaves the damage where it is.
    let leaf = {
        let pinned = PinnedPages::begin(&path).expect("a pin");
        let root = pinned.root_page("person").expect("reads").expect("a table");
        pinned.end().expect("ends");
        usize::try_from(root).expect("a page") - 1
    };
    assert_eq!(bytes[leaf * page_size], 0x0d, "a table leaf");
    for offset in 3..11 {
        bytes[leaf * page_size + offset] = 0xff;
    }
    std::fs::write(&path, &bytes).expect("damages");

    // A WRITE SINCE THE LAST SNAPSHOT makes the next pass take one.
    photos_from(&phone, 2000, 1);
    let owed_before = owed_any(&path).len();
    let refused = try_drain(
        &phone,
        wire::DrainRequest {
            asked: true,
            ..at_home()
        },
    );
    let error = refused.expect_err("a damaged vault is not backed up");
    assert!(
        matches!(
            error,
            centraid_core::CoreError::Vault(centraid_vault::VaultError::Damaged { .. })
        ),
        "{error:?}"
    );
    assert_eq!(pagesource::live_pins(), 0, "the pin ended");
    assert_eq!(first_head(&path), before, "no head was set");
    assert_eq!(owed_any(&path).len(), owed_before, "nothing was queued");
}
