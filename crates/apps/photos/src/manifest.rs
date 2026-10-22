//! The manifest, embedded and parsed rather than restated.
//!
//! `manifest.json` matches v0's manifest byte for byte.
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
        assert_eq!(manifest.version, "0.5.0");
    }

    #[test]
    fn it_declares_three_queries_and_nineteen_actions() {
        let manifest = manifest();
        // v0's eight less `faces`, `face-queue` and `people` (Q-1047-2), and less
        // `storage` and `enrichment-status`, whose producers left with the custody
        // sweep and the enricher (R-1135-5).
        assert_eq!(manifest.queries.len(), 3);
        assert_eq!(manifest.actions.len(), 19);
        for name in ["library", "search", "duplicates"] {
            assert!(manifest.query(name).is_some(), "no query {name}");
        }
        for name in [
            "faces",
            "face-queue",
            "people",
            "storage",
            "enrichment-status",
        ] {
            assert!(
                manifest.query(name).is_none(),
                "the retired query {name} is back"
            );
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
    /// `purge-photo` and `delete-album`; no command this build carries sets the
    /// command-level gate.
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
        assert_eq!(required, ["purge-photo", "delete-album"]);
    }

    /// PHOTOS' ACTIONS INVOKE ITS OWN VERBS AND THE SHARED ONES, and the table says
    /// so. What each command wrote is the commit's own census, not a list a
    /// manifest carries (V3).
    #[test]
    fn every_action_invokes_a_photo_verb_or_a_shared_one() {
        for row in ACTIONS {
            let schema = row.command.split('.').next().unwrap_or_default();
            assert!(
                [
                    "photo",
                    "album",
                    "entity",
                    "flag",
                    "tag",
                    "edge",
                    "container"
                ]
                .contains(&schema),
                "{} invokes {}, which is outside Photos' reach",
                row.action,
                row.command
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
    fn it_declares_twenty_two_scopes_seven_reads_and_one_act_per_command() {
        use centraid_apps_kit::manifest::ScopeVerbs;

        let manifest = manifest();
        let vault = manifest
            .vault
            .as_ref()
            .expect("Photos declares its vault reach");
        assert_eq!(vault.scopes.len(), 22);
        let mut reads: Vec<&str> = vault
            .scopes
            .iter()
            .filter(|scope| scope.verbs == ScopeVerbs::Read)
            .map(|scope| {
                assert_eq!(scope.schema, "vault");
                scope.table.as_deref().expect("a read names its table")
            })
            .collect();
        reads.sort_unstable();
        assert_eq!(
            reads,
            [
                "blob",
                "container",
                "derivative",
                "edge",
                "entity",
                "photo",
                "place"
            ]
        );
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
                        .expect("an act scope over a whole schema would be the widest form"),
                )
            })
            .collect();
        declared.sort_unstable();
        assert_eq!(declared, crate::commands::act_scope_tables());
        assert_eq!(declared.len(), 15);
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
