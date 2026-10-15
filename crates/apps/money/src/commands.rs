//! THE 20 ACTIONS, as command invocations.
//!
//! Every Money action is a thin invocation of ONE typed vault command
//! (`crates/vault/src/commands/money.rs`): the projection lives in the command,
//! not the app. So this module is a table, not logic — it names which command
//! each action invokes and hands the input through.
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5). It is the caller's correlation
//! key: it pairs an answer with the call that caused it, and it never reaches
//! the vault, which keeps no replay ledger (#1029 §1, R-1088-12). A write the
//! shell may re-offer is idempotent by its content or by an id the phone minted
//! first — seventeen of these commands are the first, three (`add_account`,
//! `add_rule`, `add_category`) the second.
//!
//! **A denial is a value, never an `Err`.** [`Outcome`] carries `Denied` as one
//! of its states; `Err` is reserved for a door that is not there at all.

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
/// fails closed. Every decision the vault takes, including a refusal,
/// arrives as an [`Outcome`].
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

/// THE TABLE. Twenty actions, twenty commands, in the manifest's own order.
/// Confirmation is asked for what cannot be taken back or touches many rows.
pub const ACTIONS: [ActionRow; 20] = [
    ActionRow {
        action: "add-account",
        command: "money.add_account",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "edit-account",
        command: "money.edit_account",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "set-opening-balance",
        command: "money.set_opening_balance",
        confirm: Confirm::Required,
    },
    ActionRow {
        action: "import-transactions",
        command: "money.import_transactions",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "record-checkpoint",
        command: "money.record_checkpoint",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "save-import-profile",
        command: "money.save_import_profile",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "categorize",
        command: "money.categorize",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "void-transaction",
        command: "money.void_transaction",
        confirm: Confirm::Required,
    },
    ActionRow {
        action: "set-display-name",
        command: "money.set_display_name",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "link-transfer",
        command: "money.link_transfer",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "unlink-transfer",
        command: "money.unlink_transfer",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "set-target",
        command: "money.set_target",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "set-carry",
        command: "money.set_carry",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "add-rule",
        command: "money.add_rule",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "edit-rule",
        command: "money.edit_rule",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "delete-rule",
        command: "money.delete_rule",
        confirm: Confirm::Required,
    },
    ActionRow {
        action: "apply-rule-to-history",
        command: "money.apply_rule_to_history",
        confirm: Confirm::Required,
    },
    ActionRow {
        action: "add-category",
        command: "money.add_category",
        confirm: Confirm::None,
    },
    ActionRow {
        action: "merge-category",
        command: "money.merge_category",
        confirm: Confirm::Required,
    },
    ActionRow {
        action: "archive-category",
        command: "money.archive_category",
        confirm: Confirm::None,
    },
];

/// The row for an action, if it is declared.
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

/// Invoke one action through `door`. An undeclared action is `Failed`, not a
/// panic; `Err` means the door itself is absent.
pub fn run(
    door: &dyn Commands,
    action: &str,
    input: BTreeMap<String, Value>,
    invoke_key: &str,
) -> Result<Outcome, CommandsUnavailable> {
    let Some(row) = action_row(action) else {
        return Ok(Outcome::Failed {
            reason: Some(format!("money declares no action \"{action}\"")),
        });
    };
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

    pub struct RecordingDoor {
        pub seen: RefCell<Vec<Invocation>>,
        pub answer: Outcome,
        pub unavailable: bool,
    }

    impl RecordingDoor {
        pub fn executed() -> Self {
            Self::answering(Outcome::Executed {
                output: serde_json::json!({}),
            })
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
        names.dedup();
        assert_eq!(names.len(), ACTIONS.len());
        let mut commands: Vec<&str> = ACTIONS.iter().map(|row| row.command).collect();
        commands.sort_unstable();
        commands.dedup();
        assert_eq!(commands.len(), ACTIONS.len(), "one action per command");
        assert!(ACTIONS.iter().all(|row| row.command.starts_with("money.")));
    }

    #[test]
    fn the_invoke_key_reaches_the_door_and_the_command_is_the_tables() {
        let door = RecordingDoor::executed();
        let outcome = run(
            &door,
            "categorize",
            input(&[("txn_ids", Value::Array(vec![]))]),
            "key-1",
        );
        assert!(matches!(outcome, Ok(Outcome::Executed { .. })));
        let seen = door.seen.borrow();
        assert_eq!(
            (
                seen[0].command,
                seen[0].invoke_key.as_str(),
                seen[0].optional
            ),
            ("money.categorize", "key-1", false)
        );
    }

    #[test]
    fn a_denial_is_a_value_and_not_an_error() {
        let door = RecordingDoor::answering(Outcome::Denied {
            reason: Some("no".into()),
            code: Some("vault_denied".into()),
        });
        let outcome = run(&door, "void-transaction", input(&[]), "k").expect("not an Err");
        assert!(matches!(outcome, Outcome::Denied { .. }));
        assert!(outcome.output().is_none() && !outcome.pending());
    }

    #[test]
    fn an_absent_door_fails_closed_and_names_the_command() {
        let door = RecordingDoor::absent();
        let error = run(&door, "set-target", input(&[]), "k").expect_err("an Err");
        assert_eq!(error.command, "money.set_target");
    }

    #[test]
    fn an_undeclared_action_is_refused_rather_than_panicking() {
        let door = RecordingDoor::executed();
        let outcome = run(&door, "nope", input(&[]), "k").unwrap();
        assert_eq!(
            outcome,
            Outcome::Failed {
                reason: Some("money declares no action \"nope\"".into())
            }
        );
        assert!(door.seen.borrow().is_empty());
    }
}
