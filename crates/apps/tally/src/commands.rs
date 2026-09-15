//! THE 23 ACTIONS, as command invocations.
//!
//! Every Tally action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app
//! (`packages/blueprints/apps/_shared/action-kit.ts`, #1020 apps §3.4). So this
//! module is a table, not logic — it names which command each action invokes
//! and hands the input through.
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5). v0's `invokeKey` is optional
//! and falls back to the call's **ordinal**, which "is only stable for a
//! handler that makes the same call sequence every time"
//! (`packages/blueprints/types/centraid.d.ts:86-95`). A replayed intent whose
//! handler branched differently then re-executes a committed command under
//! another call's key. The port makes the key a required field, so the fallback
//! does not exist to be relied on.
//!
//! **A denial is a value, never an `Err`** (#1020 apps seam 10). v0 wraps every
//! action in `runVaultAction`, which answers HTTP 200 with
//! `{status: "denied", reason, code}` on a throw, because "the DISPATCH
//! succeeded and the vault's decision is in the body"
//! (`action-kit.ts:1-3`). Rust's instinct — propagate the error — would turn a
//! renderable state into a blank screen, so [`Outcome`] carries `Denied` as one
//! of its states and the trait's `Result` is reserved for a door that is not
//! there at all.

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
    /// invocation as failed rather than refusing the whole run
    /// (`centraid.d.ts:77-84`). The gateway ignores the field.
    pub optional: bool,
}

/// The seven states a vault invocation settles in, as v0 spells them
/// (`VaultOutcome`, `centraid.d.ts:38`). `Denied` is one of them.
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
    /// The vault's decision, and a state the surface renders — `vault_denied`
    /// in the payload, never an error.
    Denied {
        reason: Option<String>,
        code: Option<String>,
    },
}

impl Outcome {
    /// The output of an executed command, or `None` for every other state.
    pub fn output(&self) -> Option<&Value> {
        match self {
            Self::Executed { output } => Some(output),
            _ => None,
        }
    }

    /// Whether the surface should show the write as still in flight.
    pub fn pending(&self) -> bool {
        matches!(self, Self::Queued | Self::InFlight | Self::Parked { .. })
    }
}

/// The one door an app writes through.
///
/// `Err` means the door itself is absent — v0's `VAULT_UNAVAILABLE`, which
/// fails closed (`packages/server/src/engine/handlers/handler-runner.ts:196-200`).
/// Every decision the vault takes, including a refusal, arrives as an
/// [`Outcome`].
pub trait Commands {
    fn invoke(&self, invocation: &Invocation) -> Result<Outcome, CommandsUnavailable>;
}

/// The door is not there. Fails closed, and says which command it was.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("the vault door is unavailable; {command} was not attempted")]
pub struct CommandsUnavailable {
    pub command: &'static str,
}

/// Whether the conversation surface asks before dispatching. Carried here so
/// the table and the manifest can be checked against each other; the dispatcher
/// itself is permissionless (`manifest.ts:51`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confirm {
    None,
    Required,
}

/// One row of the action table: the manifest's action name, the command it
/// invokes, and whether the surface confirms first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionRow {
    pub action: &'static str,
    pub command: &'static str,
    pub confirm: Confirm,
}

/// THE TABLE. Twenty-three actions, twenty-three commands, in the manifest's
/// own order.
///
/// Two of them invoke a **core** command rather than a tally one, and that is
/// the point: accepting or rejecting a bank-statement match writes a
/// `core.link` with `relation: "same-as"` or `"distinct-from"` and **is not a
/// merge** — nothing is deleted and no amount moves, so the member's bank
/// statement stays reconcilable (`actions/accept-match.ts:3-11`,
/// `actions/reject-match.ts:3-9`).
pub const ACTIONS: [ActionRow; 23] = [
    ActionRow {
        action: "add-expense",
        command: "tally.add_expense",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "add-receipt-expense",
        command: "tally.add_receipt_expense",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "edit-expense",
        command: "tally.edit_expense",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "delete-expense",
        command: "tally.delete_expense",
        confirm: Confirm::Required,
    },
    ActionRow {
        action: "undo-expense",
        command: "tally.undo_expense",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "restore-expense",
        command: "tally.restore_expense",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "reallocate-receipt",
        command: "tally.reallocate_receipt",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "settle-up",
        command: "tally.settle_up",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "add-friend",
        command: "tally.add_friend",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "create-group",
        command: "tally.create_group",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "rename-group",
        command: "tally.rename_group",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "add-group-member",
        command: "tally.add_group_member",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "remove-group-member",
        command: "tally.remove_group_member",
        confirm: Confirm::Required,
    },
    ActionRow {
        action: "delete-group",
        command: "tally.delete_group",
        confirm: Confirm::Required,
    },
    ActionRow {
        action: "leave-group",
        command: "tally.leave_group",
        confirm: Confirm::Required,
    },
    ActionRow {
        action: "archive-group",
        command: "tally.archive_group",
        confirm: Confirm::Required,
    },
    ActionRow {
        action: "set-group-simplification",
        command: "tally.set_group_simplification",
        confirm: Confirm::Required,
    },
    ActionRow {
        action: "nudge",
        command: "tally.nudge",
        confirm: Confirm::Required,
    },
    ActionRow {
        action: "save-recurring-expense",
        command: "tally.save_recurring_expense",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "materialize-recurring-expense",
        command: "tally.materialize_recurring_expense",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "edit-recurring-expense-occurrence",
        command: "tally.edit_recurring_expense_occurrence",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "accept-match",
        command: "core.link_entities",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "reject-match",
        command: "core.link_entities",
        confirm: Confirm::None,
    },
];

/// The relation `accept-match` and `reject-match` write. Named, because the
/// two actions share a command and differ only here.
pub const MATCH_RELATIONS: [(&str, &str); 2] = [
    ("accept-match", "same-as"),
    ("reject-match", "distinct-from"),
];

/// The row for one action name.
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

/// Run one of the app's actions.
///
/// The `input` is the body the dispatcher already validated against the
/// manifest's schema (`action-kit.ts:11`), so there is no second validation
/// here — a second one is a second answer to "what is a valid body".
pub fn run(
    door: &dyn Commands,
    action: &str,
    input: BTreeMap<String, Value>,
    invoke_key: &str,
) -> Result<Outcome, CommandsUnavailable> {
    let Some(row) = action_row(action) else {
        // An action the manifest does not declare cannot be dispatched, so
        // reaching here is a programming error in the app, not a member-facing
        // state. It answers `Failed` rather than panicking: a shell that asked
        // for a handler that does not exist should see a refusal, not a crash.
        return Ok(Outcome::Failed {
            reason: Some(format!("tally declares no action \"{action}\"")),
        });
    };
    let mut input = input;
    if let Some((_, relation)) = MATCH_RELATIONS.iter().find(|(name, _)| *name == row.action) {
        input.insert("relation".to_owned(), Value::String((*relation).to_owned()));
    }
    door.invoke(&Invocation {
        command: row.command,
        input,
        invoke_key: invoke_key.to_owned(),
        optional: false,
    })
}

#[cfg(test)]
pub(crate) mod testing {
    use std::cell::RefCell;

    use super::{Commands, CommandsUnavailable, Invocation, Outcome};

    /// An in-memory door that records what it was asked and answers what it was
    /// told to. The real one is `crates/vault`'s, and an app changes nothing
    /// but which door it is handed.
    pub struct RecordingDoor {
        pub seen: RefCell<Vec<Invocation>>,
        pub answer: Outcome,
        pub unavailable: bool,
    }

    impl RecordingDoor {
        pub fn executed() -> Self {
            Self {
                seen: RefCell::new(Vec::new()),
                answer: Outcome::Executed {
                    output: serde_json::json!({}),
                },
                unavailable: false,
            }
        }

        pub fn answering(answer: Outcome) -> Self {
            Self {
                seen: RefCell::new(Vec::new()),
                answer,
                unavailable: false,
            }
        }

        pub fn absent() -> Self {
            Self {
                seen: RefCell::new(Vec::new()),
                answer: Outcome::Queued,
                unavailable: true,
            }
        }
    }

    impl Commands for RecordingDoor {
        fn invoke(&self, invocation: &Invocation) -> Result<Outcome, CommandsUnavailable> {
            self.seen.borrow_mut().push(invocation.clone());
            if self.unavailable {
                return Err(CommandsUnavailable {
                    command: invocation.command,
                });
            }
            Ok(self.answer.clone())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::RecordingDoor;
    use super::*;

    fn input(pairs: &[(&str, Value)]) -> BTreeMap<String, Value> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect()
    }

    #[test]
    fn every_action_is_named_once_and_maps_to_one_command() {
        let mut names: Vec<&str> = ACTIONS.iter().map(|row| row.action).collect();
        names.sort_unstable();
        let unique = names.len();
        names.dedup();
        assert_eq!(names.len(), unique, "an action name appears twice");
        assert_eq!(ACTIONS.len(), 23);
    }

    #[test]
    fn the_invoke_key_reaches_the_door_and_is_not_derivable_from_the_call_order() {
        let door = RecordingDoor::executed();
        run(
            &door,
            "delete-expense",
            input(&[("expense_id", Value::String("e-1".to_owned()))]),
            "tally.delete-expense",
        )
        .unwrap();
        let seen = door.seen.borrow();
        assert_eq!(seen[0].command, "tally.delete_expense");
        assert_eq!(seen[0].invoke_key, "tally.delete-expense");
    }

    #[test]
    fn the_two_match_actions_share_a_command_and_differ_only_in_the_relation() {
        for (action, relation) in MATCH_RELATIONS {
            let door = RecordingDoor::executed();
            run(&door, action, BTreeMap::new(), action).unwrap();
            let seen = door.seen.borrow();
            assert_eq!(seen[0].command, "core.link_entities");
            assert_eq!(
                seen[0].input.get("relation"),
                Some(&Value::String(relation.to_owned())),
                "{action} must write its own relation"
            );
        }
    }

    #[test]
    fn a_denial_is_a_value_and_not_an_error() {
        let door = RecordingDoor::answering(Outcome::Denied {
            reason: Some("this app's grant was revoked".to_owned()),
            code: Some("revoked".to_owned()),
        });
        let outcome = run(&door, "add-expense", BTreeMap::new(), "add").unwrap();
        assert!(matches!(outcome, Outcome::Denied { .. }));
        assert!(outcome.output().is_none());
        assert!(!outcome.pending(), "a denial has settled");
    }

    #[test]
    fn an_absent_door_fails_closed_and_names_the_command() {
        let door = RecordingDoor::absent();
        let outcome = run(&door, "settle-up", BTreeMap::new(), "settle");
        assert_eq!(
            outcome,
            Err(CommandsUnavailable {
                command: "tally.settle_up"
            })
        );
    }

    #[test]
    fn an_undeclared_action_is_refused_rather_than_panicking() {
        let door = RecordingDoor::executed();
        let outcome = run(&door, "delete-everything", BTreeMap::new(), "x").unwrap();
        assert!(matches!(outcome, Outcome::Failed { .. }));
        assert!(door.seen.borrow().is_empty(), "nothing reached the vault");
    }
}
