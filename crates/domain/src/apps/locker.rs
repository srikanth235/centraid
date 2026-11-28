//! Locker: items whose sensitive values are sealed.

use rusqlite::Row;

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported};
use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, desc, param, read};

use super::{Trashed, trash};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockerItemSummary {
    pub id: String,
    pub title: String,
    pub item_type: String,
    pub compromised: bool,
    pub last_used_at: Option<String>,
    pub starred_at: Option<String>,
    pub at: String,
}

impl LockerItemSummary {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            item_type: row.get("item_type")?,
            compromised: row.get::<_, i64>("compromised")? != 0,
            last_used_at: row.get("last_used_at")?,
            starred_at: row.get("starred_at")?,
            at: row.get("at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockerItemDetail {
    pub id: String,
    pub title: String,
    pub item_type: String,
    pub compromised: bool,
    pub last_used_at: Option<String>,
    pub starred_at: Option<String>,
    pub arrived_via: Option<String>,
    pub arrived_label: Option<String>,
    pub updated_at: String,
}

impl LockerItemDetail {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            item_type: row.get("item_type")?,
            compromised: row.get::<_, i64>("compromised")? != 0,
            last_used_at: row.get("last_used_at")?,
            starred_at: row.get("starred_at")?,
            arrived_via: row.get("arrived_via")?,
            arrived_label: row.get("arrived_label")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LockerFieldMeta {
    pub id: String,
    pub item_id: String,
    pub field_key: Option<String>,
    pub kind: String,
    pub section: String,
    pub label: String,
    pub value_text: Option<String>,
    pub value_set_at: Option<String>,
    pub position: f64,
}

impl LockerFieldMeta {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            item_id: row.get("item_id")?,
            field_key: row.get("field_key")?,
            kind: row.get("kind")?,
            section: row.get("section")?,
            label: row.get("label")?,
            value_text: row.get("value_text")?,
            value_set_at: row.get("value_set_at")?,
            position: row.get("position")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockerPasskeyMeta {
    pub id: String,
    pub item_id: String,
    pub rp_id: String,
    pub user_handle: Option<String>,
    pub display_name: Option<String>,
    pub created_at: String,
}

impl LockerPasskeyMeta {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            item_id: row.get("item_id")?,
            rp_id: row.get("rp_id")?,
            user_handle: row.get("user_handle")?,
            display_name: row.get("display_name")?,
            created_at: row.get("created_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockerExpiryAlert {
    pub id: String,
    pub item_id: String,
    pub field_id: String,
    pub offset_min: i64,
    pub expires_on: Option<String>,
    pub snoozed_until: Option<String>,
}

impl LockerExpiryAlert {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            item_id: row.get("item_id")?,
            field_id: row.get("field_id")?,
            offset_min: row.get("offset_min")?,
            expires_on: row.get("expires_on")?,
            snoozed_until: row.get("snoozed_until")?,
        })
    }
}

pub const ITEMS: Read<LockerItemSummary> = read(
    ReadDecl {
        name: "locker.items",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, l.type AS item_type, l.compromised, l.last_used_at, \
                     e.starred_at, e.updated_at AS at \
              FROM entity e JOIN locker_item l ON l.id = e.id \
              WHERE e.kind = 'locker_item' AND e.deleted_at IS NULL \
                AND (e.updated_at, e.id) < (:a, :b) \
              ORDER BY e.updated_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["locker_item"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    LockerItemSummary::of,
);

pub const ITEMS_BY_TYPE: Read<LockerItemSummary> = read(
    ReadDecl {
        name: "locker.items_by_type",
        shape: Shape::PagedList,
        sql: "SELECT l.id, e.title, l.type AS item_type, l.compromised, l.last_used_at, \
                     e.starred_at, e.updated_at AS at \
              FROM locker_item l INDEXED BY locker_item_by_type \
              JOIN entity e ON e.id = l.id \
              WHERE l.type = :item_type AND e.deleted_at IS NULL AND l.id < :a \
              ORDER BY l.id DESC LIMIT :n",
        params: &[param("item_type", ParamTy::Text)],
        reads: &["locker_item"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("id", "a")],
    },
    LockerItemSummary::of,
);

pub const STARRED: Read<LockerItemSummary> = read(
    ReadDecl {
        name: "locker.starred",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, l.type AS item_type, l.compromised, l.last_used_at, \
                     e.starred_at, e.starred_at AS at \
              FROM entity e JOIN locker_item l ON l.id = e.id \
              WHERE e.kind = 'locker_item' AND e.starred_at IS NOT NULL \
                AND e.deleted_at IS NULL AND (e.starred_at, e.id) < (:a, :b) \
              ORDER BY e.starred_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["locker_item"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    LockerItemSummary::of,
);

pub const ITEM_BY_ID: Read<LockerItemDetail> = read(
    ReadDecl {
        name: "locker.item_by_id",
        shape: Shape::ByKey,
        sql: "SELECT locker_item.id, entity.title, locker_item.type AS item_type, \
                     locker_item.compromised, locker_item.last_used_at, entity.starred_at, \
                     entity.arrived_via, entity.arrived_label, entity.updated_at \
              FROM locker_item JOIN entity ON entity.id = locker_item.id \
              WHERE locker_item.id = :id AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &["locker_item"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    LockerItemDetail::of,
);

// Plaintext metadata only: the authorizer denies value_sealed and value_blob to every module.
pub const FIELDS_OF_ITEM: Read<LockerFieldMeta> = read(
    ReadDecl {
        name: "locker.fields_of_item",
        shape: Shape::BoundedChild,
        sql: "SELECT id, item_id, field_key, kind, section, label, value_text, value_set_at, position \
              FROM locker_item_field \
              WHERE item_id = :item_id \
              ORDER BY position ASC, id ASC LIMIT 200",
        params: &[param("item_id", ParamTy::Id)],
        reads: &["locker_item_field"],
        across: &[],
        bound: 200,
        cursor: &[],
    },
    LockerFieldMeta::of,
);

// Plaintext metadata only: the authorizer denies private_key to every module.
pub const PASSKEYS_OF_ITEM: Read<LockerPasskeyMeta> = read(
    ReadDecl {
        name: "locker.passkeys_of_item",
        shape: Shape::BoundedChild,
        sql: "SELECT id, item_id, rp_id, user_handle, display_name, created_at \
              FROM locker_item_passkey \
              WHERE item_id = :item_id \
              ORDER BY id ASC LIMIT 50",
        params: &[param("item_id", ParamTy::Id)],
        reads: &["locker_item_passkey"],
        across: &[],
        bound: 50,
        cursor: &[],
    },
    LockerPasskeyMeta::of,
);

pub const EXPIRY_ALERTS: Read<LockerExpiryAlert> = read(
    ReadDecl {
        name: "locker.expiry_alerts",
        shape: Shape::BoundedChild,
        sql: "SELECT r.id, r.entity_id AS item_id, r.field_id, r.offset_min, \
                     f.value_text AS expires_on, s.until AS snoozed_until \
              FROM reminder r INDEXED BY reminder_by_kind \
              JOIN entity e ON e.id = r.entity_id \
              JOIN locker_item_field f ON f.id = r.field_id \
              LEFT JOIN snooze s ON s.field_id = r.field_id \
              WHERE r.entity_kind = 'locker_item' AND e.deleted_at IS NULL \
              ORDER BY r.entity_id ASC LIMIT 100",
        params: &[],
        reads: &["locker_item_field"],
        across: &["reminder", "entity", "snooze"],
        bound: 100,
        cursor: &[],
    },
    LockerExpiryAlert::of,
);

pub const TRASH: Read<Trashed> = trash!("locker.trash", "'locker_item'");

pub const READS: &[ReadDecl] = &[
    ITEMS.decl,
    ITEMS_BY_TYPE.decl,
    STARRED.decl,
    ITEM_BY_ID.decl,
    FIELDS_OF_ITEM.decl,
    PASSKEYS_OF_ITEM.decl,
    EXPIRY_ALERTS.decl,
    TRASH.decl,
];

pub const KINDS: &[KindDecl] = &[KindDecl::new(
    "locker_item",
    "locker",
    "item",
    "items",
    Trash::Listed("locker.trash"),
)
.footers(&[Footer::Linked, Footer::MentionedIn, Footer::Origin])
.exports(Export::File {
    header: "centraid.locker.v1",
    format: exported,
})
.shares(Share::Never(
    "a Locker item is never handed to the share sheet",
))];
