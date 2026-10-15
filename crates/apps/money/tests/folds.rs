//! THE READS AND THE FOLDS, against hand-computed fixtures (#1099, wave 3).
//!
//! `contracts/apps/money/rows.json` is a small ledger built through the
//! committed DDL; `spending.json`, `cashflow.json`, `balances.json`,
//! `targets.json` and `transfers.json` hold what each fold answers over it,
//! worked out by hand and explained in their `_` fields. The loaders run over
//! the kit's `TestDoor` (keyset assembler one; assembler two, the vault's
//! `keyset_page`, is proven by the core lane).
//!
//! No SQL appears here: the fixture is a JSON bundle and the reads are
//! statements-as-data.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_money::civil;
use centraid_apps_money::engine::{
    Context, SheetInput, SpentIndex, TargetMode, account_balance, cashflow, net_worth, spending,
    target_sheet, target_status, transfer_proposals,
};
use centraid_apps_money::import::Direction;
use centraid_apps_money::queries::{
    self, ActivityFilter, CategoryFilter, MONTH_ROWS, TxnRow, load_accounts, load_activity_page,
    load_categories, load_checkpoints, load_ledger, load_month, load_rules, load_targets,
    load_transfer_candidates, load_transfer_links, search,
};
use rusqlite::Connection;
use serde_json::Value;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn fixture(name: &str) -> Value {
    let text = fs::read_to_string(root().join("contracts/apps/money").join(name))
        .unwrap_or_else(|e| panic!("{name}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn vault() -> Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql")).expect("DDL");
    let rows = fs::read_to_string(root().join("contracts/apps/money/rows.json")).expect("rows");
    open_contract_vault(&ddl, &rows).expect("the fixture vault is built")
}

struct World {
    accounts: Vec<queries::AccountRow>,
    categories: Vec<queries::CategoryRow>,
    linked: BTreeSet<String>,
}

fn world(door: &TestDoor<'_>) -> World {
    let links = load_transfer_links(door).expect("links").value;
    World {
        accounts: load_accounts(door).expect("accounts"),
        categories: load_categories(door).expect("categories"),
        linked: links
            .iter()
            .flat_map(|l| [l.from_txn.clone(), l.to_txn.clone()])
            .collect(),
    }
}

fn context<'a>(world: &'a World, today: &'a str) -> Context<'a> {
    Context {
        accounts: &world.accounts,
        categories: &world.categories,
        linked: &world.linked,
        today,
    }
}

fn windows(door: &TestDoor<'_>, through: &str, count: usize) -> Vec<(String, Vec<TxnRow>)> {
    let mut out = Vec::new();
    for back in (0..count).rev() {
        let month = civil::add_months(through, -i32::try_from(back).unwrap()).unwrap();
        let rows = load_month(door, &month, &ActivityFilter::default())
            .expect("month")
            .value;
        out.push((month, rows));
    }
    out
}

fn i(value: &Value) -> i64 {
    value.as_i64().expect("an integer")
}

#[test]
fn spending_reconciles_with_the_hand_computed_month() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let world = world(&door);
    let case = fixture("spending.json");
    let today = case["today"].as_str().unwrap();
    let month = case["month"].as_str().unwrap();
    let rows = load_month(&door, month, &ActivityFilter::default()).expect("month");
    assert!(!rows.truncated);
    let folded = spending(&rows.value, month, &context(&world, today));
    let expected = case["expected"].as_object().unwrap();
    assert_eq!(
        folded.len(),
        expected.len(),
        "one entry per currency, no sum across them"
    );
    for entry in &folded {
        let want = &expected[&entry.currency];
        assert_eq!(
            entry.spent_minor,
            i(&want["spent"]),
            "{} spent",
            entry.currency
        );
        assert_eq!(entry.refund_credit_minor, i(&want["refund_credit"]));
        assert_eq!(entry.in_minor, i(&want["in"]));
        assert_eq!(entry.out_minor, i(&want["out"]));
        assert_eq!(entry.net_minor(), i(&want["net"]));
        let lines: Vec<(Option<String>, i64, i64)> = entry
            .lines
            .iter()
            .map(|l| (l.category_id.clone(), l.spent_minor, l.refund_credit_minor))
            .collect();
        let wanted: Vec<(Option<String>, i64, i64)> = want["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| {
                (
                    l["category"].as_str().map(str::to_owned),
                    i(&l["spent"]),
                    i(&l["refund_credit"]),
                )
            })
            .collect();
        assert_eq!(lines, wanted, "{} lines", entry.currency);
        assert_eq!(
            (
                entry.transfers_excluded_count as i64,
                entry.transfers_excluded_minor
            ),
            (
                i(&want["transfers_excluded"]["count"]),
                i(&want["transfers_excluded"]["amount"])
            )
        );
        assert_eq!(
            (entry.future_count as i64, entry.future_minor),
            (i(&want["future"]["count"]), i(&want["future"]["amount"]))
        );
    }
}

#[test]
fn a_category_refunded_past_its_purchases_shows_a_refund_credit_and_lowers_nothing_else() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let mut world = world(&door);
    world.linked.clear();
    let mut rows = load_month(&door, "2024-03", &ActivityFilter::default())
        .unwrap()
        .value;
    // Refund the groceries past what was bought.
    for row in &mut rows {
        if row.txn_id == "t12" {
            row.amount_minor = 9_000;
        }
    }
    let folded = spending(&rows, "2024-03", &context(&world, "2024-03-20"));
    let usd = folded.iter().find(|f| f.currency == "USD").unwrap();
    let groceries = usd
        .lines
        .iter()
        .find(|l| l.category_id.as_deref() == Some("money:cat:food.groceries"))
        .unwrap();
    assert_eq!(
        (groceries.spent_minor, groceries.refund_credit_minor),
        (0, 2_000)
    );
    let dining = usd
        .lines
        .iter()
        .find(|l| l.category_id.as_deref() == Some("money:cat:food.dining"))
        .unwrap();
    assert_eq!(dining.spent_minor, 7_500, "another category is not lowered");
    assert_eq!(usd.refund_credit_minor, 2_000);
}

#[test]
fn cash_flow_reconciles_and_the_current_month_is_partial() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let world = world(&door);
    let case = fixture("cashflow.json");
    let today = case["today"].as_str().unwrap();
    let windows = windows(&door, case["through"].as_str().unwrap(), 12);
    assert_eq!(windows.len(), 12);
    let series = cashflow(&windows, &context(&world, today));
    for (currency, months) in &series {
        assert_eq!(months.len(), 12, "{currency}: every window has a point");
        let wanted: BTreeMap<String, &Value> = case["expected"][currency]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| (m["month"].as_str().unwrap().to_owned(), m))
            .collect();
        for month in months {
            match wanted.get(&month.month) {
                Some(want) => {
                    assert_eq!(month.in_minor, i(&want["in"]), "{currency} {}", month.month);
                    assert_eq!(month.out_minor, i(&want["out"]));
                    assert_eq!(month.net_minor, i(&want["net"]));
                    assert_eq!(month.savings_rate_bp, Some(i(&want["savings_rate_bp"])));
                    assert_eq!(month.partial, want["partial"].as_bool().unwrap());
                }
                None => {
                    assert_eq!(
                        (month.in_minor, month.out_minor, month.net_minor),
                        (0, 0, 0)
                    );
                    assert_eq!(month.savings_rate_bp, None, "no money in: no rate");
                    assert!(!month.partial);
                }
            }
        }
    }
    assert_eq!(series.len(), 2, "USD and CAD, never summed");
}

#[test]
fn balances_reconcile_and_a_checkpoint_is_evidence_not_the_balance() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let world = world(&door);
    let case = fixture("balances.json");
    let today = case["today"].as_str().unwrap();
    let checkpoints = load_checkpoints(&door).unwrap();
    assert!(!checkpoints.truncated);
    let mut balances = Vec::new();
    for account in &world.accounts {
        let ledger = load_ledger(&door, &account.account_id).unwrap();
        assert!(!ledger.truncated);
        let balance = account_balance(account, Some(&ledger.value), &checkpoints.value, today);
        let want = &case["accounts"][&account.account_id];
        assert_eq!(balance.currency, want["currency"].as_str().unwrap());
        assert_eq!(
            balance.balance_minor,
            Some(i(&want["balance"])),
            "{}",
            account.account_id
        );
        match (&balance.checkpoint, want["checkpoint"].as_object()) {
            (None, None) => {}
            (Some(got), Some(w)) => {
                assert_eq!(got.as_of, w["as_of"].as_str().unwrap());
                assert_eq!(got.stated_minor, i(&w["stated"]));
                assert_eq!(got.delta_minor, i(&w["delta"]));
                assert_eq!(got.agrees, w["agrees"].as_bool().unwrap());
            }
            other => panic!("{}: checkpoint {other:?}", account.account_id),
        }
        balances.push(balance);
    }
    let worth = net_worth(&balances, &world.accounts, today);
    for (currency, want) in case["net_worth"].as_object().unwrap() {
        assert_eq!(worth[currency], (i(want), true), "{currency}");
    }
    assert_eq!(worth.len(), 2, "per currency, never summed across them");
    // A ledger the read could not hold has no balance, and says so.
    let account = &world.accounts[0];
    let unavailable = account_balance(account, None, &checkpoints.value, today);
    assert_eq!(unavailable.balance_minor, None);
    assert!(unavailable.checkpoint.is_none());
    assert!(!net_worth(&[unavailable], &world.accounts, today)["USD"].1);
}

#[test]
fn targets_carry_only_what_a_carrying_month_left_unused() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let world = world(&door);
    let case = fixture("targets.json");
    let today = case["today"].as_str().unwrap();
    let windows = windows(&door, "2024-03", 13);
    let ctx = context(&world, today);
    let spent = SpentIndex::from_windows(&windows, &ctx);
    let targets = load_targets(&door, "2023-03", "2024-03").unwrap().value;
    for want in case["statuses"].as_array().unwrap() {
        let status = target_status(
            &targets,
            &spent,
            &world.categories,
            want["month"].as_str().unwrap(),
            want["category"].as_str().unwrap(),
            TargetMode::default(),
        )
        .expect("a target");
        let label = format!("{} {}", status.month, status.category_id);
        assert_eq!(status.amount_minor, i(&want["amount"]), "{label}");
        assert_eq!(status.carry_in_minor, i(&want["carry_in"]), "{label}");
        assert_eq!(status.planned_minor, i(&want["planned"]), "{label}");
        assert_eq!(status.spent_minor, i(&want["spent"]), "{label}");
        assert_eq!(status.left_minor, i(&want["left"]), "{label}");
        assert_eq!(status.over, want["over"].as_bool().unwrap(), "{label}");
    }
    let sheet = &case["sheet"];
    let derived = target_sheet(
        &targets,
        &spent,
        &world.categories,
        &SheetInput {
            month: sheet["month"].as_str().unwrap(),
            category: sheet["category"].as_str().unwrap(),
            currency: sheet["currency"].as_str().unwrap(),
            amount_minor: i(&sheet["amount"]),
            carry: sheet["carry"].as_bool().unwrap(),
        },
    );
    assert_eq!(
        derived.six_month_average_minor,
        i(&sheet["six_month_average"])
    );
    assert_eq!(
        derived.next_month_preview_minor,
        i(&sheet["next_month_preview"])
    );
}

#[test]
fn overspending_does_not_carry_in_tracking_and_does_in_the_dormant_envelope_branch() {
    use centraid_apps_money::queries::TargetRow;
    let target = |month: &str, amount: i64| TargetRow {
        month: month.to_owned(),
        category_concept_id: "c".to_owned(),
        amount_minor: amount,
        currency: "USD".to_owned(),
        carry: true,
    };
    let targets = vec![target("2024-01", 1_000), target("2024-02", 1_000)];
    let mut windows: Vec<(String, Vec<TxnRow>)> = Vec::new();
    let row = TxnRow {
        txn_id: "x".into(),
        account_id: "A".into(),
        posted_on: "2024-01-05".into(),
        amount_minor: 1_800,
        currency: "USD".into(),
        direction: Direction::Debit,
        status: "posted".into(),
        description: "d".into(),
        category_concept_id: Some("c".into()),
        external_id: None,
        display_name: None,
        display_name_source: None,
        memo: None,
        check_number: None,
        bank_type: None,
        imported_from: None,
    };
    windows.push(("2024-01".into(), vec![row]));
    let accounts = vec![queries::AccountRow {
        account_id: "A".into(),
        name: "A".into(),
        kind: "checking".into(),
        on_budget: true,
        opening_minor: 0,
        opening_on: None,
        closed_on: None,
        currency: "USD".into(),
        external_ref: None,
    }];
    let categories = Vec::new();
    let linked = BTreeSet::new();
    let ctx = Context {
        accounts: &accounts,
        categories: &categories,
        linked: &linked,
        today: "2024-03-01",
    };
    let spent = SpentIndex::from_windows(&windows, &ctx);
    let tracking = target_status(
        &targets,
        &spent,
        &categories,
        "2024-02",
        "c",
        TargetMode::Tracking,
    )
    .unwrap();
    assert_eq!(
        (tracking.carry_in_minor, tracking.planned_minor),
        (0, 1_000)
    );
    let envelope = target_status(
        &targets,
        &spent,
        &categories,
        "2024-02",
        "c",
        TargetMode::Envelope,
    )
    .unwrap();
    assert_eq!(
        (envelope.carry_in_minor, envelope.planned_minor),
        (-800, 200)
    );
}

#[test]
fn a_carry_chain_is_followed_twelve_months_back_and_no_further() {
    use centraid_apps_money::queries::TargetRow;
    // Every month from 2023-01 to 2024-03 plans 100 and carries; nothing is spent.
    let mut targets = Vec::new();
    let mut month = "2023-01".to_owned();
    while month.as_str() <= "2024-03" {
        targets.push(TargetRow {
            month: month.clone(),
            category_concept_id: "c".into(),
            amount_minor: 100,
            currency: "USD".into(),
            carry: true,
        });
        month = civil::add_months(&month, 1).unwrap();
    }
    let spent = SpentIndex::default();
    let status =
        target_status(&targets, &spent, &[], "2024-03", "c", TargetMode::Tracking).unwrap();
    // 100 itself, and twelve carried months of 100: the chain stops at twelve.
    assert_eq!(status.planned_minor, 100 + 12 * 100);
    assert_eq!(status.carry_in_minor, 1_200);
}

#[test]
fn transfer_proposals_over_the_ledger_and_over_constructed_rows() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let world = world(&door);
    let case = fixture("transfers.json");
    let rows = load_transfer_candidates(&door, &world.accounts).unwrap();
    let found = transfer_proposals(&rows, &world.linked, &BTreeSet::new());
    let wanted = case["rows_json_expected"].as_array().unwrap();
    assert_eq!(found.len(), wanted.len());
    for (got, want) in found.iter().zip(wanted) {
        assert_eq!(got.debit_txn_id, want["debit"].as_str().unwrap());
        assert_eq!(got.credit_txn_id, want["credit"].as_str().unwrap());
        assert_eq!(got.amount_minor, i(&want["amount"]));
        assert_eq!(got.currency, want["currency"].as_str().unwrap());
        assert_eq!(got.days_apart, i(&want["days_apart"]));
    }
    for case in fixture("transfers.json")["cases"].as_array().unwrap() {
        let rows: Vec<TxnRow> = case["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                let r = r.as_array().unwrap();
                TxnRow {
                    txn_id: r[0].as_str().unwrap().into(),
                    account_id: r[1].as_str().unwrap().into(),
                    posted_on: r[2].as_str().unwrap().into(),
                    direction: if r[3] == "debit" {
                        Direction::Debit
                    } else {
                        Direction::Credit
                    },
                    amount_minor: i(&r[4]),
                    currency: r[5].as_str().unwrap().into(),
                    status: r[6].as_str().unwrap().into(),
                    description: String::new(),
                    category_concept_id: None,
                    external_id: None,
                    display_name: None,
                    display_name_source: None,
                    memo: None,
                    check_number: None,
                    bank_type: None,
                    imported_from: None,
                }
            })
            .collect();
        let linked: BTreeSet<String> = case["linked"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().into())
            .collect();
        let decided: BTreeSet<(String, String)> = case["decided"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (p[0].as_str().unwrap().into(), p[1].as_str().unwrap().into()))
            .collect();
        let got: Vec<(String, String, i64)> = transfer_proposals(&rows, &linked, &decided)
            .into_iter()
            .map(|p| (p.debit_txn_id, p.credit_txn_id, p.days_apart))
            .collect();
        let want: Vec<(String, String, i64)> = case["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                (
                    e[0].as_str().unwrap().into(),
                    e[1].as_str().unwrap().into(),
                    i(&e[2]),
                )
            })
            .collect();
        assert_eq!(got, want, "{}", case["name"]);
    }
}

// ---------------------------------------------------------------------------
// The statements themselves.
// ---------------------------------------------------------------------------

#[test]
fn a_month_is_a_range_and_its_rows_wear_money_columns() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let march = load_month(&door, "2024-03", &ActivityFilter::default()).unwrap();
    assert_eq!(march.value.len(), 17);
    assert!(!march.truncated);
    assert!(
        march
            .value
            .windows(2)
            .all(|w| w[0].posted_on >= w[1].posted_on),
        "newest first"
    );
    let netflix = march.value.iter().find(|r| r.txn_id == "t20").unwrap();
    assert_eq!(netflix.display_name.as_deref(), Some("Netflix"));
    assert_eq!(netflix.name(), "Netflix");
    assert_eq!(netflix.memo.as_deref(), Some("Monthly plan"));
    let shop = load_month(&door, "2024-03", &ActivityFilter::default()).unwrap();
    let shop = shop.value.iter().find(|r| r.txn_id == "t11").unwrap();
    assert_eq!(shop.check_number.as_deref(), Some("101"));
    // No row of another month, and none dropped at the month's edge.
    assert_eq!(
        load_month(&door, "2024-02", &ActivityFilter::default())
            .unwrap()
            .value
            .len(),
        4
    );
    assert_eq!(
        load_month(&door, "2023-12", &ActivityFilter::default())
            .unwrap()
            .value
            .len(),
        0
    );
}

#[test]
fn activity_filters_by_account_and_category_and_pages_by_keyset() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let chk = ActivityFilter {
        account_id: Some("A1".into()),
        category: CategoryFilter::Any,
    };
    let first = load_activity_page(&door, "2024-03", &chk, &PageRequest::first(4)).unwrap();
    assert_eq!(first.rows.len(), 4);
    let (sort_key, pk) = first.next.clone().expect("more rows");
    let second = load_activity_page(
        &door,
        "2024-03",
        &chk,
        &PageRequest::after(100, centraid_apps_kit::page::PageCursor { sort_key, pk }),
    )
    .unwrap();
    let all = load_month(&door, "2024-03", &chk).unwrap().value;
    let paged: Vec<&str> = first
        .rows
        .iter()
        .chain(&second.rows)
        .map(|r| r.txn_id.as_str())
        .collect();
    assert_eq!(
        paged,
        all.iter().map(|r| r.txn_id.as_str()).collect::<Vec<_>>()
    );
    assert!(second.next.is_none());
    assert!(all.iter().all(|r| r.account_id == "A1"));
    let needs = ActivityFilter {
        account_id: None,
        category: CategoryFilter::Uncategorised,
    };
    let uncategorised = load_month(&door, "2024-03", &needs).unwrap().value;
    assert!(
        uncategorised
            .iter()
            .all(|r| r.category_concept_id.is_none() && !r.is_void())
    );
    assert_eq!(uncategorised.len(), 8);
    let groceries = ActivityFilter {
        account_id: None,
        category: CategoryFilter::Is("money:cat:food.groceries".into()),
    };
    assert_eq!(
        load_month(&door, "2024-03", &groceries)
            .unwrap()
            .value
            .len(),
        4
    );
}

#[test]
fn accounts_categories_rules_links_and_targets_read_whole() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let accounts = load_accounts(&door).unwrap();
    assert_eq!(accounts.len(), 5);
    let chk = accounts.iter().find(|a| a.account_id == "A1").unwrap();
    assert_eq!(
        (chk.currency.as_str(), chk.on_budget, chk.opening_minor),
        ("USD", true, 100_000)
    );
    assert_eq!(chk.external_ref.as_deref(), Some("1234"));
    assert!(
        !accounts
            .iter()
            .find(|a| a.account_id == "A3")
            .unwrap()
            .on_budget
    );
    let categories = load_categories(&door).unwrap();
    assert!(
        categories
            .iter()
            .find(|c| c.concept_id == "money:cat:fun.entertainment")
            .unwrap()
            .archived
    );
    assert!(
        !categories
            .iter()
            .find(|c| c.concept_id == "money:cat:food.dining")
            .unwrap()
            .archived
    );
    let dining = categories
        .iter()
        .find(|c| c.concept_id == "money:cat:food.dining")
        .unwrap();
    assert_eq!(dining.parent.as_deref(), Some("money:cat:food"));
    let rules = load_rules(&door).unwrap();
    assert_eq!(rules.value.len(), 1);
    assert_eq!(rules.value[0].pattern, "netflix");
    assert_eq!(load_transfer_links(&door).unwrap().value.len(), 1);
    assert_eq!(
        load_targets(&door, "2024-03", "2024-03")
            .unwrap()
            .value
            .len(),
        2
    );
    assert_eq!(
        load_targets(&door, "2024-01", "2024-03")
            .unwrap()
            .value
            .len(),
        4
    );
    assert_eq!(MONTH_ROWS, 2_000);
}

#[test]
fn the_existing_window_an_import_plan_reads_is_the_accounts_rows_in_the_range() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let rows = queries::load_existing(&door, "A1", "2024-03-01", "2024-03-12").unwrap();
    let days: Vec<&str> = rows.iter().map(|r| r.posted_on.as_str()).collect();
    assert_eq!(
        days,
        vec![
            "2024-03-01",
            "2024-03-03",
            "2024-03-04",
            "2024-03-10",
            "2024-03-11",
            "2024-03-12"
        ]
    );
    assert!(rows.iter().all(|r| {
        r.external_id
            .as_deref()
            .is_some_and(|id| id.starts_with("csv:"))
    }));
    let void = queries::load_existing(&door, "A1", "2024-03-14", "2024-03-14").unwrap();
    assert!(
        void[0].void,
        "a void row still claims its id but is never proposed"
    );
}

#[test]
fn search_walks_months_newest_first_and_forgives_a_slip() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let hits = search(&door, "2024-03", "netflix", 10).unwrap();
    assert_eq!(
        hits.rows
            .iter()
            .map(|r| r.txn_id.as_str())
            .collect::<Vec<_>>(),
        vec!["t20", "t08", "t04"]
    );
    assert_eq!(hits.corrected, None);
    // The member's name, the memo and the category label are searched too.
    assert_eq!(
        search(&door, "2024-03", "weekly shop", 10)
            .unwrap()
            .rows
            .len(),
        1
    );
    assert_eq!(
        search(&door, "2024-03", "subscriptions", 10)
            .unwrap()
            .total_matches,
        3
    );
    // A slipped letter is forgiven against the words walked, and says so.
    let slipped = search(&door, "2024-03", "chipotel", 10).unwrap();
    assert_eq!(slipped.corrected.as_deref(), Some("chipotle"));
    assert_eq!(slipped.total_matches, 3);
    // Nothing means nothing, and an empty term reads nothing.
    assert_eq!(
        search(&door, "2024-03", "zzzzqq", 10)
            .unwrap()
            .total_matches,
        0
    );
    assert!(search(&door, "2024-03", "  ", 10).unwrap().rows.is_empty());
    // A walk starts where it is told: from February, March is not read.
    assert_eq!(
        search(&door, "2024-02", "netflix", 10)
            .unwrap()
            .total_matches,
        2
    );
    // The limit caps what is returned, not what is counted.
    let limited = search(&door, "2024-03", "netflix", 1).unwrap();
    assert_eq!((limited.rows.len(), limited.total_matches), (1, 3));
}

/// Debits of one merchant on the given days, as the detector reads them.
fn debits(merchant: &str, days: &[Value]) -> Vec<TxnRow> {
    days.iter()
        .enumerate()
        .map(|(at, day)| TxnRow {
            txn_id: format!("{merchant}-{at}"),
            account_id: "A".into(),
            posted_on: day.as_str().expect("a day").to_owned(),
            amount_minor: 3000,
            currency: "USD".into(),
            direction: Direction::Debit,
            status: "posted".into(),
            description: merchant.to_owned(),
            category_concept_id: None,
            external_id: None,
            display_name: None,
            display_name_source: None,
            memo: None,
            check_number: None,
            bank_type: None,
            imported_from: None,
        })
        .collect()
}

#[test]
fn month_positions_match_the_hand_computed_calendar() {
    use centraid_apps_money::recurring::{Cadence, Status, detect};
    use centraid_vault::time::rrule::assert_supported;
    let case = fixture("recurring.json");
    for want in case["positions"].as_array().unwrap() {
        let name = want["merchant"].as_str().unwrap();
        let today = want["today"].as_str().unwrap();
        let rows = debits(name, want["days"].as_array().unwrap());
        let found = detect(&rows, &BTreeSet::new(), today);
        assert_eq!(found.len(), 1, "{name}");
        let got = &found[0];
        assert_eq!(got.cadence, Cadence::Monthly, "{name}: monthly on the wire");
        assert_eq!(got.rrule, want["rrule"].as_str().unwrap(), "{name}");
        assert!(assert_supported(&got.rrule).is_ok(), "{name}");
        assert_eq!(got.anchor, want["anchor"].as_str().unwrap(), "{name}");
        assert_eq!(got.rank_milli, i(&want["rank_milli"]), "{name}");
        assert_eq!(
            got.next_due(today).as_deref(),
            want["next_due"].as_str(),
            "{name}"
        );
        for window in want["projection"].as_array().unwrap() {
            let projected = got.project(
                window["from"].as_str().unwrap(),
                window["to"].as_str().unwrap(),
                today,
            );
            let got_pairs: Vec<(String, &str)> = projected
                .iter()
                .map(|p| {
                    let status = match p.status {
                        Status::Paid => "paid",
                        Status::Due => "due",
                        Status::Late => "late",
                    };
                    (p.expected_on.clone(), status)
                })
                .collect();
            let want_pairs: Vec<(String, &str)> = window["expected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| (e[0].as_str().unwrap().to_owned(), e[1].as_str().unwrap()))
                .collect();
            assert_eq!(got_pairs, want_pairs, "{name}");
        }
    }
    for none in case["not_offered"].as_array().unwrap() {
        let rows = debits(
            none["merchant"].as_str().unwrap(),
            none["days"].as_array().unwrap(),
        );
        assert!(
            detect(&rows, &BTreeSet::new(), none["today"].as_str().unwrap()).is_empty(),
            "{none}"
        );
    }
}

#[test]
fn recurring_series_over_the_ledger_match_the_fixture() {
    use centraid_apps_money::recurring::{
        Cadence, RECURRING_MONTHS, Status, detect, forecast, seen_times,
    };
    let connection = vault();
    let door = TestDoor::new(&connection);
    let world = world(&door);
    let case = fixture("recurring.json");
    let today = case["today"].as_str().unwrap();
    let month = case["month"].as_str().unwrap();
    let lookback = queries::load_lookback(&door, month, RECURRING_MONTHS).unwrap();
    assert!(!lookback.truncated);
    let found = detect(&lookback.value, &world.linked, today);
    let wanted = case["series"].as_array().unwrap();
    assert_eq!(found.len(), wanted.len());
    for (got, want) in found.iter().zip(wanted) {
        assert_eq!(got.merchant_key, want["merchant_key"].as_str().unwrap());
        assert_eq!(got.account_id, want["account"].as_str().unwrap());
        assert_eq!(got.cadence, Cadence::Monthly);
        assert_eq!(want["cadence"], "monthly");
        assert_eq!(got.rrule, want["rrule"].as_str().unwrap());
        assert_eq!(got.anchor, want["anchor"].as_str().unwrap());
        assert_eq!(got.median_amount_minor, i(&want["median"]));
        assert_eq!(
            got.category_concept_id.as_deref(),
            want["category"].as_str()
        );
        assert_eq!(
            got.occurrences,
            want["occurrences"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| d.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        );
        assert_eq!(got.rank_milli, i(&want["rank_milli"]));
        assert_eq!(got.next_due(today).as_deref(), want["next_due"].as_str());
        for window in want["projection"].as_array().unwrap() {
            let projected = got.project(
                window["from"].as_str().unwrap(),
                window["to"].as_str().unwrap(),
                today,
            );
            let words = |s: Status| match s {
                Status::Paid => "paid",
                Status::Due => "due",
                Status::Late => "late",
            };
            let got_pairs: Vec<(String, &str)> = projected
                .iter()
                .map(|p| (p.expected_on.clone(), words(p.status)))
                .collect();
            let want_pairs: Vec<(String, &str)> = window["expected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| (e[0].as_str().unwrap().to_owned(), e[1].as_str().unwrap()))
                .collect::<Vec<_>>()
                .into_iter()
                .map(|(d, s)| {
                    (
                        d,
                        if s == "paid" {
                            "paid"
                        } else if s == "due" {
                            "due"
                        } else {
                            "late"
                        },
                    )
                })
                .collect();
            assert_eq!(got_pairs, want_pairs);
        }
    }
    for (description, times) in case["seen_times"].as_object().unwrap() {
        assert_eq!(
            seen_times(&lookback.value, description),
            usize::try_from(i(times)).unwrap(),
            "{description}"
        );
    }
    // The forecast: March's spending so far plus nothing still to come.
    let ctx = context(&world, today);
    let rows = load_month(&door, month, &ActivityFilter::default())
        .unwrap()
        .value;
    let spent: BTreeMap<String, i64> = spending(&rows, month, &ctx)
        .into_iter()
        .map(|s| (s.currency, s.spent_minor))
        .collect();
    let is_income = |c: &str| ctx.is_income(c);
    for line in forecast(&spent, &found, month, today, &is_income) {
        let want = &case["forecast"][&line.currency];
        if want.is_null() {
            continue;
        }
        assert_eq!(line.spent_so_far_minor, i(&want["spent_so_far"]));
        assert_eq!(line.expected_minor, i(&want["expected"]));
        assert_eq!(line.month_end_minor, i(&want["month_end"]));
    }
}
