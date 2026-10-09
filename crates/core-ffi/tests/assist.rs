//! THE CHAT CROSSES THE FIVE SYMBOLS.
//!
//! `Request::Assist` is a request kind and `AssistEvent` an event kind, so the
//! ABI gained no symbol for the on-device chat — `abi-five-symbols` still
//! counts five. This is the proof that the bytes make the trip: a session is
//! started and a message sent through `centraid_call`, and the turn's events
//! come back through `centraid_next_event` as encoded envelopes, in order.

use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_assist::testing::ScriptedModel;
use centraid_core_ffi::{
    CENTRAID_OK, CENTRAID_TIMEOUT, centraid_call, centraid_close, centraid_free,
    centraid_next_event, centraid_open,
};
use prost::Message as _;

struct Opened {
    dir: std::path::PathBuf,
    handle: *mut centraid_core::Handle,
}

// SAFETY: the pointer is a live `Handle`, which is `Sync` (calls are reentrant
// across threads by the ABI's own contract), and `dir` is read-only.
unsafe impl Sync for Opened {}

impl Opened {
    /// A sample vault with a model slot of its own, for the tests that install
    /// fakes.
    fn sample() -> Self {
        Self::open(true)
    }

    /// A sample vault whose chat takes attachments, for the tests of the path that is off in the
    /// shipped build (R-1088-19).
    fn offering_attachments() -> Self {
        let opened = Self::sample();
        opened.core().assist().offer_attachments(true);
        opened
    }

    /// A sample vault exactly as `centraid_open` leaves it: the process-wide
    /// model slot, with the real engine's loader in it under `llama` and with
    /// no loader at all without it.
    fn as_opened() -> Self {
        Self::open(false)
    }

    fn open(private_slot: bool) -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let config = format!(
            r#"{{"path":{:?},"create":true}}"#,
            dir.join("vault.db").display().to_string()
        );
        let mut handle: *mut centraid_core::Handle = std::ptr::null_mut();
        // SAFETY: `config` lives for the call and `handle` is a live local.
        let code = unsafe { centraid_open(config.as_ptr(), config.len(), &raw mut handle) };
        assert_eq!(code, CENTRAID_OK);
        let opened = Self { dir, handle };
        if private_slot {
            // `centraid_open` hands every handle the process-wide slot, and the
            // tests that install fakes must not install them into it.
            opened
                .core()
                .assist()
                .use_host(Arc::new(centraid_assist::ModelHost::new()));
        }
        let found = opened.call(wire::request::Kind::Found(wire::FoundRequest {
            display_name: "Sample".to_owned(),
            owner_name: "Me".to_owned(),
            content: wire::FoundContent::Sample as i32,
        }));
        assert!(matches!(found.kind, Some(wire::response::Kind::Found(_))));
        opened
    }

    fn core(&self) -> &centraid_core::Handle {
        // SAFETY: the handle is live until `drop`, and `Handle` is `Sync`.
        unsafe { &*self.handle }
    }

    fn call(&self, kind: wire::request::Kind) -> wire::Response {
        let (code, envelope) = self.call_raw(kind);
        assert_eq!(code, CENTRAID_OK);
        match envelope.body {
            Some(wire::envelope::Body::Response(response)) => response,
            other => panic!("{other:?}"),
        }
    }

    /// A call's status code and the envelope it handed back, whatever it was.
    fn call_raw(&self, kind: wire::request::Kind) -> (i32, wire::Envelope) {
        let request = wire::Envelope {
            request_id: 0,
            body: Some(wire::envelope::Body::Request(wire::Request {
                kind: Some(kind),
            })),
        }
        .encode_to_vec();
        let mut buf: *mut u8 = std::ptr::null_mut();
        let mut len: usize = 0;
        // SAFETY: live handle, borrowed request, live out-pointers.
        let code = unsafe {
            centraid_call(
                self.handle,
                request.as_ptr(),
                request.len(),
                &raw mut buf,
                &raw mut len,
            )
        };
        // SAFETY: what the call reported, freed once with its length.
        let bytes = unsafe { std::slice::from_raw_parts(buf, len) }.to_vec();
        unsafe { centraid_free(buf, len) };
        (
            code,
            wire::Envelope::decode(bytes.as_slice()).expect("an envelope"),
        )
    }

    fn events(&self) -> Vec<wire::Event> {
        let mut out = Vec::new();
        loop {
            let mut buf: *mut u8 = std::ptr::null_mut();
            let mut len: usize = 0;
            // SAFETY: live handle and out-pointers.
            let code = unsafe { centraid_next_event(self.handle, 50, &raw mut buf, &raw mut len) };
            if code == CENTRAID_TIMEOUT {
                return out;
            }
            assert_eq!(code, CENTRAID_OK);
            // SAFETY: as in `call`.
            let bytes = unsafe { std::slice::from_raw_parts(buf, len) }.to_vec();
            unsafe { centraid_free(buf, len) };
            match wire::Envelope::decode(bytes.as_slice())
                .expect("an envelope")
                .body
            {
                Some(wire::envelope::Body::Event(event)) => out.push(event),
                other => panic!("{other:?}"),
            }
        }
    }
}

impl Drop for Opened {
    fn drop(&mut self) {
        // SAFETY: the handle came from `centraid_open` and is closed once.
        unsafe { centraid_close(self.handle) };
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn assist(opened: &Opened, kind: wire::assist_request::Kind) -> wire::AssistResponse {
    match opened
        .call(wire::request::Kind::Assist(wire::AssistRequest {
            kind: Some(kind),
        }))
        .kind
    {
        Some(wire::response::Kind::Assist(answer)) => answer,
        other => panic!("{other:?}"),
    }
}

/// One model message, as the free decoder reads it: a think, then the one call it writes.
fn message(think: &str, tool: &str, args: &[(&str, &str)]) -> [String; 2] {
    let params: String = args
        .iter()
        .map(|(key, value)| format!("<parameter={key}>\n{value}\n</parameter>\n"))
        .collect();
    [
        think.to_owned(),
        format!("\n\n<tool_call>\n<function={tool}>\n{params}</function>\n"),
    ]
}

#[test]
fn a_turn_crosses_the_abi_and_its_events_come_back_encoded_and_in_order() {
    let opened = Opened::sample();
    opened
        .core()
        .assist()
        .host()
        .install(Arc::new(ScriptedModel::new(
            [
                message("plan: look", "find", &[("kind", "task")]),
                message("plan: answer", "answer", &[("rows", "@1")]),
            ]
            .into_iter()
            .flatten(),
        )));
    opened.events();

    let Some(wire::assist_response::Kind::Started(started)) = assist(
        &opened,
        wire::assist_request::Kind::Start(wire::AssistStartRequest {
            app: "tasks".to_owned(),
            ..wire::AssistStartRequest::default()
        }),
    )
    .kind
    else {
        panic!("a chat starts")
    };
    let Some(wire::assist_response::Kind::Sent(sent)) = assist(
        &opened,
        wire::assist_request::Kind::Send(wire::AssistSendRequest {
            session_id: started.session_id,
            text: "What is due today?".to_owned(),
            tz: "UTC".to_owned(),
            regenerate: false,
            turn_id: 1,
            ..wire::AssistSendRequest::default()
        }),
    )
    .kind
    else {
        panic!("a send answers")
    };
    let Some(wire::assist_sent::Outcome::Answered(answer)) = sent.outcome else {
        panic!("the turn answers")
    };
    assert_eq!(answer.text, "Found 12 tasks. Showing 6.");
    assert_eq!(answer.cards.len(), 6);
    assert!(
        answer
            .cards
            .iter()
            .all(|card| card.app == "tasks" && card.entity == "task")
    );

    let kinds: Vec<&'static str> = opened
        .events()
        .into_iter()
        .filter_map(|event| match event.kind? {
            wire::event::Kind::Assist(event) => Some(match event.kind? {
                wire::assist_event::Kind::Activity(_) => "activity",
                wire::assist_event::Kind::Cards(_) => "cards",
                wire::assist_event::Kind::Token(_) => "token",
                wire::assist_event::Kind::Answer(_) => "answer",
                wire::assist_event::Kind::Failed(_) => "failed",
                wire::assist_event::Kind::Reading(_) => "reading",
                wire::assist_event::Kind::Pending(_) => "pending",
            }),
            _ => None,
        })
        .collect();
    // one Activity a looking step, the cards, then the answer: the runtime composes the line,
    // so no words stream
    assert_eq!(
        kinds,
        ["activity", "activity", "cards", "answer"],
        "{kinds:?}"
    );
}

#[test]
fn a_decline_out_of_scope_crosses_the_abi_as_the_canned_sentence_and_no_streamed_words() {
    // R-1088-19: no free reply. The words scripted after the decline are never asked for.
    let opened = Opened::sample();
    let model = Arc::new(ScriptedModel::new(
        std::iter::once(message(
            "plan: no",
            "decline",
            &[("reason", "out_of_scope")],
        ))
        .flatten()
        .chain(["Hello. I can look things up for you.".to_owned()]),
    ));
    opened.core().assist().host().install(model.clone());
    opened.events();
    let session = start(&opened);
    let sent = send_with(&opened, session, 1, "hi", Vec::new());
    let Some(wire::assist_sent::Outcome::Answered(answer)) = sent.outcome else {
        panic!("the turn answers")
    };
    assert_eq!(answer.text, "Outside what chat can do here.");
    assert_eq!(
        model.requests().len(),
        2,
        "a think and a call, then nothing"
    );
    let kinds: Vec<&'static str> = opened
        .events()
        .into_iter()
        .filter_map(|event| match event.kind? {
            wire::event::Kind::Assist(event) => Some(match event.kind? {
                wire::assist_event::Kind::Token(_) => "token",
                wire::assist_event::Kind::Answer(_) => "answer",
                _ => "other",
            }),
            _ => None,
        })
        .collect();
    assert_eq!(kinds, ["answer"], "no word streams: {kinds:?}");
}

#[test]
fn a_parked_write_crosses_the_abi_as_a_card_and_a_tap_on_it_comes_back_settled() {
    // A write turn: two model messages (look, then act), each a think and the one call it writes.
    let opened = Opened::sample();
    let script: Vec<String> = [
        message(
            "plan: look",
            "find",
            &[("kind", "task"), ("name", "dry cleaning")],
        ),
        message(
            "plan: write",
            "act",
            &[("verb", "complete"), ("rows", "@1")],
        ),
    ]
    .into_iter()
    .flatten()
    .collect();
    opened
        .core()
        .assist()
        .host()
        .install(Arc::new(ScriptedModel::new(script)));
    opened.events();

    let session = start(&opened);
    let sent = send_with(
        &opened,
        session,
        1,
        "complete the dry cleaning task",
        Vec::new(),
    );
    let Some(wire::assist_sent::Outcome::Answered(answer)) = sent.outcome else {
        panic!("the turn answers")
    };
    let card = answer.pending.expect("the answer carries the card");
    assert_eq!(card.steps.len(), 1);
    assert_eq!(
        card.steps[0].summary,
        "Complete task \"Pick up the dry cleaning\""
    );

    // the same card came back on the stream, encoded, just before the answer
    let streamed: Vec<wire::AssistEvent> = opened
        .events()
        .into_iter()
        .filter_map(|event| match event.kind? {
            wire::event::Kind::Assist(event) => Some(event),
            _ => None,
        })
        .collect();
    let on_stream = streamed
        .iter()
        .find_map(|event| match event.kind.as_ref()? {
            wire::assist_event::Kind::Pending(card) => Some(card),
            _ => None,
        });
    assert_eq!(on_stream, Some(&card));

    // THE TAP crosses as its own request and comes back as `settled`
    let Some(wire::assist_response::Kind::Settled(settled)) = assist(
        &opened,
        wire::assist_request::Kind::Confirm(wire::AssistConfirmRequest {
            session_id: session,
            pending_id: card.pending_id.clone(),
        }),
    )
    .kind
    else {
        panic!("a confirm answers settled")
    };
    assert_eq!(settled.outcome, wire::AssistSettleOutcome::Applied as i32);
    assert_eq!(settled.line, "Done.");
    assert_eq!(settled.pending_id, card.pending_id);

    // and the same tap again is nothing writing twice
    let Some(wire::assist_response::Kind::Settled(again)) = assist(
        &opened,
        wire::assist_request::Kind::Dismiss(wire::AssistDismissRequest {
            session_id: session,
            pending_id: card.pending_id,
        }),
    )
    .kind
    else {
        panic!("a dismiss answers settled")
    };
    assert_eq!(
        again.outcome,
        wire::AssistSettleOutcome::NothingWaiting as i32
    );
}

#[test]
fn a_status_and_a_refusal_cross_as_typed_messages() {
    let opened = Opened::sample();
    let status = assist(
        &opened,
        wire::assist_request::Kind::Status(wire::AssistStatusRequest {
            model_path: "/nowhere/model.gguf".to_owned(),
            ..wire::AssistStatusRequest::default()
        }),
    );
    let Some(wire::assist_response::Kind::Status(status)) = status.kind else {
        panic!("a status answers")
    };
    assert_eq!(status.state, wire::AssistModelState::Absent as i32);

    // No model is loaded: a typed refusal in the outcome, not an error.
    let Some(wire::assist_response::Kind::Started(started)) = assist(
        &opened,
        wire::assist_request::Kind::Start(wire::AssistStartRequest::default()),
    )
    .kind
    else {
        panic!()
    };
    let Some(wire::assist_response::Kind::Sent(sent)) = assist(
        &opened,
        wire::assist_request::Kind::Send(wire::AssistSendRequest {
            session_id: started.session_id,
            text: "hi".to_owned(),
            turn_id: 1,
            ..wire::AssistSendRequest::default()
        }),
    )
    .kind
    else {
        panic!()
    };
    let Some(wire::assist_sent::Outcome::Refused(refusal)) = sent.outcome else {
        panic!()
    };
    assert_eq!(
        refusal.reason,
        wire::AssistRefusalReason::ModelAbsent as i32
    );
}

fn status_of(opened: &Opened, path: &std::path::Path) -> wire::AssistStatus {
    let answer = assist(
        opened,
        wire::assist_request::Kind::Status(wire::AssistStatusRequest {
            model_path: path.display().to_string(),
            ..wire::AssistStatusRequest::default()
        }),
    );
    match answer.kind {
        Some(wire::assist_response::Kind::Status(status)) => status,
        other => panic!("a status answered {other:?}"),
    }
}

fn load(opened: &Opened, path: &std::path::Path) -> (i32, Option<wire::AssistStatus>) {
    let (code, envelope) = opened.call_raw(wire::request::Kind::Assist(wire::AssistRequest {
        kind: Some(wire::assist_request::Kind::Load(wire::AssistLoadRequest {
            model_path: path.display().to_string(),
            ..wire::AssistLoadRequest::default()
        })),
    }));
    match envelope.body {
        Some(wire::envelope::Body::Response(wire::Response {
            kind: Some(wire::response::Kind::Assist(wire::AssistResponse { kind })),
        })) => match kind {
            Some(wire::assist_response::Kind::Status(status)) => (code, Some(status)),
            other => panic!("a load answered {other:?}"),
        },
        Some(wire::envelope::Body::Error(_)) => (code, None),
        other => panic!("{other:?}"),
    }
}

#[cfg(feature = "llama")]
#[test]
fn a_core_as_opened_reads_a_model_file_as_present_and_refuses_a_file_that_is_not_one() {
    // THE ENGINE IS WIRED INTO `centraid_open`: a file that is there is PRESENT
    // (an engine could read it), never NO_ENGINE. This is the line the shell's
    // "this build cannot run the assistant" screen hangs on.
    let opened = Opened::as_opened();
    let dir = opened.dir.join("models");
    std::fs::create_dir_all(&dir).expect("a directory");
    let gone = dir.join("nowhere.gguf");
    assert_eq!(
        status_of(&opened, &gone).state,
        wire::AssistModelState::Absent as i32
    );

    let garbage = dir.join("not-a-model.gguf");
    std::fs::write(&garbage, b"this is not a GGUF file, however long it is").expect("a file");
    let status = status_of(&opened, &garbage);
    assert_eq!(status.state, wire::AssistModelState::Present as i32);
    assert_eq!(status.model_bytes, 43);

    // llama.cpp reads the magic and says no; that is a typed refusal in an
    // error envelope, the slot is not stuck loading, and the file is still
    // PRESENT.
    let (code, loaded) = load(&opened, &garbage);
    assert_ne!(code, CENTRAID_OK);
    assert!(loaded.is_none());
    assert_eq!(
        status_of(&opened, &garbage).state,
        wire::AssistModelState::Present as i32
    );
}

#[cfg(not(feature = "llama"))]
#[test]
fn a_core_as_opened_without_the_engine_reads_a_model_file_as_no_engine_and_will_not_load() {
    // THE PR GATE'S BUILD: `llama` is off, so `centraid_open` registers no
    // engine and a file that is there is NO_ENGINE — the state the shell draws
    // as "this build cannot run the assistant" — and never PRESENT, which
    // would promise a load nothing could do. The engine-on twin above is run
    // by the `engine` job (`.github/workflows/gate.yml`).
    let opened = Opened::as_opened();
    let dir = opened.dir.join("models");
    std::fs::create_dir_all(&dir).expect("a directory");
    assert_eq!(
        status_of(&opened, &dir.join("nowhere.gguf")).state,
        wire::AssistModelState::Absent as i32
    );

    let file = dir.join("a-model-or-not.gguf");
    std::fs::write(&file, b"this is not a GGUF file, however long it is").expect("a file");
    let status = status_of(&opened, &file);
    assert_eq!(status.state, wire::AssistModelState::NoEngine as i32);
    assert_eq!(status.model_bytes, 43);

    let (code, loaded) = load(&opened, &file);
    assert_ne!(code, CENTRAID_OK);
    assert!(loaded.is_none());
    assert_eq!(
        status_of(&opened, &file).state,
        wire::AssistModelState::NoEngine as i32
    );
}

/// THE REAL MODEL, THROUGH THE FIVE SYMBOLS. `CENTRAID_ASSIST_MODEL` names a
/// GGUF; unset, this is a no-op, and `cargo test -- --ignored` runs it:
///
/// ```text
/// CENTRAID_ASSIST_MODEL=~/.cache/centraid/models/Qwen3.5-0.8B-Q4_0.gguf \
///   cargo test --release -p centraid-core-ffi --test assist -- --ignored --nocapture
/// ```
///
/// It loads the file, asks the sample vault a few questions and prints what
/// the model said. What it asserts is the plane's contract and not the model's
/// accuracy: every turn ends in an answer or a typed refusal, and a cancel
/// stops a turn.
#[cfg(feature = "llama")]
#[test]
#[ignore = "needs a model file: set CENTRAID_ASSIST_MODEL"]
fn the_real_model_answers_questions_over_the_sample_vault() {
    let Some(model) = std::env::var_os("CENTRAID_ASSIST_MODEL") else {
        eprintln!("CENTRAID_ASSIST_MODEL is not set; nothing to run");
        return;
    };
    let model = std::path::PathBuf::from(model);
    let opened = Opened::as_opened();
    assert_eq!(
        status_of(&opened, &model).state,
        wire::AssistModelState::Present as i32
    );
    let started = std::time::Instant::now();
    let (code, loaded) = load(&opened, &model);
    assert_eq!(code, CENTRAID_OK);
    assert_eq!(
        loaded.expect("a status").state,
        wire::AssistModelState::Ready as i32
    );
    eprintln!("load: {:.2} s", started.elapsed().as_secs_f64());

    let session = |app: &str| match assist(
        &opened,
        wire::assist_request::Kind::Start(wire::AssistStartRequest {
            app: app.to_owned(),
            ..wire::AssistStartRequest::default()
        }),
    )
    .kind
    {
        Some(wire::assist_response::Kind::Started(started)) => started.session_id,
        other => panic!("{other:?}"),
    };
    let ask = |session_id: u64, turn_id: u64, text: &str| {
        let started = std::time::Instant::now();
        let answer = assist(
            &opened,
            wire::assist_request::Kind::Send(wire::AssistSendRequest {
                session_id,
                text: text.to_owned(),
                tz: "UTC".to_owned(),
                regenerate: false,
                turn_id,
                ..wire::AssistSendRequest::default()
            }),
        );
        let Some(wire::assist_response::Kind::Sent(sent)) = answer.kind else {
            panic!("a send answers")
        };
        eprintln!("[{:.2} s] {text}", started.elapsed().as_secs_f64());
        // What the model streamed, and the looking it did first.
        let events = opened.events();
        for event in &events {
            if let Some(wire::event::Kind::Assist(wire::AssistEvent {
                kind: Some(wire::assist_event::Kind::Activity(activity)),
                ..
            })) = &event.kind
            {
                eprintln!("    step: {} in {}", activity.tool, activity.app);
            }
        }
        let streamed: String = events
            .into_iter()
            .filter_map(|event| match event.kind? {
                wire::event::Kind::Assist(wire::AssistEvent {
                    kind: Some(wire::assist_event::Kind::Token(token)),
                    ..
                }) => Some(token.text),
                _ => None,
            })
            .collect();
        if !streamed.is_empty() {
            eprintln!("    streamed: {streamed:?}");
        }
        match sent.outcome {
            Some(wire::assist_sent::Outcome::Answered(answered)) => {
                eprintln!(
                    "    -> {:?} ({} cards: {})",
                    answered.text,
                    answered.cards.len(),
                    answered
                        .cards
                        .iter()
                        .take(3)
                        .map(|card| card.title.as_str())
                        .collect::<Vec<_>>()
                        .join(" | ")
                );
                assert!(!answered.text.is_empty());
            }
            Some(wire::assist_sent::Outcome::Refused(refusal)) => {
                eprintln!(
                    "    -> refused: reason {} ({})",
                    refusal.reason, refusal.detail
                );
            }
            None => panic!("a send names an outcome"),
        }
    };
    // Each question in a chat of its own: a 0.8B model copies its own earlier
    // steps, so one wrong call early would be most of the run's answers.
    for question in [
        "What is due today?",
        "What can you do?",
        "Who owes me money?",
        "Show me photos of the Tahoe trip",
        "What tasks are overdue?",
        "What does my week look like?",
        "Find my notes about chili",
        "Which of my friends should I get back in touch with?",
    ] {
        ask(session(""), 1, question);
    }
    // A scoped chat and a follow-up that depends on the turn before it.
    let tasks = session("tasks");
    ask(tasks, 1, "What's overdue?");
    ask(tasks, 2, "And what is due today?");

    // Sessions of several turns, which is where a small model copies itself:
    // a refusal must not become the chat's habit, and a follow-up must read
    // the turn before it.
    let refused_first = session("");
    ask(refused_first, 1, "Add a task to buy milk");
    ask(refused_first, 2, "What's due today?");
    ask(refused_first, 3, "And tomorrow?");
    let people = session("");
    ask(people, 1, "Who is Maya?");
    ask(people, 2, "What about Jake?");
    ask(people, 3, "Show me photos of her");
    let weather_first = session("");
    ask(weather_first, 1, "What's the weather in Tahoe?");
    ask(weather_first, 2, "Who owes me money?");
    ask(weather_first, 3, "What did we spend last month?");

    // A stop that arrives mid-turn ends it: cancel from another thread.
    let long = session("");
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(30));
            assist(
                &opened,
                wire::assist_request::Kind::Cancel(wire::AssistCancelRequest { session_id: long }),
            );
        });
        ask(long, 1, "Summarise everything I have in every app");
    });

    // `Unload` is what a shell sends under memory pressure. (A model still
    // loaded at exit is freed by the engine's exit hook, or ggml's Metal
    // teardown would assert.)
    let freed = assist(
        &opened,
        wire::assist_request::Kind::Unload(wire::AssistUnloadRequest {}),
    );
    let Some(wire::assist_response::Kind::Status(status)) = freed.kind else {
        panic!("an unload answers with the slot's state")
    };
    assert_ne!(status.state, wire::AssistModelState::Ready as i32);
}

// ---------------------------------------------------------------------------
// ATTACHMENTS, ACROSS THE FIVE SYMBOLS.
// ---------------------------------------------------------------------------

/// A row's id, read through the page door a shell reads through: the `nth`
/// row of `from`, in key order, whose `columns` (as text; a null cell is empty)
/// satisfy `keep`.
///
/// This used to be SQL in a test, which is a query outside the crates SQL
/// lives in (`sql-confinement`). The page door is the product's own way to
/// ask a vault what it holds, so the test now asks the same way.
fn id_of(
    opened: &Opened,
    from: &str,
    pk: &str,
    columns: &[&str],
    nth: usize,
    keep: impl Fn(&[String]) -> bool,
) -> String {
    let mut select = vec![pk.to_owned()];
    select.extend(columns.iter().map(|column| (*column).to_owned()));
    let answer = opened.call(wire::request::Kind::Page(wire::PageRequest {
        query: Some(wire::PageQuery {
            name: "assist.test".to_owned(),
            select,
            from: from.to_owned(),
            r#where: None,
            bind: Vec::new(),
            order: Some(wire::PageOrder {
                sort_column: pk.to_owned(),
                pk_column: pk.to_owned(),
                descending: false,
            }),
            with_held_thumbnail: false,
            with_note_body: false,
            with_document_size: false,
            with_minor_units: false,
            local_day_columns: Vec::new(),
            tz: String::new(),
        }),
        limit: 500,
        after: None,
    }));
    let Some(wire::response::Kind::Page(page)) = answer.kind else {
        panic!("a page answered {answer:?}");
    };
    let text = |value: &wire::Value| match &value.kind {
        Some(wire::value::Kind::Text(text)) => text.clone(),
        _ => String::new(),
    };
    page.rows
        .iter()
        .map(|row| row.values.iter().map(text).collect::<Vec<_>>())
        .filter(|cells| keep(&cells[1..]))
        .nth(nth)
        .map(|cells| cells[0].clone())
        .unwrap_or_else(|| panic!("{from} has no matching row number {nth}"))
}

/// The document with this exact title.
fn document_titled(opened: &Opened, title: &str) -> String {
    id_of(
        opened,
        "core_document",
        "document_id",
        &["title"],
        0,
        |cells| cells[0] == title,
    )
}

/// The `nth` titled photograph, in key order.
fn photo(opened: &Opened, nth: usize) -> String {
    id_of(
        opened,
        "media_asset",
        "asset_id",
        &["kind", "title"],
        nth,
        |cells| cells[0] == "photo" && !cells[1].is_empty(),
    )
}

fn start(opened: &Opened) -> u64 {
    match assist(
        opened,
        wire::assist_request::Kind::Start(wire::AssistStartRequest::default()),
    )
    .kind
    {
        Some(wire::assist_response::Kind::Started(started)) => started.session_id,
        other => panic!("{other:?}"),
    }
}

fn send_with(
    opened: &Opened,
    session_id: u64,
    turn_id: u64,
    text: &str,
    attachments: Vec<wire::AssistAttachment>,
) -> wire::AssistSent {
    let answer = assist(
        opened,
        wire::assist_request::Kind::Send(wire::AssistSendRequest {
            session_id,
            text: text.to_owned(),
            tz: "UTC".to_owned(),
            turn_id,
            attachments,
            ..wire::AssistSendRequest::default()
        }),
    );
    match answer.kind {
        Some(wire::assist_response::Kind::Sent(sent)) => sent,
        other => panic!("a send answers: {other:?}"),
    }
}

fn photo_of(asset_id: &str) -> wire::AssistAttachment {
    wire::AssistAttachment {
        kind: Some(wire::assist_attachment::Kind::VaultPhoto(
            wire::AssistVaultPhoto {
                asset_id: asset_id.to_owned(),
            },
        )),
        ..wire::AssistAttachment::default()
    }
}

fn doc_of(doc_id: &str) -> wire::AssistAttachment {
    wire::AssistAttachment {
        kind: Some(wire::assist_attachment::Kind::VaultDoc(
            wire::AssistVaultDoc {
                doc_id: doc_id.to_owned(),
            },
        )),
        ..wire::AssistAttachment::default()
    }
}

fn refusal_of(sent: &wire::AssistSent) -> i32 {
    match &sent.outcome {
        Some(wire::assist_sent::Outcome::Refused(refusal)) => refusal.reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn the_shipped_chat_refuses_every_attachment_and_never_loads_the_projector() {
    // R-1088-19: `attach::OFFERED` is off, so a send that carries a document or a photo is
    // refused `AttachmentUnsupported` before the model is asked or the file is read, and a load
    // that names a projector leaves the vision state at PRESENT, never READY.
    let opened = Opened::sample();
    assert!(!opened.core().assist().attachments_offered());
    let model = Arc::new(ScriptedModel::new(["never said"]).seeing());
    opened.core().assist().host().install(model.clone());
    opened.events();
    let session = start(&opened);
    let packing = document_titled(&opened, "Tahoe packing list");
    let asset = photo(&opened, 0);
    for (turn, attachment) in (1u64..).zip([doc_of(&packing), photo_of(&asset)]) {
        let sent = send_with(&opened, session, turn, "What is in this?", vec![attachment]);
        assert_eq!(
            refusal_of(&sent),
            wire::AssistRefusalReason::AttachmentUnsupported as i32
        );
    }
    assert!(model.requests().is_empty(), "the model was not asked");

    // The same load that makes a fake model READY when attachments are offered
    // (`a_status_and_a_load_say_where_the_projector_stands`) leaves it PRESENT.
    opened
        .core()
        .assist()
        .host()
        .install(Arc::new(ScriptedModel::empty()));
    let projector = opened.dir.join("mmproj.gguf");
    std::fs::write(&projector, b"projector bytes").expect("a file");
    let answer = assist(
        &opened,
        wire::assist_request::Kind::Load(wire::AssistLoadRequest {
            model_path: "anywhere".to_owned(),
            projector_path: projector.display().to_string(),
        }),
    );
    let Some(wire::assist_response::Kind::Status(status)) = answer.kind else {
        panic!("a load answers with a status")
    };
    assert_eq!(status.vision, wire::AssistVisionState::Present as i32);
}

#[test]
fn a_document_attachment_is_read_through_the_core_and_answered_without_tools() {
    let opened = Opened::offering_attachments();
    let model = Arc::new(ScriptedModel::new([
        "Bring the rain shell, boots and a headlamp.",
    ]));
    opened.core().assist().host().install(model.clone());
    opened.events();
    let packing = document_titled(&opened, "Tahoe packing list");

    let sent = send_with(
        &opened,
        start(&opened),
        1,
        "What should I not forget?",
        vec![doc_of(&packing)],
    );
    let Some(wire::assist_sent::Outcome::Answered(answer)) = sent.outcome else {
        panic!("the turn answers: {sent:?}")
    };
    assert_eq!(answer.text, "Bring the rain shell, boots and a headlamp.");
    assert!(answer.notices.is_empty(), "a short document is not cut");

    // ONE generation, over the document's CURRENT revision (the edit's lines).
    let requests = model.requests();
    assert_eq!(requests.len(), 1, "no tool loop");
    assert!(requests[0].grammar.is_none());
    assert!(requests[0].prompt.contains("- Hiking boots"));
    assert!(
        requests[0].prompt.contains("Tire chains"),
        "the current revision"
    );
    assert!(requests[0].images.is_empty());

    let kinds: Vec<&'static str> = opened
        .events()
        .into_iter()
        .filter_map(|event| match event.kind? {
            wire::event::Kind::Assist(event) => Some(match event.kind? {
                wire::assist_event::Kind::Reading(reading) => {
                    assert_eq!(reading.kind, wire::AssistReadingKind::Document as i32);
                    "reading"
                }
                wire::assist_event::Kind::Token(_) => "token",
                wire::assist_event::Kind::Answer(_) => "answer",
                _ => "other",
            }),
            _ => None,
        })
        .collect();
    assert_eq!(kinds.first(), Some(&"reading"), "{kinds:?}");
    assert_eq!(kinds.last(), Some(&"answer"), "{kinds:?}");
    assert!(!kinds.contains(&"other"), "{kinds:?}");
}

#[test]
fn a_vault_photo_reaches_the_model_decoded_and_scaled_and_needs_a_projector() {
    let opened = Opened::offering_attachments();
    let asset = photo(&opened, 0);

    // No projector: a typed refusal before the photograph is decoded.
    let blind = Arc::new(ScriptedModel::new(["never said"]));
    opened.core().assist().host().install(blind.clone());
    opened.events();
    let session = start(&opened);
    let sent = send_with(
        &opened,
        session,
        1,
        "What is in this photo?",
        vec![photo_of(&asset)],
    );
    assert_eq!(
        refusal_of(&sent),
        wire::AssistRefusalReason::VisionAbsent as i32
    );
    assert!(blind.requests().is_empty(), "the model was not asked");
    let failed = opened.events().into_iter().any(|event| {
        matches!(
            event.kind,
            Some(wire::event::Kind::Assist(wire::AssistEvent {
                kind: Some(wire::assist_event::Kind::Failed(_)),
                ..
            }))
        )
    });
    assert!(failed, "the stream says so too");

    // With one: the engine is handed RGB, scaled to the 448-pixel edge.
    let seeing = Arc::new(ScriptedModel::new(["A mountain lake at dusk."]).seeing());
    opened.core().assist().host().install(seeing.clone());
    let sent = send_with(
        &opened,
        session,
        2,
        "What is in this photo?",
        vec![photo_of(&asset)],
    );
    let Some(wire::assist_sent::Outcome::Answered(answer)) = sent.outcome else {
        panic!("the turn answers: {sent:?}")
    };
    assert_eq!(answer.text, "A mountain lake at dusk.");
    let request = &seeing.requests()[0];
    assert_eq!(request.images.len(), 1);
    let (width, height) = request.images[0];
    assert!(
        width.max(height) <= 448 && width.min(height) > 0,
        "{width}x{height}"
    );
    assert_eq!(request.prompt.matches("<__media__>").count(), 1);
    assert!(request.grammar.is_none());
}

#[test]
fn what_the_chat_does_not_read_is_a_typed_refusal_and_a_malformed_request_is_an_error() {
    let opened = Opened::offering_attachments();
    let seeing = Arc::new(ScriptedModel::empty().seeing());
    opened.core().assist().host().install(seeing.clone());
    let session = start(&opened);
    let video = id_of(&opened, "media_asset", "asset_id", &["kind"], 0, |cells| {
        cells[0] == "video"
    });
    let bytes = |bytes: &[u8], mime: &str| wire::AssistAttachment {
        kind: Some(wire::assist_attachment::Kind::ImageBytes(
            wire::AssistImageBytes {
                content: bytes.to_vec(),
                mime: mime.to_owned(),
            },
        )),
        ..wire::AssistAttachment::default()
    };
    let reason = |sent: &wire::AssistSent| refusal_of(sent);
    use wire::AssistRefusalReason as R;

    let cases = [
        (vec![photo_of(&video)], R::AttachmentUnsupported),
        (vec![photo_of("no-such-asset")], R::AttachmentUnreadable),
        (vec![doc_of("no-such-document")], R::AttachmentUnreadable),
        (
            vec![bytes(b"not an image at all", "image/jpeg")],
            R::AttachmentUnreadable,
        ),
        (
            vec![bytes(b"%PDF-1.7", "application/pdf")],
            R::AttachmentUnsupported,
        ),
        (
            vec![bytes(&vec![0u8; 26 * 1024 * 1024], "image/png")],
            R::AttachmentTooLarge,
        ),
    ];
    for (turn, (attachments, expected)) in cases.into_iter().enumerate() {
        let sent = send_with(
            &opened,
            session,
            turn as u64 + 1,
            "What is this?",
            attachments,
        );
        assert_eq!(reason(&sent), expected as i32, "case {turn}");
    }
    assert!(seeing.requests().is_empty(), "no refusal reached the model");

    // Two photos, an empty attachment and an id-less one are the request's fault.
    for attachments in [
        vec![photo_of("a"), photo_of("b")],
        vec![wire::AssistAttachment::default()],
        vec![photo_of("")],
    ] {
        let (code, envelope) = opened.call_raw(wire::request::Kind::Assist(wire::AssistRequest {
            kind: Some(wire::assist_request::Kind::Send(wire::AssistSendRequest {
                session_id: session,
                text: "x".to_owned(),
                turn_id: 99,
                attachments,
                ..wire::AssistSendRequest::default()
            })),
        }));
        assert_ne!(code, CENTRAID_OK);
        assert!(matches!(
            envelope.body,
            Some(wire::envelope::Body::Error(_))
        ));
    }
}

#[test]
fn retry_over_a_document_asks_the_same_document_again() {
    let opened = Opened::offering_attachments();
    let model = Arc::new(ScriptedModel::new(["First answer.", "Second answer."]));
    opened.core().assist().host().install(model.clone());
    let packing = document_titled(&opened, "Tahoe packing list");
    let session = start(&opened);
    send_with(
        &opened,
        session,
        1,
        "What should I not forget?",
        vec![doc_of(&packing)],
    );

    // A regenerate with no attachments asks the last turn's own again.
    let answer = assist(
        &opened,
        wire::assist_request::Kind::Send(wire::AssistSendRequest {
            session_id: session,
            regenerate: true,
            turn_id: 2,
            tz: "UTC".to_owned(),
            ..wire::AssistSendRequest::default()
        }),
    );
    let Some(wire::assist_response::Kind::Sent(sent)) = answer.kind else {
        panic!("a send answers")
    };
    let Some(wire::assist_sent::Outcome::Answered(answer)) = sent.outcome else {
        panic!("the retry answers: {sent:?}")
    };
    assert_eq!(answer.text, "Second answer.");
    let requests = model.requests();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1].prompt.contains("- Hiking boots"),
        "the same document"
    );
    assert!(
        !requests[1].prompt.contains("First answer."),
        "the dropped turn is not in the retry's history"
    );
}

#[test]
fn a_status_and_a_load_say_where_the_projector_stands() {
    let opened = Opened::offering_attachments();
    let dir = opened.dir.join("models");
    std::fs::create_dir_all(&dir).expect("a directory");
    let projector = dir.join("mmproj.gguf");
    let vision = |status: &wire::AssistResponse| match &status.kind {
        Some(wire::assist_response::Kind::Status(status)) => {
            (status.vision, status.projector_bytes)
        }
        other => panic!("{other:?}"),
    };
    let ask = |model: &str, projector: &std::path::Path| {
        assist(
            &opened,
            wire::assist_request::Kind::Status(wire::AssistStatusRequest {
                model_path: model.to_owned(),
                projector_path: projector.display().to_string(),
            }),
        )
    };
    // No projector path: the field stays unspecified.
    let silent = assist(
        &opened,
        wire::assist_request::Kind::Status(wire::AssistStatusRequest::default()),
    );
    assert_eq!(
        vision(&silent),
        (wire::AssistVisionState::Unspecified as i32, 0)
    );
    assert_eq!(
        vision(&ask("", &projector)).0,
        wire::AssistVisionState::Absent as i32
    );
    std::fs::write(&projector, b"projector bytes").expect("a file");
    assert_eq!(
        vision(&ask("", &projector)),
        (wire::AssistVisionState::Present as i32, 15)
    );

    // A fake model that is already loaded takes the projector without being
    // loaded again, and then the status is READY.
    opened
        .core()
        .assist()
        .host()
        .install(Arc::new(ScriptedModel::empty()));
    let loaded = assist(
        &opened,
        wire::assist_request::Kind::Load(wire::AssistLoadRequest {
            model_path: "anywhere".to_owned(),
            projector_path: projector.display().to_string(),
        }),
    );
    assert_eq!(vision(&loaded).0, wire::AssistVisionState::Ready as i32);
    assert_eq!(
        vision(&ask("anywhere", &projector)).0,
        wire::AssistVisionState::Ready as i32
    );
}

#[test]
fn the_picker_lists_the_sample_vaults_text_documents_newest_edit_first() {
    let opened = Opened::sample();
    let answer = assist(
        &opened,
        wire::assist_request::Kind::Documents(wire::AssistDocumentsRequest { limit: 0 }),
    );
    let Some(wire::assist_response::Kind::Documents(listed)) = answer.kind else {
        panic!("a documents list answers")
    };
    let titles: Vec<&str> = listed.documents.iter().map(|d| d.title.as_str()).collect();
    assert!(titles.contains(&"Tahoe packing list"), "{titles:?}");
    assert_eq!(titles.len(), 3, "the three sample documents: {titles:?}");
    assert!(
        listed
            .documents
            .iter()
            .all(|d| d.media_type.starts_with("text/markdown") && !d.doc_id.is_empty())
    );
    let limited = assist(
        &opened,
        wire::assist_request::Kind::Documents(wire::AssistDocumentsRequest { limit: 1 }),
    );
    let Some(wire::assist_response::Kind::Documents(one)) = limited.kind else {
        panic!()
    };
    assert_eq!(one.documents.len(), 1);
}

/// THE REAL MODEL AND PROJECTOR OVER ATTACHMENTS, through the five symbols.
///
/// ```text
/// CENTRAID_ASSIST_MODEL=~/.cache/centraid/models/Qwen3.5-0.8B-Q4_0.gguf \
/// CENTRAID_ASSIST_MMPROJ=~/.cache/centraid/models/Qwen3.5-0.8B-mmproj-F16.gguf \
///   cargo test --release -p centraid-core-ffi --test assist -- --ignored --nocapture attachments
/// ```
///
/// It describes sample-vault photographs and asks about a sample document, and
/// prints what the model said. Asserted: every turn answers, a photo turn
/// streams, and nothing is refused.
#[cfg(feature = "llama")]
#[test]
#[ignore = "needs CENTRAID_ASSIST_MODEL and CENTRAID_ASSIST_MMPROJ"]
fn the_real_model_reads_sample_photos_and_a_sample_document_attachments() {
    let (Some(model), Some(projector)) = (
        std::env::var_os("CENTRAID_ASSIST_MODEL"),
        std::env::var_os("CENTRAID_ASSIST_MMPROJ"),
    ) else {
        eprintln!("CENTRAID_ASSIST_MODEL / CENTRAID_ASSIST_MMPROJ unset; nothing to run");
        return;
    };
    let opened = Opened::as_opened();
    opened.core().assist().offer_attachments(true);
    let (code, loaded) = {
        let (code, envelope) = opened.call_raw(wire::request::Kind::Assist(wire::AssistRequest {
            kind: Some(wire::assist_request::Kind::Load(wire::AssistLoadRequest {
                model_path: std::path::PathBuf::from(&model).display().to_string(),
                projector_path: std::path::PathBuf::from(&projector).display().to_string(),
            })),
        }));
        match envelope.body {
            Some(wire::envelope::Body::Response(wire::Response {
                kind:
                    Some(wire::response::Kind::Assist(wire::AssistResponse {
                        kind: Some(wire::assist_response::Kind::Status(status)),
                    })),
            })) => (code, status),
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(code, CENTRAID_OK);
    assert_eq!(loaded.vision, wire::AssistVisionState::Ready as i32);

    let ask = |text: &str, attachments: Vec<wire::AssistAttachment>| {
        let started = std::time::Instant::now();
        let sent = send_with(&opened, start(&opened), 1, text, attachments);
        let streamed = opened
            .events()
            .into_iter()
            .filter(|event| {
                matches!(
                    event.kind,
                    Some(wire::event::Kind::Assist(wire::AssistEvent {
                        kind: Some(wire::assist_event::Kind::Token(_)),
                        ..
                    }))
                )
            })
            .count();
        let Some(wire::assist_sent::Outcome::Answered(answer)) = sent.outcome else {
            panic!("the turn answers: {sent:?}")
        };
        eprintln!(
            "[{:.2} s, {streamed} pieces] {text}\n  -> {}",
            started.elapsed().as_secs_f64(),
            answer.text
        );
        assert!(streamed > 0 && !answer.text.is_empty());
    };
    for offset in [0, 7, 15] {
        let asset = id_of(
            &opened,
            "media_asset",
            "asset_id",
            &["kind"],
            offset,
            |cells| cells[0] == "photo",
        );
        ask("What is in this photo?", vec![photo_of(&asset)]);
    }
    let packing = document_titled(&opened, "Tahoe packing list");
    ask("What should I not forget?", vec![doc_of(&packing)]);
    let cabin = id_of(
        &opened,
        "core_document",
        "document_id",
        &["title"],
        0,
        |cells| cells[0].to_lowercase().starts_with("cabin rental"),
    );
    ask(
        "What is the nightly rate and the deposit?",
        vec![doc_of(&cabin)],
    );
    assist(
        &opened,
        wire::assist_request::Kind::Unload(wire::AssistUnloadRequest {}),
    );
}
