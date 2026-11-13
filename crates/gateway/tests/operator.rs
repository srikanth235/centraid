//! THE OPERATOR'S VERBS, THROUGH THE REAL GATEWAY (#1191, B5, B7).
//!
//! The member at the gateway machine has the last word: `freeze`, `unfreeze`,
//! `undo`, `purge-now` and `delete-vault` go through the same `Engine` a
//! phone's request does. The attacker-side behaviour of a frozen vault, the
//! unfreeze arithmetic, the undo and the long-gap re-base are conformance
//! cases (`a_frozen_vault_refuses_writes_and_answers_reads` and its
//! neighbours in `tests/conformance_wire.rs`); what is here is what only the
//! CLI's library adds: resolving the id, `--yes`, counts, and the binary.

use std::process::Command;

use centraid_gateway::client::Client;
use centraid_gateway::rules::ids::{Digest, Name, VaultId};
use centraid_gateway::rules::signing::sign_delete;
use centraid_gateway::rules::wire::DeleteRequest;
use centraid_gateway::server::harness::{Spawned, pair_secret, spawn};
use centraid_gateway::server::operator::{self, Verb};

struct Member {
    key: ed25519_dalek::SigningKey,
    vault: VaultId,
    phone: Client,
    generation: u64,
}

async fn member(gateway: &Spawned) -> Member {
    let key = ed25519_dalek::SigningKey::from_bytes(&[21; 32]);
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
    }
}

impl Member {
    async fn stores_and_deletes(&mut self, gateway: &Spawned, label: &str) -> Name {
        let name = Name::from_bytes(blake3::derive_key("operator test name", label.as_bytes()));
        let bytes = blake3::hash(label.as_bytes()).as_bytes().repeat(4);
        self.phone
            .put(&self.vault, &name, &Digest::of(&bytes), bytes)
            .await
            .expect("stores");
        self.generation += 1;
        let request = DeleteRequest {
            names: vec![name],
            generation: self.generation,
            signature: sign_delete(&self.key, &gateway.gateway_id, 1, self.generation, &[name]),
        };
        self.phone
            .delete(&self.vault, &request)
            .await
            .expect("holds");
        name
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_now_needs_yes_and_an_unfrozen_vault() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let mut member = member(&gateway).await;
    let name = member.stores_and_deletes(&gateway, "held").await;
    let shared = gateway.shared();
    let id = member.vault.hex()[..8].to_owned();
    let vault = operator::resolve(shared, &id).expect("resolves the first 8 hex");

    let no = operator::run(shared, &vault, Verb::PurgeNow, false).expect_err("needs --yes");
    assert!(no.0.contains("--yes"), "{no}");
    operator::run(shared, &vault, Verb::Freeze, false).expect("freezes");
    let frozen = operator::run(shared, &vault, Verb::PurgeNow, true).expect_err("frozen");
    assert!(frozen.0.contains("frozen"), "{frozen}");
    assert!(
        member.phone.get(&member.vault, &name, None).await.is_ok(),
        "nothing was purged"
    );

    operator::run(shared, &vault, Verb::Unfreeze, false).expect("unfreezes");
    let lines = operator::run(shared, &vault, Verb::PurgeNow, true).expect("purges");
    assert_eq!(lines.len(), 1);
    assert!(
        lines[0].contains("1 holds made due") && lines[0].contains("1 objects purged"),
        "counts only: {lines:?}"
    );
    assert!(
        !lines[0].contains(&name.hex()),
        "the verb never prints a name"
    );
    assert!(
        member.phone.get(&member.vault, &name, None).await.is_err(),
        "the held object is gone"
    );
    gateway.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_vault_needs_a_frozen_vault_and_removes_everything() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let mut member = member(&gateway).await;
    let held = member.stores_and_deletes(&gateway, "held").await;
    let live = Name::from_bytes(blake3::derive_key("operator test name", b"live"));
    let bytes = b"live bytes".repeat(8);
    member
        .phone
        .put(&member.vault, &live, &Digest::of(&bytes), bytes)
        .await
        .expect("stores");
    let shared = gateway.shared();
    let vault = operator::resolve(shared, &member.vault.hex()[..8]).expect("resolves");

    let no = operator::run(shared, &vault, Verb::DeleteVault, false).expect_err("needs --yes");
    assert!(no.0.contains("--yes"));
    let unfrozen = operator::run(shared, &vault, Verb::DeleteVault, true).expect_err("not frozen");
    assert!(unfrozen.0.contains("not frozen"), "{unfrozen}");
    assert!(member.phone.get(&member.vault, &live, None).await.is_ok());

    operator::run(shared, &vault, Verb::Freeze, false).expect("freezes");
    let lines = operator::run(shared, &vault, Verb::DeleteVault, true).expect("deletes");
    assert!(
        lines[0].contains("2 objects") && lines[0].contains("1 tokens"),
        "{lines:?}"
    );
    for name in [held, live] {
        assert!(
            !gateway
                .data_dir()
                .join("objects")
                .join(vault.hex())
                .join(&name.hex()[..2])
                .join(name.hex())
                .exists(),
            "an object file survives"
        );
    }
    assert!(
        shared
            .rules(|gateway| gateway.pairings())
            .expect("lists")
            .is_empty(),
        "the vault is gone"
    );
    assert!(
        member.phone.objects(&member.vault, None, 10).await.is_err(),
        "its token is gone with it"
    );
    gateway.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ambiguous_or_unknown_vault_id_is_refused() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let shared = gateway.shared();
    assert!(
        operator::resolve(shared, "abcdef01").is_err(),
        "no such vault"
    );
    assert!(operator::resolve(shared, "abc").is_err(), "too short");
    let member = member(&gateway).await;
    assert!(operator::resolve(shared, &member.vault.hex()[..8]).is_ok());
    gateway.shutdown().await;
}

/// The binary: a verb without `--yes` exits 3 and says why; `freeze` and
/// `unfreeze` print counts and no name.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_binary_runs_the_verbs_and_exits_3_on_a_refusal() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let member = member(&gateway).await;
    let id = member.vault.hex()[..8].to_owned();
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_centraid-gateway"))
            .arg("vault")
            .arg(&id)
            .args(args)
            .arg("--data-dir")
            .arg(gateway.data_dir())
            .output()
            .expect("runs")
    };
    let frozen = run(&["freeze"]);
    assert_eq!(frozen.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&frozen.stdout).contains("frozen"));
    let refused = run(&["purge-now"]);
    assert_eq!(refused.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&refused.stderr).contains("--yes"));
    let thawed = run(&["unfreeze"]);
    assert_eq!(thawed.status.code(), Some(0));
    gateway.shutdown().await;
}
