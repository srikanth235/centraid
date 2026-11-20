//! What chat writes of Money (the owner's ruling of 2026-11-20): an account's opening balance and
//! currency, a plan's amount, and a transaction's amount and day; every amount read and written with
//! its currency; no transaction created. Each test asks the vault what it holds afterwards.

mod common;

use centraid_apps_kit::row::Cell;
use centraid_nativetools::vaultio::{Handle, SetClock};
use common::{World, call, seeded_with};
use serde_json::{Value, json};

fn world_json() -> Value {
    json!({
        "me": "Sam Park", "epoch": "2026-01-05T09:00", "seed": "money", "currency": "USD",
        "accounts": [
            {"key": "everyday", "name": "Everyday", "kind": "checking"},
            {"key": "travel", "name": "Travel card", "kind": "credit_card", "currency": "EUR"},
            {"key": "empty", "name": "Empty", "kind": "savings"}
        ],
        "transactions": [
            {"key": "coffee", "account": "everyday", "date": "2026-09-26", "amount": -4.5,
             "name": "Blue Bottle", "description": "BLUE BOTTLE #12", "category": "food.dining"},
            {"key": "pay", "account": "everyday", "date": "2026-09-15", "amount": 2500,
             "name": "Acme payroll", "description": "ACME CORP PAYROLL", "category": "income.pay"},
            {"key": "bistro", "account": "travel", "date": "2026-09-02", "amount": -30,
             "name": "Le Bistro", "description": "LE BISTRO PARIS", "category": "food.dining"}
        ],
        "budgets": [{"month": "2026-09", "category": "food.dining", "amount": 300}]
    })
}

/// What the vault holds: `columns` of the rows of `table` that satisfy `predicate`, each row as
/// its cells joined by `|`.
fn held(world: &World, table: &str, columns: &str, predicate: &str, binds: &[&str]) -> Vec<String> {
    let handle = Handle::open(world.path(), SetClock::at(1_900_000_000_000), "money-edits")
        .expect("the vault opens");
    let binds: Vec<String> = binds.iter().map(|bind| (*bind).to_owned()).collect();
    let pk = if table == "budget" {
        "category_id"
    } else {
        "id"
    };
    handle
        .table_where(table, columns, pk, pk, predicate, &binds)
        .expect("a read")
        .iter()
        .map(|row| {
            columns
                .split(',')
                .map(|column| match row.get(column.trim()) {
                    Some(Cell::Integer(value)) => value.to_string(),
                    Some(Cell::Text(value)) => value.clone(),
                    Some(Cell::Real(value)) => value.to_string(),
                    _ => String::new(),
                })
                .collect::<Vec<_>>()
                .join("|")
        })
        .collect()
}

fn line(world: &World, key: &str) -> String {
    held(
        world,
        "txn",
        "id, amount_minor, currency, posted_on",
        "id = ?",
        &[&world.id(key)],
    )
    .remove(0)
    .split_once('|')
    .map(|(_, rest)| rest.to_owned())
    .unwrap_or_default()
}

fn account(world: &World, key: &str) -> String {
    held(
        world,
        "account",
        "id, currency, opening_minor, opening_on",
        "id = ?",
        &[&world.id(key)],
    )
    .remove(0)
    .split_once('|')
    .map(|(_, rest)| rest.to_owned())
    .unwrap_or_default()
}

fn edit(session: &mut centraid_nativetools::Session, kind: &str, name: &str, args: &str) -> Value {
    let row = common::number(session, kind, name);
    call(
        session,
        "act",
        json!({"verb": "edit", "rows": row, "args": args}),
    )
}

#[test]
fn a_transaction_amount_keeps_its_direction_and_its_currency() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    let done = edit(&mut session, "transaction", "Blue Bottle", "amount: 5.25");
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("edited"),
        "{done}"
    );
    // money out stays out when the member states no sign
    assert_eq!(line(&world, "coffee"), "-525|USD|2026-09-26");
    // a stated sign is the member's, and a figure in the Indian grouping reads whole
    let done = edit(
        &mut session,
        "transaction",
        "Acme payroll",
        "amount: 2,50,000",
    );
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("edited"),
        "{done}"
    );
    assert_eq!(line(&world, "pay"), "25000000|USD|2026-09-15");
    let done = edit(&mut session, "transaction", "Blue Bottle", "amount: -$6");
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("edited"),
        "{done}"
    );
    assert_eq!(line(&world, "coffee"), "-600|USD|2026-09-26");
    // another currency than the line's is refused and nothing is written
    let refused = edit(
        &mut session,
        "transaction",
        "Blue Bottle",
        "amount: \u{20ac}6",
    );
    let said = refused["text"].as_str().unwrap_or_default();
    assert!(
        said.starts_with("error:") && said.contains("USD"),
        "{refused}"
    );
    assert_eq!(line(&world, "coffee"), "-600|USD|2026-09-26");
    // more places than the currency has is refused, never rounded
    let refused = edit(&mut session, "transaction", "Blue Bottle", "amount: 6.255");
    assert!(
        refused["text"]
            .as_str()
            .unwrap_or_default()
            .contains("2 decimal places"),
        "{refused}"
    );
}

#[test]
fn a_transaction_day_is_corrected_with_reschedule_and_the_amount_stays() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    session.user("");
    call(
        &mut session,
        "find",
        json!({"kind": "transaction", "name": "Blue Bottle"}),
    );
    let done = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": "#1", "args": "to: {\"date\":\"2026-09-25\"}"}),
    );
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("rescheduled"),
        "{done}"
    );
    assert_eq!(line(&world, "coffee"), "-450|USD|2026-09-25");
    // taking it back is the undo of the turn
    session.user("");
    let undone = call(&mut session, "act", json!({"verb": "undo"}));
    assert!(
        undone["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("undone"),
        "{undone}"
    );
    assert_eq!(line(&world, "coffee"), "-450|USD|2026-09-26");
}

#[test]
fn chat_still_creates_no_transaction() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    let out = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "transaction", "args": "name: Lunch\namount: 12"}),
    );
    assert!(
        out["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("error:"),
        "{out}"
    );
    assert_eq!(
        held(&world, "txn", "id", "1 = 1", &[]).len(),
        3,
        "no line was added"
    );
}

#[test]
fn an_opening_balance_is_an_amount_in_the_accounts_currency_as_of_a_day() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    let done = edit(
        &mut session,
        "account",
        "Everyday",
        "opening: $1,200\nopening_on: 2026-01-01",
    );
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("edited"),
        "{done}"
    );
    assert_eq!(account(&world, "everyday"), "USD|120000|2026-01-01");
    // the amount alone keeps the day it was true
    let done = edit(&mut session, "account", "Everyday", "opening: 1500");
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("edited"),
        "{done}"
    );
    assert_eq!(account(&world, "everyday"), "USD|150000|2026-01-01");
    // a euro account holds euros, and a dollar sign on it is refused
    let refused = edit(
        &mut session,
        "account",
        "Travel card",
        "opening: $40\nopening_on: 2026-01-01",
    );
    let said = refused["text"].as_str().unwrap_or_default();
    assert!(
        said.starts_with("error:") && said.contains("EUR"),
        "{refused}"
    );
    let done = edit(
        &mut session,
        "account",
        "Travel card",
        "opening: -\u{20ac}40\nopening_on: 2026-01-01",
    );
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("edited"),
        "{done}"
    );
    assert_eq!(account(&world, "travel"), "EUR|-4000|2026-01-01");
    // an opening balance that is not nothing needs its day
    let refused = edit(&mut session, "account", "Empty", "opening: 10");
    assert!(
        refused["text"].as_str().unwrap_or_default().contains("day"),
        "{refused}"
    );
    assert_eq!(account(&world, "empty"), "USD|0|");
}

#[test]
fn an_account_changes_currency_only_while_it_has_no_transactions() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    let done = edit(&mut session, "account", "Empty", "currency: INR");
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("edited"),
        "{done}"
    );
    assert_eq!(account(&world, "empty"), "INR|0|");
    let refused = edit(&mut session, "account", "Everyday", "currency: EUR");
    assert!(
        refused["text"]
            .as_str()
            .unwrap_or_default()
            .contains("keeps its currency"),
        "{refused}"
    );
    assert_eq!(account(&world, "everyday"), "USD|0|");
}

#[test]
fn an_account_is_created_with_its_currency_and_its_opening_balance() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    session.user("");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "account",
               "args": "name: Mumbai savings\ntype: savings\ncurrency: INR\nopening: \u{20b9}2.5 lakh\nopening_on: 2026-01-01"}),
    );
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("created"),
        "{done}"
    );
    let made = held(
        &world,
        "account",
        "id, currency, opening_minor, opening_on",
        "currency = ? AND opening_minor <> 0",
        &["INR"],
    );
    assert_eq!(made.len(), 1, "{made:?}");
    assert!(made[0].ends_with("|INR|25000000|2026-01-01"), "{made:?}");
    // a figure with no day is the member's to complete: nothing was made
    session.user("");
    let refused = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "account", "args": "name: Other\ntype: cash\nopening: 40"}),
    );
    assert!(
        refused["text"]
            .as_str()
            .unwrap_or_default()
            .contains("opening_on"),
        "{refused}"
    );
    assert_eq!(held(&world, "account", "id", "1 = 1", &[]).len(), 4);
}

#[test]
fn a_plans_amount_is_sent_with_its_currency() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    let plan = |world: &World| {
        held(
            world,
            "budget",
            "category_id, month, amount_minor, currency, carry",
            "month = ?",
            &["2026-09"],
        )
    };
    assert!(
        plan(&world)[0].ends_with("|2026-09|30000|USD|0"),
        "{:?}",
        plan(&world)
    );
    let done = edit(&mut session, "budget", "Dining out", "amount: 450");
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("edited"),
        "{done}"
    );
    assert!(
        plan(&world)[0].ends_with("|2026-09|45000|USD|0"),
        "{:?}",
        plan(&world)
    );
    // another currency is the plan's own, with its own minor unit
    let done = edit(&mut session, "budget", "Dining out", "amount: 50000 JPY");
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("edited"),
        "{done}"
    );
    assert!(
        plan(&world)[0].ends_with("|2026-09|50000|JPY|0"),
        "{:?}",
        plan(&world)
    );
    // carry is its own command
    let done = edit(&mut session, "budget", "Dining out", "carry: yes");
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("edited"),
        "{done}"
    );
    assert!(
        plan(&world)[0].ends_with("|2026-09|50000|JPY|1"),
        "{:?}",
        plan(&world)
    );
    // a change of currency alone cannot move the figure between minor units
    let refused = edit(&mut session, "budget", "Dining out", "currency: USD");
    assert!(
        refused["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("error:"),
        "{refused}"
    );
    assert!(
        plan(&world)[0].ends_with("|2026-09|50000|JPY|1"),
        "{:?}",
        plan(&world)
    );
}

/// What the patched world shows after each of these writes is what the vault holds (`Writes::Shadow`
/// runs every step for real and compares): no part of Money's edits drifts.
#[test]
fn the_patched_world_follows_the_vault_through_every_money_edit() {
    use centraid_nativetools::Flags;
    use centraid_nativetools::park::Writes;
    let world = seeded_with(&world_json());
    let mut session = world.session_with(
        common::TODAY,
        Flags {
            writes: Writes::Shadow,
            ..common::s2_flags()
        },
    );
    let mut steps: Vec<Value> = Vec::new();
    for (kind, name, args) in [
        ("transaction", "Blue Bottle", "amount: 5.25"),
        (
            "account",
            "Everyday",
            "opening: $1,200\nopening_on: 2026-01-01",
        ),
        ("account", "Everyday", "opening: 1500"),
        ("account", "Empty", "currency: INR"),
        ("budget", "Dining out", "amount: 450"),
        ("budget", "Dining out", "amount: 50000 JPY"),
        ("budget", "Dining out", "carry: yes"),
    ] {
        steps.push(edit(&mut session, kind, name, args));
        let drift = session.take_drift();
        assert!(
            drift.is_empty(),
            "{kind} {name} {args}: {}",
            drift.join("\n")
        );
    }
    for done in &steps {
        assert!(
            done["text"]
                .as_str()
                .unwrap_or_default()
                .starts_with("edited"),
            "{done}"
        );
    }
    session.user("");
    let row = common::number(&mut session, "transaction", "Blue Bottle");
    let moved = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": row, "args": "to: {\"date\":\"2026-09-25\"}"}),
    );
    assert!(
        moved["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("rescheduled"),
        "{moved}"
    );
    session.user("");
    let made = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "account",
               "args": "name: Mumbai savings\ntype: savings\ncurrency: INR\nopening: \u{20b9}2.5 lakh\nopening_on: 2026-01-01"}),
    );
    assert!(
        made["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("created"),
        "{made}"
    );
    let drift = session.take_drift();
    assert!(drift.is_empty(), "{}", drift.join("\n"));
}

/// Parked, an edit writes nothing; the member's tap writes it.
#[test]
fn a_parked_money_edit_waits_for_the_tap() {
    use centraid_nativetools::Flags;
    use centraid_nativetools::park::{Confirmed, Writes};
    let world = seeded_with(&world_json());
    let mut session = world.session_with(
        common::TODAY,
        Flags {
            writes: Writes::Park,
            ..common::s2_flags()
        },
    );
    let done = edit(&mut session, "transaction", "Blue Bottle", "amount: 5.25");
    assert!(
        done["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("edited"),
        "{done}"
    );
    assert_eq!(
        line(&world, "coffee"),
        "-450|USD|2026-09-26",
        "nothing is written yet"
    );
    let id = session
        .pending()
        .map(|pending| pending.id.clone())
        .expect("a parked write");
    assert!(matches!(session.confirm(&id), Confirmed::Done { .. }));
    assert_eq!(line(&world, "coffee"), "-525|USD|2026-09-26");
}
