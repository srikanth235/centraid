//! The Money redesign's behaviour (#1173): Activity's overview card and review
//! banner, day groups and their totals, the colour a category wears, and
//! Spending's chart. Driven through the door a shell uses, over the example
//! scenario; every assertion is on counts and values, never on time.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use money_support::*;
use wire::money_home_event::{self as he, Kind as H};
use wire::money_home_state::Destination;
use wire::status_chip::Tone;

const PALETTE: [&str; 8] = [
    "blue",
    "mustard",
    "violet",
    "petrol",
    "indigo",
    "graphite",
    "raspberry",
    "orchid",
];

fn activity_data(d: &centraid_screens::testing::Driver, i: u64) -> wire::MoneyActivityData {
    home_data(d.view(i)).activity.clone().expect("activity")
}

fn spending_data(d: &centraid_screens::testing::Driver, i: u64) -> wire::MoneySpendingData {
    home_data(d.view(i)).spending.clone().expect("spending")
}

#[test]
fn activity_opens_with_the_months_overview_and_its_in_out_and_net() {
    let d = driver();
    let i = home(&d);
    assert_eq!(
        home_state(d.view(i)).destination,
        Destination::Activity as i32
    );
    let activity = activity_data(&d, i);
    assert!(!activity.heroes.is_empty(), "the overview card is drawn");
    let hero = &activity.heroes[0];
    assert!(
        hero.spent_label.starts_with("Spent in "),
        "{}",
        hero.spent_label
    );
    assert!(!hero.spent.is_empty());
    assert_eq!(activity.in_out_net.len(), activity.heroes.len());
    let labels: Vec<&str> = activity.in_out_net[0]
        .figures
        .iter()
        .map(|f| f.label.as_str())
        .collect();
    assert_eq!(labels, ["In", "Out", "Net"]);
    // Money in is green, drawn from `positive`, never from a red tone.
    let net = &activity.in_out_net[0].figures[2];
    assert_eq!(net.positive, net.amount.starts_with('+'));
}

#[test]
fn the_review_banner_counts_the_rows_that_need_a_category_and_opens_them() {
    let mut d = driver();
    let i = home(&d);
    let activity = activity_data(&d, i);
    let counted: u32 = activity
        .needs_count
        .parse()
        .expect("the example scenario has rows with no category");
    assert!(counted > 0);
    assert_eq!(activity.review_label, "Review");
    assert!(
        activity.needs_title.starts_with("Need a category · "),
        "{}",
        activity.needs_title
    );
    assert!(
        activity.needs_label.contains(&counted.to_string()),
        "said aloud with the count: {}",
        activity.needs_label
    );
    assert_eq!(activity.needs_key, "uncategorised");
    // The banner lists exactly those rows: every row left carries the chip.
    event(
        &mut d,
        i,
        home_event(H::CategoryPicked(he::CategoryPicked {
            key: activity.needs_key.clone(),
        })),
    );
    let filtered = activity_data(&d, i);
    let rows: Vec<&wire::MoneyRow> = filtered
        .sections
        .iter()
        .flat_map(|section| &section.rows)
        .collect();
    assert!(!rows.is_empty());
    assert!(rows.iter().all(|row| row.color_key.is_empty()));
}

#[test]
fn a_day_group_carries_what_the_day_came_to_and_a_transfer_is_not_in_it() {
    let d = driver();
    let i = home(&d);
    let activity = activity_data(&d, i);
    assert!(!activity.sections.is_empty());
    for section in &activity.sections {
        assert_eq!(
            section.total_positive,
            section.total.starts_with('+'),
            "{}: {}",
            section.heading,
            section.total
        );
        let only_transfers = section.rows.iter().all(|row| row.tile_icon == "Swap");
        if only_transfers {
            assert!(
                section.total.is_empty(),
                "{} holds only transfers, which count for nothing",
                section.heading
            );
        }
    }
    // A transfer row says so, and is not drawn as money out or in.
    for row in activity.sections.iter().flat_map(|s| &s.rows) {
        if row.tile_icon == "Swap" {
            assert_eq!(row.meta, "Transfer · not counted as spending");
            assert_eq!(row.amount_tone, Tone::Seam as i32);
            assert!(!row.positive);
            assert!(row.chips.iter().all(|c| c.label != "Transfer"));
        }
    }
}

#[test]
fn money_out_is_ink_and_only_money_in_is_green() {
    let d = driver();
    let i = home(&d);
    for row in activity_data(&d, i)
        .sections
        .iter()
        .flat_map(|section| &section.rows)
    {
        assert_ne!(row.amount_tone, Tone::Net as i32, "{}", row.title);
        assert_eq!(
            row.positive,
            !row.dimmed && !row.amount.starts_with('-'),
            "{}: {}",
            row.title,
            row.amount
        );
    }
}

#[test]
fn a_row_wears_its_categorys_colour_from_the_one_palette_and_the_same_every_time() {
    let d = driver();
    let i = home(&d);
    let activity = activity_data(&d, i);
    let mut seen: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    for row in activity.sections.iter().flat_map(|s| &s.rows) {
        let category = row.meta.split(" · ").next().unwrap_or_default().to_owned();
        if row.color_key.is_empty() {
            continue;
        }
        assert!(
            PALETTE.contains(&row.color_key.as_str()),
            "{}",
            row.color_key
        );
        assert_eq!(row.initial.chars().count(), 1);
        // One category, one colour, wherever it is drawn.
        if let Some(before) = seen.insert(category.clone(), row.color_key.clone()) {
            assert_eq!(before, row.color_key, "{category}");
        }
    }
    assert!(!seen.is_empty(), "the example scenario has filed rows");
}

#[test]
fn spending_draws_weekly_bars_cut_by_category_and_a_caption_for_the_selected_one() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Spending);
    let spending = spending_data(&d, i);
    assert!(!spending.bars.is_empty());
    let bars = &spending.bars[0];
    let modes: Vec<(&str, bool)> = bars
        .modes
        .iter()
        .map(|m| (m.key.as_str(), m.selected))
        .collect();
    assert_eq!(modes, [("week", true), ("day", false)]);
    assert!(
        (4..=5).contains(&bars.bars.len()),
        "a month is four or five weeks"
    );
    assert_eq!(bars.bars.iter().filter(|b| b.selected).count(), 1);
    for bar in &bars.bars {
        assert!(bar.height_bp <= 10_000);
        if !bar.segments.is_empty() {
            let share: u32 = bar.segments.iter().map(|s| s.share_bp).sum();
            assert_eq!(share, 10_000, "{}: segments fill the bar", bar.label);
        }
        for segment in &bar.segments {
            assert!(PALETTE.contains(&segment.color_key.as_str()));
        }
        assert!(bar.label.contains('–') || bar.label.parse::<u32>().is_ok());
    }
    assert!(
        bars.bars.iter().any(|b| b.height_bp == 10_000) || bars.pace_bp == 10_000,
        "the tallest bar, or the plan's pace, is full height"
    );
    assert!(!bars.caption.is_empty());
    // The caption names the selected bar's range.
    let selected = bars.bars.iter().find(|b| b.selected).unwrap();
    let first = selected.label.split('–').next().unwrap();
    assert!(bars.caption.starts_with(first), "{}", bars.caption);
}

#[test]
fn picking_a_bar_moves_the_selection_and_the_caption_and_day_mode_cuts_by_day() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Spending);
    let start = spending_data(&d, i).bars[0].clone();
    let before = start.caption.clone();
    // Today's bar is the one selected to begin with; pick another one.
    let chosen = start.bars.iter().position(|b| !b.selected);
    let pick = |d: &mut centraid_screens::testing::Driver, index: u32| {
        event(d, i, home_event(H::BarPicked(he::BarPicked { index })));
    };
    let chosen = u32::try_from(chosen.expect("a bar to pick")).unwrap();
    pick(&mut d, chosen);
    let first = spending_data(&d, i).bars[0].clone();
    assert!(first.bars[chosen as usize].selected);
    assert_eq!(first.bars.iter().filter(|b| b.selected).count(), 1);
    assert_ne!(first.caption, before, "the caption follows the bar");
    // A bar past the end is nothing: the chart keeps one selected bar.
    pick(&mut d, 99);
    assert_eq!(
        spending_data(&d, i).bars[0]
            .bars
            .iter()
            .filter(|b| b.selected)
            .count(),
        1
    );
    event(
        &mut d,
        i,
        home_event(H::BarsModePicked(he::BarsModePicked {
            key: "day".to_owned(),
        })),
    );
    let days = spending_data(&d, i).bars[0].clone();
    assert!((28..=31).contains(&days.bars.len()), "{}", days.bars.len());
    assert!(days.modes[1].selected);
    // A label on every seventh day, empty between.
    assert_eq!(days.bars[0].label, "1");
    assert_eq!(days.bars[1].label, "");
    assert_eq!(days.bars[7].label, "8");
    // A month change puts the selection back on today's bar.
    event(&mut d, i, home_event(H::MonthTapped(he::MonthTapped {})));
    let older = home_data(d.view(i)).month_options[1].key.clone();
    event(
        &mut d,
        i,
        home_event(H::MonthPicked(he::MonthPicked { month: older })),
    );
    let past = spending_data(&d, i).bars[0].clone();
    assert_eq!(past.bars.iter().filter(|b| b.selected).count(), 1);
    assert!(
        past.bars.iter().all(|b| !b.upcoming),
        "a month that is over has no days to come"
    );
}

#[test]
fn a_category_line_says_where_it_stands_against_its_plan_in_its_colour() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Spending);
    let spending = spending_data(&d, i);
    let lines: Vec<&wire::MoneyCategoryLine> =
        spending.tables.iter().flat_map(|t| &t.rows).collect();
    assert!(!lines.is_empty());
    for line in lines {
        assert!(PALETTE.contains(&line.color_key.as_str()), "{}", line.label);
        assert!(line.progress_bp <= 10_000);
        if line.has_plan {
            assert!(
                line.caption.starts_with("of ") || line.caption.contains(" over the "),
                "{}",
                line.caption
            );
            assert_eq!(line.over, line.caption.contains(" over the "));
        } else {
            assert_eq!(line.caption, "No plan");
            assert_eq!(line.progress_bp, 0);
        }
    }
}

#[test]
fn categories_past_the_third_fold_into_one_row_until_it_is_tapped() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Spending);
    let table = spending_data(&d, i).tables[0].clone();
    match &table.more {
        Some(more) => {
            assert_eq!(table.rows.len(), 3);
            assert!(
                more.label.ends_with("more categories") || more.label == "1 more category",
                "{}",
                more.label
            );
            assert!(!more.amount.is_empty());
            event(
                &mut d,
                i,
                home_event(H::CategoriesExpanded(he::CategoriesExpanded {})),
            );
            let opened = spending_data(&d, i).tables[0].clone();
            assert!(opened.more.is_none());
            assert!(opened.rows.len() > 3);
        }
        None => assert!(
            table.rows.len() <= 3,
            "nothing is folded, so nothing is hidden"
        ),
    }
}

#[test]
fn the_no_category_row_on_spending_opens_activity_filtered_to_those_rows() {
    let mut d = driver();
    let i = land_on(&mut d, wire::MoneyDestination::Spending);
    let none = spending_data(&d, i).tables[0]
        .uncategorised
        .clone()
        .expect("the example scenario has rows with no category");
    assert_eq!(none.label, "No category");
    assert!(none.color_key.is_empty(), "drawn as a dashed dot");
    event(
        &mut d,
        i,
        home_event(H::CategoryPicked(he::CategoryPicked {
            key: "uncategorised".to_owned(),
        })),
    );
    assert_eq!(
        home_state(d.view(i)).destination,
        Destination::Activity as i32
    );
    assert!(
        home_state(d.view(i))
            .filter_menu
            .as_ref()
            .unwrap()
            .filtering
    );
}

#[test]
fn a_categorys_colour_is_stable_in_the_palette_and_none_for_no_category() {
    use centraid_screens::money::fold::{REST_COLOR_KEY, color_key};
    assert_eq!(
        color_key("category:groceries"),
        color_key("category:groceries")
    );
    for id in [
        "category:groceries",
        "category:rent",
        "x",
        "category:income",
    ] {
        assert!(PALETTE.contains(&color_key(id).as_str()), "{id}");
    }
    assert_eq!(color_key(""), "");
    assert_eq!(color_key("   "), "");
    assert!(PALETTE.contains(&REST_COLOR_KEY));
}
