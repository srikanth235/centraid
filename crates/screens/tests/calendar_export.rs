//! Calendar's export (`calendar.export`, #1185): the kit's export screen with a row for every
//! calendar, an owner check first, and a calendar file handed to the OS save sheet.

mod calendar_support;

use calendar_support::World;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::strings::Locale;
use centraid_screens::{Registry, agenda, calendar};

const NOW: i64 = 1_794_214_800_000;

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

#[test]
fn an_export_saves_an_ics_through_the_os_save_sheet_after_the_owner_check() {
    let mut world = World::seeded_with(
        Registry::default()
            .with(calendar::HOME, calendar::home::build)
            .with(calendar::EXPORT, calendar::export::build),
        NOW,
    );
    world.propose(
        "Review",
        "2026-11-12T14:00:00",
        "2026-11-12T15:00:00",
        |_| {},
    );
    let entry = centraid_screens::kit::export::entry(Locale::En, calendar::EXPORT);
    let i = world.driver.push(agenda::TAB, entry.route);
    let rows = &state(world.driver.view(i)).rows;
    assert_eq!(rows[0].label, "All calendars");
    assert!(rows.len() > 1, "each calendar is a row: {rows:?}");
    world.driver.effects.clear();
    world.driver.send(
        i,
        wire::screen_event::Kind::Transfer(wire::TransferEvent {
            key: "all".to_owned(),
            ..Default::default()
        }),
    );
    pass_owner_check(&mut world.driver);
    let Some(wire::effect::Kind::SaveFile(save)) = world
        .driver
        .effects
        .last()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.clone())
    else {
        panic!("the save sheet was asked for");
    };
    assert_eq!(save.name, "Calendar.ics");
    assert_eq!(save.media_type, "text/calendar");
    let text = String::from_utf8_lossy(&save.content);
    assert!(text.contains("BEGIN:VCALENDAR") && text.contains("SUMMARY:Review"));
    world
        .driver
        .answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert!(
        state(world.driver.view(i))
            .status
            .as_ref()
            .is_some_and(|s| s.sentence == "Export saved")
    );
}
