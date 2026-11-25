//! What Calendar reads (#1214 L3, G3): a day, a week, a month, people's dates, and what overlaps.
//! Each read is a bounded index walk, so the plan of each statement is asked of SQLite: an index
//! name, never a scan or a sort, whatever the vault holds.

mod common;

use centraid_vault::commands::event::reads::{self, Appearance, Source};
use common::world::World;
use serde_json::json;

fn event(w: &World, input: serde_json::Value) -> String {
    w.ok("event.propose", input)["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

fn read<T>(w: &World, body: impl FnOnce(&rusqlite::Connection) -> centraid_vault::Result<T>) -> T {
    w.vault().read(body).expect("a read")
}

fn titles(items: &[Appearance]) -> Vec<String> {
    items
        .iter()
        .map(|i| format!("{}@{}", i.title, i.day))
        .collect()
}

fn date(w: &World, person: &str, kind: &str, date: &str) -> String {
    let id = w.mint();
    let single = i32::from(kind == "birthday");
    w.commit(|tx| {
        tx.connection().execute(
            "INSERT INTO person_date (id, person_id, kind, single, date) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, person, kind, single, date],
        )?;
        Ok(())
    });
    id
}

#[test]
fn a_day_a_week_and_a_month_hold_the_events_that_are_on_them_in_the_viewers_zone() {
    let w = World::new("event_reads");
    // Zoned: 23:30 in New York on the 4th is the 5th in UTC; the viewer's day decides.
    event(&w, json!({ "title": "Late call", "starts": "2026-03-04T23:30", "ends": "2026-03-05T00:30", "zone": "America/New_York" }));
    event(&w, json!({ "title": "Lunch", "starts": "2026-03-05T12:00", "ends": "2026-03-05T13:00", "timing": "floating" }));
    event(&w, json!({ "title": "Holiday", "starts": "2026-03-05", "ends": "2026-03-07", "busy": false }));
    event(&w, json!({ "title": "Next week", "starts": "2026-03-12T09:00", "timing": "floating" }));
    event(&w, json!({ "title": "April", "starts": "2026-04-02T09:00", "timing": "floating" }));
    let trashed = event(&w, json!({ "title": "Gone", "starts": "2026-03-05T15:00", "timing": "floating" }));
    w.ok("entity.trash", json!({ "id": &trashed }));

    let ny = read(&w, |c| reads::day(c, "2026-03-04", Some("America/New_York")));
    assert_eq!(titles(&ny), vec!["Late call@2026-03-04"]);
    let utc = read(&w, |c| reads::day(c, "2026-03-05", Some("UTC")));
    assert_eq!(
        titles(&utc),
        vec!["Holiday@2026-03-05", "Late call@2026-03-05", "Lunch@2026-03-05"],
        "all-day first, then by the clock"
    );
    // A multi-day event is on every day it covers, and says where it ends.
    let sixth = read(&w, |c| reads::day(c, "2026-03-06", Some("UTC")));
    assert_eq!(titles(&sixth), vec!["Holiday@2026-03-06"]);
    assert_eq!(sixth[0].last_day, "2026-03-07");
    // The week from a Monday holds that week; the month holds March.
    let week = read(&w, |c| reads::week(c, "2026-03-05", 1, Some("UTC")));
    assert_eq!(
        titles(&week),
        vec!["Holiday@2026-03-05", "Late call@2026-03-05", "Lunch@2026-03-05"]
    );
    let month = read(&w, |c| reads::month(c, 2026, 3, Some("UTC")));
    assert_eq!(month.len(), 4, "{:?}", titles(&month));
    assert!(titles(&month).contains(&"Next week@2026-03-12".to_owned()));
    // An event that began before the window and still runs into it is in it.
    let running = read(&w, |c| reads::window(c, "2026-03-07", 1, Some("UTC")));
    assert_eq!(titles(&running), vec!["Holiday@2026-03-07"]);
    // Nothing on a quiet day, and a window is capped at a month grid.
    assert!(read(&w, |c| reads::day(c, "2026-03-20", Some("UTC"))).is_empty());
    assert!(read(&w, |c| reads::window(c, "2026-01-01", 400, Some("UTC"))).len() <= 5);
}

#[test]
fn a_series_shows_its_days_with_the_changes_to_them() {
    let w = World::new("event_reads_series");
    let id = event(
        &w,
        json!({ "title": "Standup", "starts": "2026-03-02T09:00", "ends": "2026-03-02T09:30",
                "zone": "Europe/Paris", "rule": "FREQ=WEEKLY" }),
    );
    w.ok("event.edit_occurrence", json!({ "id": &id, "original_start": "2026-03-09T08:00:00.000Z", "action": "skip" }));
    w.ok(
        "event.edit_occurrence",
        json!({ "id": &id, "original_start": "2026-03-16T08:00:00.000Z", "action": "override",
                "starts": "2026-03-17T10:30", "title": "Late standup", "location": "Room 4" }),
    );
    let march = read(&w, |c| reads::month(c, 2026, 3, Some("Europe/Paris")));
    assert_eq!(
        titles(&march),
        vec![
            "Standup@2026-03-02",
            "Late standup@2026-03-17",
            "Standup@2026-03-23",
            "Standup@2026-03-30"
        ],
        "the 9th is skipped, the 16th moved to the 17th at half past ten"
    );
    let moved = &march[1];
    assert_eq!(moved.original_start.as_deref(), Some("2026-03-16T08:00:00.000Z"));
    assert_eq!(moved.location.as_deref(), Some("Room 4"));
    assert_eq!(moved.ends.as_deref(), Some("2026-03-17T10:00:00.000Z"), "the series' length goes with it");
    assert!(moved.repeats);
    // A split ends the old series and starts the new: the days read as one run.
    w.ok("event.split", json!({ "id": &id, "original_start": "2026-03-23T08:00:00.000Z", "starts": "2026-03-23T10:00", "title": "Late standup" }));
    let after = read(&w, |c| reads::month(c, 2026, 3, Some("Europe/Paris")));
    assert_eq!(
        titles(&after),
        vec![
            "Standup@2026-03-02",
            "Late standup@2026-03-17",
            "Late standup@2026-03-23",
            "Late standup@2026-03-30"
        ]
    );
    // A series with a rule the expander cannot read stands for its first day.
    w.commit(|tx| {
        tx.connection().execute(
            "UPDATE event SET rule_supported = 0 WHERE id = ?1",
            [&id],
        )?;
        Ok(())
    });
    let odd = read(&w, |c| reads::month(c, 2026, 3, Some("Europe/Paris")));
    assert_eq!(odd.iter().filter(|i| i.id == id).count(), 1);
}

#[test]
fn people_s_dates_are_shown_on_their_day_and_are_never_events() {
    let w = World::new("event_reads_dates");
    let maya = w.person("Maya");
    let jo = w.person("Jo");
    date(&w, &maya, "birthday", "1990-03-05");
    date(&w, &jo, "birthday", "--03-05");
    let leap = date(&w, &jo, "anniversary", "2000-02-29");
    let future = w.person("Not yet");
    date(&w, &future, "birthday", "2040-03-05");
    event(&w, json!({ "title": "Lunch", "starts": "2026-03-05T12:00", "timing": "floating" }));
    let events_before: i64 = w.one("SELECT COUNT(*) FROM event", &[]);
    let day = read(&w, |c| reads::day(c, "2026-03-05", Some("UTC")));
    assert_eq!(
        day.iter()
            .map(|i| (i.source, i.title.clone(), i.year))
            .collect::<Vec<_>>(),
        vec![
            (Source::PersonDate, "Maya".to_owned(), Some(1990)),
            (Source::PersonDate, "Jo".to_owned(), None),
            (Source::Event, "Lunch".to_owned(), None),
        ],
        "a date is shown on its day every year, from the year it began; before that nobody has it"
    );
    assert!(day.iter().all(|i| i.title != "Not yet"));
    assert_eq!(day[0].date_kind.as_deref(), Some("birthday"));
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM event", &[]), events_before, "a date makes no event");
    // 29 February falls on the 28th in a year with no leap day, on the 29th in one.
    let feb = read(&w, |c| reads::day(c, "2026-02-28", Some("UTC")));
    assert_eq!(feb.iter().map(|i| i.id.clone()).collect::<Vec<_>>(), vec![leap.clone()]);
    let leap_year = read(&w, |c| reads::window(c, "2028-02-28", 2, Some("UTC")));
    assert_eq!(
        leap_year.iter().map(|i| i.day.clone()).collect::<Vec<_>>(),
        vec!["2028-02-29"]
    );
    // A person in the trash has no date on the calendar.
    w.ok("entity.trash", json!({ "id": &maya }));
    let after = read(&w, |c| reads::day(c, "2026-03-05", Some("UTC")));
    assert!(after.iter().all(|i| i.title != "Maya"));
}

#[test]
fn an_overlap_is_a_read_never_a_refusal() {
    let w = World::new("event_reads_overlap");
    let a = event(&w, json!({ "title": "A", "starts": "2026-03-05T10:00", "ends": "2026-03-05T12:00", "timing": "floating" }));
    let b = event(&w, json!({ "title": "B", "starts": "2026-03-05T11:00", "ends": "2026-03-05T11:30", "timing": "floating" }));
    let c = event(&w, json!({ "title": "C", "starts": "2026-03-05T11:15", "ends": "2026-03-05T13:00", "timing": "floating" }));
    let found = read(&w, |conn| reads::overlaps(conn, "2026-03-05", 1, Some("UTC")));
    let pairs: Vec<(String, String)> = found
        .iter()
        .map(|o| (o.first.0.clone(), o.second.0.clone()))
        .collect();
    assert_eq!(
        pairs,
        vec![(a.clone(), b.clone()), (a.clone(), c.clone()), (b, c)]
    );
    // A cancelled event blocks nothing, and neither does one that was made free.
    w.ok("event.cancel", json!({ "id": &a }));
    let found = read(&w, |conn| reads::overlaps(conn, "2026-03-05", 1, Some("UTC")));
    assert_eq!(found.len(), 1);
}

// ---------------------------------------------------------------------------------------------
// The plans: each statement is an index walk
// ---------------------------------------------------------------------------------------------

fn plan(w: &World, sql: &str, binds: &[&str]) -> Vec<String> {
    let binds: Vec<centraid_vault::value::Value> = binds
        .iter()
        .map(|text| centraid_vault::value::Value::Text((*text).to_owned()))
        .collect();
    w.vault().explain_query_plan(sql, &binds).expect("a plan")
}

fn assert_walk(plan: &[String], index: &str) {
    let text = plan.join("\n");
    assert!(text.contains(index), "no `{index}` in:\n{text}");
    assert!(!text.contains("TEMP B-TREE"), "a sort in:\n{text}");
    for line in plan {
        assert!(
            !line.starts_with("SCAN ") || line.contains("USING"),
            "a scan in:\n{text}"
        );
    }
}

#[test]
fn every_statement_of_a_calendar_read_is_an_index_walk() {
    let w = World::new("event_reads_plans");
    // A vault with rows in every table the reads touch, so the planner has statistics to be wrong about.
    for n in 0..30 {
        event(&w, json!({ "title": format!("E{n}"), "starts": format!("2026-03-{:02}T09:00", n % 28 + 1), "timing": "floating" }));
    }
    let maya = w.person("Maya");
    date(&w, &maya, "birthday", "1990-03-05");
    assert_walk(
        &plan(
            &w,
            reads::SINGLES,
            &["2026-01-01T00:00", "2026-04-01T00:00", "floating", "2026-03-01T00:00"],
        ),
        "event_by_start",
    );
    assert_walk(&plan(&w, reads::SERIES, &["2026-04-01T00:00"]), "event_by_rule");
    assert_walk(
        &plan(&w, reads::OVERRIDES, &["x", "2026-01-01", "2026-12-31"]),
        "sqlite_autoindex_occurrence",
    );
    assert_walk(
        &plan(&w, reads::LONG, &["2026-04-01T00:00", "2026-03-01T00:00", "floating"]),
        "event_long",
    );
    assert_walk(
        &plan(&w, reads::MOVED, &["2026-03-01T00:00", "2026-04-01T00:00"]),
        "occurrence_by_moved",
    );
    assert_walk(&plan(&w, reads::DATES, &["03-05"]), "person_date_by_day");
    // The overlap read and the three entry points run these and no others: guests are one seek of
    // the key, and the series' `occurrence` rows one range of theirs.
    assert_walk(
        &plan(&w, centraid_vault::commands::event::GUESTS, &["x"]),
        "PRIMARY KEY (event_id=?)",
    );
}

#[test]
fn a_long_event_is_found_by_its_own_index_and_costs_a_window_nothing_it_did_not_hold() {
    let w = World::new("event_reads_long");
    event(&w, json!({ "title": "Semester", "starts": "2026-01-12", "ends": "2026-05-29", "busy": false }));
    event(&w, json!({ "title": "Trip", "starts": "2026-03-01T08:00", "ends": "2026-03-20T18:00", "timing": "floating" }));
    event(&w, json!({ "title": "Weekend", "starts": "2026-03-06", "ends": "2026-03-08", "busy": false }));
    for month in ["01", "02", "04", "05"] {
        for n in 1..=20 {
            event(&w, json!({ "title": format!("m{month}d{n}"), "starts": format!("2026-{month}-{n:02}T09:00"), "timing": "floating" }));
        }
    }
    let day = read(&w, |c| reads::day(c, "2026-03-10", Some("UTC")));
    assert_eq!(titles(&day), vec!["Semester@2026-03-10", "Trip@2026-03-10"]);
    let after = read(&w, |c| reads::day(c, "2026-06-10", Some("UTC")));
    assert!(after.is_empty(), "the semester ended in May");
    let weekend = read(&w, |c| reads::day(c, "2026-03-08", Some("UTC")));
    assert_eq!(titles(&weekend), vec!["Semester@2026-03-08", "Weekend@2026-03-08", "Trip@2026-03-08"]);
    // The rows the walk reads are counted by SQLite, not timed: the long events plus the week behind
    // the window, never the months of short events elsewhere.
    let (short, long): (i64, i64) = read(&w, |c| {
        Ok((
            c.query_row(
                "SELECT COUNT(*) FROM event WHERE long IS NULL AND starts >= '2026-03-02' AND starts < '2026-03-11'",
                [],
                |r| r.get(0),
            )?,
            c.query_row("SELECT COUNT(*) FROM event WHERE long = 1", [], |r| r.get(0))?,
        ))
    });
    assert_eq!((short, long), (1, 2), "{} events in the vault, 3 of them read", w.one::<i64>("SELECT COUNT(*) FROM event", &[]));
    // A day moved into a window from months away is found by its own index.
    let id = event(&w, json!({ "title": "Standup", "starts": "2026-01-05T09:00", "timing": "floating", "rule": "FREQ=WEEKLY" }));
    w.ok("event.edit_occurrence", json!({ "id": &id, "original_start": "2026-01-12T09:00", "action": "override", "starts": "2026-08-05T10:00" }));
    let august = read(&w, |c| reads::day(c, "2026-08-05", Some("UTC")));
    assert_eq!(titles(&august), vec!["Standup@2026-08-05"]);
    assert_eq!(august[0].original_start.as_deref(), Some("2026-01-12T09:00"));
}
