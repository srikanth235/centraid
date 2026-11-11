//! EVERYTHING ON THIS PHONE AS ONE ARCHIVE (#1185): `vault.export_all`, a stored zip with one
//! folder per app, written to a file and never built in memory (owner decision D17).
//!
//! | Folder | What is in it | Written by |
//! |---|---|---|
//! | `Notes/` | the Markdown tree, a folder per notebook | [`note::markdown_entries`] |
//! | `People/people.vcf` | everyone as vCards | [`person::vcard_file`] |
//! | `Calendar/calendar.ics` | every event | [`event_portable::calendar_text`] |
//! | `Reminders/reminders.ics` | every reminder | [`task_portable::reminders_text`] |
//! | `Money/transactions.csv` | every transaction | [`txn_portable::transactions_csv`] |
//! | `Health/` | `Daily totals.csv`, `Workouts.csv` | [`health_portable`] |
//! | `Docs/` | the originals, in the member's folders | [`document_portable::add_documents`] |
//! | `Photos/` | the originals, named by when they were taken | [`photo_portable::add_photos`] |
//!
//! Each piece is the function the app's own export command runs, so the text files are the very
//! bytes an app's own export saves; the originals are streamed from the content store's files in
//! fixed-size chunks, never read into memory. A `README.txt` at the top says what each folder is.
//!
//! **LOCKER IS NOT IN IT** (owner decision D11): a Locker item's contents leave the phone only
//! through Locker's own export, which asks for its own, stricter owner check. Nothing here reads
//! a Locker table, and the notes are the member's own: a note about the vault itself is left out
//! exactly as `note.export` leaves it.
//!
//! The zip is written to the store's staging folder, emptied first; the shell deletes the file
//! once the save sheet is done with it. The command answers `{path, name, media_type, count,
//! missing}`: `count` is the files in the archive other than the README and `missing` counts the
//! documents and photographs whose bytes are not on this phone, which the archive leaves out. It
//! writes nothing to the vault.

use std::fs::{self, File};
use std::io::{BufWriter, Seek, Write};

use crate::bytes::BlobStore;
use crate::commands::document::no_store;
use crate::commands::document_portable::{add_documents, clear, live_documents, live_folders};
use crate::commands::health_portable::{measurements, workouts};
use crate::commands::photo_portable::{add_photos, live_photos};
use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, event_portable, note, person,
    task_portable, txn_portable,
};
use crate::error::{Result, VaultError};
use crate::portable::zip::ZipWriter;

/// The note at the top of the archive, in plain words.
pub const README: &str = "\
This is a copy of what Centraid holds on your phone, one folder per app.

Notes: your notes as Markdown files, a folder for each notebook.
People: everyone as one contacts file (people.vcf).
Calendar: your events as one calendar file (calendar.ics).
Reminders: your reminders as one calendar file (reminders.ics).
Money: your transactions as one spreadsheet (transactions.csv).
Health: your daily totals and your workouts as two spreadsheets.
Docs: your documents, as the original files, in the folders you made.
Photos: your photos and videos, as the original files, by the year and time they were taken.

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
    let day: String = ctx.now.chars().take(10).collect();
    match write_archive(ctx, &target) {
        Ok((count, missing)) => Ok(serde_json::json!({
            "path": target.to_string_lossy(),
            "name": format!("Centraid export {day}.zip"),
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

/// The archive itself. Returns how many files went in (the README not counted) and how many
/// documents and photographs were not on this phone.
fn write_archive(ctx: &CommandCtx<'_, '_>, target: &std::path::Path) -> Result<(u64, u64)> {
    let (Some(blobs), connection) = (ctx.blobs(), ctx.connection()) else {
        return Err(VaultError::Invariant {
            context: "vault.export_all ran without a content store".to_owned(),
        });
    };
    let mut zip = ZipWriter::new(BufWriter::new(File::create(target)?));
    put(&mut zip, "README.txt", README.as_bytes())?;

    let (_, notes) = note::markdown_entries(connection, None)?;
    for entry in notes {
        put(&mut zip, &format!("Notes/{}", entry.path), &entry.bytes)?;
    }
    let (people, _) = person::vcard_file(connection, None, None)?;
    put(&mut zip, "People/people.vcf", people.as_bytes())?;
    let (calendar, _) = event_portable::calendar_text(connection, None, None)?;
    put(&mut zip, "Calendar/calendar.ics", calendar.as_bytes())?;
    let (reminders, _) = task_portable::reminders_text(connection, None, None)?;
    put(&mut zip, "Reminders/reminders.ics", reminders.as_bytes())?;
    let (money, _) = txn_portable::transactions_csv(connection)?;
    put(&mut zip, "Money/transactions.csv", money.as_bytes())?;
    let (daily, _) = measurements(connection, None)?;
    put(&mut zip, "Health/Daily totals.csv", daily.as_bytes())?;
    let (moves, _, _) = workouts(connection, None)?;
    put(&mut zip, "Health/Workouts.csv", moves.as_bytes())?;

    let folders = live_folders(connection)?;
    let documents = live_documents(connection)?;
    let (_, lost_documents) = add_documents(&mut zip, blobs, &folders, None, documents, "Docs/")?;
    let photos = live_photos(connection, None)?;
    let (_, lost_photos) = add_photos(&mut zip, blobs, photos, "Photos/")?;

    let count = zip.entries().saturating_sub(1);
    zip.finish()?;
    Ok((count, lost_documents + lost_photos))
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
