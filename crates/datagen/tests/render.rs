//! M4: render and mix, end to end over a small intents run, with a byte-level tokenizer (no network, no model file).
//!
//! What is proved here: every step's think compiles back to its reference call, the records carry the contract M6 reads
//! (ids and weights of one length, the mask exactly the assistant messages), the records load in `assist-eval` and replay
//! to their gold, no world is in two splits, the manifest names the version, and a rebuild is byte-identical.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use centraid_assist::native::identity::MODEL;
use centraid_assist::native::prompt::ToolsMode;
use centraid_assist_eval::run::{Runner, StepOut, Stepper};
use centraid_assist_eval::source::EvalSource;
use centraid_datagen::Catalog;
use centraid_datagen::mix::{self, Shares};
use centraid_datagen::render::{Tokenizer, byte_level_tokenizer, byte_level_tokenizer_json};
use centraid_datagen::run::{self, Config as RunConfig};
use centraid_datagen::source::DatagenSource;
use centraid_datagen::version::{self, Provenance, RenderConfig};
use serde_json::{Value, json};

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| Catalog::build().expect("catalog"))
}

/// A small intents run (the stage before messages; its users are placeholders, which the runtime reads as an empty message),
/// and the tokenizer file.
fn input() -> &'static (tempfile::TempDir, PathBuf) {
    static DIR: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    DIR.get_or_init(|| {
        let config = RunConfig {
            seed: 1,
            counts: [3, 1, 1],
            per_world: [0; 3],
            cell_limit: Some(40),
        };
        let scratch = tempfile::tempdir().expect("tempdir");
        let generated = run::generate(&config, catalog(), scratch.path()).expect("run");
        let dir = tempfile::tempdir().expect("tempdir");
        run::write(dir.path(), &config, catalog(), &generated).expect("write");
        let tokenizer = dir.path().join("tokenizer.json");
        std::fs::write(&tokenizer, byte_level_tokenizer_json()).expect("tokenizer");
        (dir, tokenizer)
    })
}

fn mix_config() -> mix::Config {
    mix::Config {
        targets: [60, 15, 15],
        shares: Shares::default(),
        seed: 1,
        live: Vec::new(),
    }
}

fn build(out: &Path) -> Value {
    let (dir, tokenizer) = input();
    version::render_and_mix(
        dir.path(),
        out,
        &RenderConfig {
            tokenizer: tokenizer.clone(),
            decision_weight: 2.0,
            concurrency: 2,
        },
        &mix_config(),
        &Provenance {
            version: "test".to_owned(),
            runtime_commit: "unknown".to_owned(),
            tokenizer_path: "tokenizer.json".to_owned(),
            seeds: json!({"master": 1, "mix": 1}),
        },
    )
    .expect("render and mix");
    serde_json::from_str(&std::fs::read_to_string(out.join("manifest.json")).expect("manifest"))
        .expect("json")
}

/// The version, built once.
fn version_dir() -> &'static (tempfile::TempDir, Value) {
    static DIR: OnceLock<(tempfile::TempDir, Value)> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = build(dir.path());
        (dir, manifest)
    })
}

fn records(dir: &Path, split: &str) -> Vec<Value> {
    let file = std::fs::File::open(dir.join(format!("{split}.jsonl.zst"))).expect("file");
    let text = String::from_utf8(zstd::stream::decode_all(file).expect("zstd")).expect("utf8");
    text.lines()
        .map(|line| serde_json::from_str(line).expect("a record"))
        .collect()
}

#[test]
fn every_step_round_trips_and_the_mask_is_exactly_the_assistant_messages() {
    let (dir, manifest) = version_dir();
    let render = &manifest["render"];
    let steps = render["steps"].as_u64().expect("steps");
    assert!(steps > 100, "{steps} steps");
    assert_eq!(render["steps_roundtripped"], render["steps"]);
    let tokenizer = byte_level_tokenizer().expect("tokenizer");
    let mut seen = 0;
    let mut bad_calls = 0;
    let mut masked_regions = 0;
    let mut weights_seen: BTreeSet<String> = BTreeSet::new();
    for split in ["train", "val", "test"] {
        for record in records(dir.path(), split) {
            seen += 1;
            let ids: Vec<u32> =
                serde_json::from_value(record["render"]["input_ids"].clone()).expect("ids");
            let weights: Vec<f32> =
                serde_json::from_value(record["render"]["weights"].clone()).expect("weights");
            let text = record["render"]["text"].as_str().expect("text");
            assert_eq!(ids.len(), weights.len());
            assert_eq!(
                tokenizer.decode(&ids).expect("decode"),
                text,
                "the ids encode the text"
            );
            for turn in record["turns"].as_array().expect("turns") {
                bad_calls += turn["ref"]
                    .as_array()
                    .expect("ref")
                    .iter()
                    .filter(|call| call["bad"] == true)
                    .count();
            }
            // an independent reading of the text: every `<|im_start|>assistant\n<think>\n` opens one region that runs to its
            // `<|im_end|>`, and nothing else is trained
            let header = format!("{}assistant\n{}", MODEL.im_start, MODEL.think_open);
            let mut regions: Vec<(usize, usize)> = Vec::new();
            let mut from = 0;
            while let Some(at) = text[from..].find(&header) {
                let start = from + at + header.len();
                let end =
                    start + text[start..].find(MODEL.im_end).expect("closed") + MODEL.im_end.len();
                regions.push((start, end));
                from = end;
            }
            assert!(!regions.is_empty());
            let (ids2, offsets) = tokenizer.encode(text).expect("encode");
            assert_eq!(ids2, ids);
            let mut region_weights: Vec<Vec<f32>> = vec![Vec::new(); regions.len()];
            for (i, (a, b)) in offsets.iter().enumerate() {
                weights_seen.insert(format!("{:?}", weights[i]));
                match regions.iter().position(|(s, e)| a >= s && b <= e) {
                    Some(r) => region_weights[r].push(weights[i]),
                    None => assert_eq!(
                        weights[i],
                        0.0,
                        "{:?} is not an assistant token",
                        &text[*a..*b]
                    ),
                }
            }
            for trained in region_weights {
                // a region is trained (every token weighs at least 1) or is the call the runtime was expected to refuse
                if trained.iter().all(|w| *w == 0.0) {
                    masked_regions += 1;
                } else {
                    assert!(
                        trained.iter().all(|w| *w >= 1.0),
                        "a gap in a trained message"
                    );
                    assert!(trained.contains(&2.0), "a step with no deciding token");
                }
            }
        }
    }
    assert!(seen >= 30, "{seen} sessions");
    assert_eq!(
        masked_regions, bad_calls,
        "exactly the refused calls are masked"
    );
    assert!(bad_calls > 0, "the run holds an error-then-repair turn");
    assert_eq!(
        weights_seen,
        ["0.0", "1.0", "2.0"].map(str::to_owned).into()
    );
}

#[test]
fn a_record_is_the_eval_session_with_a_render_beside_it_and_loads_in_the_eval_unchanged() {
    let (dir, _) = version_dir();
    let source =
        DatagenSource::open_version(dir.path(), &["train", "val", "test", "noise"]).expect("open");
    let sessions = source.sessions().expect("the eval reads the records");
    assert!(sessions.len() >= 30);
    for session in &sessions {
        assert!(source.world(&session.world).is_ok());
        assert!(!session.turns.is_empty());
    }
    for record in records(dir.path(), "train") {
        for key in [
            "id", "world", "today", "me", "tags", "turns", "meta", "render",
        ] {
            assert!(record.get(key).is_some(), "{key}");
        }
        assert!(
            record.get("scenario").is_none(),
            "the typed scenario stays behind"
        );
        for key in ["input_ids", "weights", "text"] {
            assert!(record["render"].get(key).is_some(), "render.{key}");
        }
        for turn in record["turns"].as_array().expect("turns") {
            for key in ["user", "gold", "ref", "tags"] {
                assert!(turn.get(key).is_some(), "{key}");
            }
        }
    }
}

/// Says each turn's reference calls in turn, reading the turn from the placeholder in the prompt.
struct Replay {
    calls: BTreeMap<String, Vec<String>>,
    said: Mutex<BTreeMap<String, usize>>,
}

impl Stepper for Replay {
    fn step(
        &self,
        prompt: &str,
        _dates: Option<&str>,
        _tools: ToolsMode,
    ) -> Result<StepOut, String> {
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
fn the_reference_calls_of_the_records_replay_to_their_gold_in_the_eval() {
    let (dir, _) = version_dir();
    let all: Vec<Value> = ["train", "val", "test"]
        .iter()
        .flat_map(|split| records(dir.path(), split))
        .collect();
    let mut calls = BTreeMap::new();
    for record in &all {
        for turn in record["turns"].as_array().expect("turns") {
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
            calls.insert(turn["user"].as_str().expect("user").to_owned(), texts);
        }
    }
    let replay = Replay {
        calls,
        said: Mutex::new(BTreeMap::new()),
    };
    let source = DatagenSource::open_version(dir.path(), &["train", "val", "test"]).expect("open");
    let mut runner = Runner::new(&source, &replay).expect("runner");
    let mut failed = Vec::new();
    let mut turns = 0;
    for session in source.sessions().expect("sessions") {
        let result = runner.run_session(&session).expect("session runs");
        for turn in &result.turns {
            turns += 1;
            if !turn.pass {
                failed.push(format!("{} {}: {:?}", result.id, turn.user, turn.problems));
            }
        }
    }
    assert!(turns > 50);
    assert!(
        failed.is_empty(),
        "{} of {turns} turns failed, first: {:?}",
        failed.len(),
        failed.iter().take(3).collect::<Vec<_>>()
    );
}

#[test]
fn no_world_is_in_two_splits_and_noise_follows_val() {
    let (dir, _) = version_dir();
    let mut home: BTreeMap<String, &str> = BTreeMap::new();
    for split in ["train", "val", "test"] {
        for record in records(dir.path(), split) {
            let world = record["world"].as_str().expect("world").to_owned();
            assert_eq!(
                *home.entry(world.clone()).or_insert(split),
                split,
                "{world}"
            );
        }
    }
    let val: BTreeSet<String> = records(dir.path(), "val")
        .iter()
        .map(|r| r["id"].as_str().expect("id").to_owned())
        .collect();
    for record in records(dir.path(), "noise") {
        let id = record["id"].as_str().expect("id");
        assert!(val.contains(id.trim_end_matches("~noise")), "{id}");
    }
}

#[test]
fn the_manifest_names_the_data_version() {
    let (dir, manifest) = version_dir();
    assert_eq!(manifest["catalog_hash"], catalog().hash());
    assert_eq!(
        manifest["tokenizer"]["blake3"],
        blake3::hash(byte_level_tokenizer_json().as_bytes())
            .to_hex()
            .to_string()
    );
    for key in [
        "runtime_commit",
        "seeds",
        "llm_cache",
        "weights",
        "targets",
        "splits",
        "files",
        "record",
    ] {
        assert!(manifest.get(key).is_some(), "{key}");
    }
    assert_eq!(manifest["weights"]["decision"], 2.0);
    // the files are what the manifest says
    for (name, file) in manifest["files"].as_object().expect("files") {
        let bytes = std::fs::read(dir.path().join(name)).expect("file");
        assert_eq!(
            file["blake3"],
            blake3::hash(&bytes).to_hex().to_string(),
            "{name}"
        );
    }
    // the shares are pinned per split
    for split in manifest["splits"].as_array().expect("splits") {
        assert!(split["multi_turn_share"].is_number());
        assert!(split["three_plus_share"].is_number());
    }
    let report = std::fs::read_to_string(dir.path().join("report.txt")).expect("report");
    assert!(report.contains("cells (turns)") && report.contains("target realised supply"));
}

#[test]
fn a_rebuild_from_the_same_input_is_byte_identical() {
    let (_, first) = version_dir();
    let again = tempfile::tempdir().expect("tempdir");
    let second = build(again.path());
    assert_eq!(first["files"], second["files"]);
}

#[test]
fn the_real_tokenizer_reads_a_record_as_the_byte_level_one_does_when_the_file_is_there() {
    // `DATAGEN_TOKENIZER=/path/to/Qwen3.5-0.8B/tokenizer.json cargo test -p centraid-datagen`; skipped without it
    let Some(path) = std::env::var_os("DATAGEN_TOKENIZER") else {
        return;
    };
    let real = Tokenizer::open(Path::new(&path)).expect("the tokenizer file");
    let (dir, _) = version_dir();
    let record = records(dir.path(), "train").remove(0);
    let text = record["render"]["text"].as_str().expect("text");
    let (ids, offsets) = real.encode(text).expect("encode");
    assert_eq!(real.decode(&ids).expect("decode"), text);
    // each special string of the format is one token
    let starts = text.matches(MODEL.im_start).count();
    let first = real.encode(MODEL.im_start).expect("encode").0;
    assert_eq!(first.len(), 1);
    assert_eq!(ids.iter().filter(|id| **id == first[0]).count(), starts);
    assert_eq!(ids.len(), offsets.len());
}
