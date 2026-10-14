//! THE YEAR-3 MONEY CEILING, through the real command path (#1099).
//!
//! 18,000 transactions over four accounts (`year3::year3`), read by the real
//! CSV reader, imported through the real `money.import_transactions` via the
//! `vault-door` feature, read back through both keyset assemblers (the kit's
//! `TestDoor` over the vault's connection, and the vault's own `keyset_page`),
//! and reconciled against arithmetic done straight from the parsed rows.
//!
//! Run on its own: `cargo test -p centraid-apps-money --features vault-door
//! --test year3 -- --nocapture`.

#![cfg(feature = "vault-door")]

mod common;

use std::collections::BTreeMap;
use std::time::Instant;

use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_money::engine;
use centraid_apps_money::import::{CsvOptions, Direction, IMPORT_ROWS, ImportRow, plan, read_csv};
use centraid_apps_money::phone;
use centraid_apps_money::queries::{
    self, ACCOUNT_ROWS, ActivityFilter, MONTH_ROWS, load_accounts, load_ledger, load_lookback,
};
use centraid_apps_money::year3::{YEAR3, year3};
use common::{KeysetDoor, Scratch, add_account, execute};
use serde_json::json;

const TODAY: &str = "2025-01-15";

fn rows_json(account: usize, rows: &[ImportRow]) -> Vec<serde_json::Value> {
    rows.iter()
        .enumerate()
        .map(|(at, row)| {
            json!({
                "txn_id": format!("y3-{account}-{at}"),
                "external_id": row.external_id,
                "posted_on": row.posted_on,
                "amount_minor": row.amount_minor,
                "direction": row.direction.as_str(),
                "description": row.description,
                "memo": row.memo,
                "check_number": row.check_number,
                "bank_type": row.bank_type,
            })
        })
        .collect()
}

#[test]
fn eighteen_thousand_rows_import_read_and_reconcile() {
    const { assert!(YEAR3.rows_per_account <= IMPORT_ROWS) };
    let scratch = Scratch::founded("year3");
    let door = scratch.door();
    let kinds = ["checking", "credit_card", "savings", "cash"];
    let accounts = year3(1099);
    let mut parsed: Vec<Vec<ImportRow>> = Vec::new();
    let started = Instant::now();
    for (at, account) in accounts.iter().enumerate() {
        let id = format!("acct-{at}");
        add_account(&door, &id, &account.name, kinds[at], account.currency);
        let statement = read_csv(account.csv.as_bytes(), &CsvOptions::new(account.currency))
            .expect("a statement");
        let planned = plan(&statement, &id, account.currency, &[], &[], TODAY);
        assert_eq!(planned.totals.new, YEAR3.rows_per_account);
        let rows: Vec<ImportRow> = planned.rows.iter().filter_map(|r| r.row.clone()).collect();
        let output = execute(
            &door,
            "money.import_transactions",
            json!({ "account_id": id, "source": "csv", "rows": rows_json(at, &rows) }),
        );
        let outcomes = output["outcomes"].as_array().expect("outcomes");
        assert_eq!(outcomes.len(), YEAR3.rows_per_account);
        assert!(
            outcomes.iter().all(|o| o["outcome"] == "inserted"),
            "account {at}"
        );
        parsed.push(rows);
    }
    println!("imported 18,000 rows in {:?}", started.elapsed());

    // RE-IMPORTING THE SAME FILE WRITES NOTHING.
    let again = execute(
        &door,
        "money.import_transactions",
        json!({ "account_id": "acct-0", "source": "csv", "rows": rows_json(0, &parsed[0]) }),
    );
    assert!(
        again["outcomes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|o| o["outcome"] == "already_in")
    );

    // THE READS, over both assemblers, give the same answers.
    let by_test_door = scratch
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let started = Instant::now();
            let answers = (
                phone::spending(&door, "2024-06", TODAY).expect("spending"),
                phone::cashflow(&door, "2024-12", TODAY).expect("cashflow"),
                phone::accounts(&door, TODAY).expect("accounts"),
                phone::recurring_screen(&door, TODAY).expect("recurring"),
                phone::activity(
                    &door,
                    "2024-06",
                    &ActivityFilter::default(),
                    &PageRequest::first(50),
                    TODAY,
                )
                .expect("activity"),
                phone::search(&door, "2024-12", "netflix", 20, TODAY).expect("search"),
            );
            println!("six screens over TestDoor in {:?}", started.elapsed());
            Ok(answers)
        })
        .expect("reads");
    let keyset = KeysetDoor(&scratch.vault);
    let started = Instant::now();
    let by_keyset = (
        phone::spending(&keyset, "2024-06", TODAY).expect("spending"),
        phone::cashflow(&keyset, "2024-12", TODAY).expect("cashflow"),
        phone::accounts(&keyset, TODAY).expect("accounts"),
        phone::recurring_screen(&keyset, TODAY).expect("recurring"),
        phone::activity(
            &keyset,
            "2024-06",
            &ActivityFilter::default(),
            &PageRequest::first(50),
            TODAY,
        )
        .expect("activity"),
        phone::search(&keyset, "2024-12", "netflix", 20, TODAY).expect("search"),
    );
    println!(
        "six screens over the vault's keyset_page in {:?}",
        started.elapsed()
    );
    assert_eq!(by_test_door.0, by_keyset.0, "spending");
    for (a, b) in by_test_door.1.series[0]
        .months
        .iter()
        .zip(&by_keyset.1.series[0].months)
    {
        assert_eq!(a, b, "cash flow month {}", a.month);
    }
    assert_eq!(by_test_door.1, by_keyset.1, "cash flow");
    assert_eq!(by_test_door.2, by_keyset.2, "accounts");
    assert_eq!(by_test_door.3, by_keyset.3, "recurring");
    assert_eq!(by_test_door.4, by_keyset.4, "activity");
    assert_eq!(by_test_door.5, by_keyset.5, "search");

    // THE CEILINGS HOLD.
    let lookback = load_lookback(&keyset, "2024-12", 13).expect("lookback");
    assert!(!lookback.truncated);
    for account in load_accounts(&keyset).expect("accounts") {
        let ledger = load_ledger(&keyset, &account.account_id).expect("ledger");
        assert!(!ledger.truncated);
        assert!(ledger.value.len() <= ACCOUNT_ROWS);
    }
    let month = queries::load_month(&keyset, "2024-06", &ActivityFilter::default()).expect("month");
    assert!(month.value.len() < MONTH_ROWS && !month.truncated);

    // RECONCILIATION against arithmetic done from the parsed rows alone.
    let (spending, cashflow, accounts_view, ..) = by_keyset;
    let mut june_out = 0i64;
    let mut june_in = 0i64;
    let mut dec_out = 0i64;
    for rows in &parsed {
        for row in rows {
            match (
                row.posted_on.starts_with("2024-06"),
                row.posted_on.starts_with("2024-12"),
                row.direction,
            ) {
                (true, _, Direction::Debit) => june_out += row.amount_minor,
                (true, _, Direction::Credit) => june_in += row.amount_minor,
                (_, true, Direction::Debit) => dec_out += row.amount_minor,
                _ => {}
            }
        }
    }
    let usd = &spending.in_out_net[0];
    assert_eq!(usd.outgoing.amount_minor, june_out);
    assert_eq!(usd.incoming.amount_minor, june_in);
    assert_eq!(usd.net.amount_minor, june_in - june_out);
    let december = cashflow.series[0].months.last().expect("a month");
    assert_eq!(december.outgoing.amount_minor, dec_out);
    let mut expected_balance: BTreeMap<String, i64> = BTreeMap::new();
    for (at, rows) in parsed.iter().enumerate() {
        expected_balance.insert(
            format!("acct-{at}"),
            rows.iter().map(ImportRow::signed_minor).sum(),
        );
    }
    let listed = accounts_view
        .on_budget
        .iter()
        .chain(&accounts_view.off_budget);
    let mut seen = 0;
    for line in listed {
        assert_eq!(
            line.balance.as_ref().map(|m| m.amount_minor),
            Some(expected_balance[&line.account_id]),
            "{}",
            line.account_id
        );
        seen += 1;
    }
    assert_eq!(seen, 4);
    let total: i64 = expected_balance.values().sum();
    assert_eq!(accounts_view.net_worth[0].amount.amount_minor, total);
    assert_eq!(engine::CARRY_MONTHS, 12);
}
