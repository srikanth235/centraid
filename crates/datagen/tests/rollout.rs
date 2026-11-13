//! M7 records rendered by M4's renderer: the render of a rollout record is the data version's render, and the command's
//! path (a scripted model, the eval's runner, `records::cut`) writes records that carry it. No network, no weights.

use std::path::Path;
use std::sync::OnceLock;

use centraid_assist::native::identity::MODEL;
use centraid_assist::native::prompt::ToolsMode;
use centraid_assist_eval::rollout::fake::Scripted;
use centraid_assist_eval::rollout::records::{self, Cutting, Needs, Record, RecordTurn, Weighing};
use centraid_assist_eval::rollout::run_rollouts;
use centraid_assist_eval::run::Runner;
use centraid_assist_eval::source::EvalSource;
use centraid_datagen::Catalog;
use centraid_datagen::mix::{self, Shares};
use centraid_datagen::render::{Tokenizer, byte_level_tokenizer, byte_level_tokenizer_json};
use centraid_datagen::rollout::{Renderer, read_worlds};
use centraid_datagen::run::{self, Config as RunConfig};
use centraid_datagen::source::DatagenSource;
use centraid_datagen::version::{self, Provenance, RenderConfig};
use serde_json::{Value, json};

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| Catalog::build().expect("catalog"))
}

/// A small data version, built once.
fn version_dir() -> &'static tempfile::TempDir {
    static DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
    DIR.get_or_init(|| {
        let config = RunConfig {
            seed: 1,
            counts: [3, 1, 1],
            per_world: [0; 3],
            cell_limit: Some(40),
            mistakes: Vec::new(),
        };
        let scratch = tempfile::tempdir().expect("tempdir");
        let generated = run::generate(&config, catalog(), scratch.path()).expect("run");
        let input = tempfile::tempdir().expect("tempdir");
        run::write(input.path(), &config, catalog(), &generated).expect("write");
        let tokenizer = input.path().join("tokenizer.json");
        std::fs::write(&tokenizer, byte_level_tokenizer_json()).expect("tokenizer");
        let out = tempfile::tempdir().expect("tempdir");
        version::render_and_mix(
            input.path(),
            out.path(),
            &RenderConfig {
                tokenizer,
                decision_weight: 2.0,
                concurrency: 2,
            },
            &mix::Config {
                targets: [60, 15, 15],
                shares: Shares::default(),
                seed: 1,
                live: Vec::new(),
                floor: [0; 3],
                subsets: Vec::new(),
                reserved: Vec::new(),
                reserve: 0,
                ..mix::Config::default()
            },
            &Provenance {
                version: "test".to_owned(),
                runtime_commit: "unknown".to_owned(),
                tokenizer_path: "tokenizer.json".to_owned(),
                seeds: json!({"master": 1, "mix": 1}),
            },
        )
        .expect("render and mix");
        out
    })
}

fn records_of(dir: &Path, split: &str) -> Vec<Value> {
    let file =
        std::fs::File::open(centraid_datagen::version::split_path(dir, split)).expect("file");
    let text = String::from_utf8(zstd::stream::decode_all(file).expect("zstd")).expect("utf8");
    text.lines()
        .map(|line| serde_json::from_str(line).expect("a record"))
        .collect()
}

/// The messages of an assistant side as the model would have written them, read back out of a rendered text: one per
/// step, each from `<think>` through its call, without the `<|im_end|>` the log adds.
fn said_in(text: &str) -> Vec<String> {
    let header = format!("{}assistant\n", MODEL.im_start);
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find(&header) {
        let start = from + at + header.len();
        let end = start + text[start..].find(MODEL.im_end).expect("closed");
        out.push(text[start..end].to_owned());
        from = end;
    }
    out
}

/// A rollout record that says what the data version's record says: each turn's messages are that turn's steps.
fn rollout_record(record: &Value) -> Record {
    let said = said_in(record["render"]["text"].as_str().expect("text"));
    let mut next = said.into_iter();
    let turns = record["turns"]
        .as_array()
        .expect("turns")
        .iter()
        .map(|turn| RecordTurn {
            user: turn["user"].as_str().unwrap_or_default().to_owned(),
            gold: Vec::new(),
            reference: Vec::new(),
            tags: Vec::new(),
            said: next
                .by_ref()
                .take(turn["ref"].as_array().expect("ref").len())
                .collect(),
        })
        .collect();
    Record {
        id: record["id"].as_str().expect("id").to_owned(),
        world: record["world"].as_str().expect("world").to_owned(),
        today: record["today"].as_str().expect("today").to_owned(),
        me: record["me"].as_str().expect("me").to_owned(),
        tags: Vec::new(),
        turns,
        render: None,
    }
}

#[test]
fn a_rollout_record_renders_exactly_as_the_data_version_renders_its_session() {
    let dir = version_dir().path();
    let tokenizer = byte_level_tokenizer().expect("tokenizer");
    let version: Vec<Value> = ["train", "val", "test"]
        .iter()
        .flat_map(|split| records_of(dir, split))
        .collect();
    let worlds =
        read_worlds(dir, version.iter().filter_map(|r| r["world"].as_str())).expect("worlds");
    let scratch = tempfile::tempdir().expect("tempdir");
    let renderer = Renderer::new(catalog(), &worlds, &tokenizer, 2.0, scratch.path());
    let mut masked = 0;
    for record in &version {
        let rendered = renderer
            .render_one(&rollout_record(record))
            .unwrap_or_else(|e| panic!("{}: {e}", record["id"]));
        let ids: Vec<u32> =
            serde_json::from_value(record["render"]["input_ids"].clone()).expect("ids");
        let weights: Vec<f32> =
            serde_json::from_value(record["render"]["weights"].clone()).expect("weights");
        assert_eq!(
            rendered.text,
            record["render"]["text"].as_str().expect("text")
        );
        assert_eq!(rendered.input_ids, ids, "{}", record["id"]);
        assert_eq!(rendered.weights, weights, "{}", record["id"]);
        masked += weights.iter().filter(|w| **w == 0.0).count();
    }
    assert!(version.len() >= 30, "{} records", version.len());
    assert!(masked > 0);
}

/// The ids and weights of a rendered record, as the trainer reads them.
fn check_render(line: &Value, tokenizer: &Tokenizer) {
    let render = &line["render"];
    let ids: Vec<u32> = serde_json::from_value(render["input_ids"].clone()).expect("ids");
    let weights: Vec<f32> = serde_json::from_value(render["weights"].clone()).expect("weights");
    assert!(!ids.is_empty());
    assert_eq!(ids.len(), weights.len());
    assert_eq!(
        tokenizer.decode(&ids).expect("decode"),
        render["text"].as_str().expect("text")
    );
    assert!(weights.contains(&1.0) && weights.contains(&2.0));
    assert_eq!(weights[0], 0.0, "the system turn is context");
}

#[test]
fn the_scripted_model_gives_records_with_a_render_the_trainer_can_read() {
    let dir = version_dir().path();
    let tokenizer = byte_level_tokenizer().expect("tokenizer");
    let source = DatagenSource::open_version(dir, &["train"]).expect("open");
    let sessions = source.sessions().expect("sessions");
    let session = &sessions[0];
    let version = records_of(dir, "train");
    let record = version
        .iter()
        .find(|r| r["id"] == session.id.as_str())
        .expect("the session's record");
    // sample 0 says the reference messages (it passes), sample 1 declines every step (it fails unless gold declines)
    let mut script = said_in(record["render"]["text"].as_str().expect("text"));
    script.retain(|message| !message.is_empty());
    let steps = script.len();
    script.push(centraid_assist_eval::rollout::fake::message(
        "decline",
        &[("reason", "out_of_scope")],
    ));
    let model = Scripted::new(script);
    let mut runner = Runner::new(&source, &model)
        .expect("runner")
        .with_tools(ToolsMode::Sig);
    let rollouts = run_rollouts(&mut runner, session, 2).expect("rollouts");
    assert!(steps > 1);
    assert!(
        rollouts[0].result.pass(),
        "the reference messages pass: {:?}",
        rollouts[0]
            .result
            .turns
            .iter()
            .map(|t| &t.problems)
            .collect::<Vec<_>>()
    );

    let worlds = read_worlds(dir, [session.world.as_str()]).expect("worlds");
    let scratch = tempfile::tempdir().expect("tempdir");
    let renderer = Renderer::new(catalog(), &worlds, &tokenizer, 2.0, scratch.path());
    let out = tempfile::tempdir().expect("tempdir");
    let stats = records::cut(
        &sessions,
        &rollouts,
        &Cutting {
            needs: &Needs::default(),
            weighing: Weighing::default(),
        },
        Some(&renderer),
        out.path(),
    )
    .expect("cut");
    assert!(stats.rft_records >= 1);
    let text = std::fs::read_to_string(out.path().join("rft.jsonl")).expect("rft.jsonl");
    let lines: Vec<Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).expect("a line"))
        .collect();
    assert_eq!(lines.len(), stats.rft_lines);
    for line in &lines {
        check_render(line, &tokenizer);
        // the record is rendered from what the model said, which is the version's own text for the passing sample
        assert_eq!(
            line["render"]["text"], record["render"]["text"],
            "the passing sample renders as the data version's session"
        );
    }
    // the weighted record carries `render` beside the eval's session fields
    for key in [
        "id", "world", "today", "me", "turns", "weight", "copies", "cells",
    ] {
        assert!(lines[0].get(key).is_some(), "{key}");
    }
}

/// A data version's sessions carry the split file they were read from, and a val, test or noise split cannot be cut
/// into training records (`datagen rollout-records --split val` stops on this check).
#[test]
fn a_held_out_split_of_a_data_version_is_refused() {
    let dir = version_dir();
    for (split, held) in [("train", false), ("val", true), ("test", true)] {
        let source = DatagenSource::open_version(dir.path(), &[split]).expect("open");
        let sessions = source.sessions().expect("sessions");
        assert!(!sessions.is_empty(), "{split}");
        assert!(sessions.iter().all(|s| s.split.as_deref() == Some(split)));
        assert_eq!(
            records::refuse_held_out(&sessions).is_err(),
            held,
            "{split}"
        );
    }
}
