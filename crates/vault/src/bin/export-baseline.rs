//! Render the vault's baseline: the schema and the seeded rows of a vault founded by the ladder
//! this build embeds, as one executable rung.
//!
//! ```sh
//! cargo run -p centraid-vault --bin export-baseline > contracts/migrations/001_baseline.sql
//! ```
//!
//! It takes no argument, as `export-ladder-ddl` takes none: it describes a file it FOUNDS. It
//! founds one the way `Vault::create` does up to the entity-kind registry — foreign keys off,
//! the ladder run from nothing — and reads back its `sqlite_master` and its rows.
//!
//! This is the tool the baseline was squashed with (2026-10-15, Q-1029-1), from the fifteen
//! rungs that preceded it. While `001_baseline.sql` is the whole ladder, this command renders it
//! byte for byte; once a rung is appended it renders the squash of both, which is how a later
//! squash is cut. It is not `centraid-ontology`'s `export-ddl`, and the difference is the point
//! of a second tool: `contracts/schema/vault-ddl.sql` is a *description* — `sqlite_master`
//! ordered by type then name, which puts every index before every table and is unrunnable — and
//! a migration has to be ordered by DEPENDENCY and has to leave out the objects SQLite creates
//! for itself.
//!
//! `tests/baseline.rs` renders the baseline of the current ladder, runs the text on a fresh
//! connection and diffs the schema and every row against a vault founded the ordinary way.

use std::process::ExitCode;

fn main() -> ExitCode {
    match centraid_vault::migrations::render_baseline() {
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
