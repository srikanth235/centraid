//! Money's reads against a vault the product founds and Money's own commands fill
//! (#1135): the lines a statement left, the bank's words kept beside the member's
//! name, an account and its bank number, the categories, the rules and plans, and
//! seam S2 (the app's rule semantics and the vault's agree on every shared case).

mod common;

use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_money::import::{CsvOptions, read_csv};
use centraid_apps_money::queries::{
    ActivityFilter, load_accounts, load_categories, load_checkpoints, load_existing, load_ledger,
    load_month, load_rules, load_saved_profiles, load_targets, load_transaction,
    load_transfer_links,
};
use centraid_apps_money::rules::{self, Candidate, MatchKind, Rule};
use common::World;
use serde_json::{Value, json};

fn read<T>(world: &World, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
    world
        .vault
        .read(|connection| Ok(body(&TestDoor::new(connection))))
        .expect("reads")
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
                "external_ref": "1234-5678", "opening_minor": -2_000, "on_budget": false }),
    );
    world.ok("flag.set", json!({ "id": "acct-2", "flag": "archived" }));
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
            card.on_budget
        ),
        (
            "Card",
            "credit_card",
            "EUR",
            Some("1234-5678"),
            -2_000,
            false
        )
    );
    assert!(card.closed_on.as_deref().is_some_and(|day| day.len() == 10));
    world.ok("entity.trash", json!({ "id": "acct-1" }));
    let accounts = read(&world, |door| load_accounts(door).expect("accounts"));
    assert_eq!(accounts.len(), 1);
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
        (world.line("csv:out01"), world.line("csv:in001"))
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
