//! THE TWENTY-NINE ACTIONS, as command invocations.
//!
//! Every People action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app
//! (`packages/blueprints/apps/_shared/action-kit.ts`). So this module is a
//! table, not logic. Twenty-nine actions over twenty-nine commands —
//! **twenty-eight `people.*` and one `core.merge_party`** — which is the
//! largest action surface in the tree and the reason the census calls People
//! the clearest lane-sizing signal in §A.
//!
//! ### The one action whose input the app RESHAPES, and why it is the only one
//!
//! `merge-people` takes `{source_party_id, target_party_id}` and sends
//! `{merged_party_id, survivor_party_id}` (`actions/merge-people.ts:17`-`:22`).
//! Every other action forwards its body verbatim, because the command's schema
//! is the contract and a reshaping app is a second schema. The rename is kept
//! rather than removed: `source`/`target` is what the merge SCREEN says, and
//! `survivor`/`merged` is what the ontology primitive says — the two words for
//! the surviving row are the difference between "the one you are keeping" and
//! "the one that still exists afterwards", and only the second is true.
//!
//! ### Finding PE-F1 — three `act` scopes name the wrong schema
//!
//! The manifest declares `{schema: "social", table: "save_contact_channel"}`,
//! `{…, "delete_contact_channel"}` and `{…, "undo_contact_channel"}` as its
//! three narrow `act` scopes. **No such commands exist.** The `social` schema's
//! four commands are `resolve_identity`, `draft_message`, `send_message` and
//! `mark_thread_read` (`packages/vault/src/commands/social.ts`); the three
//! contact-channel commands are `people.save_contact_channel`,
//! `people.delete_contact_channel` and `people.undo_contact_channel`
//! (`packages/vault/src/commands/people-organize.ts:49`, `:175`, `:251`). The
//! three actions work today only because `{schema: "people", verbs:
//! "read+act"}` covers the whole schema, so the narrow scopes are never
//! consulted. [`act_scope_schemas`] is derived from this table rather than
//! transcribed, and `the_three_social_act_scopes_name_no_social_command`
//! is the red that states it.
//!
//! ### Two gates, never one (census §A0)
//!
//! People declares `confirmation: "required"` on exactly **three** actions —
//! `trash-person`, `delete-contact-channel`, `merge-people` (D-1020-PE6) —
//! and that is the DISPATCHING SURFACE's gate. Of the twenty-nine commands
//! behind them exactly **one** carries the command-level `confirm`, and it is
//! not one of the two `people.*` ones: `core.merge_party` parks a **non-owner**
//! invocation regardless of risk, because an irreversible fold of one person
//! into another is not a thing an assistant does on the member's behalf
//! (`merge.ts:68`-`:70`). Collapsing the two gates would put a dialog in front
//! of the owner's own trash and drop the non-owner park on the merge.
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5); v0's falls back to the call's
//! ordinal, which is stable only for a handler that makes the same call
//! sequence every time.
//!
//! **A denial is a value, never an `Err`** (#1020 apps seam 10).
//!
//! **`online_only` is empty for People, and that is a checked claim.** Locker
//! declares `ONLINE_ONLY_ACTIONS` in
//! `packages/blueprints/apps/locker/writes.ts`; `grep -rn ONLINE_ONLY
//! packages/blueprints/apps/people` finds none, and `people/writes.ts` is the
//! shell's write door rather than a policy list. So every People action may be
//! queued offline — including `merge-people`, which is worth stating: the merge
//! is irreversible, and it is still durable in the outbox rather than refused,
//! because a member on a plane who has just noticed two cards for their
//! grandfather is not doing anything the vault should lose.

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
    /// invocation as failed rather than refusing the whole run. People has
    /// none — every action here is the member's own gesture.
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
    /// **QUEUED IS NOT A REFUSAL** (`writes.ts:51`-`:53`): it is durable in the
    /// outbox and already projected, so the row's pending chip carries it — and
    /// it offers no Undo, because a reverse write against a row the vault never
    /// saw is not a reversal.
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
    /// A seat refuses to QUEUE this offline. People declares none; see the
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

const fn confirmed(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::Required,
        online_only: false,
    }
}

/// THE TABLE. Twenty-nine actions, twenty-nine commands, in the manifest's own
/// order.
pub const ACTIONS: [ActionRow; 29] = [
    act("add-person", "people.add_person"),
    act("edit-person", "people.edit_person"),
    act("set-cadence", "people.set_cadence"),
    // The canonical party SURVIVES a trash; only the profile is dated shut.
    confirmed("trash-person", "people.trash_person"),
    act("restore-person", "people.restore_person"),
    act("undo-person", "people.undo_person"),
    act("log-interaction", "people.log_interaction"),
    act("star-person", "people.star_person"),
    act("unstar-person", "people.unstar_person"),
    act("move-person", "people.move_person"),
    act("add-note", "people.add_note"),
    act("add-task", "people.add_task"),
    act("complete-task", "people.complete_task"),
    act("reopen-task", "people.reopen_task"),
    act("add-important-date", "people.add_important_date"),
    act("toggle-reminder", "people.toggle_reminder"),
    act("add-relationship", "people.add_relationship"),
    act("add-gift", "people.add_gift"),
    act("toggle-gift", "people.toggle_gift"),
    act("add-debt", "people.add_debt"),
    act("settle-debt", "people.settle_debt"),
    act("create-list", "people.create_list"),
    act("rename-list", "people.rename_list"),
    act("delete-list", "people.delete_list"),
    act("add-journal-entry", "people.add_journal_entry"),
    act("save-contact-channel", "people.save_contact_channel"),
    confirmed("delete-contact-channel", "people.delete_contact_channel"),
    act("undo-contact-channel", "people.undo_contact_channel"),
    // THE ONTOLOGY PRIMITIVE. The only action that leaves the `people` schema,
    // the only one whose command parks a non-owner, and the only one whose
    // input the app renames.
    confirmed("merge-people", "core.merge_party"),
];

/// One action's row, by the name the manifest gives it.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

/// The schemas this table's commands actually belong to, deduplicated.
///
/// Derived rather than transcribed, because the manifest's own `act` scopes
/// disagree with it — see finding PE-F1 in the module note.
#[must_use]
pub fn act_scope_schemas() -> Vec<&'static str> {
    let mut schemas: Vec<&'static str> = ACTIONS
        .iter()
        .map(|row| {
            row.command
                .split_once('.')
                .map_or(row.command, |(at, _)| at)
        })
        .collect();
    schemas.sort_unstable();
    schemas.dedup();
    schemas
}

/// `merge-people`'s rename, in one place.
///
/// The merge SCREEN says source and target; the ontology primitive says merged
/// and survivor. A missing id is left out rather than sent as `null`, because
/// `core.merge_party`'s schema is `additionalProperties: false` with both ids
/// required and a `null` would be refused as the wrong TYPE rather than as a
/// missing id.
#[must_use]
pub fn merge_input(
    source_party_id: Option<&str>,
    target_party_id: Option<&str>,
) -> BTreeMap<String, Value> {
    let mut input = BTreeMap::new();
    if let Some(target) = target_party_id {
        input.insert(
            "survivor_party_id".to_owned(),
            Value::String(target.to_owned()),
        );
    }
    if let Some(source) = source_party_id {
        input.insert(
            "merged_party_id".to_owned(),
            Value::String(source.to_owned()),
        );
    }
    input
}

/// Build one action's invocation.
///
/// The input is the action's own, verbatim — with the single exception the
/// module note states, which is applied here rather than at the call site so
/// there is one place the two vocabularies meet.
#[must_use]
pub fn invocation_for(
    action: &str,
    invoke_key: &str,
    input: BTreeMap<String, Value>,
) -> Option<Invocation> {
    let row = action_row(action)?;
    let input = if row.action == "merge-people" {
        merge_input(
            input.get("source_party_id").and_then(Value::as_str),
            input.get("target_party_id").and_then(Value::as_str),
        )
    } else {
        input
    };
    Some(Invocation::new(row.command, invoke_key, input))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn twenty_nine_actions_invoke_twenty_nine_distinct_commands() {
        assert_eq!(ACTIONS.len(), 29);
        let mut commands: Vec<&str> = ACTIONS.iter().map(|row| row.command).collect();
        commands.sort_unstable();
        let before = commands.len();
        commands.dedup();
        assert_eq!(before, commands.len(), "no command is invoked twice");
        assert_eq!(
            ACTIONS
                .iter()
                .filter(|row| row.command.starts_with("people."))
                .count(),
            28,
            "twenty-eight of the twenty-nine are the people schema's"
        );
    }

    /// THE THREE MANIFEST CONFIRMATIONS (D-1020-PE6), and nothing else.
    #[test]
    fn three_actions_are_confirmed_by_the_dispatching_surface() {
        let required: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.confirm == Confirm::Required)
            .map(|row| row.action)
            .collect();
        assert_eq!(
            required,
            ["trash-person", "delete-contact-channel", "merge-people"]
        );
    }

    #[test]
    fn no_action_is_withheld_offline() {
        assert!(ACTIONS.iter().all(|row| !row.online_only));
        // Including the merge, which is irreversible and still durable.
        assert!(
            !action_row("merge-people")
                .expect("in the table")
                .online_only
        );
    }

    /// A DEMONSTRATED RED for finding PE-F1: the manifest's three `social.*`
    /// act scopes name commands the `social` schema does not own.
    #[test]
    fn the_three_social_act_scopes_name_no_social_command() {
        assert_eq!(act_scope_schemas(), ["core", "people"]);
        for channel in [
            "save-contact-channel",
            "delete-contact-channel",
            "undo-contact-channel",
        ] {
            let row = action_row(channel).expect("in the table");
            assert!(
                row.command.starts_with("people."),
                "{channel} invokes {}, and the manifest scopes it under `social`",
                row.command
            );
        }
    }

    /// The one input the app renames, and the shape a missing id takes.
    #[test]
    fn merge_people_renames_source_and_target_onto_merged_and_survivor() {
        let mut body = BTreeMap::new();
        body.insert(
            "source_party_id".to_owned(),
            Value::String("p-dup".to_owned()),
        );
        body.insert(
            "target_party_id".to_owned(),
            Value::String("p-keep".to_owned()),
        );
        let invocation = invocation_for("merge-people", "people:0", body).expect("in the table");
        assert_eq!(invocation.command, "core.merge_party");
        assert_eq!(
            invocation
                .input
                .get("merged_party_id")
                .and_then(Value::as_str),
            Some("p-dup")
        );
        assert_eq!(
            invocation
                .input
                .get("survivor_party_id")
                .and_then(Value::as_str),
            Some("p-keep")
        );
        assert!(
            !invocation.input.contains_key("source_party_id"),
            "the screen's vocabulary must not reach the command"
        );
        // A MISSING ID IS OMITTED, never `null`: the command's schema refuses
        // `additionalProperties` and requires both, so a `null` would be
        // refused as the wrong type rather than as the missing id it is.
        assert_eq!(merge_input(None, Some("p-keep")).len(), 1);
    }

    #[test]
    fn an_invocation_carries_its_key_and_an_unknown_action_has_none() {
        let invocation = invocation_for("add-person", "people:3", BTreeMap::new())
            .expect("add-person is in the table");
        assert_eq!(invocation.command, "people.add_person");
        assert_eq!(invocation.invoke_key, "people:3");
        assert!(!invocation.optional, "People has no decorating invocation");
        assert!(invocation_for("forget-everyone", "people:4", BTreeMap::new()).is_none());
    }

    /// A DENIAL IS A VALUE. The outcome enum carries it, and `output()` is
    /// `None` for every state but `Executed`.
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
                output: serde_json::json!({ "party_id": "p1" })
            }
            .output(),
            Some(&serde_json::json!({ "party_id": "p1" }))
        );
    }
}
