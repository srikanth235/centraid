//! The manifest, embedded and parsed rather than restated.
//!
//! `manifest.json` is `packages/blueprints/apps/tally/app.json` byte for byte.
//! It is embedded with `include_str!` so a shipped binary carries the manifest
//! it was built with and never looks for a repository path at runtime — the
//! same reason `crates/ontology` embeds the registries
//! (`contracts/README.md`, "Why the registries are transcribed").
//!
//! Parsing it at load time rather than transcribing it into Rust types is the
//! point: two copies of "which tables does Tally write" is how the two answers
//! drift, and the drift is invisible because both copies look right.

use std::sync::OnceLock;

use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id. Named here because the crate's own name is a Rust fact and
/// the app id is a product one; a surface keys on this.
pub const APP_ID: &str = "tally";

/// The parsed manifest.
///
/// # Panics
///
/// If the committed manifest does not parse. That is a build-time fact about a
/// file in this crate, not a runtime condition: a Tally binary whose manifest
/// is unreadable has no queries and no actions, and there is nothing for it to
/// do but say so loudly. `the_committed_manifest_parses` below is the test that
/// keeps the panic unreachable.
pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| {
        parse_manifest(MANIFEST_JSON).expect("crates/apps/tally/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ACTIONS;
    use centraid_apps_kit::manifest::CANONICAL_DESIGNED_STATES;

    #[test]
    fn the_committed_manifest_parses_and_is_tallys() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "0.3.0");
    }

    #[test]
    fn it_declares_eight_queries_and_twenty_three_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 8);
        assert_eq!(manifest.actions.len(), 23);
        for name in [
            "dashboard",
            "group",
            "friend",
            "activity",
            "search",
            "history",
            "export",
            "matches",
        ] {
            assert!(manifest.query(name).is_some(), "no query {name}");
        }
    }

    /// The table in [`crate::commands`] and the manifest are two statements of
    /// the same fact, and this is what keeps them one.
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

    /// v0's `confirmation` and the port's `Confirm` must agree, because the
    /// conversation surface reads one of them and the app reads the other.
    #[test]
    fn the_confirmation_of_every_action_agrees_with_the_manifest() {
        use centraid_apps_kit::manifest::Confirmation;

        use crate::commands::Confirm;

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

    #[test]
    fn every_action_declares_the_tables_it_writes() {
        // `[]` is valid and says "no database writes"; Tally has no such
        // action, because every one of its 23 invokes a vault command.
        for action in &manifest().actions {
            assert!(
                !action.writes.is_empty(),
                "{} declares no writes, but every Tally action writes",
                action.name
            );
        }
        // Every declared table is one of the five schemas Tally reaches.
        for table in manifest().declared_writes() {
            let schema = table.split('.').next().unwrap_or_default();
            assert!(
                ["tally", "core", "social", "schedule"].contains(&schema),
                "{table} is outside Tally's reach"
            );
        }
    }

    #[test]
    fn the_state_partition_is_closed_and_tally_designs_all_seven() {
        let states = manifest()
            .states
            .as_ref()
            .expect("Tally declares its designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(
            states.excluded.is_empty(),
            "Tally has no unrepresentable state; every exclusion needs a reason and a citation"
        );
    }

    #[test]
    fn it_declares_its_reach_and_creates_no_tables_of_its_own() {
        let manifest = manifest();
        let vault = manifest
            .vault
            .as_ref()
            .expect("Tally declares its vault reach");
        assert_eq!(vault.scopes.len(), 45);
        assert!(
            manifest.ext_tables.is_empty(),
            "Tally is a record-only app over the vault's own tables"
        );
    }
}
