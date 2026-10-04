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

/// Pair through a relay in front of the gateway: the payload names the relay,
/// so every later pass reaches the gateway through it. Answers the gateway's
/// id.
fn pair_through(handle: &centraid_core::Handle, gateway: &Gateway, relay: &Relay) -> String {
    pair_with(handle, &gateway.payload_at(relay.addr))
        .destination
        .expect("a destination")
        .gateway_id
}

/// `count` originals of `size` bytes each, owned by the app.
fn originals(handle: &centraid_core::Handle, label: &str, count: usize, size: usize) {
    for index in 0..count {
        let bytes = bytes_of(&format!("{label} {index}"), size);
        let staged = stage(handle, owned("image/heic", &bytes), &bytes);
        add_asset(handle, &staged, "photo");
    }
}

/// **A GATEWAY THAT GOES AWAY PART-WAY THROUGH A PASS** (#1080, B1; the
/// root's simulator repro: a gateway killed while a film's parts moved).
/// Nothing counts as backed up that the gateway did not acknowledge; what
/// waits is counted as waiting for the gateway, not for time; and when it
/// comes back the next pass sends only what is left, leaving the gateway
/// holding exactly what the ledger confirms.
#[test]
fn a_gateway_that_goes_away_mid_pass_is_blamed_and_the_next_pass_finishes() {
    let gateway = gateway();
    let relay = Relay::to(gateway.spawned.addr);
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let id = pair_through(&phone, &gateway, &relay);
    drain(&phone, at_home());
    // SIX ORIGINALS OF A MEBIBYTE: each part goes alone.
    originals(&phone, "a photograph the gateway half took", 6, 1 << 20);

    // THE GATEWAY GOES AWAY PART-WAY THROUGH THE THIRD.
    relay.cut_after(2 * (1 << 20) + (1 << 19));
    let cut = drain(&phone, quietly());
    assert_eq!(cut.stopped, wire::DrainStop::Unreachable as i32, "{cut:?}");
    assert!(
        (1..6).contains(&cut.confirmed_parts),
        "some moved before the gateway went: {cut:?}"
    );
    let held = gateway.held(&vault_id());
    let confirmed = ledger(&path).confirmed_names(&id).expect("reads");
    assert!(
        confirmed.is_subset(&held),
        "the ledger confirms nothing the gateway does not hold"
    );
    let left = 6 - u64::from(cut.confirmed_parts);
    let waits = status(&phone);
    assert_eq!(waits.content_confirmed, u64::from(cut.confirmed_parts));
    assert_eq!(
        (
            waiting(&waits, wire::WaitReason::Gateway),
            waiting(&waits, wire::WaitReason::Window)
        ),
        (left, 0),
        "what waits, waits for the gateway: {:?}",
        waits.waiting
    );

    // THE GATEWAY COMES BACK, and the next pass sends what is left.
    relay.mend();
    let resumed = drain(&phone, quietly());
    assert_eq!(
        resumed.stopped,
        wire::DrainStop::Empty as i32,
        "{resumed:?}"
    );
    assert_eq!(
        u64::from(resumed.confirmed_parts),
        left,
        "nothing acknowledged is sent again"
    );
    let backed = status(&phone);
    assert_eq!(backed.content_confirmed, backed.content_total);
    assert!(backed.waiting.is_empty(), "{:?}", backed.waiting);
    assert_eq!(
        gateway.held(&vault_id()),
        ledger(&path).confirmed_names(&id).expect("reads"),
        "the gateway holds exactly what the ledger confirms"
    );
}

/// **A GATEWAY THAT GOES AWAY WHILE A PASS ASKS IT A QUESTION** (#1080, B1).
/// The pass reached the gateway and was asking it `exists` when it went.
/// That is the same gateway out of reach as one that stops mid-upload: an
/// answer that says so, and a status that waits for the gateway — never a
/// refusal a shell reads as "no pass ran".
#[test]
fn a_gateway_that_goes_away_mid_question_is_an_unreachable_pass() {
    let gateway = gateway();
    let relay = Relay::to(gateway.spawned.addr);
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair_through(&phone, &gateway, &relay);
    drain(&phone, at_home());
    // WHAT A PASS WITH NOTHING TO DO SENDS: a handshake and `info`.
    let before = relay.sent();
    drain(&phone, quietly());
    let reach = relay.sent() - before;
    let seen = |phone: &centraid_core::Handle| status(phone).destinations[0].last_seen_ms;
    let last_seen = seen(&phone);

    // FIFTY ORIGINALS, and the gateway goes a few bytes into the question.
    originals(&phone, "a small original", 50, 512);
    relay.cut_after(i64::try_from(reach).expect("fits") + 64);
    let cut = try_drain(&phone, quietly())
        .unwrap_or_else(|error| panic!("a gateway out of reach is an answer: {error}"));
    assert!(
        seen(&phone) > last_seen,
        "the pass reached the gateway first"
    );
    assert_eq!(cut.stopped, wire::DrainStop::Unreachable as i32, "{cut:?}");
    let waits = status(&phone);
    assert_eq!(
        waiting(&waits, wire::WaitReason::Gateway),
        50,
        "{:?}",
        waits.waiting
    );

    relay.mend();
    let resumed = drain(&phone, quietly());
    assert_eq!(
        resumed.stopped,
        wire::DrainStop::Empty as i32,
        "{resumed:?}"
    );
    assert_eq!(resumed.confirmed_parts, 50);
    let backed = status(&phone);
    assert_eq!(backed.content_confirmed, 50);
}

/// The whole parts in a spool directory: files named by 64 hex characters.
fn spooled(dir: &std::path::Path) -> Vec<(String, u64)> {
    std::fs::read_dir(dir.join("vault.spool"))
        .expect("lists the spool")
        .map(|entry| entry.expect("an entry"))
        .filter(|entry| entry.file_name().len() == 64)
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                entry.metadata().expect("measures").len(),
            )
        })
        .collect()
}

/// **A PART A CRASH LEFT IN THE SPOOL DOES NOT WAIT THERE FOREVER** (#1080,
/// B2). A pass that was killed between confirming a part and deleting its
/// file, or between sealing a part under its name and queuing it, leaves a
/// whole part no queue row names. Nothing would ever move or delete it: it
/// would read as bytes left to back up on every pass and hold the spool's
/// room from every later one.
#[test]
fn a_part_a_crash_left_in_the_spool_is_swept_by_the_next_core() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    let photo = bytes_of("a photograph the crash interrupted", 200_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    add_asset(&phone, &photo_handle, "photo");
    drain(&phone, at_home());
    assert!(spooled(dir.path()).is_empty(), "the pass emptied the spool");

    // WHAT THE CRASH LEFT: a confirmed part's file, and a sealed part whose
    // queue row never landed.
    let confirmed = *ledger(&path)
        .confirmed_names(&id)
        .expect("reads")
        .iter()
        .next()
        .expect("a confirmed name");
    let spool = dir.path().join("vault.spool");
    std::fs::write(
        spool.join(confirmed.to_hex()),
        bytes_of("a sealed part the crash kept", 70_000),
    )
    .expect("plants");
    std::fs::write(
        spool.join(Name::from_bytes([7; 32]).to_hex()),
        bytes_of("a part sealed and never queued", 50_000),
    )
    .expect("plants");
    drop(phone);

    let phone = reopen(&path);
    let drained = drain(&phone, quietly());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    assert_eq!(
        drained.pending_bytes, 0,
        "nothing is left to send: {drained:?}"
    );
    assert_eq!(status(&phone).spool_bytes, 0);
    assert!(
        spooled(dir.path()).is_empty(),
        "no part outlives the queue: {:?}",
        spooled(dir.path())
    );
}
