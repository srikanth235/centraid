//! Mounted restore enrollment followed by the real runtime's original-fetch worker.
//! The restore network response is scripted; files, custody, secret acknowledgements,
//! shelf mounting, async dispatch and the final core request are real.
mod vault_support;

use centraid_api_proto::core_v1 as wire;
use centraid_core::vaults::Vaults;
use centraid_screens::custody::{door, secrets};
use prost::Message;
use wire::screen_event::Kind as E;

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
