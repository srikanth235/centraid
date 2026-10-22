//! Render the names of the commands this build registers, one per line, as the
//! `contracts/schema` fixture.
//!
//! ```sh
//! cargo run -p centraid-vault --bin export-commands \
//!   > contracts/schema/vault-commands.txt
//! ```
//!
//! The shell's `ShellCommandsExistSpec` cannot link Rust, so it reads the
//! registry's source; this list is the registry itself, and that spec holds its
//! scan to it. `tests/command_list.rs` diffs it against the live registry, so a
//! command added without regenerating it is red here and a scan that misses one
//! is red there.

use std::process::ExitCode;

use centraid_vault::Registry;

fn main() -> ExitCode {
    match Registry::with_system_commands() {
        Ok(registry) => {
            for name in registry.names() {
                println!("{name}");
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("export-commands: {error}");
            ExitCode::FAILURE
        }
    }
}
