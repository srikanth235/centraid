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
    let steps = common::chat::read_tasks();
    let model = common::chat::script(&[
        steps[0].clone(),
        steps[1].clone(),
        steps[0].clone(),
        steps[1].clone(),
    ]);
    sample.install(Arc::clone(&model) as Arc<dyn Model>);
    let session = sample.start("");
    assert_eq!(
        answered(&sample.send(session, 1, "What is due today?")).text,
        common::chat::FOUND_TASKS
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
    assert_eq!(answered(&sent).text, common::chat::FOUND_TASKS);
    // Two generations a step: the retry's first is the fifth prompt, and it is a conversation of
    // one question, asked afresh.
    let prompts = model.prompts();
    assert_eq!(prompts.len(), 8);
    assert!(prompts[4].ends_with(&format!(
        "What is due today?<|im_end|>\n{}",
        "<|im_start|>assistant\n<think>\n"
    )));
    assert!(
        !prompts[4].contains("plan: look") && !prompts[4].contains("<tool_response>"),
        "the replaced turn is not in the retry's context"
    );
    assert_eq!(prompts[4].matches("What is due today?").count(), 1);
}

#[test]
fn a_new_chat_forgets_the_transcript_and_keeps_the_scope() {
    let sample = common::chat::sample();
    let model = common::chat::script(&[
        common::chat::decline("sealed_egress"),
        common::chat::decline("sealed_egress"),
    ]);
    sample.install(Arc::clone(&model) as Arc<dyn Model>);
    let session = sample.start("tally");
    sample.send(session, 1, "Hi there");
    sample
        .assist(Ask::Clear(wire::AssistClearRequest {
            session_id: session,
        }))
        .unwrap();
    let second = sample.send(session, 2, "Hi again");
    let prompts = model.prompts();
    assert!(prompts[0].contains("Hi there"));
    assert!(
        prompts[2..]
            .iter()
            .all(|prompt| !prompt.contains("Hi there")),
        "the new chat is a fresh conversation"
    );
    // The scope is the chat's own and outlives a new chat: the new thread is Tally's too.
    let listed = match sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                query: Some(wire::app_query_request::Query::ChatThreads(
                    wire::ChatThreadsRequest::default(),
                )),
            })),
        })
        .unwrap()
        .kind
    {
        Some(wire::response::Kind::AppQuery(answer)) => match answer.answer {
            Some(wire::app_query_response::Answer::ChatThreads(listed)) => listed.threads,
            other => panic!("{other:?}"),
        },
        other => panic!("{other:?}"),
    };
    let row = listed
        .iter()
        .find(|row| row.thread_id == second.thread_id)
        .expect("the new chat is listed");
    assert_eq!(row.scope_app, "tally");
}

#[test]
fn locker_is_in_no_prompt_a_session_ever_builds() {
    let sample = common::chat::sample();
    let model = common::chat::script(&[
        common::chat::decline("sealed_egress"),
        common::chat::decline("sealed_egress"),
    ]);
    sample.install(Arc::clone(&model) as Arc<dyn Model>);
    // Every scope a chat can have, asked a question a vault's secrets answer.
    for app in ["", "tasks"] {
        let session = sample.start(app);
        sample.send(session, 1, "What is my wifi password?");
    }
    let prompts = model.prompts();
    assert_eq!(prompts.len(), 4);
    // The kind card still names the kind the model was trained with (R-1088-10), but the world
    // the phone loads holds no Locker row (R-1088-3): no item is listed in any prompt.
    assert!(
        prompts
            .iter()
            .all(|prompt| !prompt.contains("locker items:")),
        "a secret that was never in a prompt cannot be in an answer"
    );
}

#[test]
fn a_zone_the_database_does_not_know_does_not_fail_the_turn() {
    let sample = common::chat::sample();
    let model = common::chat::script(&[
        common::chat::decline("sealed_egress"),
        common::chat::decline("sealed_egress"),
    ]);
    sample.install(Arc::clone(&model) as Arc<dyn Model>);
    let session = sample.start("");
    sample.drain_assist_events();
    // The member's days are read in UTC when their zone is not one the bundled database knows,
    // and the events are read as stored: the question is still answered.
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
    answered(&sent);
    // and the chat takes the next question
    answered(&sample.send(session, 2, "hello"));
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
    use centraid_assist::App;
    use centraid_assist::suggest::{SUGGESTIONS, suggest};
    let sample = common::chat::sample();
    let door = sample.handle.assist_door();
    for scope in std::iter::once(None).chain(App::ALL.into_iter().map(Some)) {
        let got = suggest(&door, common::chat::TZ, scope);
        assert_eq!(got.len(), SUGGESTIONS, "{scope:?}");
        // Deterministic: the same vault, the same three, in the same order.
        assert_eq!(got, suggest(&door, common::chat::TZ, scope), "{scope:?}");
        // Opened from an app, all three are about it.
        if let Some(app) = scope {
            assert!(got.iter().all(|s| s.app == app), "{app:?}: {got:?}");
        }
        let texts: std::collections::BTreeSet<_> = got.iter().map(|s| &s.text).collect();
        assert_eq!(texts.len(), SUGGESTIONS, "{scope:?}: no repeats");
    }
    let unscoped = suggest(&door, common::chat::TZ, None);
    let apps: std::collections::BTreeSet<_> = unscoped.iter().map(|s| s.app).collect();
    assert_eq!(
        apps.len(),
        3,
        "an unscoped chat opens on three different apps"
    );
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
