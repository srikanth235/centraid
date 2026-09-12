//! The lane's exit criterion: **two processes pair and stream a commit**, plus
//! the relay cases #1020 requires to have tests (D-1020-C9).
//!
//! "Two processes" is two independent iroh endpoints with their own sockets and
//! their own identities, in one test binary. The test is honest about what that
//! does and does not prove: the QUIC handshake, the ALPN routing, the ticket
//! redemption, the allowlist admission and the framed streaming are all real,
//! over real UDP on the loopback interface; what it does not exercise is NAT
//! traversal, which needs two networks and is `cross_network_relay`'s job in
//! `tests/agent-e2e-pairing` for v0 and the wave 3 lane G VPS smoke for v1.

use std::time::Duration;

use centraid_api_proto::core_v1::{
    self as core, LogOp, LogPage, LogRow, RecordKey, RowImage, Value, envelope, pair_response,
    request, response, value,
};
use centraid_net::allowlist::{AllowlistStore as _, Device, MemoryAllowlist};
use centraid_net::endpoint::{Endpoint, EndpointConfig, RelayMode};
use centraid_net::error::ConnectError;
use centraid_net::{pairing, ticket};
use centraid_protocol::Connection as _;
use centraid_protocol::alpn;
use centraid_protocol::version::local_hello;
use centraid_protocol::wire::{read_envelope, write_envelope};
use tokio::io::AsyncWriteExt as _;

const VAULT_ID: &str = "vault_test";
const VAULT_NAME: &str = "Home";
const GATEWAY_ID: &str = "gw_test";

fn text(literal: &str) -> Value {
    Value {
        kind: Some(value::Kind::Text(literal.to_owned())),
    }
}

/// Three synthetic log rows, one commit. Small on purpose — what is under test
/// is that a commit arrives whole and is acknowledged, not that the log scales.
fn a_commit() -> LogPage {
    let rows = (1u64..=3)
        .map(|index| {
            let mut columns = RowImage::default();
            columns
                .columns
                .insert("title".to_owned(), text(&format!("row {index}")));
            LogRow {
                seq: index,
                commit_seq: 1,
                schema_epoch: 4,
                ddl_version: 0,
                table: "tally_expense".to_owned(),
                op: LogOp::Insert as i32,
                pk: Some(RecordKey {
                    values: vec![text(&format!("exp_{index}"))],
                }),
                row: Some(columns),
                prior: None,
                indirect: false,
                deferred: false,
                producer: "gateway".to_owned(),
                committed_at: "2026-01-01T00:00:00.000Z".to_owned(),
            }
        })
        .collect::<Vec<_>>();
    LogPage {
        vault_id: VAULT_ID.to_owned(),
        epoch: "epoch_test".to_owned(),
        schema_epoch: 4,
        ddl_version: 0,
        floor: 0,
        watermark: 3,
        next: 3,
        has_more: false,
        rows,
    }
}

/// THE EXIT CRITERION. A seat redeems a QR ticket against a gateway and then
/// streams one commit off it, on two different ALPNs, over real UDP.
///
/// Every number the report quotes comes from here: the frame count, the bytes,
/// and the wall clock.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_endpoints_pair_and_stream_a_commit() {
    let started = std::time::Instant::now();

    let gateway = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("the gateway binds");
    let seat = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("the seat binds");
    let allowlist = std::sync::Arc::new(MemoryAllowlist::new());

    let minted = pairing::mint(&gateway, allowlist.as_ref(), VAULT_NAME, 0)
        .await
        .expect("minted");
    // The member's path: the QR's payload, decoded.
    let scanned = ticket::decode(&minted.encoded).expect("the QR round-trips");
    assert!(
        !scanned.direct_addrs.is_empty(),
        "a relay-less gateway must put its addresses in the ticket (D-1020-C15)"
    );

    // The gateway's accept loop: two connections, one per lane.
    let serving = {
        let gateway = gateway.clone();
        let allowlist = allowlist.clone();
        let page = a_commit();
        tokio::spawn(async move {
            let mut lanes: Vec<Vec<u8>> = Vec::new();
            // The accepted connections are HELD for the length of the task.
            // Dropping one closes it, and a QUIC close discards whatever the
            // peer has not read yet — so a gateway that answered and moved on
            // would close the connection under the seat's own read. That is a
            // real ordering rule and not a test artefact: the answer is not
            // delivered until the peer has read it.
            let mut held = Vec::new();
            let mut sent_frames = 0usize;
            let mut sent_bytes = 0usize;
            while lanes.len() < 2 {
                let accepted = gateway
                    .accept(allowlist.as_ref())
                    .await
                    .expect("accepted")
                    .expect("the endpoint is open");
                if accepted.alpn == alpn::PAIR {
                    let redeemed = pairing::serve_redemption(
                        &accepted.connection,
                        allowlist.as_ref(),
                        VAULT_ID,
                        VAULT_NAME,
                        GATEWAY_ID,
                        1_000,
                    )
                    .await
                    .expect("served");
                    assert!(redeemed.device.is_some(), "the ticket enrolled the seat");
                    lanes.push(accepted.alpn.clone());
                    held.push(accepted.connection);
                    continue;
                }

                // The seat lane. The device is already known — `accept` refused
                // an unenrolled peer before this line.
                assert_eq!(accepted.alpn, alpn::SEAT);
                assert!(
                    accepted.device.as_ref().expect("admitted").is_live(),
                    "`accept` refused an unenrolled peer above this line"
                );
                let (mut send, mut recv) = accepted
                    .connection
                    .accept_bi()
                    .await
                    .expect("the seat opened a stream");

                // 1. the handshake, at request id 0
                centraid_protocol::handshake::accept(
                    &mut send,
                    &mut recv,
                    &local_hello("1.0.0-test", &["replica"]),
                )
                .await
                .expect("the window admits the seat");
                sent_frames += 1;

                // 2. the commit, answering the seat's LogRequest
                let asked = read_envelope(&mut recv)
                    .await
                    .expect("read")
                    .expect("a request");
                let limit = match asked.body {
                    Some(envelope::Body::Request(core::Request {
                        kind: Some(request::Kind::Log(log)),
                    })) => log.limit,
                    other => panic!("expected a LogRequest, got {other:?}"),
                };
                assert!(limit > 0, "`limit` is required and validated > 0");
                let answer = centraid_protocol::wire::response(
                    asked.request_id,
                    core::Response {
                        kind: Some(response::Kind::Log(page.clone())),
                    },
                );
                sent_bytes += prost::Message::encoded_len(&answer) + 4;
                write_envelope(&mut send, &answer).await.expect("write");
                send.flush().await.expect("flush");
                sent_frames += 1;

                // 3. the seat's acknowledgement, as a cursor in a second
                //    LogRequest — the shape a real seat uses, so the test does
                //    not invent an ack message the protocol does not have.
                let acked = read_envelope(&mut recv)
                    .await
                    .expect("read")
                    .expect("an ack");
                match acked.body {
                    Some(envelope::Body::Request(core::Request {
                        kind: Some(request::Kind::Log(log)),
                    })) => {
                        let since = log.since.expect("the seat sent its cursor");
                        assert_eq!(since.seq, 3, "the seat acknowledged the whole commit");
                        assert_eq!(since.epoch, "epoch_test");
                    }
                    other => panic!("expected the seat's cursor, got {other:?}"),
                }
                lanes.push(accepted.alpn.clone());
                held.push(accepted.connection);
            }
            (lanes, sent_frames, sent_bytes, held.len())
        })
    };

    // ---- the seat's half ----

    let paired = pairing::redeem(&seat, &scanned, "Test Phone", "linux")
        .await
        .expect("the pair lane answered");
    match paired.result.expect("a result") {
        pair_response::Result::Ok(ok) => {
            assert_eq!(ok.vault_id, VAULT_ID);
            assert_eq!(ok.vault_name, VAULT_NAME);
            assert_eq!(ok.gateway_id, GATEWAY_ID);
        }
        pair_response::Result::Error(error) => panic!("refused: {error:?}"),
    }
    // The enrolment is a fact in the gateway's own store, not just a response.
    assert!(
        allowlist
            .device(&seat.id())
            .await
            .expect("enrolled")
            .is_live()
    );

    let connection = seat
        .connect(gateway.id(), None, &scanned.direct_addrs, alpn::SEAT)
        .await
        .expect("the seat lane admits an enrolled device");
    let (mut send, mut recv) = connection.open_bi().await.expect("open");

    let mut frames = 0usize;
    let mut bytes = 0usize;

    centraid_protocol::handshake::dial(
        &mut send,
        &mut recv,
        &local_hello("1.0.0-test", &["replica"]),
    )
    .await
    .expect("the window admits the gateway");
    send.flush().await.expect("flush");
    frames += 1;

    let ask = centraid_protocol::wire::request(
        1,
        core::Request {
            kind: Some(request::Kind::Log(core::LogRequest {
                since: None,
                limit: 1_000,
            })),
        },
    );
    bytes += prost::Message::encoded_len(&ask) + 4;
    write_envelope(&mut send, &ask).await.expect("write");
    send.flush().await.expect("flush");
    frames += 1;

    let answered = read_envelope(&mut recv)
        .await
        .expect("read")
        .expect("a page");
    frames += 1;
    let page = match answered.body {
        Some(envelope::Body::Response(core::Response {
            kind: Some(response::Kind::Log(page)),
        })) => page,
        other => panic!("expected a LogPage, got {other:?}"),
    };
    assert_eq!(answered.request_id, 1, "the answer names the request");
    assert_eq!(page.rows.len(), 3, "the commit arrived whole");
    assert!(!page.has_more);
    assert_eq!(
        page.next, page.watermark,
        "no more rows, so next is the watermark"
    );
    assert_eq!(page.rows[0].commit_seq, 1);
    assert_eq!(
        page.rows.iter().map(|row| row.seq).collect::<Vec<_>>(),
        [1, 2, 3],
        "in order"
    );
    assert_eq!(
        page.rows[2]
            .row
            .as_ref()
            .expect("an image")
            .columns
            .get("title"),
        Some(&text("row 3"))
    );

    // Acknowledge by sending the cursor back.
    let ack = centraid_protocol::wire::request(
        2,
        core::Request {
            kind: Some(request::Kind::Log(core::LogRequest {
                since: Some(core::LogCursor {
                    epoch: page.epoch.clone(),
                    seq: page.next,
                }),
                limit: 1_000,
            })),
        },
    );
    bytes += prost::Message::encoded_len(&ack) + 4;
    write_envelope(&mut send, &ack).await.expect("write");
    send.flush().await.expect("flush");
    frames += 1;

    let (lanes, gateway_frames, gateway_bytes, connections) =
        tokio::time::timeout(Duration::from_secs(20), serving)
            .await
            .expect("the gateway finished inside the budget")
            .expect("the task joined");
    assert_eq!(connections, 2, "one connection per lane, both held open");
    assert_eq!(lanes.len(), 2, "both lanes were used");
    assert!(lanes.contains(&alpn::PAIR.to_vec()));
    assert!(lanes.contains(&alpn::SEAT.to_vec()));

    let elapsed = started.elapsed();
    // Printed rather than asserted: they are the report's numbers, and an
    // assertion on a wall clock is a flaky test on a loaded runner. The one
    // bound that IS asserted is the 20-second timeout above, which is a
    // liveness check and not a performance claim.
    println!(
        "pair-and-stream: seat sent/read {frames} frames ({bytes} body bytes), gateway wrote \
         {gateway_frames} frames ({gateway_bytes} body bytes), 3 rows in 1 commit, wall clock \
         {:.3}s",
        elapsed.as_secs_f64()
    );

    gateway.close().await;
    seat.close().await;
}

/// The no-relay case #1020 requires a test for: relays disabled, a peer id that
/// is real but routes nowhere. The answer must be typed and must arrive inside
/// the budget — **never a hang** (D-1020-C9).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unroutable_peer_fails_typed_inside_the_timeout() {
    let mut config = EndpointConfig::loopback();
    // Two seconds rather than ten: the assertion is that the dial is BOUNDED,
    // and a test that takes ten seconds to prove it is a test people delete.
    config.connect_timeout = Duration::from_secs(2);
    let seat = Endpoint::spawn(config).await.expect("bind");

    // A well-formed id nothing answers for, with no addresses and no relay.
    let nobody = *iroh::SecretKey::generate().public().as_bytes();

    let started = std::time::Instant::now();
    let error = seat
        .connect(nobody, None, &[], alpn::SEAT)
        .await
        .expect_err("nothing is there");
    let elapsed = started.elapsed();

    assert!(
        matches!(
            error,
            ConnectError::PeerUnreachable | ConnectError::Timeout(_)
        ),
        "expected a typed unreachable/timeout, got {error:?}"
    );
    assert!(
        error.is_worth_retrying(),
        "an unroutable peer may become routable; the shell should keep trying"
    );
    assert!(
        elapsed < Duration::from_secs(6),
        "the dial took {elapsed:?} against a 2s budget — connect is not bounded"
    );
    println!(
        "unroutable peer: {error} after {:.3}s",
        elapsed.as_secs_f64()
    );
    seat.close().await;
}

/// An unenrolled peer on the seat lane is closed with `Unauthorized` **before
/// any frame is read** (#1020, D-1020-C8). The assertion that makes it mean
/// something is the second one: the gateway never accepted a stream, so the
/// bytes the impostor wrote were never parsed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unenrolled_peer_is_closed_before_a_frame_is_read() {
    let gateway = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("bind");
    let seat = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("bind");
    let allowlist = std::sync::Arc::new(MemoryAllowlist::new());
    let hints: Vec<String> = gateway
        .addr()
        .await
        .expect("bound")
        .ip_addrs()
        .map(ToString::to_string)
        .collect();

    let serving = {
        let gateway = gateway.clone();
        let allowlist = allowlist.clone();
        tokio::spawn(async move { gateway.accept(allowlist.as_ref()).await.err() })
    };

    let connection = seat
        .connect(gateway.id(), None, &hints, alpn::SEAT)
        .await
        .expect("the QUIC handshake itself succeeds; admission is above it");
    // Write a frame the gateway must never parse.
    if let Ok((mut send, _recv)) = connection.open_bi().await {
        let _ = write_envelope(
            &mut send,
            &centraid_protocol::wire::request(
                1,
                core::Request {
                    kind: Some(request::Kind::Hello(local_hello("1.0.0-test", &[]))),
                },
            ),
        )
        .await;
        let _ = send.flush().await;
    }

    let refusal = tokio::time::timeout(Duration::from_secs(20), serving)
        .await
        .expect("the gateway answered inside the budget")
        .expect("the task joined")
        .expect("a refusal");
    assert!(
        matches!(refusal, ConnectError::Unauthorized),
        "expected Unauthorized, got {refusal:?}"
    );
    assert!(
        !refusal.is_worth_retrying(),
        "an unenrolled device must be told to pair, not left retrying"
    );
    // Nothing was enrolled by the attempt.
    assert!(allowlist.device(&seat.id()).await.is_none());

    gateway.close().await;
    seat.close().await;
}

/// A revoked device is refused for the SAME reason an unknown one is
/// (`packages/vault/src/gateway/identity.ts:27-35`). Asserted through the
/// allowlist rather than over the wire, because the wire path is the test above
/// and what is under test here is that revocation reaches the admission
/// decision at all.
#[tokio::test]
async fn a_revoked_device_is_refused_like_an_unknown_one() {
    let allowlist = MemoryAllowlist::new();
    let endpoint = [9u8; 32];
    allowlist.enroll_without_a_ticket(Device {
        endpoint_id: endpoint,
        device_id: "dev_9".to_owned(),
        label: "An Old Phone".to_owned(),
        platform: "ios".to_owned(),
        enrolled_at_ms: 0,
        revoked_at_ms: None,
    });
    assert!(
        allowlist
            .device(&endpoint)
            .await
            .filter(Device::is_live)
            .is_some()
    );
    allowlist.revoke("dev_9", 1_000).await.expect("revoked");
    assert!(
        allowlist
            .device(&endpoint)
            .await
            .filter(Device::is_live)
            .is_none(),
        "a revoked device must fail the same filter an unknown one fails"
    );
    assert!(
        allowlist.device(&[1u8; 32]).await.is_none(),
        "and an unknown one is simply absent"
    );
}

/// `spawn` never blocks on the network (D-1020-C10), and it holds for the
/// DEFAULT relay mode too — which is the case that could block, because a relay
/// handshake is a network round trip.
///
/// The assertion is a time bound, which is the only way to state "did not wait
/// for the network". Two seconds is generous by an order of magnitude against a
/// relay handshake over a real WAN and still fails loudly if `online()` were
/// ever awaited in `bind`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_returns_without_waiting_for_a_relay() {
    let started = std::time::Instant::now();
    let endpoint = Endpoint::spawn(EndpointConfig {
        relay: RelayMode::Default,
        ..EndpointConfig::default()
    })
    .await
    .expect("binding the UDP socket does not need a relay");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "spawn took {elapsed:?} — it waited for the network (D-1020-C10)"
    );

    // The first connectivity state a shell sees is OFFLINE, not a spinner.
    let mut events = endpoint.events();
    let seat = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("bind");
    drop(seat);
    // The OFFLINE event was emitted during `bind`, before this subscription, so
    // the subscription is asserted to be usable rather than to have received
    // it — a broadcast channel has no replay, deliberately (a shell that is
    // behind needs the current state, not history).
    assert!(events.try_recv().is_err());

    println!(
        "spawn with the default relay mode returned in {:.3}s",
        elapsed.as_secs_f64()
    );
    endpoint.close().await;
}

/// Idling closes the socket and resuming re-binds under the SAME identity
/// (D-1020-C14). The identity assertion is the load-bearing one: an endpoint id
/// that changed across a background cycle would be a gateway every paired seat
/// stops recognising.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_and_resume_keep_the_endpoint_id() {
    let endpoint = Endpoint::spawn(EndpointConfig::loopback())
        .await
        .expect("bind");
    let before = endpoint.id();
    let addr_before = endpoint.addr().await.expect("bound");

    endpoint.idle().await;
    assert!(endpoint.is_idle());
    assert!(
        endpoint.addr().await.is_none(),
        "an idled endpoint has no socket, which is the battery cost being removed"
    );
    // A dial while idle is refused rather than silently re-binding: a
    // backgrounded phone that dialled on its own is exactly what idling exists
    // to prevent.
    assert!(matches!(
        endpoint
            .connect([7u8; 32], None, &[], alpn::SEAT)
            .await
            .expect_err("idle"),
        ConnectError::PeerUnreachable
    ));

    endpoint.resume().await.expect("re-bind");
    assert!(!endpoint.is_idle());
    assert_eq!(
        endpoint.id(),
        before,
        "the identity is the secret key, not the socket"
    );
    let addr_after = endpoint.addr().await.expect("re-bound");
    assert_eq!(addr_after.id, addr_before.id);

    // Resuming an already-resumed endpoint is a no-op rather than a re-bind.
    endpoint.resume().await.expect("idempotent");
    assert_eq!(endpoint.id(), before);
    endpoint.close().await;
}

/// The relay-only case (#1020, D-1020-C9 (c)).
///
/// **`#[ignore]`d here, and the reason is the environment, not the code.** The
/// case needs two endpoints that can reach a relay and cannot reach each other
/// directly. This container has one network namespace and egress only through
/// an HTTPS proxy, so n0's relays are not reachable from it and "withhold the
/// direct addresses" would test nothing but a failed dial. It runs under
/// `cargo test -- --ignored` in the `nightly` profile, where the runner has
/// real egress, and it is the wave 3 lane G VPS smoke that proves it on the
/// network the product actually ships on.
///
/// It is written out rather than left as a comment so that the day the lane
/// exists, the test is what runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs egress to a relay and two networks: run under --ignored on the nightly runner (#1020 wave 2 lane C, D-1020-C9)"]
async fn a_relay_only_pair_and_stream() {
    let relayed = || EndpointConfig {
        relay: RelayMode::Default,
        ..EndpointConfig::default()
    };
    let gateway = Endpoint::spawn(relayed()).await.expect("bind");
    let seat = Endpoint::spawn(relayed()).await.expect("bind");
    let allowlist = std::sync::Arc::new(MemoryAllowlist::new());

    let minted = pairing::mint(&gateway, allowlist.as_ref(), VAULT_NAME, 0)
        .await
        .expect("minted");
    let scanned = ticket::decode(&minted.encoded).expect("decoded");
    assert!(
        !scanned.relay_url.is_empty(),
        "a relayed gateway must name its home relay in the ticket"
    );

    let serving = {
        let gateway = gateway.clone();
        let allowlist = allowlist.clone();
        tokio::spawn(async move {
            let accepted = gateway
                .accept(allowlist.as_ref())
                .await
                .expect("accepted")
                .expect("open");
            pairing::serve_redemption(
                &accepted.connection,
                allowlist.as_ref(),
                VAULT_ID,
                VAULT_NAME,
                GATEWAY_ID,
                1_000,
            )
            .await
            .expect("served")
            .device
            .is_some()
        })
    };

    // RELAY ONLY: the ticket's direct addresses are dropped, so the only path
    // left is the home relay named in it.
    let relay_only = centraid_api_proto::core_v1::PairTicket {
        direct_addrs: Vec::new(),
        ..scanned
    };
    let paired = pairing::redeem(&seat, &relay_only, "Relayed Phone", "linux")
        .await
        .expect("the relay carried the pair lane");
    assert!(matches!(
        paired.result.expect("a result"),
        pair_response::Result::Ok(_)
    ));
    assert!(
        tokio::time::timeout(Duration::from_secs(30), serving)
            .await
            .expect("inside the budget")
            .expect("joined")
    );

    gateway.close().await;
    seat.close().await;
}
