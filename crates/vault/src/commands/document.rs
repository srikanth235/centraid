//! `document.*`: a file the member keeps — add one, write one, replace its bytes, restore an older
//! version. The files a phone's folder holds are followed through [`FILES`].
//!
//! A document is an entity of kind `document` over one blob: the bytes' hash and what they are
//! (`media_type`) are columns of its row. **A folder is a place** (C2): a document sits in exactly
//! one folder or at the top level, and that is its home, `entity.parent_id`, like every kind's. A
//! document is made in a folder (`folder_id` at add) and moved with the shared `entity.move`; a
//! folder sits in a folder the same way; trashing a folder takes everything in it to the trash
//! (`trashed_by`) and restoring it brings back exactly that, and a document restored out of a
//! trashed folder lands at the top level. A document that belongs in two places gets a tag. Two
//! sibling folders may repeat a name. Identity is the wrapper, not the bytes: two documents may
//! share one blob, and adding the same file twice is two documents over one set of bytes, which
//! the blob plane stores once.
//!
//! Everything else a member does to a document is a shared verb: the name (`entity.retitle`), the
//! trash, the purge and the emptied trash (`entity.*`), a star (`entity.star`), a label
//! (`tag.add`), a folder (`container.create` of kind `folder`), an attachment to anything
//! (`edge.add`), and the words extracted from the bytes (`derivative.write` of variant `text`).
//! What is here is what only a document has.
//!
//! ## A version is the bytes that were replaced
//!
//! Replacing a document's bytes changes `document.blob`; **the commit door keeps the bytes it had**
//! (a `revision` whose `revision_blob` row, slot `blob`, names them, B3), so a document's earlier
//! bytes live as long as the document does and a trashed document keeps them until its purge. A
//! collection in the same commit cannot take them (the version about to be written names them).
//! A restore writes the current bytes as a version and the chosen ones as current, and a replace
//! or a restore that lands on the bytes already there writes nothing.
//!
//! ## Text
//!
//! A document whose media type is `text/*` can be written in place: `document.create_text` and
//! `document.edit` put the words into the content store through the command's blob door, claim the
//! blob, and keep the words as the blob's `text` derivative, which is what the search index reads.
//! The words are bounded like a note's body; a larger file is added as bytes, and its extracted
//! text is the phone's `derivative.write` (or the `text` a command carries with the file).
//!
//! ## A followed folder
//!
//! A folder a phone picks is a followed store ([`FILES`], the `files` system): its files fill one
//! folder of the vault, a file changed on the phone is a new version of its document, a file the
//! member renamed or replaced keeps the member's word, and a file gone from a complete read goes
//! to the trash unless the member edited it.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value as Json;

use crate::commands::entity::{self, STALE_GUARD, home_refusal, lookup_live, with_rev};
use crate::commands::follow::{Child, Gone, Match, OriginRow, SystemMap};
use crate::commands::note::BODY_BUDGET_BYTES;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, arrival};
use crate::error::{Result, VaultError};
use crate::model::Kind;

/// A sentence when the folder the command names (`folder_id`) cannot hold a document: it is not
/// there, it is in the trash, or it is not a folder.
pub(crate) fn folder_refusal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    home_refusal(
        ctx.connection(),
        Kind::Document,
        None,
        ctx.optional_str("folder_id"),
    )
}

/// A sentence when the bytes `key` names cannot be claimed: they are not claimed yet and the
/// command did not say how large they are (`size_key`).
///
/// **A command claims the bytes it names** (R-1135-5-9): the stage door only claims what the
/// phone counted, and a row never points at bytes nobody claimed.
pub(crate) fn pre_claimable(
    ctx: &CommandCtx<'_, '_>,
    key: &str,
    size_key: &str,
) -> Result<Option<String>> {
    let Some(hash) = ctx.optional_str(key) else {
        return Ok(None);
    };
    let held: i64 =
        ctx.connection()
            .query_row("SELECT COUNT(*) FROM blob WHERE hash = ?1", [hash], |row| {
                row.get(0)
            })?;
    let sized = ctx.input.get(size_key).is_some_and(|size| !size.is_null());
    Ok((held == 0 && !sized)
        .then(|| "those bytes have not been counted; say how large they are".to_owned()))
}

/// Claim the bytes `key` names at the size the phone counted (`size_key`); bytes already claimed
/// are left as they are, and their size must agree.
pub(crate) fn claim(ctx: &CommandCtx<'_, '_>, key: &str, size_key: &str) -> Result<()> {
    if let (Some(hash), Some(size)) = (
        ctx.optional_str(key),
        ctx.input.get(size_key).and_then(Json::as_i64),
    ) {
        crate::blob::stage(ctx.connection(), hash, size)?;
    }
    Ok(())
}

pub(crate) fn no_store(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    ctx.blobs()
        .is_none()
        .then(|| "this vault has nowhere to keep a file's bytes".to_owned())
}

fn title_refusal(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    ctx.optional_str("title")
        .is_some_and(|title| title.trim().is_empty())
        .then(|| "a document needs a name".to_owned())
}

/// A live document: a trashed one is frozen, restore it first.
fn live_document(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(
        match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
            Err(sentence) => Some(sentence),
            Ok(found) if found.kind != Kind::Document => Some(format!(
                "“{}” is a {}, not a document",
                found.title,
                found.kind.noun()
            )),
            Ok(_) => None,
        },
    )
}

fn words_refusal(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    let words = ctx.optional_str("body_text")?;
    (words.len() > BODY_BUDGET_BYTES).then(|| {
        format!(
            "those words are {} bytes, over the {BODY_BUDGET_BYTES}-byte budget for a document \
             written here; add the file instead",
            words.len()
        )
    })
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("a document needs a name".to_owned()));
    }
    if let Some(sentence) = pre_claimable(ctx, "blob", "size")? {
        return Ok(Some(sentence));
    }
    folder_refusal(ctx)
}

fn pre_create_text(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("a document needs a name".to_owned()));
    }
    if let Some(sentence) = no_store(ctx).or_else(|| words_refusal(ctx)) {
        return Ok(Some(sentence));
    }
    folder_refusal(ctx)
}

/// The media type of the document's current bytes.
pub(crate) fn media_type_of(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<Option<String>> {
    Ok(ctx
        .connection()
        .query_row(
            "SELECT media_type FROM document WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?)
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = live_document(ctx)? {
        return Ok(Some(sentence));
    }
    let media_type = media_type_of(ctx, ctx.required_str("id")?)?.unwrap_or_default();
    if ctx.optional_str("body_text").is_some()
        && !crate::blob::base_media_type(&media_type).starts_with("text/")
    {
        return Ok(Some(format!(
            "this document is {media_type}; its words can only be written in place when it is \
             text — replace its bytes instead"
        )));
    }
    if ctx.optional_str("body_text").is_some()
        && let Some(sentence) = no_store(ctx).or_else(|| words_refusal(ctx))
    {
        return Ok(Some(sentence));
    }
    Ok(title_refusal(ctx))
}

fn pre_replace(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = live_document(ctx)? {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = pre_claimable(ctx, "blob", "size")? {
        return Ok(Some(sentence));
    }
    Ok(title_refusal(ctx))
}

fn pre_restore_version(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = live_document(ctx)? {
        return Ok(Some(sentence));
    }
    let held: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM revision WHERE entity_id = ?1 AND seq = ?2",
        rusqlite::params![ctx.required_str("id")?, ctx.input["seq"].as_i64()],
        |row| row.get(0),
    )?;
    Ok((held == 0).then(|| "That version is not in this document's history.".to_owned()))
}

/// Found a document over bytes already claimed: the entity in its folder and the kind row.
///
/// The one birth of a document, public so any command that files a document the same way reaches
/// one place.
pub fn found(
    ctx: &CommandCtx<'_, '_>,
    id: Option<&str>,
    title: &str,
    blob: &str,
    media_type: &str,
    folder: Option<&str>,
) -> Result<String> {
    let title = title.trim();
    let id = match id {
        Some(id) => {
            ctx.insert_entity_in(id, Kind::Document, title, folder)?;
            id.to_owned()
        }
        None => ctx.insert_entity_under(Kind::Document, title, folder)?,
    };
    ctx.connection().execute(
        "INSERT INTO document (id, blob, media_type) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, blob, media_type],
    )?;
    Ok(id)
}

/// Make `blob` the document's bytes. The ones it had are kept as a version by the commit door
/// ([`crate::history`]). Returns whether anything changed.
fn set_content(ctx: &CommandCtx<'_, '_>, id: &str, blob: &str, media_type: &str) -> Result<bool> {
    let changed = ctx.connection().execute(
        "UPDATE document SET blob = ?2, media_type = ?3
          WHERE id = ?1 AND (blob <> ?2 OR media_type <> ?3)",
        rusqlite::params![id, blob, media_type],
    )?;
    Ok(changed > 0)
}

/// Write words into the content store, claim them, and keep them as the text the search index
/// reads. Returns the blob's hash.
pub(crate) fn write_words(ctx: &CommandCtx<'_, '_>, words: &str) -> Result<String> {
    let store = ctx.blobs().ok_or_else(|| VaultError::Invariant {
        context: "a precondition said the vault had a content store".to_owned(),
    })?;
    let hash = store
        .put(words.as_bytes())
        .map_err(|error| VaultError::Invariant {
            context: format!("the content store refused a document's words: {error}"),
        })?;
    crate::blob::stage(
        ctx.connection(),
        &hash,
        i64::try_from(words.len()).unwrap_or(i64::MAX),
    )?;
    crate::blob::write_derivative(ctx.connection(), &ctx.now, &hash, "text", None, Some(words))?;
    Ok(hash)
}

/// The words the phone read out of the bytes (a PDF's text, a scan's OCR), when it sent them with
/// the file: they are the blob's `text` derivative, so the document is found by them from the
/// first moment.
fn keep_extracted_text(ctx: &CommandCtx<'_, '_>, blob: &str, text: Option<&str>) -> Result<()> {
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        crate::blob::write_derivative(ctx.connection(), &ctx.now, blob, "text", None, Some(text))?;
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct AddDocumentInput {
    id: Option<String>,
    title: String,
    blob: String,
    media_type: String,
    folder_id: Option<String>,
    text: Option<String>,
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: AddDocumentInput = ctx.parse_input()?;
    claim(ctx, "blob", "size")?;
    keep_extracted_text(ctx, &input.blob, input.text.as_deref())?;
    let id = found(
        ctx,
        input.id.as_deref(),
        &input.title,
        &input.blob,
        &input.media_type,
        input.folder_id.as_deref(),
    )?;
    arrival::record(ctx, &id, Kind::Document)?;
    Ok(serde_json::json!({ "id": id }))
}

#[derive(serde::Deserialize)]
struct CreateTextInput {
    id: Option<String>,
    title: String,
    body_text: Option<String>,
    media_type: Option<String>,
    folder_id: Option<String>,
}

fn create_text(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: CreateTextInput = ctx.parse_input()?;
    let hash = write_words(ctx, input.body_text.as_deref().unwrap_or_default())?;
    let id = found(
        ctx,
        input.id.as_deref(),
        &input.title,
        &hash,
        input.media_type.as_deref().unwrap_or("text/plain"),
        input.folder_id.as_deref(),
    )?;
    Ok(serde_json::json!({ "id": id }))
}

#[derive(serde::Deserialize)]
struct EditDocumentInput {
    id: String,
    body_text: Option<String>,
    title: Option<String>,
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: EditDocumentInput = ctx.parse_input()?;
    if let Some(words) = input.body_text.as_deref() {
        let hash = write_words(ctx, words)?;
        let media_type = media_type_of(ctx, &input.id)?.unwrap_or_default();
        set_content(ctx, &input.id, &hash, &media_type)?;
    }
    if let Some(title) = input.title.as_deref() {
        entity::rename(ctx, &input.id, title.trim())?;
    }
    with_rev(ctx, &input.id, serde_json::json!({ "id": input.id }))
}

#[derive(serde::Deserialize)]
struct ReplaceDocumentInput {
    id: String,
    blob: String,
    media_type: Option<String>,
    title: Option<String>,
    text: Option<String>,
}

fn replace(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: ReplaceDocumentInput = ctx.parse_input()?;
    let media_type = match input.media_type {
        Some(media_type) => media_type,
        None => media_type_of(ctx, &input.id)?.unwrap_or_default(),
    };
    claim(ctx, "blob", "size")?;
    keep_extracted_text(ctx, &input.blob, input.text.as_deref())?;
    let replaced = set_content(ctx, &input.id, &input.blob, &media_type)?;
    if let Some(title) = input.title.as_deref() {
        entity::rename(ctx, &input.id, title.trim())?;
    }
    Ok(serde_json::json!({ "id": input.id, "replaced": replaced }))
}

#[derive(serde::Deserialize)]
struct RestoreDocumentVersionInput {
    id: String,
    seq: Option<i64>,
}

fn restore_version(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: RestoreDocumentVersionInput = ctx.parse_input()?;
    // The bytes of the version: one path with every other restore (`history.restore_version`),
    // limited to the content, as this verb always was.
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
// The phone's files, followed
// ---------------------------------------------------------------------------

/// What a source last said of a record beyond what the model keeps, read back from
/// `source.stated`: the member cannot edit it, so the row always agrees with it, and a changed
/// statement is recorded by the engine and written nowhere else.
fn stated_read(connection: &Connection, id: &str) -> Result<Json> {
    let stated: Option<String> = connection
        .query_row(
            "SELECT s.stated FROM source s JOIN origin o ON o.id = s.origin_id
              WHERE s.entity_id = ?1 AND o.retired_at IS NULL
              ORDER BY s.seen_at DESC, s.id LIMIT 1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(stated
        .and_then(|text| serde_json::from_str::<Json>(&text).ok())
        .and_then(|stated| stated.get("stat").cloned())
        .unwrap_or(Json::Null))
}

fn stated_canon(value: &Json) -> Json {
    value.clone()
}

fn stated_merge(_: &CommandCtx<'_, '_>, _: &str, _: Option<&Json>, _: &Json) -> Result<bool> {
    Ok(false)
}

fn stated_take(_: &CommandCtx<'_, '_>, _: &str, _: Option<&str>, _: &Json) -> Result<bool> {
    Ok(false)
}

/// A file's size and modification time as the phone last stated them.
///
/// The phone's cheap pre-check rides in the statement: a rescan of an unchanged folder reads no
/// bytes, because the phone asks the vault what each file last stated (`source.stated`) and
/// stages a file only when its size or time moved.
const STAT: Child = Child {
    name: "stat",
    read: |connection, id| stated_read(connection, id),
    canon: stated_canon,
    merge: stated_merge,
    items: None,
    take: stated_take,
    stamp: None,
};

/// What a file nobody said the type of is.
const UNKNOWN_TYPE: &str = "application/octet-stream";

fn file_defaults(
    _: &Connection,
    _: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(vec![(
        "media_type",
        rusqlite::types::Value::Text(UNKNOWN_TYPE.to_owned()),
    )])
}

fn as_stated(
    _: &CommandCtx<'_, '_>,
    _: &mut serde_json::Map<String, Json>,
) -> std::result::Result<(), String> {
    Ok(())
}

fn nothing_to_settle(_: &CommandCtx<'_, '_>, _: &str) -> Result<()> {
    Ok(())
}

/// The `files` system: a document of the folder a phone's picked folder fills, over the bytes the
/// phone staged. A file is found again by its name; a file the phone no longer holds goes to the
/// trash unless the member edited it.
pub const FILES: SystemMap = SystemMap {
    system: "files",
    command: "follow.files",
    kind: Kind::Document,
    claims: Some("blob"),
    fields: &["blob", "media_type"],
    fixed: &[],
    children: &[STAT],
    match_on: &[Match::Title],
    gone: Gone::Trash,
    window: None,
    defaults: file_defaults,
    founds: None,
    shape: as_stated,
    settle: nothing_to_settle,
    named: nothing_to_settle,
};

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const ADD: &[CommandCondition] = &[CommandCondition {
        predicate: "document_has_a_name_arrived_bytes_and_a_folder",
        check: pre_add,
    }];
    const CREATE_TEXT: &[CommandCondition] = &[CommandCondition {
        predicate: "document_has_a_name_words_within_budget_and_a_folder",
        check: pre_create_text,
    }];
    const EDIT: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "document_is_live_text_and_words_within_budget",
            check: pre_edit,
        },
    ];
    const REPLACE: &[CommandCondition] = &[CommandCondition {
        predicate: "document_is_live_and_bytes_arrived",
        check: pre_replace,
    }];
    const RESTORE: &[CommandCondition] = &[CommandCondition {
        predicate: "document_is_live_and_version_is_its_own",
        check: pre_restore_version,
    }];
    vec![
        CommandDefinition::plain(
            "document.add",
            "document",
            concat!(
                r#"{
              "type": "object",
              "required": ["title", "blob", "media_type"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "maxLength": 1000 },
                "blob": { "type": "string", "minLength": 64, "maxLength": 64 },
                "media_type": { "type": "string", "minLength": 1 },
                "size": { "type": "integer", "minimum": 0 },
                "folder_id": { "type": ["string", "null"] },
                "text": { "type": "string", "maxLength": 200000 },
                "#,
                crate::commands::arrival::arrived_property!(),
                r#"
              }
            }"#
            ),
            Idempotency::Once,
            ADD,
            add,
        ),
        CommandDefinition::plain(
            "document.create_text",
            "document",
            r#"{
              "type": "object",
              "required": ["title"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "maxLength": 1000 },
                "body_text": { "type": "string" },
                "media_type": { "type": "string", "enum": ["text/plain", "text/markdown"] },
                "folder_id": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Once,
            CREATE_TEXT,
            create_text,
        ),
        CommandDefinition::plain(
            "document.edit",
            "document",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "body_text": { "type": "string" },
                "title": { "type": "string", "maxLength": 1000 },
                "expected_rev": { "type": "integer", "minimum": 0 }
              }
            }"#,
            Idempotency::Idempotent,
            EDIT,
            edit,
        ),
        CommandDefinition::plain(
            "document.replace",
            "document",
            r#"{
              "type": "object",
              "required": ["id", "blob"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "blob": { "type": "string", "minLength": 64, "maxLength": 64 },
                "size": { "type": "integer", "minimum": 0 },
                "media_type": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "maxLength": 1000 },
                "text": { "type": "string", "maxLength": 200000 }
              }
            }"#,
            Idempotency::Idempotent,
            REPLACE,
            replace,
        ),
        CommandDefinition::plain(
            "document.restore_version",
            "document",
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
    ]
}
