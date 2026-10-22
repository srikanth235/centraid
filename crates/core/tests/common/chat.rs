//! A member's vault holding the Tahoe scenario behind a real handle, and the
//! chat's calls over the wire.
//!
//! Shared by the chat's integration files. The vault is founded through the
//! door a phone uses (`FoundRequest`, no content) and then seeded with the
//! example scenario (`centraid_core::example::seed`) through the command plane,
//! so what these tests read is the rows a phone holds — and the vault stays
//! WRITABLE, because these tests write through the chat.

use std::sync::Arc;

use centraid_assist::model::Model;
use centraid_assist::testing::ScriptedModel;
use centraid_core::api_proto as wire;
use centraid_core::{Core, CoreConfig, Handle};

pub struct Sample {
    dir: std::path::PathBuf,
    pub handle: Handle,
}

impl Sample {
    /// Where the vault file is, so a test can close the core and open it again.
    pub fn vault_path(&self) -> std::path::PathBuf {
        self.dir.join("vault.db")
    }
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

/// One model step, as the free decoder reads it: a think that states no whole call, so the call is
/// the model's own (a second generation, which stops at `</tool_call>`).
pub fn step(think: &str, tool: &str, args: &[(&str, &str)]) -> [String; 2] {
    let params: String = args
        .iter()
        .map(|(key, value)| format!("<parameter={key}>\n{value}\n</parameter>\n"))
        .collect();
    [
        think.to_owned(),
        format!("\n\n<tool_call>\n<function={tool}>\n{params}</function>\n"),
    ]
}

/// A model that says each step in order, and records what it was asked.
pub fn script(steps: &[[String; 2]]) -> Arc<ScriptedModel> {
    Arc::new(ScriptedModel::new(steps.iter().flatten().cloned()))
}

/// The two steps of a read: look at the tasks, then answer with them. On the scenario that is
/// twelve tasks, six of them drawn.
pub fn read_tasks() -> [[String; 2]; 2] {
    [
        step("plan: look", "find", &[("kind", "task")]),
        step("plan: answer", "answer", &[("rows", "@1")]),
    ]
}

/// What a read of the tasks says on the scenario.
pub const FOUND_TASKS: &str = "Found 12 tasks. Showing 6.";

/// The one step of a turn the model declines.
pub fn decline(reason: &str) -> [String; 2] {
    step("plan: no", "decline", &[("reason", reason)])
}

/// A founded vault seeded with the scenario, with its byte store, and no
/// model loaded.
pub fn sample() -> Sample {
    sample_with(|config| config)
}

/// [`sample`] over a core opened with the member's seed, so Locker can be unlocked.
pub fn sample_with_seed(seed: centraid_identity::Seed) -> Sample {
    sample_with(|config| config.with_seed(seed, 0))
}

fn sample_with(configure: impl FnOnce(CoreConfig) -> CoreConfig) -> Sample {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("the directory is made");
    let path = dir.join("vault.db");
    let handle = Core::open(configure(CoreConfig::new(&path))).expect("a core opens with create");
    handle
        .open_own_bytes(path.with_extension("bytes"))
        .expect("the byte store opens");
    seed_scenario(&handle);
    Sample { dir, handle }
}

/// FOUND `handle`'s file through the wire with no content, then seed the whole
/// scenario into it through the command plane, and insist it landed whole.
pub fn seed_scenario(handle: &Handle) {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Found(wire::FoundRequest {
                display_name: "Sample".to_owned(),
                owner_name: "Me".to_owned(),
                content: wire::FoundContent::Unspecified as i32,
            })),
        })
        .expect("the vault founds");
    let Some(wire::response::Kind::Found(_)) = answer.kind else {
        panic!("a found answered {:?}", answer.kind);
    };
    let report = handle
        .with_vault(|vault| {
            centraid_core::example::seed(
                vault,
                handle.registry(),
                &handle.owner(),
                &|_| true,
                centraid_core::example::now_ms(),
            )
        })
        .expect("the scenario seeds");
    assert!(report.is_whole(), "the scenario seeds whole: {report:?}");
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

/// The plaintexts planted in the Locker item [`with_a_locker_item`] files: its sealed password
/// and its sealed one-time-code seed. The vault holds only their ciphertext.
pub const PLANTED_SECRETS: [&str; 2] = [
    "PLANTED-PASSWORD-zq7xk4-not-in-any-payload",
    "PLANTED-OTPSEED-mv9wr2-not-in-any-payload",
];

/// File a Locker item, `Vaultbank login` (username `ada.vault`), whose password and code seed are
/// sealed under a key written nowhere, through the owner's own door. Returns its id.
pub fn with_a_locker_item(sample: &Sample) -> String {
    use centraid_vault::custody::locker_key::encrypt_under_locker_key;
    let owner = sample.handle.owner();
    let key = sample
        .handle
        .with_vault(|vault| {
            vault
                .locker_generation()
                .map_err(|error| centraid_core::CoreError::InvalidRequest {
                    detail: error.to_string(),
                })
        })
        .expect("the key plane lands");
    let seal = |plaintext: &str| {
        encrypt_under_locker_key(&[0x5a_u8; 32], &key, "lk-vaultbank", plaintext)
            .expect("the cell seals")
    };
    let ran = sample
        .handle
        .with_vault(|vault| {
            vault
                .execute(
                    sample.handle.registry(),
                    &owner,
                    &centraid_vault::commands::Command::new(
                        "locker.add_item",
                        serde_json::json!({
                            "item_id": "lk-vaultbank", "type": "login",
                            "title": "Vaultbank login", "username": "ada.vault",
                            "url": "https://vaultbank.example",
                            "password": seal(PLANTED_SECRETS[0]),
                            "otp_seed": seal(PLANTED_SECRETS[1]),
                            "password_rotated": true, "key_id": key
                        }),
                    ),
                )
                .map_err(centraid_core::CoreError::from)
        })
        .expect("the owner's command answers");
    assert_eq!(
        ran.status,
        centraid_vault::CommandStatus::Executed,
        "{:?}",
        ran.reason
    );
    "lk-vaultbank".to_owned()
}
