//! The manifest, embedded and parsed rather than restated.
//!
//! `manifest.json` is embedded verbatim, byte for byte.

use std::sync::OnceLock;

use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id.
pub const APP_ID: &str = "tasks";

/// The parsed manifest.
///
/// # Panics
///
/// If the committed manifest does not parse — a build-time fact about a file in
/// this crate, not a runtime condition.
pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| {
        parse_manifest(MANIFEST_JSON).expect("crates/apps/tasks/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::manifest::{CANONICAL_DESIGNED_STATES, Confirmation, ScopeVerbs};

    use crate::board::{BOARD_MAX, BOARD_MIN};
    use crate::commands::{ACTIONS, Confirm, act_scope_tables};

    #[test]
    fn the_committed_manifest_parses_and_is_tasks() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "0.4.0");
    }

    #[test]
    fn it_declares_six_queries_and_fifteen_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 6);
        assert_eq!(manifest.actions.len(), 15);
        for name in ["board", "search", "task", "projects", "catch-up", "trash"] {
            assert!(manifest.query(name).is_some(), "no query {name}");
        }
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

    /// **TASKS CONFIRMS NOTHING IN v0, INCLUDING `delete`** (census §A0, §A
    /// seam 7). Ported faithfully; the question goes to the owner as a finding
    /// rather than being answered in code (D-1020-S6). `delete` trashes a task
    /// AND every subtask under it, which is as destructive as `delete-note`.
    /// The one exception is `purge` (#1015 D1), which is not v0's and is the
    /// one irreversible act: it confirms, as every other app's destroy does.
    #[test]
    fn tasks_confirms_only_the_purge_and_the_delete_gate_is_a_finding() {
        for row in ACTIONS {
            let declared = manifest()
                .action(row.action)
                .expect("checked above")
                .confirmation;
            let expected = if row.action == "purge" {
                (Confirmation::Required, Confirm::Required)
            } else {
                (Confirmation::None, Confirm::None)
            };
            assert_eq!((declared, row.confirm), expected, "{}", row.action);
        }
    }

    /// TWENTY-ONE SCOPES: seven reads of the vault's own tables and one `act` per
    /// command the actions invoke (fourteen: `create-project` and
    /// `create-section` are one `container.create`). The `act` half is compared
    /// against the action table rather than transcribed.
    #[test]
    fn it_declares_seven_reads_and_one_act_scope_per_command() {
        let manifest = manifest();
        let vault = manifest.vault.as_ref().expect("Tasks declares its reach");
        assert_eq!(vault.scopes.len(), 21);
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
        assert_eq!(declared, act_scope_tables());
        assert_eq!(declared.len(), 14);
        let reads: Vec<&str> = vault
            .scopes
            .iter()
            .filter(|scope| scope.verbs == ScopeVerbs::Read)
            .map(|scope| {
                assert_eq!(scope.schema, "vault");
                scope.table.as_deref().expect("a read names a table")
            })
            .collect();
        assert_eq!(reads.len(), 7);
        assert!(
            vault
                .scopes
                .iter()
                .all(|scope| scope.verbs == ScopeVerbs::Read || scope.verbs == ScopeVerbs::Act),
            "Tasks declares no read+act and no reveal"
        );
        assert!(
            manifest.ext_tables.is_empty(),
            "Tasks is a projection over the vault's own tables: no data of its own"
        );
    }

    /// **THE BOARD'S WINDOW IS THE MANIFEST'S, AND IT IS THE ONLY BOUND**
    /// (census §A7). Read off the manifest rather than restated, because the
    /// clamp and the schema disagreeing is a refusal a member cannot act on.
    #[test]
    fn the_boards_window_is_the_one_the_manifest_declares() {
        let board = manifest().query("board").expect("the board query");
        let limit = &board.input["properties"]["limit"];
        assert_eq!(limit["minimum"], serde_json::json!(20));
        assert_eq!(limit["maximum"], serde_json::json!(500));
        assert_eq!(
            u64::try_from(BOARD_MIN).unwrap_or_default(),
            limit["minimum"].as_u64().unwrap_or_default()
        );
        assert_eq!(
            u64::try_from(BOARD_MAX).unwrap_or_default(),
            limit["maximum"].as_u64().unwrap_or_default()
        );
    }

    #[test]
    fn it_is_record_only_and_enabled_on_every_seat() {
        let raw: serde_json::Value =
            serde_json::from_str(MANIFEST_JSON).expect("the manifest is JSON");
        assert_eq!(raw["seats"]["byteBearing"], serde_json::json!(false));
        assert_eq!(raw["seats"]["disabledOn"], serde_json::json!([]));
        assert_eq!(raw["seats"]["originActs"], serde_json::json!([]));
        assert_eq!(raw["seats"]["northStar"], serde_json::json!("todoist"));
        assert_eq!(raw["actionSideEffect"], serde_json::json!("vault-write"));
    }

    #[test]
    fn the_state_partition_is_closed_and_tasks_designs_all_seven() {
        let states = manifest()
            .states
            .as_ref()
            .expect("Tasks declares its designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(
            states.excluded.is_empty(),
            "Tasks has no unrepresentable state"
        );
    }

    /// THE ACT SCOPES AND THE ACTIONS AGREE, both ways (finding PE-F1, P3): a
    /// narrow `act` scope names a command some action invokes, and every
    /// action's command is covered by a scope. A scope no action uses tells a
    /// consent screen the app reaches a command it never calls.
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
