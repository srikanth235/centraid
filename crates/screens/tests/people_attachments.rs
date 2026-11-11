//! A person's page and its attachments section (#1185): the photos and files on one person, Add
//! file, and Remove with its confirm, through the door a shell uses. The shell picks and stages the
//! bytes (`PickFile`); the screen files them as a document and attaches it. Nothing here streams a
//! byte: the shell's half is answered by value, as a shell answers it.

mod people_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::docs;
use centraid_screens::testing::Driver;
use people_support::*;
use wire::agenda_attachment_event::Kind as A;
use wire::app_query_response::Answer;
use wire::effect_result::Outcome as O;
use wire::people_person_event::Kind as P;

fn on_person(d: &mut Driver, i: u64, kind: A) {
    send_person(
        d,
        i,
        P::Attachment(wire::AgendaAttachmentEvent { kind: Some(kind) }),
    );
}

fn section(d: &Driver, i: u64) -> wire::AgendaAttachmentsSection {
    person_data(d.view(i))
        .attachments
        .clone()
        .expect("an attachments section")
}

fn held(d: &Driver, person: &str) -> usize {
    match answer(
        d,
        load::people::Attachments {
            item_id: person.to_owned(),
            after: None,
            limit: 10,
        },
    ) {
        Answer::AgendaAttachments(page) => page.attachments.len(),
        other => panic!("attachments answered {other:?}"),
    }
}

/// Answer the oldest effect the person's page asked, whatever other screens have pending.
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
fn a_person_with_nothing_attached_says_so_and_offers_both_adds() {
    let mut d = clean();
    let ada = person(&d, "Ada Lovelace");
    let i = open_person(&mut d, &ada, "Ada Lovelace");
    let section = section(&d, i);
    assert_eq!(section.heading, "Attachments");
    assert!(section.items.is_empty());
    assert_eq!(section.empty_label, "Nothing attached yet.");
    assert_eq!(section.add_photo_label, "Add photo");
    assert_eq!(section.add_file_label, "Add file");
}

#[test]
fn add_file_asks_for_a_file_then_files_it_in_docs_and_attaches_it_to_the_person() {
    let mut d = clean();
    let ada = person(&d, "Ada Lovelace");
    let i = open_person(&mut d, &ada, "Ada Lovelace");
    on_person(&mut d, i, A::AddFile(Default::default()));
    assert!(section(&d, i).busy, "the pick is under way");
    answer_for(&mut d, i, picked('b', 2_400_000, "Engine notes.pdf"));
    let section = section(&d, i);
    assert_eq!(section.items.len(), 1, "{:?}", section.status);
    let tile = &section.items[0];
    assert_eq!(tile.kind, "document");
    assert_eq!(tile.title, "Engine notes.pdf");
    assert_eq!(
        tile.route.as_ref().map(|route| route.screen.as_str()),
        Some(docs::DOCUMENT),
        "a tap opens the document in Docs"
    );
    assert_eq!(section.heading, "Attachments · 1");
    assert_eq!(held(&d, &ada), 1, "the vault holds the attachment");
}

#[test]
fn remove_asks_says_the_file_stays_and_detaches_only_the_edge() {
    let mut d = clean();
    let ada = person(&d, "Ada Lovelace");
    let i = open_person(&mut d, &ada, "Ada Lovelace");
    on_person(&mut d, i, A::AddFile(Default::default()));
    answer_for(&mut d, i, picked('c', 1024, "Menu.pdf"));
    let doc = section(&d, i).items[0].attachment_id.clone();

    on_person(
        &mut d,
        i,
        A::RemoveAsked(wire::agenda_attachment_event::RemoveAsked {
            attachment_id: doc.clone(),
        }),
    );
    let confirm = section(&d, i).remove_confirm.expect("a confirm");
    assert_eq!(confirm.body, "It comes off here. The file stays in Docs.");
    on_person(&mut d, i, A::RemoveConfirmed(Default::default()));
    assert!(section(&d, i).items.is_empty());
    assert_eq!(held(&d, &ada), 0);
}
