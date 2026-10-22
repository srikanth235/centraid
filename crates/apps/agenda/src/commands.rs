//! THE SEVEN ACTIONS, as command invocations.
//!
//! Every Agenda action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app. So this module is a
//! table, not logic.
//!
//! **FIVE OF THE SEVEN ARE `event.*`** and two are the shared edge verbs the
//! attachment pair is everywhere (`edge.add`, `edge.remove`: an attachment is an
//! `attached` edge from the event to a document or a photo). An action's input
//! is its command's input, verbatim. [`tests::every_command_this_app_names_is_registered`]
//! checks the table against the vault's own catalogue rather than against a
//! list. **A button that mapped a gesture onto a command nobody registered would
//! report success and write nothing**, which is what that test exists to
//! prevent.
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5); v0's falls back to the call's
//! ordinal, which is stable only for a handler that makes the same call
//! sequence every time.
//!
//! **A denial is a value, never an `Err`** (#1020 apps seam 10).
//!
//! **`confirmation` is the manifest's and `confirm` is the command's** (census
//! §A0, two gates). **Agenda declares NONE of the first**, including on
//! `cancel-event`, and the port reproduces that faithfully; the
//! `event.*` commands that restate a commitment (`edit`, `cancel`,
//! `edit_occurrence`) park a non-owner invocation are the OTHER gate,
//! and collapsing them would put a dialog in front of nothing and drop the park
//! in exchange (D-1020-S6, a finding for the owner).

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
    /// invocation as failed rather than refusing the whole run. Agenda has none
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

use centraid_apps_kit::actions::act;
pub use centraid_apps_kit::actions::{ActionRow, Confirm};

/// The seven, in the manifest's own order.
pub const ACTIONS: &[ActionRow] = &[
    act("propose", "event.propose"),
    act("rsvp", "event.respond"),
    act("edit-event", "event.edit"),
    act("edit-occurrence", "event.edit_occurrence"),
    act("cancel-event", "event.cancel"),
    act("attach", "edge.add"),
    act("detach", "edge.remove"),
];

/// The row for an action, by name.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    centraid_apps_kit::actions::find(&ACTIONS, action)
}

/// The `act` scopes Agenda declares, derived from the action table: one per
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
    fn five_of_the_seven_are_the_events_own_and_two_are_the_shared_edge_verbs() {
        assert_eq!(ACTIONS.len(), 7);
        let own: Vec<&str> = ACTIONS
            .iter()
            .map(|row| row.command)
            .filter(|command| command.starts_with("event."))
            .collect();
        assert_eq!(
            own,
            [
                "event.propose",
                "event.respond",
                "event.edit",
                "event.edit_occurrence",
                "event.cancel"
            ]
        );
        // An attachment is an `attached` edge: the shared verbs, not a wrapper.
        assert_eq!(act_scope_tables().len(), 7);
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
        let invocation = Invocation::new("event.propose", "propose", BTreeMap::new());
        assert_eq!(invocation.invoke_key, "propose");
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
