//! A question, the turn that answers it, and the write it may propose.

mod chat_support;

use centraid_api_proto::core_v1 as wire;
use centraid_assist::testing::ScriptedModel;
use chat_support::{
    Chat, DRY_CLEANING, FOUND_TASKS, complete_dry_cleaning, read_tasks, script, step,
};
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
    assert!(
        !state.suggestions.is_empty() && state.suggestions.len() <= 3,
        "{:?}",
        state.suggestions
    );
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
    // THE THREAD IS LIVE (#1173): the answer settles and the chips above the composer come back.
    assert!(
        !state.suggestions.is_empty() && state.suggestions.len() <= 3,
        "{:?}",
        state.suggestions
    );
    // The core saved the turn: the header takes the title and the drawer lists the chat.
    assert_eq!(state.title, "what tasks do I have?");
    assert!(!state.thread_id.is_empty());
    assert_eq!(chat.thread_titles(), ["what tasks do I have?"]);
    assert!(state.can_retry && state.can_new_chat);
}

#[test]
fn suggestions_are_offered_in_a_live_thread_as_well_as_an_empty_one() {
    let mut chat = ready();
    let first = chat.state().suggestions.clone();
    assert_eq!(first.len(), 3);
    chat.say("what tasks do I have?");
    let live = chat.state();
    assert_eq!(live.messages.len(), 2);
    assert_eq!(live.suggestions.len(), 3, "chips above the composer");
    assert!(!live.streaming);
}

#[test]
fn a_turn_settles_once_and_what_arrives_after_it_changes_nothing() {
    let mut chat = ready();
    chat.event(C::Sent(wire::chat_event::Sent {
        text: "tasks?".to_owned(),
        ..Default::default()
    }));
    // While the turn runs the thread already shows the question and a streaming answer.
    assert!(chat.state().streaming);
    assert_eq!(chat.state().activity, "Thinking");
    chat.perform();
    let before = chat.state().clone();
    assert_eq!(before.messages[1].text, FOUND_TASKS);
    assert!(!before.thread_id.is_empty());
    // a late failure of the same turn, and a late token of it, are not heard
    chat.driver.send(
        chat.id,
        S::OffThreadDone(wire::OffThreadDone {
            tag: "send:1".to_owned(),
            bytes: Vec::new(),
        }),
    );
    chat.driver.send(
        chat.id,
        S::Assist(wire::AssistEvent {
            session_id: 1,
            turn_id: 1,
            kind: Some(wire::assist_event::Kind::Token(wire::AssistToken {
                text: "LATE".to_owned(),
            })),
        }),
    );
    assert_eq!(chat.state(), &before);
}

#[test]
fn an_event_for_another_turn_or_session_is_not_heard() {
    let mut chat = ready();
    chat.event(C::Sent(wire::chat_event::Sent {
        text: "tasks?".to_owned(),
        ..Default::default()
    }));
    let session = {
        // The running turn is 1 on the chat's session; an event for turn 99 is stale.
        let wire::ChatState { .. } = chat.state();
        1
    };
    let stale = |turn| wire::AssistEvent {
        session_id: session,
        turn_id: turn,
        kind: Some(wire::assist_event::Kind::Token(wire::AssistToken {
            text: "STALE".to_owned(),
        })),
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
    assert!(
        chat.state().messages.is_empty(),
        "no thread before the model is ready"
    );
    let mut chat = ready();
    chat.say("   ");
    assert!(chat.state().messages.is_empty());
    chat.event(C::Sent(wire::chat_event::Sent {
        text: "first".to_owned(),
        ..Default::default()
    }));
    chat.event(C::Sent(wire::chat_event::Sent {
        text: "second".to_owned(),
        ..Default::default()
    }));
    assert_eq!(chat.state().messages.len(), 2, "one turn runs at a time");
    chat.perform();
}

#[test]
fn a_decline_is_a_composed_line_and_an_exhausted_model_is_the_generic_failure() {
    let mut chat = Chat::ready(script(&[step(
        "plan: no",
        "decline",
        &[("reason", "not_found")],
    )]));
    chat.say("do the thing");
    assert_eq!(chat.last_text(), "Nothing found.");

    let mut chat = Chat::ready(std::sync::Arc::new(ScriptedModel::empty()));
    chat.say("anything");
    let state = chat.state();
    assert_eq!(state.error, "The model stopped. Try again.");
    assert_eq!(
        state.messages.len(),
        1,
        "an answer with nothing in it is dropped, the question stays"
    );
    assert!(!state.streaming);
}

#[test]
fn stopping_keeps_the_part_that_was_drawn_says_nothing_and_offers_retry() {
    let model = std::sync::Arc::new(
        ScriptedModel::new(read_tasks().iter().flatten().cloned()).cancelling_during(1, 1),
    );
    let mut chat = Chat::ready(model);
    chat.event(C::Sent(wire::chat_event::Sent {
        text: "tasks?".to_owned(),
        ..Default::default()
    }));
    // The member taps Stop while the send is still running; here the model fires the token.
    chat.perform();
    let state = chat.state();
    assert!(
        state.error.is_empty(),
        "a stop says nothing: {:?}",
        state.error
    );
    assert!(!state.streaming);
    assert!(state.can_retry);
    // what was drawn stays, under one quiet line (ChatStoppedFailed.dc.html)
    if let Some(answer) = state
        .messages
        .iter()
        .find(|m| m.role == wire::chat_message::Role::Assistant as i32)
    {
        assert_eq!(
            (answer.mark.as_str(), answer.mark_failed),
            ("Stopped", false)
        );
    }
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
    assert_eq!(
        state.messages.len(),
        2,
        "the question stays, the answer is replaced"
    );
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
    assert!(
        chat.state().messages.is_empty(),
        "the thread is drawn only when the model is ready"
    );
}

// ---------------------------------------------------------------- proposals --

fn proposing() -> Chat {
    let mut chat = Chat::ready(script(&complete_dry_cleaning()));
    chat.say("complete the dry cleaning task");
    chat
}

fn card(chat: &Chat) -> wire::ChatPending {
    chat.state()
        .messages
        .last()
        .and_then(|m| m.pending.clone())
        .expect("a card")
}

fn task_status(chat: &Chat, title: &str) -> String {
    use centraid_assist::native::Door as _;
    use centraid_assist::native::door::text;
    let door = chat.driver.handle.assist_door();
    let titles: std::collections::BTreeMap<String, String> = door
        .table_where(
            "entity",
            "id, title, created_at",
            "created_at",
            "id",
            "kind = ?",
            &["task".to_owned()],
        )
        .unwrap()
        .iter()
        .filter_map(|row| Some((text(row, "id")?, text(row, "title")?)))
        .collect();
    door.table("task", "id, status", "id", "id")
        .unwrap()
        .iter()
        .find_map(|row| {
            (titles.get(&text(row, "id")?)? == title)
                .then(|| text(row, "status").unwrap_or_default())
        })
        .expect("the task")
}

#[test]
fn a_write_the_model_parks_is_a_card_in_the_cores_words_and_writes_nothing_until_the_tap() {
    let chat = proposing();
    let message = chat.state().messages.last().unwrap();
    assert_eq!(
        message.text,
        format!("Proposed: Complete task \"{DRY_CLEANING}\".")
    );
    let pending = card(&chat);
    assert_eq!(pending.state(), State::Waiting);
    assert_eq!(pending.steps.len(), 1);
    assert_eq!(
        pending.steps[0].summary,
        format!("Complete task \"{DRY_CLEANING}\"")
    );
    assert_eq!(
        (
            pending.confirm_label.as_str(),
            pending.cancel_label.as_str()
        ),
        ("Complete reminder", "Not now")
    );
    // THE STEP DRAWS AS THE BOARD'S ROW: the row's name, then its kind's plural and when it is.
    assert_eq!(pending.steps[0].title, DRY_CLEANING);
    assert!(
        pending.steps[0].subtitle.starts_with("Reminders"),
        "{}",
        pending.steps[0].subtitle
    );
    // THE CARD IS LABELLED AND COLOURED BY THE CORE (#1173): "Proposed change", in the colour of
    // the app whose row it changes (a task is Reminders'), and nothing is written yet.
    assert_eq!(pending.title, "Proposed change");
    assert_eq!(pending.app, "reminders");
    assert!(!pending.destructive && pending.more_line.is_empty());
    assert_eq!(task_status(&chat, DRY_CLEANING), "open");
}

#[test]
fn confirm_runs_the_card_once_and_draws_the_cores_line_with_an_undo_for_the_write() {
    let mut chat = proposing();
    let id = card(&chat).pending_id;
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: id.clone(),
    }));
    let pending = card(&chat);
    assert_eq!(pending.state(), State::Applied);
    assert_eq!(pending.settled_line, "Done.");
    assert_eq!(task_status(&chat, DRY_CLEANING), "done");
    // a second tap finds nothing waiting
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: id,
    }));
    assert_eq!(card(&chat).state(), State::Applied);
    // ONE UNDO FOR THE ONE WRITE, said as the board has it
    let pending = card(&chat);
    assert_eq!(pending.undo.len(), 1);
    assert_eq!(pending.undo[0].sentence, "Made by Chat");
    assert_eq!(pending.undo[0].action_label, "Undo");
}

fn undo(chat: &mut Chat, index: u32) {
    let id = card(chat).pending_id;
    chat.event(C::PendingUndone(wire::chat_event::PendingUndone {
        pending_id: id,
        index,
    }));
}

#[test]
fn undo_on_the_applied_card_takes_the_write_back_once_through_the_kits_door() {
    let mut chat = proposing();
    let id = card(&chat).pending_id;
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: id,
    }));
    assert_eq!(task_status(&chat, DRY_CLEANING), "done");
    undo(&mut chat, 0);
    assert_eq!(task_status(&chat, DRY_CLEANING), "open");
    let line = &card(&chat).undo[0];
    assert_eq!(
        (line.sentence.as_str(), line.action_label.as_str()),
        ("Undone", "")
    );
    // a second tap has nothing on offer, and an index no write has is not heard
    undo(&mut chat, 0);
    undo(&mut chat, 7);
    assert_eq!(task_status(&chat, DRY_CLEANING), "open");
    assert_eq!(card(&chat).undo[0].sentence, "Undone");
}

#[test]
fn an_undo_after_the_record_changed_again_is_refused_in_the_cores_words_and_the_key_is_gone() {
    use centraid_assist::native::Door as _;
    use centraid_assist::native::door::text;
    // a rename: its inverse names the version it made (`history.undo`), so a later change refuses it
    let mut chat = Chat::ready(script(&[step(
        "plan: rename",
        "act",
        &[
            ("verb", "edit"),
            ("kind", "task"),
            ("name", DRY_CLEANING),
            ("args", "name: Collect the dry cleaning"),
        ],
    )]));
    chat.say("rename the dry cleaning task");
    let id = card(&chat).pending_id;
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: id,
    }));
    assert_eq!(card(&chat).state(), State::Applied);
    let task = chat
        .driver
        .handle
        .assist_door()
        .table_where(
            "entity",
            "id, title, created_at",
            "created_at",
            "id",
            "kind = ?",
            &["task".to_owned()],
        )
        .unwrap()
        .iter()
        .find(|row| text(row, "title").as_deref() == Some("Collect the dry cleaning"))
        .and_then(|row| text(row, "id"))
        .expect("the renamed task");
    chat.driver
        .handle
        .command(
            "entity.retitle",
            &serde_json::json!({ "id": task, "title": "Dry cleaning, by hand" }),
            "by-hand",
        )
        .unwrap();
    undo(&mut chat, 0);
    let line = &card(&chat).undo[0];
    assert!(line.refused, "{line:?}");
    assert!(
        line.action_label.is_empty(),
        "no Undo key once it was refused"
    );
    assert_eq!(
        task_status(&chat, "Dry cleaning, by hand"),
        "open",
        "the later change stays"
    );
}

#[test]
fn cancel_settles_the_card_at_once_and_writes_nothing() {
    let mut chat = proposing();
    let id = card(&chat).pending_id;
    chat.event(C::PendingCancelled(wire::chat_event::PendingCancelled {
        pending_id: id.clone(),
    }));
    let pending = card(&chat);
    assert_eq!(pending.state(), State::NotDone);
    assert_eq!(pending.settled_line, "Not done.");
    assert_eq!(task_status(&chat, DRY_CLEANING), "open");
    // and the core no longer holds it
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: id,
    }));
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
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: id,
    }));
    assert_eq!(task_status(&chat, DRY_CLEANING), "open");
}

#[test]
fn taps_that_are_not_for_a_waiting_card_do_nothing() {
    let mut chat = proposing();
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: "other".to_owned(),
    }));
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: String::new(),
    }));
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
        door.table_where(
            "entity",
            "id, title, created_at",
            "created_at",
            "id",
            "kind = ?",
            &["task".to_owned()],
        )
        .unwrap()
        .iter()
        .find(|row| text(row, "title").as_deref() == Some(DRY_CLEANING))
        .and_then(|row| text(row, "id"))
        .unwrap()
    };
    let mut request =
        centraid_screens::catalog::act::reminders::CompleteTask { task_id: task }.request();
    request.invoke_key = "test:moved:1".to_owned();
    let moved = chat.driver.act(request);
    assert_eq!(moved.status, wire::ActStatus::Executed as i32, "{moved:?}");
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: id,
    }));
    let pending = card(&chat);
    assert_eq!(pending.state(), State::Stale);
    assert_eq!(pending.settled_line, "That changed since. Ask again.");
}

#[test]
fn a_sent_token_is_echoed_only_when_the_question_is_taken() {
    let mut chat = ready();
    // the shell kept the words as a draft and sent them under token 7
    chat.event(C::Sent(wire::chat_event::Sent {
        text: "tasks?".to_owned(),
        token: 7,
    }));
    assert_eq!(chat.state().accepted_send, 7);
    // a second send while the turn runs is refused, so its token is not echoed
    chat.event(C::Sent(wire::chat_event::Sent {
        text: "again".to_owned(),
        token: 8,
    }));
    assert_eq!(
        chat.state().accepted_send,
        7,
        "the draft stays for a refused send"
    );
    chat.perform();
    // a blank send is refused too; a suggestion's tap (token 0) never moves the echo
    chat.event(C::Sent(wire::chat_event::Sent {
        text: "  ".to_owned(),
        token: 9,
    }));
    assert_eq!(chat.state().accepted_send, 7);
    // before the model is ready nothing is taken
    let mut early = Chat::with(None);
    early.event(C::Sent(wire::chat_event::Sent {
        text: "early".to_owned(),
        token: 1,
    }));
    assert_eq!(early.state().accepted_send, 0);
}

#[test]
fn a_message_too_long_to_read_is_said_at_once_and_the_draft_stays() {
    let mut chat = ready();
    let long = "x".repeat(centraid_assist::native_turn::MESSAGE_MAX + 1);
    chat.event(C::Sent(wire::chat_event::Sent {
        text: long,
        token: 5,
    }));
    let state = chat.state();
    assert_eq!(
        state.error,
        "That is too long for Chat to read at once. Shorten it and try again."
    );
    assert!(state.messages.is_empty(), "nothing was sent");
    assert_eq!(state.accepted_send, 0, "so the shell keeps the draft");
}

fn edit_started(chat: &mut Chat) {
    chat.event(C::EditStarted(wire::chat_event::EditStarted {}));
}

#[test]
fn edit_is_offered_on_the_last_member_message_only_and_the_composer_takes_its_words() {
    let mut chat = proposing();
    let state = chat.state();
    let offered: Vec<(bool, i32)> = state
        .messages
        .iter()
        .map(|message| (message.can_edit, message.role))
        .collect();
    assert_eq!(
        offered.iter().filter(|(offer, _)| *offer).count(),
        1,
        "one message offers Edit: {offered:?}"
    );
    let at = state.messages.iter().position(|m| m.can_edit).unwrap();
    assert_eq!(
        state.messages[at].role,
        wire::chat_message::Role::User as i32
    );
    assert_eq!(state.edit_label, "Edit");
    assert!(!state.editing);

    let before = state.edit_token;
    edit_started(&mut chat);
    let state = chat.state();
    assert!(state.editing);
    assert_eq!(state.edit_text, state.messages[at].text);
    assert_ne!(
        state.edit_token, before,
        "the shell fills the composer on a new token"
    );
    assert_eq!(
        (state.editing_title.as_str(), state.editing_body.as_str()),
        (
            "Editing your question",
            "Chat’s answer to it is replaced when you send."
        )
    );
    assert!(
        state.messages.iter().all(|message| !message.can_edit),
        "no second Edit while one is open"
    );

    // the banner's cancel: the question is a message again and the composer is told to empty
    let opened = state.edit_token;
    chat.event(C::EditCancelled(wire::chat_event::EditCancelled {}));
    let state = chat.state();
    assert!(!state.editing && state.edit_text.is_empty());
    assert_ne!(state.edit_token, opened);
    assert_eq!(state.messages.len(), 2, "nothing was replaced");
}

#[test]
fn sending_an_edit_replaces_the_question_and_its_answer_and_leaves_an_applied_write_applied() {
    let mut chat = proposing();
    let id = card(&chat).pending_id;
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: id,
    }));
    assert_eq!(task_status(&chat, DRY_CLEANING), "done");
    edit_started(&mut chat);
    chat.event(C::Sent(wire::chat_event::Sent {
        text: "what is due this week?".to_owned(),
        token: 9,
    }));
    let state = chat.state();
    // the question and its answer were replaced, not added to
    let users: Vec<&str> = state
        .messages
        .iter()
        .filter(|message| message.role == wire::chat_message::Role::User as i32)
        .map(|message| message.text.as_str())
        .collect();
    assert_eq!(users, ["what is due this week?"]);
    assert_eq!(state.messages.len(), 2);
    assert!(!state.editing);
    assert_eq!(state.accepted_send, 9);
    // THE EARLIER ANSWER'S WRITE IS NOT UNDONE BY BEING REPLACED
    assert_eq!(task_status(&chat, DRY_CLEANING), "done");
}

#[test]
fn the_latest_key_has_its_words_from_the_core() {
    let chat = proposing();
    let state = chat.state();
    assert_eq!(
        (
            state.latest_label.as_str(),
            state.jump_to_latest_label.as_str()
        ),
        ("Latest", "Jump to latest")
    );
}
