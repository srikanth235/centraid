//! THE PIN, AND WHAT A SWEEP MAY NOT TAKE (#1025 S3, R25).
//!
//! `docs/mobile-offline.md`: "Bytes a queued intent still needs are not
//! evictable. The seat publishes the content ids its unsettled outbox names to
//! the offline byte store on every move of the queue, and the LRU sweep reads
//! that answer alongside the pins — so the one copy of what a pending write is
//! waiting on cannot be deleted to make room for a cache."
//!
//! The store had a `forget` and no sweep at all, so the rule had nothing to be
//! true of. These are the sweep's first tests and the ones that matter: a pin
//! survives a budget that cannot fit it, and the pressure it causes is
//! REPORTED rather than resolved by breaking the promise.

use centraid_blobs::{ByteStore, ContentHash};

/// Bytes that are distinct, compressible-free and big enough that the store
/// writes files rather than anything clever.
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
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pinned_blob_survives_a_sweep_that_takes_everything_else() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let store = ByteStore::open(dir.path().join("bytes"))
        .await
        .expect("the store opens");

    let queued = filler(1, 64 * 1024);
    let cache_a = filler(2, 64 * 1024);
    let cache_b = filler(3, 64 * 1024);
    let pinned = store.add_bytes(queued.clone()).await.expect("it lands");
    let one = store.add_bytes(cache_a).await.expect("it lands");
    let two = store.add_bytes(cache_b).await.expect("it lands");
    for hash in [pinned, one, two] {
        assert!(store.is_complete(hash).await.expect("it answers"), "{hash}");
    }

    let pins: std::collections::HashSet<ContentHash> = [pinned].into_iter().collect();
    let (swept, taken) = store.sweep(&pins, 0).await.expect("the sweep runs");

    assert_eq!(swept.evicted, 2, "both unpinned blobs are candidates");
    // THE SWEEP NAMES WHAT IT TOOK (#1025, D-1025-S7-20). The seat's held-blob
    // table drops exactly these rows in the same window, and a count could not
    // tell it which.
    assert_eq!(taken.len(), 2);
    assert!(!taken.contains(&pinned), "a pin is never taken");
    assert_eq!(swept.pinned, 64 * 1024);
    // THE PRESSURE IS REPORTED, NOT RESOLVED. A store over budget BECAUSE of
    // pins says by how much; it does not take one to make the number look
    // better.
    assert_eq!(swept.over_budget_by, 64 * 1024);

    assert!(
        store.is_complete(pinned).await.expect("it answers"),
        "the one copy of a queued write was evicted to make room for a cache"
    );
    // And the bytes are still readable, not merely indexed: the pin is about
    // the FILE, which is what a retried intent hands the gateway.
    assert_eq!(store.read(pinned).await.expect("the bytes read"), queued);
    let path = store
        .data_path(pinned)
        .await
        .expect("it answers")
        .expect("a complete blob has a file");
    assert_eq!(std::fs::read(&path).expect("the file reads"), queued);

    store.close().await;
}

/// A SWEEP THAT NEED NOT RUN TAKES NOTHING. The budget fits, so the cache is
/// left alone — an LRU that trimmed on every pass would spend a phone's data
/// re-fetching what it had.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_inside_its_budget_is_left_entirely_alone() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let store = ByteStore::open(dir.path().join("bytes"))
        .await
        .expect("the store opens");
    let hash = store
        .add_bytes(filler(4, 32 * 1024))
        .await
        .expect("it lands");

    let (swept, taken) = store
        .sweep(&std::collections::HashSet::new(), 1024 * 1024)
        .await
        .expect("the sweep runs");
    assert_eq!(swept.evicted, 0);
    assert!(taken.is_empty());
    assert_eq!(swept.freed, 0);
    assert_eq!(swept.over_budget_by, 0);
    assert!(store.is_complete(hash).await.expect("it answers"));

    store.close().await;
}
