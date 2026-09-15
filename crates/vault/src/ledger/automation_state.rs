//! `automation_state`: one KV namespace, two kinds of tenant (#1020,
//! D-1020-AU1).
//!
//! **The store code is the automations lane's; the DDL is not.** The table is
//! one of the ledger band's fourteen and it was created by wave 4's baseline
//! (`contracts/migrations/001_baseline.sql:268`) under D-1020-AS8 — the band is
//! on rung one, so this module adds no migration and defines no schema. What it
//! owns is the *statements*, and the reason they are here rather than in
//! `crates/automations` is `sql-confinement`: SQL lives under
//! `crates/{ontology,vault,seat,search}` and `crates/apps/kit`, and the rule is
//! not widened to accommodate a new caller.
//!
//! ## Two tenants, one table, one reserved prefix
//!
//! A handler's `ctx.state` is a per-automation key/value bag — a poll's "last
//! id I saw", a digest's "yesterday's total". The **scheduler's own** missed-run
//! ledger lives in the same table under the reserved automation id
//! [`SCHEDULER_ID`], because it is state about scheduling rather than state of
//! any one automation.
//!
//! `__trigger:` stays a **reserved key prefix** (`fire/condition.ts:17`–`:22`):
//! durable trigger positions live in `automation_trigger_cursor`, so nothing
//! writes the prefix, and [`set`] refuses it so a handler cannot squat on a
//! namespace the runtime may need back.
//!
//! ## Why the writes do not go through a command
//!
//! Same reason as the rest of the band ([`super::store`]): a command exists so
//! a member's intent is gated, receipted, replayed and replicated, and none of
//! those describes a poll's watermark. The writes still ride the commit guard,
//! so the doorbell rings and the rows are captured `local = 1`.

use rusqlite::{OptionalExtension, params};

use crate::error::{Result, VaultError};
use crate::file::Vault;

/// The reserved tenant the scheduler's own ledger lives under.
pub const SCHEDULER_ID: &str = "__scheduler";

/// The key prefix the runtime reserves. A handler may not write it.
pub const RESERVED_KEY_PREFIX: &str = "__trigger:";

/// Read one value. `None` is *absent*, which for a cursor bootstrap is a
/// different answer from `Some("null")` — a watcher with no position reacts to
/// what happens next, and one with a stored `null` has a corrupt row.
pub fn get(vault: &Vault, automation_id: &str, key: &str) -> Result<Option<String>> {
    vault.read(|connection| {
        connection
            .query_row(
                "SELECT value_json FROM automation_state WHERE automation_id = ?1 AND key = ?2",
                params![automation_id, key],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(|error| VaultError::from_sqlite("reading automation state", error))
    })
}

/// Write one value.
///
/// The reserved prefix is refused HERE rather than validated at the caller,
/// because there are several callers and one table.
pub fn set(vault: &Vault, automation_id: &str, key: &str, value_json: &str) -> Result<()> {
    if key.starts_with(RESERVED_KEY_PREFIX) && automation_id != SCHEDULER_ID {
        return Err(VaultError::InvalidInput {
            name: "key".to_owned(),
            detail: format!(
                "`{RESERVED_KEY_PREFIX}` is reserved for the runtime's own trigger bookkeeping — a \
                 durable trigger position lives in automation_trigger_cursor, not here"
            ),
        });
    }
    let now = vault.clock().now_ms();
    vault.commit(|tx| {
        tx.set_producer("ledger.automation_state.set");
        tx.connection()
            .execute(
                "INSERT INTO automation_state (automation_id, key, value_json, updated_at) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT (automation_id, key) DO UPDATE SET \
                   value_json = ?3, updated_at = ?4",
                params![automation_id, key, value_json, now],
            )
            .map_err(|error| VaultError::from_sqlite("writing automation state", error))?;
        Ok(())
    })?;
    Ok(())
}

/// Drop one key.
pub fn remove(vault: &Vault, automation_id: &str, key: &str) -> Result<bool> {
    let removed = vault.commit(|tx| {
        tx.set_producer("ledger.automation_state.remove");
        tx.connection()
            .execute(
                "DELETE FROM automation_state WHERE automation_id = ?1 AND key = ?2",
                params![automation_id, key],
            )
            .map_err(|error| VaultError::from_sqlite("removing automation state", error))
    })?;
    Ok(removed.value > 0)
}

/// Every key one automation holds, sorted. The shape a `ctx.state` listing and
/// the CLI's own report both need.
pub fn keys(vault: &Vault, automation_id: &str) -> Result<Vec<String>> {
    vault.read(|connection| {
        let mut statement = connection
            .prepare("SELECT key FROM automation_state WHERE automation_id = ?1 ORDER BY key")
            .map_err(|error| VaultError::from_sqlite("listing automation state", error))?;
        let rows = statement
            .query_map(params![automation_id], |row| row.get::<_, String>(0))
            .map_err(|error| VaultError::from_sqlite("listing automation state", error))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()
            .map_err(|error| VaultError::from_sqlite("listing automation state", error))
    })
}

/// Drop everything one automation holds.
///
/// For an automation that has been **deleted**, never for one that has been
/// disabled: a disabled automation keeps its state so re-enabling resumes
/// rather than starting over (`cursor-engine.ts` `register`).
pub fn forget(vault: &Vault, automation_id: &str) -> Result<usize> {
    if automation_id == SCHEDULER_ID {
        return Err(VaultError::InvalidInput {
            name: "automation_id".to_owned(),
            detail: "the scheduler's own ledger is not an automation's state and is not forgotten \
                     with one"
                .to_owned(),
        });
    }
    let removed = vault.commit(|tx| {
        tx.set_producer("ledger.automation_state.forget");
        tx.connection()
            .execute(
                "DELETE FROM automation_state WHERE automation_id = ?1",
                params![automation_id],
            )
            .map_err(|error| VaultError::from_sqlite("forgetting automation state", error))
    })?;
    Ok(removed.value)
}
