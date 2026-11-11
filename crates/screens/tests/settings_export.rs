//! Export everything (`home.export`, #1185): Settings carries the row, the page has one row,
//! "Everything on this phone", the owner check comes first, and then a STREAMED file: the core
//! stages one zip on disk and the OS save sheet is offered its path (`SaveFilePath`). Locker's
//! contents are not in it. Every test goes through `Driver`.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::shell;
use centraid_screens::testing::Driver;
use centraid_vault::portable::zip::stored_entries;
use wire::screen_event::Kind as E;

fn started() -> (Driver, u64) {
    let mut d = Driver::with_runtime(shell::runtime());
    d.start();
    let settings = d.push(shell::TAB, shell::routes::settings());
    // The appearance comes from the Keychain; until it answers the page is loading.
    let at = d
        .effects
        .iter()
        .position(|request| {
            request.instance == settings
                && matches!(
                    request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                    Some(wire::effect::Kind::Keychain(op)) if op.key == "appearance"
                )
        })
        .expect("the appearance was asked for");
    let request = d.effects.remove(at);
    d.send(
        settings,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(wire::effect_result::Outcome::Keychain(
                wire::KeychainValue {
                    found: false,
                    value: Vec::new(),
                },
            )),
        }),
    );
    (d, settings)
}

fn settings_row(d: &Driver, settings: u64) -> wire::SettingsRow {
    let Some(wire::view_state::Kind::Settings(state)) = &d.view(settings).kind else {
        panic!("not Settings");
    };
    let Some(wire::settings_state::Content::Data(data)) = &state.content else {
        panic!("Settings is still loading");
    };
    data.sections
        .iter()
        .flat_map(|section| &section.rows)
        .find(|row| row.id == "export")
        .cloned()
        .expect("an Export everything row in Settings")
}

fn transfer(v: &wire::ViewState) -> &wire::TransferView {
    match &v.kind {
        Some(wire::view_state::Kind::Transfer(view)) => view,
        other => panic!("not a transfer: {other:?}"),
    }
}

fn open(d: &mut Driver, settings: u64) -> u64 {
    let route = settings_row(d, settings)
        .route
        .expect("the row has a route");
    d.push(shell::TAB, route)
}

fn tap(d: &mut Driver, i: u64) {
    d.effects.clear();
    d.send(
        i,
        E::Transfer(wire::TransferEvent {
            key: "all".to_owned(),
        }),
    );
}

fn first_kind(d: &Driver) -> Option<wire::effect::Kind> {
    d.effects
        .first()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.clone())
}

fn answer_owner_check(d: &mut Driver, outcome: wire::owner_checked::Outcome, available: bool) {
    while matches!(first_kind(d), Some(wire::effect::Kind::OwnerCheck(_))) {
        d.answer_effect(wire::effect_result::Outcome::OwnerChecked(
            wire::OwnerChecked {
                available,
                outcome: outcome as i32,
                ..wire::OwnerChecked::default()
            },
        ));
    }
}

fn saved_paths(d: &Driver) -> Vec<wire::SaveFilePath> {
    d.effects
        .iter()
        .filter_map(|e| match e.effect.as_ref().and_then(|e| e.kind.clone()) {
            Some(wire::effect::Kind::SaveFilePath(save)) => Some(save),
            _ => None,
        })
        .collect()
}

#[test]
fn settings_has_an_export_row_that_opens_a_page_with_one_row() {
    let (mut d, settings) = started();
    let row = settings_row(&d, settings);
    assert_eq!(row.title, "Export everything");
    assert_eq!(row.route.as_ref().expect("a route").screen, shell::EXPORT);

    let i = open(&mut d, settings);
    let page = transfer(d.view(i));
    assert_eq!(page.title, "Export everything");
    assert_eq!(page.back_label, "Settings");
    assert!(page.lede.contains("Locker"));
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].label, "Everything on this phone");
    assert_eq!(page.rows[0].value, "8 apps; Locker exports on its own");
}

#[test]
fn a_tap_asks_the_owner_check_then_offers_the_staged_archive_to_the_save_sheet() {
    let (mut d, settings) = started();
    let i = open(&mut d, settings);
    tap(&mut d, i);
    assert!(matches!(
        first_kind(&d),
        Some(wire::effect::Kind::OwnerCheck(_))
    ));
    assert!(
        saved_paths(&d).is_empty(),
        "nothing is made before the check"
    );
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Succeeded, true);
    let saves = saved_paths(&d);
    assert_eq!(saves.len(), 1);
    let save = &saves[0];
    assert!(save.name.starts_with("Centraid export ") && save.name.ends_with(".zip"));
    assert_eq!(save.media_type, "application/zip");

    let bytes = std::fs::read(&save.path).expect("the staged file is on disk");
    let names: Vec<String> = stored_entries(&bytes)
        .expect("a zip")
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    for want in [
        "README.txt",
        "People/people.vcf",
        "Calendar/calendar.ics",
        "Reminders/reminders.ics",
        "Money/transactions.csv",
        "Health/Daily totals.csv",
        "Health/Workouts.csv",
    ] {
        assert!(names.iter().any(|name| name == want), "{want}: {names:?}");
    }
    assert!(
        !names.iter().any(|name| name.starts_with("Locker")),
        "Locker is not in it: {names:?}"
    );

    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert_eq!(
        transfer(d.view(i))
            .status
            .as_ref()
            .map(|s| s.sentence.as_str()),
        Some(format!("Export saved: {} files", names.len() - 1).as_str()),
        "it counts the files saved, not the README"
    );
}

#[test]
fn a_cancelled_check_makes_no_file() {
    let (mut d, settings) = started();
    let i = open(&mut d, settings);
    tap(&mut d, i);
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Cancelled, true);
    assert!(saved_paths(&d).is_empty());
    assert!(transfer(d.view(i)).status.is_none());
}

#[test]
fn a_phone_with_no_passcode_saves_with_the_warning() {
    let (mut d, settings) = started();
    let i = open(&mut d, settings);
    tap(&mut d, i);
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Unavailable, false);
    assert_eq!(saved_paths(&d).len(), 1, "it goes ahead");
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    let status = transfer(d.view(i)).status.clone().expect("a line");
    assert!(!status.refused);
    assert!(
        status.sentence.starts_with("Export saved: ") && status.sentence.contains(" files. "),
        "the warning rides with the saved line: {}",
        status.sentence
    );
}
