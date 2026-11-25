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
//! ## Four frames, because the C ABI takes one buffer
//!
//! | Frame | Carries | Answers |
//! |---|---|---|
//! | `begin` | the media type, the declared size, where the bytes live, a derivative's parent and tier | a `staging_id` and the chunk ceiling |
//! | `chunk` | `staging_id`, `seq`, `payload` | bytes received so far |
//! | `end` | `staging_id` | `{content_hash, byte_size, already_held}` |
//! | `abort` | `staging_id` | nothing; the session and its partial bytes are gone |
//!
//! ## A session never outlives its sender (#1202)
//!
//! Four sessions may be open, so one that is never closed would, after four,
//! refuse every later stage until the process restarted. Three things close a
//! session: `end`, a `chunk` the core refuses (any refusal, not only a failed
//! write), and `abort`, which a shell sends when its own read broke or its
//! task was cancelled between frames. A shell that could not send even that (a
//! killed task) is covered by the third: a session idle for
//! [`IDLE_LIMIT`] is reaped when the next `begin` finds the table full.
//!
//! ## Where the bytes go: never into memory (#1080 ruling 6)
//!
//! - **Owned bytes** — an edit, a document, a download, and every derivative —
//!   stream into the app's content store as they arrive, hashed as they are
//!   written, and are named when they end (`centraid_blobs::Writer`). A film
//!   is never in memory: the 512 MiB buffer this door used to fill is gone.
//! - **Bytes the operating system's library holds** are hashed as they stream and **nothing is
//!   sealed at import** (#1209): objects are rebuilt from their source whenever they are owed,
//!   and the library is the source. No plaintext copy is kept: the ledger records where
//!   (`local_bytes`), so a grid asks the shell for them by the library's own identifier.
//! - **An item a pass asked for** (`NeedBytes`) streams again, and this time its chunks are
//!   sealed as they go (`centraid_media::sealed`, class originals, one object per 4 MiB chunk)
//!   into the staging area (`centraid_vault::backup::staging`, spec §6.4), **only the chunks
//!   some gateway is owed** ([`Planned::owed`]) and only as far as the budget allows. The refs of
//!   every chunk are recorded whatever fits, so the next snapshot lists the whole original and a
//!   video larger than staging goes a window at a time. A stream that does not hash to the item
//!   the pass asked for stages nothing.
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

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use centraid_api_proto::core_v1 as wire;
use centraid_media::sealed::{self, BackupKeys, CHUNK_BYTES, Class, Name, PlaintextHash, Ref};
use centraid_vault::backup::staging::Staging as StagingArea;

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
/// file and, for a library item, its sealed chunks so far.
pub const MAX_OPEN_SESSIONS: usize = 4;

/// How long a session may sit without a frame before the next `begin` may
/// reap it. Ten minutes: a 100 MB file on a slow cloud provider still sends a
/// chunk well inside it, and a session past it has lost its sender.
pub const IDLE_LIMIT: Duration = Duration::from_secs(10 * 60);

/// The tiers a shell may stage a derivative as.
pub const TIERS: [&str; 3] = ["thumb", "preview", "poster"];

/// What the door needs from the core to take a session.
pub struct Doors {
    /// The app's content store; `None` refuses owned bytes.
    pub store: Option<centraid_blobs::ByteStore>,
    /// Where a library item the pass asked for is sealed as it streams: present only when a
    /// gateway is paired and this core holds the vault's keys.
    pub seal: Option<SealInto>,
    /// A single OS original selected by an active Rust-owned whole-vault export.
    pub export: Option<ExportArchiveInto>,
}

/// The immutable photo descriptor the Rust export job is waiting for.
pub struct ExportArchiveInto {
    pub job_id: String,
    pub photo_id: String,
    pub hash: [u8; 32],
    pub byte_size: u64,
    pub media_type: String,
    pub staging_dir: PathBuf,
    pub cancelled: std::sync::Arc<AtomicBool>,
}

/// The staging area a library item is sealed into.
pub struct SealInto {
    pub keys: BackupKeys,
    pub area: std::sync::Arc<StagingArea>,
    /// What the last pass planned for this item, when it asked for it. An item no pass asked
    /// for is only hashed.
    pub planned: Option<Planned>,
}

/// **A library item a pass asked for** (`NeedBytes`): its hash and length, which the core
/// recorded when the item first streamed, and the chunks some gateway is owed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub h: PlaintextHash,
    pub len: u64,
    /// The names of the chunks to stage, or `None` when the chunks are not known yet (the item
    /// never streamed since its import): every chunk that fits is staged.
    pub owed: Option<BTreeSet<Name>>,
}

/// One sealed chunk the stream put in the staging area.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedChunk {
    pub name: Name,
    pub path: PathBuf,
    pub size: u64,
    /// This stream made the file; one a gateway was already owed from before is not its to remove.
    fresh: bool,
}

/// What sealing a library item's stream produced: the ref of every chunk of the item, and the
/// chunks that were staged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsChunks {
    pub refs: Vec<Ref>,
    pub staged: Vec<StagedChunk>,
}

/// The chunks of a library original, sealed as the item streams past (spec §6.4).
///
/// A chunk is sealed once, its ref is kept whatever happens next, and its object is staged only if
/// a gateway is owed it and the budget has room. **Dropped before [`Self::finish`] accepted it, it
/// removes the files it made**: a stream that broke or did not hash to its item leaves nothing.
pub struct ChunkSealer {
    keys: BackupKeys,
    area: std::sync::Arc<StagingArea>,
    plan: Planned,
    buffer: Vec<u8>,
    refs: Vec<Ref>,
    staged: Vec<StagedChunk>,
    full: bool,
    kept: bool,
}

impl ChunkSealer {
    fn new(into: SealInto, plan: Planned) -> Self {
        Self {
            keys: into.keys,
            area: into.area,
            plan,
            buffer: Vec::new(),
            refs: Vec::new(),
            staged: Vec::new(),
            full: false,
            kept: false,
        }
    }

    fn update(&mut self, payload: &[u8]) {
        self.buffer.extend_from_slice(payload);
        while self.buffer.len() >= CHUNK_BYTES {
            let rest = self.buffer.split_off(CHUNK_BYTES);
            let chunk = std::mem::replace(&mut self.buffer, rest);
            self.seal(&chunk);
        }
    }

    fn seal(&mut self, chunk: &[u8]) {
        let Ok(sealed) = sealed::seal(&self.keys, Class::Originals, chunk) else {
            self.full = true;
            return;
        };
        self.refs.push(sealed.reference());
        let wanted = self
            .plan
            .owed
            .as_ref()
            .is_none_or(|owed| owed.contains(&sealed.name));
        if !wanted || self.full {
            return;
        }
        let fresh = !self.area.path_of(&sealed.name).exists();
        match self.area.put(&sealed.name, &sealed.object) {
            Ok(path) => self.staged.push(StagedChunk {
                name: sealed.name,
                path,
                size: sealed.object.len() as u64,
                fresh,
            }),
            // THE BUDGET IS THE WINDOW: when staging is full (or I/O cannot stage the chunk),
            // stop staging further chunks in this stream while still hashing and naming all refs
            // so the remaining chunks are asked for again on the next pass.
            Err(centraid_vault::backup::PlaneError::StagingFull) => self.full = true,
            Err(error) => {
                tracing::debug!(%error, "library chunk staging failed");
                self.full = true;
            }
        }
    }

    /// The chunks, **only if what streamed is the item the pass asked for**: a photograph edited
    /// since its first read must not lend its bytes to the names of the one asked for.
    fn finish(mut self, h: &PlaintextHash, len: u64) -> Option<OsChunks> {
        if !self.buffer.is_empty() {
            let rest = std::mem::take(&mut self.buffer);
            self.seal(&rest);
        }
        if *h != self.plan.h || len != self.plan.len {
            return None;
        }
        self.kept = true;
        Some(OsChunks {
            refs: std::mem::take(&mut self.refs),
            staged: std::mem::take(&mut self.staged),
        })
    }
}

impl Drop for ChunkSealer {
    fn drop(&mut self) {
        if !self.kept {
            for chunk in &self.staged {
                if chunk.fresh {
                    let _ = self.area.release(&chunk.name);
                }
            }
        }
    }
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
        seal: Option<Box<ChunkSealer>>,
    },
    ExportArchive {
        file: ExportTemp,
        job_id: String,
        photo_id: String,
        expected: [u8; 32],
        expected_len: u64,
        hasher: Box<blake3::Hasher>,
        cancelled: std::sync::Arc<AtomicBool>,
    },
}

struct ExportTemp {
    file: Option<File>,
    path: PathBuf,
    keep: bool,
}

impl Drop for ExportTemp {
    fn drop(&mut self) {
        self.file.take();
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

struct Session {
    media_type: String,
    declared: Option<u64>,
    next_seq: u64,
    received: u64,
    holding: Holding,
    /// When the last frame for this session arrived.
    touched: Instant,
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
    /// A library item, hashed; its chunks sealed into staging when a pass asked for it.
    Library {
        h: PlaintextHash,
        len: u64,
        media_type: String,
        os_ref: String,
        edited: bool,
        sealed: Option<OsChunks>,
    },
    /// One original supplied to a ZIP job, held only in a temporary stage file until verified.
    ExportArchive {
        path: PathBuf,
        staging_id: String,
        job_id: String,
        photo_id: String,
        hash: PlaintextHash,
        len: u64,
        media_type: String,
        expected: PlaintextHash,
        expected_len: u64,
    },
}

fn invalid(detail: impl Into<String>) -> CoreError {
    CoreError::InvalidRequest {
        detail: detail.into(),
    }
}

struct ParsedStageSource {
    library: bool,
    archive: Option<ArchiveStageSource>,
    derivative: Option<(String, String)>,
}

/// The immutable export descriptor carried by one archive-original stage.
struct ArchiveStageSource {
    job_id: String,
    photo_id: String,
    expected_hash: [u8; 32],
    byte_size: u64,
    media_type: String,
}

/// Read a `begin`'s fields, refusing the ones that contradict each other.
fn source_of(begin: &wire::StageBegin) -> Result<ParsedStageSource> {
    let (library, is_archive) = match wire::StageSource::try_from(begin.source) {
        Ok(wire::StageSource::Unspecified | wire::StageSource::Owned) => (false, false),
        Ok(wire::StageSource::OsLibrary) => (true, false),
        Ok(wire::StageSource::ExportArchive) => (false, true),
        Err(_) => return Err(invalid(format!("{} is not a stage source", begin.source))),
    };
    if library == begin.os_ref.is_empty() || (is_archive && !begin.os_ref.is_empty()) {
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
    let export_fields = !begin.export_job_id.is_empty()
        || !begin.export_photo_id.is_empty()
        || !begin.export_hash.is_empty();
    let archive = if is_archive {
        if begin.export_job_id.is_empty()
            || begin.export_photo_id.is_empty()
            || begin.export_hash.len() != 32
            || begin.byte_size == 0
            || !begin.for_hash.is_empty()
            || !begin.tier.is_empty()
        {
            return Err(invalid(
                "an export original carries its snapshot job, photo, hash and size",
            ));
        }
        Some(ArchiveStageSource {
            job_id: begin.export_job_id.clone(),
            photo_id: begin.export_photo_id.clone(),
            expected_hash: <[u8; 32]>::try_from(begin.export_hash.as_slice())
                .map_err(|_| invalid("an export original names a 32-byte snapshot hash"))?,
            byte_size: begin.byte_size,
            media_type: begin.media_type.clone(),
        })
    } else if export_fields {
        return Err(invalid(
            "only an export archive stage carries export snapshot fields",
        ));
    } else {
        None
    };
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
    Ok(ParsedStageSource {
        library,
        archive,
        derivative,
    })
}

impl Staging {
    /// Open a session.
    ///
    /// # Errors
    /// [`CoreError::InvalidRequest`] for a `begin` that contradicts itself or
    /// a fifth open session; [`CoreError::Unavailable`] for owned bytes on a
    /// core with no content store.
    pub fn begin(&self, begin: &wire::StageBegin, doors: Doors) -> Result<wire::StageBegun> {
        self.begin_at(begin, doors, Instant::now())
    }

    /// [`Self::begin`] at a given instant, so a test names the idle time
    /// instead of waiting for it.
    fn begin_at(
        &self,
        begin: &wire::StageBegin,
        doors: Doors,
        now: Instant,
    ) -> Result<wire::StageBegun> {
        let source = source_of(begin)?;
        if doors
            .export
            .as_ref()
            .is_some_and(|into| into.cancelled.load(Ordering::SeqCst))
        {
            return Err(invalid("the whole-vault export was cancelled"));
        }
        let mut sessions = self.lock_sessions()?;
        if sessions.len() >= MAX_OPEN_SESSIONS {
            // A FULL TABLE REAPS THE SESSIONS NOBODY IS FEEDING: dropping one
            // closes its writer and removes its partial bytes.
            sessions
                .retain(|_, session| now.saturating_duration_since(session.touched) < IDLE_LIMIT);
        }
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
        let holding = if source.library {
            Holding::Library {
                os_ref: begin.os_ref.clone(),
                edited: begin.os_edited,
                hasher: Box::new(blake3::Hasher::new()),
                seal: doors.seal.and_then(|into| {
                    // ONLY AN ITEM A PASS ASKED FOR IS SEALED. A size that contradicts the
                    // plan's is another file, and gets no staging.
                    let planned = into.planned.clone()?;
                    if declared.is_some_and(|size| size != planned.len) {
                        return None;
                    }
                    Some(Box::new(ChunkSealer::new(into, planned)))
                }),
            }
        } else if let Some(snapshot) = source.archive {
            let into = doors.export.ok_or_else(|| {
                invalid("there is no active export job waiting for these original bytes")
            })?;
            if snapshot.job_id != into.job_id
                || snapshot.photo_id != into.photo_id
                || snapshot.expected_hash != into.hash
                || snapshot.byte_size != into.byte_size
                || snapshot.media_type != into.media_type
            {
                return Err(invalid(
                    "the export original does not match the active snapshot descriptor",
                ));
            }
            let path = into.staging_dir.join(format!("{staging_id}.original"));
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| CoreError::Unavailable {
                    reason: format!("the original could not be staged: {error}"),
                })?;
            Holding::ExportArchive {
                file: ExportTemp {
                    file: Some(file),
                    path,
                    keep: false,
                },
                job_id: snapshot.job_id,
                photo_id: snapshot.photo_id,
                expected: snapshot.expected_hash,
                expected_len: snapshot.byte_size,
                hasher: Box::new(blake3::Hasher::new()),
                cancelled: std::sync::Arc::clone(&into.cancelled),
            }
        } else {
            let store = doors.store.ok_or_else(|| CoreError::Unavailable {
                reason: "this core has no content store, so it cannot keep staged bytes".to_owned(),
            })?;
            Holding::Owned {
                writer: Box::new(store.writer().map_err(|error| CoreError::Unavailable {
                    reason: format!("the content store would not take a write: {error}"),
                })?),
                derivative: source.derivative,
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
                touched: now,
            },
        );
        if sessions.get(&staging_id).is_some_and(|session| {
            matches!(
                &session.holding,
                Holding::ExportArchive { cancelled, .. }
                    if cancelled.load(Ordering::SeqCst)
            )
        }) {
            sessions.remove(&staging_id);
            return Err(invalid("the whole-vault export was cancelled"));
        }
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
        let answer = {
            let session = sessions
                .get_mut(staging_id)
                .ok_or_else(|| unknown_session(staging_id))?;
            Self::take(session, seq, payload)
        };
        if answer.is_err() {
            // ANY REFUSAL CLOSES THE SESSION (#1202): the shell ends a stage
            // where it was refused and there is no resume, so keeping it would
            // only hold one of four places and a partial file.
            sessions.remove(staging_id);
        }
        answer
    }

    fn take(session: &mut Session, seq: u64, payload: &[u8]) -> Result<wire::StageChunked> {
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
                if let Some(sealer) = seal.as_mut() {
                    sealer.update(payload);
                }
                Ok(())
            }
            Holding::ExportArchive {
                file,
                hasher,
                cancelled,
                ..
            } => {
                if cancelled.load(Ordering::SeqCst) {
                    return Err(invalid("the whole-vault export was cancelled"));
                }
                let output = file.file.as_mut().ok_or_else(|| CoreError::Unavailable {
                    reason: "the staged export original is already closed".to_owned(),
                })?;
                output
                    .write_all(payload)
                    .map_err(|error| CoreError::Unavailable {
                        reason: format!("the export original could not be staged: {error}"),
                    })?;
                hasher.update(payload);
                Ok(())
            }
        };
        written?;
        session.touched = Instant::now();
        session.received = after;
        session.next_seq += 1;
        Ok(wire::StageChunked { received: after })
    }

    /// Drop a session and its partial bytes: the shell's read broke, or its
    /// task was cancelled, after `begin`. An unknown id is not an error, since
    /// the core may already have closed the session on a refused chunk.
    pub fn abort(&self, staging_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(staging_id);
        }
    }

    /// Close every partial export-original stream after its job is cancelled.
    /// A frame holds this table lock for at most its fixed 512 KiB write.
    pub fn cancel_export(&self, job_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.retain(|_, session| {
                !matches!(
                    &session.holding,
                    Holding::ExportArchive { job_id: owner, .. } if owner == job_id
                )
            });
        }
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
        if matches!(
            &session.holding,
            Holding::ExportArchive { cancelled, .. } if cancelled.load(Ordering::SeqCst)
        ) {
            return Err(invalid("the whole-vault export was cancelled"));
        }
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
                let sealed = seal.and_then(|sealer| (*sealer).finish(&h, session.received));
                Staged::Library {
                    h,
                    len: session.received,
                    media_type: session.media_type,
                    os_ref,
                    edited,
                    sealed,
                }
            }
            Holding::ExportArchive {
                mut file,
                job_id,
                photo_id,
                expected,
                expected_len,
                hasher,
                ..
            } => {
                if let Some(output) = file.file.as_mut() {
                    output.flush().map_err(|error| CoreError::Unavailable {
                        reason: format!("the export original could not be closed: {error}"),
                    })?;
                    output.sync_all().map_err(|error| CoreError::Unavailable {
                        reason: format!("the export original could not be closed: {error}"),
                    })?;
                }
                file.file.take();
                file.keep = true;
                Staged::ExportArchive {
                    path: file.path.clone(),
                    staging_id: staging_id.to_owned(),
                    job_id,
                    photo_id,
                    hash: PlaintextHash::from_bytes(*hasher.finalize().as_bytes()),
                    len: session.received,
                    media_type: session.media_type,
                    expected: PlaintextHash::from_bytes(expected),
                    expected_len,
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
    use std::sync::Arc;

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
        area: Arc<StagingArea>,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().expect("a directory");
        let store = centraid_blobs::ByteStore::open(dir.path().join("v.bytes")).expect("a store");
        let area = Arc::new(
            StagingArea::open(dir.path().join("v.staging"), 64 * 1024 * 1024)
                .expect("a staging area"),
        );
        Rig {
            _dir: dir,
            store,
            area,
        }
    }

    impl Rig {
        /// The doors a stream no pass asked for opens with: sealed nothing.
        fn doors(&self) -> Doors {
            Doors {
                store: Some(self.store.clone()),
                export: None,
                seal: Some(SealInto {
                    keys: keys(),
                    area: Arc::clone(&self.area),
                    planned: None,
                }),
            }
        }

        /// The doors a stream the last pass asked for opens with.
        fn planned(&self, planned: Planned) -> Doors {
            self.planned_in(Arc::clone(&self.area), planned)
        }

        fn planned_in(&self, area: Arc<StagingArea>, planned: Planned) -> Doors {
            Doors {
                store: Some(self.store.clone()),
                export: None,
                seal: Some(SealInto {
                    keys: keys(),
                    area,
                    planned: Some(planned),
                }),
            }
        }
    }

    fn keys() -> BackupKeys {
        BackupKeys::from_root(&[7; 32])
    }

    /// Stream `bytes` as a library item through `doors`, and close it.
    fn stream(staging: &Staging, begin: &wire::StageBegin, doors: Doors, bytes: &[u8]) -> Staged {
        let begun = staging.begin(begin, doors).expect("begun");
        send(staging, &begun.staging_id, bytes).expect("chunked");
        staging.end(&begun.staging_id).expect("ended")
    }

    fn sealed_of(staged: Staged) -> (PlaintextHash, Option<OsChunks>) {
        let Staged::Library { h, sealed, .. } = staged else {
            panic!("a library item stages as one");
        };
        (h, sealed)
    }

    fn owned(media_type: &str, size: u64) -> wire::StageBegin {
        wire::StageBegin {
            media_type: media_type.to_owned(),
            byte_size: size,
            ..wire::StageBegin::default()
        }
    }

    fn archive_begin(bytes: &[u8]) -> wire::StageBegin {
        wire::StageBegin {
            source: wire::StageSource::ExportArchive as i32,
            byte_size: bytes.len() as u64,
            media_type: "image/jpeg".to_owned(),
            export_job_id: "vault-export-test".to_owned(),
            export_photo_id: "photo-1".to_owned(),
            export_hash: blake3::hash(bytes).as_bytes().to_vec(),
            ..wire::StageBegin::default()
        }
    }

    fn archive_doors(dir: PathBuf, bytes: &[u8], cancelled: Arc<AtomicBool>) -> Doors {
        Doors {
            store: None,
            seal: None,
            export: Some(ExportArchiveInto {
                job_id: "vault-export-test".to_owned(),
                photo_id: "photo-1".to_owned(),
                hash: *blake3::hash(bytes).as_bytes(),
                byte_size: bytes.len() as u64,
                media_type: "image/jpeg".to_owned(),
                staging_dir: dir,
                cancelled,
            }),
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
            .begin(&owned("image/heic", bytes.len() as u64), rig.doors())
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
            centraid_vault::blob::content_digest(&bytes),
            "the handle is what the vault deduplicates on"
        );
        assert_eq!(std::fs::read(&stored.path).expect("reads"), bytes);
        assert_eq!(media_type, "image/heic");
        assert_eq!(staging.open(), 0, "a closed session is gone");
    }

    #[test]
    fn cancelling_an_export_original_midstream_removes_its_partial_file() {
        let rig = rig();
        let bytes = payload(1024);
        let staging_dir = rig._dir.path().join("export-job");
        std::fs::create_dir_all(&staging_dir).expect("an export staging folder");
        let cancelled = Arc::new(AtomicBool::new(false));
        let staging = Staging::default();
        let begun = staging
            .begin(
                &archive_begin(&bytes),
                archive_doors(staging_dir.clone(), &bytes, Arc::clone(&cancelled)),
            )
            .expect("the snapshot original begins");
        staging
            .chunk(&begun.staging_id, 0, &bytes[..512])
            .expect("one bounded frame is staged");
        assert_eq!(
            std::fs::read_dir(&staging_dir).expect("lists").count(),
            1,
            "the active stream owns one temp file"
        );
        cancelled.store(true, Ordering::SeqCst);
        assert!(staging.chunk(&begun.staging_id, 1, &bytes[512..]).is_err());
        assert_eq!(staging.open(), 0, "the cancelled session is gone");
        assert_eq!(
            std::fs::read_dir(&staging_dir).expect("lists").count(),
            0,
            "cancellation removes the partial plaintext original"
        );
    }

    #[test]
    fn an_export_stage_returns_only_a_verified_temp_receipt() {
        let rig = rig();
        let bytes = payload(1024);
        let staging_dir = rig._dir.path().join("export-job");
        std::fs::create_dir_all(&staging_dir).expect("an export staging folder");
        let staging = Staging::default();
        let begun = staging
            .begin(
                &archive_begin(&bytes),
                archive_doors(
                    staging_dir.clone(),
                    &bytes,
                    Arc::new(AtomicBool::new(false)),
                ),
            )
            .expect("the snapshot original begins");
        send(&staging, &begun.staging_id, &bytes).expect("frames are staged");
        let Staged::ExportArchive {
            path,
            staging_id,
            hash,
            len,
            expected,
            expected_len,
            ..
        } = staging.end(&begun.staging_id).expect("the receipt closes")
        else {
            panic!("an archive stream returns a temporary receipt");
        };
        assert_eq!(staging_id, begun.staging_id);
        assert_eq!(hash, expected);
        assert_eq!(len, expected_len);
        assert_eq!(std::fs::read(&path).expect("temp bytes"), bytes);
        std::fs::remove_file(path).expect("the async commit removes its input");
        assert_eq!(std::fs::read_dir(staging_dir).expect("lists").count(), 0);
    }

    /// A SENDER DOES NOT CHOOSE THIS PROCESS'S MEMORY, when it declared a size.
    #[test]
    fn more_bytes_than_declared_is_refused_at_the_chunk() {
        let rig = rig();
        let staging = Staging::default();
        let begun = staging
            .begin(&owned("image/png", 50), rig.doors())
            .expect("begun");
        assert!(staging.chunk(&begun.staging_id, 0, &payload(100)).is_err());
    }

    /// A SESSION THAT FAILED IS CLOSED (#1202): four stages that each broke
    /// (a chunk out of order, one over the ceiling, one past the declared size)
    /// must leave the fifth its place.
    #[test]
    fn four_failed_stages_do_not_block_the_fifth() {
        let rig = rig();
        let staging = Staging::default();
        for round in 0..MAX_OPEN_SESSIONS {
            let begun = staging
                .begin(&owned("image/png", 100), rig.doors())
                .expect("begun");
            let refused = match round % 3 {
                0 => staging.chunk(&begun.staging_id, 5, &payload(10)),
                1 => staging.chunk(&begun.staging_id, 0, &payload(MAX_CHUNK_BYTES + 1)),
                _ => staging.chunk(&begun.staging_id, 0, &payload(101)),
            };
            assert!(refused.is_err());
        }
        assert_eq!(staging.open(), 0, "a refused chunk closes its session");
        let begun = staging
            .begin(&owned("image/png", 4), rig.doors())
            .expect("the fifth stage is taken");
        staging
            .chunk(&begun.staging_id, 0, &payload(4))
            .expect("chunked");
        staging.end(&begun.staging_id).expect("ended");
    }

    /// A SHELL THAT BROKE BETWEEN FRAMES SENDS `abort`, and the place is free.
    #[test]
    fn an_aborted_session_frees_its_place_and_an_unknown_one_is_no_error() {
        let rig = rig();
        let staging = Staging::default();
        let ids: Vec<String> = (0..MAX_OPEN_SESSIONS)
            .map(|_| {
                staging
                    .begin(&owned("image/png", 100), rig.doors())
                    .expect("begun")
                    .staging_id
            })
            .collect();
        assert!(staging.begin(&owned("image/png", 1), rig.doors()).is_err());
        for id in &ids {
            staging.abort(id);
        }
        staging.abort("stage-999");
        assert_eq!(staging.open(), 0);
        staging
            .begin(&owned("image/png", 1), rig.doors())
            .expect("the place is free");
    }

    /// A SENDER THAT DIED WITHOUT AN ABORT LOSES ITS PLACE, but only once the
    /// table is full and the session has sat idle past the limit.
    #[test]
    fn an_idle_session_is_reaped_when_the_table_is_full() {
        let rig = rig();
        let staging = Staging::default();
        let start = Instant::now();
        for _ in 0..MAX_OPEN_SESSIONS {
            staging
                .begin_at(&owned("image/png", 100), rig.doors(), start)
                .expect("begun");
        }
        let soon = start + IDLE_LIMIT - Duration::from_secs(1);
        assert!(
            staging
                .begin_at(&owned("image/png", 1), rig.doors(), soon)
                .is_err(),
            "a session still inside the limit keeps its place"
        );
        let later = start + IDLE_LIMIT;
        staging
            .begin_at(&owned("image/png", 1), rig.doors(), later)
            .expect("the idle sessions are reaped");
        assert_eq!(staging.open(), 1);
    }

    /// A TRANSPOSED FRAME NAMES THE FRAME.
    #[test]
    fn a_chunk_out_of_order_is_refused_by_number() {
        let rig = rig();
        let staging = Staging::default();
        let begun = staging
            .begin(&owned("image/png", 4096), rig.doors())
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
            .begin(&owned("image/png", 4096), rig.doors())
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
            .begin(&owned("video/quicktime", 0), rig.doors())
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
                .begin(&owned("image/png", 1), rig.doors())
                .expect("begun");
        }
        assert!(staging.begin(&owned("image/png", 1), rig.doors()).is_err());
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
                    staging.begin(&begin, rig.doors()),
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

    /// **NOTHING IS SEALED AT IMPORT** (#1209): a library item no pass asked for is only hashed,
    /// no plaintext copy is kept, and staging stays empty.
    #[test]
    fn a_library_item_nobody_asked_for_is_only_hashed() {
        let rig = rig();
        let staging = Staging::default();
        let bytes = payload(1_500_000);
        let begun = staging
            .begin(&library(bytes.len() as u64), rig.doors())
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
        assert!(sealed.is_none(), "nothing is sealed at import");
        assert!(rig.area.names().expect("lists").is_empty());
        assert!(
            rig.store.hashes().expect("lists").is_empty(),
            "the library's bytes are not copied into the app"
        );
    }

    fn planned_of(bytes: &[u8], owed: Option<BTreeSet<Name>>) -> Planned {
        Planned {
            h: PlaintextHash::of(bytes),
            len: bytes.len() as u64,
            owed,
        }
    }

    fn chunk_name(bytes: &[u8]) -> Name {
        sealed::name_of(&keys(), Class::Originals, bytes)
    }

    /// **AN ITEM A PASS ASKED FOR IS SEALED AS IT STREAMS**: every chunk's ref is kept, in order,
    /// and each chunk is staged under its deterministic name, opening to its own bytes.
    #[test]
    fn a_planned_item_seals_every_chunk_into_staging_under_known_names() {
        let rig = rig();
        let staging = Staging::default();
        let bytes = payload(CHUNK_BYTES + 700_000);
        for declared in [bytes.len() as u64, 0] {
            let (h, sealed) = sealed_of(stream(
                &staging,
                &library(declared),
                rig.planned(planned_of(&bytes, None)),
                &bytes,
            ));
            assert_eq!(h, PlaintextHash::of(&bytes));
            let sealed = sealed.expect("the chunks are kept");
            let first = &bytes[..CHUNK_BYTES];
            let second = &bytes[CHUNK_BYTES..];
            assert_eq!(
                sealed
                    .refs
                    .iter()
                    .map(|reference| reference.name)
                    .collect::<Vec<_>>(),
                [chunk_name(first), chunk_name(second)],
                "one ref per chunk, in order, named by the chunk's own bytes"
            );
            assert_eq!(sealed.staged.len(), 2);
            for (chunk, plain) in sealed.staged.iter().zip([first, second]) {
                let object = std::fs::read(&chunk.path).expect("the staged chunk");
                let reference = sealed
                    .refs
                    .iter()
                    .find(|r| r.name == chunk.name)
                    .expect("a ref");
                assert_eq!(
                    sealed::open(&keys(), reference, &object).expect("opens"),
                    plain
                );
            }
            for chunk in &sealed.staged {
                rig.area.release(&chunk.name).expect("releases");
            }
        }
    }

    /// **ONLY THE CHUNKS SOME GATEWAY IS OWED ARE STAGED**, and every ref is kept regardless: a
    /// video larger than staging goes a window at a time and never restages what a gateway holds.
    #[test]
    fn only_the_owed_chunks_are_staged_but_every_ref_is_kept() {
        let rig = rig();
        let staging = Staging::default();
        let bytes = payload(2 * CHUNK_BYTES + 5);
        let second = &bytes[CHUNK_BYTES..2 * CHUNK_BYTES];
        let owed: BTreeSet<Name> = [chunk_name(second)].into();
        let (_, sealed) = sealed_of(stream(
            &staging,
            &library(0),
            rig.planned(planned_of(&bytes, Some(owed))),
            &bytes,
        ));
        let sealed = sealed.expect("kept");
        assert_eq!(sealed.refs.len(), 3, "every chunk has a ref");
        assert_eq!(
            sealed
                .staged
                .iter()
                .map(|chunk| chunk.name)
                .collect::<Vec<_>>(),
            [chunk_name(second)]
        );
        assert_eq!(rig.area.names().expect("lists"), [chunk_name(second)]);
    }

    /// **STAGING IS A BUDGET, AND THE REFS DO NOT WAIT FOR IT**: when the area is full the rest of
    /// the stream is still hashed and named, and what could not be staged is asked for again.
    #[test]
    fn a_full_staging_area_keeps_the_refs_and_stages_what_fits() {
        let rig = rig();
        let staging = Staging::default();
        // Incompressible, so a sealed chunk is as large as its plaintext.
        let mut bytes = vec![0_u8; 3 * CHUNK_BYTES];
        blake3::Hasher::new()
            .update(b"incompressible")
            .finalize_xof()
            .fill(&mut bytes);
        let small = Arc::new(
            StagingArea::open(
                rig._dir.path().join("small.staging"),
                CHUNK_BYTES as u64 + 64,
            )
            .expect("a small area"),
        );
        let (h, sealed) = sealed_of(stream(
            &staging,
            &library(bytes.len() as u64),
            rig.planned_in(Arc::clone(&small), planned_of(&bytes, None)),
            &bytes,
        ));
        assert_eq!(h, PlaintextHash::of(&bytes));
        let sealed = sealed.expect("kept");
        assert_eq!(sealed.refs.len(), 3, "all three chunks are named");
        assert_eq!(sealed.staged.len(), 1, "only the first fits the budget");
    }

    /// **AN ITEM EDITED SINCE ITS FIRST READ LENDS NO BYTES**, and a size that contradicts the
    /// plan's gets no sealing: a stream that is not the item stages nothing and leaves no file.
    #[test]
    fn a_stream_that_is_not_the_item_stages_nothing() {
        let rig = rig();
        let staging = Staging::default();
        let bytes = payload(700_000);
        let plan = planned_of(&bytes, None);
        let mut edited = bytes.clone();
        edited[350_000] ^= 1;
        let (h, sealed) = sealed_of(stream(
            &staging,
            &library(0),
            rig.planned(plan.clone()),
            &edited,
        ));
        assert_eq!(h, PlaintextHash::of(&edited));
        assert!(sealed.is_none(), "another file's bytes are not the item's");
        assert!(
            rig.area.names().expect("lists").is_empty(),
            "nothing is left staged"
        );
        // A declared size that contradicts the plan is another file from the first byte.
        let shorter = &bytes[..bytes.len() - 10];
        let (_, sealed) = sealed_of(stream(
            &staging,
            &library(shorter.len() as u64),
            rig.planned(plan),
            shorter,
        ));
        assert!(sealed.is_none());
        assert!(rig.area.names().expect("lists").is_empty());
    }
}
