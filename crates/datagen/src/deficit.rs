//! PART 3, DEFICIT PLANNER & PHASE D SWARM BATCH EXPORT/IMPORT:
//!
//! Computes `work_order = (train_floors + mix_targets) - passing_cache_pool + refresh`,
//! classifies schema evolution (`Rename` -> 0 writer prompts, `Added` -> deficit only,
//! `ChangedMeaning`/`Removed` -> invalidate/convert to decline with 0 new writer prompts),
//! and exports/imports isolated `train` and `heldout` batches for Hydrogen swarm subagents
//! (8-10 variants per writer prompt sharing `WRITER_PREFIX`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::brief::Briefer;
use crate::catalog::Catalog;
use crate::declarations::{ChangeKind, ChangeSet, Declarations, classify_diff};
use crate::intents::IntentSpec;
use crate::oracle::{
    AmbiguityVerdict, check_ambiguity_resolver, check_currency_message, check_no_sealed,
    replay_intent,
};
use crate::phrasing_cache::{
    CacheEntry, CacheScope, CachedVariant, PhrasingCache, ReaderCheck, VariantStatus, variant_id,
};
use crate::world::Split;

/// Shared cached instruction prefix included once per writer batch (`WRITER_PREFIX`).
pub const WRITER_PREFIX: &str = "\
You write realistic, terse English phone messages a member types to their personal assistant \
(covering tasks, calendar, people, notes, docs, photos, locker, money, health). \
For each prompt entry, generate 8 to 10 distinct natural variants matching its `style`, `ask`, \
`how` (naming/reference rule), `say_verbatim` spans, and `currency` (if money). \
Hard rules:\n\
- Preserve every `say_verbatim` string verbatim.\n\
- For INR money asks, use INR currency forms (`₹`, `Rs`, `Rs.`, `INR`, `rupee`, `lakh`, `crore`); \
for USD/EUR/GBP/AED/SGD use `$`, `€`, `£`, `AED`, `S$` (never mix currencies).\n\
- Never mention tool names, parameter names, vault ids, or sealed secret values.\n\
- Output valid JSON: {\"prompts\": [{\"meaning_key\": \"...\", \"variants\": [\"...\", ...]}]}.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanConfig {
    pub version: String,
    pub train_target: usize,
    pub val_target: usize,
    pub test_target: usize,
    pub train_floor: usize,
    pub variants_per_prompt: usize,
    pub refresh_rate: f64,
    pub batch_size: usize,
}

impl Default for PlanConfig {
    fn default() -> Self {
        Self {
            version: "v0.4".to_owned(),
            train_target: 5000,
            val_target: 500,
            test_target: 1000,
            train_floor: 30,
            variants_per_prompt: 9,
            refresh_rate: 0.10,
            batch_size: 16,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriterPromptItem {
    pub meaning_key: String,
    pub intent_key: String,
    pub scope: CacheScope,
    pub style: String,
    pub today: String,
    pub currency: Option<String>,
    pub variants_wanted: usize,
    pub turns: Vec<WriterTurnBrief>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriterTurnBrief {
    pub turn: usize,
    pub ask: String,
    pub say_verbatim: Vec<String>,
    pub how: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReaderPromptItem {
    pub meaning_key: String,
    pub variant_id: String,
    pub scope: CacheScope,
    pub today: String,
    pub messages: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeficitPlan {
    pub version: String,
    pub changes: ChangeSet,
    pub unique_meaning_keys_total: usize,
    pub unique_meaning_keys_train: usize,
    pub unique_meaning_keys_heldout: usize,
    pub passing_pool_train: usize,
    pub passing_pool_heldout: usize,
    pub refresh_keys_count: usize,
    pub invalidated_keys_count: usize,
    pub targets_to_rebuild: usize,
    pub scaled_train_target: usize,
    pub scaling_note: Option<String>,
    pub train_writer_prompts: Vec<WriterPromptItem>,
    pub heldout_writer_prompts: Vec<WriterPromptItem>,
    pub train_reader_items: Vec<ReaderPromptItem>,
    pub heldout_reader_items: Vec<ReaderPromptItem>,
    pub variants_per_prompt: usize,
}

impl DeficitPlan {
    #[must_use]
    pub fn total_writer_prompts(&self) -> usize {
        self.train_writer_prompts.len() + self.heldout_writer_prompts.len()
    }

    #[must_use]
    pub fn summary_text(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("== deficit plan ({})\n", self.version));
        out.push_str(&format!(
            "unique meaning keys: {} total (train/val: {}, heldout: {})\n",
            self.unique_meaning_keys_total,
            self.unique_meaning_keys_train,
            self.unique_meaning_keys_heldout
        ));
        out.push_str(&format!(
            "passing cache pool: train={}, heldout={} | invalidated={}, refresh={}, rebuild_targets={}\n",
            self.passing_pool_train,
            self.passing_pool_heldout,
            self.invalidated_keys_count,
            self.refresh_keys_count,
            self.targets_to_rebuild
        ));
        out.push_str(&format!(
            "writer prompts needed ({} variants/prompt, shared WRITER_PREFIX): train={}, heldout={}, total={}\n",
            self.variants_per_prompt,
            self.train_writer_prompts.len(),
            self.heldout_writer_prompts.len(),
            self.total_writer_prompts()
        ));
        out.push_str(&format!(
            "selective reader items needed: train={}, heldout={}\n",
            self.train_reader_items.len(),
            self.heldout_reader_items.len()
        ));
        if let Some(note) = &self.scaling_note {
            out.push_str(&format!("scaling: {note}\n"));
        }
        if !self.changes.is_empty() {
            out.push_str(&format!(
                "evolution diff: rename={}, added={}, changed_meaning={}, removed={}\n",
                self.changes.by_kind(ChangeKind::Rename).len(),
                self.changes.by_kind(ChangeKind::Added).len(),
                self.changes.by_kind(ChangeKind::ChangedMeaning).len(),
                self.changes.by_kind(ChangeKind::Removed).len(),
            ));
        }
        out
    }
}

fn is_deliberate_refresh(version: &str, meaning_key: &str, refresh_rate: f64) -> bool {
    if refresh_rate <= 0.0 {
        return false;
    }
    let threshold = (refresh_rate * 100.0).round() as u32;
    let h = blake3::hash(format!("{version}:{meaning_key}").as_bytes());
    let pct = u32::from(h.as_bytes()[0]) % 100;
    pct < threshold
}

/// Compute the work order for `pool` given `decls`, optional `prev_decls`, and isolated caches.
///
/// # Errors
///
/// If reading cached entries fails.
#[allow(clippy::too_many_lines)]
pub fn compute_plan(
    decls: &Declarations,
    prev_decls: Option<&Declarations>,
    catalog: &Catalog,
    pool: &[IntentSpec],
    train_cache: &PhrasingCache,
    heldout_cache: &PhrasingCache,
    cfg: &PlanConfig,
) -> Result<DeficitPlan> {
    let changes = prev_decls
        .map(|prev| classify_diff(prev, decls))
        .unwrap_or_default();

    let invalidated = changes.invalidated_keys();
    let renamed = changes.renamed_keys();
    let added = changes.added_keys();

    let train_passing = train_cache.passing_pool()?;
    let heldout_passing = heldout_cache.passing_pool()?;

    // Track unique meaning keys per scope and ensure held-out reservations never pull train below floor.
    let mut train_mk_rep: BTreeMap<String, &IntentSpec> = BTreeMap::new();
    let mut heldout_mk_rep: BTreeMap<String, &IntentSpec> = BTreeMap::new();
    let mut train_cell_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut all_unique_mks = BTreeSet::new();

    for spec in pool {
        all_unique_mks.insert(spec.meaning_key.clone());
        match CacheScope::of_split(spec.split) {
            CacheScope::Train => {
                train_mk_rep.entry(spec.meaning_key.clone()).or_insert(spec);
                if spec.split == Split::Train {
                    for c in &spec.covered_cells {
                        *train_cell_counts.entry(c.clone()).or_default() += 1;
                    }
                }
            }
            CacheScope::Heldout => {
                heldout_mk_rep
                    .entry(spec.meaning_key.clone())
                    .or_insert(spec);
            }
        }
    }

    // Minimal scaling check if 228 actions * floor requires more train sessions than nominal target.
    let train_specs_count = pool.iter().filter(|s| s.split == Split::Train).count();
    let (scaled_train_target, scaling_note) = if train_specs_count > cfg.train_target {
        (
            train_specs_count,
            Some(format!(
                "train scaled minimally from {} to {} sessions to guarantee floor>={} across {} live actions and {} kinds",
                cfg.train_target,
                train_specs_count,
                cfg.train_floor,
                decls.manifest_actions.len(),
                decls.kinds.len()
            )),
        )
    } else {
        (cfg.train_target, None)
    };

    let mut train_writer_prompts = Vec::new();
    let mut heldout_writer_prompts = Vec::new();
    let mut train_reader_items = Vec::new();
    let mut heldout_reader_items = Vec::new();
    let mut refresh_keys_count = 0;
    let mut invalidated_keys_count = 0;
    let mut targets_to_rebuild = 0;

    let styles = ["terse", "dictated", "typos", "long_polite", "correction"];
    let variants_wanted = cfg.variants_per_prompt.clamp(8, 10);

    // Helper: check if spec touches any meaning_key in a ChangeKind set (checking both current & previous decls).
    let touches = |spec: &IntentSpec, set: &BTreeSet<String>| -> bool {
        if set.contains(&spec.meaning_key)
            || spec
                .signature
                .field_meanings
                .iter()
                .any(|fm| set.contains(fm))
        {
            return true;
        }
        let check_decls = |d: &Declarations| -> bool {
            spec.covered_actions.iter().any(|a| {
                d.manifest_actions
                    .iter()
                    .find(|ma| format!("{}.{}", ma.app, ma.action) == *a)
                    .is_some_and(|ma| set.contains(&ma.meaning_key))
            }) || spec.covered_kind_fields.iter().any(|(k, f)| {
                d.kind(k)
                    .and_then(|kd| kd.fields.iter().find(|fd| fd.name == *f))
                    .is_some_and(|fd| set.contains(&fd.meaning_key))
            }) || spec.covered_tool_args.iter().any(|(t, a)| {
                d.tool(t)
                    .and_then(|td| td.args.iter().find(|ad| ad.name == *a))
                    .is_some_and(|ad| set.contains(&ad.meaning_key))
            })
        };
        check_decls(decls) || prev_decls.is_some_and(check_decls)
    };

    // Determine whether we are in incremental evolution mode (`prev_decls.is_some()`).
    let incremental = prev_decls.is_some();

    for (scope, reps, passing_map, writer_out, reader_out) in [
        (
            CacheScope::Train,
            &train_mk_rep,
            &train_passing,
            &mut train_writer_prompts,
            &mut train_reader_items,
        ),
        (
            CacheScope::Heldout,
            &heldout_mk_rep,
            &heldout_passing,
            &mut heldout_writer_prompts,
            &mut heldout_reader_items,
        ),
    ] {
        for (idx, (mk, spec)) in reps.iter().enumerate() {
            let is_invalidated = touches(spec, &invalidated);
            let is_renamed = touches(spec, &renamed);
            let is_added = touches(spec, &added);

            if is_invalidated {
                invalidated_keys_count += 1;
                // ChangedMeaning / Removed -> invalidated or turned into decline (0 new writer tokens).
                continue;
            }
            if is_renamed {
                targets_to_rebuild += 1;
            }

            let have_variants = passing_map.get(mk).map_or(0, Vec::len);
            let refresh =
                have_variants > 0 && is_deliberate_refresh(&cfg.version, mk, cfg.refresh_rate);
            if refresh {
                refresh_keys_count += 1;
            }

            let need_writer = if incremental {
                // Only added items (or deliberate refresh when no rename/changed_meaning) ask writer!
                (is_added && have_variants == 0) || (!is_renamed && refresh)
            } else {
                have_variants == 0 || refresh
            };

            if need_writer {
                let today_date = spec
                    .world
                    .today
                    .parse()
                    .unwrap_or_else(|_| jiff::civil::date(2026, 9, 27));
                let briefer = Briefer {
                    catalog,
                    today: today_date,
                };
                let turns: Vec<WriterTurnBrief> = spec
                    .scenario
                    .turns
                    .iter()
                    .enumerate()
                    .map(|(t_idx, turn)| {
                        let b = briefer.turn(turn, t_idx);
                        WriterTurnBrief {
                            turn: t_idx + 1,
                            ask: b.ask,
                            say_verbatim: b.spans,
                            how: b.how,
                        }
                    })
                    .collect();
                let style = styles[idx % styles.len()].to_owned();
                writer_out.push(WriterPromptItem {
                    meaning_key: mk.clone(),
                    intent_key: spec.intent_key.clone(),
                    scope,
                    style,
                    today: spec.world.today.clone(),
                    currency: spec.signature.currency.clone(),
                    variants_wanted,
                    turns,
                });
            } else if let Some(variants) = passing_map.get(mk) {
                for v in variants {
                    if v.reader_check == ReaderCheck::Pending {
                        reader_out.push(ReaderPromptItem {
                            meaning_key: mk.clone(),
                            variant_id: v.id.clone(),
                            scope,
                            today: spec.world.today.clone(),
                            messages: v.messages.clone(),
                            reason: "pending".to_owned(),
                        });
                    }
                }
            }
        }
    }

    Ok(DeficitPlan {
        version: cfg.version.clone(),
        changes,
        unique_meaning_keys_total: all_unique_mks.len(),
        unique_meaning_keys_train: train_mk_rep.len(),
        unique_meaning_keys_heldout: heldout_mk_rep.len(),
        passing_pool_train: train_passing.values().map(Vec::len).sum(),
        passing_pool_heldout: heldout_passing.values().map(Vec::len).sum(),
        refresh_keys_count,
        invalidated_keys_count,
        targets_to_rebuild,
        scaled_train_target,
        scaling_note,
        train_writer_prompts,
        heldout_writer_prompts,
        train_reader_items,
        heldout_reader_items,
        variants_per_prompt: variants_wanted,
    })
}

/// Export pending writer and selective reader batches for Phase D Hydrogen swarm subagents.
///
/// Strictly isolates `<out>/writer/train/` & `<out>/reader/train/` from `<out>/writer/heldout/`
/// & `<out>/reader/heldout/`.
///
/// # Errors
///
/// If writing batch files fails.
pub fn export_batches(plan: &DeficitPlan, out_dir: &Path, batch_size: usize) -> Result<usize> {
    let chunk = batch_size.max(1);
    let mut files_written = 0;

    for (scope_name, prompts) in [
        ("train", &plan.train_writer_prompts),
        ("heldout", &plan.heldout_writer_prompts),
    ] {
        let dir = out_dir.join("writer").join(scope_name);
        std::fs::create_dir_all(&dir)?;
        for (i, group) in prompts.chunks(chunk).enumerate() {
            let path = dir.join(format!("batch-{i:04}.json"));
            let payload = json!({
                "version": plan.version,
                "scope": scope_name,
                "prefix": WRITER_PREFIX,
                "variants_per_prompt": plan.variants_per_prompt,
                "prompts": group,
            });
            std::fs::write(path, serde_json::to_string_pretty(&payload)?)?;
            files_written += 1;
        }
    }

    for (scope_name, items) in [
        ("train", &plan.train_reader_items),
        ("heldout", &plan.heldout_reader_items),
    ] {
        let dir = out_dir.join("reader").join(scope_name);
        std::fs::create_dir_all(&dir)?;
        for (i, group) in items.chunks(chunk).enumerate() {
            let path = dir.join(format!("batch-{i:04}.json"));
            let payload = json!({
                "version": plan.version,
                "scope": scope_name,
                "items": group,
            });
            std::fs::write(path, serde_json::to_string_pretty(&payload)?)?;
            files_written += 1;
        }
    }

    Ok(files_written)
}

#[derive(Debug, Default, Serialize)]
pub struct ImportStats {
    pub imported_variants: usize,
    pub rejected_currency: usize,
    pub rejected_sealed: usize,
    pub rejected_oracle: usize,
    pub resolver_settled: usize,
    pub pending_reader: usize,
}

/// Import Hydrogen swarm writer/reader JSON answers into isolated `<cache>/train/` and
/// `<cache>/heldout/` stores, validating currency forms, sealed-value safety, ambiguity
/// resolver, and runtime oracle.
///
/// # Errors
///
/// If an answer file is invalid JSON or violates cache scope isolation.
#[allow(clippy::too_many_lines)]
pub fn import_batches(
    cache_root: &Path,
    answers_dir: &Path,
    catalog: &Catalog,
    pool: &[IntentSpec],
) -> Result<ImportStats> {
    let mut stats = ImportStats::default();
    let train_cache = PhrasingCache::open(cache_root, CacheScope::Train)?;
    let heldout_cache = PhrasingCache::open(cache_root, CacheScope::Heldout)?;
    let mut by_mk: BTreeMap<String, &IntentSpec> = BTreeMap::new();
    for spec in pool {
        by_mk.entry(spec.meaning_key.clone()).or_insert(spec);
    }

    let scratch = tempfile::tempdir()?;

    for (scope_name, scope, cache) in [
        ("train", CacheScope::Train, &train_cache),
        ("heldout", CacheScope::Heldout, &heldout_cache),
    ] {
        let writer_dir = answers_dir.join("writer").join(scope_name);
        if writer_dir.is_dir() {
            let mut files: Vec<_> = std::fs::read_dir(&writer_dir)?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|e| e == "json" || e == "jsonl"))
                .collect();
            files.sort();
            for path in files {
                let text = std::fs::read_to_string(&path)?;
                let val: Value = serde_json::from_str(&text)
                    .with_context(|| format!("invalid JSON in {}", path.display()))?;
                let writer_name = val["writer"].as_str().unwrap_or("swarm-writer").to_owned();
                for p in val["prompts"].as_array().into_iter().flatten() {
                    let Some(mk) = p["meaning_key"].as_str() else {
                        continue;
                    };
                    let Some(spec) = by_mk.get(mk) else {
                        continue;
                    };
                    if CacheScope::of_split(spec.split) != scope {
                        bail!(
                            "scope mismatch: meaning_key `{mk}` belongs to {:?}, found in {scope_name}",
                            CacheScope::of_split(spec.split)
                        );
                    }
                    let mut variants = Vec::new();
                    for raw_var in p["variants"].as_array().into_iter().flatten() {
                        let msgs: Vec<String> = if let Some(s) = raw_var.as_str() {
                            vec![s.to_owned()]
                        } else if let Some(arr) = raw_var.as_array() {
                            arr.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        } else {
                            continue;
                        };
                        if msgs.len() != spec.scenario.turns.len() {
                            continue;
                        }
                        if msgs.iter().any(|m| check_no_sealed(m).is_err()) {
                            stats.rejected_sealed += 1;
                            continue;
                        }
                        if let Some(curr) = &spec.signature.currency
                            && let Some(first_msg) = msgs.first()
                            && check_currency_message(first_msg, curr).is_err()
                        {
                            stats.rejected_currency += 1;
                            continue;
                        }
                        let oracle_ok = match replay_intent(spec, catalog, &msgs, scratch.path())? {
                            Ok(_) => true,
                            Err(_) => {
                                stats.rejected_oracle += 1;
                                false
                            }
                        };
                        if !oracle_ok {
                            continue;
                        }
                        let ambig = check_ambiguity_resolver(
                            &spec.world,
                            catalog,
                            &spec.target,
                            &msgs[0],
                            scratch.path(),
                        )?;
                        let (reader_check, reader) = match ambig {
                            AmbiguityVerdict::Unique => {
                                stats.resolver_settled += 1;
                                (ReaderCheck::ResolverSettled, None)
                            }
                            _ => {
                                stats.pending_reader += 1;
                                (ReaderCheck::Pending, None)
                            }
                        };
                        variants.push(CachedVariant {
                            id: variant_id(mk, &msgs),
                            messages: msgs,
                            style: p["style"].as_str().unwrap_or("terse").to_owned(),
                            writer: writer_name.clone(),
                            reader,
                            reader_check,
                            world_id: spec.world.id.clone(),
                            world_neighbourhood_hash: spec.world.neighbourhood_hash.clone(),
                            currency_ok: true,
                            oracle_ok: true,
                            status: VariantStatus::Passing,
                        });
                        stats.imported_variants += 1;
                    }
                    if !variants.is_empty() {
                        cache.put(CacheEntry {
                            meaning_key: mk.to_owned(),
                            brief_version: spec.signature.brief_version.clone(),
                            scope,
                            signature: spec.signature.clone(),
                            variants,
                        })?;
                    }
                }
            }
        }

        let reader_dir = answers_dir.join("reader").join(scope_name);
        if reader_dir.is_dir() {
            let mut files: Vec<_> = std::fs::read_dir(&reader_dir)?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|e| e == "json"))
                .collect();
            files.sort();
            for path in files {
                let text = std::fs::read_to_string(&path)?;
                let val: Value = serde_json::from_str(&text)?;
                let reader_name = val["reader"].as_str().unwrap_or("swarm-reader").to_owned();
                for item in val["items"].as_array().into_iter().flatten() {
                    let (Some(mk), Some(vid), Some(passed)) = (
                        item["meaning_key"].as_str(),
                        item["variant_id"].as_str(),
                        item["passed"].as_bool(),
                    ) else {
                        continue;
                    };
                    if let Some(mut entry) = cache.get(mk)? {
                        for v in &mut entry.variants {
                            if v.id == vid {
                                v.reader = Some(reader_name.clone());
                                v.reader_check = if passed {
                                    ReaderCheck::Passed
                                } else {
                                    ReaderCheck::Failed(
                                        item["reason"]
                                            .as_str()
                                            .unwrap_or("reader rejected")
                                            .to_owned(),
                                    )
                                };
                            }
                        }
                        cache.put(entry)?;
                    }
                }
            }
        }
    }

    Ok(stats)
}

/// Deterministic offline rehearsal populator for tests and dry-run pipeline verification
/// (never publishable).
///
/// # Errors
///
/// If writing to the cache fails.
pub fn populate_rehearsal(
    pool: &[IntentSpec],
    catalog: &Catalog,
    train_cache: &PhrasingCache,
    heldout_cache: &PhrasingCache,
) -> Result<usize> {
    let mut written = 0;
    let mut seen = BTreeSet::new();
    for spec in pool {
        if !seen.insert((CacheScope::of_split(spec.split), spec.meaning_key.clone())) {
            continue;
        }
        let scope = CacheScope::of_split(spec.split);
        let cache = match scope {
            CacheScope::Train => train_cache,
            CacheScope::Heldout => heldout_cache,
        };
        if cache
            .get(&spec.meaning_key)?
            .is_some_and(|e| !e.variants.is_empty())
        {
            continue;
        }
        let today = spec
            .world
            .today
            .parse()
            .unwrap_or_else(|_| jiff::civil::date(2026, 9, 27));
        let briefer = Briefer { catalog, today };
        let messages: Vec<String> = spec
            .scenario
            .turns
            .iter()
            .enumerate()
            .map(|(i, turn)| {
                let b = briefer.turn(turn, i);
                let mut msg = b.ask;
                if let Some(curr) = &spec.signature.currency {
                    let suffix = match curr.as_str() {
                        "INR" => " in INR",
                        "USD" => " in USD",
                        "EUR" => " in EUR",
                        "GBP" => " in GBP",
                        "AED" => " in AED",
                        "SGD" => " in SGD",
                        _ => "",
                    };
                    if !suffix.is_empty() && check_currency_message(&msg, curr).is_err() {
                        msg.push_str(suffix);
                    }
                }
                for s in &b.spans {
                    if !msg.to_lowercase().contains(&s.to_lowercase()) {
                        msg.push(' ');
                        msg.push_str(s);
                    }
                }
                msg
            })
            .collect();
        let entry = CacheEntry {
            meaning_key: spec.meaning_key.clone(),
            brief_version: spec.signature.brief_version.clone(),
            scope,
            signature: spec.signature.clone(),
            variants: vec![CachedVariant {
                id: variant_id(&spec.meaning_key, &messages),
                messages,
                style: "terse".to_owned(),
                writer: "rehearsal-writer".to_owned(),
                reader: Some("rehearsal-reader".to_owned()),
                reader_check: ReaderCheck::Passed,
                world_id: spec.world.id.clone(),
                world_neighbourhood_hash: spec.world.neighbourhood_hash.clone(),
                currency_ok: true,
                oracle_ok: true,
                status: VariantStatus::Passing,
            }],
        };
        cache.put(entry)?;
        written += 1;
    }
    Ok(written)
}
