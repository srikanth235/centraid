//! `harness_health`: persistent per-kind circuit breakers (#1020, D-1020-AS3).
//!
//! The rows this module reads and writes; the *policy* over them — how long a
//! breaker stays shut, when a half-open probe may be claimed — is
//! `crates/assist::health`, because it is a decision rather than a statement.
//!
//! ## Why the breaker is persistent
//!
//! A harness that is failing because the member's subscription lapsed will fail
//! the same way on the next boot. An in-memory breaker forgets on restart and
//! an automation that fires hourly spends the whole day re-discovering it.
//!
//! ## `-1` is a PERMANENT sentinel, not a timestamp in the past
//!
//! `breaker_until = -1` means *never retry until something changes*
//! (`harness-health.ts:114`): an `auth` failure is not a transient outage and
//! backing off exponentially from it just delays the sentence the member needs
//! to read. Any positive value is a real deadline in epoch milliseconds. A
//! reader that compared `-1 < now` would treat permanent as expired, which is
//! precisely the retry storm the sentinel exists to stop — so the comparison
//! lives in one function, [`crate::ledger::health::is_open`].
//!
//! ## Why `ORDER BY COALESCE(breaker_until, 0) DESC`
//!
//! The status surface shows the *worst* class per kind. `NULL` (no breaker) must
//! sort below every real deadline, and `-1` must sort **above** every finite
//! one, which it does not under a plain DESC — so the ordering is explicit
//! about the sentinel.

use rusqlite::{OptionalExtension, params};

use crate::error::{Result, VaultError};
use crate::file::Vault;

/// The value that means "permanently open until something changes".
pub const PERMANENT: i64 = -1;

/// One `harness_health` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Health {
    pub workspace_context: String,
    pub harness_kind: String,
    pub failure_class: String,
    pub consecutive_failures: i64,
    pub breaker_until: Option<i64>,
    pub half_open_claimed_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_failure_at: Option<i64>,
    pub last_ok_at: Option<i64>,
}

/// Whether this row's breaker is shut right now.
///
/// The one place the sentinel is interpreted.
#[must_use]
pub const fn is_open(breaker_until: Option<i64>, now_ms: i64) -> bool {
    match breaker_until {
        None => false,
        Some(PERMANENT) => true,
        Some(until) => until > now_ms,
    }
}

/// Record a failure and set the breaker deadline the policy chose.
pub fn record_failure(
    vault: &Vault,
    workspace_context: &str,
    harness_kind: &str,
    failure_class: &str,
    breaker_until: Option<i64>,
    last_error: &str,
) -> Result<()> {
    let now = vault.clock().now_ms();
    vault.commit(|tx| {
        tx.set_producer("ledger.harness_health.failure");
        tx.connection()
            .execute(
                "INSERT INTO harness_health \
                 (workspace_context, harness_kind, failure_class, consecutive_failures, \
                  breaker_until, last_error, last_failure_at) \
                 VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6) \
                 ON CONFLICT (workspace_context, harness_kind, failure_class) DO UPDATE SET \
                   consecutive_failures = harness_health.consecutive_failures + 1, \
                   breaker_until = ?4, \
                   half_open_claimed_at = NULL, \
                   last_error = ?5, \
                   last_failure_at = ?6",
                params![
                    workspace_context,
                    harness_kind,
                    failure_class,
                    breaker_until,
                    last_error,
                    now
                ],
            )
            .map_err(|error| VaultError::from_sqlite("recording a harness failure", error))?;
        Ok(())
    })?;
    Ok(())
}

/// Record a success: the breaker clears and the failure run resets to zero.
pub fn record_success(
    vault: &Vault,
    workspace_context: &str,
    harness_kind: &str,
    failure_class: &str,
) -> Result<()> {
    let now = vault.clock().now_ms();
    vault.commit(|tx| {
        tx.set_producer("ledger.harness_health.ok");
        tx.connection()
            .execute(
                "INSERT INTO harness_health \
                 (workspace_context, harness_kind, failure_class, consecutive_failures, \
                  breaker_until, half_open_claimed_at, last_ok_at) \
                 VALUES (?1, ?2, ?3, 0, NULL, NULL, ?4) \
                 ON CONFLICT (workspace_context, harness_kind, failure_class) DO UPDATE SET \
                   consecutive_failures = 0, \
                   breaker_until = NULL, \
                   half_open_claimed_at = NULL, \
                   last_ok_at = ?4",
                params![workspace_context, harness_kind, failure_class, now],
            )
            .map_err(|error| VaultError::from_sqlite("recording a harness success", error))?;
        Ok(())
    })?;
    Ok(())
}

/// Claim the single half-open probe for an expired breaker.
///
/// Returns whether the claim succeeded. The `WHERE` clause is the whole
/// mechanism: two concurrent fires both see an expired deadline, both try to
/// claim, and SQLite's write lock means exactly one `UPDATE` matches. Without
/// it, every queued automation retries the wedged harness at once — which is
/// the thundering herd a breaker is supposed to prevent.
pub fn claim_half_open(
    vault: &Vault,
    workspace_context: &str,
    harness_kind: &str,
    failure_class: &str,
    now_ms: i64,
) -> Result<bool> {
    let changed = vault.commit(|tx| {
        tx.set_producer("ledger.harness_health.half_open");
        tx.connection()
            .execute(
                "UPDATE harness_health SET half_open_claimed_at = ?4 \
                 WHERE workspace_context = ?1 AND harness_kind = ?2 AND failure_class = ?3 \
                   AND half_open_claimed_at IS NULL \
                   AND breaker_until IS NOT NULL AND breaker_until <> -1 \
                   AND breaker_until <= ?4",
                params![workspace_context, harness_kind, failure_class, now_ms],
            )
            .map_err(|error| VaultError::from_sqlite("claiming a half-open probe", error))
    })?;
    Ok(changed.value > 0)
}

/// Every recorded class for one kind, worst first.
pub fn classes_for(
    vault: &Vault,
    workspace_context: &str,
    harness_kind: &str,
) -> Result<Vec<Health>> {
    vault.read(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT workspace_context, harness_kind, failure_class, consecutive_failures, \
                        breaker_until, half_open_claimed_at, last_error, last_failure_at, \
                        last_ok_at \
                 FROM harness_health WHERE workspace_context = ?1 AND harness_kind = ?2 \
                 ORDER BY CASE WHEN breaker_until = -1 THEN 1 ELSE 0 END DESC, \
                          COALESCE(breaker_until, 0) DESC, failure_class",
            )
            .map_err(|error| VaultError::from_sqlite("reading harness health", error))?;
        let rows = statement
            .query_map(params![workspace_context, harness_kind], |row| {
                Ok(Health {
                    workspace_context: row.get(0)?,
                    harness_kind: row.get(1)?,
                    failure_class: row.get(2)?,
                    consecutive_failures: row.get(3)?,
                    breaker_until: row.get(4)?,
                    half_open_claimed_at: row.get(5)?,
                    last_error: row.get(6)?,
                    last_failure_at: row.get(7)?,
                    last_ok_at: row.get(8)?,
                })
            })
            .map_err(|error| VaultError::from_sqlite("reading harness health", error))?;
        let mut found = Vec::new();
        for row in rows {
            found.push(
                row.map_err(|error| VaultError::from_sqlite("reading harness health", error))?,
            );
        }
        Ok(found)
    })
}

/// One class's row.
pub fn one(
    vault: &Vault,
    workspace_context: &str,
    harness_kind: &str,
    failure_class: &str,
) -> Result<Option<Health>> {
    vault.read(|connection| {
        connection
            .query_row(
                "SELECT workspace_context, harness_kind, failure_class, consecutive_failures, \
                        breaker_until, half_open_claimed_at, last_error, last_failure_at, \
                        last_ok_at \
                 FROM harness_health \
                 WHERE workspace_context = ?1 AND harness_kind = ?2 AND failure_class = ?3",
                params![workspace_context, harness_kind, failure_class],
                |row| {
                    Ok(Health {
                        workspace_context: row.get(0)?,
                        harness_kind: row.get(1)?,
                        failure_class: row.get(2)?,
                        consecutive_failures: row.get(3)?,
                        breaker_until: row.get(4)?,
                        half_open_claimed_at: row.get(5)?,
                        last_error: row.get(6)?,
                        last_failure_at: row.get(7)?,
                        last_ok_at: row.get(8)?,
                    })
                },
            )
            .optional()
            .map_err(|error| VaultError::from_sqlite("reading harness health", error))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_permanent_sentinel_is_never_read_as_expired() {
        assert!(is_open(Some(PERMANENT), i64::MAX));
        assert!(is_open(Some(10), 9));
        assert!(
            !is_open(Some(10), 10),
            "a deadline that has arrived is open"
        );
        assert!(!is_open(None, 0));
    }
}
