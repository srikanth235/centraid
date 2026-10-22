//! `document.*`: a file the member keeps — add one, write one, replace its
//! bytes, restore an older version, file it.
//!
//! A document is an entity of kind `document` over one blob: the bytes' hash and
//! what they are (`media_type`) are columns of its row, and the folder it is
//! filed in is one more (`folder_id`; none is the top level). Identity is the
//! wrapper, not the bytes: two documents may share one blob, and adding the same
//! file twice is two documents over one set of bytes, which the blob plane
//! stores once.
//!
//! Everything else a member does to a document is a shared verb: the name
//! (`entity.retitle`), the trash, the purge and the emptied trash
//! (`entity.*`), a star (`flag.set`), a label (`tag.add`), a folder
//! (`container.create` of kind `folder`, `entity.retitle`, `entity.trash`), an
//! attachment to anything (`edge.add`), and the words extracted from the bytes
//! (`derivative.write` of variant `text`). What is here is what only a
//! document has.
//!
//! ## A version is the bytes that were replaced
//!
//! Replacing a document's bytes writes the bytes it had as a `revision` (`seq`
//! counts up from one); the current bytes live only on the document. A restore
//! writes the current bytes as a revision and the chosen ones as current, and a
//! replace or a restore that lands on the bytes already there writes nothing.
//! A revision names its blob, so a document's earlier bytes live as long as the
//! document does, and a trashed document keeps them all until its purge.
//!
//! ## Text
//!
//! A document whose media type is `text/*` can be written in place:
//! [`document.create_text`](definitions) and `document.edit` put the words into
//! the content store through the command's blob door, claim the blob, and keep
//! the words as the blob's `text` derivative, which is what the search index
//! reads. The words are bounded like a note's body; a larger file is added as
//! bytes, and its extracted text is the phone's `derivative.write`.

use rusqlite::OptionalExtension;

use crate::commands::blob::{claim, pre_claimable};
use crate::commands::entity::lookup_live;
use crate::commands::note::BODY_BUDGET_BYTES;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::Kind;

/// A folder a document may be filed in: there, live and a folder.
fn folder_refusal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(id) = ctx.optional_str("folder_id") else {
        return Ok(None);
    };
    Ok(match lookup_live(ctx.connection(), id)? {
        Err(sentence) => Some(sentence),
        Ok(found) if found.kind != Kind::Folder => Some(format!(
            "“{}” is a {}, not a folder",
            found.title,
            found.kind.noun()
        )),
        Ok(_) => None,
    })
}

fn title_refusal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(ctx
        .optional_str("title")
        .is_some_and(|title| title.trim().is_empty())
        .then(|| "a document needs a name".to_owned()))
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

fn no_store(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    ctx.blobs()
        .is_none()
        .then(|| "this vault has nowhere to keep a file's bytes".to_owned())
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("a document needs a name".to_owned()));
    }
    if let Some(sentence) = pre_claimable(ctx, "blob")? {
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
fn media_type_of(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<Option<String>> {
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
    if ctx.optional_str("body_text").is_some() && !media_type.starts_with("text/") {
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
    title_refusal(ctx)
}

fn pre_replace(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = live_document(ctx)? {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = pre_claimable(ctx, "blob")? {
        return Ok(Some(sentence));
    }
    title_refusal(ctx)
}

fn pre_move(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = live_document(ctx)? {
        return Ok(Some(sentence));
    }
    folder_refusal(ctx)
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

/// Found a document over bytes already claimed: the entity and the kind row.
///
/// The one birth of a document, public so a follower's `add` and any command that
/// files a document the same way reach one place.
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
            ctx.insert_entity_as(id, Kind::Document, title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Document, title)?,
    };
    ctx.connection().execute(
        "INSERT INTO document (id, blob, media_type, folder_id) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, blob, media_type, folder],
    )?;
    Ok(id)
}

/// Put a document's current bytes down as its newest revision, if they are about
/// to be replaced by `blob` of `media_type`. Returns whether they differ.
pub(crate) fn keep_replaced(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    blob: &str,
    media_type: &str,
) -> Result<bool> {
    let (held, held_type): (String, String) = ctx.connection().query_row(
        "SELECT blob, media_type FROM document WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if held == blob && held_type == media_type {
        return Ok(false);
    }
    ctx.connection().execute(
        "INSERT INTO revision (entity_id, seq, at, blob, media_type)
         VALUES (?1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM revision WHERE entity_id = ?1),
                 ?2, ?3, ?4)",
        rusqlite::params![id, ctx.now, held, held_type],
    )?;
    Ok(true)
}

/// The files follower's hook: a source that states other bytes for a document the
/// member never changed replaces them, and the ones it had become a revision.
pub(crate) fn keep_replaced_by_write(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    writes: &[(&str, &serde_json::Value)],
) -> Result<()> {
    let stated = |name: &str| {
        writes
            .iter()
            .find(|(written, _)| *written == name)
            .and_then(|(_, value)| value.as_str())
    };
    if stated("blob").is_none() && stated("media_type").is_none() {
        return Ok(());
    }
    let (blob, media_type): (String, String) = ctx.connection().query_row(
        "SELECT blob, media_type FROM document WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    keep_replaced(
        ctx,
        id,
        stated("blob").unwrap_or(&blob),
        stated("media_type").unwrap_or(&media_type),
    )?;
    Ok(())
}

/// Make `blob` the document's bytes, keeping the ones it had. Returns whether
/// anything changed.
fn set_content(ctx: &CommandCtx<'_, '_>, id: &str, blob: &str, media_type: &str) -> Result<bool> {
    if !keep_replaced(ctx, id, blob, media_type)? {
        return Ok(false);
    }
    ctx.connection().execute(
        "UPDATE document SET blob = ?2, media_type = ?3 WHERE id = ?1",
        rusqlite::params![id, blob, media_type],
    )?;
    Ok(true)
}

/// Write words into the content store, claim them, and keep them as the text
/// the search index reads. Returns the blob's hash.
fn write_words(ctx: &CommandCtx<'_, '_>, words: &str) -> Result<String> {
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

/// The words the phone read out of the bytes (a PDF's text, a scan's OCR), when it
/// sent them with the file: they are the blob's `text` derivative, so the
/// document is found by them from the first moment.
fn keep_extracted_text(ctx: &CommandCtx<'_, '_>, blob: &str) -> Result<()> {
    if let Some(text) = ctx.optional_str("text").filter(|text| !text.is_empty()) {
        crate::blob::write_derivative(ctx.connection(), &ctx.now, blob, "text", None, Some(text))?;
    }
    Ok(())
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    claim(ctx, "blob")?;
    keep_extracted_text(ctx, ctx.required_str("blob")?)?;
    let id = found(
        ctx,
        ctx.optional_str("id"),
        ctx.required_str("title")?,
        ctx.required_str("blob")?,
        ctx.required_str("media_type")?,
        ctx.optional_str("folder_id"),
    )?;
    Ok(serde_json::json!({ "id": id }))
}

fn create_text(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let words = ctx.optional_str("body_text").unwrap_or_default();
    let hash = write_words(ctx, words)?;
    let id = found(
        ctx,
        ctx.optional_str("id"),
        ctx.required_str("title")?,
        &hash,
        ctx.optional_str("media_type").unwrap_or("text/plain"),
        ctx.optional_str("folder_id"),
    )?;
    Ok(serde_json::json!({ "id": id }))
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    if let Some(words) = ctx.optional_str("body_text") {
        let hash = write_words(ctx, words)?;
        let media_type = media_type_of(ctx, id)?.unwrap_or_default();
        set_content(ctx, id, &hash, &media_type)?;
    }
    if let Some(title) = ctx.optional_str("title") {
        ctx.connection().execute(
            "UPDATE entity SET title = ?2 WHERE id = ?1",
            [id, title.trim()],
        )?;
    }
    ctx.touch(id)?;
    Ok(serde_json::json!({ "id": id }))
}

fn replace(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let media_type = match ctx.optional_str("media_type") {
        Some(media_type) => media_type.to_owned(),
        None => media_type_of(ctx, id)?.unwrap_or_default(),
    };
    claim(ctx, "blob")?;
    keep_extracted_text(ctx, ctx.required_str("blob")?)?;
    let replaced = set_content(ctx, id, ctx.required_str("blob")?, &media_type)?;
    if let Some(title) = ctx.optional_str("title") {
        ctx.connection().execute(
            "UPDATE entity SET title = ?2 WHERE id = ?1",
            [id, title.trim()],
        )?;
    }
    ctx.touch(id)?;
    Ok(serde_json::json!({ "id": id, "replaced": replaced }))
}

fn move_document(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    ctx.connection().execute(
        "UPDATE document SET folder_id = ?2 WHERE id = ?1",
        rusqlite::params![id, ctx.optional_str("folder_id")],
    )?;
    ctx.touch(id)?;
    Ok(serde_json::json!({ "id": id }))
}

fn restore_version(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let (blob, media_type): (String, String) = ctx.connection().query_row(
        "SELECT blob, media_type FROM revision WHERE entity_id = ?1 AND seq = ?2",
        rusqlite::params![id, ctx.input["seq"].as_i64()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let restored = set_content(ctx, id, &blob, &media_type)?;
    if restored {
        ctx.touch(id)?;
    }
    Ok(serde_json::json!({ "id": id, "restored": restored }))
}

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
    const EDIT: &[CommandCondition] = &[CommandCondition {
        predicate: "document_is_live_text_and_words_within_budget",
        check: pre_edit,
    }];
    const REPLACE: &[CommandCondition] = &[CommandCondition {
        predicate: "document_is_live_and_bytes_arrived",
        check: pre_replace,
    }];
    const MOVE: &[CommandCondition] = &[CommandCondition {
        predicate: "document_is_live_and_folder_exists",
        check: pre_move,
    }];
    const RESTORE: &[CommandCondition] = &[CommandCondition {
        predicate: "document_is_live_and_version_is_its_own",
        check: pre_restore_version,
    }];
    vec![
        CommandDefinition::plain(
            "document.add",
            "document",
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
                "text": { "type": "string", "maxLength": 200000 }
              }
            }"#,
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
                "title": { "type": "string", "maxLength": 1000 }
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
            "document.move",
            "document",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "folder_id": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Idempotent,
            MOVE,
            move_document,
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
