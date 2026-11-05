//! M7's RFT records and DPO pairs, rendered by M4's renderer.
//!
//! `assist-eval` cuts the records of a model's rollouts ([`centraid_assist_eval::rollout::records`]) but cannot render
//! them: this crate depends on it. [`Renderer`] is the [`RenderRecord`] it asks for, so a rollout record carries
//! `render {input_ids, weights, text}` exactly as a data-version record does, and the trainer reads nothing else.
//!
//! What a rollout record holds on each turn is what the model said (`said`), not a reference call, so nothing is
//! traced: the messages are replayed through the runtime, on the world's vault the record names, as the eval ran them
//! (the user's message and its block, each message the model wrote, the runtime's answer to it), and
//! [`Log::transcript`] renders the conversation the model saw with `transcript.rs`, as for a session. The loss mask is
//! the data version's: weight 1 on every token of an assistant message (the think, `</think>`, the call,
//! `<|im_end|>`), [`DECISION_WEIGHT`](crate::render::DECISION_WEIGHT) on the deciding tokens inside it
//! ([`render::decisions`](crate::render::decisions)), 0 elsewhere, and 0 on a message the runtime refused: the model
//! is shown how a refusal is repaired, not taught to cause one.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use centraid_assist::native_turn::log::Log;
use centraid_assist_eval::rollout::records::{Record, RenderRecord, Rendered};
use serde_json::Value;

use crate::catalog::Catalog;
use crate::plan::WorldRun;
use crate::render::{Tokenizer, weights};
use crate::source::WORLDS;
use crate::world::World;

/// Read the worlds a data version holds (`<dir>/worlds/<id>.json`) for the sessions named by `ids`.
///
/// # Errors
///
/// If a world document cannot be read or is not a world.
pub fn read_worlds<'a>(
    dir: &Path,
    ids: impl IntoIterator<Item = &'a str>,
) -> Result<BTreeMap<String, World>> {
    let mut worlds = BTreeMap::new();
    for id in ids {
        if worlds.contains_key(id) {
            continue;
        }
        let file = dir.join(WORLDS).join(format!("{id}.json"));
        let text = std::fs::read_to_string(&file).with_context(|| file.display().to_string())?;
        let doc: Value = serde_json::from_str(&text).with_context(|| file.display().to_string())?;
        worlds.insert(
            id.to_owned(),
            World::from_doc(&doc).with_context(|| file.display().to_string())?,
        );
    }
    Ok(worlds)
}

/// The data version's renderer for rollout records. A world is seeded once, the first time one of its records is
/// rendered, and every record runs on a private copy of its vault.
pub struct Renderer<'a> {
    catalog: &'a Catalog,
    worlds: &'a BTreeMap<String, World>,
    tokenizer: &'a Tokenizer,
    decision: f32,
    scratch: PathBuf,
    runs: RefCell<BTreeMap<String, WorldRun<'a>>>,
}

impl<'a> Renderer<'a> {
    /// `scratch` is where worlds are seeded and vaults copied; it must exist and outlive the renderer.
    #[must_use]
    pub fn new(
        catalog: &'a Catalog,
        worlds: &'a BTreeMap<String, World>,
        tokenizer: &'a Tokenizer,
        decision: f32,
        scratch: &Path,
    ) -> Self {
        Self {
            catalog,
            worlds,
            tokenizer,
            decision,
            scratch: scratch.to_path_buf(),
            runs: RefCell::new(BTreeMap::new()),
        }
    }

    /// Render one record, with the error as an [`anyhow::Error`].
    ///
    /// # Errors
    ///
    /// As [`render_said`], and if the record's world was not read or will not seed.
    pub fn render_one(&self, record: &Record) -> Result<Rendered> {
        let world = self
            .worlds
            .get(&record.world)
            .ok_or_else(|| anyhow!("the world {} was not read", record.world))?;
        let mut runs = self.runs.borrow_mut();
        if !runs.contains_key(&record.world) {
            let run = WorldRun::seed(world, self.catalog, &self.scratch)
                .with_context(|| format!("seeding {}", record.world))?;
            runs.insert(record.world.clone(), run);
        }
        let run = runs
            .get_mut(&record.world)
            .ok_or_else(|| anyhow!("world run"))?;
        render_said(run, record, self.tokenizer, self.decision)
    }
}

impl RenderRecord for Renderer<'_> {
    fn render(&self, record: &Record) -> Result<Rendered, String> {
        self.render_one(record).map_err(|e| format!("{e:#}"))
    }
}

/// Render one rollout record on its world.
///
/// # Errors
///
/// If the record has a turn with no message of the model's that the runtime did not end itself, its `today` is not the
/// world's day (the messages were written for another date), or the tokenizer fails.
pub fn render_said(
    run: &mut WorldRun<'_>,
    record: &Record,
    tokenizer: &Tokenizer,
    decision: f32,
) -> Result<Rendered> {
    if record.today.get(..10) != run.today_at.get(..10) {
        bail!(
            "the record's day {} is not the world's {}",
            record.today,
            run.today_at
        );
    }
    let mut live = run.open()?;
    let system = live.session.prompt()["rendered"]
        .as_str()
        .context("the runtime has no system turn")?
        .to_owned();
    let mut log = Log::new(system);
    let mut masked: Vec<bool> = Vec::new();
    for (t, turn) in record.turns.iter().enumerate() {
        let said = live.session.user(&turn.user);
        log.compact(&said["compacted"]);
        log.user(&turn.user, said["block"].as_str());
        // A retraction ends the turn in the runtime before any message is asked of the model.
        let retracted = said.get("ended").is_some_and(Value::is_object);
        if turn.said.is_empty() && !retracted {
            bail!("turn {t} has no message of the model's to render");
        }
        for message in turn.said.iter().filter(|_| !retracted) {
            let reply = live.session.call_text(message);
            log.assistant(message);
            log.tool(
                reply["obs"].as_u64().and_then(|n| usize::try_from(n).ok()),
                reply["text"].as_str().unwrap_or_default(),
            );
            masked.push(reply["effect"].get("error").is_some());
        }
    }
    let rendered = log.transcript().map_err(|error| anyhow!("{error}"))?;
    let spans = rendered.byte_spans();
    let (ids, offsets) = tokenizer.encode(&rendered.text)?;
    let w = weights(&rendered.text, &spans, &masked, &offsets, decision);
    if w.len() != ids.len() || spans.len() != masked.len() {
        bail!(
            "{} weights for {} tokens, {} messages for {} spans",
            w.len(),
            ids.len(),
            masked.len(),
            spans.len()
        );
    }
    Ok(Rendered {
        input_ids: ids,
        weights: w,
        text: rendered.text,
    })
}
