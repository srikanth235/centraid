//! A task's own verbs against the v0 tables (#1214, the calendar-and-tasks lane): made, edited,
//! completed and reopened; its home (a task list, a parent task) and `entity.move`; the
//! one time vocabulary (`due`, `due_timing`, `zone`) and the planned day (`scheduled_on`); a
//! repeating task's series, its successor and a snooze; the reminders a task holds as rows, the
//! alerts they make and the defaults a timed due is given; the Today, Upcoming and Done reads and
//! the true counts, each proved to plan as a walk of the index named; search and earlier versions.
//! The trash, a star and a tag are the shared verbs (`shared_verbs.rs`) and only arrange a state
//! here. The rules the database holds for these tables are in `schema_rules.rs`; the calendar file
//! is `tasks_portable.rs`; following the phone's Reminders is `follow_reminders.rs`.

mod common;

use std::collections::BTreeSet;

use centraid_vault::task_counts::{self, Day, OpenTaskCounts};
use common::world::World;
use serde_json::{Value, json};

fn task(w: &World, input: Value) -> String {
    w.ok("task.add", input)["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

fn due(w: &World, id: &str) -> (Option<String>, Option<String>, Option<String>) {
    w.vault()
        .read(|c| {
            Ok(c.query_row(
                "SELECT due, due_timing, zone FROM task WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("a task")
}

fn status(w: &World, id: &str) -> String {
    w.one("SELECT status FROM task WHERE id = ?1", &[id])
}

fn leads(w: &World, id: &str) -> Vec<i64> {
    w.vault()
        .read(|c| {
            Ok(c.prepare(
                "SELECT offset_min FROM reminder WHERE entity_id = ?1 ORDER BY offset_min",
            )?
            .query_map([id], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<i64>>>()?)
        })
        .expect("leads")
}

/// The alerts a task holds in the index file: `(lead, timing, fire_key)`, smallest lead first.
fn fires(w: &World, id: &str) -> Vec<(i64, String, String)> {
    w.vault()
        .read(|c| {
            Ok(c.prepare(
                "SELECT r.offset_min, a.timing, a.fire_key FROM alert a
                   JOIN reminder r ON r.id = a.reminder_id
                  WHERE r.entity_id = ?1 ORDER BY r.offset_min",
            )?
            .query_map([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .expect("alerts")
}

fn plan(w: &World, sql: &str, binds: &[&str]) -> String {
    w.vault()
        .read(|c| {
            let mut statement = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(binds), |row| {
                    row.get::<_, String>(3)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.join(" | "))
        })
        .expect("a plan")
}

fn parent_of(w: &World, id: &str) -> Option<String> {
    w.one("SELECT parent_id FROM entity WHERE id = ?1", &[id])
}

fn versions(w: &World, id: &str) -> i64 {
    w.one("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &[id])
}

// ---------------------------------------------------------------------------------------------
// 1. Create, edit, complete, reopen
// ---------------------------------------------------------------------------------------------

#[test]
fn a_task_is_made_edited_completed_reopened_and_cancelled() {
    let w = World::new("task_basic");
    let id = task(
        &w,
        json!({ "title": "  Call Mum ", "description": "about Sunday", "priority": 3,
                "url": " https://example.com/mum " }),
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Call Mum"
    );
    assert_eq!(status(&w, &id), "open");
    assert_eq!(
        w.one::<i64>("SELECT priority FROM task WHERE id = ?1", &[&id]),
        3
    );
    assert_eq!(
        w.one::<String>("SELECT url FROM task WHERE id = ?1", &[&id]),
        "https://example.com/mum"
    );
    assert_eq!(due(&w, &id), (None, None, None), "no due, no timing");

    w.ok(
        "task.edit",
        json!({ "id": id, "title": "Call Mother", "description": null, "priority": 0,
                "url": null }),
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Call Mother"
    );
    for column in ["description", "url"] {
        assert_eq!(
            w.one::<Option<String>>(
                &format!("SELECT CAST({column} AS TEXT) FROM task WHERE id = ?1"),
                &[&id]
            ),
            None,
            "{column} was cleared"
        );
    }
    assert_eq!(
        w.one::<i64>("SELECT priority FROM task WHERE id = ?1", &[&id]),
        0
    );

    let done = w.ok("task.complete", json!({ "id": id }));
    assert_eq!(done["status"], "done");
    assert!(done["next_id"].is_null() && done["series_id"].is_null());
    assert_eq!(status(&w, &id), "done");
    let at: String = w.one("SELECT done_at FROM task WHERE id = ?1", &[&id]);
    // Completing again is the same answer: the first moment stands.
    w.ok("task.complete", json!({ "id": id }));
    assert_eq!(
        w.one::<String>("SELECT done_at FROM task WHERE id = ?1", &[&id]),
        at
    );
    w.ok("task.reopen", json!({ "id": id }));
    assert_eq!(status(&w, &id), "open");
    assert_eq!(
        w.one::<Option<String>>("SELECT done_at FROM task WHERE id = ?1", &[&id]),
        None
    );
    w.ok("task.cancel", json!({ "id": id }));
    assert_eq!(status(&w, &id), "cancelled");
    w.ok("task.reopen", json!({ "id": id }));
    assert_eq!(status(&w, &id), "open");
}

#[test]
fn a_task_is_refused_what_a_sentence_says_and_the_database_holds_too() {
    let w = World::new("task_refusals");
    assert!(
        w.refused("task.add", json!({ "title": "   " }))
            .contains("needs a title")
    );
    assert!(
        w.refused("task.add", json!({ "title": "x", "url": "  " }))
            .contains("needs an address")
    );
    assert!(
        w.refused("task.add", json!({ "title": "x", "rule": "FREQ=DAILY" }))
            .contains("needs a due date")
    );
    assert!(
        w.refused(
            "task.add",
            json!({ "title": "x", "due": "2026-03-02", "rule": "FREQ=BANANA" })
        )
        .contains("FREQ")
    );
    assert!(
        w.refused("task.add", json!({ "title": "x", "reminders": [10] }))
            .contains("needs a due date")
    );
    assert!(
        w.refused(
            "task.add",
            json!({ "title": "x", "scheduled_on": "2026-02-30" })
        )
        .contains("not a day")
    );
    let id = task(&w, json!({ "title": "x" }));
    assert!(
        w.refused("task.edit", json!({ "id": id, "title": " " }))
            .contains("needs a title")
    );
    assert!(
        w.refused("task.edit", json!({ "id": id, "rule": "FREQ=DAILY" }))
            .contains("needs a due date")
    );
    // A task has no snooze of its own to edit: `alert.snooze` moves the alert of a reminder that is there.
    assert!(
        w.refused(
            "alert.snooze",
            json!({ "entity_id": id, "until": "2099-03-02T10:00:00Z" })
        )
        .contains("no reminder")
    );
    // A task made with the id of another is refused, and an edit of a note is.
    assert!(
        w.refused("task.add", json!({ "title": "y", "id": id }))
            .contains("already exists")
    );
    let note = w.note("A note");
    assert!(
        w.refused("task.edit", json!({ "id": note, "title": "z" }))
            .contains("not a task")
    );
}

// ---------------------------------------------------------------------------------------------
// 2. One home
// ---------------------------------------------------------------------------------------------

#[test]
fn a_task_is_made_in_a_task_list_or_under_a_task_and_moved_by_entity_move() {
    let w = World::new("task_home");
    let errands = w.container("task_list", "Errands");
    let garden = w.container("task_list", "Garden");
    let loose = task(&w, json!({ "title": "Loose" }));
    let in_list = task(&w, json!({ "title": "Milk", "parent_id": errands }));
    let in_other = task(&w, json!({ "title": "Post", "parent_id": errands }));
    let sub = task(&w, json!({ "title": "Stamps", "parent_id": in_other }));
    assert_eq!(parent_of(&w, &loose), None);
    for (id, home, kind) in [(&in_list, &errands, "task_list"), (&sub, &in_other, "task")] {
        assert_eq!(parent_of(&w, id).as_deref(), Some(home.as_str()));
        assert_eq!(
            w.one::<String>("SELECT parent_kind FROM entity WHERE id = ?1", &[id]),
            kind
        );
    }
    // A task does not go inside a note, an event's calendar or a trashed task list.
    let note = w.note("N");
    assert!(
        w.refused("task.add", json!({ "title": "x", "parent_id": note }))
            .contains("does not go inside")
    );
    // The one verb that moves it: a task to another task list, under a task, to the top level.
    w.ok("entity.move", json!({ "id": in_list, "parent": garden }));
    assert_eq!(parent_of(&w, &in_list).as_deref(), Some(garden.as_str()));
    w.ok("entity.move", json!({ "id": loose, "parent": in_list }));
    assert_eq!(
        w.one::<String>("SELECT parent_kind FROM entity WHERE id = ?1", &[&loose]),
        "task"
    );
    w.ok("entity.move", json!({ "id": loose, "parent": null }));
    assert_eq!(parent_of(&w, &loose), None);
    // Never inside itself or below itself.
    assert!(
        w.refused("entity.move", json!({ "id": in_other, "parent": sub }))
            .contains("subtask")
    );
    assert!(
        w.refused("task.add", json!({ "title": "Deeper", "parent_id": sub }))
            .contains("subtask of its own")
    );
    assert!(
        w.refused("entity.move", json!({ "id": in_other, "parent": in_list }))
            .contains("has subtasks")
    );
    // A task cannot be moved to a note either.
    assert!(
        w.refused("entity.move", json!({ "id": loose, "parent": note }))
            .contains("does not go inside")
    );
    // The old per-kind verbs are gone: organising is order and repeat measure only.
    w.ok("task.organize", json!({ "id": loose, "position": 7.5 }));
    assert_eq!(
        w.one::<f64>("SELECT position FROM task WHERE id = ?1", &[&loose]),
        7.5
    );
}

#[test]
fn trashing_a_task_takes_its_subtasks_and_a_restore_brings_them_back() {
    let w = World::new("task_trash");
    let parent = task(&w, json!({ "title": "Move house" }));
    let child = task(&w, json!({ "title": "Box up books", "parent_id": parent }));
    let both = |w: &World| {
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE id IN (?1, ?2) AND deleted_at IS NOT NULL",
            &[&parent, &child],
        )
    };
    w.ok("entity.trash", json!({ "id": parent }));
    assert_eq!(both(&w), 2);
    // A task in the trash is frozen: an edit says so.
    assert!(
        w.refused("task.edit", json!({ "id": child, "title": "x" }))
            .contains("trash")
    );
    w.ok("entity.restore", json!({ "id": parent }));
    assert_eq!(both(&w), 0);
    w.ok("entity.trash", json!({ "id": parent }));
    w.ok("entity.purge", json!({ "id": parent }));
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM task", &[]), 0);
}

#[test]
fn a_task_list_trashes_its_tasks_and_a_task_is_found_by_its_list_and_a_rename_reaches_it() {
    let w = World::new("task_list");
    let project = w.container("task_list", "Garden");
    let id = task(
        &w,
        json!({ "title": "Prune", "parent_id": project, "description": "roses" }),
    );
    let found = |term: &str| {
        w.one::<i64>(
            "SELECT count(*) FROM search s JOIN entity e ON e.n = s.rowid
              WHERE search MATCH ?1 AND e.id = ?2",
            &[term, &id],
        ) == 1
    };
    assert!(found("garden") && found("roses") && found("prune"));
    w.ok(
        "entity.retitle",
        json!({ "id": project, "title": "Allotment" }),
    );
    assert!(found("allotment") && !found("garden"));
    w.ok("entity.trash", json!({ "id": project }));
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&id])
            .is_some()
    );
}

// ---------------------------------------------------------------------------------------------
// 3. One time vocabulary
// ---------------------------------------------------------------------------------------------

#[test]
fn a_due_is_a_zoned_instant_a_floating_minute_or_a_day_and_its_timing_follows() {
    let w = World::new("task_due");
    // An instant in any spelling is held in the clock's one form, read in a zone (the vault's, else
    // UTC) unless one is named.
    let a = task(
        &w,
        json!({ "title": "a", "due": "2026-03-02T10:00:00+01:00" }),
    );
    assert_eq!(
        due(&w, &a),
        (
            Some("2026-03-02T09:00:00.000Z".into()),
            Some("zoned".into()),
            Some("Etc/UTC".into())
        )
    );
    let b = task(
        &w,
        json!({ "title": "b", "due": "2026-03-02T10:00:00Z", "zone": "Europe/Paris" }),
    );
    assert_eq!(due(&w, &b).2.as_deref(), Some("Europe/Paris"));
    // A wall clock to the minute is floating; the seconds a phone spells are dropped when zero.
    let c = task(&w, json!({ "title": "c", "due": "2026-03-02T09:00:00" }));
    assert_eq!(
        due(&w, &c),
        (
            Some("2026-03-02T09:00".into()),
            Some("floating".into()),
            None
        )
    );
    // A wall clock with a zone is the instant it is there.
    let d = task(
        &w,
        json!({ "title": "d", "due": "2026-03-02T09:00", "zone": "Europe/Paris" }),
    );
    assert_eq!(
        due(&w, &d),
        (
            Some("2026-03-02T08:00:00.000Z".into()),
            Some("zoned".into()),
            Some("Europe/Paris".into())
        )
    );
    // A day is all-day.
    let e = task(&w, json!({ "title": "e", "due": "2026-03-02" }));
    assert_eq!(
        due(&w, &e),
        (Some("2026-03-02".into()), Some("all-day".into()), None)
    );
    // What it refuses, each in a sentence.
    for (input, fragment) in [
        (json!({ "due": "banana" }), "due"),
        (json!({ "due": "2026-03-02T09:00:30" }), "to the minute"),
        (
            json!({ "due": "2026-03-02", "zone": "Europe/Paris" }),
            "no zone",
        ),
        (
            json!({ "due": "2026-03-02T10:00:00Z", "zone": "Mars/Olympus" }),
            "not a time zone",
        ),
        (json!({ "due": null, "zone": "Europe/Paris" }), "zone"),
    ] {
        let mut input = input;
        input["title"] = json!("x");
        let sentence = w.refused("task.add", input.clone());
        assert!(sentence.contains(fragment), "{input}: {sentence}");
    }
    // An edit moves a due between the forms and the timing and zone follow it.
    w.ok("task.edit", json!({ "id": a, "due": "2026-03-05" }));
    assert_eq!(
        due(&w, &a),
        (Some("2026-03-05".into()), Some("all-day".into()), None)
    );
    w.ok("task.edit", json!({ "id": a, "due": "2026-03-05T18:30" }));
    assert_eq!(due(&w, &a).1.as_deref(), Some("floating"));
    w.ok(
        "task.edit",
        json!({ "id": a, "due": "2026-03-05T18:30:00Z", "zone": "Asia/Kolkata" }),
    );
    assert_eq!(
        due(&w, &a),
        (
            Some("2026-03-05T18:30:00.000Z".into()),
            Some("zoned".into()),
            Some("Asia/Kolkata".into())
        )
    );
    // The zone alone moves how the same moment is read; only a moment has one.
    w.ok("task.organize", json!({ "id": a, "zone": "Europe/Paris" }));
    assert_eq!(
        due(&w, &a),
        (
            Some("2026-03-05T18:30:00.000Z".into()),
            Some("zoned".into()),
            Some("Europe/Paris".into())
        )
    );
    assert!(
        w.refused("task.organize", json!({ "id": e, "zone": "Europe/Paris" }))
            .contains("only a due that is a moment")
    );
    assert!(
        w.refused("task.organize", json!({ "id": a, "zone": null }))
            .contains("read in a zone")
    );
    w.ok("task.edit", json!({ "id": a, "due": null }));
    assert_eq!(due(&w, &a), (None, None, None));
}

#[test]
fn the_planned_day_is_not_the_due_and_today_reads_both() {
    let w = World::new("task_scheduled");
    let id = task(
        &w,
        json!({ "title": "Plan me", "due": "2026-03-09", "scheduled_on": "2026-03-02" }),
    );
    assert_eq!(
        w.one::<String>("SELECT scheduled_on FROM task WHERE id = ?1", &[&id]),
        "2026-03-02"
    );
    assert_eq!(
        due(&w, &id).0.as_deref(),
        Some("2026-03-09"),
        "the due is its own"
    );
    let day = Day {
        today: "2026-03-02",
        tomorrow: "2026-03-03",
        starts: "2026-03-02T00:00:00.000Z",
        ends: "2026-03-03T00:00:00.000Z",
    };
    let ids = |rows: Vec<task_counts::TaskRow>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
    let today = |w: &World| {
        ids(w
            .vault()
            .read(|c| task_counts::today(c, &day, 50))
            .expect("today"))
    };
    assert_eq!(
        today(&w),
        std::slice::from_ref(&id),
        "planned for today though not due"
    );
    w.ok(
        "task.edit",
        json!({ "id": id, "scheduled_on": "2026-03-03" }),
    );
    assert!(today(&w).is_empty());
    w.ok("task.edit", json!({ "id": id, "scheduled_on": null }));
    assert_eq!(
        w.one::<Option<String>>("SELECT scheduled_on FROM task WHERE id = ?1", &[&id]),
        None
    );
    assert!(
        w.refused("task.edit", json!({ "id": id, "scheduled_on": "tomorrow" }))
            .contains("not a day")
    );
}

// ---------------------------------------------------------------------------------------------
// 4. A repeating task: its series, its successor, a snooze
// ---------------------------------------------------------------------------------------------

#[test]
fn a_repeating_task_names_its_series_when_the_rule_is_first_set_and_the_successor_carries_it() {
    let w = World::new("task_series");
    let mum = w.person("Mum");
    let project = w.container("task_list", "Home");
    let id = task(
        &w,
        json!({ "title": "Call Mum", "due": "2026-03-02", "rule": "FREQ=WEEKLY",
                "parent_id": project, "priority": 3, "reminders": [30] }),
    );
    let series: String = w.one("SELECT series_id FROM task WHERE id = ?1", &[&id]);
    assert_eq!(series.len(), 36, "a minted id");
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[&series]),
        0,
        "it points at no row"
    );
    w.ok("edge.add", json!({ "from": id, "rel": "about", "to": mum }));
    w.ok("tag.add", json!({ "id": id, "label": "family" }));
    w.ok("flag.set", json!({ "id": id, "flag": "starred" }));
    let done = w.ok("task.complete", json!({ "id": id }));
    let next = done["next_id"].as_str().expect("a successor").to_owned();
    assert_eq!(done["next_due"], "2026-03-09");
    assert_eq!(done["series_id"], series.as_str());
    assert_eq!(
        w.one::<String>("SELECT series_id FROM task WHERE id = ?1", &[&next]),
        series
    );
    // Completing it again is the same answer and no second successor.
    let again = w.ok("task.complete", json!({ "id": id }));
    assert!(again["next_id"].is_null());
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM task WHERE series_id = ?1", &[&series]),
        2
    );
    // The successor is still about Mum, tagged, starred, filed, as urgent and as alerted.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel IN ('about', 'tagged')",
            &[&next]
        ),
        2
    );
    assert_eq!(parent_of(&w, &next).as_deref(), Some(project.as_str()));
    assert_eq!(
        w.one::<i64>("SELECT priority FROM task WHERE id = ?1", &[&next]),
        3
    );
    assert!(
        w.one::<Option<String>>("SELECT starred_at FROM entity WHERE id = ?1", &[&next])
            .is_some()
    );
    assert_eq!(leads(&w, &next), [30]);
    assert_eq!(
        fires(&w, &next),
        [(30, "floating".to_owned(), "2026-03-09T08:30".to_owned())],
        "an all-day lead counts back from nine in the morning"
    );
    assert!(
        fires(&w, &id).is_empty(),
        "a finished occurrence alerts no more"
    );
    // Purging the first occurrence no longer cuts the series.
    w.ok("entity.trash", json!({ "id": id }));
    w.ok("entity.purge", json!({ "id": id }));
    assert_eq!(
        w.one::<String>("SELECT series_id FROM task WHERE id = ?1", &[&next]),
        series
    );
    let third = w.ok("task.complete", json!({ "id": next }));
    assert_eq!(third["series_id"], series.as_str());
    assert_eq!(third["next_due"], "2026-03-16");
    // The series is one seek of `task_by_series`.
    let seek = plan(
        &w,
        "SELECT id FROM task WHERE series_id = ?1 ORDER BY due, id",
        &[&series],
    );
    assert!(
        seek.contains("task_by_series") && !seek.contains("TEMP B-TREE"),
        "{seek}"
    );
    // Reopening makes it open and spawns nothing; cancelling ends it so.
    let count =
        |w: &World| w.one::<i64>("SELECT COUNT(*) FROM task WHERE series_id = ?1", &[&series]);
    let before = count(&w);
    w.ok("task.reopen", json!({ "id": next }));
    w.ok("task.cancel", json!({ "id": next }));
    assert_eq!(count(&w), before);
}

#[test]
fn a_series_begins_when_the_rule_is_first_set_by_an_edit_and_a_cleared_rule_keeps_it() {
    let w = World::new("task_series_edit");
    let id = task(&w, json!({ "title": "Water", "due": "2026-03-02" }));
    assert_eq!(
        w.one::<Option<String>>("SELECT series_id FROM task WHERE id = ?1", &[&id]),
        None,
        "a task that never repeats names no series"
    );
    w.ok("task.edit", json!({ "id": id, "rule": "FREQ=DAILY" }));
    let series: String = w.one("SELECT series_id FROM task WHERE id = ?1", &[&id]);
    // Editing the rule again keeps the identity.
    w.ok("task.edit", json!({ "id": id, "rule": "FREQ=WEEKLY" }));
    assert_eq!(
        w.one::<String>("SELECT series_id FROM task WHERE id = ?1", &[&id]),
        series
    );
    w.ok("task.edit", json!({ "id": id, "rule": null }));
    assert_eq!(
        w.one::<String>("SELECT series_id FROM task WHERE id = ?1", &[&id]),
        series
    );
    // A task cannot lose its due while it repeats.
    w.ok("task.edit", json!({ "id": id, "rule": "FREQ=DAILY" }));
    assert!(
        w.refused("task.edit", json!({ "id": id, "due": null }))
            .contains("needs a due date")
    );
    w.ok("task.edit", json!({ "id": id, "due": null, "rule": null }));
}

#[test]
fn a_successor_is_one_step_on_in_the_form_its_due_has_and_a_series_that_ran_out_stops() {
    let w = World::new("task_next");
    let day = task(
        &w,
        json!({ "title": "d", "due": "2026-03-02", "rule": "FREQ=DAILY" }),
    );
    assert_eq!(
        w.ok("task.complete", json!({ "id": day }))["next_due"],
        "2026-03-03"
    );
    let floating = task(
        &w,
        json!({ "title": "f", "due": "2026-03-02T09:00", "rule": "FREQ=DAILY" }),
    );
    let next = w.ok("task.complete", json!({ "id": floating }));
    assert_eq!(
        next["next_due"], "2026-03-03T09:00",
        "a wall clock repeats on the wall clock"
    );
    let next_id = next["next_id"].as_str().unwrap();
    assert_eq!(due(&w, next_id).1.as_deref(), Some("floating"));
    // A zoned due keeps its wall clock across the change of the clocks.
    let zoned = task(
        &w,
        json!({ "title": "z", "due": "2026-03-28T09:00", "zone": "Europe/Paris", "rule": "FREQ=DAILY" }),
    );
    let next = w.ok("task.complete", json!({ "id": zoned }));
    assert_eq!(
        next["next_due"], "2026-03-29T07:00:00.000Z",
        "09:00 in Paris after the spring change"
    );
    let next_id = next["next_id"].as_str().unwrap();
    assert_eq!(
        due(&w, next_id),
        (
            Some("2026-03-29T07:00:00.000Z".into()),
            Some("zoned".into()),
            Some("Europe/Paris".into())
        )
    );
    // One that ran out ends here.
    let once = task(
        &w,
        json!({ "title": "o", "due": "2026-03-02", "rule": "FREQ=DAILY;COUNT=1" }),
    );
    assert!(w.ok("task.complete", json!({ "id": once }))["next_id"].is_null());
    // Measured from the completion: the next one is a step after the clock, not the schedule.
    let from_done = task(
        &w,
        json!({ "title": "c", "due": "2030-03-02T09:00:00Z", "rule": "FREQ=DAILY;INTERVAL=30",
                "anchor": "completion" }),
    );
    let next = w.ok("task.complete", json!({ "id": from_done }));
    let next_due = next["next_due"].as_str().expect("a next due");
    assert!(next_due.starts_with("2026-01-"), "{next_due}");
}

#[test]
fn a_snooze_moves_the_alert_and_not_the_due_and_an_edit_of_the_due_ends_it() {
    let w = World::new("task_snooze");
    let id = task(
        &w,
        json!({ "title": "Call", "due": "2026-03-02T10:00:00Z", "reminders": [0, 60] }),
    );
    let snooze_count = || w.one::<i64>("SELECT count(*) FROM snooze WHERE entity_id = ?1", &[&id]);
    w.ok(
        "alert.snooze",
        json!({ "entity_id": id, "until": "2099-03-02T11:30:00Z" }),
    );
    assert_eq!(
        fires(&w, &id),
        [(0, "fixed".to_owned(), "2099-03-02T11:30:00.000Z".to_owned())],
        "the task's one alert, on its smallest lead"
    );
    assert_eq!(
        due(&w, &id).0.as_deref(),
        Some("2026-03-02T10:00:00.000Z"),
        "the due is unmoved"
    );
    // An edit that says nothing of the due keeps it, and so does one that states the same due.
    w.ok("task.edit", json!({ "id": id, "priority": 2 }));
    w.ok(
        "task.edit",
        json!({ "id": id, "due": "2026-03-02T10:00:00Z" }),
    );
    assert_eq!(snooze_count(), 1);
    // An edit of the due ends it.
    w.ok(
        "task.edit",
        json!({ "id": id, "due": "2026-03-02T12:00:00Z" }),
    );
    assert_eq!(snooze_count(), 0);
    assert_eq!(fires(&w, &id).len(), 2);
    // Finishing a task ends it too, and a finished task cannot be snoozed.
    w.ok(
        "alert.snooze",
        json!({ "entity_id": id, "until": "2099-03-02T13:00:00Z" }),
    );
    w.ok("task.cancel", json!({ "id": id }));
    assert_eq!(snooze_count(), 0);
    assert!(
        w.refused(
            "alert.snooze",
            json!({ "entity_id": id, "until": "2099-03-02T13:00:00Z" })
        )
        .contains("open task")
    );
}

// ---------------------------------------------------------------------------------------------
// 5. Reminders are rows
// ---------------------------------------------------------------------------------------------

#[test]
fn a_timed_due_alerts_at_its_time_by_default_and_a_day_or_no_due_alerts_nothing() {
    let w = World::new("task_defaults");
    let instant = task(&w, json!({ "title": "i", "due": "2026-03-02T10:00:00Z" }));
    let floating = task(&w, json!({ "title": "f", "due": "2026-03-02T10:00" }));
    let day = task(&w, json!({ "title": "d", "due": "2026-03-02" }));
    let none = task(&w, json!({ "title": "n" }));
    assert_eq!(leads(&w, &instant), [0]);
    assert_eq!(leads(&w, &floating), [0]);
    assert_eq!(leads(&w, &day), Vec::<i64>::new(), "a day has no moment");
    assert_eq!(leads(&w, &none), Vec::<i64>::new());
    assert_eq!(
        fires(&w, &instant),
        [(0, "fixed".to_owned(), "2026-03-02T10:00:00.000Z".to_owned())]
    );
    assert_eq!(
        fires(&w, &floating),
        [(0, "floating".to_owned(), "2026-03-02T10:00".to_owned())]
    );
    assert!(fires(&w, &day).is_empty());
    // Stating the leads is exact: no default is added to them, and none is every alert gone.
    let early = task(
        &w,
        json!({ "title": "e", "due": "2026-03-02T10:00", "reminders": [10] }),
    );
    assert_eq!(leads(&w, &early), [10]);
    assert_eq!(
        fires(&w, &early),
        [(10, "floating".to_owned(), "2026-03-02T09:50".to_owned())]
    );
    let silent = task(
        &w,
        json!({ "title": "s", "due": "2026-03-02T10:00", "reminders": [] }),
    );
    assert!(leads(&w, &silent).is_empty() && fires(&w, &silent).is_empty());
    // A day with a lead counts it back from nine in the morning.
    let day_lead = task(
        &w,
        json!({ "title": "dl", "due": "2026-03-02", "reminders": [60, 60, 0] }),
    );
    assert_eq!(leads(&w, &day_lead), [0, 60], "each lead once");
    assert_eq!(
        fires(&w, &day_lead),
        [
            (0, "floating".to_owned(), "2026-03-02T09:00".to_owned()),
            (60, "floating".to_owned(), "2026-03-02T08:00".to_owned())
        ]
    );
    // The member removes the default and the task stays quiet; nothing puts it back by itself.
    let reminder: String = w.one("SELECT id FROM reminder WHERE entity_id = ?1", &[&instant]);
    w.ok("reminder.remove", json!({ "id": reminder }));
    assert!(fires(&w, &instant).is_empty());
    w.ok("task.edit", json!({ "id": instant, "priority": 1 }));
    assert!(leads(&w, &instant).is_empty());
}

#[test]
fn an_edit_states_the_leads_or_leaves_them_and_a_due_moves_their_alerts() {
    let w = World::new("task_leads");
    let id = task(
        &w,
        json!({ "title": "x", "due": "2026-03-02T10:00:00Z", "reminders": [10, 60] }),
    );
    // Omitted: they stay.
    w.ok("task.edit", json!({ "id": id, "title": "y" }));
    assert_eq!(leads(&w, &id), [10, 60]);
    // Stated: exactly these.
    w.ok("task.edit", json!({ "id": id, "reminders": [5, 60] }));
    assert_eq!(leads(&w, &id), [5, 60]);
    w.ok("task.edit", json!({ "id": id, "reminders": [] }));
    assert!(leads(&w, &id).is_empty() && fires(&w, &id).is_empty());
    w.ok("task.edit", json!({ "id": id, "reminders": [15] }));
    // A moved due moves the alerts.
    w.ok(
        "task.edit",
        json!({ "id": id, "due": "2026-03-04T10:00:00Z" }),
    );
    assert_eq!(
        fires(&w, &id),
        [(
            15,
            "fixed".to_owned(),
            "2026-03-04T09:45:00.000Z".to_owned()
        )]
    );
    // A reminder needs a due, in a sentence first and in the database too.
    let bare = task(&w, json!({ "title": "bare" }));
    assert!(
        w.refused("task.edit", json!({ "id": bare, "reminders": [5] }))
            .contains("needs a due date")
    );
    assert!(
        w.refused(
            "reminder.add",
            json!({ "entity_id": bare, "offset_min": 5 })
        )
        .contains("no due date")
    );
    // Clearing the due takes the reminders with it.
    w.ok("task.edit", json!({ "id": id, "due": null }));
    assert!(leads(&w, &id).is_empty() && fires(&w, &id).is_empty());
    // A task given its first timed due, holding no reminder, alerts at it; a day does not.
    w.ok("task.edit", json!({ "id": id, "due": "2026-03-04T10:00" }));
    assert_eq!(leads(&w, &id), [0]);
    let day = task(&w, json!({ "title": "d", "due": "2026-03-04" }));
    assert!(leads(&w, &day).is_empty());
    w.ok("task.edit", json!({ "id": day, "due": "2026-03-04T08:00" }));
    assert_eq!(leads(&w, &day), [0], "a day made a moment now has one");
    // A member who stated none is not given one by a later edit of the time.
    let quiet = task(
        &w,
        json!({ "title": "q", "due": "2026-03-02T10:00", "reminders": [] }),
    );
    w.ok(
        "task.edit",
        json!({ "id": quiet, "due": "2026-03-03T10:00" }),
    );
    assert!(leads(&w, &quiet).is_empty());
}

#[test]
fn a_task_alerts_only_while_it_is_open_and_live() {
    let w = World::new("task_alert_life");
    let id = task(&w, json!({ "title": "x", "due": "2026-03-02T10:00" }));
    assert_eq!(fires(&w, &id).len(), 1);
    w.ok("task.complete", json!({ "id": id }));
    assert!(fires(&w, &id).is_empty());
    w.ok("task.reopen", json!({ "id": id }));
    assert_eq!(fires(&w, &id).len(), 1);
    w.ok("entity.trash", json!({ "id": id }));
    assert!(fires(&w, &id).is_empty());
    w.ok("entity.restore", json!({ "id": id }));
    assert_eq!(fires(&w, &id).len(), 1);
    w.ok("entity.trash", json!({ "id": id }));
    w.ok("entity.purge", json!({ "id": id }));
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM reminder", &[]), 0);
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM alert", &[]), 0);
    // The alerts equal a rebuild from the rows.
    let keep = task(
        &w,
        json!({ "title": "k", "due": "2026-03-02", "reminders": [30] }),
    );
    let before = fires(&w, &keep);
    w.vault().rebuild_index().expect("rebuilds");
    assert_eq!(fires(&w, &keep), before);
}

// ---------------------------------------------------------------------------------------------
// 6. The reads: Today, Upcoming, Overdue, Done and the true counts
// ---------------------------------------------------------------------------------------------

/// Today is 2 March 2026 in Paris (UTC+1): it begins at 23:00 UTC the day before.
fn day() -> Day<'static> {
    Day {
        today: "2026-03-02",
        tomorrow: "2026-03-03",
        starts: "2026-03-01T23:00:00.000Z",
        ends: "2026-03-02T23:00:00.000Z",
    }
}

fn titles(rows: &[task_counts::TaskRow]) -> Vec<String> {
    rows.iter().map(|row| row.title.clone()).collect()
}

fn world_of_days() -> (World, String) {
    let w = World::new("task_reads");
    let paris = |title: &str, due: &str| json!({ "title": title, "due": due, "zone": "Europe/Paris", "reminders": [] });
    // Zoned: today, tomorrow's first half hour and the late evening before.
    task(&w, paris("zoned today", "2026-03-02T09:00"));
    task(&w, paris("zoned tomorrow", "2026-03-03T00:30"));
    task(&w, paris("zoned yesterday", "2026-03-01T23:30"));
    // Floating and all-day.
    task(
        &w,
        json!({ "title": "floating today", "due": "2026-03-02T20:00", "reminders": [] }),
    );
    task(
        &w,
        json!({ "title": "floating yesterday", "due": "2026-03-01T20:00", "reminders": [] }),
    );
    task(&w, json!({ "title": "day today", "due": "2026-03-02" }));
    task(&w, json!({ "title": "day yesterday", "due": "2026-03-01" }));
    task(&w, json!({ "title": "day later", "due": "2026-03-05" }));
    // Planned only, and planned and due.
    task(
        &w,
        json!({ "title": "planned", "scheduled_on": "2026-03-02" }),
    );
    task(
        &w,
        json!({ "title": "planned and due", "due": "2026-03-02", "scheduled_on": "2026-03-02" }),
    );
    // A repeating one, a trashed one, a done one.
    task(
        &w,
        json!({ "title": "repeats", "due": "2026-03-02", "rule": "FREQ=WEEKLY" }),
    );
    let gone = task(&w, json!({ "title": "trashed", "due": "2026-03-02" }));
    w.ok("entity.trash", json!({ "id": gone }));
    let done = task(&w, json!({ "title": "done", "due": "2026-03-02" }));
    w.ok("task.complete", json!({ "id": done }));
    // A subtask of an open parent belongs to the parent; one of a closed parent is a root.
    let parent = task(&w, json!({ "title": "parent" }));
    task(
        &w,
        json!({ "title": "child of open", "due": "2026-03-02", "parent_id": parent }),
    );
    let closed = task(&w, json!({ "title": "closed parent" }));
    task(
        &w,
        json!({ "title": "child of closed", "due": "2026-03-02", "parent_id": closed }),
    );
    w.ok("task.complete", json!({ "id": closed }));
    (w, done)
}

#[test]
fn today_upcoming_overdue_and_done_read_each_form_of_a_due_as_what_it_is() {
    let (w, _) = world_of_days();
    let read = |f: fn(
        &rusqlite::Connection,
        &Day<'_>,
        usize,
    ) -> centraid_vault::Result<Vec<task_counts::TaskRow>>| {
        let rows = w.vault().read(|c| f(c, &day(), 50)).expect("a read");
        titles(&rows).into_iter().collect::<BTreeSet<_>>()
    };
    let set = |names: &[&str]| {
        names
            .iter()
            .map(|n| (*n).to_owned())
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(
        read(task_counts::today),
        set(&[
            "zoned today",
            "floating today",
            "day today",
            "planned",
            "planned and due",
            "repeats",
            "child of closed"
        ])
    );
    assert_eq!(
        read(task_counts::overdue),
        set(&["zoned yesterday", "floating yesterday", "day yesterday"])
    );
    assert_eq!(
        read(task_counts::upcoming),
        set(&["zoned tomorrow", "day later"])
    );
    // Today lists what is due in order, then what is only planned, each once.
    let rows = w
        .vault()
        .read(|c| task_counts::today(c, &day(), 50))
        .unwrap();
    assert_eq!(
        titles(&rows)
            .iter()
            .filter(|t| *t == "planned and due")
            .count(),
        1
    );
    assert_eq!(titles(&rows).last().map(String::as_str), Some("planned"));
    assert!(rows.iter().any(|r| r.title == "repeats" && r.repeats));
    // A limit cuts the list, not the walk's order.
    let two = w
        .vault()
        .read(|c| task_counts::upcoming(c, &day(), 1))
        .unwrap();
    assert_eq!(titles(&two), ["zoned tomorrow"]);
    // Done: latest first, paged by the instant the page before ended at.
    let done = w.vault().read(|c| task_counts::done(c, None, 10)).unwrap();
    assert_eq!(titles(&done).len(), 2);
    let page = w
        .vault()
        .read(|c| task_counts::done(c, done.first().and_then(|r| r.done_at.as_deref()), 10))
        .unwrap();
    assert!(
        page.len() < done.len(),
        "the page before the latest leaves it out"
    );
}

#[test]
fn the_counts_are_true_at_any_size_and_count_what_the_board_draws() {
    let (w, _) = world_of_days();
    let counts = w.vault().open_task_counts(&day()).expect("counts");
    // Today: zoned today, floating today, day today, planned and due, child of closed (a root).
    // The repeating one is the caller's to place, the trashed and done are not tasks to do.
    assert_eq!(
        counts,
        OpenTaskCounts {
            overdue: 3,
            today: 5,
            planned: 2,
            starred: 0,
        }
    );
    // A star is a column, and a count of it is one seek of the partial index.
    let starred = w
        .vault()
        .read(|c| {
            Ok(c.query_row(
                "SELECT t.id FROM task t JOIN entity e ON e.id = t.id WHERE e.title = 'day today'",
                [],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    w.ok("flag.set", json!({ "id": starred, "flag": "starred" }));
    assert_eq!(w.vault().open_task_counts(&day()).unwrap().starred, 1);
    w.ok("task.complete", json!({ "id": starred }));
    assert_eq!(w.vault().open_task_counts(&day()).unwrap().starred, 0);
}

#[test]
fn each_read_and_count_is_a_bounded_walk_of_the_index_it_names() {
    let w = World::new("task_plans");
    let d = day();
    let cases: [(&str, &[&str], &str); 13] = [
        (task_counts::OVERDUE_ZONED, &[d.starts, "50"], "task_by_due"),
        (task_counts::OVERDUE_DAYS, &[d.today, "50"], "task_by_due"),
        (
            task_counts::TODAY_ZONED,
            &[d.starts, d.ends, "50"],
            "task_by_due",
        ),
        (
            task_counts::TODAY_DAYS,
            &[d.today, d.tomorrow, "50"],
            "task_by_due",
        ),
        (task_counts::PLANNED, &[d.today, "50"], "task_by_scheduled"),
        (task_counts::UPCOMING_ZONED, &[d.ends, "50"], "task_by_due"),
        (
            task_counts::UPCOMING_DAYS,
            &[d.tomorrow, "50"],
            "task_by_due",
        ),
        (task_counts::DONE, &["9999", "50"], "task_by_done"),
        (task_counts::COUNT_OVERDUE_ZONED, &[d.starts], "task_by_due"),
        (task_counts::COUNT_OVERDUE_DAYS, &[d.today], "task_by_due"),
        (
            task_counts::COUNT_TODAY_ZONED,
            &[d.starts, d.ends],
            "task_by_due",
        ),
        (
            task_counts::COUNT_TODAY_DAYS,
            &[d.today, d.tomorrow],
            "task_by_due",
        ),
        (task_counts::COUNT_PLANNED, &[d.today], "task_by_scheduled"),
    ];
    for (sql, binds, index) in cases {
        let plan = plan(&w, sql, binds);
        assert!(plan.contains(index), "{sql}\n{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "it sorts: {sql}\n{plan}");
        assert!(
            !plan.contains("SCAN t") && !plan.contains("SCAN e") && !plan.contains("SCAN task"),
            "it scans: {sql}\n{plan}"
        );
    }
    let starred = plan(&w, task_counts::COUNT_STARRED, &[]);
    assert!(starred.contains("entity_starred"), "{starred}");
    assert!(
        !starred.contains("TEMP B-TREE") && !starred.contains("SCAN e"),
        "{starred}"
    );
}

// ---------------------------------------------------------------------------------------------
// 7. Search and earlier versions
// ---------------------------------------------------------------------------------------------

#[test]
fn a_tasks_words_are_searchable_now_and_in_earlier_versions_and_an_edit_makes_a_version() {
    let w = World::new("task_versions");
    let id = task(
        &w,
        json!({ "title": "Quokka chore", "description": "marmoset words",
                "due": "2026-03-02T10:00", "reminders": [5] }),
    );
    let now = |word: &str| {
        w.one::<i64>(
            "SELECT count(DISTINCT e.id) FROM search s JOIN entity e ON e.n = s.rowid
              WHERE search MATCH ?1 AND e.id = ?2",
            &[&format!("\"{word}\""), &id],
        )
    };
    let before = |word: &str| {
        w.one::<i64>(
            "SELECT count(DISTINCT e.id) FROM search_past t JOIN entity e ON e.n = (t.rowid >> 24)
              WHERE search_past MATCH ?1",
            &[&format!("\"{word}\"")],
        )
    };
    assert_eq!((now("quokka"), now("marmoset")), (1, 1));
    assert_eq!(versions(&w, &id), 0, "nothing was changed yet");
    w.ok(
        "task.edit",
        json!({ "id": id, "description": "wombat words", "title": "Numbat chore",
                "due": "2026-03-03T11:00", "reminders": [15] }),
    );
    assert_eq!(versions(&w, &id), 1, "an edit keeps the task as it was");
    assert_eq!((now("wombat"), now("numbat")), (1, 1));
    assert_eq!((now("marmoset"), now("quokka")), (0, 0));
    assert_eq!((before("marmoset"), before("quokka")), (1, 1));
    // A save that changes nothing makes no version.
    w.ok(
        "task.edit",
        json!({ "id": id, "description": "wombat words" }),
    );
    assert_eq!(versions(&w, &id), 1);
    // Restoring the earlier version puts back its words, its due, its timing and its reminders.
    let seq: i64 = w.one(
        "SELECT seq FROM revision WHERE entity_id = ?1 ORDER BY seq LIMIT 1",
        &[&id],
    );
    w.ok("history.restore_version", json!({ "id": id, "seq": seq }));
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Quokka chore"
    );
    assert_eq!(
        w.one::<String>("SELECT description FROM task WHERE id = ?1", &[&id]),
        "marmoset words"
    );
    assert_eq!(due(&w, &id).0.as_deref(), Some("2026-03-02T10:00"));
    assert_eq!(leads(&w, &id), [5]);
    assert_eq!(
        fires(&w, &id),
        [(5, "floating".to_owned(), "2026-03-02T09:55".to_owned())]
    );
    assert_eq!(now("marmoset"), 1);
    // A repeating task's series identity is part of what a version keeps.
    let rep = task(&w, json!({ "title": "r", "due": "2026-03-02" }));
    w.ok("task.edit", json!({ "id": rep, "rule": "FREQ=DAILY" }));
    let series: String = w.one("SELECT series_id FROM task WHERE id = ?1", &[&rep]);
    w.ok("task.edit", json!({ "id": rep, "priority": 4 }));
    let seq: i64 = w.one(
        "SELECT seq FROM revision WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
        &[&rep],
    );
    w.ok("history.restore_version", json!({ "id": rep, "seq": seq }));
    assert_eq!(
        w.one::<String>("SELECT series_id FROM task WHERE id = ?1", &[&rep]),
        series
    );
    assert_eq!(
        w.one::<i64>("SELECT priority FROM task WHERE id = ?1", &[&rep]),
        0
    );
}

#[test]
fn a_stale_save_of_a_task_is_refused_and_a_fresh_one_answers_the_next_revision() {
    let w = World::new("task_stale");
    let id = task(&w, json!({ "title": "x" }));
    let first = w.ok(
        "task.edit",
        json!({ "id": id, "title": "y", "expected_rev": 0 }),
    );
    let rev = first["rev"].as_i64().expect("a revision");
    w.ok(
        "task.edit",
        json!({ "id": id, "title": "z", "expected_rev": rev }),
    );
    let sentence = w.refused(
        "task.edit",
        json!({ "id": id, "title": "w", "expected_rev": rev }),
    );
    assert!(sentence.contains("changed somewhere else"), "{sentence}");
}

// ---------------------------------------------------------------------------------------------
// 8. The words the code reads are the checks the file holds
// ---------------------------------------------------------------------------------------------

#[test]
fn the_words_the_code_reads_are_the_checks_the_file_holds() {
    use centraid_vault::commands::task;
    let w = World::new("task_words");
    let ddl: String = w.one("SELECT sql FROM sqlite_master WHERE name = 'task'", &[]);
    let words = |column: &str| -> BTreeSet<String> {
        let at = ddl.find(&format!("{column} ")).expect("a column");
        let rest = &ddl[at..];
        let open = rest.find("IN (").expect("a list") + 4;
        let close = rest[open..].find(')').expect("a close") + open;
        rest[open..close]
            .split(',')
            .map(|word| word.trim().trim_matches('\'').to_owned())
            .collect()
    };
    let set = |words: &[&str]| {
        words
            .iter()
            .map(|w| (*w).to_owned())
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(words("status"), set(&task::STATUSES));
    assert_eq!(
        words("anchor"),
        task::ANCHORS
            .iter()
            .map(|anchor| anchor.as_str().to_owned())
            .collect()
    );
    assert_eq!(words("due_timing"), set(&task::TIMINGS));
}
