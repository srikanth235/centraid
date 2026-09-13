//! THE SEVEN ACTIONS, as command invocations.
//!
//! Every Agenda action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app
//! (`packages/blueprints/apps/_shared/action-kit.ts`). So this module is a
//! table, not logic.
//!
//! **FIVE OF THE SEVEN ARE `schedule.*`** and two are `core.*` — the attachment
//! pair every record app shares (census §A6). `schedule.*` is this lane's whole
//! schema; `core.attach` and `core.detach` are the Notes lane's, so they are
//! named here and marked [`PENDING_COMMANDS`] until they register, the same
//! shape the extension's native host uses: **a host that silently mapped a
//! gesture onto a command nobody registered would be a button that reports
//! success and writes nothing.**
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5); v0's falls back to the call's
//! ordinal, which is stable only for a handler that makes the same call
//! sequence every time.
//!
//! **A denial is a value, never an `Err`** (#1020 apps seam 10).
//!
//! **`online_only` is empty for Agenda, and that is a checked claim.**
//! `ONLINE_ONLY_ACTIONS` is declared in `packages/blueprints/apps/locker/writes.ts`
//! and `grep -rn ONLINE_ONLY packages/blueprints/apps/agenda` finds none;
//! there is no `writes.ts` in that directory. So every Agenda action may be
//! queued offline, including `propose` — which is the point of accepting an
//! invitation on a train.
//!
//! **`confirmation` is the manifest's and `confirm` is the command's** (census
//! §A0, two gates). **Agenda declares NONE of the first**, including on
//! `cancel-event`, and the port reproduces that faithfully; the four
//! `schedule.*` commands that park a non-owner invocation are the OTHER gate,
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

/// Whether the **dispatching surface** asks before dispatching. This is the
/// manifest's `confirmation`, not the command definition's `confirm` — two
/// different gates (census §A0).
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
    /// A seat refuses to QUEUE this offline. Agenda declares none; see the
    /// module note for the grep behind the claim.
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

/// The seven, in the manifest's own order.
pub const ACTIONS: &[ActionRow] = &[
    act("propose", "schedule.propose_event"),
    act("rsvp", "schedule.respond_rsvp"),
    act("edit-event", "schedule.edit_event"),
    act("edit-occurrence", "schedule.edit_event_occurrence"),
    act("cancel-event", "schedule.cancel_event"),
    act("attach", "core.attach"),
    act("detach", "core.detach"),
];

/// The commands this app names that the vault does not register yet.
///
/// **Named rather than discovered**, exactly as the extension's native host
/// names its own: `core.attach` and `core.detach` are the Notes lane's half of
/// `core.*`, and an attach button that reported success and wrote nothing is
/// what this list exists to prevent.
/// [`tests::the_pending_commands_are_the_ones_the_catalogue_lacks`] fails when
/// one of them lands — the list shrinks by being wrong.
pub const PENDING_COMMANDS: [&str; 2] = ["core.attach", "core.detach"];

/// The row for an action, by name.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

/// The `act` scopes the manifest declares, sorted — the tables the grant names.
#[must_use]
pub fn act_scope_tables() -> Vec<&'static str> {
    let mut tables: Vec<&'static str> = vec!["attach", "cancel_event", "detach"];
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
        assert_eq!(ACTIONS.len(), 7);
    }

    #[test]
    fn five_of_the_seven_are_the_schedule_schema() {
        let schedule = ACTIONS
            .iter()
            .filter(|row| row.command.starts_with("schedule."))
            .count();
        assert_eq!(schedule, 5);
        let core = ACTIONS
            .iter()
            .filter(|row| row.command.starts_with("core."))
            .count();
        assert_eq!(core, 2);
    }

    /// Every command this app names is either in the catalogue or on
    /// [`PENDING_COMMANDS`]; when a lane lands one, this fails and the name
    /// comes off rather than staying a silent no-op.
    #[test]
    fn the_pending_commands_are_the_ones_the_catalogue_lacks() {
        for row in ACTIONS {
            let pending = PENDING_COMMANDS.contains(&row.command);
            // The catalogue this crate can see without linking the vault's
            // registry: `schedule.*` is this lane's own and is real.
            let known = row.command.starts_with("schedule.");
            assert!(
                known != pending,
                "`{}` is {}registered and {}on the pending list",
                row.command,
                if known { "" } else { "not " },
                if pending { "" } else { "not " }
            );
        }
    }

    #[test]
    fn an_invocation_carries_its_key_and_is_never_optional() {
        let invocation = Invocation::new("schedule.propose_event", "propose", BTreeMap::new());
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
