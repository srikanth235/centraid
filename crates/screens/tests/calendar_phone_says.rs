//! WHAT THE PHONE SAYS on a followed event's page (#1183): a line under each field the member's edit
//! holds apart from the phone's calendar, one tap to take the calendar's value back, and nothing on
//! any list. Every test goes through `Driver`, the door a shell uses, over a vault seeded at a
//! fixed instant.

mod calendar_support;

use calendar_support::World;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::kit::schedule::rule_words::long_day;
use centraid_screens::strings::Locale;
use serde_json::{Value, json};
use wire::screen_event::Kind as E;

/// 2026-03-02 12:00 UTC.
const SEEDED_AT_MS: i64 = 1_772_452_800_000;
const DAY: &str = "2099-06-19";

fn world() -> World {
    World::seeded_at(SEEDED_AT_MS)
}

/// The phone's calendar states one meeting; its id.
fn follow(w: &mut World, fields: Value) -> String {
    let mut stated = json!({
        "title": "Design sync", "description": "agenda", "starts": "2099-06-19T09:00",
        "ends": "2099-06-19T10:00", "timing": "floating", "busy": 1, "reminders": [30]
    });
    for (name, value) in fields.as_object().expect("fields") {
        stated[name] = value.clone();
    }
    w.act(act::calendar::FollowCalendar {
        origin: json!({ "ref": "calendar:work", "label": "Work", "device_id": "phone-1" })
            .to_string(),
        records: json!([{ "external_id": "uid:1", "device_id": "phone-1", "fields": stated }])
            .to_string(),
        complete: Some(true),
        since: None,
        ..Default::default()
    });
    w.window("2099-06-19T00:00:00Z", "2099-06-20T00:00:00Z")
        .first()
        .expect("the followed event")
        .event_id
        .clone()
}

fn edit(w: &mut World, id: &str, change: impl FnOnce(&mut act::calendar::EditEvent)) {
    let mut request = act::calendar::EditEvent {
        event_id: id.to_owned(),
        ..Default::default()
    };
    change(&mut request);
    w.act(request);
}

fn taken(w: &mut World, page: u64, line: &wire::PhoneSays) {
    w.driver.send(
        page,
        E::PhoneSaysTaken(wire::PhoneSaysTaken {
            take: line.take.clone(),
        }),
    );
}

fn leads(lines: &[wire::PhoneSays]) -> Vec<&str> {
    lines.iter().map(|line| line.lead.as_str()).collect()
}

#[test]
fn an_event_nobody_edited_and_one_nothing_follows_show_no_line() {
    let mut w = world();
    let id = follow(&mut w, json!({}));
    let page = w.open_event(&id, &id, None, DAY);
    let data = w.event_data(page);
    assert!(data.title_phone_says.is_none() && data.notes_phone_says.is_none());
    assert!(data.when_phone_says.is_empty() && data.facts_phone_says.is_empty());
    assert!(data.guests_phone_says.is_empty());

    let own = w.propose("Own", "2099-06-19T12:00:00", "2099-06-19T13:00:00", |_| {});
    edit(&mut w, &own, |e| e.title = Some("Mine".to_owned()));
    let page = w.open_event(&own, &own, None, DAY);
    assert!(w.event_data(page).title_phone_says.is_none());
}

#[test]
fn a_changed_title_notes_alerts_and_availability_each_say_so_under_their_place() {
    let mut w = world();
    let id = follow(&mut w, json!({}));
    edit(&mut w, &id, |e| {
        e.title = Some("Design review".to_owned());
        e.description = Field::Is("agenda and notes".to_owned());
        e.reminders = Field::Is("[5, 60]".to_owned());
        e.busy = Some(false);
    });
    let page = w.open_event(&id, &id, None, DAY);
    let data = w.event_data(page).clone();
    assert_eq!(data.title, "Design review");
    let title = data.title_phone_says.clone().expect("the title line");
    assert_eq!(title.lead, "Phone says Design sync");
    assert_eq!(title.action_label, "Use phone’s");
    assert_eq!(
        title.accessibility_label,
        "Use the title your phone has, Design sync"
    );
    assert_eq!(
        data.notes_phone_says.as_ref().map(|l| l.lead.as_str()),
        Some("Phone says agenda")
    );
    assert_eq!(
        leads(&data.facts_phone_says),
        ["Phone says Busy", "Phone says 30 minutes before",],
        "availability, then alerts, in the order the facts are drawn"
    );

    // The tap takes the title back; the other lines stay until they are taken.
    taken(&mut w, page, &title);
    let data = w.event_data(page).clone();
    assert_eq!(data.title, "Design sync");
    assert!(data.title_phone_says.is_none());
    assert_eq!(data.facts_phone_says.len(), 2);
    for line in data
        .facts_phone_says
        .iter()
        .chain(data.notes_phone_says.iter())
    {
        taken(&mut w, page, line);
    }
    let data = w.event_data(page);
    assert!(data.notes_phone_says.is_none() && data.facts_phone_says.is_empty());
    assert!(w.event_state(page).status.is_none());
}

#[test]
fn a_moved_start_and_end_say_the_day_and_time_the_phone_has_and_taking_them_moves_the_event_back() {
    let mut w = world();
    let id = follow(&mut w, json!({}));
    edit(&mut w, &id, |e| {
        e.starts = Some("2099-06-19T11:00".to_owned());
        e.ends = Field::Is("2099-06-19T12:30".to_owned());
    });
    let page = w.open_event(&id, &id, None, DAY);
    let day = long_day(Locale::En, DAY);
    let data = w.event_data(page).clone();
    assert_eq!(
        leads(&data.when_phone_says),
        [
            format!("Phone says starts {day}, 09:00"),
            format!("Phone says ends {day}, 10:00"),
        ]
    );
    assert_eq!(
        data.when_phone_says[0].accessibility_label,
        format!("Use the time your phone has, starts {day}, 09:00")
    );
    taken(&mut w, page, &data.when_phone_says[0]);
    taken(&mut w, page, &data.when_phone_says[1]);
    let data = w.event_data(page);
    assert!(data.when_phone_says.is_empty());
    assert_eq!(data.when_label, "09:00 – 10:00");
}

#[test]
fn a_zoned_start_is_read_in_the_zone_it_is_in_and_says_so() {
    let mut w = world();
    // 09:00 in New York is 14:00 on a London wall clock in June.
    let id = follow(
        &mut w,
        json!({ "timing": "zoned", "zone": "America/New_York",
                "starts": "2099-06-19T09:00", "ends": "2099-06-19T10:00" }),
    );
    edit(&mut w, &id, |e| {
        e.starts = Some("2099-06-19T08:00".to_owned())
    });
    let page = w.open_event(&id, &id, None, DAY);
    let day = long_day(Locale::En, DAY);
    assert_eq!(
        leads(&w.event_data(page).when_phone_says),
        [format!("Phone says starts {day}, 09:00, New York, America")]
    );
}

#[test]
fn a_guest_whose_reply_changed_one_taken_off_and_one_added() {
    let mut w = world();
    let person = |w: &mut World, name: &str, email: &str| -> String {
        let done = w.act(act::people::AddPerson {
            title: name.to_owned(),
            ..Default::default()
        });
        let id = serde_json::from_slice::<Value>(&done.output).expect("json")["id"]
            .as_str()
            .expect("id")
            .to_owned();
        w.act(act::people::SaveContactChannel {
            contact_point_id: id.clone(),
            kind: act::people::SaveContactChannelKind::Email,
            value: email.to_owned(),
            ..Default::default()
        });
        id
    };
    let ann = person(&mut w, "Ann Lee", "ann@example.com");
    person(&mut w, "Priya Shah", "priya@example.com");
    let guest =
        |name: &str, email: &str| json!({ "name": name, "email": email, "state": "needs-action" });
    let id = follow(
        &mut w,
        json!({ "attendees": [guest("Ann Lee", "ann@example.com"), guest("Priya Shah", "priya@example.com")] }),
    );
    let page = w.open_event(&id, &id, None, DAY);
    assert!(w.event_data(page).guests_phone_says.is_empty());

    // Priya is taken off, the member adds someone the phone never named, and Ann replies.
    let other = person(&mut w, "Meera Rao", "meera@example.com");
    edit(&mut w, &id, |e| {
        e.attendees = Some(json!([ann.clone(), other]).to_string());
    });
    w.act(act::calendar::Rsvp {
        event_id: id.clone(),
        person_id: ann,
        state: act::calendar::RsvpState::Accepted,
    });
    let page = w.open_event(&id, &id, None, DAY);
    let lines = w.event_data(page).guests_phone_says.clone();
    assert!(!lines.is_empty(), "the guests differ from the phone's");
    assert!(
        lines.iter().all(|line| !line.lead.contains("Meera")),
        "a guest the member added has no line: {:?}",
        leads(&lines)
    );
    assert!(
        lines
            .iter()
            .any(|line| line.lead == "Phone says Ann Lee, No answer yet"
                && line.accessibility_label
                    == "Use the guest your phone has, Ann Lee, No answer yet"),
        "{:?}",
        leads(&lines)
    );
    let removed = lines
        .iter()
        .find(|line| line.lead == "Phone still has Priya Shah")
        .expect("Priya was taken off");
    assert_eq!(removed.action_label, "Add back");
    assert_eq!(
        removed.accessibility_label,
        "Add back the guest Priya Shah from your phone"
    );
    let before = lines.len();
    taken(&mut w, page, removed);
    assert_eq!(w.event_data(page).guests_phone_says.len(), before - 1);
}

#[test]
fn a_refused_take_is_a_sentence_over_the_event_as_it_still_is() {
    let mut w = world();
    let id = follow(&mut w, json!({}));
    edit(&mut w, &id, |e| e.title = Some("Design review".to_owned()));
    let page = w.open_event(&id, &id, None, DAY);
    let mut line = w.event_data(page).title_phone_says.clone().expect("line");
    line.take.as_mut().expect("take").field = "no_such_field".to_owned();
    taken(&mut w, page, &line);
    let status = w.event_state(page).status.clone().expect("a sentence");
    assert!(status.refused && !status.sentence.trim().is_empty());
    let data = w.event_data(page);
    assert_eq!(data.title, "Design review");
    assert!(data.title_phone_says.is_some());
}

#[test]
fn the_editor_and_the_lists_carry_no_line() {
    let mut w = world();
    let id = follow(&mut w, json!({}));
    edit(&mut w, &id, |e| e.title = Some("Design review".to_owned()));
    let editor = w.open_edit(&id, &id, None, DAY);
    let drawn = format!("{:?}", w.driver.view(editor));
    assert!(drawn.contains("Design review"));
    assert!(!drawn.contains("Phone says") && !drawn.contains("Use phone"));
    let window = w.window("2099-06-19T00:00:00Z", "2099-06-20T00:00:00Z");
    assert_eq!(window.len(), 1);
    assert_eq!(window[0].summary.as_deref(), Some("Design review"));
}
