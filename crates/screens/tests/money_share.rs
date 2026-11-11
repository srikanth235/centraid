//! Share one transaction (#1185): the page's Share row asks the owner check, and only a pass hands
//! the line to the OS as one spreadsheet file.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::money::routes;
use money_support::*;
use wire::money_transaction_event as te;

fn kinds(d: &centraid_screens::testing::Driver) -> Vec<wire::effect::Kind> {
    d.effects
        .iter()
        .filter_map(|request| request.effect.as_ref()?.kind.clone())
        .collect()
}

fn data(v: &wire::ViewState) -> &wire::MoneyTransactionData {
    let Some(wire::view_state::Kind::MoneyTransaction(state)) = &v.kind else {
        panic!("not a transaction");
    };
    match &state.content {
        Some(wire::money_transaction_state::Content::Data(data)) => data,
        other => panic!("no data: {other:?}"),
    }
}

fn status(v: &wire::ViewState) -> Option<wire::StatusLine> {
    let Some(wire::view_state::Kind::MoneyTransaction(state)) = &v.kind else {
        panic!("not a transaction");
    };
    state.status.clone()
}

/// A line of this month's Activity.
fn a_line(d: &mut centraid_screens::testing::Driver) -> String {
    let i = land_on(d, wire::MoneyDestination::Activity);
    home_data(d.view(i))
        .activity
        .as_ref()
        .unwrap()
        .sections
        .iter()
        .flat_map(|s| &s.rows)
        .map(|row| row.txn_id.clone())
        .next()
        .expect("a line this month")
}

fn share(d: &mut centraid_screens::testing::Driver, page: u64) {
    d.send(
        page,
        wire::screen_event::Kind::MoneyTransaction(wire::MoneyTransactionEvent {
            kind: Some(te::Kind::Action(te::ActionPicked {
                key: "share".to_owned(),
            })),
        }),
    );
}

fn check(outcome: wire::owner_checked::Outcome) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::OwnerChecked(wire::OwnerChecked {
        available: true,
        outcome: outcome as i32,
        ..wire::OwnerChecked::default()
    })
}

#[test]
fn one_transaction_is_shared_as_one_csv_only_after_the_owner_check() {
    let mut d = driver();
    let id = a_line(&mut d);
    let page = push(&mut d, routes::transaction(&id, "Money"));
    assert!(
        data(d.view(page))
            .actions
            .iter()
            .any(|a| a.key == "share" && a.label == "Share" && a.icon_key == "Share" && a.enabled)
    );
    d.effects.clear();
    share(&mut d, page);
    assert!(matches!(
        kinds(&d).as_slice(),
        [wire::effect::Kind::OwnerCheck(check)] if check.ask
    ));
    d.answer_effect(check(wire::owner_checked::Outcome::Succeeded));
    let Some(wire::effect::Kind::ShareBytes(file)) = kinds(&d).into_iter().last() else {
        panic!("the share sheet was asked for");
    };
    assert!(file.name.ends_with(".csv"), "{}", file.name);
    assert_eq!(file.media_type, "text/csv");
    let text = String::from_utf8_lossy(&file.content);
    assert_eq!(
        text.lines().count(),
        2,
        "the header and the one line: {text}"
    );
}

#[test]
fn a_refused_check_shares_nothing_and_says_why() {
    let mut d = driver();
    let id = a_line(&mut d);
    let page = push(&mut d, routes::transaction(&id, "Money"));
    d.effects.clear();
    share(&mut d, page);
    d.answer_effect(check(wire::owner_checked::Outcome::Failed));
    assert!(
        !kinds(&d)
            .iter()
            .any(|kind| matches!(kind, wire::effect::Kind::ShareBytes(_)))
    );
    let status = status(d.view(page)).expect("a sentence");
    assert!(status.refused);
}
