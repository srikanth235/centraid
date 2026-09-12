//! The 23 `tally.*` commands, as SKELETONS for lane D3 to fill.
//!
//! Every one is registered with its real name, its real input schema from v0's
//! catalogue, its real idempotency class and its real risk — and a handler that
//! returns `VaultError::NotImplemented`. That is deliberate and it is not a
//! placeholder in the usual sense:
//!
//! - **The registry is complete from the first commit.** Lane D3 fills bodies
//!   without touching `Registry`, `execute` or the gate order, and lane R can
//!   drive a command door that knows every name the product has.
//! - **The schemas are already the contract.** A stub whose schema is `{}`
//!   would let a caller send anything and discover the shape only when the body
//!   landed; these refuse a malformed input today, with the same message they
//!   will refuse it with when the handler is real.
//! - **`NotImplemented` is a typed error, not a panic**, so a shell can render
//!   "not in this build yet" rather than losing the process.
//!
//! Input shapes are transcribed from `census-wave2-apps.md` §2.8, which cites
//! each command's `packages/vault/src/commands/tally*.ts` line. Where the
//! census names a key without a type — `splits`, `payers`, `line_items`,
//! `member_ids`, `split_params`, `override` — the schema admits any JSON:
//! narrowing it here would be lane D3 inventing the shape from the key's name,
//! and a wrong narrow schema is worse than an open one because it refuses a
//! correct call.
//!
//! **`additionalProperties: false` on every one.** An unrecognised key is a
//! caller that believes it asked for something; accepting and ignoring it is
//! how a feature appears to work.

use crate::commands::{CommandDefinition, Idempotency, Risk, not_implemented};

/// One registered-but-empty command.
fn stub(
    name: &'static str,
    input_schema: &'static str,
    idempotency: Idempotency,
    risk: Risk,
    confirm: bool,
) -> CommandDefinition {
    CommandDefinition {
        name,
        owner_schema: "tally",
        input_schema,
        idempotency,
        risk,
        confirm,
        preconditions: &[],
        postconditions: &[],
        handler: not_implemented,
        sealed_input: &[],
        online_only: false,
    }
}

/// Every `tally.*` command in the catalogue.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        stub(
            "tally.add_expense",
            r#"{
          "type": "object",
          "required": ["description", "amount_minor", "paid_by", "category", "splits"],
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 },
            "group_id": { "type": "string", "minLength": 1 },
            "description": { "type": "string", "minLength": 1 },
            "amount_minor": { "type": "integer" },
            "paid_by": { "type": "string", "minLength": 1 },
            "payers": {},
            "spent_on": { "type": "string", "minLength": 1 },
            "category": { "type": "string", "minLength": 1 },
            "splits": {},
            "split_method": { "type": "string", "minLength": 1 },
            "split_params": {},
            "line_items": {}
          }
        }"#,
            Idempotency::Once,
            Risk::Low,
            false,
        ),
        stub(
            "tally.add_friend",
            r#"{
          "type": "object",
          "required": ["name"],
          "additionalProperties": false,
          "properties": {
            "name": { "type": "string", "minLength": 1 },
            "party_id": { "type": "string", "minLength": 1 },
            "email": { "type": "string", "minLength": 1 },
            "phone": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Once,
            Risk::Low,
            false,
        ),
        stub(
            "tally.add_group_member",
            r#"{
          "type": "object",
          "required": ["group_id", "party_id"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "party_id": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.add_receipt_expense",
            r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 },
            "group_id": { "type": "string", "minLength": 1 },
            "description": { "type": "string", "minLength": 1 },
            "amount_minor": { "type": "integer" },
            "paid_by": { "type": "string", "minLength": 1 },
            "payers": {},
            "spent_on": { "type": "string", "minLength": 1 },
            "category": { "type": "string", "minLength": 1 },
            "splits": {},
            "split_params": {},
            "staged_sha": { "type": "string", "minLength": 1 },
            "ocr_text": { "type": "string", "minLength": 1 },
            "line_items": {}
          }
        }"#,
            Idempotency::Once,
            Risk::Low,
            false,
        ),
        stub(
            "tally.archive_group",
            r#"{
          "type": "object",
          "required": ["group_id"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "archived": { "type": "boolean" }
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.bind_txn",
            r#"{
          "type": "object",
          "required": ["txn_id"],
          "additionalProperties": false,
          "properties": {
            "txn_id": { "type": "string", "minLength": 1 },
            "expense_id": { "type": "string", "minLength": 1 },
            "settlement_id": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.create_group",
            r#"{
          "type": "object",
          "required": ["name", "icon", "member_ids"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1 },
            "icon": { "type": "string", "minLength": 1 },
            "color": { "type": "string", "minLength": 1 },
            "currency": { "type": "string", "minLength": 1 },
            "member_ids": {}
          }
        }"#,
            Idempotency::Once,
            Risk::Low,
            false,
        ),
        stub(
            "tally.delete_expense",
            r#"{
          "type": "object",
          "required": ["expense_id"],
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Once,
            Risk::Low,
            false,
        ),
        stub(
            "tally.delete_group",
            r#"{
          "type": "object",
          "required": ["group_id"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Once,
            Risk::Low,
            false,
        ),
        stub(
            "tally.edit_expense",
            r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 },
            "description": { "type": "string", "minLength": 1 },
            "amount_minor": { "type": "integer" },
            "paid_by": { "type": "string", "minLength": 1 },
            "payers": {},
            "spent_on": { "type": "string", "minLength": 1 },
            "category": { "type": "string", "minLength": 1 },
            "splits": {},
            "split_method": { "type": "string", "minLength": 1 },
            "split_params": {},
            "line_items": {}
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.edit_recurring_expense_occurrence",
            r#"{
          "type": "object",
          "required": ["template_id", "original_start_local", "scope", "action"],
          "additionalProperties": false,
          "properties": {
            "template_id": { "type": "string", "minLength": 1 },
            "original_start_local": { "type": "string", "minLength": 1 },
            "scope": { "type": "string", "minLength": 1 },
            "action": { "type": "string", "minLength": 1 },
            "override": {}
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.leave_group",
            r#"{
          "type": "object",
          "required": ["group_id"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "party_id": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.materialize_recurring_expense",
            r#"{
          "type": "object",
          "required": ["template_id", "original_start_local"],
          "additionalProperties": false,
          "properties": {
            "template_id": { "type": "string", "minLength": 1 },
            "original_start_local": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.nudge",
            r#"{
          "type": "object",
          "required": ["party_id", "as_of_minor"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "group_id": { "type": "string", "minLength": 1 },
            "as_of_minor": { "type": "integer" },
            "note": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Once,
            Risk::Low,
            true,
        ),
        stub(
            "tally.reallocate_receipt",
            r#"{
          "type": "object",
          "required": ["expense_id", "line_items", "splits"],
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 },
            "line_items": {},
            "splits": {}
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.remove_group_member",
            r#"{
          "type": "object",
          "required": ["group_id", "party_id"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "party_id": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.rename_group",
            r#"{
          "type": "object",
          "required": ["group_id", "name"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.restore_expense",
            r#"{
          "type": "object",
          "required": ["expense_id"],
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.save_recurring_expense",
            r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "template_id": { "type": "string", "minLength": 1 },
            "group_id": { "type": "string", "minLength": 1 },
            "description": { "type": "string", "minLength": 1 },
            "original_amount_minor": { "type": "integer" },
            "original_currency": { "type": "string", "minLength": 1 },
            "settlement_currency": { "type": "string", "minLength": 1 },
            "paid_by": { "type": "string", "minLength": 1 },
            "category": { "type": "string", "minLength": 1 },
            "splits": {},
            "rrule": { "type": "string", "minLength": 1 },
            "anchor_start": { "type": "string", "minLength": 1 },
            "tz": { "type": "string", "minLength": 1 },
            "rate_scaled": { "type": "integer" },
            "rate_scale": { "type": "integer" },
            "rate_source": { "type": "string", "minLength": 1 },
            "rate_date": { "type": "string", "minLength": 1 },
            "status": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.set_expense_memo",
            r#"{
          "type": "object",
          "required": ["expense_id", "note"],
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 },
            "note": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.set_group_simplification",
            r#"{
          "type": "object",
          "required": ["group_id", "simplify"],
          "additionalProperties": false,
          "properties": {
            "group_id": { "type": "string", "minLength": 1 },
            "simplify": { "type": "boolean" }
          }
        }"#,
            Idempotency::Idempotent,
            Risk::Low,
            false,
        ),
        stub(
            "tally.settle_up",
            r#"{
          "type": "object",
          "required": ["from_party", "to_party", "amount_minor"],
          "additionalProperties": false,
          "properties": {
            "settlement_id": { "type": "string", "minLength": 1 },
            "from_party": { "type": "string", "minLength": 1 },
            "to_party": { "type": "string", "minLength": 1 },
            "amount_minor": { "type": "integer" },
            "currency": { "type": "string", "minLength": 1 },
            "group_id": { "type": "string", "minLength": 1 },
            "paid_on": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Once,
            Risk::Low,
            false,
        ),
        stub(
            "tally.undo_expense",
            r#"{
          "type": "object",
          "required": ["expense_id", "revision_id"],
          "additionalProperties": false,
          "properties": {
            "expense_id": { "type": "string", "minLength": 1 },
            "revision_id": { "type": "string", "minLength": 1 }
          }
        }"#,
            Idempotency::Once,
            Risk::Low,
            false,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_twenty_three_are_here_with_valid_schemas() {
        let definitions = definitions();
        // The catalogue's own count for the tally schema (apps census §2.8).
        assert_eq!(definitions.len(), 23);
        let mut names: Vec<&str> = definitions.iter().map(|entry| entry.name).collect();
        names.sort_unstable();
        let unique = names.len();
        names.dedup();
        assert_eq!(names.len(), unique, "a name is registered twice");
        for definition in &definitions {
            assert!(definition.name.starts_with("tally."));
            assert_eq!(definition.owner_schema, "tally");
            let schema: serde_json::Value = serde_json::from_str(definition.input_schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
            // Every schema is closed, and says so in the fixture rather than
            // relying on a validator default.
            assert_eq!(
                schema.get("additionalProperties"),
                Some(&serde_json::Value::Bool(false)),
                "{} is open",
                definition.name
            );
            assert!(
                jsonschema::validator_for(&schema).is_ok(),
                "{}'s schema does not compile",
                definition.name
            );
        }
    }

    #[test]
    fn the_four_named_by_the_catalogue_carry_their_required_keys() {
        // A spot check against the census rows, so a transcription slip in the
        // required list is caught rather than assumed.
        let by_name: std::collections::BTreeMap<&str, serde_json::Value> = definitions()
            .iter()
            .map(|entry| {
                (
                    entry.name,
                    serde_json::from_str(entry.input_schema).expect("parses"),
                )
            })
            .collect();
        let required = |name: &str| -> Vec<String> {
            by_name[name]["required"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default()
        };
        assert_eq!(required("tally.add_group_member"), ["group_id", "party_id"]);
        assert_eq!(required("tally.rename_group"), ["group_id", "name"]);
        assert_eq!(
            required("tally.settle_up"),
            ["from_party", "to_party", "amount_minor"]
        );
        assert_eq!(
            required("tally.create_group"),
            ["name", "icon", "member_ids"]
        );
    }
}
