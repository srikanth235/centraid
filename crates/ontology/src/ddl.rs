//! The DDL fixture: a vault's schema as one text file.
//!
//! `contracts/schema/vault-ddl.sql` is the golden corpus's `sqlite_master`,
//! which is the ONE artefact that says what shape the frozen file actually has.
//! v0's own golden test compares the frozen schema against a vault founded by
//! today's baseline, so drift is caught there; this fixture serves the other
//! direction — a language-neutral statement of the shape that Rust, and any
//! later reader, can diff without a SQLite build and a migration ladder.
//!
//! It is GENERATED. `bin/export-ddl.rs` writes it and `tests/fixtures.rs`
//! regenerates it in memory and diffs, so editing the file by hand is a red
//! test rather than a silent lie.

use crate::error::Result;
use crate::vault::Vault;

/// The header every generated fixture carries, naming the command that made it.
pub const DDL_FIXTURE_HEADER: &str = "\
-- GENERATED — do not edit. The golden corpus's schema, one statement per block.
--
--   cargo run -p centraid-ontology --bin export-ddl -- \\
--     contracts/golden/issue-1020/vault.db.gz > contracts/schema/vault-ddl.sql
--
-- Source: sqlite_master (type, name, tbl_name, sql) where sql is not null,
-- ordered by type then name. `sqlite_stat*` is excluded: it is the planner's
-- own statistics over the corpus rows, so it says how much data a file holds
-- and nothing about its shape. Regenerate in the same slice as any change to
-- the corpus; tests/fixtures.rs diffs this file against the live schema (#1020).
";

/// Render a vault's DDL in the fixture's format.
pub fn ddl_fixture(vault: &Vault) -> Result<String> {
    let mut out = String::from(DDL_FIXTURE_HEADER);
    for object in vault.schema_objects()? {
        out.push_str(&format!(
            "\n-- {} {} on {}\n{};\n",
            object.kind,
            object.name,
            object.table,
            object.sql.trim_end().trim_end_matches(';')
        ));
    }
    Ok(out)
}
