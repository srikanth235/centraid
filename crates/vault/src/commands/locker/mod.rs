//! The `locker.*` commands: Locker is an app like every other, and what differs is sealing
//! (#1214, K).
//!
//! A Locker item is an entity of kind `locker_item`: its title, stamps, trash, star, archive,
//! tags, links, `[[title]]` and attachments are the vault's shared verbs and rows, with no Locker
//! branch anywhere (an attached scan or photo is an ordinary document or photo). Exactly four
//! tables hold the rest: `locker_item` (the type, the compromised flag, the last use),
//! `locker_item_field` (every value: built-in, template and custom, addresses, aliases and the
//! memo included), `locker_item_passkey` and `locker_key`.
//!
//! ## The one sentence the differences follow from
//!
//! *A sealed value is ciphertext under a key `K` this crate never holds.* `K` is the 24 words' own
//! leaf, derived by the core and kept in its memory; the command plane sees only `lk1:` ciphertext
//! and the generation id it was sealed under. So no command here can read a secret, and none can
//! write one in the clear: [`custody::assert_sealed_cell`] refuses anything else, and a refusal's
//! sentence never quotes the value. Sealed values (a secret, a one-time-code seed, a file's bytes
//! and its sealed name, a passkey's private key) are never indexed, never turned into derived
//! data, never written in plaintext, and are kept sealed in every earlier version; the core opens
//! them only behind the member's unlock. A secret's age is its field's `value_set_at`, which moves
//! only when the value changes (the vault cannot compare ciphertexts, so the caller says whether
//! it did).
//!
//! The caller mints the id a sealed value is bound to (`AAD = row id ‖ key id`): a single-instance
//! built-in field's is `<item id>:<field key>` ([`schema::field_id_of`]), so the core can seal
//! against it before the row exists.
//!
//! ## The reads and the stamps
//!
//! The core's session runs three stamps BEFORE it opens a cell or loads `K`, so a stamp that did
//! not land is an error and no plaintext exists: [`mark_used`] (a use is not an edit: no revision,
//! no `updated_at`), and the two outcomes of an unlock on `locker_key`. `locker.totp_code` is the
//! stamp of a code the core computes. [`reads`] holds what the autofill and passkey sign-in ask.

mod custody;
mod fields;
mod items;
mod passkeys;
pub mod reads;
pub mod schema;

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::Result;

pub use fields::{PLAIN_VALUE_BUDGET_BYTES, SEALED_VALUE_BUDGET_BYTES};
pub use schema::{
    BuiltIn, FIELD_KINDS, ITEM_TYPES, SEALED_PLACEHOLDER, built_in, built_ins, expiry_display,
    field_id_of, is_sealed_kind, normalise_date, secret_keys, secret_keys_of,
};

use custody::{invalid, mark_unlock_failed, mark_unlocked, mark_used, totp_code};
use fields::{remove_field, set_field};
use items::{add_item, counts, duplicate_item, edit_item, export};
use passkeys::{remove_passkey, set_passkey};

// ---------------------------------------------------------------------------
// Small helpers over the file.
// ---------------------------------------------------------------------------

fn count(ctx: &CommandCtx<'_, '_>, sql: &str, params: &[&str]) -> Result<i64> {
    let values: Vec<&dyn rusqlite::ToSql> = params
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect();
    Ok(ctx
        .connection()
        .query_row(sql, values.as_slice(), |row| row.get(0))?)
}

fn item_type_of(ctx: &CommandCtx<'_, '_>, item_id: &str) -> Result<String> {
    ctx.connection()
        .query_row(
            "SELECT type FROM locker_item WHERE id = ?1",
            [item_id],
            |row| row.get(0),
        )
        .map_err(|_| invalid("item_id", "there is no locker item with that id"))
}

/// Every `locker.*` command this build carries. Trash, restore, purge, star, archive, tags,
/// links and reminders on a date field are the vault's shared verbs (`entity.*`, `tag.*`,
/// `link.add`, `edge.add`, `reminder.add`).
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        add_item(),
        edit_item(),
        duplicate_item(),
        set_field(),
        remove_field(),
        set_passkey(),
        remove_passkey(),
        totp_code(),
        counts(),
        export(),
        mark_used(),
        mark_unlocked(),
        mark_unlock_failed(),
    ]
}

fn definition(
    name: &'static str,
    input_schema: &'static str,
    idempotency: Idempotency,
    preconditions: &'static [CommandCondition],
    postconditions: &'static [CommandCondition],
    handler: crate::commands::CommandHandler,
) -> CommandDefinition {
    CommandDefinition {
        name,
        owner_schema: "locker",
        input_schema,
        idempotency,
        risk: Risk::Low,
        confirm: false,
        preconditions,
        postconditions,
        handler,
        sealed_input: &[],
    }
}

#[cfg(test)]
mod tests {
    use super::custody::assert_sealed_cell;
    use super::*;

    /// The door's own type enum is the lookup's set.
    #[test]
    fn the_doors_type_enum_is_the_type_list() {
        let schema: serde_json::Value =
            serde_json::from_str(add_item().input_schema).expect("the schema is JSON");
        let door: Vec<String> = schema["properties"]["type"]["enum"]
            .as_array()
            .expect("an enum")
            .iter()
            .map(|value| value.as_str().expect("a string").to_owned())
            .collect();
        assert_eq!(door, ITEM_TYPES.map(str::to_owned).to_vec());
    }

    /// Every command's input schema is valid JSON and refuses an unlisted property.
    #[test]
    fn every_input_schema_is_closed() {
        for definition in definitions() {
            let schema: serde_json::Value = serde_json::from_str(definition.input_schema)
                .unwrap_or_else(|error| {
                    panic!("{}'s input schema is not JSON: {error}", definition.name)
                });
            assert_eq!(
                schema["additionalProperties"],
                serde_json::json!(false),
                "{} takes properties it does not declare",
                definition.name
            );
        }
    }

    /// A plaintext that merely begins `lk1:` is not ciphertext.
    #[test]
    fn only_real_ciphertext_and_the_placeholder_pass_the_cell_guard() {
        assert!(assert_sealed_cell("password", None).is_ok());
        assert!(assert_sealed_cell("password", Some("")).is_ok());
        assert!(assert_sealed_cell("password", Some(SEALED_PLACEHOLDER)).is_ok());
        assert!(assert_sealed_cell("password", Some("correct-horse")).is_err());
        assert!(assert_sealed_cell("password", Some("lk1:hunter2")).is_err());

        use base64::Engine as _;
        let body = base64::engine::general_purpose::STANDARD.encode([0_u8; 36]);
        assert!(assert_sealed_cell("password", Some(&format!("lk1:{body}"))).is_ok());
    }
}
