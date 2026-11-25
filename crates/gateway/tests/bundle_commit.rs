//! A BUNDLE COMMITS IN ONE TRANSACTION, AND A CRASH LEAVES ONLY AN ORPHAN PACK
//! (`CGW4`, #1209, #1212, spec §4; #1191, B7, E14).
//!
//! Each `POST bundle` streams valid frames into one staged packfile, `fsync`s
//! it once, renames it into `packs/<vault>/<pack>.pack`, and commits all
//! completed frames in a single `BEGIN IMMEDIATE … COMMIT` SQLite transaction.
//! A process killed with `SIGKILL` between pack rename and SQLite commit leaves
//! zero rows in `state.db` and one orphan `.pack` file on disk, which
//! `orphans_once` removes once `ORPHAN_MIN_AGE_MS` passes.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use centraid_gateway::rules::bundle::Frame;
use centraid_gateway::rules::ids::{Name, VaultId};
use centraid_gateway::rules::state::State as _;
use centraid_gateway::server::harness::{Spawned, pair_secret, spawn};
use centraid_gateway::server::store::PackId;
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

/// One transaction per bundle, counted by the adapter, not timed: five frames
/// in one bundle execute one `BEGIN IMMEDIATE … COMMIT` transaction and write
/// one `.pack` file; re-sending the same five executes one transaction and
/// unlinks the redundant packfile because zero frames were newly stored.
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
    assert_eq!(answer.stored(), 5, "{answer:?}");
    assert_eq!(begun() - before, 1, "five frames, one SQLite transaction");
    assert_eq!(
        gateway.shared().store().pack_files().expect("lists").len(),
        1,
        "one packfile on disk"
    );

    let before = begun();
    let answer = phone.bundle(&vault, &frames).await.expect("answers");
    assert_eq!(answer.there(), 5);
    assert_eq!(begun() - before, 1, "duplicate bundle, one transaction");
    assert_eq!(
        gateway.shared().store().pack_files().expect("lists").len(),
        1,
        "redundant packfile with zero stored frames was unlinked"
    );
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

/// **The child**: re-executed by
/// `a_process_killed_between_a_rename_and_its_row_leaves_only_a_file`
/// with a data directory and a marker path, it uploads a bundle of three
/// frames and, the moment the staged `.pack` file has been renamed into
/// `packs/<vault>/` and before the SQLite transaction commits any rows, writes
/// the marker and parks forever until the parent sends `SIGKILL`.
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
            if renamed == 1 {
                std::fs::write(&marker, b"renamed").expect("the marker");
                loop {
                    std::thread::park();
                }
            }
        })));
    let _ = phone.bundle(&vault, &bundle_of_three()).await;
    unreachable!("the parent kills this process");
}

/// A PROCESS KILLED WITH `SIGKILL` BETWEEN PACK RENAME AND SQLITE COMMIT leaves
/// zero rows in `object` and one orphan `.pack` file on disk; `orphans_once`
/// leaves it alone while young and removes it once `ORPHAN_MIN_AGE_MS` passes.
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
        0,
        "killed before SQLite commit: zero object rows: {rows:?}"
    );
    assert_eq!(
        gateway.shared().store().pack_files().expect("lists").len(),
        1,
        "one orphan .pack file on disk"
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
        "the packfile is younger than ORPHAN_MIN_AGE_MS"
    );
    gateway.advance_clock(TWO_HOURS_MS);
    assert_eq!(orphans_once(gateway.shared()).expect("sweeps"), 1);
    assert_eq!(
        gateway.shared().store().pack_files().expect("lists").len(),
        0,
        "the orphan .pack file was cleaned up"
    );
    gateway.shutdown().await;
}

/// A SWEEP DURING AN OPEN BUNDLE COMMIT REMOVES NOTHING (#1191, E14): the hook
/// runs `orphans_once` right after the packfile rename while `commit_guard` is
/// active and before its SQLite transaction commits, with the clock two hours
/// ahead. It removes nothing; once committed, all three frames are live.
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
            if renamed == 1 {
                seen.store(orphans_once(&shared).expect("sweeps"), Ordering::SeqCst);
                files.store(
                    shared.store().pack_files().expect("lists").len() as u64,
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
        1,
        "the renamed packfile stood"
    );
    assert_eq!(
        gateway.shared().store().pack_files().expect("lists").len(),
        1
    );
    assert_eq!(
        orphans_once(gateway.shared()).expect("sweeps"),
        0,
        "after the commit the packfile is referenced by object rows"
    );
    let names: Vec<Name> = frames.iter().map(|f| f.name).collect();
    assert!(
        phone
            .exists(&vault, &names)
            .await
            .expect("exists")
            .is_empty()
    );
    gateway.shutdown().await;
}

/// A FAULT INSIDE A BUNDLE TRANSACTION ROLLS BACK ATOMICALLY AND UNLINKS THE
/// FAILED PACKFILE, WHILE EARLIER COMMITTED BUNDLES AND HEALED ROWS STAND.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_faulting_bundle_rolls_back_cleanly_and_heals_on_retry() {
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

    // Fault on the 2nd object inside the single bundle transaction: the whole
    // transaction rolls back and the new packfile is unlinked.
    gateway.shared().store().knobs().fail_commit(2);
    let both = [healing.clone(), other.clone()];
    assert!(
        phone.bundle(&vault, &both).await.is_err(),
        "the fault surfaces as an error"
    );
    gateway.shared().store().knobs().fail_commit(0);

    assert_eq!(
        gateway.shared().store().pack_files().expect("lists").len(),
        1,
        "the failed bundle's packfile was unlinked on rollback"
    );
    assert!(
        gateway
            .shared()
            .rules(|rules| Ok(rules.state.object(&vault, &other.name)?))
            .expect("reads")
            .is_none(),
        "the rolled-back bundle left no row for `other`"
    );

    // Retry succeeds in one transaction: `healing` is healed in a new pack and `other` is stored.
    let answer = phone.bundle(&vault, &both).await.expect("stores");
    assert_eq!(answer.stored(), 2, "{answer:?}");
    let (row, loc) = gateway
        .shared()
        .rules(|rules| Ok(rules.state.object_with_location(&vault, &healing.name)?))
        .expect("reads")
        .expect("the row is there");
    assert!(row.damaged_at_ms.is_none(), "healing cleared damaged_at_ms");
    let slice_digest = gateway
        .shared()
        .store()
        .read_slice_digest(&vault, loc, row.size)
        .expect("reads")
        .expect("slice exists");
    assert_eq!(slice_digest, row.digest);
    assert!(
        phone
            .exists(&vault, &[healing.name, other.name])
            .await
            .expect("exists")
            .is_empty()
    );
    gateway.shutdown().await;
}

/// R5: THE ORPHAN SWEEP'S CHECK AND UNLINK ARE ONE ATOMIC STEP UNDER THE
/// GATEWAY LOCK. While `orphans_once` is inside `before_orphan_unlink` removing
/// an aged orphan `.pack` file, a concurrent `POST bundle` waits for the lock
/// and commits its own `.pack` file safely afterward.
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
    let racing = frame("a name uploaded concurrently with orphan unlink");

    // Plant an aged orphan `.pack` file with zero rows in `object`.
    let orphan_id = PackId::from_bytes([0xee; 16]);
    let orphan_path = gateway.shared().store().pack_path(&vault, &orphan_id);
    std::fs::create_dir_all(orphan_path.parent().expect("vault packs dir")).expect("creates dir");
    std::fs::write(&orphan_path, b"what a crash left").expect("writes orphan pack");
    std::fs::File::options()
        .write(true)
        .open(&orphan_path)
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
                        .expect("the bundle is admitted after the orphan step");
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

    assert!(!orphan_path.exists(), "the orphan packfile was removed");
    let phone = gateway.client(paired.token);
    assert_eq!(
        phone.get(&vault, &racing.name, None).await.expect("reads"),
        racing.bytes
    );
    assert!(
        phone
            .exists(&vault, &[racing.name])
            .await
            .expect("exists")
            .is_empty(),
        "the newly uploaded object is live"
    );
    assert_eq!(
        gateway.shared().store().pack_files().expect("lists").len(),
        1
    );
    gateway.shutdown().await;
}
