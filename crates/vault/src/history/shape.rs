//! What an entity's state is: the classification of every table, and the SQL derived from it.
//!
//! [`TABLES`] is the one place that says which tables make up an entity's state; [`OMITTED`] the
//! one place that says which columns of those tables are not kept, each with its reason;
//! [`BLOB_SLOTS`] the one place that says which columns name bytes. Every other column is kept
//! automatically, read from the file's own `table_xinfo`. A test fails when a table the baseline
//! makes, a kind the model names, or a column that references `blob(hash)` is not classified here.
//!
//! THE SNAPSHOT GRAMMAR (B1, version [`SHAPE_VERSION`]): a host's state is its entity's `title` and
//! home (`parent_id`), its kind row, and the rows it OWNS (a person's contact points, an event's
//! guests and reminders, a note's assets, a Locker item's fields). Edges, links, `budget`, `rule`,
//! `occurrence` and `transfer` belong to a relationship or a series, not to one record, and are
//! outside: setting a budget writes no copy of the category's other budgets or rules.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use rusqlite::Connection;

use super::{SEEN, STATE_VIEW};
use crate::error::Result;
use crate::model::Kind;

/// The grammar version a `revision` is written in (`revision.shape`). A reader refuses a version
/// written by a newer grammar rather than read it as this one.
pub const SHAPE_VERSION: i64 = 1;

/// What a table is to the history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The entity row: its `title` and its home (`parent_id`) are a member's state.
    Entity,
    /// A kind's own row, keyed by the entity's id (`concept` and `container` host several kinds).
    Host,
    /// Rows that belong to one entity, a part of its state: `via` is the column that holds the
    /// entity's id, `hosts` the kind rows they hang from. A row goes by the primary key's other
    /// columns.
    Child {
        hosts: &'static [&'static str],
        via: &'static str,
    },
    /// Not an entity's state, with the reason.
    Outside(&'static str),
}

/// A lookup table: seeded and written only by a migration rung.
const LOOKUP: Role = Role::Outside("a lookup: written only by a migration rung");

/// Every table of the vault, classified. A table not named here fails
/// `every_table_is_classified`.
pub const TABLES: &[(&str, Role)] = &[
    ("entity", Role::Entity),
    // The kind rows.
    ("person", Role::Host),
    ("place", Role::Host),
    ("event", Role::Host),
    ("task", Role::Host),
    ("workout", Role::Host),
    ("touch", Role::Host),
    ("reading", Role::Host),
    ("note", Role::Host),
    ("document", Role::Host),
    ("photo", Role::Host),
    ("account", Role::Host),
    ("txn", Role::Host),
    ("thread", Role::Host),
    ("locker_item", Role::Host),
    ("concept", Role::Host),
    ("container", Role::Host),
    // The rows a kind row owns. Order matters to a restore: a row is written after the rows it
    // points at (a reminder after the date or field it names).
    (
        "contact_point",
        Role::Child {
            hosts: &["person"],
            via: "person_id",
        },
    ),
    (
        "person_date",
        Role::Child {
            hosts: &["person"],
            via: "person_id",
        },
    ),
    (
        "event_guest",
        Role::Child {
            hosts: &["event"],
            via: "event_id",
        },
    ),
    (
        "txn_split",
        Role::Child {
            hosts: &["txn"],
            via: "txn_id",
        },
    ),
    (
        "note_asset",
        Role::Child {
            hosts: &["note"],
            via: "note_id",
        },
    ),
    (
        "locker_item_field",
        Role::Child {
            hosts: &["locker_item"],
            via: "item_id",
        },
    ),
    (
        "locker_item_passkey",
        Role::Child {
            hosts: &["locker_item"],
            via: "item_id",
        },
    ),
    (
        "reminder",
        Role::Child {
            hosts: &["event", "task", "person", "locker_item"],
            via: "entity_id",
        },
    ),
    // Not an entity's state.
    (
        "vault",
        Role::Outside("the vault's own row and write counter"),
    ),
    (
        "edge",
        Role::Outside(
            "B1: a relation between two records is neither one's snapshot; it has its own verbs and Undo",
        ),
    ),
    (
        "link",
        Role::Outside("B1: a hand-made link joins two records and belongs to neither"),
    ),
    (
        "mention",
        Role::Outside("rebuilt from the note's words on every save"),
    ),
    (
        "transfer",
        Role::Outside("B1: a transfer pairs two lines and belongs to neither"),
    ),
    (
        "txn_match_dismissal",
        Role::Outside("B1: a dismissed match names two lines and belongs to neither"),
    ),
    (
        "budget",
        Role::Outside("B1: a budget is not part of its category's snapshot"),
    ),
    (
        "rule",
        Role::Outside("B1: a rule is not part of its category's snapshot"),
    ),
    (
        "occurrence",
        Role::Outside("B1: a one-day override is not part of its series' snapshot"),
    ),
    (
        "blob",
        Role::Outside(
            "bytes, by hash; a version names one through `revision_blob` and copies none",
        ),
    ),
    (
        "derivative",
        Role::Outside("derived from a blob, rebuilt on demand"),
    ),
    (
        "origin",
        Role::Outside("what a phone store is, not a record"),
    ),
    (
        "source",
        Role::Outside("what the phone last said; `follow::differences` reads it"),
    ),
    ("revision", Role::Outside("the history itself")),
    (
        "revision_blob",
        Role::Outside("the history's own blob claims"),
    ),
    ("action_key", Role::Outside("the keys of acts already run")),
    ("search_owed", Role::Outside("the index file's queue")),
    (
        "measurement",
        Role::Outside("a day's total, not an edit; a correction overwrites it"),
    ),
    (
        "checkpoint",
        Role::Outside("a balance the bank stated; never edited"),
    ),
    (
        "message",
        Role::Outside("a chat's transcript is appended, never edited"),
    ),
    (
        "message_attachment",
        Role::Outside("a chat's transcript is appended, never edited"),
    ),
    ("locker_key", Role::Outside("custody's own bookkeeping")),
    ("entity_kind", LOOKUP),
    ("home_shape", LOOKUP),
    ("concept_kind", LOOKUP),
    ("container_kind", LOOKUP),
    ("palette", LOOKUP),
    ("arrival_via", LOOKUP),
    ("arrival_via_kind", LOOKUP),
    ("origin_system", LOOKUP),
    ("source_shape", LOOKUP),
    ("derivative_variant", LOOKUP),
    ("contact_point_kind", LOOKUP),
    ("photo_form", LOOKUP),
    ("account_type", LOOKUP),
    ("locker_type", LOOKUP),
    ("message_refusal", LOOKUP),
    ("message_notice", LOOKUP),
    ("person_form", LOOKUP),
    ("person_date_kind", LOOKUP),
    ("reminder_target", LOOKUP),
    ("health_metric", LOOKUP),
    ("edge_shape", LOOKUP),
];

/// The columns of the tables above that are not kept, with the reason. Everything else is.
///
/// A host's `id` and a child's `via` column are the entity's id and are never state; they are
/// not listed.
pub const OMITTED: &[(&str, &str, &str)] = &[
    ("entity", "n", "row order"),
    ("entity", "id", "identity"),
    ("entity", "kind", "identity"),
    ("entity", "parent_kind", "identity: the home's kind"),
    ("entity", "created_at", "stamp, never edited"),
    ("entity", "updated_at", "stamp; every commit moves it"),
    (
        "entity",
        "deleted_at",
        "trash is not state: a trashed record is the same record",
    ),
    ("entity", "purge_at", "trash is not state"),
    ("entity", "trashed_by", "trash is not state"),
    (
        "entity",
        "starred_at",
        "A14: a star is not an edit; it stamps no revision",
    ),
    (
        "entity",
        "pinned_at",
        "A14: a pin is not an edit; it stamps no revision",
    ),
    (
        "entity",
        "archived_at",
        "A14: an archive is not an edit; it stamps no revision",
    ),
    ("entity", "arrived_via", "provenance, never edited"),
    ("entity", "arrived_label", "provenance, never edited"),
    ("concept", "kind", "identity: the entity's kind"),
    ("container", "kind", "identity: the entity's kind"),
    // The file a photograph is does not change; an edit makes another photograph. Its motion clip
    // is named like any blob ([`BLOB_SLOTS`]).
    // An album's cover shows bytes the album points at; it is not the album's own content, so a
    // version keeps none of it and a purged photograph's bytes go with it.
    (
        "container",
        "cover",
        "a view of another item's bytes, not the album's content",
    ),
    ("photo", "blob", "immutable: the file"),
    ("photo", "media_type", "immutable: the file"),
    ("photo", "form", "immutable: the file"),
    ("photo", "width", "immutable: the file"),
    ("photo", "height", "immutable: the file"),
    ("photo", "duration_s", "immutable: the file"),
    ("photo", "motion_duration_s", "immutable: the file"),
    ("photo", "exif", "immutable: the file"),
    ("photo", "burst", "immutable: the camera's"),
    ("photo", "edited_from", "immutable: how it was made"),
    // A line's origin is not an edit: the one change it ever makes (a hand line confirmed as a
    // statement line) is the command's, and a restore must not undo it (the table refuses it).
    ("txn", "entered", "a line's origin is not an edit"),
    // Locker: the sealed cells are kept as the ciphertext they are, never a plaintext. What is only
    // a use of the item is not an edit.
    ("locker_item", "last_used_at", "a use is not an edit"),
    (
        "locker_item_field",
        "updated_at",
        "a stamp, set by the command from the vault's clock; every save moves it",
    ),
    (
        "locker_item_passkey",
        "updated_at",
        "a stamp, set by the command from the vault's clock; every save moves it",
    ),
];

/// Where a column's bytes are named by a version (B3): not inside the state, which holds no hash,
/// but as a `revision_blob` row. One row here is all an app lane writes to keep a new blob
/// column's earlier values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobSlot {
    /// The kind row or child table that holds the column.
    pub table: &'static str,
    /// The column that references `blob(hash)`.
    pub column: &'static str,
    /// The `revision_blob.slot` it is kept under.
    pub slot: SlotName,
    /// A column of the same row kept beside the bytes as `revision_blob.media_type`, so the state
    /// holds neither.
    pub media_type: Option<&'static str>,
}

/// How a [`BlobSlot`] is named.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotName {
    /// One slot for the entity's one row (`avatar`).
    One(&'static str),
    /// One slot per row of a child table: `<prefix>:<the row's id column>` (`asset:<id>`).
    PerRow(&'static str),
}

/// Every column that names bytes and is part of a state. A column that references `blob(hash)` and
/// is neither here nor in [`OMITTED`] fails `every_blob_column_is_a_slot_or_omitted`.
pub const BLOB_SLOTS: &[BlobSlot] = &[
    BlobSlot {
        table: "document",
        column: "blob",
        slot: SlotName::One("blob"),
        media_type: Some("media_type"),
    },
    BlobSlot {
        table: "person",
        column: "avatar",
        slot: SlotName::One("avatar"),
        media_type: None,
    },
    BlobSlot {
        table: "photo",
        column: "motion_blob",
        slot: SlotName::One("motion"),
        media_type: None,
    },
    BlobSlot {
        table: "note_asset",
        column: "blob",
        slot: SlotName::PerRow("asset"),
        media_type: Some("media_type"),
    },
    BlobSlot {
        table: "locker_item_field",
        column: "value_blob",
        slot: SlotName::PerRow("field"),
        media_type: None,
    },
];

/// The slot of `table`'s blob column, if it is one.
#[must_use]
pub fn blob_slot(table: &str, column: &str) -> Option<&'static BlobSlot> {
    BLOB_SLOTS
        .iter()
        .find(|slot| slot.table == table && slot.column == column)
}

/// The columns whose change is NOT a change to the entity a member sees: an update that moves only
/// these neither stamps `updated_at` nor re-indexes. This is the commit triggers' own notion, apart
/// from [`OMITTED`] (what the history does not keep): an immutable or bank-stated column the
/// history leaves out is still a change to the entity when a command moves it (a purge detaching a
/// derived photo's `edited_from`, `txn.account_id` feeding the account's text).
pub const NEVER_TOUCHES: &[(&str, &str, &str)] =
    &[("locker_item", "last_used_at", "a use is not an edit")];

fn never_touches(table: &str, column: &str) -> bool {
    NEVER_TOUCHES
        .iter()
        .any(|(name, never, _)| *name == table && *never == column)
}

/// Whether `table.column` holds ciphertext under the Locker key (`lk1:`): kept in a state exactly
/// as sealed, and shown nowhere but masked ([`crate::history::MASK`]). One list with the custody
/// module's, so a sealed column added there is masked here without a second edit.
#[must_use]
pub fn is_sealed(table: &str, column: &str) -> bool {
    crate::custody::locker_key::LOCKER_ENCRYPTED_COLUMNS
        .iter()
        .any(|(name, _, columns)| *name == table && columns.contains(&column))
}

/// The values kept in a cell of their own on `revision`, not inline in `state`: a note's words,
/// the one value large enough to deserve a cell (`fill_body` reads it).
pub const CONTENT: &[(&str, &str)] = &[("note", "body")];

/// One table of the state, as the file has it.
#[derive(Debug, Clone)]
pub struct Part {
    /// The table.
    pub name: &'static str,
    pub role: Role,
    /// The columns kept, in table order.
    pub columns: Vec<String>,
    /// The columns whose change moves the entity (`updated_at`, search): every live column but
    /// a host's id and the [`NEVER_TOUCHES`] ones, kept by the history or not.
    pub touch_columns: Vec<String>,
    /// The columns that name one row among the entity's rows of this table (empty for a kind row
    /// and for a child that is one row per entity).
    pub key: Vec<String>,
    /// For a column that references another table's row: the table and its column.
    pub references: BTreeMap<String, (String, String)>,
}

impl Part {
    /// Whether the entity has at most one row here (a kind row, a one-to-one child).
    #[must_use]
    pub fn is_one(&self) -> bool {
        self.key.is_empty()
    }

    /// The column holding the entity's id.
    #[must_use]
    pub const fn via(&self) -> &'static str {
        match self.role {
            Role::Child { via, .. } => via,
            _ => "id",
        }
    }
}

/// The classification applied to this file's columns.
#[derive(Debug, Clone)]
pub struct Shape {
    pub parts: Vec<Part>,
}

static SHAPE: OnceLock<Shape> = OnceLock::new();

/// The shape of the vault's tables, read from the file once per process: every file this build
/// opens has the same tables (the schema digest says so).
///
/// # Errors
/// A database error.
pub fn shape(connection: &Connection) -> Result<&'static Shape> {
    if let Some(shape) = SHAPE.get() {
        return Ok(shape);
    }
    let read = Shape::read(connection)?;
    Ok(SHAPE.get_or_init(|| read))
}

fn omitted(table: &str, column: &str) -> bool {
    OMITTED
        .iter()
        .any(|(name, omitted, _)| *name == table && *omitted == column)
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

impl Shape {
    /// Read the classified tables' columns from the file. A classified table the file does not
    /// have (an earlier rung) is left out.
    ///
    /// # Errors
    /// A database error.
    pub fn read(connection: &Connection) -> Result<Self> {
        let mut parts = Vec::new();
        for (name, role) in TABLES {
            if matches!(role, Role::Outside(_) | Role::Entity) {
                continue;
            }
            let via = match role {
                Role::Child { via, .. } => *via,
                _ => "id",
            };
            let mut statement =
                connection.prepare(&format!("PRAGMA table_xinfo({})", quoted(name)))?;
            let rows: Vec<(String, i64, i64)> = statement
                .query_map([], |row| Ok((row.get(1)?, row.get(5)?, row.get(6)?)))?
                .collect::<rusqlite::Result<_>>()?;
            if rows.is_empty() {
                continue;
            }
            // Generated columns (`kind`, `notebook_kind`, ...) are derived from kept ones.
            let live: Vec<&(String, i64, i64)> = rows.iter().filter(|row| row.2 == 0).collect();
            let columns = live
                .iter()
                .map(|row| row.0.clone())
                .filter(|column| column != via && !omitted(name, column))
                .collect();
            let touch_columns = live
                .iter()
                .map(|row| row.0.clone())
                .filter(|column| {
                    (column != via || matches!(role, Role::Child { .. }))
                        && !never_touches(name, column)
                })
                .collect();
            let mut keyed: Vec<&&(String, i64, i64)> = live
                .iter()
                .filter(|row| row.1 > 0 && row.0 != via)
                .collect();
            keyed.sort_by_key(|row| row.1);
            let key = keyed.into_iter().map(|row| row.0.clone()).collect();
            let mut references = BTreeMap::new();
            let mut fks =
                connection.prepare(&format!("PRAGMA foreign_key_list({})", quoted(name)))?;
            for row in fks.query_map([], |row| {
                Ok((
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(4)?,
                ))
            })? {
                let (from, table, to) = row?;
                references.insert(from, (table, to));
            }
            parts.push(Part {
                name,
                role: *role,
                columns,
                touch_columns,
                key,
                references,
            });
        }
        Ok(Self { parts })
    }

    /// The part for a table.
    #[must_use]
    pub fn part(&self, name: &str) -> Option<&Part> {
        self.parts.iter().find(|part| part.name == name)
    }

    /// The children that hang from a kind row.
    pub fn children_of<'a>(&'a self, host: &'a str) -> impl Iterator<Item = &'a Part> {
        self.parts.iter().filter(
            move |part| matches!(part.role, Role::Child { hosts, .. } if hosts.contains(&host)),
        )
    }

    /// The kind rows.
    pub fn hosts(&self) -> impl Iterator<Item = &Part> {
        self.parts.iter().filter(|part| part.role == Role::Host)
    }

    /// The JSON object expression for one row of `part`, read through the alias `alias`.
    fn object(part: &Part, alias: &str) -> String {
        let pairs: Vec<String> = part
            .columns
            .iter()
            .map(|column| format!("'{column}', {alias}.{}", quoted(column)))
            .collect();
        format!("json_object({})", pairs.join(", "))
    }

    /// The expression for an entity's whole state, over `e` (an `entity` row).
    fn state_expression(&self) -> String {
        let mut branches = Vec::new();
        for host in self.hosts() {
            let kinds: Vec<String> = Kind::ALL
                .iter()
                .filter(|kind| kind.host() == host.name)
                .map(|kind| format!("'{}'", kind.as_str()))
                .collect();
            let mut members = vec![
                "'entity', json_object('title', e.title, 'parent_id', e.parent_id)".to_owned(),
                format!(
                    "'{host_name}', json((SELECT {obj} FROM {table} t WHERE t.id = e.id))",
                    host_name = host.name,
                    obj = Self::object(host, "t"),
                    table = quoted(host.name),
                ),
            ];
            for child in self.children_of(host.name) {
                let Role::Child { via, .. } = child.role else {
                    continue;
                };
                let rows = if child.is_one() {
                    format!(
                        "(SELECT {obj} FROM {table} c WHERE c.{via} = e.id)",
                        obj = Self::object(child, "c"),
                        table = quoted(child.name),
                        via = quoted(via),
                    )
                } else {
                    let order: Vec<String> = child
                        .key
                        .iter()
                        .map(|column| format!("c.{}", quoted(column)))
                        .collect();
                    format!(
                        "(SELECT json_group_array({obj} ORDER BY {order}) FROM {table} c
                           WHERE c.{via} = e.id)",
                        obj = Self::object(child, "c"),
                        order = order.join(", "),
                        table = quoted(child.name),
                        via = quoted(via),
                    )
                };
                members.push(format!("'{}', json({rows})", child.name));
            }
            branches.push(format!(
                "WHEN e.kind IN ({}) THEN json_object({})",
                kinds.join(", "),
                members.join(", ")
            ));
        }
        format!("CASE {} END", branches.join(" "))
    }

    /// The statements that install the history's door on a connection.
    pub(super) fn install_sql(&self) -> String {
        let mut sql = format!(
            "CREATE TEMP TABLE IF NOT EXISTS {SEEN} (entity_id TEXT PRIMARY KEY, state TEXT)
               WITHOUT ROWID;
             DROP VIEW IF EXISTS temp.{STATE_VIEW};
             CREATE TEMP VIEW {STATE_VIEW} (entity_id, state) AS
               SELECT e.id, {} FROM main.entity e;\n",
            self.state_expression()
        );
        // The entity's state, recorded once per commit, the first time a row of it is about to
        // change.
        let seen = |id: &str| {
            format!(
                "INSERT INTO temp.{SEEN} (entity_id, state)
                   SELECT {id}, (SELECT state FROM temp.{STATE_VIEW} WHERE entity_id = {id})
                    WHERE NOT EXISTS (SELECT 1 FROM temp.{SEEN} WHERE entity_id = {id});"
            )
        };
        let mut trigger = |name: &str, when: &str, table: &str, body: String| {
            sql.push_str(&format!(
                "CREATE TEMP TRIGGER IF NOT EXISTS centraid_history_{name}
                   {when} ON main.{table} BEGIN {body} END;\n",
                table = quoted(table)
            ));
        };
        // A creation has no earlier state; a deletion's rows are about to go.
        trigger(
            "entity_born",
            "AFTER INSERT",
            "entity",
            format!("INSERT OR IGNORE INTO temp.{SEEN} (entity_id, state) VALUES (new.id, NULL);"),
        );
        trigger(
            "entity_gone",
            "BEFORE DELETE",
            "entity",
            format!("INSERT OR IGNORE INTO temp.{SEEN} (entity_id, state) VALUES (old.id, NULL);"),
        );
        trigger(
            "entity_title",
            "BEFORE UPDATE OF title, parent_id",
            "entity",
            seen("old.id"),
        );
        for part in &self.parts {
            let via = quoted(part.via());
            let alias = part.name;
            trigger(
                &format!("{alias}_update"),
                "BEFORE UPDATE",
                part.name,
                seen(&format!("old.{via}")),
            );
            trigger(
                &format!("{alias}_delete"),
                "BEFORE DELETE",
                part.name,
                seen(&format!("old.{via}")),
            );
            if matches!(part.role, Role::Child { .. }) {
                trigger(
                    &format!("{alias}_insert"),
                    "BEFORE INSERT",
                    part.name,
                    seen(&format!("new.{via}")),
                );
            }
        }
        // Also install auto-touch / auto-reindex triggers so every write to an entity, its host
        // row, its child rows, or its edges automatically lands in `updated_at`, `search`, and
        // `alert` at commit — without relying on every command handler remembering `ctx.touch`.
        sql.push_str(&format!(
            "CREATE TEMP TABLE IF NOT EXISTS {COMMIT_TOUCHED}
               (entity_id TEXT PRIMARY KEY, stamp INTEGER NOT NULL DEFAULT 0, born INTEGER NOT NULL DEFAULT 0)
               WITHOUT ROWID;\n",
            COMMIT_TOUCHED = super::COMMIT_TOUCHED,
        ));
        let mark_stamp = |id: &str| {
            format!(
                "INSERT INTO temp.{t} (entity_id, stamp, born) VALUES ({id}, 1, 0)
                   ON CONFLICT (entity_id) DO UPDATE SET stamp = 1;",
                t = super::COMMIT_TOUCHED,
            )
        };
        let mark_reindex = |id: &str| {
            format!(
                "INSERT OR IGNORE INTO temp.{t} (entity_id, stamp, born) VALUES ({id}, 0, 0);",
                t = super::COMMIT_TOUCHED,
            )
        };
        let changed = |columns: &[String]| {
            columns
                .iter()
                .map(|c| format!("old.{q} IS NOT new.{q}", q = quoted(c)))
                .collect::<Vec<_>>()
                .join(" OR ")
        };
        let mut touch_trigger =
            |name: &str, timing: &str, table: &str, guard: Option<&str>, body: String| {
                let when_clause = guard.map_or(String::new(), |g| format!(" WHEN {g}"));
                sql.push_str(&format!(
                    "CREATE TEMP TRIGGER IF NOT EXISTS centraid_commit_{name}
                   {timing} ON main.{table}{when_clause} BEGIN {body} END;\n",
                    table = quoted(table),
                ));
            };
        touch_trigger(
            "entity_born",
            "AFTER INSERT",
            "entity",
            None,
            format!(
                "INSERT INTO temp.{t} (entity_id, stamp, born) VALUES (new.id, 0, 1)
                   ON CONFLICT (entity_id) DO UPDATE SET born = 1;",
                t = super::COMMIT_TOUCHED,
            ),
        );
        touch_trigger(
            "entity_gone",
            "AFTER DELETE",
            "entity",
            None,
            mark_reindex("old.id"),
        );
        touch_trigger(
            "entity_update",
            "AFTER UPDATE OF title, parent_id, deleted_at, purge_at",
            "entity",
            Some(
                "old.title IS NOT new.title OR old.parent_id IS NOT new.parent_id
                 OR old.deleted_at IS NOT new.deleted_at OR old.purge_at IS NOT new.purge_at",
            ),
            mark_stamp("new.id"),
        );
        // An edge is no part of a state (B1) but it still moves what the index file reads.
        // Re-index only the endpoint whose `index::text_of` actually reads this
        // relation — never the container or tag end, because adding one member to a
        // large list/tag must not expand all of the label's other dependents into
        // `search_owed`. Reordering (`position`) fires nothing.
        touch_trigger(
            "edge_to_insert",
            "AFTER INSERT",
            "edge",
            Some("new.rel IN ('contains', 'about', 'with')"),
            mark_reindex("new.to_id"),
        );
        touch_trigger(
            "edge_to_delete",
            "AFTER DELETE",
            "edge",
            Some("old.rel IN ('contains', 'about', 'with')"),
            mark_reindex("old.to_id"),
        );
        touch_trigger(
            "edge_from_insert",
            "AFTER INSERT",
            "edge",
            Some("new.rel = 'tagged'"),
            mark_reindex("new.from_id"),
        );
        touch_trigger(
            "edge_from_delete",
            "AFTER DELETE",
            "edge",
            Some("old.rel = 'tagged'"),
            mark_reindex("old.from_id"),
        );
        touch_trigger(
            "edge_related_insert",
            "AFTER INSERT",
            "edge",
            Some("new.rel = 'related'"),
            format!(
                "{} {}",
                mark_reindex("new.from_id"),
                mark_reindex("new.to_id")
            ),
        );
        touch_trigger(
            "edge_related_update",
            "AFTER UPDATE OF \"label_id\"",
            "edge",
            Some("new.rel = 'related' AND old.label_id IS NOT new.label_id"),
            format!(
                "{} {}",
                mark_reindex("new.from_id"),
                mark_reindex("new.to_id")
            ),
        );
        touch_trigger(
            "edge_related_delete",
            "AFTER DELETE",
            "edge",
            Some("old.rel = 'related'"),
            format!(
                "{} {}",
                mark_reindex("old.from_id"),
                mark_reindex("old.to_id")
            ),
        );
        // A one-day override (B1: outside its series' snapshot) moves the series' alerts: the
        // series is queued for the index file, and nothing is stamped or versioned.
        touch_trigger(
            "occurrence_insert",
            "AFTER INSERT",
            "occurrence",
            None,
            mark_reindex("new.series_id"),
        );
        touch_trigger(
            "occurrence_update",
            "AFTER UPDATE",
            "occurrence",
            None,
            mark_reindex("new.series_id"),
        );
        touch_trigger(
            "occurrence_delete",
            "AFTER DELETE",
            "occurrence",
            None,
            mark_reindex("old.series_id"),
        );
        // What a phone store states decides whether the phone or the vault alerts for a record
        // (`alerts::phone_holds`): a source written, changed or gone, and an origin retired (or taken
        // up again), queue the records they name for the index file. Nothing is stamped.
        touch_trigger(
            "source_insert",
            "AFTER INSERT",
            "source",
            Some("new.entity_id IS NOT NULL"),
            mark_reindex("new.entity_id"),
        );
        touch_trigger(
            "source_update",
            "AFTER UPDATE OF stated, gone_at, entity_id",
            "source",
            Some("new.entity_id IS NOT NULL"),
            mark_reindex("new.entity_id"),
        );
        touch_trigger(
            "source_delete",
            "AFTER DELETE",
            "source",
            Some("old.entity_id IS NOT NULL"),
            mark_reindex("old.entity_id"),
        );
        for part in &self.parts {
            match part.role {
                Role::Host => {
                    // Only a column that really changed fires it (`WHEN`), so an upsert that
                    // writes the same values stamps and re-indexes nothing. `touch_columns`
                    // leaves out [`NEVER_TOUCHES`] (`locker_item.last_used_at`), so a reveal
                    // stamp never bumps `updated_at`.
                    if !part.touch_columns.is_empty() {
                        let cols: Vec<String> =
                            part.touch_columns.iter().map(|c| quoted(c)).collect();
                        touch_trigger(
                            &format!("{}_update", part.name),
                            &format!("AFTER UPDATE OF {}", cols.join(", ")),
                            part.name,
                            Some(&changed(&part.touch_columns)),
                            mark_stamp("new.id"),
                        );
                    }
                }
                Role::Child { .. } => {
                    let via = quoted(part.via());
                    touch_trigger(
                        &format!("{}_insert", part.name),
                        "AFTER INSERT",
                        part.name,
                        None,
                        mark_stamp(&format!("new.{via}")),
                    );
                    touch_trigger(
                        &format!("{}_update", part.name),
                        "AFTER UPDATE",
                        part.name,
                        Some(&changed(&part.touch_columns)),
                        mark_stamp(&format!("new.{via}")),
                    );
                    touch_trigger(
                        &format!("{}_delete", part.name),
                        "AFTER DELETE",
                        part.name,
                        None,
                        mark_stamp(&format!("old.{via}")),
                    );
                }
                Role::Entity | Role::Outside(_) => {}
            }
        }
        sql
    }

    /// The tables of the file that are not classified, for the classification test.
    ///
    /// # Errors
    /// A database error.
    pub fn unclassified(connection: &Connection) -> Result<BTreeSet<String>> {
        let mut statement = connection.prepare(
            "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table'
                AND name NOT LIKE 'sqlite_%'",
        )?;
        let names: Vec<String> = statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(names
            .into_iter()
            .filter(|name| {
                !TABLES.iter().any(|(table, _)| table == name) && !crate::log::guard::is_index(name)
            })
            .collect())
    }
}
