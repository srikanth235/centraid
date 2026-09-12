//! THE SIXTEEN ACTIONS, as command invocations.
//!
//! Every Docs action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app
//! (`packages/blueprints/apps/_shared/action-kit.ts`). So this module is a
//! table, not logic.
//!
//! **ALL SIXTEEN ARE `core.*`** — Docs is the app whose whole command surface
//! belongs to the core schema (census §A3), which is why "porting Docs'
//! commands" meant editing `crates/vault/src/commands/core.rs` and not this
//! crate. The scope list stays **explicit, one `act` scope per action**: the
//! manifest declares sixteen `{schema: "core", table: "<command>", verbs:
//! "act"}` entries rather than one `read+act` over the whole schema, and
//! widening it would hand Docs every `core.*` command including the two merges.
//! Only agenda and people use the whole-schema form, and Docs is not one of
//! them.
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5); v0's falls back to the call's
//! ordinal, which is stable only for a handler that makes the same call
//! sequence every time.
//!
//! **A denial is a value, never an `Err`** (#1020 apps seam 10).
//!
//! **`online_only` is empty for Docs, and that is a checked claim.** Locker
//! declares `ONLINE_ONLY_ACTIONS` in `packages/blueprints/apps/locker/writes.ts`;
//! `grep -rn ONLINE_ONLY packages/blueprints/apps/docs` finds none, and there is
//! no `writes.ts` in that directory. So every Docs action may be queued
//! offline, including `upload` — which is the point of filing a scan of a
//! receipt in a car park.
//!
//! **`confirmation` is the manifest's and `confirm` is the command's** (census
//! §A0, two gates). Docs' one manifest-confirmed action is `empty-trash`; no
//! `core.*` command this build carries sets `confirm: true`. Collapsing them
//! would put a dialog in front of nothing and drop nothing in exchange.

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
    /// invocation as failed rather than refusing the whole run. Docs has none —
    /// every action here is the member's own gesture.
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
    /// A seat refuses to QUEUE this offline. Docs declares none; see the module
    /// note for the grep behind the claim.
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

const fn confirmed(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::Required,
        online_only: false,
    }
}

/// THE TABLE. Sixteen actions, sixteen commands, in the manifest's own order.
pub const ACTIONS: [ActionRow; 16] = [
    act("upload", "core.add_document"),
    act("rename", "core.rename_document"),
    act("move", "core.move_document"),
    act("trash", "core.trash_document"),
    act("restore", "core.restore_document"),
    // THE ONE CONFIRM-GATED ACTION, and the app's only bulk purge.
    confirmed("empty-trash", "core.empty_document_trash"),
    act("star", "core.star_document"),
    act("unstar", "core.unstar_document"),
    act("tag", "core.tag_item"),
    act("untag", "core.untag_item"),
    act("edit", "core.edit_document"),
    act("replace", "core.replace_document_content"),
    act("restore-version", "core.restore_document_version"),
    act("create-folder", "core.create_folder"),
    act("rename-folder", "core.rename_folder"),
    act("delete-folder", "core.delete_folder"),
];

/// One action's row, by the name the manifest gives it.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

/// The `act` scopes Docs declares, derived from the action table.
///
/// The manifest spells each one as `{schema: "core", table: "<command name
/// without its schema>"}`; deriving it here is what lets
/// `every_act_scope_is_one_action` compare the two lists instead of trusting
/// them.
#[must_use]
pub fn act_scope_tables() -> Vec<&'static str> {
    let mut tables: Vec<&'static str> = ACTIONS
        .iter()
        .map(|row| {
            row.command
                .split_once('.')
                .map_or(row.command, |(_, name)| name)
        })
        .collect();
    tables.sort_unstable();
    tables.dedup();
    tables
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
    fn every_action_invokes_exactly_one_core_command() {
        assert_eq!(ACTIONS.len(), 16);
        let mut commands: Vec<&str> = ACTIONS.iter().map(|row| row.command).collect();
        for command in &commands {
            assert!(
                command.starts_with("core."),
                "{command} is not a core command, and Docs' whole surface is core's"
            );
        }
        commands.sort_unstable();
        let before = commands.len();
        commands.dedup();
        assert_eq!(before, commands.len(), "no command is invoked twice");
    }

    /// The one manifest-confirmed action, and nothing else.
    #[test]
    fn empty_trash_is_the_only_confirmed_action() {
        let required: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.confirm == Confirm::Required)
            .map(|row| row.action)
            .collect();
        assert_eq!(required, ["empty-trash"]);
    }

    #[test]
    fn no_action_is_withheld_offline() {
        assert!(ACTIONS.iter().all(|row| !row.online_only));
    }

    /// SIXTEEN ACT SCOPES, ONE PER ACTION — never one `read+act` over the whole
    /// schema. Widening it would hand Docs `core.merge_party`.
    #[test]
    fn the_act_scopes_are_one_per_action() {
        assert_eq!(act_scope_tables().len(), 16);
        assert!(act_scope_tables().contains(&"add_document"));
        assert!(!act_scope_tables().contains(&"merge_party"));
    }

    #[test]
    fn an_invocation_carries_its_key_and_an_unknown_action_has_none() {
        let invocation =
            invocation_for("upload", "docs:0", BTreeMap::new()).expect("upload is in the table");
        assert_eq!(invocation.command, "core.add_document");
        assert_eq!(invocation.invoke_key, "docs:0");
        assert!(!invocation.optional, "Docs has no decorating invocation");
        assert!(invocation_for("undelete-everything", "docs:1", BTreeMap::new()).is_none());
    }

    /// A DENIAL IS A VALUE. The outcome enum carries it, and `output()` is
    /// `None` for every state but `Executed` — so a caller cannot read an
    /// output off a refusal.
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
                output: serde_json::json!({ "document_id": "d1" })
            }
            .output(),
            Some(&serde_json::json!({ "document_id": "d1" }))
        );
    }
}
