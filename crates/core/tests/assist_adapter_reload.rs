//! AN ADAPTER THAT LANDS WHILE A TURN RUNS (#1188 G5), through the core's plan. Its own test
//! binary, because the reload is a load the core runs on its own pool thread, so the record must be
//! held on every thread (`held_for_all_threads`), which is only safe with no other test running
//! beside it.
//!
//! The turn is made observable without a clock: the model's `generate` blocks on a channel the test
//! controls, and every claim is a count of loads.

mod common;

use std::path::Path;
use std::sync::Arc;

use centraid_assist::ModelLoader;
use centraid_assist::model::{Control, GenerateRequest, Generation, Model, ModelError};
use centraid_core::api_proto as wire;
use wire::assist_request::Kind as Ask;

const ADAPTER_FILE: &str = "centraid-adapter-dddddddddddd.gguf";

/// A record whose current model is `New-Q4_0.gguf` with a 4-byte adapter made for it.
fn adapter_record() -> centraid_assist::record::Record {
    let current = centraid_assist::record::record().current;
    let adapter = centraid_assist::record::Adapter {
        url: format!(
            "https://huggingface.co/x/adapter/resolve/{}/a.gguf",
            "a".repeat(40)
        ),
        file_name: "a.gguf".to_owned(),
        sha256: "d".repeat(64),
        bytes: 4,
        base_sha256: "b".repeat(64),
        tools_hash: current.tools_hash.clone(),
        prompt_hash: current.prompt_hash.clone(),
        score: None,
    };
    centraid_assist::record::Record {
        current: centraid_assist::record::Entry {
            url: format!(
                "https://huggingface.co/x/y/resolve/{}/New-Q4_0.gguf",
                "a".repeat(40)
            ),
            file_name: "New-Q4_0.gguf".to_owned(),
            sha256: "b".repeat(64),
            bytes: 604_000_000,
            ..current
        },
        previous: None,
        adapter: Some(adapter),
    }
}

/// A model whose generation blocks until the test releases it, so a turn is observably running
/// with no clock: it says it started, waits for a release, then ends cancelled.
struct Gate {
    started: std::sync::Mutex<std::sync::mpsc::Sender<()>>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

impl Model for Gate {
    fn generate(
        &self,
        _: &GenerateRequest<'_>,
        _: &mut dyn FnMut(&str) -> Control,
    ) -> Result<Generation, ModelError> {
        self.started.lock().unwrap().send(()).unwrap();
        let _ = self.release.lock().unwrap().recv();
        Ok(Generation {
            text: String::new(),
            finish: centraid_assist::model::Finish::Cancelled,
            prompt_tokens: 0,
            generated_tokens: 0,
        })
    }
}

/// Records what every load was given: the adapter path, or none.
struct CountingLoader {
    seen: std::sync::Mutex<Vec<Option<std::path::PathBuf>>>,
    gate: Arc<Gate>,
}

impl CountingLoader {
    fn loads(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

impl ModelLoader for CountingLoader {
    fn load(&self, path: &Path) -> Result<Arc<dyn Model>, ModelError> {
        self.load_with_adapter(path, None)
    }

    fn load_with_adapter(
        &self,
        _: &Path,
        adapter: Option<&Path>,
    ) -> Result<Arc<dyn Model>, ModelError> {
        self.seen
            .lock()
            .unwrap()
            .push(adapter.map(Path::to_path_buf));
        Ok(Arc::clone(&self.gate) as Arc<dyn Model>)
    }
}

fn plan_of(answer: wire::AssistResponse) -> wire::AssistPlan {
    match answer.kind {
        Some(wire::assist_response::Kind::Plan(plan)) => plan,
        other => panic!("not a plan: {other:?}"),
    }
}

fn load(sample: &common::chat::Sample, path: &str) {
    sample
        .assist(Ask::Load(wire::AssistLoadRequest {
            model_path: path.to_owned(),
            projector_path: String::new(),
        }))
        .expect("the model loads");
}

#[test]
fn an_adapter_that_lands_during_a_turn_changes_nothing_under_it_and_loads_when_the_chat_opens_again()
 {
    centraid_assist::record::held_for_all_threads(adapter_record(), || {
        let (started_tx, started) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let loader = Arc::new(CountingLoader {
            seen: Vec::new().into(),
            gate: Arc::new(Gate {
                started: started_tx.into(),
                release: release_rx.into(),
            }),
        });
        let sample = common::chat::sample();
        let dir = sample.dir().join("models");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("New-Q4_0.gguf"), b"weights").unwrap();
        sample.handle.assist().host().set_loader(loader.clone());
        let models_dir = dir.display().to_string();

        // the chat opens: the plan says to load the current model, and the shell does
        let opened = plan_of(
            sample
                .assist(Ask::Opened(wire::AssistOpenedRequest {
                    models_dir: models_dir.clone(),
                }))
                .unwrap(),
        );
        assert!(!opened.reload && opened.load_path.is_empty());
        let status = plan_of(
            sample
                .assist(Ask::Plan(wire::AssistPlanRequest {
                    models_dir: models_dir.clone(),
                    intent: wire::AssistIntent::Status as i32,
                    ..wire::AssistPlanRequest::default()
                }))
                .unwrap(),
        );
        assert_eq!(status.stand, wire::AssistStand::UseCurrent as i32);
        assert_eq!(
            status.offer,
            wire::AssistOffer::AdapterOnly as i32,
            "the adapter is on offer"
        );
        load(&sample, &status.load_path);
        assert_eq!(loader.loads(), 1);

        let session = sample.start("");
        std::thread::scope(|scope| {
            let turn = scope.spawn(|| sample.send(session, 1, "hi"));
            started.recv().expect("the turn is generating");

            // the adapter lands under it
            std::fs::write(dir.join(ADAPTER_FILE), b"lora").unwrap();
            let landed = plan_of(
                sample
                    .assist(Ask::Finished(wire::AssistFinishedRequest {
                        models_dir: models_dir.clone(),
                        which: wire::AssistFinishedWhich::Adapter as i32,
                        ok: true,
                        facts: None,
                    }))
                    .unwrap(),
            );
            assert!(!landed.reload, "nothing reloads under a running turn");
            assert_eq!(
                landed.offer,
                wire::AssistOffer::None as i32,
                "the row is done"
            );
            assert_eq!(loader.loads(), 1);

            // the turn ends on the model it began with
            release.send(()).unwrap();
            turn.join().unwrap();
            assert_eq!(loader.loads(), 1, "the turn's end reloads nothing either");
        });

        // the tab opens again: now the model is loaded again, once, with the adapter in place
        let again = plan_of(
            sample
                .assist(Ask::Opened(wire::AssistOpenedRequest { models_dir }))
                .unwrap(),
        );
        assert!(again.reload, "one reload is owed");
        load(&sample, &again.load_path);
        assert_eq!(loader.loads(), 2, "one reload, with the adapter in place");
        assert_eq!(
            loader.seen.lock().unwrap()[1].as_deref(),
            Some(dir.join(ADAPTER_FILE).as_path())
        );
    });
}
