//! A REAL SEAT ASKS THE REAL GATEWAY FOR ITS LOG (#1020, lane D2).
//!
//! `crates/net/tests/pair_and_stream.rs` proves the transport with a gateway
//! written inside the test: it hands back a `LogPage` literal. This one spawns
//! the shipped binary, pairs with it over QUIC, and asks it for a page that
//! comes out of a vault the binary founded itself. What is under test is the
//! twenty lines between the two — `run.rs`'s accept arm and `seat_lane::serve`
//! — which is exactly the seam that did not exist.
//!
//! The gateway runs `--no-relay`, so pairing is direct over loopback and the
//! test needs no network beyond this machine.
//!
//! ## TWO STATES ON ONE ALPN (#1025 S3, D-1025-S3-4)
//!
//! There is one ALPN and a connection is PROMOTED or PROVISIONAL. This file
//! holds the gateway-side half of that claim, because the lane is where it
//! lives: an unenrolled peer that asks for a log page is closed BY NAME, and
//! the enrolled connection open beside it is untouched. `crates/net`'s own test
//! proves the other half — that `accept` marks such a peer provisional rather
//! than closing it — and neither test can prove the other's.
//!
//! ## ONE STREAM PER REQUEST (#1025 S2)
//!
//! The handshake is the connection's first stream and every request after it
//! opens one of its own. This test drives that shape by hand — it is the
//! wire's, not `centraid_seat_link`'s — so a gateway that regressed to
//! accepting one stream per connection would fail here on the SECOND request
//! rather than in a shell somebody has to reproduce.

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

/// LET A FRESHLY BOUND ENDPOINT FIND ITS OWN ADDRESSES BEFORE IT DIALS.
///
/// `Endpoint::spawn` returns as soon as the socket is bound — which is the
/// contract, and the reason a shell's first screen never waits on a network —
/// and iroh then enumerates this host's interfaces in the background. A dial
/// issued in the middle of that takes seconds longer than one issued after it,
/// and the connect bound is ten (D-1020-C9).
///
/// On a phone a member fills that gap by reading a screen and tapping a button.
/// Here nothing does, so this waits — and asserts nothing about the duration,
/// because it is a property of the host's networking rather than of this
/// product (`docs/traps/first-dial-readiness.md`).
async fn warm(endpoint: &Endpoint) {
    for _ in 0..30 {
        if endpoint
            .addr()
            .await
            .is_some_and(|addr| addr.ip_addrs().next().is_some())
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
}

const READY_LINE: &str = "centraid gateway ready";

/// Kills the gateway when the test ends, pass or fail.
struct Gateway(Child);

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Spawn the binary and read back its ticket. Returns `None` when the gateway
/// never became ready, so the caller can say so rather than hang.
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
    // A THREAD THAT DRAINS STDOUT FOR THE WHOLE RUN, and the draining is the
    // point. The QR block is printed AFTER the ticket line, so a reader that
    // stopped at the ticket would close the pipe under the gateway's next
    // `println!` — and a failed write to stdout PANICS the gateway's main
    // thread. That is what "the pair lane answered: Timeout(10s)" was: not a
    // network problem, a gateway this harness had killed.
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_paired_seat_reads_the_gateways_own_log() {
    let data_dir = tempfile::tempdir().expect("a temp dir");
    let Some((_gateway, encoded)) = start(data_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };
    let scanned = ticket::decode(&encoded).expect("the printed ticket decodes");

    // THE SEAT'S OWN CONFIG, which is `default()` and not `loopback()` — the
    // same one `centraid seat pair` builds. A relay-disabled seat has no
    // discovery of its own and could only reach a gateway whose endpoint it
    // already shared a process with, which is `crates/net`'s test and not this
    // one. The GATEWAY is the half that runs `--no-relay` here, so nothing in
    // this test needs a relay to be reachable; the seat only needs to be able
    // to dial the addresses the ticket carries.
    let seat = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("the seat binds");
    warm(&seat).await;

    // 1. PAIR. The gateway's allowlist is in memory, so this enrolment and the
    //    seat lane below must happen in one run — which they do.
    // The connection the redemption promoted is DROPPED here on purpose: this
    // test drives the plane by hand and dials its own, which is the path a
    // seat takes on every window after the first.
    let (_promoted, paired) = pairing::redeem(&seat, &scanned, "Test Seat", "linux")
        .await
        .expect("the gateway answered the pair stream");
    let vault_id = match paired.result.expect("a result") {
        pair_response::Result::Ok(ok) => ok.vault_id,
        pair_response::Result::Error(error) => panic!("the gateway refused the ticket: {error:?}"),
    };
    assert!(
        !vault_id.is_empty(),
        "the gateway named the vault it founded"
    );

    // 2. THE SEAT LANE, on the enrolled identity. The ticket carries the
    //    gateway's endpoint as bytes; `connect` wants the 32-byte key.
    let gateway_endpoint: [u8; 32] = scanned
        .gateway_endpoint
        .as_slice()
        .try_into()
        .expect("a ticket names a 32-byte endpoint");
    let connection = seat
        .connect(gateway_endpoint, None, &scanned.direct_addrs, alpn::PLANE)
        .await
        .expect("the one plane admits the device it just enrolled");

    // THE VERSION WINDOW, ON THE CONNECTION'S FIRST STREAM, and that stream
    // then ends. The gateway will not accept a request stream before it.
    {
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

    // 3. THE PAGE. `since: None` means "from the floor", which for a vault the
    //    gateway founded moments ago is its whole history.
    let answered = ask(
        &connection,
        core::Request {
            kind: Some(request::Kind::Log(core::LogRequest {
                since: None,
                limit: 1_000,
                // A ONE-SHOT PAGE, not a tail (#1025 S2, D-1025-S7-40).
                tail: false,
            })),
        },
    )
    .await;
    let page = match answered.body {
        Some(envelope::Body::Response(core::Response {
            kind: Some(response::Kind::Log(page)),
        })) => page,
        other => panic!("expected a LogPage from the real gateway, got {other:?}"),
    };

    // THE ROWS ARE THE GATEWAY'S OWN. Founding writes the vault row and its
    // owner party, so a freshly founded vault's log is not empty — and an empty
    // page here would be the failure this whole lane is about, because a seat
    // applies it as "nothing changed" and calls itself caught up.
    assert_eq!(
        page.vault_id, vault_id,
        "the page names the vault it came from"
    );
    assert!(
        !page.rows.is_empty(),
        "a founded vault has a vault row and an owner party; the gateway served an empty log"
    );
    assert!(
        page.rows.iter().any(|row| row.table == "core_vault"),
        "the founding commit is in the page: {:?}",
        page.rows.iter().map(|row| &row.table).collect::<Vec<_>>()
    );

    // 4. THE SECOND ASK, on the cursor the first answer returned. This is the
    //    loop a seat actually runs, and it is the half most likely to be
    //    quietly wrong: a gateway that ignored `since` would re-serve the same
    //    rows forever and a seat would apply its own history in a circle.
    let cursor = core::LogCursor {
        epoch: page.epoch.clone(),
        seq: page.next,
    };
    let answered = ask(
        &connection,
        core::Request {
            kind: Some(request::Kind::Log(core::LogRequest {
                since: Some(cursor),
                limit: 1_000,
                // A ONE-SHOT PAGE, not a tail (#1025 S2, D-1025-S7-40).
                tail: false,
            })),
        },
    )
    .await;
    let tail = match answered.body {
        Some(envelope::Body::Response(core::Response {
            kind: Some(response::Kind::Log(page)),
        })) => page,
        other => panic!("expected a second LogPage, got {other:?}"),
    };
    assert!(
        tail.rows.is_empty(),
        "the gateway re-served {} rows the seat had already acknowledged",
        tail.rows.len()
    );
    assert!(!tail.has_more, "a caught-up seat is told it is caught up");

    // 5. THE REFUSAL IS BY NAME. A seat that asks for anything but the log gets
    //    `UNSUPPORTED_MESSAGE` and a member sentence, not a silent close and
    //    not an answer this lane has no principal to make.
    let refused = ask(
        &connection,
        core::Request {
            kind: Some(request::Kind::Hello(local_hello(
                "1.0.0-test",
                &["replica"],
            ))),
        },
    )
    .await;
    match refused.body {
        Some(envelope::Body::Error(error)) => {
            assert_eq!(error.code, core::ErrorCode::UnsupportedMessage as i32);
            assert!(
                !error.sentence.is_empty(),
                "a refusal a member could be shown says something"
            );
        }
        other => panic!("expected a typed refusal, got {other:?}"),
    }

    // 6. A MALFORMED FIRST FRAME COSTS ITS STREAM AND NOT THE CONNECTION
    //    (#1025 S2). `len == 0` is a refusal rather than an empty message —
    //    a stream of zeroes would otherwise be an infinite sequence of valid
    //    frames — so this is a frame the reader cannot recover from, on a
    //    connection that must survive it.
    {
        let (mut send, _recv) = connection.open_bi().await.expect("a stream opens");
        send.write_all(&[0u8, 0, 0, 0])
            .await
            .expect("the prefix goes out");
        send.flush().await.expect("flush");
        let _ = send.finish();
    }

    // THE CONNECTION IS STILL THERE, and it still answers. Under one stream per
    // connection this assertion could not even be written: the malformed frame
    // WAS the connection, and there was nothing left to ask on.
    let after = ask(
        &connection,
        core::Request {
            kind: Some(request::Kind::Log(core::LogRequest {
                since: None,
                limit: 1_000,
                // A ONE-SHOT PAGE, not a tail (#1025 S2, D-1025-S7-40).
                tail: false,
            })),
        },
    )
    .await;
    assert!(
        matches!(
            after.body,
            Some(envelope::Body::Response(core::Response {
                kind: Some(response::Kind::Log(_)),
            }))
        ),
        "a malformed frame on one stream took the whole connection down"
    );
}

/// One request, on a stream of its own, answered once.
///
/// The request id is 1 on every stream, because a stream carries exactly one
/// request and there is nothing to disambiguate; zero stays reserved for the
/// handshake.
async fn ask(connection: &centraid_net::IrohConnection, request: core::Request) -> core::Envelope {
    let (mut send, mut recv) = connection.open_bi().await.expect("a request stream opens");
    let asked = centraid_protocol::wire::request(1, request);
    write_envelope(&mut send, &asked).await.expect("write");
    send.flush().await.expect("flush");
    let _ = send.finish();
    read_envelope(&mut recv)
        .await
        .expect("read")
        .expect("the gateway answered")
}

/// AN UNENROLLED PEER IS CLOSED BY NAME, AND IT COSTS AN ENROLLED SEAT NOTHING
/// (#1025 S3, D-1025-S3-4).
///
/// The two halves are the test. A stranger that opens a `log` stream on the one
/// ALPN is refused with `UNAUTHORIZED` and its CONNECTION ends — not merely its
/// stream, because a peer this gateway has never enrolled and which did not ask
/// to be has nothing else this plane can serve it. And the seat that paired
/// properly, whose connection is open at the same moment, reads its page
/// afterwards exactly as if nothing had happened.
///
/// The second assertion is the one that would catch the real regression. Making
/// the refusal close the endpoint, or drop the accept loop, or poison a shared
/// lane is the shape of mistake that only shows up when two devices are in
/// range at once — which is every household.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unenrolled_peer_is_closed_by_name_and_an_enrolled_one_is_untouched() {
    let data_dir = tempfile::tempdir().expect("a temp dir");
    let Some((_gateway, encoded)) = start(data_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };
    let scanned = ticket::decode(&encoded).expect("the printed ticket decodes");
    let gateway_endpoint: [u8; 32] = scanned
        .gateway_endpoint
        .as_slice()
        .try_into()
        .expect("a ticket names a 32-byte endpoint");

    // ---- THE ENROLLED SEAT, CONNECTED AND HANDSHAKEN -----------------------
    let seat = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("the seat binds");
    warm(&seat).await;
    let (promoted, paired) = pairing::redeem(&seat, &scanned, "Test Seat", "linux")
        .await
        .expect("the gateway answered the pair stream");
    assert!(
        matches!(
            paired.result.expect("a result"),
            pair_response::Result::Ok(_)
        ),
        "the ticket did not enrol the seat"
    );
    // THE CONNECTION THE REDEMPTION PROMOTED, used without a second dial. The
    // handshake below is the second stream of the connection whose FIRST stream
    // was the pairing — which is the whole of "promoted in place".
    {
        let (mut send, mut recv) = promoted.open_bi().await.expect("the stream opens");
        centraid_protocol::handshake::dial(
            &mut send,
            &mut recv,
            &local_hello("1.0.0-test", &["replica"]),
        )
        .await
        .expect("the promoted connection carries the version window");
        send.flush().await.expect("flush");
        let _ = send.finish();
    }

    // ---- THE STRANGER ------------------------------------------------------
    let stranger = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("the stranger binds");
    let uninvited = stranger
        .connect(gateway_endpoint, None, &scanned.direct_addrs, alpn::PLANE)
        .await
        .expect("the QUIC handshake succeeds; admission is above it");
    let (mut send, mut recv) = uninvited.open_bi().await.expect("the stream opens");
    write_envelope(
        &mut send,
        &centraid_protocol::wire::request(
            7,
            core::Request {
                kind: Some(request::Kind::Log(core::LogRequest {
                    since: None,
                    limit: 10,
                // A ONE-SHOT PAGE, not a tail (#1025 S2, D-1025-S7-40).
                tail: false,
            })),
            },
        ),
    )
    .await
    .expect("write");
    send.flush().await.expect("flush");

    // BY NAME. The refusal is written before the connection goes, so a member
    // holding a revoked phone is told what happened rather than watching a
    // dial fail silently.
    let refusal = tokio::time::timeout(Duration::from_secs(10), read_envelope(&mut recv))
        .await
        .expect("the gateway answered inside the budget")
        .expect("read")
        .expect("a refusal");
    match refusal.body {
        Some(envelope::Body::Error(error)) => {
            assert_eq!(
                error.code,
                core::ErrorCode::Unauthorized as i32,
                "an unenrolled peer's log request was refused as {error:?}"
            );
            assert!(!error.sentence.is_empty(), "a refusal carries a sentence");
        }
        other => panic!("expected an UNAUTHORIZED error, got {other:?}"),
    }
    // AND THE CONNECTION GOES. Waiting on `closed` rather than asserting on a
    // second read, because "the connection ended" is the fact and a second read
    // is one way it shows up.
    tokio::time::timeout(Duration::from_secs(10), uninvited.closed())
        .await
        .expect("the gateway closed the stranger's connection");

    // ---- AND THE ENROLLED SEAT IS UNTOUCHED --------------------------------
    let answered = ask(
        &promoted,
        core::Request {
            kind: Some(request::Kind::Log(core::LogRequest {
                since: None,
                limit: 10,
                // A ONE-SHOT PAGE, not a tail (#1025 S2, D-1025-S7-40).
                tail: false,
            })),
        },
    )
    .await;
    match answered.body {
        Some(envelope::Body::Response(core::Response {
            kind: Some(response::Kind::Log(page)),
        })) => assert!(
            !page.vault_id.is_empty(),
            "the page names the vault it came from"
        ),
        other => panic!("the enrolled seat's page was lost with the stranger: {other:?}"),
    }
}
