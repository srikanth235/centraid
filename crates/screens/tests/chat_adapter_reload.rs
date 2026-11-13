//! AN ADAPTER THAT LANDS WHILE A TURN RUNS (#1188 G5). Its own test binary, because the reload is
//! a load the core runs on its own pool thread, so the record must be held on every thread
//! (`held_for_all_threads`), which is only safe with no other test running beside it.
//!
//! The turn is made observable without a clock: the model's `generate` blocks on a channel the
//! test controls, and every claim is a count of loads.

mod chat_support;

use std::path::Path;
use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_assist::ModelLoader;
use centraid_assist::model::{Model, ModelError};
use chat_support::Chat;
use wire::chat_event::Kind as C;

const ADAPTER_FILE: &str = "centraid-adapter-dddddddddddd.gguf";

fn open_in(chat: &mut Chat, dir: &Path) {
    chat.event(C::Opened(wire::chat_event::Opened {
        models_dir: dir.display().to_string(),
        vault_name: "Sample".to_owned(),
        ..wire::chat_event::Opened::default()
    }));
    chat.perform();
}

fn finished(chat: &mut Chat, ok: bool) {
    chat.event(C::DownloadFinished(wire::chat_event::DownloadFinished {
        ok,
        vision: false,
    }));
}

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
        _: &centraid_assist::model::GenerateRequest<'_>,
        _: &mut dyn FnMut(&str) -> centraid_assist::model::Control,
    ) -> Result<centraid_assist::model::Generation, ModelError> {
        self.started.lock().unwrap().send(()).unwrap();
        let _ = self.release.lock().unwrap().recv();
        Ok(centraid_assist::model::Generation {
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

#[test]
fn an_adapter_that_lands_during_a_turn_changes_nothing_under_it_and_loads_when_the_tab_opens_again()
{
    let record = adapter_record();
    centraid_assist::record::held_for_all_threads(record, || {
        let (started_tx, started) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let loader = Arc::new(CountingLoader {
            seen: Vec::new().into(),
            gate: Arc::new(Gate {
                started: started_tx.into(),
                release: release_rx.into(),
            }),
        });
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("New-Q4_0.gguf"), b"weights").unwrap();
        let mut chat = Chat::with(None);
        chat.driver
            .handle
            .assist()
            .host()
            .set_loader(loader.clone());
        open_in(&mut chat, &dir);
        assert_eq!(loader.loads(), 1);
        // the member taps the row; a question starts a turn that does not finish until released
        chat.event(C::Download(wire::chat_event::DownloadTapped {
            update: true,
            ..Default::default()
        }));
        chat.event(C::Sent(wire::chat_event::Sent {
            text: "hi".to_owned(),
            token: 1,
        }));
        started.recv().expect("the turn is generating");
        // the adapter lands under it
        std::fs::write(dir.join(ADAPTER_FILE), b"lora").unwrap();
        finished(&mut chat, true);
        assert_eq!(loader.loads(), 1, "nothing reloads under a running turn");
        assert!(chat.state().update_step.is_none(), "the row is done");
        // the turn ends on the model it began with
        release.send(()).unwrap();
        chat.perform();
        assert_eq!(loader.loads(), 1, "the turn's end reloads nothing either");
        // the tab opens again: now the model is loaded again, once, and the file is there for it
        chat.open("");
        chat.event(C::Opened(wire::chat_event::Opened {
            models_dir: dir.display().to_string(),
            vault_name: "Sample".to_owned(),
            ..wire::chat_event::Opened::default()
        }));
        chat.perform();
        assert_eq!(loader.loads(), 2, "one reload, with the adapter in place");
    });
}
