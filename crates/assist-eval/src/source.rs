//! WHERE A SET COMES FROM. The eval reads sessions and worlds through [`EvalSource`], so the record the `datagen`
//! crate will write (#1166, stage 7) is one more implementation, not a change to the runner.
//!
//! Today's source is the frozen JSONL set the retired Python eval scored (`data/v7/val.jsonl`, `data/v7/FROZEN.md`) and the
//! world JSON files its sessions name (`data/v7/worlds`). Both are held out: `experiments/toolchat/native/artefacts.py
//! fetch` brings them from the private data version.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::EvalError;
use crate::gold::Session;

/// A session left out of a run, and why.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Exclusion {
    pub id: String,
    pub reason: String,
}

/// A set of sessions and the worlds they run in.
pub trait EvalSource {
    /// A label for the report: the file or version the set came from.
    fn label(&self) -> String;

    /// Every session, in set order.
    ///
    /// # Errors
    /// [`EvalError`] when the set cannot be read.
    fn sessions(&self) -> Result<Vec<Session>, EvalError>;

    /// Sessions the source holds but cannot be asked, and why. They are not in [`Self::sessions`]; the report
    /// counts them so a subset never reads as the whole set.
    ///
    /// # Errors
    /// [`EvalError`] when the set cannot be read.
    fn excluded(&self) -> Result<Vec<Exclusion>, EvalError> {
        Ok(Vec::new())
    }

    /// A world description (`crates/nativetools/src/seed.rs` documents the format) by the name a session gives.
    ///
    /// # Errors
    /// [`EvalError`] when no such world can be read.
    fn world(&self, name: &str) -> Result<Value, EvalError>;
}

fn read(path: &Path) -> Result<String, EvalError> {
    std::fs::read_to_string(path).map_err(|error| EvalError::Read {
        path: path.display().to_string(),
        message: error.to_string(),
    })
}

/// A frozen JSONL set (one session per line) and the directories its worlds live in, searched in order
/// (by default `data/v7/worlds`).
#[derive(Debug, Clone)]
pub struct JsonlSource {
    set: PathBuf,
    worlds: Vec<PathBuf>,
}

impl JsonlSource {
    #[must_use]
    pub fn new(set: impl Into<PathBuf>, worlds: Vec<PathBuf>) -> Self {
        Self {
            set: set.into(),
            worlds,
        }
    }
}

impl EvalSource for JsonlSource {
    fn label(&self) -> String {
        self.set.display().to_string()
    }

    fn sessions(&self) -> Result<Vec<Session>, EvalError> {
        let text = read(&self.set)?;
        let mut out = Vec::new();
        for (index, line) in text
            .lines()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
        {
            out.push(serde_json::from_str(line).map_err(|error| EvalError::Json {
                what: format!("{} line {}", self.set.display(), index + 1),
                message: error.to_string(),
            })?);
        }
        Ok(out)
    }

    fn world(&self, name: &str) -> Result<Value, EvalError> {
        for dir in &self.worlds {
            let path = dir.join(format!("{name}.json"));
            if path.exists() {
                return serde_json::from_str(&read(&path)?).map_err(|error| EvalError::Json {
                    what: path.display().to_string(),
                    message: error.to_string(),
                });
            }
        }
        Err(EvalError::Read {
            path: name.to_owned(),
            message: format!(
                "no world {name}.json in {}; `python3 experiments/toolchat/native/artefacts.py fetch` brings the held-out worlds",
                self.worlds
                    .iter()
                    .map(|d| d.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        })
    }
}

/// A set held in memory: tests, and a generator that scores what it just made.
#[derive(Debug, Clone, Default)]
pub struct MemorySource {
    pub label: String,
    pub sessions: Vec<Session>,
    pub worlds: BTreeMap<String, Value>,
}

impl EvalSource for MemorySource {
    fn label(&self) -> String {
        self.label.clone()
    }

    fn sessions(&self) -> Result<Vec<Session>, EvalError> {
        Ok(self.sessions.clone())
    }

    fn world(&self, name: &str) -> Result<Value, EvalError> {
        self.worlds
            .get(name)
            .cloned()
            .ok_or_else(|| EvalError::Read {
                path: name.to_owned(),
                message: "no such world in the set".to_owned(),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_jsonl_set_reads_one_session_per_line_and_says_which_line_is_bad() {
        let dir = tempfile::tempdir().expect("tempdir");
        let good = r#"{"id":"S1","world":"W","today":"2026-03-12T18:20","me":"Sam","turns":[{"user":"hi","gold":[{"type":"decline","reasons":["out_of_scope"]}],"ref":[]}]}"#;
        let path = dir.path().join("set.jsonl");
        std::fs::write(&path, format!("{good}\n\n{good}\n")).expect("write");
        let source = JsonlSource::new(&path, vec![dir.path().to_path_buf()]);
        let sessions = source.sessions().expect("sessions");
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].turns[0].user, "hi");
        std::fs::write(&path, format!("{good}\n{{\"id\": 3}}\n")).expect("write");
        let error = source.sessions().expect_err("bad line").to_string();
        assert!(error.contains("line 2"), "{error}");
    }

    #[test]
    fn a_world_is_found_in_the_first_directory_that_has_it() {
        let (a, b) = (
            tempfile::tempdir().expect("a"),
            tempfile::tempdir().expect("b"),
        );
        std::fs::write(b.path().join("W.json"), r#"{"me": "Sam"}"#).expect("write");
        let source = JsonlSource::new(
            "unused",
            vec![a.path().to_path_buf(), b.path().to_path_buf()],
        );
        assert_eq!(source.world("W").expect("world")["me"], "Sam");
        assert!(
            source
                .world("X")
                .expect_err("missing")
                .to_string()
                .contains("artefacts.py fetch")
        );
    }
}
