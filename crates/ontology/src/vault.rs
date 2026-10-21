//! Opening a vault file, and the facts the core reads before anything else.
//!
//! `open` does two things and no more: turn foreign keys on and read the
//! journal mode. Whether the file is one this build can climb to is
//! `crates/vault`'s, which owns the ladder and `application_id`.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::{OntologyError, Result};

/// The ontology CONTRACT version: a property of the file and of a command
/// contract, never a per-row stamp.
pub const ONTOLOGY_VERSION: &str = "1.0";

pub struct Vault {
    connection: Connection,
    path: PathBuf,
    user_version: i64,
    journal_mode: String,
}

impl Vault {
    /// Open a vault file, refusing a shape this build does not understand.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Err(OntologyError::Missing { path });
        }
        let connection = Connection::open(&path)?;
        // Foreign keys are per-connection in SQLite and OFF by default, so a
        // core that forgot this line would enforce none of the model's keys.
        connection.pragma_update(None, "foreign_keys", "ON")?;

        let journal_mode: String =
            connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        let user_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;

        Ok(Self {
            connection,
            path,
            user_version,
            journal_mode,
        })
    }

    #[must_use]
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub const fn user_version(&self) -> i64 {
        self.user_version
    }

    #[must_use]
    pub fn journal_mode(&self) -> &str {
        &self.journal_mode
    }

    /// Every schema object the file carries, as `sqlite_master` rows with a
    /// non-null `sql`, ordered by `type` then `name`.
    ///
    /// `sqlite_stat*` is excluded for the reason v0's `golden-vault.test.ts`
    /// gives: it is the planner's own statistics over the corpus rows, so its
    /// presence says how much data a file has and nothing about its shape.
    pub fn schema_objects(&self) -> Result<Vec<SchemaObject>> {
        schema_objects_of(&self.connection)
    }
}

/// One row of `sqlite_master` that carries DDL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaObject {
    pub kind: String,
    pub name: String,
    pub table: String,
    pub sql: String,
}

/// The same read, over a bare connection.
///
/// A v1 file is not openable through [`Vault`] — its `user_version` is on v1's
/// own axis and this crate's window is v0's (D-1020-D1-2) — and rendering the
/// schema of a file this build FOUNDED is exactly what
/// `centraid_vault::migrations::render_ladder_ddl` has to do. So the query
/// lives here, in the crate that owns what a schema object is, and both callers
/// share it rather than each keeping a copy that could disagree.
pub fn schema_objects_of(connection: &rusqlite::Connection) -> Result<Vec<SchemaObject>> {
    let mut statement = connection.prepare(
        r"SELECT type, name, tbl_name, sql FROM sqlite_master
            WHERE sql IS NOT NULL
              AND name NOT LIKE 'sqlite\_stat%' ESCAPE '\'
            ORDER BY type, name",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(SchemaObject {
                kind: row.get(0)?,
                name: row.get(1)?,
                table: row.get(2)?,
                sql: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
