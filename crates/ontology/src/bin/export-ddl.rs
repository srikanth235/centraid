//! Export a vault's `sqlite_master` DDL as the `contracts/schema` fixture.
//!
//! The fixture is a REGENERATED file, never a hand-edited one:
//!
//! ```sh
//! cargo run -p centraid-ontology --bin export-ddl -- \
//!   contracts/golden/issue-1020/vault.db.gz > contracts/schema/vault-ddl.sql
//! ```
//!
//! The argument may be a `.gz` (inflated into a scratch directory first, never
//! opened in place — see `docs/traps/wal-checkpoint.md`) or a plain `vault.db`.
//! `tests/fixtures.rs` regenerates the same text in memory and diffs it, so a
//! stale fixture is red rather than decorative.

use std::path::PathBuf;
use std::process::ExitCode;

use centraid_ontology::golden::{inflate, scratch_dir};
use centraid_ontology::vault::Vault;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(target) = args.next() else {
        eprintln!(
            "usage: export-ddl <path to vault.db or vault.db.gz>\n\
             writes the file's sqlite_master DDL to stdout"
        );
        return ExitCode::FAILURE;
    };
    let path = PathBuf::from(target);
    match render(&path) {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("export-ddl: {error}");
            ExitCode::FAILURE
        }
    }
}

fn render(path: &std::path::Path) -> centraid_ontology::Result<String> {
    if path.extension().is_none_or(|ext| ext != "gz") {
        return centraid_ontology::ddl_fixture(&Vault::open(path)?);
    }
    // Never open the committed file in place: opening a vault writes a `-wal`
    // sidecar beside it and a checkpoint folds that back into the file itself.
    let dir = scratch_dir();
    let db = inflate(path, &dir)?;
    let rendered = centraid_ontology::ddl_fixture(&Vault::open(&db)?);
    let _ = std::fs::remove_dir_all(&dir);
    rendered
}
