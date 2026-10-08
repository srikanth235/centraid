//! A PROPOSAL'S STORED LIFE THROUGH THE DOOR A SHELL USES (#1088, rung twelve): a native turn that
//! parks a write is saved `proposed`, and the member's tap settles the saved message.
//!
//! What a shell relies on and cannot check for itself: a reopened thread reads the settled line and
//! not a question the member had already answered. The tests read the vault's own stored thread
//! (`Vault::chat_thread`), because that is the truth the wire's `ChatThread` is drawn from.
//!
//! * a turn that parks is saved `proposed`, with the proposal's own words and its cards;
//! * a confirm settles it `applied` and a dismissal `dismissed`, each with the line the member was
//!   told; a card whose row changed settles `stale`;
//! * a card tapped twice settles once;
//! * a thread reopened reads the settled card, holds no pending write, and a tap on the old card
//!   from the new session records nothing;
//! * a proposal nobody answered is `proposed` until the next turn saved into its thread dismisses it,
//!   whether that turn is typed in the same chat or in the thread reopened;
//! * a turn that is not a proposal is saved `answered`, as it always was.

mod common;

use std::sync::Arc;

use centraid_assist::native::park::Confirmed;
use centraid_core::api_proto as wire;
use wire::assist_request::Kind as Ask;

use common::chat::{script, step};

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

fn native_sample(steps: &[[String; 2]]) -> common::chat::Sample {
    let sample = common::chat::sample();
    sample.install(script(steps));
    sample
}

/// `(outcome, text)` of every assistant message of a stored thread, oldest first.
fn answers(sample: &common::chat::Sample, thread_id: &str) -> Vec<(String, String)> {
    sample
        .handle
        .with_vault(|vault| Ok(vault.chat_thread(thread_id)?))
        .expect("the thread reads")
        .expect("the thread is there")
        .messages
        .into_iter()
        .filter(|message| message.role == "assistant")
        .map(|message| (message.outcome, message.text))
        .collect()
}

fn card_count(sample: &common::chat::Sample, thread_id: &str) -> usize {
    sample
        .handle
        .with_vault(|vault| Ok(vault.chat_thread(thread_id)?))
        .expect("the thread reads")
        .expect("the thread is there")
        .messages
        .iter()
        .map(|message| message.cards.len())
        .sum()
}

fn pending_id(sample: &common::chat::Sample, session: u64) -> String {
    sample
        .handle
        .assist_pending(session)
        .expect("the chat exists")
        .expect("a write is waiting")
        .id
}

/// Open a stored thread again, as a shell does: a new session over its last turns.
fn reopen(sample: &common::chat::Sample, thread_id: &str) -> u64 {
    match sample
        .assist(Ask::Start(wire::AssistStartRequest {
            thread_id: thread_id.to_owned(),
            ..wire::AssistStartRequest::default()
        }))
        .expect("a stored chat reopens")
        .kind
    {
        Some(wire::assist_response::Kind::Started(started)) => started.session_id,
        other => panic!("{other:?}"),
    }
}

fn status_of(sample: &common::chat::Sample, title: &str) -> String {
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
        .find(|row| text(row, "title").as_deref() == Some(title))
        .and_then(|row| text(row, "status"))
        .expect("the task is there")
}

// ---------------------------------------------------------------------------
// proposed, then applied or dismissed
// ---------------------------------------------------------------------------

#[test]
fn a_turn_that_parks_is_saved_proposed_and_a_tap_settles_it_applied_with_the_line_told() {
    let sample = native_sample(&complete_dry_cleaning());
    let session = sample.start("");
    let sent = sample.send(session, 1, "complete the dry cleaning task");
    let thread = sent.thread_id.clone();
    assert!(!thread.is_empty(), "the turn was saved");

    // SAVED PROPOSED, with the words the member read and the rows the proposal names
    let saved = answers(&sample, &thread);
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].0, "proposed");
    assert!(saved[0].1.starts_with("Proposed: "), "{}", saved[0].1);
    assert!(saved[0].1.contains(DRY_CLEANING), "{}", saved[0].1);
    let cards = card_count(&sample, &thread);

    let card = pending_id(&sample, session);
    let tapped = sample.handle.assist_confirm(session, &card).unwrap();
    assert!(
        matches!(tapped.outcome, Confirmed::Done { .. }),
        "{tapped:?}"
    );
    assert_eq!(status_of(&sample, DRY_CLEANING), "completed");

    // SETTLED APPLIED, with the line the tap answered, and the cards still there
    assert_eq!(
        answers(&sample, &thread),
        vec![("applied".to_owned(), "Done.".to_owned())]
    );
    assert_eq!(card_count(&sample, &thread), cards);
}

#[test]
fn a_card_tapped_twice_settles_once() {
    let sample = native_sample(&complete_dry_cleaning());
    let session = sample.start("");
    let thread = sample
        .send(session, 1, "complete the dry cleaning task")
        .thread_id;
    let card = pending_id(&sample, session);
    let first = sample.handle.assist_confirm(session, &card).unwrap();
    let again = sample.handle.assist_confirm(session, &card).unwrap();
    assert_eq!(first, again);
    assert_eq!(
        answers(&sample, &thread),
        vec![("applied".to_owned(), "Done.".to_owned())]
    );
}

#[test]
fn a_dismissed_card_is_saved_dismissed_with_the_line_a_dismissal_answers() {
    let sample = native_sample(&complete_dry_cleaning());
    let session = sample.start("");
    let thread = sample
        .send(session, 1, "complete the dry cleaning task")
        .thread_id;
    let card = pending_id(&sample, session);
    assert!(sample.handle.assist_dismiss(session, &card).unwrap());
    assert_eq!(
        answers(&sample, &thread),
        vec![("dismissed".to_owned(), "Not done.".to_owned())]
    );
    assert_eq!(status_of(&sample, DRY_CLEANING), "needs-action");
    // and a card that was never waiting records nothing
    assert!(!sample.handle.assist_dismiss(session, &card).unwrap());
    assert_eq!(answers(&sample, &thread)[0].0, "dismissed");
}

#[test]
fn a_card_whose_row_changed_since_is_saved_stale_with_the_line_told() {
    let sample = native_sample(&complete_dry_cleaning());
    let session = sample.start("");
    let thread = sample
        .send(session, 1, "complete the dry cleaning task")
        .thread_id;
    let card = pending_id(&sample, session);

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
    sample
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

    let tapped = sample.handle.assist_confirm(session, &card).unwrap();
    assert!(
        matches!(tapped.outcome, Confirmed::Stale { .. }),
        "{tapped:?}"
    );
    assert_eq!(
        answers(&sample, &thread),
        vec![(
            "stale".to_owned(),
            "That changed since. Ask again.".to_owned()
        )]
    );
    assert_eq!(status_of(&sample, DRY_CLEANING), "needs-action");
}

// ---------------------------------------------------------------------------
// a reopened thread
// ---------------------------------------------------------------------------

#[test]
fn a_reopened_thread_reads_the_settled_line_and_holds_no_card_to_tap() {
    let sample = native_sample(&complete_dry_cleaning());
    let session = sample.start("");
    let sent = sample.send(session, 1, "complete the dry cleaning task");
    let thread = sent.thread_id;
    let card = pending_id(&sample, session);
    sample.handle.assist_confirm(session, &card).unwrap();

    // THE THREAD, REOPENED in a session of its own: the transcript reads what was settled
    let again = reopen(&sample, &thread);
    assert_ne!(again, session, "a reopened thread is a fresh session");
    assert!(sample.handle.assist_pending(again).unwrap().is_none());
    assert_eq!(
        answers(&sample, &thread),
        vec![("applied".to_owned(), "Done.".to_owned())]
    );

    // the old card, tapped from the new session, is nobody's: nothing is recorded and nothing moves
    let late = sample.handle.assist_confirm(again, &card).unwrap();
    assert_eq!(late.outcome, Confirmed::Unknown);
    assert!(!sample.handle.assist_dismiss(again, &card).unwrap());
    assert_eq!(
        answers(&sample, &thread),
        vec![("applied".to_owned(), "Done.".to_owned())]
    );
}

#[test]
fn a_proposal_nobody_answered_stays_proposed_in_a_reopened_thread_and_the_next_turn_dismisses_it() {
    let mut steps = complete_dry_cleaning();
    steps.push(step("plan: no", "decline", &[("reason", "out_of_scope")]));
    let sample = native_sample(&steps);
    let session = sample.start("");
    let sent = sample.send(session, 1, "complete the dry cleaning task");
    let thread = sent.thread_id;
    let proposal = answers(&sample, &thread)[0].1.clone();

    // the app closes with the card on screen; the thread reopens with no card behind it
    let again = reopen(&sample, &thread);
    assert!(sample.handle.assist_pending(again).unwrap().is_none());
    assert_eq!(
        answers(&sample, &thread),
        vec![("proposed".to_owned(), proposal.clone())],
        "it was proposed and nothing has answered it"
    );

    // the member types another question into the reopened thread: that dismisses the card, as a
    // new message does in a live session, and its words stay as the member last saw them
    let next = sample.send(again, 2, "what is the capital of France?");
    assert_eq!(next.thread_id, thread, "one chat, one thread");
    assert_eq!(
        answers(&sample, &thread),
        vec![
            ("dismissed".to_owned(), proposal),
            (
                "answered".to_owned(),
                "Outside what chat can do here.".to_owned()
            ),
        ]
    );
    assert_eq!(status_of(&sample, DRY_CLEANING), "needs-action");
}

#[test]
fn a_new_message_in_the_same_chat_dismisses_the_card_and_it_cannot_be_settled_afterwards() {
    let mut steps = complete_dry_cleaning();
    steps.push(step("plan: no", "decline", &[("reason", "out_of_scope")]));
    let sample = native_sample(&steps);
    let session = sample.start("");
    let thread = sample
        .send(session, 1, "complete the dry cleaning task")
        .thread_id;
    let card = pending_id(&sample, session);
    sample.send(session, 2, "never mind, what is the capital of France");
    let stored = answers(&sample, &thread);
    assert_eq!(stored[0].0, "dismissed");
    assert!(stored[0].1.starts_with("Proposed: "), "{}", stored[0].1);
    assert_eq!(stored[1].0, "answered");

    // the late tap on the card that was dropped records nothing
    let late = sample.handle.assist_confirm(session, &card).unwrap();
    assert_eq!(late.outcome, Confirmed::Unknown);
    assert_eq!(answers(&sample, &thread), stored);
}

// ---------------------------------------------------------------------------
// what is not a proposal
// ---------------------------------------------------------------------------

#[test]
fn a_turn_that_is_not_a_proposal_is_saved_answered_as_it_always_was() {
    let sample = native_sample(&[
        step("plan: look", "find", &[("kind", "task")]),
        step("plan: answer", "answer", &[("rows", "@1")]),
    ]);
    let session = sample.start("");
    let thread = sample.send(session, 1, "what tasks do I have?").thread_id;
    let stored = answers(&sample, &thread);
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].0, "answered");
    // and a tap on a card that never existed records nothing in a chat with no proposal
    assert_eq!(
        sample
            .handle
            .assist_confirm(session, "no-such-card")
            .unwrap()
            .outcome,
        Confirmed::Unknown
    );
    assert_eq!(answers(&sample, &thread), stored);
}
