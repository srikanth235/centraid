//! The manifest, embedded and parsed rather than restated.
//!
//! It is embedded with `include_str!` so a shipped binary carries the manifest it was built with,
//! and parsed by the kit at load time. Each action's `input` is the vault command's own schema,
//! copied verbatim; `every_action_is_a_vault_command_with_its_schema` proves it, because two
//! copies of "what does `measurement.record` take" is how the two answers drift.

use std::sync::OnceLock;

use centraid_apps_kit::actions::{ActionRow, act, confirmed};
use centraid_apps_kit::manifest::{Manifest, parse_manifest};

/// The manifest, as committed.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

/// The app's id: what a surface keys on.
pub const APP_ID: &str = "health";

/// The action each vault command is declared as.
pub const ACTIONS: [ActionRow; 17] = [
    // THE GENERAL LINK (#1185): any item to any other, and the link taken off.
    act("link", "edge.add"),
    act("unlink", "edge.remove"),
    act("record-days", "measurement.record"),
    act("follow-workouts", "follow.health"),
    act("delete-workout", "entity.trash"),
    confirmed("stop-following", "follow.stop"),
    act("log-workout", "workout.log"),
    act("edit-workout", "workout.edit"),
    act("restore-workout", "entity.restore"),
    // THE TWO DESTROYS (#1185), as in every app: one trashed workout, and the whole trash.
    confirmed("purge-workout", "entity.purge"),
    confirmed("empty-trash", "entity.empty_trash"),
    act("edit-figure", "measurement.log"),
    act("log-figure", "measurement.log"),
    act("clear-figure", "measurement.clear"),
    // AN ATTACHMENT is an `attached` edge from the item to a document or a photo: the shared
    // verbs, one pair in every app (the Attach promise, #1185).
    act("attach", "edge.add"),
    act("detach", "edge.remove"),
    // THE HEALTH DATA AS A FILE (#1185): the More sheet's Export and a workout's Share. It writes
    // nothing (`writes_nothing`).
    act("export-csv", "health.export_csv"),
];

/// The parsed manifest.
///
/// # Panics
///
/// If the committed manifest does not parse, which `the_committed_manifest_parses_and_is_healths`
/// keeps unreachable.
pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| {
        parse_manifest(MANIFEST_JSON).expect("crates/apps/health/manifest.json must parse")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::manifest::{CANONICAL_DESIGNED_STATES, Confirmation};

    #[test]
    fn the_committed_manifest_parses_and_is_healths() {
        let manifest = manifest();
        assert_eq!(manifest.id, APP_ID);
        assert_eq!(manifest.manifest_version, 1);
        assert_eq!(manifest.version, "0.2.0");
        let raw: serde_json::Value = serde_json::from_str(MANIFEST_JSON).unwrap();
        assert_eq!(raw["iconKey"], "Activity");
        // Identity hue 110, the widest free gap on the ring (R-1129-10).
        assert_eq!(raw["colorKey"], "olive");
    }

    #[test]
    fn it_declares_seven_queries_and_its_actions() {
        let manifest = manifest();
        assert_eq!(manifest.queries.len(), 8);
        for name in [
            "today",
            "series",
            "trends",
            "workouts",
            "workout",
            "trash",
            "follow-view",
        ] {
            assert!(manifest.query(name).is_some(), "no query {name}");
        }
        assert_eq!(manifest.actions.len(), ACTIONS.len());
        for row in ACTIONS {
            let (action, _) = (row.action, row.command);
            let declared = manifest.action(action).expect("declared");
            // The irreversible acts confirm (#1185), as every other app's destroys do.
            let expected = if matches!(action, "purge-workout" | "empty-trash" | "stop-following") {
                Confirmation::Required
            } else {
                Confirmation::None
            };
            assert_eq!(declared.confirmation, expected, "{action}");
        }
    }

    /// The input without the words only the conversation surface reads: the names chat says a
    /// property under (`aliases`) and the ids it leaves for the core (`x-minted`, `x-target`),
    /// and the one kind `empty-trash` narrows the shared verb's free `kind` to (`enum`).
    fn chat_words_removed(schema: &serde_json::Value) -> serde_json::Value {
        match schema {
            serde_json::Value::Object(map) => serde_json::Value::Object(
                map.iter()
                    .filter(|(key, _)| !matches!(key.as_str(), "aliases" | "x-minted" | "x-target"))
                    .map(|(key, value)| (key.clone(), chat_words_removed(value)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    #[test]
    fn every_action_is_a_vault_command_with_its_schema() {
        let registry = centraid_vault::commands::Registry::with_system_commands()
            .expect("the registry builds");
        for ActionRow {
            action, command, ..
        } in ACTIONS
        {
            let registered = registry
                .get(command)
                .unwrap_or_else(|| panic!("{command} is not a vault command"));
            // `empty-trash` is the app's narrowing of the bulk verb: it names the one kind it
            // empties and leaves out `limit` and `defer_collect`, which are the launch pass's.
            if action == "empty-trash" {
                continue;
            }
            // `attach` and `detach` narrow the shared edge verbs to the one relation, as in every
            // app (the Attach promise): `from`, `rel` (`attached`) and `to`.
            if matches!(action, "attach" | "detach") {
                continue;
            }
            assert_eq!(
                &chat_words_removed(&manifest().action(action).expect("declared").input),
                registered.schema(),
                "{action}'s input is not {command}'s schema"
            );
        }
    }

    /// HEALTH READS THE VAULT'S OWN TABLES AND WRITES THROUGH ITS OWN COMMANDS: its days, the health
    /// follow, the stop of a follow, what the member logs by hand and the shared trash and
    /// restore. It reaches no other app's verbs.
    #[test]
    fn health_reads_the_vaults_tables_and_acts_through_its_commands() {
        use centraid_apps_kit::manifest::ScopeVerbs;
        let vault = manifest().vault.as_ref().expect("a vault block");
        for scope in &vault.scopes {
            assert_eq!(
                scope.verbs == ScopeVerbs::Read,
                scope.schema == "vault",
                "{}.{:?} is neither a read of the vault's tables nor an act on a command",
                scope.schema,
                scope.table
            );
        }
        let commands: Vec<&str> = ACTIONS.iter().map(|row| row.command).collect();
        assert_eq!(
            manifest().act_scope_disagreements(&commands),
            Vec::<String>::new()
        );
    }

    #[test]
    fn the_state_partition_is_closed_and_health_creates_no_tables() {
        let states = manifest().states.as_ref().expect("designed states");
        assert_eq!(states.designed.len(), CANONICAL_DESIGNED_STATES.len());
        assert!(states.excluded.is_empty());
        assert!(manifest().ext_tables.is_empty());
    }

    /// THE CATALOG NAMES THE COMMAND EACH ACTION RUNS, and it is the command
    /// the action table runs: chat's verb rows are generated from the first.
    #[test]
    fn every_action_declares_the_command_it_invokes() {
        for ActionRow {
            action, command, ..
        } in super::ACTIONS
        {
            let declared = manifest().action(action).expect("a declared action");
            assert_eq!(declared.command, command, "{action}");
        }
    }
}
