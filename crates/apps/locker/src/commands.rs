//! THE SEVENTEEN ACTIONS, as the manifest's table (#1047).
//!
//! Every Locker action is ONE typed vault command: the projection lives in the
//! command, not the app. So this module is a table, not logic — the one
//! `manifest::tests` hold the manifest to. On the phone a shell's machine
//! names the command itself; v0's invocation door (`Invocation`, `Commands`,
//! `Outcome`) had no production caller and is deleted (#1047 T2).
//!
//! `reveal` is not an action at all — it is the core's
//! (`crates/core::locker::phone`), behind the unlock.
//!
//! ## What `export` means (D-1020-L7)
//!
//! The command plane cannot unseal, so `locker.export` answers the plain half
//! plus each row's `key_id` and writes the one receipt a mass reveal owes;
//! producing the plaintext file is the core's, where `K` is.
//!
//! ## Two gates, not one
//!
//! [`Confirm`] here is the **manifest's** `confirmation`, which the dispatching
//! surface reads. The command definition's own `confirm` parks a **non-owner**
//! invocation regardless of risk. Locker's two manifest-confirmed actions are
//! `purge-item` and `export`; the `locker.*` catalogue's two command-level
//! gates are on `locker.purge_item` and `locker.export`. Same count, different
//! gates, and collapsing them loses the non-owner park (census §A0).

/// Whether the **dispatching surface** asks before dispatching.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confirm {
    None,
    Required,
}

/// One row of the action table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionRow {
    pub action: &'static str,
    pub command: &'static str,
    pub confirm: Confirm,
}

const fn act(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::None,
    }
}

const fn confirmed(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::Required,
    }
}

/// THE TABLE. Seventeen actions, seventeen commands, in the manifest's own
/// order. `set-memo` is the seventeenth (#1047): the memo command existed and
/// no action exposed it (the handoff's README §8 paper cut).
pub const ACTIONS: [ActionRow; 17] = [
    act("add-item", "locker.add_item"),
    act("edit-item", "locker.edit_item"),
    act("trash-item", "locker.trash_item"),
    act("restore-item", "locker.restore_item"),
    confirmed("purge-item", "locker.purge_item"),
    act("star-item", "locker.star_item"),
    act("unstar-item", "locker.unstar_item"),
    act("archive-item", "locker.archive_item"),
    act("unarchive-item", "locker.unarchive_item"),
    act("duplicate-item", "locker.duplicate_item"),
    act("set-field", "locker.set_field"),
    act("remove-field", "locker.remove_field"),
    act("set-addresses", "locker.set_addresses"),
    act("set-passkey", "locker.set_passkey"),
    act("clear-passkey", "locker.clear_passkey"),
    act("set-memo", "locker.set_memo"),
    confirmed("export", "locker.export"),
];

/// The row for an action name.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every action names one command, and no command is named twice.
    #[test]
    fn the_table_is_one_command_per_action_and_no_duplicates() {
        assert_eq!(ACTIONS.len(), 17);
        let mut commands: Vec<&str> = ACTIONS.iter().map(|row| row.command).collect();
        commands.sort_unstable();
        let count = commands.len();
        commands.dedup();
        assert_eq!(commands.len(), count, "a command is invoked by two actions");
        for row in ACTIONS {
            assert!(
                row.command.starts_with("locker."),
                "{} invokes {}, which is not a locker.* command — every Locker \
                 action writes through its own schema",
                row.action,
                row.command
            );
        }
    }
}
