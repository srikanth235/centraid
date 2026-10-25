//! `backup.home` through the door a shell uses (#1135, lane H2), over a real core:
//! the registered name, the named read `shell.backup-status`, the shell's secret
//! stores and probes answered as a shell answers them, and a pushed page that
//! pops. What the screen decides with every reading is
//! `crates/screens/src/backup/tests.rs`; a paired gateway is
//! `crates/core/tests/shell_backup.rs`.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::backup::{self, routes};
use centraid_screens::testing::{Driver, FakeShell};
use wire::screen_event::Kind as E;

fn open() -> (Driver, FakeShell, u64) {
    let mut driver = Driver::with_runtime(centraid_screens::standard());
    driver.start();
    driver.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: "en-US".to_owned(),
        zone: "UTC".to_owned(),
        platform: "ios".to_owned(),
    }));
    let instance = driver.push("home", routes::home());
    (driver, FakeShell::default(), instance)
}

fn data(driver: &Driver, instance: u64) -> wire::BackupHomeData {
    match &driver.view(instance).kind {
        Some(wire::view_state::Kind::BackupHome(wire::BackupHomeState {
            body: Some(wire::backup_home_state::Body::Data(data)),
        })) => (**data).clone(),
        other => panic!("not a ready Backup screen: {other:?}"),
    }
}

#[test]
fn the_backup_screen_is_registered_and_loads_until_the_phones_settings_are_read() {
    let (mut driver, mut shell, instance) = open();
    assert!(matches!(
        &driver.view(instance).kind,
        Some(wire::view_state::Kind::BackupHome(wire::BackupHomeState {
            body: Some(wire::backup_home_state::Body::Loading(_))
        }))
    ));
    // The shell's two stores and the platform's keychain probe are answered the way
    // a shell answers them; the background probe is the shell's own and stays for us.
    driver.serve(&mut shell);
    let background = driver
        .effects
        .iter()
        .position(|request| {
            // The `backup` tab's own root asks too: this is the pushed page's.
            request.instance == instance
                && matches!(
                    request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                    Some(wire::effect::Kind::BackgroundProbe(_))
                )
        })
        .expect("the screen asks whether the platform will wake Centraid");
    let asked = driver.effects.remove(background);
    assert_eq!(asked.instance, instance);
    driver.send(
        instance,
        E::EffectResult(wire::EffectResult {
            effect_id: asked.effect_id,
            outcome: Some(wire::effect_result::Outcome::BackgroundStatus(
                wire::BackgroundStatus { registered: false },
            )),
        }),
    );
    let data = data(&driver, instance);
    assert_eq!(
        data.background_notice,
        "Background App Refresh is off, so Centraid only catches up when you open it."
    );
}

#[test]
fn an_unpaired_vault_offers_pairing_not_a_status_and_no_dead_primary() {
    let (mut driver, mut shell, instance) = open();
    driver.serve(&mut shell);
    let data = data(&driver, instance);
    let line = data.line.expect("the line");
    assert!(line.unpaired);
    assert_eq!(line.sentence, "Not backed up. Pair a backup device.");
    assert!(data.destinations.is_empty());
    assert_eq!(data.devices_heading, "");
    assert_eq!(data.back_up_now_label, "");
    assert!(!data.back_up_now_enabled);
    // PAIRING IS THE PAGE'S ONE THING TO DO, and it is a route the shell pushes.
    assert_eq!(data.ink, wire::BackupInk::AddDestination as i32);
    assert_eq!(data.add_destination, Some(routes::add_destination()));
    assert_eq!(data.add_destination_label, "Add backup device");
    // A phone with no key has no key section.
    assert_eq!(data.key_heading, "");
    // The rule's three sentences, the default picked; videos included.
    assert_eq!(data.rule_choices.len(), 3);
    assert!(data.rule_choices[0].picked);
    assert!(data.include_videos);
}

#[test]
fn the_rule_the_member_chose_is_kept_by_the_shell_and_comes_back() {
    let (mut driver, mut shell, instance) = open();
    driver.serve(&mut shell);
    driver.send(
        instance,
        E::BackupHome(wire::BackupHomeEvent {
            kind: Some(wire::backup_home_event::Kind::RuleChosen(
                wire::backup_home_event::RuleChosen {
                    stored: "manual".to_owned(),
                },
            )),
        }),
    );
    driver.send(
        instance,
        E::BackupHome(wire::BackupHomeEvent {
            kind: Some(wire::backup_home_event::Kind::SetIncludeVideos(
                wire::backup_home_event::SetIncludeVideos { include: false },
            )),
        }),
    );
    driver.serve(&mut shell);
    assert_eq!(
        shell.device.get("transfer-rule").map(String::as_str),
        Some("manual")
    );
    assert_eq!(
        shell
            .device
            .get("transfer-rule.include-videos")
            .map(String::as_str),
        Some("excluded")
    );
    // Closed and opened again, it reads them back.
    driver.pop("home", instance);
    let again = driver.push("home", routes::home());
    driver.serve(&mut shell);
    let data = data(&driver, again);
    assert!(data.rule_choices[2].picked && !data.include_videos);
}

#[test]
fn choosing_a_rule_tells_the_pass_service_in_the_same_call_that_the_write_is_answered() {
    let (mut driver, mut shell, instance) = open();
    driver.serve(&mut shell);
    let windows = |driver: &Driver| {
        driver
            .effects
            .iter()
            .filter_map(
                |request| match request.effect.as_ref().and_then(|e| e.kind.as_ref()) {
                    Some(wire::effect::Kind::ScheduleWindows(schedule)) => Some(schedule.clone()),
                    _ => None,
                },
            )
            .last()
    };
    let before = windows(&driver).map(|schedule| schedule.windows.len());
    driver.effects.retain(|request| {
        !matches!(
            request.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::ScheduleWindows(_))
        )
    });
    driver.send(
        instance,
        E::BackupHome(wire::BackupHomeEvent {
            kind: Some(wire::backup_home_event::Kind::RuleChosen(
                wire::backup_home_event::RuleChosen {
                    stored: "manual".to_owned(),
                },
            )),
        }),
    );
    driver.serve(&mut shell);
    // NO ASK FROM THE SHELL: the screen's own write is what the service hears,
    // and it asks the OS for its windows again under the new rule.
    let schedule = windows(&driver)
        .unwrap_or_else(|| panic!("the service asks for the windows again (before: {before:?})"));
    assert_eq!(schedule.windows[0].link, wire::WindowLink::Unmetered as i32);
}

#[test]
fn a_pushed_backup_page_pops_and_its_timers_die_with_it() {
    let (mut driver, mut shell, instance) = open();
    driver.serve(&mut shell);
    assert_eq!(backup::HOME, "backup.home");
    let update = driver.pop("home", instance);
    assert!(update.closed.contains(&instance));
    // A change the screen no longer reads is not heard by anything.
    assert_eq!(driver.pump(std::time::Duration::from_millis(60)), 0);
}

/// THERE IS NO SECOND SWITCH FOR PHOTOGRAPHS (the KMP `CameraRollSpec`): the member's one rule
/// governs originals, so choosing "photos on cellular" writes the rule's one key and nothing
/// else. The videos switch is the rule's own refinement (`transfer-rule.include-videos`), written
/// only when the member moves it.
#[test]
fn choosing_photos_on_cellular_writes_the_one_rule_and_no_second_switch() {
    let (mut driver, mut shell, instance) = open();
    driver.serve(&mut shell);
    driver.send(
        instance,
        E::BackupHome(wire::BackupHomeEvent {
            kind: Some(wire::backup_home_event::Kind::RuleChosen(
                wire::backup_home_event::RuleChosen {
                    stored: "wifi-and-cellular-photos".to_owned(),
                },
            )),
        }),
    );
    driver.serve(&mut shell);
    let keys: Vec<&str> = shell
        .device
        .keys()
        .map(String::as_str)
        .filter(|key| key.contains("rule") || key.contains("photo") || key.contains("cellular"))
        .collect();
    assert_eq!(keys, ["transfer-rule"]);
    assert_eq!(
        shell.device.get("transfer-rule").map(String::as_str),
        Some("wifi-and-cellular-photos")
    );
}
