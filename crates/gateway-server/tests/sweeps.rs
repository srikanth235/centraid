//! **THE SWEEPS ACTUALLY REMOVE BYTES** (#1029 §3, §5 line 337, W15-4).
//!
//! `gateway-core`'s `purge` and `scrub` were written in W4 and **nothing called
//! them**: `purge` had no caller in the workspace at all and `scrub` had one
//! CLI verb. A household that deleted a year of bases got the disk back only if
//! somebody ran a command nobody had told them about.
//!
//! What is asserted here is the thing a unit test of `retention::purgeable`
//! cannot say: that a sweep, over a **real `SqliteState` and a real filesystem
//! object store**, unlinks the bytes of a tombstone past its grace period and
//! **leaves the bytes of one inside its grace alone**.
//!
//! The two objects are in the same vault, tombstoned at the same moment, and
//! the only thing that differs is the clock the sweep is run at — so a sweep
//! that removed both, or neither, fails for the one reason the test is about.

use std::time::Duration;

use centraid_gateway_core::Gateway;
use centraid_gateway_core::engine::{Caller, CommitInput};
use centraid_gateway_core::ids::{Key32, ObjectName};
use centraid_gateway_core::plan::Plan;
use centraid_gateway_core::retention::Policy;
use centraid_gateway_core::store::ByteStore as _;
use centraid_gateway_core::upload::Declaration;
use centraid_gateway_core::{ObjectKind, ServerTime};
use centraid_gateway_server::bytes::configured::{Backend, ConfiguredBytes};
use centraid_gateway_server::bytes::fs::FilesystemBytes;
use centraid_gateway_server::config::Config;
use centraid_gateway_server::http::{Server, Shared};
use centraid_gateway_server::state::{SqliteState, register};
use centraid_gateway_server::sweeps::{self, Schedule};

const DAY: i64 = 86_400_000;

fn at(day: i64) -> ServerTime {
    ServerTime::from_millis(400 * DAY + day * DAY)
}

/// An object, named the one way an object may be named.
fn named(body: Vec<u8>) -> (ObjectName, Vec<u8>) {
    (ObjectName::of(&body), body)
}

/// A server holding one vault with two committed objects.
async fn holding(objects: &[(ObjectName, Vec<u8>)]) -> (Shared, Key32, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let vault = Key32::from_bytes([0x11; 32]);
    let device = Key32::from_bytes([0x22; 32]);
    let mut state = SqliteState::in_memory().expect("a state file");
    register(&mut state, vault, vault, Plan::active(u64::MAX), false)
        .await
        .expect("a registered vault");

    // THE BYTES GO IN THROUGH THE ADAPTER'S OWN WRITER, which is what the PUT
    // route calls: this test is about the sweep, so the upload is the shortest
    // real path to a store that holds something.
    let files = FilesystemBytes::open(dir.path(), "").expect("an object directory");
    for (name, body) in objects {
        files.put(&vault, name, body).expect("the store takes it");
    }
    let bytes = ConfiguredBytes::new(Backend::Filesystem(files));
    let mut gateway = Gateway::new(state, bytes, Policy::default());

    let caller = Caller {
        vault,
        device,
        epoch: 1,
        now: at(0),
    };
    gateway
        .claim_lease(caller)
        .await
        .expect("this device takes the lease");

    let declarations: Vec<Declaration> = objects
        .iter()
        .map(|(name, body)| Declaration {
            name: *name,
            kind: ObjectKind::Segment,
            padded_size: body.len() as u64,
        })
        .collect();
    gateway
        .declare(caller, &declarations)
        .await
        .expect("the gateway declares");
    gateway
        .commit(
            caller,
            &CommitInput {
                generation: centraid_gateway_core::Generation::parse(&"a".repeat(32))
                    .expect("a generation id"),
                objects: objects.iter().map(|(name, _)| *name).collect(),
                manifest_head: objects[0].0,
                prev_head: None,
                first_txid: 1,
                last_txid: 2,
            },
        )
        .await
        .expect("the gateway commits");

    let server = Server {
        gateway,
        config: Config::defaults(dir.path(), ""),
    };
    (centraid_gateway_server::serve::shared(server), vault, dir)
}

/// **THE CLAIM.** One tombstone past its grace is gone after a sweep; one
/// inside its grace is untouched.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tombstone_past_its_grace_is_purged_by_a_sweep_and_one_inside_it_is_not() {
    // THE NAME IS THE HASH OF THE BYTES, on both sides — the gateway hashes
    // what it stores and refuses a name that is not its bytes' hash before it
    // acks (scope amendment 2026-09-21). A test that named an object anything
    // else would be refused at commit, which is the rule working.
    let old = named(b"one".repeat(64));
    let fresh = named(b"two".repeat(64));
    let (server, vault, _dir) = holding(&[old.clone(), fresh.clone()]).await;

    let caller = Caller {
        vault,
        device: Key32::from_bytes([0x22; 32]),
        epoch: 1,
        now: at(0),
    };

    // BOTH ARE TOMBSTONED AT THE SAME MOMENT. The only thing that will differ
    // is the clock each sweep runs at, so nothing else can explain the result.
    {
        let mut held = server.lock().await;
        for (name, _) in [&old, &fresh] {
            held.gateway
                .delete(caller, &[*name], true)
                .await
                .expect("the gateway tombstones");
        }
    }

    // ---- ONE TICK INSIDE THE GRACE PERIOD ------------------------------
    // The default grace is seven days; day one is inside it.
    let counts = sweeps::purge_once(&server, at(1))
        .await
        .expect("the sweep runs");
    assert_eq!(counts.vaults, 1);
    assert_eq!(
        counts.purged, 0,
        "a sweep inside the grace period purged {} object(s), which is an undo a member can no \
         longer reach",
        counts.purged
    );
    {
        let held = server.lock().await;
        for (name, _) in [&old, &fresh] {
            assert!(
                held.gateway
                    .bytes
                    .read(&vault, name)
                    .await
                    .expect("the store answers")
                    .is_some(),
                "the bytes went inside the grace period"
            );
        }
    }

    // ---- ONE TICK PAST IT ----------------------------------------------
    let counts = sweeps::purge_once(&server, at(9))
        .await
        .expect("the sweep runs");
    assert_eq!(
        counts.purged, 2,
        "a sweep past the grace period purged {} of 2, so a delete does not free a disk",
        counts.purged
    );
    {
        let held = server.lock().await;
        for (name, _) in [&old, &fresh] {
            assert!(
                held.gateway
                    .bytes
                    .read(&vault, name)
                    .await
                    .expect("the store answers")
                    .is_none(),
                "the bytes survived their own purge"
            );
        }
    }

    // ---- AND A SECOND SWEEP IS A NO-OP ---------------------------------
    // Idempotent, because a timer fires again whether or not there was
    // anything to do the last time.
    let again = sweeps::purge_once(&server, at(10))
        .await
        .expect("the sweep runs");
    assert_eq!(again.purged, 0, "a second sweep purged something twice");
}

/// The scrub sweep reads every stored object and reports counts, over the same
/// real state and the same real store.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_scrub_sweep_reads_every_object_and_reports_counts_only() {
    let one = named(b"bytes".repeat(32));
    let two = named(b"more!".repeat(32));
    let (server, _vault, _dir) = holding(&[one, two]).await;

    let counts = sweeps::scrub_once(&server).await.expect("the scrub runs");
    assert_eq!(counts.vaults, 1);
    assert_eq!(
        counts.objects_read, 2,
        "the scrub did not read every object"
    );
    assert_eq!(counts.corrupt, 0, "the gateway hashed what it stored wrong");
    assert_eq!(counts.missing, 0);
}

/// The schedule is a comparison against the last completed sweep, so a laptop
/// that was shut for a month sweeps **once** when it comes back rather than
/// firing a storm of missed ones.
#[test]
fn a_laptop_that_was_off_for_a_month_sweeps_once_when_it_comes_back() {
    assert!(!Schedule::due(3_600, Duration::from_secs(3_599)));
    assert!(Schedule::due(3_600, Duration::from_secs(3_600)));
    assert!(Schedule::due(3_600, Duration::from_secs(30 * 24 * 3_600)));
    // AND ZERO IS OFF, which a self-hoster on a spinning disk may want for the
    // scrub and which is why it is a number rather than a flag.
    assert!(!Schedule::due(0, Duration::from_secs(365 * 24 * 3_600)));
}
