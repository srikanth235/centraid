//! A vault's schema as one text file: the renderer behind the DDL fixture.
//!
//! `contracts/schema/vault-ddl.sql` is `sqlite_master` of a file this build
//! founded, ordered for reading. `centraid-vault`'s `export-ladder-ddl` writes
//! it and `crates/vault/tests/ladder_ddl.rs` regenerates it in memory and
//! diffs, so editing the file by hand is a red test rather than a silent lie.
//! The renderer lives here, in the crate that owns what a schema object is, so
//! there is one answer to "what does this file look like".

use crate::error::Result;
use crate::vault::Vault;

/// The header `export-ddl` puts on the text it prints for a file it was handed.
pub const DDL_FIXTURE_HEADER: &str = "\
-- GENERATED — do not edit. A vault file's schema, one statement per block.
--
--   cargo run -p centraid-ontology --bin export-ddl -- <vault.db>
--
-- Source: sqlite_master (type, name, tbl_name, sql) where sql is not null,
-- ordered by type then name. `sqlite_stat*` is excluded: it is the planner's
-- own statistics, so it says how much data a file holds and nothing about its
-- shape. What a NEW vault founds is `contracts/schema/vault-ddl.sql`.
";

/// Render a vault's DDL in the fixture's format, under a caller's header.
pub fn render_ddl(vault: &Vault, header: &str) -> Result<String> {
    Ok(render_ddl_objects(&vault.schema_objects()?, header))
}

/// The same, over schema objects read from anywhere.
#[must_use]
pub fn render_ddl_objects(objects: &[crate::vault::SchemaObject], header: &str) -> String {
    let mut out = String::from(header);
    for object in objects {
        out.push_str(&format!(
            "\n-- {} {} on {}\n{};\n",
            object.kind,
            object.name,
            object.table,
            object.sql.trim_end().trim_end_matches(';')
        ));
    }
    out
}

/// Render a file's DDL under the generic header.
pub fn ddl_fixture(vault: &Vault) -> Result<String> {
    render_ddl(vault, DDL_FIXTURE_HEADER)
}
