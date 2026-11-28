//! An event's own verbs against the v0 tables (#1214, calendar lane): the three timings, the
//! calendar as its home, its guests, a series and the day-by-day changes to it, "this and
//! following" as a split, alerts as `reminder` rows, and an overlap that is allowed and read. The
//! trash, a tag and a move are the shared verbs; the rules the database holds for these tables are
//! in `schema_rules.rs`; the reads are `event_reads.rs`, the iCalendar door `event_portable.rs`.

mod common;

use centraid_vault::model::Kind;
use common::world::World;
use serde_json::{Value, json};

fn standup(w: &World) -> String {
    w.ok(
        "event.propose",
        json!({ "title": "Standup", "starts": "2026-03-02T09:00", "ends": "2026-03-02T09:30",
                "zone": "Europe/Paris", "rule": "FREQ=WEEKLY" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

fn event(w: &World, input: Value) -> String {
    w.ok("event.propose", input)["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

fn text(w: &World, sql: &str, params: &[&str]) -> Option<String> {
    w.vault()
        .read(|c| {
            Ok(rusqlite::OptionalExtension::optional(c.query_row(
                sql,
                rusqlite::params_from_iter(params),
                |r| r.get::<_, Option<String>>(0),
            ))?
            .flatten())
        })
        .expect("a row")
}

fn email(w: &World, person: &str, address: &str) {
    let id = w.mint();
    w.commit(|tx| {
        tx.connection().execute(
            "INSERT INTO contact_point (id, person_id, kind, value, normalized, position)
             VALUES (?1, ?2, 'email', ?3, ?4, 0)",
            rusqlite::params![id, person, address, address.to_lowercase()],
        )?;
        Ok(())
    });
}

fn days(w: &World, series: &str) -> Vec<(String, i64, Option<String>)> {
    w.vault()
        .read(|c| {
            Ok(c.prepare(
                "SELECT original_start, cancelled, starts FROM occurrence
                  WHERE series_id = ?1 ORDER BY 1",
            )?
            .query_map([series], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?)
        })
        .expect("rows")
}

// ---------------------------------------------------------------------------------------------
// 1. The three timings, and the calendar as the home
// ---------------------------------------------------------------------------------------------

#[test]
fn a_zoned_time_is_the_instant_its_wall_clock_is_and_a_skipped_clock_is_refused() {
    let w = World::new("event_zoned");
    let id = standup(&w);
    assert_eq!(
        text(&w, "SELECT starts FROM event WHERE id = ?1", &[&id]).as_deref(),
        Some("2026-03-02T08:00:00.000Z")
    );
    assert_eq!(
        text(
            &w,
            "SELECT timing || ' ' || zone FROM event WHERE id = ?1",
            &[&id]
        )
        .as_deref(),
        Some("zoned Europe/Paris")
    );
    let sentence = w.refused(
        "event.propose",
        json!({ "title": "Gap", "starts": "2026-03-29T02:30", "zone": "Europe/Paris" }),
    );
    assert!(sentence.contains("does not exist"), "{sentence}");
    // An instant stated with its own `Z` is held as it is, in the clock's one form.
    let instant = event(
        &w,
        json!({ "title": "Call", "starts": "2026-03-05T14:00:00Z", "zone": "Asia/Tokyo" }),
    );
    assert_eq!(
        text(&w, "SELECT starts FROM event WHERE id = ?1", &[&instant]).as_deref(),
        Some("2026-03-05T14:00:00.000Z")
    );
}

#[test]
fn a_floating_time_is_a_wall_clock_to_the_minute_and_an_all_day_one_a_date() {
    let w = World::new("event_forms");
    // A phone that spells a zero second is held to the minute; a second that means something is refused.
    let lunch = event(
        &w,
        json!({ "title": "Lunch", "starts": "2026-03-05T12:00:00", "ends": "2026-03-05T13:00:00.000",
                "timing": "floating" }),
    );
    assert_eq!(
        text(
            &w,
            "SELECT starts || ' ' || ends || ' ' || ifnull(zone, '-') FROM event WHERE id = ?1",
            &[&lunch]
        )
        .as_deref(),
        Some("2026-03-05T12:00 2026-03-05T13:00 -")
    );
    let sentence = w.refused(
        "event.propose",
        json!({ "title": "Odd", "starts": "2026-03-05T12:00:30", "timing": "floating" }),
    );
    assert!(sentence.contains("to the minute"), "{sentence}");
    // A date is all-day (its end is the LAST day), an instant is zoned, a bare wall clock is floating.
    let trip = event(
        &w,
        json!({ "title": "Trip", "starts": "2026-03-05", "ends": "2026-03-07", "busy": false }),
    );
    assert_eq!(
        text(
            &w,
            "SELECT timing || ' ' || starts || ' ' || ends FROM event WHERE id = ?1",
            &[&trip]
        )
        .as_deref(),
        Some("all-day 2026-03-05 2026-03-07")
    );
    let sentence = w.refused(
        "event.propose",
        json!({ "title": "Mixed", "starts": "2026-03-05T09:00", "timing": "all-day" }),
    );
    assert!(sentence.contains("date"), "{sentence}");
    // A zone belongs to a zoned time alone.
    let sentence = w.refused(
        "event.propose",
        json!({ "title": "Zoned all-day", "starts": "2026-03-05", "timing": "all-day", "zone": "Europe/Paris" }),
    );
    assert!(sentence.contains("zone"), "{sentence}");
    // An event ends after it starts.
    let sentence = w.refused(
        "event.propose",
        json!({ "title": "Backwards", "starts": "2026-03-05T10:00", "ends": "2026-03-05T09:00", "timing": "floating" }),
    );
    assert!(sentence.contains("end after"), "{sentence}");
    // A trip or a semester is an event like any other: nothing refuses its length.
    let semester = event(
        &w,
        json!({ "title": "Semester", "starts": "2026-03-05", "ends": "2026-09-05", "busy": false }),
    );
    assert_eq!(
        w.one::<i64>("SELECT long FROM event WHERE id = ?1", &[&semester]),
        1,
        "an event that runs past a week is `long`"
    );
    assert!(text(&w, "SELECT long FROM event WHERE id = ?1", &[&trip]).is_none());
}

#[test]
fn the_calendar_is_the_events_home_and_a_move_is_the_shared_verb() {
    let w = World::new("event_home");
    let work = w.container("calendar", "Work");
    let id = event(
        &w,
        json!({ "title": "Review", "starts": "2026-03-05T10:00", "timing": "floating", "calendar_id": work }),
    );
    assert_eq!(
        text(&w, "SELECT parent_id FROM entity WHERE id = ?1", &[&id]).as_deref(),
        Some(work.as_str())
    );
    // Nothing named: the vault's own calendar.
    let plain = event(
        &w,
        json!({ "title": "Plain", "starts": "2026-03-05", "busy": false }),
    );
    assert_eq!(
        text(&w, "SELECT parent_id FROM entity WHERE id = ?1", &[&plain]).as_deref(),
        Some("calendar:default")
    );
    // A move to another calendar goes through `entity.move`; the event edit does not carry a calendar.
    let home = w.container("calendar", "Home");
    w.ok("entity.move", json!({ "id": &id, "parent": &home }));
    assert_eq!(
        text(&w, "SELECT parent_id FROM entity WHERE id = ?1", &[&id]).as_deref(),
        Some(home.as_str())
    );
    assert!(
        w.run("event.edit", json!({ "id": &id, "calendar_id": &home }))
            .status
            != centraid_vault::CommandStatus::Executed
    );
    // An event is not at the top level, and not in a task list.
    let sentence = w.refused("entity.move", json!({ "id": &id, "parent": null }));
    assert!(sentence.contains("calendar"), "{sentence}");
    let project = w.container("task_list", "Roof");
    let sentence = w.refused("entity.move", json!({ "id": &id, "parent": &project }));
    assert!(sentence.contains("does not go inside"), "{sentence}");
    let sentence = w.refused(
        "event.propose",
        json!({ "title": "Lost", "starts": "2026-03-05", "calendar_id": &project }),
    );
    assert!(sentence.contains("does not go inside"), "{sentence}");
    // Trashing the calendar takes its events; a restore brings back exactly those.
    w.ok("entity.trash", json!({ "id": &home }));
    assert!(text(&w, "SELECT deleted_at FROM entity WHERE id = ?1", &[&id]).is_some());
    assert!(text(&w, "SELECT deleted_at FROM entity WHERE id = ?1", &[&plain]).is_none());
    w.ok("entity.restore", json!({ "id": &home }));
    assert!(text(&w, "SELECT deleted_at FROM entity WHERE id = ?1", &[&id]).is_none());
    // An event in the trash on its own comes back on its own.
    w.ok("entity.trash", json!({ "id": &plain }));
    w.ok("entity.restore", json!({ "id": &plain }));
    assert!(!w.stamp(&plain).is_empty());
}

#[test]
fn where_it_is_is_words_and_never_makes_a_place() {
    let w = World::new("event_location");
    let places_before: i64 = w.one("SELECT COUNT(*) FROM entity WHERE kind = 'place'", &[]);
    let id = event(
        &w,
        json!({ "title": "Coffee", "starts": "2026-03-05T10:00", "timing": "floating",
                "location": "the usual café, Rue Cler" }),
    );
    assert_eq!(
        text(&w, "SELECT location FROM event WHERE id = ?1", &[&id]).as_deref(),
        Some("the usual café, Rue Cler")
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE kind = 'place'", &[]),
        places_before,
        "a location is words, not a place"
    );
    assert!(text(&w, "SELECT place_id FROM event WHERE id = ?1", &[&id]).is_none());
    // A place is only one the member has.
    let place = w.made(Kind::Place, "Home");
    w.commit(|tx| {
        tx.connection()
            .execute("INSERT INTO place (id) VALUES (?1)", [&place])?;
        Ok(())
    });
    w.ok(
        "event.edit",
        json!({ "id": &id, "place_id": &place, "location": null }),
    );
    assert_eq!(
        text(&w, "SELECT place_id FROM event WHERE id = ?1", &[&id]).as_deref(),
        Some(place.as_str())
    );
    assert!(text(&w, "SELECT location FROM event WHERE id = ?1", &[&id]).is_none());
    let sentence = w.refused("event.edit", json!({ "id": &id, "location": "  " }));
    assert!(sentence.contains("says something"), "{sentence}");
    let note = w.note("Not a place");
    let sentence = w.refused("event.edit", json!({ "id": &id, "place_id": &note }));
    assert!(sentence.contains("not a place"), "{sentence}");
}

#[test]
fn an_edit_changes_what_it_states_and_a_moved_start_keeps_the_length() {
    let w = World::new("event_edit");
    let id = event(
        &w,
        json!({ "title": "Review", "starts": "2026-03-05T10:00", "ends": "2026-03-05T11:30",
                "timing": "floating", "description": "slides" }),
    );
    w.ok(
        "event.edit",
        json!({ "id": &id, "title": "Design review", "starts": "2026-03-06T14:00" }),
    );
    assert_eq!(
        text(
            &w,
            "SELECT starts || ' ' || ends FROM event WHERE id = ?1",
            &[&id]
        )
        .as_deref(),
        Some("2026-03-06T14:00 2026-03-06T15:30"),
        "a start moved with no end said keeps the length"
    );
    assert_eq!(
        text(&w, "SELECT title FROM entity WHERE id = ?1", &[&id]).as_deref(),
        Some("Design review")
    );
    assert_eq!(
        text(&w, "SELECT description FROM event WHERE id = ?1", &[&id]).as_deref(),
        Some("slides"),
        "what the edit does not state is left"
    );
    w.ok("event.edit", json!({ "id": &id, "description": null, "status": "tentative", "busy": false, "travel_min": 20 }));
    assert_eq!(
        text(&w, "SELECT ifnull(description, '-') || status || busy || travel_min FROM event WHERE id = ?1", &[&id])
            .as_deref(),
        Some("-tentative020")
    );
    // Cancelling says so and leaves the event where it is.
    w.ok("event.cancel", json!({ "id": &id }));
    assert_eq!(
        text(&w, "SELECT status FROM event WHERE id = ?1", &[&id]).as_deref(),
        Some("cancelled")
    );
    // The same event in the trash is refused an edit, with the trash's sentence.
    w.ok("entity.trash", json!({ "id": &id }));
    let sentence = w.refused("event.edit", json!({ "id": &id, "title": "Nope" }));
    assert!(sentence.contains("trash"), "{sentence}");
}

// ---------------------------------------------------------------------------------------------
// 2. Guests
// ---------------------------------------------------------------------------------------------

#[test]
fn guests_are_added_edited_and_removed_and_a_guest_not_in_people_is_still_a_guest() {
    let w = World::new("event_guests");
    let id = event(
        &w,
        json!({ "title": "Planning", "starts": "2026-03-05T10:00", "timing": "floating",
                "guests": [
                  { "address": "Maya@Example.com", "name": "Maya Rao", "organizer": true },
                  { "address": "mailto:jo@example.com" }
                ] }),
    );
    let rows = |w: &World| -> Vec<String> {
        w.strings(
            "SELECT address || '|' || ifnull(name, '-') || '|' || role || '|' || status || '|' || organizer
               FROM event_guest WHERE event_id = ?1 ORDER BY address",
            &[&id],
        )
    };
    assert_eq!(
        rows(&w),
        vec![
            "jo@example.com|-|required|needs-action|0",
            "maya@example.com|Maya Rao|required|needs-action|1"
        ],
        "an address is the identity: lower case, no `mailto:`"
    );
    // A guest answers; an edit of the list keeps the answer it does not state.
    w.ok(
        "event.respond",
        json!({ "id": &id, "address": "JO@example.com", "status": "accepted" }),
    );
    w.ok(
        "event.edit",
        json!({ "id": &id, "guests": [
            { "address": "jo@example.com", "role": "optional" },
            { "address": "sam@example.com", "name": "Sam", "status": "tentative" }
        ] }),
    );
    assert_eq!(
        rows(&w),
        vec![
            "jo@example.com|-|optional|accepted|0",
            "sam@example.com|Sam|required|tentative|0"
        ],
        "Maya was left out and is off the list; Jo keeps the answer, Sam arrives with his"
    );
    // The organizer is one: a new one takes the badge.
    w.ok(
        "event.edit",
        json!({ "id": &id, "guests": [
            { "address": "jo@example.com", "organizer": true },
            { "address": "sam@example.com" }
        ] }),
    );
    w.ok(
        "event.edit",
        json!({ "id": &id, "guests": [
            { "address": "jo@example.com" },
            { "address": "sam@example.com", "organizer": true }
        ] }),
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM event_guest WHERE event_id = ?1 AND organizer = 1",
            &[&id]
        ),
        1
    );
    assert_eq!(
        w.one::<String>(
            "SELECT address FROM event_guest WHERE event_id = ?1 AND organizer = 1",
            &[&id]
        ),
        "sam@example.com"
    );
    let sentence = w.refused(
        "event.edit",
        json!({ "id": &id, "guests": [
            { "address": "a@example.com", "organizer": true },
            { "address": "b@example.com", "organizer": true }
        ] }),
    );
    assert!(sentence.contains("one organizer"), "{sentence}");
    // An answer needs an invitation, an address needs to be one, and none at all removes every guest.
    let sentence = w.refused(
        "event.respond",
        json!({ "id": &id, "address": "nobody@example.com", "status": "accepted" }),
    );
    assert!(sentence.contains("not invited"), "{sentence}");
    let sentence = w.refused(
        "event.edit",
        json!({ "id": &id, "guests": [{ "address": "two words" }] }),
    );
    assert!(sentence.contains("not an address"), "{sentence}");
    w.ok("event.edit", json!({ "id": &id, "guests": [] }));
    assert!(rows(&w).is_empty());
}

#[test]
fn a_guest_resolves_to_a_person_by_address_and_survives_that_persons_purge() {
    let w = World::new("event_guest_person");
    let maya = w.person("Maya");
    email(&w, &maya, "maya@example.com");
    let id = event(
        &w,
        json!({ "title": "Lunch", "starts": "2026-03-05T12:00", "timing": "floating",
                "guests": [{ "address": "Maya@example.com" }, { "address": "stranger@example.com" }] }),
    );
    let person_of = |address: &str| -> Option<String> {
        text(
            &w,
            "SELECT person_id FROM event_guest WHERE event_id = ?1 AND address = ?2",
            &[&id, address],
        )
    };
    assert_eq!(person_of("maya@example.com"), Some(maya.clone()));
    assert_eq!(
        person_of("stranger@example.com"),
        None,
        "not in People, still a guest"
    );
    // The read resolves an address that became a person's after the guest was invited.
    let sam = w.person("Sam");
    email(&w, &sam, "stranger@example.com");
    let resolved = w
        .vault()
        .read(|c| centraid_vault::commands::event::guests_of(c, &id))
        .expect("guests");
    assert_eq!(
        resolved
            .iter()
            .map(|g| (g.address.clone(), g.person_id.clone()))
            .collect::<Vec<_>>(),
        vec![
            (Some("maya@example.com".to_owned()), Some(maya.clone())),
            (Some("stranger@example.com".to_owned()), Some(sam.clone())),
        ]
    );
    // Purging the person leaves the guest, now with nobody behind the address.
    w.ok("entity.trash", json!({ "id": &maya }));
    w.ok("entity.purge", json!({ "id": &maya }));
    assert_eq!(person_of("maya@example.com"), None);
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM event_guest WHERE event_id = ?1",
            &[&id]
        ),
        2,
        "the guest outlives the person"
    );
    // The invitation of a person with a trashed card is no person at all.
    w.ok("entity.trash", json!({ "id": &sam }));
    let resolved = w
        .vault()
        .read(|c| centraid_vault::commands::event::guests_of(c, &id))
        .expect("guests");
    assert!(resolved.iter().all(|g| g.person_id.is_none()));
}

#[test]
fn a_person_with_no_email_is_a_guest_and_their_purge_leaves_no_orphan_row() {
    let w = World::new("event_guest_by_person");
    let maya = w.person("Maya");
    let id = event(
        &w,
        json!({ "title": "Walk", "starts": "2026-03-05T12:00", "timing": "floating" }),
    );
    w.ok("event.add_guest", json!({ "id": &id, "person_id": &maya }));
    w.ok(
        "event.add_guest",
        json!({ "id": &id, "address": "pat@example.com" }),
    );
    let rows = |w: &World| {
        w.strings(
            "SELECT ifnull(address, '-') || '|' || ifnull(person_id, '-') FROM event_guest
              WHERE event_id = ?1 ORDER BY id",
            &[&id],
        )
    };
    assert_eq!(
        rows(&w),
        [format!("-|{maya}"), "pat@example.com|-".to_owned()]
    );
    w.ok("event.add_guest", json!({ "id": &id, "person_id": &maya }));
    assert_eq!(rows(&w).len(), 2, "the same person is one guest");
    assert!(
        w.refused("event.add_guest", json!({ "id": &id }))
            .contains("a person or an address")
    );
    w.ok(
        "event.respond",
        json!({ "id": &id, "person_id": &maya, "status": "accepted" }),
    );
    assert_eq!(
        text(
            &w,
            "SELECT status FROM event_guest WHERE event_id = ?1 AND person_id = ?2",
            &[&id, &maya]
        )
        .as_deref(),
        Some("accepted")
    );
    w.ok("entity.trash", json!({ "id": &maya }));
    w.ok("entity.purge", json!({ "id": &maya }));
    assert_eq!(
        rows(&w),
        ["pat@example.com|-"],
        "the address-less row went first"
    );
}

#[test]
fn an_earlier_version_with_three_guests_restores_three_and_keeps_no_copy_of_the_start() {
    let w = World::new("event_guest_version");
    let maya = w.person("Maya");
    let id = event(
        &w,
        json!({ "title": "Walk", "starts": "2026-03-05T12:00", "timing": "floating",
                "guests": [{ "address": "a@example.com" }, { "address": "b@example.com" }] }),
    );
    w.ok("event.add_guest", json!({ "id": &id, "person_id": &maya }));
    w.ok("event.edit", json!({ "id": &id, "guests": [] }));
    let count = |w: &World| {
        w.one::<i64>(
            "SELECT COUNT(*) FROM event_guest WHERE event_id = ?1",
            &[&id],
        )
    };
    assert_eq!(count(&w), 0);
    let three: i64 = w.one(
        "SELECT seq FROM revision WHERE entity_id = ?1 AND json_array_length(state, '$.event_guest') = 3",
        &[&id],
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM revision r, json_each(r.state, '$.event_guest') g
              WHERE r.entity_id = ?1 AND json_extract(g.value, '$.starts') IS NOT NULL",
            &[&id]
        ),
        0
    );
    w.ok(
        "history.restore_version",
        json!({ "id": &id, "seq": three }),
    );
    assert_eq!(
        count(&w),
        3,
        "an earlier version with three guests restores three"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM event_guest WHERE event_id = ?1 AND starts = '2026-03-05T12:00'",
            &[&id]
        ),
        3,
        "the restored rows copy the event's start again"
    );
}

#[test]
fn moving_an_event_re_sorts_it_on_a_persons_timeline_by_one_index() {
    let w = World::new("event_guest_timeline");
    let maya = w.person("Maya");
    let first = event(
        &w,
        json!({ "title": "First", "starts": "2026-03-05T12:00", "timing": "floating" }),
    );
    let second = event(
        &w,
        json!({ "title": "Second", "starts": "2026-03-06T12:00", "timing": "floating" }),
    );
    for id in [&first, &second] {
        w.ok("event.add_guest", json!({ "id": id, "person_id": &maya }));
    }
    let timeline =
        "SELECT event_id FROM event_guest WHERE person_id = ?1 ORDER BY starts, event_id";
    let order = |w: &World| w.strings(timeline, &[&maya]);
    assert_eq!(order(&w), [first.clone(), second.clone()]);
    w.ok(
        "event.edit",
        json!({ "id": &first, "starts": "2026-03-09T12:00" }),
    );
    assert_eq!(
        order(&w),
        [second, first],
        "the guest row followed the event's new start"
    );
    let plan = w
        .vault()
        .explain_query_plan(
            timeline,
            &[centraid_vault::value::Value::Text(maya.clone())],
        )
        .expect("a plan")
        .join("\n");
    assert!(plan.contains("event_guest_by_person_start"), "{plan}");
    assert!(!plan.contains("TEMP B-TREE"), "{plan}");
}

// ---------------------------------------------------------------------------------------------
// 3. A series, a day of it, and "this and following"
// ---------------------------------------------------------------------------------------------

#[test]
fn a_day_of_a_series_is_skipped_moved_and_put_back_by_its_wall_clock() {
    let w = World::new("event_days");
    let id = standup(&w);
    let key = "2026-03-09T08:00:00.000Z";
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": key, "action": "skip" }),
    );
    assert_eq!(days(&w, &id), vec![(key.to_owned(), 1, None)]);
    // A moved day states its own start; the rest is the series'.
    let key2 = "2026-03-16T08:00:00.000Z";
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": key2, "action": "override",
                "starts": "2026-03-16T10:30", "title": "Late standup", "location": "Room 4" }),
    );
    assert_eq!(
        days(&w, &id)[1],
        (
            key2.to_owned(),
            0,
            Some("2026-03-16T09:30:00.000Z".to_owned())
        )
    );
    assert_eq!(
        text(&w, "SELECT title || '|' || location FROM occurrence WHERE series_id = ?1 AND original_start = ?2", &[&id, key2])
            .as_deref(),
        Some("Late standup|Room 4")
    );
    // A day the rule does not land on is refused.
    let sentence = w.refused(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-10T08:00:00.000Z", "action": "skip" }),
    );
    assert!(
        sentence.contains("not one the event lands on"),
        "{sentence}"
    );
    // A day may be moved as far as the member likes.
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": key2, "action": "override", "starts": "2026-09-16T10:30" }),
    );
    // Put back: the rows go and the series is the series again.
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": key, "action": "restore" }),
    );
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": key2, "action": "restore" }),
    );
    assert!(days(&w, &id).is_empty());
    // A day of an event that does not repeat is refused.
    let one = event(
        &w,
        json!({ "title": "Once", "starts": "2026-03-05", "busy": false }),
    );
    let sentence = w.refused(
        "event.edit_occurrence",
        json!({ "id": &one, "original_start": "2026-03-05", "action": "skip" }),
    );
    assert!(sentence.contains("does not repeat"), "{sentence}");
}

#[test]
fn a_day_with_its_own_timing_keeps_it_and_one_that_states_the_series_own_stores_none() {
    let w = World::new("event_day_timing");
    let id = w.ok(
        "event.propose",
        json!({ "title": "Holiday", "starts": "2026-03-02", "ends": "2026-03-02", "rule": "FREQ=WEEKLY" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    // An all-day series' day moved to a time reads under the timing it was moved under.
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-09", "action": "override",
                "timing": "floating", "starts": "2026-03-09T18:00" }),
    );
    assert_eq!(
        text(
            &w,
            "SELECT timing || ' ' || starts FROM occurrence WHERE series_id = ?1",
            &[&id]
        )
        .as_deref(),
        Some("floating 2026-03-09T18:00")
    );
    // A day that states its series' own timing stores none.
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-16", "action": "override",
                "timing": "all-day", "starts": "2026-03-17", "title": "Moved a day" }),
    );
    assert!(
        text(
            &w,
            "SELECT timing FROM occurrence WHERE series_id = ?1 AND original_start = '2026-03-16'",
            &[&id]
        )
        .is_none()
    );
    // A zoned day needs the zone it is in.
    let sentence = w.refused(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-23", "action": "override",
                "timing": "zoned", "starts": "2026-03-23T10:00:00Z" }),
    );
    assert!(sentence.contains("zone"), "{sentence}");
}

#[test]
fn this_and_following_splits_the_series_and_a_change_of_timing_to_the_future_is_allowed() {
    let w = World::new("event_split");
    let guest_person = w.person("Maya");
    email(&w, &guest_person, "maya@example.com");
    let id = event(
        &w,
        json!({ "title": "Standup", "starts": "2026-03-02T09:00", "ends": "2026-03-02T09:30",
                "zone": "Europe/Paris", "rule": "FREQ=WEEKLY", "reminders": [10],
                "guests": [{ "address": "maya@example.com", "status": "accepted" }] }),
    );
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-09T08:00:00.000Z", "action": "skip" }),
    );
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-23T08:00:00.000Z", "action": "skip" }),
    );
    let tag = w.made(Kind::Tag, "team");
    w.ok(
        "edge.add",
        json!({ "from": &id, "rel": "tagged", "to": &tag }),
    );
    // From the 16th the standup is at ten: a change of timing, to the future.
    let out = w.ok(
        "event.split",
        json!({ "id": &id, "original_start": "2026-03-16T08:00:00.000Z",
                "starts": "2026-03-16T10:00", "ends": "2026-03-16T10:45", "title": "Late standup" }),
    );
    assert_eq!(out["split"], json!(true));
    let new_id = out["new_id"].as_str().expect("the new event").to_owned();
    // The old series ends the day before: its rule says so, and nothing links the halves.
    let old_rule = text(&w, "SELECT rule FROM event WHERE id = ?1", &[&id]).expect("a rule");
    assert!(old_rule.contains("UNTIL=20260309T080000Z"), "{old_rule}");
    assert!(!old_rule.contains("COUNT"));
    assert_eq!(
        text(&w, "SELECT starts FROM event WHERE id = ?1", &[&id]).as_deref(),
        Some("2026-03-02T08:00:00.000Z"),
        "the old half keeps its own start"
    );
    // The new one starts on the split day, at the new time, in the same calendar, with what was carried.
    assert_eq!(
        w.strings(
            "SELECT v.starts || '|' || v.ends || '|' || v.zone || '|' || e.title || '|' || e.parent_id
               FROM event v JOIN entity e ON e.id = v.id WHERE v.id = ?1",
            &[&new_id]
        ),
        vec!["2026-03-16T09:00:00.000Z|2026-03-16T09:45:00.000Z|Europe/Paris|Late standup|calendar:default"]
    );
    let new_rule = text(&w, "SELECT rule FROM event WHERE id = ?1", &[&new_id]).expect("a rule");
    assert!(
        new_rule.contains("FREQ=WEEKLY") && !new_rule.contains("UNTIL"),
        "{new_rule}"
    );
    assert_eq!(
        w.strings(
            "SELECT address || status FROM event_guest WHERE event_id = ?1",
            &[&new_id]
        ),
        vec!["maya@example.comaccepted"],
        "the guests and their answers come along"
    );
    assert_eq!(
        w.strings(
            "SELECT CAST(offset_min AS TEXT) FROM reminder WHERE entity_id = ?1",
            &[&new_id]
        ),
        vec!["10"]
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'tagged'",
            &[&new_id]
        ),
        1
    );
    // Its days: the 9th (before the split) stays with the old half; the 23rd was skipped at nine, and
    // the new half's days are at ten, so that skip is dropped rather than left to match nothing.
    assert_eq!(days(&w, &id).len(), 1);
    assert!(days(&w, &new_id).is_empty());
    // No scope any more: the day override carries only the day.
    assert!(
        w.vault()
            .read(|c| Ok(c.prepare("SELECT scope FROM occurrence").is_err()))
            .expect("prepares")
    );
}

#[test]
fn a_split_that_changes_no_time_carries_the_days_and_shares_out_a_count() {
    let w = World::new("event_split_count");
    let id = event(
        &w,
        json!({ "title": "Course", "starts": "2026-03-02T18:00", "timing": "floating",
                "rule": "FREQ=WEEKLY;COUNT=6" }),
    );
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-23T18:00", "action": "skip" }),
    );
    let out = w.ok(
        "event.split",
        json!({ "id": &id, "original_start": "2026-03-16T18:00", "location": "Annex" }),
    );
    let new_id = out["new_id"].as_str().expect("the new event").to_owned();
    // Two weeks were kept (the 2nd, the 9th); four are left for the new half.
    let old_rule = text(&w, "SELECT rule FROM event WHERE id = ?1", &[&id]).expect("a rule");
    assert!(
        old_rule.contains("UNTIL=20260309T180000") && !old_rule.contains("COUNT"),
        "{old_rule}"
    );
    let new_rule = text(&w, "SELECT rule FROM event WHERE id = ?1", &[&new_id]).expect("a rule");
    assert!(new_rule.contains("COUNT=4"), "{new_rule}");
    assert_eq!(
        text(&w, "SELECT location FROM event WHERE id = ?1", &[&new_id]).as_deref(),
        Some("Annex")
    );
    assert!(text(&w, "SELECT location FROM event WHERE id = ?1", &[&id]).is_none());
    // The skipped week moved with the days it belongs to.
    assert!(days(&w, &id).is_empty());
    assert_eq!(
        days(&w, &new_id),
        vec![("2026-03-23T18:00".to_owned(), 1, None)]
    );
}

#[test]
fn splitting_at_the_first_day_is_the_edit_of_the_whole_series_and_a_day_off_the_rule_is_refused() {
    let w = World::new("event_split_first");
    let id = standup(&w);
    let before = w.one::<i64>("SELECT COUNT(*) FROM event", &[]);
    let out = w.ok(
        "event.split",
        json!({ "id": &id, "original_start": "2026-03-02T08:00:00.000Z", "title": "Daily-ish" }),
    );
    assert_eq!(out["split"], json!(false));
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM event", &[]), before);
    assert_eq!(
        text(&w, "SELECT title FROM entity WHERE id = ?1", &[&id]).as_deref(),
        Some("Daily-ish")
    );
    let sentence = w.refused(
        "event.split",
        json!({ "id": &id, "original_start": "2026-03-03T08:00:00.000Z", "title": "Nope" }),
    );
    assert!(
        sentence.contains("not one the event lands on"),
        "{sentence}"
    );
    let once = event(
        &w,
        json!({ "title": "Once", "starts": "2026-03-05", "busy": false }),
    );
    let sentence = w.refused(
        "event.split",
        json!({ "id": &once, "original_start": "2026-03-05", "title": "Nope" }),
    );
    assert!(sentence.contains("does not repeat"), "{sentence}");
}

#[test]
fn a_change_to_the_whole_series_moves_its_days_with_it_and_a_new_timing_drops_them() {
    let w = World::new("event_series_edit");
    let id = standup(&w);
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-09T08:00:00.000Z", "action": "skip" }),
    );
    // The standup moves from nine to ten for the whole series: the skipped week stays skipped.
    w.ok(
        "event.edit",
        json!({ "id": &id, "starts": "2026-03-02T10:00", "ends": "2026-03-02T10:30" }),
    );
    assert_eq!(
        days(&w, &id),
        vec![("2026-03-09T09:00:00.000Z".to_owned(), 1, None)]
    );
    // A series that stops repeating has no days to change.
    w.ok("event.edit", json!({ "id": &id, "timing": "floating", "starts": "2026-03-02T10:00", "ends": "2026-03-02T10:30", "zone": null }));
    assert!(
        days(&w, &id).is_empty(),
        "a new timing starts the series' days afresh"
    );
    w.ok("event.edit", json!({ "id": &id, "rule": null }));
    assert!(text(&w, "SELECT rule FROM event WHERE id = ?1", &[&id]).is_none());
    // A rule outside the expander's subset is refused where it is written.
    let sentence = w.refused("event.edit", json!({ "id": &id, "rule": "FREQ=HOURLY" }));
    assert!(
        sentence.to_lowercase().contains("hourly") || sentence.contains("FREQ"),
        "{sentence}"
    );
}

// ---------------------------------------------------------------------------------------------
// 4. Overlap
// ---------------------------------------------------------------------------------------------

#[test]
fn a_busy_event_may_land_on_a_busy_one_and_the_read_says_so() {
    let w = World::new("event_overlap");
    let a = event(
        &w,
        json!({ "title": "Dentist", "starts": "2026-03-05T10:00", "ends": "2026-03-05T11:00", "timing": "floating" }),
    );
    // Nothing refuses the second: the same hour, busy.
    let b = event(
        &w,
        json!({ "title": "Call", "starts": "2026-03-05T10:30", "ends": "2026-03-05T11:30", "timing": "floating" }),
    );
    // A free one, an all-day one and the next hour overlap nothing.
    let _free = event(
        &w,
        json!({ "title": "Maybe", "starts": "2026-03-05T10:15", "ends": "2026-03-05T10:45", "timing": "floating", "busy": false }),
    );
    let _all_day = event(
        &w,
        json!({ "title": "Trip", "starts": "2026-03-05", "ends": "2026-03-05", "busy": true }),
    );
    let _next = event(
        &w,
        json!({ "title": "Lunch", "starts": "2026-03-05T11:30", "ends": "2026-03-05T12:30", "timing": "floating" }),
    );
    let found = w
        .vault()
        .read(|c| centraid_vault::commands::event::reads::overlaps(c, "2026-03-05", 1, Some("UTC")))
        .expect("overlaps");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].first, (a, None));
    assert_eq!(found[0].second, (b, None));
}

// ---------------------------------------------------------------------------------------------
// 5. Alerts are reminder rows
// ---------------------------------------------------------------------------------------------

#[test]
fn an_events_alerts_are_reminder_rows_set_changed_and_moved_with_the_event() {
    let w = World::new("event_reminders");
    // An event has no alert unless it is given one (no default alert existed for an event).
    let none = event(
        &w,
        json!({ "title": "Quiet", "starts": "2099-03-05T10:00", "timing": "floating" }),
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM reminder WHERE entity_id = ?1",
            &[&none]
        ),
        0
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM alert", &[]), 0);
    let id = event(
        &w,
        json!({ "title": "Review", "starts": "2099-03-05T10:00", "timing": "floating", "reminders": [60, 10, 10] }),
    );
    let leads = |w: &World| {
        w.strings("SELECT CAST(offset_min AS TEXT) FROM reminder WHERE entity_id = ?1 ORDER BY offset_min", &[&id])
    };
    assert_eq!(leads(&w), vec!["10", "60"]);
    let fire = |w: &World| {
        w.strings(
            "SELECT a.fire_key FROM alert a JOIN reminder r ON r.id = a.reminder_id
              WHERE r.entity_id = ?1 ORDER BY a.fire_key",
            &[&id],
        )
    };
    assert_eq!(fire(&w), vec!["2099-03-05T09:00", "2099-03-05T09:50"]);
    // A change of leads: the one that stays keeps its row, the one that goes loses its alert.
    w.ok("event.edit", json!({ "id": &id, "reminders": [10, 1440] }));
    assert_eq!(leads(&w), vec!["10", "1440"]);
    assert_eq!(fire(&w), vec!["2099-03-04T10:00", "2099-03-05T09:50"]);
    // The alert moves with the start.
    w.ok(
        "event.edit",
        json!({ "id": &id, "starts": "2099-03-06T10:00" }),
    );
    assert_eq!(fire(&w), vec!["2099-03-05T10:00", "2099-03-06T09:50"]);
    // A reminder is a lead of 0 minutes to a year before, and nothing else (the input schema says so).
    assert!(
        w.vault()
            .execute(
                &w.registry,
                &centraid_vault::Principal::owner("phone"),
                &centraid_vault::Command::new(
                    "event.edit",
                    json!({ "id": &id, "reminders": [-5] })
                ),
            )
            .map_or(true, |outcome| outcome.status
                != centraid_vault::CommandStatus::Executed)
    );
    // Cancelling or trashing takes the alerts; null removes them.
    w.ok("event.edit", json!({ "id": &id, "reminders": null }));
    assert!(leads(&w).is_empty() && fire(&w).is_empty());
}

#[test]
fn a_series_day_that_is_skipped_or_moved_moves_the_alert() {
    let w = World::new("event_series_alert");
    let id = event(
        &w,
        json!({ "title": "Standup", "starts": "2026-03-05T09:00", "timing": "floating",
                "rule": "FREQ=DAILY", "reminders": [0] }),
    );
    let fire = |w: &World| {
        w.strings("SELECT a.fire_key FROM alert a JOIN reminder r ON r.id = a.reminder_id WHERE r.entity_id = ?1", &[&id])
    };
    assert_eq!(fire(&w), vec!["2026-03-05T09:00"]);
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-05T09:00", "action": "skip" }),
    );
    assert_eq!(fire(&w), vec!["2026-03-06T09:00"]);
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-06T09:00", "action": "override", "starts": "2026-03-06T07:30" }),
    );
    assert_eq!(fire(&w), vec!["2026-03-06T07:30"]);
}
