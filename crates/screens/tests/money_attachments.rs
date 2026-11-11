//! A transaction's page and its attachments section (#1185): the photos and files on one line, Add
//! file, and Remove with its confirm, through the door a shell uses. The shell picks and stages the
//! bytes (`PickFile`); the screen files them as a document and attaches it. Nothing here streams a
//! byte: the shell's half is answered by value, as a shell answers it.

mod money_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::docs;
use centraid_screens::money::routes;
use centraid_screens::testing::Driver;
use money_support::*;
use wire::agenda_attachment_event::Kind as A;
use wire::app_query_response::Answer;
use wire::effect_result::Outcome as O;
use wire::money_transaction_event as te;

fn data(v: &wire::ViewState) -> &wire::MoneyTransactionData {
    match &v.kind {
        Some(wire::view_state::Kind::MoneyTransaction(s)) => match &s.content {
            Some(wire::money_transaction_state::Content::Data(d)) => d,
            other => panic!("no transaction data: {other:?}"),
        },
        other => panic!("not a transaction: {other:?}"),
    }
}

/// The first line of this month's Activity: its id.
fn a_line(d: &mut Driver) -> String {
    let i = land_on(d, wire::MoneyDestination::Activity);
    home_data(d.view(i))
        .activity
        .as_ref()
        .unwrap()
        .sections
        .iter()
        .flat_map(|s| &s.rows)
        .map(|row| row.txn_id.clone())
        .next()
        .expect("a line this month")
}

fn open(d: &mut Driver, id: &str) -> u64 {
    push(d, routes::transaction(id, "Money"))
}

fn on_page(d: &mut Driver, i: u64, kind: A) {
    event(
        d,
        i,
        wire::screen_event::Kind::MoneyTransaction(wire::MoneyTransactionEvent {
            kind: Some(te::Kind::Attachment(wire::AgendaAttachmentEvent {
                kind: Some(kind),
            })),
        }),
    );
}

fn section(d: &Driver, i: u64) -> wire::AgendaAttachmentsSection {
    data(d.view(i))
        .attachments
        .clone()
        .expect("an attachments section")
}

fn held(d: &Driver, line: &str) -> usize {
    match load_answer(
        d,
        load::money::Attachments {
            item_id: line.to_owned(),
            after: None,
            limit: 10,
        },
    ) {
        Answer::AgendaAttachments(page) => page.attachments.len(),
        other => panic!("attachments answered {other:?}"),
    }
}

/// Answer the oldest effect the page asked, whatever other screens have pending.
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
fn a_line_with_nothing_attached_says_so_and_offers_both_adds() {
    let mut d = driver();
    let id = a_line(&mut d);
    let i = open(&mut d, &id);
    let section = section(&d, i);
    assert_eq!(section.heading, "Attachments");
    assert!(section.items.is_empty());
    assert_eq!(section.empty_label, "Nothing attached yet.");
    assert_eq!(section.add_photo_label, "Add photo");
    assert_eq!(section.add_file_label, "Add file");
}

#[test]
fn add_file_files_it_in_docs_and_attaches_it_to_the_line_and_remove_detaches_only_the_edge() {
    let mut d = driver();
    let id = a_line(&mut d);
    let i = open(&mut d, &id);
    on_page(&mut d, i, A::AddFile(Default::default()));
    assert!(section(&d, i).busy, "the pick is under way");
    answer_for(&mut d, i, picked('b', 2_400_000, "Receipt.pdf"));
    let tile = {
        let section = section(&d, i);
        assert_eq!(section.items.len(), 1, "{:?}", section.status);
        section.items[0].clone()
    };
    assert_eq!(tile.kind, "document");
    assert_eq!(tile.title, "Receipt.pdf");
    assert_eq!(
        tile.route.as_ref().map(|route| route.screen.as_str()),
        Some(docs::DOCUMENT),
        "a tap opens the document in Docs"
    );
    assert_eq!(held(&d, &id), 1, "the vault holds the attachment");

    on_page(
        &mut d,
        i,
        A::RemoveAsked(wire::agenda_attachment_event::RemoveAsked {
            attachment_id: tile.attachment_id,
        }),
    );
    let confirm = section(&d, i).remove_confirm.expect("a confirm");
    assert_eq!(confirm.body, "It comes off here. The file stays in Docs.");
    on_page(&mut d, i, A::RemoveConfirmed(Default::default()));
    assert!(section(&d, i).items.is_empty());
    assert_eq!(held(&d, &id), 0);
}
