//! Health's export (`health.export`, #1185): the kit's export screen with a row for the daily
//! totals, one for the workouts and one per metric, an owner check first, and a spreadsheet file
//! handed to the OS save sheet.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::health;
use centraid_screens::kit::export;
use centraid_screens::strings::Locale;
use centraid_screens::testing::Driver;
use health_support::*;

fn state(v: &wire::ViewState) -> &wire::TransferView {
    match &v.kind {
        Some(wire::view_state::Kind::Transfer(view)) => view,
        other => panic!("not a transfer: {other:?}"),
    }
}

fn pass_owner_check(d: &mut Driver) {
    while matches!(
        d.effects
            .first()
            .and_then(|e| e.effect.as_ref())
            .and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::OwnerCheck(_))
    ) {
        d.answer_effect(wire::effect_result::Outcome::OwnerChecked(
            wire::OwnerChecked {
                available: true,
                outcome: wire::owner_checked::Outcome::Succeeded as i32,
                ..wire::OwnerChecked::default()
            },
        ));
    }
}

fn saved(d: &Driver) -> wire::SaveFile {
    let Some(wire::effect::Kind::SaveFile(save)) = d
        .effects
        .last()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.clone())
    else {
        panic!("the save sheet was asked for");
    };
    save
}

/// A driver with a week of totals and one workout.
fn seeded() -> Driver {
    let d = driver();
    let day = today(&d);
    record(
        &d,
        &day,
        &[
            (1, "steps", 8_000.0),
            (2, "steps", 9_000.0),
            (1, "weight_kg", 71.5),
        ],
    );
    connect_store(&d);
    workout(
        &d,
        "run",
        "run",
        "2026-11-08T06:40:00.000Z",
        "2026-11-08T07:11:00.000Z",
    );
    d
}

fn send_row(d: &mut Driver, page: u64, key: &str) {
    d.effects.clear();
    d.send(
        page,
        wire::screen_event::Kind::Transfer(wire::TransferEvent {
            key: key.to_owned(),
        }),
    );
    pass_owner_check(d);
}

#[test]
fn health_lists_the_totals_the_workouts_and_each_metric_and_the_more_sheet_opens_it() {
    let mut d = seeded();
    let home = root(&d);
    home_event(
        &mut d,
        home,
        wire::health_home_event::Kind::ShowMore(Default::default()),
    );
    let more = home_state(d.view(home)).more_rows.clone();
    let row = more
        .iter()
        .find(|r| r.route.as_ref().is_some_and(|r| r.screen == health::EXPORT))
        .expect("an Export row in More");
    assert_eq!(row.label, "Export");
    let page = push(&mut d, row.route.clone().unwrap());
    let labels: Vec<&str> = state(d.view(page))
        .rows
        .iter()
        .map(|r| r.label.as_str())
        .collect();
    assert_eq!(
        labels,
        [
            "All daily totals",
            "All workouts",
            "Steps",
            "Sleep",
            "Active energy",
            "Exercise",
            "Resting heart rate",
            "Weight"
        ]
    );
}

#[test]
fn the_totals_are_saved_as_a_csv_through_the_os_save_sheet_after_the_owner_check() {
    let mut d = seeded();
    let entry = export::entry(Locale::En, health::EXPORT);
    let page = push(&mut d, entry.route);
    send_row(&mut d, page, "totals");
    let save = saved(&d);
    assert_eq!(save.name, "Daily totals.csv");
    assert_eq!(save.media_type, "text/csv");
    let text = String::from_utf8_lossy(&save.content);
    assert!(text.starts_with("Date,Metric,Value,Unit"), "{text}");
    assert_eq!(text.lines().count(), 4, "the header and three days: {text}");
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert!(
        state(d.view(page))
            .status
            .as_ref()
            .is_some_and(|s| s.sentence == "Export saved")
    );
}

#[test]
fn the_workouts_and_one_metric_are_their_own_files() {
    let mut d = seeded();
    let entry = export::entry(Locale::En, health::EXPORT);
    let page = push(&mut d, entry.route);
    send_row(&mut d, page, "workouts");
    let save = saved(&d);
    assert_eq!(save.name, "Workouts.csv");
    let text = String::from_utf8_lossy(&save.content);
    assert!(text.starts_with("Start,End,Type,Title,"), "{text}");
    assert_eq!(text.lines().count(), 2, "{text}");
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    send_row(&mut d, page, "weight_kg");
    let save = saved(&d);
    assert_eq!(save.name, "Weight by day.csv");
    let text = String::from_utf8_lossy(&save.content);
    assert_eq!(text.lines().count(), 2, "{text}");
    assert!(text.contains("weight_kg") && text.contains("71.5"));
}
