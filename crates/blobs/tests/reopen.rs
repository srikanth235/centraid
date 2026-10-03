//! ONE STORE DIRECTORY, OPENED AGAIN AND OPENED TWICE.
//!
//! A phone switches back to a vault it left, and the JVM's ABI round trip opens,
//! closes and opens one file in one process. The store is a directory with no
//! index and no lock, so a reopen finds what the first opener took, and two
//! openers over one directory are one store: each sees the other's blobs the
//! moment they are named.

use centraid_blobs::{ByteStore, ContentHash};

#[test]
fn a_store_opened_again_holds_what_the_first_one_took() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let root = dir.path().join("bytes");
    let first = ByteStore::open(&root).expect("the first opens");
    let hash = first
        .put_bytes(&b"kept across a close".repeat(512))
        .expect("it lands")
        .hash;
    drop(first);

    let second = ByteStore::open(&root).expect("the directory opens again");
    assert!(
        second.is_complete(hash).expect("it answers"),
        "the reopened store holds what the first one took"
    );
    assert_eq!(
        second.read(hash).expect("it reads"),
        b"kept across a close".repeat(512)
    );
}

#[test]
fn two_openers_over_one_directory_are_one_store() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let root = dir.path().join("bytes");
    let one = ByteStore::open(&root).expect("the first opens");
    let two = ByteStore::open(&root).expect("a second opener is not refused");
    let hash = one
        .put_bytes(b"written through one")
        .expect("it lands")
        .hash;
    assert!(two.is_complete(hash).expect("it answers"));
    assert_eq!(two.hashes().expect("it lists"), vec![hash]);
    let again = two.put_bytes(b"written through one").expect("it lands");
    assert!(
        again.already_held,
        "the same bytes through the other opener"
    );
    assert_eq!(ContentHash::of(b"written through one"), again.hash);
}
