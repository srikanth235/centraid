//! THE CHAT'S HISTORY, THROUGH THE DOOR A SHELL USES (R-CHAT-1).
//!
//! A turn is saved when it ends, in one commit, through `chat.save_turn`; the
//! `chat.*` app queries read it back; and a stored thread reopens into a
//! session that routes a follow-up as it would have been routed. These are the
//! claims a shell relies on and cannot check for itself:
//!
//! 1. every way a turn ends is saved as what the member was shown;
//! 2. a new chat is a new thread, and a retry replaces the last stored turn;
//! 3. a reopened thread's follow-up is routed WITH its stored read in the
//!    prompt, and the prompt still holds only the last two turns;
//! 4. a camera-roll image is kept as a small thumbnail and never as itself;
//! 5. a deleted chat is gone, and a chat belongs to the vault it happened in.

mod common;

use std::sync::Arc;

use centraid_assist::model::Model;
use centraid_assist::testing::ScriptedModel;
use centraid_core::CoreError;
use centraid_core::api_proto as wire;
use wire::assist_request::Kind as Ask;

const TASKS: &str = r#"{"tool":"tasks.list","args":{"view":"today"}}"#;

fn route_and_phrase(phrase: &str) -> [String; 2] {
    [TASKS.to_owned(), phrase.to_owned()]
}

fn query(
    sample: &common::chat::Sample,
    query: wire::app_query_request::Query,
) -> wire::AppQueryResponse {
    let answer = sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                query: Some(query),
            })),
        })
        .expect("an app query answers");
    match answer.kind {
        Some(wire::response::Kind::AppQuery(answer)) => *answer,
        other => panic!("an app query answered {other:?}"),
    }
}

fn threads(sample: &common::chat::Sample) -> Vec<wire::ChatThreadRow> {
    match query(
        sample,
        wire::app_query_request::Query::ChatThreads(wire::ChatThreadsRequest::default()),
    )
    .answer
    {
        Some(wire::app_query_response::Answer::ChatThreads(listed)) => listed.threads,
        other => panic!("{other:?}"),
    }
}

fn thread(sample: &common::chat::Sample, id: &str) -> wire::ChatThread {
    match query(
        sample,
        wire::app_query_request::Query::ChatThread(wire::ChatThreadRequest {
            thread_id: id.to_owned(),
        }),
    )
    .answer
    {
        Some(wire::app_query_response::Answer::ChatThread(found)) => found,
        other => panic!("{other:?}"),
    }
}

fn send(
    sample: &common::chat::Sample,
    session: u64,
    turn: u64,
    text: &str,
    regenerate: bool,
    attachments: Vec<wire::AssistAttachment>,
) -> wire::AssistSent {
    match sample
        .assist(Ask::Send(wire::AssistSendRequest {
            session_id: session,
            text: text.to_owned(),
            tz: common::chat::TZ.to_owned(),
            regenerate,
            turn_id: turn,
            attachments,
        }))
        .expect("a send answers")
        .kind
    {
        Some(wire::assist_response::Kind::Sent(sent)) => sent,
        other => panic!("{other:?}"),
    }
}

fn start_thread(
    sample: &common::chat::Sample,
    thread_id: &str,
) -> Result<wire::AssistStarted, CoreError> {
    sample
        .assist(Ask::Start(wire::AssistStartRequest {
            app: String::new(),
            thread_id: thread_id.to_owned(),
        }))
        .map(|answer| match answer.kind {
            Some(wire::assist_response::Kind::Started(started)) => started,
            other => panic!("{other:?}"),
        })
}

fn command(
    sample: &common::chat::Sample,
    name: &str,
    input: serde_json::Value,
    key: &str,
) -> wire::CommandOutcome {
    let answer = sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Command(wire::Command {
                name: name.to_owned(),
                input: serde_json::to_vec(&input).unwrap(),
                invoke_key: key.to_owned(),
                ..wire::Command::default()
            })),
        })
        .expect("a command answers");
    match answer.kind {
        Some(wire::response::Kind::Command(outcome)) => outcome,
        other => panic!("{other:?}"),
    }
}

fn texts(stored: &wire::ChatThread) -> Vec<(bool, String)> {
    stored
        .messages
        .iter()
        .map(|message| (message.from_member, message.text.clone()))
        .collect()
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut canvas = image::RgbaImage::new(width, height);
    for (x, y, pixel) in canvas.enumerate_pixels_mut() {
        *pixel = image::Rgba([(x % 251) as u8, (y % 251) as u8, 120, 255]);
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .expect("the fixture encodes");
    out
}

// ---------------------------------------------------------------------------
// 1 & 2. Every way a turn ends is saved; new chat, new thread; retry replaces
// ---------------------------------------------------------------------------

#[test]
fn a_completed_turn_is_saved_listed_and_read_back_with_its_cards() {
    let sample = common::chat::sample();
    sample.install(Arc::new(ScriptedModel::new(route_and_phrase(
        "Two things are due.",
    ))));
    let session = sample.start("tasks");
    assert!(
        threads(&sample).is_empty(),
        "nothing is saved before a turn ends"
    );

    let sent = send(
        &sample,
        session,
        1,
        "  What is due   today? ",
        false,
        vec![],
    );
    assert!(!sent.thread_id.is_empty(), "the response names the thread");
    assert_eq!(sent.thread_title, "What is due today?");

    let listed = threads(&sample);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].thread_id, sent.thread_id);
    assert_eq!(listed[0].scope_app, "tasks");

    let stored = thread(&sample, &sent.thread_id);
    assert!(stored.found);
    assert_eq!(stored.messages.len(), 2);
    let (question, answer) = (&stored.messages[0], &stored.messages[1]);
    assert!(question.from_member);
    assert_eq!(question.text, "What is due   today?");
    assert_eq!(answer.text, "Two things are due.");
    assert_eq!(answer.outcome, wire::ChatStoredOutcome::Answered as i32);
    assert!(
        !answer.cards.is_empty(),
        "the rows the answer found are kept"
    );
    assert!(
        answer
            .cards
            .iter()
            .all(|card| card.app == "tasks" && !card.id.is_empty())
    );
}

#[test]
fn the_next_turn_joins_the_thread_and_a_new_chat_starts_another() {
    let sample = common::chat::sample();
    let model = ScriptedModel::new(
        route_and_phrase("One.")
            .into_iter()
            .chain(route_and_phrase("Two."))
            .chain(route_and_phrase("Three.")),
    );
    sample.install(Arc::new(model));
    let session = sample.start("");
    let first = send(&sample, session, 1, "what is due today?", false, vec![]);
    let second = send(&sample, session, 2, "and again?", false, vec![]);
    assert_eq!(first.thread_id, second.thread_id);
    assert_eq!(thread(&sample, &first.thread_id).messages.len(), 4);

    sample
        .assist(Ask::Clear(wire::AssistClearRequest {
            session_id: session,
        }))
        .unwrap();
    let third = send(&sample, session, 3, "a new question", false, vec![]);
    assert_ne!(
        third.thread_id, first.thread_id,
        "a new chat is a new thread"
    );
    let listed = threads(&sample);
    assert_eq!(listed.len(), 2);
    // Newest first.
    assert_eq!(listed[0].thread_id, third.thread_id);
    assert_eq!(thread(&sample, &first.thread_id).messages.len(), 4);
}

#[test]
fn a_retry_replaces_the_last_stored_turn_and_only_that_one() {
    let sample = common::chat::sample();
    let model = ScriptedModel::new(
        route_and_phrase("First wording.")
            .into_iter()
            .chain(route_and_phrase("Second wording."))
            .chain(route_and_phrase("Better second wording.")),
    );
    sample.install(Arc::new(model));
    let session = sample.start("");
    let first = send(&sample, session, 1, "what is due today?", false, vec![]);
    send(&sample, session, 2, "and tomorrow?", false, vec![]);
    let retried = send(&sample, session, 3, "", true, vec![]);
    assert_eq!(retried.thread_id, first.thread_id);

    let stored = thread(&sample, &first.thread_id);
    assert_eq!(
        texts(&stored),
        vec![
            (true, "what is due today?".to_owned()),
            (false, "First wording.".to_owned()),
            (true, "and tomorrow?".to_owned()),
            (false, "Better second wording.".to_owned()),
        ]
    );
}

#[test]
fn a_stopped_turn_saves_what_was_streamed_marked_stopped() {
    let sample = common::chat::sample();
    // The route says no tool fits; the free answer streams and is stopped
    // after two pieces.
    let model = ScriptedModel::new([
        r#"{"tool":"none"}"#,
        "Partly written answer that was stopped",
    ])
    .cancelling_during(1, 2);
    sample.install(Arc::new(model));
    let session = sample.start("");
    let sent = send(&sample, session, 1, "tell me something", false, vec![]);
    assert!(matches!(
        sent.outcome,
        Some(wire::assist_sent::Outcome::Refused(ref refusal))
            if refusal.reason == wire::AssistRefusalReason::Cancelled as i32
    ));
    assert!(!sent.thread_id.is_empty(), "a stopped turn is saved too");
    let stored = thread(&sample, &sent.thread_id);
    let answer = &stored.messages[1];
    assert_eq!(answer.outcome, wire::ChatStoredOutcome::Stopped as i32);
    assert!(
        !answer.text.is_empty()
            && "Partly written answer that was stopped".starts_with(&answer.text),
        "what was streamed is kept: {:?}",
        answer.text
    );
}

#[test]
fn a_refusal_is_saved_as_the_reason_the_member_was_shown() {
    let sample = common::chat::sample();
    // No tool fits and the free answer says nothing: the plane's own refusal.
    sample.install(Arc::new(ScriptedModel::new([r#"{"tool":"none"}"#, ""])));
    let session = sample.start("");
    let sent = send(
        &sample,
        session,
        1,
        "what is the meaning of life",
        false,
        vec![],
    );
    assert!(!sent.thread_id.is_empty());
    let answer = &thread(&sample, &sent.thread_id).messages[1];
    assert_eq!(answer.outcome, wire::ChatStoredOutcome::Refused as i32);
    assert_eq!(answer.refusal, wire::AssistRefusalReason::NoToolFits as i32);
}

#[test]
fn a_turn_that_never_started_because_another_was_running_is_not_saved() {
    // BUSY is the one refusal that is not a turn: nothing was asked of the
    // model and nothing is kept.
    let sample = common::chat::sample();
    let (started, wait) = std::sync::mpsc::channel();
    sample.install(Arc::new(centraid_assist::testing::StallingModel::new(
        started,
    )));
    let session = sample.start("");
    std::thread::scope(|scope| {
        let running = scope.spawn(|| send(&sample, session, 1, "first", false, vec![]));
        wait.recv().unwrap();
        let busy = send(&sample, session, 2, "second", false, vec![]);
        assert!(matches!(
            busy.outcome,
            Some(wire::assist_sent::Outcome::Refused(ref refusal))
                if refusal.reason == wire::AssistRefusalReason::Busy as i32
        ));
        assert!(busy.thread_id.is_empty());
        sample
            .assist(Ask::Cancel(wire::AssistCancelRequest {
                session_id: session,
            }))
            .unwrap();
        running.join().unwrap();
    });
    let listed = threads(&sample);
    assert_eq!(listed.len(), 1);
    assert_eq!(thread(&sample, &listed[0].thread_id).messages.len(), 2);
}

// ---------------------------------------------------------------------------
// 3. Rehydration
// ---------------------------------------------------------------------------

#[test]
fn a_reopened_thread_routes_a_follow_up_with_its_stored_read_in_the_prompt() {
    let sample = common::chat::sample();
    sample.install(Arc::new(ScriptedModel::new(route_and_phrase(
        "Two things.",
    ))));
    let session = sample.start("");
    let first = send(&sample, session, 1, "what is due today?", false, vec![]);

    // The app is closed and opened again: a new session over the stored thread.
    let follow_up = Arc::new(ScriptedModel::new(route_and_phrase("Another thing.")));
    sample.install(Arc::clone(&follow_up) as Arc<dyn Model>);
    let reopened = start_thread(&sample, &first.thread_id).expect("the thread reopens");
    assert_eq!(reopened.thread_id, first.thread_id);
    assert_ne!(reopened.session_id, session);
    let sent = send(
        &sample,
        reopened.session_id,
        1,
        "and tomorrow?",
        false,
        vec![],
    );
    assert_eq!(
        sent.thread_id, first.thread_id,
        "the follow-up joins the same thread"
    );

    let route = &follow_up.prompts()[0];
    assert!(
        route.contains("what is due today?"),
        "the stored question: {route}"
    );
    assert!(
        route.contains(r#"{"tool":"tasks.list","args":{"view":"today"}}"#),
        "the stored read the assistant made: {route}"
    );
    assert_eq!(thread(&sample, &first.thread_id).messages.len(), 4);
}

#[test]
fn a_long_thread_costs_the_model_no_more_than_a_short_one() {
    let sample = common::chat::sample();
    let mut script = Vec::new();
    for n in 1..=5 {
        script.extend(route_and_phrase(&format!("Answer {n}.")));
    }
    sample.install(Arc::new(ScriptedModel::new(script)));
    let session = sample.start("");
    let mut thread_id = String::new();
    for n in 1..=5 {
        thread_id = send(
            &sample,
            session,
            n,
            &format!("question number {n}"),
            false,
            vec![],
        )
        .thread_id;
    }
    let after = Arc::new(ScriptedModel::new(route_and_phrase("Sixth.")));
    sample.install(Arc::clone(&after) as Arc<dyn Model>);
    let reopened = start_thread(&sample, &thread_id).unwrap();
    send(
        &sample,
        reopened.session_id,
        1,
        "question number 6",
        false,
        vec![],
    );
    let route = &after.prompts()[0];
    assert!(
        !route.contains("question number 3"),
        "no prompt growth: {route}"
    );
    assert!(route.contains("question number 4") && route.contains("question number 5"));
}

#[test]
fn a_reopened_threads_retry_asks_its_last_question_again() {
    let sample = common::chat::sample();
    sample.install(Arc::new(ScriptedModel::new(route_and_phrase(
        "Old wording.",
    ))));
    let session = sample.start("");
    let first = send(&sample, session, 1, "what is due today?", false, vec![]);
    sample.install(Arc::new(ScriptedModel::new(route_and_phrase(
        "New wording.",
    ))));
    let reopened = start_thread(&sample, &first.thread_id).unwrap();
    let retried = send(&sample, reopened.session_id, 1, "", true, vec![]);
    assert_eq!(retried.thread_id, first.thread_id);
    assert_eq!(
        texts(&thread(&sample, &first.thread_id)),
        vec![
            (true, "what is due today?".to_owned()),
            (false, "New wording.".to_owned())
        ]
    );
}

#[test]
fn a_thread_that_is_not_in_the_vault_does_not_reopen() {
    let sample = common::chat::sample();
    assert!(matches!(
        start_thread(&sample, "no-such-thread"),
        Err(CoreError::InvalidRequest { .. })
    ));
}

// ---------------------------------------------------------------------------
// 4. Attachments
// ---------------------------------------------------------------------------

#[test]
fn a_camera_roll_image_is_saved_as_a_small_thumbnail_and_never_as_itself() {
    let sample = common::chat::sample();
    sample.install(Arc::new(ScriptedModel::new(["It is a gradient."]).seeing()));
    let session = sample.start("");
    let original = png(1200, 800);
    let sent = send(
        &sample,
        session,
        1,
        "what is this?",
        false,
        vec![wire::AssistAttachment {
            kind: Some(wire::assist_attachment::Kind::ImageBytes(
                wire::AssistImageBytes {
                    content: original.clone(),
                    mime: "image/png".to_owned(),
                },
            )),
            label: "Camera roll".to_owned(),
        }],
    );
    assert!(!sent.thread_id.is_empty());
    let stored = thread(&sample, &sent.thread_id);
    let attachment = &stored.messages[0].attachments[0];
    assert_eq!(
        attachment.kind,
        wire::ChatStoredAttachmentKind::Image as i32
    );
    assert_eq!(attachment.label, "Camera roll");
    assert!(attachment.asset_id.is_empty() && attachment.document_id.is_empty());

    let path = &attachment.thumbnail_path;
    assert!(!path.is_empty(), "the thumbnail is readable");
    let bytes = std::fs::read(path).expect("the thumbnail file reads");
    let decoded = image::load_from_memory(&bytes).expect("it is an image");
    assert_eq!(decoded.width().max(decoded.height()), 256);
    assert!(
        bytes.len() < 60_000,
        "a thumbnail, not a picture: {}",
        bytes.len()
    );
    assert_ne!(bytes, original, "the original is never what is kept");
    assert_eq!((decoded.width(), decoded.height()), (256, 171));
}

#[test]
fn a_vault_document_is_saved_as_a_reference_and_its_label() {
    let sample = common::chat::sample();
    let documents = match sample
        .assist(Ask::Documents(wire::AssistDocumentsRequest { limit: 5 }))
        .unwrap()
        .kind
    {
        Some(wire::assist_response::Kind::Documents(listed)) => listed.documents,
        other => panic!("{other:?}"),
    };
    let doc = documents.first().expect("the sample holds a text document");
    sample.install(Arc::new(ScriptedModel::new(["It is about a trip."])));
    let session = sample.start("");
    let sent = send(
        &sample,
        session,
        1,
        "summarise this",
        false,
        vec![wire::AssistAttachment {
            kind: Some(wire::assist_attachment::Kind::VaultDoc(
                wire::AssistVaultDoc {
                    doc_id: doc.doc_id.clone(),
                },
            )),
            label: doc.title.clone(),
        }],
    );
    let attachment = &thread(&sample, &sent.thread_id).messages[0].attachments[0];
    assert_eq!(
        attachment.kind,
        wire::ChatStoredAttachmentKind::Document as i32
    );
    assert_eq!(attachment.document_id, doc.doc_id);
    assert_eq!(attachment.label, doc.title);
}

// ---------------------------------------------------------------------------
// 5. Deleting, and which vault a chat belongs to
// ---------------------------------------------------------------------------

#[test]
fn a_deleted_chat_is_gone_and_cannot_be_reopened() {
    let sample = common::chat::sample();
    sample.install(Arc::new(ScriptedModel::new(route_and_phrase("Two."))));
    let session = sample.start("");
    let sent = send(&sample, session, 1, "what is due today?", false, vec![]);

    let renamed = command(
        &sample,
        "chat.rename_thread",
        serde_json::json!({ "thread_id": sent.thread_id, "title": "Due today" }),
        "rename-1",
    );
    assert_eq!(renamed.status, wire::CommandStatus::Executed as i32);
    assert_eq!(threads(&sample)[0].title, "Due today");

    let deleted = command(
        &sample,
        "chat.delete_thread",
        serde_json::json!({ "thread_id": sent.thread_id }),
        "delete-1",
    );
    assert_eq!(deleted.status, wire::CommandStatus::Executed as i32);
    assert!(threads(&sample).is_empty());
    assert!(!thread(&sample, &sent.thread_id).found);
    assert!(start_thread(&sample, &sent.thread_id).is_err());

    // The still-open session is not wedged: its next turn starts a new thread.
    sample.install(Arc::new(ScriptedModel::new(route_and_phrase("Again."))));
    let again = send(&sample, session, 2, "once more", false, vec![]);
    assert!(!again.thread_id.is_empty());
    assert_ne!(again.thread_id, sent.thread_id);
}

#[test]
fn clearing_every_chat_leaves_none_to_list() {
    let sample = common::chat::sample();
    sample.install(Arc::new(ScriptedModel::new(
        route_and_phrase("One.")
            .into_iter()
            .chain(route_and_phrase("Two.")),
    )));
    let first = sample.start("");
    send(&sample, first, 1, "first chat", false, vec![]);
    let second = sample.start("");
    send(&sample, second, 1, "second chat", false, vec![]);
    assert_eq!(threads(&sample).len(), 2);
    let cleared = command(&sample, "chat.clear", serde_json::json!({}), "clear-1");
    assert_eq!(cleared.status, wire::CommandStatus::Executed as i32);
    assert!(threads(&sample).is_empty());
}

#[test]
fn a_card_whose_row_is_gone_says_so_at_the_tap() {
    let sample = common::chat::sample();
    sample.install(Arc::new(ScriptedModel::new(route_and_phrase("Two."))));
    let session = sample.start("");
    let sent = send(&sample, session, 1, "what is due today?", false, vec![]);
    let card = thread(&sample, &sent.thread_id).messages[1].cards[0].clone();
    let ask = |app: &str, entity: &str, id: &str| match query(
        &sample,
        wire::app_query_request::Query::ChatCard(wire::ChatCardRequest {
            app: app.to_owned(),
            entity: entity.to_owned(),
            id: id.to_owned(),
        }),
    )
    .answer
    {
        Some(wire::app_query_response::Answer::ChatCard(live)) => live.exists,
        other => panic!("{other:?}"),
    };
    assert!(ask(&card.app, &card.entity, &card.id), "the row is there");
    assert!(!ask(&card.app, &card.entity, "a-row-that-was-deleted"));
    assert!(
        !ask("locker", "item", &card.id),
        "locker is never a card's app"
    );
}

#[test]
fn a_chat_belongs_to_the_vault_it_happened_in_and_goes_with_it() {
    let first = common::chat::sample();
    let second = common::chat::sample();
    first.install(Arc::new(ScriptedModel::new(route_and_phrase("Two."))));
    let session = first.start("");
    send(&first, session, 1, "what is due today?", false, vec![]);
    assert_eq!(threads(&first).len(), 1);
    assert!(threads(&second).is_empty(), "another vault never sees it");

    // THE CHAT IS IN THE VAULT'S OWN FILE, and in nothing beside it: forgetting
    // a vault deletes its directory whole (`Shelf.forget`), so a chat that
    // lived anywhere else would outlive it.
    let dir = first.dir().to_path_buf();
    let file = dir.join("vault.db");
    first.handle.close();
    let reopened = centraid_vault::Vault::open(&file).expect("the vault file opens");
    let kept = reopened.chat_threads(10).expect("the chat is in vault.db");
    assert_eq!(kept.len(), 1);
    assert_eq!(
        reopened
            .chat_thread(&kept[0].thread_id)
            .unwrap()
            .expect("the thread")
            .messages
            .len(),
        2
    );
    reopened.close().expect("closes");
    std::fs::remove_dir_all(&dir).expect("the vault is forgotten");
    assert!(!file.exists());
}
