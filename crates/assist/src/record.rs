//! THE MODEL RECORD (#1188 C1): which model file this release ships and which runtime it was made for.
//!
//! The release pins its model in `model.json`, one entry for the model it ships (`current`) and,
//! while a release still supports it, the one before (`previous`, the two-model window). An entry
//! names the file (a Hugging Face URL by commit, the file's SHA-256 and size), the tool catalogue
//! and prompt it was trained on, and the score it earned. The catalogue and the prompt are named by
//! hash so a build whose runtime drifted from the model's training refuses to ship: the gate's
//! `model-record` step (`tests/model_record.rs`) recomputes both from the runtime and fails when an
//! entry disagrees. The file is written by `cargo xtask model-pin`, never by hand.
//!
//! BESIDE `current` the record may carry one [`Adapter`]: a small LoRA file made for the vault
//! turns, trained against one exact base file and one exact tool catalogue and prompt. It is
//! updated far more often than the base, so it is its own entry with its own hashes; absent means
//! the stock model runs alone, exactly as before. [`crate::adapter`] decides, per turn, whether the
//! file on the phone is the one to use.
//!
//! Nothing here fetches anything. The phone fetches a pinned file only when the member asks, only from
//! Hugging Face, only by the commit in `url`.

use serde::{Deserialize, Serialize};

use crate::native::identity;
use crate::native::prompt::{ToolsMode, kind_card_for, py_json, tools_block, tools_for};

/// The record as committed.
const RECORD: &str = include_str!("../model.json");

/// One model file, and what it was made against.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Entry {
    /// `https://huggingface.co/<repo>/resolve/<40-hex commit>/<file>`. Never a branch or a tag.
    pub url: String,
    /// What the file is called on the phone.
    pub file_name: String,
    /// The file's SHA-256, lowercase hex (Hugging Face's own hash of an LFS file).
    pub sha256: String,
    /// The file's size in bytes, quoted before a byte has moved.
    pub bytes: u64,
    /// The tool catalogue the model learned (`ToolsMode::name`), which the runtime then serves it.
    pub tools_mode: String,
    /// BLAKE3 of the tool catalogue in that mode, lowercase hex.
    pub tools_hash: String,
    /// BLAKE3 of the static system turn in that mode, lowercase hex.
    pub prompt_hash: String,
    /// The model's special tokens (the GGUF vocabulary's control and user-defined tokens), sorted,
    /// written by `cargo xtask model-pin` from the file itself. [`crate::escape`] breaks every one
    /// in text the model reads as data, and the gate replays each through it.
    pub special_tokens: Vec<String>,
    /// Where `special_tokens` came from: `"file"` (read from the GGUF by `model-pin`) or
    /// `"declared"` (written by hand). The release gate refuses a shipping entry that is declared.
    pub special_tokens_source: String,
    /// The score the model earned on the frozen sets, 0 to 1, or `None` for a file that was never scored
    /// (a stock base model).
    pub score: Option<f64>,
}

/// The adapter a release ships beside its base model: a LoRA file that is on for vault turns.
///
/// It is trained against ONE base file (`base_sha256`) and ONE catalogue and prompt (`tools_hash`,
/// `prompt_hash`: the same hashes an [`Entry`] carries, computed by the same runtime). It is used
/// only while all three still match what the phone holds and what the app serves
/// ([`crate::adapter::decide`]); otherwise the base runs alone.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Adapter {
    /// `https://huggingface.co/<repo>/resolve/<40-hex commit>/<file>`. Never a branch or a tag.
    pub url: String,
    /// The file's name in that repository.
    pub file_name: String,
    /// The file's SHA-256, lowercase hex. The shell keeps a download only when it matches.
    pub sha256: String,
    /// The file's size in bytes, quoted before a byte has moved.
    pub bytes: u64,
    /// The SHA-256 of the base model file it was trained against (an [`Entry::sha256`]).
    pub base_sha256: String,
    /// BLAKE3 of the tool catalogue it was trained on: the [`Entry::tools_hash`] of its base.
    pub tools_hash: String,
    /// BLAKE3 of the static system turn it was trained on: the [`Entry::prompt_hash`] of its base.
    pub prompt_hash: String,
    /// The score it earned on the frozen sets, 0 to 1.
    pub score: Option<f64>,
}

impl Adapter {
    /// What the file is called on the phone: the name carries the start of its SHA-256, so a file
    /// by that name of the right size is this exact adapter (the shell keeps only a download whose
    /// digest matched), and an updated adapter is a different file beside the old one.
    #[must_use]
    pub fn local_name(&self) -> String {
        format!(
            "{LOCAL_PREFIX}{}.gguf",
            self.sha256.get(..12).unwrap_or(&self.sha256)
        )
    }
}

/// What every adapter file on the phone is called before its digest.
pub const LOCAL_PREFIX: &str = "centraid-adapter-";

/// The release's pin: the model it ships and the one before, and the adapter made for the former.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Record {
    pub current: Entry,
    pub previous: Option<Entry>,
    /// Absent (and absent from the file) when the release ships the stock model alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<Adapter>,
}

/// The record this build was made with.
///
/// # Panics
/// Never in a build the gate passed: `model_record` parses it.
#[must_use]
pub fn record() -> Record {
    if let Some(held) = HELD.with(|held| held.borrow().clone()) {
        return held;
    }
    if let Some(held) = HELD_EVERYWHERE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
    {
        return held;
    }
    let mut record =
        parse(RECORD).expect("model.json is valid; the gate's model-record step reads it");
    if let Some(entry) = dev_model() {
        record.current = entry;
        record.previous = None;
        record.adapter = None;
    }
    record
}

/// A DEBUG LOADER (#1188): a model to try before it is pinned, named by Hugging Face repository
/// and commit, with the file's name, SHA-256 and size (the shell still verifies what it fetches).
/// A debug build started with `CENTRAID_DEV_MODEL=<repo>@<commit>/<file>` and
/// `CENTRAID_DEV_MODEL_SHA256` and `CENTRAID_DEV_MODEL_BYTES` fetches that file in place of the
/// pinned one; the hashes of the tool catalogue and prompt are those of the pinned entry.
///
/// **IT CANNOT SHIP.** Like the dev chat script, the reading exists only under `debug_assertions`;
/// a release build compiles the second definition, which looks at nothing
/// (`a_release_build_has_no_debug_model_loader`).
#[cfg(debug_assertions)]
fn dev_model() -> Option<Entry> {
    let named = std::env::var("CENTRAID_DEV_MODEL").ok()?;
    let sha256 = std::env::var("CENTRAID_DEV_MODEL_SHA256").ok()?;
    let bytes = std::env::var("CENTRAID_DEV_MODEL_BYTES")
        .ok()?
        .parse()
        .ok()?;
    dev_entry(&named, &sha256, bytes)
}

#[cfg(not(debug_assertions))]
fn dev_model() -> Option<Entry> {
    None
}

/// The entry a `<repo>@<commit>/<file>` names, on the pinned entry's tools and prompt.
#[cfg(debug_assertions)]
fn dev_entry(named: &str, sha256: &str, bytes: u64) -> Option<Entry> {
    let (repo, rest) = named.split_once('@')?;
    let (commit, file) = rest.split_once('/')?;
    if repo.is_empty() || file.is_empty() || commit.len() != 40 {
        return None;
    }
    let pinned = parse(RECORD).ok()?.current;
    Some(Entry {
        url: format!("https://huggingface.co/{repo}/resolve/{commit}/{file}"),
        file_name: file.to_owned(),
        sha256: sha256.to_owned(),
        bytes,
        score: None,
        ..pinned
    })
}

thread_local! {
    static HELD: std::cell::RefCell<Option<Record>> = const { std::cell::RefCell::new(None) };
}

static HELD_EVERYWHERE: std::sync::Mutex<Option<Record>> = std::sync::Mutex::new(None);

/// Run `f` with `record` standing in for the committed one on EVERY thread: for a test binary whose
/// one test drives work that a core runs on its own pool threads (a model load), which
/// [`held_for`] cannot reach. Nothing ships it a record; use it only in a test binary that runs no
/// other test at the same time.
pub fn held_for_all_threads<T>(record: Record, f: impl FnOnce() -> T) -> T {
    let lock = |held: Option<Record>| {
        std::mem::replace(
            &mut *HELD_EVERYWHERE
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            held,
        )
    };
    let before = lock(Some(record));
    let out = f();
    lock(before);
    out
}

/// Run `f` with `record` standing in for the committed one on THIS thread: how a test drives the
/// two-model window from a fixture record with a `previous` entry. Nothing ships it a record; it
/// reads no file and changes nothing for another thread.
pub fn held_for<T>(record: Record, f: impl FnOnce() -> T) -> T {
    let before = HELD.with(|held| held.replace(Some(record)));
    let out = f();
    HELD.with(|held| *held.borrow_mut() = before);
    out
}

/// Read a record.
///
/// # Errors
/// The parser's words.
pub fn parse(text: &str) -> Result<Record, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

/// The texts the runtime hashes for a catalogue mode: the tool catalogue (as Python's `json.dumps` writes it) and the
/// static prompt, which is the identity, the static system turn (the identity's markers, the tools block, the kind card
/// in `USD`) and the escape rules. The vault's own lines (today, the name, the directory) are data, not template, and
/// are left out.
#[must_use]
pub fn runtime_texts(mode: ToolsMode) -> (String, String) {
    let tools = tools_for(mode);
    let catalogue = py_json(&serde_json::Value::Array(tools.clone()));
    let system = format!(
        "{}system\n{}\n\n{}{}\n",
        identity::MODEL.im_start,
        tools_block(&tools),
        kind_card_for(mode, "USD").join("\n"),
        identity::MODEL.im_end,
    );
    let prompt = format!(
        "{}\n{system}\n{}\n{}",
        identity::json(),
        crate::escape::RULE,
        crate::escape::builtin().join("\n")
    );
    (catalogue, prompt)
}

/// The hashes the runtime computes for a catalogue mode: the BLAKE3 of the two texts of [`runtime_texts`].
#[must_use]
pub fn runtime_hashes(mode: ToolsMode) -> (String, String) {
    let (catalogue, prompt) = runtime_texts(mode);
    (
        blake3::hash(catalogue.as_bytes()).to_hex().to_string(),
        blake3::hash(prompt.as_bytes()).to_hex().to_string(),
    )
}

/// Everything wrong with the adapter `record` ships, one sentence each: empty when there is none or
/// it is fit to ship. It must be pinned to a commit, be trained against the base this release
/// ships and on the catalogue and prompt this runtime serves.
#[must_use]
pub fn adapter_problems(record: &Record) -> Vec<String> {
    let Some(adapter) = &record.adapter else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let hex = |text: &str, len: usize| {
        text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    };
    if !commit_pinned(&adapter.url) {
        out.push(format!(
            "adapter {} is not a Hugging Face URL pinned to a commit",
            adapter.url
        ));
    }
    if !adapter.url.ends_with(&adapter.file_name) {
        out.push(format!(
            "adapter {} does not end in {}",
            adapter.url, adapter.file_name
        ));
    }
    if !hex(&adapter.sha256, 64) {
        out.push("adapter sha256 is not 64 lowercase hex digits".to_owned());
    }
    if !hex(&adapter.base_sha256, 64) {
        out.push("adapter base_sha256 is not 64 lowercase hex digits".to_owned());
    }
    if adapter.bytes == 0 {
        out.push("adapter bytes is zero".to_owned());
    }
    if adapter.base_sha256 != record.current.sha256 {
        out.push(format!(
            "adapter was trained on base {}, not the base this release ships ({})",
            adapter.base_sha256, record.current.sha256
        ));
    }
    if adapter.sha256 == record.current.sha256 {
        out.push("adapter is the base file".to_owned());
    }
    if let Some(mode) = ToolsMode::parse(&record.current.tools_mode) {
        let (tools, prompt) = runtime_hashes(mode);
        if adapter.tools_hash != tools {
            out.push(format!(
                "adapter tools_hash {} is not the runtime's catalogue ({tools})",
                adapter.tools_hash
            ));
        }
        if adapter.prompt_hash != prompt {
            out.push(format!(
                "adapter prompt_hash {} is not the runtime's prompt ({prompt})",
                adapter.prompt_hash
            ));
        }
    }
    if adapter
        .score
        .is_some_and(|score| !(0.0..=1.0).contains(&score))
    {
        out.push("adapter score is outside 0 to 1".to_owned());
    }
    out
}

fn commit_pinned(url: &str) -> bool {
    url.strip_prefix("https://huggingface.co/")
        .and_then(|rest| rest.split("/resolve/").nth(1))
        .and_then(|rest| rest.split('/').next())
        .is_some_and(|commit| commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Everything wrong with `entry`, one sentence each: empty when it is fit to ship.
#[must_use]
pub fn problems(entry: &Entry) -> Vec<String> {
    let mut out = Vec::new();
    if !commit_pinned(&entry.url) {
        out.push(format!(
            "{} is not a Hugging Face URL pinned to a commit",
            entry.url
        ));
    }
    if !entry.url.ends_with(&entry.file_name) {
        out.push(format!("{} does not end in {}", entry.url, entry.file_name));
    }
    let hex = |text: &str, len: usize| {
        text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    };
    if !hex(&entry.sha256, 64) {
        out.push("sha256 is not 64 lowercase hex digits".to_owned());
    }
    if entry.bytes == 0 {
        out.push("bytes is zero".to_owned());
    }
    match ToolsMode::parse(&entry.tools_mode) {
        None => out.push(format!(
            "tools_mode {:?} is not a catalogue mode",
            entry.tools_mode
        )),
        Some(mode) => {
            let (tools, prompt) = runtime_hashes(mode);
            if entry.tools_hash != tools {
                out.push(format!(
                    "tools_hash {} is not the runtime's catalogue ({tools}) in mode {}",
                    entry.tools_hash, entry.tools_mode
                ));
            }
            if entry.prompt_hash != prompt {
                out.push(format!(
                    "prompt_hash {} is not the runtime's prompt ({prompt}) in mode {}",
                    entry.prompt_hash, entry.tools_mode
                ));
            }
        }
    }
    if !matches!(entry.special_tokens_source.as_str(), "file" | "declared") {
        out.push("special_tokens_source is neither \"file\" nor \"declared\"".to_owned());
    }
    let mut sorted = entry.special_tokens.clone();
    sorted.sort();
    sorted.dedup();
    if sorted != entry.special_tokens {
        out.push("special_tokens is not sorted and free of repeats".to_owned());
    }
    for needed in [identity::MODEL.im_start, identity::MODEL.im_end] {
        if !entry.special_tokens.iter().any(|token| token == needed) {
            out.push(format!(
                "special_tokens lacks {needed}, which the template writes"
            ));
        }
    }
    if entry
        .score
        .is_some_and(|score| !(0.0..=1.0).contains(&score))
    {
        out.push("score is outside 0 to 1".to_owned());
    }
    out
}

#[cfg(test)]
mod dev_model_tests {
    /// In a release build the loader is not compiled in: the function that would read the
    /// variables is the one that returns `None`.
    #[cfg(not(debug_assertions))]
    #[test]
    fn a_release_build_has_no_debug_model_loader() {
        assert!(super::dev_model().is_none());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_debug_loader_names_a_file_by_repo_and_commit_and_nothing_else() {
        let commit = "d".repeat(40);
        let entry = super::dev_entry(
            &format!("acme/models@{commit}/Try-Q4_0.gguf"),
            &"e".repeat(64),
            7,
        )
        .expect("an entry");
        assert_eq!(
            entry.url,
            format!("https://huggingface.co/acme/models/resolve/{commit}/Try-Q4_0.gguf")
        );
        assert_eq!(entry.file_name, "Try-Q4_0.gguf");
        assert_eq!(entry.bytes, 7);
        assert!(
            super::problems(&entry)
                .iter()
                .all(|p| !p.contains("pinned to a commit"))
        );
        // a branch is not a commit
        assert!(super::dev_entry("acme/models@main/Try.gguf", "e", 1).is_none());
        assert!(super::dev_entry("no-commit", "e", 1).is_none());
    }
}
