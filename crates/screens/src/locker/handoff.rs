//! THE GENERATOR'S CANDIDATE, HANDED TO THE EDITOR (#1047). "Put it on an item"
//! opens a new login whose password is the one on screen. The candidate must
//! never ride a route — a route goes to the shell and back — so it waits here,
//! in this process, until the editor takes it once. It is not kept across a
//! take, and a relock drops it.

use std::sync::Mutex;

static SLOT: Mutex<Option<String>> = Mutex::new(None);

fn slot() -> std::sync::MutexGuard<'static, Option<String>> {
    SLOT.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Leave `candidate` for the next editor that opens from the generator.
pub(super) fn put(candidate: &str) {
    *slot() = Some(candidate.to_owned());
}

/// Take it, once.
pub(super) fn take() -> Option<String> {
    slot().take()
}

/// Drop it unseen (a relock).
pub(super) fn clear() {
    *slot() = None;
}
