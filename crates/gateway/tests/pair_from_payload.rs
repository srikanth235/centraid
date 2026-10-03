//! A phone pairs from the text of a QR, keeps what it learned, and hands an
//! upload to someone else to perform (#1080).
//!
//! The QR's text is what `pair` prints; the phone parses it, dials the
//! addresses trusting the pin, pairs with the secret, and stores a
//! [`Destination`]: the addresses, the certificate's bytes and the token.
//! Every later contact trusts those bytes. `presign_put` then prepares a
//! `PUT` the way the iPhone's background session will perform it — URL,
//! method, headers, a file as the body — and this test performs it with a bare
//! HTTP client, not ours, so the handoff is proved complete on its own.

use bytes::Bytes;
use centraid_gateway::client::tls::{Trust, client_config};
use centraid_gateway::client::{Client, ClientError};
use centraid_gateway::rules::code::Refusal;
use centraid_gateway::rules::ids::{Digest, Name, VaultId};
use centraid_gateway::rules::payload::PairPayload;
use centraid_gateway::rules::wire::{PairKind, PairRequest};
use centraid_gateway::server::harness::spawn;
use http_body_util::{BodyExt as _, Full};
use hyper_util::rt::TokioIo;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::pki_types::ServerName;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_phone_pairs_from_the_text_of_a_qr_and_hands_off_an_upload() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");

    // What `pair` prints, and what the camera reads back.
    let printed = gateway.payload().to_json();
    let payload = PairPayload::parse(&printed).expect("the QR's text parses");
    assert_eq!(payload.gw, gateway.gateway_id);
    assert_eq!(payload.pin, gateway.pin);

    let phone = Client::first_contact(payload.addrs.clone(), payload.pin);
    let info = phone.info().await.expect("the pinned gateway answers");
    assert_eq!(info.gateway_id, payload.gw, "the QR and the gateway agree");

    let identity = ed25519_dalek::SigningKey::from_bytes(&[3; 32]);
    let vault = VaultId::from_bytes(identity.verifying_key().to_bytes());
    let paired = phone
        .pair(&PairRequest {
            vault_id: vault,
            label: "Ada's phone".to_owned(),
            kind: PairKind::Secret,
            secret: Some(payload.secret),
            claim: None,
            read: None,
        })
        .await
        .expect("pairs");
    assert_eq!((paired.epoch, paired.gateway_id), (1, payload.gw));

    // What the ledger keeps, and a later contact trusting exactly those bytes.
    let destination = phone
        .destination()
        .expect("certificate and token are known");
    assert_eq!(destination.cert_der, gateway.cert_der);
    assert_eq!(destination.token, paired.token);
    let later = Client::new(&destination);
    let state = later.head_state(&vault).await.expect("reads");
    assert_eq!((state.epoch, state.head), (1, None));

    // The same secret, again: spent.
    assert!(matches!(
        Client::first_contact(payload.addrs.clone(), payload.pin)
            .pair(&PairRequest {
                vault_id: VaultId::from_bytes(
                    ed25519_dalek::SigningKey::from_bytes(&[4; 32])
                        .verifying_key()
                        .to_bytes()
                ),
                label: String::new(),
                kind: PairKind::Secret,
                secret: Some(payload.secret),
                claim: None,
                read: None,
            })
            .await,
        Err(ClientError::Refused(Refusal::Unauthorized))
    ));

    // The handoff, performed by a client that is not ours.
    let sealed = b"a sealed part the OS uploads while the app sleeps".to_vec();
    let name = Name::from_bytes([0x42; 32]);
    let digest = Digest::of(&sealed);
    let handoff = later
        .presign_put(&vault, &name, &digest, sealed.len() as u64)
        .expect("prepared");
    assert_eq!(handoff.method, "PUT");
    let rest = handoff.url.strip_prefix("https://").expect("https");
    let (authority, path) = rest.split_at(rest.find('/').expect("a path"));
    assert_eq!(authority, gateway.addr.to_string());
    assert_eq!(path, format!("/v2/v/{vault}/o/{name}"));

    let socket = tokio::net::TcpStream::connect(authority)
        .await
        .expect("connects");
    let tls = TlsConnector::from(client_config(Trust::Certificate(gateway.cert_der.clone())))
        .connect(ServerName::try_from("localhost").expect("a name"), socket)
        .await
        .expect("handshakes");
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
        .await
        .expect("speaks HTTP/1.1");
    tokio::spawn(connection);
    let mut request = hyper::Request::builder()
        .method(handoff.method.as_str())
        .uri(path)
        .header("host", authority);
    for (header, value) in &handoff.headers {
        request = request.header(header.as_str(), value.as_str());
    }
    let response = sender
        .send_request(
            request
                .body(Full::new(Bytes::from(sealed.clone())))
                .expect("a request"),
        )
        .await
        .expect("answered");
    assert_eq!(response.status(), 201, "the handoff stored the object");
    let _ = response.into_body().collect().await;

    let stored = later.get(&vault, &name, None).await.expect("reads back");
    assert_eq!(stored, sealed);
    assert!(
        later
            .exists(&vault, &[name])
            .await
            .expect("exists")
            .is_empty()
    );

    gateway.shutdown().await;
}

/// THE TERMINAL HEARS A PAIRING AS IT LANDS, with the safety number a member
/// may compare against the phone's (the root's ruling A7): the event names the
/// vault, how it paired and at which epoch, and the line `serve` prints for it
/// is the safety line over that vault and this gateway's pin.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_landed_pairing_is_announced_with_its_safety_line() {
    use std::sync::{Arc, Mutex};

    use centraid_gateway::server::harness::spawn_with;
    use centraid_gateway::server::{Event, report};

    let heard: Arc<Mutex<Vec<Event>>> = Arc::default();
    let ear = Arc::clone(&heard);
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn_with(
        dir.path(),
        Some(Arc::new(move |event: &Event| {
            ear.lock().expect("the ear").push(event.clone());
        })),
    )
    .await
    .expect("spawned");
    let payload = gateway.payload();
    let identity = ed25519_dalek::SigningKey::from_bytes(&[5; 32]);
    let vault = VaultId::from_bytes(identity.verifying_key().to_bytes());
    Client::first_contact(payload.addrs.clone(), payload.pin)
        .pair(&PairRequest {
            vault_id: vault,
            label: "Ada's phone".to_owned(),
            kind: PairKind::Secret,
            secret: Some(payload.secret),
            claim: None,
            read: None,
        })
        .await
        .expect("pairs");
    let events = heard.lock().expect("the ear").clone();
    assert_eq!(
        events,
        vec![Event::Paired {
            vault,
            kind: PairKind::Secret,
            epoch: 1,
            label: "Ada's phone".to_owned(),
        }]
    );
    let lines = report::event_lines(&events[0], &gateway.pin);
    assert_eq!(lines[1], report::safety_line(&vault, &gateway.pin));
    gateway.shutdown().await;
}
