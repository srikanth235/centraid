//! The reminders import, completed (#1173): every field a reminder carries and what the app makes of
//! it. The mappings are pure (`reminders::request`, `priority_of`, `list_color`); the rest runs the
//! member's own Import tap through the `imports.made` service against a real vault and reads the
//! tasks back from the board. (The service's one line drops a trailing full stop, as it does for
//! every importer.)

mod imports_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::imports::reminders;
use centraid_screens::kit::read::{self, Reading};
use imports_support::{Shell, shell};
use wire::app_query_response::Answer;
use wire::effect::Kind as K;
use wire::effect_result::Outcome as O;

fn reminder(title: &str) -> wire::PhoneReminder {
    wire::PhoneReminder {
        title: title.to_owned(),
        ..wire::PhoneReminder::default()
    }
}

// ---------------------------------------------------------------------------
// The mappings
// ---------------------------------------------------------------------------

#[test]
fn eventkit_priority_becomes_the_apps_bangs() {
    // 0 none; 1..4 high -> !!! ; 5 medium -> !! ; 6..9 low -> !
    let levels: Vec<i64> = [0, 1, 4, 5, 6, 9, -3, 12]
        .into_iter()
        .map(reminders::priority_of)
        .collect();
    assert_eq!(levels, [0, 3, 3, 2, 1, 1, 0, 0]);
}

#[test]
fn a_dated_reminder_carries_its_time_zone_priority_alarm_link_and_notes() {
    let r = wire::PhoneReminder {
        title: "Dentist".into(),
        notes: "bring the form".into(),
        due: "2026-12-01".into(),
        due_time: "09:30:00".into(),
        tz: "Europe/Paris".into(),
        priority: 5,
        alarm_minutes_before: Some(30),
        url: "https://example.com/appointment".into(),
        ..wire::PhoneReminder::default()
    };
    let (add, dropped) = reminders::fields(&r);
    assert!(!dropped);
    assert_eq!(add["title"], "Dentist");
    assert_eq!(add["description"], "bring the form");
    assert_eq!(add["due"], "2026-12-01T09:30");
    assert_eq!(add["zone"], "Europe/Paris");
    assert_eq!(add["priority"], 2);
    assert_eq!(add["remind_before_min"], 30);
    assert_eq!(add["url"], "https://example.com/appointment");
}

#[test]
fn a_date_only_reminder_stays_a_day_and_a_floating_time_has_no_zone() {
    let day = wire::PhoneReminder {
        due: "2026-12-01".into(),
        ..reminder("Day")
    };
    let (add, _) = reminders::fields(&day);
    assert_eq!(add["due"], "2026-12-01");
    assert_eq!(add["zone"], serde_json::Value::Null);
    let floating = wire::PhoneReminder {
        due_time: "18:00".into(),
        ..day
    };
    let (add, _) = reminders::fields(&floating);
    assert_eq!(add["due"], "2026-12-01T18:00");
    assert_eq!(add["zone"], serde_json::Value::Null);
}

#[test]
fn an_alarm_with_no_due_is_dropped_because_it_has_nothing_to_count_back_from() {
    let r = wire::PhoneReminder {
        alarm_minutes_before: Some(10),
        ..reminder("No due")
    };
    let (add, _) = reminders::fields(&r);
    assert_eq!(add["remind_before_min"], serde_json::Value::Null);
}

#[test]
fn a_supported_rule_is_kept_and_an_unsupported_one_is_dropped_and_counted() {
    let dated = |rrule: &str| wire::PhoneReminder {
        due: "2026-12-01".into(),
        rrule: rrule.into(),
        ..reminder("Repeats")
    };
    let (add, dropped) = reminders::fields(&dated("RRULE:FREQ=WEEKLY;BYDAY=MO,WE"));
    assert!(!dropped);
    assert_eq!(add["rule"], "FREQ=WEEKLY;BYDAY=MO,WE");
    // An hourly rule is below the engine's day.
    let (add, dropped) = reminders::fields(&dated("FREQ=HOURLY;INTERVAL=2"));
    assert!(dropped);
    assert_eq!(add["rule"], serde_json::Value::Null);
    // A rule with nothing to repeat from cannot be kept either.
    let undated = wire::PhoneReminder {
        rrule: "FREQ=DAILY".into(),
        ..reminder("Undated")
    };
    let (_, dropped) = reminders::fields(&undated);
    assert!(dropped);
}

#[test]
fn a_phone_colour_becomes_the_nearest_list_colour_never_red_amber_or_green() {
    assert_eq!(
        reminders::list_color("Red", "#FF3B30").as_deref(),
        Some("raspberry")
    );
    assert_eq!(
        reminders::list_color("Amber", "#FF9500").as_deref(),
        Some("mustard")
    );
    assert_eq!(
        reminders::list_color("Green", "#34C759").as_deref(),
        Some("petrol")
    );
    assert_eq!(
        reminders::list_color("Grey", "#8E8E93").as_deref(),
        Some("graphite")
    );
    assert_eq!(reminders::list_color("None", ""), None);
}

#[test]
fn a_completed_reminder_is_kept_only_when_the_member_asked_for_them() {
    let done = wire::PhoneReminder {
        completed: true,
        completed_at: "2026-11-01T08:00:00Z".into(),
        ..reminder("Done")
    };
    let open = reminder("Open");
    let both = [open.clone(), done.clone()];
    assert_eq!(reminders::tasks(&both, false).len(), 1);
    assert_eq!(reminders::tasks(&both, true).len(), 2);
    let (add, _) = reminders::fields(&done);
    assert_eq!(add["done_at"], "2026-11-01T08:00:00Z");
    let (add, _) = reminders::fields(&open);
    assert_eq!(add["done_at"], serde_json::Value::Null);
}

#[test]
fn the_status_line_says_what_was_refused_dropped_and_made() {
    use centraid_screens::strings::Locale;
    let said = reminders::status_line(
        Locale::En,
        reminders::Outcome {
            added: 3,
            refused: 1,
            rules_dropped: 2,
            lists_created: 1,
            ..reminders::Outcome::default()
        },
    );
    assert_eq!(
        said,
        "3 tasks imported. 1 reminder could not be imported. 2 repeats were not imported. 1 list created."
    );
    assert_eq!(
        reminders::status_line(
            Locale::En,
            reminders::Outcome {
                added: 1,
                ..reminders::Outcome::default()
            }
        ),
        "1 task imported"
    );
}

// ---------------------------------------------------------------------------
// Through the vault
// ---------------------------------------------------------------------------

fn tap(shell: &mut Shell, include_completed: bool) {
    let instance = shell.made;
    shell.d.send(
        instance,
        wire::screen_event::Kind::ImportsMade(wire::ImportsMadeEvent {
            kind: Some(wire::imports_made_event::Kind::RemindersRequested(
                wire::imports_made_event::RemindersRequested { include_completed },
            )),
        }),
    );
}

fn asked(shell: &Shell) -> Vec<wire::RemindersRead> {
    shell
        .d
        .effects
        .iter()
        .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            K::RemindersRead(read) => Some(*read),
            _ => None,
        })
        .collect()
}

fn answer(shell: &mut Shell, outcome: O) {
    let at = shell
        .d
        .effects
        .iter()
        .position(|request| {
            matches!(
                request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                Some(K::RemindersRead(_))
            )
        })
        .expect("a reminders read is out");
    let request = shell.d.effects.remove(at);
    shell.d.send(
        request.instance,
        wire::screen_event::Kind::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(outcome),
        }),
    );
}

fn snapshot(items: Vec<wire::PhoneReminder>) -> O {
    O::RemindersSnapshot(wire::RemindersSnapshot { reminders: items })
}

fn line(shell: &Shell) -> String {
    match &shell.d.views[&shell.made].kind {
        Some(wire::view_state::Kind::ImportsMade(state)) => state.summary.clone(),
        other => panic!("made draws {other:?}"),
    }
}

fn flatten(tasks: &[wire::AgendaTask], into: &mut Vec<wire::AgendaTask>) {
    for task in tasks {
        into.push(task.clone());
        flatten(&task.children, into);
    }
}

/// Every task the board holds: the open ones and the logbook's.
fn tasks(shell: &Shell) -> Vec<wire::AgendaTask> {
    let mut all = Vec::new();
    for view in [
        load::reminders::BoardView::All,
        load::reminders::BoardView::Logbook,
    ] {
        shell.d.with_ctx(|ctx| {
            if let Reading::Data(board) = read::read(
                ctx,
                load::reminders::Board {
                    limit: 500,
                    view: Some(view),
                    ..load::reminders::Board::default()
                },
                |answer| match answer {
                    Answer::AgendaTaskBoard(board) => Some(board),
                    _ => None,
                },
            ) {
                for group in &board.groups {
                    flatten(&group.tasks, &mut all);
                }
            }
        });
    }
    all
}

fn projects(shell: &Shell) -> Vec<wire::AgendaTaskProject> {
    shell.d.with_ctx(|ctx| {
        match read::read(
            ctx,
            load::reminders::Projects::default(),
            |answer| match answer {
                Answer::AgendaTaskProjects(projects) => Some(projects),
                _ => None,
            },
        ) {
            Reading::Data(projects) => projects.projects,
            _ => panic!("the projects read"),
        }
    })
}

fn find(all: &[wire::AgendaTask], title: &str) -> wire::AgendaTask {
    all.iter()
        .find(|task| task.title == title)
        .unwrap_or_else(|| panic!("no task `{title}` in {all:?}"))
        .clone()
}

fn fresh_shell() -> Shell {
    let mut shell = shell();
    // The services open together; their first reads are not this file's.
    shell.d.effects.clear();
    shell
}

#[test]
fn the_tap_asks_the_os_and_the_completed_option_is_asked_only_when_on() {
    let mut off = fresh_shell();
    tap(&mut off, false);
    let reads = asked(&off);
    assert_eq!(reads.len(), 1);
    assert!(reads[0].ask_permission && !reads[0].include_completed);
    let mut on = fresh_shell();
    tap(&mut on, true);
    assert!(asked(&on)[0].include_completed);
}

#[test]
fn every_field_lands_on_the_task_and_the_priority_and_rule_are_the_vaults() {
    let mut shell = fresh_shell();
    tap(&mut shell, false);
    answer(
        &mut shell,
        snapshot(vec![wire::PhoneReminder {
            title: "Pay rent".into(),
            notes: "transfer".into(),
            due: "2099-03-02".into(),
            due_time: "09:00".into(),
            tz: "Europe/Paris".into(),
            priority: 1,
            phone_flagged: Some(true),
            rrule: "FREQ=MONTHLY;BYMONTHDAY=2".into(),
            alarm_minutes_before: Some(60),
            ..wire::PhoneReminder::default()
        }]),
    );
    assert_eq!(line(&shell), "1 task imported");
    let all = tasks(&shell);
    let rent = find(&all, "Pay rent");
    assert_eq!(rent.priority, 3);
    assert_eq!(rent.description.as_deref(), Some("transfer"));
    assert_eq!(rent.remind_before_min, Some(60));
    assert_eq!(rent.tz.as_deref(), Some("Europe/Paris"));
    assert!(rent.repeats);
    assert_eq!(rent.rrule.as_deref(), Some("FREQ=MONTHLY;BYMONTHDAY=2"));
    assert_eq!(rent.due_time, "09:00");
    assert!(rent.flagged, "the phone's flag is the task's star");
}

#[test]
fn an_unsupported_rule_imports_the_task_without_it_and_the_line_counts_it() {
    let mut shell = fresh_shell();
    tap(&mut shell, false);
    answer(
        &mut shell,
        snapshot(vec![wire::PhoneReminder {
            due: "2099-03-02".into(),
            rrule: "FREQ=SECONDLY".into(),
            ..reminder("Hourly")
        }]),
    );
    assert_eq!(line(&shell), "1 task imported. 1 repeat was not imported");
    let hourly = find(&tasks(&shell), "Hourly");
    assert!(!hourly.repeats);
}

#[test]
fn a_reminders_list_becomes_a_list_made_once_in_the_nearest_colour() {
    let mut shell = fresh_shell();
    tap(&mut shell, false);
    let on = |title: &str, list: &str, color: &str| wire::PhoneReminder {
        list_title: list.into(),
        list_color: color.into(),
        ..reminder(title)
    };
    answer(
        &mut shell,
        snapshot(vec![
            on("Milk", "Groceries", "#FF3B30"),
            on("Eggs", "groceries", "#FF3B30"),
            on("Call", "Family", "#34C759"),
            on("Loose", "", ""),
        ]),
    );
    assert_eq!(line(&shell), "4 tasks imported. 2 lists created");
    let lists = projects(&shell);
    let groceries = lists
        .iter()
        .find(|list| list.name == "Groceries")
        .expect("the list");
    assert_eq!(groceries.color.as_deref(), Some("raspberry"));
    let family = lists
        .iter()
        .find(|list| list.name == "Family")
        .expect("list");
    assert_eq!(family.color.as_deref(), Some("petrol"));
    assert_eq!(
        lists
            .iter()
            .filter(|l| l.name.to_lowercase() == "groceries")
            .count(),
        1
    );
    let all = tasks(&shell);
    assert_eq!(
        find(&all, "Milk").project_id.as_deref(),
        Some(groceries.project_id.as_str())
    );
    assert_eq!(find(&all, "Loose").project_id, None);

    // A second import finds the lists by name: none is made again.
    tap(&mut shell, false);
    answer(
        &mut shell,
        snapshot(vec![on("Bread", "Groceries", "#FF3B30")]),
    );
    assert_eq!(line(&shell), "1 task imported");
    assert_eq!(projects(&shell).len(), lists.len());
}

#[test]
fn completed_reminders_come_in_as_done_tasks_only_with_the_toggle_on() {
    let items = || {
        vec![
            reminder("Still open"),
            wire::PhoneReminder {
                completed: true,
                completed_at: "2026-10-01T08:00:00Z".into(),
                ..reminder("Finished")
            },
        ]
    };
    // Toggle off: even a shell that hands a completed one over gets it ignored.
    let mut off = fresh_shell();
    tap(&mut off, false);
    answer(&mut off, snapshot(items()));
    assert_eq!(line(&off), "1 task imported");
    assert!(!tasks(&off).iter().any(|task| task.title == "Finished"));

    let mut on = fresh_shell();
    tap(&mut on, true);
    answer(&mut on, snapshot(items()));
    assert_eq!(line(&on), "2 tasks imported");
    let all = tasks(&on);
    let finished = find(&all, "Finished");
    assert_eq!(finished.status, "done");
    assert_eq!(
        finished.completed_at.as_deref(),
        Some("2026-10-01T08:00:00Z")
    );
    assert_eq!(find(&all, "Still open").status, "open");
}

#[test]
fn a_refused_or_denied_read_says_so_and_a_duplicate_is_folded() {
    let mut shell = fresh_shell();
    tap(&mut shell, false);
    answer(
        &mut shell,
        O::Failed(wire::EffectFailed {
            reason: "denied".into(),
            denied: true,
            cancelled: false,
        }),
    );
    assert_eq!(
        line(&shell),
        "Reminders access is off. Turn it on in Settings"
    );
    tap(&mut shell, false);
    answer(
        &mut shell,
        snapshot(vec![
            wire::PhoneReminder {
                due: "2099-01-01".into(),
                ..reminder("Same")
            },
            wire::PhoneReminder {
                due: "2099-01-01".into(),
                ..reminder("same")
            },
        ]),
    );
    assert_eq!(line(&shell), "1 task imported");
}
