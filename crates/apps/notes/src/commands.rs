//! THE FIFTEEN ACTIONS, as command invocations.
//!
//! Every Notes action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app
//! (`packages/blueprints/apps/_shared/action-kit.ts`). So this module is a
//! table, not logic.
//!
//! **Notes reaches FOUR schemas from fifteen actions**, and that is the fact a
//! port must not smooth over: nine `knowledge.*`, four `core.*` (two tags, two
//! attachments) — `link` is a fifth `core.*` — and one `schedule.*`.
//! `send-to-tasks` writes `schedule.add_task` and then links the task back to
//! the note, which is why it is the only action making TWO invocations and the
//! only one whose second call is conditional.
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5). `send-to-tasks` is exactly why:
//! v0 notes at its own call site that the backlink "is the SECOND invoke on the
//! happy path and no invoke at all when the task did not land or there is no
//! note" (`actions/send-to-tasks.ts:43`-`:48`), so an ordinal key would name a
//! different call on two different runs of the same action.
//!
//! **`schedule.add_task` is not in this build** (state at spawn: the Agenda and
//! Tasks lane holds the `schedule` schema, slot 4d). The row is in the table
//! with [`ActionRow::pending_schema`] set, a registry test in
//! `crates/vault/src/commands/mod.rs` keeps the name reserved, and the parity
//! case is marked `pending: schedule` — the same pattern `crates/automations`
//! used for the commands other lanes owed it.
//!
//! **`confirmation` is the manifest's and `confirm` is the command's** (census
//! §A0, two gates). Notes' two manifest-confirmed actions are `delete-notebook`
//! and `delete-note`; no `knowledge.*` or `core.*` command this build carries
//! sets the command-level gate. Collapsing them would put a dialog in front of
//! nothing and drop the non-owner park in exchange.
//!
//! **Nothing here is `online_only`, and that is a checked claim.** Locker
//! declares `ONLINE_ONLY_ACTIONS` in `packages/blueprints/apps/locker/writes.ts`;
//! `grep -rn ONLINE_ONLY packages/blueprints/apps/notes` finds none and there is
//! no `writes.ts` in that directory. So every Notes action may be queued
//! offline — which is the point of writing a note on a train.

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
    /// A seat refuses to QUEUE this offline. Notes declares none; see the
    /// module note for the grep behind the claim.
    pub online_only: bool,
    /// The schema whose commands are not in this build yet, when there is one.
    /// `send-to-tasks` is the only row that carries it (slot 4d).
    pub pending_schema: Option<&'static str>,
}

const fn act(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::None,
        online_only: false,
        pending_schema: None,
    }
}

const fn confirmed(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::Required,
        online_only: false,
        pending_schema: None,
    }
}

const fn pending(action: &'static str, command: &'static str, schema: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::None,
        online_only: false,
        pending_schema: Some(schema),
    }
}

/// THE TABLE. Fifteen actions, in the manifest's own order.
pub const ACTIONS: [ActionRow; 15] = [
    act("create-note", "knowledge.create_note"),
    act("edit-note", "knowledge.edit_note"),
    act("move-note", "knowledge.move_note"),
    act("create-notebook", "knowledge.create_notebook"),
    act("rename-notebook", "knowledge.rename_notebook"),
    // THE TWO CONFIRM-GATED ACTIONS.
    confirmed("delete-notebook", "knowledge.delete_notebook"),
    confirmed("delete-note", "knowledge.delete_note"),
    act("restore-note", "knowledge.restore_note"),
    act("restore-note-version", "knowledge.restore_note_version"),
    act("link", "core.link_entities"),
    // The only action that makes TWO invocations: the task, then the backlink.
    pending("send-to-tasks", "schedule.add_task", "schedule"),
    act("attach", "core.attach"),
    act("detach", "core.detach"),
    act("add-tag", "core.tag_item"),
    act("remove-tag", "core.untag_item"),
];

/// `send-to-tasks`' SECOND invocation, which is not always made.
///
/// The task lands first; the backlink is `core.link_entities` from the note to
/// the task. It is "no invoke at all when the task did not land or there is no
/// note", which is why its key is named rather than ordinal.
pub const SEND_TO_TASKS_BACKLINK: &str = "core.link_entities";
/// v0's own literal (`actions/send-to-tasks.ts:48`), kept so the two sides
/// agree about which call this is.
pub const SEND_TO_TASKS_BACKLINK_KEY: &str = "notes.send-to-tasks.backlink";

/// One action's row, by the name the manifest gives it.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

/// The `act` scopes Notes declares, derived from the action table.
///
/// The manifest spells each as `{schema, table: "<command name without its
/// schema>"}`; deriving it here is what lets the manifest test compare the two
/// lists instead of trusting them.
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
    // `send-to-tasks` also links the task back, and the manifest declares that
    // scope too (`core.link_entities`) — it is already in the list from `link`.
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

/// The commands Notes owes another lane, by schema. Empty means nothing is
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

    #[test]
    fn every_action_invokes_exactly_one_command_over_four_schemas() {
        assert_eq!(ACTIONS.len(), 15);
        let mut schemas: Vec<&str> = ACTIONS
            .iter()
            .filter_map(|row| row.command.split_once('.').map(|(schema, _)| schema))
            .collect();
        schemas.sort_unstable();
        schemas.dedup();
        assert_eq!(schemas, ["core", "knowledge", "schedule"]);
        let knowledge = ACTIONS
            .iter()
            .filter(|row| row.command.starts_with("knowledge."))
            .count();
        assert_eq!(knowledge, 9, "the knowledge schema is nine commands");
        let mut commands: Vec<&str> = ACTIONS.iter().map(|row| row.command).collect();
        commands.sort_unstable();
        let before = commands.len();
        commands.dedup();
        assert_eq!(before, commands.len(), "no command is invoked twice");
    }

    /// The five `core.*` commands Notes takes for its `knowledge` needs: the
    /// four link/attachment ones plus the two tag ones, minus the one `link`
    /// and `send-to-tasks` share.
    #[test]
    fn the_core_commands_notes_takes_are_named() {
        let mut core: Vec<&str> = ACTIONS
            .iter()
            .map(|row| row.command)
            .filter(|command| command.starts_with("core."))
            .collect();
        core.sort_unstable();
        assert_eq!(
            core,
            [
                "core.attach",
                "core.detach",
                "core.link_entities",
                "core.tag_item",
                "core.untag_item",
            ]
        );
        // `core.unlink_entities` and `core.anchor_link` have no Notes ACTION —
        // the manifest declares neither — and they land in the vault with these
        // because the schema moves as a whole (the common brief's rule 2).
        assert!(!core.contains(&"core.unlink_entities"));
        assert!(!core.contains(&"core.merge_party"));
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

    #[test]
    fn no_action_is_withheld_offline() {
        assert!(ACTIONS.iter().all(|row| !row.online_only));
    }

    /// `send-to-tasks` is the ONE pending row, and it says which schema owes it.
    #[test]
    fn send_to_tasks_is_the_only_command_another_lane_owes() {
        assert_eq!(pending_commands(), [("schedule", "schedule.add_task")]);
    }

    #[test]
    fn an_invocation_carries_its_key_and_an_unknown_action_has_none() {
        let invocation = invocation_for("create-note", "notes:0", BTreeMap::new())
            .expect("create-note is in the table");
        assert_eq!(invocation.command, "knowledge.create_note");
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
                output: serde_json::json!({ "note_id": "n1" })
            }
            .output(),
            Some(&serde_json::json!({ "note_id": "n1" }))
        );
    }
}
