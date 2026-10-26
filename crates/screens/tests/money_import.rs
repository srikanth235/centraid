//! Import a statement: pick, plan, publish. Ports of the import cases of
//! `MoneyScreensSpec`, against the example vault's real core.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::money::routes;
use centraid_screens::testing::Driver;
use money_support::*;
use wire::money_import_event as ie;

const CSV: &str = "Date,Description,Amount\n2026-09-01,GROCER A,-20.00\n2026-09-03,GROCER B,-30.00\n2026-09-08,GROCER C,-40.00\n2026-09-10,GROCER D,-50.00\n2026-09-12,GROCER E,-60.00\n";

fn imp(v: &wire::ViewState) -> &wire::MoneyImportState {
    match &v.kind {
        Some(wire::view_state::Kind::MoneyImport(s)) => s,
        other => panic!("not import: {other:?}"),
    }
}

fn data(v: &wire::ViewState) -> &wire::MoneyImportData {
    match &imp(v).content {
        Some(wire::money_import_state::Content::Data(d)) => d,
        other => panic!("no import data: {other:?}"),
    }
}

fn iev(kind: ie::Kind) -> wire::screen_event::Kind {
    wire::screen_event::Kind::MoneyImport(wire::MoneyImportEvent { kind: Some(kind) })
}

/// Tap Choose, and answer the shell's picker with `body`.
fn pick(d: &mut Driver, i: u64, name: &str, body: &str) {
    event(d, i, iev(ie::Kind::Choose(ie::ChooseTapped {})));
    d.answer_effect(wire::effect_result::Outcome::BytesPicked(
        wire::BytesPicked {
            cancelled: false,
            name: name.to_owned(),
            media_type: String::new(),
            content: body.as_bytes().to_vec(),
        },
    ));
}

fn opened() -> (Driver, u64) {
    let mut d = driver();
    let i = push(&mut d, routes::import("Money"));
    (d, i)
}

#[test]
fn choosing_asks_the_shell_for_a_file_and_nothing_is_written_until_import() {
    let (mut d, i) = opened();
    assert_eq!(data(d.view(i)).choose_label, "Choose file");
    assert!(data(d.view(i)).needs_account);
    d.effects.clear();
    event(&mut d, i, iev(ie::Kind::Choose(ie::ChooseTapped {})));
    assert!(matches!(
        d.effects
            .last()
            .and_then(|e| e.effect.as_ref())
            .and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::PickBytes(_))
    ));
    assert_eq!(data(d.view(i)).publish_label, "");
}

#[test]
fn a_csv_waits_for_its_account_then_plans_and_publishes_the_plans_own_input() {
    let (mut d, i) = opened();
    let (account, _) = accounts(&d).remove(0);
    pick(&mut d, i, "Statement.csv", CSV);
    // With several accounts a CSV waits for the member to choose one.
    if accounts(&d).len() > 1 {
        assert_eq!(
            imp(d.view(i)).status.as_ref().unwrap().sentence,
            "Choose the account first."
        );
        assert_eq!(
            imp(d.view(i)).phase,
            wire::money_import_state::Phase::Idle as i32
        );
        event(
            &mut d,
            i,
            iev(ie::Kind::AccountPicked(ie::AccountPicked {
                account_id: account,
            })),
        );
    }
    assert_eq!(
        imp(d.view(i)).phase,
        wire::money_import_state::Phase::Planned as i32
    );
    let statement = &data(d.view(i)).statements[0];
    assert_eq!(statement.counts[0].label, "New");
    assert_eq!(statement.counts[0].detail, "5");
    assert_eq!(statement.rows.len(), 5);
    assert_eq!(data(d.view(i)).publish_label, "Import 5 rows");

    let before = home_rows_marker(&d);
    event(&mut d, i, iev(ie::Kind::Publish(ie::Publish {})));
    assert_eq!(
        imp(d.view(i)).phase,
        wire::money_import_state::Phase::Published as i32
    );
    assert_eq!(
        imp(d.view(i)).status.as_ref().unwrap().sentence,
        "Imported 5 rows"
    );
    assert_eq!(data(d.view(i)).file_value, "Statement.csv");
    assert_eq!(data(d.view(i)).done_label, "Done");
    assert_ne!(before, home_rows_marker(&d), "the rows are in the vault");
    // A second tap writes nothing.
    event(&mut d, i, iev(ie::Kind::Publish(ie::Publish {})));
    assert_eq!(
        imp(d.view(i)).status.as_ref().unwrap().sentence,
        "Imported 5 rows"
    );
    event(&mut d, i, iev(ie::Kind::Done(ie::Done {})));
    assert!(imp(d.view(i)).finished);
}

/// How many lines the vault holds now, by what Activity reads.
fn home_rows_marker(d: &Driver) -> usize {
    use centraid_screens::catalog::load;
    let wire::app_query_response::Answer::MoneyActivity(activity) = load_answer(
        d,
        load::money::Activity {
            month: "2026-09".to_owned(),
            limit: 500,
            ..Default::default()
        },
    ) else {
        panic!("not activity");
    };
    activity.rows.len()
}

#[test]
fn leaving_drops_the_file_and_the_plan() {
    let (mut d, i) = opened();
    let (account, _) = accounts(&d).remove(0);
    pick(&mut d, i, "Statement.csv", CSV);
    if accounts(&d).len() > 1 {
        event(
            &mut d,
            i,
            iev(ie::Kind::AccountPicked(ie::AccountPicked {
                account_id: account,
            })),
        );
    }
    assert!(!data(d.view(i)).statements.is_empty());
    event(&mut d, i, wire::screen_event::Kind::Left(wire::Left {}));
    assert!(data(d.view(i)).statements.is_empty());
    assert_eq!(data(d.view(i)).file_value, "No file chosen");
}

#[test]
fn a_cancelled_pick_changes_nothing_and_discard_starts_over() {
    let (mut d, i) = opened();
    event(&mut d, i, iev(ie::Kind::Choose(ie::ChooseTapped {})));
    d.answer_effect(wire::effect_result::Outcome::BytesPicked(
        wire::BytesPicked {
            cancelled: true,
            ..Default::default()
        },
    ));
    assert_eq!(data(d.view(i)).file_value, "No file chosen");
    let (account, _) = accounts(&d).remove(0);
    pick(&mut d, i, "Statement.csv", CSV);
    if accounts(&d).len() > 1 {
        event(
            &mut d,
            i,
            iev(ie::Kind::AccountPicked(ie::AccountPicked {
                account_id: account,
            })),
        );
    }
    event(&mut d, i, iev(ie::Kind::Discard(ie::Discard {})));
    assert_eq!(data(d.view(i)).file_value, "No file chosen");
    assert_eq!(data(d.view(i)).discard_label, "");
}

#[test]
fn a_file_that_cannot_name_its_date_order_asks_and_the_answer_plans_it_again() {
    let (mut d, i) = opened();
    let (account, _) = accounts(&d).remove(0);
    let ambiguous = "Date,Description,Amount\n03/04/2025,A,-1.00\n05/06/2025,B,-2.00\n07/08/2025,C,-3.00\n09/10/2025,D,-4.00\n11/12/2025,E,-5.00\n";
    pick(&mut d, i, "a.csv", ambiguous);
    if accounts(&d).len() > 1 {
        event(
            &mut d,
            i,
            iev(ie::Kind::AccountPicked(ie::AccountPicked {
                account_id: account,
            })),
        );
    }
    let question = data(d.view(i)).statements[0]
        .question
        .clone()
        .expect("a question");
    assert_eq!(
        question
            .options
            .iter()
            .map(|o| o.key.as_str())
            .collect::<Vec<_>>(),
        ["mdy", "dmy"]
    );
    // While it is asked there is nothing to import.
    assert_eq!(data(d.view(i)).publish_label, "");
    event(
        &mut d,
        i,
        iev(ie::Kind::DateOrder(ie::DateOrderPicked {
            order: "dmy".into(),
        })),
    );
    let statement = &data(d.view(i)).statements[0];
    assert!(statement.question.is_none());
    assert_eq!(data(d.view(i)).publish_label, "Import 5 rows");
}

#[test]
fn rows_proposed_as_duplicates_are_skipped_unless_the_member_says_otherwise() {
    let (mut d, i) = opened();
    let (account, _) = accounts(&d).remove(0);
    let choose_account = |d: &mut Driver, i: u64| {
        if accounts(d).len() > 1 {
            event(
                d,
                i,
                iev(ie::Kind::AccountPicked(ie::AccountPicked {
                    account_id: account.clone(),
                })),
            );
        }
    };
    pick(&mut d, i, "first.csv", CSV);
    choose_account(&mut d, i);
    event(&mut d, i, iev(ie::Kind::Publish(ie::Publish {})));
    assert_eq!(
        imp(d.view(i)).status.as_ref().unwrap().sentence,
        "Imported 5 rows"
    );

    // The same lines a day later look alike: proposed, never written on their own.
    let shifted = "Date,Description,Amount\n2026-09-02,GROCER A,-20.00\n2026-09-04,GROCER B,-30.00\n2026-09-09,GROCER C,-40.00\n2026-09-11,GROCER D,-50.00\n2026-09-13,GROCER E,-60.00\n";
    pick(&mut d, i, "second.csv", shifted);
    choose_account(&mut d, i);
    let statement = &data(d.view(i)).statements[0];
    assert!(statement.has_proposed);
    let check = statement
        .counts
        .iter()
        .find(|c| c.label == "Check these")
        .expect("a Check these count");
    assert_eq!(check.detail, "5");
    assert_eq!(
        check.tone,
        wire::status_chip::Tone::Seam as i32,
        "lines owed a look carry their tone"
    );
    assert_eq!(
        data(d.view(i)).publish_label,
        "",
        "nothing new, nothing to import"
    );

    event(
        &mut d,
        i,
        iev(ie::Kind::KeepProposed(ie::KeepProposedToggled {})),
    );
    assert!(imp(d.view(i)).keep_proposed);
    assert_eq!(data(d.view(i)).publish_label, "Import 5 rows");
    event(&mut d, i, iev(ie::Kind::Publish(ie::Publish {})));
    assert_eq!(
        imp(d.view(i)).status.as_ref().unwrap().sentence,
        "Imported 5 rows"
    );
}

/// A statement whose amounts are all positive and which names no direction:
/// the core guesses which sign means money out, says so, and offers the two
/// answers.
const POSITIVE_ONLY: &str = "Date,Description,Amount\n2026-09-01,GROCER A,20.00\n2026-09-03,GROCER B,30.00\n2026-09-08,GROCER C,40.00\n2026-09-10,GROCER D,50.00\n2026-09-12,GROCER E,60.00\n";

#[test]
fn a_guessed_sign_is_said_and_the_answer_plans_the_file_again() {
    let (mut d, i) = opened();
    let (account, _) = accounts(&d).remove(0);
    pick(&mut d, i, "a.csv", POSITIVE_ONLY);
    if accounts(&d).len() > 1 {
        event(
            &mut d,
            i,
            iev(ie::Kind::AccountPicked(ie::AccountPicked {
                account_id: account,
            })),
        );
    }
    let statement = data(d.view(i)).statements[0].clone();
    assert_eq!(
        statement.warnings,
        ["Which sign means money out was guessed."]
    );
    assert_eq!(statement.sign_label, "Money out is");
    let options: Vec<_> = statement
        .sign_options
        .iter()
        .map(|o| (o.key.as_str(), o.label.as_str(), o.selected))
        .collect();
    assert_eq!(
        options,
        [
            ("debits_negative", "Negative", false),
            ("debits_positive", "Positive", false)
        ]
    );
    // The member's answer is taken, and the file is planned again under it.
    event(
        &mut d,
        i,
        iev(ie::Kind::Sign(ie::SignPicked {
            choice: "debits_positive".into(),
        })),
    );
    // Said once answered: the guess is gone, so the warning and the two
    // choices are too, and the file is ready to import.
    let again = &data(d.view(i)).statements[0];
    assert!(again.warnings.is_empty() && again.sign_options.is_empty());
    assert_eq!(data(d.view(i)).publish_label, "Import 5 rows");
}
