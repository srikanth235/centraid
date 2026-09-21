//! **THE RUNNING ROW CENSUS** (#1029 §1, §2, line 99; W13 finding 15).
//!
//! Every table's row count, maintained by the commit guard's `update_hook` —
//! `+1` per inserted row, `−1` per deleted row, nothing for an update — and
//! **applied at COMMIT**, so a transaction that rolled back leaves no
//! increment behind. The counters are therefore exact at every txid, which is
//! what #1029 §2 needs: the manifest carries the census at every entry, and a
//! restore verifies against it after applying each segment.
//!
//! ## WHAT THIS REPLACES, AND WHY IT HAD TO GO
//!
//! `Vault::census` ran `SELECT count(*) FROM <table>` once per table, and
//! [`crate::backup::capture`] calls it **at every capture tick**. So the cost of
//! the question scaled with the vault, on the path a phone takes every time it
//! backs up — which the constitution names directly: nothing whose cost scales
//! with vault size runs synchronously on the request path.
//!
//! It was also wrong in a way nobody had to measure. The scan walked
//! `sqlite_master` and excluded only `sqlite\_%`, so it reported FTS5's
//! `_content`, `_data`, `_docsize`, `_idx` and `_config` shadow tables — the
//! index's own bookkeeping, which the guard's `is_reportable` has always kept
//! out of `CommitResult::tables`. Ninety of them reached a member's generation
//! manifest as if they were rows of theirs. The census and the change census
//! are now built from the same counters, so they cannot disagree again.
//!
//! ## THE ONE SCAN THAT REMAINS, AND WHERE IT IS
//!
//! A counter has to start somewhere. A vault that was just opened — or
//! restored, or migrated — holds rows nothing in this process counted, so the
//! **first** read of a table's count scans that table once and remembers it.
//! Everything after is arithmetic. That is a cost that scales with the vault
//! **once per process**, not once per capture tick, and it is here rather than
//! in the guard so that the guard has no scan in it at all.
//!
//! The table LIST is re-read from `sqlite_master` on every call. That is a
//! schema-sized query, not a vault-sized one, and it is what makes a table a
//! migration created since the last call appear — with its count seeded on the
//! spot.

use std::collections::BTreeMap;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::Result;

/// The per-table counts, and whether each has been seeded.
///
/// Behind a `Mutex` for the same reason the change census is: the guard hands
/// deltas in from a `&Vault`, and the vault is shared.
#[derive(Debug, Default)]
pub struct RunningCensus {
    counts: Mutex<BTreeMap<String, i64>>,
}

impl RunningCensus {
    /// **Apply one commit's deltas.** Called by the guard *after* `COMMIT`
    /// succeeded, and never on the rollback path — which is the whole of how a
    /// rolled-back transaction's increments fail to survive.
    ///
    /// A delta for a table nothing has seeded yet is dropped: the seed scan
    /// that runs on the next read counts the committed rows, this one among
    /// them, so applying it as well would double it.
    pub fn apply(&self, deltas: &BTreeMap<String, i64>) {
        let Ok(mut counts) = self.counts.lock() else {
            return;
        };
        for (table, delta) in deltas {
            if let Some(count) = counts.get_mut(table) {
                *count = count.saturating_add(*delta);
            }
        }
    }

    /// Forget everything, so the next read seeds from the file again.
    ///
    /// The restore path uses it: a vault whose bytes were replaced wholesale
    /// has counts no arithmetic of ours relates to.
    pub fn forget(&self) {
        if let Ok(mut counts) = self.counts.lock() {
            counts.clear();
        }
    }

    /// Every table this vault holds, with its row count.
    ///
    /// # Errors
    /// Whatever the schema query or a seeding scan refused.
    pub fn read(&self, connection: &Connection) -> Result<Vec<(String, i64)>> {
        let tables = reportable_tables(connection)?;
        let mut out = Vec::with_capacity(tables.len());
        for table in tables {
            let known = self
                .counts
                .lock()
                .ok()
                .and_then(|counts| counts.get(&table).copied());
            let count = match known {
                Some(count) => count,
                None => {
                    let counted = count_rows(connection, &table)?;
                    if let Ok(mut counts) = self.counts.lock() {
                        counts.insert(table.clone(), counted);
                    }
                    counted
                }
            };
            out.push((table, count));
        }
        Ok(out)
    }
}

/// The tables a member has rows in, in name order.
///
/// Three exclusions, and each is the same judgement: a census counts a
/// member's rows, not SQLite's working out.
///
/// 1. `sqlite_%` — SQLite's own bookkeeping.
/// 2. FTS5's shadow tables, through the change census's own
///    [`crate::log::guard::is_reportable`], so the two censuses cannot come to
///    disagree about what a table is.
/// 3. **Every virtual table.** An FTS5 index holds one row per row of the table
///    it indexes, so counting `fts_core_party` counts `core_party` a second
///    time — the census said 3 parties and 3 fts_core_party and a phone
///    comparing totals was comparing a number with a duplicate inside it. It is
///    also the one count the `update_hook` cannot maintain: the hook fires for
///    the shadow tables and never for the virtual table's own name.
///
/// Read from `sql` rather than from the name, so a virtual table that is not
/// called `fts_…` is excluded too.
fn reportable_tables(connection: &Connection) -> Result<Vec<String>> {
    let mut statement = connection.prepare(
        r"SELECT name, coalesce(sql, '') FROM sqlite_master
            WHERE type = 'table'
              AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
            ORDER BY name",
    )?;
    let tables = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<(String, String)>>>()?
        .into_iter()
        .filter(|(table, sql)| {
            crate::log::guard::is_reportable(table) && !sql.contains("CREATE VIRTUAL TABLE")
        })
        .map(|(table, _)| table)
        .collect();
    Ok(tables)
}

/// **The seed scan.** Once per table per process; see the module header.
fn count_rows(connection: &Connection, table: &str) -> Result<i64> {
    let sql = format!(
        "SELECT count(*) FROM {}",
        crate::log::identifiers::quoted(table)
    );
    Ok(connection.query_row(&sql, [], |row| row.get(0))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A delta for a table nothing seeded is dropped rather than invented: the
    /// seed that comes later counts those rows already.
    #[test]
    fn a_delta_for_an_unseeded_table_is_not_invented() {
        let census = RunningCensus::default();
        census.apply(&BTreeMap::from([("core_party".to_owned(), 3)]));
        let connection = Connection::open_in_memory().expect("an in-memory database");
        connection
            .execute_batch("CREATE TABLE core_party (id TEXT); INSERT INTO core_party VALUES ('a')")
            .expect("makes a table");
        assert_eq!(
            census.read(&connection).expect("reads"),
            vec![("core_party".to_owned(), 1)]
        );
    }

    /// Seed once, then arithmetic — including a delete, which is what the old
    /// scan was the only way to see.
    #[test]
    fn the_counters_move_by_their_deltas_once_seeded() {
        let connection = Connection::open_in_memory().expect("an in-memory database");
        connection
            .execute_batch("CREATE TABLE core_party (id TEXT); INSERT INTO core_party VALUES ('a')")
            .expect("makes a table");
        let census = RunningCensus::default();
        assert_eq!(census.read(&connection).expect("seeds")[0].1, 1);
        census.apply(&BTreeMap::from([("core_party".to_owned(), 4)]));
        assert_eq!(census.read(&connection).expect("reads")[0].1, 5);
        census.apply(&BTreeMap::from([("core_party".to_owned(), -2)]));
        assert_eq!(census.read(&connection).expect("reads")[0].1, 3);
        census.forget();
        assert_eq!(
            census.read(&connection).expect("re-seeds")[0].1,
            1,
            "forgetting sends the next read back to the file"
        );
    }
}
