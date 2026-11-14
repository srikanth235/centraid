//! Explicit original retrieval over a real document query and the existing off-thread door.
use super::*;
use crate::field::Keyed;
use crate::screen::{Done, Environment};
use crate::testing::Driver;
use prost::Message;

const RAW: &[u8] = b"\xef\xbb\xbfPublic recovery file\r\nsecond line\r\n";

struct Rig {
    driver: Driver,
    screen: Box<dyn Screen>,
    env: Environment,
    id: String,
    hash: String,
}

fn upload(driver: &Driver, bytes: &[u8], text: Option<&str>) -> String {
    let response = driver.act(
        act::docs::Upload {
            blob: centraid_vault::blob::content_digest(bytes),
            media_type: "text/plain".to_owned(),
            title: "Public recovery file.txt".to_owned(),
            size: Some(bytes.len() as i64),
            text: text.map(str::to_owned),
            ..Default::default()
        }
        .request()
        .keyed(kit_act::key(&["fixture"], kit_act::fresh())),
    );
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "{}",
        response.reason
    );
    serde_json::from_slice::<serde_json::Value>(&response.output).expect("JSON")["id"]
        .as_str()
        .expect("id")
        .to_owned()
}

impl Rig {
    fn new(text: Option<&str>) -> Self {
        let driver = Driver::keyed(crate::docs::runtime());
        let id = upload(&driver, RAW, text);
        let screen = build(&crate::docs::routes::document(
            &id,
            "Public recovery file.txt",
            "Docs",
        ))
        .expect("screen");
        let mut rig = Self {
            driver,
            screen,
            env: Environment::default(),
            id,
            hash: centraid_vault::blob::content_digest(RAW),
        };
        rig.send(E::Appeared(Default::default()));
        rig
    }

    fn send(&mut self, kind: E) -> Done {
        let ctx = Ctx::new(&*self.driver.handle, &self.env);
        let effects = self
            .screen
            .update(wire::ScreenEvent { kind: Some(kind) }, &ctx);
        assert!(
            effects.is_empty(),
            "original fetching uses the core, not platform effects"
        );
        ctx.finish()
    }

    fn pick(&mut self, key: &str) -> Done {
        self.send(E::DocsDocument(wire::DocsDocumentEvent {
            kind: Some(D::Action(wire::docs_document_event::ActionPicked {
                key: key.to_owned(),
            })),
        }))
    }

    fn state(&self) -> wire::DocsDocumentState {
        let ctx = Ctx::new(&*self.driver.handle, &self.env);
        let Some(wire::view_state::Kind::DocsDocument(state)) = self.screen.view(&ctx).kind else {
            panic!("document state");
        };
        state
    }

    fn data(&self) -> wire::DocsDocumentData {
        let Some(wire::docs_document_state::Content::Data(data)) = self.state().content else {
            panic!("document data");
        };
        *data
    }

    fn download_enabled(&self) -> bool {
        self.data()
            .bar
            .iter()
            .find(|action| action.key == KEY_DOWNLOAD)
            .expect("download action")
            .enabled
    }

    fn current(&self) -> wire::DocsDocument {
        let ctx = Ctx::new(&*self.driver.handle, &self.env);
        let loaded = ctx
            .load(
                load::docs::History {
                    document_id: self.id.clone(),
                }
                .into(),
            )
            .expect("load");
        let Some(Answer::DocsDocument(document)) = loaded.answer.and_then(|answer| answer.answer)
        else {
            panic!("document");
        };
        document
    }
}

fn completed(tag: &str, outcome: wire::FetchOutcome) -> E {
    E::OffThreadDone(wire::OffThreadDone {
        tag: tag.to_owned(),
        bytes: wire::VaultCalled {
            response: wire::Response {
                kind: Some(wire::response::Kind::FetchOriginal(
                    wire::FetchOriginalResponse {
                        outcome: outcome as i32,
                        path: String::new(),
                    },
                )),
            }
            .encode_to_vec(),
            error: None,
        }
        .encode_to_vec(),
    })
}

fn stage(driver: &Driver, bytes: &[u8]) {
    let frame = |kind| {
        let response = driver
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Stage(wire::StageRequest {
                    kind: Some(kind),
                })),
            })
            .expect("stage");
        let Some(wire::response::Kind::Stage(response)) = response.kind else {
            panic!("stage response");
        };
        response.kind.expect("stage kind")
    };
    let wire::stage_response::Kind::Begun(begun) =
        frame(wire::stage_request::Kind::Begin(wire::StageBegin {
            byte_size: bytes.len() as u64,
            media_type: "text/plain".to_owned(),
            source: wire::StageSource::Owned as i32,
            ..Default::default()
        }))
    else {
        panic!("begun");
    };
    for (seq, payload) in bytes.chunks(begun.chunk_bytes as usize).enumerate() {
        frame(wire::stage_request::Kind::Chunk(wire::StageChunk {
            staging_id: begun.staging_id.clone(),
            seq: seq as u64,
            payload: payload.to_vec(),
        }));
    }
    let wire::stage_response::Kind::Handle(held) =
        frame(wire::stage_request::Kind::End(wire::StageEnd {
            staging_id: begun.staging_id,
        }))
    else {
        panic!("handle");
    };
    assert_eq!(
        held.content_hash,
        centraid_vault::blob::content_digest(bytes)
    );
}

#[test]
fn a_missing_original_has_one_explicit_remedy_and_no_missing_body_edit_route() {
    let mut r = Rig::new(None);
    let data = r.data();
    assert_eq!(data.bar.len(), 5);
    assert_eq!(data.bar[0].key, KEY_DOWNLOAD);
    assert_eq!(data.bar[0].label, "Download original");
    assert_eq!(data.bar[0].icon_key, "Download");
    assert!(data.actions.iter().any(|action| action.key == KEY_DOWNLOAD));
    assert!(
        data.actions
            .iter()
            .all(|action| action.key != fold::KEY_EDIT)
    );
    let Some(wire::docs_document_data::Surface::Reading(reader)) = data.surface else {
        panic!("reader");
    };
    assert!(!reader.has_text && !reader.editable);
    assert_eq!(reader.no_text, "This document isn't on this phone yet.");
    r.send(E::DocsDocument(wire::DocsDocumentEvent {
        kind: Some(D::MoreOpened(Default::default())),
    }));
    let Some(wire::docs_sheet::Body::Actions(actions)) = r.state().sheet.expect("sheet").body
    else {
        panic!("actions");
    };
    assert!(
        actions
            .actions
            .iter()
            .any(|action| action.key == KEY_DOWNLOAD && action.enabled)
    );
}

#[test]
fn empty_and_extracted_bodies_remain_editable_while_original_availability_is_independent() {
    let r = Rig::new(Some("An extracted body\n"));
    let mut answer = r.current();
    assert!(!answer.bytes_held);
    // The Upload action requires nonempty extracted text. The query contract
    // also represents an intentionally blank derivative as Some("").
    for body in ["", "An extracted body\n"] {
        answer.body = Some(body.to_owned());
        let data = fold::document(
            Locale::En,
            crate::kit::quantity::UnitsPref::Metric,
            crate::kit::civil::HourCycle::H24,
            &answer,
            None,
            false,
        );
        assert!(
            data.actions
                .iter()
                .any(|action| action.key == fold::KEY_EDIT)
        );
        assert!(data.actions.iter().any(|action| action.key == KEY_DOWNLOAD));
        assert_eq!(
            fold::editor(Locale::En, &answer).expect("editable").body,
            body
        );
        let Some(wire::docs_document_data::Surface::Reading(reader)) = data.surface else {
            panic!("reader");
        };
        assert!(reader.has_text && reader.editable);
        assert_eq!(reader.body, body);
    }
}

#[test]
fn one_tap_queues_one_real_core_door_and_a_failure_stops_progress_with_retry() {
    let mut r = Rig::new(None);
    let rev = r.current().rev;
    let mut first = r.pick(KEY_DOWNLOAD);
    assert_eq!(first.jobs.len(), 1);
    assert!(!r.download_enabled());
    assert_eq!(
        r.state().status.expect("progress").sentence,
        "Downloading the original…"
    );
    assert_eq!(r.pick(KEY_DOWNLOAD).jobs.len(), 0);
    let (tag, work) = first.jobs.pop().expect("job");
    // No paired gateway: the real keyed core door answers Unreachable, without platform effects.
    let bytes = work(&r.driver.handle);
    r.send(E::OffThreadDone(wire::OffThreadDone { tag, bytes }));
    assert!(r.download_enabled());
    let status = r.state().status.expect("failure");
    assert!(status.refused);
    assert_eq!(
        status.sentence,
        "Can't reach your backup device. Try again later."
    );
    assert_eq!(r.current().rev, rev);
    assert!(r.current().body.is_none());
}

#[test]
fn landed_and_already_held_explicitly_reload_the_actual_bytes_and_preserve_raw_content() {
    for outcome in [wire::FetchOutcome::Landed, wire::FetchOutcome::AlreadyHeld] {
        let mut r = Rig::new(None);
        let rev = r.current().rev;
        let jobs = r.pick(KEY_DOWNLOAD);
        let tag = jobs.jobs[0].0.clone();
        stage(&r.driver, RAW);
        r.send(completed(&tag, outcome));
        let current = r.current();
        assert!(current.bytes_held);
        assert_eq!(std::fs::read(&current.bytes_path).expect("raw bytes"), RAW);
        assert_eq!(current.rev, rev);
        let data = r.data();
        assert_eq!(data.bar[0].key, KEY_SHARE);
        assert!(
            data.actions
                .iter()
                .any(|action| action.key == fold::KEY_EDIT)
        );
        assert!(data.actions.iter().all(|action| action.key != KEY_DOWNLOAD));
        let Some(wire::docs_document_data::Surface::Reading(reader)) = data.surface else {
            panic!("reader");
        };
        assert!(reader.has_text && reader.editable);
        assert_eq!(reader.body, "Public recovery file\r\nsecond line\r\n");
    }
}

#[test]
fn a_nominal_success_without_current_local_bytes_is_not_presented_as_a_preview() {
    let mut r = Rig::new(None);
    let jobs = r.pick(KEY_DOWNLOAD);
    r.send(completed(&jobs.jobs[0].0, wire::FetchOutcome::Landed));
    assert!(!r.current().bytes_held);
    assert!(r.download_enabled());
    assert!(r.state().status.expect("no false success").refused);
}

#[test]
fn unrelated_and_replaced_head_completions_cannot_claim_the_current_original_arrived() {
    let mut r = Rig::new(None);
    let jobs = r.pick(KEY_DOWNLOAD);
    r.send(completed(
        "original.fetch:unrelated",
        wire::FetchOutcome::Landed,
    ));
    assert!(
        !r.download_enabled(),
        "unrelated completion cannot consume the pending request"
    );
    let next = b"Different current head\n";
    upload(&r.driver, next, None); // register its bytes metadata, as another upload would
    let response = r.driver.act(
        act::docs::Replace {
            document_id: r.id.clone(),
            blob: centraid_vault::blob::content_digest(next),
            ..Default::default()
        }
        .request()
        .keyed("fixture:replace"),
    );
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "{}",
        response.reason
    );
    r.send(E::DataChanged(Default::default()));
    stage(&r.driver, RAW);
    r.send(completed(&jobs.jobs[0].0, wire::FetchOutcome::Landed));
    assert_ne!(r.data().row.expect("row").content_id, r.hash);
    assert!(!r.current().bytes_held);
    assert!(r.download_enabled());
    assert!(
        r.state().status.is_none(),
        "no stale success or failure for the new head"
    );
}

#[test]
fn a_download_reply_does_not_discard_a_later_user_actions_undo() {
    let mut r = Rig::new(None);
    let jobs = r.pick(KEY_DOWNLOAD);
    r.pick(KEY_STAR);
    assert_eq!(r.state().status.expect("star Undo").action_label, "Undo");
    r.send(completed(&jobs.jobs[0].0, wire::FetchOutcome::Unreachable));
    assert_eq!(
        r.state().status.expect("newer Undo survives").action_label,
        "Undo"
    );
}

#[test]
fn a_popped_page_and_malformed_matching_answer_never_stay_fetching() {
    let mut r = Rig::new(None);
    let jobs = r.pick(KEY_DOWNLOAD);
    let malformed = E::OffThreadDone(wire::OffThreadDone {
        tag: jobs.jobs[0].0.clone(),
        bytes: vec![255],
    });
    r.send(malformed);
    assert!(r.download_enabled());
    assert!(r.state().status.expect("typed no-answer").refused);
    let jobs = r.pick(KEY_DOWNLOAD);
    r.send(E::Left(Default::default()));
    r.send(completed(&jobs.jobs[0].0, wire::FetchOutcome::Landed));
    assert!(r.state().status.is_none());
}

#[test]
fn gone_trashed_invalid_and_already_held_rows_do_not_offer_fetch() {
    for document in [
        wire::DocsDocument::default(),
        wire::DocsDocument {
            document: Some(wire::DocsDocumentRow {
                content_id: "ab".repeat(32),
                trashed: true,
                ..Default::default()
            }),
            ..Default::default()
        },
        wire::DocsDocument {
            document: Some(wire::DocsDocumentRow {
                content_id: "not-a-content-id".to_owned(),
                ..Default::default()
            }),
            ..Default::default()
        },
        wire::DocsDocument {
            document: Some(wire::DocsDocumentRow {
                content_id: "ab".repeat(32),
                ..Default::default()
            }),
            bytes_held: true,
            ..Default::default()
        },
    ] {
        assert!(!fold::offers_download(&document));
        assert!(
            fold::head_actions(Locale::En, &document, false)
                .iter()
                .all(|action| action.key != KEY_DOWNLOAD)
        );
        assert!(
            fold::bar_actions(Locale::En, &document, false)
                .iter()
                .all(|action| action.key != KEY_DOWNLOAD)
        );
    }
}
