//! The snapshot builder over fixtures the vault cannot make: a pinned clock
//! (Saturday 7 November 2026, 10:30, zone Asia/Kolkata), so every row's place,
//! label and refresh is exact. Nothing here reads a clock or asserts on time.

use centraid_api_proto::core_v1 as wire;
use serde_json::Value;

use super::snapshot::{
    self, Inputs, MAX_BYTES, MAX_ID, MAX_ROWS, MAX_TITLE, clip, ready, refresh_after_of,
    seconds_between, unavailable,
};
use crate::kit::civil::HourCycle;
use crate::strings::Locale;

const TODAY: &str = "2026-11-07";
const TOMORROW: &str = "2026-11-08";
const NOW: &str = "2026-11-07T10:30";
const ZONE: &str = "Asia/Kolkata";

fn event(
    id: &str,
    title: &str,
    start: &str,
    end: &str,
    all_day: bool,
    days: &[&str],
) -> wire::AgendaEvent {
    wire::AgendaEvent {
        event_id: id.to_owned(),
        instance_key: id.to_owned(),
        summary: Some(title.to_owned()),
        local_start: start.to_owned(),
        local_end: end.to_owned(),
        all_day,
        local_days: days.iter().map(|d| (*d).to_owned()).collect(),
        // What the document must never carry.
        description: Some("SECRET NOTES".to_owned()),
        location_name: Some("SECRET PLACE".to_owned()),
        attendees: vec![wire::AgendaAttendee {
            name: "SECRET GUEST".to_owned(),
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn task(id: &str, title: &str, due_day: &str, due_time: &str) -> wire::AgendaTask {
    let due_local = if due_time.is_empty() {
        due_day.to_owned()
    } else {
        format!("{due_day}T{due_time}")
    };
    wire::AgendaTask {
        task_id: id.to_owned(),
        title: title.to_owned(),
        status: "open".to_owned(),
        due_day: due_day.to_owned(),
        due_time: due_time.to_owned(),
        due_local,
        overdue: !due_day.is_empty() && due_day < TODAY,
        lands_today: !due_day.is_empty() && due_day <= TODAY,
        days_from_today: crate::kit::civil::epoch_day_of(due_day)
            .zip(crate::kit::civil::epoch_day_of(TODAY))
            .and_then(|(due, today)| i32::try_from(due - today).ok()),
        description: Some("SECRET NOTES".to_owned()),
        ..Default::default()
    }
}

/// What the core's count read would say about `tasks` if they were every open
/// task there is (the fixtures below that are small enough to be).
fn counted(tasks: &[wire::AgendaTask]) -> wire::AgendaTaskSmartCounts {
    let open = || tasks.iter().filter(|task| task.status == "open");
    let count = |keep: &dyn Fn(&wire::AgendaTask) -> bool| {
        u32::try_from(open().filter(|task| keep(task)).count()).expect("a small count")
    };
    wire::AgendaTaskSmartCounts {
        today: count(&|task| task.lands_today && !task.overdue),
        overdue: count(&|task| task.overdue),
        flagged: count(&|task| task.flagged),
        today_day: TODAY.to_owned(),
    }
}

fn bytes(events: Vec<wire::AgendaEvent>, tasks: Vec<wire::AgendaTask>) -> Vec<u8> {
    let counts = counted(&tasks);
    bytes_counting(events, tasks, &counts)
}

/// The document when the counts are the vault's and the rows are only the few read.
fn bytes_counting(
    events: Vec<wire::AgendaEvent>,
    tasks: Vec<wire::AgendaTask>,
    counts: &wire::AgendaTaskSmartCounts,
) -> Vec<u8> {
    bytes_worded(events, tasks, counts, HourCycle::default())
}

/// The same, on a phone that words its times as `cycle`.
fn bytes_worded(
    events: Vec<wire::AgendaEvent>,
    tasks: Vec<wire::AgendaTask>,
    counts: &wire::AgendaTaskSmartCounts,
    cycle: HourCycle,
) -> Vec<u8> {
    let upcoming = wire::AgendaUpcoming {
        events,
        ..Default::default()
    };
    ready(&Inputs {
        locale: Locale::En,
        zone: ZONE,
        today: TODAY,
        now_local: NOW,
        upcoming: &upcoming,
        tasks: &tasks,
        cycle,
        counts,
    })
}

fn build(events: Vec<wire::AgendaEvent>, tasks: Vec<wire::AgendaTask>) -> Value {
    serde_json::from_slice(&bytes(events, tasks)).expect("the document is JSON")
}

fn titles(doc: &Value, list: &str) -> Vec<String> {
    let rows = if list == "up_next" {
        &doc["up_next"]
    } else {
        &doc["reminders"]["rows"]
    };
    rows.as_array()
        .expect("rows")
        .iter()
        .map(|row| row["title"].as_str().expect("title").to_owned())
        .collect()
}

#[test]
fn a_ready_document_has_the_schema_and_the_pinned_clock() {
    let doc = build(
        vec![event(
            "e1",
            "Dentist",
            "2026-11-07T15:00",
            "2026-11-07T16:00",
            false,
            &[TODAY],
        )],
        vec![
            task("t1", "Call mom", TODAY, "09:00"),
            task("t2", "Pay rent", "2026-11-05", ""),
        ],
    );
    assert_eq!(doc["version"], 1);
    assert_eq!(doc["state"], "ready");
    assert_eq!(doc["today"], TODAY);
    assert_eq!(doc["now_local"], NOW);
    assert_eq!(doc["zone"], ZONE);
    assert_eq!(doc["refresh_after"], "2026-11-07T15:00");
    let mut keys: Vec<&str> = doc
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "now_local",
            "open_add",
            "open_reminders",
            "open_up_next",
            "refresh_after",
            "reminders",
            "siri",
            "state",
            "today",
            "up_next",
            "version",
            "words",
            "zone"
        ]
    );
    assert_eq!(doc["words"]["up_next_title"], "Up next");
    assert_eq!(doc["words"]["add_label"], "New Reminder");
    assert_eq!(doc["words"]["overdue_label"], "1 overdue");
    assert_eq!(doc["words"]["today_label"], "1 today");
    assert_eq!(doc["words"]["flagged_label"], "0 flagged");
    let first = &doc["up_next"][0];
    assert_eq!(first["id"], "e1");
    assert_eq!(first["kind"], "event");
    assert_eq!(first["time_label"], "15:00");
    assert_eq!(first["day_label"], "");
    assert_eq!(first["starts_local"], "2026-11-07T15:00");
    assert_eq!(first["ends_local"], "2026-11-07T16:00");
    assert_eq!(first["all_day"], false);
    assert_eq!(first["tint"], "agenda");
    assert_eq!(first["open"], "e:e1:2026-11-07T15:00");
    assert_eq!(doc["siri"]["next_sentence"], "Next is Dentist at 15:00.");
    // The example a reader of this schema is written against.
    println!("{}", serde_json::to_string_pretty(&doc).expect("pretty"));
}

#[test]
fn the_document_carries_titles_and_times_only() {
    let text = String::from_utf8(bytes(
        vec![event(
            "e1",
            "Dentist",
            "2026-11-07T15:00",
            "2026-11-07T16:00",
            false,
            &[TODAY],
        )],
        vec![task("t1", "Call mom", TODAY, "11:00")],
    ))
    .expect("UTF-8");
    for secret in ["SECRET NOTES", "SECRET PLACE", "SECRET GUEST"] {
        assert!(!text.contains(secret), "{secret} leaked into the document");
    }
}

#[test]
fn up_next_orders_all_day_first_then_by_start_and_drops_what_has_ended() {
    let doc = build(
        vec![
            event(
                "late",
                "Dinner",
                "2026-11-07T19:00",
                "2026-11-07T21:00",
                false,
                &[TODAY],
            ),
            event(
                "done",
                "Standup",
                "2026-11-07T09:00",
                "2026-11-07T09:30",
                false,
                &[TODAY],
            ),
            event("day", "Diwali", "2026-11-07", "2026-11-07", true, &[TODAY]),
            event(
                "now",
                "Workshop",
                "2026-11-07T10:00",
                "2026-11-07T12:00",
                false,
                &[TODAY],
            ),
        ],
        vec![
            task("t", "Send invoice", TODAY, "11:30"),
            task("gone", "Early call", TODAY, "08:00"),
            task("untimed", "Water plants", TODAY, ""),
        ],
    );
    assert_eq!(
        titles(&doc, "up_next"),
        ["Diwali", "Workshop", "Send invoice", "Dinner"]
    );
    let all_day = &doc["up_next"][0];
    assert_eq!(all_day["all_day"], true);
    assert_eq!(all_day["time_label"], "All day");
    assert_eq!(all_day["starts_local"], "2026-11-07T00:00");
    assert_eq!(all_day["ends_local"], "");
    // The event in progress is still ahead of the clock.
    assert_eq!(doc["up_next"][1]["ends_local"], "2026-11-07T12:00");
    assert_eq!(doc["up_next"][2]["kind"], "task");
    assert_eq!(doc["up_next"][2]["time_label"], "11:30");
    assert_eq!(doc["siri"]["next_sentence"], "Next is Diwali, all day.");
}

#[test]
fn tomorrow_fills_the_rows_today_leaves() {
    let doc = build(
        vec![
            event(
                "a",
                "Gym",
                "2026-11-07T18:00",
                "2026-11-07T19:00",
                false,
                &[TODAY],
            ),
            event(
                "b",
                "Brunch",
                "2026-11-08T10:00",
                "2026-11-08T11:00",
                false,
                &[TOMORROW],
            ),
            event(
                "c",
                "Holiday",
                "2026-11-08",
                "2026-11-08",
                true,
                &[TOMORROW],
            ),
        ],
        vec![task("t", "Book flights", TOMORROW, "08:15")],
    );
    assert_eq!(
        titles(&doc, "up_next"),
        ["Gym", "Holiday", "Book flights", "Brunch"]
    );
    assert_eq!(doc["up_next"][0]["day_label"], "");
    for row in 1..4 {
        assert_eq!(doc["up_next"][row]["day_label"], "Tomorrow");
    }
    // Tomorrow never moves the refresh: midnight, or today's own boundary.
    assert_eq!(doc["refresh_after"], "2026-11-07T18:00");

    let today_alone = (0..MAX_ROWS)
        .map(|n| {
            event(
                &format!("x{n}"),
                &format!("Today {n}"),
                &format!("2026-11-07T{:02}:00", 12 + n),
                "",
                false,
                &[TODAY],
            )
        })
        .chain([event(
            "t",
            "Tomorrow",
            "2026-11-08T09:00",
            "",
            false,
            &[TOMORROW],
        )])
        .collect();
    let full = build(today_alone, vec![]);
    assert_eq!(titles(&full, "up_next").len(), MAX_ROWS);
    assert!(!titles(&full, "up_next").contains(&"Tomorrow".to_owned()));
}

#[test]
fn a_multi_day_event_is_shown_once_and_says_it_continues() {
    let doc = build(
        vec![event(
            "trip",
            "Trip",
            "2026-11-06T09:00",
            "2026-11-09T18:00",
            false,
            &["2026-11-06", TODAY, TOMORROW, "2026-11-09"],
        )],
        vec![],
    );
    assert_eq!(titles(&doc, "up_next"), ["Trip"]);
    assert_eq!(doc["up_next"][0]["time_label"], "Continues");
}

#[test]
fn reminders_put_overdue_first_and_count_what_is_true() {
    let mut flagged = task("f", "Renew passport", TODAY, "09:00");
    flagged.flagged = true;
    let mut done = task("d", "Done already", TODAY, "08:00");
    done.status = "done".to_owned();
    let doc = build(
        vec![],
        vec![
            task("b", "Evening walk", TODAY, "18:00"),
            flagged,
            task("o2", "Old two", "2026-11-06", ""),
            task("o1", "Old one", "2026-11-04", "07:00"),
            task("u", "Someday", "", ""),
            task("later", "Next week", "2026-11-14", ""),
            done,
        ],
    );
    assert_eq!(
        titles(&doc, "reminders"),
        ["Old one", "Old two", "Renew passport", "Evening walk"]
    );
    assert_eq!(doc["reminders"]["overdue_count"], 2);
    assert_eq!(doc["reminders"]["today_count"], 2);
    assert_eq!(doc["reminders"]["flagged_count"], 1);
    let rows = &doc["reminders"]["rows"];
    assert_eq!(rows[0]["overdue"], true);
    assert_eq!(rows[0]["due_label"], "3 days ago");
    assert_eq!(rows[1]["due_label"], "Yesterday");
    assert_eq!(rows[2]["due_label"], "09:00");
    assert_eq!(rows[2]["flagged"], true);
    assert_eq!(rows[2]["overdue"], false);
    assert_eq!(doc["words"]["overdue_label"], "2 overdue");
    assert_eq!(doc["words"]["today_label"], "2 today");
    assert_eq!(doc["words"]["flagged_label"], "1 flagged");
}

#[test]
fn an_overdue_task_is_tinted_red_and_the_rest_agenda() {
    let overdue = task("o", "Late", "2026-11-01", "09:00");
    let due = task("t", "On time", TODAY, "09:00");
    assert_eq!(snapshot::tint_of(&overdue), "red");
    assert_eq!(snapshot::tint_of(&due), "agenda");
}

#[test]
fn counted_words_take_their_singular_and_plural() {
    let one = build(vec![], vec![task("a", "A", "2026-11-06", "")]);
    assert_eq!(one["words"]["overdue_label"], "1 overdue");
    let many = build(
        vec![],
        vec![
            task("a", "A", "2026-11-06", ""),
            task("b", "B", "2026-11-05", ""),
            task("c", "C", TODAY, ""),
        ],
    );
    assert_eq!(many["words"]["overdue_label"], "2 overdue");
    assert_eq!(many["words"]["today_label"], "1 today");
    let none = build(vec![], vec![]);
    assert_eq!(none["words"]["today_label"], "0 today");
}

#[test]
fn an_empty_day_says_so_in_one_sentence() {
    let doc = build(vec![], vec![]);
    assert_eq!(doc["state"], "ready");
    assert_eq!(doc["up_next"].as_array().map(Vec::len), Some(0));
    assert_eq!(doc["siri"]["next_sentence"], "Nothing else on your day.");
    assert_eq!(doc["words"]["nothing_next"], "Nothing else today");
    assert_eq!(doc["words"]["no_reminders"], "Nothing due today");
}

#[test]
fn refresh_after_is_the_next_midnight_or_the_nearest_boundary() {
    let midnight = build(vec![], vec![]);
    assert_eq!(midnight["refresh_after"], "2026-11-08T00:00");
    // A year's end rolls the year.
    let upcoming = wire::AgendaUpcoming::default();
    let year_end = ready(&Inputs {
        locale: Locale::En,
        zone: ZONE,
        today: "2026-12-31",
        now_local: "2026-12-31T23:10",
        upcoming: &upcoming,
        tasks: &[],
        cycle: HourCycle::default(),
        counts: &wire::AgendaTaskSmartCounts::default(),
    });
    assert_eq!(
        refresh_after_of(&year_end).as_deref(),
        Some("2027-01-01T00:00")
    );
    // The end of the event in progress, before the next one starts.
    let ending = build(
        vec![
            event(
                "now",
                "Workshop",
                "2026-11-07T10:00",
                "2026-11-07T11:00",
                false,
                &[TODAY],
            ),
            event(
                "next",
                "Call",
                "2026-11-07T13:00",
                "2026-11-07T14:00",
                false,
                &[TODAY],
            ),
        ],
        vec![],
    );
    assert_eq!(ending["refresh_after"], "2026-11-07T11:00");
}

#[test]
fn seconds_between_counts_local_wall_clock_minutes() {
    assert_eq!(
        seconds_between(NOW, "2026-11-08T00:00"),
        Some(13 * 3600 + 30 * 60)
    );
    assert_eq!(seconds_between(NOW, NOW), Some(0));
    assert_eq!(seconds_between("2026-11-08T00:00", NOW), None);
    assert_eq!(seconds_between("soon", NOW), None);
}

#[test]
fn unavailable_is_its_own_state_with_no_rows() {
    let doc: Value = serde_json::from_slice(&unavailable(Locale::En, ZONE)).expect("JSON");
    assert_eq!(doc["version"], 1);
    assert_eq!(doc["state"], "unavailable");
    assert_eq!(doc["zone"], ZONE);
    assert_eq!(doc["refresh_after"], "");
    assert_eq!(doc["up_next"].as_array().map(Vec::len), Some(0));
    assert_eq!(doc["reminders"]["rows"].as_array().map(Vec::len), Some(0));
    assert_eq!(doc["words"]["unavailable"], "Open Centraid to see your day");
    assert_eq!(
        doc["siri"]["next_sentence"],
        "Open Centraid to see your day."
    );
    assert_eq!(refresh_after_of(&unavailable(Locale::En, ZONE)), None);
}

#[test]
fn the_same_answers_make_the_same_bytes() {
    let make = || {
        bytes(
            vec![event(
                "e",
                "Dentist",
                "2026-11-07T15:00",
                "2026-11-07T16:00",
                false,
                &[TODAY],
            )],
            vec![task("t", "Call mom", TODAY, "11:00")],
        )
    };
    assert_eq!(make(), make());
}

#[test]
fn a_title_is_clipped_on_a_character_boundary_with_an_ellipsis() {
    assert_eq!(clip("  Two\n  lines\t here "), "Two lines here");
    let exact = "é".repeat(MAX_TITLE);
    assert_eq!(clip(&exact), exact);
    let long = "日".repeat(MAX_TITLE + 20);
    let cut = clip(&long);
    assert_eq!(cut.chars().count(), MAX_TITLE);
    assert!(cut.ends_with('\u{2026}'));
    let emoji = "🙂".repeat(500);
    assert_eq!(clip(&emoji).chars().count(), MAX_TITLE);
    assert_eq!(clip("   "), "");
}

#[test]
fn a_thousand_long_rows_stay_in_bounds_with_true_counts() {
    let long = "x".repeat(500);
    let tasks: Vec<wire::AgendaTask> = (0..1000)
        .map(|n| {
            let mut task = if n % 2 == 0 {
                task(&format!("task-{n}"), &long, TODAY, "23:00")
            } else {
                task(&format!("task-{n}"), &long, "2026-11-01", "")
            };
            task.flagged = n % 10 == 0;
            task.sort_order = n;
            task
        })
        .collect();
    let events: Vec<wire::AgendaEvent> = (0..1000)
        .map(|n| {
            event(
                &format!("event-{n}-{}", "i".repeat(200)),
                &long,
                &format!("2026-11-07T{:02}:{:02}", 11 + (n % 12), n % 60),
                "",
                false,
                &[TODAY],
            )
        })
        .collect();
    let raw = bytes(events, tasks);
    assert!(raw.len() <= MAX_BYTES, "{} bytes", raw.len());
    let doc: Value = serde_json::from_slice(&raw).expect("JSON");
    assert_eq!(doc["version"], 1);
    for list in ["up_next", "reminders"] {
        let rows = if list == "up_next" {
            doc["up_next"].as_array()
        } else {
            doc["reminders"]["rows"].as_array()
        }
        .expect("rows");
        assert!(rows.len() <= MAX_ROWS, "{list} has {} rows", rows.len());
        for row in rows {
            assert!(row["title"].as_str().expect("title").chars().count() <= MAX_TITLE);
            assert!(row["id"].as_str().expect("id").chars().count() <= MAX_ID);
        }
    }
    // The counts are the true counts, not the rows drawn.
    assert_eq!(doc["reminders"]["today_count"], 500);
    assert_eq!(doc["reminders"]["overdue_count"], 500);
    assert_eq!(doc["reminders"]["flagged_count"], 100);
}

/// THE COUNTS ARE THE VAULT'S, NOT THE WINDOW'S (#1173): the rows come from a
/// window that holds a few tasks, and the count read says the vault holds far
/// more. The document says the vault's numbers and draws at most six rows.
#[test]
fn counts_are_independent_of_the_rows_the_window_held() {
    let tasks: Vec<wire::AgendaTask> = (0..20)
        .map(|n| {
            if n % 2 == 0 {
                task(&format!("today-{n}"), "Due", TODAY, "")
            } else {
                task(&format!("late-{n}"), "Late", "2026-11-01", "")
            }
        })
        .collect();
    let counts = wire::AgendaTaskSmartCounts {
        today: 1_200,
        overdue: 1_500,
        flagged: 90,
        today_day: TODAY.to_owned(),
    };
    let doc: Value = serde_json::from_slice(&bytes_counting(vec![], tasks, &counts)).expect("JSON");
    assert_eq!(doc["reminders"]["today_count"], 1_200);
    assert_eq!(doc["reminders"]["overdue_count"], 1_500);
    assert_eq!(doc["reminders"]["flagged_count"], 90);
    assert_eq!(doc["words"]["overdue_label"], "1500 overdue");
    assert_eq!(doc["words"]["today_label"], "1200 today");
    let rows = doc["reminders"]["rows"].as_array().expect("rows");
    assert_eq!(
        rows.len(),
        MAX_ROWS,
        "the rows are capped, the counts are not"
    );
    assert!(
        rows.iter().all(|row| row["overdue"] == true),
        "overdue fills the rows first"
    );
}

#[test]
fn control_characters_cannot_push_the_document_past_its_bound() {
    // A control character escapes to six bytes; the rows are dropped from the
    // end until the document fits, and never the other way round.
    let nasty = "\u{1}".repeat(500);
    let tasks: Vec<wire::AgendaTask> = (0..50)
        .map(|n| task(&format!("t{n}"), &nasty, TODAY, "23:00"))
        .collect();
    let events: Vec<wire::AgendaEvent> = (0..50)
        .map(|n| {
            event(
                &format!("e{n}"),
                &nasty,
                "2026-11-07T22:00",
                "",
                false,
                &[TODAY],
            )
        })
        .collect();
    let raw = bytes(events, tasks);
    assert!(raw.len() <= MAX_BYTES, "{} bytes", raw.len());
    let doc: Value = serde_json::from_slice(&raw).expect("JSON");
    assert_eq!(doc["reminders"]["today_count"], 50);
    assert!(doc["up_next"].as_array().expect("rows").len() <= MAX_ROWS);
}

#[test]
fn the_module_documents_its_version() {
    assert_eq!(snapshot::VERSION, 1);
}

/// THE PHONE'S 12 OR 24 HOUR SETTING: the rows' labels and the sentence Siri
/// speaks are worded as the phone words a time; the default stays 24-hour; the
/// machine strings a widget compares (`starts_local`) never change.
#[test]
fn times_follow_the_phones_hour_cycle() {
    let events = || {
        vec![event(
            "d",
            "Dentist",
            "2026-11-07T15:00",
            "2026-11-07T16:00",
            false,
            &[TODAY],
        )]
    };
    let tasks = || vec![task("t", "Send invoice", TODAY, "17:30")];
    let counts = counted(&tasks());
    let twelve: Value =
        serde_json::from_slice(&bytes_worded(events(), tasks(), &counts, HourCycle::H12))
            .expect("JSON");
    assert_eq!(twelve["up_next"][0]["time_label"], "3:00 PM");
    assert_eq!(twelve["up_next"][1]["time_label"], "5:30 PM");
    assert_eq!(twelve["up_next"][0]["starts_local"], "2026-11-07T15:00");
    assert_eq!(
        twelve["siri"]["next_sentence"],
        "Next is Dentist at 3:00 PM."
    );
    let plain = build(events(), tasks());
    assert_eq!(plain["up_next"][0]["time_label"], "15:00");
    assert_eq!(plain["up_next"][1]["time_label"], "17:30");
}

/// THE OPEN KEYS: opaque, short, one per row and one per place, and every key a
/// document carries is one the table the service answers from holds.
#[test]
fn rows_carry_open_keys_and_the_table_names_each() {
    use super::snapshot::{Open, ready_with_opens, unavailable_with_opens};
    let upcoming = wire::AgendaUpcoming {
        events: vec![event(
            "series",
            "Dentist",
            "2026-11-07T15:00",
            "2026-11-07T16:00",
            false,
            &[TODAY],
        )],
        ..Default::default()
    };
    let tasks = vec![
        task("t1", "Send invoice", TODAY, "17:30"),
        task("t2", "Water plants", TODAY, ""),
    ];
    let counts = counted(&tasks);
    let (raw, opens) = ready_with_opens(&Inputs {
        locale: Locale::En,
        zone: ZONE,
        today: TODAY,
        now_local: NOW,
        upcoming: &upcoming,
        tasks: &tasks,
        cycle: HourCycle::default(),
        counts: &counts,
    });
    let doc: Value = serde_json::from_slice(&raw).expect("JSON");
    assert_eq!(doc["version"], 1);
    assert_eq!(doc["open_up_next"], "up_next");
    assert_eq!(doc["open_reminders"], "reminders");
    assert_eq!(doc["open_add"], "add");
    assert_eq!(doc["up_next"][0]["open"], "e:series:2026-11-07T15:00");
    assert_eq!(doc["up_next"][1]["open"], "t:t1");
    // A date-only due is listed before a timed one.
    assert_eq!(doc["reminders"]["rows"][0]["open"], "t:t2");
    assert_eq!(doc["reminders"]["rows"][1]["open"], "t:t1");
    assert_eq!(
        opens.get("t:t2"),
        Some(&Open::Task {
            task_id: "t2".to_owned()
        })
    );
    assert!(matches!(
        opens.get("e:series:2026-11-07T15:00"),
        Some(Open::Event { event_id, day, .. }) if event_id == "series" && day == TODAY
    ));
    assert_eq!(opens.get("add"), Some(&Open::Add));
    // Nothing the document names is missing from the table.
    for key in doc["up_next"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(doc["reminders"]["rows"].as_array().into_iter().flatten())
        .filter_map(|row| row["open"].as_str())
    {
        assert!(opens.contains_key(key), "{key}");
    }
    // The unavailable document still opens the app's places, and only those.
    let (raw, opens) = unavailable_with_opens(Locale::En, ZONE);
    let doc: Value = serde_json::from_slice(&raw).expect("JSON");
    assert_eq!(doc["open_add"], "add");
    assert_eq!(opens.len(), 3);
}
