//! THE LANGUAGE MODEL, BEHIND A TRAIT, AND ITS CACHE (stages 4 and 5).
//!
//! The writer and the read-back reader are Claude Haiku through headless Claude Code
//! (`claude -p --model haiku`, no API key). Both reach it only through [`Llm`], so a test supplies
//! a deterministic fake and never touches the network.
//!
//! Every output is cached by the BLAKE3 hash of `model + prompt`, one file per prompt under
//! `<out>/llm-cache/`. A rebuild with a warm cache makes zero calls and reads the same bytes, so
//! the data it writes is byte-identical; `--offline` turns a cache miss into an error instead of a
//! call. The cache is part of the data version: it is what makes the messages reproducible.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// A text model: a prompt in, a completion out. Implementations must be callable from several
/// threads at once.
pub trait Llm: Send + Sync {
    /// The model's name, part of every cache key.
    fn model(&self) -> &str;

    /// # Errors
    ///
    /// The model's failure (a process that did not start or exited non-zero, a network error).
    fn complete(&self, prompt: &str) -> Result<String>;
}

/// Claude through headless Claude Code: `claude -p --model <model>`, the prompt on stdin.
pub struct ClaudeCli {
    pub model: String,
    pub bin: String,
}

impl ClaudeCli {
    #[must_use]
    pub fn haiku() -> Self {
        Self {
            model: "haiku".to_owned(),
            bin: std::env::var("CLAUDE_BIN").unwrap_or_else(|_| "claude".to_owned()),
        }
    }
}

impl Llm for ClaudeCli {
    fn model(&self) -> &str {
        &self.model
    }

    fn complete(&self, prompt: &str) -> Result<String> {
        let scratch = tempfile::tempdir()?;
        let mut child = Command::new(&self.bin)
            .args([
                "-p",
                "--model",
                &self.model,
                "--tools",
                "",
                "--no-session-persistence",
                "--disable-slash-commands",
                "--system-prompt",
                "You are a precise assistant. Answer with exactly the JSON asked for and nothing else.",
            ])
            // a directory with no CLAUDE.md, so no project instructions reach the model
            .current_dir(scratch.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // `[mcp-sdk]` warnings and the like are not the answer
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("starting {}", self.bin))?;
        let mut stdin = child.stdin.take().context("no stdin")?;
        let text = prompt.to_owned();
        // a big prompt must not block on a full pipe while the child writes
        let writer = std::thread::spawn(move || stdin.write_all(text.as_bytes()));
        let out = child.wait_with_output()?;
        let _ = writer.join();
        if !out.status.success() {
            bail!("{} exited with {}", self.bin, out.status);
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }
}

/// What a cache file holds.
#[derive(Serialize, Deserialize)]
struct Entry {
    model: String,
    prompt_hash: String,
    response: String,
}

/// The cache: files under `dir`, named by prompt hash.
pub struct Cache<'a> {
    llm: &'a dyn Llm,
    dir: PathBuf,
    offline: bool,
    /// Where a miss is written as a pending prompt instead of asked (see [`Cache::collecting`]).
    collect: Option<PathBuf>,
    pending: AtomicUsize,
    pub calls: AtomicUsize,
    pub hits: AtomicUsize,
}

/// The hash a prompt is cached under: the model and the exact prompt.
#[must_use]
pub fn prompt_hash(model: &str, prompt: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(model.as_bytes());
    hasher.update(&[0]);
    hasher.update(prompt.as_bytes());
    hasher.finalize().to_hex().to_string()
}

impl<'a> Cache<'a> {
    /// # Errors
    ///
    /// If the cache directory cannot be made.
    pub fn open(llm: &'a dyn Llm, dir: &Path, offline: bool) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Self {
            llm,
            dir: dir.to_path_buf(),
            offline,
            collect: None,
            pending: AtomicUsize::new(0),
            calls: AtomicUsize::new(0),
            hits: AtomicUsize::new(0),
        })
    }

    /// A cache that answers no miss: each is written to `dir/<hash>.json` as `{model, hash, prompt}` and answered
    /// with an empty string that is not cached, so a caller sees an unusable answer. The prompts are answered
    /// elsewhere and put back with [`put`]. A caller stops asking again when [`Cache::pending`] is not zero.
    #[must_use]
    pub fn collecting(mut self, dir: &Path) -> Self {
        self.collect = Some(dir.to_path_buf());
        self
    }

    /// The prompts a collecting cache has written so far.
    #[must_use]
    pub fn pending(&self) -> usize {
        self.pending.load(Ordering::Relaxed)
    }

    fn path(&self, hash: &str) -> PathBuf {
        self.dir.join(&hash[..2]).join(format!("{hash}.json"))
    }

    /// The completion of `prompt`: from the cache, or (not offline) from the model, then cached.
    ///
    /// # Errors
    ///
    /// A cache miss when offline, or the model's failure.
    pub fn complete(&self, prompt: &str) -> Result<String> {
        let hash = prompt_hash(self.llm.model(), prompt);
        let path = self.path(&hash);
        if let Ok(text) = std::fs::read_to_string(&path) {
            let entry: Entry = serde_json::from_str(&text)
                .with_context(|| format!("a corrupt cache file {}", path.display()))?;
            self.hits.fetch_add(1, Ordering::Relaxed);
            return Ok(entry.response);
        }
        if let Some(dir) = &self.collect {
            std::fs::create_dir_all(dir)?;
            let pending = serde_json::json!({
                "model": self.llm.model(), "hash": hash, "prompt": prompt,
            });
            std::fs::write(dir.join(format!("{hash}.json")), pending.to_string())?;
            self.pending.fetch_add(1, Ordering::Relaxed);
            return Ok(String::new());
        }
        if self.offline {
            bail!("offline: no cached completion for prompt {hash}");
        }
        self.calls.fetch_add(1, Ordering::Relaxed);
        let response = self.llm.complete(prompt)?;
        let entry = Entry {
            model: self.llm.model().to_owned(),
            prompt_hash: hash,
            response: response.clone(),
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // written whole, then renamed in: a killed run leaves no half-written entry
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string(&entry)?)?;
        std::fs::rename(&tmp, &path)?;
        Ok(response)
    }

    #[must_use]
    pub fn counts(&self) -> (usize, usize) {
        (
            self.calls.load(Ordering::Relaxed),
            self.hits.load(Ordering::Relaxed),
        )
    }
}

/// Put an answer into the cache under `hash` (what [`prompt_hash`] gave `model` and the prompt), the way a
/// completed call would have. A hash is 64 hex digits. Returns false when an entry is already there (kept).
///
/// # Errors
///
/// A hash that is not one, or a file that cannot be written.
pub fn put(dir: &Path, model: &str, hash: &str, response: &str) -> Result<bool> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("`{hash}` is not a prompt hash");
    }
    let path = dir.join(&hash[..2]).join(format!("{hash}.json"));
    if path.exists() {
        return Ok(false);
    }
    std::fs::create_dir_all(path.parent().context("no parent")?)?;
    let entry = Entry {
        model: model.to_owned(),
        prompt_hash: hash.to_owned(),
        response: response.to_owned(),
    };
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string(&entry)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(true)
}

/// The first JSON value in a model's answer, whatever it wrapped it in (a code fence, a sentence).
///
/// # Errors
///
/// If the answer holds no JSON object.
pub fn json_of(answer: &str) -> Result<serde_json::Value> {
    // The first `{` that opens a whole value: an answer may say more after it (a second object,
    // a note), and a stray brace in prose before it must not hide it.
    let mut rest = answer;
    while let Some(start) = rest.find('{') {
        let mut values = serde_json::Deserializer::from_str(&rest[start..]).into_iter();
        if let Some(Ok(value)) = values.next() {
            return Ok(value);
        }
        rest = &rest[start + 1..];
    }
    bail!("no JSON in the answer")
}

/// Run `f` over `items` on `workers` threads, results in input order (`None` only for a worker
/// that panicked).
pub fn parallel<T: Sync, R: Send>(
    items: &[T],
    workers: usize,
    f: impl Fn(&T) -> R + Sync,
) -> Vec<Option<R>> {
    let next = AtomicUsize::new(0);
    let slots: Vec<std::sync::Mutex<Option<R>>> =
        items.iter().map(|_| std::sync::Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..workers.clamp(1, items.len().max(1)) {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    let r = f(item);
                    if let Ok(mut slot) = slots[i].lock() {
                        *slot = Some(r);
                    }
                }
            });
        }
    });
    slots
        .into_iter()
        .map(|s| s.into_inner().ok().flatten())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Echo(AtomicUsize);
    impl Llm for Echo {
        fn model(&self) -> &str {
            "echo"
        }
        fn complete(&self, prompt: &str) -> Result<String> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(format!("{{\"len\": {}}}", prompt.len()))
        }
    }

    #[test]
    fn a_warm_cache_makes_no_calls_and_offline_fails_on_a_miss() {
        let dir = tempfile::tempdir().expect("dir");
        let llm = Echo(AtomicUsize::new(0));
        let first = Cache::open(&llm, dir.path(), false).expect("cache");
        let a = first.complete("hello").expect("a");
        assert_eq!(llm.0.load(Ordering::Relaxed), 1);
        let second = Cache::open(&llm, dir.path(), true).expect("cache");
        assert_eq!(second.complete("hello").expect("a"), a);
        assert_eq!(llm.0.load(Ordering::Relaxed), 1);
        assert!(second.complete("other").is_err());
    }

    #[test]
    fn a_collecting_cache_writes_the_prompt_and_a_put_answer_is_then_a_hit() {
        let dir = tempfile::tempdir().expect("dir");
        let pending = dir.path().join("pending");
        let cache_dir = dir.path().join("cache");
        let llm = Echo(AtomicUsize::new(0));
        let cache = Cache::open(&llm, &cache_dir, false)
            .expect("cache")
            .collecting(&pending);
        assert_eq!(cache.complete("hello").expect("empty"), "");
        assert_eq!(cache.pending(), 1);
        assert_eq!(llm.0.load(Ordering::Relaxed), 0);
        let hash = prompt_hash("echo", "hello");
        let file: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(pending.join(format!("{hash}.json"))).expect("pending"),
        )
        .expect("json");
        assert_eq!(file["prompt"], "hello");
        assert!(put(&cache_dir, "echo", &hash, "{\"a\": 1}").expect("put"));
        assert!(!put(&cache_dir, "echo", &hash, "other").expect("kept"));
        assert!(put(&cache_dir, "echo", "nothex", "x").is_err());
        let offline = Cache::open(&llm, &cache_dir, true).expect("cache");
        assert_eq!(offline.complete("hello").expect("hit"), "{\"a\": 1}");
    }

    #[test]
    fn json_is_found_inside_a_fence() {
        let v = json_of("```json\n{\"a\": [1]}\n```").expect("json");
        assert_eq!(v["a"][0], 1);
        assert!(json_of("no braces").is_err());
        let v = json_of("{\"a\": 1}\n{\"b\": 2} and a note }").expect("first value");
        assert_eq!(v["a"], 1);
        let v = json_of("a {stray brace, then {\"a\": 2}").expect("after a stray brace");
        assert_eq!(v["a"], 2);
    }

    #[test]
    fn parallel_keeps_input_order() {
        let items: Vec<usize> = (0..50).collect();
        let out = parallel(&items, 4, |i| i * 2);
        assert_eq!(out, (0..50).map(|i| Some(i * 2)).collect::<Vec<_>>());
    }
}
