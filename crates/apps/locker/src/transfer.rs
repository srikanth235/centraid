//! IMPORT AND EXPORT, AS PURE FOLDS (#1047 T2).
//!
//! The handoff's `locker/import` and `locker/export`, on the phone. Nothing
//! here opens a cell or writes a row: `crates/core::locker::transfer` opens
//! the secrets under `K` (behind the unlock and one receipt) and runs the
//! commands; this module is the file on either side of that.
//!
//! **Export** writes one of two formats. **CSV** is 1Password's dialect — the
//! handoff's "so the file lands somewhere else without a converter" — nine
//! columns, with whatever has no column (a card's number, an identity, custom
//! fields, extra addresses) as named lines in Notes. **JSON** is Centraid's
//! own, `centraid-locker/1`: every type, field, address, tag and memo, which
//! [`read`] takes back whole. Neither carries a passkey's key material — a
//! passkey is storage only and nothing on the phone signs with it — nor a
//! previous password.
//!
//! **Import** reads a password-manager CSV by its header — Chrome, 1Password,
//! Bitwarden, LastPass, Firefox and this module's own export, through one
//! alias table (v0's `passwords-csv.ts`, widened) — or Centraid's JSON. A
//! one-time-code entry is read through [`crate::totp::seed_of`], so an
//! `otpauth://` link lands as its seed. Then [`plan`] gives each row the
//! handoff's verdict against what the vault already holds: **new**, **fills
//! the empty fields only**, or **held — the vault wins**. A repeat of an
//! earlier row in the same file, or a row that names nothing, is skipped.
//!
//! **No value reaches a log.** [`Entry`] carries secrets, so it has no derived
//! `Debug`; a [`ReadRefusal`]'s sentence never quotes the file.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::totp;

/// The JSON format's name and version, the first thing [`read`] checks.
pub const JSON_FORMAT: &str = "centraid-locker/1";

/// The largest file an import reads: 4 MiB is some tens of thousands of
/// logins, and a file larger than that is not a password-manager export.
pub const MAX_IMPORT_BYTES: usize = 4 * 1024 * 1024;

/// The most rows an import plans. A plan is drawn row by row on a phone.
pub const MAX_IMPORT_ROWS: usize = 5_000;

/// The six types the phone makes; an import lands anything else as a note.
pub const PHONE_TYPES: [&str; 6] = ["login", "card", "note", "identity", "wifi", "password"];

/// Which columns each type owns — the vault's `type_fields`, which
/// `locker.add_item` and `locker.edit_item` write and null the rest of.
#[must_use]
pub fn type_columns(item_type: &str) -> &'static [&'static str] {
    match item_type {
        "login" => &["username", "password", "url", "otp_seed", "notes"],
        "card" => &["cardholder", "card_number", "expiry", "cvv", "brand"],
        "note" => &["content"],
        "identity" => &["fullname", "email", "phone", "address"],
        "wifi" => &["network", "password"],
        "password" => &["password"],
        _ => &["notes"],
    }
}

/// The custom field kinds the vault stores (`locker_item_field.kind`).
pub const FIELD_KINDS: [&str; 5] = ["text", "sealed", "url", "date", "otp"];

/// The five sealed item cells.
pub const SEALED_CELLS: [&str; 5] = ["password", "otp_seed", "card_number", "cvv", "content"];

/// One custom field. `value` is the plaintext of a sealed one.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct EntryField {
    pub section: String,
    pub label: String,
    /// `text`, `sealed`, `url`, `date` or `otp`.
    pub kind: String,
    pub value: String,
}

impl fmt::Debug for EntryField {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EntryField")
            .field("section", &self.section)
            .field("label", &self.label)
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

/// A passkey's metadata. **Never its key**: the file carries none.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EntryPasskey {
    pub rp_id: String,
    pub user_handle: String,
    pub display_name: String,
    pub credential_id: String,
    pub algorithm: String,
}

/// ONE ITEM, WITH ITS SECRETS IN THE CLEAR — what an export writes and an
/// import reads. `columns` holds every non-empty column the type owns, sealed
/// cells included, by the vault's column name.
///
/// No derived `Debug`: a `{:?}` of this is every secret it holds.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct Entry {
    pub item_type: String,
    pub title: String,
    pub columns: BTreeMap<String, String>,
    pub tags: Vec<String>,
    pub starred: bool,
    pub archived: bool,
    pub compromised: bool,
    pub memo: String,
    pub fields: Vec<EntryField>,
    /// Addresses beside the primary `url`.
    pub addresses: Vec<String>,
    pub passkey: Option<EntryPasskey>,
}

impl fmt::Debug for Entry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Entry")
            .field("item_type", &self.item_type)
            .field("title", &self.title)
            .field("columns", &self.columns.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl Entry {
    /// A column's value, or `""`.
    #[must_use]
    pub fn column(&self, column: &str) -> &str {
        self.columns.get(column).map_or("", String::as_str)
    }

    /// Whether any sealed cell or sealed field holds a value.
    #[must_use]
    pub fn carries_secret(&self) -> bool {
        SEALED_CELLS
            .iter()
            .any(|cell| !self.column(cell).is_empty())
            || self
                .fields
                .iter()
                .any(|field| field.kind == "sealed" && !field.value.is_empty())
    }
}

// ---------------------------------------------------------------------------
// Export.
// ---------------------------------------------------------------------------

/// 1Password's CSV header, in its order.
pub const CSV_HEADER: [&str; 9] = [
    "Title", "Url", "Username", "Password", "OTPAuth", "Favorite", "Archived", "Tags", "Notes",
];

/// The file as 1Password-dialect CSV (RFC 4180, CRLF, every cell that needs it
/// quoted). A login's own columns fill their columns; everything else rides
/// Notes as `Label: value` lines, so nothing in the item is left behind.
#[must_use]
pub fn csv(entries: &[Entry]) -> String {
    let mut out = String::new();
    push_row(
        &mut out,
        CSV_HEADER.iter().map(|header| (*header).to_owned()),
    );
    for entry in entries {
        let seed = entry.column("otp_seed");
        push_row(
            &mut out,
            [
                entry.title.clone(),
                entry.column("url").to_owned(),
                entry.column("username").to_owned(),
                entry.column("password").to_owned(),
                if seed.is_empty() {
                    String::new()
                } else {
                    otpauth_of(&entry.title, seed)
                },
                if entry.starred { "true" } else { "" }.to_owned(),
                if entry.archived { "true" } else { "" }.to_owned(),
                entry.tags.join(";"),
                notes_lines(entry).join("\n"),
            ],
        );
    }
    out
}

/// What has no CSV column, as named lines.
fn notes_lines(entry: &Entry) -> Vec<String> {
    let mut lines = Vec::new();
    let notes = entry.column("notes");
    if !notes.is_empty() {
        lines.push(notes.to_owned());
    }
    if entry.item_type != "login" {
        lines.push(format!("Type: {}", entry.item_type));
    }
    for (column, label) in [
        ("content", "Note"),
        ("cardholder", "Cardholder"),
        ("card_number", "Card number"),
        ("expiry", "Expiry"),
        ("cvv", "Security code"),
        ("brand", "Brand"),
        ("fullname", "Full name"),
        ("email", "Email"),
        ("phone", "Phone"),
        ("address", "Postal address"),
        ("network", "Network"),
    ] {
        let value = entry.column(column);
        if !value.is_empty() {
            lines.push(format!("{label}: {value}"));
        }
    }
    // A Wi-Fi or standalone password has its password in the Password column
    // already; nothing to repeat.
    for address in &entry.addresses {
        lines.push(format!("Address: {address}"));
    }
    for field in &entry.fields {
        if field.value.is_empty() {
            continue;
        }
        let section = if field.section.is_empty() {
            String::new()
        } else {
            format!("{} · ", field.section)
        };
        lines.push(format!("{section}{}: {}", field.label, field.value));
    }
    if !entry.memo.is_empty() {
        lines.push(format!("Memo: {}", entry.memo));
    }
    if let Some(passkey) = &entry.passkey {
        lines.push(format!(
            "Passkey: {} · {} (its key is not in this file)",
            passkey.rp_id,
            if passkey.display_name.is_empty() {
                &passkey.user_handle
            } else {
                &passkey.display_name
            }
        ));
    }
    if entry.compromised {
        lines.push("Compromised: flagged in Locker".to_owned());
    }
    lines
}

/// `otpauth://totp/<title>?secret=<seed>` — what 1Password's OTPAuth column
/// holds, and what [`crate::totp::seed_of`] reads back.
fn otpauth_of(title: &str, seed: &str) -> String {
    format!("otpauth://totp/{}?secret={seed}", percent_encoded(title))
}

fn percent_encoded(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn push_row(out: &mut String, cells: impl IntoIterator<Item = String>) {
    let row: Vec<String> = cells.into_iter().map(|cell| quoted(&cell)).collect();
    out.push_str(&row.join(","));
    out.push_str("\r\n");
}

fn quoted(cell: &str) -> String {
    if cell.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", cell.replace('"', "\"\""))
    } else {
        cell.to_owned()
    }
}

/// The file as Centraid's JSON (`centraid-locker/1`), pretty-printed.
#[must_use]
pub fn json(entries: &[Entry], exported_at: &str) -> String {
    let items: Vec<serde_json::Value> = entries
        .iter()
        .map(|entry| {
            let mut item = serde_json::Map::new();
            item.insert("type".to_owned(), entry.item_type.clone().into());
            item.insert("title".to_owned(), entry.title.clone().into());
            for (column, value) in &entry.columns {
                item.insert(column.clone(), value.clone().into());
            }
            item.insert("starred".to_owned(), entry.starred.into());
            item.insert("archived".to_owned(), entry.archived.into());
            item.insert("compromised".to_owned(), entry.compromised.into());
            item.insert("tags".to_owned(), serde_json::json!(entry.tags));
            if !entry.memo.is_empty() {
                item.insert("memo".to_owned(), entry.memo.clone().into());
            }
            item.insert(
                "fields".to_owned(),
                entry
                    .fields
                    .iter()
                    .map(|field| {
                        serde_json::json!({
                            "section": field.section,
                            "label": field.label,
                            "kind": field.kind,
                            "value": field.value,
                        })
                    })
                    .collect(),
            );
            item.insert("addresses".to_owned(), serde_json::json!(entry.addresses));
            if let Some(passkey) = &entry.passkey {
                item.insert(
                    "passkey".to_owned(),
                    serde_json::json!({
                        "rp_id": passkey.rp_id,
                        "user_handle": passkey.user_handle,
                        "display_name": passkey.display_name,
                        "credential_id": passkey.credential_id,
                        "algorithm": passkey.algorithm,
                    }),
                );
            }
            serde_json::Value::Object(item)
        })
        .collect();
    let document = serde_json::json!({
        "format": JSON_FORMAT,
        "exported_at": exported_at,
        "items": items,
    });
    serde_json::to_string_pretty(&document).unwrap_or_default()
}

/// A format's file name on `day` (`YYYY-MM-DD`), and its media type.
#[must_use]
pub fn file_of(day: &str, json: bool) -> (String, &'static str) {
    let stem = if day.is_empty() {
        "locker".to_owned()
    } else {
        format!("locker-{day}")
    };
    if json {
        (format!("{stem}.json"), "application/json")
    } else {
        (format!("{stem}.csv"), "text/csv")
    }
}

// ---------------------------------------------------------------------------
// Import: reading.
// ---------------------------------------------------------------------------

/// What an import file was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Csv,
    Json,
}

impl Format {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Json => "json",
        }
    }
}

/// A file, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportFile {
    pub format: Format,
    pub entries: Vec<Entry>,
}

/// Why a file could not be read. The sentence never quotes the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ReadRefusal {
    /// Neither a password-manager CSV (by its header) nor `centraid-locker/1`.
    #[error("that file is not a password-manager CSV or a Locker export")]
    NotReadable,
    /// Larger than [`MAX_IMPORT_BYTES`] or [`MAX_IMPORT_ROWS`].
    #[error("that file is larger than Locker imports at once")]
    TooLarge,
}

/// Read a picked file: Centraid's JSON by its `format`, else a
/// password-manager CSV by its header.
///
/// # Errors
/// [`ReadRefusal`] — the file is neither, or is too large.
pub fn read(bytes: &[u8]) -> Result<ImportFile, ReadRefusal> {
    if bytes.len() > MAX_IMPORT_BYTES {
        return Err(ReadRefusal::TooLarge);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| ReadRefusal::NotReadable)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let file = if text.trim_start().starts_with('{') {
        read_json(text)?
    } else {
        read_csv(text)?
    };
    if file.entries.len() > MAX_IMPORT_ROWS {
        return Err(ReadRefusal::TooLarge);
    }
    Ok(file)
}

fn read_json(text: &str) -> Result<ImportFile, ReadRefusal> {
    let document: serde_json::Value =
        serde_json::from_str(text).map_err(|_| ReadRefusal::NotReadable)?;
    if document["format"].as_str() != Some(JSON_FORMAT) {
        return Err(ReadRefusal::NotReadable);
    }
    let items = document["items"]
        .as_array()
        .ok_or(ReadRefusal::NotReadable)?;
    let text_of = |value: &serde_json::Value| value.as_str().unwrap_or_default().trim().to_owned();
    let entries = items
        .iter()
        .map(|item| {
            let stated = text_of(&item["type"]);
            let item_type = if PHONE_TYPES.contains(&stated.as_str()) {
                stated
            } else {
                "note".to_owned()
            };
            let mut columns = BTreeMap::new();
            for column in type_columns(&item_type) {
                let value = text_of(&item[*column]);
                if !value.is_empty() {
                    columns.insert((*column).to_owned(), value);
                }
            }
            normalise_seed(&mut columns);
            let strings = |value: &serde_json::Value| -> Vec<String> {
                value
                    .as_array()
                    .map(|list| {
                        list.iter()
                            .filter_map(|one| one.as_str())
                            .map(|one| one.trim().to_owned())
                            .filter(|one| !one.is_empty())
                            .collect()
                    })
                    .unwrap_or_default()
            };
            Entry {
                title: text_of(&item["title"]),
                columns,
                tags: strings(&item["tags"]),
                starred: item["starred"].as_bool().unwrap_or(false),
                archived: item["archived"].as_bool().unwrap_or(false),
                compromised: item["compromised"].as_bool().unwrap_or(false),
                memo: text_of(&item["memo"]),
                fields: item["fields"]
                    .as_array()
                    .map(|fields| {
                        fields
                            .iter()
                            .filter_map(|field| {
                                let label = text_of(&field["label"]);
                                let kind = text_of(&field["kind"]);
                                (!label.is_empty()).then(|| EntryField {
                                    section: text_of(&field["section"]),
                                    label,
                                    kind: if FIELD_KINDS.contains(&kind.as_str()) {
                                        kind
                                    } else {
                                        "text".to_owned()
                                    },
                                    value: field["value"].as_str().unwrap_or_default().to_owned(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                addresses: strings(&item["addresses"]),
                passkey: None,
                item_type,
            }
        })
        .collect();
    Ok(ImportFile {
        format: Format::Json,
        entries,
    })
}

const TITLE_ALIASES: [&str; 3] = ["title", "name", "item"];
const URL_ALIASES: [&str; 5] = ["url", "login_uri", "website", "uri", "login_url"];
const USERNAME_ALIASES: [&str; 4] = ["username", "login_username", "user", "login"];
const PASSWORD_ALIASES: [&str; 3] = ["password", "login_password", "pass"];
const OTP_ALIASES: [&str; 5] = ["otpauth", "totp", "login_totp", "otp", "otp_seed"];
const NOTES_ALIASES: [&str; 4] = ["notes", "note", "extra", "comments"];
const FAVORITE_ALIASES: [&str; 3] = ["favorite", "favourite", "fav"];
const TAGS_ALIASES: [&str; 1] = ["tags"];
const ARCHIVED_ALIASES: [&str; 1] = ["archived"];

fn column_of(header: &[String], aliases: &[&str]) -> Option<usize> {
    aliases
        .iter()
        .find_map(|alias| header.iter().position(|named| named == alias))
}

fn read_csv(text: &str) -> Result<ImportFile, ReadRefusal> {
    let mut rows = csv_rows(text).into_iter();
    let header: Vec<String> = rows
        .next()
        .ok_or(ReadRefusal::NotReadable)?
        .iter()
        .map(|named| named.trim().to_lowercase())
        .collect();
    let password = column_of(&header, &PASSWORD_ALIASES);
    let username = column_of(&header, &USERNAME_ALIASES);
    let url = column_of(&header, &URL_ALIASES);
    // A PASSWORD-MANAGER EXPORT NAMES A PASSWORD, and a username or an
    // address beside it — v0's test, which keeps a bank statement out.
    if password.is_none() || (username.is_none() && url.is_none()) {
        return Err(ReadRefusal::NotReadable);
    }
    let title = column_of(&header, &TITLE_ALIASES);
    let otp = column_of(&header, &OTP_ALIASES);
    let notes = column_of(&header, &NOTES_ALIASES);
    let favorite = column_of(&header, &FAVORITE_ALIASES);
    let tags = column_of(&header, &TAGS_ALIASES);
    let archived = column_of(&header, &ARCHIVED_ALIASES);
    let entries = rows
        .filter(|row| row.iter().any(|cell| !cell.trim().is_empty()))
        .map(|row| {
            let cell = |at: Option<usize>| {
                at.and_then(|at| row.get(at))
                    .map(|value| value.trim().to_owned())
                    .unwrap_or_default()
            };
            let address = cell(url);
            let named = cell(title);
            let mut columns = BTreeMap::new();
            for (column, value) in [
                ("username", cell(username)),
                ("password", cell(password)),
                ("url", address.clone()),
                ("otp_seed", cell(otp)),
                ("notes", cell(notes)),
            ] {
                if !value.is_empty() {
                    columns.insert(column.to_owned(), value);
                }
            }
            normalise_seed(&mut columns);
            let truthy = |value: String| {
                matches!(
                    value.to_lowercase().as_str(),
                    "1" | "true" | "yes" | "y" | "x"
                )
            };
            Entry {
                item_type: "login".to_owned(),
                title: if named.is_empty() {
                    host_of(&address).unwrap_or_default()
                } else {
                    named
                },
                columns,
                tags: cell(tags)
                    .split([';', ','])
                    .map(str::trim)
                    .filter(|tag| !tag.is_empty())
                    .map(str::to_owned)
                    .collect(),
                starred: truthy(cell(favorite)),
                archived: truthy(cell(archived)),
                ..Entry::default()
            }
        })
        .collect();
    Ok(ImportFile {
        format: Format::Csv,
        entries,
    })
}

/// A one-time-code entry, read once: its seed, or nothing when it is not one
/// (a counter-based link, another algorithm, a typo). The row still imports.
fn normalise_seed(columns: &mut BTreeMap<String, String>) {
    if let Some(entry) = columns.remove("otp_seed")
        && let Ok(seed) = totp::seed_of(&entry)
    {
        columns.insert("otp_seed".to_owned(), seed);
    }
}

/// RFC 4180's rows: quoted cells, doubled quotes, CRLF or LF, and a newline
/// inside quotes kept.
fn csv_rows(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if quoted {
            match character {
                '"' if chars.peek() == Some(&'"') => {
                    cell.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                other => cell.push(other),
            }
            continue;
        }
        match character {
            '"' if cell.is_empty() => quoted = true,
            ',' => row.push(std::mem::take(&mut cell)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut cell));
                rows.push(std::mem::take(&mut row));
            }
            other => cell.push(other),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

/// An address's host, lower-cased, without `www.`, a port or credentials.
#[must_use]
pub fn host_of(address: &str) -> Option<String> {
    let rest = address.trim();
    let rest = rest.split_once("://").map_or(rest, |(_, after)| after);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = authority
        .split(':')
        .next()
        .unwrap_or_default()
        .to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    (!host.is_empty()).then_some(host)
}

// ---------------------------------------------------------------------------
// Import: the plan.
// ---------------------------------------------------------------------------

/// An item already in the vault, as the plan compares against it: its plain
/// columns and which of its sealed cells hold a value.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Existing {
    pub item_id: String,
    pub item_type: String,
    pub title: String,
    /// Non-empty plain columns.
    pub plain: BTreeMap<String, String>,
    /// Sealed cells that hold a value.
    pub sealed: BTreeSet<String>,
}

impl Existing {
    fn holds(&self, column: &str) -> bool {
        self.sealed.contains(column)
            || self
                .plain
                .get(column)
                .is_some_and(|value| !value.is_empty())
    }
}

/// The handoff's three verdicts, and the skip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    New,
    /// Fills the empty fields only.
    Fill,
    /// A vault secret already exists — the vault wins.
    Held,
    Skipped,
}

/// One row's verdict, and — for a fill — the columns it fills.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub verdict: Verdict,
    pub matched: Option<String>,
    pub fills: Vec<&'static str>,
}

/// What makes two items the same item: a login by its address's host (or its
/// title, with no address) and its username; anything else by type and title.
fn key_of(item_type: &str, title: &str, url: &str, username: &str) -> Option<String> {
    let title = title.trim().to_lowercase();
    if item_type == "login" {
        let place = host_of(url).unwrap_or(title);
        if place.is_empty() {
            return None;
        }
        return Some(format!(
            "login\u{1f}{place}\u{1f}{}",
            username.trim().to_lowercase()
        ));
    }
    (!title.is_empty()).then(|| format!("{item_type}\u{1f}{title}"))
}

/// Give each entry its verdict against `existing`, in the file's order.
#[must_use]
pub fn plan(entries: &[Entry], existing: &[Existing]) -> Vec<Planned> {
    let mut held: BTreeMap<String, &Existing> = BTreeMap::new();
    for item in existing {
        let url = item.plain.get("url").map_or("", String::as_str);
        let username = item.plain.get("username").map_or("", String::as_str);
        if let Some(key) = key_of(&item.item_type, &item.title, url, username) {
            held.entry(key).or_insert(item);
        }
    }
    let mut seen: BTreeSet<String> = BTreeSet::new();
    entries
        .iter()
        .map(|entry| {
            let skipped = Planned {
                verdict: Verdict::Skipped,
                matched: None,
                fills: Vec::new(),
            };
            let Some(key) = key_of(
                &entry.item_type,
                &entry.title,
                entry.column("url"),
                entry.column("username"),
            ) else {
                return skipped;
            };
            if entry.title.trim().is_empty() || !seen.insert(key.clone()) {
                return skipped;
            }
            let Some(item) = held.get(&key) else {
                return Planned {
                    verdict: Verdict::New,
                    matched: None,
                    fills: Vec::new(),
                };
            };
            // THE VAULT WINS: a column the item already holds is never
            // replaced, and a different secret in the file is simply not used.
            let fills: Vec<&'static str> = type_columns(&item.item_type)
                .iter()
                .copied()
                .filter(|column| !entry.column(column).is_empty() && !item.holds(column))
                .collect();
            Planned {
                verdict: if fills.is_empty() {
                    Verdict::Held
                } else {
                    Verdict::Fill
                },
                matched: Some(item.item_id.clone()),
                fills,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(title: &str, url: &str, username: &str, password: &str) -> Entry {
        let mut columns = BTreeMap::new();
        for (column, value) in [("url", url), ("username", username), ("password", password)] {
            if !value.is_empty() {
                columns.insert(column.to_owned(), value.to_owned());
            }
        }
        Entry {
            item_type: "login".to_owned(),
            title: title.to_owned(),
            columns,
            ..Entry::default()
        }
    }

    /// THE HEADER DIALECTS: Chrome, Bitwarden, LastPass and Firefox name the
    /// same four things four ways, and each lands as the same login.
    #[test]
    fn every_common_header_dialect_reads_as_logins() {
        let files = [
            "name,url,username,password,note\nBank,https://bank.example/login,ada,pw-1,a note\n",
            "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,1,login,Bank,a note,,0,https://bank.example/login,ada,pw-1,\n",
            "url,username,password,totp,extra,name,grouping,fav\nhttps://bank.example/login,ada,pw-1,,a note,Bank,,1\n",
            "\u{feff}\"url\",\"username\",\"password\",\"httpRealm\"\r\n\"https://bank.example/login\",\"ada\",\"pw-1\",\"\"\r\n",
        ];
        for text in files {
            let file = read(text.as_bytes()).expect("a password-manager CSV");
            assert_eq!(file.format, Format::Csv);
            let entry = &file.entries[0];
            assert_eq!(entry.item_type, "login");
            assert!(
                entry.title == "Bank" || entry.title == "bank.example",
                "{text}"
            );
            assert_eq!(entry.column("username"), "ada");
            assert_eq!(entry.column("password"), "pw-1");
            assert_eq!(entry.column("url"), "https://bank.example/login");
        }
    }

    #[test]
    fn a_file_that_is_not_a_password_export_is_refused_without_quoting_it() {
        for text in [
            "date,amount,payee\n2026-01-01,12.00,Shop\n",
            "{\"format\":\"something-else\"}",
            "",
        ] {
            let refusal = read(text.as_bytes()).expect_err("not a password export");
            assert_eq!(refusal, ReadRefusal::NotReadable);
            assert!(!refusal.to_string().contains("Shop"));
        }
        assert_eq!(
            read(&[0xff, 0xfe, 0x00]).expect_err("not text"),
            ReadRefusal::NotReadable
        );
        let huge = vec![b'a'; MAX_IMPORT_BYTES + 1];
        assert_eq!(read(&huge).expect_err("too large"), ReadRefusal::TooLarge);
    }

    /// A QUOTED CELL KEEPS ITS COMMAS, QUOTES AND NEWLINES.
    #[test]
    fn quoted_cells_round_trip() {
        let text = "title,url,username,password,notes\r\n\"A, \"\"quoted\"\" title\",x.example,u,\"p,w\",\"two\nlines\"\r\n";
        let entry = &read(text.as_bytes()).expect("reads").entries[0];
        assert_eq!(entry.title, "A, \"quoted\" title");
        assert_eq!(entry.column("password"), "p,w");
        assert_eq!(entry.column("notes"), "two\nlines");
    }

    /// AN `otpauth://` LINK LANDS AS ITS SEED, and an entry that is not a
    /// seed is dropped — the row still imports.
    #[test]
    fn a_one_time_code_entry_is_read_as_its_seed() {
        let text = "title,url,username,password,otpauth\n\
                    A,a.example,u,p,otpauth://totp/A?secret=jbswy3dpehpk3pxp&issuer=A\n\
                    B,b.example,u,p,otpauth://hotp/B?secret=JBSWY3DPEHPK3PXP&counter=1\n";
        let file = read(text.as_bytes()).expect("reads");
        assert_eq!(file.entries[0].column("otp_seed"), "JBSWY3DPEHPK3PXP");
        assert_eq!(file.entries[1].column("otp_seed"), "");
        assert_eq!(file.entries[1].column("password"), "p");
    }

    /// THE EXPORT READS BACK: CSV as logins with every column, JSON whole.
    #[test]
    fn both_export_formats_read_back() {
        let mut bank = login("Bank", "https://bank.example", "ada", "pw, \"1\"");
        bank.columns
            .insert("otp_seed".to_owned(), "JBSWY3DPEHPK3PXP".to_owned());
        bank.columns
            .insert("notes".to_owned(), "line one\nline two".to_owned());
        bank.tags = vec!["money".to_owned(), "work".to_owned()];
        bank.starred = true;
        bank.fields.push(EntryField {
            section: "Recovery".to_owned(),
            label: "Recovery code".to_owned(),
            kind: "sealed".to_owned(),
            value: "rc-1".to_owned(),
        });
        let mut card = Entry {
            item_type: "card".to_owned(),
            title: "Visa".to_owned(),
            ..Entry::default()
        };
        card.columns
            .insert("card_number".to_owned(), "4111111111111111".to_owned());
        card.columns.insert("cvv".to_owned(), "123".to_owned());

        let text = csv(&[bank.clone(), card.clone()]);
        assert!(
            text.starts_with(
                "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\r\n"
            )
        );
        let back = read(text.as_bytes()).expect("its own CSV reads");
        assert_eq!(back.entries[0].column("password"), "pw, \"1\"");
        assert_eq!(back.entries[0].column("otp_seed"), "JBSWY3DPEHPK3PXP");
        assert_eq!(back.entries[0].tags, vec!["money", "work"]);
        assert!(back.entries[0].starred);
        assert!(
            back.entries[0]
                .column("notes")
                .contains("Recovery · Recovery code: rc-1")
        );
        // A card has no CSV columns of its own: it rides Notes, whole.
        assert!(
            back.entries[1]
                .column("notes")
                .contains("Card number: 4111111111111111")
        );

        let text = json(&[bank.clone(), card.clone()], "2026-09-29T00:00:00.000Z");
        let back = read(text.as_bytes()).expect("its own JSON reads");
        assert_eq!(back.format, Format::Json);
        assert_eq!(back.entries, vec![bank, card]);
    }

    /// A PASSKEY'S KEY IS NEVER IN EITHER FILE — there is no field to hold it.
    #[test]
    fn neither_format_carries_a_passkeys_key() {
        let mut entry = login("Bank", "bank.example", "ada", "");
        entry.passkey = Some(EntryPasskey {
            rp_id: "bank.example".to_owned(),
            user_handle: "ada".to_owned(),
            ..EntryPasskey::default()
        });
        assert!(!json(&[entry.clone()], "t").contains("private_key"));
        assert!(csv(&[entry]).contains("its key is not in this file"));
    }

    /// THE HANDOFF'S VERDICTS: new, fills the empty fields only, held — the
    /// vault wins — and a repeat of an earlier row is skipped.
    #[test]
    fn the_plan_gives_the_handoffs_verdicts_and_the_vault_wins() {
        let existing = vec![
            Existing {
                item_id: "held".to_owned(),
                item_type: "login".to_owned(),
                title: "Bank".to_owned(),
                plain: BTreeMap::from([
                    ("url".to_owned(), "https://www.bank.example/".to_owned()),
                    ("username".to_owned(), "ada".to_owned()),
                ]),
                sealed: BTreeSet::from(["password".to_owned()]),
            },
            Existing {
                item_id: "gappy".to_owned(),
                item_type: "login".to_owned(),
                title: "Mail".to_owned(),
                plain: BTreeMap::from([("url".to_owned(), "mail.example".to_owned())]),
                sealed: BTreeSet::new(),
            },
        ];
        let entries = vec![
            login(
                "Bank",
                "https://bank.example/login",
                "ADA",
                "a-different-password",
            ),
            login("Mail", "https://mail.example", "", "pw"),
            login("Shop", "shop.example", "ada", "pw"),
            login("Shop again", "https://shop.example/cart", "ada", "pw-2"),
            login("", "", "", "pw"),
        ];
        let planned = plan(&entries, &existing);
        assert_eq!(planned[0].verdict, Verdict::Held);
        assert_eq!(planned[0].matched.as_deref(), Some("held"));
        assert_eq!(planned[1].verdict, Verdict::Fill);
        assert_eq!(planned[1].fills, vec!["password"]);
        assert_eq!(planned[2].verdict, Verdict::New);
        assert_eq!(planned[3].verdict, Verdict::Skipped);
        assert_eq!(planned[4].verdict, Verdict::Skipped);
    }

    #[test]
    fn a_host_is_read_without_scheme_credentials_port_or_www() {
        assert_eq!(
            host_of("https://user:pw@www.Bank.example:8443/x?y#z").as_deref(),
            Some("bank.example")
        );
        assert_eq!(
            host_of("bank.example/login").as_deref(),
            Some("bank.example")
        );
        assert_eq!(host_of("  ").as_deref(), None);
    }

    /// NO VALUE IN A DEBUG LINE.
    #[test]
    fn an_entry_prints_no_secret() {
        let entry = login("Bank", "bank.example", "ada", "hunter2-secret");
        assert!(!format!("{entry:?}").contains("hunter2-secret"));
        let field = EntryField {
            value: "rc-secret".to_owned(),
            ..EntryField::default()
        };
        assert!(!format!("{field:?}").contains("rc-secret"));
    }
}
