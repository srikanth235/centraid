//! CHUNKING UNDER THE BROWSER'S 1 MiB CEILING (#1020 wave 4 lane extension,
//! D-1020-X3).
//!
//! Native messaging has a **1 MiB ceiling per message from an extension** and
//! no streaming (census §E seam 2). Two Companion methods carry page bytes —
//! `capture:document` sends a screenshot and `page:capture` sends a captured
//! document — and a 3 MB PNG is not an unusual screenshot at 2× on a tall page.
//! A host that simply refused those would be a Companion whose capture button
//! works on short pages.
//!
//! So a frame that would not fit is not sent. The extension opens a staging
//! session, sends the bytes as frames that do fit, and closes it:
//!
//! | Frame | What it carries | What the host answers |
//! |---|---|---|
//! | `stage:begin` | `media_type`, `byte_size`, `sha256` | a `staging_id` |
//! | `stage:chunk` | `staging_id`, `seq`, `bytes_b64` | the bytes received so far |
//! | `stage:end` | `staging_id` | `{sha256, byte_size}` — the handle |
//!
//! ## Four things the assembler refuses, and why each is a real failure mode
//!
//! 1. **A chunk out of order.** `seq` is checked against the next expected one.
//!    Base64 chunks that arrive transposed produce a digest mismatch at the
//!    end, which is a correct but useless error — this one names the chunk.
//! 2. **More bytes than were declared.** The declared size is the allocation,
//!    so a sender that kept chunking would otherwise be a sender that decides
//!    how much memory this process uses.
//! 3. **A digest that is not the bytes.** The whole point of answering with a
//!    handle is that the handle IS the bytes; a sha the sender asserted and
//!    nobody checked is a sha that means nothing.
//! 4. **A second `stage:end`.** The session is consumed, so a replayed close
//!    cannot hand out a second handle for bytes that are gone.
//!
//! ## Where the bytes go, and where they stop
//!
//! The assembled bytes stop at a **content-addressed handle** — a sha256 and a
//! size, which is exactly the shape `crates/apps/docs::bytes::StagedBlob` has
//! and exactly what `core.add_document`'s `staged_sha` takes. Promoting that
//! handle into `blob_staging` is the **byte door**, which lane Docs landed as an
//! app-crate trait with its implementation named as a hand-off
//! (`crates/apps/docs/src/bytes.rs`, D-1020-DC4). So `capture:document`'s
//! command carries the sha and the vault answers its own honest refusal until
//! that door lands, rather than this host inventing a second writer of the
//! staging band. Stated in `extension/README.md` and in the receipt.

use std::collections::BTreeMap;

use base64::Engine as _;

/// How large one staged chunk may be, in bytes of PAYLOAD.
///
/// 512 KiB of raw bytes is about 683 KiB of base64, which leaves room under the
/// browser's 1 MiB frame ceiling for the JSON envelope around it. The ceiling
/// is the browser's and is not negotiable, so the margin is taken here rather
/// than discovered at 1,048,577 bytes.
pub const MAX_CHUNK_BYTES: usize = 512 * 1024;

/// How many staging sessions one host process may hold open at once.
///
/// Four, because a browser port serves one member's gestures and four
/// simultaneous page captures is already generous — and because a session holds
/// its declared size in memory, so an unbounded count is an unbounded
/// allocation with extra steps.
pub const MAX_OPEN_SESSIONS: usize = 4;

/// How many bytes one staging session may declare.
///
/// 64 MiB — the browser's own ceiling on a message **to** an extension
/// ([`super::MAX_TO_EXTENSION`]), reused as the ceiling on what a capture may
/// be. A page screenshot larger than that is not a capture, and a session with
/// no ceiling is a process whose memory an extension chooses.
pub const MAX_STAGED_BYTES: u64 = super::MAX_TO_EXTENSION as u64;

/// One in-flight assembly.
#[derive(Debug)]
struct Session {
    media_type: String,
    declared_size: u64,
    declared_sha: String,
    next_seq: u64,
    bytes: Vec<u8>,
}

/// Every staging session this host holds.
///
/// One per host process, which is one per browser port: a session cannot
/// outlive the port that opened it, so nothing here needs a sweeper.
#[derive(Debug, Default)]
pub struct Staging {
    sessions: BTreeMap<String, Session>,
    minted: u64,
}

/// What a staging frame answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Staged {
    /// A session is open.
    Begun { staging_id: String },
    /// A chunk landed; this many bytes are held.
    Chunked { received: u64 },
    /// The session closed and the bytes are addressed by this digest.
    Handle { sha256: String, byte_size: u64 },
}

/// Why a staging frame was refused. One code per reason, because the sender's
/// next move differs: a bad `seq` is retryable from that chunk and a digest
/// mismatch is not retryable at all.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StageRefusal {
    #[error("`{0}` is not an open staging session")]
    UnknownSession(String),
    #[error("chunk {got} arrived where {expected} was expected")]
    OutOfOrder { expected: u64, got: u64 },
    #[error("a chunk of {0} bytes is over the {MAX_CHUNK_BYTES}-byte chunk ceiling")]
    ChunkTooLarge(usize),
    #[error("the chunks carry more bytes than the {declared} declared")]
    Overrun { declared: u64 },
    #[error("the session declared {declared} bytes and {got} arrived")]
    Short { declared: u64, got: u64 },
    #[error("the assembled bytes are not the digest the sender declared")]
    DigestMismatch,
    #[error("{0} is over the {MAX_STAGED_BYTES}-byte staging ceiling")]
    TooLarge(u64),
    #[error("a staged capture declares a sha256 as 64 hex characters")]
    MalformedDigest,
    #[error("a chunk that is not base64")]
    MalformedChunk,
    #[error("{MAX_OPEN_SESSIONS} staging sessions are already open on this port")]
    TooManySessions,
}

impl Staging {
    /// Open a session for a declared size and digest.
    pub fn begin(
        &mut self,
        media_type: &str,
        byte_size: u64,
        sha256: &str,
    ) -> Result<Staged, StageRefusal> {
        if byte_size > MAX_STAGED_BYTES {
            return Err(StageRefusal::TooLarge(byte_size));
        }
        if self.open() >= MAX_OPEN_SESSIONS {
            return Err(StageRefusal::TooManySessions);
        }
        if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(StageRefusal::MalformedDigest);
        }
        self.minted += 1;
        let staging_id = format!("stage-{}", self.minted);
        self.sessions.insert(
            staging_id.clone(),
            Session {
                media_type: media_type.to_owned(),
                declared_size: byte_size,
                declared_sha: sha256.to_ascii_lowercase(),
                next_seq: 0,
                // THE DECLARED SIZE IS THE ALLOCATION. Reserving it here and
                // refusing anything past it is what makes the overrun check a
                // bound rather than a report.
                bytes: Vec::with_capacity(usize::try_from(byte_size).unwrap_or(0)),
            },
        );
        Ok(Staged::Begun { staging_id })
    }

    /// Take one chunk.
    pub fn chunk(
        &mut self,
        staging_id: &str,
        seq: u64,
        bytes_b64: &str,
    ) -> Result<Staged, StageRefusal> {
        let session = self
            .sessions
            .get_mut(staging_id)
            .ok_or_else(|| StageRefusal::UnknownSession(staging_id.to_owned()))?;
        if seq != session.next_seq {
            return Err(StageRefusal::OutOfOrder {
                expected: session.next_seq,
                got: seq,
            });
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(bytes_b64)
            .map_err(|_| StageRefusal::MalformedChunk)?;
        if bytes.len() > MAX_CHUNK_BYTES {
            return Err(StageRefusal::ChunkTooLarge(bytes.len()));
        }
        let would_be = session.bytes.len() as u64 + bytes.len() as u64;
        if would_be > session.declared_size {
            return Err(StageRefusal::Overrun {
                declared: session.declared_size,
            });
        }
        session.bytes.extend_from_slice(&bytes);
        session.next_seq += 1;
        Ok(Staged::Chunked {
            received: session.bytes.len() as u64,
        })
    }

    /// Close the session and answer the handle.
    ///
    /// The session is **removed before the digest is checked**: a close that
    /// failed must not leave bytes behind for a second attempt to append to.
    pub fn end(&mut self, staging_id: &str) -> Result<(Staged, Vec<u8>, String), StageRefusal> {
        let session = self
            .sessions
            .remove(staging_id)
            .ok_or_else(|| StageRefusal::UnknownSession(staging_id.to_owned()))?;
        let got = session.bytes.len() as u64;
        if got != session.declared_size {
            return Err(StageRefusal::Short {
                declared: session.declared_size,
                got,
            });
        }
        let digest = sha256_hex(&session.bytes);
        if digest != session.declared_sha {
            return Err(StageRefusal::DigestMismatch);
        }
        Ok((
            Staged::Handle {
                sha256: digest,
                byte_size: got,
            },
            session.bytes,
            session.media_type,
        ))
    }

    /// How many sessions are open. For the host's own refusals and for tests.
    #[must_use]
    pub fn open(&self) -> usize {
        self.sessions.len()
    }
}

/// The digest, lowercase hex.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .fold(String::with_capacity(64), |mut text, byte| {
            use std::fmt::Write as _;
            let _ = write!(text, "{byte:02x}");
            text
        })
}

/// How many chunks a payload of this size takes, as the sender plans it.
///
/// Exported so the host and the extension plan the same split: the extension's
/// `stage-core.ts` computes it too, and `contracts/extension/frames.json` pins
/// one worked case at 3 MB so the two cannot disagree about the last chunk.
#[must_use]
pub const fn chunk_count(byte_size: u64) -> u64 {
    if byte_size == 0 {
        return 0;
    }
    byte_size.div_ceil(MAX_CHUNK_BYTES as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(size: usize) -> Vec<u8> {
        // Not zeroes: a digest over a run of zeroes would pass a broken
        // assembler that dropped a chunk of them.
        (0..size).map(|at| (at % 251) as u8).collect()
    }

    fn send(staging: &mut Staging, id: &str, bytes: &[u8]) -> Result<(), StageRefusal> {
        for (seq, window) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
            staging.chunk(
                id,
                seq as u64,
                &base64::engine::general_purpose::STANDARD.encode(window),
            )?;
        }
        Ok(())
    }

    /// THE 3 MB CASE, end to end: seven chunks, a handle, and the bytes back.
    #[test]
    fn a_three_megabyte_capture_stages_in_chunks_and_answers_a_handle() {
        let bytes = payload(3 * 1024 * 1024);
        let digest = sha256_hex(&bytes);
        let mut staging = Staging::default();
        let Staged::Begun { staging_id } = staging
            .begin("image/png", bytes.len() as u64, &digest)
            .expect("begun")
        else {
            panic!("begin answers a staging id");
        };
        assert_eq!(chunk_count(bytes.len() as u64), 6);
        send(&mut staging, &staging_id, &bytes).expect("chunked");
        let (staged, assembled, media_type) = staging.end(&staging_id).expect("ended");
        assert_eq!(
            staged,
            Staged::Handle {
                sha256: digest,
                byte_size: bytes.len() as u64,
            }
        );
        assert_eq!(assembled, bytes, "the handle addresses these bytes");
        assert_eq!(media_type, "image/png");
        assert_eq!(staging.open(), 0, "a closed session is gone");
    }

    /// EVERY CHUNK FITS. The point of the whole layer.
    #[test]
    fn no_chunk_frame_reaches_the_browsers_ceiling() {
        let bytes = payload(3 * 1024 * 1024);
        for window in bytes.chunks(MAX_CHUNK_BYTES) {
            let frame = serde_json::json!({
                "t": "stage:chunk",
                "staging_id": "stage-1",
                "seq": 0,
                "bytes_b64": base64::engine::general_purpose::STANDARD.encode(window),
            });
            let encoded = serde_json::to_vec(&frame).expect("encoded");
            assert!(
                encoded.len() < super::super::MAX_FROM_EXTENSION as usize,
                "a chunk frame is {} bytes, over the browser's ceiling",
                encoded.len()
            );
        }
    }

    /// A TRANSPOSED CHUNK IS NAMED, not discovered as a digest mismatch.
    #[test]
    fn a_chunk_out_of_order_names_the_chunk() {
        let bytes = payload(2 * MAX_CHUNK_BYTES);
        let mut staging = Staging::default();
        let Staged::Begun { staging_id } = staging
            .begin("image/png", bytes.len() as u64, &sha256_hex(&bytes))
            .expect("begun")
        else {
            panic!("a staging id");
        };
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes[..MAX_CHUNK_BYTES]);
        assert_eq!(
            staging.chunk(&staging_id, 1, &encoded),
            Err(StageRefusal::OutOfOrder {
                expected: 0,
                got: 1
            })
        );
    }

    /// A SENDER DOES NOT CHOOSE THIS PROCESS'S MEMORY.
    #[test]
    fn more_bytes_than_declared_is_refused_at_the_chunk() {
        let mut staging = Staging::default();
        let bytes = payload(100);
        let Staged::Begun { staging_id } = staging
            .begin("image/png", 50, &sha256_hex(&bytes[..50]))
            .expect("begun")
        else {
            panic!("a staging id");
        };
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        assert_eq!(
            staging.chunk(&staging_id, 0, &encoded),
            Err(StageRefusal::Overrun { declared: 50 })
        );
        assert!(
            staging
                .begin("image/png", MAX_STAGED_BYTES + 1, &sha256_hex(&bytes))
                .is_err()
        );
    }

    /// THE HANDLE IS THE BYTES. A declared digest that is not them is refused,
    /// and the session is gone either way.
    #[test]
    fn a_digest_that_is_not_the_bytes_is_refused_and_consumes_the_session() {
        let bytes = payload(1024);
        let mut staging = Staging::default();
        let lie = "0".repeat(64);
        let Staged::Begun { staging_id } = staging.begin("image/png", 1024, &lie).expect("begun")
        else {
            panic!("a staging id");
        };
        send(&mut staging, &staging_id, &bytes).expect("chunked");
        assert_eq!(staging.end(&staging_id), Err(StageRefusal::DigestMismatch));
        // CONSUMED: a replayed close cannot hand out a second handle.
        assert_eq!(
            staging.end(&staging_id),
            Err(StageRefusal::UnknownSession(staging_id))
        );
    }

    /// A SHORT SESSION IS NOT A SMALLER CAPTURE.
    #[test]
    fn closing_early_is_refused_rather_than_truncating() {
        let bytes = payload(4096);
        let mut staging = Staging::default();
        let Staged::Begun { staging_id } = staging
            .begin("image/png", bytes.len() as u64, &sha256_hex(&bytes))
            .expect("begun")
        else {
            panic!("a staging id");
        };
        send(&mut staging, &staging_id, &bytes[..1024]).expect("chunked");
        assert_eq!(
            staging.end(&staging_id),
            Err(StageRefusal::Short {
                declared: 4096,
                got: 1024
            })
        );
    }

    /// A SENDER DOES NOT OPEN UNBOUNDED SESSIONS EITHER.
    #[test]
    fn a_fifth_open_session_is_refused() {
        let mut staging = Staging::default();
        let digest = sha256_hex(b"x");
        for _ in 0..MAX_OPEN_SESSIONS {
            staging.begin("image/png", 1, &digest).expect("begun");
        }
        assert_eq!(
            staging.begin("image/png", 1, &digest),
            Err(StageRefusal::TooManySessions)
        );
        assert_eq!(staging.open(), MAX_OPEN_SESSIONS);
    }

    /// A MALFORMED DIGEST NEVER OPENS A SESSION.
    #[test]
    fn a_declared_digest_is_sixty_four_hex_characters() {
        let mut staging = Staging::default();
        for bad in ["", "abc", &"z".repeat(64), &"a".repeat(63), &"A".repeat(65)] {
            assert_eq!(
                staging.begin("image/png", 1, bad),
                Err(StageRefusal::MalformedDigest),
                "{bad:?}"
            );
        }
        assert_eq!(staging.open(), 0);
    }

    /// The split the two sides plan is the same split.
    #[test]
    fn the_chunk_count_is_arithmetic_both_sides_can_do() {
        assert_eq!(chunk_count(0), 0);
        assert_eq!(chunk_count(1), 1);
        assert_eq!(chunk_count(MAX_CHUNK_BYTES as u64), 1);
        assert_eq!(chunk_count(MAX_CHUNK_BYTES as u64 + 1), 2);
        assert_eq!(chunk_count(3 * 1024 * 1024), 6);
    }
}
