//! Print a vault file's schema in the DDL fixture's format.
//!
//! ```sh
//! cargo run -p centraid-ontology --bin export-ddl -- <vault.db>
//! ```
//!
//! The file is opened as it is, so point it at a COPY: opening a vault writes a
//! `-wal` sidecar and a checkpoint folds that back into the file
//! ([`docs/traps/wal-checkpoint.md`](../../../../docs/traps/wal-checkpoint.md)).

use std::process::ExitCode;

use centraid_ontology::vault::Vault;

fn main() -> ExitCode {
    let Some(target) = std::env::args_os().nth(1) else {
        eprintln!("usage: export-ddl <path to a copy of vault.db>");
        return ExitCode::FAILURE;
    };
    match Vault::open(&target).and_then(|vault| centraid_ontology::ddl_fixture(&vault)) {
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
