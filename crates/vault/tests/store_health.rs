//! The content store, kept honestly (#1191, V20): a sweep of unclaimed files lists the directory
//! once for the whole pass, and a thumbnail write asks about the file it replaced and walks no
//! library. (A rotted file healed on re-add is tested where the store is, in `centraid-blobs`.)

mod common;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

use centraid_vault::bytes::BlobStore;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

/// The real content store behind a counter of how many times its directory is listed.
struct Counting {
    inner: centraid_blobs::ContentBytes,
    listings: Arc<AtomicUsize>,
}

impl BlobStore for Counting {
    fn put(&self, bytes: &[u8]) -> centraid_vault::bytes::Result<String> {
        self.inner.put(bytes)
    }
    fn get(&self, id: &str) -> centraid_vault::bytes::Result<Vec<u8>> {
        self.inner.get(id)
    }
    fn has(&self, id: &str) -> centraid_vault::bytes::Result<bool> {
        self.inner.has(id)
    }
    fn ids(&self) -> centraid_vault::bytes::Result<BTreeSet<String>> {
        self.listings.fetch_add(1, Ordering::SeqCst);
        self.inner.ids()
    }
    fn size(&self, id: &str) -> centraid_vault::bytes::Result<u64> {
        self.inner.size(id)
    }
    fn remove(&self, id: &str) -> centraid_vault::bytes::Result<bool> {
        self.inner.remove(id)
    }
    fn path_of(&self, id: &str) -> centraid_vault::bytes::Result<Option<PathBuf>> {
        self.inner.path_of(id)
    }
}

struct World {
    vault: Vault,
    registry: Registry,
    listings: Arc<AtomicUsize>,
    _dir: PathBuf,
}

impl World {
    fn new() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a directory");
        let file = dir.join("vault.db");
        let store = centraid_blobs::ByteStore::open(file.with_extension("bytes")).expect("a store");
        let listings = Arc::new(AtomicUsize::new(0));
        let vault = Vault::create_with(
            &file,
            Box::new(Arc::new(FixedClock::frozen())),
            Box::new(SeededIds::new("store-health")),
        )
        .expect("a vault")
        .with_blobs(Box::new(Counting {
            inner: centraid_blobs::ContentBytes::new(store),
            listings: Arc::clone(&listings),
        }));
        vault.found("Test", "Owner").expect("founds");
        Self {
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
            listings,
            _dir: dir,
        }
    }

    fn put(&self, seed: &str) -> String {
        self.vault
            .blobs()
            .expect("a store")
            .put(seed.as_bytes())
            .expect("stored")
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn count(&self, sql: &str) -> i64 {
        self.vault
            .read(|c| Ok(c.query_row(sql, [], |r| r.get(0))?))
            .expect("a count")
    }
}

fn age(world: &World, hash: &str, before: SystemTime) {
    let path = world
        .vault
        .blobs()
        .expect("a store")
        .path_of(hash)
        .expect("asks")
        .expect("a file");
    std::fs::File::options()
        .write(true)
        .open(path)
        .expect("opens")
        .set_modified(before - Duration::from_secs(3600))
        .expect("sets the time");
}

#[test]
fn a_sweep_lists_the_directory_once_however_many_batches_it_takes() {
    let w = World::new();
    let launch = SystemTime::now();
    let strays: Vec<String> = (0..11).map(|n| w.put(&format!("stray {n}"))).collect();
    for stray in &strays {
        age(&w, stray, launch);
    }
    let before = w.listings.load(Ordering::SeqCst);
    let (mut removed, mut batches, mut after) = (0, 0, String::new());
    loop {
        let batch = w
            .vault
            .sweep_unclaimed_files(launch, &after, 3)
            .expect("sweeps");
        removed += batch.removed.len();
        batches += 1;
        match batch.next {
            Some(next) => after = next,
            None => break,
        }
    }
    assert_eq!(removed, 11, "every stray went");
    assert!(batches >= 4, "eleven files in batches of three: {batches}");
    assert_eq!(
        w.listings.load(Ordering::SeqCst) - before,
        1,
        "one listing of the directory for the whole sweep"
    );
    // A second sweep is a second listing, not a stale one.
    let _ = w
        .vault
        .sweep_unclaimed_files(launch, "", 3)
        .expect("sweeps");
    assert_eq!(w.listings.load(Ordering::SeqCst) - before, 2);
}

#[test]
fn a_thumbnail_write_releases_the_file_it_replaced_and_walks_no_library() {
    let w = World::new();
    let original = w.put("the picture");
    w.ok(
        "document.add",
        json!({ "title": "Pic", "blob": original, "size": 11, "media_type": "image/jpeg" }),
    );
    // A library with unclaimed claims in it: a walk of the whole library would collect these.
    w.vault
        .commit(|tx| {
            for n in 0..40 {
                tx.connection().execute(
                    "INSERT INTO blob (hash, size) VALUES (?1, 1)",
                    [format!("{n:02x}").repeat(32)],
                )?;
            }
            Ok(())
        })
        .expect("claims");
    let first = w.put("thumb one");
    let second = w.put("thumb two");
    let write = |out: &str| {
        w.ok(
            "derivative.write",
            json!({ "blob": original, "variant": "thumb", "out": out, "out_size": 9,
                     "media_type": "image/webp" }),
        )
    };
    write(&first);
    let released = write(&second);
    let released: Vec<&str> = released["released"]
        .as_array()
        .expect("a list")
        .iter()
        .map(|hash| hash.as_str().expect("a hash"))
        .collect();
    assert_eq!(
        released,
        [first.as_str()],
        "only the replaced file is released"
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM blob WHERE hash NOT IN (SELECT blob FROM document) AND hash <> (SELECT out FROM derivative)"),
        40,
        "the library's other claims were not walked"
    );
    // A dropped variant releases its file the same way.
    let dropped = w.ok(
        "derivative.drop",
        json!({ "blob": original, "variant": "thumb" }),
    );
    assert_eq!(dropped["released"], json!([second]));
    assert_eq!(w.count("SELECT COUNT(*) FROM blob"), 41);
}
