//! A DATA VERSION: render (stage 6) and mix (stage 7) over a messages run, and the files they write.
//!
//! ```text
//! <out>/manifest.json                     the data version: hashes, seeds, shares, files
//! <out>/data/{train,val,test,noise}.jsonl.zst   one zstd frame each, one record a line
//! <out>/worlds/<id>.json                  the worlds the sessions name (presence-only)
//! <out>/build/render.txt                  what rendering and mixing did and could not do
//! <out>/build/render-dropped.jsonl        each lost turn and why
//! <out>/build/messages.json, messages.txt the manifest and report of the messages run it came from
//! <out>/build/llm-cache.jsonl.zst         that run's LLM cache, packed ([`pack_cache`]; `datagen unpack-cache`)
//! <out>/contract/{tools.json,system.txt,hashes.json}   the tool contract the data was rendered for ([`crate::contract`])
//! ```
//!
//! Everything above is the published data version, published as one tag in each of two dataset repositories
//! ([`crate::publish`] lays it out): train, val and noise, their worlds, the contract and the reports in the data
//! repository; test, its worlds and the LLM cache in the held-out one. `datagen build` also keeps its stages under
//! `<out>/stages/`, which are working files and not published.
//!
//! # The record contract (what M6 reads)
//!
//! A line of a `*.jsonl.zst` is the session of `assist_eval::gold::Session` (`id`, `world`, `today`, `me`, `tags`,
//! `turns[{user, gold, ref, tags}]`, so [`crate::source::DatagenSource::open_version`] hands it to `assist-eval`
//! unchanged), plus `meta` (`app`, `apps`, `cells`, `span`: what the per-app and per-cell slices read) and
//!
//! ```json
//! "render": {"input_ids": [u32, ...], "weights": [f32, ...], "text": "<the rendered transcript>"}
//! ```
//!
//! `input_ids` and `weights` have one entry per token; the trainer reads only these two. `weights[i]` is the loss weight of
//! token `i` (see [`crate::render`]): 0 outside the assistant messages, 1 inside, [`crate::render::DECISION_WEIGHT`] on
//! deciding tokens. `text` is the string `input_ids` encodes.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{Value, json};

use crate::catalog::Catalog;
use crate::declarations::Declarations;
use crate::mix::{self, Selection};
use crate::render::{self, Counts, Features, Tokenizer, parallel};
use crate::source::{SESSIONS, WORLDS};

/// The folder of a data version that holds the split files.
pub const DATA: &str = "data";
/// The folder of a data version that holds how it was made.
pub const BUILD: &str = "build";
/// The packed LLM cache under [`BUILD`].
pub const PACKED_CACHE: &str = "llm-cache.jsonl.zst";
/// Packed isolated phrasing caches under [`BUILD`].
pub const PACKED_TRAIN_CACHE: &str = "phrasing-cache-train.jsonl.zst";
pub const PACKED_HELDOUT_CACHE: &str = "phrasing-cache-heldout.jsonl.zst";
/// Maximum records per deterministic zstd shard.
pub const SHARD_SIZE: usize = 500;

/// Legacy single-file path of `split` (`train`, `val`, `test`, `noise`) in the data version at `dir`.
#[must_use]
pub fn split_path(dir: &Path, split: &str) -> PathBuf {
    dir.join(DATA).join(format!("{split}.jsonl.zst"))
}

/// Ordered shard paths (`data/<split>/shard-XXXX.jsonl.zst`) for `split`, empty when unsharded.
#[must_use]
pub fn split_paths(dir: &Path, split: &str) -> Vec<PathBuf> {
    let shard_dir = dir.join(DATA).join(split);
    let Ok(entries) = std::fs::read_dir(&shard_dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("shard-") && n.ends_with(".jsonl.zst"))
        })
        .collect();
    paths.sort();
    paths
}

/// What rendering needs besides the input.
pub struct RenderConfig {
    pub tokenizer: PathBuf,
    pub decision_weight: f32,
    pub concurrency: usize,
}

/// One rendered session in the spool.
struct Slot {
    offset: u64,
    len: u32,
}

/// The frames of rendered sessions, appended as they are made and read back by position.
struct Spool {
    file: Mutex<(std::fs::File, u64)>,
    path: PathBuf,
}

impl Spool {
    fn create(path: &Path) -> Result<Self> {
        Ok(Self {
            file: Mutex::new((std::fs::File::create(path)?, 0)),
            path: path.to_path_buf(),
        })
    }

    fn append(&self, line: &str) -> Result<Slot> {
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        let frame = zstd::stream::encode_all(&bytes[..], 3)?;
        let mut guard = self
            .file
            .lock()
            .map_err(|_| anyhow::anyhow!("the spool lock is poisoned"))?;
        guard.0.write_all(&frame)?;
        let slot = Slot {
            offset: guard.1,
            len: u32::try_from(frame.len())?,
        };
        guard.1 += frame.len() as u64;
        Ok(slot)
    }

    fn read(&self, slot: &Slot) -> Result<Vec<u8>> {
        use std::io::{Seek, SeekFrom};
        let mut file = std::fs::File::open(&self.path)?;
        file.seek(SeekFrom::Start(slot.offset))?;
        let mut frame = vec![0_u8; slot.len as usize];
        file.read_exact(&mut frame)?;
        Ok(zstd::stream::decode_all(&frame[..])?)
    }
}

/// A session the renderer could not render, or lost turns of.
#[derive(Debug, Clone, Serialize)]
pub struct DropRow {
    pub split: String,
    pub session: String,
    /// 1-based turn.
    pub turn: usize,
    pub reason: String,
    pub detail: String,
    /// The session was kept as a shorter one.
    pub kept_turns: usize,
}

/// Everything rendering made.
pub struct Rendered {
    pub features: Vec<Features>,
    slots: Vec<Slot>,
    spool: Spool,
    pub counts: Counts,
    pub sessions_in: usize,
    pub truncated: usize,
    pub dropped: Vec<DropRow>,
    pub reasons: BTreeMap<String, usize>,
    pub tokenizer_hash: String,
    pub max_tokens: usize,
}

fn read_sessions(input: &Path) -> Result<BTreeMap<String, Vec<(String, Value)>>> {
    let mut by_world: BTreeMap<String, Vec<(String, Value)>> = BTreeMap::new();
    for split in ["train", "val", "test", "noise"] {
        let path = input.join(split).join(SESSIONS);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let record: Value =
                serde_json::from_str(line).with_context(|| path.display().to_string())?;
            by_world
                .entry(record["world"].as_str().unwrap_or_default().to_owned())
                .or_default()
                .push((split.to_owned(), record));
        }
    }
    Ok(by_world)
}

/// Render every session of the messages run in `input`.
///
/// # Errors
///
/// If the input or the tokenizer cannot be read, or a world cannot be seeded.
pub fn render_all(
    input: &Path,
    cfg: &RenderConfig,
    catalog: &Catalog,
    spool_path: &Path,
) -> Result<Rendered> {
    let tokenizer = Tokenizer::open(&cfg.tokenizer)?;
    let by_world = read_sessions(input)?;
    let spool = Spool::create(spool_path)?;
    let worlds: Vec<(String, Vec<(String, Value)>)> = by_world.into_iter().collect();
    let sessions_in: usize = worlds.iter().map(|(_, records)| records.len()).sum();
    type Made = (Features, Slot, Counts, bool, usize);
    type Out = (Vec<Made>, Vec<DropRow>);
    let results: Vec<Option<Result<Out>>> = parallel(&worlds, cfg.concurrency, |(id, records)| {
        let split_hint = records.first().map(|(s, _)| s.as_str()).unwrap_or("train");
        let split_sub = if split_hint == "noise" {
            "val"
        } else {
            split_hint
        };
        let flat = input.join(WORLDS).join(format!("{id}.json"));
        let nested = input
            .join(WORLDS)
            .join(split_sub)
            .join(format!("{id}.json"));
        let file = if flat.is_file() { flat } else { nested };
        let doc: Value = serde_json::from_str(
            &std::fs::read_to_string(&file).with_context(|| file.display().to_string())?,
        )?;
        let scratch = tempfile::tempdir()?;
        let done = render::world(
            &doc,
            catalog,
            records,
            &tokenizer,
            cfg.decision_weight,
            scratch.path(),
        )?;
        let mut made: Vec<Made> = Vec::new();
        let mut dropped: Vec<DropRow> = Vec::new();
        for ((split, record), (session, outcome)) in records.iter().zip(done) {
            let row = |refused: &render::Refused, kept: usize| DropRow {
                split: split.clone(),
                session: session.clone(),
                turn: refused.turn + 1,
                reason: refused.reason.clone(),
                detail: refused.detail.chars().take(300).collect(),
                kept_turns: kept,
            };
            let _ = record;
            match outcome {
                Ok((rendered, first)) => {
                    if let Some(refused) = first {
                        dropped.push(row(&refused, rendered.features.turns));
                    }
                    let slot = spool.append(&rendered.line)?;
                    let tokens = rendered.features.tokens;
                    made.push((
                        rendered.features,
                        slot,
                        rendered.counts,
                        rendered.truncated,
                        tokens,
                    ));
                }
                Err(refused) => dropped.push(row(&refused, 0)),
            }
        }
        Ok((made, dropped))
    });
    let mut all: Vec<Made> = Vec::new();
    let mut dropped: Vec<DropRow> = Vec::new();
    for result in results {
        let (made, rows) = result.context("a render thread panicked")??;
        all.extend(made);
        dropped.extend(rows);
    }
    all.sort_by(|a, b| (&a.0.split, &a.0.id).cmp(&(&b.0.split, &b.0.id)));
    dropped.sort_by(|a, b| (&a.split, &a.session).cmp(&(&b.split, &b.session)));
    let mut counts = Counts::default();
    let mut truncated = 0;
    let mut max_tokens = 0;
    let mut features = Vec::new();
    let mut slots = Vec::new();
    for (f, slot, c, cut, tokens) in all {
        counts.add(&c);
        truncated += usize::from(cut);
        max_tokens = max_tokens.max(tokens);
        features.push(f);
        slots.push(slot);
    }
    let mut reasons: BTreeMap<String, usize> = BTreeMap::new();
    for row in &dropped {
        *reasons.entry(row.reason.clone()).or_default() += 1;
    }
    Ok(Rendered {
        features,
        slots,
        spool,
        counts,
        sessions_in,
        truncated,
        dropped,
        reasons,
        tokenizer_hash: tokenizer.hash,
        max_tokens,
    })
}

/// What a data version is made of besides the sessions: the hashes that, together, name it.
#[derive(Debug, Clone, Default)]
pub struct Provenance {
    pub version: String,
    pub runtime_commit: String,
    pub tokenizer_path: String,
    pub seeds: Value,
}

/// The BLAKE3 of an LLM cache (every file's name and bytes, in name order) and how many outputs it holds.
///
/// # Errors
///
/// If a cache file cannot be read.
pub fn cache_hash(dir: &Path) -> Result<(String, usize)> {
    let names = cache_files(dir)?;
    let mut hasher = blake3::Hasher::new();
    for path in &names {
        hasher.update(
            path.strip_prefix(dir)
                .unwrap_or(path)
                .to_string_lossy()
                .as_bytes(),
        );
        hasher.update(&std::fs::read(path)?);
    }
    Ok((hasher.finalize().to_hex().to_string(), names.len()))
}

/// The cache files under `dir` (`<shard>/<hash>.json`), sorted by their path relative to `dir`.
fn cache_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut names: Vec<PathBuf> = Vec::new();
    if dir.is_dir() {
        for shard in std::fs::read_dir(dir)? {
            let shard = shard?.path();
            if shard.is_dir() {
                for file in std::fs::read_dir(&shard)? {
                    names.push(file?.path());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

/// Pack the LLM cache under `dir` into one zstd frame at `to`: a line `{"file": "<shard>/<hash>.json", "text": "..."}`
/// per cache file, in path order, so a published version carries its cache as one file. The number of entries.
///
/// # Errors
///
/// If a cache file cannot be read or `to` cannot be written.
pub fn pack_cache(dir: &Path, to: &Path) -> Result<usize> {
    let names = cache_files(dir)?;
    let file = std::fs::File::create(to).with_context(|| to.display().to_string())?;
    let mut encoder = zstd::stream::Encoder::new(std::io::BufWriter::new(file), 19)?;
    for path in &names {
        let rel = path
            .strip_prefix(dir)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let line = json!({"file": rel, "text": std::fs::read_to_string(path)?});
        encoder.write_all(serde_json::to_string(&line)?.as_bytes())?;
        encoder.write_all(b"\n")?;
    }
    encoder.finish()?.flush()?;
    Ok(names.len())
}

/// Unpack a cache packed by [`pack_cache`] into `dir` (a messages run's `llm-cache/`), byte for byte, so `datagen
/// messages --offline` over the same intents rebuilds with no model calls. The number of entries.
///
/// # Errors
///
/// If `from` cannot be read, a line is not a packed entry, or names a path outside `dir`.
pub fn unpack_cache(from: &Path, dir: &Path) -> Result<usize> {
    let bytes = zstd::stream::decode_all(
        std::fs::File::open(from).with_context(|| from.display().to_string())?,
    )?;
    let mut n = 0;
    for line in String::from_utf8(bytes)?.lines().filter(|l| !l.is_empty()) {
        let entry: Value = serde_json::from_str(line)?;
        let (Some(rel), Some(text)) = (entry["file"].as_str(), entry["text"].as_str()) else {
            anyhow::bail!("not a packed cache entry: {line:.80}");
        };
        let safe = rel.split('/').count() == 2
            && rel
                .split('/')
                .all(|part| !part.is_empty() && part != ".." && part != ".");
        anyhow::ensure!(safe, "a packed cache entry outside the cache: {rel}");
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap_or(dir))?;
        std::fs::write(&path, text)?;
        n += 1;
    }
    Ok(n)
}

/// The commit of the runtime this version was made with: `git rev-parse HEAD` where the command runs, `unknown` outside
/// a checkout.
#[must_use]
pub fn runtime_commit() -> String {
    let run = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    };
    match run(&["rev-parse", "HEAD"]) {
        Some(rev) => {
            let dirty = run(&["status", "--porcelain", "--untracked-files=no"])
                .is_some_and(|status| !status.is_empty());
            if dirty { format!("{rev}-dirty") } else { rev }
        }
        None => "unknown".to_owned(),
    }
}

/// What a data version is written from besides the sessions.
#[derive(Clone, Copy)]
pub struct Version<'a> {
    /// The messages run the sessions came from (its worlds and its LLM cache).
    pub input: &'a Path,
    pub out: &'a Path,
    pub catalog: &'a Catalog,
    pub provenance: &'a Provenance,
    pub decision_weight: f32,
    pub mix: &'a mix::Config,
}

/// Write the chosen sessions of each split, the worlds they name, the manifest and the report.
///
/// # Errors
///
/// If a file cannot be written.
#[allow(clippy::too_many_lines)]
pub fn write_version(
    version: &Version<'_>,
    rendered: &Rendered,
    selection: &Selection,
) -> Result<Value> {
    let Version {
        input,
        out,
        catalog,
        provenance,
        decision_weight,
        mix: cfg,
    } = *version;
    std::fs::create_dir_all(out.join(DATA))?;
    std::fs::create_dir_all(out.join(BUILD))?;
    let mut files = serde_json::Map::new();
    let mut shards_map = serde_json::Map::new();
    let mut example_ids = serde_json::Map::new();
    let mut worlds: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    for split in ["train", "val", "test", "noise"] {
        let mut indices = selection.chosen.get(split).cloned().unwrap_or_default();
        indices.sort_unstable();
        let split_dir = out.join(DATA).join(split);
        std::fs::create_dir_all(&split_dir)?;
        let mut split_shards = Vec::new();
        let mut split_ids = Vec::new();
        for i in &indices {
            split_ids.push(rendered.features[*i].id.clone());
            worlds
                .entry(rendered.features[*i].world.clone())
                .or_insert_with(|| if split == "noise" { "val" } else { split }.to_owned());
        }
        if indices.is_empty() {
            let rel = format!("{DATA}/{split}/shard-0000.jsonl.zst");
            let path = out.join(&rel);
            let file = std::fs::File::create(&path)?;
            let encoder = zstd::stream::Encoder::new(std::io::BufWriter::new(file), 6)?;
            encoder.finish()?.flush()?;
            let bytes = std::fs::read(&path)?;
            let meta = json!({
                "path": rel,
                "sessions": 0,
                "bytes": bytes.len(),
                "blake3": blake3::hash(&bytes).to_hex().to_string(),
            });
            files.insert(
                rel,
                json!({"sessions": 0, "bytes": bytes.len(), "blake3": meta["blake3"]}),
            );
            split_shards.push(meta);
        } else {
            for (shard_idx, chunk) in indices.chunks(SHARD_SIZE).enumerate() {
                let rel = format!("{DATA}/{split}/shard-{shard_idx:04}.jsonl.zst");
                let path = out.join(&rel);
                let file = std::fs::File::create(&path)?;
                let mut encoder = zstd::stream::Encoder::new(std::io::BufWriter::new(file), 6)?;
                for i in chunk {
                    encoder.write_all(&rendered.spool.read(&rendered.slots[*i])?)?;
                }
                encoder.finish()?.flush()?;
                let bytes = std::fs::read(&path)?;
                let hash = blake3::hash(&bytes).to_hex().to_string();
                files.insert(
                    rel.clone(),
                    json!({
                        "sessions": chunk.len(),
                        "bytes": bytes.len(),
                        "blake3": hash,
                    }),
                );
                split_shards.push(json!({
                    "path": rel,
                    "sessions": chunk.len(),
                    "bytes": bytes.len(),
                    "blake3": hash,
                }));
            }
        }
        shards_map.insert(split.to_owned(), Value::Array(split_shards));
        example_ids.insert(split.to_owned(), json!(split_ids));
    }
    // nested train subsets: deterministic sharded zstd files under `data/subsets/<name>/shard-XXXX.jsonl.zst`
    let mut subsets = serde_json::Map::new();
    for (name, indices) in &selection.subsets {
        let mut indices = indices.clone();
        indices.sort_unstable();
        let sub_dir = out.join(DATA).join("subsets").join(name);
        std::fs::create_dir_all(&sub_dir)?;
        let mut total_bytes = 0_usize;
        let mut sub_shards = Vec::new();
        for (shard_idx, chunk) in indices.chunks(SHARD_SIZE.max(1)).enumerate() {
            let rel = format!("{DATA}/subsets/{name}/shard-{shard_idx:04}.jsonl.zst");
            let path = out.join(&rel);
            let file = std::fs::File::create(&path)?;
            let mut encoder = zstd::stream::Encoder::new(std::io::BufWriter::new(file), 6)?;
            for i in chunk {
                encoder.write_all(&rendered.spool.read(&rendered.slots[*i])?)?;
            }
            encoder.finish()?.flush()?;
            let bytes = std::fs::read(&path)?;
            total_bytes += bytes.len();
            let hash = blake3::hash(&bytes).to_hex().to_string();
            let entry = json!({
                "path": rel,
                "sessions": chunk.len(),
                "within": "train",
                "bytes": bytes.len(),
                "blake3": hash,
            });
            files.insert(
                rel,
                json!({
                    "sessions": chunk.len(),
                    "within": "train",
                    "bytes": bytes.len(),
                    "blake3": hash,
                }),
            );
            sub_shards.push(entry);
        }
        subsets.insert(
            name.clone(),
            json!({
                "sessions": indices.len(),
                "within": "train",
                "bytes": total_bytes,
                "shards": sub_shards,
            }),
        );
    }
    let wdir = out.join(WORLDS);
    std::fs::create_dir_all(&wdir)?;
    for (id, split_name) in &worlds {
        let src = if input.join(WORLDS).join(format!("{id}.json")).is_file() {
            input.join(WORLDS).join(format!("{id}.json"))
        } else {
            input
                .join(WORLDS)
                .join(split_name)
                .join(format!("{id}.json"))
        };
        let split_wdir = wdir.join(split_name);
        std::fs::create_dir_all(&split_wdir)?;
        if src.is_file() {
            std::fs::copy(&src, split_wdir.join(format!("{id}.json")))?;
        }
    }
    let (cache, entries) = cache_hash(&input.join("llm-cache"))?;
    let packed = pack_cache(
        &input.join("llm-cache"),
        &out.join(BUILD).join(PACKED_CACHE),
    )?;
    for (from, to) in [
        ("manifest.json", "messages.json"),
        ("report.txt", "messages.txt"),
        ("models.json", "models.json"),
    ] {
        if input.join(from).exists() {
            std::fs::copy(input.join(from), out.join(BUILD).join(to))?;
        }
    }
    let splits: Vec<Value> = selection
        .reports
        .iter()
        .chain(&selection.subset_reports)
        .map(|r| {
            json!({
                "split": r.split,
                "target": r.target_sessions,
                "sessions": r.sessions,
                "turns": r.turns,
                "tokens": r.tokens,
                "minimal_pairs": r.pairs,
                "multi_turn_share": r.multi_turn_share,
                "three_plus_share": r.three_plus_share,
                "ask_or_act_pairs": r.ask_or_act_pairs,
                "by_turns": r.by_turns,
                "shares": r.shares,
                "apps": r.apps,
                "cells": r.cells,
                "duplicates_removed": r.duplicates,
                "broken_pairs_removed": r.orphan_pairs,
                "reserved_removed": r.reserved_out,
                "missed": r.missed,
            })
        })
        .collect();
    let models: Value = std::fs::read_to_string(input.join("models.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let test_tokenizer = rendered.tokenizer_hash
        == blake3::hash(crate::render::byte_level_tokenizer_json().as_bytes())
            .to_hex()
            .to_string();
    let rehearsal = models["writers"]
        .as_object()
        .into_iter()
        .chain(models["readers"].as_object())
        .flat_map(serde_json::Map::values)
        .filter_map(Value::as_str)
        .any(|m| m.starts_with("rehearsal-"))
        || models["rehearsal"].as_bool().unwrap_or(false);
    let mut blockers: Vec<&str> = Vec::new();
    if test_tokenizer {
        blockers.push("rendered with the test (byte-level) tokenizer, not the chat model's own");
    }
    if provenance.runtime_commit.ends_with("-dirty") || provenance.runtime_commit == "unknown" {
        blockers.push("built from a tree with uncommitted changes, or an unknown commit");
    }
    let tools = crate::plan::tools_mode();
    if tools == centraid_assist::native::prompt::ToolsMode::S2 {
        blockers.push(
            "the model record's tools block is s2, the tools before the regroup: it does not list create, edit or do, which the reference calls use",
        );
    }
    if rehearsal {
        blockers.push("written or read back by a rehearsal model, not a language model");
    }
    let decls_hash = Declarations::build()
        .map(|d| d.hash())
        .unwrap_or_else(|_| catalog.hash());
    let contract = crate::contract::Contract::current_v2(
        tools,
        &catalog.hash(),
        &decls_hash,
        &rendered.tokenizer_hash,
        &provenance.runtime_commit,
    );
    crate::contract::write_files(out, &contract)?;
    let manifest = json!({
        "schema_version": 2,
        "version": provenance.version,
        "tools_block": {"mode": tools.name(), "from": "crates/assist/model.json"},
        "contract": contract.to_json(),
        "heldout": {"repo": crate::publish::HELDOUT_REPO},
        "publishable": {"value": blockers.is_empty(), "blockers": blockers},
        "messages": models,
        "stage": "render+mix",
        "catalog_hash": catalog.hash(),
        "declarations_hash": decls_hash,
        "runtime_hash": contract.runtime_hash,
        "runtime_commit": provenance.runtime_commit,
        "seeds": provenance.seeds,
        "tokenizer": {"file": provenance.tokenizer_path, "blake3": rendered.tokenizer_hash, "test_tokenizer": test_tokenizer},
        "llm_cache": {"blake3": cache, "entries": entries, "packed": format!("{BUILD}/{PACKED_CACHE}"), "packed_entries": packed},
        "phrasing_cache": {
            "train": format!("{BUILD}/{PACKED_TRAIN_CACHE}"),
            "heldout": format!("{BUILD}/{PACKED_HELDOUT_CACHE}"),
            "isolated": true,
        },
        "shards": shards_map,
        "example_ids": example_ids,
        "weights": {
            "decision": decision_weight,
            "assistant": 1.0,
            "context": 0.0,
            "masked": "the first call of an error-then-repair turn",
        },
        "record": {
            "fields": ["id", "world", "today", "me", "tags", "turns[{user, gold, ref, tags}]", "meta", "render"],
            "render": ["input_ids", "weights", "text"],
        },
        "targets": {
            "train": cfg.targets[0], "val": cfg.targets[1], "test": cfg.targets[2],
            "shares": cfg.shares,
            "cell_floor": {"train": cfg.floor[0], "val": cfg.floor[1], "test": cfg.floor[2]},
        },
        "subsets": subsets,
        "reserved_combinations": selection.reserved,
        "render": {
            "sessions_in": rendered.sessions_in,
            "sessions_rendered": rendered.features.len(),
            "sessions_truncated": rendered.truncated,
            "steps": rendered.counts.steps,
            "steps_roundtripped": rendered.counts.roundtrips,
            "tokens": rendered.counts.tokens,
            "max_tokens": rendered.max_tokens,
        },
        "splits": splits,
        "noise_sessions": selection.chosen.get("noise").map_or(0, Vec::len),
        "files": files,
    });
    std::fs::write(
        out.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    let mut dropped = String::new();
    for row in &rendered.dropped {
        dropped.push_str(&serde_json::to_string(row)?);
        dropped.push('\n');
    }
    std::fs::write(out.join(BUILD).join("render-dropped.jsonl"), dropped)?;
    Ok(manifest)
}

/// The report of the render stage as text.
#[must_use]
pub fn render_report(rendered: &Rendered, decision_weight: f32) -> String {
    let c = &rendered.counts;
    let pct = |a: usize, b: usize| format!("{:.1}%", 100.0 * a as f64 / b.max(1) as f64);
    let mut out = String::new();
    out.push_str(&format!(
        "== render\nsessions in {}; rendered {} ({} as shorter sessions); dropped {}\n",
        rendered.sessions_in,
        rendered.features.len(),
        rendered.truncated,
        rendered.sessions_in - rendered.features.len()
    ));
    out.push_str(&format!(
        "steps {} — every one's think compiled back to the reference call ({} round-trips); a refused call is masked: {} steps\n",
        c.steps, c.roundtrips, c.masked_steps
    ));
    out.push_str(&format!(
        "periods: {} as dates[i], {} as the compact date; numbers as nums[i]: {}\n",
        c.dates_ref, c.dates_literal, c.nums_ref
    ));
    out.push_str(&format!(
        "tokens {} (longest session {}); weight 0: {} ({}), weight 1: {} ({}), weight {decision_weight}: {} ({})\n",
        c.tokens,
        rendered.max_tokens,
        c.tokens_zero,
        pct(c.tokens_zero, c.tokens),
        c.tokens_one,
        pct(c.tokens_one, c.tokens),
        c.tokens_decision,
        pct(c.tokens_decision, c.tokens)
    ));
    if !rendered.reasons.is_empty() {
        out.push_str("lost turns by reason:\n");
        for (reason, n) in &rendered.reasons {
            out.push_str(&format!("  {reason:<14} {n}\n"));
        }
        for row in rendered.dropped.iter().take(8) {
            out.push_str(&format!(
                "  e.g. {} turn {} {}: {}\n",
                row.session, row.turn, row.reason, row.detail
            ));
        }
    }
    out
}

/// Render and mix the messages run in `input` into the data version in `out`.
///
/// # Errors
///
/// If rendering, mixing or writing fails.
pub fn render_and_mix(
    input: &Path,
    out: &Path,
    rcfg: &RenderConfig,
    mcfg: &mix::Config,
    provenance: &Provenance,
) -> Result<String> {
    let catalog = Catalog::build()?;
    let decls = Declarations::build()?;
    let mut mcfg = mcfg.clone();
    let mut live_cells = Vec::new();
    for k in &decls.kinds {
        live_cells.push(format!("find/{}/read", k.name));
        live_cells.push(format!("compute/{}/count", k.name));
        live_cells.push(format!("create/{}/create", k.name));
        live_cells.push(format!("edit/{}/edit", k.name));
        for v in &k.verbs {
            if v != "create" && v != "edit" {
                live_cells.push(format!("do/{}/{v}", k.name));
            }
        }
    }
    mcfg.live = live_cells;
    std::fs::create_dir_all(out)?;
    let spool_path = out.join(".render.spool");
    let rendered = render_all(input, rcfg, &catalog, &spool_path)?;
    let selection = mix::mix(&rendered.features, &mcfg)?;
    write_version(
        &Version {
            input,
            out,
            catalog: &catalog,
            provenance,
            decision_weight: rcfg.decision_weight,
            mix: &mcfg,
        },
        &rendered,
        &selection,
    )?;
    let text = format!(
        "{}\n{}",
        render_report(&rendered, rcfg.decision_weight),
        mix::text(&selection)
    );
    std::fs::write(out.join(BUILD).join("render.txt"), &text)?;
    drop(rendered);
    let _ = std::fs::remove_file(&spool_path);
    Ok(text)
}

/// Configuration for the unified evolvable `datagen build` pipeline.
#[derive(Debug, Clone)]
pub struct BuildConfig {
    pub version: String,
    pub seed: u64,
    pub typo_seed: u64,
    pub cache_dir: PathBuf,
    pub out_dir: PathBuf,
    pub tokenizer: PathBuf,
    pub train_target: usize,
    pub val_target: usize,
    pub test_target: usize,
    pub train_floor: usize,
    pub offline: bool,
    pub rehearsal: bool,
    pub enforce_floors: bool,
    pub decision_weight: f32,
    pub concurrency: usize,
    pub mix_cfg: mix::Config,
}

/// Build a complete sharded data version from declarations, deterministic fixture worlds,
/// isolated meaning-keyed phrasing caches, runtime oracle replay, and deterministic sharded render.
///
/// # Errors
///
/// Fails if any live declaration/argument has 0 intents, any of `ALL_MANIFEST_ACTIONS` lacks a
/// declared tool path, any cache entry is missing when `offline = true`, or any train floor is
/// missed when `enforce_floors = true`.
#[allow(clippy::too_many_lines)]
pub fn build_evolvable(cfg: &BuildConfig) -> Result<String> {
    let decls = Declarations::build()?;
    let catalog = Catalog::from_declarations(&decls);
    let pool = crate::intents::generate_pool(
        &decls,
        cfg.seed,
        cfg.train_target,
        cfg.val_target,
        cfg.test_target,
        cfg.train_floor,
    );
    let audit = crate::intents::audit_coverage(&decls, &pool);
    if !audit.is_complete() {
        anyhow::bail!(
            "declaration coverage guard failed: uncovered_tools={:?}, uncovered_args={:?}, uncovered_kinds={:?}, uncovered_kind_fields={:?}, uncovered_manifest_actions={:?}",
            audit.uncovered_tools,
            audit.uncovered_args,
            audit.uncovered_kinds,
            audit.uncovered_kind_fields,
            audit.uncovered_manifest_actions
        );
    }

    let train_cache = crate::phrasing_cache::PhrasingCache::open(
        &cfg.cache_dir,
        crate::phrasing_cache::CacheScope::Train,
    )?;
    let heldout_cache = crate::phrasing_cache::PhrasingCache::open(
        &cfg.cache_dir,
        crate::phrasing_cache::CacheScope::Heldout,
    )?;

    if cfg.rehearsal {
        crate::deficit::populate_rehearsal(&pool, &catalog, &train_cache, &heldout_cache)?;
    }

    let train_pool = train_cache.passing_pool()?;
    let heldout_pool = heldout_cache.passing_pool()?;
    let mut missing = Vec::new();
    for spec in &pool {
        let map = match crate::phrasing_cache::CacheScope::of_split(spec.split) {
            crate::phrasing_cache::CacheScope::Train => &train_pool,
            crate::phrasing_cache::CacheScope::Heldout => &heldout_pool,
        };
        if !map.contains_key(&spec.meaning_key) {
            missing.push(spec.meaning_key.clone());
        }
    }
    if cfg.offline && !missing.is_empty() {
        anyhow::bail!(
            "offline build failed: {} meaning_keys missing from phrasing cache (run `datagen plan` / `export-batches` + `import-batches`)",
            missing.len()
        );
    }

    // Write staged sessions + fixture worlds after replaying each through the current runtime oracle
    // in parallel across `concurrency` threads, collecting results deterministically by index.
    let stage_dir = cfg.out_dir.join("stages").join("messages");
    std::fs::create_dir_all(stage_dir.join(WORLDS))?;
    let mut jobs: Vec<(
        usize,
        &crate::intents::IntentSpec,
        &crate::phrasing_cache::CachedVariant,
    )> = Vec::new();
    let mut writers_used = std::collections::BTreeSet::new();
    let mut readers_used = std::collections::BTreeSet::new();
    let mut any_rehearsal = cfg.rehearsal;
    // For fast unfloored test/smoke builds (`!cfg.enforce_floors`), keep a deterministic diverse
    // sample matching the requested targets after verifying full declaration coverage above.
    let mut train_done_kept = 0_usize;
    let mut train_special_kept = 0_usize;
    let mut val_kept = 0_usize;
    let mut test_kept = 0_usize;
    let max_train = cfg.train_target.max(40);
    let max_val = cfg.val_target.max(10);
    let max_test = cfg.test_target.max(10);
    let special_cap = (max_train / 2).max(15);

    for (idx, spec) in pool.iter().enumerate() {
        let map = match crate::phrasing_cache::CacheScope::of_split(spec.split) {
            crate::phrasing_cache::CacheScope::Train => &train_pool,
            crate::phrasing_cache::CacheScope::Heldout => &heldout_pool,
        };
        let Some(variants) = map.get(&spec.meaning_key) else {
            continue;
        };
        if !cfg.enforce_floors {
            match spec.split {
                crate::world::Split::Train => {
                    let is_special = spec.scenario.turns.len() >= 2
                        || spec
                            .scenario
                            .turns
                            .iter()
                            .any(|t| !matches!(t.outcome, crate::intent::Outcome::Done));
                    if is_special {
                        if train_special_kept >= special_cap {
                            continue;
                        }
                        train_special_kept += 1;
                    } else {
                        if train_done_kept + special_cap >= max_train {
                            continue;
                        }
                        train_done_kept += 1;
                    }
                }
                crate::world::Split::Val => {
                    if val_kept >= max_val {
                        continue;
                    }
                    val_kept += 1;
                }
                crate::world::Split::Test => {
                    if test_kept >= max_test {
                        continue;
                    }
                    test_kept += 1;
                }
            }
        }
        let variant = &variants[idx % variants.len()];
        writers_used.insert(variant.writer.clone());
        if let Some(r) = &variant.reader {
            readers_used.insert(r.clone());
        }
        if variant.writer.starts_with("rehearsal-") {
            any_rehearsal = true;
        }
        let world_path = stage_dir
            .join(WORLDS)
            .join(format!("{}.json", spec.world.id()));
        if !world_path.is_file() {
            std::fs::write(&world_path, serde_json::to_string(&spec.world.doc)?)?;
        }
        jobs.push((idx, spec, variant));
    }

    let workers = cfg.concurrency.clamp(1, 8).min(jobs.len().max(1));
    let cursor = std::sync::atomic::AtomicUsize::new(0);
    let results: Mutex<Vec<(usize, Result<Value, String>)>> =
        Mutex::new(Vec::with_capacity(jobs.len()));
    std::thread::scope(|s| -> Result<()> {
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            handles.push(s.spawn(|| -> Result<()> {
                let scratch = tempfile::tempdir()?;
                loop {
                    let i = cursor.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(&(idx, spec, variant)) = jobs.get(i) else {
                        break;
                    };
                    let res = crate::oracle::replay_intent(
                        spec,
                        &catalog,
                        &variant.messages,
                        scratch.path(),
                    )?;
                    results
                        .lock()
                        .expect("replay results lock")
                        .push((idx, res));
                }
                Ok(())
            }));
        }
        for h in handles {
            match h.join() {
                Ok(r) => r?,
                Err(_) => anyhow::bail!("oracle replay worker thread panicked"),
            }
        }
        Ok(())
    })?;

    let mut replay_out = results.into_inner().expect("replay results");
    replay_out.sort_by_key(|(idx, _)| *idx);

    let mut split_files: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut oracle_dropped = 0_usize;
    let mut train_cell_pass: BTreeMap<String, usize> = BTreeMap::new();
    let mut train_kf_pass: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut train_arg_pass: BTreeMap<(String, String), usize> = BTreeMap::new();

    for (idx, replayed) in replay_out {
        let spec = &pool[idx];
        match replayed {
            Ok(rec) => {
                if spec.split == crate::world::Split::Train {
                    for c in &spec.covered_cells {
                        *train_cell_pass.entry(c.clone()).or_default() += 1;
                    }
                    for kf in &spec.covered_kind_fields {
                        *train_kf_pass.entry(kf.clone()).or_default() += 1;
                    }
                    for ta in &spec.covered_tool_args {
                        *train_arg_pass.entry(ta.clone()).or_default() += 1;
                    }
                }
                split_files
                    .entry(spec.split.name().to_owned())
                    .or_default()
                    .push(serde_json::to_string(&rec)?);
                if spec.split == crate::world::Split::Val {
                    let mut noise_rec = rec;
                    if let Some(turns) = noise_rec["turns"].as_array_mut() {
                        for (ti, t) in turns.iter_mut().enumerate() {
                            if let Some(u) = t["user"].as_str() {
                                let mut typo_rng =
                                    crate::rng::Rng::new(cfg.typo_seed ^ ((idx * 31 + ti) as u64));
                                let noisy = crate::typos::apply(
                                    u,
                                    &[],
                                    &mut typo_rng,
                                    crate::typos::Level::Heavy,
                                );
                                t["user"] = json!(noisy);
                            }
                        }
                    }
                    split_files
                        .entry("noise".to_owned())
                        .or_default()
                        .push(serde_json::to_string(&noise_rec)?);
                }
            }
            Err(_) => {
                oracle_dropped += 1;
            }
        }
    }

    if cfg.enforce_floors && cfg.train_floor > 0 {
        let mut misses = Vec::new();
        for (c, count) in &train_cell_pass {
            if *count < cfg.train_floor {
                misses.push(format!("cell {c}: {count} < {}", cfg.train_floor));
            }
        }
        for kd in decls.kinds.iter().filter(|k| k.live) {
            for fd in kd.fields.iter().filter(|f| f.live) {
                let count = train_kf_pass
                    .get(&(kd.name.clone(), fd.name.clone()))
                    .copied()
                    .unwrap_or(0);
                if count < cfg.train_floor {
                    misses.push(format!(
                        "({}.{}): {count} < {}",
                        kd.name, fd.name, cfg.train_floor
                    ));
                }
            }
        }
        for td in decls.tools.iter().filter(|t| t.live) {
            for ad in td.args.iter().filter(|a| a.live) {
                let count = train_arg_pass
                    .get(&(td.name.clone(), ad.name.clone()))
                    .copied()
                    .unwrap_or(0);
                if count < cfg.train_floor {
                    misses.push(format!(
                        "arg {}.{}: {count} < {}",
                        td.name, ad.name, cfg.train_floor
                    ));
                }
            }
        }
        if !misses.is_empty() {
            anyhow::bail!("train floor guard failed: {}", misses.join(", "));
        }
    }

    for (split_name, lines) in &split_files {
        let dir = stage_dir.join(split_name);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join(SESSIONS), lines.join("\n") + "\n")?;
    }
    std::fs::write(
        stage_dir.join("models.json"),
        serde_json::to_string_pretty(&json!({
            "writers": {"pool": writers_used.into_iter().collect::<Vec<_>>()},
            "readers": {"pool": readers_used.into_iter().collect::<Vec<_>>()},
            "rehearsal": any_rehearsal,
        }))?,
    )?;

    // Pack separate phrasing caches for heldout repo archival.
    std::fs::create_dir_all(cfg.out_dir.join(BUILD))?;
    let train_packed = train_cache.pack(&cfg.out_dir.join(BUILD).join(PACKED_TRAIN_CACHE))?;
    let heldout_packed = heldout_cache.pack(&cfg.out_dir.join(BUILD).join(PACKED_HELDOUT_CACHE))?;
    train_cache.write_declarations(&decls)?;
    heldout_cache.write_declarations(&decls)?;

    let provenance = Provenance {
        version: cfg.version.clone(),
        runtime_commit: runtime_commit(),
        tokenizer_path: cfg
            .tokenizer
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
        seeds: json!({"master": cfg.seed, "typos": cfg.typo_seed, "mix": cfg.mix_cfg.seed}),
    };
    let rcfg = RenderConfig {
        tokenizer: cfg.tokenizer.clone(),
        decision_weight: cfg.decision_weight,
        concurrency: cfg.concurrency,
    };
    let report_text = render_and_mix(&stage_dir, &cfg.out_dir, &rcfg, &cfg.mix_cfg, &provenance)?;
    Ok(format!(
        "{report_text}\noracle_dropped={oracle_dropped}, cache_train={train_packed}, cache_heldout={heldout_packed}\n"
    ))
}
