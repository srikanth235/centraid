//! Share one event (#1185, take out): the page's Share row asks the owner check, and only a pass
//! hands the event to the OS as one calendar file.

mod calendar_support;

use calendar_support::World;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::{Registry, calendar};
use wire::agenda_event_event::Kind as K;

fn kinds(d: &centraid_screens::testing::Driver) -> Vec<wire::effect::Kind> {
    d.effects
        .iter()
        .filter_map(|request| request.effect.as_ref()?.kind.clone())
        .collect()
}

fn world() -> World {
    World::seeded_with(
        Registry::default().with(calendar::HOME, calendar::home::build),
        1_794_214_800_000,
    )
}

fn share(world: &mut World, page: u64) {
    world.send_event(
        page,
        K::Action(wire::agenda_event_event::ActionPicked {
            key: "share".to_owned(),
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
fn one_event_is_shared_as_one_ics_only_after_the_owner_check() {
    let mut world = world();
    let review = world.propose(
        "Review",
        "2026-11-12T14:00:00",
        "2026-11-12T15:00:00",
        |_| {},
    );
    world.propose(
        "Lunch",
        "2026-11-12T12:00:00",
        "2026-11-12T13:00:00",
        |_| {},
    );
    let page = world.open_event(&review, &review, None, "2026-11-12");
    assert!(
        world
            .event_data(page)
            .actions
            .iter()
            .any(|a| a.key == "share" && a.label == "Share")
    );
    world.driver.effects.clear();
    share(&mut world, page);
    assert!(matches!(
        kinds(&world.driver).as_slice(),
        [wire::effect::Kind::OwnerCheck(check)] if check.ask
    ));
    world
        .driver
        .answer_effect(check(wire::owner_checked::Outcome::Succeeded));
    let Some(wire::effect::Kind::ShareBytes(file)) = kinds(&world.driver).into_iter().last() else {
        panic!("the share sheet was asked for");
    };
    assert_eq!(file.name, "Review.ics");
    assert_eq!(file.media_type, "text/calendar");
    let text = String::from_utf8_lossy(&file.content);
    assert_eq!(text.matches("BEGIN:VEVENT").count(), 1);
    assert!(text.contains("SUMMARY:Review") && !text.contains("Lunch"));
}

#[test]
fn a_refused_check_shares_nothing_and_says_why() {
    let mut world = world();
    let review = world.propose(
        "Review",
        "2026-11-12T14:00:00",
        "2026-11-12T15:00:00",
        |_| {},
    );
    let page = world.open_event(&review, &review, None, "2026-11-12");
    world.driver.effects.clear();
    share(&mut world, page);
    world
        .driver
        .answer_effect(check(wire::owner_checked::Outcome::Failed));
    assert!(
        !kinds(&world.driver)
            .iter()
            .any(|kind| matches!(kind, wire::effect::Kind::ShareBytes(_)))
    );
    let status = world.event_state(page).status.clone().expect("a sentence");
    assert!(status.refused);
}
