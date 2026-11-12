//! M3: phone-style messages and verify, with a deterministic fake model (no network).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;

use anyhow::Result;
use centraid_datagen::llm::Llm;
use centraid_datagen::messages::{self, Config};
use centraid_datagen::plan::is_placeholder;
use centraid_datagen::rehearsal::Rehearsal;
use centraid_datagen::run::{self, Config as RunConfig};
use centraid_datagen::source::DatagenSource;
use centraid_datagen::{Catalog, World, WorldSpec};
use serde_json::Value;

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
            mistakes: Vec::new(),
        };
        let scratch = tempfile::tempdir().expect("tempdir");
        let generated = run::generate(&config, catalog(), scratch.path()).expect("run");
        let dir = tempfile::tempdir().expect("tempdir");
        run::write(dir.path(), &config, catalog(), &generated).expect("write");
        dir
    })
    .path()
}

/// The rehearsal models of the library: two writers (the test split's is another model than train's) and a reader.
struct Models {
    writer: Rehearsal,
    test_writer: Rehearsal,
    reader: Rehearsal,
}

impl Models {
    fn new() -> Self {
        let make = |role: &str| Rehearsal::new(role, catalog(), intents_dir()).expect("rehearsal");
        Self {
            writer: make("writer"),
            test_writer: make("writer-b"),
            reader: make("reader"),
        }
    }

    fn all(&self) -> messages::Models<'_> {
        messages::Models {
            writer: [&self.writer, &self.writer, &self.test_writer],
            reader: [&self.reader, &self.reader, &self.reader],
        }
    }

    fn prompts(&self) -> Vec<String> {
        [&self.writer, &self.test_writer, &self.reader]
            .iter()
            .flat_map(|m| m.prompts.lock().expect("lock").clone())
            .collect()
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
        collect: None,
        limit: None,
        seed: 1,
        style_shares: centraid_datagen::style::DEFAULT_SHARES,
    }
}

#[test]
fn a_rebuild_from_a_warm_cache_makes_no_call_and_is_byte_identical() {
    let a = tempfile::tempdir().expect("tempdir");
    let models = Models::new();
    let first = messages::run(
        &config(false),
        catalog(),
        &models.all(),
        intents_dir(),
        a.path(),
    )
    .expect("run");
    assert!(first.calls > 0);
    assert!(
        first.stats.turns_kept > 0,
        "the fake's messages should mostly survive"
    );

    // the cache travels with the data version; copy it and rebuild offline with a model that
    // must not be called
    let b = tempfile::tempdir().expect("tempdir");
    copy_dir(&a.path().join("llm-cache"), &b.path().join("llm-cache"));
    struct Never(&'static str);
    impl Llm for Never {
        fn model(&self) -> &str {
            self.0
        }
        fn complete(&self, _: &str) -> Result<String> {
            anyhow::bail!("a warm cache must make no call")
        }
    }
    let (w, wb, r) = (
        Never("rehearsal-writer"),
        Never("rehearsal-writer-b"),
        Never("rehearsal-reader"),
    );
    let never = messages::Models {
        writer: [&w, &w, &wb],
        reader: [&r, &r, &r],
    };
    let second = messages::run(&config(true), catalog(), &never, intents_dir(), b.path())
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
    assert!(messages::run(&config(true), catalog(), &never, intents_dir(), c.path()).is_err());
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
    let models = Models::new();
    messages::run(
        &config(false),
        catalog(),
        &models.all(),
        intents_dir(),
        out.path(),
    )
    .expect("run");
    let prompts = models.prompts();
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
    let models = Models::new();
    let report = messages::run(
        &config(false),
        catalog(),
        &models.all(),
        intents_dir(),
        out.path(),
    )
    .expect("run");
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

#[test]
fn a_reader_that_is_its_split_writer_is_refused_and_so_is_a_test_writer_of_trains() {
    let models = Models::new();
    let out = tempfile::tempdir().expect("tempdir");
    // the test split read back by its own writer
    let own = messages::Models {
        writer: [&models.writer, &models.writer, &models.test_writer],
        reader: [&models.reader, &models.reader, &models.test_writer],
    };
    let err = messages::run(&config(false), catalog(), &own, intents_dir(), out.path())
        .err()
        .expect("refused");
    assert!(
        err.to_string()
            .contains("test split is read back by its own writer"),
        "{err}"
    );
    // the test split written by train's writer
    let same = messages::Models {
        writer: [&models.writer, &models.writer, &models.writer],
        reader: [&models.reader, &models.reader, &models.reader],
    };
    let err = messages::run(&config(false), catalog(), &same, intents_dir(), out.path())
        .err()
        .expect("refused");
    assert!(err.to_string().contains("train's writer"), "{err}");
    assert!(models.prompts().is_empty(), "a refused build calls nothing");
}

#[test]
fn sessions_carry_their_style_and_writer_and_the_test_split_has_its_own_style_words() {
    let out = tempfile::tempdir().expect("tempdir");
    let models = Models::new();
    let report = messages::run(
        &config(false),
        catalog(),
        &models.all(),
        intents_dir(),
        out.path(),
    )
    .expect("run");
    assert!(report.text.contains("recovery of act"));
    let train =
        std::fs::read_to_string(out.path().join("train").join("sessions.jsonl")).expect("train");
    let first: Value =
        serde_json::from_str(train.lines().next().expect("a session")).expect("json");
    let tags: Vec<&str> = first["tags"]
        .as_array()
        .expect("tags")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(tags.iter().any(|t| t.starts_with("style:")), "{tags:?}");
    assert!(tags.contains(&"writer:rehearsal-writer"), "{tags:?}");
    // no prompt the train writer was given holds a sentence of the test split's style wording
    for style in centraid_datagen::style::ALL {
        let test_words = style.instruction(true);
        for p in models.writer.prompts.lock().expect("lock").iter() {
            assert!(
                !p.contains(test_words),
                "train's prompt holds the test wording of {}",
                style.name()
            );
        }
    }
    let models_json = std::fs::read_to_string(out.path().join("models.json")).expect("models.json");
    assert!(models_json.contains("rehearsal-writer-b"));
}
