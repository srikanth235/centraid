//! DOCS' ORIGINALS AS ONE ARCHIVE (#1185): `document.export_zip`, every document that is not in
//! the trash (all of them, or one folder's and the folders below it) as a stored zip written to
//! a file, never built in memory (owner decision D17).
//!
//! The archive has the folder structure the member sees: `Taxes/2026/Receipt.pdf`, a document at
//! the top level at the top of the archive. A name that two documents share gets ` 2`, ` 3` before
//! its extension, so nothing overwrites anything. Each original is copied from its file in the
//! content store through [`crate::portable::zip::ZipWriter`] in fixed-size chunks, so the memory
//! an export holds does not depend on how large the documents are.
//!
//! The zip is written to the store's staging folder ([`BlobStore::staging_dir`]), emptied first so
//! an earlier export (or one a crash left half written) never lingers; the shell deletes the file
//! once the save sheet is done with it. The command answers `{path, name, media_type, count,
//! missing}`: `missing` counts documents whose bytes are not on this phone (evicted, or still to
//! arrive), which the archive leaves out. It writes nothing to the vault.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufWriter, Seek, Write};
use std::path::Path;

use rusqlite::Connection;

use crate::bytes::BlobStore;
use crate::commands::document::{folder_refusal, no_store};
use crate::commands::note_portable::file_stem;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::portable::zip::ZipWriter;

/// How far up a folder chain is followed before it is taken for a cycle.
const DEPTH: usize = 64;

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
    folder_refusal(ctx)
}

/// A live folder: its name and the folder it is in.
pub(crate) struct Folder {
    name: String,
    parent: Option<String>,
}

/// The names from `scope` (exclusive; the top when none) down to `folder`, top first, or `None`
/// when the chain passes a folder that is in the trash (or never reaches `scope`).
fn path_of(
    folders: &BTreeMap<String, Folder>,
    folder: Option<&str>,
    scope: Option<&str>,
) -> Option<Vec<String>> {
    let mut names = Vec::new();
    let mut at = folder;
    for _ in 0..DEPTH {
        let Some(id) = at else {
            return scope.is_none().then(|| {
                names.reverse();
                names
            });
        };
        if Some(id) == scope {
            names.reverse();
            return Some(names);
        }
        let found = folders.get(id)?;
        names.push(file_stem(&found.name));
        at = found.parent.as_deref();
    }
    None
}

/// `path` made unique among `used` (compared without regard to case) by ` 2`, ` 3` before the
/// extension.
pub(crate) fn unique(used: &mut BTreeSet<String>, path: String) -> String {
    if used.insert(path.to_lowercase()) {
        return path;
    }
    let (folder, name) = path
        .rsplit_once('/')
        .map_or(("", path.as_str()), |(f, n)| (f, n));
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    let mut again = 1;
    loop {
        again += 1;
        let candidate = if folder.is_empty() {
            format!("{stem} {again}{extension}")
        } else {
            format!("{folder}/{stem} {again}{extension}")
        };
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
    }
}

/// Empty the staging folder: a file an earlier export left is plaintext that must not linger.
pub(crate) fn clear(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            fs::remove_dir_all(&path)?;
        } else {
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// Every live folder by id.
pub(crate) fn live_folders(connection: &Connection) -> Result<BTreeMap<String, Folder>> {
    let mut folders: BTreeMap<String, Folder> = BTreeMap::new();
    {
        let mut statement = connection.prepare_cached(
            "SELECT e.id, e.title, c.parent_id
               FROM container c JOIN entity e ON e.id = c.id
              WHERE c.kind = 'folder' AND e.deleted_at IS NULL",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Folder {
                    name: row.get(1)?,
                    parent: row.get(2)?,
                },
            ))
        })?;
        for row in rows {
            let (id, folder) = row?;
            folders.insert(id, folder);
        }
    }
    Ok(folders)
}

/// Every live document: its title, its blob and its folder, in the order it was made.
pub(crate) fn live_documents(connection: &Connection) -> Result<Vec<DocumentRow>> {
    let mut statement = connection.prepare_cached(
        "SELECT e.title, d.blob, d.folder_id
           FROM document d JOIN entity e ON e.id = d.id
          WHERE e.deleted_at IS NULL
          ORDER BY e.n",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// A document to write: its title, its blob's hash and the folder it is in.
pub(crate) type DocumentRow = (String, String, Option<String>);

/// `document.export_zip`: see the module header.
fn export_zip(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let (Some(blobs), connection) = (ctx.blobs(), ctx.connection()) else {
        return Err(VaultError::Invariant {
            context: "document.export_zip ran without a content store".to_owned(),
        });
    };
    let Some(staging) = blobs.staging_dir() else {
        return Err(VaultError::Invariant {
            context: "document.export_zip ran without a staging folder".to_owned(),
        });
    };
    let scope = ctx.optional_str("folder_id");

    let folders = live_folders(connection)?;
    let archive_name = scope
        .and_then(|id| folders.get(id))
        .map_or_else(|| "Documents".to_owned(), |folder| file_stem(&folder.name));

    let documents = live_documents(connection)?;

    clear(&staging)?;
    let target = staging.join("export.zip");
    let written = write_archive(blobs, &target, &folders, scope, documents);
    match written {
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
    folders: &BTreeMap<String, Folder>,
    scope: Option<&str>,
    documents: Vec<DocumentRow>,
) -> Result<(u64, u64)> {
    let mut zip = ZipWriter::new(BufWriter::new(File::create(target)?));
    let (added, missing) = add_documents(&mut zip, blobs, folders, scope, documents, "")?;
    zip.finish()?;
    Ok((added, missing))
}

/// Stream each document's original into `zip` under `prefix` (empty, or a folder name ending in
/// `/`), in the folders the member sees. Returns how many went in and how many were not on this
/// phone. The whole-vault export writes the same entries under `Docs/`.
pub(crate) fn add_documents<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    blobs: &(dyn BlobStore + Send + Sync),
    folders: &BTreeMap<String, Folder>,
    scope: Option<&str>,
    documents: Vec<DocumentRow>,
    prefix: &str,
) -> Result<(u64, u64)> {
    let mut used: BTreeSet<String> = BTreeSet::new();
    let mut added = 0_u64;
    let mut missing = 0_u64;
    for (title, blob, folder) in documents {
        let Some(mut names) = path_of(folders, folder.as_deref(), scope) else {
            continue;
        };
        let located = blobs
            .path_of(&blob)
            .map_err(|error| VaultError::Invariant {
                context: format!("the content store would not say where a document is: {error}"),
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
        names.push(file_stem(&title));
        let name = unique(&mut used, format!("{prefix}{}", names.join("/")));
        zip.add(&name, size, file)?;
        added += 1;
    }
    Ok((added, missing))
}

const SCHEMA: &str = r#"{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "folder_id": { "type": ["string", "null"] }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const EXPORT: &[CommandCondition] = &[CommandCondition {
        predicate: "document_export_has_a_store_a_staging_folder_and_a_folder_that_exists",
        check: pre_export,
    }];
    vec![CommandDefinition::plain(
        "document.export_zip",
        "document",
        SCHEMA,
        Idempotency::Idempotent,
        EXPORT,
        export_zip,
    )]
}
