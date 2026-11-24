//! PART 3, MEANING-KEYED PHRASING CACHE: strictly isolated `<cache>/train/` and
//! `<cache>/heldout/` stores, keyed by BLAKE3 of the semantic wording signature
//! (`meaning_key`: action, kind & field by meaning — NOT tool/arg name — row naming,
//! value shape & currency, writer brief version).
//!
//! Records which reader check each phrasing passed and against which fixture world
//! (`world_id`, `world_neighbourhood_hash`). Never mixes train and held-out entries.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::declarations::Declarations;
use crate::intents::WordingSignature;
use crate::world::Split;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheScope {
    Train,
    Heldout,
}

impl CacheScope {
    #[must_use]
    pub const fn dir_name(self) -> &'static str {
        match self {
            Self::Train => "train",
            Self::Heldout => "heldout",
        }
    }

    #[must_use]
    pub const fn of_split(split: Split) -> Self {
        match split {
            Split::Train | Split::Val => Self::Train,
            Split::Test => Self::Heldout,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReaderCheck {
    Passed,
    ResolverSettled,
    Pending,
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VariantStatus {
    Passing,
    Invalidated,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedVariant {
    pub id: String,
    pub messages: Vec<String>,
    pub style: String,
    pub writer: String,
    pub reader: Option<String>,
    pub reader_check: ReaderCheck,
    pub world_id: String,
    pub world_neighbourhood_hash: String,
    pub currency_ok: bool,
    pub oracle_ok: bool,
    pub status: VariantStatus,
}

impl CachedVariant {
    #[must_use]
    pub fn is_passing(&self) -> bool {
        self.status == VariantStatus::Passing
            && self.currency_ok
            && self.oracle_ok
            && matches!(
                self.reader_check,
                ReaderCheck::Passed | ReaderCheck::ResolverSettled
            )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CacheEntry {
    pub meaning_key: String,
    pub brief_version: String,
    pub scope: CacheScope,
    pub signature: WordingSignature,
    pub variants: Vec<CachedVariant>,
}

/// Strictly isolated handle over `<root>/train/` or `<root>/heldout/`.
#[derive(Debug, Clone)]
pub struct PhrasingCache {
    root: PathBuf,
    scope: CacheScope,
}

impl PhrasingCache {
    /// Open one isolated cache scope (`<root>/train/` or `<root>/heldout/`).
    ///
    /// # Errors
    ///
    /// If the directory cannot be created.
    pub fn open(root: &Path, scope: CacheScope) -> Result<Self> {
        let scoped = root.join(scope.dir_name());
        std::fs::create_dir_all(scoped.join("entries"))?;
        Ok(Self {
            root: scoped,
            scope,
        })
    }

    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.root
    }

    #[must_use]
    pub fn scope(&self) -> CacheScope {
        self.scope
    }

    fn entry_path(&self, meaning_key: &str) -> PathBuf {
        let prefix = meaning_key.get(..2).unwrap_or("00");
        self.root
            .join("entries")
            .join(prefix)
            .join(format!("{meaning_key}.json"))
    }

    /// Read a cached entry by `meaning_key` if present.
    ///
    /// # Errors
    ///
    /// If an existing entry file is corrupt JSON or mismatches this cache's `scope`.
    pub fn get(&self, meaning_key: &str) -> Result<Option<CacheEntry>> {
        let path = self.entry_path(meaning_key);
        if !path.is_file() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading cache entry {}", path.display()))?;
        let entry: CacheEntry = serde_json::from_str(&text)
            .with_context(|| format!("corrupt cache entry {}", path.display()))?;
        if entry.scope != self.scope {
            bail!(
                "cache isolation violation: {} holds {:?} entry inside {:?} cache",
                path.display(),
                entry.scope,
                self.scope
            );
        }
        Ok(Some(entry))
    }

    /// Insert or merge a [`CacheEntry`] into this isolated scope.
    ///
    /// # Errors
    ///
    /// If `entry.scope != self.scope` or writing fails.
    pub fn put(&self, mut entry: CacheEntry) -> Result<()> {
        if entry.scope != self.scope {
            bail!(
                "refusing to write {:?} entry into {:?} cache",
                entry.scope,
                self.scope
            );
        }
        let path = self.entry_path(&entry.meaning_key);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if let Some(existing) = self.get(&entry.meaning_key)? {
            let mut by_id: BTreeMap<String, CachedVariant> = existing
                .variants
                .into_iter()
                .map(|v| (v.id.clone(), v))
                .collect();
            for v in entry.variants {
                by_id.insert(v.id.clone(), v);
            }
            entry.variants = by_id.into_values().collect();
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&entry)?)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Load all entries in this scope, sorted by `meaning_key`.
    ///
    /// # Errors
    ///
    /// If any entry file is unreadable or corrupt.
    pub fn all_entries(&self) -> Result<Vec<CacheEntry>> {
        let mut paths = Vec::new();
        let entries_dir = self.root.join("entries");
        if entries_dir.is_dir() {
            for shard in std::fs::read_dir(&entries_dir)? {
                let shard = shard?.path();
                if shard.is_dir() {
                    for file in std::fs::read_dir(&shard)? {
                        let p = file?.path();
                        if p.extension().is_some_and(|e| e == "json") {
                            paths.push(p);
                        }
                    }
                }
            }
        }
        paths.sort();
        let mut out = Vec::with_capacity(paths.len());
        for p in paths {
            let text = std::fs::read_to_string(&p)?;
            let entry: CacheEntry = serde_json::from_str(&text)
                .with_context(|| format!("corrupt cache entry {}", p.display()))?;
            if entry.scope != self.scope {
                bail!("cache isolation violation in {}", p.display());
            }
            out.push(entry);
        }
        Ok(out)
    }

    /// Count passing variants per `meaning_key` in this scope.
    ///
    /// # Errors
    ///
    /// If reading entries fails.
    pub fn passing_pool(&self) -> Result<BTreeMap<String, Vec<CachedVariant>>> {
        let mut pool = BTreeMap::new();
        for entry in self.all_entries()? {
            let passing: Vec<CachedVariant> = entry
                .variants
                .into_iter()
                .filter(CachedVariant::is_passing)
                .collect();
            if !passing.is_empty() {
                pool.insert(entry.meaning_key, passing);
            }
        }
        Ok(pool)
    }

    /// Invalidate variants whose `meaning_key` matches any key in `keys`.
    ///
    /// # Errors
    ///
    /// If reading or writing entries fails.
    pub fn invalidate_keys(&self, keys: &std::collections::BTreeSet<String>) -> Result<usize> {
        let mut count = 0;
        for mut entry in self.all_entries()? {
            if keys.contains(&entry.meaning_key) {
                for v in &mut entry.variants {
                    if v.status == VariantStatus::Passing {
                        v.status = VariantStatus::Invalidated;
                        count += 1;
                    }
                }
                let path = self.entry_path(&entry.meaning_key);
                std::fs::write(&path, serde_json::to_string_pretty(&entry)?)?;
            }
        }
        Ok(count)
    }

    /// Save the declarations snapshot for future `DeclarationDiff` comparisons.
    ///
    /// # Errors
    ///
    /// If writing fails.
    pub fn write_declarations(&self, decls: &Declarations) -> Result<()> {
        let path = self.root.join("declarations.json");
        std::fs::write(path, serde_json::to_string_pretty(decls)?)?;
        Ok(())
    }

    /// Load the previous declarations snapshot if present.
    ///
    /// # Errors
    ///
    /// If the file exists and is invalid JSON.
    pub fn read_declarations(&self) -> Result<Option<Declarations>> {
        let path = self.root.join("declarations.json");
        if !path.is_file() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(&path)?;
        Ok(Some(serde_json::from_str(&text)?))
    }

    /// BLAKE3 hash and entry count across all files in this isolated scope.
    ///
    /// # Errors
    ///
    /// If any file cannot be read.
    pub fn hash_and_count(&self) -> Result<(String, usize)> {
        let entries = self.all_entries()?;
        let mut hasher = blake3::Hasher::new();
        for entry in &entries {
            hasher.update(entry.meaning_key.as_bytes());
            hasher.update(&serde_json::to_vec(entry)?);
        }
        Ok((hasher.finalize().to_hex().to_string(), entries.len()))
    }

    /// Pack this isolated scope into a deterministic `.jsonl.zst` archive.
    ///
    /// # Errors
    ///
    /// If reading entries or writing `to` fails.
    pub fn pack(&self, to: &Path) -> Result<usize> {
        let entries = self.all_entries()?;
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = std::fs::File::create(to)?;
        let mut enc = zstd::stream::Encoder::new(std::io::BufWriter::new(file), 6)?;
        for entry in &entries {
            let line = json!({
                "file": format!("entries/{}/{}.json", entry.meaning_key.get(..2).unwrap_or("00"), entry.meaning_key),
                "entry": entry,
            });
            enc.write_all(serde_json::to_string(&line)?.as_bytes())?;
            enc.write_all(b"\n")?;
        }
        enc.finish()?.flush()?;
        Ok(entries.len())
    }

    /// Unpack a packed scope archive into this cache scope.
    ///
    /// # Errors
    ///
    /// If any line fails validation or crosses scope boundaries.
    pub fn unpack(&self, from: &Path) -> Result<usize> {
        let bytes = zstd::stream::decode_all(std::fs::File::open(from)?)?;
        let mut count = 0;
        for line in String::from_utf8(bytes)?
            .lines()
            .filter(|l| !l.trim().is_empty())
        {
            let v: Value = serde_json::from_str(line)?;
            let entry: CacheEntry = serde_json::from_value(v["entry"].clone())?;
            self.put(entry)?;
            count += 1;
        }
        Ok(count)
    }
}

/// Deterministic variant id from `(meaning_key, messages)`.
#[must_use]
pub fn variant_id(meaning_key: &str, messages: &[String]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(meaning_key.as_bytes());
    for m in messages {
        hasher.update(&[0]);
        hasher.update(m.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}
