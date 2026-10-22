//! THE YEAR-3 SEARCH VAULT, founded once per test binary (#1135).
//!
//! `search_budget` times the core's search answers over it and `query_plans`
//! plans every read the apps hold over it; both need the same vault, and the same
//! vault is what makes the one's p95 and the other's plan about one thing.
//!
//! **How it is founded.** The vault is created by this build (`Core::open`, then
//! `Vault::found`), the generator in `centraid_apps_kit::search_corpus` writes
//! its rows in one commit, and the index is built by the vault's own `rebuild`:
//! the same function a restored vault with a damaged index runs, over rows no
//! command wrote. A generator that wrote rows around the writer is the reason
//! the rebuild is here and not the incremental path.
//!
//! `dead_code` is allowed for the reason `common/mod.rs` gives: each integration
//! test is its own binary and compiles this whole module.
#![allow(dead_code)]

use std::path::PathBuf;
use std::time::Instant;

use centraid_apps_kit::search_corpus::{
    SearchCorpusCounts, SearchCorpusShape, Vocabulary, YEAR3_ROWS, YEAR3_SEARCH,
    year3_search_corpus,
};
use centraid_core::{Core, CoreConfig, Handle};

/// The seed every run uses, so two runs found byte-identical rows.
pub const SEED: u64 = 1_135_003;

/// The member's 24 words (the BIP-39 all-`abandon` vector): Locker's session
/// needs a seed to unlock.
const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";

pub struct Year3 {
    pub dir: PathBuf,
    pub handle: Handle,
    pub counts: SearchCorpusCounts,
    pub shape: SearchCorpusShape,
    pub vocabulary: Vocabulary,
    /// Seconds spent writing the rows, and building the index.
    pub wrote_seconds: f64,
    pub indexed_seconds: f64,
}

impl Year3 {
    /// Close the file the way a phone's app is closed (so SQLite learns the
    /// statistics of the tables a session read, as `PRAGMA optimize` does on
    /// every close) and open it again. The vault a plan is taken on is a
    /// third-year phone's, which has been closed many times; a vault founded a
    /// moment ago has no statistics at all and plans differently.
    pub fn reopen(&mut self) {
        self.handle.close_file().expect("the file closes");
        let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
            .expect("the words parse")
            .seed();
        self.handle = Core::open(
            CoreConfig::new(self.dir.join("vault.db"))
                .opening_existing()
                .with_seed(seed, 0),
        )
        .expect("the core reopens");
    }
}

impl Drop for Year3 {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Found the vault, write the corpus, build the index.
pub fn found() -> Year3 {
    found_shape(YEAR3_SEARCH)
}

/// The same rows with short texts: for a test that plans statements.
pub fn found_rows() -> Year3 {
    found_shape(YEAR3_ROWS)
}

pub fn found_shape(shape: SearchCorpusShape) -> Year3 {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the words parse")
        .seed();
    let handle =
        Core::open(CoreConfig::new(dir.join("vault.db")).with_seed(seed, 0)).expect("a core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Year 3", "Owner")?))
        .expect("it founds");

    let started = Instant::now();
    let counts =
        handle
            .with_vault(|vault| {
                Ok(vault
                    .commit(|tx| {
                        Ok(year3_search_corpus(tx.connection(), shape, SEED)
                            .expect("the corpus lands"))
                    })?
                    .value)
            })
            .expect("the corpus commits");
    let wrote_seconds = started.elapsed().as_secs_f64();

    let started = Instant::now();
    handle
        .with_vault(|vault| {
            vault.commit(|tx| {
                centraid_vault::index::rebuild(tx.connection())?;
                Ok(())
            })?;
            Ok(())
        })
        .expect("the index builds");
    let indexed_seconds = started.elapsed().as_secs_f64();

    Year3 {
        dir,
        handle,
        counts,
        shape,
        vocabulary: Vocabulary::new(shape.vocabulary),
        wrote_seconds,
        indexed_seconds,
    }
}
