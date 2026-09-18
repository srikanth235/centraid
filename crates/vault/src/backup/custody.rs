//! Blob custody: one file key per set of bytes, and where those bytes are
//! (#1029 §4, F6, F8, F14).
//!
//! Rung four's two tables, and the four things they make true.
//!
//! **1. Every original and thumbnail is encrypted ONCE, under a fresh 32-byte
//! file key.** [`admit`] mints a key only when the plaintext hash is new. A
//! second import of the same photograph — the ordinary case, because a camera
//! roll is re-walked every time the app wakes — is a `SELECT`, and the bytes are
//! never sealed, never uploaded and never counted twice.
//!
//! **2. The phone deduplicates on its own, and the plaintext hash never leaves
//! the vault.** The hash is the primary key here and appears nowhere else: an
//! object is named by its own CIPHERTEXT hash, and nothing this module writes
//! goes on the wire. The gateway is never asked whether it already holds
//! something; it could not answer without being told a plaintext commitment,
//! which is the leak §4 spends the format avoiding.
//!
//! **3. The vault is the index.** [`Placement`] is `(object, offset, length)`
//! per part. A blob under 16 MiB is one part at offset 0 of its own object; one
//! over is a list of `blob` objects (F6); a thumbnail is a range inside a pack.
//! One shape for all three, so a reader never branches on which it got, and no
//! index file exists to load or to grow with the backup in memory.
//!
//! **4. Sharing hands out a file key, not a copy.** W8 builds sharing; what
//! makes it cheap is here — there is ONE row and ONE file key for one set of
//! bytes, so a photo shared with ten people is ten capabilities over one upload.
//! A share's own capability is deliberately NOT in this module: that is W8's,
//! and the property it needs from here is that the key is a row it can read.
//!
//! ## WHY A RESTORE'S THUMBNAIL GRID COSTS PACKS AND NOT THUMBNAILS
//!
//! [`grid_fetches`] groups placements by object. A hundred thousand thumbnails
//! packed at ~16 MiB apiece are some tens of packs, and the grid is complete
//! after that many GETs — each pack downloaded once and sliced locally by the
//! ranges these rows already hold. The number is a property of the ROWS, not of
//! the transport, which is why it can be tested without one
//! (`tests/restore_grid.rs`).
//!
//! ## F14 — THE VAULT OWNS ITS COPY, WITH EVICTION
//!
//! A custody row is a claim on bytes the vault holds, not a reference into the
//! OS photo library. PhotoKit often does not hold the original under "Optimize
//! iPhone Storage"; restoring into the OS library mints new asset ids that break
//! every reference; and iCloud Photos on the new phone already has the images.
//! So the row names a plaintext hash the vault can re-derive and an object the
//! vault can re-fetch, and `centraid_blobs::ByteStore::sweep` is free to evict
//! the local copy at any time without the row becoming a lie.

use centraid_media::object;

use crate::error::{Result, VaultError};
use crate::file::Vault;

/// A blob's own key. 32 random bytes, drawn once for one set of bytes.
///
/// Not `Debug`-printable and not `Display`: a key in a log line is a key in a
/// crash report. `centraid_identity` makes the same choice for the same reason.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct FileKey([u8; object::KEY_BYTES]);

impl FileKey {
    /// Draw a fresh one from the operating system.
    ///
    /// # Errors
    /// [`VaultError::Invariant`] when the operating system will not give
    /// entropy — never a quieter generator, for the reason
    /// `centraid_media::object::ObjectError::Entropy` gives.
    pub fn fresh() -> Result<Self> {
        use rand::TryRngCore as _;

        let mut bytes = [0_u8; object::KEY_BYTES];
        rand::rngs::OsRng
            .try_fill_bytes(&mut bytes)
            .map_err(|error| VaultError::Invariant {
                context: format!("the operating system would not give a file key: {error}"),
            })?;
        Ok(Self(bytes))
    }

    /// Adopt the 32 bytes a custody row carries.
    ///
    /// # Errors
    /// [`VaultError::Invariant`] when the column does not hold 32 bytes, which
    /// the table's own CHECK already refuses to store.
    pub fn from_row(bytes: &[u8]) -> Result<Self> {
        Ok(Self(bytes.try_into().map_err(|_| {
            VaultError::Invariant {
                context: format!("a file key is 32 bytes and this row has {}", bytes.len()),
            }
        })?))
    }

    /// The key, for sealing and opening. Borrowed, never copied out.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; object::KEY_BYTES] {
        &self.0
    }

    /// The custody this key is, for [`object::seal`].
    #[must_use]
    pub const fn custody(&self) -> object::Custody<'_> {
        object::Custody::FileKey(&self.0)
    }
}

impl std::fmt::Debug for FileKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("FileKey(<redacted>)")
    }
}

/// What a blob is. The column's two values, and there is no third: a `base`, a
/// `segment` and a `manifest` are wrapped under the root and have no custody row
/// at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobRole {
    /// A camera original.
    Original,
    /// A generated thumbnail.
    Thumbnail,
}

impl BlobRole {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Thumbnail => "thumbnail",
        }
    }

    /// Read one back out of the column.
    ///
    /// # Errors
    /// [`VaultError::Invariant`] for a value the column's CHECK would refuse.
    pub fn from_column(text: &str) -> Result<Self> {
        match text {
            "original" => Ok(Self::Original),
            "thumbnail" => Ok(Self::Thumbnail),
            other => Err(VaultError::Invariant {
                context: format!("{other:?} is not a blob role"),
            }),
        }
    }

    /// The object kind and role this blob seals as.
    #[must_use]
    pub const fn object(self) -> (object::Kind, object::Role) {
        match self {
            Self::Original => (object::Kind::Blob, object::Role::Original),
            Self::Thumbnail => (object::Kind::Thumbnail, object::Role::Thumbnail),
        }
    }
}

/// WHERE a blob's bytes are: `(object, offset, length)`, §4's own triple.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    /// Which part of the blob this is. `0` for anything that fits one object.
    pub part_index: u32,
    /// The object's name: BLAKE3 of its own ciphertext.
    pub object_name: String,
    /// Where this part starts INSIDE that object. `0` for a whole object, and
    /// the item's offset for a thumbnail inside a pack.
    pub byte_offset: u64,
    /// How many bytes of that object this part occupies.
    pub byte_length: u64,
}

/// One blob's whole row: its key, its size, its role and where it lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Custody {
    /// BLAKE3 of the plaintext. **The dedup key, and it never leaves here.**
    pub plaintext_hash: String,
    pub file_key: FileKey,
    pub plaintext_bytes: u64,
    pub role: BlobRole,
    /// In `part_index` order. Empty for a blob admitted but not yet sealed.
    pub placements: Vec<Placement>,
}

/// What [`admit`] decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    /// These bytes are already the vault's. **Nothing is sealed and nothing is
    /// uploaded** — this is the ordinary outcome of a re-walked camera roll.
    Held(Box<Custody>),
    /// New bytes, with the fresh file key they are to be sealed under.
    Fresh(FileKey),
}

/// **The phone's own deduplication** (§4).
///
/// Look the plaintext hash up; mint a file key and a row only if it is new.
/// The gateway is not asked and could not be — it holds ciphertext named by
/// ciphertext hashes, and telling it a plaintext hash is the confirmable
/// commitment the whole format avoids.
///
/// Admitting is a COMMIT, because the row is what makes the key survive the
/// crash between "the bytes were sealed" and "the upload finished". A key drawn
/// and not written down is a photograph nobody can ever open again.
///
/// # Errors
/// [`VaultError`] for anything SQLite refused, or a row whose key is not 32
/// bytes.
pub fn admit(
    vault: &Vault,
    plaintext_hash: &str,
    plaintext_bytes: u64,
    role: BlobRole,
) -> Result<Admission> {
    if let Some(held) = lookup(vault, plaintext_hash)? {
        return Ok(Admission::Held(Box::new(held)));
    }
    let key = FileKey::fresh()?;
    let now = vault.clock().now_text();
    vault.commit(|tx| {
        tx.connection().execute(
            "INSERT INTO backup_blob_custody
                 (plaintext_hash, file_key, plaintext_bytes, blob_role, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (plaintext_hash) DO NOTHING",
            rusqlite::params![
                plaintext_hash,
                key.as_bytes().as_slice(),
                plaintext_bytes as i64,
                role.as_str(),
                now,
            ],
        )?;
        Ok(())
    })?;
    // The insert may have lost a race with another writer on the same bytes.
    // Reading back is what makes this function's promise — "one key per set of
    // bytes" — true rather than probable.
    match lookup(vault, plaintext_hash)? {
        Some(held) if held.file_key != key => Ok(Admission::Held(Box::new(held))),
        _ => Ok(Admission::Fresh(key)),
    }
}

/// Record where a blob's bytes landed, replacing any earlier answer.
///
/// Replacing rather than appending: a repack moves items, and a blob whose old
/// placement survived beside its new one would be a row pointing at a pack that
/// has been tombstoned.
///
/// # Errors
/// [`VaultError`] for anything SQLite refused — including a placement for a
/// blob with no custody row, which the foreign key refuses.
pub fn record_placements(
    vault: &Vault,
    plaintext_hash: &str,
    placements: &[Placement],
) -> Result<()> {
    vault.commit(|tx| {
        let connection = tx.connection();
        connection.execute(
            "DELETE FROM backup_blob_placement WHERE plaintext_hash = ?1",
            rusqlite::params![plaintext_hash],
        )?;
        for placement in placements {
            connection.execute(
                "INSERT INTO backup_blob_placement
                     (plaintext_hash, part_index, object_name, byte_offset, byte_length)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    plaintext_hash,
                    i64::from(placement.part_index),
                    placement.object_name,
                    placement.byte_offset as i64,
                    placement.byte_length as i64,
                ],
            )?;
        }
        Ok(())
    })?;
    Ok(())
}

/// One blob's custody row, with its placements.
///
/// # Errors
/// [`VaultError`] for anything SQLite refused, or a malformed row.
pub fn lookup(vault: &Vault, plaintext_hash: &str) -> Result<Option<Custody>> {
    vault.read(|connection| {
        let row = connection
            .query_row(
                "SELECT file_key, plaintext_bytes, blob_role FROM backup_blob_custody
                 WHERE plaintext_hash = ?1",
                rusqlite::params![plaintext_hash],
                |row| {
                    Ok((
                        row.get::<_, Vec<u8>>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional_row()?;
        let Some((key, bytes, role)) = row else {
            return Ok(None);
        };
        Ok(Some(Custody {
            plaintext_hash: plaintext_hash.to_owned(),
            file_key: FileKey::from_row(&key)?,
            plaintext_bytes: bytes as u64,
            role: BlobRole::from_column(&role)?,
            placements: placements_of(connection, plaintext_hash)?,
        }))
    })
}

/// **Every thumbnail the vault knows**, with its key and its ranges.
///
/// The read a restore makes once, before it downloads a single original. It is
/// one query and not one per item, and what it answers is fed straight to
/// [`grid_fetches`].
///
/// # Errors
/// [`VaultError`] for anything SQLite refused, or a malformed row.
pub fn thumbnails(vault: &Vault) -> Result<Vec<Custody>> {
    by_role(vault, BlobRole::Thumbnail)
}

/// Every original the vault knows. The list a grid shows placeholders for and
/// fetches **on demand** (F14) — never eagerly, and never before the grid.
///
/// # Errors
/// [`VaultError`] for anything SQLite refused, or a malformed row.
pub fn originals(vault: &Vault) -> Result<Vec<Custody>> {
    by_role(vault, BlobRole::Original)
}

fn by_role(vault: &Vault, role: BlobRole) -> Result<Vec<Custody>> {
    vault.read(|connection| {
        let mut statement = connection.prepare(
            "SELECT c.plaintext_hash, c.file_key, c.plaintext_bytes,
                    p.part_index, p.object_name, p.byte_offset, p.byte_length
             FROM backup_blob_custody c
             LEFT JOIN backup_blob_placement p ON p.plaintext_hash = c.plaintext_hash
             WHERE c.blob_role = ?1
             ORDER BY c.plaintext_hash, p.part_index",
        )?;
        let mut out: Vec<Custody> = Vec::new();
        let mut rows = statement.query(rusqlite::params![role.as_str()])?;
        while let Some(row) = rows.next()? {
            let hash: String = row.get(0)?;
            if out.last().map(|held| held.plaintext_hash.as_str()) != Some(hash.as_str()) {
                out.push(Custody {
                    plaintext_hash: hash,
                    file_key: FileKey::from_row(&row.get::<_, Vec<u8>>(1)?)?,
                    plaintext_bytes: row.get::<_, i64>(2)? as u64,
                    role,
                    placements: Vec::new(),
                });
            }
            // A LEFT JOIN: a blob admitted but not yet sealed has one row with a
            // null part, and it is a real state — the crash window between
            // `admit` and `record_placements`.
            if let Some(part) = row.get::<_, Option<i64>>(3)? {
                let last = out.last_mut().expect("a row was just pushed");
                last.placements.push(Placement {
                    part_index: u32::try_from(part).unwrap_or(u32::MAX),
                    object_name: row.get(4)?,
                    byte_offset: row.get::<_, i64>(5)? as u64,
                    byte_length: row.get::<_, i64>(6)? as u64,
                });
            }
        }
        Ok(out)
    })
}

fn placements_of(
    connection: &rusqlite::Connection,
    plaintext_hash: &str,
) -> Result<Vec<Placement>> {
    let mut statement = connection.prepare(
        "SELECT part_index, object_name, byte_offset, byte_length
         FROM backup_blob_placement WHERE plaintext_hash = ?1 ORDER BY part_index",
    )?;
    let rows = statement.query_map(rusqlite::params![plaintext_hash], |row| {
        Ok(Placement {
            part_index: u32::try_from(row.get::<_, i64>(0)?).unwrap_or(u32::MAX),
            object_name: row.get(1)?,
            byte_offset: row.get::<_, i64>(2)? as u64,
            byte_length: row.get::<_, i64>(3)? as u64,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// One object a restore has to fetch, and every item it will slice out of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectFetch {
    pub object_name: String,
    /// The `(plaintext_hash, placement)` pairs this object serves, in the order
    /// they appear inside it — so a reader slices forward and never seeks back.
    pub items: Vec<(String, Placement)>,
}

impl ObjectFetch {
    /// The first byte of this object any item needs, and the last.
    ///
    /// A pack is downloaded whole in practice — the items are dense and the
    /// range is the object — but the pair is what a ranged GET would use, and it
    /// is what makes a partly-dead pack cost its live span rather than its size.
    #[must_use]
    pub fn byte_span(&self) -> (u64, u64) {
        let first = self
            .items
            .iter()
            .map(|(_, placement)| placement.byte_offset)
            .min()
            .unwrap_or(0);
        let last = self
            .items
            .iter()
            .map(|(_, placement)| placement.byte_offset + placement.byte_length)
            .max()
            .unwrap_or(0);
        (first, last)
    }
}

/// **The plan that makes a restored grid cost packs, not thumbnails** (§4, §5).
///
/// Group every placement by the object that holds it. The answer's LENGTH is
/// the number of requests the grid costs, and it is the number of distinct
/// objects — which for packed thumbnails is `total bytes / 16 MiB`, whatever the
/// item count. `tests/restore_grid.rs` runs it at a hundred thousand.
///
/// Pure: no store, no socket, no SQL. The rows come from [`thumbnails`], and
/// scheduling is the part most likely to change as real phones report back.
#[must_use]
pub fn grid_fetches(blobs: &[Custody]) -> Vec<ObjectFetch> {
    // A BTreeMap and not a HashMap: the order a restore fetches in has to be
    // the same on two runs, or a resumed restore re-fetches what it already
    // has. Object names are ciphertext hashes, so the order is arbitrary but
    // stable, which is the property that matters.
    let mut by_object: std::collections::BTreeMap<&str, Vec<(String, Placement)>> =
        std::collections::BTreeMap::new();
    for blob in blobs {
        for placement in &blob.placements {
            by_object
                .entry(placement.object_name.as_str())
                .or_default()
                .push((blob.plaintext_hash.clone(), placement.clone()));
        }
    }
    by_object
        .into_iter()
        .map(|(object_name, mut items)| {
            items.sort_by_key(|(hash, placement)| {
                (placement.byte_offset, placement.part_index, hash.clone())
            });
            ObjectFetch {
                object_name: object_name.to_owned(),
                items,
            }
        })
        .collect()
}

/// `query_row` that answers `None` for no rows instead of an error.
trait OptionalRow<T> {
    fn optional_row(self) -> Result<Option<T>>;
}

impl<T> OptionalRow<T> for rusqlite::Result<T> {
    fn optional_row(self) -> Result<Option<T>> {
        match self {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file::Vault;

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = Vault::create(dir.path().join("vault.db")).expect("creates");
        (dir, vault)
    }

    fn hash(seed: u8) -> String {
        hex::encode([seed; 32])
    }

    /// **THE PHONE DEDUPLICATES ON ITS OWN.** The same bytes twice is one key,
    /// one row, and nothing to seal the second time.
    #[test]
    fn the_same_bytes_twice_are_admitted_once_under_one_file_key() {
        let (_dir, vault) = vault();
        let first = admit(&vault, &hash(1), 4096, BlobRole::Original).expect("admits");
        let Admission::Fresh(key) = first else {
            panic!("the first sight of these bytes is not fresh");
        };

        let second = admit(&vault, &hash(1), 4096, BlobRole::Original).expect("admits");
        let Admission::Held(held) = second else {
            panic!(
                "the second sight of the same bytes minted a second key — \
                    that is a second upload of one photograph"
            );
        };
        assert_eq!(
            held.file_key, key,
            "the held row is not the key that was minted"
        );
        assert_eq!(held.plaintext_bytes, 4096);
        assert_eq!(held.role, BlobRole::Original);
    }

    /// Two different photographs get two different keys. Asserted because the
    /// day they share one is the day sharing a photo shares its neighbour.
    #[test]
    fn two_different_blobs_never_share_a_file_key() {
        let (_dir, vault) = vault();
        let Admission::Fresh(one) = admit(&vault, &hash(2), 1, BlobRole::Original).expect("admits")
        else {
            panic!("fresh");
        };
        let Admission::Fresh(two) = admit(&vault, &hash(3), 1, BlobRole::Original).expect("admits")
        else {
            panic!("fresh");
        };
        assert_ne!(one, two);
    }

    #[test]
    fn placements_round_trip_and_replace_rather_than_accumulate() {
        let (_dir, vault) = vault();
        admit(&vault, &hash(4), 99, BlobRole::Thumbnail).expect("admits");
        let first = vec![Placement {
            part_index: 0,
            object_name: hash(9),
            byte_offset: 128,
            byte_length: 64,
        }];
        record_placements(&vault, &hash(4), &first).expect("records");
        assert_eq!(
            lookup(&vault, &hash(4))
                .expect("looks up")
                .expect("a row")
                .placements,
            first
        );

        // A repack moved it. The old row must not survive beside the new one.
        let moved = vec![Placement {
            part_index: 0,
            object_name: hash(10),
            byte_offset: 0,
            byte_length: 64,
        }];
        record_placements(&vault, &hash(4), &moved).expect("records");
        assert_eq!(
            lookup(&vault, &hash(4))
                .expect("looks up")
                .expect("a row")
                .placements,
            moved
        );
    }

    /// F6: an original over 16 MiB is a LIST of blob objects, and the parts come
    /// back in order.
    #[test]
    fn a_blob_over_the_cap_is_an_ordered_list_of_parts() {
        let (_dir, vault) = vault();
        admit(&vault, &hash(5), 30 * 1024 * 1024, BlobRole::Original).expect("admits");
        let parts: Vec<Placement> = (0..3_u32)
            .map(|index| Placement {
                part_index: index,
                object_name: hash(20 + index as u8),
                byte_offset: 0,
                byte_length: 14 * 1024 * 1024,
            })
            .collect();
        record_placements(&vault, &hash(5), &parts).expect("records");
        let back = lookup(&vault, &hash(5)).expect("looks up").expect("a row");
        assert_eq!(back.placements, parts);
        assert_eq!(
            back.placements
                .iter()
                .map(|p| p.part_index)
                .collect::<Vec<_>>(),
            [0, 1, 2]
        );
    }

    /// A placement for bytes with no custody row is refused by the foreign key,
    /// not written and discovered later.
    #[test]
    fn a_placement_without_a_custody_row_is_refused() {
        let (_dir, vault) = vault();
        assert!(
            record_placements(
                &vault,
                &hash(6),
                &[Placement {
                    part_index: 0,
                    object_name: hash(7),
                    byte_offset: 0,
                    byte_length: 1,
                }],
            )
            .is_err()
        );
    }

    #[test]
    fn a_file_key_is_never_printed() {
        let key = FileKey::fresh().expect("draws");
        assert_eq!(format!("{key:?}"), "FileKey(<redacted>)");
        assert!(!format!("{key:?}").contains(&hex::encode(key.as_bytes())[..8]));
    }

    /// The grid plan is one fetch per OBJECT, and the items inside it are in
    /// offset order so a reader slices forward.
    #[test]
    fn the_grid_plan_is_one_fetch_per_object_however_many_items() {
        let pack = hash(30);
        let blobs: Vec<Custody> = (0..40_u8)
            .map(|index| Custody {
                plaintext_hash: hash(index),
                file_key: FileKey::fresh().expect("draws"),
                plaintext_bytes: 1024,
                role: BlobRole::Thumbnail,
                placements: vec![Placement {
                    part_index: 0,
                    object_name: pack.clone(),
                    // Descending offsets, so the sort is doing something.
                    byte_offset: u64::from(40 - index) * 1024,
                    byte_length: 1024,
                }],
            })
            .collect();

        let fetches = grid_fetches(&blobs);
        assert_eq!(
            fetches.len(),
            1,
            "forty thumbnails in one pack is one fetch"
        );
        assert_eq!(fetches[0].object_name, pack);
        assert_eq!(fetches[0].items.len(), 40);
        assert!(
            fetches[0]
                .items
                .windows(2)
                .all(|pair| pair[0].1.byte_offset <= pair[1].1.byte_offset),
            "the items are not in offset order"
        );
        assert_eq!(fetches[0].byte_span(), (1024, 41 * 1024));
    }

    #[test]
    fn a_blob_admitted_but_not_yet_sealed_is_a_row_with_no_placements() {
        let (_dir, vault) = vault();
        admit(&vault, &hash(8), 7, BlobRole::Thumbnail).expect("admits");
        let all = thumbnails(&vault).expect("reads");
        assert_eq!(all.len(), 1);
        assert!(all[0].placements.is_empty());
        assert!(grid_fetches(&all).is_empty(), "nothing to fetch yet");
        assert!(originals(&vault).expect("reads").is_empty());
    }
}
