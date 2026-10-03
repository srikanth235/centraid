//! THE PIN, AND WHAT A SWEEP MAY NOT TAKE (#1025 S3, R25).
//!
//! A pinned blob is the one copy of bytes nothing else holds — an original no
//! gateway has acknowledged. A sweep that freed space by taking one would turn
//! a member's photograph into a row with nothing behind it, and no later pass
//! could recover it. These are the sweep's tests and the ones that matter: a
//! pin survives a budget that cannot fit it, and the pressure it causes is
//! REPORTED rather than resolved by breaking the promise.

use std::collections::HashSet;

use centraid_blobs::{ByteStore, ContentHash};

/// Bytes that are distinct per seed and big enough to be worth sweeping.
fn filler(seed: u8, bytes: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes);
    let mut state = u64::from(seed).wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    while out.len() < bytes {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        out.extend_from_slice(&state.to_le_bytes());
    }
    out.truncate(bytes);
    out
}

/// A PIN IS NEVER AN EVICTION CANDIDATE, and the store says how far over budget
/// the pins alone put it.
///
/// The budget here is ZERO, which is the hardest case: every unpinned blob must
/// go and the pinned one must stay. A sweep that filtered pins out at the end
/// rather than before it ordered anything would take it on exactly this
/// arithmetic.
#[test]
fn a_pinned_blob_survives_a_sweep_that_takes_everything_else() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let store = ByteStore::open(dir.path().join("bytes")).expect("the store opens");

    let unacknowledged = filler(1, 64 * 1024);
    let pinned = store.put_bytes(&unacknowledged).expect("it lands").hash;
    let one = store
        .put_bytes(&filler(2, 64 * 1024))
        .expect("it lands")
        .hash;
    let two = store
        .put_bytes(&filler(3, 64 * 1024))
        .expect("it lands")
        .hash;
    for hash in [pinned, one, two] {
        assert!(store.is_complete(hash).expect("it answers"), "{hash}");
    }

    let pins: HashSet<ContentHash> = [pinned].into_iter().collect();
    let (swept, taken) = store.sweep(&pins, 0).expect("the sweep runs");

    assert_eq!(swept.evicted, 2, "both unpinned blobs are candidates");
    // THE SWEEP NAMES WHAT IT TOOK (#1025, D-1025-S7-20): a caller keeping a
    // row per held blob drops exactly these rows, and a count could not tell
    // it which.
    assert_eq!(taken.len(), 2);
    assert!(!taken.contains(&pinned), "a pin is never taken");
    assert_eq!(swept.pinned, 64 * 1024);
    // THE PRESSURE IS REPORTED, NOT RESOLVED. A store over budget BECAUSE of
    // pins says by how much; it does not take one to make the number look
    // better.
    assert_eq!(swept.over_budget_by, 64 * 1024);
    for gone in [one, two] {
        assert!(!store.is_complete(gone).expect("it answers"), "{gone}");
    }

    assert!(
        store.is_complete(pinned).expect("it answers"),
        "the one copy of an unacknowledged original was evicted to make room"
    );
    // And the bytes are still readable, not merely listed: the pin is about
    // the FILE, which is what the sealer reads when it backs the original up.
    assert_eq!(store.read(pinned).expect("the bytes read"), unacknowledged);
    let path = store
        .path_of(pinned)
        .expect("it answers")
        .expect("a held blob has a file");
    assert_eq!(
        std::fs::read(&path).expect("the file reads"),
        unacknowledged
    );
    assert_eq!(store.bytes_held().expect("it sums"), 64 * 1024);
}

/// A SWEEP THAT NEED NOT RUN TAKES NOTHING. The budget fits, so every blob is
/// left alone: a sweep that trimmed on every pass would make the phone fetch
/// back what it had.
#[test]
fn a_store_inside_its_budget_is_left_entirely_alone() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let store = ByteStore::open(dir.path().join("bytes")).expect("the store opens");
    let hash = store
        .put_bytes(&filler(4, 32 * 1024))
        .expect("it lands")
        .hash;

    let (swept, taken) = store
        .sweep(&HashSet::new(), 1024 * 1024)
        .expect("the sweep runs");
    assert_eq!(swept.evicted, 0);
    assert!(taken.is_empty());
    assert_eq!(swept.freed, 0);
    assert_eq!(swept.over_budget_by, 0);
    assert_eq!(swept.held, 32 * 1024);
    assert!(store.is_complete(hash).expect("it answers"));
}

/// OLDEST FIRST: a budget that fits one blob keeps the newest, because the
/// tail of the store is what landed longest ago.
#[test]
fn a_sweep_takes_the_oldest_first() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let store = ByteStore::open(dir.path().join("bytes")).expect("the store opens");
    let old = store.put_bytes(&filler(5, 16 * 1024)).expect("it lands");
    let new = store.put_bytes(&filler(6, 16 * 1024)).expect("it lands");
    let long_ago = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    std::fs::File::options()
        .write(true)
        .open(&old.path)
        .and_then(|file| file.set_modified(long_ago))
        .expect("ages the old blob");

    let (swept, taken) = store
        .sweep(&HashSet::new(), 16 * 1024)
        .expect("the sweep runs");
    assert_eq!(taken, vec![old.hash]);
    assert_eq!(swept.freed, 16 * 1024);
    assert!(store.is_complete(new.hash).expect("it answers"));
}
