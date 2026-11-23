//! THE CLIENT'S TRANSPORT, AGAINST REAL SOCKETS (#1209, spec §4, G4).
//!
//! HTTP/2 with HTTP/1.1 by ALPN; every address dialled at once, preferred
//! first and the rest after a stagger, the first verified handshake winning;
//! retries bounded by count for idempotent calls; `BUSY` honoured with its
//! `retry_after_ms`; a typed reach. **Nothing here asserts on seconds**: the
//! stagger is injected, waits are counted, and every claim is a count of
//! dials, attempts, calls, connections or retries.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse as _, Response};
use axum::routing::{any, post};
use centraid_gateway::client::tls::{Trust, client_config};
use centraid_gateway::client::{Client, ClientError, Destination, Limits, Reach};
use centraid_gateway::rules::bundle::Frame;
use centraid_gateway::rules::code::{Code, Refusal, RefusalBody};
use centraid_gateway::rules::ids::{GatewayId, Name, Pin, Token, VaultId};
use centraid_gateway::rules::wire::{CODE_HEADER, Missing};
use centraid_gateway::server::harness::{Spawned, pair_secret, spawn, spawn_http1_only};
use centraid_gateway::server::serve::{TlsListener, bind, run_router};
use centraid_gateway::server::tls::Identity;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::pki_types::ServerName;

async fn paired(gateway: &Spawned) -> (VaultId, Client, Token) {
    let key = ed25519_dalek::SigningKey::from_bytes(&[61; 32]);
    let paired = pair_secret(
        &gateway.first_contact(),
        &key,
        "a phone",
        gateway.mint_pairing_secret(),
    )
    .await
    .expect("pairs");
    (
        VaultId::from_bytes(key.verifying_key().to_bytes()),
        gateway.client(paired.token),
        paired.token,
    )
}

fn frame(label: &str) -> Frame {
    let name = Name::from_bytes(blake3::derive_key("transport name", label.as_bytes()));
    Frame::of(name, blake3::hash(label.as_bytes()).as_bytes().repeat(8))
}

/// An address nothing listens on: a port bound and let go.
async fn dead_address() -> String {
    let socket = bind("127.0.0.1:0").await.expect("binds");
    socket.local_addr().expect("an address").to_string()
}

fn destination(addrs: Vec<String>, gateway: &Spawned, token: Token) -> Destination {
    Destination {
        addrs,
        cert_der: gateway.cert_der.clone(),
        token,
    }
}

/// What ALPN the gateway answers a client that offers `offered`.
async fn negotiated(gateway: &Spawned, offered: &[&[u8]]) -> Option<Vec<u8>> {
    let socket = tokio::net::TcpStream::connect(gateway.addr)
        .await
        .expect("connects");
    let mut config = (*client_config(Trust::Certificate(gateway.cert_der.clone()))).clone();
    config.alpn_protocols = offered.iter().map(|alpn| alpn.to_vec()).collect();
    let stream = TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from("localhost").expect("a name"), socket)
        .await
        .expect("handshakes");
    stream.get_ref().1.alpn_protocol().map(<[u8]>::to_vec)
}

/// SERVER-SIDE ALPN: `h2` is chosen when it is offered, even beside
/// `http/1.1`; a client that offers `http/1.1` alone gets it; one that
/// offers nothing still handshakes (and is served HTTP/1.1).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_gateway_prefers_h2_and_falls_back_to_http_1_1() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    assert_eq!(
        negotiated(&gateway, &[b"h2", b"http/1.1"]).await,
        Some(b"h2".to_vec())
    );
    assert_eq!(
        negotiated(&gateway, &[b"http/1.1", b"h2"]).await,
        Some(b"h2".to_vec()),
        "the server's order decides"
    );
    assert_eq!(
        negotiated(&gateway, &[b"http/1.1"]).await,
        Some(b"http/1.1".to_vec())
    );
    assert_eq!(negotiated(&gateway, &[]).await, None);
    gateway.shutdown().await;

    let dir = tempfile::tempdir().expect("a temp dir");
    let old = spawn_http1_only(dir.path()).await.expect("spawned");
    assert_eq!(
        negotiated(&old, &[b"h2", b"http/1.1"]).await,
        Some(b"http/1.1".to_vec()),
        "a gateway that does not offer h2 is not given it"
    );
    old.shutdown().await;
}

/// THE CLIENT SPEAKS WHAT WAS AGREED: HTTP/2 to a gateway that offers it,
/// HTTP/1.1 to one that does not, and every route works over both. Many calls
/// ride one connection, counted at the gateway's cable.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_client_speaks_h2_and_falls_back_to_http_1_1_by_alpn() {
    for (offering_h2, expected) in [(true, "h2"), (false, "http/1.1")] {
        let dir = tempfile::tempdir().expect("a temp dir");
        let gateway = if offering_h2 {
            spawn(dir.path()).await
        } else {
            spawn_http1_only(dir.path()).await
        }
        .expect("spawned");
        let (vault, phone, _) = paired(&gateway).await;
        let one = frame("over either protocol");
        assert_eq!(
            phone
                .bundle(&vault, std::slice::from_ref(&one))
                .await
                .expect("stores")
                .stored(),
            1
        );
        assert_eq!(
            phone.get(&vault, &one.name, None).await.expect("reads"),
            one.bytes
        );
        assert_eq!(
            phone.fetch(&vault, &[one.name]).await.expect("fetches")[0].bytes,
            one.bytes
        );
        assert!(
            phone
                .exists(&vault, &[one.name])
                .await
                .expect("exists")
                .is_empty()
        );
        assert_eq!(phone.negotiated(), Some(expected));
        gateway.shutdown().await;
    }
}

/// THREE DEAD ADDRESSES AHEAD OF A LIVE ONE STILL REACH THE GATEWAY IN ONE
/// DIAL ATTEMPT: one call, no retry, one connection. Each address was tried
/// once (four), one TCP connection was made, and the live address is now the
/// preferred one. The default stagger is used: the dead addresses fail at
/// once, and the next address is dialled at once, not after the stagger.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn three_dead_addresses_ahead_of_a_live_one_reach_in_one_dial_attempt() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (_, _, token) = paired(&gateway).await;
    let accepted = gateway.cable().connections();
    let addrs = vec![
        dead_address().await,
        dead_address().await,
        dead_address().await,
        gateway.addr.to_string(),
    ];
    let phone = Client::new(&destination(addrs, &gateway, token));
    phone.info().await.expect("the live address answers");
    assert_eq!(phone.dial_attempts(), 4, "each address tried once");
    assert_eq!(phone.dials(), 1, "one TCP connection was made");
    assert_eq!(phone.retries(), 0, "in one dial attempt, not a retry");
    assert_eq!(phone.preferred_index(), 3, "the winner is preferred");
    assert_eq!(gateway.cable().connections() - accepted, 1);

    // Kept: later calls dial nothing.
    phone.info().await.expect("again");
    assert_eq!((phone.dial_attempts(), phone.dials()), (4, 1));
    gateway.shutdown().await;
}

/// A FIRST ADDRESS THAT ACCEPTS AND NEVER SPEAKS IS OVERTAKEN: the second
/// address is dialled after the stagger and wins; the silent one is dropped.
/// The winner becomes the preferred address, so a fresh connection dials it
/// first and, answering at once, never dials the silent one again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_silent_first_address_is_overtaken_and_the_winner_is_preferred() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, _, token) = paired(&gateway).await;
    // Accepts TCP, then says nothing: a gateway whose cable is stalled, so a
    // handshake with it never answers.
    let quiet_dir = tempfile::tempdir().expect("a temp dir");
    let quiet = spawn(quiet_dir.path()).await.expect("spawned");
    quiet.cable().stall();
    let silent_addr = quiet.addr.to_string();

    let phone = Client::new(&destination(
        vec![silent_addr, gateway.addr.to_string()],
        &gateway,
        token,
    ));
    // The stagger is injected small so the test does not wait on it.
    phone.set_limits(Limits {
        stagger: Duration::from_millis(5),
        ..Limits::default()
    });
    phone.info().await.expect("the second address answers");
    assert_eq!(phone.dial_attempts(), 2, "both were dialled");
    assert_eq!(phone.dials(), 2, "both accepted TCP; one spoke");
    assert_eq!(
        phone.preferred_index(),
        1,
        "the one that spoke is preferred"
    );

    // A long stagger now: if the silent address were dialled first it would
    // hold the connection for the whole stagger, and the count below would be
    // two more.
    phone.set_limits(Limits {
        stagger: Duration::from_secs(3600),
        ..Limits::default()
    });
    phone.drop_connection().await;
    phone.head(&vault).await.ok();
    assert_eq!(
        phone.dial_attempts(),
        3,
        "only the preferred address was dialled again"
    );
    assert_eq!(phone.preferred_index(), 1);
    quiet.cable().mend();
    quiet.shutdown().await;
    gateway.shutdown().await;
}

/// A gateway whose answer to `exists` and `revoke` dies after its headers: the
/// body stream errors, the stream is reset, and the client's read fails. A
/// link that keeps dying under a request. Counts the calls it was given.
async fn flaky() -> (
    String,
    Vec<u8>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let dir = tempfile::tempdir().expect("a temp dir");
    let identity = Identity::load_or_mint(dir.path(), || GatewayId::from_bytes([9; 16]))
        .expect("a certificate");
    let listener = TlsListener::new(
        bind("127.0.0.1:0").await.expect("binds"),
        identity.server_config().expect("a TLS config"),
    )
    .expect("a TLS listener");
    let addr = listener.local().to_string();
    let calls = Arc::new(AtomicUsize::new(0));
    async fn dying(State(calls): State<Arc<AtomicUsize>>) -> Response {
        calls.fetch_add(1, Ordering::SeqCst);
        let body = axum::body::Body::from_stream(futures::stream::iter(vec![
            Ok(bytes::Bytes::from_static(b"{\"missing\":[")),
            Err(std::io::Error::other("the link died")),
        ]));
        Response::new(body)
    }
    let router = Router::new()
        .route("/v1/v/{vault}/exists", post(dying))
        .route("/v1/v/{vault}/revoke", post(dying))
        .with_state(Arc::clone(&calls));
    let cert = identity.cert_der().to_vec();
    let task = tokio::spawn(async move {
        let _keep = dir;
        let _ = run_router(listener, router, std::future::pending()).await;
    });
    (addr, cert, calls, task)
}

/// A DROPPED CONNECTION ON AN IDEMPOTENT CALL RETRIES AT MOST THREE TIMES:
/// four calls for `exists` (the call and its three repeats) and then
/// `Unreachable`; and a call that is not idempotent is sent once, because it
/// may have been applied.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_connection_retries_an_idempotent_call_three_times_and_no_more() {
    let (addr, cert, calls, task) = flaky().await;
    let vault = VaultId::from_bytes([3; 32]);
    let name = Name::from_bytes([4; 32]);
    let phone = Client::new(&Destination {
        addrs: vec![addr],
        cert_der: cert,
        token: Token::from_bytes([5; 32]),
    });
    let outcome = phone.exists(&vault, &[name]).await;
    assert!(
        matches!(outcome, Err(ClientError::Unreachable(_))),
        "{outcome:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        4,
        "the call and three repeats"
    );
    assert_eq!(phone.retries(), 3);

    let before = calls.load(Ordering::SeqCst);
    let outcome = phone.revoke(&vault).await;
    assert!(
        matches!(outcome, Err(ClientError::Unreachable(_))),
        "{outcome:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst) - before,
        1,
        "a revoke may have reached the gateway, so it is sent once"
    );
    assert_eq!(phone.retries(), 3, "no retry was spent on it");
    task.abort();
}

/// A gateway that answers `BUSY` for the first `busy` calls of `exists`, each
/// time asking for `retry_after_ms`, and then answers.
async fn busy_gateway(
    busy: usize,
    retry_after_ms: u64,
) -> (
    String,
    Vec<u8>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let dir = tempfile::tempdir().expect("a temp dir");
    let identity = Identity::load_or_mint(dir.path(), || GatewayId::from_bytes([8; 16]))
        .expect("a certificate");
    let listener = TlsListener::new(
        bind("127.0.0.1:0").await.expect("binds"),
        identity.server_config().expect("a TLS config"),
    )
    .expect("a TLS listener");
    let addr = listener.local().to_string();
    let calls = Arc::new(AtomicUsize::new(0));
    async fn exists(
        State((calls, busy, retry)): State<(Arc<AtomicUsize>, usize, u64)>,
    ) -> Response {
        if calls.fetch_add(1, Ordering::SeqCst) < busy {
            let refusal = Refusal::Busy {
                retry_after_ms: retry,
            };
            let mut response = (
                StatusCode::from_u16(Code::Busy.status()).expect("a status"),
                axum::Json(RefusalBody::of(&refusal, 1)),
            )
                .into_response();
            response
                .headers_mut()
                .insert(CODE_HEADER, axum::http::HeaderValue::from_static("BUSY"));
            return response;
        }
        axum::Json(Missing { missing: vec![] }).into_response()
    }
    let router = Router::new()
        .route("/v1/v/{vault}/exists", post(exists))
        .with_state((Arc::clone(&calls), busy, retry_after_ms));
    let cert = identity.cert_der().to_vec();
    let task = tokio::spawn(async move {
        let _keep = dir;
        let _ = run_router(listener, router, std::future::pending()).await;
    });
    (addr, cert, calls, task)
}

/// `BUSY` IS HONOURED: the call waits what the gateway asked and asks again,
/// as one of its three retries. Twice busy, then served: three calls, two
/// waits of the asked 1,234 ms (the cap is injected to zero, so the test
/// records the wait and does not sit in it).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn busy_is_honoured_with_its_retry_after_and_counted() {
    let (addr, cert, calls, task) = busy_gateway(2, 1_234).await;
    let phone = Client::new(&Destination {
        addrs: vec![addr],
        cert_der: cert,
        token: Token::from_bytes([5; 32]),
    });
    phone.set_limits(Limits {
        busy_cap: Duration::ZERO,
        ..Limits::default()
    });
    let vault = VaultId::from_bytes([3; 32]);
    let missing = phone
        .exists(&vault, &[Name::from_bytes([4; 32])])
        .await
        .expect("served after two BUSY answers");
    assert!(missing.is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(phone.busy_waits(), vec![1_234, 1_234]);
    assert_eq!(phone.retries(), 2);
    task.abort();

    // A gateway that is always busy is asked four times, no more.
    let (addr, cert, calls, task) = busy_gateway(usize::MAX, 50).await;
    let phone = Client::new(&Destination {
        addrs: vec![addr],
        cert_der: cert,
        token: Token::from_bytes([5; 32]),
    });
    phone.set_limits(Limits {
        busy_cap: Duration::ZERO,
        ..Limits::default()
    });
    let outcome = phone.exists(&vault, &[Name::from_bytes([4; 32])]).await;
    let error = outcome.expect_err("busy to the end");
    assert_eq!(error.reach(), Reach::Busy, "{error:?}");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        4,
        "the call and three retries"
    );
    task.abort();
}

/// THE TYPED REACH, from a live gateway: `ok`, `unreachable`, `untrusted`,
/// `pair_again` (a token the gateway does not know) and `too_old` (an older
/// gateway); and every error's own reach.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_reach_is_typed() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone, token) = paired(&gateway).await;
    assert_eq!(
        phone.reach(Some(&vault)).await,
        Reach::Ok,
        "paired, no head yet"
    );

    let stranger = Client::new(&destination(
        vec![gateway.addr.to_string()],
        &gateway,
        Token::from_bytes([0xee; 32]),
    ));
    assert_eq!(stranger.reach(Some(&vault)).await, Reach::PairAgain);

    let wrong_pin =
        Client::first_contact(vec![gateway.addr.to_string()], Pin::from_bytes([0x11; 32]));
    assert_eq!(wrong_pin.reach(None).await, Reach::Untrusted);

    let nowhere = Client::new(&destination(vec![dead_address().await], &gateway, token));
    assert_eq!(nowhere.reach(Some(&vault)).await, Reach::Unreachable);
    gateway.shutdown().await;

    // An older gateway, played by a stub.
    let dir = tempfile::tempdir().expect("a temp dir");
    let identity = Identity::load_or_mint(dir.path(), || GatewayId::from_bytes([5; 16]))
        .expect("a certificate");
    let listener = TlsListener::new(
        bind("127.0.0.1:0").await.expect("binds"),
        identity.server_config().expect("a TLS config"),
    )
    .expect("a TLS listener");
    let addr = listener.local().to_string();
    let router = Router::new().fallback(any(|| async {
        axum::Json(serde_json::json!({
            "gateway_id": "05050505050505050505050505050505",
            "protocol": 0,
            "time_ms": 1
        }))
    }));
    let server = tokio::spawn(run_router(listener, router, std::future::pending()));
    let old = Client::trusting(vec![addr], identity.cert_der().to_vec());
    assert_eq!(old.reach(None).await, Reach::TooOld);
    server.abort();

    // What every kind of error means.
    for (error, reach) in [
        (ClientError::Unreachable(String::new()), Reach::Unreachable),
        (ClientError::Untrusted, Reach::Untrusted),
        (ClientError::Unverified("the head"), Reach::Untrusted),
        (
            ClientError::GatewayTooOld {
                found: 0,
                required: 1,
            },
            Reach::TooOld,
        ),
        (ClientError::NoToken, Reach::PairAgain),
        (
            ClientError::Refused(Refusal::Unauthorized),
            Reach::PairAgain,
        ),
        (
            ClientError::Refused(Refusal::Frozen { since_ms: 1 }),
            Reach::Frozen,
        ),
        (
            ClientError::Refused(Refusal::Busy { retry_after_ms: 1 }),
            Reach::Busy,
        ),
        (
            ClientError::Refused(Refusal::NotFound { name: None }),
            Reach::Ok,
        ),
    ] {
        assert_eq!(error.reach(), reach, "{error:?}");
    }
}
