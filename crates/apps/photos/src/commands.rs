//! THE 18 ACTIONS, as command invocations.
//!
//! Every Photos action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app
//! (`packages/blueprints/apps/_shared/action-kit.ts`). So this module is a
//! table, not logic.
//!
//! **Three of the eighteen invoke a command outside `media.*`**, and that is
//! the point a schema-first port loses: `tag-asset` and `untag-asset` write
//! through `core.tag_item`/`core.untag_item` because a free-form label is one
//! shared "Tags" concept scheme across every app, and `request-enrichment`
//! writes `enrich.request_enrichment` — **the only action in any app that
//! writes to `enrich`** (census §A2).
//!
//! **`invoke_key` is mandatory** (D-1020-D3-5); v0's falls back to the call's
//! ordinal, which is stable only for a handler that makes the same call
//! sequence every time.
//!
//! **A denial is a value, never an `Err`** (#1020 apps seam 10).
//!
//! **`online_only` is empty for Photos, and that is a checked claim.** Locker
//! declares `ONLINE_ONLY_ACTIONS` in `packages/blueprints/apps/locker/writes.ts`;
//! `packages/blueprints/apps/photos/` has no `writes.ts` at all
//! (`ls packages/blueprints/apps/photos | grep writes` prints nothing), and
//! `grep -rn ONLINE_ONLY packages/blueprints/apps/photos` finds none. So every
//! Photos action may be queued offline, including `upload` — which is the whole
//! point of a camera-roll backup that works on a plane.

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
    /// A seat refuses to QUEUE this offline. Photos declares none; see the
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

/// THE TABLE. Eighteen actions, eighteen commands, in the manifest's own order.
pub const ACTIONS: [ActionRow; 18] = [
    act("upload", "media.add_asset"),
    act("update-asset", "media.update_asset"),
    act("delete-asset", "media.delete_asset"),
    act("restore", "media.restore_asset"),
    confirmed("purge-asset", "media.purge_asset"),
    act("create-album", "media.create_album"),
    act("rename-album", "media.rename_album"),
    act("set-album-cover", "media.set_album_cover"),
    confirmed("delete-album", "media.delete_album"),
    act("restore-album", "media.restore_album"),
    act("add-to-album", "media.add_to_album"),
    act("remove-from-album", "media.remove_from_album"),
    act("answer-face", "media.answer_face_proposal"),
    act("set-place", "media.set_asset_place"),
    act("name-place", "media.name_place"),
    act("tag-asset", "core.tag_item"),
    act("untag-asset", "core.untag_item"),
    act("request-enrichment", "enrich.request_enrichment"),
];

/// The row for one action name.
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

/// `core.tag_item` is polymorphic over a SUBJECT type, and Photos' subjects are
/// always assets. The action's input names an `asset_id`; the command takes
/// `subject_type` + `subject_id` (`packages/vault/src/commands/tags.ts:80-85`,
/// and `crates/vault/src/commands/core.rs`'s `TAGGABLE`).
const TAG_SUBJECT_TYPE: &str = "media.asset";

/// **The capability stays pinned to `faces`, and it is the CONSENT SCOPE**
/// (#352, `actions/request-enrichment.ts:3`). Before `enrich_request` carried
/// one, the owner's on-demand ask was untagged, so a face-detection consent
/// handed the same queue row to every enabled enricher and each one read the
/// member's "detect faces" as its own permission. A port that dropped the
/// field would re-open that.
const ENRICH_CAPABILITY: &str = "faces";

/// Run one of the app's actions.
///
/// The `input` is the body the dispatcher already validated against the
/// manifest's schema, so there is no second validation here.
///
/// Two translations happen, and both are v0's:
///
/// 1. `tag-asset`'s `{asset_id, label}` becomes `core.tag_item`'s
///    `{subject_type: "media.asset", subject_id, label}`, and `untag-asset`'s
///    `{tag_id}` passes straight through — **untag removes the edge by id,
///    never by label** (`actions/tag-asset.ts`, `actions/untag-asset.ts`).
/// 2. `request-enrichment` carries `reason: "manual"` and
///    `capability: "faces"`, and omits `entity_id` entirely when the caller
///    named none — the ask is "prioritise faces", not "enrich this one
///    photograph" (`actions/request-enrichment.ts`).
pub fn run(
    door: &dyn Commands,
    action: &str,
    input: BTreeMap<String, Value>,
    invoke_key: &str,
) -> Result<Outcome, CommandsUnavailable> {
    let Some(row) = action_row(action) else {
        return Ok(Outcome::Failed {
            reason: Some(format!("photos declares no action \"{action}\"")),
        });
    };
    let mut input = input;
    if row.action == "tag-asset" {
        let asset = input.remove("asset_id").unwrap_or(Value::Null);
        input.insert(
            "subject_type".to_owned(),
            Value::String(TAG_SUBJECT_TYPE.to_owned()),
        );
        input.insert("subject_id".to_owned(), asset);
    }
    if row.action == "request-enrichment" {
        input
            .entry("entity_type".to_owned())
            .or_insert_with(|| Value::String("media.asset".to_owned()));
        // An absent target is ABSENT, not null: `enrich_request.target_id` is
        // nullable and a JSON `null` is a value the schema refuses.
        if input.get("entity_id").is_some_and(Value::is_null) {
            input.remove("entity_id");
        }
        // `reason: "manual"` is the owner's ask, and the only reason an app may
        // write (`enrich_request.reason`'s CHECK admits `projected` too, and
        // that one is minted by the vault itself).
        input.insert("reason".to_owned(), Value::String("manual".to_owned()));
        input.insert(
            "capability".to_owned(),
            Value::String(ENRICH_CAPABILITY.to_owned()),
        );
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

    /// An in-memory door that records what it was asked.
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
        assert_eq!(ACTIONS.len(), 18);
    }

    /// Fifteen `media.*`, two `core.*`, one `enrich.*`. A port that put all
    /// eighteen under `media` would have moved the shared tag scheme into one
    /// app and given Photos its own enrichment queue.
    #[test]
    fn three_actions_reach_outside_the_media_schema() {
        let outside: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| !row.command.starts_with("media."))
            .map(|row| row.command)
            .collect();
        assert_eq!(
            outside,
            [
                "core.tag_item",
                "core.untag_item",
                "enrich.request_enrichment"
            ]
        );
    }

    #[test]
    fn no_photos_action_is_online_only() {
        assert!(ACTIONS.iter().all(|row| !row.online_only));
    }

    #[test]
    fn tagging_an_asset_names_the_target_type_the_shared_scheme_needs() {
        let door = RecordingDoor::executed();
        run(
            &door,
            "tag-asset",
            input(&[
                ("asset_id", Value::String("a-1".to_owned())),
                ("label", Value::String("sunset".to_owned())),
            ]),
            "photos.tag-asset",
        )
        .unwrap();
        let seen = door.seen.borrow();
        assert_eq!(seen[0].command, "core.tag_item");
        assert_eq!(
            seen[0].input.get("subject_type"),
            Some(&Value::String("media.asset".to_owned()))
        );
        assert_eq!(
            seen[0].input.get("subject_id"),
            Some(&Value::String("a-1".to_owned()))
        );
        assert!(
            !seen[0].input.contains_key("asset_id"),
            "the command takes subject_id, not asset_id"
        );
    }

    /// Untag removes the EDGE, by id. A port that removed by label would delete
    /// every photo's copy of the same word.
    #[test]
    fn untagging_passes_the_tag_id_through_and_never_a_label() {
        let door = RecordingDoor::executed();
        run(
            &door,
            "untag-asset",
            input(&[("tag_id", Value::String("t-9".to_owned()))]),
            "photos.untag-asset",
        )
        .unwrap();
        let seen = door.seen.borrow();
        assert_eq!(seen[0].command, "core.untag_item");
        assert_eq!(seen[0].input.len(), 1);
        assert!(seen[0].input.contains_key("tag_id"));
    }

    #[test]
    fn request_enrichment_is_a_manual_ask_with_a_default_target_type() {
        let door = RecordingDoor::executed();
        run(&door, "request-enrichment", BTreeMap::new(), "ask").unwrap();
        let seen = door.seen.borrow();
        assert_eq!(seen[0].command, "enrich.request_enrichment");
        assert_eq!(
            seen[0].input.get("reason"),
            Some(&Value::String("manual".to_owned()))
        );
        assert_eq!(
            seen[0].input.get("entity_type"),
            Some(&Value::String("media.asset".to_owned()))
        );
        // THE CONSENT SCOPE. Without it one enricher's consent is every
        // enricher's.
        assert_eq!(
            seen[0].input.get("capability"),
            Some(&Value::String("faces".to_owned()))
        );
        assert!(
            !seen[0].input.contains_key("entity_id"),
            "an absent target is absent, never a null"
        );
    }

    #[test]
    fn the_invoke_key_reaches_the_door_and_is_not_derivable_from_the_call_order() {
        let door = RecordingDoor::executed();
        run(
            &door,
            "purge-asset",
            input(&[("asset_id", Value::String("a-1".to_owned()))]),
            "photos.purge-asset",
        )
        .unwrap();
        assert_eq!(door.seen.borrow()[0].invoke_key, "photos.purge-asset");
    }

    #[test]
    fn a_denial_is_a_value_and_not_an_error() {
        let door = RecordingDoor::answering(Outcome::Denied {
            reason: Some("this app's grant was revoked".to_owned()),
            code: Some("VAULT_ACCESS".to_owned()),
        });
        let outcome = run(&door, "upload", BTreeMap::new(), "upload").unwrap();
        assert!(matches!(outcome, Outcome::Denied { .. }));
        assert!(outcome.output().is_none());
        assert!(!outcome.pending(), "a denial has settled");
    }

    #[test]
    fn an_absent_door_fails_closed_and_names_the_command() {
        let door = RecordingDoor::absent();
        assert_eq!(
            run(&door, "delete-asset", BTreeMap::new(), "delete"),
            Err(CommandsUnavailable {
                command: "media.delete_asset"
            })
        );
    }

    #[test]
    fn an_undeclared_action_is_refused_rather_than_panicking() {
        let door = RecordingDoor::executed();
        let outcome = run(&door, "delete-library", BTreeMap::new(), "x").unwrap();
        assert!(matches!(outcome, Outcome::Failed { .. }));
        assert!(door.seen.borrow().is_empty(), "nothing reached the vault");
    }
}
