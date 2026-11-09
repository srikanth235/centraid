//! `agenda.attachments` and the Wave 2 read fields (#1173), through `Handle::call` and `Handle::load`
//! as a shell asks them.

use super::super::*;
use crate::config::CoreConfig;
use crate::handle::{Core, Handle};

const NOW: &str = "2099-06-02T02:00:00.000Z";
const TZ: &str = "America/New_York";

struct Scratch {
    dir: std::path::PathBuf,
    handle: Handle,
    writes: std::cell::Cell<u32>,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Scratch {
    fn founded() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let now = centraid_vault::time::recurrence::parse_instant_ms(NOW).expect("an instant");
        let clock = std::sync::Arc::new(centraid_vault::clock::FixedClock::at(now));
        let handle = Core::open(CoreConfig::new(dir.join("vault.db")).with_clock(
            clock.clone(),
            std::sync::Arc::new(centraid_vault::clock::ClockIds::new(Box::new(clock))),
        ))
        .expect("it opens");
        handle
            .with_vault(|vault| Ok(vault.found("Agenda", "Owner")?))
            .expect("it founds");
        handle
            .open_own_bytes(dir.join("vault.bytes"))
            .expect("the byte store opens");
        Self {
            dir,
            handle,
            writes: std::cell::Cell::new(0),
        }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        self.writes.set(self.writes.get() + 1);
        let outcome = self
            .handle
            .command(
                name,
                &input,
                &format!("agenda-attachments-test-{}", self.writes.get()),
            )
            .unwrap_or_else(|error| panic!("{name} refused: {error}"));
        assert_eq!(
            outcome.status,
            centraid_vault::CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn id(&self, name: &str, input: serde_json::Value) -> String {
        self.run(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    /// Stage bytes the way a shell does: begin, one chunk, end.
    fn stage(&self, bytes: &[u8], media_type: &str) -> String {
        let frame = |kind: wire::stage_request::Kind| match self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Stage(wire::StageRequest {
                    kind: Some(kind),
                })),
            })
            .expect("the stage frame is taken")
            .kind
        {
            Some(wire::response::Kind::Stage(wire::StageResponse { kind: Some(kind) })) => kind,
            other => panic!("a stage frame answered as {other:?}"),
        };
        let wire::stage_response::Kind::Begun(begun) =
            frame(wire::stage_request::Kind::Begin(wire::StageBegin {
                media_type: media_type.to_owned(),
                byte_size: bytes.len() as u64,
                ..wire::StageBegin::default()
            }))
        else {
            panic!("begin answers begun");
        };
        frame(wire::stage_request::Kind::Chunk(wire::StageChunk {
            staging_id: begun.staging_id.clone(),
            seq: 0,
            payload: bytes.to_vec(),
        }));
        let wire::stage_response::Kind::Handle(handle) =
            frame(wire::stage_request::Kind::End(wire::StageEnd {
                staging_id: begun.staging_id,
            }))
        else {
            panic!("end answers a handle");
        };
        handle.content_hash
    }

    fn photo(&self, bytes: &[u8]) -> String {
        let blob = self.stage(bytes, "image/png");
        self.id(
            "photo.add",
            serde_json::json!({ "blob": blob, "size": bytes.len(), "media_type": "image/png" }),
        )
    }

    fn document(&self, title: &str, bytes: &[u8]) -> String {
        let blob = self.stage(bytes, "application/pdf");
        self.id(
            "document.add",
            serde_json::json!({
                "title": title, "blob": blob, "size": bytes.len(), "media_type": "application/pdf"
            }),
        )
    }

    fn attach(&self, from: &str, to: &str) {
        self.run(
            "edge.add",
            serde_json::json!({ "from": from, "rel": "attached", "to": to }),
        );
    }

    fn event(&self) -> String {
        self.id(
            "event.propose",
            serde_json::json!({
                "title": "Dinner", "starts": "2099-06-03T19:00:00", "ends": "2099-06-03T20:00:00",
                "zone": TZ, "busy": false, "travel_min": 25,
            }),
        )
    }

    /// `agenda.attachments`, asked as the screens ask it: through `load`.
    fn page(&self, item: &str, after: &str, limit: u32) -> wire::AgendaAttachments {
        let mut request: wire::LoadRequest = wire::LoadRequest {
            app: "calendar".to_owned(),
            query: "attachments".to_owned(),
            limit,
            after: after.to_owned(),
            ..Default::default()
        };
        request.params.insert(
            "item_id".to_owned(),
            wire::Value {
                kind: Some(wire::value::Kind::Text(item.to_owned())),
            },
        );
        match self
            .handle
            .load(&request)
            .expect("the load answers")
            .answer
            .and_then(|answer| answer.answer)
        {
            Some(wire::app_query_response::Answer::AgendaAttachments(page)) => page,
            other => panic!("attachments answered as {other:?}"),
        }
    }
}

/// Photos and documents attached to an event come back a page at a time, each named, typed and
/// sized; an image carries the file that draws it and a PDF does not; the cursor walks the rest.
#[test]
fn attachments_page_through_with_thumbnails_for_images_only() {
    let scratch = Scratch::founded();
    let event = scratch.event();
    let photo = scratch.photo(b"not-really-a-png-but-held");
    let lease = scratch.document("Lease", b"%PDF-1.7 lease");
    let menu = scratch.document("Menu", b"%PDF-1.7 menu");
    for id in [&photo, &lease, &menu] {
        scratch.attach(&event, id);
    }

    let first = scratch.page(&event, "", 2);
    assert_eq!(first.attachments.len(), 2);
    let cursor = first.next.clone().expect("one more page");
    assert!(cursor.contains('\u{1f}'), "the cursor is the joined pair");
    let second = scratch.page(&event, &cursor, 2);
    assert_eq!(second.attachments.len(), 1);
    assert!(second.next.is_none(), "the last page has no cursor");

    let all: Vec<&wire::AgendaAttachmentRow> = first
        .attachments
        .iter()
        .chain(second.attachments.iter())
        .collect();
    let by_id = |id: &str| {
        all.iter()
            .find(|row| row.attachment_id == id)
            .copied()
            .expect("the attachment is on a page")
    };
    let picture = by_id(&photo);
    assert_eq!(picture.kind, "photo");
    assert_eq!(picture.media_type, "image/png");
    assert!(
        !picture.thumbnail_path.is_empty(),
        "a held image is drawn from a file"
    );
    let file = by_id(&lease);
    assert_eq!(file.kind, "document");
    assert_eq!(file.title.as_deref(), Some("Lease"));
    assert_eq!(file.media_type, "application/pdf");
    assert!(file.byte_size > 0);
    assert!(file.thumbnail_path.is_empty(), "a PDF has no picture");
}

/// An id that is nothing, a trashed attachment and an item with nothing are an empty page, never a
/// failure.
#[test]
fn attachments_of_nothing_and_a_trashed_file_are_an_empty_page() {
    let scratch = Scratch::founded();
    let event = scratch.event();
    assert!(scratch.page(&event, "", 10).attachments.is_empty());
    assert!(scratch.page("no-such-item", "", 10).attachments.is_empty());
    let doc = scratch.document("Receipt", b"%PDF-1.7 receipt");
    scratch.attach(&event, &doc);
    assert_eq!(scratch.page(&event, "", 10).attachments.len(), 1);
    scratch.run("entity.trash", serde_json::json!({ "id": doc }));
    assert!(
        scratch.page(&event, "", 10).attachments.is_empty(),
        "a file in the trash is left out"
    );
}

/// The event read carries the member's free/busy and travel time, and the task read its address.
#[test]
fn the_event_and_task_reads_carry_busy_travel_and_the_url() {
    let scratch = Scratch::founded();
    let event = scratch.event();
    let answer = scratch
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                query: Some(wire::app_query_request::Query::AgendaEvent(
                    wire::AgendaEventRequest {
                        event_id: event.clone(),
                        instance_key: String::new(),
                        original_start_local: String::new(),
                        tz: TZ.to_owned(),
                    },
                )),
            })),
        })
        .expect("the event read answers");
    let Some(wire::response::Kind::AppQuery(response)) = answer.kind else {
        panic!("not an app query answer");
    };
    let Some(wire::app_query_response::Answer::AgendaEvent(detail)) = response.answer else {
        panic!("not an event answer");
    };
    let row = detail.event.expect("the event is there");
    assert!(!row.busy, "stored free reads as free");
    assert_eq!(row.travel_min, Some(25));
    assert!(detail.followed_guests.is_empty());

    let task = scratch.id(
        "task.add",
        serde_json::json!({ "title": "Book flights", "url": "https://example.com/flights" }),
    );
    let answer = scratch
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                query: Some(wire::app_query_request::Query::AgendaTask(
                    wire::AgendaTaskRequest {
                        task_id: task,
                        tz: TZ.to_owned(),
                    },
                )),
            })),
        })
        .expect("the task read answers");
    let Some(wire::response::Kind::AppQuery(response)) = answer.kind else {
        panic!("not an app query answer");
    };
    let Some(wire::app_query_response::Answer::AgendaTask(detail)) = response.answer else {
        panic!("not a task answer");
    };
    assert_eq!(
        detail.task.expect("the task").url.as_deref(),
        Some("https://example.com/flights")
    );
}
