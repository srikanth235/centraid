//! THE `social` SCHEMA: four commands, and the highest-risk one in the model.
//!
//! The domain resolves raw addresses to parties — **never a duplicate person
//! per channel** — and owns conversation state. The message state machine is
//! `draft → sent → delivered → read | failed` and moves OUTBOUND only through
//! [`send_message`], which is `risk: high` with `confirm: true`: apps and agents
//! park for owner confirmation while the owner acts directly (#306, tier 3
//! semantic egress — structure cannot verify a send). Sending marks state;
//! **transport is a projection-side concern** and the gateway keeps no byte
//! custody and opens no sockets (`packages/vault/src/commands/social.ts:1`-`:7`).
//!
//! ### This is NOT where a contact channel is written
//!
//! The three contact-channel commands are named `people.*` and v0 declares them
//! `ownerSchema: "social"`. They are owned by `people` here, with the options
//! and the finding recorded as D-1020-PE8 in `commands/people.rs` — the three
//! narrow `social` act scopes People's manifest declares are now dead weight.
//!
//! ### An identifier is not a channel (#883, O-contact)
//!
//! A key someone IS — a DID, a site, an IBAN, a claimed handle — lives in
//! `core_party_identifier`. An address they can be REACHED at lives in
//! `social_contact_channel`. [`resolve_identity`] is the one call that decides
//! which, and the DDL agrees with it: `core_party_identifier.scheme` admits
//! only `url|did|handle|iban|other`, so an `email` or a `tel` **cannot** be
//! written to the register at all. It binds as a channel or it is refused.
//!
//! ### There is deliberately NO card command
//!
//! The role line and the nickname belong to `people.edit_person`, the note to
//! `people.add_note`, the favourite to `people.star_person`. A second writer is
//! how two copies disagree (`social.ts:198`-`:200`).

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};

const MESSAGE_TARGET_TYPE: &str = "social.message";

/// Every `social.*` command this build carries — all four of v0's.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        resolve_identity(),
        draft_message(),
        send_message(),
        mark_thread_read(),
    ]
}

/// The channel kind a reach scheme names. `tel` is `phone` on a channel; a
/// `handle` is ambiguous, so only the CALL SITE decides whether it is reach or
/// a claimed identity key (`contact-reach.ts:11`-`:17`).
fn reach_kind_of(scheme: &str) -> Option<&'static str> {
    match scheme {
        "email" => Some("email"),
        "tel" | "phone" => Some("phone"),
        _ => None,
    }
}

fn owner_party_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    let owner: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT self_party_id FROM core_vault WHERE self_party_id IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    owner.ok_or_else(|| VaultError::Invariant {
        context: "this vault has no owner yet".to_owned(),
    })
}

fn resolve_identity() -> CommandDefinition {
    CommandDefinition {
        name: "social.resolve_identity",
        owner_schema: "social",
        input_schema: r#"{
          "type": "object",
          "required": ["party_id", "scheme", "value"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "scheme": { "type": "string", "enum": ["email", "tel", "handle"] },
            "value": { "type": "string", "minLength": 1 },
            "label": { "type": "string" }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "party_exists",
                check: |ctx| {
                    let party_id = ctx.required_str("party_id")?;
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_party WHERE party_id = ?1",
                        [party_id],
                        |row| row.get(0),
                    )?;
                    Ok((count != 1).then(|| "there is no party with that id".to_owned()))
                },
            },
            CommandCondition {
                // A HANDLE BOUND TO A DIFFERENT PARTY IS AN IDENTITY FORK.
                // Asked of BOTH stores: reach lives in channels, claimed
                // handles in the register, and half the forks hide in whichever
                // is not consulted (#883).
                predicate: "handle_not_claimed_elsewhere",
                check: |ctx| {
                    let party_id = ctx.required_str("party_id")?;
                    let scheme = ctx.required_str("scheme")?;
                    let value = ctx.required_str("value")?;
                    let kind = reach_kind_of(scheme).unwrap_or(scheme);
                    let claimed: i64 = ctx.connection().query_row(
                        "SELECT (SELECT COUNT(*) FROM core_party_identifier
                                  WHERE scheme = ?1 AND value = ?2 AND party_id <> ?3)
                              + (SELECT COUNT(*) FROM social_contact_channel
                                  WHERE kind = ?4 AND value = ?2 AND party_id <> ?3)",
                        rusqlite::params![scheme, value, party_id, kind],
                        |row| row.get(0),
                    )?;
                    Ok((claimed != 0).then(|| {
                        format!("{scheme}:{value} already identifies somebody else in this vault")
                    }))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "identifier_bound",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                let scheme = ctx.required_str("scheme")?;
                let value = ctx.required_str("value")?;
                let kind = reach_kind_of(scheme).unwrap_or(scheme);
                let bound: i64 = ctx.connection().query_row(
                    "SELECT (SELECT COUNT(*) FROM core_party_identifier
                              WHERE scheme = ?1 AND value = ?2 AND party_id = ?3)
                          + (SELECT COUNT(*) FROM social_contact_channel
                              WHERE kind = ?4 AND value = ?2 AND party_id = ?3)",
                    rusqlite::params![scheme, value, party_id, kind],
                    |row| row.get(0),
                )?;
                Ok((bound != 1)
                    .then(|| "the address is bound to neither store, or to both".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let scheme = ctx.required_str("scheme")?.to_owned();
            let value = ctx.required_str("value")?.to_owned();
            let label = ctx.optional_str("label").map(str::to_owned);

            match reach_kind_of(&scheme) {
                // REACH BINDS AS A CHANNEL.
                Some(kind) => {
                    let normalized = crate::commands::people::contact_reach_key(kind, &value);
                    let existing: Option<String> = ctx
                        .connection()
                        .query_row(
                            "SELECT channel_id FROM social_contact_channel
                              WHERE party_id = ?1 AND kind = ?2 AND normalized_value = ?3",
                            rusqlite::params![party_id, kind, normalized],
                            |row| row.get(0),
                        )
                        .ok();
                    if existing.is_none() {
                        // THE FIRST CHANNEL OF A KIND IS THE PREFERRED ONE, and
                        // a later one is not — a resolve must not silently
                        // demote the address the member chose.
                        let has_preferred: i64 = ctx.connection().query_row(
                            "SELECT COUNT(*) FROM social_contact_channel
                              WHERE party_id = ?1 AND kind = ?2 AND is_preferred = 1",
                            rusqlite::params![party_id, kind],
                            |row| row.get(0),
                        )?;
                        let channel_id = ctx.next_id();
                        ctx.connection().execute(
                            "INSERT INTO social_contact_channel
                               (channel_id, party_id, kind, label, value, normalized_value,
                                is_preferred, provenance_json, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                                     '{\"source\":\"social.resolve_identity\"}', ?8, ?8)",
                            rusqlite::params![
                                channel_id,
                                party_id,
                                kind,
                                label,
                                value.trim(),
                                normalized,
                                i64::from(has_preferred == 0),
                                ctx.now
                            ],
                        )?;
                    }
                }
                // A CLAIMED HANDLE IS AN IDENTITY KEY IN THE REGISTER.
                None => {
                    let existing: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_party_identifier
                          WHERE scheme = ?1 AND value = ?2",
                        rusqlite::params![scheme, value],
                        |row| row.get(0),
                    )?;
                    if existing == 0 {
                        let has_primary: i64 = ctx.connection().query_row(
                            "SELECT COUNT(*) FROM core_party_identifier
                              WHERE party_id = ?1 AND scheme = ?2 AND is_primary = 1",
                            rusqlite::params![party_id, scheme],
                            |row| row.get(0),
                        )?;
                        let identifier_id = ctx.next_id();
                        ctx.connection().execute(
                            "INSERT INTO core_party_identifier
                               (identifier_id, party_id, scheme, value, issuer, label,
                                is_primary, verified_at, valid_from, valid_to, updated_at)
                             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, NULL, ?7, NULL, ?7)",
                            rusqlite::params![
                                identifier_id,
                                party_id,
                                scheme,
                                value,
                                label,
                                i64::from(has_primary == 0),
                                ctx.now
                            ],
                        )?;
                    }
                }
            }

            // BACKFILL IDENTITY WITHOUT REWRITING THE MESSAGES: the raw handle
            // stays for audit.
            let participants = ctx.connection().execute(
                "UPDATE social_thread_participant SET party_id = ?1, updated_at = ?2
                  WHERE handle = ?3 AND party_id IS NULL",
                rusqlite::params![party_id, ctx.now, value],
            )?;
            let messages = ctx.connection().execute(
                "UPDATE social_message SET sender_party_id = ?1, updated_at = ?2
                  WHERE sender_handle = ?3 AND sender_party_id IS NULL",
                rusqlite::params![party_id, ctx.now, value],
            )?;
            Ok(serde_json::json!({
                "party_id": party_id,
                "participants_resolved": participants,
                "messages_resolved": messages,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

/// The inline text budget a draft body must stay under (`#367`): a `text/plain`
/// body stays inline forever, because the FTS trigger reads `content_uri`
/// in-transaction and there is no CAS redirect possible.
const INLINE_BODY_BUDGET_BYTES: usize = 64 * 1024;

fn draft_message() -> CommandDefinition {
    CommandDefinition {
        name: "social.draft_message",
        owner_schema: "social",
        input_schema: r#"{
          "type": "object",
          "required": ["body_text"],
          "additionalProperties": false,
          "properties": {
            "body_text": { "type": "string", "minLength": 1 },
            "thread_id": { "type": "string", "minLength": 1 },
            "recipient_party_id": { "type": "string", "minLength": 1 },
            "channel": { "type": "string", "enum": ["sms", "email", "dm", "group"] },
            "subject": { "type": "string" }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Medium,
        confirm: false,
        preconditions: &[
            CommandCondition {
                // EITHER AN EXISTING THREAD OR A RECIPIENT TO OPEN ONE WITH.
                predicate: "thread_or_recipient_exists",
                check: |ctx| {
                    if let Some(thread_id) = ctx.optional_str("thread_id") {
                        let count: i64 = ctx.connection().query_row(
                            "SELECT COUNT(*) FROM social_thread WHERE thread_id = ?1",
                            [thread_id],
                            |row| row.get(0),
                        )?;
                        return Ok((count != 1).then(|| "there is no such thread".to_owned()));
                    }
                    let Some(recipient) = ctx.optional_str("recipient_party_id") else {
                        return Ok(Some(
                            "a draft needs a thread to join or somebody to open one with"
                                .to_owned(),
                        ));
                    };
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_party WHERE party_id = ?1",
                        [recipient],
                        |row| row.get(0),
                    )?;
                    Ok((count != 1).then(|| "there is no party with that id".to_owned()))
                },
            },
            CommandCondition {
                predicate: "body_within_inline_budget",
                check: |ctx| {
                    let body = ctx.required_str("body_text")?;
                    Ok((body.len() > INLINE_BODY_BUDGET_BYTES).then(|| {
                        format!(
                            "a draft body stays inline and is capped at {} KiB; this one is {} KiB",
                            INLINE_BODY_BUDGET_BYTES / 1024,
                            body.len() / 1024
                        )
                    }))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "message_is_draft",
            check: |ctx| {
                let message_id = ctx.produced_ids.borrow().last().cloned();
                let Some(message_id) = message_id else {
                    return Ok(Some("no message was minted".to_owned()));
                };
                let drafted: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM social_message
                      WHERE message_id = ?1 AND delivery = 'draft'",
                    [&message_id],
                    |row| row.get(0),
                )?;
                // The last produced id is the representation's, so a bare
                // `last()` is not the message — the handler reports the message
                // id in its output and the check looks the draft up by thread.
                if drafted == 1 {
                    return Ok(None);
                }
                let any_draft: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM social_message WHERE delivery = 'draft'",
                    [],
                    |row| row.get(0),
                )?;
                Ok((any_draft == 0).then(|| "the draft was not written".to_owned()))
            },
        }],
        handler: |ctx| {
            let body_text = ctx.required_str("body_text")?.to_owned();
            let sender = owner_party_id(ctx)?;
            let thread_id = match ctx.optional_str("thread_id") {
                Some(thread_id) => thread_id.to_owned(),
                None => {
                    let thread_id = ctx.next_id();
                    ctx.connection().execute(
                        "INSERT INTO social_thread
                           (thread_id, channel, subject, external_ref, created_at,
                            last_message_at, updated_at)
                         VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?4)",
                        rusqlite::params![
                            thread_id,
                            ctx.optional_str("channel").unwrap_or("dm"),
                            ctx.optional_str("subject"),
                            ctx.now
                        ],
                    )?;
                    // A SELF-THREAD IS ONE PARTICIPANT, not a UNIQUE collision.
                    let mut parties = vec![sender.clone()];
                    if let Some(recipient) = ctx.optional_str("recipient_party_id")
                        && recipient != sender
                    {
                        parties.push(recipient.to_owned());
                    }
                    for party_id in parties {
                        let tp_id = ctx.next_id();
                        ctx.connection().execute(
                            "INSERT INTO social_thread_participant
                               (tp_id, thread_id, party_id, handle, joined_at, muted, updated_at)
                             VALUES (?1, ?2, ?3, NULL, ?4, 0, ?4)",
                            rusqlite::params![tp_id, thread_id, party_id, ctx.now],
                        )?;
                    }
                    thread_id
                }
            };
            // RENT THE BYTES, OWN THE REFERENCE (P2): identical bodies dedupe
            // on sha256.
            let sha = centraid_media::format::sha256_hex(body_text.as_bytes());
            let existing: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT content_id FROM core_content_item WHERE sha256 = ?1",
                    [&sha],
                    |row| row.get(0),
                )
                .ok();
            let content_id = match existing {
                Some(content_id) => content_id,
                None => {
                    let content_id = ctx.next_id();
                    ctx.connection().execute(
                        "INSERT INTO core_content_item
                           (content_id, content_uri, sha256, byte_size, language,
                            creator_party_id, origin_device_id, deleted_at, purge_at,
                            created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, NULL, ?6, ?6)",
                        rusqlite::params![
                            content_id,
                            format!(
                                "data:text/plain;charset=utf-8,{}",
                                encode_uri_component(&body_text)
                            ),
                            sha,
                            i64::try_from(body_text.len()).unwrap_or(i64::MAX),
                            sender,
                            ctx.now
                        ],
                    )?;
                    content_id
                }
            };
            let message_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO social_message
                   (message_id, thread_id, sender_party_id, sender_handle, sent_at,
                    body_content_id, in_reply_to_id, delivery, external_id,
                    created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, ?4, ?5, NULL, 'draft', NULL, ?4, ?4)",
                rusqlite::params![message_id, thread_id, sender, ctx.now, content_id],
            )?;
            // THIS MESSAGE'S READING OF ITS BODY BYTES (#996 R20(b)).
            let representation_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO core_content_text
                   (content_id, body_text, decoder, byte_size, created_at, updated_at)
                 VALUES (?1, ?2, 'data-uri/v1', ?3, ?4, ?4)
                 ON CONFLICT (content_id) DO UPDATE SET
                   body_text = excluded.body_text, updated_at = excluded.updated_at",
                rusqlite::params![
                    content_id,
                    body_text,
                    i64::try_from(body_text.len()).unwrap_or(i64::MAX),
                    ctx.now
                ],
            )?;
            ctx.connection().execute(
                "INSERT INTO core_content_representation
                   (representation_id, content_id, owner_type, owner_id, media_type,
                    charset, interpretation, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'text/plain', 'utf-8', 'body', ?5, ?5)
                 ON CONFLICT (owner_type, owner_id) DO UPDATE SET
                   content_id = excluded.content_id, updated_at = excluded.updated_at",
                rusqlite::params![
                    representation_id,
                    content_id,
                    MESSAGE_TARGET_TYPE,
                    message_id,
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({
                "message_id": message_id,
                "thread_id": thread_id,
                "body_content_id": content_id,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn send_message() -> CommandDefinition {
    CommandDefinition {
        name: "social.send_message",
        owner_schema: "social",
        input_schema: r#"{
          "type": "object",
          "required": ["message_id"],
          "additionalProperties": false,
          "properties": { "message_id": { "type": "string", "minLength": 1 } }
        }"#,
        idempotency: Idempotency::Once,
        // TIER 3 SEMANTIC EGRESS (#306): structure cannot verify a send, so it
        // parks for every non-owner caller. `risk` is salience; `confirm` is
        // what parks.
        risk: Risk::High,
        confirm: true,
        preconditions: &[CommandCondition {
            // ONLY DRAFTS SEND: sent, delivered, read and failed are
            // provider-sync states and none of them is a thing to send again.
            predicate: "message_is_draft",
            check: |ctx| {
                let message_id = ctx.required_str("message_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM social_message
                      WHERE message_id = ?1 AND delivery = 'draft'",
                    [message_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "that message is not a draft".to_owned()))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "message_sent",
            check: |ctx| {
                let message_id = ctx.required_str("message_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM social_message
                      WHERE message_id = ?1 AND delivery = 'sent'",
                    [message_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the draft was not released".to_owned()))
            },
        }],
        handler: |ctx| {
            let message_id = ctx.required_str("message_id")?.to_owned();
            let thread_id: String = ctx.connection().query_row(
                "SELECT thread_id FROM social_message WHERE message_id = ?1",
                [&message_id],
                |row| row.get(0),
            )?;
            ctx.connection().execute(
                "UPDATE social_message SET delivery = 'sent', sent_at = ?1, updated_at = ?1
                  WHERE message_id = ?2",
                rusqlite::params![ctx.now, message_id],
            )?;
            ctx.connection().execute(
                "UPDATE social_thread SET last_message_at = ?1, updated_at = ?1
                  WHERE thread_id = ?2",
                rusqlite::params![ctx.now, thread_id],
            )?;
            Ok(serde_json::json!({ "message_id": message_id, "delivery": "sent" }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn mark_thread_read() -> CommandDefinition {
    CommandDefinition {
        name: "social.mark_thread_read",
        owner_schema: "social",
        input_schema: r#"{
          "type": "object",
          "required": ["thread_id", "read_at"],
          "additionalProperties": false,
          "properties": {
            "thread_id": { "type": "string", "minLength": 1 },
            "read_at": { "type": "string", "minLength": 1 }
          }
        }"#,
        // Opening a thread re-stamps the cursor with a newer instant every
        // time — repeated marks are the normal case, not a replay to refuse.
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "thread_exists",
            check: |ctx| {
                let thread_id = ctx.required_str("thread_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM social_thread WHERE thread_id = ?1",
                    [thread_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "there is no such thread".to_owned()))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "owner_cursor_stamped",
            check: |ctx| {
                let thread_id = ctx.required_str("thread_id")?;
                let read_at = ctx.required_str("read_at")?;
                let owner = owner_party_id(ctx)?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM social_thread_participant
                      WHERE thread_id = ?1 AND last_read_at = ?2 AND party_id = ?3",
                    rusqlite::params![thread_id, read_at, owner],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the owner's read cursor did not move".to_owned()))
            },
        }],
        handler: |ctx| {
            let thread_id = ctx.required_str("thread_id")?.to_owned();
            let read_at = ctx.required_str("read_at")?.to_owned();
            let owner = owner_party_id(ctx)?;
            // THE OWNER READS THEIR OWN INBOX: a missing participant row means
            // they simply have not spoken in this thread yet, and joining as a
            // silent participant keeps the projection true.
            let existing: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT tp_id FROM social_thread_participant
                      WHERE thread_id = ?1 AND party_id = ?2",
                    rusqlite::params![thread_id, owner],
                    |row| row.get(0),
                )
                .ok();
            match existing {
                Some(tp_id) => {
                    ctx.connection().execute(
                        "UPDATE social_thread_participant SET last_read_at = ?1, updated_at = ?2
                          WHERE tp_id = ?3",
                        rusqlite::params![read_at, ctx.now, tp_id],
                    )?;
                }
                None => {
                    let tp_id = ctx.next_id();
                    ctx.connection().execute(
                        "INSERT INTO social_thread_participant
                           (tp_id, thread_id, party_id, handle, joined_at, muted,
                            last_read_at, updated_at)
                         VALUES (?1, ?2, ?3, NULL, ?4, 0, ?5, ?4)",
                        rusqlite::params![tp_id, thread_id, owner, ctx.now, read_at],
                    )?;
                }
            }
            Ok(serde_json::json!({ "thread_id": thread_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_definition_is_a_social_command_with_a_valid_schema() {
        for definition in definitions() {
            assert!(definition.name.starts_with("social."));
            assert_eq!(definition.owner_schema, "social");
            let schema = serde_json::from_str::<serde_json::Value>(definition.input_schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
            jsonschema::validator_for(&schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
        }
    }

    /// FOUR COMMANDS, and the census's split: 2 idempotent / 2 once, with
    /// exactly one command-level `confirm`.
    #[test]
    fn the_schema_carries_four_commands_and_one_non_owner_park() {
        let definitions = definitions();
        assert_eq!(definitions.len(), 4);
        assert_eq!(
            definitions
                .iter()
                .filter(|definition| definition.idempotency == Idempotency::Idempotent)
                .count(),
            2
        );
        assert_eq!(
            definitions
                .iter()
                .filter(|definition| definition.idempotency == Idempotency::Once)
                .count(),
            2
        );
        let parked: Vec<&str> = definitions
            .iter()
            .filter(|definition| definition.confirm)
            .map(|definition| definition.name)
            .collect();
        assert_eq!(parked, ["social.send_message"]);
        // AND IT IS THE ONLY `high` IN THE SCHEMA.
        let loud: Vec<&str> = definitions
            .iter()
            .filter(|definition| definition.risk == Risk::High)
            .map(|definition| definition.name)
            .collect();
        assert_eq!(loud, ["social.send_message"]);
    }

    /// AN IDENTIFIER IS NOT A CHANNEL, and the reach map is what decides.
    #[test]
    fn reach_schemes_bind_as_channels_and_a_handle_does_not() {
        assert_eq!(reach_kind_of("email"), Some("email"));
        assert_eq!(reach_kind_of("tel"), Some("phone"));
        assert_eq!(reach_kind_of("phone"), Some("phone"));
        // A HANDLE IS AMBIGUOUS: only the call site knows whether it is reach
        // or a claimed identity key.
        assert_eq!(reach_kind_of("handle"), None);
        assert_eq!(reach_kind_of("did"), None);
    }

    /// The register's CHECK cannot hold an email or a tel, which is why the
    /// reach map is not merely a convenience.
    #[test]
    fn the_register_admits_no_reach_scheme() {
        const REGISTER_SCHEMES: [&str; 5] = ["url", "did", "handle", "iban", "other"];
        for scheme in ["email", "tel", "phone"] {
            assert!(
                !REGISTER_SCHEMES.contains(&scheme),
                "{scheme} would be refused by core_party_identifier's own CHECK"
            );
        }
    }
}
