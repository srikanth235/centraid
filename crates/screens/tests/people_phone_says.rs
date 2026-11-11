//! WHAT THE PHONE SAYS on a followed person's page (#1183): a line under each field the member's
//! edit holds apart from the phone's contacts, one tap to take the phone's value back, and nothing
//! anywhere else. Every test goes through `Driver`, the door a shell uses, over a vault seeded at a
//! fixed instant so no day of the week decides a result.

mod people_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::people;
use centraid_screens::testing::Driver;
use people_support::*;
use serde_json::json;

/// 2026-03-02 12:00 UTC.
const SEEDED_AT_MS: i64 = 1_772_452_800_000;

fn driver() -> Driver {
    let mut d = Driver::with_runtime_at(people::runtime(), SEEDED_AT_MS);
    d.start();
    d
}

/// The phone's address book states Ada, with a misspelt name, a role, a birthday, a number and an
/// email; the id of the person it made.
fn followed_ada(d: &Driver) -> String {
    arrange(
        d,
        act::people::FollowContacts {
            origin: json!({ "ref": "phone", "label": "Phone" }).to_string(),
            records: json!([{ "external_id": "c1", "fields": {
                "title": "Ada Lovelase", "role": "Colleague", "birthday": "12-09", "nickname": "Ada L",
                "points": [
                    { "kind": "phone", "value": "+44 7700 900123", "label": "mobile" },
                    { "kind": "email", "value": "ada@lovelace.example", "label": "work" }
                ] } }])
            .to_string(),
            complete: Some(true),
            since: None,
            ..Default::default()
        },
    );
    roster_of(d)
        .people
        .iter()
        .find(|row| row.name == "Ada Lovelase")
        .expect("the followed person")
        .party_id
        .clone()
}

fn edit(d: &Driver, id: &str, change: impl FnOnce(&mut act::people::EditPerson)) {
    let mut request = act::people::EditPerson {
        person_id: id.to_owned(),
        ..Default::default()
    };
    change(&mut request);
    arrange(d, request);
}

fn page(d: &mut Driver, id: &str) -> (u64, wire::PeoplePersonData) {
    let i = open_person(d, id, "Ada");
    let data = person_data(d.view(i)).clone();
    (i, data)
}

fn taken(d: &mut Driver, i: u64, line: &wire::PhoneSays) {
    d.send(
        i,
        wire::screen_event::Kind::PhoneSaysTaken(wire::PhoneSaysTaken {
            take: line.take.clone(),
        }),
    );
}

#[test]
fn a_person_nobody_edited_and_one_nothing_follows_show_no_line() {
    let mut d = driver();
    let id = followed_ada(&d);
    let (_, data) = page(&mut d, &id);
    assert!(data.name_phone_says.is_none() && data.role_phone_says.is_none());
    assert!(data.nickname_phone_says.is_none() && data.birthday_phone_says.is_none());
    assert!(data.channels_phone_says.is_empty());

    // A person of the member's own, edited, follows no phone: nothing to compare with.
    let mine = person(&d, "Katherine");
    edit(&d, &mine, |e| e.title = Some("Kat".to_owned()));
    let (_, data) = page(&mut d, &mine);
    assert!(data.name_phone_says.is_none() && data.channels_phone_says.is_empty());
}

#[test]
fn a_changed_field_says_what_the_phone_says_under_that_field_and_taking_it_removes_the_line() {
    let mut d = driver();
    let id = followed_ada(&d);
    edit(&d, &id, |e| {
        e.title = Some("Ada Lovelace".to_owned());
        e.role = Some("Friend".to_owned());
        e.nickname = Some("Countess".to_owned());
        e.birthday = Some("12-10".to_owned());
    });
    let (i, data) = page(&mut d, &id);
    assert_eq!(
        data.name, "Ada Lovelace",
        "the member's own value is what is drawn"
    );

    let name = data.name_phone_says.clone().expect("the name line");
    assert_eq!(name.lead, "Phone says Ada Lovelase");
    assert_eq!(name.action_label, "Use phone’s");
    assert_eq!(
        name.accessibility_label,
        "Use the name your phone has, Ada Lovelase"
    );
    let take = name.take.clone().expect("what to send back");
    assert_eq!((take.field.as_str(), take.item_key), ("title", None));
    assert_eq!(
        data.role_phone_says.as_ref().map(|l| l.lead.as_str()),
        Some("Phone says Colleague")
    );
    assert_eq!(
        data.nickname_phone_says.as_ref().map(|l| l.lead.as_str()),
        Some("Phone says Ada L")
    );
    let birthday = data.birthday_phone_says.clone().expect("the birthday line");
    assert_eq!(birthday.lead, "Phone says 9 December");
    assert_eq!(
        birthday.accessibility_label,
        "Use the birthday your phone has, 9 December"
    );

    // The tap takes the phone's name; the line goes, the others stay.
    taken(&mut d, i, &name);
    let data = person_data(d.view(i)).clone();
    assert_eq!(data.name, "Ada Lovelase");
    assert!(data.name_phone_says.is_none());
    assert!(
        data.role_phone_says.is_some()
            && data.nickname_phone_says.is_some()
            && data.birthday_phone_says.is_some()
    );
    assert!(person_state(d.view(i)).status.is_none());

    for line in [
        data.role_phone_says,
        data.nickname_phone_says,
        data.birthday_phone_says,
    ] {
        taken(&mut d, i, &line.expect("a line"));
    }
    let data = person_data(d.view(i)).clone();
    assert_eq!(
        (data.role.as_str(), data.channels_phone_says.len()),
        ("Colleague", 0)
    );
    assert!(
        data.role_phone_says.is_none()
            && data.nickname_phone_says.is_none()
            && data.birthday_phone_says.is_none()
    );
}

#[test]
fn a_changed_number_says_so_a_removed_one_is_still_the_phones_and_an_added_one_has_no_line() {
    let mut d = driver();
    let id = followed_ada(&d);
    let (_, data) = page(&mut d, &id);
    let channel = |kind: &str| {
        data.channels
            .iter()
            .find(|c| c.kind_label == kind)
            .expect("the channel")
            .channel_id
            .clone()
    };
    // The member removes the phone's number, relabels its email and adds an address.
    arrange(
        &d,
        act::people::DeleteContactChannel {
            point_id: channel("Phone"),
        },
    );
    arrange(
        &d,
        act::people::SaveContactChannel {
            contact_point_id: id.clone(),
            point_id: Some(channel("Email")),
            kind: act::people::SaveContactChannelKind::Email,
            value: "ada@lovelace.example".to_owned(),
            label: Field::Is("home".to_owned()),
            preferred: None,
        },
    );
    arrange(
        &d,
        act::people::SaveContactChannel {
            contact_point_id: id.clone(),
            kind: act::people::SaveContactChannelKind::Address,
            value: "12 Crescent Rd, London".to_owned(),
            ..Default::default()
        },
    );

    let (i, data) = page(&mut d, &id);
    let lines: Vec<(&str, &str, &str)> = data
        .channels_phone_says
        .iter()
        .map(|l| {
            (
                l.lead.as_str(),
                l.action_label.as_str(),
                l.accessibility_label.as_str(),
            )
        })
        .collect();
    assert_eq!(
        lines,
        [
            (
                "Phone says ada@lovelace.example (work)",
                "Use phone’s",
                "Use the email your phone has, ada@lovelace.example (work)"
            ),
            (
                "Phone still has +44 7700 900123 (mobile)",
                "Add back",
                "Add back the number +44 7700 900123 (mobile) from your phone"
            ),
        ],
        "one per changed or removed item; the added address has none"
    );
    assert_eq!(
        data.channels.len(),
        2,
        "the member's own channels are what is drawn"
    );

    // Add back restores the number and only that line goes.
    taken(&mut d, i, &data.channels_phone_says[1]);
    let data = person_data(d.view(i)).clone();
    assert_eq!(data.channels.len(), 3);
    assert_eq!(data.channels_phone_says.len(), 1);
    assert!(data.channels.iter().any(|c| c.value == "+44 7700 900123"));

    // Use phone’s on the email puts the phone's label back.
    taken(&mut d, i, &data.channels_phone_says[0]);
    let data = person_data(d.view(i)).clone();
    assert!(data.channels_phone_says.is_empty());
    assert!(data.channels.iter().any(|c| c.label == "work"));
}

#[test]
fn a_refused_take_is_a_sentence_over_the_page_as_it_still_is() {
    let mut d = driver();
    let id = followed_ada(&d);
    edit(&d, &id, |e| e.title = Some("Ada Lovelace".to_owned()));
    let (i, data) = page(&mut d, &id);
    let line = data.name_phone_says.expect("the line");

    // A field the phone never stated: the vault refuses, and the page says so.
    let mut bad = line.clone();
    bad.take.as_mut().expect("take").field = "no_such_field".to_owned();
    taken(&mut d, i, &bad);
    let state = person_state(d.view(i));
    let status = state.status.clone().expect("a sentence");
    assert!(status.refused && !status.sentence.trim().is_empty());
    let data = person_data(d.view(i));
    assert_eq!(data.name, "Ada Lovelace", "the page keeps its data");
    assert!(data.name_phone_says.is_some());
}

#[test]
fn the_roster_the_touch_view_and_search_carry_no_line() {
    let mut d = driver();
    let id = followed_ada(&d);
    edit(&d, &id, |e| e.title = Some("Ada Lovelace".to_owned()));
    let home = open_home(&mut d, wire::PeopleDestination::Unspecified);
    let drawn = format!("{:?}", d.view(home));
    assert!(drawn.contains("Ada Lovelace"));
    assert!(
        !drawn.contains("Phone says") && !drawn.contains("Use phone"),
        "the roster shows the member's value and no mark"
    );
    // Searching by the member's name finds the row, and the results carry no mark either.
    send_home(
        &mut d,
        home,
        wire::people_home_event::Kind::SearchOpened(wire::people_home_event::SearchOpened {}),
    );
    send_home(
        &mut d,
        home,
        wire::people_home_event::Kind::SearchTerm(wire::people_home_event::SearchTermChanged {
            term: "lovelace".into(),
        }),
    );
    let drawn = format!("{:?}", d.view(home));
    assert!(drawn.contains("Ada Lovelace"));
    assert!(!drawn.contains("Phone says") && !drawn.contains("Use phone"));
}
