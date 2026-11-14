//! A note's attachments (#1185): the editor's menu offers "Attachments", which opens a sheet over
//! the editor holding the kit's section: the photos and files on the note, Add file, and Remove with
//! its confirm. The shell picks and stages the bytes (`PickFile`); the screen files them as a
//! document and attaches it. Nothing here streams a byte: the shell's half is answered by value.

mod notes_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::docs;
use centraid_screens::notes::{self, routes};
use centraid_screens::testing::Driver;
use notes_support::*;
use wire::agenda_attachment_event::Kind as A;
use wire::app_query_response::Answer;
use wire::effect_result::Outcome as O;
use wire::notes_editor_event::Kind as N;

fn opened(d: &mut Driver, id: &str) -> u64 {
    d.push(notes::TAB, routes::editor(id))
}

fn open_sheet(d: &mut Driver, i: u64) {
    send_editor(
        d,
        i,
        N::AttachmentsOpened(wire::notes_editor_event::AttachmentsOpened {}),
    );
}

fn on_sheet(d: &mut Driver, i: u64, kind: A) {
    send_editor(
        d,
        i,
        N::Attachment(wire::AgendaAttachmentEvent { kind: Some(kind) }),
    );
}

fn section(d: &Driver, i: u64) -> wire::AgendaAttachmentsSection {
    *editor_state(d.view(i))
        .attachments
        .clone()
        .expect("the Attachments sheet is open")
}

fn held(d: &Driver, note: &str) -> usize {
    match answer(
        d,
        load::notes::Attachments {
            item_id: note.to_owned(),
            after: None,
            limit: 10,
        },
    ) {
        Answer::AgendaAttachments(page) => page.attachments.len(),
        other => panic!("attachments answered {other:?}"),
    }
}

/// Answer the oldest effect the editor asked, whatever other screens have pending.
fn answer_for(d: &mut Driver, instance: u64, outcome: O) {
    let at = d
        .effects
        .iter()
        .position(|request| request.instance == instance)
        .expect("that page asked for an effect");
    let request = d.effects.remove(at);
    d.send(
        instance,
        wire::screen_event::Kind::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(outcome),
        }),
    );
}

fn picked(blob: char, size: u64, name: &str) -> O {
    O::FilePicked(wire::FilePicked {
        blob: blob.to_string().repeat(64),
        byte_size: size,
        name: name.to_owned(),
        media_type: String::new(),
    })
}

#[test]
fn the_menu_offers_attachments_and_the_sheet_opens_empty_with_both_adds() {
    let mut d = driver();
    let id = note(&d, "Lisbon trip", "Flights are booked");
    let i = opened(&mut d, &id);
    let state = editor_state(d.view(i));
    let entry = state.attachments_entry.clone().expect("the menu row");
    assert_eq!(entry.label, "Attachments");
    assert_eq!(entry.count_label, "", "nothing attached yet");
    assert!(state.attachments.is_none(), "the sheet is closed");

    open_sheet(&mut d, i);
    let section = section(&d, i);
    assert_eq!(section.heading, "Attachments");
    assert_eq!(section.empty_label, "Nothing attached yet.");
    assert_eq!(section.add_photo_label, "Add photo");
    assert_eq!(section.add_file_label, "Add file");

    send_editor(
        &mut d,
        i,
        N::AttachmentsClosed(wire::notes_editor_event::AttachmentsClosed {}),
    );
    assert!(editor_state(d.view(i)).attachments.is_none());
}

#[test]
fn add_file_files_it_in_docs_and_attaches_it_to_the_note_and_remove_detaches_only_the_edge() {
    let mut d = driver();
    let id = note(&d, "Lisbon trip", "Flights are booked");
    let i = opened(&mut d, &id);
    open_sheet(&mut d, i);
    on_sheet(&mut d, i, A::AddFile(Default::default()));
    assert!(section(&d, i).busy, "the pick is under way");
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: false,
    }));
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: true,
    }));
    let effect_id = d
        .effects
        .iter()
        .find(|request| request.instance == i)
        .unwrap()
        .effect_id;
    d.send(
        i,
        wire::screen_event::Kind::EffectResult(wire::EffectResult {
            effect_id,
            outcome: Some(O::FileProgress(wire::FileProgress {
                staged_bytes: 85,
                total_bytes: 85,
                name: "Itinerary.pdf".to_owned(),
            })),
        }),
    );
    assert!(section(&d, i).busy, "progress keeps the picker pending");
    answer_for(&mut d, i, picked('b', 2_400_000, "Itinerary.pdf"));
    let tile = {
        let section = section(&d, i);
        assert_eq!(section.items.len(), 1, "{:?}", section.status);
        section.items[0].clone()
    };
    assert_eq!(tile.kind, "document");
    assert_eq!(tile.title, "Itinerary.pdf");
    assert_eq!(
        tile.route.as_ref().map(|route| route.screen.as_str()),
        Some(docs::DOCUMENT),
        "a tap opens the document in Docs"
    );
    assert_eq!(held(&d, &id), 1, "the vault holds the attachment");
    assert_eq!(
        editor_state(d.view(i))
            .attachments_entry
            .as_ref()
            .map(|entry| entry.count_label.as_str()),
        Some("1"),
        "the menu row counts it"
    );

    on_sheet(
        &mut d,
        i,
        A::RemoveAsked(wire::agenda_attachment_event::RemoveAsked {
            attachment_id: tile.attachment_id,
        }),
    );
    let confirm = section(&d, i).remove_confirm.expect("a confirm");
    assert_eq!(confirm.body, "It comes off here. The file stays in Docs.");
    on_sheet(&mut d, i, A::RemoveConfirmed(Default::default()));
    assert!(section(&d, i).items.is_empty());
    assert_eq!(held(&d, &id), 0);
}

fn retained_share_message_then_attachment(unprotected: bool) {
    let mut d = driver();
    let id = note(&d, "Lisbon trip", "Flights are booked");
    let i = opened(&mut d, &id);
    d.effects.clear();
    send_editor(
        &mut d,
        i,
        N::ShareRequested(wire::notes_editor_event::ShareRequested {}),
    );
    answer_for(
        &mut d,
        i,
        O::OwnerChecked(wire::OwnerChecked {
            outcome: if unprotected {
                wire::owner_checked::Outcome::Unavailable
            } else {
                wire::owner_checked::Outcome::Succeeded
            } as i32,
            ..Default::default()
        }),
    );
    assert!(d.effects.iter().any(|request| matches!(
        request.effect.as_ref().and_then(|effect| effect.kind.as_ref()),
        Some(wire::effect::Kind::ShareBytes(_))
    )));
    answer_for(
        &mut d,
        i,
        if unprotected {
            O::Done(wire::EffectDone {})
        } else {
            O::Failed(wire::EffectFailed {
                reason: "unavailable".to_owned(),
                ..Default::default()
            })
        },
    );
    assert!(
        !editor_state(d.view(i))
            .chrome
            .as_ref()
            .unwrap()
            .status
            .is_empty(),
        "the previous share's warning or failure remains visible"
    );

    open_sheet(&mut d, i);
    on_sheet(&mut d, i, A::AddFile(Default::default()));
    let request = d
        .effects
        .iter()
        .find(|request| request.instance == i)
        .unwrap();
    d.send(
        i,
        wire::screen_event::Kind::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(O::FileProgress(wire::FileProgress {
                staged_bytes: 85,
                total_bytes: 85,
                name: "Itinerary.pdf".to_owned(),
            })),
        }),
    );
    assert!(section(&d, i).busy);
    assert!(section(&d, i).busy_label.contains("Itinerary.pdf"));
    answer_for(&mut d, i, picked('c', 85, "Itinerary.pdf"));
    assert!(!section(&d, i).busy, "the pick has completed");
    assert_eq!(section(&d, i).items.len(), 1);
    assert_eq!(held(&d, &id), 1, "the file is attached in the vault");
}

#[test]
fn retained_share_warning_does_not_swallow_attachment_progress_or_completion() {
    retained_share_message_then_attachment(true);
}

#[test]
fn retained_share_failure_does_not_swallow_attachment_progress_or_completion() {
    retained_share_message_then_attachment(false);
}
