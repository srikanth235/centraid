//! Calendar follows the phone one way, the vault's half (#1214): `follow.calendar` lands what the
//! phone states into a calendar of the vault that stands for the phone's calendar; the member's
//! edit stands over it field by field; nothing is ever written back. Each test plays the phone by
//! hand through the engine with the product's own map (`follow::SYSTEMS`).

mod common;

use common::world::World;
use serde_json::{Value, json};

fn read_into(
    w: &World,
    calendar: &str,
    color: Option<&str>,
    records: Vec<Value>,
    complete: bool,
) -> Value {
    let mut origin =
        json!({ "ref": format!("calendar:{calendar}"), "label": calendar, "device_id": "phone-1" });
    if let Some(color) = color {
        origin["color"] = json!(color);
    }
    w.ok(
        "follow.calendar",
        json!({ "origin": origin, "complete": complete, "records": records }),
    )
}

/// The phone calendar `work` read in full, stating `records`.
fn read(w: &World, records: Vec<Value>) -> Value {
    read_into(w, "work", None, records, true)
}

fn event_of(w: &World, uid: &str) -> String {
    w.one(
        "SELECT entity_id FROM source WHERE external_id = ?1",
        &[uid],
    )
}

fn meeting(uid: &str, title: &str) -> Value {
    json!({ "external_id": uid, "device_id": "phone-1", "fields": {
        "title": title, "starts": "2026-03-02T09:00", "ends": "2026-03-02T10:00",
        "timing": "floating", "description": "agenda", "rule": null, "busy": 1 } })
}

fn with(mut record: Value, field: &str, value: Value) -> Value {
    record["fields"][field] = value;
    record
}

fn deleted(w: &World, id: &str) -> bool {
    w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[id])
        .is_some()
}

fn alerts_of(w: &World, event: &str) -> i64 {
    w.vault()
        .read(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM alert a JOIN reminder r ON r.id = a.reminder_id WHERE r.entity_id = ?1",
                [event],
                |r| r.get(0),
            )?)
        })
        .expect("alerts")
}

#[test]
fn a_phone_change_the_vault_did_not_touch_lands_and_a_members_edit_stands() {
    let w = World::new("cal_follow_edit");
    read(&w, vec![meeting("uid:1", "Sync")]);
    let event = event_of(&w, "uid:1");
    // It is in the calendar that stands for the phone's, and read as its own record: Phone says.
    assert_eq!(
        w.one::<String>("SELECT e.title FROM entity e WHERE e.id = (SELECT parent_id FROM entity WHERE id = ?1)", &[&event]),
        "work"
    );
    read(
        &w,
        vec![with(
            meeting("uid:1", "Sync"),
            "description",
            json!("new agenda"),
        )],
    );
    assert_eq!(
        w.one::<String>("SELECT description FROM event WHERE id = ?1", &[&event]),
        "new agenda"
    );
    // The member edits the title field by field; the phone's next word on another field still lands.
    w.ok(
        "event.edit",
        json!({ "id": &event, "title": "Mine", "description": "mine" }),
    );
    read(
        &w,
        vec![with(
            meeting("uid:1", "Sync 2"),
            "ends",
            json!("2026-03-02T11:00"),
        )],
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&event]),
        "Mine"
    );
    assert_eq!(
        w.one::<String>("SELECT description FROM event WHERE id = ?1", &[&event]),
        "mine"
    );
    assert_eq!(
        w.one::<String>("SELECT ends FROM event WHERE id = ?1", &[&event]),
        "2026-03-02T11:00"
    );
    // The phone's word stays readable: "Phone says X".
    let says = w
        .vault()
        .read(|c| centraid_vault::commands::follow::differences(c, &event))
        .expect("differences");
    let fields: Vec<&str> = says.iter().map(|d| d.field.as_str()).collect();
    assert!(
        fields.contains(&"title") && fields.contains(&"description"),
        "{fields:?}"
    );
}

#[test]
fn a_phone_delete_trashes_an_untouched_event_and_only_forgets_an_edited_one() {
    let w = World::new("cal_follow_gone");
    read(
        &w,
        vec![
            meeting("uid:1", "Sync"),
            meeting("uid:2", "Other"),
            meeting("uid:3", "Third"),
        ],
    );
    let (untouched, edited) = (event_of(&w, "uid:1"), event_of(&w, "uid:3"));
    w.ok(
        "event.edit",
        json!({ "id": &edited, "description": "mine" }),
    );
    let told = read(&w, vec![meeting("uid:2", "Other")]);
    assert!(deleted(&w, &untouched), "the untouched event is trashed");
    assert!(!deleted(&w, &edited), "the edited event is kept");
    assert_eq!(told["forgotten"], 1);
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&edited]
        ),
        0
    );
    // Gone and back: the same record in a later read restores the row the follower trashed.
    read(
        &w,
        vec![meeting("uid:1", "Sync"), meeting("uid:2", "Other")],
    );
    assert!(!deleted(&w, &untouched), "back with the record");
    // What the member trashed stays trashed.
    let other = event_of(&w, "uid:2");
    w.ok("entity.trash", json!({ "id": &other }));
    read(
        &w,
        vec![meeting("uid:1", "Sync"), meeting("uid:2", "Other")],
    );
    assert!(deleted(&w, &other));
}

#[test]
fn a_phones_alerts_land_as_reminder_rows_the_members_change_stands_and_one_alert_sounds_per_thing()
{
    let w = World::new("cal_follow_alerts");
    let soon = |uid: &str, reminders: Value| {
        let mut record = with(meeting(uid, "Sync"), "reminders", reminders);
        record["fields"]["starts"] = json!("2099-03-02T09:00");
        record["fields"]["ends"] = json!("2099-03-02T10:00");
        record
    };
    read(&w, vec![soon("uid:1", json!([60, 10]))]);
    let event = event_of(&w, "uid:1");
    let leads = |w: &World| {
        w.one::<String>(
            "SELECT group_concat(offset_min) FROM (SELECT offset_min FROM reminder WHERE entity_id = ?1 ORDER BY offset_min)",
            &[&event],
        )
    };
    assert_eq!(leads(&w), "10,60");
    // The phone alerts for it: the vault's own alerts stay silent while it is what the phone stated.
    assert_eq!(
        alerts_of(&w, &event),
        0,
        "the phone's record is the phone's to alert"
    );
    // The member's change to the alerts is Centraid's: it alerts, and it stands over the phone's next word.
    w.ok("event.edit", json!({ "id": &event, "reminders": [5] }));
    assert_eq!(alerts_of(&w, &event), 1);
    read(&w, vec![soon("uid:1", json!([60, 10, 1440]))]);
    assert_eq!(leads(&w), "5");
    let refused = w.run(
        "follow.calendar",
        json!({ "origin": { "ref": "calendar:work", "label": "work", "device_id": "phone-1" },
                "complete": false,
                "records": [with(meeting("uid:9", "Bad"), "reminders", json!(["soon"]))] }),
    );
    assert_eq!(
        refused.output["refused"], 1,
        "an alert that is not minutes is left out"
    );
}

#[test]
fn a_phones_guests_are_guests_whether_or_not_they_are_in_people_and_follow_one_by_one() {
    let w = World::new("cal_follow_guests");
    let ann = w.person("Ann Lee");
    let point = w.mint();
    w.commit(|tx| {
        tx.connection().execute(
            "INSERT INTO contact_point (id, person_id, kind, value, normalized, position)
             VALUES (?1, ?2, 'email', 'Ann@Example.com', 'ann@example.com', 0)",
            rusqlite::params![point, ann],
        )?;
        Ok(())
    });
    let guests = json!([
        { "name": "Ann", "email": "Ann@example.com", "state": "accepted" },
        { "name": "Stranger", "email": "who@example.com", "state": "tentative" },
        { "name": "No email" }
    ]);
    read(
        &w,
        vec![with(meeting("uid:1", "Sync"), "attendees", guests)],
    );
    let event = event_of(&w, "uid:1");
    assert_eq!(
        w.strings(
            "SELECT address || '|' || status || '|' || ifnull(person_id, '-') FROM event_guest WHERE event_id = ?1 ORDER BY address",
            &[&event]
        ),
        vec![format!("ann@example.com|accepted|{ann}"), "who@example.com|tentative|-".to_owned()],
        "a matching address is that person's; one who is not in People is a guest all the same"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM person", &[]),
        2,
        "the owner and Ann: nobody is minted"
    );
    let stated: Value = serde_json::from_str(
        &w.one::<String>("SELECT stated FROM source WHERE entity_id = ?1", &[&event]),
    )
    .expect("json");
    assert_eq!(
        stated["attendees"].as_array().map(Vec::len),
        Some(3),
        "a guest with no address stays in the statement"
    );
    // The member answers for Ann and takes Stranger off; the phone's next word does not undo either.
    w.ok(
        "event.respond",
        json!({ "id": &event, "address": "ann@example.com", "status": "declined" }),
    );
    w.ok(
        "event.edit",
        json!({ "id": &event, "guests": [{ "address": "ann@example.com" }] }),
    );
    read(
        &w,
        vec![with(
            meeting("uid:1", "Sync"),
            "attendees",
            json!([
                { "name": "Ann", "email": "ann@example.com", "state": "accepted" },
                { "name": "Stranger", "email": "who@example.com", "state": "accepted" },
                { "name": "New", "email": "new@example.com", "state": "needs-action" }
            ]),
        )],
    );
    assert_eq!(
        w.strings(
            "SELECT address || '|' || status FROM event_guest WHERE event_id = ?1 ORDER BY address",
            &[&event]
        ),
        vec!["ann@example.com|declined", "new@example.com|needs-action"],
        "the member's answer and removal stand; a new guest lands"
    );
}

#[test]
fn a_phones_location_is_words_and_never_makes_a_place() {
    let w = World::new("cal_follow_location");
    let places = w.one::<i64>("SELECT COUNT(*) FROM entity WHERE kind = 'place'", &[]);
    read(
        &w,
        vec![with(
            meeting("uid:1", "Sync"),
            "location",
            json!("The depot"),
        )],
    );
    let event = event_of(&w, "uid:1");
    assert_eq!(
        w.one::<String>("SELECT location FROM event WHERE id = ?1", &[&event]),
        "The depot"
    );
    assert!(
        w.one::<Option<String>>("SELECT place_id FROM event WHERE id = ?1", &[&event])
            .is_none()
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE kind = 'place'", &[]),
        places
    );
}

// ---------------------------------------------------------------------------------------------
// A series' days
// ---------------------------------------------------------------------------------------------

fn series_fields(overrides: Value) -> Value {
    json!({
        "title": "Standup", "starts": "2026-03-02T09:00:00", "ends": "2026-03-02T09:30:00",
        "zone": "Europe/Paris", "rule": "FREQ=WEEKLY", "overrides": overrides,
    })
}

fn window(shown: &[&str], moved: Value) -> Value {
    json!({ "from": "2026-03-01T00:00:00Z", "to": "2026-04-01T00:00:00Z", "shown": shown, "moved": moved })
}

const WEEKS: [&str; 5] = [
    "2026-03-02T09:00:00",
    "2026-03-09T09:00:00",
    "2026-03-16T09:00:00",
    "2026-03-23T09:00:00",
    "2026-03-30T09:00:00",
];

fn standup(w: &World, fields: Value) -> Value {
    read(
        w,
        vec![json!({ "external_id": "uid:standup", "fields": fields })],
    )
}

fn days(w: &World, series: &str) -> Vec<(String, i64, Option<String>)> {
    w.vault()
        .read(|c| {
            Ok(c.prepare("SELECT original_start, cancelled, starts FROM occurrence WHERE series_id = ?1 ORDER BY 1")?
                .query_map([series], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?)
        })
        .expect("rows")
}

#[test]
fn a_followed_series_skips_what_the_phone_does_not_show_and_moves_what_it_moved() {
    let w = World::new("cal_follow_series");
    let shown: Vec<&str> = WEEKS
        .iter()
        .copied()
        .filter(|k| *k != "2026-03-09T09:00:00")
        .collect();
    let moved = json!([{ "original_start": "2026-03-16T09:00:00", "starts": "2026-03-16T14:00:00",
                          "ends": "2026-03-16T14:30:00", "title": "Standup", "location": "Room 4" }]);
    let told = standup(&w, series_fields(window(&shown, moved)));
    assert_eq!(told["added"], 1, "{told}");
    let id: String = w.one("SELECT entity_id FROM source", &[]);
    assert_eq!(
        w.one::<String>("SELECT starts FROM event WHERE id = ?1", &[&id]),
        "2026-03-02T08:00:00.000Z"
    );
    assert_eq!(
        w.one::<i64>("SELECT rule_supported FROM event WHERE id = ?1", &[&id]),
        1
    );
    // The days are keyed as the series' timing keys them: the instant of a zoned series' day.
    assert_eq!(
        days(&w, &id),
        [
            ("2026-03-09T08:00:00.000Z".to_owned(), 1, None),
            (
                "2026-03-16T08:00:00.000Z".to_owned(),
                0,
                Some("2026-03-16T13:00:00.000Z".to_owned())
            ),
        ]
    );
    assert_eq!(
        w.one::<Option<String>>(
            "SELECT title FROM occurrence WHERE series_id = ?1 AND cancelled = 0",
            &[&id]
        ),
        None,
        "the title it shares is not copied"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT location FROM occurrence WHERE series_id = ?1 AND cancelled = 0",
            &[&id]
        ),
        "Room 4",
        "a day's location is its own words"
    );
}

#[test]
fn the_phone_does_not_undo_a_day_the_member_changed_and_a_slid_window_forgets_nothing() {
    let w = World::new("cal_follow_slide");
    let shown: Vec<&str> = WEEKS
        .iter()
        .copied()
        .filter(|k| *k != "2026-03-09T09:00:00")
        .collect();
    standup(&w, series_fields(window(&shown, json!([]))));
    let id: String = w.one("SELECT entity_id FROM source", &[]);
    // The member brings the skipped week back, and skips another.
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-09T08:00:00.000Z", "action": "restore" }),
    );
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-23T08:00:00.000Z", "action": "skip" }),
    );
    standup(&w, series_fields(window(&shown, json!([]))));
    assert_eq!(
        days(&w, &id),
        [("2026-03-23T08:00:00.000Z".to_owned(), 1, None)]
    );
    // The phone now drops the 30th over a window that slid past the 2nd.
    let shown_now = [
        "2026-03-09T09:00:00",
        "2026-03-16T09:00:00",
        "2026-03-23T09:00:00",
    ];
    let slid = json!({ "from": "2026-03-08T00:00:00Z", "to": "2026-04-01T00:00:00Z", "shown": shown_now, "moved": [] });
    standup(&w, series_fields(slid));
    assert_eq!(
        days(&w, &id),
        [
            ("2026-03-23T08:00:00.000Z".to_owned(), 1, None),
            ("2026-03-30T07:00:00.000Z".to_owned(), 1, None),
        ]
    );
}

#[test]
fn a_phones_moved_day_keeps_its_timing_link_and_location_through_the_follower() {
    let w = World::new("cal_follow_moved_day");
    let series = |moved: Value| {
        json!({ "external_id": "uid:trash", "fields": {
            "title": "Trash day", "starts": "2026-03-02", "ends": "2026-03-02", "timing": "all-day",
            "zone": null, "rule": "FREQ=WEEKLY",
            "overrides": { "from": "2026-03-01T00:00:00Z", "to": "2026-03-31T00:00:00Z",
                            "shown": ["2026-03-02", "2026-03-16"], "moved": [moved] } } })
    };
    let day = |location: &str| {
        series(json!({
            "original_start": "2026-03-09", "timing": "floating",
            "starts": "2026-03-09T15:00:00", "ends": "2026-03-09T16:00:00",
            "title": "Trash day", "url": "https://meet.example/c", "location": location }))
    };
    read_into(&w, "home", None, vec![day("The depot")], true);
    let id: String = w.one("SELECT entity_id FROM source", &[]);
    assert_eq!(
        w.strings("SELECT ifnull(timing,'-') || '|' || ifnull(starts,'-') || '|' || ifnull(url,'-') || '|' || ifnull(location,'-') FROM occurrence WHERE series_id = ?1 AND cancelled = 0", &[&id]),
        vec!["floating|2026-03-09T15:00|https://meet.example/c|The depot"]
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM place", &[]),
        0,
        "a location makes no place"
    );
    // Said again: nothing to update.
    let told = read_into(&w, "home", None, vec![day("The depot")], true);
    assert_eq!(
        told["updated"].as_i64(),
        Some(0),
        "the same word is no change: {told}"
    );
}

// ---------------------------------------------------------------------------------------------
// The calendars the phone's calendars become
// ---------------------------------------------------------------------------------------------

fn dated(i: usize, calendar: &str) -> Value {
    json!({ "external_id": format!("uid:{calendar}{i}"), "fields": {
        "title": format!("{calendar} {i}"), "starts": format!("2026-03-{:02}T09:00:00", i + 1),
        "ends": format!("2026-03-{:02}T10:00:00", i + 1), "zone": "Europe/Paris" } })
}

#[test]
fn each_phone_calendar_is_a_calendar_of_the_vault_with_the_phones_colour() {
    let w = World::new("cal_follow_calendars");
    read_into(&w, "home", Some("teal"), vec![dated(1, "home")], true);
    read_into(&w, "work", Some("rose"), vec![dated(1, "work")], true);
    let own = "SELECT COUNT(*) FROM container WHERE kind = 'calendar' AND id <> 'calendar:default'";
    assert_eq!(w.one::<i64>(own, &[]), 2, "one calendar per phone calendar");
    let home: String = w.one("SELECT fills FROM origin WHERE ref = 'calendar:home'", &[]);
    assert_eq!(
        w.one::<String>("SELECT color FROM container WHERE id = ?1", &[&home]),
        "teal"
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&home]),
        "home"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT n.parent_id FROM entity n WHERE n.title = 'home 1'",
            &[]
        ),
        home,
        "the event is on its own calendar, not calendar:default"
    );
    read_into(&w, "home", Some("indigo"), vec![dated(1, "home")], true);
    assert_eq!(
        w.one::<String>("SELECT color FROM container WHERE id = ?1", &[&home]),
        "indigo"
    );
    assert_eq!(w.one::<i64>(own, &[]), 2);
}

#[test]
fn a_calendar_the_member_renamed_keeps_their_name_and_one_they_did_not_follows_the_phone() {
    let w = World::new("cal_follow_rename");
    read_into(&w, "home", None, vec![dated(1, "home")], true);
    read_into(&w, "work", None, vec![dated(1, "work")], true);
    let (home, work): (String, String) = (
        w.one("SELECT fills FROM origin WHERE ref = 'calendar:home'", &[]),
        w.one("SELECT fills FROM origin WHERE ref = 'calendar:work'", &[]),
    );
    w.ok("entity.retitle", json!({ "id": home, "title": "Family" }));
    for (calendar, label) in [("home", "iCloud: Home"), ("work", "iCloud: Work")] {
        w.ok(
            "follow.calendar",
            json!({ "origin": { "ref": format!("calendar:{calendar}"), "label": label, "device_id": "phone-1" },
                    "complete": true, "records": [dated(1, calendar)] }),
        );
    }
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&home]),
        "Family"
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&work]),
        "iCloud: Work"
    );
}

#[test]
fn a_calendar_that_lost_most_of_its_events_trashes_none_of_them() {
    let w = World::new("cal_follow_doubt");
    read_into(
        &w,
        "home",
        None,
        (1..=6).map(|i| dated(i, "home")).collect(),
        true,
    );
    read_into(&w, "work", None, vec![dated(1, "work")], true);
    let told = read_into(&w, "home", None, vec![dated(1, "home")], true);
    assert_eq!(told["doubted"].as_i64(), Some(5), "{told}");
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'event' AND deleted_at IS NOT NULL",
            &[]
        ),
        0
    );
}

#[test]
fn a_purged_phone_calendar_ends_its_follow_and_the_next_pass_makes_it_again() {
    let w = World::new("cal_follow_purge");
    read_into(&w, "home", Some("teal"), vec![dated(1, "home")], true);
    let home: String = w.one("SELECT fills FROM origin WHERE ref = 'calendar:home'", &[]);
    let sentence = w.refused("entity.purge", json!({ "id": home }));
    assert!(sentence.contains("trash"), "{sentence}");
    w.ok("entity.trash", json!({ "id": home }));
    w.ok("entity.purge", json!({ "id": home }));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE parent_id = ?1", &[&home]),
        0
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM origin", &[]), 0);
    read_into(&w, "home", Some("teal"), vec![dated(1, "home")], true);
    let again: String = w.one("SELECT fills FROM origin WHERE ref = 'calendar:home'", &[]);
    assert_ne!(again, home, "a new calendar, since the old one is gone");
}

#[test]
fn a_followed_calendar_the_member_trashed_stays_trashed_until_the_member_restores_it() {
    let w = World::new("cal_follow_trashed");
    read(&w, vec![meeting("uid:1", "Sync")]);
    let event = event_of(&w, "uid:1");
    let calendar: String = w.one("SELECT parent_id FROM entity WHERE id = ?1", &[&event]);
    w.ok("entity.trash", json!({ "id": calendar }));
    assert!(deleted(&w, &event));
    // A pass does not restore the calendar, and nothing lands in a trashed one: it is refused with a
    // sentence, so a restore and the next pass bring everything.
    let refused = w.vault().execute(
        &w.registry,
        &centraid_vault::Principal::owner("phone"),
        &centraid_vault::Command::new(
            "follow.calendar",
            json!({ "origin": { "ref": "calendar:work", "label": "work", "device_id": "phone-1" },
                    "complete": true,
                    "records": [meeting("uid:1", "Sync"), meeting("uid:2", "New")] }),
        ),
    );
    assert!(
        refused.is_err_and(|error| error.to_string().contains("trash")),
        "a pass into a trashed calendar is refused with its sentence"
    );
    assert!(deleted(&w, &calendar) && deleted(&w, &event));
    w.ok("entity.restore", json!({ "id": calendar }));
    read(&w, vec![meeting("uid:1", "Sync"), meeting("uid:2", "New")]);
    let arrival = event_of(&w, "uid:2");
    assert!(!deleted(&w, &calendar) && !deleted(&w, &event) && !deleted(&w, &arrival));
}
