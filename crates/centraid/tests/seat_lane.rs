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
    let seat = Endpoint::spawn(EndpointConfig::default())
        .await
        .expect("the seat binds");

    // 1. PAIR. The gateway's allowlist is in memory, so this enrolment and the
    //    seat lane below must happen in one run — which they do.
    let paired = pairing::redeem(&seat, &scanned, "Test Seat", "linux")
        .await
        .expect("the pair lane answered");
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
        .connect(gateway_endpoint, None, &scanned.direct_addrs, alpn::SEAT)
        .await
        .expect("the seat lane admits the device it just enrolled");
    let (mut send, mut recv) = connection.open_bi().await.expect("the stream opens");

    centraid_protocol::handshake::dial(
        &mut send,
        &mut recv,
        &local_hello("1.0.0-test", &["replica"]),
    )
    .await
    .expect("the version window admits this seat");
    send.flush().await.expect("flush");

    // 3. THE PAGE. `since: None` means "from the floor", which for a vault the
    //    gateway founded moments ago is its whole history.
    let ask = centraid_protocol::wire::request(
        1,
        core::Request {
            kind: Some(request::Kind::Log(core::LogRequest {
                since: None,
                limit: 1_000,
            })),
        },
    );
    write_envelope(&mut send, &ask).await.expect("write");
    send.flush().await.expect("flush");

    let answered = read_envelope(&mut recv)
        .await
        .expect("read")
        .expect("the gateway answered");
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
    let again = centraid_protocol::wire::request(
        2,
        core::Request {
            kind: Some(request::Kind::Log(core::LogRequest {
                since: Some(cursor),
                limit: 1_000,
            })),
        },
    );
    write_envelope(&mut send, &again).await.expect("write");
    send.flush().await.expect("flush");
    let answered = read_envelope(&mut recv)
        .await
        .expect("read")
        .expect("the gateway answered");
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
    let overreach = centraid_protocol::wire::request(
        3,
        core::Request {
            kind: Some(request::Kind::Hello(local_hello(
                "1.0.0-test",
                &["replica"],
            ))),
        },
    );
    write_envelope(&mut send, &overreach).await.expect("write");
    send.flush().await.expect("flush");
    let refused = read_envelope(&mut recv)
        .await
        .expect("read")
        .expect("the gateway answered");
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
}
