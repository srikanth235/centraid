//! M3: phone-style messages and verify, with a deterministic fake model (no network).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::sync::OnceLock;

use anyhow::Result;
use centraid_datagen::brief::Briefer;
use centraid_datagen::intent::Scenario;
use centraid_datagen::llm::{Llm, json_of};
use centraid_datagen::messages::{self, Config};
use centraid_datagen::plan::is_placeholder;
use centraid_datagen::run::{self, Config as RunConfig};
use centraid_datagen::source::DatagenSource;
use centraid_datagen::verify;
use centraid_datagen::{Catalog, World, WorldSpec};
use serde_json::{Value, json};

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| Catalog::build().expect("catalog"))
}

/// A small intents run, written to a directory once.
fn intents_dir() -> &'static Path {
    static DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
    DIR.get_or_init(|| {
        let config = RunConfig {
            seed: 1,
            counts: [1, 1, 0],
            per_world: [0; 3],
            cell_limit: Some(14),
        };
        let scratch = tempfile::tempdir().expect("tempdir");
        let generated = run::generate(&config, catalog(), scratch.path()).expect("run");
        let dir = tempfile::tempdir().expect("tempdir");
        run::write(dir.path(), &config, catalog(), &generated).expect("write");
        dir
    })
    .path()
}

/// The marker a fake writer puts in a message: a number that identifies the turn's brief, so the
/// fake reader can look the intent up again. (A digit run: the typo pass leaves it alone.)
fn marker(ask: &str, how: &str) -> String {
    let h = blake3::hash(format!("{ask}\n{how}").as_bytes());
    let mut n = [0_u8; 4];
    n.copy_from_slice(&h.as_bytes()[..4]);
    format!("q{}", u32::from_le_bytes(n))
}

/// Writes `show <spans> <marker>` for each turn (a pronoun turn says `show those <marker>`), reads
/// back by looking the marker up in the intents. Records every prompt.
struct Fake {
    expected: BTreeMap<String, verify::Expected>,
    prompts: Mutex<Vec<String>>,
    calls: Mutex<usize>,
}

impl Fake {
    fn new() -> Self {
        let mut expected = BTreeMap::new();
        for split in ["train", "val"] {
            let text = std::fs::read_to_string(intents_dir().join(split).join("sessions.jsonl"))
                .expect("sessions");
            for line in text.lines() {
                let record: Value = serde_json::from_str(line).expect("json");
                let scenario: Scenario =
                    serde_json::from_value(record["scenario"].clone()).expect("scenario");
                let today = record["today"].as_str().expect("today")[..10]
                    .parse()
                    .expect("date");
                let briefer = Briefer {
                    catalog: catalog(),
                    today,
                };
                for (i, turn) in scenario.turns.iter().enumerate() {
                    let b = briefer.turn(turn, i);
                    expected.insert(marker(&b.ask, &b.how), verify::expected(turn, today));
                }
            }
        }
        Self {
            expected,
            prompts: Mutex::new(Vec::new()),
            calls: Mutex::new(0),
        }
    }
}

impl Llm for Fake {
    fn model(&self) -> &str {
        "fake"
    }

    fn complete(&self, prompt: &str) -> Result<String> {
        self.prompts.lock().expect("lock").push(prompt.to_owned());
        *self.calls.lock().expect("lock") += 1;
        let start = prompt.find("Sessions:\n").expect("sessions") + "Sessions:\n".len();
        let sessions = json_of(&format!("{{\"s\": {}}}", &prompt[start..]))?;
        let mut out = Vec::new();
        if prompt.starts_with("You write what a person types") {
            for s in sessions["s"].as_array().expect("array") {
                let messages: Vec<String> = s["turns"]
                    .as_array()
                    .expect("turns")
                    .iter()
                    .map(|t| {
                        let spans: Vec<&str> = t["say_verbatim"]
                            .as_array()
                            .expect("spans")
                            .iter()
                            .filter_map(Value::as_str)
                            .collect();
                        let m = marker(
                            t["ask"].as_str().expect("ask"),
                            t["how"].as_str().expect("how"),
                        );
                        if spans.is_empty() {
                            format!("show those {m}")
                        } else {
                            format!("show {} {m}", spans.join(" and "))
                        }
                    })
                    .collect();
                out.push(json!({"id": s["id"], "messages": messages}));
            }
        } else {
            for s in sessions["s"].as_array().expect("array") {
                let turns: Vec<Value> = s["messages"]
                    .as_array()
                    .expect("messages")
                    .iter()
                    .map(|m| {
                        let text = m.as_str().expect("text");
                        let at = text.rfind('q').expect("marker");
                        let want = &self.expected[&text[at..]];
                        json!({
                            "act": want.act,
                            "kind": want.kind.clone().unwrap_or_else(|| "unknown".into()),
                            "from": want.period.map(|p| p.0.to_string()).unwrap_or_default(),
                            "to": want.period.map(|p| p.1.to_string()).unwrap_or_default(),
                            "numbers": want.numbers,
                            "leans_on": want.leans.map(|l| l.0 + 1),
                            "decline_reason": want.decline,
                        })
                    })
                    .collect();
                out.push(json!({"id": s["id"], "turns": turns}));
            }
        }
        Ok(json!({"sessions": out}).to_string())
    }
}

fn files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(d).expect("dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let name = path
                    .strip_prefix(dir)
                    .expect("prefix")
                    .display()
                    .to_string();
                out.insert(name, std::fs::read(&path).expect("read"));
            }
        }
    }
    out
}

fn config(offline: bool) -> Config {
    Config {
        batch: 5,
        concurrency: 3,
        offline,
        limit: None,
        seed: 1,
    }
}

#[test]
fn a_rebuild_from_a_warm_cache_makes_no_call_and_is_byte_identical() {
    let a = tempfile::tempdir().expect("tempdir");
    let fake = Fake::new();
    let first =
        messages::run(&config(false), catalog(), &fake, intents_dir(), a.path()).expect("run");
    assert!(first.calls > 0);
    assert!(
        first.stats.turns_kept > 0,
        "the fake's messages should mostly survive"
    );

    // the cache travels with the data version; copy it and rebuild offline with a model that
    // must not be called
    let b = tempfile::tempdir().expect("tempdir");
    copy_dir(&a.path().join("llm-cache"), &b.path().join("llm-cache"));
    struct Never;
    impl Llm for Never {
        fn model(&self) -> &str {
            "fake"
        }
        fn complete(&self, _: &str) -> Result<String> {
            anyhow::bail!("a warm cache must make no call")
        }
    }
    let second = messages::run(&config(true), catalog(), &Never, intents_dir(), b.path())
        .expect("offline rebuild");
    assert_eq!(second.calls, 0);
    assert!(second.hits > 0);
    assert_eq!(
        files(a.path()),
        files(b.path()),
        "the rebuild is byte-identical"
    );

    // offline with a cold cache fails instead of calling
    let c = tempfile::tempdir().expect("tempdir");
    assert!(messages::run(&config(true), catalog(), &Never, intents_dir(), c.path()).is_err());
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("mkdir");
    for entry in std::fs::read_dir(from).expect("dir") {
        let path = entry.expect("entry").path();
        let target = to.join(path.file_name().expect("name"));
        if path.is_dir() {
            copy_dir(&path, &target);
        } else {
            std::fs::copy(&path, &target).expect("copy");
        }
    }
}

#[test]
fn no_sealed_value_or_placeholder_reaches_a_prompt() {
    let out = tempfile::tempdir().expect("tempdir");
    let fake = Fake::new();
    messages::run(&config(false), catalog(), &fake, intents_dir(), out.path()).expect("run");
    let prompts = fake.prompts.lock().expect("lock");
    assert!(!prompts.is_empty());
    // every sealed placeholder a world would seed
    let mut sealed = Vec::new();
    for id in ["train-00", "val-00"] {
        let text = std::fs::read_to_string(intents_dir().join("worlds").join(format!("{id}.json")))
            .expect("world");
        let doc: Value = serde_json::from_str(&text).expect("json");
        let seeded = centraid_datagen::world::seed_document_of(&doc).to_string();
        for part in seeded.split('"').filter(|p| p.starts_with("placeholder:")) {
            sealed.push(part.to_owned());
        }
    }
    assert!(!sealed.is_empty(), "the worlds hold sealed fields to leak");
    for prompt in prompts.iter() {
        assert!(messages::no_sealed(prompt).is_ok());
        for s in &sealed {
            assert!(!prompt.contains(s.as_str()), "{s} reached a prompt");
        }
        assert!(!prompt.contains("⟨m3:"));
    }
}

#[test]
fn the_output_is_a_run_the_eval_reads_with_real_messages_and_verdicts() {
    let out = tempfile::tempdir().expect("tempdir");
    let fake = Fake::new();
    let report =
        messages::run(&config(false), catalog(), &fake, intents_dir(), out.path()).expect("run");
    let source = DatagenSource::open(out.path(), None).expect("open");
    let sessions = centraid_assist_eval::source::EvalSource::sessions(&source).expect("sessions");
    assert_eq!(sessions.len(), report.stats.sessions_kept);
    for s in &sessions {
        for t in &s.turns {
            assert!(!is_placeholder(&t.user), "{}", t.user);
        }
    }
    // the noise copy of val is its own directory, heavier than the clean val text
    let noise = DatagenSource::open_named(out.path(), &["noise"]).expect("noise");
    let noisy = centraid_assist_eval::source::EvalSource::sessions(&noise).expect("sessions");
    assert!(!noisy.is_empty());
    assert!(noisy.iter().all(|s| s.id.ends_with("~noise")));
    // a verdict beside every turn, and the drops are listed with reasons
    let text = std::fs::read_to_string(out.path().join("val").join("sessions.jsonl")).expect("val");
    let record: Value =
        serde_json::from_str(text.lines().next().expect("a session")).expect("json");
    assert_eq!(record["turns"][0]["verify"]["keep"], true);
    let dropped = std::fs::read_to_string(out.path().join("dropped.jsonl")).expect("dropped");
    for line in dropped.lines() {
        let row: Value = serde_json::from_str(line).expect("json");
        assert!(
            row["reason"].as_str().is_some_and(|r| !r.is_empty()),
            "{row}"
        );
    }
    assert!(report.text.contains("by grid cell"));
    assert!(report.text.contains("read-back recovery"));
}

#[test]
fn a_world_read_back_from_its_document_replays_like_the_original() {
    let doc: Value = serde_json::from_str(
        &std::fs::read_to_string(intents_dir().join("worlds").join("train-00.json"))
            .expect("world"),
    )
    .expect("json");
    let world = World::from_doc(&doc).expect("world");
    assert_eq!(world.id(), "train-00");
    let _: WorldSpec = world.spec;
}
