//! Share one reminder (#1185, take out): the page's Share button asks the owner check, and only a
//! pass hands the reminder to the OS as one calendar file.

mod reminders_support;
#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda;
use reminders_support::*;
use wire::todo_detail_event::Kind as D;

fn kinds(d: &centraid_screens::testing::Driver) -> Vec<wire::effect::Kind> {
    d.effects
        .iter()
        .filter_map(|request| request.effect.as_ref()?.kind.clone())
        .collect()
}

fn check(outcome: wire::owner_checked::Outcome) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::OwnerChecked(wire::OwnerChecked {
        available: true,
        outcome: outcome as i32,
        ..wire::OwnerChecked::default()
    })
}

#[test]
fn one_reminder_is_shared_as_one_ics_only_after_the_owner_check() {
    let mut d = driver();
    let milk = task(&d, "Buy milk");
    task(&d, "Post letter");
    let i = d.push(agenda::TAB, routes::task(&milk));
    assert_eq!(detail_data(d.view(i)).share_label, "Share");
    d.effects.clear();
    send_detail(&mut d, i, D::ShareRequested(Default::default()));
    assert!(matches!(
        kinds(&d).as_slice(),
        [wire::effect::Kind::OwnerCheck(check)] if check.ask
    ));
    d.answer_effect(check(wire::owner_checked::Outcome::Succeeded));
    let Some(wire::effect::Kind::ShareBytes(file)) = kinds(&d).into_iter().last() else {
        panic!("the share sheet was asked for");
    };
    assert_eq!(file.name, "Buy milk.ics");
    assert_eq!(file.media_type, "text/calendar");
    let text = String::from_utf8_lossy(&file.content);
    assert_eq!(text.matches("BEGIN:VTODO").count(), 1);
    assert!(text.contains("SUMMARY:Buy milk") && !text.contains("Post letter"));
}

#[test]
fn a_refused_check_shares_nothing_and_says_why() {
    let mut d = driver();
    let milk = task(&d, "Buy milk");
    let i = d.push(agenda::TAB, routes::task(&milk));
    d.effects.clear();
    send_detail(&mut d, i, D::ShareRequested(Default::default()));
    d.answer_effect(check(wire::owner_checked::Outcome::Failed));
    assert!(
        !kinds(&d)
            .iter()
            .any(|kind| matches!(kind, wire::effect::Kind::ShareBytes(_)))
    );
    let status = detail(d.view(i)).status.clone().expect("a sentence");
    assert!(status.refused);
}
