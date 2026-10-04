//! THE BACKUP PLANE AT ITS EDGES, THROUGH THE CORE'S DOORS, AGAINST A REAL
//! GATEWAY (#1080, the adversarial sweep).
//!
//! Each case is a way a pass meets the world going wrong — a gateway that
//! sleeps mid-pass, forgets the vault, fills its disk; a phone killed between
//! two steps; a second phone taking the vault over — and asserts what a
//! member is owed: nothing counts as backed up that a gateway did not
//! acknowledge, the status names what is waited for, and the next pass
//! finishes without sending again what was acknowledged.

mod common;

use std::path::PathBuf;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::backup::naming::Name;
use serde_json::json;

use common::*;

fn note(handle: &centraid_core::Handle, title: &str, body: &str) -> String {
    command(
        handle,
        "knowledge.create_note",
        &json!({ "title": title, "body_text": body, "format": "plain" }),
        &format!("note:{title}"),
    )["note_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// **A PHONE THAT TOOK THE VAULT OVER MOVES THE HEAD** (R-1080-C17). Pairing a
/// gateway that already holds the vault claims it; the claim names the head
/// the gateway held, and the phone's next pass must set its own snapshot as
/// the head over that one — or the records it writes are never backed up
/// again, while every pass answers that it emptied.
#[test]
fn a_phone_that_took_the_vault_over_moves_the_head() {
    let gateway = gateway();
    let first_dir = tempfile::tempdir().expect("a directory");
    let first = phone(first_dir.path());
    pair(&first, &gateway);
    note(&first, "Before", "written on the first phone");
    drain(&first, at_home());

    let second_dir = tempfile::tempdir().expect("a directory");
    let second_path = second_dir.path().join("vault.db");
    let second = phone(second_dir.path());
    pair(&second, &gateway);
    note(
        &second,
        "After",
        "written on the phone that took the vault over",
    );
    let drained = drain(&second, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    assert!(
        drained.acked_at_ms.is_some(),
        "the head moved to the second phone's snapshot: {drained:?}"
    );
    let (epoch, head) = gateway.writer(&vault_id());
    assert_eq!(epoch, 2, "the takeover claimed the next epoch");
    let taken = ledger(&second_path).snapshots().expect("reads");
    assert_eq!(
        head,
        taken.last().map(|snapshot| snapshot.name),
        "the gateway's head is the second phone's newest snapshot"
    );

    // WHAT A RESTORE BRINGS BACK IS THE SECOND PHONE'S VAULT.
    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    assert_eq!(
        rows(&PathBuf::from(&restored.vaults[0].path)),
        rows(&second_path),
        "row for row"
    );
}

/// The three files that are a gateway's identity, copied to a new data
/// directory: a gateway whose disk was replaced and whose identity came back
/// from a copy, with nothing else.
fn identity_into(from: &std::path::Path, to: &std::path::Path) {
    for file in ["tls.key", "tls.crt", "gateway.id"] {
        std::fs::copy(from.join(file), to.join(file)).expect("copies the identity");
    }
}

/// **A GATEWAY THAT LOST THE VAULT, PAIRED AGAIN, IS SENT EVERYTHING AGAIN**
/// (#1080, B3). The gateway's disk was replaced and its identity restored, so
/// its id and certificate are the ones this phone pinned and it holds nothing
/// for the vault. Until the member pairs again the phone's token opens
/// nothing; once they do, the phone must not trust what the old copy
/// acknowledged — every file and the records go again, and the head is set.
#[test]
fn pairing_again_with_a_gateway_that_lost_the_vault_sends_everything_again() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    let photo = bytes_of(
        "a photograph from before the gateway lost its disk",
        150_000,
    );
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    let thumb = bytes_of("its thumbnail, before the disk went", 5_000);
    stage(&phone, thumb_of(&photo_handle, &thumb), &thumb);
    add_asset(&phone, &photo_handle, "photo");
    drain(&phone, at_home());
    let before = status(&phone);
    assert_eq!((before.content_confirmed, before.content_total), (2, 2));

    let replaced = tempfile::tempdir().expect("a directory");
    identity_into(gateway.spawned.data_dir(), replaced.path());
    drop(gateway);
    let gateway = gateway_in(replaced);
    assert_eq!(
        gateway.spawned.gateway_id.hex(),
        id,
        "the same gateway, as pinned"
    );

    // BEFORE THE MEMBER PAIRS AGAIN: the phone's token opens nothing there,
    // and the gateway holds nothing for the vault.
    let book = ledger(&path);
    let mut row = book.destination(&id).expect("reads").expect("paired");
    row.addrs = vec![gateway.spawned.addr.to_string()];
    book.put_destination(&row).expect("writes");
    let refused = try_drain(&phone, at_home()).expect_err("the gateway does not know the token");
    assert_eq!(refused.code(), wire::ErrorCode::Unauthorized, "{refused}");
    assert!(gateway.held(&vault_id()).is_empty());

    // THE MEMBER PAIRS AGAIN with the code the gateway prints now, and the
    // next pass is an ordinary one: nobody tapped Back up now.
    pair(&phone, &gateway);
    let drained = drain(&phone, quietly());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    assert!(
        drained.acked_at_ms.is_some(),
        "the head is set at the gateway that lost it: {drained:?}"
    );
    let held = gateway.held(&vault_id());
    let missing: Vec<Name> = file_names(&phone)
        .into_iter()
        .filter(|name| !held.contains(name))
        .collect();
    assert!(missing.is_empty(), "the gateway lacks {missing:?}");
    let backed = status(&phone);
    assert_eq!(backed.content_confirmed, backed.content_total, "{backed:?}");
    let confirmed = ledger(&path).confirmed_names(&id).expect("reads");
    assert!(
        confirmed.iter().all(|name| held.contains(name)),
        "nothing the ledger confirms is missing from the gateway"
    );
    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    assert_eq!(rows(&PathBuf::from(&restored.vaults[0].path)), rows(&path));
}
