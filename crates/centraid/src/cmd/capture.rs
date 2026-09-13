//! THE WAL CAPTURE TICK (#1020, D-1020-G9) — the gap wave 2 lane R named.
//!
//! `rpoSeconds` is the vault's WAL capture tick, so "how much can I lose" and
//! "how often do I ship" are one number the owner sets once
//! (`crates/vault/src/backup/wal.rs`'s module docs). Lane R built the seal, the
//! address rules, the replay ordering and the point-in-time cut — and nothing
//! was running the tick, so `centraid backup now` shipped a snapshot with an
//! EMPTY WAL tail and an RPO of "since the last snapshot". That is the whole of
//! what this module fixes.
//!
//! ## Why the pending tail is on disk and not in memory
//!
//! The gateway captures; `centraid backup now` is a separate process. An
//! in-process buffer would be invisible to it, which would leave exactly two
//! options: have the CLI capture the tail itself (a second capturer, with its
//! own idea of where the last segment ended — the failure lane R's module docs
//! warn about for generations), or ship no tail at all.
//!
//! So a tick appends one line to `<data-dir>/wal/pending.jsonl` and writes the
//! **sealed** bytes to the blob store. The tail is durable, one writer owns it,
//! and `backup now` reads it. A crash between the blob write and the index
//! append loses one tick's index line and leaves an orphan blob, which is the
//! right way round: a blob nothing points at is garbage, and an index line
//! pointing at a blob that is not there would be a manifest that cannot be
//! replayed.
//!
//! ## The offsets are the identity, so they are read from the file
//!
//! A segment's address is `{db, generation, group, startOffset, endOffset,
//! tickMs}` and **both** offsets are in the nonce. The capture therefore never
//! invents an offset: `start` is where the last tick stopped and `end` is the
//! current length of `<vault>.db-wal`. When the WAL file gets SHORTER than
//! `start`, SQLite has checkpointed and restarted it — the byte at offset 400
//! is now a different byte — so the group is bumped and the offset resets to
//! zero. Without that, two different byte ranges would seal under one address
//! and, with a deterministic nonce, under one nonce.

use std::path::{Path, PathBuf};

use centraid_vault::backup::wal::{WalSegment, seal_segment};
use centraid_vault::backup::{BlobStore, FsBlobStore};

/// The pending-tail index, one JSON object per line, append-only within a
/// generation. JSON Lines rather than one document because a tick must be one
/// append: rewriting a whole document every `rpoSeconds` is a window in which a
/// crash loses every earlier segment rather than the last one.
pub const PENDING: &str = "wal/pending.jsonl";

pub struct WalCapture {
    wal_file: PathBuf,
    pending: PathBuf,
    vault_id: String,
    master: Vec<u8>,
    blobs: FsBlobStore,
    group: u64,
    next_offset: u64,
}

impl WalCapture {
    /// Resume from whatever the last run left behind, so a gateway restart does
    /// not re-seal bytes that are already in the tail under a different
    /// address.
    pub fn open(
        data_dir: &Path,
        vault_file: &Path,
        vault_id: String,
        master: Vec<u8>,
    ) -> Result<Self, String> {
        let blobs = FsBlobStore::open(super::blobs_dir_in(data_dir))
            .map_err(|error| format!("blob store: {error}"))?;
        let pending = data_dir.join(PENDING);
        if let Some(parent) = pending.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("creating {}: {error}", parent.display()))?;
        }
        let (group, next_offset) = resume(&pending);
        let mut name = vault_file.as_os_str().to_owned();
        name.push("-wal");
        Ok(Self {
            wal_file: PathBuf::from(name),
            pending,
            vault_id,
            master,
            blobs,
            group,
            next_offset,
        })
    }

    /// One tick. `Ok(None)` means the WAL has not grown — no segment, no blob,
    /// no index line. A tick that sealed zero bytes every `rpoSeconds` would
    /// fill the store with empty segments and make the tail meaningless.
    pub fn tick(&mut self, generation: u64, tick_ms: u64) -> Result<Option<WalSegment>, String> {
        let Ok(metadata) = std::fs::metadata(&self.wal_file) else {
            // No `-wal` file at all: the vault is in another journal mode, or
            // nothing has been written since it was created.
            return Ok(None);
        };
        let length = metadata.len();
        if length < self.next_offset {
            // A checkpoint restarted the file. New group, offsets from zero —
            // see the module docs on why this is not cosmetic.
            self.group += 1;
            self.next_offset = 0;
        }
        if length == self.next_offset {
            return Ok(None);
        }
        let bytes = std::fs::read(&self.wal_file)
            .map_err(|error| format!("reading {}: {error}", self.wal_file.display()))?;
        // Re-check against what was actually read: the file can grow between
        // the `metadata` call and the read, and sealing a range whose end
        // offset is not the end of the bytes would be an address that does not
        // describe its own payload.
        let end = bytes.len() as u64;
        if end <= self.next_offset {
            return Ok(None);
        }
        let start = self.next_offset;
        let plain = &bytes[start as usize..end as usize];

        let mut segment = WalSegment {
            db: "vault".to_owned(),
            generation: generation.to_string(),
            group: self.group,
            start_offset: start,
            end_offset: end,
            tick_ms,
            blob_id: String::new(),
        };
        let sealed = seal_segment(&self.master, &self.vault_id, &segment.address(), plain)
            .map_err(|error| format!("sealing the WAL tail: {error}"))?;
        segment.blob_id = self
            .blobs
            .put(&sealed)
            .map_err(|error| format!("storing the sealed segment: {error}"))?;

        append(&self.pending, &segment)?;
        self.next_offset = end;
        Ok(Some(segment))
    }
}

/// THE RPO CLOCK'S LIVENESS MARKER, at `<data-dir>/wal/tick.json`.
///
/// A tick that finds nothing new writes no segment and no index line, which is
/// correct — and indistinguishable, from outside, from a tick that is not
/// running at all. That distinction is the whole of an RPO: "you can lose at
/// most 60 seconds" is a claim about a loop, and an operator (and the release
/// smoke) needs to be able to tell that the loop is alive without a write to
/// observe.
///
/// So every tick rewrites this one small file: how many ticks have run, when
/// the last one was, how many segments they have sealed, and the last
/// segment's address. It is a status file, not a ledger — it is rewritten
/// rather than appended, and nothing reads it to decide what to replay.
pub fn record_tick(
    data_dir: &Path,
    tick_ms: u64,
    ticks: u64,
    segments: u64,
    last: Option<&WalSegment>,
) -> Result<(), String> {
    let path = data_dir.join("wal/tick.json");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("creating {}: {error}", parent.display()))?;
    }
    let document = serde_json::json!({
        "ticks": ticks,
        "lastTickMs": tick_ms,
        "segments": segments,
        "lastSegment": last.map(|segment| serde_json::json!({
            "group": segment.group,
            "startOffset": segment.start_offset,
            "endOffset": segment.end_offset,
            "blob": segment.blob_id,
        })),
    });
    std::fs::write(&path, format!("{document:#}\n"))
        .map_err(|error| format!("writing {}: {error}", path.display()))
}

/// Where the last run stopped: the highest `endOffset` in the highest group.
fn resume(pending: &Path) -> (u64, u64) {
    let Ok(text) = std::fs::read_to_string(pending) else {
        return (0, 0);
    };
    let mut group = 0;
    let mut offset = 0;
    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let this_group = row
            .get("group")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let end = row
            .get("endOffset")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        if this_group > group {
            group = this_group;
            offset = end;
        } else if this_group == group && end > offset {
            offset = end;
        }
    }
    (group, offset)
}

fn append(pending: &Path, segment: &WalSegment) -> Result<(), String> {
    use std::io::Write as _;
    let row = serde_json::json!({
        "db": segment.db,
        "generation": segment.generation,
        "group": segment.group,
        "startOffset": segment.start_offset,
        "endOffset": segment.end_offset,
        "tickMs": segment.tick_ms,
        "blob": segment.blob_id,
    });
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(pending)
        .map_err(|error| format!("opening {}: {error}", pending.display()))?;
    writeln!(file, "{row}").map_err(|error| format!("appending to the pending tail: {error}"))?;
    // The index is the thing a manifest is built from, so it is fsynced. The
    // blob store's own durability is its business.
    let _ = file.sync_data();
    Ok(())
}

/// Read the pending tail back, with each segment's sealed bytes.
///
/// `backup now`'s input. Returns the segments in replay order, and the sealed
/// bytes are re-read from the blob store rather than re-sealed: re-sealing
/// would need the plaintext, which is the one thing the gateway deliberately
/// did not keep.
pub fn pending_tail(data_dir: &Path) -> Result<Vec<(WalSegment, Vec<u8>)>, String> {
    let pending = data_dir.join(PENDING);
    let Ok(text) = std::fs::read_to_string(&pending) else {
        return Ok(Vec::new());
    };
    let blobs = FsBlobStore::open(super::blobs_dir_in(data_dir))
        .map_err(|error| format!("blob store: {error}"))?;
    let mut found = Vec::new();
    for (line_number, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let row: serde_json::Value = serde_json::from_str(line)
            .map_err(|error| format!("{}:{}: {error}", pending.display(), line_number + 1))?;
        let text_of = |field: &str| {
            row.get(field)
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let number_of = |field: &str| {
            row.get(field)
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default()
        };
        let segment = WalSegment {
            db: text_of("db"),
            generation: text_of("generation"),
            group: number_of("group"),
            start_offset: number_of("startOffset"),
            end_offset: number_of("endOffset"),
            tick_ms: number_of("tickMs"),
            blob_id: text_of("blob"),
        };
        let sealed = blobs.get(&segment.blob_id).map_err(|error| {
            format!(
                "the pending tail names blob {} and the store cannot produce it: {error}. A \
                 manifest that listed it would be a generation that cannot be replayed.",
                segment.blob_id
            )
        })?;
        found.push((segment, sealed));
    }
    found.sort_by(|left, right| left.0.replay_key().cmp(&right.0.replay_key()));
    Ok(found)
}

/// Retire the tail a generation has taken. Called after the manifest is
/// written, never before: the segments are IN that manifest now, and a tail
/// cleared first would be a generation whose WAL rows are in no manifest at all.
pub fn retire_pending(data_dir: &Path) -> Result<(), String> {
    let pending = data_dir.join(PENDING);
    if !pending.exists() {
        return Ok(());
    }
    // Moved aside rather than deleted, and overwritten on the next generation:
    // the previous generation's index is the only local record of which blobs
    // it claimed, and it costs a few hundred bytes.
    let taken = pending.with_extension("jsonl.taken");
    std::fs::rename(&pending, &taken)
        .map_err(|error| format!("retiring {}: {error}", pending.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A WAL that grows produces one segment per tick, each addressed from the
    /// last one's end — and a tick over an unchanged file produces nothing.
    #[test]
    fn each_tick_seals_exactly_the_bytes_that_arrived_since_the_last_one() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let vault = data.join("vault.db");
        std::fs::write(&vault, b"").unwrap();
        let wal = data.join("vault.db-wal");
        std::fs::write(&wal, vec![b'a'; 64]).unwrap();

        let mut capture =
            WalCapture::open(data, &vault, "vault-1".to_owned(), vec![7; 32]).unwrap();
        let first = capture.tick(1, 1_000).unwrap().expect("a first segment");
        assert_eq!((first.start_offset, first.end_offset), (0, 64));
        assert_eq!(first.group, 0);

        // Nothing new: no segment, no blob, no line.
        assert!(capture.tick(1, 2_000).unwrap().is_none());

        std::fs::write(&wal, vec![b'a'; 100]).unwrap();
        let second = capture.tick(1, 3_000).unwrap().expect("a second segment");
        assert_eq!((second.start_offset, second.end_offset), (64, 100));
        assert_ne!(first.blob_id, second.blob_id);

        let tail = pending_tail(data).unwrap();
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].0.start_offset, 0);
        assert_eq!(tail[1].0.start_offset, 64);
    }

    /// A CHECKPOINT bumps the group and resets the offset. Without this, the
    /// range 0..64 of the new file would seal under the address the range 0..64
    /// of the old file already used — one nonce, two payloads, under one key.
    #[test]
    fn a_checkpoint_that_shortens_the_wal_starts_a_new_group_at_offset_zero() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let vault = data.join("vault.db");
        std::fs::write(&vault, b"").unwrap();
        let wal = data.join("vault.db-wal");
        std::fs::write(&wal, vec![b'a'; 64]).unwrap();
        let mut capture =
            WalCapture::open(data, &vault, "vault-1".to_owned(), vec![7; 32]).unwrap();
        let first = capture.tick(1, 1_000).unwrap().unwrap();

        std::fs::write(&wal, vec![b'b'; 32]).unwrap();
        let after = capture.tick(1, 2_000).unwrap().expect("a segment");
        assert_eq!(after.group, first.group + 1);
        assert_eq!((after.start_offset, after.end_offset), (0, 32));
        // Two different payloads, two different addresses, two different blobs.
        assert_ne!(first.blob_id, after.blob_id);
    }

    /// A restarted gateway resumes where the tail stopped rather than re-sealing
    /// bytes that are already in it.
    #[test]
    fn a_restart_resumes_from_the_recorded_end_offset() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let vault = data.join("vault.db");
        std::fs::write(&vault, b"").unwrap();
        let wal = data.join("vault.db-wal");
        std::fs::write(&wal, vec![b'a'; 64]).unwrap();
        {
            let mut capture =
                WalCapture::open(data, &vault, "vault-1".to_owned(), vec![7; 32]).unwrap();
            capture.tick(1, 1_000).unwrap().unwrap();
        }
        std::fs::write(&wal, vec![b'a'; 90]).unwrap();
        let mut resumed =
            WalCapture::open(data, &vault, "vault-1".to_owned(), vec![7; 32]).unwrap();
        let next = resumed.tick(1, 2_000).unwrap().expect("a segment");
        assert_eq!((next.start_offset, next.end_offset), (64, 90));
        assert_eq!(pending_tail(data).unwrap().len(), 2);
    }

    /// The liveness marker exists after a tick that sealed NOTHING, which is
    /// the case it is for: without it, "the RPO clock is running" and "the RPO
    /// clock is dead" look the same from outside.
    #[test]
    fn a_tick_that_seals_nothing_still_records_that_it_ran() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        std::fs::write(data.join("vault.db"), b"").unwrap();
        let mut capture = WalCapture::open(
            data,
            &data.join("vault.db"),
            "vault-1".to_owned(),
            vec![7; 32],
        )
        .unwrap();
        // No `-wal` file at all, so the tick has nothing to seal.
        assert!(capture.tick(1, 1_000).unwrap().is_none());
        record_tick(data, 1_000, 1, 0, None).unwrap();
        let text = std::fs::read_to_string(data.join("wal/tick.json")).unwrap();
        let status: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(status["ticks"], 1);
        assert_eq!(status["segments"], 0);
        assert!(status["lastSegment"].is_null());
        assert!(pending_tail(data).unwrap().is_empty());
    }

    #[test]
    fn a_retired_tail_is_moved_aside_and_the_next_generation_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let vault = data.join("vault.db");
        std::fs::write(&vault, b"").unwrap();
        std::fs::write(data.join("vault.db-wal"), vec![b'a'; 16]).unwrap();
        let mut capture =
            WalCapture::open(data, &vault, "vault-1".to_owned(), vec![7; 32]).unwrap();
        capture.tick(1, 1_000).unwrap().unwrap();
        assert_eq!(pending_tail(data).unwrap().len(), 1);
        retire_pending(data).unwrap();
        assert!(pending_tail(data).unwrap().is_empty());
        assert!(data.join("wal/pending.jsonl.taken").exists());
    }

    /// An index line whose blob is gone FAILS rather than being skipped: a
    /// manifest listing a segment the store cannot produce is a generation that
    /// cannot be replayed, and finding that out at restore time is the whole
    /// failure mode backups exist to avoid.
    #[test]
    fn a_pending_line_whose_blob_is_missing_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        std::fs::create_dir_all(data.join("wal")).unwrap();
        std::fs::create_dir_all(super::super::blobs_dir_in(data)).unwrap();
        std::fs::write(
            data.join(PENDING),
            "{\"db\":\"vault\",\"generation\":\"1\",\"group\":0,\"startOffset\":0,\"endOffset\":8,\"tickMs\":1,\"blob\":\"deadbeef\"}\n",
        )
        .unwrap();
        let error = pending_tail(data).expect_err("must refuse");
        assert!(error.contains("deadbeef"), "{error}");
        assert!(error.contains("cannot be replayed"), "{error}");
    }
}
