//! The task page says what the phone's Reminders say where the member's value differs (#1185),
//! with one tap to take the phone's value back.

mod reminders_support;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::{agenda, reminders};
use reminders_support::*;
use serde_json::json;

fn lines(d: &mut centraid_screens::testing::Driver, id: &str) -> (u64, Vec<wire::PhoneSays>) {
    let i = d.push(agenda::TAB, reminders::routes::task(id));
    (i, detail(d.view(i)).phone_says.clone())
}

#[test]
fn an_edited_followed_field_says_what_the_phone_says_and_taking_it_back_clears_the_line() {
    let mut d = reminders_driver();
    follow_reminders(
        &d,
        ("list:1", "Errands"),
        json!([{ "external_id": "r1", "fields": reminder_fields("Call mum", json!({ "priority": 3 })) }]),
        true,
    );
    let id = id_by_title(&d, "Call mum");
    assert!(lines(&mut d, &id).1.is_empty(), "nobody edited anything");
    arrange(
        &d,
        act::reminders::EditTask {
            task_id: id.clone(),
            title: Some("Phone mum".to_owned()),
            priority: Some(1),
            ..Default::default()
        },
    );
    let (page, says) = lines(&mut d, &id);
    let leads: Vec<&str> = says.iter().map(|line| line.lead.as_str()).collect();
    assert_eq!(leads, ["Phone says Call mum", "Phone says !!!"]);
    let title = says
        .iter()
        .find(|line| line.lead.ends_with("Call mum"))
        .unwrap();
    d.send(
        page,
        wire::screen_event::Kind::PhoneSaysTaken(wire::PhoneSaysTaken {
            take: title.take.clone(),
        }),
    );
    let after = detail(d.view(page)).phone_says.clone();
    assert_eq!(after.len(), 1);
    assert_eq!(task_of(&d, &id).title, "Call mum");
    let _ = (Field::<String>::Keep, reminders::EARLIER);
}

#[test]
fn a_flag_the_member_changed_says_what_the_phone_says_and_taking_it_flags_the_task_again() {
    let mut d = reminders_driver();
    follow_reminders(
        &d,
        ("list:1", "Errands"),
        json!([{ "external_id": "r1", "fields": reminder_fields("Call mum", json!({ "starred": true })) }]),
        true,
    );
    let id = id_by_title(&d, "Call mum");
    assert!(
        task_of(&d, &id).flagged,
        "flagged on the phone, starred here"
    );
    assert!(lines(&mut d, &id).1.is_empty(), "nobody changed the star");
    arrange(
        &d,
        act::reminders::UnstarTask {
            task_id: id.clone(),
        },
    );
    let (page, says) = lines(&mut d, &id);
    let leads: Vec<&str> = says.iter().map(|line| line.lead.as_str()).collect();
    assert_eq!(leads, ["Phone says flagged"]);
    d.send(
        page,
        wire::screen_event::Kind::PhoneSaysTaken(wire::PhoneSaysTaken {
            take: says[0].take.clone(),
        }),
    );
    assert!(task_of(&d, &id).flagged);
    assert!(detail(d.view(page)).phone_says.is_empty());
}
