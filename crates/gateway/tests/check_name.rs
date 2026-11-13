//! **CHECK THIS NAME** (#1191, decision 34): the vault key's signed request that the gateway hash
//! one stored object against its recorded digest. A rotted object is marked damaged (a signed
//! delete then frees it at once and a re-sealed `PUT` is a first write); an intact one is left
//! exactly as it was. A token alone is refused, a replay is refused, a frozen vault refuses it,
//! and a vault may have only a pass's sample size checked in a window.

use centraid_gateway::client::{Client, ClientError};
use centraid_gateway::rules::code::Refusal;
use centraid_gateway::rules::ids::{Digest, Name, Signature, VaultId};
use centraid_gateway::rules::limits::MAX_CHECKS_PER_WINDOW;
use centraid_gateway::rules::signing::{sign_check, sign_delete};
use centraid_gateway::rules::wire::{CheckRequest, CheckState, DeleteRequest};
use centraid_gateway::server::harness::{Spawned, pair_secret, spawn};
use centraid_gateway::server::operator::{self, Verb};

struct Member {
    key: ed25519_dalek::SigningKey,
    vault: VaultId,
    phone: Client,
    generation: u64,
    gateway: centraid_gateway::rules::ids::GatewayId,
}

async fn member(gateway: &Spawned) -> Member {
    let key = ed25519_dalek::SigningKey::from_bytes(&[31; 32]);
    let paired = pair_secret(
        &gateway.first_contact(),
        &key,
        "a phone",
        gateway.mint_pairing_secret(),
    )
    .await
    .expect("pairs");
    Member {
        vault: VaultId::from_bytes(key.verifying_key().to_bytes()),
        phone: gateway.client(paired.token),
        key,
        generation: 0,
        gateway: gateway.gateway_id,
    }
}

fn bytes_of(label: &str) -> Vec<u8> {
    blake3::hash(label.as_bytes()).as_bytes().repeat(4)
}

fn name_of(label: &str) -> Name {
    Name::from_bytes(blake3::derive_key("check test name", label.as_bytes()))
}

impl Member {
    async fn stores(&self, label: &str) -> Name {
        let name = name_of(label);
        let bytes = bytes_of(label);
        self.phone
            .put(&self.vault, &name, &Digest::of(&bytes), bytes)
            .await
            .expect("stores");
        name
    }

    fn check_request(&mut self, name: &Name) -> CheckRequest {
        self.generation += 1;
        CheckRequest {
            name: *name,
            generation: self.generation,
            signature: sign_check(&self.key, &self.gateway, 1, self.generation, name),
        }
    }

    async fn check(&mut self, name: &Name) -> Result<CheckState, ClientError> {
        let request = self.check_request(name);
        self.phone
            .check(&self.vault, &request)
            .await
            .map(|checked| checked.state)
    }

    async fn delete(&mut self, name: &Name) -> centraid_gateway::rules::wire::DeleteAnswer {
        self.generation += 1;
        let request = DeleteRequest {
            names: vec![*name],
            generation: self.generation,
            signature: sign_delete(&self.key, &self.gateway, 1, self.generation, &[*name]),
        };
        self.phone
            .delete(&self.vault, &request)
            .await
            .expect("deletes")
    }
}

fn refusal(error: ClientError) -> Refusal {
    match error {
        ClientError::Refused(refusal) => refusal,
        other => panic!("a refusal was expected: {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rotted_part_is_marked_damaged_freed_by_a_signed_delete_and_resealed() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let mut member = member(&gateway).await;
    let name = member.stores("rotted").await;
    gateway.corrupt(&member.vault, &name).expect("rots it");
    assert_eq!(
        member.check(&name).await.expect("checks"),
        CheckState::Damaged
    );
    let answer = member.delete(&name).await;
    assert_eq!(answer.freed, vec![name], "a damaged name is freed at once");
    let resealed = bytes_of("resealed");
    member
        .phone
        .put(&member.vault, &name, &Digest::of(&resealed), resealed)
        .await
        .expect("a re-sealed copy is a first write");
    assert_eq!(
        member.check(&name).await.expect("checks"),
        CheckState::Intact
    );
    gateway.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_intact_part_is_left_exactly_as_it_was() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let mut member = member(&gateway).await;
    let name = member.stores("sound").await;
    assert_eq!(
        member.check(&name).await.expect("checks"),
        CheckState::Intact
    );
    // IT IS STILL LIVE: a signed delete holds it (and does not free it).
    let answer = member.delete(&name).await;
    assert_eq!(answer.deleted, vec![name]);
    assert!(answer.freed.is_empty(), "an intact name is held, not freed");
    assert_eq!(
        member
            .check(&name_of("never stored"))
            .await
            .expect("checks"),
        CheckState::Missing
    );
    gateway.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_token_alone_a_replay_or_another_signature_is_refused() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let mut member = member(&gateway).await;
    let name = member.stores("guarded").await;
    gateway.corrupt(&member.vault, &name).expect("rots it");

    let generation = member.generation + 1;
    for (what, signature) in [
        ("an empty signature", Signature::from_bytes([0; 64])),
        (
            "a delete's signature",
            sign_delete(&member.key, &member.gateway, 1, generation, &[name]),
        ),
        (
            "another key's signature",
            sign_check(
                &ed25519_dalek::SigningKey::from_bytes(&[9; 32]),
                &member.gateway,
                1,
                generation,
                &name,
            ),
        ),
        (
            "a check of another name",
            sign_check(
                &member.key,
                &member.gateway,
                1,
                generation,
                &name_of("other"),
            ),
        ),
    ] {
        let request = CheckRequest {
            name,
            generation,
            signature,
        };
        let error = member
            .phone
            .check(&member.vault, &request)
            .await
            .expect_err(what);
        assert!(
            matches!(refusal(error), Refusal::Unauthorized),
            "{what} is refused"
        );
    }

    // A REPLAY of a check the gateway answered is refused: the counter has moved past it.
    let request = member.check_request(&name);
    member
        .phone
        .check(&member.vault, &request)
        .await
        .expect("the first goes through");
    let replay = member
        .phone
        .check(&member.vault, &request)
        .await
        .expect_err("a replay");
    assert!(matches!(refusal(replay), Refusal::OutOfOrder { .. }));
    gateway.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_frozen_vault_refuses_a_check() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let mut member = member(&gateway).await;
    let name = member.stores("frozen").await;
    let vault = operator::resolve(gateway.shared(), &member.vault.hex()[..8]).expect("resolves");
    operator::run(gateway.shared(), &vault, Verb::Freeze, false).expect("freezes");
    let error = member.check(&name).await.expect_err("frozen");
    assert!(matches!(refusal(error), Refusal::Frozen { .. }));
    gateway.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn more_checks_than_a_pass_samples_are_told_busy() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let mut member = member(&gateway).await;
    let name = member.stores("busy").await;
    for _ in 0..MAX_CHECKS_PER_WINDOW {
        member.check(&name).await.expect("within the cap");
    }
    let error = member.check(&name).await.expect_err("past the cap");
    assert!(matches!(refusal(error), Refusal::Busy { .. }));
    gateway.shutdown().await;
}
