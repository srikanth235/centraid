//! Money's export (`money.export`, #1185): the kit's export screen with a row for every account,
//! an owner check first, and a spreadsheet file handed to the OS save sheet.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::kit::export;
use centraid_screens::money;
use centraid_screens::strings::Locale;
use money_support::*;

fn state(v: &wire::ViewState) -> &wire::TransferView {
    match &v.kind {
        Some(wire::view_state::Kind::Transfer(view)) => view,
        other => panic!("not a transfer: {other:?}"),
    }
}

fn pass_owner_check(d: &mut centraid_screens::testing::Driver) {
    while matches!(
        d.effects
            .first()
            .and_then(|e| e.effect.as_ref())
            .and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::OwnerCheck(_))
    ) {
        d.answer_effect(wire::effect_result::Outcome::OwnerChecked(
            wire::OwnerChecked {
                available: true,
                outcome: wire::owner_checked::Outcome::Succeeded as i32,
                ..wire::OwnerChecked::default()
            },
        ));
    }
}

fn saved(d: &centraid_screens::testing::Driver) -> wire::SaveFile {
    let Some(wire::effect::Kind::SaveFile(save)) = d
        .effects
        .last()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.clone())
    else {
        panic!("the save sheet was asked for");
    };
    save
}

#[test]
fn money_lists_all_accounts_and_each_account_and_the_more_sheet_opens_it() {
    let mut d = driver();
    let h = land_on(&mut d, wire::MoneyDestination::Activity);
    let more = home_state(d.view(h))
        .chrome
        .as_ref()
        .unwrap()
        .more_rows
        .clone();
    let row = more
        .iter()
        .find(|r| r.route.as_ref().is_some_and(|r| r.screen == money::EXPORT))
        .expect("an Export row in More");
    assert_eq!(row.label, "Export");
    let i = push(&mut d, row.route.clone().unwrap());
    let rows = &state(d.view(i)).rows;
    assert_eq!(rows[0].label, "All accounts");
    let accounts = accounts(&d);
    assert!(!accounts.is_empty());
    assert_eq!(rows.len(), 1 + accounts.len());
    for (_, name) in &accounts {
        assert!(rows.iter().any(|r| &r.label == name), "{name}: {rows:?}");
    }
}

#[test]
fn an_export_saves_a_csv_through_the_os_save_sheet_after_the_owner_check() {
    let mut d = driver();
    let entry = export::entry(Locale::En, money::EXPORT);
    let i = push(&mut d, entry.route);
    d.effects.clear();
    d.send(
        i,
        wire::screen_event::Kind::Transfer(wire::TransferEvent {
            key: "all".to_owned(),
            ..Default::default()
        }),
    );
    pass_owner_check(&mut d);
    let save = saved(&d);
    assert_eq!(save.name, "Transactions.csv");
    assert_eq!(save.media_type, "text/csv");
    let text = String::from_utf8_lossy(&save.content);
    assert!(text.starts_with("Date,Account,Payee,"), "{text}");
    assert!(text.lines().count() > 1);
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert!(
        state(d.view(i))
            .status
            .as_ref()
            .is_some_and(|s| s.sentence == "Export saved")
    );
}

#[test]
fn one_account_is_exported_as_its_own_file() {
    let mut d = driver();
    let (account, name) = accounts(&d).remove(0);
    let entry = export::entry(Locale::En, money::EXPORT);
    let i = push(&mut d, entry.route);
    d.effects.clear();
    d.send(
        i,
        wire::screen_event::Kind::Transfer(wire::TransferEvent {
            key: account,
            ..Default::default()
        }),
    );
    pass_owner_check(&mut d);
    let save = saved(&d);
    assert_eq!(save.name, format!("{name} transactions.csv"));
    let text = String::from_utf8_lossy(&save.content);
    let rows: Vec<&str> = text.lines().skip(1).collect();
    assert!(!rows.is_empty());
    assert!(rows.iter().all(|r| r.contains(&name)), "{text}");
}
