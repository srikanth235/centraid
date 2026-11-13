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
        "note.create",
        &json!({ "title": title, "body": body, "format": "plain" }),
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
        add_asset(&old, &staged, "photo");
        let thumb_handle = stage(&old, thumb_of(&staged, &thumb), &thumb);
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
    // THE ANSWER SAYS HOW MANY CAME BACK OF HOW MANY (#1188): the vault is kept first, then the
    // grid is fetched, and a damaged one is the one that did not land.
    assert_eq!(restored.vaults[0].derivatives_total, 3, "{restored:?}");
    assert_eq!(restored.vaults[0].derivatives_landed, 2, "{restored:?}");
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
    let head = head_of(&old_path, &id);
    let manifest = manifest_at(&gateway, &head);
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
    // The scan shares one connection now (#1188), so far fewer answered bytes are spent before the
    // fetch begins: the budget is what lets the handshake and the head through, and cuts the fetch.
    gateway.cable().cut_after_answers(16 * 1024);
    let cut =
        try_restore(new_dir.path(), &gateway.payload()).expect_err("the gateway went mid-fetch");
    assert_eq!(cut.code(), wire::ErrorCode::PeerUnreachable, "{cut}");
    assert!(
        nothing_laid_down(new_dir.path()).is_empty(),
        "{:?}",
        nothing_laid_down(new_dir.path())
    );
    assert_eq!(gateway.writer(&vault_id()).0, 1, "no epoch was spent");

    gateway.cable().mend();
    let restored = try_restore(new_dir.path(), &gateway.payload())
        .unwrap_or_else(|error| panic!("the next restore finishes: {error}"));
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    assert_eq!(gateway.writer(&vault_id()).0, 2, "one claim");
}

/// **A RESTORE KILLED AFTER ITS CLAIM, BEFORE IT KEPT THE VAULT, IS FINISHED
/// BY THE NEXT ONE** (#1080, R3). The claim landed and the ledger holds the
/// token it answered, but the phone died before the vault was named
/// `vault.db`. The next restore lays the vault down again over what was left
/// and claims once more, since nothing tells it the first claim's ledger was
/// finished; the half-kept ledger does not survive into the vault it keeps.
#[test]
fn a_restore_killed_after_its_claim_is_finished_by_the_next_one() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old_path = old_dir.path().join("vault.db");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Before", "written before the phone was lost");
    drain(&old, at_home());

    let new_dir = tempfile::tempdir().expect("a directory");
    let first = restore(new_dir.path(), &gateway);
    assert_eq!(first.vaults.len(), 1, "{first:?}");
    assert_eq!(gateway.writer(&vault_id()).0, 2);
    // KILLED BEFORE ITS LAST STEP: what adopt() leaves before the rename.
    let kept = PathBuf::from(&first.vaults[0].path);
    std::fs::rename(&kept, kept.with_file_name("vault.db.restoring")).expect("renames");

    let again = restore(new_dir.path(), &gateway);
    assert_eq!(again.vaults.len(), 1, "the vault comes back: {again:?}");
    assert_eq!(PathBuf::from(&again.vaults[0].path), kept);
    assert_eq!(gateway.writer(&vault_id()).0, 3, "claimed once more");
    assert_eq!(rows(&kept), rows(&old_path), "row for row");
    let refused = try_drain(&old, quietly()).expect_err("the old phone is fenced");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    let phone = reopen(&kept);
    note(&phone, "After", "written on the restored phone");
    let next = drain(&phone, at_home());
    assert!(next.acked_at_ms.is_some(), "it backs up: {next:?}");
}

/// **A GATEWAY THAT DIES AFTER THE CLAIM LEAVES THE RESTORED VAULT** (#1080,
/// R3). The claim landed, so the old phone is fenced; the vault was checked
/// before it, so it is kept, and the grid the gateway took with it is fetched
/// on demand. Neither phone is left without the vault, and once the gateway
/// is back the restored phone backs up at the epoch it claimed — no second
/// claim is spent.
#[test]
fn a_gateway_that_dies_after_the_claim_leaves_the_restored_vault() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old_path = old_dir.path().join("vault.db");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    let mut thumbs = Vec::new();
    for index in 0..12 {
        let photo = bytes_of(&format!("photograph {index}"), 20_000);
        let staged = stage(&old, owned("image/heic", &photo), &photo);
        let thumb = bytes_of(&format!("thumbnail {index}"), 30_000);
        add_asset(&old, &staged, "photo");
        thumbs.push(stage(&old, thumb_of(&staged, &thumb), &thumb).content_hash);
    }
    drain(&old, at_home());

    let new_dir = tempfile::tempdir().expect("a directory");
    let runtime = runtime();
    let restored = centraid_core::phone::restore::run_observed(
        &new_dir.path().join("custody.db"),
        &wire::RestoreRequest {
            phrase: WORDS.to_owned(),
            payload: gateway.payload(),
            ..wire::RestoreRequest::default()
        },
        runtime.handle(),
        // THE GATEWAY GOES once the claim's answer is through, before the
        // grid's 360 KB.
        &mut |_| gateway.cable().cut_after_answers(8 * 1024),
    )
    .unwrap_or_else(|error| panic!("the claim landed and the vault is kept: {error}"));
    keep_restored(&restored);
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    assert_eq!(gateway.writer(&vault_id()).0, 2, "one claim");
    let path = PathBuf::from(&restored.vaults[0].path);
    assert_eq!(rows(&path), rows(&old_path), "row for row");
    let bytes = centraid_blobs::ByteStore::open(path.with_extension("bytes")).expect("opens");
    let landed = thumbs
        .iter()
        .filter(|hash| {
            bytes
                .read(centraid_blobs::ContentHash::parse_hex(hash).expect("hex"))
                .is_ok()
        })
        .count();
    assert!(landed < thumbs.len(), "the gateway went mid-grid");

    gateway.cable().mend();
    let refused = try_drain(&old, quietly()).expect_err("the old phone is fenced");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    let phone = reopen(&path);
    note(&phone, "After", "written on the restored phone");
    let next = drain(&phone, at_home());
    assert!(next.acked_at_ms.is_some(), "it backs up: {next:?}");
    assert_eq!(gateway.writer(&vault_id()).0, 2, "at the epoch it claimed");
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
            .get("note")
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

/// The vault restored from `gateway` onto a new phone in `dir`, which then
/// took a photograph and wrote a note and backed both up: everything the old
/// phone's copy does not hold. Answers the new phone and the photograph's
/// object at the gateway.
fn moved_on(
    gateway: &Gateway,
    dir: &std::path::Path,
) -> (centraid_core::Handle, centraid_vault::backup::naming::Name) {
    let new = reopen(&PathBuf::from(&restore(dir, gateway).vaults[0].path));
    let photo = bytes_of("a photograph only the new phone took", 50_000);
    let staged = stage(&new, owned("image/heic", &photo), &photo);
    add_asset(&new, &staged, "photo");
    note(&new, "Newer", "written on the new phone after the restore");
    let backed = drain(&new, at_home());
    assert!(backed.acked_at_ms.is_some(), "{backed:?}");
    let object = centraid_vault::backup::naming::Name::from_bytes(
        *gateway_name(&staged.content_hash, 0).as_bytes(),
    );
    assert!(gateway.held(&vault_id()).contains(&object));
    (new, object)
}

/// The new phone is still the writer: it backs up what it writes next, at the
/// writer epoch it holds, and the gateway still holds its photograph.
fn goes_on_writing(
    new: &centraid_core::Handle,
    gateway: &Gateway,
    object: &centraid_vault::backup::naming::Name,
) {
    let epoch = gateway.writer(&vault_id()).0;
    note(new, "Newest", "written after the old phone tried to pair");
    let next = drain(new, at_home());
    assert!(
        next.acked_at_ms.is_some(),
        "the new phone backs up: {next:?}"
    );
    assert_eq!(gateway.writer(&vault_id()).0, epoch, "still its epoch");
    assert!(gateway.held(&vault_id()).contains(object));
}

/// A pairing asked for through the core, as the Backup screen's "Add a
/// laptop" does.
fn try_pair(
    handle: &centraid_core::Handle,
    gateway: &Gateway,
) -> centraid_core::Result<wire::response::Kind> {
    try_ask(
        handle,
        wire::request::Kind::PairPhone(wire::PairRequest {
            payload: gateway.payload(),
        }),
    )
}

/// **A SUPERSEDED PHONE CANNOT TAKE THE VAULT BACK BY PAIRING** (#1080, R6;
/// the root's simulator repro). The new phone wrote after the restore; the
/// old one, frozen, paired the same gateway with a fresh code. A takeover
/// would have made its older copy the writer: its next pass set the head over
/// the new phone's, and retention then collected every file only the new
/// phone held. The pairing is refused `MOVED`, before anything is claimed or
/// cleared, with the way back in its sentence; the gateway's writer and head
/// stay the new phone's, the old phone stays frozen, and the new phone goes
/// on backing up.
#[test]
fn a_superseded_phone_that_pairs_again_is_refused() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Before", "written before the move");
    drain(&old, at_home());
    let new_dir = tempfile::tempdir().expect("a directory");
    let (new, object) = moved_on(&gateway, new_dir.path());
    let learned = try_drain(&old, quietly()).expect_err("superseded");
    assert_eq!(learned.code(), wire::ErrorCode::VaultMoved, "{learned}");
    assert!(status(&old).frozen);
    let writer = gateway.writer(&vault_id());

    let refused = try_pair(&old, &gateway).expect_err("a frozen phone takes nothing back");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    assert!(
        refused.sentence().contains("24 words"),
        "the way back is a restore: {}",
        refused.sentence()
    );
    assert_eq!(gateway.writer(&vault_id()), writer, "nothing was claimed");
    assert!(status(&old).frozen, "it stays frozen");
    let again = try_drain(&old, at_home()).expect_err("still superseded");
    assert_eq!(again.code(), wire::ErrorCode::VaultMoved, "{again}");
    assert_eq!(gateway.writer(&vault_id()), writer);
    goes_on_writing(&new, &gateway, &object);
}

/// **A SUPERSEDED PHONE CANNOT FORGET ITS WAY BACK EITHER** (#1080, R6).
/// Forgetting the gateway would take the row that carries the phone's `MOVED`
/// mark with it: the phone would read as no longer frozen, and its next
/// pairing would find no record of the gateway — the lost-ledger takeover —
/// and claim the vault with its older copy after all. The forget is refused
/// `MOVED`, the phone stays frozen, and pairing again is still refused.
#[test]
fn a_superseded_phone_cannot_forget_its_way_back() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    let id = pair(&old, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    note(&old, "Before", "written before the move");
    drain(&old, at_home());
    let new_dir = tempfile::tempdir().expect("a directory");
    let (new, object) = moved_on(&gateway, new_dir.path());
    let learned = try_drain(&old, quietly()).expect_err("superseded");
    assert_eq!(learned.code(), wire::ErrorCode::VaultMoved, "{learned}");
    let writer = gateway.writer(&vault_id());

    let forgot = try_ask(
        &old,
        wire::request::Kind::ForgetDestination(wire::ForgetDestinationRequest { gateway_id: id }),
    )
    .expect_err("a frozen phone keeps the record that freezes it");
    assert_eq!(forgot.code(), wire::ErrorCode::VaultMoved, "{forgot}");
    assert!(status(&old).frozen, "it stays frozen");
    drop(old);
    let old = reopen(&old_dir.path().join("vault.db"));
    assert!(status(&old).frozen, "and a relaunch knows it");
    let refused = try_pair(&old, &gateway).expect_err("still nothing taken back");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    assert_eq!(gateway.writer(&vault_id()), writer, "nothing was claimed");
    goes_on_writing(&new, &gateway, &object);
}

/// **AN OLD PHONE WHOSE PAIRING IS ITS FIRST CONTACT SINCE THE MOVE IS
/// REFUSED TOO** (#1080, R6). Nothing told it yet that it moved: no pass of
/// it has reached the gateway since the restore. Its ledger holds the gateway
/// at the epoch its token was minted at, and the gateway answers a higher
/// writer epoch — so its copy is older than the gateway's, and the pairing is
/// refused `MOVED` and freezes it, rather than claiming over the new phone.
#[test]
fn an_old_phone_whose_first_contact_is_a_pairing_is_refused() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Before", "written before the move");
    drain(&old, at_home());
    let new_dir = tempfile::tempdir().expect("a directory");
    let (new, object) = moved_on(&gateway, new_dir.path());
    assert!(!status(&old).frozen, "it has not heard yet");
    let writer = gateway.writer(&vault_id());

    let refused = try_pair(&old, &gateway).expect_err("its copy is older than the gateway's");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    assert_eq!(gateway.writer(&vault_id()), writer, "nothing was claimed");
    assert!(status(&old).frozen, "the pairing told it");
    let again = try_drain(&old, at_home()).expect_err("superseded");
    assert_eq!(again.code(), wire::ErrorCode::VaultMoved, "{again}");
    goes_on_writing(&new, &gateway, &object);
}

/// **A PHONE THAT LOST ITS LEDGER STILL TAKES ITS VAULT OVER** (#1080,
/// R-1080-C17). The vault's own phone lost its backup ledger — its record of
/// the gateway, its token, every acknowledgement — and pairs again with a
/// fresh code. Nothing on it says another phone superseded it, so it claims
/// the vault as ruled, and backs up from there.
#[test]
fn a_phone_that_lost_its_ledger_takes_its_vault_over() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    note(&phone, "Before", "written before the ledger was lost");
    drain(&phone, at_home());
    drop(phone);
    let lost = centraid_vault::backup::state::DeviceState::path_for(&path);
    for suffix in ["", "-wal", "-shm"] {
        let mut file = lost.clone().into_os_string();
        file.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(file));
    }

    let phone = reopen(&path);
    pair(&phone, &gateway);
    assert_eq!(gateway.writer(&vault_id()).0, 2, "it claimed the vault");
    note(&phone, "After", "written once it took the vault over");
    let next = drain(&phone, at_home());
    assert!(next.acked_at_ms.is_some(), "it backs up: {next:?}");
    let restored_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(restored_dir.path(), &gateway);
    assert_eq!(
        rows(&PathBuf::from(&restored.vaults[0].path)),
        rows(&path),
        "the head is its vault, row for row"
    );
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
    // THE PASS THAT MOVED THE PHOTOGRAPH ALSO TOOK THE SNAPSHOT ITS ROW NEEDS
    // (R-1080-C15): its new ranges and manifest are the only other parts.
    assert_eq!(
        next.confirmed_parts - snapshot_parts_after(&gateway, &phone, &before),
        1,
        "the new photograph alone, besides the snapshot: {next:?}"
    );
    let snapshot_names = {
        let newest = head_of(
            &path,
            &state(&path).gateways().expect("reads")[0].gateway_id,
        );
        let mut names = manifest_at(&gateway, &newest).range_names();
        names.insert(newest);
        names
    };
    let added: Vec<_> = gateway
        .held(&vault_id())
        .difference(&before)
        .copied()
        .filter(|name| !snapshot_names.contains(name))
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
    let old_dir = tempfile::tempdir().expect("a directory");
    let old_path = old_dir.path().join("vault.db");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Records", "a vault of records and no files");
    drain(&old, at_home());
    let acknowledged = rows(&old_path);

    // A LATER PASS IS CUT SHORT: a photograph and a new note, half sent.
    let photo = bytes_of("a photograph the cut pass carried", 400_000);
    let staged = stage(&old, owned("image/heic", &photo), &photo);
    add_asset(&old, &staged, "photo");
    note(&old, "Unsent", "written before the cut");
    // The vault is a few ranges, so the cut falls inside the snapshot, before its head.
    gateway.cable().cut_after(4096);
    let cut = drain(&old, at_home());
    assert_eq!(cut.stopped, wire::DrainStop::Unreachable as i32, "{cut:?}");

    gateway.cable().mend();
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

/// **A RESTORED PHONE'S RE-WALK IS TOLD WHICH DERIVATIVES THE VAULT ALREADY
/// HOLDS** (#1080, the simulator run). The walk streams every library item
/// again, and finds `already_held` false — the original is the gateway's, not
/// the phone's — so it rendered and staged each photograph's thumbnail and
/// preview, which the restore had brought back with their rows. The stage
/// door now names the tiers the vault holds, rows and bytes both, so the shell
/// renders only the rest. A derivative whose bytes did not come back is not
/// held: the shell renders it, and staging replaces the row.
#[test]
fn a_restored_phones_walk_is_told_which_derivatives_the_vault_already_holds() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    let photo = bytes_of("a library photograph, with its two derivatives", 120_000);
    let original = stage(
        &old,
        library("image/heic", "lib-derived", &photo, false),
        &photo,
    );
    assert!(
        original.derivatives_held.is_empty(),
        "nothing is held for a photograph the vault has never seen: {original:?}"
    );
    add_asset(&old, &original, "photo");
    let thumb = bytes_of("its thumbnail", 4_000);
    let thumb_handle = stage(&old, thumb_of(&original, &thumb), &thumb);
    let preview = bytes_of("its preview", 9_000);
    let preview_handle = stage(
        &old,
        wire::StageBegin {
            tier: "preview".to_owned(),
            ..thumb_of(&original, &preview)
        },
        &preview,
    );
    drain(&old, at_home());

    let new_dir = tempfile::tempdir().expect("a directory");
    let path = PathBuf::from(&restore(new_dir.path(), &gateway).vaults[0].path);
    let phone = reopen(&path);
    let walked = stage(
        &phone,
        library("image/heic", "lib-derived", &photo, false),
        &photo,
    );
    assert!(
        !walked.already_held,
        "the original is the gateway's, not this phone's: {walked:?}"
    );
    assert_eq!(
        walked.derivatives_held,
        vec!["preview".to_owned(), "thumb".to_owned()],
        "the restore brought both back: {walked:?}"
    );

    // A DERIVATIVE WHOSE BYTES ARE NOT HERE IS NOT HELD, whatever its row says.
    let store = centraid_blobs::ByteStore::open(path.with_extension("bytes")).expect("opens");
    assert!(
        store
            .remove(
                centraid_blobs::ContentHash::parse_hex(&thumb_handle.content_hash).expect("a hash")
            )
            .expect("removes"),
        "the thumbnail was in the store"
    );
    let again = stage(
        &phone,
        library("image/heic", "lib-derived", &photo, false),
        &photo,
    );
    assert_eq!(
        again.derivatives_held,
        vec!["preview".to_owned()],
        "{again:?}"
    );
    assert_ne!(preview_handle.content_hash, thumb_handle.content_hash);
}

/// The three files that are a phone's backup ledger, removed: its record of
/// every gateway, its token and every acknowledgement.
fn lose_the_ledger(path: &std::path::Path) {
    let lost = centraid_vault::backup::state::DeviceState::path_for(path);
    for suffix in ["", "-wal", "-shm"] {
        let mut file = lost.clone().into_os_string();
        file.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(file));
    }
}

/// **A PHONE WITH NO RECORD OF THE GATEWAY, AND A COPY OLDER THAN THE HEAD,
/// TAKES NOTHING OVER** (#1080, the sweep's F4). The old phone was superseded
/// by a restore and lost its ledger as well, so nothing on it says it moved —
/// R-1080-C17 lets it claim. Its copy is older than the head the new phone
/// set, and a claim would put the vault back where it was and leave the new
/// phone's records out of the history. The claim first compares the head with
/// its own copy: the head was taken after the copy's last command and holds
/// commands the copy never ran, so the pairing is refused `MOVED`, nothing is
/// claimed, and the new phone goes on backing up.
#[test]
fn a_phone_with_no_record_of_the_gateway_and_an_older_copy_takes_nothing_over() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old_path = old_dir.path().join("vault.db");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Before", "written before the move");
    drain(&old, at_home());
    let new_dir = tempfile::tempdir().expect("a directory");
    let (new, object) = moved_on(&gateway, new_dir.path());
    let writer = gateway.writer(&vault_id());
    let held = gateway.held(&vault_id());

    // THE OLD PHONE LOSES ITS LEDGER: nothing on it records the gateway, so
    // nothing tells it that another phone superseded it.
    drop(old);
    lose_the_ledger(&old_path);
    let old = reopen(&old_path);
    let refused = try_pair(&old, &gateway).expect_err("its copy is older than the head");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    assert_eq!(gateway.writer(&vault_id()), writer, "nothing was claimed");
    assert_eq!(gateway.held(&vault_id()), held, "no object moved");
    goes_on_writing(&new, &gateway, &object);

    // THE NEW PHONE'S RECORDS ARE WHAT A RESTORE BRINGS BACK, the newest note
    // included: the head never regressed.
    let restored_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(restored_dir.path(), &gateway);
    let restored_rows = rows(&PathBuf::from(&restored.vaults[0].path));
    let new_rows = rows(new.path());
    assert_eq!(
        restored_rows, new_rows,
        "the newer phone's vault, row for row"
    );
}

/// **A COPY THAT RAN COMMANDS AFTER THE HEAD WAS TAKEN STILL TAKES ITS VAULT
/// OVER** (#1080, the sweep's F4, the other side of the comparison). The
/// head's `taken_at_ms` is the cheap gate: a phone whose last command ran
/// after it is not behind it, so a lost ledger costs the vault's own phone
/// nothing — and, with the head equal to its copy (the case above this one
/// in the file), the manifest's receipts say the same.
#[test]
fn a_copy_that_ran_commands_after_the_head_still_takes_its_vault_over() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let path = dir.path().join("vault.db");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    note(&phone, "Before", "written before the last snapshot");
    drain(&phone, at_home());
    note(&phone, "After", "written after the last snapshot");
    drop(phone);
    lose_the_ledger(&path);

    let phone = reopen(&path);
    pair(&phone, &gateway);
    assert_eq!(gateway.writer(&vault_id()).0, 2, "it claimed the vault");
    let next = drain(&phone, at_home());
    assert!(next.acked_at_ms.is_some(), "it backs up: {next:?}");
    let restored_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(restored_dir.path(), &gateway);
    assert_eq!(
        rows(&PathBuf::from(&restored.vaults[0].path)),
        rows(&path),
        "the head is its vault, row for row, the note written last included"
    );
}

/// **THE SAME PHONE REPLACES ITS OLDER COPY AND IS NEVER FROZEN** (#1173, item
/// 22). A phone that holds an older copy of a vault the gateway has a newer head
/// for restores it: the head is laid down over the copy, the vault is claimed,
/// and the copy gives way. The "moved to your other phone" freeze is for a real
/// move to a phone that is not this one, so this phone backs up afterwards.
#[test]
fn restoring_onto_a_phone_that_holds_an_older_copy_replaces_it_and_freezes_nothing() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Before", "written before the copy");
    drain(&old, at_home());

    // The phone restores once and holds the copy.
    let here = tempfile::tempdir().expect("a directory");
    let first = restore(here.path(), &gateway);
    let held = PathBuf::from(&first.vaults[0].path);
    let backup = tempfile::tempdir().expect("a directory");
    let older = backup.path().join("vault.db");
    std::fs::copy(&held, &older).expect("the copy");
    let older_ledger = centraid_vault::backup::state::DeviceState::path_for(&older);
    std::fs::copy(
        centraid_vault::backup::state::DeviceState::path_for(&held),
        &older_ledger,
    )
    .expect("the ledger");

    // It goes on, writes and backs up: the gateway holds a newer head.
    let phone_now = reopen(&held);
    note(&phone_now, "After", "written after the copy");
    assert!(drain(&phone_now, at_home()).acked_at_ms.is_some());
    let newer_rows = rows(&held);
    drop(phone_now);

    // The older copy comes back over the newer file, as a restored device
    // backup would put it there.
    for suffix in ["", "-wal", "-shm"] {
        let mut gone = held.clone().into_os_string();
        gone.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(gone));
    }
    std::fs::copy(&older, &held).expect("the older copy is back");
    std::fs::copy(
        &older_ledger,
        centraid_vault::backup::state::DeviceState::path_for(&held),
    )
    .expect("its ledger");
    assert_ne!(rows(&held), newer_rows, "the held copy is the older one");

    let again = restore(here.path(), &gateway);
    assert_eq!(
        again.vaults.len(),
        1,
        "the held vault is restored: {again:?}"
    );
    assert_eq!(PathBuf::from(&again.vaults[0].path), held);
    assert_eq!(rows(&held), newer_rows, "the older copy was replaced");
    let phone_after = reopen(&held);
    assert!(
        !status(&phone_after).frozen,
        "the same phone is not told it moved"
    );
    note(&phone_after, "Later", "written after the replacement");
    let next = drain(&phone_after, at_home());
    assert!(next.acked_at_ms.is_some(), "it backs up: {next:?}");
}

/// **A COPY THAT RAN WRITES ITS BACKUP LACKS IS NOT REPLACED** (#1173, item 22). The ruling
/// replaces an OLDER copy; one this phone has written to since its last backup is the newer, and a
/// restore over it would lose those writes. It is left as it is and answered as unclaimed, and the
/// gateway's writer is not moved.
#[test]
fn restoring_onto_a_phone_whose_copy_is_newer_than_the_backup_leaves_that_copy_alone() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Before", "written before");
    drain(&old, at_home());

    let here = tempfile::tempdir().expect("a directory");
    let first = restore(here.path(), &gateway);
    let held = PathBuf::from(&first.vaults[0].path);
    let epoch = gateway.writer(&vault_id()).0;

    // The phone writes and does not back up.
    let phone_now = reopen(&held);
    note(&phone_now, "Unbacked", "written since the last backup");
    drop(phone_now);
    let with_the_note = rows(&held);

    let again = restore(here.path(), &gateway);
    assert!(again.vaults.is_empty(), "nothing was replaced: {again:?}");
    assert_eq!(again.unclaimed.len(), 1, "{again:?}");
    assert!(again.unclaimed[0].reason.contains("newer"), "{again:?}");
    assert_eq!(rows(&held), with_the_note, "the copy kept its writes");
    assert_eq!(gateway.writer(&vault_id()).0, epoch, "no claim was made");
}

fn mentions(path: &std::path::Path, text: &str) -> bool {
    rows(path)
        .values()
        .any(|table| table.iter().any(|row| row.contains(text)))
}

/// **A NEWEST BACKUP THAT WILL NOT OPEN IS NOT THE END; AN OLDER ONE IS OFFERED, NEVER TAKEN
/// SILENTLY** (#1188, B5, NB4). The first restore claims nothing and says what it found; the
/// second, after the member's yes, restores the older backup and the gateway's head follows it;
/// and with every backup damaged the restore says so and moves nothing.
#[test]
fn an_older_backup_is_offered_when_the_newest_will_not_open() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old_path = old_dir.path().join("vault.db");
    // THE VAULT'S CLOCK IS HELD, so the two backups fall on different days and the history
    // keeps both.
    let clock = std::sync::Arc::new(centraid_vault::clock::FixedClock::frozen());
    let old = {
        let clock = std::sync::Arc::clone(&clock);
        phone_with(old_dir.path(), move |config| {
            config.with_clock(
                clock.clone(),
                std::sync::Arc::new(centraid_vault::clock::ClockIds::new(Box::new(clock))),
            )
        })
    };
    let id = pair(&old, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    note(&old, "First", "kept in the older backup");
    drain(&old, at_home());
    let older = head_of(&old_path, &id);
    clock.advance_days(2);
    note(&old, "Second", "only in the newest backup");
    drain(&old, at_home());
    let newest = head_of(&old_path, &id);
    assert_ne!(older, newest, "two backups");

    let store = gateway.spawned.shared().store();
    let file_of = |name: centraid_vault::backup::naming::Name| {
        store.path(
            &vault_id(),
            &centraid_gateway::rules::ids::Name::from_bytes(*name.as_bytes()),
        )
    };
    let sound = std::fs::read(file_of(newest)).expect("reads");
    Damage::Flip.apply(&file_of(newest));

    // THE OFFER: nothing restored, nothing claimed, nothing laid down.
    let asked = tempfile::tempdir().expect("a directory");
    let offered = restore(asked.path(), &gateway);
    assert!(offered.vaults.is_empty(), "{offered:?}");
    assert_eq!(offered.older_offers.len(), 1, "{offered:?}");
    let offer = &offered.older_offers[0];
    assert!(
        offer.offered_taken_at_ms < offer.newest_taken_at_ms,
        "{offer:?}"
    );
    assert_eq!(offer.device, "127.0.0.1");
    assert!(nothing_laid_down(asked.path()).is_empty());
    assert_eq!(gateway.writer(&vault_id()), (1, Some(newest)), "no claim");

    // THE MEMBER SAYS YES.
    let took = try_ask(
        &shelf(asked.path()),
        wire::request::Kind::Restore(wire::RestoreRequest {
            phrase: WORDS.to_owned(),
            payload: gateway.payload(),
            use_older: true,
            ..wire::RestoreRequest::default()
        }),
    )
    .expect("restores");
    let wire::response::Kind::Restore(took) = took else {
        panic!("a restore answers as a restore");
    };
    assert_eq!(took.vaults.len(), 1, "{took:?}");
    assert!(took.older_offers.is_empty());
    let path = PathBuf::from(&took.vaults[0].path);
    assert!(mentions(&path, "First"));
    assert!(
        !mentions(&path, "Second"),
        "the older backup has no later note"
    );
    assert_eq!(
        gateway.writer(&vault_id()),
        (2, Some(older)),
        "the head follows the backup that was restored"
    );

    // WITH EVERY BACKUP DAMAGED THERE IS NOTHING TO OFFER.
    std::fs::write(file_of(newest), sound).expect("mends");
    Damage::Flip.apply(&file_of(newest));
    Damage::Flip.apply(&file_of(older));
    let none = tempfile::tempdir().expect("a directory");
    let refused = try_restore(none.path(), &gateway.payload()).expect_err("nothing opens");
    assert_eq!(
        refused.code(),
        wire::ErrorCode::BackupUnreadable,
        "{refused}"
    );
    assert!(nothing_laid_down(none.path()).is_empty());
}

/// Where a restore laid a vault down, by the file it keeps until the claim is adopted.
fn laid_down(dir: &std::path::Path) -> Option<PathBuf> {
    fn walk(dir: &std::path::Path) -> Option<PathBuf> {
        for entry in std::fs::read_dir(dir).ok()? {
            let path = entry.ok()?.path();
            if path.is_dir() {
                if let Some(found) = walk(&path) {
                    return Some(found);
                }
            } else if path
                .file_name()
                .is_some_and(|name| name == "vault.db.restoring")
            {
                return Some(path);
            }
        }
        None
    }
    walk(dir)
}

/// **A CLAIM THAT LANDED IS NEVER FORGOTTEN** (#1188, item 7). The gateway moved the writer to
/// this phone and froze the old one; adopting the vault then failed (here the ledger cannot be
/// written). The checked file stays, the answer names the vault as claimed and unfinished
/// (never "unclaimed" with the file deleted), and restoring again finishes it.
#[test]
fn a_claim_that_landed_is_never_forgotten_when_adopting_fails() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old_path = old_dir.path().join("vault.db");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Before", "written before the phone was lost");
    drain(&old, at_home());

    let new_dir = tempfile::tempdir().expect("a directory");
    let runtime = runtime();
    let mut broken = None;
    let first = centraid_core::phone::restore::run_hooked(
        &new_dir.path().join("custody.db"),
        &wire::RestoreRequest {
            phrase: WORDS.to_owned(),
            payload: gateway.payload(),
            ..wire::RestoreRequest::default()
        },
        runtime.handle(),
        &mut |_| {},
        &mut |_| {
            // THE CLAIM LANDED; the ledger's place is taken by a directory, so adopting fails.
            let file = laid_down(new_dir.path()).expect("the checked file is laid down");
            let ledger = centraid_vault::backup::state::DeviceState::path_for(
                &file.with_file_name("vault.db"),
            );
            std::fs::create_dir_all(&ledger).expect("a directory where the ledger goes");
            broken = Some(ledger);
        },
    )
    .expect("a claim that landed is answered, not refused");
    assert!(first.vaults.is_empty(), "{first:?}");
    assert_eq!(first.unclaimed.len(), 1, "{first:?}");
    assert!(
        first.unclaimed[0].claimed,
        "the claim landed, and the answer says so: {first:?}"
    );
    assert_eq!(gateway.writer(&vault_id()).0, 2, "the claim landed");
    let kept = laid_down(new_dir.path()).expect("the checked file was not forgotten");
    assert!(
        !kept.with_file_name("vault.db").exists(),
        "nothing reads as held yet"
    );
    let refused = try_drain(&old, quietly()).expect_err("the old phone is frozen");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");

    // THE MEMBER RESTORES AGAIN, naming the vault, and it is finished.
    std::fs::remove_dir_all(broken.expect("the hook ran")).expect("the way is clear");
    let again = centraid_core::phone::restore::run(
        &new_dir.path().join("custody.db"),
        &wire::RestoreRequest {
            phrase: WORDS.to_owned(),
            payload: gateway.payload(),
            indices: first.unclaimed.iter().map(|vault| vault.index).collect(),
            ..wire::RestoreRequest::default()
        },
        runtime.handle(),
    )
    .expect("restores again");
    assert_eq!(again.vaults.len(), 1, "{again:?}");
    assert!(again.unclaimed.is_empty(), "{again:?}");
    assert_eq!(rows(&PathBuf::from(&again.vaults[0].path)), rows(&old_path));
}

/// **A SCAN HANDSHAKES ONCE, NOT ONCE PER INDEX** (#1188, item 17). A restore asks about the
/// vault's index and twenty more past it; every question was a new TCP and TLS connection.
#[test]
fn a_restore_scan_reuses_one_connection() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    note(&old, "Before", "written before the phone was lost");
    drain(&old, at_home());
    let before = gateway.cable().connections();

    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    assert!(
        restored.gap_scanned >= 20,
        "the scan walked the gap: {restored:?}"
    );
    let dialled = gateway.cable().connections() - before;
    assert!(
        dialled <= 3,
        "{} indices were asked about over {dialled} connections",
        restored.gap_scanned
    );
}
