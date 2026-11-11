//! PHOTOS' ORIGINALS AS ONE ARCHIVE (#1185): `photo.export_zip`, every photograph and video that
//! is not in the trash (all of them, or one album's) as a stored zip written to a file, never
//! built in memory (owner decision D17).
//!
//! The archive holds the ORIGINAL bytes of each photograph (the blob the photograph is over, never
//! a thumbnail or another rendition), named by when it was taken: `2025/2025-07-01 123000.jpg`.
//! The time is the capture time on the clock where it was taken (the stored time plus the stored
//! offset), or the day it was imported when the file says none. Two photographs with the same
//! second get ` 2`, ` 3` before the extension, so nothing overwrites anything. An edit is its own
//! photograph in the library, so it is its own file; the archive carries no edit instructions
//! and does not rewrite a place (the file is exactly what was stored).
//!
//! The zip is written to the store's staging folder ([`BlobStore::staging_dir`]), emptied first;
//! the shell deletes the file once the save sheet is done with it. The command answers `{path,
//! name, media_type, count, missing}`: `missing` counts photographs whose bytes are not on this
//! phone (freed up, or still to arrive), which the archive leaves out. It writes nothing to the
//! vault.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufWriter, Seek, Write};
use std::path::Path;

use rusqlite::Connection;

use crate::bytes::BlobStore;
use crate::commands::document::no_store;
use crate::commands::document_portable::{clear, unique};
use crate::commands::entity::lookup_live;
use crate::commands::note_portable::file_stem;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::Kind;
use crate::portable::zip::ZipWriter;

/// Where the archive goes, or why it cannot.
fn pre_export(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = no_store(ctx) {
        return Ok(Some(sentence));
    }
    if ctx.blobs().and_then(BlobStore::staging_dir).is_none() {
        return Ok(Some(
            "this vault has nowhere to stage a file for export".to_owned(),
        ));
    }
    let Some(id) = ctx.optional_str("album_id") else {
        return Ok(None);
    };
    Ok(match lookup_live(ctx.connection(), id)? {
        Err(sentence) => Some(sentence),
        Ok(found) if found.kind != Kind::Album => Some(format!(
            "“{}” is a {}, not an album",
            found.title,
            found.kind.noun()
        )),
        Ok(_) => None,
    })
}

/// The extension a file of this media type is saved with.
fn extension_of(media_type: &str) -> &'static str {
    match media_type.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "image/avif" => "avif",
        "image/tiff" => "tiff",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "image/x-adobe-dng" | "image/dng" => "dng",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/x-matroska" => "mkv",
        "video/3gpp" => "3gp",
        "video/mpeg" => "mpg",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

/// One photograph to write: its bytes' hash, its media type and its stamp (`YYYY-MM-DD HHMMSS`).
pub(crate) struct Item {
    blob: String,
    media_type: String,
    stamp: Option<String>,
}

/// Every live photograph (or one album's) in the order it was taken.
pub(crate) fn live_photos(connection: &Connection, album: Option<&str>) -> Result<Vec<Item>> {
    // The capture time on the clock where it was taken (SQLite does the date arithmetic), else
    // the day the photograph was imported.
    let mut statement = connection.prepare_cached(
        "SELECT p.blob, p.media_type,
                strftime('%Y-%m-%d %H%M%S', COALESCE(p.taken_at, e.created_at),
                         printf('%+d minutes', CASE WHEN p.taken_at IS NULL
                                                    THEN 0 ELSE COALESCE(p.offset_min, 0) END))
           FROM photo p JOIN entity e ON e.id = p.id
          WHERE e.deleted_at IS NULL
            AND (?1 IS NULL OR EXISTS (SELECT 1 FROM edge m
                                        WHERE m.from_id = ?1 AND m.rel = 'contains'
                                          AND m.to_id = p.id))
          ORDER BY COALESCE(p.taken_at, e.created_at), e.n",
    )?;
    let items = statement
        .query_map([album], |row| {
            Ok(Item {
                blob: row.get(0)?,
                media_type: row.get(1)?,
                stamp: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(items)
}

/// `photo.export_zip`: see the module header.
fn export_zip(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let (Some(blobs), connection) = (ctx.blobs(), ctx.connection()) else {
        return Err(VaultError::Invariant {
            context: "photo.export_zip ran without a content store".to_owned(),
        });
    };
    let Some(staging) = blobs.staging_dir() else {
        return Err(VaultError::Invariant {
            context: "photo.export_zip ran without a staging folder".to_owned(),
        });
    };
    let album = ctx.optional_str("album_id");
    let archive_name = match album {
        Some(id) => {
            connection.query_row("SELECT title FROM entity WHERE id = ?1", [id], |row| {
                row.get::<_, String>(0)
            })?
        }
        None => "Photos".to_owned(),
    };
    let archive_name = match file_stem(&archive_name) {
        name if name.is_empty() => "Photos".to_owned(),
        name => name,
    };

    let items = live_photos(connection, album)?;

    clear(&staging)?;
    let target = staging.join("export.zip");
    match write_archive(blobs, &target, items) {
        Ok((count, missing)) => Ok(serde_json::json!({
            "path": target.to_string_lossy(),
            "name": format!("{archive_name}.zip"),
            "media_type": "application/zip",
            "count": count,
            "missing": missing,
        })),
        Err(error) => {
            // A half-written archive is plaintext nobody asked to keep.
            let _ = fs::remove_file(&target);
            Err(error)
        }
    }
}

/// The archive itself: each original streamed from the store's file. Returns how many went in
/// and how many were not on this phone.
fn write_archive(
    blobs: &(dyn BlobStore + Send + Sync),
    target: &Path,
    items: Vec<Item>,
) -> Result<(u64, u64)> {
    let mut zip = ZipWriter::new(BufWriter::new(File::create(target)?));
    let (added, missing) = add_photos(&mut zip, blobs, items, "")?;
    zip.finish()?;
    Ok((added, missing))
}

/// Stream each photograph's original into `zip` under `prefix` (empty, or a folder name ending in
/// `/`), named by when it was taken. Returns how many went in and how many were not on this
/// phone. The whole-vault export writes the same entries under `Photos/`.
pub(crate) fn add_photos<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    blobs: &(dyn BlobStore + Send + Sync),
    items: Vec<Item>,
    prefix: &str,
) -> Result<(u64, u64)> {
    let mut used: BTreeSet<String> = BTreeSet::new();
    let mut added = 0_u64;
    let mut missing = 0_u64;
    for item in items {
        let located = blobs
            .path_of(&item.blob)
            .map_err(|error| VaultError::Invariant {
                context: format!("the content store would not say where a photograph is: {error}"),
            })?;
        let Some(path) = located else {
            missing += 1;
            continue;
        };
        let Ok(file) = File::open(&path) else {
            missing += 1;
            continue;
        };
        let size = file.metadata()?.len();
        let extension = extension_of(&item.media_type);
        let name = match item.stamp {
            Some(stamp) => format!("{}/{stamp}.{extension}", stamp.get(..4).unwrap_or("0000")),
            None => format!(
                "Undated/{}.{extension}",
                item.blob.chars().take(12).collect::<String>()
            ),
        };
        let name = unique(&mut used, format!("{prefix}{name}"));
        zip.add(&name, size, file)?;
        added += 1;
    }
    Ok((added, missing))
}

const SCHEMA: &str = r#"{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "album_id": { "type": ["string", "null"] }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const EXPORT: &[CommandCondition] = &[CommandCondition {
        predicate: "photo_export_has_a_store_a_staging_folder_and_an_album_that_exists",
        check: pre_export,
    }];
    vec![CommandDefinition::plain(
        "photo.export_zip",
        "photo",
        SCHEMA,
        Idempotency::Idempotent,
        EXPORT,
        export_zip,
    )]
}
