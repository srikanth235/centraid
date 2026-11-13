//! RECORDS FROM ROLLOUTS: RFT records from the passing ones.
//!
//! The records are in the data version's record shape (`id, world, today, me, tags, turns[{user, gold, ref, tags}]`, then
//! `render`), so the trainer reads them as it reads `train.jsonl.zst`. What differs from a datagen record is the
//! turns' assistant side: a datagen turn's `ref` is the reference calls; here `ref` is **the calls the model made**
//! and `said` is **the messages it wrote** (think and call, as decoded). A renderer renders `said` when a turn has it
//! and `ref` otherwise. An RFT record is cut after its passing prefix.
//!
//! `render` comes from a [`RenderRecord`], the data version's renderer (M4), which this crate cannot link (`datagen`
//! depends on it): `datagen rollout-records` supplies it and calls [`cut`]. `assist-eval rollout-records` has none, so
//! its records are written without `render` and cannot be trained on.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::Rollout;
use crate::args::ArgClass;
use crate::gold::{Accept, RefCall, Session};

/// A record rendered: the tokens the trainer reads, the weight of each, and the text they came from.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rendered {
    pub input_ids: Vec<u32>,
    pub weights: Vec<f32>,
    pub text: String,
}

/// The data version's renderer. `datagen` implements it over its M4 render module (`centraid_datagen::rollout`); this
/// crate never renders.
pub trait RenderRecord {
    /// Render a record the way the data version renders its sessions.
    ///
    /// # Errors
    /// The renderer's words when the record cannot be rendered.
    fn render(&self, record: &Record) -> Result<Rendered, String>;
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordTurn {
    pub user: String,
    pub gold: Vec<Accept>,
    /// The calls the model made this turn.
    #[serde(rename = "ref")]
    pub reference: Vec<RefCall>,
    pub tags: Vec<String>,
    /// The messages the model wrote this turn, one per step.
    pub said: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Record {
    pub id: String,
    pub world: String,
    pub today: String,
    pub me: String,
    pub tags: Vec<String>,
    pub turns: Vec<RecordTurn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render: Option<Rendered>,
}

/// An RFT line: a record, and how much it should count.
#[derive(Debug, Clone, Serialize)]
pub struct RftRecord {
    #[serde(flatten)]
    pub record: Record,
    /// The sampling weight: 1 for a record from a cell the model passes, more toward what it still fails.
    pub weight: f64,
    /// The copies of the line written to the file (the weight rounded, at least 1 and at most `max_copies`). A
    /// trainer that samples by `weight` should read the file with `copies` ignored, one line each.
    pub copies: usize,
    /// The grid cells of the record's turns.
    pub cells: Vec<String>,
}

fn call_of(value: &Value) -> Option<RefCall> {
    Some(RefCall {
        tool: value["tool"].as_str()?.to_owned(),
        args: value["args"].as_object().cloned().unwrap_or_default(),
        bad: false,
    })
}

/// The record of a rollout cut after `upto` turns, its turns' assistant side being what the model did. The session is
/// the source's: it supplies the user's words and gold, which a result does not keep.
fn record_of(session: &Session, rollout: &Rollout, upto: usize, id: String) -> Record {
    let turns = session
        .turns
        .iter()
        .zip(&rollout.result.turns)
        .take(upto)
        .map(|(turn, result)| RecordTurn {
            user: turn.user.clone(),
            gold: turn.gold.clone(),
            reference: result.calls.iter().filter_map(call_of).collect(),
            tags: turn.tags.clone(),
            said: result.said.clone(),
        })
        .collect();
    Record {
        id,
        world: session.world.clone(),
        today: session.today.clone(),
        me: session.me.clone(),
        tags: session.tags.clone(),
        turns,
        render: None,
    }
}

// ---------------------------------------------------------------------------------------------------- what to weigh

/// What the model still fails, read from a report: fail rate per grid cell or tag and per argument class. Cells the
/// report does not name count as passed.
#[derive(Debug, Clone, Default)]
pub struct Needs {
    /// Cell (`tool/kind/verb`) or tag → fail rate.
    pub cells: BTreeMap<String, f64>,
    /// `rows`, `date`, `filters`, `amount` → fail rate.
    pub arguments: BTreeMap<String, f64>,
}

impl Needs {
    /// Read a report file ([`Self::from_report`]).
    ///
    /// # Errors
    /// [`crate::EvalError::Read`] when the file cannot be read, [`crate::EvalError::Json`] when it is not JSON.
    pub fn read(path: &std::path::Path, min_samples: usize) -> Result<Self, crate::EvalError> {
        let name = path.display().to_string();
        let text = std::fs::read_to_string(path).map_err(|e| crate::EvalError::Read {
            path: name.clone(),
            message: e.to_string(),
        })?;
        let report = serde_json::from_str(&text).map_err(|e| crate::EvalError::Json {
            what: name,
            message: e.to_string(),
        })?;
        Ok(Self::from_report(&report, min_samples))
    }

    /// Read the needs out of a report: a rollout report (`by_cell`, `by_tag`, `arguments`) or an `assist-eval`
    /// report (`by_tag`, `arguments`). An entry with fewer than `min_samples` samples is left out: a rate over two
    /// turns steers nothing.
    #[must_use]
    pub fn from_report(report: &Value, min_samples: usize) -> Self {
        let mut needs = Self::default();
        for section in ["by_cell", "by_tag"] {
            for (name, entry) in report[section].as_object().into_iter().flatten() {
                // a rollout report nests the rate (`{rate: {k, n, rate}}`); an eval report is the rate itself
                let rate = if entry["rate"].is_object() {
                    &entry["rate"]
                } else {
                    entry
                };
                let n = rate["n"].as_u64().unwrap_or(0);
                if let Some(value) = rate["rate"].as_f64()
                    && usize::try_from(n).is_ok_and(|n| n >= min_samples)
                {
                    needs.cells.insert(name.clone(), 1.0 - value);
                }
            }
        }
        for (name, entry) in report["arguments"].as_object().into_iter().flatten() {
            let scored = entry["scored"].as_u64().unwrap_or(0);
            if let Some(value) = entry["rate"].as_f64()
                && usize::try_from(scored).is_ok_and(|n| n >= min_samples)
            {
                needs.arguments.insert(name.clone(), 1.0 - value);
            }
        }
        needs
    }
}

/// How the weight is made: `1 + cell_gain * (the worst fail rate among the turn's cell and tags) + arg_gain * (the
/// mean fail rate of the argument classes the turn states)`. A record's weight is the largest of its turns' (one hard
/// turn is the reason to keep it). With no needs every weight is 1.
#[derive(Debug, Clone, Copy)]
pub struct Weighing {
    pub cell_gain: f64,
    pub arg_gain: f64,
    pub max_copies: usize,
}

impl Default for Weighing {
    fn default() -> Self {
        Self {
            cell_gain: 2.0,
            arg_gain: 2.0,
            max_copies: 4,
        }
    }
}

fn turn_weight(
    turn: &crate::run::TurnResult,
    session_tags: &[String],
    needs: &Needs,
    how: Weighing,
) -> f64 {
    let cell = std::iter::once(&turn.cell)
        .chain(&turn.tags)
        .chain(session_tags)
        .filter_map(|k| needs.cells.get(k))
        .copied()
        .fold(0.0_f64, f64::max);
    let stated: Vec<f64> = ArgClass::ALL
        .iter()
        .filter(|c| turn.args.get(c.word()).is_some_and(|v| v != "absent"))
        .filter_map(|c| needs.arguments.get(c.word()))
        .copied()
        .collect();
    let arg = if stated.is_empty() {
        0.0
    } else {
        stated.iter().sum::<f64>() / stated.len() as f64
    };
    1.0 + how.cell_gain * cell + how.arg_gain * arg
}

// ------------------------------------------------------------------------------------------------------------- RFT

/// What a records run left out, and why.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RecordStats {
    pub rollouts: usize,
    /// RFT: rollouts that failed their first turn (nothing to keep).
    pub rft_nothing_passed: usize,
    /// RFT: rollouts whose kept turns repeat another sample's messages.
    pub rft_duplicates: usize,
    pub rft_records: usize,
    pub rft_lines: usize,
}

fn by_session(rollouts: &[Rollout]) -> BTreeMap<&str, Vec<&Rollout>> {
    let mut out: BTreeMap<&str, Vec<&Rollout>> = BTreeMap::new();
    for rollout in rollouts {
        out.entry(rollout.result.id.as_str())
            .or_default()
            .push(rollout);
    }
    out
}

/// Training records are cut from train sessions only. A val, test or noise session in the set is refused, whatever
/// the command (`assist-eval rollout-records`, `datagen rollout-records`), before anything is written.
///
/// # Errors
/// [`crate::EvalError::Data`] naming the splits and the first sessions.
pub fn refuse_held_out(sessions: &[Session]) -> Result<(), crate::EvalError> {
    let held: Vec<&Session> = sessions.iter().filter(|s| s.is_held_out()).collect();
    if held.is_empty() {
        return Ok(());
    }
    let splits: BTreeSet<&str> = held.iter().filter_map(|s| s.split.as_deref()).collect();
    let first: Vec<&str> = held.iter().take(3).map(|s| s.id.as_str()).collect();
    Err(crate::EvalError::Data(format!(
        "refusing to cut training records from held-out data: {} session(s) of the {} split (first: {}). \
         Records are cut from the train split only",
        held.len(),
        splits.into_iter().collect::<Vec<_>>().join("/"),
        first.join(", ")
    )))
}

/// RFT records: each rollout's passing prefix (every turn before its first failure, or all of them), deduplicated
/// among a session's samples by the messages, weighted by [`Weighing`]. A rollout the engine failed in keeps the
/// turns that ran and passed.
#[must_use]
pub fn rft_records(
    sessions: &[Session],
    rollouts: &[Rollout],
    needs: &Needs,
    how: Weighing,
    stats: &mut RecordStats,
) -> Vec<RftRecord> {
    let sessions: BTreeMap<&str, &Session> = sessions.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut out = Vec::new();
    for (id, group) in by_session(rollouts) {
        let Some(session) = sessions.get(id) else {
            continue;
        };
        let mut seen: BTreeSet<Vec<Vec<String>>> = BTreeSet::new();
        for rollout in group {
            stats.rollouts += 1;
            let kept = rollout
                .result
                .turns
                .iter()
                .take_while(|t| t.run && t.pass)
                .count();
            if kept == 0 {
                stats.rft_nothing_passed += 1;
                continue;
            }
            let said: Vec<Vec<String>> = rollout.result.turns[..kept]
                .iter()
                .map(|t| t.said.clone())
                .collect();
            if !seen.insert(said) {
                stats.rft_duplicates += 1;
                continue;
            }
            let weight = rollout.result.turns[..kept]
                .iter()
                .map(|t| turn_weight(t, &session.tags, needs, how))
                .fold(1.0_f64, f64::max);
            let copies = (weight.round() as usize).clamp(1, how.max_copies.max(1));
            let cells: Vec<String> = rollout.result.turns[..kept]
                .iter()
                .map(|t| t.cell.clone())
                .collect();
            for copy in 0..copies {
                let name = if copy == 0 {
                    format!("{id}~s{}", rollout.sample)
                } else {
                    format!("{id}~s{}~d{copy}", rollout.sample)
                };
                out.push(RftRecord {
                    record: record_of(session, rollout, kept, name),
                    weight,
                    copies,
                    cells: cells.clone(),
                });
            }
            stats.rft_records += 1;
            stats.rft_lines += copies;
        }
    }
    out
}

/// Render every record in place with `renderer`; a record the renderer refuses is an error naming it, since a
/// trainer must not meet a half-rendered file.
///
/// # Errors
/// The id of the record and the renderer's words.
pub fn render_all(renderer: &dyn RenderRecord, rft: &mut [RftRecord]) -> Result<(), String> {
    let one = |record: &mut Record| {
        renderer
            .render(record)
            .map(|rendered| record.render = Some(rendered))
            .map_err(|e| format!("{}: {e}", record.id))
    };
    rft.iter_mut().try_for_each(|r| one(&mut r.record))
}

/// How [`cut`] turns rollouts into records.
#[derive(Debug, Clone, Copy)]
pub struct Cutting<'a> {
    pub needs: &'a Needs,
    pub weighing: Weighing,
}

/// Cut the RFT records of `rollouts` over `sessions`, render them with `renderer` when there is one, and write
/// `rft.jsonl` and `stats.json` under `out`.
///
/// # Errors
/// [`EvalError::Data`] with the id of a record the renderer refuses (nothing is written then), and
/// [`EvalError::Read`] when a file cannot be written.
pub fn cut(
    sessions: &[Session],
    rollouts: &[Rollout],
    how: &Cutting<'_>,
    renderer: Option<&dyn RenderRecord>,
    out: &std::path::Path,
) -> Result<RecordStats, crate::EvalError> {
    refuse_held_out(sessions)?;
    let mut stats = RecordStats::default();
    let mut rft = rft_records(sessions, rollouts, how.needs, how.weighing, &mut stats);
    if let Some(renderer) = renderer {
        render_all(renderer, &mut rft).map_err(crate::EvalError::Data)?;
    }
    let write = |name: &str, lines: Vec<String>| -> Result<(), crate::EvalError> {
        let path = out.join(name);
        let mut text = lines.join("\n");
        if !text.is_empty() {
            text.push('\n');
        }
        std::fs::write(&path, text).map_err(|e| crate::EvalError::Read {
            path: path.display().to_string(),
            message: e.to_string(),
        })
    };
    std::fs::create_dir_all(out).map_err(|e| crate::EvalError::Read {
        path: out.display().to_string(),
        message: e.to_string(),
    })?;
    let json = |e: serde_json::Error| crate::EvalError::Json {
        what: "a record".to_owned(),
        message: e.to_string(),
    };
    write(
        "rft.jsonl",
        rft.iter()
            .map(|r| serde_json::to_string(r).map_err(json))
            .collect::<Result<_, _>>()?,
    )?;
    write(
        "stats.json",
        vec![serde_json::to_string_pretty(&stats).map_err(json)?],
    )?;
    Ok(stats)
}
