//! Money's home: Spending, Activity and Cash flow, the filters, the month, the
//! More sheet. Ports of the home cases of `MoneyScreensSpec`, driven through the
//! door a shell uses.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use money_support::*;
use wire::money_home_event::{self as he, Kind as H};
use wire::money_home_state::{Destination, Sheet};

#[test]
fn spending_is_the_default_and_is_drawn_per_currency() {
    let d = driver();
    let i = home(&d);
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
    assert_eq!(band, ["spending", "activity", "cashflow", "more"]);
    assert!(state.band[0].current);
}

#[test]
fn a_category_row_opens_its_target_for_the_month_in_view() {
    let d = driver();
    let i = home(&d);
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
    let d = driver();
    let i = home(&d);
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
            "money.import"
        ]
    );
}

#[test]
fn stepping_the_month_back_reads_the_month_before_and_never_goes_past_today() {
    let mut d = driver();
    let i = home(&d);
    let current = home_state(d.view(i)).month.clone();
    assert!(!current.is_empty(), "the answer names the month in view");
    assert!(!home_data(d.view(i)).can_step_next);
    event(
        &mut d,
        i,
        home_event(H::MonthStepped(he::MonthStepped { months: -1 })),
    );
    let back = home_state(d.view(i)).month.clone();
    assert!(back < current);
    assert!(home_data(d.view(i)).can_step_next);
    event(
        &mut d,
        i,
        home_event(H::MonthStepped(he::MonthStepped { months: 1 })),
    );
    assert_eq!(home_state(d.view(i)).month, current);
    event(
        &mut d,
        i,
        home_event(H::MonthStepped(he::MonthStepped { months: 1 })),
    );
    assert_eq!(
        home_state(d.view(i)).month,
        current,
        "there is no month after this one"
    );
}

#[test]
fn the_month_sheet_offers_twelve_months_and_picking_one_reads_it() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Activity);
    event(
        &mut d,
        i,
        home_event(H::Chip(he::ChipTapped {
            key: "month".into(),
        })),
    );
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
}

#[test]
fn activity_groups_lines_under_their_days_with_a_route_each() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Activity);
    let state = home_state(d.view(i));
    assert_eq!(state.destination, Destination::Activity as i32);
    let chips: Vec<_> = state.chips.iter().map(|c| c.key.as_str()).collect();
    assert_eq!(chips, ["month", "account", "category"]);
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

#[test]
fn picking_an_account_filters_the_lines_and_says_so_on_the_chip() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Activity);
    let (account_id, name) = accounts(&d).remove(0);
    event(
        &mut d,
        i,
        home_event(H::Chip(he::ChipTapped {
            key: "account".into(),
        })),
    );
    assert_eq!(home_state(d.view(i)).sheet, Sheet::Account as i32);
    event(
        &mut d,
        i,
        home_event(H::AccountPicked(he::AccountPicked {
            account_id: account_id.clone(),
        })),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.account_id, account_id);
    assert_eq!(state.sheet, Sheet::None as i32);
    let chip = state.chips.iter().find(|c| c.key == "account").unwrap();
    assert!(chip.active);
    assert_eq!(chip.label, name);
    let activity = home_data(d.view(i)).activity.as_ref().unwrap();
    for row in activity.sections.iter().flat_map(|s| &s.rows) {
        assert!(
            row.meta.contains(&name) || row.accessibility_label.contains(&name),
            "{}",
            row.meta
        );
    }
}

#[test]
fn the_needs_a_category_filter_lists_only_uncategorised_lines() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Activity);
    event(
        &mut d,
        i,
        home_event(H::CategoryPicked(he::CategoryPicked {
            key: "uncategorised".into(),
        })),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.category_filter, "uncategorised");
    let chip = state.chips.iter().find(|c| c.key == "category").unwrap();
    assert_eq!(chip.label, "Needs a category");
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
fn cash_flow_has_twelve_months_per_currency_and_no_month_stepper() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Cashflow);
    let data = home_data(d.view(i));
    assert!(!data.shows_month);
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
            key: "spending".into(),
        })),
    );
    assert_eq!(
        home_state(d.view(i)).destination,
        Destination::Spending as i32
    );
}

#[test]
fn moving_a_tab_reads_that_tab_and_keeps_the_month() {
    let mut d = driver();
    let i = home(&d);
    event(
        &mut d,
        i,
        home_event(H::MonthStepped(he::MonthStepped { months: -1 })),
    );
    let month = home_state(d.view(i)).month.clone();
    event(
        &mut d,
        i,
        home_event(H::Band(he::BandPicked {
            key: "activity".into(),
        })),
    );
    let state = home_state(d.view(i));
    assert_eq!(state.destination, Destination::Activity as i32);
    assert_eq!(state.month, month);
    assert_eq!(state.band[1].key, "activity");
    assert!(state.band[1].current);
}
