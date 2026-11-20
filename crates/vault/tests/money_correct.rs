//! The member corrects what an import read wrongly on a line (`txn.correct`): the amount and
//! the day, kept as earlier versions, kept through a re-import, and never in another currency.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::history;
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

    fn held(&self, id: &str) -> String {
        self.text(
            "SELECT posted_on || ' ' || amount_minor || ' ' || currency FROM txn WHERE id = ?1",
            &[id],
        )
        .expect("a line")
    }
}

fn account(world: &World, title: &str, currency: &str) -> String {
    world.ok(
        "account.add",
        json!({ "title": title, "type": "checking", "currency": currency }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

#[test]
fn a_correction_changes_the_amount_and_the_day_and_a_reimport_keeps_it() {
    let world = World::new();
    let id = account(&world, "Everyday", "USD");
    let lines = [("c:1", "2026-03-02", -4250, "GROCER")];
    world.import(&id, &lines);
    let line = world.line("c:1");
    let out = world.ok(
        "txn.correct",
        json!({ "id": line, "amount_minor": -4520, "posted_on": "2026-03-03" }),
    );
    assert_eq!(out["changed"], true);
    assert_eq!(out["replaced"]["amount_minor"], -4250);
    assert_eq!(world.held(&line), "2026-03-03 -4520 USD");
    // The same correction again writes nothing.
    assert_eq!(
        world.ok("txn.correct", json!({ "id": line, "amount_minor": -4520 }))["changed"],
        false
    );
    // A later statement saying the bank's old words does not undo it, and adds nothing.
    world.import(&id, &lines);
    assert_eq!(world.held(&line), "2026-03-03 -4520 USD");
    // Taking the act back is correcting to what it held.
    world.ok(
        "txn.correct",
        json!({ "id": line, "amount_minor": -4250, "posted_on": "2026-03-02" }),
    );
    assert_eq!(world.held(&line), "2026-03-02 -4250 USD");
}

#[test]
fn a_correction_is_an_earlier_version_and_restores() {
    let world = World::new();
    let id = account(&world, "Everyday", "INR");
    world.import(&id, &[("c:1", "2026-03-02", -4250, "GROCER")]);
    let line = world.line("c:1");
    world.ok("txn.correct", json!({ "id": line, "amount_minor": -9900 }));
    let versions = world
        .scratch
        .vault
        .read(|c| history::earlier_versions(c, &line, None, 10))
        .expect("versions")
        .versions;
    assert_eq!(versions.len(), 1);
    assert!(
        versions[0]
            .changes
            .iter()
            .any(|change| change.field.ends_with("amount_minor")),
        "{:?}",
        versions[0].changes
    );
    world.ok("history.undo", json!({ "id": line }));
    assert_eq!(world.held(&line), "2026-03-02 -4250 INR");
}

#[test]
fn a_correction_is_refused_when_it_is_unsound() {
    let world = World::new();
    let one = account(&world, "Everyday", "USD");
    let two = account(&world, "Savings", "USD");
    world.import(&one, &[("c:1", "2026-03-02", -5000, "MOVE")]);
    let out = world.line("c:1");
    world.import(&two, &[("c:2", "2026-03-02", 5000, "MOVE")]);
    let into = world.line("c:2");
    assert!(
        world
            .refused(
                "txn.correct",
                json!({ "id": out, "posted_on": "2026-02-30" })
            )
            .contains("real date")
    );
    assert!(
        world
            .refused("txn.correct", json!({ "id": out, "currency": "EUR" }))
            .contains("currency, USD")
    );
    assert!(
        world
            .refused("txn.correct", json!({ "id": out, "currency": "U$D" }))
            .contains("three-letter")
    );
    assert!(
        world
            .refused("txn.correct", json!({ "id": out }))
            .contains("what to correct")
    );
    // The same currency, spelled in lower case, is the account's and changes nothing.
    assert_eq!(
        world.ok("txn.correct", json!({ "id": out, "currency": "usd" }))["changed"],
        false
    );
    world.ok("txn.link_transfer", json!({ "id": out, "other_id": into }));
    assert!(
        world
            .refused("txn.correct", json!({ "id": out, "amount_minor": 5000 }))
            .contains("money out and the other money in")
    );
    // The size of a transfer's side may be corrected while it stays one way.
    world.ok("txn.correct", json!({ "id": out, "amount_minor": -5100 }));
    world.ok("txn.void", json!({ "id": into }));
    assert!(
        world
            .refused("txn.correct", json!({ "id": into, "amount_minor": 1 }))
            .contains("removed")
    );
    assert_eq!(world.held(&out), "2026-03-02 -5100 USD");
}

#[test]
fn an_account_changes_currency_only_while_it_has_no_transactions() {
    let world = World::new();
    let id = account(&world, "Everyday", "USD");
    world.ok("account.edit", json!({ "id": id, "currency": "eur" }));
    assert_eq!(
        world
            .text("SELECT currency FROM account WHERE id = ?1", &[&id])
            .as_deref(),
        Some("EUR")
    );
    assert!(
        world
            .refused("account.edit", json!({ "id": id, "currency": "EU1" }))
            .contains("three-letter")
    );
    world.import(&id, &[("c:1", "2026-03-02", -4250, "GROCER")]);
    assert!(
        world
            .refused("account.edit", json!({ "id": id, "currency": "USD" }))
            .contains("keeps its currency")
    );
    // Saying the currency it already has is no change.
    world.ok("account.edit", json!({ "id": id, "currency": "EUR" }));
}

#[test]
fn a_currency_is_three_letters_wherever_money_names_one() {
    let world = World::new();
    for bad in ["U$D", "1ND", "U D"] {
        assert!(
            world
                .refused(
                    "account.add",
                    json!({ "title": "Bad", "type": "cash", "currency": bad })
                )
                .contains("three-letter"),
            "{bad}"
        );
    }
    let food = world.ok("category.add", json!({ "title": "Zebra food" }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert!(
        world
            .refused(
                "budget.set",
                json!({ "month": "2026-03", "category_id": food, "amount_minor": 100, "currency": "12A" })
            )
            .contains("three-letter")
    );
    world.ok(
        "budget.set",
        json!({ "month": "2026-03", "category_id": food, "amount_minor": 100, "currency": "inr" }),
    );
    assert_eq!(
        world
            .text(
                "SELECT currency FROM budget WHERE category_id = ?1",
                &[&food]
            )
            .as_deref(),
        Some("INR")
    );
}
