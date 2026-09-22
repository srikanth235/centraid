//! # `map` — reading `grammar/map.json`
//!
//! The gold canonical per (corpus, session, turn). Read only by
//! [`OracleCanonical`](crate::oracle::OracleCanonical), which is a ceiling
//! test and says so.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct MapTurn {
    pub corpus: String,
    pub session: String,
    pub turn: usize,
    pub category: String,
    pub expectation: String,
    pub request: String,
    pub canonical: String,
    pub covered: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct MapFile {
    turns: Vec<MapTurn>,
}

/// Where `grammar/map.json` lives, relative to this crate.
#[must_use]
pub fn default_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("evalsuite")
        .join("grammar")
        .join("map.json")
}

/// Every mapped turn, keyed `(corpus, session, turn)`.
///
/// # Errors
///
/// The file is unreadable or is not a map.
pub fn read(path: &Path) -> Result<BTreeMap<(String, String, usize), MapTurn>, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let file: MapFile =
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(file
        .turns
        .into_iter()
        .map(|turn| ((turn.corpus.clone(), turn.session.clone(), turn.turn), turn))
        .collect())
}

/// Every mapped turn, in file order.
///
/// # Errors
///
/// The file is unreadable or is not a map.
pub fn read_all(path: &Path) -> Result<Vec<MapTurn>, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let file: MapFile =
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(file.turns)
}
