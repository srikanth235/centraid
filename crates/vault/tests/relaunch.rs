//! WHAT AN APP LAUNCH COSTS THE SPOOL (#1029 W5, hand-off 5).
//!
//! The receipt carried two claims about `SQLITE_FCNTL_PERSIST_WAL` and no
//! measurement between them. W1 argued `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE` was
//! the whole of the requirement, since SQLite removes the `-wal` only after the
//! close-time checkpoint that setting skips. W3 recorded the opposite — "it
//! costs a base on every restart", because capture reads a restarted WAL as a
//! new generation and owes it a full base.
//!
//! **This is the measurement.** It is a property test and not a benchmark: the
//! thing the product needs is that a member closing the app and opening it
//! again does not put a whole vault back on the wire, and the observable form
//! of that is `CaptureOutcome.broke` and the generation id.
//!
//! ## What it proves, and where it does not reach
//!
//! It proves the property against THIS workspace's SQLite, on the host the gate
//! runs on. **Neither phone's SQLite has ever been compiled in this container**
//! — iOS links Apple's system build and Android its own — so the claim this
//! file makes is "held here", and `crates/core-ffi`'s `wal` shim is what closes
//! the case it cannot reach. `centraid_vault::wal_persistence` has that
//! argument in full.

use centraid_vault::Vault;
use centraid_vault::backup::objects::ObjectKeys;
use centraid_vault::backup::{BackupHome, capture};

fn scratch() -> std::path::PathBuf {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("the scratch directory is made");
    dir
}

/// A RELAUNCH DOES NOT BREAK THE GENERATION, so it does not owe a base.
///
/// Found, captured, **checkpointed** — which is the case the two claims differ
/// over, because the vault owns its checkpoints (`wal_autocheckpoint = 0`) and
/// a checkpointed WAL is the one SQLite would otherwise delete at close — then
/// the connection is dropped and the vault reopened. Capture comes back on the
/// same generation, having broken nothing.
#[test]
fn a_relaunch_does_not_break_the_generation() {
    let dir = scratch();
    let path = dir.join("v.db");
    let wal = dir.join("v.db-wal");
    let home = BackupHome::open(dir.join("backup")).expect("a backup home");
    let spool = home.spool().expect("a spool");
    let keys = ObjectKeys::new([7u8; 32], [9u8; 32]);

    let first = {
        let vault = Vault::create(path.clone()).expect("a vault");
        vault.found("Relaunch", "Owner").expect("founded");
        let captured = capture::capture(&vault, &spool, &keys).expect("the first capture");
        assert!(!captured.broke, "a first capture breaks nothing");
        // THE CHECKPOINT IS THE POINT. Without it the `-wal` still holds every
        // frame and SQLite has nothing to delete, so a test that skipped it
        // would pass while proving the easy half.
        capture::checkpoint(&vault, &spool).expect("the app checkpoints");
        captured.generation
    };

    // THE APP IS CLOSED. The `Vault` is dropped, which drops its one
    // `Connection`, which is the last connection on the file.
    assert!(
        wal.exists(),
        "the `-wal` survives the close, which is the property both claims are \
         about — `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE` is what keeps it here, and \
         `crates/core-ffi`'s `PERSIST_WAL` shim is what keeps it on a build \
         whose close path would delete it anyway"
    );

    // THE APP IS OPENED AGAIN, and writes.
    let vault = Vault::open(&path).expect("the vault reopens");
    vault
        .found("Second", "Owner")
        .expect("a write after the relaunch");
    let second = capture::capture(&vault, &spool, &keys).expect("the capture after a relaunch");

    assert!(
        !second.broke,
        "a relaunch must not break into a new generation: a break is a FULL BASE \
         on the wire, and a member who closes and opens the app has changed nothing"
    );
    assert_eq!(
        second.generation, first,
        "the same generation, so the segments after it still chain to the base \
         that is already uploaded"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// The seam is optional, and a vault with no host installed still opens.
///
/// `crates/centraid`'s own paths and every test in this crate run without a
/// shim, and a seam whose absence failed an open would make the shim a
/// dependency of the vault rather than a hardening of it.
#[test]
fn a_vault_opens_with_no_wal_persistence_host_installed() {
    let dir = scratch();
    let path = dir.join("v.db");
    let vault = Vault::create(path).expect("a vault opens with no host installed");
    vault.found("No host", "Owner").expect("and it founds");
    let _ = std::fs::remove_dir_all(&dir);
}
