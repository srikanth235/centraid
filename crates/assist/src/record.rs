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

/// The release's pin: the model it ships and the one before.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Record {
    pub current: Entry,
    pub previous: Option<Entry>,
}

/// The record this build was made with.
///
/// # Panics
/// Never in a build the gate passed: `model_record` parses it.
#[must_use]
pub fn record() -> Record {
    parse(RECORD).expect("model.json is valid; the gate's model-record step reads it")
}

/// Read a record.
///
/// # Errors
/// The parser's words.
pub fn parse(text: &str) -> Result<Record, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

/// The hashes the runtime computes for a catalogue mode: the tool catalogue and the static system
/// turn (the identity's markers, the tools block, the kind card in `USD`). The vault's own lines
/// (today, the name, the directory) are data, not template, and are left out.
#[must_use]
pub fn runtime_hashes(mode: ToolsMode) -> (String, String) {
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
    (
        blake3::hash(catalogue.as_bytes()).to_hex().to_string(),
        blake3::hash(prompt.as_bytes()).to_hex().to_string(),
    )
}

/// Everything wrong with `entry`, one sentence each: empty when it is fit to ship.
#[must_use]
pub fn problems(entry: &Entry) -> Vec<String> {
    let mut out = Vec::new();
    let commit_pinned = entry
        .url
        .strip_prefix("https://huggingface.co/")
        .and_then(|rest| rest.split("/resolve/").nth(1))
        .and_then(|rest| rest.split('/').next())
        .is_some_and(|commit| commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()));
    if !commit_pinned {
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
