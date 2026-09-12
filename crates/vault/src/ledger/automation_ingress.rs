//! `trigger_ingress`: a delivery is durable before it is a fire (#1020,
//! D-1020-AU5).
//!
//! The store code is the automations lane's and the DDL is the band's (see
//! [`super::automation_state`]).
//!
//! ## Why the table exists at all
//!
//! An inbound delivery — a webhook a seat forwarded, a poll's batch — is the
//! one trigger element the gateway cannot recompute. A cron minute can be
//! derived again, a condition's rows can be re-read; a webhook body is gone the
//! moment the caller gets its answer. So the row is written **after auth and
//! before the fire**, and the fire reads it back. A gateway that dies between
//! the two re-delivers.
//!
//! ## The UNIQUE constraint IS the idempotency
//!
//! `UNIQUE (source, source_key, delivery_id)`. A provider that retries because
//! our 202 was lost hits the constraint, and [`store`] answers `false` — a
//! **duplicate, not an error**. Distinguishing them anywhere else would mean
//! two writers with two opinions about what a repeat means.
//!
//! ## `expires_at`, and who prunes
//!
//! The row carries its own expiry and [`prune_expired`] is what removes it. The
//! band's retention pass is `crates/assist`'s (D-1020-AS3) and it must not
//! prune a **live** cursor; this table is the other half of that rule — an
//! ingress row past its expiry has either been fired or been lost for a day,
//! and either way nothing is waiting for it.

use rusqlite::{OptionalExtension, params};

use crate::error::{Result, VaultError};
use crate::file::Vault;

/// The two values `trigger_ingress.source` may hold — the table's own CHECK.
pub const SOURCES: [&str; 2] = ["webhook", "poll"];

/// One row, as it is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ingress {
    pub source: String,
    /// The webhook route slug, or the poll's connection key.
    pub source_key: String,
    pub delivery_id: String,
    pub received_at: i64,
    /// The payload. `payload_ref` is the alternative the DDL allows for a
    /// payload too large to inline; nothing writes it yet, and a row must
    /// carry one or the other.
    pub payload_json: String,
    pub expires_at: i64,
}

/// One stored delivery, with the autoincrement id the source position uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub id: i64,
    pub ingress: Ingress,
}

/// Store one delivery. `false` means it was already there.
pub fn store(vault: &Vault, ingress: &Ingress) -> Result<bool> {
    if !SOURCES.contains(&ingress.source.as_str()) {
        return Err(VaultError::InvalidInput {
            name: "source".to_owned(),
            detail: format!(
                "`{}` is not an ingress source; the table's own CHECK allows {}",
                ingress.source,
                SOURCES.join(" or ")
            ),
        });
    }
    let inserted = vault.commit(|tx| {
        tx.set_producer("ledger.trigger_ingress.store");
        tx.connection()
            .execute(
                "INSERT OR IGNORE INTO trigger_ingress \
                 (source, source_key, delivery_id, received_at, payload_json, expires_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    ingress.source,
                    ingress.source_key,
                    ingress.delivery_id,
                    ingress.received_at,
                    ingress.payload_json,
                    ingress.expires_at,
                ],
            )
            .map_err(|error| VaultError::from_sqlite("storing an ingress delivery", error))
    })?;
    Ok(inserted.value > 0)
}

/// Deliveries for one source key after a position, oldest first.
///
/// **A bounded window** (D-1020-D3-12: a bound reports the size it reaches):
/// `limit` is the batch cap the cursor engine already applies, and it is
/// passed down rather than re-derived so the two cannot disagree.
pub fn after(
    vault: &Vault,
    source: &str,
    source_key: &str,
    after_id: i64,
    limit: usize,
) -> Result<Vec<Stored>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    vault.read(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT id, source, source_key, delivery_id, received_at, \
                        COALESCE(payload_json, ''), expires_at \
                 FROM trigger_ingress \
                 WHERE source = ?1 AND source_key = ?2 AND id > ?3 \
                 ORDER BY id LIMIT ?4",
            )
            .map_err(|error| VaultError::from_sqlite("reading ingress deliveries", error))?;
        let rows = statement
            .query_map(params![source, source_key, after_id, limit], |row| {
                Ok(Stored {
                    id: row.get(0)?,
                    ingress: Ingress {
                        source: row.get(1)?,
                        source_key: row.get(2)?,
                        delivery_id: row.get(3)?,
                        received_at: row.get(4)?,
                        payload_json: row.get(5)?,
                        expires_at: row.get(6)?,
                    },
                })
            })
            .map_err(|error| VaultError::from_sqlite("reading ingress deliveries", error))?;
        rows.collect::<rusqlite::Result<Vec<Stored>>>()
            .map_err(|error| VaultError::from_sqlite("reading ingress deliveries", error))
    })
}

/// Is this exact delivery already stored? The read behind a seat's "did that
/// get through" question.
pub fn contains(vault: &Vault, source: &str, source_key: &str, delivery_id: &str) -> Result<bool> {
    vault.read(|connection| {
        connection
            .query_row(
                "SELECT 1 FROM trigger_ingress \
                 WHERE source = ?1 AND source_key = ?2 AND delivery_id = ?3",
                params![source, source_key, delivery_id],
                |_row| Ok(()),
            )
            .optional()
            .map(|found| found.is_some())
            .map_err(|error| VaultError::from_sqlite("checking an ingress delivery", error))
    })
}

/// Remove rows past their own expiry. Returns how many.
pub fn prune_expired(vault: &Vault, now_ms: i64) -> Result<usize> {
    let removed = vault.commit(|tx| {
        tx.set_producer("ledger.trigger_ingress.prune");
        tx.connection()
            .execute(
                "DELETE FROM trigger_ingress WHERE expires_at <= ?1",
                params![now_ms],
            )
            .map_err(|error| VaultError::from_sqlite("pruning ingress deliveries", error))
    })?;
    Ok(removed.value)
}
