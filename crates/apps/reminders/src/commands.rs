//! REMINDERS' ACTIONS, as command invocations.
//!
//! Every Reminders action is a thin invocation of ONE typed vault command: the projection lives in
//! the command, not the app. So this module is a table, not logic. Six are `task.*`; the rest are the
//! shared verbs (`entity.*`, `container.*`, `tag.*`, `flag.*`, `edge.*`). An action's input is its
//! command's input, verbatim. [`tests::every_command_this_app_names_is_registered`] checks the table
//! against the vault's own catalogue: a button that mapped a gesture onto a command nobody registered
//! would report success and write nothing.
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5). **A denial is a value, never an `Err`** (#1020 apps
//! seam 10). **Reminders confirms one action**, `purge-task`; the `task.*` commands' own command-level
//! gate is the other gate (census §A0).

use std::collections::BTreeMap;

use serde_json::Value;

/// What a command invocation carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    /// The typed vault command, `<schema>.<name>`.
    pub command: &'static str,
    pub input: BTreeMap<String, Value>,
    /// Which of this handler's calls this is. Mandatory; see the module note.
    pub invoke_key: String,
    /// Whether a failed invocation may leave the rest of the run usable. Reminders has none
    /// — every action here is the member's own gesture.
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
    ///
    /// **`Parked` is one of them**, and that is the whole of the
    /// commitment-restating contract: an agent's reschedule waits for the owner
    /// rather than failing, and the surface says "waiting", not "no".
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

pub use centraid_apps_kit::actions::{ActionRow, Confirm};
use centraid_apps_kit::actions::{act, confirmed};

/// The twenty-one, in the manifest's own order.
pub const ACTIONS: &[ActionRow] = &[
    act("add-task", "task.add"),
    act("edit-task", "task.edit"),
    // AN ACTION SAYS THE STATE IT WANTS (R-1135-3-10): the v0 `set-status` took a
    // status word the caller had not read, and `in-process` is no state of the
    // model. Completing is the one operation Reminders, People and automations share
    // (a repeating task gets its next occurrence); cancelling ends the
    // occurrence with no successor; reopening makes a closed one open.
    act("complete-task", "task.complete"),
    act("reopen-task", "task.reopen"),
    act("cancel-task", "task.cancel"),
    act("organize-task", "task.organize"),
    act("delete-task", "entity.trash"),
    // EMPTYING THE TRASH (#1015 D1), behind the manifest's confirmation.
    confirmed("purge-task", "entity.purge"),
    confirmed("empty-trash", "entity.empty_trash"),
    // RESTORE UNDOES THE DELETE GESTURE (the trash's one verb every app has).
    act("restore-task", "entity.restore"),
    // A project, an area and a section are containers: the shared verb.
    act("create-project", "container.create"),
    // A project or an area is renamed through the shared retitle verb.
    act("rename-list", "entity.retitle"),
    act("create-section", "container.create"),
    // A tag is a `tagged` edge: the shared verbs.
    act("add-task-tag", "tag.add"),
    act("remove-task-tag", "tag.remove"),
    // THE FLAG (#1173): Reminders' name for the vault's starred flag.
    act("star-task", "flag.set"),
    act("unstar-task", "flag.clear"),
    act("style-container", "container.style"),
    // An attachment is an `attached` edge from the task: the shared verbs.
    act("attach", "edge.add"),
    act("detach", "edge.remove"),
    // THE REMINDERS AS A FILE (#1185): the More sheet's Export and a reminder's Share. It writes
    // nothing (`writes_nothing`).
    act("export-ics", "task.export_ics"),
];

/// The row for an action, by name.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    centraid_apps_kit::actions::find(ACTIONS, action)
}

/// The `act` scopes Reminders declares, derived from the action table: one per
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
    fn the_tasks_own_are_the_verbs_the_rest_are_shared_and_no_event_is_touched() {
        assert_eq!(ACTIONS.len(), 21);
        assert!(
            ACTIONS.iter().all(|row| !row.command.starts_with("event.")),
            "Reminders never writes an event"
        );
        let own = |prefix: &str| -> Vec<&str> {
            ACTIONS
                .iter()
                .map(|row| row.command)
                .filter(|command| command.starts_with(prefix))
                .collect()
        };
        assert_eq!(
            own("task."),
            [
                "task.add",
                "task.edit",
                "task.complete",
                "task.reopen",
                "task.cancel",
                "task.organize",
                "task.export_ics"
            ]
        );
        // The shared verbs serve several actions without a wrapper: a project and a section are
        // one `container.create`.
        let creates: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.command == "container.create")
            .map(|row| row.action)
            .collect();
        assert_eq!(creates, ["create-project", "create-section"]);
        assert_eq!(act_scope_tables().len(), 20);
    }

    /// EVERY command this app names is in the vault's own catalogue. **A button
    /// that mapped a gesture onto a command nobody registered would report
    /// success and write nothing**, which is what this exists to prevent.
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

    #[test]
    fn an_invocation_carries_its_key_and_is_never_optional() {
        let invocation = Invocation::new("task.add", "add-task", BTreeMap::new());
        assert_eq!(invocation.invoke_key, "add-task");
        assert!(!invocation.optional);
    }

    #[test]
    fn a_parked_write_is_pending_and_a_denial_is_not() {
        assert!(Outcome::Parked { reason: None }.pending());
        assert!(
            !Outcome::Denied {
                reason: None,
                code: None
            }
            .pending()
        );
        assert!(
            Outcome::Denied {
                reason: None,
                code: None
            }
            .output()
            .is_none()
        );
    }
}

#[cfg(test)]
mod task_tests {
    use super::*;

    /// EVERY INPUT KEY AN ACTION DECLARES IS ONE ITS COMMAND ACCEPTS. The commands are
    /// `additionalProperties: false`, so a key the manifest names and the vault does not is a
    /// write that is refused outright (#1046's audit).
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

    /// THE OTHER DIRECTION, FOR `edit-task`: every key `task.edit` takes is one the app can send,
    /// so an estimate that can be set can be unset.
    #[test]
    fn edit_task_declares_every_key_task_edit_accepts() {
        let registry = centraid_vault::commands::Registry::with_system_commands()
            .expect("the vault's own registry");
        let accepted = registry.get("task.edit").expect("registered").schema();
        let declared = &crate::manifest::manifest()
            .action("edit-task")
            .expect("declared")
            .input;
        for key in accepted["properties"]
            .as_object()
            .expect("properties")
            .keys()
        {
            assert!(
                declared["properties"].get(key).is_some(),
                "`edit-task` does not declare `{key}`"
            );
        }
    }
}
