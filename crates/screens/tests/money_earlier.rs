//! EARLIER VERSIONS of a transaction (#1185): the entry at the foot of the page with its count
//! (absent at zero), the kit's one list with the name and category a version held (the bank's
//! amount, day and account never change, so they never appear), Restore with no confirm, Undo, and
//! a change a statement pass made reading "From a statement". Every test goes through `Driver`,
//! over a vault seeded at a fixed instant.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::kit::earlier;
use centraid_screens::money::{self, routes};
use centraid_screens::testing::Driver;
use money_support::*;
use serde_json::json;
use wire::app_query_response::Answer;

/// Monday 9 November 2026, 09:00 UTC.
const NOW: i64 = 1_794_214_800_000;

fn seeded() -> Driver {
    let mut d = Driver::with_runtime_at(money::runtime(), NOW);
    d.start();
    d
}

fn command(d: &Driver, name: &str, input: serde_json::Value) -> serde_json::Value {
    static KEYS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let key = format!(
        "money-earlier-{}",
        KEYS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let outcome = d
        .handle
        .command(name, &input, &key)
        .expect("the command runs");
    assert_eq!(
        outcome.status,
        centraid_vault::CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
    outcome.output
}

fn statement(d: &Driver, category: Option<&str>) {
    command(
        d,
        "follow.statement",
        json!({ "origin": { "ref": "er", "label": "Statement", "fills": "er" },
                "records": [{ "external_id": "er:1", "fields": {
                    "title": "QQBISTRO CAFE", "posted_on": "2026-11-02", "amount_minor": -4_250,
                    "category_id": category,
                    "line": { "memo": "m", "imported_from": "csv" } } }] }),
    );
}

fn arrange(d: &Driver) -> String {
    command(
        d,
        "account.add",
        json!({ "id": "er", "title": "Earlier test", "type": "checking", "currency": "USD" }),
    );
    statement(d, None);
    let Answer::MoneyActivity(activity) = load_answer(
        d,
        load::money::Activity {
            month: "2026-11".to_owned(),
            account_id: Some("er".to_owned()),
            limit: 50,
            ..Default::default()
        },
    ) else {
        panic!("not activity");
    };
    activity.rows[0].txn_id.clone()
}

/// Two of the categories the example scenario seeds.
const GROCERIES: &str = "category:food.groceries";
const DINING: &str = "category:food.dining";

fn rename(d: &Driver, id: &str, title: &str) {
    let done = d.act(act_key(act::money::SetDisplayName {
        transaction_id: id.to_owned(),
        title: title.to_owned(),
        expected_rev: None,
    }));
    assert_eq!(done.status, wire::ActStatus::Executed as i32, "{done:?}");
}

fn categorize(d: &Driver, id: &str, category: &str) {
    let done = d.act(act_key(act::money::Categorize {
        ids: json!([id]).to_string(),
        category_id: Some(category.to_owned()),
    }));
    assert_eq!(done.status, wire::ActStatus::Executed as i32, "{done:?}");
}

fn act_key(request: impl Into<wire::ActRequest>) -> wire::ActRequest {
    use centraid_screens::field::Keyed;
    static KEYS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    request.into().keyed(format!(
        "earlier-act-{}",
        KEYS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}

fn the_name(d: &Driver, id: &str) -> String {
    match load_answer(
        d,
        load::money::Transaction {
            txn_id: id.to_owned(),
        },
    ) {
        Answer::MoneyTransaction(txn) => txn.display_name,
        other => panic!("{other:?}"),
    }
}

fn earlier_view(v: &wire::ViewState) -> &wire::EarlierView {
    match &v.kind {
        Some(wire::view_state::Kind::Earlier(view)) => view,
        other => panic!("not the earlier-versions screen: {other:?}"),
    }
}

fn rows(v: &wire::ViewState) -> &[wire::EarlierRow] {
    match &earlier_view(v).content {
        Some(wire::earlier_view::Content::Data(data)) => &data.rows,
        other => panic!("no data: {other:?}"),
    }
}

fn state(v: &wire::ViewState) -> &wire::MoneyTransactionState {
    match &v.kind {
        Some(wire::view_state::Kind::MoneyTransaction(s)) => s,
        other => panic!("not a transaction page: {other:?}"),
    }
}

fn open_earlier(d: &mut Driver, id: &str) -> u64 {
    let page = push(d, routes::transaction(id, "Money"));
    let entry = state(d.view(page)).earlier.clone().expect("the entry");
    push(d, entry.route.expect("a route"))
}

fn send(d: &mut Driver, i: u64, kind: wire::earlier_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::Earlier(wire::EarlierEvent { kind: Some(kind) }),
    );
}

/// The bistro line, renamed and categorized twice over: two earlier versions at least.
fn edited(d: &Driver) -> (String, String, String) {
    let id = arrange(d);
    categorize(d, &id, GROCERIES);
    categorize(d, &id, DINING);
    (id, GROCERIES.to_owned(), DINING.to_owned())
}

#[test]
fn the_page_offers_the_entry_with_the_count_only_once_there_is_something_earlier() {
    let mut d = seeded();
    let id = arrange(&d);
    let page = push(&mut d, routes::transaction(&id, "Money"));
    assert!(state(d.view(page)).earlier.is_none());
    d.pop(money::TAB, page);

    categorize(&d, &id, GROCERIES);
    categorize(&d, &id, DINING);
    let page = push(&mut d, routes::transaction(&id, "Money"));
    let entry = state(d.view(page)).earlier.clone().expect("the entry");
    assert_eq!(entry.label, "Earlier versions");
    assert_eq!(entry.count_label, "2");
    assert_eq!(entry.accessibility_label, "Earlier versions, 2");
    let route = entry.route.expect("a route");
    assert_eq!(route.screen, money::EARLIER);
    let Some(wire::route::Args::Earlier(args)) = route.args else {
        panic!("the shared route");
    };
    assert_eq!(args.entity_id, id);
}

#[test]
fn the_list_names_each_category_a_version_held_and_never_the_banks_figures() {
    let mut d = seeded();
    let (id, ..) = edited(&d);
    let i = open_earlier(&mut d, &id);
    let listed = rows(d.view(i)).to_vec();
    let lines: Vec<&str> = listed.iter().map(|row| row.value.as_str()).collect();
    assert_eq!(lines, ["Dining out", "Groceries", "Other details"]);
    assert!(listed[0].current && listed[0].restore_label.is_empty());
    assert!(listed[1..].iter().all(|row| row.restore_label == "Restore"));
    for row in &listed {
        assert!(
            !row.value.contains("42") && !row.value.contains("2026"),
            "the bank's amount and day never change, so never read: {}",
            row.value
        );
    }
}

#[test]
fn a_name_the_member_gave_reads_as_the_name_each_change_moved() {
    let mut d = seeded();
    let id = arrange(&d);
    categorize(&d, &id, GROCERIES);
    rename(&d, &id, "Bistro lunch");
    rename(&d, &id, "Bistro dinner");
    let i = open_earlier(&mut d, &id);
    let lines: Vec<String> = rows(d.view(i)).iter().map(|r| r.value.clone()).collect();
    // Each version holds what that change moved: the name, with a category only when it moved too.
    assert_eq!(lines[0], "Bistro dinner");
    assert_eq!(lines[1], "Bistro lunch");
    assert_eq!(lines[2], "QQBISTRO CAFE");
    assert_eq!(lines[3], "Other details");
}

#[test]
fn restore_asks_nothing_says_so_with_undo_and_undo_puts_it_back() {
    let mut d = seeded();
    let id = arrange(&d);
    rename(&d, &id, "Bistro lunch");
    rename(&d, &id, "Bistro dinner");
    let i = open_earlier(&mut d, &id);
    let first = rows(d.view(i))[1].seq;
    send(
        &mut d,
        i,
        wire::earlier_event::Kind::Restore(wire::earlier_event::RestoreTapped { seq: first }),
    );
    assert_eq!(the_name(&d, &id), "Bistro lunch", "the field is back");
    let status = earlier_view(d.view(i)).status.clone().expect("a status");
    assert_eq!(status.sentence, "Earlier version restored");
    assert_eq!(status.action_label, "Undo");

    send(
        &mut d,
        i,
        wire::earlier_event::Kind::StatusActed(wire::earlier_event::StatusActed {}),
    );
    assert_eq!(the_name(&d, &id), "Bistro dinner", "the restore is undone");
}

#[test]
fn a_change_a_statement_pass_made_reads_as_coming_from_a_statement() {
    let mut d = seeded();
    let id = arrange(&d);
    statement(&d, Some(GROCERIES));
    let i = open_earlier(&mut d, &id);
    let listed = rows(d.view(i)).to_vec();
    assert_eq!(listed.len(), 2);
    assert!(
        listed[0].label.ends_with(" · From a statement"),
        "{}",
        listed[0].label
    );
    assert!(!listed[1].label.contains("From"));
    assert_eq!(listed[0].value, "Groceries");
}

#[test]
fn a_read_that_fails_is_the_failed_state_never_an_empty_list() {
    let mut d = Driver::unfounded(money::runtime());
    d.start();
    let route = earlier::route(money::EARLIER, "some-id", "Money");
    let i = push(&mut d, route);
    assert!(matches!(
        earlier_view(d.view(i))
            .page
            .as_ref()
            .and_then(|page| page.state.as_ref()),
        Some(wire::page_state::State::Failed(_))
    ));
}

#[test]
fn a_statement_line_says_its_account_in_the_one_shared_line() {
    let mut d = driver();
    let id = arrange(&d);
    let page = push(&mut d, routes::transaction(&id, "Money"));
    let line = state(d.view(page)).origin.clone().expect("a line");
    assert_eq!(line.text, "From Earlier test");
    assert_eq!(line.accessibility_label, "Came from Earlier test");
    // The old bespoke "Imported" fact is gone: one mechanism says where it came from.
    let facts = match state(d.view(page)).content.as_ref() {
        Some(wire::money_transaction_state::Content::Data(data)) => data.facts.clone(),
        other => panic!("no data: {other:?}"),
    };
    assert!(facts.iter().all(|fact| fact.label != "Imported"));
}
