//! THE ELEVEN ACTIONS, as command invocations.
//!
//! Every Tasks action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app. So this module is a table, not
//! logic.
//!
//! **SEVEN OF THE ELEVEN ARE `schedule.*`** — this lane's whole schema — and
//! four are `core.*`: the tag pair (the Docs lane's) and the attachment pair
//! (the Notes lane's). All four are registered, so [`PENDING_COMMANDS`] is
//! **empty** and [`tests::every_command_this_app_names_is_registered`] checks
//! it against the vault's own catalogue. A button that reported success and
//! wrote nothing is what that test exists to prevent.
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5).
//!
//! **A denial is a value, never an `Err`** (#1020 apps seam 10).
//!
//! **`online_only` is empty for Tasks, and that is a checked claim**: `grep -rn
//! ONLINE_ONLY packages/blueprints/apps/tasks` finds none and there is no
//! `writes.ts` in that directory. Filing a task in a tunnel is the point.

use std::collections::BTreeMap;

use serde_json::Value;

/// What a command invocation carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub command: &'static str,
    pub input: BTreeMap<String, Value>,
    /// Which of this handler's calls this is. Mandatory.
    pub invoke_key: String,
    pub optional: bool,
}

impl Invocation {
    /// One invocation of `command`, under `invoke_key`.
    #[must_use]
    pub fn new(command: &'static str, invoke_key: &str, input: BTreeMap<String, Value>) -> Self {
        Self {
            command,
            input,
            invoke_key: invoke_key.to_owned(),
            optional: false,
        }
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
    pub const fn output(&self) -> Option<&Value> {
        match self {
            Self::Executed { output } => Some(output),
            _ => None,
        }
    }

    /// Whether the surface should show the write as still in flight.
    pub const fn pending(&self) -> bool {
        matches!(self, Self::Queued | Self::InFlight | Self::Parked { .. })
    }
}

/// The one door an app writes through.
pub trait Commands {
    /// # Errors
    ///
    /// The door is not there. Fails closed and names the command.
    fn invoke(&self, invocation: &Invocation) -> Result<Outcome, CommandsUnavailable>;
}

/// The door is not there. Fails closed, and says which command it was.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("the vault door is unavailable; {command} was not attempted")]
pub struct CommandsUnavailable {
    pub command: &'static str,
}

/// Whether the **dispatching surface** asks before dispatching. The manifest's
/// `confirmation`, not the command definition's `confirm` — two gates.
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
    pub online_only: bool,
}

const fn act(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::None,
        online_only: false,
    }
}

/// The eleven, in the manifest's own order.
pub const ACTIONS: &[ActionRow] = &[
    act("add", "schedule.add_task"),
    act("set-status", "schedule.set_task_status"),
    act("delete", "schedule.delete_task"),
    act("edit", "schedule.edit_task"),
    act("save-project", "schedule.save_project"),
    act("save-section", "schedule.save_section"),
    act("organize-task", "schedule.organize_task"),
    act("attach", "core.attach"),
    act("detach", "core.detach"),
    act("add-tag", "core.tag_item"),
    act("remove-tag", "core.untag_item"),
];

/// The commands this app names that the vault does not register yet.
///
/// **EMPTY.** It held the attachment pair — the Notes lane's half of `core.*`
/// — and they came off when that lane registered them.
pub const PENDING_COMMANDS: [&str; 0] = [];

/// The row for an action, by name.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

/// The `act` scope tables the manifest declares, sorted.
#[must_use]
pub fn act_scope_tables() -> Vec<&'static str> {
    let mut tables: Vec<&'static str> = vec![
        "add_task",
        "set_task_status",
        "edit_task",
        "save_project",
        "save_section",
        "organize_task",
        "delete_task",
        "attach",
        "detach",
        "tag_item",
        "untag_item",
    ];
    tables.sort_unstable();
    tables
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_action_names_one_command_and_no_two_name_the_same() {
        let mut commands: Vec<&str> = ACTIONS.iter().map(|row| row.command).collect();
        commands.sort_unstable();
        let unique = {
            let mut copy = commands.clone();
            copy.dedup();
            copy
        };
        assert_eq!(commands, unique, "one command per action");
        assert_eq!(ACTIONS.len(), 11);
    }

    #[test]
    fn seven_of_the_eleven_are_the_schedule_schema() {
        assert_eq!(
            ACTIONS
                .iter()
                .filter(|row| row.command.starts_with("schedule."))
                .count(),
            7
        );
        assert_eq!(
            ACTIONS
                .iter()
                .filter(|row| row.command.starts_with("core."))
                .count(),
            4
        );
    }

    /// EVERY command this app names is either in the vault's own catalogue or
    /// on [`PENDING_COMMANDS`]. The tag pair landed with Docs, the attachment
    /// pair with Notes, and `schedule.*` is this lane's own.
    #[test]
    fn every_command_this_app_names_is_registered() {
        let registry = centraid_vault::commands::Registry::with_system_commands()
            .expect("the vault's own registry");
        for row in ACTIONS {
            let known = registry.get(row.command).is_some();
            let pending = PENDING_COMMANDS.contains(&row.command);
            assert!(
                known != pending,
                "`{}` is {}registered and {}on the pending list",
                row.command,
                if known { "" } else { "not " },
                if pending { "" } else { "not " }
            );
        }
        assert!(PENDING_COMMANDS.is_empty(), "nothing is owed to this app");
    }

    #[test]
    fn no_action_is_online_only_because_filing_in_a_tunnel_is_the_point() {
        assert!(ACTIONS.iter().all(|row| !row.online_only));
    }
}
