//! The manifest, embedded and parsed rather than restated.
//!
//! `manifest.json` is `packages/blueprints/apps/people/app.json` byte for byte.
//! It is embedded with `include_str!` so a shipped binary carries the manifest
//! it was built with and never looks for a repository path at runtime — the
//! same reason `crates/ontology` embeds the registries (`contracts/README.md`).

use std::sync::OnceLock;

use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id.
pub const APP_ID: &str = "people";

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
        parse_manifest(MANIFEST_JSON).expect("crates/apps/people/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::manifest::{CANONICAL_DESIGNED_STATES, Confirmation, ScopeVerbs};

    use crate::commands::{ACTIONS, Confirm, action_row};
    use crate::queries::{ROSTER_MAX, ROSTER_MIN};

    #[test]
    fn the_committed_manifest_parses_and_is_people() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "0.1.2");
    }

    #[test]
    fn it_declares_seven_queries_and_twenty_nine_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 7);
        assert_eq!(manifest.actions.len(), 29);
        // The seven are the handler FILES the dispatcher resolves —
        // `queries/<name>.ts` — and `_shared.ts` and `person-contacts.ts` are
        // helpers beside them rather than queries (`person-contacts.ts:17`).
        for name in [
            "people",
            "person",
            "dashboard",
            "journal",
            "search",
            "trash",
            "history",
        ] {
            assert!(manifest.query(name).is_some(), "no query {name}");
        }
        assert!(manifest.query("person-contacts").is_none());
    }

    #[test]
    fn every_declared_action_has_a_command_and_every_command_an_action() {
        let manifest = manifest();
        for action in &manifest.actions {
            assert!(
                action_row(&action.name).is_some(),
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
        // ORDER, not just membership: the table is the manifest's own order, so
        // a reader comparing the two files reads them top to bottom.
        let declared: Vec<&str> = manifest
            .actions
            .iter()
            .map(|action| action.name.as_str())
            .collect();
        let ported: Vec<&str> = ACTIONS.iter().map(|row| row.action).collect();
        assert_eq!(declared, ported);
    }

    /// v0's `confirmation` and the port's [`Confirm`] must agree, because the
    /// conversation surface reads one of them and the app reads the other.
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
    }

    #[test]
    fn every_action_declares_the_tables_it_writes() {
        for action in &manifest().actions {
            assert!(
                !action.writes.is_empty(),
                "{} declares no writes, but every People action writes",
                action.name
            );
        }
        // Seven schemas are REACHED by the declared writes, which is the fact
        // the app's own description states: People stores nothing of its own
        // and writes everybody else's canonical rows.
        let mut schemas: Vec<&str> = manifest()
            .declared_writes()
            .into_iter()
            .map(|table| table.split('.').next().unwrap_or_default())
            .collect();
        schemas.sort_unstable();
        schemas.dedup();
        assert_eq!(
            schemas,
            [
                "core",
                "knowledge",
                "outbox",
                "people",
                "schedule",
                "social",
                "tally"
            ]
        );
    }

    /// TWENTY-FOUR SCOPES: nineteen reads, four `act` and **one `read+act`
    /// over the whole `people` schema** (census §A0's table).
    ///
    /// The whole-schema form is the widest there is and only agenda and People
    /// use it. It is asserted here rather than narrowed, because expanding it
    /// into twenty-four explicit scopes CHANGES THE GRANT'S MEANING — the
    /// member consented to "People, over the People schema", and twenty-four
    /// rows is a different sentence even where the reach is the same.
    #[test]
    fn it_declares_twenty_four_scopes_with_one_whole_schema_grant() {
        let manifest = manifest();
        let vault = manifest.vault.as_ref().expect("People declares its reach");
        assert_eq!(vault.scopes.len(), 24);

        let mut schemas: Vec<&str> = vault
            .scopes
            .iter()
            .map(|scope| scope.schema.as_str())
            .collect();
        schemas.sort_unstable();
        schemas.dedup();
        assert_eq!(
            schemas,
            [
                "core",
                "knowledge",
                "people",
                "schedule",
                "share",
                "social",
                "tally"
            ]
        );

        let whole_schema: Vec<&str> = vault
            .scopes
            .iter()
            .filter(|scope| scope.verbs == ScopeVerbs::ReadAct)
            .map(|scope| scope.schema.as_str())
            .collect();
        assert_eq!(whole_schema, ["people"]);
        assert!(
            vault
                .scopes
                .iter()
                .find(|scope| scope.verbs == ScopeVerbs::ReadAct)
                .is_some_and(|scope| scope.table.is_none()),
            "`read+act` over the whole schema is the widest form and is what People has"
        );

        assert_eq!(
            vault
                .scopes
                .iter()
                .filter(|scope| scope.verbs == ScopeVerbs::Read)
                .count(),
            19
        );
        assert_eq!(
            vault
                .scopes
                .iter()
                .filter(|scope| scope.verbs == ScopeVerbs::Act)
                .count(),
            4
        );
        // NOTHING REVEALED: `reveal` is Locker's alone.
        assert!(
            vault
                .scopes
                .iter()
                .all(|scope| scope.verbs != ScopeVerbs::Reveal)
        );
        assert!(
            manifest.ext_tables.is_empty(),
            "People is a projection over the vault's own tables: no data of its own"
        );
    }

    /// FINDING PE-F1, as an assertion over the manifest itself: three of the
    /// four narrow `act` scopes name the `social` schema, and the commands
    /// those three actions invoke are `people.*`.
    #[test]
    fn three_act_scopes_name_social_and_one_names_core() {
        let vault = manifest()
            .vault
            .as_ref()
            .expect("People declares its reach");
        let mut narrow: Vec<(&str, &str)> = vault
            .scopes
            .iter()
            .filter(|scope| scope.verbs == ScopeVerbs::Act)
            .map(|scope| {
                (
                    scope.schema.as_str(),
                    scope
                        .table
                        .as_deref()
                        .expect("a narrow act scope names a table"),
                )
            })
            .collect();
        narrow.sort_unstable();
        assert_eq!(
            narrow,
            [
                ("core", "merge_party"),
                ("social", "delete_contact_channel"),
                ("social", "save_contact_channel"),
                ("social", "undo_contact_channel"),
            ]
        );
        assert_eq!(
            crate::commands::act_scope_schemas(),
            ["core", "people"],
            "the commands the actions invoke live in `core` and `people`; the scopes say `social`"
        );
    }

    /// The `core.entity_revision` scope is the only row-filtered, field-masked
    /// read in the manifest, and `history` is what it exists for.
    #[test]
    fn the_revision_scope_is_row_filtered_to_this_apps_own_entity() {
        let vault = manifest()
            .vault
            .as_ref()
            .expect("People declares its reach");
        let revision = vault
            .scopes
            .iter()
            .find(|scope| scope.table.as_deref() == Some("entity_revision"))
            .expect("the revision scope");
        assert_eq!(revision.schema, "core");
        assert_eq!(revision.row_filter.len(), 1);
        assert_eq!(revision.row_filter[0].column, "entity_type");
        assert_eq!(revision.row_filter[0].op, "eq");
        assert_eq!(
            revision.row_filter[0].value,
            Some(serde_json::json!("people.person"))
        );
        // The mask is what stops `snapshot_json` of somebody else's entity
        // riding a People payload; `snapshot_json` of THIS one is in it because
        // the undo rail renders it.
        let mask = revision
            .field_mask
            .as_ref()
            .expect("the revision scope is masked");
        assert!(mask.contains(&"snapshot_json".to_owned()));
        assert!(!mask.contains(&"actor_party_id".to_owned()));
    }

    /// People is record-only, enabled on every seat, and has no origin act.
    #[test]
    fn it_is_record_only_with_no_origin_act() {
        let raw: serde_json::Value =
            serde_json::from_str(MANIFEST_JSON).expect("the manifest is JSON");
        assert_eq!(raw["seats"]["byteBearing"], serde_json::json!(false));
        assert_eq!(raw["seats"]["disabledOn"], serde_json::json!([]));
        assert_eq!(raw["seats"]["originActs"], serde_json::json!([]));
        assert_eq!(
            raw["seats"]["northStar"],
            serde_json::json!("google-contacts")
        );
        assert_eq!(raw["actionSideEffect"], serde_json::json!("vault-write"));
    }

    #[test]
    fn the_state_partition_is_closed_and_people_designs_all_seven() {
        let states = manifest()
            .states
            .as_ref()
            .expect("People declares its designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(
            states.excluded.is_empty(),
            "People has no unrepresentable state; every exclusion needs a reason and a citation"
        );
    }

    /// THE WIDEST WINDOW IN THE TREE (D-1020-PE4): `people.limit` is 20–10,000,
    /// an order of magnitude above every other app's 2,000, and nothing in the
    /// manifest explains it.
    ///
    /// Read off the manifest rather than restated, because the clamp and the
    /// schema disagreeing is a refusal a member cannot act on — and here they
    /// DO disagree in v0: the handler clamps to 9,999, so a caller passing the
    /// schema's own maximum gets a window one short of it and is told
    /// `window: 9999`. See [`crate::roster`].
    #[test]
    fn the_rosters_window_is_the_one_the_manifest_declares() {
        let people = manifest().query("people").expect("the roster query");
        let limit = &people.input["properties"]["limit"];
        assert_eq!(limit["minimum"], serde_json::json!(20));
        assert_eq!(limit["maximum"], serde_json::json!(10_000));
        assert_eq!(
            u64::try_from(ROSTER_MIN).unwrap_or_default(),
            limit["minimum"].as_u64().unwrap_or_default()
        );
        assert_eq!(
            u64::try_from(ROSTER_MAX).unwrap_or_default(),
            limit["maximum"].as_u64().unwrap_or_default(),
            "the port honours the declared maximum; v0 clamps one below it"
        );
    }

    /// THE MANIFEST PROMISES A FIELD THE HANDLER NEVER EMITS (finding PE-F2).
    ///
    /// `person`'s description names `shared_with_them` beside `vaults` and says
    /// both are null when the sharing reads are denied. `queries/person.ts`
    /// returns `vaults` and nothing else, and `queries/_shared.ts:1`-`:3` says
    /// why: what is shared WITH a person goes through the live grant plane
    /// (`GET /centraid/_vault/grants?partyId=`), and there is no second
    /// vault-side invitation plane to read. So the sentence describes a field
    /// that has never existed — the `auth_session` class of dead manifest
    /// declaration (census §A seam 2), one app over.
    #[test]
    fn the_person_description_names_a_field_no_handler_returns() {
        let person = manifest().query("person").expect("the person query");
        let description = person.description.as_deref().unwrap_or_default();
        assert!(
            description.contains("shared_with_them"),
            "finding PE-F2 moved: re-judge it rather than deleting this test"
        );
        assert!(
            !crate::person::PERSON_FIELDS.contains(&"shared_with_them"),
            "if the port grew the field, the finding is closed and the sentence is true"
        );
    }
}
