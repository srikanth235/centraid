//! A TAILING SEAT IS SERVED A PAGE IT DID NOT ASK FOR (#1025 S2, D-1025-S7-40).
//!
//! The gateway half of the one mechanism. `tests/seat_lane.rs` proves the
//! one-shot door — a page, a cursor, a refusal by name — against the shipped
//! binary over real QUIC; this file proves the other half of the same door:
//! `LogRequest.tail` serves the catch-up pages exactly as the one-shot door
//! does and then KEEPS THE STREAM OPEN, writing a further `LogPage` every time
//! the vault's watermark moves.
//!
//! It drives the wire by hand, deliberately. What is under test is what a
//! GATEWAY does, and a test that drove `centraid_seat_link` would be proving
//! the two halves against each other — so a seat that stopped tailing and a
//! gateway that stopped serving one would both read green.
//!
//! Three claims, and each of them is a thing that went wrong somewhere in v0's
//! push story:
//!
//! 1. **catch-up then live, on ONE stream** — no second request between them,
//!    which is what makes "current within one round trip" true rather than a
//!    polling interval with a short name;
//! 2. **a second tail from the same device replaces the first** — otherwise a
//!    phone that relaunched leaves the gateway writing pages into a socket
//!    nobody will ever read;
//! 3. **`RebootstrapRequired` ends the stream** — a tail is the same answer
//!    more than once, and that answer is the last one.

use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use centraid_api_proto::core_v1::{self as core, envelope, pair_response, request, response};
use centraid_net::endpoint::{Endpoint, EndpointConfig};
use centraid_net::{pairing, ticket};
use centraid_protocol::Connection as _;
use centraid_protocol::alpn;
use centraid_protocol::version::local_hello;
use centraid_protocol::wire::{read_envelope, write_envelope};
use tokio::io::AsyncWriteExt as _;

const READY_LINE: &str = "centraid gateway ready";

/// See `tests/seat_lane.rs`: a freshly bound endpoint enumerates its addresses
/// in the background, and a dial issued in the middle of that pays for it
/// (`docs/traps/first-dial-readiness.md`).
async fn warm(endpoint: &Endpoint) {
    for _ in 0..30 {
        if endpoint
            .addr()
            .await
            .is_some_and(|addr| addr.ip_addrs().next().is_some())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
}

struct Gateway(Child);

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start(data_dir: &std::path::Path) -> Option<(Gateway, String)> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_centraid"))
        .arg("gateway")
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--print-qr")
        .arg("--no-relay")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the gateway binary runs");
    let stdout = child.stdout.take().expect("piped");
    let (tx, rx) = mpsc::channel();
    // THE WHOLE OF STDOUT IS DRAINED FOR THE RUN. A reader that stopped at the
    // ticket closes the pipe under the gateway's next `println!`, and a failed
    // write to stdout panics its main thread — see `tests/seat_lane.rs`.
    std::thread::spawn(move || {
        let mut ready = false;
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.starts_with(READY_LINE) {
                ready = true;
            }
            if let Some(encoded) = line.strip_prefix("ticket ")
                && ready
                && !sent
            {
                sent = true;
                let _ = tx.send(encoded.trim().to_owned());
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(encoded) => Some((Gateway(child), encoded)),
        Err(_) => None,
    }
}

/// A paired, handshaked connection to a running gateway.
async fn paired(
    data_dir: &std::path::Path,
) -> Option<(Gateway, Endpoint, centraid_net::IrohConnection)> {
    let (gateway, encoded) = start(data_dir)?;
    let scanned = ticket::decode(&encoded).expect("the printed ticket decodes");
    let seat = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("the seat binds");
    warm(&seat).await;
    let (_promoted, answer) = pairing::redeem(&seat, &scanned, "Tail Seat", "linux")
        .await
        .expect("the gateway answered the pair stream");
    match answer.result.expect("a result") {
        pair_response::Result::Ok(ok) => ok,
        pair_response::Result::Error(error) => panic!("the ticket was refused: {error:?}"),
    };
    let gateway_endpoint: [u8; 32] = scanned
        .gateway_endpoint
        .as_slice()
        .try_into()
        .expect("a ticket names a 32-byte endpoint");
    let connection = seat
        .connect(gateway_endpoint, None, &scanned.direct_addrs, alpn::PLANE)
        .await
        .expect("the one plane admits the device it just enrolled");
    handshake(&connection).await;
    Some((gateway, seat, connection))
}

/// The version window, on the connection's first stream. The gateway accepts no
/// request stream before it.
async fn handshake(connection: &centraid_net::IrohConnection) {
    let (mut send, mut recv) = connection.open_bi().await.expect("the stream opens");
    centraid_protocol::handshake::dial(
        &mut send,
        &mut recv,
        &local_hello("1.0.0-test", &["replica"]),
    )
    .await
    .expect("the version window admits this seat");
    send.flush().await.expect("flush");
    let _ = send.finish();
}

/// Open a TAIL and read its first answer. The stream is returned, because every
/// page after the first comes off it with no further request.
async fn open_tail(
    connection: &centraid_net::IrohConnection,
    since: Option<core::LogCursor>,
) -> (centraid_net::RawRecv, core::Envelope) {
    let (mut send, mut recv) = connection.open_bi().await.expect("a tail stream opens");
    let asked = centraid_protocol::wire::request(
        1,
        core::Request {
            kind: Some(request::Kind::Log(core::LogRequest {
                since,
                limit: 1_000,
                tail: true,
            })),
        },
    );
    write_envelope(&mut send, &asked).await.expect("write");
    send.flush().await.expect("flush");
    // FINISHED, NOT DROPPED. A tail sends exactly one request and has nothing
    // more to say; the gateway reads to the end of the stream rather than
    // guessing from a length.
    let _ = send.finish();
    let first = read_envelope(&mut recv)
        .await
        .expect("the gateway answered the tail")
        .expect("an answer, not a closed stream");
    (recv, first)
}

fn page(envelope: core::Envelope) -> core::LogPage {
    match envelope.body {
        Some(envelope::Body::Response(core::Response {
            kind: Some(response::Kind::Log(page)),
        })) => page,
        other => panic!("expected a LogPage, got {other:?}"),
    }
}

/// Read pages off an open tail until one says it is the end.
async fn drain_catch_up(recv: &mut centraid_net::RawRecv, first: core::LogPage) -> core::LogPage {
    let mut page_read = first;
    while page_read.has_more {
        let envelope = read_envelope(recv)
            .await
            .expect("the tail kept answering")
            .expect("a page, not a closed stream");
        page_read = page(envelope);
    }
    page_read
}

/// COMMIT A ROW ON THE GATEWAY, over the same connection, as a member would.
///
/// An `intent` stream and not a direct write to the file: the gateway is the
/// only writer, and a test that reached around it would be proving the tail
/// against a watermark nothing in the product moves.
async fn commit_a_row(connection: &centraid_net::IrohConnection, name: &str) {
    let input = serde_json::json!({ "display_name": name });
    // THE HASH IS THE SEAT'S, and here the test is the seat (#1025 S4). A shell
    // leaves it empty and its own core computes it; the GATEWAY refuses an
    // intent whose claim does not rehash, because running one would execute
    // something nobody signed for. So the preimage is built the same way
    // `centraid_core::intent::payload_of` builds it.
    let claim = centraid_vault::intents::IntentPayload {
        app_id: "core".to_owned(),
        action: "add_party".to_owned(),
        input: input.clone(),
        base_versions: Vec::new(),
        depends_on: Vec::new(),
        needs: Vec::new(),
    };
    let payload_hash = claim.hash().expect("the claim hashes");
    let (mut send, mut recv) = connection.open_bi().await.expect("an intent stream opens");
    let asked = centraid_protocol::wire::request(
        1,
        core::Request {
            kind: Some(request::Kind::Intent(core::Intent {
                intent_id: format!("i-{name}"),
                app_id: "core".to_owned(),
                action: "add_party".to_owned(),
                input: centraid_vault::intents::canonical_json(&input)
                    .expect("canonical JSON")
                    .into_bytes(),
                payload_hash,
                ..Default::default()
            })),
        },
    );
    write_envelope(&mut send, &asked).await.expect("write");
    send.flush().await.expect("flush");
    let _ = send.finish();
    let answered = read_envelope(&mut recv)
        .await
        .expect("the gateway answered the intent")
        .expect("an answer");
    match answered.body {
        Some(envelope::Body::Response(core::Response {
            kind: Some(response::Kind::Outcome(outcome)),
        })) => assert_eq!(
            outcome.status,
            core::IntentStatus::Executed as i32,
            "the gateway ran the write: {outcome:?}"
        ),
        other => panic!("expected an outcome, got {other:?}"),
    }
}

/// THE CLAIM: catch up on one stream, then be handed the next commit WITHOUT
/// asking for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_tailing_seat_is_served_a_page_after_a_commit() {
    let data_dir = tempfile::tempdir().expect("a temp dir");
    let Some((_gateway, _seat, connection)) = paired(data_dir.path()).await else {
        panic!("the gateway printed no ticket within 30s");
    };

    // 1. THE CATCH-UP, on the tail's own stream. `since: None` is "from the
    //    floor", which for a vault founded moments ago is its whole history —
    //    and it arrives exactly as the one-shot door serves it.
    let (mut recv, first) = open_tail(&connection, None).await;
    let first = page(first);
    assert!(
        !first.rows.is_empty(),
        "a founded vault has a vault row and an owner party; the tail served an empty log"
    );
    let caught_up = drain_catch_up(&mut recv, first).await;
    assert!(!caught_up.has_more, "the catch-up ended");
    let cursor = caught_up.next;

    // 2. A COMMIT, AND NOTHING ELSE. No second `LogRequest`, no poll, no timer.
    commit_a_row(&connection, "Tailed Into Being").await;

    // 3. THE PAGE ARRIVES ON THE STREAM THAT WAS ALREADY OPEN.
    let live = tokio::time::timeout(Duration::from_secs(10), read_envelope(&mut recv))
        .await
        .expect("a tailing seat was served within ten seconds of the commit")
        .expect("the tail is readable")
        .expect("a page, not a closed stream");
    let live = page(live);
    assert!(
        !live.rows.is_empty(),
        "the gateway woke the tail and wrote a page with nothing in it"
    );
    assert!(
        live.next > cursor,
        "the live page moved the cursor: {} -> {}",
        cursor,
        live.next
    );
    assert!(
        live.rows.iter().any(|row| row.table == "core_party"),
        "the committed row is in the page: {:?}",
        live.rows.iter().map(|row| &row.table).collect::<Vec<_>>()
    );
}

/// A SECOND TAIL FROM THE SAME DEVICE REPLACES THE FIRST.
///
/// What a relaunched phone does. The first stream is left on a gateway that
/// will never be read from again, so it is closed — and the second is the one
/// that gets the next commit.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_tail_replaces_the_first() {
    let data_dir = tempfile::tempdir().expect("a temp dir");
    let Some((_gateway, _seat, connection)) = paired(data_dir.path()).await else {
        panic!("the gateway printed no ticket within 30s");
    };

    let (mut first_recv, first) = open_tail(&connection, None).await;
    let caught_up = drain_catch_up(&mut first_recv, page(first)).await;
    let cursor = core::LogCursor {
        epoch: caught_up.epoch.clone(),
        seq: caught_up.next,
    };

    // THE SECOND, on the cursor the first reached. Same device, same
    // connection: the gateway tells them apart by nothing, because there is
    // nothing to tell apart — one device holds one tail.
    let (mut second_recv, second) = open_tail(&connection, Some(cursor)).await;
    let _ = drain_catch_up(&mut second_recv, page(second)).await;

    // THE FIRST IS CLOSED. `read_envelope` answers `Ok(None)` on a stream the
    // writer finished — which is what a replaced tail is, and not an error.
    let ended = tokio::time::timeout(Duration::from_secs(10), read_envelope(&mut first_recv))
        .await
        .expect("the replaced tail ended within ten seconds");
    assert!(
        matches!(ended, Ok(None) | Err(_)),
        "the first tail was still open after the second replaced it"
    );

    // AND THE SECOND IS THE ONE THAT GETS THE COMMIT.
    commit_a_row(&connection, "Served To The Second").await;
    let live = tokio::time::timeout(Duration::from_secs(10), read_envelope(&mut second_recv))
        .await
        .expect("the second tail was served")
        .expect("readable")
        .expect("a page");
    assert!(!page(live).rows.is_empty(), "the second tail got the page");
}

/// `RebootstrapRequired` ENDS THE STREAM, exactly as it ends a one-shot request.
///
/// A cursor of another epoch is the cheapest way to be under the floor from the
/// first read, and it is a real state: it is what a seat holding a copy of a
/// vault that was restored from backup asks with.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rebootstrap_ends_the_tail() {
    let data_dir = tempfile::tempdir().expect("a temp dir");
    let Some((_gateway, _seat, connection)) = paired(data_dir.path()).await else {
        panic!("the gateway printed no ticket within 30s");
    };

    let (mut recv, first) = open_tail(
        &connection,
        Some(core::LogCursor {
            epoch: "an-epoch-this-vault-never-had".to_owned(),
            seq: 1,
        }),
    )
    .await;
    match first.body {
        Some(envelope::Body::Response(core::Response {
            kind: Some(response::Kind::RebootstrapRequired(required)),
        })) => {
            assert_ne!(
                required.reason,
                core::RebootstrapReason::Unspecified as i32,
                "a re-bootstrap says which kind"
            );
        }
        other => panic!("expected a re-bootstrap on a foreign epoch, got {other:?}"),
    }

    // THE STREAM IS OVER. A tail that stayed open after telling a seat to throw
    // its file away would be a stream into a file that is about to be renamed.
    let after = tokio::time::timeout(Duration::from_secs(10), read_envelope(&mut recv))
        .await
        .expect("the tail ended within ten seconds");
    assert!(
        matches!(after, Ok(None) | Err(_)),
        "the tail kept writing after a re-bootstrap"
    );
}
