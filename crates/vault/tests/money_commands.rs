//! THE 20 `money.*` COMMANDS (#1099, wave 1 lane V).
//!
//! What each test holds, and the claim a port would get wrong:
//!
//! 1. **Idempotency, by state.** Every `Idempotent` command is run twice with the
//!    same input and the rows (including `row_version`, so a no-op that still
//!    wrote would show) are identical. A `Once` command re-offered is refused and
//!    changes nothing.
//! 2. **A refusal is a value.** A precondition's sentence and its predicate name
//!    come back as a `Failed` outcome, never a panic and never a half-write.
//! 3. **Importing twice writes nothing**, and a file that overlaps the last by a
//!    week writes only the new lines.
//! 4. **The schema backs the commands**: a currency mismatch, an edit of an
//!    imported line and an un-void are refused by the engine even when a command
//!    is bypassed.
//! 5. **Void never deletes.**
//! 6. **Merging a category rewrites every reference in one commit.**
//! 7. **Rule matching follows the plan's seam S2** (specificity ascending, then
//!    position, then id; the last rule that sets a field wins).

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandOutcome, CommandStatus, Vault};
use serde_json::{Value, json};

struct Money {
    scratch: common::Scratch,
    registry: Registry,
    principal: Principal,
}

const GROCERIES: &str = "money:cat:food.groceries";
const DINING: &str = "money:cat:food.dining";
const FUEL: &str = "money:cat:transport.fuel";
const FOOD: &str = "money:cat:food";

impl Money {
    fn open(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        Self {
            scratch,
            registry,
            principal: Principal::owner("phone"),
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    fn try_run(&self, command: &str, input: Value) -> CommandOutcome {
        self.vault()
            .execute(
                &self.registry,
                &self.principal,
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("`{command}` errored rather than answering: {error}"))
    }

    fn run(&self, command: &str, input: Value) -> Value {
        let outcome = self.try_run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "`{command}` refused: {:?} / {:?}",
            outcome.predicate,
            outcome.reason
        );
        outcome.output
    }

    /// The predicate a refused command named; fails if it ran.
    fn refused(&self, command: &str, input: Value) -> String {
        let before = self.fingerprint();
        let outcome = self.try_run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "`{command}` should have been refused"
        );
        assert!(outcome.reason.is_some(), "a refusal says why");
        assert_eq!(
            before,
            self.fingerprint(),
            "a refused `{command}` must write nothing"
        );
        outcome.predicate.expect("a refusal names its predicate")
    }

    /// Run an idempotent command twice: the second run changes no row. Returns
    /// the first run's output.
    fn twice(&self, command: &str, input: Value) -> Value {
        let first = self.run(command, input.clone());
        let after_first = self.fingerprint();
        let second = self.run(command, input);
        assert_eq!(
            after_first,
            self.fingerprint(),
            "`{command}` run twice must land the same state"
        );
        let _ = second;
        first
    }

    /// Every row a Money command can touch, with its versions, as text.
    fn fingerprint(&self) -> String {
        let tables = [
            "core_account",
            "core_transaction",
            "core_link",
            "core_tag",
            "core_concept",
            "core_entity",
            "money_account",
            "money_transaction",
            "money_target",
            "money_rule",
            "money_import_profile",
            "money_balance_checkpoint",
        ];
        self.vault()
            .read(|connection| {
                let mut out = String::new();
                for table in tables {
                    let mut statement =
                        connection.prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2"))?;
                    let columns = statement.column_count();
                    let rows = statement.query_map([], |row| {
                        let mut line = String::new();
                        for column in 0..columns {
                            line.push_str(&format!("{:?}|", row.get_ref(column)?));
                        }
                        Ok(line)
                    })?;
                    out.push_str(&format!("# {table}\n"));
                    for row in rows {
                        out.push_str(&row?);
                        out.push('\n');
                    }
                }
                Ok(out)
            })
            .expect("the fingerprint reads")
    }

    fn count(&self, sql: &str) -> i64 {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .expect("the count reads")
    }

    fn text(&self, sql: &str) -> String {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .expect("the text reads")
    }

    fn account(&self, id: &str, name: &str, kind: &str, currency: &str) {
        self.run(
            "money.add_account",
            json!({ "account_id": id, "name": name, "kind": kind, "currency": currency }),
        );
    }

    fn import(&self, account: &str, rows: Vec<Value>) -> Value {
        self.run(
            "money.import_transactions",
            json!({ "account_id": account, "source": "ofx", "rows": rows }),
        )
    }
}

fn line(txn: &str, external: &str, day: &str, amount: i64, direction: &str, text: &str) -> Value {
    json!({
        "txn_id": txn, "external_id": external, "posted_on": day,
        "amount_minor": amount, "direction": direction, "description": text,
    })
}

fn outcomes(output: &Value) -> Vec<(String, String)> {
    output["outcomes"]
        .as_array()
        .expect("outcomes")
        .iter()
        .map(|o| {
            (
                o["txn_id"].as_str().unwrap().to_owned(),
                o["outcome"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[test]
fn an_account_is_a_core_account_decorated_with_the_members_words() {
    let money = Money::open("money-account");
    let output = money.run(
        "money.add_account",
        json!({ "account_id": "chq", "name": "Everyday", "kind": "checking",
                "currency": "cad", "opening_minor": 120_000, "opening_on": "2026-01-01" }),
    );
    assert_eq!(output["currency"], "CAD");
    assert_eq!(
        money.text("SELECT kind || '|' || currency || '|' || is_asset FROM core_account WHERE account_id = 'chq'"),
        "depository|CAD|1"
    );
    assert_eq!(
        money.text("SELECT kind || '|' || on_budget || '|' || opening_minor FROM money_account WHERE account_id = 'chq'"),
        "checking|1|120000"
    );
    // The owner is the vault's own party.
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_account a JOIN core_vault v ON v.self_party_id = a.owner_party_id"),
        1
    );
    money.account("card", "Visa", "credit_card", "CAD");
    assert_eq!(
        money.text("SELECT kind || '|' || is_asset FROM core_account WHERE account_id = 'card'"),
        "credit|0"
    );
    money.account("cash", "Wallet", "cash", "CAD");
    assert_eq!(
        money.text("SELECT kind FROM core_account WHERE account_id = 'cash'"),
        "cash"
    );
    // Omitting the currency means the vault's own.
    let output = money.run(
        "money.add_account",
        json!({ "account_id": "sav", "name": "Savings", "kind": "savings" }),
    );
    assert_eq!(output["currency"], "USD");
}

#[test]
fn add_account_is_once_and_refuses_what_it_cannot_honour() {
    let money = Money::open("money-account-refusals");
    money.account("a1", "Everyday", "checking", "USD");
    // A re-offer of the minted id changes nothing.
    assert_eq!(
        money.refused(
            "money.add_account",
            json!({ "account_id": "a1", "name": "Other", "kind": "savings" })
        ),
        "account_id_free"
    );
    assert_eq!(
        money.refused(
            "money.add_account",
            json!({ "account_id": "a2", "name": " everyday ", "kind": "savings" })
        ),
        "name_is_free"
    );
    assert_eq!(
        money.refused(
            "money.add_account",
            json!({ "account_id": "a3", "name": "  ", "kind": "savings" })
        ),
        "name_is_present"
    );
    assert_eq!(
        money.refused(
            "money.add_account",
            json!({ "account_id": "a4", "name": "Reserve", "kind": "savings", "opening_minor": 5 })
        ),
        "opening_balance_has_a_day"
    );
    assert_eq!(
        money.refused(
            "money.add_account",
            json!({ "account_id": "a5", "name": "Reserve", "kind": "savings",
                    "opening_minor": 5, "opening_on": "2026-02-30" })
        ),
        "opening_date_is_real"
    );
    assert_eq!(
        money.refused(
            "money.add_account",
            json!({ "account_id": "a6", "name": "Reserve", "kind": "savings", "currency": "us1" })
        ),
        "currency_is_a_code"
    );
}

#[test]
fn editing_an_account_renames_the_members_word_and_leaves_the_spines_alone() {
    let money = Money::open("money-edit-account");
    money.account("a1", "Everyday", "checking", "USD");
    money.account("card", "Visa", "credit_card", "USD");
    let out = money.twice(
        "money.edit_account",
        json!({ "account_id": "a1", "name": "Main" }),
    );
    assert_eq!(out["changed"], true);
    assert_eq!(
        money.text("SELECT name FROM money_account WHERE account_id = 'a1'"),
        "Main"
    );
    assert_eq!(
        money.text("SELECT name FROM core_account WHERE account_id = 'a1'"),
        "Everyday",
        "the append-only spine row keeps the words it was founded with"
    );
    money.twice(
        "money.edit_account",
        json!({ "account_id": "a1", "kind": "savings", "on_budget": false }),
    );
    assert_eq!(
        money.text("SELECT kind || on_budget FROM money_account WHERE account_id = 'a1'"),
        "savings0"
    );
    assert_eq!(
        money.refused(
            "money.edit_account",
            json!({ "account_id": "a1", "kind": "credit_card" })
        ),
        "kind_stays_in_its_class"
    );
    assert_eq!(
        money.refused(
            "money.edit_account",
            json!({ "account_id": "a1", "name": "visa" })
        ),
        "name_is_free"
    );
    assert_eq!(
        money.refused(
            "money.edit_account",
            json!({ "account_id": "nope", "name": "X" })
        ),
        "account_is_money"
    );
    // Close and reopen.
    money.twice(
        "money.edit_account",
        json!({ "account_id": "card", "closed_on": "2026-03-01" }),
    );
    assert_eq!(
        money.text("SELECT closed_on FROM money_account WHERE account_id = 'card'"),
        "2026-03-01"
    );
    money.twice(
        "money.edit_account",
        json!({ "account_id": "card", "closed_on": null }),
    );
    assert_eq!(
        money.count("SELECT COUNT(*) FROM money_account WHERE closed_on IS NOT NULL"),
        0
    );
    assert_eq!(
        money.refused(
            "money.edit_account",
            json!({ "account_id": "card", "closed_on": "2026-13-01" })
        ),
        "closing_date_is_real"
    );
}

#[test]
fn an_opening_balance_dated_after_the_first_line_needs_a_yes() {
    let money = Money::open("money-opening");
    money.account("a1", "Everyday", "checking", "USD");
    money.import(
        "a1",
        vec![line("t1", "ofx:1", "2026-02-10", 500, "debit", "COFFEE")],
    );
    let before = json!({ "account_id": "a1", "opening_minor": 10_000, "opening_on": "2026-02-01" });
    money.twice("money.set_opening_balance", before);
    assert_eq!(
        money.refused(
            "money.set_opening_balance",
            json!({ "account_id": "a1", "opening_minor": 1, "opening_on": "2026-03-01" })
        ),
        "opening_not_after_first_transaction"
    );
    money.twice(
        "money.set_opening_balance",
        json!({ "account_id": "a1", "opening_minor": 1, "opening_on": "2026-03-01", "confirm": true }),
    );
    assert_eq!(
        money.text("SELECT opening_on FROM money_account WHERE account_id = 'a1'"),
        "2026-03-01"
    );
    // A void line does not count as the first line.
    money.run("money.void_transaction", json!({ "txn_id": "t1" }));
    money.run(
        "money.set_opening_balance",
        json!({ "account_id": "a1", "opening_minor": 2, "opening_on": "2026-04-01" }),
    );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

#[test]
fn importing_twice_writes_nothing_and_an_overlap_writes_only_the_new_lines() {
    let money = Money::open("money-import");
    money.account("a1", "Everyday", "checking", "USD");
    let first = vec![
        line(
            "t1",
            "ofx:A1",
            "2026-01-02",
            1_250,
            "debit",
            "  COSTCO WHSE #123 ",
        ),
        line("t2", "ofx:A2", "2026-01-03", 250_000, "credit", "PAYROLL"),
        line("t3", "ofx:A3", "2026-01-09", 899, "debit", "NETFLIX"),
    ];
    let output = money.run(
        "money.import_transactions",
        json!({ "account_id": "a1", "source": "ofx", "rows": first,
                "checkpoint": { "as_of": "2026-01-09", "balance_minor": 98_000, "currency": "USD" } }),
    );
    assert_eq!(
        outcomes(&output),
        [("t1", "inserted"), ("t2", "inserted"), ("t3", "inserted")]
            .map(|(a, b)| (a.to_owned(), b.to_owned()))
    );
    assert_eq!(output["checkpoint_written"], true);
    // The bank's words are kept as written (trimmed of the edges only), and the
    // amounts are magnitudes in the ACCOUNT's currency.
    assert_eq!(
        money.text("SELECT description || '|' || amount_minor || '|' || currency || '|' || status || '|' || posted_at FROM core_transaction WHERE txn_id = 't1'"),
        "COSTCO WHSE #123|1250|USD|posted|2026-01-02T00:00:00Z"
    );

    // The same file again: every line is already in, nothing is written, the
    // checkpoint is not rewritten, and no Money table is reported as touched.
    let after_first = money.fingerprint();
    let again = money.try_run(
        "money.import_transactions",
        json!({ "account_id": "a1", "source": "ofx",
                "rows": [
                  line("u1", "ofx:A1", "2026-01-02", 1_250, "debit", "COSTCO WHSE #123"),
                  line("u2", "ofx:A2", "2026-01-03", 250_000, "credit", "PAYROLL"),
                  line("u3", "ofx:A3", "2026-01-09", 899, "debit", "NETFLIX")],
                "checkpoint": { "as_of": "2026-01-09", "balance_minor": 98_000, "currency": "USD" } }),
    );
    assert_eq!(again.status, CommandStatus::Executed);
    assert_eq!(
        after_first,
        money.fingerprint(),
        "the second import wrote nothing"
    );
    assert_eq!(again.output["checkpoint_written"], false);
    let ids: Vec<String> = again.output["outcomes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| {
            format!(
                "{}:{}",
                o["txn_id"].as_str().unwrap(),
                o["outcome"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(
        ids,
        ["t1:already_in", "t2:already_in", "t3:already_in"],
        "an already-in line names the row that holds it"
    );
    assert!(
        !again
            .tables
            .iter()
            .any(|table| table.starts_with("money_") || table == "core_transaction"),
        "{:?}",
        again.tables
    );

    // A file that overlaps the last by a week: only the new lines land.
    let overlap = vec![
        line("v1", "ofx:A3", "2026-01-09", 899, "debit", "NETFLIX"),
        line("v2", "ofx:A4", "2026-01-12", 4_000, "debit", "SHELL"),
        line("v3", "ofx:A5", "2026-01-15", 1_000, "debit", "PHARMACY"),
    ];
    let output = money.import("a1", overlap);
    assert_eq!(
        outcomes(&output),
        [("t3", "already_in"), ("v2", "inserted"), ("v3", "inserted")]
            .map(|(a, b)| (a.to_owned(), b.to_owned()))
    );
    assert_eq!(money.count("SELECT COUNT(*) FROM core_transaction"), 5);
    assert_eq!(money.count("SELECT COUNT(*) FROM money_transaction"), 5);
}

#[test]
fn an_import_says_per_line_what_it_would_not_take() {
    let money = Money::open("money-import-refusals");
    money.account("a1", "Everyday", "checking", "USD");
    money.import(
        "a1",
        vec![line("t1", "ofx:A1", "2026-01-02", 100, "debit", "X")],
    );
    let rows = vec![
        line(
            "r1",
            "csv:abc",
            "2026-01-02",
            100,
            "debit",
            "wrong source prefix",
        ),
        line("r2", "ofx:B2", "2026-02-30", 100, "debit", "not a real day"),
        {
            let mut row = line(
                "r3",
                "ofx:B3",
                "2026-01-02",
                100,
                "debit",
                "no such category",
            );
            row["category_concept_id"] = json!("not-a-category");
            row
        },
        // A txn id another row already holds, under a different statement line.
        line("t1", "ofx:B4", "2026-01-02", 100, "debit", "id taken"),
        {
            let mut row = line("r5", "ofx:B5", "2026-01-04", 700, "debit", "fine");
            row["category_concept_id"] = json!(GROCERIES);
            row["display_name"] = json!(" Corner shop ");
            row["memo"] = json!("  ");
            row["bank_type"] = json!("POS");
            row["check_number"] = json!("1042");
            row
        },
        // The same line twice in one file: the second finds the first.
        line("r6", "ofx:B5", "2026-01-04", 700, "debit", "fine"),
    ];
    let output = money.import("a1", rows);
    let reasons: Vec<String> = output["outcomes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| {
            format!(
                "{}:{}",
                o["outcome"].as_str().unwrap(),
                o["reason"].as_str().unwrap_or("-")
            )
        })
        .collect();
    assert_eq!(
        reasons,
        [
            "refused:external_id_not_from_source",
            "refused:bad_date",
            "refused:unknown_category",
            "refused:txn_id_taken",
            "inserted:-",
            "already_in:-",
        ]
    );
    // The accepted line carries everything the statement had, and a name given
    // by the importer's rules is a RULE's name, not the member's.
    assert_eq!(
        money.text("SELECT COALESCE(display_name, '-') || '|' || COALESCE(display_name_source, '-') || '|' || COALESCE(memo, '-') || '|' || COALESCE(bank_type, '-') || '|' || COALESCE(check_number, '-') || '|' || imported_from FROM money_transaction WHERE txn_id = 'r5'"),
        "Corner shop|rule|-|POS|1042|ofx"
    );
    assert_eq!(
        money.text("SELECT category_concept_id FROM core_transaction WHERE txn_id = 'r5'"),
        GROCERIES
    );
    // The refused lines wrote nothing.
    assert_eq!(money.count("SELECT COUNT(*) FROM core_transaction"), 2);
}

#[test]
fn an_import_into_nothing_a_wrong_currency_or_too_many_lines_is_refused_whole() {
    let money = Money::open("money-import-whole");
    money.account("a1", "Everyday", "checking", "USD");
    assert_eq!(
        money.refused(
            "money.import_transactions",
            json!({ "account_id": "ghost", "source": "csv", "rows": [] })
        ),
        "account_is_money"
    );
    assert_eq!(
        money.refused(
            "money.import_transactions",
            json!({ "account_id": "a1", "source": "ofx", "rows": [],
                    "checkpoint": { "as_of": "2026-01-09", "balance_minor": 1, "currency": "EUR" } })
        ),
        "checkpoint_matches_the_account"
    );
    // Over the vault's own ceiling: refused by the schema gate before any write.
    let rows: Vec<Value> = (0..20_001)
        .map(|i| {
            line(
                &format!("t{i}"),
                &format!("ofx:{i:08}"),
                "2026-01-02",
                1,
                "debit",
                "x",
            )
        })
        .collect();
    let outcome = money.try_run(
        "money.import_transactions",
        json!({ "account_id": "a1", "source": "ofx", "rows": rows }),
    );
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert_eq!(outcome.predicate.as_deref(), Some("schema"));
    assert_eq!(money.count("SELECT COUNT(*) FROM core_transaction"), 0);
}

#[test]
fn a_stated_balance_is_written_once_and_replaced_when_the_bank_corrects_it() {
    let money = Money::open("money-checkpoint");
    money.account("a1", "Everyday", "checking", "USD");
    let out = money.twice(
        "money.record_checkpoint",
        json!({ "account_id": "a1", "as_of": "2026-01-31", "balance_minor": -4_000 }),
    );
    assert_eq!(out["written"], true);
    assert_eq!(
        money.text("SELECT source || '|' || balance_minor FROM money_balance_checkpoint"),
        "member|-4000"
    );
    let out = money.run(
        "money.record_checkpoint",
        json!({ "account_id": "a1", "as_of": "2026-01-31", "balance_minor": -4_500 }),
    );
    assert_eq!(out["written"], true);
    assert_eq!(
        money.count("SELECT COUNT(*) FROM money_balance_checkpoint"),
        1
    );
    // A different source on the same day is a different statement.
    money.run(
        "money.record_checkpoint",
        json!({ "account_id": "a1", "as_of": "2026-01-31", "balance_minor": -4_500, "source": "ofx" }),
    );
    assert_eq!(
        money.count("SELECT COUNT(*) FROM money_balance_checkpoint"),
        2
    );
    assert_eq!(
        money.refused(
            "money.record_checkpoint",
            json!({ "account_id": "a1", "as_of": "2026-01-31", "balance_minor": 1, "currency": "EUR" })
        ),
        "checkpoint_matches_the_account"
    );
    assert_eq!(
        money.refused(
            "money.record_checkpoint",
            json!({ "account_id": "a1", "as_of": "2026-02-31", "balance_minor": 1 })
        ),
        "checkpoint_date_is_real"
    );
}

#[test]
fn a_layout_is_remembered_by_the_files_header_and_refused_when_it_cannot_say_where_the_amount_is() {
    let money = Money::open("money-profile");
    money.account("a1", "Everyday", "checking", "USD");
    let profile = json!({
        "account_id": "a1", "header_fingerprint": "h1", "delimiter": ";", "skip_lines": 2,
        "date_order": "dmy", "sign_mode": "debit_credit", "date_col": 0, "debit_col": 3,
        "credit_col": 4, "desc_col": 1, "memo_col": null,
    });
    let out = money.twice("money.save_import_profile", profile.clone());
    assert_eq!(out["saved"], true);
    assert_eq!(money.count("SELECT COUNT(*) FROM money_import_profile"), 1);
    // Saving the same layout again is not a change; a different one replaces it.
    let again = money.run("money.save_import_profile", profile.clone());
    assert_eq!(again["saved"], false);
    let mut changed = profile.clone();
    changed["delimiter"] = json!(",");
    changed["sign_mode"] = json!("signed");
    changed["amount_col"] = json!(2);
    money.twice("money.save_import_profile", changed);
    assert_eq!(money.count("SELECT COUNT(*) FROM money_import_profile"), 1);
    assert_eq!(
        money.text("SELECT delimiter || sign_mode || amount_col FROM money_import_profile"),
        ",signed2"
    );
    let mut bad = profile;
    bad["header_fingerprint"] = json!("h2");
    bad["sign_mode"] = json!("indicator");
    assert_eq!(
        money.refused("money.save_import_profile", bad),
        "layout_names_its_columns"
    );
}

// ---------------------------------------------------------------------------
// Decisions about a line
// ---------------------------------------------------------------------------

fn two_accounts(money: &Money) {
    money.account("a1", "Everyday", "checking", "USD");
    money.account("a2", "Savings", "savings", "USD");
    money.import(
        "a1",
        vec![
            line(
                "t1",
                "ofx:1",
                "2026-01-02",
                100_000,
                "debit",
                "TRANSFER TO SAVINGS",
            ),
            line(
                "t2",
                "ofx:2",
                "2026-01-03",
                1_250,
                "debit",
                "COSTCO WHSE #123",
            ),
            line("t3", "ofx:3", "2026-01-04", 4_000, "debit", "SHELL OIL"),
        ],
    );
    money.import(
        "a2",
        vec![line(
            "s1",
            "ofx:S1",
            "2026-01-02",
            100_000,
            "credit",
            "TRANSFER FROM CHEQUING",
        )],
    );
}

#[test]
fn categorizing_many_lines_is_idempotent_and_refuses_what_is_not_a_live_category() {
    let money = Money::open("money-categorize");
    two_accounts(&money);
    let out = money.twice(
        "money.categorize",
        json!({ "txn_ids": ["t2", "t3", "t2"], "category_concept_id": GROCERIES }),
    );
    assert_eq!(out["changed"], 2);
    let again = money.run(
        "money.categorize",
        json!({ "txn_ids": ["t2"], "category_concept_id": GROCERIES }),
    );
    assert_eq!(again["changed"], 0);
    // null clears.
    money.twice(
        "money.categorize",
        json!({ "txn_ids": ["t3"], "category_concept_id": null }),
    );
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_transaction WHERE category_concept_id IS NOT NULL"),
        1
    );
    assert_eq!(
        money.refused(
            "money.categorize",
            json!({ "txn_ids": ["t2"], "category_concept_id": "nope" })
        ),
        "category_is_known"
    );
    assert_eq!(
        money.refused(
            "money.categorize",
            json!({ "txn_ids": ["ghost"], "category_concept_id": GROCERIES })
        ),
        "transactions_are_money"
    );
    money.run(
        "money.archive_category",
        json!({ "concept_id": DINING, "archived": true }),
    );
    assert_eq!(
        money.refused(
            "money.categorize",
            json!({ "txn_ids": ["t2"], "category_concept_id": DINING })
        ),
        "category_is_known"
    );
    money.run("money.void_transaction", json!({ "txn_id": "t3" }));
    assert_eq!(
        money.refused(
            "money.categorize",
            json!({ "txn_ids": ["t3"], "category_concept_id": GROCERIES })
        ),
        "transactions_are_not_void"
    );
}

#[test]
fn void_never_deletes_and_never_comes_back_and_ends_the_transfer_it_was_half_of() {
    let money = Money::open("money-void");
    two_accounts(&money);
    money.run(
        "money.link_transfer",
        json!({ "txn_id": "t1", "other_txn_id": "s1" }),
    );
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_link WHERE valid_to IS NULL"),
        1
    );
    let rows_before = money.count("SELECT COUNT(*) FROM core_transaction");
    let out = money.twice("money.void_transaction", json!({ "txn_id": "t1" }));
    assert_eq!(out["voided"], true);
    assert_eq!(out["transfers_ended"], 1);
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_transaction"),
        rows_before,
        "nothing is deleted"
    );
    assert_eq!(
        money.text("SELECT status FROM core_transaction WHERE txn_id = 't1'"),
        "void"
    );
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_link WHERE valid_to IS NULL"),
        0
    );
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_link"),
        1,
        "the link keeps its history"
    );
    // A void line is not what a re-import brings back: it is the same line.
    let out = money.import(
        "a1",
        vec![line(
            "x1",
            "ofx:1",
            "2026-01-02",
            100_000,
            "debit",
            "TRANSFER TO SAVINGS",
        )],
    );
    assert_eq!(outcomes(&out), [("t1".to_owned(), "already_in".to_owned())]);
    assert_eq!(
        money.text("SELECT status FROM core_transaction WHERE txn_id = 't1'"),
        "void"
    );
    assert_eq!(
        money.refused("money.void_transaction", json!({ "txn_id": "ghost" })),
        "transaction_is_money"
    );
}

#[test]
fn the_members_name_for_a_line_is_theirs_and_clears_back_to_the_banks_words() {
    let money = Money::open("money-name");
    two_accounts(&money);
    money.twice(
        "money.set_display_name",
        json!({ "txn_id": "t2", "display_name": "  Costco " }),
    );
    assert_eq!(
        money.text("SELECT display_name || '|' || display_name_source FROM money_transaction WHERE txn_id = 't2'"),
        "Costco|member"
    );
    assert_eq!(
        money.text("SELECT description FROM core_transaction WHERE txn_id = 't2'"),
        "COSTCO WHSE #123",
        "the bank's words are never edited"
    );
    money.twice(
        "money.set_display_name",
        json!({ "txn_id": "t2", "display_name": null }),
    );
    assert_eq!(
        money.count("SELECT COUNT(*) FROM money_transaction WHERE display_name IS NOT NULL"),
        0
    );
    assert_eq!(
        money.refused(
            "money.set_display_name",
            json!({ "txn_id": "t2", "display_name": "   " })
        ),
        "name_is_not_blank"
    );
    assert_eq!(
        money.refused(
            "money.set_display_name",
            json!({ "txn_id": "ghost", "display_name": "x" })
        ),
        "transaction_is_money"
    );
}

#[test]
fn a_transfer_is_two_halves_of_one_movement_and_the_vault_refuses_the_rest() {
    let money = Money::open("money-transfer");
    two_accounts(&money);
    money.account("eur", "Euros", "checking", "EUR");
    money.import(
        "eur",
        vec![line(
            "e1",
            "ofx:E1",
            "2026-01-02",
            100_000,
            "credit",
            "FROM CAD",
        )],
    );
    // Same account, same direction, different currency, void, unknown.
    assert_eq!(
        money.refused(
            "money.link_transfer",
            json!({ "txn_id": "t1", "other_txn_id": "t2" })
        ),
        "different_accounts"
    );
    assert_eq!(
        money.refused(
            "money.link_transfer",
            json!({ "txn_id": "t1", "other_txn_id": "t1" })
        ),
        "two_different_transactions"
    );
    assert_eq!(
        money.refused(
            "money.link_transfer",
            json!({ "txn_id": "t1", "other_txn_id": "e1" })
        ),
        "same_currency"
    );
    assert_eq!(
        money.refused(
            "money.link_transfer",
            json!({ "txn_id": "t1", "other_txn_id": "ghost" })
        ),
        "both_are_money_transactions"
    );
    money.import(
        "a2",
        vec![line("s2", "ofx:S2", "2026-01-05", 5, "debit", "FEE")],
    );
    assert_eq!(
        money.refused(
            "money.link_transfer",
            json!({ "txn_id": "t1", "other_txn_id": "s2" })
        ),
        "opposite_directions"
    );
    money.run("money.void_transaction", json!({ "txn_id": "s2" }));
    money.import(
        "a2",
        vec![line("s3", "ofx:S3", "2026-01-05", 5, "credit", "REFUND")],
    );
    money.run("money.void_transaction", json!({ "txn_id": "s3" }));
    assert_eq!(
        money.refused(
            "money.link_transfer",
            json!({ "txn_id": "t1", "other_txn_id": "s3" })
        ),
        "neither_is_void"
    );

    // The accepted link: the debit is the `from` end whichever way the pair is given.
    let out = money.twice(
        "money.link_transfer",
        json!({ "txn_id": "s1", "other_txn_id": "t1" }),
    );
    assert_eq!(out["linked"], true);
    assert_eq!(
        money.text("SELECT from_id || '>' || to_id FROM core_link WHERE valid_to IS NULL"),
        "t1>s1"
    );
    let reversed = money.run(
        "money.link_transfer",
        json!({ "txn_id": "t1", "other_txn_id": "s1" }),
    );
    assert_eq!(
        reversed["linked"], false,
        "the same pair said again is not a second link"
    );
    assert_eq!(money.count("SELECT COUNT(*) FROM core_link"), 1);
    // Half of a transfer is not also half of another.
    money.import(
        "a2",
        vec![line(
            "s4",
            "ofx:S4",
            "2026-01-06",
            100_000,
            "credit",
            "AGAIN",
        )],
    );
    assert_eq!(
        money.refused(
            "money.link_transfer",
            json!({ "txn_id": "t1", "other_txn_id": "s4" })
        ),
        "not_in_another_transfer"
    );
    // Unlink ends it (history kept), twice is the same, and the pair can be relinked.
    let out = money.twice("money.unlink_transfer", json!({ "txn_id": "s1" }));
    assert_eq!(out["unlinked"], 1);
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_link WHERE valid_to IS NULL"),
        0
    );
    money.run(
        "money.link_transfer",
        json!({ "txn_id": "t1", "other_txn_id": "s4" }),
    );
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_link WHERE valid_to IS NULL"),
        1
    );
    assert_eq!(
        money.refused("money.unlink_transfer", json!({ "txn_id": "ghost" })),
        "transaction_exists"
    );
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

#[test]
fn a_plan_is_set_changed_carried_and_removed_and_none_of_it_is_a_figure() {
    let money = Money::open("money-target");
    let plan = |amount: Value| json!({ "month": "2026-02", "category_concept_id": GROCERIES, "amount_minor": amount });
    let out = money.twice("money.set_target", plan(json!(60_000)));
    assert_eq!(out["changed"], true);
    assert_eq!(
        money.text("SELECT amount_minor || currency || carry FROM money_target"),
        "60000USD0"
    );
    assert_eq!(
        money.refused(
            "money.set_carry",
            json!({ "month": "2026-03", "category_concept_id": GROCERIES, "carry": true })
        ),
        "target_exists"
    );
    money.twice(
        "money.set_carry",
        json!({ "month": "2026-02", "category_concept_id": GROCERIES, "carry": true }),
    );
    // Changing the amount keeps the carry unless told.
    money.twice("money.set_target", plan(json!(70_000)));
    assert_eq!(
        money.text("SELECT amount_minor || ':' || carry FROM money_target"),
        "70000:1"
    );
    money.twice(
        "money.set_target",
        json!({ "month": "2026-02", "category_concept_id": GROCERIES, "amount_minor": 70_000,
                "carry": false, "currency": "CAD" }),
    );
    assert_eq!(
        money.text("SELECT currency || ':' || carry FROM money_target"),
        "CAD:0"
    );
    // null removes it; removing what is not there is the same end state.
    money.twice("money.set_target", plan(Value::Null));
    assert_eq!(money.count("SELECT COUNT(*) FROM money_target"), 0);
    assert_eq!(
        money.refused(
            "money.set_target",
            json!({ "month": "2026-13", "category_concept_id": GROCERIES, "amount_minor": 1 })
        ),
        "month_is_real"
    );
    assert_eq!(
        money.refused(
            "money.set_target",
            json!({ "month": "2026-02", "category_concept_id": "nope", "amount_minor": 1 })
        ),
        "category_is_known"
    );
}

// ---------------------------------------------------------------------------
// Rules (seam S2)
// ---------------------------------------------------------------------------

#[test]
fn a_rule_is_refused_when_it_does_nothing_or_names_what_is_not_there() {
    let money = Money::open("money-rule-refusals");
    two_accounts(&money);
    let base = |extra: Value| {
        let mut rule = json!({ "rule_id": "r1", "match_kind": "contains", "pattern": "costco" });
        for (key, value) in extra.as_object().unwrap() {
            rule[key] = value.clone();
        }
        rule
    };
    assert_eq!(
        money.refused("money.add_rule", base(json!({}))),
        "rule_is_sound",
        "no action"
    );
    assert_eq!(
        money.refused("money.add_rule", base(json!({ "set_category_concept_id": GROCERIES, "amount_min_minor": 5, "amount_max_minor": 4 }))),
        "rule_is_sound"
    );
    assert_eq!(
        money.refused(
            "money.add_rule",
            base(json!({ "set_category_concept_id": "nope" }))
        ),
        "rule_is_sound"
    );
    assert_eq!(
        money.refused(
            "money.add_rule",
            base(json!({ "set_display_name": "Costco", "account_id": "ghost" }))
        ),
        "rule_is_sound"
    );
    let out = money.run(
        "money.add_rule",
        base(json!({ "set_category_concept_id": GROCERIES })),
    );
    assert_eq!(out["position"], 0);
    // Once: the minted id re-offered is refused, and nothing changes.
    assert_eq!(
        money.refused(
            "money.add_rule",
            base(json!({ "set_category_concept_id": FUEL }))
        ),
        "rule_id_free"
    );
    // A rule is an entity.
    assert_eq!(
        money.count(
            "SELECT COUNT(*) FROM core_entity WHERE entity_id = 'r1' AND entity_type = 'money.rule'"
        ),
        1
    );
    // An edit may clear a field with null but not leave the rule empty.
    money.run(
        "money.edit_rule",
        json!({ "rule_id": "r1", "set_display_name": "Costco" }),
    );
    money.twice(
        "money.edit_rule",
        json!({ "rule_id": "r1", "set_category_concept_id": null }),
    );
    assert_eq!(
        money.refused(
            "money.edit_rule",
            json!({ "rule_id": "r1", "set_display_name": null })
        ),
        "rule_is_sound"
    );
    assert_eq!(
        money.refused(
            "money.edit_rule",
            json!({ "rule_id": "ghost", "pattern": "x" })
        ),
        "rule_exists"
    );
    let out = money.twice("money.delete_rule", json!({ "rule_id": "r1" }));
    assert_eq!(out["deleted"], true);
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_entity WHERE entity_id = 'r1'"),
        0
    );
}

/// A fixture for the seam: the same lines and rules the app crate's own matcher
/// is run against (wave 3).
fn history_fixture(money: &Money) {
    money.account("a1", "Everyday", "checking", "USD");
    money.account("a2", "Card", "credit_card", "USD");
    money.import(
        "a1",
        vec![
            line(
                "h1",
                "ofx:H1",
                "2026-01-02",
                12_000,
                "debit",
                "  costco   whse #123 ",
            ),
            line(
                "h2",
                "ofx:H2",
                "2026-01-03",
                6_500,
                "debit",
                "COSTCO GAS #123",
            ),
            line("h3", "ofx:H3", "2026-01-04", 300, "debit", "Costco"),
            line("h4", "ofx:H4", "2026-01-05", 900, "debit", "SHELL OIL 5512"),
            line("h5", "ofx:H5", "2026-01-06", 100, "credit", "interest"),
        ],
    );
    money.import(
        "a2",
        vec![line(
            "c1",
            "ofx:C1",
            "2026-01-02",
            12_000,
            "debit",
            "COSTCO WHSE #9",
        )],
    );
    // 1: contains COSTCO -> groceries (specificity 1).
    // 2: matches COSTCO GAS* -> fuel + "Costco Gas" (specificity 2).
    // 3: is COSTCO -> dining + name "Costco" (specificity 3).
    // 4: contains COSTCO on the card, >= 10000 -> "Bulk" (specificity 3, position decides ties).
    money.run("money.add_rule", json!({ "rule_id": "r1", "match_kind": "contains", "pattern": "costco", "set_category_concept_id": GROCERIES }));
    money.run("money.add_rule", json!({ "rule_id": "r2", "match_kind": "matches", "pattern": "costco gas*", "set_category_concept_id": FUEL, "set_display_name": "Costco Gas" }));
    money.run("money.add_rule", json!({ "rule_id": "r3", "match_kind": "is", "pattern": "COSTCO", "set_category_concept_id": DINING, "set_display_name": "Costco" }));
    money.run("money.add_rule", json!({ "rule_id": "r4", "match_kind": "contains", "pattern": "costco", "account_id": "a2", "amount_min_minor": 10_000, "set_display_name": "Bulk" }));
}

fn cat_and_name(money: &Money, txn: &str) -> String {
    money.text(&format!(
        "SELECT COALESCE(t.category_concept_id, '-') || '|' || COALESCE(m.display_name, '-')
           FROM core_transaction t LEFT JOIN money_transaction m ON m.txn_id = t.txn_id
          WHERE t.txn_id = '{txn}'"
    ))
}

#[test]
fn applying_the_rules_to_history_follows_the_seam_the_last_rule_to_set_a_field_wins() {
    let money = Money::open("money-rule-history");
    history_fixture(&money);
    let out = money.twice("money.apply_rule_to_history", json!({}));
    // h1: only r1 matches -> groceries, no name.  h2: r1 then r2 (wildcard)
    // -> fuel + "Costco Gas".  h3: r1, r3 -> dining + "Costco" (is beats contains).
    // h4, h5: nothing.  c1: r1, then r4 (specificity 3, name only) -> groceries + "Bulk".
    assert_eq!(cat_and_name(&money, "h1"), format!("{GROCERIES}|-"));
    assert_eq!(cat_and_name(&money, "h2"), format!("{FUEL}|Costco Gas"));
    assert_eq!(cat_and_name(&money, "h3"), format!("{DINING}|Costco"));
    assert_eq!(cat_and_name(&money, "h4"), "-|-");
    assert_eq!(cat_and_name(&money, "h5"), "-|-");
    assert_eq!(cat_and_name(&money, "c1"), format!("{GROCERIES}|Bulk"));
    assert_eq!(out["matched"], 4);
    assert_eq!(out["recategorised"], 4);
    assert_eq!(out["renamed"], 3);
    // h1 matched only a rule that sets no name, so it has none; c1's name is a rule's.
    assert_eq!(
        money.count(
            "SELECT COUNT(*) FROM money_transaction WHERE txn_id = 'h1' AND display_name IS NULL"
        ),
        1
    );
    assert_eq!(
        money.text("SELECT display_name_source FROM money_transaction WHERE txn_id = 'c1'"),
        "rule"
    );
}

#[test]
fn the_history_pass_leaves_the_members_own_choices_unless_asked() {
    let money = Money::open("money-rule-overwrite");
    history_fixture(&money);
    money.run(
        "money.categorize",
        json!({ "txn_ids": ["h1"], "category_concept_id": FUEL }),
    );
    money.run(
        "money.set_display_name",
        json!({ "txn_id": "h3", "display_name": "My Costco" }),
    );
    let out = money.twice("money.apply_rule_to_history", json!({}));
    assert_eq!(
        cat_and_name(&money, "h1"),
        format!("{FUEL}|-"),
        "a chosen category stays"
    );
    assert_eq!(
        cat_and_name(&money, "h3"),
        format!("{DINING}|My Costco"),
        "a chosen name stays"
    );
    assert_eq!(out["recategorised"], 3);
    // With `overwrite` the rules win, and a second pass still changes nothing.
    money.twice("money.apply_rule_to_history", json!({ "overwrite": true }));
    assert_eq!(cat_and_name(&money, "h1"), format!("{GROCERIES}|-"));
    assert_eq!(cat_and_name(&money, "h3"), format!("{DINING}|Costco"));
}

#[test]
fn naming_a_rule_limits_the_pass_to_the_lines_that_rule_matches() {
    let money = Money::open("money-rule-named");
    history_fixture(&money);
    let out = money.twice("money.apply_rule_to_history", json!({ "rule_id": "r2" }));
    // Only h2 matches r2 (the wildcard); the full rule set decides what it becomes.
    assert_eq!(out["matched"], 1);
    assert_eq!(cat_and_name(&money, "h2"), format!("{FUEL}|Costco Gas"));
    assert_eq!(cat_and_name(&money, "h1"), "-|-");
    assert_eq!(
        money.refused("money.apply_rule_to_history", json!({ "rule_id": "ghost" })),
        "rule_exists"
    );
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

#[test]
fn a_category_is_added_under_a_group_and_archived_without_losing_a_line() {
    let money = Money::open("money-category");
    let out = money.run(
        "money.add_category",
        json!({ "category_id": "cat-pets", "name": "Pets", "parent_concept_id": FOOD }),
    );
    assert_eq!(out["category_id"], "cat-pets");
    assert_eq!(
        money.text("SELECT notation || '|' || broader_concept_id FROM core_concept WHERE concept_id = 'cat-pets'"),
        format!("custom.cat-pets|{FOOD}")
    );
    // Once: the minted id re-offered is refused.
    assert_eq!(
        money.refused(
            "money.add_category",
            json!({ "category_id": "cat-pets", "name": "Pets 2" })
        ),
        "category_id_free"
    );
    assert_eq!(
        money.refused(
            "money.add_category",
            json!({ "category_id": "c2", "name": " pets ", "parent_concept_id": FOOD })
        ),
        "name_is_free_among_siblings"
    );
    // Two levels: not under another category.
    assert_eq!(
        money.refused(
            "money.add_category",
            json!({ "category_id": "c3", "name": "Deep", "parent_concept_id": GROCERIES })
        ),
        "parent_is_a_group"
    );
    assert_eq!(
        money.refused(
            "money.add_category",
            json!({ "category_id": "c4", "name": "Lost", "parent_concept_id": "nope" })
        ),
        "parent_is_a_group"
    );
    // A new top-level group is allowed.
    money.run(
        "money.add_category",
        json!({ "category_id": "grp", "name": "Kids" }),
    );

    let archived = money.twice(
        "money.archive_category",
        json!({ "concept_id": "cat-pets", "archived": true }),
    );
    assert_eq!(archived["changed"], true);
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_tag WHERE target_type = 'core.concept' AND target_id = 'cat-pets'"),
        1
    );
    money.twice(
        "money.archive_category",
        json!({ "concept_id": "cat-pets", "archived": false }),
    );
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_tag WHERE target_type = 'core.concept' AND target_id = 'cat-pets'"),
        0
    );
    assert_eq!(
        money.refused(
            "money.archive_category",
            json!({ "concept_id": "nope", "archived": true })
        ),
        "category_exists"
    );
}

#[test]
fn merging_a_category_rewrites_every_reference_in_one_commit_and_removes_it() {
    let money = Money::open("money-merge");
    two_accounts(&money);
    money.run(
        "money.add_category",
        json!({ "category_id": "cat-bulk", "name": "Bulk", "parent_concept_id": FOOD }),
    );
    money.run(
        "money.categorize",
        json!({ "txn_ids": ["t2", "t3"], "category_concept_id": "cat-bulk" }),
    );
    money.run("money.add_rule", json!({ "rule_id": "r1", "match_kind": "contains", "pattern": "costco", "set_category_concept_id": "cat-bulk" }));
    for (month, category, amount) in [
        ("2026-01", "cat-bulk", 10_000),
        ("2026-02", "cat-bulk", 5_000),
        ("2026-01", GROCERIES, 60_000),
    ] {
        money.run(
            "money.set_target",
            json!({ "month": month, "category_concept_id": category, "amount_minor": amount }),
        );
    }
    money.run(
        "money.set_carry",
        json!({ "month": "2026-01", "category_concept_id": "cat-bulk", "carry": true }),
    );
    money.run(
        "money.archive_category",
        json!({ "concept_id": "cat-bulk", "archived": true }),
    );

    let out = money.run(
        "money.merge_category",
        json!({ "from_concept_id": "cat-bulk", "into_concept_id": GROCERIES }),
    );
    assert_eq!(out["transactions"], 2);
    assert_eq!(out["rules"], 1);
    assert_eq!(out["targets"], 2);
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_transaction WHERE category_concept_id = 'cat-bulk'"),
        0
    );
    assert_eq!(
        money.count(&format!(
            "SELECT COUNT(*) FROM core_transaction WHERE category_concept_id = '{GROCERIES}'"
        )),
        2
    );
    assert_eq!(
        money.text("SELECT set_category_concept_id FROM money_rule WHERE rule_id = 'r1'"),
        GROCERIES
    );
    // The two January plans add up and keep the carry; the February plan moved.
    assert_eq!(
        money.text(&format!("SELECT amount_minor || ':' || carry FROM money_target WHERE month = '2026-01' AND category_concept_id = '{GROCERIES}'")),
        "70000:1"
    );
    assert_eq!(
        money.text(&format!("SELECT amount_minor || '' FROM money_target WHERE month = '2026-02' AND category_concept_id = '{GROCERIES}'")),
        "5000"
    );
    assert_eq!(
        money.count("SELECT COUNT(*) FROM money_target WHERE category_concept_id = 'cat-bulk'"),
        0
    );
    // The category and its archive mark are gone; the lines are all still there.
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_concept WHERE concept_id = 'cat-bulk'"),
        0
    );
    assert_eq!(
        money.count("SELECT COUNT(*) FROM core_tag WHERE target_id = 'cat-bulk'"),
        0
    );
    assert_eq!(money.count("SELECT COUNT(*) FROM core_transaction"), 4);
    // Merging again: the source is gone, so it is a refusal and changes nothing.
    assert_eq!(
        money.refused(
            "money.merge_category",
            json!({ "from_concept_id": "cat-bulk", "into_concept_id": GROCERIES })
        ),
        "both_are_categories"
    );
    assert_eq!(
        money.refused(
            "money.merge_category",
            json!({ "from_concept_id": GROCERIES, "into_concept_id": GROCERIES })
        ),
        "two_different_categories"
    );
    assert_eq!(
        money.refused(
            "money.merge_category",
            json!({ "from_concept_id": FOOD, "into_concept_id": FUEL })
        ),
        "merged_category_has_no_children"
    );
}

// ---------------------------------------------------------------------------
// The schema backs the commands
// ---------------------------------------------------------------------------

#[test]
fn a_bypassed_command_still_cannot_break_the_ledger() {
    let money = Money::open("money-bypass");
    money.account("eur", "Euros", "checking", "EUR");
    money.import(
        "eur",
        vec![line("e1", "ofx:E1", "2026-01-02", 100, "debit", "X")],
    );
    let raw = |sql: &str| {
        money
            .vault()
            .commit(|tx| {
                tx.set_producer("test.bypass");
                tx.connection().execute_batch(sql)?;
                Ok(())
            })
            .map(|_| ())
    };
    assert!(raw("UPDATE core_transaction SET currency = 'USD' WHERE txn_id = 'e1'").is_err());
    assert!(raw("UPDATE core_transaction SET amount_minor = 5 WHERE txn_id = 'e1'").is_err());
    assert!(raw("UPDATE core_transaction SET description = 'edited' WHERE txn_id = 'e1'").is_err());
    raw("UPDATE core_transaction SET status = 'void' WHERE txn_id = 'e1'")
        .expect("void is allowed");
    assert!(raw("UPDATE core_transaction SET status = 'posted' WHERE txn_id = 'e1'").is_err());
    assert_eq!(money.count("SELECT COUNT(*) FROM core_transaction"), 1);
}
