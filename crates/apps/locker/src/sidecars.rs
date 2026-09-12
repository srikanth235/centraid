//! THE ITEM PANE'S SIDECARS — the SHAPE of a secret, never the secret.
//!
//! Ported from `packages/blueprints/apps/locker/queries/item-sidecars.ts`. One
//! rule runs through all of it: **a sealed cell never rides these payloads.**
//! `value_sealed` and `private_key` are projected because their *presence* is
//! what the pane draws, and what comes back is a boolean; a revision's
//! `snapshot_json` is opened here and **never forwarded**.
//!
//! ## Every sidecar is one walk, and a refused one empties its own section
//!
//! Every sidecar is the same read — one item's rows out of a table keyed on the
//! item — so it is one function given the table, its projection and its own
//! primary key. A vault's largest custom-field set is still a set one member
//! typed, so the walk's stated ceiling is far above it and **erroring there is
//! the right answer**: a pane silently missing half a card's fields is worse
//! than one that says it could not be drawn.
//!
//! A sidecar the grant does not cover leaves *its own section* empty and never
//! takes the pane down with it (`rowsOf`'s `catch`). That is a deliberate
//! asymmetry with rule 3 of the kit: a **fan-out ceiling** errors, and a
//! **consent refusal on one section** is a value. [`SidecarReading`] is what
//! keeps the two apart, so "no fields" and "fields I may not see" are two
//! answers rather than one empty list.
//!
//! ## The revision allow-list, and why a snapshot's secrets stay in it
//!
//! [`REVISION_COLUMNS`] is an **allow-list and the sealed columns are not on
//! it**. A snapshot keeps `password`, `otp_seed`, `card_number`, `cvv` and
//! `content` exactly as the row held them — ciphertext under the item's own
//! additional data — so comparing two snapshots would answer *"was this cell
//! rewritten"*, never *"did the value change"*, and the ciphertext is not
//! something a payload may carry either way.
//!
//! **A rotation is read off its plain witness**: the vault re-stamps
//! `password_set_at` exactly when a password is set and leaves it alone when an
//! edit round-trips the placeholder, so the timestamp says a rotation happened
//! without anything having to look at the secret.

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{FanOutBound, PageDoor, in_list, read_pages};
use centraid_apps_kit::row::{Row, integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::types::ITEM_ENTITY_TYPE;

/// The vault's placeholder for a sealed cell (`packages/vault/src/schema/sealed.ts:201`).
///
/// Round-tripped `«sealed»` is **unchanged, never a value** (#293): an edit
/// that hands this back means "leave the secret alone", which is what lets the
/// edit form exist without the form ever holding the password.
pub const SEALED_PLACEHOLDER: &str = "«sealed»";

/// One item's sidecars is one member's worth of rows: 500 × 8 = 4,000, the
/// kit's default, stated and errored at.
pub const SIDECAR_BOUND: FanOutBound = FanOutBound::new(500, 8);

/// One item's revisions. `locker.item` declares `revisions: {retain: forever}`,
/// so a password rotated last March is still here; the pane shows the newest
/// fifty (`readHistory`'s default).
pub const HISTORY_ROWS: usize = 50;

/// THE THREE STATES OF A SIDECAR SECTION.
///
/// `Vec<T>` collapses two of them: "this item has no custom fields" and "the
/// grant does not cover `locker_item_field`" both become an empty list, and the
/// pane draws the same empty section for a fact and for a refusal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarReading<T> {
    /// Read, and this is what there is — possibly nothing.
    Read(Vec<T>),
    /// The grant does not cover it. The section says so.
    Refused,
}

impl<T> SidecarReading<T> {
    /// The rows, or an empty slice. **A renderer that wants to say "none" must
    /// check [`Self::refused`] first.**
    #[must_use]
    pub fn rows(&self) -> &[T] {
        match self {
            Self::Read(rows) => rows,
            Self::Refused => &[],
        }
    }

    #[must_use]
    pub const fn refused(&self) -> bool {
        matches!(self, Self::Refused)
    }
}

/// One custom field, as the pane draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub field_id: String,
    pub section: String,
    pub label: String,
    pub kind: String,
    /// `None` for a sealed field. A sealed value reads back as **nothing plus
    /// `sealed: true`**, which is the honest shape: `value_text` is `NULL` by
    /// the table's own CHECK when the kind is sealed.
    pub value: Option<String>,
    pub sealed: bool,
    pub position: i64,
}

/// One stored address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Address {
    pub address_id: String,
    pub url: String,
    pub match_policy: String,
    pub position: i64,
}

/// The passkey slot. **Key material is sealed; its presence is what draws.**
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

/// One revision — **what changed and when**, never to what.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revision {
    pub revision_id: String,
    pub operation: String,
    /// The member-facing WORDS of the columns that differ, sorted.
    pub changed: Vec<String>,
    pub recorded_at: Option<String>,
    /// The snapshot would not parse. An empty object diffed against the live
    /// item would report every column as changed, which is a louder claim than
    /// "unreadable" and a false one.
    pub unreadable: bool,
}

/// One attachment's metadata. The bytes are **not** sealed — the sealed class
/// is a column class — so this returns what the file *is*.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub attachment_id: String,
    pub content_id: String,
    pub role: String,
    pub media_type: Option<String>,
    pub byte_size: Option<i64>,
}

/// Everything the item pane reads beside the item's own row.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Sidecars {
    pub fields: Vec<Field>,
    pub addresses: Vec<Address>,
    pub passkey: Option<Passkey>,
    pub history: Vec<Revision>,
    pub attachments: Vec<Attachment>,
}

fn one_items_rows(
    name: &'static str,
    select: &'static str,
    from: &'static str,
    pk_column: &'static str,
    item_id: &str,
    column: &str,
) -> PageQuery {
    PageQuery::new(name, select, from, PageOrder::asc(pk_column, pk_column)).filter(
        &format!("{column} = ?"),
        vec![PageBindValue::Text(item_id.to_owned())],
    )
}

/// The connector alias statement.
#[must_use]
pub fn alias_statement(item_id: &str) -> PageQuery {
    one_items_rows(
        "locker.sidecars.alias",
        "alias, item_id",
        "locker_item_alias",
        "alias",
        item_id,
        "item_id",
    )
}

/// The custom-field statement. `value_sealed` is projected for its PRESENCE.
#[must_use]
pub fn fields_statement(item_id: &str) -> PageQuery {
    one_items_rows(
        "locker.sidecars.fields",
        "field_id, item_id, section, label, kind, value_text, value_sealed, position",
        "locker_item_field",
        "field_id",
        item_id,
        "item_id",
    )
}

#[must_use]
pub fn addresses_statement(item_id: &str) -> PageQuery {
    one_items_rows(
        "locker.sidecars.addresses",
        "address_id, item_id, url, match_policy, position",
        "locker_item_address",
        "address_id",
        item_id,
        "item_id",
    )
}

/// The passkey statement. `private_key` is projected for its PRESENCE.
#[must_use]
pub fn passkey_statement(item_id: &str) -> PageQuery {
    one_items_rows(
        "locker.sidecars.passkey",
        "item_id, rp_id, user_handle, display_name, credential_id, algorithm, private_key, created_at",
        "locker_item_passkey",
        "item_id",
        item_id,
        "item_id",
    )
}

/// The revision statement (#916, owner decision D2).
///
/// `locker_item_history` was a **second** revision mechanism for the same
/// question and it is gone: an item's pre-mutation state is a
/// `core_entity_revision` row.
#[must_use]
pub fn revisions_statement(item_id: &str) -> PageQuery {
    PageQuery::new(
        "locker.sidecars.revisions",
        "revision_id, entity_type, entity_id, operation, snapshot_json, recorded_at",
        "core_entity_revision",
        PageOrder::desc("recorded_at", "revision_id"),
    )
    .filter(
        "entity_type = ? AND entity_id = ?",
        vec![
            PageBindValue::Text(ITEM_ENTITY_TYPE.to_owned()),
            PageBindValue::Text(item_id.to_owned()),
        ],
    )
}

#[must_use]
pub fn attachments_statement(item_id: &str) -> PageQuery {
    PageQuery::new(
        "locker.sidecars.attachments",
        "attachment_id, target_type, target_id, content_id, role",
        "core_attachment",
        PageOrder::asc("attachment_id", "attachment_id"),
    )
    .filter(
        "target_type = ? AND target_id = ?",
        vec![
            PageBindValue::Text(ITEM_ENTITY_TYPE.to_owned()),
            PageBindValue::Text(item_id.to_owned()),
        ],
    )
}

/// The byte sizes of a bounded set of content ids.
pub fn contents_statement(content_ids: &[String]) -> KitResult<PageQuery> {
    let contents = in_list("content_id", content_ids)?;
    Ok(PageQuery::new(
        "locker.sidecars.contents",
        "content_id, byte_size",
        "core_content_item",
        PageOrder::asc("content_id", "content_id"),
    )
    .filter(&contents.sql, contents.bind))
}

/// Fold the custom-field rows.
///
/// The sort is v0's, and the tie-break chain matters: `(section, position,
/// label)`, so two fields a member gave the same position land in a stable
/// order rather than the primary key's.
#[must_use]
pub fn fold_fields(rows: &[Row]) -> Vec<Field> {
    let mut fields: Vec<Field> = rows
        .iter()
        .map(|row| {
            let kind = text_of(row, "kind").unwrap_or_default();
            let sealed_cell = text_of(row, "value_sealed");
            Field {
                field_id: text_of(row, "field_id").unwrap_or_default(),
                section: text_of(row, "section").unwrap_or_default(),
                label: text_of(row, "label").unwrap_or_default(),
                // A sealed field's value is `None`, and the table's own CHECK
                // is what makes that a fact rather than a choice.
                value: if kind == "sealed" {
                    None
                } else {
                    text_of(row, "value_text")
                },
                sealed: kind == "sealed" && sealed_cell.is_some(),
                kind,
                position: integer_or_zero(row, "position"),
            }
        })
        .collect();
    fields.sort_by(|left, right| {
        left.section
            .cmp(&right.section)
            .then(left.position.cmp(&right.position))
            .then(left.label.cmp(&right.label))
    });
    fields
}

/// Fold the address rows, in the member's own order.
#[must_use]
pub fn fold_addresses(rows: &[Row]) -> Vec<Address> {
    let mut addresses: Vec<Address> = rows
        .iter()
        .map(|row| Address {
            address_id: text_of(row, "address_id").unwrap_or_default(),
            url: text_of(row, "url").unwrap_or_default(),
            match_policy: text_of(row, "match_policy")
                .unwrap_or_else(|| "registrable-domain".to_owned()),
            position: integer_or_zero(row, "position"),
        })
        .collect();
    addresses.sort_by(|left, right| {
        left.position
            .cmp(&right.position)
            .then(left.address_id.cmp(&right.address_id))
    });
    addresses
}

/// Fold the passkey row. `private_key` becomes a boolean and nothing else.
#[must_use]
pub fn fold_passkey(rows: &[Row]) -> Option<Passkey> {
    let row = rows.first()?;
    Some(Passkey {
        rp_id: text_of(row, "rp_id").unwrap_or_default(),
        user_handle: text_of(row, "user_handle"),
        display_name: text_of(row, "display_name"),
        credential_id: text_of(row, "credential_id"),
        algorithm: text_of(row, "algorithm"),
        created_at: text_of(row, "created_at"),
        has_private_key: text_of(row, "private_key").is_some(),
    })
}

/// THE PLAIN COLUMNS A REVISION MAY NAME, and the word it names each by.
pub const REVISION_COLUMNS: [(&str, &str); 18] = [
    ("type", "type"),
    ("title", "title"),
    ("username", "username"),
    ("url", "url"),
    ("url_match_policy", "url_match_policy"),
    ("notes", "notes"),
    ("cardholder", "cardholder"),
    ("expiry", "expiry"),
    ("brand", "brand"),
    ("fullname", "fullname"),
    ("email", "email"),
    ("phone", "phone"),
    ("address", "address"),
    ("network", "network"),
    ("compromised", "compromised"),
    ("archived_at", "archived"),
    ("deleted_at", "trashed"),
    ("password_set_at", "password"),
];

fn changed_between(before: &serde_json::Value, after: &serde_json::Value) -> Vec<String> {
    let mut changed: Vec<String> = REVISION_COLUMNS
        .iter()
        .filter(|(column, _)| {
            let was = before.get(column).unwrap_or(&serde_json::Value::Null);
            let now = after.get(column).unwrap_or(&serde_json::Value::Null);
            was != now
        })
        .map(|(_, word)| (*word).to_owned())
        .collect();
    changed.sort_unstable();
    changed.dedup();
    changed
}

/// Fold the revision rows into "what changed and when".
///
/// `current` is the item as it stands. Newest-first, each revision is
/// superseded by the one before it in the list and the newest by the item
/// itself — so the walk carries `after` backwards through the chain.
#[must_use]
pub fn fold_history(rows: &[Row], current: &serde_json::Value) -> Vec<Revision> {
    let mut after = current.clone();
    rows.iter()
        .take(HISTORY_ROWS)
        .map(|row| {
            let snapshot = text_of(row, "snapshot_json")
                .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                .filter(serde_json::Value::is_object);
            let (changed, unreadable) = match &snapshot {
                Some(snapshot) => (changed_between(snapshot, &after), false),
                None => (Vec::new(), true),
            };
            if let Some(snapshot) = snapshot {
                after = snapshot;
            }
            Revision {
                revision_id: text_of(row, "revision_id").unwrap_or_default(),
                operation: text_of(row, "operation").unwrap_or_default(),
                changed,
                recorded_at: text_of(row, "recorded_at"),
                unreadable,
            }
        })
        .collect()
}

/// Fold the attachment edges against the content rows and the representations.
///
/// Bytes carry **no media type** since #996 (R20(b)); the attachment's own
/// representation says what it reads them as, and bytes have no title.
#[must_use]
pub fn fold_attachments(
    edges: &[Row],
    contents: &[Row],
    media_type_by_owner: &BTreeMap<String, String>,
    media_type_by_content: &BTreeMap<String, String>,
) -> Vec<Attachment> {
    let sizes: BTreeMap<String, Option<i64>> = contents
        .iter()
        .filter_map(|row| {
            let id = text_of(row, "content_id")?;
            let size = row.get("byte_size").and_then(|cell| cell.integer());
            Some((id, size))
        })
        .collect();
    edges
        .iter()
        .map(|row| {
            let attachment_id = text_of(row, "attachment_id").unwrap_or_default();
            let content_id = text_of(row, "content_id").unwrap_or_default();
            Attachment {
                media_type: media_type_by_owner
                    .get(&owner_key(ITEM_ATTACHMENT_OWNER, &attachment_id))
                    .or_else(|| media_type_by_content.get(&content_id))
                    .cloned(),
                byte_size: sizes.get(&content_id).copied().flatten(),
                role: text_of(row, "role").unwrap_or_default(),
                attachment_id,
                content_id,
            }
        })
        .collect()
}

/// The owner type a Locker attachment's representation is keyed by.
pub const ITEM_ATTACHMENT_OWNER: &str = "core.attachment";

/// `ownerKey`, ported from `_shared/representation-reads.ts`.
#[must_use]
pub fn owner_key(owner_type: &str, owner_id: &str) -> String {
    format!("{owner_type}:{owner_id}")
}

/// Read one sidecar's rows, turning a **refused door** into a value and
/// leaving a **ceiling** an error.
///
/// This is the one place the asymmetry in this module's doc comment is
/// implemented, and it is implemented by matching on the error rather than by
/// catching everything — v0's bare `catch` swallows a fan-out overflow too,
/// which is how a pane silently loses half a card's fields and reports it as an
/// item with no custom fields.
///
/// The kit's error type has **no denial variant**, on purpose: a denial is a
/// value in the app's own payload. What reaches an app crate from a door that
/// would not answer is therefore the door's own refusal sentence
/// (`KitError::GrammarRefused`), and that is the one arm that becomes
/// [`SidecarReading::Refused`]. Everything else — a ceiling, a broken cursor, a
/// projection that does not carry its own sort column — is a bug in this crate
/// or its caller and goes up.
pub fn read_sidecar(door: &dyn PageDoor, query: &PageQuery) -> KitResult<SidecarReading<Row>> {
    match read_pages(door, query, SIDECAR_BOUND) {
        Ok(rows) => Ok(SidecarReading::Read(rows)),
        Err(centraid_apps_kit::KitError::GrammarRefused { .. }) => Ok(SidecarReading::Refused),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::row::Cell;

    fn row(pairs: &[(&str, Cell)]) -> Row {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect()
    }

    fn text(value: &str) -> Cell {
        Cell::Text(value.to_owned())
    }

    /// A SEALED CUSTOM VALUE READS BACK AS NOTHING PLUS A BOOLEAN.
    #[test]
    fn a_sealed_field_carries_no_value_and_a_plain_one_does() {
        let rows = vec![
            row(&[
                ("field_id", text("f1")),
                ("section", text("")),
                ("label", text("Recovery code")),
                ("kind", text("sealed")),
                ("value_sealed", text("lk1:AAAA")),
                ("position", Cell::Integer(0)),
            ]),
            row(&[
                ("field_id", text("f2")),
                ("section", text("")),
                ("label", text("Account number")),
                ("kind", text("text")),
                ("value_text", text("12345")),
                ("position", Cell::Integer(1)),
            ]),
        ];
        let fields = fold_fields(&rows);
        assert_eq!(fields[0].label, "Recovery code");
        assert_eq!(fields[0].value, None);
        assert!(fields[0].sealed);
        assert_eq!(fields[1].value.as_deref(), Some("12345"));
        assert!(!fields[1].sealed);
    }

    /// The placeholder is not a value either — a sealed field whose cell holds
    /// the vault's placeholder is still sealed and still carries nothing.
    #[test]
    fn the_placeholder_is_not_a_value() {
        let rows = vec![row(&[
            ("field_id", text("f1")),
            ("section", text("")),
            ("label", text("Code")),
            ("kind", text("sealed")),
            ("value_sealed", text(SEALED_PLACEHOLDER)),
            ("position", Cell::Integer(0)),
        ])];
        let fields = fold_fields(&rows);
        assert_eq!(fields[0].value, None);
        assert!(fields[0].sealed);
    }

    /// A sealed field with NO cell at all is a slot, not a secret.
    #[test]
    fn an_empty_sealed_slot_is_not_sealed() {
        let rows = vec![row(&[
            ("field_id", text("f1")),
            ("section", text("")),
            ("label", text("Code")),
            ("kind", text("sealed")),
            ("position", Cell::Integer(0)),
        ])];
        assert!(!fold_fields(&rows)[0].sealed);
    }

    #[test]
    fn fields_sort_by_section_then_position_then_label() {
        let make = |id: &str, section: &str, position: i64, label: &str| {
            row(&[
                ("field_id", text(id)),
                ("section", text(section)),
                ("label", text(label)),
                ("kind", text("text")),
                ("position", Cell::Integer(position)),
            ])
        };
        let rows = vec![
            make("f3", "Bank", 0, "Sort code"),
            make("f1", "", 1, "Second"),
            make("f2", "", 0, "First"),
            make("f4", "Bank", 0, "Account"),
        ];
        let order: Vec<&str> = fold_fields(&rows)
            .iter()
            .map(|field| field.field_id.as_str())
            .map(str::to_owned)
            .collect::<Vec<String>>()
            .iter()
            .map(|id| match id.as_str() {
                "f1" => "f1",
                "f2" => "f2",
                "f3" => "f3",
                _ => "f4",
            })
            .collect();
        assert_eq!(order, ["f2", "f1", "f4", "f3"]);
    }

    #[test]
    fn a_passkeys_private_key_becomes_a_boolean() {
        let with = vec![row(&[
            ("item_id", text("i1")),
            ("rp_id", text("bank.example")),
            ("private_key", text("lk1:AAAA")),
            ("created_at", text("2026-01-01T00:00:00.000Z")),
        ])];
        let passkey = fold_passkey(&with).expect("a passkey");
        assert!(passkey.has_private_key);
        assert_eq!(passkey.rp_id, "bank.example");

        let without = vec![row(&[
            ("item_id", text("i1")),
            ("rp_id", text("bank.example")),
        ])];
        assert!(!fold_passkey(&without).expect("a slot").has_private_key);
        assert_eq!(fold_passkey(&[]), None);
    }

    /// A REVISION NAMES COLUMNS, NEVER VALUES — and a rotation is named by its
    /// plain witness.
    #[test]
    fn a_revision_names_the_password_only_through_password_set_at() {
        let current = serde_json::json!({
            "title": "Bank",
            "password_set_at": "2026-02-01T00:00:00.000Z",
            "password": "lk1:NEW"
        });
        let rows = vec![row(&[
            ("revision_id", text("r1")),
            ("operation", text("update")),
            (
                "snapshot_json",
                text(
                    r#"{"title":"Bank","password_set_at":"2026-01-01T00:00:00.000Z","password":"lk1:OLD"}"#,
                ),
            ),
            ("recorded_at", text("2026-02-01T00:00:00.000Z")),
        ])];
        let history = fold_history(&rows, &current);
        assert_eq!(history[0].changed, ["password"]);
        assert!(!history[0].unreadable);
        // `password` the CIPHERTEXT differs too and is NOT on the allow-list,
        // so it contributes nothing: the word came from `password_set_at`.
        assert!(
            !REVISION_COLUMNS
                .iter()
                .any(|(column, _)| *column == "password"),
            "the sealed column is on the revision allow-list"
        );
        for sealed in [
            "password",
            "otp_seed",
            "card_number",
            "cvv",
            "content",
            "value_sealed",
        ] {
            assert!(
                !REVISION_COLUMNS.iter().any(|(column, _)| *column == sealed),
                "{sealed} is on the revision allow-list"
            );
        }
    }

    /// A snapshot that will not parse names NOTHING, and says so.
    #[test]
    fn an_unreadable_snapshot_names_nothing_rather_than_everything() {
        let current = serde_json::json!({"title": "Bank"});
        let rows = vec![row(&[
            ("revision_id", text("r1")),
            ("operation", text("update")),
            ("snapshot_json", text("{not json")),
            ("recorded_at", text("2026-02-01T00:00:00.000Z")),
        ])];
        let history = fold_history(&rows, &current);
        assert!(history[0].changed.is_empty());
        assert!(history[0].unreadable);
    }

    /// The chain walks backwards: each revision is diffed against the state
    /// that SUPERSEDED it, not against the live item.
    #[test]
    fn the_chain_is_diffed_pairwise_and_not_against_the_live_item() {
        let current = serde_json::json!({"title": "Third"});
        let rows = vec![
            row(&[
                ("revision_id", text("r2")),
                ("operation", text("update")),
                ("snapshot_json", text(r#"{"title":"Second"}"#)),
                ("recorded_at", text("2026-02-02T00:00:00.000Z")),
            ]),
            row(&[
                ("revision_id", text("r1")),
                ("operation", text("update")),
                ("snapshot_json", text(r#"{"title":"Second"}"#)),
                ("recorded_at", text("2026-02-01T00:00:00.000Z")),
            ]),
        ];
        let history = fold_history(&rows, &current);
        assert_eq!(history[0].changed, ["title"]);
        // The second revision holds the same title as the first, so nothing
        // changed between them — diffed against the live item it would have
        // claimed a change that never happened.
        assert!(history[1].changed.is_empty());
    }

    /// "No fields" and "fields I may not see" are two answers.
    #[test]
    fn a_refused_section_is_not_an_empty_section() {
        let read: SidecarReading<Field> = SidecarReading::Read(Vec::new());
        let refused: SidecarReading<Field> = SidecarReading::Refused;
        assert!(read.rows().is_empty());
        assert!(refused.rows().is_empty());
        assert!(!read.refused());
        assert!(refused.refused());
        assert_ne!(read, refused);
    }

    #[test]
    fn an_attachments_media_type_prefers_the_attachments_own_representation() {
        let edges = vec![row(&[
            ("attachment_id", text("a1")),
            ("content_id", text("c1")),
            ("role", text("scan")),
        ])];
        let contents = vec![row(&[
            ("content_id", text("c1")),
            ("byte_size", Cell::Integer(2048)),
        ])];
        let by_owner = [(
            owner_key(ITEM_ATTACHMENT_OWNER, "a1"),
            "application/pdf".to_owned(),
        )]
        .into_iter()
        .collect();
        let by_content = [("c1".to_owned(), "image/png".to_owned())]
            .into_iter()
            .collect();
        let folded = fold_attachments(&edges, &contents, &by_owner, &by_content);
        assert_eq!(folded[0].media_type.as_deref(), Some("application/pdf"));
        assert_eq!(folded[0].byte_size, Some(2048));

        let folded = fold_attachments(&edges, &contents, &BTreeMap::new(), &by_content);
        assert_eq!(folded[0].media_type.as_deref(), Some("image/png"));

        let folded = fold_attachments(&edges, &contents, &BTreeMap::new(), &BTreeMap::new());
        assert_eq!(folded[0].media_type, None);
    }

    /// Every sidecar statement is keyed on one item, so none of them can be
    /// asked for the whole table.
    #[test]
    fn every_sidecar_statement_is_pinned_to_one_item() {
        for query in [
            alias_statement("i1"),
            fields_statement("i1"),
            addresses_statement("i1"),
            passkey_statement("i1"),
            revisions_statement("i1"),
            attachments_statement("i1"),
        ] {
            let predicate = query
                .r#where
                .clone()
                .unwrap_or_else(|| panic!("{} has no predicate", query.name));
            assert!(predicate.contains('?'), "{} takes no bind", query.name);
            assert!(
                query
                    .bind
                    .iter()
                    .any(|bind| { matches!(bind, PageBindValue::Text(value) if value == "i1") }),
                "{} is not pinned to the item",
                query.name
            );
        }
    }
}
