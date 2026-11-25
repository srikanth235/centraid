//! Locker sealed files and the backup (#1214, K10, I7): bytes already encrypted under the Locker key
//! before they reach the blob store. Such a file is ALWAYS sent with a backup, whatever the member's
//! exclusions; its bytes are NEVER freed from the phone; no derivative is ever made from it.
//!
//! The Locker command module is not plugged in yet, so the item and its file field are written as
//! raw rows (the Locker lane has nothing to add here: the rule is read from the schema's own
//! `locker_item_field.value_blob` and from the version slot that names an earlier file).

mod backup_support;

use std::cell::RefCell;
use std::collections::BTreeSet;

use backup_support::{Rig, T0};
use centraid_media::sealed::PlaintextHash;
use centraid_vault::backup::files::content_files;
use centraid_vault::backup::restore::Restore;
use centraid_vault::backup::snapshot::Options;
use centraid_vault::backup::store::{MemoryStore, Store};
use centraid_vault::backup::tree::{self, EntryKind};
use centraid_vault::model::Kind;

const AT: &str = "2026-03-01T09:00:00.000Z";

fn claim(rig: &Rig, bytes: &[u8]) -> String {
    let hash = rig
        .vault()
        .blobs()
        .expect("a content store")
        .put(bytes)
        .expect("stores");
    rig.vault()
        .commit(|tx| {
            tx.connection().execute(
                "INSERT INTO blob (hash, size) VALUES (?1, ?2) ON CONFLICT (hash) DO NOTHING",
                rusqlite::params![hash, bytes.len() as i64],
            )?;
            Ok(())
        })
        .expect("a claim");
    hash
}

/// A Locker item with one sealed file field holding `bytes`; returns the item's id.
fn sealed_file(rig: &Rig, bytes: &[u8]) -> String {
    let hash = claim(rig, bytes);
    let id = rig.vault().ids().next();
    rig.vault()
        .commit(|tx| {
            let c = tx.connection();
            c.execute(
                "INSERT INTO locker_key (id, key_id, created_at) VALUES (1, 'k1', ?1)",
                [AT],
            )?;
            tx.insert_entity(&id, Kind::LockerItem, "Passport scan", AT)?;
            c.execute(
                "INSERT INTO locker_item (id, type) VALUES (?1, 'document')",
                [&id],
            )?;
            c.execute(
                "INSERT INTO locker_item_field (id, item_id, label, kind, value_sealed, value_blob,
                                               key_id, value_set_at, created_at, updated_at)
                 VALUES ('f-file', ?1, 'Scan', 'file', 'lk1:AAAA', ?2, 'k1', ?3, ?3, ?3)",
                rusqlite::params![id, hash, AT],
            )?;
            Ok(())
        })
        .expect("a sealed file");
    id
}

fn video(rig: &Rig, bytes: &[u8]) -> String {
    let hash = claim(rig, bytes);
    let id = rig.vault().ids().next();
    rig.vault()
        .commit(|tx| {
            tx.insert_entity(&id, Kind::Photo, "", AT)?;
            tx.connection().execute(
                "INSERT INTO photo (id, blob, media_type, form) VALUES (?1, ?2, 'video/mp4', 'video')",
                rusqlite::params![id, hash],
            )?;
            Ok(())
        })
        .expect("a video");
    hash
}

fn hash_of(bytes: &[u8]) -> PlaintextHash {
    PlaintextHash::from_hex(&centraid_vault::blob::content_digest(bytes)).expect("a hash")
}

/// Every exclusion on (a video exclusion, which is the rule a pass applies to originals): the
/// video original is left out of the tree and the sealed file is not.
#[test]
fn a_sealed_file_is_in_the_tree_with_every_exclusion_on() {
    let rig = Rig::new("sealed-tree");
    let (film, scan) = (
        b"a film ".repeat(200),
        b"lk1:sealed scan bytes ".repeat(100),
    );
    video(&rig, &film);
    sealed_file(&rig, &scan);
    let mut options = Options::at(T0);
    options.exclude_videos = true;
    let taken = rig.snapshot_with(options);
    let root = tree::root_of(&rig.state, &taken.root).expect("a root");
    let entries = tree::entries_of(&rig.state, &root.blobs).expect("entries");
    let sealed = entries
        .iter()
        .find(|e| e.h == hash_of(&scan))
        .expect("sealed entry");
    assert_eq!(sealed.kind, EntryKind::Original);
    assert!(
        !sealed.original.is_empty(),
        "its chunks are sealed for the gateway"
    );
    assert_eq!(sealed.media_type, "application/octet-stream");
    let film = entries
        .iter()
        .find(|e| e.h == hash_of(&film))
        .expect("film entry");
    assert_eq!(
        film.kind,
        EntryKind::ExcludedOriginal,
        "the exclusion applies to the film"
    );
}

/// The listing says what a sealed file is: opaque, an original, never a video, flagged sealed;
/// the same of an earlier version's file while the item lives.
#[test]
fn the_listing_flags_a_sealed_file_and_an_earlier_one_stays_flagged() {
    let rig = Rig::new("sealed-listing");
    let item = sealed_file(&rig, b"lk1:first file");
    let second = claim(&rig, b"lk1:second file");
    rig.vault()
        .commit(|tx| {
            tx.connection().execute(
                "UPDATE locker_item_field SET value_blob = ?1, value_sealed = 'lk1:BBBB',
                        updated_at = ?2 WHERE id = 'f-file'",
                rusqlite::params![second, AT],
            )?;
            Ok(())
        })
        .expect("replaced");
    let _ = item;
    let files = content_files(rig.vault()).expect("lists");
    let first = hash_of(b"lk1:first file");
    for hash in [first, hash_of(b"lk1:second file")] {
        let file = files.iter().find(|f| f.h == hash).expect("listed");
        assert!(file.sealed && file.is_original() && !file.video);
        assert_eq!(file.media_type, "application/octet-stream");
    }
    assert!(
        files.iter().filter(|f| f.sealed).count() == 2,
        "the earlier version's file and the current are the only sealed files"
    );
}

/// What reaches the gateway is the sealed bytes, byte for byte, under every exclusion; a restore
/// brings them back.
#[test]
fn a_sealed_file_crosses_to_the_gateway_and_back_with_every_exclusion_on() {
    let rig = Rig::new("sealed-restore");
    let (film, scan) = (
        b"a film ".repeat(200),
        b"lk1:sealed scan bytes ".repeat(100),
    );
    video(&rig, &film);
    sealed_file(&rig, &scan);
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 2);
    rig.pair(&store);
    let mut options = Options::at(T0);
    options.exclude_videos = true;
    let taken = rig.snapshot_with(options);
    let env = rig.env(T0);
    let pass = centraid_vault::backup::engine::GatewayPass::new(&env, &store as &dyn Store)
        .expect("a pass");
    centraid_vault::backup::engine::Scheduler::new(vec![pass], 8)
        .run(10_000)
        .expect("runs");

    let restore =
        Restore::open(&rig.keys, &[&store as &dyn Store], &taken.root.name).expect("opens");
    let brought: RefCell<BTreeSet<PlaintextHash>> = RefCell::new(BTreeSet::new());
    let dir = tempfile::tempdir().expect("a directory");
    let (_, _, originals) = restore
        .restore_all(
            &dir.path().join("vault.db"),
            &mut |_| Ok(()),
            &mut |entry, bytes| {
                assert_eq!(PlaintextHash::of(bytes), entry.h);
                brought.borrow_mut().insert(entry.h);
                Ok(())
            },
        )
        .expect("restores");
    assert_eq!(originals.restored, 1, "the sealed file and no film");
    assert!(brought.borrow().contains(&hash_of(&scan)));
    assert!(!brought.borrow().contains(&hash_of(&film)));
}

/// "Free up space" is offered only what is not in this set: a sealed file is in it whatever
/// albums the member kept, an earlier version's sealed file too.
#[test]
fn a_sealed_file_is_never_among_what_a_pass_may_free() {
    let rig = Rig::new("sealed-never-freed");
    sealed_file(&rig, b"lk1:first file");
    let second = claim(&rig, b"lk1:second file");
    let plain = video(&rig, b"a film");
    rig.vault()
        .commit(|tx| {
            tx.connection().execute(
                "UPDATE locker_item_field SET value_blob = ?1 WHERE id = 'f-file'",
                [&second],
            )?;
            Ok(())
        })
        .expect("replaced");
    let never =
        centraid_vault::originals::never_freed(rig.vault(), &BTreeSet::new()).expect("asks");
    let expected: BTreeSet<String> = [b"lk1:first file".as_slice(), b"lk1:second file"]
        .into_iter()
        .map(centraid_vault::blob::content_digest)
        .collect();
    assert_eq!(never, expected);
    assert!(
        !never.contains(&plain),
        "an ordinary original is the member's to free"
    );
}

/// No derivative is made from a sealed file: not by the library, not by the command, not by the
/// shell's staging door.
#[test]
fn no_derivative_is_ever_made_from_a_sealed_file() {
    let rig = Rig::new("sealed-no-derivative");
    sealed_file(&rig, b"lk1:file");
    let sealed = centraid_vault::blob::content_digest(b"lk1:file");
    let thumb = claim(&rig, b"a thumbnail");
    let registry = centraid_vault::commands::Registry::with_system_commands().expect("a registry");
    let written = rig.vault().execute(
        &registry,
        &centraid_vault::Principal::owner("phone"),
        &centraid_vault::Command::new(
            "derivative.write",
            serde_json::json!({ "blob": sealed, "variant": "thumb", "out": thumb, "out_size": 11, "media_type": "image/jpeg" }),
        ),
    );
    assert!(written.is_err(), "the command refuses");
    let staged = rig
        .vault()
        .stage_derivative(&centraid_vault::blob::StagedDerivative {
            hash: thumb.clone(),
            byte_size: 11,
            media_type: "image/jpeg".to_owned(),
            variant: "thumb".to_owned(),
            variant_of: sealed.clone(),
        });
    assert!(staged.is_err(), "the staging door refuses");
    let text = rig.vault().commit(|tx| {
        centraid_vault::blob::write_derivative(
            tx.connection(),
            AT,
            &sealed,
            "text",
            None,
            Some("words"),
        )
    });
    assert!(text.is_err(), "not even a text");
    let rows: i64 = rig
        .vault()
        .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM derivative", [], |row| row.get(0))?))
        .expect("counts");
    assert_eq!(rows, 0);
    assert!(
        centraid_vault::blob::is_sealed(&rig.raw(), &sealed).expect("asks"),
        "the schema says which file it is"
    );
}
