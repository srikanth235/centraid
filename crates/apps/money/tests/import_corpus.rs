//! THE ADVERSARIAL CORPUS (#1099, wave 2).
//!
//! Every file under `tests/corpus/` is shaped like something a bank really
//! exports, or like the thing that breaks a reader: a preamble before the
//! header, no header at all, a day-first date column whose first row is
//! ambiguous, windows-1252 bytes, a byte-order mark, a quoted newline, a
//! parenthesised negative, an OFX 1.x SGML file and an OFX 2.x XML one.
//!
//! The corpus pins the CONTRACT, not the implementation: for each file, the
//! exact `(day, signed minor amount, description)` of every row and the exact
//! line and reason of every rejected one. The `receipts/issue-1099-money.md`
//! lane section records each case red against a stub reader, then green.

use std::path::PathBuf;

use centraid_apps_money::import::{
    AccountRef, AmountSpec, CsvOptions, DateOrder, Direction, ExistingTxn, IMPORT_BYTES,
    IMPORT_ROWS, ImportPlan, ParsedRow, Refusal, RejectReason, RowVerdict, SignChoice, Source,
    Statement, StatementRefusal, Warning, read_csv, read_ofx, resolve_account,
};
use centraid_apps_money::rules::{MatchKind, Rule};

fn corpus(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("corpus")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn csv(name: &str, currency: &str) -> Statement {
    read_csv(&corpus(name), &CsvOptions::new(currency)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// `(day, signed minor, description)` of every readable row, in file order.
fn rows(statement: &Statement) -> Vec<(String, i64, String)> {
    statement
        .readable()
        .map(|(_, row)| {
            (
                row.posted_on.clone(),
                row.signed_minor(),
                row.description.clone(),
            )
        })
        .collect()
}

fn rejected(statement: &Statement) -> Vec<(usize, RejectReason)> {
    statement
        .rows
        .iter()
        .filter_map(|row: &ParsedRow| row.result.as_ref().err().map(|why| (row.line, *why)))
        .collect()
}

fn t(day: &str, minor: i64, description: &str) -> (String, i64, String) {
    (day.to_owned(), minor, description.to_owned())
}

fn existing_of(statement: &Statement, prefix: &str) -> Vec<ExistingTxn> {
    statement
        .readable()
        .enumerate()
        .map(|(at, (_, row))| ExistingTxn {
            txn_id: format!("{prefix}{at}"),
            external_id: Some(row.external_id.clone()),
            posted_on: row.posted_on.clone(),
            amount_minor: row.amount_minor,
            direction: row.direction,
            description: row.description.clone(),
            display_name: None,
        })
        .collect()
}

fn plan_of(statement: &Statement, existing: &[ExistingTxn]) -> ImportPlan {
    centraid_apps_money::import::plan(statement, "acct-1", "USD", existing, &[], "2024-06-30")
}

fn verdicts(plan: &ImportPlan) -> Vec<&RowVerdict> {
    plan.rows.iter().map(|row| &row.verdict).collect()
}

// ---------------------------------------------------------------------------
// The banks.
// ---------------------------------------------------------------------------

#[test]
fn chase_checking_signed_amounts_type_and_check_number() {
    let statement = csv("chase_checking.csv", "USD");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-01-16", -575, "STARBUCKS STORE 12345 SEATTLE WA"),
            t("2024-01-15", 250_000, "PAYROLL ACME CORP PPD ID: 1234567"),
            t("2024-01-12", -12_000, "CHECK 1042"),
            t("2024-01-05", -1_549, "NETFLIX.COM"),
        ]
    );
    let check = statement.readable().nth(2).map(|(_, r)| r.clone());
    let check = check.expect("third row");
    assert_eq!(check.check_number.as_deref(), Some("1042"));
    assert_eq!(check.bank_type.as_deref(), Some("CHECK_PAYMENT"));
    assert!(rejected(&statement).is_empty());
    assert!(statement.warnings.is_empty());
    assert!(statement.question.is_none());
}

#[test]
fn amex_positive_charges_are_flipped_and_the_guess_is_declared() {
    let statement = csv("amex.csv", "USD");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-01-29", -4_217, "AMAZON MKTPLACE PMTS"),
            t("2024-01-28", -1_860, "UBER *TRIP"),
            t("2024-01-25", 50_000, "AUTOPAY PAYMENT - THANK YOU"),
            t("2024-01-20", -8_602, "WHOLEFDS MKT 10234"),
            t("2024-01-03", -1_549, "NETFLIX.COM"),
        ]
    );
    let profile = statement.profile.as_ref().expect("csv profile");
    assert!(matches!(profile.amounts, AmountSpec::Flip { .. }));
    assert_eq!(statement.warnings, vec![Warning::SignGuessed]);
    // The member's override reads the same file the other way round.
    let mut options = CsvOptions::new("USD");
    options.sign = Some(SignChoice::DebitsNegative);
    let other = read_csv(&corpus("amex.csv"), &options).expect("reads");
    assert_eq!(rows(&other)[0].1, 4_217);
    assert!(other.warnings.is_empty());
}

#[test]
fn capital_one_debit_and_credit_columns_and_the_posted_date() {
    let statement = csv("capital_one.csv", "USD");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-01-03", -4_510, "SHELL OIL 57444212"),
            t("2024-01-06", 30_000, "CAPITAL ONE MOBILE PYMT"),
            t("2024-01-10", -645, "TIM HORTONS #0345"),
        ]
    );
    let profile = statement.profile.as_ref().expect("profile");
    assert!(matches!(profile.amounts, AmountSpec::DebitCredit { .. }));
    assert!(statement.warnings.is_empty());
}

#[test]
fn bank_of_america_preamble_is_skipped_and_the_balance_line_is_one_rejected_row() {
    let statement = csv("bank_of_america.csv", "USD");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-01-03", -8_545, "WHOLE FOODS #123 AUSTIN TX"),
            t("2024-01-15", 200_000, "PAYROLL DEPOSIT"),
            t("2024-01-22", -76_500, "RENT PAYMENT"),
        ]
    );
    assert_eq!(rejected(&statement), vec![(8, RejectReason::MissingAmount)]);
    let profile = statement.profile.as_ref().expect("profile");
    assert!(profile.has_header);
    assert_eq!(profile.skip_rows, 6);
}

#[test]
fn wells_fargo_has_no_header_and_is_read_by_content() {
    let statement = csv("wells_fargo.csv", "USD");
    assert_eq!(
        rows(&statement),
        vec![
            t(
                "2024-01-05",
                -4_530,
                "POS PURCHASE - TARGET T-1234 SAN FRANCISCO"
            ),
            t("2024-01-13", 150_000, "DIRECT DEP ACME INC"),
            t("2024-01-20", -1_200, "MONTHLY SERVICE FEE"),
        ]
    );
    assert!(!statement.profile.as_ref().expect("profile").has_header);
    assert!(rejected(&statement).is_empty());
}

#[test]
fn td_canada_headerless_debit_credit_balance_is_month_first() {
    // TD's EasyWeb export is MM/DD/YYYY; a 13th and a 20th settle it, so this
    // is modelled as month-first and not asked.
    let statement = csv("td_canada.csv", "CAD");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-01-05", -452, "TIM HORTONS #1234"),
            t("2024-01-13", 220_000, "PAYROLL DEPOSIT"),
            t("2024-01-20", -8_500, "ROGERS WIRELESS"),
        ]
    );
    let profile = statement.profile.as_ref().expect("profile");
    assert!(matches!(
        profile.amounts,
        AmountSpec::DebitCredit {
            debit: Some(2),
            credit: Some(3)
        }
    ));
    assert_eq!(profile.date_order, DateOrder::Mdy);
}

#[test]
fn rbc_reads_the_account_currency_column_and_both_description_lines() {
    let statement = csv("rbc.csv", "CAD");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-01-05", -5_420, "LOBLAWS #1234"),
            t("2024-01-22", 180_000, "PAYROLL"),
            t("2024-01-23", -30_000, "Cheque 101"),
        ]
    );
    let all: Vec<_> = statement.readable().map(|(_, r)| r.clone()).collect();
    assert_eq!(all[0].memo.as_deref(), Some("TORONTO ON"));
    assert_eq!(all[2].check_number.as_deref(), Some("101"));
    assert_eq!(all[2].memo, None);
}

#[test]
fn tangerine_name_memo_and_transaction_type() {
    let statement = csv("tangerine.csv", "CAD");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-01-05", -385, "TIM HORTONS"),
            t("2024-01-22", 120_000, "PAYROLL"),
        ]
    );
    let first = statement.readable().next().expect("row").1.clone();
    assert_eq!(first.memo.as_deref(), Some("Purchase - INTERAC"));
    assert_eq!(first.bank_type.as_deref(), Some("DEBIT"));
}

// ---------------------------------------------------------------------------
// Encodings and syntax.
// ---------------------------------------------------------------------------

#[test]
fn windows_1252_bytes_are_decoded_not_mangled() {
    let statement = csv("windows1252.csv", "USD");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-01-03", -450, "CAFé DU MONDE"),
            t("2024-01-04", -825, "Zürich Café"),
        ]
    );
}

#[test]
fn a_utf8_byte_order_mark_is_not_part_of_the_first_header_cell() {
    let statement = csv("utf8_bom.csv", "USD");
    assert_eq!(rows(&statement), vec![t("2024-01-03", -450, "Café Rouge")]);
    assert!(statement.profile.as_ref().expect("profile").has_header);
}

#[test]
fn crlf_and_a_quoted_newline_and_doubled_quotes() {
    let statement = csv("crlf_quoted_newline.csv", "USD");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-01-03", -450, "LINE ONE\nLINE TWO"),
            t("2024-01-04", -825, "WITH \"QUOTES\", COMMA"),
        ]
    );
    // The second record starts on line 4 because the first spans two lines.
    let lines: Vec<usize> = statement.rows.iter().map(|r| r.line).collect();
    assert_eq!(lines, vec![2, 4]);
}

#[test]
fn crlf_and_lf_exports_of_one_statement_hash_alike() {
    let lf = String::from_utf8(corpus("crlf_quoted_newline.csv"))
        .expect("utf8")
        .replace("\r\n", "\n");
    let a = csv("crlf_quoted_newline.csv", "USD");
    let b = read_csv(lf.as_bytes(), &CsvOptions::new("USD")).expect("reads");
    let ids = |s: &Statement| -> Vec<String> {
        s.readable().map(|(_, r)| r.external_id.clone()).collect()
    };
    assert_eq!(ids(&a), ids(&b));
}

#[test]
fn parentheses_dollar_minus_and_cr_suffix() {
    let statement = csv("parentheses.csv", "USD");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-01-03", -5_420, "GROCER"),
            t("2024-01-04", 1_200, "REFUND"),
            t("2024-01-05", -9_500, "ANNUAL FEE"),
            t("2024-01-06", 125_000, "BONUS"),
        ]
    );
    assert!(
        statement.warnings.is_empty(),
        "an explicit CR/DR is not a guess"
    );
}

#[test]
fn semicolons_decimal_commas_and_dotted_dates() {
    let statement = csv("semicolon_decimal_comma.csv", "EUR");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-01-05", -1_250, "REWE MARKT"),
            t("2024-01-17", 240_000, "GEHALT"),
        ]
    );
    assert_eq!(statement.profile.as_ref().expect("profile").delimiter, ';');
    assert_eq!(
        statement.profile.as_ref().expect("profile").date_order,
        DateOrder::Dmy
    );
}

#[test]
fn bad_rows_are_rejected_one_by_one_with_their_line_and_the_file_is_not_blocked() {
    let statement = csv("bad_rows.csv", "USD");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-01-03", -450, "GOOD ONE"),
            t("2024-01-07", -200, "GOOD TWO"),
            t("2024-01-08", -300, "GOOD THREE"),
        ]
    );
    assert_eq!(
        rejected(&statement),
        vec![
            (3, RejectReason::UnreadableDate),
            (4, RejectReason::UnreadableAmount),
            (5, RejectReason::ZeroAmount),
        ]
    );
    let plan = plan_of(&statement, &[]);
    assert_eq!(plan.totals.rows, 6);
    assert_eq!(plan.totals.rejected, 3);
    assert_eq!(plan.totals.new, 3);
}

// ---------------------------------------------------------------------------
// Date order.
// ---------------------------------------------------------------------------

#[test]
fn a_day_first_file_whose_first_row_is_ambiguous_is_decided_by_the_whole_column() {
    let statement = csv("dmy_first_ambiguous.csv", "USD");
    assert_eq!(
        rows(&statement),
        vec![
            t("2024-04-03", -1_000, "FIRST ROW AMBIGUOUS"),
            t("2024-04-05", -1_100, "SECOND"),
            t("2024-04-21", -1_200, "DECIDES IT"),
        ]
    );
    assert_eq!(
        statement.profile.as_ref().expect("profile").date_order,
        DateOrder::Dmy
    );
    assert!(statement.question.is_none());
}

#[test]
fn a_wholly_ambiguous_file_asks_and_the_answer_reads_it() {
    let statement = csv("dmy_wholly_ambiguous.csv", "USD");
    assert!(statement.rows.is_empty(), "no rows are read on a guess");
    let question = statement.question.as_ref().expect("the question");
    assert_eq!(question.samples.len(), 3);
    assert_eq!(question.options, vec![DateOrder::Mdy, DateOrder::Dmy]);
    let plan = plan_of(&statement, &[]);
    assert!(plan.question.is_some());
    assert_eq!(plan.totals.rows, 0);

    let mut options = CsvOptions::new("USD");
    options.date_order = Some(DateOrder::Dmy);
    let day_first = read_csv(&corpus("dmy_wholly_ambiguous.csv"), &options).expect("reads");
    assert_eq!(
        rows(&day_first)
            .iter()
            .map(|r| r.0.as_str())
            .collect::<Vec<_>>(),
        vec!["2024-04-03", "2024-06-05", "2024-12-11"]
    );
    options.date_order = Some(DateOrder::Mdy);
    let month_first = read_csv(&corpus("dmy_wholly_ambiguous.csv"), &options).expect("reads");
    assert_eq!(
        rows(&month_first)
            .iter()
            .map(|r| r.0.as_str())
            .collect::<Vec<_>>(),
        vec!["2024-03-04", "2024-05-06", "2024-11-12"]
    );
}

#[test]
fn an_answer_cannot_overrule_a_day_the_file_proves() {
    let mut options = CsvOptions::new("USD");
    options.date_order = Some(DateOrder::Mdy);
    let statement = read_csv(&corpus("dmy_first_ambiguous.csv"), &options).expect("reads");
    assert_eq!(rows(&statement)[0].0, "2024-04-03");
}

// ---------------------------------------------------------------------------
// OFX / QFX.
// ---------------------------------------------------------------------------

fn only_statement(name: &str) -> centraid_apps_money::import::OfxStatement {
    let mut file = read_ofx(&corpus(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    assert_eq!(file.statements.len(), 1, "{name}");
    file.statements.remove(0)
}

#[test]
fn qfx_sgml_1x_with_zone_suffixes_checknum_and_the_ledger_balance() {
    let ofx = only_statement("qfx_sgml.qfx");
    assert_eq!(ofx.acct_id.as_deref(), Some("000123456789"));
    assert_eq!(ofx.currency.as_deref(), Some("USD"));
    assert_eq!(
        rows(&ofx.statement),
        vec![
            t("2024-01-05", -4_530, "TARGET T-1234"),
            t("2024-01-13", 150_000, "ACME PAYROLL"),
            t("2024-01-20", -12_000, "CHECK 1042"),
        ]
    );
    let all: Vec<_> = ofx
        .statement
        .readable()
        .map(|(l, r)| (l, r.clone()))
        .collect();
    assert_eq!(all[0].1.external_id, "ofx:202401050001");
    assert_eq!(all[0].1.memo.as_deref(), Some("POS PURCHASE"));
    assert_eq!(all[0].1.bank_type.as_deref(), Some("DEBIT"));
    assert_eq!(all[2].1.check_number.as_deref(), Some("1042"));
    assert_eq!(
        all.iter().map(|(l, _)| *l).collect::<Vec<_>>(),
        vec![21, 22, 23]
    );
    let checkpoint = ofx.statement.checkpoint.as_ref().expect("LEDGERBAL");
    assert_eq!(
        (checkpoint.as_of.as_str(), checkpoint.balance_minor),
        ("2024-01-31", 233_470),
        "the available balance is not the ledger balance"
    );
    assert_eq!(ofx.statement.source, Source::Ofx);
}

#[test]
fn ofx_2x_xml_with_entities() {
    let ofx = only_statement("ofx2.ofx");
    assert_eq!(ofx.currency.as_deref(), Some("CAD"));
    assert_eq!(
        rows(&ofx.statement),
        vec![
            t("2024-01-05", -1_250, "CAFÉ & BAKERY"),
            t("2024-01-15", 200_000, "EMPLOYER"),
        ]
    );
    assert_eq!(
        ofx.statement.checkpoint.as_ref().map(|c| c.balance_minor),
        Some(198_750)
    );
}

#[test]
fn a_multi_account_file_is_one_statement_per_account_matched_by_digits_or_reference() {
    let file = read_ofx(&corpus("multi_account.ofx")).expect("reads");
    assert_eq!(file.statements.len(), 3);
    let accounts = vec![
        AccountRef {
            account_id: "checking".into(),
            currency: "USD".into(),
            external_ref: None,
            mask: Some("3333".into()),
        },
        AccountRef {
            account_id: "savings".into(),
            currency: "USD".into(),
            external_ref: Some("9999-8888-4444".into()),
            mask: None,
        },
    ];
    let resolved: Vec<Result<&str, StatementRefusal>> = file
        .statements
        .iter()
        .map(|s| resolve_account(s, &accounts).map(|a| a.account_id.as_str()))
        .collect();
    assert_eq!(
        resolved,
        vec![
            Ok("checking"),
            Ok("savings"),
            Err(StatementRefusal::NoAccount)
        ]
    );
    // The card statement keeps its own balance, signed as printed.
    assert_eq!(
        file.statements[2]
            .statement
            .checkpoint
            .as_ref()
            .map(|c| c.balance_minor),
        Some(-3_310)
    );
}

#[test]
fn a_statement_matching_two_accounts_is_refused_and_never_merged() {
    let file = read_ofx(&corpus("multi_account.ofx")).expect("reads");
    let accounts = vec![
        AccountRef {
            account_id: "a".into(),
            currency: "USD".into(),
            external_ref: None,
            mask: Some("3333".into()),
        },
        AccountRef {
            account_id: "b".into(),
            currency: "USD".into(),
            external_ref: Some("111122223333".into()),
            mask: None,
        },
    ];
    assert_eq!(
        resolve_account(&file.statements[0], &accounts).err(),
        Some(StatementRefusal::Ambiguous)
    );
}

#[test]
fn a_currency_that_is_not_the_accounts_is_refused_with_both_currencies_named() {
    let ofx = only_statement("curdef_mismatch.ofx");
    let accounts = vec![AccountRef {
        account_id: "checking".into(),
        currency: "USD".into(),
        external_ref: None,
        mask: Some("3333".into()),
    }];
    let refusal = resolve_account(&ofx, &accounts).expect_err("refused");
    assert_eq!(
        refusal,
        StatementRefusal::CurrencyMismatch {
            statement: "EUR".into(),
            account: "USD".into()
        }
    );
    assert_eq!(
        refusal.sentence(),
        "This statement is in EUR; the account is in USD."
    );
}

#[test]
fn one_bad_trnamt_is_one_rejected_row_and_the_rest_are_new() {
    let ofx = only_statement("ofx_bad_trnamt.ofx");
    assert_eq!(
        rejected(&ofx.statement),
        vec![(11, RejectReason::UnreadableAmount)]
    );
    let plan = plan_of(&ofx.statement, &[]);
    assert_eq!(plan.totals.new, 2);
    assert_eq!(plan.totals.rejected, 1);
    assert_eq!(plan.totals.rows, 3);
}

#[test]
fn a_transaction_with_no_fitid_gets_the_nofitid_key_and_an_identical_pair_stays_two() {
    let ofx = only_statement("ofx_no_fitid.ofx");
    let ids: Vec<String> = ofx
        .statement
        .readable()
        .map(|(_, r)| r.external_id.clone())
        .collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.iter().all(|id| id.starts_with("ofx-nofitid:")));
    assert_ne!(ids[0], ids[1]);
}

#[test]
fn a_file_that_is_not_ofx_is_refused() {
    assert_eq!(
        read_ofx(b"hello, this is not a bank file").err(),
        Some(Refusal::UnreadableOfx)
    );
    assert_eq!(read_ofx(b"   ").err(), Some(Refusal::Empty));
}

// ---------------------------------------------------------------------------
// The plan.
// ---------------------------------------------------------------------------

#[test]
fn the_same_file_twice_is_every_row_already_in() {
    let first = csv("chase_checking.csv", "USD");
    let existing = existing_of(&first, "t");
    let second = plan_of(&csv("chase_checking.csv", "USD"), &existing);
    assert_eq!(second.totals.rows, 4);
    assert_eq!(second.totals.already_in, 4);
    assert_eq!(second.totals.new, 0);
    assert!(
        second
            .rows
            .iter()
            .all(|r| matches!(r.verdict, RowVerdict::AlreadyIn { .. }))
    );
    // The same for OFX.
    let qfx = only_statement("qfx_sgml.qfx");
    let again = plan_of(&qfx.statement, &existing_of(&qfx.statement, "q"));
    assert_eq!(again.totals.already_in, 3);
}

#[test]
fn a_file_overlapping_the_last_by_a_week_has_only_its_new_rows_new() {
    let a = csv("overlap_a.csv", "USD");
    let existing = existing_of(&a, "t");
    let b = plan_of(&csv("overlap_b.csv", "USD"), &existing);
    assert_eq!(b.totals.already_in, 3);
    assert_eq!(b.totals.new, 2);
    let new_descriptions: Vec<&str> = b
        .rows
        .iter()
        .filter(|r| r.verdict == RowVerdict::New)
        .filter_map(|r| r.row.as_ref().map(|row| row.description.as_str()))
        .collect();
    assert_eq!(new_descriptions, vec!["GROCER F", "GROCER G"]);
    assert_eq!(b.totals.new_out_minor, 7_000 + 8_000);
    assert_eq!(
        b.totals.file_out_minor,
        4_000 + 5_000 + 6_000 + 7_000 + 8_000
    );
    assert_eq!(
        (b.totals.first_day.as_deref(), b.totals.last_day.as_deref()),
        (Some("2024-01-08"), Some("2024-01-17"))
    );
}

#[test]
fn a_weekly_same_amount_charge_is_never_proposed_as_last_weeks() {
    let weekly = csv("weekly_charge.csv", "USD");
    let ids: std::collections::HashSet<String> = weekly
        .readable()
        .map(|(_, r)| r.external_id.clone())
        .collect();
    assert_eq!(ids.len(), 4, "four weeks, four transactions");
    // Last week's charge exists under a DIFFERENT id (a manual entry, a changed
    // export): the fuzzy window is three days, so a week later is New.
    let existing = vec![ExistingTxn {
        txn_id: "manual".into(),
        external_id: None,
        posted_on: "2024-01-01".into(),
        amount_minor: 999,
        direction: Direction::Debit,
        description: "STREAMCO".into(),
        display_name: None,
    }];
    let plan = plan_of(&weekly, &existing);
    let kinds: Vec<&str> = plan
        .rows
        .iter()
        .map(|r| match r.verdict {
            RowVerdict::New => "new",
            RowVerdict::ProposedDuplicate { .. } => "proposed",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, vec!["proposed", "new", "new", "new"]);
    // The next week's charge on its own, against last week's: seven days apart
    // is two charges, not one.
    let next_week = read_csv(
        b"Date,Description,Amount\n2024-01-08,\"STREAMCO\",-9.99\n",
        &CsvOptions::new("USD"),
    )
    .expect("reads");
    assert_eq!(
        plan_of(&next_week, &existing).rows[0].verdict,
        RowVerdict::New
    );
}

#[test]
fn an_identical_pair_on_one_day_is_two_rows_and_re_imports_as_two_already_in() {
    let first = csv("identical_pair.csv", "USD");
    let ids: Vec<String> = first
        .readable()
        .map(|(_, r)| r.external_id.clone())
        .collect();
    assert_ne!(ids[0], ids[1]);
    let existing = existing_of(&first, "t");
    let again = plan_of(&csv("identical_pair.csv", "USD"), &existing);
    assert_eq!(again.totals.already_in, 3);
    // With only ONE of the pair held, the file's second coffee is the new one.
    let one_held = vec![existing[0].clone(), existing[2].clone()];
    let partial = plan_of(&csv("identical_pair.csv", "USD"), &one_held);
    assert_eq!(partial.totals.already_in, 2);
    assert_eq!(partial.totals.new, 1);
}

#[test]
fn the_fuzzy_pass_proposes_one_to_one_and_never_across_distinct_fitids() {
    let qfx = only_statement("qfx_sgml.qfx");
    // A CSV-era copy of the first QFX row: same day, amount, similar name.
    let csv_copy = ExistingTxn {
        txn_id: "csv-1".into(),
        external_id: Some("csv:abc".into()),
        posted_on: "2024-01-06".into(),
        amount_minor: 4_530,
        direction: Direction::Debit,
        description: "TARGET T-1234 SAN FRANCISCO".into(),
        display_name: None,
    };
    let plan = plan_of(&qfx.statement, std::slice::from_ref(&csv_copy));
    assert_eq!(
        plan.rows[0].verdict,
        RowVerdict::ProposedDuplicate {
            existing: "csv-1".into()
        }
    );
    assert_eq!(plan.totals.proposed_duplicates, 1);
    // A different FITID on an existing OFX row is a different transaction.
    let other_fitid = ExistingTxn {
        external_id: Some("ofx:SOMETHING-ELSE".into()),
        ..csv_copy
    };
    let plan = plan_of(&qfx.statement, &[other_fitid]);
    assert_eq!(plan.rows[0].verdict, RowVerdict::New);
}

#[test]
fn two_incoming_rows_cannot_claim_the_same_existing_row() {
    let statement = read_csv(
        b"Date,Description,Amount\n2024-01-02,\"COFFEE SHOP\",-4.00\n2024-01-03,\"COFFEE SHOP 2\",-4.00\n",
        &CsvOptions::new("USD"),
    )
    .expect("reads");
    let existing = vec![ExistingTxn {
        txn_id: "held".into(),
        external_id: None,
        posted_on: "2024-01-02".into(),
        amount_minor: 400,
        direction: Direction::Debit,
        description: "COFFEE SHOP".into(),
        display_name: None,
    }];
    let plan = plan_of(&statement, &existing);
    assert_eq!(plan.totals.proposed_duplicates, 1);
    assert_eq!(plan.totals.new, 1);
}

#[test]
fn repeats_inside_one_file_collapse_and_the_counts_add_up() {
    let doubled = "Date,Description,Amount\n2024-01-02,\"A\",-4.00\n";
    let statement = read_csv(doubled.as_bytes(), &CsvOptions::new("USD")).expect("reads");
    // Build a repeat by hand: the same parsed row twice.
    let mut repeated = statement.clone();
    repeated.rows.push(repeated.rows[0].clone());
    let plan = plan_of(&repeated, &[]);
    assert_eq!(
        verdicts(&plan),
        vec![
            &RowVerdict::New,
            &RowVerdict::RepeatInFile { first_line: 2 }
        ]
    );
    let totals = &plan.totals;
    assert_eq!(
        totals.new
            + totals.already_in
            + totals.proposed_duplicates
            + totals.repeats_in_file
            + totals.rejected,
        totals.rows
    );
}

#[test]
fn future_dated_rows_are_imported_and_flagged() {
    let statement = csv("overlap_b.csv", "USD");
    let plan = plan_on_day(&statement, "2024-01-12");
    assert_eq!(plan.totals.future_dated, 2);
    assert_eq!(plan.totals.new, 5);
    assert_eq!(
        plan.rows.iter().map(|r| r.future_dated).collect::<Vec<_>>(),
        vec![false, false, false, true, true]
    );
}

fn plan_on_day(statement: &Statement, today: &str) -> ImportPlan {
    centraid_apps_money::import::plan(statement, "acct-1", "USD", &[], &[], today)
}

#[test]
fn rules_set_the_category_and_name_on_the_plan_rows_and_a_bank_row_is_never_dropped() {
    let statement = csv("amex.csv", "USD");
    let rules = vec![Rule {
        rule_id: "r1".into(),
        kind: MatchKind::Contains,
        pattern: "netflix".into(),
        amount_min_minor: None,
        amount_max_minor: None,
        account_id: None,
        category_concept_id: Some("subscriptions".into()),
        display_name: Some("Netflix".into()),
        position: 0,
    }];
    let planned =
        centraid_apps_money::import::plan(&statement, "acct-1", "USD", &[], &rules, "2024-06-30");
    let netflix = planned
        .rows
        .iter()
        .find_map(|r| {
            r.row
                .as_ref()
                .filter(|row| row.description == "NETFLIX.COM")
        })
        .expect("row");
    assert_eq!(
        netflix.category_concept_id.as_deref(),
        Some("subscriptions")
    );
    assert_eq!(netflix.display_name.as_deref(), Some("Netflix"));
    assert_eq!(planned.totals.rows, 5);
    assert_eq!(planned.totals.new, 5);
    assert_eq!(
        netflix.description, "NETFLIX.COM",
        "the raw description is untouched"
    );
}

// ---------------------------------------------------------------------------
// Profiles.
// ---------------------------------------------------------------------------

#[test]
fn a_saved_profile_is_reapplied_while_its_fingerprint_matches_and_redetected_when_it_does_not() {
    let first = csv("chase_checking.csv", "USD");
    let profile = first.profile.clone().expect("profile");
    let mut options = CsvOptions::new("USD");
    options.profile = Some(&profile);
    let again = read_csv(&corpus("chase_checking.csv"), &options).expect("reads");
    assert_eq!(rows(&again), rows(&first));
    assert!(again.warnings.is_empty());
    // A different bank's file under the same saved profile: re-detected, said so.
    let other = read_csv(&corpus("amex.csv"), &options).expect("reads");
    assert!(other.warnings.contains(&Warning::ProfileChanged));
    assert_eq!(rows(&other), rows(&csv("amex.csv", "USD")));
    // The fingerprint is the header AND the column count.
    assert_ne!(
        first.profile.as_ref().map(|p| p.fingerprint.clone()),
        other.profile.as_ref().map(|p| p.fingerprint.clone())
    );
}

#[test]
fn a_profile_round_trips_through_json_for_the_core_to_keep() {
    let profile = csv("td_canada.csv", "CAD").profile.expect("profile");
    let json = serde_json::to_string(&profile).expect("serialises");
    let back: centraid_apps_money::import::CsvProfile = serde_json::from_str(&json).expect("reads");
    assert_eq!(back, profile);
}

// ---------------------------------------------------------------------------
// Limits.
// ---------------------------------------------------------------------------

fn big_csv(rows: usize) -> String {
    let mut text = String::from("Date,Description,Amount\n");
    for index in 0..rows {
        text.push_str(&format!(
            "2024-01-{:02},\"ROW {index}\",-{}.{:02}\n",
            index % 28 + 1,
            index / 100 % 90 + 1,
            index % 100
        ));
    }
    text
}

#[test]
fn twenty_thousand_rows_read_and_twenty_thousand_and_one_are_refused_with_the_limit() {
    let at_the_limit =
        read_csv(big_csv(IMPORT_ROWS).as_bytes(), &CsvOptions::new("USD")).expect("reads");
    assert_eq!(at_the_limit.rows.len(), IMPORT_ROWS);
    let over = read_csv(big_csv(IMPORT_ROWS + 1).as_bytes(), &CsvOptions::new("USD"));
    assert_eq!(
        over.err(),
        Some(Refusal::TooManyRows { limit: IMPORT_ROWS })
    );
}

#[test]
fn eight_mebibytes_and_one_byte_is_refused_by_both_readers() {
    let bytes = vec![b'a'; IMPORT_BYTES + 1];
    let expected = Some(Refusal::TooLarge {
        bytes: IMPORT_BYTES + 1,
        limit: IMPORT_BYTES,
    });
    assert_eq!(read_csv(&bytes, &CsvOptions::new("USD")).err(), expected);
    assert_eq!(read_ofx(&bytes).err(), expected);
}

#[test]
fn a_file_with_no_date_or_no_amount_is_not_a_statement() {
    let text = b"name,colour\nrose,red\nlily,white\n";
    assert_eq!(
        read_csv(text, &CsvOptions::new("USD")).err(),
        Some(Refusal::NotAStatement)
    );
    assert_eq!(
        read_csv(b"", &CsvOptions::new("USD")).err(),
        Some(Refusal::Empty)
    );
}

// ---------------------------------------------------------------------------
// Year-3 volume.
// ---------------------------------------------------------------------------

#[test]
fn year_three_volume_reads_plans_and_replans_to_all_already_in() {
    use centraid_apps_money::year3::{YEAR3, year3};
    let accounts = year3(1099);
    assert_eq!(accounts.len(), YEAR3.accounts);
    let mut total = 0;
    for account in &accounts {
        let statement =
            read_csv(account.csv.as_bytes(), &CsvOptions::new(account.currency)).expect("reads");
        assert!(rejected(&statement).is_empty(), "{}", account.name);
        let first = plan_of(&statement, &[]);
        assert_eq!(first.totals.rows, YEAR3.rows_per_account);
        assert_eq!(first.totals.new, YEAR3.rows_per_account);
        // Identical same-day rows exist in 4,500 draws; none collapses.
        let held = existing_of(&statement, "t");
        let second = plan_of(&statement, &held);
        assert_eq!(second.totals.already_in, YEAR3.rows_per_account);
        total += first.totals.rows;
    }
    assert_eq!(total, 18_000);
    // Byte-identical across runs.
    assert_eq!(year3(1099), accounts);
}
