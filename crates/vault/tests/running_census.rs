//! **THE CENSUS IS A RUNNING COUNTER, NOT A SCAN** (#1029 W13, finding 15).
//!
//! `Vault::census` ran `SELECT count(*)` once per table, and #1029 §2 calls it
//! at **every capture tick** — so the cost of asking "how many rows does this
//! vault hold" scaled with the vault, on the path a phone takes every time it
//! backs up. #1029 line 99 says what it should be instead: the running
//! per-table count the `update_hook` maintains, `+1` per insert and `−1` per
//! delete, exact at every txid.
//!
//! Three properties, and each is a way the counters could be wrong:
//!
//! 1. **They agree with the file.** A randomised workload of inserts, updates
//!    and deletes, compared against a full scan after every single commit. A
//!    counter that drifted would make the shrink guard (F4) fire on a vault
//!    that lost nothing, or stay quiet on one that lost everything — and it
//!    would write that wrong number into the generation manifest, where a
//!    restore verifies against it.
//! 2. **A rollback leaves nothing behind.** The hook fires for every row a
//!    rolled-back body wrote, and none of those rows exists afterwards. A
//!    counter that took its increments at hook time rather than at COMMIT would
//!    keep them.
//! 3. **The counters and the guard agree about what a table is.** The census
//!    now reads the same counters `CommitResult::tables` is built from, so
//!    FTS5's shadow tables — `_content`, `_data`, `_docsize`, `_idx`,
//!    `_config`, which every write to an indexed table touches through a
//!    trigger — are out of both. The scan had them in, so a member's census
//!    carried four bookkeeping "tables" no app of theirs owns.
//!
//! Property 3 is the one that fails before the fix.

mod common;

use rusqlite::params;

/// Deterministic, so a failure is reproducible: a tiny LCG rather than a
/// dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        self.0 >> 33
    }
}

/// Count every table the census names, the slow way.
fn scan(vault: &centraid_vault::file::Vault, census: &[(String, i64)]) -> Vec<(String, i64)> {
    census
        .iter()
        .map(|(table, _)| {
            let actual: i64 = vault
                .read(|connection| {
                    Ok(connection.query_row(
                        &format!(
                            "SELECT count(*) FROM {}",
                            centraid_vault::log::identifiers::quoted(table)
                        ),
                        [],
                        |row| row.get(0),
                    )?)
                })
                .unwrap_or_else(|error| panic!("`{table}` would not count: {error}"));
            (table.clone(), actual)
        })
        .collect()
}

/// **Property 3, and it is red before the fix.**
///
/// A census built by scanning `sqlite_master` reports FTS5's shadow tables. A
/// census read off the counters the `update_hook` maintains does not, because
/// the guard's `is_reportable` has always excluded them — and the whole of
/// finding 15's fix is that those are the same numbers.
#[test]
fn the_census_names_no_fts5_shadow_table() {
    let scratch = common::Scratch::founded("census-shadow").expect("a vault is founded");
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.shadow");
            tx.connection().execute(
                "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                 VALUES ('p-shadow', 'person', 'Shadow', ?1, ?1)",
                [&"2026-01-01T00:00:00.000Z"],
            )?;
            Ok(())
        })
        .expect("the commit lands");

    let census = scratch.vault.census().expect("the census reads");
    let shadows: Vec<&String> = census
        .iter()
        .map(|(table, _)| table)
        .filter(|table| {
            table.starts_with("fts_")
                && ["_content", "_data", "_docsize", "_idx", "_config"]
                    .iter()
                    .any(|suffix| table.ends_with(suffix))
        })
        .collect();
    assert!(
        shadows.is_empty(),
        "the census carries SQLite's index bookkeeping as if it were a \
         member's rows, so it does not come from the counters: {shadows:?}"
    );
    assert!(
        census.iter().any(|(table, _)| table == "core_party"),
        "the census lost a real table"
    );
}

/// **Properties 1 and 2.** A randomised workload, checked against a scan after
/// every commit — and after a rollback, whose increments must not survive.
#[test]
fn the_running_census_equals_a_scan_after_every_commit_and_every_rollback() {
    let scratch = common::Scratch::founded("census-workload").expect("a vault is founded");
    let mut rng = Rng(0x5eed_1029);
    let mut live: Vec<String> = Vec::new();

    for round in 0..40_u32 {
        let roll = rng.next() % 10;
        let outcome = scratch.vault.commit(|tx| {
            tx.set_producer("test.workload");
            match roll {
                // Insert one to three.
                0..=4 => {
                    for step in 0..=(rng.next() % 3) {
                        let id = format!("p-{round}-{step}");
                        tx.connection().execute(
                            "INSERT INTO core_party
                               (party_id, kind, display_name, created_at, updated_at)
                             VALUES (?1, 'person', ?2, ?3, ?3)",
                            params![id, format!("Person {round}"), "2026-01-01T00:00:00.000Z"],
                        )?;
                    }
                    Ok(true)
                }
                // Update, which moves no counter at all.
                5..=6 => {
                    tx.connection().execute(
                        "UPDATE core_party SET display_name = ?1 WHERE kind = 'person'",
                        params![format!("Renamed {round}")],
                    )?;
                    Ok(true)
                }
                // Delete the oldest, if there is one.
                7..=8 => {
                    if let Some(id) = live.first() {
                        tx.connection()
                            .execute("DELETE FROM core_party WHERE party_id = ?1", params![id])?;
                    }
                    Ok(true)
                }
                // **A ROLLBACK**: write, then refuse. The hook fired for every
                // row; none of them exists afterwards.
                _ => {
                    for step in 0..3 {
                        tx.connection().execute(
                            "INSERT INTO core_party
                               (party_id, kind, display_name, created_at, updated_at)
                             VALUES (?1, 'person', 'Doomed', ?2, ?2)",
                            params![
                                format!("p-rolled-{round}-{step}"),
                                "2026-01-01T00:00:00.000Z"
                            ],
                        )?;
                    }
                    Err(centraid_vault::error::VaultError::Invariant {
                        context: "this transaction is refused on purpose".to_owned(),
                    })
                }
            }
        });

        match (roll, &outcome) {
            (9, result) => assert!(result.is_err(), "the rollback round committed"),
            (_, result) => {
                result.as_ref().expect("the commit lands");
            }
        }

        // Track what survived, so the delete round has something real to remove.
        if outcome.is_ok() {
            match roll {
                0..=4 => {
                    for step in 0..=2_u64 {
                        let id = format!("p-{round}-{step}");
                        let exists: i64 = scratch
                            .vault
                            .read(|connection| {
                                Ok(connection.query_row(
                                    "SELECT count(*) FROM core_party WHERE party_id = ?1",
                                    params![id],
                                    |row| row.get(0),
                                )?)
                            })
                            .expect("reads");
                        if exists == 1 && !live.contains(&id) {
                            live.push(id);
                        }
                    }
                }
                7..=8 => {
                    if !live.is_empty() {
                        live.remove(0);
                    }
                }
                _ => {}
            }
        }

        // THE ASSERTION, after every single round.
        let census = scratch.vault.census().expect("the census reads");
        assert_eq!(
            census,
            scan(&scratch.vault, &census),
            "round {round} (roll {roll}): the running census disagrees with the file"
        );
    }
}
