//! THE FIFTEEN ITEM TYPES, and the degradation rule that keeps a sixteenth
//! renderable.
//!
//! Ported from `packages/blueprints/apps/locker/queries/type-degradation.ts`
//! and `types.ts`, whose list is pinned to the schema's own CHECK constraint by
//! `locker-item-type.test.ts`.
//!
//! *A type is a set of sections and fields, so a type the vault does not have
//! yet degrades to a note with custom fields rather than to nothing.* The vault
//! enforces its list with a CHECK; this is the read side of the same rule, and
//! it exists because a vault restored from a **newer build** — or one an
//! assistant wrote an unfamiliar type into — must still render. Every
//! type-specific value already lives in `locker_item_field`, so the only thing
//! an unrecognised type loses is the word on its chip.
//!
//! Nine of the fifteen (`ssh_key` onward) own **no columns of their own**
//! (#872): they are templates of sections and fields, minted into
//! `locker_item_field` by `locker.add_item`. That is the same mechanism the
//! degradation relies on, which is why the rule works at all.

/// The fifteen, in the CHECK constraint's own order.
pub const ITEM_TYPES: [&str; 15] = [
    "login",
    "card",
    "note",
    "identity",
    "wifi",
    "password",
    "ssh_key",
    "api_credential",
    "passport",
    "bank_account",
    "driving_licence",
    "software_licence",
    "crypto_wallet",
    "membership",
    "document",
];

/// What an unknown type reads as.
pub const DEGRADED_TYPE: &str = "note";

/// The entity type a Locker item is, in the revision and tag planes.
pub const ITEM_ENTITY_TYPE: &str = "locker.item";

/// The receipt object type an *unlock* is recorded under, beside
/// `locker.item`. Both are named by the `access` query's two walls.
pub const AUTH_ENTITY_TYPE: &str = "locker.auth";

#[must_use]
pub fn is_known_type(item_type: &str) -> bool {
    ITEM_TYPES.contains(&item_type)
}

/// An unknown type reads as a note. Its custom fields come through intact.
#[must_use]
pub fn degrade_type(item_type: &str) -> &str {
    if is_known_type(item_type) {
        item_type
    } else {
        DEGRADED_TYPE
    }
}

/// What the item pane shows a type *was*, when it degraded. `None` when the
/// type is known — v0's `degraded_from` (`queries/item.ts`).
#[must_use]
pub fn degraded_from(item_type: &str) -> Option<&str> {
    if is_known_type(item_type) {
        None
    } else {
        Some(item_type)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_type_reads_as_a_note_and_says_what_it_was() {
        assert_eq!(degrade_type("login"), "login");
        assert_eq!(degraded_from("login"), None);
        assert_eq!(degrade_type("quantum_key"), "note");
        assert_eq!(degraded_from("quantum_key"), Some("quantum_key"));
    }

    /// The list is the MANIFEST's, and the manifest's is the schema's.
    ///
    /// `add-item` declares `type: {enum: [...LOCKER_ITEM_TYPES]}`, so the
    /// manifest is this crate's own source of truth and this assertion keeps
    /// the Rust list pinned to it. The other half of the chain — the manifest's
    /// enum against `locker_item`'s CHECK constraint — is asserted in
    /// `crates/vault`, where reading a DDL statement is in the layer that owns
    /// one: this crate holds no SQL and no locator into any
    /// (`cargo xtask rules`' `sql-confinement`), and v0 pins the same pair from
    /// its own side in `locker-item-type.test.ts`.
    #[test]
    fn the_type_list_matches_the_manifests_own_enum() {
        let raw: serde_json::Value =
            serde_json::from_str(crate::manifest::MANIFEST_JSON).expect("the manifest is JSON");
        let declared = raw["actions"]
            .as_array()
            .expect("the manifest declares actions")
            .iter()
            .find(|action| action["name"] == "add-item")
            .expect("the manifest declares add-item")["input"]["properties"]["type"]["enum"]
            .as_array()
            .expect("add-item's type is an enum")
            .iter()
            .map(|value| value.as_str().expect("a string").to_owned())
            .collect::<Vec<String>>();
        assert_eq!(declared, ITEM_TYPES.map(str::to_owned).to_vec());
    }

    #[test]
    fn nine_of_the_fifteen_own_no_columns_of_their_own() {
        // The six that do: login, card, note, identity, wifi, password.
        let column_owning = &ITEM_TYPES[..6];
        assert_eq!(
            column_owning,
            ["login", "card", "note", "identity", "wifi", "password"]
        );
        assert_eq!(ITEM_TYPES.len() - column_owning.len(), 9);
    }
}
