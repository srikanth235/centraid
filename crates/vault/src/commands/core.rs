//! The three `core.*` commands that prove the pipeline end to end.
//!
//! `core.add_party`, `core.update_party` and `core.tag_item`, with v0's input
//! shapes. Three rather than thirty because the thing under test is the GATE
//! ORDER, the capture and the receipt chain — and a fourth command of the same
//! shape adds no evidence about any of them. The other 171 land with their
//! apps' lanes.
//!
//! ### What is narrowed, and why (D-1020-D1-14)
//!
//! `core.add_party` accepts v0's `identifiers` array, whose schema admits
//! `email` and `tel`. v0 routes those to `social.save_contact_channel` through
//! `bindContactReach`, because **an address you can reach a person at is a
//! channel, not an identity-register entry** (#883, ruling O-contact) — and
//! `core_party_identifier`'s own CHECK refuses them. The contact-reach plane is
//! the People lane's, so here a reach scheme is REFUSED with a sentence naming
//! the command that takes it, rather than silently dropped. A dropped
//! identifier is the failure mode this avoids: the app believes it bound an
//! email and nothing did.

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

/// Every `core.*` command this build carries.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![add_party(), update_party(), tag_item()]
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
fn actor_party_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
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
    fn the_three_definitions_are_named_under_their_owner_schema() {
        for definition in definitions() {
            assert!(
                definition.name.starts_with("core."),
                "{} is not a core command",
                definition.name
            );
            assert_eq!(definition.owner_schema, "core");
            serde_json::from_str::<serde_json::Value>(definition.input_schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
        }
    }
}
