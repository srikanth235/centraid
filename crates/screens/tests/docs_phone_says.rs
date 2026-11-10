//! WHAT THE FOLDER SAYS on a followed document's page (#1183): a line under the name when the member
//! renamed a document its followed folder still names otherwise, one tap to take the folder's name
//! back, and nothing on the drive. Every test goes through `Driver`, the door a shell uses, over a
//! vault seeded at a fixed instant.

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

/// A followed folder states one file, `scan0042.pdf`; the ids of the folder and of the document it
/// made.
fn followed_folder(d: &Driver) -> (String, String) {
    let taxes = folder(d, "Taxes", None);
    let bytes = b"scan bytes";
    let hash = centraid_vault::blob::content_digest(bytes);
    d.handle
        .command(
            "blob.stage",
            &json!({ "hash": hash, "size": bytes.len() }),
            "stage:scan",
        )
        .expect("the bytes are staged");
    arrange(
        d,
        act::shell::FollowFiles {
            origin: json!({ "ref": "/Documents/Taxes", "label": "Taxes", "fills": taxes })
                .to_string(),
            records: json!([{ "external_id": "/scan0042.pdf", "fields": {
                "title": "scan0042.pdf", "blob": hash, "media_type": "application/pdf",
                "stat": "10:1" } }])
            .to_string(),
            complete: Some(true),
        },
    );
    match answer(
        d,
        centraid_screens::catalog::load::docs::Drive {
            folder_id: Some(taxes.clone()),
            ..Default::default()
        },
    ) {
        wire::app_query_response::Answer::DocsDrive(drive) => (
            taxes,
            drive
                .documents
                .first()
                .expect("the followed document")
                .document_id
                .clone(),
        ),
        other => panic!("the drive answered {other:?}"),
    }
}

fn followed_scan(d: &Driver) -> String {
    followed_folder(d).1
}

fn rename(d: &Driver, id: &str, title: &str) {
    arrange(
        d,
        act::docs::Rename {
            document_id: id.to_owned(),
            title: title.to_owned(),
        },
    );
}

fn taken(d: &mut Driver, page: u64, line: &wire::PhoneSays) {
    d.send(
        page,
        wire::screen_event::Kind::PhoneSaysTaken(wire::PhoneSaysTaken {
            take: line.take.clone(),
        }),
    );
}

#[test]
fn a_document_nobody_renamed_and_one_nothing_follows_show_no_line() {
    let mut d = driver();
    let id = followed_scan(&d);
    let page = d.push(docs::TAB, routes::document(&id, "scan0042.pdf", ""));
    assert!(document_data(d.view(page)).title_phone_says.is_none());

    let mine = text(&d, "Notes", "words");
    rename(&d, &mine, "Notes, edited");
    let page = d.push(docs::TAB, routes::document(&mine, "Notes", ""));
    assert!(document_data(d.view(page)).title_phone_says.is_none());
}

#[test]
fn a_renamed_document_says_the_folders_name_and_taking_it_restores_the_name() {
    let mut d = driver();
    let id = followed_scan(&d);
    rename(&d, &id, "Taxes 2025.pdf");
    let page = d.push(docs::TAB, routes::document(&id, "Taxes 2025.pdf", ""));
    let data = document_data(d.view(page)).clone();
    assert_eq!(
        data.row.as_ref().map(|r| r.title.as_str()),
        Some("Taxes 2025.pdf")
    );
    let line = data.title_phone_says.expect("the line");
    assert_eq!(line.lead, "Folder says scan0042.pdf");
    assert_eq!(line.action_label, "Use folder’s");
    assert_eq!(
        line.accessibility_label,
        "Use the name the folder has, scan0042.pdf"
    );

    taken(&mut d, page, &line);
    let data = document_data(d.view(page));
    assert_eq!(
        data.row.as_ref().map(|r| r.title.as_str()),
        Some("scan0042.pdf")
    );
    assert!(data.title_phone_says.is_none());
    assert!(document_state(d.view(page)).status.is_none());
}

#[test]
fn a_refused_take_is_a_sentence_over_the_document_as_it_still_is() {
    let mut d = driver();
    let id = followed_scan(&d);
    rename(&d, &id, "Taxes 2025.pdf");
    let page = d.push(docs::TAB, routes::document(&id, "Taxes 2025.pdf", ""));
    let mut line = document_data(d.view(page))
        .title_phone_says
        .clone()
        .expect("line");
    line.take.as_mut().expect("take").field = "no_such_field".to_owned();
    taken(&mut d, page, &line);
    let status = document_state(d.view(page))
        .status
        .clone()
        .expect("a sentence");
    assert!(status.refused && !status.sentence.trim().is_empty());
    let data = document_data(d.view(page));
    assert_eq!(
        data.row.as_ref().map(|r| r.title.as_str()),
        Some("Taxes 2025.pdf")
    );
    assert!(data.title_phone_says.is_some());
}

#[test]
fn the_drive_and_its_folders_carry_no_line() {
    let mut d = driver();
    let (taxes, id) = followed_folder(&d);
    rename(&d, &id, "Taxes 2025.pdf");
    let root = root(&d);
    let drawn = format!("{:?}", d.view(root));
    let folder_page = d.push(docs::TAB, routes::folder(&taxes, "Taxes", ""));
    let in_folder = format!("{:?}", d.view(folder_page));
    assert!(in_folder.contains("Taxes 2025.pdf"));
    for drawn in [drawn, in_folder] {
        assert!(!drawn.contains("Folder says") && !drawn.contains("Use folder"));
    }
}
