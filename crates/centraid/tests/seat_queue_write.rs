//! A SEAT CAN QUEUE `media.add_asset` (#1025 S7, D-1025-S7-81).
//!
//! Slice 6's blocker, and the reason the camera roll was complete on the phone
//! and dead one layer below it. With permission granted, the pass running, the
//! bytes staged and the core's own hash in hand, the intent came back
//!
//! ```text
//! no such table: blob_staging
//! ```
//!
//! `Handle::queue_write` runs `predict()` first, which executes the REAL
//! handler against the seat's own replica to build the optimistic overlay.
//! `media.add_asset`'s `pre_staged_or_owned` precondition asked whether the
//! bytes were staged, minted or held — and the STAGED half read `blob_staging`,
//! a declared private table (`contracts/schema/v0-registries.json`) that no
//! replica carries. So the write was refused before it ever reached the outbox.
//!
//! **Why `crates/centraid/tests/bytes_upward.rs` was green anyway**: it writes
//! the `IntentRecord` into the `Outbox` directly, in Rust, past the only door a
//! phone has. No test in the tree sent `Request::Intent` for `media.add_asset`
//! from a seat. This one does.
//!
//! **Why it needs no gateway.** The only thing about a replica that matters to
//! this question is the missing private band, so the fixture founds a vault and
//! takes the band away. That keeps the test deterministic on a host where the
//! QUIC-pairing suites are not (`docs/traps/first-dial-readiness.md`);
//! `bytes_upward.rs` carries the same assertion over a live gateway.

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig};

const A_PHOTOGRAPH: &[u8] =
    include_bytes!("../../../contracts/apps/photos/sample/harbor-lights.png");

/// A founded vault with the gateway's private staging band removed, and the
/// photograph already in this device's own content store — which is where a
/// shell puts it before it queues the write.
async fn a_seat_holding_a_photograph(
    dir: &std::path::Path,
) -> (centraid_core::Handle, String, usize) {
    let path = dir.join("replica.db");
    let store = centraid_blobs::ByteStore::open(dir.join("replica.bytes"))
        .await
        .expect("the byte store opens");

    let founding = Core::open(CoreConfig::gateway(&path)).expect("opens");
    founding
        .with_vault(|vault| Ok(vault.found("Seat", "Owner")?))
        .expect("founds");
    founding.close();
    drop(founding);
    {
        let connection = rusqlite::Connection::open(&path).expect("the file opens");
        assert!(
            centraid_vault::testdoor::drop_the_private_staging_band(&connection),
            "the fixture found no staging band to drop, so it is not the schema \
             difference this test is about"
        );
    }

    let seat = Core::open(CoreConfig::replicated_seat(&path)).expect("the seat core opens");
    let door = centraid_blobs::ContentBytes::new(store, tokio::runtime::Handle::current());
    let hash = {
        use centraid_vault::backup::store::BlobStore as _;
        door.put(A_PHOTOGRAPH).expect("the seat's store takes it")
    };
    seat.attach_bytes(door);
    (seat, hash, A_PHOTOGRAPH.len())
}

fn an_add_asset(intent_id: &str, hash: &str, byte_size: usize) -> wire::Request {
    let input = serde_json::json!({
        "staged_sha": hash,
        "kind": "photo",
        "title": "Taken on the phone",
    });
    wire::Request {
        kind: Some(wire::request::Kind::Intent(wire::Intent {
            intent_id: intent_id.to_owned(),
            app_id: "media".to_owned(),
            action: "add_asset".to_owned(),
            input: serde_json::to_vec(&input).expect("the input encodes"),
            // A SHELL DECLARES NO HASH; the seat computes its own (D-1025-S4-6).
            payload_hash: String::new(),
            needs: vec![wire::NeededBytes {
                hash: hash.to_owned(),
                byte_size: u64::try_from(byte_size).expect("a size"),
                media_type: "image/png".to_owned(),
            }],
            ..Default::default()
        })),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seat_queues_add_asset_for_bytes_its_own_store_holds() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let (seat, hash, byte_size) = a_seat_holding_a_photograph(dir.path()).await;

    let answered = seat
        .call(&an_add_asset("i-photo", &hash, byte_size))
        // The failure this test exists for lands HERE, as
        // `InvalidRequest { detail: "… no such table: blob_staging" }`.
        .expect("the seat queued the write");
    let Some(wire::response::Kind::Outcome(outcome)) = answered.kind else {
        panic!("an intent outcome comes back");
    };
    assert_eq!(
        outcome.status,
        wire::IntentStatus::Queued as i32,
        "the write did not reach the outbox: {outcome:?}"
    );
    // QUEUED AND NEVER EXECUTED, with no commit: this device has no authority
    // over any row and the gateway has not been told.
    assert_eq!(outcome.commit_seq, None);
    assert_eq!(outcome.intent_id, "i-photo");
    seat.close();
}

/// AND THE PREDICTION REALLY RAN — the badge carries a value.
///
/// The cheap way to "fix" this defect would have been to let the refusal fall
/// into `predict`'s "this copy is behind" arm, which queues the write with NO
/// page: the member gets a badge and an empty grid until the gateway answers.
/// The precondition was made role-aware instead, so the seat's own store
/// carries the check and the handler produces a real row image. The assertion
/// is that the photograph is on the screen before any gateway has seen it.
#[tokio::test(flavor = "multi_thread")]
async fn the_queued_photograph_is_on_this_device_before_any_gateway_sees_it() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let (seat, hash, byte_size) = a_seat_holding_a_photograph(dir.path()).await;
    let path = dir.path().join("replica.db");

    assert!(
        {
            let connection = rusqlite::Connection::open(&path).expect("opens");
            centraid_vault::testdoor::the_one_photograph(&connection).is_none()
        },
        "the fixture already held a photograph"
    );

    seat.call(&an_add_asset("i-photo", &hash, byte_size))
        .expect("the seat queued the write");
    seat.close();
    drop(seat);

    let connection = rusqlite::Connection::open(&path).expect("opens");
    assert!(
        centraid_vault::testdoor::the_one_photograph(&connection).is_some(),
        "the write was queued with no page: the member got the badge and not the \
         photograph"
    );
}
