//! What one day of a repeating event may carry of its own, and what a phone's calendar is
//! ([#1146](https://github.com/srikanth235/centraid/issues/1146), H5, D6, D7): a moved day keeps
//! its own timing, link and place; a followed calendar is a calendar of the vault, with the phone's
//! colour; and the guard against a read that lost most of a calendar holds per calendar.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("agenda-days").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: Value) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn refused(&self, name: &str, input: Value) -> String {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{name} was not refused"
        );
        outcome.reason.expect("a sentence")
    }

    fn id(&self, name: &str, input: Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn sql(&self, sql: &str, params: &[&str]) {
        self.scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.sql");
                tx.connection()
                    .execute(sql, rusqlite::params_from_iter(params))?;
                Ok(())
            })
            .expect("a write");
    }

    /// `(timing, zone, starts, ends)` of the one day of `series` keyed `key`.
    fn day(
        &self,
        series: &str,
        key: &str,
    ) -> (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) {
        self.scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    "SELECT timing, zone, starts, ends FROM occurrence
                      WHERE series_id = ?1 AND original_start = ?2 AND scope = 'occurrence'",
                    [series, key],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?)
            })
            .expect("a day")
    }
}

fn all_day_weekly(w: &World) -> String {
    w.id(
        "event.propose",
        json!({ "title": "Trash day", "starts": "2026-03-02", "timing": "all-day",
                "rule": "FREQ=WEEKLY" }),
    )
}

fn zoned_weekly(w: &World) -> String {
    w.id(
        "event.propose",
        json!({ "title": "Standup", "starts": "2026-03-02T09:00", "ends": "2026-03-02T09:30",
                "zone": "Europe/Paris", "rule": "FREQ=WEEKLY" }),
    )
}

// ---------------------------------------------------------------------------
// H5: a moved day has its own timing
// ---------------------------------------------------------------------------

#[test]
fn an_all_day_series_day_moved_to_a_time_keeps_the_timing_it_was_moved_under() {
    let w = World::new();
    let id = all_day_weekly(&w);
    w.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-09", "scope": "occurrence",
                "action": "override", "timing": "floating",
                "starts": "2026-03-09T15:00", "ends": "2026-03-09T16:00" }),
    );
    let (timing, zone, starts, ends) = w.day(&id, "2026-03-09");
    assert_eq!(
        timing.as_deref(),
        Some("floating"),
        "the day says how its time reads"
    );
    assert_eq!(zone, None);
    assert_eq!(starts.as_deref(), Some("2026-03-09T15:00"));
    assert_eq!(ends.as_deref(), Some("2026-03-09T16:00"));
}

#[test]
fn a_zoned_series_day_made_all_day_is_a_date_and_is_not_refused() {
    let w = World::new();
    let id = zoned_weekly(&w);
    w.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-09T09:00:00", "scope": "occurrence",
                "action": "override", "timing": "all-day", "starts": "2026-03-09" }),
    );
    let (timing, _, starts, ends) = w.day(&id, "2026-03-09T09:00:00");
    assert_eq!(timing.as_deref(), Some("all-day"));
    assert_eq!(starts.as_deref(), Some("2026-03-09"));
    assert_eq!(
        ends, None,
        "the series' end is a time of day; this day does not borrow it"
    );
}

#[test]
fn a_day_that_states_its_series_own_timing_stores_none() {
    let w = World::new();
    let id = zoned_weekly(&w);
    w.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-09T09:00:00", "scope": "occurrence",
                "action": "override", "timing": "zoned", "zone": "Europe/Paris",
                "starts": "2026-03-09T11:00", "ends": "2026-03-09T11:30" }),
    );
    let (timing, zone, ..) = w.day(&id, "2026-03-09T09:00:00");
    assert_eq!(
        (timing, zone),
        (None, None),
        "the same timing is the series', not the day's own"
    );
}

#[test]
fn a_change_of_timing_is_for_one_day_not_for_every_day_after() {
    let w = World::new();
    let id = all_day_weekly(&w);
    let sentence = w.refused(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-09", "scope": "future",
                "action": "override", "timing": "floating", "starts": "2026-03-09T15:00" }),
    );
    assert!(sentence.contains("one day"), "{sentence}");
}

#[test]
fn a_change_of_timing_needs_the_time_it_is_under() {
    let w = World::new();
    let id = all_day_weekly(&w);
    let sentence = w.refused(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-09", "scope": "occurrence",
                "action": "override", "timing": "floating" }),
    );
    assert!(sentence.contains("starts"), "{sentence}");
}

// ---------------------------------------------------------------------------
// D6: a day's own link and place
// ---------------------------------------------------------------------------

fn place(w: &World, title: &str) -> String {
    w.id("place.add", json!({ "title": title }))
}

#[test]
fn one_day_of_a_series_carries_its_own_link_and_place_and_the_rest_stay_the_series() {
    let w = World::new();
    let id = zoned_weekly(&w);
    let room = place(&w, "Room B");
    w.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-09T09:00:00", "scope": "occurrence",
                "action": "override", "url": "https://meet.example/b", "place_id": room }),
    );
    assert_eq!(
        w.one::<Option<String>>("SELECT url FROM occurrence WHERE series_id = ?1", &[&id])
            .as_deref(),
        Some("https://meet.example/b")
    );
    assert_eq!(
        w.one::<Option<String>>(
            "SELECT place_id FROM occurrence WHERE series_id = ?1",
            &[&id]
        ),
        Some(room.clone())
    );
    // The series itself is untouched: guests and reminders stay the series'.
    assert_eq!(
        w.one::<Option<String>>("SELECT url FROM event WHERE id = ?1", &[&id]),
        None
    );
    // The place is a live place, or the day is refused.
    let sentence = w.refused(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-16T09:00:00", "scope": "occurrence",
                "action": "override", "place_id": id }),
    );
    assert!(sentence.contains("place"), "{sentence}");
}

#[test]
fn purging_a_place_a_day_names_leaves_the_day_with_the_series_place() {
    let w = World::new();
    let id = zoned_weekly(&w);
    let room = place(&w, "Room B");
    w.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-09T09:00:00", "scope": "occurrence",
                "action": "override", "place_id": room, "title": "Standup (B)" }),
    );
    w.ok("entity.trash", json!({ "id": room }));
    w.ok("entity.purge", json!({ "id": room }));
    assert_eq!(
        w.one::<Option<String>>(
            "SELECT place_id FROM occurrence WHERE series_id = ?1",
            &[&id]
        ),
        None,
        "the day stays, and reads the series' place again"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM occurrence WHERE series_id = ?1",
            &[&id]
        ),
        1
    );
}

// ---------------------------------------------------------------------------
// D6/H5 through the follower
// ---------------------------------------------------------------------------

fn follow(w: &World, calendar: &str, color: Option<&str>, records: Vec<Value>) -> Value {
    let mut origin = json!({ "ref": format!("calendar:{calendar}"), "label": calendar,
                              "device_id": "phone-1" });
    if let Some(color) = color {
        origin["color"] = json!(color);
    }
    w.ok(
        "follow.calendar",
        json!({ "origin": origin, "complete": true, "records": records }),
    )
}

fn series_with(moved: Value) -> Value {
    json!({ "external_id": "uid:trash", "fields": {
        "title": "Trash day", "starts": "2026-03-02", "ends": "2026-03-02", "timing": "all-day",
        "zone": null, "rule": "FREQ=WEEKLY",
        "overrides": { "from": "2026-03-01T00:00:00Z", "to": "2026-03-31T00:00:00Z",
                        "shown": ["2026-03-02", "2026-03-16"], "moved": [moved] } } })
}

#[test]
fn a_phone_s_moved_day_keeps_its_timing_link_and_place_through_the_follower() {
    let w = World::new();
    follow(
        &w,
        "home",
        None,
        vec![series_with(json!({
            "original_start": "2026-03-09", "timing": "floating",
            "starts": "2026-03-09T15:00:00", "ends": "2026-03-09T16:00:00",
            "title": "Trash day", "url": "https://meet.example/c", "location": "The depot" }))],
    );
    let id = w.one::<String>("SELECT entity_id FROM source", &[]);
    let (timing, _, starts, _) = w.day(&id, "2026-03-09");
    assert_eq!(timing.as_deref(), Some("floating"));
    assert_eq!(starts.as_deref(), Some("2026-03-09T15:00:00"));
    assert_eq!(
        w.one::<Option<String>>("SELECT url FROM occurrence WHERE series_id = ?1", &[&id])
            .as_deref(),
        Some("https://meet.example/c")
    );
    let place: Option<String> = w.one(
        "SELECT place_id FROM occurrence WHERE series_id = ?1",
        &[&id],
    );
    let place = place.expect("the phone's location became a place");
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&place]),
        "The depot"
    );
    // Said again: the same place, not another.
    follow(
        &w,
        "home",
        None,
        vec![series_with(json!({
            "original_start": "2026-03-09", "timing": "floating",
            "starts": "2026-03-09T15:00:00", "ends": "2026-03-09T16:00:00",
            "title": "Trash day", "url": "https://meet.example/c", "location": "the depot" }))],
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM place", &[]),
        1,
        "a location said twice is one place"
    );
}

// ---------------------------------------------------------------------------
// D7: one calendar per phone calendar, with its colour
// ---------------------------------------------------------------------------

fn dated(i: usize, calendar: &str) -> Value {
    json!({ "external_id": format!("uid:{calendar}{i}"), "fields": {
        "title": format!("{calendar} {i}"), "starts": format!("2026-03-{:02}T09:00:00", i + 1),
        "ends": format!("2026-03-{:02}T10:00:00", i + 1), "zone": "Europe/Paris" } })
}

#[test]
fn each_phone_calendar_is_a_calendar_of_the_vault_with_the_phone_s_colour() {
    let w = World::new();
    follow(&w, "home", Some("var(--c-teal)"), vec![dated(1, "home")]);
    follow(&w, "work", Some("var(--c-rose)"), vec![dated(1, "work")]);
    let calendars: i64 = w.one(
        "SELECT COUNT(*) FROM container WHERE kind = 'calendar' AND id <> 'calendar:default'",
        &[],
    );
    assert_eq!(calendars, 2, "one calendar per phone calendar");
    let home: String = w.one("SELECT fills FROM origin WHERE ref = 'calendar:home'", &[]);
    assert_eq!(
        w.one::<Option<String>>("SELECT color FROM container WHERE id = ?1", &[&home])
            .as_deref(),
        Some("var(--c-teal)")
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&home]),
        "home"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT e.calendar_id FROM event e JOIN entity n ON n.id = e.id WHERE n.title = 'home 1'",
            &[]
        ),
        home,
        "the event is on its own calendar, not calendar:default"
    );
    // The colour follows the phone's; the same calendar is kept, not made again.
    follow(&w, "home", Some("var(--c-indigo)"), vec![dated(1, "home")]);
    assert_eq!(
        w.one::<Option<String>>("SELECT color FROM container WHERE id = ?1", &[&home])
            .as_deref(),
        Some("var(--c-indigo)")
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM container WHERE kind = 'calendar' AND id <> 'calendar:default'",
            &[]
        ),
        2
    );
}

#[test]
fn a_calendar_the_member_renamed_keeps_their_name_and_one_they_did_not_follows_the_phone() {
    let w = World::new();
    follow(&w, "home", None, vec![dated(1, "home")]);
    follow(&w, "work", None, vec![dated(1, "work")]);
    let (home, work): (String, String) = (
        w.one("SELECT fills FROM origin WHERE ref = 'calendar:home'", &[]),
        w.one("SELECT fills FROM origin WHERE ref = 'calendar:work'", &[]),
    );
    w.ok("entity.retitle", json!({ "id": home, "title": "Family" }));
    let relabel = |calendar: &str, label: &str| {
        w.ok(
            "follow.calendar",
            json!({ "origin": { "ref": format!("calendar:{calendar}"), "label": label,
                                 "device_id": "phone-1" },
                     "complete": true, "records": [dated(1, calendar)] }),
        )
    };
    relabel("home", "iCloud: Home");
    relabel("work", "iCloud: Work");
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&home]),
        "Family",
        "the member's name stands"
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&work]),
        "iCloud: Work",
        "an untouched name follows the phone"
    );
}

#[test]
fn a_calendar_that_lost_most_of_its_events_trashes_none_of_them() {
    let w = World::new();
    let all: Vec<Value> = (1..=6).map(|i| dated(i, "home")).collect();
    follow(&w, "home", None, all);
    follow(&w, "work", None, vec![dated(1, "work")]);
    // The phone's read of `home` now holds one of its six; `work` is whole.
    let told = follow(&w, "home", None, vec![dated(1, "home")]);
    assert_eq!(told["doubted"].as_i64(), Some(5), "{told}");
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'event' AND deleted_at IS NOT NULL",
            &[]
        ),
        0,
        "nothing went to the trash"
    );
}

#[test]
fn a_purged_phone_calendar_ends_its_follow_and_the_next_pass_makes_it_again() {
    let w = World::new();
    follow(&w, "home", Some("var(--c-teal)"), vec![dated(1, "home")]);
    let home: String = w.one("SELECT fills FROM origin WHERE ref = 'calendar:home'", &[]);
    // A calendar with events cannot be purged: they are moved or deleted first.
    let sentence = w.refused("entity.purge", json!({ "id": home }));
    assert!(sentence.contains("event"), "{sentence}");
    w.sql(
        "UPDATE event SET calendar_id = 'calendar:default' WHERE calendar_id = ?1",
        &[&home],
    );
    w.ok("entity.purge", json!({ "id": home }));
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM origin", &[]), 0);
    follow(&w, "home", Some("var(--c-teal)"), vec![dated(1, "home")]);
    let again: String = w.one("SELECT fills FROM origin WHERE ref = 'calendar:home'", &[]);
    assert_ne!(again, home, "a new calendar, since the old one is gone");
}
