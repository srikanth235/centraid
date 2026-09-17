//! Capture: commit-bounded page segments, spooled before checkpoint (#1029 §2).
//!
//! ## DEBOUNCED, NOT A TIMER OVER `rpo_seconds` — AND NOT A COMMIT HOOK (F11)
//!
//! Reference A drops "`rpo_seconds` as the capture tick" and F11 says why on
//! both sides. A **timer** is wrong because the WAL is already the fsynced log:
//! shipping it on a clock buys no durability the WAL did not already have, and
//! a tick that fires while a transaction is open is what produced B7's
//! mid-transaction cuts. Sealing **per commit** is wrong the other way: an
//! autosaving note would become hundreds of objects a minute, each with its own
//! header, padding and upload, for no extra safety at all.
//!
//! So capture is **debounced work triggered by commits**: it runs after an idle
//! interval, after N commits, when the spool passes its bound, and on
//! backgrounding. [`Debounce`] is that decision and nothing else — no clock of
//! its own, no I/O — so the policy can be tested without a vault.
//!
//! ## The order inside one tick, which is F11's order
//!
//! 1. Take the write mutex. Capture never took a lock before, so a checkpoint
//!    between ticks raced it (B6).
//! 2. Read the WAL from the durable cursor to the **last commit frame**
//!    ([`super::wal::read_frames`]).
//! 3. Build the segment, with the census as of that commit.
//! 4. Seal it, write it into the spool, fsync the file **and the directory**,
//!    then read it back from disk and open it (§4).
//! 5. Record `(salt1, salt2, frame index, last_txid)` durably — **before** any
//!    checkpoint can make it stale.
//! 6. Only now may [`checkpoint`] run, and only if the spool covers every
//!    committed txid.
//!
//! A crash at any point before step 5 re-captures frames on the next tick.
//! Re-capturing is free; losing is not; so every window falls on that side.
//!
//! ## The break rule
//!
//! A WAL restart with new salts is **normal** after every truncate. A salt
//! mismatch **mid-cursor** is a break: frames that were never captured are gone,
//! and the stream is not contiguous any more. A break **starts a new
//! generation** with a fresh 128-bit random id (F3) and never edits the old one
//! — the old generation stays exactly as it was, an append stream that stopped.
//! `pending_tail().len() + 1` and `manifests + 1` are both gone (B8).

use std::time::Duration;

use centraid_media::object::{Kind, Role};

use crate::backup::objects::{ObjectKeys, ObjectsError};
use crate::backup::segment::{GenerationId, PageSegment, SegmentError};
use crate::backup::spool::{Spool, SpoolCursor, SpoolEntry, SpoolError};
use crate::backup::wal::{self, WalCursor, WalError};
use crate::file::Vault;

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error(transparent)]
    Vault(#[from] crate::error::VaultError),
    #[error(transparent)]
    Wal(#[from] WalError),
    #[error(transparent)]
    Segment(#[from] SegmentError),
    #[error(transparent)]
    Spool(#[from] SpoolError),
    #[error(transparent)]
    Objects(#[from] ObjectsError),
    #[error(
        "refusing to checkpoint: the spool holds commits through {spooled} and the log \
         carries {committed} — every committed frame must be in the spool first"
    )]
    NotSpooled { spooled: u64, committed: u64 },
}

type Result<T> = std::result::Result<T, CaptureError>;

/// When a tick is due.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapturePolicy {
    /// How long after the last commit a quiet vault is captured.
    pub idle: Duration,
    /// How many commits force a capture regardless of quiet.
    pub commits: u64,
    /// The spool size past which a new base is taken and the spool dropped
    /// (§2, and the "spool grows without bound offline" risk).
    pub spool_bound_bytes: u64,
    /// The WAL size past which a checkpoint is taken.
    pub checkpoint_bytes: u64,
}

impl Default for CapturePolicy {
    /// The shape §2 asks for, in numbers a phone can live with.
    ///
    /// Two seconds of quiet is longer than a keystroke and shorter than a
    /// member noticing; sixty-four commits bounds how much a busy import can
    /// build up before it is shipped; the spool bound is what triggers a new
    /// base rather than an unbounded tail.
    fn default() -> Self {
        Self {
            idle: Duration::from_secs(2),
            commits: 64,
            spool_bound_bytes: 64 * 1024 * 1024,
            checkpoint_bytes: 16 * 1024 * 1024,
        }
    }
}

/// Why a tick fired. The member never sees these; a log line does, and a test
/// asserts on them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureReason {
    /// The vault went quiet.
    Idle,
    /// Enough commits piled up.
    Commits,
    /// The app is going to the background, which on iOS may be the last moment
    /// it runs for a while.
    Backgrounding,
    /// The spool passed its bound.
    SpoolBound,
    /// A caller asked.
    Explicit,
}

/// The debounce: commits in, "is it due" out. No clock, no I/O, no vault.
#[derive(Debug, Clone, Default)]
pub struct Debounce {
    commits_since: u64,
    /// Milliseconds on the caller's monotonic clock.
    last_commit_at: Option<u64>,
    backgrounding: bool,
}

impl Debounce {
    /// A commit landed.
    pub const fn note_commit(&mut self, now_ms: u64) {
        self.commits_since += 1;
        self.last_commit_at = Some(now_ms);
    }

    /// The app is heading to the background.
    pub const fn note_backgrounding(&mut self) {
        self.backgrounding = true;
    }

    /// Commits waiting to be captured.
    #[must_use]
    pub const fn pending_commits(&self) -> u64 {
        self.commits_since
    }

    /// Whether a tick is due, and why.
    ///
    /// **Nothing to capture is never due.** Backgrounding with no commits does
    /// not seal an empty segment, which would be an object a minute for an app
    /// a member keeps switching away from.
    #[must_use]
    pub fn due(
        &self,
        now_ms: u64,
        policy: &CapturePolicy,
        spool_bytes: u64,
    ) -> Option<CaptureReason> {
        if self.commits_since == 0 {
            return None;
        }
        if self.backgrounding {
            return Some(CaptureReason::Backgrounding);
        }
        if self.commits_since >= policy.commits {
            return Some(CaptureReason::Commits);
        }
        if spool_bytes >= policy.spool_bound_bytes {
            return Some(CaptureReason::SpoolBound);
        }
        let quiet_for = now_ms.saturating_sub(self.last_commit_at?);
        (u128::from(quiet_for) >= policy.idle.as_millis()).then_some(CaptureReason::Idle)
    }

    /// A tick ran. Whatever it captured is no longer pending.
    pub const fn captured(&mut self) {
        self.commits_since = 0;
        self.backgrounding = false;
    }
}

/// What one tick did.
#[derive(Debug, Clone)]
pub struct CaptureOutcome {
    pub generation: GenerationId,
    /// The spooled segment, or `None` when there was nothing committed to cut.
    pub entry: Option<SpoolEntry>,
    pub commits: u64,
    pub first_txid: u64,
    pub last_txid: u64,
    /// A WAL restart stranded frames: this tick started a **new generation**
    /// and the caller owes it a base (§2, F3).
    pub broke: bool,
    /// Frames of an open transaction were left in the log, as they must be.
    pub uncommitted_tail: bool,
}

/// Run one capture tick.
///
/// The caller holds the vault's write mutex — on the phone that is the one
/// `Mutex<Option<Vault>>` per handle, and here it is `&Vault`, which is not
/// `Sync`. That is the lock capture never took (B6).
///
/// Returns `Ok` with `entry: None` when the log holds no committed frame past
/// the cursor: a quiet vault is not an error and must not mint an empty object.
///
/// # Errors
/// [`CaptureError`] for anything the WAL, the seal or the spool refused. A
/// [`WalError::Restarted`] is **not** an error out of here: it is the break, and
/// it is handled by starting a new generation.
pub fn capture(vault: &Vault, spool: &Spool, keys: &ObjectKeys) -> Result<CaptureOutcome> {
    let mut cursor = match spool.cursor()? {
        Some(cursor) => cursor,
        // A vault with no cursor has never captured. Its base is txid 0 and its
        // generation starts here.
        None => {
            let fresh = SpoolCursor::at(GenerationId::mint()?, 0);
            spool.record_cursor(&fresh)?;
            fresh
        }
    };

    let Some(bytes) = wal::read_sidecar(vault.path())? else {
        // No `-wal` at all: the file was checkpointed and closed. Nothing to do,
        // and emphatically not an error — see docs/traps/wal-checkpoint.md.
        return Ok(quiet(&cursor));
    };

    let page_size = u32::try_from(crate::file::PAGE_SIZE).unwrap_or(4096);
    let mut broke = false;
    let read = match wal::read_frames(&bytes, &cursor.wal, page_size) {
        Ok(read) => read,
        Err(WalError::Restarted { .. }) => {
            // THE BREAK (§2). Frames we never captured are gone, so this
            // generation's stream is not contiguous any more. Start a new one
            // and never edit the old.
            broke = true;
            cursor = SpoolCursor::at(GenerationId::mint()?, cursor.last_txid);
            spool.record_cursor(&cursor)?;
            wal::read_frames(&bytes, &WalCursor::fresh(), page_size)?
        }
        Err(error) => return Err(error.into()),
    };

    if read.frames.is_empty() {
        let mut outcome = quiet(&cursor);
        outcome.broke = broke;
        outcome.uncommitted_tail = read.uncommitted_tail;
        return Ok(outcome);
    }

    // THE CENSUS AS OF THE COMMIT WE CUT AT. Capture runs under the write
    // mutex and the walk stopped at the last commit frame, so the vault's own
    // rows are exactly that commit's rows — no snapshot and no scan of the WAL
    // is needed to agree with the segment.
    let census = vault.census()?;
    let first_txid = cursor.last_txid + 1;
    let segment = PageSegment::from_frames(
        cursor.generation,
        first_txid,
        page_size,
        census,
        &read.frames,
    )?;

    // SEAL ONCE. The same ciphertext is re-sent on retry and never resealed, so
    // no nonce is ever reused (B9, §4).
    let plain = segment.encode();
    let sealed = keys.seal(Kind::Segment, Role::Whole, &plain)?;
    let entry = spool.add(
        segment.first_txid,
        segment.last_txid,
        &sealed.name.hex(),
        &sealed.bytes,
    )?;
    // VERIFY BEFORE UPLOAD (§4): from the FILE, not from the buffer.
    keys.verify_on_disk(Kind::Segment, &sealed, &entry.path)?;

    // AND ONLY NOW is the cursor durable — before any checkpoint (§2, step 4).
    let next = SpoolCursor {
        generation: cursor.generation,
        wal: wal::cursor_after(&read),
        last_txid: segment.last_txid,
        acked_txid: cursor.acked_txid,
    };
    spool.record_cursor(&next)?;

    Ok(CaptureOutcome {
        generation: segment.generation,
        commits: segment.commits(),
        first_txid: segment.first_txid,
        last_txid: segment.last_txid,
        entry: Some(entry),
        broke,
        uncommitted_tail: read.uncommitted_tail,
    })
}

fn quiet(cursor: &SpoolCursor) -> CaptureOutcome {
    CaptureOutcome {
        generation: cursor.generation,
        entry: None,
        commits: 0,
        first_txid: cursor.last_txid + 1,
        last_txid: cursor.last_txid,
        broke: false,
        uncommitted_tail: false,
    }
}

/// What a checkpoint did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckpointOutcome {
    /// Frames in the log when the checkpoint ran.
    pub log_frames: i64,
    /// Frames it moved into the database. **A successful TRUNCATE can report
    /// zero** (§2's trap list) — the log was already fully checkpointed and the
    /// truncate still did its job.
    pub checkpointed: i64,
    /// Whether SQLite reported a reader in the way. A partial checkpoint is a
    /// normal outcome with a reader open; the caller tries again later.
    pub busy: bool,
    /// Whether the `-wal` file is gone or empty afterwards.
    pub truncated: bool,
}

/// **Take a TRUNCATE checkpoint — only when the spool holds every commit** (§2).
///
/// W1 already set `wal_autocheckpoint = 0`, so this is the only checkpoint the
/// vault takes and capture owns it. The refusal is the point: a checkpoint that
/// ran ahead of the spool would remove frames nothing else holds, which is the
/// one way this design loses a committed transaction.
///
/// `PRAGMA optimize` runs first, because it **writes `sqlite_stat1`** and is
/// therefore a commit — running it after the checkpoint would leave a frame in a
/// log the caller believes it just emptied (§2's trap list). Its commit is
/// captured on the next tick.
///
/// # Errors
/// [`CaptureError::NotSpooled`] when the spool does not cover the committed
/// txids; otherwise whatever SQLite refused.
pub fn checkpoint(vault: &Vault, spool: &Spool) -> Result<CheckpointOutcome> {
    let cursor = spool.cursor()?;
    if let Some(cursor) = &cursor {
        // Everything the spool must hold is everything capture has cut, and
        // capture only ever cuts on a commit boundary.
        let covered = spool.covers(cursor.acked_txid + 1, cursor.last_txid)?;
        if !covered {
            return Err(CaptureError::NotSpooled {
                spooled: cursor.acked_txid,
                committed: cursor.last_txid,
            });
        }
    }

    let connection = vault.connection();
    // A commit, so it goes BEFORE the checkpoint that is meant to empty the log.
    let _ = connection.execute_batch("PRAGMA optimize");

    let (busy, log_frames, checkpointed) = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|error| crate::error::VaultError::from_sqlite("checkpointing the log", error))?;

    let sidecar = wal::sidecar_path(vault.path());
    let truncated = std::fs::metadata(&sidecar).map_or(true, |meta| meta.len() <= 32);

    // THE LOG RESTARTED, so the cursor's frame index means nothing in the new
    // instance. Recording that here, rather than discovering it as a break next
    // tick, is what makes our own truncate the normal path §2 says it is.
    if truncated && let Some(cursor) = cursor {
        spool.record_cursor(&SpoolCursor {
            generation: cursor.generation,
            wal: WalCursor::fresh(),
            last_txid: cursor.last_txid,
            acked_txid: cursor.acked_txid,
        })?;
    }

    Ok(CheckpointOutcome {
        log_frames,
        checkpointed,
        busy: busy != 0,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> CapturePolicy {
        CapturePolicy {
            idle: Duration::from_millis(500),
            commits: 4,
            spool_bound_bytes: 1_000,
            checkpoint_bytes: 1_000,
        }
    }

    #[test]
    fn a_quiet_vault_is_never_due_however_long_it_stays_quiet() {
        let debounce = Debounce::default();
        assert_eq!(debounce.due(1_000_000, &policy(), 0), None);
        let mut backgrounded = Debounce::default();
        backgrounded.note_backgrounding();
        assert_eq!(
            backgrounded.due(1_000_000, &policy(), 0),
            None,
            "backgrounding with nothing to capture must not seal an empty object"
        );
    }

    /// **F11.** Capture is debounced, not per commit and not on a timer.
    #[test]
    fn a_commit_alone_is_not_due_until_the_vault_goes_quiet() {
        let mut debounce = Debounce::default();
        debounce.note_commit(1_000);
        assert_eq!(debounce.due(1_100, &policy(), 0), None, "still typing");
        assert_eq!(debounce.due(1_400, &policy(), 0), None);
        assert_eq!(
            debounce.due(1_500, &policy(), 0),
            Some(CaptureReason::Idle),
            "half a second of quiet"
        );
    }

    #[test]
    fn enough_commits_backgrounding_and_the_spool_bound_all_fire_early() {
        let mut debounce = Debounce::default();
        for tick in 0..4 {
            debounce.note_commit(1_000 + tick);
        }
        assert_eq!(
            debounce.due(1_004, &policy(), 0),
            Some(CaptureReason::Commits)
        );

        let mut spooling = Debounce::default();
        spooling.note_commit(1_000);
        assert_eq!(
            spooling.due(1_001, &policy(), 1_000),
            Some(CaptureReason::SpoolBound)
        );

        let mut leaving = Debounce::default();
        leaving.note_commit(1_000);
        leaving.note_backgrounding();
        assert_eq!(
            leaving.due(1_001, &policy(), 0),
            Some(CaptureReason::Backgrounding),
            "the last moment the app runs beats every other rule"
        );
    }

    #[test]
    fn a_tick_clears_what_it_captured() {
        let mut debounce = Debounce::default();
        debounce.note_commit(1_000);
        debounce.note_backgrounding();
        assert_eq!(debounce.pending_commits(), 1);
        debounce.captured();
        assert_eq!(debounce.pending_commits(), 0);
        assert_eq!(debounce.due(9_000, &policy(), 0), None);
    }
}
