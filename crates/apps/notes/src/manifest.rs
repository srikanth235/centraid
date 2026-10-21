//! The manifest, embedded and parsed rather than restated.
//!
//! `manifest.json` is embedded with `include_str!`, verbatim, so a shipped
//! binary carries the manifest it was built with and never looks for a
//! repository path at runtime — the same reason `crates/ontology` embeds the
//! registries (`contracts/README.md`).

use std::sync::OnceLock;

use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id.
pub const APP_ID: &str = "notes";

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
        parse_manifest(MANIFEST_JSON).expect("crates/apps/notes/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::manifest::{CANONICAL_DESIGNED_STATES, Confirmation, ScopeVerbs};

    use crate::commands::{ACTIONS, Confirm, act_scope_tables};

    #[test]
    fn the_committed_manifest_parses_and_is_notes() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "0.9.0");
    }

    #[test]
    fn it_declares_six_queries_and_seventeen_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 6);
        assert_eq!(manifest.actions.len(), 17);
        for name in [
            "link-targets",
            "library",
            "note",
            "search",
            "history",
            "journal",
        ] {
            assert!(manifest.query(name).is_some(), "no query {name}");
        }
        // The directory also holds `powerbox.ts`, `filing.ts`, `shelves.ts` and
        // the rest — helpers beside the handlers, and the dispatcher resolves
        // `queries/<name>.ts` rather than scanning the directory.
        assert!(manifest.query("powerbox").is_none());
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
    /// definition parks a NON-OWNER invocation regardless of risk. Notes'
    /// two manifest-confirmed actions are the two deletes, and no command this
    /// build carries for Notes sets the command-level gate.
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
        assert_eq!(required, ["delete-notebook", "delete-note"]);
    }

    /// THE TWO MANIFEST CONFIRMATIONS, RE-JUDGED RATHER THAN CITED.
    ///
    /// `delete-note` is reversible — a 30-day trash — and it is confirm-gated;
    /// `restore-note-version` replaces the body a member is looking at and is
    /// **not**. The asymmetry is v0's and it survives here because the restore
    /// is itself reversible (a restore appends a new occurrence and nothing is
    /// rewritten, #996 R20(a)), so the destructive verb is the one that leaves
    /// the shelf. `delete-notebook` unfiles and never destroys, and it is gated
    /// anyway — because a member cannot see, from the gesture, that their notes
    /// survive. Both are questions for the owner in this lane's receipt, with
    /// the recommendation to keep them.
    #[test]
    fn the_destructive_verbs_and_the_reversible_one_are_gated_as_v0_gates_them() {
        let gated = |action: &str| {
            manifest()
                .action(action)
                .expect("the action is declared")
                .confirmation
        };
        assert_eq!(gated("delete-note"), Confirmation::Required);
        assert_eq!(gated("delete-notebook"), Confirmation::Required);
        assert_eq!(gated("restore-note-version"), Confirmation::None);
        assert_eq!(gated("move-note"), Confirmation::None);
    }

    /// A NOTE MAY BE CLEARED (owner ruling 2026-09-24): the manifest's `body`
    /// accepts the empty string on both actions, in step with `note.create` /
    /// `note.edit`'s own schemas.
    #[test]
    fn a_note_body_may_be_empty_on_create_and_edit() {
        for action in ["create-note", "edit-note"] {
            let input = &manifest().action(action).expect("declared").input;
            assert_eq!(
                input["properties"]["body"]["minLength"], 0,
                "{action} still refuses an empty body"
            );
        }
    }

    /// A TITLE MAY BE CLEARED BY AN EDIT (#1047 T1): Notes draws an empty
    /// title as the body's first line, so `edit-note` takes `""` in step with
    /// `note.edit`. A new note still needs a name or a first line.
    #[test]
    fn a_note_title_may_be_cleared_by_an_edit_and_not_left_empty_on_create() {
        let title = |action: &str| {
            manifest().action(action).expect("declared").input["properties"]["title"]["minLength"]
                .clone()
        };
        assert_eq!(
            title("edit-note"),
            0,
            "edit-note still refuses an empty title"
        );
        assert_eq!(title("create-note"), 1);
    }

    /// NOTES' ACTIONS INVOKE ITS OWN `note` COMMANDS AND THE SHARED VERBS — and
    /// the one command Agenda owes — and the table says so. What each command
    /// wrote is the commit's own census, not a list a manifest carries (V3).
    #[test]
    fn the_actions_invoke_the_note_commands_the_shared_verbs_and_agendas_task_add() {
        let mut schemas: Vec<&str> = ACTIONS
            .iter()
            .filter_map(|row| row.command.split('.').next())
            .collect();
        schemas.sort_unstable();
        schemas.dedup();
        assert_eq!(
            schemas,
            ["container", "edge", "entity", "flag", "note", "tag", "task"]
        );
    }

    /// TWENTY-SEVEN SCOPES: twelve reads over the vault's tables, and **fifteen
    /// `act` scopes**, one per distinct command the seventeen actions invoke.
    ///
    /// The `act` half is compared against the action table rather than
    /// transcribed: a sixteenth action with no scope is an action the grant does
    /// not cover, and a scope with no action is reach nothing uses.
    #[test]
    fn it_declares_twenty_seven_scopes_with_one_act_scope_per_command() {
        let manifest = manifest();
        let vault = manifest.vault.as_ref().expect("Notes declares its reach");
        assert_eq!(vault.scopes.len(), 27);

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
                "container",
                "edge",
                "entity",
                "flag",
                "note",
                "tag",
                "task",
                "vault"
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
        assert_eq!(declared, act_scope_tables());
        assert_eq!(declared.len(), 15);

        let reads = vault
            .scopes
            .iter()
            .filter(|scope| scope.verbs == ScopeVerbs::Read)
            .count();
        assert_eq!(reads, 12);
        // NOTHING WIDER, and nothing revealed: `read+act` over a whole schema
        // is the widest form and only agenda and people use it; `reveal` is
        // Locker's alone.
        assert!(
            vault
                .scopes
                .iter()
                .all(|scope| scope.verbs == ScopeVerbs::Read || scope.verbs == ScopeVerbs::Act),
            "Notes declares no read+act and no reveal"
        );
        assert!(
            manifest.ext_tables.is_empty(),
            "Notes is a projection over the vault's own tables: no data of its own"
        );
    }

    /// THE POWERBOX IS WHY `person`, `event`, `task`, `document` AND `photo` ARE
    /// IN THE SCOPE LIST.
    ///
    /// Notes reads other apps' kinds (census §A4), and the scopes nothing else
    /// in this app touches are the proof: they are read ONLY to draw the far end
    /// of a link. A port that dropped one would silently shrink a card.
    #[test]
    fn the_scope_only_the_powerbox_needs_is_declared() {
        let vault = manifest().vault.as_ref().expect("Notes declares its reach");
        let declared = |schema: &str, table: &str| {
            vault.scopes.iter().any(|scope| {
                scope.schema == schema
                    && scope.table.as_deref() == Some(table)
                    && scope.verbs == ScopeVerbs::Read
            })
        };
        for table in ["person", "event", "task", "document", "photo"] {
            assert!(declared("vault", table), "{table} is a card's table");
        }
        // And Locker is not reachable at all — the absence is structural.
        assert!(
            vault.scopes.iter().all(|scope| scope.schema != "locker"),
            "a secret cannot become a link target by adding a scope"
        );
    }

    /// Notes is byte-bearing, enabled on every seat, and its origin acts are
    /// capture and voice. `disabledOn` is empty here, unlike Locker's stale
    /// `["viewer"]` (census §A seam 1) — nothing to re-judge for this app.
    #[test]
    fn it_is_byte_bearing_with_capture_and_voice_as_its_origin_acts() {
        let raw: serde_json::Value =
            serde_json::from_str(MANIFEST_JSON).expect("the manifest is JSON");
        assert_eq!(raw["seats"]["byteBearing"], serde_json::json!(true));
        assert_eq!(raw["seats"]["disabledOn"], serde_json::json!([]));
        assert_eq!(
            raw["seats"]["originActs"],
            serde_json::json!(["capture", "voice"])
        );
        assert_eq!(raw["seats"]["northStar"], serde_json::json!("apple-notes"));
        assert_eq!(raw["actionSideEffect"], serde_json::json!("vault-write"));
    }

    #[test]
    fn the_state_partition_is_closed_and_notes_designs_all_seven() {
        let states = manifest()
            .states
            .as_ref()
            .expect("Notes declares its designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(
            states.excluded.is_empty(),
            "Notes has no unrepresentable state; every exclusion needs a reason and a citation"
        );
    }

    /// The library's and the journal's declared window, read off the manifest
    /// rather than restated — a clamp and a schema that disagree are a refusal
    /// a member cannot act on.
    #[test]
    fn both_windowed_queries_declare_the_same_bounds_the_clamp_uses() {
        for name in ["library", "journal"] {
            let query = manifest().query(name).expect("the query is declared");
            let limit = &query.input["properties"]["limit"];
            assert_eq!(limit["minimum"], serde_json::json!(20), "{name}");
            assert_eq!(limit["maximum"], serde_json::json!(2000), "{name}");
            assert_eq!(
                u64::try_from(crate::queries::WINDOW_MIN).unwrap_or_default(),
                limit["minimum"].as_u64().unwrap_or_default()
            );
            assert_eq!(
                u64::try_from(crate::queries::WINDOW_MAX).unwrap_or_default(),
                limit["maximum"].as_u64().unwrap_or_default()
            );
        }
    }

    /// `note`, `search`, `history` and `link-targets` declare NO window, and
    /// that is not an oversight: each is bounded by something other than a
    /// caller's number — one row, the ranked hits, the chain's own length, and
    /// eight per domain.
    #[test]
    fn the_four_unwindowed_queries_take_no_limit() {
        for name in ["note", "search", "history", "link-targets"] {
            let query = manifest().query(name).expect("the query is declared");
            assert!(
                query.input["properties"]["limit"].is_null(),
                "{name} declares a limit the port does not clamp"
            );
        }
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
}
