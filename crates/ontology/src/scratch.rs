//! Where a test or a generator keeps a file it will throw away.
//!
//! A vault is never opened in place from a committed path: opening one writes a
//! `-wal` sidecar and a checkpoint folds that back into the file
//! ([`docs/traps/wal-checkpoint.md`](../../../docs/traps/wal-checkpoint.md)). So
//! whoever needs a vault makes a directory of their own, here.

use std::path::{Path, PathBuf};

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

/// A scratch directory name no other test holds, not yet created.
///
/// The process id and the clock's nanoseconds make the pair unique, and a name
/// that is taken anyway is stepped past rather than reused.
#[must_use]
pub fn scratch_dir() -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    loop {
        let unique = format!(
            "centraid-scratch-{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let dir = std::env::temp_dir().join(unique);
        if !dir.exists() {
            return dir;
        }
    }
}
