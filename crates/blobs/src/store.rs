//! The local byte store: what this device holds, and how much of it (#1020,
//! D-1020-B3).
//!
//! This is `iroh-blobs`' filesystem store with a Centraid-shaped door on it.
//! The door is narrow on purpose — five verbs — because every extra one is a
//! place a caller could learn that the bytes are BLAKE3-addressed, and the
//! point of [`crate::hash::ContentHash`] is that they need not.
//!
//! ## ONE CONTENT STORE PER VAULT, AND THIS IS IT (#1025 S3, D-1025-S3-1)
//!
//! A device used to hold two: this one, and a plain one-file-per-hash CAS at
//! `<vault>.blobs` that `Vault::with_blobs` wrote and `content_location` read.
//! The read path knew the second and the transfer path knew the first, so a
//! photograph a seat FETCHED could never be displayed and a photograph a
//! window MINTED could never be served. Both are gone into this one, which the
//! grid reads and the window writes alike.
//!
//! The sibling `centraid_vault::backup::store::FsBlobStore` stays, and it is a
//! different question: it keeps one digest over whole BACKUP ARTEFACTS, which are
//! small, moved whole and sealed by `contracts/golden/format-golden.json`.
//! Applying ITS shape — `put(&[u8])`, `get(&str) -> Vec<u8>` — to a camera roll
//! would mean buffering an 800 MB video in a phone's address space to store it
//! and again to read it, and it has no way to express the state this plane
//! exists to make routine: **a blob this device holds PART of**.
//!
//! ## NOTHING IS INLINED, EVER (#1025 S3, D-1025-S3-2)
//!
//! iroh-blobs inlines a blob under 16 KiB into its own redb index instead of
//! writing a file. That is a sensible default for a transfer cache and a wrong
//! one for a content store a platform reads FROM: `content_location` answers a
//! PATH — `UIImage(contentsOfFile:)`, a Compose painter, an `<img>` — and a
//! thumbnail small enough to be inlined is a thumbnail with no path, which is
//! most of a photo grid. [`ByteStore::open`] therefore sets the inline
//! threshold to zero, so every complete blob is a file at a name
//! [`ByteStore::data_path`] can compute without asking the store anything.
//!
//! ## Holding is three states, not two
//!
//! [`Holding`] is `Missing`, `Partial` or `Complete`, and the middle one is the
//! normal state of a phone that has been awake for thirty seconds. Code that
//! treats holding as a boolean re-downloads from zero, which is precisely the
//! failure the byte plane was designed to remove — so the store never answers
//! `bool` for "do you have it" except in [`ByteStore::is_complete`], whose name
//! says which question it answered.
//!
//! ## A tag per blob, named by the hash
//!
//! `iroh-blobs` garbage-collects untagged blobs, so an untagged import is a
//! photograph that may not survive the night. Every import here takes a tag
//! whose name IS the hex hash: idempotent (the same bytes twice is the same
//! tag), greppable, and it makes eviction a deletion by a name the caller can
//! compute without asking the store anything.

use std::path::{Path, PathBuf};

use iroh_blobs::api::blobs::Blobs;
use iroh_blobs::api::proto::BlobStatus;
use iroh_blobs::store::fs::FsStore;

use crate::hash::ContentHash;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("the byte store at {path} could not be opened: {detail}")]
    Open { path: PathBuf, detail: String },
    #[error("the byte store could not take {path}: {detail}")]
    Import { path: PathBuf, detail: String },
    #[error("the byte store could not answer for {hash}: {detail}")]
    Query { hash: ContentHash, detail: String },
    #[error("the byte store could not write {hash} to {path}: {detail}")]
    Export {
        hash: ContentHash,
        path: PathBuf,
        detail: String,
    },
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// How much of a blob this device holds.
///
/// ## Two numbers, and the bug that comes from collapsing them
///
/// `held` is how many verified bytes are on this disk. `size` is how large the
/// whole blob turns out to be. They are NOT the same number and a partial blob
/// is exactly where they diverge — which is the one case this type exists for.
///
/// iroh-blobs' own `BlobStatus::Partial { size }` carries the second, and the
/// first version of this module read it as the first. The windows test caught
/// it immediately: a resumed window reported twenty-one megabytes already held
/// while the store said zero, because `size` had simply not been validated yet.
/// Had it read `Some(size)` instead of `None` the mistake would have been
/// invisible and every progress figure in the product would have been the file
/// size from the first chunk onward. So both are carried, both are named, and
/// [`Self::held_bytes`] answers the question a scheduler is actually asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holding {
    Missing,
    /// Some verified chunks, and not all of them.
    Partial {
        /// Verified bytes on this disk.
        held: u64,
        /// The whole blob's size. `None` until the size proof has arrived,
        /// which is the normal state after a window that was cut early.
        size: Option<u64>,
    },
    Complete {
        bytes: u64,
    },
}

impl Holding {
    #[must_use]
    pub const fn is_complete(self) -> bool {
        matches!(self, Self::Complete { .. })
    }

    /// Verified bytes this device holds. The number a progress row shows and a
    /// scheduler subtracts.
    #[must_use]
    pub const fn held_bytes(self) -> u64 {
        match self {
            Self::Missing => 0,
            Self::Partial { held, .. } => held,
            Self::Complete { bytes } => bytes,
        }
    }

    /// The whole blob's size, when it is known. `None` on a partial blob whose
    /// size proof has not arrived — a caller that needs a denominator must
    /// handle that rather than divide by the numerator.
    #[must_use]
    pub const fn total_bytes(self) -> Option<u64> {
        match self {
            Self::Missing => None,
            Self::Partial { size, .. } => size,
            Self::Complete { bytes } => Some(bytes),
        }
    }
}

/// This device's content-addressed bytes.
///
/// Cheap to clone; every clone is the same store. Held by the gateway (which
/// holds everything) and by a seat (which holds what it has fetched and has not
/// evicted).
#[derive(Debug, Clone)]
pub struct ByteStore {
    store: FsStore,
    root: PathBuf,
}

impl ByteStore {
    /// Open, creating the directory if it is not there.
    ///
    /// **The inline threshold is zero** (D-1025-S3-2). See the module header:
    /// a blob small enough to be inlined is a blob with no file, and this
    /// store's readers are platforms that open files.
    pub async fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        std::fs::create_dir_all(&root).map_err(|error| StoreError::Open {
            path: root.clone(),
            detail: error.to_string(),
        })?;
        let mut options = iroh_blobs::store::fs::options::Options::new(&root);
        options.inline = iroh_blobs::store::fs::options::InlineOptions::NO_INLINE;
        let store = FsStore::load_with_opts(root.join("blobs.db"), options)
            .await
            .map_err(|error| StoreError::Open {
                path: root.clone(),
                detail: error.to_string(),
            })?;
        Ok(Self { store, root })
    }

    /// The file a complete blob's bytes are in, or `None` when this device does
    /// not hold the whole thing.
    ///
    /// THE ANSWER `content_location` GIVES A GRID. It is iroh-blobs' own data
    /// file, read in place and never exported to a second copy: a phone that
    /// exported every cell of a camera roll would hold the roll twice.
    ///
    /// The name is computable — `<root>/data/<hex>.data`, which is
    /// `PathOptions::data_path` — but completeness is not, so this asks the
    /// store first. A path to a PARTIAL blob would be half a photograph
    /// rendered as a photograph, which is worse than a cell that says the file
    /// has not arrived.
    pub async fn data_path(&self, hash: ContentHash) -> Result<Option<PathBuf>> {
        if !self.is_complete(hash).await? {
            return Ok(None);
        }
        Ok(Some(self.data_file(hash)))
    }

    /// EVERY WHOLE BLOB THIS STORE HOLDS, with its file and its size.
    ///
    /// One store round trip ([`Self::complete_hashes`]) and then a `stat` per
    /// blob, which is what [`Self::sweep`] already does for the same set: the
    /// file name is computable, so asking the actor per blob would be a
    /// round trip to learn something the path already says.
    ///
    /// The one caller is the seat's held-blob table, which is rebuilt from this
    /// at every core open (#1025, D-1025-S7-20). A hash the index calls
    /// complete whose file cannot be stated is **left out**: a row is a promise
    /// that a surface can open the path, and a path that does not resolve is
    /// worse than a cell that says the photograph has not arrived.
    pub async fn held_files(&self) -> Result<Vec<(ContentHash, PathBuf, u64)>> {
        let mut held = Vec::new();
        for hash in self.complete_hashes().await? {
            let path = self.data_file(hash);
            let Ok(metadata) = std::fs::metadata(&path) else {
                continue;
            };
            held.push((hash, path, metadata.len()));
        }
        Ok(held)
    }

    /// Where a blob's bytes WOULD be. Says nothing about whether they are.
    fn data_file(&self, hash: ContentHash) -> PathBuf {
        self.root.join("data").join(format!("{hash}.data"))
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn blobs(&self) -> &Blobs {
        self.store.blobs()
    }

    /// Take a file into the store, hashing it as it is read.
    ///
    /// **Never holds the file in memory.** This is the verb a camera roll uses,
    /// and the reason [`Self::add_bytes`] exists beside it rather than instead
    /// of it.
    pub async fn add_path(&self, path: impl AsRef<Path>) -> Result<ContentHash> {
        let path = path.as_ref().to_path_buf();
        // An ABSOLUTE path: iroh-blobs refuses a relative one, and the refusal
        // would otherwise surface at a caller that never said "relative".
        let absolute = std::path::absolute(&path).map_err(|error| StoreError::Import {
            path: path.clone(),
            detail: error.to_string(),
        })?;
        // `TryReference`: a gateway importing a vault's whole CAS must not
        // store every photograph twice. iroh-blobs is free to copy anyway and
        // does for small files, which is why this is the option and not a
        // promise.
        let options = iroh_blobs::api::blobs::AddPathOptions {
            path: absolute,
            format: iroh_blobs::BlobFormat::Raw,
            mode: iroh_blobs::api::proto::ImportMode::TryReference,
        };
        self.tag_of(self.blobs().add_path_with_opts(options), &path)
            .await
    }

    /// Take bytes already in memory. For a thumbnail, a caption, a manifest —
    /// things whose size is known to be small at the call site.
    pub async fn add_bytes(&self, bytes: impl Into<bytes::Bytes>) -> Result<ContentHash> {
        self.tag_of(self.blobs().add_bytes(bytes), Path::new("<memory>"))
            .await
    }

    async fn tag_of(
        &self,
        progress: iroh_blobs::api::blobs::AddProgress<'_>,
        path: &Path,
    ) -> Result<ContentHash> {
        // A TEMPORARY TAG FIRST, then a permanent one named by the hash. The
        // temp tag is what keeps the freshly-imported blob from being collected
        // in the window between "the bytes are in" and "we know what to call
        // them" — which is a window that exists precisely because the name IS
        // the hash and is therefore not known until the import finishes.
        let temp = progress
            .temp_tag()
            .await
            .map_err(|error| StoreError::Import {
                path: path.to_path_buf(),
                detail: error.to_string(),
            })?;
        let hash_and_format = temp.hash_and_format();
        let hash = ContentHash::from(hash_and_format.hash);
        self.store
            .tags()
            .set(hash.to_hex(), hash_and_format)
            .await
            .map_err(|error| StoreError::Import {
                path: path.to_path_buf(),
                detail: error.to_string(),
            })?;
        drop(temp);
        Ok(hash)
    }

    /// How much of this blob is here.
    ///
    /// Reads the BITFIELD, not the status. `status` answers which of the three
    /// states a blob is in and, for a partial one, how big the whole blob is;
    /// only the bitfield knows how much of it landed. See [`Holding`].
    pub async fn holding(&self, hash: ContentHash) -> Result<Holding> {
        let query = |detail: String| StoreError::Query { hash, detail };
        let status = self
            .blobs()
            .status(hash)
            .await
            .map_err(|error| query(error.to_string()))?;
        Ok(match status {
            BlobStatus::NotFound => Holding::Missing,
            BlobStatus::Complete { size } => Holding::Complete { bytes: size },
            BlobStatus::Partial { size } => {
                let bitfield = self
                    .blobs()
                    .observe(hash)
                    .await
                    .map_err(|error| query(error.to_string()))?;
                Holding::Partial {
                    held: bitfield.total_bytes(),
                    size,
                }
            }
        })
    }

    /// Whether the whole blob is here. The narrow question, named as such.
    pub async fn is_complete(&self, hash: ContentHash) -> Result<bool> {
        Ok(self.holding(hash).await?.is_complete())
    }

    /// Write a complete blob out to a file a platform can open.
    ///
    /// The answer a grid wants is a path (`ContentUrl.path`), and this is what
    /// produces one. Refuses a partial blob: half a photograph rendered as a
    /// photograph is worse than a cell that says the file has not arrived.
    pub async fn export(&self, hash: ContentHash, target: impl AsRef<Path>) -> Result<u64> {
        let target = target.as_ref().to_path_buf();
        let absolute = std::path::absolute(&target).map_err(|error| StoreError::Export {
            hash,
            path: target.clone(),
            detail: error.to_string(),
        })?;
        self.blobs()
            .export(hash, &absolute)
            .finish()
            .await
            .map_err(|error| StoreError::Export {
                hash,
                path: target,
                detail: error.to_string(),
            })
    }

    /// Read a complete blob into memory. Small things only — a thumbnail, a
    /// manifest. There is deliberately no "read the original" verb.
    pub async fn read(&self, hash: ContentHash) -> Result<Vec<u8>> {
        self.blobs()
            .get_bytes(hash)
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|error| StoreError::Query {
                hash,
                detail: error.to_string(),
            })
    }

    /// Every blob this device holds WHOLE, in one call.
    ///
    /// A planner over a camera roll needs to know which of forty thousand
    /// candidates are already done, and asking [`Self::holding`] forty thousand
    /// times is forty thousand round trips to the store's actor. This is one.
    /// It deliberately says nothing about partial blobs — those are the small
    /// minority and [`Self::holding`] answers them exactly.
    pub async fn complete_hashes(&self) -> Result<std::collections::HashSet<ContentHash>> {
        self.blobs()
            .list()
            .hashes()
            .await
            .map(|hashes| hashes.into_iter().map(ContentHash::from).collect())
            .map_err(|error| StoreError::Query {
                hash: ContentHash::from_bytes([0; 32]),
                detail: format!("listing the store: {error}"),
            })
    }

    /// Drop this device's claim on a blob.
    ///
    /// Deletes the TAG, which is the only thing keeping the blob from
    /// iroh-blobs' collector; the bytes go when it next runs. Named `forget`
    /// and not `delete` because that is exactly what it promises — a blob
    /// another tag still names, or one a transfer is holding, stays.
    ///
    /// What it is for: the bootstrap artifact. It is the size of the vault, it
    /// has already been expanded into the replica, and a seat that kept it
    /// would hold its own vault twice on a phone.
    pub async fn forget(&self, hash: ContentHash) -> Result<()> {
        self.store
            .tags()
            .delete(hash.to_hex())
            .await
            .map(|_| ())
            .map_err(|error| StoreError::Query {
                hash,
                detail: error.to_string(),
            })
    }

    /// Free space down to `budget_bytes`, and NEVER take a pinned blob.
    ///
    /// ## The pin is structural, not a filter at the end (#1025 S3, R25)
    ///
    /// Bytes an unsettled outbox intent names are the ONE copy of a write a
    /// member has already made. Deleting them to make room for a cache turns a
    /// queued photograph into a queued photograph with nothing behind it, and
    /// no later window can recover it — the gateway never had the bytes, which
    /// is the whole reason the intent is still queued.
    ///
    /// So `pinned` is subtracted BEFORE anything is ordered, and a store whose
    /// pins alone exceed the budget reports [`Sweep::over_budget_by`] rather
    /// than breaking the promise. A sweep that filtered pins out at the end
    /// would evict them whenever the arithmetic came out that way, which is
    /// exactly when it matters.
    ///
    /// ## Oldest first, by the data file's own mtime
    ///
    /// There is no access time to read — iroh-blobs keeps none, and a phone's
    /// filesystem is usually mounted `noatime` — so the order is by when the
    /// bytes landed. That is the right order for a cache filled newest-first by
    /// [`crate::plan`]: the tail of the store is what a member scrolled past
    /// longest ago. A blob whose file cannot be stated sorts OLDEST, so a store
    /// that has lost track of a file frees it rather than keeping it forever.
    ///
    /// What is deleted is the TAG (see [`Self::forget`]); the bytes go when
    /// iroh-blobs' collector next runs.
    /// **It answers WHICH blobs it took, not only how many** (#1025,
    /// D-1025-S7-20): the seat keeps a row per held blob so a page read can
    /// join it, and a count cannot tell that table which rows to drop.
    pub async fn sweep(
        &self,
        pinned: &std::collections::HashSet<ContentHash>,
        budget_bytes: u64,
    ) -> Result<(Sweep, Vec<ContentHash>)> {
        let mut report = Sweep::default();
        let mut candidates: Vec<(std::time::SystemTime, ContentHash, u64)> = Vec::new();
        for hash in self.complete_hashes().await? {
            // The data file's own length and mtime in ONE stat. With nothing
            // inlined (see the module header) the file is the blob, so its
            // length is the size the budget is counted in.
            let Ok(metadata) = std::fs::metadata(self.data_file(hash)) else {
                // No file for a hash the index calls complete. Oldest, so it is
                // the first thing released.
                candidates.push((std::time::SystemTime::UNIX_EPOCH, hash, 0));
                continue;
            };
            let bytes = metadata.len();
            report.held += bytes;
            if pinned.contains(&hash) {
                report.pinned += bytes;
                continue;
            }
            candidates.push((
                metadata
                    .modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                hash,
                bytes,
            ));
        }
        report.over_budget_by = report.pinned.saturating_sub(budget_bytes);
        candidates.sort_by_key(|(at, hash, _)| (*at, *hash));

        let mut standing = report.held;
        let mut taken = Vec::new();
        for (_, hash, bytes) in candidates {
            if standing <= budget_bytes {
                break;
            }
            self.forget(hash).await?;
            standing = standing.saturating_sub(bytes);
            report.freed += bytes;
            report.evicted += 1;
            taken.push(hash);
        }
        Ok((report, taken))
    }

    /// Close the store cleanly, flushing its index.
    pub async fn close(self) {
        self.store.shutdown().await.ok();
    }
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
    /// says is that a queued write is holding the space.
    pub over_budget_by: u64,
}

/// `ContentHash` is accepted wherever iroh-blobs wants a `Hash`, so the store's
/// own signatures never mention the dependency.
impl From<ContentHash> for iroh_blobs::HashAndFormat {
    fn from(hash: ContentHash) -> Self {
        Self::raw(hash.into())
    }
}
