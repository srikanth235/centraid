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
fn a_fresh_chat_checks_and_draws_its_header_and_what_it_is_looking_at() {
    let chat = Chat::with(None);
    let state = chat.state();
    assert_eq!(state.phase(), Phase::Checking);
    assert_eq!(state.title, "New chat");
    assert_eq!(state.subtitle, "On this phone");
    assert!(state.messages.is_empty() && state.empty_line.is_empty());
    // the blank page of a check says what it looks at (#1188 C12)
    let step = state.model_step.clone().expect("a step");
    assert_eq!(step.title, "Checking this phone");
    assert_eq!(
        step.note_line,
        "Looking at memory and free space for the model."
    );
}

#[test]
fn no_model_draws_the_download_step_with_the_size_the_sentence_and_the_action() {
    let mut chat = Chat::with(None);
    chat.open("");
    let state = chat.state();
    assert_eq!(state.phase(), Phase::NeedsModel);
    let step = state.model_step.clone().expect("a step");
    assert_eq!(step.size_line, "563 MB download");
    assert_eq!(
        step.note_line,
        "It stays on this phone, and nothing you ask leaves it."
    );
    assert_eq!(
        step.extra_line,
        "Photos need another 205 MB download, asked when you attach one."
    );
    assert_eq!(step.action_label, "Download on Wi‑Fi");
    assert_eq!(step.secondary_label, "Use mobile data instead");
    assert!(
        state.messages.is_empty(),
        "a member never types into a chat with no model"
    );
}

#[test]
fn a_file_this_build_has_no_engine_for_is_unavailable_and_not_a_download_problem() {
    let (mut chat, dir) = with_model_file(None);
    open_in(&mut chat, &dir);
    let state = chat.state();
    assert_eq!(state.phase(), Phase::Unavailable);
    assert_eq!(
        state.model_step.clone().unwrap().status_line,
        "Chat is not available here."
    );
    assert!(state.model_step.clone().unwrap().action_label.is_empty());
}

#[test]
fn a_model_on_the_phone_is_loaded_then_a_session_started_then_suggestions_asked_for() {
    let (mut chat, dir) = with_model_file(Some(Arc::new(Loader(script(&read_tasks())))));
    chat.event(C::Opened(wire::chat_event::Opened {
        models_dir: dir.display().to_string(),
        ..wire::chat_event::Opened::default()
    }));
    // The load blocks for seconds, so it runs on the core's pool and the chat shows the wait.
    assert_eq!(chat.state().phase(), Phase::Loading);
    assert_eq!(
        chat.state().model_step.clone().unwrap().status_line,
        "Loading model"
    );
    assert!(
        chat.driver.effects.is_empty(),
        "the shell carries none of it"
    );
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
    chat.event(C::Download(wire::chat_event::DownloadTapped {
        vision: false,
        ..Default::default()
    }));
    assert_eq!(chat.state().phase(), Phase::Downloading);
    let asked = chat.asked(|kind| match kind {
        wire::effect::Kind::ModelDownload(download) => Some(download.clone()),
        _ => None,
    });
    assert_eq!(asked.len(), 1);
    let download = &asked[0];
    assert!(!download.vision);
    assert_eq!(download.file_name, "Qwen3.5-0.8B-Q4_0.gguf");
    assert!(
        download
            .url
            .contains("/resolve/8fea620810c4afa23dd6443f999a48574c1611a3/")
    );
    assert_eq!(download.models_dir, "/nowhere/models");
    // unknown progress, then a known one
    assert_eq!(
        chat.state().model_step.clone().unwrap().status_line,
        "Downloading"
    );
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
    chat.event(C::DownloadFinished(wire::chat_event::DownloadFinished {
        ok: false,
        vision: false,
    }));
    let state = chat.state();
    assert_eq!(state.phase(), Phase::NeedsModel);
    assert_eq!(state.error, "Download stopped. Try again.");
    // and again, to a load
    chat.event(C::Download(wire::chat_event::DownloadTapped {
        vision: false,
        ..Default::default()
    }));
    assert!(chat.state().error.is_empty());
    chat.event(C::DownloadFinished(wire::chat_event::DownloadFinished {
        ok: true,
        vision: false,
    }));
    assert_eq!(chat.state().phase(), Phase::Loading);
}

#[test]
fn a_download_tap_outside_the_download_step_does_nothing_and_a_stale_status_cannot_undo_one() {
    let mut chat = Chat::ready(script(&read_tasks()));
    chat.driver.effects.clear();
    chat.event(C::Download(wire::chat_event::DownloadTapped {
        vision: false,
        ..Default::default()
    }));
    assert_eq!(chat.state().phase(), Phase::Ready);
    assert!(chat.driver.effects.is_empty());

    let mut chat = Chat::with(None);
    chat.open("");
    chat.event(C::Download(wire::chat_event::DownloadTapped {
        vision: false,
        ..Default::default()
    }));
    // the tab appears again while the transfer runs: the status read must not step back
    chat.open("");
    assert_eq!(chat.state().phase(), Phase::Downloading);
}

#[test]
fn a_download_still_running_from_an_earlier_launch_is_downloading_at_once() {
    let mut chat = Chat::with(None);
    chat.open("");
    assert_eq!(
        chat.state().phase(),
        Phase::NeedsModel,
        "the status read said no model"
    );
    chat.event(C::DownloadProgress(wire::chat_event::DownloadProgress {
        done_bytes: 10,
        total_bytes: 100,
        vision: false,
    }));
    assert_eq!(
        chat.state().phase(),
        Phase::Downloading,
        "without waiting for a tap"
    );
    assert!(chat.state().error.is_empty());
    // the status read that lands after it is ignored
    chat.open("");
    assert_eq!(chat.state().phase(), Phase::Downloading);
}

#[test]
fn health_and_locker_are_chat_scopes_like_every_other_app() {
    let mut chat = Chat::with(Some(script(&read_tasks())));
    chat.event(C::Opened(wire::chat_event::Opened {
        app: "locker".to_owned(),
        ..Default::default()
    }));
    // Locker is a scope (every app is), so the session opens.
    assert_eq!(chat.state().phase(), Phase::Ready);
    assert_eq!(chat.state().scope_app, "locker");
}

#[test]
fn the_scopes_are_the_assistants_apps_in_menu_order_and_an_id_that_is_no_app_scopes_to_every_app() {
    let scopes = centraid_screens::chat::scopable_apps();
    assert_eq!(
        scopes,
        [
            "calendar",
            "docs",
            "health",
            "locker",
            "money",
            "notes",
            "people",
            "photos",
            "reminders"
        ]
    );
    for app in &scopes {
        assert_eq!(centraid_screens::chat::scope_of(app), *app);
    }
    assert_eq!(centraid_screens::chat::scope_of("tasks"), "");
    assert_eq!(centraid_screens::chat::scope_of("chat"), "");
    assert_eq!(centraid_screens::chat::scope_of(""), "");
}

#[test]
fn the_tab_appearing_again_keeps_the_thread_whatever_scope_the_shell_says_and_a_scope_chosen_starts_over()
 {
    let mut chat = Chat::ready(script(&read_tasks()));
    chat.say("tasks?");
    chat.open("notes");
    assert_eq!(
        chat.state().messages.len(),
        2,
        "the thread survives a switch of tab"
    );
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
    assert_eq!(
        chat.state().phase(),
        Phase::NeedsModel,
        "the file is in a directory the shell did not name"
    );
    open_in(&mut chat, &dir);
    assert_eq!(chat.state().phase(), Phase::Ready);
}

// ------------------------------------------------------------- the photo reader --

fn vault_photo(chat: &mut Chat) {
    chat.event(C::Attached(wire::chat_event::Attached {
        source: Some(wire::chat_event::attached::Source::VaultPhoto(
            wire::chat_event::VaultPhoto {
                asset_id: "asset-1".to_owned(),
            },
        )),
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
    assert_eq!(step.action_label, "Download on Wi‑Fi");
    assert_eq!(step.secondary_label, "Use mobile data instead");
    assert_eq!(step.tertiary_label, "Not now");
    assert!(state.vision_blocked);
    chat.say("what is this?");
    assert!(
        chat.state().messages.is_empty(),
        "the send waits for the reader"
    );
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
    assert_eq!(
        state.messages.len(),
        1,
        "the question stays, the empty answer goes"
    );
    assert_eq!(state.error, "That attachment would not open.");
}

#[test]
fn removing_the_photo_takes_its_offer_away_and_a_document_needs_no_reader() {
    let mut chat = Chat::ready(script(&read_tasks()));
    vault_photo(&mut chat);
    assert!(chat.state().vision_step.is_some());
    let id = chat.state().pending[0].id;
    chat.event(C::AttachmentRemoved(wire::chat_event::AttachmentRemoved {
        id,
    }));
    assert!(chat.state().vision_step.is_none() && chat.state().pending.is_empty());
    chat.event(C::Attached(wire::chat_event::Attached {
        source: Some(wire::chat_event::attached::Source::VaultDocument(
            wire::chat_event::VaultDocument {
                doc_id: "doc-1".to_owned(),
            },
        )),
        label: "Notes.txt".to_owned(),
        thumbnail_path: String::new(),
    }));
    assert!(chat.state().vision_step.is_none() && !chat.state().vision_blocked);
}

#[test]
fn a_reader_download_that_stops_is_offered_again_with_one_line_and_its_events_never_move_the_models_phase()
 {
    let mut chat = Chat::ready(script(&read_tasks()));
    vault_photo(&mut chat);
    chat.event(C::Download(wire::chat_event::DownloadTapped {
        vision: true,
        ..Default::default()
    }));
    let asked = chat.asked(|kind| match kind {
        wire::effect::Kind::ModelDownload(download) if download.vision => {
            Some(download.file_name.clone())
        }
        _ => None,
    });
    assert_eq!(asked, ["Qwen3.5-0.8B-mmproj-F16.gguf"]);
    chat.event(C::DownloadProgress(wire::chat_event::DownloadProgress {
        done_bytes: 1,
        total_bytes: 4,
        vision: true,
    }));
    assert_eq!(
        chat.state().phase(),
        Phase::Ready,
        "the reader is not the model's phase"
    );
    assert_eq!(
        chat.state().vision_step.clone().unwrap().status_line,
        "Downloading 25%"
    );
    chat.event(C::DownloadFinished(wire::chat_event::DownloadFinished {
        ok: false,
        vision: true,
    }));
    let step = chat.state().vision_step.clone().unwrap();
    assert_eq!(step.status_line, "Download stopped. Try again.");
    assert_eq!(step.action_label, "Download on Wi‑Fi");
}

fn vision_download(chat: &mut Chat, choice: wire::ChatStepAction) -> Option<wire::ModelDownload> {
    chat.driver.effects.clear();
    chat.event(C::Download(wire::chat_event::DownloadTapped {
        vision: true,
        choice: choice as i32,
        ..Default::default()
    }));
    download_effect(chat)
}

#[test]
fn a_tap_on_the_photo_offer_is_not_consent_to_mobile_data_the_explicit_choice_is() {
    use wire::chat_event::device_facts::Network;
    let mut chat = Chat::ready(script(&read_tasks()));
    facts(&mut chat, Network::Cellular, 2_000_000_000);
    vault_photo(&mut chat);
    let download = vision_download(&mut chat, wire::ChatStepAction::Unspecified)
        .expect("the primary button starts the fetch");
    assert!(
        !download.allow_cellular,
        "a default tap never uses mobile data"
    );
    let step = chat.state().vision_step.clone().unwrap();
    assert_eq!(step.secondary_label, "Use mobile data for the rest");
    let download = vision_download(&mut chat, wire::ChatStepAction::DownloadCellular)
        .expect("the explicit choice");
    assert!(download.allow_cellular);
}

#[test]
fn not_now_on_the_photo_sheet_drops_the_photo_and_the_offer() {
    let mut chat = Chat::ready(script(&read_tasks()));
    vault_photo(&mut chat);
    assert!(chat.state().vision_step.is_some());
    assert!(vision_download(&mut chat, wire::ChatStepAction::NotNow).is_none());
    let state = chat.state();
    assert!(state.pending.is_empty());
    assert!(state.vision_step.is_none() && !state.vision_blocked);
}

#[test]
fn a_message_takes_one_photo_and_one_document_a_second_of_a_kind_replaces_the_first() {
    let mut chat = Chat::ready(script(&read_tasks()));
    vault_photo(&mut chat);
    chat.event(C::Attached(wire::chat_event::Attached {
        source: Some(wire::chat_event::attached::Source::VaultPhoto(
            wire::chat_event::VaultPhoto {
                asset_id: "asset-2".to_owned(),
            },
        )),
        label: "River".to_owned(),
        thumbnail_path: String::new(),
    }));
    for doc in ["a", "b"] {
        chat.event(C::Attached(wire::chat_event::Attached {
            source: Some(wire::chat_event::attached::Source::VaultDocument(
                wire::chat_event::VaultDocument {
                    doc_id: doc.to_owned(),
                },
            )),
            label: format!("{doc}.txt"),
            thumbnail_path: String::new(),
        }));
    }
    let labels: Vec<String> = chat
        .state()
        .pending
        .iter()
        .map(|chip| chip.label.clone())
        .collect();
    assert_eq!(labels, ["River", "b.txt"]);
}

#[test]
fn attaching_waits_for_a_thread_and_not_while_a_turn_runs() {
    let mut chat = Chat::with(None);
    vault_photo(&mut chat);
    assert!(chat.state().pending.is_empty());
    let mut chat = Chat::ready(script(&read_tasks()));
    chat.event(C::Sent(wire::chat_event::Sent {
        text: "tasks?".to_owned(),
        ..Default::default()
    }));
    vault_photo(&mut chat);
    assert!(chat.state().pending.is_empty());
    chat.perform();
}

// ONE APP IS ONE WORD (#1128): the roster lists the apps a card may name and each is a scope. The
// roster's other half, that the vault's DDL holds no app word, is pinned in crates/vault.

#[test]
fn the_scopes_are_the_vaults_roster() {
    let roster: Vec<&str> = centraid_vault::roster::APPS
        .iter()
        .map(|app| app.id)
        .collect();
    assert_eq!(roster, centraid_screens::chat::scopable_apps());
    assert!(
        roster
            .iter()
            .all(|app| centraid_screens::chat::scope_of(app) == *app)
    );
}

fn facts(chat: &mut Chat, network: wire::chat_event::device_facts::Network, free_bytes: u64) {
    chat.event(C::DeviceFacts(wire::chat_event::DeviceFacts {
        network: network as i32,
        free_bytes,
        ..Default::default()
    }));
}

fn download_effect(chat: &Chat) -> Option<wire::ModelDownload> {
    chat.asked(|kind| match kind {
        wire::effect::Kind::ModelDownload(download) => Some(download.clone()),
        _ => None,
    })
    .pop()
}

#[test]
fn a_phone_with_too_little_space_is_told_so_and_nothing_is_fetched_until_it_has_it() {
    use wire::chat_event::device_facts::Network;
    let mut chat = Chat::with(None);
    chat.open("");
    facts(&mut chat, Network::Wifi, 310_000_000);
    let step = chat.state().model_step.clone().expect("a step");
    assert_eq!(step.title, "Not enough space");
    assert_eq!(
        step.note_line,
        "The model needs 563 MB and this phone has 310 MB free. Free up 253 MB, then check again."
    );
    assert_eq!(step.action_label, "Check again");
    assert_eq!(step.action_kind, wire::ChatStepAction::CheckAgain as i32);
    chat.driver.effects.clear();
    chat.event(C::Download(wire::chat_event::DownloadTapped::default()));
    assert!(download_effect(&chat).is_none());
    assert_eq!(chat.state().phase(), Phase::NeedsModel);
    // space was made: the same chat offers the download
    facts(&mut chat, Network::Wifi, 2_000_000_000);
    assert_eq!(
        chat.state().model_step.clone().unwrap().action_kind,
        wire::ChatStepAction::Download as i32
    );
}

#[test]
fn on_mobile_data_the_chat_asks_first_and_waiting_for_wifi_is_a_download_that_will_not_use_it() {
    use wire::chat_event::device_facts::Network;
    let mut chat = Chat::with(None);
    chat.open("");
    facts(&mut chat, Network::Cellular, 2_000_000_000);
    let step = chat.state().model_step.clone().expect("a step");
    assert_eq!(step.title, "Use mobile data?");
    assert_eq!(
        (step.action_label.as_str(), step.secondary_label.as_str()),
        ("Download now", "Wait for Wi‑Fi")
    );
    // Wait for Wi-Fi: the download starts and the shell is told not to use mobile data
    chat.driver.effects.clear();
    chat.event(C::Download(wire::chat_event::DownloadTapped {
        vision: false,
        choice: wire::ChatStepAction::WaitWifi as i32,
        ..Default::default()
    }));
    assert!(!download_effect(&chat).expect("a download").allow_cellular);
    let step = chat.state().model_step.clone().expect("a step");
    assert_eq!(step.title, "Waiting for Wi‑Fi");
    assert_eq!(step.secondary_label, "Use mobile data for the rest");
    // …and the rest over mobile data takes the same file up again, allowed
    chat.driver.effects.clear();
    chat.event(C::Download(wire::chat_event::DownloadTapped {
        vision: false,
        choice: wire::ChatStepAction::DownloadCellular as i32,
        ..Default::default()
    }));
    assert!(download_effect(&chat).expect("a download").allow_cellular);
    assert_eq!(chat.state().model_step.clone().unwrap().title, "");
}

#[test]
fn wifi_is_the_default_the_download_carries_no_permission_for_mobile_data() {
    use wire::chat_event::device_facts::Network;
    let mut chat = Chat::with(None);
    chat.open("");
    facts(&mut chat, Network::Wifi, 2_000_000_000);
    chat.driver.effects.clear();
    chat.event(C::Download(wire::chat_event::DownloadTapped::default()));
    assert!(!download_effect(&chat).expect("a download").allow_cellular);
}

#[test]
fn a_phone_with_too_little_memory_is_told_why_and_is_offered_no_download() {
    use wire::chat_event::device_facts::Network;
    let mut chat = Chat::with(None);
    chat.open("");
    chat.event(C::DeviceFacts(wire::chat_event::DeviceFacts {
        network: Network::Wifi as i32,
        free_bytes: 2_000_000_000,
        memory_bytes: 3_000_000_000,
    }));
    let step = chat.state().model_step.clone().expect("a step");
    assert_eq!(step.title, "Chat can’t run on this phone");
    assert_eq!(
        step.note_line,
        "It needs 4 GB of memory and this phone has 3.0 GB."
    );
    assert!(step.action_label.is_empty());
    chat.driver.effects.clear();
    chat.event(C::Download(wire::chat_event::DownloadTapped::default()));
    assert!(
        download_effect(&chat).is_none(),
        "nothing is fetched for a phone that cannot run it"
    );
}

// ------------------------------------------------------ the two-model window --

fn window_record() -> centraid_assist::record::Record {
    let current = centraid_assist::record::record().current;
    let entry = |file: &str, sha: &str, bytes: u64| centraid_assist::record::Entry {
        url: format!(
            "https://huggingface.co/x/y/resolve/{}/{file}",
            "a".repeat(40)
        ),
        file_name: file.to_owned(),
        sha256: sha.repeat(64),
        bytes,
        ..current.clone()
    };
    centraid_assist::record::Record {
        adapter: None,
        current: entry("New-Q4_0.gguf", "b", 604_000_000),
        previous: Some(entry("Old-Q4_0.gguf", "c", 563_000_000)),
    }
}

/// A chat whose models directory holds exactly `files`, over a loader that accepts any of them.
fn with_files(files: &[&str]) -> (Chat, std::path::PathBuf) {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).unwrap();
    for file in files {
        std::fs::write(dir.join(file), b"weights").unwrap();
    }
    let chat = Chat::with(None);
    chat.driver
        .handle
        .assist()
        .host()
        .set_loader(Arc::new(Loader(script(&read_tasks()))));
    (chat, dir)
}

fn deleted(chat: &Chat) -> Vec<String> {
    chat.asked(|kind| match kind {
        wire::effect::Kind::DeleteModelFile(gone) => Some(gone.file_name.clone()),
        _ => None,
    })
}

#[test]
fn the_model_before_the_current_one_keeps_working_and_a_row_offers_the_new_one_with_its_size() {
    centraid_assist::record::held_for(window_record(), || {
        let (mut chat, dir) = with_files(&["Old-Q4_0.gguf"]);
        open_in(&mut chat, &dir);
        let state = chat.state();
        assert_eq!(
            state.phase(),
            Phase::Ready,
            "the older model is in the window"
        );
        let row = state.update_step.clone().expect("the update row");
        assert_eq!(row.title, "A newer model is ready");
        assert_eq!(row.size_line, "604 MB");
        assert_eq!(row.action_label, "Update");
        assert!(
            deleted(&chat).is_empty(),
            "nothing goes before the new one is in use"
        );
    });
}

#[test]
fn the_update_is_fetched_beside_the_old_file_swapped_in_and_the_old_file_deleted() {
    centraid_assist::record::held_for(window_record(), || {
        let (mut chat, dir) = with_files(&["Old-Q4_0.gguf"]);
        open_in(&mut chat, &dir);
        chat.driver.effects.clear();
        chat.event(C::Download(wire::chat_event::DownloadTapped {
            update: true,
            ..Default::default()
        }));
        let fetch = download_effect(&chat).expect("the fetch of the new file");
        assert_eq!(fetch.file_name, "New-Q4_0.gguf");
        assert!(!fetch.allow_cellular, "the update waits for Wi‑Fi");
        assert_eq!(
            chat.state().phase(),
            Phase::Ready,
            "the old model keeps answering"
        );
        chat.event(C::DownloadProgress(wire::chat_event::DownloadProgress {
            done_bytes: 151,
            total_bytes: 604,
            vision: false,
        }));
        assert!(chat.state().update_step.clone().unwrap().progress_known);
        // the shell verified the file and put it beside the old one
        std::fs::write(dir.join("New-Q4_0.gguf"), b"weights").unwrap();
        chat.event(C::DownloadFinished(wire::chat_event::DownloadFinished {
            ok: true,
            vision: false,
        }));
        chat.perform();
        let state = chat.state();
        assert_eq!(state.phase(), Phase::Ready);
        assert!(state.update_step.is_none());
        assert_eq!(deleted(&chat), vec!["Old-Q4_0.gguf".to_owned()]);
    });
}

#[test]
fn a_model_older_than_the_window_says_an_update_is_needed_and_is_removed_after_the_new_one_arrives()
{
    centraid_assist::record::held_for(window_record(), || {
        let (mut chat, dir) = with_files(&["Ancient-Q4_0.gguf"]);
        open_in(&mut chat, &dir);
        let state = chat.state();
        assert_eq!(state.phase(), Phase::NeedsModel);
        let step = state.model_step.clone().expect("the step");
        assert_eq!(step.title, "Chat needs a newer model");
        assert!(step.note_line.contains("604 MB"), "{}", step.note_line);
        assert_eq!(step.action_label, "Download on Wi‑Fi");
        chat.event(C::Download(wire::chat_event::DownloadTapped::default()));
        std::fs::write(dir.join("New-Q4_0.gguf"), b"weights").unwrap();
        chat.event(C::DownloadFinished(wire::chat_event::DownloadFinished {
            ok: true,
            vision: false,
        }));
        chat.perform();
        assert_eq!(chat.state().phase(), Phase::Ready);
        assert_eq!(deleted(&chat), vec!["Ancient-Q4_0.gguf".to_owned()]);
    });
}

#[test]
fn a_phone_on_the_current_model_has_no_update_row_and_deletes_nothing() {
    centraid_assist::record::held_for(window_record(), || {
        let (mut chat, dir) = with_files(&["New-Q4_0.gguf"]);
        open_in(&mut chat, &dir);
        assert_eq!(chat.state().phase(), Phase::Ready);
        assert!(chat.state().update_step.is_none());
        assert!(deleted(&chat).is_empty());
    });
}
