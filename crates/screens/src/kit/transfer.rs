//! THE KIT'S TRANSFER SCREEN, the parts every app's import and export share (#1173): the
//! wire view, the picked files made into `{path, text}`, and the saved file's answer.
//!
//! An app's `<app>.import` / `<app>.export` is its own machine over its own commands (Notes
//! reads Markdown, People reads vCards); what is common is how a page is drawn and how a picked
//! file or folder arrives.

use centraid_api_proto::core_v1 as wire;

/// One tappable or plain row.
#[must_use]
pub fn row(
    key: &str,
    label: &str,
    value: &str,
    tappable: bool,
    icon_key: &str,
) -> wire::TransferRow {
    wire::TransferRow {
        key: key.to_owned(),
        label: label.to_owned(),
        value: value.to_owned(),
        tappable,
        icon_key: icon_key.to_owned(),
        accessibility_label: if value.is_empty() {
            label.to_owned()
        } else {
            format!("{label}, {value}")
        },
    }
}

/// One button.
#[must_use]
pub fn action(key: &str, label: &str, primary: bool, enabled: bool) -> wire::TransferAction {
    wire::TransferAction {
        key: key.to_owned(),
        label: label.to_owned(),
        primary,
        enabled,
    }
}

/// A file as the shells hand it back, read as text: the path below the picked folder (or the
/// file's name) and its words. A file that is not UTF-8 is read lossily: a Markdown or vCard
/// file with a stray byte is still the member's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextFile {
    pub path: String,
    pub text: String,
}

/// The files of a pick, whether it was one file or several (`BytesPicked.files`).
#[must_use]
pub fn picked_files(picked: &wire::BytesPicked) -> Vec<TextFile> {
    let lossy = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
    if picked.files.is_empty() {
        if picked.cancelled || picked.name.is_empty() {
            return Vec::new();
        }
        return vec![TextFile {
            path: picked.name.clone(),
            text: lossy(&picked.content),
        }];
    }
    picked
        .files
        .iter()
        .map(|file| TextFile {
            path: file.name.clone(),
            text: lossy(&file.content),
        })
        .collect()
}

/// What an import records as where its items came from: the file's name for one file, the picked
/// folder's name for a folder, else the first file's name. A name, never content. `None` for a pick
/// that named nothing.
#[must_use]
pub fn arrival_name(files: &[TextFile]) -> Option<String> {
    let first = files.first()?;
    let folder = first
        .path
        .split_once('/')
        .map(|(folder, _)| folder)
        .filter(|_| files.len() > 1);
    let name = match folder {
        Some(folder)
            if files
                .iter()
                .all(|file| file.path.starts_with(&format!("{folder}/"))) =>
        {
            folder
        }
        _ => first.path.rsplit('/').next().unwrap_or(&first.path),
    };
    Some(name.trim().to_owned()).filter(|name| !name.is_empty())
}

/// The files as the JSON text an import action carries.
#[must_use]
pub fn files_json(files: &[TextFile]) -> String {
    serde_json::Value::Array(
        files
            .iter()
            .map(|file| serde_json::json!({ "path": file.path, "text": file.text }))
            .collect(),
    )
    .to_string()
}

/// A count out of an action's JSON output.
#[must_use]
pub fn count(output: &[u8], field: &str) -> u32 {
    serde_json::from_slice::<serde_json::Value>(output)
        .ok()
        .and_then(|value| value.get(field)?.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod arrival_tests {
    use super::*;

    fn file(path: &str) -> TextFile {
        TextFile {
            path: path.to_owned(),
            text: "secret words".to_owned(),
        }
    }

    #[test]
    fn an_arrival_is_named_by_its_file_or_its_folder_never_its_content() {
        assert_eq!(
            arrival_name(&[file("contacts.vcf")]).as_deref(),
            Some("contacts.vcf")
        );
        assert_eq!(
            arrival_name(&[file("Vault/a.md"), file("Vault/sub/b.md")]).as_deref(),
            Some("Vault")
        );
        assert_eq!(
            arrival_name(&[file("a.md"), file("b.md")]).as_deref(),
            Some("a.md")
        );
        assert_eq!(arrival_name(&[]), None);
    }
}
