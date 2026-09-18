//! The spool: sealed segments that outlive a checkpoint (#1029 §2, F11).
//!
//! ## THE DURABILITY ORDER IS THE PRODUCT (F11)
//!
//! The WAL is already the fsynced log, so the spool does not have to be a second
//! one. What it has to be is **the thing that still holds a commit's pages after
//! the checkpoint that removed them from the WAL**. That gives one ordering, and
//! every rule in this module is a clause of it:
//!
//! 1. **The WAL is durable first.** `synchronous = FULL` is set explicitly by
//!    W1, not inherited: without it a checkpoint could remove frames the
//!    platter never saw, and the next txid would collide with a commit the phone
//!    lost.
//! 2. **A segment is sealed, written, fsynced — file *and* directory — and then
//!    read back from disk and opened** (§4, "verify before upload"). The
//!    read-back is not paranoia about the format: storage corruption only shows
//!    in what fsync put down, never in the buffer that was sealed.
//! 3. **The cursor is recorded only after that**, and before any checkpoint, so
//!    a crash between the two re-captures frames rather than losing them.
//! 4. **The checkpoint runs only when every committed frame is in the spool.**
//!    [`Spool::covers`] is the question a checkpoint asks.
//! 5. **A spool entry is dropped only after the store acks it** — never on a
//!    timer, never because a checkpoint happened. [`Spool::release_through`] is
//!    the only remover.
//!
//! Re-capturing is always safe and losing is never safe, so every crash window
//! in that list falls on the re-capture side.
//!
//! ## What is not here
//!
//! The upload. §6 puts the gateway in W4 and there is no network in this crate:
//! "the store acks it" means a [`super::store::BlobStore`] returned an id, and
//! v0's only store is the local filesystem.

use std::path::{Path, PathBuf};

use crate::backup::segment::GenerationId;
use crate::backup::wal::WalCursor;

#[derive(Debug, thiserror::Error)]
pub enum SpoolError {
    #[error("spool io at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("the spool cursor at {path} is not one this build reads: {reason}")]
    Cursor { path: PathBuf, reason: String },
}

type Result<T> = std::result::Result<T, SpoolError>;

fn io_at(path: &Path) -> impl FnOnce(std::io::Error) -> SpoolError + '_ {
    move |source| SpoolError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// `fsync` a directory, so a rename into it is on the platter.
///
/// **A rename is not durable until its directory is synced.** Renaming a
/// segment into place and syncing only the file leaves a crash window in which
/// the bytes exist and the name does not — which is exactly a lost commit.
fn sync_dir(dir: &Path) -> Result<()> {
    std::fs::File::open(dir)
        .and_then(|handle| handle.sync_all())
        .map_err(io_at(dir))
}

/// Write bytes durably, atomically, under a name that cannot collide (B13).
pub(crate) fn write_durably(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;

    let dir = path.parent().unwrap_or(Path::new("."));
    let temp = dir.join(unique_temp_name(path));
    {
        let mut handle = std::fs::File::create(&temp).map_err(io_at(&temp))?;
        handle.write_all(bytes).map_err(io_at(&temp))?;
        handle.sync_all().map_err(io_at(&temp))?;
    }
    match std::fs::rename(&temp, path) {
        Ok(()) => {}
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            return Err(io_at(path)(error));
        }
    }
    sync_dir(dir)
}

/// A temp name two writers cannot both choose (B13).
///
/// The name this replaces was `{id}.{pid}.tmp`, which two threads of one
/// process share: both create it, both write, one renames a file the other is
/// still writing into. The process id stays because it makes an abandoned temp
/// attributable; what makes it unique is the 16 random bytes.
pub(crate) fn unique_temp_name(path: &Path) -> String {
    use rand::TryRngCore as _;

    let stem = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("object");
    let mut suffix = [0_u8; 16];
    // A failure here is not a reason to fall back to a colliding name: the
    // clock and the thread id are both guessable, and the whole point is that
    // two writers cannot meet. `OsRng` failing means the process cannot make a
    // nonce either, so let the write fail loudly at `create` instead.
    if rand::rngs::OsRng.try_fill_bytes(&mut suffix).is_err() {
        return format!("{stem}.{}.__entropy_failed__.tmp", std::process::id());
    }
    format!("{stem}.{}.{}.tmp", std::process::id(), hex::encode(suffix))
}

/// What capture knows, written down before any checkpoint can make it stale.
///
/// §2: "Record `(salt1, salt2, last frame, last_txid)` durably with the spool
/// entry, before any checkpoint makes it stale."
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpoolCursor {
    pub generation: GenerationId,
    pub wal: WalCursor,
    /// The last txid capture has cut a segment for.
    pub last_txid: u64,
    /// **The txid the object store has acknowledged**, and therefore the point
    /// below which the spool no longer has to hold anything.
    ///
    /// This is what a checkpoint measures coverage from, and it is deliberately
    /// not "the base's txid": a generation's base and a store ack are different
    /// events, and asking coverage from the base would refuse every checkpoint
    /// after the first generation released its spool.
    pub acked_txid: u64,
}

impl SpoolCursor {
    /// A cursor for a generation with nothing spooled yet, at `acked_txid`.
    #[must_use]
    pub const fn at(generation: GenerationId, acked_txid: u64) -> Self {
        Self {
            generation,
            wal: WalCursor::fresh(),
            last_txid: acked_txid,
            acked_txid,
        }
    }

    fn encode(&self) -> String {
        let (salt1, salt2) = self.wal.salts.unwrap_or((0, 0));
        serde_json::json!({
            "format": "centraid-spool-cursor/1",
            "generation": self.generation.hex(),
            "salt1": salt1,
            "salt2": salt2,
            "haveSalts": self.wal.salts.is_some(),
            "nextFrame": self.wal.next_frame,
            "lastTxid": self.last_txid,
            "ackedTxid": self.acked_txid,
        })
        .to_string()
    }

    fn decode(path: &Path, text: &str) -> Result<Self> {
        let bad = |reason: &str| SpoolError::Cursor {
            path: path.to_path_buf(),
            reason: reason.to_owned(),
        };
        let value: serde_json::Value =
            serde_json::from_str(text).map_err(|error| bad(&error.to_string()))?;
        if value.get("format").and_then(serde_json::Value::as_str)
            != Some("centraid-spool-cursor/1")
        {
            return Err(bad("the format line is not this build's"));
        }
        let generation = value
            .get("generation")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| bad("no generation"))
            .and_then(|text| {
                GenerationId::from_hex(text).map_err(|error| bad(&error.to_string()))
            })?;
        let number = |key: &str| -> Result<u64> {
            value
                .get(key)
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| bad(&format!("no {key}")))
        };
        let have_salts = value
            .get("haveSalts")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let salts = if have_salts {
            Some((
                u32::try_from(number("salt1")?).map_err(|_| bad("salt1 is not 32 bits"))?,
                u32::try_from(number("salt2")?).map_err(|_| bad("salt2 is not 32 bits"))?,
            ))
        } else {
            None
        };
        Ok(Self {
            generation,
            wal: WalCursor {
                salts,
                next_frame: number("nextFrame")?,
            },
            last_txid: number("lastTxid")?,
            acked_txid: number("ackedTxid")?,
        })
    }
}

/// One sealed segment the spool holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpoolEntry {
    pub first_txid: u64,
    pub last_txid: u64,
    /// The object's name: the BLAKE3 of its own ciphertext.
    pub object: String,
    pub path: PathBuf,
    pub bytes: u64,
}

/// The directory sealed segments wait in.
#[derive(Debug, Clone)]
pub struct Spool {
    root: PathBuf,
}

/// `<first>-<last>-<object>.seg`, so the spool is orderable without opening a
/// single segment.
fn entry_name(first_txid: u64, last_txid: u64, object: &str) -> String {
    format!("{first_txid:020}-{last_txid:020}-{object}.seg")
}

fn parse_entry(path: &Path) -> Option<SpoolEntry> {
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_suffix(".seg")?;
    let mut parts = stem.splitn(3, '-');
    let first_txid = parts.next()?.parse().ok()?;
    let last_txid = parts.next()?.parse().ok()?;
    let object = parts.next()?;
    if object.len() != 64 || !object.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(SpoolEntry {
        first_txid,
        last_txid,
        object: object.to_owned(),
        bytes: std::fs::metadata(path).ok()?.len(),
        path: path.to_path_buf(),
    })
}

impl Spool {
    /// Open (creating) the spool under a data directory.
    ///
    /// # Errors
    /// [`SpoolError::Io`] when the directory cannot be made.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        std::fs::create_dir_all(&root).map_err(io_at(&root))?;
        Ok(Self { root })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn cursor_path(&self) -> PathBuf {
        self.root.join("cursor")
    }

    /// The cursor, or `None` for a spool that has never captured.
    ///
    /// # Errors
    /// [`SpoolError::Io`] or [`SpoolError::Cursor`].
    pub fn cursor(&self) -> Result<Option<SpoolCursor>> {
        let path = self.cursor_path();
        match std::fs::read_to_string(&path) {
            Ok(text) => SpoolCursor::decode(&path, &text).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(SpoolError::Io { path, source }),
        }
    }

    /// Record the cursor durably. **Call this before any checkpoint** (§2).
    ///
    /// # Errors
    /// [`SpoolError::Io`].
    pub fn record_cursor(&self, cursor: &SpoolCursor) -> Result<()> {
        write_durably(&self.cursor_path(), cursor.encode().as_bytes())
    }

    /// Add a sealed segment, durably, and hand back the entry.
    ///
    /// The bytes are fsynced and the directory with them; the caller then reads
    /// the file back and verifies it before anything is allowed to depend on it
    /// ([`Spool::read`], §4).
    ///
    /// # Errors
    /// [`SpoolError::Io`].
    pub fn add(
        &self,
        first_txid: u64,
        last_txid: u64,
        object: &str,
        sealed: &[u8],
    ) -> Result<SpoolEntry> {
        let path = self.root.join(entry_name(first_txid, last_txid, object));
        write_durably(&path, sealed)?;
        Ok(SpoolEntry {
            first_txid,
            last_txid,
            object: object.to_owned(),
            path,
            bytes: sealed.len() as u64,
        })
    }

    /// Read a spooled segment back **from disk**.
    ///
    /// # Errors
    /// [`SpoolError::Io`].
    pub fn read(&self, entry: &SpoolEntry) -> Result<Vec<u8>> {
        std::fs::read(&entry.path).map_err(io_at(&entry.path))
    }

    /// Every segment the spool holds, in txid order.
    ///
    /// # Errors
    /// [`SpoolError::Io`].
    pub fn entries(&self) -> Result<Vec<SpoolEntry>> {
        let mut entries: Vec<SpoolEntry> = match std::fs::read_dir(&self.root) {
            Ok(listing) => listing
                .filter_map(std::result::Result::ok)
                .filter_map(|entry| parse_entry(&entry.path()))
                .collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(source) => {
                return Err(SpoolError::Io {
                    path: self.root.clone(),
                    source,
                });
            }
        };
        entries.sort_by_key(|entry| (entry.first_txid, entry.last_txid));
        Ok(entries)
    }

    /// The bytes the spool is holding, which is what its bound is measured in.
    ///
    /// # Errors
    /// [`SpoolError::Io`].
    pub fn bytes(&self) -> Result<u64> {
        Ok(self.entries()?.iter().map(|entry| entry.bytes).sum())
    }

    /// **Does the spool hold every commit up to `txid`?** This is the question a
    /// checkpoint asks, and a `false` is a refusal to checkpoint (§2, F11).
    ///
    /// A run with a hole in it does not cover anything past the hole, however
    /// many segments sit above it.
    ///
    /// # Errors
    /// [`SpoolError::Io`].
    pub fn covers(&self, from_txid: u64, txid: u64) -> Result<bool> {
        if txid < from_txid {
            return Ok(true);
        }
        let mut next = from_txid;
        for entry in self.entries()? {
            if entry.first_txid > next {
                break;
            }
            if entry.last_txid >= next {
                next = entry.last_txid + 1;
            }
        }
        Ok(next > txid)
    }

    /// **Drop segments the store has acknowledged — and nothing else** (§2).
    ///
    /// The only remover in this module, and it takes a txid the caller got back
    /// from a store, not a clock and not a checkpoint. A segment dropped because
    /// "the checkpoint succeeded" is the commit the phone lost.
    ///
    /// # Errors
    /// [`SpoolError::Io`].
    pub fn release_through(&self, acked_txid: u64) -> Result<usize> {
        let mut removed = 0;
        for entry in self.entries()? {
            if entry.last_txid <= acked_txid {
                std::fs::remove_file(&entry.path).map_err(io_at(&entry.path))?;
                removed += 1;
            }
        }
        if removed > 0 {
            sync_dir(&self.root)?;
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generation() -> GenerationId {
        GenerationId::from_bytes([1_u8; 16])
    }

    fn object(byte: u8) -> String {
        hex::encode([byte; 32])
    }

    #[test]
    fn the_cursor_round_trips_and_a_foreign_one_is_refused() {
        let dir = tempfile::tempdir().expect("a directory");
        let spool = Spool::open(dir.path()).expect("opens");
        assert_eq!(spool.cursor().expect("reads"), None);

        let cursor = SpoolCursor {
            generation: generation(),
            wal: WalCursor {
                salts: Some((0xdead_beef, 0x0bad_f00d)),
                next_frame: 41,
            },
            last_txid: 9,
            acked_txid: 4,
        };
        spool.record_cursor(&cursor).expect("records");
        assert_eq!(spool.cursor().expect("reads"), Some(cursor));

        std::fs::write(dir.path().join("cursor"), r#"{"format":"other/1"}"#).expect("writes");
        assert!(matches!(spool.cursor(), Err(SpoolError::Cursor { .. })));
    }

    /// **F11's rule 5.** A checkpoint does not remove a spool entry; only an ack
    /// does.
    #[test]
    fn a_segment_is_dropped_only_after_the_store_acks_it() {
        let dir = tempfile::tempdir().expect("a directory");
        let spool = Spool::open(dir.path()).expect("opens");
        spool.add(1, 2, &object(0xa1), b"sealed one").expect("adds");
        spool.add(3, 3, &object(0xa2), b"sealed two").expect("adds");
        spool
            .add(4, 6, &object(0xa3), b"sealed three")
            .expect("adds");
        assert_eq!(spool.entries().expect("lists").len(), 3);

        // The store acked through txid 3, and only those two go.
        assert_eq!(spool.release_through(3).expect("releases"), 2);
        let left = spool.entries().expect("lists");
        assert_eq!(left.len(), 1);
        assert_eq!((left[0].first_txid, left[0].last_txid), (4, 6));

        // A partial ack never takes a segment that reaches past it.
        assert_eq!(spool.release_through(5).expect("releases"), 0);
        assert_eq!(spool.entries().expect("lists").len(), 1);
    }

    /// The question a checkpoint asks, and the hole it must see.
    #[test]
    fn covers_is_false_across_a_hole_however_many_segments_sit_above_it() {
        let dir = tempfile::tempdir().expect("a directory");
        let spool = Spool::open(dir.path()).expect("opens");
        spool.add(1, 3, &object(0xb1), b"one").expect("adds");
        spool.add(7, 9, &object(0xb2), b"three").expect("adds");
        assert!(spool.covers(1, 3).expect("asks"));
        assert!(!spool.covers(1, 4).expect("asks"), "txids 4..6 are missing");
        assert!(!spool.covers(1, 9).expect("asks"));
        spool.add(4, 6, &object(0xb3), b"two").expect("adds");
        assert!(spool.covers(1, 9).expect("asks"));
        assert!(spool.covers(1, 0).expect("nothing to cover"));
    }

    /// **B13.** Two writers cannot choose one temp name.
    #[test]
    fn a_temp_name_cannot_collide_between_two_writers() {
        let path = Path::new("/spool/a.seg");
        let names: std::collections::BTreeSet<String> =
            (0..256).map(|_| unique_temp_name(path)).collect();
        assert_eq!(names.len(), 256, "256 draws, 256 names");
        assert!(names.iter().all(|name| name.ends_with(".tmp")));
        assert!(names.iter().all(|name| name.starts_with("a.seg.")));
    }

    #[test]
    fn a_durable_write_leaves_no_temp_behind_and_the_bytes_are_there() {
        let dir = tempfile::tempdir().expect("a directory");
        let path = dir.path().join("thing");
        write_durably(&path, b"durable").expect("writes");
        assert_eq!(std::fs::read(&path).expect("reads"), b"durable");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("lists")
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp file survives a write");
    }

    #[test]
    fn a_file_that_is_not_a_segment_is_not_one() {
        let dir = tempfile::tempdir().expect("a directory");
        let spool = Spool::open(dir.path()).expect("opens");
        std::fs::write(dir.path().join("README"), b"not a segment").expect("writes");
        std::fs::write(dir.path().join("1-2-short.seg"), b"nor this").expect("writes");
        spool.add(1, 1, &object(7), b"real").expect("adds");
        assert_eq!(spool.entries().expect("lists").len(), 1);
        assert_eq!(spool.bytes().expect("sizes"), 4);
    }
}
