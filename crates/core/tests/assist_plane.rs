//! THE CHAT'S DOOR, as a shell uses it: `Request::Assist` over a real handle.
//!
//! What a shell relies on and cannot check for itself: the model's three
//! states, the session rules, the event stream, stop reaching a generation that
//! is running, a vault that stays readable while the model thinks, and every
//! refusal arriving typed.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::sync::mpsc;

use centraid_assist::host::ModelLoader;
use centraid_assist::model::{Model, ModelError};
use centraid_assist::testing::{ScriptedModel, StallingModel};
use centraid_core::CoreError;
use centraid_core::api_proto as wire;
use wire::assist_request::Kind as Ask;

fn scratch_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "centraid-assist-plane-{}-{name}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("model.gguf");
    std::fs::write(&path, bytes).unwrap();
    path
}

struct Loader(Arc<dyn Model>);

impl ModelLoader for Loader {
    fn load(&self, _: &Path) -> Result<Arc<dyn Model>, ModelError> {
        Ok(Arc::clone(&self.0))
    }
}

fn status(sample: &common::chat::Sample, kind: Ask) -> wire::AssistStatus {
    match sample.assist(kind).expect("a status answers").kind {
        Some(wire::assist_response::Kind::Status(status)) => status,
        other => panic!("{other:?}"),
    }
}

fn refusal_of(sent: &wire::AssistSent) -> i32 {
    match sent.outcome.as_ref().expect("an outcome") {
        wire::assist_sent::Outcome::Refused(refusal) => refusal.reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn answered(sent: &wire::AssistSent) -> &wire::AssistAnswer {
    match sent.outcome.as_ref().expect("an outcome") {
        wire::assist_sent::Outcome::Answered(answer) => answer,
        other => panic!("expected an answer, got {other:?}"),
    }
}

#[test]
fn the_model_is_absent_then_without_an_engine_then_present_then_ready() {
    let sample = common::chat::sample();
    let path = std::env::temp_dir().join(format!(
        "centraid-assist-plane-{}-absent/model.gguf",
        std::process::id()
    ));
    let ask = |kind: fn(String) -> Ask, path: &Path| {
        status(&sample, kind(path.to_string_lossy().into_owned()))
    };
    let status_of = |path: String| {
        Ask::Status(wire::AssistStatusRequest {
            model_path: path,
            ..wire::AssistStatusRequest::default()
        })
    };
    let _ = ask;

    assert_eq!(
        status(&sample, status_of(path.to_string_lossy().into_owned())).state,
        wire::AssistModelState::Absent as i32
    );

    let file = scratch_file("states", b"model bytes");
    let here = file.to_string_lossy().into_owned();
    let no_engine = status(&sample, status_of(here.clone()));
    assert_eq!(
        (no_engine.state, no_engine.model_bytes),
        (wire::AssistModelState::NoEngine as i32, 11)
    );
    let refused = sample.assist(Ask::Load(wire::AssistLoadRequest {
        model_path: here.clone(),
        ..wire::AssistLoadRequest::default()
    }));
    assert!(
        matches!(refused, Err(CoreError::InvalidRequest { .. })),
        "no engine is the request's fault"
    );

    sample
        .handle
        .assist()
        .host()
        .set_loader(Arc::new(Loader(Arc::new(ScriptedModel::empty()))));
    assert_eq!(
        status(&sample, status_of(here.clone())).state,
        wire::AssistModelState::Present as i32
    );
    let loaded = status(
        &sample,
        Ask::Load(wire::AssistLoadRequest {
            model_path: here.clone(),
            ..wire::AssistLoadRequest::default()
        }),
    );
    assert_eq!(loaded.state, wire::AssistModelState::Ready as i32);
    assert_eq!(
        status(&sample, status_of(here)).state,
        wire::AssistModelState::Ready as i32
    );

    let unloaded = status(&sample, Ask::Unload(wire::AssistUnloadRequest {}));
    assert_ne!(unloaded.state, wire::AssistModelState::Ready as i32);
}

#[test]
fn a_chat_is_scoped_to_an_app_the_assistant_reads_and_never_to_locker() {
    let sample = common::chat::sample();
    let first = sample.start("");
    assert_eq!(sample.start("tally"), first + 1);
    for bad in ["locker", "nope", "TALLY"] {
        let refused = sample.assist(Ask::Start(wire::AssistStartRequest {
            app: bad.to_owned(),
            ..wire::AssistStartRequest::default()
        }));
        assert!(
            matches!(refused, Err(CoreError::InvalidRequest { .. })),
            "{bad}"
        );
    }
}

#[test]
fn a_send_with_no_model_is_a_typed_refusal_and_a_failed_event() {
    let sample = common::chat::sample();
    let session = sample.start("");
    sample.drain_assist_events();
    let sent = sample.send(session, 7, "What is due today?");
    assert_eq!(
        refusal_of(&sent),
        wire::AssistRefusalReason::ModelAbsent as i32
    );
    let events = sample.drain_assist_events();
    assert_eq!(events.len(), 1);
    assert_eq!((events[0].session_id, events[0].turn_id), (session, 7));
    assert!(matches!(
        events[0].kind,
        Some(wire::assist_event::Kind::Failed(_))
    ));
}

#[test]
fn an_unknown_chat_and_an_empty_message_are_the_requests_fault() {
    let sample = common::chat::sample();
    sample.install(Arc::new(ScriptedModel::empty()));
    let unknown = sample.assist(Ask::Send(wire::AssistSendRequest {
        session_id: 99,
        text: "hi".to_owned(),
        ..wire::AssistSendRequest::default()
    }));
    assert!(matches!(unknown, Err(CoreError::InvalidRequest { .. })));
    let session = sample.start("");
    let empty = sample.assist(Ask::Send(wire::AssistSendRequest {
        session_id: session,
        text: "   ".to_owned(),
        ..wire::AssistSendRequest::default()
    }));
    assert!(matches!(empty, Err(CoreError::InvalidRequest { .. })));
    let nothing_to_repeat = sample.assist(Ask::Send(wire::AssistSendRequest {
        session_id: session,
        regenerate: true,
        ..wire::AssistSendRequest::default()
    }));
    assert!(matches!(
        nothing_to_repeat,
        Err(CoreError::InvalidRequest { .. })
    ));
    assert!(matches!(
        sample.assist(Ask::Clear(wire::AssistClearRequest { session_id: 99 })),
        Err(CoreError::InvalidRequest { .. })
    ));
}

#[test]
fn regenerate_asks_the_last_question_again_without_the_turn_it_replaces() {
    let sample = common::chat::sample();
    let model = Arc::new(ScriptedModel::new([
        r#"{"tool":"tasks.list","args":{"view":"today"}}"#,
        "First wording.",
        r#"{"tool":"tasks.list","args":{"view":"today"}}"#,
        "Second wording.",
    ]));
    sample.install(Arc::clone(&model) as Arc<dyn Model>);
    let session = sample.start("");
    assert_eq!(
        answered(&sample.send(session, 1, "What is due today?")).text,
        "First wording."
    );
    let again = sample
        .assist(Ask::Send(wire::AssistSendRequest {
            session_id: session,
            tz: common::chat::TZ.to_owned(),
            regenerate: true,
            turn_id: 2,
            ..wire::AssistSendRequest::default()
        }))
        .unwrap();
    let Some(wire::assist_response::Kind::Sent(sent)) = again.kind else {
        panic!()
    };
    assert_eq!(answered(&sent).text, "Second wording.");
    let prompts = model.prompts();
    assert!(prompts[2].ends_with(&format!(
        "What is due today?<|im_end|>\n{}",
        centraid_assist::prompt::ASSISTANT_TURN
    )));
    assert!(
        !prompts[2].contains("First wording."),
        "the replaced turn is not in the retry's context"
    );
}

#[test]
fn a_new_chat_forgets_the_transcript_and_keeps_the_scope() {
    let sample = common::chat::sample();
    let model = Arc::new(ScriptedModel::new([
        r#"{"answer":"Hello."}"#,
        r#"{"answer":"Hello again."}"#,
    ]));
    sample.install(Arc::clone(&model) as Arc<dyn Model>);
    let session = sample.start("tally");
    sample.send(session, 1, "Hi there");
    sample
        .assist(Ask::Clear(wire::AssistClearRequest {
            session_id: session,
        }))
        .unwrap();
    sample.send(session, 2, "Hi again");
    let prompts = model.prompts();
    assert!(!prompts[1].contains("Hi there"));
    assert!(
        prompts[1].find("- tally.balances").unwrap()
            < prompts[1].find("- agenda.upcoming").unwrap()
    );
}

#[test]
fn locker_is_in_no_prompt_a_session_ever_builds() {
    let sample = common::chat::sample();
    let model = Arc::new(ScriptedModel::new([
        r#"{"answer":"No."}"#,
        r#"{"answer":"No."}"#,
    ]));
    sample.install(Arc::clone(&model) as Arc<dyn Model>);
    // Every scope a chat can have, asked a question a vault's secrets answer.
    for app in ["", "tasks"] {
        let session = sample.start(app);
        sample.send(session, 1, "What is my wifi password?");
    }
    let prompts = model.prompts();
    assert_eq!(prompts.len(), 2);
    assert!(
        prompts
            .iter()
            .all(|prompt| !prompt.to_lowercase().contains("locker")),
        "a secret that was never in a prompt cannot be in an answer"
    );
}

#[test]
fn a_failed_read_is_query_failed_and_leaves_the_chat_usable() {
    let sample = common::chat::sample();
    let model = Arc::new(ScriptedModel::new([
        r#"{"tool":"agenda.upcoming","args":{"range":"today"}}"#,
        r#"{"answer":"Still here."}"#,
    ]));
    sample.install(Arc::clone(&model) as Arc<dyn Model>);
    let session = sample.start("");
    sample.drain_assist_events();
    // A zone the bundled database does not know: the request's fault, which the
    // read reports and the turn turns into a refusal.
    let asked = sample
        .assist(Ask::Send(wire::AssistSendRequest {
            session_id: session,
            text: "What is on today?".to_owned(),
            tz: "Not/AZone".to_owned(),
            regenerate: false,
            turn_id: 1,
            ..wire::AssistSendRequest::default()
        }))
        .unwrap();
    let Some(wire::assist_response::Kind::Sent(sent)) = asked.kind else {
        panic!()
    };
    assert_eq!(
        refusal_of(&sent),
        wire::AssistRefusalReason::QueryFailed as i32
    );
    let events = sample.drain_assist_events();
    assert!(matches!(
        events.last().unwrap().kind,
        Some(wire::assist_event::Kind::Failed(_))
    ));
    assert_eq!(
        answered(&sample.send(session, 2, "hello")).text,
        "Still here."
    );
}

#[test]
fn stop_reaches_a_running_generation_and_the_vault_stays_readable_meanwhile() {
    let sample = common::chat::sample();
    let (started, wait) = mpsc::channel();
    sample.install(Arc::new(StallingModel::new(started)));
    let session = sample.start("");
    sample.drain_assist_events();
    std::thread::scope(|scope| {
        let turn = scope.spawn(|| sample.send(session, 1, "What is due today?"));
        wait.recv().expect("the generation started");

        // The model is mid-thought; the vault is not held.
        match sample
            .assist(Ask::Suggest(wire::AssistSuggestRequest {
                app: String::new(),
                tz: common::chat::TZ.to_owned(),
            }))
            .unwrap()
            .kind
        {
            Some(wire::assist_response::Kind::Suggestions(suggestions)) => {
                assert_eq!(suggestions.prompts.len(), 3)
            }
            other => panic!("{other:?}"),
        }
        // One turn at a time: a second send is BUSY, not queued, and not streamed.
        assert_eq!(
            refusal_of(&sample.send(session, 2, "and tomorrow?")),
            wire::AssistRefusalReason::Busy as i32
        );

        sample
            .assist(Ask::Cancel(wire::AssistCancelRequest {
                session_id: session,
            }))
            .unwrap();
        let stopped = turn.join().expect("the turn ends");
        assert_eq!(
            refusal_of(&stopped),
            wire::AssistRefusalReason::Cancelled as i32
        );
    });
    let events = sample.drain_assist_events();
    assert!(
        events.iter().all(|event| event.turn_id == 1),
        "the busy send streamed nothing"
    );
    assert!(matches!(
        events.last().unwrap().kind,
        Some(wire::assist_event::Kind::Failed(ref failed)) if failed.reason == wire::AssistRefusalReason::Cancelled as i32
    ));
    // A late cancel is a no-op, and the chat takes the next question.
    sample
        .assist(Ask::Cancel(wire::AssistCancelRequest {
            session_id: session,
        }))
        .unwrap();
    sample
        .assist(Ask::Cancel(wire::AssistCancelRequest { session_id: 999 }))
        .unwrap();
}

#[test]
fn a_new_chat_stops_a_running_turn_first() {
    let sample = common::chat::sample();
    let (started, wait) = mpsc::channel();
    sample.install(Arc::new(StallingModel::new(started)));
    let session = sample.start("");
    std::thread::scope(|scope| {
        let turn = scope.spawn(|| sample.send(session, 1, "What is due today?"));
        wait.recv().unwrap();
        sample
            .assist(Ask::Clear(wire::AssistClearRequest {
                session_id: session,
            }))
            .unwrap();
        assert_eq!(
            refusal_of(&turn.join().unwrap()),
            wire::AssistRefusalReason::Cancelled as i32
        );
    });
}

#[test]
fn suggestions_are_three_questions_this_vault_can_answer() {
    let sample = common::chat::sample();
    let reader = centraid_core::assist::VaultReader {
        handle: &sample.handle,
    };
    let context = centraid_assist::ReadContext {
        tz: common::chat::TZ,
    };
    for app in std::iter::once(None).chain(centraid_assist::App::ALL.into_iter().map(Some)) {
        let suggestions = centraid_assist::suggest::suggest(&reader, app, &context);
        assert!(!suggestions.is_empty(), "{app:?}");
        for suggestion in &suggestions {
            // Every suggestion names a call the vault answers with something to show.
            let output = centraid_assist::Reader::read(&reader, &suggestion.call, &context)
                .unwrap_or_else(|error| panic!("{}: {error}", suggestion.text));
            assert!(
                !output.rows.is_empty() || !output.facts.is_empty(),
                "{app:?}: {} finds nothing in the sample vault",
                suggestion.text
            );
        }
    }
    let unscoped = centraid_assist::suggest::suggest(&reader, None, &context);
    assert_eq!(unscoped.len(), 3);
    let apps: std::collections::BTreeSet<_> = unscoped.iter().map(|s| s.call.spec().app).collect();
    assert_eq!(
        apps.len(),
        3,
        "an unscoped chat opens on three different apps"
    );
    let tally =
        centraid_assist::suggest::suggest(&reader, Some(centraid_assist::App::Tally), &context);
    assert!(
        tally
            .iter()
            .all(|s| s.call.spec().app == centraid_assist::App::Tally)
    );
    assert_eq!(tally.len(), 3);
}

#[test]
fn suggestions_name_things_from_this_vault() {
    let sample = common::chat::sample();
    let prompts = |app: &str| match sample
        .assist(Ask::Suggest(wire::AssistSuggestRequest {
            app: app.to_owned(),
            tz: common::chat::TZ.to_owned(),
        }))
        .unwrap()
        .kind
    {
        Some(wire::assist_response::Kind::Suggestions(s)) => s.prompts,
        other => panic!("{other:?}"),
    };
    let tasks = prompts("tasks");
    assert!(tasks.iter().any(|p| p.contains("Tahoe trip")), "{tasks:?}");
    assert!(matches!(
        sample.assist(Ask::Suggest(wire::AssistSuggestRequest {
            app: "locker".to_owned(),
            tz: String::new()
        })),
        Err(CoreError::InvalidRequest { .. })
    ));
}

#[test]
fn a_closed_handle_refuses_with_a_typed_error() {
    let sample = common::chat::sample();
    sample.handle.close();
    assert!(matches!(
        sample.assist(Ask::Start(wire::AssistStartRequest::default())),
        Err(CoreError::Closed)
    ));
}
