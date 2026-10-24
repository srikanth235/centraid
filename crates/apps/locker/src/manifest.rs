//! The manifest, embedded and parsed rather than restated — and the two fields
//! deleted from it, with the deletion itself under test (D-1020-L7).
//!
//! `manifest.json` has exactly two keys removed from v0's manifest. It is
//! embedded with `include_str!` so a shipped binary carries the manifest it
//! was built with and never looks for a repository path at runtime — the
//! same reason `crates/ontology` embeds the registries (`contracts/README.md`).
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

    // DELETED WITH ITS ORACLE (#1025 S4).
    // `the_manifest_differs_from_v0_by_exactly_the_two_dead_fields` applied
    // D-1020-L7's two edits to v0's manifest and asserted the result was
    // byte-identical to ours. That file went with
    // `chore(retire): delete the v0 tree`, and freezing a copy of it under
    // `contracts/` to keep the diff alive would be re-importing the tree that
    // retirement deleted (v0-no-legacy). What D-1020-L7 RULED is asserted
    // directly instead, below and in `commands.rs`: the `items` query declares
    // no `auth_session`, and `seats.disabledOn` is empty. Those are facts about
    // this manifest, which is the only manifest there is now.

    /// D-1020-L7's TWO DELETIONS, asserted as properties of this manifest.
    #[test]
    fn the_permit_era_parameter_is_gone_and_locker_is_on_every_seat() {
        let manifest = ours();
        let items = manifest["queries"]
            .as_array()
            .expect("queries")
            .iter()
            .find(|query| query["name"] == "items")
            .expect("the items query");
        assert!(
            items["input"]["properties"]
                .as_object()
                .expect("an object schema")
                .get("auth_session")
                .is_none(),
            "`auth_session` is a permit-era parameter (#996 R13) and this port \
             carries its absence"
        );
        assert_eq!(
            manifest["seats"]["disabledOn"],
            serde_json::json!([]),
            "Locker is disabled on no seat (#996 R13)"
        );
    }

    #[test]
    fn it_declares_five_queries_and_nineteen_actions() {
        let manifest = manifest();
        // v0's eight less the two autofill queries, deleted with the fill
        // plane (R-1047-D3), and the Watchtower review, deleted with the
        // weak/reused scoring (Q-1047-16).
        assert_eq!(manifest.queries.len(), 5);
        assert_eq!(manifest.actions.len(), 19);
        for name in ["items", "item", "search", "trash", "access"] {
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
    /// The reveal runs in the phone's core, the only holder of `K`
    /// (`crates/core::locker::phone`), behind the member's unlock. The vault's
    /// access plane has no reveal judgement at all (R-1047-D2), so these three
    /// scopes are the manifest's declaration of what the app may ask the core
    /// to open, and they are still exactly three.
    #[test]
    fn it_declares_twenty_eight_scopes_and_the_three_reveals_are_lockers_own() {
        let manifest = manifest();
        let vault = manifest
            .vault
            .as_ref()
            .expect("Locker declares its vault reach");
        assert_eq!(vault.scopes.len(), 28);

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

        // The audit reach, declared: Locker's own `receipt` table, which is the
        // wall (nothing else writes it), so no row filter rides with it. An item
        // is an entity (#1135), so Locker also declares the shared verbs it
        // wraps (`entity.*`, `flag.*`, `tag.*`) and its read of `entity` and
        // `edge`, which the page door serves to a read named as Locker's own.
        let receipts = vault
            .scopes
            .iter()
            .find(|scope| scope.table.as_deref() == Some("receipt"))
            .expect("Locker declares its reach over its own receipt table");
        assert_eq!(receipts.schema, "locker");
        assert!(receipts.row_filter.is_empty());
        assert!(
            vault
                .scopes
                .iter()
                .all(|scope| ["locker", "entity", "flag", "tag", "vault"]
                    .contains(&scope.schema.as_str())),
            "Locker reaches its own tables and the shared verbs, and nothing else"
        );
        assert!(
            vault
                .scopes
                .iter()
                .filter(|scope| scope.schema != "locker")
                .all(|scope| scope.table.as_deref() != Some("person")),
            "no scope reaches another app's table"
        );

        assert!(
            manifest.ext_tables.is_empty(),
            "Locker is a projection over the vault's own tables"
        );
    }

    /// L4 (ruled 2026-10-15): `edit-item` REPLACES the item's type fields, and
    /// the manifest — which an assistant or an API caller reads as the
    /// contract — says so in the action's description and on its input, in the
    /// same words the command's own schema carries
    /// (`the_edit_commands_schema_says_it_replaces` holds the other half).
    #[test]
    fn edit_item_says_it_replaces_rather_than_patches() {
        let edit = manifest()
            .action("edit-item")
            .expect("Locker declares edit-item");
        let said = edit.description.as_deref().expect("a description");
        assert!(said.contains("REPLACES and does not patch"), "{said}");
        let input = edit.input["description"]
            .as_str()
            .expect("the input carries the same sentence for a caller that reads only it");
        for phrase in ["REPLACES, does not patch", "CLEARED", "«sealed»"] {
            assert!(input.contains(phrase), "the input lost `{phrase}`: {input}");
        }
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
        // No origin act: autofill was a browser extension's (R-1047-D3).
        assert_eq!(raw["seats"]["originActs"], serde_json::json!([]));
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
