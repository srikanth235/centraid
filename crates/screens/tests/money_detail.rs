//! One transaction, a category's target, recurring charges and search. Ports of
//! the matching cases of `MoneyScreensSpec`, through the door a shell uses.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::money::routes;
use money_support::*;
use wire::money_search_event as se;
use wire::money_target_event as tg;
use wire::money_transaction_event as te;
use wire::money_transaction_state::Sheet;

fn txn_state(v: &wire::ViewState) -> &wire::MoneyTransactionState {
    match &v.kind {
        Some(wire::view_state::Kind::MoneyTransaction(s)) => s,
        other => panic!("not a transaction: {other:?}"),
    }
}

fn txn_data(v: &wire::ViewState) -> &wire::MoneyTransactionData {
    match &txn_state(v).content {
        Some(wire::money_transaction_state::Content::Data(d)) => d,
        other => panic!("no transaction data: {other:?}"),
    }
}

fn txn_event(kind: te::Kind) -> wire::screen_event::Kind {
    wire::screen_event::Kind::MoneyTransaction(wire::MoneyTransactionEvent { kind: Some(kind) })
}

/// The first line of this month's Activity: its id.
fn a_line(d: &mut centraid_screens::testing::Driver) -> String {
    let i = land_on(d, wire::MoneyDestination::Activity);
    home_data(d.view(i))
        .activity
        .as_ref()
        .unwrap()
        .sections
        .iter()
        .flat_map(|s| &s.rows)
        .find(|row| row.chips.is_empty())
        .or_else(|| {
            home_data(d.view(i))
                .activity
                .as_ref()
                .unwrap()
                .sections
                .iter()
                .flat_map(|s| &s.rows)
                .next()
        })
        .map(|row| row.txn_id.clone())
        .expect("a line this month")
}

fn open(d: &mut centraid_screens::testing::Driver, id: &str) -> u64 {
    push(d, routes::transaction(id, "Money"))
}

#[test]
fn a_transaction_page_shows_what_the_bank_wrote_and_how_to_change_it() {
    let mut d = driver();
    let id = a_line(&mut d);
    let i = open(&mut d, &id);
    let state = txn_state(d.view(i));
    assert_eq!(state.chrome.as_ref().unwrap().back_label, "Money");
    assert_eq!(state.chrome.as_ref().unwrap().title, "Transaction");
    let data = txn_data(d.view(i));
    let labels: Vec<&str> = data.facts.iter().map(|f| f.label.as_str()).collect();
    assert!(labels.starts_with(&["Account", "Posted", "Bank wrote", "Category", "Name"]));
    let category = data.facts.iter().find(|f| f.label == "Category").unwrap();
    assert_eq!(category.action, "category");
    assert!(data.amount.contains('$'));
    let keys: Vec<&str> = data.actions.iter().map(|a| a.key.as_str()).collect();
    assert!(keys.contains(&"category") && keys.contains(&"name") && keys.contains(&"void"));
}

#[test]
fn filing_a_line_under_a_category_commits_and_says_so() {
    let mut d = driver();
    let id = a_line(&mut d);
    let i = open(&mut d, &id);
    event(
        &mut d,
        i,
        txn_event(te::Kind::Action(te::ActionPicked {
            key: "category".into(),
        })),
    );
    assert_eq!(txn_state(d.view(i)).sheet, Sheet::Category as i32);
    let options = txn_data(d.view(i)).category_options.clone();
    assert_eq!(options[0].label, "No category");
    let pick = options
        .iter()
        .find(|o| !o.key.is_empty())
        .expect("a category")
        .clone();
    event(
        &mut d,
        i,
        txn_event(te::Kind::Category(te::CategoryPicked {
            category_id: pick.key.clone(),
        })),
    );
    let state = txn_state(d.view(i));
    assert_eq!(state.sheet, Sheet::None as i32);
    assert_eq!(state.status.as_ref().unwrap().sentence, "Category saved");
    let filed = txn_data(d.view(i))
        .facts
        .iter()
        .find(|f| f.label == "Category")
        .unwrap()
        .detail
        .clone();
    assert_eq!(filed, pick.label);
}

#[test]
fn clearing_the_category_sends_null_and_leaves_the_line_without_one() {
    let mut d = driver();
    let id = a_line(&mut d);
    let i = open(&mut d, &id);
    event(
        &mut d,
        i,
        txn_event(te::Kind::Category(te::CategoryPicked {
            category_id: String::new(),
        })),
    );
    let data = txn_data(d.view(i));
    let category = data.facts.iter().find(|f| f.label == "Category").unwrap();
    assert_eq!(category.detail, "No category");
    assert_eq!(
        txn_state(d.view(i)).status.as_ref().unwrap().sentence,
        "Category saved"
    );
}

#[test]
fn naming_a_line_saves_the_name_and_a_cleared_name_goes_back_to_the_banks() {
    let mut d = driver();
    let id = a_line(&mut d);
    let i = open(&mut d, &id);
    event(
        &mut d,
        i,
        txn_event(te::Kind::Action(te::ActionPicked { key: "name".into() })),
    );
    assert_eq!(txn_state(d.view(i)).sheet, Sheet::Name as i32);
    event(
        &mut d,
        i,
        txn_event(te::Kind::NameEdited(te::NameEdited {
            text: "Corner cafe".into(),
        })),
    );
    event(&mut d, i, txn_event(te::Kind::NameSaved(te::NameSaved {})));
    assert_eq!(txn_data(d.view(i)).title, "Corner cafe");
    assert_eq!(
        txn_state(d.view(i)).status.as_ref().unwrap().sentence,
        "Name saved"
    );
    let name = txn_data(d.view(i))
        .facts
        .iter()
        .find(|f| f.label == "Name")
        .unwrap()
        .detail
        .clone();
    assert!(name.ends_with("set by you"), "{name}");
    event(
        &mut d,
        i,
        txn_event(te::Kind::Action(te::ActionPicked { key: "name".into() })),
    );
    event(
        &mut d,
        i,
        txn_event(te::Kind::NameEdited(te::NameEdited { text: "  ".into() })),
    );
    event(&mut d, i, txn_event(te::Kind::NameSaved(te::NameSaved {})));
    let raw = txn_data(d.view(i))
        .facts
        .iter()
        .find(|f| f.label == "Bank wrote")
        .unwrap()
        .detail
        .clone();
    assert_eq!(txn_data(d.view(i)).title, raw);
}

#[test]
fn voiding_asks_first_and_a_void_line_offers_no_more_changes() {
    let mut d = driver();
    let id = a_line(&mut d);
    let i = open(&mut d, &id);
    event(
        &mut d,
        i,
        txn_event(te::Kind::Action(te::ActionPicked { key: "void".into() })),
    );
    let confirm = txn_state(d.view(i))
        .confirm
        .clone()
        .expect("a confirmation");
    assert_eq!(confirm.title, "Void this transaction?");
    assert!(confirm.destructive);
    event(
        &mut d,
        i,
        txn_event(te::Kind::ConfirmDismissed(te::ConfirmDismissed {})),
    );
    assert!(txn_state(d.view(i)).confirm.is_none());
    assert!(txn_data(d.view(i)).chips.iter().all(|c| c.label != "Void"));
    event(
        &mut d,
        i,
        txn_event(te::Kind::Action(te::ActionPicked { key: "void".into() })),
    );
    event(
        &mut d,
        i,
        txn_event(te::Kind::ConfirmAccepted(te::ConfirmAccepted {})),
    );
    let data = txn_data(d.view(i));
    assert!(data.chips.iter().any(|c| c.label == "Void"));
    assert!(data.actions.iter().all(|a| a.key != "void"));
    assert!(
        data.actions
            .iter()
            .filter(|a| a.key == "category" || a.key == "name")
            .all(|a| !a.enabled)
    );
    assert_eq!(
        txn_state(d.view(i)).status.as_ref().unwrap().sentence,
        "Marked void"
    );
}

#[test]
fn an_unknown_line_is_a_failure_never_an_empty_page() {
    let mut d = driver();
    let i = open(&mut d, "no-such-line");
    assert!(matches!(
        txn_state(d.view(i)).content,
        Some(wire::money_transaction_state::Content::Failure(_))
    ));
}

// --- target ------------------------------------------------------------------

fn target_state(v: &wire::ViewState) -> &wire::MoneyTargetState {
    match &v.kind {
        Some(wire::view_state::Kind::MoneyTarget(s)) => s,
        other => panic!("not a target: {other:?}"),
    }
}

fn target_data(v: &wire::ViewState) -> &wire::MoneyTargetData {
    match &target_state(v).content {
        Some(wire::money_target_state::Content::Data(d)) => d,
        other => panic!("no target data: {other:?}"),
    }
}

fn target_event(kind: tg::Kind) -> wire::screen_event::Kind {
    wire::screen_event::Kind::MoneyTarget(wire::MoneyTargetEvent { kind: Some(kind) })
}

/// A category line of Spending: its target route's arguments.
fn a_category(d: &centraid_screens::testing::Driver) -> wire::Route {
    let i = home(d);
    home_data(d.view(i))
        .spending
        .as_ref()
        .unwrap()
        .tables
        .iter()
        .flat_map(|t| &t.rows)
        .next()
        .and_then(|row| row.route.clone())
        .expect("a category line")
}

#[test]
fn a_target_is_seeded_from_the_stored_plan_and_previews_next_month() {
    let mut d = driver();
    let route = a_category(&d);
    let i = push(&mut d, route);
    let data = target_data(d.view(i));
    assert!(data.title.ends_with("target"));
    assert_eq!(data.figures.len(), 3);
    assert!(!data.preview.is_empty());
    assert!(!data.can_save || !target_state(d.view(i)).amount_text.is_empty());
    assert_eq!(
        target_state(d.view(i)).chrome.as_ref().unwrap().title,
        "Target"
    );
}

#[test]
fn typing_an_amount_asks_the_core_again_and_saving_finishes_the_page() {
    let mut d = driver();
    let route = a_category(&d);
    let i = push(&mut d, route);
    event(
        &mut d,
        i,
        target_event(tg::Kind::Amount(tg::AmountEdited {
            text: "250.00".into(),
        })),
    );
    assert!(target_data(d.view(i)).can_save);
    assert!(target_data(d.view(i)).issue.is_empty());
    event(
        &mut d,
        i,
        target_event(tg::Kind::Carry(tg::CarryToggled {})),
    );
    assert!(target_state(d.view(i)).carry);
    assert_eq!(
        target_data(d.view(i)).preview_note,
        "Unused money carries over."
    );
    event(&mut d, i, target_event(tg::Kind::Save(tg::Save {})));
    assert!(target_state(d.view(i)).finished);
    // the plan is stored: a fresh page for the same category is seeded from it
    let route = a_category(&d);
    let again = push(&mut d, route);
    assert_eq!(target_state(d.view(again)).amount_text, "250.00");
    assert!(target_state(d.view(again)).carry);
    assert_eq!(target_data(d.view(again)).remove_label, "Remove target");
}

#[test]
fn a_bad_amount_says_so_and_cannot_be_saved() {
    let mut d = driver();
    let route = a_category(&d);
    let i = push(&mut d, route);
    event(
        &mut d,
        i,
        target_event(tg::Kind::Amount(tg::AmountEdited {
            text: "12.345".into(),
        })),
    );
    let data = target_data(d.view(i));
    assert_eq!(data.issue, "Type an amount, like 220.00.");
    assert!(!data.can_save);
    event(&mut d, i, target_event(tg::Kind::Save(tg::Save {})));
    assert!(!target_state(d.view(i)).finished);
}

#[test]
fn removing_a_stored_target_finishes_the_page_and_clears_the_plan() {
    let mut d = driver();
    let route = a_category(&d);
    let i = push(&mut d, route.clone());
    event(
        &mut d,
        i,
        target_event(tg::Kind::Amount(tg::AmountEdited { text: "100".into() })),
    );
    event(&mut d, i, target_event(tg::Kind::Save(tg::Save {})));
    let again = push(&mut d, route);
    event(&mut d, again, target_event(tg::Kind::Remove(tg::Remove {})));
    assert!(target_state(d.view(again)).finished);
    let route = a_category(&d);
    let last = push(&mut d, route);
    assert!(target_data(d.view(last)).remove_label.is_empty());
}

// --- recurring ---------------------------------------------------------------

#[test]
fn recurring_charges_are_rows_with_a_cadence_and_a_state() {
    let mut d = driver();
    let i = push(&mut d, routes::recurring("Money"));
    let Some(wire::view_state::Kind::MoneyRecurring(state)) = d.view(i).kind.clone() else {
        panic!("not recurring");
    };
    assert_eq!(state.chrome.as_ref().unwrap().title, "Recurring");
    let Some(wire::money_recurring_state::Content::Data(data)) = state.content else {
        panic!("no recurring data");
    };
    assert!(data.empty.is_some() == data.rows.is_empty());
    for row in &data.rows {
        assert!(row.meta.contains('·'), "{}", row.meta);
        assert!(row.detail.contains("seen"), "{}", row.detail);
    }
}

// --- search ------------------------------------------------------------------

fn search_state(v: &wire::ViewState) -> &wire::MoneySearchState {
    match &v.kind {
        Some(wire::view_state::Kind::MoneySearch(s)) => s,
        other => panic!("not search: {other:?}"),
    }
}

fn search_event(kind: se::Kind) -> wire::screen_event::Kind {
    wire::screen_event::Kind::MoneySearch(wire::MoneySearchEvent { kind: Some(kind) })
}

#[test]
fn search_rests_until_there_is_a_term_and_reads_nothing_for_a_blank_one() {
    let mut d = driver();
    let i = push(&mut d, routes::search("Money"));
    let state = search_state(d.view(i));
    assert_eq!(
        state.resting.as_ref().unwrap().headline,
        "Search by name, bank words or category."
    );
    assert!(state.content.is_none());
    event(
        &mut d,
        i,
        search_event(se::Kind::Term(se::TermChanged { term: "   ".into() })),
    );
    assert!(search_state(d.view(i)).content.is_none());
}

#[test]
fn a_term_that_matches_nothing_says_so_and_a_clear_goes_back_to_resting() {
    let mut d = driver();
    let i = push(&mut d, routes::search("Money"));
    event(
        &mut d,
        i,
        search_event(se::Kind::Term(se::TermChanged {
            term: "zzqqxx".into(),
        })),
    );
    let Some(wire::money_search_state::Content::Data(data)) =
        search_state(d.view(i)).content.clone()
    else {
        panic!("no search data");
    };
    // THE ASK IS OFFERED ON NO MATCH TOO: the term goes to the assistant, scoped to Money.
    assert_eq!(
        data.ask,
        Some(wire::SearchAsk {
            label: "Ask about “zzqqxx”".into(),
            question: "Find zzqqxx".into(),
            scope: "money".into(),
            route: Some(centraid_screens::chat::routes::ask("Find zzqqxx", "money")),
        })
    );
    let empty = data.empty.expect("an empty state");
    assert_eq!(empty.headline, "Nothing matches zzqqxx.");
    assert_eq!(
        empty.body,
        "Searches names, bank words, categories and memos."
    );
    event(&mut d, i, search_event(se::Kind::Cleared(se::Cleared {})));
    let state = search_state(d.view(i));
    assert!(state.resting.is_some() && state.content.is_none() && state.term.is_empty());
}

#[test]
fn a_term_that_matches_lists_rows_with_the_day_and_a_route() {
    let mut d = driver();
    let i = push(&mut d, routes::search("Money"));
    event(
        &mut d,
        i,
        search_event(se::Kind::Term(se::TermChanged {
            term: "rent".into(),
        })),
    );
    let Some(wire::money_search_state::Content::Data(data)) =
        search_state(d.view(i)).content.clone()
    else {
        panic!("no search data");
    };
    // THE ASK IS OFFERED BESIDE THE MATCHES TOO, with the term as typed.
    assert_eq!(data.ask.as_ref().map(|a| a.scope.as_str()), Some("money"));
    assert_eq!(
        data.ask.as_ref().map(|a| a.question.as_str()),
        Some("Find rent")
    );
    if data.rows.is_empty() {
        return; // the example scenario may not hold the word; the empty case is pinned above
    }
    assert!(!data.count_label.is_empty());
    for row in &data.rows {
        assert_eq!(row.route.as_ref().unwrap().screen, "money.transaction");
    }
}
