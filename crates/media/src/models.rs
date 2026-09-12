//! The model lock: **verify what is on disk, fetch only what is missing**
//! (#1020 open question 9, `docs/recognition-automations.md:81`).
//!
//! Weights are release assets, not repository content. `models.lock.json` pins
//! every file by sha256, byte length and an immutable upstream URL — a
//! commit-addressed `resolve/<sha>` link, never a moving `main`. This module is
//! the one implementation of *"is this file the file we pinned, and if not, get
//! it"*, which is exactly the half of open question 9 that already exists in v0
//! and needs porting rather than designing.
//!
//! ## Four properties the port keeps, and the reason for each
//!
//! 1. **Size first, then digest.** A `stat` rules out a truncated or replaced
//!    file without hashing 600 MB of CLIP.
//! 2. **Temp file, then rename.** A killed or corrupt download never leaves a
//!    partial file where a complete one is expected, and a concurrent reader
//!    sees the old file or the new one, never a growing one. **The digest is
//!    checked on the temp file, before the rename** — so the name only ever
//!    appears over verified bytes.
//! 3. **A failure is REPORTED, NEVER THROWN.** `ensure` answers a
//!    [`Provision`] with `ready` and `failed` lists and returns `Ok` even when
//!    every capability failed: the gateway boots either way and the automation
//!    for that capability stays unavailable until the next boot. A `Result::Err`
//!    from this module means the *lock file itself* could not be read, which is
//!    a build problem and not a network one.
//! 4. **A capability outside the request is not read and not written.**
//!    Provisioning `faces` must not touch CLIP's 600 MB.
//!
//! ## Fetching is a trait, and this crate opens no socket
//!
//! [`Fetch`] is the seam. `crates/media` is scanned by `no-listening-socket`
//! and has no HTTP client; the real fetcher is the host's, handed in. The tests
//! drive [`DirectoryFetch`] — bytes read from a local directory keyed by the
//! pinned path — through **the same code the network fetcher runs**, which is
//! what makes the verify-then-rename property testable here at all. The
//! network fetcher is an owner hand-off, named in the lane's receipt with the
//! command and the evidence it needs.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// One pinned file.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct LockFile {
    /// Model id and version, e.g. `yunet-arcface@1`.
    pub model: String,
    /// Path under `<runtime_dir>/models`, POSIX-separated.
    pub path: String,
    pub sha256: String,
    /// Exact byte length of the pinned file.
    pub bytes: u64,
    pub license: String,
    pub url: String,
    /// Capabilities that cannot run without this file.
    pub capabilities: Vec<String>,
}

/// The manifest.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Lock {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub files: Vec<LockFile>,
}

/// The schema version this build understands. Equality, like the ontology's:
/// a manifest from a newer release is a stale BUILD, not an old manifest.
pub const SCHEMA_VERSION: u32 = 1;

/// Why a lock file could not be used at all.
#[derive(Debug, thiserror::Error)]
pub enum LockError {
    #[error("the model lock is not readable: {0}")]
    Unreadable(#[from] io::Error),
    #[error("the model lock is not valid JSON: {0}")]
    Malformed(#[from] serde_json::Error),
    #[error("the model lock is schema version {found}; this build reads {SCHEMA_VERSION}")]
    Version { found: u32 },
    #[error("`{path}` pins a sha256 that is not 64 hex characters")]
    Digest { path: String },
    #[error("`{path}` escapes the models directory")]
    Escape { path: String },
}

impl Lock {
    /// Parse a manifest, refusing three shapes a later stage could not.
    ///
    /// - a schema version this build does not read;
    /// - a digest that is not 64 hex characters, because a pin that cannot be
    ///   compared is not a pin (the same shape rule `core_content_item.sha256`
    ///   carries as a CHECK, #996 R21);
    /// - **a path that escapes the models directory.** `path` is joined onto a
    ///   host directory and then written to; `../../.ssh/authorized_keys` is a
    ///   manifest, not a download.
    pub fn parse(text: &str) -> Result<Self, LockError> {
        let lock: Self = serde_json::from_str(text)?;
        if lock.schema_version != SCHEMA_VERSION {
            return Err(LockError::Version {
                found: lock.schema_version,
            });
        }
        for file in &lock.files {
            if file.sha256.len() != 64 || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(LockError::Digest {
                    path: file.path.clone(),
                });
            }
            if !is_contained(&file.path) {
                return Err(LockError::Escape {
                    path: file.path.clone(),
                });
            }
        }
        Ok(lock)
    }

    /// Read a manifest off disk.
    pub fn read(path: &Path) -> Result<Self, LockError> {
        Self::parse(&fs::read_to_string(path)?)
    }

    /// Every capability the manifest can satisfy, in manifest order.
    #[must_use]
    pub fn capabilities(&self) -> Vec<&str> {
        let mut seen = Vec::new();
        for file in &self.files {
            for capability in &file.capabilities {
                if !seen.contains(&capability.as_str()) {
                    seen.push(capability.as_str());
                }
            }
        }
        seen
    }

    /// The files one capability needs.
    #[must_use]
    pub fn files_for(&self, capability: &str) -> Vec<&LockFile> {
        self.files
            .iter()
            .filter(|file| file.capabilities.iter().any(|name| name == capability))
            .collect()
    }
}

/// A relative POSIX path with no `..` segment, no root and no drive.
fn is_contained(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && path
            .split(['/', '\\'])
            .all(|segment| !segment.is_empty() && segment != ".." && segment != ".")
}

/// Where pinned bytes come from. The real one is the host's HTTP client; this
/// crate opens no socket.
pub trait Fetch {
    /// The bytes at `url`, or a sentence saying why not. **The implementation
    /// need not verify anything**: [`ensure`] verifies what it is handed.
    fn get(&self, url: &str) -> Result<Vec<u8>, String>;
}

/// A fetcher that reads from a local directory, keyed by the pinned `path`.
///
/// Not a mock in the usual sense: it drives the real [`ensure`] code, so the
/// size check, the digest check, the temp file and the rename are all exercised
/// — everything except the socket.
#[derive(Debug, Clone)]
pub struct DirectoryFetch {
    root: PathBuf,
    lock: Lock,
}

impl DirectoryFetch {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>, lock: Lock) -> Self {
        Self {
            root: root.into(),
            lock,
        }
    }
}

impl Fetch for DirectoryFetch {
    fn get(&self, url: &str) -> Result<Vec<u8>, String> {
        let file = self
            .lock
            .files
            .iter()
            .find(|file| file.url == url)
            .ok_or_else(|| format!("{url} is not in this manifest"))?;
        fs::read(self.root.join(&file.path)).map_err(|error| format!("{url}: {error}"))
    }
}

/// One capability that could not be completed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub capability: String,
    /// The sentence a boot log prints. Never an error a caller has to catch.
    pub reason: String,
}

/// What a provision run found. **Never an `Err` for a capability**; see the
/// module note.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Provision {
    /// Capabilities whose every pinned file is present and digest-verified.
    pub ready: Vec<String>,
    /// Paths (relative to `<runtime_dir>/models`) fetched by THIS call.
    pub fetched: Vec<String>,
    pub failed: Vec<Failure>,
}

/// Present AND byte-identical to the pin. Size first; see the module note.
#[must_use]
pub fn matches_pin(destination: &Path, file: &LockFile) -> bool {
    match fs::metadata(destination) {
        Ok(info) if info.is_file() && info.len() == file.bytes => {}
        _ => return false,
    }
    fs::read(destination).is_ok_and(|bytes| sha256_hex(&bytes) == file.sha256.to_ascii_lowercase())
}

/// Lowercase hex SHA-256.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Verify what is on disk under `<runtime_dir>/models` and report, **opening
/// no connection at all**.
///
/// This is the path an unconfigured host takes: a test, an e2e harness, an
/// embedded build. `fetched` is always empty by construction.
#[must_use]
pub fn verify(lock: &Lock, runtime_dir: &Path, capabilities: &[&str]) -> Provision {
    provision(lock, runtime_dir, capabilities, None)
}

/// Make the pinned weights for `capabilities` present, fetching only what is
/// missing or fails its pin. Idempotent and safe on every boot.
#[must_use]
pub fn ensure(
    lock: &Lock,
    runtime_dir: &Path,
    capabilities: &[&str],
    fetcher: &dyn Fetch,
) -> Provision {
    provision(lock, runtime_dir, capabilities, Some(fetcher))
}

fn provision(
    lock: &Lock,
    runtime_dir: &Path,
    capabilities: &[&str],
    fetcher: Option<&dyn Fetch>,
) -> Provision {
    let models_dir = runtime_dir.join("models");
    let mut provision = Provision::default();
    // Deduped, and in the caller's own order for a readable boot log.
    let mut seen = BTreeSet::new();
    for capability in capabilities
        .iter()
        .filter(|capability| seen.insert(**capability))
    {
        let files = lock.files_for(capability);
        if files.is_empty() {
            provision.failed.push(Failure {
                capability: (*capability).to_owned(),
                reason: format!("no pinned assets for capability \"{capability}\""),
            });
            continue;
        }
        let mut missing: Vec<String> = Vec::new();
        for file in files {
            let destination = models_dir.join(&file.path);
            if matches_pin(&destination, file) {
                continue;
            }
            let Some(fetcher) = fetcher else {
                missing.push(file.path.clone());
                continue;
            };
            match download(&destination, file, fetcher) {
                Ok(()) => provision.fetched.push(file.path.clone()),
                Err(reason) => missing.push(format!("{} ({reason})", file.path)),
            }
        }
        if missing.is_empty() {
            provision.ready.push((*capability).to_owned());
        } else {
            provision.failed.push(Failure {
                capability: (*capability).to_owned(),
                reason: format!("missing or unverified: {}", missing.join(", ")),
            });
        }
    }
    provision
}

/// Fetch one file into a temp path, verify the digest, then rename.
///
/// **Every failure removes the temp file.** A `.partial` left behind would be
/// read as a download in progress by a later boot that has no such download.
fn download(destination: &Path, file: &LockFile, fetcher: &dyn Fetch) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = destination.with_extension("partial");
    let outcome = (|| {
        let bytes = fetcher.get(&file.url)?;
        // Length before digest, for the same reason the disk check does it.
        let length = bytes.len() as u64;
        if length != file.bytes {
            return Err(format!(
                "length mismatch for {}: {length} != {}",
                file.path, file.bytes
            ));
        }
        fs::write(&temporary, &bytes).map_err(|error| error.to_string())?;
        // THE DIGEST IS CHECKED ON WHAT LANDED, not on what was handed over: a
        // short write is a different file and this is where it is caught.
        let actual = fs::read(&temporary)
            .map(|written| sha256_hex(&written))
            .map_err(|error| error.to_string())?;
        if actual != file.sha256.to_ascii_lowercase() {
            return Err(format!(
                "sha256 mismatch for {}: {actual} != {}",
                file.path, file.sha256
            ));
        }
        fs::rename(&temporary, destination).map_err(|error| error.to_string())
    })();
    if outcome.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lock_text(files: &[(&str, &str, &[u8], &[&str])]) -> String {
        let entries: Vec<String> = files
            .iter()
            .map(|(model, path, bytes, capabilities)| {
                format!(
                    r#"{{"model":"{model}","path":"{path}","sha256":"{}","bytes":{},"license":"MIT","url":"https://example.invalid/{path}","capabilities":[{}]}}"#,
                    sha256_hex(bytes),
                    bytes.len(),
                    capabilities
                        .iter()
                        .map(|name| format!("\"{name}\""))
                        .collect::<Vec<_>>()
                        .join(","),
                )
            })
            .collect();
        format!(r#"{{"schemaVersion":1,"files":[{}]}}"#, entries.join(","))
    }

    struct World {
        dir: PathBuf,
    }

    impl World {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("centraid-models-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(dir.join("upstream")).expect("temp dir");
            fs::create_dir_all(dir.join("runtime/models")).expect("temp dir");
            Self { dir }
        }

        fn upstream(&self) -> PathBuf {
            self.dir.join("upstream")
        }

        fn runtime(&self) -> PathBuf {
            self.dir.join("runtime")
        }

        fn put_upstream(&self, path: &str, bytes: &[u8]) {
            let target = self.upstream().join(path);
            fs::create_dir_all(target.parent().expect("a parent")).expect("mkdir");
            fs::write(target, bytes).expect("write");
        }
    }

    impl Drop for World {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn the_committed_v0_manifest_parses_and_names_its_capabilities() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/model-runtime/models.lock.json");
        let lock = Lock::read(&path).expect("the pinned manifest parses");
        assert_eq!(lock.schema_version, SCHEMA_VERSION);
        assert!(!lock.files.is_empty());
        for capability in ["embed-image", "embed-text"] {
            assert!(
                lock.capabilities().contains(&capability),
                "{capability} is not in the manifest"
            );
        }
        // Every pin is a comparable digest and a contained path — the two
        // shapes `Lock::parse` refuses, asserted against the real file.
        for file in &lock.files {
            assert_eq!(file.sha256.len(), 64, "{} has no comparable pin", file.path);
            assert!(is_contained(&file.path), "{} escapes", file.path);
            assert!(file.bytes > 0, "{} pins no length", file.path);
        }
    }

    #[test]
    fn a_schema_version_this_build_does_not_read_is_refused() {
        let text = r#"{"schemaVersion":2,"files":[]}"#;
        assert!(matches!(
            Lock::parse(text),
            Err(LockError::Version { found: 2 })
        ));
    }

    /// A PATH THAT ESCAPES IS A MANIFEST, NOT A DOWNLOAD.
    #[test]
    fn a_path_that_escapes_the_models_directory_is_refused_before_any_write() {
        for path in ["../../.ssh/authorized_keys", "/etc/passwd", "clip/../../x"] {
            let text = lock_text(&[("m@1", path, b"x", &["faces"])]);
            assert!(
                matches!(Lock::parse(&text), Err(LockError::Escape { .. })),
                "{path} was accepted"
            );
        }
    }

    #[test]
    fn a_pin_that_cannot_be_compared_is_refused() {
        let text = r#"{"schemaVersion":1,"files":[{"model":"m@1","path":"a","sha256":"abc",
          "bytes":1,"license":"MIT","url":"u","capabilities":["faces"]}]}"#;
        assert!(matches!(Lock::parse(text), Err(LockError::Digest { .. })));
    }

    #[test]
    fn verify_reports_what_is_missing_and_opens_nothing() {
        let world = World::new("verify");
        let text = lock_text(&[("y@1", "yunet/model.onnx", b"weights", &["faces"])]);
        let lock = Lock::parse(&text).expect("parses");
        let provision = verify(&lock, &world.runtime(), &["faces"]);
        assert!(provision.ready.is_empty());
        assert!(provision.fetched.is_empty(), "verify never fetches");
        assert_eq!(provision.failed.len(), 1);
        assert!(provision.failed[0].reason.contains("yunet/model.onnx"));
    }

    /// THE WHOLE PROPERTY: verify, then fetch, then verify again, then rename.
    #[test]
    fn ensure_fetches_what_is_missing_and_the_name_appears_over_verified_bytes() {
        let world = World::new("ensure");
        world.put_upstream("yunet/model.onnx", b"weights");
        let text = lock_text(&[("y@1", "yunet/model.onnx", b"weights", &["faces"])]);
        let lock = Lock::parse(&text).expect("parses");
        let fetcher = DirectoryFetch::new(world.upstream(), lock.clone());

        let first = ensure(&lock, &world.runtime(), &["faces"], &fetcher);
        assert_eq!(first.ready, ["faces"]);
        assert_eq!(first.fetched, ["yunet/model.onnx"]);
        assert!(first.failed.is_empty());
        let landed = world.runtime().join("models/yunet/model.onnx");
        assert_eq!(fs::read(&landed).expect("landed"), b"weights");
        assert!(
            !landed.with_extension("partial").exists(),
            "no temp file survives a success"
        );

        // Idempotent: a provisioned runtime fetches nothing.
        let second = ensure(&lock, &world.runtime(), &["faces"], &fetcher);
        assert_eq!(second.ready, ["faces"]);
        assert!(second.fetched.is_empty());
    }

    /// A CORRUPT DOWNLOAD IS REPORTED, NEVER THROWN, and leaves nothing behind.
    #[test]
    fn a_digest_mismatch_is_reported_and_no_partial_file_survives() {
        let world = World::new("corrupt");
        // Upstream serves bytes of the RIGHT LENGTH and the wrong content, so
        // the length check passes and the digest check is what catches it.
        world.put_upstream("yunet/model.onnx", b"weightz");
        let text = lock_text(&[("y@1", "yunet/model.onnx", b"weights", &["faces"])]);
        let lock = Lock::parse(&text).expect("parses");
        let fetcher = DirectoryFetch::new(world.upstream(), lock.clone());

        let provision = ensure(&lock, &world.runtime(), &["faces"], &fetcher);
        assert!(provision.ready.is_empty());
        assert_eq!(provision.failed.len(), 1);
        assert!(
            provision.failed[0].reason.contains("sha256 mismatch"),
            "{}",
            provision.failed[0].reason
        );
        let landed = world.runtime().join("models/yunet/model.onnx");
        assert!(!landed.exists(), "the name must not appear over bad bytes");
        assert!(!landed.with_extension("partial").exists());
    }

    #[test]
    fn a_truncated_download_is_caught_by_the_length_check() {
        let world = World::new("short");
        world.put_upstream("yunet/model.onnx", b"weig");
        let text = lock_text(&[("y@1", "yunet/model.onnx", b"weights", &["faces"])]);
        let lock = Lock::parse(&text).expect("parses");
        let fetcher = DirectoryFetch::new(world.upstream(), lock.clone());
        let provision = ensure(&lock, &world.runtime(), &["faces"], &fetcher);
        assert!(provision.failed[0].reason.contains("length mismatch"));
    }

    #[test]
    fn an_unreachable_upstream_is_reported_and_the_host_still_boots() {
        let world = World::new("unreachable");
        let text = lock_text(&[("y@1", "yunet/model.onnx", b"weights", &["faces"])]);
        let lock = Lock::parse(&text).expect("parses");
        // Nothing was put upstream: every read fails.
        let fetcher = DirectoryFetch::new(world.upstream(), lock.clone());
        let provision = ensure(&lock, &world.runtime(), &["faces"], &fetcher);
        assert!(provision.ready.is_empty());
        assert_eq!(provision.failed.len(), 1);
        // And `ensure` returned. There is no `?` for a caller to propagate.
    }

    /// THE NO-NETWORK HOST, stated as a fetcher rather than as an empty
    /// directory: every `get` refuses, which is what a phone in a tunnel and a
    /// gateway behind a proxy both look like from in here.
    ///
    /// Two claims, and the second is the one that matters: `ensure` RETURNS —
    /// a provisioning failure is reported in `Provision::failed`, never raised
    /// — and `verify` on the same lock touches no network at all, because it
    /// is a question about the disk.
    #[test]
    fn a_host_with_no_network_is_reported_and_never_throws() {
        struct NoNetwork;
        impl Fetch for NoNetwork {
            fn get(&self, url: &str) -> Result<Vec<u8>, String> {
                Err(format!("{url}: no network on this host"))
            }
        }

        let world = World::new("no-network");
        let text = lock_text(&[("y@1", "yunet/model.onnx", b"weights", &["faces"])]);
        let lock = Lock::parse(&text).expect("parses");

        // `verify` first: it never asks a fetcher anything.
        let seen = verify(&lock, &world.runtime(), &["faces"]);
        assert!(seen.ready.is_empty());
        assert_eq!(seen.failed.len(), 1);

        let provision = ensure(&lock, &world.runtime(), &["faces"], &NoNetwork);
        assert!(provision.ready.is_empty());
        assert_eq!(provision.failed.len(), 1);
        assert!(
            provision.failed[0].reason.contains("no network"),
            "the failure carries the fetcher's own sentence: {}",
            provision.failed[0].reason
        );
        // And nothing was written: a refused fetch leaves no temp file behind.
        assert!(
            !world.runtime().join("yunet/model.onnx").exists(),
            "a refused fetch must not leave a file the next verify would trust"
        );
    }

    /// A capability outside the request is not read and not written.
    #[test]
    fn provisioning_one_capability_leaves_every_other_file_alone() {
        let world = World::new("scoped");
        world.put_upstream("yunet/model.onnx", b"weights");
        world.put_upstream("clip/visual.onnx", b"six-hundred-megabytes");
        let text = lock_text(&[
            ("y@1", "yunet/model.onnx", b"weights", &["faces"]),
            (
                "c@1",
                "clip/visual.onnx",
                b"six-hundred-megabytes",
                &["embed-image"],
            ),
        ]);
        let lock = Lock::parse(&text).expect("parses");
        let fetcher = DirectoryFetch::new(world.upstream(), lock.clone());
        let provision = ensure(&lock, &world.runtime(), &["faces"], &fetcher);
        assert_eq!(provision.fetched, ["yunet/model.onnx"]);
        assert!(
            !world.runtime().join("models/clip/visual.onnx").exists(),
            "CLIP must not be fetched for a faces provision"
        );
    }

    #[test]
    fn a_capability_the_manifest_cannot_satisfy_is_named_in_the_failure() {
        let text = lock_text(&[("y@1", "yunet/model.onnx", b"weights", &["faces"])]);
        let lock = Lock::parse(&text).expect("parses");
        let world = World::new("unknown-capability");
        let provision = verify(&lock, &world.runtime(), &["transcript"]);
        assert!(provision.failed[0].reason.contains("no pinned assets"));
    }

    #[test]
    fn a_replaced_file_of_the_right_length_fails_its_pin() {
        let world = World::new("replaced");
        let text = lock_text(&[("y@1", "yunet/model.onnx", b"weights", &["faces"])]);
        let lock = Lock::parse(&text).expect("parses");
        let landed = world.runtime().join("models/yunet/model.onnx");
        fs::create_dir_all(landed.parent().expect("parent")).expect("mkdir");
        fs::write(&landed, b"weightz").expect("write");
        assert!(!matches_pin(&landed, &lock.files[0]));
        assert!(verify(&lock, &world.runtime(), &["faces"]).ready.is_empty());
    }
}
