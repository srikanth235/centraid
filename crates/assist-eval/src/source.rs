//! WHERE A SET COMES FROM. The eval reads sessions and worlds through [`EvalSource`], so the record the `datagen`
//! crate will write (#1166, stage 7) is one more implementation, not a change to the runner.
//!
//! The source is a JSONL set (one session per line) and the world JSON files its sessions name. A data version's split is
//! `data/<split>.jsonl.zst` (decompress it) and its `worlds/<split>/`; the version comes from the private Hugging Face repository
//! `srikanth235/centraid-assist-data` at a pinned revision. There is no default set and no default worlds: see
//! [`require_set`].

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

/// A presence-only world document (what `datagen` writes: a locker row names its sealed fields and holds no secret)
/// as the seeder reads it: each sealed marker becomes the deterministic placeholder `placeholder:<key>:<field>`, in
/// memory only. A document with no `sealed` marker (the frozen worlds) comes back unchanged.
#[must_use]
pub fn seed_document_of(doc: &Value) -> Value {
    let mut doc = doc.clone();
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

/// The set and the worlds a command was given, or a plain error saying what to pass. There is no default: a run names
/// the data it scores.
///
/// # Errors
/// A message naming the missing flag.
pub fn require_set(
    set: Option<PathBuf>,
    worlds: Vec<PathBuf>,
) -> Result<(PathBuf, Vec<PathBuf>), String> {
    const FROM: &str = "a data version of the private Hugging Face dataset srikanth235/centraid-assist-data at a pinned revision: data/<split>.jsonl.zst decompressed, and its worlds/<split>/ directory";
    let set = set.ok_or_else(|| format!("give --set SET.jsonl ({FROM})"))?;
    if worlds.is_empty() {
        return Err(format!("give --worlds DIR, the set's worlds ({FROM})"));
    }
    Ok((set, worlds))
}

/// The split a set file is named for: `val.jsonl`, `test.jsonl.zst`, or `<dir>/val/sessions.jsonl` (what
/// `datagen intents` writes). `None` for any other name.
#[must_use]
pub fn split_of_path(path: &Path) -> Option<String> {
    let known = |word: &str| ["train", "val", "test", "noise"].contains(&word);
    let name = path.file_name()?.to_string_lossy();
    let stem = name.split('.').next().unwrap_or_default();
    if known(stem) {
        return Some(stem.to_owned());
    }
    let parent = path.parent()?.file_name()?.to_string_lossy().into_owned();
    known(&parent).then_some(parent)
}

/// A frozen JSONL set (one session per line) and the directories its worlds live in, searched in order
/// (a data version's `worlds/`).
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
        let split = split_of_path(&self.set);
        let mut out = Vec::new();
        for (index, line) in text
            .lines()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
        {
            let mut session: Session =
                serde_json::from_str(line).map_err(|error| EvalError::Json {
                    what: format!("{} line {}", self.set.display(), index + 1),
                    message: error.to_string(),
                })?;
            if session.split.is_none() {
                session.split.clone_from(&split);
            }
            out.push(session);
        }
        Ok(out)
    }

    fn world(&self, name: &str) -> Result<Value, EvalError> {
        for dir in &self.worlds {
            let path = dir.join(format!("{name}.json"));
            if path.exists() {
                return serde_json::from_str(&read(&path)?)
                    .map(|doc: Value| seed_document_of(&doc))
                    .map_err(|error| EvalError::Json {
                        what: path.display().to_string(),
                        message: error.to_string(),
                    });
            }
        }
        Err(EvalError::Read {
            path: name.to_owned(),
            message: format!(
                "no world {name}.json in {}, and the set's worlds are in its data version's `worlds/<split>/` directory (pass it with --worlds)",
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
    fn a_run_names_its_set_and_worlds_there_is_no_default() {
        let none = require_set(None, vec![]).unwrap_err();
        assert!(
            none.contains("--set") && none.contains("srikanth235/centraid-assist-data"),
            "{none}"
        );
        let no_worlds = require_set(Some("val.jsonl".into()), vec![]).unwrap_err();
        assert!(no_worlds.contains("--worlds"), "{no_worlds}");
        assert!(require_set(Some("val.jsonl".into()), vec!["worlds".into()]).is_ok());
    }

    #[test]
    fn a_presence_only_world_is_read_with_its_sealed_placeholders() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("W.json"),
            r#"{"me":"Sam","locker":[{"key":"wifi","sealed":["password"],"name":"Wifi"}]}"#,
        )
        .expect("write");
        let world = JsonlSource::new("unused", vec![dir.path().to_path_buf()])
            .world("W")
            .expect("world");
        assert_eq!(world["locker"][0]["password"], "placeholder:wifi:password");
        assert!(world["locker"][0].get("sealed").is_none());
    }

    #[test]
    fn a_set_named_for_its_split_carries_the_split_to_its_sessions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let line = r#"{"id":"S1","world":"W","today":"2026-03-12T18:20","me":"Sam","turns":[]}"#;
        for (name, want) in [("val.jsonl", Some("val")), ("mixed.jsonl", None)] {
            let path = dir.path().join(name);
            std::fs::write(&path, format!("{line}\n")).expect("write");
            let sessions = JsonlSource::new(&path, vec![])
                .sessions()
                .expect("sessions");
            assert_eq!(sessions[0].split.as_deref(), want, "{name}");
            assert_eq!(sessions[0].is_held_out(), want.is_some());
        }
        let nested = dir.path().join("test");
        std::fs::create_dir(&nested).expect("dir");
        assert_eq!(
            split_of_path(&nested.join("sessions.jsonl")).as_deref(),
            Some("test")
        );
        // a record that says its own split keeps it
        let own = dir.path().join("val2.jsonl");
        std::fs::write(&own, line.replace("\"id\"", "\"split\":\"noise\",\"id\"")).expect("write");
        let sessions = JsonlSource::new(&own, vec![]).sessions().expect("sessions");
        assert!(sessions[0].is_held_out());
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
                .contains("--worlds")
        );
    }
}
