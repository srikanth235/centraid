//! One snapshot (spec §5, #1209, L3): dirty ranges, the periodic full read, the checkpoint after
//! the pin, a damaged vault refused. Counts of ranges read, never durations.

mod backup_support;

use backup_support::{Rig, T0};
use centraid_media::sealed::{self, Class};
use centraid_vault::backup::snapshot::{FULL_EVERY, Options};
use centraid_vault::backup::{tree, wal};
use centraid_vault::pagesource::live_pins;

fn root_of(rig: &Rig, taken: &centraid_vault::backup::snapshot::Taken) -> tree::Root {
    tree::root_of(&rig.state, &taken.root).expect("a root")
}

#[test]
fn the_first_snapshot_reads_every_range_and_hashes_the_whole_vault() {
    let rig = Rig::new("first");
    rig.grow(40, "first");
    let taken = rig.snapshot(T0);
    let root = root_of(&rig, &taken);
    assert!(taken.full);
    assert!(root.range_count() > 4, "the vault is several ranges");
    assert_eq!(taken.ranges_read, root.range_count());
    assert_eq!(taken.ranges_new as u64, root.range_count());
    assert!(root.db_hash.is_some(), "a full read sets db_hash");
    assert_eq!(live_pins(), 0);
    // Every new range is staged, and staging holds exactly those objects.
    assert_eq!(
        rig.staging.names().expect("names").len() as u64,
        root.range_count()
    );
    assert_eq!(
        rig.state.staged_all().expect("rows").len() as u64,
        root.range_count()
    );
}

#[test]
fn a_one_page_edit_reads_one_range_on_a_normal_snapshot() {
    let rig = Rig::new("onepage");
    rig.grow(40, "onepage");
    let first = rig.snapshot(T0);
    let before = root_of(&rig, &first);

    // One page: a single column of the single `vault` row, by a second connection.
    let raw = rig.raw();
    raw.execute("UPDATE vault SET writes = writes + 1", [])
        .expect("one row changes");
    drop(raw);

    let taken = rig.snapshot(T0 + 1_000);
    assert!(!taken.full, "the second snapshot is a normal one");
    assert_eq!(taken.ranges_read, 1, "one page is one range read");
    assert_eq!(taken.ranges_new, 1, "and one new range object");
    let after = root_of(&rig, &taken);
    assert!(
        after.db_hash.is_none(),
        "a normal snapshot carries no db_hash"
    );
    assert_eq!(after.range_count(), before.range_count());
    let (old, new) = (
        tree::ranges_of(&rig.state, &before).expect("ranges"),
        tree::ranges_of(&rig.state, &after).expect("ranges"),
    );
    assert_eq!(
        old.iter()
            .zip(&new)
            .filter(|(a, b)| a.name != b.name)
            .count(),
        1
    );
}

#[test]
fn nothing_changed_reads_no_range_and_makes_the_same_root_but_for_its_time() {
    let rig = Rig::new("quiet");
    rig.grow(20, "quiet");
    rig.snapshot(T0);
    let taken = rig.snapshot(T0 + 1);
    assert_eq!(taken.ranges_read, 0);
    assert_eq!(taken.ranges_new, 0);
}

#[test]
fn a_checkpoint_made_behind_the_core_is_caught_by_the_next_full_read() {
    let rig = Rig::new("behind");
    rig.grow(40, "behind");
    let first = rig.snapshot(T0);
    assert!(first.full);

    // A page changes, and something other than the core folds the WAL into the file.
    let raw = rig.raw();
    raw.execute("UPDATE vault SET writes = writes + 1", [])
        .expect("an edit");
    raw.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        row.get::<_, i64>(0)
    })
    .expect("a checkpoint nobody asked the core about");
    drop(raw);
    assert!(
        wal::frame_pages(rig.vault().path())
            .expect("frames")
            .is_empty(),
        "the WAL no longer says what changed"
    );

    // The normal snapshots miss it: their ranges are the old ones.
    let mut stale = None;
    for step in 1..FULL_EVERY {
        let taken = rig.snapshot(T0 + step * 1_000);
        assert!(!taken.full);
        assert_eq!(
            taken.ranges_read, 0,
            "the dirty set is empty and so is the read"
        );
        stale = Some(taken);
    }
    let stale = root_of(&rig, &stale.expect("a snapshot"));
    assert!(stale.db_hash.is_none());

    // The fourth after the full read is the next full read: it finds the range and sets db_hash.
    let caught = rig.snapshot(T0 + FULL_EVERY * 1_000);
    assert!(caught.full);
    assert_eq!(
        caught.ranges_new, 1,
        "exactly the range the dirty set missed"
    );
    let healed = root_of(&rig, &caught);
    assert!(healed.db_hash.is_some());
}

#[test]
fn a_full_read_is_at_least_daily() {
    let rig = Rig::new("daily");
    rig.grow(20, "daily");
    rig.snapshot(T0);
    let next_day = rig.snapshot(T0 + 25 * 60 * 60 * 1000);
    assert!(
        next_day.full,
        "a day later is a full read whatever the count says"
    );
    let same_day = rig.snapshot(T0 + 26 * 60 * 60 * 1000);
    assert!(!same_day.full);
}

#[test]
fn the_checkpoint_comes_after_the_pin_and_pages_written_during_it_are_carried() {
    let rig = Rig::new("carry");
    rig.grow(40, "carry");
    rig.snapshot(T0);
    assert!(
        wal::frame_pages(rig.vault().path())
            .expect("frames")
            .is_empty(),
        "the core checkpointed after the pin ended"
    );
    let raw = rig.raw();
    // A page is written while the next snapshot's pin is open: the pin does not see it, and the
    // checkpoint that follows folds it away.
    let during = || {
        raw.execute("UPDATE vault SET writes = writes + 1", [])
            .expect("a commit during the pin");
    };
    let mut options = Options::at(T0 + 1_000);
    options.on_pin = Some(&during);
    let pinned = rig.snapshot_with(options);
    assert_eq!(
        pinned.ranges_read, 0,
        "the pin read the vault before the commit"
    );
    let carry = rig.state.device().expect("device").carry;
    assert!(
        !carry.is_empty(),
        "the page written during the pin is carried"
    );
    // The next snapshot reads it although the WAL no longer lists it.
    let next = rig.snapshot(T0 + 2_000);
    assert_eq!(next.ranges_read, 1);
    assert_eq!(next.ranges_new, 1);
    assert!(rig.state.device().expect("device").carry.is_empty());
}

#[test]
fn a_damaged_vault_is_refused_before_any_root_exists() {
    let rig = Rig::new("damaged");
    rig.grow(20, "damaged");
    // Fold the WAL so the damage is not shadowed, then damage a leaf page.
    let raw = rig.raw();
    raw.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        row.get::<_, i64>(0)
    })
    .expect("checkpoints");
    drop(raw);
    let path = rig.vault().path().to_owned();
    let mut bytes = std::fs::read(&path).expect("reads");
    let leaf = (1..bytes.len() / 4096)
        .find(|page| bytes[page * 4096] == 0x0d)
        .expect("a leaf page");
    bytes[leaf * 4096 + 3] = 0xff;
    bytes[leaf * 4096 + 4] = 0xff;
    std::fs::write(&path, &bytes).expect("damages");

    let refused = centraid_vault::backup::snapshot::take(
        rig.vault(),
        &rig.keys,
        &rig.state,
        &rig.staging,
        &rig.directory,
        Options::at(T0),
    );
    assert!(refused.is_err(), "a damaged vault signs nothing");
    assert_eq!(live_pins(), 0, "the pin is released");
    assert!(
        rig.state.device().expect("device").newest.is_none(),
        "no root exists"
    );
    assert_eq!(
        rig.state.node_count().expect("nodes"),
        0,
        "and no node was kept"
    );
}

#[test]
fn photos_become_entries_once_and_their_chunks_are_read_once() {
    let rig = Rig::new("photos");
    let original = rig.add_original(&b"an original photograph ".repeat(300));
    let thumbnail = rig.add_thumbnail(&original, b"a thumbnail", "2026-01-02T03:04:05.000Z");
    let first = rig.snapshot(T0);
    assert_eq!(first.entries_new, 2);
    let root = root_of(&rig, &first);
    let entries = tree::entries_of(&rig.state, &root.blobs).expect("entries");
    assert_eq!(entries.len(), 2);
    let photo = entries
        .iter()
        .find(|entry| entry.h == original)
        .expect("the original");
    assert_eq!(photo.original.len(), 1);
    assert!(photo.thumbnail.is_empty());
    assert!(photo.original.iter().all(|r| r.class == Class::Originals));
    let thumb = entries
        .iter()
        .find(|entry| entry.h == thumbnail)
        .expect("the thumbnail");
    assert!(thumb.original.is_empty());
    assert_eq!(thumb.thumbnail.len(), 1);
    assert!(thumb.taken_at_ms > 0);
    // The ref is the sealed object of the bytes.
    let expected = sealed::seal(
        &rig.keys,
        Class::Originals,
        &b"an original photograph ".repeat(300),
    )
    .expect("seals")
    .reference();
    assert_eq!(photo.original[0], expected);

    let second = rig.snapshot(T0 + 1_000);
    assert_eq!(
        second.entries_new, 0,
        "known blobs are not read or sealed again"
    );
}

#[test]
fn a_snapshot_taken_while_another_thread_commits_is_exactly_a_committed_state() {
    use centraid_vault::Vault;
    use centraid_vault::backup::drill::dump;
    use centraid_vault::backup::engine::{Env, GatewayPass, Policy, Scheduler};
    use centraid_vault::backup::restore::Restore;
    use centraid_vault::backup::store::MemoryStore;
    use std::sync::mpsc;

    let rig = Rig::new("thread");
    rig.grow(30, "thread");
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 2);
    rig.pair(&store);
    rig.snapshot(T0);

    // Another thread holds the vault open on a connection of its own and commits notes the moment
    // a pin begins, then reports; the snapshot's pin must not see any of it.
    let path = rig.vault().path().to_owned();
    let (go, wait) = mpsc::channel::<u32>();
    let (done, finished) = mpsc::channel::<()>();
    let committer = std::thread::spawn(move || {
        let vault = Vault::open(&path).expect("a second handle opens the vault");
        while let Ok(count) = wait.recv() {
            for n in 0..count {
                backup_support::common::insert_note(&vault, &format!("from the thread {n}"))
                    .expect("commits");
            }
            done.send(()).expect("reports");
        }
    });

    for round in 1..=3_u64 {
        let committed = dump(rig.vault()).expect("the committed state at the pin");
        let during = || {
            go.send(5).expect("asks the thread to commit");
            finished.recv().expect("the thread committed");
        };
        let mut options = Options::at(T0 + round * 1_000);
        options.on_pin = Some(&during);
        let taken = rig.snapshot_with(options);
        let env = Env::new(
            rig.vault(),
            &rig.keys,
            &rig.state,
            &rig.staging,
            Policy::WIFI,
            T0 + round,
        );
        Scheduler::new(vec![GatewayPass::new(&env, &store).expect("a pass")], 8)
            .run(10_000)
            .expect("runs");

        let dir = tempfile::tempdir().expect("a directory");
        let restore = Restore::open(
            &rig.keys,
            &[&store as &dyn centraid_vault::backup::store::Store],
            &taken.root.name,
        )
        .expect("opens");
        let out = dir.path().join("restored.db");
        restore.records(&out).expect("every restore check holds");
        let restored = Vault::open(&out).expect("opens");
        assert_eq!(
            dump(&restored).expect("dumps"),
            committed,
            "round {round}: exactly the state at the pin, none of the commits that landed during it"
        );
    }
    drop(go);
    committer.join().expect("the thread ends");

    // What the thread committed is in the next snapshot: carried although the WAL was folded.
    let after = dump(rig.vault()).expect("dumps");
    let last = rig.snapshot(T0 + 10_000);
    let env = Env::new(
        rig.vault(),
        &rig.keys,
        &rig.state,
        &rig.staging,
        Policy::WIFI,
        T0 + 10_000,
    );
    Scheduler::new(vec![GatewayPass::new(&env, &store).expect("a pass")], 8)
        .run(10_000)
        .expect("runs");
    let dir = tempfile::tempdir().expect("a directory");
    let restore = Restore::open(
        &rig.keys,
        &[&store as &dyn centraid_vault::backup::store::Store],
        &last.root.name,
    )
    .expect("opens");
    restore
        .records(&dir.path().join("final.db"))
        .expect("restores");
    assert_eq!(
        dump(&Vault::open(dir.path().join("final.db")).expect("opens")).expect("dumps"),
        after
    );
}

#[test]
fn the_quick_check_runs_before_the_head_is_signed() {
    use centraid_vault::backup::engine::GatewayPass;
    use centraid_vault::backup::store::{MemoryStore, Store as _};

    let rig = Rig::new("quick");
    rig.grow(20, "quick");
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 2);
    rig.pair(&store);
    let raw = rig.raw();
    raw.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        row.get::<_, i64>(0)
    })
    .expect("folds");
    drop(raw);
    let path = rig.vault().path().to_owned();
    let mut bytes = std::fs::read(&path).expect("reads");
    let leaf = (1..bytes.len() / 4096)
        .find(|page| bytes[page * 4096] == 0x0d)
        .expect("a leaf page");
    bytes[leaf * 4096 + 3] = 0xff;
    bytes[leaf * 4096 + 4] = 0xff;
    std::fs::write(&path, &bytes).expect("damages");

    let refused = centraid_vault::backup::snapshot::take(
        rig.vault(),
        &rig.keys,
        &rig.state,
        &rig.staging,
        &rig.directory,
        Options::at(T0),
    );
    assert!(
        refused.is_err(),
        "quick_check refuses the pass on the pin it read"
    );
    // No root exists, so no pass can start and no head is ever signed over the damage.
    let env = rig.env(T0);
    assert!(GatewayPass::new(&env, &store).is_err());
    assert!(store.head().expect("head").is_none());
    assert_eq!(store.counts().heads, 0);
}
