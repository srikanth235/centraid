//! THE BROWSABLE HALF OF A LOCKER ITEM, AND THE AUDIT WINDOW: what
//! [`crate::phone`]'s loaders read and fold (#1047).
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

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::in_list;
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::types::{AUTH_ENTITY_TYPE, ITEM_ENTITY_TYPE};

/// THE BROWSABLE HALF OF A LOCKER ITEM (#996 wave 4, R8 and W6-D2).
///
/// A statement names its columns, and **no sealed cell is on this list**.
pub const ITEM_COLUMNS: &str = "item_id, type, title, username, url, notes, \
     cardholder, expiry, brand, fullname, email, phone, address, network, \
     compromised, password_set_at, created_at, updated_at, \
     archived_at, deleted_at, purge_at";

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
/// `access.ts:20`-`:21` — the default and the ceiling of the audit window.
pub const ACCESS_DEFAULT: usize = 200;
pub const ACCESS_MAX: usize = 2_000;

/// The two concept schemes, and the star's notation.
///
/// Restated here because `_shared/concept-scheme-kit.ts` is an import-free leaf
/// on the v0 side too. **The two URIs are spelled differently and that is
/// deliberate**: the flags scheme is an `https` URI because flag SQL fragments
/// are interpolated into condition SQL, where a `urn:`-style `:flags` reads as
/// a NAMED PARAMETER (#258, the colon-literal trap).
pub const FLAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/flags";
pub const LOCKER_TAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/locker-tags";
pub const STARRED_NOTATION: &str = "starred";

/// Clamp a caller's `limit` the way v0 does: `min(max(limit || default, min), max)`.
#[must_use]
pub fn items_window(limit: Option<i64>) -> usize {
    let asked = match limit {
        Some(value) if value > 0 => usize::try_from(value).unwrap_or(ITEMS_MAX),
        _ => ITEMS_DEFAULT,
    };
    asked.clamp(ITEMS_MIN, ITEMS_MAX)
}

/// The same clamp for the audit window (`access.ts:22`-`:25`).
#[must_use]
pub fn access_window(limit: Option<i64>) -> usize {
    let asked = match limit {
        Some(value) if value > 0 => usize::try_from(value).unwrap_or(ACCESS_MAX),
        _ => ACCESS_DEFAULT,
    };
    asked.clamp(ITEMS_MIN, ACCESS_MAX)
}

/// THE AUDIT WINDOW, AND THE INNER OF ITS TWO WALLS (census §A8).
///
/// The manifest's `rowFilter` on `object_type` is the outer wall, carried per
/// call as the page door's execution clamp. This predicate names the same two
/// types **in the statement**, so the page is filtered *before* the window
/// rather than after — without it a busy vault's newest 200 receipts could be
/// entirely someone else's and the clamp would hand this screen an empty
/// history.
pub fn access_statement(item_id: Option<&str>) -> KitResult<PageQuery> {
    let types = in_list(
        "object_type",
        &[ITEM_ENTITY_TYPE.to_owned(), AUTH_ENTITY_TYPE.to_owned()],
    )?;
    let (predicate, mut bind) = match item_id {
        Some(id) if !id.is_empty() => (format!("{} AND object_id = ?", types.sql), {
            let mut bind = types.bind;
            bind.push(PageBindValue::Text(id.to_owned()));
            bind
        }),
        _ => (types.sql, types.bind),
    };
    bind.shrink_to_fit();
    Ok(PageQuery::new(
        "locker.access.receipts",
        "receipt_id, action, object_type, object_id, decision, occurred_at, detail_json",
        "access_receipt",
        PageOrder::desc("occurred_at", "receipt_id"),
    )
    .filter(&predicate, bind))
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
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub archived_at: Option<String>,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
}

impl ItemRow {
    /// Read one row of [`ITEM_COLUMNS`].
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
            created_at: text_of(row, "created_at"),
            updated_at: text_of(row, "updated_at"),
            archived_at: text_of(row, "archived_at"),
            deleted_at: text_of(row, "deleted_at"),
            purge_at: text_of(row, "purge_at"),
        }
    }

    /// Whether the term matches this row, over the three columns v0 matches
    /// over — title, username and url — case-insensitively.
    #[must_use]
    pub fn matches(&self, term: &str) -> bool {
        let hit = |value: &str| value.to_lowercase().contains(term);
        hit(&self.title)
            || self.username.as_deref().is_some_and(hit)
            || self.url.as_deref().is_some_and(hit)
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

/// One audit entry, and which of the two things it records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessKind {
    /// An unlock. `object_type = locker.auth`.
    Auth,
    /// A reveal in the app.
    Reveal,
}

impl AccessKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Reveal => "reveal",
        }
    }
}

/// One row of the access history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessEntry {
    pub receipt_id: String,
    pub kind: AccessKind,
    pub action: String,
    /// `allow` or `deny`, and **anything that is not `deny` reads as `allow`**
    /// — v0's own coercion, kept because a third value must not read as a
    /// refusal that did not happen.
    pub allowed: bool,
    pub item_id: Option<String>,
    pub occurred_at: Option<String>,
    pub columns: Option<Vec<String>>,
    pub reason: Option<String>,
    /// The receipt's `context.derivation`: `totp` for a one-time code,
    /// `export` for an export (#1047 T2).
    pub derivation: Option<String>,
    /// The value went to the clipboard (`context.use = "copy"`, #1047 T2).
    pub copied: bool,
    /// The custom field a reveal opened (#1047 T2).
    pub field_id: Option<String>,
}

/// What the `access` query answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessAnswer {
    pub entries: Vec<AccessEntry>,
    pub window: usize,
    pub truncated: bool,
}

/// Fold the audit window.
///
/// The re-sort is v0's and is kept: the page already comes back
/// `occurred_at DESC`, and the fold sorts again by the same key so two receipts
/// in one millisecond land in a stable order rather than the keyset's.
#[must_use]
pub fn access_answer(window: usize, rows: &[Row]) -> AccessAnswer {
    let mut entries: Vec<AccessEntry> = rows
        .iter()
        .map(|row| {
            let object_type = text_of(row, "object_type").unwrap_or_default();
            let detail = text_of(row, "detail_json")
                .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                .unwrap_or(serde_json::Value::Null);
            let kind = if object_type == AUTH_ENTITY_TYPE {
                AccessKind::Auth
            } else {
                AccessKind::Reveal
            };
            AccessEntry {
                receipt_id: text_of(row, "receipt_id").unwrap_or_default(),
                kind,
                action: text_of(row, "action").unwrap_or_default(),
                allowed: text_of(row, "decision").as_deref() != Some("deny"),
                item_id: if object_type == ITEM_ENTITY_TYPE {
                    text_of(row, "object_id")
                } else {
                    None
                },
                occurred_at: text_of(row, "occurred_at"),
                columns: detail["columns"].as_array().map(|columns| {
                    columns
                        .iter()
                        .map(|column| match column.as_str() {
                            Some(text) => text.to_owned(),
                            None => column.to_string(),
                        })
                        .collect()
                }),
                reason: detail["failing"].as_str().map(str::to_owned),
                derivation: detail["context"]["derivation"].as_str().map(str::to_owned),
                copied: detail["context"]["use"].as_str() == Some("copy"),
                field_id: detail["field_id"].as_str().map(str::to_owned),
            }
        })
        .collect();
    entries.sort_by(|left, right| {
        right
            .occurred_at
            .cmp(&left.occurred_at)
            .then_with(|| left.receipt_id.cmp(&right.receipt_id))
    });
    AccessAnswer {
        truncated: rows.len() >= window,
        window,
        entries,
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
            assert!(
                !ITEM_COLUMNS.split(", ").any(|named| named.trim() == column),
                "{column} is a sealed cell and it is in ITEM_COLUMNS"
            );
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

    /// THE INNER WALL. Without the predicate the clamp filters AFTER the
    /// window and a busy vault's newest 200 receipts are someone else's.
    #[test]
    fn the_audit_statement_names_both_object_types_in_sql() {
        let query = access_statement(None).expect("the statement builds");
        let predicate = query.r#where.clone().expect("a predicate");
        assert_eq!(predicate, "object_type IN (?, ?)");
        assert_eq!(query.bind.len(), 2);
        let pinned = access_statement(Some("item-1")).expect("the statement builds");
        assert_eq!(
            pinned.r#where.as_deref(),
            Some("object_type IN (?, ?) AND object_id = ?")
        );
        assert_eq!(pinned.bind.len(), 3);
        // An empty id is not a filter, it is no filter.
        assert_eq!(access_statement(Some("")).expect("builds").bind.len(), 2);
    }

    #[test]
    fn the_windows_clamp_the_way_v0_clamps() {
        assert_eq!(items_window(None), 300);
        assert_eq!(items_window(Some(0)), 300);
        assert_eq!(items_window(Some(5)), 20);
        assert_eq!(items_window(Some(400)), 400);
        assert_eq!(items_window(Some(99_999)), 2_000);
        assert_eq!(access_window(None), 200);
        assert_eq!(access_window(Some(1)), 20);
        assert_eq!(access_window(Some(9_999)), 2_000);
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

    #[test]
    fn the_search_fold_matches_title_username_and_url_only() {
        let row = ItemRow {
            item_id: "i1".to_owned(),
            title: "Bank".to_owned(),
            username: Some("ada@example.com".to_owned()),
            url: Some("https://bank.example".to_owned()),
            notes: Some("a memorable note".to_owned()),
            ..ItemRow::default()
        };
        assert!(row.matches("bank"));
        assert!(row.matches("ada@"));
        assert!(row.matches("bank.example"));
        // `notes` is plaintext and is NOT matched, exactly as v0 does not.
        assert!(!row.matches("memorable"));
    }

    #[test]
    fn an_auth_receipt_names_no_item_and_a_reveal_names_its_cell() {
        let rows = vec![
            row(&[
                ("receipt_id", "r2"),
                ("action", "reveal"),
                ("object_type", "locker.item"),
                ("object_id", "i1"),
                ("decision", "allow"),
                ("occurred_at", "2026-01-02T00:00:00.000Z"),
                (
                    "detail_json",
                    r#"{"context":{"kind":"reveal"},"columns":["password"]}"#,
                ),
            ]),
            row(&[
                ("receipt_id", "r1"),
                ("action", "unlock"),
                ("object_type", "locker.auth"),
                ("decision", "deny"),
                ("occurred_at", "2026-01-01T00:00:00.000Z"),
                (
                    "detail_json",
                    r#"{"failing":"the passphrase did not match"}"#,
                ),
            ]),
        ];
        let answer = access_answer(200, &rows);
        assert_eq!(answer.entries.len(), 2);
        assert_eq!(answer.entries[0].kind, AccessKind::Reveal);
        assert_eq!(
            answer.entries[0].columns.as_deref(),
            Some(&["password".to_owned()][..])
        );
        assert_eq!(answer.entries[0].item_id.as_deref(), Some("i1"));
        assert_eq!(answer.entries[1].kind, AccessKind::Auth);
        assert!(!answer.entries[1].allowed);
        // An auth receipt names no item, because it is about the vault.
        assert_eq!(answer.entries[1].item_id, None);
        assert!(!answer.truncated);
    }

    /// A CODE, A COPY AND A FIELD ARE NAMED AS SUCH (#1047 T2), from what
    /// the receipt's detail already says — never from a value.
    #[test]
    fn a_code_a_copy_and_a_field_are_read_off_the_receipt() {
        let rows = vec![
            row(&[
                ("receipt_id", "r3"),
                ("action", "reveal locker.totp_code"),
                ("object_type", "locker.item"),
                ("object_id", "i1"),
                ("decision", "allow"),
                ("occurred_at", "2026-01-03T00:00:00.000Z"),
                (
                    "detail_json",
                    r#"{"columns":["otp_seed"],"context":{"kind":"reveal","derivation":"totp","use":"copy"}}"#,
                ),
            ]),
            row(&[
                ("receipt_id", "r2"),
                ("action", "reveal locker.item"),
                ("object_type", "locker.item"),
                ("object_id", "i1"),
                ("decision", "allow"),
                ("occurred_at", "2026-01-02T00:00:00.000Z"),
                (
                    "detail_json",
                    r#"{"columns":["value_sealed"],"field_id":"f1","context":{"kind":"reveal","use":"show"}}"#,
                ),
            ]),
        ];
        let answer = access_answer(200, &rows);
        assert_eq!(answer.entries[0].derivation.as_deref(), Some("totp"));
        assert!(answer.entries[0].copied);
        assert_eq!(answer.entries[1].field_id.as_deref(), Some("f1"));
        assert!(!answer.entries[1].copied);
        assert_eq!(answer.entries[1].derivation, None);
    }

    #[test]
    fn a_full_window_says_it_is_truncated() {
        let rows: Vec<Row> = (0..3)
            .map(|index| {
                row(&[
                    ("receipt_id", "r"),
                    ("action", "reveal"),
                    ("object_type", "locker.item"),
                    ("decision", "allow"),
                    ("occurred_at", "2026-01-01T00:00:00.000Z"),
                ])
                .into_iter()
                .chain([("object_id".to_owned(), Cell::Text(format!("i{index}")))])
                .collect()
            })
            .collect();
        assert!(access_answer(3, &rows).truncated);
        assert!(!access_answer(4, &rows).truncated);
    }
}
