//! `thread.*`: the only writers of a conversation, and `thread.save_turn` the one that matters.
//!
//! A member's conversation with the on-device assistant is vault data (R-CHAT-1): a `thread` is an
//! entity of its own kind whose title is what the drawer lists and what search finds, its
//! `message`s are children that cascade with it, and a message's attachments are children of the
//! message ([#1135](https://github.com/srikanth235/centraid/issues/1135)). Nothing writes them but
//! these commands, so a chat is backed up and indexed exactly as a note is.
//!
//! What the shared verbs already do is not written again (L5: a chat is an ordinary trashable
//! entity): **a chat is trashed, restored and deleted forever by `entity.trash`, `entity.restore`
//! and `entity.purge`**, and a purge removes its messages and attachments in the same commit and
//! releases the thumbnails nothing rents then. A chat is retitled by `entity.retitle` like any
//! entity: this module has no rename. A chat in the trash is out of every list and out of search,
//! and nothing is saved into it until it is restored.
//!
//! A chat is not a link end, not a `[[title]]` target and takes no tag (`entity_kind.linkable` is
//! 0): `link.add`, `edge.add` and `tag.add` refuse it with a sentence, and the database refuses it
//! as well.
//!
//! ## A proposal has a life, and the vault keeps its end (#1088)
//!
//! A write the assistant makes parks behind a confirm card (R-1088-2). The turn that parked is
//! saved with the outcome `proposed`, and [`settle_proposal`] records how the card ended:
//! `applied`, `dismissed`, `stale` or `failed`. The pending write itself is memory and is inert when
//! its thread is reopened (R-1088-10); the vault stores only the outcome and the line the member
//! was told. A `proposed` message nobody settled is dismissed by the next turn saved into its
//! thread, as a new message dismisses the card in a live session, so a thread holds at most one
//! and it is its last (a unique index holds the one). The `message` table's two triggers hold the
//! rest: a message is never born settled, and only a proposal settles, once.
//!
//! ## What the vault defines, and what a lookup says
//!
//! A refusal's reason and a notice are rows of `message_refusal` and `message_notice` (A1): this
//! module names none of them, it asks the table. `message.outcome` is the one closed state machine
//! and keeps its CHECK and triggers.
//!
//! ## One turn is one commit
//!
//! [`save_turn`] writes the member's question AND the assistant's answer (or refusal, or the part
//! streamed before a stop) in one transaction: a process killed while a turn runs loses that turn
//! whole and never keeps half of it (R-CHAT-5).
//!
//! ## A REFUSAL MUST NOT QUOTE WHAT A DELETE REMOVES
//!
//! A conversation's text and its thumbnails are exactly what "delete this chat" removes. `turn`,
//! `title` and a settled `text` are therefore SEALED input keys: a refusal's sentence never quotes
//! the value, the mechanism Locker uses for a password (R-CHAT-6).
//!
//! ## What a card is, and what is never stored
//!
//! A card is a `message_card` row: the `entity_id` it shows and a closed `qualifier` code, and no
//! word of the item. The thread read resolves the title live, so purging an item leaves none of its
//! words in a card, and the engine sets `entity_id` to NULL, which the read draws as a tombstone.
//! The apps a chat may be scoped to are [`crate::roster`], read here for the input schema and
//! nowhere else. A camera-roll image is stored as a thumbnail of at most 256 pixels the caller made,
//! with the label the member's phone gave it; the original never is. A vault photograph or document
//! is stored as the `entity_id` it is and no words of its own: its title is read live too.

use std::sync::OnceLock;

use base64::Engine as _;
use serde_json::{Value, json};

use crate::chat::title_of;
use crate::commands::entity::{find, purge_one};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};
use crate::model::Kind;
use crate::roster;

/// How an answer may end: the outcomes a turn is saved with (a closed state machine, A1; the
/// question is `sent` and a proposal settles later, by `thread.settle_proposal`).
const OUTCOMES: [&str; 4] = ["answered", "stopped", "refused", "proposed"];

/// One card a message shows: the item and a closed code, and no word of the item.
fn card_schema() -> Value {
    json!({
      "type": "object",
      "required": ["entity_id"],
      "additionalProperties": false,
      "properties": {
        "entity_id": { "type": "string", "minLength": 1 },
        "qualifier": { "type": "string", "pattern": "^[a-z][a-z_]{0,23}$" }
      }
    })
}

fn attachment_schema() -> Value {
    json!({
      "type": "object",
      "required": ["form"],
      "additionalProperties": false,
      "properties": {
        "form": { "enum": ["photo", "document", "image"] },
        "label": { "type": "string", "minLength": 1, "maxLength": 300 },
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
        "refusal": { "type": "string", "minLength": 1 },
        "notice": { "type": "string", "minLength": 1 },
        "cards": { "type": "array", "maxItems": 50, "items": card_schema() }
      }
    })
}

fn save_turn_schema() -> &'static str {
    static SCHEMA: OnceLock<String> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        let mut scopes: Vec<Value> = roster::ids().map(Value::from).collect();
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

const EMPTY_SCHEMA: &str =
    r#"{ "type": "object", "additionalProperties": false, "properties": {} }"#;

/// Why this id is no chat to write into, as a sentence: there is none, or it is in the trash.
fn unusable(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<Option<String>> {
    Ok(match find(ctx.connection(), id)? {
        Some(found) if found.kind == Kind::Thread => found
            .deleted_at
            .map(|_| "This chat is in the trash; restore it first.".to_owned()),
        _ => Some("This chat is gone.".to_owned()),
    })
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
        Some(id) => unusable(ctx, id),
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

/// A reason and a notice are rows of their lookups: an unknown one is refused with a sentence that
/// quotes neither (the turn is sealed).
fn pre_lookups(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let answer = &turn(ctx)["answer"];
    for (key, domain, sentence) in [
        (
            "refusal",
            "message_refusal",
            "That is not a reason a reply is refused for.",
        ),
        (
            "notice",
            "message_notice",
            "That is not a notice a reply carries.",
        ),
    ] {
        let Some(code) = answer.get(key).and_then(Value::as_str) else {
            continue;
        };
        let known: bool = ctx.connection().query_row(
            &format!("SELECT EXISTS (SELECT 1 FROM vocab WHERE domain = '{domain}' AND code = ?1)"),
            [code],
            |row| row.get(0),
        )?;
        if !known {
            return Ok(Some(sentence.to_owned()));
        }
    }
    Ok(None)
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
        // An image is its thumbnail and its label and no vault item; a photo or a document is a
        // vault item and no label or thumbnail, its title is read live (the table's CHECKs say the
        // same).
        let names_itself = if form == "image" {
            has("thumbnail_data_uri") && has("label") && !has("entity_id")
        } else {
            has("entity_id") && !has("thumbnail_data_uri") && !has("label")
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

#[derive(serde::Deserialize)]
struct CardInput {
    entity_id: String,
    qualifier: Option<String>,
}

#[derive(serde::Deserialize)]
struct AttachmentInput {
    form: String,
    label: Option<String>,
    entity_id: Option<String>,
    thumbnail_data_uri: Option<String>,
}

#[derive(serde::Deserialize)]
struct QuestionInput {
    text: String,
    #[serde(default)]
    attachments: Vec<AttachmentInput>,
}

#[derive(serde::Deserialize, Default)]
struct AnswerInput {
    outcome: String,
    text: Option<String>,
    refusal: Option<String>,
    notice: Option<String>,
    #[serde(default)]
    cards: Vec<CardInput>,
}

#[derive(serde::Deserialize)]
struct TurnInput {
    question: QuestionInput,
    answer: AnswerInput,
}

#[derive(serde::Deserialize)]
struct SaveTurnInput {
    thread_id: Option<String>,
    replace_last: Option<bool>,
    scope_app: Option<String>,
    turn: TurnInput,
}

fn insert_message(
    ctx: &CommandCtx<'_, '_>,
    thread_id: &str,
    ordinal: i64,
    role: &str,
    outcome: &str,
    text: &str,
    answer: &AnswerInput,
) -> Result<()> {
    ctx.connection().execute(
        "INSERT INTO message
           (thread_id, ordinal, role, text, outcome, refusal, notice, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        rusqlite::params![
            thread_id,
            ordinal,
            role,
            text,
            outcome,
            answer.refusal,
            answer.notice,
            ctx.now,
        ],
    )?;
    for (position, card) in answer.cards.iter().enumerate() {
        let entity_id = Some(card.entity_id.as_str())
            .filter(|id| matches!(find(ctx.connection(), id), Ok(Some(_))));
        ctx.connection().execute(
            "INSERT INTO message_card (thread_id, ordinal, position, entity_id, qualifier)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                thread_id,
                ordinal,
                i64::try_from(position).unwrap_or(0),
                entity_id,
                card.qualifier,
            ],
        )?;
    }
    Ok(())
}

fn save_turn(ctx: &CommandCtx<'_, '_>) -> Result<Value> {
    let input: SaveTurnInput = ctx.parse_input()?;
    let question = &input.turn.question;
    let answer = &input.turn.answer;
    let connection = ctx.connection();

    // THE THREAD: the named one, or a new one titled by its first question.
    let (thread_id, created) = match input.thread_id {
        Some(existing) => (existing, false),
        None => {
            let id = ctx.insert_entity(Kind::Thread, &title_of(&question.text))?;
            connection.execute(
                "INSERT INTO thread (id, scope) VALUES (?1, ?2)",
                rusqlite::params![id, input.scope_app],
            )?;
            (id, true)
        }
    };

    // A REGENERATE REPLACES THE LAST TURN: its two messages (and their attachments, by cascade) go.
    if input.replace_last.unwrap_or(false) && !created {
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
    let empty_answer = AnswerInput::default();
    insert_message(
        ctx,
        &thread_id,
        user_ordinal,
        "user",
        "sent",
        &question.text,
        &empty_answer,
    )?;
    insert_message(
        ctx,
        &thread_id,
        assistant_ordinal,
        "assistant",
        &answer.outcome,
        answer.text.as_deref().unwrap_or_default(),
        answer,
    )?;

    // THE ATTACHMENTS: an entity the engine keeps honest, or a thumbnail rented from the blob plane.
    for (position, attachment) in question.attachments.iter().enumerate() {
        let entity_id = attachment
            .entity_id
            .as_deref()
            .filter(|id| matches!(find(connection, id), Ok(Some(_))));
        let thumb = attachment
            .thumbnail_data_uri
            .as_deref()
            .map(|uri| keep_thumbnail(ctx, uri))
            .transpose()?;
        connection.execute(
            "INSERT INTO message_attachment (thread_id, ordinal, position, form, label, entity_id, thumb)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                thread_id,
                user_ordinal,
                i64::try_from(position).unwrap_or(0),
                attachment.form,
                attachment.label,
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
        "released": released,
    }))
}

// ---------------------------------------------------------------------------
// thread.settle_proposal, thread.clear
// ---------------------------------------------------------------------------

fn pre_settle(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let thread_id = ctx.required_str("thread_id")?;
    if let Some(sentence) = unusable(ctx, thread_id)? {
        return Ok(Some(sentence));
    }
    // ONLY THE LAST ANSWER CAN BE WAITING: `save_turn` dismisses the one before it.
    let asked = ctx.required_str("outcome")?;
    let waiting = last_answer(ctx, thread_id)?
        .is_some_and(|(_, outcome)| outcome == "proposed" || outcome == asked);
    Ok((!waiting).then(|| "Nothing is waiting on that.".to_owned()))
}

#[derive(serde::Deserialize)]
struct SettleProposalInput {
    thread_id: String,
    outcome: String,
    text: Option<String>,
}

fn settle_proposal(ctx: &CommandCtx<'_, '_>) -> Result<Value> {
    let input: SettleProposalInput = ctx.parse_input()?;
    let Some((ordinal, current)) = last_answer(ctx, &input.thread_id)? else {
        return Ok(json!({ "thread_id": input.thread_id, "settled": false }));
    };
    // A tap delivered twice settles once: the second finds it settled the way it asks.
    if current == input.outcome {
        return Ok(
            json!({ "thread_id": input.thread_id, "assistant_ordinal": ordinal, "settled": false }),
        );
    }
    // The settled line replaces the proposal's, in the statement that moves the outcome (the trigger
    // lets the outcome move only from `proposed`).
    ctx.connection().execute(
        "UPDATE message SET outcome = ?1, text = COALESCE(?2, text), updated_at = ?3
          WHERE thread_id = ?4 AND ordinal = ?5",
        rusqlite::params![input.outcome, input.text, ctx.now, input.thread_id, ordinal],
    )?;
    ctx.touch(&input.thread_id)?;
    Ok(json!({ "thread_id": input.thread_id, "assistant_ordinal": ordinal, "settled": true }))
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
    let released = crate::blob::collect(ctx.connection())?;
    Ok(json!({ "deleted": purged.len(), "released": released }))
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
                    predicate: "a_reason_and_a_notice_are_lookup_rows",
                    check: pre_lookups,
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
            // THE WHOLE TURN IS SEALED: what was said, the cards' titles and the thumbnail never
            // appear in a refusal's sentence (R-CHAT-6).
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
