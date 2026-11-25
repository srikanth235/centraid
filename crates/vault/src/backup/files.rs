//! Every file the vault knows by hash, as the phone backs it up (#1080, "The
//! phone core").
//!
//! [`super::naming::content_hashes`] answers what garbage collection needs —
//! a hash and a length. A pass needs more of each file to decide whether it
//! may cross this link now: whether it is an original or a derivative (a
//! thumbnail crosses on any link, an original by the member's rule), whether
//! it is a moving image (a video's original never crosses a metered link),
//! what the vault reads it as, and how recent it is (newest first, so the
//! photograph just taken is safe before last year's). The SQL stays here
//! because SQL is confined to this crate.
//!
//! **Which columns rent a blob is the schema's** ([`renting_columns`]; [`RENTERS`] says whose a row
//! is), and a Locker sealed file is flagged ([`ContentFile::sealed`]): opaque, always an original,
//! never excluded.
//!
//! **A file is a `blob` row** ([#1135](https://github.com/srikanth235/centraid/issues/1135)):
//! the originals and, because `derivative.out` is a foreign key into `blob`,
//! every thumbnail, preview and poster. A body kept in a row (a note's text) is
//! not a blob: it is the vault file's own and travels in every snapshot of it.
//! A purged document's blob row was collected with it, so its bytes are the
//! store's to reclaim and are listed nowhere; a trashed one's are listed until
//! its purge date, because trash keeps its reference alive, and not after it
//! ([`content_files`]).

use super::naming::PlaintextHash;
use super::{Result, invariant};
use crate::file::Vault;

/// One file the vault knows by hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentFile {
    pub h: PlaintextHash,
    pub len: u64,
    /// What the vault reads the bytes as: the media type the row that rents
    /// them states, or the derivative's own.
    pub media_type: String,
    /// `None` for an original; `thumb`, `preview` or `poster` for a derivative.
    pub variant: Option<String>,
    /// A moving image: its media type is a video's.
    pub video: bool,
    /// When the row that holds the bytes was made, as it stores it; empty for
    /// bytes whose renter does not say.
    pub created_at: String,
    /// A Locker sealed file: bytes already encrypted under the Locker key. Always part of a backup,
    /// whatever the member's exclusions, never freed from the phone, and no derivative is made from
    /// it, so it is never a [`Self::variant`] and never a video (its media type is sealed with it).
    pub sealed: bool,
}

impl ContentFile {
    /// An original: the bytes a member took, made or received.
    #[must_use]
    pub const fn is_original(&self) -> bool {
        self.variant.is_none()
    }
}

/// Every blob with a renter that is not past its purge date, each hash once,
/// newest first.
///
/// **A blob only lapsed entities name is not listed**: its renter's `purge_at`
/// has passed, so the next launch purges it and it is no longer the member's to
/// keep safe. Uploading it would spend the link on bytes about to be deleted,
/// and counting it would say "backed up" of something that is going. A blob a
/// live entity also names is listed; a blob nothing names yet (claimed, not
/// yet named) is listed; a derivative follows its original.
///
/// # Errors
/// [`super::PlaneError`] when the vault will not read, or a row holds a hash
/// that is not 64 lowercase hex characters or a negative size.
pub fn content_files(vault: &Vault) -> Result<Vec<ContentFile>> {
    let now_text = vault.clock().now_text();
    let now_ms = vault.clock().now_ms();
    vault.read(|connection| Ok(content_files_on(connection, &now_text, now_ms)))?
}

/// [`content_files`] read directly on `connection` (used by pinned read transactions without
/// locking [`Vault`]).
///
/// # Errors
/// As [`content_files`].
pub fn content_files_on(
    connection: &rusqlite::Connection,
    now_text: &str,
    now_ms: i64,
) -> Result<Vec<ContentFile>> {
    type Row = (String, i64, Option<String>, Option<String>, String, bool);
    let rows: Vec<Row> = (|| -> rusqlite::Result<Vec<Row>> {
        let mut statement = connection.prepare(&format!(
            "{} ORDER BY 5 DESC, variant IS NOT NULL, 1",
            select_files("")
        ))?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })()?;
    let lapsed = lapsed_blobs_on(connection, now_text, now_ms)?;
    let mut out = Vec::with_capacity(rows.len());
    for (hash, size, variant, media_type, created_at, sealed) in rows {
        if lapsed.contains(&hash) {
            continue;
        }
        let h = PlaintextHash::from_hex(&hash)
            .map_err(|_| invariant(format!("a blob's hash `{hash}` cannot be named")))?;
        let len = u64::try_from(size)
            .map_err(|_| invariant(format!("blob `{hash}` has a negative size")))?;
        let (media_type, variant, video) = read_as(media_type, variant, sealed);
        out.push(ContentFile {
            h,
            len,
            media_type,
            variant,
            video,
            created_at,
            sealed,
        });
    }
    Ok(out)
}

/// The query behind [`content_files_on`] and [`content_files_for`]: one row per blob,
/// `(hash, size, variant, media type, taken, sealed)`.
fn select_files(filter: &str) -> String {
    format!(
        "SELECT b.hash, b.size,
                (SELECT variant FROM derivative WHERE out = b.hash LIMIT 1) AS variant,
                COALESCE((SELECT media_type FROM derivative WHERE out = b.hash LIMIT 1),
                         (SELECT media_type FROM photo WHERE blob = b.hash LIMIT 1),
                         (SELECT media_type FROM document WHERE blob = b.hash LIMIT 1),
                         (SELECT media_type FROM revision_blob WHERE blob = b.hash AND media_type IS NOT NULL LIMIT 1)),
                COALESCE((SELECT p.taken_at FROM derivative dv JOIN photo p ON p.blob = dv.blob
                           WHERE dv.out = b.hash LIMIT 1),
                         (SELECT created_at FROM derivative WHERE out = b.hash LIMIT 1),
                         (SELECT COALESCE(p.taken_at, e.created_at) FROM photo p JOIN entity e ON e.id = p.id
                           WHERE p.blob = b.hash LIMIT 1),
                         (SELECT e.created_at FROM document d JOIN entity e ON e.id = d.id
                           WHERE d.blob = b.hash LIMIT 1),
                         (SELECT r.at FROM revision_blob rb JOIN revision r ON r.entity_id = rb.entity_id AND r.seq = rb.seq
                           WHERE rb.blob = b.hash LIMIT 1),
                         ''),
                {sealed}
           FROM blob b {filter}",
        sealed = crate::blob::sealed_condition("b.hash"),
    )
}

/// What the vault reads a file as. A sealed file is read as opaque bytes whatever else names its
/// hash (its real name and type are sealed inside the Locker item), is no one's derivative and is
/// never a moving image, so no exclusion of videos reaches it.
fn read_as(
    media_type: Option<String>,
    variant: Option<String>,
    sealed: bool,
) -> (String, Option<String>, bool) {
    if sealed {
        return ("application/octet-stream".to_owned(), None, false);
    }
    let media_type = media_type.unwrap_or_else(|| "application/octet-stream".to_owned());
    let video = media_type.trim().to_ascii_lowercase().starts_with("video/");
    (media_type, variant, video)
}

/// What the vault says of one hash a walk of its claims met.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Found {
    /// Rented, or not yet named by anyone: the member's to keep safe.
    Live(ContentFile),
    /// Only lapsed entities rent it: the vault's own collection will take it.
    Lapsed,
}

/// [`content_files`] for the named hashes alone: each that has a `blob` row, as [`Found::Live`]
/// or [`Found::Lapsed`]. A hash with no row is absent from the answer (collected since the
/// walk saw it). The B12 cursor walks a page of claims and asks this about the page.
///
/// # Errors
/// As [`content_files`].
pub fn content_files_for(
    vault: &Vault,
    hashes: &[PlaintextHash],
) -> Result<std::collections::BTreeMap<PlaintextHash, Found>> {
    type Row = (String, i64, Option<String>, Option<String>, String, bool);
    let lapsed = lapsed_blobs(vault)?;
    let mut out = std::collections::BTreeMap::new();
    let rows: Vec<Row> = vault.read(|connection| {
        let mut statement = connection.prepare(&select_files("WHERE b.hash = ?1"))?;
        let mut rows = Vec::new();
        for hash in hashes {
            let found = statement
                .query_map([hash.to_hex()], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<Row>>>()?;
            rows.extend(found);
        }
        Ok(rows)
    })?;
    for (hash, size, variant, media_type, created_at, sealed) in rows {
        let h = PlaintextHash::from_hex(&hash)
            .map_err(|_| invariant(format!("a blob's hash `{hash}` cannot be named")))?;
        if lapsed.contains(&hash) {
            out.insert(h, Found::Lapsed);
            continue;
        }
        let len = u64::try_from(size)
            .map_err(|_| invariant(format!("blob `{hash}` has a negative size")))?;
        let (media_type, variant, video) = read_as(media_type, variant, sealed);
        out.insert(
            h,
            Found::Live(ContentFile {
                h,
                len,
                media_type,
                variant,
                video,
                created_at,
                sealed,
            }),
        );
    }
    Ok(out)
}

/// Whose each renting column is: `(table, column, the column of that table naming the entity it
/// belongs to)`. **Which columns rent a blob is the schema's** (`PRAGMA foreign_key_list`, read by
/// [`crate::blob::references`], the same walk the collector makes); this list only says whose a
/// row of each is, which the schema cannot. [`lapsed_blobs`] fails, naming the column, when the
/// schema has a renter this list does not, and `tests/backup_renters.rs` holds the two equal, so a
/// column that rents bytes cannot be added without saying whose they are.
///
/// `derivative.out` is not here: a derivative's file is its original's.
pub const RENTERS: &[(&str, &str, &str)] = &[
    ("container", "cover", "id"),
    ("document", "blob", "id"),
    // A sealed file is a field of its item (I7); an earlier version names every blob it held
    // through `revision_blob` (B3).
    ("locker_item_field", "value_blob", "item_id"),
    ("message_attachment", "thumb", "thread_id"),
    ("note_asset", "blob", "note_id"),
    ("person", "avatar", "id"),
    ("photo", "blob", "id"),
    ("photo", "motion_blob", "id"),
    ("revision_blob", "blob", "entity_id"),
];

/// The columns that keep a blob alive, read from the file: every plain (not cascading) reference
/// into `blob(hash)`, as `(table, column)`, `derivative.out` included.
///
/// # Errors
/// SQLite's refusal.
pub fn renting_columns(
    connection: &rusqlite::Connection,
) -> crate::error::Result<std::collections::BTreeSet<(String, String)>> {
    Ok(crate::blob::references(connection)?
        .into_iter()
        .filter(|reference| reference.keeps_alive)
        .map(|reference| (reference.table, reference.column))
        .collect())
}

/// The hashes only lapsed entities rent: every renter of each is an entity
/// whose `purge_at` is at or before now, or a derivative of such a blob.
fn lapsed_blobs(vault: &Vault) -> Result<std::collections::HashSet<String>> {
    let now = vault.clock().now_text();
    let now_ms = vault.clock().now_ms();
    vault.read(|connection| Ok(lapsed_blobs_on(connection, &now, now_ms)))?
}

fn lapsed_blobs_on(
    connection: &rusqlite::Connection,
    now: &str,
    now_ms: i64,
) -> Result<std::collections::HashSet<String>> {
    use std::collections::{HashMap, HashSet};
    let read = || -> crate::error::Result<HashSet<String>> {
        // A clock far from the vault's last commit lapses nothing: bytes of a still-restorable
        // trashed item stay in the backup (#1191, V19).
        if !crate::clock::is_credible(connection, now_ms)? {
            return Ok(HashSet::new());
        }
        // hash -> whether some renter is live
        let mut live: HashMap<String, bool> = HashMap::new();
        for (table, column) in renting_columns(connection)? {
            // A derivative's file is its original's (below).
            if (table.as_str(), column.as_str()) == ("derivative", "out") {
                continue;
            }
            let Some((_, _, owner)) = RENTERS
                .iter()
                .find(|(name, rents, _)| *name == table && *rents == column)
            else {
                return Err(crate::error::VaultError::Invariant {
                    context: format!(
                        "`{table}.{column}` holds a blob hash and the backup does not know whose it is"
                    ),
                });
            };
            let mut statement = connection.prepare(&format!(
                "SELECT t.{column}, e.purge_at IS NOT NULL AND e.purge_at <= ?1
                   FROM {table} t JOIN entity e ON e.id = t.{owner}
                  WHERE t.{column} IS NOT NULL"
            ))?;
            let rows = statement.query_map([now], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })?;
            for row in rows {
                let (hash, lapsed) = row?;
                let entry = live.entry(hash).or_insert(false);
                *entry = *entry || !lapsed;
            }
        }
        // A derivative's file is its original's: live while the original is.
        let derived: Vec<(String, String)> = connection
            .prepare("SELECT blob, out FROM derivative WHERE out IS NOT NULL")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        loop {
            let mut changed = false;
            for (original, out) in &derived {
                // An original nothing rents is not lapsed (claimed, not yet named).
                let original_live = live.get(original).copied().unwrap_or(true);
                let entry = live.entry(out.clone()).or_insert(false);
                if original_live && !*entry {
                    *entry = true;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        Ok(live
            .into_iter()
            .filter(|(_, live)| !live)
            .map(|(hash, _)| hash)
            .collect::<HashSet<_>>())
    };
    read().map_err(|error| {
        invariant(format!(
            "the vault would not say which blobs have lapsed: {error}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(bytes: &[u8]) -> PlaintextHash {
        PlaintextHash::from_hex(&crate::blob::content_digest(bytes)).expect("a digest is a hash")
    }

    fn founded() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault.found("Household", "Ada").expect("founds");
        (dir, vault)
    }

    /// A photograph in the trash is still a file to send, because trash keeps
    /// its reference alive, until its purge date passes; once purged it is
    /// collected and so is its thumbnail.
    #[test]
    fn a_trashed_original_is_a_file_and_a_collected_one_is_not() {
        let (_dir, vault) = founded();
        let (original, thumb) = (hash(b"a photograph"), hash(b"its thumbnail"));
        let now = vault.clock().now_text();
        let id = vault.ids().next();
        vault
            .commit(|tx| {
                let c = tx.connection();
                crate::blob::stage(c, &original.to_hex(), 12)?;
                tx.insert_entity(&id, crate::model::Kind::Photo, "", &now)?;
                c.execute(
                    "INSERT INTO photo (id, blob, media_type, form) VALUES (?1, ?2, 'image/jpeg', 'photo')",
                    rusqlite::params![id, original.to_hex()],
                )?;
                crate::blob::write_derivative(
                    c,
                    &now,
                    &original.to_hex(),
                    "thumb",
                    Some((&thumb.to_hex(), 30, "image/jpeg")),
                    None,
                )?;
                c.execute(
                    "UPDATE entity SET deleted_at = ?2, purge_at = '9999-12-31T00:00:00.000Z'
                      WHERE id = ?1",
                    rusqlite::params![id, now],
                )?;
                Ok(())
            })
            .expect("commits");
        assert_eq!(content_files(&vault).expect("reads").len(), 2);
        // Past its purge date the launch pass takes it, so it is no longer a
        // file to keep safe: neither it nor its thumbnail is listed.
        vault
            .commit(|tx| {
                tx.connection().execute(
                    "UPDATE entity SET purge_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
                    [&id],
                )?;
                Ok(())
            })
            .expect("lapses");
        assert!(content_files(&vault).expect("reads").is_empty());
        vault
            .commit(|tx| {
                tx.connection()
                    .execute("DELETE FROM entity WHERE id = ?1", [&id])?;
                Ok(())
            })
            .expect("purges");
        assert_eq!(vault.collect_blobs().expect("collects").len(), 2);
        assert!(content_files(&vault).expect("reads").is_empty());
        assert!(
            crate::backup::naming::content_hashes(&vault)
                .expect("reads")
                .is_empty()
        );
    }

    #[test]
    fn an_original_and_its_poster_are_two_files_newest_first() {
        let (_dir, vault) = founded();
        let (original, poster) = (hash(b"a film"), hash(b"its poster"));
        let now = vault.clock().now_text();
        let id = vault.ids().next();
        vault
            .commit(|tx| {
                let c = tx.connection();
                crate::blob::stage(c, &original.to_hex(), 9000)?;
                tx.insert_entity(&id, crate::model::Kind::Photo, "", "2026-01-01T00:00:00.000Z")?;
                c.execute(
                    "INSERT INTO photo (id, blob, media_type, form) VALUES (?1, ?2, 'video/mp4', 'video')",
                    rusqlite::params![id, original.to_hex()],
                )?;
                crate::blob::write_derivative(
                    c,
                    "2026-02-01T00:00:00.000Z",
                    &original.to_hex(),
                    "poster",
                    Some((&poster.to_hex(), 30, "image/jpeg")),
                    None,
                )?;
                let _ = now;
                Ok(())
            })
            .expect("commits");
        let files = content_files(&vault).expect("reads");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].h, poster, "newest first");
        assert_eq!(files[0].variant.as_deref(), Some("poster"));
        assert!(!files[0].video, "a poster is a picture");
        assert_eq!(files[1].h, original);
        assert!(files[1].is_original() && files[1].video);
        assert_eq!(files[1].len, 9000);
    }

    #[test]
    fn photo_taken_at_orders_capture_time_and_propagates_to_derivatives() {
        let (_dir, vault) = founded();
        let (moon_orig, moon_thumb, recent_orig) = (
            hash(b"moon landing"),
            hash(b"moon thumb"),
            hash(b"recent photo"),
        );
        let id_moon = vault.ids().next();
        let id_recent = vault.ids().next();
        vault
            .commit(|tx| {
                let c = tx.connection();
                crate::blob::stage(c, &moon_orig.to_hex(), 100)?;
                tx.insert_entity(
                    &id_moon,
                    crate::model::Kind::Photo,
                    "",
                    "2026-11-24T12:00:00.000Z",
                )?;
                c.execute(
                    "INSERT INTO photo (id, blob, media_type, form, taken_at)
                     VALUES (?1, ?2, 'image/jpeg', 'photo', '1969-07-20T20:17:40.000Z')",
                    rusqlite::params![id_moon, moon_orig.to_hex()],
                )?;
                crate::blob::write_derivative(
                    c,
                    "2026-11-24T12:00:01.000Z",
                    &moon_orig.to_hex(),
                    "thumb",
                    Some((&moon_thumb.to_hex(), 30, "image/jpeg")),
                    None,
                )?;

                crate::blob::stage(c, &recent_orig.to_hex(), 200)?;
                tx.insert_entity(
                    &id_recent,
                    crate::model::Kind::Photo,
                    "",
                    "2026-11-23T12:00:00.000Z",
                )?;
                c.execute(
                    "INSERT INTO photo (id, blob, media_type, form, taken_at)
                     VALUES (?1, ?2, 'image/jpeg', 'photo', '2025-06-01T12:00:00.000Z')",
                    rusqlite::params![id_recent, recent_orig.to_hex()],
                )?;
                Ok(())
            })
            .expect("commits");

        let files = content_files(&vault).expect("reads");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].h, recent_orig);
        assert_eq!(files[0].created_at, "2025-06-01T12:00:00.000Z");
        // Moon photo and its derivative both carry 1969-07-20T20:17:40.000Z and sort after 2025.
        assert_eq!(files[1].h, moon_orig);
        assert_eq!(files[1].created_at, "1969-07-20T20:17:40.000Z");
        assert_eq!(files[2].h, moon_thumb);
        assert_eq!(files[2].created_at, "1969-07-20T20:17:40.000Z");
    }
}
