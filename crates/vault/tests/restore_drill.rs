//! The restore drill (spec §7, #1209, L6): back up with the real engine, lose everything, restore
//! from the tree in the order R3, and prove it is the vault that was lost.

mod backup_support;

use std::cell::RefCell;
use std::collections::BTreeMap;

use backup_support::{Rig, T0};
use centraid_media::sealed::{Class, Name, PlaintextHash};
use centraid_vault::Vault;
use centraid_vault::backup::drill::dump;
use centraid_vault::backup::engine::{Env, GatewayPass, Policy, Scheduler};
use centraid_vault::backup::restore::{self, Restore};
use centraid_vault::backup::store::{MemoryStore, Store};
use centraid_vault::backup::tree::Entry;

fn back_up(
    rig: &Rig,
    stores: &[&MemoryStore],
    now_ms: u64,
) -> centraid_vault::backup::snapshot::Taken {
    for store in stores {
        store.set_clock_ms(T0 * 2);
        rig.pair(store);
    }
    let taken = rig.snapshot(now_ms);
    let env = Env::new(
        rig.vault(),
        &rig.keys,
        &rig.state,
        &rig.staging,
        Policy::WIFI,
        now_ms,
    );
    let passes = stores
        .iter()
        .map(|store| GatewayPass::new(&env, *store as &dyn Store).expect("a pass"))
        .collect();
    Scheduler::new(passes, 8).run(10_000).expect("runs");
    taken
}

fn rig_with_a_library(seed: &str) -> (Rig, Vec<PlaintextHash>) {
    let rig = Rig::new(seed);
    rig.grow(40, seed);
    let mut originals = Vec::new();
    for n in 0..4_u8 {
        let original = rig.add_original(
            &format!("photograph {n} of the lake ")
                .repeat(500)
                .into_bytes(),
        );
        rig.add_thumbnail(
            &original,
            format!("thumbnail {n}").as_bytes(),
            &format!("2026-02-{:02}T10:00:00.000Z", n + 1),
        );
        originals.push(original);
    }
    (rig, originals)
}

#[test]
fn back_up_lose_everything_restore_in_the_order_of_r3_and_prove_it() {
    let (rig, originals) = rig_with_a_library("drill");
    let store = MemoryStore::new("desk");
    let taken = back_up(&rig, &[&store], T0);
    let before = dump(rig.vault()).expect("dumps");
    assert!(before.values().map(Vec::len).sum::<usize>() > 40);

    // Everything is lost but the 24 words (the keys) and the gateway.
    let restored_dir = tempfile::tempdir().expect("a directory");
    let path = restored_dir.path().join("vault.db");
    let head = store.head().expect("head").expect("a head");
    assert_eq!(head.name, taken.root.name);
    let restore = Restore::open(&rig.keys, &[&store], &head.name).expect("opens the tree");

    let events: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let restored_media: RefCell<BTreeMap<PlaintextHash, Vec<u8>>> = RefCell::new(BTreeMap::new());
    let mut opened = |path: &std::path::Path| -> centraid_vault::backup::Result<()> {
        // THE VAULT OPENS after the records phase and before any media.
        let vault = Vault::open(path).expect("opens through the ladder");
        events
            .borrow_mut()
            .push(format!("open:{}", restored_media.borrow().len()));
        assert_eq!(
            dump(&vault).expect("dumps"),
            before,
            "the records are the vault that was lost"
        );
        Ok(())
    };
    let mut order: Vec<(u64, Class)> = Vec::new();
    let mut sink = |entry: &Entry, bytes: &[u8]| -> centraid_vault::backup::Result<()> {
        assert_eq!(PlaintextHash::of(bytes), entry.h);
        let class = if entry.thumbnail.is_empty() {
            Class::Originals
        } else {
            Class::Thumbnails
        };
        order.push((entry.taken_at_ms, class));
        restored_media.borrow_mut().insert(entry.h, bytes.to_vec());
        events.borrow_mut().push(format!("media:{class:?}"));
        Ok(())
    };
    let (records, thumbnails, originals_report) = restore
        .restore_all(&path, &mut opened, &mut sink)
        .expect("restores");

    let checks: Vec<&str> = records.checks.iter().map(|check| check.name).collect();
    assert_eq!(
        checks,
        [
            "ranges",
            "db_hash",
            "integrity_check",
            "header",
            "schema",
            "census"
        ]
    );
    assert!(records.ranges > 2);
    assert_eq!(
        (thumbnails.restored, thumbnails.missing, thumbnails.damaged),
        (4, 0, 0)
    );
    assert_eq!(originals_report.restored, 4);
    let log = events.borrow();
    assert_eq!(
        log[0], "open:0",
        "the vault opened before a single photo came back"
    );
    assert!(
        log[1..5].iter().all(|event| event == "media:Thumbnails"),
        "{log:?}"
    );
    assert!(
        log[5..].iter().all(|event| event == "media:Originals"),
        "{log:?}"
    );
    // Newest first within a class.
    for class in [Class::Thumbnails, Class::Originals] {
        let times: Vec<u64> = order
            .iter()
            .filter(|(_, c)| *c == class)
            .map(|(t, _)| *t)
            .collect();
        assert!(
            times.windows(2).all(|pair| pair[0] >= pair[1]),
            "{class:?}: {times:?}"
        );
    }
    // Every original the member took is back, byte for byte.
    let media = restored_media.borrow();
    for original in &originals {
        assert!(media.contains_key(original));
    }
}

#[test]
fn a_gateway_that_lost_an_object_is_made_up_by_another() {
    let (rig, _) = rig_with_a_library("two");
    let (one, two) = (MemoryStore::new("one"), MemoryStore::new("two"));
    let taken = back_up(&rig, &[&one, &two], T0);
    let victim = *centraid_vault::backup::tree::media_of(&rig.state, &taken.root, Class::Originals)
        .expect("media")
        .keys()
        .next()
        .expect("an original");
    assert!(one.lose_bytes(&victim), "the first gateway lost a file");
    let dir = tempfile::tempdir().expect("a directory");

    let alone = Restore::open(&rig.keys, &[&one as &dyn Store], &taken.root.name).expect("opens");
    alone
        .records(&dir.path().join("a.db"))
        .expect("records are fine");
    let report = alone.originals(&mut |_, _| Ok(())).expect("walks");
    assert_eq!(
        (report.restored, report.missing),
        (3, 1),
        "one original is missing"
    );

    let both =
        Restore::open(&rig.keys, &[&one as &dyn Store, &two], &taken.root.name).expect("opens");
    let report = both.originals(&mut |_, _| Ok(())).expect("walks");
    assert_eq!(
        (report.restored, report.missing),
        (4, 0),
        "the second gateway supplies it"
    );
}

#[test]
fn a_range_that_rotted_on_the_gateway_is_refused_and_no_vault_is_claimed() {
    let (rig, _) = rig_with_a_library("damage");
    let store = MemoryStore::new("desk");
    let taken = back_up(&rig, &[&store], T0);
    let ranges = {
        let restore =
            Restore::open(&rig.keys, &[&store as &dyn Store], &taken.root.name).expect("opens");
        centraid_vault::backup::tree::ranges_of(&restore, &restore.root).expect("ranges")
    };
    // A range rots on the gateway: it will not open, so no vault is claimed to be restored.
    assert!(store.flip_bit(&ranges[2].name));
    let dir = tempfile::tempdir().expect("a directory");
    let restore =
        Restore::open(&rig.keys, &[&store as &dyn Store], &taken.root.name).expect("opens");
    assert!(restore.records(&dir.path().join("v.db")).is_err());
}

#[test]
fn check_my_backup_restores_into_scratch_and_removes_it() {
    let (rig, _) = rig_with_a_library("check");
    let store = MemoryStore::new("desk");
    back_up(&rig, &[&store], T0);
    let scratch = rig.scratch.join("vault.scratch");
    let report = restore::check(&rig.keys, &store, &scratch).expect("checks");
    assert_eq!(
        (report.thumbnails_missing, report.originals_missing),
        (0, 0)
    );
    assert!(!scratch.exists(), "the scratch directory is gone");

    // A media chunk the gateway lost is reported, not hidden.
    let lost = *centraid_vault::backup::tree::media_of(
        &rig.state,
        &rig.env(T0).newest().expect("newest").expect("a root"),
        Class::Thumbnails,
    )
    .expect("media")
    .keys()
    .next()
    .expect("a thumbnail");
    assert!(store.lose_bytes(&lost));
    store.check_name(&lost).expect("the gateway notices");
    let report = restore::check(&rig.keys, &store, &scratch).expect("checks");
    assert_eq!(report.thumbnails_missing, 1);
}

#[test]
fn the_head_to_restore_is_the_greatest_epoch_generation_and_writes() {
    use centraid_vault::backup::store::Head;
    let head = |epoch, generation, writes| Head {
        name: Name::from_bytes([epoch as u8; 32]),
        prev: None,
        taken_at_ms: 0,
        epoch,
        generation,
        writes,
        set_at_ms: 0,
    };
    let heads = vec![
        ("a".to_owned(), head(1, 9, 100)),
        ("b".to_owned(), head(2, 1, 5)),
        ("c".to_owned(), head(2, 1, 7)),
    ];
    assert_eq!(
        restore::pick_head(&heads).map(|(id, _)| id.as_str()),
        Some("c")
    );
    assert!(restore::pick_head(&[]).is_none());
}

#[test]
fn the_structural_check_still_judges_a_vault_file() {
    let rig = Rig::new("structural");
    rig.grow(5, "s");
    let raw = rig.raw();
    raw.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        row.get::<_, i64>(0)
    })
    .expect("folds");
    let report = restore::restore_check(rig.vault().path()).expect("checks");
    assert!(report.is_clean());
    assert!(restore::restore_check(&rig.scratch.join("nothing.db")).is_err());
}
