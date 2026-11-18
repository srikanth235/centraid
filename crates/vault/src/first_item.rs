//! THE MEMBER'S FIRST ITEM: the earliest `created_at` of a row they made or imported.
//!
//! One bounded read per kind of [`Kind::MEMBER_ITEMS`] (the one definition of what a member can add),
//! a `MIN` over the `entity_by_created` index; nothing is counted. The starter notes are not the
//! member's, nor are the two starter tasks older vaults were founded with, and nor are the founding
//! person and the default Calendar (the vault's first of each). Every query is fixed text with bound parameters.

use rusqlite::Connection;

use crate::file::Vault;
use crate::model::Kind;

/// A kind's earliest row.
const EARLIEST: &str = "SELECT MIN(created_at) FROM entity WHERE kind = ?1";
/// A kind's earliest row whose title is not one of the starter titles (`?2`, a JSON array).
const EARLIEST_UNMARKED: &str = "SELECT MIN(created_at) FROM entity WHERE kind = ?1 \
     AND title NOT IN (SELECT value FROM json_each(?2))";
/// The earliest row of a kind (`?1`) that is not the vault's first of that kind: the founding person,
/// and the default Calendar the vault is founded with.
const EARLIEST_AFTER_FIRST: &str = "SELECT MIN(created_at) FROM entity WHERE kind = ?1 AND id NOT IN \
     (SELECT id FROM entity WHERE kind = ?1 ORDER BY created_at, n LIMIT 1)";

/// The earliest `created_at` (an ISO string) of anything the member made or imported, or `None`
/// for a vault that holds nothing of theirs. `starter_titles` are the starter notes' and the retired
/// starter tasks' titles, which do not count.
///
/// A READ THAT FAILS IS LOGGED AND READ AS NONE: this answers a status line and a prompt that waits
/// for a first item, and failing the whole status page over it would cost more than a prompt that
/// comes one read later.
#[must_use]
pub fn first_item_at(vault: &Vault, starter_titles: &[&str]) -> Option<String> {
    let starters = serde_json::to_string(starter_titles).ok()?;
    match vault.read(|connection| earliest(connection, &starters)) {
        Ok(at) => at,
        Err(error) => {
            tracing::warn!(%error, "the member's first item could not be read");
            None
        }
    }
}

fn earliest(connection: &Connection, starters: &str) -> crate::Result<Option<String>> {
    let mut first: Option<String> = None;
    for kind in Kind::MEMBER_ITEMS {
        let at: Option<String> = match kind {
            Kind::Person | Kind::Calendar => {
                connection.query_row(EARLIEST_AFTER_FIRST, [kind.as_str()], |row| row.get(0))?
            }
            // A starter's title is a starter's, whatever its kind: the notes, and the tasks older vaults hold.
            Kind::Note | Kind::Task => {
                connection.query_row(EARLIEST_UNMARKED, (kind.as_str(), starters), |row| {
                    row.get(0)
                })?
            }
            other => connection.query_row(EARLIEST, [other.as_str()], |row| row.get(0))?,
        };
        if let Some(at) = at
            && first.as_ref().is_none_or(|best| at < *best)
        {
            first = Some(at);
        }
    }
    Ok(first)
}
