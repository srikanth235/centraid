//! THE EIGHTEEN ACTIONS, as command invocations.
//!
//! Every Docs action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app. So this module is a table, not
//! logic. A command is either a document's own (`document.*`, six of them) or a
//! shared verb every app uses (`entity.*`, `flag.*`, `tag.*`, `container.*`):
//! Docs does not wrap a shared verb, so two actions may name one command
//! (`rename` and `rename-folder` are both `entity.retitle`; `trash` and
//! `delete-folder` are both `entity.trash`), and an action's input is its
//! command's input, verbatim (#1135).
//!
//! The scope list is **explicit, one `act` scope per distinct command**: the
//! manifest declares `{schema: "<verb's family>", table: "<verb>", verbs: "act"}`
//! for each command an action names, so the consent a member grants is the
//! commands Docs sends and no wider.
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5); v0's falls back to the call's
//! ordinal, which is stable only for a handler that makes the same call
//! sequence every time.
//!
//! **A denial is a value, never an `Err`** (#1020 apps seam 10).
//!
//! **`confirmation` is the manifest's and `confirm` is the command's** (census
//! §A0, two gates). Docs' two manifest-confirmed actions are `purge` and
//! `empty-trash`, the two destroys (ruling D-1 of 2026-09-25); no command this
//! build carries sets the command-level gate.

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

pub use centraid_apps_kit::actions::{ActionRow, Confirm};
use centraid_apps_kit::actions::{act, confirmed};

/// THE TABLE. Eighteen actions, eighteen commands, in the manifest's own order.
pub const ACTIONS: [ActionRow; 18] = [
    act("upload", "document.add"),
    // The Add sheet's "Text" (#1047): words in, a text document out.
    act("create-text", "document.create_text"),
    act("rename", "entity.retitle"),
    act("move", "document.move"),
    act("trash", "entity.trash"),
    act("restore", "entity.restore"),
    // THE TWO CONFIRM-GATED ACTIONS, and the app's two destroys (D-1,
    // 2026-09-25): one trashed document, and the whole trash.
    confirmed("purge", "entity.purge"),
    confirmed("empty-trash", "entity.empty_trash"),
    act("star", "flag.set"),
    act("unstar", "flag.clear"),
    act("tag", "tag.add"),
    act("untag", "tag.remove"),
    act("edit", "document.edit"),
    act("replace", "document.replace"),
    act("restore-version", "document.restore_version"),
    act("create-folder", "container.create"),
    act("rename-folder", "entity.retitle"),
    act("delete-folder", "entity.trash"),
];

/// One action's row, by the name the manifest gives it.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    centraid_apps_kit::actions::find(&ACTIONS, action)
}

/// The `act` scopes Docs declares, derived from the action table.
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
    fn every_action_invokes_one_command_and_the_document_verbs_are_the_documents_own() {
        assert_eq!(ACTIONS.len(), 18);
        let own: Vec<&str> = ACTIONS
            .iter()
            .map(|row| row.command)
            .filter(|command| command.starts_with("document."))
            .collect();
        assert_eq!(
            own,
            [
                "document.add",
                "document.create_text",
                "document.move",
                "document.edit",
                "document.replace",
                "document.restore_version"
            ],
            "what only a document has; everything else is a shared verb"
        );
        let mut schemas: Vec<&str> = ACTIONS
            .iter()
            .filter_map(|row| row.command.split_once('.').map(|(schema, _)| schema))
            .collect();
        schemas.sort_unstable();
        schemas.dedup();
        assert_eq!(schemas, ["container", "document", "entity", "flag", "tag"]);
    }

    #[test]
    fn a_shared_verb_serves_two_actions_without_a_wrapper() {
        let retitle: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.command == "entity.retitle")
            .map(|row| row.action)
            .collect();
        assert_eq!(retitle, ["rename", "rename-folder"]);
    }

    /// Every command an action names is one the vault registers.
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
    fn the_two_destroys_are_the_only_confirmed_actions() {
        let required: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.confirm == Confirm::Required)
            .map(|row| row.action)
            .collect();
        assert_eq!(required, ["purge", "empty-trash"]);
    }

    /// ONE ACT SCOPE PER DISTINCT COMMAND — never one `read+act` over a whole
    /// family. Widening it would hand Docs every `entity.*` verb it never sends.
    #[test]
    fn the_act_scopes_are_one_per_distinct_command() {
        assert_eq!(act_scope_tables().len(), 16);
        assert!(act_scope_tables().contains(&("document", "add")));
        assert!(!act_scope_tables().contains(&("person", "merge")));
    }

    #[test]
    fn an_invocation_carries_its_key_and_an_unknown_action_has_none() {
        let invocation =
            invocation_for("upload", "docs:0", BTreeMap::new()).expect("upload is in the table");
        assert_eq!(invocation.command, "document.add");
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
                output: serde_json::json!({ "id": "d1" })
            }
            .output(),
            Some(&serde_json::json!({ "id": "d1" }))
        );
    }
}
