//! `trash` — the transactions in the trash, most recently trashed first (#1185).
//!
//! A transaction is an entity of kind `txn`; trashing one (`entity.trash`) stamps `deleted_at` and
//! `purge_at` on the entity row and changes nothing of the line (what the bank stated is never
//! edited), so the shelf is a read of those rows. Every figure reads a trashed line out
//! ([`crate::queries`]: balances, spending, cash flow, recurring charges, search, transfers) and a
//! restore brings it back exactly. The page door cannot read the shelf (the lists read live lines),
//! so this is a read of its own, bounded by [`TRASH_ROWS`] with the truncation reported. A row is
//! named as the member sees the line: their name for it, else the bank's words.

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, read_window};
use centraid_apps_kit::row::text_of;

use crate::queries::trashed_titles_statement;

/// The shelf's window.
pub const TRASH_ROWS: usize = 500;

/// One trashed transaction: its name and the two instants the vault stamped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashRow {
    pub txn_id: String,
    pub title: String,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
}

/// The shelf, and whether it is longer than its window.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrashData {
    pub transactions: Vec<TrashRow>,
    pub truncated: bool,
}

/// `trash`: the trashed transactions.
///
/// # Errors
///
/// A door failure.
pub fn load_trash(door: &dyn PageDoor) -> KitResult<TrashData> {
    let window = read_window(door, &trashed_titles_statement(), TRASH_ROWS)?;
    let transactions = window
        .rows
        .iter()
        .filter_map(|row| {
            Some(TrashRow {
                txn_id: text_of(row, "id")?,
                title: text_of(row, "title").unwrap_or_default(),
                deleted_at: text_of(row, "deleted_at"),
                purge_at: text_of(row, "purge_at"),
            })
        })
        .collect();
    Ok(TrashData {
        transactions,
        truncated: window.filled,
    })
}
