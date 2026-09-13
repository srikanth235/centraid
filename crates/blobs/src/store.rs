//! The local byte store: what this device holds, and how much of it (#1020,
//! D-1020-B3).
//!
//! This is `iroh-blobs`' filesystem store with a Centraid-shaped door on it.
//! The door is narrow on purpose — five verbs — because every extra one is a
//! place a caller could learn that the bytes are BLAKE3-addressed, and the
//! point of [`crate::hash::ContentHash`] is that they need not.
//!
//! ## Why this is not `centraid_vault::backup::store::BlobStore`
//!
//! That trait is `put(&[u8]) -> String` and `get(&str) -> Vec<u8>`, which is
//! right for what it was built for: a backup manifest is small and a generation
//! is moved whole, so holding one in memory costs nothing and the all-or-nothing
//! shape is a feature. Applying the same shape to a camera roll would mean
//! buffering an 800 MB video in a phone's address space to store it and again
//! to read it, and it has no way to express the state this whole plane exists
//! to make routine: **a blob this device holds PART of**.
//!
//! So the two stores coexist and address different things. The backup store
//! keeps SHA-256 over whole artefacts; this one keeps BLAKE3 over member bytes.
//! Neither is a migration of the other.
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
    pub async fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        std::fs::create_dir_all(&root).map_err(|error| StoreError::Open {
            path: root.clone(),
            detail: error.to_string(),
        })?;
        let store = FsStore::load(&root)
            .await
            .map_err(|error| StoreError::Open {
                path: root.clone(),
                detail: error.to_string(),
            })?;
        Ok(Self { store, root })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The underlying store, for [`crate::lane`] and for nothing else.
    ///
    /// `pub(crate)`: a caller that reaches iroh-blobs' own API has stepped past
    /// [`Holding`] and past the tagging rule above, and the two places that
    /// legitimately need it are both in this crate.
    pub(crate) const fn inner(&self) -> &FsStore {
        &self.store
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

    /// Take a vault's content CAS into the byte store, in place.
    ///
    /// `Vault::blobs_root_for` is one file per blob named by its hash, and
    /// since D-1020-B2 that hash is BLAKE3 — **the same hash this store uses**.
    /// So an import is not a translation: each file's own name is what it must
    /// hash to, and a mismatch is corruption reported rather than a blob filed
    /// under the wrong name.
    ///
    /// `TryReference`, so a gateway holding forty thousand photographs does not
    /// hold them twice. iroh-blobs may still copy — it is free to, and does for
    /// very small files — so this is a request and not a guarantee.
    ///
    /// Idempotent and cheap to repeat: a file already in the store is
    /// re-hashed and lands on the same name. Returns how many blobs the store
    /// holds from this directory, and how many files did not hash to their own
    /// name.
    pub async fn import_content_cas(&self, root: impl AsRef<Path>) -> Result<(usize, usize)> {
        let root = root.as_ref();
        let Ok(entries) = std::fs::read_dir(root) else {
            // NO CAS IS NOT AN ERROR. A vault with no photographs has no
            // directory, and a gateway that refused to start over it would
            // refuse to start over a brand-new vault.
            return Ok((0, 0));
        };
        let mut imported = 0usize;
        let mut mismatched = 0usize;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            // The filename IS the expected hash. A temp file from an
            // interrupted put (`<hash>.<pid>.tmp`) does not parse as one and is
            // skipped rather than imported under a name it did not claim.
            let Some(expected) = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| ContentHash::parse_hex(name).ok())
            else {
                continue;
            };
            match self.add_path(&path).await {
                Ok(actual) if actual == expected => imported += 1,
                Ok(_) => mismatched += 1,
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "a content blob would not import");
                    mismatched += 1;
                }
            }
        }
        Ok((imported, mismatched))
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

    /// Close the store cleanly, flushing its index.
    pub async fn close(self) {
        self.store.shutdown().await.ok();
    }
}

/// `ContentHash` is accepted wherever iroh-blobs wants a `Hash`, so the store's
/// own signatures never mention the dependency.
impl From<ContentHash> for iroh_blobs::HashAndFormat {
    fn from(hash: ContentHash) -> Self {
        Self::raw(hash.into())
    }
}
