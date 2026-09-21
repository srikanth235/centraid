//! TWO HOUSEHOLD MEMBERS ON ONE SERVER, AND NEITHER CAN REACH THE OTHER'S
//! BYTES (Q13, #1029 §3).
//!
//! This is the claim self-hosting rests on: a household buys one box and puts
//! everybody's vault on it, so "multi-tenant" here is not an enterprise feature
//! but the ordinary case. It is also the claim a type system cannot make —
//! `object` is keyed by `(vault_key, name)` and two households can legitimately
//! hold the same object, so a read that forgot the vault would serve one
//! member's ciphertext to another and every type in the crate would be
//! satisfied.
//!
//! So it is tested against a **live server over a real socket**, with real
//! device certificates and real signatures, on all three verbs a phone has for
//! an object: read it, ask whether it is there, and delete it.
//!
//! `src/sql.rs` carries the same claim as a scan over the statements. Both are
//! wanted: the scan catches a query written wrong, this catches a route that
//! never asked.

use centraid_gateway_core::Gateway;
use centraid_gateway_core::ids::{Key32, ObjectKind, ObjectName, VaultId};
use centraid_gateway_core::plan::Plan;
use centraid_gateway_core::retention::Policy;
use centraid_gateway_core::store::StateStore as _;
use centraid_gateway_server::bytes::ProxyWrite as _;
use centraid_gateway_server::bytes::configured::{Backend, ConfiguredBytes};
use centraid_gateway_server::bytes::fs::FilesystemBytes;
use centraid_gateway_server::config::Config;
use centraid_gateway_server::http::{
    CERTIFICATE_HEADER, PROTOCOL_HEADER, SIGNATURE_HEADER, Server, TIMESTAMP_HEADER,
};
use centraid_gateway_server::state::{SqliteState, register};
use centraid_gateway_server::{clock, serve};
use centraid_identity::{DeviceCertificate, Epoch, RecoveryPhrase, VaultIdentityKey};
use ed25519_dalek::{Signer as _, SigningKey};

/// One household member: their vault's identity key and one phone.
struct Member {
    identity: VaultIdentityKey,
    device: SigningKey,
    certificate: Vec<u8>,
    vault: VaultId,
}

impl Member {
    fn new(index: u32, device_seed: u8) -> Self {
        // Two different vaults of ONE account's seed, which is exactly the
        // household shape: `seed / vault'(i) / identity'`, and a vault index is
        // never reused (F2).
        let phrase = RecoveryPhrase::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon art",
        )
        .expect("a valid recovery phrase");
        let keys = centraid_identity::derive::restore_vault_keys(&phrase.seed(), index)
            .expect("vault keys");
        let device = SigningKey::from_bytes(&[device_seed; 32]);
        let certificate =
            DeviceCertificate::issue(&keys.identity, &device.verifying_key(), Epoch::new(1));
        Self {
            vault: Key32::from_bytes(keys.identity.public().to_bytes()),
            identity: keys.identity,
            certificate: certificate.to_bytes().to_vec(),
            device,
        }
    }

    /// The headers a signed request carries.
    ///
    /// `path` is the **signed** path — which may deliberately not be this
    /// member's own, because that is the attack under test.
    fn headers(&self, method: &str, path: &str, body: &[u8]) -> Vec<(String, String)> {
        let now = clock::now().millis();
        let request = centraid_gateway_core::auth::SignedRequest {
            method,
            path,
            body_digest: *blake3::hash(body).as_bytes(),
            timestamp_ms: now,
            protocol: centraid_gateway_core::PROTOCOL_MIN,
            certificate_bytes: &self.certificate,
            signature: &[],
        };
        let signature = self
            .device
            .sign(&centraid_gateway_core::auth::preimage(&request));
        vec![
            (
                CERTIFICATE_HEADER.to_owned(),
                hex::encode(&self.certificate),
            ),
            (
                SIGNATURE_HEADER.to_owned(),
                hex::encode(signature.to_bytes()),
            ),
            (TIMESTAMP_HEADER.to_owned(), now.to_string()),
            (
                PROTOCOL_HEADER.to_owned(),
                centraid_gateway_core::PROTOCOL_MIN.to_string(),
            ),
        ]
    }
}

struct Live {
    origin: String,
    client: reqwest::Client,
    /// Kept alive for the life of the server.
    _objects: tempfile::TempDir,
}

/// Bring up a real server with two registered vaults, each holding one object.
async fn two_tenants() -> (Live, Member, Member, ObjectName, ObjectName) {
    let alice = Member::new(0, 0xA1);
    let bob = Member::new(1, 0xB0);

    let objects = tempfile::tempdir().expect("a temporary object directory");
    let mut state = SqliteState::in_memory().expect("a state file");
    for member in [&alice, &bob] {
        register(
            &mut state,
            member.vault,
            Key32::from_bytes(member.identity.public().to_bytes()),
            Plan::active(1_024 * 1_024 * 1_024),
            false,
        )
        .await
        .expect("a registered vault");
    }

    let bytes = ConfiguredBytes::new(Backend::Filesystem(
        FilesystemBytes::open(objects.path(), "").expect("an object directory"),
    ));
    let mut gateway = Gateway::new(state, bytes, Policy::default());

    // One object each, landed straight into the stores and the index — this
    // test is about who may READ them, and the commit path is the conformance
    // suite's subject.
    let alice_bytes = b"ciphertext that is alice's".to_vec();
    let bob_bytes = b"ciphertext that is bob's".to_vec();
    let alice_object = ObjectName::of(&alice_bytes);
    let bob_object = ObjectName::of(&bob_bytes);
    for (member, blob, name) in [
        (&alice, &alice_bytes, alice_object),
        (&bob, &bob_bytes, bob_object),
    ] {
        gateway
            .bytes
            .write(&member.vault, &name, blob.clone())
            .await
            .expect("stored");
        gateway
            .state
            .put_object(
                &member.vault,
                &centraid_gateway_core::store::StoredObject {
                    name,
                    kind: ObjectKind::Blob,
                    padded_size: blob.len() as u64,
                    state: centraid_gateway_core::store::ObjectState::Committed,
                    received_at: clock::now(),
                    generation: centraid_gateway_core::engine::zero_generation(),
                },
            )
            .await
            .expect("indexed");
    }

    let bound = serve::bind("127.0.0.1:0").await.expect("a free port");
    let origin = format!("http://{}", bound.address);
    let shared = serve::shared(Server {
        gateway,
        config: Config::defaults(objects.path(), &origin),
    });
    tokio::spawn(async move {
        let _ = serve::serve_plain(bound, shared).await;
    });

    (
        Live {
            origin,
            client: reqwest::Client::new(),
            _objects: objects,
        },
        alice,
        bob,
        alice_object,
        bob_object,
    )
}

async fn request(
    live: &Live,
    member: &Member,
    method: reqwest::Method,
    path: &str,
    body: Vec<u8>,
) -> reqwest::Response {
    let mut request = live
        .client
        .request(method.clone(), format!("{}{path}", live.origin));
    for (name, value) in member.headers(method.as_str(), path, &body) {
        request = request.header(name, value);
    }
    request.body(body).send().await.expect("a response")
}

fn object_path(vault: VaultId, name: ObjectName) -> String {
    format!("/v1/objects/{}/{}", vault.hex(), name.hex())
}

/// A MEMBER READS THEIR OWN OBJECT, which is the control: without it the test
/// below would pass against a server that refused everybody.
#[tokio::test]
async fn a_member_can_read_their_own_object() {
    let (live, alice, _bob, alice_object, _) = two_tenants().await;
    let response = request(
        &live,
        &alice,
        reqwest::Method::GET,
        &object_path(alice.vault, alice_object),
        Vec::new(),
    )
    .await;
    assert!(response.status().is_success(), "{:?}", response.status());
    assert_eq!(
        response.bytes().await.expect("a body").as_ref(),
        b"ciphertext that is alice's"
    );
}

/// **ONE TENANT CANNOT READ ANOTHER'S OBJECT.** Alice signs, correctly, for
/// Bob's path; the signature verifies and the request is still refused, because
/// the certificate names Alice's vault and the path names Bob's.
#[tokio::test]
async fn one_tenant_cannot_read_anothers_object() {
    let (live, alice, bob, _, bob_object) = two_tenants().await;
    let response = request(
        &live,
        &alice,
        reqwest::Method::GET,
        &object_path(bob.vault, bob_object),
        Vec::new(),
    )
    .await;
    assert_eq!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "alice read bob's object"
    );
    let body = response.text().await.expect("a body");
    assert!(
        !body.contains("ciphertext"),
        "the refusal carried bytes: {body}"
    );
    // A STRANGER AND AN UNREGISTERED VAULT ARE THE SAME REFUSAL, so the answer
    // does not tell Alice whether Bob has a vault here at all.
    assert!(body.contains("Unauthorized"), "{body}");
}

/// The same for the write half of the proxy: Alice cannot put bytes under Bob's
/// prefix, which would be a way to fill a housemate's quota or to overwrite.
#[tokio::test]
async fn one_tenant_cannot_write_under_anothers_prefix() {
    let (live, alice, bob, _, _) = two_tenants().await;
    let planted = b"bytes alice wants in bob's store".to_vec();
    let name = ObjectName::of(&planted);
    let response = request(
        &live,
        &alice,
        reqwest::Method::PUT,
        &object_path(bob.vault, name),
        planted,
    )
    .await;
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);

    // And nothing landed: Bob's own read of that name finds nothing.
    let check = request(
        &live,
        &bob,
        reqwest::Method::GET,
        &object_path(bob.vault, name),
        Vec::new(),
    )
    .await;
    assert_eq!(check.status(), reqwest::StatusCode::NOT_FOUND);
}

/// And for the delete verb, which is the one whose damage is not recoverable
/// from the phone.
#[tokio::test]
async fn one_tenant_cannot_delete_anothers_object() {
    let (live, alice, bob, _, bob_object) = two_tenants().await;
    let body = serde_json::to_vec(&serde_json::json!({
        "objects": [bob_object.hex()],
        "member_confirmed_shrink": true,
    }))
    .expect("a request body");
    let response = request(
        &live,
        &alice,
        reqwest::Method::POST,
        &format!("/v1/vaults/{}/delete", bob.vault.hex()),
        body,
    )
    .await;
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);

    // Bob's object is still there and still readable by Bob.
    let check = request(
        &live,
        &bob,
        reqwest::Method::GET,
        &object_path(bob.vault, bob_object),
        Vec::new(),
    )
    .await;
    assert!(check.status().is_success());
}

/// A REQUEST SIGNED FOR ONE PATH AND SENT TO ANOTHER IS REFUSED. Without this,
/// the isolation above could be walked around by replaying one's own valid
/// signature against a neighbour's URL.
#[tokio::test]
async fn a_signature_does_not_travel_between_paths() {
    let (live, alice, bob, alice_object, bob_object) = two_tenants().await;
    // Signed for Alice's own object, sent to Bob's.
    let signed_for = object_path(alice.vault, alice_object);
    let sent_to = object_path(bob.vault, bob_object);
    let mut request = live.client.get(format!("{}{sent_to}", live.origin));
    for (name, value) in alice.headers("GET", &signed_for, &[]) {
        request = request.header(name, value);
    }
    let response = request.send().await.expect("a response");
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
}
