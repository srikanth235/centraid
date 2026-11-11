//! Money's home: Activity (home), Spending and Cash flow, the header's filter menu, the
//! month under the title, the More sheet. Ports of the home cases of `MoneyScreensSpec`, driven through the
//! door a shell uses.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::kit::menu;
use centraid_screens::testing::Driver;
use money_support::*;
use wire::money_home_event::{self as he, Kind as H};
use wire::money_home_state::{Destination, Sheet};

#[test]
fn activity_is_home_and_spending_is_drawn_per_currency() {
    let mut d = driver();
    let i = home(&d);
    assert_eq!(
        home_state(d.view(i)).destination,
        Destination::Activity as i32,
        "Money opens on Activity"
    );
    let i = land_on(&mut d, wire::MoneyDestination::Spending);
    let state = home_state(d.view(i));
    assert_eq!(state.destination, Destination::Spending as i32);
    assert_eq!(state.chrome.as_ref().unwrap().title, "Money");
    let data = home_data(d.view(i));
    let spending = data.spending.as_ref().expect("spending data");
    assert!(spending.empty.is_none(), "the example scenario has lines");
    assert!(!spending.heroes.is_empty());
    for hero in &spending.heroes {
        assert!(
            hero.spent.starts_with('$') || hero.spent.starts_with("-$"),
            "{}",
            hero.spent
        );
    }
    assert!(!spending.definitions.is_empty());
    let band: Vec<_> = state.band.iter().map(|t| t.key.as_str()).collect();
    assert_eq!(band, ["activity", "spending", "cashflow", "more"]);
    assert!(state.band[1].current);
}

#[test]
fn a_category_row_opens_its_target_for_the_month_in_view() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Spending);
    let data = home_data(d.view(i));
    let spending = data.spending.as_ref().unwrap();
    let line = spending
        .tables
        .iter()
        .flat_map(|t| &t.rows)
        .next()
        .expect("a category line");
    let route = line.route.as_ref().unwrap();
    let Some(wire::route::Args::MoneyTarget(target)) = route.args.clone() else {
        panic!("a category row routes to its target");
    };
    assert_eq!(target.month, home_state(d.view(i)).month);
    assert!(!target.category_id.is_empty());
    assert_eq!(route.screen, "money.target");
}

#[test]
fn the_header_search_and_recurring_rows_are_routes() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Spending);
    let chrome = home_state(d.view(i)).chrome.as_ref().unwrap();
    assert_eq!(chrome.import_route.as_ref().unwrap().screen, "money.import");
    assert_eq!(chrome.search_route.as_ref().unwrap().screen, "money.search");
    let spending = home_data(d.view(i)).spending.as_ref().unwrap();
    assert_eq!(
        spending.recurring_route.as_ref().unwrap().screen,
        "money.recurring"
    );
    let more: Vec<&str> = chrome
        .more_rows
        .iter()
        .map(|r| r.route.as_ref().unwrap().screen.as_str())
        .collect();
    assert_eq!(
        more,
        [
            "money.accounts",
            "money.rules",
            "money.categories",
            "money.import",
            "money.export",
            "money.trash"
        ]
    );
}

#[test]
fn the_month_is_the_title_second_line_on_activity_and_spending_and_not_on_cash_flow() {
    let mut d = driver();
    for (destination, shown) in [
        (wire::MoneyDestination::Activity, true),
        (wire::MoneyDestination::Spending, true),
        (wire::MoneyDestination::Cashflow, false),
    ] {
        let i = land_on(&mut d, destination);
        let state = home_state(d.view(i));
        assert_eq!(state.subtitle.is_some(), shown, "{destination:?}");
        if let Some(subtitle) = &state.subtitle {
            assert_eq!(subtitle.label, home_data(d.view(i)).month_label);
            assert!(subtitle.tappable, "a tap opens the month sheet");
            assert!(subtitle.spoken.starts_with("Month, "));
        }
    }
}

#[test]
fn the_month_sheet_is_the_one_way_to_step_back_and_never_offers_a_month_after_today() {
    let mut d = driver();
    let i = home(&d);
    let current = home_state(d.view(i)).month.clone();
    assert!(!current.is_empty(), "the answer names the month in view");
    event(&mut d, i, home_event(H::MonthTapped(he::MonthTapped {})));
    assert_eq!(home_state(d.view(i)).sheet, Sheet::Month as i32);
    let options = home_data(d.view(i)).month_options.clone();
    assert_eq!(options[0].key, current, "the newest choice is this month");
    assert!(options[0].selected);
    assert!(options.iter().all(|o| o.key <= current));
    // A month after this one, asked for anyway, lands on this one.
    let after = format!("{}-12", &current[..4]);
    event(
        &mut d,
        i,
        home_event(H::MonthPicked(he::MonthPicked {
            month: if after > current {
                after
            } else {
                "9999-12".to_owned()
            },
        })),
    );
    assert_eq!(home_state(d.view(i)).month, current);
    // A month back reads that month and the subtitle says it.
    event(
        &mut d,
        i,
        home_event(H::MonthPicked(he::MonthPicked {
            month: options[1].key.clone(),
        })),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.month, options[1].key);
    assert_eq!(state.subtitle.as_ref().unwrap().label, options[1].label);
    assert_eq!(state.sheet, Sheet::None as i32);
}

#[test]
fn the_month_sheet_offers_twelve_months_and_picking_one_reads_it() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Activity);
    event(&mut d, i, home_event(H::MonthTapped(he::MonthTapped {})));
    assert_eq!(home_state(d.view(i)).sheet, Sheet::Month as i32);
    let options = home_data(d.view(i)).month_options.clone();
    assert_eq!(options.len(), 12);
    let older = options[3].key.clone();
    event(
        &mut d,
        i,
        home_event(H::MonthPicked(he::MonthPicked {
            month: older.clone(),
        })),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.month, older);
    assert_eq!(state.sheet, Sheet::None as i32);
    // The month beside the title follows it.
    assert_eq!(
        state.subtitle.as_ref().unwrap().label,
        home_data(d.view(i)).month_label
    );
}

#[test]
fn activity_groups_lines_under_their_days_with_a_route_each() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Activity);
    let state = home_state(d.view(i));
    assert_eq!(state.destination, Destination::Activity as i32);
    let activity = home_data(d.view(i)).activity.as_ref().unwrap();
    assert!(
        !activity.sections.is_empty(),
        "the example scenario has lines this month"
    );
    for section in &activity.sections {
        assert!(!section.heading.is_empty());
        for row in &section.rows {
            assert!(!row.title.is_empty());
            assert_eq!(row.route.as_ref().unwrap().screen, "money.transaction");
            assert!(row.amount.contains('$'), "{}", row.amount);
        }
    }
}

/// The menu Activity draws, with the sections it is made of.
fn filter_menu(d: &Driver, i: u64) -> &wire::FilterMenu {
    home_state(d.view(i))
        .filter_menu
        .as_ref()
        .expect("Activity has a filter menu")
}

fn pick(d: &mut Driver, i: u64, section: &str, option: &str) {
    event(
        d,
        i,
        home_event(H::FilterMenuPicked(wire::FilterMenuPicked {
            section_key: section.into(),
            option_key: option.into(),
        })),
    );
}

#[test]
fn activity_has_the_filter_menu_and_the_month_under_the_title_and_nothing_else_does() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Activity);
    let built = filter_menu(&d, i);
    // Account and Category are nested single choices; Money has no sort.
    let keys: Vec<_> = built.sections.iter().map(|s| s.key.as_str()).collect();
    assert_eq!(keys, ["account", "category"]);
    assert!(built.sections.iter().all(|s| s.nested));
    assert!(
        built
            .sections
            .iter()
            .all(|s| s.kind == wire::menu_section::Kind::Single as i32)
    );
    assert!(menu::find(built, menu::SORT).is_none());
    assert!(!built.filtering);
    assert_eq!(built.spoken, "Filter");
    assert_eq!(built.clear_label, "Clear filters");
    let account = menu::find(built, "account").unwrap();
    assert_eq!(account.title, "Account");
    assert_eq!(account.summary, "All accounts");
    assert_eq!(account.options[0].key, "all");
    assert_eq!(menu::checked(account), ["all"]);
    let category = menu::find(built, "category").unwrap();
    assert_eq!(category.summary, "All categories");
    let category_keys: Vec<_> = category.options.iter().map(|o| o.key.as_str()).collect();
    assert_eq!(&category_keys[..2], ["all", "uncategorised"]);
    assert_eq!(category.options[1].label, "Needs a category");
    assert!(category.options.len() > 2, "the categories follow");
    // The month stays beside the title and opens its sheet.
    let subtitle = home_state(d.view(i)).subtitle.as_ref().unwrap();
    assert_eq!(subtitle.label, home_data(d.view(i)).month_label);
    assert_eq!(subtitle.spoken, format!("Month, {}", subtitle.label));
    assert!(subtitle.tappable);
    assert!(!subtitle.clearable);
    // Spending has the month but no filter, and Cash flow has neither.
    for (key, month) in [("spending", true), ("cashflow", false)] {
        event(
            &mut d,
            i,
            home_event(H::Band(he::BandPicked { key: key.into() })),
        );
        let state = home_state(d.view(i));
        assert!(state.filter_menu.is_none(), "{key}");
        assert_eq!(state.subtitle.is_some(), month, "{key}");
    }
}

#[test]
fn picking_an_account_filters_the_lines_and_lights_the_menu() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Activity);
    let (account_id, name) = accounts(&d).remove(0);
    pick(&mut d, i, "account", &account_id);
    let state = home_state(d.view(i));
    assert_eq!(state.sheet, Sheet::None as i32);
    let built = filter_menu(&d, i);
    assert!(built.filtering);
    assert_eq!(built.spoken, "Filter, on");
    let account = menu::find(built, "account").unwrap();
    assert_eq!(menu::checked(account), [account_id.as_str()]);
    assert!(account.summary.starts_with(&name), "{}", account.summary);
    // The other section is untouched.
    assert_eq!(
        menu::checked(menu::find(built, "category").unwrap()),
        ["all"]
    );
    let activity = home_data(d.view(i)).activity.as_ref().unwrap();
    for row in activity.sections.iter().flat_map(|s| &s.rows) {
        assert!(
            row.meta.contains(&name) || row.accessibility_label.contains(&name),
            "{}",
            row.meta
        );
    }
    // All puts the account back and unlights the menu.
    pick(&mut d, i, "account", "all");
    let built = filter_menu(&d, i);
    assert!(!built.filtering);
    assert_eq!(
        menu::checked(menu::find(built, "account").unwrap()),
        ["all"]
    );
}

#[test]
fn a_category_pick_is_one_choice_and_a_clear_resets_both_filters_but_not_the_month() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Activity);
    event(&mut d, i, home_event(H::MonthTapped(he::MonthTapped {})));
    let older = home_data(d.view(i)).month_options[1].key.clone();
    event(
        &mut d,
        i,
        home_event(H::MonthPicked(he::MonthPicked { month: older })),
    );
    let month = home_state(d.view(i)).month.clone();
    let (account_id, _) = accounts(&d).remove(0);
    pick(&mut d, i, "account", &account_id);
    let category = menu::find(filter_menu(&d, i), "category").unwrap();
    let chosen = category.options.last().unwrap().key.clone();
    assert!(!["all", "uncategorised"].contains(&chosen.as_str()));
    pick(&mut d, i, "category", &chosen);
    pick(&mut d, i, "category", "uncategorised");
    let built = filter_menu(&d, i);
    assert!(built.filtering);
    let category = menu::find(built, "category").unwrap();
    assert_eq!(menu::checked(category), ["uncategorised"]);
    assert_eq!(category.summary, "Needs a category");
    assert_eq!(
        menu::checked(menu::find(built, "account").unwrap()),
        [account_id.as_str()]
    );
    // A pick the menu does not hold is nothing.
    pick(&mut d, i, "sort", "name_asc");
    pick(&mut d, i, "account", "all-of-them");
    assert!(filter_menu(&d, i).filtering);
    event(
        &mut d,
        i,
        home_event(H::FilterMenuCleared(wire::FilterMenuCleared {})),
    );
    let built = filter_menu(&d, i);
    assert!(!built.filtering);
    for key in ["account", "category"] {
        assert_eq!(menu::checked(menu::find(built, key).unwrap()), ["all"]);
    }
    assert_eq!(
        home_state(d.view(i)).month,
        month,
        "the month is not a filter"
    );
}

#[test]
fn the_needs_row_lists_only_uncategorised_lines_and_the_menu_says_so() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Activity);
    event(
        &mut d,
        i,
        home_event(H::CategoryPicked(he::CategoryPicked {
            key: "uncategorised".into(),
        })),
    );
    let built = filter_menu(&d, i);
    assert!(built.filtering);
    let category = menu::find(built, "category").unwrap();
    assert_eq!(menu::checked(category), ["uncategorised"]);
    assert_eq!(category.summary, "Needs a category");
    let activity = home_data(d.view(i)).activity.as_ref().unwrap();
    for row in activity.sections.iter().flat_map(|s| &s.rows) {
        assert!(
            row.chips.iter().any(|c| c.label == "No category"),
            "{}",
            row.title
        );
    }
}

#[test]
fn a_filter_that_matches_nothing_says_so_and_offers_no_import() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Activity);
    // a month long before any line
    event(
        &mut d,
        i,
        home_event(H::MonthPicked(he::MonthPicked {
            month: "2001-01".into(),
        })),
    );
    let activity = home_data(d.view(i)).activity.as_ref().unwrap();
    assert!(activity.sections.is_empty());
    let empty = activity.empty.as_ref().expect("an empty state");
    assert_eq!(empty.headline, "Nothing this month.");
    assert_eq!(empty.action_label, "Import statement");
    event(
        &mut d,
        i,
        home_event(H::CategoryPicked(he::CategoryPicked {
            key: "uncategorised".into(),
        })),
    );
    let empty = home_data(d.view(i))
        .activity
        .as_ref()
        .unwrap()
        .empty
        .clone()
        .unwrap();
    assert_eq!(empty.headline, "Nothing matches these filters.");
    assert!(empty.action_label.is_empty());
}

#[test]
fn cash_flow_has_twelve_months_per_currency_and_no_month_to_change() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Cashflow);
    let data = home_data(d.view(i));
    assert!(home_state(d.view(i)).subtitle.is_none());
    let cashflow = data.cashflow.as_ref().unwrap();
    assert!(!cashflow.series.is_empty());
    let months = &cashflow.series[0].months;
    assert_eq!(months.len(), 12);
    assert!(
        months.iter().any(|m| m.partial),
        "the current month is marked partial"
    );
    for month in months {
        assert!(month.in_bp <= 10_000 && month.out_bp <= 10_000);
        assert_eq!(month.label.len(), 3);
    }
    assert!(!cashflow.definitions.is_empty());
}

#[test]
fn the_more_sheet_opens_and_closes_behind_a_tapped_row() {
    let mut d = driver();
    let i = home(&d);
    event(
        &mut d,
        i,
        home_event(H::Band(he::BandPicked { key: "more".into() })),
    );
    assert_eq!(home_state(d.view(i)).sheet, Sheet::More as i32);
    event(&mut d, i, home_event(H::MoreOpened(he::MoreOpened {})));
    assert_eq!(home_state(d.view(i)).sheet, Sheet::None as i32);
    // the same tab again is nothing
    event(
        &mut d,
        i,
        home_event(H::Band(he::BandPicked {
            key: "activity".into(),
        })),
    );
    assert_eq!(
        home_state(d.view(i)).destination,
        Destination::Activity as i32
    );
}

#[test]
fn moving_a_tab_reads_that_tab_and_keeps_the_month() {
    let mut d = driver();
    let i = home(&d);
    event(&mut d, i, home_event(H::MonthTapped(he::MonthTapped {})));
    let older = home_data(d.view(i)).month_options[1].key.clone();
    event(
        &mut d,
        i,
        home_event(H::MonthPicked(he::MonthPicked { month: older })),
    );
    let month = home_state(d.view(i)).month.clone();
    event(
        &mut d,
        i,
        home_event(H::Band(he::BandPicked {
            key: "spending".into(),
        })),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.destination, Destination::Spending as i32);
    assert_eq!(state.month, month);
    assert_eq!(state.band[1].key, "spending");
    assert!(state.band[1].current);
}
