//! THE PROOF THE WHOLE PLANE RESTS ON (#1020, D-1020-B1).
//!
//! One claim, stated as a law in `lane.rs` and asserted here:
//!
//! > Every window of any length makes durable, verified progress, and nothing
//! > is ever redone.
//!
//! A phone does not choose its windows. iOS hands `BGAppRefreshTask` about
//! thirty seconds at a moment of its own choosing; Android defers a periodic
//! worker into whatever Doze decides; either can suspend the process between
//! one packet and the next. So the test does not transfer a blob — it transfers
//! a blob *in a stream of short windows that are cut where they fall*, which is
//! the only access pattern the product will ever actually see.
//!
//! ## THE CUT IS BY PROGRESS, NOT BY THE WALL CLOCK (#1025 S2)
//!
//! This test used to cut every window after 120 ms. It passed alone every time
//! and failed under parallel load — `window 1 was cut and left no verified
//! chunks` — because on a machine running four other test binaries, 120 ms is
//! not reliably enough to verify one 16 KiB chunk group. The assertion was
//! right and the schedule was the flake.
//!
//! So a window is cut when it has landed [`WINDOW_BYTES`] of VERIFIED progress,
//! whatever that took. That is stricter rather than looser: the number of
//! windows is now fixed by the blob size instead of by how fast the machine is,
//! every window is still cut mid-stream, and every assertion below is
//! unchanged. A cut that fires on observed progress cannot fire before any
//! progress exists, which is precisely the failure that was being reported.
//!
//! ## Why the cut is a dropped future and not a closed socket
//!
//! Dropping the fetch future is what suspension looks like from inside the
//! process: the task simply stops between awaits. It is also the harder case —
//! a closed socket gives the store an ordered shutdown, a dropped future gives
//! it nothing — so a store that survives this survives the other.
//!
//! ## What it actually does, and the falsification that proves it means
//! something
//!
//! A 24 MiB blob over 120 ms windows takes five windows on this machine: four
//! are cut mid-stream and the fifth opens holding 23,543,808 verified bytes and
//! moves the remaining 1,622,016. Replace `LocalInfo::missing()` in
//! [`centraid_blobs::fetch`] with a request for the whole blob — the
//! restart-from-zero implementation this plane exists to avoid — and the same
//! test runs four hundred windows without ever finishing, which is the phone
//! failure reproduced in a unit test.
//!
//! ## The bound, and why it is not "moved == size"
//!
//! A window cut partway through a 16 KiB chunk group discards that group's
//! bytes, because they were never verified and an unverified byte is not a byte
//! this device may keep. So the honest bound is `size + one chunk group per
//! window`, and the test asserts exactly that rather than a round number. A
//! restart-from-zero implementation would need `size` per window and fails it
//! by orders of magnitude; an implementation that kept unverified bytes would
//! pass the byte count and fail the content comparison at the end.

use std::time::Duration;

use centraid_blobs::{ByteStore, ContentHash, Holding};
use centraid_net::{Device, Endpoint, EndpointConfig, MemoryAllowlist, RawRecv, RawSend};
use centraid_protocol::Connection as _;
use centraid_protocol::alpn;

/// Read the one tagging frame and hand the rest of the stream to the provider.
///
/// The production gateway does this in `centraid/src/seat_lane.rs` beside its
/// other request kinds; a test that only ever serves blobs does the same two
/// steps with nothing else in the match.
async fn serve_one_blob_stream(
    store: &ByteStore,
    connection_id: u64,
    send: RawSend,
    mut recv: RawRecv,
) {
    use centraid_api_proto::core_v1 as core;
    let Ok(Some(envelope)) = centraid_protocol::wire::read_envelope(&mut recv).await else {
        return;
    };
    let Some(core::envelope::Body::Request(core::Request {
        kind: Some(core::request::Kind::Blob(_)),
    })) = envelope.body
    else {
        return;
    };
    centraid_blobs::serve_stream(store, connection_id, send, recv).await;
}

/// 24 MiB — 1536 chunk groups. Large enough that no single short window
/// finishes it over loopback, small enough to stay a unit test.
const BLOB_BYTES: usize = 24 * 1024 * 1024;
/// The bao chunk group. A cut window can waste at most this much.
const CHUNK_GROUP: u64 = 16 * 1024;
/// How much verified progress one window is allowed to make before it is cut.
///
/// A divisor of nothing in particular: 4 MiB over a 24 MiB blob is six windows,
/// which is enough interruptions to prove resumption and few enough to stay a
/// unit test.
const WINDOW_BYTES: u64 = 4 * 1024 * 1024;
/// The backstop, so a window that makes NO progress at all cannot hang the
/// test. It is not the cut — [`WINDOW_BYTES`] is — and a run in which this is
/// what fires is a run that found a real stall.
const WINDOW_CEILING: Duration = Duration::from_secs(60);
const MAX_WINDOWS: usize = 400;

/// Deterministic, incompressible-ish, and different in every chunk group — so a
/// store that mixed two groups up produces a different file rather than an
/// identical one.
fn a_large_photograph() -> Vec<u8> {
    let mut bytes = Vec::with_capacity(BLOB_BYTES);
    let mut state: u64 = 0x2545_F491_4F6C_DD1D;
    while bytes.len() < BLOB_BYTES {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        bytes.extend_from_slice(&state.to_le_bytes());
    }
    bytes.truncate(BLOB_BYTES);
    bytes
}

fn device(endpoint_id: [u8; 32]) -> Device {
    Device {
        endpoint_id,
        device_id: "device-under-test".to_owned(),
        label: "a phone".to_owned(),
        platform: "ios".to_owned(),
        enrolled_at_ms: 1,
        revoked_at_ms: None,
    }
}

/// The gateway: a store, an endpoint, and an accept loop that serves the byte
/// lane to whatever the allowlist admits.
async fn gateway(
    store: ByteStore,
    allowlist: MemoryAllowlist,
) -> (Endpoint, Vec<String>, tokio::task::JoinHandle<()>) {
    let endpoint = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("the gateway endpoint binds");
    let addr = endpoint.addr().await.expect("the gateway has an address");
    let hints: Vec<String> = addr.ip_addrs().map(|socket| socket.to_string()).collect();

    let serving = endpoint.clone();
    let task = tokio::spawn(async move {
        loop {
            match serving.accept(&allowlist).await {
                // PROMOTED ONLY (#1025 S3, D-1025-S3-4). `accept` no longer
                // closes an unenrolled peer — it marks the connection
                // PROVISIONAL so a device redeeming a pairing code has
                // somewhere to knock — so a lane that serves blobs must ask.
                // This toy gateway asks in the one line the real one does, and
                // `an_unenrolled_peer_cannot_fetch_a_blob_it_knows_the_hash_of`
                // is what fails if the line goes.
                Ok(Some(accepted)) if accepted.alpn == alpn::PLANE && accepted.is_promoted() => {
                    let store = store.clone();
                    // ONE TASK PER CONNECTION, AND ONE PER STREAM INSIDE IT
                    // (#1025 S2). There is no byte lane: a blob rides a stream
                    // of the one plane whose first frame says `blob`, and this
                    // loop is the same shape the gateway's own is.
                    tokio::spawn(async move {
                        let connection_id = accepted.connection.iroh().stable_id() as u64;
                        loop {
                            let Ok((send, recv)): centraid_protocol::Result<(RawSend, RawRecv)> =
                                accepted.connection.accept_bi().await
                            else {
                                break;
                            };
                            let store = store.clone();
                            tokio::spawn(async move {
                                serve_one_blob_stream(&store, connection_id, send, recv).await;
                            });
                        }
                        // The connection must outlive the transfer: a dropped
                        // iroh connection sends CONNECTION_CLOSE at once and
                        // QUIC discards stream data the peer has not read.
                        drop(accepted);
                    });
                }
                Ok(Some(_)) => {}
                Ok(None) => return,
                // An unauthorised peer. The loop keeps serving: refusing one
                // dialler is not a reason to stop admitting the others.
                Err(_) => {}
            }
        }
    });
    (endpoint, hints, task)
}

/// The law, asserted over a stream of windows that are cut where they fall.
#[tokio::test(flavor = "multi_thread")]
async fn a_blob_crosses_in_many_short_windows_and_no_byte_is_moved_twice() {
    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");

    let photograph = a_large_photograph();
    let gateway_store = ByteStore::open(gateway_dir.path().join("blobs"))
        .await
        .expect("the gateway store opens");
    let hash = gateway_store
        .add_bytes(photograph.clone())
        .await
        .expect("the gateway takes the photograph");
    assert_eq!(hash, ContentHash::of(&photograph), "the name is the bytes");

    let seat_store = ByteStore::open(seat_dir.path().join("blobs"))
        .await
        .expect("the seat store opens");
    let seat = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("the seat endpoint binds");

    let allowlist = MemoryAllowlist::new();
    allowlist.enroll_without_a_ticket(device(seat.id()));
    let (gateway_endpoint, hints, accepting) = gateway(gateway_store.clone(), allowlist).await;

    let mut windows = 0usize;
    let mut total_moved = 0u64;
    let mut held_at_end_of_last_window = 0u64;

    while windows < MAX_WINDOWS {
        windows += 1;
        let connection = seat
            .connect(gateway_endpoint.id(), None, &hints, alpn::PLANE)
            .await
            .expect("the seat dials the one plane");

        // THE CUT, BY OBSERVED PROGRESS. The fetch races a watcher that polls
        // what the store actually holds; whichever finishes first ends the
        // window, and the watcher only finishes once `WINDOW_BYTES` of VERIFIED
        // bytes have landed since this window opened. Dropping the fetch future
        // is still what the cut IS — the task simply stops between awaits,
        // which is what suspension looks like from inside the process.
        let watcher = {
            let seat_store = seat_store.clone();
            let floor = held_at_end_of_last_window + WINDOW_BYTES;
            async move {
                loop {
                    if seat_store
                        .holding(hash)
                        .await
                        .map_or(0, |holding| holding.held_bytes())
                        >= floor
                    {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            }
        };
        let report = tokio::time::timeout(WINDOW_CEILING, async {
            tokio::select! {
                fetched = centraid_blobs::fetch(&seat_store, connection.iroh(), hash) => Some(fetched),
                () = watcher => None,
            }
        })
        .await
        .expect("a window made no progress at all within the ceiling");
        // `None` is the cut; `Some` is a fetch that finished first. Shaped as
        // the old `timeout` result so the assertions below read unchanged.
        let report = report.ok_or(());

        // THE CUT. A timeout drops the fetch future mid-stream, which is what
        // the OS suspending this process looks like from in here. Nothing is
        // told about it — not the store, not the peer.
        let Ok(report) = report else {
            drop(connection);
            let holding = seat_store.holding(hash).await.expect("the seat can answer");
            // DURABLE PROGRESS. The cut window still left verified chunks
            // behind, and the store reports them as partial rather than as
            // nothing.
            assert!(
                matches!(holding, Holding::Partial { .. } | Holding::Complete { .. }),
                "window {windows} was cut and left no verified chunks: {holding:?}"
            );
            assert!(
                holding.held_bytes() >= held_at_end_of_last_window,
                "window {windows} went BACKWARDS: {} then {}",
                held_at_end_of_last_window,
                holding.held_bytes()
            );
            held_at_end_of_last_window = holding.held_bytes();
            continue;
        };

        let report = report.expect("a window either lands bytes or is cut; it does not fail");
        // NOTHING IS REDONE. The window began from what the last one left.
        assert_eq!(
            report.held_before,
            held_at_end_of_last_window,
            "window {windows} did not start from what window {} left",
            windows - 1
        );
        total_moved += report.moved;
        held_at_end_of_last_window = report.held_before + report.moved;
        drop(connection);
        if report.complete {
            break;
        }
    }

    assert!(
        seat_store
            .is_complete(hash)
            .await
            .expect("the seat answers"),
        "{windows} windows of {WINDOW_BYTES} bytes did not finish {BLOB_BYTES} bytes"
    );

    // THE INTERRUPTION REALLY HAPPENED. Without this the test could pass on a
    // machine fast enough to finish in one window, and would then be asserting
    // nothing about resumption at all.
    assert!(
        windows >= 2,
        "one window finished the whole blob; the test proved nothing about resumption"
    );

    // THE BOUND. A restart-from-zero implementation moves `BLOB_BYTES` per
    // window and misses this by orders of magnitude.
    let allowed = BLOB_BYTES as u64 + windows as u64 * CHUNK_GROUP;
    assert!(
        total_moved <= allowed,
        "{total_moved} bytes crossed for a {BLOB_BYTES}-byte blob over {windows} windows \
         (at most {allowed} is explainable by cut chunk groups)"
    );

    // AND THE BYTES ARE THE BYTES. The byte count above would also be satisfied
    // by a store that kept unverified fragments; this is what says it did not.
    let out = seat_dir.path().join("recovered.bin");
    seat_store
        .export(hash, &out)
        .await
        .expect("the seat exports");
    let recovered = std::fs::read(&out).expect("the exported file reads");
    assert_eq!(recovered.len(), photograph.len());
    assert!(recovered == photograph, "the recovered photograph differs");
    assert_eq!(
        ContentHash::of(&recovered),
        hash,
        "the recovered bytes do not hash to the name they were fetched under"
    );

    gateway_endpoint.close().await;
    seat.close().await;
    accepting.abort();
}

/// The security claim that survived the byte lane's deletion (#1025 S2) and the
/// pair lane's (#1025 S3): **knowing a hash is not permission to fetch it.**
///
/// `Endpoint::accept` decides once, before a stream is accepted, whether this
/// peer is an enrolled device — and since D-1025-S3-4 the answer is a STATE
/// rather than a close, because a device redeeming a pairing code is
/// unenrolled by definition and needs somewhere to knock. A PROVISIONAL
/// connection may carry a `pair` stream and nothing else, so the stranger here
/// never gets to open one and say `blob`.
///
/// The thing that would break this is a lane that serves on `accepted` without
/// reading `is_promoted`. That is one line, and this test is what makes its
/// absence loud.
#[tokio::test(flavor = "multi_thread")]
async fn an_unenrolled_peer_cannot_fetch_a_blob_it_knows_the_hash_of() {
    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let stranger_dir = tempfile::tempdir().expect("a temp dir");

    let gateway_store = ByteStore::open(gateway_dir.path().join("blobs"))
        .await
        .expect("the gateway store opens");
    let hash = gateway_store
        .add_bytes(b"a private photograph".to_vec())
        .await
        .expect("the gateway takes it");

    let stranger_store = ByteStore::open(stranger_dir.path().join("blobs"))
        .await
        .expect("the store opens");
    let stranger = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("the endpoint binds");

    // AN EMPTY ALLOWLIST. The stranger's endpoint id is perfectly valid and
    // simply not enrolled, which is the state every device in the world is in.
    let (gateway_endpoint, hints, accepting) =
        gateway(gateway_store.clone(), MemoryAllowlist::new()).await;

    let dialled = stranger
        .connect(gateway_endpoint.id(), None, &hints, alpn::PLANE)
        .await;

    // The refusal may surface at the dial or at the first request, depending on
    // when the close lands — QUIC lets the handshake complete before the
    // application closes the connection. Either is a refusal; what must never
    // happen is bytes.
    if let Ok(connection) = dialled {
        let fetched = tokio::time::timeout(
            Duration::from_secs(5),
            centraid_blobs::fetch(&stranger_store, connection.iroh(), hash),
        )
        .await;
        assert!(
            !matches!(fetched, Ok(Ok(report)) if report.complete),
            "an unenrolled peer fetched a blob by knowing its hash"
        );
    }
    assert_eq!(
        stranger_store
            .holding(hash)
            .await
            .expect("the store answers"),
        Holding::Missing,
        "an unenrolled peer got bytes"
    );

    gateway_endpoint.close().await;
    stranger.close().await;
    accepting.abort();
}
