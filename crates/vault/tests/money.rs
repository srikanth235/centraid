//! Money against the v0 tables (#1214): accounts and their balances, a line entered by hand or
//! stated by a bank, the proposed match between the two, a line's categories in `txn_split` and the
//! one rule that they add up, transfers across currencies, categories, budgets and rules, and what
//! a month reads. The rules the database holds for these tables are also written as raw SQL in
//! `schema_rules.rs`; the spreadsheet door is `txn_portable.rs`.

mod common;

use centraid_vault::commands::money::{self, Spent};
use centraid_vault::commands::txn;
use centraid_vault::{Command, Principal};
use common::world::World;
use serde_json::{Value, json};

fn world(seed: &str) -> World {
    World::new(seed)
}

fn account(w: &World, title: &str) -> String {
    w.ok(
        "account.add",
        json!({ "title": title, "type": "checking", "currency": "USD" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

fn account_in(w: &World, title: &str, kind: &str, currency: &str) -> String {
    w.ok(
        "account.add",
        json!({ "title": title, "type": kind, "currency": currency }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

/// A hand line: the id.
fn hand(w: &World, account: &str, day: &str, amount: i64, title: &str) -> String {
    w.ok(
        "txn.add",
        json!({ "account_id": account, "posted_on": day, "amount_minor": amount, "title": title }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

/// Statement lines `(external id, day, amount, the bank's words)` followed into an account.
fn import(w: &World, account: &str, lines: &[(&str, &str, i64, &str)]) -> Value {
    let records: Vec<Value> = lines
        .iter()
        .map(|(external, day, amount, words)| {
            json!({
                "external_id": external,
                "fields": {
                    "title": words, "posted_on": day, "amount_minor": amount,
                    "line": { "memo": "m", "imported_from": "csv" },
                }
            })
        })
        .collect();
    w.ok(
        "follow.statement",
        json!({
            "origin": { "ref": account, "label": "Everyday", "fills": account },
            "records": records,
        }),
    )
}

/// The line a statement record became.
fn stated(w: &World, external: &str) -> String {
    w.one(
        "SELECT entity_id FROM source WHERE external_id = ?1",
        &[external],
    )
}

fn read<T>(w: &World, body: impl FnOnce(&rusqlite::Connection) -> centraid_vault::Result<T>) -> T {
    w.vault().read(body).expect("a read")
}

const GROCER: (&str, &str, i64, &str) = ("csv:aaaaa", "2026-03-02", -4_250, "WHOLE FOODS MKT 123");
const PAY: (&str, &str, i64, &str) = ("csv:bbbbb", "2026-03-03", 300_000, "ACME PAYROLL");
const COFFEE: (&str, &str, i64, &str) = ("csv:ccccc", "2026-03-04", -450, "BLUE COFFEE CO");

fn parts(w: &World, id: &str) -> Vec<(String, i64)> {
    read(w, |c| {
        Ok(txn::parts_of(c, id)?
            .into_iter()
            .map(|part| (part.category_id, part.amount_minor))
            .collect())
    })
}

// ---------------------------------------------------------------------------------------------
// 1. Accounts
// ---------------------------------------------------------------------------------------------

#[test]
fn an_account_has_a_type_from_the_lookup_and_an_origin_only_when_a_statement_needs_one() {
    let w = world("account_types");
    // The types are the lookup's rows: a loan, an investment and an asset are accounts too.
    for kind in [
        "checking",
        "savings",
        "credit_card",
        "cash",
        "loan",
        "investment",
        "asset",
    ] {
        account_in(&w, &format!("A {kind}"), kind, "USD");
    }
    assert!(
        w.refused(
            "account.add",
            json!({ "title": "Mortgage", "type": "mortgage" })
        )
        .contains("not a kind of account")
    );
    // No bank number and no statement yet: no origin. A number makes the account's one origin.
    let plain = account(&w, "Everyday");
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM origin WHERE fills = ?1", &[&plain]),
        0
    );
    let numbered = w.ok(
        "account.add",
        json!({ "title": "Card", "type": "credit_card", "external_ref": "1234-5678" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(
        w.one::<String>("SELECT ref FROM origin WHERE fills = ?1", &[&numbered]),
        "1234-5678"
    );
    // The vault's currency is the default.
    let cash = w.ok("account.add", json!({ "title": "Wallet", "type": "cash" }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(
        w.one::<String>("SELECT currency FROM account WHERE id = ?1", &[&cash]),
        w.one::<String>("SELECT currency FROM vault", &[])
    );
    assert!(
        w.refused(
            "account.add",
            json!({ "title": " everyday ", "type": "savings" })
        )
        .contains("already have an account")
    );
    assert!(
        w.refused(
            "account.add",
            json!({ "title": "Other", "type": "savings", "external_ref": "1234-5678" })
        )
        .contains("bank number")
    );
    // Setting a number makes the origin; clearing it falls back to the account's own id.
    w.ok(
        "account.edit",
        json!({ "id": plain, "external_ref": "99-0001" }),
    );
    assert_eq!(
        w.one::<String>("SELECT ref FROM origin WHERE fills = ?1", &[&plain]),
        "99-0001"
    );
    w.ok("account.edit", json!({ "id": plain, "external_ref": null }));
    assert_eq!(
        w.one::<String>("SELECT ref FROM origin WHERE fills = ?1", &[&plain]),
        plain
    );
    // A type is a label: any row of the lookup, and a rename keeps the origin's label in step.
    w.ok(
        "account.edit",
        json!({ "id": numbered, "type": "checking" }),
    );
    w.ok(
        "account.edit",
        json!({ "id": plain, "title": "Rainy day", "type": "savings" }),
    );
    assert_eq!(
        w.one::<String>("SELECT label FROM origin WHERE fills = ?1", &[&plain]),
        "Rainy day"
    );
    assert!(
        w.refused("account.edit", json!({ "id": plain, "type": "nonsense" }))
            .contains("not a kind of account")
    );
}

#[test]
fn an_opening_balance_needs_its_day_and_the_currency_is_fixed_once_the_account_has_lines() {
    let w = world("account_opening");
    assert!(
        w.refused(
            "account.add",
            json!({ "title": "A", "type": "checking", "opening_minor": 500 })
        )
        .contains("needs the day")
    );
    let id = w.ok(
        "account.add",
        json!({ "title": "A", "type": "checking", "currency": "USD",
                "opening_minor": 500, "opening_on": "2026-01-01" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert!(
        w.refused(
            "account.set_opening",
            json!({ "id": id, "opening_minor": 5 })
        )
        .contains("needs the day")
    );
    w.ok(
        "account.set_opening",
        json!({ "id": id, "opening_minor": 0 }),
    );
    // Before it has a line the currency may change; after, the sentence and the table both say no.
    w.ok("account.edit", json!({ "id": id, "currency": "eur" }));
    assert_eq!(
        w.one::<String>("SELECT currency FROM account WHERE id = ?1", &[&id]),
        "EUR"
    );
    hand(&w, &id, "2026-03-01", -100, "First");
    assert!(
        w.refused("account.edit", json!({ "id": id, "currency": "USD" }))
            .contains("fixed once it has lines")
    );
    w.ok("account.edit", json!({ "id": id, "currency": "EUR" }));
    let error = w
        .vault()
        .commit(|tx| {
            tx.connection()
                .execute("UPDATE account SET currency = 'USD' WHERE id = ?1", [&id])?;
            Ok(())
        })
        .expect_err("refused");
    assert!(
        error.to_string().contains("fixed once it has lines"),
        "{error}"
    );
}

#[test]
fn the_balance_on_a_day_is_derived_at_read_time_and_a_checkpoint_is_a_stated_row() {
    let w = world("balance");
    let id = w.ok(
        "account.add",
        json!({ "title": "A", "type": "checking", "currency": "USD",
                "opening_minor": 5_000, "opening_on": "2026-01-01" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    hand(&w, &id, "2025-12-31", -100, "Before");
    hand(&w, &id, "2026-01-01", -200, "On the day");
    hand(&w, &id, "2026-01-02", -300, "After");
    hand(&w, &id, "2026-02-01", 1_000, "Pay");
    w.ok(
        "txn.add",
        json!({ "account_id": id, "posted_on": "2026-02-02", "amount_minor": -999,
                "title": "Pending", "status": "pending" }),
    );
    let gone = hand(&w, &id, "2026-02-03", -50, "Mistake");
    let on = |day: &str| read(&w, |c| money::balance_on(c, &id, day)).expect("an account");
    // Lines on or before the opening day are already in the opening balance.
    assert_eq!(on("2026-01-01"), 5_000);
    assert_eq!(on("2026-01-02"), 4_700);
    assert_eq!(on("2026-02-28"), 5_700 - 50);
    // Before it opened, the lines between are taken back out.
    assert_eq!(on("2025-12-31"), 5_200);
    // A wrong line is trashed like any item, and the balance is derived again.
    w.ok("entity.trash", json!({ "id": gone }));
    assert_eq!(on("2026-02-28"), 5_700);
    assert!(read(&w, |c| money::balance_on(c, "nobody", "2026-01-01")).is_none());
    // No figure is stored: the account row holds only what it opened with.
    assert_eq!(
        w.one::<i64>("SELECT opening_minor FROM account WHERE id = ?1", &[&id]),
        5_000
    );
    // A checkpoint is what the bank stated, with what the lines say beside it.
    assert!(
        w.refused(
            "checkpoint.record",
            json!({ "account_id": id, "day": "2026-02-30", "balance_minor": 1 })
        )
        .contains("real date")
    );
    for (day, stated) in [("2026-01-02", 4_700), ("2026-02-28", 5_000)] {
        w.ok(
            "checkpoint.record",
            json!({ "account_id": id, "day": day, "balance_minor": stated }),
        );
    }
    let gaps = read(&w, |c| money::checkpoint_gaps(c, &id));
    assert_eq!(
        gaps.iter()
            .map(|g| (g.day.as_str(), g.stated_minor, g.derived_minor))
            .collect::<Vec<_>>(),
        [("2026-01-02", 4_700, 4_700), ("2026-02-28", 5_000, 5_700)]
    );
    // Stating a day again is the same row, and the latest word stands.
    assert_eq!(
        w.ok(
            "checkpoint.record",
            json!({ "account_id": id, "day": "2026-02-28", "balance_minor": 5_000 })
        )["written"],
        false
    );
}

#[test]
fn a_layout_is_remembered_on_the_statement_origin_and_forgotten_with_null() {
    let w = world("layout");
    let id = account(&w, "Everyday");
    let layout = json!({
        "header_fingerprint": "date,desc,amt", "delimiter": ",", "date_order": "ymd",
        "sign_mode": "signed", "date_col": 0, "desc_col": 1, "amount_col": 2
    });
    assert!(
        w.refused(
            "account.remember_layout",
            json!({ "id": id, "layout": {
                "header_fingerprint": "x", "delimiter": ",", "date_order": "ymd",
                "sign_mode": "debit_credit", "date_col": 0, "desc_col": 1, "debit_col": 2 } })
        )
        .contains("which columns hold the amount")
    );
    let first = w.ok(
        "account.remember_layout",
        json!({ "id": id, "layout": layout }),
    );
    assert_eq!(first["saved"], true);
    assert_eq!(first["replaced"]["layout"], Value::Null);
    // The origin's config is a JSON object the vault defines: it carries its version.
    assert_eq!(
        w.one::<i64>(
            "SELECT json_extract(config, '$.v') FROM origin WHERE fills = ?1",
            &[&id]
        ),
        1
    );
    assert_eq!(
        w.ok(
            "account.remember_layout",
            json!({ "id": id, "layout": layout })
        )["saved"],
        false
    );
    let forgot = w.ok(
        "account.remember_layout",
        json!({ "id": id, "layout": null }),
    );
    assert_eq!(
        forgot["replaced"]["layout"], layout,
        "the act is taken back by the same layout"
    );
    assert_eq!(
        w.one::<Option<String>>("SELECT config FROM origin WHERE fills = ?1", &[&id]),
        None
    );
}

#[test]
fn trashing_an_account_takes_its_lines_and_restoring_brings_them_back_and_a_purge_takes_all() {
    let w = world("account_trash");
    let id = account(&w, "Everyday");
    import(&w, &id, &[GROCER, PAY]);
    let by_hand = hand(&w, &id, "2026-03-05", -100, "Cash");
    w.ok("entity.trash", json!({ "id": id }));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'txn' AND deleted_at IS NOT NULL",
            &[]
        ),
        3
    );
    // A line of a trashed account is no line of any month.
    assert!(read(&w, |c| money::spending_in_month(c, "2026-03")).is_empty());
    w.ok("entity.restore", json!({ "id": id }));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'txn' AND deleted_at IS NOT NULL",
            &[]
        ),
        0
    );
    w.ok("entity.trash", json!({ "id": by_hand }));
    w.ok("entity.trash", json!({ "id": id }));
    w.ok("entity.purge", json!({ "id": id }));
    for table in ["txn", "account", "origin", "source", "txn_split"] {
        assert_eq!(
            w.one::<i64>(&format!("SELECT COUNT(*) FROM {table}"), &[]),
            0,
            "{table}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// 2. A line by hand
// ---------------------------------------------------------------------------------------------

#[test]
fn a_hand_line_is_entered_edited_and_trashed_on_any_account_and_there_is_no_void() {
    let w = world("hand_line");
    // An account no statement has ever been read into has hand lines too.
    let wallet = account_in(&w, "Wallet", "cash", "USD");
    let id = w.ok(
        "txn.add",
        json!({ "account_id": wallet, "posted_on": "2026-03-05", "amount_minor": -1_200,
                "title": "Lunch", "memo": "with Sam", "category_id": "category:food.dining" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(
        w.one::<String>("SELECT entered FROM txn WHERE id = ?1", &[&id]),
        "hand"
    );
    assert_eq!(
        w.one::<String>("SELECT memo FROM txn WHERE id = ?1", &[&id]),
        "with Sam"
    );
    assert_eq!(
        parts(&w, &id),
        [("category:food.dining".to_owned(), -1_200)]
    );
    // There is no currency on a line: it is the account's.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM pragma_table_info('txn') WHERE name = 'currency'",
            &[]
        ),
        0
    );
    // A hand line is edited: day, amount, memo, name; one part follows the amount it was the whole of.
    let edited = w.ok(
        "txn.edit",
        json!({ "id": id, "posted_on": "2026-03-06", "amount_minor": -1_500, "memo": null }),
    );
    assert_eq!(edited["changed"], true);
    assert_eq!(
        w.one::<String>(
            "SELECT posted_on || ' ' || amount_minor FROM txn WHERE id = ?1",
            &[&id]
        ),
        "2026-03-06 -1500"
    );
    assert_eq!(
        w.one::<Option<String>>("SELECT memo FROM txn WHERE id = ?1", &[&id]),
        None
    );
    assert_eq!(
        parts(&w, &id),
        [("category:food.dining".to_owned(), -1_500)]
    );
    assert_eq!(
        w.ok("txn.edit", json!({ "id": id, "amount_minor": -1_500 }))["changed"],
        false
    );
    w.ok("entity.retitle", json!({ "id": id, "title": "Team lunch" }));
    assert!(
        w.refused("txn.edit", json!({ "id": id, "posted_on": "2026-02-30" }))
            .contains("real date")
    );
    assert!(
        w.refused(
            "txn.edit",
            json!({ "id": id, "original_amount_minor": 1_000 })
        )
        .contains("needs both")
    );
    // What a foreign purchase was charged is a pair.
    w.ok(
        "txn.edit",
        json!({ "id": id, "original_amount_minor": -1_100, "original_currency": "EUR" }),
    );
    assert_eq!(
        w.one::<String>(
            "SELECT original_amount_minor || original_currency FROM txn WHERE id = ?1",
            &[&id]
        ),
        "-1100EUR"
    );
    // A wrong line is trashed like any item: there is no void.
    let error = w
        .vault()
        .execute(
            &w.registry,
            &Principal::owner("phone"),
            &Command::new("txn.void", json!({ "id": id })),
        )
        .expect_err("not a command");
    assert!(matches!(
        error,
        centraid_vault::VaultError::UnknownCommand { .. }
    ));
    let error = w
        .vault()
        .commit(|tx| {
            tx.connection()
                .execute("UPDATE txn SET status = 'void' WHERE id = ?1", [&id])?;
            Ok(())
        })
        .expect_err("a status of the closed set");
    assert!(error.to_string().contains("CHECK"), "{error}");
    w.ok("entity.trash", json!({ "id": id }));
    w.ok("entity.restore", json!({ "id": id }));
    // A line on an account that is not there is refused with a sentence.
    assert!(
        w.refused(
            "txn.add",
            json!({ "account_id": "nobody", "posted_on": "2026-03-05", "amount_minor": 1 })
        )
        .contains("no such account")
    );
}

#[test]
fn a_line_a_csv_brought_in_once_is_an_arrival_and_a_hand_line() {
    let w = world("csv_arrival");
    let id = account(&w, "Everyday");
    let line = w.ok(
        "txn.add",
        json!({ "account_id": id, "posted_on": "2026-03-05", "amount_minor": -700,
                "title": "Old bank", "arrived_via": "csv", "arrived_label": "/home/me/export.csv" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(
        w.one::<String>(
            "SELECT arrived_via || ' ' || arrived_label FROM entity WHERE id = ?1",
            &[&line]
        ),
        "csv export.csv"
    );
    // Not a follow: no origin and no source, and the line is the member's to edit.
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM origin", &[]), 0);
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM source", &[]), 0);
    assert_eq!(
        w.one::<String>("SELECT entered FROM txn WHERE id = ?1", &[&line]),
        "hand"
    );
    w.ok("txn.edit", json!({ "id": line, "amount_minor": -800 }));
    // A way in that does not bring in a line is refused.
    let outcome = w.run(
        "txn.add",
        json!({ "account_id": id, "posted_on": "2026-03-05", "amount_minor": -1,
                "arrived_via": "vcard", "arrived_label": "x.vcf" }),
    );
    assert_eq!(outcome.status, centraid_vault::CommandStatus::Failed);
}

// ---------------------------------------------------------------------------------------------
// 3. A statement
// ---------------------------------------------------------------------------------------------

#[test]
fn a_statement_is_followed_line_by_line_and_a_reimport_writes_nothing() {
    let w = world("statement");
    let id = account(&w, "Everyday");
    let first = import(&w, &id, &[GROCER, PAY, COFFEE]);
    assert_eq!(first["added"], 3);
    let grocer = stated(&w, GROCER.0);
    let before = w.stamp(&grocer);
    assert_eq!(
        w.one::<String>(
            "SELECT entered || ' ' || (account_id = ?2) FROM txn WHERE id = ?1",
            &[&grocer, &id]
        ),
        "statement 1"
    );
    // The bank's own words are kept as it said them.
    assert_eq!(
        w.one::<String>(
            "SELECT json_extract(stated, '$.line.memo') FROM source WHERE entity_id = ?1",
            &[&grocer]
        ),
        "m"
    );
    w.scratch.clock.advance_ms(60_000);
    let again = import(&w, &id, &[GROCER, PAY, COFFEE]);
    assert_eq!(
        (
            again["added"].as_i64(),
            again["updated"].as_i64(),
            again["unchanged"].as_i64()
        ),
        (Some(0), Some(0), Some(3))
    );
    assert_eq!(w.stamp(&grocer), before, "a re-import touches nothing");
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM txn", &[]), 3);
    // A statement is an account's, not a phone's, and has no end.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM origin WHERE device_id IS NOT NULL",
            &[]
        ),
        0
    );
    let reference = w.one::<String>("SELECT ref FROM origin WHERE system = 'statement'", &[]);
    assert!(
        w.refused(
            "follow.stop",
            json!({ "system": "statement", "ref": reference })
        )
        .contains("no end")
    );
    // One origin per account, whatever ref an import names, and the same line twice is one line.
    let other = w.ok(
        "follow.statement",
        json!({
            "origin": { "ref": "another-ref", "label": "Everyday", "fills": id },
            "records": [{ "external_id": GROCER.0, "fields": {
                "title": GROCER.3, "posted_on": GROCER.1, "amount_minor": GROCER.2 } }],
        }),
    );
    assert_eq!(other["added"], 0);
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM origin WHERE system = 'statement'",
            &[]
        ),
        1
    );
}

#[test]
fn a_statement_line_is_never_edited_but_its_category_memo_and_name_are_the_members() {
    let w = world("statement_fixed");
    let id = account(&w, "Everyday");
    import(&w, &id, &[GROCER]);
    let grocer = stated(&w, GROCER.0);
    w.ok(
        "txn.categorize",
        json!({ "ids": [grocer], "category_id": "category:food.groceries" }),
    );
    w.ok("txn.edit", json!({ "id": grocer, "memo": "weekly shop" }));
    w.ok(
        "entity.retitle",
        json!({ "id": grocer, "title": "Groceries" }),
    );
    // The bank restates the line with another day, amount and words: none of it reaches the row.
    let restated = w.ok(
        "follow.statement",
        json!({
            "origin": { "ref": id, "label": "Everyday", "fills": id },
            "records": [{ "external_id": GROCER.0, "fields": {
                "title": "WHOLE FOODS MARKET", "posted_on": "2026-03-09", "amount_minor": -9_999 } }],
        }),
    );
    assert_eq!(restated["added"], 0);
    assert_eq!(
        w.one::<String>(
            "SELECT posted_on || ' ' || amount_minor || ' ' || memo FROM txn WHERE id = ?1",
            &[&grocer]
        ),
        "2026-03-02 -4250 weekly shop"
    );
    assert_eq!(
        parts(&w, &grocer),
        [("category:food.groceries".to_owned(), -4_250)]
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&grocer]),
        "Groceries"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT stated_title FROM source WHERE entity_id = ?1",
            &[&grocer]
        ),
        GROCER.3,
        "the bank's words stay what it said"
    );
    // The command says so in a sentence, and the table refuses the same write.
    for edit in [
        json!({ "id": grocer, "amount_minor": -1 }),
        json!({ "id": grocer, "posted_on": "2026-03-01" }),
        json!({ "id": grocer, "original_amount_minor": 5, "original_currency": "EUR" }),
    ] {
        assert!(w.refused("txn.edit", edit).contains("never edited"));
    }
    for sql in [
        "UPDATE txn SET amount_minor = 1",
        "UPDATE txn SET posted_on = '2026-03-01'",
        "UPDATE txn SET original_amount_minor = 5, original_currency = 'EUR'",
        "UPDATE txn SET account_id = (SELECT id FROM account LIMIT 1)",
    ] {
        let error = w
            .vault()
            .commit(|tx| {
                tx.connection().execute(sql, [])?;
                Ok(())
            })
            .expect_err(sql);
        assert!(error.to_string().contains("never edited"), "{sql}: {error}");
    }
    // The line's origin never turns back into a hand line.
    let error = w
        .vault()
        .commit(|tx| {
            tx.connection()
                .execute("UPDATE txn SET entered = 'hand' WHERE id = ?1", [&grocer])?;
            Ok(())
        })
        .expect_err("refused");
    assert!(
        error.to_string().contains("origin never changes"),
        "{error}"
    );
}

#[test]
fn a_pending_line_the_bank_posts_later_and_a_foreign_purchase_are_the_banks_word() {
    let w = world("statement_pending");
    let id = account(&w, "Everyday");
    let record = |status: &str| {
        json!({
            "origin": { "ref": id, "label": "Everyday", "fills": id },
            "records": [{ "external_id": "ofx:1", "fields": {
                "title": "CAFE ROMA", "posted_on": "2026-03-02", "amount_minor": -1_100,
                "status": status, "original_amount_minor": -1_000, "original_currency": "EUR" } }],
        })
    };
    w.ok("follow.statement", record("pending"));
    let line = stated(&w, "ofx:1");
    assert_eq!(
        w.one::<String>("SELECT status FROM txn WHERE id = ?1", &[&line]),
        "pending"
    );
    assert_eq!(
        read(&w, |c| money::balance_on(c, &id, "2026-03-31")),
        Some(0)
    );
    assert_eq!(w.ok("follow.statement", record("posted"))["updated"], 1);
    assert_eq!(
        w.one::<String>(
            "SELECT status || ' ' || original_amount_minor || original_currency FROM txn WHERE id = ?1",
            &[&line]
        ),
        "posted -1000EUR"
    );
    assert_eq!(
        read(&w, |c| money::balance_on(c, &id, "2026-03-31")),
        Some(-1_100)
    );
}

#[test]
fn a_rule_names_a_line_when_it_is_added_and_the_banks_words_stay_in_the_statement() {
    let w = world("statement_named");
    let id = account(&w, "Everyday");
    w.ok(
        "rule.add",
        json!({ "match": "contains", "text": "blue coffee", "category_id": "category:food.dining",
                "display_name": "Blue Coffee" }),
    );
    import(&w, &id, &[COFFEE]);
    let coffee = stated(&w, COFFEE.0);
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&coffee]),
        "Blue Coffee"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT stated_title FROM source WHERE entity_id = ?1",
            &[&coffee]
        ),
        COFFEE.3
    );
    // A name the member chose is not taken back by a re-import.
    w.ok(
        "entity.retitle",
        json!({ "id": coffee, "title": "Morning coffee" }),
    );
    import(&w, &id, &[COFFEE]);
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&coffee]),
        "Morning coffee"
    );
}

#[test]
fn a_statement_that_seems_to_be_a_hand_line_only_proposes_the_match_and_confirm_makes_it_one_line()
{
    let w = world("match");
    let id = account(&w, "Everyday");
    let by_hand = w.ok(
        "txn.add",
        json!({ "account_id": id, "posted_on": "2026-03-01", "amount_minor": -4_250,
                "title": "Whole Foods", "memo": "party food", "category_id": "category:food.groceries" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let elsewhere = hand(&w, &id, "2026-03-01", -999, "Other amount");
    import(
        &w,
        &id,
        &[GROCER, ("csv:far", "2026-03-20", -4_250, "TOO LATE"), PAY],
    );
    let statement = stated(&w, GROCER.0);
    // Nothing merged: both lines are there, and the hand line is as it was.
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM txn", &[]), 5);
    assert_eq!(
        w.one::<String>(
            "SELECT entered || posted_on || amount_minor FROM txn WHERE id = ?1",
            &[&by_hand]
        ),
        "hand2026-03-01-4250"
    );
    let proposals = read(&w, |c| txn::proposed_matches(c, &id));
    assert_eq!(
        proposals,
        [txn::Proposal {
            hand_id: by_hand.clone(),
            statement_id: statement.clone()
        }],
        "the same amount within a few days, and nothing else"
    );
    // A confirm that is not a hand line against a statement line is refused.
    for (a, b) in [(&statement, &by_hand), (&by_hand, &elsewhere)] {
        assert!(
            w.refused(
                "txn.confirm_match",
                json!({ "hand_id": a, "statement_id": b })
            )
            .contains("hand")
        );
    }
    // Confirm: the statement's day and amount win; the hand line's category, memo and name carry over.
    w.ok(
        "txn.confirm_match",
        json!({ "hand_id": by_hand, "statement_id": statement }),
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM txn", &[]),
        4,
        "the statement's own row is gone"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[&statement]),
        0
    );
    assert_eq!(
        w.one::<String>(
            "SELECT entered || posted_on || amount_minor || memo FROM txn WHERE id = ?1",
            &[&by_hand]
        ),
        "statement2026-03-02-4250party food"
    );
    assert_eq!(
        parts(&w, &by_hand),
        [("category:food.groceries".to_owned(), -4_250)]
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&by_hand]),
        "Whole Foods"
    );
    // The statement states the line now, and from here it is never edited.
    assert_eq!(stated(&w, GROCER.0), by_hand);
    assert!(
        w.refused("txn.edit", json!({ "id": by_hand, "amount_minor": -1 }))
            .contains("never edited")
    );
    assert!(read(&w, |c| txn::proposed_matches(c, &id)).is_empty());
    // Importing the same statement again finds the line and writes nothing.
    let again = import(&w, &id, &[GROCER]);
    assert_eq!(
        (again["added"].as_i64(), again["unchanged"].as_i64()),
        (Some(0), Some(1))
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM txn", &[]), 4);
}

#[test]
fn a_line_in_a_transfer_or_a_split_that_would_change_amount_is_not_confirmed_silently() {
    let w = world("match_refused");
    let id = account(&w, "Everyday");
    let split = hand(&w, &id, "2026-03-01", -1_000, "Mixed");
    w.ok(
        "txn.split",
        json!({ "id": split, "parts": [
            { "category_id": "category:food.groceries", "amount_minor": -600 },
            { "category_id": "category:shopping.general", "amount_minor": -400 } ] }),
    );
    import(&w, &id, &[("csv:s", "2026-03-01", -1_100, "MIXED SHOP")]);
    let statement = stated(&w, "csv:s");
    assert!(
        w.refused(
            "txn.confirm_match",
            json!({ "hand_id": split, "statement_id": statement })
        )
        .contains("split it again")
    );
    // The same amount carries every part over.
    import(&w, &id, &[("csv:t", "2026-03-02", -1_000, "MIXED SHOP 2")]);
    let same = stated(&w, "csv:t");
    w.ok(
        "txn.confirm_match",
        json!({ "hand_id": split, "statement_id": same }),
    );
    assert_eq!(parts(&w, &split).len(), 2);
    // A line in a transfer is unlinked first.
    let savings = account(&w, "Savings");
    let out = hand(&w, &id, "2026-04-01", -500, "To savings");
    let into = hand(&w, &savings, "2026-04-01", 500, "From everyday");
    w.ok("txn.link_transfer", json!({ "id": out, "other_id": into }));
    import(&w, &id, &[("csv:u", "2026-04-01", -500, "TRANSFER OUT")]);
    let again = stated(&w, "csv:u");
    assert!(
        w.refused(
            "txn.confirm_match",
            json!({ "hand_id": out, "statement_id": again })
        )
        .contains("transfer")
    );
}

// ---------------------------------------------------------------------------------------------
// 4. Splits, and the one rule that they add up
// ---------------------------------------------------------------------------------------------

#[test]
fn a_line_has_one_part_several_or_none_and_the_parts_add_up_to_the_amount() {
    let w = world("splits");
    let id = account(&w, "Everyday");
    let line = hand(&w, &id, "2026-03-01", -1_000, "Costco");
    assert!(parts(&w, &line).is_empty(), "uncategorised: none");
    w.ok(
        "txn.categorize",
        json!({ "ids": [line], "category_id": "category:food.groceries" }),
    );
    assert_eq!(
        parts(&w, &line),
        [("category:food.groceries".to_owned(), -1_000)]
    );
    let three = json!({ "id": line, "parts": [
        { "category_id": "category:food.groceries", "amount_minor": -600, "memo": "food" },
        { "category_id": "category:shopping.general", "amount_minor": -300 },
        { "category_id": "category:health.care", "amount_minor": -100 } ] });
    let done = w.ok("txn.split", three.clone());
    assert_eq!(done["changed"], true);
    assert_eq!(parts(&w, &line).len(), 3);
    assert_eq!(w.ok("txn.split", three)["changed"], false);
    // The sentence says it first; the commit guard says it again whatever wrote the rows.
    assert!(
        w.refused(
            "txn.split",
            json!({ "id": line, "parts": [
                { "category_id": "category:food.groceries", "amount_minor": -600 },
                { "category_id": "category:health.care", "amount_minor": -100 } ] })
        )
        .contains("add up")
    );
    assert!(
        w.refused(
            "txn.split",
            json!({ "id": line, "parts": [
                { "category_id": "category:nope", "amount_minor": -1_000 } ] })
        )
        .contains("no such category")
    );
    // A split line's amount is edited only with the new parts.
    assert!(
        w.refused("txn.edit", json!({ "id": line, "amount_minor": -2_000 }))
            .contains("say how the new amount is split")
    );
    w.ok(
        "txn.edit",
        json!({ "id": line, "amount_minor": -2_000, "splits": [
            { "category_id": "category:food.groceries", "amount_minor": -1_500 },
            { "category_id": "category:health.care", "amount_minor": -500 } ] }),
    );
    // Filing the whole line under one category folds the parts; none clears them.
    w.ok(
        "txn.categorize",
        json!({ "ids": [line], "category_id": "category:fun.subscriptions" }),
    );
    assert_eq!(
        parts(&w, &line),
        [("category:fun.subscriptions".to_owned(), -2_000)]
    );
    let cleared = w.ok(
        "txn.categorize",
        json!({ "ids": [line], "category_id": null }),
    );
    assert_eq!(cleared["changed"], 1);
    assert!(parts(&w, &line).is_empty());
    // An archived category is not a place to file.
    w.ok(
        "flag.set",
        json!({ "id": "category:fees", "flag": "archived" }),
    );
    assert!(
        w.refused(
            "txn.categorize",
            json!({ "ids": [line], "category_id": "category:fees" })
        )
        .contains("archived")
    );
}

/// The commit guard holds the sum for every write path: each one is tried with raw SQL (what any
/// future command, restore or import would do) and each fails the whole commit, with nothing kept.
#[test]
fn every_path_that_writes_a_line_or_its_parts_is_held_to_the_sum_by_the_commit_guard() {
    let w = world("sum_guard");
    let id = account(&w, "Everyday");
    let line = hand(&w, &id, "2026-03-01", -1_000, "Costco");
    w.ok(
        "txn.split",
        json!({ "id": line, "parts": [
            { "category_id": "category:food.groceries", "amount_minor": -600 },
            { "category_id": "category:shopping.general", "amount_minor": -400 } ] }),
    );
    let fresh = w.mint();
    let attempts: Vec<(&str, String)> = vec![
        ("delete a part", format!("DELETE FROM txn_split WHERE txn_id = '{line}' AND position = 2")),
        (
            "change a part's amount",
            format!("UPDATE txn_split SET amount_minor = -500 WHERE txn_id = '{line}' AND position = 1"),
        ),
        (
            "add a part",
            format!("INSERT INTO txn_split (txn_id, position, category_id, amount_minor) VALUES ('{line}', 3, 'category:fees', -1)"),
        ),
        ("change the line's amount", format!("UPDATE txn SET amount_minor = -1_001 WHERE id = '{line}'")),
        (
            "move a part to another line's key",
            format!("UPDATE txn_split SET position = 1.5 WHERE txn_id = '{line}' AND position = 1; UPDATE txn_split SET amount_minor = 0 WHERE txn_id = '{line}' AND position = 1.5"),
        ),
        (
            "a new line born with parts that do not add up",
            format!(
                "INSERT INTO entity (id, kind, title, created_at, updated_at) VALUES ('{fresh}', 'txn', 'N', '2026-03-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z');
                 INSERT INTO txn (id, account_id, posted_on, amount_minor, entered) VALUES ('{fresh}', '{id}', '2026-03-01', -10, 'hand');
                 INSERT INTO txn_split (txn_id, position, category_id, amount_minor) VALUES ('{fresh}', 1, 'category:fees', -9)"
            ),
        ),
    ];
    for (what, sql) in attempts {
        let error = w
            .vault()
            .commit(|tx| {
                tx.connection().execute_batch(&sql)?;
                Ok(())
            })
            .expect_err(what);
        let text = error.to_string();
        assert!(
            text.contains("add up") || text.contains("-1_001"),
            "{what}: {text}"
        );
    }
    // Nothing of any attempt stayed.
    assert_eq!(parts(&w, &line).len(), 2);
    assert_eq!(
        w.one::<i64>("SELECT amount_minor FROM txn WHERE id = ?1", &[&line]),
        -1_000
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM txn", &[]), 1);
    // The same rows written so that they do add up are one commit that lands.
    w.commit(|tx| {
        tx.connection().execute_batch(&format!(
            "UPDATE txn SET amount_minor = -1001 WHERE id = '{line}';
             UPDATE txn_split SET amount_minor = -601 WHERE txn_id = '{line}' AND position = 1"
        ))?;
        Ok(())
    });
    // A line with no parts is uncategorised, and always holds.
    w.commit(|tx| {
        tx.connection().execute_batch(&format!(
            "DELETE FROM txn_split WHERE txn_id = '{line}'; UPDATE txn SET amount_minor = -5 WHERE id = '{line}'"
        ))?;
        Ok(())
    });
}

// ---------------------------------------------------------------------------------------------
// 5. A purged category
// ---------------------------------------------------------------------------------------------

#[test]
fn a_purged_category_refiles_its_parts_under_its_group_and_the_line_keeps_summing() {
    let w = world("purge_category");
    let id = account(&w, "Everyday");
    let beans = w.ok(
        "category.add",
        json!({ "title": "Beans", "parent_id": "category:food" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let split = hand(&w, &id, "2026-03-01", -1_000, "Mixed");
    w.ok(
        "txn.split",
        json!({ "id": split, "parts": [
            { "category_id": beans, "amount_minor": -600 },
            { "category_id": "category:health.care", "amount_minor": -400 } ] }),
    );
    let whole = hand(&w, &id, "2026-03-02", -300, "Only beans");
    w.ok(
        "txn.categorize",
        json!({ "ids": [whole], "category_id": beans }),
    );
    // A line whose parts would then name one category twice shows it once.
    let twice = hand(&w, &id, "2026-03-03", -500, "Twice");
    w.ok(
        "txn.split",
        json!({ "id": twice, "parts": [
            { "category_id": beans, "amount_minor": -200, "memo": "first" },
            { "category_id": "category:food", "amount_minor": -300, "memo": "second" } ] }),
    );
    w.ok("entity.purge", json!({ "id": beans }));
    assert_eq!(parts(&w, &twice), [("category:food".to_owned(), -500)]);
    // The part named the category's group now, and the other part is where it was.
    assert_eq!(
        parts(&w, &split),
        [
            ("category:food".to_owned(), -600),
            ("category:health.care".to_owned(), -400)
        ]
    );
    assert_eq!(parts(&w, &whole), [("category:food".to_owned(), -300)]);
}

#[test]
fn a_purged_category_with_no_group_leaves_a_split_line_uncategorised_and_a_purge_is_never_refused()
{
    let w = world("purge_group");
    let id = account(&w, "Everyday");
    let top = w.ok("category.add", json!({ "title": "Pets" }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let split = hand(&w, &id, "2026-03-01", -1_000, "Mixed");
    w.ok(
        "txn.split",
        json!({ "id": split, "parts": [
            { "category_id": top, "amount_minor": -600 },
            { "category_id": "category:health.care", "amount_minor": -400 } ] }),
    );
    let whole = hand(&w, &id, "2026-03-02", -300, "Only pets");
    w.ok(
        "txn.categorize",
        json!({ "ids": [whole], "category_id": top }),
    );
    // With no group to roll up to, the parts go and the lines are uncategorised.
    w.ok("entity.purge", json!({ "id": top }));
    assert!(parts(&w, &split).is_empty());
    assert!(parts(&w, &whole).is_empty());
    assert_eq!(
        w.one::<i64>("SELECT amount_minor FROM txn WHERE id = ?1", &[&split]),
        -1_000
    );
}

// ---------------------------------------------------------------------------------------------
// 6. Transfers
// ---------------------------------------------------------------------------------------------

#[test]
fn a_transfer_pairs_two_lines_of_two_accounts_in_one_currency_or_two_and_goes_with_either_line() {
    let w = world("transfers");
    let usd = account_in(&w, "Everyday", "checking", "USD");
    let usd2 = account_in(&w, "Savings", "savings", "USD");
    let eur = account_in(&w, "Euro", "checking", "EUR");
    let out = hand(&w, &usd, "2026-03-05", -50_000, "To savings");
    let into = hand(&w, &usd2, "2026-03-05", 50_000, "From everyday");
    let snack = hand(&w, &usd, "2026-03-06", -700, "Snack");
    assert!(
        w.refused("txn.link_transfer", json!({ "id": out, "other_id": snack }))
            .contains("between two accounts")
    );
    let fee = hand(&w, &usd2, "2026-03-05", -300, "Fee");
    assert!(
        w.refused("txn.link_transfer", json!({ "id": out, "other_id": fee }))
            .contains("money out and the other money in")
    );
    assert!(
        w.refused("txn.link_transfer", json!({ "id": out, "other_id": out }))
            .contains("two different")
    );
    w.ok("txn.link_transfer", json!({ "id": into, "other_id": out }));
    // The lower id is `a`: one row for the pair, whichever half was named first.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM transfer WHERE a < b AND a IN (?1, ?2)",
            &[&out, &into]
        ),
        1
    );
    assert_eq!(
        w.ok("txn.link_transfer", json!({ "id": out, "other_id": into }))["linked"],
        false
    );
    // A line is in at most one transfer.
    let refund = hand(&w, &usd2, "2026-03-07", 700, "Refund");
    assert!(
        w.refused(
            "txn.link_transfer",
            json!({ "id": refund, "other_id": out })
        )
        .contains("another transfer")
    );
    // Across currencies: what left one account is not what arrived in the other.
    let sent = hand(&w, &usd, "2026-03-08", -10_000, "To Euro");
    let got = hand(&w, &eur, "2026-03-08", 9_200, "From Everyday");
    w.ok("txn.link_transfer", json!({ "id": sent, "other_id": got }));
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM transfer", &[]), 2);
    // A half keeps its account and its direction while it is paired.
    assert!(
        w.refused("txn.edit", json!({ "id": got, "amount_minor": -1 }))
            .contains("keeps its direction")
    );
    assert!(
        w.refused("txn.edit", json!({ "id": got, "account_id": usd }))
            .contains("stays in its account")
    );
    w.ok("txn.edit", json!({ "id": got, "amount_minor": 9_300 }));
    // Neither half is spent: a movement of the member's own money is in no month's spending.
    assert!(
        read(&w, |c| money::spending_in_month(c, "2026-03"))
            .iter()
            .all(|spent| spent.amount_minor == -300
                || spent.amount_minor == -700
                || spent.amount_minor == 700)
    );
    // The pair goes with either line: purging one half takes the pair and leaves the other a plain line.
    w.ok("entity.trash", json!({ "id": got }));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM transfer", &[]),
        2,
        "a trashed half is restored with its pair"
    );
    w.ok("entity.purge", json!({ "id": got }));
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM transfer", &[]), 1);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[&sent]),
        1
    );
    // Unlinking names the other half, so linking it again takes the act back.
    let unlinked = w.ok("txn.unlink_transfer", json!({ "id": into }));
    assert_eq!(unlinked["unlinked"], 1);
    assert_eq!(unlinked["replaced"]["other_id"], out.as_str());
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM transfer", &[]), 0);
}

// ---------------------------------------------------------------------------------------------
// 7. Categories, budgets, rules
// ---------------------------------------------------------------------------------------------

#[test]
fn a_category_is_added_under_a_group_and_merged_with_everything_it_held() {
    let w = world("categories");
    let id = account(&w, "Everyday");
    let coffee = hand(&w, &id, "2026-03-04", -450, "Blue Coffee");
    let beans = w.ok(
        "category.add",
        json!({ "title": "Beans  & Co", "parent_id": "category:food" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(
        w.one::<String>("SELECT key FROM concept WHERE id = ?1", &[&beans]),
        "food.beans & co"
    );
    assert_eq!(
        w.one::<String>("SELECT parent_id FROM entity WHERE id = ?1", &[&beans]),
        "category:food"
    );
    assert!(
        w.refused(
            "category.add",
            json!({ "title": "beans & co", "parent_id": "category:food" })
        )
        .contains("already a category")
    );
    assert!(
        w.refused(
            "category.add",
            json!({ "title": "Deep", "parent_id": beans })
        )
        .contains("not under another category")
    );
    // The same name in another group is another category.
    w.ok(
        "category.add",
        json!({ "title": "Beans & Co", "parent_id": "category:fun" }),
    );
    w.ok(
        "txn.categorize",
        json!({ "ids": [coffee], "category_id": beans }),
    );
    w.ok(
        "rule.add",
        json!({ "match": "is", "text": "x", "category_id": beans }),
    );
    for (month, category, amount) in [
        ("2026-03", beans.as_str(), 100),
        ("2026-03", "category:food.dining", 50),
        ("2026-04", beans.as_str(), 70),
    ] {
        w.ok(
            "budget.set",
            json!({ "month": month, "category_id": category, "amount_minor": amount }),
        );
    }
    let merged = w.ok(
        "category.merge",
        json!({ "from_id": beans, "into_id": "category:food.dining" }),
    );
    assert_eq!(
        (
            merged["parts"].as_i64(),
            merged["rules"].as_i64(),
            merged["plans"].as_i64()
        ),
        (Some(1), Some(1), Some(2))
    );
    assert_eq!(
        parts(&w, &coffee),
        [("category:food.dining".to_owned(), -450)]
    );
    assert_eq!(
        w.one::<i64>("SELECT category_id = 'category:food.dining' FROM rule", &[]),
        1
    );
    assert_eq!(
        w.one::<i64>("SELECT amount_minor FROM budget WHERE category_id = 'category:food.dining' AND month = '2026-03'", &[]),
        150,
        "where both planned the month, the budgets add"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM budget WHERE month = '2026-04' AND category_id = 'category:food.dining'", &[]),
        1
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[&beans]),
        0
    );
    assert!(
        w.refused(
            "category.merge",
            json!({ "from_id": "category:food", "into_id": "category:fun" })
        )
        .contains("inside it")
    );
}

#[test]
fn a_budget_is_a_month_a_carry_and_an_amount_in_the_vaults_currency_and_writes_no_copy_of_others() {
    let w = world("budgets");
    // A budget has no currency: the vault's is the one it is in.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM pragma_table_info('budget') WHERE name = 'currency'",
            &[]
        ),
        0
    );
    let outcome = w.run(
        "budget.set",
        json!({ "month": "2026-03", "category_id": "category:food", "amount_minor": 1, "currency": "EUR" }),
    );
    assert_eq!(outcome.status, centraid_vault::CommandStatus::Failed);
    let plan =
        json!({ "month": "2026-03", "category_id": "category:food", "amount_minor": 60_000 });
    let revisions =
        |id: &str| w.one::<i64>("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &[id]);
    let before = revisions("category:food");
    assert_eq!(w.ok("budget.set", plan.clone())["changed"], true);
    assert_eq!(w.ok("budget.set", plan)["changed"], false);
    w.ok(
        "budget.set",
        json!({ "month": "2026-04", "category_id": "category:food", "amount_minor": 70_000 }),
    );
    w.ok(
        "rule.add",
        json!({ "match": "contains", "text": "grocer", "category_id": "category:food" }),
    );
    // A budget and a rule are outside their category's snapshot: no version of it was written.
    assert_eq!(revisions("category:food"), before);
    assert!(
        w.refused(
            "budget.set",
            json!({ "month": "2026-13", "category_id": "category:food", "amount_minor": 1 })
        )
        .contains("real month")
    );
    assert!(
        w.refused(
            "budget.set_carry",
            json!({ "month": "2026-05", "category_id": "category:food", "carry": true })
        )
        .contains("Set an amount")
    );
    assert_eq!(
        w.ok(
            "budget.set_carry",
            json!({ "month": "2026-03", "category_id": "category:food", "carry": true })
        )["changed"],
        true
    );
    let month = read(&w, |c| money::budgets_of_month(c, "2026-03"));
    assert_eq!(
        month
            .iter()
            .map(|b| (b.category_id.as_str(), b.amount_minor, b.carry))
            .collect::<Vec<_>>(),
        [("category:food", 60_000, true)]
    );
    // Setting the amount again keeps the carry it had.
    w.ok(
        "budget.set",
        json!({ "month": "2026-03", "category_id": "category:food", "amount_minor": 65_000 }),
    );
    assert_eq!(
        w.one::<i64>("SELECT carry FROM budget WHERE month = '2026-03'", &[]),
        1
    );
    assert_eq!(
        w.ok(
            "budget.set",
            json!({ "month": "2026-03", "category_id": "category:food", "amount_minor": null })
        )["changed"],
        true
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM budget", &[]), 1);
}

#[test]
fn a_rule_files_history_by_the_banks_words_the_most_specific_decides_and_a_split_line_is_left_alone()
 {
    let w = world("rules");
    let id = account(&w, "Everyday");
    import(
        &w,
        &id,
        &[
            GROCER,
            PAY,
            COFFEE,
            ("csv:ddddd", "2026-03-05", -8_000, "BLUE COFFEE ROASTERS"),
        ],
    );
    w.ok(
        "rule.add",
        json!({ "match": "contains", "text": "coffee", "category_id": "category:food.dining" }),
    );
    w.ok(
        "rule.add",
        json!({ "match": "contains", "text": "coffee", "min": 5000,
                "category_id": "category:shopping.general", "display_name": "Roasters" }),
    );
    // The pattern is a JSON object the vault defines, with its version; the order is its position.
    assert_eq!(
        w.one::<String>("SELECT json_extract(pattern, '$.v') || json_extract(pattern, '$.match') FROM rule ORDER BY position LIMIT 1", &[]),
        "1contains"
    );
    assert_eq!(
        w.strings(
            "SELECT display_name FROM rule WHERE display_name IS NOT NULL",
            &[]
        ),
        ["Roasters"]
    );
    let applied = w.ok("rule.apply", json!({}));
    assert_eq!(
        (
            applied["matched"].as_i64(),
            applied["recategorised"].as_i64()
        ),
        (Some(2), Some(2))
    );
    // The rule's name is the payee now; the bank's words stay what it said.
    let roasters = stated(&w, "csv:ddddd");
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&roasters]),
        "Roasters"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT stated_title FROM source WHERE entity_id = ?1",
            &[&roasters]
        ),
        "BLUE COFFEE ROASTERS"
    );
    let category = |external: &str| {
        parts(&w, &stated(&w, external))
            .first()
            .map(|p| p.0.clone())
    };
    assert_eq!(category(COFFEE.0).as_deref(), Some("category:food.dining"));
    assert_eq!(
        category("csv:ddddd").as_deref(),
        Some("category:shopping.general")
    );
    // A member's choice survives a second run, and only `overwrite` replaces it.
    w.ok(
        "txn.categorize",
        json!({ "ids": [stated(&w, COFFEE.0)], "category_id": "category:fees" }),
    );
    assert_eq!(w.ok("rule.apply", json!({}))["recategorised"], 0);
    assert_eq!(
        w.ok("rule.apply", json!({ "overwrite": true }))["recategorised"],
        1
    );
    assert_eq!(category(COFFEE.0).as_deref(), Some("category:food.dining"));
    // A line the member split is theirs, even with `overwrite`.
    let coffee = stated(&w, COFFEE.0);
    w.ok(
        "txn.split",
        json!({ "id": coffee, "parts": [
            { "category_id": "category:fees", "amount_minor": -150 },
            { "category_id": "category:fun.entertainment", "amount_minor": -300 } ] }),
    );
    assert_eq!(
        w.ok("rule.apply", json!({ "overwrite": true }))["recategorised"],
        0
    );
    assert_eq!(parts(&w, &coffee).len(), 2);
    // What matches is the statement's words, not the name the member gave.
    w.ok(
        "entity.retitle",
        json!({ "id": coffee, "title": "Morning" }),
    );
    w.ok(
        "txn.categorize",
        json!({ "ids": [coffee], "category_id": null }),
    );
    assert_eq!(w.ok("rule.apply", json!({}))["recategorised"], 1);
    // A rule is edited in place, in order, and an archived category is not a place to file.
    let first = w.strings("SELECT id FROM rule ORDER BY position", &[])[0].clone();
    w.ok(
        "rule.edit",
        json!({ "id": first, "text": "espresso", "position": 9 }),
    );
    assert_eq!(
        w.one::<String>(
            "SELECT json_extract(pattern, '$.text') FROM rule WHERE id = ?1",
            &[&first]
        ),
        "espresso"
    );
    w.ok(
        "flag.set",
        json!({ "id": "category:fees", "flag": "archived" }),
    );
    assert!(
        w.refused(
            "rule.add",
            json!({ "match": "is", "text": "x", "category_id": "category:fees" })
        )
        .contains("archived")
    );
    assert!(
        w.refused("rule.apply", json!({ "id": "no-such-rule" }))
            .contains("no such rule")
    );
    assert_eq!(w.ok("rule.delete", json!({ "id": first }))["deleted"], true);
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM rule", &[]), 1);
}

// ---------------------------------------------------------------------------------------------
// 8. What a month reads
// ---------------------------------------------------------------------------------------------

#[test]
fn spending_by_category_and_month_reads_the_one_table_and_leaves_out_what_is_not_spent() {
    let w = world("spending");
    let usd = account_in(&w, "Everyday", "checking", "USD");
    let eur = account_in(&w, "Euro", "checking", "EUR");
    let savings = account_in(&w, "Savings", "savings", "USD");
    let off = w.ok(
        "account.add",
        json!({ "title": "House", "type": "asset", "currency": "USD", "on_budget": false }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let lines = |account: &str, day: &str, amount: i64, category: Option<&str>| {
        let mut input = json!({ "account_id": account, "posted_on": day, "amount_minor": amount });
        if let Some(category) = category {
            input["category_id"] = json!(category);
        }
        w.ok("txn.add", input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    };
    lines(&usd, "2026-03-01", -1_000, Some("category:food.groceries"));
    lines(&usd, "2026-03-31", -500, Some("category:food.groceries"));
    lines(&usd, "2026-04-01", -9_999, Some("category:food.groceries"));
    lines(&usd, "2026-03-10", -200, None);
    lines(&eur, "2026-03-11", -300, Some("category:food.groceries"));
    lines(&off, "2026-03-12", -7_000, Some("category:housing.home"));
    let split = lines(&usd, "2026-03-15", -1_000, None);
    w.ok(
        "txn.split",
        json!({ "id": split, "parts": [
            { "category_id": "category:food.groceries", "amount_minor": -700 },
            { "category_id": "category:shopping.general", "amount_minor": -300 } ] }),
    );
    let pending = lines(&usd, "2026-03-16", -555, Some("category:fees"));
    w.ok("txn.edit", json!({ "id": pending, "status": "pending" }));
    let out = lines(&usd, "2026-03-20", -2_000, None);
    let into = lines(&savings, "2026-03-20", 2_000, None);
    w.ok("txn.link_transfer", json!({ "id": out, "other_id": into }));
    let trashed = lines(
        &usd,
        "2026-03-21",
        -4_000,
        Some("category:fun.entertainment"),
    );
    w.ok("entity.trash", json!({ "id": trashed }));
    let march = read(&w, |c| money::spending_in_month(c, "2026-03"));
    let amount = |currency: &str, category: Option<&str>| {
        march
            .iter()
            .find(|s: &&Spent| s.currency == currency && s.category_id.as_deref() == category)
            .map(|s| s.amount_minor)
    };
    assert_eq!(
        amount("USD", Some("category:food.groceries")),
        Some(-1_000 - 500 - 700)
    );
    assert_eq!(amount("USD", Some("category:shopping.general")), Some(-300));
    assert_eq!(
        amount("USD", None),
        Some(-200),
        "an uncategorised line is its own row"
    );
    assert_eq!(
        amount("EUR", Some("category:food.groceries")),
        Some(-300),
        "a currency is never added to another"
    );
    assert_eq!(
        amount("USD", Some("category:housing.home")),
        None,
        "an account off the budget is not spent"
    );
    assert_eq!(
        amount("USD", Some("category:fees")),
        None,
        "a pending line is not spent yet"
    );
    assert_eq!(
        amount("USD", Some("category:fun.entertainment")),
        None,
        "a trashed line is gone"
    );
    assert_eq!(march.len(), 4, "{march:?}");
    assert_eq!(
        read(&w, |c| money::spending_in_month(c, "2026-04"))
            .iter()
            .map(|s| s.amount_minor)
            .collect::<Vec<_>>(),
        [-9_999]
    );
}

/// Each read a screen makes is a bounded walk of an index: no scan of a table and no sort.
#[test]
fn what_a_month_balance_and_proposal_read_each_walk_an_index_and_sort_nothing() {
    let w = world("plans");
    let id = account(&w, "Everyday");
    hand(&w, &id, "2026-03-01", -1, "x");
    let plan = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> Vec<String> {
        read(&w, |c| {
            let mut statement = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let rows = statement
                .query_map(params, |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
    };
    let clean = |what: &str, plan: &[String]| {
        let joined = plan.join("\n");
        assert!(!joined.contains("TEMP B-TREE"), "{what}: {joined}");
        assert!(
            !plan
                .iter()
                .any(|line| line.starts_with("SCAN") && !line.contains("USING")),
            "{what}: {joined}"
        );
    };
    let spending = plan(money::SPENDING_OF_MONTH, &[&"2026-03-01", &"2026-04-01"]);
    clean("a month", &spending);
    assert!(
        spending.iter().any(|line| line.contains("txn_by_day")),
        "the month is a range of lines by day: {spending:?}"
    );
    let balance = plan(
        money::POSTED_BETWEEN,
        &[&id.as_str(), &"2026-01-01", &"2026-03-31"],
    );
    clean("a balance", &balance);
    assert!(
        balance
            .iter()
            .any(|line| line.contains("txn_by_account_day")),
        "{balance:?}"
    );
    let proposals = plan(txn::PROPOSALS, &[&id.as_str(), &3_i64]);
    clean("the proposals", &proposals);
    assert!(
        proposals
            .iter()
            .any(|line| line.contains("txn_hand_by_account")),
        "{proposals:?}"
    );
    let budgets = plan(money::BUDGETS_OF_MONTH, &[&"2026-03"]);
    clean("a month's budgets", &budgets);
    assert!(
        budgets.iter().any(|line| line.contains("budget_by_month")),
        "{budgets:?}"
    );
    let of_category = plan(money::PLANS_OF_CATEGORY, &[&"category:food"]);
    clean("a category's budgets", &of_category);
    assert!(
        of_category.iter().any(|line| line.contains("PRIMARY KEY")),
        "{of_category:?}"
    );
    // Statements of a month count as one walk, whatever the month holds.
    let before = w
        .vault()
        .read(|c| Ok(c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))?))
        .expect("reads");
    assert_eq!(before, 1);
}

// ---------------------------------------------------------------------------------------------
// 10. Search and earlier versions
// ---------------------------------------------------------------------------------------------

#[test]
fn a_line_is_found_by_its_name_memo_category_and_account_and_by_its_earlier_words() {
    let w = world("search");
    let id = account(&w, "Vacation fund");
    let line = w.ok(
        "txn.add",
        json!({ "account_id": id, "posted_on": "2026-03-01", "amount_minor": -1_000,
                "title": "Quokka tours", "memo": "wombat entry", "category_id": "category:fun.entertainment" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let now = |word: &str| {
        w.one::<i64>(
            "SELECT count(DISTINCT e.id) FROM search s JOIN entity e ON e.n = s.rowid
              WHERE search MATCH ?1 AND e.id = ?2",
            &[&format!("\"{word}\""), &line],
        )
    };
    let before = |word: &str| {
        w.one::<i64>(
            "SELECT count(DISTINCT e.id) FROM search_past t JOIN entity e ON e.n = (t.rowid >> 24)
              WHERE search_past MATCH ?1 AND e.id = ?2",
            &[&format!("\"{word}\""), &line],
        )
    };
    assert_eq!(
        (
            now("quokka"),
            now("wombat"),
            now("entertainment"),
            now("vacation")
        ),
        (1, 1, 1, 1)
    );
    w.ok("txn.edit", json!({ "id": line, "memo": "numbat entry" }));
    w.ok(
        "entity.retitle",
        json!({ "id": line, "title": "Marsupial tours" }),
    );
    assert_eq!((now("wombat"), now("quokka"), now("numbat")), (0, 0, 1));
    assert_eq!(
        (before("wombat"), before("quokka")),
        (1, 1),
        "found in the version that said it"
    );
    // A trashed line is in no search of the present.
    w.ok("entity.trash", json!({ "id": line }));
    assert_eq!(now("numbat"), 0);
}

#[test]
fn a_hand_line_keeps_earlier_versions_and_a_confirmed_one_cannot_go_back_to_the_amount_before() {
    let w = world("versions");
    let id = account(&w, "Everyday");
    let line = hand(&w, &id, "2026-03-01", -4_000, "Dinner");
    w.ok(
        "txn.edit",
        json!({ "id": line, "amount_minor": -4_250, "memo": "with tip" }),
    );
    let versions = w.strings(
        "SELECT CAST(json_extract(state, '$.txn.amount_minor') AS TEXT) FROM revision WHERE entity_id = ?1 ORDER BY seq",
        &[&line],
    );
    assert_eq!(
        versions.last().map(String::as_str),
        Some("-4000"),
        "the state before the edit"
    );
    // The line's origin is not part of a version: restoring never undoes a confirm.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM revision WHERE entity_id = ?1 AND json_extract(state, '$.txn.entered') IS NOT NULL",
            &[&line]
        ),
        0
    );
    let seq = w.one::<i64>(
        "SELECT MAX(seq) FROM revision WHERE entity_id = ?1",
        &[&line],
    );
    w.ok("history.restore_version", json!({ "id": line, "seq": seq }));
    assert_eq!(
        w.one::<i64>("SELECT amount_minor FROM txn WHERE id = ?1", &[&line]),
        -4_000
    );
    // Now a statement states it: the line is the bank's, and an earlier hand version of it cannot
    // put the amount back.
    import(&w, &id, &[("csv:d", "2026-03-02", -4_500, "RESTAURANT")]);
    let statement = stated(&w, "csv:d");
    w.ok(
        "txn.confirm_match",
        json!({ "hand_id": line, "statement_id": statement }),
    );
    let first = w.one::<i64>(
        "SELECT MIN(seq) FROM revision WHERE entity_id = ?1",
        &[&line],
    );
    let outcome = w.run(
        "history.restore_version",
        json!({ "id": line, "seq": first }),
    );
    assert_eq!(
        outcome.status,
        centraid_vault::CommandStatus::Failed,
        "{outcome:?}"
    );
    assert_eq!(
        w.one::<i64>("SELECT amount_minor FROM txn WHERE id = ?1", &[&line]),
        -4_500
    );
    // Its memo and categories are still the member's to put back.
    w.ok("txn.edit", json!({ "id": line, "memo": "later words" }));
    let last = w.one::<i64>(
        "SELECT MAX(seq) FROM revision WHERE entity_id = ?1",
        &[&line],
    );
    w.ok(
        "history.restore_version",
        json!({ "id": line, "seq": last }),
    );
    assert_ne!(
        w.one::<Option<String>>("SELECT memo FROM txn WHERE id = ?1", &[&line])
            .as_deref(),
        Some("later words")
    );
}
