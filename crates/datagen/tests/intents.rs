//! Stages 2 and 3 end to end: determinism, coverage of the live cells, and the proof that matters
//! most, that the eval loads what datagen writes and every turn passes when the reference calls
//! are replayed through it (so gold is the runtime's effect, reproduced).

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use centraid_assist::native::prompt::ToolsMode;
use centraid_assist_eval::run::{Runner, StepOut, Stepper};
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

/// Says each turn's reference calls in turn, reading the turn from the placeholder in the prompt.
struct Replay {
    calls: BTreeMap<String, Vec<String>>,
    said: Mutex<BTreeMap<String, usize>>,
}

impl Replay {
    fn new(records: &[Value]) -> Self {
        let mut calls = BTreeMap::new();
        for record in records {
            for turn in record["turns"].as_array().expect("turns") {
                let user = turn["user"].as_str().expect("user").to_owned();
                let texts = turn["ref"]
                    .as_array()
                    .expect("ref")
                    .iter()
                    .map(|call| {
                        let mut text = format!(
                            "<tool_call>\n<function={}>\n",
                            call["tool"].as_str().unwrap_or_default()
                        );
                        for (k, v) in call["args"].as_object().into_iter().flatten() {
                            text += &format!(
                                "<parameter={k}>\n{}\n</parameter>\n",
                                v.as_str().unwrap_or_default()
                            );
                        }
                        text + "</function>\n</tool_call>"
                    })
                    .collect();
                calls.insert(user, texts);
            }
        }
        Self {
            calls,
            said: Mutex::new(BTreeMap::new()),
        }
    }
}

impl Stepper for Replay {
    fn step(
        &self,
        prompt: &str,
        _dates: Option<&str>,
        _tools: ToolsMode,
    ) -> Result<StepOut, String> {
        // the last placeholder in the prompt is the turn being answered
        let start = prompt.rfind("⟨m3:").ok_or("no placeholder in the prompt")?;
        let end = start + prompt[start..].find('⟩').ok_or("unclosed placeholder")? + '⟩'.len_utf8();
        let user = &prompt[start..end];
        let mut said = self.said.lock().expect("lock");
        let n = said.entry(user.to_owned()).or_default();
        let text = self
            .calls
            .get(user)
            .and_then(|c| c.get(*n))
            .ok_or("more steps than reference calls")?;
        *n += 1;
        Ok(StepOut {
            text: text.clone(),
            think_cut: false,
        })
    }
}

#[test]
fn replaying_the_reference_calls_through_the_eval_reproduces_every_gold() {
    let records: Vec<Value> = generated().kept.iter().map(|k| k.record.clone()).collect();
    let source = DatagenSource::new("test", records.clone(), generated().docs.clone());
    let replay = Replay::new(&records);
    let mut runner = Runner::new(&source, &replay).expect("runner");
    let mut failed = Vec::new();
    for session in source.sessions().expect("the eval reads the sessions") {
        let result = runner.run_session(&session).expect("session runs");
        for turn in result.turns.iter().filter(|t| !t.pass) {
            failed.push(format!(
                "{} {}: {:?} ended {}",
                result.id, turn.user, turn.problems, turn.ending
            ));
        }
    }
    assert!(
        failed.is_empty(),
        "{} turns failed, first: {:?}",
        failed.len(),
        failed.iter().take(5).collect::<Vec<_>>()
    );
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
    for cell in [
        "create/workout/create",
        "create/daily figure/create",
        "do/locker item/reveal",
    ] {
        assert!(
            not_live.iter().any(|c| c == cell),
            "{cell} should be not live: {not_live:?}"
        );
    }
    let compare_live = catalog().ops.iter().any(|o| o.name == "compare" && o.live);
    let cell = centraid_datagen::grid::Cell::new("compute", "transaction", "compare");
    assert_eq!(grid.is_live(&cell), compare_live);
}
