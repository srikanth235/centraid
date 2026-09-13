//! `automation_trigger_cursor`: the durable position of every trigger (#1020,
//! D-1020-AU1).
//!
//! The store code is the automations lane's and the DDL is the band's (see
//! [`super::automation_state`] for the split and the reason).
//!
//! ## What the row means, column by column
//!
//! | Column | What it is |
//! |---|---|
//! | `source_kind` | the trigger's IDENTITY, not just its kind: an `event` trigger's includes its connection and filter, so a trigger edited in place at the same index does not inherit a position that means nothing to its replacement |
//! | `position_json` | the committed source position. **Never advanced past an unacknowledged element** |
//! | `pending_json` | the write-ahead batch. Present ⟺ a delivery is still owed |
//! | `window_from`/`window_to` | the window the last read covered, for the missed-run report |
//! | `skipped` | how many due occurrences the backfill class collapsed |
//! | `gap_reason` | `scheduler_gap` when it did |
//! | `dead_letter_json` | the bounded tail of elements given up on |
//!
//! ## The one ordering that matters
//!
//! A pending batch is written **before** any side effect and the committed
//! position stays put until every element is acknowledged. So a gateway that
//! dies mid-batch restarts with the batch still pending and the position still
//! behind it — which is why [`put`] is a plain upsert and the ordering lives in
//! `centraid_automations::fire::cursor`, where the batch is.
//!
//! ## Retention must not prune a live cursor
//!
//! [`retain`] deletes by `(automation_id, trigger_index)` against the DECLARED
//! slot set, enabled or not — a disabled automation keeps its watermark. And an
//! **empty** desired set is refused rather than treated as "delete
//! everything", because the one caller that could pass an empty set is a
//! reconcile that read no automations, which is a failure and not a wipe.

use rusqlite::{OptionalExtension, params};

use crate::error::{Result, VaultError};
use crate::file::Vault;

/// One `automation_trigger_cursor` row.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Cursor {
    pub source_kind: String,
    pub position_json: Option<String>,
    pub pending_json: Option<String>,
    pub window_from: Option<i64>,
    pub window_to: Option<i64>,
    pub skipped: i64,
    pub gap_reason: Option<String>,
    pub dead_letter_json: Option<String>,
    pub updated_at: i64,
}

/// One declared slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slot {
    pub automation_id: String,
    pub trigger_index: i64,
}

/// Read one cursor.
pub fn get(vault: &Vault, automation_id: &str, trigger_index: i64) -> Result<Option<Cursor>> {
    vault.read(|connection| {
        connection
            .query_row(
                "SELECT source_kind, position_json, pending_json, window_from, window_to, \
                        skipped, gap_reason, dead_letter_json, updated_at \
                 FROM automation_trigger_cursor \
                 WHERE automation_id = ?1 AND trigger_index = ?2",
                params![automation_id, trigger_index],
                |row| {
                    Ok(Cursor {
                        source_kind: row.get(0)?,
                        position_json: row.get(1)?,
                        pending_json: row.get(2)?,
                        window_from: row.get(3)?,
                        window_to: row.get(4)?,
                        skipped: row.get(5)?,
                        gap_reason: row.get(6)?,
                        dead_letter_json: row.get(7)?,
                        updated_at: row.get(8)?,
                    })
                },
            )
            .optional()
            .map_err(|error| VaultError::from_sqlite("reading a trigger cursor", error))
    })
}

/// Upsert one cursor.
pub fn put(vault: &Vault, automation_id: &str, trigger_index: i64, cursor: &Cursor) -> Result<()> {
    vault.commit(|tx| {
        tx.set_producer("ledger.automation_trigger_cursor.put");
        tx.connection()
            .execute(
                "INSERT INTO automation_trigger_cursor \
                 (automation_id, trigger_index, source_kind, position_json, pending_json, \
                  window_from, window_to, skipped, gap_reason, dead_letter_json, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
                 ON CONFLICT (automation_id, trigger_index) DO UPDATE SET \
                   source_kind = ?3, position_json = ?4, pending_json = ?5, \
                   window_from = ?6, window_to = ?7, skipped = ?8, gap_reason = ?9, \
                   dead_letter_json = ?10, updated_at = ?11",
                params![
                    automation_id,
                    trigger_index,
                    cursor.source_kind,
                    cursor.position_json,
                    cursor.pending_json,
                    cursor.window_from,
                    cursor.window_to,
                    cursor.skipped,
                    cursor.gap_reason,
                    cursor.dead_letter_json,
                    cursor.updated_at,
                ],
            )
            .map_err(|error| VaultError::from_sqlite("writing a trigger cursor", error))?;
        Ok(())
    })?;
    Ok(())
}

/// Every cursor whose batch is still pending, so a boot can resume them.
///
/// The read a restart makes first: a pending batch is authoritative, and a
/// gateway that started ticking before draining these would re-read sources
/// whose elements are already owed.
pub fn pending(vault: &Vault) -> Result<Vec<Slot>> {
    vault.read(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT automation_id, trigger_index FROM automation_trigger_cursor \
                 WHERE pending_json IS NOT NULL ORDER BY automation_id, trigger_index",
            )
            .map_err(|error| VaultError::from_sqlite("listing pending batches", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok(Slot {
                    automation_id: row.get(0)?,
                    trigger_index: row.get(1)?,
                })
            })
            .map_err(|error| VaultError::from_sqlite("listing pending batches", error))?;
        rows.collect::<rusqlite::Result<Vec<Slot>>>()
            .map_err(|error| VaultError::from_sqlite("listing pending batches", error))
    })
}

/// Delete every cursor outside the declared slot set.
///
/// An EMPTY set is refused: see the module header.
pub fn retain(vault: &Vault, slots: &[Slot]) -> Result<usize> {
    if slots.is_empty() {
        return Err(VaultError::InvalidInput {
            name: "slots".to_owned(),
            detail: "an empty desired set is a reconcile that read no automations, not a request \
                     to delete every cursor"
                .to_owned(),
        });
    }
    let keep: std::collections::BTreeSet<(String, i64)> = slots
        .iter()
        .map(|slot| (slot.automation_id.clone(), slot.trigger_index))
        .collect();
    let existing: Vec<Slot> = vault.read(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT automation_id, trigger_index FROM automation_trigger_cursor \
                 ORDER BY automation_id, trigger_index",
            )
            .map_err(|error| VaultError::from_sqlite("listing trigger cursors", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok(Slot {
                    automation_id: row.get(0)?,
                    trigger_index: row.get(1)?,
                })
            })
            .map_err(|error| VaultError::from_sqlite("listing trigger cursors", error))?;
        rows.collect::<rusqlite::Result<Vec<Slot>>>()
            .map_err(|error| VaultError::from_sqlite("listing trigger cursors", error))
    })?;
    let doomed: Vec<&Slot> = existing
        .iter()
        .filter(|slot| !keep.contains(&(slot.automation_id.clone(), slot.trigger_index)))
        .collect();
    if doomed.is_empty() {
        return Ok(0);
    }
    let mut removed = 0usize;
    let outcome = vault.commit(|tx| {
        tx.set_producer("ledger.automation_trigger_cursor.retain");
        for slot in &doomed {
            removed += tx
                .connection()
                .execute(
                    "DELETE FROM automation_trigger_cursor \
                     WHERE automation_id = ?1 AND trigger_index = ?2",
                    params![slot.automation_id, slot.trigger_index],
                )
                .map_err(|error| VaultError::from_sqlite("pruning trigger cursors", error))?;
        }
        Ok(())
    })?;
    drop(outcome);
    Ok(removed)
}
