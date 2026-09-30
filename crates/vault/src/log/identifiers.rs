//! Reading a table's shape out of the file it is in.
//!
//! Three helpers over `PRAGMA table_info` and one quoting rule. They lived in
//! `log/capture.rs`, beside the session-extension capture that is deleted with
//! the replica log plane ([#1029](https://github.com/srikanth235/centraid/issues/1029)
//! §1), and they are not part of that plane at all: every SQL-building caller
//! in this workspace quotes with [`quoted`], the page door asks
//! [`primary_key_of`] which columns a cursor is over, and a migration asks
//! [`table_columns`] what a table now holds.
//!
//! They read the FILE and never a registry. A table's declared shape is a fact
//! about the database in hand — an ext band can plant one mid-transaction —
//! and a second copy in Rust would be a second thing to keep true.

use rusqlite::Connection;

use crate::error::{Result, VaultError};

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
                "`{table}` declares no PRIMARY KEY; a row of it could never be addressed"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_identifier_is_quoted_with_sqlites_own_escape() {
        assert_eq!(quoted("order"), "\"order\"");
        assert_eq!(quoted("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn a_table_with_no_primary_key_is_an_invariant_and_not_an_empty_answer() {
        let connection = Connection::open_in_memory().expect("in memory");
        connection
            .execute_batch(
                "CREATE TABLE keyed (a TEXT PRIMARY KEY, b TEXT); CREATE TABLE loose (a TEXT)",
            )
            .expect("two tables");
        assert_eq!(
            primary_key_of(&connection, "keyed").expect("a key"),
            vec!["a".to_owned()]
        );
        assert!(primary_key_of(&connection, "loose").is_err());
        assert_eq!(
            table_columns(&connection, "keyed").expect("columns"),
            vec!["a".to_owned(), "b".to_owned()]
        );
        assert!(table_columns(&connection, "absent").is_err());
    }
}
