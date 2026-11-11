//! The manifest, embedded and parsed rather than restated.
//!
//! `manifest.json` is embedded with `include_str!`, verbatim, so a shipped
//! binary carries the manifest it was built with and never looks for a
//! repository path at runtime — the same reason `crates/ontology` embeds the
//! registries.

use std::sync::OnceLock;

use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id.
pub const APP_ID: &str = "calendar";

/// The parsed manifest.
///
/// # Panics
///
/// If the committed manifest does not parse — a build-time fact about a file in
/// this crate, not a runtime condition.
pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| {
        parse_manifest(MANIFEST_JSON).expect("crates/apps/calendar/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::manifest::{CANONICAL_DESIGNED_STATES, Confirmation, ScopeVerbs};

    use crate::commands::{ACTIONS, Confirm};

    #[test]
    fn the_committed_manifest_parses_and_is_calendar() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "1.0.0");
    }

    #[test]
    fn it_declares_seven_queries_and_fourteen_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 8);
        assert_eq!(manifest.actions.len(), 22);
        for name in [
            "upcoming",
            "search",
            "day-context",
            "parties",
            "event",
            "attachments",
            "dated-reminders",
        ] {
            assert!(manifest.query(name).is_some(), "no query {name}");
        }
    }

    /// LEAST PRIVILEGE (rounds 10 and 12): a reminder on a Calendar day can be ticked complete and
    /// ticked back there, as in Apple's Calendar, but the write is REMINDERS' OWN `complete-task` and
    /// `reopen-task`, sent by the screen under Reminders' name. So Calendar READS `task` (a title, a
    /// due day and time, the state) and holds no general task write and no complete or uncomplete
    /// permission either: no scope on `task` but the read, no `task.*` command, no action of that
    /// kind among its fourteen.
    #[test]
    fn calendar_reads_reminders_and_holds_no_task_write_the_tick_is_reminders() {
        let vault = manifest().vault.as_ref().expect("reach");
        for scope in &vault.scopes {
            if scope.table.as_deref() == Some("task") || scope.schema == "task" {
                assert!(
                    scope.verbs == ScopeVerbs::Read && scope.schema == "vault",
                    "Calendar's only scope on a task is the read: {}.{:?}",
                    scope.schema,
                    scope.table
                );
            }
        }
        for action in &manifest().actions {
            assert!(
                !action.name.contains("task") && !action.command.contains("task"),
                "Calendar names no task action, complete and uncomplete included: {}",
                action.name
            );
        }
        assert!(vault.scopes.iter().any(|s| s.schema == "vault"
            && s.table.as_deref() == Some("task")
            && s.verbs == ScopeVerbs::Read));
        assert!(
            vault
                .scopes
                .iter()
                .all(|s| !(s.verbs == ScopeVerbs::Act && s.schema == "task")),
            "Calendar acts on no task command"
        );
        assert!(
            manifest()
                .actions
                .iter()
                .all(|a| !a.command.starts_with("task."))
        );
    }

    #[test]
    fn every_declared_action_has_a_command_and_every_command_an_action() {
        let manifest = manifest();
        for action in &manifest.actions {
            assert!(
                crate::commands::action_row(&action.name).is_some(),
                "the manifest declares {} and the command table does not",
                action.name
            );
        }
        for row in ACTIONS {
            assert!(
                manifest.action(row.action).is_some(),
                "the command table names {} and the manifest does not",
                row.action
            );
        }
    }

    /// **AGENDA CONFIRMS NOTHING IN v0, INCLUDING `cancel-event`** (census §A0,
    /// §A seams 7). The port reproduces that faithfully and the question goes
    /// to the owner as a finding rather than being answered in code
    /// (D-1020-S6): `cancel-event` is as destructive as `delete-note`, which
    /// Notes confirms.
    ///
    /// **This is not the command's `confirm`** — two different gates. The
    /// `event.*` commands behind `cancel-event`, `edit-event` and
    /// `edit-occurrence` DO carry the command-level gate, which parks a
    /// NON-OWNER invocation regardless of risk; what is absent here is the
    /// owner-facing prompt on the member's own gesture.
    ///
    /// The exceptions are `purge-event` and `empty-trash` (#1185), the irreversible acts: they
    /// confirm, as every other app's destroys do; so does `stop-following`, which cannot be taken
    /// back by one action.
    #[test]
    fn calendar_confirms_nothing_and_the_command_gate_is_the_other_one() {
        for row in ACTIONS {
            let declared = manifest()
                .action(row.action)
                .expect("checked above")
                .confirmation;
            let expected = if matches!(
                row.action,
                "purge-event"
                    | "empty-trash"
                    | "stop-following"
                    | "delete-calendar"
                    | "restore-calendar"
            ) {
                (Confirmation::Required, Confirm::Required)
            } else {
                (Confirmation::None, Confirm::None)
            };
            assert_eq!((declared, row.confirm), expected, "{}", row.action);
        }
    }

    /// THE SCOPES: reads of the vault's own tables and one `act` per command the actions invoke.
    /// The `act` half is compared against the action table rather than transcribed: an action with
    /// no scope is an action the grant does not cover, and a scope with no action is reach nothing
    /// uses.
    #[test]
    fn it_declares_its_reads_and_one_act_scope_per_command() {
        let manifest = manifest();
        let vault = manifest
            .vault
            .as_ref()
            .expect("Calendar declares its reach");
        let mut declared: Vec<(&str, &str)> = vault
            .scopes
            .iter()
            .filter(|scope| scope.verbs == ScopeVerbs::Act)
            .map(|scope| {
                (
                    scope.schema.as_str(),
                    scope
                        .table
                        .as_deref()
                        .expect("an act scope names a command"),
                )
            })
            .collect();
        declared.sort_unstable();
        assert_eq!(declared, crate::commands::act_scope_tables());
        let reads: Vec<&str> = vault
            .scopes
            .iter()
            .filter(|scope| scope.verbs == ScopeVerbs::Read)
            .map(|scope| {
                assert_eq!(scope.schema, "vault");
                scope.table.as_deref().expect("a read names a table")
            })
            .collect();
        assert_eq!(reads.len(), 12);
        assert!(
            vault
                .scopes
                .iter()
                .all(|scope| matches!(scope.verbs, ScopeVerbs::Read | ScopeVerbs::Act)),
            "nothing wider and nothing revealed: `reveal` is Locker's alone"
        );
        assert!(
            manifest.ext_tables.is_empty(),
            "Calendar is a projection over the vault's own tables: no data of its own"
        );
    }

    /// Calendar is record-only: no bytes, every seat, and the calendar is its
    /// north star.
    #[test]
    fn it_is_record_only_and_enabled_on_every_seat() {
        let raw: serde_json::Value =
            serde_json::from_str(MANIFEST_JSON).expect("the manifest is JSON");
        assert_eq!(raw["seats"]["byteBearing"], serde_json::json!(false));
        assert_eq!(raw["seats"]["disabledOn"], serde_json::json!([]));
        assert_eq!(raw["seats"]["originActs"], serde_json::json!([]));
        assert_eq!(
            raw["seats"]["northStar"],
            serde_json::json!("google-calendar")
        );
        assert_eq!(raw["actionSideEffect"], serde_json::json!("vault-write"));
    }

    #[test]
    fn the_state_partition_is_closed_and_designs_all_seven() {
        let states = manifest()
            .states
            .as_ref()
            .expect("Calendar declares its designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(
            states.excluded.is_empty(),
            "Calendar has no unrepresentable state"
        );
    }

    /// THE ACT SCOPES AND THE ACTIONS AGREE, both ways (finding PE-F1, P3): a
    /// narrow `act` scope names a command some action invokes, and every
    /// action's command is covered by a scope. A scope no action uses declares a
    /// command the app never calls.
    #[test]
    fn every_act_scope_names_a_command_an_action_invokes_and_every_command_is_covered() {
        let commands: Vec<&str> = crate::commands::ACTIONS
            .iter()
            .map(|row| row.command)
            .collect();
        assert_eq!(
            manifest().act_scope_disagreements(&commands),
            Vec::<String>::new()
        );
    }

    /// THE CATALOG NAMES THE COMMAND EACH ACTION RUNS, and it is the command
    /// the action table runs: chat's verb rows are generated from the first and
    /// executed through the second.
    #[test]
    fn every_action_declares_the_command_its_row_invokes() {
        for row in crate::commands::ACTIONS {
            let declared = manifest().action(row.action).expect("a declared action");
            assert_eq!(declared.command, row.command, "{}", row.action);
        }
    }
}
