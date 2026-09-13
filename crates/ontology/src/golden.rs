//! Reaching the frozen corpus without touching it.
//!
//! The committed file is gzipped and is NEVER opened in place. Opening a vault
//! runs pragmas and — once `crates/vault` has a ladder — migrations, and SQLite
//! writes a `-wal` sidecar beside whatever file it opened; a checkpoint then
//! folds it back into the file itself (see `docs/traps/wal-checkpoint.md`). So
//! the corpus is inflated into a scratch directory first and the copy is what
//! gets opened, exactly as v0's `golden-vault.test.ts` does.

use std::fs::File;
use std::io::{BufReader, Write as _};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use serde::Deserialize;

use crate::error::{OntologyError, Result};
use crate::snapshot::TableSnapshot;

/// The label of the **v1 baseline** corpus: a vault frozen by v0's own freezer
/// at the ladder head, which is the shape v1 founds its files from
/// ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-D1-1).
///
/// It is what `open_golden` opens and what `contracts/schema/vault-ddl.sql` is
/// generated from. There is ONE baseline; the checkpoint label below is kept
/// beside it because it is the low end of the accepted `user_version` window,
/// not a second baseline.
pub const GOLDEN_LABEL: &str = "issue-1020";

/// The label of the #929 checkpoint corpus, frozen at the LOW end of the
/// accepted `PRAGMA user_version` window. v0's own golden suite migrates it
/// forward on every run, which is the only reason a pre-ladder-head file is
/// worth keeping: it is the evidence that the ladder still climbs.
pub const GOLDEN_LABEL_CHECKPOINT: &str = "issue-929";

/// The repository root, resolved from this crate's own manifest directory so a
/// test does not depend on the working directory it was invoked from.
#[must_use]
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/ontology sits two directories below the repository root")
        .to_path_buf()
}

/// The v1 copy of the baseline corpus: `contracts/golden/<label>`.
#[must_use]
pub fn contracts_golden_dir() -> PathBuf {
    contracts_golden_dir_for(GOLDEN_LABEL)
}

/// The v1 copy of any labelled corpus.
#[must_use]
pub fn contracts_golden_dir_for(label: &str) -> PathBuf {
    repo_root().join("contracts/golden").join(label)
}

/// The v0 copy of the baseline corpus, the pinned oracle's own path. It exists
/// until wave 6 deletes the v0 tree; a caller must handle its absence.
#[must_use]
pub fn v0_golden_dir() -> PathBuf {
    v0_golden_dir_for(GOLDEN_LABEL)
}

/// The v0 copy of any labelled corpus.
#[must_use]
pub fn v0_golden_dir_for(label: &str) -> PathBuf {
    repo_root().join("packages/vault/tests/golden").join(label)
}

/// The manifest a release froze beside the file.
#[derive(Debug, Clone, Deserialize)]
pub struct GoldenManifest {
    pub label: String,
    #[serde(rename = "frozenAt")]
    pub frozen_at: String,
    #[serde(rename = "ontologyVersion")]
    pub ontology_version: String,
    #[serde(rename = "userVersion")]
    pub user_version: i64,
    /// Physical table name -> what it held at freeze time.
    pub tables: std::collections::BTreeMap<String, TableSnapshot>,
}

/// Read and parse `manifest.json` from a corpus directory.
pub fn read_manifest(dir: &Path) -> Result<GoldenManifest> {
    let path = dir.join("manifest.json");
    let text = std::fs::read_to_string(&path)?;
    serde_json::from_str(&text).map_err(|source| OntologyError::Json {
        context: format!("{} is not a golden manifest", path.display()),
        source,
    })
}

/// Inflate a gzipped vault into `dir`, returning the path of the plain file.
pub fn inflate(gz: &Path, dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let target = dir.join("vault.db");
    let mut decoder = GzDecoder::new(BufReader::new(File::open(gz)?));
    let mut out = File::create(&target)?;
    std::io::copy(&mut decoder, &mut out)?;
    out.flush()?;
    Ok(target)
}

/// An inflated corpus in a scratch directory that is removed when dropped.
pub struct InflatedGolden {
    dir: PathBuf,
    db: PathBuf,
    manifest: GoldenManifest,
}

impl InflatedGolden {
    /// Inflate the corpus in `source_dir` into a fresh scratch directory.
    pub fn from_dir(source_dir: &Path) -> Result<Self> {
        let dir = scratch_dir();
        let db = inflate(&source_dir.join("vault.db.gz"), &dir)?;
        let manifest = read_manifest(source_dir)?;
        Ok(Self { dir, db, manifest })
    }

    #[must_use]
    pub fn db_path(&self) -> &Path {
        &self.db
    }

    #[must_use]
    pub const fn manifest(&self) -> &GoldenManifest {
        &self.manifest
    }
}

impl Drop for InflatedGolden {
    fn drop(&mut self) {
        // A scratch copy the test no longer needs; a failure to remove it must
        // not mask the assertion that the test was actually about.
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Inflate the v1 copy of the baseline corpus. The helper every test uses.
pub fn open_golden() -> Result<InflatedGolden> {
    InflatedGolden::from_dir(&contracts_golden_dir())
}

/// Inflate the v1 copy of a labelled corpus.
pub fn open_golden_labelled(label: &str) -> Result<InflatedGolden> {
    InflatedGolden::from_dir(&contracts_golden_dir_for(label))
}

/// A unique scratch directory for an inflated copy. Outside the repository, so
/// nothing it holds can be committed by accident.
#[must_use]
pub fn scratch_dir() -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = format!(
        "centraid-golden-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    std::env::temp_dir().join(unique)
}
