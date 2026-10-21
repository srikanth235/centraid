//! THE TEST DOOR over a vault's own tables — questions a test asks about a
//! copy of a vault, in the crate that owns the schema (#1025 S5).
//!
//! ## Why it exists
//!
//! `sql-confinement` (`cargo xtask rules`) refuses SQL outside
//! `crates/{ontology,vault,seat,search}` and `crates/apps/kit`, and the refusal
//! is the point: a query written somewhere else is a crate reaching past its
//! layer, and a test is not an exemption — a test that hand-writes
//! `SELECT … FROM entity` is a second, unversioned opinion about a schema
//! this crate owns, and it goes stale the first time a column moves.
//!
//! S1–S4 built the seat's end-to-end tests with the statements inline and the
//! rule went red. These are those questions, moved here and **named for the
//! question rather than for the SQL**, so the call site reads as the assertion
//! it is: `assert_eq!(vault_rows(connection), 1)` says what
//! `query_row("SELECT COUNT(*) FROM vault", …)` only implied.
//!
//! ## Why a plain `pub mod` and not a cargo feature
//!
//! `crates/apps/kit/src/testdoor.rs` is the precedent and it is an ungated
//! `pub mod`. A feature would not do what it looks like it does here: cargo
//! unifies features across a package's normal and dev dependencies in one
//! build, so a `testdoor` feature switched on by `crates/centraid`'s
//! dev-dependency would be switched on for its ordinary dependency too — the
//! module would be in the shipped binary anyway and the gate would be
//! decoration. What keeps this out of the product is that nothing in the
//! product calls it, which is a fact `cargo xtask` can check and a feature flag
//! cannot.
//!
//! ## What it is not
//!
//! It applies no access decision, resolves no entity and compiles no row
//! filter: it is the OWNER'S view of a file, which is what a test comparing two
//! copies of a vault wants. A door that decides what a caller may see is
//! `crate::page`'s.

use rusqlite::Connection;

/// How many `vault` rows a file holds: one once it is founded.
///
/// A file with no such table answers **0** rather than failing: "this is not a
/// vault" and "this vault is not founded" are the same answer to this question,
/// and a test asserting `== 1` refuses both.
#[must_use]
pub fn vault_rows(connection: &Connection) -> i64 {
    connection
        .query_row("SELECT COUNT(*) FROM vault", [], |row| row.get(0))
        .unwrap_or(0)
}

/// Every person, as `(id, name)`, in name order.
#[must_use]
pub fn people(connection: &Connection) -> Vec<(String, String)> {
    pairs(
        connection,
        "SELECT id, title FROM entity WHERE kind = 'person' ORDER BY title, id",
    )
}

/// How many people carry this name.
#[must_use]
pub fn people_named(connection: &Connection, name: &str) -> i64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM entity WHERE kind = 'person' AND title = ?1",
            [name],
            |row| row.get(0),
        )
        .unwrap_or(0)
}

/// Every note's title, in title order.
#[must_use]
pub fn note_titles(connection: &Connection) -> Vec<String> {
    pairs(
        connection,
        "SELECT title, id FROM entity WHERE kind = 'note' ORDER BY title, id",
    )
    .into_iter()
    .map(|(title, _)| title)
    .collect()
}

/// The calendar a founded vault starts with, as `(id, name)`.
#[must_use]
pub fn the_founded_calendar(connection: &Connection) -> Option<(String, String)> {
    pairs(
        connection,
        "SELECT id, title FROM entity WHERE kind = 'calendar' ORDER BY n LIMIT 1",
    )
    .into_iter()
    .next()
}

/// The variant of every derivative a file holds, in variant order.
#[must_use]
pub fn derivative_variants(connection: &Connection) -> Vec<String> {
    pairs(
        connection,
        "SELECT variant, blob FROM derivative ORDER BY variant, blob",
    )
    .into_iter()
    .map(|(variant, _)| variant)
    .collect()
}

/// Forget every derivative a file holds, so a sweep has something to do.
/// Returns how many it forgot.
#[must_use]
pub fn forget_derivatives(connection: &Connection) -> usize {
    connection
        .execute("DELETE FROM derivative", [])
        .unwrap_or(0)
}

fn pairs(connection: &Connection, sql: &str) -> Vec<(String, String)> {
    let Ok(mut statement) = connection.prepare(sql) else {
        return Vec::new();
    };
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map(|rows| rows.filter_map(std::result::Result::ok).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Vault;

    #[test]
    fn a_founded_vault_answers_the_questions_a_test_asks() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = Vault::create(dir.path().join("vault.db")).expect("a vault");
        assert_eq!(
            vault
                .read(|connection| Ok(vault_rows(connection)))
                .expect("reads"),
            0
        );
        vault.found("Household", "Ada").expect("founds");
        vault
            .read(|connection| {
                assert_eq!(vault_rows(connection), 1);
                assert_eq!(people(connection).len(), 1);
                assert_eq!(people_named(connection, "Ada"), 1);
                assert_eq!(
                    the_founded_calendar(connection).map(|(_, name)| name),
                    Some("Calendar".to_owned())
                );
                assert!(note_titles(connection).is_empty());
                assert!(derivative_variants(connection).is_empty());
                Ok(())
            })
            .expect("reads");
    }
}
