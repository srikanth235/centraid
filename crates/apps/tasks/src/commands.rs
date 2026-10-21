//! THE FIFTEEN ACTIONS, as command invocations.
//!
//! Every Tasks action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app. So this module is a table, not
//! logic.
//!
//! **SIX OF THE FIFTEEN ARE `task.*`**, the task's own verbs; the rest are the
//! shared verbs every app uses (`entity.*`, `container.create`, `edge.*`,
//! `tag.*`). An action's input is its command's input, verbatim, and
//! [`tests::every_command_this_app_names_is_registered`] checks the table
//! against the vault's own catalogue. A button that reported success and wrote
//! nothing is what that test exists to prevent.
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5).
//!
//! **A denial is a value, never an `Err`** (#1020 apps seam 10).

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
}

const fn act(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::None,
    }
}

/// The thirteen, in the manifest's own order.
pub const ACTIONS: &[ActionRow] = &[
    act("add", "task.add"),
    act("edit", "task.edit"),
    // AN ACTION SAYS THE STATE IT WANTS (R-1135-3-10): the v0 `set-status` took a
    // status word the caller had not read, and `in-process` is no state of the
    // model. Completing is the one operation Tasks, People and automations share
    // (a repeating task gets its next occurrence); cancelling ends the
    // occurrence with no successor; reopening makes a closed one open.
    act("complete", "task.complete"),
    act("reopen", "task.reopen"),
    act("cancel", "task.cancel"),
    act("organize-task", "task.organize"),
    act("delete", "entity.trash"),
    // EMPTYING THE TRASH (#1015 D1), behind the manifest's confirmation.
    ActionRow {
        confirm: Confirm::Required,
        ..act("purge", "entity.purge")
    },
    // RESTORE UNDOES THE DELETE GESTURE (the trash's one verb every app has).
    act("restore", "entity.restore"),
    // A project, an area and a section are containers: the shared verb.
    act("create-project", "container.create"),
    act("create-section", "container.create"),
    // An attachment is an `attached` edge, a tag a `tagged` one: the shared verbs.
    act("attach", "edge.add"),
    act("detach", "edge.remove"),
    act("add-tag", "tag.add"),
    act("remove-tag", "tag.remove"),
];

/// The row for an action, by name.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

/// The `act` scopes Tasks declares, derived from the action table: one per
/// distinct command, as `(schema, name)`.
#[must_use]
pub fn act_scope_tables() -> Vec<(&'static str, &'static str)> {
    let mut scopes: Vec<(&'static str, &'static str)> = ACTIONS
        .iter()
        .map(|row| {
            row.command
                .split_once('.')
                .map_or((row.command, row.command), |(schema, name)| (schema, name))
        })
        .collect();
    scopes.sort_unstable();
    scopes.dedup();
    scopes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_action_names_one_command_and_the_task_verbs_are_the_tasks_own() {
        assert_eq!(ACTIONS.len(), 15);
        let own: Vec<&str> = ACTIONS
            .iter()
            .map(|row| row.command)
            .filter(|command| command.starts_with("task."))
            .collect();
        assert_eq!(
            own,
            [
                "task.add",
                "task.edit",
                "task.complete",
                "task.reopen",
                "task.cancel",
                "task.organize"
            ]
        );
        // The shared verbs serve two actions without a wrapper: a project and a
        // section are one `container.create`.
        let creates: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.command == "container.create")
            .map(|row| row.action)
            .collect();
        assert_eq!(creates, ["create-project", "create-section"]);
        assert_eq!(act_scope_tables().len(), 14);
    }

    /// EVERY command this app names is in the vault's own catalogue. A button
    /// that reported success and wrote nothing is what this exists to prevent.
    #[test]
    fn every_command_this_app_names_is_registered() {
        let registry = centraid_vault::commands::Registry::with_system_commands()
            .expect("the vault's own registry");
        for row in ACTIONS {
            assert!(
                registry.get(row.command).is_some(),
                "`{}` is not registered",
                row.command
            );
        }
    }

    /// EVERY INPUT KEY AN ACTION DECLARES IS ONE ITS COMMAND ACCEPTS. The
    /// commands are `additionalProperties: false`, so a key the manifest names
    /// and the vault does not is a write that is refused outright
    /// (#1046's audit).
    #[test]
    fn every_declared_input_key_is_one_the_command_accepts() {
        let registry = centraid_vault::commands::Registry::with_system_commands()
            .expect("the vault's own registry");
        for row in ACTIONS {
            let declared = crate::manifest::manifest()
                .action(row.action)
                .expect("the manifest declares it");
            let accepted = registry
                .get(row.command)
                .expect("registered")
                .schema()
                .get("properties")
                .and_then(serde_json::Value::as_object)
                .expect("a command schema has properties");
            for key in declared
                .input
                .get("properties")
                .and_then(serde_json::Value::as_object)
                .into_iter()
                .flat_map(serde_json::Map::keys)
            {
                assert!(
                    accepted.contains_key(key),
                    "`{}` declares `{key}` and `{}` does not accept it",
                    row.action,
                    row.command
                );
            }
        }
    }

    /// THE OTHER DIRECTION, FOR `edit`: every key `task.edit` takes is one the
    /// app can send, so an estimate that can be set can be unset.
    #[test]
    fn edit_declares_every_key_task_edit_accepts() {
        let registry = centraid_vault::commands::Registry::with_system_commands()
            .expect("the vault's own registry");
        let accepted = registry.get("task.edit").expect("registered").schema();
        let declared = &crate::manifest::manifest()
            .action("edit")
            .expect("declared")
            .input;
        for key in accepted["properties"]
            .as_object()
            .expect("properties")
            .keys()
        {
            assert!(
                declared["properties"].get(key).is_some(),
                "`edit` does not declare `{key}`"
            );
        }
    }
}
