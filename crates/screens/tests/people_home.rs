//! People's home through the door a shell uses: the roster with its filter menu
//! (filters, counts and order) and star; search; Touch; More. Ports the Home cases of `PeopleSpec` over a real
//! vault. Every sentence is Rust's, so the views are asserted as finished words.

mod people_support;

use std::time::{SystemTime, UNIX_EPOCH};

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::kit::{civil, menu};
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

fn pick(section: &str, option: &str) -> H {
    H::FilterMenuPicked(wire::FilterMenuPicked {
        section_key: section.to_owned(),
        option_key: option.to_owned(),
    })
}

fn menu_of(d: &centraid_screens::testing::Driver, i: u64) -> wire::FilterMenu {
    home_state(d.view(i))
        .filter_menu
        .clone()
        .expect("the filter menu")
}

/// The labels and counts of a section's options.
fn shown(section: &wire::MenuSection) -> Vec<(&str, u32)> {
    section
        .options
        .iter()
        .map(|option| (option.label.as_str(), option.count))
        .collect()
}

#[test]
fn the_root_is_the_roster_under_a_band_with_one_filter_menu() {
    let mut d = clean();
    person(&d, "Dana Reyes");
    person(&d, "Sam");
    let i = begin(&mut d);
    let state = home_state(d.view(i));
    assert_eq!(state.title, "People");
    assert_eq!(
        state
            .band
            .iter()
            .map(|t| t.key.as_str())
            .collect::<Vec<_>>(),
        ["people", "touch", "more"]
    );
    assert!(
        state
            .band
            .iter()
            .find(|t| t.key == "people")
            .unwrap()
            .current
    );
    // THE FILTER with the counts of the whole window, All picked; then the SORT.
    let built = state.filter_menu.clone().expect("the filter menu");
    assert_eq!(
        built
            .sections
            .iter()
            .map(|s| s.key.as_str())
            .collect::<Vec<_>>(),
        ["show", "sort"]
    );
    let show = menu::find(&built, "show").unwrap();
    assert_eq!(show.title, "Show");
    assert_eq!(show.kind, wire::menu_section::Kind::Single as i32);
    assert_eq!(shown(show), [("All", 2), ("Starred", 0), ("Overdue", 0)]);
    assert_eq!(
        show.options
            .iter()
            .map(|o| o.key.as_str())
            .collect::<Vec<_>>(),
        ["all", "starred", "due"]
    );
    assert_eq!(menu::checked(show), ["all"]);
    let sort = menu::find(&built, menu::SORT).unwrap();
    assert_eq!(sort.kind, wire::menu_section::Kind::Single as i32);
    assert_eq!(shown(sort), [("Recently added", 0), ("Name", 0)]);
    assert_eq!(menu::checked(sort), ["name"], "A to Z is the default");
    assert!(!built.filtering);
    assert_eq!(built.spoken, "Filter and sort");
    assert_eq!(built.clear_label, "Clear filters");
    let data = roster_data(d.view(i));
    assert_eq!(data.status_line, "2 people · 0 to reconnect · 0 starred");
    // A person who was never touched says so; the row opens their page.
    let dana = flat(data)
        .into_iter()
        .find(|r| r.name == "Dana Reyes")
        .unwrap();
    assert_eq!(dana.meta, "No touch logged yet");
    assert_eq!(dana.avatar.as_ref().unwrap().initials, "DR");
    assert!(dana.avatar.as_ref().unwrap().hue_key.starts_with('c'));
    assert_eq!(dana.star_label, "Star Dana Reyes");
    assert_eq!(
        dana.route,
        Some(routes::person(&dana.party_id, "Dana Reyes", false))
    );
    assert_eq!(state.add_person, Some(routes::new_person()));
}

#[test]
fn an_order_is_the_reads_and_a_pick_moves_the_check_and_never_lights_the_button() {
    let mut d = clean();
    person(&d, "Zed");
    person(&d, "Ana");
    person(&d, "Mia");
    let i = begin(&mut d);
    send_home(&mut d, i, pick("sort", "name"));
    let state = home_state(d.view(i));
    // There is no order sheet any more: the menu is the whole of it.
    assert_eq!(
        state.sheet,
        wire::people_home_state::Sheet::Unspecified as i32
    );
    let built = menu_of(&d, i);
    assert_eq!(menu::checked(menu::find(&built, "sort").unwrap()), ["name"]);
    assert!(!built.filtering, "a sort is not a filter");
    assert_eq!(names(roster_data(d.view(i))), ["Ana", "Mia", "Zed"]);
    // The same order again is nothing.
    send_home(&mut d, i, pick("sort", "name"));
    assert_eq!(names(roster_data(d.view(i))), ["Ana", "Mia", "Zed"]);
    // ... and back.
    send_home(&mut d, i, pick("sort", "recent"));
    assert_eq!(
        menu::checked(menu::find(&menu_of(&d, i), "sort").unwrap()),
        ["recent"]
    );
    // A key the menu did not make is nothing.
    let before = d.view(i).clone();
    send_home(&mut d, i, pick("sort", "nope"));
    send_home(&mut d, i, pick("show", "nope"));
    send_home(&mut d, i, pick("nope", "name"));
    assert_eq!(
        *d.view(i),
        wire::ViewState {
            revision: d.view(i).revision,
            ..before
        }
    );
}

#[test]
fn the_star_is_a_write_from_the_row_and_the_starred_chip_filters() {
    let mut d = clean();
    let dana = person(&d, "Dana");
    person(&d, "Sam");
    let i = begin(&mut d);
    send_home(
        &mut d,
        i,
        H::Star(ev::StarToggled {
            party_id: dana.clone(),
        }),
    );
    let state = home_state(d.view(i));
    let status = state.status.as_ref().expect("a status");
    assert_eq!(status.sentence, "Dana starred");
    assert!(!status.refused);
    let row = flat(roster_data(d.view(i)))
        .into_iter()
        .find(|r| r.party_id == dana)
        .unwrap();
    assert!(row.starred);
    assert_eq!(row.star_label, "Remove star from Dana");
    assert_eq!(row.accessibility_label, "Dana, starred");
    let show =
        |d: &centraid_screens::testing::Driver| menu::find(&menu_of(d, i), "show").unwrap().clone();
    assert_eq!(show(&d).options[1].count, 1);

    send_home(&mut d, i, pick("show", "starred"));
    assert_eq!(names(roster_data(d.view(i))), ["Dana"]);
    assert_eq!(menu::checked(&show(&d)), ["starred"]);
    // Starred narrows the roster, so the button is lit; Clear is back to All.
    assert!(menu_of(&d, i).filtering);
    assert_eq!(menu_of(&d, i).spoken, "Filter and sort, on");

    send_home(&mut d, i, H::Star(ev::StarToggled { party_id: dana }));
    let state = home_state(d.view(i));
    assert_eq!(
        state.status.as_ref().unwrap().sentence,
        "Star removed · Dana"
    );
    // Nobody is starred now, and that is the filter's own sentence, not day one's.
    let empty = roster_data(d.view(i))
        .empty
        .clone()
        .expect("an empty state");
    assert_eq!(empty.headline, "Nobody is starred.");
    assert_eq!(empty.action_label, "");
    assert_eq!(empty.import_source, wire::ImportSource::Unspecified as i32);
    // CLEAR FILTERS goes back to All: the button goes out and everyone is back.
    assert!(menu_of(&d, i).filtering);
    send_home(&mut d, i, H::FilterMenuCleared(wire::FilterMenuCleared {}));
    assert!(!menu_of(&d, i).filtering);
    assert_eq!(menu::checked(&show(&d)), ["all"]);
    assert_eq!(flat(roster_data(d.view(i))).len(), 2);
}

#[test]
fn clear_filters_keeps_the_order() {
    let mut d = clean();
    person(&d, "Zed");
    person(&d, "Ana");
    let i = begin(&mut d);
    send_home(&mut d, i, pick("sort", "name"));
    send_home(&mut d, i, pick("show", "due"));
    assert!(menu_of(&d, i).filtering);
    send_home(&mut d, i, H::FilterMenuCleared(wire::FilterMenuCleared {}));
    let built = menu_of(&d, i);
    assert!(!built.filtering);
    assert_eq!(menu::checked(menu::find(&built, "show").unwrap()), ["all"]);
    assert_eq!(menu::checked(menu::find(&built, "sort").unwrap()), ["name"]);
    assert_eq!(names(roster_data(d.view(i))), ["Ana", "Zed"]);
}

#[test]
fn a_filter_with_nobody_says_so_and_day_one_offers_the_phones_contacts() {
    let mut d = clean();
    let i = begin(&mut d);
    // Day one: nobody at all.
    let empty = roster_data(d.view(i)).empty.clone().expect("day one");
    assert_eq!(empty.headline, "Add people you keep up with");
    assert_eq!(empty.action_label, "Add person");
    assert_eq!(empty.import_source, wire::ImportSource::Contacts as i32);

    person(&d, "Dana");
    refresh(&mut d, i);
    send_home(&mut d, i, pick("show", "due"));
    let empty = roster_data(d.view(i))
        .empty
        .clone()
        .expect("a filter's own");
    assert_eq!(empty.headline, "Nobody is overdue.");
}

#[test]
fn a_touch_is_counted_in_the_members_days_on_the_row() {
    let mut d = clean();
    let dana = person(&d, "Dana");
    let i = begin(&mut d);
    assert_eq!(flat(roster_data(d.view(i)))[0].meta, "No touch logged yet");
    arrange(
        &d,
        act::people::LogInteraction {
            person_id: dana,
            kind: "call".to_owned(),
            text: None,
        },
    );
    d.pump(std::time::Duration::from_millis(300));
    assert_eq!(flat(roster_data(d.view(i)))[0].meta, "Last touch today");
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
    let chips: Vec<String> = flat(roster_data(d.view(i)))[0]
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
    // Open, with no term: the roster stands and no filter narrows a name, so there
    // is no menu, and a pick that arrives anyway is nothing.
    let state = home_state(d.view(i));
    assert!(state.search.as_ref().unwrap().open);
    assert!(state.filter_menu.is_none());
    send_home(&mut d, i, pick("show", "starred"));
    send_home(&mut d, i, H::FilterMenuCleared(wire::FilterMenuCleared {}));
    assert!(home_state(d.view(i)).filter_menu.is_none());

    send_home(
        &mut d,
        i,
        H::SearchTerm(ev::SearchTermChanged { term: "dan".into() }),
    );
    let state = home_state(d.view(i));
    let results = state
        .search
        .as_ref()
        .unwrap()
        .results
        .as_ref()
        .expect("results");
    assert_eq!(
        results
            .rows
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>(),
        ["Dana Reyes"]
    );
    // Ask is the row at the foot of an answer, scoped to People.
    let ask = state.search.as_ref().unwrap().ask.as_ref().expect("Ask");
    assert_eq!(ask.scope, "people");
    assert_eq!(ask.question, "Find dan");
    // The roster stands under it.
    assert_eq!(flat(roster_data(d.view(i))).len(), 2);

    send_home(
        &mut d,
        i,
        H::SearchTerm(ev::SearchTermChanged {
            term: "zzqx".into(),
        }),
    );
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
    // The menu comes back with the roster, and the stale pick changed nothing.
    let built = state.filter_menu.clone().expect("the menu is back");
    assert_eq!(menu::checked(menu::find(&built, "show").unwrap()), ["all"]);
}

#[test]
fn more_holds_lists_import_export_and_trash_and_is_an_ordinary_band_tab_last() {
    let mut d = clean();
    person(&d, "Dana");
    let i = begin(&mut d);
    let landed = home_state(d.view(i));
    let last = landed.band.last().unwrap();
    assert_eq!(
        (last.key.as_str(), last.icon_key.as_str()),
        ("more", "MoreHoriz")
    );
    send_home(&mut d, i, H::Band(ev::BandPicked { key: "more".into() }));
    let more = home_state(d.view(i));
    assert_eq!(more.sheet, wire::people_home_state::Sheet::More as i32);
    let labels: Vec<&str> = more.more_rows.iter().map(|r| r.label.as_str()).collect();
    assert_eq!(labels, ["Lists", "Import", "Export", "Trash"]);
    assert_eq!(more.more_rows[0].route, Some(routes::lists("People")));
    assert_eq!(more.more_rows[3].route, Some(routes::trash()));
    assert_eq!(more.more_rows[3].meta, "30 days, then erased");
    assert!(more.more_rows[..3].iter().all(|row| row.meta.is_empty()));
    send_home(&mut d, i, H::SheetClosed(ev::SheetClosed {}));
    assert_eq!(
        home_state(d.view(i)).sheet,
        wire::people_home_state::Sheet::Unspecified as i32
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
    send_home(
        &mut d,
        i,
        H::Band(ev::BandPicked {
            key: "touch".into(),
        }),
    );
    assert_eq!(depth(&d), before);
    let state = home_state(d.view(i));
    assert_eq!(state.destination, wire::PeopleDestination::Touch as i32);
    // Touch filters nothing: no menu, and a stale pick is nothing.
    assert!(state.filter_menu.is_none());
    send_home(&mut d, i, pick("show", "starred"));
    send_home(&mut d, i, pick("sort", "name"));
    send_home(&mut d, i, H::FilterMenuCleared(wire::FilterMenuCleared {}));
    let state = home_state(d.view(i));
    assert_eq!(state.destination, wire::PeopleDestination::Touch as i32);
    assert!(state.filter_menu.is_none());
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
    assert!(
        touch
            .tiles
            .iter()
            .find(|t| t.key == "reconnect")
            .unwrap()
            .net
    );
    assert_eq!(touch.reconnect_empty, "Nobody is overdue.");
    assert_eq!(touch.upcoming_empty, "No dates coming up.");
    // BOTH SPELLINGS OF A KIND are one noun: `visit` is "Met up".
    let recent = &touch.recent[0];
    assert_eq!(
        (recent.kind_label.as_str(), recent.when_label.as_str()),
        ("Met up", "Today")
    );
    assert_eq!(recent.text, "Coffee");
    assert_eq!(recent.route, Some(routes::person(&dana, "Dana", false)));
    assert_eq!(touch.status_line, "1 person · 0 overdue");

    // The same tab is nothing; a tile lands on People under its chip.
    send_home(
        &mut d,
        i,
        H::Band(ev::BandPicked {
            key: "touch".into(),
        }),
    );
    assert_eq!(
        home_state(d.view(i)).destination,
        wire::PeopleDestination::Touch as i32
    );
    send_home(
        &mut d,
        i,
        H::Tile(ev::TilePicked {
            key: "upcoming".into(),
        }),
    );
    assert_eq!(
        home_state(d.view(i)).destination,
        wire::PeopleDestination::Touch as i32
    );
    send_home(
        &mut d,
        i,
        H::Tile(ev::TilePicked {
            key: "reconnect".into(),
        }),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.destination, wire::PeopleDestination::People as i32);
    // THE TILE SETS THE SAME FILTER A PICK DOES: Overdue is checked and lit.
    let built = state.filter_menu.clone().expect("the menu");
    assert_eq!(menu::checked(menu::find(&built, "show").unwrap()), ["due"]);
    assert!(built.filtering);
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
fn the_words_the_core_corrected_are_on_the_field_and_a_new_term_clears_them() {
    let mut d = clean();
    person(&d, "Dana Reyes");
    let i = begin(&mut d);
    send_home(&mut d, i, H::SearchOpened(ev::SearchOpened {}));
    send_home(
        &mut d,
        i,
        H::SearchTerm(ev::SearchTermChanged {
            term: "danaa".into(),
        }),
    );
    let corrected = home_state(d.view(i)).search.clone().unwrap().corrected;
    if !corrected.is_empty() {
        assert!(
            corrected.starts_with("Including results for "),
            "{corrected}"
        );
    }
    send_home(
        &mut d,
        i,
        H::SearchTerm(ev::SearchTermChanged {
            term: "dana".into(),
        }),
    );
    assert_eq!(home_state(d.view(i)).search.clone().unwrap().corrected, "");
}

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

#[test]
fn the_roster_opens_a_to_z_with_an_index_and_recently_added_is_the_flat_list() {
    let mut d = clean();
    for name in ["Zed", "Ana", "Émile", "Дана", "Bea", "Eve"] {
        person(&d, name);
    }
    let i = begin(&mut d);
    let data = roster_data(d.view(i));
    assert!(data.rows.is_empty(), "the rows are in the sections");
    assert_eq!(
        data.sections
            .iter()
            .map(|s| (s.key.as_str(), s.rows.len()))
            .collect::<Vec<_>>(),
        [("A", 1), ("B", 1), ("E", 2), ("Z", 1), ("#", 1)]
    );
    assert_eq!(
        data.sections[2]
            .rows
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>(),
        ["Eve", "Émile"],
        "the core's order inside a letter"
    );
    assert_eq!(data.index.len(), 27);
    assert_eq!(data.index.last().unwrap().letter, "#");
    let of = |letter: &str| data.index.iter().find(|l| l.letter == letter).unwrap();
    assert_eq!(
        (of("E").has_rows, of("E").section_key.as_str()),
        (true, "E")
    );
    assert_eq!(
        (of("C").has_rows, of("C").section_key.as_str()),
        (false, "E"),
        "a letter with nobody jumps to the next one that has people"
    );
    // Recently added is the flat list, with no index.
    send_home(&mut d, i, pick("sort", "recent"));
    let data = roster_data(d.view(i));
    assert!(data.sections.is_empty() && data.index.is_empty());
    assert_eq!(data.rows.len(), 6);
    assert_eq!(data.rows[0].name, "Eve", "newest added first");
}

#[test]
fn my_card_is_the_owner_above_the_all_list_and_a_filter_takes_it_away() {
    let mut d = clean();
    person(&d, "Dana Reyes");
    let i = begin(&mut d);
    let owner = roster_of(&d).owner.expect("the vault has an owner");
    let data = roster_data(d.view(i));
    let card = data.my_card.as_ref().expect("My card");
    assert_eq!(card.party_id, owner.party_id);
    assert_eq!(card.label, "My card");
    assert_eq!(
        card.route,
        Some(routes::person(&owner.party_id, &card.name, false))
    );
    assert!(
        flat(data).iter().all(|row| row.party_id != owner.party_id),
        "the owner is My card, not one of the people"
    );
    send_home(&mut d, i, pick("show", "starred"));
    assert!(roster_data(d.view(i)).my_card.is_none());
    send_home(&mut d, i, pick("show", "all"));
    assert!(roster_data(d.view(i)).my_card.is_some());
}

#[test]
fn nobody_overdue_is_no_reconnect_line() {
    let mut d = clean();
    person(&d, "Dana Reyes");
    let i = begin(&mut d);
    assert!(roster_data(d.view(i)).reconnect.is_none());
}
