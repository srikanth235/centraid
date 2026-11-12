use super::*;

const NOW: &str = "2026-11-10T08:00";
const NY: &str = "America/New_York";
const HOUR: i64 = 3_600_000;

fn task(id: &str, due_day: &str, due_time: &str, remind: &str) -> wire::AgendaTask {
    wire::AgendaTask {
        task_id: id.to_owned(),
        status: "open".to_owned(),
        title: format!("Task {id}"),
        due_day: due_day.to_owned(),
        due_time: due_time.to_owned(),
        remind_at_local: remind.to_owned(),
        ..Default::default()
    }
}

fn event(key: &str, start: &str, minutes: &[i64]) -> wire::AgendaEvent {
    wire::AgendaEvent {
        event_id: "ev".to_owned(),
        instance_key: key.to_owned(),
        summary: Some("Lunch".to_owned()),
        local_start: start.to_owned(),
        reminders: minutes
            .iter()
            .map(|m| wire::AgendaReminder { minutes_before: *m })
            .collect(),
        ..Default::default()
    }
}

fn run(
    zone: &str,
    tasks: &[wire::AgendaTask],
    events: &[wire::AgendaEvent],
) -> Vec<wire::PendingNotification> {
    desired(&Inputs {
        vault_id: "v1",
        zone,
        locale: Locale::En,
        now_local: NOW,
        tasks,
        projects: &[wire::AgendaTaskProject {
            project_id: "p1".to_owned(),
            name: "Home".to_owned(),
            ..Default::default()
        }],
        events,
        calendars: &[wire::AgendaCalendar {
            calendar_id: "c1".to_owned(),
            name: Some("Work".to_owned()),
            color: None,
            icon: None,
        }],
    })
}

#[test]
fn a_task_reminder_says_when_it_is_for_and_where_it_lives() {
    let mut t = task("a", "2026-11-11", "09:00", "2026-11-10T09:00");
    let set = run(NY, &[t.clone()], &[]);
    assert_eq!(set.len(), 1);
    let n = &set[0];
    assert_eq!(n.notification_id, "task|v1|a|2026-11-10T09:00");
    assert_eq!(n.title, "Task a");
    // The body is read when it fires (Nov 10), so the 11th is "Tomorrow".
    assert_eq!(n.body, "Tomorrow at 09:00 · Inbox");
    assert_eq!(
        (n.category_id.as_str(), n.thread_id.as_str()),
        ("task", "reminders")
    );
    assert!(!n.immediate);
    assert_eq!(
        (n.fire_local.as_str(), n.zone.as_str()),
        ("2026-11-10T09:00", NY)
    );

    t.project_id = Some("p1".to_owned());
    t.remind_at_local = "2026-11-11T09:00".to_owned();
    assert_eq!(run(NY, &[t], &[])[0].body, "Today at 09:00 · Home");
}

#[test]
fn a_repeating_task_contributes_its_one_next_reminder() {
    let mut t = task("r", "2026-11-12", "07:30", "2026-11-12T07:30");
    t.repeats = true;
    let set = run(NY, &[t], &[]);
    assert_eq!(set.len(), 1);
    assert_eq!(set[0].category_id, "task.repeating");
}

#[test]
fn a_repeating_event_alerts_each_occurrence_in_the_window() {
    let events = [
        event("ev@1", "2026-11-11T12:00", &[10, 60]),
        event("ev@2", "2026-11-12T12:00", &[10, 60]),
        event("ev@far", "2026-12-12T12:00", &[10]),
    ];
    let set = run(NY, &[], &events);
    assert_eq!(set.len(), 4);
    assert_eq!(set[0].notification_id, "event|v1|ev@1|60");
    assert_eq!(set[0].fire_local, "2026-11-11T11:00");
    assert_eq!(set[0].body, "Today at 12:00");
    assert!(set.iter().all(|n| n.category_id.is_empty()));
}

#[test]
fn an_event_says_where_it_is_else_its_calendar() {
    let mut e = event("k", "2026-11-12T12:00", &[0]);
    e.calendar_id = Some("c1".to_owned());
    assert_eq!(run(NY, &[], &[e.clone()])[0].body, "Today at 12:00 · Work");
    e.location_name = Some("Cafe".to_owned());
    assert_eq!(run(NY, &[], &[e])[0].body, "Today at 12:00 · Cafe");
}

#[test]
fn a_blank_title_is_untitled_in_its_own_word() {
    let mut t = task("a", "2026-11-11", "09:00", "2026-11-11T09:00");
    t.title = "  ".to_owned();
    let mut e = event("k", "2026-11-12T12:00", &[0]);
    e.summary = None;
    let set = run(NY, &[t], &[e]);
    let title = |prefix: &str| {
        set.iter()
            .find(|n| n.notification_id.starts_with(prefix))
            .map(|n| n.title.clone())
    };
    assert_eq!(title("task|").as_deref(), Some("Untitled task"));
    assert_eq!(title("event|").as_deref(), Some("Untitled event"));
}

#[test]
fn what_is_done_cancelled_dateless_or_past_is_left_out() {
    let mut done = task("d", "2026-11-11", "09:00", "2026-11-11T09:00");
    done.status = "done".to_owned();
    let mut cancelled = task("c", "2026-11-11", "09:00", "2026-11-11T09:00");
    cancelled.status = "cancelled".to_owned();
    // A date-only due has no moment, and so no reminder.
    let date_only = task("o", "2026-11-11", "", "");
    let past = task("p", "2026-11-10", "07:00", "2026-11-10T07:00");
    let mut off = event("e1", "2026-11-11T12:00", &[10]);
    off.status = Some("cancelled".to_owned());
    let mut all_day = event("e2", "2026-11-11T00:00", &[10]);
    all_day.all_day = true;
    let gone = event("e3", "2026-11-10T08:05", &[10]);
    let none = event("e4", "2026-11-11T12:00", &[]);
    assert_eq!(
        run(
            NY,
            &[done, cancelled, date_only, past],
            &[off, all_day, gone, none]
        ),
        Vec::new()
    );
}

#[test]
fn a_reminder_at_this_minute_is_kept() {
    let t = task("n", "2026-11-10", "08:00", "2026-11-10T08:00");
    assert_eq!(run(NY, &[t], &[]).len(), 1);
}

#[test]
fn the_window_is_two_weeks() {
    let inside = task("in", "2026-11-24", "08:00", "2026-11-24T08:00");
    let outside = task("out", "2026-11-25", "09:00", "2026-11-25T09:00");
    let set = run(NY, &[inside, outside], &[]);
    assert_eq!(set.len(), 1);
    assert!(set[0].notification_id.contains("|in|"));
}

#[test]
fn the_cap_keeps_the_soonest_forty_eight() {
    let tasks: Vec<_> = (0..60)
        .map(|i| {
            let minute = format!("2026-11-11T09:{:02}", 59 - i % 60);
            task(&format!("t{i:02}"), "2026-11-11", "09:00", &minute)
        })
        .collect();
    let set = run(NY, &tasks, &[]);
    assert_eq!(set.len(), CAP);
    assert_eq!(set[0].fire_local, "2026-11-11T09:00");
    assert_eq!(set[CAP - 1].fire_local, "2026-11-11T09:47");
    assert!(set.windows(2).all(|w| w[0].fire_at_ms <= w[1].fire_at_ms));
}

#[test]
fn a_task_nested_under_another_is_found_once() {
    let mut child = task("kid", "2026-11-11", "09:00", "2026-11-11T09:00");
    child.parent_task_id = Some("parent".to_owned());
    let mut parent = task("parent", "2026-11-11", "10:00", "2026-11-11T10:00");
    parent.children = vec![child.clone()];
    let groups = [
        wire::AgendaTaskGroup {
            tasks: vec![parent],
            ..Default::default()
        },
        wire::AgendaTaskGroup {
            tasks: vec![child],
            ..Default::default()
        },
    ];
    let flat = flatten(&groups);
    assert_eq!(flat.len(), 2);
    assert!(flat.iter().all(|t| t.children.is_empty()));
    assert_eq!(run(NY, &flat, &[]).len(), 2);
}

#[test]
fn the_same_wall_clock_is_another_instant_in_another_zone() {
    let t = task("z", "2026-11-11", "09:00", "2026-11-11T09:00");
    let ny = run(NY, std::slice::from_ref(&t), &[]);
    let tokyo = run("Asia/Tokyo", &[t], &[]);
    assert_eq!(ny[0].fire_local, tokyo[0].fire_local);
    assert_ne!(ny[0].fire_at_ms, tokyo[0].fire_at_ms);
    // EST is UTC-5 and JST is UTC+9.
    assert_eq!(ny[0].fire_at_ms - tokyo[0].fire_at_ms, 14 * HOUR);
    assert_eq!(tokyo[0].zone, "Asia/Tokyo");
}

#[test]
fn an_event_read_in_another_zone_fires_by_that_zones_clock() {
    let e = event("k", "2026-11-11T12:00", &[30]);
    let ny = run(NY, &[], std::slice::from_ref(&e));
    let tokyo = run("Asia/Tokyo", &[], &[e]);
    assert_eq!(ny[0].fire_local, "2026-11-11T11:30");
    assert_eq!(tokyo[0].fire_local, "2026-11-11T11:30");
    assert_eq!(ny[0].fire_at_ms - tokyo[0].fire_at_ms, 14 * HOUR);
}

#[test]
fn an_unknown_zone_holds_nothing() {
    let t = task("z", "2026-11-11", "09:00", "2026-11-11T09:00");
    assert!(run("Not/AZone", &[t], &[]).is_empty());
}

#[test]
fn the_buttons_are_the_task_ones_and_a_repeating_ones_are_fewer() {
    let cats = categories(Locale::En);
    let by = |id: &str| -> Vec<(i32, String)> {
        cats.iter()
            .find(|c| c.category_id == id)
            .unwrap()
            .actions
            .iter()
            .map(|a| (a.verb, a.label.clone()))
            .collect()
    };
    assert_eq!(
        by("task"),
        vec![
            (2, "Mark as done".to_owned()),
            (3, "Snooze 1 hour".to_owned()),
            (4, "Tomorrow".to_owned())
        ]
    );
    assert_eq!(by("task.repeating"), vec![(2, "Mark as done".to_owned())]);
    assert_eq!(by("receipt"), vec![(5, "Undo".to_owned())]);
}

#[test]
fn a_full_set_is_read_again_when_its_last_item_arrives() {
    let at = |ms: i64| wire::PendingNotification {
        fire_at_ms: ms,
        ..Default::default()
    };
    let few = vec![at(1)];
    assert_eq!(refresh_after(&few, 0), REFRESH);
    let full: Vec<_> = (0..CAP).map(|_| at(30 * 60_000)).collect();
    assert_eq!(refresh_after(&full, 0), Duration::from_secs(30 * 60));
    let soon: Vec<_> = (0..CAP).map(|_| at(1_000)).collect();
    assert_eq!(refresh_after(&soon, 0), REFRESH_LEAST);
}

/// DST ON A FIRE TIME (#1188, A8): a wall clock that does not exist (the spring gap) fires at the
/// next real one, and one that happens twice (the autumn overlap) fires once, at the earlier.
#[test]
fn a_fire_time_in_the_spring_gap_reads_forward_and_one_in_the_autumn_overlap_fires_once() {
    let at = |now_local: &str, remind: &str| {
        let t = task("a", &remind[..10], &remind[11..], remind);
        desired(&Inputs {
            vault_id: "v1",
            zone: NY,
            locale: Locale::En,
            now_local,
            tasks: &[t],
            projects: &[],
            events: &[],
            calendars: &[],
        })
    };
    // 2027-03-14 02:30 does not exist in New York; the clocks go from 02:00 to 03:00.
    let set = at("2027-03-13T08:00", "2027-03-14T02:30");
    assert_eq!(set.len(), 1);
    assert_eq!(set[0].fire_local, "2027-03-14T03:30");
    // 01:30 on 2026-11-01 happens twice: once, at the earlier, 01:30 EDT = 05:30Z.
    let set = at("2026-10-31T08:00", "2026-11-01T01:30");
    assert_eq!(set.len(), 1);
    assert_eq!(set[0].fire_at_ms, 1_793_511_000_000);
}
