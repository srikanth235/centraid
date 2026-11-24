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
    if path.extension().is_some_and(|ext| ext == "zst") {
        let file = std::fs::File::open(path).map_err(|error| EvalError::Read {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
        let bytes = zstd::stream::decode_all(file).map_err(|error| EvalError::Read {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
        return String::from_utf8(bytes).map_err(|error| EvalError::Read {
            path: path.display().to_string(),
            message: error.to_string(),
        });
    }
    std::fs::read_to_string(path).map_err(|error| EvalError::Read {
        path: path.display().to_string(),
        message: error.to_string(),
    })
}

fn parse_sessions_text(
    text: &str,
    source_name: &Path,
    default_split: Option<&str>,
    out: &mut Vec<Session>,
) -> Result<(), EvalError> {
    for (index, line) in text
        .lines()
        .enumerate()
        .filter(|(_, l)| !l.trim().is_empty())
    {
        let mut session: Session = serde_json::from_str(line).map_err(|error| EvalError::Json {
            what: format!("{} line {}", source_name.display(), index + 1),
            message: error.to_string(),
        })?;
        if session.split.is_none() {
            session.split = default_split.map(str::to_owned);
        }
        out.push(session);
    }
    Ok(())
}

fn read_world_from_dirs(dirs: &[PathBuf], name: &str) -> Result<Value, EvalError> {
    for dir in dirs {
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
            dirs.iter()
                .map(|d| d.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    })
}

fn shard_files_in_dir(dir: &Path) -> Result<Vec<PathBuf>, EvalError> {
    let entries = std::fs::read_dir(dir).map_err(|error| EvalError::Read {
        path: dir.display().to_string(),
        message: error.to_string(),
    })?;
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with(".jsonl") || n.ends_with(".jsonl.zst"))
        })
        .collect();
    files.sort();
    Ok(files)
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
    const FROM: &str = "a data version of the private Hugging Face dataset srikanth235/centraid-assist-data at a pinned revision: manifest.json (or version directory), data/<split>.jsonl.zst, and its worlds/<split>/ directory";
    let set = set.ok_or_else(|| format!("give --set SET.jsonl ({FROM})"))?;
    let is_manifest = set.file_name().is_some_and(|n| n == "manifest.json")
        || (set.is_dir() && set.join("manifest.json").is_file());
    if worlds.is_empty() && !is_manifest {
        return Err(format!("give --worlds DIR, the set's worlds ({FROM})"));
    }
    Ok((set, worlds))
}

/// The split a set file is named for: `val.jsonl`, `test.jsonl.zst`, `<dir>/val/sessions.jsonl`, or `data/val/`
/// (`shard-*.jsonl.zst`). `None` for any other name.
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

/// A frozen JSONL set (one session per line, plain or `.zst`, or a directory of shards) and the directories its
/// worlds live in, searched in order (a data version's `worlds/`).
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
        let split = split_of_path(&self.set);
        let mut out = Vec::new();
        if self.set.is_dir() {
            let files = shard_files_in_dir(&self.set)?;
            for file in files {
                let text = read(&file)?;
                let file_split = split_of_path(&file).or_else(|| split.clone());
                parse_sessions_text(&text, &file, file_split.as_deref(), &mut out)?;
            }
            return Ok(out);
        }
        let text = read(&self.set)?;
        parse_sessions_text(&text, &self.set, split.as_deref(), &mut out)?;
        Ok(out)
    }

    fn world(&self, name: &str) -> Result<Value, EvalError> {
        read_world_from_dirs(&self.worlds, name)
    }
}

/// A data version opened from `manifest.json` (or its directory), reading sharded manifests (`data/<split>/shard-*.jsonl.zst`)
/// with fallback to legacy single-file layouts (`data/<split>.jsonl.zst` / `<split>/<split>.jsonl.zst`).
#[derive(Debug, Clone)]
pub struct ManifestSource {
    manifest_path: PathBuf,
    split: String,
    files: Vec<PathBuf>,
    worlds: Vec<PathBuf>,
}

impl ManifestSource {
    /// Open `path` (a version directory containing `manifest.json`, or `manifest.json` itself) for `split`.
    ///
    /// # Errors
    /// [`EvalError`] when `manifest.json` cannot be read/parsed or no data files exist for `split`.
    pub fn open(
        path: impl Into<PathBuf>,
        split: impl Into<String>,
        extra_worlds: Vec<PathBuf>,
    ) -> Result<Self, EvalError> {
        let path = path.into();
        let split = split.into();
        let (root, manifest_path) = if path.is_dir() {
            (path.clone(), path.join("manifest.json"))
        } else {
            (
                path.parent()
                    .unwrap_or_else(|| Path::new("."))
                    .to_path_buf(),
                path,
            )
        };
        let raw = read(&manifest_path)?;
        let manifest: Value = serde_json::from_str(&raw).map_err(|error| EvalError::Json {
            what: manifest_path.display().to_string(),
            message: error.to_string(),
        })?;
        let files = resolve_manifest_split_files(&root, &manifest, &split)?;
        let mut worlds = extra_worlds;
        worlds.push(root.join("worlds").join(&split));
        worlds.push(root.join("worlds"));
        Ok(Self {
            manifest_path,
            split,
            files,
            worlds,
        })
    }
}

fn resolve_manifest_split_files(
    root: &Path,
    manifest: &Value,
    split: &str,
) -> Result<Vec<PathBuf>, EvalError> {
    if let Some(entries) = manifest
        .get("shards")
        .and_then(|s| s.get(split))
        .and_then(Value::as_array)
    {
        if entries.is_empty() {
            return Err(EvalError::Data(format!(
                "manifest.shards.{split} must not be empty"
            )));
        }
        let mut files = Vec::with_capacity(entries.len());
        for entry in entries {
            let rel = entry
                .get("path")
                .and_then(Value::as_str)
                .or_else(|| entry.as_str())
                .ok_or_else(|| {
                    EvalError::Data(format!(
                        "manifest.shards.{split} entry lacks string path: {entry}"
                    ))
                })?;
            files.push(root.join(rel));
        }
        return Ok(files);
    }
    let shard_dir = root.join("data").join(split);
    if shard_dir.is_dir() {
        let files = shard_files_in_dir(&shard_dir)?;
        if !files.is_empty() {
            return Ok(files);
        }
    }
    for rel in [
        format!("data/{split}.jsonl.zst"),
        format!("{split}/{split}.jsonl.zst"),
        format!("data/{split}.jsonl"),
    ] {
        let candidate = root.join(&rel);
        if candidate.is_file() {
            return Ok(vec![candidate]);
        }
    }
    Err(EvalError::Read {
        path: root.join("data").join(split).display().to_string(),
        message: format!("no shards or single-file data found for split `{split}`"),
    })
}

impl EvalSource for ManifestSource {
    fn label(&self) -> String {
        format!("{}#{}", self.manifest_path.display(), self.split)
    }

    fn sessions(&self) -> Result<Vec<Session>, EvalError> {
        let mut out = Vec::new();
        for file in &self.files {
            let text = read(file)?;
            parse_sessions_text(&text, file, Some(&self.split), &mut out)?;
        }
        Ok(out)
    }

    fn world(&self, name: &str) -> Result<Value, EvalError> {
        read_world_from_dirs(&self.worlds, name)
    }
}

/// Either a plain/compressed JSONL source (single file or directory of shards) or a version `manifest.json`.
#[derive(Debug, Clone)]
pub enum SetSource {
    Jsonl(JsonlSource),
    Manifest(ManifestSource),
}

impl EvalSource for SetSource {
    fn label(&self) -> String {
        match self {
            Self::Jsonl(s) => s.label(),
            Self::Manifest(s) => s.label(),
        }
    }

    fn sessions(&self) -> Result<Vec<Session>, EvalError> {
        match self {
            Self::Jsonl(s) => s.sessions(),
            Self::Manifest(s) => s.sessions(),
        }
    }

    fn excluded(&self) -> Result<Vec<Exclusion>, EvalError> {
        match self {
            Self::Jsonl(s) => s.excluded(),
            Self::Manifest(s) => s.excluded(),
        }
    }

    fn world(&self, name: &str) -> Result<Value, EvalError> {
        match self {
            Self::Jsonl(s) => s.world(name),
            Self::Manifest(s) => s.world(name),
        }
    }
}

/// Open a set from `manifest.json` (or version directory), a split shard directory, or a single `.jsonl`/`.jsonl.zst` file.
///
/// # Errors
/// [`EvalError`] when a manifest cannot be read or parsed.
pub fn open_set(
    set: &Path,
    worlds: &[PathBuf],
    split: Option<&str>,
) -> Result<SetSource, EvalError> {
    let is_manifest = set.file_name().is_some_and(|n| n == "manifest.json")
        || (set.is_dir() && set.join("manifest.json").is_file());
    if is_manifest {
        let split = split.unwrap_or("val");
        return Ok(SetSource::Manifest(ManifestSource::open(
            set,
            split,
            worlds.to_vec(),
        )?));
    }
    Ok(SetSource::Jsonl(JsonlSource::new(set, worlds.to_vec())))
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

    fn write_zst(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        let encoded = zstd::stream::encode_all(text.as_bytes(), 3).expect("zstd");
        std::fs::write(path, encoded).expect("write");
    }

    #[test]
    fn a_sharded_manifest_and_single_file_fallback_both_read_cleanly() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let s1 = r#"{"id":"S1","world":"W1","today":"2026-03-12T18:20","me":"Sam","turns":[]}"#;
        let s2 = r#"{"id":"S2","world":"W1","today":"2026-03-12T18:20","me":"Sam","turns":[]}"#;
        write_zst(
            &root.join("data/val/shard-0000.jsonl.zst"),
            &format!("{s1}\n"),
        );
        write_zst(
            &root.join("data/val/shard-0001.jsonl.zst"),
            &format!("{s2}\n"),
        );
        std::fs::create_dir_all(root.join("worlds/val")).expect("worlds dir");
        std::fs::write(
            root.join("worlds/val/W1.json"),
            r#"{"me":"Sam","locker":[{"key":"wifi","sealed":["password"],"name":"Wifi"}]}"#,
        )
        .expect("world");
        let manifest = serde_json::json!({
            "schema_version": 2,
            "version": "v0.4",
            "shards": {
                "val": [
                    {"path": "data/val/shard-0000.jsonl.zst", "sessions": 1},
                    {"path": "data/val/shard-0001.jsonl.zst", "sessions": 1}
                ]
            }
        });
        std::fs::write(root.join("manifest.json"), manifest.to_string()).expect("manifest");
        assert!(require_set(Some(root.to_path_buf()), vec![]).is_ok());

        let src = open_set(root, &[], Some("val")).expect("open_set");
        let sessions = src.sessions().expect("sessions");
        assert_eq!(sessions.len(), 2);
        assert_eq!(
            (sessions[0].id.as_str(), sessions[1].id.as_str()),
            ("S1", "S2")
        );
        assert_eq!(sessions[0].split.as_deref(), Some("val"));
        assert_eq!(
            src.world("W1").expect("world")["locker"][0]["password"],
            "placeholder:wifi:password"
        );

        // Directory of shards via JsonlSource
        let dir_src = JsonlSource::new(root.join("data/val"), vec![root.join("worlds/val")]);
        assert_eq!(dir_src.sessions().expect("dir sessions").len(), 2);

        // Single-file fallback via ManifestSource when `shards` is absent
        let legacy_dir = tempfile::tempdir().expect("legacy");
        let lroot = legacy_dir.path();
        write_zst(&lroot.join("data/val.jsonl.zst"), &format!("{s1}\n{s2}\n"));
        std::fs::create_dir_all(lroot.join("worlds")).expect("worlds");
        std::fs::write(lroot.join("worlds/W1.json"), r#"{"me":"Sam"}"#).expect("world");
        std::fs::write(lroot.join("manifest.json"), r#"{"version":"v0.3"}"#).expect("manifest");
        let legacy = open_set(&lroot.join("manifest.json"), &[], None).expect("legacy");
        assert_eq!(legacy.sessions().expect("legacy sessions").len(), 2);
        assert_eq!(legacy.world("W1").expect("world")["me"], "Sam");

        // Direct .jsonl.zst file via JsonlSource
        let zst_src =
            JsonlSource::new(lroot.join("data/val.jsonl.zst"), vec![lroot.join("worlds")]);
        assert_eq!(zst_src.sessions().expect("zst sessions").len(), 2);

        // Empty shards list is rejected
        let empty_dir = tempfile::tempdir().expect("empty");
        std::fs::write(
            empty_dir.path().join("manifest.json"),
            r#"{"schema_version":2,"shards":{"val":[]}}"#,
        )
        .expect("empty manifest");
        assert!(matches!(
            open_set(empty_dir.path(), &[], Some("val")),
            Err(EvalError::Data(_))
        ));
    }
}
