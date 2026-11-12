//! M4: render and mix, end to end over a small intents run, with a byte-level tokenizer (no network, no model file).
//!
//! What is proved here: every step's think compiles back to its reference call, the records carry the contract M6 reads
//! (ids and weights of one length, the mask exactly the assistant messages), the records load in `assist-eval` and replay
//! to their gold, no world is in two splits, the manifest names the version, and a rebuild is byte-identical.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use centraid_assist::native::identity::MODEL;
use centraid_assist::native::prompt::ToolsMode;
use centraid_assist_eval::replay;
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
    let file =
        std::fs::File::open(centraid_datagen::version::split_path(dir, split)).expect("file");
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

/// The path a scoring run takes before any model is asked: the reference calls replayed through the runner and judge.
#[test]
fn the_reference_calls_of_the_records_replay_to_their_gold_in_the_eval() {
    let (dir, _) = version_dir();
    let source = DatagenSource::open_version(dir.path(), &["train", "val", "test"]).expect("open");
    let sessions = source.sessions().expect("sessions");
    let report = replay::require(&source, &sessions, ToolsMode::Sig).expect("the version replays");
    assert!(report.turns > 50);
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
    let report =
        std::fs::read_to_string(dir.path().join("build").join("render.txt")).expect("report");
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

#[test]
fn the_real_tokenizer_gives_the_ids_the_huggingface_one_gave_when_the_file_is_there() {
    // The ids below were read from the `tokenizers` crate on the same file, and our encoder matched it on 3.5 million texts
    // (#1171); they pin the special tokens, the digit split, the double space and NFC.
    let Some(path) = std::env::var_os("DATAGEN_TOKENIZER") else {
        return;
    };
    let real = Tokenizer::open(Path::new(&path)).expect("the tokenizer file");
    let ids = |text: &str| real.encode(text).expect("encode").0;
    assert_eq!(
        ids("<|im_start|>user\nHello, world! 123<|im_end|>\n"),
        [
            248_045, 846, 198, 9419, 11, 1814, 0, 220, 16, 17, 18, 248_046, 198
        ]
    );
    assert_eq!(ids("e\u{301}  \n\n x'S"), [933, 18050, 830, 12887]);
    assert_eq!(
        ids("<think>\nfind  tasks  due"),
        [248_068, 198, 3772, 220, 8806, 220, 4016]
    );
}

#[test]
fn the_packed_llm_cache_unpacks_byte_for_byte_and_refuses_paths_outside_the_cache() {
    let from = tempfile::tempdir().expect("tempdir");
    let files = [
        ("ab/ab01.json", "{\"response\": \"x\"}\n"),
        ("cd/cd02.json", "{\"response\": \"ü\"}"),
    ];
    for (rel, text) in files {
        let path = from.path().join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, text).expect("write");
    }
    let packed = from.path().join("packed.jsonl.zst");
    assert_eq!(
        centraid_datagen::version::pack_cache(from.path(), &packed).expect("pack"),
        2
    );
    let to = tempfile::tempdir().expect("tempdir");
    assert_eq!(
        centraid_datagen::version::unpack_cache(&packed, to.path()).expect("unpack"),
        2
    );
    for (rel, text) in files {
        assert_eq!(
            std::fs::read_to_string(to.path().join(rel)).expect("read"),
            text,
            "{rel}"
        );
    }
    assert_eq!(
        centraid_datagen::version::cache_hash(from.path()).expect("hash"),
        centraid_datagen::version::cache_hash(to.path()).expect("hash"),
    );

    let evil = from.path().join("evil.jsonl.zst");
    let line = serde_json::json!({"file": "../x.json", "text": "no"}).to_string();
    std::fs::write(
        &evil,
        zstd::stream::encode_all(line.as_bytes(), 3).expect("zstd"),
    )
    .expect("write");
    assert!(centraid_datagen::version::unpack_cache(&evil, to.path()).is_err());
    assert!(!to.path().join("../x.json").exists());
}

#[test]
fn a_version_is_its_publishable_tree() {
    let (dir, manifest) = version_dir();
    for path in [
        "manifest.json",
        "build/render.txt",
        "build/render-dropped.jsonl",
        "build/llm-cache.jsonl.zst",
    ] {
        assert!(dir.path().join(path).is_file(), "{path}");
    }
    for split in ["train", "val", "test", "noise"] {
        assert!(
            manifest["files"][format!("data/{split}.jsonl.zst")].is_object(),
            "{split}"
        );
    }
    assert!(dir.path().join("worlds").is_dir());
    assert_eq!(manifest["llm_cache"]["packed"], "build/llm-cache.jsonl.zst");
    assert_eq!(
        manifest["llm_cache"]["packed_entries"],
        manifest["llm_cache"]["entries"]
    );
}
