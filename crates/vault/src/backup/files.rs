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
//! **A file is a `blob` row** ([#1135](https://github.com/srikanth235/centraid/issues/1135)):
//! the originals and, because `derivative.out` is a foreign key into `blob`,
//! every thumbnail, preview and poster. A body kept in a row (a note's text) is
//! not a blob: it is the vault file's own and travels in every snapshot of it.
//! A purged document's blob row was collected with it, so its bytes are the
//! store's to reclaim and are listed nowhere; a trashed one's are listed until
//! its purge, because trash keeps its reference alive.

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
}

impl ContentFile {
    /// An original: the bytes a member took, made or received.
    #[must_use]
    pub const fn is_original(&self) -> bool {
        self.variant.is_none()
    }
}

/// Every blob, each hash once, newest first.
///
/// # Errors
/// [`super::PlaneError`] when the vault will not read, or a row holds a hash
/// that is not 64 lowercase hex characters or a negative size.
pub fn content_files(vault: &Vault) -> Result<Vec<ContentFile>> {
    type Row = (String, i64, Option<String>, Option<String>, String);
    let rows: Vec<Row> = vault.read(|connection| {
        let mut statement = connection.prepare(
            "SELECT b.hash, b.size,
                    (SELECT variant FROM derivative WHERE out = b.hash LIMIT 1),
                    COALESCE((SELECT media_type FROM derivative WHERE out = b.hash LIMIT 1),
                             (SELECT media_type FROM photo WHERE blob = b.hash),
                             (SELECT media_type FROM document WHERE blob = b.hash LIMIT 1),
                             (SELECT media_type FROM revision WHERE blob = b.hash LIMIT 1)),
                    COALESCE((SELECT created_at FROM derivative WHERE out = b.hash LIMIT 1),
                             (SELECT e.created_at FROM photo p JOIN entity e ON e.id = p.id
                               WHERE p.blob = b.hash),
                             (SELECT e.created_at FROM document d JOIN entity e ON e.id = d.id
                               WHERE d.blob = b.hash LIMIT 1),
                             (SELECT at FROM revision WHERE blob = b.hash LIMIT 1),
                             '')
               FROM blob b
              ORDER BY 5 DESC, 3 IS NOT NULL, 1",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    let mut out = Vec::with_capacity(rows.len());
    for (hash, size, variant, media_type, created_at) in rows {
        let h = PlaintextHash::from_hex(&hash)
            .map_err(|_| invariant(format!("a blob's hash `{hash}` cannot be named")))?;
        let len = u64::try_from(size)
            .map_err(|_| invariant(format!("blob `{hash}` has a negative size")))?;
        let media_type = media_type.unwrap_or_else(|| "application/octet-stream".to_owned());
        let video = media_type.trim().to_ascii_lowercase().starts_with("video/");
        out.push(ContentFile {
            h,
            len,
            media_type,
            variant,
            video,
            created_at,
        });
    }
    Ok(out)
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
    /// its reference alive; once purged it is collected and so is its thumbnail.
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
                    "UPDATE entity SET deleted_at = ?2, purge_at = ?2 WHERE id = ?1",
                    rusqlite::params![id, now],
                )?;
                Ok(())
            })
            .expect("commits");
        assert_eq!(content_files(&vault).expect("reads").len(), 2);
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
}
