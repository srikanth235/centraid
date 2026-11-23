//! The `locker.*` commands — what involves a secret or Locker's own structure,
//! plus the three stamps the core's session writes (#1020, D-1020-L1…L7; #1047;
//! #1146).
//!
//! ## The one sentence this whole file follows from
//!
//! *Locker secret cells are sealed under a key `K` this crate never holds.*
//! `K` is the 24 words' own leaf, derived by the core and kept in its memory
//! (#1047, D-6); the command plane sees only ciphertext and the generation id
//! it was sealed under. So every command below **cannot read a secret and
//! cannot write one in the clear either**, and the shape that falls out is not
//! a detail:
//!
//! ### 1. A secret arrives as CIPHERTEXT, and plaintext is a typed refusal
//!
//! In v0 `locker.add_item` took a plaintext `password` and a seal sweep
//! encrypted it. There is no sweep here, because there is no `K` here. The
//! core's Locker session (`crates/core/src/locker/phone.rs`, `seal_command`)
//! encrypts the member's input under `K` before the command runs, so what
//! reaches this file is `lk1:<base64>` plus the `key_id` it was sealed under;
//! [`assert_sealed_cell`] refuses anything else **by construction rather than
//! by policy** — a plaintext password reaching this file would be a secret in
//! the vault's file, its WAL, and the backup ranges
//! the laptop's gateway stores, which is the property
//! `tests/locker_plaintext_gate.rs` searches for. The refusal is
//! [`crate::error::VaultError::InvalidInput`] naming the cell, and the value
//! never reaches a message.
//!
//! `assert_live_locker_key_id` is the second half: a write sealed under a
//! generation that is not the vault's one is refused with *"re-enter this
//! secret"*, because the command plane **cannot** decrypt the intent in order
//! to re-encrypt it.
//!
//! ### 2. The caller mints the id of any row that carries a secret (D-1020-L9)
//!
//! `AAD = rowId ‖ keyId`. That is what stops a ciphertext being moved between
//! rows — and it means whoever encrypts must already know the row's id. The
//! command plane mints ids for other new rows; for a secret-bearing row it
//! cannot, because the core seals against the id before the row exists.
//!
//! Three options were weighed (D-1020-L9):
//!
//! - **(a) two commands**: the vault mints the row, the caller fills the
//!   secret with a second call. Rejected: an interrupted duplicate leaves a
//!   copy of a login with no password, which is a locker item that looks
//!   complete and is not.
//! - **(b) the vault mints the id and returns it, the caller seals, the vault
//!   rewrites.** Same window, one more round trip.
//! - **(c) the caller mints the id** and sends it with the ciphertext.
//!   Adopted. `seal_command` refuses a secret with no `item_id` to seal
//!   against, and [`assert_fresh_id`] refuses one that is taken or malformed —
//!   so the vault keeps the property that matters (no id collision, no id reuse
//!   across kinds: the id is an `entity` id, and `entity.id` is unique).
//!
//! ### 3. A derivation over secrets leaves the command plane; its STAMP does not
//!
//! `locker.totp_code` unsealed the seed inside v0's server. Here it stamps the
//! item as used and answers the item and the period; the digits are
//! `crates/core::locker::phone`'s, over a seed only a core holding `K` can
//! open, computed after this stamp lands (D-1020-L6, Q-1047-16). v0's `locker.watchtower`, which unsealed every password to
//! score weak and reused, is deleted rather than moved (Q-1047-16): nothing
//! on the phone scores them.
//!
//! `locker.export` moves the same way and for the same reason — and keeps
//! `confirm: true` and `risk: high`, because what it authorises is still the
//! mass unseal of everything the locker holds. It stamps no item: a file is not
//! a use of any one of them.
//!
//! ### 4. Three commands are the core's, because the reveal and the unlock are
//!
//! The Locker keeps no access log (#1146): what remains of one is a stamp on
//! the item and a count on the key, each written by a command the core runs
//! BEFORE it opens a cell or loads `K`, so a stamp that did not land is an
//! error and no plaintext exists (D-1020-L3).
//!
//! - [`mark_used`]: a reveal in the core stamps `locker_item.last_used_at`.
//!   A use is not an edit — the entity's `updated_at` stays,
//!   no version is kept, and nothing re-indexes.
//! - [`mark_unlocked`] and [`mark_unlock_failed`]: the unlock's two outcomes,
//!   on `locker_key`. A failure is its own command because the unlock it
//!   describes was refused, and a refusal writes nothing; a success resets the
//!   count and answers what it cleared.
//!
//! #1020's second add, `locker.rotate_key` (rotation's step 2 across seats,
//! D-1020-L4), is deleted (#1047 slice D1): `K` is the seed's single leaf, so
//! there is no `K′` for a rotation to move to.
//!
//! ## A Locker item is an entity of its own kind (#1135)
//!
//! `entity.id` is the item's id; its title, stamps and trash window are the
//! entity's, and its kind row `locker_item` holds the typed columns and the
//! five sealed cells. So the lifecycle is the vault's, one implementation for
//! every kind: **trash, restore, purge, empty trash** are `entity.*`, the
//! **star and the archive** are `flag.*`, and an item's **tags** are vault
//! tags (`tag.*`, `tagged` edges). This file keeps only what involves a secret
//! or Locker's own structure: the item's fields, sealed fields, passkeys,
//! aliases, addresses, one-time codes, import, export, duplicate, counts and
//! the three stamps.
//!
//! What follows from that, and is worth saying:
//!
//! - Trash wins over archive, as for every kind. An archived item can be
//!   trashed, and a restore returns it to the archive.
//! - A restore refuses a **lapsed** window (#916 review 1.5), in `entity.restore`.
//! - `entity.purge` deletes an item's sidecars **explicitly** rather than
//!   trusting `ON DELETE CASCADE`, because a cascade fires no `AFTER DELETE`
//!   trigger unless `recursive_triggers` is on, so an offline phone would keep
//!   rows whose item is gone. A purge confirms and presents the same for every
//!   kind (`Risk::Medium`, `confirm`).
//! - **No entity-wide reader carries a sealed cell**: no command's input is
//!   stored, and a message scrubs the five cells (and a duplicate's `fields[].value`) out; a Locker item's
//!   history keeps a sealed cell only as the `lk1:` ciphertext it is, masked on read (`crate::history`), `text_of` indexes the plain fields only, a page over `entity`
//!   or `edge` serves the item's plain rows and no sealed column. The chat's
//!   assistant is the member's principal and meets the same wall: a sealed
//!   value is a channel its door and runtime keep closed, not an authority
//!   the vault withholds.

mod custody;
mod items;
pub mod schema;
mod sidecars;

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::Result;

pub use schema::{
    ALL_FIELDS, FIELD_KINDS, ITEM_TYPES, SEALED_ITEM_CELLS, SEALED_PLACEHOLDER, is_sealed_kind,
    secret_cells, type_fields,
};

use custody::{invalid, mark_unlock_failed, mark_unlocked, mark_used, totp_code};
use items::{add_item, counts, duplicate_item, edit_item, export};
use sidecars::{
    clear_passkey, remove_field, set_addresses_command, set_field, set_memo, set_passkey,
};

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

// ---------------------------------------------------------------------------
// The catalogue.
// ---------------------------------------------------------------------------

/// Every `locker.*` command this build carries: what involves a secret or
/// Locker's own structure, plus the three stamps the core's session writes.
/// Trash, restore, purge, star, archive and tags are the vault's shared verbs
/// (`entity.*`, `flag.*`, `tag.*`).
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        add_item(),
        edit_item(),
        totp_code(),
        set_memo(),
        duplicate_item(),
        set_field(),
        remove_field(),
        set_addresses_command(),
        set_passkey(),
        clear_passkey(),
        counts(),
        export(),
        // The three the core's session needs (#1146).
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

fn item_id_output(item_id: &str) -> serde_json::Value {
    serde_json::json!({ "item_id": item_id })
}

#[cfg(test)]
mod tests {
    use super::custody::assert_sealed_cell;
    use super::schema::template_for;
    use super::*;

    /// THE THREE LISTS THAT MUST AGREE, and the one that is the schema's.
    ///
    /// `ITEM_TYPES` is the CHECK constraint's list; the `add_item` schema's
    /// enum is the door's; `type_fields` decides which columns each type owns.
    /// This is the leg of the tripwire that `crates/apps/locker` cannot hold,
    /// because reading a DDL statement belongs in the layer that owns one
    /// (`sql-confinement`).
    #[test]
    fn the_type_list_is_the_check_constraints_and_the_doors() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("contracts/schema/vault-ddl.sql");
        let ddl = std::fs::read_to_string(&path).expect("the committed DDL");
        let check = ddl
            .split("locker_item (")
            .nth(1)
            .expect("the DDL declares locker_item")
            .split("CHECK (type IN (")
            .nth(1)
            .expect("locker_item CHECKs its type")
            .split("))")
            .next()
            .expect("the CHECK closes");
        let declared: Vec<String> = check
            .split(',')
            .map(|value| value.trim().trim_matches('\'').trim().to_owned())
            .filter(|value| !value.is_empty())
            .collect();
        assert_eq!(declared, ITEM_TYPES.map(str::to_owned).to_vec());

        // And the door's own enum is the same set.
        let schema: serde_json::Value =
            serde_json::from_str(add_item().input_schema).expect("the schema is JSON");
        let door: Vec<String> = schema["properties"]["type"]["enum"]
            .as_array()
            .expect("an enum")
            .iter()
            .map(|value| value.as_str().expect("a string").to_owned())
            .collect();
        assert_eq!(door, ITEM_TYPES.map(str::to_owned).to_vec());

        // Every type owns only columns that exist, and the nine own exactly
        // the memo.
        for item_type in ITEM_TYPES {
            for column in type_fields(item_type) {
                assert!(
                    ALL_FIELDS.contains(column),
                    "{item_type} claims the column {column}, which is not one"
                );
            }
        }
        for item_type in &ITEM_TYPES[6..] {
            assert_eq!(type_fields(item_type), ["notes"], "{item_type}");
            assert!(
                !template_for(item_type).is_empty(),
                "{item_type} owns no columns and has no template either"
            );
        }
    }

    /// Every command's input schema is valid JSON and refuses an unlisted
    /// property. `additionalProperties: false` is what stops a caller
    /// inventing a column, and a schema that forgot it is a door that takes
    /// anything.
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

    /// THE STRUCTURAL GUARD, at the boundary. A plaintext that merely begins
    /// `lk1:` is not ciphertext, which is why the predicate is structural and
    /// not a `starts_with`.
    #[test]
    fn only_real_ciphertext_and_the_placeholder_pass_the_cell_guard() {
        assert!(assert_sealed_cell("password", None).is_ok());
        assert!(assert_sealed_cell("password", Some("")).is_ok());
        assert!(assert_sealed_cell("password", Some(SEALED_PLACEHOLDER)).is_ok());
        assert!(assert_sealed_cell("password", Some("correct-horse")).is_err());
        // The bare prefix is the attack the structural predicate exists for: a
        // member password beginning `lk1:` must be SEALED, not stored verbatim
        // as "already sealed".
        assert!(assert_sealed_cell("password", Some("lk1:hunter2")).is_err());

        use base64::Engine as _;
        let body = base64::engine::general_purpose::STANDARD.encode([0_u8; 36]);
        assert!(assert_sealed_cell("password", Some(&format!("lk1:{body}"))).is_ok());
    }

    #[test]
    fn the_template_types_seal_only_the_value_that_is_the_credential() {
        // A passport's number is sealed; the holder's name is not, because
        // sealing metadata costs the browsable half for nothing.
        let passport = template_for("passport");
        let sealed: Vec<&str> = passport
            .iter()
            .filter(|(_, _, kind)| *kind == "sealed")
            .map(|(_, label, _)| *label)
            .collect();
        assert_eq!(sealed, ["Passport number"]);
        // A crypto wallet is the other end: three of six are the credential.
        assert_eq!(
            template_for("crypto_wallet")
                .iter()
                .filter(|(_, _, kind)| *kind == "sealed")
                .count(),
            3
        );
        // A type this build does not know has no template, which is what lets
        // it degrade to a note rather than to nothing.
        assert!(template_for("quantum_key").is_empty());
    }

    #[test]
    fn secret_cells_are_exactly_the_sealed_columns_each_type_owns() {
        for item_type in ITEM_TYPES {
            let expected: Vec<&str> = type_fields(item_type)
                .iter()
                .copied()
                .filter(|col| SEALED_ITEM_CELLS.contains(col))
                .collect();
            assert_eq!(secret_cells(item_type), expected.as_slice(), "{item_type}");
        }
        assert!(secret_cells("quantum_key").is_empty());
    }
}
