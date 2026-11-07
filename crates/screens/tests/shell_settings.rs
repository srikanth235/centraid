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
        Some(wire::settings_state::Content::Data(data)) => data,
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

#[test]
fn the_platform_answer_changes_the_key_sentence() {
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
    assert!(
        key.starts_with("Saved in iCloud Keychain") || key.starts_with("Backed up with Google")
    );
}
