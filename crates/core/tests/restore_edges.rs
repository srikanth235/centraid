//! A RESTORE AT ITS EDGES, THROUGH THE CORE'S DOORS, AGAINST A REAL GATEWAY
//! (#1080, the adversarial sweep).
//!
//! What a restore owes a member whatever goes wrong: words that are not
//! theirs are refused before anything is asked; damage on the gateway is
//! refused before any claim, so the old phone goes on backing up; a restore
//! cut short leaves nothing that stops the next one; and whoever claims last
//! is the one writer, with every phone it superseded frozen and saying so.

mod common;

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use centraid_api_proto::core_v1 as wire;
use serde_json::json;

use common::*;

fn note(handle: &centraid_core::Handle, title: &str, body: &str) {
    command(
        handle,
        "knowledge.create_note",
        &json!({ "title": title, "body_text": body, "format": "plain" }),
        &format!("note:{title}"),
    );
}

/// **A RESTORE KILLED BETWEEN ITS CHECK AND ITS CLAIM IS FINISHED BY THE
/// NEXT ONE** (#1080, R3). The first attempt fetched and checked the vault
/// and died before it claimed anything: no writer epoch moved, and the old
/// phone is still the writer. What it laid down must not read to the next
/// attempt as a vault this phone already holds, or that vault is never
/// claimed — the old phone goes on as the writer, and the new phone keeps a
/// copy nothing backs up.
#[test]
fn a_restore_killed_before_its_claim_is_finished_by_the_next_one() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old_path = old_dir.path().join("vault.db");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Before", "written before the phone was lost");
    drain(&old, at_home());

    let new_dir = tempfile::tempdir().expect("a directory");
    let runtime = runtime();
    let killed = std::panic::catch_unwind(AssertUnwindSafe(|| {
        centraid_core::phone::restore::run_observed(
            &new_dir.path().join("custody.db"),
            &wire::RestoreRequest {
                phrase: WORDS.to_owned(),
                payload: gateway.payload(),
                ..wire::RestoreRequest::default()
            },
            runtime.handle(),
            &mut |_| panic!("the phone dies between the check and the claim"),
        )
    }));
    assert!(killed.is_err(), "the first attempt died");
    assert_eq!(gateway.writer(&vault_id()).0, 1, "nothing was claimed");

    // THE MEMBER OPENS THE APP AGAIN AND RESTORES AGAIN.
    let restored = restore(new_dir.path(), &gateway);
    assert_eq!(
        restored.vaults.len(),
        1,
        "the vault comes back: {restored:?}"
    );
    assert_eq!(gateway.writer(&vault_id()).0, 2, "one claim, one epoch");
    let path = PathBuf::from(&restored.vaults[0].path);
    assert_eq!(rows(&path), rows(&old_path), "row for row");
    let refused = try_drain(&old, at_home()).expect_err("the old phone is superseded");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    let phone = reopen(&path);
    assert_eq!(
        status(&phone).destinations.len(),
        1,
        "the restored vault is paired"
    );
    let next = drain(&phone, at_home());
    assert!(
        next.acked_at_ms.is_some(),
        "the restored phone backs up: {next:?}"
    );
}

/// **ONE DAMAGED THUMBNAIL ON THE GATEWAY DOES NOT COST A RESTORE THE REST
/// OF THE GRID** (#1080, R2). The claim landed and every derivative comes
/// back in `fetch` bundles; a thumbnail whose object does not open is the one
/// the grid draws without — as for any derivative the gateway does not hold
/// — never the reason every derivative after it is not fetched.
#[test]
fn a_damaged_thumbnail_costs_a_restore_that_thumbnail_alone() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    let mut thumbs = Vec::new();
    for index in 0..3 {
        let photo = bytes_of(&format!("photograph {index}"), 60_000);
        let staged = stage(&old, owned("image/heic", &photo), &photo);
        let thumb = bytes_of(&format!("thumbnail {index}"), 4_000);
        let thumb_handle = stage(&old, thumb_of(&staged, &thumb), &thumb);
        add_asset(&old, &staged, "photo");
        thumbs.push((thumb_handle.content_hash, thumb));
    }
    drain(&old, at_home());
    // THE NEWEST THUMBNAIL'S OBJECT IS DAMAGED: it is fetched first.
    let (damaged, _) = thumbs.last().expect("three").clone();
    gateway
        .spawned
        .corrupt(&vault_id(), &gateway_name(&damaged, 0))
        .expect("a bit flips");

    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    let path = PathBuf::from(&restored.vaults[0].path);
    let bytes = centraid_blobs::ByteStore::open(path.with_extension("bytes")).expect("opens");
    for (hash, thumb) in &thumbs {
        let held = bytes
            .read(centraid_blobs::ContentHash::parse_hex(hash).expect("hex"))
            .ok();
        if *hash == damaged {
            assert!(held.is_none(), "nothing damaged lands");
        } else {
            assert_eq!(
                held.as_ref(),
                Some(thumb),
                "an undamaged thumbnail came back"
            );
        }
    }
}

/// **AN OLD PHONE LEARNS IT WAS SUPERSEDED AT ITS FIRST CONTACT, NOT ITS
/// FIRST WRITE** (#1080, R6; the root's simulator repro). Another phone
/// restored the vault and claimed the next writer epoch. The old phone's next
/// pass has nothing to write — no snapshot due, no new file — so no `PUT` is
/// ever refused `MOVED`; it reached the gateway and read as alive, taking
/// edits that could only ever be stranded. The gateway's head answers the
/// writer epoch on every read, and a pass now asks it at contact.
#[test]
fn an_old_phone_learns_it_moved_at_its_first_contact() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old_path = old_dir.path().join("vault.db");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Before", "written before the move");
    drain(&old, at_home());
    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    assert_eq!(restored.vaults.len(), 1);
    assert_eq!(gateway.writer(&vault_id()).0, 2);

    // THE OLD PHONE'S NEXT PASS: nothing to write.
    let refused = try_drain(&old, quietly()).expect_err("superseded, learned at contact");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    assert!(status(&old).frozen, "the old phone says it is frozen");
    drop(old);

    // AND A RELAUNCH OF IT KNOWS AT ONCE.
    let old = reopen(&old_path);
    assert!(status(&old).frozen);
    let again = try_drain(&old, quietly()).expect_err("still superseded");
    assert_eq!(again.code(), wire::ErrorCode::VaultMoved, "{again}");
}

/// Nothing a refused restore may leave on the new phone: every directory it
/// made, and every file in them.
fn nothing_laid_down(dir: &std::path::Path) -> Vec<String> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).expect("lists") {
        let path = entry.expect("an entry").path();
        if path.is_dir() {
            found.push(path.display().to_string());
        }
    }
    found
}

/// **WORDS THAT ARE NOT THE MEMBER'S ARE REFUSED BEFORE ANYTHING IS ASKED,
/// OR FIND NOTHING** (#1080, R1). A phrase with a bad checksum or the wrong
/// number of words is refused before any gateway is dialled; a valid phrase
/// of another seed derives vaults the gateway does not hold, and finds none.
/// Either way nothing is written on the phone, the gateway's writer epoch and
/// head do not move, and the old phone goes on backing up.
#[test]
fn words_that_are_not_the_members_change_nothing() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    drain(&old, at_home());
    let before = gateway.writer(&vault_id());
    let tokens_before = tokens(&gateway);

    let new_dir = tempfile::tempdir().expect("a directory");
    let ask_with = |phrase: &str| {
        try_ask(
            &shelf(new_dir.path()),
            wire::request::Kind::Restore(wire::RestoreRequest {
                phrase: phrase.to_owned(),
                payload: gateway.payload(),
                ..wire::RestoreRequest::default()
            }),
        )
    };
    let mut words: Vec<&str> = WORDS.split_whitespace().collect();
    words[23] = "abandon";
    let checksum = ask_with(&words.join(" ")).expect_err("a bad checksum");
    assert_eq!(
        checksum.code(),
        wire::ErrorCode::InvalidRequest,
        "{checksum}"
    );
    let short = ask_with(
        &WORDS
            .split_whitespace()
            .take(23)
            .collect::<Vec<_>>()
            .join(" "),
    )
    .expect_err("twenty-three words");
    assert_eq!(short.code(), wire::ErrorCode::InvalidRequest, "{short}");
    let another = centraid_identity::RecoveryPhrase::generate()
        .expect("words")
        .words()
        .collect::<Vec<_>>()
        .join(" ");
    let Ok(wire::response::Kind::Restore(nothing)) = ask_with(&another) else {
        panic!("another member's words are an answer");
    };
    assert!(nothing.vaults.is_empty(), "{nothing:?}");
    assert!(
        nothing_laid_down(new_dir.path()).is_empty(),
        "{:?}",
        nothing_laid_down(new_dir.path())
    );
    assert_eq!(gateway.writer(&vault_id()), before);
    assert_eq!(tokens(&gateway), tokens_before, "no grant was minted");
    let next = drain(&old, at_home());
    assert!(
        next.acked_at_ms.is_some(),
        "the old phone backs up: {next:?}"
    );
}

/// How the gateway's copy of one object is damaged.
#[derive(Debug, Clone, Copy)]
enum Damage {
    /// One bit flipped.
    Flip,
    /// Cut to half its length.
    Truncate,
    /// The file gone from `objects/`.
    Remove,
}

impl Damage {
    fn apply(self, file: &std::path::Path) {
        match self {
            Self::Flip => {
                let mut bytes = std::fs::read(file).expect("reads");
                let middle = bytes.len() / 2;
                bytes[middle] ^= 1;
                std::fs::write(file, bytes).expect("writes");
            }
            Self::Truncate => {
                let bytes = std::fs::read(file).expect("reads");
                std::fs::write(file, &bytes[..bytes.len() / 2]).expect("writes");
            }
            Self::Remove => std::fs::remove_file(file).expect("removes"),
        }
    }
}

/// **DAMAGE ON THE GATEWAY IS REFUSED BEFORE ANY CLAIM** (#1080, R2). A
/// flipped bit, a truncation or a missing file in a range or in the head's
/// manifest: the restore refuses, writes nothing that reads as a vault, and
/// moves no writer epoch — so the old phone is not frozen over a vault no
/// phone could restore, and goes on backing up.
#[test]
fn damage_on_the_gateway_is_refused_before_any_claim() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old_path = old_dir.path().join("vault.db");
    let old = phone(old_dir.path());
    let id = pair(&old, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    note(&old, "Before", "a note the damage must not cost");
    drain(&old, at_home());
    let book = ledger(&old_path);
    let head = book.head(&id).expect("reads").expect("a head");
    let taken = book
        .snapshots()
        .expect("reads")
        .into_iter()
        .find(|snapshot| snapshot.name == head)
        .expect("the head");
    let manifest =
        centraid_vault::backup::snapshot::Manifest::from_json(taken.manifest_json.as_bytes())
            .expect("a manifest");
    let range = manifest.ranges[manifest.ranges.len() / 2].name;
    let store = gateway.spawned.shared().store();
    let file_of = |name: centraid_vault::backup::naming::Name| {
        store.path(
            &vault_id(),
            &centraid_gateway::rules::ids::Name::from_bytes(*name.as_bytes()),
        )
    };
    for (what, name) in [("a range", range), ("the manifest", head)] {
        for damage in [Damage::Flip, Damage::Truncate, Damage::Remove] {
            let file = file_of(name);
            let sound = std::fs::read(&file).expect("reads");
            damage.apply(&file);
            let new_dir = tempfile::tempdir().expect("a directory");
            let refused = try_restore(new_dir.path(), &gateway.payload());
            assert!(refused.is_err(), "{damage:?} {what}: {refused:?}");
            assert!(
                nothing_laid_down(new_dir.path()).is_empty(),
                "{damage:?} {what} left {:?}",
                nothing_laid_down(new_dir.path())
            );
            assert_eq!(
                gateway.writer(&vault_id()),
                (1, Some(head)),
                "{damage:?} {what}: no claim"
            );
            std::fs::write(&file, sound).expect("mends");
        }
    }
    // SOUND AGAIN, it restores; and the old phone was never frozen.
    let next = drain(&old, quietly());
    assert_eq!(next.stopped, wire::DrainStop::Empty as i32, "{next:?}");
    let new_dir = tempfile::tempdir().expect("a directory");
    assert_eq!(restore(new_dir.path(), &gateway).vaults.len(), 1);
}

/// **A GATEWAY THAT DIES MID-FETCH LEAVES NOTHING THAT BLOCKS THE NEXT
/// RESTORE** (#1080, R3). The restore stops as unreachable with nothing laid
/// down and no epoch moved; once the gateway is back the next restore
/// finishes, claiming once.
#[test]
fn a_gateway_that_dies_mid_fetch_is_restored_from_next_time() {
    let gateway = gateway();
    let relay = Relay::to(gateway.spawned.addr);
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    for index in 0..40 {
        note(
            &old,
            &format!("note {index}"),
            &"a line of the vault ".repeat(200),
        );
    }
    drain(&old, at_home());

    let new_dir = tempfile::tempdir().expect("a directory");
    relay.cut_after_answers(64 * 1024);
    let cut = try_restore(new_dir.path(), &gateway.payload_at(relay.addr))
        .expect_err("the gateway went mid-fetch");
    assert_eq!(cut.code(), wire::ErrorCode::PeerUnreachable, "{cut}");
    assert!(
        nothing_laid_down(new_dir.path()).is_empty(),
        "{:?}",
        nothing_laid_down(new_dir.path())
    );
    assert_eq!(gateway.writer(&vault_id()).0, 1, "no epoch was spent");

    relay.mend();
    let restored = try_restore(new_dir.path(), &gateway.payload_at(relay.addr))
        .unwrap_or_else(|error| panic!("the next restore finishes: {error}"));
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    assert_eq!(gateway.writer(&vault_id()).0, 2, "one claim");
}

/// **TWO PHONES RESTORING ONE VAULT AT ONCE END WITH ONE WRITER** (#1080,
/// R4). Each checks the head and claims it; whichever claims last is the
/// writer, and the other's first pass is refused `MOVED` and freezes, saying
/// so. Neither is left believing it is the writer.
#[test]
fn two_phones_restoring_at_once_end_with_one_writer() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Shared", "the vault two phones restore at once");
    drain(&old, at_home());

    let dirs = [
        tempfile::tempdir().expect("a directory"),
        tempfile::tempdir().expect("a directory"),
    ];
    let restores: Vec<_> = dirs
        .iter()
        .map(|dir| {
            let path = dir.path().to_path_buf();
            let payload = gateway.payload();
            std::thread::spawn(move || try_restore(&path, &payload))
        })
        .collect();
    let answers: Vec<_> = restores
        .into_iter()
        .map(|thread| thread.join().expect("a restore thread"))
        .collect();
    let restored: Vec<PathBuf> = answers
        .iter()
        .filter_map(|answer| answer.as_ref().ok())
        .filter_map(|answer| answer.vaults.first())
        .map(|vault| PathBuf::from(&vault.path))
        .collect();
    assert!(!restored.is_empty(), "{answers:?}");
    let (epoch, _) = gateway.writer(&vault_id());
    assert_eq!(epoch, 1 + restored.len() as u64, "one claim each");

    let mut writers = 0;
    for path in &restored {
        let phone = reopen(path);
        match try_drain(&phone, at_home()) {
            Ok(drained) => {
                assert!(drained.acked_at_ms.is_some(), "{drained:?}");
                writers += 1;
            }
            Err(error) => {
                assert_eq!(error.code(), wire::ErrorCode::VaultMoved, "{error}");
                assert!(status(&phone).frozen, "the loser says it is frozen");
            }
        }
    }
    assert_eq!(writers, 1, "exactly one writer");
    let refused = try_drain(&old, at_home()).expect_err("the old phone is superseded");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved);
}

/// **A CHAIN OF RESTORES: A TO B TO C** (#1080, R5). B is frozen when C
/// claims, A stays frozen, and C backs up.
#[test]
fn a_chain_of_restores_freezes_every_phone_but_the_last() {
    let gateway = gateway();
    let a_dir = tempfile::tempdir().expect("a directory");
    let a = phone(a_dir.path());
    pair(&a, &gateway);
    note(&a, "Written on A", "the first phone");
    drain(&a, at_home());

    let b_dir = tempfile::tempdir().expect("a directory");
    let b = reopen(&PathBuf::from(
        &restore(b_dir.path(), &gateway).vaults[0].path,
    ));
    note(&b, "Written on B", "the second phone");
    assert!(drain(&b, at_home()).acked_at_ms.is_some());

    let c_dir = tempfile::tempdir().expect("a directory");
    let c_path = PathBuf::from(&restore(c_dir.path(), &gateway).vaults[0].path);
    let c = reopen(&c_path);
    assert_eq!(gateway.writer(&vault_id()).0, 3);
    for (who, phone) in [("A", &a), ("B", &b)] {
        let refused = try_drain(phone, at_home()).expect_err("superseded");
        assert_eq!(
            refused.code(),
            wire::ErrorCode::VaultMoved,
            "{who}: {refused}"
        );
        assert!(status(phone).frozen, "{who} says it is frozen");
    }
    note(&c, "Written on C", "the third phone");
    let drained = drain(&c, at_home());
    assert!(drained.acked_at_ms.is_some(), "C backs up: {drained:?}");
    assert!(
        rows(&c_path)
            .get("knowledge_note")
            .is_some_and(|notes| notes.len() == 3),
        "C holds what A and B wrote"
    );
}

/// **THE OLD PHONE AFTER A MOVE CHANGES NOTHING AT THE GATEWAY** (#1080, R6).
/// A pass and Back up now are refused `MOVED`, a handoff too, and the status
/// says frozen; the gateway's head, epoch and objects are what the new phone
/// left.
#[test]
fn the_old_phone_after_a_move_changes_nothing_at_the_gateway() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    drain(&old, at_home());
    let new_dir = tempfile::tempdir().expect("a directory");
    let new = reopen(&PathBuf::from(
        &restore(new_dir.path(), &gateway).vaults[0].path,
    ));
    drain(&new, at_home());
    let writer = gateway.writer(&vault_id());
    let held = gateway.held(&vault_id());

    let photo = bytes_of("a photograph taken on the old phone after the move", 50_000);
    let staged = stage(&old, owned("image/heic", &photo), &photo);
    add_asset(&old, &staged, "photo");
    for request in [
        at_home(),
        wire::DrainRequest {
            asked: true,
            ..at_home()
        },
    ] {
        let refused = try_drain(&old, request).expect_err("a moved phone's pass");
        assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    }
    let handoff = try_ask(
        &old,
        wire::request::Kind::Handoff(wire::HandoffRequest {
            max_bytes: 1 << 20,
            max_parts: 4,
        }),
    )
    .expect_err("a moved phone hands nothing off");
    assert_eq!(handoff.code(), wire::ErrorCode::VaultMoved, "{handoff}");
    assert!(status(&old).frozen);
    assert_eq!(gateway.writer(&vault_id()), writer);
    assert_eq!(gateway.held(&vault_id()), held, "no object moved");
}

/// **AFTER A RESTORE, NEW ITEMS GO AND NOTHING THE GATEWAY HOLDS GOES
/// AGAIN; AN ORIGINAL COMES BACK AS IT WAS, AND ONE THAT IS GONE SAYS SO**
/// (#1080, R7).
#[test]
fn after_a_restore_only_what_is_new_is_sent() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    let photo = bytes_of("an original from the lost phone", 300_000);
    let photo_handle = stage(&old, owned("image/heic", &photo), &photo);
    add_asset(&old, &photo_handle, "photo");
    let gone = bytes_of("an original the gateway will lose", 100_000);
    let gone_handle = stage(&old, owned("image/heic", &gone), &gone);
    add_asset(&old, &gone_handle, "photo");
    drain(&old, at_home());

    let new_dir = tempfile::tempdir().expect("a directory");
    let path = PathBuf::from(&restore(new_dir.path(), &gateway).vaults[0].path);
    let phone = reopen(&path);
    drain(&phone, at_home());
    let backed = status(&phone);
    assert_eq!(
        backed.content_confirmed, backed.content_total,
        "nothing to send"
    );
    let before = gateway.held(&vault_id());

    let fresh = bytes_of("taken on the restored phone", 80_000);
    let fresh_handle = stage(&phone, owned("image/heic", &fresh), &fresh);
    add_asset(&phone, &fresh_handle, "photo");
    let next = drain(&phone, quietly());
    assert_eq!(
        next.confirmed_parts, 1,
        "the new photograph alone: {next:?}"
    );
    let added: Vec<_> = gateway
        .held(&vault_id())
        .difference(&before)
        .copied()
        .collect();
    let fresh_name = centraid_vault::backup::naming::name(
        &keys().backup,
        &centraid_vault::backup::naming::PlaintextHash::from_hex(&fresh_handle.content_hash)
            .expect("a hash"),
        0,
    );
    assert_eq!(
        added,
        vec![fresh_name],
        "the new photograph and nothing else"
    );

    let fetch = |hash: &str| {
        let wire::response::Kind::FetchOriginal(fetched) = ask(
            &phone,
            wire::request::Kind::FetchOriginal(wire::FetchOriginalRequest {
                content_hash: hex::decode(hash).expect("hex"),
            }),
        ) else {
            panic!("a fetch answers");
        };
        fetched
    };
    let landed = fetch(&photo_handle.content_hash);
    assert_eq!(landed.outcome, wire::FetchOutcome::Landed as i32);
    assert_eq!(
        blake3::hash(&std::fs::read(&landed.path).expect("reads"))
            .to_hex()
            .to_string(),
        photo_handle.content_hash,
        "the source's BLAKE3"
    );
    std::fs::remove_file(
        gateway
            .spawned
            .shared()
            .store()
            .path(&vault_id(), &gateway_name(&gone_handle.content_hash, 0)),
    )
    .expect("the gateway loses it");
    assert_eq!(
        fetch(&gone_handle.content_hash).outcome,
        wire::FetchOutcome::NotInBackup as i32
    );
}

/// **A VAULT WITH NO FILES, AND ONE WHOSE LAST PASS WAS CUT SHORT** (#1080,
/// R8). The records alone restore; and what a restore brings back is the
/// last head the gateway acknowledged, with the counts the gateway holds.
#[test]
fn a_records_only_vault_and_a_cut_short_pass_restore_what_was_acknowledged() {
    let gateway = gateway();
    let relay = Relay::to(gateway.spawned.addr);
    let old_dir = tempfile::tempdir().expect("a directory");
    let old_path = old_dir.path().join("vault.db");
    let old = phone(old_dir.path());
    pair_with(&old, &gateway.payload_at(relay.addr));
    note(&old, "Records", "a vault of records and no files");
    drain(&old, at_home());
    let acknowledged = rows(&old_path);

    // A LATER PASS IS CUT SHORT: a photograph and a new note, half sent.
    let photo = bytes_of("a photograph the cut pass carried", 400_000);
    let staged = stage(&old, owned("image/heic", &photo), &photo);
    add_asset(&old, &staged, "photo");
    note(&old, "Unsent", "written before the cut");
    relay.cut_after(40 * 1024);
    let cut = drain(&old, at_home());
    assert_eq!(cut.stopped, wire::DrainStop::Unreachable as i32, "{cut:?}");

    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    let path = PathBuf::from(&restored.vaults[0].path);
    assert_eq!(rows(&path), acknowledged, "the last head acknowledged");
    let phone = reopen(&path);
    drain(&phone, quietly());
    let backed = status(&phone);
    assert_eq!(
        backed.content_confirmed, backed.content_total,
        "the restored phone counts what the gateway holds: {:?}",
        backed.waiting
    );
}
