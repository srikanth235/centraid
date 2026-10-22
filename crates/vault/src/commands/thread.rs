//! `thread.*`: the only writers of a conversation, and `thread.save_turn` the one that matters.
//!
//! A member's conversation with the on-device assistant is vault data (R-CHAT-1): a `thread` is an
//! entity of its own kind whose title is what the drawer lists and what search finds, its
//! `message`s are children that cascade with it, and a message's attachments are children of the
//! message ([#1135](https://github.com/srikanth235/centraid/issues/1135)). Nothing writes them but
//! these commands, so a chat is journalled, backed up and indexed exactly as a note is.
//!
//! What the shared verbs already do is not written again: **deleting a chat is `entity.purge`**
//! (a chat has no trash, R-CHAT-8, so `Kind::has_trash` is false for it and the purge needs no
//! trashing first), and the thumbnails nothing rents then are collected in the same commit.
//! `entity.retitle` refuses a thread, because a title is the first thing the member said and so
//! leaves the journal sealed ([`rename`]); that is the only reason this module has a rename.
//!
//! ## A proposal has a life, and the vault keeps its end (#1088)
//!
//! A write the assistant makes parks behind a confirm card (R-1088-2). The turn that parked is
//! saved with the outcome `proposed`, and [`settle_proposal`] records how the card ended:
//! `applied`, `dismissed`, `stale` or `failed`. The pending write itself is memory and is inert when
//! its thread is reopened (R-1088-10); the vault stores only the outcome and the line the member
//! was told. A `proposed` message nobody settled is dismissed by the next turn saved into its
//! thread, as a new message dismisses the card in a live session, so a thread holds at most one
//! and it is its last. The `message` table's two triggers hold the rest: a message is never born
//! settled, and only a proposal settles, once.
//!
//! ## One turn is one commit
//!
//! [`save_turn`] writes the member's question AND the assistant's answer (or refusal, or the part
//! streamed before a stop) in one transaction: a process killed while a turn runs loses that turn
//! whole and never keeps half of it (R-CHAT-5).
//!
//! ## THE JOURNAL MUST NOT KEEP WHAT A DELETE REMOVES
//!
//! A conversation's text, its cards (titles read out of other apps) and its thumbnails are exactly
//! what "delete this chat" removes. `turn`, `title` and a settled `text` are therefore SEALED input
//! keys: the journal keeps a token and never the value, the mechanism Locker uses for a password
//! (R-CHAT-6).
//!
//! ## What a card is, and what is never stored
//!
//! A card is a JSON snapshot in the answer's own row (R-CHAT-3): no reference to the row it names, so
//! a member's deleting a task is never a refusal or a hole in their history. The apps a card may name
//! and a chat may be scoped to are [`crate::roster`], read here for the input schema and nowhere else.
//! A camera-roll image is stored as a thumbnail of at most 256 pixels the caller made; the original
//! never is. A vault photograph or document is stored as the `entity_id` it is, which the engine sets
//! to NULL if the entity is purged: the chat keeps the question and its label.

use std::sync::OnceLock;

use base64::Engine as _;
use serde_json::{Value, json};

use crate::chat::title_of;
use crate::commands::entity::{find, purge_one};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};
use crate::model::Kind;
use crate::roster;

const OUTCOMES: [&str; 4] = ["answered", "stopped", "refused", "proposed"];
const REFUSALS: [&str; 9] = [
    "no_tool_fits",
    "query_failed",
    "unparsable",
    "model_absent",
    "model_failed",
    "vision_absent",
    "attachment_unsupported",
    "attachment_unreadable",
    "attachment_too_large",
];

/// One card a message snapshots. `app` is the roster's.
fn card_schema() -> Value {
    json!({
      "type": "object",
      "required": ["app", "entity", "id", "title"],
      "additionalProperties": false,
      "properties": {
        "app": { "enum": roster::ids().collect::<Vec<_>>() },
        "entity": { "type": "string", "minLength": 1 },
        "id": { "type": "string", "minLength": 1 },
        "qualifier": { "type": "string" },
        "title": { "type": "string" },
        "subtitle": { "type": "string" },
        "meta": { "type": "string" }
      }
    })
}

fn attachment_schema() -> Value {
    json!({
      "type": "object",
      "required": ["form", "label"],
      "additionalProperties": false,
      "properties": {
        "form": { "enum": ["photo", "document", "image"] },
        "label": { "type": "string", "maxLength": 300 },
        "entity_id": { "type": "string", "minLength": 1 },
        "thumbnail_data_uri": { "type": "string", "maxLength": 400_000 }
      }
    })
}

fn question_schema() -> Value {
    json!({
      "type": "object",
      "required": ["text"],
      "additionalProperties": false,
      "properties": {
        "text": { "type": "string", "minLength": 1, "maxLength": 8000 },
        "attachments": { "type": "array", "maxItems": 2, "items": attachment_schema() }
      }
    })
}

fn answer_schema() -> Value {
    json!({
      "type": "object",
      "required": ["outcome"],
      "additionalProperties": false,
      "properties": {
        "outcome": { "enum": OUTCOMES },
        "text": { "type": "string", "maxLength": 20_000 },
        "refusal": { "enum": REFUSALS },
        "notice": { "enum": ["doc_truncated"] },
        "record_json": { "type": "string", "maxLength": 20_000 },
        "cards": { "type": "array", "maxItems": 50, "items": card_schema() }
      }
    })
}

fn save_turn_schema() -> &'static str {
    static SCHEMA: OnceLock<String> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        let mut scopes: Vec<Value> = roster::scopes().map(Value::from).collect();
        scopes.push(Value::Null);
        json!({
          "type": "object",
          "required": ["turn"],
          "additionalProperties": false,
          "properties": {
            "thread_id": { "type": "string", "minLength": 1 },
            "replace_last": { "type": "boolean" },
            "scope_app": { "enum": scopes },
            "turn": {
              "type": "object",
              "required": ["question", "answer"],
              "additionalProperties": false,
              "properties": { "question": question_schema(), "answer": answer_schema() }
            }
          }
        })
        .to_string()
    })
}

const SETTLE_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["thread_id", "outcome"],
  "additionalProperties": false,
  "properties": {
    "thread_id": { "type": "string", "minLength": 1 },
    "outcome": { "enum": ["applied", "dismissed", "stale", "failed"] },
    "text": { "type": "string", "minLength": 1, "maxLength": 20000 }
  }
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

const EMPTY_SCHEMA: &str =
    r#"{ "type": "object", "additionalProperties": false, "properties": {} }"#;

fn is_thread(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<bool> {
    Ok(find(ctx.connection(), id)?.is_some_and(|found| found.kind == Kind::Thread))
}

fn gone() -> Option<String> {
    Some("This chat is gone.".to_owned())
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn turn<'a>(ctx: &'a CommandCtx<'_, '_>) -> &'a Value {
    &ctx.input["turn"]
}

fn attachments(ctx: &CommandCtx<'_, '_>) -> Vec<Value> {
    turn(ctx)["question"]["attachments"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn replaces(ctx: &CommandCtx<'_, '_>) -> bool {
    ctx.input
        .get("replace_last")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// The ordinal and outcome of a thread's last assistant message.
fn last_answer(ctx: &CommandCtx<'_, '_>, thread_id: &str) -> Result<Option<(i64, String)>> {
    Ok(ctx
        .connection()
        .query_row(
            "SELECT ordinal, outcome FROM message
              WHERE thread_id = ?1 AND role = 'assistant' ORDER BY ordinal DESC LIMIT 1",
            [thread_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok())
}

// ---------------------------------------------------------------------------
// thread.save_turn
// ---------------------------------------------------------------------------

fn pre_thread_named(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    match ctx.optional_str("thread_id") {
        Some(id) => Ok((!is_thread(ctx, id)?).then(gone).flatten()),
        None => Ok(None),
    }
}

fn pre_replace(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if !replaces(ctx) {
        return Ok(None);
    }
    let nothing = || Some("There is no earlier question to ask again.".to_owned());
    let Some(thread_id) = ctx.optional_str("thread_id") else {
        return Ok(nothing());
    };
    Ok(last_answer(ctx, thread_id)?.map_or_else(nothing, |_| None))
}

fn pre_refusal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let answer = &turn(ctx)["answer"];
    let refused = str_of(answer, "outcome") == "refused";
    Ok((refused != answer.get("refusal").is_some())
        .then(|| "A refused turn names its reason, and no other does.".to_owned()))
}

fn pre_title(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok((ctx.optional_str("thread_id").is_none()
        && title_of(str_of(&turn(ctx)["question"], "text")).is_empty())
    .then(|| "A chat is titled by a question with words in it.".to_owned()))
}

fn pre_attachments(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    for attachment in attachments(ctx) {
        let form = str_of(&attachment, "form");
        let has = |key: &str| attachment.get(key).is_some();
        let names_itself = if form == "image" {
            !has("entity_id")
        } else {
            has("entity_id") && !has("thumbnail_data_uri")
        };
        if !names_itself {
            return Ok(Some(
                "An attachment is a photo, a document or an image, and names only its own."
                    .to_owned(),
            ));
        }
        if has("thumbnail_data_uri") {
            if ctx.blobs().is_none() {
                return Ok(Some(
                    "this vault has no content store to keep a thumbnail in".to_owned(),
                ));
            }
            if decode_data_uri(str_of(&attachment, "thumbnail_data_uri")).is_none() {
                return Ok(Some("a thumbnail is a base64 image data URI".to_owned()));
            }
        }
        if let Some(found) = attachment
            .get("entity_id")
            .and_then(Value::as_str)
            .map(|id| find(ctx.connection(), id))
            .transpose()?
            .flatten()
        {
            let wants = if form == "photo" {
                Kind::Photo
            } else {
                Kind::Document
            };
            if found.kind != wants {
                return Ok(Some(format!(
                    "“{}” is a {}, not a {form}",
                    found.title,
                    found.kind.noun()
                )));
            }
        }
    }
    Ok(None)
}

/// `(media type, bytes)` of a `data:image/...;base64,` URI.
fn decode_data_uri(uri: &str) -> Option<(String, Vec<u8>)> {
    let rest = uri.strip_prefix("data:")?;
    let (head, payload) = rest.split_once(',')?;
    let media_type = head.strip_suffix(";base64")?;
    media_type.starts_with("image/").then_some(())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    Some((media_type.to_owned(), bytes))
}

/// Keep a thumbnail's bytes in the content store and claim them; the hash the attachment rents.
fn keep_thumbnail(ctx: &CommandCtx<'_, '_>, uri: &str) -> Result<String> {
    let invariant = |context: String| VaultError::Invariant { context };
    let (_, bytes) = decode_data_uri(uri)
        .ok_or_else(|| invariant("a precondition said the thumbnail decodes".to_owned()))?;
    let store = ctx
        .blobs()
        .ok_or_else(|| invariant("a precondition said the vault had a content store".to_owned()))?;
    let hash = store
        .put(&bytes)
        .map_err(|error| invariant(format!("the content store refused a thumbnail: {error}")))?;
    crate::blob::stage(
        ctx.connection(),
        &hash,
        i64::try_from(bytes.len()).unwrap_or(i64::MAX),
    )?;
    Ok(hash)
}

fn insert_message(
    ctx: &CommandCtx<'_, '_>,
    thread_id: &str,
    ordinal: i64,
    role: &str,
    outcome: &str,
    text: &str,
    answer: &Value,
) -> Result<()> {
    let cards = answer.get("cards").cloned().unwrap_or_else(|| json!([]));
    let card = |card: &Value| {
        json!({
            "app": str_of(card, "app"), "entity": str_of(card, "entity"), "id": str_of(card, "id"),
            "qualifier": str_of(card, "qualifier"), "title": str_of(card, "title"),
            "subtitle": str_of(card, "subtitle"), "meta": str_of(card, "meta"),
        })
    };
    let snapshot: Vec<Value> = cards
        .as_array()
        .map(|all| all.iter().map(card).collect())
        .unwrap_or_default();
    let text_of = |key: &str| answer.get(key).and_then(Value::as_str);
    ctx.connection().execute(
        "INSERT INTO message
           (thread_id, ordinal, role, text, outcome, refusal, notice, record, cards, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        rusqlite::params![
            thread_id,
            ordinal,
            role,
            text,
            outcome,
            text_of("refusal"),
            text_of("notice"),
            text_of("record_json"),
            Value::Array(snapshot).to_string(),
            ctx.now,
        ],
    )?;
    Ok(())
}

fn save_turn(ctx: &CommandCtx<'_, '_>) -> Result<Value> {
    let question = &turn(ctx)["question"];
    let answer = &turn(ctx)["answer"];
    let connection = ctx.connection();

    // THE THREAD: the named one, or a new one titled by its first question.
    let (thread_id, created) = match ctx.optional_str("thread_id") {
        Some(existing) => (existing.to_owned(), false),
        None => {
            let id = ctx.insert_entity(Kind::Thread, &title_of(str_of(question, "text")))?;
            connection.execute(
                "INSERT INTO thread (id, scope) VALUES (?1, ?2)",
                rusqlite::params![id, ctx.optional_str("scope_app")],
            )?;
            (id, true)
        }
    };

    // A REGENERATE REPLACES THE LAST TURN: its two messages (and their attachments, by cascade) go.
    if replaces(ctx) && !created {
        let last = last_answer(ctx, &thread_id)?.map_or(0, |(ordinal, _)| ordinal);
        connection.execute(
            "DELETE FROM message WHERE thread_id = ?1 AND ordinal >= ?2",
            rusqlite::params![thread_id, (last - 1).max(0)],
        )?;
    }

    // A NEW MESSAGE DISMISSES THE CARD THAT WAS WAITING (R-1088-10): the thread never holds a second
    // proposal, and the one it holds is its last. Its words stay as the member last saw them.
    connection.execute(
        "UPDATE message SET outcome = 'dismissed', updated_at = ?2
          WHERE thread_id = ?1 AND outcome = 'proposed'",
        rusqlite::params![thread_id, ctx.now],
    )?;
    let user_ordinal: i64 = connection.query_row(
        "SELECT COALESCE(MAX(ordinal) + 1, 0) FROM message WHERE thread_id = ?1",
        [&thread_id],
        |row| row.get(0),
    )?;
    let assistant_ordinal = user_ordinal + 1;
    insert_message(
        ctx,
        &thread_id,
        user_ordinal,
        "user",
        "sent",
        str_of(question, "text"),
        &json!({}),
    )?;
    insert_message(
        ctx,
        &thread_id,
        assistant_ordinal,
        "assistant",
        str_of(answer, "outcome"),
        str_of(answer, "text"),
        answer,
    )?;

    // THE ATTACHMENTS: an entity the engine keeps honest, or a thumbnail rented from the blob plane.
    for (position, attachment) in attachments(ctx).iter().enumerate() {
        let entity_id = attachment
            .get("entity_id")
            .and_then(Value::as_str)
            .filter(|id| matches!(find(connection, id), Ok(Some(_))));
        let thumb = attachment
            .get("thumbnail_data_uri")
            .and_then(Value::as_str)
            .map(|uri| keep_thumbnail(ctx, uri))
            .transpose()?;
        connection.execute(
            "INSERT INTO message_attachment (thread_id, ordinal, position, form, label, entity_id, thumb)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                thread_id,
                user_ordinal,
                i64::try_from(position).unwrap_or(0),
                str_of(attachment, "form"),
                str_of(attachment, "label"),
                entity_id,
                thumb,
            ],
        )?;
    }

    // THE THREAD MOVES TO THE TOP, and is indexed again: its words changed.
    if !created {
        ctx.touch(&thread_id)?;
    }
    let released = crate::blob::collect(connection)?;
    let title: String = connection.query_row(
        "SELECT title FROM entity WHERE id = ?1",
        [&thread_id],
        |row| row.get(0),
    )?;
    Ok(json!({
        "thread_id": thread_id,
        "title": title,
        "created": created,
        "user_ordinal": user_ordinal,
        "assistant_ordinal": assistant_ordinal,
        "released": released.len(),
    }))
}

// ---------------------------------------------------------------------------
// thread.settle_proposal, thread.rename, thread.clear
// ---------------------------------------------------------------------------

fn pre_settle(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let thread_id = ctx.required_str("thread_id")?;
    if !is_thread(ctx, thread_id)? {
        return Ok(gone());
    }
    // ONLY THE LAST ANSWER CAN BE WAITING: `save_turn` dismisses the one before it.
    let asked = ctx.required_str("outcome")?;
    let waiting = last_answer(ctx, thread_id)?
        .is_some_and(|(_, outcome)| outcome == "proposed" || outcome == asked);
    Ok((!waiting).then(|| "Nothing is waiting on that.".to_owned()))
}

fn settle_proposal(ctx: &CommandCtx<'_, '_>) -> Result<Value> {
    let thread_id = ctx.required_str("thread_id")?;
    let outcome = ctx.required_str("outcome")?;
    let Some((ordinal, current)) = last_answer(ctx, thread_id)? else {
        return Ok(json!({ "thread_id": thread_id, "settled": false }));
    };
    // A tap delivered twice settles once: the second finds it settled the way it asks.
    if current == outcome {
        return Ok(
            json!({ "thread_id": thread_id, "assistant_ordinal": ordinal, "settled": false }),
        );
    }
    // The settled line replaces the proposal's, in the statement that moves the outcome (the trigger
    // lets the outcome move only from `proposed`).
    ctx.connection().execute(
        "UPDATE message SET outcome = ?1, text = COALESCE(?2, text), updated_at = ?3
          WHERE thread_id = ?4 AND ordinal = ?5",
        rusqlite::params![
            outcome,
            ctx.optional_str("text"),
            ctx.now,
            thread_id,
            ordinal
        ],
    )?;
    ctx.touch(thread_id)?;
    Ok(json!({ "thread_id": thread_id, "assistant_ordinal": ordinal, "settled": true }))
}

fn pre_rename(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if !is_thread(ctx, ctx.required_str("thread_id")?)? {
        return Ok(gone());
    }
    Ok(title_of(ctx.required_str("title")?)
        .is_empty()
        .then(|| "A chat needs a name.".to_owned()))
}

fn rename(ctx: &CommandCtx<'_, '_>) -> Result<Value> {
    let thread_id = ctx.required_str("thread_id")?;
    let title = title_of(ctx.required_str("title")?);
    ctx.connection().execute(
        "UPDATE entity SET title = ?2 WHERE id = ?1",
        [thread_id, title.as_str()],
    )?;
    ctx.touch(thread_id)?;
    Ok(json!({ "thread_id": thread_id, "title": title }))
}

fn clear(ctx: &CommandCtx<'_, '_>) -> Result<Value> {
    let ids: Vec<String> = ctx
        .connection()
        .prepare("SELECT id FROM thread")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut purged = Vec::new();
    for id in &ids {
        purge_one(ctx, id, &mut purged)?;
    }
    crate::blob::collect(ctx.connection())?;
    Ok(json!({ "deleted": purged.len() }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition {
            name: "thread.save_turn",
            owner_schema: "thread",
            input_schema: save_turn_schema(),
            // A retry of the same turn is a second turn: the shell sends each turn once, and a
            // regenerate says so with `replace_last`.
            idempotency: Idempotency::Once,
            risk: Risk::Low,
            confirm: false,
            preconditions: &[
                CommandCondition {
                    predicate: "named_thread_exists",
                    check: pre_thread_named,
                },
                CommandCondition {
                    predicate: "replace_last_names_a_thread_with_a_turn",
                    check: pre_replace,
                },
                CommandCondition {
                    predicate: "a_refusal_names_its_reason",
                    check: pre_refusal,
                },
                CommandCondition {
                    predicate: "a_new_chat_is_titled_by_words",
                    check: pre_title,
                },
                CommandCondition {
                    predicate: "an_attachment_names_what_it_is",
                    check: pre_attachments,
                },
            ],
            postconditions: &[],
            handler: save_turn,
            // THE WHOLE TURN IS SEALED: what was said, the cards' titles and the thumbnail leave the
            // audit journal as a token (R-CHAT-6).
            sealed_input: &["turn"],
        },
        CommandDefinition {
            name: "thread.settle_proposal",
            owner_schema: "thread",
            input_schema: SETTLE_SCHEMA,
            idempotency: Idempotency::Idempotent,
            risk: Risk::Low,
            confirm: false,
            preconditions: &[CommandCondition {
                predicate: "a_proposal_is_waiting",
                check: pre_settle,
            }],
            postconditions: &[],
            handler: settle_proposal,
            // The settled line is what was said, like the turn it replaces.
            sealed_input: &["text"],
        },
        CommandDefinition {
            name: "thread.rename",
            owner_schema: "thread",
            input_schema: RENAME_SCHEMA,
            idempotency: Idempotency::Idempotent,
            risk: Risk::Low,
            confirm: false,
            preconditions: &[CommandCondition {
                predicate: "thread_exists_and_title_has_words",
                check: pre_rename,
            }],
            postconditions: &[],
            handler: rename,
            sealed_input: &["title"],
        },
        // Permanent, and the member asked for it: every chat, with its messages and thumbnails.
        CommandDefinition {
            risk: Risk::High,
            ..CommandDefinition::plain(
                "thread.clear",
                "thread",
                EMPTY_SCHEMA,
                Idempotency::Idempotent,
                &[],
                clear,
            )
        },
    ]
}
