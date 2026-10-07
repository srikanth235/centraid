//! The content store: a directory of files, each named by the BLAKE3 of its
//! bytes ([#1080](https://github.com/srikanth235/centraid/issues/1080)).
//!
//! `<vault stem>.bytes/<64 lowercase hex>`, one file per blob, and nothing
//! else a reader has to know. A platform opens a path in place — a grid cell,
//! a document viewer, the sealer that backs a file up — so a blob is a FILE,
//! never a row in an index and never inlined (D-1025-S3-2), and its name is
//! computable from its hash without asking anything.
//!
//! ## A WRITE IS WHOLE OR IT DID NOT HAPPEN
//!
//! Bytes go to `incoming/` first, are hashed as they are written, are synced,
//! and are renamed to their name only when the last byte is in; the directory
//! is synced after the rename. A reader therefore sees a whole blob or no
//! blob, never a prefix, and "the file exists" is the whole of "this device
//! holds these bytes". There is no partial state to track and no index to keep
//! in step with the files: the directory IS the index.
//!
//! A write a crash cut short is a stray file in `incoming/`, never a blob, and
//! [`ByteStore::open`] clears any that has not been written to for an hour —
//! long enough that no live writer in this or another process is touched.
//!
//! ## A READ OF BYTES VERIFIES THEM
//!
//! [`ByteStore::read`] hashes what it read and refuses bytes that are not
//! their own name: a store whose file rotted answers [`StoreError::Corrupt`]
//! rather than a photograph that is someone else's. A PATH handed to a
//! platform is not re-hashed per open — a grid would hash a screenful of
//! photographs to draw them — and the backup sealer hashes every file it reads
//! anyway, so a rotten file is named where it would do harm.
//!
//! ## THE STORE BEFORE #1080, ADOPTED ONCE
//!
//! Until #1080 this directory held a transfer store's layout: a `blobs.db`
//! index beside `data/<hex>.data`, with `.obao4` outboards and, for a blob
//! held in part, `.bitfield` and `.sizes4` files. The index cannot be read
//! without the crate that wrote it, which has left the tree, and the files
//! hold bytes a member may have nowhere else
//! — an edit, a document, a download — so [`ByteStore::open`] adopts them
//! rather than leaving them stranded: every `data/<hex>.data` with no
//! `.bitfield` beside it is hashed, and moved to its name when it hashes to
//! it. What is left of the old layout — partial blobs, outboards, files that
//! did not verify, the index — is then removed. The pass reads every adopted
//! byte once, at the first open after the upgrade, and never again: a store
//! with no `data/` directory has nothing to adopt.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use crate::hash::ContentHash;

/// Where writes land before they have a name.
const INCOMING: &str = "incoming";

/// How long a file in `incoming/` may go unwritten before [`ByteStore::open`]
/// treats it as a crashed write. A live writer appends at least every chunk.
const STALE_INCOMING: Duration = Duration::from_secs(60 * 60);

/// One read or write unit: large enough that a video is not a million
/// syscalls, small enough that it is not a second copy of a photograph.
const CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("the content store at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{hash} in the content store hashes to {actual}: the file is corrupt")]
    Corrupt {
        hash: ContentHash,
        actual: ContentHash,
    },
}

pub type Result<T> = std::result::Result<T, StoreError>;

fn io_at(path: &Path) -> impl FnOnce(io::Error) -> StoreError + '_ {
    move |source| StoreError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// A blob the store just took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub hash: ContentHash,
    pub bytes: u64,
    /// The file its bytes are in, from now on.
    pub path: PathBuf,
    /// Whether the store held these bytes before this write: the write then
    /// added nothing, and the second copy it made was discarded.
    pub already_held: bool,
}

/// What the first open after the upgrade did with the store's old layout.
/// See the module header.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Adopted {
    /// Blobs moved to their name.
    pub blobs: usize,
    /// Old files that were not whole blobs or did not hash to their name, and
    /// were removed with the old layout.
    pub discarded: usize,
}

/// This device's content-addressed bytes.
///
/// Cheap to clone; every clone is the same directory, and two stores opened
/// over one directory are one store — there is no lock, because there is no
/// index to guard.
#[derive(Debug, Clone)]
pub struct ByteStore {
    root: PathBuf,
}

impl ByteStore {
    /// Open, creating the directory if it is not there, adopting the layout
    /// before #1080 if it is, and clearing writes a crash cut short.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the directory cannot be made or read.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        Ok(Self::open_adopting(root)?.0)
    }

    /// [`Self::open`], answering what the adoption of the old layout did.
    ///
    /// # Errors
    /// As [`Self::open`].
    pub fn open_adopting(root: impl AsRef<Path>) -> Result<(Self, Adopted)> {
        let root = root.as_ref().to_path_buf();
        let incoming = root.join(INCOMING);
        fs::create_dir_all(&incoming).map_err(io_at(&incoming))?;
        let store = Self { root };
        let adopted = store.adopt_legacy_layout()?;
        store.clear_stale_incoming()?;
        Ok((store, adopted))
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Where a blob's bytes are, or would be. Says nothing about whether they
    /// are.
    #[must_use]
    pub fn path_for(&self, hash: ContentHash) -> PathBuf {
        self.root.join(hash.to_hex())
    }

    /// The file a blob's bytes are in, or `None` when this store does not hold
    /// it. A file at its name is whole, by construction.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the file system will not say.
    pub fn path_of(&self, hash: ContentHash) -> Result<Option<PathBuf>> {
        let path = self.path_for(hash);
        match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => Ok(Some(path)),
            Ok(_) => Ok(None),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io_at(&path)(error)),
        }
    }

    /// Whether this store holds the blob. There is no partial blob to be
    /// confused with: a write is whole or it is not here.
    ///
    /// # Errors
    /// As [`Self::path_of`].
    pub fn is_complete(&self, hash: ContentHash) -> Result<bool> {
        Ok(self.path_of(hash)?.is_some())
    }

    /// The blob's length, or `None` when this store does not hold it.
    ///
    /// # Errors
    /// As [`Self::path_of`].
    pub fn size(&self, hash: ContentHash) -> Result<Option<u64>> {
        let path = self.path_for(hash);
        match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => Ok(Some(metadata.len())),
            Ok(_) => Ok(None),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io_at(&path)(error)),
        }
    }

    /// Begin a write whose name is not known until its last byte: the stage
    /// door's shape, where bytes arrive over many calls.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the incoming file cannot be made.
    pub fn writer(&self) -> Result<Writer> {
        let path = self.root.join(INCOMING).join(incoming_name());
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(io_at(&path))?;
        Ok(Writer {
            store: self.clone(),
            path,
            file: Some(file),
            hasher: blake3::Hasher::new(),
            bytes: 0,
        })
    }

    /// Take bytes already in memory: a thumbnail, a note's attachment, a body
    /// a command spills.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the write fails; nothing is left behind.
    pub fn put_bytes(&self, bytes: &[u8]) -> Result<Stored> {
        let mut writer = self.writer()?;
        writer.write(bytes)?;
        writer.finish()
    }

    /// Take a stream, hashing it as it is written: never more than one chunk
    /// in memory, whatever its length.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the read or the write fails; nothing is left
    /// behind.
    pub fn put_stream(&self, reader: &mut dyn Read) -> Result<Stored> {
        let mut writer = self.writer()?;
        let mut chunk = vec![0_u8; CHUNK_BYTES];
        loop {
            let read = match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(io_at(&writer.path)(error)),
            };
            writer.write(&chunk[..read])?;
        }
        writer.finish()
    }

    /// Take a file, streamed: the file is read once and never held whole.
    ///
    /// # Errors
    /// As [`Self::put_stream`], and [`StoreError::Io`] naming `path` when it
    /// will not open.
    pub fn put_path(&self, path: impl AsRef<Path>) -> Result<Stored> {
        let path = path.as_ref();
        let mut file = fs::File::open(path).map_err(io_at(path))?;
        self.put_stream(&mut file)
    }

    /// Read a blob into memory, verified against its name. Small things only —
    /// a thumbnail, a manifest; a platform opens anything larger by its path.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the file is missing or unreadable, and
    /// [`StoreError::Corrupt`] when its bytes are not its name's.
    pub fn read(&self, hash: ContentHash) -> Result<Vec<u8>> {
        let path = self.path_for(hash);
        let bytes = fs::read(&path).map_err(io_at(&path))?;
        let actual = ContentHash::of(&bytes);
        if actual != hash {
            return Err(StoreError::Corrupt { hash, actual });
        }
        Ok(bytes)
    }

    /// Delete a blob. `false` when it was not here, which is not an error: the
    /// caller wanted it gone and it is.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the file system refuses.
    pub fn remove(&self, hash: ContentHash) -> Result<bool> {
        let path = self.path_for(hash);
        match fs::remove_file(&path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(io_at(&path)(error)),
        }
    }

    /// Every blob this store holds, in hash order.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the directory will not list.
    pub fn hashes(&self) -> Result<Vec<ContentHash>> {
        Ok(self
            .entries()?
            .into_iter()
            .map(|entry| entry.hash)
            .collect())
    }

    /// The bytes this store holds.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the directory will not list.
    pub fn bytes_held(&self) -> Result<u64> {
        Ok(self.entries()?.iter().map(|entry| entry.bytes).sum())
    }

    /// Free space down to `budget_bytes`, and NEVER take a pinned blob.
    ///
    /// ## The pin is structural, not a filter at the end (#1025 S3, R25)
    ///
    /// A pinned blob is one whose loss nothing could repair: an original no
    /// gateway has acknowledged, held nowhere else. So `pinned` is subtracted
    /// BEFORE anything is ordered, and a store whose pins alone exceed the
    /// budget reports [`Sweep::over_budget_by`] rather than breaking the
    /// promise. A sweep that filtered pins out at the end would evict them
    /// whenever the arithmetic came out that way, which is exactly when it
    /// matters.
    ///
    /// ## Oldest first, by the file's own mtime
    ///
    /// There is no access time to read — a phone's file system is usually
    /// mounted `noatime` — so the order is by when the bytes landed. A file
    /// that cannot be stated is not listed at all and so is never a candidate.
    ///
    /// It answers WHICH blobs it took, not only how many: a caller keeping a
    /// row per held blob drops exactly those rows.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the directory will not list or a file will not
    /// delete; what was deleted before the refusal stays deleted.
    pub fn sweep(
        &self,
        pinned: &HashSet<ContentHash>,
        budget_bytes: u64,
    ) -> Result<(Sweep, Vec<ContentHash>)> {
        let mut report = Sweep::default();
        let mut candidates = Vec::new();
        for entry in self.entries()? {
            report.held += entry.bytes;
            if pinned.contains(&entry.hash) {
                report.pinned += entry.bytes;
            } else {
                candidates.push(entry);
            }
        }
        report.over_budget_by = report.pinned.saturating_sub(budget_bytes);
        candidates.sort_by_key(|entry| (entry.modified, entry.hash));

        let mut standing = report.held;
        let mut taken = Vec::new();
        for entry in candidates {
            if standing <= budget_bytes {
                break;
            }
            self.remove(entry.hash)?;
            standing = standing.saturating_sub(entry.bytes);
            report.freed += entry.bytes;
            report.evicted += 1;
            taken.push(entry.hash);
        }
        Ok((report, taken))
    }

    /// Every blob file, with its length and mtime. Entries whose name is not a
    /// hash — `incoming/`, anything a platform put here — are not blobs.
    fn entries(&self) -> Result<Vec<Entry>> {
        let mut entries = Vec::new();
        for item in fs::read_dir(&self.root).map_err(io_at(&self.root))? {
            let item = item.map_err(io_at(&self.root))?;
            let Some(hash) = item
                .file_name()
                .to_str()
                .and_then(|name| ContentHash::parse_hex(name).ok())
            else {
                continue;
            };
            let Ok(metadata) = item.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            entries.push(Entry {
                hash,
                bytes: metadata.len(),
                modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            });
        }
        entries.sort_by_key(|entry| entry.hash);
        Ok(entries)
    }

    /// Move a finished write to its name.
    fn settle(&self, incoming: &Path, hash: ContentHash, bytes: u64) -> Result<Stored> {
        let path = self.path_for(hash);
        if self.path_of(hash)?.is_some() {
            // THE SAME BYTES TWICE ARE ONE BLOB. The file already at the name
            // is these bytes by construction, so the copy is dropped rather
            // than renamed over it.
            fs::remove_file(incoming).map_err(io_at(incoming))?;
            return Ok(Stored {
                hash,
                bytes,
                path,
                already_held: true,
            });
        }
        fs::rename(incoming, &path).map_err(io_at(&path))?;
        sync_directory(&self.root)?;
        Ok(Stored {
            hash,
            bytes,
            path,
            already_held: false,
        })
    }

    /// Clear writes a crash cut short. See the module header.
    fn clear_stale_incoming(&self) -> Result<()> {
        let incoming = self.root.join(INCOMING);
        let now = SystemTime::now();
        for item in fs::read_dir(&incoming).map_err(io_at(&incoming))? {
            let item = item.map_err(io_at(&incoming))?;
            let Ok(metadata) = item.metadata() else {
                continue;
            };
            let idle = metadata
                .modified()
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .unwrap_or_default();
            if metadata.is_file() && idle >= STALE_INCOMING {
                let path = item.path();
                fs::remove_file(&path).map_err(io_at(&path))?;
            }
        }
        Ok(())
    }

    /// Adopt the layout before #1080. See the module header.
    fn adopt_legacy_layout(&self) -> Result<Adopted> {
        let data = self.root.join("data");
        let mut adopted = Adopted::default();
        if data.is_dir() {
            for item in fs::read_dir(&data).map_err(io_at(&data))? {
                let item = item.map_err(io_at(&data))?;
                let name = item.file_name();
                let Some(hex) = name.to_str().and_then(|name| name.strip_suffix(".data")) else {
                    continue;
                };
                let Ok(hash) = ContentHash::parse_hex(hex) else {
                    continue;
                };
                // A `.bitfield` is how that store marked a blob it held in
                // part: not a blob, and never adopted as one.
                if data.join(format!("{hex}.bitfield")).exists() {
                    adopted.discarded += 1;
                    continue;
                }
                if self.path_of(hash)?.is_some() {
                    continue;
                }
                let path = item.path();
                let mut file = fs::File::open(&path).map_err(io_at(&path))?;
                let mut hasher = blake3::Hasher::new();
                io::copy(&mut file, &mut hasher).map_err(io_at(&path))?;
                if ContentHash::from_bytes(*hasher.finalize().as_bytes()) == hash {
                    fs::rename(&path, self.path_for(hash)).map_err(io_at(&path))?;
                    adopted.blobs += 1;
                } else {
                    adopted.discarded += 1;
                }
            }
            sync_directory(&self.root)?;
            fs::remove_dir_all(&data).map_err(io_at(&data))?;
        }
        let temp = self.root.join("temp");
        if temp.is_dir() {
            fs::remove_dir_all(&temp).map_err(io_at(&temp))?;
        }
        let index = self.root.join("blobs.db");
        match fs::remove_file(&index) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_at(&index)(error)),
        }
        Ok(adopted)
    }
}

/// A write in progress: bytes hashed as they arrive, named when they end.
///
/// Dropped unfinished, it deletes its incoming file: a write that did not end
/// is not a blob.
#[derive(Debug)]
pub struct Writer {
    store: ByteStore,
    path: PathBuf,
    file: Option<fs::File>,
    hasher: blake3::Hasher,
    bytes: u64,
}

impl Writer {
    /// Append bytes.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the incoming file will not take them.
    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        let Some(file) = self.file.as_mut() else {
            return Err(io_at(&self.path)(io::Error::other(
                "this write has already ended",
            )));
        };
        file.write_all(bytes).map_err(io_at(&self.path))?;
        self.hasher.update(bytes);
        self.bytes += bytes.len() as u64;
        Ok(())
    }

    /// The bytes written so far.
    #[must_use]
    pub const fn written(&self) -> u64 {
        self.bytes
    }

    /// End the write: sync the bytes, name them, and move them to their name.
    ///
    /// # Errors
    /// [`StoreError::Io`] when the sync or the move fails; the incoming file
    /// is removed either way.
    pub fn finish(mut self) -> Result<Stored> {
        let Some(file) = self.file.take() else {
            return Err(io_at(&self.path)(io::Error::other(
                "this write has already ended",
            )));
        };
        let synced = file.sync_all().map_err(io_at(&self.path));
        drop(file);
        let stored = synced.and_then(|()| {
            let hash = ContentHash::from_bytes(*self.hasher.finalize().as_bytes());
            self.store.settle(&self.path, hash, self.bytes)
        });
        // EVERY REFUSAL AFTER THE HANDLE IS TAKEN CLEANS UP HERE: `Drop` only
        // removes the incoming file of a write that still holds its handle.
        if stored.is_err() {
            let _ = fs::remove_file(&self.path);
        }
        stored
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        if self.file.take().is_some() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// One blob file, as a listing saw it.
struct Entry {
    hash: ContentHash,
    bytes: u64,
    modified: SystemTime,
}

/// A name for an incoming file no other write in this or another process can
/// share: the process, a counter, and the moment.
fn incoming_name() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    format!(
        "{}-{}-{nanos}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// Make a rename in `directory` durable. On the platforms the store runs on —
/// a phone, and the Unix machines its tests run on — a directory is synced
/// through a handle on it; elsewhere the rename is as durable as the
/// platform makes it.
fn sync_directory(directory: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(directory)
            .and_then(|handle| handle.sync_all())
            .map_err(io_at(directory))?;
    }
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

/// What one eviction sweep did.
///
/// Every number is bytes except [`Self::evicted`], which is blobs. `held` is
/// what the store held when the sweep opened, pins included; `pinned` is the
/// part of it nothing may take.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Sweep {
    pub held: u64,
    pub pinned: u64,
    pub evicted: usize,
    pub freed: u64,
    /// How far the PINS alone exceed the budget. Non-zero is an honest report
    /// and never a licence: the sweep has already stopped, and what a surface
    /// says is that a pinned original is holding the space.
    pub over_budget_by: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, ByteStore) {
        let dir = tempfile::tempdir().expect("a directory");
        let store = ByteStore::open(dir.path().join("vault.bytes")).expect("the store opens");
        (dir, store)
    }

    /// A WRITE IS WHOLE: the file appears at its name only when the last byte
    /// is in, and the same bytes twice are one blob.
    #[test]
    fn a_blob_is_a_file_named_by_its_hash_and_the_same_bytes_twice_are_one() {
        let (_dir, store) = store();
        let photograph = b"a camera original".repeat(1000);
        let mut writer = store.writer().expect("a write begins");
        writer.write(&photograph[..500]).expect("a chunk");
        let hash = ContentHash::of(&photograph);
        assert_eq!(
            store.path_of(hash).expect("asks"),
            None,
            "half a write is no blob"
        );
        writer.write(&photograph[500..]).expect("the rest");
        assert_eq!(writer.written(), photograph.len() as u64);
        let stored = writer.finish().expect("it ends");
        assert_eq!(stored.hash, hash);
        assert!(!stored.already_held);
        assert_eq!(stored.path, store.root().join(hash.to_hex()));
        assert_eq!(fs::read(&stored.path).expect("reads"), photograph);
        assert_eq!(
            store.path_of(hash).expect("asks"),
            Some(stored.path.clone())
        );
        assert_eq!(
            store.size(hash).expect("asks"),
            Some(photograph.len() as u64)
        );

        let again = store.put_bytes(&photograph).expect("it lands");
        assert!(again.already_held, "the same bytes twice are one blob");
        assert_eq!(store.hashes().expect("lists"), vec![hash]);
        assert_eq!(store.bytes_held().expect("sums"), photograph.len() as u64);
        assert_eq!(
            fs::read_dir(store.root().join(INCOMING))
                .expect("lists")
                .count(),
            0,
            "no write leaves an incoming file behind"
        );
    }

    /// A write that never ended leaves nothing, a stream is hashed as it is
    /// written, and a file is taken whole without being held whole.
    #[test]
    fn an_abandoned_write_leaves_nothing_and_a_stream_or_a_file_is_taken_whole() {
        let (dir, store) = store();
        {
            let mut writer = store.writer().expect("a write begins");
            writer
                .write(b"a video the app was killed during")
                .expect("a chunk");
        }
        assert!(store.hashes().expect("lists").is_empty());
        assert_eq!(
            fs::read_dir(store.root().join(INCOMING))
                .expect("lists")
                .count(),
            0
        );

        let long: Vec<u8> = (0..3 * CHUNK_BYTES + 17)
            .map(|at| (at % 251) as u8)
            .collect();
        let streamed = store.put_stream(&mut long.as_slice()).expect("it lands");
        assert_eq!(streamed.hash, ContentHash::of(&long));
        assert_eq!(streamed.bytes, long.len() as u64);

        let source = dir.path().join("download.pdf");
        fs::write(&source, b"%PDF a downloaded document").expect("writes");
        let taken = store.put_path(&source).expect("it lands");
        assert_eq!(
            store.read(taken.hash).expect("reads"),
            b"%PDF a downloaded document"
        );
        assert!(source.exists(), "the source is read, never moved");
    }

    /// A READ VERIFIES: a file whose bytes are not its name is corruption,
    /// named, and never handed back as the blob.
    #[test]
    fn a_rotten_file_is_refused_as_corrupt_and_removal_is_idempotent() {
        let (_dir, store) = store();
        let stored = store.put_bytes(b"a thumbnail").expect("it lands");
        fs::write(&stored.path, b"a thumbnail, rotted").expect("rots");
        assert!(matches!(
            store.read(stored.hash),
            Err(StoreError::Corrupt { hash, .. }) if hash == stored.hash
        ));
        assert!(store.remove(stored.hash).expect("removes"));
        assert!(!store.remove(stored.hash).expect("removes"), "already gone");
        assert!(!store.is_complete(stored.hash).expect("asks"));
        assert!(matches!(
            store.read(stored.hash),
            Err(StoreError::Io { .. })
        ));
    }

    /// A crashed write older than an hour is cleared at open; a fresh one is a
    /// live writer's and is left alone.
    #[test]
    fn a_stale_incoming_file_is_cleared_at_open_and_a_live_one_is_not() {
        let (_dir, store) = store();
        let incoming = store.root().join(INCOMING);
        let stale = incoming.join("crashed");
        let live = incoming.join("writing");
        fs::write(&stale, b"half a video").expect("writes");
        fs::write(&live, b"a video arriving").expect("writes");
        let an_hour_ago = SystemTime::now() - STALE_INCOMING - Duration::from_secs(1);
        fs::File::options()
            .write(true)
            .open(&stale)
            .and_then(|file| file.set_modified(an_hour_ago))
            .expect("ages");
        ByteStore::open(store.root()).expect("reopens");
        assert!(!stale.exists(), "a crashed write is cleared");
        assert!(live.exists(), "a live writer is never touched");
    }

    /// THE STORE BEFORE #1080, ADOPTED: a whole blob moves to its name, and a
    /// partial blob, a file that does not hash to its name, the outboards and
    /// the index go with the old layout.
    #[test]
    fn the_layout_before_1080_is_adopted_once_and_only_whole_verified_blobs_survive() {
        let dir = tempfile::tempdir().expect("a directory");
        let root = dir.path().join("vault.bytes");
        let data = root.join("data");
        fs::create_dir_all(&data).expect("makes");
        fs::create_dir_all(root.join("temp")).expect("makes");
        fs::write(root.join("blobs.db"), b"an index nothing can read").expect("writes");

        let document = b"an edited document, held nowhere else".to_vec();
        let whole = ContentHash::of(&document);
        fs::write(data.join(format!("{whole}.data")), &document).expect("writes");
        fs::write(data.join(format!("{whole}.obao4")), b"outboard").expect("writes");
        let partial = ContentHash::of(b"a video fetched in part");
        fs::write(data.join(format!("{partial}.data")), b"a video").expect("writes");
        fs::write(data.join(format!("{partial}.bitfield")), b"bits").expect("writes");
        let rotten = ContentHash::of(b"what this file should hold");
        fs::write(data.join(format!("{rotten}.data")), b"something else").expect("writes");

        let (store, adopted) = ByteStore::open_adopting(&root).expect("opens");
        assert_eq!(
            adopted,
            Adopted {
                blobs: 1,
                discarded: 2
            }
        );
        assert_eq!(store.hashes().expect("lists"), vec![whole]);
        assert_eq!(store.read(whole).expect("reads"), document);
        assert!(!data.exists(), "the old layout is gone");
        assert!(!root.join("temp").exists());
        assert!(!root.join("blobs.db").exists());

        let (_, again) = ByteStore::open_adopting(&root).expect("reopens");
        assert_eq!(again, Adopted::default(), "adoption happens once");
        assert_eq!(store.hashes().expect("lists"), vec![whole]);
    }
}
