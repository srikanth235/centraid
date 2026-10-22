//! THE NINETEEN ACTIONS, as the manifest's table (#1047, #1135).
//!
//! Every Locker action is ONE typed vault command: the projection lives in the
//! command, not the app. So this module is a table, not logic — the one
//! `manifest::tests` hold the manifest to. A command is either Locker's own
//! (`locker.*`: what involves a secret or Locker's structure) or a shared verb
//! every app uses (`entity.*`, `flag.*`, `tag.*`): a Locker item is an entity,
//! so its trash, its star, its archive and its tags are the vault's, and two
//! actions may name one command (`star-item` and `archive-item` are both
//! `flag.set`). On the phone a shell's machine names the command itself;
//! v0's invocation door (`Invocation`, `Commands`, `Outcome`) had no production
//! caller and is deleted (#1047 T2).
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

/// THE TABLE. Nineteen actions, in the manifest's own order. `set-memo` is the
/// seventeenth of v0's (#1047): the memo command existed and no action exposed
/// it (the handoff's README §8 paper cut). The seven lifecycle actions and the
/// two tag actions are the vault's shared verbs (#1135).
pub const ACTIONS: [ActionRow; 19] = [
    act("add-item", "locker.add_item"),
    act("edit-item", "locker.edit_item"),
    act("trash-item", "entity.trash"),
    act("restore-item", "entity.restore"),
    confirmed("purge-item", "entity.purge"),
    act("star-item", "flag.set"),
    act("unstar-item", "flag.clear"),
    act("archive-item", "flag.set"),
    act("unarchive-item", "flag.clear"),
    act("add-tag", "tag.add"),
    act("remove-tag", "tag.remove"),
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

    /// Every action names one command; a command Locker owns is named once,
    /// and the rest are the vault's shared verbs, which several actions may
    /// share.
    #[test]
    fn the_table_is_one_command_per_action_and_locker_wraps_no_shared_verb() {
        assert_eq!(ACTIONS.len(), 19);
        let own: Vec<&str> = ACTIONS
            .iter()
            .map(|row| row.command)
            .filter(|command| command.starts_with("locker."))
            .collect();
        let mut deduped = own.clone();
        deduped.sort_unstable();
        deduped.dedup();
        assert_eq!(
            deduped.len(),
            own.len(),
            "a Locker command is invoked twice"
        );
        assert_eq!(own.len(), 10, "what only Locker has; the rest is shared");
        for row in ACTIONS
            .iter()
            .filter(|row| !row.command.starts_with("locker."))
        {
            assert!(
                ["entity.", "flag.", "tag."]
                    .iter()
                    .any(|schema| row.command.starts_with(schema)),
                "{} invokes {}, which is neither Locker's nor a shared verb",
                row.action,
                row.command
            );
        }
        // The duplicates the vault now spells once are not spelled again.
        for gone in [
            "trash_item",
            "restore_item",
            "purge_item",
            "star_item",
            "archive_item",
        ] {
            assert!(
                !ACTIONS
                    .iter()
                    .any(|row| row.command == format!("locker.{gone}"))
            );
        }
    }
}
