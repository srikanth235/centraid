//! **The crash matrix and the replay fuzz** (#1029 §2, W3 validation).
//!
//! Reference B's validation list for W3 is three things: "the crash matrix, the
//! replay fuzz test (random commits → capture → restore → compare file bytes and
//! census), and one red-first test per B-defect". The per-defect tests live
//! beside the code they are about; the two whole-path ones live here, because
//! neither is about a module.
//!
//! ## What "kill at every step" means without killing a process
//!
//! Each case stops the sequence at one step and then asks the **next** tick to
//! carry on from whatever is on disk. That is what a crash leaves behind: a
//! prefix of the writes, and a process that has forgotten everything it held in
//! memory. Every case ends with the same question — **does a restore land on the
//! last spooled commit?** — and every case must answer yes.
//!
//! The one thing this cannot simulate in-process is the operating system taking
//! the app away mid-`write`. What it can and does simulate is every ordering
//! between the durable steps, which is where the design's claims actually live.
//!
//! ## A note on closing a vault
//!
//! In WAL mode SQLite checkpoints and removes the `-wal` when the last
//! connection closes, and `SQLITE_FCNTL_PERSIST_WAL` — the file-control that
//! turns that off — needs C and is deliberately unset (W1). So "reopen after a
//! crash" here finds a **fresh log with new salts**, which capture reads as a
//! break and answers with a new generation. That is correct and lossless: the
//! frames went into the main database file, and the new generation's base
//! carries them. `a_foreign_checkpoint_between_ticks_breaks_into_a_new_generation`
//! is that case, asserted rather than assumed.

use std::path::Path;

use centraid_vault::backup::objects::ObjectKeys;
use centraid_vault::backup::store::BlobStore as _;
use centraid_vault::backup::{self, BackupHome, GenerationManifest, Spool};
use centraid_vault::file::Vault;

fn keys() -> ObjectKeys {
    ObjectKeys::new([0x77; 32], [0x88; 32])
}

/// SplitMix64. A fuzz test that cannot be replayed from its seed is a flake
/// generator, so the generator is written down rather than pulled in.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound.max(1)
    }
}

/// A store that stops accepting bytes. **The disk filling, as the code sees
/// it**: every write in the path fails, and nothing that was already written is
/// lost.
///
/// Permissions are not used for this: the tests run as root in CI, where a
/// read-only directory is still writable, so a permission-based simulation
/// would pass vacuously.
struct FullDisk {
    inner: centraid_vault::backup::FsBlobStore,
    full: std::sync::atomic::AtomicBool,
}

impl FullDisk {
    fn new(inner: centraid_vault::backup::FsBlobStore) -> Self {
        Self {
            inner,
            full: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn fill(&self) {
        self.full.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn empty(&self) {
        self.full.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    fn is_full(&self) -> bool {
        self.full.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl centraid_vault::backup::BlobStore for FullDisk {
    fn put(&self, bytes: &[u8]) -> centraid_vault::backup::store::Result<String> {
        if self.is_full() {
            return Err(centraid_vault::backup::BlobError::Io {
                path: self.inner.root().to_path_buf(),
                source: std::io::Error::from(std::io::ErrorKind::StorageFull),
            });
        }
        self.inner.put(bytes)
    }

    fn get(&self, id: &str) -> centraid_vault::backup::store::Result<Vec<u8>> {
        self.inner.get(id)
    }

    fn has(&self, id: &str) -> centraid_vault::backup::store::Result<bool> {
        self.inner.has(id)
    }

    fn ids(&self) -> centraid_vault::backup::store::Result<std::collections::BTreeSet<String>> {
        self.inner.ids()
    }

    fn size(&self, id: &str) -> centraid_vault::backup::store::Result<u64> {
        self.inner.size(id)
    }

    fn path_of(
        &self,
        id: &str,
    ) -> centraid_vault::backup::store::Result<Option<std::path::PathBuf>> {
        self.inner.path_of(id)
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
    vault: Vault,
    home: BackupHome,
    spool: Spool,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("a directory");
    let root = dir.path().to_path_buf();
    std::fs::create_dir_all(root.join("live")).expect("makes the live directory");
    let vault = Vault::create(root.join("live").join("vault.db")).expect("creates");
    vault.found("The Matrix Household", "Ada").expect("founds");
    let home = BackupHome::open(root.join("backup")).expect("opens");
    let spool = home.spool().expect("opens the spool");
    Fixture {
        _dir: dir,
        root,
        vault,
        home,
        spool,
    }
}

fn write_rows(vault: &Vault, from: usize, count: usize) {
    for index in from..from + count {
        vault
            .commit(|tx| {
                tx.set_producer("matrix.write");
                tx.connection().execute(
                    "INSERT INTO core_content_item \
                       (content_id, content_uri, content_hash, byte_size, created_at) \
                     VALUES (?1, ?2, ?3, ?4, '2026-01-01T00:00:00.000Z')",
                    rusqlite::params![
                        format!("content-{index}"),
                        format!("cas:content-{index}"),
                        centraid_vault::content::content_digest(format!("row {index}").as_bytes()),
                        index as i64,
                    ],
                )?;
                Ok(())
            })
            .expect("writes");
    }
}

fn delete_rows(vault: &Vault, pattern: &str) {
    vault
        .commit(|tx| {
            tx.set_producer("matrix.delete");
            tx.connection().execute(
                "DELETE FROM core_content_item WHERE content_id LIKE ?1",
                rusqlite::params![pattern],
            )?;
            Ok(())
        })
        .expect("deletes");
}

/// Restore the newest generation from the store and hand back its file and the
/// txid it landed on.
fn restore_newest(home: &BackupHome, keys: &ObjectKeys, into: &Path) -> (u64, Vec<(String, i64)>) {
    let blobs = home.objects().expect("opens the store");
    let head = centraid_vault::backup::ManifestHead::read(&home.head_path())
        .expect("reads the head")
        .expect("there is a head");
    let bytes = blobs.get(&head.manifest).expect("the manifest is stored");
    let manifest = GenerationManifest::open(keys, &bytes).expect("opens");
    let restored =
        backup::restore::restore_generation(keys, &manifest, &blobs, into, None).expect("restores");
    assert_eq!(
        restored.census_matches(into).expect("asks"),
        Ok(()),
        "the restored census must be the census the generation carried"
    );
    (restored.txid, restored.census)
}

fn rows_in(file: &Path) -> i64 {
    let connection =
        rusqlite::Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("opens");
    connection
        .query_row("SELECT count(*) FROM core_content_item", [], |row| {
            row.get(0)
        })
        .expect("counts")
}

// ---------------------------------------------------------- the crash matrix

/// **Step 1: the process dies after a commit and before capture runs.**
///
/// The commit is in the fsynced WAL; nothing is in the spool. The next tick has
/// to pick the frames up from the durable cursor, which has not moved.
#[test]
fn a_crash_between_a_commit_and_the_capture_tick_loses_nothing() {
    let fixture = fixture();
    write_rows(&fixture.vault, 0, 6);
    // The tick never ran: no cursor, no segment.
    assert!(fixture.spool.entries().expect("lists").is_empty());

    // The next tick, as if after a restart.
    let outcome = backup::capture(&fixture.vault, &fixture.spool, &keys()).expect("captures");
    assert!(outcome.entry.is_some(), "the frames were still there");
    assert!(
        outcome.commits >= 7,
        "six rows plus founding's own commits, and {} were cut",
        outcome.commits
    );
    assert!(fixture.spool.covers(1, outcome.last_txid).expect("asks"));
}

/// **Step 2: the process dies after the segment is spooled and before the
/// cursor is recorded.**
///
/// The one window the design deliberately leaves open, because re-capturing is
/// free and losing is not: the next tick re-reads the same frames and spools
/// them again under a **different object name** (the nonces are random), and the
/// spool then holds two entries covering one txid range. What must hold is that
/// the range is still covered and a restore still lands on it.
#[test]
fn a_crash_between_the_spool_write_and_the_cursor_record_re_captures_rather_than_losing() {
    let fixture = fixture();
    let keys = keys();
    write_rows(&fixture.vault, 0, 4);

    let first = backup::capture(&fixture.vault, &fixture.spool, &keys).expect("captures");
    let entry = first.entry.expect("a segment");

    // Rewind the cursor to what it was before the tick: the crash happened
    // after the spool write and before the record.
    let cursor = fixture.spool.cursor().expect("reads").expect("a cursor");
    fixture
        .spool
        .record_cursor(&centraid_vault::backup::SpoolCursor::at(
            cursor.generation,
            0,
        ))
        .expect("rewinds");

    let second = backup::capture(&fixture.vault, &fixture.spool, &keys).expect("re-captures");
    let again = second.entry.expect("a segment");
    assert_eq!(
        (again.first_txid, again.last_txid),
        (entry.first_txid, entry.last_txid),
        "the same commits, re-cut"
    );
    assert_ne!(
        again.object, entry.object,
        "sealed again means sealed under fresh nonces, never the same object"
    );
    assert_eq!(fixture.spool.entries().expect("lists").len(), 2);
    assert!(fixture.spool.covers(1, again.last_txid).expect("asks"));
}

/// **Step 3: a checkpoint is attempted while the log holds an uncaptured
/// commit.**
///
/// This is the one that loses data if it is allowed, and it is refused (F11).
/// The refusal does not come from the spool's own bookkeeping — the cursor only
/// knows what capture told it, so a commit made after the last tick is invisible
/// there. It comes from reading the log, which is the only honest witness.
#[test]
fn a_checkpoint_ahead_of_the_spool_is_refused_rather_than_taken() {
    let fixture = fixture();
    let keys = keys();
    write_rows(&fixture.vault, 0, 3);
    backup::capture(&fixture.vault, &fixture.spool, &keys).expect("captures");
    backup::checkpoint(&fixture.vault, &fixture.spool).expect("a fully captured log checkpoints");

    // Commits the spool does not hold, and no tick since.
    write_rows(&fixture.vault, 3, 3);
    let error = backup::checkpoint(&fixture.vault, &fixture.spool).expect_err("must refuse");
    assert!(
        error
            .to_string()
            .contains("every committed frame must be in the spool"),
        "{error}"
    );
    // And the log is still there, because the checkpoint did not run.
    assert!(
        centraid_vault::backup::wal::read_sidecar(fixture.vault.path())
            .expect("reads")
            .is_some_and(|bytes| bytes.len() > 32),
        "a refused checkpoint leaves the log alone"
    );

    // Capture, and it goes through.
    backup::capture(&fixture.vault, &fixture.spool, &keys).expect("captures");
    backup::checkpoint(&fixture.vault, &fixture.spool).expect("now it may");
}

/// **Step 4: the process dies during a base build, before the generation is
/// recorded.**
///
/// The store holds range objects and no manifest names them. Two things must
/// hold: the next generation must succeed, and those objects must be **in the
/// vault's index**, so a range whose bytes have not changed is reused rather
/// than sealed again. That index is what makes an abandoned build cost nothing
/// on the retry, and it is what §2 means by "the phone decides that from a local
/// upload index; the gateway is never asked".
#[test]
fn a_crash_during_a_base_build_leaves_indexed_objects_and_the_next_one_succeeds() {
    let fixture = fixture();
    let keys = keys();
    let blobs = fixture.home.objects().expect("opens");
    write_rows(&fixture.vault, 0, 8);
    backup::capture(&fixture.vault, &fixture.spool, &keys).expect("captures");
    backup::checkpoint(&fixture.vault, &fixture.spool).expect("checkpoints");

    let generation = centraid_vault::backup::GenerationId::mint().expect("mints");
    let abandoned = backup::build_base(
        &fixture.vault,
        &keys,
        &blobs,
        generation,
        0,
        &fixture.home.scratch(),
    )
    .expect("builds");
    // No manifest, no head: as far as the chain is concerned this never
    // happened.
    assert!(
        centraid_vault::backup::ManifestHead::read(&fixture.home.head_path())
            .expect("reads")
            .is_none()
    );
    let indexed = backup::base::read_object_index(&fixture.vault).expect("reads the index");
    for range in &abandoned.ranges {
        assert!(
            indexed.contains_key(&range.plaintext_hash),
            "the abandoned build's objects must be reusable through the in-vault index"
        );
        assert!(blobs.has(&range.object_name).expect("asks"));
    }

    let outcome =
        backup::take_generation(&fixture.vault, &keys, &fixture.home, &blobs, None).expect("takes");
    let restored = fixture.root.join("restored.db");
    let (txid, _) = restore_newest(&fixture.home, &keys, &restored);
    assert_eq!(txid, outcome.last_txid);
    assert_eq!(rows_in(&restored), 8);
}

/// **Step 5: the disk fills.**
///
/// Nothing is released, the spool still covers every commit, and the next
/// attempt on a working disk restores everything. That is F11's rule 5 under
/// the one condition that tests it: the spool is the only copy, so a failure
/// that dropped it would be the commit the member lost.
#[test]
fn a_disk_full_during_a_generation_releases_nothing_and_the_retry_restores() {
    let fixture = fixture();
    let keys = keys();
    let blobs = FullDisk::new(fixture.home.objects().expect("opens"));
    write_rows(&fixture.vault, 0, 6);
    backup::capture(&fixture.vault, &fixture.spool, &keys).expect("captures");
    let before: Vec<_> = fixture.spool.entries().expect("lists");
    assert!(!before.is_empty());

    blobs.fill();
    let failed = backup::take_generation(&fixture.vault, &keys, &fixture.home, &blobs, None);
    assert!(
        failed.is_err(),
        "a store that will not take bytes must fail"
    );
    assert_eq!(
        fixture.spool.entries().expect("lists"),
        before,
        "a failed generation releases nothing — the spool is the only copy"
    );

    blobs.empty();
    let outcome = backup::take_generation(&fixture.vault, &keys, &fixture.home, &blobs, None)
        .expect("retries");
    let restored = fixture.root.join("restored.db");
    let (txid, _) = restore_newest(&fixture.home, &keys, &restored);
    assert_eq!(txid, outcome.last_txid);
    assert_eq!(rows_in(&restored), 6);
}

/// **Step 6: a foreign checkpoint restarts the log between ticks.**
///
/// This is B6's race. A checkpoint somebody else took — a debugging tool, a
/// share extension, or SQLite's own close-on-last-connection, which cannot be
/// turned off without `SQLITE_FCNTL_PERSIST_WAL` — restarts the log with new
/// salts. Capture must see a **break**, start a new generation, and lose
/// nothing: the frames went into the main database file, and the new
/// generation's base carries them.
#[test]
fn a_foreign_checkpoint_between_ticks_breaks_into_a_new_generation() {
    let fixture = fixture();
    let keys = keys();
    write_rows(&fixture.vault, 0, 5);
    let first = backup::capture(&fixture.vault, &fixture.spool, &keys).expect("captures");
    let generation = first.generation;

    // More commits, then somebody else's TRUNCATE — taken straight on the
    // connection, behind capture's back.
    let blobs = fixture.home.objects().expect("opens");
    write_rows(&fixture.vault, 5, 5);
    {
        // A SECOND OPENER, which is exactly the shape of the defect: Reference
        // B's "any other opener with default `wal_autocheckpoint` (an iOS share
        // extension, a debugging tool) restarts the WAL under capture".
        let foreign = rusqlite::Connection::open(fixture.vault.path()).expect("opens");
        foreign
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("checkpoints behind capture's back");
    }
    write_rows(&fixture.vault, 10, 2);

    let after = backup::capture(&fixture.vault, &fixture.spool, &keys).expect("captures");
    assert!(after.broke, "a restart mid-cursor is a break");
    assert_ne!(
        after.generation, generation,
        "a break starts a NEW generation and never edits the old one"
    );

    // And nothing is lost: the new generation's base is taken from the file the
    // foreign checkpoint folded those frames into.
    let outcome =
        backup::take_generation(&fixture.vault, &keys, &fixture.home, &blobs, None).expect("takes");
    let restored = fixture.root.join("restored.db");
    let (txid, _) = restore_newest(&fixture.home, &keys, &restored);
    assert_eq!(txid, outcome.last_txid);
    assert_eq!(rows_in(&restored), 12, "every row survives the break");
}

/// **B2, the positive statement.** `backup now` used to fail whenever there was
/// a WAL tail: `pending_tail` handed back already-sealed bytes and the
/// generation sealed them again, which the length check then rejected. The
/// drill and the export both passed `&[]`, so nothing tested it.
///
/// A generation over a vault with a live log is now the ordinary case, and the
/// two properties that made the old one impossible are asserted here: a segment
/// is **sealed once**, and a retry **re-sends the same ciphertext** rather than
/// resealing it (B9, §4).
#[test]
fn a_generation_over_a_live_log_succeeds_and_a_retry_re_sends_rather_than_reseals() {
    let fixture = fixture();
    let keys = keys();
    let blobs = fixture.home.objects().expect("opens");
    write_rows(&fixture.vault, 0, 5);

    // The spool's sealed bytes, and the name they will be stored under. The
    // name IS the BLAKE3 of the ciphertext, so an upload that resealed would
    // land under a different one.
    let tick = backup::capture(&fixture.vault, &fixture.spool, &keys).expect("captures");
    let entry = tick.entry.expect("a segment");
    let sealed = fixture.spool.read(&entry).expect("reads the spool");
    assert_eq!(
        centraid_media::object::ObjectName::of(&sealed).hex(),
        entry.object,
        "the spool records the object's own name"
    );
    let first = blobs.put(&sealed).expect("stores");
    let retried = blobs.put(&sealed).expect("re-sends");
    assert_eq!(first, retried, "a retry is one blob, not a second seal");
    assert_eq!(first, entry.object);

    // And the generation itself, over a vault whose log is not empty.
    let outcome = backup::take_generation(&fixture.vault, &keys, &fixture.home, &blobs, None)
        .expect("a WAL tail is the ordinary case, not a failure");
    assert!(
        !outcome.segments.is_empty(),
        "the tail collected AFTER the base is the generation's segments (B5)"
    );
    for segment in &outcome.segments {
        let bytes = blobs.get(&segment.object).expect("stored");
        let plain = keys
            .open(centraid_media::object::Kind::Segment, &bytes)
            .expect("opens as a segment");
        let decoded = centraid_vault::backup::PageSegment::decode(&plain).expect("decodes");
        assert_eq!(decoded.first_txid, segment.first_txid);
        assert_eq!(decoded.last_txid, segment.last_txid);
    }

    let restored = fixture.root.join("restored.db");
    let (txid, _) = restore_newest(&fixture.home, &keys, &restored);
    assert_eq!(txid, outcome.last_txid);
    assert_eq!(rows_in(&restored), 5);
}

/// **Every generation restores to the last commit the spool held**, across a
/// run of ticks, checkpoints and generations — the matrix's summary claim.
#[test]
fn a_run_of_ticks_checkpoints_and_generations_always_restores_to_the_last_spooled_commit() {
    let fixture = fixture();
    let keys = keys();
    let blobs = fixture.home.objects().expect("opens");
    let mut previous: Option<String> = None;
    let mut written = 0_usize;

    for round in 0..4 {
        write_rows(&fixture.vault, written, 3);
        written += 3;
        backup::capture(&fixture.vault, &fixture.spool, &keys).expect("captures");
        if round % 2 == 0 {
            backup::checkpoint(&fixture.vault, &fixture.spool).expect("checkpoints");
        }
        let outcome = backup::take_generation(
            &fixture.vault,
            &keys,
            &fixture.home,
            &blobs,
            previous.as_deref(),
        )
        .expect("takes");
        previous = Some(outcome.manifest.clone());

        let restored = fixture.root.join(format!("restored-{round}.db"));
        let (txid, _) = restore_newest(&fixture.home, &keys, &restored);
        assert_eq!(txid, outcome.last_txid, "round {round}");
        assert_eq!(rows_in(&restored), written as i64, "round {round}");
    }
}

// ------------------------------------------------------------ the replay fuzz

/// **The replay fuzz**: random commits → capture → restore → compare **file
/// bytes** and **census** (Reference B, W3 validation).
///
/// The seeds are fixed so a failure is reproducible; the shapes they produce are
/// not. Inserts, deletes and a checkpoint at random points give the three
/// things that make a replay hard: pages written more than once in a range, a
/// transaction that frees pages and shrinks the file, and a log that restarts
/// under the cursor.
#[test]
fn random_commits_capture_and_restore_to_the_same_bytes_and_the_same_census() {
    for seed in [1_u64, 7, 42, 1_729, 90_210] {
        let fixture = fixture();
        let keys = keys();
        let blobs = fixture.home.objects().expect("opens");
        let mut rng = Rng(seed);
        let mut written = 0_usize;

        for _ in 0..8 {
            match rng.below(4) {
                0 if written > 4 => delete_rows(
                    &fixture.vault,
                    &format!("content-{}", rng.below(written as u64)),
                ),
                1 => {
                    let count = 1 + rng.below(5) as usize;
                    write_rows(&fixture.vault, written, count);
                    written += count;
                }
                2 => {
                    backup::capture(&fixture.vault, &fixture.spool, &keys).expect("captures");
                    backup::checkpoint(&fixture.vault, &fixture.spool).expect("checkpoints");
                }
                _ => {
                    let count = 1 + rng.below(9) as usize;
                    write_rows(&fixture.vault, written, count);
                    written += count;
                }
            }
        }

        backup::capture(&fixture.vault, &fixture.spool, &keys).expect("captures");
        let outcome = backup::take_generation(&fixture.vault, &keys, &fixture.home, &blobs, None)
            .expect("takes");
        // The file as it stands, with the log folded in, is what byte-exactness
        // is measured against.
        backup::checkpoint(&fixture.vault, &fixture.spool).expect("checkpoints");
        let live = std::fs::read(fixture.vault.path()).expect("reads");
        let live_census =
            centraid_vault::backup::drill::census(fixture.vault.path()).expect("counts");

        let restored = fixture.root.join("fuzz-restored.db");
        let (txid, census) = restore_newest(&fixture.home, &keys, &restored);
        assert_eq!(txid, outcome.last_txid, "seed {seed}");

        let back = std::fs::read(&restored).expect("reads");
        assert_eq!(
            back.len(),
            live.len(),
            "seed {seed}: the file is a different size"
        );
        let first_diff = back
            .iter()
            .zip(&live)
            .position(|(left, right)| left != right);
        assert_eq!(
            first_diff.filter(|at| *at >= 100),
            None,
            "seed {seed}: first differing byte at {first_diff:?} of {} (page {:?})",
            live.len(),
            first_diff.map(|at| at / 4096 + 1)
        );
        for (table, rows) in &census {
            assert_eq!(
                live_census.get(table),
                Some(rows),
                "seed {seed}: {table} disagrees"
            );
        }
    }
}
