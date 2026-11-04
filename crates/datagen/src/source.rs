//! THE SESSIONS AS AN EVAL SOURCE: `assist-eval` reads a datagen run through [`DatagenSource`], so
//! a set made here plugs straight into the eval with no converter.
//!
//! A record is a line of `<dir>/sessions.jsonl`: the fields of `assist_eval::gold::Session` (`id`,
//! `world`, `today`, `me`, `tags`, `turns[{user, gold, ref, tags}]`) plus the typed `scenario`
//! beside them for M3, and a `constraints` count on each turn. The eval ignores what it does not
//! read. Each turn's `user` is a placeholder (see [`crate::plan::placeholder`]) until M3 writes
//! the message. A world is read from `<dir>/worlds/<id>.json` (presence-only) and handed over with
//! its sealed placeholders put back in memory, so the vault the eval seeds is the one gold was
//! recorded against; the placeholder document is never written to disk.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};
use centraid_assist_eval::EvalError;
use centraid_assist_eval::gold::Session;
use centraid_assist_eval::source::EvalSource;
use serde_json::Value;

use crate::settings::Split;
use crate::world::seed_document_of;

/// The file a run writes its sessions to, in each split's directory.
pub const SESSIONS: &str = "sessions.jsonl";

/// The directory of world documents (presence-only: a sealed value is never written).
pub const WORLDS: &str = "worlds";

pub struct DatagenSource {
    label: String,
    records: Vec<Value>,
    /// Presence-only world documents by id.
    worlds: BTreeMap<String, Value>,
}

impl DatagenSource {
    #[must_use]
    pub fn new(
        label: impl Into<String>,
        records: Vec<Value>,
        worlds: BTreeMap<String, Value>,
    ) -> Self {
        Self {
            label: label.into(),
            records,
            worlds,
        }
    }

    /// Open a run written by `datagen intents`: every `<split>/sessions.jsonl` under `dir`
    /// (`split` limits it to one) and the world documents under `<dir>/worlds/`.
    ///
    /// # Errors
    ///
    /// If a sessions file or a world cannot be read.
    pub fn open(dir: &Path, split: Option<Split>) -> Result<Self> {
        let mut records = Vec::new();
        let mut worlds = BTreeMap::new();
        for s in Split::ALL
            .into_iter()
            .filter(|s| split.is_none_or(|w| w == *s))
        {
            let path = dir.join(s.name()).join(SESSIONS);
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                let record: Value = serde_json::from_str(line)?;
                let id = record["world"].as_str().unwrap_or_default().to_owned();
                if let std::collections::btree_map::Entry::Vacant(slot) = worlds.entry(id.clone()) {
                    let file = dir.join(WORLDS).join(format!("{id}.json"));
                    let text = std::fs::read_to_string(&file)
                        .with_context(|| file.display().to_string())?;
                    slot.insert(serde_json::from_str(&text)?);
                }
                records.push(record);
            }
        }
        Ok(Self {
            label: dir.display().to_string(),
            records,
            worlds,
        })
    }
}

impl EvalSource for DatagenSource {
    fn label(&self) -> String {
        self.label.clone()
    }

    fn sessions(&self) -> Result<Vec<Session>, EvalError> {
        self.records
            .iter()
            .enumerate()
            .map(|(i, record)| {
                serde_json::from_value(record.clone()).map_err(|error| EvalError::Json {
                    what: format!("{} record {}", self.label, i + 1),
                    message: error.to_string(),
                })
            })
            .collect()
    }

    fn world(&self, name: &str) -> Result<Value, EvalError> {
        self.worlds
            .get(name)
            .map(seed_document_of)
            .ok_or_else(|| EvalError::Read {
                path: name.to_owned(),
                message: "no such world in the run".to_owned(),
            })
    }
}
