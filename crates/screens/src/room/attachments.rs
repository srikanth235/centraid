//! Attach a shell-picked, core-staged file to the item whose detail page opened the picker.

use centraid_api_proto::core_v1 as wire;
use serde_json::json;

use super::screen::{Event, Input, Outcome};
use super::selector::Act;
use crate::strings::{Locale, shared};

const EN: Locale = Locale::En;
const PREFIX: &str = "attachment:pick:";

pub fn ask(kind: &str, home: &str) -> Outcome {
    let suffix = format!("{kind}:{home}");
    match kind {
        "scan" => Outcome::effect(
            &format!("{PREFIX}{suffix}"),
            wire::shell_effect::Kind::ScanDocument(wire::ShellScanDocument {}),
        ),
        "photo" | "edited" => Outcome::effect(
            &format!("{PREFIX}{suffix}"),
            wire::shell_effect::Kind::PickPhoto(wire::ShellPickPhoto {
                multiple: false,
                video: false,
            }),
        ),
        _ => Outcome::effect(
            &format!("{PREFIX}{kind}:{home}"),
            wire::shell_effect::Kind::PickFile(wire::ShellPickFile {
                types: Vec::new(),
                multiple: false,
            }),
        ),
    }
}

pub fn handle(e: &mut Event<'_>, tag: &str, input: &Input) -> Option<Outcome> {
    let suffix = tag.strip_prefix(PREFIX)?;
    let Some((kind, home)) = suffix.split_once(':') else {
        return Some(Outcome::refuse(&shared::attachment_unavailable(EN)));
    };
    let Input::Effect(result) = input else {
        return Some(Outcome::default());
    };
    let Some(outcome) = result.outcome.as_ref() else {
        return Some(Outcome::refuse(&shared::attachment_unavailable(EN)));
    };
    match outcome {
        wire::shell_effect_result::Outcome::Failed(failed) if failed.cancelled => {
            Some(Outcome::default())
        }
        wire::shell_effect_result::Outcome::Picked(picked) => {
            let Some(item) = picked.items.first() else {
                return Some(Outcome::default());
            };
            let Some(staged) = item.stage_handle.as_ref() else {
                return Some(Outcome::refuse(&shared::attachment_unavailable(EN)));
            };
            let blob = staged.content_hash.as_str();
            let media_type = item.media_type.trim();
            if !valid_hash(blob) || media_type.is_empty() || media_type.len() > 128 {
                return Some(Outcome::refuse(&shared::attachment_unavailable(EN)));
            }
            let size = i64::try_from(staged.byte_size).ok();
            let Some(size) = size else {
                return Some(Outcome::refuse(&shared::attachment_unavailable(EN)));
            };
            let title = display_name(&item.name);
            if kind.starts_with("note-") {
                let act = Act::new(
                    "note.asset_add",
                    json!({
                        "id": home,
                        "blob": blob,
                        "name": title,
                        "media_type": media_type,
                    }),
                );
                return Some(match e.door.act(&act) {
                    Ok(done) => Outcome::done(&done.sentence, done.undo),
                    Err(_) => Outcome::refuse(&shared::attachment_unavailable(EN)),
                });
            }
            let is_image = media_type.starts_with("image/");
            if kind == "edited" && !is_image {
                return Some(Outcome::refuse(&shared::attachment_unavailable(EN)));
            }
            let (command, arrived_via) = match (kind, is_image) {
                ("photo" | "edited", true) => ("photo.add", "picker"),
                ("scan", true) => ("photo.add", "scan"),
                ("scan", false) => ("document.add", "scan"),
                _ => ("document.add", "picker"),
            };
            let mut input = json!({
                "arrived_label": title,
                "arrived_via": arrived_via,
                "blob": blob,
                "media_type": media_type,
                "size": size,
            });
            if !home.is_empty() && kind == "edited" {
                input["edited_from"] = json!(home);
            } else if !home.is_empty() {
                input["home"] = json!(home);
                input["title"] = json!(title);
            } else {
                input["title"] = json!(title);
            }
            if command == "photo.add" && kind == "scan" {
                input["form"] = json!("scan");
            }
            let act = Act::new(command, input);
            Some(match e.door.act(&act) {
                Ok(done) => Outcome::done(&done.sentence, done.undo),
                Err(_) => Outcome::refuse(&shared::attachment_unavailable(EN)),
            })
        }
        _ => Some(Outcome::refuse(&shared::attachment_unavailable(EN))),
    }
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn display_name(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if leaf.is_empty() || leaf.chars().any(char::is_control) {
        "Attachment".to_owned()
    } else {
        leaf.chars().take(200).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{display_name, valid_hash};

    #[test]
    fn staged_content_hash_and_filename_are_checked_before_command() {
        assert!(valid_hash(&"a".repeat(64)));
        assert!(!valid_hash("../secret"));
        assert!(!valid_hash(&"g".repeat(64)));
        assert_eq!(display_name("/tmp/scan.pdf"), "scan.pdf");
        assert_eq!(display_name("C:\\tmp\\scan.pdf"), "scan.pdf");
        assert_eq!(display_name("../"), "Attachment");
    }
}
