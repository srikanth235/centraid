//! WHAT ONLY A TEST MAY DO TO A GATEWAY'S DISK AND ANSWERS (#1191, E14).
//!
//! A disk that reads full, an upload refused as too large, an `exists` that
//! lies, a count of the questions asked, the order objects were committed in,
//! and a hook that runs (or stops the process) the moment a file has been
//! renamed into place and before its row is written. None of it may be in the
//! gateway a member runs, so this whole module is behind the `test-harness`
//! cargo feature, as [`crate::server::harness`] is, and the few places the
//! store and the routes consult it are each behind the same attribute.
//! `cargo xtask rules` fails if either is not.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::server::store::StageError;

/// Called after the `n`th file (1-based, in this process) was renamed into
/// place by a commit, before its row is written.
pub type RenameHook = Arc<dyn Fn(usize) + Send + Sync>;

/// The knobs of one gateway.
#[derive(Default)]
pub struct Knobs {
    full: AtomicBool,
    too_large: AtomicBool,
    lying: AtomicBool,
    exists_calls: AtomicU64,
    exists_names: AtomicU64,
    commits: Mutex<Vec<u64>>,
    renames: AtomicU64,
    attempts: AtomicU64,
    fail_at: AtomicU64,
    after_rename: Mutex<Option<RenameHook>>,
    before_unlink: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl core::fmt::Debug for Knobs {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str("Knobs")
    }
}

impl Knobs {
    /// Refuse every upload `DISK_FULL` until told otherwise: a real full disk
    /// is not something a test can make on any machine it runs on.
    pub fn pretend_full(&self, full: bool) {
        self.full.store(full, Ordering::SeqCst);
    }

    /// Refuse every upload `TOO_LARGE` until told otherwise.
    pub fn pretend_too_large(&self, too_large: bool) {
        self.too_large.store(too_large, Ordering::SeqCst);
    }

    /// Make `exists` answer that every name is held, whatever the disk holds:
    /// a gateway that lies, which is what a phone's read-back is for.
    pub fn pretend_to_hold_everything(&self, lying: bool) {
        self.lying.store(lying, Ordering::SeqCst);
    }

    /// Make the `nth` commit from now (1 is the next) fail with a store
    /// fault before it touches a file: the fault a bundle's transaction must
    /// survive. `0` takes it away.
    pub fn fail_commit(&self, nth: u64) {
        self.attempts.store(0, Ordering::SeqCst);
        self.fail_at.store(nth, Ordering::SeqCst);
    }

    /// Whether this commit must fail.
    pub(crate) fn commit_fails(&self) -> bool {
        let fail_at = self.fail_at.load(Ordering::SeqCst);
        fail_at != 0 && self.attempts.fetch_add(1, Ordering::SeqCst) + 1 == fail_at
    }

    /// Run `hook` after every file a commit renames into place, before its
    /// row is written; `None` takes it away.
    pub fn after_rename(&self, hook: Option<RenameHook>) {
        if let Ok(mut held) = self.after_rename.lock() {
            *held = hook;
        }
    }

    /// Run `hook` inside the orphan sweep's one step, after it has looked at
    /// the index and before it unlinks; `None` takes it away.
    pub fn on_orphan_unlink(&self, hook: Option<Arc<dyn Fn() + Send + Sync>>) {
        if let Ok(mut held) = self.before_unlink.lock() {
            *held = hook;
        }
    }

    pub(crate) fn before_orphan_unlink(&self) {
        let hook = self.before_unlink.lock().ok().and_then(|held| held.clone());
        if let Some(hook) = hook {
            hook();
        }
    }

    /// Whether staging must be refused, and how.
    pub(crate) fn refusing(&self, limit: u64) -> Option<StageError> {
        if self.full.load(Ordering::SeqCst) {
            return Some(StageError::DiskFull);
        }
        self.too_large
            .load(Ordering::SeqCst)
            .then_some(StageError::TooLarge { limit })
    }

    /// Whether `exists` lies.
    pub(crate) fn lies(&self) -> bool {
        self.lying.load(Ordering::SeqCst)
    }

    /// Note one `exists` call about `names` names.
    pub(crate) fn note_exists(&self, names: usize) {
        self.exists_calls.fetch_add(1, Ordering::SeqCst);
        self.exists_names.fetch_add(names as u64, Ordering::SeqCst);
    }

    /// `(calls, names)` the gateway has been asked by `exists`.
    #[must_use]
    pub fn exists_asked(&self) -> (u64, u64) {
        (
            self.exists_calls.load(Ordering::SeqCst),
            self.exists_names.load(Ordering::SeqCst),
        )
    }

    /// The order every object was committed in, from one process-wide counter.
    #[must_use]
    pub fn commit_order(&self) -> Vec<u64> {
        self.commits
            .lock()
            .map(|held| held.clone())
            .unwrap_or_default()
    }

    /// A file was just renamed into place.
    pub(crate) fn renamed(&self) {
        static ORDER: AtomicU64 = AtomicU64::new(0);
        if let Ok(mut commits) = self.commits.lock() {
            commits.push(ORDER.fetch_add(1, Ordering::SeqCst));
        }
        let nth = usize::try_from(self.renames.fetch_add(1, Ordering::SeqCst) + 1).unwrap_or(0);
        let hook = self.after_rename.lock().ok().and_then(|held| held.clone());
        if let Some(hook) = hook {
            hook(nth);
        }
    }
}
