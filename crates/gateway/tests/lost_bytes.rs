//! A ROW WHOSE BYTES ARE GONE (#1080, the sweep's B3).
//!
//! The object index lives in `state.db` and the bytes in `objects/`, so the
//! two can disagree behind the gateway's back: a member "cleaning up"
//! `objects/`, a disk that lost files, a copy of the data directory taken
//! while it changed. The documents promise that such a name reads as missing
//! and that the phone sends it again. `GET` and `fetch` already answered from
//! the file; `exists` and `PUT` answered from the row alone, so the phone was
//! told the name was held, and a phone that sent it again anyway was told
//! "already stored" while nothing was written — until a quarterly scrub.

use centraid_gateway::client::{Client, Part, Put, Source};
use centraid_gateway::rules::ids::{Digest, Name, VaultId};
use centraid_gateway::rules::wire::{PairKind, PairRequest};
use centraid_gateway::server::harness::{Spawned, spawn};

/// A vault paired with `gateway`, and the client holding its token.
async fn paired(gateway: &Spawned, seed: u8) -> (VaultId, Client) {
    let identity = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    let vault = VaultId::from_bytes(identity.verifying_key().to_bytes());
    let phone = gateway.first_contact();
    let paired = phone
        .pair(&PairRequest {
            vault_id: vault,
            label: "a phone".to_owned(),
            kind: PairKind::Secret,
            secret: Some(gateway.mint_pairing_secret()),
            claim: None,
            read: None,
        })
        .await
        .expect("pairs");
    (vault, gateway.client(paired.token))
}

/// Bytes nobody can open, from a seed, under a name from another.
fn sealed(seed: &str) -> Vec<u8> {
    let mut bytes = vec![0_u8; 1_000];
    blake3::Hasher::new()
        .update(seed.as_bytes())
        .finalize_xof()
        .fill(&mut bytes);
    bytes
}

fn name(seed: &str) -> Name {
    Name::from_bytes(*blake3::hash(seed.as_bytes()).as_bytes())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_name_whose_file_is_gone_reads_missing_and_a_put_brings_it_back() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, client) = paired(&gateway, 7).await;
    let (kept, lost) = (name("kept"), name("lost"));
    for (name, bytes) in [(kept, sealed("kept")), (lost, sealed("lost"))] {
        client
            .put(&vault, &name, &Digest::of(&bytes), bytes)
            .await
            .expect("stores");
    }
    let file = gateway.shared().store().path(&vault, &lost);
    std::fs::remove_file(&file).expect("the bytes go behind the gateway's back");

    // EXISTS TELLS THE TRUTH: the phone is asked for it again.
    let missing = client.exists(&vault, &[kept, lost]).await.expect("answers");
    assert_eq!(missing, vec![lost], "a name with no bytes is not held");

    // A PUT BRINGS IT BACK, under the sealing the phone has now.
    let again = sealed("lost, sealed again");
    let answer = client
        .put(&vault, &lost, &Digest::of(&again), again.clone())
        .await
        .expect("answers");
    assert!(matches!(answer, Put::Stored(_)), "{answer:?}");
    assert_eq!(std::fs::read(&file).expect("the bytes are back"), again);
    assert!(
        client
            .exists(&vault, &[lost])
            .await
            .expect("answers")
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bundle_brings_back_a_name_whose_file_is_gone() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, client) = paired(&gateway, 8).await;
    let lost = name("a range");
    let first = sealed("a range");
    client
        .put(&vault, &lost, &Digest::of(&first), first.clone())
        .await
        .expect("stores");
    let file = gateway.shared().store().path(&vault, &lost);
    std::fs::remove_file(&file).expect("the bytes go behind the gateway's back");

    let answer = client
        .bundle_parts(
            &vault,
            vec![Part {
                name: lost,
                digest: Digest::of(&first),
                source: Source::Bytes(first.clone().into()),
            }],
        )
        .await
        .expect("answers");
    assert_eq!(answer.stored, vec![lost], "{answer:?}");
    assert_eq!(std::fs::read(&file).expect("the bytes are back"), first);
}
