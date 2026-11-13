//! `head_state` TRUSTS NOTHING A GATEWAY SAYS ABOUT THE EPOCH (#1191, C6).
//!
//! The client verifies the head's signature and the standing claim's against
//! the vault's key and the gateway id the phone learned at pairing, and only
//! then takes the greater epoch. A stub gateway answers `GET head` with a
//! genuine signed head and claim, and then with each field lied about in turn,
//! and the wrong gateway's id, and the wrong vault: every lie is a typed
//! `Unverified`, the genuine answer is believed.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::response::IntoResponse as _;
use axum::routing::get;
use centraid_gateway::client::{Client, ClientError};
use centraid_gateway::rules::ids::{GatewayId, Name, Nonce, Signature, Token, VaultId};
use centraid_gateway::rules::signing::{HeadFields, sign_claim, sign_head};
use centraid_gateway::rules::wire::{ClaimView, HeadView};
use centraid_gateway::server::serve::{TlsListener, bind, run_router};
use centraid_gateway::server::tls::Identity;

fn genuine(key: &ed25519_dalek::SigningKey, gateway: &GatewayId) -> HeadView {
    let manifest = Name::from_bytes([3; 32]);
    let fields = HeadFields {
        epoch: 2,
        generation: 5,
        writes: 9,
        taken_at_ms: 1_000,
        manifest,
        prev: Some(Name::from_bytes([4; 32])),
    };
    let nonce = Nonce::from_bytes([6; 40]);
    HeadView {
        name: manifest,
        prev: fields.prev,
        taken_at_ms: 1_000,
        epoch: 2,
        generation: 5,
        writes: 9,
        set_at_ms: 77,
        signature: sign_head(key, gateway, &fields),
        claim: Some(ClaimView {
            epoch: 3,
            head_seen: Some(manifest),
            nonce,
            signature: sign_claim(key, gateway, 3, Some(&manifest), &nonce),
        }),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gateway_that_lies_in_any_field_is_not_believed() {
    let key = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
    let vault = VaultId::from_bytes(key.verifying_key().to_bytes());
    let gateway = GatewayId::from_bytes([5; 16]);
    let head = genuine(&key, &gateway);

    let dir = tempfile::tempdir().expect("a temp dir");
    let identity =
        Identity::load_or_mint(dir.path(), || GatewayId::from_bytes([1; 16])).expect("identity");
    let listener = TlsListener::new(
        bind("127.0.0.1:0").await.expect("binds"),
        identity.server_config().expect("TLS"),
    )
    .expect("listener");
    let addr = listener.local();
    let serving: Arc<Mutex<HeadView>> = Arc::new(Mutex::new(head));
    let answer = Arc::clone(&serving);
    let router = Router::new().route(
        "/v3/v/{vault}/head",
        get(move || {
            let answer = Arc::clone(&answer);
            async move { axum::Json(*answer.lock().expect("answer")).into_response() }
        }),
    );
    let server = tokio::spawn(run_router(listener, router, std::future::pending()));
    let phone = Client::trusting(vec![addr.to_string()], identity.cert_der().to_vec());
    phone.set_token(Token::from_bytes([7; 32]));

    // The truth is believed, and the epoch is the greater verified one.
    let state = phone.head_state(&vault, &gateway).await.expect("believed");
    assert_eq!(state.epoch, 3, "the claim's epoch is above the head's");

    let flip = |signature: Signature| {
        let mut bytes = *signature.as_bytes();
        bytes[0] ^= 1;
        Signature::from_bytes(bytes)
    };
    type Lie = (&'static str, Box<dyn Fn(&mut HeadView)>);
    let lies: Vec<Lie> = vec![
        ("name", Box::new(|h| h.name = Name::from_bytes([8; 32]))),
        ("prev", Box::new(|h| h.prev = None)),
        ("taken_at_ms", Box::new(|h| h.taken_at_ms += 1)),
        ("epoch", Box::new(|h| h.epoch = 99)),
        ("generation", Box::new(|h| h.generation += 1)),
        ("writes", Box::new(|h| h.writes += 1)),
        (
            "signature",
            Box::new(move |h| h.signature = flip(h.signature)),
        ),
        (
            "claim epoch",
            Box::new(|h| {
                if let Some(c) = h.claim.as_mut() {
                    c.epoch = 99
                }
            }),
        ),
        (
            "claim head_seen",
            Box::new(|h| {
                if let Some(c) = h.claim.as_mut() {
                    c.head_seen = None
                }
            }),
        ),
        (
            "claim nonce",
            Box::new(|h| {
                if let Some(c) = h.claim.as_mut() {
                    c.nonce = Nonce::from_bytes([0; 40])
                }
            }),
        ),
        (
            "claim signature",
            Box::new(move |h| {
                if let Some(c) = h.claim.as_mut() {
                    c.signature = flip(c.signature)
                }
            }),
        ),
    ];
    for (field, lie) in &lies {
        let mut lied = head;
        lie(&mut lied);
        *serving.lock().expect("answer") = lied;
        match phone.head_state(&vault, &gateway).await {
            Err(ClientError::Unverified(_)) => {}
            other => panic!("a lie in {field} was believed: {other:?}"),
        }
    }

    // The right answer for another gateway, or another vault, is a lie here.
    *serving.lock().expect("answer") = head;
    let other_gateway = GatewayId::from_bytes([6; 16]);
    assert!(matches!(
        phone.head_state(&vault, &other_gateway).await,
        Err(ClientError::Unverified(_))
    ));
    let other_vault = VaultId::from_bytes(
        ed25519_dalek::SigningKey::from_bytes(&[10; 32])
            .verifying_key()
            .to_bytes(),
    );
    assert!(matches!(
        phone.head_state(&other_vault, &gateway).await,
        Err(ClientError::Unverified(_))
    ));
    server.abort();
}
