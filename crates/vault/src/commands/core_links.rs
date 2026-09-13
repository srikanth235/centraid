//! THE FIVE `core.*` LINK AND ATTACHMENT COMMANDS — the other half of Notes'
//! write surface (#1020, slot 4c).
//!
//! They are `core.*` and they are here rather than in [`super::core`] because
//! that file already carries the parties, tags, documents and folders half at
//! three thousand lines; splitting on the seam a lane took is the honest place
//! to split. `super::core::definitions` and [`definitions`] are both registered
//! by [`super::Registry::with_system_commands`], so the SCHEMA is still one
//! schema — which is the rule these commands moved under (the common brief's
//! rule 2: a lane takes a whole schema for its slot, and `core` was Docs').
//!
//! ## Links (core §01/§08, #272)
//!
//! **All cross-entity meaning goes through `core.link`** — a SKOS-governed
//! relation concept, `valid_from`/`valid_to`, and who asserted it — never an
//! ad-hoc junction table. These two commands are the whole write surface and
//! backlinks come free as a reverse read.
//!
//! Three rules, each of which is a bug if a port drops it:
//!
//! 1. **An endpoint must resolve, exist LIVE, and be READABLE under the
//!    caller's grant.** Linking to a row the caller cannot see would make the
//!    link itself the disclosure (`links.ts:36`-`:40`).
//! 2. **Links do not link links.** `core.link` and `core.link_anchor` are
//!    refused as endpoints, because a graph of assertions about assertions is a
//!    second model nothing else reads.
//! 3. **UNLINK IS TEMPORAL, NOT DESTRUCTIVE.** The row survives with `valid_to`
//!    set: history is never rewritten (#916 R3). A port that deleted the row
//!    would make "we used to think these were related" unaskable.
//!
//! ## The anchor (#282)
//!
//! A standoff selector is a W3C text-quote selector plus a position hint into
//! the FROM endpoint's decoded body — **a locator, never a second judgment**.
//! Resolution is presentation-side, which is why the selector ships as data and
//! `crates/apps/notes` resolves it. `core.anchor_link` with no selector CLEARS
//! one, and that is a hard delete: a locator is presentation, not history.
//!
//! ## Attachments (core §01)
//!
//! A polymorphic edge (`core_attachment.target_type`/`target_id`) onto a
//! canonical `core.content_item`, with **exactly one source per call**. The edge
//! counts as a GC reference — `core_attachment.content_id` is the first entry of
//! the one content-reference list (#883) — which is why
//! [`detach`](fn@detach_definition) releases bytes nothing else holds: "the
//! content item is canonical and deduped; detach never touches it" was true of
//! the DEDUPE and wrong about the LIFECYCLE (#916, adversarial BUG-6).

use crate::access::{Decision, Verb, evaluate_access};
use crate::commands::core::{
    DEFAULT_MEDIA_TYPE, media_type_for_content, minted_bytes, pre_exactly_one_source,
    pre_inline_bytes_are_storable, pre_is_data_uri, pre_staged_or_owned,
    pre_text_body_within_budget, pre_within_size_cap, set_representation,
};
use crate::commands::media::release_content_if_unreferenced;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};

/// The SKOS scheme link relations come from, seeded at bootstrap
/// (`links.ts:13`).
pub const RELATIONS_SCHEME_URI: &str = "urn:duaility:relations";

/// What a link may point at, and the primary key of each.
///
/// An ALLOW-LIST, not a lookup: an unknown `from_type` is refused rather than
/// turned into SQL. v0 asks the entity registry and then refuses `core.link`
/// and `core.link_anchor` by name; the port carries the same set explicitly,
/// so "links do not link links" is the absence of two rows rather than a check
/// someone can delete.
const LINKABLE: &[(&str, &str, bool)] = &[
    ("core.party", "core_party", true),
    ("core.place", "core_place", false),
    ("core.event", "core_event", true),
    ("core.transaction", "core_transaction", false),
    ("core.content_item", "core_content_item", true),
    ("core.document", "core_document", true),
    ("core.collection", "core_collection", false),
    ("knowledge.note", "knowledge_note", true),
    ("knowledge.annotation", "knowledge_annotation", false),
    ("schedule.task", "schedule_task", true),
    ("schedule.project", "schedule_project", false),
    ("social.thread", "social_thread", false),
    ("social.message", "social_message", false),
    ("media.asset", "media_asset", true),
    ("tally.expense", "tally_expense", true),
];

/// Logical name → PK column for the subjects a file may be pinned to
/// (`attachments.ts:24`-`:36`).
///
/// **Locker is one allow-list entry, not a second attach command** (#872), and
/// the boundary is honest: the bytes ride the content spine and are NOT sealed.
/// Sealing is a COLUMN class, so a locker attachment is protected by the vault
/// file rather than by the reveal gate, and Locker's copy has to say so.
const SUBJECT_PK: &[(&str, &str)] = &[
    ("core.event", "event_id"),
    ("core.party", "party_id"),
    ("core.transaction", "txn_id"),
    ("schedule.task", "task_id"),
    ("knowledge.note", "note_id"),
    ("social.thread", "thread_id"),
    ("social.message", "message_id"),
    ("media.asset", "asset_id"),
    ("locker.item", "item_id"),
];

/// The roles `core_attachment.role`'s CHECK accepts (`attachments.ts:38`-`:46`).
///
/// A TEST ORACLE, not a second source: Rust has no `const` string building, so
/// [`ATTACH_SCHEMA`]'s `enum` is a literal and this list is what
/// `the_attachment_roles_are_the_tables_own` compares it against. A role added
/// to one and not the other fails there.
#[cfg(test)]
const ROLES: &[&str] = &[
    "photo", "manual", "receipt", "warranty", "contract", "embed", "other",
];

/// The five, in v0's own file order: links, then attachments.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        link_entities(),
        unlink_entities(),
        anchor_link(),
        attach(),
        detach(),
    ]
}

fn linkable(entity: &str) -> Option<(&'static str, &'static str, bool)> {
    LINKABLE
        .iter()
        .find(|(logical, _, _)| *logical == entity)
        .copied()
}

fn subject_table(entity: &str) -> Option<(&'static str, String)> {
    SUBJECT_PK
        .iter()
        .find(|(logical, _)| *logical == entity)
        .map(|(logical, pk)| (*pk, logical.replacen('.', "_", 1)))
}

/// An endpoint must resolve, exist live, and be READABLE under the caller's
/// grant (`links.ts:36`-`:70`).
fn endpoint_refusal(
    ctx: &CommandCtx<'_, '_>,
    role: &str,
    entity: &str,
    id: &str,
) -> Result<Option<String>> {
    if entity == "core.link" || entity == "core.link_anchor" {
        return Ok(Some("Links do not link links.".to_owned()));
    }
    let Some((_, physical, tracks_trash)) = linkable(entity) else {
        return Ok(Some(format!(
            "`{entity}` is not something a link can name as its {role} end."
        )));
    };
    let (schema, name) = entity.split_once('.').unwrap_or(("core", entity));
    let live_clause = if tracks_trash {
        " AND deleted_at IS NULL"
    } else {
        ""
    };
    let id_column = pk_of(physical);
    let count: i64 = ctx.connection().query_row(
        &format!(
            "SELECT COUNT(*) FROM {} WHERE {} = ?1{live_clause}",
            crate::log::quoted(physical),
            crate::log::quoted(&id_column)
        ),
        [id],
        |row| row.get(0),
    )?;
    if count != 1 {
        return Ok(Some(format!("There is no live {entity} with id {id}.")));
    }
    let decision = evaluate_access(ctx.connection(), &ctx.principal, schema, name, Verb::Read)?;
    Ok(match decision {
        Decision::Deny { failing, .. } => Some(format!(
            "No standing answer covers reading {entity}: {failing}"
        )),
        Decision::Allow { .. } => None,
    })
}

/// The primary key of a linkable table. Derived from the table name because
/// every one of them is `<last segment>_id`, and asserted by the test below
/// rather than assumed.
fn pk_of(physical: &str) -> String {
    match physical {
        "core_transaction" => "txn_id".to_owned(),
        "core_content_item" => "content_id".to_owned(),
        _ => format!(
            "{}_id",
            physical.split_once('_').map_or(physical, |(_, rest)| rest)
        ),
    }
}

/// The relation concept a notation names, or `None` — relations are VOCABULARY
/// and a caller cannot invent one.
fn relation_concept(ctx: &CommandCtx<'_, '_>, relation: &str) -> Result<Option<String>> {
    Ok(ctx
        .connection()
        .query_row(
            "SELECT c.concept_id FROM core_concept c
               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE s.uri = ?1 AND c.notation = ?2",
            rusqlite::params![RELATIONS_SCHEME_URI, relation],
            |row| row.get::<_, String>(0),
        )
        .ok())
}

/// Upsert the one anchor a link may carry; returns the anchor row id.
fn write_anchor(
    ctx: &CommandCtx<'_, '_>,
    link_id: &str,
    selector: &serde_json::Value,
) -> Result<String> {
    // The stored JSON carries the four selector fields IN ORDER, never the
    // caller's object verbatim: a selector with extra keys is a second shape a
    // reader would have to know about.
    let json = serde_json::json!({
        "exact": selector.get("exact").and_then(serde_json::Value::as_str).unwrap_or_default(),
        "prefix": selector.get("prefix").and_then(serde_json::Value::as_str).unwrap_or_default(),
        "suffix": selector.get("suffix").and_then(serde_json::Value::as_str).unwrap_or_default(),
        "start": selector.get("start").and_then(serde_json::Value::as_i64).unwrap_or_default(),
    })
    .to_string();
    if let Ok(anchor_id) = ctx.connection().query_row(
        "SELECT anchor_id FROM core_link_anchor WHERE link_id = ?1",
        [link_id],
        |row| row.get::<_, String>(0),
    ) {
        ctx.connection().execute(
            "UPDATE core_link_anchor SET selector_json = ?1 WHERE anchor_id = ?2",
            rusqlite::params![json, anchor_id],
        )?;
        return Ok(anchor_id);
    }
    let anchor_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_link_anchor (anchor_id, link_id, selector_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![anchor_id, link_id, json, ctx.now],
    )?;
    Ok(anchor_id)
}

fn pre_link_live(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let link_id = ctx.required_str("link_id")?;
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_link WHERE link_id = ?1 AND valid_to IS NULL",
        [link_id],
        |row| row.get(0),
    )?;
    Ok((count != 1).then(|| "That link is not a live assertion.".to_owned()))
}

// ---------------------------------------------------------------------------
// The five
// ---------------------------------------------------------------------------

fn link_entities() -> CommandDefinition {
    CommandDefinition {
        name: "core.link_entities",
        owner_schema: "core",
        input_schema: LINK_SCHEMA,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: LINK_PRE,
        postconditions: &[CommandCondition {
            predicate: "link_live",
            check: |ctx| {
                let from_id = ctx.required_str("from_id")?.to_owned();
                let to_id = ctx.required_str("to_id")?.to_owned();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_link
                      WHERE from_id = ?1 AND to_id = ?2 AND valid_to IS NULL",
                    rusqlite::params![from_id, to_id],
                    |row| row.get(0),
                )?;
                Ok((count < 1).then(|| "the link was not asserted".to_owned()))
            },
        }],
        handler: |ctx| {
            let from_type = ctx.required_str("from_type")?.to_owned();
            let from_id = ctx.required_str("from_id")?.to_owned();
            let to_type = ctx.required_str("to_type")?.to_owned();
            let to_id = ctx.required_str("to_id")?.to_owned();
            let relation = ctx.required_str("relation")?.to_owned();
            let Some(concept_id) = relation_concept(ctx, &relation)? else {
                return Err(VaultError::InvalidInput {
                    name: "relation".to_owned(),
                    detail: format!("unknown relation \"{relation}\""),
                });
            };
            // WHO ASSERTED IT is part of the link.
            // `asserted_by` is the CHECK's own vocabulary
            // (`owner`/`app`/`agent`/`import`): an agent's assertion is not the
            // owner's, and a surface that cannot tell them apart cannot offer to
            // undo one. An automation runs because the owner scheduled it, so its
            // assertion is the owner's — which is v0's answer too, reached
            // there because a scheduled run carries the owner's credential.
            let asserted_by = match &ctx.principal {
                crate::access::Principal::Agent { .. } => "agent",
                crate::access::Principal::OwnerDevice { .. }
                | crate::access::Principal::Automation { .. } => "owner",
            };
            let link_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO core_link
                   (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                    valid_from, valid_to, asserted_by, provenance_id, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, NULL, ?7)",
                rusqlite::params![
                    link_id,
                    from_type,
                    from_id,
                    to_type,
                    to_id,
                    concept_id,
                    ctx.now,
                    asserted_by
                ],
            )?;
            if let Some(selector) = ctx.input.get("selector").filter(|value| value.is_object()) {
                write_anchor(ctx, &link_id, selector)?;
            }
            Ok(serde_json::json!({
                "link_id": link_id,
                "relation_concept_id": concept_id,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

const LINK_PRE: &[CommandCondition] = &[
    CommandCondition {
        // Relations are VOCABULARY: the notation must already be a concept in
        // the relations scheme, never caller-invented.
        predicate: "relation_in_scheme",
        check: |ctx| {
            let relation = ctx.required_str("relation")?;
            Ok(relation_concept(ctx, relation)?
                .is_none()
                .then(|| format!("`{relation}` is not a relation this vault knows.")))
        },
    },
    CommandCondition {
        predicate: "not_a_self_link",
        check: |ctx| {
            let same = ctx.required_str("from_type")? == ctx.required_str("to_type")?
                && ctx.required_str("from_id")? == ctx.required_str("to_id")?;
            Ok(same.then(|| "An entity cannot link to itself.".to_owned()))
        },
    },
    CommandCondition {
        predicate: "endpoints_are_live_and_readable",
        check: |ctx| {
            if let Some(refusal) = endpoint_refusal(
                ctx,
                "from",
                ctx.required_str("from_type")?,
                ctx.required_str("from_id")?,
            )? {
                return Ok(Some(refusal));
            }
            endpoint_refusal(
                ctx,
                "to",
                ctx.required_str("to_type")?,
                ctx.required_str("to_id")?,
            )
        },
    },
    CommandCondition {
        // Refuse an exact duplicate WHILE THE FIRST ASSERTION IS LIVE; after an
        // unlink the same relationship may be reasserted, which is the whole
        // point of `valid_to` being a date rather than a delete.
        predicate: "no_identical_live_link",
        check: |ctx| {
            let relation = ctx.required_str("relation")?.to_owned();
            let Some(concept_id) = relation_concept(ctx, &relation)? else {
                return Ok(None);
            };
            let count: i64 = ctx.connection().query_row(
                "SELECT COUNT(*) FROM core_link
                  WHERE from_type = ?1 AND from_id = ?2 AND to_type = ?3 AND to_id = ?4
                    AND relation_concept_id = ?5 AND valid_to IS NULL",
                rusqlite::params![
                    ctx.required_str("from_type")?,
                    ctx.required_str("from_id")?,
                    ctx.required_str("to_type")?,
                    ctx.required_str("to_id")?,
                    concept_id
                ],
                |row| row.get(0),
            )?;
            Ok((count != 0).then(|| "That relationship is already asserted.".to_owned()))
        },
    },
];

fn unlink_entities() -> CommandDefinition {
    CommandDefinition {
        name: "core.unlink_entities",
        owner_schema: "core",
        input_schema: LINK_ID_SCHEMA,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "link_live",
            check: pre_link_live,
        }],
        postconditions: &[CommandCondition {
            // ENDED, NOT ERASED: the row survives with `valid_to` set (#916 R3).
            predicate: "link_ended",
            check: |ctx| {
                let link_id = ctx.required_str("link_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_link
                      WHERE link_id = ?1 AND valid_to IS NOT NULL",
                    [link_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the link was not ended".to_owned()))
            },
        }],
        handler: |ctx| {
            let link_id = ctx.required_str("link_id")?.to_owned();
            ctx.connection().execute(
                "UPDATE core_link SET valid_to = ?1 WHERE link_id = ?2",
                rusqlite::params![ctx.now, link_id],
            )?;
            Ok(serde_json::json!({ "link_id": link_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn anchor_link() -> CommandDefinition {
    CommandDefinition {
        name: "core.anchor_link",
        owner_schema: "core",
        input_schema: ANCHOR_SCHEMA,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            // ANCHORS RIDE LIVE JUDGMENTS ONLY — an ended link keeps its history
            // and takes no new locator.
            predicate: "link_live",
            check: pre_link_live,
        }],
        postconditions: &[CommandCondition {
            predicate: "link_still_live",
            check: pre_link_live_postcondition,
        }],
        handler: |ctx| {
            let link_id = ctx.required_str("link_id")?.to_owned();
            if let Some(selector) = ctx.input.get("selector").filter(|value| value.is_object()) {
                let anchor_id = write_anchor(ctx, &link_id, selector)?;
                return Ok(serde_json::json!({
                    "link_id": link_id, "anchor_id": anchor_id
                }));
            }
            // A LOCATOR IS PRESENTATION, NOT HISTORY — clearing it is a hard
            // delete, unlike the link itself.
            ctx.connection().execute(
                "DELETE FROM core_link_anchor WHERE link_id = ?1",
                [&link_id],
            )?;
            Ok(serde_json::json!({ "link_id": link_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn pre_link_live_postcondition(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(pre_link_live(ctx)?.map(|_| "the link stopped being live".to_owned()))
}

fn attach() -> CommandDefinition {
    CommandDefinition {
        name: "core.attach",
        owner_schema: "core",
        input_schema: ATTACH_SCHEMA,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: ATTACH_PRE,
        postconditions: &[CommandCondition {
            predicate: "attachment_links_subject_to_content",
            check: |ctx| {
                let subject_type = ctx.required_str("subject_type")?.to_owned();
                let subject_id = ctx.required_str("subject_id")?.to_owned();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_attachment
                      WHERE target_type = ?1 AND target_id = ?2",
                    rusqlite::params![subject_type, subject_id],
                    |row| row.get(0),
                )?;
                Ok((count < 1).then(|| "the file was not attached".to_owned()))
            },
        }],
        handler: |ctx| {
            let subject_type = ctx.required_str("subject_type")?.to_owned();
            let subject_id = ctx.required_str("subject_id")?.to_owned();
            let minted = minted_bytes(ctx)?;
            let media_type = if ctx.optional_str("content_id").is_some() {
                // ATTACHING BYTES ALREADY IN THE VAULT: this attachment inherits
                // whatever reading the vault already has of them (#996 R20(b))
                // rather than being told by a column on the byte row.
                media_type_for_content(ctx, &minted.content_id)?
                    .unwrap_or_else(|| DEFAULT_MEDIA_TYPE.to_owned())
            } else {
                minted.media_type.clone()
            };
            let role = ctx.optional_str("role").map_or_else(
                || {
                    if media_type.starts_with("image/") {
                        "photo".to_owned()
                    } else {
                        "other".to_owned()
                    }
                },
                str::to_owned,
            );
            let existing: i64 = ctx.connection().query_row(
                "SELECT COUNT(*) FROM core_attachment WHERE target_type = ?1 AND target_id = ?2",
                rusqlite::params![subject_type, subject_id],
                |row| row.get(0),
            )?;
            let is_primary = i64::from(existing == 0);
            let attachment_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO core_attachment
                   (attachment_id, target_type, target_id, content_id, role, is_primary, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    attachment_id,
                    subject_type,
                    subject_id,
                    minted.content_id,
                    role,
                    is_primary,
                    ctx.now
                ],
            )?;
            // THE ATTACHMENT'S OWN READING OF THE BYTES (#996 R20(b)): the same
            // sha pinned to two rows carries two readings.
            set_representation(
                ctx,
                &minted.content_id,
                "core.attachment",
                &attachment_id,
                &media_type,
                Some(&role),
            )?;
            Ok(serde_json::json!({
                "attachment_id": attachment_id,
                "content_id": minted.content_id,
                "is_primary": is_primary,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

const ATTACH_PRE: &[CommandCondition] = &[
    CommandCondition {
        predicate: "subject_is_live",
        check: |ctx| {
            let subject_type = ctx.required_str("subject_type")?;
            let subject_id = ctx.required_str("subject_id")?;
            let Some((pk, table)) = subject_table(subject_type) else {
                return Ok(Some(format!("A file cannot be pinned to {subject_type}.")));
            };
            let count: i64 = ctx.connection().query_row(
                &format!(
                    "SELECT COUNT(*) FROM {} WHERE {} = ?1",
                    crate::log::quoted(&table),
                    crate::log::quoted(pk)
                ),
                [subject_id],
                |row| row.get(0),
            )?;
            Ok((count != 1).then(|| format!("There is no {subject_type} with id {subject_id}.")))
        },
    },
    CommandCondition {
        predicate: "exactly_one_source",
        check: pre_exactly_one_source,
    },
    CommandCondition {
        predicate: "is_data_uri",
        check: pre_is_data_uri,
    },
    CommandCondition {
        predicate: "within_size_cap",
        check: pre_within_size_cap,
    },
    CommandCondition {
        predicate: "text_body_within_budget",
        check: pre_text_body_within_budget,
    },
    CommandCondition {
        predicate: "inline_bytes_are_storable",
        check: pre_inline_bytes_are_storable,
    },
    CommandCondition {
        predicate: "staged_or_owned",
        check: pre_staged_or_owned,
    },
    CommandCondition {
        predicate: "content_exists",
        check: |ctx| {
            let Some(content_id) = ctx.optional_str("content_id") else {
                return Ok(None);
            };
            let count: i64 = ctx.connection().query_row(
                "SELECT COUNT(*) FROM core_content_item
                  WHERE content_id = ?1 AND deleted_at IS NULL",
                [content_id],
                |row| row.get(0),
            )?;
            Ok((count != 1).then(|| "This vault holds no live bytes with that id.".to_owned()))
        },
    },
];

fn detach() -> CommandDefinition {
    CommandDefinition {
        name: "core.detach",
        owner_schema: "core",
        input_schema: DETACH_SCHEMA,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "attachment_exists",
            check: |ctx| {
                let attachment_id = ctx.required_str("attachment_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_attachment WHERE attachment_id = ?1",
                    [attachment_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "There is no attachment with that id.".to_owned()))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "attachment_removed",
            check: |ctx| {
                let attachment_id = ctx.required_str("attachment_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_attachment WHERE attachment_id = ?1",
                    [attachment_id],
                    |row| row.get(0),
                )?;
                Ok((count != 0).then(|| "the attachment survived".to_owned()))
            },
        }],
        handler: |ctx| {
            let attachment_id = ctx.required_str("attachment_id")?.to_owned();
            let content_id: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT content_id FROM core_attachment WHERE attachment_id = ?1",
                    [&attachment_id],
                    |row| row.get(0),
                )
                .ok();
            ctx.connection().execute(
                "DELETE FROM core_attachment WHERE attachment_id = ?1",
                [&attachment_id],
            )?;
            // THE LAST REFERENCE RELEASES THE BYTES (#916, adversarial BUG-6).
            // An attachment that minted its own content item — a receipt
            // photographed into Tally, a file dropped on a note — was the only
            // thing referencing it, so detaching left a content row with no
            // referrer, no trash pair, and bytes no sweep would reclaim.
            let released = match content_id.as_deref() {
                Some(content_id) => release_content_if_unreferenced(ctx, content_id)?,
                None => false,
            };
            Ok(serde_json::json!({
                "attachment_id": attachment_id,
                "content_released": i64::from(released),
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

// ---------------------------------------------------------------------------
// The schemas, verbatim from v0's `inputSchema` blocks.
// ---------------------------------------------------------------------------

/// The W3C text-quote selector plus a position hint. `start` is UTF-16 code
/// units, because that is what a browser's selection API reports and the anchor
/// has to survive the round trip through one.
///
/// A TEST ORACLE for the same reason [`ROLES`] is one: the two commands that
/// take a selector each carry the literal, and
/// `the_selector_shape_is_one_literal_in_both_commands` is what keeps them one
/// shape.
#[cfg(test)]
const SELECTOR_SCHEMA: &str = r#"{
              "type": "object",
              "required": ["exact", "prefix", "suffix", "start"],
              "additionalProperties": false,
              "properties": {
                "exact": { "type": "string", "minLength": 1 },
                "prefix": { "type": "string" },
                "suffix": { "type": "string" },
                "start": { "type": "integer", "minimum": 0 }
              }
            }"#;

const LINK_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["from_type", "from_id", "to_type", "to_id", "relation"],
          "additionalProperties": false,
          "properties": {
            "from_type": { "type": "string", "minLength": 1 },
            "from_id": { "type": "string", "minLength": 1 },
            "to_type": { "type": "string", "minLength": 1 },
            "to_id": { "type": "string", "minLength": 1 },
            "relation": { "type": "string", "minLength": 1 },
            "selector": {
              "type": "object",
              "required": ["exact", "prefix", "suffix", "start"],
              "additionalProperties": false,
              "properties": {
                "exact": { "type": "string", "minLength": 1 },
                "prefix": { "type": "string" },
                "suffix": { "type": "string" },
                "start": { "type": "integer", "minimum": 0 }
              }
            }
          }
        }"#;

const LINK_ID_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["link_id"],
          "additionalProperties": false,
          "properties": { "link_id": { "type": "string", "minLength": 1 } }
        }"#;

const ANCHOR_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["link_id"],
          "additionalProperties": false,
          "properties": {
            "link_id": { "type": "string", "minLength": 1 },
            "selector": {
              "type": "object",
              "required": ["exact", "prefix", "suffix", "start"],
              "additionalProperties": false,
              "properties": {
                "exact": { "type": "string", "minLength": 1 },
                "prefix": { "type": "string" },
                "suffix": { "type": "string" },
                "start": { "type": "integer", "minimum": 0 }
              }
            }
          }
        }"#;

const ATTACH_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["subject_type", "subject_id"],
          "additionalProperties": false,
          "properties": {
            "subject_type": { "type": "string", "enum": [
              "core.event", "core.party", "core.transaction", "schedule.task",
              "knowledge.note", "social.thread", "social.message", "media.asset",
              "locker.item"
            ] },
            "subject_id": { "type": "string", "minLength": 1 },
            "data_uri": { "type": "string", "minLength": 6 },
            "content_id": { "type": "string", "minLength": 1 },
            "staged_sha": { "type": "string", "minLength": 64, "maxLength": 64 },
            "role": { "type": "string", "enum": [
              "photo", "manual", "receipt", "warranty", "contract", "embed", "other"
            ] }
          }
        }"#;

const DETACH_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["attachment_id"],
          "additionalProperties": false,
          "properties": { "attachment_id": { "type": "string", "minLength": 1 } }
        }"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_five_are_core_commands_with_valid_schemas() {
        let names: Vec<&str> = definitions()
            .iter()
            .map(|definition| definition.name)
            .collect();
        assert_eq!(
            names,
            [
                "core.link_entities",
                "core.unlink_entities",
                "core.anchor_link",
                "core.attach",
                "core.detach",
            ]
        );
        for definition in definitions() {
            assert_eq!(definition.owner_schema, "core");
            let schema = serde_json::from_str::<serde_json::Value>(definition.input_schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
            jsonschema::validator_for(&schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
            assert!(!definition.confirm, "{}", definition.name);
            assert!(!definition.online_only, "{}", definition.name);
            assert!(definition.sealed_input.is_empty(), "{}", definition.name);
        }
    }

    /// v0's split for these five: `link_entities` and `attach` are **once**, the
    /// other three idempotent (`links.ts:245`, `:275`, `:337`;
    /// `attachments.ts:131`, `:262`). The two `once` commands are the two that
    /// MINT a row, which is the only classification a duplicate delivery can get
    /// wrong.
    #[test]
    fn the_idempotency_split_matches_v0() {
        let once: Vec<&str> = definitions()
            .iter()
            .filter(|definition| definition.idempotency == Idempotency::Once)
            .map(|definition| definition.name)
            .collect();
        assert_eq!(once, ["core.link_entities", "core.attach"]);
    }

    /// LINKS DO NOT LINK LINKS, and the absence is the shape of the table.
    #[test]
    fn the_two_link_tables_are_not_linkable() {
        assert!(linkable("core.link").is_none());
        assert!(linkable("core.link_anchor").is_none());
        assert!(linkable("knowledge.note").is_some());
        // And a secret is not linkable either — Locker is ATTACHABLE (bytes on
        // an item, #872) and never a link endpoint.
        assert!(linkable("locker.item").is_none());
        assert!(subject_table("locker.item").is_some());
    }

    /// The primary key of every linkable table, derived rather than listed —
    /// and asserted, because `core_transaction` and `core_content_item` are the
    /// two that do not follow the rule.
    #[test]
    fn every_linkable_tables_primary_key_is_derivable() {
        for (entity, physical, _) in LINKABLE {
            let expected = match *entity {
                "core.transaction" => "txn_id".to_owned(),
                "core.content_item" => "content_id".to_owned(),
                other => format!(
                    "{}_id",
                    other.split_once('.').map_or(other, |(_, name)| name)
                ),
            };
            assert_eq!(pk_of(physical), expected, "{entity}");
        }
    }

    #[test]
    fn the_selector_shape_is_one_literal_in_both_commands() {
        let selector: serde_json::Value =
            serde_json::from_str(SELECTOR_SCHEMA).expect("the selector schema is JSON");
        for (name, schema) in [
            ("core.link_entities", LINK_SCHEMA),
            ("core.anchor_link", ANCHOR_SCHEMA),
        ] {
            let parsed: serde_json::Value =
                serde_json::from_str(schema).expect("the schema is JSON");
            assert_eq!(
                parsed["properties"]["selector"], selector,
                "{name} declares a different selector shape"
            );
        }
    }

    /// Every `role` the schema names is a role the table's CHECK accepts.
    #[test]
    fn the_attachment_roles_are_the_tables_own() {
        let parsed: serde_json::Value =
            serde_json::from_str(ATTACH_SCHEMA).expect("the schema is JSON");
        let declared: Vec<&str> = parsed["properties"]["role"]["enum"]
            .as_array()
            .expect("the roles are a list")
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect();
        assert_eq!(declared, ROLES);
    }
}
