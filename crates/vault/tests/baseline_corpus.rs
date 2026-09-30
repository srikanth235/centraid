//! THE BASELINE CORPUS, RE-FROZEN FROM RUST (#1020 lane A's suggestion).
//!
//! `centraid_ontology::snapshot_vault` walks the golden corpus and digests
//! every row the way v0's freezer did, so reproducing v0's manifest proves the
//! two read the file the same way.
//!
//! **It is the survivor of `tests/gates.rs`** (#1029 §1). That file held the
//! three applier gates — ORACLE, CONVERGENCE and ATOMICITY — over
//! `contracts/applier/*`. Every one of them was a claim about a SECOND host
//! applying this vault's log: the oracle compared the rows `replica_log`
//! carried against v0's, convergence fed a copy rows S..N and compared the
//! censuses, and atomicity replayed a half-delivered batch. The log plane, the
//! applier and the fixtures are deleted, and none of the three has a subject
//! left. This one never did depend on them.

#[test]
fn freezing_the_baseline_corpus_from_rust_reproduces_v0s_manifest() {
    // Lane A suggested it; it is a test now. `snapshot_vault` walks the corpus
    // and digests every row the way v0's freezer did, so reproducing the
    // manifest proves the two read the file the same way — which is the only
    // claim that makes the Rust side a candidate to replace the oracle.
    let golden = centraid_ontology::golden::open_golden().expect("the corpus inflates");
    let vault = centraid_ontology::Vault::open(golden.db_path()).expect("the corpus opens");
    let refrozen = centraid_ontology::snapshot_vault(vault.connection()).expect("the freeze runs");
    let frozen = &golden.manifest().tables;

    let mut findings: Vec<String> = Vec::new();
    for (table, expected) in frozen {
        match refrozen.get(table) {
            None => findings.push(format!(
                "`{table}` is in the manifest and not in the freeze"
            )),
            Some(actual) => {
                if actual.columns != expected.columns {
                    findings.push(format!("`{table}`: columns differ"));
                }
                if actual.rows != expected.rows {
                    findings.push(format!(
                        "`{table}`: {} row(s) frozen, {} now",
                        expected.rows, actual.rows
                    ));
                }
                for (key, digest) in &expected.digests {
                    if actual.digests.get(key) != Some(digest) {
                        findings.push(format!("`{table}` row `{key}`: digest moved"));
                    }
                }
            }
        }
    }
    for table in refrozen.keys() {
        if !frozen.contains_key(table) {
            findings.push(format!(
                "`{table}` is in the freeze and not in the manifest"
            ));
        }
    }
    assert_eq!(findings.join("\n"), "");
    assert_eq!(frozen.len(), 16, "the corpus's own table count");
}
