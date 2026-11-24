//! PART 2 (CORE STRUCT), THE WORLD: presence-only seed document wrapper and split definitions.
//!
//! Fixture worlds are constructed by [`crate::fixture_world`] as minimal deterministic vaults
//! (referenced rows + look-alike distractors, never a whole-vault copy). Locker rows carry
//! presence-only `"sealed": [...]` markers on disk; [`seed_document_of`] swaps them for
//! deterministic in-memory placeholders when seeding into SQLite.

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Which side of the train / val / test split a fixture world falls on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Split {
    Train,
    Val,
    Test,
}

impl Split {
    pub const ALL: [Self; 3] = [Self::Train, Self::Val, Self::Test];

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Train => "train",
            Self::Val => "val",
            Self::Test => "test",
        }
    }

    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|split| split.name() == s)
    }

    /// Whether this split is held out from training (`test`).
    #[must_use]
    pub const fn is_heldout(self) -> bool {
        matches!(self, Self::Test)
    }
}

/// `(seed document section, catalog kind)` for every section whose rows are named by `name`.
pub const NAMED_SECTIONS: &[(&str, &str)] = &[
    ("people", "person"),
    ("lists", "list"),
    ("calendars", "calendar"),
    ("people_lists", "people list"),
    ("sections", "section"),
    ("places", "place"),
    ("events", "event"),
    ("important_dates", "important date"),
    ("tasks", "task"),
    ("gifts", "gift"),
    ("notebooks", "notebook"),
    ("notes", "note"),
    ("journal_entries", "journal entry"),
    ("folders", "folder"),
    ("documents", "document"),
    ("albums", "album"),
    ("photos", "photo"),
    ("locker", "locker item"),
    ("locker_fields", "locker field"),
    ("locker_passkeys", "locker passkey"),
    ("contact_points", "contact point"),
    ("accounts", "account"),
    ("transactions", "transaction"),
    ("categories", "category"),
    ("rules", "rule"),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Persona {
    pub me: String,
    pub currency: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorldSpec {
    pub split: Split,
    pub index: usize,
    pub seed: u64,
}

impl WorldSpec {
    #[must_use]
    pub fn id(&self) -> String {
        format!("w-{}-{:04x}", self.split.name(), self.seed & 0xffff)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct World {
    pub id: String,
    pub split: Split,
    pub seed: u64,
    pub persona: Persona,
    /// Civil day (`YYYY-MM-DD`) sessions on this fixture world run on.
    pub today: String,
    /// Presence-only seed document (Locker rows use `"sealed": [...]`, never secret values).
    pub doc: Value,
    /// Hash of the rows/names/distractors in this world's neighbourhood (for ambiguity re-check).
    pub neighbourhood_hash: String,
}

impl World {
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Reconstruct a [`World`] from a presence-only JSON document on disk.
    ///
    /// # Errors
    ///
    /// If the document lacks `seed`, `me`, or `today`.
    pub fn from_doc(doc: &Value) -> Result<Self> {
        let id = doc["seed"]
            .as_str()
            .context("a world document has no `seed`")?
            .to_owned();
        let split = if id.contains("test") {
            Split::Test
        } else if id.contains("val") {
            Split::Val
        } else {
            Split::Train
        };
        let me = doc["me"]
            .as_str()
            .context("a world document has no `me`")?
            .to_owned();
        let today = doc["today"]
            .as_str()
            .context("a world document has no `today`")?
            .to_owned();
        let currency = doc["currency"].as_str().unwrap_or("INR").to_owned();
        let neighbourhood_hash = neighbourhood_hash_of(doc);
        Ok(Self {
            id,
            split,
            seed: 0,
            persona: Persona { me, currency },
            today,
            doc: doc.clone(),
            neighbourhood_hash,
        })
    }

    #[must_use]
    pub fn section_counts(&self) -> Vec<(String, usize)> {
        self.doc
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(k, v)| v.as_array().map(|rows| (k.clone(), rows.len())))
            .collect()
    }

    /// In-memory seed document with `"sealed"` markers swapped for deterministic placeholders.
    #[must_use]
    pub fn seed_document(&self) -> Value {
        seed_document_of(&self.doc)
    }

    /// Seed this fixture world into a fresh vault at `path`.
    ///
    /// # Errors
    ///
    /// If the vault seeder refuses a command.
    pub fn seed_into(&self, path: &Path) -> Result<Value> {
        centraid_nativetools::seed::seed(&self.seed_document(), path)
            .map_err(anyhow::Error::msg)
            .with_context(|| format!("seeding fixture world {}", self.id))
    }
}

/// Compute a deterministic hash over the rows, names, and currencies in a world document.
#[must_use]
pub fn neighbourhood_hash_of(doc: &Value) -> String {
    let bytes = serde_json::to_vec(doc).unwrap_or_default();
    blake3::hash(&bytes).to_hex().to_string()
}

/// Swap `"sealed"` markers on Locker items for in-memory deterministic placeholders.
#[must_use]
pub fn seed_document_of(doc: &Value) -> Value {
    centraid_assist_eval::source::seed_document_of(doc)
}
