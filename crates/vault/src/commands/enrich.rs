//! **ONE COMMAND ONLY: `enrich.request_enrichment`.**
//!
//! The `enrich` schema is the automations lane's for wave 4 slot 4b — nine
//! commands, eight of them `retry-safe`, and every one of them a writer of the
//! recognition plane. This file holds exactly the one an APP invokes, because
//! `request-enrichment` is the only action in any of the eight apps that writes
//! to `enrich` (census §A2) and Photos' lane could not land its action table
//! without it. **Adding a second definition here belongs to the automations
//! lane**, in `crates/vault/src/commands/enrich.rs` — this file — so the two
//! halves meet in one place rather than in two files under one schema.
//!
//! ## `enrich_request` is a PRIORITY HINT, never a gate
//!
//! `docs/recognition-automations.md:37`: a recipe with an empty queue still
//! walks the library behind its cursor. A port that treated the queue as the
//! work list would stop recognition for every vault that had never pressed the
//! button. So this command writes one row and moves nothing else; the walk is
//! the automations lane's, and `a_hint_is_a_row_and_nothing_else` is the test.
//!
//! ## The capability is the CONSENT SCOPE and `manual` requires it
//!
//! Before `enrich_request` carried a capability, the owner's on-demand ask was
//! untagged, so one face-detection consent handed the same queue row to every
//! enabled enricher and each read the member's "detect faces" as its own
//! permission. The column's own CHECK enforces the vocabulary; refusing here
//! buys the caller a sentence instead of a constraint name.
//!
//! ## What this command deliberately does NOT do, and who owns it
//!
//! v0's handler also RE-KEYS A CONSENT ANSWER (#807): a `manual` request is the
//! member's answer to a consent moment, so v0 records `capability × on-device`
//! as granted in the consent plane and stamps `share.authority`
//! (`packages/vault/src/commands/enrich.ts:489-506`). That plane has no Rust
//! home yet and it is the automations lane's, not this one's: writing half of
//! it — a consent row with no reader — would be worse than writing none.
//! Named as a coordination point for slot 4b in the Photos lane's receipt, and
//! the manifest's `writes` for `request-enrichment` still declares
//! `share.authority`, which is how the gap stays visible.

use crate::commands::{CommandCondition, CommandDefinition, Idempotency, Risk};
use crate::error::VaultError;

/// The reasons an owner-facing caller may give. `projected` is minted by the
/// vault itself during share ingest and is deliberately absent here.
const CALLER_REASONS: &[&str] = &["search-miss", "on-view", "manual"];

/// Every `enrich.*` command this build carries. One, for now; see the header.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![request_enrichment()]
}

fn request_enrichment() -> CommandDefinition {
    CommandDefinition {
        name: "enrich.request_enrichment",
        owner_schema: "enrich",
        input_schema: r#"{
          "type": "object",
          "required": ["entity_type", "reason"],
          "additionalProperties": false,
          "properties": {
            "entity_type": { "type": "string", "minLength": 1 },
            "entity_id": { "type": "string", "minLength": 1 },
            "reason": { "type": "string", "enum": ["search-miss", "on-view", "manual"] },
            "detail": { "type": "string" },
            "capability": { "type": "string", "minLength": 1, "maxLength": 64 }
          }
        }"#,
        // RETRY-SAFE: a hint written twice is one queue that moved sooner
        // twice, which is the same queue.
        idempotency: Idempotency::RetrySafe,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "manual_names_its_capability",
            check: |ctx| {
                if ctx.required_str("reason")? != "manual" {
                    return Ok(None);
                }
                Ok(ctx.optional_str("capability").is_none().then(|| {
                    "an owner's \"do this now\" must name the capability it is asking for — an \
                     untagged ask would read as consent for every enricher, not the one the \
                     member chose"
                        .to_owned()
                }))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "request_recorded",
            check: |ctx| {
                let request_id = ctx
                    .produced_ids
                    .borrow()
                    .first()
                    .cloned()
                    .unwrap_or_default();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM enrich_request WHERE request_id = ?1",
                    [&request_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the request was not recorded".to_owned()))
            },
        }],
        handler: |ctx| {
            let entity_type = ctx.required_str("entity_type")?.to_owned();
            let reason = ctx.required_str("reason")?.to_owned();
            if !CALLER_REASONS.contains(&reason.as_str()) {
                return Err(VaultError::InvalidInput {
                    name: "reason".to_owned(),
                    detail: format!("`{reason}` is not a reason a caller may give"),
                });
            }
            let request_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO enrich_request
                   (request_id, target_type, target_id, reason, detail, capability,
                    requested_at, drained_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
                rusqlite::params![
                    request_id,
                    entity_type,
                    ctx.optional_str("entity_id"),
                    reason,
                    ctx.optional_str("detail"),
                    ctx.optional_str("capability"),
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({ "request_id": request_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_one_definition_is_named_under_its_owner_schema() {
        let definitions = definitions();
        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0].name, "enrich.request_enrichment");
        assert_eq!(definitions[0].owner_schema, "enrich");
        assert_eq!(definitions[0].idempotency, Idempotency::RetrySafe);
        serde_json::from_str::<serde_json::Value>(definitions[0].input_schema)
            .expect("the schema is JSON");
    }

    /// The caller's vocabulary is three reasons. `projected` is the vault's own
    /// and always carries a NULL capability, so a caller that could send it
    /// would be minting a row the device lane must not lease.
    #[test]
    fn projected_is_not_a_reason_a_caller_may_give() {
        let schema: serde_json::Value =
            serde_json::from_str(definitions()[0].input_schema).expect("JSON");
        let reasons = schema["properties"]["reason"]["enum"]
            .as_array()
            .expect("an enum");
        assert_eq!(reasons.len(), 3);
        assert!(!reasons.iter().any(|value| value == "projected"));
        assert_eq!(CALLER_REASONS.len(), 3);
    }
}
