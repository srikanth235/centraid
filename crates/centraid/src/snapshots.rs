//! The gateway's current bootstrap blob, one per vault (#1025 S1).
//!
//! ## BOOTSTRAP IS A BLOB, NOT A WALK
//!
//! A seat that has never synced used to be handed an empty file and the log
//! from the floor. #996 R4 superseded that and #1020 built it back: the log has
//! a floor, so "from seq 0" is a page the gateway cannot serve on any vault
//! with history, and replaying a million rows is a download nobody wants.
//!
//! So the gateway keeps a **snapshot**: `VACUUM INTO` of the replicated tables
//! with every private one dropped, hashed with BLAKE3 and put into this vault's
//! byte store. The seat is answered `{hash, seq, bytes}` on the message that
//! told it to take a copy — `PairOk` or `RebootstrapRequired` (#1025 S7,
//! item 5) — and fetches the bytes over the byte lane like any other blob:
//! resumable by verified chunk group, immutable, and identity-checked against
//! its own `core_vault` row before the destination is touched.
//!
//! ## IT IS BUILT REPLICA-SHAPED (#1025 S7, item 3)
//!
//! [`centraid_vault::build_replica_snapshot`] and not `build_snapshot`: the
//! artifact is **uncompressed** and already carries the seat's own empty tables
//! (`centraid_seat::seat_own_ddl`, which is why this crate links
//! `crates/seat`). That is what lets a phone ADOPT it — hard-link the verified
//! bytes to the replica's name and write one small transaction — instead of
//! expanding a gzip into a second full-size file and copying tables into it.
//!
//! It is therefore NOT the same artifact as the backup and the pre-migration
//! copy any more. Those two are still gzipped archives that somebody stores;
//! this one is a file a device renames. The pipeline is one function with a
//! `Shape`, so the sanitisation — private tables dropped, credential canaries
//! overwritten, the log truncated with the floor kept — is the same code and
//! cannot drift between them.
//!
//! ## WHEN IT IS REBUILT, AND WHY THAT IS THE FLOOR AND NOT A CLOCK
//!
//! When a seat asks and the current one is **older than the log floor**, or
//! there is none. That is the only condition that matters: a snapshot at a seq
//! at or above the floor can still be tailed from, because every row the seat
//! needs after it is still in the log. A snapshot below the floor cannot —
//! the deltas between it and the floor are collected — so it is a file that
//! would bootstrap a seat straight into a re-bootstrap.
//!
//! A time-based refresh would rebuild a 300 MB artifact on a schedule nobody
//! asked for; a per-request rebuild would do it once per phone.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use centraid_blobs::{ByteStore, ContentHash};
use centraid_core::Handle;

/// The seat's own DDL, leaked once.
///
/// `build_replica_snapshot` takes a `&'static str` because the statements
/// outlive every build; `seat_own_ddl()` composes a `String` from the three
/// constants that define the tables. One leak, of a value this process would
/// have held for its whole life anyway, and it keeps the schema defined in one
/// place — in `crates/seat`, beside the code that reads those tables.
fn seat_ddl() -> &'static str {
    static DDL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    DDL.get_or_init(|| centraid_seat::seat_own_ddl().leak())
}

/// A snapshot this gateway currently holds, and its content address.
#[derive(Debug, Clone)]
pub struct Offer {
    pub head: centraid_vault::SnapshotHead,
    pub hash: ContentHash,
    pub size: u64,
}

/// The gateway's snapshot, kept current for whoever asks.
///
/// Cheap to clone; every clone answers from the same cache. One per vault,
/// because the artifact is a copy of one vault's file.
#[derive(Clone)]
pub struct Snapshots {
    dir: PathBuf,
    blobs: ByteStore,
    current: Arc<Mutex<Option<Offer>>>,
}

impl Snapshots {
    #[must_use]
    pub fn new(dir: PathBuf, blobs: ByteStore) -> Self {
        Self {
            dir,
            blobs,
            current: Arc::new(Mutex::new(None)),
        }
    }

    /// The offer a seat is answered with, rebuilding it when it is owed.
    ///
    /// **Blocking.** The build is a `VACUUM INTO` over the whole vault; the
    /// caller runs it on a blocking worker, because a blocking read on an async
    /// worker starves every other lane this gateway serves.
    pub async fn current(&self, handle: &Arc<Handle>) -> Result<Offer, String> {
        let floor = self.floor(handle).await?;
        if let Some(held) = self.held()
            && held.head.seq >= floor
        {
            return Ok(held);
        }
        let built = self.build(handle).await?;
        // THE BYTES GO IN AFTER THE FILE IS COMPLETE, and `add_path` re-hashes
        // them: the name the seat is told is what the store actually holds, not
        // what the builder asserted.
        let hash = self
            .blobs
            .add_path(self.dir.join(&built.name))
            .await
            .map_err(|error| format!("the snapshot would not enter the byte store: {error}"))?;
        let offer = Offer {
            size: built.size,
            head: built,
            hash,
        };
        self.sweep(&offer.head.name);
        if let Ok(mut held) = self.current.lock() {
            *held = Some(offer.clone());
        }
        Ok(offer)
    }

    fn held(&self) -> Option<Offer> {
        self.current.lock().ok().and_then(|held| held.clone())
    }

    /// The log's retention floor, read through the vault the core holds.
    async fn floor(&self, handle: &Arc<Handle>) -> Result<i64, String> {
        let handle = Arc::clone(handle);
        tokio::task::spawn_blocking(move || {
            handle.with_vault(|vault| {
                vault
                    .read(centraid_vault::converge::position)
                    .map(|(_, floor, _)| floor)
                    .map_err(centraid_core::CoreError::from)
            })
        })
        .await
        .map_err(|joined| format!("reading the floor did not finish: {joined}"))?
        .map_err(|error| format!("the log's floor could not be read: {error}"))
    }

    async fn build(&self, handle: &Arc<Handle>) -> Result<centraid_vault::SnapshotHead, String> {
        let handle = Arc::clone(handle);
        let dir = self.dir.clone();
        tokio::task::spawn_blocking(move || {
            handle.with_vault(|vault| {
                centraid_vault::build_replica_snapshot(vault, &dir, seat_ddl())
                    .map_err(centraid_core::CoreError::from)
            })
        })
        .await
        .map_err(|joined| format!("the snapshot build did not finish: {joined}"))?
        .map_err(|error| format!("the snapshot would not build: {error}"))
    }

    /// Remove every artifact in the directory except the one just published.
    ///
    /// The bytes a seat fetches come from the byte STORE, which took its own
    /// copy; the directory is scratch. A gateway that kept every generation
    /// would grow by the size of the vault on every floor advance.
    fn sweep(&self, keep: &str) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_str().is_some_and(|name| name == keep) {
                continue;
            }
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
