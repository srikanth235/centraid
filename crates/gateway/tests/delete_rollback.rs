//! A DELETE IS BOUND TO ITS HEAD, EVEN AFTER A DATA-DIRECTORY ROLLBACK
//! (#1209, spec §4, G3).
//!
//! The phone computes what to delete from the head it read; the delete names
//! that head's root, and a gateway takes it only while that is its current
//! head. Here the gateway's whole data directory is put back to an earlier
//! moment — as a restored backup of the machine, or a snapshot of its disk,
//! would — and the delete the phone computed under the later head is refused,
//! holding nothing. Counted: names held before and after.

use std::path::Path;

use centraid_gateway::client::{Client, ClientError};
use centraid_gateway::rules::bundle::Frame;
use centraid_gateway::rules::code::Refusal;
use centraid_gateway::rules::ids::{GatewayId, Name, VaultId};
use centraid_gateway::rules::signing::{HeadFields, sign_delete, sign_head};
use centraid_gateway::rules::wire::{DeleteRequest, SetHead};
use centraid_gateway::server::harness::{pair_secret, spawn};

fn blob(label: &str) -> Frame {
    let name = Name::from_bytes(blake3::derive_key("rollback name", label.as_bytes()));
    Frame::of(name, blake3::hash(label.as_bytes()).as_bytes().repeat(8))
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("a directory");
    for entry in std::fs::read_dir(from).expect("lists") {
        let entry = entry.expect("an entry");
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("copies");
        }
    }
}

fn empty(dir: &Path) {
    for entry in std::fs::read_dir(dir).expect("lists") {
        let path = entry.expect("an entry").path();
        if path.is_dir() {
            std::fs::remove_dir_all(path).expect("removes");
        } else {
            std::fs::remove_file(path).expect("removes");
        }
    }
}

fn head(
    key: &ed25519_dalek::SigningKey,
    gateway: &GatewayId,
    name: Name,
    prev: Option<Name>,
    generation: u64,
) -> SetHead {
    let fields = HeadFields {
        epoch: 1,
        generation,
        writes: generation,
        taken_at_ms: 1,
        manifest: name,
        prev,
    };
    SetHead {
        name,
        prev,
        taken_at_ms: 1,
        generation,
        writes: generation,
        signature: sign_head(key, gateway, &fields),
    }
}

fn delete(
    key: &ed25519_dalek::SigningKey,
    gateway: &GatewayId,
    generation: u64,
    head_root: Name,
    names: &[Name],
) -> DeleteRequest {
    DeleteRequest {
        names: names.to_vec(),
        generation,
        head_root: Some(head_root),
        signature: sign_delete(key, gateway, 1, generation, Some(&head_root), names),
    }
}

async fn held(phone: &Client, vault: &VaultId) -> usize {
    phone.held(vault, None, 100).await.expect("held").len()
}

/// THE ROLLBACK. Head one is made and the data directory is copied; head two
/// is made on top of it, and a delete bound to head two is accepted there. The
/// directory is then put back to the copy. The same signed delete, and any
/// delete computed under head two, is refused `HEAD_CONFLICT` by the rolled
/// back gateway, which answers the head it has; a delete bound to the head it
/// does have is accepted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delete_computed_under_a_newer_head_is_refused_after_a_data_dir_rollback() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let beside = tempfile::tempdir().expect("a temp dir");
    let key = ed25519_dalek::SigningKey::from_bytes(&[51; 32]);
    let vault = VaultId::from_bytes(key.verifying_key().to_bytes());
    let (one, two, victim, other) = (
        blob("root one"),
        blob("root two"),
        blob("a name only head one keeps out of the keep set"),
        blob("another name"),
    );

    let gateway = spawn(dir.path()).await.expect("spawned");
    let gateway_id = gateway.gateway_id;
    let paired = pair_secret(
        &gateway.first_contact(),
        &key,
        "a phone",
        gateway.mint_pairing_secret(),
    )
    .await
    .expect("pairs");
    let phone = gateway.client(paired.token);
    phone
        .bundle(&vault, &[one.clone(), victim.clone(), other.clone()])
        .await
        .expect("stores");
    phone
        .set_head(&vault, &head(&key, &gateway_id, one.name, None, 1))
        .await
        .expect("head one");
    gateway.shutdown().await;
    copy_tree(dir.path(), beside.path());

    // Later: head two, and a delete bound to it, accepted.
    let gateway = spawn(dir.path()).await.expect("spawned again");
    let phone = gateway.client(paired.token);
    phone
        .bundle(&vault, std::slice::from_ref(&two))
        .await
        .expect("stores");
    phone
        .set_head(
            &vault,
            &head(&key, &gateway_id, two.name, Some(one.name), 2),
        )
        .await
        .expect("head two");
    let computed_under_two = delete(&key, &gateway_id, 3, two.name, &[victim.name]);
    let accepted = phone
        .delete(&vault, &computed_under_two)
        .await
        .expect("accepted under its own head");
    assert_eq!(accepted.deleted, vec![victim.name]);
    assert_eq!(held(&phone, &vault).await, 1);
    gateway.shutdown().await;

    // The rollback: the whole data directory goes back to the copy.
    empty(dir.path());
    copy_tree(beside.path(), dir.path());
    let gateway = spawn(dir.path())
        .await
        .expect("the rolled-back gateway opens");
    let phone = gateway.client(paired.token);
    assert_eq!(
        held(&phone, &vault).await,
        0,
        "nothing is held after the rollback"
    );

    let replayed = phone.delete(&vault, &computed_under_two).await;
    match replayed {
        Err(ClientError::Refused(Refusal::HeadConflict {
            head: Some(current),
            ..
        })) => {
            assert_eq!(current.name, one.name, "it answers the head it has");
        }
        other => panic!("a delete under a head the gateway never had was not refused: {other:?}"),
    }
    let fresh_under_two = delete(&key, &gateway_id, 4, two.name, &[other.name]);
    assert!(
        matches!(
            phone.delete(&vault, &fresh_under_two).await,
            Err(ClientError::Refused(Refusal::HeadConflict { .. }))
        ),
        "a new delete computed under the newer head is refused too"
    );
    assert_eq!(held(&phone, &vault).await, 0, "the refusals held nothing");
    assert_eq!(
        phone.objects(&vault, None, 100).await.expect("lists").len(),
        3,
        "and every name is still stored"
    );

    // Bound to the head it does have, it is taken.
    let answer = phone
        .delete(
            &vault,
            &delete(&key, &gateway_id, 5, one.name, &[other.name]),
        )
        .await
        .expect("accepted under the head it has");
    assert_eq!(answer.deleted, vec![other.name]);
    assert_eq!(held(&phone, &vault).await, 1);
    gateway.shutdown().await;
}
