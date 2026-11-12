//! Money as a spreadsheet file (#1185): `txn.export_csv` writes RFC 4180 text a spreadsheet reads
//! back (quoted fields, doubled quotes, CRLF), amounts as plain decimals with the currency in its
//! own column, names the file for what it holds, leaves the trash out and writes nothing.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("csv").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self
            .scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn id(&self, name: &str, input: Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn account(&self, title: &str, currency: &str) -> String {
        self.id(
            "account.add",
            json!({ "title": title, "type": "checking", "currency": currency }),
        )
    }

    /// One statement line; the transaction's id.
    fn line(&self, account: &str, external: &str, day: &str, amount: i64, words: &str) -> String {
        self.line_with(account, external, day, amount, words, json!({}))
    }

    fn line_with(
        &self,
        account: &str,
        external: &str,
        day: &str,
        amount: i64,
        words: &str,
        line: Value,
    ) -> String {
        self.ok(
            "follow.statement",
            json!({
                "origin": { "ref": account, "label": "Bank", "fills": account },
                "records": [{
                    "external_id": external,
                    "fields": { "title": words, "posted_on": day, "amount_minor": amount,
                                "line": line }
                }],
            }),
        );
        self.scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    "SELECT entity_id FROM source WHERE external_id = ?1",
                    [external],
                    |r| r.get::<_, String>(0),
                )?)
            })
            .expect("a followed line")
    }

    fn file(&self, input: Value) -> (Value, String) {
        let out = self.ok("txn.export_csv", input);
        let text = String::from_utf8(
            base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                out["content"].as_str().expect("content"),
            )
            .expect("base64"),
        )
        .expect("utf-8");
        (out, text)
    }

    fn writes(&self) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row("SELECT writes FROM vault", [], |r| r.get(0))?))
            .expect("a row")
    }
}

/// The records of a CSV file the way a spreadsheet reads it: CRLF between records, quotes
/// honoured (a doubled quote is one), a quoted field may hold commas and line breaks.
fn records(text: &str) -> Vec<Vec<String>> {
    assert!(text.ends_with("\r\n"), "every record ends in CRLF");
    let mut out = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') if chars.peek() == Some(&'"') => {
                chars.next();
                cell.push('"');
            }
            (true, '"') => quoted = false,
            (true, other) => cell.push(other),
            (false, '"') => quoted = true,
            (false, ',') => row.push(std::mem::take(&mut cell)),
            (false, '\r') => {
                assert_eq!(chars.next(), Some('\n'), "a bare CR");
                row.push(std::mem::take(&mut cell));
                out.push(std::mem::take(&mut row));
            }
            (false, '\n') => panic!("a bare LF outside quotes"),
            (false, other) => cell.push(other),
        }
    }
    out
}

#[test]
fn a_header_then_one_row_per_transaction_with_plain_decimal_amounts() {
    let w = World::new();
    let usd = w.account("Everyday", "USD");
    let yen = w.account("Tokyo", "JPY");
    w.line(&usd, "a", "2026-03-02", -1234, "COFFEE");
    w.line(&usd, "b", "2026-03-01", 250_000, "PAYROLL");
    w.line(&usd, "c", "2026-03-03", -5, "FEE");
    w.line(&yen, "d", "2026-03-04", -1200, "RAMEN");
    let (out, text) = w.file(json!({}));
    assert_eq!(out["media_type"], "text/csv");
    assert_eq!(out["name"], "Transactions.csv");
    assert_eq!(out["count"], 4);
    let rows = records(&text);
    assert_eq!(
        rows[0],
        [
            "Date",
            "Account",
            "Payee",
            "Description",
            "Category",
            "Amount",
            "Currency",
            "Status",
            "Memo",
            "Check number"
        ]
    );
    assert_eq!(rows.len(), 5);
    assert!(rows.iter().all(|r| r.len() == 10));
    let by_payee = |payee: &str| rows.iter().find(|r| r[2] == payee).expect("a row").clone();
    assert_eq!(by_payee("COFFEE")[5], "-12.34");
    assert_eq!(by_payee("COFFEE")[6], "USD");
    assert_eq!(by_payee("COFFEE")[0], "2026-03-02");
    assert_eq!(by_payee("COFFEE")[1], "Everyday");
    assert_eq!(by_payee("COFFEE")[7], "posted");
    assert_eq!(by_payee("PAYROLL")[5], "2500.00");
    assert_eq!(by_payee("FEE")[5], "-0.05");
    assert_eq!(by_payee("RAMEN")[5], "-1200");
    assert_eq!(by_payee("RAMEN")[6], "JPY");
    // Oldest first, as a statement reads.
    assert_eq!(rows[1][2], "PAYROLL");
}

#[test]
fn commas_quotes_and_line_breaks_are_quoted_and_survive_a_round_trip() {
    let w = World::new();
    let account = w.account("Joint, \"main\"", "USD");
    w.line_with(
        &account,
        "q",
        "2026-04-01",
        -4200,
        "Cafe \"Uno\", Main St",
        json!({ "memo": "table for two\nlate bill, paid", "check_number": 1042 }),
    );
    let (_, text) = w.file(json!({}));
    assert!(text.contains("\"Cafe \"\"Uno\"\", Main St\""));
    assert!(text.contains("\"Joint, \"\"main\"\"\""));
    assert!(!text.replace("\r\n", "").contains('\r'));
    let rows = records(&text);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1][1], "Joint, \"main\"");
    assert_eq!(rows[1][2], "Cafe \"Uno\", Main St");
    assert_eq!(rows[1][8], "table for two\nlate bill, paid");
    assert_eq!(rows[1][9], "1042");
}

#[test]
fn the_members_name_is_the_payee_and_the_banks_words_stay_and_a_category_is_named() {
    let w = World::new();
    let account = w.account("Everyday", "USD");
    let line = w.line(&account, "n", "2026-05-05", -900, "SQ *BLUE BOTTLE 123");
    w.ok(
        "entity.retitle",
        json!({ "id": line, "title": "Blue Bottle" }),
    );
    let category = w.id("category.add", json!({ "title": "Coffee" }));
    w.ok(
        "txn.categorize",
        json!({ "ids": [line], "category_id": category }),
    );
    let (_, text) = w.file(json!({}));
    let rows = records(&text);
    assert_eq!(rows[1][2], "Blue Bottle");
    assert_eq!(rows[1][3], "SQ *BLUE BOTTLE 123");
    assert_eq!(rows[1][4], "Coffee");
}

#[test]
fn a_trashed_transaction_is_not_in_the_file_and_the_count_says_so() {
    let w = World::new();
    let account = w.account("Everyday", "USD");
    w.line(&account, "k", "2026-06-01", -100, "KEEP");
    let gone = w.line(&account, "g", "2026-06-02", -200, "GONE");
    w.ok("entity.trash", json!({ "id": gone }));
    let (out, text) = w.file(json!({}));
    assert_eq!(out["count"], 1);
    assert!(text.contains("KEEP") && !text.contains("GONE"));
    let (out, _) = w.file(json!({ "transaction_id": gone }));
    assert_eq!(out["count"], 0);
}

#[test]
fn a_voided_line_is_kept_with_its_status_and_a_trashed_one_is_dropped() {
    let w = World::new();
    let account = w.account("Everyday", "USD");
    w.line(&account, "k", "2026-06-01", -100, "KEEP");
    let voided = w.line(&account, "v", "2026-06-02", -200, "VOIDED");
    let gone = w.line(&account, "g", "2026-06-03", -300, "GONE");
    w.ok("entity.trash", json!({ "id": gone }));
    w.scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.void");
            tx.connection()
                .execute("UPDATE txn SET status = 'void' WHERE id = ?1", [&voided])?;
            Ok(())
        })
        .expect("a voided line");
    let (out, text) = w.file(json!({}));
    assert_eq!(out["count"], 2);
    assert!(!text.contains("GONE"));
    let rows = records(&text);
    let void_row = rows
        .iter()
        .find(|r| r[2] == "VOIDED")
        .expect("the voided line");
    assert_eq!(void_row[7], "void");
    let kept = rows
        .iter()
        .find(|r| r[2] == "KEEP")
        .expect("the other line");
    assert_ne!(kept[7], "void");
}

#[test]
fn one_account_is_its_own_file_named_for_it() {
    let w = World::new();
    let one = w.account("Everyday", "USD");
    let two = w.account("Savings", "USD");
    w.line(&one, "e", "2026-07-01", -100, "IN ONE");
    w.line(&two, "s", "2026-07-02", -200, "IN TWO");
    let (out, text) = w.file(json!({ "account_id": two }));
    assert_eq!(out["name"], "Savings transactions.csv");
    assert_eq!(out["count"], 1);
    assert!(text.contains("IN TWO") && !text.contains("IN ONE"));
}

#[test]
fn one_transaction_is_named_for_its_payee_and_day_and_writes_nothing() {
    let w = World::new();
    let account = w.account("Everyday", "USD");
    w.line(&account, "x", "2026-08-01", -100, "OTHER");
    let line = w.line(&account, "y", "2026-08-09", -2599, "Bookshop / Main");
    let before = w.writes();
    let (out, text) = w.file(json!({ "transaction_id": line }));
    assert_eq!(out["name"], "Bookshop - Main 2026-08-09.csv");
    assert_eq!(out["count"], 1);
    let rows = records(&text);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1][5], "-25.99");
    assert!(!text.contains("OTHER"));
    assert_eq!(w.writes(), before, "an export writes nothing");
}
