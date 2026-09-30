//! Test-only helpers. No `tempfile` dependency: the gate runner's dependency
//! budget is part of the `local` profile's two minutes, and one deterministic
//! directory per test does the same job.

use std::fs;
use std::path::PathBuf;

/// A clean, empty directory for one test's fixture tree.
///
/// Named after the test rather than randomised, and wiped on entry, so a failed
/// run leaves its fixture on disk to look at and the next run is unaffected.
pub fn fixture_dir(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("centraid-xtask-{name}"));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("create the fixture root");
    root
}
