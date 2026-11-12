//! WHETHER THE ADAPTER IS USED (#1188 G2): one decision, in Rust, once.
//!
//! The on-device assistant is the stock base model plus, when the release ships one, a small
//! adapter ([`crate::record::Adapter`]) that is on for vault turns. The adapter is only ever an
//! improvement on the base, never a requirement: this module answers "may this turn use it?" and
//! every answer but [`Verdict::Use`] means the stock model answers exactly as it did before, under
//! the same grammar. A missing or stale adapter is not an error a member acts on, so nothing here
//! returns one; a shell never decides, it asks.
//!
//! An adapter is used only while all of these hold:
//!
//! 1. the release names one;
//! 2. its file is on the phone and is the file the record names (the shell keeps a download only
//!    when its SHA-256 matched, and the local name carries the digest, so a file of that name and
//!    size is that file);
//! 3. it was trained against the base file in use (`base_sha256`);
//! 4. it was trained on the tool catalogue and prompt this build serves.
//!
//! [`decide`] is the pure rule, over facts, and the fixture `contracts/assist/adapter-cases.json`
//! holds it. [`resolve`] gathers the facts from the record and the models directory.

use std::path::Path;

use crate::model::AdapterUse;
use crate::native::prompt::ToolsMode;
use crate::record::{Adapter, Record, runtime_hashes};

/// What the models directory holds for the adapter's local name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disk {
    /// No file of that name (or an empty one).
    Missing,
    /// A file of that name and this many bytes.
    Bytes(u64),
}

/// What the app serves: the hashes of its tool catalogue and static system turn, and the base file
/// in use (an installed model's SHA-256 as the record pins it).
#[derive(Debug, Clone, Copy)]
pub struct App<'a> {
    pub base_sha256: &'a str,
    pub tools_hash: &'a str,
    pub prompt_hash: &'a str,
}

/// The decision, and when it is not [`Verdict::Use`], why. A reason is for tests and for deciding
/// what to clean up; it is never words a member reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Use,
    /// The release names no adapter.
    None,
    /// The adapter's file is not on the phone, or is not the file the record names (wrong size).
    NotOnDisk,
    /// It was trained against a different base than the one in use.
    OtherBase,
    /// It was trained on a different tool catalogue or prompt than this build serves.
    OtherCatalogue,
}

impl Verdict {
    #[must_use]
    pub fn used(self) -> bool {
        self == Self::Use
    }

    /// The file on the phone (if any) can never be used again by this release's base: it goes.
    #[must_use]
    pub fn file_is_dead(self) -> bool {
        matches!(self, Self::OtherBase)
    }

    /// The name the fixtures spell it by.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Use => "use",
            Self::None => "none",
            Self::NotOnDisk => "not-on-disk",
            Self::OtherBase => "other-base",
            Self::OtherCatalogue => "other-catalogue",
        }
    }
}

/// The rule. The first reason that applies wins; the order is the order of the list above.
#[must_use]
pub fn decide(adapter: Option<&Adapter>, disk: Disk, app: &App<'_>) -> Verdict {
    let Some(adapter) = adapter else {
        return Verdict::None;
    };
    if adapter.base_sha256 != app.base_sha256 {
        return Verdict::OtherBase;
    }
    if adapter.tools_hash != app.tools_hash || adapter.prompt_hash != app.prompt_hash {
        return Verdict::OtherCatalogue;
    }
    match disk {
        Disk::Bytes(bytes) if bytes == adapter.bytes => Verdict::Use,
        _ => Verdict::NotOnDisk,
    }
}

/// What `models_dir` holds for `adapter`.
#[must_use]
pub fn disk(models_dir: &Path, adapter: &Adapter) -> Disk {
    std::fs::metadata(models_dir.join(adapter.local_name()))
        .ok()
        .filter(std::fs::Metadata::is_file)
        .map_or(Disk::Missing, |meta| match meta.len() {
            0 => Disk::Missing,
            bytes => Disk::Bytes(bytes),
        })
}

/// The decision for the base file named `base_file` in `models_dir` under `record`, with the facts
/// gathered here. A base the record does not pin (an older file) is a base no adapter fits.
#[must_use]
pub fn resolve(record: &Record, models_dir: &Path, base_file: &str) -> Verdict {
    let Some(adapter) = &record.adapter else {
        return Verdict::None;
    };
    let base = std::iter::once(&record.current)
        .chain(record.previous.as_ref())
        .find(|entry| entry.file_name == base_file);
    let Some(base) = base else {
        return Verdict::OtherBase;
    };
    // The app serves the catalogue of the model it ships.
    let Some(mode) = ToolsMode::parse(&record.current.tools_mode) else {
        return Verdict::OtherCatalogue;
    };
    let (tools_hash, prompt_hash) = runtime_hashes(mode);
    decide(
        Some(adapter),
        disk(models_dir, adapter),
        &App {
            base_sha256: &base.sha256,
            tools_hash: &tools_hash,
            prompt_hash: &prompt_hash,
        },
    )
}

/// THE SWITCH, per turn: a vault turn (the native plane's) runs with the adapter on when
/// [`resolve`] says it is used for the model loaded from `loaded`; anything else (an attached or
/// free reply, no loaded path, no adapter) is off. The only place the choice is made.
#[must_use]
pub fn for_vault_turn(record: &Record, loaded: Option<&Path>) -> AdapterUse {
    let Some(loaded) = loaded else {
        return AdapterUse::Off;
    };
    let (Some(dir), Some(file)) = (loaded.parent(), loaded.file_name().and_then(|f| f.to_str()))
    else {
        return AdapterUse::Off;
    };
    if resolve(record, dir, file).used() {
        AdapterUse::On
    } else {
        AdapterUse::Off
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CASES: &str = include_str!("../../../contracts/assist/adapter-cases.json");

    fn adapter(v: &Value) -> Option<Adapter> {
        let a = v.get("adapter").filter(|a| !a.is_null())?;
        let s = |k: &str| a[k].as_str().unwrap().to_owned();
        Some(Adapter {
            url: String::new(),
            file_name: s("file_name"),
            sha256: s("sha256"),
            bytes: a["bytes"].as_u64().unwrap(),
            base_sha256: s("base_sha256"),
            tools_hash: s("tools_hash"),
            prompt_hash: s("prompt_hash"),
            score: None,
        })
    }

    #[test]
    fn the_fixture_cases_decide_as_written() {
        let all: Value = serde_json::from_str(CASES).unwrap();
        let cases = all["cases"].as_array().unwrap();
        assert!(cases.len() >= 8);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let adapter = adapter(case);
            let disk = match case["disk_bytes"].as_u64() {
                Some(bytes) => Disk::Bytes(bytes),
                None => Disk::Missing,
            };
            let app = &case["app"];
            let verdict = decide(
                adapter.as_ref(),
                disk,
                &App {
                    base_sha256: app["base_sha256"].as_str().unwrap(),
                    tools_hash: app["tools_hash"].as_str().unwrap(),
                    prompt_hash: app["prompt_hash"].as_str().unwrap(),
                },
            );
            assert_eq!(verdict.name(), case["verdict"], "{name}");
            assert_eq!(verdict.used(), case["used"], "{name}");
            assert_eq!(verdict.file_is_dead(), case["delete_file"], "{name}");
        }
    }

    #[test]
    fn a_vault_turn_switches_on_only_when_the_adapter_is_used() {
        let dir = std::env::temp_dir().join(format!("centraid-switch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut record = crate::record::record();
        let base = dir.join(&record.current.file_name);
        assert_eq!(for_vault_turn(&record, Some(&base)), AdapterUse::Off);
        let (tools, prompt) = runtime_hashes(ToolsMode::parse(&record.current.tools_mode).unwrap());
        let adapter = Adapter {
            url: String::new(),
            file_name: "a.gguf".into(),
            sha256: "cd".repeat(32),
            bytes: 3,
            base_sha256: record.current.sha256.clone(),
            tools_hash: tools,
            prompt_hash: prompt,
            score: None,
        };
        std::fs::write(dir.join(adapter.local_name()), b"abc").unwrap();
        record.adapter = Some(adapter);
        assert_eq!(for_vault_turn(&record, Some(&base)), AdapterUse::On);
        assert_eq!(for_vault_turn(&record, None), AdapterUse::Off);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_release_without_an_adapter_is_the_stock_model() {
        let mut record = crate::record::record();
        record.adapter = None;
        let dir = std::env::temp_dir();
        assert_eq!(
            resolve(&record, &dir, &record.current.file_name),
            Verdict::None
        );
    }

    #[test]
    fn the_file_must_be_there_and_the_size_the_record_names() {
        let dir = std::env::temp_dir().join(format!("centraid-adapter-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut record = crate::record::record();
        let (tools, prompt) = runtime_hashes(ToolsMode::parse(&record.current.tools_mode).unwrap());
        let adapter = Adapter {
            url: String::new(),
            file_name: "a.gguf".into(),
            sha256: "ab".repeat(32),
            bytes: 5,
            base_sha256: record.current.sha256.clone(),
            tools_hash: tools,
            prompt_hash: prompt,
            score: None,
        };
        record.adapter = Some(adapter.clone());
        let base = record.current.file_name.clone();
        assert_eq!(resolve(&record, &dir, &base), Verdict::NotOnDisk);
        std::fs::write(dir.join(adapter.local_name()), b"1234").unwrap();
        assert_eq!(resolve(&record, &dir, &base), Verdict::NotOnDisk);
        std::fs::write(dir.join(adapter.local_name()), b"12345").unwrap();
        assert_eq!(resolve(&record, &dir, &base), Verdict::Use);
        // a base the record does not pin has no adapter
        assert_eq!(resolve(&record, &dir, "Old.gguf"), Verdict::OtherBase);
        std::fs::remove_dir_all(&dir).ok();
    }
}
