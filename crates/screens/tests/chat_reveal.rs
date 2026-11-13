//! A Locker secret shown on the chat card (#1188): the card's Reveal asks the phone's owner check,
//! the core reads the value, the card shows it, and it is kept nowhere: not in the prompt, not in
//! the saved turn, not after a relock or a leave.

mod chat_support;
mod locker_support;

use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_assist::testing::ScriptedModel;
use centraid_screens::catalog::act;
use chat_support::{Chat, step};
use locker_support::{arrange, checked, login, passed};
use wire::chat_event::Kind as C;

const SECRET: &str = "correct horse";

fn reveal_script() -> Arc<ScriptedModel> {
    Arc::new(ScriptedModel::new(step(
        "plan: secret",
        "act",
        &[
            ("verb", "reveal"),
            ("kind", "locker_item"),
            ("name", "bank"),
            ("args", "field: password"),
        ],
    )))
}

/// A chat over a vault with one login, asked to show its password: the card is on screen, shut.
fn asked() -> (Chat, Arc<ScriptedModel>) {
    let model = reveal_script();
    let mut chat = Chat::keyed(model.clone());
    login(&chat.driver, "i1", "Bank");
    chat.say("what is my bank password?");
    (chat, model)
}

fn card(chat: &Chat) -> wire::ChatCard {
    chat.state()
        .messages
        .last()
        .and_then(|message| message.cards.first().cloned())
        .expect("a card")
}

fn row(chat: &Chat) -> wire::LockerFieldRow {
    card(chat).reveal.expect("the card carries a sealed row")
}

fn verb(chat: &mut Chat, key: &str) {
    let id = chat.state().messages.last().unwrap().id;
    chat.event(C::RevealVerb(wire::chat_event::RevealVerb {
        message_id: id,
        index: 0,
        key: key.to_owned(),
    }));
}

fn owner_checks(chat: &Chat) -> usize {
    chat.asked(|kind| matches!(kind, wire::effect::Kind::OwnerCheck(c) if c.ask).then_some(()))
        .len()
}

fn everything(chat: &Chat) -> String {
    format!("{:?}", chat.state())
}

#[test]
fn a_reveal_shows_only_after_the_owner_check_and_a_cancel_shows_nothing() {
    let (mut chat, _) = asked();
    // The card offers a Reveal over a mask: no value, no page to open.
    let shut = row(&chat);
    assert!(
        shut.value.is_empty() && shut.sealed && !shut.revealed,
        "{shut:?}"
    );
    assert_eq!(shut.verbs.first().map(|v| v.key.as_str()), Some("reveal"));
    assert_eq!(shut.verbs.first().map(|v| v.label.as_str()), Some("Reveal"));
    assert!(!everything(&chat).contains(SECRET));

    // Tapped with the wall shut: the owner check is asked, and nothing shows before it answers.
    verb(&mut chat, "reveal");
    assert_eq!(owner_checks(&chat), 1);
    assert!(!everything(&chat).contains(SECRET));

    // A cancel shows nothing and says nothing: not a failure.
    chat.driver
        .answer_effect(checked(wire::owner_checked::Outcome::Cancelled));
    assert!(row(&chat).value.is_empty());
    assert!(card(&chat).note.is_empty(), "{:?}", card(&chat).note);

    // Passed: the value is on the card, with Copy and Conceal and its countdown note.
    verb(&mut chat, "reveal");
    chat.driver.answer_effect(passed(wire::Biometry::Face));
    let shown = row(&chat);
    assert!(shown.revealed && shown.value == SECRET, "{shown:?}");
    let keys: Vec<&str> = shown.verbs.iter().map(|v| v.key.as_str()).collect();
    assert_eq!(keys, ["copy", "conceal"]);
    // The screen is shielded from capture while it shows.
    assert!(
        chat.asked(|kind| match kind {
            wire::effect::Kind::ScreenshotShield(s) => Some(s.on),
            _ => None,
        })
        .contains(&true)
    );

    // Conceal puts it away; a second Reveal with the Locker still open asks no second check.
    verb(&mut chat, "conceal");
    assert!(row(&chat).value.is_empty());
    let asks = owner_checks(&chat);
    verb(&mut chat, "reveal");
    assert_eq!(owner_checks(&chat), asks);
    assert_eq!(row(&chat).value, SECRET);
}

#[test]
fn a_phone_that_refuses_the_member_is_counted_and_said_on_the_card() {
    let (mut chat, _) = asked();
    verb(&mut chat, "reveal");
    chat.driver
        .answer_effect(checked(wire::owner_checked::Outcome::Failed));
    assert!(row(&chat).value.is_empty());
    assert!(!card(&chat).note.is_empty());
    let state = locker_support::session(
        &chat.driver,
        wire::locker_session_request::Step::State(wire::LockerStateAsk::default()),
    );
    assert_eq!(state.failed_unlocks, 1);
}

#[test]
fn the_revealed_value_is_in_no_prompt_and_no_saved_turn() {
    let (mut chat, model) = asked();
    verb(&mut chat, "reveal");
    chat.driver.answer_effect(passed(wire::Biometry::Face));
    assert_eq!(row(&chat).value, SECRET);

    // Nothing the model was shown holds it.
    assert!(
        model
            .prompts()
            .iter()
            .all(|prompt| !prompt.contains(SECRET))
    );
    // Nothing on the thread holds it: the saved messages and their cards.
    let thread = chat.state().thread_id.clone();
    assert!(!thread.is_empty());
    let message = chat.state().messages.last().unwrap().clone();
    assert!(!message.text.contains(SECRET));
    assert!(
        message
            .cards
            .iter()
            .all(|c| c.title != SECRET && c.subtitle != SECRET && c.meta != SECRET)
    );

    // Reopening the thread shows the card with Reveal again, not the value.
    chat.event(C::NewChat(wire::chat_event::NewChat {}));
    chat.event(C::ThreadOpened(wire::chat_event::ThreadOpened {
        thread_id: thread,
        title: String::new(),
    }));
    chat.perform();
    assert!(!everything(&chat).contains(SECRET));
    let reopened = row(&chat);
    assert!(reopened.value.is_empty());
    assert_eq!(reopened.verbs[0].key, "reveal");
    // Search of the chats holds none either.
    chat.event(C::DrawerSearchOpened(
        wire::chat_event::DrawerSearchOpened {},
    ));
    chat.event(C::DrawerSearchTerm(wire::chat_event::DrawerSearchTerm {
        term: SECRET.to_owned(),
    }));
    assert!(!everything(&chat).contains(SECRET));
}

#[test]
fn a_relock_or_leaving_drops_the_value() {
    for leave in ["background", "relock", "tab", "new chat"] {
        let (mut chat, _) = asked();
        verb(&mut chat, "reveal");
        chat.driver.answer_effect(passed(wire::Biometry::Face));
        assert_eq!(row(&chat).value, SECRET, "{leave}");
        match leave {
            "background" => {
                chat.driver
                    .call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
                        foreground: false,
                    }));
            }
            "relock" => {
                locker_support::session(
                    &chat.driver,
                    wire::locker_session_request::Step::Relock(wire::LockerRelock {}),
                );
                chat.driver
                    .call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
                        foreground: false,
                    }));
            }
            "tab" => {
                chat.driver.send(
                    chat.id,
                    wire::screen_event::Kind::TabHidden(wire::TabHidden {}),
                );
            }
            _ => {
                chat.event(C::NewChat(wire::chat_event::NewChat {}));
            }
        }
        assert!(!everything(&chat).contains(SECRET), "{leave}");
        // The shield falls with the value.
        let last_shield = chat.asked(|kind| match kind {
            wire::effect::Kind::ScreenshotShield(s) => Some(s.on),
            _ => None,
        });
        assert_eq!(last_shield.last(), Some(&false), "{leave}");
    }
}

#[test]
fn an_item_deleted_since_makes_the_card_say_it_is_gone() {
    let (mut chat, _) = asked();
    arrange(
        &chat.driver,
        act::locker::TrashItem {
            locker_item_id: "i1".to_owned(),
        },
    );
    verb(&mut chat, "reveal");
    let gone = card(&chat);
    assert_eq!(gone.note, "This item is gone.");
    assert!(gone.reveal.is_none());
    assert_eq!(owner_checks(&chat), 0);
}

#[test]
fn a_one_time_code_shows_the_current_code_and_never_the_seed() {
    let mut chat = Chat::keyed(Arc::new(ScriptedModel::new(step(
        "plan: code",
        "act",
        &[
            ("verb", "reveal"),
            ("kind", "locker_item"),
            ("name", "mail"),
            ("args", "field: code"),
        ],
    ))));
    arrange(
        &chat.driver,
        act::locker::AddItem {
            title: "Mail".to_owned(),
            item_id: Some("i2".to_owned()),
            otp_seed: Some("JBSWY3DPEHPK3PXP".to_owned()),
            ..Default::default()
        },
    );
    chat.say("show my mail code");
    let shut = row(&chat);
    let keys: Vec<&str> = shut.verbs.iter().map(|v| v.key.as_str()).collect();
    assert_eq!(keys, ["code", "copy_code"]);
    verb(&mut chat, "code");
    chat.driver.answer_effect(passed(wire::Biometry::Face));
    let shown = row(&chat);
    assert!(shown.revealed && shown.countdown.is_some(), "{shown:?}");
    assert_eq!(shown.value.replace(' ', "").len(), 6, "{}", shown.value);
    assert!(!everything(&chat).contains("JBSWY3DPEHPK3PXP"));
}
