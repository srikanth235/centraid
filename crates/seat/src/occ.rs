//! `row_version` optimistic concurrency, and what `actual_version == 0` means.
//!
//! ## Zero means the row is gone
//!
//! `row_version` is `INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)`, so
//! there is no legitimate version zero and the sentinel cannot collide. A
//! conflict reporting `actual_version: 0` is therefore "the row you were
//! editing does not exist", which is a different remedy from "somebody else
//! edited it" — hence [`IntentState::ConflictBaseMissing`] as its own verdict.
//!
//! [`IntentState::ConflictBaseMissing`]: crate::intent::IntentState::ConflictBaseMissing
//!
//! ## Two holes, both inherited and both recorded
//!
//! 1. **ABA across a re-insert.** `row_version` restarts at 1 on every INSERT,
//!    so a base version of 1 captured before a delete passes the check against
//!    a *different* row that happens to also be at 1. v0 considered and
//!    rejected two fixes; this port inherits the hole rather than inventing a
//!    third, because a seat that disagreed with the gateway about what a
//!    conflict is would be worse than the hole.
//! 2. **Coverage.** Fifty-one replicated tables carry no `row_version` at all
//!    — `core_entity`, `conversations`, `turns`, `items`, `access_device`,
//!    `sync_connection`, `share_authority` among them. [`has_row_version`] is
//!    how a caller asks, and [`occ_check`] answers `Unversioned` rather than
//!    pretending: a port that assumed universal `row_version` would silently
//!    lose conflicts on exactly the tables that register names.

use rusqlite::Connection;

use crate::error::Result;

/// One row whose version did not match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub entity: String,
    pub row_id: String,
    pub shape_id: Option<String>,
    pub expected_version: i64,
    /// **ZERO MEANS THE ROW IS GONE.**
    pub actual_version: i64,
}

impl Conflict {
    /// Whether the base row is missing rather than merely moved.
    #[must_use]
    pub const fn base_is_missing(&self) -> bool {
        self.actual_version == 0
    }
}

/// What one version check concluded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OccVerdict {
    /// The version matched.
    Held,
    /// It did not, and here is what the file actually holds.
    Moved(Conflict),
    /// This table has no `row_version` column, so nothing was checked. NOT the
    /// same answer as `Held`, and a caller that conflates them is claiming a
    /// guarantee for the 51 tables the gap register names.
    Unversioned,
}

/// Whether a table carries `row_version`.
pub fn has_row_version(connection: &Connection, table: &str) -> Result<bool> {
    Ok(centraid_vault::log::table_columns(connection, table)?
        .iter()
        .any(|column| column == "row_version"))
}

/// Check one declared base version against the file.
///
/// `pk_column` is the table's single-column key; a composite-key table is not
/// version-referenced by a seat, because a base version names ONE row id.
pub fn occ_check(
    connection: &Connection,
    table: &str,
    pk_column: &str,
    entity: &str,
    row_id: &str,
    shape_id: Option<&str>,
    expected_version: i64,
) -> Result<OccVerdict> {
    if !has_row_version(connection, table)? {
        return Ok(OccVerdict::Unversioned);
    }
    let actual: Option<i64> = connection
        .query_row(
            &format!(
                "SELECT row_version FROM {} WHERE {} = ?1",
                centraid_vault::log::quoted(table),
                centraid_vault::log::quoted(pk_column)
            ),
            [row_id],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    // A missing row is version ZERO on the wire, which is the sentinel and not
    // an absent answer: a seat that received "no version" would not know
    // whether to retry or to tell the member the row is gone.
    let actual_version = actual.unwrap_or(0);
    if actual_version == expected_version {
        return Ok(OccVerdict::Held);
    }
    Ok(OccVerdict::Moved(Conflict {
        entity: entity.to_owned(),
        row_id: row_id.to_owned(),
        shape_id: shape_id.map(str::to_owned),
        expected_version,
        actual_version,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> Connection {
        let connection = Connection::open_in_memory().expect("opens");
        connection
            .execute_batch(
                "CREATE TABLE versioned (id TEXT PRIMARY KEY, row_version INTEGER NOT NULL
                    DEFAULT 1 CHECK (row_version >= 1)) STRICT;
                 CREATE TABLE bare (id TEXT PRIMARY KEY, value TEXT) STRICT;
                 INSERT INTO versioned (id, row_version) VALUES ('r1', 3);
                 INSERT INTO bare (id, value) VALUES ('r1', 'x');",
            )
            .expect("the DDL runs");
        connection
    }

    #[test]
    fn a_matching_version_holds() {
        let connection = scratch();
        assert_eq!(
            occ_check(&connection, "versioned", "id", "note", "r1", None, 3).expect("it checks"),
            OccVerdict::Held
        );
    }

    #[test]
    fn a_moved_version_reports_what_the_file_holds() {
        let connection = scratch();
        let OccVerdict::Moved(conflict) =
            occ_check(&connection, "versioned", "id", "note", "r1", None, 2).expect("it checks")
        else {
            panic!("a version mismatch is a conflict");
        };
        assert_eq!(conflict.expected_version, 2);
        assert_eq!(conflict.actual_version, 3);
        assert!(!conflict.base_is_missing());
    }

    #[test]
    fn a_missing_row_is_version_zero_and_zero_means_gone() {
        let connection = scratch();
        let OccVerdict::Moved(conflict) =
            occ_check(&connection, "versioned", "id", "note", "gone", None, 3).expect("it checks")
        else {
            panic!("a missing base is a conflict");
        };
        assert_eq!(conflict.actual_version, 0);
        assert!(conflict.base_is_missing());
    }

    /// THE GAP REGISTER. `Unversioned` is not `Held`.
    #[test]
    fn a_table_with_no_row_version_answers_unversioned_rather_than_held() {
        let connection = scratch();
        assert!(!has_row_version(&connection, "bare").expect("it reads"));
        assert_eq!(
            occ_check(&connection, "bare", "id", "note", "r1", None, 1).expect("it checks"),
            OccVerdict::Unversioned
        );
        // Even for a row that does not exist: the claim is about the TABLE.
        assert_eq!(
            occ_check(&connection, "bare", "id", "note", "gone", None, 1).expect("it checks"),
            OccVerdict::Unversioned
        );
    }

    #[test]
    fn the_aba_hole_is_reproduced_rather_than_papered_over() {
        let connection = scratch();
        // A base version of 1 captured, the row deleted, a different row
        // re-inserted under the same id. `row_version` restarts at 1.
        connection
            .execute_batch(
                "INSERT INTO versioned (id, row_version) VALUES ('aba', 1);
                 DELETE FROM versioned WHERE id = 'aba';
                 INSERT INTO versioned (id, row_version) VALUES ('aba', 1);",
            )
            .expect("the churn runs");
        assert_eq!(
            occ_check(&connection, "versioned", "id", "note", "aba", None, 1).expect("it checks"),
            OccVerdict::Held,
            "the ABA hole is INHERITED and recorded; a seat that disagreed with the gateway \
             about what a conflict is would be worse than the hole"
        );
    }
}
