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
        assert_eq!(manifest.version, "0.2.0");
        let raw: serde_json::Value = serde_json::from_str(MANIFEST_JSON).unwrap();
        assert_eq!(raw["iconKey"], "Coin");
        assert_eq!(raw["colorKey"], "indigo", "R-1099-23");
    }

    #[test]
    fn it_declares_eleven_queries_and_twenty_two_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 11);
        assert_eq!(manifest.actions.len(), 22);
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

    /// MONEY REACHES ITS OWN VERBS AND THE SHARED ONES, and the vault's own
    /// tables, read-only. What each command wrote is the commit's own census,
    /// not a list a manifest carries (V3).
    #[test]
    fn money_reaches_its_own_verbs_the_shared_ones_and_the_vaults_tables() {
        let vault = manifest().vault.as_ref().expect("a vault block");
        for scope in &vault.scopes {
            let reads = scope.verbs == ScopeVerbs::Read;
            assert_eq!(
                reads,
                scope.schema == "vault",
                "{}.{:?} is neither a read of the vault's tables nor an act on a command",
                scope.schema,
                scope.table
            );
        }
        for row in ACTIONS {
            let schema = row.command.split('.').next().unwrap_or_default();
            assert!(
                [
                    "account",
                    "txn",
                    "budget",
                    "checkpoint",
                    "rule",
                    "category",
                    "follow",
                    "entity",
                    "flag"
                ]
                .contains(&schema),
                "{} invokes {}, which is outside Money's reach",
                row.action,
                row.command
            );
        }
    }

    /// THE ACT SCOPES AND THE ACTIONS AGREE, both ways: a narrow `act` scope
    /// names a command some action invokes, and every action's command is
    /// covered by a scope.
    #[test]
    fn every_act_scope_names_a_command_an_action_invokes_and_every_command_is_covered() {
        let commands: Vec<&str> = ACTIONS.iter().map(|row| row.command).collect();
        assert_eq!(
            manifest().act_scope_disagreements(&commands),
            Vec::<String>::new()
        );
    }

    /// An action's input is its command's own schema, copied verbatim: two
    /// copies of "what does `txn.categorize` take" is how the two drift.
    #[test]
    fn every_action_is_a_vault_command_with_its_schema() {
        let registry = centraid_vault::commands::Registry::with_system_commands()
            .expect("the registry builds");
        for row in ACTIONS {
            let registered = registry
                .get(row.command)
                .unwrap_or_else(|| panic!("{} is not a vault command", row.command));
            assert_eq!(
                &manifest().action(row.action).expect("declared").input,
                registered.schema(),
                "{}'s input is not {}'s schema",
                row.action,
                row.command
            );
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
