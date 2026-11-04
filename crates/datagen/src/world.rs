//! STAGE 1, THE WORLD: one made-up person's whole vault as a seed document, a pure function of
//! a [`WorldSpec`]. The document is the vocabulary of `centraid_nativetools::seed`, so a world
//! seeds into a real vault through the vault's typed commands and the `centraid-assist`
//! runtime reads it back like any other.

use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;

use crate::persona::Persona;
use crate::rng::Rng;
use crate::settings::{Settings, Split};

/// `(seed document section, catalog kind)` for every section whose rows are named by `name`.
pub const NAMED_SECTIONS: &[(&str, &str)] = &[
    ("people", "person"),
    ("lists", "list"),
    ("events", "event"),
    ("tasks", "task"),
    ("notebooks", "notebook"),
    ("notes", "note"),
    ("folders", "folder"),
    ("documents", "document"),
    ("albums", "album"),
    ("photos", "photo"),
    ("locker", "locker item"),
    ("accounts", "account"),
    ("transactions", "transaction"),
];

/// Everything that decides a world. Two equal specs make equal worlds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct WorldSpec {
    pub split: Split,
    /// Position within the split.
    pub index: usize,
    pub seed: u64,
}

impl WorldSpec {
    /// The id the world is filed under: `train-07`.
    #[must_use]
    pub fn id(&self) -> String {
        format!("{}-{:02}", self.split.name(), self.index)
    }
}

/// The worlds of a run: `Split::first_run_count` per split, each seed drawn from `master` and the
/// world's place, so a seed belongs to exactly one split and a split can grow without moving the
/// others.
#[must_use]
pub fn plan(master: u64) -> Vec<WorldSpec> {
    plan_sized(master, |split| split.first_run_count())
}

/// [`plan`] with a count per split.
#[must_use]
pub fn plan_sized(master: u64, count: impl Fn(Split) -> usize) -> Vec<WorldSpec> {
    let root = Rng::new(master);
    let mut specs = Vec::new();
    for split in Split::ALL {
        for index in 0..count(split) {
            let seed = root
                .fork(&format!("world:{}:{index}", split.name()))
                .next_u64();
            specs.push(WorldSpec { split, index, seed });
        }
    }
    specs
}

#[derive(Debug, Clone, PartialEq)]
pub struct World {
    pub spec: WorldSpec,
    pub persona: Persona,
    pub settings: Settings,
    /// The civil day sessions on this world run.
    pub today: String,
    /// The seed document with Locker rows in their presence-only form (`"sealed": ["password"]`,
    /// never a value).
    pub doc: Value,
}

impl World {
    /// Make the world of `spec` with the settings the spec's place gives it.
    #[must_use]
    pub fn generate(spec: WorldSpec) -> Self {
        let rng = Rng::new(spec.seed);
        let settings = Settings::for_world(spec.index, &mut rng.fork("settings"));
        Self::generate_with(spec, settings)
    }

    /// Make the world of `spec` under explicit `settings`.
    #[must_use]
    pub fn generate_with(spec: WorldSpec, settings: Settings) -> Self {
        crate::generate::build(spec, settings)
    }

    #[must_use]
    pub fn id(&self) -> String {
        self.spec.id()
    }

    /// Rows per seed-document section.
    #[must_use]
    pub fn section_counts(&self) -> Vec<(String, usize)> {
        self.doc
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(key, value)| value.as_array().map(|rows| (key.clone(), rows.len())))
            .collect()
    }

    /// The document `centraid_nativetools::seed` reads: each presence marker becomes a
    /// deterministic placeholder secret, so a vault holds a sealed value to reveal while no
    /// document, prompt or record the pipeline writes ever does.
    #[must_use]
    pub fn seed_document(&self) -> Value {
        let mut doc = self.doc.clone();
        if let Some(rows) = doc.get_mut("locker").and_then(Value::as_array_mut) {
            for row in rows {
                let key = row["key"].as_str().unwrap_or_default().to_owned();
                let sealed: Vec<String> = row
                    .get("sealed")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|field| field.as_str().map(str::to_owned))
                    .collect();
                if let Some(object) = row.as_object_mut() {
                    object.remove("sealed");
                    for field in sealed {
                        object.insert(
                            field.clone(),
                            Value::String(format!("placeholder:{key}:{field}")),
                        );
                    }
                }
            }
        }
        doc
    }

    /// Seed the world into a fresh vault at `path`; the answer is every key's kind and id.
    ///
    /// # Errors
    ///
    /// If the vault refuses a command; the message names it.
    pub fn seed_into(&self, path: &Path) -> Result<Value> {
        centraid_nativetools::seed::seed(&self.seed_document(), path)
            .map_err(anyhow::Error::msg)
            .with_context(|| format!("seeding world {}", self.id()))
    }
}
