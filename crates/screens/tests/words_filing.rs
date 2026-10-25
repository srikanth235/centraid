//! A vault on its own key is filed in the main vault's Locker after an unlock
//! (R-ONBOARD-10): the runtime relays Locker's `locker.unlocked` announcement to
//! the custody service, which files each pending key through the one write.

mod words_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::custody::secrets;
use centraid_screens::locker::routes;
use words_support::*;

const ID: &str = "0123456789abcdef";

fn waiting_phone(own_vault_in_front: bool) -> Phone {
    let mut phone = phone(routes::lock(), "ios");
    let device = &mut phone.shell.device;
    device.insert(secrets::PENDING_FILINGS.to_owned(), format!("{ID}\tFamily"));
    device.insert(
        format!("{}{ID}", secrets::LOCAL_OWN_WORDS_PREFIX),
        words_b().join(" "),
    );
    device.insert(format!("{}v-main", secrets::INDEX_PREFIX), "0".to_owned());
    device.insert(secrets::INDEX_HIGH_WATER.to_owned(), "0".to_owned());
    if own_vault_in_front {
        device.insert(format!("{}v-main", secrets::OWN_VAULT_PREFIX), ID.to_owned());
    }
    phone.keeper.set_foreground("v-main", "My vault");
    phone
}

fn unlock(phone: &mut Phone) {
    phone
        .driver
        .answer_effect(owner_checked(wire::owner_checked::Outcome::Succeeded));
    phone.serve();
}

#[test]
fn the_pending_key_is_filed_as_a_note_when_locker_unlocks_and_then_cleared() {
    let mut phone = waiting_phone(false);
    // Nothing is filed while the Locker is locked: the entry waits.
    assert!(phone.shell.device.contains_key(secrets::PENDING_FILINGS));
    unlock(&mut phone);
    assert!(
        !phone.shell.device.contains_key(secrets::PENDING_FILINGS),
        "the core took the note, so nothing is left to file"
    );
    // The note is in the Locker: its title names the vault, its content the words.
    let items = phone
        .driver
        .handle
        .locker_session(&wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::State(
                wire::LockerStateAsk {},
            )),
        })
        .expect("the session answers");
    assert_eq!(items.state, wire::LockerSessionState::Unlocked as i32);
}

#[test]
fn a_vault_on_its_own_key_in_front_is_no_main_vault_so_nothing_is_filed_there() {
    let mut phone = waiting_phone(true);
    unlock(&mut phone);
    assert!(
        phone.shell.device.contains_key(secrets::PENDING_FILINGS),
        "a key filed in a vault that needs its own key to open is lost with it"
    );
}

#[test]
fn an_entry_whose_words_were_never_kept_here_is_dropped_rather_than_retried_forever() {
    let mut phone = waiting_phone(false);
    phone
        .shell
        .device
        .remove(&format!("{}{ID}", secrets::LOCAL_OWN_WORDS_PREFIX));
    unlock(&mut phone);
    assert!(!phone.shell.device.contains_key(secrets::PENDING_FILINGS));
}
