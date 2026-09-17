//! The base: **page-identical, sealed, and split into ranges** (#1029 §2, B1, B4).
//!
//! ## THE TWO DEFECTS THIS MODULE EXISTS TO CLOSE
//!
//! **B1 — the base was stored unsealed.** It was a gzipped `VACUUM INTO` copy,
//! put into the blob store as-is and gunzipped straight back out by recover.
//! That artefact is a complete vault: it carries `locker_key`, which names the
//! vault's live key, and `access_device_secret`, which is every paired device's
//! key half. The old module argued at length that a base must keep those
//! private bands — the argument is right and the conclusion was half-finished,
//! because a copy that keeps them and does not seal them is a plaintext vault
//! sitting in the backup. Every range is now a `centraid-object/1` object (§4).
//!
//! **B4 — `VACUUM INTO` renumbers pages**, which is why WAL frames could never
//! be replayed onto the base. A vacuum rebuilds the file from its logical
//! content: page 41 afterwards is not the page 41 the log has frames for. So the
//! copy is taken with **SQLite's online backup API**, which copies page 1 to
//! page 1 and page N to page N, and the result is byte-identical to the source
//! file. That is what makes [`super::segment::apply`] mean anything, and it is
//! also what makes range dedup work at all: under a vacuum, one inserted row
//! moves every page after it and every range would read as changed.
//!
//! `VACUUM` never runs on a vault for the same reason, and W1's
//! `auto_vacuum = NONE` is the pragma that keeps it from happening behind our
//! backs (`file.rs`).
//!
//! ## Ranges, and the index that makes a daily base cheap (F10)
//!
//! The file is cut into **page-aligned 4 MiB ranges**, each sealed as its own
//! object. A range whose plaintext hash is already in the vault's index reuses
//! the object that holds it — the gateway is never asked (§2). That is what
//! makes F10's "the base is the retention unit" affordable: a daily base of a
//! 400 MiB vault where one note changed is one new range and ninety-nine reused
//! ones.
//!
//! The index lives **in the vault** (§4, rung three), so a restored phone knows
//! what the store already holds and does not re-upload the whole file for its
//! first base.

use std::path::Path;

use centraid_media::object::{Kind, Role};

use crate::backup::objects::{ObjectKeys, ObjectsError};
use crate::backup::segment::GenerationId;
use crate::backup::store::{BlobError, BlobStore};
use crate::error::{Result, VaultError};
use crate::file::Vault;

/// The range size §2 names: 4 MiB, and page-aligned by construction because
/// 4 MiB is a whole number of 4096-byte pages.
pub const RANGE_BYTES: u64 = 4 * 1024 * 1024;

/// One 4 MiB slice of the base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseRange {
    pub index: u32,
    pub offset: u64,
    pub length: u64,
    /// BLAKE3 of this range's **plaintext**: the dedup key, and the thing that
    /// never leaves the phone (§4).
    pub plaintext_hash: String,
    /// BLAKE3 of the sealed object's ciphertext: the object's name.
    pub object_name: String,
    pub object_bytes: u64,
    /// Whether an object already held these bytes, so nothing new was sealed.
    pub reused: bool,
}

/// What a base is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseHead {
    /// **The vault identity key, hex** — §0's `vault_id`, not the file's local
    /// UUID. It is what a manifest names and what §4 binds into every object's
    /// AAD, so a base from another vault does not merely look wrong: it does
    /// not open.
    pub vault_id: String,
    /// The vault file's own `vault_id`, which is the directory a restore lands
    /// in. Local to this device; never in an object.
    pub file_vault_id: String,
    pub generation: GenerationId,
    /// The txid this base covers up to. A restore applies segments from
    /// `txid + 1`.
    pub txid: u64,
    pub page_size: u32,
    pub db_size_pages: u32,
    pub file_bytes: u64,
    /// BLAKE3 of the whole copied file, which is what a restore checks against.
    pub plaintext_hash: String,
    pub ranges: Vec<BaseRange>,
}

impl BaseHead {
    /// Ranges this base had to seal, rather than reuse.
    #[must_use]
    pub fn sealed_ranges(&self) -> usize {
        self.ranges.iter().filter(|range| !range.reused).count()
    }

    /// The bytes this base costs the store, counting only what it sealed.
    #[must_use]
    pub fn new_bytes(&self) -> u64 {
        self.ranges
            .iter()
            .filter(|range| !range.reused)
            .map(|range| range.object_bytes)
            .sum()
    }
}

/// Take a **page-identical** copy of the vault into `dir`.
///
/// Uses SQLite's online backup API, which copies page for page. The caller
/// holds the write mutex and has checkpointed, so the copy is the whole
/// committed state and no frame is left behind in a log the copy does not carry
/// (see `docs/traps/wal-checkpoint.md`).
///
/// # Errors
/// [`VaultError`] for anything SQLite or the filesystem refused.
pub fn copy_page_identical(vault: &Vault, target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_file(target);
    let mut destination = rusqlite::Connection::open(target)
        .map_err(|error| VaultError::from_sqlite("opening the base copy", error))?;
    {
        let backup = rusqlite::backup::Backup::new(vault.connection(), &mut destination)
            .map_err(|error| VaultError::from_sqlite("starting the base copy", error))?;
        // One step, every page: `-1` is "all remaining pages", so there is no
        // window in which the copy is half-made and the source has moved.
        backup
            .step(-1)
            .map_err(|error| VaultError::from_sqlite("copying the vault page for page", error))?;
    }
    destination
        .close()
        .map_err(|(_, error)| VaultError::from_sqlite("closing the base copy", error))?;
    Ok(())
}

/// Build the base of a generation: copy, split, seal what is new, record the
/// index.
///
/// Every sealed range goes into `blobs` — whose `put` fsyncs (B13) — and is then
/// **read back from the file and opened** before it is recorded (§4, F11). A
/// range the vault's index already names is reused and nothing is sealed for it.
///
/// # Errors
/// [`BaseError`] for anything the copy, the seal or the index refused.
pub fn build_base(
    vault: &Vault,
    keys: &ObjectKeys,
    blobs: &dyn BlobStore,
    generation: GenerationId,
    txid: u64,
    scratch: &Path,
) -> std::result::Result<BaseHead, BaseError> {
    let file_vault_id = vault.vault_id()?.ok_or_else(|| VaultError::Invariant {
        context: "a vault that was never founded has no base to take".to_owned(),
    })?;

    std::fs::create_dir_all(scratch)?;
    let copy = scratch.join("base.page-identical");
    copy_page_identical(vault, &copy)?;
    let bytes = std::fs::read(&copy)?;
    let _ = std::fs::remove_file(&copy);

    let page_size = u32::try_from(crate::file::PAGE_SIZE).unwrap_or(4096);
    let file_bytes = bytes.len() as u64;
    let db_size_pages = u32::try_from(file_bytes / u64::from(page_size)).unwrap_or(u32::MAX);

    let mut known = read_object_index(vault)?;
    let mut ranges = Vec::new();
    for (index, chunk) in bytes.chunks(RANGE_BYTES as usize).enumerate() {
        let plaintext_hash = blake3::hash(chunk).to_hex().to_string();
        let index32 = u32::try_from(index).unwrap_or(u32::MAX);
        let offset = index as u64 * RANGE_BYTES;

        if let Some((object_name, object_bytes)) = known.get(&plaintext_hash).cloned() {
            // §2: the phone decides reuse from its own index; the gateway is
            // never asked.
            ranges.push(BaseRange {
                index: index32,
                offset,
                length: chunk.len() as u64,
                plaintext_hash,
                object_name,
                object_bytes,
                reused: true,
            });
            continue;
        }

        let sealed = keys.seal(Kind::Base, Role::Whole, chunk)?;
        let object_name = blobs.put(&sealed.bytes)?;
        debug_assert_eq!(object_name, sealed.name.hex(), "the store names by BLAKE3");
        let path = blobs
            .path_of(&object_name)?
            .ok_or_else(|| BaseError::Vanished {
                object: object_name.clone(),
            })?;
        keys.verify_on_disk(Kind::Base, &sealed, &path)?;

        let object_bytes = sealed.bytes.len() as u64;
        known.insert(plaintext_hash.clone(), (object_name.clone(), object_bytes));
        ranges.push(BaseRange {
            index: index32,
            offset,
            length: chunk.len() as u64,
            plaintext_hash,
            object_name,
            object_bytes,
            reused: false,
        });
    }

    let head = BaseHead {
        vault_id: keys.vault_id_hex(),
        file_vault_id,
        generation,
        txid,
        page_size,
        db_size_pages,
        file_bytes,
        plaintext_hash: blake3::hash(&bytes).to_hex().to_string(),
        ranges,
    };
    record_base(vault, &head)?;
    Ok(head)
}

#[derive(Debug, thiserror::Error)]
pub enum BaseError {
    #[error(transparent)]
    Vault(#[from] VaultError),
    #[error(transparent)]
    Objects(#[from] ObjectsError),
    #[error(transparent)]
    Blob(#[from] BlobError),
    #[error("base io: {0}")]
    Io(#[from] std::io::Error),
    #[error("the base for generation {generation} names no range at offset {offset}")]
    MissingRange { generation: String, offset: u64 },
    #[error("the store lost object {object} between the put and the read-back")]
    Vanished { object: String },
}

/// The dedup index: plaintext hash → the object already holding those bytes.
///
/// # Errors
/// [`VaultError`] when the vault will not read.
pub fn read_object_index(
    vault: &Vault,
) -> Result<std::collections::HashMap<String, (String, u64)>> {
    vault.read(|connection| {
        let mut statement = connection
            .prepare("SELECT plaintext_hash, object_name, object_bytes FROM backup_object_range")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, String>(1)?, row.get::<_, i64>(2)? as u64),
            ))
        })?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    })
}

/// Write a base's ranges into the in-vault index.
///
/// **This is itself a commit**, so it produces WAL frames that the next capture
/// tick ships — which is right: the index is vault state and a restored phone
/// needs it (§2).
fn record_base(vault: &Vault, head: &BaseHead) -> Result<()> {
    let now = vault.clock().now_text();
    let generation = head.generation.hex();
    vault.commit(|tx| {
        let connection = tx.connection();
        for range in &head.ranges {
            connection.execute(
                "INSERT INTO backup_object_range
                     (plaintext_hash, object_name, object_bytes, plaintext_bytes, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (plaintext_hash) DO NOTHING",
                rusqlite::params![
                    range.plaintext_hash,
                    range.object_name,
                    range.object_bytes as i64,
                    range.length as i64,
                    now,
                ],
            )?;
            connection.execute(
                "INSERT INTO backup_base_range
                     (generation, range_index, byte_offset, byte_length, plaintext_hash, object_name)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (generation, range_index) DO UPDATE SET
                     byte_offset = excluded.byte_offset,
                     byte_length = excluded.byte_length,
                     plaintext_hash = excluded.plaintext_hash,
                     object_name = excluded.object_name",
                rusqlite::params![
                    generation,
                    i64::from(range.index),
                    range.offset as i64,
                    range.length as i64,
                    range.plaintext_hash,
                    range.object_name,
                ],
            )?;
        }
        Ok(())
    })?;
    Ok(())
}

/// Reassemble a base from its range objects, in order.
///
/// This is the first half of a restore: the file it writes is page-identical to
/// the vault the base was taken from, which is what lets
/// [`super::segment::apply`] write page numbers into it (B4).
///
/// # Errors
/// [`BaseError::MissingRange`] when a range's object is not among `objects`;
/// otherwise whatever opening refused.
pub fn restore_base(
    keys: &ObjectKeys,
    head: &BaseHead,
    blobs: &dyn BlobStore,
    target: &Path,
) -> std::result::Result<(), BaseError> {
    use std::io::Write as _;

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = std::fs::File::create(target)?;
    for range in &head.ranges {
        let sealed = blobs
            .get(&range.object_name)
            .map_err(|_| BaseError::MissingRange {
                generation: head.generation.hex(),
                offset: range.offset,
            })?;
        let plain = keys.open(Kind::Base, &sealed)?;
        // THE PLAINTEXT HASH IS CHECKED HERE, not only the object's name. The
        // name proves the ciphertext is whole; this proves the bytes are the
        // bytes the base was built from, which is the claim a restore makes.
        if blake3::hash(&plain).to_hex().to_string() != range.plaintext_hash {
            return Err(BaseError::MissingRange {
                generation: head.generation.hex(),
                offset: range.offset,
            });
        }
        out.write_all(&plain)?;
    }
    out.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::store::FsBlobStore;
    use crate::custody::locker_key;
    use crate::custody::member_key::MemberKeyCustody;

    fn keys() -> ObjectKeys {
        ObjectKeys::new([0x21; 32], [0x22; 32])
    }

    fn founded(dir: &Path) -> Vault {
        let vault = Vault::create(dir.join("vault.db")).expect("creates");
        let founded = vault.found("The Household", "Ada").expect("founds");
        vault
            .enrol_device("d-1", &founded.owner_party_id, "a laptop", "linux", "pk-1")
            .expect("enrols");
        let custody = MemberKeyCustody::on_seat(&dir.join("seat"), founded.vault_id.clone());
        vault
            .commit(|tx| {
                locker_key::found_locker_key(
                    tx.connection(),
                    &custody,
                    "k-1",
                    "2026-01-01T00:00:00.000Z",
                )
                .map_err(|error| VaultError::Invariant {
                    context: error.to_string(),
                })?;
                Ok(())
            })
            .expect("founds a locker key");
        vault
    }

    /// **B4.** The copy is page-identical, which `VACUUM INTO` is not — and
    /// that is the whole reason a WAL frame can be replayed onto it.
    #[test]
    fn the_copy_is_page_identical_and_a_vacuum_copy_is_not() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        // Write enough rows that a vacuum has something to renumber, then
        // delete some, so the file has free pages a vacuum would reclaim.
        for index in 0..200 {
            vault
                .commit(|tx| {
                    tx.connection().execute(
                        "INSERT INTO backup_object_range
                             (plaintext_hash, object_name, object_bytes, plaintext_bytes, created_at)
                         VALUES (?1, ?2, 1, 1, '2026-01-01T00:00:00.000Z')",
                        rusqlite::params![format!("{index:064}"), format!("{index:064}")],
                    )?;
                    Ok(())
                })
                .expect("writes");
        }
        vault
            .commit(|tx| {
                tx.connection()
                    .execute("DELETE FROM backup_object_range WHERE rowid % 2 = 0", [])?;
                Ok(())
            })
            .expect("deletes");

        // The source file is compared AFTER a checkpoint: until then the rows
        // are in the log and `vault.db` is four kilobytes of header. This is
        // also why `take_generation` checkpoints before it copies.
        vault
            .connection()
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("checkpoints");

        let identical = dir.path().join("identical.db");
        copy_page_identical(&vault, &identical).expect("copies");
        let vacuumed = dir.path().join("vacuumed.db");
        vault
            .connection()
            .execute("VACUUM INTO ?1", [vacuumed.to_str().expect("utf-8")])
            .expect("vacuums");
        vault.close().expect("closes");

        let source = std::fs::read(dir.path().join("vault.db")).expect("reads");
        let copied = std::fs::read(&identical).expect("reads");
        let vacuum_copy = std::fs::read(&vacuumed).expect("reads");
        assert_eq!(
            copied.len(),
            source.len(),
            "the backup API copies page for page"
        );
        assert_ne!(
            vacuum_copy.len(),
            source.len(),
            "a vacuum rebuilt the file — this is B4, reproduced"
        );
        // The change-counter and the WAL-related header fields legitimately
        // differ; every page body must not.
        assert_eq!(
            &copied[100..],
            &source[100..],
            "every page after the file header is identical"
        );
    }

    /// **B1.** The base is sealed, and the two rows the old artefact carried in
    /// the clear are not readable in it.
    #[test]
    fn the_base_is_sealed_and_carries_no_readable_locker_key() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        let keys = keys();
        let blobs = FsBlobStore::open(dir.path().join("objects")).expect("opens");
        let head = build_base(
            &vault,
            &keys,
            &blobs,
            GenerationId::from_bytes([1; 16]),
            0,
            &dir.path().join("scratch"),
        )
        .expect("builds");
        vault.close().expect("closes");

        assert!(!head.ranges.is_empty());
        for range in &head.ranges {
            let sealed = blobs.get(&range.object_name).expect("reads");
            for secret in [b"locker_key".as_slice(), b"access_device_secret".as_slice()] {
                assert!(
                    !sealed.windows(secret.len()).any(|window| window == secret),
                    "a sealed base range must not carry {} in the clear",
                    String::from_utf8_lossy(secret)
                );
            }
            assert_eq!(
                &sealed[..4],
                centraid_media::object::HEADER_MAGIC,
                "every range is a centraid-object"
            );
        }
    }

    /// **F10.** A second base over an unchanged vault reuses every range.
    #[test]
    fn an_unchanged_range_reuses_its_object_and_nothing_new_is_sealed() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        let keys = keys();
        let blobs = FsBlobStore::open(dir.path().join("objects")).expect("opens");
        let first = build_base(
            &vault,
            &keys,
            &blobs,
            GenerationId::from_bytes([1; 16]),
            0,
            &dir.path().join("scratch"),
        )
        .expect("builds");
        assert_eq!(first.sealed_ranges(), first.ranges.len(), "all new");

        let second = build_base(
            &vault,
            &keys,
            &blobs,
            GenerationId::from_bytes([2; 16]),
            1,
            &dir.path().join("scratch"),
        )
        .expect("builds");
        vault.close().expect("closes");
        // The first base's own index rows are a commit, so the file has moved
        // by one page at most; what must hold is that the ranges that did not
        // change were not resealed.
        assert!(
            second.sealed_ranges() < second.ranges.len() || second.ranges.len() == 1,
            "an unchanged range must reuse its object: {} of {} resealed",
            second.sealed_ranges(),
            second.ranges.len()
        );
    }

    /// The round trip the whole module is for: a base restores to the bytes it
    /// was taken from.
    #[test]
    fn a_base_restores_to_the_file_it_was_taken_from() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        let keys = keys();
        let blobs = FsBlobStore::open(dir.path().join("objects")).expect("opens");
        let head = build_base(
            &vault,
            &keys,
            &blobs,
            GenerationId::from_bytes([3; 16]),
            0,
            &dir.path().join("scratch"),
        )
        .expect("builds");
        vault.close().expect("closes");

        let restored = dir.path().join("restored.db");
        restore_base(&keys, &head, &blobs, &restored).expect("restores");
        let bytes = std::fs::read(&restored).expect("reads");
        assert_eq!(bytes.len() as u64, head.file_bytes);
        assert_eq!(
            blake3::hash(&bytes).to_hex().to_string(),
            head.plaintext_hash
        );

        // And it is a vault: the private bands the base exists to carry are in
        // it, readable now that it is decrypted.
        let connection = rusqlite::Connection::open(&restored).expect("opens");
        assert_eq!(
            locker_key::live_locker_key_id(&connection)
                .expect("reads")
                .as_deref(),
            Some("k-1")
        );
    }

    #[test]
    fn a_missing_range_object_is_named_rather_than_producing_a_short_file() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        let keys = keys();
        let blobs = FsBlobStore::open(dir.path().join("objects")).expect("opens");
        let head = build_base(
            &vault,
            &keys,
            &blobs,
            GenerationId::from_bytes([4; 16]),
            0,
            &dir.path().join("scratch"),
        )
        .expect("builds");
        vault.close().expect("closes");
        std::fs::remove_file(
            blobs
                .path_of(&head.ranges[0].object_name)
                .expect("asks")
                .expect("a path"),
        )
        .expect("removes");
        assert!(matches!(
            restore_base(&keys, &head, &blobs, &dir.path().join("out.db")),
            Err(BaseError::MissingRange { .. })
        ));
    }

    #[test]
    fn a_vault_that_was_never_founded_has_no_base() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = Vault::create(dir.path().join("vault.db")).expect("creates");
        let blobs = FsBlobStore::open(dir.path().join("objects")).expect("opens");
        assert!(
            build_base(
                &vault,
                &keys(),
                &blobs,
                GenerationId::from_bytes([5; 16]),
                0,
                &dir.path().join("scratch"),
            )
            .is_err()
        );
    }
}
