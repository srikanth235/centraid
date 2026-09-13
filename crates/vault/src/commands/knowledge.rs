//! THE `knowledge` SCHEMA — nine commands, and none of them stores a note.
//!
//! A note is a `knowledge.note` wrapper over a canonical, sha256-deduped
//! `core.content_item` body: rent the bytes, own the reference
//! (`packages/vault/src/commands/knowledge.ts:1`-`:8`). A notebook is a surface
//! view over `core_collection`, the one owner-curation mechanism (#274) — which
//! is why a collection may also hold photos and documents, and why these
//! commands keep their contracts while storage stays unified.
//!
//! **Notebooks stay one-per-note in v1.** The entry table allows many-to-many
//! and [`move_note`] keeps a single placement, until a real multi-notebook
//! surface asks for more. The postcondition is what makes that a fact.
//!
//! ## Three rules a port must not smooth over
//!
//! 1. **A NOTE'S BODY IS DEDUPED ON THE TEXT, NOT ON THE `data:` URI.**
//!    [`content_item_for`] hashes the body text itself
//!    (`knowledge.ts:78`), while `core.add_document`'s mint hashes the decoded
//!    BYTES of a `data:` payload. The two agree for a percent-encoded UTF-8
//!    body and diverge the moment an encoding changes, so the note path keeps
//!    its own sha — a port that reused the document mint would give every
//!    existing note a new content id.
//! 2. **THE NOTE'S OWN READING OF ITS BODY** (#996 R20(b), drift ONT-28). Two
//!    notes with identical bytes and different formats used to collide on the
//!    sha and take the FIRST note's media type — "a markdown note filed after an
//!    identical plain one was markdown to nobody". The reading is the note's,
//!    on `core_content_representation`, keyed by owner.
//! 3. **A REVISION IS AN OCCURRENCE** (#996 R20(a)). Creating a note records the
//!    first one; an edit that deduplicates back onto the same content id records
//!    NONE, because it revised nothing; a restore appends a new head naming the
//!    body it brings back and rewrites nothing. `restore_note_version` refuses a
//!    content id outside this note's own chain, which is a different answer from
//!    "no such version" and only detectable because a revision has an identity of
//!    its own.
//!
//! ## The inline budget is 64 KiB, and it is NOT the 1 MiB ceiling
//!
//! A text body cannot redirect to the CAS — the FTS feed decodes it
//! in-transaction and a trigger cannot do I/O — so
//! [`super::core::INLINE_BODY_BUDGET_BYTES`] refuses a body over ~64 KiB at the
//! command (`commands/inline-body-guard.ts:13`). The 1 MiB "SB-text" figure is
//! `core.content_item`'s `replicaValues.textCeilingBytes`, a REPLICA rule about
//! when a seat stops carrying a body's value and names the absence. Both are
//! real and they are sixteen times apart; this file enforces the tighter one and
//! `crates/apps/notes/tests/long_body.rs` is the fixture that trips it
//! (D-1020-N4).

use crate::commands::core::{
    INLINE_BODY_BUDGET_BYTES, actor_party_id, encode_uri_component, index_content_text, minted_id,
    minted_id_is_free, purge_at, record_body_revision, revision_chain_of, set_representation,
};
use crate::commands::media::release_content_if_unreferenced;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};

/// The note wrapper's logical entity type.
pub const NOTE_TARGET_TYPE: &str = "knowledge.note";

/// The trash grace window, in v0's arithmetic (#308).
///
/// Thirty days, the same window documents and assets carry — and the same
/// helper, `super::core::purge_at`, so there is one answer to "when does this
/// purge" rather than one per schema.
pub const NOTE_PURGE_AFTER_DAYS: i64 = 30;

/// What a note's `format` means in media-type terms.
const MEDIA_TYPE: &[(&str, &str)] = &[
    ("markdown", "text/markdown"),
    ("html", "text/html"),
    ("plain", "text/plain"),
];

/// `text/plain` is the answer for a format nothing declared, exactly as v0's
/// `MEDIA_TYPE[format] ?? "text/plain"`.
fn media_type_of(format: &str) -> &'static str {
    MEDIA_TYPE
        .iter()
        .find(|(name, _)| *name == format)
        .map_or("text/plain", |(_, media_type)| *media_type)
}

/// Every `knowledge.*` command, in v0's own file order.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        create_note(),
        edit_note(),
        move_note(),
        create_notebook(),
        rename_notebook(),
        delete_notebook(),
        delete_note(),
        restore_note(),
        restore_note_version(),
    ]
}

// ---------------------------------------------------------------------------
// Shared helpers. Each is a fact about the model, not a convenience.
// ---------------------------------------------------------------------------

/// THE NOTE'S OWN READING OF ITS BODY (#996 R20(b), drift ONT-28).
fn set_note_representation(
    ctx: &CommandCtx<'_, '_>,
    note_id: &str,
    content_id: &str,
    format: &str,
) -> Result<()> {
    set_representation(
        ctx,
        content_id,
        NOTE_TARGET_TYPE,
        note_id,
        media_type_of(format),
        Some("body"),
    )?;
    Ok(())
}

/// Dedupe-or-insert a text body as a canonical content item.
///
/// The sha is over the TEXT (see the module note). The budget is checked here
/// as well as in the precondition, because the precondition is a gate a caller
/// sees and this is the invariant the row depends on — and the two cannot
/// disagree, because both read the same constant.
fn content_item_for(ctx: &CommandCtx<'_, '_>, body_text: &str, format: &str) -> Result<String> {
    let media_type = media_type_of(format);
    if body_text.len() > INLINE_BODY_BUDGET_BYTES {
        return Err(VaultError::InvalidInput {
            name: "body_text".to_owned(),
            detail: format!(
                "that note body is {} bytes, over the {INLINE_BODY_BUDGET_BYTES}-byte inline \
                 budget — a text body cannot redirect to blob storage (the search index reads \
                 it in-transaction), so this one is refused rather than silently bloating the \
                 vault",
                body_text.len()
            ),
        });
    }
    let sha = centraid_media::format::sha256_hex(body_text.as_bytes());
    if let Ok(content_id) = ctx.connection().query_row(
        "SELECT content_id FROM core_content_item WHERE sha256 = ?1",
        [&sha],
        |row| row.get::<_, String>(0),
    ) {
        return Ok(content_id);
    }
    let content_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_content_item
           (content_id, content_uri, sha256, byte_size, language, creator_party_id,
            origin_device_id, deleted_at, purge_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, NULL, ?6, ?6)",
        rusqlite::params![
            content_id,
            format!(
                "data:{media_type};charset=utf-8,{}",
                encode_uri_component(body_text)
            ),
            sha,
            i64::try_from(body_text.len()).unwrap_or(i64::MAX),
            actor_party_id(ctx)?,
            ctx.now
        ],
    )?;
    // DECODE AT WRITE TIME (#996 R4/R8): the FTS trigger reads
    // `core_content_text`, so the text has to be there before the
    // representation row fires it.
    index_content_text(ctx, &content_id, media_type)?;
    Ok(content_id)
}

/// File a note at the end of a collection (one ordered list, all types).
fn place_note(ctx: &CommandCtx<'_, '_>, note_id: &str, notebook_id: &str) -> Result<()> {
    let entry_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_collection_entry
           (entry_id, collection_id, target_type, target_id, position, added_at)
         VALUES (?1, ?2, ?3, ?4,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM core_collection_entry
                   WHERE collection_id = ?2), ?5)",
        rusqlite::params![entry_id, notebook_id, NOTE_TARGET_TYPE, note_id, ctx.now],
    )?;
    Ok(())
}

/// The note id a CREATED row took, as a postcondition sees it.
fn created_note_id(ctx: &CommandCtx<'_, '_>) -> String {
    super::core::created_row_id(ctx, "note_id")
}

fn created_notebook_id(ctx: &CommandCtx<'_, '_>) -> String {
    super::core::created_row_id(ctx, "notebook_id")
}

/// THE INLINE BUDGET, AS A GATE RATHER THAN A THROW.
///
/// v0 throws from the handler (`assertTextBodyWithinBudget`) and its HTTP layer
/// turns the throw into `{status: "denied"}`. Here it is a PRECONDITION, so the
/// refusal is receipted with its own predicate and an owner-facing sentence and
/// the audit trail names the gate rather than an exception type — the same move
/// `core.add_document`'s `text_body_within_budget` makes (D-1020-DC8's pattern).
///
/// [`content_item_for`] keeps the same check as the invariant the row depends
/// on; both read [`INLINE_BODY_BUDGET_BYTES`], so the gate and the invariant
/// cannot disagree.
fn pre_body_within_budget(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(body_text) = ctx.optional_str("body_text") else {
        return Ok(None);
    };
    Ok((body_text.len() > INLINE_BODY_BUDGET_BYTES).then(|| {
        format!(
            "That note is {} bytes of text, over the {INLINE_BODY_BUDGET_BYTES}-byte inline \
             budget — a note's words are stored in the vault row so the search index can read \
             them, and a body this long is refused rather than silently bloating the file.",
            body_text.len()
        )
    }))
}

/// A trashed note is FROZEN: restore first, then edit.
fn pre_note_is_live(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let note_id = ctx.required_str("note_id")?;
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM knowledge_note WHERE note_id = ?1 AND deleted_at IS NULL",
        [note_id],
        |row| row.get(0),
    )?;
    Ok((count != 1).then(|| "There is no live note with that id.".to_owned()))
}

/// Filing is optional; a named notebook must exist. An unfiled write passes
/// trivially, which is v0's `CASE WHEN :notebook_id IS NULL THEN 1`.
fn pre_notebook_exists_if_given(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(notebook_id) = ctx.optional_str("notebook_id") else {
        return Ok(None);
    };
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
        [notebook_id],
        |row| row.get(0),
    )?;
    Ok((count != 1).then(|| "There is no notebook with that id.".to_owned()))
}

fn pre_notebook_exists(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let notebook_id = ctx.required_str("notebook_id")?;
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
        [notebook_id],
        |row| row.get(0),
    )?;
    Ok((count != 1).then(|| "There is no notebook with that id.".to_owned()))
}

/// The body a note is currently made of, and the format it reads it as.
fn note_body(ctx: &CommandCtx<'_, '_>, note_id: &str) -> Result<(String, String)> {
    ctx.connection()
        .query_row(
            "SELECT body_content_id, format FROM knowledge_note WHERE note_id = ?1",
            [note_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| VaultError::Invariant {
            context: format!("note {note_id} vanished between check and execute"),
        })
}

// ---------------------------------------------------------------------------
// The nine
// ---------------------------------------------------------------------------

/// The minted-id shape every CREATING command accepts (#922 G2).
///
/// A TEST ORACLE: Rust has no `const` string building, so the two creating
/// schemas below carry the literal and
/// `both_creating_commands_declare_the_same_minted_id_shape` is what keeps them
/// one shape.
#[cfg(test)]
const MINTED_ID_PROPERTY: &str = r#"{
              "type": "string", "minLength": 36, "maxLength": 36,
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            }"#;

fn create_note() -> CommandDefinition {
    CommandDefinition {
        name: "knowledge.create_note",
        owner_schema: "knowledge",
        input_schema: CREATE_NOTE_SCHEMA,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "note_id_is_free",
                check: |ctx| minted_id_is_free(ctx, "note_id", "knowledge_note", "note_id", "note"),
            },
            CommandCondition {
                predicate: "body_text_within_budget",
                check: pre_body_within_budget,
            },
            CommandCondition {
                predicate: "notebook_exists_if_given",
                check: pre_notebook_exists_if_given,
            },
        ],
        postconditions: &[CommandCondition {
            // The note exists, unpinned, and is placed iff a notebook was named.
            predicate: "note_created_and_placed",
            check: |ctx| {
                let note_id = created_note_id(ctx);
                let notebook_id = ctx.optional_str("notebook_id").map(str::to_owned);
                let live: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM knowledge_note WHERE note_id = ?1 AND pinned = 0",
                    [&note_id],
                    |row| row.get(0),
                )?;
                let placements: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_collection_entry
                      WHERE target_type = ?1 AND target_id = ?2",
                    rusqlite::params![NOTE_TARGET_TYPE, note_id],
                    |row| row.get(0),
                )?;
                let placed = match notebook_id.as_deref() {
                    None => placements == 0,
                    Some(notebook_id) => {
                        let here: i64 = ctx.connection().query_row(
                            "SELECT COUNT(*) FROM core_collection_entry
                              WHERE target_type = ?1 AND target_id = ?2 AND collection_id = ?3",
                            rusqlite::params![NOTE_TARGET_TYPE, note_id, notebook_id],
                            |row| row.get(0),
                        )?;
                        here == 1
                    }
                };
                Ok((live != 1 || !placed).then(|| "the note was not created and filed".to_owned()))
            },
        }],
        handler: |ctx| {
            let format = ctx.optional_str("format").unwrap_or("plain").to_owned();
            let title = ctx.required_str("title")?.to_owned();
            let body_text = ctx.required_str("body_text")?.to_owned();
            let notebook_id = ctx.optional_str("notebook_id").map(str::to_owned);
            // THE WRAPPER'S ID FIRST, so `created_row_id` finds it at
            // `produced_ids[0]` — the same order `core.add_document` takes.
            let note_id = minted_id(ctx, "note_id");
            let content_id = content_item_for(ctx, &body_text, &format)?;
            ctx.connection().execute(
                "INSERT INTO knowledge_note
                   (note_id, author_party_id, title, body_content_id, format, pinned,
                    created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)",
                rusqlite::params![
                    note_id,
                    actor_party_id(ctx)?,
                    title,
                    content_id,
                    format,
                    ctx.now
                ],
            )?;
            set_note_representation(ctx, &note_id, &content_id, &format)?;
            // The FIRST occurrence (#996 R20(a)): a note's original body is a
            // version like any other, so the chain starts here.
            let revision_id =
                record_body_revision(ctx, NOTE_TARGET_TYPE, &note_id, &content_id, None)?;
            ctx.connection().execute(
                "UPDATE knowledge_note SET current_revision_id = ?1 WHERE note_id = ?2",
                rusqlite::params![revision_id, note_id],
            )?;
            if let Some(notebook_id) = notebook_id {
                place_note(ctx, &note_id, &notebook_id)?;
            }
            Ok(serde_json::json!({
                "note_id": note_id,
                "body_content_id": content_id,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn edit_note() -> CommandDefinition {
    CommandDefinition {
        name: "knowledge.edit_note",
        owner_schema: "knowledge",
        input_schema: EDIT_NOTE_SCHEMA,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "note_is_live",
                check: pre_note_is_live,
            },
            CommandCondition {
                predicate: "body_text_within_budget",
                check: pre_body_within_budget,
            },
        ],
        postconditions: &[CommandCondition {
            // Each field either was not asked for, or now reads back exactly as
            // sent. An untouched field passes.
            predicate: "edits_applied",
            check: |ctx| {
                let note_id = ctx.required_str("note_id")?.to_owned();
                for (key, column) in [("title", "title"), ("format", "format")] {
                    let Some(value) = ctx.optional_str(key) else {
                        continue;
                    };
                    let count: i64 = ctx.connection().query_row(
                        &format!(
                            "SELECT COUNT(*) FROM knowledge_note WHERE note_id = ?1 AND {column} = ?2"
                        ),
                        rusqlite::params![note_id, value],
                        |row| row.get(0),
                    )?;
                    if count != 1 {
                        return Ok(Some(format!("the note's {key} was not applied")));
                    }
                }
                if let Some(pinned) = ctx.input.get("pinned").and_then(serde_json::Value::as_i64) {
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM knowledge_note WHERE note_id = ?1 AND pinned = ?2",
                        rusqlite::params![note_id, pinned],
                        |row| row.get(0),
                    )?;
                    if count != 1 {
                        return Ok(Some("the note's pin was not applied".to_owned()));
                    }
                }
                Ok(None)
            },
        }],
        handler: |ctx| {
            let note_id = ctx.required_str("note_id")?.to_owned();
            let (current_content_id, current_format) = note_body(ctx, &note_id)?;
            let mut sets: Vec<&str> = vec!["updated_at = ?"];
            let mut binds: Vec<rusqlite::types::Value> =
                vec![rusqlite::types::Value::Text(ctx.now.clone())];
            let mut minted: Option<String> = None;

            if let Some(body_text) = ctx.optional_str("body_text") {
                // A body edit re-resolves the reference: a new (or deduped)
                // content item, decoded with the format the note will HAVE after
                // this edit rather than the one it had before.
                let format = ctx
                    .optional_str("format")
                    .unwrap_or(&current_format)
                    .to_owned();
                let content_id = content_item_for(ctx, body_text, &format)?;
                if content_id != current_content_id {
                    // A NO-OP EDIT RECORDS NO OCCURRENCE: dedup landing back on
                    // the same content id revised nothing.
                    let revision_id = record_body_revision(
                        ctx,
                        NOTE_TARGET_TYPE,
                        &note_id,
                        &content_id,
                        Some(&current_content_id),
                    )?;
                    sets.push("current_revision_id = ?");
                    binds.push(rusqlite::types::Value::Text(revision_id));
                }
                sets.push("body_content_id = ?");
                binds.push(rusqlite::types::Value::Text(content_id.clone()));
                set_note_representation(ctx, &note_id, &content_id, &format)?;
                minted = Some(content_id);
            }
            if let Some(title) = ctx.optional_str("title") {
                sets.push("title = ?");
                binds.push(rusqlite::types::Value::Text(title.to_owned()));
            }
            if let Some(format) = ctx.optional_str("format") {
                sets.push("format = ?");
                binds.push(rusqlite::types::Value::Text(format.to_owned()));
            }
            if let Some(pinned) = ctx.input.get("pinned").and_then(serde_json::Value::as_i64) {
                sets.push("pinned = ?");
                binds.push(rusqlite::types::Value::Integer(pinned));
            }
            binds.push(rusqlite::types::Value::Text(note_id.clone()));
            // ONE `UPDATE`, whatever the caller is changing: a second statement
            // would be a second `row_version` bump for one member gesture.
            ctx.connection()
                .prepare(&format!(
                    "UPDATE knowledge_note SET {} WHERE note_id = ?",
                    sets.join(", ")
                ))?
                .execute(rusqlite::params_from_iter(binds))?;
            Ok(match minted {
                Some(content_id) => serde_json::json!({
                    "note_id": note_id, "body_content_id": content_id
                }),
                None => serde_json::json!({ "note_id": note_id }),
            })
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn move_note() -> CommandDefinition {
    CommandDefinition {
        name: "knowledge.move_note",
        owner_schema: "knowledge",
        input_schema: MOVE_NOTE_SCHEMA,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "note_is_live",
                check: pre_note_is_live,
            },
            CommandCondition {
                predicate: "notebook_exists_if_given",
                check: pre_notebook_exists_if_given,
            },
        ],
        postconditions: &[CommandCondition {
            // ONE placement in the target notebook, or none at all if unfiled.
            // The entry table allows many-to-many; this is what keeps v1 at one.
            predicate: "note_singly_placed",
            check: |ctx| {
                let note_id = ctx.required_str("note_id")?.to_owned();
                let placements: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_collection_entry
                      WHERE target_type = ?1 AND target_id = ?2",
                    rusqlite::params![NOTE_TARGET_TYPE, note_id],
                    |row| row.get(0),
                )?;
                let Some(notebook_id) = ctx.optional_str("notebook_id") else {
                    return Ok((placements != 0).then(|| "the note is still filed".to_owned()));
                };
                let here: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_collection_entry
                      WHERE target_type = ?1 AND target_id = ?2 AND collection_id = ?3",
                    rusqlite::params![NOTE_TARGET_TYPE, note_id, notebook_id],
                    |row| row.get(0),
                )?;
                Ok((placements != 1 || here != 1)
                    .then(|| "the note is not singly placed in that notebook".to_owned()))
            },
        }],
        handler: |ctx| {
            let note_id = ctx.required_str("note_id")?.to_owned();
            let notebook_id = ctx.optional_str("notebook_id").map(str::to_owned);
            ctx.connection().execute(
                "DELETE FROM core_collection_entry WHERE target_type = ?1 AND target_id = ?2",
                rusqlite::params![NOTE_TARGET_TYPE, note_id],
            )?;
            if let Some(notebook_id) = notebook_id {
                place_note(ctx, &note_id, &notebook_id)?;
            }
            Ok(serde_json::json!({ "note_id": note_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn create_notebook() -> CommandDefinition {
    CommandDefinition {
        name: "knowledge.create_notebook",
        owner_schema: "knowledge",
        input_schema: CREATE_NOTEBOOK_SCHEMA,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "notebook_id_is_free",
                check: |ctx| {
                    minted_id_is_free(
                        ctx,
                        "notebook_id",
                        "core_collection",
                        "collection_id",
                        "notebook",
                    )
                },
            },
            CommandCondition {
                predicate: "parent_exists_if_given",
                check: |ctx| {
                    let Some(parent) = ctx.optional_str("parent_notebook_id") else {
                        return Ok(None);
                    };
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
                        [parent],
                        |row| row.get(0),
                    )?;
                    Ok((count != 1).then(|| "There is no notebook with that id.".to_owned()))
                },
            },
            CommandCondition {
                // THE SAME COLLISION RULE `rename_notebook` ENFORCES. Two
                // notebooks with the same name are indistinguishable in every
                // filing UI, and without this the duplicate could only be
                // untangled by renaming one away — which rename itself refuses.
                predicate: "name_unused",
                check: |ctx| {
                    let name = ctx.required_str("name")?;
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_collection WHERE name = ?1",
                        [name],
                        |row| row.get(0),
                    )?;
                    Ok((count != 0)
                        .then(|| "You already have a notebook with that name.".to_owned()))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "notebook_created",
            check: |ctx| {
                let notebook_id = created_notebook_id(ctx);
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1",
                    [&notebook_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the notebook was not created".to_owned()))
            },
        }],
        handler: |ctx| {
            let notebook_id = minted_id(ctx, "notebook_id");
            let name = ctx.required_str("name")?.to_owned();
            let parent = ctx.optional_str("parent_notebook_id").map(str::to_owned);
            // `sort_order` is SIBLING-SCOPED, and the parent match is `IS` (not
            // `=`) so NULL parents group together rather than never matching.
            ctx.connection().execute(
                "INSERT INTO core_collection
                   (collection_id, owner_party_id, name, cover_content_id,
                    parent_collection_id, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, ?4,
                         (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM core_collection
                           WHERE parent_collection_id IS ?4), ?5, ?5)",
                rusqlite::params![notebook_id, actor_party_id(ctx)?, name, parent, ctx.now],
            )?;
            Ok(serde_json::json!({ "notebook_id": notebook_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn rename_notebook() -> CommandDefinition {
    CommandDefinition {
        name: "knowledge.rename_notebook",
        owner_schema: "knowledge",
        input_schema: RENAME_NOTEBOOK_SCHEMA,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "notebook_exists",
                check: pre_notebook_exists,
            },
            CommandCondition {
                // Scoped to the same OWNER, and excluding the notebook itself,
                // so renaming a notebook to its own name is an idempotent no-op
                // rather than a refusal.
                predicate: "name_unused_by_owner",
                check: |ctx| {
                    let notebook_id = ctx.required_str("notebook_id")?.to_owned();
                    let name = ctx.required_str("name")?.to_owned();
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_collection
                          WHERE name = ?1 AND collection_id <> ?2
                            AND owner_party_id = (SELECT owner_party_id FROM core_collection
                                                   WHERE collection_id = ?2)",
                        rusqlite::params![name, notebook_id],
                        |row| row.get(0),
                    )?;
                    Ok((count != 0)
                        .then(|| "You already have a notebook with that name.".to_owned()))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "name_updated",
            check: |ctx| {
                let notebook_id = ctx.required_str("notebook_id")?.to_owned();
                let name = ctx.required_str("name")?.to_owned();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_collection
                      WHERE collection_id = ?1 AND name = ?2",
                    rusqlite::params![notebook_id, name],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the notebook was not renamed".to_owned()))
            },
        }],
        handler: |ctx| {
            let notebook_id = ctx.required_str("notebook_id")?.to_owned();
            let name = ctx.required_str("name")?.to_owned();
            ctx.connection().execute(
                "UPDATE core_collection SET name = ?1 WHERE collection_id = ?2",
                rusqlite::params![name, notebook_id],
            )?;
            Ok(serde_json::json!({ "notebook_id": notebook_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn delete_notebook() -> CommandDefinition {
    CommandDefinition {
        name: "knowledge.delete_notebook",
        owner_schema: "knowledge",
        input_schema: NOTEBOOK_ID_SCHEMA,
        idempotency: Idempotency::Idempotent,
        // UNFILE, DON'T DESTROY: the notebook is pure structure — deleting it
        // orphans no content and every member note survives — so it sits at
        // `low` alongside `delete_note`, which destroys strictly more.
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "notebook_exists",
                check: pre_notebook_exists,
            },
            CommandCondition {
                // HIERARCHY NEVER DANGLES: children are deleted (or re-parented
                // by hand) first, mirroring how `create_notebook` refuses a
                // missing parent on the way in.
                predicate: "notebook_has_no_children",
                check: |ctx| {
                    let notebook_id = ctx.required_str("notebook_id")?;
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_collection WHERE parent_collection_id = ?1",
                        [notebook_id],
                        |row| row.get(0),
                    )?;
                    Ok((count != 0).then(|| {
                        "That notebook still holds notebooks; delete or move them first.".to_owned()
                    }))
                },
            },
        ],
        postconditions: &[CommandCondition {
            // The collection and every entry ONTO it are gone together; member
            // notes survive as unfiled rows, because entries are the only edge.
            predicate: "notebook_and_placements_removed",
            check: |ctx| {
                let notebook_id = ctx.required_str("notebook_id")?.to_owned();
                let left: i64 = ctx.connection().query_row(
                    "SELECT (SELECT COUNT(*) FROM core_collection WHERE collection_id = ?1)
                          + (SELECT COUNT(*) FROM core_collection_entry WHERE collection_id = ?1)",
                    [&notebook_id],
                    |row| row.get(0),
                )?;
                Ok((left != 0).then(|| "the notebook or its placements survived".to_owned()))
            },
        }],
        handler: |ctx| {
            let notebook_id = ctx.required_str("notebook_id")?.to_owned();
            let unfiled: i64 = ctx.connection().query_row(
                "SELECT COUNT(*) FROM core_collection_entry
                  WHERE collection_id = ?1 AND target_type = ?2",
                rusqlite::params![notebook_id, NOTE_TARGET_TYPE],
                |row| row.get(0),
            )?;
            ctx.connection().execute(
                "DELETE FROM core_collection_entry WHERE collection_id = ?1",
                [&notebook_id],
            )?;
            ctx.connection().execute(
                "DELETE FROM core_collection WHERE collection_id = ?1",
                [&notebook_id],
            )?;
            Ok(serde_json::json!({
                "notebook_id": notebook_id,
                "notes_unfiled": unfiled,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn delete_note() -> CommandDefinition {
    CommandDefinition {
        name: "knowledge.delete_note",
        owner_schema: "knowledge",
        input_schema: NOTE_ID_SCHEMA,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "note_is_live",
            check: pre_note_is_live,
        }],
        postconditions: &[CommandCondition {
            predicate: "note_trashed_not_destroyed",
            check: |ctx| {
                let note_id = ctx.required_str("note_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM knowledge_note
                      WHERE note_id = ?1 AND deleted_at IS NOT NULL AND purge_at IS NOT NULL",
                    [note_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the note was not moved to the trash".to_owned()))
            },
        }],
        handler: |ctx| {
            let note_id = ctx.required_str("note_id")?.to_owned();
            let (content_id, _) = note_body(ctx, &note_id)?;
            let until = purge_at(&ctx.now)?;
            ctx.connection().execute(
                "UPDATE knowledge_note
                    SET deleted_at = ?1, purge_at = ?2, updated_at = ?1
                  WHERE note_id = ?3",
                rusqlite::params![ctx.now, until, note_id],
            )?;
            // BODIES ARE SHARED. Another live note or message may still rent the
            // same bytes, so only an UNREFERENCED body soft-deletes — and a
            // trashed note is not a rental, so restore un-trashes the body with
            // it.
            let released = release_content_if_unreferenced(ctx, &content_id)?;
            Ok(serde_json::json!({
                "note_id": note_id,
                "purge_at": until,
                "body_released": i64::from(released),
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn restore_note() -> CommandDefinition {
    CommandDefinition {
        name: "knowledge.restore_note",
        owner_schema: "knowledge",
        input_schema: NOTE_ID_SCHEMA,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            // RESTORE REFUSES A LAPSED WINDOW (#916, review 1.5). The comparison
            // is against `ctx.now` and NOT SQLite's own clock — lane V's fix, and
            // the reason this fixture is reproducible at any instant while v0's
            // has to live in 2099.
            predicate: "note_in_trash",
            check: |ctx| {
                let note_id = ctx.required_str("note_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM knowledge_note
                      WHERE note_id = ?1 AND deleted_at IS NOT NULL
                        AND (purge_at IS NULL OR purge_at > ?2)",
                    rusqlite::params![note_id, ctx.now],
                    |row| row.get(0),
                )?;
                Ok((count != 1)
                    .then(|| "That note is not in the trash, or its window has lapsed.".to_owned()))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "note_restored",
            check: |ctx| {
                let note_id = ctx.required_str("note_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM knowledge_note
                      WHERE note_id = ?1 AND deleted_at IS NULL AND purge_at IS NULL",
                    [note_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the note was not restored".to_owned()))
            },
        }],
        handler: |ctx| {
            let note_id = ctx.required_str("note_id")?.to_owned();
            let (content_id, _) = note_body(ctx, &note_id)?;
            ctx.connection().execute(
                "UPDATE knowledge_note
                    SET deleted_at = NULL, purge_at = NULL, updated_at = ?1
                  WHERE note_id = ?2",
                rusqlite::params![ctx.now, note_id],
            )?;
            // If trashing released the body bytes, restoring rents them again.
            ctx.connection().execute(
                "UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL
                  WHERE content_id = ?1 AND deleted_at IS NOT NULL",
                [&content_id],
            )?;
            Ok(serde_json::json!({ "note_id": note_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn restore_note_version() -> CommandDefinition {
    CommandDefinition {
        name: "knowledge.restore_note_version",
        owner_schema: "knowledge",
        input_schema: RESTORE_VERSION_SCHEMA,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: RESTORE_VERSION_PRE,
        postconditions: &[CommandCondition {
            // A RESTORE IS A NEW OCCURRENCE, never a rewrite: the head names the
            // restored content AND has a parent, which is what says history was
            // appended to rather than moved.
            predicate: "restored_and_recorded",
            check: |ctx| {
                let note_id = ctx.required_str("note_id")?.to_owned();
                let content_id = ctx.required_str("content_id")?.to_owned();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM knowledge_note n
                       JOIN core_entity_revision r ON r.revision_id = n.current_revision_id
                      WHERE n.note_id = ?1 AND n.body_content_id = ?2
                        AND r.content_id = ?2 AND r.parent_revision_id IS NOT NULL",
                    rusqlite::params![note_id, content_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the version was not restored and recorded".to_owned()))
            },
        }],
        handler: |ctx| {
            let note_id = ctx.required_str("note_id")?.to_owned();
            let content_id = ctx.required_str("content_id")?.to_owned();
            let (current_content_id, format) = note_body(ctx, &note_id)?;
            // A REVISION BELONGS TO ONE OBJECT (#996 R20(a)). The precondition
            // already walked the chain; this is the handler's own guard, and it
            // is a DIFFERENT answer from "no such version".
            let chain = revision_chain_of(ctx, NOTE_TARGET_TYPE, &note_id)?;
            if !chain.iter().any(|(_, id)| *id == content_id) {
                return Err(VaultError::InvalidInput {
                    name: "content_id".to_owned(),
                    detail: format!(
                        "content {content_id} is not a revision of {note_id} — \
                         a revision belongs to one object"
                    ),
                });
            }
            let revision_id = record_body_revision(
                ctx,
                NOTE_TARGET_TYPE,
                &note_id,
                &content_id,
                Some(&current_content_id),
            )?;
            ctx.connection().execute(
                "UPDATE knowledge_note
                    SET body_content_id = ?1, current_revision_id = ?2, updated_at = ?3
                  WHERE note_id = ?4",
                rusqlite::params![content_id, revision_id, ctx.now, note_id],
            )?;
            // THE REPRESENTATION FOLLOWS THE HEAD (#996 R20(b)): a restore
            // changes WHICH bytes the note reads, never HOW it reads them — so
            // the note's own format is what the new head is read as.
            set_note_representation(ctx, &note_id, &content_id, &format)?;
            Ok(serde_json::json!({ "note_id": note_id, "content_id": content_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

/// `restore_note_version`'s three gates, in v0's order.
const RESTORE_VERSION_PRE: &[CommandCondition] = &[
    CommandCondition {
        predicate: "note_is_live",
        check: pre_note_is_live,
    },
    CommandCondition {
        predicate: "not_already_current",
        check: |ctx| {
            let note_id = ctx.required_str("note_id")?.to_owned();
            let content_id = ctx.required_str("content_id")?.to_owned();
            let count: i64 = ctx.connection().query_row(
                "SELECT COUNT(*) FROM knowledge_note
                  WHERE note_id = ?1 AND body_content_id = ?2",
                rusqlite::params![note_id, content_id],
                |row| row.get(0),
            )?;
            Ok((count != 0).then(|| "That version is already the note's body.".to_owned()))
        },
    },
    CommandCondition {
        // ONLY A CONTENT ITEM REACHED THROUGH THIS NOTE'S OWN APPEND-ONLY CHAIN
        // is restorable. v0 spells this as a recursive CTE whose `UNION`
        // terminates a cycle made by a restore-of-a-restore; the port walks the
        // chain with the same step cap and the same stop, and
        // `crates/apps/notes` turns the reader's half of that walk into a typed
        // refusal (D-1020-N2).
        predicate: "target_in_chain",
        check: |ctx| {
            let note_id = ctx.required_str("note_id")?.to_owned();
            let content_id = ctx.required_str("content_id")?.to_owned();
            let chain = revision_chain_of(ctx, NOTE_TARGET_TYPE, &note_id)?;
            Ok((!chain.iter().any(|(_, id)| *id == content_id))
                .then(|| "That version is not in this note's history.".to_owned()))
        },
    },
];

// ---------------------------------------------------------------------------
// The schemas, verbatim from v0's `inputSchema` blocks.
// ---------------------------------------------------------------------------

const CREATE_NOTE_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["title", "body_text"],
          "additionalProperties": false,
          "properties": {
            "note_id": {
              "type": "string", "minLength": 36, "maxLength": 36,
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "title": { "type": "string", "minLength": 1 },
            "body_text": { "type": "string", "minLength": 1 },
            "format": { "type": "string", "enum": ["markdown", "html", "plain"] },
            "notebook_id": { "type": "string", "minLength": 1 }
          }
        }"#;

const EDIT_NOTE_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["note_id"],
          "additionalProperties": false,
          "properties": {
            "note_id": { "type": "string", "minLength": 1 },
            "title": { "type": "string", "minLength": 1 },
            "body_text": { "type": "string", "minLength": 1 },
            "format": { "type": "string", "enum": ["markdown", "html", "plain"] },
            "pinned": { "type": "integer", "minimum": 0, "maximum": 1 }
          }
        }"#;

const MOVE_NOTE_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["note_id"],
          "additionalProperties": false,
          "properties": {
            "note_id": { "type": "string", "minLength": 1 },
            "notebook_id": { "type": "string", "minLength": 1 }
          }
        }"#;

const CREATE_NOTEBOOK_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["name"],
          "additionalProperties": false,
          "properties": {
            "notebook_id": {
              "type": "string", "minLength": 36, "maxLength": 36,
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "name": { "type": "string", "minLength": 1 },
            "parent_notebook_id": { "type": "string", "minLength": 1 }
          }
        }"#;

const RENAME_NOTEBOOK_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["notebook_id", "name"],
          "additionalProperties": false,
          "properties": {
            "notebook_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1 }
          }
        }"#;

const NOTEBOOK_ID_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["notebook_id"],
          "additionalProperties": false,
          "properties": { "notebook_id": { "type": "string", "minLength": 1 } }
        }"#;

const NOTE_ID_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["note_id"],
          "additionalProperties": false,
          "properties": { "note_id": { "type": "string", "minLength": 1 } }
        }"#;

const RESTORE_VERSION_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["note_id", "content_id"],
          "additionalProperties": false,
          "properties": {
            "note_id": { "type": "string", "minLength": 1 },
            "content_id": { "type": "string", "minLength": 1 }
          }
        }"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_is_nine_commands_all_named_under_knowledge() {
        let names: Vec<&str> = definitions()
            .iter()
            .map(|definition| definition.name)
            .collect();
        assert_eq!(names.len(), 9);
        for definition in definitions() {
            assert!(definition.name.starts_with("knowledge."));
            assert_eq!(definition.owner_schema, "knowledge");
            let schema = serde_json::from_str::<serde_json::Value>(definition.input_schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
            jsonschema::validator_for(&schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
        }
    }

    /// v0's split for this schema: **9 commands, 7 idempotent / 2 once**
    /// (census §A0's per-schema tally reads `knowledge 9`). The two `once`
    /// commands are the two creates, which is the only classification a
    /// duplicate delivery can get wrong.
    #[test]
    fn the_idempotency_split_matches_v0() {
        let once: Vec<&str> = definitions()
            .iter()
            .filter(|definition| definition.idempotency == Idempotency::Once)
            .map(|definition| definition.name)
            .collect();
        assert_eq!(once, ["knowledge.create_note", "knowledge.create_notebook"]);
        assert_eq!(
            definitions()
                .iter()
                .filter(|definition| definition.idempotency == Idempotency::Idempotent)
                .count(),
            7
        );
    }

    /// TWO GATES, NEVER ONE (census §A0). Notes' two manifest-confirmed actions
    /// are the two deletes, and neither command carries the NON-OWNER park —
    /// `confirm: true` is a different gate and only the two merges set it in v0.
    #[test]
    fn no_knowledge_command_carries_the_non_owner_park() {
        for definition in definitions() {
            assert!(!definition.confirm, "{}", definition.name);
            assert!(!definition.online_only, "{}", definition.name);
            assert!(definition.sealed_input.is_empty(), "{}", definition.name);
            // `risk` is SALIENCE ONLY: every knowledge command is `low`,
            // including the two deletes, because both are reversible.
            assert_eq!(definition.risk, Risk::Low, "{}", definition.name);
        }
    }

    /// THE MINTED-ID SHAPE IS ONE LITERAL (#922 G2), and both creating
    /// commands declare it. Rust has no `const` string concatenation, so the
    /// coupling is held by this assertion rather than by the compiler: a
    /// creating command whose accepted id shape drifted from
    /// [`MINTED_ID_PROPERTY`] fails here.
    #[test]
    fn both_creating_commands_declare_the_same_minted_id_shape() {
        for (name, schema) in [
            ("knowledge.create_note", CREATE_NOTE_SCHEMA),
            ("knowledge.create_notebook", CREATE_NOTEBOOK_SCHEMA),
        ] {
            assert!(
                schema.contains(MINTED_ID_PROPERTY),
                "{name} no longer declares the minted-id shape verbatim"
            );
        }
    }

    #[test]
    fn a_format_the_enum_does_not_name_reads_as_plain_text() {
        assert_eq!(media_type_of("markdown"), "text/markdown");
        assert_eq!(media_type_of("html"), "text/html");
        assert_eq!(media_type_of("plain"), "text/plain");
        assert_eq!(media_type_of("latex"), "text/plain");
    }
}
