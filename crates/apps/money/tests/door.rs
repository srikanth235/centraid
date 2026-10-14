//! THE APP'S OWN DOOR, against a real vault (#1099).
//!
//! `cargo test -p centraid-apps-money --features vault-door`. What it asserts
//! is the MAPPING: an executed command answers its output, a refused one
//! answers `Failed` with the condition's sentence, a command nobody registered
//! is the one `Err`. Then the manifest's action schemas against the vault's,
//! the same key delivered twice, and seam S2 against the real
//! `money.apply_rule_to_history`.

#![cfg(feature = "vault-door")]

mod common;

use std::fs;
use std::path::Path;

use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_money::commands::{ACTIONS, Commands, Outcome, run};
use centraid_apps_money::door::VaultDoor;
use centraid_apps_money::manifest::manifest;
use centraid_apps_money::queries::{ActivityFilter, load_month};
use centraid_apps_money::rules::{self, Candidate, MatchKind, Rule};
use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use common::{Scratch, add_account, execute, invocation};
use serde_json::{Value, json};

#[test]
fn the_door_maps_every_state_the_surface_renders() {
    let scratch = Scratch::founded("door");
    let door = scratch.door();
    add_account(&door, "acct-1", "Checking", "checking", "USD");

    // FAILED, with the condition's own sentence: not an error, not a denial.
    let refused = door
        .invoke(&invocation(
            "money.import_transactions",
            json!({ "account_id": "nope", "source": "csv", "rows": [] }),
            "k",
        ))
        .expect("the door is there");
    assert_eq!(
        refused,
        Outcome::Failed {
            reason: Some("There is no Money account with that id.".to_owned())
        }
    );

    // A schema violation is also a value.
    let invalid = door
        .invoke(&invocation(
            "money.categorize",
            json!({ "txn_ids": "x" }),
            "k",
        ))
        .expect("the door is there");
    assert!(
        matches!(invalid, Outcome::Failed { reason: Some(_) }),
        "{invalid:?}"
    );

    // AN UNREGISTERED COMMAND is the one `Err`: the door itself cannot serve it.
    let mut empty = Registry::new();
    empty
        .register(
            centraid_vault::commands::core::definitions()
                .into_iter()
                .next()
                .expect("there is one"),
        )
        .expect("it registers");
    let narrow = VaultDoor::new(&scratch.vault, &empty, Principal::owner("phone"));
    let unavailable = narrow
        .invoke(&invocation("money.add_account", json!({}), "k"))
        .expect_err("a door that cannot serve the command fails closed");
    assert_eq!(unavailable.command, "money.add_account");
}

#[test]
fn the_same_key_delivered_twice_runs_twice_and_the_commands_make_that_safe() {
    let scratch = Scratch::founded("twice");
    let door = scratch.door();
    let add = |key: &str| {
        run(
            &door,
            "add-account",
            [
                ("account_id", json!("acct-1")),
                ("name", json!("Checking")),
                ("kind", json!("checking")),
                ("currency", json!("USD")),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
            key,
        )
        .expect("the door is there")
    };
    // `Once`, by an id the phone minted: a second delivery is refused, a value.
    assert!(matches!(add("same-key"), Outcome::Executed { .. }));
    assert!(matches!(add("same-key"), Outcome::Failed { .. }));
    // Idempotent by content: a second delivery runs again and changes nothing.
    let target = |key: &str| {
        run(
            &door,
            "set-target",
            [
                ("month", json!("2024-03")),
                ("category_concept_id", json!("money:cat:food.groceries")),
                ("amount_minor", json!(5000)),
                ("currency", json!("USD")),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
            key,
        )
        .expect("the door is there")
    };
    let first = target("k");
    let second = target("k");
    assert!(
        matches!(first, Outcome::Executed { .. }) && matches!(second, Outcome::Executed { .. })
    );
    let rows = scratch
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            Ok(
                centraid_apps_money::queries::load_targets(&door, "2024-03", "2024-03")
                    .expect("targets read")
                    .value,
            )
        })
        .expect("reads");
    assert_eq!(rows.len(), 1, "one target, however many deliveries");
}

#[test]
fn the_action_schemas_are_the_vaults() {
    let scratch = Scratch::founded("schemas");
    for row in ACTIONS {
        let declared = &manifest().action(row.action).expect("declared").input;
        let registered = scratch
            .registry
            .get(row.command)
            .unwrap_or_else(|| panic!("the vault registers {}", row.command));
        assert_eq!(declared, registered.schema(), "{} input schema", row.action);
    }
    assert_eq!(
        scratch
            .registry
            .names()
            .iter()
            .filter(|n| n.starts_with("money."))
            .count(),
        ACTIONS.len(),
        "every money command has an action and the table has no extra"
    );
}

#[test]
fn seam_s2_the_crate_and_the_vault_agree_on_every_row_of_the_shared_cases() {
    let text = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../contracts/apps/money/rules.json"),
    )
    .expect("the case file");
    let case: Value = serde_json::from_str(&text).expect("JSON");
    let rule_of = |r: &Value| Rule {
        rule_id: r["rule_id"].as_str().unwrap().to_owned(),
        kind: match r["match_kind"].as_str().unwrap() {
            "is" => MatchKind::Is,
            "matches" => MatchKind::Matches,
            _ => MatchKind::Contains,
        },
        pattern: r["pattern"].as_str().unwrap().to_owned(),
        amount_min_minor: r["amount_min_minor"].as_i64(),
        amount_max_minor: r["amount_max_minor"].as_i64(),
        account_id: None,
        category_concept_id: r["set_category_concept_id"].as_str().map(str::to_owned),
        display_name: r["set_display_name"].as_str().map(str::to_owned),
        position: r["position"].as_i64().unwrap(),
    };
    let crate_rules: Vec<Rule> = case["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(rule_of)
        .collect();
    let rows = case["rows"].as_array().unwrap();

    // The crate's reading of the cases is the hand-computed expectation.
    for row in rows {
        let applied = rules::apply(
            &crate_rules,
            &Candidate {
                description: row["description"].as_str().unwrap(),
                amount_minor: row["amount_minor"].as_i64().unwrap(),
                account_id: "acct-1",
            },
        );
        assert_eq!(
            applied.category_concept_id.as_deref(),
            row["category"].as_str(),
            "{}",
            row["why"]
        );
        assert_eq!(
            applied.display_name.as_deref(),
            row["display_name"].as_str(),
            "{}",
            row["why"]
        );
    }

    // The vault's reading, through the real commands, is the same.
    let scratch = Scratch::founded("s2");
    let door = scratch.door();
    add_account(&door, "acct-1", "Checking", "checking", "USD");
    let import_rows: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(at, row)| {
            json!({
                "txn_id": format!("txn-{at}"),
                "external_id": format!("csv:case{at}"),
                "posted_on": "2024-03-05",
                "amount_minor": row["amount_minor"],
                "direction": "debit",
                "description": row["description"],
            })
        })
        .collect();
    execute(
        &door,
        "money.import_transactions",
        json!({ "account_id": "acct-1", "source": "csv", "rows": import_rows }),
    );
    for rule in case["rules"].as_array().unwrap() {
        execute(&door, "money.add_rule", rule.clone());
    }
    let applied = execute(&door, "money.apply_rule_to_history", json!({}));
    assert!(applied["matched"].as_i64().unwrap() > 0);
    let read = scratch
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            Ok(load_month(&door, "2024-03", &ActivityFilter::default())
                .expect("month")
                .value)
        })
        .expect("reads");
    for (at, row) in rows.iter().enumerate() {
        let stored = read
            .iter()
            .find(|r| r.txn_id == format!("txn-{at}"))
            .expect("imported");
        assert_eq!(
            stored.category_concept_id.as_deref(),
            row["category"].as_str(),
            "vault category, {}",
            row["why"]
        );
        assert_eq!(
            stored.display_name.as_deref(),
            row["display_name"].as_str(),
            "vault name, {}",
            row["why"]
        );
    }
}
