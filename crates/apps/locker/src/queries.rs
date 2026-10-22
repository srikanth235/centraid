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
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

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
     compromised, password_set_at, starred, memo, created_at, updated_at, \
     archived_at, deleted_at, purge_at";

/// What a statement reads of an item's ENTITY row.
pub const ENTITY_COLUMNS: &str = "id, title, created_at, updated_at, deleted_at, purge_at";

/// What a statement reads of an item's KIND row (`locker_item`): its typed
/// plain columns and the memo, never a sealed cell.
pub const KIND_COLUMNS: &str = "id, type, username, url, notes, cardholder, expiry, brand, \
     fullname, email, phone, address, network, compromised, password_set_at, memo";

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

/// THE AUDIT WINDOW: Locker's own `receipt` table, newest first.
///
/// A receipt is Locker's evidence and nothing else's, so there is no type wall
/// to carry: the table is the wall. A page for one item names it
/// (`item_id = ?`); the whole history takes no predicate, and an export or an
/// unlock, which name no item, are in it.
pub fn access_statement(item_id: Option<&str>) -> KitResult<PageQuery> {
    let query = PageQuery::new(
        "locker.access.receipts",
        "seq, at, item_id, act",
        "receipt",
        PageOrder::desc("at", "seq"),
    );
    Ok(match item_id {
        Some(id) if !id.is_empty() => {
            query.filter("item_id = ?", vec![PageBindValue::Text(id.to_owned())])
        }
        _ => query,
    })
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
            created_at: text_of(row, "created_at"),
            updated_at: text_of(row, "updated_at"),
            archived_at: text_of(row, "archived_at"),
            deleted_at: text_of(row, "deleted_at"),
            purge_at: text_of(row, "purge_at"),
        }
    }

    /// The plain texts a search reads on this row: title, username and address
    /// (v0's three) and, since #1097 (R6), the note, the full name, the email,
    /// the phone and the card brand a member typed.
    ///
    /// **Never a sealed cell**: this reads the browsable half only, so
    /// `password`, `otp_seed`, `card_number`, `cvv` and `content` cannot be
    /// matched or offered as a correction — they are not on [`ITEM_COLUMNS`].
    /// `cardholder`, `address`, `network` and `expiry` are not searched.
    /// The memo and the aliases are other tables' rows and are the walker's.
    pub fn searchable(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.title.as_str()).chain(
            [
                &self.username,
                &self.url,
                &self.notes,
                &self.fullname,
                &self.email,
                &self.phone,
                &self.brand,
            ]
            .into_iter()
            .filter_map(|value| value.as_deref()),
        )
    }

    /// Whether the term (already lowercased) matches this row's
    /// [`searchable`](Self::searchable) texts, case-insensitively.
    #[must_use]
    pub fn matches(&self, term: &str) -> bool {
        self.searchable()
            .any(|value| value.to_lowercase().contains(term))
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

/// One audit entry, and which of the four things it records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessKind {
    /// An unlock (`unlock`, `unlock_refused`).
    Auth,
    /// A reveal or a copy of one sealed cell in the app.
    Reveal,
    /// A one-time code made from an item's seed (`code`, `code_copy`).
    Code,
    /// Every secret into a file (`export`): the one
    /// receipt that names the whole Locker and no item (#1047 T2).
    Export,
}

impl AccessKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Reveal => "reveal",
            Self::Code => "code",
            Self::Export => "export",
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
    /// The item's title as it is now, when the history was asked of the whole
    /// Locker ([`crate::phone::load_access`] with no item): `None` for an
    /// unlock or an export, which name no item, and for an item the vault no
    /// longer holds. A receipt itself names the item by id only.
    pub item_title: Option<String>,
    /// The custom field's label as it is now; `None` when none was opened, the
    /// history was one item's (its page names its own fields) or the field is
    /// gone.
    pub field_label: Option<String>,
}

/// What the `access` query answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessAnswer {
    pub entries: Vec<AccessEntry>,
    pub window: usize,
    pub truncated: bool,
}

/// What a receipt's `act` says: the verb, the cells that were opened, and the
/// custom field when one was. `crates/vault`'s `locker.reveal_receipt` writes it
/// as `<verb>[ <column>[,<column>…][ <field id>]]`, names and never values.
struct Act<'a> {
    verb: &'a str,
    columns: Vec<String>,
    field_id: Option<String>,
}

fn act_of(act: &str) -> Act<'_> {
    let mut words = act.split(' ');
    let verb = words.next().unwrap_or_default();
    let columns = words
        .next()
        .map(|columns| columns.split(',').map(str::to_owned).collect())
        .unwrap_or_default();
    Act {
        verb,
        columns,
        field_id: words.next().map(str::to_owned),
    }
}

/// Fold the audit window.
///
/// The re-sort is v0's and is kept: the page already comes back
/// `at DESC`, and the fold sorts again by the same key so two receipts in one
/// millisecond land in a stable order rather than the keyset's.
#[must_use]
pub fn access_answer(window: usize, rows: &[Row]) -> AccessAnswer {
    let mut entries: Vec<AccessEntry> = rows
        .iter()
        .map(|row| {
            let act = text_of(row, "act").unwrap_or_default();
            let parsed = act_of(&act);
            // THE KIND IS READ OFF THE VERB the command wrote.
            let (kind, derivation) = match parsed.verb {
                "unlock" | "unlock_refused" => (AccessKind::Auth, None),
                "export" => (AccessKind::Export, Some("export")),
                "code" | "code_copy" => (AccessKind::Code, Some("totp")),
                _ => (AccessKind::Reveal, None),
            };
            AccessEntry {
                receipt_id: text_of(row, "seq").unwrap_or_default(),
                kind,
                action: parsed.verb.to_owned(),
                allowed: !parsed.verb.ends_with("_refused"),
                // AN EXPORT NAMES NO ITEM, and neither does an unlock: their
                // receipts carry none.
                item_id: text_of(row, "item_id"),
                occurred_at: text_of(row, "at"),
                columns: (!parsed.columns.is_empty()).then_some(parsed.columns),
                // The sentence a refusal said is in the journal row the receipt
                // names, and is not copied here.
                reason: None,
                derivation: derivation.map(str::to_owned),
                copied: matches!(parsed.verb, "copy" | "code_copy"),
                field_id: parsed.field_id,
                item_title: None,
                field_label: None,
            }
        })
        .collect();
    entries.sort_by(|left, right| {
        right.occurred_at.cmp(&left.occurred_at).then_with(|| {
            // `seq` is a number: a later receipt sorts first on a tie.
            let seq = |entry: &AccessEntry| entry.receipt_id.parse::<i64>().unwrap_or_default();
            seq(right).cmp(&seq(left))
        })
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

    /// THE AUDIT STATEMENT READS LOCKER'S OWN TABLE and narrows to an item
    /// only when asked: the table is the wall.
    #[test]
    fn the_audit_statement_reads_the_receipt_table_and_narrows_to_one_item_on_request() {
        let whole = access_statement(None).expect("the statement builds");
        assert_eq!(whole.from, "receipt");
        assert!(whole.r#where.is_none());
        let pinned = access_statement(Some("item-1")).expect("the statement builds");
        assert_eq!(pinned.r#where.as_deref(), Some("item_id = ?"));
        assert_eq!(pinned.bind.len(), 1);
        // An empty id is not a filter, it is no filter.
        assert!(
            access_statement(Some(""))
                .expect("builds")
                .r#where
                .is_none()
        );
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
    fn the_search_fold_matches_what_a_member_typed_and_nothing_else() {
        let row = ItemRow {
            item_id: "i1".to_owned(),
            title: "Bank".to_owned(),
            username: Some("ada@example.com".to_owned()),
            url: Some("https://bank.example".to_owned()),
            notes: Some("a memorable note".to_owned()),
            fullname: Some("Ada Lovelace".to_owned()),
            email: Some("ada.l@mail.test".to_owned()),
            phone: Some("555-0100".to_owned()),
            brand: Some("Visa".to_owned()),
            cardholder: Some("Cardholder Name".to_owned()),
            address: Some("12 Analytical Way".to_owned()),
            network: Some("HomeNet".to_owned()),
            expiry: Some("04/27".to_owned()),
            ..ItemRow::default()
        };
        // v0's three, and (#1097, R6) the note, name, email, phone and brand.
        for found in [
            "bank",
            "ada@",
            "bank.example",
            "memorable",
            "lovelace",
            "mail.test",
            "555-01",
            "visa",
        ] {
            assert!(row.matches(found), "{found} is typed text of the item");
        }
        // The columns a search does not read.
        for not in ["cardholder", "analytical", "homenet", "04/27"] {
            assert!(!row.matches(not), "{not} is not searched");
        }
    }

    /// THE WALKER LEVEL, where a planted plaintext sealed value is visible. A
    /// row that carries all five sealed cells as readable words, read the way the
    /// walker reads a row, must put none of them in the texts a search matches or
    /// offers as a correction: `ItemRow::of` reads no sealed key into any field.
    /// (The core test of the same property sees ciphertext after the relock, so
    /// it cannot notice a sealed cell joining the walk; this one can.)
    #[test]
    fn a_planted_sealed_value_joins_no_searched_text() {
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
        for (column, value) in &planted {
            assert!(
                item.searchable().all(|text| !text.contains(value.as_str())),
                "the sealed {column} is in a text a search reads"
            );
            assert!(
                !item.matches(&value.to_lowercase()),
                "the sealed {column} is matched"
            );
        }
        // The control: the typed texts of the same row are all read.
        assert_eq!(item.searchable().count(), 8);
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

    fn receipt(seq: &str, at: &str, item: Option<&str>, act: &str) -> Row {
        let mut cells = row(&[("seq", seq), ("at", at), ("act", act)]);
        if let Some(item) = item {
            cells.insert("item_id".to_owned(), Cell::Text(item.to_owned()));
        }
        cells
    }

    #[test]
    fn an_auth_receipt_names_no_item_and_a_reveal_names_its_cell() {
        let rows = vec![
            receipt(
                "2",
                "2026-01-02T00:00:00.000Z",
                Some("item-1"),
                "reveal password",
            ),
            receipt("1", "2026-01-01T00:00:00.000Z", None, "unlock"),
        ];
        let answer = access_answer(200, &rows);
        let reveal = &answer.entries[0];
        assert_eq!(reveal.kind, AccessKind::Reveal);
        assert_eq!(reveal.item_id.as_deref(), Some("item-1"));
        assert_eq!(
            reveal.columns.as_deref(),
            Some(&["password".to_owned()][..])
        );
        assert!(reveal.allowed && !reveal.copied);
        let unlock = &answer.entries[1];
        assert_eq!(unlock.kind, AccessKind::Auth);
        // An auth receipt names no item, because it is about the vault.
        assert_eq!(unlock.item_id, None);
        assert_eq!(unlock.columns, None);
        assert_eq!(unlock.receipt_id, "1");
    }

    /// WHAT THE VERB SAYS, never a value: a code, a copy, a field and a refusal
    /// are read off the act `crates/vault` wrote.
    #[test]
    fn a_code_a_copy_and_a_field_are_read_off_the_receipt() {
        let rows = vec![
            receipt(
                "4",
                "2026-01-04T00:00:00.000Z",
                Some("item-1"),
                "code_copy otp_seed",
            ),
            receipt(
                "3",
                "2026-01-03T00:00:00.000Z",
                Some("item-1"),
                "copy value_sealed field-1",
            ),
            receipt(
                "2",
                "2026-01-02T00:00:00.000Z",
                Some("item-1"),
                "code otp_seed",
            ),
            receipt(
                "1",
                "2026-01-01T00:00:00.000Z",
                Some("item-1"),
                "reveal_refused password",
            ),
        ];
        let answer = access_answer(200, &rows);
        let by_id = |id: &str| {
            answer
                .entries
                .iter()
                .find(|entry| entry.receipt_id == id)
                .expect("an entry")
        };
        assert_eq!(by_id("4").kind, AccessKind::Code);
        assert!(by_id("4").copied, "a copied code");
        assert_eq!(by_id("4").derivation.as_deref(), Some("totp"));
        assert!(!by_id("2").copied, "a shown code");
        assert_eq!(by_id("3").field_id.as_deref(), Some("field-1"));
        assert!(by_id("3").copied);
        assert_eq!(
            by_id("3").columns.as_deref(),
            Some(&["value_sealed".to_owned()][..])
        );
        assert!(!by_id("1").allowed, "a refused reveal reads as a refusal");
    }

    #[test]
    fn an_unlock_an_export_a_code_and_a_reveal_are_four_kinds() {
        let rows = vec![
            receipt("4", "2026-01-04T00:00:00.000Z", None, "export"),
            receipt("3", "2026-01-03T00:00:00.000Z", None, "unlock_refused"),
            receipt("2", "2026-01-02T00:00:00.000Z", Some("i"), "code otp_seed"),
            receipt("1", "2026-01-01T00:00:00.000Z", Some("i"), "reveal cvv"),
        ];
        let kinds: Vec<(AccessKind, bool)> = access_answer(200, &rows)
            .entries
            .iter()
            .map(|entry| (entry.kind, entry.allowed))
            .collect();
        assert_eq!(
            kinds,
            [
                (AccessKind::Export, true),
                (AccessKind::Auth, false),
                (AccessKind::Code, true),
                (AccessKind::Reveal, true),
            ]
        );
        // AN EXPORT NAMES NO ITEM, and its derivation says so.
        let export = &access_answer(200, &rows).entries[0];
        assert_eq!(export.item_id, None);
        assert_eq!(export.derivation.as_deref(), Some("export"));
        // A fold over receipts alone holds ids, never names.
        assert!(
            access_answer(200, &rows)
                .entries
                .iter()
                .all(|entry| entry.item_title.is_none() && entry.field_label.is_none())
        );
    }

    #[test]
    fn a_full_window_says_it_is_truncated() {
        let rows: Vec<Row> = (0..3)
            .map(|index| {
                receipt(
                    &index.to_string(),
                    "2026-01-01T00:00:00.000Z",
                    Some(&format!("i{index}")),
                    "reveal password",
                )
            })
            .collect();
        assert!(access_answer(3, &rows).truncated);
        assert!(!access_answer(4, &rows).truncated);
    }
}
