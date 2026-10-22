//! The manifest, embedded and parsed rather than restated.
//!
//! It is embedded with `include_str!` so a shipped binary carries the manifest it was built with,
//! and parsed by the kit at load time. Each action's `input` is the vault command's own schema,
//! copied verbatim; `every_action_is_a_vault_command_with_its_schema` proves it, because two
//! copies of "what does `measurement.record` take" is how the two answers drift.

use std::sync::OnceLock;

use centraid_apps_kit::actions::{ActionRow, act};
use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id: what a surface keys on.
pub const APP_ID: &str = "health";

/// The action each vault command is declared as.
pub const ACTIONS: [ActionRow; 3] = [
    act("record-days", "measurement.record"),
    act("follow-workouts", "follow.health"),
    act("delete-workout", "entity.trash"),
];

/// The parsed manifest.
///
/// # Panics
///
/// If the committed manifest does not parse, which `the_committed_manifest_parses_and_is_healths`
/// keeps unreachable.
pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| {
        parse_manifest(MANIFEST_JSON).expect("crates/apps/health/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::manifest::{CANONICAL_DESIGNED_STATES, Confirmation};

    #[test]
    fn the_committed_manifest_parses_and_is_healths() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "0.2.0");
        let raw: serde_json::Value = serde_json::from_str(MANIFEST_JSON).unwrap();
        assert_eq!(raw["iconKey"], "Activity");
        // Identity hue 110, the widest free gap on the ring (R-1129-10).
        assert_eq!(raw["colorKey"], "olive");
    }

    #[test]
    fn it_declares_six_queries_and_three_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 6);
        for name in [
            "today",
            "series",
            "trends",
            "workouts",
            "workout",
            "follow-view",
        ] {
            assert!(manifest.query(name).is_some(), "no query {name}");
        }
        assert_eq!(manifest.actions.len(), ACTIONS.len());
        for row in ACTIONS {
            let (action, _) = (row.action, row.command);
            let declared = manifest.action(action).expect("declared");
            assert_eq!(declared.confirmation, Confirmation::None, "{action}");
        }
    }

    #[test]
    fn every_action_is_a_vault_command_with_its_schema() {
        let registry = centraid_vault::commands::Registry::with_system_commands()
            .expect("the registry builds");
        for ActionRow {
            action, command, ..
        } in ACTIONS
        {
            let registered = registry
                .get(command)
                .unwrap_or_else(|| panic!("{command} is not a vault command"));
            assert_eq!(
                &manifest().action(action).expect("declared").input,
                registered.schema(),
                "{action}'s input is not {command}'s schema"
            );
        }
    }

    /// HEALTH READS THE VAULT'S OWN TABLES AND WRITES THROUGH THREE COMMANDS: its days, the health
    /// follow and the shared trash. It reaches no other app's verbs.
    #[test]
    fn health_reads_the_vaults_tables_and_acts_through_three_commands() {
        use centraid_apps_kit::manifest::ScopeVerbs;
        let vault = manifest().vault.as_ref().expect("a vault block");
        for scope in &vault.scopes {
            assert_eq!(
                scope.verbs == ScopeVerbs::Read,
                scope.schema == "vault",
                "{}.{:?} is neither a read of the vault's tables nor an act on a command",
                scope.schema,
                scope.table
            );
        }
        let commands: Vec<&str> = ACTIONS.iter().map(|row| row.command).collect();
        assert_eq!(
            manifest().act_scope_disagreements(&commands),
            Vec::<String>::new()
        );
    }

    #[test]
    fn the_state_partition_is_closed_and_health_creates_no_tables() {
        let states = manifest().states.as_ref().expect("designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(states.excluded.is_empty());
        assert!(manifest().ext_tables.is_empty());
    }

    /// THE CATALOG NAMES THE COMMAND EACH ACTION RUNS, and it is the command
    /// the action table runs: chat's verb rows are generated from the first.
    #[test]
    fn every_action_declares_the_command_it_invokes() {
        for ActionRow {
            action, command, ..
        } in super::ACTIONS
        {
            let declared = manifest().action(action).expect("a declared action");
            assert_eq!(declared.command, command, "{action}");
        }
    }
}
