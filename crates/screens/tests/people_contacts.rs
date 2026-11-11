//! Contacts → People, imported and followed, through the door a shell uses: the
//! shell reads the OS (`ContactsRead`) and answers a snapshot; the rules (what to
//! import, how it maps, what the status line says, when a pass runs) are Rust's.
//! Ports `ContactsImport`'s rules and `ContactsFollowSpec`.

mod people_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::testing::Driver;
use people_support::*;
use wire::effect::Kind as F;
use wire::effect_result::Outcome as O;
use wire::people_home_event::{self as ev, Kind as H};

fn contact(name: &str, id: &str, phone: &str, birthday: &str) -> wire::PhoneContact {
    wire::PhoneContact {
        name: name.to_owned(),
        phones: if phone.is_empty() {
            vec![]
        } else {
            vec![phone.to_owned()]
        },
        birthday: birthday.to_owned(),
        phone_id: id.to_owned(),
        ..wire::PhoneContact::default()
    }
}

fn snapshot(contacts: Vec<wire::PhoneContact>) -> O {
    O::Contacts(wire::ContactsSnapshot {
        complete: true,
        device_id: "this-install".to_owned(),
        containers: Vec::new(),
        contacts,
    })
}

fn kinds(d: &Driver) -> Vec<String> {
    d.effects
        .iter()
        .map(
            |request| match request.effect.as_ref().and_then(|e| e.kind.as_ref()) {
                Some(F::ContactsRead(read)) => format!("read:ask={}", read.ask_permission),
                Some(F::Keychain(op)) => format!("keychain:{}", op.op),
                Some(F::PhoneWatch(watch)) => format!("watch:{}", watch.on),
                other => format!("{other:?}"),
            },
        )
        .collect()
}

fn status(d: &Driver, i: u64) -> String {
    home_state(d.view(i))
        .status
        .as_ref()
        .map(|status| status.sentence.clone())
        .unwrap_or_default()
}

/// Answer the flag the home asks first (is this device following?): not yet.
fn not_following(d: &mut Driver) {
    d.answer_effect(O::Keychain(wire::KeychainValue {
        found: false,
        value: Vec::new(),
    }));
}

#[test]
fn the_day_one_tap_reads_the_address_book_and_a_snapshot_becomes_people() {
    let mut d = clean();
    let i = begin(&mut d);
    // The home asked whether this device follows; the answer is no.
    assert_eq!(kinds(&d), ["keychain:1"]);
    not_following(&mut d);
    assert!(d.effects.is_empty());

    send_home(&mut d, i, H::ImportContacts(ev::ImportContactsTapped {}));
    assert_eq!(status(&d, i), "Importing contacts");
    // The member's tap may ask the OS for permission.
    assert_eq!(kinds(&d), ["read:ask=true"]);
    // A second tap while one runs is nothing: it would write every person twice.
    send_home(&mut d, i, H::ImportContacts(ev::ImportContactsTapped {}));
    assert_eq!(kinds(&d), ["read:ask=true"]);

    d.answer_effect(snapshot(vec![
        contact("  Ada   Lovelace ", "lookup:ada", "555 0100", "12-10"),
        contact("Sam Park", "local:sam", "", ""),
        contact("", "lookup:nameless", "", ""),
    ]));
    assert_eq!(status(&d, i), "2 people imported");
    // This device follows from now on: the flag is kept off the vault. The store is watched and
    // read by the follow coordinator, not by this screen.
    assert_eq!(kinds(&d), ["keychain:2"]);

    let names: Vec<String> = roster_of(&d)
        .people
        .iter()
        .map(|p| p.name.clone())
        .collect();
    assert_eq!(names, ["Ada Lovelace", "Sam Park"]);
    let ada = roster_of(&d)
        .people
        .into_iter()
        .find(|p| p.name == "Ada Lovelace")
        .unwrap();
    let sheet = sheet_of(&d, &ada.party_id).sheet.unwrap();
    assert!(
        sheet
            .channels
            .iter()
            .any(|c| c.kind == "phone" && c.value == "555 0100")
    );
    // The birthday came with it, as a date the person page shows.
    assert!(sheet.dates.iter().any(|date| date.month_day == "12-10"));
    // The roster reads again by itself.
    d.pump(Duration::from_millis(300));
    assert_eq!(flat(roster_data(d.view(i))).len(), 2);
}

#[test]
fn an_import_the_os_refuses_says_where_to_turn_it_on_and_an_empty_phone_says_add_an_account() {
    let mut d = clean();
    let i = begin(&mut d);
    not_following(&mut d);

    send_home(&mut d, i, H::ImportContacts(ev::ImportContactsTapped {}));
    d.answer_effect(O::Failed(wire::EffectFailed {
        reason: "contacts access not given".into(),
        denied: true,
        cancelled: false,
    }));
    assert_eq!(
        status(&d, i),
        "Contacts access is off. Turn it on in Settings."
    );
    // Nothing is followed, and nothing is watched.
    assert!(d.effects.is_empty());

    send_home(&mut d, i, H::ImportContacts(ev::ImportContactsTapped {}));
    d.answer_effect(snapshot(Vec::new()));
    assert!(
        status(&d, i).starts_with("No contacts found."),
        "{}",
        status(&d, i)
    );
    assert!(
        d.effects.is_empty(),
        "no account, no following: {:?}",
        kinds(&d)
    );
}

#[test]
fn a_device_that_imported_asks_the_phone_nothing_from_the_home() {
    let mut d = clean();
    let i = begin(&mut d);
    // The keychain says this device imported: the home only knows it, to draw the row. Watching
    // the store and reading it are the follow coordinator's (`follow_coordinator.rs`: a burst of
    // changes is one pass, a pass never asks the OS), whichever screen is showing.
    d.answer_effect(O::Keychain(wire::KeychainValue {
        found: true,
        value: b"1".to_vec(),
    }));
    assert!(d.effects.is_empty(), "{:?}", kinds(&d));
    d.pump(Duration::from_millis(2_600));
    assert!(d.effects.is_empty(), "{:?}", kinds(&d));
    assert_eq!(status(&d, i), "", "and says nothing");
}

fn row(d: &Driver, i: u64) -> wire::PeopleContactsRow {
    home_state(d.view(i)).contacts.clone().expect("the row")
}

#[test]
fn the_phone_contacts_row_says_on_off_paused_and_no_access_and_its_action_fits() {
    use wire::people_contacts_row::State;
    let mut d = clean();
    let i = begin(&mut d);
    not_following(&mut d);
    // Never turned on: Off, and the action turns it on (the import, which may ask the OS).
    let off = row(&d, i);
    assert_eq!(
        (
            off.state,
            off.state_label.as_str(),
            off.action_label.as_str()
        ),
        (State::Off as i32, "Off", "Turn on")
    );
    send_home(&mut d, i, H::ContactsAction(ev::ContactsActionTapped {}));
    assert_eq!(kinds(&d), ["read:ask=true"]);
    d.answer_effect(snapshot(vec![
        contact("Ada Lovelace", "lookup:ada", "555 0100", ""),
        contact("Sam Park", "local:sam", "", ""),
    ]));
    let on = row(&d, i);
    assert_eq!(on.state, State::Following as i32);
    assert_eq!(on.action_label, "Pause");
    assert!(on.detail.starts_with("2 followed"), "{}", on.detail);
    d.effects.clear();

    // Pause: the keychain says paused, and the coordinator's next pass finds it so and reads nothing.
    send_home(&mut d, i, H::ContactsAction(ev::ContactsActionTapped {}));
    assert_eq!(kinds(&d), ["keychain:2"]);
    let paused = row(&d, i);
    assert_eq!(
        (paused.state, paused.action_label.as_str()),
        (State::Paused as i32, "Resume")
    );
    d.effects.clear();

    // Resume: the keychain says so, and the coordinator is asked for a pass.
    send_home(&mut d, i, H::ContactsAction(ev::ContactsActionTapped {}));
    assert_eq!(kinds(&d), ["keychain:2"]);
    assert_eq!(row(&d, i).state, State::Following as i32);
}

#[test]
fn a_phone_that_refused_the_address_book_says_so_and_the_action_opens_settings() {
    use wire::people_contacts_row::State;
    let mut d = clean();
    let i = begin(&mut d);
    not_following(&mut d);
    send_home(&mut d, i, H::ImportContacts(ev::ImportContactsTapped {}));
    d.answer_effect(O::Failed(wire::EffectFailed {
        reason: "contacts access not given".into(),
        denied: true,
        cancelled: false,
    }));
    let denied = row(&d, i);
    assert_eq!(
        (
            denied.state,
            denied.state_label.as_str(),
            denied.action_label.as_str()
        ),
        (State::Denied as i32, "No access", "Settings")
    );
    d.effects.clear();
    send_home(&mut d, i, H::ContactsAction(ev::ContactsActionTapped {}));
    assert!(matches!(
        d.effects
            .last()
            .and_then(|e| e.effect.as_ref())
            .and_then(|e| e.kind.as_ref()),
        Some(F::VaultCommand(_))
    ));
}

fn stop_row(d: &Driver, i: u64) -> Option<wire::PeopleMoreRow> {
    home_state(d.view(i))
        .more_rows
        .iter()
        .find(|row| row.key == "stop")
        .cloned()
}

#[test]
fn stop_reading_is_offered_only_while_following_asks_in_the_shared_words_and_the_people_stay() {
    use wire::people_contacts_row::State;
    let mut d = clean();
    let i = begin(&mut d);
    not_following(&mut d);
    assert!(stop_row(&d, i).is_none(), "nothing is followed yet");

    send_home(&mut d, i, H::ImportContacts(ev::ImportContactsTapped {}));
    d.answer_effect(snapshot(vec![contact(
        "Ada Lovelace",
        "lookup:ada",
        "555 0100",
        "",
    )]));
    d.effects.clear();
    // The same words as Health's: "Stop reading {store}", on a row with no route of its own.
    let stop = stop_row(&d, i).expect("following: the row is there");
    assert_eq!(
        (stop.label.as_str(), stop.icon_key.as_str()),
        ("Stop reading Phone contacts", "Stop")
    );
    assert!(stop.route.is_none());
    assert!(home_state(d.view(i)).stop.is_none());

    // Tapping it asks first, in the shared sheet's words; dismissing keeps following.
    send_home(
        &mut d,
        i,
        H::MoreRow(ev::MoreRowPicked {
            key: "stop".to_owned(),
        }),
    );
    let confirm = home_state(d.view(i)).stop.clone().expect("asked first");
    assert_eq!(confirm.title, "Stop reading Phone contacts?");
    assert_eq!(
        confirm.body,
        "People stops reading Phone contacts on this phone. The people already here stay."
    );
    assert_eq!(confirm.confirm_label, "Stop reading");
    assert!(confirm.destructive);
    send_home(&mut d, i, H::StopDismissed(ev::StopDismissed {}));
    assert!(home_state(d.view(i)).stop.is_none());
    assert_eq!(row_state(&d, i), State::Following as i32);
    assert!(d.effects.is_empty());

    // Confirming retires the store: this device no longer follows, and the people stay.
    send_home(
        &mut d,
        i,
        H::MoreRow(ev::MoreRowPicked {
            key: "stop".to_owned(),
        }),
    );
    send_home(&mut d, i, H::StopConfirmed(ev::StopConfirmed {}));
    assert_eq!(kinds(&d), ["keychain:3"], "the habit is forgotten");
    assert!(home_state(d.view(i)).stop.is_none());
    assert_eq!(status(&d, i), "People stopped reading your phone contacts.");
    assert_eq!(row_state(&d, i), State::Off as i32);
    assert_eq!(row(&d, i).action_label, "Turn on");
    assert!(stop_row(&d, i).is_none());
    let names: Vec<String> = roster_of(&d)
        .people
        .iter()
        .map(|p| p.name.clone())
        .collect();
    assert_eq!(names, ["Ada Lovelace"]);
    // A confirm that was never asked stops nothing.
    d.effects.clear();
    send_home(&mut d, i, H::StopConfirmed(ev::StopConfirmed {}));
    assert!(d.effects.is_empty());
}

fn row_state(d: &Driver, i: u64) -> i32 {
    row(d, i).state
}
