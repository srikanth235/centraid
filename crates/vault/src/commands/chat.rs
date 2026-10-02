//! THE `chat` SCHEMA — four commands, and the only writers of a conversation.
//!
//! A member's conversations with the on-device assistant are vault data
//! (R-CHAT-1): `chat_thread` is an entity, `chat_message` is a projection of
//! its thread, and the card and attachment tables are projections of a message
//! (rung ten, `contracts/migrations/010_chat.sql`). Nothing writes them but
//! these commands, so a chat is backed up, receipted and captured exactly as a
//! note is.
//!
//! ## One turn is one commit
//!
//! [`save_turn`] writes the member's question AND the assistant's answer (or
//! refusal, or the part of it that was streamed before a stop) in one
//! transaction. A process killed while a turn runs therefore loses that turn
//! whole and never keeps half of it: the in-flight turn is not state, the
//! completed ones are (R-CHAT-5).
//!
//! ## THE JOURNAL MUST NOT KEEP WHAT A DELETE REMOVES
//!
//! The invocation journal stores a command's input, and a conversation's text,
//! its cards (titles read out of other apps) and its thumbnails are exactly what
//! "delete this chat" is meant to remove. `turn` is therefore a SEALED input
//! key: the journal keeps a token and never the value, the same mechanism
//! Locker uses for a password, so deleting a thread leaves nothing of what was
//! said in the audit band (R-CHAT-6).
//!
//! ## What is never stored
//!
//! A camera-roll image is stored as a thumbnail of at most 256 pixels, minted
//! as a content item in the byte plane and rented by the attachment row; the
//! original never is. A vault photograph or document is stored as the typed
//! reference it is. Locker is not an app a card can name: the schema's enum and
//! the table's CHECK both stop at the seven apps the assistant reads.

use crate::chat::title_of;
use crate::commands::core::mint_content_from_data_uri;
use crate::commands::media::release_content_now;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};

/// The chat thread's logical entity type.
pub const THREAD_TARGET_TYPE: &str = "chat.thread";

/// Every `chat.*` command.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![save_turn(), rename_thread(), delete_thread(), clear()]
}

const SAVE_TURN_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["turn"],
  "additionalProperties": false,
  "properties": {
    "thread_id": { "type": "string", "minLength": 1 },
    "replace_last": { "type": "boolean" },
    "scope_app": {
      "enum": ["agenda", "docs", "notes", "people", "photos", "tally", "tasks", null]
    },
    "turn": {
      "type": "object",
      "required": ["question", "answer"],
      "additionalProperties": false,
      "properties": {
        "question": {
          "type": "object",
          "required": ["text"],
          "additionalProperties": false,
          "properties": {
            "text": { "type": "string", "minLength": 1, "maxLength": 8000 },
            "attachments": {
              "type": "array",
              "maxItems": 2,
              "items": {
                "type": "object",
                "required": ["kind", "label"],
                "additionalProperties": false,
                "properties": {
                  "kind": { "enum": ["photo", "document", "image"] },
                  "label": { "type": "string", "maxLength": 300 },
                  "asset_id": { "type": "string", "minLength": 1 },
                  "document_id": { "type": "string", "minLength": 1 },
                  "thumbnail_data_uri": { "type": "string", "maxLength": 400000 }
                }
              }
            }
          }
        },
        "answer": {
          "type": "object",
          "required": ["outcome"],
          "additionalProperties": false,
          "properties": {
            "outcome": { "enum": ["answered", "stopped", "refused"] },
            "text": { "type": "string", "maxLength": 20000 },
            "refusal": {
              "enum": [
                "no_tool_fits", "query_failed", "unparsable", "model_absent", "model_failed",
                "vision_absent", "attachment_unsupported", "attachment_unreadable",
                "attachment_too_large"
              ]
            },
            "notice": { "enum": ["doc_truncated"] },
            "record_json": { "type": "string", "maxLength": 20000 },
            "cards": {
              "type": "array",
              "maxItems": 50,
              "items": {
                "type": "object",
                "required": ["app", "entity", "id", "title"],
                "additionalProperties": false,
                "properties": {
                  "app": { "enum": ["agenda", "docs", "notes", "people", "photos", "tally", "tasks"] },
                  "entity": { "type": "string", "minLength": 1 },
                  "id": { "type": "string", "minLength": 1 },
                  "qualifier": { "type": "string" },
                  "title": { "type": "string" },
                  "subtitle": { "type": "string" },
                  "meta": { "type": "string" }
                }
              }
            }
          }
        }
      }
    }
  }
}"#;

const THREAD_ID_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["thread_id"],
  "additionalProperties": false,
  "properties": { "thread_id": { "type": "string", "minLength": 1 } }
}"#;

const RENAME_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["thread_id", "title"],
  "additionalProperties": false,
  "properties": {
    "thread_id": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "minLength": 1, "maxLength": 200 }
  }
}"#;

const EMPTY_SCHEMA: &str = r#"{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}"#;

fn thread_exists(ctx: &CommandCtx<'_, '_>, thread_id: &str) -> Result<bool> {
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM chat_thread WHERE thread_id = ?1",
        [thread_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn turn<'a>(ctx: &'a CommandCtx<'_, '_>) -> &'a serde_json::Value {
    &ctx.input["turn"]
}

fn text_of<'a>(value: &'a serde_json::Value, key: &str) -> &'a str {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
}

/// Every thumbnail the given threads' messages rent, read BEFORE the rows go.
fn thumbnails_of(ctx: &CommandCtx<'_, '_>, thread_filter: Option<&str>) -> Result<Vec<String>> {
    let mut statement = ctx.connection().prepare(
        "SELECT DISTINCT thumb_content_id FROM chat_message_attachment
          WHERE thumb_content_id IS NOT NULL AND (?1 IS NULL OR thread_id = ?1)",
    )?;
    let rows = statement.query_map([thread_filter], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
}

/// Let go of thumbnails nothing rents any more. `release_content_now` checks
/// the registry's reference list itself, so a thumbnail another chat still
/// holds stays.
fn release(ctx: &CommandCtx<'_, '_>, content_ids: &[String]) -> Result<()> {
    for content_id in content_ids {
        release_content_now(ctx, content_id)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// chat.save_turn
// ---------------------------------------------------------------------------

fn save_turn() -> CommandDefinition {
    CommandDefinition {
        name: "chat.save_turn",
        owner_schema: "chat",
        input_schema: SAVE_TURN_SCHEMA,
        // A retry of the same turn is a second turn: the shell sends each turn
        // once, and a regenerate says so with `replace_last`.
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "named_thread_exists",
                check: |ctx| {
                    let Some(thread_id) = ctx.optional_str("thread_id") else {
                        return Ok(None);
                    };
                    Ok((!thread_exists(ctx, thread_id)?).then(|| "This chat is gone.".to_owned()))
                },
            },
            CommandCondition {
                predicate: "replace_last_names_a_thread_with_a_turn",
                check: |ctx| {
                    let replace = ctx
                        .input
                        .get("replace_last")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    if !replace {
                        return Ok(None);
                    }
                    let Some(thread_id) = ctx.optional_str("thread_id") else {
                        return Ok(Some(
                            "There is no earlier question to ask again.".to_owned(),
                        ));
                    };
                    let turns: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM chat_message
                          WHERE thread_id = ?1 AND role = 'assistant'",
                        [thread_id],
                        |row| row.get(0),
                    )?;
                    Ok((turns == 0)
                        .then(|| "There is no earlier question to ask again.".to_owned()))
                },
            },
            CommandCondition {
                predicate: "a_refusal_names_its_reason",
                check: |ctx| {
                    let answer = &turn(ctx)["answer"];
                    let refused = text_of(answer, "outcome") == "refused";
                    let reason = answer.get("refusal").is_some();
                    Ok((refused != reason)
                        .then(|| "A refused turn names its reason, and no other does.".to_owned()))
                },
            },
            CommandCondition {
                predicate: "an_attachment_names_what_it_is",
                check: |ctx| {
                    let attachments = turn(ctx)["question"]["attachments"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    for attachment in &attachments {
                        let has = |key: &str| attachment.get(key).is_some();
                        let complete = match text_of(attachment, "kind") {
                            "photo" => has("asset_id") && !has("document_id"),
                            "document" => has("document_id") && !has("asset_id"),
                            "image" => !has("asset_id") && !has("document_id"),
                            _ => false,
                        };
                        let thumb_ok =
                            (text_of(attachment, "kind") == "image") || !has("thumbnail_data_uri");
                        if !complete || !thumb_ok {
                            return Ok(Some(
                                "An attachment is a photo, a document or an image, and names only its own."
                                    .to_owned(),
                            ));
                        }
                    }
                    Ok(None)
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "the_turn_is_in_its_thread",
            check: |ctx| {
                // The named thread, else the one this command minted first.
                let thread_id = super::core::created_row_id(ctx, "thread_id");
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM chat_message m
                      WHERE m.thread_id = ?1 AND m.role = 'assistant'
                        AND m.ordinal = (SELECT MAX(ordinal) FROM chat_message WHERE thread_id = ?1)",
                    [&thread_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the turn did not land in its chat".to_owned()))
            },
        }],
        handler: |ctx| {
            let replace = ctx
                .input
                .get("replace_last")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let question = &turn(ctx)["question"];
            let answer = &turn(ctx)["answer"];

            // THE THREAD: the named one, or a new one titled by its first
            // question.
            let (thread_id, title, created) = match ctx.optional_str("thread_id") {
                Some(existing) => {
                    let title: String = ctx.connection().query_row(
                        "SELECT title FROM chat_thread WHERE thread_id = ?1",
                        [existing],
                        |row| row.get(0),
                    )?;
                    (existing.to_owned(), title, false)
                }
                None => {
                    let thread_id = ctx.next_id();
                    let title = title_of(text_of(question, "text"));
                    if title.is_empty() {
                        return Err(VaultError::InvalidInput {
                            name: "turn".to_owned(),
                            detail: "a chat is titled by a question with words in it".to_owned(),
                        });
                    }
                    let scope = ctx.optional_str("scope_app");
                    ctx.connection().execute(
                        "INSERT INTO chat_thread (thread_id, title, scope_app, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?4)",
                        rusqlite::params![thread_id, title, scope, ctx.now],
                    )?;
                    (thread_id, title, true)
                }
            };

            // A REGENERATE REPLACES THE LAST TURN: its two messages, their
            // cards and attachments go, and the thumbnails nothing rents then.
            let mut released = Vec::new();
            if replace && !created {
                let last_assistant: i64 = ctx.connection().query_row(
                    "SELECT MAX(ordinal) FROM chat_message
                      WHERE thread_id = ?1 AND role = 'assistant'",
                    [&thread_id],
                    |row| row.get(0),
                )?;
                let from = (last_assistant - 1).max(0);
                let mut statement = ctx.connection().prepare(
                    "SELECT DISTINCT thumb_content_id FROM chat_message_attachment
                      WHERE thread_id = ?1 AND message_ordinal >= ?2
                        AND thumb_content_id IS NOT NULL",
                )?;
                released = statement
                    .query_map(rusqlite::params![thread_id, from], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<rusqlite::Result<Vec<String>>>()?;
                drop(statement);
                ctx.connection().execute(
                    "DELETE FROM chat_message WHERE thread_id = ?1 AND ordinal >= ?2",
                    rusqlite::params![thread_id, from],
                )?;
            }

            let next: i64 = ctx.connection().query_row(
                "SELECT COALESCE(MAX(ordinal) + 1, 0) FROM chat_message WHERE thread_id = ?1",
                [&thread_id],
                |row| row.get(0),
            )?;
            let (user_ordinal, assistant_ordinal) = (next, next + 1);

            ctx.connection().execute(
                "INSERT INTO chat_message
                   (thread_id, ordinal, role, text, outcome, refusal, notice, record_json, created_at)
                 VALUES (?1, ?2, 'user', ?3, 'sent', NULL, NULL, NULL, ?4)",
                rusqlite::params![thread_id, user_ordinal, text_of(question, "text"), ctx.now],
            )?;
            ctx.connection().execute(
                "INSERT INTO chat_message
                   (thread_id, ordinal, role, text, outcome, refusal, notice, record_json, created_at)
                 VALUES (?1, ?2, 'assistant', ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    thread_id,
                    assistant_ordinal,
                    text_of(answer, "text"),
                    text_of(answer, "outcome"),
                    answer.get("refusal").and_then(serde_json::Value::as_str),
                    answer.get("notice").and_then(serde_json::Value::as_str),
                    answer.get("record_json").and_then(serde_json::Value::as_str),
                    ctx.now,
                ],
            )?;

            // THE ATTACHMENTS, as references; a camera-roll image as the small
            // thumbnail minted in the byte plane.
            let attachments = question["attachments"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for (position, attachment) in attachments.iter().enumerate() {
                let kind = text_of(attachment, "kind");
                let asset_id = attachment
                    .get("asset_id")
                    .and_then(serde_json::Value::as_str)
                    .filter(|id| {
                        ctx.connection()
                            .query_row(
                                "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1",
                                [id],
                                |row| row.get::<_, i64>(0),
                            )
                            .is_ok_and(|n| n > 0)
                    });
                let document_id = attachment
                    .get("document_id")
                    .and_then(serde_json::Value::as_str)
                    .filter(|id| {
                        ctx.connection()
                            .query_row(
                                "SELECT COUNT(*) FROM core_document WHERE document_id = ?1",
                                [id],
                                |row| row.get::<_, i64>(0),
                            )
                            .is_ok_and(|n| n > 0)
                    });
                let thumb = match attachment
                    .get("thumbnail_data_uri")
                    .and_then(serde_json::Value::as_str)
                {
                    Some(uri) if kind == "image" => {
                        Some(mint_content_from_data_uri(ctx, uri)?.content_id)
                    }
                    _ => None,
                };
                ctx.connection().execute(
                    "INSERT INTO chat_message_attachment
                       (thread_id, message_ordinal, position, kind, label,
                        asset_id, document_id, thumb_content_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    rusqlite::params![
                        thread_id,
                        user_ordinal,
                        i64::try_from(position).unwrap_or(0),
                        kind,
                        text_of(attachment, "label"),
                        asset_id,
                        document_id,
                        thumb,
                    ],
                )?;
            }

            // THE CARDS, as snapshots: no reference to the row they name.
            let cards = answer["cards"].as_array().cloned().unwrap_or_default();
            for (position, card) in cards.iter().enumerate() {
                ctx.connection().execute(
                    "INSERT INTO chat_message_card
                       (thread_id, message_ordinal, position, app, entity, row_id,
                        qualifier, title, subtitle, meta)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    rusqlite::params![
                        thread_id,
                        assistant_ordinal,
                        i64::try_from(position).unwrap_or(0),
                        text_of(card, "app"),
                        text_of(card, "entity"),
                        text_of(card, "id"),
                        text_of(card, "qualifier"),
                        text_of(card, "title"),
                        text_of(card, "subtitle"),
                        text_of(card, "meta"),
                    ],
                )?;
            }

            // THE THREAD MOVES TO THE TOP: its newest activity is now. A thread
            // this command just made already carries it: touching it again
            // would hand the stamp to the touch trigger, which reads the host's
            // clock and not the vault's.
            if !created {
                ctx.connection().execute(
                    "UPDATE chat_thread SET updated_at = ?1 WHERE thread_id = ?2",
                    rusqlite::params![ctx.now, thread_id],
                )?;
            }
            release(ctx, &released)?;

            Ok(serde_json::json!({
                "thread_id": thread_id,
                "title": title,
                "created": created,
                "user_ordinal": user_ordinal,
                "assistant_ordinal": assistant_ordinal,
            }))
        },
        // THE WHOLE TURN IS SEALED: what was said, the cards' titles and the
        // thumbnail leave the audit journal as a token (R-CHAT-6).
        sealed_input: &["turn"],
    }
}

// ---------------------------------------------------------------------------
// chat.rename_thread
// ---------------------------------------------------------------------------

fn rename_thread() -> CommandDefinition {
    CommandDefinition {
        name: "chat.rename_thread",
        owner_schema: "chat",
        input_schema: RENAME_SCHEMA,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "thread_exists",
                check: |ctx| {
                    let thread_id = ctx.required_str("thread_id")?;
                    Ok((!thread_exists(ctx, thread_id)?).then(|| "This chat is gone.".to_owned()))
                },
            },
            CommandCondition {
                predicate: "title_has_words",
                check: |ctx| {
                    let title = ctx.required_str("title")?;
                    Ok(title_of(title)
                        .is_empty()
                        .then(|| "A chat needs a name.".to_owned()))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "title_updated",
            check: |ctx| {
                let thread_id = ctx.required_str("thread_id")?.to_owned();
                let title = title_of(ctx.required_str("title")?);
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM chat_thread WHERE thread_id = ?1 AND title = ?2",
                    rusqlite::params![thread_id, title],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the chat was not renamed".to_owned()))
            },
        }],
        handler: |ctx| {
            let thread_id = ctx.required_str("thread_id")?.to_owned();
            let title = title_of(ctx.required_str("title")?);
            // A rename is activity, and states its own instant for the reason
            // `save_turn` does.
            ctx.connection().execute(
                "UPDATE chat_thread SET title = ?1, updated_at = ?2 WHERE thread_id = ?3",
                rusqlite::params![title, ctx.now, thread_id],
            )?;
            Ok(serde_json::json!({ "thread_id": thread_id, "title": title }))
        },
        sealed_input: &["title"],
    }
}

// ---------------------------------------------------------------------------
// chat.delete_thread, chat.clear
// ---------------------------------------------------------------------------

fn delete_thread() -> CommandDefinition {
    CommandDefinition {
        name: "chat.delete_thread",
        owner_schema: "chat",
        input_schema: THREAD_ID_SCHEMA,
        idempotency: Idempotency::Idempotent,
        // Permanent, and the member asked for it: there is no trash for a chat.
        risk: Risk::Medium,
        confirm: false,
        preconditions: &[],
        postconditions: &[CommandCondition {
            predicate: "thread_and_messages_removed",
            check: |ctx| {
                let thread_id = ctx.required_str("thread_id")?.to_owned();
                let left: i64 = ctx.connection().query_row(
                    "SELECT (SELECT COUNT(*) FROM chat_thread WHERE thread_id = ?1)
                          + (SELECT COUNT(*) FROM chat_message WHERE thread_id = ?1)",
                    [&thread_id],
                    |row| row.get(0),
                )?;
                Ok((left != 0).then(|| "the chat or its messages survived".to_owned()))
            },
        }],
        handler: |ctx| {
            let thread_id = ctx.required_str("thread_id")?.to_owned();
            let released = thumbnails_of(ctx, Some(&thread_id))?;
            // The messages, cards and attachments go with the thread: composite
            // foreign keys, `ON DELETE CASCADE`.
            let deleted = ctx
                .connection()
                .execute("DELETE FROM chat_thread WHERE thread_id = ?1", [&thread_id])?;
            release(ctx, &released)?;
            Ok(serde_json::json!({ "thread_id": thread_id, "deleted": deleted }))
        },
        sealed_input: &[],
    }
}

fn clear() -> CommandDefinition {
    CommandDefinition {
        name: "chat.clear",
        owner_schema: "chat",
        input_schema: EMPTY_SCHEMA,
        idempotency: Idempotency::Idempotent,
        risk: Risk::High,
        confirm: false,
        preconditions: &[],
        postconditions: &[CommandCondition {
            predicate: "no_chat_survived",
            check: |ctx| {
                let left: i64 = ctx.connection().query_row(
                    "SELECT (SELECT COUNT(*) FROM chat_thread)
                          + (SELECT COUNT(*) FROM chat_message)",
                    [],
                    |row| row.get(0),
                )?;
                Ok((left != 0).then(|| "a chat survived being cleared".to_owned()))
            },
        }],
        handler: |ctx| {
            let released = thumbnails_of(ctx, None)?;
            let deleted = ctx.connection().execute("DELETE FROM chat_thread", [])?;
            release(ctx, &released)?;
            Ok(serde_json::json!({ "deleted": deleted }))
        },
        sealed_input: &[],
    }
}
