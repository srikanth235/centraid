//! Session capture and the decode, the two halves that must not be separated.
//!
//! ## One session per table, and it is mandatory (plane census seam 1)
//!
//! `rusqlite` DOES expose `Session::table_filter`, which `node:sqlite` does not
//! — so v1 *could* open one filtered session. It does not, for two reasons,
//! and the first is enough on its own:
//!
//! 1. **A filter is a promise, and the promise was already broken once.**
//!    `node:sqlite`'s `createSession({filter})` is accepted and silently
//!    ignored on 3.50.2 and 3.51.2: an excluded row still shipped. The failure
//!    mode is a private table's rows reaching every seat, which is the worst
//!    outcome this crate has, and it is invisible until someone reads a log.
//!    A per-table `attach` cannot be silently ignored: a table that was never
//!    attached produces no changes at all, so the failure is "no rows", which
//!    a test sees.
//! 2. **The decode is per table anyway.** A changeset's items carry their table
//!    name, but the column-name cache, the primary key and the read-back
//!    statement are all per table, and one session per table means the decode
//!    can assert that a session emitted only its own table's changes — which is
//!    a real check against the session extension changing under us.
//!
//! Measured cost of the whole set in v0 was about 2 ms per commit.
//!
//! ## The decode happens INSIDE the capturing transaction
//!
//! An insert's or update's image is the row READ BACK by primary key, not the
//! changeset's `newValues`: an UPDATE's record carries only the columns the
//! statement touched, so trusting it as an image writes a partial row. The read
//! must therefore precede any later statement in the same transaction that
//! could move the row, which is why `capture` decodes each session's changeset
//! the moment it takes it.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::Connection;
use rusqlite::fallible_streaming_iterator::FallibleStreamingIterator as _;
use rusqlite::hooks::Action;
use rusqlite::session::{ChangesetItem, Session};

use crate::error::{Result, VaultError};
use crate::value::{RowImage, Value, key_to_json};

/// What a log row says happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogOp {
    Insert,
    Update,
    Delete,
    /// A schema statement. Carried so a seat can follow an additive change
    /// inside one schema epoch; the statement itself rides in `row_json`.
    Ddl,
}

impl LogOp {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Insert => "insert",
            Self::Update => "update",
            Self::Delete => "delete",
            Self::Ddl => "ddl",
        }
    }

    pub fn parse(text: &str) -> Result<Self> {
        match text {
            "insert" => Ok(Self::Insert),
            "update" => Ok(Self::Update),
            "delete" => Ok(Self::Delete),
            "ddl" => Ok(Self::Ddl),
            other => Err(VaultError::Invariant {
                context: format!("`{other}` is not a log op"),
            }),
        }
    }
}

/// One decoded change, ready to become a log row.
#[derive(Debug, Clone)]
pub struct DecodedRow {
    pub table: String,
    pub op: LogOp,
    /// Primary-key values, in the changeset's column order.
    pub key: Vec<Value>,
    /// The full NEW image for insert/update; the full OLD image for delete.
    /// `None` for a `local` row, which carries a position and nothing else.
    pub row: Option<RowImage>,
    /// The OLD values of the columns an UPDATE touched. **`Some(empty)` is a
    /// real answer** — an update that changed only its key columns — and
    /// `None` means "no prior is known", which is the claim that forces a
    /// re-bootstrap. Only an update ever has one.
    pub prior: Option<RowImage>,
    /// The session flagged this change as trigger- or cascade-produced.
    /// Carried, not filtered: a cascaded delete is a real row a seat applies.
    pub indirect: bool,
    /// A gateway-local lane: logged for the doorbell, never served to a seat.
    pub local: bool,
}

/// The open sessions of one commit.
pub struct Capture<'conn> {
    sessions: Vec<(String, Session<'conn>)>,
    /// Column names, keyed on `PRAGMA schema_version`.
    columns: ColumnCache,
}

impl<'conn> Capture<'conn> {
    /// Open one session per table in `tables`.
    pub fn open(connection: &'conn Connection, tables: &[String]) -> Result<Self> {
        let mut sessions = Vec::with_capacity(tables.len());
        for table in tables {
            let mut session = Session::new(connection)?;
            session.attach(Some(table.as_str()))?;
            sessions.push((table.clone(), session));
        }
        Ok(Self {
            sessions,
            columns: ColumnCache::default(),
        })
    }

    /// Add a session for a table planted mid-transaction by DDL.
    ///
    /// ADDITIVELY, never by reopening the set: reopening would throw away every
    /// change already recorded in this transaction.
    pub fn watch(&mut self, connection: &'conn Connection, table: &str) -> Result<()> {
        if self.sessions.iter().any(|(name, _)| name == table) {
            return Ok(());
        }
        let mut session = Session::new(connection)?;
        session.attach(Some(table))?;
        self.sessions.push((table.to_owned(), session));
        Ok(())
    }

    /// Take every session's changeset and decode it, in one pass.
    ///
    /// Returns the decoded rows and the non-local tables this commit touched.
    /// A local lane is not a table this commit "touched" as far as any consumer
    /// is concerned: nothing replicates from it.
    pub fn decode(
        &mut self,
        connection: &Connection,
        local_tables: &HashSet<String>,
    ) -> Result<(Vec<DecodedRow>, Vec<String>)> {
        let mut decoded: Vec<DecodedRow> = Vec::new();
        let mut tables: Vec<String> = Vec::new();
        // The sessions are iterated in the order they were opened, which is
        // the order the table list gave. Deterministic, because the ORACLE
        // fixture compares row order.
        let names: Vec<String> = self.sessions.iter().map(|(name, _)| name.clone()).collect();
        for (index, table) in names.iter().enumerate() {
            let changeset = {
                let (_, session) = &mut self.sessions[index];
                if session.is_empty() {
                    continue;
                }
                session.changeset()?
            };
            let local = local_tables.contains(table);
            let rows = decode_changeset(connection, table, &changeset, local, &mut self.columns)?;
            if rows.is_empty() {
                continue;
            }
            if !local {
                tables.push(table.clone());
            }
            decoded.extend(rows);
        }
        Ok((decoded, tables))
    }

    /// Abandon the sessions without taking their changesets.
    ///
    /// THE ROLLBACK PATH, and it must run BEFORE the ROLLBACK: SQLite's session
    /// extension does not un-record what a full rollback undid, so a session
    /// left open across one would replay the rolled-back changes into the next
    /// commit. (A savepoint rollback IS un-recorded, which is why `ROLLBACK TO`
    /// keeps the pair — see `log::guard`.)
    pub fn abandon(self) {
        drop(self);
    }

    #[must_use]
    pub fn table_count(&self) -> usize {
        self.sessions.len()
    }
}

/// Turn one table's changeset into log rows.
///
/// **One row per (table, key) per commit.** The collapse is the SESSION's, not
/// ours: it groups by table then by key, and intra-commit statement order is
/// not recoverable from the wire. That is not a loss — a log row says "this is
/// what the row is now", and a subscriber applies end state under last-write-
/// wins. The `seen` set below only guards a malformed changeset carrying one
/// key twice.
fn decode_changeset(
    connection: &Connection,
    table: &str,
    changeset: &rusqlite::session::Changeset,
    local: bool,
    columns: &mut ColumnCache,
) -> Result<Vec<DecodedRow>> {
    let mut decoded: Vec<DecodedRow> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut iter = changeset.iter()?;
    while let Some(item) = iter.next()? {
        let operation = item.op()?;
        if operation.table_name() != table {
            // One session per table, so this cannot happen without the session
            // extension having changed under us. Fail rather than mislabel.
            return Err(VaultError::Invariant {
                context: format!(
                    "the session for `{table}` emitted a change for `{}`",
                    operation.table_name()
                ),
            });
        }
        let column_count = usize::try_from(operation.number_of_columns()).unwrap_or(0);
        let op = match operation.code() {
            Action::SQLITE_INSERT => LogOp::Insert,
            Action::SQLITE_UPDATE => LogOp::Update,
            Action::SQLITE_DELETE => LogOp::Delete,
            other => {
                return Err(VaultError::Invariant {
                    context: format!("a changeset carried the action {other:?}"),
                });
            }
        };
        let indirect = operation.indirect();
        let key_flags = item.pk()?.to_vec();

        // A PK-CHANGING UPDATE IS DELETE + INSERT on the wire, including for an
        // INTEGER PRIMARY KEY alias, so the key for an update always comes from
        // the OLD record and there is no case where the two disagree — the
        // whole reason to read it from `old_value` is that an update's NEW
        // record may legally omit the key columns.
        let key = key_values(item, &key_flags, column_count, op)?;
        let identity = key_to_json(&key);
        if !seen.insert(identity.clone()) {
            continue;
        }

        if local {
            // POSITION ONLY. No read-back, no image: the row says that
            // something about this key happened at this position, and
            // everything else about it is device-scoped and resolved at the
            // door.
            decoded.push(DecodedRow {
                table: table.to_owned(),
                op,
                key,
                row: None,
                prior: None,
                indirect,
                local: true,
            });
            continue;
        }

        if op == LogOp::Delete {
            // A DELETE record carries EVERY column of the old row, so this is
            // the one op whose image needs no read — and the one whose row is
            // gone. The image is POSITIONAL, which is why the column cache is
            // keyed on `PRAGMA schema_version`.
            let names = columns.names_of(connection, table)?;
            let mut image = RowImage::new();
            for index in 0..column_count {
                let Some(column) = names.get(index) else {
                    continue;
                };
                // `absent` arrives as an error from the FFI, because the value
                // pointer is null; that is the DISTINCTION, not a failure.
                if let Some(value) = optional_old(item, index)? {
                    image.insert(column.clone(), value);
                }
            }
            // WHAT REPLICATES BUT NOT WHOLE. Both images go through redaction:
            // a DELETE carries the old row verbatim, so skipping this branch
            // would leak on the way out what the INSERT branch withheld.
            crate::log::redact_row_image(table, &mut image);
            decoded.push(DecodedRow {
                table: table.to_owned(),
                op,
                key,
                row: Some(image),
                // A delete's `row_json` IS the state before it, so there is
                // nothing a prior delta could add.
                prior: None,
                indirect,
                local: false,
            });
            continue;
        }

        let Some(mut image) =
            read_back(connection, table, &key_flags, column_count, &key, columns)?
        else {
            return Err(VaultError::DecodeOutsideTransaction {
                table: table.to_owned(),
                key: identity,
            });
        };
        crate::log::redact_row_image(table, &mut image);
        let prior = if op == LogOp::Update {
            Some(prior_delta(item, column_count, connection, table, columns)?)
        } else {
            None
        };
        decoded.push(DecodedRow {
            table: table.to_owned(),
            op,
            key,
            row: Some(image),
            prior,
            indirect,
            local: false,
        });
    }
    Ok(decoded)
}

/// The OLD values of the columns this UPDATE changed (#1014 R-1014-13).
///
/// `absent` is the changeset saying "this statement did not touch the column",
/// and an untouched column has the same value in both images — so the columns
/// left out here are exactly the ones `row_json` already answers for. An empty
/// map is a real answer (an update that changed nothing but its key columns);
/// `null` would mean "no prior is known", a different claim.
fn prior_delta(
    item: &ChangesetItem,
    column_count: usize,
    connection: &Connection,
    table: &str,
    columns: &mut ColumnCache,
) -> Result<RowImage> {
    let names = columns.names_of(connection, table)?;
    let mut prior = RowImage::new();
    for index in 0..column_count {
        let Some(column) = names.get(index) else {
            continue;
        };
        if let Some(value) = optional_old(item, index)? {
            prior.insert(column.clone(), value);
        }
    }
    Ok(prior)
}

/// The primary-key values of one change, in the changeset's COLUMN order.
///
/// Column order, not declared-key order. `pk_json` is compared against v0's
/// bytes by the ORACLE fixture and v0 reads the flags in index order, so this
/// is the faithful reading; the read-back below binds in the same order so the
/// two cannot disagree.
fn key_values(
    item: &ChangesetItem,
    key_flags: &[u8],
    column_count: usize,
    op: LogOp,
) -> Result<Vec<Value>> {
    let mut key = Vec::new();
    for index in 0..column_count {
        if key_flags.get(index).copied().unwrap_or(0) == 0 {
            continue;
        }
        let value = if op == LogOp::Insert {
            optional_new(item, index)?
        } else {
            optional_old(item, index)?
        };
        let Some(value) = value else {
            return Err(VaultError::Invariant {
                context: format!(
                    "a changeset key column at index {index} is absent, which the session extension never emits"
                ),
            });
        };
        key.push(value);
    }
    if key.is_empty() {
        return Err(VaultError::Invariant {
            context: "a change carried no primary-key column; the session extension does not track a table with no PRIMARY KEY and its rows would never replicate".to_owned(),
        });
    }
    Ok(key)
}

/// Read the row back by primary key, for the full image.
fn read_back(
    connection: &Connection,
    table: &str,
    key_flags: &[u8],
    column_count: usize,
    key: &[Value],
    columns: &mut ColumnCache,
) -> Result<Option<RowImage>> {
    let names = columns.names_of(connection, table)?;
    let key_columns: Vec<String> = (0..column_count)
        .filter(|index| key_flags.get(*index).copied().unwrap_or(0) != 0)
        .filter_map(|index| names.get(index).cloned())
        .collect();
    let predicate = key_columns
        .iter()
        .map(|column| format!("{} = ?", quoted(column)))
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!("SELECT * FROM {} WHERE {predicate}", quoted(table));
    let mut statement = connection.prepare_cached(&sql)?;
    let binds: Vec<&dyn rusqlite::ToSql> = key
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect();
    let mut rows = statement.query(binds.as_slice())?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let mut image = RowImage::new();
    for (index, column) in names.iter().enumerate() {
        image.insert(column.clone(), Value::from_ref(row.get_ref(index)?)?);
    }
    Ok(Some(image))
}

/// `new_value`, with an absent column as `None` rather than an error.
fn optional_new(item: &ChangesetItem, index: usize) -> Result<Option<Value>> {
    match item.new_value(index) {
        Ok(value) => Ok(Some(Value::from_ref(value)?)),
        Err(rusqlite::Error::InvalidColumnIndex(_)) => Ok(None),
        Err(error) => Err(VaultError::Sqlite(error)),
    }
}

/// `old_value`, with an absent column as `None`.
///
/// THE DISTINCTION THIS WHOLE MODULE TURNS ON. The FFI signals "this column is
/// not in this record" by handing back a null value pointer, which `rusqlite`
/// reports as `InvalidColumnIndex`. That is `absent`. A column that IS in the
/// record and holds SQL NULL comes back as `Ok(ValueRef::Null)`. Collapsing
/// the two writes NULLs over live data.
fn optional_old(item: &ChangesetItem, index: usize) -> Result<Option<Value>> {
    match item.old_value(index) {
        Ok(value) => Ok(Some(Value::from_ref(value)?)),
        Err(rusqlite::Error::InvalidColumnIndex(_)) => Ok(None),
        Err(error) => Err(VaultError::Sqlite(error)),
    }
}

/// Column names, keyed on `PRAGMA schema_version` (#1014 G15).
///
/// These names are the SOLE source of column order for a DELETE image, which is
/// positional: the changeset gives values by index and nothing else says what
/// they are. v0's cache never invalidated, so after a column drop every delete
/// row for that table carried its values under the wrong keys — and a seat
/// applied it. SQLite's own counter is bumped by every table, index and trigger
/// change, including one an ext band installs mid-session, so it is the only
/// notion of "the schema moved" that cannot disagree with the schema.
#[derive(Default)]
pub struct ColumnCache {
    schema_version: Option<i64>,
    names: HashMap<String, Vec<String>>,
}

impl ColumnCache {
    pub fn names_of(&mut self, connection: &Connection, table: &str) -> Result<&Vec<String>> {
        let current: i64 = connection.query_row("PRAGMA schema_version", [], |row| row.get(0))?;
        if self.schema_version != Some(current) {
            self.schema_version = Some(current);
            self.names.clear();
        }
        if !self.names.contains_key(table) {
            let names = table_columns(connection, table)?;
            self.names.insert(table.to_owned(), names);
        }
        Ok(self
            .names
            .get(table)
            .expect("just inserted if it was missing"))
    }
}

/// Every column of a table, in declaration order.
pub fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>> {
    let sql = format!("PRAGMA table_info({})", quoted(table));
    let mut statement = connection.prepare(&sql)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if names.is_empty() {
        return Err(VaultError::Invariant {
            context: format!("`{table}` has no columns; it does not exist in this file"),
        });
    }
    Ok(names)
}

/// The declared primary key of a table, in key order.
pub fn primary_key_of(connection: &Connection, table: &str) -> Result<Vec<String>> {
    let sql = format!("PRAGMA table_info({})", quoted(table));
    let mut statement = connection.prepare(&sql)?;
    let mut key: Vec<(i64, String)> = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(position, _)| *position > 0)
        .collect();
    key.sort_by_key(|(position, _)| *position);
    if key.is_empty() {
        return Err(VaultError::Invariant {
            context: format!(
                "`{table}` declares no PRIMARY KEY; the session extension does not track it and its rows would never replicate"
            ),
        });
    }
    Ok(key.into_iter().map(|(_, name)| name).collect())
}

/// A quoted SQL identifier.
///
/// Double quotes with doubling, which is SQLite's own escape. Every identifier
/// this crate interpolates comes from `sqlite_master` or a `PRAGMA`, so it is
/// already a name SQLite accepted — the quoting is against a column called
/// `table` or `order`, not against injection.
#[must_use]
pub fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The tables this commit's sessions cover: the file's tables ∩ the replicated
/// allow-list, plus the local lanes.
///
/// Cached by the caller on `PRAGMA schema_version` for the same reason the
/// column names are — an ext band can plant a table mid-transaction.
pub fn capture_tables(connection: &Connection, local_tables: &[String]) -> Result<Vec<String>> {
    let mut statement = connection.prepare(
        r"SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
            ORDER BY name",
    )?;
    let present: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut tables: BTreeMap<String, ()> = BTreeMap::new();
    for name in present {
        if centraid_ontology::registries::is_replicated_table(&name) || local_tables.contains(&name)
        {
            tables.insert(name, ());
        }
    }
    Ok(tables.into_keys().collect())
}
