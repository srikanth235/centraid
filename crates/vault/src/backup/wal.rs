//! Reading SQLite's write-ahead log **properly** (#1029 §2, B6, B7, B9).
//!
//! ## WHAT THIS REPLACES, AND WHY IT IS A REWRITE AND NOT A FIX
//!
//! The module that stood here shipped **byte ranges of the `-wal` file**, cut at
//! whatever length the file happened to have when a timer fired, sealed under a
//! nonce derived from `(start offset, end offset)`. Reference A names four
//! defects in that one sentence and they compound:
//!
//! - **B7** — the cut is at the file's current length, so a segment routinely
//!   ends mid-frame or mid-transaction. The header, the salts and the checksums
//!   were never read at all.
//! - **B6** — a WAL restart was detected only when the file got *shorter*.
//!   SQLite's automatic checkpoint restarts the WAL **in place**, with new salts
//!   at the same length, so frames were silently lost. (W1 has since set
//!   `wal_autocheckpoint = 0`, which removes the automatic checkpoint but not
//!   the class: any other opener, a share extension or a debugging tool, still
//!   restarts it.)
//! - **B9** — the nonce was derived from the address, which is safe only if one
//!   address always names one set of bytes. B6 and B8 broke exactly that, so the
//!   old stack had **nonce reuse under one key**.
//! - **B4** — even a perfectly cut byte range could not be replayed, because the
//!   base it would replay onto was a `VACUUM INTO` copy with renumbered pages.
//!
//! §2's answer is that **what gets shipped is pages, not WAL bytes**. This
//! module is the half that reads: it parses the header, verifies the checksum
//! chain in the byte order the magic names, and hands back frames up to the
//! **last commit frame**. [`super::segment`] is the half that ships.
//!
//! ## The format, as SQLite writes it
//!
//! ```text
//! header, 32 bytes, always big-endian:
//!   magic(4) version(4) pageSize(4) checkpointSeq(4) salt1(4) salt2(4) sum1(4) sum2(4)
//! then, repeated:
//!   frame header, 24 bytes:  pgno(4) dbSize(4) salt1(4) salt2(4) sum1(4) sum2(4)
//!   page data, pageSize bytes
//! ```
//!
//! `dbSize` is non-zero **only on a commit frame**, where it is the size of the
//! database in pages after that transaction. That field is the only transaction
//! boundary the WAL has, and it is what a segment is cut on.
//!
//! The magic names the byte order the **checksums** are computed in —
//! `0x377f0682` little-endian, `0x377f0683` big-endian — and nothing else in the
//! file changes with it. Getting this wrong makes every frame look corrupt on
//! one half of the world's machines.
//!
//! ## Trailing frames that fail the chain are not an error
//!
//! They are a crash mid-write, and SQLite ignores them on recovery. So does
//! [`read_frames`]: the walk stops at the first frame that does not verify, and
//! everything before it is real. Treating them as corruption would turn every
//! power loss into a failed backup.

/// A WAL header is 32 bytes.
pub const HEADER_BYTES: usize = 32;

/// A frame header is 24 bytes.
pub const FRAME_HEADER_BYTES: usize = 24;

/// `0x377f0682`: the checksums in this file are little-endian.
pub const MAGIC_LITTLE: u32 = 0x377f_0682;

/// `0x377f0683`: the checksums in this file are big-endian.
pub const MAGIC_BIG: u32 = 0x377f_0683;

/// The WAL format version SQLite writes and this reader understands.
pub const WAL_FORMAT_VERSION: u32 = 3_007_000;

#[derive(Debug, thiserror::Error)]
pub enum WalError {
    #[error("the write-ahead log is shorter than its own header")]
    NoHeader,
    #[error("{0:#010x} is not a write-ahead log's magic")]
    NotAWal(u32),
    #[error("write-ahead log format {0} is not this reader's")]
    UnsupportedVersion(u32),
    #[error("the write-ahead log's header checksum does not verify")]
    HeaderChecksum,
    #[error("a write-ahead log page is {0} bytes and this vault's pages are {1}")]
    PageSize(u32, u32),
    #[error("reading the write-ahead log at {path}: {source}")]
    Io {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "the write-ahead log restarted under the capture cursor: it carries salts \
         ({found1:#010x}, {found2:#010x}) and the cursor was taken at \
         ({held1:#010x}, {held2:#010x}) with {frames} frame(s) already captured"
    )]
    Restarted {
        held1: u32,
        held2: u32,
        found1: u32,
        found2: u32,
        frames: u64,
    },
}

type Result<T> = std::result::Result<T, WalError>;

/// The header of a `-wal` file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WalHeader {
    /// Which byte order the checksums are in.
    pub big_endian_checksums: bool,
    pub page_size: u32,
    pub checkpoint_seq: u32,
    /// The pair that identifies this **instance** of the WAL. A truncate mints
    /// a new pair, which is how a restart is seen (B6).
    pub salt1: u32,
    pub salt2: u32,
    /// The checksum the first frame's chain continues from.
    pub checksum: (u32, u32),
}

/// One frame, as capture cares about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalFrame {
    /// Which page of the database this frame carries.
    pub page_number: u32,
    /// The database size in pages after this transaction, or `None` when this
    /// frame is not a commit frame. **This is the only transaction boundary the
    /// WAL has.**
    pub commit_db_size: Option<u32>,
    /// The page's bytes.
    pub page: Vec<u8>,
}

impl WalFrame {
    /// Whether this frame ends a transaction.
    #[must_use]
    pub const fn is_commit(&self) -> bool {
        self.commit_db_size.is_some()
    }
}

/// What a walk of the log found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalRead {
    pub header: WalHeader,
    /// Frames from the cursor's position up to and including the **last commit
    /// frame**. Never a partial transaction (B7).
    pub frames: Vec<WalFrame>,
    /// How many frames of the file this read consumed, counted from the start
    /// of the file. The next read starts here.
    pub next_frame: u64,
    /// How many commits the frames contain. Capture's txid advances by this.
    pub commits: u64,
    /// Whether frames were seen past the last commit — a transaction in flight,
    /// or a crash mid-write. Either way they are left for the next read.
    pub uncommitted_tail: bool,
}

/// SQLite's checksum: two 32-bit accumulators over 8-byte words (`walChecksumBytes`).
///
/// Not a standard checksum and deliberately not replaced by one: a reader that
/// computes a different function than the writer rejects every frame, and this
/// function's whole job is to agree with SQLite byte for byte.
#[must_use]
pub fn checksum(big_endian: bool, seed: (u32, u32), data: &[u8]) -> (u32, u32) {
    let (mut s0, mut s1) = seed;
    for word in data.chunks_exact(8) {
        let (left, right) = if big_endian {
            (
                u32::from_be_bytes([word[0], word[1], word[2], word[3]]),
                u32::from_be_bytes([word[4], word[5], word[6], word[7]]),
            )
        } else {
            (
                u32::from_le_bytes([word[0], word[1], word[2], word[3]]),
                u32::from_le_bytes([word[4], word[5], word[6], word[7]]),
            )
        };
        s0 = s0.wrapping_add(left).wrapping_add(s1);
        s1 = s1.wrapping_add(right).wrapping_add(s0);
    }
    (s0, s1)
}

fn be32(bytes: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Parse a `-wal` file's header.
///
/// # Errors
/// [`WalError::NoHeader`], [`WalError::NotAWal`], [`WalError::UnsupportedVersion`]
/// or [`WalError::HeaderChecksum`].
pub fn read_header(bytes: &[u8]) -> Result<WalHeader> {
    if bytes.len() < HEADER_BYTES {
        return Err(WalError::NoHeader);
    }
    let magic = be32(bytes, 0);
    let big_endian_checksums = match magic {
        MAGIC_LITTLE => false,
        MAGIC_BIG => true,
        other => return Err(WalError::NotAWal(other)),
    };
    let version = be32(bytes, 4);
    if version != WAL_FORMAT_VERSION {
        return Err(WalError::UnsupportedVersion(version));
    }
    // The header's own checksum covers its first 24 bytes, seeded from zero.
    let stated = (be32(bytes, 24), be32(bytes, 28));
    if checksum(big_endian_checksums, (0, 0), &bytes[..24]) != stated {
        return Err(WalError::HeaderChecksum);
    }
    Ok(WalHeader {
        big_endian_checksums,
        page_size: be32(bytes, 8),
        checkpoint_seq: be32(bytes, 12),
        salt1: be32(bytes, 16),
        salt2: be32(bytes, 20),
        checksum: stated,
    })
}

/// Where a read of the log starts, and what it is continuing.
///
/// **The salts are half of this and they are why it is durable** (§2, B6). A
/// cursor that recorded only a frame index would happily keep counting into a
/// WAL that had been truncated and rewritten underneath it, which is the bug
/// that lost frames silently.
///
/// ## Why there is no checksum in here
///
/// §2 says to record `(salt1, salt2, frame index)` and that is exactly what
/// this holds. A cursor could also carry the running checksum at its frame, to
/// save re-verifying the chain below it — and it deliberately does not, because
/// then the durable cursor would carry *derived* state that has to stay in step
/// with the file, and a cursor whose checksum is stale or absent would silently
/// verify nothing. [`read_frames`] therefore walks the chain **from the header
/// every time** and only emits frames at or past `next_frame`. The log is
/// bounded by the checkpoint threshold, so the cost is small and the class of
/// bug is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WalCursor {
    /// The instance of the WAL this cursor was taken in. `None` before the
    /// first read of a fresh log.
    pub salts: Option<(u32, u32)>,
    /// Frames already captured, counted from the start of the file.
    pub next_frame: u64,
}

impl WalCursor {
    /// A cursor at the start of a log nothing has been captured from.
    #[must_use]
    pub const fn fresh() -> Self {
        Self {
            salts: None,
            next_frame: 0,
        }
    }

    /// Whether this cursor has frames behind it that a restart would strand.
    #[must_use]
    pub const fn is_mid_log(&self) -> bool {
        self.next_frame > 0
    }
}

/// Walk the log from `cursor` to the last commit frame.
///
/// ## The break rule, stated once
///
/// A WAL restart with new salts is **normal** after every truncate (§2,
/// Reference B). It is a **break** only *mid-cursor* — when frames were already
/// captured in the instance that has now gone. So:
///
/// - salts equal to the cursor's: continue;
/// - cursor at frame zero: adopt whatever salts are there, in any instance;
/// - salts different with frames behind us: [`WalError::Restarted`], and the
///   caller starts a new generation (§2, F3). Anything else would seal bytes
///   from two instances of the log under one cursor and call the result a
///   contiguous stream.
///
/// # Errors
/// [`WalError::Restarted`] for the break above; [`WalError::PageSize`] when the
/// log's pages are not this vault's; otherwise whatever [`read_header`] refused.
pub fn read_frames(bytes: &[u8], cursor: &WalCursor, page_size: u32) -> Result<WalRead> {
    let header = read_header(bytes)?;
    if header.page_size != page_size {
        return Err(WalError::PageSize(header.page_size, page_size));
    }
    if let Some((held1, held2)) = cursor.salts
        && (held1, held2) != (header.salt1, header.salt2)
        && cursor.is_mid_log()
    {
        return Err(WalError::Restarted {
            held1,
            held2,
            found1: header.salt1,
            found2: header.salt2,
            frames: cursor.next_frame,
        });
    }

    let frame_bytes = FRAME_HEADER_BYTES + page_size as usize;
    // A cursor into a different instance restarts at zero: the instance it
    // counted in no longer exists, and `is_mid_log` above proved nothing was
    // captured from it.
    let same_instance = cursor.salts == Some((header.salt1, header.salt2));
    let skip_below = if same_instance { cursor.next_frame } else { 0 };
    // ALWAYS FROM THE HEADER. The chain is verified in full and only the frames
    // at or past the cursor are emitted — see [`WalCursor`] for why the cursor
    // carries no checksum of its own.
    let mut running = header.checksum;

    let mut frames = Vec::new();
    let mut commits = 0_u64;
    // Where the walk stood at the last commit frame, so the cursor we hand back
    // never points inside a transaction.
    let mut at_last_commit = (skip_below, 0_usize);
    let mut index = 0_u64;

    loop {
        let at = HEADER_BYTES + (index as usize) * frame_bytes;
        let Some(frame) = bytes.get(at..at + frame_bytes) else {
            break;
        };
        // A frame from another instance of the log is the end of this one:
        // SQLite leaves the old bytes in place when it restarts, so past the
        // live tail there is stale data that verifies against nothing.
        if be32(frame, 8) != header.salt1 || be32(frame, 12) != header.salt2 {
            break;
        }
        let after_header = checksum(header.big_endian_checksums, running, &frame[..8]);
        let computed = checksum(
            header.big_endian_checksums,
            after_header,
            &frame[FRAME_HEADER_BYTES..],
        );
        if computed != (be32(frame, 16), be32(frame, 20)) {
            // A crash mid-write. SQLite ignores the tail and so do we.
            break;
        }
        running = computed;
        let db_size = be32(frame, 4);
        if index >= skip_below {
            frames.push(WalFrame {
                page_number: be32(frame, 0),
                commit_db_size: (db_size != 0).then_some(db_size),
                page: frame[FRAME_HEADER_BYTES..].to_vec(),
            });
            if db_size != 0 {
                commits += 1;
            }
        }
        index += 1;
        if db_size != 0 {
            at_last_commit = (index.max(skip_below), frames.len());
        }
    }

    // CUT ON A COMMIT BOUNDARY, NEVER MID-FRAME AND NEVER MID-TRANSACTION (B7).
    let (next_frame, keep) = at_last_commit;
    let uncommitted_tail = frames.len() > keep;
    frames.truncate(keep);
    Ok(WalRead {
        header,
        frames,
        next_frame,
        commits,
        uncommitted_tail,
    })
}

/// The cursor to record after a [`read_frames`], **before** any checkpoint.
///
/// §2: "Record `(salt1, salt2, last frame, last_txid)` durably with the spool
/// entry, before any checkpoint makes it stale."
#[must_use]
pub fn cursor_after(read: &WalRead) -> WalCursor {
    WalCursor {
        salts: Some((read.header.salt1, read.header.salt2)),
        next_frame: read.next_frame,
    }
}

/// Read the `-wal` sidecar beside a vault file. Absent is not an error: a vault
/// that has just been checkpointed has no log to capture.
///
/// # Errors
/// [`WalError::Io`] for anything but a missing file.
pub fn read_sidecar(vault_file: &std::path::Path) -> Result<Option<Vec<u8>>> {
    let path = sidecar_path(vault_file);
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(WalError::Io { path, source }),
    }
}

/// `<vault>.db` → `<vault>.db-wal`, which is the name SQLite uses.
#[must_use]
pub fn sidecar_path(vault_file: &std::path::Path) -> std::path::PathBuf {
    let mut name = vault_file.as_os_str().to_os_string();
    name.push("-wal");
    std::path::PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: u32 = 64;

    /// Build a WAL the way SQLite does, so the reader is tested against the
    /// format and not against its own writer's shortcuts.
    struct WalBuilder {
        bytes: Vec<u8>,
        big_endian: bool,
        salt1: u32,
        salt2: u32,
        running: (u32, u32),
    }

    impl WalBuilder {
        fn new(salt1: u32, salt2: u32, big_endian: bool) -> Self {
            let mut bytes = Vec::new();
            bytes.extend_from_slice(
                &(if big_endian { MAGIC_BIG } else { MAGIC_LITTLE }).to_be_bytes(),
            );
            bytes.extend_from_slice(&WAL_FORMAT_VERSION.to_be_bytes());
            bytes.extend_from_slice(&PAGE.to_be_bytes());
            bytes.extend_from_slice(&1_u32.to_be_bytes());
            bytes.extend_from_slice(&salt1.to_be_bytes());
            bytes.extend_from_slice(&salt2.to_be_bytes());
            let running = checksum(big_endian, (0, 0), &bytes[..24]);
            bytes.extend_from_slice(&running.0.to_be_bytes());
            bytes.extend_from_slice(&running.1.to_be_bytes());
            Self {
                bytes,
                big_endian,
                salt1,
                salt2,
                running,
            }
        }

        fn frame(&mut self, page_number: u32, db_size: u32, fill: u8) -> &mut Self {
            let mut head = Vec::new();
            head.extend_from_slice(&page_number.to_be_bytes());
            head.extend_from_slice(&db_size.to_be_bytes());
            let page = vec![fill; PAGE as usize];
            let after_head = checksum(self.big_endian, self.running, &head);
            let sum = checksum(self.big_endian, after_head, &page);
            self.running = sum;
            self.bytes.extend_from_slice(&head);
            self.bytes.extend_from_slice(&self.salt1.to_be_bytes());
            self.bytes.extend_from_slice(&self.salt2.to_be_bytes());
            self.bytes.extend_from_slice(&sum.0.to_be_bytes());
            self.bytes.extend_from_slice(&sum.1.to_be_bytes());
            self.bytes.extend_from_slice(&page);
            self
        }

        /// A frame whose checksum is wrong: a crash mid-write.
        fn torn_frame(&mut self, page_number: u32) -> &mut Self {
            let before = self.running;
            self.frame(page_number, 0, 0xff);
            self.running = before;
            let at = self.bytes.len() - PAGE as usize - 8;
            self.bytes[at] ^= 0x01;
            self
        }
    }

    /// **B7.** A segment is cut on a commit boundary, never mid-transaction.
    #[test]
    fn a_read_stops_at_the_last_commit_frame_and_never_mid_transaction() {
        let mut wal = WalBuilder::new(0xaaaa_0001, 0xbbbb_0001, false);
        // Two committed transactions, then two frames of a third still open.
        wal.frame(1, 0, 1).frame(2, 3, 2); // txn 1: two frames, commits at 3 pages
        wal.frame(4, 4, 3); // txn 2: one frame, commits at 4 pages
        wal.frame(5, 0, 4).frame(6, 0, 5); // txn 3: in flight

        let read = read_frames(&wal.bytes, &WalCursor::fresh(), PAGE).expect("reads");
        assert_eq!(read.frames.len(), 3, "the open transaction is left alone");
        assert_eq!(read.commits, 2);
        assert_eq!(read.next_frame, 3);
        assert!(read.uncommitted_tail);
        assert!(read.frames.last().expect("a frame").is_commit());
        assert_eq!(read.frames.last().expect("a frame").commit_db_size, Some(4));
    }

    /// Trailing frames that fail the chain are a crash mid-write, and SQLite
    /// ignores them. So does this.
    #[test]
    fn a_torn_tail_is_ignored_exactly_as_sqlite_ignores_it() {
        let mut wal = WalBuilder::new(7, 8, false);
        wal.frame(1, 1, 1);
        wal.torn_frame(2);
        let read = read_frames(&wal.bytes, &WalCursor::fresh(), PAGE).expect("reads");
        assert_eq!(read.frames.len(), 1);
        assert_eq!(read.next_frame, 1);
    }

    /// **B6, the whole defect.** A restart in place, at the same length, with
    /// new salts: the old code compared file lengths and saw nothing.
    #[test]
    fn a_restart_in_place_at_the_same_length_is_a_break_not_a_continuation() {
        let mut first = WalBuilder::new(0x1111_1111, 0x2222_2222, false);
        first.frame(1, 1, 0xa1).frame(2, 2, 0xa2);
        let read = read_frames(&first.bytes, &WalCursor::fresh(), PAGE).expect("reads");
        let cursor = cursor_after(&read);
        assert_eq!(cursor.next_frame, 2);

        // The same file length, new salts, different bytes — SQLite restarting
        // the log in place after a checkpoint somebody else took.
        let mut second = WalBuilder::new(0x3333_3333, 0x4444_4444, false);
        second.frame(1, 1, 0xb1).frame(2, 2, 0xb2);
        assert_eq!(first.bytes.len(), second.bytes.len(), "same length");

        let error = read_frames(&second.bytes, &cursor, PAGE).expect_err("must break");
        assert!(
            matches!(error, WalError::Restarted { frames: 2, .. }),
            "{error}"
        );
    }

    /// And a restart is **normal** when nothing was captured from the instance
    /// that went away. That is what happens after every truncate we take
    /// ourselves, so it must not raise a break.
    #[test]
    fn a_restart_with_nothing_captured_behind_it_is_normal() {
        let mut wal = WalBuilder::new(0x5555_5555, 0x6666_6666, false);
        wal.frame(1, 1, 9);
        let cursor = WalCursor {
            salts: Some((0x1111_1111, 0x2222_2222)),
            next_frame: 0,
        };
        let read = read_frames(&wal.bytes, &cursor, PAGE).expect("a fresh instance is fine");
        assert_eq!(read.frames.len(), 1);
        assert_eq!(cursor_after(&read).salts, Some((0x5555_5555, 0x6666_6666)));
    }

    /// The magic names the byte order of the CHECKSUMS, and of nothing else.
    #[test]
    fn both_checksum_byte_orders_are_read() {
        for big_endian in [false, true] {
            let mut wal = WalBuilder::new(1, 2, big_endian);
            wal.frame(1, 1, 0x42);
            let read = read_frames(&wal.bytes, &WalCursor::fresh(), PAGE).expect("reads");
            assert_eq!(read.header.big_endian_checksums, big_endian);
            assert_eq!(read.frames.len(), 1);
        }
    }

    #[test]
    fn a_continuing_read_picks_up_where_the_cursor_left_off() {
        let mut wal = WalBuilder::new(3, 4, false);
        wal.frame(1, 1, 0x10);
        let first = read_frames(&wal.bytes, &WalCursor::fresh(), PAGE).expect("reads");
        let cursor = cursor_after(&first);

        wal.frame(2, 2, 0x20).frame(3, 3, 0x30);
        let second = read_frames(&wal.bytes, &cursor, PAGE).expect("reads");
        assert_eq!(second.frames.len(), 2);
        assert_eq!(second.commits, 2);
        assert_eq!(second.next_frame, 3);
        assert_eq!(second.frames[0].page, vec![0x20; PAGE as usize]);
    }

    #[test]
    fn a_log_that_is_not_one_is_named_rather_than_parsed() {
        assert!(matches!(read_header(b"short"), Err(WalError::NoHeader)));
        let mut wal = WalBuilder::new(1, 1, false);
        wal.frame(1, 1, 0);
        let mut wrong_magic = wal.bytes.clone();
        wrong_magic[3] ^= 0xff;
        assert!(matches!(
            read_header(&wrong_magic),
            Err(WalError::NotAWal(_))
        ));
        let mut wrong_sum = wal.bytes.clone();
        wrong_sum[24] ^= 0x01;
        assert!(matches!(
            read_header(&wrong_sum),
            Err(WalError::HeaderChecksum)
        ));
        assert!(matches!(
            read_frames(&wal.bytes, &WalCursor::fresh(), PAGE * 2),
            Err(WalError::PageSize(..))
        ));
    }

    #[test]
    fn stale_frames_past_the_live_tail_are_not_read() {
        // A long instance, then a short one written over its front. The bytes
        // past the new tail still carry the old salts.
        let mut old = WalBuilder::new(0x0101_0101, 0x0202_0202, false);
        old.frame(1, 1, 1).frame(2, 2, 2).frame(3, 3, 3);
        let mut new = WalBuilder::new(0x0303_0303, 0x0404_0404, false);
        new.frame(1, 1, 9);
        let mut mixed = new.bytes.clone();
        mixed.extend_from_slice(&old.bytes[new.bytes.len()..]);

        let read = read_frames(&mixed, &WalCursor::fresh(), PAGE).expect("reads");
        assert_eq!(
            read.frames.len(),
            1,
            "the stale tail is not this instance's"
        );
        assert_eq!(read.frames[0].page, vec![9; PAGE as usize]);
    }

    #[test]
    fn the_sidecar_is_named_the_way_sqlite_names_it() {
        assert_eq!(
            sidecar_path(std::path::Path::new("/a/vault.db")),
            std::path::PathBuf::from("/a/vault.db-wal")
        );
        assert_eq!(
            read_sidecar(std::path::Path::new("/nowhere/vault.db")).expect("absent is fine"),
            None
        );
    }
}
