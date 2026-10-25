//! A question, the turn that answers it, and the write it may propose.

mod chat_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_assist::testing::ScriptedModel;
use chat_support::{Chat, DRY_CLEANING, FOUND_TASKS, complete_dry_cleaning, read_tasks, script, step};
use wire::chat_event::Kind as C;
use wire::chat_pending::State;
use wire::chat_state::Phase;
use wire::screen_event::Kind as S;

fn ready() -> Chat {
    Chat::ready(script(&read_tasks()))
}

#[test]
fn opening_a_ready_model_starts_a_session_and_shows_three_suggestions() {
    let chat = ready();
    let state = chat.state();
    assert_eq!(state.phase(), Phase::Ready);
    assert_eq!(state.title, "New chat");
    assert_eq!(state.subtitle, "Sample · on this phone");
    assert_eq!(state.empty_line, "Ask about anything in your vault.");
    assert!(!state.suggestions.is_empty() && state.suggestions.len() <= 3, "{:?}", state.suggestions);
    assert!(state.messages.is_empty());
}

#[test]
fn a_question_streams_into_the_thread_and_settles_once_with_its_thread_named() {
    let mut chat = ready();
    chat.say("what tasks do I have?");
    let state = chat.state();
    assert_eq!(state.messages.len(), 2);
    assert_eq!(state.messages[0].text, "what tasks do I have?");
    assert_eq!(state.messages[0].role(), wire::chat_message::Role::User);
    let answer = &state.messages[1];
    assert_eq!(answer.text, FOUND_TASKS);
    assert_eq!(answer.cards.len(), 6);
    assert!(!answer.streaming && !state.streaming && state.activity.is_empty());
    assert!(state.error.is_empty());
    assert!(state.suggestions.is_empty(), "suggestions go with the first question");
    // The core saved the turn: the header takes the title and the drawer lists the chat.
    assert_eq!(state.title, "what tasks do I have?");
    assert!(!state.thread_id.is_empty());
    assert_eq!(chat.thread_titles(), ["what tasks do I have?"]);
    assert!(state.can_retry && state.can_new_chat);
}

#[test]
fn the_answer_to_the_send_call_settles_the_turn_whichever_comes_first() {
    let mut chat = ready();
    chat.event(C::Sent(wire::chat_event::Sent { text: "tasks?".to_owned() }));
    // While the turn runs the thread already shows the question and a streaming answer.
    assert!(chat.state().streaming);
    assert_eq!(chat.state().activity, "Thinking");
    // The answer before the stream: settled by the call; the stream that follows is dropped.
    assert!(chat.answer_call(false));
    let state = chat.state();
    assert_eq!(state.messages.len(), 2);
    assert_eq!(state.messages[1].text, FOUND_TASKS);
    assert_eq!(state.messages[1].cards.len(), 6);
    assert!(!state.streaming);
}

#[test]
fn the_stream_alone_draws_the_activity_the_cards_and_the_sentence_as_they_come() {
    let mut chat = ready();
    chat.event(C::Sent(wire::chat_event::Sent { text: "tasks?".to_owned() }));
    // Run the call, pump the stream, but hold the call's answer back.
    let (request, call) = {
        let at = chat.driver.effects.iter().position(|r| {
            matches!(r.effect.as_ref().and_then(|e| e.kind.as_ref()), Some(wire::effect::Kind::AssistCall(_)))
        }).expect("a send");
        let request = chat.driver.effects.remove(at);
        let Some(wire::effect::Kind::AssistCall(call)) = request.effect.clone().and_then(|e| e.kind) else {
            unreachable!()
        };
        (request, call.request.unwrap())
    };
    let sent = chat.driver.handle.call(&wire::Request { kind: Some(wire::request::Kind::Assist(call)) }).unwrap();
    chat.driver.pump(Duration::from_millis(60));
    let state = chat.state();
    // The terminal event settled the turn.
    assert_eq!(state.messages[1].text, FOUND_TASKS);
    assert!(!state.streaming);
    // The call's answer arriving second changes nothing and adopts the thread.
    let Some(wire::response::Kind::Assist(response)) = sent.kind else { panic!() };
    chat.driver.send(request.instance, S::EffectResult(wire::EffectResult {
        effect_id: request.effect_id,
        outcome: Some(wire::effect_result::Outcome::AssistAnswered(response)),
    }));
    assert_eq!(chat.state().messages.len(), 2);
    assert!(!chat.state().thread_id.is_empty());
}

#[test]
fn an_event_for_another_turn_or_session_is_not_heard() {
    let mut chat = ready();
    chat.event(C::Sent(wire::chat_event::Sent { text: "tasks?".to_owned() }));
    let session = {
        // The running turn is 1 on the chat's session; an event for turn 99 is stale.
        let wire::ChatState { .. } = chat.state();
        1
    };
    let stale = |turn| wire::AssistEvent {
        session_id: session,
        turn_id: turn,
        kind: Some(wire::assist_event::Kind::Token(wire::AssistToken { text: "STALE".to_owned() })),
    };
    for turn in [0, 99] {
        chat.driver.send(chat.id, S::Assist(stale(turn)));
    }
    assert!(!chat.state().messages[1].text.contains("STALE"));
    chat.perform();
}

#[test]
fn a_blank_message_a_message_while_one_runs_and_a_message_before_ready_are_not_sent() {
    let mut chat = Chat::with(None);
    chat.say("early");
    assert!(chat.state().messages.is_empty(), "no thread before the model is ready");
    let mut chat = ready();
    chat.say("   ");
    assert!(chat.state().messages.is_empty());
    chat.event(C::Sent(wire::chat_event::Sent { text: "first".to_owned() }));
    chat.event(C::Sent(wire::chat_event::Sent { text: "second".to_owned() }));
    assert_eq!(chat.state().messages.len(), 2, "one turn runs at a time");
    chat.perform();
}

#[test]
fn a_decline_is_a_composed_line_and_an_exhausted_model_is_the_generic_failure() {
    let mut chat = Chat::ready(script(&[step("plan: no", "decline", &[("reason", "not_found")])]));
    chat.say("do the thing");
    assert_eq!(chat.last_text(), "Nothing found.");

    let mut chat = Chat::ready(std::sync::Arc::new(ScriptedModel::empty()));
    chat.say("anything");
    let state = chat.state();
    assert_eq!(state.error, "The model stopped. Retry.");
    assert_eq!(state.messages.len(), 1, "an answer with nothing in it is dropped, the question stays");
    assert!(!state.streaming);
}

#[test]
fn stopping_keeps_the_part_that_was_drawn_says_nothing_and_offers_retry() {
    let model = std::sync::Arc::new(
        ScriptedModel::new(read_tasks().iter().flatten().cloned()).cancelling_during(1, 1),
    );
    let mut chat = Chat::ready(model);
    chat.event(C::Sent(wire::chat_event::Sent { text: "tasks?".to_owned() }));
    // The member taps Stop while the send is still running; here the model fires the token.
    chat.perform();
    let state = chat.state();
    assert!(state.error.is_empty(), "a stop says nothing: {:?}", state.error);
    assert!(!state.streaming);
    assert!(state.can_retry);
}

#[test]
fn retry_asks_the_same_question_again_in_place_of_the_last_answer() {
    let mut chat = Chat::ready(script(&[
        read_tasks()[0].clone(),
        read_tasks()[1].clone(),
        read_tasks()[0].clone(),
        read_tasks()[1].clone(),
    ]));
    chat.say("tasks?");
    chat.event(C::Regenerated(wire::chat_event::Regenerated {}));
    chat.perform();
    let state = chat.state();
    assert_eq!(state.messages.len(), 2, "the question stays, the answer is replaced");
    assert_eq!(state.messages[0].text, "tasks?");
    assert_eq!(state.messages[1].text, FOUND_TASKS);
}

#[test]
fn a_new_chat_clears_the_thread_and_asks_for_fresh_suggestions() {
    let mut chat = ready();
    chat.say("tasks?");
    let before = chat.state().thread_id.clone();
    assert!(!before.is_empty());
    chat.event(C::NewChat(wire::chat_event::NewChat {}));
    let state = chat.state();
    assert!(state.messages.is_empty() && state.thread_id.is_empty());
    assert_eq!(state.title, "New chat");
    assert!(!state.suggestions.is_empty());
    assert!(!state.can_new_chat);
    // the stored chat is still in the drawer
    assert_eq!(chat.thread_titles(), ["tasks?"]);
}

#[test]
fn copy_puts_one_messages_text_on_the_clipboard_and_an_unknown_message_nothing() {
    let mut chat = ready();
    chat.say("tasks?");
    let id = chat.state().messages[1].id;
    chat.event(C::Copied(wire::chat_event::Copied { message_id: id }));
    let copied = chat.asked(|kind| match kind {
        wire::effect::Kind::ClipboardSet(set) => Some(set.text.clone()),
        _ => None,
    });
    assert_eq!(copied, [FOUND_TASKS]);
    chat.driver.effects.clear();
    chat.event(C::Copied(wire::chat_event::Copied { message_id: 999 }));
    assert!(chat.driver.effects.is_empty());
}

#[test]
fn a_model_that_went_away_sends_the_chat_back_to_ask_where_it_stands() {
    let mut chat = ready();
    chat.driver.handle.assist().host().unload();
    chat.say("tasks?");
    // The refusal sends the chat back to CHECKING, and the status read finds no model file.
    assert_eq!(chat.state().phase(), Phase::NeedsModel);
    assert!(chat.state().messages.is_empty(), "the thread is drawn only when the model is ready");
}

// ---------------------------------------------------------------- proposals --

fn proposing() -> Chat {
    let mut chat = Chat::ready(script(&complete_dry_cleaning()));
    chat.say("complete the dry cleaning task");
    chat
}

fn card(chat: &Chat) -> wire::ChatPending {
    chat.state().messages.last().and_then(|m| m.pending.clone()).expect("a card")
}

fn task_status(chat: &Chat, title: &str) -> String {
    use centraid_assist::native::Door as _;
    use centraid_assist::native::door::text;
    let door = chat.driver.handle.assist_door();
    let titles: std::collections::BTreeMap<String, String> = door
        .table_where("entity", "id, title, created_at", "created_at", "id", "kind = ?", &["task".to_owned()])
        .unwrap()
        .iter()
        .filter_map(|row| Some((text(row, "id")?, text(row, "title")?)))
        .collect();
    door.table("task", "id, status", "id", "id")
        .unwrap()
        .iter()
        .find_map(|row| {
            (titles.get(&text(row, "id")?)? == title).then(|| text(row, "status").unwrap_or_default())
        })
        .expect("the task")
}

#[test]
fn a_write_the_model_parks_is_a_card_in_the_cores_words_and_writes_nothing_until_the_tap() {
    let chat = proposing();
    let message = chat.state().messages.last().unwrap();
    assert_eq!(message.text, format!("Proposed: Complete task \"{DRY_CLEANING}\"."));
    let pending = card(&chat);
    assert_eq!(pending.state(), State::Waiting);
    assert_eq!(pending.steps.len(), 1);
    assert_eq!(pending.steps[0].summary, format!("Complete task \"{DRY_CLEANING}\""));
    assert_eq!((pending.confirm_label.as_str(), pending.cancel_label.as_str()), ("Confirm", "Cancel"));
    assert!(!pending.destructive && pending.more_line.is_empty());
    assert_eq!(task_status(&chat, DRY_CLEANING), "open");
}

#[test]
fn confirm_runs_the_card_once_and_draws_the_cores_line_with_no_undo() {
    let mut chat = proposing();
    let id = card(&chat).pending_id;
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed { pending_id: id.clone() }));
    let pending = card(&chat);
    assert_eq!(pending.state(), State::Applied);
    assert_eq!(pending.settled_line, "Done.");
    assert_eq!(task_status(&chat, DRY_CLEANING), "done");
    // a second tap finds nothing waiting
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed { pending_id: id }));
    assert_eq!(card(&chat).state(), State::Applied);
}

#[test]
fn cancel_settles_the_card_at_once_and_writes_nothing() {
    let mut chat = proposing();
    let id = card(&chat).pending_id;
    chat.event(C::PendingCancelled(wire::chat_event::PendingCancelled { pending_id: id.clone() }));
    let pending = card(&chat);
    assert_eq!(pending.state(), State::NotDone);
    assert_eq!(pending.settled_line, "Not done.");
    assert_eq!(task_status(&chat, DRY_CLEANING), "open");
    // and the core no longer holds it
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed { pending_id: id }));
    assert_eq!(task_status(&chat, DRY_CLEANING), "open");
}

#[test]
fn a_new_question_makes_a_waiting_card_inert_and_the_core_never_runs_it() {
    let mut chat = Chat::ready(script(&[
        complete_dry_cleaning()[0].clone(),
        complete_dry_cleaning()[1].clone(),
        step("plan: no", "decline", &[("reason", "not_found")]),
    ]));
    chat.say("complete the dry cleaning task");
    let id = card(&chat).pending_id;
    chat.say("never mind");
    let first = &chat.state().messages[1];
    assert_eq!(first.pending.as_ref().unwrap().state(), State::Inert);
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed { pending_id: id }));
    assert_eq!(task_status(&chat, DRY_CLEANING), "open");
}

#[test]
fn taps_that_are_not_for_a_waiting_card_do_nothing() {
    let mut chat = proposing();
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed { pending_id: "other".to_owned() }));
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed { pending_id: String::new() }));
    assert_eq!(card(&chat).state(), State::Waiting);
    assert_eq!(task_status(&chat, DRY_CLEANING), "open");
}

#[test]
fn a_card_whose_rows_moved_says_so_and_runs_nothing() {
    let mut chat = proposing();
    // Another surface completes the task while the card waits.
    let id = card(&chat).pending_id;
    let task = {
        use centraid_assist::native::Door as _;
        use centraid_assist::native::door::text;
        let door = chat.driver.handle.assist_door();
        door.table_where("entity", "id, title, created_at", "created_at", "id", "kind = ?", &["task".to_owned()])
            .unwrap()
            .iter()
            .find(|row| text(row, "title").as_deref() == Some(DRY_CLEANING))
            .and_then(|row| text(row, "id"))
            .unwrap()
    };
    let mut request = centraid_screens::catalog::act::agenda::CompleteTask { task_id: task }.request();
    request.invoke_key = "test:moved:1".to_owned();
    let moved = chat.driver.act(request);
    assert_eq!(moved.status, wire::ActStatus::Executed as i32, "{moved:?}");
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed { pending_id: id }));
    let pending = card(&chat);
    assert_eq!(pending.state(), State::Stale);
    assert_eq!(pending.settled_line, "That changed since. Ask again.");
}
