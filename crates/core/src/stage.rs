//! A SHELL STREAMS BYTES IN AND THE CORE NAMES THEM (#1025 S4, D-1025-S4-6).
//!
//! ## What this replaces, and why the replacement is not a preference
//!
//! `MediaLibrary.Asset` on mobile carried a `sha256` the shell computed over
//! each original in the camera roll, documented as "THE identity". It was not:
//! the identity of a member's bytes is `core_content_item.content_hash`, which
//! is **BLAKE3** (D-1025-S4-1) and is UNIQUE, and neither iOS nor Android
//! offers BLAKE3 — `CryptoKit` and `MessageDigest` both stop at SHA-2. So the
//! shell was computing a different function's value and calling it the same
//! name, and every asset it enrolled would have been filed under a hash the
//! vault does not use.
//!
//! The fix is the one the byte plane already believed: the shell moves bytes and
//! the core names them. `Asset.sha256` is gone from `PlatformServices.kt`
//! entirely, and this is where its answer comes from instead.
//!
//! ## The shape is the native-messaging stage door's, on purpose
//!
//! `crates/centraid/src/cmd/native_host/stage.rs` solves the same problem for a
//! browser: a hard ceiling on one message and no streaming, so bytes arrive in
//! frames the receiver bounds. The C ABI has the same shape — `centraid_call`
//! takes one buffer — so the same three frames answer it:
//!
//! | Frame | Carries | Answers |
//! |---|---|---|
//! | `begin` | `media_type`, `byte_size` | a `staging_id` and the chunk ceiling |
//! | `chunk` | `staging_id`, `seq`, `payload` | bytes received so far |
//! | `end` | `staging_id` | `{content_hash, byte_size, already_held}` |
//!
//! ## Three refusals, each a real failure mode
//!
//! 1. **A chunk out of order.** `seq` is checked against the next expected one,
//!    so a shell whose frames raced names the frame rather than minting bytes
//!    nobody asked for.
//! 2. **More bytes than were declared.** The declared size is the allocation, so
//!    a sender that kept chunking would be a sender deciding how much memory
//!    this process uses.
//! 3. **A short close.** A session that declared more than it sent is refused
//!    rather than silently naming a truncated file — which is the failure that
//!    survives every structural check and surfaces months later as a photograph
//!    that will not open.
//!
//! A fourth thing is refused implicitly: a second `end`. The session is removed
//! before anything else happens, so a replayed close cannot hand out a second
//! handle for bytes that are gone.
//!
//! ## `already_held` is a product fact, not a statistic
//!
//! Re-scanning a camera roll is the ordinary case, not the exception. A shell
//! that could not tell whether the core already had a photograph would re-send
//! the roll on every scan, which on a phone is the difference between a background
//! refresh and a data bill. The core knows — the store is content-addressed —
//! so it says.

use std::collections::BTreeMap;
use std::sync::Mutex;

use centraid_api_proto::core_v1 as wire;

use crate::error::{CoreError, Result};

/// How many bytes one `chunk` frame may carry.
///
/// 512 KiB, the native-messaging door's number, and for a related reason: the
/// C ABI copies each request buffer across the boundary, so a frame is a
/// transient allocation on both sides of it. A shell that wants fewer round
/// trips raises its own read size, not this.
pub const MAX_CHUNK_BYTES: usize = 512 * 1024;

/// How large one staged object may be. 512 MiB — a RAW original or a short
/// video, and not a library.
pub const MAX_STAGED_BYTES: u64 = 512 * 1024 * 1024;

/// How many sessions one core may hold open at once.
///
/// Four, because a roll import is sequential and a shell that needed five
/// concurrent uploads would be a shell holding two gigabytes of originals in
/// memory to save wall-clock it does not have.
pub const MAX_OPEN_SESSIONS: usize = 4;

#[derive(Debug)]
struct Session {
    media_type: String,
    declared_size: u64,
    next_seq: u64,
    bytes: Vec<u8>,
}

/// Every open staging session on one core.
#[derive(Debug, Default)]
pub struct Staging {
    sessions: Mutex<BTreeMap<String, Session>>,
    minted: Mutex<u64>,
}

/// What a completed session produced: the handle, and the bytes to put away.
pub struct Staged {
    pub content_hash: String,
    pub byte_size: u64,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

impl Staging {
    /// Open a session for a declared size and media type.
    pub fn begin(&self, media_type: &str, byte_size: u64) -> Result<wire::StageBegun> {
        if byte_size > MAX_STAGED_BYTES {
            return Err(CoreError::InvalidRequest {
                detail: format!("{byte_size} is over the {MAX_STAGED_BYTES}-byte staging ceiling"),
            });
        }
        let mut sessions = self.lock_sessions()?;
        if sessions.len() >= MAX_OPEN_SESSIONS {
            return Err(CoreError::InvalidRequest {
                detail: format!("{MAX_OPEN_SESSIONS} staging sessions are already open"),
            });
        }
        let staging_id = {
            let mut minted = self.minted.lock().map_err(|_| poisoned())?;
            *minted += 1;
            format!("stage-{minted}")
        };
        sessions.insert(
            staging_id.clone(),
            Session {
                media_type: media_type.to_owned(),
                declared_size: byte_size,
                next_seq: 0,
                // THE DECLARED SIZE IS THE ALLOCATION. Reserving it here and
                // refusing anything past it is what makes the overrun check a
                // bound rather than a report.
                bytes: Vec::with_capacity(usize::try_from(byte_size).unwrap_or(0)),
            },
        );
        Ok(wire::StageBegun {
            staging_id,
            chunk_bytes: MAX_CHUNK_BYTES as u64,
        })
    }

    /// Take one chunk.
    pub fn chunk(&self, staging_id: &str, seq: u64, payload: &[u8]) -> Result<wire::StageChunked> {
        let mut sessions = self.lock_sessions()?;
        let session = sessions
            .get_mut(staging_id)
            .ok_or_else(|| unknown_session(staging_id))?;
        if seq != session.next_seq {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "chunk {seq} arrived where {} was expected",
                    session.next_seq
                ),
            });
        }
        if payload.len() > MAX_CHUNK_BYTES {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "a chunk of {} bytes is over the {MAX_CHUNK_BYTES}-byte ceiling",
                    payload.len()
                ),
            });
        }
        if session.bytes.len() as u64 + payload.len() as u64 > session.declared_size {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "the chunks carry more bytes than the {} declared",
                    session.declared_size
                ),
            });
        }
        session.bytes.extend_from_slice(payload);
        session.next_seq += 1;
        Ok(wire::StageChunked {
            received: session.bytes.len() as u64,
        })
    }

    /// Close the session and hand back what it assembled.
    ///
    /// The session is **removed before the length is checked**: a close that
    /// failed must not leave bytes behind for a second attempt to append to.
    pub fn end(&self, staging_id: &str) -> Result<Staged> {
        let session = self
            .lock_sessions()?
            .remove(staging_id)
            .ok_or_else(|| unknown_session(staging_id))?;
        let got = session.bytes.len() as u64;
        if got != session.declared_size {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "the session declared {} bytes and {got} arrived",
                    session.declared_size
                ),
            });
        }
        Ok(Staged {
            // THE VAULT'S OWN FUNCTION. Not a digest this module chose, and not
            // one a shell declared.
            content_hash: centraid_vault::content::content_digest(&session.bytes),
            byte_size: got,
            media_type: session.media_type,
            bytes: session.bytes,
        })
    }

    /// How many sessions are open. For a shell's own refusals and for tests.
    pub fn open(&self) -> usize {
        self.sessions.lock().map(|held| held.len()).unwrap_or(0)
    }

    fn lock_sessions(&self) -> Result<std::sync::MutexGuard<'_, BTreeMap<String, Session>>> {
        self.sessions.lock().map_err(|_| poisoned())
    }
}

fn unknown_session(staging_id: &str) -> CoreError {
    CoreError::InvalidRequest {
        detail: format!("`{staging_id}` is not an open staging session"),
    }
}

fn poisoned() -> CoreError {
    CoreError::Unavailable {
        reason: "the staging table is poisoned by an earlier panic".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(size: usize) -> Vec<u8> {
        // Not zeroes: a digest over a run of zeroes would pass an assembler
        // that dropped a chunk of them.
        (0..size).map(|at| (at % 251) as u8).collect()
    }

    fn send(staging: &Staging, id: &str, bytes: &[u8]) -> Result<()> {
        for (seq, window) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
            staging.chunk(id, seq as u64, window)?;
        }
        Ok(())
    }

    /// THE HANDLE IS THE VAULT'S OWN NAME FOR THE BYTES.
    #[test]
    fn a_streamed_original_is_named_by_the_vaults_own_digest() {
        let bytes = payload(3 * 1024 * 1024);
        let staging = Staging::default();
        let begun = staging
            .begin("image/heic", bytes.len() as u64)
            .expect("begun");
        assert_eq!(begun.chunk_bytes, MAX_CHUNK_BYTES as u64);
        send(&staging, &begun.staging_id, &bytes).expect("chunked");
        let staged = staging.end(&begun.staging_id).expect("ended");
        assert_eq!(
            staged.content_hash,
            centraid_vault::content::content_digest(&bytes),
            "the handle is what the vault deduplicates on"
        );
        assert_eq!(staged.bytes, bytes);
        assert_eq!(staged.media_type, "image/heic");
        assert_eq!(staging.open(), 0, "a closed session is gone");
    }

    /// A SENDER DOES NOT CHOOSE THIS PROCESS'S MEMORY.
    #[test]
    fn more_bytes_than_declared_is_refused_at_the_chunk() {
        let staging = Staging::default();
        let begun = staging.begin("image/png", 50).expect("begun");
        assert!(staging.chunk(&begun.staging_id, 0, &payload(100)).is_err());
        assert!(staging.begin("image/png", MAX_STAGED_BYTES + 1).is_err());
    }

    /// A TRANSPOSED FRAME NAMES THE FRAME.
    #[test]
    fn a_chunk_out_of_order_is_refused_by_number() {
        let staging = Staging::default();
        let begun = staging.begin("image/png", 4096).expect("begun");
        let refused = staging
            .chunk(&begun.staging_id, 1, &payload(1024))
            .expect_err("out of order");
        assert!(
            format!("{refused}").contains("where 0 was expected"),
            "{refused}"
        );
    }

    /// A SHORT SESSION IS NOT A SMALLER PHOTOGRAPH, and it consumes the session.
    #[test]
    fn closing_early_is_refused_rather_than_truncating() {
        let staging = Staging::default();
        let begun = staging.begin("image/png", 4096).expect("begun");
        send(&staging, &begun.staging_id, &payload(1024)).expect("chunked");
        assert!(staging.end(&begun.staging_id).is_err());
        // CONSUMED: a replayed close cannot hand out a handle for bytes that
        // are gone.
        assert!(staging.end(&begun.staging_id).is_err());
        assert_eq!(staging.open(), 0);
    }

    /// A SENDER DOES NOT OPEN UNBOUNDED SESSIONS EITHER.
    #[test]
    fn a_fifth_open_session_is_refused() {
        let staging = Staging::default();
        for _ in 0..MAX_OPEN_SESSIONS {
            staging.begin("image/png", 1).expect("begun");
        }
        assert!(staging.begin("image/png", 1).is_err());
        assert_eq!(staging.open(), MAX_OPEN_SESSIONS);
    }
}
