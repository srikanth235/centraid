//! Money's and Health's verbs against a vault the product founds: an account and
//! its one statement origin, a statement followed line by line (never edited,
//! re-imported for nothing, a member's category and name surviving), a transfer,
//! a void, a plan, a checkpoint, a rule applied to history, a category merged,
//! a batch of days, and a workout followed from a health store.

mod common;

use std::collections::BTreeSet;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("money").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: Value) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn refused(&self, name: &str, input: Value) -> String {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{name} was not refused"
        );
        outcome.reason.expect("a sentence")
    }

    fn id(&self, name: &str, input: Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn count(&self, sql: &str, params: &[&str]) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn text(&self, sql: &str, params: &[&str]) -> Option<String> {
        self.scratch
            .vault
            .read(|c| {
                Ok(
                    c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))
                        .optional()?
                        .flatten(),
                )
            })
            .expect("a row")
    }

    fn version(&self, id: &str) -> i64 {
        self.count("SELECT version FROM entity WHERE id = ?1", &[id])
    }

    fn account(&self, title: &str) -> String {
        self.id(
            "account.add",
            json!({ "title": title, "type": "checking", "currency": "USD" }),
        )
    }

    /// One line of a statement: signed, money out negative.
    fn import(&self, account: &str, lines: &[(&str, &str, i64, &str)]) -> Value {
        let records: Vec<Value> = lines
            .iter()
            .map(|(external, day, amount, words)| {
                json!({
                    "external_id": external,
                    "fields": {
                        "title": words,
                        "posted_on": day,
                        "amount_minor": amount,
                        "line": { "memo": "m", "imported_from": "csv" },
                    }
                })
            })
            .collect();
        self.ok(
            "follow.statement",
            json!({
                "origin": { "ref": account, "label": "Everyday", "fills": account },
                "records": records,
            }),
        )
    }

    fn line(&self, external: &str) -> String {
        self.text(
            "SELECT entity_id FROM source WHERE external_id = ?1",
            &[external],
        )
        .expect("a followed line")
    }
}

const GROCER: (&str, &str, i64, &str) = ("csv:aaaaa", "2026-03-02", -4_250, "WHOLE FOODS MKT 123");
const PAY: (&str, &str, i64, &str) = ("csv:bbbbb", "2026-03-03", 300_000, "ACME PAYROLL");
const COFFEE: (&str, &str, i64, &str) = ("csv:ccccc", "2026-03-04", -450, "BLUE COFFEE CO");

#[test]
fn an_account_has_one_statement_origin_from_birth_and_keeps_its_bank_number_there() {
    let world = World::new();
    let plain = world.account("Everyday");
    let numbered = world.id(
        "account.add",
        json!({ "title": "Card", "type": "credit_card", "external_ref": "1234-5678" }),
    );
    // No number: the origin's ref is the account's own id.
    assert_eq!(
        world
            .text("SELECT ref FROM origin WHERE fills = ?1", &[&plain])
            .as_deref(),
        Some(plain.as_str())
    );
    assert_eq!(
        world
            .text("SELECT ref FROM origin WHERE fills = ?1", &[&numbered])
            .as_deref(),
        Some("1234-5678")
    );
    // The vault's currency is the default; a name is the account's title.
    let defaulted = world.id("account.add", json!({ "title": "Cash", "type": "cash" }));
    assert_eq!(
        world
            .text("SELECT currency FROM account WHERE id = ?1", &[&defaulted])
            .as_deref(),
        world.text("SELECT currency FROM vault", &[]).as_deref()
    );
    assert!(
        world
            .refused(
                "account.add",
                json!({ "title": " everyday ", "type": "savings" })
            )
            .contains("already have an account")
    );
    assert!(
        world
            .refused(
                "account.add",
                json!({ "title": "Other", "type": "savings", "external_ref": "1234-5678" })
            )
            .contains("bank number")
    );
    // The number moves the origin's ref and clearing it falls back to the id.
    world.ok(
        "account.edit",
        json!({ "id": plain, "external_ref": "99-0001" }),
    );
    assert_eq!(
        world
            .text("SELECT ref FROM origin WHERE fills = ?1", &[&plain])
            .as_deref(),
        Some("99-0001")
    );
    world.ok("account.edit", json!({ "id": plain, "external_ref": null }));
    assert_eq!(
        world
            .text("SELECT ref FROM origin WHERE fills = ?1", &[&plain])
            .as_deref(),
        Some(plain.as_str())
    );
    // A card cannot become a checking account; checking can become savings.
    assert!(
        world
            .refused(
                "account.edit",
                json!({ "id": numbered, "type": "checking" })
            )
            .contains("own kind of account")
    );
    world.ok("account.edit", json!({ "id": plain, "type": "savings" }));
    // Closing is the archived flag; renaming is the shared retitle.
    world.ok("flag.set", json!({ "id": plain, "flag": "archived" }));
    world.ok(
        "entity.retitle",
        json!({ "id": plain, "title": "Rainy day" }),
    );
    assert_eq!(
        world
            .text("SELECT title FROM entity WHERE id = ?1", &[&plain])
            .as_deref(),
        Some("Rainy day")
    );
}

#[test]
fn a_statement_is_followed_line_by_line_and_a_reimport_writes_nothing() {
    let world = World::new();
    let account = world.account("Everyday");
    let first = world.import(&account, &[GROCER, PAY, COFFEE]);
    assert_eq!(first["added"], 3);
    let grocer = world.line(GROCER.0);
    let before = world.version(&grocer);
    // The line is the account's, in its currency, with the bank's own words kept.
    assert_eq!(
        world
            .text(
                "SELECT currency || ' ' || amount_minor FROM txn WHERE id = ?1",
                &[&grocer]
            )
            .as_deref(),
        Some("USD -4250")
    );
    assert_eq!(
        world
            .text(
                "SELECT json_extract(stated, '$.line.memo') FROM source WHERE entity_id = ?1",
                &[&grocer]
            )
            .as_deref(),
        Some("m")
    );
    let again = world.import(&account, &[GROCER, PAY, COFFEE]);
    assert_eq!(
        (again["added"].as_i64(), again["updated"].as_i64()),
        (Some(0), Some(0))
    );
    assert_eq!(again["unchanged"], 3);
    assert_eq!(
        world.version(&grocer),
        before,
        "a re-import touches nothing"
    );
    assert_eq!(world.count("SELECT COUNT(*) FROM txn", &[]), 3);
}

#[test]
fn a_line_is_never_edited_and_the_members_category_and_name_survive_a_restatement() {
    let world = World::new();
    let account = world.account("Everyday");
    world.import(&account, &[GROCER]);
    let grocer = world.line(GROCER.0);
    world.ok(
        "txn.categorize",
        json!({ "ids": [grocer], "category_id": "category:food.groceries" }),
    );
    world.ok(
        "entity.retitle",
        json!({ "id": grocer, "title": "Groceries" }),
    );
    // The bank restates the line with a different day, amount and words, and
    // names a category of its own: none of it reaches the row.
    let restated = world.ok(
        "follow.statement",
        json!({
            "origin": { "ref": account, "label": "Everyday", "fills": account },
            "records": [{
                "external_id": GROCER.0,
                "fields": {
                    "title": "WHOLE FOODS MARKET",
                    "posted_on": "2026-03-09",
                    "amount_minor": -9_999,
                    "category_id": "category:food.dining",
                }
            }],
        }),
    );
    assert_eq!(restated["added"], 0);
    assert_eq!(
        world
            .text(
                "SELECT posted_on || ' ' || amount_minor || ' ' || category_id FROM txn WHERE id = ?1",
                &[&grocer]
            )
            .as_deref(),
        Some("2026-03-02 -4250 category:food.groceries")
    );
    assert_eq!(
        world
            .text("SELECT title FROM entity WHERE id = ?1", &[&grocer])
            .as_deref(),
        Some("Groceries")
    );
    // The schema says so too: a line's day and amount are never written.
    let refused = world.scratch.vault.commit(|tx| {
        tx.connection()
            .execute("UPDATE txn SET amount_minor = 1 WHERE id = ?1", [&grocer])?;
        Ok(())
    });
    assert!(
        refused
            .expect_err("refused")
            .to_string()
            .contains("never edited")
    );
}

#[test]
fn a_line_stated_in_a_category_the_member_never_changed_follows_the_bank() {
    let world = World::new();
    let account = world.account("Everyday");
    let record = |category: &str| {
        json!({
            "origin": { "ref": account, "label": "Everyday", "fills": account },
            "records": [{
                "external_id": COFFEE.0,
                "fields": {
                    "title": COFFEE.3, "posted_on": COFFEE.1, "amount_minor": COFFEE.2,
                    "category_id": category,
                }
            }],
        })
    };
    world.ok("follow.statement", record("category:food.dining"));
    let coffee = world.line(COFFEE.0);
    world.ok("follow.statement", record("category:fun.entertainment"));
    assert_eq!(
        world
            .text("SELECT category_id FROM txn WHERE id = ?1", &[&coffee])
            .as_deref(),
        Some("category:fun.entertainment")
    );
}

#[test]
fn a_transfer_is_two_lines_pointing_at_each_other_and_a_void_ends_it() {
    let world = World::new();
    let current = world.account("Everyday");
    let savings = world.account("Savings");
    world.import(
        &current,
        &[("csv:out01", "2026-03-05", -50_000, "TO SAVINGS")],
    );
    world.import(
        &savings,
        &[("csv:in001", "2026-03-05", 50_000, "FROM EVERYDAY")],
    );
    world.import(&current, &[("csv:out02", "2026-03-06", -700, "SNACK")]);
    let (out, into, snack) = (
        world.line("csv:out01"),
        world.line("csv:in001"),
        world.line("csv:out02"),
    );
    assert!(
        world
            .refused("txn.link_transfer", json!({ "id": out, "other_id": snack }))
            .contains("between two accounts")
    );
    world.import(&savings, &[("csv:out03", "2026-03-05", -300, "FEE")]);
    assert!(
        world
            .refused(
                "txn.link_transfer",
                json!({ "id": out, "other_id": world.line("csv:out03") })
            )
            .contains("money out and the other money in")
    );
    assert!(
        world
            .refused("txn.link_transfer", json!({ "id": out, "other_id": out }))
            .contains("two different")
    );
    world.ok("txn.link_transfer", json!({ "id": out, "other_id": into }));
    let paired = |a: &str, b: &str| {
        world
            .text("SELECT transfer_id FROM txn WHERE id = ?1", &[a])
            .as_deref()
            == Some(b)
    };
    assert!(paired(&out, &into) && paired(&into, &out));
    // Saying it again changes nothing; a third line cannot join.
    assert_eq!(
        world.ok("txn.link_transfer", json!({ "id": into, "other_id": out }))["linked"],
        false
    );
    world.import(&savings, &[("csv:in002", "2026-03-06", 700, "REFUND")]);
    let refund = world.line("csv:in002");
    assert!(
        world
            .refused(
                "txn.link_transfer",
                json!({ "id": refund, "other_id": out })
            )
            .contains("another transfer")
    );
    // A void is final, ends the transfer on both halves, and cannot be filed.
    let voided = world.ok("txn.void", json!({ "id": out }));
    assert_eq!(voided["transfers_ended"], 2);
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM txn WHERE transfer_id IS NOT NULL",
            &[]
        ),
        0
    );
    assert!(
        world
            .refused(
                "txn.categorize",
                json!({ "ids": [out], "category_id": "category:fees" })
            )
            .contains("removed")
    );
    let revived = world.scratch.vault.commit(|tx| {
        tx.connection()
            .execute("UPDATE txn SET status = 'posted' WHERE id = ?1", [&out])?;
        Ok(())
    });
    assert!(
        revived
            .expect_err("refused")
            .to_string()
            .contains("stays void")
    );
}

#[test]
fn a_plan_a_carry_and_a_checkpoint_are_idempotent_rows_not_figures() {
    let world = World::new();
    let account = world.account("Everyday");
    let plan =
        json!({ "month": "2026-03", "category_id": "category:food", "amount_minor": 60_000 });
    assert_eq!(world.ok("budget.set", plan.clone())["changed"], true);
    assert_eq!(world.ok("budget.set", plan)["changed"], false);
    assert!(
        world
            .refused(
                "budget.set",
                json!({ "month": "2026-13", "category_id": "category:food", "amount_minor": 1 })
            )
            .contains("real month")
    );
    assert!(
        world
            .refused(
                "budget.set_carry",
                json!({ "month": "2026-04", "category_id": "category:food", "carry": true })
            )
            .contains("Set an amount")
    );
    assert_eq!(
        world.ok(
            "budget.set_carry",
            json!({ "month": "2026-03", "category_id": "category:food", "carry": true })
        )["changed"],
        true
    );
    assert_eq!(
        world.ok(
            "budget.set",
            json!({ "month": "2026-03", "category_id": "category:food", "amount_minor": null })
        )["changed"],
        true
    );
    assert_eq!(world.count("SELECT COUNT(*) FROM budget", &[]), 0);

    let stated = json!({ "account_id": account, "day": "2026-03-31", "balance_minor": 120_000 });
    assert_eq!(
        world.ok("checkpoint.record", stated.clone())["written"],
        true
    );
    assert_eq!(world.ok("checkpoint.record", stated)["written"], false);
    world.ok(
        "checkpoint.record",
        json!({ "account_id": account, "day": "2026-03-31", "balance_minor": 119_000 }),
    );
    assert_eq!(
        world.count("SELECT balance_minor FROM checkpoint", &[]),
        119_000
    );
    world.ok(
        "account.set_opening",
        json!({ "id": account, "opening_minor": 5_000 }),
    );
    assert_eq!(world.count("SELECT opening_minor FROM account", &[]), 5_000);
}

#[test]
fn a_rule_files_history_by_the_banks_words_and_the_most_specific_rule_decides() {
    let world = World::new();
    let account = world.account("Everyday");
    world.import(
        &account,
        &[
            GROCER,
            PAY,
            COFFEE,
            ("csv:ddddd", "2026-03-05", -8_000, "BLUE COFFEE ROASTERS"),
        ],
    );
    let broad = world.id(
        "rule.add",
        json!({ "match": "contains", "text": "coffee", "category_id": "category:food.dining" }),
    );
    let narrow = world.id(
        "rule.add",
        json!({ "match": "contains", "text": "coffee", "min": 5000, "category_id": "category:shopping.general" }),
    );
    let _ = (broad, narrow);
    let applied = world.ok("rule.apply", json!({}));
    assert_eq!(applied["matched"], 2);
    assert_eq!(applied["recategorised"], 2);
    let category = |external: &str| {
        world.text(
            "SELECT category_id FROM txn WHERE id = ?1",
            &[&world.line(external)],
        )
    };
    assert_eq!(category(COFFEE.0).as_deref(), Some("category:food.dining"));
    assert_eq!(
        category("csv:ddddd").as_deref(),
        Some("category:shopping.general")
    );
    // A member's choice survives a second run, and only `overwrite` replaces it.
    world.ok(
        "txn.categorize",
        json!({ "ids": [world.line(COFFEE.0)], "category_id": "category:fees" }),
    );
    assert_eq!(world.ok("rule.apply", json!({}))["recategorised"], 0);
    assert_eq!(category(COFFEE.0).as_deref(), Some("category:fees"));
    assert_eq!(
        world.ok("rule.apply", json!({ "overwrite": true }))["recategorised"],
        1
    );
    assert_eq!(category(COFFEE.0).as_deref(), Some("category:food.dining"));
    // What matches is the statement's words, not the name the member gave.
    world.ok(
        "entity.retitle",
        json!({ "id": world.line(COFFEE.0), "title": "Morning" }),
    );
    world.ok(
        "txn.categorize",
        json!({ "ids": [world.line(COFFEE.0)], "category_id": null }),
    );
    assert_eq!(world.ok("rule.apply", json!({}))["recategorised"], 1);
    // A rule is edited in place, and an archived category is not a place to file.
    let rules = world.count("SELECT COUNT(*) FROM rule", &[]);
    assert_eq!(rules, 2);
    world.ok(
        "flag.set",
        json!({ "id": "category:fees", "flag": "archived" }),
    );
    assert!(
        world
            .refused(
                "rule.add",
                json!({ "match": "is", "text": "x", "category_id": "category:fees" })
            )
            .contains("archived")
    );
    assert!(
        world
            .refused("rule.apply", json!({ "id": "no-such-rule" }))
            .contains("no such rule")
    );
}

#[test]
fn a_category_is_added_under_a_group_and_merged_with_everything_it_held() {
    let world = World::new();
    let account = world.account("Everyday");
    world.import(&account, &[COFFEE]);
    let beans = world.id(
        "category.add",
        json!({ "title": "Beans  & Co", "parent_id": "category:food" }),
    );
    assert_eq!(beans, "category:food.beans & co");
    assert!(
        world
            .refused(
                "category.add",
                json!({ "title": "beans & co", "parent_id": "category:food" })
            )
            .contains("already a category")
    );
    assert!(
        world
            .refused(
                "category.add",
                json!({ "title": "Deep", "parent_id": beans })
            )
            .contains("not under another category")
    );
    // The same name in another group is another category.
    world.id(
        "category.add",
        json!({ "title": "Beans & Co", "parent_id": "category:fun" }),
    );
    let coffee = world.line(COFFEE.0);
    world.ok(
        "txn.categorize",
        json!({ "ids": [coffee], "category_id": beans }),
    );
    world.ok(
        "rule.add",
        json!({ "match": "is", "text": "x", "category_id": beans }),
    );
    world.ok(
        "budget.set",
        json!({ "month": "2026-03", "category_id": beans, "amount_minor": 100, "currency": "USD" }),
    );
    world.ok("budget.set", json!({ "month": "2026-03", "category_id": "category:food.dining", "amount_minor": 50, "currency": "USD" }));
    world.ok(
        "budget.set",
        json!({ "month": "2026-04", "category_id": beans, "amount_minor": 70, "currency": "USD" }),
    );
    let merged = world.ok(
        "category.merge",
        json!({ "from_id": beans, "into_id": "category:food.dining" }),
    );
    assert_eq!(
        (merged["transactions"].as_i64(), merged["rules"].as_i64()),
        (Some(1), Some(1))
    );
    assert_eq!(
        world
            .text("SELECT category_id FROM txn WHERE id = ?1", &[&coffee])
            .as_deref(),
        Some("category:food.dining")
    );
    assert_eq!(
        world.count("SELECT category_id = 'category:food.dining' FROM rule", &[]),
        1
    );
    assert_eq!(
        world.count(
            "SELECT amount_minor FROM budget WHERE category_id = 'category:food.dining' AND month = '2026-03'",
            &[]
        ),
        150
    );
    assert_eq!(
        world.count("SELECT COUNT(*) FROM budget WHERE month = '2026-04' AND category_id = 'category:food.dining'", &[]),
        1
    );
    assert_eq!(
        world.count("SELECT COUNT(*) FROM entity WHERE id = ?1", &[&beans]),
        0
    );
    // A group with categories in it cannot be merged away.
    assert!(
        world
            .refused(
                "category.merge",
                json!({ "from_id": "category:food", "into_id": "category:fun" })
            )
            .contains("inside it")
    );
}

#[test]
fn an_account_takes_its_origin_and_its_lines_with_it_when_purged() {
    let world = World::new();
    let account = world.account("Everyday");
    world.import(&account, &[GROCER, PAY]);
    world.ok("entity.trash", json!({ "id": account }));
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM entity WHERE kind = 'txn' AND deleted_at IS NOT NULL",
            &[]
        ),
        2
    );
    world.ok("entity.purge", json!({ "id": account }));
    for table in ["txn", "account", "origin", "source"] {
        assert_eq!(
            world.count(&format!("SELECT COUNT(*) FROM {table}"), &[]),
            0,
            "{table}"
        );
    }
}

#[test]
fn days_are_recorded_once_and_only_a_changed_value_is_written() {
    let world = World::new();
    let days = json!({ "days": [
        { "day": "2026-03-01", "metric": "steps", "value": 8000 },
        { "day": "2026-03-01", "metric": "weight_kg", "value": 71.5 },
        { "day": "2026-03-02", "metric": "steps", "value": 9100 },
    ]});
    let first = world.ok("measurement.record", days.clone());
    assert_eq!(
        (first["written"].as_i64(), first["unchanged"].as_i64()),
        (Some(3), Some(0))
    );
    let second = world.ok("measurement.record", days);
    assert_eq!(
        (second["written"].as_i64(), second["unchanged"].as_i64()),
        (Some(0), Some(3))
    );
    let changed = world.ok(
        "measurement.record",
        json!({ "days": [
            { "day": "2026-03-01", "metric": "steps", "value": 0 },
            { "day": "2026-03-02", "metric": "steps", "value": 9100 },
        ]}),
    );
    assert_eq!(
        (changed["written"].as_i64(), changed["unchanged"].as_i64()),
        (Some(1), Some(1))
    );
    assert_eq!(
        world.count("SELECT CAST(value AS INTEGER) FROM measurement WHERE day = '2026-03-01' AND metric = 'steps'", &[]),
        0
    );
    assert!(
        world
            .refused(
                "measurement.record",
                json!({ "days": [
                    { "day": "2026-03-01", "metric": "steps", "value": 1 },
                    { "day": "2026-03-01", "metric": "steps", "value": 2 },
                ]})
            )
            .contains("stated twice")
    );
    assert!(
        world
            .refused(
                "measurement.record",
                json!({ "days": [{ "day": "2026-02-30", "metric": "steps", "value": 1 }] })
            )
            .contains("not a calendar day")
    );
    assert!(
        world
            .refused(
                "measurement.record",
                json!({ "person_id": "nobody", "days": [{ "day": "2026-03-01", "metric": "steps", "value": 1 }] })
            )
            .contains("no such person")
    );
}

fn workout(external: &str, kind: &str, starts: &str, distance: f64) -> Value {
    json!({
        "external_id": external,
        "device_id": "phone-a",
        "fields": {
            "kind": kind,
            "starts": starts,
            "ends": format!("{}07:45:00Z", &starts[..11]),
            "workout": { "recorded_by": "Watch", "moving_s": 2_700, "distance_m": distance, "heart_bpm": 148 },
        }
    })
}

fn follow_health(world: &World, device: &str, records: &[Value], complete: bool) -> Value {
    let records: Vec<Value> = records
        .iter()
        .map(|record| {
            let mut record = record.clone();
            record["device_id"] = json!(device);
            record
        })
        .collect();
    world.ok(
        "follow.health",
        json!({
            "origin": { "ref": "store:apple-health", "label": "Apple Health", "device_id": device },
            "records": records,
            "complete": complete,
        }),
    )
}

#[test]
fn a_workout_is_an_activity_of_a_workout_kind_with_what_the_store_measured() {
    let world = World::new();
    let run = workout("local:1", "run", "2026-03-04T07:00:00Z", 5_234.5);
    let added = follow_health(&world, "phone-a", std::slice::from_ref(&run), false);
    assert_eq!(added["added"], 1);
    let id = world.line("local:1");
    assert_eq!(
        world
            .text(
                "SELECT a.type_id || ' ' || a.starts || ' ' || e.title FROM activity a
                   JOIN entity e ON e.id = a.id WHERE a.id = ?1",
                &[&id]
            )
            .as_deref(),
        Some("workout_kind:run 2026-03-04T07:00:00.000Z Run")
    );
    assert_eq!(
        world
            .text(
                "SELECT recorded_by || ' ' || moving_s || ' ' || distance_m || ' ' || heart_bpm FROM workout WHERE id = ?1",
                &[&id]
            )
            .as_deref(),
        Some("Watch 2700 5234.5 148")
    );
    // Seen again, unchanged: nothing is written. Changed: only the figure moves.
    let version = world.version(&id);
    assert_eq!(
        follow_health(&world, "phone-a", &[run], false)["unchanged"],
        1
    );
    assert_eq!(world.version(&id), version);
    let longer = workout("local:1", "run", "2026-03-04T07:00:00Z", 5_300.0);
    assert_eq!(
        follow_health(&world, "phone-a", &[longer], false)["updated"],
        1
    );
    assert_eq!(
        world.count("SELECT CAST(distance_m AS INTEGER) FROM workout", &[]),
        5_300
    );
    // A word the vault has not met becomes a kind of its own, once.
    let pilates = workout("local:2", "pilates", "2026-03-05T07:00:00Z", 0.0);
    follow_health(&world, "phone-a", std::slice::from_ref(&pilates), false);
    assert_eq!(
        world
            .text(
                "SELECT title FROM entity WHERE id = 'workout_kind:pilates'",
                &[]
            )
            .as_deref(),
        Some("pilates")
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM concept WHERE kind = 'workout_kind'",
            &[]
        ),
        9
    );
}

#[test]
fn a_workout_gone_from_the_phone_is_kept_and_forgotten_and_a_new_phone_refinds_it() {
    let world = World::new();
    let run = workout("local:1", "run", "2026-03-04T07:00:00Z", 5_000.0);
    let swim = workout("local:2", "swim", "2026-03-05T07:00:00Z", 1_000.0);
    follow_health(&world, "phone-a", &[run.clone(), swim.clone()], false);
    let swim_id = world.line("local:2");
    // A complete read that no longer holds the swim: the row stays, the source goes.
    let read = follow_health(&world, "phone-a", std::slice::from_ref(&run), true);
    assert_eq!(
        (read["forgotten"].as_i64(), read["trashed"].as_i64()),
        (Some(1), Some(0))
    );
    assert_eq!(world.count("SELECT COUNT(*) FROM activity", &[]), 2);
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&swim_id]
        ),
        0
    );
    assert_eq!(
        world.count(
            "SELECT deleted_at IS NULL FROM entity WHERE id = ?1",
            &[&swim_id]
        ),
        1
    );
    // A new phone's ids mean nothing here: the same workout, met under a new id
    // and a start a few seconds off, is the same row, never a second one.
    let moved = workout("local:901", "run", "2026-03-04T07:00:41Z", 5_000.0);
    let met = follow_health(&world, "phone-b", &[moved], false);
    assert_eq!(
        (met["matched"].as_i64(), met["added"].as_i64()),
        (Some(1), Some(0))
    );
    assert_eq!(world.count("SELECT COUNT(*) FROM activity", &[]), 2);
    // The swim the old source forgot is found again by kind and minute too.
    let found = follow_health(
        &world,
        "phone-b",
        &[workout(
            "local:902",
            "swim",
            "2026-03-05T07:00:10Z",
            1_000.0,
        )],
        false,
    );
    assert_eq!(found["matched"], 1);
    assert_eq!(world.count("SELECT COUNT(*) FROM activity", &[]), 2);
    // Deleting one is the shared trash, like any entity.
    world.ok("entity.trash", json!({ "id": swim_id }));
}

#[test]
fn the_words_the_code_reads_are_the_checks_the_file_holds() {
    let world = World::new();
    let ddl = |table: &str| -> String {
        world
            .scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    "SELECT sql FROM sqlite_master WHERE name = ?1",
                    [table],
                    |r| r.get(0),
                )?)
            })
            .expect("a table")
    };
    let words = |sql: &str, column: &str| -> BTreeSet<String> {
        let at = sql.find(&format!("{column} ")).expect("a column");
        let rest = &sql[at..];
        let open = rest.find("IN (").expect("a list") + 4;
        let close = rest[open..].find(')').expect("a close") + open;
        rest[open..close]
            .split(',')
            .map(|word| word.trim().trim_matches('\'').to_owned())
            .collect()
    };
    let set =
        |words: &[&str]| -> BTreeSet<String> { words.iter().map(|w| (*w).to_owned()).collect() };
    assert_eq!(
        words(&ddl("account"), "type"),
        set(&centraid_vault::commands::money::ACCOUNT_TYPES)
    );
    assert_eq!(
        words(&ddl("txn"), "status"),
        set(&centraid_vault::commands::money::TXN_STATUSES)
    );
    assert_eq!(
        words(&ddl("measurement"), "metric"),
        set(&centraid_vault::commands::measurement::METRICS)
    );
    assert_eq!(
        centraid_vault::commands::rule::MATCH_KINDS.len(),
        3,
        "a rule's `match` words are the schema's enum, which the next test reads"
    );
}
