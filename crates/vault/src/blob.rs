//! The blob plane: the vault's claim on bytes, and what is derived from them.
//!
//! A `blob` row is the vault's claim on bytes the content store names by the
//! same BLAKE3 hash ([`content_digest`]); a `derivative` is something computed
//! from a blob (a thumbnail, extracted text, a caption). Nothing else in the
//! vault holds a hash: every column that does is a foreign key into
//! `blob(hash)`, so
//!
//! - **the engine refuses to delete a referenced blob**, and a trashed
//!   document's bytes survive until its purge, because trash keeps references
//!   alive;
//! - **garbage collection is one question** ([`Vault::collect_blobs`]): which
//!   blob does no foreign key name? It is asked of `PRAGMA foreign_key_list`
//!   over every table, so nothing keeps a list of renting columns, and a new
//!   table that rents a blob is collected correctly the day it is created
//!   ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//!
//! A reference that *cascades* does not keep its target alive (a derivative
//! does not keep the original it was cut from); only a plain reference does.

use rusqlite::Connection;

use crate::bytes::Located;
use crate::error::{Result, VaultError};
use crate::file::Vault;

/// The BLAKE3 hash of some bytes, as the 64 lowercase hex characters `blob.hash` holds.
#[must_use]
pub fn content_digest(bytes: &[u8]) -> String {
    hex::encode(blake3::hash(bytes).as_bytes())
}

/// Whether this is the spelling of a hash `blob.hash` accepts.
#[must_use]
pub fn is_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Media types a surface must never EMBED, whatever else is known about them:
/// each can carry script that would run with the app's own reach.
pub const NEVER_INLINE: [&str; 3] = ["text/html", "application/xhtml+xml", "image/svg+xml"];

/// The media type with its parameters stripped and lowercased.
///
/// `text/html; charset=utf-8` is `text/html`, and a comparison that missed the
/// parameter would let the one type [`NEVER_INLINE`] exists for through.
#[must_use]
pub fn base_media_type(media_type: &str) -> String {
    media_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// Whether this media type may ever be served inline.
#[must_use]
pub fn may_serve_inline(media_type: &str) -> bool {
    !media_type.is_empty() && !NEVER_INLINE.contains(&base_media_type(media_type).as_str())
}

/// Bytes this device holds, declared by whoever is staging them: the hash is
/// verified absolutely by the store that wrote them, the size is the caller's
/// reading of its own bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeededBytes {
    /// 64 lowercase hex: the BLAKE3 root hash.
    pub hash: String,
    pub byte_size: i64,
}

/// A derivative the shell rendered and this device holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedDerivative {
    /// The derivative's own hash, 64 lowercase hex.
    pub hash: String,
    pub byte_size: i64,
    pub media_type: String,
    /// `thumb`, `preview` or `poster`.
    pub variant: String,
    /// The hash of the original it was rendered from.
    pub variant_of: String,
}

/// Where one blob's bytes are, and how its reader reads them.
///
/// At most one of [`Self::path`] and [`Self::os_ref`] is set: the bytes are in
/// the app's own store, or in the operating system's library, or not on this
/// device at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobLocation {
    pub hash: String,
    /// The file, when this device's content store holds the bytes.
    pub path: Option<std::path::PathBuf>,
    /// The operating system library's identifier for the bytes, when the
    /// library holds them and the store does not (#1080 ruling 6). Only the
    /// shell can open it.
    pub os_ref: Option<String>,
    /// What the reader said these bytes are.
    pub media_type: String,
    pub byte_size: i64,
    /// Whether a surface may EMBED this rather than only offer it.
    pub embeddable: bool,
    /// A member-facing sentence, set only when the bytes are on no path and
    /// in no library.
    pub absent_reason: String,
}

/// Claim these bytes, if they are not claimed already. Returns whether a row
/// was added.
///
/// # Errors
/// [`VaultError::InvalidInput`] for a hash that is not 64 lowercase hex, a
/// negative size, or a hash already claimed at another size (the same bytes
/// have one size).
pub fn stage(connection: &Connection, hash: &str, size: i64) -> Result<bool> {
    if !is_hash(hash) {
        return Err(VaultError::InvalidInput {
            name: "hash".to_owned(),
            detail: "a content hash is 64 lowercase hex characters".to_owned(),
        });
    }
    if size < 0 {
        return Err(VaultError::InvalidInput {
            name: "size".to_owned(),
            detail: "bytes cannot have a negative size".to_owned(),
        });
    }
    let held: Option<i64> = connection
        .query_row("SELECT size FROM blob WHERE hash = ?1", [hash], |row| {
            row.get(0)
        })
        .ok();
    match held {
        Some(held) if held != size => Err(VaultError::InvalidInput {
            name: "size".to_owned(),
            detail: format!("these bytes are already held at {held} bytes, not {size}"),
        }),
        Some(_) => Ok(false),
        None => {
            connection.execute(
                "INSERT INTO blob (hash, size) VALUES (?1, ?2)",
                rusqlite::params![hash, size],
            )?;
            Ok(true)
        }
    }
}

/// Write a derivative of a blob, replacing the variant's earlier one.
///
/// `out` is the derivative's own bytes, claimed here with their size; a
/// derivative that is text, a caption or a hash is stored in the row and has
/// none.
///
/// # Errors
/// [`VaultError::InvalidInput`] when the blob it is of is not claimed yet.
pub fn write_derivative(
    connection: &Connection,
    now: &str,
    blob: &str,
    variant: &str,
    out: Option<(&str, i64, &str)>,
    text: Option<&str>,
) -> Result<()> {
    let known: i64 =
        connection.query_row("SELECT COUNT(*) FROM blob WHERE hash = ?1", [blob], |row| {
            row.get(0)
        })?;
    if known == 0 {
        return Err(VaultError::InvalidInput {
            name: "blob".to_owned(),
            detail: "the bytes this is derived from are not held here yet".to_owned(),
        });
    }
    if let Some((hash, size, _)) = out {
        stage(connection, hash, size)?;
    }
    connection.execute(
        "INSERT OR REPLACE INTO derivative (blob, variant, out, media_type, text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            blob,
            variant,
            out.map(|(hash, _, _)| hash),
            out.map(|(_, _, media_type)| media_type),
            text,
            now
        ],
    )?;
    Ok(())
}

/// Every `(table, column)` that holds a hash: the foreign keys into `blob(hash)`,
/// read from the file, with whether the reference keeps its target alive.
///
/// The one fact the plane is built on. A reference that cascades does not keep
/// a blob alive; a plain one does.
pub fn references(connection: &Connection) -> Result<Vec<BlobReference>> {
    let tables: Vec<String> = connection
        .prepare(
            "SELECT name FROM sqlite_master
              WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'
                AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
              ORDER BY name",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut found = Vec::new();
    for table in tables {
        // `PRAGMA foreign_key_list`: id, seq, table, from, to, on_update, on_delete, match.
        let mut statement = connection.prepare(&format!(
            "PRAGMA foreign_key_list({})",
            crate::log::quoted(&table)
        ))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (target, column, on_delete) in rows {
            if target == "blob" {
                found.push(BlobReference {
                    table: table.clone(),
                    column,
                    keeps_alive: on_delete != "CASCADE",
                });
            }
        }
    }
    Ok(found)
}

/// One column that holds a hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobReference {
    pub table: String,
    pub column: String,
    /// Whether a row here stops its blob being collected.
    pub keeps_alive: bool,
}

/// Delete every blob no foreign key keeps alive; returns the hashes, so the
/// caller can delete the bytes the store holds under them.
///
/// Repeats until a pass finds none: a blob collected can take its derivatives
/// with it (the reference cascades), and those derivatives' own bytes are then
/// unreferenced in their turn.
pub fn collect(connection: &Connection) -> Result<Vec<String>> {
    let keeping: Vec<BlobReference> = references(connection)?
        .into_iter()
        .filter(|reference| reference.keeps_alive)
        .collect();
    let unclaimed = keeping
        .iter()
        .map(|r| {
            format!(
                "NOT EXISTS (SELECT 1 FROM {} WHERE {} = b.hash)",
                crate::log::quoted(&r.table),
                crate::log::quoted(&r.column)
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!("SELECT hash FROM blob b WHERE {unclaimed} ORDER BY hash");
    let mut collected = Vec::new();
    loop {
        let doomed: Vec<String> = connection
            .prepare(&sql)?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<_>>()?;
        if doomed.is_empty() {
            return Ok(collected);
        }
        for hash in &doomed {
            connection.execute("DELETE FROM blob WHERE hash = ?1", [hash])?;
        }
        collected.extend(doomed);
    }
}

impl Vault {
    /// Claim bytes this device now HOLDS, so the command that names them can
    /// point a row at them.
    ///
    /// Idempotent: a hash already claimed is left as it is. Returns how many
    /// rows were added.
    pub fn stage_bytes(&self, staged: &[NeededBytes]) -> Result<usize> {
        if staged.is_empty() {
            return Ok(0);
        }
        let outcome = self.commit(|tx| {
            tx.set_producer("blob.stage");
            let mut added = 0usize;
            for need in staged {
                added += usize::from(stage(tx.connection(), &need.hash, need.byte_size)?);
            }
            Ok(added)
        })?;
        Ok(outcome.value)
    }

    /// The derivatives the vault has rows for, of the blob `original`:
    /// `(variant, the derivative's own hash)`, a thumbnail and a preview. A
    /// restored vault holds every one of these with the rows it came back in,
    /// so a shell that streams the original again need not render them.
    pub fn derivatives_of(&self, original: &str) -> Result<Vec<(String, String)>> {
        self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT variant, out FROM derivative
                  WHERE blob = ?1 AND variant IN ('thumb', 'preview') AND out IS NOT NULL
                  ORDER BY variant",
            )?;
            let rows = statement
                .query_map([original], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Record a DERIVATIVE the shell rendered and this device now holds: a
    /// thumbnail, a preview or a poster of the blob `variant_of` names. The
    /// platform decoder renders what the Rust fallback cannot (HEIC, RAW, a
    /// video's poster), so the shell renders and stages it and the core keeps
    /// it as its own file, sealed like any other. One variant holds one file.
    ///
    /// # Errors
    /// [`VaultError::InvalidInput`] for a variant that is not `thumb`,
    /// `preview` or `poster`, a malformed hash, or an original not held yet.
    pub fn stage_derivative(&self, derivative: &StagedDerivative) -> Result<()> {
        if !matches!(derivative.variant.as_str(), "thumb" | "preview" | "poster") {
            return Err(VaultError::InvalidInput {
                name: "tier".to_owned(),
                detail: format!("`{}` is not thumb, preview or poster", derivative.variant),
            });
        }
        let now = self.clock().now_text();
        self.commit(|tx| {
            tx.set_producer("derivative.write");
            write_derivative(
                tx.connection(),
                &now,
                &derivative.variant_of,
                &derivative.variant,
                Some((
                    &derivative.hash,
                    derivative.byte_size,
                    &derivative.media_type,
                )),
                None,
            )?;
            for owner in owners_of_blob(tx.connection(), &derivative.variant_of)? {
                tx.mark_for_index(&owner);
            }
            Ok(())
        })?;
        Ok(())
    }

    /// Collect the blobs nothing names ([`collect`]), in a commit of their own.
    /// Returns the hashes; deleting their bytes from the store is the caller's.
    pub fn collect_blobs(&self) -> Result<Vec<String>> {
        Ok(self
            .commit(|tx| {
                tx.set_producer("blob.collect");
                collect(tx.connection())
            })?
            .value)
    }

    /// Locate the bytes a grid cell or a row stands for, by what the grid has:
    /// the id of a photograph or a document, or a blob's own hash.
    ///
    /// The media type is the row's, or (for a bare hash) the one of whatever
    /// rents the bytes, so a reader that only holds an id still learns whether it
    /// may embed them. An id that is neither is a state, not a fault: "this item
    /// is not here".
    pub fn content_location(&self, id: &str) -> Result<BlobLocation> {
        let found: Option<(String, String)> = self.read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT blob, media_type FROM photo WHERE id = ?1
                     UNION ALL SELECT blob, media_type FROM document WHERE id = ?1
                     UNION ALL SELECT b.hash,
                          COALESCE((SELECT media_type FROM derivative WHERE out = b.hash LIMIT 1),
                                   (SELECT media_type FROM photo WHERE blob = b.hash),
                                   (SELECT media_type FROM document WHERE blob = b.hash LIMIT 1),
                                   '')
                       FROM blob b WHERE b.hash = ?1
                     LIMIT 1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok())
        })?;
        match found {
            Some((hash, media_type)) => {
                let mut location = self.blob_location(&hash, &media_type)?;
                location.hash = id.to_owned();
                Ok(location)
            }
            None => Ok(BlobLocation {
                hash: id.to_owned(),
                path: None,
                os_ref: None,
                media_type: String::new(),
                byte_size: 0,
                embeddable: false,
                absent_reason: "Centraid does not have this item.".to_owned(),
            }),
        }
    }

    /// Locate one blob's bytes for the reader that knows what they are.
    ///
    /// Never an `Err` for "the bytes are not here": that is a state a grid
    /// draws, with a sentence, and a failed read would take a whole screenful
    /// down over one missing cell. `Err` is reserved for the vault itself being
    /// unreadable.
    pub fn blob_location(&self, hash: &str, media_type: &str) -> Result<BlobLocation> {
        let size: Option<i64> = self.read(|connection| {
            Ok(connection
                .query_row("SELECT size FROM blob WHERE hash = ?1", [hash], |row| {
                    row.get(0)
                })
                .ok())
        })?;
        let embeddable = may_serve_inline(media_type);
        let absent = |reason: &str| BlobLocation {
            hash: hash.to_owned(),
            path: None,
            os_ref: None,
            media_type: media_type.to_owned(),
            byte_size: 0,
            embeddable,
            absent_reason: reason.to_owned(),
        };
        let Some(byte_size) = size else {
            // "Not in this vault" rather than "not on this device": a phone
            // missing the ROW is a different problem from one missing the
            // bytes, and telling a member to wait for a sync that will never
            // mention it is worse than saying nothing.
            return Ok(absent("Centraid does not have this item."));
        };
        let Some(blobs) = self.blobs() else {
            return Ok(absent("This copy of Centraid has no file store."));
        };
        let held = |path, os_ref| BlobLocation {
            hash: hash.to_owned(),
            path,
            os_ref,
            media_type: media_type.to_owned(),
            byte_size,
            embeddable,
            absent_reason: String::new(),
        };
        match blobs.locate(hash) {
            Ok(Located::Store(path)) => Ok(held(Some(path), None)),
            // THE LIBRARY HOLDS IT, and the phone never copied it in (#1080
            // ruling 6): the bytes are on this device, so nothing is absent;
            // the shell opens them by the library's own identifier.
            Ok(Located::OsLibrary(os_ref)) => Ok(held(None, Some(os_ref))),
            // A ROW WITHOUT ITS BYTES ON THIS DEVICE is a state, not a fault: a
            // restored phone shows its grid before it fetches an original.
            Ok(Located::Nowhere) => Ok(absent("This file has not reached this device yet.")),
            Err(error) => {
                // The store itself is unhappy: a corrupt blob, a permission.
                // Logged with its detail and reported without it, because a
                // store's words are not a member's.
                tracing::warn!("the content store could not answer for {hash}: {error}");
                Ok(absent("Centraid could not open this file."))
            }
        }
    }
}

/// The entities whose search text a blob's derivatives are part of: the
/// documents and photographs whose bytes it is.
pub(crate) fn owners_of_blob(connection: &Connection, hash: &str) -> Result<Vec<String>> {
    Ok(connection
        .prepare_cached(
            "SELECT id FROM document WHERE blob = ?1 UNION SELECT id FROM photo WHERE blob = ?1",
        )?
        .query_map([hash], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
