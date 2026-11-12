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
fn a_due_the_member_moved_says_what_the_phone_says_in_the_words_and_zone_of_the_page() {
    let mut d = reminders_driver();
    d.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: "en-US".to_owned(),
        zone: "Pacific/Auckland".to_owned(),
        hour_cycle_12: true,
        ..Default::default()
    }));
    let weekday = |day: &str| {
        centraid_screens::kit::civil::relative_day(
            centraid_screens::strings::Locale::En,
            day,
            "2000-01-01",
        )
    };
    follow_reminders(
        &d,
        ("list:1", "Errands"),
        json!([
            // A wall clock the phone states with no zone: it is the member's own.
            { "external_id": "wall", "fields": reminder_fields("Wall", json!({ "due": "2099-03-02T09:30" })) },
            // An instant: 20:00 UTC is the next morning in Auckland.
            { "external_id": "instant", "fields": reminder_fields("Instant", json!({ "due": "2099-03-02T20:00:00Z" })) },
            { "external_id": "day", "fields": reminder_fields("Day", json!({ "due": "2099-03-02" })) },
        ]),
        true,
    );
    for title in ["Wall", "Instant", "Day"] {
        let id = id_by_title(&d, title);
        arrange(
            &d,
            act::reminders::EditTask {
                task_id: id.clone(),
                due: Field::Is("2099-06-01".to_owned()),
                ..Default::default()
            },
        );
    }
    let said = |d: &mut centraid_screens::testing::Driver, title: &str| {
        let id = id_by_title(d, title);
        lines(d, &id)
            .1
            .into_iter()
            .map(|line| line.lead)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        said(&mut d, "Wall"),
        [format!("Phone says {} 9:30 AM", weekday("2099-03-02"))]
    );
    assert_eq!(
        said(&mut d, "Instant"),
        [format!("Phone says {} 9:00 AM", weekday("2099-03-03"))]
    );
    assert_eq!(
        said(&mut d, "Day"),
        [format!("Phone says {}", weekday("2099-03-02"))]
    );
}
