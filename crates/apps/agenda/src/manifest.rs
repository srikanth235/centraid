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
pub const APP_ID: &str = "agenda";

/// The parsed manifest.
///
/// # Panics
///
/// If the committed manifest does not parse — a build-time fact about a file in
/// this crate, not a runtime condition.
pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| {
        parse_manifest(MANIFEST_JSON).expect("crates/apps/agenda/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::manifest::{CANONICAL_DESIGNED_STATES, Confirmation, ScopeVerbs};

    use crate::commands::{ACTIONS, Confirm};

    #[test]
    fn the_committed_manifest_parses_and_is_agenda() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "0.6.0");
    }

    #[test]
    fn it_declares_four_queries_and_seven_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 4);
        assert_eq!(manifest.actions.len(), 7);
        for name in ["upcoming", "search", "day-context", "parties"] {
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
    #[test]
    fn agenda_confirms_nothing_and_the_command_gate_is_the_other_one() {
        for row in ACTIONS {
            let declared = manifest()
                .action(row.action)
                .expect("checked above")
                .confirmation;
            assert_eq!(declared, Confirmation::None, "{}", row.action);
            assert_eq!(row.confirm, Confirm::None, "{}", row.action);
        }
    }

    /// SEVENTEEN SCOPES: ten reads of the vault's own tables and one `act` per
    /// command the actions invoke. The `act` half is compared against the action
    /// table rather than transcribed: an action with no scope is an action the
    /// grant does not cover, and a scope with no action is reach nothing uses.
    #[test]
    fn it_declares_ten_reads_and_one_act_scope_per_command() {
        let manifest = manifest();
        let vault = manifest.vault.as_ref().expect("Agenda declares its reach");
        assert_eq!(vault.scopes.len(), 17);
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
        assert_eq!(reads.len(), 10);
        assert!(
            vault
                .scopes
                .iter()
                .all(|scope| matches!(scope.verbs, ScopeVerbs::Read | ScopeVerbs::Act)),
            "nothing wider and nothing revealed: `reveal` is Locker's alone"
        );
        assert!(
            manifest.ext_tables.is_empty(),
            "Agenda is a projection over the vault's own tables: no data of its own"
        );
    }

    /// Agenda is record-only: no bytes, every seat, and the calendar is its
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
    fn the_state_partition_is_closed_and_agenda_designs_all_seven() {
        let states = manifest()
            .states
            .as_ref()
            .expect("Agenda declares its designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(
            states.excluded.is_empty(),
            "Agenda has no unrepresentable state"
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
