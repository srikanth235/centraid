//! Reminders' export (`reminders.export`, #1185): the kit's export screen with a row for every
//! list, an owner check first, and a calendar file of to-dos handed to the OS save sheet.

mod reminders_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda;
use centraid_screens::strings::Locale;
use reminders_support::*;

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
fn an_export_saves_an_ics_of_to_dos_through_the_os_save_sheet_after_the_owner_check() {
    let mut d = driver();
    project(&d, "Errands");
    task(&d, "Buy milk");
    let entry = centraid_screens::kit::export::entry(Locale::En, "reminders.export");
    let i = d.push(agenda::TAB, entry.route);
    let rows = &state(d.view(i)).rows;
    assert_eq!(rows[0].label, "All lists");
    assert!(rows.iter().any(|r| r.label == "Errands"), "{rows:?}");
    d.effects.clear();
    d.send(
        i,
        wire::screen_event::Kind::Transfer(wire::TransferEvent {
            key: "all".to_owned(),
        }),
    );
    pass_owner_check(&mut d);
    let Some(wire::effect::Kind::SaveFile(save)) = d
        .effects
        .last()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.clone())
    else {
        panic!("the save sheet was asked for");
    };
    assert_eq!(save.name, "Reminders.ics");
    assert_eq!(save.media_type, "text/calendar");
    let text = String::from_utf8_lossy(&save.content);
    assert!(text.contains("BEGIN:VTODO") && text.contains("SUMMARY:Buy milk"));
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert!(
        state(d.view(i))
            .status
            .as_ref()
            .is_some_and(|s| s.sentence == "Export saved")
    );
}
