//! THE PHONE'S ANSWERS over the fixture ledger (#1099, wave 3).
//!
//! `contracts/apps/money/rows.json` and the hand-computed fixtures are the
//! same ones `folds.rs` reconciles the engine with; this file asserts what each
//! screen's typed answer says of them.

use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::money::money;
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_money::import::{CsvOptions, read_csv};
use centraid_apps_money::phone::{self, Flag, VerdictKind, definitions, import_plan};
use centraid_apps_money::queries::{ActivityFilter, CategoryFilter, load_categories};
use centraid_apps_money::recurring::{Cadence, Status};
use rusqlite::Connection;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn vault() -> Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql")).expect("DDL");
    let rows = fs::read_to_string(root().join("contracts/apps/money/rows.json")).expect("rows");
    open_contract_vault(&ddl, &rows).expect("the fixture vault is built")
}

const TODAY: &str = "2024-03-20";

#[test]
fn spending_says_what_the_month_holds_and_what_it_left_out() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let answer = phone::spending(&door, "2024-03", TODAY).expect("spending");
    assert_eq!(
        (answer.day_of_month, answer.days_in_month, answer.days_left),
        (20, 31, 11)
    );
    assert!(!answer.empty && !answer.truncated);
    // CAD sorts before USD; each is its own figure.
    assert_eq!(answer.per_currency.len(), 2);
    let cad = &answer.per_currency[0];
    assert_eq!(
        (cad.spent.clone(), cad.planned.clone()),
        (money(3_000, "CAD"), None)
    );
    let usd = &answer.per_currency[1];
    assert_eq!(usd.spent, money(16_599, "USD"));
    // The Food group's 20,000 stands for the groceries target inside it.
    assert_eq!(usd.planned, Some(money(20_000, "USD")));
    assert_eq!(usd.left, Some(money(3_401, "USD")));
    assert_eq!(usd.progress_bp, Some(8_300));
    assert_eq!(usd.refund_credit, money(0, "USD"));

    let usd_lines: Vec<(&str, i64, Option<i64>, i64, bool)> = answer
        .categories
        .iter()
        .filter(|c| c.currency == "USD")
        .map(|c| {
            (
                c.label.as_str(),
                c.spent.amount_minor,
                c.planned.as_ref().map(|m| m.amount_minor),
                c.carry_in.amount_minor,
                c.over,
            )
        })
        .collect();
    assert_eq!(
        usd_lines,
        vec![
            ("Food", 13_000, Some(20_000), 0, false),
            ("Dining out", 7_500, None, 0, false),
            ("Groceries", 5_500, Some(9_000), 3_000, false),
            ("Subscriptions", 1_599, None, 0, false),
        ]
    );
    let groceries = answer
        .categories
        .iter()
        .find(|c| c.label == "Groceries" && c.currency == "USD")
        .unwrap();
    assert_eq!(groceries.group.as_deref(), Some("Food"));
    assert_eq!(groceries.left, Some(money(3_500, "USD")));

    assert_eq!(answer.uncategorised.len(), 1);
    assert!(
        answer
            .uncategorised
            .iter()
            .any(|u| u.count == 1 && u.amount == money(2_000, "USD"))
    );
    let net: Vec<_> = answer.in_out_net.iter().map(|n| n.net.clone()).collect();
    assert_eq!(net, vec![money(7_000, "CAD"), money(284_401, "USD")]);
    assert_eq!(answer.transfers_excluded.len(), 1);
    assert_eq!(answer.transfers_excluded[0].amount, money(20_000, "USD"));
    assert_eq!(answer.future_excluded.len(), 1);
    assert_eq!(
        (
            answer.future_excluded[0].count,
            answer.future_excluded[0].amount.clone()
        ),
        (1, money(4_000, "USD"))
    );
    let forecast = answer
        .forecast
        .iter()
        .find(|f| f.month_end.currency.code() == "USD")
        .unwrap();
    assert_eq!(
        (
            forecast.spent_so_far.amount_minor,
            forecast.expected.amount_minor,
            forecast.month_end.amount_minor
        ),
        (16_599, 0, 16_599)
    );
    let last = answer.last_import.as_ref().expect("the newest import");
    assert_eq!(
        (last.source.as_str(), last.account_name.as_deref()),
        ("csv", Some("Checking"))
    );
    for key in [
        definitions::SPENDING,
        definitions::FORECAST,
        definitions::IN_OUT_NET,
    ] {
        assert!(answer.definitions.contains(&key));
    }
}

#[test]
fn a_past_month_has_no_forecast_and_an_empty_vault_is_day_one() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let february = phone::spending(&door, "2024-02", TODAY).unwrap();
    assert!(february.forecast.is_empty());
    assert_eq!((february.day_of_month, february.days_left), (29, 0));
    // February's plan: groceries 12,000, spent 9,000.
    let groceries = february
        .categories
        .iter()
        .find(|c| c.label == "Groceries")
        .unwrap();
    assert_eq!(groceries.planned, Some(money(12_000, "USD")));
    // A month with nothing in it is not "empty": the vault has history.
    let december = phone::spending(&door, "2023-12", TODAY).unwrap();
    assert!(!december.empty);
    assert!(december.per_currency.is_empty());
    let blank = Connection::open_in_memory().unwrap();
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql")).unwrap();
    let blank = open_contract_vault(&ddl, "[]").map(|_| blank).unwrap();
    drop(blank);
    let empty = open_contract_vault(&ddl, "[]").unwrap();
    let door = TestDoor::new(&empty);
    let day_one = phone::spending(&door, "2024-03", TODAY).unwrap();
    assert!(day_one.empty);
    assert!(phone::home_tile(&door, "2024-03", TODAY).unwrap().empty);
}

#[test]
fn activity_rows_carry_their_flags_and_the_needs_category_count() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let answer = phone::activity(
        &door,
        "2024-03",
        &ActivityFilter::default(),
        &PageRequest::first(100),
        TODAY,
    )
    .unwrap();
    let flags = |id: &str| {
        answer
            .rows
            .iter()
            .find(|r| r.txn_id == id)
            .unwrap()
            .flags
            .clone()
    };
    assert_eq!(flags("t17"), vec![Flag::Transfer]);
    assert_eq!(flags("t15"), vec![Flag::Uncategorised]);
    assert_eq!(flags("t19"), vec![Flag::Void]);
    assert_eq!(flags("t21"), vec![Flag::Future]);
    assert!(flags("t20").is_empty());
    let netflix = answer.rows.iter().find(|r| r.txn_id == "t20").unwrap();
    assert_eq!(
        (
            netflix.display_name.as_str(),
            netflix.raw.as_str(),
            netflix.amount.clone()
        ),
        ("Netflix", "NETFLIX.COM", money(-1_599, "USD"))
    );
    assert_eq!(netflix.category_label.as_deref(), Some("Subscriptions"));
    assert_eq!(netflix.account_label, "Checking");
    // Needs a category: the uncategorised rows that are not half of a transfer.
    let needs: i64 = answer.needs_category.iter().map(|n| n.count as i64).sum();
    assert_eq!(
        needs, 6,
        "t15 t16 t23 t24 t25 t26; the linked pair is not 'needing'"
    );
    assert!(answer.cursor.is_none());
    let chk = ActivityFilter {
        account_id: Some("A1".into()),
        category: CategoryFilter::Any,
    };
    let first = phone::activity(&door, "2024-03", &chk, &PageRequest::first(3), TODAY).unwrap();
    assert_eq!(first.rows.len(), 3);
    assert!(first.cursor.is_some());
}

#[test]
fn a_transaction_knows_its_transfer_its_series_and_how_often_it_is_seen() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let netflix = phone::transaction(&door, "t20", TODAY)
        .unwrap()
        .expect("a row");
    assert_eq!(netflix.seen_times, 3);
    let series = netflix.recurring.expect("a monthly series");
    assert_eq!(series.cadence, Cadence::Monthly);
    assert_eq!(series.next_due.as_deref(), Some("2024-04-15"));
    assert_eq!(series.amount, money(1_599, "USD"));
    assert_eq!(netflix.applied_rule_ids, vec!["r1".to_owned()]);
    assert!(netflix.rule_proposal.is_none(), "a rule already files it");
    assert_eq!(netflix.memo.as_deref(), Some("Monthly plan"));
    assert_eq!(netflix.bank_type.as_deref(), Some("DEBIT_CARD"));

    let linked = phone::transaction(&door, "t17", TODAY).unwrap().unwrap();
    assert_eq!(linked.transferred_with.as_deref(), Some("t18"));
    assert!(linked.transfer_proposal.is_none());

    let open = phone::transaction(&door, "t25", TODAY).unwrap().unwrap();
    let offer = open.transfer_proposal.expect("the open pair");
    assert_eq!(
        (
            offer.other_txn_id.as_str(),
            offer.other_account_label.as_str(),
            offer.days_apart
        ),
        ("t26", "Loan", 1)
    );
    assert!(phone::transaction(&door, "nope", TODAY).unwrap().is_none());
}

#[test]
fn cash_flow_accounts_rules_and_categories() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let flow = phone::cashflow(&door, "2024-03", TODAY).unwrap();
    assert_eq!(flow.series.len(), 2);
    let usd = flow.series.iter().find(|s| s.currency == "USD").unwrap();
    assert_eq!(usd.months.len(), 12);
    let march = usd.months.last().unwrap();
    assert_eq!(
        (
            march.month.as_str(),
            march.net.clone(),
            march.savings_rate_bp,
            march.partial
        ),
        ("2024-03", money(284_401, "USD"), Some(9_402), true)
    );

    let accounts = phone::accounts(&door, TODAY).unwrap();
    assert_eq!(accounts.on_budget.len(), 3);
    assert_eq!(accounts.off_budget.len(), 2);
    let checking = &accounts
        .on_budget
        .iter()
        .find(|a| a.name == "Checking")
        .unwrap();
    assert_eq!(checking.balance, Some(money(951_703, "USD")));
    assert_eq!(checking.mask.as_deref(), Some("1234"));
    let checkpoint = checking.checkpoint.as_ref().unwrap();
    assert!(checkpoint.agrees);
    let card = accounts
        .on_budget
        .iter()
        .find(|a| a.name == "Card")
        .unwrap();
    assert!(!card.checkpoint.as_ref().unwrap().agrees);
    assert_eq!(
        card.checkpoint.as_ref().unwrap().delta,
        money(-1_000, "USD")
    );
    let worth: Vec<_> = accounts
        .net_worth
        .iter()
        .map(|w| (w.amount.clone(), w.complete))
        .collect();
    assert_eq!(
        worth,
        vec![(money(7_000, "CAD"), true), (money(1_456_803, "USD"), true)]
    );

    let rules = phone::rules(&door).unwrap();
    assert_eq!(rules.rules.len(), 1);
    assert_eq!(
        rules.rules[0].category_label.as_deref(),
        Some("Subscriptions")
    );
    assert_eq!((rules.rules[0].specificity, rules.limit), (1, 500));

    let categories = phone::categories(&door).unwrap();
    let fun = categories
        .groups
        .iter()
        .find(|g| g.label == "Fun and travel")
        .unwrap();
    assert!(
        fun.categories
            .iter()
            .any(|c| c.label == "Entertainment and travel" && c.archived)
    );
}

#[test]
fn the_target_sheet_recurring_screen_home_tile_and_search() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let sheet = phone::target_sheet(
        &door,
        "2024-03",
        "money:cat:food.groceries",
        "USD",
        None,
        TODAY,
    )
    .unwrap();
    assert_eq!(sheet.amount, Some(money(6_000, "USD")));
    assert_eq!(
        (sheet.carry, sheet.carry_in.clone(), sheet.spent.clone()),
        (true, money(3_000, "USD"), money(5_500, "USD"))
    );
    assert_eq!(sheet.six_month_average, money(2_833, "USD"));
    assert_eq!(sheet.next_month_preview, money(9_500, "USD"));
    // Typing a new amount re-derives the preview, not the stored plan.
    let typed = phone::target_sheet(
        &door,
        "2024-03",
        "money:cat:food.groceries",
        "USD",
        Some((4_000, false)),
        TODAY,
    )
    .unwrap();
    assert_eq!(typed.next_month_preview, money(4_000, "USD"));
    assert_eq!(typed.amount, Some(money(6_000, "USD")));

    let recurring = phone::recurring_screen(&door, TODAY).unwrap();
    assert_eq!(recurring.series.len(), 1);
    let line = &recurring.series[0];
    assert_eq!(
        (line.merchant.as_str(), line.cadence_words),
        ("Netflix", "every month")
    );
    assert_eq!((line.status, line.seen_times), (Status::Due, 3));
    assert_eq!(line.next_due.as_deref(), Some("2024-04-15"));

    let tile = phone::home_tile(&door, "2024-03", TODAY).unwrap();
    assert!(!tile.empty);
    assert_eq!(tile.spent, vec![money(3_000, "CAD"), money(16_599, "USD")]);

    let found = phone::search(&door, "2024-03", "netflx", 10, TODAY).unwrap();
    assert_eq!(found.corrected.as_deref(), Some("netflix"));
    assert_eq!(found.rows.len(), 3);
    assert_eq!(found.months_walked, 12);
}

#[test]
fn an_import_plan_reads_as_rows_totals_and_a_profile_to_save() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let file = b"Date,Description,Amount\n2024-03-12,\"TRANSFER TO SAVINGS\",-200.00\n2024-03-21,\"NEW SHOP\",-12.50\nbad,\"X\",1\n";
    let statement = read_csv(file, &CsvOptions::new("USD")).unwrap();
    let existing =
        centraid_apps_money::queries::load_existing(&door, "A1", "2024-03-09", "2024-03-24")
            .unwrap();
    let plan = centraid_apps_money::import::plan(&statement, "A1", "USD", &existing, &[], TODAY);
    let categories = load_categories(&door).unwrap();
    let view = import_plan(&plan, &categories, None);
    assert_eq!(
        (
            view.new,
            view.already_in,
            view.proposed_duplicates,
            view.rejected
        ),
        (1, 0, 1, 1),
        "the first row is the held transfer under another id: proposed, not written"
    );
    let kinds: Vec<VerdictKind> = view.rows.iter().map(|r| r.verdict).collect();
    assert_eq!(
        kinds,
        vec![
            VerdictKind::ProposedDuplicate,
            VerdictKind::New,
            VerdictKind::Rejected
        ]
    );
    assert_eq!(view.rows[0].existing_txn_id.as_deref(), Some("t17"));
    assert_eq!(view.rows[1].amount, Some(money(-1_250, "USD")));
    assert!(view.rows[1].future_dated);
    assert_eq!(view.rows[2].reason, Some("The date could not be read."));
    assert_eq!(view.new_out, money(1_250, "USD"));
    // The layout is offered for saving until one with this fingerprint is saved.
    let saved = view.profile_to_save.clone().expect("a layout to save");
    assert_eq!(
        (saved.sign_mode.as_str(), saved.date_order.as_str()),
        ("signed", "ymd")
    );
    let again = import_plan(&plan, &categories, Some(&saved));
    assert!(again.profile_to_save.is_none());
    // The saved decisions come back as options.
    let options = CsvOptions::from_saved("USD", &saved);
    assert_eq!(
        options.sign,
        Some(centraid_apps_money::import::SignChoice::DebitsNegative)
    );
}
