//! Docs' arm, through `Handle::call` — the door a shell uses.

use super::super::*;
use crate::config::CoreConfig;
use crate::handle::{Core, Handle};

/// The vault clock, stopped: 02:00Z on 2 June is still 1 June, 22:00, in New
/// York — so a test that reads a day in UTC gets a different answer.
const NOW: &str = "2099-06-02T02:00:00.000Z";
const TZ: &str = "America/New_York";

struct Scratch {
    dir: std::path::PathBuf,
    handle: Handle,
    writes: std::cell::Cell<u32>,
}

impl Scratch {
    fn founded() -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let now = centraid_vault::time::recurrence::parse_instant_ms(NOW).expect("an instant");
        let handle = Core::open(CoreConfig::new(dir.join("vault.db")).with_clock(
            std::sync::Arc::new(centraid_vault::clock::FixedClock::at(now)),
            std::sync::Arc::new(centraid_vault::clock::ClockIds::new(Box::new(
                centraid_vault::clock::FixedClock::at(now),
            ))),
        ))
        .expect("it opens");
        handle
            .with_vault(|vault| Ok(vault.found("Docs", "Owner")?))
            .expect("it founds");
        Self {
            dir,
            handle,
            writes: std::cell::Cell::new(0),
        }
    }

    fn ask(
        &self,
        query: wire::app_query_request::Query,
    ) -> Result<wire::app_query_response::Answer> {
        match self.handle.call(&wire::Request {
            kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                query: Some(query),
            })),
        })? {
            wire::Response {
                kind: Some(wire::response::Kind::AppQuery(answer)),
            } => Ok(answer.answer.expect("an app query is answered")),
            other => panic!("an app query answered as {other:?}"),
        }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        self.writes.set(self.writes.get() + 1);
        let response = self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Command(wire::Command {
                    name: name.to_owned(),
                    input: serde_json::to_vec(&input).expect("json"),
                    invoke_key: format!("docs-query-test-{}", self.writes.get()),
                    ..wire::Command::default()
                })),
            })
            .unwrap_or_else(|error| panic!("{name} refused: {error}"));
        let Some(wire::response::Kind::Command(outcome)) = response.kind else {
            panic!("a command answered with something else");
        };
        assert_eq!(
            outcome.status,
            wire::CommandStatus::Executed as i32,
            "{name}: {}",
            outcome.reason
        );
        serde_json::from_slice(&outcome.output).expect("the output is JSON")
    }

    fn add(&self, title: &str, body: &str, folder_id: Option<&str>) -> String {
        self.add_uri(
            title,
            &format!("data:text/plain;charset=utf-8,{body}"),
            folder_id,
        )
    }

    fn add_uri(&self, title: &str, data_uri: &str, folder_id: Option<&str>) -> String {
        let mut input = serde_json::json!({ "title": title, "data_uri": data_uri });
        if let Some(folder_id) = folder_id {
            input["folder_id"] = serde_json::json!(folder_id);
        }
        self.run("core.add_document", input)["document_id"]
            .as_str()
            .expect("a document id")
            .to_owned()
    }

    fn folder(&self, name: &str, parent: Option<&str>) -> String {
        let mut input = serde_json::json!({ "name": name });
        if let Some(parent) = parent {
            input["parent_folder_id"] = serde_json::json!(parent);
        }
        self.run("core.create_folder", input)["folder_id"]
            .as_str()
            .expect("a folder id")
            .to_owned()
    }

    fn drive(&self, request: wire::DocsDriveRequest) -> wire::DocsDrive {
        match self
            .ask(wire::app_query_request::Query::DocsDrive(
                wire::DocsDriveRequest {
                    tz: TZ.to_owned(),
                    ..request
                },
            ))
            .expect("the drive answers")
        {
            wire::app_query_response::Answer::DocsDrive(drive) => drive,
            other => panic!("the drive answered as {other:?}"),
        }
    }

    fn shelf(&self, shelf: wire::DocsShelf) -> wire::DocsDrive {
        self.drive(wire::DocsDriveRequest {
            shelf: shelf as i32,
            ..wire::DocsDriveRequest::default()
        })
    }

    fn document(&self, document_id: &str) -> wire::DocsDocument {
        match self
            .ask(wire::app_query_request::Query::DocsDocument(
                wire::DocsDocumentRequest {
                    document_id: document_id.to_owned(),
                    tz: TZ.to_owned(),
                },
            ))
            .expect("the document answers")
        {
            wire::app_query_response::Answer::DocsDocument(document) => document,
            other => panic!("the document answered as {other:?}"),
        }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn titles(drive: &wire::DocsDrive) -> Vec<&str> {
    drive
        .documents
        .iter()
        .map(|row| row.title.as_str())
        .collect()
}

/// AN EMPTY VAULT IS AN EMPTY DRIVE, not a refusal and not an error: no
/// folders scheme exists until something is filed.
#[test]
fn an_empty_vault_answers_an_empty_drive() {
    let scratch = Scratch::founded();
    for shelf in [
        wire::DocsShelf::All,
        wire::DocsShelf::Starred,
        wire::DocsShelf::Recent,
        wire::DocsShelf::Trash,
    ] {
        let drive = scratch.shelf(shelf);
        assert!(drive.documents.is_empty(), "{shelf:?}");
        assert_eq!(drive.all_count, 0);
        assert_eq!(drive.trash_count, 0);
        assert!(!drive.truncated);
        assert_eq!(drive.window, 200, "the default window");
        assert_eq!(drive.today, "2099-06-01", "the device's day, not UTC's");
        assert_eq!(drive.now_local, "2099-06-01T22:00");
    }
    let missing = scratch.document("no-such-document");
    assert!(missing.document.is_none(), "a stale link is a state");
    assert!(missing.versions.is_empty());
    assert_eq!(missing.body, None);
}

/// TRASH IS ITS OWN SHELF: a trashed document leaves All, Starred and its
/// folder, is counted once in `trash_count`, and carries its dates — the purge
/// day thirty local days out.
#[test]
fn a_trashed_document_is_excluded_from_the_drive_and_dated_in_trash() {
    let scratch = Scratch::founded();
    let lease = scratch.add("Lease", "rent", None);
    let receipt = scratch.add("Receipt", "paid", None);
    scratch.run(
        "core.star_document",
        serde_json::json!({ "document_id": receipt }),
    );
    scratch.run(
        "core.trash_document",
        serde_json::json!({ "document_id": receipt }),
    );

    let all = scratch.shelf(wire::DocsShelf::All);
    assert_eq!(titles(&all), ["Lease"]);
    assert_eq!(all.all_count, 1);
    assert_eq!(all.unfiled_count, 1);
    assert_eq!(
        all.starred_count, 0,
        "a star survives trash but not the shelf"
    );
    assert_eq!(all.trash_count, 1);
    assert!(scratch.shelf(wire::DocsShelf::Starred).documents.is_empty());
    let top = scratch.shelf(wire::DocsShelf::Folder);
    assert_eq!(titles(&top), ["Lease"], "the top level, live only");
    let live = &all.documents[0];
    assert_eq!(live.document_id, lease);
    assert!(live.trashed_at.is_empty() && live.purge_at.is_empty());

    let trash = scratch.shelf(wire::DocsShelf::Trash);
    assert_eq!(titles(&trash), ["Receipt"]);
    let row = &trash.documents[0];
    assert!(row.trashed && row.starred);
    assert_eq!(row.trashed_at, NOW);
    assert_eq!(row.trashed_local, "2099-06-01T22:00");
    assert_eq!(row.purge_local_day, "2099-07-01");
    assert_eq!(row.purge_in_days, 30);

    // SEARCH NEVER MATCHES THE TRASH.
    let wire::app_query_response::Answer::DocsSearch(found) = scratch
        .ask(wire::app_query_request::Query::DocsSearch(
            wire::DocsSearchRequest {
                term: "paid".to_owned(),
                limit: 10,
                tz: TZ.to_owned(),
            },
        ))
        .expect("search answers")
    else {
        panic!("search answered as something else");
    };
    assert!(found.documents.is_empty());
}

/// THE FOLDER TREE: nesting is `parent_id`, a folder directly under the root
/// is top level, each folder counts its DIRECT live children, a folder shelf
/// is exactly those, and the document's path is its breadcrumb.
#[test]
fn the_folder_tree_nests_counts_and_paths() {
    let scratch = Scratch::founded();
    let home = scratch.folder("Home", None);
    let leases = scratch.folder("Leases", Some(&home));
    let lease = scratch.add("Lease 2099", "rent", Some(&leases));
    scratch.add("Deed", "land", Some(&home));
    scratch.add("Loose", "note", None);

    let drive = scratch.shelf(wire::DocsShelf::All);
    let by_name = |name: &str| {
        drive
            .folders
            .iter()
            .find(|folder| folder.name == name)
            .unwrap_or_else(|| panic!("{name} is on the rail"))
    };
    assert_eq!(
        drive.folders.len(),
        2,
        "the root is the drive, not a folder"
    );
    assert_eq!(by_name("Home").parent_id, "", "top level");
    assert_eq!(by_name("Leases").parent_id, home);
    assert_eq!(by_name("Home").document_count, 1, "direct children only");
    assert_eq!(by_name("Leases").document_count, 1);
    assert_eq!(drive.unfiled_count, 1);

    let in_leases = scratch.drive(wire::DocsDriveRequest {
        shelf: wire::DocsShelf::Folder as i32,
        folder_id: leases.clone(),
        ..wire::DocsDriveRequest::default()
    });
    assert_eq!(titles(&in_leases), ["Lease 2099"]);
    assert_eq!(in_leases.documents[0].folder_id, leases);

    let opened = scratch.document(&lease);
    let path: Vec<&str> = opened
        .path
        .iter()
        .map(|folder| folder.name.as_str())
        .collect();
    assert_eq!(path, ["Home", "Leases"]);
}

/// VERSION HISTORY IS NEWEST FIRST, numbered from the oldest, with exactly one
/// current — and the reader's body is the head's text.
#[test]
fn the_version_history_is_newest_first_and_numbered_from_the_oldest() {
    let scratch = Scratch::founded();
    let lease = scratch.add("Lease", "first", None);
    for body in ["second", "third"] {
        scratch.run(
            "core.edit_document",
            serde_json::json!({ "document_id": lease, "body_text": body }),
        );
    }
    let opened = scratch.document(&lease);
    let row = opened.document.expect("the document exists");
    assert_eq!(row.surface, wire::DocsSurface::Reading as i32);
    assert_eq!(row.kind, wire::DocsKind::Document as i32);
    assert_eq!(row.kind_name, "Document");
    assert_eq!(row.size, "5 bytes", "the head's bytes, in words");
    assert_eq!(opened.body.as_deref(), Some("third"));
    let numbers: Vec<u32> = opened
        .versions
        .iter()
        .map(|version| version.number)
        .collect();
    assert_eq!(numbers, [3, 2, 1]);
    assert!(opened.versions[0].current);
    assert!(opened.versions[1..].iter().all(|version| !version.current));
    assert_eq!(opened.versions[0].content_id, row.content_id);
    assert_eq!(opened.versions[2].size, "5 bytes");
    // A text document's words are its body, not a file on this device.
    assert!(!opened.bytes_held);
    assert!(!opened.bytes_absent_reason.is_empty());
}

/// BODY ABSENT IS NOT BODY EMPTY: an empty text document answers `Some("")`,
/// and text that did not decode answers `None`.
#[test]
fn an_absent_body_and_an_empty_body_are_two_answers() {
    let scratch = Scratch::founded();
    let empty = scratch.add("Blank", "", None);
    assert_eq!(scratch.document(&empty).body.as_deref(), Some(""));
    // 0xFF is not UTF-8: the one decoder writes no text row for it.
    let undecodable = scratch.add_uri("Garbled", "data:text/plain;base64,/w==", None);
    let opened = scratch.document(&undecodable);
    assert!(opened.document.is_some());
    assert_eq!(opened.body, None);
}

/// Filters compose, the sort is the member's, and a label is matched exactly.
///
/// The Modified filter is proved in `crates/apps/docs/tests/phone.rs` and not
/// here: `core.add_document` leaves `updated_at` to the
/// `core_document_touch_updated_at` trigger, which stamps SQLite's own clock
/// rather than the vault's, so under this suite's stopped clock a new row's
/// `updated_at` is today's host date and not 2099's.
#[test]
fn filters_compose_and_the_sort_is_the_requests() {
    let scratch = Scratch::founded();
    let ten = scratch.add("Scan 10", "b", None);
    scratch.add("scan 2", "a", None);
    scratch.add("Budget.md", "c", None);
    scratch.run(
        "core.tag_item",
        serde_json::json!({ "subject_type": "core.document", "subject_id": ten, "label": "Tax" }),
    );
    let by_name = scratch.drive(wire::DocsDriveRequest {
        sort: wire::DocsSort::Name as i32,
        ascending: true,
        ..wire::DocsDriveRequest::default()
    });
    assert_eq!(titles(&by_name), ["Budget.md", "scan 2", "Scan 10"]);
    assert_eq!(by_name.labels, ["Tax"]);

    let row = by_name
        .documents
        .iter()
        .find(|row| row.title == "Scan 10")
        .expect("a row");
    assert_eq!(row.media_type, "text/plain");
    assert_eq!(
        row.created_local, "2099-06-01T22:00",
        "the vault clock, in New York"
    );
    let tagged = scratch.drive(wire::DocsDriveRequest {
        label: "Tax".to_owned(),
        r#type: wire::DocsTypeFilter::Text as i32,
        ..wire::DocsDriveRequest::default()
    });
    assert_eq!(titles(&tagged), ["Scan 10"]);
    let nothing = scratch.drive(wire::DocsDriveRequest {
        r#type: wire::DocsTypeFilter::Pdf as i32,
        ..wire::DocsDriveRequest::default()
    });
    assert!(nothing.documents.is_empty());
}

/// The activity rail reads the vault's own trail; the zone rule refuses a name
/// the database does not know, as every app query does.
#[test]
fn activity_answers_and_an_unknown_zone_is_refused() {
    let scratch = Scratch::founded();
    let lease = scratch.add("Lease", "rent", None);
    let wire::app_query_response::Answer::DocsActivity(rail) = scratch
        .ask(wire::app_query_request::Query::DocsActivity(
            wire::DocsActivityRequest {
                document_id: lease,
                tz: TZ.to_owned(),
            },
        ))
        .expect("activity answers")
    else {
        panic!("activity answered as something else");
    };
    for event in &rail.events {
        assert_eq!(event.occurred_local, "2099-06-01T22:00");
    }

    let refused = scratch
        .ask(wire::app_query_request::Query::DocsDrive(
            wire::DocsDriveRequest {
                tz: "America/New_Yrok".to_owned(),
                ..wire::DocsDriveRequest::default()
            },
        ))
        .expect_err("an unknown zone is refused");
    assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
    let zero = scratch
        .ask(wire::app_query_request::Query::DocsSearch(
            wire::DocsSearchRequest {
                term: "rent".to_owned(),
                limit: 0,
                tz: TZ.to_owned(),
            },
        ))
        .expect_err("a zero limit is refused");
    assert_eq!(zero.code(), wire::ErrorCode::InvalidRequest);
}
