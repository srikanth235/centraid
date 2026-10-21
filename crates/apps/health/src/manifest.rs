//! The manifest, embedded and parsed rather than restated.
//!
//! It is embedded with `include_str!` so a shipped binary carries the manifest it was built with,
//! and parsed by the kit at load time. Each action's `input` is the vault command's own schema,
//! copied verbatim; `every_action_is_a_vault_command_with_its_schema` proves it, because two
//! copies of "what does `health.record_days` take" is how the two answers drift.

use std::sync::OnceLock;

use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id: what a surface keys on.
pub const APP_ID: &str = "health";

/// The action each vault command is declared as.
pub const ACTIONS: [(&str, &str); 3] = [
    ("record-days", "health.record_days"),
    ("follow-workout", "health.follow_workout"),
    ("purge-workout", "health.purge_workout"),
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
        assert_eq!(manifest.version, "0.1.0");
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
        for (action, _) in ACTIONS {
            let declared = manifest.action(action).expect("declared");
            assert_eq!(declared.confirmation, Confirmation::None, "{action}");
        }
    }

    #[test]
    fn every_action_is_a_vault_command_with_its_schema() {
        let registry = centraid_vault::commands::Registry::with_system_commands()
            .expect("the registry builds");
        for (action, command) in ACTIONS {
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

    /// HEALTH READS THE SPINE AND THE PHONE BAND AND WRITES ONLY ITS OWN PACK; it reaches no
    /// other app's schema, and it writes nothing of the spine's directly (a workout's activity is
    /// written by `health.follow_workout`).
    #[test]
    fn health_reaches_its_pack_the_spine_and_the_phone_band() {
        let vault = manifest().vault.as_ref().expect("a vault block");
        for scope in &vault.scopes {
            assert!(
                ["health", "core", "phone"].contains(&scope.schema.as_str()),
                "{}.{:?} is outside Health's reach",
                scope.schema,
                scope.table
            );
        }
        for (_, command) in ACTIONS {
            assert!(command.starts_with("health."), "{command}");
        }
    }

    #[test]
    fn the_state_partition_is_closed_and_health_creates_no_tables() {
        let states = manifest().states.as_ref().expect("designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(states.excluded.is_empty());
        assert!(manifest().ext_tables.is_empty());
    }
}
