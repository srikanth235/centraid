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
//! 3. **The census counts a member's rows and not SQLite's working out.** It
//!    reads the same counters `CommitResult::tables` is built from, so FTS5's
//!    shadow tables — `_content`, `_data`, `_docsize`, `_idx`, `_config` — are
//!    out; and so is the FTS5 virtual table itself, which holds one row per row
//!    of the table it indexes, so counting it counted that table twice. The
//!    scan had all of them in: ninety shadow tables and eighteen duplicated
//!    counts in every member's generation manifest.
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
/// A census built by scanning `sqlite_master` reports FTS5's whole index. A
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
        .filter(|table| table.starts_with("fts_"))
        .collect();
    assert!(
        shadows.is_empty(),
        "the census carries SQLite's index bookkeeping as if it were a \
         member's rows, so it does not come from the counters: {shadows:?}"
    );
    // The virtual table goes with its shadows: FTS5 holds one row per row of
    // the table it indexes, so counting it counted `core_party` twice.
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

/// **EVERY WRITE PATH MOVES THE COUNTER, NOT ONLY THE COMMANDS** (#1047 R3).
///
/// The Locker's first unlock names a generation, and on a vault that has none
/// it writes one `locker_key` row. That write went straight to the connection,
/// outside [`centraid_vault::file::Vault::commit`] — so the `update_hook`
/// never saw it, the running census kept saying 0, the generation manifest
/// carried 0, and every restore of a phone that had ever opened Locker was
/// refused by `census_matches` with the row sitting right there in the file.
///
/// The census has to be **seeded before** the write for this to be red: a
/// counter seeded after it counts the row in its scan.
#[test]
fn the_locker_generation_row_is_counted_by_the_running_census() {
    let scratch = common::Scratch::founded("census-locker-key").expect("a vault is founded");
    let before = scratch.vault.census().expect("the census seeds");
    assert_eq!(
        before
            .iter()
            .find(|(table, _)| table == "locker_key")
            .map(|(_, rows)| *rows),
        Some(0),
        "a founded vault names no Locker generation yet"
    );

    let key_id = scratch
        .vault
        .locker_generation()
        .expect("the first unlock names a generation");
    assert_eq!(
        scratch
            .vault
            .locker_generation()
            .expect("and names it again"),
        key_id,
        "a second unlock reuses the live generation"
    );

    let census = scratch.vault.census().expect("the census reads");
    assert_eq!(
        census,
        scan(&scratch.vault, &census),
        "the running census missed the locker_key row the first unlock wrote"
    );
}

/// **`INSERT OR REPLACE` CAN DISPLACE A ROW THE HOOK NEVER HEARS ABOUT.**
///
/// SQLite's `update_hook` is not invoked for a row deleted by `REPLACE`
/// conflict resolution when the table has no delete trigger and no foreign key
/// pointing at it — the fast path. A REPLACE over an existing key there is
/// `+1` with no `−1`, and the running census drifts up by one. Whether a given
/// vault table takes the fast path depends on triggers and foreign keys any
/// later rung may add or drop, so no vault writer uses `OR REPLACE`
/// ([`no_vault_writer_resolves_a_conflict_by_replace`]); this test pins the
/// SQLite behaviour that ban rests on, on a table with neither.
#[test]
fn sqlite_does_not_report_a_row_that_a_fast_path_replace_displaced() {
    let scratch = common::Scratch::founded("census-replace").expect("a vault is founded");
    scratch
        .vault
        .commit(|tx| {
            tx.connection().execute_batch(
                "CREATE TABLE probe_replace (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT",
            )?;
            Ok(())
        })
        .expect("the probe table is made");
    let _ = scratch.vault.census().expect("the census seeds");
    for value in ["first", "second"] {
        scratch
            .vault
            .commit(|tx| {
                tx.connection().execute(
                    "INSERT OR REPLACE INTO probe_replace (k, v) VALUES ('one', ?1)",
                    params![value],
                )?;
                Ok(())
            })
            .expect("the commit lands");
    }
    let census = scratch.vault.census().expect("the census reads");
    let counted = census
        .iter()
        .find(|(table, _)| table == "probe_replace")
        .map(|(_, rows)| *rows);
    assert_eq!(
        counted,
        Some(2),
        "SQLite now reports a fast-path REPLACE's displaced row; the ban in \
         `no_vault_writer_resolves_a_conflict_by_replace` can be re-judged"
    );
}

/// **THE MECHANICAL HALF OF THE SWEEP.** No writer in the vault crate resolves
/// a conflict by REPLACE, because the running census cannot see the row it
/// displaces ([`sqlite_does_not_report_a_row_that_a_fast_path_replace_displaced`]). An
/// upsert (`ON CONFLICT … DO UPDATE`) is an update, which the hook reports and
/// which moves no count.
#[test]
fn no_vault_writer_resolves_a_conflict_by_replace() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut stack = vec![root];
    let mut found = Vec::new();
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("the source tree reads") {
            let path = entry.expect("an entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .extension()
                .is_some_and(|ext| ext == "rs" || ext == "sql")
            {
                let text = std::fs::read_to_string(&path).expect("a source file reads");
                for (line, content) in text.lines().enumerate() {
                    let upper = content.to_uppercase();
                    let code = upper.trim_start();
                    if code.starts_with("//") || code.starts_with("--") {
                        continue;
                    }
                    if upper.contains("OR REPLACE") || upper.contains("REPLACE INTO") {
                        found.push(format!("{}:{}", path.display(), line + 1));
                    }
                }
            }
        }
    }
    assert!(
        found.is_empty(),
        "a REPLACE displaces a row the running census never hears about: {found:?}"
    );
}
