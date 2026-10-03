//! A SHELL STREAMS BYTES IN AND THE CORE NAMES THEM (#1025 S4, D-1025-S4-6;
//! the stage door v2, [#1080](https://github.com/srikanth235/centraid/issues/1080)).
//!
//! ## Why the core names the bytes
//!
//! The identity of a member's bytes is `core_content_item.content_hash`,
//! which is **BLAKE3** (D-1025-S4-1) and is UNIQUE, and neither iOS nor
//! Android offers BLAKE3. A shell that named its own bytes would be computing a
//! different function's value under the vault's name. So the shell moves bytes
//! and the core names them.
//!
//! ## Three frames, because the C ABI takes one buffer
//!
//! | Frame | Carries | Answers |
//! |---|---|---|
//! | `begin` | the media type, the declared size, where the bytes live, a derivative's parent and tier | a `staging_id` and the chunk ceiling |
//! | `chunk` | `staging_id`, `seq`, `payload` | bytes received so far |
//! | `end` | `staging_id` | `{content_hash, byte_size, already_held}` |
//!
//! ## Where the bytes go: never into memory (#1080 ruling 6)
//!
//! - **Owned bytes** — an edit, a document, a download, and every derivative —
//!   stream into the app's content store as they arrive, hashed as they are
//!   written, and are named when they end (`centraid_blobs::Writer`). A film
//!   is never in memory: the 512 MiB buffer this door used to fill is gone.
//! - **Bytes the operating system's library holds** are hashed as they stream
//!   and, when a gateway is paired and the spool has room, sealed into the
//!   spool **in the same stream** (`centraid_media::sealed::FileSealer`, the
//!   root's ruling A8). No plaintext copy is kept: the library has the bytes,
//!   and the ledger records where (`local_bytes`), so a grid asks the shell
//!   for them by the library's own identifier. When room runs out mid-file
//!   the sealed parts are dropped and the bytes are only hashed; the item
//!   waits, and a pass asks for it again (`NeedBytes`).
//!
//! ## The refusals, each a real failure mode
//!
//! 1. **A chunk out of order.** `seq` is checked against the next expected one,
//!    so a shell whose frames raced names the frame rather than minting bytes
//!    nobody asked for.
//! 2. **More bytes than were declared**, when a size was declared: a sender
//!    does not decide how much this process takes.
//! 3. **A short close**, when a size was declared: a truncated file is the
//!    failure that survives every structural check and surfaces months later
//!    as a photograph that will not open.
//! 4. **A begin that contradicts itself**: a library item with no identifier,
//!    owned bytes with one, a derivative with no parent or no tier, a
//!    derivative from the library.
//!
//! A replayed close is refused too: the session is removed before anything
//! else happens, so it cannot hand out a second handle.
//!
//! ## `already_held` is a product fact, not a statistic
//!
//! Re-scanning a camera roll is the ordinary case. A shell that could not tell
//! whether the core already had a photograph would re-send the roll on every
//! scan, so the core says: the app's store had these bytes, or the ledger had
//! recorded them in the library.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use centraid_api_proto::core_v1 as wire;
use centraid_media::sealed::{BackupKeys, FileSeal, FileSealer, PlaintextHash};
use centraid_vault::backup::spool::Spool;

use crate::error::{CoreError, Result};

/// How many bytes one `chunk` frame may carry.
///
/// 512 KiB, because the C ABI copies each request buffer across the boundary,
/// so a frame is a transient allocation on both sides of it. A shell that
/// wants fewer round trips raises its own read size, not this.
pub const MAX_CHUNK_BYTES: usize = 512 * 1024;

/// How many sessions one core may hold open at once.
///
/// Four, because a roll import is sequential, and every open session holds a
/// file and, for a library item, its sealed parts so far.
pub const MAX_OPEN_SESSIONS: usize = 4;

/// The tiers a shell may stage a derivative as.
pub const TIERS: [&str; 3] = ["thumb", "preview", "poster"];

/// The parts sealed beside a library item's stream.
type PartPaths = Box<dyn FnMut(u32) -> PathBuf + Send>;

/// What the door needs from the core to take a session.
pub struct Doors {
    /// The app's content store; `None` refuses owned bytes.
    pub store: Option<centraid_blobs::ByteStore>,
    /// Where a library item is sealed as it streams: present only when a
    /// gateway is paired and this core holds the vault's keys.
    pub seal: Option<SealInto>,
}

/// The spool a library item is sealed into, and how much it may take.
pub struct SealInto {
    pub keys: BackupKeys,
    pub spool: Spool,
    pub budget: u64,
}

struct LibrarySeal {
    sealer: FileSealer<PartPaths>,
    held: u64,
    budget: u64,
}

enum Holding {
    Owned {
        // BOXED, as the library's state is: a write hashes as it goes.
        writer: Box<centraid_blobs::Writer>,
        /// `(for_hash hex, tier)` for a derivative.
        derivative: Option<(String, String)>,
    },
    Library {
        os_ref: String,
        edited: bool,
        // BOXED: a hasher and a sealer are kilobytes of state, and a session
        // table of owned writers should not be sized for them.
        hasher: Box<blake3::Hasher>,
        seal: Option<Box<LibrarySeal>>,
    },
}

struct Session {
    media_type: String,
    declared: Option<u64>,
    next_seq: u64,
    received: u64,
    holding: Holding,
}

/// Every open staging session on one core.
#[derive(Default)]
pub struct Staging {
    sessions: Mutex<BTreeMap<String, Session>>,
    minted: Mutex<u64>,
}

impl std::fmt::Debug for Staging {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Staging")
            .field("open", &self.open())
            .finish()
    }
}

/// What a completed session produced, for the core to record.
pub enum Staged {
    /// Owned bytes, in the content store.
    Owned {
        stored: centraid_blobs::Stored,
        media_type: String,
        /// `(for_hash hex, tier)` for a derivative.
        derivative: Option<(String, String)>,
    },
    /// A library item, hashed; sealed into temp parts when room allowed.
    Library {
        h: PlaintextHash,
        len: u64,
        media_type: String,
        os_ref: String,
        edited: bool,
        sealed: Option<FileSeal>,
    },
}

fn invalid(detail: impl Into<String>) -> CoreError {
    CoreError::InvalidRequest {
        detail: detail.into(),
    }
}

/// Read a `begin`'s fields, refusing the ones that contradict each other.
fn source_of(begin: &wire::StageBegin) -> Result<(bool, Option<(String, String)>)> {
    let library = match wire::StageSource::try_from(begin.source) {
        Ok(wire::StageSource::Unspecified | wire::StageSource::Owned) => false,
        Ok(wire::StageSource::OsLibrary) => true,
        Err(_) => return Err(invalid(format!("{} is not a stage source", begin.source))),
    };
    if library == begin.os_ref.is_empty() {
        return Err(invalid(if library {
            "an item from the library names its identifier (`os_ref`)"
        } else {
            "owned bytes carry no library identifier"
        }));
    }
    if begin.os_edited && !library {
        return Err(invalid(
            "only a library item can have been edited in the library",
        ));
    }
    let derivative = match (begin.for_hash.is_empty(), begin.tier.is_empty()) {
        (true, true) => None,
        (false, false) => {
            let parent = <[u8; 32]>::try_from(begin.for_hash.as_slice())
                .map_err(|_| invalid("`for_hash` is a 32-byte content hash"))?;
            if !TIERS.contains(&begin.tier.as_str()) {
                return Err(invalid(format!(
                    "`{}` is not a tier: thumb, preview or poster",
                    begin.tier
                )));
            }
            if library {
                return Err(invalid(
                    "a derivative is the app's own bytes, never the library's",
                ));
            }
            Some((hex::encode(parent), begin.tier.clone()))
        }
        _ => return Err(invalid("a derivative names both its parent and its tier")),
    };
    Ok((library, derivative))
}

impl Staging {
    /// Open a session.
    ///
    /// # Errors
    /// [`CoreError::InvalidRequest`] for a `begin` that contradicts itself or
    /// a fifth open session; [`CoreError::Unavailable`] for owned bytes on a
    /// core with no content store.
    pub fn begin(&self, begin: &wire::StageBegin, doors: Doors) -> Result<wire::StageBegun> {
        let (library, derivative) = source_of(begin)?;
        let mut sessions = self.lock_sessions()?;
        if sessions.len() >= MAX_OPEN_SESSIONS {
            return Err(invalid(format!(
                "{MAX_OPEN_SESSIONS} staging sessions are already open"
            )));
        }
        let staging_id = {
            let mut minted = self.minted.lock().map_err(|_| poisoned())?;
            *minted += 1;
            format!("stage-{minted}")
        };
        let declared = (begin.byte_size > 0).then_some(begin.byte_size);
        let holding = if library {
            Holding::Library {
                os_ref: begin.os_ref.clone(),
                edited: begin.os_edited,
                hasher: Box::new(blake3::Hasher::new()),
                seal: doors.seal.and_then(|into| {
                    let held = into.spool.bytes().ok()?;
                    if held >= into.budget {
                        return None;
                    }
                    let spool = into.spool.clone();
                    let tag = staging_id.clone();
                    let paths: PartPaths = Box::new(move |index| spool.temp_path(&tag, index));
                    Some(Box::new(LibrarySeal {
                        // MEDIA IS NOT COMPRESSED (#1080, the sealed format):
                        // a photograph or a film is already compressed.
                        sealer: FileSealer::new(&into.keys, false, declared, paths),
                        held,
                        budget: into.budget,
                    }))
                }),
            }
        } else {
            let store = doors.store.ok_or_else(|| CoreError::Unavailable {
                reason: "this core has no content store, so it cannot keep staged bytes".to_owned(),
            })?;
            Holding::Owned {
                writer: Box::new(store.writer().map_err(|error| CoreError::Unavailable {
                    reason: format!("the content store would not take a write: {error}"),
                })?),
                derivative,
            }
        };
        sessions.insert(
            staging_id.clone(),
            Session {
                media_type: begin.media_type.clone(),
                declared,
                next_seq: 0,
                received: 0,
                holding,
            },
        );
        Ok(wire::StageBegun {
            staging_id,
            chunk_bytes: MAX_CHUNK_BYTES as u64,
        })
    }

    /// Take one chunk.
    ///
    /// # Errors
    /// [`CoreError::InvalidRequest`] for an unknown session, a chunk out of
    /// order or over the ceiling, or bytes past the declared size;
    /// [`CoreError::Unavailable`] when the store will not take them. A session
    /// that refused a write is closed.
    pub fn chunk(&self, staging_id: &str, seq: u64, payload: &[u8]) -> Result<wire::StageChunked> {
        let mut sessions = self.lock_sessions()?;
        let session = sessions
            .get_mut(staging_id)
            .ok_or_else(|| unknown_session(staging_id))?;
        if seq != session.next_seq {
            return Err(invalid(format!(
                "chunk {seq} arrived where {} was expected",
                session.next_seq
            )));
        }
        if payload.len() > MAX_CHUNK_BYTES {
            return Err(invalid(format!(
                "a chunk of {} bytes is over the {MAX_CHUNK_BYTES}-byte ceiling",
                payload.len()
            )));
        }
        let after = session.received.saturating_add(payload.len() as u64);
        if let Some(declared) = session.declared
            && after > declared
        {
            return Err(invalid(format!(
                "the chunks carry more bytes than the {declared} declared"
            )));
        }
        let written = match &mut session.holding {
            Holding::Owned { writer, .. } => {
                writer
                    .write(payload)
                    .map_err(|error| CoreError::Unavailable {
                        reason: format!("the content store would not take the bytes: {error}"),
                    })
            }
            Holding::Library { hasher, seal, .. } => {
                hasher.update(payload);
                if let Some(open) = seal {
                    // ROOM, AS IT GOES: when the parts sealed so far would
                    // pass the spool's budget they are dropped — the sealer
                    // removes its temp files — and the bytes are only hashed.
                    let fits = open.held.saturating_add(after) <= open.budget;
                    if !fits || open.sealer.update(payload).is_err() {
                        *seal = None;
                    }
                }
                Ok(())
            }
        };
        if let Err(error) = written {
            sessions.remove(staging_id);
            return Err(error);
        }
        session.received = after;
        session.next_seq += 1;
        Ok(wire::StageChunked { received: after })
    }

    /// Close the session and hand back what it produced.
    ///
    /// The session is **removed before the length is checked**: a close that
    /// failed must not leave bytes behind for a second attempt to append to.
    ///
    /// # Errors
    /// [`CoreError::InvalidRequest`] for an unknown session or a short one;
    /// [`CoreError::Unavailable`] when the store will not keep the bytes.
    pub fn end(&self, staging_id: &str) -> Result<Staged> {
        let session = self
            .lock_sessions()?
            .remove(staging_id)
            .ok_or_else(|| unknown_session(staging_id))?;
        if let Some(declared) = session.declared
            && session.received != declared
        {
            return Err(invalid(format!(
                "the session declared {declared} bytes and {} arrived",
                session.received
            )));
        }
        Ok(match session.holding {
            Holding::Owned { writer, derivative } => Staged::Owned {
                stored: (*writer).finish().map_err(|error| CoreError::Unavailable {
                    reason: format!("the staged bytes could not be kept: {error}"),
                })?,
                media_type: session.media_type,
                derivative,
            },
            Holding::Library {
                os_ref,
                edited,
                hasher,
                seal,
            } => {
                let h = PlaintextHash::from_bytes(*hasher.finalize().as_bytes());
                let sealed = seal
                    .and_then(|open| open.sealer.finish().ok())
                    .filter(|sealed| sealed.h == h && sealed.len == session.received);
                Staged::Library {
                    h,
                    len: session.received,
                    media_type: session.media_type,
                    os_ref,
                    edited,
                    sealed,
                }
            }
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
    invalid(format!("`{staging_id}` is not an open staging session"))
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

    struct Rig {
        _dir: tempfile::TempDir,
        store: centraid_blobs::ByteStore,
        spool: Spool,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().expect("a directory");
        let store = centraid_blobs::ByteStore::open(dir.path().join("v.bytes")).expect("a store");
        let spool = Spool::open(dir.path().join("v.spool")).expect("a spool");
        Rig {
            _dir: dir,
            store,
            spool,
        }
    }

    impl Rig {
        fn doors(&self, budget: Option<u64>) -> Doors {
            Doors {
                store: Some(self.store.clone()),
                seal: budget.map(|budget| SealInto {
                    keys: BackupKeys::from_root(&[7; 32]),
                    spool: self.spool.clone(),
                    budget,
                }),
            }
        }
    }

    fn owned(media_type: &str, size: u64) -> wire::StageBegin {
        wire::StageBegin {
            media_type: media_type.to_owned(),
            byte_size: size,
            ..wire::StageBegin::default()
        }
    }

    /// THE HANDLE IS THE VAULT'S OWN NAME FOR THE BYTES, and owned bytes land
    /// in the store, streamed.
    #[test]
    fn a_streamed_original_is_named_by_the_vaults_own_digest() {
        let rig = rig();
        let bytes = payload(3 * 1024 * 1024);
        let staging = Staging::default();
        let begun = staging
            .begin(&owned("image/heic", bytes.len() as u64), rig.doors(None))
            .expect("begun");
        assert_eq!(begun.chunk_bytes, MAX_CHUNK_BYTES as u64);
        send(&staging, &begun.staging_id, &bytes).expect("chunked");
        let Staged::Owned {
            stored, media_type, ..
        } = staging.end(&begun.staging_id).expect("ended")
        else {
            panic!("owned bytes stage as owned");
        };
        assert_eq!(
            stored.hash.to_hex(),
            centraid_vault::content::content_digest(&bytes),
            "the handle is what the vault deduplicates on"
        );
        assert_eq!(std::fs::read(&stored.path).expect("reads"), bytes);
        assert_eq!(media_type, "image/heic");
        assert_eq!(staging.open(), 0, "a closed session is gone");
    }

    /// A SENDER DOES NOT CHOOSE THIS PROCESS'S MEMORY, when it declared a size.
    #[test]
    fn more_bytes_than_declared_is_refused_at_the_chunk() {
        let rig = rig();
        let staging = Staging::default();
        let begun = staging
            .begin(&owned("image/png", 50), rig.doors(None))
            .expect("begun");
        assert!(staging.chunk(&begun.staging_id, 0, &payload(100)).is_err());
    }

    /// A TRANSPOSED FRAME NAMES THE FRAME.
    #[test]
    fn a_chunk_out_of_order_is_refused_by_number() {
        let rig = rig();
        let staging = Staging::default();
        let begun = staging
            .begin(&owned("image/png", 4096), rig.doors(None))
            .expect("begun");
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
        let rig = rig();
        let staging = Staging::default();
        let begun = staging
            .begin(&owned("image/png", 4096), rig.doors(None))
            .expect("begun");
        send(&staging, &begun.staging_id, &payload(1024)).expect("chunked");
        assert!(staging.end(&begun.staging_id).is_err());
        // CONSUMED: a replayed close cannot hand out a handle for bytes that
        // are gone.
        assert!(staging.end(&begun.staging_id).is_err());
        assert_eq!(staging.open(), 0);
        assert!(
            rig.store.hashes().expect("lists").is_empty(),
            "nothing was kept"
        );
    }

    /// AN UNDECLARED SIZE IS TAKEN AS IT ARRIVES (#1080): the library does not
    /// always know a length before the read.
    #[test]
    fn an_undeclared_size_takes_what_arrives() {
        let rig = rig();
        let staging = Staging::default();
        let begun = staging
            .begin(&owned("video/quicktime", 0), rig.doors(None))
            .expect("begun");
        let bytes = payload(MAX_CHUNK_BYTES * 2 + 17);
        send(&staging, &begun.staging_id, &bytes).expect("chunked");
        let Staged::Owned { stored, .. } = staging.end(&begun.staging_id).expect("ended") else {
            panic!("owned");
        };
        assert_eq!(stored.bytes, bytes.len() as u64);
    }

    /// A SENDER DOES NOT OPEN UNBOUNDED SESSIONS EITHER.
    #[test]
    fn a_fifth_open_session_is_refused() {
        let rig = rig();
        let staging = Staging::default();
        for _ in 0..MAX_OPEN_SESSIONS {
            staging
                .begin(&owned("image/png", 1), rig.doors(None))
                .expect("begun");
        }
        assert!(
            staging
                .begin(&owned("image/png", 1), rig.doors(None))
                .is_err()
        );
        assert_eq!(staging.open(), MAX_OPEN_SESSIONS);
    }

    /// A BEGIN THAT CONTRADICTS ITSELF is refused before a byte is taken.
    #[test]
    fn a_begin_that_contradicts_itself_is_refused() {
        let rig = rig();
        let staging = Staging::default();
        let library = |os_ref: &str| wire::StageBegin {
            media_type: "image/heic".to_owned(),
            byte_size: 10,
            source: wire::StageSource::OsLibrary as i32,
            os_ref: os_ref.to_owned(),
            ..wire::StageBegin::default()
        };
        for begin in [
            library(""),
            wire::StageBegin {
                os_ref: "item-1".to_owned(),
                ..owned("image/jpeg", 10)
            },
            wire::StageBegin {
                os_edited: true,
                ..owned("image/jpeg", 10)
            },
            wire::StageBegin {
                for_hash: vec![1; 32],
                ..owned("image/jpeg", 10)
            },
            wire::StageBegin {
                for_hash: vec![1; 31],
                tier: "thumb".to_owned(),
                ..owned("image/jpeg", 10)
            },
            wire::StageBegin {
                for_hash: vec![1; 32],
                tier: "huge".to_owned(),
                ..owned("image/jpeg", 10)
            },
            wire::StageBegin {
                for_hash: vec![1; 32],
                tier: "thumb".to_owned(),
                ..library("item-1")
            },
            wire::StageBegin {
                source: 99,
                ..owned("image/jpeg", 10)
            },
        ] {
            assert!(
                matches!(
                    staging.begin(&begin, rig.doors(Some(u64::MAX))),
                    Err(CoreError::InvalidRequest { .. })
                ),
                "{begin:?}"
            );
        }
        assert_eq!(staging.open(), 0);
    }

    fn library(size: u64) -> wire::StageBegin {
        wire::StageBegin {
            media_type: "image/heic".to_owned(),
            byte_size: size,
            source: wire::StageSource::OsLibrary as i32,
            os_ref: "library-item-9".to_owned(),
            os_edited: true,
            ..wire::StageBegin::default()
        }
    }

    /// **A8: a library item is hashed and sealed in one stream, and no
    /// plaintext copy is kept.** Its parts are named once its hash is known.
    #[test]
    fn a_library_item_is_sealed_as_it_streams_and_never_kept() {
        let rig = rig();
        let staging = Staging::default();
        let bytes = payload(1_500_000);
        let begun = staging
            .begin(&library(bytes.len() as u64), rig.doors(Some(u64::MAX)))
            .expect("begun");
        send(&staging, &begun.staging_id, &bytes).expect("chunked");
        let Staged::Library {
            h,
            len,
            os_ref,
            edited,
            sealed,
            ..
        } = staging.end(&begun.staging_id).expect("ended")
        else {
            panic!("a library item stages as one");
        };
        assert_eq!(h, PlaintextHash::of(&bytes));
        assert_eq!(len, bytes.len() as u64);
        assert_eq!((os_ref.as_str(), edited), ("library-item-9", true));
        let sealed = sealed.expect("sealed beside the stream");
        assert_eq!(sealed.h, h);
        assert_eq!(sealed.parts.len(), 1);
        let keys = BackupKeys::from_root(&[7; 32]);
        assert_eq!(
            sealed.parts[0].name,
            centraid_media::sealed::name(&keys, &h, 0)
        );
        let sealed_bytes = std::fs::read(&sealed.parts[0].path).expect("the temp part");
        assert_eq!(
            centraid_media::sealed::open_whole(&keys, &sealed.parts[0].name, &sealed_bytes)
                .expect("opens"),
            bytes
        );
        assert!(
            rig.store.hashes().expect("lists").is_empty(),
            "the library's bytes are not copied into the app"
        );
    }

    /// ROOM RUNS OUT MID-FILE: the parts are dropped, the bytes are still
    /// hashed, and the item waits to be asked for again.
    #[test]
    fn a_library_item_past_the_spool_budget_is_hashed_and_not_sealed() {
        let rig = rig();
        let staging = Staging::default();
        let bytes = payload(MAX_CHUNK_BYTES * 3);
        let begun = staging
            .begin(
                &library(bytes.len() as u64),
                rig.doors(Some(MAX_CHUNK_BYTES as u64)),
            )
            .expect("begun");
        send(&staging, &begun.staging_id, &bytes).expect("chunked");
        let Staged::Library { h, sealed, .. } = staging.end(&begun.staging_id).expect("ended")
        else {
            panic!("library");
        };
        assert_eq!(h, PlaintextHash::of(&bytes));
        assert!(sealed.is_none(), "nothing sealed past the budget");
        let leftovers: Vec<_> = std::fs::read_dir(rig.spool.dir()).expect("lists").collect();
        assert!(
            leftovers.is_empty(),
            "the temp parts were dropped: {leftovers:?}"
        );
    }
}
