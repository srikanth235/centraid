//! #1146 wave 6: an account's opening balance is as of a day (D9), and a rule can
//! rename a payee without touching the bank's words.

mod common;

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

    fn import(&self, account: &str, lines: &[(&str, &str, i64, &str)]) {
        let records: Vec<Value> = lines
            .iter()
            .map(|(external, day, amount, words)| {
                json!({
                    "external_id": external,
                    "fields": { "title": words, "posted_on": day, "amount_minor": amount,
                                "line": { "memo": "m", "imported_from": "csv" } }
                })
            })
            .collect();
        self.ok(
            "follow.statement",
            json!({
                "origin": { "ref": account, "label": "Everyday", "fills": account },
                "records": records,
            }),
        );
    }

    fn line(&self, external: &str) -> String {
        self.text(
            "SELECT entity_id FROM source WHERE external_id = ?1",
            &[external],
        )
        .expect("a followed line")
    }
}

#[test]
fn an_opening_balance_is_as_of_a_day_set_at_create_and_at_edit() {
    let world = World::new();
    let account = world.ok(
        "account.add",
        json!({ "title": "Everyday", "type": "checking", "currency": "USD",
                "opening_minor": 120_000, "opening_on": "2026-01-01" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(
        world
            .text("SELECT opening_on FROM account WHERE id = ?1", &[&account])
            .as_deref(),
        Some("2026-01-01")
    );
    world.ok(
        "account.set_opening",
        json!({ "id": account, "opening_minor": 5_000, "opening_on": "2026-02-01" }),
    );
    assert_eq!(
        world
            .text("SELECT opening_on FROM account WHERE id = ?1", &[&account])
            .as_deref(),
        Some("2026-02-01")
    );
    assert!(
        world
            .refused(
                "account.set_opening",
                json!({ "id": account, "opening_minor": 1, "opening_on": "2026-02-30" })
            )
            .contains("real date")
    );
    // An opening balance with no day cannot say which lines it already holds.
    assert!(
        world
            .refused(
                "account.add",
                json!({ "title": "Other", "type": "cash", "opening_minor": 5 })
            )
            .contains("needs the day")
    );
}

#[test]
fn a_rule_renames_the_line_and_never_the_banks_words() {
    let world = World::new();
    let account = world.ok(
        "account.add",
        json!({ "title": "Everyday", "type": "checking", "currency": "USD" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    world.import(
        &account,
        &[
            ("csv:a", "2026-03-02", -4_250, "WHOLE FOODS MKT 123"),
            ("csv:b", "2026-03-03", -900, "WHOLE FOODS MKT 456"),
            ("csv:c", "2026-03-04", -450, "BLUE COFFEE CO"),
        ],
    );
    // The member already named one of the two lines.
    world.ok(
        "entity.retitle",
        json!({ "id": world.line("csv:b"), "title": "Corner shop" }),
    );
    world.ok(
        "rule.add",
        json!({ "match": "contains", "text": "whole foods", "category_id": "category:food.groceries",
                "display_name": "Whole Foods" }),
    );
    let applied = world.ok("rule.apply", json!({}));
    assert_eq!(applied["renamed"], 1, "only the line the bank named");
    let title = |external: &str| {
        world
            .text(
                "SELECT title FROM entity WHERE id = ?1",
                &[&world.line(external)],
            )
            .expect("a title")
    };
    assert_eq!(title("csv:a"), "Whole Foods");
    assert_eq!(title("csv:b"), "Corner shop", "the member's own name stays");
    assert_eq!(title("csv:c"), "BLUE COFFEE CO");
    let stated = world
        .text(
            "SELECT json_extract(stated, '$.title') FROM source WHERE external_id = 'csv:a'",
            &[],
        )
        .expect("the bank's words");
    assert_eq!(stated, "WHOLE FOODS MKT 123");
    // A rule applied again changes nothing; `overwrite` takes the member's name too.
    assert_eq!(world.ok("rule.apply", json!({}))["renamed"], 0);
    assert_eq!(
        world.ok("rule.apply", json!({ "overwrite": true }))["renamed"],
        1
    );
    assert_eq!(title("csv:b"), "Whole Foods");
    // A name is not blank.
    assert!(
        world
            .refused(
                "rule.add",
                json!({ "match": "is", "text": "x", "category_id": "category:fees", "display_name": "  " })
            )
            .contains("name")
    );
}

#[test]
fn a_line_imported_after_the_rule_takes_the_payee_and_a_reimport_keeps_a_later_name() {
    let world = World::new();
    let account = world.ok(
        "account.add",
        json!({ "title": "Everyday", "type": "checking", "currency": "USD" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    world.ok(
        "rule.add",
        json!({ "match": "contains", "text": "whole foods", "category_id": "category:food.groceries",
                "display_name": "Whole Foods" }),
    );
    let lines = [("csv:a", "2026-03-02", -4_250, "WHOLE FOODS MKT 123")];
    world.import(&account, &lines);
    let id = world.line("csv:a");
    let title = || {
        world
            .text("SELECT title FROM entity WHERE id = ?1", &[&id])
            .expect("a title")
    };
    assert_eq!(title(), "Whole Foods");
    assert_eq!(
        world
            .text(
                "SELECT json_extract(stated, '$.title') FROM source WHERE external_id = 'csv:a'",
                &[]
            )
            .as_deref(),
        Some("WHOLE FOODS MKT 123")
    );
    world.ok("entity.retitle", json!({ "id": id, "title": "Groceries" }));
    world.import(&account, &lines);
    assert_eq!(title(), "Groceries", "a re-import does not rename");
}
