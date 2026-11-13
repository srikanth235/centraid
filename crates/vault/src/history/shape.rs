//! What an entity's state is: the classification of every table, and the SQL derived from it.
//!
//! [`TABLES`] is the one place that says which tables make up an entity's state; [`OMITTED`] the
//! one place that says which columns of those tables are not kept, each with its reason. Every
//! other column is kept automatically, read from the file's own `table_xinfo`. A test fails when
//! a table the baseline makes, or a kind the model names, is not classified here.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use rusqlite::Connection;

use super::{SEEN, STATE_VIEW};
use crate::error::Result;
use crate::model::Kind;

/// The `host` of a child that hangs from every kind's row (a tag, a flag, a link).
pub const EVERY_KIND: &str = "*";

/// What a table is to the history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The entity row: only its `title` is a member's state.
    Entity,
    /// A kind's own row, keyed by the entity's id (`concept` and `container` host several kinds).
    Host,
    /// Rows that belong to one entity, a part of its state: `via` is the column that holds the
    /// entity's id, `host` the kind row they hang from, `filter` a predicate (over the child's own
    /// columns) saying which of its rows are state at all.
    Child {
        host: &'static str,
        via: &'static str,
        filter: Option<&'static str>,
        /// The name the rows go by in a state (the table's, unless one table holds several
        /// kinds of child, as `edge` does).
        alias: &'static str,
        /// The columns that name one row among the entity's, when the table's primary key does
        /// not (a table with none). Empty: the primary key, less `via`.
        key: &'static [&'static str],
    },
    /// Not an entity's state, with the reason.
    Outside(&'static str),
}

/// Every table of the vault, classified. A table not named here fails
/// `every_table_is_classified`.
pub const TABLES: &[(&str, Role)] = &[
    ("entity", Role::Entity),
    // The kind rows.
    ("person", Role::Host),
    ("place", Role::Host),
    ("event", Role::Host),
    ("task", Role::Host),
    ("activity", Role::Host),
    ("note", Role::Host),
    ("document", Role::Host),
    ("photo", Role::Host),
    ("account", Role::Host),
    ("txn", Role::Host),
    ("thread", Role::Host),
    ("concept", Role::Host),
    ("container", Role::Host),
    ("locker_item", Role::Host),
    // Rows that hang off a kind row.
    (
        "contact_point",
        Role::Child {
            host: "person",
            via: "person_id",
            filter: None,
            alias: "contact_point",
            key: &[],
        },
    ),
    (
        "occurrence",
        Role::Child {
            host: "event",
            via: "series_id",
            filter: None,
            alias: "occurrence",
            key: &[],
        },
    ),
    (
        "workout",
        Role::Child {
            host: "activity",
            via: "id",
            filter: None,
            alias: "workout",
            key: &[],
        },
    ),
    (
        "budget",
        Role::Child {
            host: "concept",
            via: "category_id",
            filter: None,
            alias: "budget",
            key: &[],
        },
    ),
    (
        "rule",
        Role::Child {
            host: "concept",
            via: "category_id",
            filter: None,
            alias: "rule",
            key: &[],
        },
    ),
    (
        "locker_item_address",
        Role::Child {
            host: "locker_item",
            via: "item_id",
            filter: None,
            alias: "locker_item_address",
            key: &[],
        },
    ),
    (
        "locker_item_alias",
        Role::Child {
            host: "locker_item",
            via: "item_id",
            filter: None,
            alias: "locker_item_alias",
            key: &[],
        },
    ),
    // A guest is part of the event: the person and their answer.
    (
        "edge",
        Role::Child {
            host: "event",
            via: "from_id",
            filter: Some("rel = 'attendee'"),
            alias: "attendee",
            key: &["to_id"],
        },
    ),
    // WHAT DECORATES A RECORD IS PART OF ITS STATE (#1185): its tags and flags, the list or album
    // it is in, and the links a member made by hand. They are `edge` rows of every kind (`host`
    // `*`), each named by the alias it goes by in a state, so a change to one is an earlier
    // version like a change to a field, and a restore puts it back.
    (
        "edge",
        Role::Child {
            host: "*",
            via: "from_id",
            filter: Some("rel = 'tagged' AND to_id LIKE 'tag:%'"),
            alias: "tag",
            key: &["to_id"],
        },
    ),
    // A star, a pin and an archive: the seeded flag entities.
    (
        "edge",
        Role::Child {
            host: "*",
            via: "from_id",
            filter: Some("rel = 'tagged' AND to_id LIKE 'flag:%'"),
            alias: "flag",
            key: &["to_id"],
        },
    ),
    // A list or an album holds the record: the membership is the RECORD's (the entity is the
    // edge's `to_id`), never the container's, which holds thousands.
    (
        "edge",
        Role::Child {
            host: "*",
            via: "to_id",
            filter: Some("rel = 'contains'"),
            alias: "membership",
            key: &["from_id"],
        },
    ),
    // A link set by hand, from either end. A link compiled from a note's words carries an anchor
    // and is not state: the words are, and a restore recompiles it.
    (
        "edge",
        Role::Child {
            host: "*",
            via: "from_id",
            filter: Some("rel = 'links' AND wikilink IS NULL AND anchor IS NULL"),
            alias: "link_out",
            key: &["to_id"],
        },
    ),
    // A link a Locker item started is Locker's alone and never named in another record's history
    // (owner ruling D11).
    (
        "edge",
        Role::Child {
            host: "*",
            via: "to_id",
            filter: Some(
                "rel = 'links' AND wikilink IS NULL AND anchor IS NULL AND NOT EXISTS \
                 (SELECT 1 FROM entity f WHERE f.id = from_id AND f.kind = 'locker_item')",
            ),
            alias: "link_in",
            key: &["from_id"],
        },
    ),
    // What a note, a task or an event is about, and who a photograph shows.
    (
        "edge",
        Role::Child {
            host: "*",
            via: "from_id",
            filter: Some("rel = 'about' AND anchor IS NULL"),
            alias: "about",
            key: &["to_id"],
        },
    ),
    (
        "edge",
        Role::Child {
            host: "*",
            via: "from_id",
            filter: Some("rel = 'depicts'"),
            alias: "depicts",
            key: &["to_id"],
        },
    ),
    // The two halves of a transfer are each other's state: a line's pair is a row of `transfer`
    // whichever side it is on, so a change to the pair is an earlier version of both lines.
    (
        "transfer",
        Role::Child {
            host: "txn",
            via: "a",
            filter: None,
            alias: "transfer_low",
            key: &["b"],
        },
    ),
    (
        "transfer",
        Role::Child {
            host: "txn",
            via: "b",
            filter: None,
            alias: "transfer_high",
            key: &["a"],
        },
    ),
    // A custom field's sealed value (a `sealed` or `otp` kind) is kept like any other column, as
    // the ciphertext it is: sealed under the same key and bound to the same field id, so a restore
    // puts back a value the live reveal opens.
    (
        "locker_item_field",
        Role::Child {
            host: "locker_item",
            via: "item_id",
            filter: None,
            alias: "locker_item_field",
            key: &[],
        },
    ),
    // A passkey is part of the item: its relying party, names and algorithm, and its private key as
    // the ciphertext it is, so removing or replacing one is taken back like any other change. The
    // key is masked on read and never revealed, as it never is live.
    (
        "locker_item_passkey",
        Role::Child {
            host: "locker_item",
            via: "item_id",
            filter: None,
            alias: "locker_item_passkey",
            key: &[],
        },
    ),
    // Not an entity's state.
    (
        "vault",
        Role::Outside("the vault's own row and write counter"),
    ),
    (
        "edge_shape",
        Role::Outside("the model's own rules, founded with the file"),
    ),
    (
        "blob",
        Role::Outside("bytes, by hash; a version names one and copies none"),
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
    ("action_key", Role::Outside("the keys of acts already run")),
    (
        "measurement",
        Role::Outside("a reading of a day, not an edit; a series of its own"),
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
    ("search_word", Role::Outside("the search index")),
    ("search_owed", Role::Outside("the search index")),
    (
        "alert",
        Role::Outside("derived from the event or task it belongs to"),
    ),
];

/// The relations (`edge.rel`) that are not part of an entity's state, with the reason. Every
/// relation the baseline allows is either here or a [`Role::Child`] of `edge`; a test fails on one
/// that is neither.
pub const RELATIONS_OUTSIDE: &[(&str, &str)] = &[
    (
        "attached",
        "an attachment is a record of its own, with its own verbs (attach, detach) and its own Undo",
    ),
    (
        "with",
        "a Locker item's link; never state, and hidden from every door but Locker's",
    ),
    (
        "related",
        "a relationship between two people, with its own verbs",
    ),
];

/// The columns of the tables above that are not kept, with the reason. Everything else is.
///
/// A host's `id` and a child's `via` column are the entity's id and are never state; they are
/// not listed.
pub const OMITTED: &[(&str, &str, &str)] = &[
    ("entity", "n", "row order"),
    ("entity", "id", "identity"),
    ("entity", "kind", "identity"),
    ("entity", "created_at", "stamp, never edited"),
    ("entity", "updated_at", "stamp; every commit moves it"),
    (
        "edge",
        "position",
        "the order of a list or album is the container's: reordering is not a change to a record, and a restore puts a member back unordered",
    ),
    (
        "entity",
        "deleted_at",
        "trash is not state: a trashed record is the same record",
    ),
    ("entity", "purge_at", "trash is not state"),
    ("concept", "kind", "identity: the entity's kind"),
    ("container", "kind", "identity: the entity's kind"),
    // The file a photograph is does not change; an edit makes another photograph.
    ("photo", "blob", "immutable: the file"),
    ("photo", "media_type", "immutable: the file"),
    ("photo", "form", "immutable: the file"),
    ("photo", "width", "immutable: the file"),
    ("photo", "height", "immutable: the file"),
    ("photo", "duration_s", "immutable: the file"),
    ("photo", "exif", "immutable: the file"),
    ("photo", "burst", "immutable: the camera's"),
    ("photo", "edited_from", "immutable: how it was made"),
    // A statement line's own words are the bank's; only what the member sets is state.
    ("txn", "account_id", "bank-stated, never edited"),
    ("txn", "currency", "bank-stated, never edited"),
    ("txn", "posted_on", "bank-stated, never edited"),
    ("txn", "amount_minor", "bank-stated, never edited"),
    // Locker: the five sealed cells, the stamp of the last change to one and the key generation
    // they were sealed under are all kept (the ciphertext, never a plaintext), so a changed
    // password comes back with its age. What is only a use of the item is not.
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

/// Whether `table.column` holds ciphertext under the Locker key (`lk1:`): kept in a state exactly
/// as sealed, and shown nowhere but masked ([`crate::history::MASK`]). One list with the custody
/// module's, so a sealed column added there is masked here without a second edit.
#[must_use]
pub fn is_sealed(table: &str, column: &str) -> bool {
    crate::custody::locker_key::LOCKER_ENCRYPTED_COLUMNS
        .iter()
        .any(|(name, _, columns)| *name == table && columns.contains(&column))
}

/// The values kept in a cell of their own on `revision`, not inline in `state`.
pub const CONTENT: &[(&str, &str, Cell)] = &[
    ("note", "body", Cell::Body),
    ("document", "blob", Cell::Blob),
    ("document", "media_type", Cell::MediaType),
];

/// A content cell of `revision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cell {
    Body,
    Blob,
    MediaType,
}

impl Cell {
    pub(super) const fn index(self) -> usize {
        match self {
            Self::Body => 0,
            Self::Blob => 1,
            Self::MediaType => 2,
        }
    }
}

/// One table of the state, as the file has it.
#[derive(Debug, Clone)]
pub struct Part {
    /// The table.
    pub name: &'static str,
    /// What its rows are called in a state.
    pub alias: &'static str,
    pub role: Role,
    /// The columns kept, in table order.
    pub columns: Vec<String>,
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

    /// The predicate saying which of the table's rows are state, when not all.
    #[must_use]
    pub const fn filter(&self) -> Option<&'static str> {
        match self.role {
            Role::Child { filter, .. } => filter,
            _ => None,
        }
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
            let (via, alias, key_override) = match role {
                Role::Child {
                    via, alias, key, ..
                } => (*via, *alias, *key),
                _ => ("id", *name, &[][..]),
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
            let mut keyed: Vec<&&(String, i64, i64)> = live
                .iter()
                .filter(|row| row.1 > 0 && row.0 != via)
                .collect();
            keyed.sort_by_key(|row| row.1);
            let key = if key_override.is_empty() {
                keyed.into_iter().map(|row| row.0.clone()).collect()
            } else {
                key_override
                    .iter()
                    .map(|column| (*column).to_owned())
                    .collect()
            };
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
                alias,
                role: *role,
                columns,
                key,
                references,
            });
        }
        Ok(Self { parts })
    }

    /// The part for a table.
    #[must_use]
    pub fn part(&self, alias: &str) -> Option<&Part> {
        self.parts.iter().find(|part| part.alias == alias)
    }

    /// The children that hang from a kind row.
    pub fn children_of<'a>(&'a self, host: &'a str) -> impl Iterator<Item = &'a Part> {
        self.parts
            .iter()
            .filter(move |part| matches!(part.role, Role::Child { host: of, .. } if of == host || of == EVERY_KIND))
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
                "'entity', json_object('title', e.title)".to_owned(),
                format!(
                    "'{host_name}', json((SELECT {obj} FROM {table} t WHERE t.id = e.id))",
                    host_name = host.name,
                    obj = Self::object(host, "t"),
                    table = quoted(host.name),
                ),
            ];
            for child in self.children_of(host.name) {
                let Role::Child { via, filter, .. } = child.role else {
                    continue;
                };
                let scope = filter.map_or_else(String::new, |filter| format!(" AND ({filter})"));
                let rows = if child.is_one() {
                    format!(
                        "(SELECT {obj} FROM {table} c WHERE c.{via} = e.id{scope})",
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
                           WHERE c.{via} = e.id{scope})",
                        obj = Self::object(child, "c"),
                        order = order.join(", "),
                        table = quoted(child.name),
                        via = quoted(via),
                    )
                };
                members.push(format!("'{}', json({rows})", child.alias));
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
        // change. A table that holds other things than state (`edge`) wakes it only for a row
        // that is state: the filter reads the row through a one-row subquery of `old` or `new`.
        let seen = |id: &str, part: Option<(&Part, &str)>, extra: &str| {
            let (from, scope) = match part {
                Some((part, row)) if part.filter().is_some() => {
                    let columns: Vec<String> = std::iter::once(part.via().to_owned())
                        .chain(part.columns.iter().cloned())
                        .map(|column| format!("{row}.{0} AS {0}", quoted(&column)))
                        .collect();
                    (
                        format!(" FROM (SELECT {}) AS r", columns.join(", ")),
                        format!("({}) AND ", part.filter().unwrap_or("1")),
                    )
                }
                _ => (String::new(), String::new()),
            };
            format!(
                "INSERT INTO temp.{SEEN} (entity_id, state)
                   SELECT {id}, (SELECT state FROM temp.{STATE_VIEW} WHERE entity_id = {id}){from}
                    WHERE {scope}{extra}NOT EXISTS (SELECT 1 FROM temp.{SEEN} WHERE entity_id = {id});"
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
            "BEFORE UPDATE OF title",
            "entity",
            seen("old.id", None, ""),
        );
        for part in &self.parts {
            let via = quoted(part.via());
            let alias = part.alias;
            // An edge that goes because its OTHER end is being deleted (a tag or a list purged)
            // is not a change to the record that carried it: the end is marked as it is deleted
            // (`entity_gone`), before the cascade reaches the edge.
            let far = if part.name == "edge" {
                let other = if part.via() == "from_id" {
                    "to_id"
                } else {
                    "from_id"
                };
                format!(
                    "NOT EXISTS (SELECT 1 FROM temp.{SEEN} gone
                                  WHERE gone.entity_id = old.{other} AND gone.state IS NULL) AND "
                )
            } else {
                String::new()
            };
            trigger(
                &format!("{alias}_update"),
                "BEFORE UPDATE",
                part.name,
                seen(&format!("old.{via}"), Some((part, "old")), ""),
            );
            trigger(
                &format!("{alias}_delete"),
                "BEFORE DELETE",
                part.name,
                seen(&format!("old.{via}"), Some((part, "old")), &far),
            );
            if matches!(part.role, Role::Child { .. }) {
                trigger(
                    &format!("{alias}_insert"),
                    "BEFORE INSERT",
                    part.name,
                    seen(&format!("new.{via}"), Some((part, "new")), ""),
                );
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
