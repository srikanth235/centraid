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

use centraid_gateway::client::{Client, Part, Source};
use centraid_gateway::rules::ids::{Digest, Name, VaultId};

use centraid_gateway::rules::wire::FrameResult;
use centraid_gateway::server::harness::pair_secret;
use centraid_gateway::server::harness::{Spawned, put, spawn};

/// A vault paired with `gateway`, and the client holding its token.
async fn paired(gateway: &Spawned, seed: u8) -> (VaultId, Client) {
    let identity = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    let vault = VaultId::from_bytes(identity.verifying_key().to_bytes());
    let phone = gateway.first_contact();
    let paired = pair_secret(
        &phone,
        &identity,
        "a phone".to_owned(),
        gateway.mint_pairing_secret(),
    )
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
        put(&client, &vault, &name, &Digest::of(&bytes), bytes)
            .await
            .expect("stores");
    }
    let file = gateway.shared().store().path(&vault, &lost);
    std::fs::remove_file(&file).expect("the bytes go behind the gateway's back");

    // EXISTS TELLS THE TRUTH: the phone is asked for it again.
    let missing = client.exists(&vault, &[kept, lost]).await.expect("answers");
    assert_eq!(missing, vec![lost], "a name with no bytes is not held");

    // A PUT BRINGS IT BACK — with the bytes the row records (#1191, R3). A
    // sealing the phone makes afresh has another digest, and a gateway that
    // took any bytes over a name it holds a row for would let a writer token
    // swap garbage in: it is NAME_TAKEN, and nothing changes.
    let again = sealed("lost, sealed again");
    let answer = put(&client, &vault, &lost, &Digest::of(&again), again.clone())
        .await
        .expect("answers");
    assert!(matches!(answer, FrameResult::Taken { .. }), "{answer:?}");
    assert!(!file.exists(), "and no file was written");
    let original = sealed("lost");
    let answer = put(
        &client,
        &vault,
        &lost,
        &Digest::of(&original),
        original.clone(),
    )
    .await
    .expect("answers");
    assert!(matches!(answer, FrameResult::Stored { .. }), "{answer:?}");
    assert_eq!(std::fs::read(&file).expect("the bytes are back"), original);
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
    put(&client, &vault, &lost, &Digest::of(&first), first.clone())
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
    assert_eq!(
        answer.results,
        vec![FrameResult::Stored { name: lost }],
        "{answer:?}"
    );
    assert_eq!(std::fs::read(&file).expect("the bytes are back"), first);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_name_whose_file_is_gone_reads_missing_and_a_put_brings_it_back() {
    use centraid_gateway::rules::signing;
    use centraid_gateway::rules::wire::DeleteRequest;

    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let identity = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
    let vault = VaultId::from_bytes(identity.verifying_key().to_bytes());
    let phone = gateway.first_contact();
    let paired = pair_secret(
        &phone,
        &identity,
        "a phone".to_owned(),
        gateway.mint_pairing_secret(),
    )
    .await
    .expect("pairs");
    let client = gateway.client(paired.token);

    let lost = name("held-lost");
    let bytes = sealed("held-lost");
    let digest = Digest::of(&bytes);
    put(&client, &vault, &lost, &digest, bytes.clone())
        .await
        .expect("stores");

    // Soft-delete `lost` so its row is held (`hold.is_some()`, `!is_live()`).
    let delete_sig = signing::sign_delete(
        &identity,
        &paired.gateway_id,
        paired.epoch,
        1,
        None,
        &[lost],
    );
    client
        .delete(
            &vault,
            &DeleteRequest {
                generation: 1,
                head_root: None,
                names: vec![lost],
                signature: delete_sig,
            },
        )
        .await
        .expect("holds");

    let file = gateway.shared().store().path(&vault, &lost);
    std::fs::remove_file(&file).expect("the bytes go behind the gateway's back");

    // Putting the held name again must notice the missing file, mark it missing, and restore bytes.
    let answer = put(&client, &vault, &lost, &digest, bytes.clone())
        .await
        .expect("answers");
    assert!(matches!(answer, FrameResult::Stored { .. }), "{answer:?}");
    assert_eq!(std::fs::read(&file).expect("the bytes are back"), bytes);
}
