//! Health's home (`health.home`): ports of the `HealthScreensSpec` home cases —
//! the empty and connected states, Today's words and units, More, the facts, the
//! trends, the workouts — and the change-event path that `record-days` once never
//! reached (a `WITHOUT ROWID` table's write reported no table).

mod health_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::kit::menu;
use health_support::*;
use wire::health_home_event as he;
use wire::health_home_state::Sheet;

/// Thirty days before today, steps climbing from 6,100 to 9,000, plus today.
fn month_of_steps(d: &centraid_screens::testing::Driver, today: &str) {
    let mut days: Vec<(i64, &str, f64)> = (1..=30)
        .map(|back| (back, "steps", 6_000.0 + 100.0 * back as f64))
        .collect();
    days.extend([
        (0, "steps", 8_412.0),
        (0, "sleep_min", 432.0),
        (0, "active_energy_kcal", 412.0),
        (0, "resting_hr_bpm", 58.0),
        (1, "weight_kg", 71.4),
        (1, "resting_hr_bpm", 59.0),
        (2, "resting_hr_bpm", 61.0),
        (3, "resting_hr_bpm", 57.0),
    ]);
    record(d, today, &days);
}

#[test]
fn nothing_connected_every_tab_is_one_sentence_and_connect_naming_the_phones_store() {
    let d = driver();
    let i = root(&d);
    let state = home_state(d.view(i));
    let data = home_data(d.view(i));
    let empty = data.empty.as_ref().expect("an empty state");
    assert_eq!(
        empty.headline,
        "Bring in your steps, sleep and workouts from Apple Health."
    );
    assert_eq!(empty.action_label, "Connect Apple Health");
    assert!(data.today_data.is_none());
    let band: Vec<&str> = state.band.iter().map(|tab| tab.label.as_str()).collect();
    assert_eq!(band, ["Summary", "Trends", "Workouts", "More"]);
    let more: Vec<&str> = state.more_rows.iter().map(|row| row.key.as_str()).collect();
    assert_eq!(more, ["reads", "choose"]);
    // The row that opens Connect carries the route, and the empty state's
    // action does too: no shell names a destination.
    assert_eq!(
        state.more_rows[1].route.as_ref().map(|r| r.screen.as_str()),
        Some("health.connect")
    );
    assert_eq!(
        data.connect.as_ref().map(|r| r.screen.as_str()),
        Some("health.connect")
    );
}

#[test]
fn the_phones_store_is_its_os_health_connect_on_android() {
    let d = driver_on("android", "en-GB");
    let data = home_data(d.view(root(&d)));
    assert_eq!(
        data.empty.as_ref().unwrap().action_label,
        "Connect Health Connect"
    );
}

#[test]
fn today_is_the_days_numbers_against_the_members_own_typical_in_the_members_words() {
    let d = driver();
    let today = today(&d);
    connect_store(&d);
    month_of_steps(&d, &today);
    workout(
        &d,
        "w1",
        "run",
        &format!("{today}T09:00:00.000Z"),
        &format!("{today}T09:31:00.000Z"),
    );
    let mut d = d;
    let i = root(&d);
    home_event(&mut d, i, he::Kind::Refreshed(he::Refreshed {}));
    let data = home_data(d.view(i));
    let today_data = data.today_data.as_ref().expect("Today's numbers");
    let hero = today_data.hero.as_ref().unwrap();
    assert_eq!(hero.value, "8,412");
    assert_eq!(hero.when_label, "So far today");
    // Above the usual range (the quartiles of the 30 days before), and higher steps are better.
    assert_eq!(hero.typical, "Above your typical 6,825–8,275");
    assert!(hero.good && hero.wide);
    // The seven days to today, as a share of the tallest; today's the tallest and last.
    assert_eq!(hero.spark_bp.len(), 7);
    assert_eq!(hero.spark_bp[6], 10_000);
    assert_eq!(hero.spark_bp[0], 7_846);
    assert_eq!(hero.spark_label, "Last 7 days");
    assert_eq!(today_data.metrics_heading, "Pinned");
    assert_eq!(today_data.metrics_note, "against your own typical");
    // The 30 days to today average 7,530 steps against the one day (9,000) before them: -16%.
    assert_eq!(today_data.highlights_heading, "Highlights");
    assert_eq!(today_data.highlights.len(), 1);
    let said = &today_data.highlights[0];
    assert_eq!(said.emphasis, "16% less");
    assert_eq!(said.lead, "Over the last 30 days you walked ");
    assert_eq!(
        data.day_label.split(" · ").nth(1),
        Some("read from Apple Health")
    );
    // The route a tap pushes is the metric's page, from this page's title.
    match &hero.route.as_ref().unwrap().args {
        Some(wire::route::Args::HealthMetric(args)) => {
            assert_eq!(
                (args.metric.as_str(), args.parent.as_str()),
                ("steps", "Summary")
            );
        }
        other => panic!("{other:?}"),
    }
    let labels: Vec<&str> = today_data
        .metrics
        .iter()
        .map(|m| m.label.as_str())
        .collect();
    assert_eq!(
        labels,
        [
            "Sleep",
            "Active energy",
            "Exercise",
            "Resting heart rate",
            "Weight"
        ]
    );
    let sleep = &today_data.metrics[0];
    assert_eq!(
        (sleep.value.as_str(), sleep.when_label.as_str()),
        ("7 h 12 min", "Last night")
    );
    // Pinned order is fixed: the first two cards are wide (with a sparkline), the rest compact
    // and without one.
    let order: Vec<&str> = std::iter::once(hero)
        .chain(&today_data.metrics)
        .map(|line| line.metric.as_str())
        .collect();
    assert_eq!(
        order,
        [
            "steps",
            "sleep_min",
            "active_energy_kcal",
            "exercise_min",
            "resting_hr_bpm",
            "weight_kg"
        ]
    );
    let wide: Vec<bool> = std::iter::once(hero)
        .chain(&today_data.metrics)
        .map(|line| line.wide)
        .collect();
    assert_eq!(wide, [true, true, false, false, false, false]);
    let icons: Vec<&str> = std::iter::once(hero)
        .chain(&today_data.metrics)
        .map(|line| line.icon_key.as_str())
        .collect();
    assert_eq!(
        icons,
        ["MapPin", "Moon", "Bolt", "Activity", "Heart", "Gauge"]
    );
    assert_eq!(sleep.spark_bp.len(), 7);
    assert!(
        today_data.metrics[1..]
            .iter()
            .all(|line| line.spark_bp.is_empty())
    );
    // A compact card says the typical alone: no range, no verdict.
    assert_eq!(today_data.metrics[1].typical, "");
    assert_eq!(today_data.metrics[3].typical, "Typical 58–60");
    assert_eq!(today_data.metrics[1].unit, "kcal");
    let exercise = &today_data.metrics[2];
    assert_eq!(exercise.value, "");
    assert_eq!(exercise.when_label, "Nothing yet today");
    let weight = &today_data.metrics[4];
    assert_eq!(
        (weight.value.as_str(), weight.unit.as_str()),
        ("71.4", "kg")
    );
    assert_eq!(weight.when_label, "Yesterday");
    assert_eq!(today_data.workouts_heading, "Workouts today");
    let line = &today_data.workouts[0];
    assert_eq!(line.title, "Morning run");
    assert_eq!(line.meta, "5.2 km · 31 min");
    // R-1129-13: where the numbers come from (the header's subtitle), and no time.
    assert!(!data.day_label.contains(':'));
}

#[test]
fn units_are_the_phones_imperial_weighs_in_pounds_and_runs_in_miles() {
    let d = driver_on("ios", "en-US");
    let today = today(&d);
    connect_store(&d);
    record(&d, &today, &[(1, "weight_kg", 71.4)]);
    workout(
        &d,
        "w1",
        "run",
        &format!("{today}T09:00:00.000Z"),
        &format!("{today}T09:31:00.000Z"),
    );
    let mut d = d;
    let i = root(&d);
    home_event(&mut d, i, he::Kind::Refreshed(he::Refreshed {}));
    let today_data = home_data(d.view(i)).today_data.clone().unwrap();
    let weight = &today_data.metrics[4];
    assert_eq!(
        (weight.value.as_str(), weight.unit.as_str()),
        ("157.4", "lb")
    );
    assert_eq!(today_data.workouts[0].meta, "3.2 mi · 31 min");
}

#[test]
fn a_record_days_write_redraws_today_with_no_tap() {
    // The census of a commit that wrote only `measurement` was empty (a WITHOUT
    // ROWID table never reaches SQLite's update hook), so no change event fired and
    // a screen never drew the day the follower had just recorded.
    let mut d = driver();
    let today = today(&d);
    connect_store(&d);
    let i = root(&d);
    d.pump(Duration::from_millis(300));
    let steps = |d: &centraid_screens::testing::Driver| {
        home_data(d.view(i))
            .today_data
            .as_ref()
            .and_then(|t| t.hero.as_ref())
            .map(|hero| hero.value.clone())
    };
    assert_eq!(steps(&d).as_deref(), Some(""));
    record(&d, &today, &[(0, "steps", 8_412.0)]);
    d.pump(Duration::from_millis(500));
    assert_eq!(steps(&d).as_deref(), Some("8,412"));
}

#[test]
fn more_says_what_health_reads_and_a_chosen_type_that_read_nothing_and_stops_behind_a_confirm() {
    let (mut d, follower) = driver_following_on("ios", "de-DE");
    let today = today(&d);
    connect_store(&d);
    record(&d, &today, &[(0, "steps", 8_412.0), (1, "weight_kg", 71.4)]);
    let i = root(&d);
    // The phone's habit: connected, with steps, sleep, weight and workouts chosen.
    assert!(matches!(pending(&d), wire::effect::Kind::Keychain(_)));
    d.answer_effect(keychain("1|steps,sleep_min,weight_kg,workouts"));
    // The pass the coordinator starts reads the same habit, then asks the shell to read the
    // store, and never asks the OS.
    d.pump(std::time::Duration::from_millis(2_600));
    answer_for(
        &mut d,
        follower,
        keychain("1|steps,sleep_min,weight_kg,workouts"),
    );
    match pending_for(&d, follower) {
        wire::effect::Kind::HealthRead(read) => {
            assert!(!read.ask_permission);
            assert_eq!(read.chosen, ["steps", "sleep_min", "weight_kg", "workouts"]);
            assert_eq!(read.today, today);
        }
        other => panic!("{other:?}"),
    }
    answer_for(
        &mut d,
        follower,
        wire::effect_result::Outcome::Health(wire::HealthSnapshot {
            store: wire::health_snapshot::Store::AppleHealth as i32,
            store_present: true,
            workouts_complete: true,
            device_id: "phone-a".to_owned(),
            ..Default::default()
        }),
    );
    let state = home_state(d.view(i));
    let rows: Vec<&str> = state.more_rows.iter().map(|row| row.key.as_str()).collect();
    assert_eq!(rows, ["reads", "choose", "stop"]);
    assert_eq!(state.more_rows[2].label, "Stop reading Apple Health");
    assert_eq!(state.more_rows[2].tone, wire::status_chip::Tone::Net as i32);
    let facts: Vec<(&str, &str)> = state
        .reads_facts
        .iter()
        .map(|fact| (fact.label.as_str(), fact.detail.as_str()))
        .collect();
    // Sleep was chosen and read nothing in the year: HealthKit cannot say it was
    // refused. And nothing says Chat does not read Health: it does.
    assert_eq!(
        facts,
        [
            ("Reads", "daily totals and workouts"),
            ("Writes", "nothing to Apple Health"),
            ("Nothing read", "Sleep: see Settings › Health › Data Access"),
        ]
    );
    home_event(
        &mut d,
        i,
        he::Kind::More(he::MorePicked {
            key: "reads".to_owned(),
        }),
    );
    assert_eq!(home_state(d.view(i)).sheet, Sheet::Reads as i32);
    home_event(
        &mut d,
        i,
        he::Kind::More(he::MorePicked {
            key: "stop".to_owned(),
        }),
    );
    let stop = home_state(d.view(i));
    assert_eq!(stop.sheet, Sheet::Stop as i32);
    let confirm = stop.stop.as_ref().expect("the confirm");
    assert_eq!(confirm.title, "Stop reading Apple Health?");
    assert!(confirm.destructive);
    // Confirmed: the origin is retired, every day stays, the phone forgets it
    // connected (and keeps the choice), and the screen is the empty state again.
    home_event(&mut d, i, he::Kind::Stop(he::StopConfirmed {}));
    let after = home_state(d.view(i));
    assert_eq!(after.sheet, Sheet::None as i32);
    assert!(home_data(d.view(i)).empty.is_some());
    match pending(&d) {
        wire::effect::Kind::Keychain(op) => {
            assert_eq!(op.op, wire::keychain_op::Op::Set as i32);
            assert_eq!(op.value, b"0|steps,sleep_min,weight_kg,workouts");
        }
        other => panic!("{other:?}"),
    }
    match answer(&d, centraid_screens::catalog::load::health::Today {}) {
        wire::app_query_response::Answer::HealthToday(today) => {
            assert!(!today.connected);
            assert!(
                today.metrics.iter().any(|m| m.value.is_some()),
                "every day stays"
            );
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn health_connect_names_a_refused_type_exactly() {
    let (mut d, follower) = driver_following_on("android", "en-GB");
    let today = today(&d);
    connect_store(&d);
    record(&d, &today, &[(0, "steps", 8_412.0)]);
    let i = root(&d);
    d.answer_effect(keychain("1|steps,sleep_min"));
    // The home asked the coordinator for a pass: after the settle it reads the same habit.
    d.pump(std::time::Duration::from_millis(2_600));
    answer_for(&mut d, follower, keychain("1|steps,sleep_min"));
    answer_for(
        &mut d,
        follower,
        wire::effect_result::Outcome::Health(wire::HealthSnapshot {
            store: wire::health_snapshot::Store::HealthConnect as i32,
            store_present: true,
            refused: vec!["sleep_min".to_owned()],
            ..Default::default()
        }),
    );
    let facts = &home_state(d.view(i)).reads_facts;
    let last = facts.last().unwrap();
    assert_eq!(
        (last.label.as_str(), last.detail.as_str()),
        ("Not allowed", "Sleep: change it in Health Connect")
    );
    assert!(facts.iter().all(|fact| fact.label != "Nothing read"));
}

#[test]
fn trends_are_per_metric_deltas_against_the_period_before_a_sparkline_with_gaps_and_the_range_a_segment()
 {
    let mut d = driver();
    let today = today(&d);
    connect_store(&d);
    // 30 days before today at 7,000, the 30 before them at 6,000.
    let mut days: Vec<(i64, &str, f64)> = (0..30).map(|b| (b, "steps", 7_000.0)).collect();
    days.extend((30..60).map(|b| (b, "steps", 6_000.0)));
    days.extend([(0, "sleep_min", 420.0), (40, "sleep_min", 400.0)]);
    record(&d, &today, &days);
    let i = root(&d);
    band(&mut d, i, "trends");
    let state = home_state(d.view(i));
    assert_eq!(state.destination, wire::HealthDestination::Trends as i32);
    let trends = home_data(d.view(i)).trends.as_ref().expect("trends");
    assert_eq!(
        trends.compare_line,
        "Last 30 days, against the 30 days before"
    );
    let steps = &trends.rows[0];
    assert_eq!(steps.label, "Steps");
    assert_eq!(steps.unit, "a day");
    assert_eq!(steps.delta, "+17%");
    assert!(!steps.points_bp.is_empty());
    let sleep = trends
        .rows
        .iter()
        .find(|row| row.metric == "sleep_min")
        .unwrap();
    assert_eq!(sleep.unit, "a night");
    let segments: Vec<(&str, bool)> = state
        .segments
        .iter()
        .map(|segment| (segment.label.as_str(), segment.active))
        .collect();
    assert_eq!(
        segments,
        [("30 days", true), ("90 days", false), ("Year", false)]
    );
    home_event(
        &mut d,
        i,
        he::Kind::Range(he::RangePicked {
            key: "year".to_owned(),
        }),
    );
    assert_eq!(
        home_data(d.view(i)).trends.as_ref().unwrap().compare_line,
        "Last 12 months, against the year before"
    );
}

/// A run today and a ride 40 days back, on the Workouts tab.
fn run_and_ride(d: &mut centraid_screens::testing::Driver) -> u64 {
    let today = today(d);
    connect_store(d);
    workout(
        d,
        "w1",
        "run",
        &format!("{today}T09:00:00.000Z"),
        &format!("{today}T09:31:00.000Z"),
    );
    let old = day_back(&today, 40);
    workout(
        d,
        "w2",
        "cycle",
        &format!("{old}T16:00:00.000Z"),
        &format!("{old}T17:00:00.000Z"),
    );
    let i = root(d);
    band(d, i, "workouts");
    i
}

fn pick_kind(d: &mut centraid_screens::testing::Driver, i: u64, option: &str) {
    home_event(
        d,
        i,
        he::Kind::FilterMenuPicked(wire::FilterMenuPicked {
            section_key: "kind".to_owned(),
            option_key: option.to_owned(),
        }),
    );
}

#[test]
fn workouts_are_this_week_then_by_month_newest_first_with_a_menu_option_per_kind_present() {
    let mut d = driver();
    let i = run_and_ride(&mut d);
    let state = home_state(d.view(i));
    let menu = state.filter_menu.as_ref().expect("the workouts menu");
    assert_eq!(menu.sections.len(), 1);
    let kind = menu::find(menu, "kind").expect("the kind section");
    assert_eq!(kind.title, "Type");
    assert_eq!(kind.kind, wire::menu_section::Kind::Single as i32);
    assert!(!kind.nested);
    let labels: Vec<&str> = kind.options.iter().map(|o| o.label.as_str()).collect();
    // The core orders the kinds most first, then by label.
    assert_eq!(labels, ["All", "Rides", "Runs"]);
    assert_eq!(kind.options[0].key, "all");
    assert!(kind.options.iter().all(|option| option.count == 0));
    assert_eq!(menu::checked(kind), ["all"]);
    assert!(!menu.filtering);
    assert_eq!(menu.spoken, "Filter");
    assert_eq!(menu.clear_label, "Clear filters");
    let workouts = home_data(d.view(i)).workouts.as_ref().unwrap();
    assert_eq!(workouts.sections.len(), 2);
    assert_eq!(workouts.sections[0].heading, "This week");
    assert_eq!(workouts.sections[0].rows[0].title, "Morning run");
    assert_eq!(workouts.sections[1].rows[0].title, "Evening ride");
    assert!(!workouts.more);
}

#[test]
fn picking_a_kind_filters_lights_the_button_and_the_option_key_is_the_concept() {
    let mut d = driver();
    let i = run_and_ride(&mut d);
    let run = home_state(d.view(i)).filter_menu.as_ref().unwrap().sections[0].options[2]
        .key
        .clone();
    assert_ne!(run, "all");
    pick_kind(&mut d, i, &run);
    let state = home_state(d.view(i));
    let menu = state.filter_menu.as_ref().unwrap();
    assert!(menu.filtering);
    assert_eq!(menu.spoken, "Filter, on");
    assert_eq!(
        menu::checked(menu::find(menu, "kind").unwrap()),
        [run.as_str()]
    );
    // The kinds stay on offer, so the member can switch from one to another.
    assert_eq!(menu.sections[0].options.len(), 3);
    let filtered = home_data(d.view(i)).workouts.as_ref().unwrap();
    assert_eq!(filtered.sections.len(), 1);
    assert_eq!(filtered.sections[0].rows[0].title, "Morning run");
    // The row's route is the workout's page, from this page's title.
    match &filtered.sections[0].rows[0].route.as_ref().unwrap().args {
        Some(wire::route::Args::HealthWorkout(args)) => assert_eq!(args.parent, "Workouts"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn picking_all_and_the_clear_row_both_return_every_kind() {
    let mut d = driver();
    let i = run_and_ride(&mut d);
    let run = home_state(d.view(i)).filter_menu.as_ref().unwrap().sections[0].options[2]
        .key
        .clone();

    pick_kind(&mut d, i, &run);
    assert!(
        home_state(d.view(i))
            .filter_menu
            .as_ref()
            .unwrap()
            .filtering
    );
    pick_kind(&mut d, i, "all");
    let state = home_state(d.view(i));
    let menu = state.filter_menu.as_ref().unwrap();
    assert!(!menu.filtering);
    assert_eq!(menu::checked(&menu.sections[0]), ["all"]);
    assert_eq!(
        home_data(d.view(i))
            .workouts
            .as_ref()
            .unwrap()
            .sections
            .len(),
        2
    );

    pick_kind(&mut d, i, &run);
    home_event(
        &mut d,
        i,
        he::Kind::FilterMenuCleared(wire::FilterMenuCleared {}),
    );
    let state = home_state(d.view(i));
    let menu = state.filter_menu.as_ref().unwrap();
    assert!(!menu.filtering);
    assert_eq!(menu::checked(&menu.sections[0]), ["all"]);
    assert_eq!(
        home_data(d.view(i))
            .workouts
            .as_ref()
            .unwrap()
            .sections
            .len(),
        2
    );
}

#[test]
fn a_pick_in_another_section_changes_nothing() {
    let mut d = driver();
    let i = run_and_ride(&mut d);
    home_event(
        &mut d,
        i,
        he::Kind::FilterMenuPicked(wire::FilterMenuPicked {
            section_key: "sort".to_owned(),
            option_key: "oldest".to_owned(),
        }),
    );
    let state = home_state(d.view(i));
    assert!(!state.filter_menu.as_ref().unwrap().filtering);
    assert_eq!(
        home_data(d.view(i))
            .workouts
            .as_ref()
            .unwrap()
            .sections
            .len(),
        2
    );
}

#[test]
fn the_menu_is_on_workouts_only_and_never_before_a_store_or_without_a_kind() {
    // Not connected: no tab has a menu.
    let mut d = driver();
    let i = root(&d);
    band(&mut d, i, "workouts");
    assert!(home_state(d.view(i)).filter_menu.is_none());

    // Connected, no workout yet: there is no kind to choose, so no button.
    let mut d = driver();
    connect_store(&d);
    let i = root(&d);
    band(&mut d, i, "workouts");
    assert!(home_state(d.view(i)).filter_menu.is_none());

    // Connected with workouts: Today and Trends have none, Workouts has one.
    let mut d = driver();
    let i = run_and_ride(&mut d);
    assert!(home_state(d.view(i)).filter_menu.is_some());
    band(&mut d, i, "today");
    assert!(home_state(d.view(i)).filter_menu.is_none());
    band(&mut d, i, "trends");
    assert!(home_state(d.view(i)).filter_menu.is_none());
    // Trends keeps its range segments, which are not the menu.
    assert_eq!(home_state(d.view(i)).segments.len(), 3);
    band(&mut d, i, "workouts");
    assert!(home_state(d.view(i)).filter_menu.is_some());
}

#[test]
fn a_workout_re_reads_home_and_an_unrelated_write_does_not() {
    // Port of "a change to the days, the workouts, their kinds or the store's origin re-reads
    // home, and nothing else does".
    let mut d = driver();
    let today = today(&d);
    connect_store(&d);
    let i = root(&d);
    band(&mut d, i, "workouts");
    d.pump(Duration::from_millis(300));
    assert!(
        home_data(d.view(i))
            .workouts
            .as_ref()
            .unwrap()
            .sections
            .is_empty()
    );

    // Nothing Health reads changed: no screen update arrives.
    arrange(
        &d,
        centraid_screens::catalog::act::notes::CreateNote {
            title: "Unrelated".to_owned(),
            body: "words".to_owned(),
            ..Default::default()
        },
    );
    assert_eq!(d.pump(Duration::from_millis(400)), 0);

    // A followed workout does: it is drawn with no tap.
    workout(
        &d,
        "w1",
        "run",
        &format!("{today}T09:00:00.000Z"),
        &format!("{today}T09:31:00.000Z"),
    );
    assert!(d.pump(Duration::from_millis(500)) > 0);
    assert_eq!(
        home_data(d.view(i)).workouts.as_ref().unwrap().sections[0].rows[0].title,
        "Morning run"
    );
}
