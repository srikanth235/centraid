//! THE BROWSABLE HALF OF A LOCKER ITEM: what [`crate::phone`]'s loaders read
//! and fold (#1047).
//!
//! Three facts run through every Locker read and are stated once, here:
//!
//! 1. **[`ITEM_COLUMNS`] is the browsable half, and no sealed cell is on it.**
//!    `password`, `otp_seed`, `card_number`, `cvv` and `content` are absent **by
//!    construction rather than stripped afterwards**, so there is one place to
//!    read to know what a Locker list can carry.
//! 2. **Listing is not unlocking.** The phone's statements run on its own rows
//!    under the app grant alone. That is why title, url and username are
//!    plaintext at rest at all: listing and search need no `K`.
//! 3. **A stated window is walked, not clamped** (D-1020-D3-12, R-1020-35).
//!    `MAX_PAGE_ROWS` clamps a page at 500, so a window is walked with
//!    [`centraid_apps_kit::read_window`], which also **reports whether the
//!    window filled**.
//!
//! v0's shelf statements and folds (`Shelf`, `items_answer`, `decorate`,
//! `item_detail` and the tag and alias statements beside them) are deleted
//! (#1047 T2): the phone reads through [`crate::phone`], and a mechanical
//! caller sweep found no production caller for any of them. The frozen parity
//! bundle keeps v0's answers as the record, and `tests/parity.rs` compares
//! them with the phone's loaders.

use centraid_apps_kit::row::{Row, text_of};

/// THE BROWSABLE HALF OF A LOCKER ITEM (#996 wave 4, R8 and W6-D2), as the
/// folded row [`ItemRow`] carries it.
///
/// A Locker item is an entity (#1135), so the row is read from three places and
/// folded: the entity row ([`ENTITY_COLUMNS`]: title, stamps, trash), the kind
/// row ([`KIND_COLUMNS`]) and the vault's `tagged` edges (the star and the
/// archive are flags, the tags are vault tags). **No sealed cell is on this
/// list, or on either statement list.**
pub const ITEM_COLUMNS: &str = "item_id, type, title, username, url, notes, \
     cardholder, expiry, brand, fullname, email, phone, address, network, \
     compromised, password_set_at, starred, memo, last_used_at, created_at, updated_at, \
     archived_at, deleted_at, purge_at";

/// What a statement reads of an item's ENTITY row.
pub const ENTITY_COLUMNS: &str = "id, title, created_at, updated_at, deleted_at, purge_at";

/// What a statement reads of an item's KIND row (`locker_item`): its typed
/// plain columns and the memo, never a sealed cell.
pub const KIND_COLUMNS: &str = "id, type, username, url, notes, cardholder, expiry, brand, \
     fullname, email, phone, address, network, compromised, password_set_at, memo, last_used_at";

/// The five columns of `locker_item` that hold ciphertext under `K`, named here
/// only so [`tests`] can assert none of them is in [`ITEM_COLUMNS`].
pub const SEALED_ITEM_COLUMNS: [&str; 5] =
    ["password", "otp_seed", "card_number", "cvv", "content"];

/// The default and the bounds of the `items` window (`items.ts`, and the
/// manifest's own input schema: 20…2,000, default 300).
pub const ITEMS_DEFAULT: usize = 300;
pub const ITEMS_MIN: usize = 20;
pub const ITEMS_MAX: usize = 2_000;

/// `SEARCH_ROWS` (`search.ts:26`). The shelf the term is matched over.
pub const SEARCH_ROWS: usize = 500;
/// `TRASH_ROWS` (`trash.ts:18`).
pub const TRASH_ROWS: usize = 2_000;

/// Clamp a caller's `limit` the way v0 does: `min(max(limit || default, min), max)`.
#[must_use]
pub fn items_window(limit: Option<i64>) -> usize {
    let asked = match limit {
        Some(value) if value > 0 => usize::try_from(value).unwrap_or(ITEMS_MAX),
        _ => ITEMS_DEFAULT,
    };
    asked.clamp(ITEMS_MIN, ITEMS_MAX)
}

/// One raw `locker_item` row, in the browsable projection.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ItemRow {
    pub item_id: String,
    pub item_type: String,
    pub title: String,
    pub username: Option<String>,
    pub url: Option<String>,
    pub notes: Option<String>,
    pub cardholder: Option<String>,
    pub expiry: Option<String>,
    pub brand: Option<String>,
    pub fullname: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address: Option<String>,
    pub network: Option<String>,
    /// The **one stored security fact** (weak and reused are not scored,
    /// Q-1047-16).
    pub compromised: bool,
    /// When the CURRENT password was set. `None` honestly says "unknown"
    /// rather than claiming an age Review would then reason from.
    pub password_set_at: Option<String>,
    /// Whether the member starred it: the vault's `flag:starred`, a `tagged`
    /// edge, set by `flag.set`.
    pub starred: bool,
    /// The member's plaintext memo, a column of the item.
    pub memo: Option<String>,
    /// When the core last opened one of the item's sealed cells (#1146); a
    /// stamp, not an edit, so `updated_at` does not move with it.
    pub last_used_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// When it was archived: the day the `flag:archived` edge was put on it.
    pub archived_at: Option<String>,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
}

impl ItemRow {
    /// Read one folded row of [`ITEM_COLUMNS`].
    #[must_use]
    pub fn of(row: &Row) -> Self {
        Self {
            item_id: text_of(row, "item_id").unwrap_or_default(),
            item_type: text_of(row, "type").unwrap_or_default(),
            title: text_of(row, "title").unwrap_or_default(),
            username: text_of(row, "username"),
            url: text_of(row, "url"),
            notes: text_of(row, "notes"),
            cardholder: text_of(row, "cardholder"),
            expiry: text_of(row, "expiry"),
            brand: text_of(row, "brand"),
            fullname: text_of(row, "fullname"),
            email: text_of(row, "email"),
            phone: text_of(row, "phone"),
            address: text_of(row, "address"),
            network: text_of(row, "network"),
            compromised: truthy(row, "compromised"),
            password_set_at: text_of(row, "password_set_at"),
            starred: truthy(row, "starred"),
            memo: text_of(row, "memo").filter(|memo| !memo.is_empty()),
            last_used_at: text_of(row, "last_used_at"),
            created_at: text_of(row, "created_at"),
            updated_at: text_of(row, "updated_at"),
            archived_at: text_of(row, "archived_at"),
            deleted_at: text_of(row, "deleted_at"),
            purge_at: text_of(row, "purge_at"),
        }
    }
}

fn truthy(row: &Row, column: &str) -> bool {
    match row.get(column) {
        Some(centraid_apps_kit::row::Cell::Integer(value)) => *value == 1,
        Some(centraid_apps_kit::row::Cell::Text(value)) => value == "1" || value == "true",
        _ => false,
    }
}

/// A safe, secret-free subtitle for a list row (`items.ts`'s `subtitleOf`).
#[must_use]
pub fn subtitle_of(row: &ItemRow) -> String {
    let or_dash = |value: &Option<String>| {
        value
            .as_deref()
            .filter(|text| !text.is_empty())
            .unwrap_or("—")
            .to_owned()
    };
    match row.item_type.as_str() {
        "login" => or_dash(&row.username),
        "card" => "Card".to_owned(),
        "note" => "Secure note".to_owned(),
        "identity" => or_dash(&row.email),
        "wifi" => or_dash(&row.network),
        _ => "Password".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::row::Cell;

    fn row(pairs: &[(&str, &str)]) -> Row {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), Cell::Text((*value).to_owned())))
            .collect()
    }

    /// THE LIST PAYLOAD CANNOT CARRY A SECRET, and this is the assertion that
    /// says so about the projection rather than about a handler's behaviour.
    #[test]
    fn no_sealed_column_is_in_the_browsable_projection() {
        for column in SEALED_ITEM_COLUMNS {
            for list in [ITEM_COLUMNS, KIND_COLUMNS, ENTITY_COLUMNS] {
                assert!(
                    !list.split(", ").any(|named| named.trim() == column),
                    "{column} is a sealed cell and it is in a browsable list"
                );
            }
        }
        // The two sidecar sealed columns are not on it either.
        for column in ["value_sealed", "private_key"] {
            assert!(
                !ITEM_COLUMNS.contains(column),
                "{column} is in ITEM_COLUMNS"
            );
        }
        // …and the browsable half is still the browsable half.
        for column in ["title", "username", "url", "notes", "email", "network"] {
            assert!(ITEM_COLUMNS.contains(column), "{column} is missing");
        }
    }

    #[test]
    fn the_windows_clamp_the_way_v0_clamps() {
        assert_eq!(items_window(None), 300);
        assert_eq!(items_window(Some(0)), 300);
        assert_eq!(items_window(Some(5)), 20);
        assert_eq!(items_window(Some(400)), 400);
        assert_eq!(items_window(Some(99_999)), 2_000);
    }

    /// A card's subtitle is a word: its last four digits are sealed.
    #[test]
    fn a_card_subtitle_is_a_word_and_a_bare_login_a_dash() {
        let card = ItemRow {
            item_type: "card".to_owned(),
            ..ItemRow::default()
        };
        assert_eq!(subtitle_of(&card), "Card");
        let login = ItemRow {
            item_type: "login".to_owned(),
            username: None,
            ..ItemRow::default()
        };
        assert_eq!(subtitle_of(&login), "—");
    }

    /// THE ROW LEVEL, where a planted plaintext sealed value is visible. A row
    /// that carries all five sealed cells as readable words, read the way a shelf
    /// reads a row, must hold none of them in any field: `ItemRow::of` reads no
    /// sealed key into the row. (The core test of the same property sees
    /// ciphertext after the relock, so it cannot notice a sealed cell joining a
    /// row; this one can. The index's side of it is the vault's plaintext gate.)
    #[test]
    fn a_planted_sealed_value_joins_no_field_of_the_row() {
        let planted: Vec<(String, String)> = SEALED_ITEM_COLUMNS
            .iter()
            .map(|column| ((*column).to_owned(), format!("plaintext-of-{column}")))
            .collect();
        let mut pairs: Vec<(&str, &str)> = vec![
            ("item_id", "i1"),
            ("type", "login"),
            ("title", "Bank"),
            ("username", "ada"),
            ("url", "https://bank.example"),
            ("notes", "a note"),
            ("fullname", "Ada Lovelace"),
            ("email", "ada@mail.test"),
            ("phone", "555-0100"),
            ("brand", "Visa"),
        ];
        pairs.extend(planted.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        let item = ItemRow::of(&row(&pairs));
        let shown = format!("{item:?}");
        for (column, value) in &planted {
            assert!(
                !shown.contains(value.as_str()),
                "the sealed {column} is in a field of the row"
            );
        }
        // The control: the typed texts of the same row are all read.
        assert!(shown.contains("Lovelace") && shown.contains("mail.test"));
    }

    #[test]
    fn nothing_searchable_is_a_sealed_column() {
        // The projection a search reads carries no sealed cell, so no sealed
        // cell can be matched or offered as a correction.
        for sealed in SEALED_ITEM_COLUMNS {
            assert!(
                !ITEM_COLUMNS
                    .split(',')
                    .any(|column| column.trim() == sealed),
                "{sealed} is on the browsable projection"
            );
        }
    }
}
