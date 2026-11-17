//! Money's reads against a vault the product founds and Money's own commands fill
//! (#1135): the lines a statement left, the bank's words kept beside the member's
//! name, an account and its bank number, the categories, the rules and plans, and
//! seam S2 (the app's rule semantics and the vault's agree on every shared case).

mod common;

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::{Page, PageCursor, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::{Cell, Row};
use centraid_apps_kit::statement::PageQuery;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_money::import::{CsvOptions, read_csv};
use centraid_apps_money::queries::{
    ActivityFilter, load_accounts, load_categories, load_checkpoints, load_existing, load_ledger,
    load_month, load_rules, load_saved_profiles, load_targets, load_transaction,
    load_transfer_links,
};
use centraid_apps_money::rules::{self, Candidate, MatchKind, Rule};
use centraid_apps_money::trash::load_trash;
use common::World;
use serde_json::{Value, json};

fn read<T>(world: &World, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
    world
        .vault
        .read(|connection| Ok(body(&TestDoor::new(connection))))
        .expect("reads")
}

struct BoundedLedgerDoor {
    total: usize,
    amount_minor: i64,
    pending_rows: usize,
    short_page: bool,
    empty_cursor: bool,
    calls: std::cell::Cell<usize>,
    max_limit: std::cell::Cell<usize>,
    delivered: std::cell::Cell<usize>,
    trash_reads: std::cell::Cell<usize>,
}

impl PageDoor for BoundedLedgerDoor {
    fn page(&self, query: &PageQuery, request: &PageRequest) -> KitResult<Page<Row>> {
        self.calls.set(self.calls.get() + 1);
        self.max_limit.set(self.max_limit.get().max(request.limit));
        if query.name == "money.transactions.trashed" {
            self.trash_reads.set(self.trash_reads.get() + 1);
            return Ok(Page {
                rows: Vec::new(),
                next: None,
            });
        }
        assert_eq!(query.name, "money.account.ledger");
        if self.empty_cursor && request.after.is_none() {
            return Ok(Page {
                rows: Vec::new(),
                next: Some(PageCursor {
                    sort_key: "2024-03-06".to_owned(),
                    pk: "empty-cursor".to_owned(),
                }),
            });
        }
        if self.short_page && request.after.is_none() {
            let mut row = Row::new();
            row.insert("id".to_owned(), Cell::Text("txn-short".to_owned()));
            row.insert("posted_on".to_owned(), Cell::Text("2024-03-06".to_owned()));
            row.insert("amount_minor".to_owned(), Cell::Integer(self.amount_minor));
            row.insert("status".to_owned(), Cell::Text("posted".to_owned()));
            self.delivered.set(self.delivered.get() + 1);
            return Ok(Page {
                rows: vec![row],
                next: Some(PageCursor {
                    sort_key: "2024-03-06".to_owned(),
                    pk: "txn-short".to_owned(),
                }),
            });
        }
        let start = request.after.as_ref().map_or(0, |cursor| {
            cursor
                .pk
                .strip_prefix("txn-")
                .expect("transaction cursor")
                .parse::<usize>()
                .expect("numeric transaction cursor")
                + 1
        });
        let end = (start + request.limit).min(self.total);
        let rows: Vec<Row> = (start..end)
            .map(|index| {
                let mut row = Row::new();
                row.insert("id".to_owned(), Cell::Text(format!("txn-{index}")));
                row.insert("posted_on".to_owned(), Cell::Text("2024-03-06".to_owned()));
                row.insert("amount_minor".to_owned(), Cell::Integer(self.amount_minor));
                let status = if index < self.pending_rows {
                    "pending"
                } else {
                    "posted"
                };
                row.insert("status".to_owned(), Cell::Text(status.to_owned()));
                row
            })
            .collect();
        self.delivered.set(self.delivered.get() + rows.len());
        let next = (end < self.total).then(|| PageCursor {
            sort_key: "2024-03-06".to_owned(),
            pk: format!("txn-{}", end - 1),
        });
        Ok(Page { rows, next })
    }
}

fn bounded_ledger_door(total: usize, amount_minor: i64, pending_rows: usize) -> BoundedLedgerDoor {
    BoundedLedgerDoor {
        total,
        amount_minor,
        pending_rows,
        short_page: false,
        empty_cursor: false,
        calls: std::cell::Cell::default(),
        max_limit: std::cell::Cell::default(),
        delivered: std::cell::Cell::default(),
        trash_reads: std::cell::Cell::default(),
    }
}

#[test]
fn a_line_reads_back_with_the_banks_words_the_members_name_and_the_statements_own_columns() {
    let world = World::founded("lines");
    world.account("acct-1", "Everyday", "checking", "USD");
    world.import(
        "acct-1",
        &[
            ("csv:aaaaa", "2024-03-05", -4_250, "WHOLE FOODS MKT 123"),
            ("csv:bbbbb", "2024-03-06", 300_000, "ACME PAYROLL"),
        ],
    );
    let grocer = world.line("csv:aaaaa");
    let month = |world: &World| {
        read(world, |door| {
            load_month(door, "2024-03", &ActivityFilter::default()).expect("month")
        })
    };
    let before = month(&world);
    assert!(!before.truncated);
    assert_eq!(before.value.len(), 2);
    let line = before
        .value
        .iter()
        .find(|row| row.txn_id == grocer)
        .expect("the line");
    assert_eq!(
        (
            line.description.as_str(),
            line.amount_minor,
            line.direction.as_str(),
            line.memo.as_deref(),
            line.imported_from.as_deref(),
            line.external_id.as_deref(),
            line.display_name.as_deref()
        ),
        (
            "WHOLE FOODS MKT 123",
            4_250,
            "debit",
            Some("m"),
            Some("csv"),
            Some("csv:aaaaa"),
            None
        )
    );
    // The member's name is the entity's title; the bank's words stay where they were.
    world.ok(
        "entity.retitle",
        json!({ "id": grocer, "title": "Groceries" }),
    );
    let named = read(&world, |door| load_transaction(door, &grocer).expect("one")).expect("found");
    assert_eq!(
        (
            named.description.as_str(),
            named.display_name.as_deref(),
            named.display_name_source.as_deref(),
            named.name()
        ),
        (
            "WHOLE FOODS MKT 123",
            Some("Groceries"),
            Some("member"),
            "Groceries"
        )
    );
    // A line in the trash is in no window and no ledger.
    world.ok("entity.trash", json!({ "id": grocer }));
    assert_eq!(month(&world).value.len(), 1);
    let ledger = read(&world, |door| load_ledger(door, "acct-1").expect("ledger"));
    assert_eq!(ledger.value.len(), 1);
}

#[test]
fn an_account_reads_with_its_bank_number_its_close_and_nothing_from_the_trash() {
    let world = World::founded("accounts");
    world.account("acct-1", "Everyday", "checking", "USD");
    world.ok(
        "account.add",
        json!({ "id": "acct-2", "title": "Card", "type": "credit_card", "currency": "EUR",
                "external_ref": "1234-5678", "opening_minor": -2_000, "opening_on": "2024-02-01",
                "on_budget": false }),
    );
    world.ok("flag.set", json!({ "id": "acct-2", "flag": "archived" }));
    world.ok(
        "account.add",
        json!({ "id": "acct-3", "title": "Euro cash", "type": "cash", "currency": "EUR",
                "opening_minor": 300, "opening_on": "2024-02-01", "on_budget": true }),
    );
    let accounts = read(&world, |door| load_accounts(door).expect("accounts"));
    let everyday = accounts.iter().find(|a| a.account_id == "acct-1").unwrap();
    let card = accounts.iter().find(|a| a.account_id == "acct-2").unwrap();
    assert_eq!(everyday.external_ref, None, "no number is no number");
    assert_eq!(everyday.closed_on, None);
    assert_eq!(
        (
            card.name.as_str(),
            card.kind.as_str(),
            card.currency.as_str(),
            card.external_ref.as_deref(),
            card.opening_minor,
            card.opening_on.as_deref(),
            card.on_budget
        ),
        (
            "Card",
            "credit_card",
            "EUR",
            Some("1234-5678"),
            -2_000,
            Some("2024-02-01"),
            false
        )
    );
    assert!(card.closed_on.as_deref().is_some_and(|day| day.len() == 10));
    let today = card.closed_on.as_deref().expect("close date");
    let screen = read(&world, |door| {
        centraid_apps_money::phone::accounts(door, today).expect("Accounts")
    });
    let closed_card = screen
        .off_budget
        .iter()
        .find(|a| a.account_id == "acct-2")
        .unwrap();
    assert!(closed_card.closed);
    let worth: BTreeMap<&str, (i64, bool)> = screen
        .net_worth
        .iter()
        .map(|line| {
            (
                line.amount.currency.code(),
                (line.amount.amount_minor, line.complete),
            )
        })
        .collect();
    assert_eq!(
        worth,
        BTreeMap::from([("EUR", (300, true)), ("USD", (0, true))])
    );
    world.ok("entity.trash", json!({ "id": "acct-1" }));
    let accounts = read(&world, |door| load_accounts(door).expect("accounts"));
    assert_eq!(accounts.len(), 2);
}

#[test]
fn categories_rules_plans_checkpoints_and_transfers_read_back_as_the_commands_wrote_them() {
    let world = World::founded("misc");
    world.account("acct-1", "Everyday", "checking", "USD");
    world.account("acct-2", "Savings", "savings", "USD");
    world.import(
        "acct-1",
        &[("csv:out01", "2024-03-05", -50_000, "TO SAVINGS")],
    );
    world.import(
        "acct-2",
        &[("csv:in001", "2024-03-05", 50_000, "FROM EVERYDAY")],
    );
    world.ok(
        "txn.link_transfer",
        json!({ "id": world.line("csv:out01"), "other_id": world.line("csv:in001") }),
    );
    let links = read(&world, |door| load_transfer_links(door).expect("links"));
    assert_eq!(links.value.len(), 1);
    assert_eq!(
        (
            links.value[0].from_txn.clone(),
            links.value[0].to_txn.clone()
        ),
        {
            // The pair is one row, the lower id first.
            let (out, into) = (world.line("csv:out01"), world.line("csv:in001"));
            if out < into { (out, into) } else { (into, out) }
        }
    );

    let beans = world.ok(
        "category.add",
        json!({ "title": "Beans", "parent_id": "category:food" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    world.ok("flag.set", json!({ "id": beans, "flag": "archived" }));
    let categories = read(&world, |door| load_categories(door).expect("categories"));
    let found = categories.iter().find(|c| c.concept_id == beans).unwrap();
    assert_eq!(
        (
            found.label.as_str(),
            found.parent.as_deref(),
            found.archived
        ),
        ("Beans", Some("category:food"), true)
    );
    let groceries = categories
        .iter()
        .find(|c| c.concept_id == "category:food.groceries")
        .unwrap();
    assert!(!groceries.archived && groceries.parent.as_deref() == Some("category:food"));
    assert!(
        categories
            .iter()
            .any(|c| c.concept_id == "category:income" && c.parent.is_none())
    );

    world.ok(
        "rule.add",
        json!({ "id": "r1", "match": "matches", "text": "AMZN*", "min": 100, "category_id": "category:shopping.general" }),
    );
    let rules = read(&world, |door| load_rules(door).expect("rules")).value;
    assert_eq!(rules.len(), 1);
    assert_eq!(
        (
            rules[0].rule_id.as_str(),
            rules[0].kind,
            rules[0].pattern.as_str(),
            rules[0].amount_min_minor,
            rules[0].category_concept_id.as_deref()
        ),
        (
            "r1",
            MatchKind::Matches,
            "AMZN*",
            Some(100),
            Some("category:shopping.general")
        )
    );

    world.ok(
        "budget.set",
        json!({ "month": "2024-03", "category_id": "category:food", "amount_minor": 60_000, "currency": "USD", "carry": true }),
    );
    let plans = read(&world, |door| {
        load_targets(door, "2024-03", "2024-03").expect("plans")
    });
    assert_eq!(plans.value.len(), 1);
    assert!(plans.value[0].carry && plans.value[0].amount_minor == 60_000);

    world.ok(
        "checkpoint.record",
        json!({ "account_id": "acct-1", "day": "2024-03-31", "balance_minor": 1_000 }),
    );
    let checkpoints = read(&world, |door| load_checkpoints(door).expect("checkpoints")).value;
    assert_eq!(
        (
            checkpoints[0].as_of.as_str(),
            checkpoints[0].currency.as_str()
        ),
        ("2024-03-31", "USD")
    );
}

#[test]
fn a_saved_layout_round_trips_through_the_real_command_and_read() {
    let world = World::founded("layout");
    world.account("acct-1", "Everyday", "checking", "USD");
    let file = b"Date,Description,Amount\n2024-03-12,\"SHOP\",-12.50\n2024-03-13,\"PAY\",100.00\n";
    let statement = read_csv(file, &CsvOptions::new("USD")).expect("reads");
    let saved = statement
        .profile
        .as_ref()
        .and_then(|profile| profile.to_saved())
        .expect("a layout");
    world.ok(
        "account.remember_layout",
        json!({ "id": "acct-1", "layout": serde_json::to_value(&saved).expect("json") }),
    );
    let read_back = read(&world, |door| {
        load_saved_profiles(door, "acct-1").expect("reads")
    });
    assert_eq!(read_back, vec![saved]);
    assert!(
        read(&world, |door| load_saved_profiles(door, "other")
            .expect("reads"))
        .is_empty()
    );
}

#[test]
fn what_an_import_plan_compares_against_is_the_lines_with_their_banks_words() {
    let world = World::founded("existing");
    world.account("acct-1", "Everyday", "checking", "USD");
    world.import(
        "acct-1",
        &[
            ("csv:aaaaa", "2024-03-05", -4_250, "WHOLE FOODS MKT 123"),
            ("csv:bbbbb", "2024-04-05", -100, "LATER"),
        ],
    );
    world.ok("txn.void", json!({ "id": world.line("csv:aaaaa") }));
    let existing = read(&world, |door| {
        load_existing(door, "acct-1", "2024-03-01", "2024-03-31").expect("existing")
    });
    assert_eq!(existing.len(), 1);
    assert_eq!(
        (
            existing[0].external_id.as_deref(),
            existing[0].description.as_str(),
            existing[0].amount_minor,
            existing[0].void
        ),
        (Some("csv:aaaaa"), "WHOLE FOODS MKT 123", 4_250, true)
    );
}

/// The shared cases of seam S2: every rule matches any account, and the amount
/// bounds are inclusive and on the magnitude.
/// `(id, match, text, lower bound, upper bound, category, position)`.
type SharedRule = (
    &'static str,
    &'static str,
    &'static str,
    Option<i64>,
    Option<i64>,
    &'static str,
    i64,
);

const RULES: [SharedRule; 5] = [
    (
        "r1",
        "contains",
        "AMAZON",
        None,
        None,
        "category:shopping.general",
        0,
    ),
    (
        "r2",
        "is",
        "amazon prime",
        None,
        None,
        "category:fun.subscriptions",
        1,
    ),
    (
        "r3",
        "matches",
        "AMZN*MKTP ??",
        None,
        None,
        "category:shopping.general",
        2,
    ),
    (
        "r4",
        "contains",
        "shell",
        Some(2_000),
        Some(20_000),
        "category:transport.fuel",
        3,
    ),
    (
        "r7",
        "contains",
        "  gym ",
        None,
        None,
        "category:health.care",
        6,
    ),
];

/// `(description, magnitude, the category the deciding rule files it under, why)`.
const ROWS: [(&str, i64, Option<&str>, &str); 7] = [
    (
        "Amazon  Prime",
        1_599,
        Some("category:fun.subscriptions"),
        "r1 (contains, 1) then r2 (is, 3): the last to set it wins",
    ),
    (
        "AMZN Mktp US",
        2_500,
        Some("category:shopping.general"),
        "r3's wildcard: * is a space, ?? is two characters",
    ),
    (
        "SHELL OIL 5544",
        5_000,
        Some("category:transport.fuel"),
        "r4, inside its amount bounds",
    ),
    ("SHELL OIL 5544", 1_999, None, "one below r4's lower bound"),
    (
        "SHELL OIL",
        20_000,
        Some("category:transport.fuel"),
        "r4's upper bound is inclusive",
    ),
    (
        "Weekly   GYM pass",
        3_000,
        Some("category:health.care"),
        "the pattern is normalised too, and contains is a substring",
    ),
    ("UNMATCHED", 100, None, "no rule matches"),
];

#[test]
fn seam_s2_the_crate_and_the_vault_agree_on_every_row_of_the_shared_cases() {
    let kind_of = |word: &str| match word {
        "is" => MatchKind::Is,
        "matches" => MatchKind::Matches,
        _ => MatchKind::Contains,
    };
    let crate_rules: Vec<Rule> = RULES
        .iter()
        .map(|(id, kind, pattern, min, max, category, position)| Rule {
            rule_id: (*id).to_owned(),
            kind: kind_of(kind),
            pattern: (*pattern).to_owned(),
            amount_min_minor: *min,
            amount_max_minor: *max,
            account_id: None,
            category_concept_id: Some((*category).to_owned()),
            display_name: None,
            position: *position,
        })
        .collect();
    // The crate's reading of the cases is the hand-computed expectation.
    for (description, magnitude, category, why) in ROWS {
        let applied = rules::apply(
            &crate_rules,
            &Candidate {
                description,
                amount_minor: magnitude,
                account_id: "acct-1",
            },
        );
        assert_eq!(applied.category_concept_id.as_deref(), category, "{why}");
    }

    // The vault's reading, through the real commands, is the same.
    let world = World::founded("s2");
    world.account("acct-1", "Everyday", "checking", "USD");
    let lines: Vec<(String, i64, String)> = ROWS
        .iter()
        .enumerate()
        .map(|(at, (description, magnitude, _, _))| {
            (
                format!("csv:case{at}"),
                -magnitude,
                (*description).to_owned(),
            )
        })
        .collect();
    let borrowed: Vec<(&str, &str, i64, &str)> = lines
        .iter()
        .map(|(external, amount, words)| (external.as_str(), "2024-03-05", *amount, words.as_str()))
        .collect();
    world.import("acct-1", &borrowed);
    for (id, kind, pattern, min, max, category, position) in RULES {
        let mut input = json!({ "id": id, "match": kind, "text": pattern, "category_id": category, "position": position });
        if let Some(min) = min {
            input["min"] = json!(min);
        }
        if let Some(max) = max {
            input["max"] = json!(max);
        }
        world.ok("rule.add", input);
    }
    let applied: Value = world.ok("rule.apply", json!({}));
    assert!(applied["matched"].as_i64().unwrap() > 0);
    let month = read(&world, |door| {
        load_month(door, "2024-03", &ActivityFilter::default())
            .expect("month")
            .value
    });
    for (at, (_, _, category, why)) in ROWS.iter().enumerate() {
        let stored = month
            .iter()
            .find(|row| row.txn_id == world.line(&format!("csv:case{at}")))
            .expect("imported");
        assert_eq!(
            stored.category_concept_id.as_deref(),
            *category,
            "vault: {why}"
        );
    }
}

#[test]
fn a_balance_counts_the_lines_after_the_opening_day_and_no_line_twice() {
    let world = World::founded("opening");
    world.ok(
        "account.add",
        json!({ "id": "acct-1", "title": "Everyday", "type": "checking", "currency": "USD",
                "opening_minor": 100_000, "opening_on": "2024-03-05" }),
    );
    world.import(
        "acct-1",
        &[
            // On and before the opening day: already in the 100,000.
            ("csv:aaaaa", "2024-03-04", -4_000, "BEFORE"),
            ("csv:bbbbb", "2024-03-05", -1_000, "ON THE DAY"),
            ("csv:ccccc", "2024-03-06", -250, "AFTER"),
            ("csv:ddddd", "2024-03-07", 5_000, "PAYDAY"),
        ],
    );
    let (account, ledger) = read(&world, |door| {
        let account = load_accounts(door).expect("accounts").remove(0);
        let ledger = load_ledger(door, "acct-1").expect("ledger").value;
        (account, ledger)
    });
    assert_eq!(account.opening_on.as_deref(), Some("2024-03-05"));
    assert_eq!(
        centraid_apps_money::engine::balance_on(&account, &ledger, "2024-03-31"),
        Some(100_000 - 250 + 5_000)
    );
    assert_eq!(
        centraid_apps_money::engine::balance_on(&account, &ledger, "2024-03-05"),
        Some(100_000),
        "the opening day itself is the opening balance"
    );
    let screen = read(&world, |door| {
        centraid_apps_money::phone::accounts(door, "2024-03-31").expect("Accounts")
    });
    assert_eq!(
        screen.on_budget[0].balance.as_ref().map(|m| m.amount_minor),
        Some(104_750),
        "the streamed Accounts fold shares the opening-day arithmetic"
    );
}

#[test]
fn streamed_accounts_uses_latest_past_checkpoint_and_keeps_void_and_future_rows_out() {
    let world = World::founded("accounts-checkpoints");
    world.ok(
        "account.add",
        json!({ "id": "acct-1", "title": "Everyday", "type": "checking", "currency": "USD",
                "opening_minor": 1_000, "opening_on": "2024-03-05" }),
    );
    world.import(
        "acct-1",
        &[
            ("csv:void", "2024-03-06", -100, "VOIDED"),
            ("csv:credit", "2024-03-12", 500, "CREDIT"),
            ("csv:debit", "2024-03-18", -50, "DEBIT"),
            ("csv:future", "2024-04-02", 700, "FUTURE"),
        ],
    );
    world.ok("txn.void", json!({ "id": world.line("csv:void") }));
    for (day, balance_minor) in [
        ("2024-03-10", 1_000),
        ("2024-03-20", 1_450),
        ("2024-04-03", 9_999),
    ] {
        world.ok(
            "checkpoint.record",
            json!({ "account_id": "acct-1", "day": day, "balance_minor": balance_minor }),
        );
    }
    let screen = read(&world, |door| {
        centraid_apps_money::phone::accounts(door, "2024-03-31").expect("Accounts")
    });
    let account = &screen.on_budget[0];
    assert_eq!(
        account.balance.as_ref().map(|m| m.amount_minor),
        Some(1_450)
    );
    let checkpoint = account.checkpoint.as_ref().expect("past checkpoint");
    assert_eq!(
        (
            checkpoint.as_of.as_str(),
            checkpoint.stated.amount_minor,
            checkpoint.delta.amount_minor,
            checkpoint.agrees
        ),
        ("2024-03-20", 1_450, 0, true),
        "future checkpoint ignored; void and opening-day rules stay in the shared fold"
    );
}

#[test]
fn streamed_accounts_finds_a_past_checkpoint_beyond_the_global_four_hundred_rows() {
    let world = World::founded("accounts-checkpoint-window");
    world.account("acct-many", "Many statements", "checking", "USD");
    world.account("acct-target", "Target", "savings", "EUR");
    world.ok(
        "checkpoint.record",
        json!({ "account_id": "acct-target", "day": "2024-03-20", "balance_minor": 900 }),
    );
    for offset in 0..401 {
        let day = centraid_apps_money::civil::shift("2025-01-01", offset).expect("future day");
        world.ok(
            "checkpoint.record",
            json!({ "account_id": "acct-many", "day": day, "balance_minor": offset }),
        );
    }

    let screen = read(&world, |door| {
        centraid_apps_money::phone::accounts(door, "2024-03-31").expect("Accounts")
    });
    let target = screen
        .on_budget
        .iter()
        .chain(&screen.off_budget)
        .find(|account| account.account_id == "acct-target")
        .expect("target account");
    let checkpoint = target
        .checkpoint
        .as_ref()
        .expect("checkpoint outside global page");
    assert_eq!(
        (checkpoint.as_of.as_str(), checkpoint.stated.amount_minor),
        ("2024-03-20", 900)
    );
    let many = screen
        .on_budget
        .iter()
        .chain(&screen.off_budget)
        .find(|account| account.account_id == "acct-many")
        .expect("many-checkpoint account");
    assert!(
        many.checkpoint.is_none(),
        "no past checkpoint is actually present"
    );
}

#[test]
fn streamed_ledger_preserves_the_forty_thousand_row_probe_boundary() {
    for (total, pending_rows, complete, expected_balance) in [
        (39_999, 1, true, Some(-39_998)),
        (40_000, 0, true, Some(-40_000)),
        (40_001, 0, false, None),
    ] {
        let door = bounded_ledger_door(total, -1, pending_rows);
        let mut trash = None;
        let mut visited = 0;
        let account = centraid_apps_money::queries::AccountRow {
            account_id: "acct-1".to_owned(),
            name: "Everyday".to_owned(),
            kind: "checking".to_owned(),
            on_budget: true,
            opening_minor: 0,
            opening_on: None,
            closed_on: None,
            currency: "USD".to_owned(),
            external_ref: None,
        };
        let mut fold =
            centraid_apps_money::engine::AccountBalanceFold::new(&account, &[], "2024-03-31");
        let result =
            centraid_apps_money::queries::fold_account_ledger(&door, "acct-1", &mut trash, |row| {
                visited += 1;
                fold.push(row);
            })
            .expect("bounded ledger fold");
        assert_eq!(result, complete, "total source rows: {total}");
        let delivered = total.min(40_000);
        let pages = delivered.div_ceil(500);
        assert_eq!(
            visited, delivered,
            "rows folded before completion is decided"
        );
        assert_eq!(door.delivered.get(), delivered, "delivered source rows");
        assert_eq!(
            door.calls.get(),
            pages + 1,
            "ledger pages plus one trash read"
        );
        assert_eq!(door.max_limit.get(), 500, "one page at a time");
        assert_eq!(door.trash_reads.get(), 1, "trash set loaded once");
        let balance = fold.finish(result);
        assert_eq!(balance.balance_minor, expected_balance);
        let worth = centraid_apps_money::engine::net_worth(
            std::slice::from_ref(&balance),
            std::slice::from_ref(&account),
            "2024-03-31",
        );
        assert_eq!(worth["USD"].1, complete, "net-worth completeness");
    }
}

#[test]
fn streamed_ledger_stops_on_short_pages_that_still_have_a_cursor() {
    for (short_page, empty_cursor, expected_calls, expected_trash_reads) in
        [(true, false, 2, 1), (false, true, 1, 0)]
    {
        let mut door = bounded_ledger_door(1_000, -1, 0);
        door.short_page = short_page;
        door.empty_cursor = empty_cursor;
        let mut trash = None;
        let complete =
            centraid_apps_money::queries::fold_account_ledger(&door, "acct-1", &mut trash, |_| {})
                .expect("short page result");
        assert!(!complete, "a short page with a continuation is incomplete");
        assert_eq!(door.calls.get(), expected_calls);
        assert_eq!(door.trash_reads.get(), expected_trash_reads);
    }
}

#[test]
fn balance_fold_cancels_wide_prefixes_and_marks_unrepresentable_totals_unavailable() {
    let account = centraid_apps_money::queries::AccountRow {
        account_id: "acct-1".to_owned(),
        name: "Everyday".to_owned(),
        kind: "checking".to_owned(),
        on_budget: true,
        opening_minor: i64::MAX,
        opening_on: None,
        closed_on: None,
        currency: "USD".to_owned(),
        external_ref: None,
    };
    let txn = |txn_id: &str, amount_minor: i64, direction| centraid_apps_money::queries::TxnRow {
        txn_id: txn_id.to_owned(),
        account_id: account.account_id.clone(),
        posted_on: "2024-03-06".to_owned(),
        amount_minor,
        currency: "USD".to_owned(),
        direction,
        status: "posted".to_owned(),
        description: String::new(),
        category_concept_id: None,
        external_id: None,
        display_name: None,
        display_name_source: None,
        memo: None,
        check_number: None,
        bank_type: None,
        imported_from: None,
    };
    let cancelling = [
        txn("credit", 1, centraid_apps_money::import::Direction::Credit),
        txn("debit", 1, centraid_apps_money::import::Direction::Debit),
    ];
    assert_eq!(
        centraid_apps_money::engine::balance_on(&account, &cancelling, "2024-03-31"),
        Some(i64::MAX),
        "the final representable balance survives an out-of-range prefix"
    );
    let mut fold =
        centraid_apps_money::engine::AccountBalanceFold::new(&account, &[], "2024-03-31");
    for row in &cancelling {
        fold.push(row);
    }
    assert_eq!(fold.finish(true).balance_minor, Some(i64::MAX));

    let overflowing = [txn(
        "credit",
        1,
        centraid_apps_money::import::Direction::Credit,
    )];
    assert_eq!(
        centraid_apps_money::engine::balance_on(&account, &overflowing, "2024-03-31"),
        None,
        "an unrepresentable final total is unavailable"
    );
    let mut fold =
        centraid_apps_money::engine::AccountBalanceFold::new(&account, &[], "2024-03-31");
    fold.push(&overflowing[0]);
    let balance = fold.finish(true);
    assert_eq!(balance.balance_minor, None);
    assert_eq!(
        centraid_apps_money::engine::net_worth(
            std::slice::from_ref(&balance),
            std::slice::from_ref(&account),
            "2024-03-31",
        )["USD"],
        (0, false)
    );

    let door = bounded_ledger_door(40_001, i64::MAX, 0);
    let mut trash = None;
    let mut fold =
        centraid_apps_money::engine::AccountBalanceFold::new(&account, &[], "2024-03-31");
    let complete =
        centraid_apps_money::queries::fold_account_ledger(&door, "acct-1", &mut trash, |row| {
            fold.push(row)
        })
        .expect("bounded prefix");
    assert!(!complete);
    assert_eq!(fold.finish(complete).balance_minor, None);
}

#[test]
fn a_rule_that_names_a_payee_reads_back_and_applies_in_the_app_as_in_the_vault() {
    let world = World::founded("payee");
    world.account("acct-1", "Everyday", "checking", "USD");
    world.ok(
        "rule.add",
        json!({ "id": "r1", "match": "contains", "text": "whole foods",
                "category_id": "category:food.groceries", "display_name": "Whole Foods" }),
    );
    world.ok(
        "rule.add",
        json!({ "id": "r2", "match": "contains", "text": "coffee",
                "category_id": "category:food.dining" }),
    );
    let rules = read(&world, |door| load_rules(door).expect("rules")).value;
    let named = rules.iter().find(|rule| rule.rule_id == "r1").unwrap();
    assert_eq!(named.display_name.as_deref(), Some("Whole Foods"));
    assert_eq!(
        rules
            .iter()
            .find(|rule| rule.rule_id == "r2")
            .unwrap()
            .display_name,
        None
    );
    let candidate = |description| Candidate {
        description,
        amount_minor: 4_250,
        account_id: "acct-1",
    };
    assert_eq!(
        rules::apply(&rules, &candidate("WHOLE FOODS MKT 123"))
            .display_name
            .as_deref(),
        Some("Whole Foods")
    );
    assert_eq!(
        rules::apply(&rules, &candidate("BLUE COFFEE CO")).display_name,
        None
    );
}

/// A TRANSACTION IN THE TRASH (#1185) is `entity.deleted_at` and nothing of the line: the bank's
/// amount, day and account are untouched (the line's triggers are never fired), every window and
/// the ledger leave it out, the trash reads it with the name the member sees, and a restore brings
/// the line back exactly.
#[test]
fn a_trashed_line_is_the_entitys_stamp_alone_and_a_restore_brings_it_back_exactly() {
    let world = World::founded("trashed-line");
    world.account("acct-1", "Everyday", "checking", "USD");
    world.import(
        "acct-1",
        &[
            ("csv:aaaaa", "2024-03-05", -4_250, "WHOLE FOODS MKT 123"),
            ("csv:bbbbb", "2024-03-06", 300_000, "ACME PAYROLL"),
        ],
    );
    let grocer = world.line("csv:aaaaa");
    world.ok(
        "entity.retitle",
        json!({ "id": grocer, "title": "Groceries" }),
    );
    let figures = |world: &World| {
        let month = read(world, |door| {
            load_month(door, "2024-03", &ActivityFilter::default()).expect("month")
        });
        let ledger = read(world, |door| load_ledger(door, "acct-1").expect("ledger"));
        (
            month.value.iter().map(|row| row.amount_minor).sum::<i64>(),
            month.value.len(),
            ledger.value.len(),
        )
    };
    let before = figures(&world);
    // `amount_minor` is the magnitude: the sum is of what moved, in or out.
    assert_eq!(before, (4_250 + 300_000, 2, 2));
    let account_balance = |world: &World| {
        let screen = read(world, |door| {
            centraid_apps_money::phone::accounts(door, "2024-03-31").expect("Accounts")
        });
        screen.on_budget[0]
            .balance
            .as_ref()
            .expect("complete balance")
            .amount_minor
    };
    assert_eq!(account_balance(&world), 295_750);
    let line_before = read(&world, |door| load_transaction(door, &grocer).expect("one"));

    world.ok("entity.trash", json!({ "id": grocer }));
    assert_eq!(
        figures(&world),
        (300_000, 1, 1),
        "the trashed line is in no figure"
    );
    assert_eq!(account_balance(&world), 300_000);
    assert_eq!(
        read(&world, |door| load_transaction(door, &grocer).expect("one")),
        None,
        "and its page reads it as gone"
    );
    let shelf = read(&world, |door| load_trash(door).expect("trash"));
    assert!(!shelf.truncated);
    assert_eq!(shelf.transactions.len(), 1);
    assert_eq!(shelf.transactions[0].txn_id, grocer);
    assert_eq!(shelf.transactions[0].title, "Groceries");
    assert!(shelf.transactions[0].deleted_at.is_some() && shelf.transactions[0].purge_at.is_some());

    world.ok("entity.restore", json!({ "id": grocer }));
    assert_eq!(figures(&world), before, "restored: every figure is back");
    assert_eq!(account_balance(&world), 295_750);
    assert_eq!(
        read(&world, |door| load_transaction(door, &grocer).expect("one")),
        line_before,
        "the line is exactly what it was"
    );
    assert!(
        read(&world, |door| load_trash(door).expect("trash"))
            .transactions
            .is_empty()
    );
}

/// A STATEMENT IMPORTED AGAIN NEVER BRINGS A TRASHED LINE BACK (#1185): the follow engine finds the
/// line by its statement id, sees the trash is the member's (not its own for an absence, and a
/// statement line is never removed for one), and leaves it; the plan counts it as already in.
#[test]
fn a_reimported_statement_leaves_a_trashed_line_in_the_trash_and_the_plan_calls_it_already_in() {
    let world = World::founded("reimport");
    world.account("acct-1", "Everyday", "checking", "USD");
    let lines = [
        ("csv:aaaaa", "2024-03-05", -4_250, "WHOLE FOODS MKT 123"),
        ("csv:bbbbb", "2024-03-06", 300_000, "ACME PAYROLL"),
    ];
    world.import("acct-1", &lines);
    let grocer = world.line("csv:aaaaa");
    world.ok("entity.trash", json!({ "id": grocer }));

    // The plan keeps the trashed line in its view of the account, marked, so the row is `already_in`.
    let existing = read(&world, |door| {
        load_existing(door, "acct-1", "2024-03-01", "2024-03-31").expect("existing")
    });
    assert_eq!(existing.len(), 2);
    let held = existing
        .iter()
        .find(|line| line.txn_id == grocer)
        .expect("the trashed line");
    assert_eq!(
        (held.external_id.as_deref(), held.trashed, held.void),
        (Some("csv:aaaaa"), true, false)
    );

    // The same statement again: nothing is added, nothing is restored, the line stays in the trash.
    let again = world.import("acct-1", &lines);
    assert_eq!(again["added"], 0, "{again}");
    assert_eq!(again["restored"], 0, "{again}");
    let ledger = read(&world, |door| load_ledger(door, "acct-1").expect("ledger"));
    assert_eq!(ledger.value.len(), 1, "still only the payroll");
    let shelf = read(&world, |door| load_trash(door).expect("trash"));
    assert_eq!(shelf.transactions.len(), 1);
    assert_eq!(world.line("csv:aaaaa"), grocer, "no second line was made");

    // A statement that no longer holds the line (the bank dropped it) does not take it out either:
    // a statement line is never removed, so the member's restore still finds it.
    world.import("acct-1", &lines[1..]);
    world.ok("entity.restore", json!({ "id": grocer }));
    let ledger = read(&world, |door| load_ledger(door, "acct-1").expect("ledger"));
    assert_eq!(ledger.value.len(), 2);
}

/// A TRANSFER WITH A HALF IN THE TRASH IS NOT LIVE (#1185): the half that is left counts as the
/// ordinary line it is, and the link is whole again when the other half is restored.
#[test]
fn a_transfer_with_a_trashed_half_is_not_a_link_until_the_half_is_restored() {
    let world = World::founded("transfer-trash");
    world.account("acct-1", "Everyday", "checking", "USD");
    world.account("acct-2", "Savings", "savings", "USD");
    world.import(
        "acct-1",
        &[("csv:out", "2024-03-05", -10_000, "TO SAVINGS")],
    );
    world.import(
        "acct-2",
        &[("csv:in", "2024-03-05", 10_000, "FROM CHECKING")],
    );
    let (out, into) = (world.line("csv:out"), world.line("csv:in"));
    world.ok("txn.link_transfer", json!({ "id": out, "other_id": into }));
    let links = |world: &World| read(world, |door| load_transfer_links(door).expect("links")).value;
    assert_eq!(links(&world).len(), 1);
    world.ok("entity.trash", json!({ "id": into }));
    assert!(links(&world).is_empty());
    world.ok("entity.restore", json!({ "id": into }));
    assert_eq!(links(&world).len(), 1);
}
