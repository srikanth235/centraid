//! THE NINETEEN ACTIONS, as command invocations.
//!
//! Every Photos action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app. So this module is a table, not
//! logic. A command is either a photograph's own (`photo.*`, `album.set_cover`)
//! or a shared verb every app uses (`entity.*`, `flag.*`, `tag.*`, `edge.*`,
//! `container.*`): Photos does not wrap a shared verb, so two actions may name one
//! command (`rename-album` and `name-place` are both `entity.retitle`), and an
//! action's input is its command's input, verbatim (#1135).
//!
//! **What a photograph's two flags are.** A heart is `flag.set` of `starred` and the
//! archive is `flag.set` of `archived`: one verb, two words, the same shape Photos'
//! star and Notes' pin take.
//!
//! **Faces are gone.** `answer-face` and `request-enrichment` left with the
//! recognition surfaces nothing produces (R-FP-10, Q-1047-2).
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5); v0's falls back to the call's
//! ordinal, which is stable only for a handler that makes the same call
//! sequence every time.
//!
//! **A denial is a value, never an `Err`** (#1020 apps seam 10).
//!
//! **`confirmation` is the manifest's and `confirm` is the command's** (census
//! §A0, two gates). Photos' two manifest-confirmed actions are `purge-photo` and
//! `delete-album`; no command this build carries sets the command-level gate.

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
    /// invocation as failed rather than refusing the whole run. Photos has none —
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
}

const fn act(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::None,
    }
}

const fn confirmed(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::Required,
    }
}

/// THE TABLE. Eighteen actions, eighteen commands, in the manifest's own order.
pub const ACTIONS: [ActionRow; 19] = [
    act("upload", "photo.add"),
    act("edit-photo", "photo.edit"),
    act("retitle-photo", "entity.retitle"),
    act("flag-photo", "flag.set"),
    act("unflag-photo", "flag.clear"),
    act("delete-photo", "entity.trash"),
    act("restore-photo", "entity.restore"),
    // THE TWO CONFIRM-GATED ACTIONS: one trashed photograph forever, and an
    // album (its photographs stay in the library).
    confirmed("purge-photo", "entity.purge"),
    act("create-album", "container.create"),
    act("rename-album", "entity.retitle"),
    act("set-album-cover", "album.set_cover"),
    confirmed("delete-album", "entity.trash"),
    act("restore-album", "entity.restore"),
    act("add-to-album", "edge.add"),
    act("remove-from-album", "edge.remove"),
    act("set-place", "photo.set_place"),
    act("name-place", "entity.retitle"),
    act("tag-photo", "tag.add"),
    act("untag-photo", "tag.remove"),
];

/// One action's row, by the name the manifest gives it.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

/// The `act` scopes Photos declares, derived from the action table.
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
    fn every_action_invokes_one_command_and_the_photo_verbs_are_the_photographs_own() {
        assert_eq!(ACTIONS.len(), 19);
        let own: Vec<&str> = ACTIONS
            .iter()
            .map(|row| row.command)
            .filter(|command| command.starts_with("photo.") || command.starts_with("album."))
            .collect();
        assert_eq!(
            own,
            [
                "photo.add",
                "photo.edit",
                "album.set_cover",
                "photo.set_place"
            ],
            "what only a photograph or an album has; everything else is a shared verb"
        );
        let mut schemas: Vec<&str> = ACTIONS
            .iter()
            .filter_map(|row| row.command.split_once('.').map(|(schema, _)| schema))
            .collect();
        schemas.sort_unstable();
        schemas.dedup();
        assert_eq!(
            schemas,
            [
                "album",
                "container",
                "edge",
                "entity",
                "flag",
                "photo",
                "tag"
            ]
        );
    }

    #[test]
    fn a_shared_verb_serves_several_actions_without_a_wrapper() {
        let retitle: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.command == "entity.retitle")
            .map(|row| row.action)
            .collect();
        assert_eq!(retitle, ["retitle-photo", "rename-album", "name-place"]);
        let trash: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.command == "entity.trash")
            .map(|row| row.action)
            .collect();
        assert_eq!(trash, ["delete-photo", "delete-album"]);
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
        assert_eq!(required, ["purge-photo", "delete-album"]);
    }

    /// ONE ACT SCOPE PER DISTINCT COMMAND — never one `read+act` over a whole
    /// family. Widening it would hand Photos every `entity.*` verb it never sends.
    #[test]
    fn the_act_scopes_are_one_per_distinct_command() {
        assert_eq!(act_scope_tables().len(), 15);
        assert!(act_scope_tables().contains(&("photo", "add")));
        assert!(
            !act_scope_tables()
                .iter()
                .any(|(schema, _)| *schema == "enrich")
        );
    }

    #[test]
    fn an_invocation_carries_its_key_and_an_unknown_action_has_none() {
        let invocation =
            invocation_for("upload", "photos:0", BTreeMap::new()).expect("upload is in the table");
        assert_eq!(invocation.command, "photo.add");
        assert_eq!(invocation.invoke_key, "photos:0");
        assert!(!invocation.optional, "Photos has no decorating invocation");
        assert!(invocation_for("undelete-everything", "photos:1", BTreeMap::new()).is_none());
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
