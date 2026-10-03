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

use std::collections::BTreeSet;

use super::naming::PlaintextHash;
use super::{Result, invariant};
use crate::file::Vault;

/// One file the vault knows by hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentFile {
    pub h: PlaintextHash,
    pub len: u64,
    /// What the vault reads the bytes as: the content item's oldest
    /// representation, or the derivative's own type.
    pub media_type: String,
    /// `None` for an original (a content item); `thumb`, `preview` or
    /// `poster` for a derivative.
    pub variant: Option<String>,
    /// A moving image: its media type is a video's, or its asset is a video.
    pub video: bool,
    /// When the vault learned of it, as the row stores it.
    pub created_at: String,
}

impl ContentFile {
    /// An original: the bytes a member took, made or received.
    #[must_use]
    pub const fn is_original(&self) -> bool {
        self.variant.is_none()
    }
}

/// Every content item and every derivative with bytes of its own, each hash
/// once, newest first. Trashed rows are included: their bytes are restorable
/// until the row is purged, exactly as [`super::naming::content_hashes`]
/// counts them.
///
/// # Errors
/// [`super::PlaneError`] when the vault will not read, or a row holds a hash
/// that is not 64 lowercase hex characters or a negative size.
pub fn content_files(vault: &Vault) -> Result<Vec<ContentFile>> {
    type Row = (String, i64, Option<String>, Option<String>, i64, String);
    let rows: Vec<Row> = vault.read(|connection| {
        let mut statement = connection.prepare(
            "SELECT i.content_hash, i.byte_size,
                    (SELECT r.media_type FROM core_content_representation r
                      WHERE r.content_id = i.content_id
                      ORDER BY r.created_at, r.representation_id LIMIT 1),
                    NULL,
                    EXISTS (SELECT 1 FROM media_asset a
                             WHERE a.content_id = i.content_id AND a.kind = 'video'),
                    i.created_at
               FROM core_content_item i
             UNION ALL
             SELECT d.content_hash, d.byte_size, d.media_type, d.variant, 0, d.created_at
               FROM core_content_derivative d
              WHERE d.content_hash IS NOT NULL
             ORDER BY 6 DESC, 4 IS NOT NULL, 1",
        )?;
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
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(rows.len());
    for (hash, size, media_type, variant, video_asset, created_at) in rows {
        let h = PlaintextHash::from_hex(&hash)
            .map_err(|_| invariant(format!("a content row's hash `{hash}` cannot be named")))?;
        if !seen.insert(h) {
            continue;
        }
        let len = u64::try_from(size)
            .map_err(|_| invariant(format!("content `{hash}` has a negative size")))?;
        let media_type = media_type.unwrap_or_else(|| "application/octet-stream".to_owned());
        let video = video_asset != 0
            || (variant.is_none() && media_type.trim().to_ascii_lowercase().starts_with("video/"));
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

    #[test]
    fn an_original_and_its_thumbnail_are_two_files_newest_first() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault.found("Household", "Ada").expect("founds");
        let original = PlaintextHash::from_hex(&crate::content::content_digest(b"a film"))
            .expect("a digest is a hash");
        let thumb = PlaintextHash::from_hex(&crate::content::content_digest(b"its poster"))
            .expect("a digest is a hash");
        let now = vault.clock().now_text();
        let (item, derivative, asset) =
            (vault.ids().next(), vault.ids().next(), vault.ids().next());
        vault
            .commit(|tx| {
                let connection = tx.connection();
                connection.execute(
                    "INSERT INTO core_content_item
                       (content_id, content_uri, content_hash, byte_size, created_at, updated_at)
                     VALUES (?1, 'blob:x', ?2, 9000, '2026-01-01T00:00:00Z', ?3)",
                    rusqlite::params![item, original.to_hex(), now],
                )?;
                connection.execute(
                    "INSERT INTO core_content_derivative
                       (derivative_id, content_id, variant, content_hash, media_type, byte_size,
                        created_at, updated_at)
                     VALUES (?1, ?2, 'poster', ?3, 'image/jpeg', 30, '2026-02-01T00:00:00Z', ?4)",
                    rusqlite::params![derivative, item, thumb.to_hex(), now],
                )?;
                connection.execute(
                    "INSERT INTO media_asset (asset_id, content_id, kind, created_at, updated_at)
                     VALUES (?1, ?2, 'video', ?3, ?3)",
                    rusqlite::params![asset, item, now],
                )?;
                Ok(())
            })
            .expect("commits");
        let files = content_files(&vault).expect("reads");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].h, thumb, "newest first");
        assert_eq!(files[0].variant.as_deref(), Some("poster"));
        assert!(!files[0].video, "a poster is a picture");
        assert_eq!(files[1].h, original);
        assert!(files[1].is_original() && files[1].video);
        assert_eq!(files[1].len, 9000);
    }
}
