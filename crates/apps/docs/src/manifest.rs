//! The manifest, embedded and parsed rather than restated.
//!
//! `manifest.json` is `packages/blueprints/apps/docs/app.json` byte for byte.
//! It is embedded with `include_str!` so a shipped binary carries the manifest
//! it was built with and never looks for a repository path at runtime — the
//! same reason `crates/ontology` embeds the registries (`contracts/README.md`).

use std::sync::OnceLock;

use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id.
pub const APP_ID: &str = "docs";

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
        parse_manifest(MANIFEST_JSON).expect("crates/apps/docs/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::manifest::{CANONICAL_DESIGNED_STATES, Confirmation, ScopeVerbs};

    use crate::commands::{ACTIONS, Confirm, act_scope_tables};

    #[test]
    fn the_committed_manifest_parses_and_is_docs() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "0.4.0");
    }

    #[test]
    fn it_declares_four_queries_and_sixteen_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 4);
        assert_eq!(manifest.actions.len(), 16);
        // The four are `drive`, `search`, `history`, `activity` — NOT the
        // directory listing: `queries/_shared.ts` and
        // `queries/document-origins.ts` are helpers beside the handlers, and
        // the dispatcher resolves `queries/<name>.ts` rather than scanning the
        // directory (`_shared.ts:1`-`:5`).
        for name in ["drive", "search", "history", "activity"] {
            assert!(manifest.query(name).is_some(), "no query {name}");
        }
        assert!(manifest.query("document-origins").is_none());
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

    /// v0's `confirmation` and the port's [`Confirm`] must agree, because the
    /// conversation surface reads one of them and the app reads the other.
    ///
    /// **This is not the command's `confirm`** (census §A0): `confirmation` is a
    /// manifest field the dispatching surface reads, and `confirm` on a command
    /// definition parks a NON-OWNER invocation regardless of risk. Docs'
    /// one manifest-confirmed action is `empty-trash`, and no `core.*` command
    /// this build carries sets the command-level gate at all.
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
        let required: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.confirm == Confirm::Required)
            .map(|row| row.action)
            .collect();
        assert_eq!(required, ["empty-trash"]);
    }

    #[test]
    fn every_action_declares_the_tables_it_writes() {
        for action in &manifest().actions {
            assert!(
                !action.writes.is_empty(),
                "{} declares no writes, but every Docs action writes",
                action.name
            );
        }
        for table in manifest().declared_writes() {
            let schema = table.split('.').next().unwrap_or_default();
            assert_eq!(schema, "core", "{table} is outside Docs' reach");
        }
    }

    /// THIRTY-FOUR SCOPES: eighteen reads over five schemas, and **sixteen
    /// `act` scopes, one per action** (census §A0's table).
    ///
    /// The `act` half is compared against the action table rather than
    /// transcribed, because the whole point of the narrow form is that it
    /// tracks the actions: a seventeenth action with no scope is an action the
    /// grant does not cover, and a scope with no action is reach nothing uses.
    #[test]
    fn it_declares_thirty_four_scopes_with_one_act_scope_per_action() {
        let manifest = manifest();
        let vault = manifest.vault.as_ref().expect("Docs declares its reach");
        assert_eq!(vault.scopes.len(), 34);

        let mut schemas: Vec<&str> = vault
            .scopes
            .iter()
            .map(|scope| scope.schema.as_str())
            .collect();
        schemas.sort_unstable();
        schemas.dedup();
        assert_eq!(schemas, ["access", "blob", "core", "share", "social"]);

        let mut declared_acts: Vec<&str> = vault
            .scopes
            .iter()
            .filter(|scope| scope.verbs == ScopeVerbs::Act)
            .map(|scope| {
                scope
                    .table
                    .as_deref()
                    .expect("an act scope over a whole schema would be the widest form")
            })
            .collect();
        declared_acts.sort_unstable();
        assert_eq!(declared_acts, act_scope_tables());
        assert_eq!(declared_acts.len(), 16);

        let reads = vault
            .scopes
            .iter()
            .filter(|scope| scope.verbs == ScopeVerbs::Read)
            .count();
        assert_eq!(reads, 18);
        // NOTHING WIDER, and nothing revealed: `read+act` over a whole schema
        // is the widest form and only agenda and people use it; `reveal` is
        // Locker's alone.
        assert!(
            vault
                .scopes
                .iter()
                .all(|scope| scope.verbs == ScopeVerbs::Read || scope.verbs == ScopeVerbs::Act),
            "Docs declares no read+act and no reveal"
        );
        assert!(
            manifest.ext_tables.is_empty(),
            "Docs is a projection over the vault's own tables: no data of its own"
        );
    }

    /// Docs is byte-bearing, enabled on every seat, and its origin act is the
    /// scanner. `disabledOn` is empty here, unlike Locker's stale `["viewer"]`
    /// (census §A seam 1) — nothing to re-judge for this app.
    #[test]
    fn it_is_byte_bearing_with_the_scanner_as_its_origin_act() {
        let raw: serde_json::Value =
            serde_json::from_str(MANIFEST_JSON).expect("the manifest is JSON");
        assert_eq!(raw["seats"]["byteBearing"], serde_json::json!(true));
        assert_eq!(raw["seats"]["disabledOn"], serde_json::json!([]));
        assert_eq!(raw["seats"]["originActs"], serde_json::json!(["scanner"]));
        assert_eq!(raw["seats"]["northStar"], serde_json::json!("google-drive"));
        assert_eq!(raw["actionSideEffect"], serde_json::json!("vault-write"));
    }

    #[test]
    fn the_state_partition_is_closed_and_docs_designs_all_seven() {
        let states = manifest()
            .states
            .as_ref()
            .expect("Docs declares its designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(
            states.excluded.is_empty(),
            "Docs has no unrepresentable state; every exclusion needs a reason and a citation"
        );
    }

    /// The drive's declared window, which [`crate::queries::DriveInput`] clamps
    /// to. Read off the manifest rather than restated, because the clamp and the
    /// schema disagreeing is a refusal a member cannot act on.
    #[test]
    fn the_drives_window_is_the_one_the_manifest_declares() {
        let drive = manifest().query("drive").expect("the drive query");
        let limit = &drive.input["properties"]["limit"];
        assert_eq!(limit["minimum"], serde_json::json!(20));
        assert_eq!(limit["maximum"], serde_json::json!(2000));
        assert_eq!(
            u64::try_from(crate::queries::DRIVE_MIN).unwrap_or_default(),
            limit["minimum"].as_u64().unwrap_or_default()
        );
        assert_eq!(
            u64::try_from(crate::queries::DRIVE_MAX).unwrap_or_default(),
            limit["maximum"].as_u64().unwrap_or_default()
        );
    }
}
