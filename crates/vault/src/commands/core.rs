//! THE `core` SCHEMA: the parties, the tags, and Docs' whole command surface.
//!
//! v0's `core` schema carries **27 typed commands** across seven files. Lane D1
//! landed three of them — `core.add_party`, `core.update_party`,
//! `core.tag_item` — to prove the gate order, the capture and the receipt
//! chain end to end. Wave 4 slot 4b adds **sixteen**: the document, folder, tag
//! and content commands, which are Docs' entire write surface
//! (census-wave4 §A3: "a lane that ports Docs' commands is editing
//! `crates/vault`, not an app crate").
//!
//! ### The eight `core.*` commands deliberately NOT here (D-1020-DC3)
//!
//! `core.link_entities`, `core.unlink_entities`, `core.anchor_link`,
//! `core.attach`, `core.detach` (Notes' link and attachment plane),
//! `core.merge_party`, `core.merge_entity` and `core.find_duplicate_parties`
//! (People's merge plane). No Docs action invokes any of them, and the two
//! confirm-gated ones in the whole schema are the two merges — a park in front
//! of a **non-owner** merge, which is a People-lane behaviour to prove with
//! People's fixtures rather than an eight-command stub written blind here.
//! The rule "a lane takes a whole SCHEMA for its slot" is about not having two
//! writers of one file at once; it is not an instruction to write commands no
//! consumer of this slot exercises.
//!
//! The counts, off v0's own definitions: **17 idempotent / 8 once / 2
//! retry-safe**, and **2 command-level `confirm`** — both on the merges.
//! The census reads the `once` arm as six (`census-wave4.md:47`); the eight are
//! `add_party`, `add_document`, `trash_document`, `create_folder`,
//! `link_entities`, `attach`, `merge_party`, `merge_entity`, and 17 + 8 + 2 is
//! the 27 the same line states. `the_idempotency_split_matches_v0` below is the
//! count for the nineteen this build carries.
//!
//! ### Two gates, never one (census §A0)
//!
//! Docs declares `confirmation: "required"` on exactly one action,
//! `empty-trash`, and that is the DISPATCHING SURFACE's gate. No `core.*`
//! command this build carries sets `confirm: true` —
//! `core.empty_document_trash` deliberately does not
//! (`packages/vault/src/commands/documents.ts:538`: "owner confirmation is in
//! front of the command"), and its `risk` is `high`, which is salience and
//! never an approval trigger. Collapsing the two would put a dialog in front
//! of the owner's own empty-trash and drop nothing in exchange.
//!
//! ### Identity is the wrapper, never the bytes (D-1020-DC1)
//!
//! `core_document` wraps a sha256-deduped `core_content_item`. **Two documents
//! may legitimately share identical bytes** — dedup is on the bytes and never
//! on document identity (#352) — so `add_document` always mints a fresh
//! wrapper and reports `deduped: 1` when the bytes were already known. Version
//! history is a chain of `core_entity_revision` OCCURRENCES (#996 R20(a)), not
//! a content-keyed `revises` link: a document that returns to bytes it already
//! held is two versions, and a revision belongs to ONE object.
//!
//! ### What is narrowed, and why
//!
//! - **D-1020-D1-14** (lane D1's, unchanged): `core.add_party` refuses an
//!   `email`/`tel` identifier with a sentence naming
//!   `social.save_contact_channel`, rather than dropping it.
//! - **D-1020-DC8**: an inline `data_uri` whose media type is **not** `text/*`
//!   is refused with a sentence naming the missing seam. v0 spills those bytes
//!   into the local CAS (`ctx.blobs.spill`,
//!   `packages/vault/src/blob/mint.ts:90`-`:99`) and `CommandCtx` carries no
//!   blob door — the same gap lane Photos named for `media.add_asset`. The
//!   refusal is per INPUT SHAPE rather than per command, which is the whole
//!   difference: the entire `text/*` path and the entire `staged_sha` path are
//!   real, because `promoteStagedBlob` is pure row work and says so
//!   (`packages/vault/src/blob/promote.ts:1`-`:5`: "no I/O — the bytes are
//!   already in the local CAS"). So a scanned PDF staged through the blob door
//!   files, versions and restores here for real; only a PDF pasted inline as
//!   base64 refuses.
//! - **D-1020-DC9**: `queueMissingDeviceEnrichmentRequests` — the
//!   `enrich_request` rows v0's claim writes for a device that has not
//!   contributed a derivative — is NOT written here. `enrich.*` is the
//!   automations lane's schema this slot, and writing another lane's table from
//!   this one is how two writers of one plane happen. Named as an owner
//!   hand-off in the receipt.
//!
//! ### Conditions read `:ctx_now`, never SQLite's clock
//!
//! `core.restore_document` refuses a LAPSED grace window, and the window is
//! compared against the invocation's own instant (lane V made v0's conditions
//! do the same). A condition that read `strftime('now')` could not be fixtured
//! at any instant but the host's.

use std::collections::BTreeMap;

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};

/// Identity-register schemes `core_party_identifier` accepts.
const REGISTER_SCHEMES: &[&str] = &["url", "did", "handle", "iban", "other"];
/// Schemes that are a CHANNEL, not an identifier.
const REACH_SCHEMES: &[&str] = &["email", "tel"];

const TAGS_SCHEME_URI: &str = "centraid:tags:v1";

/// Taggable entities: logical name to primary key, plus whether the table has
/// a `deleted_at` lifecycle. Doubles as an allow-list guard on the raw SQL.
const TAGGABLE: &[(&str, &str, bool)] = &[
    ("knowledge.note", "note_id", true),
    ("schedule.task", "task_id", false),
    ("core.document", "document_id", true),
    ("media.asset", "asset_id", true),
];

/// Every `core.*` command this build carries: the nineteen of v0's twenty-seven
/// that the parties plane and Docs' whole write surface need.
///
/// The order is v0's own file order — parties, tags, then documents and folders
/// — so the registry's `agent_command` record reads like the source it was
/// ported from.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        add_party(),
        update_party(),
        tag_item(),
        untag_item(),
        add_document(),
        rename_document(),
        move_document(),
        trash_document(),
        restore_document(),
        empty_document_trash(),
        star_document(),
        unstar_document(),
        edit_document(),
        replace_document_content(),
        restore_document_version(),
        create_folder(),
        rename_folder(),
        delete_folder(),
        set_extracted_text(),
        // PEOPLE'S SLOT (wave 4 slot 4c): the ontology primitive behind
        // `merge-people`, and the second of the schema's two confirm-gated
        // commands.
        merge_party(),
    ]
}

fn add_party() -> CommandDefinition {
    CommandDefinition {
        name: "core.add_party",
        owner_schema: "core",
        input_schema: r#"{
          "type": "object",
          "required": ["display_name"],
          "additionalProperties": false,
          "properties": {
            "display_name": { "type": "string", "minLength": 1 },
            "kind": { "type": "string", "enum": ["person", "org", "group"] },
            "sort_name": { "type": "string" },
            "birth_date": { "type": "string" },
            "identifiers": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["scheme", "value"],
                "additionalProperties": false,
                "properties": {
                  "scheme": { "type": "string",
                              "enum": ["email", "tel", "url", "did", "handle", "iban", "other"] },
                  "value": { "type": "string", "minLength": 1 },
                  "label": { "type": "string" }
                }
              }
            }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        // An array input cannot ride a templated precondition; the handler's
        // own refusals land as receipted denies, which is v0's answer too.
        preconditions: &[],
        postconditions: &[CommandCondition {
            predicate: "party_created",
            check: |ctx| {
                let party_id = ctx
                    .produced_ids
                    .borrow()
                    .first()
                    .cloned()
                    .unwrap_or_default();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_party WHERE party_id = ?1",
                    [&party_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the party was not created".to_owned()))
            },
        }],
        handler: |ctx| {
            let display_name = ctx.required_str("display_name")?.to_owned();
            let kind = ctx.optional_str("kind").unwrap_or("person").to_owned();
            let sort_name = ctx.optional_str("sort_name").map(str::to_owned);
            let birth_date = ctx.optional_str("birth_date").map(str::to_owned);
            let identifiers = ctx
                .input
                .get("identifiers")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();

            // A reach scheme is refused BEFORE the party is minted, so a
            // refused call leaves nothing behind.
            for identifier in &identifiers {
                let scheme = identifier
                    .get("scheme")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                if REACH_SCHEMES.contains(&scheme) {
                    return Err(VaultError::InvalidInput {
                        name: "identifiers".to_owned(),
                        detail: format!(
                            "`{scheme}` is a way to reach someone, not an identity-register entry; use `social.save_contact_channel`"
                        ),
                    });
                }
                if !REGISTER_SCHEMES.contains(&scheme) {
                    return Err(VaultError::InvalidInput {
                        name: "identifiers".to_owned(),
                        detail: format!("`{scheme}` is not an identity-register scheme"),
                    });
                }
                // AN IDENTIFIER ALREADY BOUND IS A FORK, NOT A NEW CONTACT.
                // Refused, never merged silently, and the answer names who
                // holds it so the app can offer that party instead.
                let value = identifier
                    .get("value")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let claimed: Option<String> = ctx
                    .connection()
                    .query_row(
                        "SELECT party_id FROM core_party_identifier
                          WHERE scheme = ?1 AND value = ?2 AND valid_to IS NULL LIMIT 1",
                        rusqlite::params![scheme, value],
                        |row| row.get(0),
                    )
                    .ok();
                if let Some(claimed) = claimed {
                    let name: String = ctx
                        .connection()
                        .query_row(
                            "SELECT display_name FROM core_party WHERE party_id = ?1",
                            [&claimed],
                            |row| row.get(0),
                        )
                        .unwrap_or_else(|_| claimed.clone());
                    return Err(VaultError::InvalidInput {
                        name: "identifiers".to_owned(),
                        detail: format!(
                            "{scheme}:{value} already identifies \"{name}\" ({claimed})"
                        ),
                    });
                }
            }

            let party_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO core_party
                   (party_id, kind, display_name, sort_name, birth_date, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                rusqlite::params![party_id, kind, display_name, sort_name, birth_date, ctx.now],
            )?;
            let mut bound = 0;
            for identifier in &identifiers {
                let identifier_id = ctx.next_id();
                ctx.connection().execute(
                    "INSERT INTO core_party_identifier
                       (identifier_id, party_id, scheme, value, issuer, label,
                        is_primary, valid_from, updated_at)
                     VALUES (?1, ?2, ?3, ?4, NULL, ?5, 0, ?6, ?6)",
                    rusqlite::params![
                        identifier_id,
                        party_id,
                        identifier.get("scheme").and_then(serde_json::Value::as_str),
                        identifier.get("value").and_then(serde_json::Value::as_str),
                        identifier.get("label").and_then(serde_json::Value::as_str),
                        ctx.now,
                    ],
                )?;
                bound += 1;
            }
            Ok(serde_json::json!({ "party_id": party_id, "identifiers_bound": bound }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn update_party() -> CommandDefinition {
    CommandDefinition {
        name: "core.update_party",
        owner_schema: "core",
        input_schema: r#"{
          "type": "object",
          "required": ["party_id"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "display_name": { "type": "string", "minLength": 1 },
            "sort_name": { "type": "string" },
            "birth_date": { "type": "string" }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            // An agent's identity row is managed by enrollment, not by a
            // contact app; `kind != 'agent'` is that rule, not a filter.
            predicate: "party_exists_and_editable",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_party WHERE party_id = ?1 AND kind <> 'agent'",
                    [party_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1)
                    .then(|| "there is no editable person or organisation with that id".to_owned()))
            },
        }],
        postconditions: &[CommandCondition {
            // Each field either was not asked for, or reads back exactly as
            // sent. Not "the row changed": a command's own statement about
            // what it did has to be checkable against the file.
            predicate: "edits_applied",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                for column in ["display_name", "sort_name", "birth_date"] {
                    let Some(wanted) = ctx.optional_str(column) else {
                        continue;
                    };
                    let found: Option<String> = ctx.connection().query_row(
                        &format!(
                            "SELECT {} FROM core_party WHERE party_id = ?1",
                            crate::log::quoted(column)
                        ),
                        [party_id],
                        |row| row.get(0),
                    )?;
                    if found.as_deref() != Some(wanted) {
                        return Ok(Some(format!(
                            "`{column}` did not take the value it was sent"
                        )));
                    }
                }
                Ok(None)
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let mut sets: Vec<String> = Vec::new();
            let mut values: Vec<String> = Vec::new();
            for column in ["display_name", "sort_name", "birth_date"] {
                if let Some(value) = ctx.optional_str(column) {
                    sets.push(format!("{} = ?", crate::log::quoted(column)));
                    values.push(value.to_owned());
                }
            }
            if sets.is_empty() {
                // Nothing asked for is not an error, and it is also not a
                // write: an UPDATE with no SET would still bump `row_version`
                // through the touch trigger, which is a change a seat has to
                // apply for no reason.
                return Ok(serde_json::json!({ "party_id": party_id }));
            }
            sets.push("updated_at = ?".to_owned());
            values.push(ctx.now.clone());
            values.push(party_id.clone());
            let sql = format!(
                "UPDATE core_party SET {} WHERE party_id = ?",
                sets.join(", ")
            );
            let binds: Vec<&dyn rusqlite::ToSql> = values
                .iter()
                .map(|value| value as &dyn rusqlite::ToSql)
                .collect();
            ctx.connection().prepare(&sql)?.execute(binds.as_slice())?;
            Ok(serde_json::json!({ "party_id": party_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn tag_item() -> CommandDefinition {
    CommandDefinition {
        name: "core.tag_item",
        owner_schema: "core",
        input_schema: r#"{
          "type": "object",
          "required": ["subject_type", "subject_id", "label"],
          "additionalProperties": false,
          "properties": {
            "subject_type": { "type": "string",
                              "enum": ["knowledge.note", "schedule.task",
                                       "core.document", "media.asset"] },
            "subject_id": { "type": "string", "minLength": 1 },
            "label": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "subject_is_live",
            check: |ctx| {
                let subject_type = ctx.required_str("subject_type")?;
                let subject_id = ctx.required_str("subject_id")?;
                let Some((_, pk, live)) = TAGGABLE
                    .iter()
                    .find(|(logical, _, _)| *logical == subject_type)
                else {
                    return Ok(Some(format!("`{subject_type}` cannot be tagged")));
                };
                let table = subject_type.replacen('.', "_", 1);
                let live_clause = if *live { " AND deleted_at IS NULL" } else { "" };
                let count: i64 = ctx.connection().query_row(
                    &format!(
                        "SELECT COUNT(*) FROM {} WHERE {} = ?1{live_clause}",
                        crate::log::quoted(&table),
                        crate::log::quoted(pk)
                    ),
                    [subject_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| format!("there is no live {subject_type} with that id")))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "tag_recorded",
            check: |ctx| {
                let subject_type = ctx.required_str("subject_type")?;
                let subject_id = ctx.required_str("subject_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_tag WHERE target_type = ?1 AND target_id = ?2",
                    rusqlite::params![subject_type, subject_id],
                    |row| row.get(0),
                )?;
                Ok((count < 1).then(|| "the tag was not recorded".to_owned()))
            },
        }],
        handler: |ctx| {
            let subject_type = ctx.required_str("subject_type")?.to_owned();
            let subject_id = ctx.required_str("subject_id")?.to_owned();
            let label = ctx.required_str("label")?.to_owned();
            let notation = notation_of(&label);
            if notation.is_empty() {
                return Err(VaultError::InvalidInput {
                    name: "label".to_owned(),
                    detail: "a tag label cannot be only whitespace".to_owned(),
                });
            }
            let actor = actor_party_id(ctx)?;
            let scheme_id = find_or_create_tags_scheme(ctx)?;
            let concept_id = find_or_create_concept(ctx, &scheme_id, &label, &notation)?;

            // IDEMPOTENT: the same label returns the existing edge, which is
            // what `core_tag_owner_assertion_idx` makes a fact rather than a
            // convention.
            let existing: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT tag_id FROM core_tag
                      WHERE target_type = ?1 AND target_id = ?2 AND concept_id = ?3
                        AND tagged_by_party_id IS NOT NULL",
                    rusqlite::params![subject_type, subject_id, concept_id],
                    |row| row.get(0),
                )
                .ok();
            if let Some(tag_id) = existing {
                return Ok(serde_json::json!({
                    "tag_id": tag_id, "concept_id": concept_id, "notation": notation
                }));
            }
            // Owner-asserted: a party, NO confidence — the exact inverse of an
            // enrichment-derived tag, and the CHECK on the table is what makes
            // the two shapes mutually exclusive.
            let tag_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO core_tag
                   (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                    confidence, tagged_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
                rusqlite::params![tag_id, subject_type, subject_id, concept_id, actor, ctx.now],
            )?;
            Ok(serde_json::json!({
                "tag_id": tag_id, "concept_id": concept_id, "notation": notation
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

// ===========================================================================
// THE DOCUMENT / FOLDER / TAG / CONTENT HALF OF THE SCHEMA (#1020 slot 4b).
//
// Shared helpers first. Each one is a fact about the model, not a convenience:
// where a helper exists, it is because two commands would otherwise spell the
// same rule twice and the second spelling is the one that drifts.
// ===========================================================================

/// The folders scheme. **An `https` URI, not a `urn:`, and that is not drift**:
/// this literal is interpolated into condition SQL, where `:folders` reads as a
/// NAMED PARAMETER (#258, the colon-literal trap) and no parameter name can
/// start with a slash (`packages/vault/src/commands/documents.ts:47`).
pub const FOLDER_SCHEME_URI: &str = "https://centraid.dev/schemes/folders";

/// The flags scheme and the star's notation, for the same reason.
const FLAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/flags";
const STARRED_NOTATION: &str = "starred";

/// The drive's top level: the folders scheme's own `root` concept.
const ROOT_FOLDER_NOTATION: &str = "root";

/// Document identity marks the WRAPPER row, never the raw content item.
pub const DOCUMENT_TARGET_TYPE: &str = "core.document";

/// The trash grace window (#352). Thirty days, in v0's arithmetic.
const PURGE_AFTER_DAYS: i64 = 30;

/// Decoded-size cap for the inline `data:` door: ~256 KB of content, ~350 KB of
/// base64 (`packages/vault/src/blob/mint.ts:19`). Anything larger takes the
/// staging route, because the journal records every input.
pub(crate) const MAX_INLINE_DATA_URI_CHARS: usize = 360_000;

/// The inline-body budget for `text/*`: ~64 KiB of DECODED text
/// (`packages/vault/src/commands/inline-body-guard.ts:13`).
///
/// **This is not the 1 MiB "SB-text" ceiling** and the two are easy to
/// conflate. 1 MiB is `core.content_item`'s `replicaValues.textCeilingBytes`
/// (`packages/vault/src/schema/entity-catalog.ts:77`) — a REPLICA rule about
/// when a seat stops carrying a body's value and names the absence. The gate a
/// command enforces is this one, and it is sixteen times tighter, because a
/// text body cannot redirect to the CAS at all: the FTS feed decodes it
/// in-transaction and a trigger cannot do I/O.
pub(crate) const INLINE_BODY_BUDGET_BYTES: usize = 64 * 1024;

/// What produced the text in `core_content_text`, so a decoder change can
/// rebuild exactly the rows it invalidates (`schema/representation.ts:25`).
const CONTENT_TEXT_DECODER: &str = "data-uri/v1";

/// The RFC 6838 answer for bytes nothing described (`blob/promote.ts:43`).
pub(crate) const DEFAULT_MEDIA_TYPE: &str = "application/octet-stream";

/// The wrappers that keep a body history: their table and their pointer
/// (`packages/vault/src/commands/revisions.ts:40`). A `core.*` command in this
/// build only ever writes the first, but the guard is the v0 guard: an entity
/// that keeps no body history must not acquire one by accident.
const BODY_HISTORY_WRAPPERS: &[(&str, &str, &str)] = &[
    ("core.document", "core_document", "document_id"),
    ("knowledge.note", "knowledge_note", "note_id"),
];

/// `blob:sha256-<hex>` — the content URI of bytes that live in the CAS
/// (`packages/vault/src/blob/store.ts:20`).
fn blob_uri_for(sha256: &str) -> String {
    format!("blob:sha256-{sha256}")
}

/// The instant a document trashed at `now` purges at.
///
/// The arithmetic is `crates/vault::clock`'s, not a third copy: `parse_iso_ms`
/// and `format_iso_ms` are already public there. (`commands/media.rs` carries
/// its own private pair — a duplication this lane files as a finding rather
/// than editing another slot's file to remove.)
pub(crate) fn purge_at(now: &str) -> Result<String> {
    let millis = crate::clock::parse_iso_ms(now).ok_or_else(|| VaultError::Invariant {
        context: format!("`{now}` is not an instant this vault can date a purge from"),
    })?;
    Ok(crate::clock::format_iso_ms(
        millis + PURGE_AFTER_DAYS * 86_400_000,
    ))
}

/// The folders scheme's id, created on first use.
fn folder_scheme_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    find_or_create_scheme(ctx, FOLDER_SCHEME_URI, "Folders")
}

/// A concept scheme's id, created on first use.
fn find_or_create_scheme(ctx: &CommandCtx<'_, '_>, uri: &str, title: &str) -> Result<String> {
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT scheme_id FROM core_concept_scheme WHERE uri = ?1",
            [uri],
            |row| row.get(0),
        )
        .ok();
    if let Some(scheme_id) = existing {
        return Ok(scheme_id);
    }
    let scheme_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version, created_at)
         VALUES (?1, ?2, ?3, 'centraid', '1', ?4)",
        rusqlite::params![scheme_id, uri, title, ctx.now],
    )?;
    Ok(scheme_id)
}

/// The drive's top level — the scheme's `root` concept, created on first use.
fn root_folder_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    let scheme_id = folder_scheme_id(ctx)?;
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT concept_id FROM core_concept WHERE scheme_id = ?1 AND notation = ?2",
            rusqlite::params![scheme_id, ROOT_FOLDER_NOTATION],
            |row| row.get(0),
        )
        .ok();
    if let Some(concept_id) = existing {
        return Ok(concept_id);
    }
    let concept_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_concept
           (concept_id, scheme_id, notation, pref_label, alt_labels_json,
            broader_concept_id, definition, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Documents', NULL, NULL, 'The drive top level', ?4, ?4)",
        rusqlite::params![concept_id, scheme_id, ROOT_FOLDER_NOTATION, ctx.now],
    )?;
    Ok(concept_id)
}

/// Re-file a document: **exactly one folders-scheme tag per document**.
///
/// Delete-then-insert, which is what makes `move_document` a refile rather than
/// a second filing — and what the `filed_once` postcondition checks.
fn file_into(ctx: &CommandCtx<'_, '_>, document_id: &str, folder_concept_id: &str) -> Result<()> {
    ctx.connection().execute(
        "DELETE FROM core_tag
          WHERE target_type = ?1 AND target_id = ?2
            AND concept_id IN (SELECT c.concept_id FROM core_concept c
                                 JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                                WHERE s.uri = ?3)",
        rusqlite::params![DOCUMENT_TARGET_TYPE, document_id, FOLDER_SCHEME_URI],
    )?;
    let tag_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_tag
           (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
            confidence, tagged_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
        rusqlite::params![
            tag_id,
            DOCUMENT_TARGET_TYPE,
            document_id,
            folder_concept_id,
            actor_party_id(ctx)?,
            ctx.now
        ],
    )?;
    Ok(())
}

/// The `starred` concept id, created on first use. "Favorite" rides along as a
/// SKOS altLabel, so the star is one row in one place for every surface (#274).
fn starred_concept_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    let scheme_id = find_or_create_scheme(ctx, FLAGS_SCHEME_URI, "Flags")?;
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT concept_id FROM core_concept WHERE scheme_id = ?1 AND notation = ?2",
            rusqlite::params![scheme_id, STARRED_NOTATION],
            |row| row.get(0),
        )
        .ok();
    if let Some(concept_id) = existing {
        return Ok(concept_id);
    }
    let concept_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_concept
           (concept_id, scheme_id, notation, pref_label, alt_labels_json,
            broader_concept_id, definition, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Starred', '[\"Favorite\"]', NULL,
                 'Owner attention: one star across every surface', ?4, ?4)",
        rusqlite::params![concept_id, scheme_id, STARRED_NOTATION, ctx.now],
    )?;
    Ok(concept_id)
}

/// Set or clear `starred`. Delete-then-insert keeps it idempotent and refreshes
/// who-starred-when on a re-star (`commands/flags.ts:78`).
fn set_starred(ctx: &CommandCtx<'_, '_>, target_id: &str, starred: bool) -> Result<()> {
    let concept_id = starred_concept_id(ctx)?;
    ctx.connection().execute(
        "DELETE FROM core_tag WHERE target_type = ?1 AND target_id = ?2 AND concept_id = ?3",
        rusqlite::params![DOCUMENT_TARGET_TYPE, target_id, concept_id],
    )?;
    if !starred {
        return Ok(());
    }
    let tag_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_tag
           (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
            confidence, tagged_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
        rusqlite::params![
            tag_id,
            DOCUMENT_TARGET_TYPE,
            target_id,
            concept_id,
            actor_party_id(ctx)?,
            ctx.now
        ],
    )?;
    Ok(())
}

/// Whether a live `starred` tag stands on this document.
fn is_starred(ctx: &CommandCtx<'_, '_>, document_id: &str) -> Result<bool> {
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ?1 AND t.target_id = ?2
            AND s.uri = ?3 AND c.notation = ?4",
        rusqlite::params![
            DOCUMENT_TARGET_TYPE,
            document_id,
            FLAGS_SCHEME_URI,
            STARRED_NOTATION
        ],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// A live document's row: is it there, and undeleted?
fn document_is_live(ctx: &CommandCtx<'_, '_>, document_id: &str) -> Result<bool> {
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_document WHERE document_id = ?1 AND deleted_at IS NULL",
        [document_id],
        |row| row.get(0),
    )?;
    Ok(count == 1)
}

/// `document_exists`, the precondition eight of v0's definitions share: a
/// trashed document is FROZEN — restore first, then rename, move, star or edit
/// it.
fn pre_document_exists(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let document_id = ctx.required_str("document_id")?;
    Ok((!document_is_live(ctx, document_id)?)
        .then(|| "there is no live document with that id".to_owned()))
}

const LIVE_DOCUMENT: [CommandCondition; 1] = [CommandCondition {
    predicate: "document_exists",
    check: pre_document_exists,
}];

/// Is this concept a folder in the owner's folders scheme?
fn folder_exists(ctx: &CommandCtx<'_, '_>, folder_id: &str) -> Result<bool> {
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_concept c
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE c.concept_id = ?1 AND s.uri = ?2",
        rusqlite::params![folder_id, FOLDER_SCHEME_URI],
        |row| row.get(0),
    )?;
    Ok(count == 1)
}

/// `folder_exists_if_given`: an omitted folder means the drive's top level, and
/// that is not a refusal.
fn folder_exists_if_given(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(folder_id) = ctx.optional_str("folder_id") else {
        return Ok(None);
    };
    Ok((!folder_exists(ctx, folder_id)?).then(|| "there is no folder with that id".to_owned()))
}

/// The media type THIS owner reads its bytes as (#996 R20(b)). `None` where no
/// representation row names one — which is the absence, never a default.
fn media_type_of_owner(
    ctx: &CommandCtx<'_, '_>,
    owner_type: &str,
    owner_id: &str,
) -> Result<Option<String>> {
    Ok(ctx
        .connection()
        .query_row(
            "SELECT media_type FROM core_content_representation
              WHERE owner_type = ?1 AND owner_id = ?2",
            rusqlite::params![owner_type, owner_id],
            |row| row.get(0),
        )
        .ok())
}

/// THE ONE DECODER for a canonical body (#996 R4/R8,
/// `packages/vault/src/schema/content-text.ts:19`).
///
/// `None` for anything that is not `text/*` over a `data:` URI — and `None` is
/// the answer "we could not decode these bytes", which is why
/// `core_content_text.body_text` is `NOT NULL` and an absent row is the state.
fn content_text(media_type: &str, content_uri: &str) -> Option<String> {
    if !media_type.starts_with("text/") || !content_uri.starts_with("data:") {
        return None;
    }
    let comma = content_uri.find(',')?;
    let meta = &content_uri[..comma];
    let payload = &content_uri[comma + 1..];
    if meta.contains(";base64") {
        let bytes = base64_decode(payload)?;
        String::from_utf8(bytes).ok()
    } else {
        percent_decode_utf8(payload)
    }
}

/// DECODE AT WRITE TIME (#996 R4/R8): the one writer of `core_content_text`.
///
/// Written BEFORE the representation row, because the representation's own FTS
/// trigger reads `core_content_text` — so the text has to be there when it
/// fires (`schema/representation.ts:120`-`:124`).
pub(crate) fn index_content_text(
    ctx: &CommandCtx<'_, '_>,
    content_id: &str,
    media_type: &str,
) -> Result<()> {
    let content_uri: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT content_uri FROM core_content_item WHERE content_id = ?1",
            [content_id],
            |row| row.get(0),
        )
        .ok();
    let text = content_uri
        .as_deref()
        .and_then(|uri| content_text(media_type, uri));
    let Some(text) = text else {
        // A representation re-typed from text to binary takes its text with it.
        ctx.connection().execute(
            "DELETE FROM core_content_text WHERE content_id = ?1",
            [content_id],
        )?;
        return Ok(());
    };
    ctx.connection().execute(
        "INSERT INTO core_content_text
           (content_id, body_text, decoder, byte_size, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT (content_id) DO UPDATE SET
           body_text = excluded.body_text,
           decoder = excluded.decoder,
           byte_size = excluded.byte_size,
           updated_at = excluded.updated_at",
        rusqlite::params![
            content_id,
            text,
            CONTENT_TEXT_DECODER,
            i64::try_from(text.len()).unwrap_or(i64::MAX),
            ctx.now
        ],
    )?;
    Ok(())
}

/// What one owner takes a content item's bytes to BE (#996 R20(b), ONT-28).
///
/// `UNIQUE (owner_type, owner_id)`, so this is an upsert on the OWNER — the
/// same document re-typed keeps one row, and the same sha under two documents
/// keeps two.
pub(crate) fn set_representation(
    ctx: &CommandCtx<'_, '_>,
    content_id: &str,
    owner_type: &str,
    owner_id: &str,
    media_type: &str,
    interpretation: Option<&str>,
) -> Result<String> {
    index_content_text(ctx, content_id, media_type)?;
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT representation_id FROM core_content_representation
              WHERE owner_type = ?1 AND owner_id = ?2",
            rusqlite::params![owner_type, owner_id],
            |row| row.get(0),
        )
        .ok();
    if let Some(representation_id) = existing {
        ctx.connection().execute(
            "UPDATE core_content_representation
                SET content_id = ?1, media_type = ?2, charset = NULL, interpretation = ?3
              WHERE representation_id = ?4",
            rusqlite::params![content_id, media_type, interpretation, representation_id],
        )?;
        return Ok(representation_id);
    }
    let representation_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_content_representation
           (representation_id, content_id, owner_type, owner_id, media_type,
            charset, interpretation, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?7)",
        rusqlite::params![
            representation_id,
            content_id,
            owner_type,
            owner_id,
            media_type,
            interpretation,
            ctx.now
        ],
    )?;
    Ok(representation_id)
}

/// A body-history wrapper's current occurrence, or `None` before its first.
pub(crate) fn current_revision_of(
    ctx: &CommandCtx<'_, '_>,
    entity_type: &str,
    entity_id: &str,
) -> Result<Option<String>> {
    let Some((_, table, pk)) = BODY_HISTORY_WRAPPERS
        .iter()
        .find(|(logical, _, _)| *logical == entity_type)
    else {
        return Err(VaultError::Invariant {
            context: format!("`{entity_type}` keeps no body history"),
        });
    };
    Ok(ctx
        .connection()
        .query_row(
            &format!(
                "SELECT current_revision_id FROM {} WHERE {} = ?1",
                crate::log::quoted(table),
                crate::log::quoted(pk)
            ),
            [entity_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten())
}

/// Record that `content_id` became the wrapper's current body, and return the
/// OCCURRENCE id the caller writes into `current_revision_id`.
///
/// A REVISION IS AN OCCURRENCE, NOT A CONTENT ID (#996 R20(a)). The caller
/// repoints the wrapper itself, so a no-op edit — dedup landing back on the
/// same content id — skips the call rather than recording a revision that
/// revised nothing.
pub(crate) fn record_body_revision(
    ctx: &CommandCtx<'_, '_>,
    entity_type: &str,
    entity_id: &str,
    content_id: &str,
    previous_content_id: Option<&str>,
) -> Result<String> {
    let parent = current_revision_of(ctx, entity_type, entity_id)?;
    let revision_id = ctx.next_id();
    let snapshot = serde_json::json!({ "previous_content_id": previous_content_id }).to_string();
    ctx.connection().execute(
        "INSERT INTO core_entity_revision
           (revision_id, entity_type, entity_id, operation, snapshot_json,
            recorded_at, undo_until, undone_at, actor_party_id, invocation_id,
            content_id, parent_revision_id, updated_at)
         VALUES (?1, ?2, ?3, 'revise', ?4, ?5, ?5, NULL, NULL, NULL, ?6, ?7, ?5)",
        rusqlite::params![
            revision_id,
            entity_type,
            entity_id,
            snapshot,
            ctx.now,
            content_id,
            parent
        ],
    )?;
    Ok(revision_id)
}

/// Occurrences of one wrapper, newest first, walked from its current pointer.
///
/// Over `parent_revision_id`, never over content: a chain that revisits the
/// same bytes (A→B→A→B) is four distinct occurrences and reads as four. The
/// step cap is the same `MAX_CHAIN_STEPS` the app-plane walk uses.
pub(crate) fn revision_chain_of(
    ctx: &CommandCtx<'_, '_>,
    entity_type: &str,
    entity_id: &str,
) -> Result<Vec<(String, String)>> {
    let mut chain: Vec<(String, String)> = Vec::new();
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut at = current_revision_of(ctx, entity_type, entity_id)?;
    for _ in 0..MAX_CHAIN_STEPS {
        let Some(revision_id) = at.clone() else { break };
        if !seen.insert(revision_id.clone()) {
            break;
        }
        let row: Option<(Option<String>, Option<String>)> = ctx
            .connection()
            .query_row(
                "SELECT content_id, parent_revision_id FROM core_entity_revision
                  WHERE revision_id = ?1",
                [&revision_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        let Some((Some(content_id), parent)) = row else {
            break;
        };
        chain.push((revision_id, content_id));
        at = parent;
    }
    Ok(chain)
}

/// The chain-walk cap. A well-formed chain terminates on a null parent; this
/// caps a malformed one (`packages/blueprints/apps/docs/queries/history.ts:23`).
pub const MAX_CHAIN_STEPS: usize = 500;

/// A content item this command minted or claimed.
pub(crate) struct Minted {
    pub(crate) content_id: String,
    pub(crate) media_type: String,
    pub(crate) byte_size: i64,
    /// `1` when the sha already had a content item — the bytes were known, the
    /// DOCUMENT is still new.
    pub(crate) deduped: i64,
}

/// Dedupe-or-insert the canonical content item behind an inline `data:` payload.
///
/// THE MEDIA TYPE IS THIS CALL'S, NEVER THE STORED ROW'S (#996 R20(b)). It used
/// to be read back off the deduped row, so the first import of a byte string
/// decided what every later owner of those bytes was reading. The caller writes
/// it onto ITS OWN representation; nothing about it is stored here.
///
/// Re-presenting known bytes RESTORES them from trash — re-upload = restore,
/// `media.add_asset`'s rule.
pub(crate) fn mint_content_from_data_uri(ctx: &CommandCtx<'_, '_>, uri: &str) -> Result<Minted> {
    let (media_type, bytes) = decode_data_uri(uri)?;
    let sha = centraid_media::format::sha256_hex(&bytes);
    let existing: Option<(String, Option<String>)> = ctx
        .connection()
        .query_row(
            "SELECT content_id, deleted_at FROM core_content_item WHERE sha256 = ?1",
            [&sha],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let byte_size = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
    if let Some((content_id, deleted_at)) = existing {
        if deleted_at.is_some() {
            ctx.connection().execute(
                "UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL
                  WHERE content_id = ?1",
                [&content_id],
            )?;
        }
        return Ok(Minted {
            content_id,
            media_type,
            byte_size,
            deduped: 1,
        });
    }
    // TEXT STAYS IN THE ROW (the FTS feed decodes it in-transaction); binary
    // bytes spill to the CAS, and the spill needs a blob door `CommandCtx` does
    // not carry — D-1020-DC8, the module note. A refusal, never a
    // `core_content_item` whose `content_uri` names bytes nothing stored.
    if !media_type.starts_with("text/") {
        return Err(VaultError::InvalidInput {
            name: "data_uri".to_owned(),
            detail: format!(
                "`{media_type}` bytes cannot ride a command's own JSON in this build: \
                 the local content store is not on the command context yet. \
                 Stage them first (POST /_vault/blobs) and send `staged_sha`"
            ),
        });
    }
    let content_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_content_item
           (content_id, content_uri, sha256, byte_size, language, creator_party_id,
            origin_device_id, deleted_at, purge_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, NULL, ?6, ?6)",
        rusqlite::params![
            content_id,
            uri,
            sha,
            byte_size,
            actor_party_id(ctx).ok(),
            ctx.now
        ],
    )?;
    Ok(Minted {
        content_id,
        media_type,
        byte_size,
        deduped: 0,
    })
}

/// Claim one staged sha into a canonical content item
/// (`packages/vault/src/blob/promote.ts:52`).
///
/// **Pure row work, no I/O** — the bytes are already in the local CAS, which is
/// what lets this path be real while the inline binary path is not (D-1020-DC8).
/// Idempotent over dedup: when a content item already owns the sha, the claim
/// restores it from trash and just consumes the staging rows.
///
/// WHAT THE UPLOAD SAID, not what the deduped row once said (#996 R20(b)): the
/// staging band sniffed THESE bytes on THIS arrival. Re-claiming known bytes
/// with nothing staged means the CLAIMER supplies the reading.
pub(crate) fn promote_staged_blob(ctx: &CommandCtx<'_, '_>, sha256: &str) -> Result<Minted> {
    let staged: Option<(String, i64)> = ctx
        .connection()
        .query_row(
            "SELECT media_type, byte_size FROM blob_staging
              WHERE sha256 = ?1 AND variant IS NULL",
            [sha256],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let existing: Option<(String, i64, Option<String>)> = ctx
        .connection()
        .query_row(
            "SELECT content_id, byte_size, deleted_at FROM core_content_item WHERE sha256 = ?1",
            [sha256],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();
    let (content_id, byte_size, deduped) = match (&staged, &existing) {
        (None, None) => {
            return Err(VaultError::InvalidInput {
                name: "staged_sha".to_owned(),
                detail: format!("no staged blob {sha256} — upload it first (POST /_vault/blobs)"),
            });
        }
        (_, Some((content_id, byte_size, deleted_at))) => {
            if deleted_at.is_some() {
                ctx.connection().execute(
                    "UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL
                      WHERE content_id = ?1",
                    [content_id],
                )?;
            }
            (content_id.clone(), *byte_size, 1)
        }
        (Some((_, byte_size)), None) => {
            let content_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO core_content_item
                   (content_id, content_uri, sha256, byte_size, language, creator_party_id,
                    origin_device_id, deleted_at, purge_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, NULL, ?6, ?6)",
                rusqlite::params![
                    content_id,
                    blob_uri_for(sha256),
                    sha256,
                    byte_size,
                    actor_party_id(ctx).ok(),
                    ctx.now
                ],
            )?;
            (content_id, *byte_size, 0)
        }
    };
    promote_staged_variants(ctx, sha256, &content_id)?;
    let media_type = staged
        .map(|(media_type, _)| media_type)
        .or(media_type_for_content(ctx, &content_id)?)
        .unwrap_or_else(|| DEFAULT_MEDIA_TYPE.to_owned());
    // D-1020-DC9: v0 also queues `enrich_request` rows here for a device that
    // has contributed no derivative. `enrich.*` is the automations lane's
    // schema this slot; the hand-off is in the receipt.
    ctx.connection().execute(
        "DELETE FROM blob_staging WHERE sha256 = ?1 AND variant IS NULL",
        [sha256],
    )?;
    Ok(Minted {
        content_id,
        media_type,
        byte_size,
        deduped,
    })
}

/// The oldest reading of these bytes, for a claim that has none of its own.
pub(crate) fn media_type_for_content(
    ctx: &CommandCtx<'_, '_>,
    content_id: &str,
) -> Result<Option<String>> {
    Ok(ctx
        .connection()
        .query_row(
            "SELECT media_type FROM core_content_representation
              WHERE content_id = ?1 ORDER BY created_at, representation_id LIMIT 1",
            [content_id],
            |row| row.get(0),
        )
        .ok())
}

/// Staged derivatives riding beside a parent (`variant_of = sha`) promote into
/// `core_content_derivative`, and extracted text becomes the `text` variant
/// feeding the parent's FTS row.
///
/// Only the two INLINE semantic variants Docs can produce — `text` and
/// `transcript` — are promoted here; a binary derivative (`thumb`, `preview`,
/// `poster`) is a CAS rental whose bytes this build cannot verify without the
/// blob door, and promoting a row that names bytes nothing stored is the
/// failure D-1020-DC8 refuses.
fn promote_staged_variants(
    ctx: &CommandCtx<'_, '_>,
    parent_sha: &str,
    content_id: &str,
) -> Result<()> {
    // THE CHEAP INGEST EXTRACTOR IS THE BACKSTOP, and it goes FIRST so any
    // device-contributed pdf.js/OCR text below wins deterministically
    // (`blob/promote.ts`'s `promoteVariants`).
    let meta: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT meta_json FROM blob_staging WHERE sha256 = ?1 AND variant IS NULL",
            [parent_sha],
            |row| row.get(0),
        )
        .ok();
    if let Some(text) = meta
        .as_deref()
        .and_then(|meta| serde_json::from_str::<serde_json::Value>(meta).ok())
        .as_ref()
        .and_then(|meta| meta.get("text"))
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
    {
        upsert_text_derivative(ctx, content_id, "text", "text/plain", text)?;
    }
    let mut statement = ctx.connection().prepare(
        "SELECT staging_id, media_type, variant, inline_content FROM blob_staging
          WHERE variant_of = ?1 AND variant IS NOT NULL AND inline_content IS NOT NULL
          ORDER BY staging_id",
    )?;
    let staged: Vec<(String, String, String, String)> = statement
        .query_map([parent_sha], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for (staging_id, media_type, variant, inline_content) in staged {
        upsert_text_derivative(ctx, content_id, &variant, &media_type, &inline_content)?;
        ctx.connection().execute(
            "DELETE FROM blob_staging WHERE staging_id = ?1",
            [&staging_id],
        )?;
    }
    Ok(())
}

/// One inline derivative row, replaced rather than merged.
///
/// `UNIQUE (content_id, variant)` and the table's paired CHECKs mean an inline
/// variant carries `text_content` and no `sha256`; the delete-then-insert is
/// v0's (`commands/enrich.ts`'s `writeExtractedText`), and it is what makes
/// the command retry-safe.
fn upsert_text_derivative(
    ctx: &CommandCtx<'_, '_>,
    content_id: &str,
    variant: &str,
    media_type: &str,
    text: &str,
) -> Result<i64> {
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT derivative_id FROM core_content_derivative
              WHERE content_id = ?1 AND variant = ?2",
            rusqlite::params![content_id, variant],
            |row| row.get(0),
        )
        .ok();
    let replaced = i64::from(existing.is_some());
    if let Some(derivative_id) = existing {
        ctx.connection().execute(
            "DELETE FROM core_content_derivative WHERE derivative_id = ?1",
            [&derivative_id],
        )?;
    }
    let derivative_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, sha256, media_type, byte_size,
            text_content, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?7)",
        rusqlite::params![
            derivative_id,
            content_id,
            variant,
            media_type,
            i64::try_from(text.len()).unwrap_or(i64::MAX),
            text,
            ctx.now
        ],
    )?;
    Ok(replaced)
}

/// Parse and DECODE a `data:` URI — **the bytes are identity now, not the
/// text** (`packages/vault/src/blob/mint.ts:28`). Which is also what fixed the
/// old dedup hole: the same bytes under two declared mime types were two rows.
pub(crate) fn decode_data_uri(uri: &str) -> Result<(String, Vec<u8>)> {
    let refuse = |detail: &str| VaultError::InvalidInput {
        name: "data_uri".to_owned(),
        detail: detail.to_owned(),
    };
    let rest = uri
        .strip_prefix("data:")
        .ok_or_else(|| refuse("payload must be a data: URI"))?;
    let comma = rest
        .find(',')
        .ok_or_else(|| refuse("malformed data: URI (no comma)"))?;
    let meta = &rest[..comma];
    let payload = &rest[comma + 1..];
    let base64 = meta.split(';').any(|part| part == "base64");
    let media_type = meta
        .split(';')
        .next()
        .filter(|first| !first.is_empty())
        .unwrap_or(DEFAULT_MEDIA_TYPE)
        .to_owned();
    let bytes = if base64 {
        base64_decode(payload).ok_or_else(|| refuse("the base64 payload does not decode"))?
    } else {
        percent_decode_utf8(payload)
            .ok_or_else(|| refuse("the payload is not valid percent-encoded UTF-8"))?
            .into_bytes()
    };
    Ok((media_type, bytes))
}

/// `Buffer.from(payload, "base64")`, which is FORGIVING: Node's decoder ignores
/// characters outside the alphabet and tolerates missing padding, so a strict
/// decoder would refuse URIs v0 accepts.
fn base64_decode(payload: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let filtered: String = payload
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric()
                || *character == '+'
                || *character == '/'
                || *character == '-'
                || *character == '_'
        })
        .collect();
    let engine = base64::engine::general_purpose::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::general_purpose::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );
    engine
        .decode(filtered.replace('-', "+").replace('_', "/"))
        .ok()
}

/// `decodeURIComponent`: percent-decode as UTF-8, and `+` is NOT a space.
fn percent_decode_utf8(payload: &str) -> Option<String> {
    let bytes = payload.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = payload.get(at + 1..at + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `encodeURIComponent`, for the `data:` URI `edit_document` builds.
///
/// The unreserved set is v0's exactly — `A-Za-z0-9-_.!~*'()` — because the URI
/// this produces is the content item's own `content_uri` and therefore part of
/// what the sha is taken over: a different escaping is different bytes and
/// therefore a different content id.
pub(crate) fn encode_uri_component(text: &str) -> String {
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

/// THE INLINE DOOR'S GATES, each a named function so two commands share one
/// spelling rather than two.
///
/// `exactly_one_source`, `is_data_uri`, `within_size_cap`, the text budget and
/// `staged_or_owned`, in v0's order. They are preconditions in v0 rather than
/// schema rules because JSON Schema's `oneOf` would make the error name the
/// schema instead of the choice.
pub(crate) fn pre_exactly_one_source(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let inline = ctx.optional_str("data_uri").is_some();
    let staged = ctx.optional_str("staged_sha").is_some();
    Ok((inline == staged).then(|| {
        "send the bytes one way: `data_uri` for a small inline payload, \
         or `staged_sha` for bytes already uploaded"
            .to_owned()
    }))
}

pub(crate) fn pre_is_data_uri(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(uri) = ctx.optional_str("data_uri") else {
        return Ok(None);
    };
    Ok((!uri.starts_with("data:")).then(|| "an inline payload must be a data: URI".to_owned()))
}

/// The inline door is for SMALL payloads (#296): the journal records every
/// input, so big documents take the staging route.
pub(crate) fn pre_within_size_cap(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(uri) = ctx.optional_str("data_uri") else {
        return Ok(None);
    };
    Ok((uri.len() > MAX_INLINE_DATA_URI_CHARS).then(|| {
        format!(
            "that payload is {} characters, over the {MAX_INLINE_DATA_URI_CHARS}-character \
             inline door — upload it first (POST /_vault/blobs) and send `staged_sha`",
            uri.len()
        )
    }))
}

/// The tighter second gate, for `text/*` only: binary spills to the CAS
/// regardless (`commands/inline-body-guard.ts:44`-`:52`).
pub(crate) fn pre_text_body_within_budget(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(uri) = ctx.optional_str("data_uri") else {
        return Ok(None);
    };
    let Ok((media_type, bytes)) = decode_data_uri(uri) else {
        // A malformed URI is `is_data_uri`'s or the mint's to say; this gate has
        // no opinion about it.
        return Ok(None);
    };
    Ok(
        (media_type.starts_with("text/") && bytes.len() > INLINE_BODY_BUDGET_BYTES).then(|| {
            format!(
                "that inline {media_type} body is {} bytes, over the \
                 {INLINE_BODY_BUDGET_BYTES}-byte inline budget — text bodies cannot redirect \
                 to blob storage (the search index reads them in-transaction), so this one is \
                 refused rather than silently bloating the vault",
                bytes.len()
            )
        }),
    )
}

/// D-1020-DC8, AS A GATE RATHER THAN A THROW.
///
/// Inline bytes that are not `text/*` have to be spilled into the local
/// content store, and `CommandCtx` carries no blob door. v0 throws from the
/// handler and its HTTP layer turns the throw into `{status: "denied"}`; here
/// it is a PRECONDITION, so the refusal is receipted with its own predicate and
/// an owner-facing sentence, and the audit trail names the gate rather than an
/// exception type.
///
/// It does NOT refuse bytes this vault already holds: the mint dedupes before
/// it would spill, so a second wrapper over a content item that exists needs no
/// store at all. Which is also v0's order (`blob/mint.ts:69`-`:88`).
pub(crate) fn pre_inline_bytes_are_storable(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(uri) = ctx.optional_str("data_uri") else {
        return Ok(None);
    };
    let Ok((media_type, bytes)) = decode_data_uri(uri) else {
        return Ok(None);
    };
    if media_type.starts_with("text/") {
        return Ok(None);
    }
    let held: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_content_item WHERE sha256 = ?1",
        [centraid_media::format::sha256_hex(&bytes)],
        |row| row.get(0),
    )?;
    Ok((held == 0).then(|| {
        format!(
            "`{media_type}` bytes cannot ride a command's own JSON in this build: \
             the local content store is not on the command context yet. \
             Stage them first (POST /_vault/blobs) and send `staged_sha`"
        )
    }))
}

pub(crate) fn pre_staged_or_owned(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(sha) = ctx.optional_str("staged_sha") else {
        return Ok(None);
    };
    let held: i64 = ctx.connection().query_row(
        "SELECT (EXISTS(SELECT 1 FROM blob_staging WHERE sha256 = ?1 AND variant IS NULL)
                 OR EXISTS(SELECT 1 FROM core_content_item WHERE sha256 = ?1))",
        [sha],
        |row| row.get(0),
    )?;
    Ok((held != 1).then(|| {
        "those bytes are not staged and this vault does not already hold them — \
         upload them first (POST /_vault/blobs)"
            .to_owned()
    }))
}

/// The bytes this write carries, whichever door they came through.
pub(crate) fn minted_bytes(ctx: &CommandCtx<'_, '_>) -> Result<Minted> {
    if let Some(sha) = ctx.optional_str("staged_sha") {
        let sha = sha.to_owned();
        return promote_staged_blob(ctx, &sha);
    }
    let uri = ctx.required_str("data_uri")?.to_owned();
    mint_content_from_data_uri(ctx, &uri)
}

/// The id a CREATED row takes: the seat's when it minted one, ours otherwise
/// (#922 G2, `packages/vault/src/commands/minted-id.ts:33`).
pub(crate) fn minted_id(ctx: &CommandCtx<'_, '_>, property: &str) -> String {
    ctx.optional_str(property)
        .map_or_else(|| ctx.next_id(), str::to_owned)
}

/// The id a CREATED row took, as a POSTCONDITION sees it.
///
/// The gate hands a postcondition the input only — never the output — so a
/// minted id has to be findable from what the run produced. Every creating
/// command below mints its own row id FIRST, so `produced_ids[0]` is it; that
/// is also the more honest order, because a document is a wrapper that then
/// acquires bytes.
fn created_id(ctx: &CommandCtx<'_, '_>, property: &str) -> String {
    created_row_id(ctx, property)
}

/// The same, for a sibling schema's creating commands.
///
/// `knowledge.create_note` and `knowledge.create_notebook` have the same
/// problem and the same answer, and the rule — **mint the wrapper's own id
/// FIRST** — is one rule about `produced_ids`, not one per schema.
pub(crate) fn created_row_id(ctx: &CommandCtx<'_, '_>, property: &str) -> String {
    ctx.optional_str(property)
        .map(str::to_owned)
        .or_else(|| ctx.produced_ids.borrow().first().cloned())
        .unwrap_or_default()
}

/// Refuse a minted id the vault already holds. Absent id, no opinion.
///
/// A seat-minted id the vault has seen is a REPLAY or a COLLISION, never an
/// instruction to overwrite the row someone else is looking at.
pub(crate) fn minted_id_is_free(
    ctx: &CommandCtx<'_, '_>,
    property: &str,
    table: &str,
    id_column: &str,
    subject: &str,
) -> Result<Option<String>> {
    let Some(id) = ctx.optional_str(property) else {
        return Ok(None);
    };
    let count: i64 = ctx.connection().query_row(
        &format!(
            "SELECT COUNT(*) FROM {} WHERE {} = ?1",
            crate::log::quoted(table),
            crate::log::quoted(id_column)
        ),
        [id],
        |row| row.get(0),
    )?;
    Ok((count != 0).then(|| format!("That {subject} already exists.")))
}

// ---------------------------------------------------------------------------
// The fourteen document and folder commands.
// ---------------------------------------------------------------------------

/// ONE `UPDATE core_document`, whatever the caller is changing.
///
/// The `SET` fragments are this module's own literals — never caller data — and
/// the binds are positional in the order the fragments appear, with the
/// document id last. A second statement would be a second `row_version` bump
/// for one member gesture, which puts a seat's row ahead of the origin's for
/// the same edit.
fn update_document(ctx: &CommandCtx<'_, '_>, sets: &[&str], binds: &[String]) -> Result<()> {
    let sql = format!(
        "UPDATE core_document SET {} WHERE document_id = ?",
        sets.join(", ")
    );
    let params: Vec<&dyn rusqlite::ToSql> = binds
        .iter()
        .map(|bind| bind as &dyn rusqlite::ToSql)
        .collect();
    ctx.connection().prepare(&sql)?.execute(params.as_slice())?;
    Ok(())
}

fn add_document() -> CommandDefinition {
    CommandDefinition {
        name: "core.add_document",
        owner_schema: "core",
        input_schema: ADD_DOCUMENT_SCHEMA,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: ADD_DOCUMENT_PRE,
        postconditions: &[CommandCondition {
            predicate: "document_filed",
            check: |ctx| {
                let document_id = created_id(ctx, "document_id");
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_document d
                      WHERE d.document_id = ?1 AND d.deleted_at IS NULL
                        AND EXISTS(SELECT 1 FROM core_tag t
                                     JOIN core_concept c ON c.concept_id = t.concept_id
                                     JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                                    WHERE t.target_type = ?2 AND t.target_id = d.document_id
                                      AND s.uri = ?3)",
                    rusqlite::params![document_id, DOCUMENT_TARGET_TYPE, FOLDER_SCHEME_URI],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the document was not filed".to_owned()))
            },
        }],
        handler: |ctx| {
            // THE WRAPPER'S ID FIRST — see `created_id`.
            let document_id = minted_id(ctx, "document_id");
            let title = ctx.required_str("title")?.to_owned();
            let folder_id = ctx.optional_str("folder_id").map(str::to_owned);
            let extracted_text = ctx.optional_str("extracted_text").map(str::to_owned);
            let minted = minted_bytes(ctx)?;
            ctx.connection().execute(
                "INSERT INTO core_document
                   (document_id, title, current_content_id, created_at, updated_at,
                    deleted_at, purge_at)
                 VALUES (?1, ?2, ?3, ?4, ?4, NULL, NULL)",
                rusqlite::params![document_id, title, minted.content_id, ctx.now],
            )?;
            // THIS DOCUMENT'S READING OF THE BYTES (#996 R20(b)). The same sha
            // filed twice as two documents carries two readings, so a second
            // filing cannot inherit the first import's media type.
            set_representation(
                ctx,
                &minted.content_id,
                DOCUMENT_TARGET_TYPE,
                &document_id,
                &minted.media_type,
                Some("body"),
            )?;
            // The FIRST occurrence (#996 R20(a)): a document's original body is
            // a version like any other, so the chain starts here rather than
            // being inferred later from the absence of a parent edge.
            let revision_id = record_body_revision(
                ctx,
                DOCUMENT_TARGET_TYPE,
                &document_id,
                &minted.content_id,
                None,
            )?;
            ctx.connection().execute(
                "UPDATE core_document SET current_revision_id = ?1 WHERE document_id = ?2",
                rusqlite::params![revision_id, document_id],
            )?;
            if let Some(text) = extracted_text.filter(|text| !text.is_empty()) {
                upsert_text_derivative(ctx, &minted.content_id, "text", "text/plain", &text)?;
            }
            let folder = match folder_id {
                Some(folder_id) => folder_id,
                None => root_folder_id(ctx)?,
            };
            file_into(ctx, &document_id, &folder)?;
            Ok(serde_json::json!({
                "document_id": document_id,
                "content_id": minted.content_id,
                "deduped": minted.deduped,
                "byte_size": minted.byte_size,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

/// `add_document`'s preconditions: the minted-id guard, the five byte-source
/// gates, and the folder check.
const ADD_DOCUMENT_PRE: &[CommandCondition] = &[
    CommandCondition {
        predicate: "document_id_is_free",
        check: |ctx| {
            minted_id_is_free(
                ctx,
                "document_id",
                "core_document",
                "document_id",
                "document",
            )
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
        predicate: "folder_exists_if_given",
        check: folder_exists_if_given,
    },
];

/// `move_document`'s: the document is live, and the folder is one.
const MOVE_DOCUMENT_PRE: &[CommandCondition] = &[
    CommandCondition {
        predicate: "document_exists",
        check: pre_document_exists,
    },
    CommandCondition {
        predicate: "folder_exists_if_given",
        check: folder_exists_if_given,
    },
];

const ADD_DOCUMENT_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["title"],
          "additionalProperties": false,
          "properties": {
            "document_id": {
              "type": "string", "minLength": 36, "maxLength": 36,
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "data_uri": { "type": "string", "minLength": 6 },
            "staged_sha": { "type": "string", "minLength": 64, "maxLength": 64 },
            "title": { "type": "string", "minLength": 1 },
            "folder_id": { "type": "string", "minLength": 1 },
            "extracted_text": { "type": "string", "minLength": 1, "maxLength": 200000 }
          }
        }"#;

fn rename_document() -> CommandDefinition {
    CommandDefinition {
        name: "core.rename_document",
        owner_schema: "core",
        input_schema: r#"{
          "type": "object",
          "required": ["document_id", "title"],
          "additionalProperties": false,
          "properties": {
            "document_id": { "type": "string", "minLength": 1 },
            "title": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &LIVE_DOCUMENT,
        postconditions: &[CommandCondition {
            predicate: "title_applied",
            check: |ctx| {
                let document_id = ctx.required_str("document_id")?;
                let title = ctx.required_str("title")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_document WHERE document_id = ?1 AND title = ?2",
                    rusqlite::params![document_id, title],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the title did not take".to_owned()))
            },
        }],
        handler: |ctx| {
            let document_id = ctx.required_str("document_id")?.to_owned();
            let title = ctx.required_str("title")?.to_owned();
            // The WRAPPER's title only — bytes and version history untouched.
            ctx.connection().execute(
                "UPDATE core_document SET title = ?1, updated_at = ?2 WHERE document_id = ?3",
                rusqlite::params![title, ctx.now, document_id],
            )?;
            Ok(serde_json::json!({ "document_id": document_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn move_document() -> CommandDefinition {
    CommandDefinition {
        name: "core.move_document",
        owner_schema: "core",
        input_schema: r#"{
          "type": "object",
          "required": ["document_id"],
          "additionalProperties": false,
          "properties": {
            "document_id": { "type": "string", "minLength": 1 },
            "folder_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: MOVE_DOCUMENT_PRE,
        postconditions: &[CommandCondition {
            // FILED EXACTLY ONCE — the move replaced, never duplicated.
            predicate: "filed_once",
            check: |ctx| {
                let document_id = ctx.required_str("document_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_tag t
                       JOIN core_concept c ON c.concept_id = t.concept_id
                       JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                      WHERE t.target_type = ?1 AND t.target_id = ?2 AND s.uri = ?3",
                    rusqlite::params![DOCUMENT_TARGET_TYPE, document_id, FOLDER_SCHEME_URI],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| {
                    format!(
                        "the document is filed in {count} folders, and a document is filed in one"
                    )
                }))
            },
        }],
        handler: |ctx| {
            let document_id = ctx.required_str("document_id")?.to_owned();
            // An omitted folder means back to the drive's top level.
            let folder = match ctx.optional_str("folder_id") {
                Some(folder_id) => folder_id.to_owned(),
                None => root_folder_id(ctx)?,
            };
            file_into(ctx, &document_id, &folder)?;
            ctx.connection().execute(
                "UPDATE core_document SET updated_at = ?1 WHERE document_id = ?2",
                rusqlite::params![ctx.now, document_id],
            )?;
            Ok(serde_json::json!({ "document_id": document_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn trash_document() -> CommandDefinition {
    CommandDefinition {
        name: "core.trash_document",
        owner_schema: "core",
        input_schema: DOCUMENT_ID_ONLY,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        // ONLY A LIVE DOCUMENT CAN BE TRASHED — a double-delete fails loudly
        // instead of silently re-stamping the trash date.
        preconditions: &LIVE_DOCUMENT,
        postconditions: &[CommandCondition {
            predicate: "document_trashed",
            check: |ctx| {
                let document_id = ctx.required_str("document_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_document
                      WHERE document_id = ?1 AND deleted_at IS NOT NULL AND purge_at IS NOT NULL",
                    [document_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the document was not trashed".to_owned()))
            },
        }],
        handler: |ctx| {
            let document_id = ctx.required_str("document_id")?.to_owned();
            let until = purge_at(&ctx.now)?;
            // CONTENT IS UNTOUCHED (the retention stance, #352): the wrapper
            // trashes, its bytes — current AND every superseded revision — stay
            // live until the document itself purges.
            ctx.connection().execute(
                "UPDATE core_document SET deleted_at = ?1, purge_at = ?2, updated_at = ?1
                  WHERE document_id = ?3",
                rusqlite::params![ctx.now, until, document_id],
            )?;
            Ok(serde_json::json!({ "document_id": document_id, "purge_at": until }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn restore_document() -> CommandDefinition {
    CommandDefinition {
        name: "core.restore_document",
        owner_schema: "core",
        input_schema: DOCUMENT_ID_ONLY,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            // RESTORE REFUSES A LAPSED WINDOW (#916, review 1.5), and the
            // window is compared against `ctx.now` — the invocation's own
            // instant — never SQLite's clock.
            predicate: "document_in_trash",
            check: |ctx| {
                let document_id = ctx.required_str("document_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_document
                      WHERE document_id = ?1 AND deleted_at IS NOT NULL
                        AND (purge_at IS NULL OR purge_at > ?2)",
                    rusqlite::params![document_id, ctx.now],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| {
                    "that document is not in the trash, or its grace window has run out".to_owned()
                }))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "document_restored",
            check: |ctx| {
                let document_id = ctx.required_str("document_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_document
                      WHERE document_id = ?1 AND deleted_at IS NULL AND purge_at IS NULL",
                    [document_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the document was not restored".to_owned()))
            },
        }],
        handler: |ctx| {
            let document_id = ctx.required_str("document_id")?.to_owned();
            // It returns to the folder it was filed in: trash keeps the folder
            // tag (and the star), so a restored document lands where it was.
            ctx.connection().execute(
                "UPDATE core_document SET deleted_at = NULL, purge_at = NULL, updated_at = ?1
                  WHERE document_id = ?2",
                rusqlite::params![ctx.now, document_id],
            )?;
            Ok(serde_json::json!({ "document_id": document_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

/// `core.empty_document_trash` — collapse the grace window on EVERY document
/// already in the trash so the next lifecycle sweep destroys them (#1015, D1).
///
/// **Nothing is deleted here.** The gateway's sweep is the only thing that
/// destroys a document, and it keeps its rent checks, its authority revocations
/// and its provenance receipts — emptying the trash is a DATE, not a second
/// destruction path. `purge_at` collapses onto the row's own `deleted_at`
/// rather than onto `now`: a moment provably in the past, so the postcondition
/// is exact without reading a clock.
///
/// An empty trash is a NO-OP that still executes: a member who taps "Empty
/// trash" on an empty trash is not shown a refusal. And **not** `confirm: true`
/// — the owner's confirmation is the manifest's `confirmation: "required"`, in
/// front of the command (census §A0's two gates).
fn empty_document_trash() -> CommandDefinition {
    CommandDefinition {
        name: "core.empty_document_trash",
        owner_schema: "core",
        input_schema: r#"{ "type": "object", "additionalProperties": false, "properties": {} }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::High,
        confirm: false,
        preconditions: &[],
        postconditions: &[CommandCondition {
            // NO DOCUMENT MAY SIT IN THE TRASH STILL WAITING OUT A WINDOW.
            predicate: "trash_window_collapsed",
            check: |ctx| {
                let waiting: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_document
                      WHERE deleted_at IS NOT NULL AND purge_at <> deleted_at",
                    [],
                    |row| row.get(0),
                )?;
                Ok((waiting != 0).then(|| {
                    format!("{waiting} trashed documents are still waiting out a grace window")
                }))
            },
        }],
        handler: |ctx| {
            let released = ctx.connection().execute(
                "UPDATE core_document SET purge_at = deleted_at, updated_at = ?1
                  WHERE deleted_at IS NOT NULL",
                [&ctx.now],
            )?;
            Ok(serde_json::json!({
                "documents_released": i64::try_from(released).unwrap_or(i64::MAX)
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn star_document() -> CommandDefinition {
    CommandDefinition {
        name: "core.star_document",
        owner_schema: "core",
        input_schema: DOCUMENT_ID_ONLY,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        // A trashed document refuses state changes (the same rule as
        // rename/move), but an already-starred one keeps its tag through trash
        // and restore.
        preconditions: &LIVE_DOCUMENT,
        postconditions: &[CommandCondition {
            predicate: "document_starred",
            check: |ctx| {
                let document_id = ctx.required_str("document_id")?;
                Ok(
                    (!is_starred(ctx, document_id)?)
                        .then(|| "the star was not recorded".to_owned()),
                )
            },
        }],
        handler: |ctx| {
            let document_id = ctx.required_str("document_id")?.to_owned();
            // ONE flags-scheme tag on the document WRAPPER — the same star
            // every other surface reads.
            set_starred(ctx, &document_id, true)?;
            ctx.connection().execute(
                "UPDATE core_document SET updated_at = ?1 WHERE document_id = ?2",
                rusqlite::params![ctx.now, document_id],
            )?;
            Ok(serde_json::json!({ "document_id": document_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn unstar_document() -> CommandDefinition {
    CommandDefinition {
        name: "core.unstar_document",
        owner_schema: "core",
        input_schema: DOCUMENT_ID_ONLY,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &LIVE_DOCUMENT,
        postconditions: &[CommandCondition {
            predicate: "document_unstarred",
            check: |ctx| {
                let document_id = ctx.required_str("document_id")?;
                Ok(is_starred(ctx, document_id)?.then(|| "the star is still there".to_owned()))
            },
        }],
        handler: |ctx| {
            let document_id = ctx.required_str("document_id")?.to_owned();
            set_starred(ctx, &document_id, false)?;
            ctx.connection().execute(
                "UPDATE core_document SET updated_at = ?1 WHERE document_id = ?2",
                rusqlite::params![ctx.now, document_id],
            )?;
            Ok(serde_json::json!({ "document_id": document_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn edit_document() -> CommandDefinition {
    CommandDefinition {
        name: "core.edit_document",
        owner_schema: "core",
        input_schema: r#"{
          "type": "object",
          "required": ["document_id", "body_text"],
          "additionalProperties": false,
          "properties": {
            "document_id": { "type": "string", "minLength": 1 },
            "body_text": { "type": "string" },
            "title": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            // A trashed document is FROZEN: restore first, then edit.
            CommandCondition {
                predicate: "document_exists",
                check: pre_document_exists,
            },
            CommandCondition {
                // Only text-editable media types take the structured
                // `body_text` door; a scanned PDF or an image goes through
                // `replace_document_content`. The type is read off THIS
                // document's representation, not off bytes other documents also
                // use (#996 R20(b)).
                predicate: "current_content_is_text",
                check: |ctx| {
                    let document_id = ctx.required_str("document_id")?;
                    let media_type = media_type_of_owner(ctx, DOCUMENT_TARGET_TYPE, document_id)?;
                    Ok(match media_type {
                        Some(media_type) if media_type.starts_with("text/") => None,
                        Some(media_type) => Some(format!(
                            "this document is {media_type}; editing its body in place is a \
                             text-only gesture — replace its bytes instead"
                        )),
                        None => Some(
                            "nothing says what this document's bytes are, so they cannot be \
                             edited as text"
                                .to_owned(),
                        ),
                    })
                },
            },
            CommandCondition {
                predicate: "text_body_within_budget",
                check: |ctx| {
                    let body = ctx.required_str("body_text")?;
                    Ok((body.len() > INLINE_BODY_BUDGET_BYTES).then(|| {
                        format!(
                            "that body is {} bytes, over the {INLINE_BODY_BUDGET_BYTES}-byte \
                             inline budget — text bodies cannot redirect to blob storage \
                             (the search index reads them in-transaction)",
                            body.len()
                        )
                    }))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "edit_applied",
            check: |ctx| {
                let document_id = ctx.required_str("document_id")?;
                let body_text = ctx.required_str("body_text")?;
                let stored: Option<String> = ctx
                    .connection()
                    .query_row(
                        "SELECT ct.body_text FROM core_document d
                           JOIN core_content_text ct ON ct.content_id = d.current_content_id
                          WHERE d.document_id = ?1",
                        [document_id],
                        |row| row.get(0),
                    )
                    .ok();
                if stored.as_deref() != Some(body_text) {
                    return Ok(Some("the body did not take".to_owned()));
                }
                if let Some(title) = ctx.optional_str("title") {
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_document WHERE document_id = ?1 AND title = ?2",
                        rusqlite::params![document_id, title],
                        |row| row.get(0),
                    )?;
                    if count != 1 {
                        return Ok(Some("the title did not take".to_owned()));
                    }
                }
                Ok(None)
            },
        }],
        handler: |ctx| {
            let document_id = ctx.required_str("document_id")?.to_owned();
            let body_text = ctx.required_str("body_text")?.to_owned();
            let title = ctx.optional_str("title").map(str::to_owned);
            let current: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT current_content_id FROM core_document WHERE document_id = ?1",
                    [&document_id],
                    |row| row.get(0),
                )
                .ok();
            let current = current.ok_or_else(|| VaultError::Invariant {
                context: "the document vanished between check and execute".to_owned(),
            })?;
            // The media type CARRIES FORWARD — an edit changes the words, never
            // the format — and it is read off THIS document's representation.
            let media_type = media_type_of_owner(ctx, DOCUMENT_TARGET_TYPE, &document_id)?
                .unwrap_or_else(|| "text/plain".to_owned());
            let data_uri = format!(
                "data:{media_type};charset=utf-8,{}",
                encode_uri_component(&body_text)
            );
            let minted = mint_content_from_data_uri(ctx, &data_uri)?;
            // ONE `UPDATE`, because the touch trigger bumps `row_version` per
            // statement and two statements would put this seat's row a version
            // ahead of the origin's for the same edit.
            let mut sets: Vec<&str> = vec!["updated_at = ?"];
            let mut binds: Vec<String> = vec![ctx.now.clone()];
            if minted.content_id != current {
                let revision_id = record_body_revision(
                    ctx,
                    DOCUMENT_TARGET_TYPE,
                    &document_id,
                    &minted.content_id,
                    Some(&current),
                )?;
                sets.push("current_content_id = ?");
                binds.push(minted.content_id.clone());
                sets.push("current_revision_id = ?");
                binds.push(revision_id);
                set_representation(
                    ctx,
                    &minted.content_id,
                    DOCUMENT_TARGET_TYPE,
                    &document_id,
                    &media_type,
                    Some("body"),
                )?;
            }
            if let Some(title) = &title {
                sets.push("title = ?");
                binds.push(title.clone());
            }
            binds.push(document_id.clone());
            update_document(ctx, &sets, &binds)?;
            Ok(serde_json::json!({
                "document_id": document_id, "content_id": minted.content_id
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn replace_document_content() -> CommandDefinition {
    CommandDefinition {
        name: "core.replace_document_content",
        owner_schema: "core",
        input_schema: r#"{
          "type": "object",
          "required": ["document_id"],
          "additionalProperties": false,
          "properties": {
            "document_id": { "type": "string", "minLength": 1 },
            "data_uri": { "type": "string", "minLength": 6 },
            "staged_sha": { "type": "string", "minLength": 64, "maxLength": 64 },
            "title": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: REPLACE_CONTENT_PRE,
        postconditions: &[CommandCondition {
            predicate: "content_replaced",
            check: |ctx| {
                let document_id = ctx.required_str("document_id")?;
                // The content id is the OUTPUT, which a postcondition does not
                // see — so the claim is checked against the model instead: the
                // head names a live content item, and the head IS an
                // occurrence's content.
                let aligned: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_document d
                       JOIN core_entity_revision r ON r.revision_id = d.current_revision_id
                      WHERE d.document_id = ?1 AND r.content_id = d.current_content_id",
                    [document_id],
                    |row| row.get(0),
                )?;
                if aligned != 1 {
                    return Ok(Some(
                        "the document's head and its newest occurrence do not name the same bytes"
                            .to_owned(),
                    ));
                }
                if let Some(title) = ctx.optional_str("title") {
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_document WHERE document_id = ?1 AND title = ?2",
                        rusqlite::params![document_id, title],
                        |row| row.get(0),
                    )?;
                    if count != 1 {
                        return Ok(Some("the title did not take".to_owned()));
                    }
                }
                Ok(None)
            },
        }],
        handler: |ctx| {
            let document_id = ctx.required_str("document_id")?.to_owned();
            let title = ctx.optional_str("title").map(str::to_owned);
            let current: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT current_content_id FROM core_document WHERE document_id = ?1",
                    [&document_id],
                    |row| row.get(0),
                )
                .ok();
            let current = current.ok_or_else(|| VaultError::Invariant {
                context: "the document vanished between check and execute".to_owned(),
            })?;
            let minted = minted_bytes(ctx)?;
            // Replacing the bytes RE-STATES what this document reads them as
            // (#996): a scan replaced by a PDF is a new reading, not a new byte
            // row's property.
            set_representation(
                ctx,
                &minted.content_id,
                DOCUMENT_TARGET_TYPE,
                &document_id,
                &minted.media_type,
                Some("body"),
            )?;
            let mut sets: Vec<&str> = vec!["updated_at = ?"];
            let mut binds: Vec<String> = vec![ctx.now.clone()];
            if minted.content_id != current {
                let revision_id = record_body_revision(
                    ctx,
                    DOCUMENT_TARGET_TYPE,
                    &document_id,
                    &minted.content_id,
                    Some(&current),
                )?;
                sets.push("current_content_id = ?");
                binds.push(minted.content_id.clone());
                sets.push("current_revision_id = ?");
                binds.push(revision_id);
            }
            if let Some(title) = &title {
                sets.push("title = ?");
                binds.push(title.clone());
            }
            binds.push(document_id.clone());
            update_document(ctx, &sets, &binds)?;
            Ok(serde_json::json!({
                "document_id": document_id,
                "content_id": minted.content_id,
                "deduped": minted.deduped,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

/// `replace_document_content`'s: the document is live, and the bytes came
/// through exactly one door.
const REPLACE_CONTENT_PRE: &[CommandCondition] = &[
    CommandCondition {
        predicate: "document_exists",
        check: pre_document_exists,
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
];

fn restore_document_version() -> CommandDefinition {
    CommandDefinition {
        name: "core.restore_document_version",
        owner_schema: "core",
        input_schema: r#"{
          "type": "object",
          "required": ["document_id", "content_id"],
          "additionalProperties": false,
          "properties": {
            "document_id": { "type": "string", "minLength": 1 },
            "content_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "document_exists",
                check: pre_document_exists,
            },
            CommandCondition {
                predicate: "not_already_current",
                check: |ctx| {
                    let document_id = ctx.required_str("document_id")?;
                    let content_id = ctx.required_str("content_id")?;
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_document
                          WHERE document_id = ?1 AND current_content_id = ?2",
                        rusqlite::params![document_id, content_id],
                        |row| row.get(0),
                    )?;
                    Ok((count != 0).then(|| "that version is already the current one".to_owned()))
                },
            },
            CommandCondition {
                // A REVISION BELONGS TO ONE OBJECT (#996 R20(a)). The target
                // must be a content item THIS DOCUMENT'S OWN occurrences name —
                // never an arbitrary content item, and never another document's
                // history that happens to share the bytes. The walk is over
                // occurrence ids, so A→B→A→B is four occurrences and terminates.
                predicate: "target_in_chain",
                check: |ctx| {
                    let document_id = ctx.required_str("document_id")?;
                    let content_id = ctx.required_str("content_id")?;
                    let chain = revision_chain_of(ctx, DOCUMENT_TARGET_TYPE, document_id)?;
                    Ok(
                        (!chain.iter().any(|(_, content)| content == content_id)).then(|| {
                            format!(
                                "content {content_id} is not a version of {document_id} — \
                             a version belongs to one document"
                            )
                        }),
                    )
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "restored_and_recorded",
            check: |ctx| {
                let document_id = ctx.required_str("document_id")?;
                let content_id = ctx.required_str("content_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_document d
                       JOIN core_entity_revision r ON r.revision_id = d.current_revision_id
                      WHERE d.document_id = ?1 AND d.current_content_id = ?2
                        AND r.content_id = ?2 AND r.parent_revision_id IS NOT NULL",
                    rusqlite::params![document_id, content_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1)
                    .then(|| "the restore did not land as a new forward occurrence".to_owned()))
            },
        }],
        handler: |ctx| {
            let document_id = ctx.required_str("document_id")?.to_owned();
            let content_id = ctx.required_str("content_id")?.to_owned();
            let current: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT current_content_id FROM core_document WHERE document_id = ?1",
                    [&document_id],
                    |row| row.get(0),
                )
                .ok();
            let current = current.ok_or_else(|| VaultError::Invariant {
                context: "the document vanished between check and execute".to_owned(),
            })?;
            // HISTORY NEVER REWRITES (rule R3): this ASSERTS a new forward
            // occurrence and repoints the head, so the old chain stays exactly
            // as it was and a restore-of-a-restore never loops.
            let revision_id = record_body_revision(
                ctx,
                DOCUMENT_TARGET_TYPE,
                &document_id,
                &content_id,
                Some(&current),
            )?;
            ctx.connection().execute(
                "UPDATE core_document
                    SET current_content_id = ?1, current_revision_id = ?2, updated_at = ?3
                  WHERE document_id = ?4",
                rusqlite::params![content_id, revision_id, ctx.now, document_id],
            )?;
            // The representation FOLLOWS THE HEAD (#996 R20(b)): a restore
            // changes WHICH bytes this document reads, never HOW it reads them.
            let media_type = media_type_of_owner(ctx, DOCUMENT_TARGET_TYPE, &document_id)?
                .unwrap_or_else(|| "text/plain".to_owned());
            set_representation(
                ctx,
                &content_id,
                DOCUMENT_TARGET_TYPE,
                &document_id,
                &media_type,
                Some("body"),
            )?;
            Ok(serde_json::json!({
                "document_id": document_id, "content_id": content_id
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn create_folder() -> CommandDefinition {
    CommandDefinition {
        name: "core.create_folder",
        owner_schema: "core",
        input_schema: CREATE_FOLDER_SCHEMA,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "folder_id_is_free",
                check: |ctx| {
                    minted_id_is_free(ctx, "folder_id", "core_concept", "concept_id", "folder")
                },
            },
            CommandCondition {
                predicate: "parent_exists_if_given",
                check: |ctx| {
                    let Some(parent) = ctx.optional_str("parent_folder_id") else {
                        return Ok(None);
                    };
                    Ok((!folder_exists(ctx, parent)?)
                        .then(|| "there is no folder with that parent id".to_owned()))
                },
            },
            CommandCondition {
                // SIBLING FOLDERS KEEP DISTINCT NAMES — a receipted refusal
                // beats two "Taxes" folders side by side. A parentless folder
                // and one filed under `root` are SIBLINGS, which is why the
                // clause has two arms.
                predicate: "name_unused_among_siblings",
                check: |ctx| {
                    let name = ctx.required_str("name")?;
                    let parent = ctx.optional_str("parent_folder_id");
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_concept c
                           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                          WHERE s.uri = ?1 AND c.pref_label = ?2 AND c.notation <> ?3
                            AND ((?4 IS NULL AND (c.broader_concept_id IS NULL
                                   OR c.broader_concept_id IN
                                      (SELECT concept_id FROM core_concept
                                        WHERE notation = ?3 AND scheme_id = s.scheme_id)))
                                 OR c.broader_concept_id = ?4)",
                        rusqlite::params![FOLDER_SCHEME_URI, name, ROOT_FOLDER_NOTATION, parent],
                        |row| row.get(0),
                    )?;
                    Ok((count != 0)
                        .then(|| format!("there is already a folder called \"{name}\" there")))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "folder_created",
            check: |ctx| {
                let folder_id = created_id(ctx, "folder_id");
                let name = ctx.required_str("name")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_concept WHERE concept_id = ?1 AND pref_label = ?2",
                    rusqlite::params![folder_id, name],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the folder was not created".to_owned()))
            },
        }],
        handler: |ctx| {
            // THE FOLDER'S OWN ID FIRST — see `created_id`. The scheme and the
            // root concept may each mint one behind it.
            let folder_id = minted_id(ctx, "folder_id");
            let name = ctx.required_str("name")?.to_owned();
            let scheme_id = folder_scheme_id(ctx)?;
            let parent = match ctx.optional_str("parent_folder_id") {
                Some(parent) => parent.to_owned(),
                None => root_folder_id(ctx)?,
            };
            // A folder is a SKOS concept whose `notation` is its own id: the
            // notation has to be unique within the scheme and a member-facing
            // name is not.
            ctx.connection().execute(
                "INSERT INTO core_concept
                   (concept_id, scheme_id, notation, pref_label, alt_labels_json,
                    broader_concept_id, definition, created_at, updated_at)
                 VALUES (?1, ?2, ?1, ?3, NULL, ?4, NULL, ?5, ?5)",
                rusqlite::params![folder_id, scheme_id, name, parent, ctx.now],
            )?;
            Ok(serde_json::json!({ "folder_id": folder_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn rename_folder() -> CommandDefinition {
    CommandDefinition {
        name: "core.rename_folder",
        owner_schema: "core",
        input_schema: r#"{
          "type": "object",
          "required": ["folder_id", "name"],
          "additionalProperties": false,
          "properties": {
            "folder_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &FOLDER_NOT_ROOT,
        postconditions: &[CommandCondition {
            predicate: "name_applied",
            check: |ctx| {
                let folder_id = ctx.required_str("folder_id")?;
                let name = ctx.required_str("name")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_concept WHERE concept_id = ?1 AND pref_label = ?2",
                    rusqlite::params![folder_id, name],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the name did not take".to_owned()))
            },
        }],
        handler: |ctx| {
            let folder_id = ctx.required_str("folder_id")?.to_owned();
            let name = ctx.required_str("name")?.to_owned();
            ctx.connection().execute(
                "UPDATE core_concept SET pref_label = ?1, updated_at = ?2 WHERE concept_id = ?3",
                rusqlite::params![name, ctx.now, folder_id],
            )?;
            Ok(serde_json::json!({ "folder_id": folder_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

/// `folder_exists_and_not_root` — the drive's top level is the DRIVE's name,
/// not a folder's, so it refuses both a rename and a delete.
fn pre_folder_not_root(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let folder_id = ctx.required_str("folder_id")?;
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_concept c
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE c.concept_id = ?1 AND s.uri = ?2 AND c.notation <> ?3",
        rusqlite::params![folder_id, FOLDER_SCHEME_URI, ROOT_FOLDER_NOTATION],
        |row| row.get(0),
    )?;
    Ok((count != 1).then(|| {
        "there is no folder with that id — the drive's own top level is not a folder".to_owned()
    }))
}

const FOLDER_NOT_ROOT: [CommandCondition; 1] = [CommandCondition {
    predicate: "folder_exists_and_not_root",
    check: pre_folder_not_root,
}];

fn delete_folder() -> CommandDefinition {
    CommandDefinition {
        name: "core.delete_folder",
        owner_schema: "core",
        input_schema: r#"{
          "type": "object",
          "required": ["folder_id"],
          "additionalProperties": false,
          "properties": { "folder_id": { "type": "string", "minLength": 1 } }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "folder_exists_and_not_root",
                check: pre_folder_not_root,
            },
            CommandCondition {
                // ONLY EMPTY FOLDERS DELETE — move or trash the contents first,
                // and "contents" includes TRASHED documents, which still carry
                // their folder tag so a restore lands where it was.
                predicate: "folder_is_empty",
                check: |ctx| {
                    let folder_id = ctx.required_str("folder_id")?;
                    let occupied: i64 = ctx.connection().query_row(
                        "SELECT (EXISTS(SELECT 1 FROM core_tag WHERE concept_id = ?1)
                                 OR EXISTS(SELECT 1 FROM core_concept
                                            WHERE broader_concept_id = ?1))",
                        [folder_id],
                        |row| row.get(0),
                    )?;
                    Ok((occupied != 0).then(|| {
                        "that folder still holds documents or subfolders — \
                         a trashed document counts, because it keeps its folder"
                            .to_owned()
                    }))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "folder_removed",
            check: |ctx| {
                let folder_id = ctx.required_str("folder_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_concept WHERE concept_id = ?1",
                    [folder_id],
                    |row| row.get(0),
                )?;
                Ok((count != 0).then(|| "the folder is still there".to_owned()))
            },
        }],
        handler: |ctx| {
            let folder_id = ctx.required_str("folder_id")?.to_owned();
            ctx.connection().execute(
                "DELETE FROM core_concept WHERE concept_id = ?1",
                [&folder_id],
            )?;
            Ok(serde_json::json!({ "folder_id": folder_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

// ---------------------------------------------------------------------------
// The tag half, and the recognition writer.
// ---------------------------------------------------------------------------

fn untag_item() -> CommandDefinition {
    CommandDefinition {
        name: "core.untag_item",
        owner_schema: "core",
        input_schema: r#"{
          "type": "object",
          "required": ["tag_id"],
          "additionalProperties": false,
          "properties": { "tag_id": { "type": "string", "minLength": 1 } }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "tag_exists",
            check: |ctx| {
                let tag_id = ctx.required_str("tag_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_tag WHERE tag_id = ?1",
                    [tag_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "there is no such label on anything".to_owned()))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "tag_removed",
            check: |ctx| {
                let tag_id = ctx.required_str("tag_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_tag WHERE tag_id = ?1",
                    [tag_id],
                    |row| row.get(0),
                )?;
                Ok((count != 0).then(|| "the label is still there".to_owned()))
            },
        }],
        handler: |ctx| {
            let tag_id = ctx.required_str("tag_id")?.to_owned();
            // BY TAG_ID, THE SPECIFIC EDGE — never by label. Two labels can
            // spell the same word under two schemes, and removing "by label"
            // would take the folder tag or the star with it.
            ctx.connection()
                .execute("DELETE FROM core_tag WHERE tag_id = ?1", [&tag_id])?;
            Ok(serde_json::json!({ "tag_id": tag_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

/// `core.set_extracted_text` — THE RECOGNITION WRITER (#299).
///
/// OCR and transcription land as an INLINE `core_content_derivative`, which is
/// what feeds the parent content item's FTS row. `retry-safe` because a second
/// run replaces the row rather than adding one: the derivative's key is
/// `(content_id, variant)`.
///
/// **The automations lane calls this by name.** Everything about the model and
/// the provider side of a recognition run is that lane's; the only thing here
/// is where the text goes. The `capability`/`model`/`profile`/`prompt_rev`/
/// `confidence`/`regions` inputs are accepted and validated — v0's schema
/// verbatim — and the derivation stamp they feed
/// (`packages/vault/src/enrich/derivation.ts`) is the automations lane's table,
/// so this build records the text and not the stamp (D-1020-DC9).
fn set_extracted_text() -> CommandDefinition {
    CommandDefinition {
        name: "core.set_extracted_text",
        owner_schema: "core",
        input_schema: SET_EXTRACTED_TEXT_SCHEMA,
        idempotency: Idempotency::RetrySafe,
        risk: Risk::Medium,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "content_item_live",
            check: |ctx| {
                let content_id = ctx.required_str("content_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_content_item
                      WHERE content_id = ?1 AND deleted_at IS NULL",
                    [content_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "there are no live bytes with that content id".to_owned()))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "text_derivative_present",
            check: |ctx| {
                let content_id = ctx.required_str("content_id")?;
                let variant = ctx.optional_str("variant").unwrap_or("text");
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_content_derivative
                      WHERE content_id = ?1 AND variant = ?2",
                    rusqlite::params![content_id, variant],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the extracted text was not recorded".to_owned()))
            },
        }],
        handler: |ctx| {
            let content_id = ctx.required_str("content_id")?.to_owned();
            let text = ctx.required_str("text")?.to_owned();
            let variant = ctx.optional_str("variant").unwrap_or("text").to_owned();
            let replaced = upsert_text_derivative(ctx, &content_id, &variant, "text/plain", &text)?;
            Ok(serde_json::json!({ "content_id": content_id, "replaced": replaced }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

const SET_EXTRACTED_TEXT_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["content_id", "text"],
          "additionalProperties": false,
          "properties": {
            "content_id": { "type": "string", "minLength": 1 },
            "text": { "type": "string", "minLength": 1 },
            "variant": { "type": "string", "enum": ["text", "transcript"] },
            "capability": { "type": "string", "minLength": 1 },
            "model": { "type": "string", "minLength": 1 },
            "profile": { "type": "string", "minLength": 1 },
            "prompt_rev": { "type": "string", "minLength": 1 },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "regions": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["text"],
                "additionalProperties": false,
                "properties": {
                  "text": { "type": "string" },
                  "box": { "type": "array", "minItems": 4, "maxItems": 4,
                           "items": { "type": "integer", "minimum": 0 } },
                  "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
                }
              }
            }
          }
        }"#;

const DOCUMENT_ID_ONLY: &str = r#"{
          "type": "object",
          "required": ["document_id"],
          "additionalProperties": false,
          "properties": { "document_id": { "type": "string", "minLength": 1 } }
        }"#;

const CREATE_FOLDER_SCHEMA: &str = r#"{
          "type": "object",
          "required": ["name"],
          "additionalProperties": false,
          "properties": {
            "folder_id": {
              "type": "string", "minLength": 36, "maxLength": 36,
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "name": { "type": "string", "minLength": 1 },
            "parent_folder_id": { "type": "string", "minLength": 1 }
          }
        }"#;

/// Display label to notation: lowercased, whitespace collapsed, trimmed.
#[must_use]
pub fn notation_of(label: &str) -> String {
    label
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The acting party: the caller's own, else the vault's owner.
pub(crate) fn actor_party_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    let owner: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT self_party_id FROM core_vault WHERE self_party_id IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    owner.ok_or_else(|| VaultError::Invariant {
        context: "this vault has no owner yet; enrol one before tagging".to_owned(),
    })
}

fn find_or_create_tags_scheme(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT scheme_id FROM core_concept_scheme WHERE uri = ?1",
            [TAGS_SCHEME_URI],
            |row| row.get(0),
        )
        .ok();
    if let Some(scheme_id) = existing {
        return Ok(scheme_id);
    }
    let scheme_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version, created_at)
         VALUES (?1, ?2, 'Tags', 'centraid', 'v1', ?3)",
        rusqlite::params![scheme_id, TAGS_SCHEME_URI, ctx.now],
    )?;
    Ok(scheme_id)
}

fn find_or_create_concept(
    ctx: &CommandCtx<'_, '_>,
    scheme_id: &str,
    label: &str,
    notation: &str,
) -> Result<String> {
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT concept_id FROM core_concept WHERE scheme_id = ?1 AND notation = ?2",
            rusqlite::params![scheme_id, notation],
            |row| row.get(0),
        )
        .ok();
    if let Some(concept_id) = existing {
        return Ok(concept_id);
    }
    let concept_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_concept
           (concept_id, scheme_id, notation, pref_label, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        rusqlite::params![concept_id, scheme_id, notation, label.trim(), ctx.now],
    )?;
    Ok(concept_id)
}

// ---------------------------------------------------------------------------
// `core.merge_party` — THE ONTOLOGY PRIMITIVE (#290, D-1020-PE2).
//
// Without a merge, every added source DEGRADES the vault: an import mints a
// second "Grandpa Ray" and from then on half the birthdays, half the debts and
// half the photographs are on the wrong card. So the fold is not a soft merge
// and not a redirect — **every reference re-points and the merged party's row
// is deleted.**
//
// ### The sweep is GENERATED, never a hand-kept list
//
// v0's merge walks two discovered sets plus one enumerated one
// (`commands/merge-fold.ts`), and this port keeps the shape and widens the
// discovery:
//
// 1. **Every engine foreign key onto `core_party`**, read live from
//    `PRAGMA foreign_key_list` over every table in the file. Forty-four columns
//    in the committed DDL, and a forty-fifth added by a migration is swept the
//    day it exists rather than the day somebody remembers.
// 2. **Every polymorphic `(type, id)` pointer into the entity supertype**, also
//    read live: rung ten (#916) turned all thirteen of them into COMPOSITE
//    foreign keys into `core_entity(entity_type, entity_id)`, so a two-column
//    FK whose parent is `core_entity` IS the pointer set. v0 reads them from
//    `schema/entity-refs.ts`'s `ENTITY_POINTERS`; reading the schema instead
//    means the list and the DDL cannot drift, which is the whole failure the
//    registry existed to prevent.
// 3. **The pointers the engine cannot see** — [`PARTY_POINTERS`], which is one
//    column: `share_authority.principal_id` under `principal_kind = 'person'`.
//    It is polymorphic on a kind that selects a party, a circle, a harness or
//    an automation, so **no single `REFERENCES` clause can express it** and
//    neither walk above can find it. A merge that skipped it would delete the
//    folded-in party out from under a LIVE standing answer, and a share the
//    owner had already granted would silently stop being delivered.
//
// `merge_party_sweep` returns all three as one list, and
// `the_sweep_finds_every_column_that_names_a_party` asserts that no column in
// the file whose NAME looks like a party pointer is outside it — the mechanical
// sweep, as a test rather than as a paragraph.
//
// ### RE-JUDGING THE POLYMORPHIC REFERENCE (AGENTS.md: a citation is not a
// justification)
//
// The #916 wave filed polymorphic references as settled and had to reopen them.
// Re-judged here on the merge's own evidence:
//
// * **Who depends on it.** `core_link`, `core_tag`, `core_collection_entry`,
//   `core_attachment`, `knowledge_annotation`,
//   `schedule_recurrence_exception`, the four `enrich_*` tables, `outbox_item`,
//   `sync_external_entity` and `share_subscription_lineage` — thirteen tables,
//   every one of which points at *any* entity kind. A typed reference table per
//   (pointer × target kind) would be thirteen tables times the entity kinds
//   each admits, and `core_tag` alone tags documents, notes, tasks, assets and
//   parties.
// * **What the FK buys.** Since rung ten each pair is a real composite FK, so
//   the engine CHECKS the target on write and CASCADES the pointer when the
//   target is purged. That is the property a typed table would also have, and
//   it is the one that matters.
// * **What it still costs.** `PRAGMA foreign_key_list` reports `core_entity` as
//   the parent, so "what points at THIS party" is not answerable from the
//   engine — which is exactly why this sweep has to read the pair shape rather
//   than the parent name. That cost is real and it is paid once, here.
//
// **Verdict: the polymorphic reference stays, and the finding is elsewhere** —
// it is that `share_authority.principal_id` is NOT one of them. It is the one
// pointer with no type column the engine can read, it is the one a merge can
// silently break, and it is enumerated in a hand-kept list. Making it a real
// `(principal_type, principal_id)` pair into `core_entity` is the change that
// would retire [`PARTY_POINTERS`] entirely; it is an owner hand-off in this
// lane's receipt, not a schema edit from an app slot.
//
// ### What a collision means, per table
//
// A re-point can hit a UNIQUE constraint the survivor already satisfies, and
// "delete the loser" is the wrong answer for money. #916 review 2.1 records how
// that destroyed money: the splits and payers of a shared expense are keyed
// `(expense_id, party_id)`, so folding two people who both appear on one bill
// collides — and a deleted split threw away a share the total still counted.
// A SHARE IS A NUMBER: the right answer is to add it to the survivor's.
// [`MERGE_COLLISIONS`] is that table, and a CHECK failure is separate again: the
// two sides of a two-party row just became one party, a payment to oneself is
// not a payment, and the row is folded away and COUNTED as degenerate.
// A FOREIGN KEY failure is a bug in this code or a corrupt vault and is
// re-thrown, because the old blanket catch turned it into a silent delete.

/// A column that holds a party id with **no foreign key on it**, plus the
/// predicate that says which of its rows do.
///
/// One entry, and the header says why it cannot be discovered. A second entry
/// arriving here is a schema change that should have been a composite FK.
const PARTY_POINTERS: &[(&str, &str, &str, PointerCollision)] = &[(
    "share_authority",
    "principal_id",
    "principal_kind = 'person'",
    // A STANDING ANSWER IS NEVER SILENTLY DELETED: it is dated shut and THEN
    // re-pointed, which is also the only order that works where the constraint
    // covers live rows only.
    PointerCollision::Revoke,
)];

/// Columns whose NAME reads as a party pointer and which hold something else.
///
/// The audit in `crates/vault/tests/people_commands.rs` scans every column in
/// the file for a party-shaped name and asserts each one is either in the sweep
/// or here. One entry, with the DDL's own reason:
/// `share_authority_request.principal_id` carries **an automation's enrolment
/// key** — the table has no `principal_kind` column and the baseline says
/// outright that the id is "the same principal id
/// `share_authority.principal_id` carries for an 'automation' row"
/// (`contracts/migrations/001_baseline.sql`). A merge that re-pointed it would
/// hand one automation's pending scope request to a person.
pub const NOT_A_PARTY_POINTER: &[(&str, &str)] = &[("share_authority_request", "principal_id")];

/// What happens to the loser when a pointer's re-point collides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PointerCollision {
    /// The row is an ANSWER: date it shut, then re-point it.
    Revoke,
}

/// What a UNIQUE collision means for a table the engine's FK walk reaches.
///
/// The default is "drop the duplicate" — machinery saying nothing the
/// survivor's copy does not already say. These are the exceptions, and every
/// one of them is a number or a primacy flag.
const MERGE_COLLISIONS: &[(&str, Collision)] = &[
    ("tally_expense_split", Collision::Sum("share_minor")),
    ("tally_expense_payer", Collision::Sum("paid_minor")),
    (
        "tally_expense_line_allocation",
        Collision::Sum("share_minor"),
    ),
    (
        "tally_recurring_expense_split",
        Collision::Sum("share_minor"),
    ),
    ("core_party_identifier", Collision::Demote("is_primary")),
    ("social_contact_channel", Collision::Demote("is_preferred")),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Collision {
    /// Both rows are real and their amounts ADD: fold onto the survivor's row.
    Sum(&'static str),
    /// A second row of a kind only one may be primary: keep it, demote it.
    Demote(&'static str),
    /// Duplicate machinery. The default.
    DropDuplicate,
}

fn collision_for(table: &str) -> Collision {
    MERGE_COLLISIONS
        .iter()
        .find(|(name, _)| *name == table)
        .map_or(Collision::DropDuplicate, |(_, policy)| *policy)
}

/// One foreign key as `PRAGMA foreign_key_list` reports it: the parent table,
/// and its `(seq, from, to)` columns. A two-column group is a polymorphic pair.
type ForeignKeyGroup = (String, Vec<(i64, String, Option<String>)>);

/// One column the sweep has to re-point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartyRef {
    pub table: String,
    /// The column holding the party id.
    pub column: String,
    /// The type column beside it, on a polymorphic pointer.
    pub type_column: Option<String>,
    /// A raw predicate ANDed onto the match, for a hand-kept pointer.
    pub predicate: Option<String>,
    /// EVERY primary-key column, in key order.
    pub key: Vec<String>,
}

/// THE PRIMARY KEY, WHOLE (#916, review 2.1).
///
/// This was once `cols.find(|c| c.pk == 1)`, read as "the primary key column".
/// **`PRAGMA table_info.pk` is not a boolean**: it is the column's POSITION in
/// the key, 1-based. On `tally_expense_split (expense_id, party_id)` that
/// returned `expense_id` alone, so a merge's "re-point this one row" ran
/// `UPDATE … WHERE expense_id = ?` and rewrote — or, on the collision path,
/// DELETED — every split of the expense. A shared 900 became an expense with no
/// splits and no payers, silently.
fn primary_key_of(connection: &rusqlite::Connection, table: &str) -> Result<Vec<String>> {
    let mut prepared = connection
        .prepare("SELECT name, pk FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk")?;
    let rows = prepared.query_map([table], |row| row.get::<_, String>(0))?;
    let key: Vec<String> = rows.collect::<std::result::Result<Vec<String>, _>>()?;
    Ok(if key.is_empty() {
        vec!["rowid".to_owned()]
    } else {
        key
    })
}

/// Every table in the file, excluding SQLite's own and the full-text indexes.
///
/// **The `fts_*` tables are NOT swept**, and that is a decision rather than a
/// gap: `fts_core_party` is an external-content FTS5 index whose rows are
/// maintained by triggers on `core_party`, so a merge that hand-edited it would
/// be a second writer of a derived table — and deleting the merged party fires
/// the trigger that removes its row anyway.
fn user_tables(connection: &rusqlite::Connection) -> Result<Vec<String>> {
    let mut prepared = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
           AND name NOT LIKE 'fts_%'
         ORDER BY name",
    )?;
    let rows = prepared.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<String>, _>>()?)
}

/// THE WHOLE SWEEP, generated from the live schema plus the one list it cannot
/// generate.
///
/// The order is stable — engine FKs by table then column, then the polymorphic
/// pairs, then the hand-kept pointers — so a merge's tally is reproducible and
/// a fixture can be compared.
pub fn merge_party_sweep(connection: &rusqlite::Connection) -> Result<Vec<PartyRef>> {
    let mut refs: Vec<PartyRef> = Vec::new();
    for table in user_tables(connection)? {
        if table == "core_party" {
            continue;
        }
        let key = primary_key_of(connection, &table)?;
        // `id` groups the columns of ONE foreign key; `seq` orders them inside
        // it. A two-column key is a `(type, id)` pair.
        let mut prepared = connection.prepare(
            "SELECT id, seq, \"table\", \"from\", \"to\"
               FROM pragma_foreign_key_list(?1) ORDER BY id, seq",
        )?;
        let rows = prepared.query_map([&table], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;
        let mut groups: BTreeMap<i64, ForeignKeyGroup> = BTreeMap::new();
        for row in rows {
            let (id, seq, parent, from, to) = row?;
            groups
                .entry(id)
                .or_insert_with(|| (parent, Vec::new()))
                .1
                .push((seq, from, to));
        }
        for (parent, mut columns) in groups.into_values() {
            columns.sort_by_key(|(seq, _, _)| *seq);
            match (parent.as_str(), columns.len()) {
                // A single-column FK straight onto the party table.
                ("core_party", 1) => refs.push(PartyRef {
                    table: table.clone(),
                    column: columns[0].1.clone(),
                    type_column: None,
                    predicate: None,
                    key: key.clone(),
                }),
                // A composite FK into the entity supertype: the pair IS a
                // polymorphic pointer, whatever the columns are called.
                ("core_entity", 2) => {
                    let type_column = columns
                        .iter()
                        .find(|(_, _, to)| to.as_deref() == Some("entity_type"))
                        .map(|(_, from, _)| from.clone());
                    let id_column = columns
                        .iter()
                        .find(|(_, _, to)| to.as_deref() == Some("entity_id"))
                        .map(|(_, from, _)| from.clone());
                    if let (Some(type_column), Some(id_column)) = (type_column, id_column) {
                        refs.push(PartyRef {
                            table: table.clone(),
                            column: id_column,
                            type_column: Some(type_column),
                            predicate: None,
                            key: key.clone(),
                        });
                    }
                }
                _ => {}
            }
        }
    }
    for (table, column, predicate, _) in PARTY_POINTERS {
        refs.push(PartyRef {
            table: (*table).to_owned(),
            column: (*column).to_owned(),
            type_column: None,
            predicate: Some((*predicate).to_owned()),
            key: primary_key_of(connection, table)?,
        });
    }
    Ok(refs)
}

/// What one fold did, for the citation and for the test.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FoldTally {
    pub repointed: usize,
    pub deduped: usize,
    pub summed: usize,
    /// Rows whose two ends became one party. A payment to oneself is not a
    /// payment.
    pub degenerate: usize,
    pub revoked: usize,
}

/// Which constraint refused, so the fold can ANSWER it rather than reach for
/// the delete (#916, review 2.1).
///
/// The old code caught every failure and deleted the row, so a UNIQUE collision
/// ("the survivor already has this"), a CHECK violation ("the merge just made
/// this row nonsense") and a FOREIGN KEY refusal ("this is a bug") were all
/// "duplicate relation removed" in the citation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConstraintClass {
    Unique,
    Check,
    ForeignKey,
    Other,
}

fn constraint_class_of(error: &rusqlite::Error) -> ConstraintClass {
    let message = error.to_string();
    if message.contains("UNIQUE constraint failed") || message.contains("PRIMARY KEY") {
        ConstraintClass::Unique
    } else if message.contains("CHECK constraint failed") {
        ConstraintClass::Check
    } else if message.contains("FOREIGN KEY constraint failed") {
        ConstraintClass::ForeignKey
    } else {
        ConstraintClass::Other
    }
}

fn quoted(parts: &[String]) -> String {
    parts
        .iter()
        .map(|part| format!("\"{part}\" = ?"))
        .collect::<Vec<String>>()
        .join(" AND ")
}

/// Re-point ONE row from `merged` to `survivor`, answering whichever constraint
/// refuses.
fn repoint_row(
    connection: &rusqlite::Connection,
    reference: &PartyRef,
    key_values: &[rusqlite::types::Value],
    survivor: &str,
    now: &str,
    tally: &mut FoldTally,
) -> Result<()> {
    let where_key = quoted(&reference.key);
    let mut binds: Vec<rusqlite::types::Value> =
        vec![rusqlite::types::Value::Text(survivor.to_owned())];
    binds.extend(key_values.iter().cloned());
    let update = format!(
        "UPDATE \"{}\" SET \"{}\" = ? WHERE {where_key}",
        reference.table, reference.column
    );
    match connection.execute(&update, rusqlite::params_from_iter(binds.iter())) {
        Ok(_) => {
            tally.repointed += 1;
            return Ok(());
        }
        Err(error) => match constraint_class_of(&error) {
            ConstraintClass::Check => {
                // BOTH ENDS ARE THE SURVIVOR NOW: the row says nothing.
                connection.execute(
                    &format!("DELETE FROM \"{}\" WHERE {where_key}", reference.table),
                    rusqlite::params_from_iter(key_values.iter()),
                )?;
                tally.degenerate += 1;
                return Ok(());
            }
            ConstraintClass::Unique => {}
            // A BUG IN THIS CODE OR A CORRUPT VAULT. Re-thrown; the old blanket
            // catch turned it into a silent delete.
            ConstraintClass::ForeignKey | ConstraintClass::Other => return Err(error.into()),
        },
    }

    match collision_for(&reference.table) {
        Collision::Sum(amount_column) if reference.key.contains(&reference.column) => {
            // The survivor's row carries the same key with this column swapped.
            let survivor_key: Vec<rusqlite::types::Value> = reference
                .key
                .iter()
                .zip(key_values)
                .map(|(column, value)| {
                    if column == &reference.column {
                        rusqlite::types::Value::Text(survivor.to_owned())
                    } else {
                        value.clone()
                    }
                })
                .collect();
            let amount: i64 = connection
                .query_row(
                    &format!(
                        "SELECT \"{amount_column}\" FROM \"{}\" WHERE {where_key}",
                        reference.table
                    ),
                    rusqlite::params_from_iter(key_values.iter()),
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let mut binds: Vec<rusqlite::types::Value> =
                vec![rusqlite::types::Value::Integer(amount)];
            binds.extend(survivor_key);
            connection.execute(
                &format!(
                    "UPDATE \"{}\" SET \"{amount_column}\" = \"{amount_column}\" + ? WHERE {where_key}",
                    reference.table
                ),
                rusqlite::params_from_iter(binds.iter()),
            )?;
            connection.execute(
                &format!("DELETE FROM \"{}\" WHERE {where_key}", reference.table),
                rusqlite::params_from_iter(key_values.iter()),
            )?;
            tally.summed += 1;
            return Ok(());
        }
        Collision::Demote(flag_column) => {
            let mut binds: Vec<rusqlite::types::Value> =
                vec![rusqlite::types::Value::Text(survivor.to_owned())];
            binds.extend(key_values.iter().cloned());
            let demote = format!(
                "UPDATE \"{}\" SET \"{}\" = ?, \"{flag_column}\" = 0 WHERE {where_key}",
                reference.table, reference.column
            );
            match connection.execute(&demote, rusqlite::params_from_iter(binds.iter())) {
                Ok(_) => {
                    tally.repointed += 1;
                    return Ok(());
                }
                // A collision on the VALUE, not on primacy: a genuine duplicate.
                Err(error) if constraint_class_of(&error) == ConstraintClass::Unique => {}
                Err(error) => return Err(error.into()),
            }
        }
        Collision::Sum(_) | Collision::DropDuplicate => {}
    }

    if let Some(PointerCollision::Revoke) = PARTY_POINTERS
        .iter()
        .find(|(table, column, _, _)| *table == reference.table && *column == reference.column)
        .map(|(_, _, _, policy)| *policy)
    {
        let mut binds: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(now.to_owned()),
            rusqlite::types::Value::Text(survivor.to_owned()),
        ];
        binds.extend(key_values.iter().cloned());
        connection.execute(
            &format!(
                "UPDATE \"{}\" SET revoked_at = ?, \"{}\" = ? WHERE {where_key}",
                reference.table, reference.column
            ),
            rusqlite::params_from_iter(binds.iter()),
        )?;
        tally.repointed += 1;
        tally.revoked += 1;
        return Ok(());
    }

    connection.execute(
        &format!("DELETE FROM \"{}\" WHERE {where_key}", reference.table),
        rusqlite::params_from_iter(key_values.iter()),
    )?;
    tally.deduped += 1;
    Ok(())
}

/// Read the primary keys of the rows one reference holds against `merged`.
fn rows_naming(
    connection: &rusqlite::Connection,
    reference: &PartyRef,
    merged: &str,
) -> Result<Vec<Vec<rusqlite::types::Value>>> {
    let projection = reference
        .key
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<String>>()
        .join(", ");
    let mut predicate = format!("\"{}\" = ?1", reference.column);
    if let Some(type_column) = reference.type_column.as_deref() {
        predicate.push_str(&format!(" AND \"{type_column}\" = ?2"));
    }
    if let Some(scope) = reference.predicate.as_deref() {
        predicate.push_str(&format!(" AND {scope}"));
    }
    let sql = format!(
        "SELECT {projection} FROM \"{}\" WHERE {predicate}",
        reference.table
    );
    let mut prepared = connection.prepare(&sql)?;
    let width = reference.key.len();
    let map = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Vec<rusqlite::types::Value>> {
        (0..width).map(|at| row.get(at)).collect()
    };
    let rows = if reference.type_column.is_some() {
        prepared.query_map(rusqlite::params![merged, PARTY_ENTITY_TYPE], map)?
    } else {
        prepared.query_map([merged], map)?
    };
    Ok(rows.collect::<std::result::Result<Vec<Vec<rusqlite::types::Value>>, _>>()?)
}

/// The logical entity name a party carries in every polymorphic pointer.
const PARTY_ENTITY_TYPE: &str = "core.party";

/// `people_profile.party_id` is UNIQUE, so the generic re-point would DELETE
/// the duplicate's cadence, last-contacted and colour. Fold them first (#864).
///
/// The fold's rules, each one chosen so the merge cannot lose a fact:
/// a real cadence beats "no cadence"; the LATER last-contacted wins, because
/// "when did I last speak to them" is one question with one answer; and any
/// other field the survivor lacks is taken from the loser.
fn fold_people_profile(
    connection: &rusqlite::Connection,
    survivor: &str,
    merged: &str,
    now: &str,
) -> Result<()> {
    type Profile = (
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let load = |party_id: &str| -> Option<Profile> {
        connection
            .query_row(
                "SELECT cadence_days, last_contacted_at, avatar_color, role, met
                   FROM people_profile WHERE party_id = ?1",
                [party_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .ok()
    };
    let Some(extra) = load(merged) else {
        return Ok(());
    };
    let Some(kept) = load(survivor) else {
        connection.execute(
            "UPDATE people_profile SET party_id = ?1, updated_at = ?2 WHERE party_id = ?3",
            rusqlite::params![survivor, now, merged],
        )?;
        return Ok(());
    };
    let later = |left: Option<String>, right: Option<String>| -> Option<String> {
        match (left, right) {
            (None, right) => right,
            (left, None) => left,
            (Some(left), Some(right)) => Some(if left >= right { left } else { right }),
        }
    };
    connection.execute(
        "UPDATE people_profile
            SET cadence_days = ?1, last_contacted_at = ?2, avatar_color = ?3,
                role = ?4, met = ?5, updated_at = ?6
          WHERE party_id = ?7",
        rusqlite::params![
            if kept.0 > 0 { kept.0 } else { extra.0 },
            later(kept.1, extra.1),
            kept.2.or(extra.2),
            kept.3.or(extra.3),
            kept.4.or(extra.4),
            now,
            survivor
        ],
    )?;
    connection.execute("DELETE FROM people_profile WHERE party_id = ?1", [merged])?;
    Ok(())
}

/// Fold `merged` into `survivor`, and DELETE the merged party.
///
/// The order is the one that works: the UNIQUE sidecar first, then every
/// reference the sweep found, then the row itself.
pub fn fold_party(
    connection: &rusqlite::Connection,
    survivor: &str,
    merged: &str,
    now: &str,
) -> Result<FoldTally> {
    let mut tally = FoldTally::default();
    fold_people_profile(connection, survivor, merged, now)?;
    for reference in merge_party_sweep(connection)? {
        for key_values in rows_naming(connection, &reference, merged)? {
            repoint_row(
                connection,
                &reference,
                &key_values,
                survivor,
                now,
                &mut tally,
            )?;
        }
    }
    connection.execute("DELETE FROM core_party WHERE party_id = ?1", [merged])?;
    Ok(tally)
}

fn merge_party() -> CommandDefinition {
    CommandDefinition {
        name: "core.merge_party",
        owner_schema: "core",
        input_schema: r#"{
          "type": "object",
          "required": ["survivor_party_id", "merged_party_id"],
          "additionalProperties": false,
          "properties": {
            "survivor_party_id": { "type": "string", "minLength": 1 },
            "merged_party_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Once,
        // TIER 4 (#306): an irreversible merge stays loud on purpose. `risk` is
        // salience; `confirm` is what parks a NON-OWNER invocation.
        risk: Risk::High,
        confirm: true,
        preconditions: &[
            CommandCondition {
                predicate: "two_distinct_live_people",
                check: |ctx| {
                    let survivor = ctx.required_str("survivor_party_id")?;
                    let merged = ctx.required_str("merged_party_id")?;
                    if survivor == merged {
                        return Ok(Some("a person cannot be merged into themselves".to_owned()));
                    }
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_party
                          WHERE party_id IN (?1, ?2) AND kind <> 'agent'",
                        rusqlite::params![survivor, merged],
                        |row| row.get(0),
                    )?;
                    Ok((count != 2).then(|| {
                        "both of those have to be people this vault knows, and neither may be an agent"
                            .to_owned()
                    }))
                },
            },
            CommandCondition {
                // THE VAULT'S OWNER IS NOT MERGEABLE AWAY. Every band of the
                // file hangs off `core_vault.self_party_id`.
                predicate: "merged_is_not_the_owner",
                check: |ctx| {
                    let merged = ctx.required_str("merged_party_id")?;
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_vault WHERE self_party_id = ?1",
                        [merged],
                        |row| row.get(0),
                    )?;
                    Ok((count != 0).then(|| "that is you; you cannot be merged away".to_owned()))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "merged_party_gone",
            check: |ctx| {
                let merged = ctx.required_str("merged_party_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_party WHERE party_id = ?1",
                    [merged],
                    |row| row.get(0),
                )?;
                Ok((count != 0).then(|| "the folded-in person is still there".to_owned()))
            },
        }],
        handler: |ctx| {
            let survivor = ctx.required_str("survivor_party_id")?.to_owned();
            let merged = ctx.required_str("merged_party_id")?.to_owned();
            let tally = fold_party(ctx.connection(), &survivor, &merged, &ctx.now)?;
            Ok(serde_json::json!({
                "survivor_party_id": survivor,
                "repointed": tally.repointed,
                "deduped": tally.deduped,
                "summed": tally.summed,
                "degenerate": tally.degenerate,
                "revoked": tally.revoked,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notation_collapses_case_and_whitespace() {
        assert_eq!(notation_of("  Beach   Day \n"), "beach day");
        assert_eq!(notation_of("BEACH"), "beach");
        assert_eq!(notation_of("   "), "");
    }

    #[test]
    fn every_definition_is_named_under_its_owner_schema_and_has_a_valid_schema() {
        for definition in definitions() {
            assert!(
                definition.name.starts_with("core."),
                "{} is not a core command",
                definition.name
            );
            assert_eq!(definition.owner_schema, "core");
            let schema = serde_json::from_str::<serde_json::Value>(definition.input_schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
            jsonschema::validator_for(&schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
        }
    }

    /// THE TWENTY-FIVE, and the two named absences.
    ///
    /// A schema this build carries part of is a schema whose other part has to
    /// be stated somewhere, or the next lane guesses. It is stated here.
    ///
    /// **The `core` schema arrives in two FILES and is one SCHEMA.** This module
    /// is the parties/tags/documents/folders half (slot 4b, nineteen commands)
    /// plus People's ontology primitive `core.merge_party` — which lives here
    /// because the fold engine it drives is `core`'s own (slot 4c, D-1020-PE2)
    /// — and [`super::core_links`] is the link/attachment half (slot 4c, five),
    /// registered together by [`super::Registry::with_system_commands`], which
    /// is why this test counts the REGISTRY rather than `definitions()`. The
    /// two that remain are `core.merge_entity` and
    /// `core.find_duplicate_parties` (census §A5).
    #[test]
    fn the_schema_carries_twenty_five_of_v0s_twenty_seven() {
        let registry =
            crate::commands::Registry::with_system_commands().expect("the registry builds");
        let names = registry.names();
        let core: Vec<&str> = names
            .iter()
            .copied()
            .filter(|name: &&str| name.starts_with("core."))
            .collect();
        assert_eq!(core.len(), 25, "{core:?}");
        assert_eq!(
            definitions().len(),
            20,
            "this file is still the larger half"
        );
        for landed in [
            "core.link_entities",
            "core.unlink_entities",
            "core.anchor_link",
            "core.attach",
            "core.detach",
            "core.merge_party",
        ] {
            assert!(
                core.contains(&landed),
                "{landed} landed in wave 4 slot 4c and is not registered"
            );
        }
        for absent in [
            // `core.merge_entity` merges two ENTITIES rather than two parties
            // and nothing in this build invokes it; `find_duplicate_parties` is
            // the read half of a surface that does not exist yet.
            "core.merge_entity",
            "core.find_duplicate_parties",
        ] {
            assert!(
                !core.contains(&absent),
                "{absent} is a named absence and is registered here"
            );
        }
    }

    /// The split off v0's own definitions, for the twenty IN THIS FILE.
    ///
    /// v0's whole `core` schema is 17 idempotent / 8 once / 2 retry-safe. Slot
    /// 4c's link half takes two `once` (`link_entities`, `attach`) and three
    /// idempotent (`super::core_links`'s own split test asserts that half), and
    /// `core.merge_party` is the fifth `once` here; the two still absent take
    /// one `once` (`merge_entity`) and one retry-safe. The census reads the
    /// `once` arm as six (`census-wave4.md:47`), and 17 + 6 + 2 is 25 rather
    /// than the 27 the same line states — a census arithmetic slip, filed as a
    /// finding.
    #[test]
    fn the_idempotency_split_matches_v0() {
        let mut idempotent = 0;
        let mut once = 0;
        let mut retry_safe = 0;
        for definition in definitions() {
            match definition.idempotency {
                Idempotency::Idempotent => idempotent += 1,
                Idempotency::Once => once += 1,
                Idempotency::RetrySafe => retry_safe += 1,
            }
        }
        assert_eq!((idempotent, once, retry_safe), (14, 5, 1));
    }

    /// TWO GATES, NEVER ONE (census §A0). Docs' one manifest-confirmed action
    /// is `empty-trash`, and the command behind it deliberately does not carry
    /// the command-level park: `confirm: true` parks a NON-OWNER invocation,
    /// and the owner's confirmation is in front of the command.
    ///
    /// **`core.merge_party` is the schema's one exception in this build**, and
    /// it is the reason the two gates are not one: People's manifest ALSO
    /// declares `confirmation: "required"` on `merge-people`, so the owner sees
    /// a dialog and a non-owner is parked, and neither substitutes for the
    /// other. In v0 the schema has two such commands — the second, `merge_entity`,
    /// is still Notes' slot to take.
    #[test]
    fn merge_party_is_the_only_command_that_parks_a_non_owner() {
        let parked: Vec<&str> = definitions()
            .iter()
            .filter(|definition| definition.confirm)
            .map(|definition| definition.name)
            .collect();
        assert_eq!(parked, ["core.merge_party"]);
        let trash = definitions()
            .into_iter()
            .find(|definition| definition.name == "core.empty_document_trash")
            .expect("the trash command is registered");
        // `risk` is SALIENCE ONLY and never an approval trigger.
        assert_eq!(trash.risk, Risk::High);
        assert!(!trash.confirm);
    }

    #[test]
    fn nothing_here_is_online_only_or_seals_an_input() {
        for definition in definitions() {
            assert!(
                definition.online_only.eq(&false),
                "{} is marked online-only and Docs declares no ONLINE_ONLY_ACTIONS",
                definition.name
            );
            assert!(definition.sealed_input.is_empty(), "{}", definition.name);
        }
    }

    /// THE GRACE WINDOW, in the vault's own spelling. Thirty days, and the
    /// arithmetic is `crate::clock`'s rather than a third private copy.
    #[test]
    fn the_grace_window_is_thirty_days() {
        assert_eq!(
            purge_at("2099-06-01T09:00:00.000Z").expect("an instant"),
            "2099-07-01T09:00:00.000Z"
        );
        assert!(purge_at("not an instant").is_err());
    }

    /// The `data:` URI round trip IS the content id, because the sha is taken
    /// over the decoded bytes and the URI is what gets stored for `text/*`.
    #[test]
    fn a_body_round_trips_through_the_data_uri_encoding() {
        for body in [
            "hello",
            "a lease\nwith lines",
            "ünïcødé and 中文",
            "punctuation: ?&=#%+/",
            "",
        ] {
            let uri = format!(
                "data:text/plain;charset=utf-8,{}",
                encode_uri_component(body)
            );
            let (media_type, bytes) = decode_data_uri(&uri).expect("it decodes");
            assert_eq!(media_type, "text/plain");
            assert_eq!(String::from_utf8(bytes).expect("utf-8"), body);
            // And the FTS feed reads the same text back out of the stored URI.
            assert_eq!(content_text("text/plain", &uri).as_deref(), Some(body));
        }
    }

    /// `+` IS NOT A SPACE. `decodeURIComponent` leaves it alone, and a decoder
    /// that treated it as a space would change the bytes a body hashes to.
    #[test]
    fn a_plus_is_a_plus_and_not_a_space() {
        assert_eq!(percent_decode_utf8("a+b").as_deref(), Some("a+b"));
        assert_eq!(percent_decode_utf8("a%20b").as_deref(), Some("a b"));
        assert_eq!(percent_decode_utf8("a%2").as_deref(), None);
    }

    /// Base64 without padding decodes, because Node's `Buffer.from` does.
    #[test]
    fn base64_is_as_forgiving_as_nodes() {
        assert_eq!(base64_decode("aGk=").as_deref(), Some(&b"hi"[..]));
        assert_eq!(base64_decode("aGk").as_deref(), Some(&b"hi"[..]));
        assert_eq!(base64_decode("aG\nk=").as_deref(), Some(&b"hi"[..]));
    }

    /// NON-TEXT BYTES DO NOT DECODE TO TEXT, and the absence is the answer:
    /// `core_content_text.body_text` is `NOT NULL` because a row exists when a
    /// decode SUCCEEDED, and an empty string would read as an empty document.
    #[test]
    fn only_text_over_a_data_uri_decodes() {
        assert!(content_text("application/pdf", "data:application/pdf;base64,JVBER").is_none());
        assert!(content_text("text/plain", "blob:sha256-00").is_none());
    }

    /// A `blob:` URI is the CAS spelling v0 writes, and a port that spelled it
    /// differently would make every staged document unreadable.
    #[test]
    fn the_cas_uri_is_v0s_spelling() {
        assert_eq!(
            blob_uri_for("ab".repeat(32).as_str()),
            format!("blob:sha256-{}", "ab".repeat(32))
        );
    }
}
