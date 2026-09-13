//! The manifest, embedded and parsed rather than restated — and the two fields
//! deleted from it, with the deletion itself under test (D-1020-L7).
//!
//! `manifest.json` is `packages/blueprints/apps/locker/app.json` with exactly
//! two keys removed. It is embedded with `include_str!` so a shipped binary
//! carries the manifest it was built with and never looks for a repository path
//! at runtime — the same reason `crates/ontology` embeds the registries
//! (`contracts/README.md`).
//!
//! Two copies of "which tables does Locker write" is how the two answers drift,
//! so nothing here restates a scope, an action or a query in Rust. What Rust
//! *does* hold is the pair of assertions a JSON file cannot make about itself:
//! that the diff against the oracle is those two deletions and nothing else,
//! and that every action in the manifest has a command and every command an
//! action.

use std::sync::OnceLock;

use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id.
pub const APP_ID: &str = "locker";

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
        parse_manifest(MANIFEST_JSON).expect("crates/apps/locker/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{ACTIONS, Confirm};
    use centraid_apps_kit::manifest::{CANONICAL_DESIGNED_STATES, Confirmation, ScopeVerbs};

    fn v0_app_json() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("packages/blueprints/apps/locker/app.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("reading the v0 oracle at {}: {error}", path.display()));
        serde_json::from_str(&text).expect("v0's app.json is JSON")
    }

    fn ours() -> serde_json::Value {
        serde_json::from_str(MANIFEST_JSON).expect("the manifest is JSON")
    }

    #[test]
    fn the_committed_manifest_parses_and_is_locker() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "0.3.0");
    }

    /// THE WHOLE OF D-1020-L7, AS A DIFF.
    ///
    /// The port removes `auth_session` from the `items` query's input and
    /// empties `seats.disabledOn`. This test applies those two edits to v0's
    /// own file and asserts the result is byte-identical to ours — so a third
    /// change, in either direction, is a red rather than a note somebody
    /// forgot to write.
    #[test]
    fn the_manifest_differs_from_v0_by_exactly_the_two_dead_fields() {
        let mut v0 = v0_app_json();

        // 1. `auth_session` is a permit-era parameter on a live query
        //    (#996 R13, `docs/decisions.md:92`, `:879`; OQ-10). It must EXIST
        //    in the oracle, or the deletion is no longer the deletion.
        let items = v0["queries"]
            .as_array_mut()
            .expect("v0 declares queries")
            .iter_mut()
            .find(|query| query["name"] == "items")
            .expect("v0 declares the items query");
        let properties = items["input"]["properties"]
            .as_object_mut()
            .expect("the items input is an object schema");
        assert!(
            properties.remove("auth_session").is_some(),
            "v0's items query no longer declares auth_session: D-1020-L7's first \
             deletion has already happened upstream and this port should carry the \
             field's absence rather than delete it"
        );

        // 2. Locker is ruled onto every seat including the PWA (#996 R13).
        assert_eq!(
            v0["seats"]["disabledOn"],
            serde_json::json!(["viewer"]),
            "v0's disabledOn moved; re-judge D-1020-L7's second deletion against it"
        );
        v0["seats"]["disabledOn"] = serde_json::json!([]);

        assert_eq!(
            v0,
            ours(),
            "the port's manifest differs from v0's by more than the two dead fields"
        );
    }

    #[test]
    fn it_declares_eight_queries_and_sixteen_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 8);
        assert_eq!(manifest.actions.len(), 16);
        for name in [
            "autofill-candidates",
            "autofill-item",
            "items",
            "item",
            "search",
            "watchtower",
            "trash",
            "access",
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

    /// THE TWO CONFIRMATION GATES, KEPT DISTINCT (census §A0, D-1020-L7).
    ///
    /// `confirmation` is the manifest field the **dispatching surface** reads;
    /// `confirm` on a command definition parks a **non-owner** invocation
    /// regardless of risk. Locker's manifest confirms two actions
    /// (`purge-item`, `export`) and the `locker.*` catalogue carries the
    /// command-level gate on exactly the two commands those actions invoke —
    /// which is a coincidence of count, not the same gate, and collapsing them
    /// loses the non-owner park.
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
        assert_eq!(required, ["purge-item", "export"]);
    }

    /// THE ONLY THREE `reveal` SCOPES IN THE PRODUCT, and they survive the
    /// custody change.
    ///
    /// What changes in wave 4 is **who** enforces them: the reveal runs on the
    /// seat that holds `K` (`crates/seat::locker`), so the declared reach is a
    /// clamp the seat applies rather than one the gateway does. The gateway's
    /// own `reveal` refuses the `locker` schema structurally — see
    /// `crates/vault::access` (D-1020-L2) — which is why these three scopes are
    /// not a gateway permission any more and are still exactly three.
    #[test]
    fn it_declares_thirty_seven_scopes_and_the_three_reveals_are_lockers_own() {
        let manifest = manifest();
        let vault = manifest
            .vault
            .as_ref()
            .expect("Locker declares its vault reach");
        assert_eq!(vault.scopes.len(), 37);

        let reveals: Vec<String> = vault
            .scopes
            .iter()
            .filter(|scope| scope.verbs == ScopeVerbs::Reveal)
            .map(|scope| match &scope.table {
                Some(table) => format!("{}.{table}", scope.schema),
                None => scope.schema.clone(),
            })
            .collect();
        assert_eq!(
            reveals,
            [
                "locker.item".to_owned(),
                "locker.item_field".to_owned(),
                "locker.item_passkey".to_owned()
            ]
        );

        // The audit wall, declared: the OUTER of the two walls `access` has.
        let receipts = vault
            .scopes
            .iter()
            .find(|scope| scope.table.as_deref() == Some("receipt"))
            .expect("Locker declares its reach over access.receipt");
        assert_eq!(receipts.row_filter.len(), 1);
        assert_eq!(receipts.row_filter[0].column, "object_type");
        assert_eq!(receipts.row_filter[0].op, "in");
        assert_eq!(
            receipts.row_filter[0].value,
            Some(serde_json::json!(["locker.item", "locker.auth"]))
        );

        assert!(
            manifest.ext_tables.is_empty(),
            "Locker is a projection over the vault's own tables"
        );
    }

    #[test]
    fn the_state_partition_is_closed_and_locker_designs_all_seven() {
        let states = manifest()
            .states
            .as_ref()
            .expect("Locker declares its designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(
            states.excluded.is_empty(),
            "every exclusion needs a reason and a citation"
        );
    }

    /// D-1020-L7's second deletion, asserted on the parsed side too: Locker is
    /// byte-bearing (the custody triple, the upload queue, the download gate
    /// and free-up-space, `docs/blueprint-seats.md:26`-`:30`) and disabled on
    /// **no** seat.
    #[test]
    fn it_is_byte_bearing_and_disabled_on_no_seat() {
        let raw = ours();
        assert_eq!(raw["seats"]["byteBearing"], serde_json::json!(true));
        assert_eq!(raw["seats"]["disabledOn"], serde_json::json!([]));
        assert_eq!(raw["seats"]["originActs"], serde_json::json!(["autofill"]));
        assert_eq!(raw["seats"]["northStar"], serde_json::json!("1password"));
    }

    /// `auth_session` is gone from the port, and nothing else on that input is.
    #[test]
    fn the_items_input_keeps_its_window_and_its_shelf_switch() {
        let items = manifest().query("items").expect("the items query");
        let properties = items.input["properties"]
            .as_object()
            .expect("an object schema");
        let mut keys: Vec<&str> = properties.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["archived", "limit"]);
        assert_eq!(items.input["properties"]["limit"]["minimum"], 20);
        assert_eq!(items.input["properties"]["limit"]["maximum"], 2000);
    }
}
