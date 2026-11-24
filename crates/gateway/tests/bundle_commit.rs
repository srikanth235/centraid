//! A BUNDLE'S FRAMES COMMIT EACH ON ITS OWN, AND A CRASH LEAVES ONLY FILES
//! (#1209, spec §4; #1191, B7, E14).
//!
//! Each frame is staged, fsynced, renamed into place and then given its row,
//! in its own transaction, as its last byte arrives. A crash between a
//! frame's rename and its row leaves a file with no row — the orphan sweep
//! takes it once it is an hour old — and never a row whose bytes are missing;
//! the frames before it are committed and stay so. The crash is real: a child
//! process is killed with SIGKILL between a rename and its row.

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

/// One transaction per frame, counted by the adapter, not timed: five frames
/// are five commits, and the same five again are five more (each is judged on
/// its own, so a cut after frame k has committed frames 1..k and nothing else).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bundle_commits_each_frame_in_its_own_transaction() {
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
    assert_eq!(answer.stored(), 5, "{answer:?}");
    assert_eq!(begun() - before, 5, "five frames, five transactions");

    let before = begun();
    let answer = phone.bundle(&vault, &frames).await.expect("answers");
    assert_eq!(answer.there(), 5);
    assert_eq!(begun() - before, 5);
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
/// `a_process_killed_between_a_rename_and_its_row_leaves_only_a_file`
/// with a data directory and a marker path, it uploads a bundle of three
/// frames and, the moment the second file has been renamed into place and
/// before its row is written, writes the marker and stops for ever, inside
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

/// A PROCESS KILLED BETWEEN A FRAME'S RENAME AND ITS ROW leaves that file and
/// no row, and the frame before it committed. The parent opens the data
/// directory the child left: the vault is there, the first frame has its row,
/// two files are on disk; the orphan sweep takes the second once the gateway's
/// clock says it is old, and not before.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_process_killed_between_a_rename_and_its_row_leaves_only_a_file() {
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
    assert_eq!(
        rows.len(),
        1,
        "the first frame committed on its own; the second has no row: {rows:?}"
    );
    assert_eq!(
        gateway.shared().store().files().expect("lists").len(),
        2,
        "both renamed files are on disk"
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
    assert_eq!(orphans_once(gateway.shared()).expect("sweeps"), 1);
    assert_eq!(
        gateway.shared().store().files().expect("lists").len(),
        1,
        "the committed frame's file stands"
    );
    gateway.shutdown().await;
}

/// A SWEEP DURING AN OPEN BUNDLE REMOVES NOTHING (#1191, E14): the hook runs
/// the orphan sweep after the second rename, while that frame is between its
/// rename and its row, with the clock two hours on so age alone would take
/// the file. It removes none; once the bundle is in, every file has a row.
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
    assert_eq!(answer.stored(), 3);
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

/// R3, PER FRAME: THE FRAMES BEFORE A FAULT STAY COMMITTED. The bundle heals a
/// damaged name with its own bytes (its own commit) and then faults on a
/// second frame: the first is whole (row and file agree, no longer damaged),
/// the second has no file and no row, and the next bundle finishes the work
/// with `there` for the first and `stored` for the second.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_frame_that_faults_leaves_the_frames_before_it_committed() {
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
        row.damaged_at_ms.is_none(),
        "the first frame committed on its own, and healed the name"
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
    assert_eq!((answer.there(), answer.stored()), (1, 1), "{answer:?}");
    assert!(
        phone
            .exists(&vault, &[healing.name, other.name])
            .await
            .expect("exists")
            .is_empty()
    );
    gateway.shutdown().await;
}

/// R5: THE ORPHAN SWEEP'S LOOK AND ITS UNLINK ARE ONE STEP. An old file with
/// no row is about to be removed; at that very point (inside the step, after
/// the look at the index, before the unlink) a frame of the same name is
/// started on another thread. It cannot run until the step ends — the sweep
/// holds the gateway's one lock across both — so its file is stored after the
/// unlink, not under it: the name is live, with its bytes on disk.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_frame_of_the_same_name_cannot_lose_its_file_to_the_orphan_sweep() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let key = ed25519_dalek::SigningKey::from_bytes(&[31; 32]);
    let paired = pair_secret(
        &gateway.first_contact(),
        &key,
        "a phone",
        gateway.mint_pairing_secret(),
    )
    .await
    .expect("pairs");
    let vault = VaultId::from_bytes(key.verifying_key().to_bytes());
    let racing = frame("a name an orphan file holds");

    // An orphan file, old enough.
    let path = gateway.shared().store().path(&vault, &racing.name);
    std::fs::create_dir_all(path.parent().expect("a parent")).expect("a fan-out dir");
    std::fs::write(&path, b"what a crash left").expect("an orphan");
    std::fs::File::options()
        .write(true)
        .open(&path)
        .expect("opens")
        .set_modified(std::time::SystemTime::now() - Duration::from_secs(2 * 3600))
        .expect("ages");

    let runtime = tokio::runtime::Handle::current();
    let destination = centraid_gateway::client::Destination {
        addrs: vec![gateway.addr.to_string()],
        cert_der: gateway.cert_der.clone(),
        token: paired.token,
    };
    let sending: Arc<std::sync::Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::default();
    let (slot, frame_put) = (Arc::clone(&sending), racing.clone());
    gateway
        .shared()
        .store()
        .knobs()
        .on_orphan_unlink(Some(Arc::new(move || {
            let (runtime, destination, frame) =
                (runtime.clone(), destination.clone(), frame_put.clone());
            let handle = std::thread::spawn(move || {
                runtime.block_on(async {
                    centraid_gateway::client::Client::new(&destination)
                        .bundle(&vault, std::slice::from_ref(&frame))
                        .await
                        .expect("the frame is admitted, after the step");
                });
            });
            *slot.lock().expect("slot") = Some(handle);
        })));
    assert_eq!(orphans_once(gateway.shared()).expect("sweeps"), 1);
    gateway.shared().store().knobs().on_orphan_unlink(None);
    let handle = sending
        .lock()
        .expect("slot")
        .take()
        .expect("the frame was sent");
    tokio::task::spawn_blocking(move || handle.join().expect("joins"))
        .await
        .expect("joined");

    assert_eq!(std::fs::read(&path).expect("its file"), racing.bytes);
    let phone = gateway.client(paired.token);
    assert!(
        phone
            .exists(&vault, &[racing.name])
            .await
            .expect("exists")
            .is_empty(),
        "the name is live"
    );
    gateway.shutdown().await;
}
