//! The `contracts/` fixtures are GENERATED, and this is what keeps them true.
//!
//! A fixture nobody regenerates is a lie with a filename. Each test here
//! reproduces one fixture from its source and diffs, so drift is red in the
//! same run as the checkpoint rather than at the next person's expense.

use std::path::Path;

use centraid_ontology::golden::{
    GOLDEN_LABEL, GOLDEN_LABEL_CHECKPOINT, contracts_golden_dir_for, open_golden, read_manifest,
    repo_root,
};
use centraid_ontology::{Vault, ddl_fixture};

/// The first differing line of two texts, as a message a reviewer can act on.
fn first_difference(expected: &str, actual: &str) -> Option<String> {
    let mut expected_lines = expected.lines().enumerate();
    let mut actual_lines = actual.lines();
    loop {
        match (expected_lines.next(), actual_lines.next()) {
            (None, None) => return None,
            (Some((index, left)), Some(right)) if left != right => {
                return Some(format!(
                    "line {}:\n  fixture: {left}\n  live:    {right}",
                    index + 1
                ));
            }
            (Some((index, left)), None) => {
                return Some(format!(
                    "the fixture has {} extra line(s), first: {left}",
                    { expected.lines().count() - index }
                ));
            }
            (None, Some(right)) => {
                return Some(format!("the live schema has extra line(s), first: {right}"));
            }
            (Some(_), Some(_)) => {}
        }
    }
}

#[test]
fn the_ddl_fixture_still_describes_the_corpus() {
    let golden = open_golden().expect("the corpus inflates");
    let vault = Vault::open(golden.db_path()).expect("the corpus opens");
    let live = ddl_fixture(&vault).expect("the DDL renders");
    let fixture = std::fs::read_to_string(repo_root().join("contracts/schema/vault-ddl.sql"))
        .expect("the DDL fixture is committed");
    assert_eq!(
        first_difference(&fixture, &live),
        None,
        "regenerate with: cargo run -p centraid-ontology --bin export-ddl -- \
         contracts/golden/issue-1020/vault.db.gz > contracts/schema/vault-ddl.sql"
    );
}

#[test]
fn the_ddl_fixture_is_not_vacuous() {
    // A fixture that rendered to its header alone would compare equal to a
    // vault with no schema, which is the one way this gate could pass for free.
    let fixture = std::fs::read_to_string(repo_root().join("contracts/schema/vault-ddl.sql"))
        .expect("the DDL fixture is committed");
    let statements = fixture.matches("\nCREATE ").count();
    assert!(
        statements > 500,
        "only {statements} statements in the fixture"
    );
    assert!(fixture.contains("CREATE TABLE core_party"));
    assert!(fixture.contains("CREATE VIRTUAL TABLE fts_knowledge_note"));
}

#[test]
fn the_registry_fixture_is_where_the_crate_embeds_it() {
    // `registries.rs` embeds the fixture with `include_str!`, so a moved or
    // renamed file is a compile error rather than a runtime surprise. This test
    // only pins the path the README tells a regenerator to write.
    let path = repo_root().join("contracts/schema/v0-registries.json");
    assert!(Path::new(&path).exists(), "{} is missing", path.display());
    let registries = centraid_ontology::registries::v0_registries();
    assert_eq!(
        registries.ontology_version,
        centraid_ontology::ONTOLOGY_VERSION
    );
    // The two version keys are the ends of the accepted window (#1020,
    // D-1020-A1), and since D-1020-D1-1 there is a real corpus AT EACH END:
    // the #929 checkpoint at the low end, the v1 baseline at the ladder head.
    let checkpoint =
        read_manifest(&contracts_golden_dir_for(GOLDEN_LABEL_CHECKPOINT)).expect("it parses");
    let baseline = read_manifest(&contracts_golden_dir_for(GOLDEN_LABEL)).expect("it parses");
    assert_eq!(registries.user_version, checkpoint.user_version);
    assert_eq!(registries.ladder_user_version, baseline.user_version);
    assert!(
        registries.ladder_user_version > registries.user_version,
        "the ladder head is {} and the checkpoint is at {}",
        registries.ladder_user_version,
        registries.user_version
    );
}
