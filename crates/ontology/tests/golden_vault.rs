//! WAVE 1'S CHECKPOINT (#1020): the ontology crate opens the v0 golden vault.
//!
//! v0's `golden-vault.test.ts` is the oracle. It inflates the frozen corpus,
//! opens it — running the ladder, which IS the upgrade under test — and asks
//! whether every row survived with its values. This crate has no ladder, so it
//! asks the narrower question that wave 1 can honestly answer: opened WITHOUT
//! migrating, does the frozen file still present exactly the rows and digests
//! the release froze, and does it hold together structurally?
//!
//! The digests are the load-bearing part. They were written by TypeScript over
//! `node:sqlite` values, so a Rust port that reproduces them has proved it
//! reads the file the same way the oracle does — which is the only claim that
//! makes this crate a candidate to replace it.

use centraid_ontology::golden::open_golden;
use centraid_ontology::snapshot::{compare_snapshot, snapshot_tables};
use centraid_ontology::{
    Vault, compare_snapshot as _reexported, format_doctor_report, vault_doctor,
};

/// Keep the re-export honest: `lib.rs` promises this name.
const _: fn(
    &centraid_ontology::VaultSnapshot,
    &rusqlite::Connection,
) -> centraid_ontology::Result<centraid_ontology::SnapshotComparison> = _reexported;

#[test]
fn the_ontology_crate_opens_the_v0_golden_vault() {
    let golden = open_golden().expect("the corpus inflates");
    let vault = Vault::open(golden.db_path()).expect("the corpus opens");

    let manifest = golden.manifest();
    assert_eq!(manifest.label, "issue-929");
    assert_eq!(
        manifest.ontology_version,
        centraid_ontology::ONTOLOGY_VERSION
    );
    assert_eq!(vault.user_version(), manifest.user_version);
    assert_eq!(
        vault.user_version(),
        centraid_ontology::EXPECTED_USER_VERSION
    );
    // The corpus is a WAL file; the pragma is read at open so a future change
    // of journal mode is visible rather than silent.
    assert_eq!(vault.journal_mode(), "wal");
}

#[test]
fn every_row_the_release_froze_is_still_there_with_its_values() {
    let golden = open_golden().expect("the corpus inflates");
    let vault = Vault::open(golden.db_path()).expect("the corpus opens");
    let manifest = golden.manifest();

    let comparison =
        compare_snapshot(&manifest.tables, vault.connection()).expect("the comparison runs");

    // The findings ARE the message: "3 row(s) present before the upgrade are
    // GONE after it" is what a reviewer needs, not `expected true to be false`.
    assert_eq!(comparison.findings.join("\n"), "");
    assert!(comparison.ok);

    // Prove the comparison had something to compare. A manifest that silently
    // lost its tables would otherwise pass, and the numbers are the checkpoint
    // evidence the receipt quotes.
    assert_eq!(comparison.compared.tables, 16);
    let manifest_rows: usize = manifest
        .tables
        .values()
        .map(|table| table.digests.len())
        .sum();
    assert_eq!(comparison.compared.rows, manifest_rows);
    assert_eq!(comparison.compared.rows, 139);
}

#[test]
fn re_snapshotting_the_corpus_reproduces_the_frozen_manifest() {
    // The strongest form of the digest claim: not only does every frozen
    // digest match, but freezing the file again from Rust produces the SAME
    // manifest — same tables, same columns, same primary keys, same digests.
    // A port that only satisfied `compare_snapshot` could still disagree about
    // which tables belong in the corpus at all.
    let golden = open_golden().expect("the corpus inflates");
    let vault = Vault::open(golden.db_path()).expect("the corpus opens");
    let frozen = &golden.manifest().tables;
    let refrozen = centraid_ontology::snapshot_vault(vault.connection()).expect("snapshot runs");

    let mut findings: Vec<String> = Vec::new();
    for (table, expected) in frozen {
        match refrozen.get(table) {
            None => findings.push(format!(
                "`{table}` is in the manifest and not in the re-freeze"
            )),
            Some(actual) => {
                if actual.columns != expected.columns {
                    findings.push(format!("`{table}`: columns differ"));
                }
                if actual.primary_key != expected.primary_key {
                    findings.push(format!("`{table}`: primary key differs"));
                }
                if actual.rows != expected.rows {
                    findings.push(format!(
                        "`{table}`: {} row(s) frozen, {} now",
                        expected.rows, actual.rows
                    ));
                }
                for (key, digest) in &expected.digests {
                    if actual.digests.get(key) != Some(digest) {
                        findings.push(format!(
                            "`{table}` row `{key}`: digest {digest} frozen, {} now",
                            actual.digests.get(key).map_or("(absent)", String::as_str)
                        ));
                    }
                }
            }
        }
    }
    // Both directions, with ONE declared allowance.
    //
    // `replica_change` is the retired per-app change log: #1014 (R-1014-1)
    // collapsed it into `replica_log` and v0's rung ten DROPs it, so it is
    // present in the PRE-migration corpus (44 rows), absent after v0's ladder
    // runs, and absent from the manifest because the era that froze the file
    // excluded the replica plane's own mechanism from the corpus. Today's
    // `SNAPSHOT_EXCLUSIONS` names only `replica_meta`, because the other name
    // left with the table. This crate migrates nothing yet, so it sees the
    // table; the allowance is declared here, with its reason, rather than
    // added to the library's exclusion list, which must stay a faithful port
    // of what v0 enforces today.
    const CORPUS_ERA_EXCLUSIONS: &[&str] = &["replica_change"];
    for table in refrozen.keys() {
        if !frozen.contains_key(table) && !CORPUS_ERA_EXCLUSIONS.contains(&table.as_str()) {
            findings.push(format!(
                "`{table}` is in the re-freeze and not in the manifest"
            ));
        }
    }
    assert_eq!(findings.join("\n"), "");
}

#[test]
fn the_corpus_holds_together_structurally() {
    let golden = open_golden().expect("the corpus inflates");
    let vault = Vault::open(golden.db_path()).expect("the corpus opens");
    let report = vault_doctor(&vault).expect("the doctor runs");
    assert_eq!(report.integrity, "ok");
    assert_eq!(report.foreign_key_violations.join("\n"), "");
    assert!(format_doctor_report(&report).contains("clean"));
}

#[test]
fn the_snapshot_walk_skips_the_shadow_tables_and_the_replica_singleton() {
    let golden = open_golden().expect("the corpus inflates");
    let vault = Vault::open(golden.db_path()).expect("the corpus opens");
    let walked = snapshot_tables(vault.connection()).expect("the walk runs");
    assert!(!walked.is_empty());
    let findings: Vec<&String> = walked
        .iter()
        .filter(|name| {
            name.starts_with("fts_") || name.starts_with("sqlite_") || *name == "replica_meta"
        })
        .collect();
    assert!(findings.is_empty(), "walked: {findings:?}");
}
