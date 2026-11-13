//! A BUNDLE COMMITS IN ONE TRANSACTION, AND A CRASH LEAVES ONLY FILES
//! (#1191, B7, E14).
//!
//! The frames of a bundle are staged and renamed into place first; one
//! `BEGIN IMMEDIATE` then inserts every row and commits. A crash between the
//! renames and the commit leaves files with no row — the orphan sweep takes
//! them once they are an hour old — and never a row whose bytes are missing.
//! The crash is real: a child process is killed with SIGKILL between the
//! renames and the commit.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use centraid_gateway::rules::bundle::Frame;
use centraid_gateway::rules::ids::{Name, VaultId};
use centraid_gateway::rules::state::State as _;
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

const CHILD_DATA: &str = "CENTRAID_BUNDLE_CHILD_DATA";
const CHILD_MARKER: &str = "CENTRAID_BUNDLE_CHILD_MARKER";
const TWO_HOURS_MS: i64 = 2 * 3_600_000;

fn bundle_of_three() -> Vec<Frame> {
    (0..3)
        .map(|index| frame(&format!("killed part {index}")))
        .collect()
}

/// **The child**: not a test of its own. Re-executed by
/// `a_process_killed_between_the_renames_and_the_commit_leaves_only_files`
/// with a data directory and a marker path, it uploads a bundle of three
/// frames and, the moment the second file has been renamed into place and
/// before any row is written, writes the marker and stops for ever, inside
/// the open transaction, until the parent kills it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn child_stages_a_bundle_and_stalls() {
    let (Some(data), Some(marker)) = (std::env::var_os(CHILD_DATA), std::env::var_os(CHILD_MARKER))
    else {
        return;
    };
    let gateway = spawn(std::path::Path::new(&data)).await.expect("spawned");
    let (vault, phone) = paired(&gateway).await;
    gateway
        .shared()
        .store()
        .knobs()
        .after_rename(Some(Arc::new(move |renamed| {
            if renamed == 2 {
                std::fs::write(&marker, b"renamed").expect("the marker");
                loop {
                    std::thread::park();
                }
            }
        })));
    let _ = phone.bundle(&vault, &bundle_of_three()).await;
    unreachable!("the parent kills this process");
}

/// A PROCESS KILLED BETWEEN A BUNDLE'S RENAMES AND ITS COMMIT leaves files and
/// no row. The parent opens the data directory the child left: the vault is
/// there, no object has a row, two files are on disk; the orphan sweep takes
/// them once the gateway's clock says they are old, and not before.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_process_killed_between_the_renames_and_the_commit_leaves_only_files() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let beside = tempfile::tempdir().expect("a temp dir");
    let marker = beside.path().join("renamed");
    let mut child = std::process::Command::new(std::env::current_exe().expect("this binary"))
        .args([
            "child_stages_a_bundle_and_stalls",
            "--exact",
            "--test-threads=1",
        ])
        .env(CHILD_DATA, dir.path())
        .env(CHILD_MARKER, &marker)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("starts the child");
    // Wait for the event, not for a time: the marker says two files are in
    // place and no row is.
    let waited = Instant::now();
    while !marker.exists() {
        assert!(
            child.try_wait().expect("polls").is_none(),
            "the child ended before it stalled"
        );
        assert!(
            waited.elapsed() < Duration::from_secs(300),
            "the child never reached the rename"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    child.kill().expect("SIGKILL");
    child.wait().expect("reaped");

    let gateway = spawn(dir.path()).await.expect("opens what the kill left");
    let vault = VaultId::from_bytes(
        ed25519_dalek::SigningKey::from_bytes(&[31; 32])
            .verifying_key()
            .to_bytes(),
    );
    let rows = gateway
        .shared()
        .rules(|rules| Ok(rules.state.vault_objects(&vault, None, 100)?))
        .expect("reads");
    assert!(rows.is_empty(), "no row without a commit: {rows:?}");
    assert_eq!(
        gateway.shared().store().files().expect("lists").len(),
        2,
        "the two renamed files are on disk"
    );
    assert_eq!(
        gateway
            .shared()
            .rules(|rules| rules.pairings())
            .expect("lists")
            .len(),
        1,
        "the vault and its state survived the kill"
    );
    assert_eq!(
        orphans_once(gateway.shared()).expect("sweeps"),
        0,
        "a file is not old enough to be an orphan yet"
    );
    gateway.advance_clock(TWO_HOURS_MS);
    assert_eq!(orphans_once(gateway.shared()).expect("sweeps"), 2);
    assert!(gateway.shared().store().files().expect("lists").is_empty());
    gateway.shutdown().await;
}

/// A SWEEP DURING AN OPEN BUNDLE REMOVES NOTHING (#1191, E14): the hook runs
/// the orphan sweep after the second rename, while the commit is between its
/// renames and its rows, with the clock two hours on so age alone would take
/// the files. It removes none; once the bundle is in, every file has a row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sweep_during_an_open_bundle_removes_nothing() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone) = paired(&gateway).await;
    gateway.advance_clock(TWO_HOURS_MS);
    let removed = Arc::new(AtomicU64::new(u64::MAX));
    let on_disk = Arc::new(AtomicU64::new(0));
    let shared = Arc::clone(gateway.shared());
    let (seen, files) = (Arc::clone(&removed), Arc::clone(&on_disk));
    gateway
        .shared()
        .store()
        .knobs()
        .after_rename(Some(Arc::new(move |renamed| {
            if renamed == 2 {
                seen.store(orphans_once(&shared).expect("sweeps"), Ordering::SeqCst);
                files.store(
                    shared.store().files().expect("lists").len() as u64,
                    Ordering::SeqCst,
                );
            }
        })));
    let frames = bundle_of_three();
    let answer = phone.bundle(&vault, &frames).await.expect("stores");
    assert_eq!(answer.stored.len(), 3);
    assert_eq!(removed.load(Ordering::SeqCst), 0, "the sweep stood aside");
    assert_eq!(
        on_disk.load(Ordering::SeqCst),
        2,
        "both renamed files stood"
    );
    assert_eq!(gateway.shared().store().files().expect("lists").len(), 3);
    assert_eq!(
        orphans_once(gateway.shared()).expect("sweeps"),
        0,
        "after the commit every file has a row"
    );
    let held = phone
        .exists(&vault, &[frames[0].name])
        .await
        .expect("exists");
    assert!(held.is_empty());
    gateway.shutdown().await;
}

/// R3: THE DAMAGED NAME A BUNDLE REPLACES IS NOT LEFT INCONSISTENT BY A
/// ROLLBACK. The bundle heals a damaged name with its own bytes and then
/// faults on a second frame, so the transaction rolls back: the row still
/// says damaged and still holds the digest the phone's bytes have, the file
/// on disk is those bytes, the second frame has no file and no row, and the
/// next bundle completes the work.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rolled_back_bundle_leaves_a_damaged_name_consistent() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone) = paired(&gateway).await;
    let healing = frame("a part that rots");
    let other = frame("a part the fault stops");
    phone
        .bundle(&vault, std::slice::from_ref(&healing))
        .await
        .expect("stores");
    gateway.corrupt(&vault, &healing.name).expect("rots");
    gateway.scrub_now().await.expect("scrubs");
    assert_eq!(
        phone.exists(&vault, &[healing.name]).await.expect("exists"),
        vec![healing.name],
        "the scrub marked it damaged"
    );

    // The second commit of the next bundle fails.
    gateway.shared().store().knobs().fail_commit(2);
    let both = [healing.clone(), other.clone()];
    assert!(
        phone.bundle(&vault, &both).await.is_err(),
        "the fault is an error"
    );
    gateway.shared().store().knobs().fail_commit(0);

    let on_disk = gateway
        .shared()
        .store()
        .read_digest(&vault, &healing.name)
        .expect("reads")
        .expect("the file is there");
    let row = gateway
        .shared()
        .rules(|rules| Ok(rules.state.object(&vault, &healing.name)?))
        .expect("reads")
        .expect("the row is there");
    assert_eq!(
        (row.digest, row.size),
        on_disk,
        "the row and the file agree on the bytes"
    );
    assert!(
        row.damaged_at_ms.is_some(),
        "the rolled-back row is still marked damaged"
    );
    assert!(
        gateway
            .shared()
            .store()
            .path(&vault, &other.name)
            .metadata()
            .is_err(),
        "the frame that faulted left no file"
    );
    assert!(
        gateway
            .shared()
            .rules(|rules| Ok(rules.state.object(&vault, &other.name)?))
            .expect("reads")
            .is_none(),
        "and no row"
    );
    // The phone's next bundle finishes it.
    let answer = phone.bundle(&vault, &both).await.expect("stores");
    assert_eq!(answer.stored.len() + answer.already.len(), 2, "{answer:?}");
    assert!(
        phone
            .exists(&vault, &[healing.name, other.name])
            .await
            .expect("exists")
            .is_empty()
    );
    gateway.shutdown().await;
}
