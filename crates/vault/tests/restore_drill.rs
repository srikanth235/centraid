//! **The restore drill**, the step the `release` profile must not pass without
//! (#1029 §2, B3, B4).
//!
//! It moved here from `crates/centraid/tests/restore_drill.rs`. The old drill
//! ran the `centraid recover` binary against a password-wrapped recovery kit,
//! and both halves of that sentence are deleted: §5 replaces the kit file with
//! the member's 24 words, and Reference A's inventory deletes `recover` as a
//! gateway command. What the drill proves did not move — a vault is lost and a
//! generation brings it back — and the code that proves it now lives beside the
//! code it is about.
//!
//! One claim, stated as plainly as it can be: **a committed transaction
//! survives losing the vault and comes back byte-exact.**

use centraid_vault::backup::drill::run_drill;
use centraid_vault::backup::objects::ObjectKeys;

/// The two keys §0 derives for a vault. On a phone they come from the seed;
/// here they are fixed so the drill is deterministic in everything but the
/// randomness the format itself insists on.
fn keys() -> ObjectKeys {
    ObjectKeys::new([0x1d; 32], [0x2e; 32])
}

#[test]
fn a_lost_vault_comes_back_byte_exact_from_its_generation() {
    let dir = tempfile::tempdir().expect("a directory");
    let outcome = run_drill(dir.path(), &keys(), 24, 8, None).expect("the drill runs");

    assert!(outcome.total_rows > 0, "the drill lost nothing");
    assert!(
        outcome.byte_identical,
        "the restored vault is not byte-identical to the one that was lost"
    );
    assert!(
        outcome.segments_applied > 0,
        "B3: the drill must actually APPLY segments, not decrypt and discard them — \
         the tail after the base was {} segments",
        outcome.segments_applied
    );
    assert!(outcome.report.is_clean());
    assert!(
        outcome.restored.segments_left == 0,
        "a full restore leaves nothing on the floor"
    );
    assert_eq!(outcome.generation.len(), 32, "a 128-bit generation id");
    assert_eq!(outcome.manifest.len(), 64, "the manifest's object name");

    // **EVERY BLOB'S KEY AND PLACEMENT CAME BACK** (#1029 §4, F14, hand-off 5).
    // Not "this device is holding the plaintext": the vault owns its copy and
    // EVICTS it, so a restored phone holding nothing is the ordinary case. What
    // a restore has to have brought back is the file key and the
    // `(object, offset, length)` that say where the bytes are — and a
    // photograph whose key did not survive is one nobody will ever open again.
    let custody = outcome
        .report
        .checks
        .iter()
        .find(|check| check.name == "restored-blob-custody")
        .expect("the restored file carries blob custody, so the check ran");
    assert!(
        custody.ok,
        "blob custody did not survive: {}",
        custody.detail
    );
    assert!(
        custody.detail.starts_with("32 sampled"),
        "the check did not sample the 24 + 8 blobs the drill wrote: {}",
        custody.detail
    );

    // The line the gate's artifact log carries.
    println!(
        "restore drill: {} rows over {} tables, txid {}, {} segment(s) applied, byte-exact, in {} ms",
        outcome.total_rows,
        outcome.census_before.len(),
        outcome.txid,
        outcome.segments_applied,
        outcome.elapsed_ms
    );
}

/// The drill with **no** commits after the generation still restores — the case
/// a quiet phone is in, and the one a tail-only test would miss.
#[test]
fn a_generation_with_no_tail_after_it_still_restores() {
    let dir = tempfile::tempdir().expect("a directory");
    let outcome = run_drill(dir.path(), &keys(), 8, 0, None).expect("the drill runs");
    assert!(outcome.byte_identical);
    assert!(outcome.report.is_clean());
}
