//! The model's phases: absent, downloading, loading, ready, unavailable; and the photo reader.

mod chat_support;

use std::path::Path;
use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_assist::model::{Model, ModelError};
use centraid_assist::{ModelLoader, testing::ScriptedModel};
use chat_support::{Chat, read_tasks, script};
use wire::chat_event::Kind as C;
use wire::chat_state::Phase;

struct Loader(Arc<dyn Model>);

impl ModelLoader for Loader {
    fn load(&self, _: &Path) -> Result<Arc<dyn Model>, ModelError> {
        Ok(Arc::clone(&self.0))
    }
}

struct Refusing;

impl ModelLoader for Refusing {
    fn load(&self, _: &Path) -> Result<Arc<dyn Model>, ModelError> {
        Err(ModelError::Load("not a GGUF file".to_owned()))
    }
}

/// A chat whose models directory holds a model file (`bytes` long), and whose core has `loader`.
fn with_model_file(loader: Option<Arc<dyn ModelLoader>>) -> (Chat, std::path::PathBuf) {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("Qwen3.5-0.8B-Q4_0.gguf"), b"weights").unwrap();
    let chat = Chat::with(None);
    if let Some(loader) = loader {
        chat.driver.handle.assist().host().set_loader(loader);
    }
    (chat, dir)
}

fn open_in(chat: &mut Chat, dir: &Path) {
    chat.event(C::Opened(wire::chat_event::Opened {
        models_dir: dir.display().to_string(),
        vault_name: "Sample".to_owned(),
        ..wire::chat_event::Opened::default()
    }));
    chat.perform();
}

#[test]
fn a_fresh_chat_checks_and_draws_only_its_header() {
    let chat = Chat::with(None);
    let state = chat.state();
    assert_eq!(state.phase(), Phase::Checking);
    assert_eq!(state.title, "New chat");
    assert_eq!(state.subtitle, "On this phone");
    assert!(state.messages.is_empty() && state.empty_line.is_empty());
    assert!(state.model_step.is_none());
}

#[test]
fn no_model_draws_the_download_step_with_the_size_the_sentence_and_the_action() {
    let mut chat = Chat::with(None);
    chat.open("");
    let state = chat.state();
    assert_eq!(state.phase(), Phase::NeedsModel);
    let step = state.model_step.clone().expect("a step");
    assert_eq!(step.size_line, "563 MB download");
    assert_eq!(step.note_line, "This is the only time Centraid fetches anything.");
    assert_eq!(step.action_label, "Download model");
    assert!(state.messages.is_empty(), "a member never types into a chat with no model");
}

#[test]
fn a_file_this_build_has_no_engine_for_is_unavailable_and_not_a_download_problem() {
    let (mut chat, dir) = with_model_file(None);
    open_in(&mut chat, &dir);
    let state = chat.state();
    assert_eq!(state.phase(), Phase::Unavailable);
    assert_eq!(state.model_step.clone().unwrap().status_line, "Chat is not available here.");
    assert!(state.model_step.clone().unwrap().action_label.is_empty());
}

#[test]
fn a_model_on_the_phone_is_loaded_then_a_session_started_then_suggestions_asked_for() {
    let (mut chat, dir) = with_model_file(Some(Arc::new(Loader(script(&read_tasks())))));
    chat.event(C::Opened(wire::chat_event::Opened {
        models_dir: dir.display().to_string(),
        ..wire::chat_event::Opened::default()
    }));
    // The load blocks for seconds, so it is an effect the shell performs.
    assert_eq!(chat.state().phase(), Phase::Loading);
    assert_eq!(chat.state().model_step.clone().unwrap().status_line, "Loading model");
    assert_eq!(chat.driver.effects.len(), 1);
    chat.perform();
    let state = chat.state();
    assert_eq!(state.phase(), Phase::Ready);
    assert!(!state.suggestions.is_empty());
}

#[test]
fn a_model_that_will_not_load_is_a_model_to_fetch_again_with_one_line_saying_so() {
    let (mut chat, dir) = with_model_file(Some(Arc::new(Refusing)));
    open_in(&mut chat, &dir);
    let state = chat.state();
    assert_eq!(state.phase(), Phase::NeedsModel);
    assert_eq!(state.error, "The model would not load. Download it again.");
}

#[test]
fn the_download_step_tap_progress_then_a_load_and_a_failure_goes_back_with_one_line() {
    let mut chat = Chat::with(None);
    chat.open("");
    chat.event(C::Download(wire::chat_event::DownloadTapped { vision: false }));
    assert_eq!(chat.state().phase(), Phase::Downloading);
    let asked = chat.asked(|kind| match kind {
        wire::effect::Kind::ModelDownload(download) => Some(download.clone()),
        _ => None,
    });
    assert_eq!(asked.len(), 1);
    let download = &asked[0];
    assert!(!download.vision);
    assert_eq!(download.file_name, "Qwen3.5-0.8B-Q4_0.gguf");
    assert!(download.url.contains("/resolve/8fea620810c4afa23dd6443f999a48574c1611a3/"));
    assert_eq!(download.sha256.len(), 64);
    assert_eq!(download.models_dir, "/nowhere/models");
    // unknown progress, then a known one
    assert_eq!(chat.state().model_step.clone().unwrap().status_line, "Downloading");
    chat.event(C::DownloadProgress(wire::chat_event::DownloadProgress {
        done_bytes: 50,
        total_bytes: 100,
        vision: false,
    }));
    let step = chat.state().model_step.clone().unwrap();
    assert!(step.progress_known);
    assert!((step.progress - 0.5).abs() < f32::EPSILON);
    assert_eq!(step.status_line, "Downloading 50%");
    // it stopped short
    chat.event(C::DownloadFinished(wire::chat_event::DownloadFinished { ok: false, vision: false }));
    let state = chat.state();
    assert_eq!(state.phase(), Phase::NeedsModel);
    assert_eq!(state.error, "Download stopped. Retry.");
    // and again, to a load
    chat.event(C::Download(wire::chat_event::DownloadTapped { vision: false }));
    assert!(chat.state().error.is_empty());
    chat.event(C::DownloadFinished(wire::chat_event::DownloadFinished { ok: true, vision: false }));
    assert_eq!(chat.state().phase(), Phase::Loading);
}

#[test]
fn a_download_tap_outside_the_download_step_does_nothing_and_a_stale_status_cannot_undo_one() {
    let mut chat = Chat::ready(script(&read_tasks()));
    chat.driver.effects.clear();
    chat.event(C::Download(wire::chat_event::DownloadTapped { vision: false }));
    assert_eq!(chat.state().phase(), Phase::Ready);
    assert!(chat.driver.effects.is_empty());

    let mut chat = Chat::with(None);
    chat.open("");
    chat.event(C::Download(wire::chat_event::DownloadTapped { vision: false }));
    // the tab appears again while the transfer runs: the status read must not step back
    chat.open("");
    assert_eq!(chat.state().phase(), Phase::Downloading);
}

#[test]
fn a_download_still_running_from_an_earlier_launch_is_downloading_at_once() {
    let mut chat = Chat::with(None);
    chat.open("");
    assert_eq!(chat.state().phase(), Phase::NeedsModel, "the status read said no model");
    chat.event(C::DownloadProgress(wire::chat_event::DownloadProgress {
        done_bytes: 10,
        total_bytes: 100,
        vision: false,
    }));
    assert_eq!(chat.state().phase(), Phase::Downloading, "without waiting for a tap");
    assert!(chat.state().error.is_empty());
    // the status read that lands after it is ignored
    chat.open("");
    assert_eq!(chat.state().phase(), Phase::Downloading);
}

#[test]
fn health_and_locker_are_chat_scopes_like_every_other_app() {
    let mut chat = Chat::with(Some(script(&read_tasks())));
    chat.event(C::Opened(wire::chat_event::Opened { app: "locker".to_owned(), ..Default::default() }));
    // Locker is a scope (every app is), so the session opens.
    assert_eq!(chat.state().phase(), Phase::Ready);
    assert_eq!(chat.state().scope_app, "locker");
}

#[test]
fn the_scopes_are_the_assistants_apps_in_menu_order_and_an_id_that_is_no_app_scopes_to_every_app() {
    let scopes = centraid_screens::chat::scopable_apps();
    assert_eq!(
        scopes,
        ["agenda", "docs", "health", "locker", "money", "notes", "people", "photos"]
    );
    for app in &scopes {
        assert_eq!(centraid_screens::chat::scope_of(app), *app);
    }
    assert_eq!(centraid_screens::chat::scope_of("tasks"), "");
    assert_eq!(centraid_screens::chat::scope_of("chat"), "");
    assert_eq!(centraid_screens::chat::scope_of(""), "");
}

#[test]
fn the_tab_appearing_again_keeps_the_thread_whatever_scope_the_shell_says_and_a_scope_chosen_starts_over() {
    let mut chat = Chat::ready(script(&read_tasks()));
    chat.say("tasks?");
    chat.open("notes");
    assert_eq!(chat.state().messages.len(), 2, "the thread survives a switch of tab");
    assert_eq!(chat.state().scope_app, "");
    // a scope chosen from the composer's menu starts over
    chat.choose_scope("notes");
    let state = chat.state();
    assert_eq!(state.scope_app, "notes");
    assert!(state.messages.is_empty());
    // an untouched chat adopts the app it is opened from
    let mut fresh = Chat::ready(script(&read_tasks()));
    fresh.open("money");
    assert_eq!(fresh.state().scope_app, "money");
}

#[test]
fn a_chat_still_waiting_for_a_model_looks_again_when_the_tab_opens() {
    let (mut chat, dir) = with_model_file(Some(Arc::new(Loader(script(&read_tasks())))));
    chat.open("");
    assert_eq!(chat.state().phase(), Phase::NeedsModel, "the file is in a directory the shell did not name");
    open_in(&mut chat, &dir);
    assert_eq!(chat.state().phase(), Phase::Ready);
}

// ------------------------------------------------------------- the photo reader --

fn vault_photo(chat: &mut Chat) {
    chat.event(C::Attached(wire::chat_event::Attached {
        source: Some(wire::chat_event::attached::Source::VaultPhoto(wire::chat_event::VaultPhoto {
            asset_id: "asset-1".to_owned(),
        })),
        label: "Lake".to_owned(),
        thumbnail_path: String::new(),
    }));
}

#[test]
fn a_photo_with_no_reader_on_the_phone_is_the_offer_with_the_size_and_a_send_waits() {
    let mut chat = Chat::ready(script(&read_tasks()));
    vault_photo(&mut chat);
    let state = chat.state();
    assert_eq!(state.pending.len(), 1);
    assert_eq!(state.pending[0].label, "Lake");
    let step = state.vision_step.clone().expect("the reader's offer");
    assert_eq!(step.size_line, "Reading photos needs a 205 MB download");
    assert_eq!(step.action_label, "Download");
    assert!(state.vision_blocked);
    chat.say("what is this?");
    assert!(chat.state().messages.is_empty(), "the send waits for the reader");
}

#[test]
fn the_readers_download_runs_loads_and_unblocks_the_send() {
    let model = Arc::new(ScriptedModel::new(read_tasks().iter().flatten().cloned()).seeing());
    let (mut chat, dir) = {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Qwen3.5-0.8B-mmproj-F16.gguf"), b"projector").unwrap();
        (Chat::with(None), dir)
    };
    chat.driver.handle.assist().host().install(model.clone());
    chat.event(C::Opened(wire::chat_event::Opened {
        models_dir: dir.display().to_string(),
        ..Default::default()
    }));
    chat.perform();
    // the projector is on the phone and the loaded model carries it: nothing to fetch
    vault_photo(&mut chat);
    let state = chat.state();
    assert!(state.vision_step.is_none() && !state.vision_blocked);
    // the send is allowed; the asset is not a real photograph, so the core refuses the
    // attachment, and the refusal is its own line
    chat.say("what is this?");
    let state = chat.state();
    assert_eq!(state.messages.len(), 1, "the question stays, the empty answer goes");
    assert_eq!(state.error, "That attachment would not open.");
}

#[test]
fn removing_the_photo_takes_its_offer_away_and_a_document_needs_no_reader() {
    let mut chat = Chat::ready(script(&read_tasks()));
    vault_photo(&mut chat);
    assert!(chat.state().vision_step.is_some());
    let id = chat.state().pending[0].id;
    chat.event(C::AttachmentRemoved(wire::chat_event::AttachmentRemoved { id }));
    assert!(chat.state().vision_step.is_none() && chat.state().pending.is_empty());
    chat.event(C::Attached(wire::chat_event::Attached {
        source: Some(wire::chat_event::attached::Source::VaultDocument(wire::chat_event::VaultDocument {
            doc_id: "doc-1".to_owned(),
        })),
        label: "Notes.txt".to_owned(),
        thumbnail_path: String::new(),
    }));
    assert!(chat.state().vision_step.is_none() && !chat.state().vision_blocked);
}

#[test]
fn a_reader_download_that_stops_is_offered_again_with_one_line_and_its_events_never_move_the_models_phase() {
    let mut chat = Chat::ready(script(&read_tasks()));
    vault_photo(&mut chat);
    chat.event(C::Download(wire::chat_event::DownloadTapped { vision: true }));
    let asked = chat.asked(|kind| match kind {
        wire::effect::Kind::ModelDownload(download) if download.vision => Some(download.file_name.clone()),
        _ => None,
    });
    assert_eq!(asked, ["Qwen3.5-0.8B-mmproj-F16.gguf"]);
    chat.event(C::DownloadProgress(wire::chat_event::DownloadProgress {
        done_bytes: 1,
        total_bytes: 4,
        vision: true,
    }));
    assert_eq!(chat.state().phase(), Phase::Ready, "the reader is not the model's phase");
    assert_eq!(chat.state().vision_step.clone().unwrap().status_line, "Downloading 25%");
    chat.event(C::DownloadFinished(wire::chat_event::DownloadFinished { ok: false, vision: true }));
    let step = chat.state().vision_step.clone().unwrap();
    assert_eq!(step.status_line, "Download stopped. Retry.");
    assert_eq!(step.action_label, "Download");
}

#[test]
fn a_message_takes_one_photo_and_one_document_a_second_of_a_kind_replaces_the_first() {
    let mut chat = Chat::ready(script(&read_tasks()));
    vault_photo(&mut chat);
    chat.event(C::Attached(wire::chat_event::Attached {
        source: Some(wire::chat_event::attached::Source::VaultPhoto(wire::chat_event::VaultPhoto {
            asset_id: "asset-2".to_owned(),
        })),
        label: "River".to_owned(),
        thumbnail_path: String::new(),
    }));
    for doc in ["a", "b"] {
        chat.event(C::Attached(wire::chat_event::Attached {
            source: Some(wire::chat_event::attached::Source::VaultDocument(wire::chat_event::VaultDocument {
                doc_id: doc.to_owned(),
            })),
            label: format!("{doc}.txt"),
            thumbnail_path: String::new(),
        }));
    }
    let labels: Vec<String> = chat.state().pending.iter().map(|chip| chip.label.clone()).collect();
    assert_eq!(labels, ["River", "b.txt"]);
}

#[test]
fn attaching_waits_for_a_thread_and_not_while_a_turn_runs() {
    let mut chat = Chat::with(None);
    vault_photo(&mut chat);
    assert!(chat.state().pending.is_empty());
    let mut chat = Chat::ready(script(&read_tasks()));
    chat.event(C::Sent(wire::chat_event::Sent { text: "tasks?".to_owned() }));
    vault_photo(&mut chat);
    assert!(chat.state().pending.is_empty());
    chat.perform();
}
