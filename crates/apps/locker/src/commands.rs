//! THE SEVENTEEN ACTIONS, as command invocations.
//!
//! Every Locker action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app. So this module is a
//! table, not logic.
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

use std::collections::BTreeMap;

use serde_json::Value;

/// What a command invocation carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    /// The typed vault command, `<schema>.<name>`.
    pub command: &'static str,
    pub input: BTreeMap<String, Value>,
    /// Which of this handler's calls this is. **Mandatory** (D-1020-D3-5): v0's
    /// falls back to the call's ordinal, which is stable only for a handler
    /// that makes the same call sequence every time.
    pub invoke_key: String,
    /// "This decorates the answer": a caller settles an optional invocation
    /// that failed as failed, rather than refusing the whole run.
    pub optional: bool,
}

impl Invocation {
    /// One invocation of one command.
    #[must_use]
    pub fn new(command: &'static str, invoke_key: &str) -> Self {
        Self {
            command,
            input: BTreeMap::new(),
            invoke_key: invoke_key.to_owned(),
            optional: false,
        }
    }

    /// One input key.
    #[must_use]
    pub fn with(mut self, key: &str, value: Value) -> Self {
        self.input.insert(key.to_owned(), value);
        self
    }

    /// A decoration: the caller may settle it as failed.
    #[must_use]
    pub const fn optional(mut self) -> Self {
        self.optional = true;
        self
    }
}

/// The six states a vault invocation settles in. `Denied` is one of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Executed {
        output: Value,
    },
    Parked {
        reason: Option<String>,
    },
    Queued,
    InFlight,
    Failed {
        reason: Option<String>,
    },
    Denied {
        reason: Option<String>,
        code: Option<String>,
    },
}

impl Outcome {
    /// The output of an executed command, or `None` for every other state.
    #[must_use]
    pub const fn output(&self) -> Option<&Value> {
        match self {
            Self::Executed { output } => Some(output),
            _ => None,
        }
    }

    /// Whether the surface should show the write as still in flight.
    #[must_use]
    pub const fn pending(&self) -> bool {
        matches!(self, Self::Queued | Self::InFlight | Self::Parked { .. })
    }
}

/// The one door an app writes through.
pub trait Commands {
    fn invoke(&self, invocation: &Invocation) -> Result<Outcome, CommandsUnavailable>;
}

/// The door is not there. Fails closed, and says which command it was.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("the vault door is unavailable; {command} was not attempted")]
pub struct CommandsUnavailable {
    pub command: &'static str,
}

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

    #[test]
    fn an_optional_invocation_says_so_and_a_plain_one_does_not() {
        let plain = Invocation::new("locker.counts", "k0");
        assert!(!plain.optional);
        assert!(Invocation::new("locker.counts", "k0").optional().optional);
    }
}
