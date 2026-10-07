//! A sample vault behind a real handle, and the chat's calls over the wire.
//!
//! Shared by the chat's two integration files. The sample is founded through
//! the door a phone uses (`FoundRequest` with `FOUND_CONTENT_SAMPLE`), so what
//! these tests read is the Tahoe scenario as a member's phone holds it.

use std::sync::Arc;

use centraid_assist::model::Model;
use centraid_core::api_proto as wire;
use centraid_core::{Core, CoreConfig, Handle};

pub struct Sample {
    dir: std::path::PathBuf,
    pub handle: Handle,
}

impl Drop for Sample {
    fn drop(&mut self) {
        self.handle.close();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The device's zone, stated with every request as a shell states it. UTC, so
/// the scenario's days (which are UTC days) are the member's days whatever hour
/// a test runs at.
pub const TZ: &str = "UTC";

/// A founded sample vault, with its byte store, and no model loaded.
pub fn sample() -> Sample {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("the directory is made");
    let path = dir.join("vault.db");
    let handle = Core::open(CoreConfig::new(&path)).expect("a core opens with create");
    handle
        .open_own_bytes(path.with_extension("bytes"))
        .expect("the byte store opens");
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Found(wire::FoundRequest {
                display_name: "Sample".to_owned(),
                owner_name: "Me".to_owned(),
                content: wire::FoundContent::Sample as i32,
            })),
        })
        .expect("the sample vault founds");
    assert!(matches!(answer.kind, Some(wire::response::Kind::Found(_))));
    Sample { dir, handle }
}

impl Sample {
    /// The directory the vault lives in: forgetting a vault deletes it whole.
    pub fn dir(&self) -> &std::path::Path {
        &self.dir
    }

    /// Put a model in the handle's slot.
    pub fn install(&self, model: Arc<dyn Model>) {
        self.handle.assist().host().install(model);
    }

    pub fn assist(
        &self,
        kind: wire::assist_request::Kind,
    ) -> Result<wire::AssistResponse, centraid_core::CoreError> {
        let answer = self.handle.call(&wire::Request {
            kind: Some(wire::request::Kind::Assist(wire::AssistRequest {
                kind: Some(kind),
            })),
        })?;
        match answer.kind {
            Some(wire::response::Kind::Assist(assist)) => Ok(assist),
            other => panic!("an assist request answered {other:?}"),
        }
    }

    pub fn start(&self, app: &str) -> u64 {
        match self
            .assist(wire::assist_request::Kind::Start(
                wire::AssistStartRequest {
                    app: app.to_owned(),
                    ..wire::AssistStartRequest::default()
                },
            ))
            .expect("a chat starts")
            .kind
        {
            Some(wire::assist_response::Kind::Started(started)) => started.session_id,
            other => panic!("a start answered {other:?}"),
        }
    }

    pub fn send(&self, session_id: u64, turn_id: u64, text: &str) -> wire::AssistSent {
        match self
            .assist(wire::assist_request::Kind::Send(wire::AssistSendRequest {
                session_id,
                text: text.to_owned(),
                tz: TZ.to_owned(),
                regenerate: false,
                turn_id,
                ..wire::AssistSendRequest::default()
            }))
            .expect("a send answers")
            .kind
        {
            Some(wire::assist_response::Kind::Sent(sent)) => sent,
            other => panic!("a send answered {other:?}"),
        }
    }

    /// Every assist event waiting on the queue, oldest first.
    pub fn drain_assist_events(&self) -> Vec<wire::AssistEvent> {
        let mut out = Vec::new();
        while let Ok(Some(event)) = self.handle.next_event(std::time::Duration::from_millis(1)) {
            if let Some(wire::event::Kind::Assist(assist)) = event.kind {
                out.push(assist);
            }
        }
        out
    }
}
