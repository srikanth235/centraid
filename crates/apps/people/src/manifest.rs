//! The manifest, embedded and parsed rather than restated.
//!
//! `manifest.json` is embedded with `include_str!`, verbatim, so a shipped
//! binary carries the manifest it was built with and never looks for a
//! repository path at runtime — the same reason `crates/ontology` embeds the
//! registries (`contracts/README.md`).

use std::sync::OnceLock;

use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id.
pub const APP_ID: &str = "people";

/// The parsed manifest.
///
/// # Panics
///
/// If the committed manifest does not parse — a build-time fact about a file in
/// this crate, not a runtime condition. `the_committed_manifest_parses` below
/// keeps the panic unreachable.
pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| {
        parse_manifest(MANIFEST_JSON).expect("crates/apps/people/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::manifest::{CANONICAL_DESIGNED_STATES, Confirmation, ScopeVerbs};

    use crate::commands::{ACTIONS, Confirm, act_scope_tables, action_row};
    use crate::queries::{ROSTER_MAX, ROSTER_MIN};

    #[test]
    fn the_committed_manifest_parses_and_is_people() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "0.2.0");
    }

    #[test]
    fn it_declares_five_queries_and_twenty_five_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 5);
        assert_eq!(manifest.actions.len(), 25);
        for name in ["people", "person", "dashboard", "search", "trash"] {
            assert!(manifest.query(name).is_some(), "no query {name}");
        }
        // The Journal is Notes': People writes an entry and Notes shows it.
        assert!(manifest.query("journal").is_none());
    }

    #[test]
    fn every_declared_action_has_a_command_and_every_command_an_action() {
        let manifest = manifest();
        for action in &manifest.actions {
            assert!(
                action_row(&action.name).is_some(),
                "the manifest declares {} and the command table does not",
                action.name
            );
        }
        // ORDER, not just membership: the table is the manifest's own order.
        let declared: Vec<&str> = manifest
            .actions
            .iter()
            .map(|action| action.name.as_str())
            .collect();
        let ported: Vec<&str> = ACTIONS.iter().map(|row| row.action).collect();
        assert_eq!(declared, ported);
    }

    /// The manifest's `confirmation` and the table's [`Confirm`] must agree,
    /// because the conversation surface reads one of them and the app the other.
    #[test]
    fn the_confirmation_of_every_action_agrees_with_the_manifest() {
        for row in ACTIONS {
            let declared = manifest()
                .action(row.action)
                .expect("checked above")
                .confirmation;
            let expected = match row.confirm {
                Confirm::None => Confirmation::None,
                Confirm::Required => Confirmation::Required,
            };
            assert_eq!(
                declared, expected,
                "{} disagrees about confirmation",
                row.action
            );
        }
    }

    /// THIRTY-THREE SCOPES: ten reads of the vault's own tables and one `act`
    /// per command the actions invoke. The `act` half is compared against the
    /// action table rather than transcribed: an action with no scope is an
    /// action the grant does not cover, and a scope with no action is reach
    /// nothing uses.
    #[test]
    fn it_declares_ten_reads_and_one_act_scope_per_command() {
        let manifest = manifest();
        let vault = manifest.vault.as_ref().expect("People declares its reach");
        assert_eq!(vault.scopes.len(), 33);
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
        // NOTHING WIDER and nothing revealed: no whole-schema grant, and
        // `reveal` is Locker's alone.
        assert!(
            vault
                .scopes
                .iter()
                .all(|scope| matches!(scope.verbs, ScopeVerbs::Read | ScopeVerbs::Act))
        );
        assert!(
            manifest.ext_tables.is_empty(),
            "People is a projection over the vault's own tables: no data of its own"
        );
    }

    #[test]
    fn the_state_partition_is_closed_and_people_designs_all_seven() {
        let states = manifest()
            .states
            .as_ref()
            .expect("People declares its designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(
            states.excluded.is_empty(),
            "People has no unrepresentable state; every exclusion needs a reason and a citation"
        );
    }

    /// THE WIDEST WINDOW IN THE TREE: `people.limit` is 20-10,000, five times
    /// every other app's. Read off the manifest rather than restated, because a
    /// clamp and a schema that disagree are a refusal a member cannot act on.
    #[test]
    fn the_rosters_window_is_the_one_the_manifest_declares() {
        let people = manifest().query("people").expect("the roster query");
        let limit = &people.input["properties"]["limit"];
        assert_eq!(limit["minimum"], serde_json::json!(ROSTER_MIN));
        assert_eq!(limit["maximum"], serde_json::json!(ROSTER_MAX));
    }

    /// An action's input carries every field its command takes: the manifest's
    /// schema is `additionalProperties: false`, so a field it does not declare is
    /// one the app can never send.
    #[test]
    fn an_action_declares_every_field_its_command_takes() {
        let fields = |action: &str| -> Vec<String> {
            let input = &manifest().action(action).expect("declared").input;
            let mut names: Vec<String> = input["properties"]
                .as_object()
                .expect("properties")
                .keys()
                .cloned()
                .collect();
            names.sort();
            names
        };
        assert_eq!(
            fields("edit-person"),
            [
                "birthday",
                "cadence_days",
                "id",
                "met",
                "nickname",
                "role",
                "sort_name",
                "title"
            ]
        );
        // `tz` is why a member east of UTC+11:59 does not file today's entry
        // under tomorrow.
        assert_eq!(
            fields("add-journal-entry"),
            ["entry_date", "mood", "text", "tz"]
        );
        assert_eq!(
            fields("save-contact-channel"),
            ["id", "kind", "label", "point_id", "preferred", "value"]
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
