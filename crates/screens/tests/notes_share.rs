//! Share one note (#1185, take out): the editor's menu row asks the owner check, and only a pass
//! hands the note to the OS as a Markdown file.

mod notes_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::notes::{self, routes};
use notes_support::*;
use wire::notes_editor_event::Kind as N;

fn kinds(d: &centraid_screens::testing::Driver) -> Vec<wire::effect::Kind> {
    d.effects
        .iter()
        .filter_map(|request| request.effect.as_ref()?.kind.clone())
        .collect()
}

fn share_requested(d: &mut centraid_screens::testing::Driver, i: u64) {
    d.send(
        i,
        wire::screen_event::Kind::NotesEditor(wire::NotesEditorEvent {
            kind: Some(N::ShareRequested(
                wire::notes_editor_event::ShareRequested {},
            )),
        }),
    );
}

#[test]
fn a_note_is_shared_as_markdown_only_after_the_owner_check() {
    let mut d = driver();
    let id = note(&d, "Plan: trip/2", "Pack the bags");
    let i = d.push(notes::TAB, routes::editor(&id));
    assert_eq!(
        editor_state(d.view(i)).chrome.as_ref().unwrap().share_label,
        "Share"
    );
    d.effects.clear();
    share_requested(&mut d, i);
    assert!(matches!(
        kinds(&d).as_slice(),
        [wire::effect::Kind::OwnerCheck(check)] if check.ask
    ));

    d.answer_effect(wire::effect_result::Outcome::OwnerChecked(
        wire::OwnerChecked {
            available: true,
            outcome: wire::owner_checked::Outcome::Succeeded as i32,
            ..wire::OwnerChecked::default()
        },
    ));
    let Some(wire::effect::Kind::ShareBytes(share)) = kinds(&d).into_iter().last() else {
        panic!("the share sheet was asked for");
    };
    assert_eq!(share.name, "Plan- trip-2.md");
    assert_eq!(share.media_type, "text/markdown");
    assert_eq!(
        String::from_utf8_lossy(&share.content),
        "# Plan: trip/2\n\nPack the bags"
    );
    assert_eq!(share.chooser_title, "Share a copy");
}

#[test]
fn a_cancelled_check_shares_nothing_and_a_new_note_offers_no_share() {
    let mut d = driver();
    let id = note(&d, "Plan", "x");
    let i = d.push(notes::TAB, routes::editor(&id));
    d.effects.clear();
    share_requested(&mut d, i);
    d.answer_effect(wire::effect_result::Outcome::OwnerChecked(
        wire::OwnerChecked {
            outcome: wire::owner_checked::Outcome::Cancelled as i32,
            ..wire::OwnerChecked::default()
        },
    ));
    assert!(
        !kinds(&d)
            .iter()
            .any(|kind| matches!(kind, wire::effect::Kind::ShareBytes(_)))
    );

    let fresh = d.push(notes::TAB, routes::new_note());
    assert_eq!(
        editor_state(d.view(fresh))
            .chrome
            .as_ref()
            .unwrap()
            .share_label,
        ""
    );
    d.effects.clear();
    share_requested(&mut d, fresh);
    assert!(
        d.effects.is_empty(),
        "a note that does not exist asks nothing"
    );
}
