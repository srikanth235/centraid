//! The snapshot plane end to end against `MemoryStore`: a round trip, a
//! snapshot taken while another thread commits, and every refusal a restore
//! owes (#1080).

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use centraid_media::sealed;
use centraid_vault::Vault;
use centraid_vault::backup2::ledger::{Destination, Ledger};
use centraid_vault::backup2::mover::{Stop, move_queue};
use centraid_vault::backup2::naming::{BackupKeys, Digest, Name, PlaintextHash, keys_from_root};
use centraid_vault::backup2::restore::{RestoreError, fetch_and_assemble, restore_head};
use centraid_vault::backup2::snapshot::{self, APP, Manifest, Settled, Snapshot};
use centraid_vault::backup2::spool::{SPOOL_CEILING_BYTES, Spool};
use centraid_vault::backup2::store::{
    Deleted, Head, MemoryStore, ObjectEntry, Put, SnapshotEntry, Store, StoreError,
};
use centraid_vault::clock::SystemClock;

const VAULT_ID: &str = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";

fn keys() -> BackupKeys {
    keys_from_root(&[0x42; 32])
}

fn pair(ledger: &Ledger, store: &MemoryStore) {
    ledger
        .put_destination(&Destination {
            gateway_id: store.gateway_id().to_owned(),
            addrs: vec!["192.168.1.20:7443".to_owned()],
            cert_der: vec![0x30],
            token: "0".repeat(64),
            epoch: store.epoch(),
            label: "The laptop".to_owned(),
            paired_at_ms: 1,
            last_seen_ms: None,
            last_ack_ms: None,
        })
        .expect("pairs");
}

/// Take, plan, spool, move and settle one snapshot; return it.
fn back_up(vault: &Vault, dir: &Path, store: &MemoryStore) -> Snapshot {
    let keys = keys();
    let ledger = Ledger::open(Ledger::path_for(vault.path())).expect("a ledger");
    pair(&ledger, store);
    let spool = Spool::open(Spool::dir_for(vault.path())).expect("a spool");
    let snapshot =
        snapshot::take(vault, &keys, &dir.join("scratch"), VAULT_ID, APP).expect("takes");
    let plan = snapshot::plan(&snapshot, store).expect("plans");
    snapshot::spool(
        &snapshot,
        &plan,
        &spool,
        &ledger,
        &keys,
        SPOOL_CEILING_BYTES,
        1,
    )
    .expect("spools");
    let moved = move_queue(
        &ledger,
        &spool,
        store,
        Instant::now() + Duration::from_secs(120),
        &SystemClock,
    )
    .expect("moves");
    assert_eq!(moved.stopped, Stop::Empty);
    match snapshot::settle(
        &ledger,
        store,
        &snapshot.manifest_name,
        &snapshot.manifest,
        &SystemClock,
    )
    .expect("settles")
    {
        Settled::HeadSet(head) => assert_eq!(head.name, snapshot.manifest_name),
        other => panic!("the head did not move: {other:?}"),
    }
    snapshot
}

/// Every row of every table a member has rows in, as text, sorted.
fn dump(vault: &Vault, census: &BTreeMap<String, i64>) -> BTreeMap<String, Vec<String>> {
    vault
        .read(|connection| {
            let mut out = BTreeMap::new();
            for table in census.keys() {
                let mut statement = connection.prepare(&format!("SELECT * FROM \"{table}\""))?;
                let columns = statement.column_count();
                let mut rows: Vec<String> = statement
                    .query_map([], |row| {
                        let values: Vec<rusqlite::types::Value> = (0..columns)
                            .map(|index| row.get(index))
                            .collect::<rusqlite::Result<_>>()?;
                        Ok(format!("{values:?}"))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                rows.sort();
                out.insert(table.clone(), rows);
            }
            Ok(out)
        })
        .expect("dumps")
}

#[test]
fn a_founded_vault_round_trips_through_a_snapshot_and_a_restore() {
    let scratch = common::Scratch::founded("backup2-round-trip").expect("a vault");
    for index in 0..25 {
        common::insert_note(&scratch.vault, &format!("note {index}")).expect("writes");
    }
    let store = MemoryStore::new("laptop");
    let snapshot = back_up(&scratch.vault, scratch.dir(), &store);
    let before = dump(&scratch.vault, &snapshot.manifest.census);

    let restored_path = scratch.join("restored.db");
    let restored = restore_head(&store, &keys(), &restored_path).expect("restores");
    assert_eq!(restored.manifest, snapshot.manifest);
    let names: Vec<&str> = restored.checks.iter().map(|check| check.name).collect();
    assert_eq!(
        names,
        [
            "manifest",
            "ranges",
            "db_hash",
            "integrity_check",
            "header",
            "census"
        ]
    );
    let reopened = Vault::open(&restored_path).expect("opens through the ladder");
    assert_eq!(dump(&reopened, &snapshot.manifest.census), before);

    // The store holds ciphertext only: no plaintext range and no plaintext
    // hash of one is readable in any object.
    let copy = std::fs::read(&snapshot.path).expect("the scratch copy");
    for (_, sealed) in store.contents() {
        for range in &snapshot.ranges {
            assert!(
                !sealed
                    .windows(32)
                    .any(|window| window == range.h.as_bytes())
            );
        }
        assert!(!sealed.windows(64).any(|window| window == &copy[4096..4160]));
    }
}

/// **The online backup under a writer trying to commit (R-1080-B6).** A
/// vault shared across threads is behind a `Mutex`, so `commit` and `copy`
/// take turns. Each round the writer is released at the moment the copy holds
/// the vault, so every copy runs while a commit is being attempted; each
/// commit writes two parties, so a copy that caught half a transaction would
/// hold an even count beside the owner — and every copy holds exactly the
/// commits made before it.
#[test]
fn a_snapshot_taken_while_another_thread_commits_is_exactly_a_committed_state() {
    const ROUNDS: usize = 8;
    const PER_ROUND: usize = 15;
    let dir = tempfile::tempdir().expect("a directory");
    let vault = Vault::create(dir.path().join("vault.db")).expect("a vault");
    vault.found("Household", "Ada").expect("founds");
    let shared = Arc::new(Mutex::new(vault));
    let (go, released) = mpsc::channel::<()>();
    let (burst_done, bursts) = mpsc::channel::<()>();
    let writer = {
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || {
            for round in 0..ROUNDS {
                released.recv().expect("released");
                for index in 0..PER_ROUND {
                    let vault = shared.lock().expect("the vault");
                    let now = vault.clock().now_text();
                    let (first, second) = (vault.ids().next(), vault.ids().next());
                    vault
                        .commit(|tx| {
                            for (id, side) in [(&first, "left"), (&second, "right")] {
                                tx.connection().execute(
                                    "INSERT INTO core_party
                                       (party_id, kind, display_name, created_at, updated_at)
                                     VALUES (?1, 'person', ?2, ?3, ?3)",
                                    rusqlite::params![id, format!("{side} {round}.{index}"), now],
                                )?;
                            }
                            Ok(())
                        })
                        .expect("commits");
                }
                burst_done.send(()).expect("reports");
            }
        })
    };

    let keys = keys();
    for round in 0..ROUNDS {
        let copied = {
            let vault = shared.lock().expect("the vault");
            go.send(()).expect("releases the writer");
            // The writer is now blocked on the lock, mid-attempt, for the
            // whole copy.
            std::thread::sleep(Duration::from_millis(5));
            snapshot::copy(&vault, &dir.path().join(format!("s{round}"))).expect("copies")
        };
        let described = snapshot::describe(&copied, &keys, VAULT_ID, APP).expect("describes");
        let parties = described.manifest.census["core_party"];
        assert_eq!(
            parties,
            i64::try_from(1 + 2 * PER_ROUND * round).expect("fits"),
            "snapshot {round} is not exactly the commits made before it"
        );
        let connection = rusqlite::Connection::open_with_flags(
            &copied.path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("opens");
        let integrity: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("checks");
        assert_eq!(integrity, "ok");
        bursts.recv().expect("the writer's burst");
    }
    writer.join().expect("the writer finishes");
}

/// A store that answers one name with another's bytes: what a gateway that
/// mixed objects up would serve.
struct Swapped<'a> {
    inner: &'a MemoryStore,
    asked: Name,
    served: Name,
}

impl Store for Swapped<'_> {
    fn gateway_id(&self) -> &str {
        self.inner.gateway_id()
    }
    fn exists(&self, names: &[Name]) -> Result<Vec<Name>, StoreError> {
        self.inner.exists(names)
    }
    fn put(
        &self,
        name: &Name,
        digest: &Digest,
        len: u64,
        body: &mut dyn Read,
    ) -> Result<Put, StoreError> {
        self.inner.put(name, digest, len, body)
    }
    fn get(&self, name: &Name, sink: &mut dyn Write) -> Result<u64, StoreError> {
        let name = if *name == self.asked {
            &self.served
        } else {
            name
        };
        self.inner.get(name, sink)
    }
    fn head(&self) -> Result<Option<Head>, StoreError> {
        self.inner.head()
    }
    fn set_head(
        &self,
        name: &Name,
        prev: Option<&Name>,
        taken_at_ms: u64,
    ) -> Result<Head, StoreError> {
        self.inner.set_head(name, prev, taken_at_ms)
    }
    fn snapshots(&self) -> Result<Vec<SnapshotEntry>, StoreError> {
        self.inner.snapshots()
    }
    fn list(&self, after: Option<&Name>, limit: usize) -> Result<Vec<ObjectEntry>, StoreError> {
        self.inner.list(after, limit)
    }
    fn delete(&self, names: &[Name]) -> Result<Deleted, StoreError> {
        self.inner.delete(names)
    }
}

/// Upload a manifest edited by `edit`, sealed with the vault's own keys, and
/// make it the head — the strongest forgery: only the census or the hash can
/// catch it.
fn forge(store: &MemoryStore, snapshot: &Snapshot, edit: impl FnOnce(&mut Manifest)) -> Name {
    let mut manifest = snapshot.manifest.clone();
    edit(&mut manifest);
    let json = manifest.to_json().expect("serialises");
    let name = sealed::name(&keys(), &PlaintextHash::of(&json), 0);
    let bytes = sealed::seal_part(&keys(), 0, &json, true).expect("seals");
    store
        .put(
            &name,
            &Digest::of(&bytes),
            bytes.len() as u64,
            &mut bytes.as_slice(),
        )
        .expect("stores");
    store
        .set_head(&name, Some(&snapshot.manifest_name), manifest.taken_at_ms)
        .expect("moves the head");
    name
}

#[test]
fn a_restore_refuses_every_file_that_is_not_the_snapshots_and_leaves_nothing() {
    let scratch = common::Scratch::founded("backup2-refusals").expect("a vault");
    common::insert_note(&scratch.vault, "a note").expect("writes");
    let store = MemoryStore::new("laptop");
    let snapshot = back_up(&scratch.vault, scratch.dir(), &store);
    let keys = keys();
    let out = scratch.join("restored.db");

    // A range served under another's name: the manifest, here.
    let swapped = Swapped {
        inner: &store,
        asked: snapshot.ranges[0].name,
        served: snapshot.manifest_name,
    };
    assert!(matches!(
        fetch_and_assemble(&swapped, &keys, &snapshot.manifest_name, &out),
        Err(RestoreError::Range { i: 0, .. })
    ));
    // A head that names a range instead of a manifest.
    assert!(matches!(
        fetch_and_assemble(&store, &keys, &snapshot.ranges[0].name, &out),
        Err(RestoreError::Manifest(_))
    ));
    // Keys of another vault open nothing.
    assert!(matches!(
        fetch_and_assemble(
            &store,
            &keys_from_root(&[1; 32]),
            &snapshot.manifest_name,
            &out
        ),
        Err(RestoreError::Manifest(_))
    ));

    // **Red first for the census and the hash**: a manifest the vault's own
    // keys sealed, saying one more party, or another file.
    let counted = forge(&store, &snapshot, |manifest| {
        *manifest.census.get_mut("core_party").expect("a census row") += 1;
    });
    match restore_head(&store, &keys, &out) {
        Err(RestoreError::Census {
            table,
            expected,
            found,
        }) => {
            assert_eq!(table, "core_party");
            assert_eq!(expected, found.map(|rows| rows + 1));
        }
        other => panic!("the census did not refuse: {other:?}"),
    }
    store
        .set_head(&snapshot.manifest_name, Some(&counted), 1)
        .expect("moves back");
    forge(&store, &snapshot, |manifest| {
        manifest.db_hash = PlaintextHash::of(b"another file");
    });
    assert!(matches!(
        restore_head(&store, &keys, &out),
        Err(RestoreError::DbHash)
    ));
    assert!(
        !out.exists(),
        "a refused restore leaves nothing at its path"
    );
    assert!(!scratch.join("restored.db.partial").exists());

    // A missing range is named, and a restore never writes over a file.
    let fresh = MemoryStore::new("other");
    let _ = back_up(&scratch.vault, &scratch.join("again"), &fresh);
    fresh
        .delete(&[snapshot.ranges[0].name])
        .expect("tombstones");
    assert!(matches!(
        restore_head(&fresh, &keys, &out),
        Err(RestoreError::Range { i: 0, .. })
    ));
    std::fs::write(&out, b"somebody's file").expect("plants");
    assert!(matches!(
        restore_head(&store, &keys, &out),
        Err(RestoreError::Exists(_))
    ));
}
