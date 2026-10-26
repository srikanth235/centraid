//! The profile editor through the door a shell uses: autosave of only what changed,
//! close = done, a new person's first save is an add, and the cadence is its own
//! action on the tap. Ports the Editor cases of `PeopleSpec` over a real vault.

mod people_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::people::{self, routes};
use centraid_screens::testing::Driver;
use people_support::*;
use wire::people_editor_event::{self as ev, Kind as N};

fn timer(d: &mut Driver, i: u64, name: &str) {
    d.send(
        i,
        wire::screen_event::Kind::TimerFired(wire::TimerFired {
            timer: name.to_owned(),
        }),
    );
}

fn dana(d: &Driver) -> String {
    id_of(&arrange(
        d,
        act::people::AddPerson {
            title: "Dana Reyes".to_owned(),
            nickname: Some("Dee".to_owned()),
            cadence_days: Some(14),
            ..Default::default()
        },
    ))
}

fn row_of(d: &Driver, id: &str) -> wire::PeopleRosterRow {
    sheet_of(d, id)
        .sheet
        .expect("a live person")
        .person
        .expect("a row")
}

#[test]
fn the_editor_reads_the_profile_and_autosaves_only_what_changed() {
    let mut d = clean();
    let id = dana(&d);
    let i = d.push(people::TAB, routes::editor(&id));
    let state = editor_state(d.view(i));
    assert_eq!(state.chrome.as_ref().unwrap().title, "Edit person");
    assert_eq!(state.chrome.as_ref().unwrap().close_label, "Done");
    let draft = draft(d.view(i)).clone();
    assert_eq!(
        (draft.display_name.as_str(), draft.nickname.as_str()),
        ("Dana Reyes", "Dee")
    );
    assert_eq!(
        state.cadences.iter().find(|c| c.selected).unwrap().label,
        "14 days"
    );

    send_editor(
        &mut d,
        i,
        N::Met(ev::MetChanged {
            text: "At the studio".into(),
        }),
    );
    let dirty = editor_state(d.view(i)).autosave.clone().unwrap();
    assert_eq!(dirty.label, "Edited");
    assert!(!dirty.refused);
    // Nothing is written until the debounce comes due.
    assert_eq!(sheet_of(&d, &id).sheet.unwrap().met, "");
    timer(&mut d, i, "autosave");
    assert_eq!(sheet_of(&d, &id).sheet.unwrap().met, "At the studio");
    assert_eq!(
        editor_state(d.view(i)).autosave.clone().unwrap().label,
        "Saved"
    );
    // Only the field that moved was sent: the name and nickname stand.
    let row = row_of(&d, &id);
    assert_eq!(row.name, "Dana Reyes");
    assert_eq!(sheet_of(&d, &id).sheet.unwrap().nickname, "Dee");
}

#[test]
fn leaving_before_the_debounce_saves_what_is_typed_close_is_done() {
    let mut d = clean();
    let id = dana(&d);
    let i = d.push(people::TAB, routes::editor(&id));
    send_editor(
        &mut d,
        i,
        N::Role(ev::RoleChanged {
            text: "Illustrator".into(),
        }),
    );
    assert_eq!(row_of(&d, &id).role, "");
    d.pop(people::TAB, i);
    assert_eq!(row_of(&d, &id).role, "Illustrator");
}

#[test]
fn a_name_cleared_to_nothing_is_refused_here_and_the_words_stay() {
    let mut d = clean();
    let id = dana(&d);
    let i = d.push(people::TAB, routes::editor(&id));
    send_editor(&mut d, i, N::Name(ev::NameChanged { text: " ".into() }));
    timer(&mut d, i, "autosave");
    let autosave = editor_state(d.view(i)).autosave.clone().unwrap();
    // THE LAW SAYS "REFUSED" ONCE, so no shell reads the phase for its ink.
    assert!(autosave.refused);
    assert_eq!(autosave.label, "A person needs a name.");
    assert_eq!(draft(d.view(i)).display_name, " ");
    assert_eq!(row_of(&d, &id).name, "Dana Reyes");
}

#[test]
fn the_cadence_is_its_own_action_on_the_tap() {
    let mut d = clean();
    let id = dana(&d);
    let i = d.push(people::TAB, routes::editor(&id));
    send_editor(&mut d, i, N::Cadence(ev::CadencePicked { days: 30 }));
    assert_eq!(row_of(&d, &id).cadence_days, 30);
    let state = editor_state(d.view(i));
    assert_eq!(
        state.cadences.iter().find(|c| c.selected).unwrap().label,
        "30 days"
    );
    // Never: the zero is "Never".
    send_editor(&mut d, i, N::Cadence(ev::CadencePicked { days: 0 }));
    assert_eq!(row_of(&d, &id).cadence_days, 0);
    assert_eq!(
        editor_state(d.view(i))
            .cadences
            .iter()
            .find(|c| c.selected)
            .unwrap()
            .label,
        "Never"
    );
    // A cadence is not typing: nothing waits to be saved.
    assert_eq!(
        editor_state(d.view(i)).autosave.clone().unwrap().label,
        "Saved"
    );
}

#[test]
fn a_new_person_is_one_add_with_everything_typed_and_nothing_before_a_keystroke() {
    let mut d = clean();
    let i = d.push(people::TAB, routes::new_person());
    let state = editor_state(d.view(i));
    assert_eq!(state.chrome.as_ref().unwrap().title, "New person");
    assert_eq!(state.chrome.as_ref().unwrap().close_label, "Cancel");
    assert!(state.status.is_none());
    // Closing an untouched new person writes nothing.
    d.pop(people::TAB, i);
    assert!(roster_of(&d).people.is_empty());

    let i = d.push(people::TAB, routes::new_person());
    send_editor(&mut d, i, N::Name(ev::NameChanged { text: "Ana".into() }));
    send_editor(&mut d, i, N::Cadence(ev::CadencePicked { days: 7 }));
    send_editor(
        &mut d,
        i,
        N::Met(ev::MetChanged {
            text: "School".into(),
        }),
    );
    assert_eq!(
        editor_state(d.view(i)).chrome.as_ref().unwrap().close_label,
        "Done"
    );
    assert_eq!(
        editor_state(d.view(i))
            .cadences
            .iter()
            .find(|c| c.selected)
            .unwrap()
            .label,
        "7 days"
    );
    d.pop(people::TAB, i);
    let roster = roster_of(&d);
    assert_eq!(roster.people.len(), 1, "one person, not two");
    let ana = &roster.people[0];
    assert_eq!((ana.name.as_str(), ana.cadence_days), ("Ana", 7));
    assert_eq!(sheet_of(&d, &ana.party_id).sheet.unwrap().met, "School");
}

/// WORDS TYPED AFTER THE ADD ARE AN EDIT OF THE PERSON IT MADE, never a second add (#1089).
#[test]
fn words_typed_after_the_first_save_are_an_edit_of_the_person_it_made() {
    let mut d = clean();
    let i = d.push(people::TAB, routes::new_person());
    send_editor(&mut d, i, N::Name(ev::NameChanged { text: "Ana".into() }));
    timer(&mut d, i, "autosave");
    assert_eq!(roster_of(&d).people.len(), 1);
    send_editor(
        &mut d,
        i,
        N::Nickname(ev::NicknameChanged {
            text: "Annie".into(),
        }),
    );
    timer(&mut d, i, "autosave");
    let roster = roster_of(&d);
    assert_eq!(roster.people.len(), 1, "never a second add_person");
    assert_eq!(
        sheet_of(&d, &roster.people[0].party_id)
            .sheet
            .unwrap()
            .nickname,
        "Annie"
    );
    // It still says it is a new person's editor, and the name stands.
    assert_eq!(draft(d.view(i)).display_name, "Ana");
}
