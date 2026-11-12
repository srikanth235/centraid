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
        extra: &[],
        extra_wanted: &[],
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
        event("ev@far", "2027-12-12T12:00", &[10]),
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
    let gone = event("e3", "2026-11-10T08:05", &[10]);
    let none = event("e4", "2026-11-11T12:00", &[]);
    assert_eq!(
        run(NY, &[done, cancelled, date_only, past], &[off, gone, none]),
        Vec::new()
    );
}

#[test]
fn a_reminder_at_this_minute_is_kept() {
    let t = task("n", "2026-11-10", "08:00", "2026-11-10T08:00");
    assert_eq!(run(NY, &[t], &[]).len(), 1);
}

#[test]
fn the_horizon_is_ninety_days() {
    let inside = task("in", "2027-02-06", "08:00", "2027-02-06T08:00");
    let outside = task("out", "2027-02-10", "09:00", "2027-02-10T09:00");
    let set = run(NY, &[inside, outside], &[]);
    assert_eq!(set.len(), 1);
    assert!(set[0].notification_id.contains("|in|"));
}

/// A4: THE HORIZON IS FILLED BY TIME. The soonest reminders are held, and when more remain than
/// the phone can hold the last slot says reminders are paused, at the moment the last held one
/// would have sounded, with no buttons.
#[test]
fn the_cap_holds_the_soonest_and_ends_in_the_paused_notice() {
    let tasks: Vec<_> = (0..60)
        .map(|i| {
            let minute = format!("2026-11-11T09:{:02}", 59 - i % 60);
            task(&format!("t{i:02}"), "2026-11-11", "09:00", &minute)
        })
        .collect();
    let set = run(NY, &tasks, &[]);
    assert_eq!(set.len(), CAP);
    assert_eq!(set[0].fire_local, "2026-11-11T09:00");
    let paused = set.last().expect("paused");
    assert!(paused.notification_id.starts_with("paused|"), "{paused:?}");
    assert!(paused.category_id.is_empty(), "no buttons");
    assert_eq!(paused.title, "Reminders paused");
    let real: Vec<_> = set
        .iter()
        .filter(|n| !n.notification_id.starts_with("paused|"))
        .collect();
    assert_eq!(real.len(), CAP - 1, "the last slot is the notice");
    assert_eq!(
        paused.fire_at_ms,
        real.iter().map(|n| n.fire_at_ms).max().unwrap(),
        "it sounds when the last held reminder would have"
    );
    assert!(set.windows(2).all(|w| w[0].fire_at_ms <= w[1].fire_at_ms));
}

#[test]
fn a_set_that_fits_has_no_paused_notice() {
    let tasks: Vec<_> = (0..CAP)
        .map(|i| {
            task(
                &format!("t{i:02}"),
                "2026-11-11",
                "09:00",
                &format!("2026-11-11T09:{:02}", i % 60),
            )
        })
        .collect();
    let set = run(NY, &tasks, &[]);
    assert_eq!(set.len(), CAP);
    assert!(
        set.iter()
            .all(|n| !n.notification_id.starts_with("paused|"))
    );
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
            extra: &[],
            extra_wanted: &[],
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

fn stale_notice(n: u32, at: i64) -> ExtraNotice {
    use crate::kit::permission::Channel;
    ExtraNotice {
        id: format!("backup-stale:T:{n}"),
        channel: Channel::Backup,
        fire_at_ms: at,
        title: "Backup".to_owned(),
        body: "No backup in 3 days".to_owned(),
        opens: wire::Route::default(),
    }
}

/// ANOTHER PRODUCER'S NOTICES ARE HELD EVEN WHEN AGENDA FILLS THE CAP, on their own channel, and a
/// delivered one stays live while its producer wants it.
#[test]
fn a_second_producers_notices_keep_their_slots_when_agenda_fills_the_cap() {
    let tasks: Vec<_> = (0..70)
        .map(|n| {
            let minute = format!("2026-11-11T{:02}:{:02}", 9 + n / 60, n % 60);
            task(&n.to_string(), "2026-11-11", "09:00", &minute)
        })
        .collect();
    let ms_now = parse_civil_ms(NOW, &FireZone::named(NY).unwrap()).unwrap();
    let late = [
        stale_notice(1, ms_now + 10 * 24 * HOUR),
        stale_notice(2, ms_now + 17 * 24 * HOUR),
    ];
    let wanted = ["backup-stale:T:0".to_owned()];
    let inputs = Inputs {
        vault_id: "v1",
        zone: NY,
        locale: Locale::En,
        now_local: NOW,
        tasks: &tasks,
        projects: &[],
        events: &[],
        calendars: &[],
        extra: &late,
        extra_wanted: &wanted,
    };
    let set = desired(&inputs);
    assert!(set.len() <= CAP, "{}", set.len());
    let backup: Vec<_> = set.iter().filter(|n| n.channel_id == "backup").collect();
    assert_eq!(backup.len(), 2, "both warnings are held");
    assert!(
        backup.iter().all(|n| n.category_id.is_empty()),
        "no buttons"
    );
    assert!(live(&inputs).contains(&"backup-stale:T:0".to_owned()));
}

#[test]
fn a_notice_in_the_past_is_not_held() {
    let ms_now = parse_civil_ms(NOW, &FireZone::named(NY).unwrap()).unwrap();
    let past = [stale_notice(1, ms_now - HOUR)];
    let set = desired(&Inputs {
        vault_id: "v1",
        zone: NY,
        locale: Locale::En,
        now_local: NOW,
        tasks: &[],
        projects: &[],
        events: &[],
        calendars: &[],
        extra: &past,
        extra_wanted: &[],
    });
    assert!(set.is_empty());
}

/// NA6: A DAY HAS NO MOMENT. An all-day event sounds at 09:00 that day in the member's zone, once,
/// whatever its lead times; the body names the day and no clock.
#[test]
fn an_all_day_event_sounds_at_nine_on_its_day_once() {
    let mut holiday = event("h", "2026-11-12T00:00", &[10, 60]);
    holiday.all_day = true;
    holiday.local_end = "2026-11-13".to_owned();
    let set = run(NY, &[], &[holiday]);
    assert_eq!(set.len(), 1, "the first lead stands for the day");
    assert_eq!(set[0].fire_local, "2026-11-12T09:00");
    assert!(!set[0].body.contains(':'), "{}", set[0].body);
    let elsewhere = {
        let mut e = event("h", "2026-11-12T00:00", &[10]);
        e.all_day = true;
        run("Asia/Tokyo", &[], &[e])
    };
    assert_eq!(
        elsewhere[0].fire_local, "2026-11-12T09:00",
        "09:00 wherever the member is"
    );
}
