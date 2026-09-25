//! ONE STORE DIRECTORY, OPENED TWICE: refused by name while held, and open
//! again once closed.
//!
//! iroh-blobs 0.103 never returns the error a held index produces — its
//! `load_with_opts` parks forever on the actor's failure path (see
//! `ByteStore::open`'s `refuse_if_held`) — so both cases are run under a
//! deadline: a regression here is a hang, and a hang is the one failure a test
//! runner reports as a timeout rather than as the sentence below.

use std::time::Duration;

use centraid_blobs::{ByteStore, StoreError};

const DEADLINE: Duration = Duration::from_secs(30);

async fn open_within_deadline(root: &std::path::Path) -> Result<ByteStore, StoreError> {
    tokio::time::timeout(DEADLINE, ByteStore::open(root))
        .await
        .unwrap_or_else(|_| {
            panic!(
                "opening {} did not return within {DEADLINE:?}: a held index hangs \
                 iroh-blobs' open instead of failing it",
                root.display()
            )
        })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_another_opener_holds_is_refused_by_name_and_not_waited_on() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let root = dir.path().join("bytes");
    let held = open_within_deadline(&root).await.expect("the first opens");

    let error = open_within_deadline(&root)
        .await
        .expect_err("a second opener on a held index is refused");
    assert!(
        matches!(&error, StoreError::Open { detail, .. } if detail.contains("held by another open store")),
        "the refusal names the reason: {error}"
    );

    held.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_closed_store_opens_again_in_the_same_process() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let root = dir.path().join("bytes");
    let first = open_within_deadline(&root).await.expect("the first opens");
    let hash = first
        .add_bytes(b"kept across a close".repeat(512))
        .await
        .expect("it lands");
    first.close().await;

    let second = open_within_deadline(&root)
        .await
        .expect("a closed store's directory opens again");
    assert!(
        second.is_complete(hash).await.expect("it answers"),
        "the reopened store holds what the first one took"
    );
    second.close().await;
}
