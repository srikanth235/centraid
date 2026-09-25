//! The DDL fixture: a vault's schema as one text file.
//!
//! `contracts/golden/issue-1020/vault-ddl.sql` is the golden corpus's
//! `sqlite_master`, which is the ONE artefact that says what shape the frozen
//! file actually has. It lives **beside the corpus it describes**, because that
//! is what it is a description of: a historical v0 file, not the shape a new
//! vault founds (#1029, the owner's ruling of 2026-09-21). What a new vault
//! founds is `contracts/schema/vault-ddl.sql`, rendered from the ladder head by
//! `centraid-vault`'s own `export-ladder-ddl` — a separate fixture with a
//! separate drift check, because the two answer different questions and the
//! ladder is allowed to move away from the corpus.
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
--     contracts/golden/issue-1020/vault.db.gz \\
--     > contracts/golden/issue-1020/vault-ddl.sql
--
-- THE CORPUS'S OWN DESCRIPTION, beside the corpus. What a NEW vault founds is
-- `contracts/schema/vault-ddl.sql`, rendered from the ladder head by
-- `cargo run -p centraid-vault --bin export-ladder-ddl` (#1029).
--
-- Source: sqlite_master (type, name, tbl_name, sql) where sql is not null,
-- ordered by type then name. `sqlite_stat*` is excluded: it is the planner's
-- own statistics over the corpus rows, so it says how much data a file holds
-- and nothing about its shape. Regenerate in the same slice as any change to
-- the corpus; tests/fixtures.rs diffs this file against the live schema (#1020).
";

/// Render a vault's DDL in the fixture's format, under a caller's header.
///
/// The header is an argument because there are two fixtures in this format and
/// exactly one difference between them: which file, and which command, the text
/// names. A shared renderer with two headers is one answer to "what does this
/// file look like"; two renderers would be two.
pub fn render_ddl(vault: &Vault, header: &str) -> Result<String> {
    Ok(render_ddl_objects(&vault.schema_objects()?, header))
}

/// The same, over schema objects read from anywhere.
///
/// The ladder-head fixture is rendered from a file this build just founded,
/// which [`Vault`] will not open (its `user_version` is on v1's axis, not the
/// v0 window this crate accepts), so the renderer takes the objects rather
/// than the opener.
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

/// Render the corpus's DDL fixture.
pub fn ddl_fixture(vault: &Vault) -> Result<String> {
    render_ddl(vault, DDL_FIXTURE_HEADER)
}
