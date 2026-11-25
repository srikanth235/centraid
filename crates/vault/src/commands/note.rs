//! `note.*`: a note's own verbs — create, edit, restore a version, its assets, a Markdown import
//! and export. **This file is the pattern an app lane copies**; `.claude/skills/change/vault-model.md` says how.
//!
//! A note is an entity of kind `note` whose words live on its kind row. Where it sits (its
//! notebook, or the top level) is its home, `entity.parent_id`, like every kind's: a note is made
//! in one (`notebook_id` at create) and moved with the shared `entity.move`. Everything a member
//! does to a note that is not about its words goes through a shared verb: the trash
//! (`entity.trash`, `entity.restore`), a pin or star (`entity.star`/`pin`), a tag (`tag.add`), a
//! rename (`entity.retitle`), a link made by hand or an `about` (`link.add`, `edge.add`). What is
//! here is what only a note has: its words and format, its journal day, its assets.
//!
//! ## History is the commit door's
//!
//! An edit that changes a note keeps the note as it was (its words in `revision.body`, its title,
//! home, day and assets in `revision.state`, an asset's bytes as `revision_blob` slot
//! `asset:<id>`) without this file doing anything: the commit door writes every record's history
//! ([`crate::history`]). An editor's autosave is a quiet command (`Command::quiet`) and folds into
//! the version before it. An edit or a restore that lands on what is already there writes nothing,
//! because it changed nothing.
//!
//! ## The words are the source; `mention` is their compilation
//!
//! A `[[title]]` in a body is one `mention` row, `(note, ordinal, words, target)`, rebuilt from the
//! words on every save and nothing else lives in the table: every `about` the member made is an
//! `edge` (it may carry an anchor), a hand link is a `link`. `[[Alex]]` twice keeps two rows; two
//! live items titled Alex keep one row each. A title nothing carries keeps its row with no
//! target, and **creating or renaming any linkable item** ([`resolve_waiting`], called from
//! [`crate::commands::CommandCtx::insert_entity_in`] and [`crate::commands::entity::rename`])
//! points the rows waiting for that title at it. A purge turns a target's rows back to waiting
//! (the foreign key's `ON DELETE SET NULL`). What may be a target is the lookup's attribute
//! (`entity_kind.linkable`), read by the query, never a list here. A rename never rewrites a
//! note's text: the row keeps the target it has, whatever the target is now called.
//!
//! ## A journal entry is a note with a day
//!
//! `note.journal_on` (a date; none is an ordinary note). Being `about` the owner does not make a
//! note one, and an entry can be backdated.
//!
//! ## An asset is a child, not an item
//!
//! An image or file placed in the body is a `note_asset` row: in no list, search result or trash,
//! it goes with the note, and an earlier version keeps its own through history. A file the member
//! wants as an item is a document `attached` to the note instead.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use rusqlite::OptionalExtension;

use crate::commands::entity::{self, STALE_GUARD, home_refusal, lookup_live, with_rev};
use crate::commands::tag::{ensure_concept, next_color, set_tagged};
use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, arrival, deserialize_patch,
};
use crate::error::{Result, VaultError};
use crate::model::Kind;

/// The most a note's words may weigh. The body is a column of a row that is read whole to index,
/// to preview and to snapshot, so a note this long is refused rather than bloating the file.
pub const BODY_BUDGET_BYTES: usize = 64 * 1024;

/// The most mentions one note's words compile to: one pathological body cannot write thousands of
/// rows.
pub const MAX_MENTIONS: i64 = 200;

/// The most asset bytes one `note.export` archive holds (it is built in memory); a notebook with
/// more is exported by the whole-vault export, which streams.
pub const EXPORT_ASSET_BYTES: i64 = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Preconditions: each says in a sentence what the database would refuse too
// ---------------------------------------------------------------------------

fn body_refusal(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    let body = ctx.optional_str("body")?;
    (body.len() > BODY_BUDGET_BYTES).then(|| {
        format!(
            "That note is {} bytes of text, over the {BODY_BUDGET_BYTES}-byte budget; a note's \
             words are kept in the vault row they are indexed from, so a body this long is \
             refused rather than silently bloating the file.",
            body.len()
        )
    })
}

/// A sentence when `day` is not a calendar date (`note.journal_on`'s own check).
fn day_refusal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(day) = ctx.optional_str("journal_on") else {
        return Ok(None);
    };
    let valid: bool = ctx
        .connection()
        .query_row("SELECT date(?1) IS ?1", [day], |row| row.get(0))?;
    Ok((!valid).then(|| format!("“{day}” is not a day; write it as 2026-03-01")))
}

/// A live note: a trashed one is frozen, restore it first.
fn live_note(ctx: &CommandCtx<'_, '_>, key: &str) -> Result<std::result::Result<(), String>> {
    Ok(
        match lookup_live(ctx.connection(), ctx.required_str(key)?)? {
            Err(sentence) => Err(sentence),
            Ok(found) if found.kind != Kind::Note => Err(format!(
                "“{}” is a {}, not a note",
                found.title,
                found.kind.noun()
            )),
            Ok(_) => Ok(()),
        },
    )
}

fn pre_create(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("a note needs a title".to_owned()));
    }
    if let Some(sentence) = body_refusal(ctx) {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = day_refusal(ctx)? {
        return Ok(Some(sentence));
    }
    home_refusal(
        ctx.connection(),
        Kind::Note,
        None,
        ctx.optional_str("notebook_id"),
    )
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_note(ctx, "id")? {
        return Ok(Some(sentence));
    }
    if ctx
        .optional_str("title")
        .is_some_and(|t| t.trim().is_empty())
    {
        return Ok(Some("a note needs a title".to_owned()));
    }
    if let Some(sentence) = body_refusal(ctx) {
        return Ok(Some(sentence));
    }
    day_refusal(ctx)
}

fn pre_restore_version(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_note(ctx, "id")? {
        return Ok(Some(sentence));
    }
    let held: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM revision WHERE entity_id = ?1 AND seq = ?2",
        rusqlite::params![ctx.required_str("id")?, ctx.input["seq"].as_i64()],
        |row| row.get(0),
    )?;
    Ok((held == 0).then(|| "That version is not in this note's history.".to_owned()))
}

// ---------------------------------------------------------------------------
// Create, edit, restore a version
// ---------------------------------------------------------------------------

/// What a new note is made of.
#[derive(Default)]
pub struct Founding<'a> {
    /// An id the phone minted, so a re-offered create is one note.
    pub id: Option<&'a str>,
    pub title: &'a str,
    pub body: &'a str,
    /// `markdown` (the default) or `plain`.
    pub format: Option<&'a str>,
    /// The notebook it is made in; none: the top level.
    pub notebook: Option<&'a str>,
    /// Its day when it is a journal entry.
    pub journal_on: Option<&'a str>,
}

/// Found a note: the entity in its home, the kind row, and the mentions its words compile to.
///
/// The one place a note is born, so a command of another app that writes a note (a person's
/// journal entry, a task's memo) founds it the same way and then adds its own `about` edge.
pub fn found(ctx: &CommandCtx<'_, '_>, new: &Founding<'_>) -> Result<String> {
    let title = new.title.trim();
    let id = match new.id {
        Some(id) => {
            ctx.insert_entity_in(id, Kind::Note, title, new.notebook)?;
            id.to_owned()
        }
        None => ctx.insert_entity_under(Kind::Note, title, new.notebook)?,
    };
    ctx.connection().execute(
        "INSERT INTO note (id, body, format, journal_on) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![
            id,
            new.body,
            new.format.unwrap_or("markdown"),
            new.journal_on
        ],
    )?;
    rebuild_mentions(ctx, &id, new.body)?;
    Ok(id)
}

#[derive(serde::Deserialize)]
struct CreateInput {
    id: Option<String>,
    title: String,
    body: Option<String>,
    format: Option<String>,
    notebook_id: Option<String>,
    journal_on: Option<String>,
}

fn create(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: CreateInput = ctx.parse_input()?;
    let id = found(
        ctx,
        &Founding {
            id: input.id.as_deref(),
            title: &input.title,
            body: input.body.as_deref().unwrap_or_default(),
            format: input.format.as_deref(),
            notebook: input.notebook_id.as_deref(),
            journal_on: input.journal_on.as_deref(),
        },
    )?;
    Ok(serde_json::json!({ "id": id }))
}

/// Set a note's words: the one path an edit takes (a restore rebuilds through [`relink`]).
/// Returns whether the words changed.
fn set_body(ctx: &CommandCtx<'_, '_>, id: &str, body: &str) -> Result<bool> {
    let changed = ctx.connection().execute(
        "UPDATE note SET body = ?2 WHERE id = ?1 AND body <> ?2",
        [id, body],
    )?;
    if changed > 0 {
        rebuild_mentions(ctx, id, body)?;
    }
    Ok(changed > 0)
}

#[derive(serde::Deserialize)]
struct EditInput {
    id: String,
    body: Option<String>,
    format: Option<String>,
    title: Option<String>,
    /// Absent: leave the day; `null`: an ordinary note again; a date: a journal entry on it.
    #[serde(default, deserialize_with = "deserialize_patch")]
    journal_on: Option<Option<String>>,
}

/// `note.edit`: the words, the format, the title, the journal day. A title goes through the one
/// rename path, so the mentions waiting for the new title resolve.
fn edit(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: EditInput = ctx.parse_input()?;
    if let Some(body) = input.body.as_deref() {
        set_body(ctx, &input.id, body)?;
    }
    if let Some(format) = input.format.as_deref() {
        ctx.connection().execute(
            "UPDATE note SET format = ?2 WHERE id = ?1",
            [input.id.as_str(), format],
        )?;
    }
    if let Some(day) = &input.journal_on {
        ctx.connection().execute(
            "UPDATE note SET journal_on = ?2 WHERE id = ?1",
            rusqlite::params![input.id, day],
        )?;
    }
    if let Some(title) = input.title.as_deref() {
        entity::rename(ctx, &input.id, title.trim())?;
    }
    with_rev(ctx, &input.id, serde_json::json!({ "id": input.id }))
}

#[derive(serde::Deserialize)]
struct RestoreVersionInput {
    id: String,
    seq: Option<i64>,
}

fn restore_version(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: RestoreVersionInput = ctx.parse_input()?;
    // The words and assets of the version: one path with every other restore
    // (`history.restore_version`), limited to the content. What it replaces is kept as a version
    // by the commit door.
    let restored = crate::history::restore_version(
        ctx,
        &input.id,
        input.seq.unwrap_or_default(),
        crate::history::Scope::Content,
    )?
    .is_some_and(|restored| restored.restored);
    Ok(serde_json::json!({ "id": input.id, "restored": restored }))
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/// Every `[[title]]` a body names, in the order they appear, each occurrence once.
///
/// A wikilink is `[[` … `]]` on ONE line with something between. Anything else is text: an
/// unclosed `[[` is skipped rather than swallowing what follows it, and when a second `[[` opens
/// before the first closes the second is the link. Titles are trimmed; `[[Plan]]` and `[[ plan ]]`
/// are two occurrences of one title, and both are kept (a note may name a thing twice).
#[must_use]
pub fn wikilinks(body: &str) -> Vec<String> {
    let mut titles: Vec<String> = Vec::new();
    for line in body.lines() {
        let mut rest = line;
        while let Some(open) = rest.find("[[") {
            let after = &rest[open + 2..];
            let Some(close) = after.find("]]") else {
                break;
            };
            let inner = &after[..close];
            if let Some(reopened) = inner.rfind("[[") {
                // The second `[[` opened before the first closed: it is the link.
                rest = &rest[open + 2 + reopened..];
                continue;
            }
            let title = inner.trim();
            if !title.is_empty() {
                titles.push(title.to_owned());
            }
            rest = &after[close + 2..];
        }
    }
    titles
}

/// The live items a title names: every linkable kind's, by the title folded as SQLite's `NOCASE`
/// does, through `entity_by_title_nocase`. `CROSS JOIN` keeps the few linkable kinds as the
/// outer loop: left to itself the planner scans every entity. A note never names itself.
const NAMED_BY: &str = "SELECT e.id FROM entity_kind k
       CROSS JOIN entity e ON e.kind = k.code
      WHERE k.linkable = 1 AND e.title = ?2 COLLATE NOCASE AND e.deleted_at IS NULL AND e.id <> ?1
      ORDER BY e.created_at, e.id";

/// Rebuild the mentions a note's words compile to: all of them, from the words alone.
fn rebuild_mentions(ctx: &CommandCtx<'_, '_>, note: &str, body: &str) -> Result<()> {
    let connection = ctx.connection();
    connection.execute("DELETE FROM mention WHERE note_id = ?1", [note])?;
    let mut named = connection.prepare_cached(NAMED_BY)?;
    let mut insert = connection.prepare_cached(
        "INSERT INTO mention (note_id, ordinal, wikilink, to_id) VALUES (?1, ?2, ?3, ?4)",
    )?;
    let mut ordinal: i64 = 0;
    'words: for title in wikilinks(body) {
        let targets = named
            .query_map(rusqlite::params![note, title], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // A title nothing carries keeps its row, waiting.
        let rows: Vec<Option<String>> = if targets.is_empty() {
            vec![None]
        } else {
            targets.into_iter().map(Some).collect()
        };
        for target in rows {
            if ordinal >= MAX_MENTIONS {
                break 'words;
            }
            insert.execute(rusqlite::params![note, ordinal, title, target])?;
            ordinal += 1;
        }
    }
    Ok(())
}

/// Rebuild the mentions of a note whose words something other than an edit set (a restored
/// version).
pub(crate) fn relink(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<()> {
    let body: String =
        ctx.connection()
            .query_row("SELECT body FROM note WHERE id = ?1", [id], |row| {
                row.get(0)
            })?;
    rebuild_mentions(ctx, id, &body)
}

/// THE HOOK the kernel calls when an item is made or renamed: point every mention waiting for
/// this item's title at it, if it is a live linkable item. A trashed item, a reading, a chat, a
/// container or a label is never a target (`entity_kind.linkable`). Reads `mention_by_words`,
/// the waiting rows by their words, and nothing else of the vault's notes.
pub(crate) fn resolve_waiting(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<()> {
    ctx.connection().execute(
        "UPDATE mention SET to_id = ?1
          WHERE to_id IS NULL AND note_id <> ?1
            AND wikilink = (SELECT title FROM entity WHERE id = ?1) COLLATE NOCASE
            AND EXISTS (SELECT 1 FROM entity e JOIN entity_kind k ON k.code = e.kind
                         WHERE e.id = ?1 AND k.linkable = 1 AND e.deleted_at IS NULL)",
        [id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

fn no_store(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    ctx.blobs()
        .is_none()
        .then(|| "this vault has nowhere to keep a file's bytes".to_owned())
}

/// A sentence when `hash` is not bytes the content store holds.
fn bytes_refusal(ctx: &CommandCtx<'_, '_>, hash: &str) -> Result<Option<String>> {
    if let Some(sentence) = no_store(ctx) {
        return Ok(Some(sentence));
    }
    let held = ctx
        .blobs()
        .is_some_and(|store| crate::blob::is_hash(hash) && store.has(hash).unwrap_or(false));
    Ok((!held).then(|| "those bytes are not in this vault's store".to_owned()))
}

fn pre_asset_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_note(ctx, "id")? {
        return Ok(Some(sentence));
    }
    for (key, what) in [
        ("name", "a name"),
        ("media_type", "what kind of file it is"),
    ] {
        if ctx.required_str(key)?.trim().is_empty() {
            return Ok(Some(format!("an attachment needs {what}")));
        }
    }
    bytes_refusal(ctx, ctx.required_str("blob")?)
}

/// Put bytes the store holds in a note's body as an asset, last in order.
fn add_asset(
    ctx: &CommandCtx<'_, '_>,
    note: &str,
    hash: &str,
    name: &str,
    media_type: &str,
) -> Result<String> {
    let store = ctx.blobs().ok_or_else(|| VaultError::Invariant {
        context: "a precondition said the vault had a content store".to_owned(),
    })?;
    let size = store.size(hash).map_err(|error| VaultError::Invariant {
        context: format!("the content store lost a file between a check and a write: {error}"),
    })?;
    crate::blob::stage(
        ctx.connection(),
        hash,
        i64::try_from(size).unwrap_or(i64::MAX),
    )?;
    let id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO note_asset (id, note_id, blob, name, media_type, position)
         VALUES (?1, ?2, ?3, ?4, ?5,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM note_asset WHERE note_id = ?2))",
        rusqlite::params![id, note, hash, name.trim(), media_type.trim()],
    )?;
    Ok(id)
}

#[derive(serde::Deserialize)]
struct AssetAddInput {
    id: String,
    blob: String,
    name: String,
    media_type: String,
}

fn asset_add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: AssetAddInput = ctx.parse_input()?;
    let asset = add_asset(ctx, &input.id, &input.blob, &input.name, &input.media_type)?;
    Ok(serde_json::json!({ "id": input.id, "asset_id": asset }))
}

/// A sentence when `asset` is not one of this note's.
fn asset_refusal(ctx: &CommandCtx<'_, '_>, asset: &str) -> Result<Option<String>> {
    let own: bool = ctx.connection().query_row(
        "SELECT EXISTS (SELECT 1 FROM note_asset WHERE id = ?1 AND note_id = ?2)",
        [asset, ctx.required_str("id")?],
        |row| row.get(0),
    )?;
    Ok((!own).then(|| "that file is not in this note".to_owned()))
}

fn pre_asset_remove(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_note(ctx, "id")? {
        return Ok(Some(sentence));
    }
    asset_refusal(ctx, ctx.required_str("asset_id")?)
}

fn asset_remove(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let asset = ctx.required_str("asset_id")?;
    let blob: String = ctx.connection().query_row(
        "SELECT blob FROM note_asset WHERE id = ?1",
        [asset],
        |row| row.get(0),
    )?;
    ctx.connection()
        .execute("DELETE FROM note_asset WHERE id = ?1", [asset])?;
    // The bytes are not released here: the version the commit door keeps of the note as it was
    // names them (`revision_blob`, slot `asset:<id>`), and they go when that version does.
    Ok(serde_json::json!({ "id": id, "blob": blob }))
}

fn pre_asset_reorder(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_note(ctx, "id")? {
        return Ok(Some(sentence));
    }
    let listed: Vec<&str> = ctx.input["order"]
        .as_array()
        .map(|items| items.iter().filter_map(serde_json::Value::as_str).collect())
        .unwrap_or_default();
    let held: BTreeSet<String> = ctx
        .connection()
        .prepare_cached("SELECT id FROM note_asset WHERE note_id = ?1")?
        .query_map([ctx.required_str("id")?], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let said: BTreeSet<String> = listed.iter().map(|id| (*id).to_owned()).collect();
    Ok((said != held || listed.len() != held.len())
        .then(|| "name each of the note's files once, in the order you want them".to_owned()))
}

fn asset_reorder(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let order: Vec<String> = ctx.input["order"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    for (place, asset) in order.iter().enumerate() {
        ctx.connection().execute(
            "UPDATE note_asset SET position = ?2 WHERE id = ?1",
            rusqlite::params![asset, place as f64 + 1.0],
        )?;
    }
    Ok(serde_json::json!({ "id": id }))
}

// ---------------------------------------------------------------------------
// Import and export (#1173, item 14)
// ---------------------------------------------------------------------------

use crate::commands::note_portable::{self as portable, Entry, Parsed, SourceFile};

/// The note an import file belongs beside: its folder and its stem, folded.
type NoteKey = (Option<String>, String);

/// An asset file of an import: the hash of its bytes, its name and its media type.
type AssetFile = (String, String, String);

/// The most files one import takes.
const IMPORT_MAX_FILES: usize = 5_000;

/// The files, as an array or (how a screen's act carries a list) as JSON text of one. A file is
/// its text, or (an asset) the hash of bytes the shell has put in the content store.
fn source_files(ctx: &CommandCtx<'_, '_>) -> Vec<SourceFile> {
    let listed = match ctx.input.get("files") {
        Some(serde_json::Value::String(text)) => {
            serde_json::from_str::<Vec<serde_json::Value>>(text).unwrap_or_default()
        }
        Some(serde_json::Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let text = |file: &serde_json::Value, key: &str| {
        file.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    listed
        .iter()
        .take(IMPORT_MAX_FILES)
        .filter_map(|file| {
            let blob = text(file, "blob");
            let words = text(file, "text");
            (blob.is_some() || words.is_some()).then(|| SourceFile {
                path: text(file, "path").unwrap_or_default(),
                text: words.unwrap_or_default(),
                blob,
                media_type: text(file, "media_type"),
            })
        })
        .filter(|file| !file.path.is_empty())
        .collect()
}

/// The live notes among `wanted` titles that already hold these words, as `(title, body)` with the
/// title folded as SQLite's `lower` does (ASCII). ONE SCAN of the vault's notes per command, not
/// one per imported note (#1202): only a note whose title an imported one carries is kept, so what
/// is held is bounded by the import, not the vault.
fn notes_held(
    ctx: &CommandCtx<'_, '_>,
    wanted: &BTreeSet<String>,
) -> Result<HashSet<(String, String)>> {
    let mut held = HashSet::new();
    if wanted.is_empty() {
        return Ok(held);
    }
    let mut live = ctx.connection().prepare_cached(
        "SELECT lower(e.title), n.body FROM entity e JOIN note n ON n.id = e.id
          WHERE e.kind = ?1 AND e.deleted_at IS NULL",
    )?;
    let mut rows = live.query([Kind::Note.as_str()])?;
    while let Some(row) = rows.next()? {
        let title: String = row.get(0)?;
        if wanted.contains(&title) {
            held.insert((title, row.get(1)?));
        }
    }
    Ok(held)
}

/// How many of the `titles` name a live linkable item already in the vault, by the same query a
/// save resolves with.
fn named_titles(ctx: &CommandCtx<'_, '_>, titles: &[String]) -> Result<HashSet<String>> {
    let mut named = HashSet::new();
    let mut statement = ctx.connection().prepare_cached(NAMED_BY)?;
    for title in titles {
        if named.contains(&title.to_lowercase()) {
            continue;
        }
        if statement.exists(rusqlite::params!["", title])? {
            named.insert(title.to_lowercase());
        }
    }
    Ok(named)
}

/// The notebook of this name, made at the top level when there is none.
fn notebook_named(ctx: &CommandCtx<'_, '_>, title: &str) -> Result<String> {
    let found: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT id FROM entity WHERE kind = ?1 AND deleted_at IS NULL
                AND title = ?2 COLLATE NOCASE ORDER BY created_at, id LIMIT 1",
            [Kind::Notebook.as_str(), title],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = found {
        return Ok(id);
    }
    let id = ctx.insert_entity_under(Kind::Notebook, title, None)?;
    ctx.connection().execute(
        "INSERT INTO container (id, kind, position)
         VALUES (?1, ?2,
                 (SELECT COALESCE(MAX(c.position), 0) + 1 FROM container c
                    JOIN entity e ON e.id = c.id
                   WHERE c.kind = ?2 AND e.parent_id IS NULL))",
        [id.as_str(), Kind::Notebook.as_str()],
    )?;
    Ok(id)
}

/// The asset files an import carries, keyed by the note they sit beside, that the store holds.
fn assets_by_note(
    ctx: &CommandCtx<'_, '_>,
    files: &[SourceFile],
) -> BTreeMap<NoteKey, Vec<AssetFile>> {
    let mut by_note: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for file in files {
        let (Some(hash), Some(((folder, stem), name))) =
            (file.blob.as_deref(), portable::asset_owner(&file.path))
        else {
            continue;
        };
        if bytes_refusal(ctx, hash).ok().flatten().is_some() {
            continue;
        }
        let media_type = file
            .media_type
            .clone()
            .filter(|kind| !kind.trim().is_empty())
            .unwrap_or_else(|| "application/octet-stream".to_owned());
        by_note
            .entry((folder, stem))
            .or_default()
            .push((hash.to_owned(), name, media_type));
    }
    by_note
}

/// `note.import`: read Markdown and text files as notes, with their `[[links]]`, `#tags`, journal
/// day and assets. With `dry_run` it writes nothing and answers what importing would do, for the
/// preview the member confirms. A note the vault already has (same title, same words) is skipped,
/// so importing twice adds nothing. It is a one-time arrival: each note is stamped with how it
/// came, and no origin or source is made.
fn import(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let dry_run = ctx
        .input
        .get("dry_run")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let files = source_files(ctx);
    let total = files.len();
    // A file longer than a note may be is not imported, and is counted with the files that are not
    // notes: one big file never costs a folder its other notes.
    let parsed: Vec<(Parsed, Option<NoteKey>)> = files
        .iter()
        .filter(|file| file.text.len() <= BODY_BUDGET_BYTES)
        .filter_map(|file| {
            portable::parse(file).map(|note| (note, portable::owner_key(&file.path)))
        })
        .collect();
    let mut assets = assets_by_note(ctx, &files);
    // THE VAULT IS READ ONCE, and a file's twin is found by hash: the work is bounded by
    // construction.
    let held = notes_held(
        ctx,
        &parsed
            .iter()
            .map(|(note, _)| note.title.to_ascii_lowercase())
            .collect(),
    )?;
    let mut fresh: Vec<(Parsed, Option<NoteKey>)> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut skipped = 0_usize;
    for (note, key) in parsed {
        let twin = (note.title.to_ascii_lowercase(), note.body.clone());
        if held.contains(&twin) || !seen.insert(twin) {
            skipped += 1;
        } else {
            fresh.push((note, key));
        }
    }
    let tags: BTreeSet<String> = fresh
        .iter()
        .flat_map(|(note, _)| note.tags.iter().map(|tag| tag.to_lowercase()))
        .collect();
    let notebooks: BTreeSet<String> = fresh
        .iter()
        .filter_map(|(note, _)| note.notebook.as_ref().map(|name| name.to_lowercase()))
        .collect();
    let imported_titles: BTreeSet<String> = fresh
        .iter()
        .map(|(note, _)| note.title.to_lowercase())
        .collect();
    let (mut links, mut unresolved) = (0_usize, 0_usize);
    let said: Vec<Vec<String>> = fresh
        .iter()
        .map(|(note, _)| wikilinks(&note.body))
        .collect();
    let named = named_titles(ctx, &said.iter().flatten().cloned().collect::<Vec<_>>())?;
    for title in said.iter().flatten() {
        if imported_titles.contains(&title.to_lowercase()) || named.contains(&title.to_lowercase())
        {
            links += 1;
        } else {
            unresolved += 1;
        }
    }
    let taken: usize = fresh
        .iter()
        .filter_map(|(_, key)| key.as_ref().and_then(|key| assets.get(key)))
        .map(Vec::len)
        .sum();
    let ignored = total - fresh.len() - skipped - taken;
    let mut report = serde_json::json!({
        "notes": fresh.len(),
        "skipped": skipped,
        "ignored": ignored,
        "tags": tags.len(),
        "notebooks": notebooks.len(),
        "assets": taken,
        "links": links,
        "unresolved": unresolved,
        "dry_run": dry_run,
    });
    if dry_run {
        return Ok(report);
    }
    let mut books: BTreeMap<String, String> = BTreeMap::new();
    let mut made: Vec<String> = Vec::new();
    for (note, key) in &fresh {
        let notebook = match &note.notebook {
            Some(name) => {
                let folded = name.to_lowercase();
                if !books.contains_key(&folded) {
                    books.insert(folded.clone(), notebook_named(ctx, name)?);
                }
                books.get(&folded).cloned()
            }
            None => None,
        };
        // A day the file names that is not one is dropped, not refused: the words are what came.
        let day = note.journal_on.as_deref().filter(|day| {
            ctx.connection()
                .query_row("SELECT date(?1) IS ?1", [day], |row| row.get(0))
                .unwrap_or(false)
        });
        let id = found(
            ctx,
            &Founding {
                title: &note.title,
                body: &note.body,
                notebook: notebook.as_deref(),
                journal_on: day,
                ..Founding::default()
            },
        )?;
        for tag in &note.tags {
            let known: i64 = ctx.connection().query_row(
                "SELECT COUNT(*) FROM concept WHERE kind = ?1 AND key = ?2",
                [Kind::Tag.as_str(), &crate::model::fold_label(tag)],
                |row| row.get(0),
            )?;
            let concept = ensure_concept(ctx, Kind::Tag, tag)?;
            if known == 0 {
                ctx.connection().execute(
                    "UPDATE concept SET color = ?2 WHERE id = ?1",
                    [concept.as_str(), next_color(ctx)?],
                )?;
            }
            set_tagged(ctx, &id, &concept, true)?;
        }
        for (hash, name, media_type) in key
            .as_ref()
            .and_then(|key| assets.remove(key))
            .unwrap_or_default()
        {
            add_asset(ctx, &id, &hash, &name, &media_type)?;
        }
        arrival::record(ctx, &id, Kind::Note)?;
        made.push(id);
    }
    // A link to a note imported after the one that names it resolved when that note was made
    // (`resolve_waiting`): nothing to do here.
    report["ids"] = serde_json::json!(made);
    Ok(report)
}

#[derive(serde::Deserialize)]
struct ExportNoteInput {
    notebook_id: Option<String>,
}

/// `note.export`: the member's notes (a notebook's, or all) as Markdown files in an archive, a
/// folder per notebook, `[[links]]` as written, tags and the journal day in front matter, each
/// note's assets beside it. Writes nothing.
fn export(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: ExportNoteInput = ctx.parse_input()?;
    let archive = markdown_entries(ctx.connection(), ctx.blobs(), input.notebook_id.as_deref())?;
    let count = archive.notes;
    let bytes = portable::zip(&archive.entries);
    Ok(serde_json::json!({
        "name": format!("{}.zip", archive.name),
        "media_type": "application/zip",
        "count": count,
        "missing_assets": archive.missing_assets,
        "content": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
    }))
}

/// The Markdown files of the member's notes.
pub(crate) struct Archive {
    pub name: String,
    pub entries: Vec<Entry>,
    pub notes: usize,
    /// Assets whose bytes the store no longer holds: named, not silently dropped.
    pub missing_assets: usize,
}

/// The archive's name and the Markdown files of the member's notes (a notebook's with the
/// notebooks in it, or all), a folder per notebook, each note's assets in `<stem>.assets/` beside
/// it. `note.export` zips them; the whole-vault export writes the same entries under `Notes/`.
pub(crate) fn markdown_entries(
    connection: &rusqlite::Connection,
    blobs: Option<&(dyn crate::bytes::BlobStore + Send + Sync)>,
    notebook: Option<&str>,
) -> Result<Archive> {
    let mut archive_name = "Notes".to_owned();
    if let Some(id) = notebook {
        let title: Option<String> = connection
            .query_row("SELECT title FROM entity WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?;
        archive_name = title.map_or_else(|| "Notes".to_owned(), |t| portable::file_stem(&t));
    }
    let mut statement = connection.prepare_cached(
        "WITH RECURSIVE scope(id) AS (
           SELECT id FROM entity WHERE id = ?2
           UNION
           SELECT e.id FROM entity e JOIN scope s ON e.parent_id = s.id
            WHERE e.kind = ?3 AND e.deleted_at IS NULL)
         SELECT e.id, e.title, n.body, n.journal_on, nb.title
           FROM entity e JOIN note n ON n.id = e.id
           LEFT JOIN entity nb ON nb.id = e.parent_id AND nb.deleted_at IS NULL
          WHERE e.kind = ?4 AND e.deleted_at IS NULL
            AND (?1 = 0 OR e.parent_id IN (SELECT id FROM scope))
          ORDER BY e.n",
    )?;
    let rows = statement
        .query_map(
            rusqlite::params![
                i64::from(notebook.is_some()),
                notebook,
                Kind::Notebook.as_str(),
                Kind::Note.as_str()
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut tags = connection.prepare_cached(
        "SELECT c.key FROM edge t JOIN concept c ON c.id = t.to_id AND c.kind = ?2
          WHERE t.from_id = ?1 AND t.rel = 'tagged' ORDER BY c.key",
    )?;
    let mut assets = connection.prepare_cached(
        "SELECT a.name, a.blob, b.size FROM note_asset a JOIN blob b ON b.hash = a.blob
          WHERE a.note_id = ?1 ORDER BY a.position, a.id",
    )?;
    let mut used: BTreeSet<String> = BTreeSet::new();
    let mut entries: Vec<Entry> = Vec::new();
    let (mut weight, mut missing_assets) = (0_i64, 0_usize);
    let notes = rows.len();
    for (id, title, body, day, book) in rows {
        let labels = tags
            .query_map([id.as_str(), Kind::Tag.as_str()], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let folder = book.map(|name| portable::file_stem(&name));
        let stem = portable::file_stem(&title);
        let place = |name: &str| match &folder {
            Some(folder) => format!("{folder}/{name}"),
            None => name.to_owned(),
        };
        let mut stem_used = stem.clone();
        let mut again = 1;
        while !used.insert(place(&format!("{stem_used}.md")).to_lowercase()) {
            again += 1;
            stem_used = format!("{stem} {again}");
        }
        entries.push(Entry {
            path: place(&format!("{stem_used}.md")),
            bytes: portable::markdown_of(&title, &body, &labels, day.as_deref()).into_bytes(),
        });
        let held = assets
            .query_map([&id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut names: BTreeSet<String> = BTreeSet::new();
        for (name, hash, size) in held {
            weight += size;
            if weight > EXPORT_ASSET_BYTES {
                return Err(VaultError::InvalidInput {
                    name: "notebook_id".to_owned(),
                    detail: "the files in these notes are too many bytes for one archive; export \
                             a smaller notebook, or the whole vault"
                        .to_owned(),
                });
            }
            let bytes = blobs.and_then(|store| store.get(&hash).ok());
            let Some(bytes) = bytes else {
                missing_assets += 1;
                continue;
            };
            let mut file = portable::file_name(&name);
            let mut times = 1;
            while !names.insert(file.to_lowercase()) {
                times += 1;
                file = format!("{times} {}", portable::file_name(&name));
            }
            entries.push(Entry {
                path: place(&format!("{stem_used}{}/{file}", portable::ASSETS_SUFFIX)),
                bytes,
            });
        }
    }
    Ok(Archive {
        name: archive_name,
        entries,
        notes,
        missing_assets,
    })
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const CREATE: &[CommandCondition] = &[CommandCondition {
        predicate: "note_has_a_title_a_body_within_budget_a_day_and_a_notebook",
        check: pre_create,
    }];
    const EDIT: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "note_is_live_and_titled_and_body_within_budget_and_a_day",
            check: pre_edit,
        },
    ];
    const RESTORE: &[CommandCondition] = &[CommandCondition {
        predicate: "note_is_live_and_version_is_its_own",
        check: pre_restore_version,
    }];
    const ASSET_ADD: &[CommandCondition] = &[CommandCondition {
        predicate: "note_is_live_and_file_is_named_and_its_bytes_are_held",
        check: pre_asset_add,
    }];
    const ASSET_REMOVE: &[CommandCondition] = &[CommandCondition {
        predicate: "note_is_live_and_file_is_its_own",
        check: pre_asset_remove,
    }];
    const ASSET_REORDER: &[CommandCondition] = &[CommandCondition {
        predicate: "note_is_live_and_order_names_each_file_once",
        check: pre_asset_reorder,
    }];
    vec![
        CommandDefinition::plain(
            "note.import",
            "note",
            concat!(
                r#"{
              "type": "object",
              "required": ["files"],
              "additionalProperties": false,
              "properties": {
                "files": { "type": ["array", "string"] },
                "dry_run": { "type": "boolean" },
                "#,
                arrival::arrived_property!(),
                r#"
              }
            }"#
            ),
            Idempotency::Idempotent,
            &[],
            import,
        ),
        CommandDefinition::plain(
            "note.export",
            "note",
            r#"{
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "notebook_id": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Idempotent,
            &[],
            export,
        ),
        CommandDefinition::plain(
            "note.create",
            "note",
            r#"{
              "type": "object",
              "required": ["title"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "maxLength": 1000 },
                "body": { "type": "string" },
                "format": { "type": "string", "enum": ["markdown", "plain"] },
                "notebook_id": { "type": ["string", "null"] },
                "journal_on": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Once,
            CREATE,
            create,
        ),
        CommandDefinition::plain(
            "note.edit",
            "note",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "maxLength": 1000 },
                "body": { "type": "string" },
                "format": { "type": "string", "enum": ["markdown", "plain"] },
                "journal_on": { "type": ["string", "null"] },
                "expected_rev": { "type": "integer", "minimum": 0 }
              }
            }"#,
            Idempotency::Idempotent,
            EDIT,
            edit,
        ),
        CommandDefinition::plain(
            "note.restore_version",
            "note",
            r#"{
              "type": "object",
              "required": ["id", "seq"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "seq": { "type": "integer", "minimum": 1 }
              }
            }"#,
            Idempotency::Idempotent,
            RESTORE,
            restore_version,
        ),
        CommandDefinition::plain(
            "note.asset_add",
            "note",
            r#"{
              "type": "object",
              "required": ["id", "blob", "name", "media_type"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "blob": { "type": "string", "minLength": 64, "maxLength": 64 },
                "name": { "type": "string", "maxLength": 255 },
                "media_type": { "type": "string", "maxLength": 255 }
              }
            }"#,
            Idempotency::Once,
            ASSET_ADD,
            asset_add,
        ),
        CommandDefinition::plain(
            "note.asset_remove",
            "note",
            r#"{
              "type": "object",
              "required": ["id", "asset_id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "asset_id": { "type": "string", "minLength": 1 }
              }
            }"#,
            Idempotency::Idempotent,
            ASSET_REMOVE,
            asset_remove,
        ),
        CommandDefinition::plain(
            "note.asset_reorder",
            "note",
            r#"{
              "type": "object",
              "required": ["id", "order"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "order": { "type": "array", "items": { "type": "string" } }
              }
            }"#,
            Idempotency::Idempotent,
            ASSET_REORDER,
            asset_reorder,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::wikilinks;

    #[test]
    fn a_wikilink_is_two_brackets_on_one_line_with_something_between() {
        assert_eq!(
            wikilinks("see [[Plan]] and [[ plan ]] and [[Mum]]"),
            ["Plan", "plan", "Mum"]
        );
        assert!(wikilinks("[[]] [[   ]] [[unclosed").is_empty());
        assert!(wikilinks("[[one\ntwo]]").is_empty());
        assert_eq!(wikilinks("[[a [[b]]"), ["b"]);
    }
}
