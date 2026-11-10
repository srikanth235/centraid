//! CALENDAR'S ACTIONS, as command invocations.
//!
//! Every Calendar action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app. So this module is a
//! table, not logic.
//!
//! **FIVE ARE `event.*`**, the rest are the calendar's own verbs and the shared edge verbs the
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
//! §A0, two gates). **Calendar declares NONE of the first**, including on
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
    /// Whether a failed invocation may leave the rest of the run usable. Calendar has none
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

/// The fourteen, in the manifest's own order.
pub const ACTIONS: &[ActionRow] = &[
    act("propose", "event.propose"),
    act("rsvp", "event.respond"),
    act("edit-event", "event.edit"),
    act("edit-occurrence", "event.edit_occurrence"),
    act("cancel-event", "event.cancel"),
    // An event goes to the trash and comes back through the shared verbs.
    act("trash-event", "entity.trash"),
    act("restore-event", "entity.restore"),
    // An attachment is an `attached` edge from the event: the shared verbs.
    act("attach", "edge.add"),
    act("detach", "edge.remove"),
    // THE PHONE'S CALENDARS, FOLLOWED (#1127): one record per event, the vault merges.
    act("follow-calendar", "follow.calendar"),
    // A CALENDAR OF THE VAULT'S OWN is a container: the shared verb, and the shared colour and
    // icon verb. A calendar is renamed with `entity.retitle`.
    act("create-calendar", "container.create"),
    act("rename-calendar", "entity.retitle"),
    act("style-calendar", "container.style"),
    // A PLACE THE MEMBER TYPED (#1173): an event's location that is not one the vault holds.
    act("add-place", "place.add"),
];

/// The row for an action, by name.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    centraid_apps_kit::actions::find(ACTIONS, action)
}

/// The `act` scopes Calendar declares, derived from the action table: one per
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
    fn the_events_own_are_the_verbs_the_rest_are_shared_and_no_task_is_written() {
        assert_eq!(ACTIONS.len(), 14);
        assert!(
            ACTIONS.iter().all(|row| !row.command.starts_with("task.")),
            "Calendar reads a reminder and never writes one"
        );
        let own = |prefix: &str| -> Vec<&str> {
            ACTIONS
                .iter()
                .map(|row| row.command)
                .filter(|command| command.starts_with(prefix))
                .collect()
        };
        assert_eq!(
            own("event."),
            [
                "event.propose",
                "event.respond",
                "event.edit",
                "event.edit_occurrence",
                "event.cancel"
            ]
        );
        // The shared verbs serve several actions without a wrapper.
        let creates: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.command == "container.create")
            .map(|row| row.action)
            .collect();
        assert_eq!(creates, ["create-calendar"]);
        assert_eq!(act_scope_tables().len(), 14);
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
}
