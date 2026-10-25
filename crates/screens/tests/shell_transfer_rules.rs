//! Home's transfer rules sheet (#1135): the gear beside "N originals waiting" opens it, a choice is
//! kept in the phone's device store and the pass service is told in the same call, exactly as the
//! Backup page does it. The shell draws the sheet and performs the one `SecretBatch`.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::testing::{Driver, FakeShell};
use wire::home_event::Kind as H;
use wire::screen_event::Kind as E;

fn open() -> (Driver, FakeShell, u64) {
    let mut driver = Driver::with_runtime(centraid_screens::standard());
    driver.start();
    driver.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: "en-US".to_owned(),
        zone: "UTC".to_owned(),
        platform: "android".to_owned(),
        ..Default::default()
    }));
    let home = driver.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    let mut shell = FakeShell::default();
    driver.serve(&mut shell);
    (driver, shell, home)
}

fn say(driver: &mut Driver, home: u64, kind: H) {
    driver.send(home, E::Home(wire::HomeEvent { kind: Some(kind) }));
}

fn sheet(driver: &Driver, home: u64) -> Option<wire::HomeTransferSheet> {
    match &driver.view(home).kind {
        Some(wire::view_state::Kind::Home(state)) => state.transfer_sheet.clone(),
        other => panic!("not Home: {other:?}"),
    }
}

fn schedules(driver: &Driver) -> usize {
    driver
        .effects
        .iter()
        .filter(|request| {
            matches!(
                request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                Some(wire::effect::Kind::ScheduleWindows(_))
            )
        })
        .count()
}

#[test]
fn the_transfer_sheet_keeps_the_choice_and_tells_the_pass_service_in_the_same_call() {
    let (mut driver, mut shell, home) = open();
    assert!(sheet(&driver, home).is_none());
    say(
        &mut driver,
        home,
        H::TransferRulesPressed(wire::home_event::TransferRulesPressed {}),
    );
    let open = sheet(&driver, home).expect("the sheet opens");
    assert_eq!(open.choices.len(), 3);
    assert_eq!(
        open.choices
            .iter()
            .map(|choice| choice.picked)
            .collect::<Vec<_>>(),
        vec![true, false, false]
    );
    assert!(!open.title.is_empty() && !open.subtitle.is_empty());
    driver.effects.retain(|request| {
        !matches!(
            request.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::ScheduleWindows(_))
        )
    });
    say(
        &mut driver,
        home,
        H::TransferRuleChosen(wire::home_event::TransferRuleChosen {
            stored: "manual".to_owned(),
        }),
    );
    // THE SHEET CLOSES ON A CHOICE, and the store is the Backup page's.
    assert!(sheet(&driver, home).is_none());
    driver.serve(&mut shell);
    assert_eq!(
        shell.device.get("transfer-rule").map(String::as_str),
        Some("manual")
    );
    // THE SERVICE ASKS THE OS FOR ITS WINDOWS AGAIN under the new rule: nobody else told it.
    assert!(schedules(&driver) > 0, "the windows follow the rule");
    // Opened again, the sheet shows the rule that was kept.
    say(
        &mut driver,
        home,
        H::TransferRulesPressed(wire::home_event::TransferRulesPressed {}),
    );
    let again = sheet(&driver, home).expect("the sheet opens again");
    assert!(again.choices[2].picked);
}
