//! The manifest, embedded and parsed rather than restated.
//!
//! It is embedded with `include_str!` so a shipped binary carries the manifest
//! it was built with and never looks for a repository path at runtime, and it
//! is parsed by the kit at load time: two copies of "which tables does Money
//! write" is how the two answers drift, and the drift is invisible because both
//! copies look right. Each action's `input` is the vault command's own schema,
//! copied verbatim; `the_action_schemas_are_the_vaults` proves it.

use std::sync::OnceLock;

use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id: what a surface keys on.
pub const APP_ID: &str = "money";

/// The parsed manifest.
///
/// # Panics
///
/// If the committed manifest does not parse, which `the_committed_manifest_parses`
/// keeps unreachable.
pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| {
        parse_manifest(MANIFEST_JSON).expect("crates/apps/money/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{ACTIONS, Confirm, action_row};
    use centraid_apps_kit::manifest::{CANONICAL_DESIGNED_STATES, Confirmation, ScopeVerbs};

    #[test]
    fn the_committed_manifest_parses_and_is_moneys() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "0.1.0");
        let raw: serde_json::Value = serde_json::from_str(MANIFEST_JSON).unwrap();
        assert_eq!(raw["iconKey"], "Coin");
        assert_eq!(raw["colorKey"], "indigo", "R-1099-23");
    }

    #[test]
    fn it_declares_eleven_queries_and_twenty_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 11);
        assert_eq!(manifest.actions.len(), 20);
        for name in [
            "spending",
            "activity",
            "transaction",
            "cashflow",
            "accounts",
            "rules",
            "categories",
            "target-sheet",
            "recurring",
            "home-tile",
            "search",
        ] {
            assert!(manifest.query(name).is_some(), "no query {name}");
        }
    }

    #[test]
    fn every_declared_action_has_a_command_and_every_command_an_action() {
        for action in &manifest().actions {
            assert!(
                action_row(&action.name).is_some(),
                "{} has no command",
                action.name
            );
        }
        for row in ACTIONS {
            assert!(
                manifest().action(row.action).is_some(),
                "{} is undeclared",
                row.action
            );
        }
    }

    #[test]
    fn the_confirmation_of_every_action_agrees_with_the_table() {
        for row in ACTIONS {
            let declared = manifest()
                .action(row.action)
                .expect("declared")
                .confirmation;
            let expected = match row.confirm {
                Confirm::None => Confirmation::None,
                Confirm::Required => Confirmation::Required,
            };
            assert_eq!(declared, expected, "{}", row.action);
        }
    }

    #[test]
    fn every_action_declares_the_tables_it_writes_and_only_money_and_the_spine() {
        for action in &manifest().actions {
            assert!(
                !action.writes.is_empty(),
                "{} declares no writes",
                action.name
            );
        }
        for table in manifest().declared_writes() {
            let schema = table.split('.').next().unwrap_or_default();
            assert!(
                ["money", "core"].contains(&schema),
                "{table} is outside Money's reach"
            );
        }
    }

    #[test]
    fn a_table_an_action_writes_is_a_table_the_app_may_act_on() {
        let vault = manifest().vault.as_ref().expect("a vault block");
        for table in manifest().declared_writes() {
            let (schema, name) = table.split_once('.').expect("schema.table");
            let scope = vault
                .scopes
                .iter()
                .find(|s| s.schema == schema && s.table.as_deref() == Some(name))
                .unwrap_or_else(|| panic!("no scope for {table}"));
            assert_eq!(scope.verbs, ScopeVerbs::ReadAct, "{table}");
        }
    }

    #[test]
    fn the_state_partition_is_closed_and_money_designs_all_seven() {
        let states = manifest().states.as_ref().expect("designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(states.excluded.is_empty());
    }

    #[test]
    fn it_creates_no_tables_of_its_own() {
        assert!(manifest().ext_tables.is_empty());
    }
}
