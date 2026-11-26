//! THE ADAPTER SWITCH, THROUGH THE CORE (#1188 G4). A vault turn runs with the adapter on; a reply
//! over an attachment runs with it off. The model is scripted and records the `AdapterUse` every
//! generation was given, so there are no weights: the claim is about the switch the core makes
//! (`Switched { adapter: for_vault_turn(..) }`), counted per generation.
//!
//! Its own test binary: the record is held on every thread (`held_for_all_threads`) because the
//! turn runs on the core's own threads, which is only safe with no other test beside it.

mod common;

use std::path::Path;
use std::sync::{Arc, Mutex};

use centraid_assist::host::ModelLoader;
use centraid_assist::model::{AdapterUse, Control, GenerateRequest, Generation, Model, ModelError};
use centraid_assist::record::{Adapter, Entry, Record};
use centraid_assist::testing::ScriptedModel;
use centraid_core::api_proto as wire;
use wire::assist_request::Kind as Ask;

const BASE: &str = "Switch-Q4_0.gguf";
const ADAPTER_BYTES: &[u8] = b"adpt";

/// A model that says what its script says and keeps the adapter choice of each generation.
struct Spy {
    inner: ScriptedModel,
    seen: Mutex<Vec<AdapterUse>>,
}

impl Spy {
    fn take(&self) -> Vec<AdapterUse> {
        std::mem::take(&mut self.seen.lock().unwrap())
    }
}

impl Model for Spy {
    fn generate_with(
        &self,
        request: &GenerateRequest<'_>,
        adapter: AdapterUse,
        on_token: &mut dyn FnMut(&str) -> Control,
    ) -> Result<Generation, ModelError> {
        self.seen.lock().unwrap().push(adapter);
        self.inner.generate(request, on_token)
    }

    fn generate(
        &self,
        request: &GenerateRequest<'_>,
        on_token: &mut dyn FnMut(&str) -> Control,
    ) -> Result<Generation, ModelError> {
        // a caller that makes no choice runs the base: the same words as the engine's default
        self.generate_with(request, AdapterUse::Off, on_token)
    }
}

struct Loader(Arc<dyn Model>);

impl ModelLoader for Loader {
    fn load(&self, _: &Path) -> Result<Arc<dyn Model>, ModelError> {
        Ok(Arc::clone(&self.0))
    }
}

/// The committed record with its current model named `BASE` and an adapter made for it, for the
/// runtime's own catalogue and prompt.
fn record_with_adapter() -> Record {
    let current = centraid_assist::record::record().current;
    let adapter = Adapter {
        url: format!(
            "https://huggingface.co/x/adapter/resolve/{}/a.gguf",
            "a".repeat(40)
        ),
        file_name: "a.gguf".to_owned(),
        sha256: "e".repeat(64),
        bytes: ADAPTER_BYTES.len() as u64,
        base_sha256: "b".repeat(64),
        tools_hash: current.tools_hash.clone(),
        prompt_hash: current.prompt_hash.clone(),
        score: None,
    };
    let local = adapter.local_name();
    let record = Record {
        current: Entry {
            file_name: BASE.to_owned(),
            sha256: "b".repeat(64),
            ..current
        },
        previous: None,
        adapter: Some(adapter),
    };
    assert!(local.starts_with("centraid-adapter-"), "{local}");
    record
}

fn send(
    sample: &common::chat::Sample,
    session: u64,
    turn: u64,
    attachments: Vec<wire::AssistAttachment>,
) {
    let sent = sample
        .assist(Ask::Send(wire::AssistSendRequest {
            session_id: session,
            text: "what is due today?".to_owned(),
            tz: common::chat::TZ.to_owned(),
            regenerate: false,
            turn_id: turn,
            attachments,
        }))
        .expect("a send answers");
    let Some(wire::assist_response::Kind::Sent(_)) = sent.kind else {
        panic!("a send answered {sent:?}");
    };
}

#[test]
fn a_vault_turn_runs_with_the_adapter_on_and_a_reply_over_an_attachment_with_it_off() {
    let record = record_with_adapter();
    let adapter_file = record.adapter.as_ref().unwrap().local_name();
    centraid_assist::record::held_for_all_threads(record, || {
        let sample = common::chat::sample();
        let dir = sample.dir().join("models");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(BASE), b"weights").unwrap();
        std::fs::write(dir.join(adapter_file), ADAPTER_BYTES).unwrap();

        let steps = common::chat::read_tasks();
        let script = steps
            .iter()
            .flatten()
            .cloned()
            .chain(["It is about a trip.".to_owned()]);
        let spy = Arc::new(Spy {
            inner: ScriptedModel::new(script),
            seen: Mutex::new(Vec::new()),
        });
        let host = sample.handle.assist().host();
        host.set_loader(Arc::new(Loader(Arc::clone(&spy) as Arc<dyn Model>)));
        host.load(&dir.join(BASE)).expect("the model loads");
        assert!(host.loaded_path().is_some(), "the model came from a file");

        // a vault turn: every generation of the native plane carries the switch on
        let session = sample.start("");
        send(&sample, session, 1, Vec::new());
        let vault = spy.take();
        assert!(!vault.is_empty(), "the vault turn generated");
        assert!(
            vault.iter().all(|used| *used == AdapterUse::On),
            "a vault turn runs with the adapter on: {vault:?}"
        );

        // a reply over an attachment: the plane's own path, never switched on
        let documents = match sample
            .assist(Ask::Documents(wire::AssistDocumentsRequest { limit: 5 }))
            .unwrap()
            .kind
        {
            Some(wire::assist_response::Kind::Documents(listed)) => listed.documents,
            other => panic!("{other:?}"),
        };
        let doc = documents.first().expect("the sample holds a text document");
        send(
            &sample,
            session,
            2,
            vec![wire::AssistAttachment {
                kind: Some(wire::assist_attachment::Kind::VaultDoc(
                    wire::AssistVaultDoc {
                        doc_id: doc.doc_id.clone(),
                    },
                )),
                label: doc.title.clone(),
            }],
        );
        let attached = spy.take();
        assert!(!attached.is_empty(), "the attached reply generated");
        assert!(
            attached.iter().all(|used| *used == AdapterUse::Off),
            "a reply over an attachment runs with the adapter off: {attached:?}"
        );
    });
}
