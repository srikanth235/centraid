//! THE AUDIT LEDGER REACHES THIS ADAPTER'S STORAGE (#1029 §3; W4b hand-off 1).
//!
//! `centraid-gateway-core`'s `tests/audit_ledger.rs` proves the **rule**: a
//! granted tombstone reaches `StateStore::record_client_delete`, a refused one
//! does not, and it fires for every object kind. What the rule cannot prove is
//! that a given adapter's storage keeps the row, which is the same shape as
//! `compare_and_set_head`'s atomicity — the port names it as the adapter's, and
//! the adapter is where it is checked.
//!
//! So this asks one question of this adapter: after a delete the rules granted,
//! is the row in `client_delete` — the shared schema's table, spelled by
//! `contracts/gateway/queries/client_delete_insert.sql` — and does it carry the
//! object it names?
//!
//! It asks it **once per byte store**. The ledger is state-store business and
//! the byte store has no part in it, which is the claim rather than a reason to
//! skip one: an adapter pointed at a bucket keeps the same audit trail as one
//! pointed at a directory, and a delete path that quietly took a different
//! branch under S3 would be caught here rather than by an owner who found the
//! ledger empty.

mod common;

use centraid_gateway_core::checksum::{AttestedChecksum, ChecksumMode};
use centraid_gateway_core::conformance::Harness as _;
use centraid_gateway_core::engine::{Caller, CommitInput};
use centraid_gateway_core::ids::{Generation, Key32, ObjectKind, ObjectName};
use centraid_gateway_core::lease::LeaseState;
use centraid_gateway_core::plan::Plan;
use centraid_gateway_core::retention::{Policy, Verdict};
use centraid_gateway_core::store::VaultState;
use centraid_gateway_core::time::ServerTime;
use centraid_gateway_core::upload::Declaration;
use common::{ServerHarness, Store, mode_label};

const START: i64 = 400 * 86_400_000;

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

async fn ledger_row_lands(store: Store) {
    let mode = ChecksumMode::Attest;
    let combination = format!("{} × {}", store.label(), mode_label(mode));
    let mut harness = ServerHarness::new(store).await;
    harness
        .reset(mode, Policy::default())
        .await
        .expect("a reset");
    harness
        .register(VaultState {
            vault: vault(),
            account: Key32::from_bytes([0x22; 32]),
            lease: LeaseState::unclaimed(),
            head: None,
            append_only: false,
            plan: Plan::active(1_024 * 1_024 * 1_024),
        })
        .await
        .expect("registration");
    harness
        .gateway()
        .claim_lease(caller(START))
        .await
        .expect("the lease");

    let bytes = b"a blob this server cannot open".to_vec();
    let declaration = Declaration {
        name: ObjectName::of(&bytes),
        checksum: AttestedChecksum::of(&bytes),
        kind: ObjectKind::Blob,
        padded_size: bytes.len() as u64,
    };
    harness
        .gateway()
        .declare(caller(START), core::slice::from_ref(&declaration))
        .await
        .expect("a target");
    harness
        .upload(vault(), declaration.name, bytes, true)
        .await
        .expect("the upload");
    harness
        .gateway()
        .commit(
            caller(START),
            &CommitInput {
                generation: Generation::parse("a1b2c3d4e5f60718293a4b5c6d7e8f90").expect("hex"),
                objects: vec![declaration.name],
                manifest_head: ObjectName::of(b"a head"),
                prev_head: None,
                first_txid: 1,
                last_txid: 2,
            },
        )
        .await
        .expect("the commit");

    let outcomes = harness
        .gateway()
        .delete(caller(START + 1), &[declaration.name], false)
        .await
        .expect("the delete");
    assert!(
        matches!(outcomes[0].verdict, Verdict::Tombstone { .. }),
        "the blob should have been tombstoned under {combination}: {outcomes:?}"
    );

    let dump = harness.state_text().await.expect("a state dump");
    let row = dump
        .lines()
        .find(|line| line.starts_with("client_delete|"))
        .unwrap_or_else(|| {
            panic!("no `client_delete` row after a granted tombstone under {combination}:\n{dump}");
        });
    assert!(
        row.contains(&declaration.name.hex()),
        "the ledger row names some other object under {combination}: {row}"
    );
    assert!(
        row.contains(ObjectKind::Blob.as_str()),
        "the ledger row does not carry the kind under {combination}: {row}"
    );
    assert!(
        row.contains(&(START + 1).to_string()),
        "the ledger row does not carry the gateway's own receipt time under \
         {combination}: {row}"
    );
}

#[tokio::test]
async fn a_granted_tombstone_leaves_a_client_delete_row_over_a_directory() {
    ledger_row_lands(Store::Filesystem).await;
}

#[tokio::test]
async fn a_granted_tombstone_leaves_a_client_delete_row_over_an_s3_store() {
    ledger_row_lands(Store::S3).await;
}
