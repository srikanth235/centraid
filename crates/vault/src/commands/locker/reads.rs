//! What a screen, the autofill service and passkey sign-in ask Locker, as plain functions over a
//! connection (`Vault::read(|c| reads::…(c, …))`). None of them returns a sealed value: a sealed
//! field is a bit (`sealed`), and its ciphertext leaves only through the custody doors the core
//! opens behind the member's unlock.

use rusqlite::Connection;

use crate::error::Result;

use super::schema::{expiry_display, is_month_key, is_sealed_kind};

/// The statement behind [`items_for_identifier`]: the url index, `locker_item_field_by_url`.
/// `{marks}` is a list of `?`, one per candidate spelling.
#[must_use]
pub fn items_for_urls_sql(candidates: usize) -> String {
    let marks = vec!["?"; candidates.max(1)].join(", ");
    format!(
        "SELECT f.item_id FROM locker_item_field f JOIN entity e ON e.id = f.item_id
          WHERE f.kind = 'url' AND f.value_text COLLATE NOCASE IN ({marks})
            AND e.deleted_at IS NULL"
    )
}

/// The spellings a stored address may have for a site or an app identifier: what was asked,
/// without a scheme or a trailing slash, and with `https://` and `http://` in front.
#[must_use]
pub fn url_candidates(identifier: &str) -> Vec<String> {
    let asked = identifier.trim();
    let bare = asked
        .split_once("://")
        .map_or(asked, |(_, rest)| rest)
        .trim_end_matches('/');
    let mut found = vec![asked.to_owned()];
    if !bare.is_empty() {
        for scheme in ["", "https://", "http://"] {
            for slash in ["", "/"] {
                found.push(format!("{scheme}{bare}{slash}"));
            }
        }
    }
    found.sort();
    found.dedup();
    found
}

/// The live items that hold an address for this site or app identifier, by id. Never a trashed
/// item; an archived one is still found.
///
/// # Errors
/// SQLite's refusal.
pub fn items_for_identifier(connection: &Connection, identifier: &str) -> Result<Vec<String>> {
    let candidates = url_candidates(identifier);
    let mut statement = connection.prepare_cached(&items_for_urls_sql(candidates.len()))?;
    let mut found: Vec<String> = statement
        .query_map(rusqlite::params_from_iter(candidates.iter()), |row| {
            row.get(0)
        })?
        .collect::<rusqlite::Result<_>>()?;
    found.sort();
    found.dedup();
    Ok(found)
}

/// One passkey as sign-in finds it: which one, on which item. Never its key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasskeyRef {
    pub passkey_id: String,
    pub item_id: String,
    pub credential_id: Option<String>,
    pub user_handle: Option<String>,
    pub display_name: Option<String>,
}

/// The passkeys held for a site (`rp_id`), across every live item, by `locker_item_passkey_by_rp`.
///
/// # Errors
/// SQLite's refusal.
pub fn passkeys_for_rp(connection: &Connection, rp_id: &str) -> Result<Vec<PasskeyRef>> {
    let mut statement = connection.prepare_cached(
        "SELECT p.id, p.item_id, p.credential_id, p.user_handle, p.display_name
           FROM locker_item_passkey p JOIN entity e ON e.id = p.item_id
          WHERE p.rp_id = ?1 AND e.deleted_at IS NULL",
    )?;
    let mut found: Vec<PasskeyRef> = statement
        .query_map([rp_id.trim()], |row| {
            Ok(PasskeyRef {
                passkey_id: row.get(0)?,
                item_id: row.get(1)?,
                credential_id: row.get(2)?,
                user_handle: row.get(3)?,
                display_name: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    found.sort_by(|a, b| a.passkey_id.cmp(&b.passkey_id));
    Ok(found)
}

/// One field of an item, as a screen draws it.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldView {
    pub field_id: String,
    pub field_key: Option<String>,
    pub section: String,
    pub label: String,
    pub kind: String,
    /// A plain field's value, as it is kept. `None` for a sealed field.
    pub value: Option<String>,
    /// How the screen shows a plain value: a card's expiry as `MM/YY`, else the value.
    pub display: Option<String>,
    /// Whether the field holds a secret (a bit: the value is not here).
    pub sealed: bool,
    /// When a secret's value last changed.
    pub value_set_at: Option<String>,
}

/// An item's fields in order, with no sealed value in them.
///
/// # Errors
/// SQLite's refusal.
pub fn fields_of(connection: &Connection, item_id: &str) -> Result<Vec<FieldView>> {
    let item_type: Option<String> = connection
        .query_row("SELECT type FROM locker_item WHERE id = ?1", [item_id], |row| {
            row.get(0)
        })
        .ok();
    let item_type = item_type.unwrap_or_default();
    let mut statement = connection.prepare_cached(
        "SELECT id, field_key, section, label, kind, value_text, value_set_at
           FROM locker_item_field WHERE item_id = ?1 ORDER BY position, id",
    )?;
    let rows = statement.query_map([item_id], |row| {
        let kind: String = row.get(4)?;
        let key: Option<String> = row.get(1)?;
        let value: Option<String> = row.get(5)?;
        let display = match (&key, &value) {
            (Some(key), Some(value)) if is_month_key(&item_type, key) => expiry_display(value),
            _ => value.clone(),
        };
        Ok(FieldView {
            field_id: row.get(0)?,
            field_key: key,
            section: row.get(2)?,
            label: row.get(3)?,
            sealed: is_sealed_kind(&kind),
            kind,
            value,
            display,
            value_set_at: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
