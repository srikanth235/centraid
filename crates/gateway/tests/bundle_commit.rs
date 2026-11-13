//! A BUNDLE COMMITS IN ONE TRANSACTION, AND A CRASH LEAVES ONLY FILES
//! (#1191, B7, E14).
//!
//! The frames of a bundle are staged and renamed into place first; one
//! `BEGIN IMMEDIATE` then inserts every row and commits. A crash between the
//! renames and the commit leaves files with no row — the orphan sweep takes
//! them once they are an hour old — and never a row whose bytes are missing.

use std::time::{Duration, SystemTime};

use centraid_gateway::rules::bundle::Frame;
use centraid_gateway::rules::ids::{Name, VaultId};
use centraid_gateway::server::harness::{Spawned, pair_secret, spawn};
use centraid_gateway::server::sweeps::orphans_once;

async fn paired(gateway: &Spawned) -> (VaultId, centraid_gateway::client::Client) {
    let key = ed25519_dalek::SigningKey::from_bytes(&[31; 32]);
    let paired = pair_secret(
        &gateway.first_contact(),
        &key,
        "a phone",
        gateway.mint_pairing_secret(),
    )
    .await
    .expect("pairs");
    (
        VaultId::from_bytes(key.verifying_key().to_bytes()),
        gateway.client(paired.token),
    )
}

fn frame(label: &str) -> Frame {
    let name = Name::from_bytes(blake3::derive_key("bundle commit name", label.as_bytes()));
    Frame::of(name, blake3::hash(label.as_bytes()).as_bytes().repeat(16))
}

/// One `BEGIN IMMEDIATE` and one `COMMIT` for a bundle of five frames, counted
/// by the adapter, not timed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bundle_commits_in_one_transaction() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone) = paired(&gateway).await;
    let begun = || {
        gateway
            .shared()
            .rules(|rules| Ok(rules.state.transactions()))
            .expect("counts")
    };

    let frames: Vec<Frame> = (0..5)
        .map(|index| frame(&format!("part {index}")))
        .collect();
    let before = begun();
    let answer = phone.bundle(&vault, &frames).await.expect("stores");
    assert_eq!(answer.stored.len(), 5, "{answer:?}");
    assert_eq!(begun() - before, 1, "five frames, one transaction");

    // The same bundle again is five "already held" answers in one more.
    let before = begun();
    let answer = phone.bundle(&vault, &frames).await.expect("answers");
    assert_eq!(answer.already.len(), 5);
    assert_eq!(begun() - before, 1);
    gateway.shutdown().await;
}

/// What a crash between the renames and the commit leaves: files with no row.
/// None of them is listed or held; the orphan sweep removes the old ones and
/// leaves a bundle in flight (a young file) and every file that has a row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crash_between_staging_and_commit_leaves_no_row_without_bytes() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone) = paired(&gateway).await;
    let kept = frame("a stored part");
    phone
        .bundle(&vault, std::slice::from_ref(&kept))
        .await
        .expect("stores");

    let leftover = |label: &str, age: Duration| {
        let lost = frame(label);
        let path = gateway.shared().store().path(&vault, &lost.name);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("a fan-out dir");
        std::fs::write(&path, &lost.bytes).expect("a renamed file");
        let file = std::fs::File::options()
            .write(true)
            .open(&path)
            .expect("opens");
        file.set_modified(SystemTime::now() - age).expect("ages");
        (lost.name, path)
    };
    let (old_name, old) = leftover("left by a crash", Duration::from_secs(2 * 3600));
    let (_, young) = leftover("a bundle in flight", Duration::from_secs(60));

    // No row: not held, not listed, and a PUT of the name stores it.
    let missing = phone.exists(&vault, &[old_name]).await.expect("exists");
    assert_eq!(missing, vec![old_name], "a file with no row is not held");
    assert!(
        phone
            .objects(&vault, None, 10)
            .await
            .expect("lists")
            .iter()
            .all(|entry| entry.name != old_name)
    );

    let removed = orphans_once(gateway.shared()).expect("sweeps");
    assert_eq!(removed, 1, "one old orphan");
    assert!(!old.exists(), "the old orphan is gone");
    assert!(young.exists(), "a bundle in flight is left alone");
    assert!(
        gateway.shared().store().path(&vault, &kept.name).is_file(),
        "a file with a row is never an orphan"
    );
    gateway.shutdown().await;
}
