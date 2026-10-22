//! `contracts/schema/vault-commands.txt` is the registry's own list of command
//! names, and the shell's source scan is held to it (`ShellCommandsExistSpec`).
//!
//! A list nobody regenerates is a lie with a filename, so this re-renders it
//! from the live registry, exactly as `bin/export-commands` does, and diffs.

use centraid_ontology::scratch::repo_root;
use centraid_vault::Registry;

#[test]
fn the_command_list_is_the_registry() {
    let registry = Registry::with_system_commands().expect("the registry builds");
    let live: Vec<&str> = registry.names();
    let fixture = std::fs::read_to_string(repo_root().join("contracts/schema/vault-commands.txt"))
        .expect("the command list is committed");
    let committed: Vec<&str> = fixture.lines().collect();
    assert_eq!(
        committed, live,
        "regenerate with: cargo run -p centraid-vault --bin export-commands \
         > contracts/schema/vault-commands.txt"
    );
    for name in [
        "vault.rename",
        "entity.retitle",
        "note.edit",
        "follow.contacts",
    ] {
        assert!(live.contains(&name), "`{name}` is not registered");
    }
}
