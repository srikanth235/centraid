//! One transaction, a category's target, recurring charges and search. Ports of
//! the matching cases of `MoneyScreensSpec`, through the door a shell uses.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
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
    assert!(keys.contains(&"category") && keys.contains(&"name") && keys.contains(&"trash"));
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

/// A void is what a member could do before the trash (#1185), and a vault may still hold one: the
/// page draws it struck with its chip, offers no more changes to it, and offers no void (the one
/// control left is Move to trash).
#[test]
fn a_void_line_a_vault_already_holds_offers_no_more_changes_and_no_void() {
    let mut d = driver();
    let id = a_line(&mut d);
    let voided = d
        .handle
        .command("txn.void", &serde_json::json!({ "id": id }), "void-fixture")
        .expect("the vault voids it");
    assert_eq!(voided.status, centraid_vault::CommandStatus::Executed);
    let i = open(&mut d, &id);
    let data = txn_data(d.view(i));
    assert!(data.chips.iter().any(|c| c.label == "Void"));
    assert!(data.actions.iter().all(|a| a.key != "void"));
    assert!(
        data.actions
            .iter()
            .filter(|a| a.key == "category" || a.key == "name")
            .all(|a| !a.enabled)
    );
    let trash = data
        .actions
        .iter()
        .find(|a| a.key == "trash")
        .expect("a voided line can still go to the trash");
    assert!(trash.enabled && trash.destructive);
    assert_eq!(trash.label, "Move to trash");
}

#[test]
fn an_unknown_line_is_a_failure_never_an_empty_page() {
    let mut d = driver();
    let i = open(&mut d, "no-such-line");
    // A line that is not there is the page's final failure, in its own words, with no Retry.
    let state = txn_state(d.view(i));
    assert!(state.content.is_none());
    let Some(wire::page_state::State::Failed(failure)) =
        state.page.as_ref().and_then(|page| page.state.as_ref())
    else {
        panic!("an unknown line is a failed page");
    };
    assert_eq!(failure.sentence, "This transaction is no longer here.");
    assert!(failure.permanent);
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
    // Spending is not the home tab any more: ask the core for the month, as the screen does.
    let wire::app_query_response::Answer::MoneySpending(spending) = load_answer(
        d,
        centraid_screens::catalog::load::money::Spending {
            month: String::new(),
        },
    ) else {
        panic!("not Spending");
    };
    let line = spending.categories.first().expect("a category line");
    routes::target(&spending.month, &line.category_id, &line.currency)
}

#[test]
fn a_target_is_a_sheet_over_money_and_the_pages_beside_it_are_not() {
    let d = driver();
    let route = a_category(&d);
    // THE ROUTE SAYS HOW IT OPENS: the shells never name the screen to know.
    assert!(route.sheet);
    assert!(!routes::search("Money").sheet);
    assert!(!routes::recurring("Money").sheet);
    assert!(!routes::home(wire::MoneyDestination::Unspecified).sheet);
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
    // The category comes from the live example month and can already have a
    // carry-enabled plan. This test starts with no plan before testing its toggle.
    let Some(wire::route::Args::MoneyTarget(args)) = &route.args else {
        panic!("target route");
    };
    let mut clear: wire::ActRequest = act::money::SetTarget {
        amount_minor: None,
        category_id: args.category_id.clone(),
        month: args.month.clone(),
        currency: Some(args.currency.clone()),
        carry: None,
    }
    .into();
    clear.invoke_key = format!("test:{}", centraid_screens::kit::act::fresh());
    assert_eq!(d.act(clear).status, wire::ActStatus::Executed as i32);
    let i = push(&mut d, route);
    assert!(!target_state(d.view(i)).carry);
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
    // No recurring charge is the page's own empty state; otherwise the rows are the data.
    let Some(wire::money_recurring_state::Content::Data(data)) = state.content else {
        assert!(empty_of(&state.page).is_some(), "no data is the empty page");
        return;
    };
    assert!(empty_of(&state.page).is_none());
    for row in &data.rows {
        assert!(row.meta.contains('·'), "{}", row.meta);
        assert!(row.detail.contains("seen"), "{}", row.detail);
        for chip in &row.chips {
            let tone = match chip.label.as_str() {
                "Paid" => wire::status_chip::Tone::Accent,
                "Due" => wire::status_chip::Tone::Neutral,
                _ => continue,
            };
            assert_eq!(chip.tone, tone as i32, "{}", chip.label);
        }
    }
}

// --- search ------------------------------------------------------------------

fn search_state(v: &wire::ViewState) -> &wire::MoneySearchState {
    match &v.kind {
        Some(wire::view_state::Kind::MoneySearch(s)) => s,
        other => panic!("not search: {other:?}"),
    }
}

/// The empty state of a page, when the page is empty.
fn empty_of(page: &Option<wire::PageState>) -> Option<&wire::EmptyState> {
    match page.as_ref().and_then(|page| page.state.as_ref()) {
        Some(wire::page_state::State::Empty(empty)) => Some(empty),
        _ => None,
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
        empty_of(&state.page)
            .expect("the resting page is empty")
            .headline,
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
    let empty = empty_of(&search_state(d.view(i)).page).expect("an empty state");
    assert_eq!(empty.headline, "Nothing matches zzqqxx.");
    assert_eq!(
        empty.body,
        "Searches names, bank words, categories and memos."
    );
    event(&mut d, i, search_event(se::Kind::Cleared(se::Cleared {})));
    let state = search_state(d.view(i));
    assert!(empty_of(&state.page).is_some() && state.content.is_none() && state.term.is_empty());
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

fn arrange(d: &centraid_screens::testing::Driver, request: impl Into<wire::ActRequest>) -> String {
    use centraid_screens::field::Keyed;
    let response = d.act(
        request
            .into()
            .keyed(format!("arrange:{}", centraid_screens::kit::act::fresh())),
    );
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "arranging was refused: {}",
        response.reason
    );
    serde_json::from_slice::<serde_json::Value>(&response.output)
        .ok()
        .and_then(|v| v["id"].as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn with_link(kind: wire::link_event::Kind) -> wire::screen_event::Kind {
    txn_event(te::Kind::WithLink(wire::LinkEvent { kind: Some(kind) }))
}

fn with_fact(v: &wire::ViewState) -> String {
    txn_data(v)
        .facts
        .iter()
        .find(|f| f.label == "With")
        .map(|f| f.detail.clone())
        .expect("a With fact")
}

#[test]
fn a_payee_that_names_a_person_is_proposed_and_written_only_when_confirmed() {
    use wire::link_event as le;
    let mut d = driver();
    let id = a_line(&mut d);
    arrange(
        &d,
        act::money::SetDisplayName {
            transaction_id: id.clone(),
            title: "UPI Priya Rao 4412".into(),
            expected_rev: None,
        },
    );
    let priya = arrange(
        &d,
        act::people::AddPerson {
            title: "Priya Rao".into(),
            ..Default::default()
        },
    );
    let i = open(&mut d, &id);
    assert_eq!(with_fact(d.view(i)), "No one");
    let offer = txn_data(d.view(i)).with_offer.clone().expect("a proposal");
    assert_eq!(offer.title, "With Priya Rao?");
    assert_eq!(offer.key, "with");
    // PROPOSED, NEVER WRITTEN: nothing is linked until Confirm.
    assert_eq!(with_fact(d.view(i)), "No one");
    // "Not them" takes the proposal off the page for this sitting.
    event(
        &mut d,
        i,
        txn_event(te::Kind::OfferDismissed(te::OfferDismissed {
            key: "with".into(),
        })),
    );
    assert!(txn_data(d.view(i)).with_offer.is_none());
    assert_eq!(with_fact(d.view(i)), "No one");
    // A new sitting proposes again; Confirm writes the link.
    let j = open(&mut d, &id);
    event(
        &mut d,
        j,
        txn_event(te::Kind::OfferAccepted(te::OfferAccepted {
            key: "with".into(),
        })),
    );
    assert_eq!(with_fact(d.view(j)), "Priya Rao");
    assert!(txn_data(d.view(j)).with_offer.is_none());
    assert_eq!(
        txn_state(d.view(j)).status.as_ref().unwrap().sentence,
        "Saved"
    );
    // The picker lists the people, the linked one selected; a tap on it takes the link off.
    event(
        &mut d,
        j,
        txn_event(te::Kind::Action(te::ActionPicked { key: "with".into() })),
    );
    let picker = txn_state(d.view(j)).with_picker.clone().expect("a picker");
    assert!(picker.open && picker.loaded);
    let row = picker
        .candidates
        .iter()
        .find(|c| c.id == priya)
        .expect("the person is offered");
    assert!(row.selected);
    event(
        &mut d,
        j,
        with_link(le::Kind::Query(le::QueryChanged { text: "zzz".into() })),
    );
    let none = txn_state(d.view(j)).with_picker.clone().unwrap();
    assert!(none.candidates.is_empty());
    assert_eq!(none.empty, "No match");
    event(
        &mut d,
        j,
        with_link(le::Kind::Query(le::QueryChanged {
            text: "priya".into(),
        })),
    );
    event(
        &mut d,
        j,
        with_link(le::Kind::Pick(le::Picked { id: priya })),
    );
    assert!(!txn_state(d.view(j)).with_picker.clone().unwrap().open);
    assert_eq!(with_fact(d.view(j)), "No one");
}

#[test]
fn naming_a_line_that_changed_elsewhere_is_refused_and_the_typed_name_is_kept() {
    let mut d = driver();
    let id = a_line(&mut d);
    let i = open(&mut d, &id);
    event(
        &mut d,
        i,
        txn_event(te::Kind::Action(te::ActionPicked { key: "name".into() })),
    );
    event(
        &mut d,
        i,
        txn_event(te::Kind::NameEdited(te::NameEdited {
            text: "Mine".into(),
        })),
    );
    arrange(
        &d,
        act::money::SetDisplayName {
            transaction_id: id.clone(),
            title: "Theirs".into(),
            expected_rev: None,
        },
    );
    event(&mut d, i, txn_event(te::Kind::NameSaved(te::NameSaved {})));
    assert_eq!(txn_data(d.view(i)).title, "Theirs");
    assert_eq!(
        txn_state(d.view(i)).status.as_ref().unwrap().sentence,
        "This transaction changed somewhere else. Your text is in Earlier versions."
    );
}
