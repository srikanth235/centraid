//! The manifest, embedded and parsed rather than restated.
//!
//! `manifest.json` is `packages/blueprints/apps/photos/app.json` byte for byte.
//! It is embedded with `include_str!` so a shipped binary carries the manifest
//! it was built with and never looks for a repository path at runtime — the
//! same reason `crates/ontology` embeds the registries (`contracts/README.md`).

use std::sync::OnceLock;

use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id.
pub const APP_ID: &str = "photos";

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
        parse_manifest(MANIFEST_JSON).expect("crates/apps/photos/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ACTIONS;
    use centraid_apps_kit::manifest::CANONICAL_DESIGNED_STATES;

    #[test]
    fn the_committed_manifest_parses_and_is_photos() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "0.4.1");
    }

    #[test]
    fn it_declares_eight_queries_and_eighteen_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 8);
        assert_eq!(manifest.actions.len(), 18);
        for name in [
            "storage",
            "library",
            "faces",
            "face-queue",
            "people",
            "search",
            "duplicates",
            "enrichment-status",
        ] {
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

    /// v0's `confirmation` and the port's `Confirm` must agree, because the
    /// conversation surface reads one of them and the app reads the other.
    ///
    /// **This is not the command's `confirm`** (census §A0): `confirmation` is a
    /// manifest field the dispatching surface reads, and `confirm` on a
    /// [`crate::commands`] target's definition parks a NON-OWNER invocation
    /// regardless of risk. Photos' two manifest-confirmed actions are
    /// `purge-asset` and `delete-album`; the only `media.*` command carrying
    /// the command-level gate is `media.forget_person`, which no Photos action
    /// invokes at all. Collapsing the two loses the non-owner park.
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
        let required: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.confirm == Confirm::Required)
            .map(|row| row.action)
            .collect();
        assert_eq!(required, ["purge-asset", "delete-album"]);
    }

    #[test]
    fn every_action_declares_the_tables_it_writes() {
        for action in &manifest().actions {
            assert!(
                !action.writes.is_empty(),
                "{} declares no writes, but every Photos action writes",
                action.name
            );
        }
        for table in manifest().declared_writes() {
            let schema = table.split('.').next().unwrap_or_default();
            assert!(
                ["media", "core", "enrich", "share"].contains(&schema),
                "{table} is outside Photos' reach"
            );
        }
    }

    #[test]
    fn the_state_partition_is_closed_and_photos_designs_all_seven() {
        let states = manifest()
            .states
            .as_ref()
            .expect("Photos declares its designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(
            states.excluded.is_empty(),
            "Photos has no unrepresentable state; every exclusion needs a reason and a citation"
        );
    }

    #[test]
    fn it_declares_thirty_eight_scopes_over_five_schemas_and_no_tables_of_its_own() {
        let manifest = manifest();
        let vault = manifest
            .vault
            .as_ref()
            .expect("Photos declares its vault reach");
        assert_eq!(vault.scopes.len(), 38);
        let mut schemas: Vec<&str> = vault
            .scopes
            .iter()
            .map(|scope| scope.schema.as_str())
            .collect();
        schemas.sort_unstable();
        schemas.dedup();
        assert_eq!(schemas, ["blob", "core", "enrich", "media", "social"]);
        assert!(
            manifest.ext_tables.is_empty(),
            "Photos is a projection over the vault's own tables"
        );
    }

    /// Photos is byte-bearing and enabled on every seat. `disabledOn` is empty
    /// here, unlike Locker's stale `["viewer"]` (census §A seam 1) — nothing to
    /// re-judge for this app.
    #[test]
    fn it_is_byte_bearing_and_disabled_on_no_seat() {
        let raw: serde_json::Value =
            serde_json::from_str(MANIFEST_JSON).expect("the manifest is JSON");
        assert_eq!(raw["seats"]["byteBearing"], serde_json::json!(true));
        assert_eq!(raw["seats"]["disabledOn"], serde_json::json!([]));
        assert_eq!(raw["seats"]["originActs"], serde_json::json!(["camera"]));
    }
}
