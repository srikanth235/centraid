//! A document's page and its attachments section (#1185): the photos and files on one document, Add
//! file, and Remove with its confirm, through the door a shell uses. The shell picks and stages the
//! bytes (`PickFile`); the screen files them as a document and attaches it. Nothing here streams a
//! byte: the shell's half is answered by value, as a shell answers it.

mod docs_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::docs::{self, routes};
use centraid_screens::testing::Driver;
use docs_support::*;
use wire::agenda_attachment_event::Kind as A;
use wire::app_query_response::Answer;
use wire::docs_document_event::Kind as DD;
use wire::effect_result::Outcome as O;

fn open(d: &mut Driver, id: &str, title: &str) -> u64 {
    d.push(docs::TAB, routes::document(id, title, ""))
}

fn on_page(d: &mut Driver, i: u64, kind: A) {
    document_send(
        d,
        i,
        DD::Attachment(wire::AgendaAttachmentEvent { kind: Some(kind) }),
    );
}

fn section(d: &Driver, i: u64) -> wire::AgendaAttachmentsSection {
    document_data(d.view(i))
        .attachments
        .clone()
        .expect("an attachments section")
}

fn held(d: &Driver, document: &str) -> usize {
    match answer(
        d,
        load::docs::Attachments {
            item_id: document.to_owned(),
            after: None,
            limit: 10,
        },
    ) {
        Answer::AgendaAttachments(page) => page.attachments.len(),
        other => panic!("attachments answered {other:?}"),
    }
}

/// Answer the oldest effect the document's page asked, whatever other screens have pending.
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
fn a_document_with_nothing_attached_says_so_and_offers_both_adds() {
    let mut d = driver();
    let lease = text(&d, "Lease", "terms");
    let i = open(&mut d, &lease, "Lease");
    let section = section(&d, i);
    assert_eq!(section.heading, "Attachments");
    assert!(section.items.is_empty());
    assert_eq!(section.empty_label, "Nothing attached yet.");
    assert_eq!(section.add_photo_label, "Add photo");
    assert_eq!(section.add_file_label, "Add file");
}

#[test]
fn add_file_asks_for_a_file_then_files_it_in_docs_and_attaches_it_to_the_document() {
    let mut d = driver();
    let lease = text(&d, "Lease", "terms");
    let i = open(&mut d, &lease, "Lease");
    on_page(&mut d, i, A::AddFile(Default::default()));
    assert!(section(&d, i).busy, "the pick is under way");
    answer_for(&mut d, i, picked('b', 2_400_000, "Inventory.pdf"));
    let section = section(&d, i);
    assert_eq!(section.items.len(), 1, "{:?}", section.status);
    let tile = &section.items[0];
    assert_eq!(tile.kind, "document");
    assert_eq!(tile.title, "Inventory.pdf");
    assert_eq!(
        tile.route.as_ref().map(|route| route.screen.as_str()),
        Some(docs::DOCUMENT),
        "a tap opens the document in Docs"
    );
    assert_eq!(held(&d, &lease), 1, "the vault holds the attachment");
}

#[test]
fn remove_asks_says_the_file_stays_and_detaches_only_the_edge() {
    let mut d = driver();
    let lease = text(&d, "Lease", "terms");
    let i = open(&mut d, &lease, "Lease");
    on_page(&mut d, i, A::AddFile(Default::default()));
    answer_for(&mut d, i, picked('c', 1024, "Menu.pdf"));
    let doc = section(&d, i).items[0].attachment_id.clone();

    on_page(
        &mut d,
        i,
        A::RemoveAsked(wire::agenda_attachment_event::RemoveAsked { attachment_id: doc }),
    );
    let confirm = section(&d, i).remove_confirm.expect("a confirm");
    assert_eq!(confirm.body, "It comes off here. The file stays in Docs.");
    on_page(&mut d, i, A::RemoveConfirmed(Default::default()));
    assert!(section(&d, i).items.is_empty());
    assert_eq!(held(&d, &lease), 0);
}
