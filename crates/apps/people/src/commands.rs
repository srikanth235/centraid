//! THE TWENTY-FIVE ACTIONS, as command invocations.
//!
//! Every People action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app, so this module is a table, not
//! logic. A command is either a person's own (`person.*`, eleven of them) or a
//! shared verb every app uses (`entity.*`, `flag.*`, `container.*`): People
//! wraps no shared verb, so two actions may name one command (`trash-person`
//! and `delete-list` are both `entity.trash`; `edit-person` and `set-cadence`
//! are both `person.edit`), and an action's input is its command's input,
//! verbatim.
//!
//! **Three commands are Agenda's**, which owns events and tasks:
//! `task.complete` and `task.reopen` (a follow-up or a gift idea is a task, and
//! completing one is the operation Tasks and automations share, so a repeating
//! task gets its next occurrence) and `event.edit` (a date's reminder is its
//! event's). [`ActionRow::pending_schema`] names them until that lane lands.
//!
//! **An action says the state it wants.** The v0 actions `toggle-gift` and
//! `toggle-reminder` flipped a state the caller had not read; a gift is a task,
//! so `complete-task` and `reopen-task` are its two states, and a reminder is
//! set (`set-reminder`), not toggled.
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5): the ordinal a v0 handler falls
//! back to is stable only for a handler that makes the same call sequence every
//! time.
//!
//! **`confirmation` is the manifest's and `confirm` is the command's** (census
//! §A0, two gates). People's manifest-confirmed actions are `trash-person`,
//! `purge-person`, `delete-contact-channel` and `merge-people`; no command this
//! build carries sets the command-level gate. Collapsing them would put a
//! dialog in front of nothing and drop the non-owner park in exchange.

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

/// Whether the **dispatching surface** asks before dispatching. This is the
/// manifest's `confirmation`, not the command definition's `confirm`.
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
    /// The schema whose commands are not in this build yet, when there is one
    /// (Agenda's lane: `task`, `event`).
    pub pending_schema: Option<&'static str>,
}

const fn act(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::None,
        pending_schema: None,
    }
}

const fn confirmed(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::Required,
        pending_schema: None,
    }
}

/// THE TABLE. Twenty-five actions, in the manifest's own order.
pub const ACTIONS: [ActionRow; 25] = [
    act("add-person", "person.add"),
    act("edit-person", "person.edit"),
    act("set-cadence", "person.edit"),
    confirmed("trash-person", "entity.trash"),
    act("restore-person", "entity.restore"),
    confirmed("purge-person", "entity.purge"),
    act("log-interaction", "person.log_interaction"),
    act("star-person", "flag.set"),
    act("unstar-person", "flag.clear"),
    act("move-person", "person.move"),
    act("add-note", "person.add_note"),
    act("add-task", "person.add_task"),
    ActionRow {
        action: "complete-task",
        command: "task.complete",
        confirm: Confirm::None,
        pending_schema: Some("task"),
    },
    ActionRow {
        action: "reopen-task",
        command: "task.reopen",
        confirm: Confirm::None,
        pending_schema: Some("task"),
    },
    act("add-important-date", "person.add_date"),
    ActionRow {
        action: "set-reminder",
        command: "event.edit",
        confirm: Confirm::None,
        pending_schema: Some("event"),
    },
    act("add-relationship", "person.add_relationship"),
    act("add-gift", "person.add_gift"),
    act("create-list", "container.create"),
    act("rename-list", "entity.retitle"),
    act("delete-list", "entity.trash"),
    act("add-journal-entry", "person.add_journal_entry"),
    act("save-contact-channel", "person.save_contact_point"),
    confirmed("delete-contact-channel", "person.remove_contact_point"),
    confirmed("merge-people", "person.merge"),
];

/// One action's row, by the name the manifest gives it.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

/// The `act` scopes People declares, derived from the action table.
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

/// The commands People owes another lane, by schema. Empty means nothing is
/// pending.
#[must_use]
pub fn pending_commands() -> Vec<(&'static str, &'static str)> {
    ACTIONS
        .iter()
        .filter_map(|row| row.pending_schema.map(|schema| (schema, row.command)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commands(prefix: &str) -> Vec<&'static str> {
        let mut found: Vec<&str> = ACTIONS
            .iter()
            .map(|row| row.command)
            .filter(|command| command.starts_with(prefix))
            .collect();
        found.sort_unstable();
        found.dedup();
        found
    }

    #[test]
    fn every_action_invokes_one_command_and_the_person_verbs_are_the_persons_own() {
        assert_eq!(ACTIONS.len(), 25);
        assert_eq!(
            commands("person."),
            [
                "person.add",
                "person.add_date",
                "person.add_gift",
                "person.add_journal_entry",
                "person.add_note",
                "person.add_relationship",
                "person.add_task",
                "person.edit",
                "person.log_interaction",
                "person.merge",
                "person.move",
                "person.remove_contact_point",
                "person.save_contact_point",
            ],
            "what only a person has; everything else is a shared verb"
        );
    }

    #[test]
    fn a_shared_verb_serves_several_actions_without_a_wrapper() {
        let by = |command: &str| -> Vec<&str> {
            ACTIONS
                .iter()
                .filter(|row| row.command == command)
                .map(|row| row.action)
                .collect()
        };
        assert_eq!(by("entity.trash"), ["trash-person", "delete-list"]);
        assert_eq!(by("person.edit"), ["edit-person", "set-cadence"]);
        assert_eq!(by("flag.set"), ["star-person"]);
    }

    #[test]
    fn the_four_confirmed_actions_are_the_destructive_ones() {
        let required: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.confirm == Confirm::Required)
            .map(|row| row.action)
            .collect();
        assert_eq!(
            required,
            [
                "trash-person",
                "purge-person",
                "delete-contact-channel",
                "merge-people"
            ]
        );
    }

    /// Agenda's lane owes these three; the list shrinks by being wrong, and this
    /// is what says so.
    #[test]
    fn the_commands_owed_are_agendas() {
        assert_eq!(
            pending_commands(),
            [
                ("task", "task.complete"),
                ("task", "task.reopen"),
                ("event", "event.edit")
            ]
        );
    }

    #[test]
    fn an_invocation_carries_its_key_and_an_unknown_action_has_none() {
        let invocation = invocation_for("add-person", "people:0", BTreeMap::new())
            .expect("add-person is in the table");
        assert_eq!(invocation.command, "person.add");
        assert_eq!(invocation.invoke_key, "people:0");
        assert!(!invocation.optional);
        assert!(invocation_for("toggle-gift", "people:1", BTreeMap::new()).is_none());
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
                output: serde_json::json!({ "id": "p1" })
            }
            .output(),
            Some(&serde_json::json!({ "id": "p1" }))
        );
    }
}
