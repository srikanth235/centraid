//! Opening a vault file, and the two facts the core reads before anything else.
//!
//! `open` does three things and no more: turn foreign keys on, read the journal
//! mode, and compare `PRAGMA user_version` with what this build understands.
//! There are no migrations here — a file behind the expected version is
//! refused, not advanced, until `crates/vault` grows the forward-only ladder
//! ([#1020](https://github.com/srikanth235/centraid/issues/1020)).

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::{OntologyError, Result};

/// The ontology CONTRACT version — a property of the file and of a command
/// contract, never a per-row stamp (v0 `schema/migrate.ts`, ruling ONT-04).
pub const ONTOLOGY_VERSION: &str = "1.0";

/// The LOW end of the `PRAGMA user_version` window this build accepts: what the
/// #929 golden corpus was frozen at.
///
/// THE EXPECTED VERSION IS A CONTRACT, NOT A CONSTANT (#1020, D-1020-A1). It
/// was briefly a hard-coded `7`, which quietly made v1 understand only the
/// checkpoint fixture: v0's ladder has climbed to 11 since the freeze, so a
/// vault founded by v0's own code would have been refused as a downgrade. The
/// two ends of the window are now exported from the v0 tree into
/// `contracts/schema/v0-registries.json` and embedded, so the window moves when
/// v0's ladder moves and no Rust constant has to be remembered.
#[must_use]
pub fn expected_user_version() -> i64 {
    crate::registries::v0_registries().user_version
}

/// The HIGH end of the window: what a freshly founded v0 vault reaches today,
/// the length of v0's migration ladder.
#[must_use]
pub fn ladder_user_version() -> i64 {
    crate::registries::v0_registries().ladder_user_version
}

/// An open vault file and the two facts read at open time.
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

        // The window, not a point. A file anywhere between the frozen corpus
        // and v0's current ladder head is a shape this build reads; above the
        // head it is a file a newer build wrote and the core never guesses,
        // below the corpus it needs a forward migration this crate does not
        // have yet.
        if user_version > ladder_user_version() {
            return Err(OntologyError::DowngradeRefused {
                path,
                found: user_version,
                expected: ladder_user_version(),
            });
        }
        if user_version < expected_user_version() {
            return Err(OntologyError::UpgradeRequired {
                path,
                found: user_version,
                expected: expected_user_version(),
            });
        }

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
        let mut statement = self.connection.prepare(
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

    /// Every base table the file carries, FTS shadow tables and SQLite's own
    /// internal tables excluded.
    pub fn base_tables(&self) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare(
            r"SELECT name FROM sqlite_master
                WHERE type = 'table'
                  AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
                  AND name NOT LIKE 'fts\_%' ESCAPE '\'
                ORDER BY name",
        )?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
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
