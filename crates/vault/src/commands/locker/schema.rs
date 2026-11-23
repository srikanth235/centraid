//! Locker item types, columns, sealed cells, and templates — the ONE schema
//! metadata module read by vault commands, custody re-keying, history masking,
//! and `centraid-apps-locker` (via `centraid-apps-kit::rules::locker`).

use crate::commands::CommandCtx;

/// The five `locker_item` cells that hold ciphertext under `K`.
pub const SEALED_ITEM_CELLS: [&str; 5] = ["password", "otp_seed", "card_number", "cvv", "content"];

/// The vault's placeholder. Round-tripped, it means **leave the secret
/// alone** — which is what lets an edit form exist without ever holding the
/// password (#293).
pub const SEALED_PLACEHOLDER: &str = "«sealed»";

/// The fifteen item types, the CHECK constraint's own order.
///
/// Public because it is the SCHEMA's list and three doors have to agree with
/// it: this catalogue's `add_item` enum, `locker_item`'s CHECK, and the app
/// crate's own degradation list. `the_type_list_is_the_check_constraints_and_the_doors`
/// is the leg of that tripwire an app crate cannot hold.
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

/// The one plain column every template-backed type owns.
const TEMPLATE_TYPE_FIELDS: &[&str] = &["notes"];

/// Which columns each type owns; everything else is nulled on write.
///
/// The nine types #872 added own exactly ONE column — the plaintext memo every
/// item can carry — because their real fields are template rows in
/// `locker_item_field`. That is *"a type is a set of sections and fields"* made
/// structural: **adding a type never adds a column.**
#[must_use]
pub fn type_fields(item_type: &str) -> &'static [&'static str] {
    match item_type {
        "login" => &["username", "password", "url", "otp_seed", "notes"],
        "card" => &["cardholder", "card_number", "expiry", "cvv", "brand"],
        "note" => &["content"],
        "identity" => &["fullname", "email", "phone", "address"],
        "wifi" => &["network", "password"],
        "password" => &["password"],
        _ => TEMPLATE_TYPE_FIELDS,
    }
}

/// The custom field kinds the vault stores (`locker_item_field.kind`).
pub const FIELD_KINDS: [&str; 5] = ["text", "sealed", "url", "date", "otp"];

/// The custom field kinds whose value is a secret, kept sealed.
#[must_use]
pub fn is_sealed_kind(kind: &str) -> bool {
    matches!(kind, "sealed" | "otp")
}

/// The sealed item cells each of the six original types carries, in the order
/// the item pane draws them. The nine template types carry none of their own:
/// their secrets are sealed fields.
#[must_use]
pub fn secret_cells(item_type: &str) -> &'static [&'static str] {
    match item_type {
        "login" => &["password", "otp_seed"],
        "card" => &["card_number", "cvv"],
        "note" => &["content"],
        "wifi" | "password" => &["password"],
        _ => &[],
    }
}

/// Every built-in named field across the 15 item types — the union of every type's
/// own built-in `field_key`s, stored uniformly in `locker_item_field`.
pub const ALL_FIELDS: [&str; 16] = [
    "username",
    "password",
    "url",
    "otp_seed",
    "notes",
    "cardholder",
    "card_number",
    "expiry",
    "cvv",
    "brand",
    "content",
    "fullname",
    "email",
    "phone",
    "address",
    "network",
];

/// Metadata for a built-in named field stored as a keyed row in `locker_item_field`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltInField {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
}

/// Look up the `locker_item_field` metadata for one built-in `field_key`.
#[must_use]
pub fn built_in_field(key: &str) -> Option<BuiltInField> {
    let (key, label, kind) = match key {
        "username" => ("username", "Username", "text"),
        "password" => ("password", "Password", "sealed"),
        "url" => ("url", "Website", "url"),
        "otp_seed" => ("otp_seed", "One-time code", "otp"),
        "notes" => ("notes", "Notes", "text"),
        "cardholder" => ("cardholder", "Cardholder", "text"),
        "card_number" => ("card_number", "Card number", "sealed"),
        "expiry" => ("expiry", "Expiry", "text"),
        "cvv" => ("cvv", "CVV", "sealed"),
        "brand" => ("brand", "Brand", "text"),
        "content" => ("content", "Content", "sealed"),
        "fullname" => ("fullname", "Full name", "text"),
        "email" => ("email", "Email", "text"),
        "phone" => ("phone", "Phone", "text"),
        "address" => ("address", "Address", "text"),
        "network" => ("network", "Network", "text"),
        _ => return None,
    };
    Some(BuiltInField { key, label, kind })
}

/// Deterministic `locker_item_field.id` for a built-in keyed field, used as both
/// the row primary key and the AAD `row_id` when sealing secret built-in fields.
#[must_use]
pub fn built_in_field_id(item_id: &str, field_key: &str) -> String {
    format!("{item_id}:{field_key}")
}

/// One template field: its section, its label, its kind.
pub(super) type TemplateField = (&'static str, &'static str, &'static str);

/// The nine expansion types' templates (`locker-types.ts`).
///
/// **Sealed where the value alone is the credential**; a name, an issuer or an
/// expiry is metadata, and sealing it costs the browsable half for nothing.
pub(super) fn template_for(item_type: &str) -> &'static [TemplateField] {
    match item_type {
        "ssh_key" => &[
            ("Key", "Private key", "sealed"),
            ("Key", "Key passphrase", "sealed"),
            ("Key", "Public key", "text"),
            ("Key", "Fingerprint", "text"),
            ("Host", "Host", "text"),
            ("Host", "User", "text"),
        ],
        "api_credential" => &[
            ("Credential", "Key id", "text"),
            ("Credential", "Secret", "sealed"),
            ("Service", "Endpoint", "url"),
            ("Service", "Environment", "text"),
            ("Service", "Expires", "date"),
        ],
        "passport" => &[
            ("Document", "Passport number", "sealed"),
            ("Holder", "Full name", "text"),
            ("Holder", "Nationality", "text"),
            ("Holder", "Date of birth", "date"),
            ("Document", "Issued", "date"),
            ("Document", "Expires", "date"),
            ("Document", "Place of issue", "text"),
        ],
        "bank_account" => &[
            ("Account", "Account holder", "text"),
            ("Account", "Account number", "sealed"),
            ("Account", "Sort code or routing number", "sealed"),
            ("Account", "IBAN", "sealed"),
            ("Bank", "BIC or SWIFT", "text"),
            ("Bank", "Bank", "text"),
        ],
        "driving_licence" => &[
            ("Licence", "Licence number", "sealed"),
            ("Holder", "Full name", "text"),
            ("Holder", "Date of birth", "date"),
            ("Licence", "Issued", "date"),
            ("Licence", "Expires", "date"),
            ("Licence", "Issuing authority", "text"),
            ("Licence", "Classes", "text"),
        ],
        "software_licence" => &[
            ("Licence", "Licence key", "sealed"),
            ("Product", "Product", "text"),
            ("Product", "Version", "text"),
            ("Licence", "Registered to", "text"),
            ("Purchase", "Purchased", "date"),
            ("Licence", "Expires", "date"),
            ("Purchase", "Order reference", "text"),
        ],
        "crypto_wallet" => &[
            ("Recovery", "Recovery phrase", "sealed"),
            ("Keys", "Private key", "sealed"),
            ("Keys", "Wallet passphrase", "sealed"),
            ("Wallet", "Public address", "text"),
            ("Wallet", "Network", "text"),
            ("Wallet", "Wallet software", "text"),
        ],
        "membership" => &[
            ("Membership", "Member number", "text"),
            ("Membership", "Organisation", "text"),
            ("Membership", "Tier", "text"),
            ("Membership", "Member since", "date"),
            ("Membership", "Expires", "date"),
            ("Access", "PIN", "sealed"),
            ("Access", "Website", "url"),
        ],
        "document" => &[
            ("Document", "Reference", "text"),
            ("Document", "Issued by", "text"),
            ("Document", "Issued", "date"),
            ("Document", "Expires", "date"),
        ],
        _ => &[],
    }
}

/// The plain half of a type's columns, with a `None` for an absent or empty
/// value — v0's `fieldValues`.
pub(super) fn field_values(
    ctx: &CommandCtx<'_, '_>,
    item_type: &str,
) -> Vec<(&'static str, Option<String>)> {
    type_fields(item_type)
        .iter()
        .map(|column| {
            let value = ctx
                .optional_str(column)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            (*column, value)
        })
        .collect()
}

/// The sixteen type columns plus the key generation, as JSON-schema text.
///
/// A macro rather than a constant because the registry compiles each command's
/// schema **once, from a `&'static str`**, and `concat!` takes literals only.
macro_rules! field_schema {
    () => {
        r#"
            "username": { "type": "string" },
            "password": { "type": "string" },
            "url": { "type": "string" },
            "otp_seed": { "type": "string" },
            "notes": { "type": "string" },
            "cardholder": { "type": "string" },
            "card_number": { "type": "string" },
            "expiry": { "type": "string" },
            "cvv": { "type": "string" },
            "brand": { "type": "string" },
            "content": { "type": "string" },
            "fullname": { "type": "string" },
            "email": { "type": "string" },
            "phone": { "type": "string" },
            "address": { "type": "string" },
            "network": { "type": "string" },
            "key_id": { "type": "string", "minLength": 1 },
            "password_rotated": { "type": "boolean" }
        "#
    };
}

/// The fifteen types, as a JSON-schema enum.
macro_rules! type_enum {
    () => {
        r#""type": { "type": "string", "enum": [
              "login", "card", "note", "identity", "wifi", "password",
              "ssh_key", "api_credential", "passport", "bank_account",
              "driving_licence", "software_licence", "crypto_wallet",
              "membership", "document"
            ] },"#
    };
}

/// Just `{item_id}`, which nine commands take and nothing else.
macro_rules! item_id_only {
    () => {
        r#"{
          "type": "object",
          "required": ["item_id"],
          "additionalProperties": false,
          "properties": { "item_id": { "type": "string", "minLength": 1 } }
        }"#
    };
}

pub(super) use {field_schema, item_id_only, type_enum};
