//! THE SEVENTEEN ACTIONS, as command invocations.
//!
//! Every Notes action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app. So this module is a table, not
//! logic. A command is either a note's own (`note.*`, four of them) or a shared
//! verb every app uses (`entity.*`, `flag.*`, `tag.*`, `edge.*`, `container.*`):
//! Notes does not wrap a shared verb, so two actions may name one command
//! (`delete-note` and `delete-notebook` are both `entity.trash`; `link`,
//! `attach` and `send-to-tasks`' backlink are all `edge.add`), and an action's
//! input is its command's input, verbatim.
//!
//! **`send-to-tasks` is the one action making TWO invocations**: `task.add`
//! (Agenda's) and then `edge.add` joining the
//! task to the note with an `about` edge, which is conditional on the task having
//! landed.
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5). `send-to-tasks` is exactly why:
//! the backlink is the SECOND invoke on the happy path and no invoke at all when
//! the task did not land, so an ordinal key would name a different call on two
//! different runs of the same action.
//!
//! **`confirmation` is the manifest's and `confirm` is the command's** (census
//! §A0, two gates). Notes' two manifest-confirmed actions are `delete-notebook`
//! and `delete-note`; no command this build carries sets the command-level gate.
//! Collapsing them would put a dialog in front of nothing and drop the non-owner
//! park in exchange.

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
    /// "This decorates the answer": a seat with no gateway settles an optional
    /// invocation as failed rather than refusing the whole run.
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

pub use centraid_apps_kit::actions::{ActionRow, Confirm};
use centraid_apps_kit::actions::{act, confirmed};

/// THE TABLE. Seventeen actions, in the manifest's own order.
pub const ACTIONS: [ActionRow; 17] = [
    act("create-note", "note.create"),
    act("edit-note", "note.edit"),
    act("move-note", "note.move"),
    act("create-notebook", "container.create"),
    act("rename-notebook", "entity.retitle"),
    // THE TWO CONFIRM-GATED ACTIONS.
    confirmed("delete-notebook", "entity.trash"),
    confirmed("delete-note", "entity.trash"),
    act("restore-note", "entity.restore"),
    act("restore-note-version", "note.restore_version"),
    act("flag-note", "flag.set"),
    act("unflag-note", "flag.clear"),
    act("link", "edge.add"),
    // The only action that makes TWO invocations: the task, then the backlink.
    act("send-to-tasks", "task.add"),
    act("attach", "edge.add"),
    act("detach", "edge.remove"),
    act("add-tag", "tag.add"),
    act("remove-tag", "tag.remove"),
];

/// One action's row, by the name the manifest gives it.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    centraid_apps_kit::actions::find(&ACTIONS, action)
}

/// The `act` scopes Notes declares, derived from the action table.
///
/// The manifest spells each as `{schema, table: "<command name without its
/// schema>"}`; deriving it here is what lets the manifest test compare the two
/// lists instead of trusting them. A command two actions share is one scope.
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

/// Build one action's invocation.
///
/// The input is the action's own, verbatim: an action does not reshape a
/// command's input, because the command's schema is the contract and a
/// reshaping app is a second schema.
#[must_use]
pub fn invocation_for(
    action: &str,
    invoke_key: &str,
    input: BTreeMap<String, Value>,
) -> Option<Invocation> {
    action_row(action).map(|row| Invocation::new(row.command, invoke_key, input))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_action_invokes_one_command_and_the_note_verbs_are_the_notes_own() {
        assert_eq!(ACTIONS.len(), 17);
        let note_own: Vec<&str> = ACTIONS
            .iter()
            .map(|row| row.command)
            .filter(|command| command.starts_with("note."))
            .collect();
        assert_eq!(
            note_own,
            [
                "note.create",
                "note.edit",
                "note.move",
                "note.restore_version"
            ],
            "what only a note has; everything else is a shared verb"
        );
        let mut schemas: Vec<&str> = ACTIONS
            .iter()
            .filter_map(|row| row.command.split_once('.').map(|(schema, _)| schema))
            .collect();
        schemas.sort_unstable();
        schemas.dedup();
        assert_eq!(
            schemas,
            ["container", "edge", "entity", "flag", "note", "tag", "task"]
        );
    }

    #[test]
    fn a_shared_verb_serves_two_actions_without_a_wrapper() {
        let trash: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.command == "entity.trash")
            .map(|row| row.action)
            .collect();
        assert_eq!(trash, ["delete-notebook", "delete-note"]);
        let edges: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.command == "edge.add")
            .map(|row| row.action)
            .collect();
        assert_eq!(edges, ["link", "attach"]);
        // One scope per distinct command.
        assert_eq!(act_scope_tables().len(), 15);
    }

    #[test]
    fn the_two_confirmed_actions_are_the_two_deletes() {
        let required: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.confirm == Confirm::Required)
            .map(|row| row.action)
            .collect();
        assert_eq!(required, ["delete-notebook", "delete-note"]);
    }

    /// Every command an action names is one the vault registers: `send-to-tasks`'
    /// `task.add` is Agenda's.
    #[test]
    fn every_action_names_a_command_the_vault_registers() {
        let registry =
            centraid_vault::commands::Registry::with_system_commands().expect("a registry");
        let names = registry.names();
        for row in ACTIONS {
            assert!(
                names.contains(&row.command),
                "{} is not registered",
                row.command
            );
        }
    }

    #[test]
    fn an_invocation_carries_its_key_and_an_unknown_action_has_none() {
        let invocation = invocation_for("create-note", "notes:0", BTreeMap::new())
            .expect("create-note is in the table");
        assert_eq!(invocation.command, "note.create");
        assert_eq!(invocation.invoke_key, "notes:0");
        assert!(!invocation.optional);
        assert!(invocation_for("burn-the-notebook", "notes:1", BTreeMap::new()).is_none());
    }

    /// A DENIAL IS A VALUE, and no state but `Executed` has an output.
    #[test]
    fn a_denial_is_a_state_with_no_output() {
        let denied = Outcome::Denied {
            reason: Some("ask the owner".to_owned()),
            code: Some("VAULT_DENIED".to_owned()),
        };
        assert!(denied.output().is_none());
        assert!(!denied.pending());
        assert!(Outcome::Queued.pending());
        assert!(Outcome::Parked { reason: None }.pending());
        assert_eq!(
            Outcome::Executed {
                output: serde_json::json!({ "id": "n1" })
            }
            .output(),
            Some(&serde_json::json!({ "id": "n1" }))
        );
    }
}
