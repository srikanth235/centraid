//! `words.show`: settings shows the 24 words again (#1047 E4, Q-1047-19). Ports
//! `WordsShowSpec`: the words are read only after the phone's owner check
//! passed, are on a secure screen only while shown, and are dropped on leaving.

mod words_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::custody::{routes, secrets};
use wire::owner_checked::Outcome as Checked;
use wire::words_show_event::Kind as K;
use wire::words_show_state::Phase;
use words_support::*;

fn show_phone() -> Phone {
    let mut phone = phone(routes::show(), "ios");
    phone
        .shell
        .device
        .insert(secrets::LOCAL_WORDS.to_owned(), words_a().join(" "));
    phone
        .shell
        .synced
        .insert(secrets::SEED_KEY.to_owned(), "cd".repeat(64));
    phone.serve();
    phone
}

fn answer_check(phone: &mut Phone, outcome: Checked) {
    phone.driver.answer_effect(owner_checked(outcome));
    phone.serve();
}

#[test]
fn opening_runs_the_owner_check_at_once_nothing_is_drawn_nothing_read_nothing_secret() {
    let phone = show_phone();
    // NO SCREEN BEFORE THE CHECK: the Backup tab's "Show recovery key" is
    // already the ask.
    let asked = phone.pending();
    let [wire::effect::Kind::OwnerCheck(check)] = asked.as_slice() else {
        panic!("the owner check is up: {asked:?}")
    };
    assert!(check.ask);
    assert_eq!(check.reason, "Show your recovery key");
    let state = phone.show();
    assert_eq!(state.phase, Phase::Ask as i32);
    assert!(state.check_now && !state.secure);
    assert_eq!((state.title.as_str(), state.body.as_str()), ("", ""));
    assert_eq!(state.primary_label, "");
    assert_eq!(state.secondary_label, "");
    assert!(state.words.is_empty());
}

#[test]
fn a_cancelled_owner_check_closes_there_is_no_screen_to_stay_on() {
    let mut phone = show_phone();
    answer_check(&mut phone, Checked::Cancelled);
    let state = phone.show();
    assert!(state.finished && state.words.is_empty());
}

#[test]
fn a_failed_owner_check_keeps_the_words_hidden_and_says_so_with_a_way_to_try_again() {
    let mut phone = show_phone();
    answer_check(&mut phone, Checked::Failed);
    let state = phone.show();
    assert_eq!(state.phase, Phase::Ask as i32);
    assert!(!state.check_now && !state.finished);
    assert_eq!(state.title, "Your recovery key");
    assert_eq!(
        state.notice,
        "Couldn't confirm it's you, so your recovery key stays hidden."
    );
    assert_eq!(state.primary_label, "Show recovery key");
    assert_eq!(state.secondary_label, "Cancel");
    assert!(state.words.is_empty());
    // Trying again from the drawn screen asks again; passing reads the store.
    phone.send_show(K::Primary(wire::WordsPrimary {}));
    assert!(matches!(
        phone.pending().as_slice(),
        [wire::effect::Kind::OwnerCheck(_)]
    ));
    answer_check(&mut phone, Checked::Succeeded);
    assert_eq!(phone.show().phase, Phase::Show as i32);
}

#[test]
fn verified_reads_the_store_the_words_show_on_a_secure_screen_and_saved_drops_them_and_records_it()
{
    let mut phone = show_phone();
    answer_check(&mut phone, Checked::Succeeded);
    let state = phone.show();
    assert_eq!(state.phase, Phase::Show as i32);
    assert!(state.secure);
    assert_eq!(state.words.len(), 24);
    assert_eq!(state.words[23].word, "art");
    assert_eq!(state.primary_label, "I've saved it");
    assert_eq!(state.save_label, "Save a copy");
    assert!(!phone.shell.device.contains_key(secrets::WORDS_SAVED));
    phone.send_show(K::SaveCopy(wire::WordsSaveCopy {}));
    let shared = phone.pending();
    assert!(matches!(
        shared.as_slice(),
        [wire::effect::Kind::Share(share)] if share.text == words_a().join(" ")
    ));
    phone.driver.effects.clear();
    // "I'VE SAVED IT": the words are dropped, the claim recorded, then it closes.
    phone.send_show(K::Primary(wire::WordsPrimary {}));
    let state = phone.show();
    assert!(state.finished && state.words.is_empty());
    assert!(phone.shell.device.contains_key(secrets::WORDS_SAVED));
}

#[test]
fn leaving_the_foreground_or_swiping_away_drops_the_words() {
    let mut phone = show_phone();
    answer_check(&mut phone, Checked::Succeeded);
    phone
        .driver
        .call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
            foreground: false,
        }));
    assert!(phone.show().finished && phone.show().words.is_empty());

    let mut swiped = show_phone();
    answer_check(&mut swiped, Checked::Succeeded);
    swiped.send_show(K::Dismissed(wire::WordsDismissed {}));
    assert!(swiped.show().finished && swiped.show().words.is_empty());
}

#[test]
fn no_words_here_a_synced_seed_says_where_they_are_and_no_seed_says_to_make_or_restore() {
    let mut synced = show_phone();
    synced.shell.device.remove(secrets::LOCAL_WORDS);
    answer_check(&mut synced, Checked::Succeeded);
    let state = synced.show();
    assert_eq!(state.phase, Phase::NoneHere as i32);
    assert_eq!(state.title, "No recovery key on this phone");
    assert!(
        state
            .body
            .starts_with("Your keychain gave this phone the key without its words.")
    );
    assert!(state.words.is_empty());
    assert_eq!(state.primary_label, "Done");

    let mut bare = show_phone();
    bare.shell.device.remove(secrets::LOCAL_WORDS);
    bare.shell.synced.clear();
    answer_check(&mut bare, Checked::Succeeded);
    assert_eq!(
        bare.show().body,
        "This phone has no recovery key yet. Make a vault or restore one first."
    );
}

#[test]
fn the_vault_in_front_on_its_own_words_shows_its_words_by_its_name() {
    let mut phone = show_phone();
    let id = "0123456789abcdef";
    phone.shell.device.insert(
        format!("{}v-family", secrets::OWN_VAULT_PREFIX),
        id.to_owned(),
    );
    phone.shell.device.insert(
        format!("{}{id}", secrets::LOCAL_OWN_SEED_PREFIX),
        "ee".repeat(64),
    );
    phone
        .shell
        .device
        .insert(secrets::LOCAL_OWN_INDEX.to_owned(), format!("{id}\tFamily"));
    phone.shell.device.insert(
        format!("{}{id}", secrets::LOCAL_OWN_WORDS_PREFIX),
        words_b().join(" "),
    );
    phone.keeper.set_foreground("v-family", "Family");
    answer_check(&mut phone, Checked::Succeeded);
    let state = phone.show();
    assert_eq!(state.title, "Recovery key for Family");
    assert_eq!(state.words[0].word, "zoo");
    // A VAULT'S OWN KEY claims nothing about the member's.
    assert_eq!(state.primary_label, "Done");
    phone.send_show(K::Primary(wire::WordsPrimary {}));
    assert!(phone.show().finished);
    assert!(!phone.shell.device.contains_key(secrets::WORDS_SAVED));

    // A VAULT ON THE MEMBER'S WORDS in front shows the member's.
    let mut member = show_phone();
    member.keeper.set_foreground("v-main", "My vault");
    answer_check(&mut member, Checked::Succeeded);
    assert_eq!(member.show().words[0].word, "abandon");
}
