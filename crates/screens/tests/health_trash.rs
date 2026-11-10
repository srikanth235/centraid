//! HEALTH ADOPTS THE UNIFORM TRASH RULE (#1185): a workout moves to trash from its page with a
//! status line and Undo, leaves every list that read it, restores whole, is deleted forever or
//! emptied from the trash behind the kit's confirms, a workout the health store states is the
//! member's to trash like any other and is not brought back by the store's next read, and the trash
//! is reached from More.
//!
//! Everything is seeded at one fixed instant (`Driver::with_runtime_at`), so no assertion turns on
//! the day the suite runs, and no assertion is on a duration: only on counts and values.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::health::{self, routes};
use centraid_screens::kit::civil;
use centraid_screens::strings::Locale;
use centraid_screens::testing::Driver;
use health_support::*;
use wire::app_query_response::Answer;
use wire::health_home_event as he;
use wire::health_workout_event as we;
use wire::screen_event::Kind as E;
use wire::trash_event::{self as te, Kind as T};

/// Monday 9 November 2026, 09:00 UTC: the vault's clock for every test here.
const NOW: i64 = 1_794_214_800_000;

fn seeded() -> Driver {
    let mut driver = Driver::with_runtime_at(health::runtime(), NOW);
    driver.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: "en-GB".to_owned(),
        zone: "Europe/Berlin".to_owned(),
        platform: "ios".to_owned(),
        ..Default::default()
    }));
    driver.start();
    driver
}

/// A followed morning run on Sunday 8 November (07:40 in Berlin) and an evening ride on the 4th.
fn two_followed(d: &Driver) {
    connect_store(d);
    workout(
        d,
        "run",
        "run",
        "2026-11-08T06:40:00.000Z",
        "2026-11-08T07:11:00.000Z",
    );
    workout(
        d,
        "ride",
        "cycle",
        "2026-11-04T17:00:00.000Z",
        "2026-11-04T18:00:00.000Z",
    );
}

fn listed(d: &Driver) -> Vec<(String, String)> {
    match answer(
        d,
        load::health::Workouts {
            limit: 50,
            ..Default::default()
        },
    ) {
        Answer::HealthWorkouts(found) => found
            .workouts
            .into_iter()
            .map(|w| (w.activity_id, w.kind_key))
            .collect(),
        other => panic!("workouts answered {other:?}"),
    }
}

fn id_of(d: &Driver, kind: &str) -> String {
    listed(d)
        .into_iter()
        .find(|(_, k)| k == kind)
        .map(|(id, _)| id)
        .unwrap_or_else(|| panic!("no {kind} workout"))
}

fn page_event(d: &mut Driver, page: u64, kind: we::Kind) {
    d.send(
        page,
        E::HealthWorkout(wire::HealthWorkoutEvent { kind: Some(kind) }),
    );
}

fn trash_it(d: &mut Driver, page: u64) {
    page_event(d, page, we::Kind::Trash(we::TrashTapped {}));
}

fn undo(d: &mut Driver, page: u64) {
    page_event(d, page, we::Kind::StatusActed(we::StatusActed {}));
}

fn status(d: &Driver, page: u64) -> Option<wire::StatusLine> {
    workout_state(d.view(page)).status.clone()
}

fn trash_view(d: &Driver, page: u64) -> &wire::TrashView {
    match &d.view(page).kind {
        Some(wire::view_state::Kind::Trash(view)) => view,
        other => panic!("not the trash: {other:?}"),
    }
}

fn rows(d: &Driver, page: u64) -> Vec<wire::TrashRow> {
    match &trash_view(d, page).content {
        Some(wire::trash_view::Content::Data(data)) => data.rows.clone(),
        other => panic!("the trash has no data: {other:?}"),
    }
}

fn send_trash(d: &mut Driver, page: u64, kind: T) {
    d.send(page, E::Trash(wire::TrashEvent { kind: Some(kind) }));
}

fn trashed(d: &Driver) -> Vec<wire::HealthTrashRow> {
    match answer(d, load::health::Trash {}) {
        Answer::HealthTrash(shelf) => shelf.workouts,
        other => panic!("trash answered {other:?}"),
    }
}

#[test]
fn the_workout_page_offers_move_to_trash_and_it_asks_nothing() {
    let mut d = seeded();
    two_followed(&d);
    let run = id_of(&d, "run");
    let page = push(&mut d, routes::workout(&run, "Health"));
    let Some(wire::health_workout_state::Content::Data(data)) =
        &workout_state(d.view(page)).content
    else {
        panic!("no data");
    };
    assert_eq!(data.trash_label, "Move to trash");
    trash_it(&mut d, page);
    // No confirm exists on this page: the line says what happened and Undo reverses it.
    assert!(status(&d, page).is_some());
}

#[test]
fn moving_a_workout_to_trash_says_so_with_undo_and_takes_it_out_of_the_lists() {
    let mut d = seeded();
    two_followed(&d);
    let (run, ride) = (id_of(&d, "run"), id_of(&d, "cycle"));
    let page = push(&mut d, routes::workout(&run, "Health"));
    assert_eq!(listed(&d).len(), 2);

    trash_it(&mut d, page);
    let line = status(&d, page).expect("a status line");
    assert_eq!(line.sentence, "Morning run moved to trash");
    assert_eq!(line.action_label, "Undo");
    assert!(!line.refused);
    // The page reads the workout as gone and keeps the line over it.
    let Some(wire::health_workout_state::Content::Data(data)) =
        &workout_state(d.view(page)).content
    else {
        panic!("no data");
    };
    assert!(data.gone.is_some());
    assert!(data.trash_label.is_empty());
    // Off the list, and still there for the other.
    assert_eq!(listed(&d), [(ride, "cycle".to_owned())]);

    // In the trash, with the days the vault stamped: deleted today, erased 30 days on.
    let shelf = push(&mut d, routes::trash());
    let found = rows(&d, shelf);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, run);
    assert_eq!(found[0].title, "Morning run");
    // Deleted on the vault clock's day in the member's zone, erased 30 days on.
    let today = today(&d);
    let erased = civil::plus_days(&today, 30).expect("a day");
    assert_eq!(
        found[0].meta,
        format!(
            "Deleted {} · Erased {}",
            civil::day_month(Locale::En, &today),
            civil::day_month(Locale::En, &erased)
        )
    );
    assert_eq!(trash_view(&d, shelf).title, "Trash");
    assert_eq!(trash_view(&d, shelf).back_label, "Health");
}

#[test]
fn undo_restores_it_and_undo_of_the_restore_trashes_it_again() {
    let mut d = seeded();
    two_followed(&d);
    let run = id_of(&d, "run");
    let page = push(&mut d, routes::workout(&run, "Health"));
    trash_it(&mut d, page);
    assert_eq!(listed(&d).len(), 1);

    undo(&mut d, page);
    let line = status(&d, page).expect("a status line");
    assert_eq!(line.sentence, "Morning run restored");
    assert_eq!(line.action_label, "Undo");
    assert_eq!(listed(&d).len(), 2, "back exactly where it was");
    assert!(trashed(&d).is_empty());
    let Some(wire::health_workout_state::Content::Data(data)) =
        &workout_state(d.view(page)).content
    else {
        panic!("no data");
    };
    assert!(data.gone.is_none());
    assert_eq!(data.figures[0].value, "5.2");

    undo(&mut d, page);
    assert_eq!(
        status(&d, page).unwrap().sentence,
        "Morning run moved to trash"
    );
    assert_eq!(listed(&d).len(), 1);
}

#[test]
fn a_hand_logged_workout_goes_the_same_way_and_a_figure_does_not_make_a_workout() {
    let mut d = seeded();
    arrange(
        &d,
        act::health::LogWorkout {
            starts: "2026-11-07T16:00:00.000Z".to_owned(),
            r#type: Some("walk".to_owned()),
            ..Default::default()
        },
    );
    let id = id_of(&d, "walk");
    let page = push(&mut d, routes::workout(&id, "Health"));
    trash_it(&mut d, page);
    assert!(listed(&d).is_empty());
    let shelf = trashed(&d);
    assert_eq!(shelf.len(), 1);
    assert_eq!(shelf[0].activity_id, id);
    assert_eq!(shelf[0].kind_key, "walk");
}

/// The member's trash stands: the store states the workout again and the next pass leaves it where
/// the member put it, and does not add it a second time.
#[test]
fn a_followed_workout_the_member_trashed_stays_trashed_when_the_store_reads_it_again() {
    let mut d = seeded();
    two_followed(&d);
    let run = id_of(&d, "run");
    let page = push(&mut d, routes::workout(&run, "Health"));
    trash_it(&mut d, page);
    assert_eq!(listed(&d).len(), 1);

    // The next pass: the same records, stated again.
    workout(
        &d,
        "run",
        "run",
        "2026-11-08T06:40:00.000Z",
        "2026-11-08T07:11:00.000Z",
    );
    assert_eq!(listed(&d).len(), 1, "the store did not bring it back");
    assert_eq!(trashed(&d).len(), 1);
    // The member's restore is theirs: Undo still brings it back.
    undo(&mut d, page);
    assert_eq!(listed(&d).len(), 2);
}

#[test]
fn the_trash_deletes_forever_and_empties_in_the_shared_words() {
    let mut d = seeded();
    two_followed(&d);
    let (run, ride) = (id_of(&d, "run"), id_of(&d, "cycle"));
    for id in [&run, &ride] {
        arrange(
            &d,
            act::health::DeleteWorkout {
                workout_id: id.clone(),
            },
        );
    }
    let shelf = push(&mut d, routes::trash());
    let view = trash_view(&d, shelf);
    let Some(wire::trash_view::Content::Data(data)) = &view.content else {
        panic!("no data");
    };
    assert_eq!(data.empty_label, "Empty trash");
    assert_eq!(data.count_label, "Trash · 2");
    let titles: Vec<&str> = data.rows.iter().map(|row| row.title.as_str()).collect();
    assert_eq!(titles.len(), 2);

    // Delete forever asks first, in the kit's sentences with the noun, and writes only when confirmed.
    send_trash(&mut d, shelf, T::Purge(te::PurgeTapped { id: run.clone() }));
    let confirm = trash_view(&d, shelf).confirm.clone().expect("a confirm");
    assert_eq!(confirm.title, "Delete this workout forever?");
    assert_eq!(
        confirm.body,
        "It leaves this vault for good. This cannot be undone."
    );
    assert_eq!(confirm.confirm_label, "Delete forever");
    assert!(confirm.destructive);
    send_trash(&mut d, shelf, T::Dismissed(te::Dismissed {}));
    assert_eq!(trashed(&d).len(), 2, "nothing was written");
    send_trash(&mut d, shelf, T::Purge(te::PurgeTapped { id: run.clone() }));
    send_trash(&mut d, shelf, T::Confirmed(te::Confirmed {}));
    assert_eq!(trashed(&d).len(), 1);
    assert!(rows(&d, shelf).iter().all(|row| row.id != run));

    // The store states the purged workout again: it is not revived (a tombstone remembers it).
    workout(
        &d,
        "run",
        "run",
        "2026-11-08T06:40:00.000Z",
        "2026-11-08T07:11:00.000Z",
    );
    assert!(listed(&d).iter().all(|(id, _)| *id != run));
    assert_eq!(
        listed(&d).len(),
        0,
        "the purged run is gone, the ride is in the trash"
    );

    // Empty trash asks too, and removes everything that is left.
    send_trash(&mut d, shelf, T::Empty(te::EmptyTapped {}));
    let confirm = trash_view(&d, shelf).confirm.clone().expect("a confirm");
    assert_eq!(confirm.title, "Empty trash?");
    assert_eq!(confirm.confirm_label, "Empty trash");
    send_trash(&mut d, shelf, T::Confirmed(te::Confirmed {}));
    assert!(trashed(&d).is_empty());
    assert!(rows(&d, shelf).is_empty());
    assert!(listed(&d).is_empty());
}

#[test]
fn more_holds_the_trash_between_the_reads_and_the_stop() {
    let mut d = seeded();
    two_followed(&d);
    let home = root(&d);
    home_event(&mut d, home, he::Kind::ShowMore(he::ShowMore {}));
    let state = home_state(d.view(home));
    let keys: Vec<&str> = state.more_rows.iter().map(|row| row.key.as_str()).collect();
    assert_eq!(keys, ["reads", "choose", "trash", "stop"]);
    let row = &state.more_rows[2];
    assert_eq!(
        (row.label.as_str(), row.meta.as_str(), row.icon_key.as_str()),
        ("Trash", "30 days, then erased", "Trash")
    );
    assert_eq!(row.route.as_ref().unwrap().screen, "health.trash");
}
