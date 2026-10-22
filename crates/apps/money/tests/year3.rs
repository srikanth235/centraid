//! THE YEAR-3 MONEY CEILING, through the real command path (#1135, #1099).
//!
//! 18,000 transactions over four accounts (`year3::year3`), read by the real CSV
//! reader, planned, followed through `follow.statement` (each account's origin
//! is its statement), read back through Money's own screens over the paged door,
//! and reconciled against arithmetic done straight from the parsed rows.
//!
//! The sample is the quick run; the full profile is `#[ignore]` and runs on its
//! own: `cargo test -p centraid-apps-money --test year3 -- --ignored --nocapture`.
//!
//! **A timing here is a DEBUG build** and is projected provenance, never a ceiling.

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
use common::World;
use serde_json::{Value, json};

const TODAY: &str = "2025-01-15";
const KINDS: [&str; 4] = ["checking", "credit_card", "savings", "cash"];

fn records(rows: &[ImportRow]) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let mut line = serde_json::Map::new();
            line.insert("imported_from".to_owned(), "csv".into());
            for (key, value) in [("memo", &row.memo), ("bank_type", &row.bank_type)] {
                if let Some(value) = value {
                    line.insert(key.to_owned(), value.as_str().into());
                }
            }
            json!({
                "external_id": row.external_id,
                "fields": {
                    "title": row.description,
                    "posted_on": row.posted_on,
                    "amount_minor": row.signed_minor(),
                    "line": line,
                }
            })
        })
        .collect()
}

fn follow(world: &World, account: &str, rows: &[ImportRow]) -> Value {
    world.ok(
        "follow.statement",
        json!({
            "origin": { "ref": account, "label": "Statement", "fills": account },
            "records": records(rows),
        }),
    )
}

/// Import `accounts` accounts of the profile and read every screen back.
fn run(accounts: usize) {
    const { assert!(YEAR3.rows_per_account <= IMPORT_ROWS) };
    let world = World::founded("year3");
    let generated = year3(1_135_006);
    let mut parsed: Vec<Vec<ImportRow>> = Vec::new();
    let started = Instant::now();
    for (at, account) in generated.iter().take(accounts).enumerate() {
        let id = format!("acct-{at}");
        world.account(&id, &account.name, KINDS[at], account.currency);
        let statement = read_csv(account.csv.as_bytes(), &CsvOptions::new(account.currency))
            .expect("a statement");
        let planned = plan(&statement, &id, account.currency, &[], &[], TODAY);
        assert_eq!(planned.totals.new, YEAR3.rows_per_account);
        let rows: Vec<ImportRow> = planned.rows.iter().filter_map(|r| r.row.clone()).collect();
        let answer = follow(&world, &id, &rows);
        assert_eq!(answer["added"], YEAR3.rows_per_account, "account {at}");
        parsed.push(rows);
    }
    println!(
        "followed {} lines in {:?}",
        accounts * YEAR3.rows_per_account,
        started.elapsed()
    );

    // RE-FOLLOWING THE SAME FILE WRITES NOTHING.
    let again = follow(&world, "acct-0", &parsed[0]);
    assert_eq!(
        (again["added"].as_i64(), again["updated"].as_i64()),
        (Some(0), Some(0))
    );

    let screens = world
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let index = centraid_search::SqliteDoor::open(connection, world.vault.words())
                .expect("the index opens");
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
                phone::search(&door, &index, "netflix", 20, TODAY).expect("search"),
            );
            println!("six screens in {:?}", started.elapsed());
            // THE CEILINGS HOLD.
            let lookback = load_lookback(&door, "2024-12", 13).expect("lookback");
            assert!(!lookback.truncated);
            for account in load_accounts(&door).expect("accounts") {
                let ledger = load_ledger(&door, &account.account_id).expect("ledger");
                assert!(!ledger.truncated);
                assert!(ledger.value.len() <= ACCOUNT_ROWS);
            }
            let month =
                queries::load_month(&door, "2024-06", &ActivityFilter::default()).expect("month");
            assert!(month.value.len() < MONTH_ROWS && !month.truncated);
            Ok(answers)
        })
        .expect("reads");

    // RECONCILIATION against arithmetic done from the parsed rows alone.
    let (spending, cashflow, accounts_view, ..) = screens;
    let (mut june_out, mut june_in, mut dec_out) = (0_i64, 0_i64, 0_i64);
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
    let expected: BTreeMap<String, i64> = parsed
        .iter()
        .enumerate()
        .map(|(at, rows)| {
            (
                format!("acct-{at}"),
                rows.iter().map(ImportRow::signed_minor).sum(),
            )
        })
        .collect();
    let mut seen = 0;
    for line in accounts_view
        .on_budget
        .iter()
        .chain(&accounts_view.off_budget)
    {
        assert_eq!(
            line.balance.as_ref().map(|m| m.amount_minor),
            Some(expected[&line.account_id]),
            "{}",
            line.account_id
        );
        seen += 1;
    }
    assert_eq!(seen, accounts);
    let total: i64 = expected.values().sum();
    assert_eq!(accounts_view.net_worth[0].amount.amount_minor, total);
    assert_eq!(engine::CARRY_MONTHS, 12);
}

/// A QUARTER OF THE PROFILE: one account of 4,500 lines, the shape of the full run.
#[test]
fn one_account_of_the_profile_follows_reads_and_reconciles() {
    run(1);
}

/// THE FULL PROFILE: 18,000 lines over four accounts and three years.
#[test]
#[ignore = "the full year-3 profile; run on its own with --ignored"]
fn eighteen_thousand_rows_follow_read_and_reconcile() {
    run(YEAR3.accounts);
}
