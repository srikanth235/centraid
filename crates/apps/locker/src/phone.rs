//! THE PHONE'S FOUR QUERIES (#1047, wave L1): the loaders `crates/core`'s
//! `app_query` asks, and the folds behind them.
//!
//! The phone is the vault (#1029), so these run on the phone's own rows through
//! the core's page door — there is no gateway and no replica. What does not change is this crate's founding rule: **the list is
//! metadata; the secret is not.** Every statement here projects
//! [`ITEM_COLUMNS`] and, where a secret's existence matters, its PRESENCE
//! through the grammar's one sealed operand (`<cell> IS NOT NULL AS …`). No
//! loader here ever holds a sealed cell's ciphertext, let alone its value.
//!
//! Every window is WALKED ([`read_window`]) and says whether it filled, so a
//! count that reached its ceiling is answered as unknown rather than as the
//! ceiling ([`ItemsData::total`]).

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, read_by_id, read_window};
use centraid_apps_kit::row::{Cell, Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::queries::{
    AccessAnswer, FLAGS_SCHEME_URI, ITEM_COLUMNS, ITEMS_MAX, ItemRow, LOCKER_TAGS_SCHEME_URI,
    SEALED_ITEM_COLUMNS, SEARCH_ROWS, STARRED_NOTATION, TRASH_ROWS, access_answer,
    access_statement, access_window, items_window, subtitle_of,
};
use crate::transfer::{Entry, EntryField, EntryPasskey, Existing, type_columns};
use crate::types::{ITEM_ENTITY_TYPE, ITEM_TYPES, degrade_type, degraded_from};

/// How many tag, concept and alias rows a list walks before it stops. A tag
/// set this large is a vault the phone reads the first part of, and says so
/// nowhere a member would act on — tags decorate; they do not total.
pub const DECORATION_ROWS: usize = 4_000;

/// The search answer's default and ceiling.
pub const SEARCH_DEFAULT: usize = 50;
/// The review walks at most this many live and archived items (v0's review
/// ceiling); `ReviewData::truncated` says when it stopped.
pub const REVIEW_ROWS: usize = 2_000;

/// The sealed item cells each of the six original types carries, in the order
/// the item pane draws them. The nine template types (L-type) carry none of
/// their own: their secrets are sealed FIELDS.
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

/// Every sealed item cell, as the presence projection names it.
const PRESENCE_COLUMNS: &str = "item_id, password IS NOT NULL AS has_password, \
     otp_seed IS NOT NULL AS has_otp_seed, card_number IS NOT NULL AS has_card_number, \
     cvv IS NOT NULL AS has_cvv, content IS NOT NULL AS has_content";

// ---------------------------------------------------------------------------
// Statements.
// ---------------------------------------------------------------------------

/// Every item that is not in the trash — live and archived — newest first.
#[must_use]
pub fn shelves_statement() -> PageQuery {
    PageQuery::new(
        "locker.phone.shelves",
        ITEM_COLUMNS,
        "locker_item",
        PageOrder::desc("updated_at", "item_id"),
    )
    .filter("deleted_at IS NULL", Vec::new())
}

/// The trash, for its count only.
#[must_use]
pub fn trashed_statement() -> PageQuery {
    PageQuery::new(
        "locker.phone.trashed",
        "item_id, updated_at",
        "locker_item",
        PageOrder::desc("updated_at", "item_id"),
    )
    .filter("deleted_at IS NOT NULL", Vec::new())
}

/// Every tag row on a Locker item. The star rides the same table (a
/// flags-scheme concept) and is told apart by its concept.
#[must_use]
pub fn tag_rows_statement() -> PageQuery {
    PageQuery::new(
        "locker.phone.tags",
        "tag_id, target_id, concept_id",
        "core_tag",
        PageOrder::asc("tag_id", "tag_id"),
    )
    .filter(
        "target_type = ?",
        vec![PageBindValue::Text(ITEM_ENTITY_TYPE.to_owned())],
    )
}

/// The two schemes Locker reads: its own tags and the flags.
#[must_use]
pub fn schemes_statement() -> PageQuery {
    PageQuery::new(
        "locker.phone.schemes",
        "scheme_id, uri",
        "core_concept_scheme",
        PageOrder::asc("scheme_id", "scheme_id"),
    )
    .filter(
        "uri IN (?, ?)",
        vec![
            PageBindValue::Text(LOCKER_TAGS_SCHEME_URI.to_owned()),
            PageBindValue::Text(FLAGS_SCHEME_URI.to_owned()),
        ],
    )
}

/// The concepts of the schemes [`schemes_statement`] found.
#[must_use]
pub fn concepts_statement(scheme_ids: &[String]) -> PageQuery {
    let placeholders = vec!["?"; scheme_ids.len()].join(", ");
    PageQuery::new(
        "locker.phone.concepts",
        "concept_id, scheme_id, pref_label, notation",
        "core_concept",
        PageOrder::asc("concept_id", "concept_id"),
    )
    .filter(
        &format!("scheme_id IN ({placeholders})"),
        scheme_ids
            .iter()
            .map(|id| PageBindValue::Text(id.clone()))
            .collect(),
    )
}

/// Every connector alias.
#[must_use]
pub fn aliases_statement() -> PageQuery {
    PageQuery::new(
        "locker.phone.aliases",
        "alias, item_id",
        "locker_item_alias",
        PageOrder::asc("alias", "alias"),
    )
}

/// One item's secrets, as presence.
#[must_use]
pub fn presence_statement(item_id: &str) -> PageQuery {
    by_item(
        "locker.phone.presence",
        PRESENCE_COLUMNS,
        "locker_item",
        "item_id",
        item_id,
    )
}

/// One item's custom fields, a sealed value as its presence.
#[must_use]
pub fn fields_statement(item_id: &str) -> PageQuery {
    by_item(
        "locker.phone.fields",
        "field_id, item_id, section, label, kind, value_text, \
         value_sealed IS NOT NULL AS has_sealed, position",
        "locker_item_field",
        "field_id",
        item_id,
    )
}

/// One login's additional addresses.
#[must_use]
pub fn addresses_statement(item_id: &str) -> PageQuery {
    by_item(
        "locker.phone.addresses",
        "address_id, item_id, url, position",
        "locker_item_address",
        "address_id",
        item_id,
    )
}

/// One item's passkey slot, key material as its presence.
#[must_use]
pub fn passkey_statement(item_id: &str) -> PageQuery {
    by_item(
        "locker.phone.passkey",
        "item_id, rp_id, user_handle, display_name, credential_id, algorithm, created_at, \
         private_key IS NOT NULL AS has_private_key",
        "locker_item_passkey",
        "item_id",
        item_id,
    )
}

/// Every item not in the trash, each sealed cell as its presence — what an
/// import's plan compares a file against (#1047 T2).
#[must_use]
pub fn presence_all_statement() -> PageQuery {
    PageQuery::new(
        "locker.phone.presence_all",
        PRESENCE_COLUMNS,
        "locker_item",
        PageOrder::asc("item_id", "item_id"),
    )
    .filter("deleted_at IS NULL", Vec::new())
}

/// One item's memo (`knowledge.annotation`, `locker.set_memo`'s row).
#[must_use]
pub fn memo_statement(item_id: &str) -> PageQuery {
    PageQuery::new(
        "locker.phone.memo",
        "annotation_id, body_text, updated_at",
        "knowledge_annotation",
        PageOrder::desc("updated_at", "annotation_id"),
    )
    .filter(
        "target_type = ? AND target_id = ?",
        vec![
            PageBindValue::Text(ITEM_ENTITY_TYPE.to_owned()),
            PageBindValue::Text(item_id.to_owned()),
        ],
    )
}

fn by_item(name: &str, select: &str, from: &str, pk: &str, item_id: &str) -> PageQuery {
    PageQuery::new(name, select, from, PageOrder::asc(pk, pk))
        .filter("item_id = ?", vec![PageBindValue::Text(item_id.to_owned())])
}

// ---------------------------------------------------------------------------
// What the loaders answer.
// ---------------------------------------------------------------------------

/// One stored address beside a login's primary one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Address {
    pub address_id: String,
    pub url: String,
    pub position: i64,
}

/// The passkey slot (L-passkey). **Key material is sealed; its presence is
/// what draws**, and nothing on the phone reveals it (`KEY_NOT_SHOWN`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Passkey {
    pub rp_id: String,
    pub user_handle: Option<String>,
    pub display_name: Option<String>,
    pub credential_id: Option<String>,
    pub algorithm: Option<String>,
    pub created_at: Option<String>,
    pub has_private_key: bool,
}

/// One row as a shelf draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub row: ItemRow,
    pub starred: bool,
    pub tags: Vec<String>,
}

impl Listed {
    /// The type the phone draws.
    #[must_use]
    pub fn rendered_type(&self) -> &str {
        degrade_type(&self.row.item_type)
    }

    /// The crate's secret-free subtitle.
    #[must_use]
    pub fn subtitle(&self) -> String {
        subtitle_of(&self.row)
    }

    #[must_use]
    pub const fn archived(&self) -> bool {
        self.row.archived_at.is_some()
    }
}

/// `locker.items`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemsData {
    pub items: Vec<Listed>,
    pub truncated: bool,
    pub window: usize,
    /// `None` when the walk that counted reached its ceiling.
    pub total: Option<usize>,
    /// Live items per rendered type, `ITEM_TYPES` order, zeros dropped.
    pub by_type: Vec<(String, usize)>,
    pub archived_count: Option<usize>,
    pub trashed_count: Option<usize>,
    pub tags: Vec<String>,
}

/// `locker.item`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemData {
    pub listed: Listed,
    pub degraded_from: Option<String>,
    pub alias: Option<String>,
    pub memo: Option<String>,
    /// `(column, present)` for every sealed cell the type carries.
    pub secrets: Vec<(&'static str, bool)>,
    pub fields: Vec<PhoneField>,
    pub addresses: Vec<Address>,
    pub passkey: Option<Passkey>,
}

/// One custom field; a sealed value is absent and `present` says whether one
/// is stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneField {
    pub field_id: String,
    pub section: String,
    pub label: String,
    pub kind: String,
    pub value: Option<String>,
    pub sealed: bool,
    pub present: bool,
    pub position: i64,
}

/// `locker.search`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchData {
    pub items: Vec<Listed>,
    pub truncated: bool,
}

/// `locker.review`: the metadata verdicts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReviewData {
    pub compromised: Vec<Listed>,
    pub insecure_address: Vec<Listed>,
    pub expired: Vec<Listed>,
    pub expiring: Vec<Listed>,
    pub reviewed: usize,
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// The loaders.
// ---------------------------------------------------------------------------

/// The shelf, its counts, and the tags in use.
pub fn load_items(door: &dyn PageDoor, archived: bool, limit: Option<i64>) -> KitResult<ItemsData> {
    let window = items_window(limit);
    let walked = read_window(door, &shelves_statement(), ITEMS_MAX)?;
    let rows: Vec<ItemRow> = walked.rows.iter().map(ItemRow::of).collect();
    let decorations = decorations(door)?;
    let (live, archived_rows): (Vec<&ItemRow>, Vec<&ItemRow>) =
        rows.iter().partition(|row| row.archived_at.is_none());
    let shelf = if archived { &archived_rows } else { &live };
    let items: Vec<Listed> = shelf
        .iter()
        .take(window)
        .map(|row| decorations.listed((*row).clone()))
        .collect();
    let counted = !walked.filled;
    let trashed = read_window(door, &trashed_statement(), TRASH_ROWS)?;
    let mut by_type: BTreeMap<&str, usize> = BTreeMap::new();
    for row in &live {
        *by_type.entry(degrade_type(&row.item_type)).or_default() += 1;
    }
    let live_ids: BTreeSet<&str> = live.iter().map(|row| row.item_id.as_str()).collect();
    let tags: BTreeSet<String> = decorations
        .tags
        .iter()
        .filter(|(item_id, _)| live_ids.contains(item_id.as_str()))
        .flat_map(|(_, labels)| labels.iter().cloned())
        .collect();
    Ok(ItemsData {
        truncated: shelf.len() > window || walked.filled,
        window,
        total: counted.then_some(shelf.len()),
        by_type: ITEM_TYPES
            .iter()
            .filter_map(|known| {
                by_type
                    .get(known)
                    .map(|count| ((*known).to_owned(), *count))
            })
            .collect(),
        archived_count: counted.then_some(archived_rows.len()),
        trashed_count: (!trashed.filled).then_some(trashed.rows.len()),
        tags: tags.into_iter().collect(),
        items,
    })
}

/// One item, trashed or not; `None` when no item has the id.
pub fn load_item(door: &dyn PageDoor, item_id: &str) -> KitResult<Option<ItemData>> {
    let Some(found) = read_by_id(
        door,
        "locker.phone.item",
        ITEM_COLUMNS,
        "locker_item",
        "item_id",
        item_id,
    )?
    else {
        return Ok(None);
    };
    let row = ItemRow::of(&found);
    let decorations = decorations(door)?;
    let presence = door
        .page(&presence_statement(item_id), &first(1))?
        .rows
        .into_iter()
        .next()
        .unwrap_or_default();
    let rendered = degrade_type(&row.item_type).to_owned();
    let secrets = secret_cells(&rendered)
        .iter()
        .map(|column| (*column, truthy(&presence, &format!("has_{column}"))))
        .collect();
    let fields = read_window(door, &fields_statement(item_id), DECORATION_ROWS)?
        .rows
        .iter()
        .map(field_of)
        .collect::<Vec<_>>();
    let mut fields = fields;
    fields.sort_by(|left, right| {
        left.section
            .cmp(&right.section)
            .then(left.position.cmp(&right.position))
            .then(left.label.cmp(&right.label))
    });
    let mut addresses: Vec<Address> =
        read_window(door, &addresses_statement(item_id), DECORATION_ROWS)?
            .rows
            .iter()
            .map(|row| Address {
                address_id: text_of(row, "address_id").unwrap_or_default(),
                url: text_of(row, "url").unwrap_or_default(),
                position: integer_of(row, "position"),
            })
            .collect();
    addresses.sort_by_key(|address| address.position);
    let passkey = door
        .page(&passkey_statement(item_id), &first(1))?
        .rows
        .first()
        .map(|row| Passkey {
            rp_id: text_of(row, "rp_id").unwrap_or_default(),
            user_handle: text_of(row, "user_handle"),
            display_name: text_of(row, "display_name"),
            credential_id: text_of(row, "credential_id"),
            algorithm: text_of(row, "algorithm"),
            created_at: text_of(row, "created_at"),
            has_private_key: truthy(row, "has_private_key"),
        });
    let memo = door
        .page(&memo_statement(item_id), &first(1))?
        .rows
        .first()
        .and_then(|row| text_of(row, "body_text"));
    let alias = decorations.alias.get(item_id).cloned();
    Ok(Some(ItemData {
        degraded_from: degraded_from(&row.item_type).map(str::to_owned),
        listed: decorations.listed(row),
        alias,
        memo,
        secrets,
        fields,
        addresses,
        passkey,
    }))
}

/// Title, username and address, case-insensitively, over every item not in
/// the trash. Nothing sealed and no note is searched (L-search, the handoff's
/// search note).
pub fn load_search(door: &dyn PageDoor, term: &str, limit: usize) -> KitResult<SearchData> {
    let limit = if limit == 0 {
        SEARCH_DEFAULT
    } else {
        limit.min(SEARCH_ROWS)
    };
    let needle = term.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(SearchData {
            items: Vec::new(),
            truncated: false,
        });
    }
    let walked = read_window(door, &shelves_statement(), SEARCH_ROWS)?;
    let matched: Vec<ItemRow> = walked
        .rows
        .iter()
        .map(ItemRow::of)
        .filter(|row| row.matches(&needle))
        .collect();
    let decorations = decorations(door)?;
    Ok(SearchData {
        truncated: matched.len() > limit || walked.filled,
        items: matched
            .into_iter()
            .take(limit)
            .map(|row| decorations.listed(row))
            .collect(),
    })
}

/// The metadata review, against `today` (`YYYY-MM-DD` in the member's zone).
pub fn load_review(door: &dyn PageDoor, today: &str) -> KitResult<ReviewData> {
    let walked = read_window(door, &shelves_statement(), REVIEW_ROWS)?;
    let decorations = decorations(door)?;
    let this_month = month_of_day(today);
    let mut review = ReviewData {
        reviewed: walked.rows.len(),
        truncated: walked.filled,
        ..ReviewData::default()
    };
    for row in walked.rows.iter().map(ItemRow::of) {
        let listed = decorations.listed(row);
        let row = &listed.row;
        if row.compromised {
            review.compromised.push(listed.clone());
        }
        if listed.rendered_type() == "login"
            && row
                .url
                .as_deref()
                .is_some_and(|url| url.trim().to_ascii_lowercase().starts_with("http://"))
        {
            review.insecure_address.push(listed.clone());
        }
        if listed.rendered_type() == "card"
            && let (Some(expiry), Some(now)) =
                (row.expiry.as_deref().and_then(card_month), this_month)
        {
            if expiry < now {
                review.expired.push(listed.clone());
            } else if expiry <= now + 2 {
                review.expiring.push(listed.clone());
            }
        }
    }
    Ok(review)
}

/// The access-history window's default on the item page.
pub const ACCESS_DEFAULT: i64 = 50;

/// ONE ITEM'S ACCESS HISTORY (#1047 T2, L-access): the receipts the vault
/// already wrote about it — reveals, copies and one-time codes, refusals
/// included — newest first, as metadata. A receipt never carried a value.
pub fn load_access(
    door: &dyn PageDoor,
    item_id: &str,
    limit: Option<i64>,
) -> KitResult<AccessAnswer> {
    let window = access_window(limit.or(Some(ACCESS_DEFAULT)));
    let read = read_window(door, &access_statement(Some(item_id))?, window)?;
    Ok(access_answer(window, &read.rows))
}

/// Every item an import could land on: live and archived, with which of its
/// sealed cells hold a value (#1047 T2). The window is the shelves' ceiling.
pub fn load_import_targets(door: &dyn PageDoor) -> KitResult<Vec<Existing>> {
    let rows = read_window(door, &shelves_statement(), ITEMS_MAX)?.rows;
    let presence: BTreeMap<String, Row> = read_window(door, &presence_all_statement(), ITEMS_MAX)?
        .rows
        .into_iter()
        .filter_map(|row| text_of(&row, "item_id").map(|id| (id, row)))
        .collect();
    Ok(rows
        .iter()
        .map(ItemRow::of)
        .map(|row| {
            let item_type = degrade_type(&row.item_type).to_owned();
            let sealed = presence
                .get(&row.item_id)
                .map_or_else(BTreeSet::new, |found| {
                    SEALED_ITEM_COLUMNS
                        .iter()
                        .filter(|column| truthy(found, &format!("has_{column}")))
                        .map(|column| (*column).to_owned())
                        .collect()
                });
            Existing {
                plain: plain_columns(&row),
                sealed,
                item_id: row.item_id,
                title: row.title,
                item_type,
            }
        })
        .collect())
}

/// ONE ITEM TO EXPORT, WITHOUT ITS SECRETS: the plain half of the file's
/// entry, and the addresses of the sealed values the core opens into it.
#[derive(Debug, Clone)]
pub struct ExportSource {
    pub item_id: String,
    /// Every plain column, tag, flag, field label and address; sealed cells
    /// and sealed field values are empty until the core fills them.
    pub entry: Entry,
    /// The sealed cells this item's type carries that hold a value.
    pub sealed_cells: Vec<&'static str>,
    /// `(field_id, index into entry.fields)` for each sealed field that holds
    /// a value.
    pub sealed_fields: Vec<(String, usize)>,
}

/// EVERY ITEM AN EXPORT WRITES (#1047 T2): live and archived, oldest first,
/// with its tags, star, memo, fields, addresses and passkey metadata. The
/// trash is not exported. Nothing sealed is read: the core opens those.
pub fn load_export(door: &dyn PageDoor) -> KitResult<Vec<ExportSource>> {
    let mut rows: Vec<ItemRow> = read_window(door, &shelves_statement(), ITEMS_MAX)?
        .rows
        .iter()
        .map(ItemRow::of)
        .collect();
    rows.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.item_id.cmp(&right.item_id))
    });
    let decorations = decorations(door)?;
    let mut sources = Vec::with_capacity(rows.len());
    for row in rows {
        let item_id = row.item_id.clone();
        let item_type = degrade_type(&row.item_type).to_owned();
        let presence = door
            .page(&presence_statement(&item_id), &first(1))?
            .rows
            .into_iter()
            .next()
            .unwrap_or_default();
        let sealed_cells: Vec<&'static str> = secret_cells(&item_type)
            .iter()
            .copied()
            .filter(|column| truthy(&presence, &format!("has_{column}")))
            .collect();
        let mut fields: Vec<PhoneField> =
            read_window(door, &fields_statement(&item_id), DECORATION_ROWS)?
                .rows
                .iter()
                .map(field_of)
                .collect();
        fields.sort_by(|left, right| {
            left.section
                .cmp(&right.section)
                .then(left.position.cmp(&right.position))
                .then(left.label.cmp(&right.label))
        });
        let sealed_fields = fields
            .iter()
            .enumerate()
            .filter(|(_, field)| field.sealed && field.present)
            .map(|(index, field)| (field.field_id.clone(), index))
            .collect();
        let mut addresses: Vec<Address> =
            read_window(door, &addresses_statement(&item_id), DECORATION_ROWS)?
                .rows
                .iter()
                .map(|row| Address {
                    address_id: text_of(row, "address_id").unwrap_or_default(),
                    url: text_of(row, "url").unwrap_or_default(),
                    position: integer_of(row, "position"),
                })
                .collect();
        addresses.sort_by_key(|address| address.position);
        let passkey = door
            .page(&passkey_statement(&item_id), &first(1))?
            .rows
            .first()
            .map(|row| EntryPasskey {
                rp_id: text_of(row, "rp_id").unwrap_or_default(),
                user_handle: text_of(row, "user_handle").unwrap_or_default(),
                display_name: text_of(row, "display_name").unwrap_or_default(),
                credential_id: text_of(row, "credential_id").unwrap_or_default(),
                algorithm: text_of(row, "algorithm").unwrap_or_default(),
            });
        let memo = door
            .page(&memo_statement(&item_id), &first(1))?
            .rows
            .first()
            .and_then(|row| text_of(row, "body_text"))
            .unwrap_or_default();
        let listed = decorations.listed(row);
        let entry = Entry {
            columns: plain_columns(&listed.row)
                .into_iter()
                .filter(|(column, _)| type_columns(&item_type).contains(&column.as_str()))
                .collect(),
            title: listed.row.title.clone(),
            tags: listed.tags.clone(),
            starred: listed.starred,
            archived: listed.archived(),
            compromised: listed.row.compromised,
            memo,
            fields: fields
                .into_iter()
                .map(|field| EntryField {
                    section: field.section,
                    label: field.label,
                    kind: field.kind,
                    value: field.value.unwrap_or_default(),
                })
                .collect(),
            addresses: addresses.into_iter().map(|address| address.url).collect(),
            passkey,
            item_type,
        };
        sources.push(ExportSource {
            item_id,
            entry,
            sealed_cells,
            sealed_fields,
        });
    }
    Ok(sources)
}

/// A row's non-empty plain columns, by the vault's column name.
fn plain_columns(row: &ItemRow) -> BTreeMap<String, String> {
    [
        ("username", &row.username),
        ("url", &row.url),
        ("notes", &row.notes),
        ("cardholder", &row.cardholder),
        ("expiry", &row.expiry),
        ("brand", &row.brand),
        ("fullname", &row.fullname),
        ("email", &row.email),
        ("phone", &row.phone),
        ("address", &row.address),
        ("network", &row.network),
    ]
    .into_iter()
    .filter_map(|(column, value)| {
        value
            .as_ref()
            .filter(|value| !value.is_empty())
            .map(|value| (column.to_owned(), value.clone()))
    })
    .collect()
}

// ---------------------------------------------------------------------------
// The decorations every shelf folds over.
// ---------------------------------------------------------------------------

/// Tags, stars and aliases, keyed by item id.
#[derive(Debug, Clone, Default)]
pub struct PhoneDecorations {
    pub tags: BTreeMap<String, Vec<String>>,
    pub starred: BTreeSet<String>,
    pub alias: BTreeMap<String, String>,
}

impl PhoneDecorations {
    fn listed(&self, row: ItemRow) -> Listed {
        Listed {
            starred: self.starred.contains(&row.item_id),
            tags: self.tags.get(&row.item_id).cloned().unwrap_or_default(),
            row,
        }
    }
}

/// Read the vocabulary once, then the tag rows and aliases.
pub fn decorations(door: &dyn PageDoor) -> KitResult<PhoneDecorations> {
    let schemes = read_window(door, &schemes_statement(), 2)?.rows;
    let mut tag_scheme = None;
    let mut flag_scheme = None;
    for row in &schemes {
        let (Some(id), Some(uri)) = (text_of(row, "scheme_id"), text_of(row, "uri")) else {
            continue;
        };
        if uri == LOCKER_TAGS_SCHEME_URI {
            tag_scheme = Some(id);
        } else if uri == FLAGS_SCHEME_URI {
            flag_scheme = Some(id);
        }
    }
    let scheme_ids: Vec<String> = tag_scheme
        .iter()
        .chain(flag_scheme.iter())
        .cloned()
        .collect();
    let mut labels: BTreeMap<String, String> = BTreeMap::new();
    let mut star: Option<String> = None;
    if !scheme_ids.is_empty() {
        for row in read_window(door, &concepts_statement(&scheme_ids), DECORATION_ROWS)?.rows {
            let (Some(concept), Some(scheme)) =
                (text_of(&row, "concept_id"), text_of(&row, "scheme_id"))
            else {
                continue;
            };
            if Some(&scheme) == tag_scheme.as_ref() {
                if let Some(label) = text_of(&row, "pref_label") {
                    labels.insert(concept, label);
                }
            } else if Some(&scheme) == flag_scheme.as_ref()
                && text_of(&row, "notation").as_deref() == Some(STARRED_NOTATION)
            {
                star = Some(concept);
            }
        }
    }
    let mut decorations = PhoneDecorations::default();
    for row in read_window(door, &tag_rows_statement(), DECORATION_ROWS)?.rows {
        let (Some(target), Some(concept)) =
            (text_of(&row, "target_id"), text_of(&row, "concept_id"))
        else {
            continue;
        };
        if star.as_ref() == Some(&concept) {
            decorations.starred.insert(target);
        } else if let Some(label) = labels.get(&concept) {
            decorations
                .tags
                .entry(target)
                .or_default()
                .push(label.clone());
        }
    }
    for labels in decorations.tags.values_mut() {
        labels.sort_unstable();
        labels.dedup();
    }
    for row in read_window(door, &aliases_statement(), DECORATION_ROWS)?.rows {
        if let (Some(alias), Some(item)) = (text_of(&row, "alias"), text_of(&row, "item_id")) {
            decorations.alias.insert(item, alias);
        }
    }
    Ok(decorations)
}

// ---------------------------------------------------------------------------
// Small folds.
// ---------------------------------------------------------------------------

fn first(limit: usize) -> centraid_apps_kit::page::PageRequest {
    centraid_apps_kit::page::PageRequest::first(limit)
}

fn truthy(row: &Row, column: &str) -> bool {
    match row.get(column) {
        Some(Cell::Integer(value)) => *value != 0,
        Some(Cell::Text(value)) => value == "1" || value == "true",
        _ => false,
    }
}

fn integer_of(row: &Row, column: &str) -> i64 {
    match row.get(column) {
        Some(Cell::Integer(value)) => *value,
        Some(Cell::Text(value)) => value.parse().unwrap_or(0),
        _ => 0,
    }
}

fn field_of(row: &Row) -> PhoneField {
    let kind = text_of(row, "kind").unwrap_or_default();
    let sealed = kind == "sealed";
    let value = if sealed {
        None
    } else {
        text_of(row, "value_text")
    };
    PhoneField {
        field_id: text_of(row, "field_id").unwrap_or_default(),
        section: text_of(row, "section").unwrap_or_default(),
        label: text_of(row, "label").unwrap_or_default(),
        present: if sealed {
            truthy(row, "has_sealed")
        } else {
            value.as_deref().is_some_and(|value| !value.is_empty())
        },
        value,
        sealed,
        kind,
        position: integer_of(row, "position"),
    }
}

/// A month as a count, `year * 12 + (month - 1)`, from `YYYY-MM-DD`.
fn month_of_day(day: &str) -> Option<i64> {
    let year: i64 = day.get(0..4)?.parse().ok()?;
    let month: i64 = day.get(5..7)?.parse().ok()?;
    (1..=12).contains(&month).then_some(year * 12 + month - 1)
}

/// A card's expiry, `MM/YY` or `MM/YYYY` (a space or a hyphen accepted), as a
/// month count. `None` for anything else — an expiry this cannot read is not
/// judged, never judged expired.
#[must_use]
pub fn card_month(expiry: &str) -> Option<i64> {
    let cleaned: String = expiry.chars().filter(|c| !c.is_whitespace()).collect();
    let (month, year) = cleaned.split_once(['/', '-'])?;
    let month: i64 = month.parse().ok()?;
    let year: i64 = match year.len() {
        2 => 2000 + year.parse::<i64>().ok()?,
        4 => year.parse().ok()?,
        _ => return None,
    };
    (1..=12).contains(&month).then_some(year * 12 + month - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_card_month_reads_two_and_four_digit_years_and_refuses_the_rest() {
        assert_eq!(card_month("04/27"), Some(2027 * 12 + 3));
        assert_eq!(card_month("04/2027"), Some(2027 * 12 + 3));
        assert_eq!(card_month(" 4 - 27 "), Some(2027 * 12 + 3));
        assert_eq!(card_month("13/27"), None);
        assert_eq!(card_month("soon"), None);
    }

    #[test]
    fn only_the_six_original_types_carry_sealed_item_cells() {
        assert_eq!(secret_cells("login"), &["password", "otp_seed"]);
        assert_eq!(secret_cells("card"), &["card_number", "cvv"]);
        assert!(secret_cells("identity").is_empty());
        assert!(secret_cells("passport").is_empty());
        for cells in ITEM_TYPES.iter().map(|t| secret_cells(t)) {
            for cell in cells {
                assert!(crate::queries::SEALED_ITEM_COLUMNS.contains(cell));
            }
        }
    }

    #[test]
    fn no_phone_statement_projects_a_sealed_cell_except_as_its_presence() {
        let statements = [
            shelves_statement(),
            trashed_statement(),
            presence_statement("x"),
            presence_all_statement(),
            fields_statement("x"),
            passkey_statement("x"),
        ];
        for statement in statements {
            for column in statement.select.split(',').map(str::trim) {
                for sealed in crate::queries::SEALED_ITEM_COLUMNS
                    .iter()
                    .chain(["value_sealed", "private_key"].iter())
                {
                    if column.split_whitespace().next() == Some(*sealed) {
                        assert!(
                            column.contains("IS NOT NULL AS"),
                            "{} projects {column}",
                            statement.name
                        );
                    }
                }
            }
        }
    }
}
