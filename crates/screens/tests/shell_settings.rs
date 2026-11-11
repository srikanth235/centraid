//! Settings (#1173): the appearance choice, the rows that open Backup and the recovery key, and
//! the one-store rule that wakes Home when the choice changes.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::shell;
use centraid_screens::testing::Driver;
use wire::screen_event::Kind as E;

fn started() -> (Driver, u64, u64) {
    let mut d = Driver::with_runtime(shell::runtime());
    d.start();
    let home = d.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    let settings = d.push(shell::TAB, shell::routes::settings());
    (d, home, settings)
}

fn state(d: &Driver, i: u64) -> wire::SettingsState {
    match &d.view(i).kind {
        Some(wire::view_state::Kind::Settings(state)) => state.clone(),
        other => panic!("not Settings: {other:?}"),
    }
}

fn data(d: &Driver, i: u64) -> wire::SettingsData {
    match state(d, i).content {
        Some(wire::settings_state::Content::Data(data)) => *data,
        other => panic!("not data: {other:?}"),
    }
}

/// Answer the oldest effect of `instance` that `is` picks.
fn answer(
    d: &mut Driver,
    instance: u64,
    is: impl Fn(&wire::effect::Kind) -> bool,
    outcome: wire::effect_result::Outcome,
) {
    let at = d
        .effects
        .iter()
        .position(|request| {
            request.instance == instance
                && request
                    .effect
                    .as_ref()
                    .and_then(|e| e.kind.as_ref())
                    .is_some_and(&is)
        })
        .expect("the effect was asked");
    let request = d.effects.remove(at);
    d.send(
        instance,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(outcome),
        }),
    );
}

fn keychain_get(kind: &wire::effect::Kind) -> bool {
    matches!(kind, wire::effect::Kind::Keychain(op) if op.key == "appearance" && op.op == wire::keychain_op::Op::Get as i32)
}

fn stored(value: &str) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::Keychain(wire::KeychainValue {
        found: !value.is_empty(),
        value: value.as_bytes().to_vec(),
    })
}

fn selected(data: &wire::SettingsData) -> Vec<String> {
    data.appearance
        .as_ref()
        .unwrap()
        .choices
        .iter()
        .filter(|choice| choice.selected)
        .map(|choice| choice.id.clone())
        .collect()
}

#[test]
fn settings_is_loading_until_the_keychain_has_said_what_was_chosen() {
    let (mut d, _home, i) = started();
    assert!(matches!(
        state(&d, i).content,
        Some(wire::settings_state::Content::Loading(_))
    ));
    assert_eq!(state(&d, i).title, "Settings");
    assert_eq!(state(&d, i).back_label, "Home");
    answer(&mut d, i, keychain_get, stored("dark"));
    assert_eq!(selected(&data(&d, i)), ["dark"]);
}

#[test]
fn nothing_stored_is_the_system_appearance_and_the_three_choices_are_in_order() {
    let (mut d, _home, i) = started();
    answer(&mut d, i, keychain_get, stored(""));
    let data = data(&d, i);
    let appearance = data.appearance.as_ref().unwrap();
    assert_eq!(appearance.title, "Appearance");
    let labels: Vec<&str> = appearance
        .choices
        .iter()
        .map(|c| c.label.as_str())
        .collect();
    assert_eq!(labels, ["System", "Light", "Dark"]);
    assert_eq!(selected(&data), ["system"]);
    assert_eq!(
        appearance.note,
        "System follows your phone. Text follows your phone's text size."
    );
}

#[test]
fn a_keychain_that_cannot_answer_leaves_the_system_appearance_not_a_spinner() {
    let (mut d, _home, i) = started();
    answer(
        &mut d,
        i,
        keychain_get,
        wire::effect_result::Outcome::Failed(wire::EffectFailed::default()),
    );
    assert_eq!(selected(&data(&d, i)), ["system"]);
}

#[test]
fn picking_is_kept_by_home_in_its_one_key_and_home_draws_that_scheme() {
    let (mut d, home, i) = started();
    // Home read its own key when it opened; settle it on the phone's scheme.
    answer(&mut d, home, keychain_get, stored(""));
    answer(&mut d, i, keychain_get, stored(""));

    d.send(
        i,
        E::Settings(wire::SettingsEvent {
            kind: Some(wire::settings_event::Kind::AppearancePicked(
                wire::settings_event::AppearancePicked { id: "dark".into() },
            )),
        }),
    );
    assert_eq!(selected(&data(&d, i)), ["dark"]);
    // HOME writes its own key with the value (the one owner of the store).
    let written = d
        .effects
        .iter()
        .find_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            wire::effect::Kind::Keychain(op)
                if op.op == wire::keychain_op::Op::Set as i32 && request.instance == home =>
            {
                Some(op.value.clone())
            }
            _ => None,
        })
        .expect("the choice is written");
    assert_eq!(written, b"dark");
    // And it draws the scheme at once.
    match &d.view(home).kind {
        Some(wire::view_state::Kind::Home(home)) => {
            assert_eq!(home.scheme, wire::HomeScheme::Dark as i32);
        }
        other => panic!("not Home: {other:?}"),
    }
}

#[test]
fn choosing_system_stores_nothing_and_choosing_what_is_chosen_does_nothing() {
    let (mut d, _home, i) = started();
    answer(&mut d, i, keychain_get, stored("light"));
    let before = d.effects.len();
    let pick = |d: &mut Driver, id: &str| {
        d.send(
            i,
            E::Settings(wire::SettingsEvent {
                kind: Some(wire::settings_event::Kind::AppearancePicked(
                    wire::settings_event::AppearancePicked { id: id.into() },
                )),
            }),
        );
    };
    pick(&mut d, "light");
    assert_eq!(
        d.effects.len(),
        before,
        "the choice already made asks nothing"
    );
    pick(&mut d, "sepia");
    assert_eq!(d.effects.len(), before, "an unknown choice asks nothing");
    pick(&mut d, "system");
    let op = d
        .effects
        .iter()
        .rev()
        .find_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            wire::effect::Kind::Keychain(op) if op.op == wire::keychain_op::Op::Set as i32 => {
                Some(op.clone())
            }
            _ => None,
        })
        .expect("the choice is written");
    assert!(op.value.is_empty(), "following the phone stores nothing");
    assert_eq!(selected(&data(&d, i)), ["system"]);
}

#[test]
fn the_rows_say_where_things_stand_and_open_the_pages_that_own_them() {
    let (mut d, _home, i) = started();
    answer(&mut d, i, keychain_get, stored(""));
    let data = data(&d, i);
    let keys: Vec<&str> = data.sections.iter().map(|s| s.key.as_str()).collect();
    assert_eq!(keys, ["vault", "backup", "recovery-key"]);
    let row = |section: usize| data.sections[section].rows[0].clone();
    // One vault in the fixture: no route, a sentence that counts.
    assert_eq!(row(0).title, "Vaults");
    assert_eq!(row(0).meta, "This phone has one vault.");
    assert!(row(0).route.is_none());
    // Backup and the recovery key open the pages that own them.
    assert_eq!(row(1).route.as_ref().unwrap().screen, "backup.home");
    // Reconnect phone data opens the page that lists what another phone followed (#1185).
    let reconnect = data.sections[1]
        .rows
        .iter()
        .find(|row| row.id == "reconnect")
        .expect("a Reconnect row");
    assert_eq!(reconnect.route.as_ref().unwrap().screen, "follow.reconnect");
    assert_eq!(row(2).title, "Show recovery key");
    assert_eq!(row(2).route.as_ref().unwrap().screen, "words.show");
    // Until the platform says, the key's sentence is the cautious one.
    assert_eq!(
        row(2).meta,
        "Can't tell whether your recovery key is saved elsewhere. Save a copy."
    );
    assert!(
        row(2)
            .accessibility_label
            .starts_with("Show recovery key, ")
    );
    assert_eq!(data.version_title, "Version");
    assert_eq!(data.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(data.about_title, "About");
}

fn home_state(d: &Driver, i: u64) -> wire::HomeState {
    match &d.view(i).kind {
        Some(wire::view_state::Kind::Home(state)) => (**state).clone(),
        other => panic!("not Home: {other:?}"),
    }
}

#[test]
fn the_vault_row_opens_homes_switcher_and_steps_aside() {
    let (mut d, home, i) = started();
    answer(&mut d, i, keychain_get, stored(""));
    let vaults = data(&d, i).sections[0].rows[0].clone();
    // It has no page to push, but it is pressed, and says so (the board's chevron).
    assert!(vaults.route.is_none() && vaults.pressable);
    assert!(
        data(&d, i)
            .sections
            .iter()
            .flat_map(|s| &s.rows)
            .all(|row| {
                row.pressable == matches!(row.id.as_str(), "vaults" | "download-settings")
            }),
        "only the vault and download rows are pressed rather than pushed"
    );
    // Home holds a roster to list: the lockup's own sheet needs one.
    let personal = wire::ShellVault {
        vault_id: "v1".into(),
        name: "Personal".into(),
        state: wire::HomeVaultState::Online as i32,
        ..Default::default()
    };
    d.send(
        home,
        E::Home(wire::HomeEvent {
            kind: Some(wire::home_event::Kind::VaultsTold(
                wire::home_event::VaultsTold {
                    vault: Some(personal.clone()),
                    vaults: vec![personal],
                    none: false,
                },
            )),
        }),
    );
    assert!(home_state(&d, home).sheet.is_none());
    assert!(!state(&d, i).finished);

    d.send(
        i,
        E::Settings(wire::SettingsEvent {
            kind: Some(wire::settings_event::Kind::RowPressed(
                wire::settings_event::RowPressed {
                    id: "vaults".into(),
                },
            )),
        }),
    );
    // Home draws the switcher the lockup opens, and this page hands over.
    assert!(
        home_state(&d, home).sheet.is_some(),
        "Home's switcher is open"
    );
    assert!(state(&d, i).finished);

    // A row that is not pressed does nothing here.
    let (mut d, home, i) = started();
    answer(&mut d, i, keychain_get, stored(""));
    d.send(
        i,
        E::Settings(wire::SettingsEvent {
            kind: Some(wire::settings_event::Kind::RowPressed(
                wire::settings_event::RowPressed {
                    id: "backup".into(),
                },
            )),
        }),
    );
    assert!(!state(&d, i).finished);
    assert!(home_state(&d, home).sheet.is_none());
}

#[test]
fn each_row_names_its_tile_as_the_board_draws_it() {
    let (mut d, _home, i) = started();
    answer(&mut d, i, keychain_get, stored(""));
    let data = data(&d, i);
    let row = |section: usize| data.sections[section].rows[0].clone();
    // The vault row wears the vault's round initial, never a glyph tile.
    assert_eq!(row(0).tile, "initial");
    assert_eq!(row(0).initial.chars().count(), 1);
    // Backup wears the page's own colour; the recovery key the state-amber fill.
    assert_eq!(row(1).tile, "");
    assert_eq!(row(2).tile, "amber");
}

#[test]
fn the_board_rows_make_a_vault_and_name_the_download_rule() {
    let (mut d, _home, i) = started();
    answer(&mut d, i, keychain_get, stored(""));
    let data = data(&d, i);
    // Make a vault opens the page that makes one, under the vault row.
    let make = &data.sections[0].rows[1];
    assert_eq!(make.title, "Make a vault");
    assert_eq!(make.tile, "add");
    assert_eq!(make.route.as_ref().unwrap().screen, "words.make");
    // Download settings shows the one rule (the default until the store is read) and opens its
    // own sheet, not the Backup page.
    let download = &data.sections[1].rows[1];
    assert_eq!(download.title, "Download settings");
    assert_eq!(download.value, "Wi-Fi only");
    assert_eq!(download.tile, "neutral");
    assert!(download.route.is_none() && download.pressable);
}

fn sheet_event(d: &mut Driver, i: u64, kind: wire::settings_event::Kind) {
    d.send(i, E::Settings(wire::SettingsEvent { kind: Some(kind) }));
}

#[test]
fn download_settings_opens_a_sheet_of_the_one_rule_and_a_pick_keeps_it() {
    use wire::settings_event::{Kind as S, RowPressed, TransferRuleChosen, TransferRulesClosed};
    let (mut d, _home, i) = started();
    answer(&mut d, i, keychain_get, stored(""));
    assert!(state(&d, i).transfer_sheet.is_none());

    sheet_event(
        &mut d,
        i,
        S::RowPressed(RowPressed {
            id: "download-settings".into(),
        }),
    );
    let sheet = state(&d, i).transfer_sheet.expect("the sheet is open");
    assert_eq!(sheet.title, "Downloads");
    let picked: Vec<&str> = sheet
        .choices
        .iter()
        .filter(|choice| choice.picked)
        .map(|choice| choice.stored.as_str())
        .collect();
    assert_eq!(picked, ["wifi-only"], "the default until the store says");
    assert_eq!(sheet.choices.len(), 3);

    // CLOSING WRITES NOTHING.
    sheet_event(&mut d, i, S::TransferRulesClosed(TransferRulesClosed {}));
    assert!(state(&d, i).transfer_sheet.is_none());

    // A PICK IS ONE WRITE TO THE DEVICE STORE, and the sheet closes behind it.
    sheet_event(
        &mut d,
        i,
        S::RowPressed(RowPressed {
            id: "download-settings".into(),
        }),
    );
    let before = d.effects.len();
    sheet_event(
        &mut d,
        i,
        S::TransferRuleChosen(TransferRuleChosen {
            stored: "manual".into(),
        }),
    );
    assert!(state(&d, i).transfer_sheet.is_none());
    assert!(
        d.effects[before..].iter().any(|request| matches!(
            request.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::Secrets(batch)) if batch.ops.iter().any(|op| op.key == "transfer-rule" && op.value == b"manual")
        )),
        "the rule is written to the device store"
    );
}

#[test]
fn a_platform_sync_capability_does_not_claim_an_unknown_key_is_saved() {
    let (mut d, _home, i) = started();
    answer(&mut d, i, keychain_get, stored(""));
    answer(
        &mut d,
        i,
        |kind| matches!(kind, wire::effect::Kind::SyncedProbe(_)),
        wire::effect_result::Outcome::SyncedStatus(wire::SyncedSecretsStatus {
            synchronizing: true,
            restores_after_setup: false,
        }),
    );
    let key = data(&d, i).sections[2].rows[0].meta.clone();
    assert_eq!(
        key,
        "Can't tell whether your recovery key is saved elsewhere. Save a copy."
    );
}

fn units_environment(d: &mut Driver, locale: &str) {
    d.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: locale.to_owned(),
        zone: "UTC".to_owned(),
        platform: "ios".to_owned(),
        ..Default::default()
    }));
}

fn units_choices(data: &wire::SettingsData) -> Vec<(String, bool)> {
    data.units
        .as_ref()
        .expect("the units row")
        .choices
        .iter()
        .map(|choice| (choice.id.clone(), choice.selected))
        .collect()
}

fn units_write(kind: &wire::effect::Kind) -> bool {
    matches!(kind, wire::effect::Kind::Secrets(batch) if batch.ops.iter().any(|op| op.key == "units"))
}

fn units_answer(ok: bool) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::Secrets(wire::SecretBatched {
        answers: vec![wire::SecretAnswer {
            ok,
            ..Default::default()
        }],
    })
}

#[test]
fn the_units_row_shows_the_regions_system_until_the_member_chooses() {
    for (locale, shown) in [("en-US", "imperial"), ("de-DE", "metric")] {
        let (mut d, _home, i) = started();
        units_environment(&mut d, locale);
        answer(&mut d, i, keychain_get, stored(""));
        let data = data(&d, i);
        let units = data.units.as_ref().expect("the units row");
        assert_eq!(units.title, "Units");
        assert_eq!(
            units
                .choices
                .iter()
                .map(|choice| choice.label.as_str())
                .collect::<Vec<_>>(),
            ["Metric", "Imperial"]
        );
        assert!(units.note.contains("temperatures in every app"));
        assert_eq!(
            units_choices(&data)
                .into_iter()
                .filter(|(_, picked)| *picked)
                .map(|(id, _)| id)
                .collect::<Vec<_>>(),
            [shown],
            "{locale}"
        );
    }
}

#[test]
fn choosing_units_writes_the_device_store_and_the_row_reads_it_back() {
    use wire::settings_event::{Kind as S, UnitsPicked};
    let (mut d, _home, i) = started();
    units_environment(&mut d, "de-DE");
    answer(&mut d, i, keychain_get, stored(""));
    let before = d.effects.len();
    sheet_event(
        &mut d,
        i,
        S::UnitsPicked(UnitsPicked {
            id: "imperial".into(),
        }),
    );
    assert!(
        d.effects[before..].iter().any(|request| matches!(
            request.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::Secrets(batch)) if batch.ops.iter().any(|op| op.key == "units" && op.value == b"imperial")
        )),
        "the choice is one write to the device store"
    );
    answer(&mut d, i, units_write, units_answer(true));
    assert_eq!(
        units_choices(&data(&d, i)),
        [("metric".to_owned(), false), ("imperial".to_owned(), true)]
    );
}

#[test]
fn a_refused_units_write_keeps_the_old_choice() {
    use wire::settings_event::{Kind as S, UnitsPicked};
    let (mut d, _home, i) = started();
    units_environment(&mut d, "en-US");
    answer(&mut d, i, keychain_get, stored(""));
    sheet_event(
        &mut d,
        i,
        S::UnitsPicked(UnitsPicked {
            id: "metric".into(),
        }),
    );
    answer(&mut d, i, units_write, units_answer(false));
    assert_eq!(
        units_choices(&data(&d, i)),
        [("metric".to_owned(), false), ("imperial".to_owned(), true)],
        "the region's system stays"
    );
}
