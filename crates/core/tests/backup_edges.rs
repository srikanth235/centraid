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

/// **A NOTE IS BACKED UP WITH THE RECORDS IT LIVES IN.** A note's body is a
/// content item whose bytes are the vault's own row (`data:` text), not a
/// file in the content store or the library, so no pass can seal it by name —
/// the snapshot carries it. A status that counted it as a file to send would
/// wait on it forever and never say "backed up" to a member who writes notes.
#[test]
fn a_note_is_backed_up_with_the_records_it_lives_in() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    note(&phone, "Groceries", "milk, bread and the backup plane");
    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    assert!(drained.acked_at_ms.is_some(), "the head moved: {drained:?}");
    let backed = status(&phone);
    assert_eq!(
        backed.content_confirmed, backed.content_total,
        "the note's body is in the snapshot the gateway acknowledged: {:?}",
        backed.waiting
    );
    assert!(
        backed.waiting.is_empty(),
        "nothing waits: {:?}",
        backed.waiting
    );
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
    // ALL SIX WAIT FOR THE GATEWAY: the bytes it did not take, and the rows
    // of every one, which no snapshot has taken yet.
    let waits = status(&phone);
    assert_eq!(waits.content_confirmed, 0);
    assert_eq!(
        (
            waiting(&waits, wire::WaitReason::Gateway),
            waiting(&waits, wire::WaitReason::Window)
        ),
        (6, 0),
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
    let rows_wait = status(&phone);
    assert_eq!(
        waiting(&rows_wait, wire::WaitReason::Window),
        6,
        "the bytes are there and the rows wait for the next snapshot: {:?}",
        rows_wait.waiting
    );
    drain(
        &phone,
        wire::DrainRequest {
            asked: true,
            ..at_home()
        },
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
    drain(
        &phone,
        wire::DrainRequest {
            asked: true,
            ..at_home()
        },
    );
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

/// **WHAT A GATEWAY LOST IS SENT AGAIN BY THE NEXT LAUNCH'S FIRST PASS**
/// (#1080, B3; R-1080-7: the ledger "is reconciled against the gateway's own
/// `exists` answer on every launch, so it … cannot drift"). Files went from
/// the gateway's `objects/` behind its back: a photograph, its thumbnail and
/// one range of the records' head. The ledger still confirms all of them.
/// Only the iOS upload loop ever asked `reconcile`, so on any other shell the
/// phone never asked again; the first pass of a core's life now asks about
/// every name it confirmed, sends again what the gateway lost, and retakes a
/// head the gateway no longer holds whole.
#[test]
fn what_the_gateway_lost_is_sent_again_by_the_next_launch() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    let photo = bytes_of("a photograph the gateway's disk lost", 150_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    let thumb = bytes_of("its thumbnail, lost with it", 5_000);
    stage(&phone, thumb_of(&photo_handle, &thumb), &thumb);
    add_asset(&phone, &photo_handle, "photo");
    note(&phone, "Kept", "a note in the records the head holds");
    drain(&phone, at_home());

    // THE FILES GO: the photograph's, the thumbnail's, and one range of the
    // head. The gateway's index still lists all three.
    let book = ledger(&path);
    let head = book.head(&id).expect("reads").expect("a head");
    let taken = book
        .snapshots()
        .expect("reads")
        .into_iter()
        .find(|snapshot| snapshot.name == head)
        .expect("this phone took the head");
    let manifest =
        centraid_vault::backup::snapshot::Manifest::from_json(taken.manifest_json.as_bytes())
            .expect("a manifest");
    let range = manifest.ranges[0].name;
    let lost: Vec<Name> = file_names(&phone).into_iter().chain([range]).collect();
    assert_eq!(lost.len(), 3);
    let store = gateway.spawned.shared().store();
    let on_disk = |name: &Name| {
        store.path(
            &vault_id(),
            &centraid_gateway::rules::ids::Name::from_bytes(*name.as_bytes()),
        )
    };
    for name in &lost {
        std::fs::remove_file(on_disk(name)).expect("a file goes");
    }
    drop(phone);

    // THE NEXT LAUNCH: a new core, and an ordinary pass with nothing new.
    let phone = reopen(&path);
    let drained = drain(&phone, quietly());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    for name in &lost {
        assert!(
            on_disk(name).is_file(),
            "{name} is on the gateway's disk again"
        );
    }
    let backed = status(&phone);
    assert_eq!(backed.content_confirmed, backed.content_total);
    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    assert_eq!(
        restored.vaults.len(),
        1,
        "the head is whole again: {restored:?}"
    );
    assert_eq!(rows(&PathBuf::from(&restored.vaults[0].path)), rows(&path));
}

/// **A STATUS READ WHILE A PASS RUNS ALWAYS ANSWERS, AND A SECOND PASS IS
/// REFUSED, NOT RUN** (#1080, B8). The Backup screen reads the status while
/// "Back up now" moves parts, and the mover deletes each acknowledged part's
/// spool file as it goes; the status counts the spool's bytes. A second pass
/// — another tap, a background window — is refused while one runs, the
/// member's tap is held for exactly its own pass, and nothing is sealed or
/// sent twice.
#[test]
fn a_status_read_while_a_pass_runs_always_answers() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = std::sync::Arc::new(phone(dir.path()));
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    drain(&phone, at_home());
    originals(&phone, "a photograph the screen watches go", 120, 2_048);

    let running = std::sync::Arc::clone(&phone);
    let pass = std::thread::spawn(move || {
        try_drain(
            &running,
            wire::DrainRequest {
                asked: true,
                ..quietly()
            },
        )
    });
    let mut reads = 0_u32;
    let mut refused_second = false;
    while !pass.is_finished() {
        if let Err(error) = try_ask(
            &phone,
            wire::request::Kind::BackupStatus(wire::BackupStatusRequest {}),
        ) {
            panic!("a status read during a pass was refused: {error}");
        }
        reads += 1;
        if phone.plane().asking() {
            let second = try_drain(&phone, at_home());
            if let Err(error) = second {
                assert_eq!(error.code(), wire::ErrorCode::InvalidRequest, "{error}");
                refused_second = true;
            }
        }
    }
    let drained = pass.join().expect("the pass thread").expect("the pass");
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    assert_eq!(drained.confirmed_parts, 120);
    assert!(reads > 1, "the screen read the status while the pass ran");
    assert!(refused_second, "a second pass is refused while one runs");
    assert!(!phone.plane().asking(), "the tap ended with its pass");
    let held = gateway.held(&vault_id());
    assert_eq!(held, ledger(&path).confirmed_names(&id).expect("reads"));
    assert!(ledger(&path).queued().expect("reads").is_empty());
}

/// The sealed bytes the spool holds: its whole parts.
fn spool_bytes(dir: &std::path::Path) -> u64 {
    spooled(dir).iter().map(|(_, len)| len).sum()
}

/// **THE SPOOL NEVER HOLDS MORE THAN ITS CEILING, AND PROGRESS STILL HAPPENS
/// A WINDOW AT A TIME** (#1080, B9). On a metered link under Wi-Fi only, a
/// pass seals what fits and moves no original; what does not fit waits for
/// the room, and a pass at home moves everything, a window at a time.
#[test]
fn the_spool_never_holds_more_than_its_ceiling() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let ceiling = 1_u64 << 20;
    let phone = phone_with(dir.path(), |config| config.with_spool_ceiling(ceiling));
    pair(&phone, &gateway);
    drain(&phone, at_home());
    originals(&phone, "a photograph a third of the spool", 4, 400 * 1024);

    let metered = drain(
        &phone,
        wire::DrainRequest {
            metered: true,
            ..quietly()
        },
    );
    assert_eq!(metered.confirmed_parts, 0, "{metered:?}");
    assert!(
        spool_bytes(dir.path()) <= ceiling,
        "{} bytes spooled under a ceiling of {ceiling}",
        spool_bytes(dir.path())
    );
    assert!(spool_bytes(dir.path()) > 0, "what fits was sealed");

    let home = drain(&phone, quietly());
    assert_eq!(home.stopped, wire::DrainStop::Empty as i32, "{home:?}");
    drain(
        &phone,
        wire::DrainRequest {
            asked: true,
            ..at_home()
        },
    );
    let backed = status(&phone);
    assert_eq!((backed.content_confirmed, backed.content_total), (4, 4));
    assert_eq!(spool_bytes(dir.path()), 0);
}

/// **A SNAPSHOT A CRASH CUT SHORT LEAVES NO COPY OF THE VAULT BEHIND**
/// (#1080, B2). A snapshot copies the whole vault into `<stem>.scratch/` and
/// describes it there; a phone killed in between leaves that copy. The next
/// snapshot clears it, but the next snapshot may be an hour away — and the
/// copy is the vault's whole size, on a phone the spool's budget was cut to
/// keep from filling.
#[test]
fn a_snapshot_copy_a_crash_left_goes_with_the_next_core() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    drain(&phone, at_home());
    drop(phone);
    // WHAT THE CRASH LEFT: a copy, mid-description.
    let scratch = dir.path().join("vault.scratch");
    std::fs::create_dir_all(&scratch).expect("a directory");
    std::fs::copy(&path, scratch.join("snapshot-1-00000000deadbeef.db")).expect("copies");

    let phone = reopen(&path);
    let drained = drain(&phone, quietly());
    assert!(drained.acked_at_ms.is_none(), "no snapshot was due");
    assert!(
        !scratch.exists() || std::fs::read_dir(&scratch).expect("lists").next().is_none(),
        "no copy of the vault outlives the crash"
    );
}

/// **THE PLANE'S PAGES ARE THE GATEWAY'S** (#1080, B6). The vault restates
/// the protocol's batch sizes rather than importing them (it does not depend
/// on the gateway's crate), so a batch of names or a page of the listing
/// that outgrew the gateway's cap would be refused — or, for the listing,
/// cut short, so a collection would stop at the first page.
#[test]
fn the_planes_batches_are_the_gateways_caps() {
    use centraid_gateway::rules::limits::{LIST_LIMIT, MAX_BUNDLE_BYTES, MAX_NAMES};
    use centraid_vault::backup::store::{BUNDLE_BYTES, LIST_PAGE, NAMES_PER_CALL};
    const {
        assert!(NAMES_PER_CALL <= MAX_NAMES);
        assert!(
            LIST_PAGE == LIST_LIMIT,
            "a full page is how the listing goes on"
        );
        assert!(BUNDLE_BYTES <= MAX_BUNDLE_BYTES);
    }
}

/// **A LEDGER PAST A THOUSAND NAMES** (#1080, B6). A large library's ledger
/// confirms tens of thousands of names; a relaunch's first pass asks the
/// gateway about every one, a thousand at a time, and nothing is refused
/// for its size. Here the ledger confirms 2,500 names the gateway never
/// held, which costs a test none of a large library's hours of disk: they
/// come back missing and are unconfirmed, the library's own names stay
/// confirmed, and nothing is sent again. Collection keeps the ledger true
/// too: a name retention deletes is no longer confirmed. (The 2,000-item
/// run at nightly scale is the owner's hand-off H-5.)
#[test]
fn a_ledger_past_a_thousand_names_is_asked_about_a_thousand_at_a_time() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    originals(&phone, "one of a small library", 20, 64);
    drain(&phone, at_home());
    // A SECOND HEAD DROPS THE FIRST, and what only it named is collected.
    note(&phone, "Another", "a second head");
    let second = drain(&phone, at_home());
    assert!(second.acked_at_ms.is_some(), "{second:?}");
    assert_eq!(
        ledger(&path).confirmed_names(&id).expect("reads"),
        gateway.held(&vault_id()),
        "the ledger confirms what the gateway holds, and no more"
    );

    let strangers: Vec<(Name, u64)> = (0..2_500)
        .map(|index| {
            (
                Name::from_bytes(
                    *blake3::hash(format!("never held {index}").as_bytes()).as_bytes(),
                ),
                64,
            )
        })
        .collect();
    ledger(&path)
        .confirm_many(&strangers, &id, 1)
        .expect("confirms");
    drop(phone);
    let phone = reopen(&path);
    let relaunched = drain(&phone, quietly());
    assert_eq!(
        relaunched.stopped,
        wire::DrainStop::Empty as i32,
        "{relaunched:?}"
    );
    assert_eq!(relaunched.confirmed_parts, 0, "nothing is sent again");
    assert_eq!(
        ledger(&path).confirmed_names(&id).expect("reads"),
        gateway.held(&vault_id())
    );
    let backed = status(&phone);
    assert_eq!((backed.content_confirmed, backed.content_total), (20, 20));
}

/// **A GATEWAY FORGOTTEN WHILE A PASS RUNS** (#1080, B10). The member
/// forgets it from the Backup screen during Back up now: the pass ends with
/// an answer, not an internal error, and the ledger keeps nothing about the
/// forgotten gateway — no row, no acknowledgement — so nothing it confirmed
/// counts afterwards.
#[test]
fn a_gateway_forgotten_mid_pass_ends_the_pass_and_keeps_nothing() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = std::sync::Arc::new(phone(dir.path()));
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    drain(&phone, at_home());
    originals(
        &phone,
        "a photograph moving when its gateway is forgotten",
        120,
        2_048,
    );
    let running = std::sync::Arc::clone(&phone);
    let pass = std::thread::spawn(move || try_drain(&running, quietly()));
    while ledger(&path).confirmed_names(&id).expect("reads").len() < 30 && !pass.is_finished() {
        std::thread::yield_now();
    }
    assert!(forget(&phone, &id).forgotten);
    let answered = pass.join().expect("the pass thread");
    assert!(
        answered.as_ref().is_ok_and(|drained| drained.stopped
            == wire::DrainStop::Unreachable as i32
            || drained.stopped == wire::DrainStop::Empty as i32),
        "the pass answers: {answered:?}"
    );
    let book = ledger(&path);
    assert!(book.destinations().expect("reads").is_empty());
    assert!(book.confirmed_names(&id).expect("reads").is_empty());
    let after = status(&phone);
    assert!(after.destinations.is_empty());
    assert_eq!(
        after.content_confirmed, 0,
        "nothing a forgotten gateway held counts"
    );
}

/// **AN EMPTY FILE BACKS UP AND COMES BACK** (#1080, B5): one empty part,
/// sealed, acknowledged, and assembled into nothing.
#[test]
fn an_empty_file_backs_up_and_comes_back() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let empty = stage(&phone, owned("application/octet-stream", &[]), &[]);
    assert_eq!(empty.byte_size, 0);
    add_asset(&phone, &empty, "photo");
    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    let backed = status(&phone);
    assert_eq!((backed.content_confirmed, backed.content_total), (1, 1));
    let door = phone.bytes().expect("a door");
    let hash = centraid_blobs::ContentHash::parse_hex(&empty.content_hash).expect("hex");
    assert!(door.store().remove(hash).expect("removes"));
    let wire::response::Kind::FetchOriginal(fetched) = ask(
        &phone,
        wire::request::Kind::FetchOriginal(wire::FetchOriginalRequest {
            content_hash: hex::decode(&empty.content_hash).expect("hex"),
        }),
    ) else {
        panic!("a fetch answers");
    };
    assert_eq!(
        fetched.outcome,
        wire::FetchOutcome::Landed as i32,
        "{fetched:?}"
    );
    assert!(std::fs::read(&fetched.path).expect("reads").is_empty());
}

/// **THE SAME BYTES UNDER TWO ASSETS ARE ONE FILE, STORED ONCE** (#1080,
/// B5): a photograph imported twice is two assets over one content item.
#[test]
fn the_same_bytes_under_two_assets_are_stored_once() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let photo = bytes_of("one photograph, imported twice", 90_000);
    let first = stage(&phone, owned("image/heic", &photo), &photo);
    let second = stage(&phone, owned("image/heic", &photo), &photo);
    assert_eq!(first.content_hash, second.content_hash);
    assert!(second.already_held, "the second import is held");
    add_asset(&phone, &first, "photo");
    let again = command(
        &phone,
        "media.add_asset",
        &json!({ "staged_sha": second.content_hash, "kind": "photo" }),
        "the-second-import",
    );
    assert!(again["asset_id"].is_string(), "{again}");
    drain(&phone, at_home());
    let backed = status(&phone);
    assert_eq!((backed.content_confirmed, backed.content_total), (1, 1));
    let names = file_names(&phone);
    assert_eq!(names.len(), 1, "one file, one name");
    assert!(gateway.held(&vault_id()).is_superset(&names));
}

/// **A PAIRING CODE IS REFUSED BEFORE ANYTHING IS KEPT** (#1080, B10): a
/// code already spent, text that is not a code, and a code whose pin is not
/// the certificate of the machine at its address each leave the ledger as
/// it was.
#[test]
fn a_pairing_code_that_does_not_pair_keeps_nothing() {
    let gateway = gateway();
    let other = self::gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let paired = |payload: &str| {
        try_ask(
            &phone,
            wire::request::Kind::PairPhone(wire::PairRequest {
                payload: payload.to_owned(),
            }),
        )
    };
    let destinations = |phone: &centraid_core::Handle| status(phone).destinations.len();

    // TEXT THAT IS NOT A CODE.
    let malformed = paired("{\"v\":2,\"gw\":\"nope\"}").expect_err("not a code");
    assert_eq!(
        malformed.code(),
        wire::ErrorCode::InvalidRequest,
        "{malformed}"
    );
    // ANOTHER MACHINE AT THE CODE'S ADDRESS: its certificate is not the pin.
    let mut forged: serde_json::Value =
        serde_json::from_str(&gateway.payload()).expect("a payload");
    forged["addrs"] = json!([other.spawned.addr.to_string()]);
    let impostor = paired(&forged.to_string()).expect_err("not the pinned gateway");
    assert_eq!(impostor.code(), wire::ErrorCode::Unauthorized, "{impostor}");
    assert_eq!(tokens(&other), 0, "nothing paired with the other machine");
    assert_eq!(destinations(&phone), 0);

    // A CODE SPENT BY ONE VAULT IS REFUSED TO ANOTHER.
    let code = gateway.payload();
    pair_with(&phone, &code);
    let other_dir = tempfile::tempdir().expect("a directory");
    let second = phone_with(other_dir.path(), |config| config.with_seed(seed(), 1));
    let spent = try_ask(
        &second,
        wire::request::Kind::PairPhone(wire::PairRequest {
            payload: code.clone(),
        }),
    )
    .expect_err("a spent code");
    assert_eq!(spent.code(), wire::ErrorCode::Unauthorized, "{spent}");
    assert_eq!(destinations(&second), 0, "the refused phone keeps nothing");
    assert_eq!(destinations(&phone), 1);
}

/// **A GATEWAY ASLEEP WHEN THE PASS BEGINS, THEN WOKEN UP ON ANOTHER PORT**
/// (#1080, B1). Nothing is sealed for nobody, nothing is confirmed, and what
/// waits waits for the gateway; the gateway restarts over the same data
/// directory and the next pass finishes.
#[test]
fn a_gateway_asleep_when_the_pass_begins_is_waited_for() {
    let gateway = gateway();
    let relay = Relay::to(gateway.spawned.addr);
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair_through(&phone, &gateway, &relay);
    drain(&phone, at_home());
    originals(&phone, "taken while the laptop slept", 3, 30_000);

    relay.cut();
    let asleep = drain(&phone, quietly());
    assert_eq!(
        asleep.stopped,
        wire::DrainStop::Unreachable as i32,
        "{asleep:?}"
    );
    assert_eq!(asleep.confirmed_parts, 0);
    let waits = status(&phone);
    assert_eq!(
        waiting(&waits, wire::WaitReason::Gateway),
        3,
        "{:?}",
        waits.waiting
    );

    let gateway = gateway.restart();
    relay.retarget(gateway.spawned.addr);
    relay.mend();
    let awake = drain(&phone, quietly());
    assert_eq!(awake.stopped, wire::DrainStop::Empty as i32, "{awake:?}");
    assert_eq!(awake.confirmed_parts, 3);
    assert_eq!(
        waiting(&status(&phone), wire::WaitReason::Window),
        3,
        "the rows wait"
    );
    drain(
        &phone,
        wire::DrainRequest {
            asked: true,
            ..at_home()
        },
    );
    assert!(status(&phone).waiting.is_empty());
}

/// **KILLED AFTER SEALING, BEFORE MOVING** (#1080, B2). A metered pass seals
/// originals it may not move; the phone dies; the next core moves exactly
/// those parts, once each.
#[test]
fn a_phone_killed_after_sealing_moves_its_spool_next_time() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    drain(&phone, at_home());
    originals(&phone, "sealed on cellular", 3, 40_000);
    let sealed = drain(
        &phone,
        wire::DrainRequest {
            metered: true,
            ..quietly()
        },
    );
    assert_eq!(sealed.confirmed_parts, 0, "{sealed:?}");
    assert_eq!(ledger(&path).queued().expect("reads").len(), 3);
    drop(phone);

    let phone = reopen(&path);
    let moved = drain(&phone, quietly());
    assert_eq!(moved.stopped, wire::DrainStop::Empty as i32, "{moved:?}");
    assert_eq!(moved.confirmed_parts, 3, "each sealed part once");
    assert!(ledger(&path).queued().expect("reads").is_empty());
    assert_eq!(
        gateway.held(&vault_id()),
        ledger(&path).confirmed_names(&id).expect("reads")
    );
    assert!(spooled(dir.path()).is_empty());
}

/// **KILLED AFTER THE OPERATING SYSTEM MOVED A PART, BEFORE IT SETTLED**
/// (#1080, B2). iOS uploaded a handed-off part while the app was dead and
/// its report never reached the core. The next core's first pass asks the
/// gateway, confirms the part and frees its spool file, sending nothing
/// again.
#[test]
fn a_part_the_os_moved_unsettled_is_confirmed_by_the_next_core() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    drain(&phone, at_home());
    originals(&phone, "moved by the operating system", 2, 40_000);
    drain(
        &phone,
        wire::DrainRequest {
            metered: true,
            ..quietly()
        },
    );
    let wire::response::Kind::Handoff(batch) = ask(
        &phone,
        wire::request::Kind::Handoff(wire::HandoffRequest {
            max_bytes: 64 << 20,
            max_parts: 16,
        }),
    ) else {
        panic!("a handoff answers");
    };
    assert_eq!(batch.parts.len(), 2);
    // THE OPERATING SYSTEM UPLOADS EACH, as handed; nobody settles.
    let token: centraid_gateway::rules::ids::Token = ledger(&path)
        .destination(&id)
        .expect("reads")
        .expect("paired")
        .token
        .parse()
        .expect("a token");
    let client = gateway.spawned.client(token);
    for part in &batch.parts {
        let digest = part
            .headers
            .iter()
            .find(|header| header.name == "content-digest")
            .map(|header| {
                centraid_gateway::rules::ids::Digest::from_header(&header.value).expect("a digest")
            })
            .expect("a digest header");
        gateway
            .runtime
            .block_on(client.put_file(
                &vault_id(),
                &part.name.parse().expect("a name"),
                &digest,
                std::path::Path::new(&part.path),
            ))
            .expect("the gateway takes it");
    }
    drop(phone);

    let phone = reopen(&path);
    let next = drain(&phone, quietly());
    assert_eq!(next.stopped, wire::DrainStop::Empty as i32, "{next:?}");
    assert_eq!(next.confirmed_parts, 0, "nothing is sent again");
    assert!(ledger(&path).queued().expect("reads").is_empty());
    assert!(file_names(&phone).iter().all(|name| {
        ledger(&path)
            .confirmed_names(&id)
            .expect("reads")
            .contains(name)
    }));
    drain(
        &phone,
        wire::DrainRequest {
            asked: true,
            ..at_home()
        },
    );
    let backed = status(&phone);
    assert_eq!(
        backed.content_confirmed, backed.content_total,
        "{:?}",
        backed.waiting
    );
    assert!(spooled(dir.path()).is_empty());
}

/// **KILLED IN THE MIDDLE OF STAGING A LIBRARY ITEM** (#1080, B2). The item
/// was half streamed and half sealed into the spool's temp files when the
/// phone died; the next core sweeps them, the shell streams the item again,
/// and it backs up.
#[test]
fn a_phone_killed_mid_stage_leaves_nothing_and_stages_again() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let film = bytes_of("a film the phone died streaming", 3 << 20);
    let begin = || library("video/mp4", "lib-film-cut", &film, false);
    let wire::stage_response::Kind::Begun(begun) =
        stage_frame(&phone, wire::stage_request::Kind::Begin(begin()))
    else {
        panic!("begun");
    };
    for (seq, window) in film.chunks(512 * 1024).take(3).enumerate() {
        stage_frame(
            &phone,
            wire::stage_request::Kind::Chunk(wire::StageChunk {
                staging_id: begun.staging_id.clone(),
                seq: seq as u64,
                payload: window.to_vec(),
            }),
        );
    }
    drop(phone);
    let temps = || {
        std::fs::read_dir(dir.path().join("vault.spool"))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.file_name().to_string_lossy().ends_with(".partial"))
                    .count()
            })
            .unwrap_or(0)
    };

    let phone = reopen(&path);
    status(&phone);
    assert_eq!(temps(), 0, "the next core swept what the stream left");
    let staged = stage(&phone, begin(), &film);
    add_asset(&phone, &staged, "video");
    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    let backed = status(&phone);
    assert_eq!((backed.content_confirmed, backed.content_total), (1, 1));
}

/// **AN ITEM EDITED IN THE LIBRARY AFTER IT WAS BACKED UP** (#1080, B5). The
/// edit is another file, streamed again under the same identifier and marked
/// edited: it backs up beside the original, the original stays backed up,
/// and an edited item is never offered for deletion from the library.
#[test]
fn an_item_edited_after_backup_backs_up_beside_the_original() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let original = bytes_of("a photograph before the member edited it", 70_001);
    let first = stage(
        &phone,
        library("image/heic", "lib-edit", &original, false),
        &original,
    );
    add_asset(&phone, &first, "photo");
    drain(&phone, at_home());
    let edited = bytes_of("the same photograph, edited in the library", 69_001);
    let second = stage(
        &phone,
        library("image/heic", "lib-edit", &edited, true),
        &edited,
    );
    assert_ne!(first.content_hash, second.content_hash);
    add_asset(&phone, &second, "photo");
    let drained = drain(&phone, quietly());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    let backed = status(&phone);
    assert_eq!(
        (backed.content_confirmed, backed.content_total),
        (1, 2),
        "the edit's row waits for the next snapshot"
    );
    drain(
        &phone,
        wire::DrainRequest {
            asked: true,
            ..at_home()
        },
    );
    let backed = status(&phone);
    assert_eq!((backed.content_confirmed, backed.content_total), (2, 2));
    let wire::response::Kind::Releasable(offered) = ask(
        &phone,
        wire::request::Kind::Releasable(wire::ReleasableRequest { limit: 10 }),
    ) else {
        panic!("releasable answers");
    };
    assert!(
        offered.items.iter().all(|item| item.os_ref != "lib-edit"),
        "an edited item is never offered: {offered:?}"
    );
}

/// **TWO VAULTS ON ONE PHONE, ONE GATEWAY** (#1080, B7). Each vault's token
/// opens its own objects and none of the other's; the counts are each its
/// own; forgetting the gateway for one leaves the other's backup intact.
#[test]
fn two_vaults_on_one_gateway_cannot_reach_each_other() {
    let gateway = gateway();
    let (one_dir, two_dir) = (
        tempfile::tempdir().expect("a directory"),
        tempfile::tempdir().expect("a directory"),
    );
    let one = phone(one_dir.path());
    let two = phone_with(two_dir.path(), |config| config.with_seed(seed(), 1));
    let one_id = pair(&one, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    pair(&two, &gateway);
    originals(&one, "vault one's photograph", 2, 20_000);
    originals(&two, "vault two's photograph", 3, 20_000);
    drain(&one, at_home());
    drain(&two, at_home());
    let two_vault = centraid_core::phone::Keyring::derive(&seed(), 1)
        .expect("keys")
        .vault_id();
    assert_ne!(two_vault, vault_id());
    assert_eq!(status(&one).content_confirmed, 2);
    assert_eq!(status(&two).content_confirmed, 3);

    // VAULT ONE'S TOKEN AGAINST VAULT TWO'S OBJECTS.
    let token: centraid_gateway::rules::ids::Token = ledger(&one_dir.path().join("vault.db"))
        .destination(&one_id)
        .expect("reads")
        .expect("paired")
        .token
        .parse()
        .expect("a token");
    let client = gateway.spawned.client(token);
    let theirs: Vec<centraid_gateway::rules::ids::Name> = gateway
        .held(&two_vault)
        .iter()
        .map(|name| centraid_gateway::rules::ids::Name::from_bytes(*name.as_bytes()))
        .collect();
    let unauthorized = |outcome: Result<(), centraid_gateway::client::ClientError>| {
        matches!(
            outcome,
            Err(centraid_gateway::client::ClientError::Refused(
                centraid_gateway::rules::code::Refusal::Unauthorized
            ))
        )
    };
    let runtime = &gateway.runtime;
    assert!(unauthorized(
        runtime
            .block_on(client.exists(&two_vault, &theirs))
            .map(|_| ())
    ));
    assert!(unauthorized(
        runtime
            .block_on(client.get(&two_vault, &theirs[0], None))
            .map(|_| ())
    ));
    assert!(unauthorized(
        runtime
            .block_on(client.objects(&two_vault, None, 10))
            .map(|_| ())
    ));
    assert!(unauthorized(
        runtime
            .block_on(client.delete(&two_vault, &theirs))
            .map(|_| ())
    ));
    let planted = bytes_of("planted in another vault", 100);
    assert!(unauthorized(
        runtime
            .block_on(client.put(
                &two_vault,
                &theirs[0],
                &centraid_gateway::rules::ids::Digest::of(&planted),
                planted.clone(),
            ))
            .map(|_| ())
    ));
    let held_two = gateway.held(&two_vault);

    // FORGETTING THE GATEWAY FOR VAULT ONE LEAVES VAULT TWO'S BACKUP.
    assert!(forget(&one, &one_id).forgotten);
    assert_eq!(gateway.held(&two_vault), held_two);
    originals(&two, "vault two goes on", 1, 20_000);
    let next = drain(&two, at_home());
    assert_eq!(next.stopped, wire::DrainStop::Empty as i32, "{next:?}");
    assert_eq!(status(&two).content_confirmed, 4);
}
