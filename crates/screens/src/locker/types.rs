//! THE ONE LOCKER TYPE TABLE (#1135). What a type is called, what it is drawn
//! with, which columns its form and its page show, and whether a phone creates
//! it — said once. It replaces the copies the Kotlin screens, the SwiftUI and
//! Compose views and the editor each kept: the views draw `type_label`,
//! `type_chip` and `type_key` out of a view state and decide nothing about a
//! type.
//!
//! The ids are the vault's (`centraid_apps_locker::types::ITEM_TYPES`, which is
//! the manifest's enum and the schema's CHECK); a test below pins the table to
//! them so a sixteenth type cannot be added to one and not to the other.

use crate::strings::{Locale, locker as words};

/// How a type reads in words.
pub type Words = fn(Locale) -> String;

/// One item type.
pub struct TypeInfo {
    pub id: &'static str,
    pub label: Words,
    /// The plural a filter chip says ("Logins"); `label` where the filter row
    /// offers no chip of its own.
    pub plural: Words,
    /// A `design/native-catalog.json` icon key.
    pub icon: &'static str,
    /// The six a phone creates.
    pub creatable: bool,
    /// Whether the type's list subtitle is its own (`subtitle_of`): the core
    /// fills every other type's with a type word that beside the label would
    /// read it twice.
    pub subtitled: bool,
    /// The columns the item page and the editor show after the title, in the
    /// order a member reads them.
    pub columns: &'static [&'static str],
}

macro_rules! kind {
    ($id:literal, $label:ident, $plural:ident, $icon:literal, creatable: $creatable:literal, subtitled: $subtitled:literal, $columns:expr) => {
        TypeInfo {
            id: $id,
            label: words::$label,
            plural: words::$plural,
            icon: $icon,
            creatable: $creatable,
            subtitled: $subtitled,
            columns: $columns,
        }
    };
}

/// The fifteen, in the vault's CHECK order.
pub static TYPES: [TypeInfo; 15] = [
    kind!("login", type_login, types_login, "Key", creatable: true, subtitled: true, &["username", "password", "url", "otp_seed", "notes"]),
    kind!("card", type_card, types_card, "Coin", creatable: true, subtitled: false, &["cardholder", "card_number", "expiry", "cvv", "brand"]),
    kind!("note", type_note, types_note, "FileText", creatable: true, subtitled: false, &["content"]),
    kind!("identity", type_identity, types_identity, "User", creatable: true, subtitled: true, &["fullname", "email", "phone", "address"]),
    kind!("wifi", type_wifi, types_wifi, "Wifi", creatable: true, subtitled: true, &["network", "password"]),
    kind!("password", type_password, types_password, "Key", creatable: true, subtitled: false, &["password"]),
    kind!("ssh_key", type_ssh_key, type_ssh_key, "Lock", creatable: false, subtitled: false, &["notes"]),
    kind!("api_credential", type_api_credential, type_api_credential, "Lock", creatable: false, subtitled: false, &["notes"]),
    kind!("passport", type_passport, type_passport, "User", creatable: false, subtitled: false, &["notes"]),
    kind!("bank_account", type_bank_account, type_bank_account, "Coin", creatable: false, subtitled: false, &["notes"]),
    kind!("driving_licence", type_driving_licence, type_driving_licence, "User", creatable: false, subtitled: false, &["notes"]),
    kind!("software_licence", type_software_licence, type_software_licence, "FileText", creatable: false, subtitled: false, &["notes"]),
    kind!("crypto_wallet", type_crypto_wallet, type_crypto_wallet, "Lock", creatable: false, subtitled: false, &["notes"]),
    kind!("membership", type_membership, type_membership, "User", creatable: false, subtitled: false, &["notes"]),
    kind!("document", type_document, type_document, "FileText", creatable: false, subtitled: false, &["notes"]),
];

/// The type `id` names; a type this build does not know reads as a note (the
/// core degrades it the same way, so the id is normally known).
#[must_use]
pub fn of(id: &str) -> &'static TypeInfo {
    TYPES.iter().find(|info| info.id == id).unwrap_or(&TYPES[2])
}

/// The six a phone creates, in picker order.
pub fn creatable() -> impl Iterator<Item = &'static TypeInfo> {
    TYPES.iter().filter(|info| info.creatable)
}

impl TypeInfo {
    /// The chip's two letters, from the type's own word ("Login" → "LO",
    /// "Wi-Fi" → "WI").
    #[must_use]
    pub fn chip(&self, locale: Locale) -> String {
        (self.label)(locale)
            .chars()
            .filter(|character| character.is_alphabetic())
            .take(2)
            .collect::<String>()
            .to_uppercase()
    }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/// The five columns that hold ciphertext under `K`. A secret is revealed per
/// item, per gesture, and receipted; it is never read into a list.
pub const SECRETS: [&str; 5] = ["password", "otp_seed", "card_number", "cvv", "content"];

/// The column whose value is never shown, only the codes it makes.
pub const SEED: &str = "otp_seed";

/// Whether `column` is a sealed cell.
#[must_use]
pub fn is_secret(column: &str) -> bool {
    SECRETS.contains(&column)
}

/// A column's label.
#[must_use]
pub fn label(locale: Locale, column: &str) -> String {
    match column {
        "username" => words::field_username(locale),
        "password" => words::field_password(locale),
        "url" => words::field_url(locale),
        "otp_seed" => words::field_otp(locale),
        "notes" => words::field_notes(locale),
        "cardholder" => words::field_cardholder(locale),
        "card_number" => words::field_card_number(locale),
        "expiry" => words::field_expiry(locale),
        "cvv" => words::field_cvv(locale),
        "brand" => words::field_brand(locale),
        "content" => words::field_content(locale),
        "fullname" => words::field_fullname(locale),
        "email" => words::field_email(locale),
        "phone" => words::field_phone(locale),
        "address" => words::field_address(locale),
        "network" => words::field_network(locale),
        "title" => words::field_title(locale),
        _ => words::field_value(locale),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_is_the_vaults_fifteen_in_the_vaults_order() {
        let ids: Vec<&str> = TYPES.iter().map(|info| info.id).collect();
        assert_eq!(ids, centraid_apps_locker::types::ITEM_TYPES);
    }

    #[test]
    fn a_phone_creates_the_six_that_own_columns() {
        let ids: Vec<&str> = creatable().map(|info| info.id).collect();
        assert_eq!(
            ids,
            ["login", "card", "note", "identity", "wifi", "password"]
        );
    }

    #[test]
    fn every_secret_column_belongs_to_some_type_or_is_a_note() {
        for secret in SECRETS {
            assert!(
                TYPES.iter().any(|info| info.columns.contains(&secret)),
                "{secret}"
            );
        }
    }

    #[test]
    fn the_chip_is_two_letters_of_the_types_word() {
        assert_eq!(of("login").chip(Locale::En), "LO");
        assert_eq!(of("wifi").chip(Locale::En), "WI");
        assert_eq!(of("nonsense").id, "note");
    }
}
