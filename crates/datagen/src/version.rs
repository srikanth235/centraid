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
use crate::grid::Grid;
use crate::llm::parallel;
use crate::mix::{self, Selection};
use crate::render::{self, Counts, Features, Tokenizer};
use crate::source::{SESSIONS, WORLDS};

/// The folder of a data version that holds the split files.
pub const DATA: &str = "data";
/// The folder of a data version that holds how it was made.
pub const BUILD: &str = "build";
/// The packed LLM cache under [`BUILD`].
pub const PACKED_CACHE: &str = "llm-cache.jsonl.zst";

/// The file of `split` (`train`, `val`, `test`, `noise`) in the data version at `dir`.
#[must_use]
pub fn split_path(dir: &Path, split: &str) -> PathBuf {
    dir.join(DATA).join(format!("{split}.jsonl.zst"))
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
        let file = input.join(WORLDS).join(format!("{id}.json"));
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
    let mut worlds: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for split in ["train", "val", "test", "noise"] {
        let mut indices = selection.chosen.get(split).cloned().unwrap_or_default();
        indices.sort_unstable();
        let path = split_path(out, split);
        let file = std::fs::File::create(&path)?;
        let mut encoder = zstd::stream::Encoder::new(std::io::BufWriter::new(file), 6)?;
        for i in &indices {
            encoder.write_all(&rendered.spool.read(&rendered.slots[*i])?)?;
            worlds.insert(rendered.features[*i].world.clone());
        }
        encoder.finish()?.flush()?;
        let bytes = std::fs::read(&path)?;
        files.insert(
            format!("{DATA}/{split}.jsonl.zst"),
            json!({
                "sessions": indices.len(),
                "bytes": bytes.len(),
                "blake3": blake3::hash(&bytes).to_hex().to_string(),
            }),
        );
    }
    // nested train subsets: each is a file of its own, `data/<name>.jsonl.zst`, holding the same records as the train file
    // does for those sessions, in the train file's order, so a job names a subset and fetches one file
    let mut subsets = serde_json::Map::new();
    for (name, indices) in &selection.subsets {
        let mut indices = indices.clone();
        indices.sort_unstable();
        let rel = format!("{DATA}/{name}.jsonl.zst");
        let path = out.join(&rel);
        let file = std::fs::File::create(&path)?;
        let mut encoder = zstd::stream::Encoder::new(std::io::BufWriter::new(file), 6)?;
        for i in &indices {
            encoder.write_all(&rendered.spool.read(&rendered.slots[*i])?)?;
        }
        encoder.finish()?.flush()?;
        let bytes = std::fs::read(&path)?;
        let entry = json!({
            "sessions": indices.len(),
            "within": "train",
            "bytes": bytes.len(),
            "blake3": blake3::hash(&bytes).to_hex().to_string(),
        });
        files.insert(rel, entry.clone());
        subsets.insert(name.clone(), entry);
    }
    let wdir = out.join(WORLDS);
    std::fs::create_dir_all(&wdir)?;
    for id in &worlds {
        std::fs::copy(
            input.join(WORLDS).join(format!("{id}.json")),
            wdir.join(format!("{id}.json")),
        )?;
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
        .any(|m| m.starts_with(crate::rehearsal::PREFIX));
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
    let contract =
        crate::contract::Contract::current(tools, &catalog.hash(), &rendered.tokenizer_hash);
    crate::contract::write_files(out, &contract)?;
    let manifest = json!({
        "version": provenance.version,
        "tools_block": {"mode": tools.name(), "from": "crates/assist/model.json"},
        "contract": contract.to_json(),
        "heldout": {"repo": crate::publish::HELDOUT_REPO},
        "publishable": {"value": blockers.is_empty(), "blockers": blockers},
        "messages": models,
        "stage": "render+mix",
        "catalog_hash": catalog.hash(),
        "runtime_commit": provenance.runtime_commit,
        "seeds": provenance.seeds,
        "tokenizer": {"file": provenance.tokenizer_path, "blake3": rendered.tokenizer_hash, "test_tokenizer": test_tokenizer},
        "llm_cache": {"blake3": cache, "entries": entries, "packed": format!("{BUILD}/{PACKED_CACHE}"), "packed_entries": packed},
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
    let grid = Grid::build(&catalog);
    let mut mcfg = mcfg.clone();
    mcfg.live = grid.live().iter().map(|c| c.to_string()).collect();
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
