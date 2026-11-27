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
        "entity.move",
        "flag.set",
        "tag.add",
        "container.create",
    ] {
        assert!(live.contains(&name), "`{name}` is not registered");
    }
}

/// The groups a command is named under besides an entity kind: the shared verbs' own, the tables
/// a command writes with no kind of their own, and the followed stores.
const GROUPS: [&str; 21] = [
    "alert",
    "blob",
    "budget",
    "checkpoint",
    "concept",
    "container",
    "derivative",
    "edge",
    "entity",
    "flag",
    "follow",
    "health",
    "history",
    "link",
    "locker",
    "measurement",
    "reminder",
    "rule",
    "tag",
    "txn",
    "vault",
];

/// The closed list of verbs. A new verb is a decision of its own: it is added here, in the change
/// that adds the command.
const VERBS: [&str; 98] = [
    "add",
    "add_date",
    "add_guest",
    "add_item",
    "add_note",
    "add_relationship",
    "advance_cursor",
    "apply",
    "asset_add",
    "asset_remove",
    "asset_reorder",
    "calendar",
    "camera_roll",
    "cancel",
    "categorize",
    "clear",
    "collect",
    "color",
    "complete",
    "confirm_match",
    "contacts",
    "counts",
    "create",
    "create_text",
    "delete",
    "dismiss_match",
    "drop",
    "duplicate_item",
    "edit",
    "edit_date",
    "edit_item",
    "edit_occurrence",
    "empty_trash",
    "export",
    "export_all",
    "export_csv",
    "export_ics",
    "export_vcf",
    "export_zip",
    "files",
    "health",
    "health_readings",
    "import",
    "import_csv",
    "import_vcf",
    "keep_version",
    "link_transfer",
    "locate",
    "log",
    "mark_unlock_failed",
    "mark_unlocked",
    "mark_used",
    "merge",
    "move",
    "organize",
    "prefer_contact_point",
    "propose",
    "purge",
    "record",
    "remember_layout",
    "reminders",
    "remove",
    "remove_contact_point",
    "remove_date",
    "remove_field",
    "remove_passkey",
    "rename",
    "reopen",
    "reorder_contact_points",
    "replace",
    "respond",
    "restore",
    "restore_many",
    "restore_version",
    "retitle",
    "save_contact_point",
    "save_turn",
    "set",
    "set_avatar",
    "set_carry",
    "set_cover",
    "set_field",
    "set_opening",
    "set_passkey",
    "set_place",
    "settle_proposal",
    "snooze",
    "split",
    "stage",
    "statement",
    "stop",
    "style",
    "take_stated",
    "totp_code",
    "trash",
    "undo",
    "unlink_transfer",
    "write",
];

#[test]
fn every_command_is_a_kind_or_group_and_a_verb_of_the_closed_list() {
    let registry = Registry::with_system_commands().expect("the registry builds");
    for name in registry.names() {
        let (group, verb) = name
            .split_once('.')
            .unwrap_or_else(|| panic!("`{name}` is not `<kind>.<verb>`"));
        assert!(
            !verb.contains('.') && !name.contains(char::is_whitespace),
            "`{name}` is not `<kind>.<verb>`"
        );
        assert!(
            name.chars()
                .all(|c| c.is_ascii_lowercase() || c == '_' || c == '.'),
            "`{name}` is not lower snake case"
        );
        assert!(
            centraid_vault::model::Kind::parse(group).is_some() || GROUPS.contains(&group),
            "`{name}`: `{group}` is neither a kind nor a group of commands"
        );
        assert!(
            VERBS.contains(&verb),
            "`{name}`: `{verb}` is not on the closed list of verbs"
        );
    }
}
