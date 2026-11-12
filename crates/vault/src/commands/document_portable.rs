//! DOCS' ORIGINALS AS ONE ARCHIVE (#1185): `document.export_zip`, every document that is not in
//! the trash (all of them, or one folder's and the folders below it) as a stored zip written to
//! a file, never built in memory (owner decision D17).
//!
//! The archive has the folder structure the member sees: `Taxes/2026/Receipt.pdf`, a document at
//! the top level at the top of the archive. Every name is made safe first ([`file_name`]: no
//! separator, control character or reserved device name, short enough for any file system, the
//! extension kept), and a name that two documents share in one folder (compared without regard to
//! case) gets ` 2`, ` 3` before its extension, so nothing overwrites anything. A document and a
//! folder of one name in the same place cannot both be a path, so the folder takes ` folder`. Each original is copied from its file in the
//! content store through [`crate::portable::zip::ZipWriter`] in fixed-size chunks, so the memory
//! an export holds does not depend on how large the documents are.
//!
//! The zip is written to the store's staging folder ([`BlobStore::staging_dir`]), emptied first so
//! an earlier export (or one a crash left half written) never lingers; the shell deletes the file
//! once the save sheet is done with it. The command answers `{path, name, media_type, count,
//! missing, left_out}`: `count` is what went in, `missing` counts the documents the archive could
//! not include (their bytes are not on this phone, evicted or still to arrive, or the file could
//! not be read) and `left_out` names the first [`NAMED`] of them with the reason. The archive
//! itself carries `Left out.txt` naming every one, so nothing is skipped without a word. It
//! writes nothing to the vault.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufWriter, Seek, Write};
use std::path::Path;

use rusqlite::Connection;

use crate::bytes::BlobStore;
use crate::commands::document::{folder_refusal, no_store};
use crate::commands::note_portable::{file_name, file_stem};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::portable::zip::ZipWriter;

/// How many left-out items the command's answer names (the archive's `Left out.txt` names all).
const NAMED: usize = 20;

/// Why an original is not in the archive: its bytes are not on this phone.
pub(crate) const NOT_HERE: &str = "not on this phone";
/// Why an original is not in the archive: the file is there but cannot be read.
pub(crate) const UNREADABLE: &str = "could not be read";

/// An original an archive could not include: where it would have been, and why.
pub(crate) struct LeftOut {
    pub name: String,
    pub why: &'static str,
}

/// The command's answer for what was left out: `[{name, why}]`, the first [`NAMED`].
pub(crate) fn left_out_json(left: &[LeftOut]) -> serde_json::Value {
    left.iter()
        .take(NAMED)
        .map(|item| serde_json::json!({ "name": item.name, "why": item.why }))
        .collect()
}

/// `Left out.txt` into the archive, naming every original it could not include, or nothing when
/// none was left out. Returns whether it wrote the file.
pub(crate) fn add_left_out<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    left: &[LeftOut],
) -> Result<bool> {
    if left.is_empty() {
        return Ok(false);
    }
    let mut text = String::from("These originals could not be included in this archive.\n\n");
    for item in left {
        text.push_str(&format!("{} ({})\n", item.name, item.why));
    }
    zip.add("Left out.txt", text.len() as u64, text.as_bytes())?;
    Ok(true)
}

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
    unique_among(used, &BTreeSet::new(), path)
}

/// [`unique`], also avoiding a folder (`dirs`, lower-cased paths) of the same name.
fn unique_among(used: &mut BTreeSet<String>, dirs: &BTreeSet<String>, path: String) -> String {
    if !dirs.contains(&path.to_lowercase()) && used.insert(path.to_lowercase()) {
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
        if !dirs.contains(&candidate.to_lowercase()) && used.insert(candidate.to_lowercase()) {
            return candidate;
        }
    }
}

/// Rename a folder in `names` (the folders above a document) that has the path of a file already
/// in the archive, so a file and a folder never share a path: it takes ` folder`, then
/// ` folder 2`, and so on.
fn apart_from_files(used: &BTreeSet<String>, prefix: &str, names: &mut [String]) {
    for depth in 0..names.len() {
        let own = names[depth].clone();
        let mut again = 0;
        while used.contains(&format!("{prefix}{}", names[..=depth].join("/")).to_lowercase()) {
            again += 1;
            names[depth] = if again == 1 {
                format!("{own} folder")
            } else {
                format!("{own} folder {again}")
            };
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
        "SELECT e.n, e.title, d.blob, d.folder_id
           FROM entity e JOIN document d ON d.id = e.id
          WHERE e.kind = 'document' AND e.deleted_at IS NULL",
    )?;
    // Read through the entity index by kind, ordered here: the file keeps the order they were made.
    let mut rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                (
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.sort_by_key(|found| found.0);
    Ok(rows.into_iter().map(|(_, row)| row).collect())
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
        Ok((count, left)) => Ok(serde_json::json!({
            "path": target.to_string_lossy(),
            "name": format!("{archive_name}.zip"),
            "media_type": "application/zip",
            "count": count,
            "missing": left.len(),
            "left_out": left_out_json(&left),
        })),
        Err(error) => {
            // A half-written archive is plaintext nobody asked to keep.
            let _ = fs::remove_file(&target);
            Err(error)
        }
    }
}

/// The archive itself: each original streamed from the store's file. Returns how many went in
/// and the originals it could not include.
fn write_archive(
    blobs: &(dyn BlobStore + Send + Sync),
    target: &Path,
    folders: &BTreeMap<String, Folder>,
    scope: Option<&str>,
    documents: Vec<DocumentRow>,
) -> Result<(u64, Vec<LeftOut>)> {
    let mut zip = ZipWriter::new(BufWriter::new(File::create(target)?));
    let (added, left) = add_documents(&mut zip, blobs, folders, scope, documents, "")?;
    add_left_out(&mut zip, &left)?;
    zip.finish()?;
    Ok((added, left))
}

/// Stream each document's original into `zip` under `prefix` (empty, or a folder name ending in
/// `/`), in the folders the member sees. Returns how many went in and the originals it could not
/// include (bytes not on this phone, or a file that cannot be read), each named. The whole-vault
/// export writes the same entries under `Docs/`.
pub(crate) fn add_documents<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    blobs: &(dyn BlobStore + Send + Sync),
    folders: &BTreeMap<String, Folder>,
    scope: Option<&str>,
    documents: Vec<DocumentRow>,
    prefix: &str,
) -> Result<(u64, Vec<LeftOut>)> {
    let mut used: BTreeSet<String> = BTreeSet::new();
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    let mut added = 0_u64;
    let mut left: Vec<LeftOut> = Vec::new();
    for (title, blob, folder) in documents {
        let Some(mut names) = path_of(folders, folder.as_deref(), scope) else {
            continue;
        };
        let shown = format!(
            "{prefix}{}",
            [names.as_slice(), &[file_name(&title)]].concat().join("/")
        );
        let (path, why) = match blobs.path_of(&blob) {
            Ok(Some(path)) => (Some(path), UNREADABLE),
            Ok(None) => (None, NOT_HERE),
            Err(_) => (None, UNREADABLE),
        };
        let opened = path.and_then(|path| File::open(path).ok());
        let Some((file, size)) = opened.and_then(|file| {
            let size = file.metadata().ok()?.len();
            Some((file, size))
        }) else {
            left.push(LeftOut { name: shown, why });
            continue;
        };
        apart_from_files(&used, prefix, &mut names);
        for depth in 1..=names.len() {
            dirs.insert(format!("{prefix}{}", names[..depth].join("/")).to_lowercase());
        }
        names.push(file_name(&title));
        let name = unique_among(&mut used, &dirs, format!("{prefix}{}", names.join("/")));
        zip.add(&name, size, file)?;
        added += 1;
    }
    Ok((added, left))
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::io::Cursor;
    use std::path::PathBuf;

    use super::*;
    use crate::bytes::{BlobError, Result as BlobResult};
    use crate::portable::zip::stored_entries;

    /// A store that answers each id as the test says: a real file, one that is "there" but gone,
    /// none, or an error.
    struct Stub {
        real: PathBuf,
    }

    impl BlobStore for Stub {
        fn put(&self, _: &[u8]) -> BlobResult<String> {
            unimplemented!()
        }
        fn get(&self, _: &str) -> BlobResult<Vec<u8>> {
            unimplemented!()
        }
        fn has(&self, _: &str) -> BlobResult<bool> {
            unimplemented!()
        }
        fn ids(&self) -> BlobResult<BTreeSet<String>> {
            unimplemented!()
        }
        fn size(&self, _: &str) -> BlobResult<u64> {
            unimplemented!()
        }
        fn path_of(&self, id: &str) -> BlobResult<Option<PathBuf>> {
            match id {
                "far" => Ok(None),
                "vanished" => Ok(Some(self.real.with_file_name("vanished"))),
                "broken" => Err(BlobError::Io {
                    path: self.real.clone(),
                    source: std::io::Error::other("the disk said no"),
                }),
                _ => Ok(Some(self.real.clone())),
            }
        }
    }

    fn folders(list: &[(&str, &str, Option<&str>)]) -> BTreeMap<String, Folder> {
        list.iter()
            .map(|(id, name, parent)| {
                (
                    (*id).to_owned(),
                    Folder {
                        name: (*name).to_owned(),
                        parent: parent.map(str::to_owned),
                    },
                )
            })
            .collect()
    }

    fn run(
        folders: &BTreeMap<String, Folder>,
        documents: &[(&str, &str, Option<&str>)],
    ) -> (Vec<String>, Vec<LeftOut>) {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("bytes");
        fs::write(&real, b"original").unwrap();
        let store = Stub { real };
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let rows = documents
            .iter()
            .map(|(title, blob, folder)| {
                (
                    (*title).to_owned(),
                    (*blob).to_owned(),
                    folder.map(str::to_owned),
                )
            })
            .collect();
        let (_, left) = add_documents(&mut zip, &store, folders, None, rows, "").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let names = stored_entries(&bytes)
            .unwrap()
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        (names, left)
    }

    #[test]
    fn every_name_in_the_archive_is_safe_and_the_extension_survives() {
        let long = format!("{}.pdf", "x".repeat(400));
        let (names, _) = run(
            &BTreeMap::new(),
            &[
                ("../../etc/passwd", "a", None),
                ("tab\there.txt", "a", None),
                ("CON.txt", "a", None),
                ("nul", "a", None),
                ("Trailing dot. ", "a", None),
                ("..", "a", None),
                (long.as_str(), "a", None),
            ],
        );
        for name in &names {
            assert!(
                name.split('/').all(|part| !matches!(part, "" | "." | "..")),
                "{name}"
            );
            assert!(!name.chars().any(char::is_control), "{name}");
            assert!(name.len() <= 205, "{name}");
        }
        assert!(names.contains(&"tab-here.txt".to_owned()), "{names:?}");
        assert!(names.contains(&"CON_.txt".to_owned()), "{names:?}");
        assert!(names.contains(&"nul_".to_owned()), "{names:?}");
        assert!(names.contains(&"Trailing dot".to_owned()), "{names:?}");
        assert!(names.contains(&"Untitled".to_owned()), "{names:?}");
        assert!(
            names
                .iter()
                .any(|name| name.ends_with(".pdf") && name.starts_with("xxx"))
        );
    }

    #[test]
    fn a_folder_name_is_made_safe_too_and_a_slash_in_a_title_is_not_a_folder() {
        let tree = folders(&[("f", "Bad:name?", None), ("g", "AUX", Some("f"))]);
        let (names, _) = run(&tree, &[("a/b.pdf", "a", Some("g"))]);
        assert_eq!(names, ["Bad-name-/AUX_/a-b.pdf"]);
    }

    #[test]
    fn names_that_collide_in_one_folder_get_a_distinct_suffix_whatever_their_case() {
        let tree = folders(&[("f", "Taxes", None)]);
        let (names, _) = run(
            &tree,
            &[
                ("A.pdf", "a", Some("f")),
                ("a.PDF", "a", Some("f")),
                ("A.pdf", "a", Some("f")),
                ("A.pdf", "a", None),
                // Two titles that only collide once they are made safe.
                ("x/y.txt", "a", None),
                ("x:y.txt", "a", None),
            ],
        );
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(
            sorted,
            [
                "A.pdf",
                "Taxes/A 3.pdf",
                "Taxes/A.pdf",
                "Taxes/a 2.PDF",
                "x-y 2.txt",
                "x-y.txt",
            ]
        );
        let lower: BTreeSet<String> = names.iter().map(|name| name.to_lowercase()).collect();
        assert_eq!(lower.len(), names.len(), "no two paths are one file");
    }

    #[test]
    fn a_file_and_a_folder_of_one_name_never_share_a_path() {
        let tree = folders(&[("f", "Taxes", None)]);
        // The file first, then a document inside the folder of the same name.
        let (names, _) = run(&tree, &[("Taxes", "a", None), ("In.pdf", "a", Some("f"))]);
        assert_eq!(names, ["Taxes", "Taxes folder/In.pdf"]);
        // The folder first, then a file of the folder's name.
        let (names, _) = run(&tree, &[("In.pdf", "a", Some("f")), ("taxes", "a", None)]);
        assert_eq!(names, ["Taxes/In.pdf", "taxes 2"]);
    }

    #[test]
    fn an_original_that_cannot_be_included_is_named_with_its_reason() {
        let tree = folders(&[("f", "Taxes", None)]);
        let (names, left) = run(
            &tree,
            &[
                ("Here.pdf", "ok", None),
                ("Far.pdf", "far", Some("f")),
                ("Gone.pdf", "vanished", None),
                ("Broken.pdf", "broken", None),
            ],
        );
        assert_eq!(names, ["Here.pdf"]);
        let shown: Vec<(&str, &str)> = left
            .iter()
            .map(|item| (item.name.as_str(), item.why))
            .collect();
        assert_eq!(
            shown,
            [
                ("Taxes/Far.pdf", NOT_HERE),
                ("Gone.pdf", UNREADABLE),
                ("Broken.pdf", UNREADABLE),
            ]
        );
    }
}
