//! Render the schema A NEW VAULT GETS, as the `contracts/schema` fixture.
//!
//! ```sh
//! cargo run -p centraid-vault --bin export-ladder-ddl \
//!   > contracts/schema/vault-ddl.sql
//! ```
//!
//! It takes no argument, and that is the whole difference from
//! `centraid-ontology`'s `export-ddl`. `export-ddl` describes a FILE it is
//! handed — the frozen v0 corpus, whose description lives beside it at
//! `contracts/golden/issue-1020/vault-ddl.sql`. This one describes a file it
//! FOUNDS, from the ladder this binary embeds, so the fixture moves when a rung
//! moves and nothing else can make it move (#1029, the owner's ruling of
//! 2026-09-21).
//!
//! `tests/ladder_ddl.rs` re-renders the same text in memory and diffs, so a
//! stale fixture is red rather than decorative.

use std::process::ExitCode;

fn main() -> ExitCode {
    match centraid_vault::migrations::render_ladder_ddl() {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("export-ladder-ddl: {error}");
            ExitCode::FAILURE
        }
    }
}
