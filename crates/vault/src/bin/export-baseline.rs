//! Render the baseline corpus's schema as an EXECUTABLE migration.
//!
//! ```sh
//! cargo run -p centraid-vault --bin export-baseline -- \
//!   contracts/golden/issue-1020/vault.db.gz > contracts/migrations/001_baseline.sql
//! ```
//!
//! This is not `centraid-ontology`'s `export-ddl`, and the difference is the
//! whole point of a second tool. `contracts/schema/vault-ddl.sql` is a
//! *description*: `sqlite_master` ordered by type then name, which puts every
//! index before every table and is therefore unrunnable. A migration has to be
//! ordered by DEPENDENCY — tables, then views, then indexes, then triggers —
//! and has to leave out the objects SQLite creates for itself.
//!
//! `tests/baseline.rs` founds a vault from the output and diffs its schema
//! against the corpus's, so a stale or mis-ordered baseline is red.

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(target) = args.next() else {
        eprintln!(
            "usage: export-baseline <path to vault.db or vault.db.gz>\n\
             writes an executable baseline migration to stdout"
        );
        return ExitCode::FAILURE;
    };
    let path = std::path::PathBuf::from(target);
    match centraid_vault::migrations::render_baseline(&path) {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("export-baseline: {error}");
            ExitCode::FAILURE
        }
    }
}
