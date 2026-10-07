//! THE UNLOCK SESSION — a session, not a mode, and a clock that is checked.
//!
//! Ported from `packages/client/src/locker/locker-unlock.ts`'s `LockerSession`.
//! Four properties, each of which is the reason the type looks like this:
//!
//! 1. **The clock is checked on every call**, never scheduled. A timer in a
//!    suspended app may fire minutes late or never,
//!    and a session that expires only when a timer says so is a session that
//!    does not expire.
//! 2. **Expiry locks as a side effect.** A caller that asks after the window
//!    closed must not be able to ask again and get a different answer, so
//!    [`Session::key`] *drops the bytes* on the way out.
//! 3. **Idle is what ends a session, not elapsed time** ([`Session::touch`]).
//!    A member working through a card's fields is not asked twice.
//! 4. **Locking zeroes the bytes before dropping the reference.** A garbage
//!    collector is not a promise about when a secret stops existing; an
//!    explicit overwrite is the one thing this process can actually do.
//!
//! The key lives behind a `RefCell` rather than being taken by `&mut self`,
//! because a reveal is a **read** from every caller's point of view and
//! `crate::locker::phone` holds the session behind one `Mutex` it only ever
//! borrows. The cost is a runtime borrow, and the borrow is never held across
//! a call.

use std::cell::RefCell;

/// The unlock session's life. Was `LOCKER_SESSION_TIMEOUT_MS`.
pub const SESSION_TIMEOUT_MS: i64 = 5 * 60 * 1_000;

/// One reveal's window, used or not (`reveal.ts:21`).
///
/// *A reveal is a gesture, not a mode*, and the reason for thirty seconds is
/// the shoulder standing behind the member. The shell drops the value when it
/// runs out (`LockerRevealed.expires_in_ms`).
pub const REVEAL_WINDOW_MS: i64 = 30_000;

/// What a surface renders. Never the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// The member has not opened it, or it has closed.
    Locked,
    /// Open, with this many milliseconds left.
    Unlocked { remaining_ms: i64 },
}

/// The phone's unlock session over one vault.
pub struct Session {
    vault_id: String,
    timeout_ms: i64,
    /// `None` when locked. The key is **zeroed** before this becomes `None`.
    held: RefCell<Option<Held>>,
}

struct Held {
    key_id: String,
    key: Vec<u8>,
    expires_at_ms: i64,
}

impl Session {
    /// A locked session over one vault.
    #[must_use]
    pub fn locked(vault_id: &str) -> Self {
        Self {
            vault_id: vault_id.to_owned(),
            timeout_ms: SESSION_TIMEOUT_MS,
            held: RefCell::new(None),
        }
    }

    /// The same, with a shorter life — for a surface that wants one, and for
    /// the tests that would otherwise have to wait five minutes.
    #[must_use]
    pub fn with_timeout(mut self, timeout_ms: i64) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    #[must_use]
    pub fn vault_id(&self) -> &str {
        &self.vault_id
    }

    /// Open the session with `K`. The caller has already proven presence: the
    /// shell's OS prompt answered yes (D-5), and `phone::unlock` loaded `K`.
    pub fn open(&self, key_id: &str, key: Vec<u8>, now_ms: i64) {
        *self.held.borrow_mut() = Some(Held {
            key_id: key_id.to_owned(),
            key,
            expires_at_ms: now_ms + self.timeout_ms,
        });
    }

    /// What a surface renders.
    #[must_use]
    pub fn state(&self, now_ms: i64) -> SessionState {
        match self.held.borrow().as_ref() {
            Some(held) if now_ms < held.expires_at_ms => SessionState::Unlocked {
                remaining_ms: held.expires_at_ms - now_ms,
            },
            _ => SessionState::Locked,
        }
    }

    /// Whether the session is open at this instant.
    #[must_use]
    pub fn unlocked(&self, now_ms: i64) -> bool {
        matches!(self.state(now_ms), SessionState::Unlocked { .. })
    }

    /// THE KEY, IF THE SESSION IS LIVE — and expiry **locks** on the way out.
    ///
    /// The clone is deliberate and bounded: the caller needs the bytes for one
    /// AEAD open and the session keeps its own copy until it locks. Every
    /// consumer in this crate drops the clone inside the same function.
    pub fn key(&self, now_ms: i64) -> Result<(String, Vec<u8>), SessionExpired> {
        let expired = {
            let held = self.held.borrow();
            match held.as_ref() {
                None => return Err(SessionExpired),
                Some(held) if now_ms >= held.expires_at_ms => true,
                Some(held) => {
                    return Ok((held.key_id.clone(), held.key.clone()));
                }
            }
        };
        if expired {
            // LOCK AS A SIDE EFFECT OF ASKING TOO LATE.
            self.lock();
        }
        Err(SessionExpired)
    }

    /// Extend on deliberate use. **Idle** is what ends a session.
    pub fn touch(&self, now_ms: i64) {
        let mut held = self.held.borrow_mut();
        if let Some(inner) = held.as_mut()
            && now_ms < inner.expires_at_ms
        {
            inner.expires_at_ms = now_ms + self.timeout_ms;
        }
    }

    /// Drop the bytes, zeroing them first.
    pub fn lock(&self) {
        if let Some(mut held) = self.held.borrow_mut().take() {
            held.key.fill(0);
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.lock();
    }
}

/// The session is not open. Deliberately carries no detail: "expired" and
/// "never opened" are the same answer to a caller, and the surface reads
/// [`Session::state`] for the difference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("this Locker session is not open")]
pub struct SessionExpired;

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> Vec<u8> {
        vec![3_u8; 32]
    }

    #[test]
    fn a_new_session_is_locked() {
        assert_eq!(Session::locked("vault-1").state(0), SessionState::Locked);
    }

    /// THE CLOCK IS CHECKED, not scheduled — and the check is what expires the
    /// session, so no timer has to fire.
    #[test]
    fn a_session_expires_by_being_asked_and_not_by_a_timer() {
        let session = Session::locked("vault-1");
        session.open("key-1", key(), 0);
        assert!(session.unlocked(0));
        assert_eq!(
            session.state(0),
            SessionState::Unlocked {
                remaining_ms: SESSION_TIMEOUT_MS
            }
        );
        assert!(session.key(SESSION_TIMEOUT_MS - 1).is_ok());
        assert_eq!(session.key(SESSION_TIMEOUT_MS), Err(SessionExpired));
        // …AND ASKING TOO LATE LOCKED IT: a second ask, even at an earlier
        // instant, cannot get a different answer.
        assert_eq!(session.key(0), Err(SessionExpired));
        assert_eq!(session.state(0), SessionState::Locked);
    }

    /// IDLE IS WHAT ENDS A SESSION: a member working through a card's fields
    /// is not asked twice.
    #[test]
    fn deliberate_use_extends_and_an_expired_session_cannot_be_touched_awake() {
        let session = Session::locked("vault-1").with_timeout(1_000);
        session.open("key-1", key(), 0);
        session.touch(900);
        assert!(session.key(1_500).is_ok(), "the touch extended it");
        // Past the extended window, a touch does NOT revive it.
        session.touch(3_000);
        assert_eq!(session.key(3_000), Err(SessionExpired));
        assert_eq!(session.state(3_000), SessionState::Locked);
    }

    #[test]
    fn locking_zeroes_and_forgets() {
        let session = Session::locked("vault-1");
        session.open("key-1", key(), 0);
        session.lock();
        assert_eq!(session.key(0), Err(SessionExpired));
        assert_eq!(session.state(0), SessionState::Locked);
        // Locking twice is not an error.
        session.lock();
    }
}
