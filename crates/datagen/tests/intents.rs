//! Stages 2 and 3 end to end: determinism, coverage of the live cells, and the proof that matters
//! most, that the eval loads what datagen writes and every turn passes when the reference calls
//! are replayed through it (so gold is the runtime's effect, reproduced).

use std::collections::BTreeMap;
use std::sync::OnceLock;

use centraid_assist::native::prompt::ToolsMode;
use centraid_assist_eval::replay;
use centraid_assist_eval::source::EvalSource;
use centraid_datagen::Catalog;
use centraid_datagen::grid::Grid;
use centraid_datagen::plan::is_placeholder;
use centraid_datagen::rng::Rng;
use centraid_datagen::run::{self, Config, Generated};
use centraid_datagen::settings::Settings;
use centraid_datagen::source::DatagenSource;
use centraid_datagen::world::{World, WorldSpec};
use serde_json::Value;

/// Three train worlds: a low, a medium and a high ambiguity preset.
const CONFIG: Config = Config {
    seed: 1,
    counts: [3, 0, 0],
    per_world: [0; 3],
    cell_limit: None,
    mistakes: Vec::new(),
};

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| Catalog::build().expect("catalog"))
}

/// The worlds a spec makes, with more rows in the trash than a preset puts there: a `restore`
/// needs one, and the low presets hold almost none. (The first run's sixty worlds span all three.)
fn world_of(spec: WorldSpec) -> World {
    let mut settings = Settings::for_world(spec.index, &mut Rng::new(spec.seed).fork("settings"));
    settings.trashed = settings.trashed.max(0.5);
    World::generate_with(spec, settings)
}

fn generated() -> &'static Generated {
    static RUN: OnceLock<Generated> = OnceLock::new();
    RUN.get_or_init(|| {
        let scratch = tempfile::tempdir().expect("tempdir");
        run::generate_with(&CONFIG, catalog(), scratch.path(), &world_of).expect("run")
    })
}

#[test]
fn a_run_is_a_pure_function_of_its_seed() {
    let config = Config {
        seed: 7,
        counts: [1, 0, 0],
        per_world: [0; 3],
        cell_limit: Some(30),
        mistakes: Vec::new(),
    };
    let go = || {
        let scratch = tempfile::tempdir().expect("tempdir");
        let out = run::generate(&config, catalog(), scratch.path()).expect("run");
        out.kept
            .iter()
            .map(|k| k.record.to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(go(), go());
}

#[test]
fn every_live_cell_has_a_solvable_intent() {
    let grid = Grid::build(catalog());
    let empty: Vec<String> = grid
        .live()
        .iter()
        .filter(|c| generated().cells.get(*c).is_none_or(|s| s.kept == 0))
        .map(|c| c.to_string())
        .collect();
    assert!(
        empty.is_empty(),
        "live cells with no solvable intent: {empty:?}"
    );
}

#[test]
fn sessions_are_weighted_toward_several_turns_and_a_follow_up_leans_on_an_earlier_turn() {
    let summary = run::Summary::of(generated());
    assert!(
        summary.multi_turn_share >= 0.5,
        "multi-turn share {:.2}",
        summary.multi_turn_share
    );
    assert!(
        summary.three_plus_share >= 0.1,
        "3+ share {:.2}",
        summary.three_plus_share
    );
    assert!(
        summary.across_share >= 0.1,
        "across share {:.2}",
        summary.across_share
    );
    for kept in &generated().kept {
        let scenario: centraid_datagen::intent::Scenario =
            serde_json::from_value(kept.record["scenario"].clone()).expect("scenario");
        for (i, turn) in scenario.turns.iter().enumerate() {
            if let Some((on, _)) = turn.dep {
                assert!(on < i, "{}: turn {i} leans on turn {on}", scenario.id);
            }
        }
        for turn in kept.record["turns"].as_array().expect("turns") {
            assert!(is_placeholder(turn["user"].as_str().expect("user")));
        }
    }
}

#[test]
fn a_minimal_pair_differs_in_one_argument_and_in_its_answer() {
    let by_id: BTreeMap<String, &Value> = generated()
        .kept
        .iter()
        .map(|k| (k.record["id"].as_str().expect("id").to_owned(), &k.record))
        .collect();
    let mut pairs = 0;
    for (id, record) in &by_id {
        let Some(base) = id.strip_suffix('p') else {
            continue;
        };
        let twin = record;
        let base = by_id.get(base).expect("a twin's base is kept");
        pairs += 1;
        assert_ne!(
            base["turns"][0]["gold"], twin["turns"][0]["gold"],
            "{id}: same answer"
        );
        let (a, b) = (
            &base["scenario"]["turns"][0]["intent"],
            &twin["scenario"]["turns"][0]["intent"],
        );
        assert_ne!(a, b);
        assert_eq!(twin["turns"].as_array().expect("turns").len(), 1);
        assert!(
            twin["tags"]
                .as_array()
                .expect("tags")
                .iter()
                .any(|t| t == &Value::String(format!("pair:{}", id.trim_end_matches('p')))),
            "{id}"
        );
    }
    assert!(pairs >= 1, "no minimal pair in the run");
}

#[test]
fn replaying_the_reference_calls_through_the_eval_reproduces_every_gold() {
    let records: Vec<Value> = generated().kept.iter().map(|k| k.record.clone()).collect();
    let source = DatagenSource::new("test", records, generated().docs.clone());
    let sessions = source.sessions().expect("the eval reads the sessions");
    replay::require(&source, &sessions, ToolsMode::Sig).expect("every gold is reproduced");
}

#[test]
fn a_written_run_loads_in_the_eval_with_its_worlds() {
    let dir = tempfile::tempdir().expect("tempdir");
    run::write(dir.path(), &CONFIG, catalog(), generated()).expect("write");
    let source = DatagenSource::open(dir.path(), None).expect("open");
    let sessions = source.sessions().expect("sessions");
    assert_eq!(sessions.len(), generated().kept.len());
    for session in &sessions {
        assert!(source.world(&session.world).is_ok(), "{}", session.world);
        assert!(!session.turns.is_empty());
    }
    // the typed scenario travels beside each session for M3
    let first =
        std::fs::read_to_string(dir.path().join("train").join("sessions.jsonl")).expect("file");
    let record: Value = serde_json::from_str(first.lines().next().expect("a line")).expect("json");
    assert!(record["scenario"]["turns"].is_array());
}

#[test]
fn the_grid_marks_what_the_runtime_or_the_world_cannot_serve_as_not_live() {
    let grid = Grid::build(catalog());
    let not_live: Vec<String> = grid.not_live().iter().map(|(c, _)| c.to_string()).collect();
    for cell in ["create/daily figure/create", "do/locker item/reveal"] {
        assert!(
            not_live.iter().any(|c| c == cell),
            "{cell} should be not live: {not_live:?}"
        );
    }
    // a workout the member logs is made by the runtime (the store states only the rows it follows)
    assert!(grid.is_live(&centraid_datagen::grid::Cell::new(
        "create", "workout", "create"
    )));
    let compare_live = catalog().ops.iter().any(|o| o.name == "compare" && o.live);
    let cell = centraid_datagen::grid::Cell::new("compute", "transaction", "compare");
    assert_eq!(grid.is_live(&cell), compare_live);
}

/// A name a create or a rename gives is the pool's, not a chore with a number on a person: it comes
/// from its kind's pool, carries no trailing number, and no row of the kind (live or trashed)
/// already has it.
#[test]
fn names_a_request_gives_are_per_kind_unique_and_unnumbered() {
    use centraid_datagen::facts::{Facts, fold};
    use centraid_datagen::intent::{Intent, Scenario, Target, Val};
    use centraid_datagen::pools;

    let mut checked = (0, 0);
    for info in &generated().worlds {
        let index: usize = info
            .id
            .rsplit('-')
            .next()
            .expect("index")
            .parse()
            .expect("number");
        let world = world_of(WorldSpec {
            split: info.split,
            index,
            seed: info.seed,
        });
        let facts = Facts::of(&world, catalog());
        let pool_has = |kind: &str, name: &str| -> bool {
            if kind == "person" {
                let (first, last) = name.split_once(' ').unwrap_or((name, ""));
                let right = pools::new_people(info.split);
                right.0.contains(&first) && right.1.contains(&last)
            } else {
                pools::new_names(kind).is_some_and(|p| p.contains(&name))
            }
        };
        for kept in generated().kept.iter().filter(|k| k.world == info.id) {
            let scenario: Scenario =
                serde_json::from_value(kept.record["scenario"].clone()).expect("scenario");
            for turn in &scenario.turns {
                let (kind, name, current) = match &turn.intent {
                    Intent::Create { kind, fields } => {
                        let name = fields.iter().find_map(|c| match &c.value {
                            Val::Text(t) if c.field == "name" => Some(t.clone()),
                            _ => None,
                        });
                        (kind.clone(), name, None)
                    }
                    Intent::Edit { target, changes } => {
                        let name = changes.iter().find_map(|c| match &c.value {
                            Val::Text(t) if c.field == "name" => Some(t.clone()),
                            _ => None,
                        });
                        match target {
                            Target::Name {
                                kind, name: said, ..
                            } => {
                                let current = facts
                                    .of_kind(kind)
                                    .find(|r| fold(&r.name) == fold(said))
                                    .map(|r| r.name.clone());
                                (kind.clone(), name, current)
                            }
                            Target::Turn { kind, .. } => (kind.clone(), name, None),
                            Target::Select { sel } => (sel.kind.clone(), name, None),
                        }
                    }
                    _ => continue,
                };
                let Some(name) = name else { continue };
                assert!(
                    pool_has(&kind, &name),
                    "{}: {kind} {name:?} not from its pool",
                    scenario.id
                );
                assert!(
                    name.rsplit_once(' ')
                        .is_none_or(|(_, tail)| !tail.chars().all(|c| c.is_ascii_digit())),
                    "{}: {name:?} ends in a number",
                    scenario.id
                );
                assert!(
                    !facts
                        .rows
                        .iter()
                        .any(|r| r.kind == kind && fold(&r.name) == fold(&name)),
                    "{}: {kind} {name:?} is already a row's name",
                    scenario.id
                );
                if let Some(current) = current {
                    assert_ne!(fold(&current), fold(&name));
                }
                if matches!(turn.intent, Intent::Create { .. }) {
                    checked.0 += 1
                } else {
                    checked.1 += 1
                }
            }
        }
    }
    assert!(checked.0 > 0 && checked.1 > 0, "checked {checked:?}");
}
