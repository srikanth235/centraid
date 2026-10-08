//! THE NATIVE PLANE THROUGH THE DOOR A SHELL USES (#1088): `Request::Assist` over a real handle,
//! with a scripted model writing native messages (a think, then the one `<tool_call>`).
//!
//! What a shell relies on and cannot check for itself: a read turn runs find then answer with its
//! events in order, its cards mapped to the chat's own, and its line composed by the runtime; a
//! decline and a Locker ask end typed; a write parks behind a card, writes nothing until the member
//! taps, writes once when they do and nothing when they dismiss it or the rows changed; a stop
//! between steps ends the turn and costs the model no further call; a reopened thread and a retry
//! start a fresh session while a vault that changed does not; an event question reads the
//! member's own days; and an attachment never leaves its own path.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use centraid_assist::model::{Control, GenerateRequest, Generation, Model, ModelError};
use centraid_assist::native::park::Confirmed;
use centraid_assist::prompt::estimate_tokens;
use centraid_assist::testing::ScriptedModel;
use centraid_core::api_proto as wire;
use centraid_core::assist::PlaneKind;
use wire::assist_event::Kind as Event;
use wire::assist_request::Kind as Ask;

const FOUND_TASKS: &str = "Found 12 tasks. Showing 6.";

/// One model step, as the free decoder reads it: a think that states no whole call, so the call is
/// the model's own (a second generation, which stops at `</tool_call>`).
fn step(think: &str, tool: &str, args: &[(&str, &str)]) -> [String; 2] {
    let params: String = args
        .iter()
        .map(|(key, value)| format!("<parameter={key}>\n{value}\n</parameter>\n"))
        .collect();
    [
        think.to_owned(),
        format!("\n\n<tool_call>\n<function={tool}>\n{params}</function>\n"),
    ]
}

fn script(steps: &[[String; 2]]) -> Arc<ScriptedModel> {
    Arc::new(ScriptedModel::new(steps.iter().flatten().cloned()))
}

/// The two steps of a read: look at the tasks, then answer with them.
fn read_tasks() -> [[String; 2]; 2] {
    [
        step("plan: look", "find", &[("kind", "task")]),
        step("plan: answer", "answer", &[("rows", "@1")]),
    ]
}

fn native_sample(model: Arc<dyn Model>) -> common::chat::Sample {
    let sample = common::chat::sample();
    sample.handle.assist().use_plane(PlaneKind::Native);
    sample.install(model);
    sample
}

fn answered(sent: &wire::AssistSent) -> &wire::AssistAnswer {
    match sent.outcome.as_ref().expect("an outcome") {
        wire::assist_sent::Outcome::Answered(answer) => answer,
        other => panic!("expected an answer, got {other:?}"),
    }
}

fn refusal_of(sent: &wire::AssistSent) -> i32 {
    match sent.outcome.as_ref().expect("an outcome") {
        wire::assist_sent::Outcome::Refused(refusal) => refusal.reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// The turn's events in order, in a word each: `activity:tasks/find`, `cards:6`, `pending:<steps>`,
/// `answer`, `failed:<reason>`.
fn story(events: &[wire::AssistEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| {
            Some(match event.kind.as_ref()? {
                Event::Activity(a) => format!("activity:{}/{}", a.app, a.tool),
                Event::Cards(c) => format!("cards:{}", c.cards.len()),
                Event::Answer(_) => "answer".to_owned(),
                Event::Failed(f) => format!("failed:{}", f.reason),
                Event::Token(_) => "token".to_owned(),
                Event::Reading(_) => "reading".to_owned(),
                Event::Pending(p) => format!("pending:{}", p.steps.len()),
            })
        })
        .collect()
}

fn thread(sample: &common::chat::Sample, id: &str) -> wire::ChatThread {
    let answer = sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                query: Some(wire::app_query_request::Query::ChatThread(
                    wire::ChatThreadRequest {
                        thread_id: id.to_owned(),
                    },
                )),
            })),
        })
        .expect("an app query answers");
    match answer.kind {
        Some(wire::response::Kind::AppQuery(answer)) => match answer.answer {
            Some(wire::app_query_response::Answer::ChatThread(found)) => found,
            other => panic!("{other:?}"),
        },
        other => panic!("{other:?}"),
    }
}

/// `(title, status)` of every task row, through the same door the runtime reads.
fn tasks(sample: &common::chat::Sample) -> Vec<(String, String)> {
    use centraid_assist::native::Door as _;
    use centraid_assist::native::door::text;
    sample
        .handle
        .assist_door()
        .table(
            "schedule_task",
            "task_id, title, status",
            "task_id",
            "task_id",
        )
        .expect("the tasks read")
        .iter()
        .map(|row| {
            (
                text(row, "title").unwrap_or_default(),
                text(row, "status").unwrap_or_default(),
            )
        })
        .collect()
}

fn status_of(sample: &common::chat::Sample, title: &str) -> String {
    tasks(sample)
        .into_iter()
        .find(|(name, _)| name == title)
        .map(|(_, status)| status)
        .expect("the task is there")
}

/// The tables the change events on the queue name: what a screen would have been told. Assist
/// events are drained along with them.
fn changes_on_the_queue(sample: &common::chat::Sample) -> Vec<String> {
    let mut tables = Vec::new();
    while let Ok(Some(event)) = sample
        .handle
        .next_event(std::time::Duration::from_millis(1))
    {
        if let Some(wire::event::Kind::Change(change)) = event.kind {
            tables.push(change.table);
        }
    }
    tables
}

fn send_regenerate(sample: &common::chat::Sample, session: u64, turn: u64) -> wire::AssistSent {
    match sample
        .assist(Ask::Send(wire::AssistSendRequest {
            session_id: session,
            text: String::new(),
            tz: common::chat::TZ.to_owned(),
            regenerate: true,
            turn_id: turn,
            ..wire::AssistSendRequest::default()
        }))
        .expect("a retry answers")
        .kind
    {
        Some(wire::assist_response::Kind::Sent(sent)) => sent,
        other => panic!("{other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 1. A read turn
// ---------------------------------------------------------------------------

#[test]
fn a_read_turn_finds_then_answers_with_its_events_in_order_its_cards_mapped_and_its_line_composed()
{
    let model = script(&read_tasks());
    let sample = native_sample(model.clone());
    let session = sample.start("");
    let sent = sample.send(session, 1, "what tasks do I have?");

    let answer = answered(&sent);
    assert_eq!(answer.text, FOUND_TASKS);
    assert_eq!(answer.cards.len(), 6, "a screenful, not the list");
    let first = &answer.cards[0];
    assert_eq!(
        (first.app.as_str(), first.entity.as_str()),
        ("tasks", "task")
    );
    assert_eq!(first.title, "Rotate the tires before the drive");
    assert!(answer.cards.iter().all(|card| card.app == "tasks"));

    // THE EVENTS, in order: one Activity per looking step, the cards, then the answer. The same
    // queue and the same wire the routed plane uses.
    let events = sample.drain_assist_events();
    assert_eq!(
        story(&events),
        [
            "activity:tasks/find",
            "activity:tasks/answer",
            "cards:6",
            "answer"
        ]
    );
    assert!(
        events
            .iter()
            .all(|e| e.session_id == session && e.turn_id == 1)
    );

    // THE MODEL READ A CONVERSATION: two generations a step (the think, then the call), each from
    // the system turn, the user turn and what came before, ending where the model begins.
    let prompts = model.prompts();
    assert_eq!(prompts.len(), 4);
    assert!(prompts[0].starts_with("<|im_start|>system\n# Tools"));
    assert!(prompts[0].ends_with(
        "<|im_start|>user\nwhat tasks do I have?<|im_end|>\n<|im_start|>assistant\n<think>\n"
    ));
    assert!(prompts[2].contains("<tool_response>\n@1 · 12 tasks"));
    assert!(prompts[2].contains("plan: look"), "thinking is kept");
    assert!(prompts[2].ends_with("<|im_start|>assistant\n<think>\n"));

    // SAVED as every turn is, through `chat.save_turn`, in the shape the stored record has always
    // had: a question, an answer with its cards. There is no routing record to keep.
    let stored = thread(&sample, &sent.thread_id);
    assert_eq!(stored.messages.len(), 2);
    assert_eq!(stored.messages[1].text, FOUND_TASKS);
    assert_eq!(stored.messages[1].cards.len(), 6);
    assert_eq!(
        stored.messages[1].outcome,
        wire::ChatStoredOutcome::Answered as i32
    );
}

#[test]
fn a_follow_up_in_the_same_chat_reads_the_conversation_so_far() {
    let model = script(&[
        read_tasks()[0].clone(),
        read_tasks()[1].clone(),
        step("plan: narrow", "answer", &[("rows", "#10")]),
    ]);
    let sample = native_sample(model.clone());
    let session = sample.start("");
    let first = sample.send(session, 1, "what tasks do I have?");
    assert_eq!(answered(&first).text, FOUND_TASKS);
    let second = sample.send(session, 2, "the third one");
    let answer = answered(&second);
    assert_eq!(answer.text, "Found 1 task.");
    assert_eq!(answer.cards[0].title, "Pick up the dry cleaning");

    // The second turn's prompt holds the first turn whole: the session is kept between turns.
    let last = model.prompts().pop().unwrap();
    assert!(last.contains("what tasks do I have?"));
    assert!(last.contains("<tool_response>\n@1 · 12 tasks"));
    assert!(last.contains("the third one"));
    assert_eq!(second.thread_id, first.thread_id, "one chat, one thread");
}

#[test]
fn every_kind_is_drawn_as_a_card_of_one_of_the_seven_apps_and_the_homeless_ones_open_their_apps_home()
 {
    // One `answer kind=…` turn each, in one chat. (app, entity) per kind, from the kind table.
    let kinds = [
        ("person", "people", "person"),
        ("group", "tally", "group"),
        ("event", "agenda", "event"),
        ("album", "photos", "album"),
        ("notebook", "notes", "notebook"),
        ("folder", "docs", "folder"),
        ("list", "tasks", "project"),
        ("note", "notes", "note"),
        ("document", "docs", "document"),
        ("photo", "photos", "photo"),
    ];
    let steps: Vec<[String; 2]> = kinds
        .iter()
        .map(|(kind, _, _)| step("plan: answer", "answer", &[("kind", kind)]))
        .collect();
    let sample = native_sample(script(&steps));
    let session = sample.start("");
    for (at, (kind, app, entity)) in kinds.iter().enumerate() {
        let sent = sample.send(session, at as u64 + 1, &format!("show my {kind}s"));
        let answer = answered(&sent);
        assert!(!answer.cards.is_empty(), "{kind}: {answer:?}");
        for card in &answer.cards {
            assert_eq!(
                (card.app.as_str(), card.entity.as_str()),
                (*app, *entity),
                "{kind}"
            );
            assert!(!card.id.is_empty() && !card.title.is_empty(), "{kind}");
        }
        // and the stored record takes the card: the schema's CHECK on `app` is the seven apps
        let stored = thread(&sample, &sent.thread_id);
        assert_eq!(
            stored.messages.last().unwrap().cards.len(),
            answer.cards.len(),
            "{kind} is saved with its cards"
        );
    }
}

// ---------------------------------------------------------------------------
// 2. Every other way a turn ends
// ---------------------------------------------------------------------------

#[test]
fn a_decline_is_a_composed_line_with_no_cards_and_no_activity() {
    let model = script(&[step("plan: no", "decline", &[("reason", "out_of_scope")])]);
    let sample = native_sample(model);
    let session = sample.start("");
    let sent = sample.send(session, 1, "what is the capital of France?");
    let answer = answered(&sent);
    assert_eq!(answer.text, "Outside what chat can do here.");
    assert!(answer.cards.is_empty());
    assert_eq!(story(&sample.drain_assist_events()), ["answer"]);
}

#[test]
fn a_question_for_the_vault_that_finds_nothing_says_so() {
    let model = script(&[step(
        "plan: answer",
        "answer",
        &[("kind", "task"), ("name", "zzyzx")],
    )]);
    let sample = native_sample(model);
    let session = sample.start("");
    let sent = sample.send(session, 1, "any zzyzx tasks?");
    let answer = answered(&sent);
    assert_eq!(answer.text, "Nothing found.");
    assert!(answer.cards.is_empty());
}

#[test]
fn an_ask_for_a_secret_is_declined_sealed_egress_and_reads_no_locker() {
    // Two ways the model can reach for the Locker: look at its kind, or reveal a field.
    for (tool, args) in [
        ("find", vec![("kind", "locker_item")]),
        (
            "act",
            vec![
                ("verb", "reveal"),
                ("kind", "locker_item"),
                ("args", "field: password"),
            ],
        ),
    ] {
        let model = script(&[step("plan: secret", tool, &args)]);
        let sample = native_sample(model.clone());
        let session = sample.start("");
        let sent = sample.send(session, 1, "what is my wifi password?");
        let answer = answered(&sent);
        assert_eq!(
            answer.text, "Secrets stay in Locker. Chat does not read or send them.",
            "{tool}"
        );
        assert!(answer.cards.is_empty());
        // the Locker is the true reason, not "writes are off": no Activity either
        assert_eq!(story(&sample.drain_assist_events()), ["answer"], "{tool}");
        // and no item of the Locker was in front of the model: the world holds none
        let prompt = &model.prompts()[0];
        assert!(!prompt.contains("locker items:"), "{tool}");
    }
}

const DRY_CLEANING: &str = "Pick up the dry cleaning";

/// Look for the dry cleaning, then complete it: a write in two steps, the first a read.
fn complete_dry_cleaning() -> Vec<[String; 2]> {
    vec![
        step(
            "plan: look",
            "find",
            &[("kind", "task"), ("name", "dry cleaning")],
        ),
        step(
            "plan: write",
            "act",
            &[("verb", "complete"), ("rows", "@1")],
        ),
    ]
}

fn pending_of(
    sample: &common::chat::Sample,
    session: u64,
) -> centraid_assist::native_turn::PendingCard {
    sample
        .handle
        .assist_pending(session)
        .expect("the chat exists")
        .expect("a write is waiting")
}

#[test]
fn a_write_parks_behind_a_card_and_nothing_is_written_until_the_member_taps() {
    let sample = native_sample(script(&complete_dry_cleaning()));
    let session = sample.start("");
    let _ = changes_on_the_queue(&sample); // what founding announced
    let before = tasks(&sample);
    let sent = sample.send(session, 1, "complete the dry cleaning task");

    // THE TURN ENDS IN A PROPOSAL, in words; the card rides beside it for the core to surface
    let answer = answered(&sent);
    assert_eq!(
        answer.text,
        format!("Proposed: Complete task \"{DRY_CLEANING}\"."),
        "said in the card's words, not the model's `#3 task` lines"
    );
    assert_eq!(
        story(&sample.drain_assist_events()),
        [
            "activity:tasks/find",
            "activity:tasks/act",
            "pending:1",
            "answer"
        ],
        "the card rides the stream just before the answer"
    );
    let card = pending_of(&sample, session);
    assert_eq!(card.verbs, ["complete"]);
    assert_eq!(card.commands, ["schedule.set_task_status"]);
    assert!(!card.destructive);

    // NOTHING HAS TOUCHED THE VAULT: no row moved and no screen was told
    assert_eq!(tasks(&sample), before);
    assert_eq!(status_of(&sample, DRY_CLEANING), "needs-action");
    assert!(
        changes_on_the_queue(&sample)
            .iter()
            .all(|table| table.starts_with("chat_") || table.starts_with("core_")),
        "no app table was touched by planning"
    );

    // THE TAP WRITES, through the door, and the change feed names the table
    let tapped = sample
        .handle
        .assist_confirm(session, &card.id)
        .expect("a confirm answers");
    assert!(
        matches!(tapped.outcome, Confirmed::Done { steps: 1, .. }),
        "{tapped:?}"
    );
    assert_eq!(tapped.line, "Done.");
    assert_eq!(status_of(&sample, DRY_CLEANING), "completed");
    let tables = changes_on_the_queue(&sample);
    assert!(
        tables.iter().any(|table| table == "schedule_task"),
        "{tables:?}"
    );

    // THE SAME CARD TAPPED AGAIN writes nothing: it answers what it answered, and no screen is told
    let again = sample
        .handle
        .assist_confirm(session, &card.id)
        .expect("a second confirm answers");
    assert_eq!(again, tapped);
    assert!(changes_on_the_queue(&sample).is_empty());
    assert_eq!(
        tasks(&sample)
            .iter()
            .filter(|(_, status)| status == "completed")
            .count(),
        before
            .iter()
            .filter(|(_, status)| status == "completed")
            .count()
            + 1
    );
}

#[test]
fn a_dismissed_card_writes_nothing_and_cannot_be_confirmed_afterwards() {
    let sample = native_sample(script(&complete_dry_cleaning()));
    let session = sample.start("");
    sample.send(session, 1, "complete the dry cleaning task");
    let card = pending_of(&sample, session);
    let before = tasks(&sample);
    let _ = changes_on_the_queue(&sample);

    assert!(sample.handle.assist_dismiss(session, &card.id).unwrap());
    assert_eq!(tasks(&sample), before);
    assert!(sample.handle.assist_pending(session).unwrap().is_none());
    let late = sample.handle.assist_confirm(session, &card.id).unwrap();
    assert_eq!(late.outcome, Confirmed::Unknown);
    assert_eq!(late.line, "Nothing is waiting on that.");
    assert_eq!(tasks(&sample), before);
    assert!(
        changes_on_the_queue(&sample)
            .iter()
            .all(|table| !table.starts_with("schedule_")),
        "a dismissal tells no screen anything"
    );
    // and a card that was never made is nobody's
    assert!(
        !sample
            .handle
            .assist_dismiss(session, "no-such-card")
            .unwrap()
    );
}

#[test]
fn a_new_message_dismisses_the_card_that_was_waiting() {
    let mut steps = complete_dry_cleaning();
    steps.push(step("plan: no", "decline", &[("reason", "out_of_scope")]));
    let sample = native_sample(script(&steps));
    let session = sample.start("");
    sample.send(session, 1, "complete the dry cleaning task");
    let card = pending_of(&sample, session);
    sample.send(session, 2, "never mind, what is the capital of France");
    assert!(sample.handle.assist_pending(session).unwrap().is_none());
    assert_eq!(
        sample
            .handle
            .assist_confirm(session, &card.id)
            .unwrap()
            .outcome,
        Confirmed::Unknown
    );
    assert_eq!(status_of(&sample, DRY_CLEANING), "needs-action");
}

#[test]
fn a_card_whose_row_changed_since_it_was_planned_is_stale_and_writes_nothing() {
    let sample = native_sample(script(&complete_dry_cleaning()));
    let session = sample.start("");
    sample.send(session, 1, "complete the dry cleaning task");
    let card = pending_of(&sample, session);

    // a screen edits that very task while the card waits
    use centraid_assist::native::Door as _;
    let id = {
        use centraid_assist::native::door::text;
        sample
            .handle
            .assist_door()
            .table("schedule_task", "task_id, title", "task_id", "task_id")
            .unwrap()
            .iter()
            .find(|row| text(row, "title").as_deref() == Some(DRY_CLEANING))
            .and_then(|row| text(row, "task_id"))
            .unwrap()
    };
    let edit = sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Command(wire::Command {
                name: "schedule.edit_task".to_owned(),
                input: serde_json::to_vec(&serde_json::json!({"task_id": id, "priority": 1}))
                    .unwrap(),
                invoke_key: "test:edit-task".to_owned(),
                ..wire::Command::default()
            })),
        })
        .expect("the edit runs");
    assert!(matches!(edit.kind, Some(wire::response::Kind::Command(_))));
    let _ = changes_on_the_queue(&sample);

    let tapped = sample.handle.assist_confirm(session, &card.id).unwrap();
    assert!(
        matches!(&tapped.outcome, Confirmed::Stale { rows } if rows.iter().any(|r| r.contains("dry cleaning"))),
        "{tapped:?}"
    );
    assert_eq!(tapped.line, "That changed since. Ask again.");
    assert_eq!(status_of(&sample, DRY_CLEANING), "needs-action");
    assert!(
        changes_on_the_queue(&sample)
            .iter()
            .all(|table| !table.starts_with("schedule_")),
        "a stale card wrote nothing"
    );
}

#[test]
fn a_chain_of_two_writes_parks_as_one_card_and_a_tap_makes_both() {
    let sample = native_sample(script(&[
        step(
            "plan: first",
            "act",
            &[
                ("verb", "complete"),
                ("kind", "task"),
                ("name", "dry cleaning"),
                ("more", "true"),
            ],
        ),
        step(
            "plan: second",
            "act",
            &[
                ("verb", "complete"),
                ("kind", "task"),
                ("name", "Rotate the tires"),
            ],
        ),
    ]));
    let session = sample.start("");
    let before = tasks(&sample);
    sample.send(session, 1, "complete the dry cleaning and the tires");
    let card = pending_of(&sample, session);
    assert_eq!(card.verbs, ["complete", "complete"]);
    assert_eq!(card.commands.len(), 2);
    assert_eq!(tasks(&sample), before, "planning wrote nothing");

    let tapped = sample.handle.assist_confirm(session, &card.id).unwrap();
    assert!(
        matches!(tapped.outcome, Confirmed::Done { steps: 2, .. }),
        "{tapped:?}"
    );
    assert_eq!(status_of(&sample, DRY_CLEANING), "completed");
    assert_eq!(
        status_of(&sample, "Rotate the tires before the drive"),
        "completed"
    );
}

#[test]
fn a_confirmed_write_is_seen_by_the_next_question_in_the_same_chat() {
    let sample = native_sample(script(&[
        step(
            "plan: look",
            "find",
            &[("kind", "task"), ("name", "dry cleaning")],
        ),
        step(
            "plan: write",
            "act",
            &[("verb", "complete"), ("rows", "@1")],
        ),
        step(
            "plan: ask again",
            "answer",
            &[
                ("kind", "task"),
                ("where", "status = \"completed\""),
                ("name", "dry cleaning"),
            ],
        ),
    ]));
    let session = sample.start("");
    sample.send(session, 1, "complete the dry cleaning task");
    let card = pending_of(&sample, session);
    sample.handle.assist_confirm(session, &card.id).unwrap();
    let sent = sample.send(session, 2, "is it done?");
    let answer = answered(&sent);
    assert_eq!(answer.text, "Found 1 task.", "{answer:?}");
    assert_eq!(answer.cards[0].title, DRY_CLEANING);
    assert_eq!(answer.cards[0].meta, "completed");
}

#[test]
fn a_busy_chat_cannot_be_tapped() {
    let sample = native_sample(script(&complete_dry_cleaning()));
    let session = sample.start("");
    sample.send(session, 1, "complete the dry cleaning task");
    let card = pending_of(&sample, session);
    assert!(
        sample
            .handle
            .assist_confirm(session + 99, &card.id)
            .is_err()
    );
}

// ---------------------------------------------------------------------------
// 1b. The card on the wire (#1088, wave 2c)
// ---------------------------------------------------------------------------

fn tap(sample: &common::chat::Sample, session: u64, pending_id: &str) -> wire::AssistSettled {
    match sample
        .assist(Ask::Confirm(wire::AssistConfirmRequest {
            session_id: session,
            pending_id: pending_id.to_owned(),
        }))
        .expect("a confirm answers")
        .kind
    {
        Some(wire::assist_response::Kind::Settled(settled)) => settled,
        other => panic!("a confirm answered {other:?}"),
    }
}

fn cancel_tap(
    sample: &common::chat::Sample,
    session: u64,
    pending_id: &str,
) -> wire::AssistSettled {
    match sample
        .assist(Ask::Dismiss(wire::AssistDismissRequest {
            session_id: session,
            pending_id: pending_id.to_owned(),
        }))
        .expect("a dismiss answers")
        .kind
    {
        Some(wire::assist_response::Kind::Settled(settled)) => settled,
        other => panic!("a dismiss answered {other:?}"),
    }
}

/// The `pending` event of a turn's events, if it sent one.
fn pending_event(events: &[wire::AssistEvent]) -> Option<&wire::AssistPending> {
    events.iter().find_map(|event| match event.kind.as_ref()? {
        Event::Pending(card) => Some(card),
        _ => None,
    })
}

#[test]
fn a_parked_write_is_a_pending_event_before_the_answer_and_the_answer_carries_the_same_card() {
    let sample = native_sample(script(&complete_dry_cleaning()));
    let session = sample.start("");
    let sent = sample.send(session, 1, "complete the dry cleaning task");
    let events = sample.drain_assist_events();
    let streamed = pending_event(&events).expect("the card is on the stream");

    // THE CARD IS THE RUNTIME'S FACTS IN THE CHAT'S WORDS, not the model's text
    let waiting = pending_of(&sample, session);
    assert_eq!(streamed.pending_id, waiting.id);
    assert_eq!(streamed.verbs, ["complete"]);
    assert!(!streamed.destructive);
    assert_eq!(streamed.more, 0);
    assert_eq!(streamed.steps.len(), 1);
    let step = &streamed.steps[0];
    assert_eq!(
        (step.verb.as_str(), step.kind.as_str(), step.title.as_str()),
        ("complete", "task", DRY_CLEANING)
    );
    assert_eq!(step.summary, format!("Complete task \"{DRY_CLEANING}\""));
    assert!(!step.destructive);
    for text in std::iter::once(&step.summary).chain(&streamed.verbs) {
        assert!(
            !text.contains('#'),
            "the model's `#n` handles stay home: {text}"
        );
    }

    // THE ANSWER IS THE RELIABLE CARRIER: the response and its terminal event hold the same card
    let from_response = answered(&sent)
        .pending
        .as_ref()
        .expect("the response has it");
    assert_eq!(from_response, streamed);
    let from_event = events
        .iter()
        .find_map(|event| match event.kind.as_ref()? {
            Event::Answer(answer) => answer.pending.as_ref(),
            _ => None,
        })
        .expect("the answer event has it");
    assert_eq!(from_event, streamed);
}

#[test]
fn a_turn_that_wrote_nothing_has_no_card_on_the_stream_or_in_the_answer() {
    let sample = native_sample(script(&read_tasks()));
    let session = sample.start("");
    let sent = sample.send(session, 1, "what tasks do I have");
    let events = sample.drain_assist_events();
    assert!(pending_event(&events).is_none());
    assert!(answered(&sent).pending.is_none());
}

#[test]
fn a_confirm_request_writes_once_and_answers_how_it_ended_and_the_line() {
    let sample = native_sample(script(&complete_dry_cleaning()));
    let session = sample.start("");
    sample.send(session, 1, "complete the dry cleaning task");
    let card = pending_of(&sample, session);
    let _ = changes_on_the_queue(&sample);

    let tapped = tap(&sample, session, &card.id);
    assert_eq!(tapped.session_id, session);
    assert_eq!(tapped.pending_id, card.id);
    assert_eq!(tapped.outcome, wire::AssistSettleOutcome::Applied as i32);
    assert_eq!(tapped.line, "Done.");
    assert_eq!(status_of(&sample, DRY_CLEANING), "completed");
    assert!(
        changes_on_the_queue(&sample)
            .iter()
            .any(|table| table == "schedule_task"),
        "the change feed names the table a screen reads"
    );

    // THE SAME TAP AGAIN WRITES NOTHING and answers what it answered
    assert_eq!(tap(&sample, session, &card.id), tapped);
    assert!(changes_on_the_queue(&sample).is_empty());
    assert_eq!(
        tasks(&sample)
            .iter()
            .filter(|(_, status)| status == "completed")
            .count(),
        1 + tasks(&sample)
            .iter()
            .filter(|(title, status)| status == "completed" && title != DRY_CLEANING)
            .count()
    );
}

#[test]
fn a_dismiss_request_writes_nothing_and_what_it_dismissed_cannot_be_tapped_after() {
    let sample = native_sample(script(&complete_dry_cleaning()));
    let session = sample.start("");
    sample.send(session, 1, "complete the dry cleaning task");
    let card = pending_of(&sample, session);
    let before = tasks(&sample);
    let _ = changes_on_the_queue(&sample);

    let dismissed = cancel_tap(&sample, session, &card.id);
    assert_eq!(
        dismissed.outcome,
        wire::AssistSettleOutcome::Dismissed as i32
    );
    assert_eq!(dismissed.pending_id, card.id);
    assert_eq!(dismissed.line, "Not done.");
    assert_eq!(tasks(&sample), before);
    assert!(
        changes_on_the_queue(&sample)
            .iter()
            .all(|table| !table.starts_with("schedule_")),
        "a dismissal tells no screen anything"
    );

    // a tap after it, and a second dismissal, find nothing waiting
    let late = tap(&sample, session, &card.id);
    assert_eq!(
        late.outcome,
        wire::AssistSettleOutcome::NothingWaiting as i32
    );
    assert_eq!(late.line, "Nothing is waiting on that.");
    let again = cancel_tap(&sample, session, &card.id);
    assert_eq!(
        again.outcome,
        wire::AssistSettleOutcome::NothingWaiting as i32
    );
    assert_eq!(again.line, "Nothing is waiting on that.");
    assert_eq!(tasks(&sample), before);
}

#[test]
fn a_card_that_never_was_is_nothing_waiting_and_an_unknown_chat_is_the_requests_fault() {
    let sample = native_sample(script(&complete_dry_cleaning()));
    let session = sample.start("");
    let before = tasks(&sample);

    // a chat that has not run a native turn yet has no card to tap
    let none = tap(&sample, session, "no-such-card");
    assert_eq!(
        none.outcome,
        wire::AssistSettleOutcome::NothingWaiting as i32
    );
    assert_eq!(none.line, "Nothing is waiting on that.");

    // and a card waiting is not the one a stale id names
    sample.send(session, 1, "complete the dry cleaning task");
    let card = pending_of(&sample, session);
    let wrong = tap(&sample, session, "no-such-card");
    assert_eq!(
        wrong.outcome,
        wire::AssistSettleOutcome::NothingWaiting as i32
    );
    assert_eq!(
        cancel_tap(&sample, session, "no-such-card").outcome,
        wire::AssistSettleOutcome::NothingWaiting as i32
    );
    assert_eq!(tasks(&sample), before, "nothing was written");
    assert_eq!(
        sample.handle.assist_pending(session).unwrap().map(|c| c.id),
        Some(card.id),
        "a tap on the wrong id leaves the card waiting"
    );

    // a chat this handle does not hold is the request's fault, as for every other kind
    for request in [
        Ask::Confirm(wire::AssistConfirmRequest {
            session_id: session + 99,
            pending_id: "x".to_owned(),
        }),
        Ask::Dismiss(wire::AssistDismissRequest {
            session_id: session + 99,
            pending_id: "x".to_owned(),
        }),
    ] {
        assert!(matches!(
            sample.assist(request),
            Err(centraid_core::CoreError::InvalidRequest { .. })
        ));
    }
}

#[test]
fn a_card_whose_row_moved_answers_stale_over_the_wire_and_writes_nothing() {
    let sample = native_sample(script(&complete_dry_cleaning()));
    let session = sample.start("");
    sample.send(session, 1, "complete the dry cleaning task");
    let card = pending_of(&sample, session);
    let id = {
        use centraid_assist::native::Door as _;
        use centraid_assist::native::door::text;
        sample
            .handle
            .assist_door()
            .table("schedule_task", "task_id, title", "task_id", "task_id")
            .unwrap()
            .iter()
            .find(|row| text(row, "title").as_deref() == Some(DRY_CLEANING))
            .and_then(|row| text(row, "task_id"))
            .unwrap()
    };
    sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Command(wire::Command {
                name: "schedule.edit_task".to_owned(),
                input: serde_json::to_vec(&serde_json::json!({"task_id": id, "priority": 1}))
                    .unwrap(),
                invoke_key: "test:edit-task-wire".to_owned(),
                ..wire::Command::default()
            })),
        })
        .expect("the edit runs");
    let _ = changes_on_the_queue(&sample);

    let tapped = tap(&sample, session, &card.id);
    assert_eq!(tapped.outcome, wire::AssistSettleOutcome::Stale as i32);
    assert_eq!(tapped.line, "That changed since. Ask again.");
    assert_eq!(status_of(&sample, DRY_CLEANING), "needs-action");
    assert!(
        changes_on_the_queue(&sample)
            .iter()
            .all(|table| !table.starts_with("schedule_")),
        "a stale card wrote nothing"
    );
}

#[test]
fn a_chain_is_one_card_with_a_line_for_each_row_and_a_delete_asks_twice() {
    let sample = native_sample(script(&[
        step(
            "plan: first",
            "act",
            &[
                ("verb", "complete"),
                ("kind", "task"),
                ("name", "dry cleaning"),
                ("more", "true"),
            ],
        ),
        step(
            "plan: second",
            "act",
            &[
                ("verb", "delete"),
                ("kind", "task"),
                ("name", "Rotate the tires"),
            ],
        ),
    ]));
    let session = sample.start("");
    let sent = sample.send(session, 1, "complete the dry cleaning and delete the tires");
    assert_eq!(
        answered(&sent).text,
        "Proposed: Complete task \"Pick up the dry cleaning\"; \
         Delete task \"Rotate the tires before the drive\"."
    );
    let card = answered(&sent).pending.as_ref().expect("a card");
    assert_eq!(card.verbs, ["complete", "delete"]);
    assert!(
        card.destructive,
        "a delete in the chain makes the card ask twice"
    );
    let lines: Vec<(&str, bool)> = card
        .steps
        .iter()
        .map(|step| (step.summary.as_str(), step.destructive))
        .collect();
    assert_eq!(
        lines,
        [
            ("Complete task \"Pick up the dry cleaning\"", false),
            ("Delete task \"Rotate the tires before the drive\"", true),
        ]
    );
}

#[test]
fn a_stop_between_steps_ends_the_turn_and_costs_the_model_no_further_call() {
    /// Sets the stop flag once the Nth generation is done, as a Stop tap landing between steps.
    struct StopAfter {
        inner: Arc<ScriptedModel>,
        after: usize,
        calls: AtomicUsize,
    }
    impl Model for StopAfter {
        fn generate(
            &self,
            request: &GenerateRequest<'_>,
            on_token: &mut dyn FnMut(&str) -> Control,
        ) -> Result<Generation, ModelError> {
            let out = self.inner.generate(request, on_token)?;
            if self.calls.fetch_add(1, Ordering::SeqCst) + 1 == self.after {
                request.cancel.cancel();
            }
            Ok(out)
        }
    }
    let inner = script(&read_tasks());
    let sample = native_sample(Arc::new(StopAfter {
        inner: inner.clone(),
        after: 2, // the think and the call of step one
        calls: AtomicUsize::new(0),
    }));
    let session = sample.start("");
    let sent = sample.send(session, 1, "what tasks do I have?");

    let cancelled = wire::AssistRefusalReason::Cancelled as i32;
    assert_eq!(refusal_of(&sent), cancelled);
    assert_eq!(
        inner.prompts().len(),
        2,
        "the second step was never asked for"
    );
    let events = story(&sample.drain_assist_events());
    assert_eq!(events.last().unwrap(), &format!("failed:{cancelled}"));
    assert!(
        !events
            .iter()
            .any(|e| e.starts_with("cards") || e == "answer")
    );
    // saved as a stop, like any stopped turn
    let stored = thread(&sample, &sent.thread_id);
    assert_eq!(
        stored.messages[1].outcome,
        wire::ChatStoredOutcome::Stopped as i32
    );
    // and the chat is not wedged: a next question starts a clean session and is answered
    sample.install(script(&read_tasks()));
    let next = sample.send(session, 2, "what tasks do I have?");
    assert_eq!(answered(&next).text, FOUND_TASKS);
}

#[test]
fn an_engine_that_fails_mid_turn_is_a_typed_refusal() {
    // one step, then the script is spent
    let sample = native_sample(script(&[step("plan: look", "find", &[("kind", "task")])]));
    let session = sample.start("");
    let sent = sample.send(session, 1, "what tasks do I have?");
    assert_eq!(
        refusal_of(&sent),
        wire::AssistRefusalReason::ModelFailed as i32
    );
}

fn send_in(
    sample: &common::chat::Sample,
    session: u64,
    turn: u64,
    text: &str,
    tz: &str,
) -> wire::AssistSent {
    match sample
        .assist(Ask::Send(wire::AssistSendRequest {
            session_id: session,
            text: text.to_owned(),
            tz: tz.to_owned(),
            turn_id: turn,
            ..wire::AssistSendRequest::default()
        }))
        .expect("a send answers")
        .kind
    {
        Some(wire::assist_response::Kind::Sent(sent)) => sent,
        other => panic!("{other:?}"),
    }
}

/// `YYYY-MM-DD` of a day count since 1970-01-01 (Hinnant's civil-from-days).
fn ymd(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// The wall time the chat reads for an event stored at 22:30 UTC two days from now, asked about in
/// a zone. (The sample's own events are floating, which no zone moves.)
fn night_call_in(tz: &str) -> (String, String) {
    use centraid_assist::native::Door as _;
    use centraid_assist::native::door::text;
    let sample = native_sample(script(&[
        step(
            "plan: look",
            "find",
            &[("kind", "event"), ("name", "Night call")],
        ),
        step("plan: answer", "answer", &[("rows", "@1")]),
    ]));
    let door = sample.handle.assist_door();
    let calendar = text(
        &door
            .table(
                "schedule_calendar",
                "calendar_id, created_at",
                "created_at",
                "calendar_id",
            )
            .unwrap()[0],
        "calendar_id",
    )
    .unwrap();
    let day = ymd(door.now_ms().div_euclid(86_400_000) + 2);
    let proposed = sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Command(wire::Command {
                name: "schedule.propose_event".to_owned(),
                input: serde_json::to_vec(&serde_json::json!({
                    "summary": "Night call",
                    "dtstart": format!("{day}T22:30:00.000Z"),
                    "dtend": format!("{day}T23:30:00.000Z"),
                    "start_tz": "Etc/UTC",
                    "recurrence_semantics": "zoned",
                    "calendar_id": calendar,
                }))
                .unwrap(),
                invoke_key: "test:night-call".to_owned(),
                ..wire::Command::default()
            })),
        })
        .expect("the event is proposed");
    assert!(matches!(
        proposed.kind,
        Some(wire::response::Kind::Command(_))
    ));
    let session = sample.start("");
    let sent = send_in(&sample, session, 1, "when is the night call?", tz);
    let answer = answered(&sent);
    assert_eq!(answer.cards.len(), 1, "{answer:?}");
    (day, answer.cards[0].subtitle.clone())
}

#[test]
fn an_event_question_in_another_zone_is_answered_on_that_zones_days() {
    let (day, in_utc) = night_call_in("Etc/UTC");
    let (_, in_auckland) = night_call_in("Pacific/Auckland");
    // UTC: that evening, 22:30
    assert!(in_utc.ends_with(&format!("{day} 22:30")), "{in_utc}");
    // Auckland (UTC+13 in October): the next morning, 11:30 on the NEXT local day
    let next = ymd(days_of(&day) + 1);
    assert!(
        in_auckland.ends_with(&format!("{next} 11:30")),
        "{in_auckland} (day {day})"
    );
}

/// Days since 1970-01-01 of a `YYYY-MM-DD`.
fn days_of(day: &str) -> i64 {
    let mut parts = day.split('-').map(|part| part.parse::<i64>().unwrap());
    let (year, month, date) = (
        parts.next().unwrap(),
        parts.next().unwrap(),
        parts.next().unwrap(),
    );
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + date - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ---------------------------------------------------------------------------
// 3. Sessions: fresh, kept, and the path an attachment keeps
// ---------------------------------------------------------------------------

#[test]
fn a_reopened_thread_starts_a_fresh_session_and_the_stored_turns_stay_what_they_were() {
    let sample = native_sample(script(&read_tasks()));
    let session = sample.start("");
    let first = sample.send(session, 1, "what tasks do I have?");

    let model = script(&read_tasks());
    sample.install(model.clone());
    let reopened = match sample
        .assist(Ask::Start(wire::AssistStartRequest {
            app: String::new(),
            thread_id: first.thread_id.clone(),
        }))
        .expect("a stored chat reopens")
        .kind
    {
        Some(wire::assist_response::Kind::Started(started)) => started,
        other => panic!("{other:?}"),
    };
    let sent = sample.send(reopened.session_id, 2, "and again?");
    assert_eq!(answered(&sent).text, FOUND_TASKS);

    // THE MODEL SEES ONLY THE NEW QUESTION: no earlier turn, no earlier observation.
    let prompt = &model.prompts()[0];
    assert!(prompt.contains("and again?"));
    assert!(!prompt.contains("what tasks do I have?"));
    assert!(!prompt.contains("<tool_response>"));
    // and it saves into the same thread, after the turns already there
    assert_eq!(sent.thread_id, first.thread_id);
    assert_eq!(thread(&sample, &sent.thread_id).messages.len(), 4);
}

#[test]
fn a_session_keeps_the_conversation_across_a_screens_write_and_reads_what_the_screen_wrote() {
    let model = script(&[
        read_tasks()[0].clone(),
        read_tasks()[1].clone(),
        step("plan: lists", "answer", &[("kind", "list")]),
    ]);
    let sample = native_sample(model.clone());
    let session = sample.start("");
    sample.send(session, 1, "what tasks do I have?");

    // a screen writes (a command through the ABI) while the chat is open
    let ran = sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Command(wire::Command {
                name: "schedule.save_project".to_owned(),
                input: br#"{"name":"New list"}"#.to_vec(),
                invoke_key: "test:edit".to_owned(),
                ..wire::Command::default()
            })),
        })
        .expect("the command runs");
    assert!(matches!(ran.kind, Some(wire::response::Kind::Command(_))));

    // the next question is answered over the world as it is now, and the conversation is whole
    let sent = sample.send(session, 2, "which lists do I have?");
    let titles: Vec<&str> = answered(&sent)
        .cards
        .iter()
        .map(|card| card.title.as_str())
        .collect();
    assert!(titles.contains(&"New list"), "{titles:?}");
    let prompt = &model.prompts()[4];
    assert!(
        prompt.contains("what tasks do I have?"),
        "the session was kept"
    );
    assert!(prompt.contains("which lists do I have?"));
}

#[test]
fn a_retry_asks_the_question_again_in_a_fresh_session() {
    let model = script(&[
        read_tasks()[0].clone(),
        read_tasks()[1].clone(),
        read_tasks()[0].clone(),
        read_tasks()[1].clone(),
    ]);
    let sample = native_sample(model.clone());
    let session = sample.start("");
    let first = sample.send(session, 1, "what tasks do I have?");
    let retry = send_regenerate(&sample, session, 2);
    assert_eq!(answered(&retry).text, FOUND_TASKS);
    // the earlier attempt is not in what the model reads, and the stored turn was replaced
    assert_eq!(
        model.prompts()[4].matches("what tasks do I have?").count(),
        1
    );
    assert_eq!(retry.thread_id, first.thread_id);
    assert_eq!(thread(&sample, &retry.thread_id).messages.len(), 2);
}

#[test]
fn an_attachment_never_leaves_the_attached_path_whichever_plane_answers_the_rest() {
    let model = Arc::new(ScriptedModel::new(["It is about a trip."]));
    let sample = native_sample(model.clone());
    let documents = match sample
        .assist(Ask::Documents(wire::AssistDocumentsRequest { limit: 5 }))
        .unwrap()
        .kind
    {
        Some(wire::assist_response::Kind::Documents(listed)) => listed.documents,
        other => panic!("{other:?}"),
    };
    let doc = documents.first().expect("the sample holds a text document");
    let session = sample.start("");
    let sent = match sample
        .assist(Ask::Send(wire::AssistSendRequest {
            session_id: session,
            text: "summarise this".to_owned(),
            tz: common::chat::TZ.to_owned(),
            regenerate: false,
            turn_id: 1,
            attachments: vec![wire::AssistAttachment {
                kind: Some(wire::assist_attachment::Kind::VaultDoc(
                    wire::AssistVaultDoc {
                        doc_id: doc.doc_id.clone(),
                    },
                )),
                label: doc.title.clone(),
            }],
        }))
        .unwrap()
        .kind
    {
        Some(wire::assist_response::Kind::Sent(sent)) => sent,
        other => panic!("{other:?}"),
    };
    assert_eq!(answered(&sent).text, "It is about a trip.");
    // ONE generation, no tools in its prompt: the attached path, not a step loop
    let prompts = model.prompts();
    assert_eq!(prompts.len(), 1);
    assert!(!prompts[0].contains("<tools>"));
    // and its events are the attached path's: the reading marker first, then words, then the answer
    let story = story(&sample.drain_assist_events());
    assert_eq!(story.first().map(String::as_str), Some("reading"));
    assert_eq!(story.last().map(String::as_str), Some("answer"));
    assert!(!story.iter().any(|word| word.starts_with("activity")));
}

// ---------------------------------------------------------------------------
// 4. The routed plane stays the default, and the context the prompt takes
// ---------------------------------------------------------------------------

#[test]
fn the_routed_plane_is_the_default_and_the_native_one_is_a_choice_the_core_makes() {
    let sample = common::chat::sample();
    assert_eq!(sample.handle.assist().plane(), PlaneKind::Routed);
    sample.handle.assist().use_plane(PlaneKind::Native);
    assert_eq!(sample.handle.assist().plane(), PlaneKind::Native);
}

/// THE MEASUREMENT (D14): how much of the engine's 4096 tokens a three-turn conversation takes.
/// The estimate is the plane's own pessimistic count (`prompt::estimate_tokens`), so the real
/// tokenizer reads fewer. With `ASSIST_NATIVE_DUMP=<dir>` the test writes every prompt it sent to
/// `<dir>/prompt-N.txt`, to count with the model's own `tokenizer.json`: on the sample vault the
/// twelve prompts read 1342 to 2960 Qwen3.5 tokens (the estimate: 1803 to 4095), the system turn
/// alone 1326 (estimate 1774). The test asserts none of it, because the context is measured before
/// it is changed (R-1088-10), not pinned.
#[test]
fn the_prompt_of_a_three_turn_conversation_against_the_engines_context() {
    let model = script(&[
        step("plan: look", "find", &[("kind", "task")]),
        step("plan: answer", "answer", &[("rows", "@1")]),
        step("plan: look", "find", &[("kind", "person")]),
        step("plan: answer", "answer", &[("rows", "@2")]),
        step("plan: look", "find", &[("kind", "event")]),
        step("plan: answer", "answer", &[("rows", "@3")]),
    ]);
    let sample = native_sample(model.clone());
    let session = sample.start("");
    for (at, question) in [
        "what tasks do I have?",
        "who are my people?",
        "what is on my calendar?",
    ]
    .iter()
    .enumerate()
    {
        let sent = sample.send(session, at as u64 + 1, question);
        answered(&sent);
    }
    let prompts = model.prompts();
    // the prompt each step's first generation reads (the call's is the same plus the think)
    let tokens: Vec<u32> = prompts
        .iter()
        .step_by(2)
        .map(|p| estimate_tokens(p))
        .collect();
    let system = estimate_tokens(prompts[0].split("<|im_start|>user").next().unwrap());
    let longest = prompts.iter().map(|p| estimate_tokens(p)).max().unwrap();
    println!("CONTEXT system turn (kind card, tools, directory): {system} tokens");
    println!("CONTEXT prompt at each of the six steps: {tokens:?}");
    println!(
        "CONTEXT longest prompt of 3 turns: {longest} tokens (engine context 4096, plan window 2048)"
    );
    assert!(system > 500, "the system turn is the bulk of it");
    if let Ok(dir) = std::env::var("ASSIST_NATIVE_DUMP") {
        for (at, prompt) in prompts.iter().enumerate() {
            std::fs::write(format!("{dir}/prompt-{at}.txt"), prompt).unwrap();
        }
    }
}
