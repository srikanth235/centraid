use centraid_api_proto::core_v1 as wire;
use serde_json::Value;

use super::door::Door;
use super::screen::{Event, Input, Outcome};
use crate::strings::{Locale, shared};

const EN: Locale = Locale::En;
const OWNER: &str = "room-export:owner:";
const SAVE: &str = "room-export:save:";
const SHARE: &str = "room-share:done:";
const CLIPBOARD: &str = "room-clipboard:done:";

pub fn cleanup_pending(door: &dyn Door, tag: &str) {
    if let Some(payload) = tag.strip_prefix(SAVE)
        && let Ok(payload) = serde_json::from_str::<Value>(payload)
        && let Some(path) = payload.get("path").and_then(Value::as_str)
    {
        door.remove_export(path);
    }
}

pub fn share(title: &str, noun: &str, text: Option<&str>, done_words: &str) -> Outcome {
    let Some(kind) = centraid_domain::KINDS.iter().find(|kind| kind.id == noun) else {
        return Outcome::refuse(&shared::share_failed(EN));
    };
    let centraid_domain::kind::Share::Payload(formatter) = kind.share else {
        return Outcome::refuse(&shared::share_failed(EN));
    };
    let payload = formatter(&centraid_domain::kind::Shown { noun, title, text });
    let item = wire::ShellShareItem {
        name: title.to_owned(),
        media_type: "text/plain".to_owned(),
        text: payload,
        path: String::new(),
    };
    let tag = format!("{SHARE}{}", done_words);
    Outcome::effect(
        &tag,
        wire::shell_effect::Kind::Share(wire::ShellShare {
            items: vec![item],
            subject: title.to_owned(),
        }),
    )
}

pub fn copy(text: &str, done_words: &str) -> Outcome {
    Outcome::effect(
        &format!("{CLIPBOARD}{done_words}"),
        wire::shell_effect::Kind::ClipboardCopy(wire::ShellClipboardCopy {
            text: text.to_owned(),
            sealed: false,
            lease_s: 60,
            owner_vault_id: String::new(),
            clear_owned: false,
        }),
    )
}

pub fn download_original(e: &mut Event<'_>, blob: &str) -> Outcome {
    fetch_original(e, blob)
}

pub fn ask(command: &str, input: Value, reason: &str) -> Outcome {
    let serialized = serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_owned());
    let tag = format!("{OWNER}{command}:{serialized}:{reason}");
    Outcome::effect(
        &tag,
        wire::shell_effect::Kind::OwnerCheck(wire::ShellOwnerCheck {
            reason: reason.to_owned(),
            ..Default::default()
        }),
    )
}

pub fn handle(e: &mut Event<'_>, tag: &str, input: &Input) -> Option<Outcome> {
    if let Some(done_words) = tag.strip_prefix(CLIPBOARD) {
        return Some(match effect_outcome(input) {
            Some(wire::shell_effect_result::Outcome::Done(_)) => Outcome::say(done_words),
            Some(wire::shell_effect_result::Outcome::Failed(failed)) if failed.cancelled => {
                Outcome::default()
            }
            _ => Outcome::refuse(&shared::copy_failed(EN)),
        });
    }
    if let Some(done_words) = tag.strip_prefix(SHARE) {
        return Some(match effect_outcome(input) {
            Some(wire::shell_effect_result::Outcome::Done(_)) => Outcome::say(done_words),
            Some(wire::shell_effect_result::Outcome::Failed(failed)) if failed.cancelled => {
                Outcome::default()
            }
            Some(wire::shell_effect_result::Outcome::Failed(_)) => {
                Outcome::refuse(&shared::share_failed(EN))
            }
            _ => Outcome::refuse(&shared::share_failed(EN)),
        });
    }
    if let Some(spec) = tag.strip_prefix(OWNER) {
        let Some(outcome) = effect_outcome(input) else {
            return Some(Outcome::refuse(&shared::export_unverified(EN)));
        };
        let wire::shell_effect_result::Outcome::Owner(owner) = outcome else {
            return Some(match outcome {
                wire::shell_effect_result::Outcome::Failed(failed) if failed.cancelled => {
                    Outcome::default()
                }
                _ => Outcome::refuse(&shared::export_unverified(EN)),
            });
        };
        if owner.cancelled {
            return Some(Outcome::default());
        }
        if !owner.passed && !owner.no_passcode {
            return Some(Outcome::refuse(&shared::export_unverified(EN)));
        }
        let Some((command, tail)) = spec.split_once(':') else {
            return Some(Outcome::refuse(&shared::export_unavailable(EN)));
        };
        let Some((arguments, _reason)) = tail.rsplit_once(':') else {
            return Some(Outcome::refuse(&shared::export_unavailable(EN)));
        };
        let Ok(arguments) = serde_json::from_str::<Value>(arguments) else {
            return Some(Outcome::refuse(&shared::export_unavailable(EN)));
        };
        let result = match e.door.command_result(command, &arguments) {
            Ok(value) => value,
            Err(_) => return Some(Outcome::refuse(&shared::export_unavailable(EN))),
        };
        let (Some(name), Some(media_type)) = (
            result.get("name").and_then(Value::as_str),
            result.get("media_type").and_then(Value::as_str),
        ) else {
            return Some(Outcome::refuse(&shared::export_missing_file(EN)));
        };
        let path = if result.get("path").is_some_and(Value::is_string) {
            match e.door.stage_archive() {
                Ok(path) => path,
                Err(_) => return Some(Outcome::refuse(&shared::export_prepare_failed(EN))),
            }
        } else if let Some(encoded) = result.get("content").and_then(Value::as_str) {
            let bytes =
                match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded) {
                    Ok(bytes) => bytes,
                    Err(_) => return Some(Outcome::refuse(&shared::export_unreadable(EN))),
                };
            match e.door.stage_export(&bytes) {
                Ok(path) => path,
                Err(_) => return Some(Outcome::refuse(&shared::export_prepare_failed(EN))),
            }
        } else {
            return Some(Outcome::refuse(&shared::export_missing_file(EN)));
        };
        let payload = serde_json::json!({
            "path": path,
            "name": name,
            "unprotected": owner.no_passcode,
            "cleanup": true,
        });
        return Some(Outcome::effect(
            &format!("{SAVE}{}", payload),
            wire::shell_effect::Kind::SaveFile(wire::ShellSaveFile {
                path,
                name: name.to_owned(),
                media_type: media_type.to_owned(),
            }),
        ));
    }
    if let Some(payload) = tag.strip_prefix(SAVE) {
        let Ok(payload) = serde_json::from_str::<Value>(payload) else {
            return Some(Outcome::refuse(&shared::export_save_failed(EN)));
        };
        let path = payload
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if payload.get("cleanup").and_then(Value::as_bool) != Some(false) {
            e.door.remove_export(path);
        }
        return match effect_outcome(input) {
            Some(wire::shell_effect_result::Outcome::Done(_)) => {
                let sentence = if let Some(done) = payload.get("done_words").and_then(Value::as_str)
                {
                    done.to_owned()
                } else if payload.get("unprotected").and_then(Value::as_bool) == Some(true) {
                    shared::export_done_unprotected(EN)
                } else {
                    shared::export_done(EN)
                };
                Some(Outcome::say(&sentence))
            }
            Some(wire::shell_effect_result::Outcome::Failed(failed)) if failed.cancelled => {
                Some(Outcome::default())
            }
            Some(wire::shell_effect_result::Outcome::Failed(_)) => {
                Some(Outcome::refuse(&shared::export_save_failed(EN)))
            }
            _ => Some(Outcome::refuse(&shared::export_save_failed(EN))),
        };
    }
    None
}

fn fetch_original(e: &mut Event<'_>, blob: &str) -> Outcome {
    let Some(content_hash) = decode_hash(blob) else {
        return Outcome::refuse(&shared::original_unavailable(EN));
    };
    let response = match e.door.call(&wire::Request {
        kind: Some(wire::request::Kind::FetchOriginal(
            wire::FetchOriginalRequest { content_hash },
        )),
    }) {
        Ok(response) => response,
        Err(_) => return Outcome::refuse(&shared::original_unavailable(EN)),
    };
    let Some(wire::response::Kind::FetchOriginal(fetched)) = response.kind else {
        return Outcome::refuse(&shared::original_unavailable(EN));
    };
    match wire::FetchOutcome::try_from(fetched.outcome) {
        Ok(wire::FetchOutcome::Landed) if !fetched.path.is_empty() => {
            Outcome::say(&shared::original_downloaded(EN))
        }
        Ok(wire::FetchOutcome::AlreadyHeld) => Outcome::say(&shared::original_already_here(EN)),
        Ok(wire::FetchOutcome::Unreachable) => Outcome::refuse(&shared::original_unreachable(EN)),
        Ok(wire::FetchOutcome::NotInBackup) => Outcome::refuse(&shared::original_not_in_backup(EN)),
        Ok(wire::FetchOutcome::Untrusted) => Outcome::refuse(&shared::original_untrusted(EN)),
        Ok(wire::FetchOutcome::Damaged) => Outcome::refuse(&shared::original_damaged(EN)),
        _ => Outcome::refuse(&shared::original_unavailable(EN)),
    }
}

fn decode_hash(hex: &str) -> Option<Vec<u8>> {
    if hex.len() != 64 {
        return None;
    }
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                _ => None,
            };
            Some(digit(pair[0])? * 16 + digit(pair[1])?)
        })
        .collect()
}

fn effect_outcome(input: &Input) -> Option<&wire::shell_effect_result::Outcome> {
    let Input::Effect(result) = input else {
        return None;
    };
    result.outcome.as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct TestDoor {
        removed: Mutex<Vec<String>>,
        staged: Mutex<Vec<u8>>,
        archive: bool,
        fetched_path: Mutex<Option<String>>,
    }

    impl Door for TestDoor {
        fn act(
            &self,
            _: &super::super::selector::Act,
        ) -> std::result::Result<super::super::door::Done, super::super::door::Refused> {
            unreachable!()
        }
        fn undo(
            &self,
        ) -> std::result::Result<super::super::door::Done, super::super::door::Refused> {
            unreachable!()
        }
        fn now_ms(&self) -> i64 {
            0
        }
        fn command_result(
            &self,
            _: &str,
            _: &Value,
        ) -> std::result::Result<Value, super::super::door::Refused> {
            Ok(if self.archive {
                serde_json::json!({
                    "name": "Photos.zip",
                    "media_type": "application/zip",
                    "path": "/private/staging/export.zip",
                    "count": 4,
                })
            } else {
                serde_json::json!({
                    "name": "Notes.zip",
                    "media_type": "application/zip",
                    "content": "aGVsbG8=",
                    "count": 4,
                })
            })
        }
        fn stage_export(
            &self,
            bytes: &[u8],
        ) -> std::result::Result<String, super::super::door::Refused> {
            *self.staged.lock().unwrap() = bytes.to_vec();
            Ok("/private/staging/room-export-test.tmp".to_owned())
        }
        fn remove_export(&self, path: &str) {
            self.removed.lock().unwrap().push(path.to_owned());
        }
        fn stage_archive(&self) -> std::result::Result<String, super::super::door::Refused> {
            Ok("/private/room-exports/room-export-1.tmp".to_owned())
        }
        fn call(
            &self,
            _: &wire::Request,
        ) -> std::result::Result<wire::Response, super::super::door::Refused> {
            Ok(wire::Response {
                kind: Some(wire::response::Kind::FetchOriginal(
                    wire::FetchOriginalResponse {
                        outcome: wire::FetchOutcome::Landed as i32,
                        path: self
                            .fetched_path
                            .lock()
                            .unwrap()
                            .clone()
                            .unwrap_or_default(),
                    },
                )),
            })
        }
    }

    #[test]
    fn export_checks_owner_saves_real_command_bytes_and_cleans_the_file() {
        let owner = ask("note.export", serde_json::json!({}), "Confirm export");
        let (owner_tag, owner_kind) = owner.effect.expect("owner check is asked");
        let Some(wire::shell_effect::Kind::OwnerCheck(check)) = Some(owner_kind) else {
            panic!("owner check expected");
        };
        assert_eq!(check.reason, "Confirm export");
        assert!(!check.cancel);

        let door = TestDoor::default();
        let mut ui = super::super::ui::Ui::default();
        let mut event = Event {
            ui: &mut ui,
            door: &door,
        };
        let owner_answer = Input::Effect(wire::ShellEffectResult {
            outcome: Some(wire::shell_effect_result::Outcome::Owner(
                wire::ShellOwner {
                    passed: true,
                    ..Default::default()
                },
            )),
            ..Default::default()
        });
        let save = handle(&mut event, &owner_tag, &owner_answer).expect("save effect follows");
        let (save_tag, save_kind) = save.effect.expect("save file effect is asked");
        let Some(wire::shell_effect::Kind::SaveFile(file)) = Some(save_kind) else {
            panic!("save file expected");
        };
        assert_eq!(file.name, "Notes.zip");
        assert_eq!(file.path, "/private/staging/room-export-test.tmp");
        assert_eq!(&*door.staged.lock().unwrap(), b"hello");

        let done = Input::Effect(wire::ShellEffectResult {
            outcome: Some(wire::shell_effect_result::Outcome::Done(wire::ShellDone {})),
            ..Default::default()
        });
        let status = handle(&mut event, &save_tag, &done).expect("save result is handled");
        assert_eq!(status.status.unwrap().sentence, "Export saved");
        assert_eq!(door.removed.lock().unwrap().as_slice(), [file.path]);
    }

    #[test]
    fn streamed_archive_is_adopted_to_a_private_path_before_save() {
        let door = TestDoor {
            archive: true,
            ..Default::default()
        };
        let owner = ask("photo.export_zip", serde_json::json!({}), "Confirm export");
        let (owner_tag, _) = owner.effect.expect("owner check is asked");
        let mut ui = super::super::ui::Ui::default();
        let mut event = Event {
            ui: &mut ui,
            door: &door,
        };
        let answer = Input::Effect(wire::ShellEffectResult {
            outcome: Some(wire::shell_effect_result::Outcome::Owner(
                wire::ShellOwner {
                    passed: true,
                    ..Default::default()
                },
            )),
            ..Default::default()
        });
        let save = handle(&mut event, &owner_tag, &answer).expect("save effect follows");
        let (_, kind) = save.effect.expect("save file effect is asked");
        let Some(wire::shell_effect::Kind::SaveFile(file)) = Some(kind) else {
            panic!("save file expected");
        };
        assert_eq!(file.name, "Photos.zip");
        assert_eq!(file.path, "/private/room-exports/room-export-1.tmp");
        assert_ne!(file.path, "/private/staging/export.zip");
    }

    #[test]
    fn download_original_fetches_by_hash_and_never_deletes_the_vault_blob() {
        let door = TestDoor {
            fetched_path: Mutex::new(Some("/private/vault/blobs/original".to_owned())),
            ..Default::default()
        };
        let mut ui = super::super::ui::Ui::default();
        let mut event = Event {
            ui: &mut ui,
            door: &door,
        };
        let result = download_original(
            &mut event,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        assert!(result.effect.is_none());
        assert_eq!(
            result.status.unwrap().sentence,
            "Original downloaded to this vault."
        );
        assert!(door.removed.lock().unwrap().is_empty());
    }

    #[test]
    fn share_uses_the_registered_kind_formatter_and_waits_for_shell_done() {
        let asked = share("A note", "note", Some("Body"), "Ready to share");
        let (tag, kind) = asked.effect.expect("share effect is asked");
        let Some(wire::shell_effect::Kind::Share(payload)) = Some(kind) else {
            panic!("share effect expected");
        };
        assert_eq!(payload.items[0].text, "A note\n\nBody");
        let door = TestDoor::default();
        let mut ui = super::super::ui::Ui::default();
        let mut event = Event {
            ui: &mut ui,
            door: &door,
        };
        let failed = Input::Effect(wire::ShellEffectResult {
            outcome: Some(wire::shell_effect_result::Outcome::Failed(
                wire::ShellFailed {
                    reason: "cancelled".to_owned(),
                    cancelled: true,
                    ..Default::default()
                },
            )),
            ..Default::default()
        });
        assert!(handle(&mut event, &tag, &failed).unwrap().status.is_none());
        let done = Input::Effect(wire::ShellEffectResult {
            outcome: Some(wire::shell_effect_result::Outcome::Done(wire::ShellDone {})),
            ..Default::default()
        });
        assert_eq!(
            handle(&mut event, &tag, &done)
                .unwrap()
                .status
                .unwrap()
                .sentence,
            "Ready to share"
        );
    }
}
