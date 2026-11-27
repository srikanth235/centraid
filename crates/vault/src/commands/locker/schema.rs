//! Locker's item types and their built-in fields, held in Rust.
//!
//! **The database knows a field's SHAPE, not its name** (#1214, I2): a `locker_item_field` row's
//! `kind` says which columns it fills (`text`, `url` and `date` fill `value_text`; `sealed` and
//! `otp` fill `value_sealed` and `key_id`; `file` fills `value_blob`, `value_sealed` and `key_id`),
//! and nothing in the DDL lists a key, so a sixteenth type is a seed row in `locker_type` and a
//! table here, never a rebuild. **Which key is which kind is this file's**, and the plaintext gate
//! (`tests/locker_plaintext_gate.rs`) walks [`secret_keys`] so a secret key added here
//! is hunted for in every door the moment it exists.
//!
//! A built-in field is identified by its stable `field_key` (`password`, `card_number`,
//! `passport_number`), never by its English label: the label is a default the screen may translate,
//! and a custom field has a label and no key. A type is a set of built-in fields; a row exists only
//! while the field holds a value (a sealed field cannot be empty, the file refuses it), so a
//! template is what the screen draws and the rows are what the member filled.

/// The fifteen item types, the `locker_type` lookup's own rows (`tests/lookups.rs` and this
/// module's unit test hold the two equal).
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

/// The vault's placeholder. Round-tripped in a field's `value`, it means **leave the secret
/// alone**, which is what lets an edit form exist without ever holding the secret (#293).
pub const SEALED_PLACEHOLDER: &str = "«sealed»";

/// The field kinds the file stores (`locker_item_field.kind`).
pub const FIELD_KINDS: [&str; 6] = ["text", "sealed", "url", "date", "otp", "file"];

/// Whether a kind keeps its value sealed under `K`: the ones the file gives `value_sealed` and
/// `key_id` (a one-time-code seed and a sealed file's name and media type included).
#[must_use]
pub fn is_sealed_kind(kind: &str) -> bool {
    matches!(kind, "sealed" | "otp" | "file")
}

/// One built-in field of a type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltIn {
    /// The stable key (`password`).
    pub key: &'static str,
    /// The section the screen files it under; empty for the six original types' own fields.
    pub section: &'static str,
    /// The default label.
    pub label: &'static str,
    /// The field's kind.
    pub kind: &'static str,
    /// One per item (a login's `password`), so its row's id is [`field_id_of`] and a second is
    /// the file's refusal (`locker_item_field_single`).
    pub single: bool,
    /// An alias: the value is held by one item vault-wide (`locker_item_field_claimed`).
    pub claimed: bool,
}

const fn one(
    key: &'static str,
    section: &'static str,
    label: &'static str,
    kind: &'static str,
) -> BuiltIn {
    BuiltIn {
        key,
        section,
        label,
        kind,
        single: true,
        claimed: false,
    }
}

/// What every type may carry: more than one address (a login's sites, a membership's website), a
/// memo, and the aliases a connector finds the item by.
const EVERY_TYPE: [BuiltIn; 3] = [
    BuiltIn {
        key: "url",
        section: "",
        label: "Website",
        kind: "url",
        single: false,
        claimed: false,
    },
    one("notes", "", "Notes", "text"),
    BuiltIn {
        key: "alias",
        section: "",
        label: "Alias",
        kind: "text",
        single: false,
        claimed: true,
    },
];

const LOGIN: [BuiltIn; 3] = [
    one("username", "", "Username", "text"),
    one("password", "", "Password", "sealed"),
    one("otp_seed", "", "One-time code", "otp"),
];
const CARD: [BuiltIn; 5] = [
    one("cardholder", "", "Cardholder", "text"),
    one("card_number", "", "Card number", "sealed"),
    // Held as the LAST day of the expiry month (`2027-08-31` for 08/27), so it is a date a
    // reminder can name; a screen shows it as `MM/YY` ([`expiry_display`]).
    one("expiry", "", "Expiry", "date"),
    one("cvv", "", "CVV", "sealed"),
    one("brand", "", "Brand", "text"),
];
const NOTE: [BuiltIn; 1] = [one("content", "", "Content", "sealed")];
const IDENTITY: [BuiltIn; 4] = [
    one("full_name", "", "Full name", "text"),
    one("email", "", "Email", "text"),
    one("phone", "", "Phone", "text"),
    one("address", "", "Address", "text"),
];
const WIFI: [BuiltIn; 2] = [
    one("network", "", "Network", "text"),
    one("password", "", "Password", "sealed"),
];
const PASSWORD: [BuiltIn; 1] = [one("password", "", "Password", "sealed")];
const SSH_KEY: [BuiltIn; 6] = [
    one("private_key", "Key", "Private key", "sealed"),
    one("key_passphrase", "Key", "Key passphrase", "sealed"),
    one("public_key", "Key", "Public key", "text"),
    one("fingerprint", "Key", "Fingerprint", "text"),
    one("host", "Host", "Host", "text"),
    one("user", "Host", "User", "text"),
];
const API_CREDENTIAL: [BuiltIn; 5] = [
    one("api_key_id", "Credential", "Key id", "text"),
    one("secret", "Credential", "Secret", "sealed"),
    one("endpoint", "Service", "Endpoint", "url"),
    one("environment", "Service", "Environment", "text"),
    one("expires", "Service", "Expires", "date"),
];
const PASSPORT: [BuiltIn; 7] = [
    one("passport_number", "Document", "Passport number", "sealed"),
    one("full_name", "Holder", "Full name", "text"),
    one("nationality", "Holder", "Nationality", "text"),
    one("date_of_birth", "Holder", "Date of birth", "date"),
    one("issued", "Document", "Issued", "date"),
    one("expires", "Document", "Expires", "date"),
    one("place_of_issue", "Document", "Place of issue", "text"),
];
const BANK_ACCOUNT: [BuiltIn; 6] = [
    one("account_holder", "Account", "Account holder", "text"),
    one("account_number", "Account", "Account number", "sealed"),
    one(
        "sort_code",
        "Account",
        "Sort code or routing number",
        "sealed",
    ),
    one("iban", "Account", "IBAN", "sealed"),
    one("bic", "Bank", "BIC or SWIFT", "text"),
    one("bank", "Bank", "Bank", "text"),
];
const DRIVING_LICENCE: [BuiltIn; 7] = [
    one("licence_number", "Licence", "Licence number", "sealed"),
    one("full_name", "Holder", "Full name", "text"),
    one("date_of_birth", "Holder", "Date of birth", "date"),
    one("issued", "Licence", "Issued", "date"),
    one("expires", "Licence", "Expires", "date"),
    one("issuing_authority", "Licence", "Issuing authority", "text"),
    one("classes", "Licence", "Classes", "text"),
];
const SOFTWARE_LICENCE: [BuiltIn; 7] = [
    one("licence_key", "Licence", "Licence key", "sealed"),
    one("product", "Product", "Product", "text"),
    one("version", "Product", "Version", "text"),
    one("registered_to", "Licence", "Registered to", "text"),
    one("purchased", "Purchase", "Purchased", "date"),
    one("expires", "Licence", "Expires", "date"),
    one("order_reference", "Purchase", "Order reference", "text"),
];
const CRYPTO_WALLET: [BuiltIn; 6] = [
    one("recovery_phrase", "Recovery", "Recovery phrase", "sealed"),
    one("private_key", "Keys", "Private key", "sealed"),
    one("wallet_passphrase", "Keys", "Wallet passphrase", "sealed"),
    one("public_address", "Wallet", "Public address", "text"),
    one("network", "Wallet", "Network", "text"),
    one("wallet_software", "Wallet", "Wallet software", "text"),
];
const MEMBERSHIP: [BuiltIn; 6] = [
    one("member_number", "Membership", "Member number", "text"),
    one("organisation", "Membership", "Organisation", "text"),
    one("tier", "Membership", "Tier", "text"),
    one("member_since", "Membership", "Member since", "date"),
    one("expires", "Membership", "Expires", "date"),
    one("pin", "Access", "PIN", "sealed"),
];
const DOCUMENT: [BuiltIn; 4] = [
    one("reference", "Document", "Reference", "text"),
    one("issued_by", "Document", "Issued by", "text"),
    one("issued", "Document", "Issued", "date"),
    one("expires", "Document", "Expires", "date"),
];

/// The built-in fields a type has of its own, in the order a screen draws them (not the
/// [`EVERY_TYPE`] ones).
fn own(item_type: &str) -> &'static [BuiltIn] {
    match item_type {
        "login" => &LOGIN,
        "card" => &CARD,
        "note" => &NOTE,
        "identity" => &IDENTITY,
        "wifi" => &WIFI,
        "password" => &PASSWORD,
        "ssh_key" => &SSH_KEY,
        "api_credential" => &API_CREDENTIAL,
        "passport" => &PASSPORT,
        "bank_account" => &BANK_ACCOUNT,
        "driving_licence" => &DRIVING_LICENCE,
        "software_licence" => &SOFTWARE_LICENCE,
        "crypto_wallet" => &CRYPTO_WALLET,
        "membership" => &MEMBERSHIP,
        "document" => &DOCUMENT,
        _ => &[],
    }
}

/// Every built-in field of `item_type`: its own, then the ones every type carries. Empty for a
/// type this build does not know.
#[must_use]
pub fn built_ins(item_type: &str) -> Vec<BuiltIn> {
    let own = own(item_type);
    if own.is_empty() {
        return Vec::new();
    }
    own.iter().chain(EVERY_TYPE.iter()).copied().collect()
}

/// The built-in field `key` of `item_type`.
#[must_use]
pub fn built_in(item_type: &str, key: &str) -> Option<BuiltIn> {
    built_ins(item_type)
        .into_iter()
        .find(|field| field.key == key)
}

/// Where a built-in field sits in its type's template: its row's `position`.
#[must_use]
pub fn position_of(item_type: &str, key: &str) -> f64 {
    built_ins(item_type)
        .iter()
        .position(|field| field.key == key)
        .map_or(0.0, |at| at as f64)
}

/// The id of a single-instance built-in field's row: `<item id>:<field key>`. Deterministic, so
/// the core can seal against it before the row exists (a sealed value's additional data binds it
/// to this id).
#[must_use]
pub fn field_id_of(item_id: &str, field_key: &str) -> String {
    format!("{item_id}:{field_key}")
}

/// Whether `id` has the shape of a single-instance built-in's derived id (`<anything>:<key>` for a
/// single key of any type): such an id belongs to that item's built-in field, never to a custom one.
#[must_use]
pub fn is_derived_field_id(id: &str) -> bool {
    id.rsplit_once(':').is_some_and(|(_, key)| {
        ITEM_TYPES
            .iter()
            .flat_map(|item_type| own(item_type).iter().chain(EVERY_TYPE.iter()))
            .any(|field| field.single && field.key == key)
    })
}

/// Every built-in key that holds a secret (`sealed`, `otp` or `file`) in any type, each once.
#[must_use]
pub fn secret_keys() -> Vec<&'static str> {
    let mut keys: Vec<&'static str> = ITEM_TYPES
        .iter()
        .flat_map(|item_type| own(item_type).iter())
        .filter(|field| is_sealed_kind(field.kind))
        .map(|field| field.key)
        .collect();
    keys.sort_unstable();
    keys.dedup();
    keys
}

/// The type's secret built-in keys, in template order.
#[must_use]
pub fn secret_keys_of(item_type: &str) -> Vec<&'static str> {
    own(item_type)
        .iter()
        .filter(|field| is_sealed_kind(field.kind))
        .map(|field| field.key)
        .collect()
}

/// Whether a built-in key's date is a month ([`normalise_date`] widens it to the month's last day).
#[must_use]
pub fn is_month_key(item_type: &str, key: &str) -> bool {
    item_type == "card" && key == "expiry"
}

fn last_day(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

/// A card's expiry as the date the vault keeps: `MM/YY`, `MM/YYYY` (a space or hyphen may stand
/// for the slash), `YYYY-MM` or a whole `YYYY-MM-DD`, all become the last day of that month.
/// `None` for anything it cannot read.
#[must_use]
pub fn normalise_date(value: &str) -> Option<String> {
    let cleaned: String = value.chars().filter(|c| !c.is_whitespace()).collect();
    let parts: Vec<&str> = cleaned.split(['/', '-']).collect();
    let number = |text: &str| -> Option<i32> {
        (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
            .then(|| text.parse().ok())
            .flatten()
    };
    let (year, month) = match parts.as_slice() {
        [y, m, d] if y.len() == 4 && number(d).is_some() => (number(y)?, number(m)?),
        [y, m] if y.len() == 4 => (number(y)?, number(m)?),
        [m, y] if m.len() <= 2 && (y.len() == 2 || y.len() == 4) => {
            let year = number(y)?;
            (if y.len() == 2 { 2000 + year } else { year }, number(m)?)
        }
        _ => return None,
    };
    let month = u32::try_from(month).ok().filter(|m| (1..=12).contains(m))?;
    Some(format!("{year:04}-{month:02}-{:02}", last_day(year, month)))
}

/// A stored expiry date as the card shows it, `MM/YY`.
#[must_use]
pub fn expiry_display(date: &str) -> Option<String> {
    let (year, rest) = date.split_once('-')?;
    let month = rest.get(..2)?;
    Some(format!("{month}/{}", year.get(2..4)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_type_list_is_the_lookup() {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a directory");
        let vault = crate::Vault::create(dir.join("vault.db")).expect("a vault");
        let declared: Vec<String> = vault
            .read(|connection| {
                Ok(connection
                    .prepare("SELECT code FROM vocab WHERE domain = 'locker_type' ORDER BY code")?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<_>>()?)
            })
            .expect("the lookup reads");
        let mut held = ITEM_TYPES.map(str::to_owned).to_vec();
        held.sort();
        assert_eq!(declared, held);
        drop(vault);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_type_has_stable_unique_keys_of_a_known_kind() {
        for item_type in ITEM_TYPES {
            let fields = built_ins(item_type);
            assert!(!fields.is_empty(), "{item_type} has no fields");
            let mut seen = std::collections::BTreeSet::new();
            for field in &fields {
                assert!(
                    seen.insert(field.key),
                    "{item_type} names `{}` twice",
                    field.key
                );
                assert!(FIELD_KINDS.contains(&field.kind), "{}", field.key);
                assert!(
                    field
                        .key
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte == b'_'),
                    "`{}` is not a stable key",
                    field.key
                );
                // The file's CHECKs: a claimed field is text; a single one needs its key.
                assert!(!field.claimed || field.kind == "text", "{}", field.key);
            }
        }
        assert!(built_ins("quantum_key").is_empty());
    }

    #[test]
    fn a_key_means_one_kind_wherever_it_is_used() {
        let mut kinds: std::collections::BTreeMap<&str, &str> = std::collections::BTreeMap::new();
        for item_type in ITEM_TYPES {
            for field in built_ins(item_type) {
                let was = kinds.insert(field.key, field.kind);
                assert!(
                    was.is_none_or(|kind| kind == field.kind),
                    "`{}` is both {:?} and {}",
                    field.key,
                    was,
                    field.kind
                );
            }
        }
    }

    #[test]
    fn a_card_expiry_is_the_last_day_of_its_month() {
        assert_eq!(normalise_date("08/27").as_deref(), Some("2027-08-31"));
        assert_eq!(normalise_date("8 / 2027").as_deref(), Some("2027-08-31"));
        assert_eq!(normalise_date("2027-08").as_deref(), Some("2027-08-31"));
        assert_eq!(normalise_date("2027-08-05").as_deref(), Some("2027-08-31"));
        assert_eq!(normalise_date("02/28").as_deref(), Some("2028-02-29"));
        assert_eq!(normalise_date("02/27").as_deref(), Some("2027-02-28"));
        assert_eq!(normalise_date("02/00").as_deref(), Some("2000-02-29"));
        assert_eq!(normalise_date("13/27"), None);
        assert_eq!(normalise_date("soon"), None);
        assert_eq!(expiry_display("2027-08-31").as_deref(), Some("08/27"));
    }

    #[test]
    fn the_template_types_seal_only_the_value_that_is_the_credential() {
        // A passport's number is sealed; the holder's name is not, because sealing metadata costs
        // the browsable half for nothing.
        assert_eq!(secret_keys_of("passport"), ["passport_number"]);
        // A crypto wallet is the other end: three of six are the credential.
        assert_eq!(secret_keys_of("crypto_wallet").len(), 3);
        // A one-time-code seed is a secret key too.
        assert!(secret_keys_of("login").contains(&"otp_seed"));
        assert!(secret_keys().contains(&"card_number"));
        // A dated field is plain.
        assert_eq!(
            built_in("passport", "expires").map(|f| f.kind),
            Some("date")
        );
    }
}
