//! THE UNLOCK SESSION — a session, not a mode, and a clock that is checked.
//!
//! Ported from `packages/client/src/locker/locker-unlock.ts`'s `LockerSession`.
//! Four properties, each of which is the reason the type looks like this:
//!
//! 1. **The clock is checked on every call**, never scheduled. A timer in a
//!    backgrounded tab or a suspended window may fire minutes late or never,
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
//! because a reveal is a **read** from every caller's point of view and a
//! surface holding `&Session` must be able to perform one. The cost is a
//! runtime borrow, and the borrow is never held across a call.

use std::cell::RefCell;

use serde::{Deserialize, Serialize};

/// The unlock session's life. Was `LOCKER_SESSION_TIMEOUT_MS`.
pub const SESSION_TIMEOUT_MS: i64 = 5 * 60 * 1_000;

/// The `Lock` surface's rule, restated where the derivation happens.
pub const PASSPHRASE_MINIMUM: usize = 12;

/// WHAT IS AT REST. No plaintext key, no passphrase, and **no verifier**.
///
/// A verifier field would be a cheap oracle: a guesser could test a passphrase
/// without doing the derivation. The AEAD tag is the verifier, and doing the
/// 600,000 rounds is the price of one guess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrappedKey {
    #[serde(rename = "v")]
    pub version: u8,
    #[serde(rename = "vaultId")]
    pub vault_id: String,
    #[serde(rename = "keyId")]
    pub key_id: String,
    pub kdf: String,
    pub iterations: u32,
    /// base64.
    pub salt: String,
    /// base64.
    pub nonce: String,
    /// base64 of AES-GCM(`K`), tag appended.
    pub ciphertext: String,
}

/// What a surface renders. Never the key, and never the passphrase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// This device has no wrapped key at rest. The shell offers enrolment.
    NotEnrolled,
    /// There is a key at rest and the member has not opened it.
    Locked,
    /// Open, with this many milliseconds left.
    Unlocked { remaining_ms: i64 },
}

/// One seat's unlock session.
pub struct Session {
    vault_id: String,
    timeout_ms: i64,
    /// `None` when locked. The key is **zeroed** before this becomes `None`.
    held: RefCell<Option<Held>>,
    /// Whether there is a blob at rest — so `NotEnrolled` and `Locked` are two
    /// states and not one (a member with no key needs a different screen from
    /// a member with a locked one).
    enrolled: bool,
}

struct Held {
    key_id: String,
    key: Vec<u8>,
    expires_at_ms: i64,
}

impl Session {
    /// A locked session over a seat that has a wrapped key at rest.
    #[must_use]
    pub fn locked(vault_id: &str) -> Self {
        Self {
            vault_id: vault_id.to_owned(),
            timeout_ms: SESSION_TIMEOUT_MS,
            held: RefCell::new(None),
            enrolled: true,
        }
    }

    /// A session over a seat with nothing at rest.
    #[must_use]
    pub fn not_enrolled(vault_id: &str) -> Self {
        Self {
            vault_id: vault_id.to_owned(),
            timeout_ms: SESSION_TIMEOUT_MS,
            held: RefCell::new(None),
            enrolled: false,
        }
    }

    /// The same, with a shorter life — for a surface that wants one, and for
    /// the tests that would otherwise have to wait five minutes.
    #[must_use]
    pub fn with_timeout(mut self, timeout_ms: i64) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    /// An open session. **Test-only by name**, because production opens one by
    /// unwrapping a passphrase and there must be no other way in.
    #[must_use]
    pub fn unlocked_for_test(vault_id: &str, key_id: &str, key: Vec<u8>, now_ms: i64) -> Self {
        let session = Self::locked(vault_id);
        session.open(key_id, key, now_ms);
        session
    }

    #[must_use]
    pub fn vault_id(&self) -> &str {
        &self.vault_id
    }

    /// Open the session with an unwrapped key. The caller has already proven
    /// the passphrase by the only means there is — the AEAD opened.
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
            _ if self.enrolled => SessionState::Locked,
            _ => SessionState::NotEnrolled,
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
    fn not_enrolled_and_locked_are_two_states() {
        assert_eq!(
            Session::not_enrolled("vault-1").state(0),
            SessionState::NotEnrolled
        );
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

    /// The blob at rest round-trips through the shape the shells store.
    #[test]
    fn the_wrapped_blob_serialises_with_v0s_field_names() {
        let wrapped = WrappedKey {
            version: 1,
            vault_id: "vault-1".to_owned(),
            key_id: "key-1".to_owned(),
            kdf: "pbkdf2-sha256".to_owned(),
            iterations: 600_000,
            salt: "c2FsdA==".to_owned(),
            nonce: "bm9uY2U=".to_owned(),
            ciphertext: "Y2lwaGVy".to_owned(),
        };
        let json = serde_json::to_value(&wrapped).expect("serialises");
        // v0's own key names, so a blob written by a v0 seat is readable and a
        // blob written here is readable by one.
        assert_eq!(json["v"], serde_json::json!(1));
        assert_eq!(json["vaultId"], serde_json::json!("vault-1"));
        assert_eq!(json["keyId"], serde_json::json!("key-1"));
        assert_eq!(json["kdf"], serde_json::json!("pbkdf2-sha256"));
        let back: WrappedKey = serde_json::from_value(json).expect("round trips");
        assert_eq!(back, wrapped);
    }
}
