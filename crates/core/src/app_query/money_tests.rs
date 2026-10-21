//! Money's arm, its import plan and Home's tile, through `Handle::call` — the
//! door a shell uses — over a ledger written by the real Money commands
//! (#1099, #1135).
//!
//! What each test holds:
//!
//! 1. **The ten answers read a real ledger** and say what the crate's folds say,
//!    with the exponent on every amount.
//! 2. **The plan and the command are one path**: a CSV is planned, its
//!    `publish_input` is sent as the ordinary command, and planning the same file
//!    again finds every row already in and offers nothing to publish.
//! 3. **An OFX statement finds its account by the full ACCTID** the member
//!    stored (`external_ref`), and one that matches nothing is a sentence.
//! 4. **The 19 statements the Money crate declares are served by the core's own
//!    door** — each one is observed being asked, not assumed.
//! 5. **Refusals are values or typed errors**, and the bytes of a statement
//!    appear nowhere in an answer.

use std::cell::RefCell;
use std::collections::BTreeSet;

use super::*;
use crate::config::CoreConfig;
use crate::handle::{Core, Handle};
use centraid_apps_kit::page::Page;
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::Row;
use centraid_apps_kit::statement::PageQuery;
use prost::Message as _;
use serde_json::json;
use wire::app_query_request::Query as Q;

/// 15:00Z on 10 February 2024 is the 10th in Toronto too.
const NOW: &str = "2024-02-10T15:00:00.000Z";
const TZ: &str = "America/Toronto";
const GROCERIES: &str = "category:food.groceries";
const DINING: &str = "category:food.dining";

struct Scratch {
    dir: std::path::PathBuf,
    handle: Handle,
    writes: std::cell::Cell<u32>,
}

impl Scratch {
    fn founded() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let now = centraid_vault::time::recurrence::parse_instant_ms(NOW).expect("an instant");
        let config = CoreConfig::new(dir.join("vault.db")).with_clock(
            std::sync::Arc::new(centraid_vault::clock::FixedClock::at(now)),
            std::sync::Arc::new(centraid_vault::clock::ClockIds::new(Box::new(
                centraid_vault::clock::FixedClock::at(now),
            ))),
        );
        let handle = Core::open(config).expect("it opens");
        handle
            .with_vault(|vault| Ok(vault.found("Money", "Owner")?))
            .expect("it founds");
        Self {
            dir,
            handle,
            writes: std::cell::Cell::new(0),
        }
    }

    fn ask(&self, query: Q) -> Answer {
        match self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                    query: Some(query),
                })),
            })
            .expect("the query answers")
            .kind
        {
            Some(wire::response::Kind::AppQuery(answer)) => {
                answer.answer.expect("an app query is answered")
            }
            other => panic!("an app query answered as {other:?}"),
        }
    }

    fn try_money(&self, kind: wire::money_request::Kind) -> Result<wire::MoneyResponse> {
        match self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Money(wire::MoneyRequest {
                    kind: Some(kind),
                })),
            })?
            .kind
        {
            Some(wire::response::Kind::Money(answer)) => Ok(answer),
            other => panic!("a money request answered as {other:?}"),
        }
    }

    fn plan(&self, asked: wire::MoneyImportPlanRequest) -> wire::MoneyImportPlan {
        match self
            .try_money(wire::money_request::Kind::ImportPlan(asked))
            .expect("the plan answers")
            .kind
        {
            Some(wire::money_response::Kind::ImportPlan(plan)) => plan,
            other => panic!("a plan answered as {other:?}"),
        }
    }

    fn tile(&self) -> wire::MoneyHomeTile {
        match self
            .try_money(wire::money_request::Kind::HomeTile(
                wire::MoneyHomeTileRequest { tz: TZ.to_owned() },
            ))
            .expect("the tile answers")
            .kind
        {
            Some(wire::money_response::Kind::HomeTile(tile)) => tile,
            other => panic!("a tile answered as {other:?}"),
        }
    }

    fn try_run(&self, name: &str, input: serde_json::Value) -> Result<serde_json::Value> {
        self.writes.set(self.writes.get() + 1);
        self.run_bytes(name, serde_json::to_vec(&input).expect("json"))
    }

    fn run_bytes(&self, name: &str, input: Vec<u8>) -> Result<serde_json::Value> {
        self.writes.set(self.writes.get() + 1);
        let response = self.handle.call(&wire::Request {
            kind: Some(wire::request::Kind::Command(wire::Command {
                name: name.to_owned(),
                input,
                invoke_key: format!("money-query-test-{}", self.writes.get()),
                ..wire::Command::default()
            })),
        })?;
        let Some(wire::response::Kind::Command(outcome)) = response.kind else {
            panic!("a command answered with something else");
        };
        assert_eq!(
            outcome.status,
            wire::CommandStatus::Executed as i32,
            "{name}: {}",
            outcome.reason
        );
        Ok(serde_json::from_slice(&outcome.output).expect("the output is JSON"))
    }

    fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        self.try_run(name, input)
            .unwrap_or_else(|error| panic!("{name} refused: {error}"))
    }

    fn account(&self, id: &str, name: &str, kind: &str, currency: &str, reference: Option<&str>) {
        let mut input = json!({
            "id": id, "title": name, "type": kind, "currency": currency,
        });
        if let Some(reference) = reference {
            input["external_ref"] = json!(reference);
        }
        self.run("account.add", input);
    }

    fn csv(&self, account: &str, text: &str) -> wire::MoneyImportPlan {
        self.plan(wire::MoneyImportPlanRequest {
            tz: TZ.to_owned(),
            source: wire::MoneySource::Csv as i32,
            content: text.as_bytes().to_vec(),
            account_id: Some(account.to_owned()),
            ..wire::MoneyImportPlanRequest::default()
        })
    }

    /// Plan a CSV and publish its new rows through the ordinary command.
    fn import_csv(&self, account: &str, text: &str) -> wire::MoneyStatementPlan {
        let plan = self.csv(account, text);
        let statement = plan.statements.into_iter().next().expect("a statement");
        assert!(
            !statement.publish_input.is_empty(),
            "nothing new to publish"
        );
        let out = self
            .run_bytes("follow.statement", statement.publish_input.clone())
            .expect("the import runs");
        assert!(
            out["added"].as_u64() > Some(0) && out["refused"] == 0 && out["matched"] == 0,
            "{out}"
        );
        statement
    }

    fn spending(&self, month: &str) -> wire::MoneySpending {
        match self.ask(Q::MoneySpending(wire::MoneySpendingRequest {
            tz: TZ.to_owned(),
            month: month.to_owned(),
        })) {
            Answer::MoneySpending(answer) => answer,
            other => panic!("spending answered as {other:?}"),
        }
    }

    fn activity(&self, request: wire::MoneyActivityRequest) -> wire::MoneyActivity {
        match self.ask(Q::MoneyActivity(request)) {
            Answer::MoneyActivity(answer) => answer,
            other => panic!("activity answered as {other:?}"),
        }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

const CHECKING: &str = "Date,Description,Amount\n\
2023-12-05,NETFLIX.COM,-15.49\n\
2024-01-03,STARBUCKS #123,-5.75\n\
2024-01-05,NETFLIX.COM,-15.49\n\
2024-01-15,PAYROLL ACME,2500.00\n\
2024-01-20,WHOLE FOODS,-82.10\n\
2024-02-05,NETFLIX.COM,-15.49\n\
2024-02-03,WHOLE FOODS,-61.00\n\
2024-02-07,STARBUCKS #124,-6.10\n\
2024-02-08,TRANSFER TO SAVINGS,-500.00\n";

// Two negative lines keep a signed column's majority sign unambiguous.
const SAVINGS: &str = "Date,Description,Amount\n\
2024-01-15,MONTHLY FEE,-1.00\n\
2024-01-31,MONTHLY FEE,-1.00\n\
2024-02-08,TRANSFER FROM CHECKING,500.00\n";

/// The ledger every reading test shares: two USD accounts, nine rows and three.
fn ledger() -> Scratch {
    let scratch = Scratch::founded();
    scratch.account("chq", "Everyday", "checking", "USD", None);
    scratch.account("sav", "Rainy day", "savings", "USD", None);
    scratch.import_csv("chq", CHECKING);
    scratch.import_csv("sav", SAVINGS);
    scratch
}

fn minor(amount: &Option<wire::MoneyAmount>) -> i64 {
    amount.as_ref().expect("an amount").minor
}

// ---------------------------------------------------------------------------
// 1. The ten answers.
// ---------------------------------------------------------------------------

#[test]
fn spending_says_the_month_in_figures_with_their_exponent() {
    let scratch = ledger();
    // An empty month is the month today falls in: February.
    let february = scratch.spending("");
    assert_eq!(february.month, "2024-02");
    assert_eq!(february.today, "2024-02-10");
    assert_eq!(february.days_in_month, 29);
    assert!(!february.empty);
    assert_eq!(february.per_currency.len(), 1, "one currency, one hero");
    let hero = &february.per_currency[0];
    let spent = hero.spent.as_ref().expect("spent");
    // 15.49 + 61.00 + 6.10 + the 500.00 transfer left out of spending until it
    // is accepted: the transfer is still a debit here.
    assert_eq!(spent.currency, "USD");
    assert_eq!(spent.exponent, 2);
    assert_eq!(spent.minor, 1549 + 6100 + 610 + 50_000);
    assert_eq!(
        scratch.spending("2024-01").per_currency[0]
            .spent
            .as_ref()
            .map(|s| s.minor),
        Some(575 + 1549 + 8210 + 200)
    );
}

#[test]
fn activity_pages_a_month_with_a_cursor_and_filters() {
    let scratch = ledger();
    let first = scratch.activity(wire::MoneyActivityRequest {
        tz: TZ.to_owned(),
        month: "2024-02".to_owned(),
        limit: 3,
        ..wire::MoneyActivityRequest::default()
    });
    assert_eq!(first.rows.len(), 3);
    let next = first.next.clone().expect("more rows follow");
    // Newest first.
    assert!(first.rows[0].posted_on >= first.rows[1].posted_on);
    let second = scratch.activity(wire::MoneyActivityRequest {
        tz: TZ.to_owned(),
        month: "2024-02".to_owned(),
        limit: 3,
        after: Some(next),
        ..wire::MoneyActivityRequest::default()
    });
    // Five rows in February (four on the checking account, one on savings).
    assert_eq!(first.rows.len() + second.rows.len(), 5);
    assert!(second.next.is_none(), "the last page has no cursor");

    let only = scratch.activity(wire::MoneyActivityRequest {
        tz: TZ.to_owned(),
        month: "2024-02".to_owned(),
        limit: 50,
        account_id: Some("sav".to_owned()),
        ..wire::MoneyActivityRequest::default()
    });
    assert_eq!(only.rows.len(), 1);
    assert_eq!(only.rows[0].account_label, "Rainy day");
    assert_eq!(only.rows[0].amount.as_ref().map(|a| a.minor), Some(50_000));
    assert!(
        only.rows[0]
            .flags
            .contains(&(wire::MoneyFlag::Uncategorised as i32))
    );

    // Filing a row moves it out of "needs a category".
    let grocery = first
        .rows
        .iter()
        .chain(&second.rows)
        .find(|row| row.raw == "WHOLE FOODS")
        .expect("the grocery row")
        .txn_id
        .clone();
    scratch.run(
        "txn.categorize",
        json!({ "ids": [grocery], "category_id": GROCERIES }),
    );
    let filed = scratch.activity(wire::MoneyActivityRequest {
        tz: TZ.to_owned(),
        month: "2024-02".to_owned(),
        limit: 50,
        category_filter: wire::MoneyCategoryFilter::Is as i32,
        category_id: GROCERIES.to_owned(),
        ..wire::MoneyActivityRequest::default()
    });
    assert_eq!(filed.rows.len(), 1);
    assert_eq!(filed.rows[0].category_label.as_deref(), Some("Groceries"));
}

#[test]
fn one_transaction_with_its_proposals_and_a_missing_one_is_not_found() {
    let scratch = ledger();
    let rows = scratch
        .activity(wire::MoneyActivityRequest {
            tz: TZ.to_owned(),
            month: "2024-02".to_owned(),
            limit: 50,
            ..wire::MoneyActivityRequest::default()
        })
        .rows;
    let outgoing = rows
        .iter()
        .find(|row| row.raw == "TRANSFER TO SAVINGS")
        .expect("the outgoing half")
        .txn_id
        .clone();
    let detail = match scratch.ask(Q::MoneyTransaction(wire::MoneyTransactionRequest {
        tz: TZ.to_owned(),
        txn_id: outgoing.clone(),
    })) {
        Answer::MoneyTransaction(t) => t,
        other => panic!("{other:?}"),
    };
    assert!(detail.found);
    assert_eq!(detail.raw, "TRANSFER TO SAVINGS");
    assert_eq!(detail.amount.as_ref().map(|a| a.minor), Some(-50_000));
    assert_eq!(detail.imported_from.as_deref(), Some("csv"));
    // The app PROPOSES the other half; nothing is linked until the member says.
    let offer = detail.transfer_proposal.expect("a transfer is proposed");
    assert_eq!(offer.other_account_label, "Rainy day");
    assert!(detail.transferred_with.is_none());

    scratch.run(
        "txn.link_transfer",
        json!({ "id": outgoing, "other_id": offer.other_txn_id }),
    );
    let linked = match scratch.ask(Q::MoneyTransaction(wire::MoneyTransactionRequest {
        tz: TZ.to_owned(),
        txn_id: outgoing,
    })) {
        Answer::MoneyTransaction(t) => t,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        linked.transferred_with.as_deref(),
        Some(offer.other_txn_id.as_str())
    );
    assert!(linked.transfer_proposal.is_none());
    // And the transfer leaves spending.
    let february = scratch.spending("2024-02");
    assert_eq!(
        minor(&february.per_currency[0].spent),
        1549 + 6100 + 610,
        "an accepted transfer is not spending"
    );

    let missing = match scratch.ask(Q::MoneyTransaction(wire::MoneyTransactionRequest {
        tz: TZ.to_owned(),
        txn_id: "nope".to_owned(),
    })) {
        Answer::MoneyTransaction(t) => t,
        other => panic!("{other:?}"),
    };
    assert!(!missing.found);
}

#[test]
fn cashflow_accounts_rules_categories_targets_recurring_and_search() {
    let scratch = ledger();

    let flow = match scratch.ask(Q::MoneyCashflow(wire::MoneyCashflowRequest {
        tz: TZ.to_owned(),
        through: String::new(),
    })) {
        Answer::MoneyCashflow(flow) => flow,
        other => panic!("{other:?}"),
    };
    assert_eq!(flow.through, "2024-02");
    assert_eq!(flow.series.len(), 1);
    assert_eq!(flow.series[0].months.len(), 12);
    let january = flow.series[0]
        .months
        .iter()
        .find(|m| m.month == "2024-01")
        .expect("january");
    assert_eq!(minor(&january.incoming), 250_000);
    assert_eq!(minor(&january.outgoing), 575 + 1549 + 8210 + 200);

    // Accounts: a derived balance per account, never a stored one.
    let accounts = match scratch.ask(Q::MoneyAccounts(wire::MoneyAccountsRequest {
        tz: TZ.to_owned(),
    })) {
        Answer::MoneyAccounts(accounts) => accounts,
        other => panic!("{other:?}"),
    };
    let everyday = accounts
        .on_budget
        .iter()
        .find(|a| a.account_id == "chq")
        .expect("the checking account");
    assert_eq!(
        minor(&everyday.balance),
        250_000 - (1549 + 575 + 1549 + 8210 + 1549 + 6100 + 610 + 50_000)
    );
    assert_eq!(accounts.net_worth.len(), 1, "one currency, one net worth");

    // A rule, then the screens that read it.
    scratch.run(
        "rule.add",
        json!({ "id": "r1", "match": "contains", "text": "starbucks", "category_id": DINING }),
    );
    let rules = match scratch.ask(Q::MoneyRules(wire::MoneyRulesRequest {})) {
        Answer::MoneyRules(rules) => rules,
        other => panic!("{other:?}"),
    };
    assert_eq!(rules.rules.len(), 1);
    assert_eq!(rules.rules[0].kind, wire::MoneyMatchKind::Contains as i32);
    assert_eq!(rules.rules[0].category_label.as_deref(), Some("Dining out"));
    assert_eq!(rules.limit, 500);

    let categories = match scratch.ask(Q::MoneyCategories(wire::MoneyCategoriesRequest {})) {
        Answer::MoneyCategories(categories) => categories,
        other => panic!("{other:?}"),
    };
    assert!(
        categories
            .groups
            .iter()
            .flat_map(|g| &g.categories)
            .any(|c| c.category_id == GROCERIES && !c.archived)
    );

    // A target and its sheet.
    scratch.run(
        "budget.set",
        json!({ "month": "2024-02", "category_id": GROCERIES,
                "amount_minor": 40_000, "currency": "USD", "carry": false }),
    );
    let sheet = match scratch.ask(Q::MoneyTargetSheet(wire::MoneyTargetSheetRequest {
        tz: TZ.to_owned(),
        month: "2024-02".to_owned(),
        category_id: GROCERIES.to_owned(),
        currency: "usd".to_owned(),
        typing_amount_minor: None,
        typing_carry: false,
    })) {
        Answer::MoneyTargetSheet(sheet) => sheet,
        other => panic!("{other:?}"),
    };
    assert_eq!(sheet.currency, "USD");
    assert_eq!(minor(&sheet.amount), 40_000);
    assert_eq!(sheet.spent.as_ref().map(|s| s.exponent), Some(2));

    // Netflix is three months of the same charge.
    let recurring = match scratch.ask(Q::MoneyRecurring(wire::MoneyRecurringRequest {
        tz: TZ.to_owned(),
    })) {
        Answer::MoneyRecurring(recurring) => recurring,
        other => panic!("{other:?}"),
    };
    let netflix = recurring
        .series
        .iter()
        .find(|line| line.merchant.to_ascii_lowercase().contains("netflix"))
        .expect("netflix recurs");
    assert_eq!(netflix.cadence, wire::MoneyCadence::Monthly as i32);
    assert_eq!(netflix.seen_times, 3);
    assert_eq!(netflix.amount.as_ref().map(|a| a.minor), Some(1549));

    let search = match scratch.ask(Q::MoneySearch(wire::MoneySearchRequest {
        tz: TZ.to_owned(),
        month: String::new(),
        term: "netflix".to_owned(),
        limit: 10,
    })) {
        Answer::MoneySearch(search) => search,
        other => panic!("{other:?}"),
    };
    assert_eq!(search.total_matches, 3);
    assert_eq!(search.rows.len(), 3);
    assert!(search.months_walked > 0);

    // The tile is this month's spending, per currency.
    let tile = scratch.tile();
    assert_eq!(tile.month, "2024-02");
    assert!(!tile.empty);
    assert_eq!(tile.spent.len(), 1);
    assert_eq!(tile.spent[0].currency, "USD");
}

// ---------------------------------------------------------------------------
// 2. The plan and the command are one path.
// ---------------------------------------------------------------------------

#[test]
fn a_plan_publishes_through_the_command_and_a_replan_offers_nothing() {
    let scratch = Scratch::founded();
    scratch.account("chq", "Everyday", "checking", "USD", None);

    let plan = scratch.csv("chq", CHECKING);
    assert!(plan.refusal.is_none());
    let statement = &plan.statements[0];
    assert_eq!(statement.new, 9);
    assert_eq!(statement.already_in, 0);
    assert_eq!(statement.rows.len(), 9);
    assert_eq!(statement.first_day.as_deref(), Some("2023-12-05"));
    assert_eq!(minor(&statement.new_in), 250_000);
    assert!(!statement.publish_input.is_empty());
    // Nothing is written by planning.
    let before = scratch.activity(wire::MoneyActivityRequest {
        tz: TZ.to_owned(),
        month: "2024-02".to_owned(),
        limit: 50,
        ..wire::MoneyActivityRequest::default()
    });
    assert!(before.rows.is_empty());

    let out = scratch
        .run_bytes("follow.statement", statement.publish_input.clone())
        .expect("the import runs");
    assert_eq!(out["added"], 9);

    // The same file again: every row is already in; there is nothing to publish.
    let again = scratch.csv("chq", CHECKING);
    let statement = &again.statements[0];
    assert_eq!(statement.new, 0);
    assert_eq!(statement.already_in, 9);
    assert!(statement.publish_input.is_empty());
    assert!(statement.publish_input_with_proposed.is_empty());
    // And the layout the plan detected is offered for saving.
    assert!(statement.profile_to_save.is_some());

    // An overlapping file imports only its new line.
    let overlap = format!("{CHECKING}2024-02-09,WHOLE FOODS,-20.00\n");
    let plan = scratch.csv("chq", &overlap);
    assert_eq!(plan.statements[0].new, 1);
    assert_eq!(plan.statements[0].already_in, 9);
    let reviewed = plan.statements[0]
        .rows
        .iter()
        .find(|row| row.verdict == wire::MoneyImportVerdict::New as i32)
        .expect("one new row");
    assert_eq!(reviewed.description.as_deref(), Some("WHOLE FOODS"));
    assert_eq!(reviewed.amount.as_ref().map(|a| a.minor), Some(-2000));
}

#[test]
fn a_date_the_file_cannot_decide_is_a_question_and_its_answer_reads_the_file() {
    let scratch = Scratch::founded();
    scratch.account("chq", "Everyday", "checking", "USD", None);
    let text = "Date,Description,Amount\n03/04/2024,COFFEE,-3.00\n05/06/2024,BAGEL,-4.00\n";
    let asked = scratch.csv("chq", text);
    let statement = &asked.statements[0];
    let question = statement.question.as_ref().expect("the file asks");
    assert!(!question.samples.is_empty());
    assert!(
        statement.rows.is_empty(),
        "no rows while the question stands"
    );
    assert!(statement.publish_input.is_empty());

    let answered = scratch.plan(wire::MoneyImportPlanRequest {
        tz: TZ.to_owned(),
        source: wire::MoneySource::Csv as i32,
        content: text.as_bytes().to_vec(),
        account_id: Some("chq".to_owned()),
        date_order: wire::MoneyDateOrder::Dmy as i32,
        ..wire::MoneyImportPlanRequest::default()
    });
    let statement = &answered.statements[0];
    assert!(statement.question.is_none());
    assert_eq!(statement.new, 2);
    assert_eq!(statement.first_day.as_deref(), Some("2024-04-03"));
}

// ---------------------------------------------------------------------------
// 3. OFX finds its account by the full ACCTID.
// ---------------------------------------------------------------------------

const OFX: &str = include_str!("../../../apps/money/tests/corpus/ofx2.ofx");
const MULTI: &str = include_str!("../../../apps/money/tests/corpus/multi_account.ofx");

fn ofx(content: &str, account: Option<&str>) -> wire::MoneyImportPlanRequest {
    wire::MoneyImportPlanRequest {
        tz: TZ.to_owned(),
        source: wire::MoneySource::Ofx as i32,
        content: content.as_bytes().to_vec(),
        account_id: account.map(str::to_owned),
        ..wire::MoneyImportPlanRequest::default()
    }
}

#[test]
fn an_ofx_statement_finds_its_account_by_the_full_acctid_the_member_stored() {
    let scratch = Scratch::founded();
    scratch.account("cad", "Chequing CAD", "checking", "CAD", None);
    // No stored number: the statement matches nothing, and says so.
    let plan = scratch.plan(ofx(OFX, None));
    assert!(plan.refusal.is_none());
    assert_eq!(plan.statements.len(), 1);
    assert!(plan.statements[0].account_id.is_none());
    assert!(plan.statements[0].statement_refusal.is_some());

    // The member stores the bank's number on the account (W4-b) and it matches.
    scratch.run(
        "account.edit",
        json!({ "id": "cad", "external_ref": "9876543210" }),
    );
    let plan = scratch.plan(ofx(OFX, None));
    let statement = &plan.statements[0];
    assert_eq!(statement.account_id.as_deref(), Some("cad"));
    assert_eq!(statement.new, 2);
    assert_eq!(
        statement.checkpoint.as_ref().map(|c| c.as_of.as_str()),
        Some("2024-01-31")
    );
    assert_eq!(
        statement
            .checkpoint
            .as_ref()
            .and_then(|c| c.balance.as_ref())
            .map(|b| (b.minor, b.currency.as_str())),
        Some((198_750, "CAD"))
    );
    let out = scratch
        .run_bytes("follow.statement", statement.publish_input.clone())
        .expect("the import runs");
    assert_eq!(out["added"], 2);
    // The statement's stated balance is the shell's second command.
    let stated = statement.checkpoint.as_ref().expect("a stated balance");
    let written = scratch.run(
        "checkpoint.record",
        json!({
            "account_id": "cad", "day": stated.as_of,
            "balance_minor": stated.balance.as_ref().map(|b| b.minor),
        }),
    );
    assert_eq!(written["written"], true);
    let again = scratch.plan(ofx(OFX, None));
    assert_eq!(again.statements[0].already_in, 2);
    assert!(again.statements[0].publish_input.is_empty());

    // A currency that is not the account's is a sentence, not a plan.
    scratch.account("usd", "Chequing USD", "checking", "USD", None);
    let mismatched = scratch.plan(ofx(OFX, Some("usd")));
    assert!(mismatched.statements[0].statement_refusal.is_some());
    assert!(mismatched.statements[0].rows.is_empty());

    // A file holding three statements plans each against its own account.
    scratch.account("c", "Checking", "checking", "USD", Some("111122223333"));
    scratch.account("s", "Savings", "savings", "USD", Some("999988884444"));
    scratch.account("k", "Visa", "credit_card", "USD", Some("4111111111111111"));
    let multi = scratch.plan(ofx(MULTI, None));
    let accounts: Vec<_> = multi
        .statements
        .iter()
        .map(|s| s.account_id.clone().unwrap_or_default())
        .collect();
    assert_eq!(accounts, ["c", "s", "k"]);
}

// ---------------------------------------------------------------------------
// 4. The 19 statements, through the core's own door.
// ---------------------------------------------------------------------------

/// The statements `crates/apps/money` declares, by `PageQuery.name`.
const STATEMENTS: [&str; 19] = [
    "money.transactions.month",
    "money.transactions.entities",
    "money.transactions.statements",
    "money.transactions.trashed",
    "money.transaction",
    "money.imports.last",
    "money.accounts",
    "money.accounts.entities",
    "money.accounts.origins",
    "money.archived",
    "money.account.ledger",
    "money.account.recent",
    "money.targets",
    "money.rules",
    "money.checkpoints",
    "money.categories",
    "money.categories.entities",
    "money.links.transfer",
    "money.import.existing",
];

/// A door that remembers which statements were asked, then asks the core's.
struct Watching<'a> {
    inner: VaultDoor<'a>,
    asked: RefCell<BTreeSet<String>>,
}

impl PageDoor for Watching<'_> {
    fn page(
        &self,
        query: &PageQuery,
        request: &centraid_apps_kit::page::PageRequest,
    ) -> KitResult<Page<Row>> {
        self.asked.borrow_mut().insert(query.name.clone());
        self.inner.page(query, request)
    }
}

#[test]
fn every_statement_the_crate_declares_is_served_by_the_cores_door() {
    let scratch = ledger();
    // The rows each statement needs to be asked at all.
    scratch.run(
        "checkpoint.record",
        json!({ "account_id": "chq", "day": "2024-02-08", "balance_minor": 1 }),
    );
    scratch.run(
        "budget.set",
        json!({ "month": "2024-02", "category_id": GROCERIES,
                "amount_minor": 40_000, "currency": "USD", "carry": true }),
    );
    scratch.run(
        "rule.add",
        json!({ "id": "r1", "match": "contains", "text": "NETFLIX",
                "category_id": GROCERIES }),
    );
    scratch.run("flag.set", json!({ "id": DINING, "flag": "archived" }));
    // A saved layout, so the profile statement has a row to return.
    let saved = scratch.csv("chq", CHECKING).statements[0]
        .profile_to_save
        .clone()
        .expect("a layout to remember");
    scratch.run(
        "account.remember_layout",
        json!({
            "id": "chq",
            "layout": {
                "header_fingerprint": saved.header_fingerprint,
                "delimiter": saved.delimiter, "skip_lines": saved.skip_lines,
                "date_order": saved.date_order, "sign_mode": saved.sign_mode,
                "date_col": saved.date_col, "amount_col": saved.amount_col,
                "desc_col": saved.desc_col,
            },
        }),
    );
    scratch
        .handle
        .with_vault(|vault| {
            let watching = Watching {
                inner: VaultDoor::new(vault),
                asked: RefCell::new(BTreeSet::new()),
            };
            let today = "2024-02-10";
            let month = "2024-02";
            let first = PageRequest::first(50);
            phone::spending(&watching, month, today).expect("spending");
            phone::activity(&watching, month, &ActivityFilter::default(), &first, today)
                .expect("activity");
            let rows = phone::activity(&watching, month, &ActivityFilter::default(), &first, today)
                .expect("activity")
                .rows;
            phone::transaction(&watching, &rows[0].txn_id, today).expect("transaction");
            phone::cashflow(&watching, month, today).expect("cashflow");
            phone::accounts(&watching, today).expect("accounts");
            phone::rules(&watching).expect("rules");
            phone::categories(&watching).expect("categories");
            phone::target_sheet(&watching, month, GROCERIES, "USD", None, today).expect("sheet");
            phone::recurring_screen(&watching, today).expect("recurring");
            phone::home_tile(&watching, month, today).expect("tile");
            phone::search(&watching, month, "netflix", 10, today).expect("search");
            let accounts = queries::load_accounts(&watching).expect("accounts");
            assert_eq!(accounts.len(), 2);
            queries::load_existing(&watching, "chq", "2024-01-01", "2024-02-29").expect("existing");
            queries::load_saved_profiles(&watching, "chq").expect("profiles");
            assert!(watching.inner.take_failure().is_none());

            let asked = watching.asked.borrow();
            for name in STATEMENTS {
                assert!(
                    asked.contains(name),
                    "the core's door was never asked `{name}`; asked: {asked:?}"
                );
            }
            Ok(())
        })
        .expect("the vault is open");
}

// ---------------------------------------------------------------------------
// 5. Refusals, and what an answer never carries.
// ---------------------------------------------------------------------------

#[test]
fn the_manifests_scopes_are_ones_the_core_registry_accepts() {
    use centraid_vault::access::{Principal as VaultPrincipal, Scope, ScopeClamp};
    use centraid_vault::{Decision, Verb, evaluate_access};
    let manifest = centraid_apps_money::manifest::manifest();
    let registry = centraid_vault::commands::Registry::with_system_commands().expect("registry");
    let scopes: Vec<Scope> = manifest
        .vault
        .as_ref()
        .expect("a vault block")
        .scopes
        .iter()
        .map(|scope| Scope {
            schema: scope.schema.clone(),
            table: scope.table.clone(),
            verb: "read+act".to_owned(),
            row_filter: Vec::new(),
            field_mask: None,
        })
        .collect();
    // Every action names a command the core's registry holds, and the schema
    // that owns it is one the manifest's scopes reach: an action whose command
    // sits outside the grant is a write the app could never make.
    for row in centraid_apps_money::commands::ACTIONS {
        let registered = registry.get(row.command).unwrap_or_else(|| {
            panic!(
                "`{}` names `{}`, which the core registry does not hold",
                row.action, row.command
            )
        });
        let owner = registered.definition.owner_schema;
        assert!(
            scopes.iter().any(|scope| scope.schema == owner),
            "`{}` invokes `{}`, owned by `{owner}`, which no scope of the manifest reaches",
            row.action,
            row.command
        );
    }
    // A principal clamped to exactly the manifest's scopes is denied what they
    // do not name.
    let clamped = VaultPrincipal::OwnerDevice {
        device_id: "money".to_owned(),
        may_act: true,
        scope_clamp: Some(ScopeClamp { scopes }),
    };
    let connection = centraid_vault::rusqlite::Connection::open_in_memory().expect("memory");
    assert!(matches!(
        evaluate_access(&connection, &clamped, "notes", "note", Verb::Read).expect("judged"),
        Decision::Deny { .. }
    ));
}

#[test]
fn a_request_that_cannot_be_answered_is_refused_and_a_big_file_is_a_sentence() {
    let scratch = ledger();
    // A limit is required, never defaulted.
    assert!(
        scratch
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                    query: Some(Q::MoneySearch(wire::MoneySearchRequest {
                        tz: TZ.to_owned(),
                        term: "x".to_owned(),
                        ..wire::MoneySearchRequest::default()
                    })),
                })),
            })
            .is_err()
    );
    // A month that is not a month.
    assert!(
        scratch
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                    query: Some(Q::MoneySpending(wire::MoneySpendingRequest {
                        tz: TZ.to_owned(),
                        month: "February".to_owned(),
                    })),
                })),
            })
            .is_err()
    );
    // An unknown account and a CSV with none.
    assert!(
        scratch
            .try_money(wire::money_request::Kind::ImportPlan(
                wire::MoneyImportPlanRequest {
                    tz: TZ.to_owned(),
                    source: wire::MoneySource::Csv as i32,
                    content: b"a,b".to_vec(),
                    account_id: Some("ghost".to_owned()),
                    ..wire::MoneyImportPlanRequest::default()
                }
            ))
            .is_err()
    );
    assert!(
        scratch
            .try_money(wire::money_request::Kind::ImportPlan(
                wire::MoneyImportPlanRequest {
                    tz: TZ.to_owned(),
                    source: wire::MoneySource::Csv as i32,
                    content: b"a,b".to_vec(),
                    ..wire::MoneyImportPlanRequest::default()
                }
            ))
            .is_err()
    );
    // 8 MiB + 1 byte is refused whole, as a sentence the screen draws.
    let big = scratch.plan(wire::MoneyImportPlanRequest {
        tz: TZ.to_owned(),
        source: wire::MoneySource::Csv as i32,
        content: vec![b'a'; 8 * 1024 * 1024 + 1],
        account_id: Some("chq".to_owned()),
        ..wire::MoneyImportPlanRequest::default()
    });
    assert!(big.refusal.is_some());
    assert!(big.statements.is_empty());
    // Not a statement at all.
    let junk = scratch.csv("chq", "hello there\nthis is not a bank\n");
    assert!(junk.refusal.is_some());
}

#[test]
fn the_bytes_of_a_statement_are_in_no_answer_and_an_answer_round_trips() {
    let scratch = Scratch::founded();
    scratch.account("chq", "Everyday", "checking", "USD", None);
    let marker = "ZEBRA-QUOKKA-7731";
    let text = format!("Date,Description,Amount\n2024-02-01,{marker},-9.99\n");
    let plan = scratch.csv("chq", &text);
    // The description IS the member's own row, so it is in the plan; the FILE
    // is not: no header line, no delimiter-joined record.
    let bytes = plan.encode_to_vec();
    assert!(
        !bytes
            .windows(text.len())
            .any(|window| window == text.as_bytes()),
        "the file's bytes came back whole"
    );
    let decoded = wire::MoneyImportPlan::decode(bytes.as_slice()).expect("decodes");
    assert_eq!(decoded, plan);
    // Nothing was stored by planning: no transaction in any month.
    for month in ["2024-01", "2024-02"] {
        let stored = scratch.activity(wire::MoneyActivityRequest {
            tz: TZ.to_owned(),
            month: month.to_owned(),
            limit: 50,
            ..wire::MoneyActivityRequest::default()
        });
        assert!(stored.rows.is_empty(), "{month}");
    }
}

// ---------------------------------------------------------------------------
// 6. The demo ledger (R-1099-9).
// ---------------------------------------------------------------------------

#[test]
fn the_demo_ledger_seeds_whole_through_the_real_commands_and_reads_back() {
    let scratch = Scratch::founded();
    let now = centraid_vault::time::recurrence::parse_instant_ms(NOW).expect("an instant");
    let report = scratch
        .handle
        .with_vault(|vault| {
            let registry = centraid_vault::commands::Registry::with_system_commands()?;
            crate::example::seed(
                vault,
                &registry,
                &centraid_vault::Principal::owner("demo"),
                &|app| app == "money",
                now,
            )
        })
        .expect("the ledger seeds");
    assert!(report.is_whole(), "the ledger seeds whole: {report:?}");

    let february = scratch.spending("");
    assert!(!february.empty);
    assert!(
        february.categories.iter().any(|c| c.planned.is_some()),
        "a plan to be measured against"
    );
    let accounts = match scratch.ask(Q::MoneyAccounts(wire::MoneyAccountsRequest {
        tz: TZ.to_owned(),
    })) {
        Answer::MoneyAccounts(accounts) => accounts,
        other => panic!("{other:?}"),
    };
    assert_eq!(accounts.on_budget.len() + accounts.off_budget.len(), 3);
    // A handful of lines are left unfiled, so Activity has something to ask.
    let needing = scratch.activity(wire::MoneyActivityRequest {
        tz: TZ.to_owned(),
        month: "2024-01".to_owned(),
        limit: 50,
        category_filter: wire::MoneyCategoryFilter::Uncategorised as i32,
        ..wire::MoneyActivityRequest::default()
    });
    assert!(!needing.rows.is_empty());
    // And the recurring charges are found in what was seeded.
    let recurring = match scratch.ask(Q::MoneyRecurring(wire::MoneyRecurringRequest {
        tz: TZ.to_owned(),
    })) {
        Answer::MoneyRecurring(recurring) => recurring,
        other => panic!("{other:?}"),
    };
    assert!(!recurring.series.is_empty());
}
