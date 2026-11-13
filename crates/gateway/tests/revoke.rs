//! A TOKEN IS REVOKED, BY THE PHONE THAT HOLDS IT OR BY THE OPERATOR, AND IS A
//! STRANGER AFTER (#1080, the audit's finding 2).
//!
//! The conformance suite's `auth/a-revoked-token-is-unauthorized-everywhere`
//! holds the route over the wire; this file holds the two halves around it:
//! the client's own `revoke`, and `pairings revoke <id>`'s path, which revokes
//! by the id `pairings` prints for the phone that is lost and cannot revoke
//! itself.

use centraid_gateway::client::{Client, ClientError};
use centraid_gateway::rules::Refusal;
use centraid_gateway::rules::ids::{Digest, Name, Token, VaultId};

use centraid_gateway::server::harness::pair_secret;
use centraid_gateway::server::harness::{Spawned, spawn};
use centraid_gateway::server::report;

async fn paired(gateway: &Spawned, seed: u8) -> (VaultId, Client, Token) {
    let identity = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    let vault = VaultId::from_bytes(identity.verifying_key().to_bytes());
    let paired = pair_secret(
        &gateway.first_contact(),
        &identity,
        "a phone".to_owned(),
        gateway.mint_pairing_secret(),
    )
    .await
    .expect("pairs");
    (vault, gateway.client(paired.token), paired.token)
}

fn object(seed: &str) -> (Name, Vec<u8>) {
    let name = Name::from_bytes(blake3::derive_key(
        "centraid gateway revoke name",
        seed.as_bytes(),
    ));
    (name, blake3::hash(seed.as_bytes()).as_bytes().repeat(8))
}

fn unauthorized<T: std::fmt::Debug>(answer: Result<T, ClientError>, what: &str) {
    assert!(
        matches!(answer, Err(ClientError::Refused(Refusal::Unauthorized))),
        "{what}: {answer:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_phone_revokes_its_own_token_and_its_put_and_get_are_refused() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone, _) = paired(&gateway, 3).await;
    let (name, bytes) = object("before");
    phone
        .put(&vault, &name, &Digest::of(&bytes), bytes.clone())
        .await
        .expect("stores");

    assert!(phone.revoke(&vault).await.expect("revokes").revoked);

    let (late, late_bytes) = object("after");
    unauthorized(
        phone
            .put(&vault, &late, &Digest::of(&late_bytes), late_bytes.clone())
            .await,
        "a revoked token's put",
    );
    unauthorized(
        phone.get(&vault, &name, None).await,
        "a revoked token's get",
    );
    unauthorized(phone.revoke(&vault).await, "a second revoke");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_operator_revokes_a_lost_phone_by_the_id_pairings_prints() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, lost, token) = paired(&gateway, 4).await;
    let (_, kept, _) = paired(&gateway, 5).await;
    let (name, bytes) = object("the lost phone's");
    lost.put(&vault, &name, &Digest::of(&bytes), bytes.clone())
        .await
        .expect("stores");

    // The id `pairings` prints, and the one token it names.
    let pairings = gateway
        .shared()
        .rules(|rules| rules.pairings())
        .expect("lists");
    let id = report::token_id(&token.hash());
    let printed: Vec<String> = pairings
        .iter()
        .flat_map(|pairing| report::pairing_lines(pairing, &gateway.pin))
        .collect();
    assert!(
        printed.iter().any(|line| line.contains(&id)),
        "`pairings` prints the id: {printed:#?}"
    );
    let named: Vec<_> = pairings
        .iter()
        .flat_map(|pairing| pairing.tokens.iter())
        .filter(|record| record.hash.hex().starts_with(&id))
        .collect();
    assert_eq!(named.len(), 1, "the id names one token");

    let hash = named[0].hash;
    assert!(
        gateway
            .shared()
            .rules(|rules| rules.revoke_hash(&hash))
            .expect("revokes")
    );
    unauthorized(lost.get(&vault, &name, None).await, "the lost phone's get");
    unauthorized(
        lost.put(&vault, &name, &Digest::of(&bytes), bytes.clone())
            .await,
        "the lost phone's put",
    );
    let other = VaultId::from_bytes(
        ed25519_dalek::SigningKey::from_bytes(&[5; 32])
            .verifying_key()
            .to_bytes(),
    );
    kept.objects(&other, None, 10)
        .await
        .expect("another vault's phone is untouched");
}

/// A TOKEN REVOKED ON PURPOSE IS UNAUTHORIZED, NOT MOVED (#1191, E5): no claim
/// backs it, so it leaves no tombstone and hears nothing about a takeover.
/// Both ways to revoke: the phone's `POST revoke` and the operator's
/// `pairings revoke`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_token_revoked_on_purpose_is_unauthorised_not_moved() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, own, _) = paired(&gateway, 6).await;
    own.revoke(&vault).await.expect("revokes itself");
    unauthorized(own.objects(&vault, None, 10).await, "after its own revoke");

    let (other_vault, lost, token) = paired(&gateway, 7).await;
    let hash = token.hash();
    assert!(
        gateway
            .shared()
            .rules(|rules| rules.revoke_hash(&hash))
            .expect("revokes")
    );
    unauthorized(
        lost.objects(&other_vault, None, 10).await,
        "after the operator's revoke",
    );
    for vault in [vault, other_vault] {
        let tombstones = gateway
            .shared()
            .rules(|rules| Ok(rules.state.revoked_count(&vault)?))
            .expect("counts");
        assert_eq!(tombstones, 0, "a revoke on purpose leaves no tombstone");
    }
}
