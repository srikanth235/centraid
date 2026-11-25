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
fn a_checkpoint_made_behind_the_core_is_caught_immediately_by_the_next_snapshot() {
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

    // The very next snapshot sees the main file's disk_mark changed and forces a full read.
    let caught = rig.snapshot(T0 + 1_000);
    assert!(caught.full, "an outside checkpoint forces a full read");
    assert_eq!(
        caught.ranges_new, 1,
        "exactly the range the dirty set missed"
    );
    let healed = root_of(&rig, &caught);
    assert!(healed.db_hash.is_some());
}

#[test]
fn the_periodic_full_read_runs_every_full_every_snapshots() {
    let rig = Rig::new("cadence");
    rig.grow(20, "cadence");
    let first = rig.snapshot(T0);
    assert!(first.full);
    for step in 1..FULL_EVERY {
        let taken = rig.snapshot(T0 + step * 1_000);
        assert!(!taken.full, "step {step} is incremental");
        assert!(root_of(&rig, &taken).db_hash.is_none());
    }
    let periodic = rig.snapshot(T0 + FULL_EVERY * 1_000);
    assert!(periodic.full, "step {FULL_EVERY} is a periodic full read");
    assert!(root_of(&rig, &periodic).db_hash.is_some());
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

fn upload_and_restore(
    vault: &centraid_vault::Vault,
    keys: &sealed::BackupKeys,
    state: &centraid_vault::backup::state::DeviceState,
    staging: &centraid_vault::backup::staging::Staging,
    store: &centraid_vault::backup::store::MemoryStore,
    root: &sealed::Name,
    now_ms: u64,
) -> std::collections::BTreeMap<String, Vec<String>> {
    use centraid_vault::Vault;
    use centraid_vault::backup::drill::dump;
    use centraid_vault::backup::engine::{Env, GatewayPass, Policy, Scheduler};
    use centraid_vault::backup::restore::Restore;
    use centraid_vault::backup::store::Store;

    let env = Env::new(vault, keys, state, staging, Policy::WIFI, now_ms);
    Scheduler::new(vec![GatewayPass::new(&env, store).expect("a pass")], 8)
        .run(10_000)
        .expect("runs");
    let dir = tempfile::tempdir().expect("a directory");
    let out = dir.path().join("restored.db");
    let restore = Restore::open(keys, &[store as &dyn Store], root).expect("opens");
    restore.records(&out).expect("restores");
    dump(&Vault::open(&out).expect("opens restored")).expect("dumps restored")
}

#[test]
fn a_clean_close_after_a_write_forces_a_full_read_and_restores_all_rows() {
    use centraid_vault::Vault;
    use centraid_vault::backup::directory::Directory;
    use centraid_vault::backup::drill::dump;
    use centraid_vault::backup::snapshot;
    use centraid_vault::backup::staging::Staging;
    use centraid_vault::backup::state::{DeviceState, Gateway};
    use centraid_vault::backup::store::{MemoryStore, Store as _};

    let dir = tempfile::tempdir().expect("a directory");
    let vault_path = dir.path().join("vault.db");
    let vault = Vault::create(&vault_path).expect("creates vault");
    vault.found("The Household", "Ada").expect("founds");
    for round in 0..40 {
        backup_support::common::insert_note(&vault, &format!("seed {round} {}", "x".repeat(900)))
            .expect("inserts");
    }

    let keys = sealed::BackupKeys::from_root(&[0x42; 32]);
    let state = DeviceState::open_beside(&vault_path).expect("state");
    let staging = Staging::open(dir.path().join("vault.staging"), 512 * 1024 * 1024).expect("s");
    let directory = Directory::new(Vec::new()).expect("directory");
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 2);
    state
        .add_gateway(&Gateway::paired(
            store.gateway_id().to_owned(),
            vec!["192.168.1.20:7443".to_owned()],
            vec![0x30],
            "desk".to_owned(),
            store.epoch(),
            T0,
        ))
        .expect("pairs");

    // First snapshot (full), uploaded so the gateway holds the baseline ranges.
    let first = snapshot::take(&vault, &keys, &state, &staging, &directory, Options::at(T0))
        .expect("first snapshot");
    assert!(first.full);
    let _ = upload_and_restore(
        &vault,
        &keys,
        &state,
        &staging,
        &store,
        &first.root.name,
        T0,
    );

    // A normal write without closing stays incremental.
    backup_support::common::insert_note(&vault, "normal incremental write").expect("commits");
    let incremental = snapshot::take(
        &vault,
        &keys,
        &state,
        &staging,
        &directory,
        Options::at(T0 + 1_000),
    )
    .expect("incremental snapshot");
    assert!(
        !incremental.full,
        "normal write without close stays incremental"
    );
    let _ = upload_and_restore(
        &vault,
        &keys,
        &state,
        &staging,
        &store,
        &incremental.root.name,
        T0 + 1_000,
    );

    // Write a small row (without necessarily growing page_count) and cleanly close the last
    // connection, which checkpoints the WAL into vault.db and removes -wal.
    backup_support::common::insert_note(&vault, "written before clean close").expect("commits");
    vault.close().expect("clean close");
    assert!(
        wal::frame_pages(&vault_path).expect("frames").is_empty(),
        "clean close folded and removed the WAL"
    );

    // Reopen and snapshot: WAL and carry are both empty, yet the main file changed on disk, so
    // snapshot::take must force a full read and the restored vault must equal the live one.
    let reopened = Vault::open(&vault_path).expect("reopens");
    let live = dump(&reopened).expect("dumps live");
    let after_close = snapshot::take(
        &reopened,
        &keys,
        &state,
        &staging,
        &directory,
        Options::at(T0 + 2_000),
    )
    .expect("snapshot after clean close");
    assert!(
        after_close.full,
        "a clean close after a write must force a full read"
    );
    let restored = upload_and_restore(
        &reopened,
        &keys,
        &state,
        &staging,
        &store,
        &after_close.root.name,
        T0 + 2_000,
    );
    assert_eq!(
        restored, live,
        "restored rows equal live rows after clean close"
    );
}

#[test]
fn a_clean_close_then_new_write_forces_a_full_read_and_restores_both_writes() {
    use centraid_vault::Vault;
    use centraid_vault::backup::directory::Directory;
    use centraid_vault::backup::drill::dump;
    use centraid_vault::backup::snapshot;
    use centraid_vault::backup::staging::Staging;
    use centraid_vault::backup::state::{DeviceState, Gateway};
    use centraid_vault::backup::store::{MemoryStore, Store as _};

    let dir = tempfile::tempdir().expect("a directory");
    let vault_path = dir.path().join("vault.db");
    let vault = Vault::create(&vault_path).expect("creates vault");
    vault.found("The Household", "Ada").expect("founds");
    for round in 0..40 {
        backup_support::common::insert_note(&vault, &format!("seed {round} {}", "x".repeat(900)))
            .expect("inserts");
    }

    let keys = sealed::BackupKeys::from_root(&[0x43; 32]);
    let state = DeviceState::open_beside(&vault_path).expect("state");
    let staging = Staging::open(dir.path().join("vault.staging"), 512 * 1024 * 1024).expect("s");
    let directory = Directory::new(Vec::new()).expect("directory");
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 2);
    state
        .add_gateway(&Gateway::paired(
            store.gateway_id().to_owned(),
            vec!["192.168.1.20:7443".to_owned()],
            vec![0x30],
            "desk".to_owned(),
            store.epoch(),
            T0,
        ))
        .expect("pairs");

    let first = snapshot::take(&vault, &keys, &state, &staging, &directory, Options::at(T0))
        .expect("first snapshot");
    assert!(first.full);
    let _ = upload_and_restore(
        &vault,
        &keys,
        &state,
        &staging,
        &store,
        &first.root.name,
        T0,
    );

    // Write 1 before clean close (folded into vault.db on close).
    backup_support::common::insert_note(&vault, "before clean close").expect("commits 1");
    vault.close().expect("clean close");

    // Reopen and do Write 2 so the WAL is NON-empty, yet Write 1 is only in vault.db.
    let reopened = Vault::open(&vault_path).expect("reopens");
    backup_support::common::insert_note(&reopened, "after reopen").expect("commits 2");
    assert!(
        !wal::frame_pages(&vault_path).expect("frames").is_empty(),
        "WAL is non-empty from the post-reopen write"
    );

    let live = dump(&reopened).expect("dumps live");
    let after = snapshot::take(
        &reopened,
        &keys,
        &state,
        &staging,
        &directory,
        Options::at(T0 + 2_000),
    )
    .expect("snapshot after reopen + write");
    assert!(
        after.full,
        "a clean close before a post-reopen write must still force a full read"
    );
    let restored = upload_and_restore(
        &reopened,
        &keys,
        &state,
        &staging,
        &store,
        &after.root.name,
        T0 + 2_000,
    );
    assert_eq!(
        restored, live,
        "restored rows include both the pre-close write and the post-reopen write"
    );
}

/// A founded, seeded vault with a first (full) snapshot uploaded, for the tests that close and
/// reopen it.
struct Closing {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    keys: sealed::BackupKeys,
    state: centraid_vault::backup::state::DeviceState,
    staging: centraid_vault::backup::staging::Staging,
    directory: centraid_vault::backup::directory::Directory,
    store: centraid_vault::backup::store::MemoryStore,
}

impl Closing {
    fn new() -> (Self, centraid_vault::Vault) {
        use centraid_vault::Vault;
        use centraid_vault::backup::directory::Directory;
        use centraid_vault::backup::staging::Staging;
        use centraid_vault::backup::state::{DeviceState, Gateway};
        use centraid_vault::backup::store::{MemoryStore, Store as _};

        let dir = tempfile::tempdir().expect("a directory");
        let path = dir.path().join("vault.db");
        let vault = Vault::create(&path).expect("creates vault");
        vault.found("The Household", "Ada").expect("founds");
        for round in 0..40 {
            backup_support::common::insert_note(
                &vault,
                &format!("seed {round} {}", "x".repeat(900)),
            )
            .expect("inserts");
        }
        let state = DeviceState::open_beside(&path).expect("state");
        let staging =
            Staging::open(dir.path().join("vault.staging"), 512 * 1024 * 1024).expect("s");
        let store = MemoryStore::new("desk");
        store.set_clock_ms(T0 * 2);
        state
            .add_gateway(&Gateway::paired(
                store.gateway_id().to_owned(),
                vec!["192.168.1.20:7443".to_owned()],
                vec![0x30],
                "desk".to_owned(),
                store.epoch(),
                T0,
            ))
            .expect("pairs");
        let rig = Self {
            _dir: dir,
            path,
            keys: sealed::BackupKeys::from_root(&[0x44; 32]),
            state,
            staging,
            directory: Directory::new(Vec::new()).expect("directory"),
            store,
        };
        let first = rig.take(&vault, T0);
        assert!(first.full);
        (rig, vault)
    }

    fn take(
        &self,
        vault: &centraid_vault::Vault,
        now_ms: u64,
    ) -> centraid_vault::backup::snapshot::Taken {
        centraid_vault::backup::snapshot::take(
            vault,
            &self.keys,
            &self.state,
            &self.staging,
            &self.directory,
            Options::at(now_ms),
        )
        .expect("a snapshot")
    }

    /// Close, reopen and snapshot once, so the vault's close-time statistics exist.
    fn cycle(&self, vault: centraid_vault::Vault, now_ms: u64) -> centraid_vault::Vault {
        vault.close().expect("clean close");
        let reopened = centraid_vault::Vault::open(&self.path).expect("reopens");
        let _ = self.take(&reopened, now_ms);
        reopened
    }

    /// Upload `taken`, restore it, check the copy, and compare it with the live vault.
    fn restores_to_live(
        &self,
        vault: &centraid_vault::Vault,
        taken: &centraid_vault::backup::snapshot::Taken,
        now_ms: u64,
    ) {
        use centraid_vault::backup::drill::dump;
        use centraid_vault::backup::restore::Restore;
        use centraid_vault::backup::store::Store;
        let live = dump(vault).expect("dumps live");
        let restored = upload_and_restore(
            vault,
            &self.keys,
            &self.state,
            &self.staging,
            &self.store,
            &taken.root.name,
            now_ms,
        );
        assert_eq!(restored, live, "restored rows equal live rows");
        let dir = tempfile::tempdir().expect("a directory");
        let out = dir.path().join("restored.db");
        Restore::open(&self.keys, &[&self.store as &dyn Store], &taken.root.name)
            .expect("opens")
            .records(&out)
            .expect("restores");
        let check = rusqlite::Connection::open(&out).expect("opens restored file");
        let verdict: String = check
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("integrity_check");
        assert_eq!(verdict, "ok", "the restored file is whole");
    }
}

#[test]
fn a_search_only_write_then_clean_close_forces_a_full_read_and_restores_a_whole_file() {
    use centraid_vault::Vault;
    let (rig, vault) = Closing::new();
    // One close first, so `sqlite_stat1` exists and page 1 no longer changes on the next close.
    let vault = rig.cycle(vault, T0 + 500);
    // Notes leave several search segments; a snapshot makes the file's mark current.
    for round in 0..30 {
        backup_support::common::insert_note(&vault, &format!("more {round} words to index"))
            .expect("inserts");
    }
    let _ = rig.take(&vault, T0 + 600);
    vault.compact_search().expect("compacts");
    let _ = rig.take(&vault, T0 + 600);
    // Commits that touch only the search index leave `vault.writes` alone, and (the file already
    // holding the pages) change neither its length nor page 1.
    vault
        .commit(|tx| {
            tx.connection().execute(
                "INSERT INTO search_owed (id, after) VALUES ('nothing', '')",
                [],
            )?;
            Ok(())
        })
        .expect("owes");
    vault.reindex_owed().expect("reindexes");
    vault.close().expect("clean close");

    let reopened = Vault::open(&rig.path).expect("reopens");
    let taken = rig.take(&reopened, T0 + 1_000);
    assert!(
        taken.full,
        "a close folds search pages the WAL no longer names"
    );
    rig.restores_to_live(&reopened, &taken, T0 + 1_000);
}

#[test]
fn a_clean_close_with_no_member_write_forces_a_full_read() {
    use centraid_vault::Vault;
    let (rig, vault) = Closing::new();
    let vault = rig.cycle(vault, T0 + 500);
    // Only the close-time PRAGMA optimize writes anything.
    vault.close().expect("clean close");

    let reopened = Vault::open(&rig.path).expect("reopens");
    let taken = rig.take(&reopened, T0 + 1_000);
    assert!(taken.full, "a reopen is never trusted to be unchanged");
    rig.restores_to_live(&reopened, &taken, T0 + 1_000);
}

#[test]
fn a_steady_vault_that_is_not_closed_reads_no_range_snapshot_after_snapshot() {
    let (rig, vault) = Closing::new();
    for step in 1..=2 {
        let taken = rig.take(&vault, T0 + step);
        assert_eq!(taken.ranges_read, 0, "snapshot {step} read nothing");
        assert!(!taken.full);
    }
}

#[test]
fn fold_wal_if_needed_truncates_wal_and_next_incremental_snapshot_restores_every_write() {
    use centraid_vault::Vault;
    use centraid_vault::backup::drill::dump;
    use centraid_vault::backup::engine::{Env, GatewayPass, Policy, Scheduler};
    use centraid_vault::backup::restore::Restore;
    use centraid_vault::backup::snapshot::{self, Options};
    use centraid_vault::backup::store::MemoryStore;

    let rig = Rig::new("foldwal");
    rig.grow(20, "foldwal");
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 2);
    rig.pair(&store);

    // Baseline full snapshot uploaded to gateway.
    let first = rig.snapshot(T0);
    assert!(first.full);
    let env = rig.env(T0);
    Scheduler::new(vec![GatewayPass::new(&env, &store).expect("pass")], 8)
        .run(10_000)
        .expect("runs");

    // Accumulate offline writes in the WAL, then fold them without taking a snapshot yet.
    rig.grow(15, "offline-before-fold");
    let frames_before = wal::frame_pages(rig.vault().path()).expect("wal frames");
    assert!(
        !frames_before.is_empty(),
        "WAL holds uncommitted-to-snapshot frames"
    );

    // Below threshold does not fold.
    assert!(
        !snapshot::fold_wal_if_needed(rig.vault(), &rig.state, T0 + 500, frames_before.len() + 1,)
            .expect("below threshold")
    );
    assert_eq!(
        wal::frame_pages(rig.vault().path()).expect("frames").len(),
        frames_before.len()
    );

    // At/above threshold folds WAL ranges into `dirty_range` and truncates `-wal` to 0 frames.
    assert!(
        snapshot::fold_wal_if_needed(rig.vault(), &rig.state, T0 + 600, frames_before.len())
            .expect("folds")
    );
    assert!(
        wal::frame_pages(rig.vault().path())
            .expect("frames after fold")
            .is_empty(),
        "-wal was truncated to 0 frames"
    );
    assert!(
        !rig.state.dirty_ranges().expect("dirty_ranges").is_empty(),
        "folded ranges are recorded in dirty_range"
    );

    // The next snapshot is incremental (disk_mark matched post-fold), yet reads every folded range
    // and clears `dirty_range` once recorded.
    let live = dump(rig.vault()).expect("dumps live");
    let next = rig.snapshot_with(Options::at(T0 + 1_000));
    assert!(
        !next.full,
        "disk_mark stayed valid across fold_wal_if_needed"
    );
    assert!(next.ranges_read > 0, "folded dirty ranges were read");
    assert!(
        rig.state
            .dirty_ranges()
            .expect("dirty_ranges cleared")
            .is_empty()
    );

    // Upload the incremental snapshot and prove every folded row restores faithfully.
    let env = Env::new(
        rig.vault(),
        &rig.keys,
        &rig.state,
        &rig.staging,
        Policy::WIFI,
        T0 + 1_000,
    );
    Scheduler::new(vec![GatewayPass::new(&env, &store).expect("pass")], 8)
        .run(10_000)
        .expect("runs");
    let dir = tempfile::tempdir().expect("dir");
    let out = dir.path().join("restored.db");
    Restore::open(
        &rig.keys,
        &[&store as &dyn centraid_vault::backup::store::Store],
        &next.root.name,
    )
    .expect("opens")
    .records(&out)
    .expect("restores");
    let restored = dump(&Vault::open(&out).expect("opens restored")).expect("dumps");
    assert_eq!(restored, live);
}

#[test]
fn toggling_exclude_videos_after_free_up_space_preserves_video_refs_via_blob_chunk() {
    let rig = Rig::new("excludetoggle");
    let video_bytes = b"a cloud-only video original ".repeat(300);
    let video_id = rig
        .vault()
        .blobs()
        .expect("blobs")
        .put(&video_bytes)
        .expect("puts");
    let video_hash = centraid_media::sealed::PlaintextHash::from_hex(&video_id).expect("hash");
    let entity_id = rig.vault().ids().next();
    let now = rig.vault().clock().now_text();
    rig.vault()
        .commit(|tx| {
            let c = tx.connection();
            centraid_vault::blob::stage(c, &video_id, video_bytes.len() as i64)?;
            tx.insert_entity(&entity_id, centraid_vault::model::Kind::Photo, "", &now)?;
            c.execute(
                "INSERT INTO photo (id, blob, media_type, form) VALUES (?1, ?2, 'video/mp4', 'video')",
                rusqlite::params![entity_id, video_id],
            )?;
            Ok(())
        })
        .expect("commits video");

    // Snapshot 1 (exclude_videos = false): seals and records refs in blob_chunk.
    let first = rig.snapshot_with(Options::at(T0));
    assert_eq!(first.entries_new, 1);
    let first_entries =
        tree::entries_of(&rig.state, &root_of(&rig, &first).blobs).expect("entries");
    let first_entry = first_entries
        .iter()
        .find(|e| e.h == video_hash)
        .expect("video entry");
    assert_eq!(first_entry.kind, tree::EntryKind::Original);
    assert_eq!(first_entry.original.len(), 1);
    let expected_refs = first_entry.original.clone();

    // Remove local bytes ("Free up space") so BlobStore no longer holds the video.
    rig.vault()
        .blobs()
        .expect("blobs")
        .remove(&video_id)
        .expect("removes local copy");

    // Toggle exclude_videos ON -> snapshot writes EntryKind::ExcludedOriginal with empty refs.
    let mut off_opts = Options::at(T0 + 1_000);
    off_opts.exclude_videos = true;
    let excluded = rig.snapshot_with(off_opts);
    let excluded_entries =
        tree::entries_of(&rig.state, &root_of(&rig, &excluded).blobs).expect("entries");
    let excluded_entry = excluded_entries
        .iter()
        .find(|e| e.h == video_hash)
        .expect("excluded entry");
    assert_eq!(excluded_entry.kind, tree::EntryKind::ExcludedOriginal);
    assert!(excluded_entry.original.is_empty());

    // Toggle exclude_videos back OFF -> snapshot recovers the original Refs from blob_chunk.
    let restored = rig.snapshot_with(Options::at(T0 + 2_000));
    let restored_entries =
        tree::entries_of(&rig.state, &root_of(&rig, &restored).blobs).expect("entries");
    let restored_entry = restored_entries
        .iter()
        .find(|e| e.h == video_hash)
        .expect("restored entry");
    assert_eq!(restored_entry.kind, tree::EntryKind::Original);
    assert_eq!(restored_entry.original, expected_refs);
}

#[test]
fn hydrate_blob_chunks_from_root_recovers_cloud_only_originals_across_lose_state() {
    use centraid_vault::backup::engine::{GatewayPass, Scheduler};
    use centraid_vault::backup::snapshot;
    use centraid_vault::backup::store::{MemoryStore, Store as _};

    let mut rig = Rig::new("hydrate");
    let orig_bytes = b"a freed-up original photo ".repeat(300);
    let orig_hash = rig.add_original(&orig_bytes);
    let thumb_hash = rig.add_thumbnail(&orig_hash, b"thumb bytes", "2026-01-02T03:04:05.000Z");

    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 2);
    rig.pair(&store);
    let first = rig.snapshot(T0);
    let first_entries =
        tree::entries_of(&rig.state, &root_of(&rig, &first).blobs).expect("entries");
    let expected_orig_refs = first_entries
        .iter()
        .find(|e| e.h == orig_hash)
        .expect("orig")
        .original
        .clone();
    let expected_thumb_refs = first_entries
        .iter()
        .find(|e| e.h == thumb_hash)
        .expect("thumb")
        .thumbnail
        .clone();

    let env = rig.env(T0);
    Scheduler::new(vec![GatewayPass::new(&env, &store).expect("pass")], 8)
        .run(10_000)
        .expect("runs");

    // "Free up space": delete local original bytes, then lose state.db and staging.
    rig.vault()
        .blobs()
        .expect("blobs")
        .remove(&orig_hash.to_hex())
        .expect("removes local original");
    rig.lose_state(&[&store]);
    assert!(
        rig.state
            .blob_chunks(&orig_hash, Class::Originals)
            .expect("empty")
            .is_empty()
    );

    // Fetch the standing root nodes into the fresh state.db (as VAULT_KNOWN re-pair does),
    // hydrate blob_chunks, and verify the next snapshot preserves the cloud-only original's Refs.
    let head_ref = store.head().expect("head").expect("set").name;
    let restore = centraid_vault::backup::restore::Restore::open(
        &rig.keys,
        &[&store as &dyn centraid_vault::backup::store::Store],
        &head_ref,
    )
    .expect("opens standing root");
    // Load the standing tree nodes into state.db via NodeSource/put_node.
    let mut stack = vec![restore.root.blobs, restore.root.directory];
    stack.extend(restore.root.range_leaves.iter().copied());
    let root_bytes =
        centraid_vault::backup::tree::Node::Root(Box::new(restore.root.clone())).encode();
    rig.state
        .put_node(&restore.root_ref.name, &root_bytes)
        .expect("puts root");
    while let Some(r) = stack.pop() {
        if let Some(plaintext) = tree::NodeSource::plaintext(&restore, &r.name).expect("reads") {
            rig.state.put_node(&r.name, &plaintext).expect("puts node");
            if r.name != restore.root.directory.name
                && let Ok(tree::Node::Blobs(tree::BlobsNode {
                    body: tree::BlobsBody::Children(children),
                    ..
                })) = tree::Node::decode(&plaintext)
            {
                stack.extend(children.into_iter().map(|(_, child)| child));
            }
        }
    }

    let hydrated =
        snapshot::hydrate_blob_chunks_from_root(&rig.state, &restore.root_ref).expect("hydrates");
    assert_eq!(hydrated, 2);
    assert_eq!(
        rig.state
            .blob_chunks(&orig_hash, Class::Originals)
            .expect("orig chunks"),
        expected_orig_refs
    );
    assert_eq!(
        rig.state
            .blob_chunks(&thumb_hash, Class::Thumbnails)
            .expect("thumb chunks"),
        expected_thumb_refs
    );

    let after = rig.snapshot(T0 + 1_000);
    let after_entries =
        tree::entries_of(&rig.state, &root_of(&rig, &after).blobs).expect("entries");
    let after_orig = after_entries
        .iter()
        .find(|e| e.h == orig_hash)
        .expect("orig after");
    assert_eq!(after_orig.original, expected_orig_refs);
}

#[test]
fn concurrent_wal_fold_during_unlocked_snapshot_never_loses_post_pin_writes() {
    use centraid_vault::Vault;
    use centraid_vault::backup::drill::dump;
    use centraid_vault::backup::engine::{Env, GatewayPass, Policy, Scheduler};
    use centraid_vault::backup::restore::Restore;
    use centraid_vault::backup::snapshot;
    use centraid_vault::backup::store::{MemoryStore, Store};

    let rig = Rig::new("foldrace");
    rig.grow(25, "foldrace");
    let store = MemoryStore::new("desk");
    store.set_clock_ms(T0 * 2);
    rig.pair(&store);

    // Baseline full snapshot so `since_full == 0`, `disk_mark` is set, and the next snapshot is
    // incremental (`force_full: false`).
    let first = rig.snapshot(T0);
    assert!(first.full);
    let env = rig.env(T0);
    Scheduler::new(vec![GatewayPass::new(&env, &store).expect("pass")], 8)
        .run(10_000)
        .expect("runs");

    // Pre-pin write so the snapshot has real work and reads `dirty_range` / WAL before pin.
    backup_support::common::insert_note(rig.vault(), "before-pin note").expect("commits");

    // Run `take_with_vault_slot`: between phase 1 (metadata read) and phase 2 (`commit_step`
    // checkpoint, after `PinnedPages` has dropped), commit a write on a second `Vault` handle and
    // run `fold_wal_if_needed(..., threshold_frames = 1)` so `-wal` is truncated and `dirty_range`
    // is populated concurrently!
    let vault_path = rig.vault().path().to_owned();
    let second_handle = Vault::open(&vault_path).expect("second handle opens");
    let mut lock_calls = 0_u32;
    let taken_race = snapshot::take_with_vault_slot(
        rig.vault()
            .blobs()
            .map(|s| s as &dyn centraid_vault::bytes::BlobStore),
        &rig.keys,
        &rig.state,
        &rig.staging,
        &rig.directory,
        Options::at(T0 + 1_000),
        |step| {
            lock_calls += 1;
            if lock_calls == 2 {
                backup_support::common::insert_note(
                    &second_handle,
                    "post-pin-concurrent-fold-note",
                )
                .expect("post-pin write lands on second handle");
                let folded =
                    snapshot::fold_wal_if_needed(&second_handle, &rig.state, T0 + 1_000, 1)
                        .expect("concurrent WAL fold succeeds");
                assert!(
                    folded,
                    "concurrent fold truncated -wal and recorded dirty_range"
                );
            }
            step(rig.vault())
        },
    )
    .expect("unlocked snapshot finishes");

    // The concurrent fold's `dirty_range` must NOT have been wiped by `commit_step`, and the
    // second snapshot (incremental, `force_full: false`) must capture the post-pin write.
    assert!(
        !rig.state.dirty_ranges().expect("dirty_ranges").is_empty(),
        "concurrently folded dirty_range entries are preserved after commit_step"
    );
    assert!(
        rig.state.disk_mark().expect("disk_mark").is_none(),
        "wal_reset leaves disk_mark = None until the next snapshot"
    );
    let _ = taken_race;

    let live = dump(rig.vault()).expect("dumps live");
    let second = rig.snapshot_with(Options::at(T0 + 2_000));
    let env = Env::new(
        rig.vault(),
        &rig.keys,
        &rig.state,
        &rig.staging,
        Policy::WIFI,
        T0 + 2_000,
    );
    Scheduler::new(vec![GatewayPass::new(&env, &store).expect("pass")], 8)
        .run(10_000)
        .expect("runs");

    let dir = tempfile::tempdir().expect("dir");
    let out = dir.path().join("restored.db");
    Restore::open(&rig.keys, &[&store as &dyn Store], &second.root.name)
        .expect("opens")
        .records(&out)
        .expect("restores");
    let restored = dump(&Vault::open(&out).expect("opens restored")).expect("dumps");
    assert_eq!(
        restored, live,
        "post-pin write folded by concurrent fold_wal_if_needed is present in restored vault"
    );
}

#[test]
fn reusing_unchanged_blob_updates_taken_at_metadata() {
    let rig = Rig::new("reusemeta");
    let photo_bytes = b"unchanged photo bytes ".repeat(200);
    let blob_id = rig
        .vault()
        .blobs()
        .expect("blobs")
        .put(&photo_bytes)
        .expect("puts");
    let photo_hash = centraid_media::sealed::PlaintextHash::from_hex(&blob_id).expect("hash");
    let entity_id = rig.vault().ids().next();
    let now = rig.vault().clock().now_text();
    let initial_taken_at = "2024-05-01T10:00:00.000Z";
    let updated_taken_at = "2020-01-15T08:30:00.000Z";

    rig.vault()
        .commit(|tx| {
            let c = tx.connection();
            centraid_vault::blob::stage(c, &blob_id, photo_bytes.len() as i64)?;
            tx.insert_entity(&entity_id, centraid_vault::model::Kind::Photo, "", &now)?;
            c.execute(
                "INSERT INTO photo (id, blob, media_type, form, taken_at) VALUES (?1, ?2, 'image/jpeg', 'photo', ?3)",
                rusqlite::params![entity_id, blob_id, initial_taken_at],
            )?;
            Ok(())
        })
        .expect("commits photo");

    let first = rig.snapshot(T0);
    assert_eq!(first.entries_new, 1);
    let first_entries =
        tree::entries_of(&rig.state, &root_of(&rig, &first).blobs).expect("entries");
    let first_entry = first_entries
        .iter()
        .find(|e| e.h == photo_hash)
        .expect("first entry");
    assert_eq!(
        first_entry.taken_at_ms,
        centraid_vault::clock::parse_iso_ms(initial_taken_at).expect("parses")
    );

    // Update `photo.taken_at` and `media_type` in SQLite without changing the blob bytes.
    rig.vault()
        .commit(|tx| {
            tx.connection().execute(
                "UPDATE photo SET taken_at = ?1, media_type = 'image/heic' WHERE id = ?2",
                rusqlite::params![updated_taken_at, entity_id],
            )?;
            Ok(())
        })
        .expect("updates taken_at");

    let second = rig.snapshot(T0 + 1_000);
    assert_eq!(
        second.entries_new, 0,
        "blob bytes did not change so chunks are reused"
    );
    let second_entries =
        tree::entries_of(&rig.state, &root_of(&rig, &second).blobs).expect("entries");
    let second_entry = second_entries
        .iter()
        .find(|e| e.h == photo_hash)
        .expect("second entry");
    assert_eq!(
        second_entry.taken_at_ms,
        centraid_vault::clock::parse_iso_ms(updated_taken_at).expect("parses")
    );
    assert_eq!(second_entry.media_type, "image/heic");
    assert_eq!(second_entry.original, first_entry.original);
}
