//! People's home through the door a shell uses: the roster with its chips, order
//! and star; search; Touch; More. Ports the Home cases of `PeopleSpec` over a real
//! vault. Every sentence is Rust's, so the views are asserted as finished words.

mod people_support;

use std::time::{SystemTime, UNIX_EPOCH};

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::kit::civil;
use centraid_screens::people::routes;
use people_support::*;
use wire::app_query_response::Answer;
use wire::people_home_event::{self as ev, Kind as H};

fn today() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("a clock")
        .as_secs();
    civil::civil_day_of(i64::try_from(secs / 86_400).expect("days"))
}

/// The `MM-DD` of `days` from today.
fn month_day_in(days: i64) -> String {
    civil::plus_days(&today(), days).expect("a day")[5..].to_owned()
}

#[test]
fn the_root_is_the_roster_under_a_band_with_one_chip_row() {
    let mut d = clean();
    person(&d, "Dana Reyes");
    person(&d, "Sam");
    let i = begin(&mut d);
    let state = home_state(d.view(i));
    assert_eq!(state.title, "People");
    assert_eq!(
        state.band.iter().map(|t| t.key.as_str()).collect::<Vec<_>>(),
        ["people", "touch", "more"]
    );
    assert!(state.band.iter().find(|t| t.key == "people").unwrap().current);
    let chips: Vec<(&str, u32)> = state
        .chips
        .iter()
        .map(|chip| (chip.label.as_str(), chip.count))
        .collect();
    assert_eq!(chips, [("All", 2), ("Starred", 0), ("Overdue", 0)]);
    assert!(state.chips[0].selected);
    let sort = state.sort_chip.as_ref().expect("the sort chip");
    assert_eq!(sort.label, "Recently added");
    assert_eq!(sort.spoken, "Sort, Recently added");
    let data = roster_data(d.view(i));
    assert_eq!(data.status_line, "2 people · 0 to reconnect · 0 starred");
    // A person who was never touched says so; the row opens their page.
    let dana = data.rows.iter().find(|r| r.name == "Dana Reyes").unwrap();
    assert_eq!(dana.meta, "No touch logged yet");
    assert_eq!(dana.avatar.as_ref().unwrap().initials, "DR");
    assert!(dana.avatar.as_ref().unwrap().hue_key.starts_with('c'));
    assert_eq!(dana.star_label, "Star Dana Reyes");
    assert_eq!(dana.route, Some(routes::person(&dana.party_id, "Dana Reyes", false)));
    assert_eq!(state.add_person, Some(routes::new_person()));
}

#[test]
fn an_order_is_the_reads_and_a_pick_closes_the_sheet_and_renames_the_chip() {
    let mut d = clean();
    person(&d, "Zed");
    person(&d, "Ana");
    person(&d, "Mia");
    let i = begin(&mut d);
    send_home(
        &mut d,
        i,
        H::SheetOpened(ev::SheetOpened {
            sheet: wire::people_home_state::Sheet::Order as i32,
        }),
    );
    let sheet = home_state(d.view(i));
    assert_eq!(sheet.sheet, wire::people_home_state::Sheet::Order as i32);
    assert_eq!(
        sheet
            .order_choices
            .iter()
            .map(|c| c.label.as_str())
            .collect::<Vec<_>>(),
        ["Recently added", "Name"]
    );
    send_home(
        &mut d,
        i,
        H::Order(ev::OrderPicked {
            order: wire::PeopleOrder::Name as i32,
        }),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.sheet, wire::people_home_state::Sheet::None as i32);
    assert_eq!(state.sort_chip.as_ref().unwrap().label, "Name");
    assert_eq!(names(roster_data(d.view(i))), ["Ana", "Mia", "Zed"]);
    // The same order again is nothing.
    send_home(
        &mut d,
        i,
        H::Order(ev::OrderPicked {
            order: wire::PeopleOrder::Name as i32,
        }),
    );
    assert_eq!(names(roster_data(d.view(i))), ["Ana", "Mia", "Zed"]);
}

#[test]
fn the_star_is_a_write_from_the_row_and_the_starred_chip_filters() {
    let mut d = clean();
    let dana = person(&d, "Dana");
    person(&d, "Sam");
    let i = begin(&mut d);
    send_home(&mut d, i, H::Star(ev::StarToggled { party_id: dana.clone() }));
    let state = home_state(d.view(i));
    let status = state.status.as_ref().expect("a status");
    assert_eq!(status.sentence, "Dana starred");
    assert!(!status.refused);
    let row = roster_data(d.view(i))
        .rows
        .iter()
        .find(|r| r.party_id == dana)
        .unwrap();
    assert!(row.starred);
    assert_eq!(row.star_label, "Remove star from Dana");
    assert_eq!(row.accessibility_label, "Dana, starred");
    assert_eq!(state.chips[1].count, 1);

    send_home(
        &mut d,
        i,
        H::Chip(ev::ChipPicked {
            chip: wire::PeopleChipKey::Starred as i32,
        }),
    );
    assert_eq!(names(roster_data(d.view(i))), ["Dana"]);
    assert!(home_state(d.view(i)).chips[1].selected);

    send_home(&mut d, i, H::Star(ev::StarToggled { party_id: dana }));
    let state = home_state(d.view(i));
    assert_eq!(state.status.as_ref().unwrap().sentence, "Star removed · Dana");
    // Nobody is starred now, and that is the chip's own sentence, not day one's.
    let empty = roster_data(d.view(i)).empty.clone().expect("an empty state");
    assert_eq!(empty.headline, "Nobody is starred.");
    assert_eq!(empty.action_label, "");
    assert_eq!(empty.import_source, wire::ImportSource::Unspecified as i32);
}

#[test]
fn a_chip_with_nobody_says_so_and_day_one_offers_the_phones_contacts() {
    let mut d = clean();
    let i = begin(&mut d);
    // Day one: nobody at all.
    let empty = roster_data(d.view(i)).empty.clone().expect("day one");
    assert_eq!(empty.headline, "Add people you keep up with");
    assert_eq!(empty.action_label, "Add person");
    assert_eq!(empty.import_source, wire::ImportSource::Contacts as i32);

    person(&d, "Dana");
    refresh(&mut d, i);
    send_home(
        &mut d,
        i,
        H::Chip(ev::ChipPicked {
            chip: wire::PeopleChipKey::Due as i32,
        }),
    );
    let empty = roster_data(d.view(i)).empty.clone().expect("a chip's own");
    assert_eq!(empty.headline, "Nobody is overdue.");
}

#[test]
fn a_touch_is_counted_in_the_members_days_on_the_row() {
    let mut d = clean();
    let dana = person(&d, "Dana");
    let i = begin(&mut d);
    assert_eq!(roster_data(d.view(i)).rows[0].meta, "No touch logged yet");
    arrange(
        &d,
        act::people::LogInteraction {
            person_id: dana,
            kind: "call".to_owned(),
            text: None,
        },
    );
    d.pump(std::time::Duration::from_millis(300));
    assert_eq!(roster_data(d.view(i)).rows[0].meta, "Last touch today");
}

#[test]
fn a_birthday_within_a_month_is_a_chip_on_the_row() {
    let mut d = clean();
    arrange(
        &d,
        act::people::AddPerson {
            title: "Ana".to_owned(),
            birthday: Some(month_day_in(3)),
            ..Default::default()
        },
    );
    let i = begin(&mut d);
    let chips: Vec<String> = roster_data(d.view(i)).rows[0]
        .chips
        .iter()
        .map(|c| c.label.clone())
        .collect();
    assert_eq!(chips, ["Birthday · in 3 days"]);
}

#[test]
fn search_is_a_field_over_the_roster_names_only_and_closing_clears_it() {
    let mut d = clean();
    person(&d, "Dana Reyes");
    person(&d, "Sam");
    let i = begin(&mut d);
    send_home(&mut d, i, H::SearchOpened(ev::SearchOpened {}));
    // Open, with no term: the roster stands and no chip narrows a name.
    let state = home_state(d.view(i));
    assert!(state.search.as_ref().unwrap().open);
    assert!(state.chips.is_empty());
    assert!(state.sort_chip.is_none());

    send_home(&mut d, i, H::SearchTerm(ev::SearchTermChanged { term: "dan".into() }));
    let state = home_state(d.view(i));
    let results = state
        .search
        .as_ref()
        .unwrap()
        .results
        .as_ref()
        .expect("results");
    assert_eq!(
        results.rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
        ["Dana Reyes"]
    );
    // Ask is the row at the foot of an answer, scoped to People.
    let ask = state.search.as_ref().unwrap().ask.as_ref().expect("Ask");
    assert_eq!(ask.scope, "people");
    assert_eq!(ask.question, "Find dan");
    // The roster stands under it.
    assert_eq!(roster_data(d.view(i)).rows.len(), 2);

    send_home(&mut d, i, H::SearchTerm(ev::SearchTermChanged { term: "zzqx".into() }));
    let none = home_state(d.view(i))
        .search
        .as_ref()
        .unwrap()
        .results
        .clone()
        .unwrap();
    assert_eq!(none.empty.unwrap().headline, "Nothing matches.");

    send_home(&mut d, i, H::SearchClosed(ev::SearchClosed {}));
    let state = home_state(d.view(i));
    let search = state.search.as_ref().unwrap();
    assert!(!search.open);
    assert_eq!(search.term, "");
    assert!(search.results.is_none());
    assert_eq!(state.chips.len(), 3);
}

#[test]
fn more_holds_trash_alone_and_is_an_ordinary_band_tab_last() {
    let mut d = clean();
    person(&d, "Dana");
    let i = begin(&mut d);
    let landed = home_state(d.view(i));
    let last = landed.band.last().unwrap();
    assert_eq!((last.key.as_str(), last.icon_key.as_str()), ("more", "MoreHoriz"));
    send_home(&mut d, i, H::Band(ev::BandPicked { key: "more".into() }));
    let more = home_state(d.view(i));
    assert_eq!(more.sheet, wire::people_home_state::Sheet::More as i32);
    assert_eq!(more.more_rows.len(), 1);
    assert_eq!(more.more_rows[0].label, "Trash");
    assert_eq!(more.more_rows[0].route, Some(routes::trash()));
    send_home(&mut d, i, H::SheetClosed(ev::SheetClosed {}));
    assert_eq!(
        home_state(d.view(i)).sheet,
        wire::people_home_state::Sheet::None as i32
    );
}

#[test]
fn touch_is_tiles_rails_and_the_band_swaps_it_without_a_stack_entry() {
    let mut d = clean();
    let dana = person(&d, "Dana");
    arrange(
        &d,
        act::people::LogInteraction {
            person_id: dana.clone(),
            kind: "visit".to_owned(),
            text: Some("Coffee".to_owned()),
        },
    );
    let i = begin(&mut d);
    let depth = |d: &centraid_screens::testing::Driver| {
        d.navigation.as_ref().unwrap().tabs[0].entries.len()
    };
    let before = depth(&d);
    send_home(&mut d, i, H::Band(ev::BandPicked { key: "touch".into() }));
    assert_eq!(depth(&d), before);
    let state = home_state(d.view(i));
    assert_eq!(state.destination, wire::PeopleDestination::Touch as i32);
    // Touch filters nothing: no chip row.
    assert!(state.chips.is_empty() && state.sort_chip.is_none());
    let touch = touch_data(d.view(i));
    let tiles: Vec<(&str, u32, bool)> = touch
        .tiles
        .iter()
        .map(|t| (t.label.as_str(), t.count, t.tappable))
        .collect();
    // A FIGURE, NOT A DEAD CONTROL: v0's Upcoming tile did nothing.
    assert_eq!(
        tiles,
        [
            ("People", 1, true),
            ("Reconnect", 0, true),
            ("Upcoming", 0, false),
            ("Starred", 0, true)
        ]
    );
    assert!(touch.tiles.iter().find(|t| t.key == "reconnect").unwrap().net);
    assert_eq!(touch.reconnect_empty, "Nobody is overdue.");
    assert_eq!(touch.upcoming_empty, "No dates coming up.");
    // BOTH SPELLINGS OF A KIND are one noun: `visit` is "Met up".
    let recent = &touch.recent[0];
    assert_eq!((recent.kind_label.as_str(), recent.when_label.as_str()), ("Met up", "Today"));
    assert_eq!(recent.text, "Coffee");
    assert_eq!(recent.route, Some(routes::person(&dana, "Dana", false)));
    assert_eq!(touch.status_line, "1 person · 0 overdue");

    // The same tab is nothing; a tile lands on People under its chip.
    send_home(&mut d, i, H::Band(ev::BandPicked { key: "touch".into() }));
    assert_eq!(
        home_state(d.view(i)).destination,
        wire::PeopleDestination::Touch as i32
    );
    send_home(&mut d, i, H::Tile(ev::TilePicked { key: "upcoming".into() }));
    assert_eq!(
        home_state(d.view(i)).destination,
        wire::PeopleDestination::Touch as i32
    );
    send_home(&mut d, i, H::Tile(ev::TilePicked { key: "reconnect".into() }));
    let state = home_state(d.view(i));
    assert_eq!(state.destination, wire::PeopleDestination::People as i32);
    assert!(state.chips.iter().find(|c| c.label == "Overdue").unwrap().selected);
}

#[test]
fn touch_on_an_empty_vault_is_day_one() {
    let mut d = clean();
    let i = open_home(&mut d, wire::PeopleDestination::Touch);
    let touch = touch_data(d.view(i));
    assert_eq!(touch.empty.as_ref().unwrap().action_label, "Add person");
}

/// A LEAP-DAY BIRTHDAY FALLS ON THE 28TH IN A COMMON YEAR, on Touch's rail: the day shown is
/// the core's `today + in_days`, never the stored `MM-DD` that year lacks.
#[test]
fn a_leap_day_birthday_is_shown_on_the_day_it_falls_on() {
    let mut d = clean();
    arrange(
        &d,
        act::people::AddPerson {
            title: "Leap".to_owned(),
            birthday: Some("02-29".to_owned()),
            ..Default::default()
        },
    );
    let Answer::PeopleTouch(dashboard) = answer(&d, load::people::Dashboard::default()) else {
        panic!("the dashboard answers");
    };
    let row = &dashboard.upcoming[0];
    let in_days = row.date.as_ref().unwrap().in_days.expect("placed");
    let falls = civil::plus_days(&dashboard.today, in_days).unwrap();
    let i = open_home(&mut d, wire::PeopleDestination::Touch);
    let shown = touch_data(d.view(i)).upcoming[0].day_label.clone();
    let year: i64 = falls[..4].parse().unwrap();
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let day = if leap { "29" } else { "28" };
    assert_eq!(shown, format!("{day} February"), "falls on {falls}");
}
