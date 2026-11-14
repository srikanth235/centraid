//! Mounted restore enrollment followed by the real runtime's original-fetch worker.
//! The restore network response is scripted; files, custody, secret acknowledgements,
//! shelf mounting, async dispatch and the final core request are real.
mod vault_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::VaultRequest;
use centraid_core::vaults::Vaults;
use centraid_core::{Core, CoreConfig};
use centraid_screens::catalog::act;
use centraid_screens::custody::enrollment::{Env, Job, Out, Restored, Runner};
use centraid_screens::custody::{door, secrets};
use centraid_screens::field::Keyed;
use centraid_screens::{Ctx, Registry, Runtime, Screen, vault};
use prost::Message;
use wire::screen_event::Kind as E;

struct FetchProbe {
    hash: Option<Vec<u8>>,
    heard: String,
}

impl Screen for FetchProbe {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                if let Some(hash) = self.hash.take() {
                    ctx.vault_async(
                        "probe",
                        VaultRequest::FetchOriginal(wire::FetchOriginalRequest {
                            content_hash: hash,
                        }),
                    );
                    self.heard = "queued".to_owned();
                }
            }
            Some(E::OffThreadDone(done)) => {
                let called =
                    wire::VaultCalled::decode(done.bytes.as_slice()).expect("typed worker answer");
                self.heard = if let Some(error) = called.error {
                    format!("error:{:?}", error.code())
                } else {
                    let response =
                        wire::Response::decode(called.response.as_slice()).expect("core response");
                    match response.kind {
                        Some(wire::response::Kind::FetchOriginal(answer)) => {
                            format!("outcome:{:?}", answer.outcome())
                        }
                        _ => "wrong-response".to_owned(),
                    }
                };
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Counter(wire::CounterView {
                title: self.heard.clone(),
                ..Default::default()
            })),
            ..Default::default()
        }
    }
}

fn route(screen: &str) -> wire::Route {
    wire::Route {
        screen: screen.to_owned(),
        ..Default::default()
    }
}

#[test]
fn restored_enrollment_mounts_keys_and_the_real_screen_worker_returns_a_typed_fetch_outcome() {
    let dir = vault_support::scratch();
    let raw = b"Public absent recovery original\r\n";
    let hash = centraid_vault::blob::content_digest(raw);
    let digest: Vec<u8> = hash
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).expect("ASCII"), 16).expect("hex"))
        .collect();
    let build = |shelf: &std::sync::Arc<vault::Shelf>, cache: &secrets::VaultSecrets| {
        let digest = digest.clone();
        Runtime::new(
            Registry::default()
                .with("idle", |_| {
                    Some(Box::new(FetchProbe {
                        hash: None,
                        heard: String::new(),
                    }))
                })
                .with("fetch", move |_| {
                    Some(Box::new(FetchProbe {
                        hash: Some(digest.clone()),
                        heard: String::new(),
                    }))
                })
                .merge(vault::registry(shelf, cache)),
            vec![("probe".to_owned(), route("idle"))],
        )
        .with_services(vault::services())
    };
    let mut phone = vault_support::Phone::running(&dir, build);
    phone.launch();
    assert!(phone.holdings().vaults.is_empty());

    // What the network restore lays down, after the empty shelf has launched.
    let vault_id = vault_support::lay_down(&dir, "restored", "Public restored vault");
    let path = dir.join("restored/vault.db");
    let core = Core::open(CoreConfig::new(&path).opening_existing()).expect("fixture opens");
    let uploaded = core
        .act(
            &act::docs::Upload {
                blob: hash,
                size: Some(raw.len() as i64),
                media_type: "text/plain".to_owned(),
                title: "Public absent recovery.txt".to_owned(),
                ..Default::default()
            }
            .request()
            .keyed("fixture:upload"),
        )
        .expect("upload response");
    assert_eq!(
        uploaded.status,
        wire::ActStatus::Executed as i32,
        "{}",
        uploaded.reason
    );
    core.close();
    core.close_file().expect("fixture closes whole");

    let restored = wire::VaultCalled {
        response: wire::Response {
            kind: Some(wire::response::Kind::Restore(wire::RestoreResponse {
                vaults: vec![wire::RestoredVault {
                    vault_id: vault_id.clone(),
                    path: path.to_string_lossy().into_owned(),
                    index: 0,
                    ..Default::default()
                }],
                ..Default::default()
            })),
        }
        .encode_to_vec(),
        error: None,
    }
    .encode_to_vec();
    let mut words = vec!["abandon".to_owned(); 23];
    words.push("art".to_owned());
    let mut runner = Runner::default();
    let mut restore_answers = 0;
    let out = phone.driver.with_ctx(|ctx| {
        let env = Env {
            ctx,
            secrets: &phone.secrets,
            keeper: &*phone.shelf,
        };
        let mut progress = runner.begin(Job::restore(words, "public-test-payload"), &env);
        for _ in 0..32 {
            if let Some(out) = progress.out {
                return out;
            }
            if let Some(effect) = progress.effects.pop() {
                assert!(progress.effects.is_empty(), "one custody ask at a time");
                let outcome = match effect.kind.expect("effect") {
                    wire::effect::Kind::Secrets(batch) => {
                        wire::effect_result::Outcome::Secrets(phone.shell.batch(&batch))
                    }
                    wire::effect::Kind::SyncedProbe(_) => {
                        wire::effect_result::Outcome::SyncedStatus(wire::SyncedSecretsStatus {
                            synchronizing: phone.shell.synchronizing,
                            restores_after_setup: phone.shell.restores_after_setup,
                        })
                    }
                    _ => panic!("unexpected custody effect"),
                };
                progress = runner
                    .answered(
                        &wire::EffectResult {
                            outcome: Some(outcome),
                            ..Default::default()
                        },
                        &env,
                    )
                    .expect("pending ask");
            } else {
                restore_answers += 1;
                assert_eq!(restore_answers, 1, "one scripted network response");
                progress = runner
                    .off_thread(
                        &wire::OffThreadDone {
                            tag: door::RESTORE.to_owned(),
                            bytes: restored.clone(),
                        },
                        &env,
                    )
                    .expect("pending restore");
            }
        }
        panic!("custody exceeded its bounded asks");
    });
    assert!(matches!(
        out,
        Out::Restored(Restored::Done { added: 1, .. })
    ));
    assert!(
        phone.held(&vault_id).keyed,
        "successful custody adoption must open the actual foreground keyed"
    );
    assert!(phone.secrets.seed().is_some());
    // A cold process has only the acknowledged stores and the restored file.
    let shell = phone.shell.clone();
    phone.shelf.close_all();
    phone.driver.handle.close();
    drop(phone);
    let mut phone = vault_support::Phone::running(&dir, build);
    phone.shell = shell;
    phone.launch_blind();
    assert!(
        phone.held(&vault_id).keyed,
        "cold survey/hydration must recover the acknowledged seed and vault index"
    );
    // Drain the foreground-change announcement before pushing a page for it.
    phone.driver.pump(Duration::ZERO);
    let id = phone.driver.push("probe", route("fetch"));
    assert_eq!(phone.driver.counter(id).title, "queued");
    phone.driver.pump(Duration::from_secs(10));
    assert_eq!(
        phone.driver.counter(id).title,
        "outcome:Unreachable",
        "no paired gateway is a typed outcome, not a missing key/store/runtime response"
    );
    // Only the public fixture's key existence, never its value, is asserted here.
    assert!(phone.shell.device.contains_key(secrets::LOCAL_WORDS));
}

fn entered_runtime_restore(dir: &std::path::Path) -> (vault_support::Phone, u64, String) {
    use centraid_screens::custody;
    use wire::words_enter_event::Kind as W;
    let mut phone = vault_support::Phone::standard(dir);
    phone.launch();
    let id = phone.driver.push("home", custody::routes::restore());
    phone.driver.serve(&mut phone.shell);
    let mut send = |kind| {
        phone.driver.send(
            id,
            E::WordsEnter(wire::WordsEnterEvent { kind: Some(kind) }),
        );
        phone.driver.serve(&mut phone.shell);
    };
    send(W::Endpoint(wire::WordsEndpointTyped {
        text: "public-test-payload".to_owned(),
    }));
    send(W::Typed(wire::WordsWordTyped {
        position: 1,
        text: [vec!["abandon"; 23].join(" "), "art".to_owned()].join(" "),
    }));
    send(W::Primary(wire::WordsPrimary {}));
    let at = phone.driver.effects.iter().position(|request| matches!(request.effect.as_ref().and_then(|effect| effect.kind.as_ref()), Some(wire::effect::Kind::OwnerCheck(check)) if check.ask)).expect("the restore asks its own owner check");
    let request = phone.driver.effects.remove(at);
    assert_eq!(request.instance, id);
    phone.driver.send(
        id,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(wire::effect_result::Outcome::OwnerChecked(
                wire::OwnerChecked {
                    available: true,
                    outcome: wire::owner_checked::Outcome::Succeeded as i32,
                    ..Default::default()
                },
            )),
        }),
    );
    phone.driver.serve(&mut phone.shell);
    let Some(wire::view_state::Kind::WordsEnter(state)) = &phone.driver.view(id).kind else {
        panic!("words form");
    };
    assert_eq!(
        state.phase,
        wire::words_enter_state::Phase::Working as i32,
        "the exact owner reply must start restore before the scripted response"
    );

    // The network response is the sole script; the initiating words screen,
    // runtime, shelf and platform secret acknowledgements are the real path.
    let vault_id = vault_support::lay_down(dir, "recovered", "Public recovered vault");
    let path = dir.join("recovered/vault.db");
    phone.driver.send(
        id,
        E::OffThreadDone(wire::OffThreadDone {
            tag: door::RESTORE.to_owned(),
            bytes: wire::VaultCalled {
                response: wire::Response {
                    kind: Some(wire::response::Kind::Restore(wire::RestoreResponse {
                        vaults: vec![wire::RestoredVault {
                            vault_id: vault_id.clone(),
                            index: 0,
                            path: path.to_string_lossy().into_owned(),
                            ..Default::default()
                        }],
                        ..Default::default()
                    })),
                }
                .encode_to_vec(),
                error: None,
            }
            .encode_to_vec(),
        }),
    );
    (phone, id, vault_id)
}

#[test]
fn actual_words_runtime_persists_restored_indices_before_foreground_replaces_the_screen() {
    let dir = vault_support::scratch();
    let (mut phone, _, vault_id) = entered_runtime_restore(&dir);
    phone.driver.serve(&mut phone.shell);
    assert_eq!(
        phone
            .shell
            .device
            .get(&format!("{}{vault_id}", secrets::INDEX_PREFIX))
            .map(String::as_str),
        Some("0"),
        "the screen's replacement must not discard the index-write effect"
    );
    assert_eq!(
        phone
            .shell
            .device
            .get(secrets::INDEX_HIGH_WATER)
            .map(String::as_str),
        Some("0")
    );
    let shell = phone.shell.clone();
    phone.shelf.close_all();
    phone.driver.handle.close();
    drop(phone);
    let mut cold = vault_support::Phone::standard(&dir);
    cold.shell = shell;
    cold.launch_blind();
    assert!(
        cold.held(&vault_id).keyed,
        "the acknowledged restored index must survive the actual runtime lifetime"
    );
}

#[test]
fn actual_words_runtime_keeps_the_form_and_foreground_when_mapping_write_or_readback_fails() {
    for fail_get in [false, true] {
        let dir = vault_support::scratch();
        let (mut phone, id, vault_id) = entered_runtime_restore(&dir);
        let key = format!("{}{vault_id}", secrets::INDEX_PREFIX);
        let mut refused = false;
        for _ in 0..64 {
            let Some(at) = phone.driver.effects.iter().position(|request| {
                matches!(
                    request
                        .effect
                        .as_ref()
                        .and_then(|effect| effect.kind.as_ref()),
                    Some(wire::effect::Kind::Secrets(_) | wire::effect::Kind::SyncedProbe(_))
                )
            }) else {
                break;
            };
            let request = phone.driver.effects.remove(at);
            let outcome = match request.effect.expect("effect").kind.expect("kind") {
                wire::effect::Kind::Secrets(batch) => {
                    let fail = batch.ops.iter().any(|op| {
                        op.key == key
                            && op.op
                                == if fail_get {
                                    wire::secret_op::Op::Get as i32
                                } else {
                                    wire::secret_op::Op::Set as i32
                                }
                    });
                    if fail {
                        assert_eq!(
                            phone.shelf.foreground_id(),
                            None,
                            "pending mapping must not bring the recovered vault forward"
                        );
                        assert!(!phone.driver.closed.contains(&id));
                        refused = true;
                        wire::effect_result::Outcome::Secrets(wire::SecretBatched {
                            answers: vec![wire::SecretAnswer::default(); batch.ops.len()],
                        })
                    } else {
                        wire::effect_result::Outcome::Secrets(phone.shell.batch(&batch))
                    }
                }
                wire::effect::Kind::SyncedProbe(_) => {
                    wire::effect_result::Outcome::SyncedStatus(wire::SyncedSecretsStatus {
                        synchronizing: phone.shell.synchronizing,
                        restores_after_setup: phone.shell.restores_after_setup,
                    })
                }
                _ => unreachable!(),
            };
            phone.driver.send(
                request.instance,
                E::EffectResult(wire::EffectResult {
                    effect_id: request.effect_id,
                    outcome: Some(outcome),
                }),
            );
            if refused {
                break;
            }
        }
        assert!(refused, "the actual metadata request must reach the shell");
        assert_eq!(phone.shelf.foreground_id(), None);
        assert!(!phone.driver.closed.contains(&id));
        let Some(wire::view_state::Kind::WordsEnter(state)) = &phone.driver.view(id).kind else {
            panic!("words form");
        };
        assert_eq!(state.phase, wire::words_enter_state::Phase::Entering as i32);
        assert!(!state.notice.is_empty());
        assert!(!state.finished);
    }
}
