//! THE MEMBER'S FIRST ITEM: the earliest `created_at` of a row they made or imported.
//!
//! One bounded read, a `MIN` per kind over the `entity_by_created` index (nothing is scanned or
//! counted). The starter notes are not the member's, and nor is the founding person (the vault's
//! first).

use crate::file::Vault;

/// The earliest `created_at` (an ISO string) of anything the member made or imported, or `None`
/// for a vault that holds nothing of theirs. `starter_titles` are the untouched starter notes'
/// titles, which do not count.
#[must_use]
pub fn first_item_at(vault: &Vault, starter_titles: &[&str]) -> Option<String> {
    // Consts of ours, quoted for SQL all the same.
    let marks = starter_titles
        .iter()
        .map(|title| format!("'{}'", title.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let kinds = [
        "event",
        "task",
        "document",
        "photo",
        "account",
        "txn",
        "locker_item",
    ];
    let mut parts: Vec<String> = kinds
        .iter()
        .map(|kind| format!("SELECT MIN(created_at) AS at FROM entity WHERE kind = '{kind}'"))
        .collect();
    parts.push(format!(
        "SELECT MIN(created_at) FROM entity WHERE kind = 'note' AND title NOT IN ({marks})"
    ));
    parts.push(
        "SELECT MIN(created_at) FROM entity WHERE kind = 'person' AND id NOT IN \
         (SELECT id FROM entity WHERE kind = 'person' ORDER BY created_at, n LIMIT 1)"
            .to_owned(),
    );
    let sql = format!("SELECT MIN(at) FROM ({})", parts.join(" UNION ALL "));
    vault
        .read(|connection| Ok(connection.query_row(&sql, [], |row| row.get(0))?))
        .ok()
        .flatten()
}
