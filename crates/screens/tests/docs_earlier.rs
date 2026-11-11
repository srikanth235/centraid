//! EARLIER VERSIONS of a document (#1185): the entry at the foot of the page with its count, the
//! kit's one screen listing what the document was (its bytes with their type and size, its name,
//! its folder), Restore with no confirm, Undo, a change a followed folder made labelled as the
//! folder's, and a read that fails saying so. Every test goes through `Driver`, over a vault
//! seeded at a fixed instant.

mod docs_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::docs::{self, routes};
use centraid_screens::testing::Driver;
use docs_support::*;
use serde_json::json;

/// 2026-03-02 12:00 UTC.
const SEEDED_AT_MS: i64 = 1_772_452_800_000;

fn driver() -> Driver {
    let mut d = Driver::with_runtime_at(docs::runtime(), SEEDED_AT_MS);
    d.start();
    d
}

fn earlier_view(v: &wire::ViewState) -> &wire::EarlierView {
    match &v.kind {
        Some(wire::view_state::Kind::Earlier(view)) => view,
        other => panic!("not the earlier-versions screen: {other:?}"),
    }
}

fn rows(v: &wire::ViewState) -> &[wire::EarlierRow] {
    match &earlier_view(v).content {
        Some(wire::earlier_view::Content::Data(data)) => &data.rows,
        other => panic!("no data: {other:?}"),
    }
}

fn lines(d: &Driver, i: u64) -> Vec<String> {
    rows(d.view(i))
        .iter()
        .map(|row| row.value.clone())
        .collect()
}

fn event(d: &mut Driver, i: u64, kind: wire::earlier_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::Earlier(wire::EarlierEvent { kind: Some(kind) }),
    );
}

fn edit(d: &Driver, id: &str, body: &str) {
    arrange(
        d,
        act::docs::Edit {
            document_id: id.to_owned(),
            body_text: Some(body.to_owned()),
            title: None,
            expected_rev: None,
        },
    );
}

fn refresh(d: &mut Driver, i: u64) {
    d.send(i, wire::screen_event::Kind::Appeared(wire::Appeared {}));
}

/// Stage bytes the vault then knows, and give back their hash.
fn staged(d: &Driver, bytes: &[u8]) -> String {
    let hash = centraid_vault::blob::content_digest(bytes);
    d.handle
        .command(
            "blob.stage",
            &json!({ "hash": hash, "size": bytes.len() }),
            &format!("stage:{hash}"),
        )
        .expect("the bytes are staged");
    hash
}

fn open_earlier(d: &mut Driver, id: &str, title: &str) -> u64 {
    let entry = {
        let i = d.push(docs::TAB, routes::document(id, title, "Docs"));
        document_data(d.view(i)).earlier.clone().expect("the entry")
    };
    d.push(docs::TAB, entry.route.expect("the entry's route"))
}

#[test]
fn the_page_offers_the_entry_with_the_count_only_once_there_is_something_earlier() {
    let mut d = driver();
    let id = text(&d, "Letter", "first");
    let i = d.push(docs::TAB, routes::document(&id, "Letter", "Docs"));
    assert!(
        document_data(d.view(i)).earlier.is_none(),
        "a document never changed has nothing earlier"
    );

    edit(&d, &id, "second");
    edit(&d, &id, "third");
    refresh(&mut d, i);
    let entry = document_data(d.view(i)).earlier.clone().expect("the entry");
    assert_eq!(entry.label, "Earlier versions");
    assert_eq!(entry.count_label, "2");
    assert_eq!(entry.accessibility_label, "Earlier versions, 2");
    let route = entry.route.expect("a route");
    assert_eq!(route.screen, docs::EARLIER);
    let Some(wire::route::Args::Earlier(args)) = route.args else {
        panic!("the shared route");
    };
    assert_eq!(args.entity_id, id);
    assert_eq!(args.back_label, "Letter", "the page it came from");
}

#[test]
fn replaced_bytes_read_as_the_earlier_files_type_and_size_a_rename_as_its_name_a_move_as_its_folder()
 {
    let mut d = driver();
    let taxes = folder(&d, "Taxes", None);
    let id = pdf(&d, "Lease", 'a');
    let bigger = staged(&d, &vec![b'x'; 5_000]);
    arrange(
        &d,
        act::docs::Replace {
            blob: bigger,
            document_id: id.clone(),
            media_type: Some("application/pdf".to_owned()),
            text: None,
            title: None,
        },
    );
    arrange(
        &d,
        act::docs::Rename {
            document_id: id.clone(),
            title: "Lease 2026".to_owned(),
            expected_rev: None,
        },
    );
    arrange(
        &d,
        act::docs::Move {
            document_id: id.clone(),
            folder_id: Some(taxes),
        },
    );
    arrange(
        &d,
        act::docs::Move {
            document_id: id.clone(),
            folder_id: None,
        },
    );
    let i = open_earlier(&mut d, &id, "Lease 2026");
    assert_eq!(earlier_view(d.view(i)).back_label, "Lease 2026");
    assert_eq!(
        lines(&d, i),
        ["Docs", "Taxes", "Docs", "Lease", "PDF · 2 KB"],
        "the current folder, the earlier folders by name (the top level is Docs), the earlier name, the earlier file's type and size"
    );
    let rows = rows(d.view(i));
    assert!(rows[0].current && rows[0].current_label == "Current");
    assert!(rows[0].restore_label.is_empty());
    assert!(rows[1..].iter().all(|row| row.restore_label == "Restore"));
    assert!(rows.iter().all(|row| row.label.contains(" · ")));
}

#[test]
fn replaced_words_of_a_text_document_read_with_their_type_and_size() {
    let mut d = driver();
    let id = text(&d, "Letter", "first");
    edit(&d, &id, "second words");
    let i = open_earlier(&mut d, &id, "Letter");
    let listed = lines(&d, i);
    assert_eq!(listed.len(), 2);
    assert!(
        listed[1].ends_with(" · 5 bytes"),
        "the earlier file's size: {}",
        listed[1]
    );
}

#[test]
fn restore_asks_nothing_says_so_with_undo_and_undo_puts_it_back() {
    let mut d = driver();
    let id = text(&d, "Letter", "first");
    edit(&d, &id, "second");
    edit(&d, &id, "third");
    let i = open_earlier(&mut d, &id, "Letter");
    let oldest = rows(d.view(i)).last().expect("a row").seq;
    event(
        &mut d,
        i,
        wire::earlier_event::Kind::Restore(wire::earlier_event::RestoreTapped { seq: oldest }),
    );
    assert!(matches!(
        earlier_view(d.view(i)).content,
        Some(wire::earlier_view::Content::Data(_))
    ));
    assert_eq!(document(&d, &id).body.as_deref(), Some("first"));
    let status = earlier_view(d.view(i)).status.clone().expect("a status");
    assert_eq!(status.sentence, "Earlier version restored");
    assert_eq!(status.action_label, "Undo");
    assert_eq!(
        rows(d.view(i)).len(),
        4,
        "a restore is a version of its own"
    );

    event(
        &mut d,
        i,
        wire::earlier_event::Kind::StatusActed(wire::earlier_event::StatusActed {}),
    );
    assert_eq!(document(&d, &id).body.as_deref(), Some("third"));
    let status = earlier_view(d.view(i)).status.clone().expect("a status");
    assert_eq!(status.sentence, "Restore undone");
    assert!(status.action_label.is_empty());
}

#[test]
fn a_change_a_followed_folder_made_reads_as_from_the_folder() {
    let mut d = driver();
    let taxes = folder(&d, "Taxes", None);
    let hash = staged(&d, b"scan bytes");
    let pass = |title: &str, stat: &str| act::shell::FollowFiles {
        origin: json!({ "ref": "/Documents/Taxes", "label": "Taxes", "fills": taxes }).to_string(),
        records: json!([{ "external_id": "/scan.pdf", "fields": {
            "title": title, "blob": hash, "media_type": "application/pdf", "stat": stat } }])
        .to_string(),
        complete: Some(true),
    };
    arrange(&d, pass("scan0042.pdf", "10:1"));
    let id = match answer(
        &d,
        centraid_screens::catalog::load::docs::Drive {
            folder_id: Some(taxes.clone()),
            ..Default::default()
        },
    ) {
        wire::app_query_response::Answer::DocsDrive(drive) => drive
            .documents
            .first()
            .expect("the followed document")
            .document_id
            .clone(),
        other => panic!("the drive answered {other:?}"),
    };
    arrange(&d, pass("scan0043.pdf", "10:2"));

    let i = open_earlier(&mut d, &id, "scan0043.pdf");
    let listed = rows(d.view(i)).to_vec();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].value, "scan0043.pdf");
    assert!(
        listed[0].label.ends_with(" · From the folder"),
        "the folder's pass made the current name: {}",
        listed[0].label
    );
    assert_eq!(listed[1].value, "scan0042.pdf");
    assert!(!listed[1].label.contains("From"));
}

#[test]
fn a_read_that_fails_is_the_failed_state_never_an_empty_list() {
    let mut d = Driver::unfounded(docs::runtime());
    d.start();
    let route = centraid_screens::kit::earlier::route(docs::EARLIER, "some-id", "Letter");
    let i = d.push(docs::TAB, route);
    assert!(matches!(
        earlier_view(d.view(i))
            .page
            .as_ref()
            .and_then(|page| page.state.as_ref()),
        Some(wire::page_state::State::Failed(_))
    ));
}

#[test]
fn a_scanned_or_uploaded_document_says_so_and_a_typed_one_does_not() {
    let mut d = driver();
    let upload = |d: &Driver, seed: char, title: &str, system, label: &str| {
        id_of(&arrange(
            d,
            act::docs::Upload {
                blob: seed.to_string().repeat(64),
                media_type: "application/pdf".to_owned(),
                title: title.to_owned(),
                size: Some(2048),
                arrived_system: Some(system),
                arrived_label: Some(label.to_owned()),
                ..Default::default()
            },
        ))
    };
    let scan = upload(
        &d,
        'a',
        "Receipt",
        act::docs::UploadArrivedSystem::Scan,
        "Scanned document",
    );
    let file = upload(
        &d,
        'b',
        "Lease",
        act::docs::UploadArrivedSystem::Upload,
        "Lease.pdf",
    );
    let typed = text(&d, "Letter", "first");
    let origin = |d: &mut Driver, id: &str, title: &str| {
        let i = d.push(docs::TAB, routes::document(id, title, "Docs"));
        document_data(d.view(i)).origin.clone()
    };
    let line = origin(&mut d, &scan, "Receipt").expect("a line");
    assert_eq!(line.text, "From Scanned document");
    assert_eq!(line.accessibility_label, "Came from Scanned document");
    assert_eq!(
        origin(&mut d, &file, "Lease").map(|line| line.text),
        Some("From Lease.pdf".to_owned())
    );
    assert_eq!(origin(&mut d, &typed, "Letter"), None);
}
