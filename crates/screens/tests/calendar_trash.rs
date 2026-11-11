//! CALENDAR ADOPTS THE UNIFORM TRASH RULE (#1185): an event moves to trash from its page with a
//! status line and Undo, leaves the grid, the agenda and the notification set, restores whole, is
//! deleted forever or emptied from the trash behind the kit's confirms, and the trash is reached
//! from the band's More sheet.
//!
//! Everything is seeded at one fixed instant (`Driver::with_runtime_at`), so no assertion turns on
//! the day the suite runs, and no assertion is on a duration: only on counts and values.

mod calendar_support;

use calendar_support::World;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda::notify::{Inputs, desired};
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::kit::civil;
use centraid_screens::strings::Locale;
use centraid_screens::{Registry, agenda, calendar};
use wire::agenda_event_event::Kind as K;
use wire::screen_event::Kind as E;
use wire::trash_event::{self as te, Kind as T};

/// Monday 9 November 2026, 09:00 UTC (and London): the vault's clock for every test here.
const NOW: i64 = 1_794_214_800_000;
const TODAY_LOCAL: &str = "2026-11-09T09:00";

fn world() -> World {
    World::seeded_with(
        Registry::default()
            .with(calendar::HOME, calendar::home::build)
            .with(calendar::TRASH, calendar::trash::build),
        NOW,
    )
}

/// A one-off review on Thursday 12 November, alerted 30 minutes before.
fn review(world: &mut World) -> String {
    world.propose(
        "Review",
        "2026-11-12T14:00:00",
        "2026-11-12T15:00:00",
        |p| p.reminders = Field::Is("[30]".to_owned()),
    )
}

fn action(key: &str) -> K {
    K::Action(wire::agenda_event_event::ActionPicked {
        key: key.to_owned(),
    })
}

fn undo() -> K {
    K::StatusActed(wire::agenda_event_event::StatusActed {})
}

fn in_window(world: &World, title: &str) -> Vec<wire::AgendaEvent> {
    world
        .window("2026-11-01T00:00:00Z", "2027-03-01T00:00:00Z")
        .into_iter()
        .filter(|event| event.summary.as_deref() == Some(title))
        .collect()
}

/// The alerts the notification service would ask the phone to hold for the window's events.
fn alerts(world: &World, title: &str) -> usize {
    let wire::app_query_response::Answer::AgendaUpcoming(upcoming) =
        world.load(centraid_screens::catalog::load::calendar::Upcoming {
            from: Some("2026-11-01T00:00:00Z".to_owned()),
            to: Some("2027-03-01T00:00:00Z".to_owned()),
        })
    else {
        panic!("upcoming answered something else");
    };
    desired(&Inputs {
        vault_id: "vault",
        zone: "Europe/London",
        locale: Locale::En,
        now_local: TODAY_LOCAL,
        tasks: &[],
        projects: &[],
        events: &upcoming.events,
        calendars: &upcoming.calendars,
    })
    .iter()
    .filter(|pending| pending.title == title)
    .count()
}

fn trash_page(world: &mut World) -> u64 {
    world.driver.push(agenda::TAB, calendar::routes::trash())
}

fn trash_view(world: &World, page: u64) -> &wire::TrashView {
    match &world.driver.view(page).kind {
        Some(wire::view_state::Kind::Trash(view)) => view,
        other => panic!("not the trash: {other:?}"),
    }
}

fn rows(world: &World, page: u64) -> Vec<wire::TrashRow> {
    let view = trash_view(world, page);
    match &view.content {
        Some(wire::trash_view::Content::Data(data)) => data.rows.clone(),
        // A trash with nothing in it is the empty page and carries no rows.
        None if matches!(
            view.page.as_ref().and_then(|page| page.state.as_ref()),
            Some(wire::page_state::State::Empty(_))
        ) =>
        {
            Vec::new()
        }
        other => panic!("the trash has no data: {other:?}"),
    }
}

fn send_trash(world: &mut World, page: u64, kind: T) {
    world
        .driver
        .send(page, E::Trash(wire::TrashEvent { kind: Some(kind) }));
}

#[test]
fn the_event_page_offers_move_to_trash_and_it_asks_nothing() {
    let mut world = world();
    let id = review(&mut world);
    let page = world.open_event(&id, &id, None, "2026-11-12");
    let keys: Vec<(&str, &str, bool)> = world
        .event_data(page)
        .actions
        .iter()
        .map(|a| (a.key.as_str(), a.label.as_str(), a.destructive))
        .collect();
    assert_eq!(
        keys,
        [
            ("edit", "Edit", false),
            ("cancel", "Cancel…", true),
            ("trash", "Move to trash", true)
        ]
    );
    world.send_event(page, action("trash"));
    assert!(
        world.event_state(page).confirm.is_none(),
        "Undo and the trash restore it, so nothing is asked"
    );
}

#[test]
fn moving_an_event_to_trash_says_so_with_undo_and_takes_it_off_the_calendar_and_out_of_the_alerts()
{
    let mut world = world();
    let id = review(&mut world);
    assert_eq!(in_window(&world, "Review").len(), 1);
    assert_eq!(alerts(&world, "Review"), 1, "alerted before it is trashed");
    let page = world.open_event(&id, &id, None, "2026-11-12");

    world.send_event(page, action("trash"));
    let status = world
        .event_state(page)
        .status
        .clone()
        .expect("a status line");
    assert_eq!(status.sentence, "Review moved to trash");
    assert_eq!(status.action_label, "Undo");
    assert!(!status.refused);
    // The page reads the event as gone and keeps the line over it.
    assert!(world.event_state(page).content.is_none());
    gone_of(&world.event_state(page).page);
    // Off the grid and the agenda, and silent.
    assert!(in_window(&world, "Review").is_empty());
    assert!(world.event_row(&id).is_none());
    assert_eq!(alerts(&world, "Review"), 0, "a trashed event never alerts");

    // It is in the trash, with the days the vault stamped: deleted today, erased 30 days on.
    let trash = trash_page(&mut world);
    let row = rows(&world, trash)
        .into_iter()
        .find(|row| row.id == id)
        .expect("the event is in the trash");
    assert_eq!(row.title, "Review");
    let (today, _) = world.today();
    let erased = civil::plus_days(&today, 30).expect("a day");
    assert_eq!(
        row.meta,
        format!(
            "Deleted {} · Erased {}",
            civil::day_month(Locale::En, &today),
            civil::day_month(Locale::En, &erased)
        )
    );
    assert_eq!(row.restore_label, "Restore");
    assert_eq!(row.purge_label, "Delete forever");
    assert_eq!(row.icon_key, "Calendar");
}

#[test]
fn undo_puts_the_event_back_and_says_undone() {
    let mut world = world();
    let id = review(&mut world);
    let page = world.open_event(&id, &id, None, "2026-11-12");
    world.send_event(page, action("trash"));

    world.send_event(page, undo());
    let status = world
        .event_state(page)
        .status
        .clone()
        .expect("a status line");
    // The kit's one Undo line (#1185): "Undone", with nothing more to tap.
    assert_eq!(status.sentence, "Undone");
    assert_eq!(status.action_label, "");
    assert_eq!(world.event_data(page).title, "Review");
    assert_eq!(in_window(&world, "Review").len(), 1);
    assert_eq!(alerts(&world, "Review"), 1, "alerted again once restored");

    // Nothing is on offer any more: a second tap changes nothing.
    world.send_event(page, undo());
    assert_eq!(in_window(&world, "Review").len(), 1);
}

#[test]
fn trash_applies_to_the_whole_event_so_a_series_leaves_and_returns_with_every_occurrence() {
    let mut world = world();
    let id = world.propose(
        "Standup",
        "2026-11-10T10:00:00",
        "2026-11-10T10:30:00",
        |p| p.rule = Field::Is("FREQ=WEEKLY;BYDAY=TU".to_owned()),
    );
    let before = in_window(&world, "Standup").len();
    assert!(before > 3, "a weekly series shows many occurrences");

    // From the THIRD occurrence's page: the whole event goes, not that occurrence.
    let key = format!("{id}:2026-11-24T10:00:00");
    let page = world.open_event(&id, &key, Some("2026-11-24T10:00:00"), "2026-11-24");
    world.send_event(page, action("trash"));
    assert!(
        in_window(&world, "Standup").is_empty(),
        "every occurrence left, not only the one opened"
    );

    // One trash row for the one event, and one restore brings every occurrence back.
    let trash = trash_page(&mut world);
    let mine: Vec<_> = rows(&world, trash)
        .into_iter()
        .filter(|row| row.title == "Standup")
        .collect();
    assert_eq!(mine.len(), 1, "a series is one entry");
    send_trash(&mut world, trash, T::Restore(te::RestoreTapped { id }));
    assert_eq!(in_window(&world, "Standup").len(), before);
    assert_eq!(
        trash_view(&world, trash).status.as_ref().unwrap().sentence,
        "Standup restored"
    );
}

#[test]
fn the_trash_deletes_forever_and_empties_in_the_shared_words() {
    let mut world = world();
    let first = review(&mut world);
    let second = world.propose(
        "Dentist",
        "2026-11-13T09:00:00",
        "2026-11-13T10:00:00",
        |_| {},
    );
    world.act(act::calendar::TrashEvent {
        event_id: first.clone(),
    });
    world.act(act::calendar::TrashEvent {
        event_id: second.clone(),
    });
    let trash = trash_page(&mut world);
    let view = trash_view(&world, trash);
    assert_eq!(view.title, "Trash");
    assert_eq!(view.back_label, "Calendar");
    let Some(wire::trash_view::Content::Data(data)) = &view.content else {
        panic!("no data");
    };
    assert_eq!(data.empty_label, "Empty trash");
    assert!(
        data.count_label.starts_with("Trash · "),
        "{}",
        data.count_label
    );

    // Delete forever asks first, in the kit's sentences with the noun, and writes only when confirmed.
    send_trash(
        &mut world,
        trash,
        T::Purge(te::PurgeTapped { id: first.clone() }),
    );
    let confirm = trash_view(&world, trash)
        .confirm
        .clone()
        .expect("a confirm");
    assert_eq!(confirm.title, "Delete this event forever?");
    assert_eq!(
        confirm.body,
        "It leaves this vault for good. This cannot be undone."
    );
    assert_eq!(confirm.confirm_label, "Delete forever");
    assert!(confirm.destructive);
    send_trash(&mut world, trash, T::Dismissed(te::Dismissed {}));
    assert!(rows(&world, trash).iter().any(|row| row.id == first));
    send_trash(
        &mut world,
        trash,
        T::Purge(te::PurgeTapped { id: first.clone() }),
    );
    send_trash(&mut world, trash, T::Confirmed(te::Confirmed {}));
    assert!(!rows(&world, trash).iter().any(|row| row.id == first));
    // Gone for good.
    assert!(world.event_row(&first).is_none());

    // Empty trash asks too, and removes everything that is left.
    send_trash(&mut world, trash, T::Empty(te::EmptyTapped {}));
    let confirm = trash_view(&world, trash)
        .confirm
        .clone()
        .expect("a confirm");
    assert_eq!(confirm.title, "Empty trash?");
    assert_eq!(
        confirm.body,
        "Everything in trash leaves this vault for good. This cannot be undone."
    );
    assert_eq!(confirm.confirm_label, "Empty trash");
    send_trash(&mut world, trash, T::Confirmed(te::Confirmed {}));
    assert!(rows(&world, trash).is_empty());
    assert!(world.event_row(&second).is_none());
    // A trash with nothing in it is the page's own empty state.
    let view = trash_view(&world, trash);
    assert!(view.content.is_none());
    let Some(wire::page_state::State::Empty(empty)) =
        view.page.as_ref().and_then(|page| page.state.as_ref())
    else {
        panic!("an empty trash is an empty page");
    };
    assert_eq!(empty.headline, "Trash is empty.");
    assert_eq!(
        empty.body,
        "Deleted items wait here for 30 days, then they are erased."
    );
}

#[test]
fn the_bands_more_sheet_holds_the_trash_and_the_calendars_sheet_keeps_its_calendars() {
    let mut world = world();
    let home = world.driver.push(agenda::TAB, agenda_home());
    let band = |world: &World| -> Vec<(String, bool)> {
        home_state(world, home)
            .band
            .iter()
            .map(|tab| (tab.key.clone(), tab.current))
            .collect()
    };
    let keys: Vec<String> = band(&world).into_iter().map(|(key, _)| key).collect();
    assert_eq!(keys, ["calendar", "more", "invites", "menu"]);
    let labels: Vec<String> = home_state(&world, home)
        .band
        .iter()
        .map(|tab| tab.label.clone())
        .collect();
    assert_eq!(labels, ["Calendar", "Calendars", "Invites", "More"]);

    pick_band(&mut world, home, "menu");
    let state = home_state(&world, home);
    assert_eq!(state.sheet, wire::agenda_home_state::Sheet::More as i32);
    assert_eq!(state.chrome.as_ref().unwrap().more_title, "Calendar");
    assert_eq!(state.more_rows.len(), 2);
    assert_eq!(
        (
            state.more_rows[0].label.as_str(),
            state.more_rows[0].icon_key.as_str()
        ),
        ("Export", "Upload")
    );
    assert_eq!(
        state.more_rows[0].route.as_ref().unwrap().screen,
        "calendar.export"
    );
    let row = &state.more_rows[1];
    assert_eq!(
        (
            row.key.as_str(),
            row.label.as_str(),
            row.meta.as_str(),
            row.icon_key.as_str()
        ),
        ("trash", "Trash", "30 days, then erased", "Trash")
    );
    assert_eq!(row.route.as_ref().unwrap().screen, "calendar.trash");
    assert_eq!(
        band(&world),
        [
            ("calendar".to_owned(), false),
            ("more".to_owned(), false),
            ("invites".to_owned(), false),
            ("menu".to_owned(), true)
        ]
    );

    // The Calendars tab still opens the calendars, under its own title.
    pick_band(&mut world, home, "more");
    let state = home_state(&world, home);
    assert_eq!(state.chrome.as_ref().unwrap().more_title, "Calendars");
    assert!(state.more_rows.iter().any(|row| row.toggle));
    assert!(state.more_rows.iter().all(|row| row.key != "trash"));
}

fn agenda_home() -> wire::Route {
    wire::Route {
        sheet: false,
        screen: calendar::HOME.to_owned(),
        args: Some(wire::route::Args::AgendaHome(wire::AgendaHomeRoute {
            destination: wire::AgendaDestination::Month as i32,
            quick_add_title: String::new(),
            open_quick_add: false,
        })),
    }
}

fn home_state(world: &World, home: u64) -> &wire::AgendaHomeState {
    match &world.driver.view(home).kind {
        Some(wire::view_state::Kind::AgendaHome(state)) => state,
        other => panic!("not Calendar's home: {other:?}"),
    }
}

fn pick_band(world: &mut World, home: u64, key: &str) {
    world.driver.send(
        home,
        E::AgendaHome(wire::AgendaHomeEvent {
            kind: Some(wire::agenda_home_event::Kind::Band(
                wire::agenda_home_event::BandPicked {
                    key: key.to_owned(),
                },
            )),
        }),
    );
}

/// The page's final failure (an occurrence that is gone), or a panic naming the page.
fn gone_of(page: &Option<wire::PageState>) -> &wire::Failure {
    match page.as_ref().and_then(|page| page.state.as_ref()) {
        Some(wire::page_state::State::Failed(failure)) if failure.permanent => failure,
        _ => panic!("not a final failure: {page:?}"),
    }
}
