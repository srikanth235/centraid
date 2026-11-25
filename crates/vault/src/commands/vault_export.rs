//! EVERYTHING ON THIS PHONE AS ONE ARCHIVE (#1185): `vault.export_all`, a stored zip with one
//! folder per app, written to a file and never built in memory (owner decision D17).
//!
//! | Folder | What is in it | Written by |
//! |---|---|---|
//! | `Notes/` | the Markdown tree, a folder per notebook; a journal entry is a note with its day in the front matter | [`note::markdown_entries`] |
//! | `People/people.vcf` | everyone, including the member, as vCards | [`person::vcard_file_for_vault`] |
//! | `Calendar/calendar.ics` | every event | [`event_portable::calendar_text`] |
//! | `Reminders/reminders.ics` | every reminder | [`task_portable::reminders_text`] |
//! | `Money/transactions.csv` | every transaction | [`txn_portable::transactions_csv`] |
//! | `Health/` | `Daily totals.csv`, `Workouts.csv`, `Readings.csv` | [`health_portable`] |
//! | `Docs/` | the originals, in the member's folders | [`document_portable::add_documents`] |
//! | `Photos/` | the originals, named by when they were taken | [`photo_portable::add_photos`] |
//!
//! The aggregate includes the member's own card as well as each app's portable data.
//! Originals are streamed from the content store's files in fixed-size chunks, never read into
//! memory. A `README.txt` at the top says what each folder is.
//!
//! **LOCKER IS NOT IN IT** (owner decision D11): a Locker item's contents leave the phone only
//! through Locker's own export, which asks for its own, stricter owner check. Nothing here reads
//! a Locker table. The aggregate adds the member's own card because it is part of the member's own
//! data; the individual People export leaves it out.
//!
//! The zip is written to a private per-job folder in the store's staging area. The shell deletes
//! the file once the save sheet is done with it, and the core removes leftover job folders on the
//! next export build. The command answers `{path, name, media_type, count,
//! missing, left_out}`: `count` is the files in the archive other than the README and
//! `Left out.txt`, `missing` counts the documents and photographs the archive could not include
//! (bytes not on this phone, or a file that cannot be read) and `left_out` names the first of
//! them with the reason; `Left out.txt` in the archive names every one. It writes nothing to the
//! vault.

use std::collections::{BTreeSet, VecDeque};
use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::bytes::BlobStore;
use crate::commands::document::no_store;
use crate::commands::document_portable::{
    LeftOut, add_left_out, clear, left_out_json, live_documents, live_folders, unique,
};
use crate::commands::health_portable::{measurements, readings, workouts};
use crate::commands::photo_portable::{Item as PhotoItem, live_photos};
use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, event_portable, note, person,
    task_portable, txn_portable,
};
use crate::error::{Result, VaultError};
use crate::portable::zip::ZipWriter;

/// Why an original changed after the export snapshot was taken.
pub const PHOTO_CHANGED: &str = "the original changed during export";

/// An OS original the native shell can fetch for the current archive item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OsOriginalRequest {
    pub photo_id: String,
    pub os_ref: String,
    pub hash: String,
    pub byte_size: u64,
    pub media_type: String,
}

enum PhotoSource {
    Store(std::path::PathBuf),
    Os(String),
    Missing(&'static str),
}

struct SnapshottedPhoto {
    item: PhotoItem,
    archive_path: String,
    source: PhotoSource,
}

/// Metadata and portable text captured while the vault is held. File reads and ZIP writes happen
/// only after the caller releases the vault connection guard.
pub struct VaultExportSnapshot {
    entries: Vec<(String, Vec<u8>)>,
    folders: std::collections::BTreeMap<String, crate::commands::document_portable::Folder>,
    documents: Vec<crate::commands::document_portable::DocumentRow>,
    photos: Vec<SnapshottedPhoto>,
}

impl VaultExportSnapshot {
    /// Capture text, document paths, and immutable photo source descriptors without reading any
    /// original file bytes.
    pub fn capture(
        connection: &rusqlite::Connection,
        blobs: &(dyn BlobStore + Send + Sync),
    ) -> Result<Self> {
        use crate::bytes::Located;

        let mut entries = vec![("README.txt".to_owned(), README.as_bytes().to_vec())];
        // A journal entry is a note with a day: it is in `Notes/` with the front matter that
        // says which day.
        let notes = note::markdown_entries(connection, None, None)?;
        entries.extend(
            notes
                .entries
                .into_iter()
                .map(|entry| (format!("Notes/{}", entry.path), entry.bytes)),
        );
        let (people, _) = person::vcard_file_for_vault(connection)?;
        entries.push(("People/people.vcf".to_owned(), people.into_bytes()));
        let (calendar, _) = event_portable::calendar_text(connection, None, None)?;
        entries.push(("Calendar/calendar.ics".to_owned(), calendar.into_bytes()));
        let (reminders, _) = task_portable::reminders_text(connection, None, None)?;
        entries.push(("Reminders/reminders.ics".to_owned(), reminders.into_bytes()));
        let (money, _) = txn_portable::transactions_csv(connection)?;
        entries.push(("Money/transactions.csv".to_owned(), money.into_bytes()));
        let (daily, _) = measurements(connection, None)?;
        entries.push(("Health/Daily totals.csv".to_owned(), daily.into_bytes()));
        let (moves, _, _) = workouts(connection, None)?;
        entries.push(("Health/Workouts.csv".to_owned(), moves.into_bytes()));
        let (spot, _) = readings(connection, None)?;
        entries.push(("Health/Readings.csv".to_owned(), spot.into_bytes()));

        let folders = live_folders(connection)?;
        let documents = live_documents(connection)?;
        let mut used_photo_paths = BTreeSet::new();
        let photos = live_photos(connection, None)?
            .into_iter()
            .map(|item| {
                let archive_path = unique(
                    &mut used_photo_paths,
                    format!("Photos/{}", photo_path(&item)),
                );
                let source = match blobs.locate(&item.blob) {
                    Ok(Located::Store(path)) => PhotoSource::Store(path),
                    Ok(Located::OsLibrary(os_ref)) => PhotoSource::Os(os_ref),
                    Ok(Located::Nowhere) => {
                        PhotoSource::Missing(crate::commands::document_portable::NOT_HERE)
                    }
                    Err(_) => PhotoSource::Missing(crate::commands::document_portable::UNREADABLE),
                };
                SnapshottedPhoto {
                    item,
                    archive_path,
                    source,
                }
            })
            .collect();
        Ok(Self {
            entries,
            folders,
            documents,
            photos,
        })
    }
}

/// One whole-vault archive in progress. Its writer and metadata are bounded by the number of
/// entries; original bytes are added one at a time, and OS originals never enter the vault store.
/// Dropping an unfinished job removes its partial plaintext archive.
pub struct VaultExportArchive {
    target: std::path::PathBuf,
    zip: Option<ZipWriter<BufWriter<File>>>,
    photos: VecDeque<SnapshottedPhoto>,
    left_out: Vec<LeftOut>,
    cancelled: Arc<AtomicBool>,
    active_photo: Option<String>,
    finished: bool,
}

/// The result of advancing a phone-owned archive by at most one original.
pub enum ExportStep {
    Advanced,
    Original(OsOriginalRequest),
    Complete,
}

/// A verified OS-original frame's disposition in the archive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginalDisposition {
    Added,
    Changed,
    Unreadable,
}

/// The final, closed archive and its portable omission summary.
pub struct FinishedVaultExport {
    pub path: std::path::PathBuf,
    pub count: u64,
    pub left_out: Vec<LeftOut>,
}

impl std::fmt::Debug for VaultExportArchive {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VaultExportArchive")
            .field("pending_photos", &self.photos.len())
            .field("entries", &self.zip.as_ref().map(ZipWriter::entries))
            .finish_non_exhaustive()
    }
}

impl Drop for VaultExportArchive {
    fn drop(&mut self) {
        if !self.finished {
            self.zip.take();
            if let Some(job_dir) = self.target.parent() {
                let _ = fs::remove_dir_all(job_dir);
            } else {
                let _ = fs::remove_file(&self.target);
            }
        }
    }
}

impl VaultExportArchive {
    /// Shared cancellation signal for the core's registry and this job's bounded readers.
    #[must_use]
    pub fn cancellation_token(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancelled)
    }

    /// Write the archive from a snapshot after the caller releases the vault connection guard.
    /// The returned job owns its writer, and the only source descriptors retained for photos are
    /// those selected by the snapshot.
    pub fn begin(
        snapshot: VaultExportSnapshot,
        blobs: &(dyn BlobStore + Send + Sync),
        target: &Path,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Self> {
        let mut archive = Self {
            target: target.to_path_buf(),
            zip: Some(ZipWriter::new(BufWriter::new(File::create(target)?))),
            photos: VecDeque::new(),
            left_out: Vec::new(),
            cancelled,
            active_photo: None,
            finished: false,
        };
        for (name, bytes) in snapshot.entries {
            if archive.cancelled.load(Ordering::SeqCst) {
                return Err(VaultError::Invariant {
                    context: "the whole-vault export was cancelled".to_owned(),
                });
            }
            put(archive.zip_mut()?, &name, &bytes)?;
        }
        let cancelled_for_docs = Arc::clone(&archive.cancelled);
        let (_, left_out) = crate::commands::document_portable::add_documents_cancellable(
            archive.zip_mut()?,
            blobs,
            &snapshot.folders,
            None,
            snapshot.documents,
            "Docs/",
            &cancelled_for_docs,
        )?;
        archive.left_out = left_out;
        archive.photos = snapshot.photos.into();
        Ok(archive)
    }

    /// The next OS original needed by the job, after appending any locally stored originals and
    /// recording items that are not available. At most one OS item is returned.
    pub fn next_os_original(&mut self) -> Result<Option<OsOriginalRequest>> {
        loop {
            let Some(photo) = self.photos.front() else {
                return Ok(None);
            };
            match &photo.source {
                PhotoSource::Os(os_ref) => {
                    return Ok(Some(OsOriginalRequest {
                        photo_id: photo.item.id.clone(),
                        os_ref: os_ref.clone(),
                        hash: photo.item.blob.clone(),
                        byte_size: photo.item.size,
                        media_type: photo.item.media_type.clone(),
                    }));
                }
                PhotoSource::Missing(why) => {
                    let why = *why;
                    let photo = self.photos.pop_front().expect("front exists");
                    self.left_out.push(LeftOut {
                        name: photo.archive_path,
                        why,
                    });
                }
                PhotoSource::Store(path) => {
                    let path = path.clone();
                    let photo = self.photos.pop_front().expect("front exists");
                    self.add_store_photo(photo, &path)?;
                }
            }
        }
    }

    /// Advance the resumable export by at most one local or unavailable photo. This keeps each
    /// request to one original, and returns an OS descriptor without doing native work under the
    /// vault or export registry lock.
    pub fn next_step(&mut self) -> Result<ExportStep> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(VaultError::Invariant {
                context: "the whole-vault export was cancelled".to_owned(),
            });
        }
        if self.active_photo.is_some() {
            return Err(VaultError::Invariant {
                context: "the current export original has not been committed or skipped".to_owned(),
            });
        }
        let Some(photo) = self.photos.front() else {
            return Ok(ExportStep::Complete);
        };
        match &photo.source {
            PhotoSource::Os(os_ref) => Ok(ExportStep::Original(OsOriginalRequest {
                photo_id: photo.item.id.clone(),
                os_ref: os_ref.clone(),
                hash: photo.item.blob.clone(),
                byte_size: photo.item.size,
                media_type: photo.item.media_type.clone(),
            })),
            PhotoSource::Missing(why) => {
                let why = *why;
                let photo = self.photos.pop_front().expect("front exists");
                self.left_out.push(LeftOut {
                    name: photo.archive_path,
                    why,
                });
                Ok(ExportStep::Advanced)
            }
            PhotoSource::Store(path) => {
                let path = path.clone();
                let photo = self.photos.pop_front().expect("front exists");
                self.add_store_photo(photo, &path)?;
                Ok(ExportStep::Advanced)
            }
        }
    }

    fn add_store_photo(&mut self, photo: SnapshottedPhoto, path: &Path) -> Result<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(VaultError::Invariant {
                context: "the whole-vault export was cancelled".to_owned(),
            });
        }
        match verified_file(path, &photo.item, &self.cancelled) {
            Ok(Some(file)) => {
                let cancelled = Arc::clone(&self.cancelled);
                self.zip_mut()?.add(
                    &photo.archive_path,
                    photo.item.size,
                    CancelReader {
                        inner: file,
                        cancelled,
                    },
                )?;
            }
            Ok(None) | Err(_) if self.cancelled.load(Ordering::SeqCst) => {
                return Err(VaultError::Invariant {
                    context: "the whole-vault export was cancelled".to_owned(),
                });
            }
            Ok(None) | Err(_) => self.left_out.push(LeftOut {
                name: photo.archive_path,
                why: crate::commands::document_portable::UNREADABLE,
            }),
        }
        Ok(())
    }

    /// Add bytes staged for the current OS original. The core supplies the stage file internally;
    /// no shell-provided path reaches this method. A mismatch is left out before ZIP mutation.
    pub fn add_os_original(
        &mut self,
        photo_id: &str,
        staged_path: &Path,
    ) -> Result<OriginalDisposition> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(VaultError::Invariant {
                context: "the whole-vault export was cancelled".to_owned(),
            });
        }
        let Some(photo) = self.photos.front() else {
            return Err(VaultError::Invariant {
                context: "photo bytes arrived after the export snapshot was exhausted".to_owned(),
            });
        };
        if photo.item.id != photo_id
            || self.active_photo.as_deref() != Some(photo_id)
            || !matches!(&photo.source, PhotoSource::Os(_))
        {
            return Err(VaultError::Invariant {
                context: "photo bytes do not match the export snapshot's next original".to_owned(),
            });
        }
        let photo = self.photos.pop_front().expect("front exists");
        let verified = match verified_file(staged_path, &photo.item, &self.cancelled) {
            Ok(Some(file)) => file,
            Ok(None) => {
                if self.cancelled.load(Ordering::SeqCst) {
                    return Err(VaultError::Invariant {
                        context: "the whole-vault export was cancelled".to_owned(),
                    });
                }
                self.left_out.push(LeftOut {
                    name: photo.archive_path,
                    why: PHOTO_CHANGED,
                });
                self.active_photo = None;
                return Ok(OriginalDisposition::Changed);
            }
            Err(_) => {
                if self.cancelled.load(Ordering::SeqCst) {
                    return Err(VaultError::Invariant {
                        context: "the whole-vault export was cancelled".to_owned(),
                    });
                }
                self.left_out.push(LeftOut {
                    name: photo.archive_path,
                    why: crate::commands::document_portable::UNREADABLE,
                });
                self.active_photo = None;
                return Ok(OriginalDisposition::Unreadable);
            }
        };
        let cancelled = Arc::clone(&self.cancelled);
        self.zip_mut()?.add(
            &photo.archive_path,
            photo.item.size,
            CancelReader {
                inner: verified,
                cancelled,
            },
        )?;
        self.active_photo = None;
        Ok(OriginalDisposition::Added)
    }

    /// Claim the immutable next OS descriptor for one live Stage session. A duplicate or
    /// out-of-order begin is refused before it creates a temp file.
    pub fn claim_os_original(&mut self, photo_id: &str) -> Result<OsOriginalRequest> {
        if self.cancelled.load(Ordering::SeqCst) || self.active_photo.is_some() {
            return Err(VaultError::Invariant {
                context: "this export is cancelled or already has an original in flight".to_owned(),
            });
        }
        let Some(photo) = self.photos.front() else {
            return Err(VaultError::Invariant {
                context: "this export has no original waiting for bytes".to_owned(),
            });
        };
        let PhotoSource::Os(os_ref) = &photo.source else {
            return Err(VaultError::Invariant {
                context: "the next export original is not supplied by the photo library".to_owned(),
            });
        };
        if photo.item.id != photo_id {
            return Err(VaultError::Invariant {
                context: "the export stage does not name the next snapshot photo".to_owned(),
            });
        }
        let original = OsOriginalRequest {
            photo_id: photo.item.id.clone(),
            os_ref: os_ref.clone(),
            hash: photo.item.blob.clone(),
            byte_size: photo.item.size,
            media_type: photo.item.media_type.clone(),
        };
        self.active_photo = Some(photo_id.to_owned());
        Ok(original)
    }

    /// Release a failed or cancelled stage claim so the export can record its omission.
    pub fn release_os_claim(&mut self, photo_id: &str) -> Result<()> {
        if self.active_photo.as_deref() != Some(photo_id) {
            return Err(VaultError::Invariant {
                context: "the export stage claim does not match this photo".to_owned(),
            });
        }
        self.active_photo = None;
        Ok(())
    }

    /// Record a native lookup/read failure for the immutable next original, then continue.
    pub fn skip_os_original(&mut self, photo_id: &str, why: &'static str) -> Result<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(VaultError::Invariant {
                context: "the whole-vault export was cancelled".to_owned(),
            });
        }
        let Some(photo) = self.photos.front() else {
            return Err(VaultError::Invariant {
                context: "an unavailable photo arrived after the export snapshot was exhausted"
                    .to_owned(),
            });
        };
        if photo.item.id != photo_id
            || self.active_photo.is_some()
            || !matches!(&photo.source, PhotoSource::Os(_))
        {
            return Err(VaultError::Invariant {
                context: "unavailable photo does not match the export snapshot's next original"
                    .to_owned(),
            });
        }
        let photo = self.photos.pop_front().expect("front exists");
        self.left_out.push(LeftOut {
            name: photo.archive_path,
            why,
        });
        Ok(())
    }

    /// Close the archive and return the file for the OS save sheet.
    pub fn finish(mut self) -> Result<FinishedVaultExport> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(VaultError::Invariant {
                context: "the whole-vault export was cancelled".to_owned(),
            });
        }
        if !self.photos.is_empty() {
            return Err(VaultError::Invariant {
                context: "a whole-vault archive cannot finish with originals pending".to_owned(),
            });
        }
        let count = self.zip_mut()?.entries().saturating_sub(1);
        let left_out = std::mem::take(&mut self.left_out);
        add_left_out(self.zip_mut()?, &left_out)?;
        let zip = self.zip.take().expect("open export writer");
        zip.finish()?;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(VaultError::Invariant {
                context: "the whole-vault export was cancelled".to_owned(),
            });
        }
        self.finished = true;
        Ok(FinishedVaultExport {
            path: self.target.clone(),
            count,
            left_out,
        })
    }

    fn zip_mut(&mut self) -> Result<&mut ZipWriter<BufWriter<File>>> {
        self.zip.as_mut().ok_or_else(|| VaultError::Invariant {
            context: "the whole-vault archive writer is already closed".to_owned(),
        })
    }
}

fn verified_file(
    path: &Path,
    photo: &PhotoItem,
    cancelled: &AtomicBool,
) -> std::io::Result<Option<File>> {
    let mut file = File::open(path)?;
    if file.metadata()?.len() != photo.size {
        return Ok(None);
    }
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(std::io::Error::other("the archive was cancelled"));
        }
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    if hasher.finalize().to_hex().as_str() != photo.blob {
        return Ok(None);
    }
    File::open(path).map(Some)
}

struct CancelReader<R> {
    inner: R,
    cancelled: Arc<AtomicBool>,
}

impl<R: Read> Read for CancelReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(std::io::Error::other("the archive was cancelled"));
        }
        self.inner.read(buffer)
    }
}

fn photo_path(item: &PhotoItem) -> String {
    let extension = crate::commands::photo_portable::extension_of(&item.media_type);
    match &item.stamp {
        Some(stamp) => format!("{}/{stamp}.{extension}", stamp.get(..4).unwrap_or("0000")),
        None => format!(
            "Undated/{}.{extension}",
            item.blob.chars().take(12).collect::<String>()
        ),
    }
}

/// The note at the top of the archive, in plain words.
pub const README: &str = "\
This is a copy of what Centraid holds on your phone, one folder per app.

Notes: your notes and journal entries as Markdown files, a folder for each notebook.
People: everyone's card, including yours, in people.vcf.
Calendar: your events as one calendar file (calendar.ics).
Reminders: your reminders as one calendar file (reminders.ics).
Money: your transactions as one spreadsheet (transactions.csv).
Health: your daily totals, your workouts and your readings as three spreadsheets.
Docs: your documents, as the original files, in the folders you made.
Photos: your photos and videos, as the original files, by the year and time they were taken.

If a document or a photo could not be included, Left out.txt names it and says why.

Locker is not here. Its passwords and secrets leave only through Locker's own export.

These files are not locked. Keep this archive somewhere you trust.
";

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
    Ok(None)
}

/// The member-facing filename for an aggregate archive, dated by the vault
/// clock at the start of the export job.
#[must_use]
pub fn archive_filename(now: &str) -> String {
    let day: String = now.chars().take(10).collect();
    format!("Centraid export {day}.zip")
}

/// One small file into the archive.
fn put<W: Write + Seek>(zip: &mut ZipWriter<W>, name: &str, bytes: &[u8]) -> Result<()> {
    zip.add(name, bytes.len() as u64, bytes)?;
    Ok(())
}

/// `vault.export_all`: see the module header.
fn export_all(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let Some(blobs) = ctx.blobs() else {
        return Err(VaultError::Invariant {
            context: "vault.export_all ran without a content store".to_owned(),
        });
    };
    let Some(staging) = blobs.staging_dir() else {
        return Err(VaultError::Invariant {
            context: "vault.export_all ran without a staging folder".to_owned(),
        });
    };
    clear(&staging)?;
    let target = staging.join("export.zip");
    match write_archive(ctx, &target) {
        Ok((count, left)) => Ok(serde_json::json!({
            "path": target.to_string_lossy(),
            "name": archive_filename(&ctx.now),
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

/// The archive itself. Returns how many files went in (the README and `Left out.txt` not counted)
/// and the documents and photographs it could not include.
fn write_archive(
    ctx: &CommandCtx<'_, '_>,
    target: &std::path::Path,
) -> Result<(u64, Vec<LeftOut>)> {
    let (Some(blobs), connection) = (ctx.blobs(), ctx.connection()) else {
        return Err(VaultError::Invariant {
            context: "vault.export_all ran without a content store".to_owned(),
        });
    };
    let snapshot = VaultExportSnapshot::capture(connection, blobs)?;
    let mut archive =
        VaultExportArchive::begin(snapshot, blobs, target, Arc::new(AtomicBool::new(false)))?;
    while let Some(original) = archive.next_os_original()? {
        // The synchronous command has no native library performer. The phone's shell uses the
        // resumable request path below, which supplies this immutable original one at a time.
        archive.skip_os_original(
            &original.photo_id,
            crate::commands::document_portable::NOT_HERE,
        )?;
    }
    let finished = archive.finish()?;
    Ok((finished.count, finished.left_out))
}

const SCHEMA: &str = r#"{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const EXPORT: &[CommandCondition] = &[CommandCondition {
        predicate: "vault_export_has_a_store_and_a_staging_folder",
        check: pre_export,
    }];
    vec![CommandDefinition::plain(
        "vault.export_all",
        "vault",
        SCHEMA,
        Idempotency::Idempotent,
        EXPORT,
        export_all,
    )]
}

#[cfg(test)]
mod archive_tests {
    use super::*;
    use crate::bytes::FsBlobStore;
    use crate::commands::document_portable::DocumentRow;
    use crate::portable::zip::stored_entries;
    use std::path::PathBuf;

    fn one_os_photo(dir: &Path, bytes: &[u8]) -> (VaultExportSnapshot, FsBlobStore, PathBuf) {
        let store = FsBlobStore::open(dir.join("bytes")).expect("a byte store");
        let hash = blake3::hash(bytes).to_hex().to_string();
        let snapshot = VaultExportSnapshot {
            entries: vec![("README.txt".to_owned(), README.as_bytes().to_vec())],
            folders: std::collections::BTreeMap::new(),
            documents: Vec::<DocumentRow>::new(),
            photos: vec![SnapshottedPhoto {
                item: PhotoItem {
                    id: "photo-1".to_owned(),
                    blob: hash,
                    size: bytes.len() as u64,
                    media_type: "image/jpeg".to_owned(),
                    stamp: Some("2026-05-03 120000".to_owned()),
                },
                archive_path: "Photos/2026/2026-05-03 120000.jpg".to_owned(),
                source: PhotoSource::Os("library-item-1".to_owned()),
            }],
        };
        (snapshot, store, dir.join("job/export.zip"))
    }

    #[test]
    fn os_original_claim_is_snapshot_bound_and_only_one_stage_can_own_it() {
        let dir = tempfile::tempdir().expect("a directory");
        let bytes = b"the photo-library original";
        let (snapshot, store, target) = one_os_photo(dir.path(), bytes);
        std::fs::create_dir_all(target.parent().expect("job directory")).expect("the job folder");
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut archive =
            VaultExportArchive::begin(snapshot, &store, &target, Arc::clone(&cancelled))
                .expect("the snapshot builds");
        let ExportStep::Original(original) = archive.next_step().expect("next") else {
            panic!("the OS original is requested");
        };
        assert_eq!(original.os_ref, "library-item-1");
        assert!(archive.claim_os_original("wrong-photo").is_err());
        assert!(
            archive
                .skip_os_original("wrong-photo", PHOTO_CHANGED)
                .is_err()
        );
        assert_eq!(
            archive.claim_os_original("photo-1").expect("claim"),
            original
        );
        assert!(
            archive.claim_os_original("photo-1").is_err(),
            "duplicate Stage begin"
        );
        assert!(archive.skip_os_original("photo-1", PHOTO_CHANGED).is_err());
        let staged = dir.path().join("one.original");
        std::fs::write(&staged, bytes).expect("staged bytes");
        assert_eq!(
            archive
                .add_os_original("photo-1", &staged)
                .expect("verified original"),
            OriginalDisposition::Added
        );
        assert!(matches!(
            archive.next_step().expect("complete"),
            ExportStep::Complete
        ));
        let finished = archive.finish().expect("a closed zip");
        let entries = stored_entries(&std::fs::read(&finished.path).expect("archive"))
            .expect("valid archive");
        assert_eq!(
            entries
                .iter()
                .find(|(name, _)| name == "Photos/2026/2026-05-03 120000.jpg")
                .expect("the snapshotted original is included")
                .1,
            bytes
        );
    }

    #[test]
    fn a_changed_os_original_is_left_out_before_any_zip_entry_is_written() {
        let dir = tempfile::tempdir().expect("a directory");
        let bytes = b"the photo-library original";
        let (snapshot, store, target) = one_os_photo(dir.path(), bytes);
        std::fs::create_dir_all(target.parent().expect("job directory")).expect("the job folder");
        let mut archive =
            VaultExportArchive::begin(snapshot, &store, &target, Arc::new(AtomicBool::new(false)))
                .expect("the snapshot builds");
        let ExportStep::Original(original) = archive.next_step().expect("next") else {
            panic!("the OS original is requested");
        };
        archive
            .claim_os_original(&original.photo_id)
            .expect("claim");
        let wrong_hash = dir.path().join("wrong-hash.original");
        std::fs::write(&wrong_hash, vec![b'x'; bytes.len()]).expect("a changed original");
        assert_eq!(
            archive
                .add_os_original(&original.photo_id, &wrong_hash)
                .expect("a changed original is safely omitted"),
            OriginalDisposition::Changed
        );
        let finished = archive.finish().expect("omissions make a valid archive");
        assert_eq!(finished.left_out.len(), 1);
        assert_eq!(finished.left_out[0].why, PHOTO_CHANGED);
        let entries = stored_entries(&std::fs::read(&finished.path).expect("archive"))
            .expect("valid archive");
        assert!(
            entries
                .iter()
                .all(|(name, _)| name != "Photos/2026/2026-05-03 120000.jpg")
        );
    }

    #[test]
    fn an_original_with_a_changed_size_is_never_added_to_the_zip() {
        let dir = tempfile::tempdir().expect("a directory");
        let bytes = b"the photo-library original";
        let (snapshot, store, target) = one_os_photo(dir.path(), bytes);
        std::fs::create_dir_all(target.parent().expect("job directory")).expect("the job folder");
        let mut archive =
            VaultExportArchive::begin(snapshot, &store, &target, Arc::new(AtomicBool::new(false)))
                .expect("the snapshot builds");
        let ExportStep::Original(original) = archive.next_step().expect("next") else {
            panic!("the OS original is requested");
        };
        archive
            .claim_os_original(&original.photo_id)
            .expect("claim");
        let wrong_size = dir.path().join("wrong-size.original");
        std::fs::write(&wrong_size, vec![b'x'; bytes.len() + 1]).expect("a size change");
        assert_eq!(
            archive
                .add_os_original(&original.photo_id, &wrong_size)
                .expect("a size change is safely omitted"),
            OriginalDisposition::Changed
        );
        let finished = archive.finish().expect("omissions make a valid archive");
        assert_eq!(finished.left_out.len(), 1);
        let entries = stored_entries(&std::fs::read(&finished.path).expect("archive"))
            .expect("valid archive");
        assert!(
            entries
                .iter()
                .all(|(name, _)| name != "Photos/2026/2026-05-03 120000.jpg")
        );
    }

    #[test]
    fn an_unfinished_or_cancelled_job_removes_its_whole_plaintext_folder() {
        let dir = tempfile::tempdir().expect("a directory");
        let bytes = b"the photo-library original";
        let (snapshot, store, target) = one_os_photo(dir.path(), bytes);
        let job_dir = target.parent().expect("job directory").to_path_buf();
        std::fs::create_dir_all(&job_dir).expect("the job folder");
        let cancelled = Arc::new(AtomicBool::new(false));
        let archive = VaultExportArchive::begin(snapshot, &store, &target, Arc::clone(&cancelled))
            .expect("the snapshot builds");
        assert!(target.exists());
        cancelled.store(true, Ordering::SeqCst);
        drop(archive);
        assert!(
            !job_dir.exists(),
            "cancelled ZIP and staged originals are removed"
        );
    }
}
