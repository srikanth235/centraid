//! THE DELETE PATH WRITES THE AUDIT LEDGER (#1029 §3; W4b hand-off 1).
//!
//! `contracts/gateway/schema.sql` has carried `client_delete` — the per-object
//! record of "this device asked for this object to go, and the gateway agreed,
//! then" — since W4b added it, and **nothing wrote it**. An owner asked what a
//! device deleted and when had the `object` row until the purge removed it, and
//! nothing afterwards.
//!
//! The decision taken is to write it from the delete path, and *the delete path
//! is in this crate*: [`Gateway::delete`] calls the port for every tombstone it
//! grants. That is the whole point of putting it here rather than in an
//! adapter — a ledger one adapter kept and the other did not would be two
//! deployments answering the same audit question differently.
//!
//! # WHAT THIS FILE PROVES, AND WHAT EACH ADAPTER STILL OWES
//!
//! This proves the **rule**: that a granted tombstone reaches
//! [`StateStore::record_client_delete`], that a refused one does not, and that
//! it fires for every object kind rather than only for the bases the rate limit
//! counts. What it cannot prove is that a particular adapter's storage really
//! keeps the row — that is the adapter's own test, in the same shape as
//! `compare_and_set_head`'s atomicity, which the conformance suite also names
//! as something it cannot reach.

use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use centraid_gateway_core::engine::{Caller, CommitInput, Gateway};
use centraid_gateway_core::ids::{Generation, Key32, ObjectKind, ObjectName};
use centraid_gateway_core::lease::LeaseState;
use centraid_gateway_core::memory::{MemoryBytes, MemoryState};
use centraid_gateway_core::plan::Plan;
use centraid_gateway_core::retention::{Policy, Verdict};
use centraid_gateway_core::store::VaultState;
use centraid_gateway_core::time::ServerTime;
use centraid_gateway_core::upload::Declaration;

/// The in-memory adapter's futures are all immediately ready; one poll is the
/// whole execution. See `tests/conformance.rs`, which says the same.
fn drive<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut context) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("the in-memory adapter pended, which it cannot do"),
    }
}

const DAY: i64 = 86_400_000;
const START: i64 = 400 * DAY;

fn vault() -> Key32 {
    Key32::from_bytes([0x11; 32])
}

fn caller(now: i64) -> Caller {
    Caller {
        vault: vault(),
        device: Key32::from_bytes([1; 32]),
        epoch: 1,
        now: ServerTime::from_millis(now),
    }
}

fn generation() -> Generation {
    Generation::parse("a1b2c3d4e5f60718293a4b5c6d7e8f90").expect("hex")
}

fn founded() -> Gateway<MemoryState, MemoryBytes> {
    let mut gateway = Gateway::new(MemoryState::new(), MemoryBytes::new(), Policy::default());
    gateway.state.register(VaultState {
        vault: vault(),
        account: Key32::from_bytes([0x22; 32]),
        lease: LeaseState::unclaimed(),
        head: None,
        append_only: false,
        plan: Plan::active(1_024 * 1_024 * 1_024),
    });
    drive(gateway.claim_lease(caller(START))).expect("the lease");
    gateway
}

/// Declare, upload and commit one object, and hand back its name.
fn land(
    gateway: &mut Gateway<MemoryState, MemoryBytes>,
    bytes: &[u8],
    kind: ObjectKind,
    head: ObjectName,
    prev_head: Option<ObjectName>,
    now: i64,
) -> ObjectName {
    let declaration = Declaration {
        name: ObjectName::of(bytes),
        kind,
        padded_size: bytes.len() as u64,
    };
    drive(gateway.declare(caller(now), core::slice::from_ref(&declaration))).expect("a target");
    gateway
        .bytes
        .upload(vault(), declaration.name, bytes.to_vec());
    drive(gateway.commit(
        caller(now),
        &CommitInput {
            generation: generation(),
            objects: vec![declaration.name],
            manifest_head: head,
            prev_head,
            first_txid: 1,
            last_txid: 2,
        },
    ))
    .expect("a commit");
    declaration.name
}

/// A GRANTED TOMBSTONE IS RECORDED, OF WHATEVER KIND.
///
/// Not only bases: a base is merely the kind the rate limit counts, and an
/// owner asking what a device deleted is asking about blobs and packs too.
#[test]
fn every_granted_tombstone_lands_in_the_ledger_whatever_its_kind() {
    let mut gateway = founded();
    let blob = land(
        &mut gateway,
        b"a blob nobody here can open",
        ObjectKind::Blob,
        ObjectName::of(b"head one"),
        None,
        START,
    );
    let pack = land(
        &mut gateway,
        b"a pack of thumbnails",
        ObjectKind::Pack,
        ObjectName::of(b"head two"),
        Some(ObjectName::of(b"head one")),
        START + 1,
    );

    let outcomes =
        drive(gateway.delete(caller(START + 2), &[blob, pack], false)).expect("the delete");
    assert!(
        outcomes
            .iter()
            .all(|outcome| matches!(outcome.verdict, Verdict::Tombstone { .. })),
        "both objects should have been tombstoned: {outcomes:?}"
    );

    let mut ledger = gateway.state.client_deletes(&vault());
    ledger.sort_by_key(|(_, kind, _)| kind.as_str());
    assert_eq!(
        ledger,
        vec![
            (blob, ObjectKind::Blob, ServerTime::from_millis(START + 2)),
            (pack, ObjectKind::Pack, ServerTime::from_millis(START + 2)),
        ],
        "the delete path must record every tombstone it grants, of every kind"
    );
}

/// A REFUSED DELETE IS NOT A DELETE, AND THE LEDGER SAYS SO.
///
/// The append-only flag is the cheapest refusal to reach — the server's owner
/// has disabled deletes for devices entirely — and the ledger must stay empty:
/// a ledger that recorded requests rather than acts would tell an owner that
/// objects still in the store were deleted.
#[test]
fn a_refused_delete_writes_no_ledger_row() {
    let mut gateway = founded();
    let blob = land(
        &mut gateway,
        b"a blob on an append-only server",
        ObjectKind::Blob,
        ObjectName::of(b"head one"),
        None,
        START,
    );
    let mut state = drive(gateway.vault(&vault())).expect("the vault");
    state.append_only = true;
    drive(centraid_gateway_core::store::StateStore::put_vault(
        &mut gateway.state,
        &state,
    ))
    .expect("the flag");

    let outcomes = drive(gateway.delete(caller(START + 2), &[blob], false)).expect("the delete");
    assert!(
        matches!(outcomes[0].verdict, Verdict::Refused(_)),
        "an append-only server refuses a device's delete: {outcomes:?}"
    );
    assert!(
        gateway.state.client_deletes(&vault()).is_empty(),
        "the ledger records acts, never requests"
    );
}
