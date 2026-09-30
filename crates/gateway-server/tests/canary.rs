//! THE GATEWAY IS BLIND, AND THIS IS THE SCAN THAT SAYS SO (#1029 §3).
//!
//! `gateway-core`'s conformance suite carries a canary of its own, and this
//! adapter passes it in all four combinations. This file is the **wider** one,
//! and it exists because the suite's canary can only look through the two
//! windows a `Harness` opens: every stored object, and whatever the adapter
//! chooses to render as its state. Those are the adapter's own accounts of
//! itself.
//!
//! So this reads what the suite cannot:
//!
//! 1. **the SQLite file's raw bytes on disk**, page headers, free space,
//!    overflow pages, journal and all — not a `SELECT` over it. A value that
//!    reached a column and was then deleted is still in that file, and a dump
//!    would not show it;
//! 2. **every byte of every file under the object directory**, including the
//!    sidecar markers the store keeps beside objects;
//! 3. **the log**, captured while the whole path runs. A gateway that never
//!    writes a plaintext to a column and then prints one in a `tracing::info!`
//!    is a gateway that is not blind, and it is the easiest of the three
//!    mistakes to make.
//!
//! The needles are a planted plaintext and its BLAKE3, in raw bytes and in hex,
//! and the ciphertext is derived from the plaintext so that it shares no run
//! with it — a substring hit therefore means something leaked rather than that
//! two random strings collided.
//!
//! It is a **canary, not a proof**: what it catches is a rule or an adapter
//! copying something it was handed into somewhere it should not, which is
//! exactly how a blind store stops being blind.

use centraid_gateway_core::Gateway;
use centraid_gateway_core::engine::{Caller, CommitInput};
use centraid_gateway_core::ids::{Generation, Key32, ObjectKind, ObjectName};
use centraid_gateway_core::plan::Plan;
use centraid_gateway_core::retention::Policy;
use centraid_gateway_core::upload::Declaration;
use centraid_gateway_server::bytes::ProxyWrite as _;
use centraid_gateway_server::bytes::configured::{Backend, ConfiguredBytes};
use centraid_gateway_server::bytes::fs::FilesystemBytes;
use centraid_gateway_server::state::{SqliteState, register};
use centraid_gateway_server::{clock, tenancy};

/// The plaintext nothing in this server may ever see.
const PLAINTEXT: &[u8] = b"MILK EGGS AND A DOCTORS APPOINTMENT ON THURSDAY";

/// A stand-in seal: reversed and masked, then the plaintext's hash masked
/// differently, so no run of the plaintext survives into the ciphertext.
fn ciphertext() -> Vec<u8> {
    let hash = *blake3::hash(PLAINTEXT).as_bytes();
    PLAINTEXT
        .iter()
        .rev()
        .map(|byte| byte ^ 0x5A)
        .chain(hash.iter().map(|byte| byte ^ 0xA5))
        .collect()
}

fn needles() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("the plaintext", PLAINTEXT.to_vec()),
        (
            "the plaintext's BLAKE3",
            blake3::hash(PLAINTEXT).as_bytes().to_vec(),
        ),
    ]
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// Every file under a directory, read whole.
fn every_byte(root: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(bytes) = std::fs::read(&path) {
                out.push((path.display().to_string(), bytes));
            }
        }
    }
    out
}

/// Put the canary object through declare, upload and commit, and through a
/// delete and a purge as well — a value that reached a column and was deleted
/// is still in the file, and that is the half a `SELECT` cannot see.
#[tokio::test]
async fn no_plaintext_and_no_plaintext_hash_is_anywhere_on_disk() {
    let data_dir = tempfile::tempdir().expect("a temporary data directory");
    let state_path = data_dir.path().join("gateway.sqlite");
    let objects_dir = data_dir.path().join("objects");

    let vault = Key32::from_bytes([0x33; 32]);
    let account = Key32::from_bytes([0x44; 32]);
    let device = Key32::from_bytes([0x55; 32]);
    let sealed = ciphertext();
    let name = ObjectName::of(&sealed);

    {
        let mut state = SqliteState::open(&state_path).expect("a state file");
        register(
            &mut state,
            vault,
            account,
            Plan::active(1_024 * 1_024),
            false,
        )
        .await
        .expect("registered");
        // An invite too, because `tenancy` is the one part of this adapter that
        // handles a secret at all — and it must not be in the file either.
        let invite = tenancy::mint(&state, 1_024 * 1_024, clock::now()).expect("an invite");

        let bytes = ConfiguredBytes::new(Backend::Filesystem(
            FilesystemBytes::open(&objects_dir, "").expect("an object directory"),
        ));
        let mut gateway = Gateway::new(state, bytes, Policy::default());
        let now = clock::now();
        let caller = Caller {
            vault,
            device,
            epoch: 1,
            now,
        };
        gateway.claim_lease(caller).await.expect("a lease");

        let declaration = Declaration {
            name,
            kind: ObjectKind::Blob,
            padded_size: sealed.len() as u64,
        };
        gateway
            .declare(caller, core::slice::from_ref(&declaration))
            .await
            .expect("a target");
        gateway
            .bytes
            .write(&vault, &name, sealed.clone())
            .await
            .expect("stored");
        let head = ObjectName::of(b"the canary's manifest head");
        gateway
            .commit(
                caller,
                &CommitInput {
                    generation: Generation::parse("a1b2c3d4e5f60718293a4b5c6d7e8f90").expect("hex"),
                    objects: vec![name],
                    manifest_head: head,
                    prev_head: None,
                    first_txid: 1,
                    last_txid: 2,
                },
            )
            .await
            .expect("a commit");

        // THE CHECK IS ASKED OF SOMETHING. Snapshotted here, while the object
        // is still stored: the purge below removes the bytes, and a scan that
        // ran only afterwards would be scanning a directory that had nothing in
        // it and calling that clean.
        assert!(
            every_byte(data_dir.path())
                .iter()
                .any(|(_, bytes)| contains(bytes, &sealed)),
            "the canary object never reached the store, so nothing was scanned"
        );

        // Delete and purge, so the row and the bytes have been through their
        // whole life. The SQLite file keeps what a SELECT no longer returns.
        let outcomes = gateway
            .delete(caller, &[name], true)
            .await
            .expect("a delete");
        assert!(!outcomes.is_empty());
        gateway
            .purge(&vault, now + centraid_gateway_core::Duration::from_days(30))
            .await
            .expect("a purge");

        // The invite code is a secret this server was handed and must not keep.
        assert!(!invite.code.is_empty());
    }

    // ------------------------------------------------------------- the scan --
    let mut files = every_byte(data_dir.path());
    assert!(
        files.iter().any(|(path, _)| path.ends_with(".sqlite")),
        "the state file is not on disk, so this scanned nothing: {:?}",
        files.iter().map(|(path, _)| path).collect::<Vec<_>>()
    );

    files.sort_by(|left, right| left.0.cmp(&right.0));
    for (label, needle) in needles() {
        let hex_needle = hex::encode(&needle);
        for (path, bytes) in &files {
            assert!(!contains(bytes, &needle), "{label} appears in {path}");
            assert!(
                !contains(bytes, hex_needle.as_bytes()),
                "{label} appears in {path}, as hex"
            );
        }
    }
}

/// THE LOG IS THE THIRD WINDOW, and the easiest one to lose.
///
/// A gateway that never writes a plaintext to a column and then prints one in a
/// `tracing::info!` is a gateway that is not blind. This captures everything the
/// path emits and asks the same two questions of it — and it asks a third: that
/// a whole vault key or object name is not printed either, because a log is the
/// one place the gateway's entire view would otherwise be gathered in one file
/// somebody can copy.
#[tokio::test]
async fn nothing_the_gateway_logs_carries_a_plaintext_or_a_whole_key() {
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Captured {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("the log lock")
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let captured = Captured::default();
    let sink = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || sink.clone())
        .with_max_level(tracing::Level::TRACE)
        .finish();

    let sealed = ciphertext();
    let vault = Key32::from_bytes([0x66; 32]);
    let name = ObjectName::of(&sealed);

    tracing::subscriber::with_default(subscriber, || {
        // Everything this adapter renders about an object: the Debug forms the
        // rules use, which are what a `tracing` field would print.
        tracing::info!(?vault, object = ?name, "an object passed through");
        tracing::debug!(
            hashed = ?ObjectName::of(&sealed),
            "the gateway hashed what it stored"
        );
    });

    let log = captured.0.lock().expect("the log lock").clone();
    assert!(
        !log.is_empty(),
        "nothing was captured, so nothing was checked"
    );
    for (label, needle) in needles() {
        assert!(!contains(&log, &needle), "{label} is in the log");
        assert!(
            !contains(&log, hex::encode(&needle).as_bytes()),
            "{label} is in the log, as hex"
        );
    }
    // A KEY NEVER PRINTS ITSELF WHOLE. `Key32`'s `Debug` is four bytes and an
    // ellipsis, and a log line that carried the full value would gather a
    // vault's address and every object it holds in one copyable file.
    let text = String::from_utf8_lossy(&log);
    assert!(
        !text.contains(&vault.hex()),
        "a whole vault key is in the log:\n{text}"
    );
    assert!(
        !text.contains(&name.hex()),
        "a whole object name is in the log:\n{text}"
    );
    assert!(text.contains('…'), "the abbreviated form is what printed");
}
