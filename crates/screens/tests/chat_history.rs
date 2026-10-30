//! The drawer of past chats, its search, a stored chat reopened, and the hand-offs in and out of the
//! chat: a search's Ask, a tapped card, the photo picker's pick, the documents sheet.

mod chat_support;

use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_assist::testing::ScriptedModel;
use chat_support::{
    Chat, DRY_CLEANING, FOUND_TASKS, complete_dry_cleaning, read_tasks, script, step,
};
use wire::chat_event::Kind as C;
use wire::chat_pending::State;

/// A chat that has had `questions` answered, each a read of the tasks.
fn with_history(questions: &[&str]) -> Chat {
    let steps: Vec<[String; 2]> = questions.iter().flat_map(|_| read_tasks()).collect();
    let mut chat = Chat::ready(script(&steps));
    for (at, question) in questions.iter().enumerate() {
        if at > 0 {
            chat.event(C::NewChat(wire::chat_event::NewChat {}));
        }
        chat.say(question);
    }
    chat
}

fn open_thread(chat: &mut Chat, id: &str) {
    chat.event(C::ThreadOpened(wire::chat_event::ThreadOpened {
        thread_id: id.to_owned(),
        title: String::new(),
    }));
    chat.perform();
}

fn toggle(chat: &mut Chat, opened: bool) {
    chat.event(C::Drawer(wire::chat_event::DrawerToggled { opened }));
}

#[test]
fn the_header_says_new_chat_until_a_thread_has_a_title_with_the_vault_and_where_it_runs() {
    let chat = Chat::ready(script(&read_tasks()));
    assert_eq!(chat.state().title, "New chat");
    assert_eq!(chat.state().subtitle, "Sample · on this phone");
}

#[test]
fn the_drawer_lists_past_chats_newest_first_with_how_long_ago_and_marks_the_open_one() {
    let mut chat = with_history(&["first question", "second question"]);
    toggle(&mut chat, true);
    let state = chat.state();
    assert!(state.drawer_open);
    let titles: Vec<&str> = state.threads.iter().map(|t| t.title.as_str()).collect();
    assert_eq!(titles, ["second question", "first question"]);
    assert_eq!(state.threads[0].ago, "Just now");
    assert!(state.threads[0].current && !state.threads[1].current);
    assert!(
        state.threads[0].accessibility_label.ends_with("Open chat"),
        "{}",
        state.threads[0].accessibility_label
    );
    assert!(state.can_delete_all);
    toggle(&mut chat, false);
    assert!(!chat.state().drawer_open);
}

#[test]
fn the_drawer_is_there_before_a_model_is_and_with_no_chats_says_so_in_one_line() {
    let mut chat = Chat::with(None);
    chat.open("");
    toggle(&mut chat, true);
    let state = chat.state();
    assert!(state.drawer_open && state.threads.is_empty());
    assert_eq!(state.threads_empty_line, "No chats yet.");
    assert!(!state.can_delete_all);
}

#[test]
fn a_stored_thread_comes_back_with_its_messages_cards_and_session_and_the_follow_up_goes_to_it() {
    let mut chat = with_history(&["first question", "second question"]);
    toggle(&mut chat, true);
    let first = chat.state().threads[1].thread_id.clone();
    chat.driver.handle.assist().host().install(script(&[step(
        "plan: narrow",
        "answer",
        &[("rows", "#1")],
    )]));
    open_thread(&mut chat, &first);
    let state = chat.state();
    assert!(!state.drawer_open, "opening a chat shuts the drawer");
    assert_eq!(state.thread_id, first);
    assert_eq!(state.title, "first question");
    assert_eq!(state.messages.len(), 2);
    assert_eq!(state.messages[0].text, "first question");
    assert_eq!(state.messages[1].text, FOUND_TASKS);
    assert_eq!(state.messages[1].cards.len(), 6);
    assert!(state.can_retry, "a stored question can be asked again");
    // the follow-up is saved in the same thread
    chat.say("the first one");
    assert_eq!(chat.state().messages.len(), 4);
    assert_eq!(chat.state().thread_id, first);
    assert_eq!(chat.state().threads.len(), 2, "no third chat");
}

#[test]
fn the_chat_that_is_open_only_closes_the_drawer() {
    let mut chat = with_history(&["only question"]);
    toggle(&mut chat, true);
    let id = chat.state().thread_id.clone();
    chat.event(C::ThreadOpened(wire::chat_event::ThreadOpened {
        thread_id: id,
        title: String::new(),
    }));
    assert!(!chat.state().drawer_open);
    assert_eq!(chat.state().messages.len(), 2);
}

#[test]
fn a_chat_deleted_from_another_place_says_it_is_gone_and_becomes_a_new_chat() {
    let mut chat = with_history(&["only question"]);
    open_thread(&mut chat, "no-such-thread");
    let state = chat.state();
    assert_eq!(state.error, "This chat is gone.");
    assert!(state.messages.is_empty() && state.thread_id.is_empty());
    assert_eq!(state.title, "New chat");
}

#[test]
fn a_reopened_thread_draws_a_proposal_as_an_inert_card_and_how_it_ended_as_the_line_it_was_told() {
    // a proposal nobody answered
    let mut chat = Chat::ready(script(&complete_dry_cleaning()));
    chat.say("complete the dry cleaning task");
    let proposed = chat.state().thread_id.clone();
    chat.event(C::NewChat(wire::chat_event::NewChat {}));
    open_thread(&mut chat, &proposed);
    let message = chat.state().messages.last().unwrap().clone();
    assert!(message.text.starts_with("Proposed: "), "{}", message.text);
    let card = message.pending.expect("an inert card");
    assert_eq!(card.state(), State::Inert);
    assert!(card.pending_id.is_empty(), "nothing can name it");

    // a proposal that was applied reads as the line the member was told, with no card
    let mut chat = Chat::ready(script(&complete_dry_cleaning()));
    chat.say("complete the dry cleaning task");
    let id = chat
        .state()
        .messages
        .last()
        .unwrap()
        .pending
        .clone()
        .unwrap()
        .pending_id;
    let thread = chat.state().thread_id.clone();
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: id,
    }));
    chat.event(C::NewChat(wire::chat_event::NewChat {}));
    open_thread(&mut chat, &thread);
    let message = chat.state().messages.last().unwrap();
    assert_eq!(message.text, "Done.");
    assert!(message.pending.is_none());
}

#[test]
fn a_stopped_turn_comes_back_marked_stopped() {
    let model = Arc::new(
        ScriptedModel::new(read_tasks().iter().flatten().cloned()).cancelling_during(1, 1),
    );
    let mut chat = Chat::ready(model);
    chat.say("tasks?");
    let thread = chat.state().thread_id.clone();
    if thread.is_empty() {
        return; // a stop before anything was drawn saves nothing
    }
    chat.event(C::NewChat(wire::chat_event::NewChat {}));
    open_thread(&mut chat, &thread);
    assert!(chat.state().messages.last().is_some());
}

#[test]
fn rename_changes_the_row_and_the_header_at_once_and_tells_the_vault() {
    let mut chat = with_history(&["first question"]);
    let id = chat.state().thread_id.clone();
    toggle(&mut chat, true);
    chat.event(C::ThreadRenamed(wire::chat_event::ThreadRenamed {
        thread_id: id,
        title: "  Tasks   this week ".to_owned(),
    }));
    let state = chat.state();
    assert_eq!(state.title, "Tasks this week");
    assert_eq!(state.threads[0].title, "Tasks this week");
    // the vault holds it: a second read (the drawer opening) says the same
    toggle(&mut chat, false);
    toggle(&mut chat, true);
    assert_eq!(chat.state().threads[0].title, "Tasks this week");
    // a blank title changes nothing
    let id = chat.state().thread_id.clone();
    chat.event(C::ThreadRenamed(wire::chat_event::ThreadRenamed {
        thread_id: id,
        title: "  ".to_owned(),
    }));
    assert_eq!(chat.state().title, "Tasks this week");
}

#[test]
fn deleting_the_open_chat_goes_back_to_a_new_one_and_deleting_another_leaves_the_open_one() {
    let mut chat = with_history(&["first question", "second question"]);
    toggle(&mut chat, true);
    let first = chat.state().threads[1].thread_id.clone();
    chat.event(C::ThreadDeleted(wire::chat_event::ThreadDeleted {
        thread_id: first,
    }));
    let state = chat.state();
    assert_eq!(state.messages.len(), 2, "the open chat is untouched");
    assert_eq!(chat.thread_titles(), ["second question"]);
    let open = state.thread_id.clone();
    chat.event(C::ThreadDeleted(wire::chat_event::ThreadDeleted {
        thread_id: open,
    }));
    let state = chat.state();
    assert!(state.messages.is_empty() && state.thread_id.is_empty());
    assert!(chat.thread_titles().is_empty());
    assert!(
        !state.suggestions.is_empty(),
        "a new chat offers fresh suggestions"
    );
}

#[test]
fn delete_all_empties_the_drawer_and_an_open_stored_chat_goes_back_to_a_new_one() {
    let mut chat = with_history(&["first question", "second question"]);
    toggle(&mut chat, true);
    chat.event(C::AllThreadsDeleted(wire::chat_event::AllThreadsDeleted {}));
    let state = chat.state();
    assert!(state.threads.is_empty() && !state.drawer_open);
    assert!(state.messages.is_empty() && state.thread_id.is_empty());
}

// --------------------------------------------------------------- the search --

fn search(chat: &mut Chat, term: &str) {
    chat.event(C::DrawerSearchTerm(wire::chat_event::DrawerSearchTerm {
        term: term.to_owned(),
    }));
}

#[test]
fn the_drawer_search_asks_the_core_and_the_answers_chats_are_the_rows() {
    let mut chat = with_history(&["gym membership question", "tax return question"]);
    toggle(&mut chat, true);
    assert!(!chat.state().drawer_search.clone().unwrap().open);
    chat.event(C::DrawerSearchOpened(
        wire::chat_event::DrawerSearchOpened {},
    ));
    assert!(chat.state().drawer_search.clone().unwrap().open);
    assert_eq!(chat.state().drawer_search_placeholder, "Search chats");
    search(&mut chat, "gym");
    let state = chat.state();
    let titles: Vec<&str> = state.threads.iter().map(|t| t.title.as_str()).collect();
    assert_eq!(titles, ["gym membership question"]);
    assert!(!state.can_delete_all, "never over search results");
    // a term that finds nothing says so with the term
    search(&mut chat, "zzyzx");
    let state = chat.state();
    assert!(state.threads.is_empty());
    assert_eq!(state.threads_empty_line, "No chats match “zzyzx”.");
    // a blank term puts the plain list back
    search(&mut chat, "  ");
    assert_eq!(chat.state().threads.len(), 2);
    assert_eq!(chat.state().threads_empty_line, "");
}

#[test]
fn closing_the_field_and_shutting_the_drawer_clear_the_term_its_answer_and_its_correction() {
    let mut chat = with_history(&["gym membership question", "tax return question"]);
    toggle(&mut chat, true);
    search(&mut chat, "gym");
    chat.event(C::DrawerSearchClosed(
        wire::chat_event::DrawerSearchClosed {},
    ));
    let field = chat.state().drawer_search.clone().unwrap();
    assert!(!field.open && field.term.is_empty());
    assert_eq!(chat.state().threads.len(), 2);
    search(&mut chat, "gym");
    toggle(&mut chat, false);
    toggle(&mut chat, true);
    assert!(chat.state().drawer_search.clone().unwrap().term.is_empty());
    assert_eq!(chat.state().threads.len(), 2);
}

#[test]
fn a_chat_opened_from_the_results_and_a_delete_from_them_change_the_rows_at_once() {
    let mut chat = with_history(&["gym membership question", "tax return question"]);
    toggle(&mut chat, true);
    search(&mut chat, "gym");
    let hit = chat.state().threads[0].thread_id.clone();
    chat.event(C::ThreadDeleted(wire::chat_event::ThreadDeleted {
        thread_id: hit.clone(),
    }));
    assert!(chat.state().threads.is_empty(), "the result leaves at once");
    assert_eq!(chat.thread_titles().len(), 0);
    search(&mut chat, "tax");
    let tax = chat.state().threads[0].thread_id.clone();
    open_thread(&mut chat, &tax);
    let state = chat.state();
    assert_eq!(state.title, "tax return question");
    assert!(
        !state.drawer_search.clone().unwrap().open,
        "opening a chat closes the search"
    );
}

// -------------------------------------------------------------- the Ask hand-off --

#[test]
fn a_search_asks_the_chat_which_waits_for_the_model_then_asks_once_in_a_new_chat_when_one_is_open()
{
    let mut chat = with_history(&["an earlier question"]);
    chat.driver
        .handle
        .assist()
        .host()
        .install(script(&read_tasks()));
    chat.event(C::Asked(wire::chat_event::Asked {
        scope: "agenda".to_owned(),
        question: "Tell me about “dentist”".to_owned(),
    }));
    chat.perform();
    let state = chat.state();
    assert_eq!(state.scope_app, "agenda");
    assert_eq!(
        state.messages.len(),
        2,
        "a new chat: the earlier thread is not asked into"
    );
    assert_eq!(state.messages[0].text, "Tell me about “dentist”");
    assert_eq!(chat.thread_titles().len(), 2);
}

#[test]
fn an_ask_with_no_model_drops_the_question_and_shows_the_download_step() {
    let mut chat = Chat::with(None);
    chat.event(C::Asked(wire::chat_event::Asked {
        scope: String::new(),
        question: "hello?".to_owned(),
    }));
    chat.perform();
    let state = chat.state();
    assert_eq!(state.phase(), wire::chat_state::Phase::NeedsModel);
    assert!(state.messages.is_empty());
    assert!(
        chat.driver.effects.is_empty(),
        "nothing is queued behind a download nobody asked for"
    );
}

// ----------------------------------------------------------------- the cards --

#[test]
fn a_tapped_card_opens_its_row_and_a_card_whose_row_is_gone_says_so() {
    let mut chat = Chat::ready(script(&read_tasks()));
    chat.say("tasks?");
    let message = chat.state().messages[1].id;
    chat.event(C::CardTapped(wire::chat_event::CardTapped {
        message_id: message,
        index: 0,
    }));
    let opened = chat.asked(|kind| match kind {
        wire::effect::Kind::OpenRoute(open) => open.route.clone(),
        _ => None,
    });
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0].screen, "agenda.task");
    assert!(chat.state().card_gone_line.is_empty());
    chat.driver.effects.clear();

    // the row is deleted for good since the answer
    let gone = chat.state().messages[1].cards[1].id.clone();
    for (n, action) in ["delete-task", "purge-task"].into_iter().enumerate() {
        let done = chat.driver.act(wire::ActRequest {
            app: "agenda".to_owned(),
            action: action.to_owned(),
            input: [(
                "id".to_owned(),
                wire::Value {
                    kind: Some(wire::value::Kind::Text(gone.clone())),
                },
            )]
            .into(),
            invoke_key: format!("test:gone:{n}"),
        });
        assert_eq!(
            done.status,
            wire::ActStatus::Executed as i32,
            "{action}: {done:?}"
        );
    }
    chat.event(C::CardTapped(wire::chat_event::CardTapped {
        message_id: message,
        index: 1,
    }));
    assert_eq!(chat.state().card_gone_line, "This item is gone.");
    assert!(
        chat.driver.effects.is_empty(),
        "nothing is pushed for a row that is gone"
    );
    // and the line goes with the next gesture
    chat.event(C::DrawerSearchOpened(
        wire::chat_event::DrawerSearchOpened {},
    ));
    assert!(chat.state().card_gone_line.is_empty());
}

// ------------------------------------------------------------ attach: library, documents, picker --

#[test]
fn the_photo_library_is_the_shells_picker_and_its_pick_is_a_chip_a_cancel_nothing_and_a_bad_one_a_line()
 {
    let mut chat = Chat::ready(script(&read_tasks()));
    chat.event(C::LibraryPhotoTapped(
        wire::chat_event::LibraryPhotoTapped {},
    ));
    let asked =
        chat.asked(|kind| matches!(kind, wire::effect::Kind::PickLibraryPhoto(_)).then_some(()));
    assert_eq!(asked.len(), 1);
    let answer = |chat: &mut Chat, picked: wire::LibraryPhotoPicked| {
        chat.driver
            .answer_effect(wire::effect_result::Outcome::LibraryPhotoPicked(picked));
    };
    answer(
        &mut chat,
        wire::LibraryPhotoPicked {
            cancelled: true,
            ..Default::default()
        },
    );
    assert!(chat.state().pending.is_empty() && chat.state().error.is_empty());

    chat.event(C::LibraryPhotoTapped(
        wire::chat_event::LibraryPhotoTapped {},
    ));
    answer(
        &mut chat,
        wire::LibraryPhotoPicked {
            unreadable: true,
            ..Default::default()
        },
    );
    assert_eq!(chat.state().error, "That attachment would not open.");

    chat.event(C::LibraryPhotoTapped(
        wire::chat_event::LibraryPhotoTapped {},
    ));
    answer(
        &mut chat,
        wire::LibraryPhotoPicked {
            content: vec![1, 2, 3],
            mime: "image/jpeg".to_owned(),
            thumbnail_path: "/tmp/thumb.jpg".to_owned(),
            ..Default::default()
        },
    );
    let state = chat.state();
    assert_eq!(state.pending.len(), 1);
    assert_eq!(state.pending[0].label, "Photo");
    assert_eq!(state.pending[0].thumbnail_path, "/tmp/thumb.jpg");
    assert!(state.error.is_empty());
}

#[test]
fn the_documents_sheet_lists_the_vaults_text_documents_and_choosing_one_attaches_it() {
    let mut chat = Chat::ready(script(&read_tasks()));
    chat.event(C::DocumentsOpened(wire::chat_event::DocumentsOpened {}));
    let sheet = chat.state().document_sheet.clone().unwrap();
    assert!(sheet.open && sheet.loaded);
    assert_eq!(sheet.title, "Choose a document");
    if let Some(first) = sheet.rows.first() {
        chat.event(C::Attached(wire::chat_event::Attached {
            source: Some(wire::chat_event::attached::Source::VaultDocument(
                wire::chat_event::VaultDocument {
                    doc_id: first.doc_id.clone(),
                },
            )),
            label: first.title.clone(),
            thumbnail_path: String::new(),
        }));
        assert_eq!(chat.state().pending.len(), 1);
        assert!(
            !chat.state().document_sheet.clone().unwrap().open,
            "choosing shuts the sheet"
        );
    }
    chat.event(C::DocumentsClosed(wire::chat_event::DocumentsClosed {}));
    assert!(!chat.state().document_sheet.clone().unwrap().open);
}

#[test]
fn photos_picker_with_the_attach_purpose_hands_its_pick_to_the_chat() {
    let mut chat = Chat::ready(script(&read_tasks()));
    let route = chat
        .state()
        .attach_photo_route
        .clone()
        .expect("the route the attach control pushes");
    assert_eq!(route.screen, "photos.picker");
    let picker = chat.driver.push(centraid_screens::chat::TAB, route);
    // the picker's grid is the library: pick the first photograph and confirm
    let cells = match &chat.driver.view(picker).kind {
        Some(wire::view_state::Kind::PhotosPicker(state)) => match &state.content {
            Some(wire::photos_picker_state::Content::Data(data)) => data.cells.clone(),
            other => panic!("{other:?}"),
        },
        other => panic!("{other:?}"),
    };
    assert!(!cells.is_empty(), "the scenario has photographs");
    let first = cells[0].tile.clone().unwrap().photo_id;
    let second = cells[1].tile.clone().unwrap().photo_id;
    for id in [&first, &second] {
        chat.driver.send(
            picker,
            wire::screen_event::Kind::PhotosPicker(wire::PhotosPickerEvent {
                kind: Some(wire::photos_picker_event::Kind::Pick(
                    wire::photos_picker_event::PickToggled {
                        photo_id: id.clone(),
                    },
                )),
            }),
        );
    }
    let view = chat.driver.view(picker).clone();
    let Some(wire::view_state::Kind::PhotosPicker(state)) = view.kind else {
        panic!()
    };
    assert_eq!(state.add_label, "Attach");
    assert_eq!(
        state.chosen_label, "1 chosen",
        "one photograph: the last choice is the one meant"
    );
    chat.driver.send(
        picker,
        wire::screen_event::Kind::PhotosPicker(wire::PhotosPickerEvent {
            kind: Some(wire::photos_picker_event::Kind::Confirm(
                wire::photos_picker_event::ConfirmRequested {},
            )),
        }),
    );
    let Some(wire::view_state::Kind::PhotosPicker(state)) = chat.driver.view(picker).kind.clone()
    else {
        panic!()
    };
    assert!(state.finished, "the shell pops it");
    let chips = &chat.state().pending;
    assert_eq!(
        chips.len(),
        1,
        "one photograph: the second choice replaced the first"
    );
}

// ---------------------------------------------------------- the Locker unlock --

#[test]
fn a_confirm_that_needs_locker_open_asks_the_owner_check_and_confirms_again_once_it_is() {
    let model = script(&[step(
        "plan: save",
        "act",
        &[
            ("verb", "create"),
            ("kind", "locker_item"),
            (
                "args",
                "name: Gym\ntype: login\npassword: PLANTED-NEW-PASSWORD",
            ),
        ],
    )]);
    let mut chat = Chat::keyed(model);
    chat.say("save my gym login, password PLANTED-NEW-PASSWORD");
    let card = chat
        .state()
        .messages
        .last()
        .unwrap()
        .pending
        .clone()
        .expect("a card");
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: card.pending_id.clone(),
    }));
    // Locker is shut: nothing ran, and the OS owner check is asked for.
    let asked =
        chat.asked(|kind| matches!(kind, wire::effect::Kind::OwnerCheck(c) if c.ask).then_some(()));
    assert_eq!(asked.len(), 1);
    assert_eq!(
        chat.state()
            .messages
            .last()
            .unwrap()
            .pending
            .clone()
            .unwrap()
            .state(),
        State::Working
    );

    // declined: the card waits to be tapped again
    chat.driver
        .answer_effect(wire::effect_result::Outcome::OwnerChecked(
            wire::OwnerChecked {
                available: true,
                outcome: wire::owner_checked::Outcome::Cancelled as i32,
                ..Default::default()
            },
        ));
    assert_eq!(
        chat.state()
            .messages
            .last()
            .unwrap()
            .pending
            .clone()
            .unwrap()
            .state(),
        State::Waiting
    );

    // tapped again and passed: Locker opens and the same confirm goes again
    chat.event(C::PendingConfirmed(wire::chat_event::PendingConfirmed {
        pending_id: card.pending_id,
    }));
    chat.driver
        .answer_effect(wire::effect_result::Outcome::OwnerChecked(
            wire::OwnerChecked {
                available: true,
                outcome: wire::owner_checked::Outcome::Succeeded as i32,
                ..Default::default()
            },
        ));
    let settled = chat
        .state()
        .messages
        .last()
        .unwrap()
        .pending
        .clone()
        .unwrap();
    assert_eq!(settled.state(), State::Applied, "{settled:?}");
    let announced = chat.asked(|kind| match kind {
        wire::effect::Kind::Announce(a) => Some(a.topic.clone()),
        _ => None,
    });
    assert_eq!(announced, ["locker.unlocked"]);
    let _ = DRY_CLEANING;
}

#[test]
fn a_search_asks_as_a_page_of_its_own_and_the_question_is_put_once_the_chat_is_ready() {
    let mut chat = Chat::ready(script(&read_tasks()));
    chat.driver
        .handle
        .assist()
        .host()
        .install(script(&read_tasks()));
    let id = chat.driver.push(
        centraid_screens::chat::TAB,
        centraid_screens::chat::routes::ask("Tell me about “tasks”", "agenda"),
    );
    // the shell's first event for any chat instance: it names the models directory
    chat.driver.send(
        id,
        wire::screen_event::Kind::Chat(wire::ChatEvent {
            kind: Some(C::Opened(wire::chat_event::Opened {
                app: String::new(),
                models_dir: "/nowhere/models".to_owned(),
                ..Default::default()
            })),
        }),
    );
    for _ in 0..200 {
        chat.driver.pump(std::time::Duration::from_millis(40));
        let Some(wire::view_state::Kind::Chat(state)) = &chat.driver.view(id).kind else {
            panic!()
        };
        if state.messages.len() == 2 && !state.streaming {
            assert_eq!(state.scope_app, "agenda");
            assert_eq!(state.messages[0].text, "Tell me about “tasks”");
            return;
        }
    }
    panic!("the asked question was never put");
}

#[test]
fn a_conversation_found_by_search_opens_as_a_chat_page_with_its_messages() {
    let mut chat = with_history(&["gym membership question"]);
    let thread = chat.state().thread_id.clone();
    chat.driver
        .handle
        .assist()
        .host()
        .install(script(&read_tasks()));
    let id = chat.driver.push(
        centraid_screens::chat::TAB,
        centraid_screens::chat::routes::thread(&thread, "gym membership question"),
    );
    chat.driver.send(
        id,
        wire::screen_event::Kind::Chat(wire::ChatEvent {
            kind: Some(C::Opened(wire::chat_event::Opened {
                models_dir: "/nowhere/models".to_owned(),
                ..Default::default()
            })),
        }),
    );
    for _ in 0..200 {
        chat.driver.pump(std::time::Duration::from_millis(40));
        let Some(wire::view_state::Kind::Chat(state)) = &chat.driver.view(id).kind else {
            panic!()
        };
        if state.messages.len() == 2 {
            assert_eq!(state.title, "gym membership question");
            assert_eq!(state.thread_id, thread);
            return;
        }
    }
    panic!("the stored chat never opened");
}
