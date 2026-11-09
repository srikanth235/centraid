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
    // This device follows from now on: the flag is kept off the vault, and the store watched.
    assert_eq!(kinds(&d), ["keychain:2", "watch:true"]);

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
fn a_device_that_imported_follows_a_burst_of_changes_as_one_silent_pass() {
    let mut d = clean();
    let i = begin(&mut d);
    // The keychain says this device imported: watch the store, and follow once at once.
    d.answer_effect(O::Keychain(wire::KeychainValue {
        found: true,
        value: b"1".to_vec(),
    }));
    assert_eq!(kinds(&d), ["watch:true"]);
    let watch = d.effects.remove(0);

    // A burst of store changes arms ONE two-second timer; the pass waits it out.
    for _ in 0..3 {
        d.send(
            i,
            wire::screen_event::Kind::EffectResult(wire::EffectResult {
                effect_id: watch.effect_id,
                outcome: Some(O::PhoneChanged(wire::PhoneChanged {
                    source: wire::ImportSource::Contacts as i32,
                })),
            }),
        );
    }
    assert!(d.effects.is_empty(), "nothing is read before the settle");
    d.pump(Duration::from_millis(2600));
    // A following pass never asks the OS for permission.
    assert_eq!(kinds(&d), ["read:ask=false"]);
    d.answer_effect(snapshot(vec![contact("Ana", "lookup:ana", "", "")]));
    assert!(d.effects.is_empty());
    // And it says nothing: a following pass is silent.
    assert_eq!(status(&d, i), "");
    d.pump(Duration::from_millis(300));
    assert_eq!(
        roster_of(&d)
            .people
            .iter()
            .map(|p| p.name.as_str())
            .collect::<Vec<_>>(),
        ["Ana"]
    );
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

    // Pause: the follow stops, the store is no longer watched, and the keychain says paused.
    send_home(&mut d, i, H::ContactsAction(ev::ContactsActionTapped {}));
    assert_eq!(kinds(&d), ["keychain:2", "watch:false"]);
    let paused = row(&d, i);
    assert_eq!(
        (paused.state, paused.action_label.as_str()),
        (State::Paused as i32, "Resume")
    );
    d.effects.clear();

    // Resume: watched again and a pass at once.
    send_home(&mut d, i, H::ContactsAction(ev::ContactsActionTapped {}));
    assert_eq!(kinds(&d), ["keychain:2", "watch:true"]);
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
