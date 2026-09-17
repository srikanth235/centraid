//! The page segment: what capture ships, and what restore applies (#1029 §2).
//!
//! ## Pages, not WAL bytes — and that is the fix for B3, B4 and B7
//!
//! §2: "What gets shipped is **pages**, not WAL bytes. […] Replay writes pages
//! straight into the database file, so restore never has to rebuild a WAL, its
//! salts or its checksums."
//!
//! Each of those three defects is a consequence of shipping the log itself:
//!
//! - **B7** disappears because a segment is built from whole frames up to a
//!   commit, so there is no "cut" to get wrong.
//! - **B4** disappears because a page number is meaningful again: the base is
//!   page-identical ([`super::base`]), so page 41 in a segment is page 41 in the
//!   file. Under `VACUUM INTO` it was not, and no amount of care at the cut
//!   would have made a replay work.
//! - **B3** — restore decrypting a segment, discarding it and reporting
//!   "replayed" — becomes impossible to write by accident, because [`apply`]
//!   takes the file it is writing into and the caller has nothing else to do
//!   with the segment.
//!
//! ## The census travels with the segment
//!
//! Every segment carries the per-table row census as of its last commit, so a
//! restore verifies **after applying segments** and not only at a base boundary
//! (§2, Generations). It is the phone-side half of F4's shrink guard, and it is
//! what the replay fuzz test compares.
//!
//! ## The wire, and why it is a format
//!
//! The segment stream is the seam W4 (the gateway) and W5 (restore) both read,
//! and Reference B's seam list says to "keep it a format, not a private detail
//! of the uploader". So it is explicit, big-endian, and versioned:
//!
//! ```text
//! "CNSG" │ 1 │ generation(16) │ firstTxid(8) │ lastTxid(8) │ dbSizePages(4) │ pageSize(4)
//!        │ censusCount(4) │ [ nameLen(2) │ name │ rows(8) ]*
//!        │ pageCount(4)   │ [ pgno(4) │ page(pageSize) ]*
//! ```
//!
//! Pages are written in page-number order and each page appears **once**: when
//! a transaction range writes page 7 four times, the segment carries the last
//! version, which is the only one a replay would keep anyway.

use std::collections::BTreeMap;

use crate::backup::wal::WalFrame;

/// The segment format's magic.
pub const SEGMENT_MAGIC: &[u8; 4] = b"CNSG";

/// The segment format's version.
pub const SEGMENT_VERSION: u8 = 1;

/// A generation id: **128 random bits, never a counter** (§2, F3, #116).
///
/// ## Why it cannot be a counter, restated because B8 was exactly this
///
/// The stack this replaces computed the generation as `pending_tail().len() + 1`
/// on the capture tick and `manifests + 1` in `backup now`. Two backups running
/// at once forked into the same "generation", and `retire_pending` reset the
/// offsets to zero underneath both — which, with the old address-derived nonce,
/// is B9's nonce reuse arriving by a second road.
///
/// F3 is the positive statement: generation ids **order nothing**. A gateway
/// cannot tell from two ids which is newer and is not meant to; the lease has a
/// monotonic epoch for that and it is W5's. What a generation is, is an
/// append stream with a base at its root (F10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GenerationId([u8; 16]);

impl GenerationId {
    /// Mint a new generation.
    ///
    /// # Errors
    /// [`SegmentError::Entropy`] when the operating system will not give
    /// randomness. **Never a fallback**: a predictable generation id is a
    /// counter with extra steps, which is the defect.
    pub fn mint() -> Result<Self, SegmentError> {
        use rand::TryRngCore as _;

        let mut bytes = [0_u8; 16];
        rand::rngs::OsRng
            .try_fill_bytes(&mut bytes)
            .map_err(|error| SegmentError::Entropy(error.to_string()))?;
        Ok(Self(bytes))
    }

    /// Adopt an id read back from a manifest or a cursor.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    /// As it is written down.
    #[must_use]
    pub fn hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Read one back from its hex.
    ///
    /// # Errors
    /// [`SegmentError::Malformed`] for anything but 32 hex characters.
    pub fn from_hex(text: &str) -> Result<Self, SegmentError> {
        let bytes = hex::decode(text).map_err(|_| SegmentError::Malformed {
            reason: "a generation id is 32 hex characters",
        })?;
        let bytes: [u8; 16] = bytes.try_into().map_err(|_| SegmentError::Malformed {
            reason: "a generation id is 16 bytes",
        })?;
        Ok(Self(bytes))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SegmentError {
    #[error("not a centraid segment: {reason}")]
    Malformed { reason: &'static str },
    #[error("segment format version {0} is not this reader's")]
    UnsupportedVersion(u8),
    #[error("the operating system would not give entropy for a generation id: {0}")]
    Entropy(String),
    #[error("applying a segment to {path}: {source}")]
    Io {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "segment {generation} covers txids {first}..={last}, which does not continue {expected}"
    )]
    OutOfOrder {
        generation: String,
        first: u64,
        last: u64,
        expected: u64,
    },
}

/// The set of pages a contiguous range of commits changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageSegment {
    pub generation: GenerationId,
    /// The first txid this segment covers. Txids are a per-generation counter
    /// **owned by capture**, not a WAL offset (§2, B8).
    pub first_txid: u64,
    pub last_txid: u64,
    /// The database size in pages after the last commit. A replay truncates to
    /// this, which is how a `DELETE` that frees pages shrinks a restored file.
    pub db_size_pages: u32,
    pub page_size: u32,
    /// Rows per table as of `last_txid`, in name order.
    pub census: Vec<(String, i64)>,
    /// The latest version of each changed page, by page number.
    pub pages: BTreeMap<u32, Vec<u8>>,
}

impl PageSegment {
    /// Build a segment from the frames of a walk (see [`super::wal::read_frames`]).
    ///
    /// The frames must end on a commit — `read_frames` guarantees it — because
    /// `db_size_pages` comes from that frame and a segment without one would
    /// describe no state the database was ever in.
    ///
    /// # Errors
    /// [`SegmentError::Malformed`] when the frames do not end on a commit.
    pub fn from_frames(
        generation: GenerationId,
        first_txid: u64,
        page_size: u32,
        census: Vec<(String, i64)>,
        frames: &[WalFrame],
    ) -> Result<Self, SegmentError> {
        let last = frames.last().ok_or(SegmentError::Malformed {
            reason: "a segment needs at least one frame",
        })?;
        let db_size_pages = last.commit_db_size.ok_or(SegmentError::Malformed {
            reason: "a segment's last frame must be a commit frame",
        })?;
        let commits = frames.iter().filter(|frame| frame.is_commit()).count() as u64;
        // LAST WRITER WINS, per page (§2). A page written four times in the
        // range restores to its last version and nothing else is reachable.
        let mut pages = BTreeMap::new();
        for frame in frames {
            pages.insert(frame.page_number, frame.page.clone());
        }
        Ok(Self {
            generation,
            first_txid,
            last_txid: first_txid + commits - 1,
            db_size_pages,
            page_size,
            census,
            pages,
        })
    }

    /// How many commits this segment covers.
    #[must_use]
    pub const fn commits(&self) -> u64 {
        self.last_txid - self.first_txid + 1
    }

    /// The wire bytes, which are what gets sealed.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(64 + self.pages.len() * (4 + self.page_size as usize));
        out.extend_from_slice(SEGMENT_MAGIC);
        out.push(SEGMENT_VERSION);
        out.extend_from_slice(self.generation.as_bytes());
        out.extend_from_slice(&self.first_txid.to_be_bytes());
        out.extend_from_slice(&self.last_txid.to_be_bytes());
        out.extend_from_slice(&self.db_size_pages.to_be_bytes());
        out.extend_from_slice(&self.page_size.to_be_bytes());
        out.extend_from_slice(&(self.census.len() as u32).to_be_bytes());
        for (table, rows) in &self.census {
            let name = table.as_bytes();
            out.extend_from_slice(&(name.len() as u16).to_be_bytes());
            out.extend_from_slice(name);
            out.extend_from_slice(&rows.to_be_bytes());
        }
        out.extend_from_slice(&(self.pages.len() as u32).to_be_bytes());
        for (page_number, page) in &self.pages {
            out.extend_from_slice(&page_number.to_be_bytes());
            out.extend_from_slice(page);
        }
        out
    }

    /// Read a segment back.
    ///
    /// # Errors
    /// [`SegmentError::Malformed`] or [`SegmentError::UnsupportedVersion`].
    pub fn decode(bytes: &[u8]) -> Result<Self, SegmentError> {
        let mut at = 0_usize;
        let mut take = |count: usize| -> Result<&[u8], SegmentError> {
            let end = at.checked_add(count).ok_or(SegmentError::Malformed {
                reason: "a length overflows",
            })?;
            let slice = bytes.get(at..end).ok_or(SegmentError::Malformed {
                reason: "the segment ends early",
            })?;
            at = end;
            Ok(slice)
        };
        if take(4)? != SEGMENT_MAGIC {
            return Err(SegmentError::Malformed {
                reason: "these bytes are not a segment",
            });
        }
        let version = take(1)?[0];
        if version != SEGMENT_VERSION {
            return Err(SegmentError::UnsupportedVersion(version));
        }
        let generation = GenerationId::from_bytes(take(16)?.try_into().map_err(|_| {
            SegmentError::Malformed {
                reason: "generation id",
            }
        })?);
        let u64_at = |slice: &[u8]| -> u64 {
            let mut wide = [0_u8; 8];
            wide.copy_from_slice(slice);
            u64::from_be_bytes(wide)
        };
        let u32_at = |slice: &[u8]| -> u32 {
            let mut wide = [0_u8; 4];
            wide.copy_from_slice(slice);
            u32::from_be_bytes(wide)
        };
        let first_txid = u64_at(take(8)?);
        let last_txid = u64_at(take(8)?);
        let db_size_pages = u32_at(take(4)?);
        let page_size = u32_at(take(4)?);
        if page_size == 0 || last_txid < first_txid {
            return Err(SegmentError::Malformed {
                reason: "a segment with no pages or a txid range that runs backwards",
            });
        }
        let census_count = u32_at(take(4)?) as usize;
        let mut census = Vec::with_capacity(census_count.min(1024));
        for _ in 0..census_count {
            let name_len = {
                let field = take(2)?;
                u16::from_be_bytes([field[0], field[1]]) as usize
            };
            let name = String::from_utf8(take(name_len)?.to_vec()).map_err(|_| {
                SegmentError::Malformed {
                    reason: "a table name is not UTF-8",
                }
            })?;
            #[allow(clippy::cast_possible_wrap)]
            census.push((name, u64_at(take(8)?) as i64));
        }
        let page_count = u32_at(take(4)?) as usize;
        let mut pages = BTreeMap::new();
        for _ in 0..page_count {
            let page_number = u32_at(take(4)?);
            pages.insert(page_number, take(page_size as usize)?.to_vec());
        }
        if at != bytes.len() {
            return Err(SegmentError::Malformed {
                reason: "trailing bytes after the segment",
            });
        }
        Ok(Self {
            generation,
            first_txid,
            last_txid,
            db_size_pages,
            page_size,
            census,
            pages,
        })
    }
}

/// **Apply a segment to a database file** (B3).
///
/// The defect this closes is not subtle: `recover.rs:258-266` decrypted every
/// segment, dropped it on the floor and printed "replayed". A restore that
/// reports success while discarding every commit since the base is worse than
/// one that fails, because nothing tells the member which they got.
///
/// Pages are written at `(pgno - 1) * page_size`, and the file is then truncated
/// to `db_size_pages * page_size` — that truncation is not tidiness: it is how a
/// transaction that freed pages produces a file of the right size, and skipping
/// it leaves a tail SQLite would read as live pages.
///
/// The caller is responsible for the file being a page-identical base
/// ([`super::base`]), which is what makes a page number mean anything (B4).
///
/// # Errors
/// [`SegmentError::Io`] for anything the filesystem refused.
pub fn apply(file: &std::path::Path, segment: &PageSegment) -> Result<(), SegmentError> {
    use std::io::{Seek as _, SeekFrom, Write as _};

    let io = |source: std::io::Error| SegmentError::Io {
        path: file.to_path_buf(),
        source,
    };
    let mut handle = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(file)
        .map_err(io)?;
    for (page_number, page) in &segment.pages {
        let at = u64::from(page_number.saturating_sub(1)) * u64::from(segment.page_size);
        handle.seek(SeekFrom::Start(at)).map_err(io)?;
        handle.write_all(page).map_err(io)?;
    }
    handle
        .set_len(u64::from(segment.db_size_pages) * u64::from(segment.page_size))
        .map_err(io)?;
    // FSYNC, because a restore that has not reached the platter has not
    // happened. The next segment writes over this file and a crash between the
    // two must leave a prefix that is a real state of the database.
    handle.sync_all().map_err(io)?;
    Ok(())
}

/// Apply a run of segments in txid order, refusing a gap.
///
/// A gap is the failure a restore must never paper over: pages from txid 9 laid
/// onto a file that stopped at txid 4 is a file that was never a state of the
/// database. `expect_first` is the txid the base covers up to, plus one.
///
/// # Errors
/// [`SegmentError::OutOfOrder`] for a gap or an overlap; otherwise whatever
/// [`apply`] refused.
pub fn apply_all(
    file: &std::path::Path,
    segments: &[PageSegment],
    expect_first: u64,
) -> Result<u64, SegmentError> {
    let mut next = expect_first;
    for segment in segments {
        if segment.first_txid != next {
            return Err(SegmentError::OutOfOrder {
                generation: segment.generation.hex(),
                first: segment.first_txid,
                last: segment.last_txid,
                expected: next,
            });
        }
        apply(file, segment)?;
        next = segment.last_txid + 1;
    }
    Ok(next.saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(page_number: u32, db_size: u32, fill: u8) -> WalFrame {
        WalFrame {
            page_number,
            commit_db_size: (db_size != 0).then_some(db_size),
            page: vec![fill; 16],
        }
    }

    fn generation() -> GenerationId {
        GenerationId::from_bytes([9_u8; 16])
    }

    /// **F3.** A generation id is 128 random bits and orders nothing.
    #[test]
    fn generation_ids_are_random_and_never_a_counter() {
        let ids: std::collections::BTreeSet<_> = (0..64)
            .map(|_| GenerationId::mint().expect("mints"))
            .collect();
        assert_eq!(ids.len(), 64, "64 mints, 64 distinct ids");
        let one = GenerationId::mint().expect("mints");
        assert_eq!(
            GenerationId::from_hex(&one.hex()).expect("round trips"),
            one
        );
        assert_eq!(one.hex().len(), 32);
        assert!(GenerationId::from_hex("not hex").is_err());
        assert!(GenerationId::from_hex("00").is_err());
    }

    #[test]
    fn a_page_written_twice_in_the_range_keeps_its_last_version() {
        let frames = [
            frame(7, 0, 0x11),
            frame(7, 0, 0x22),
            frame(8, 0, 0x33),
            frame(7, 9, 0x44),
        ];
        let segment =
            PageSegment::from_frames(generation(), 5, 16, Vec::new(), &frames).expect("builds");
        assert_eq!(segment.pages.len(), 2);
        assert_eq!(segment.pages[&7], vec![0x44; 16]);
        assert_eq!(segment.db_size_pages, 9);
        assert_eq!((segment.first_txid, segment.last_txid), (5, 5));
    }

    #[test]
    fn a_segment_that_does_not_end_on_a_commit_is_refused() {
        let frames = [frame(1, 1, 1), frame(2, 0, 2)];
        assert!(PageSegment::from_frames(generation(), 1, 16, Vec::new(), &frames).is_err());
        assert!(PageSegment::from_frames(generation(), 1, 16, Vec::new(), &[]).is_err());
    }

    #[test]
    fn a_segment_round_trips_through_its_wire_bytes() {
        let frames = [frame(1, 0, 1), frame(4, 2, 2), frame(2, 4, 3)];
        let census = vec![("core_entity".to_owned(), 17), ("note".to_owned(), 3)];
        let segment =
            PageSegment::from_frames(generation(), 11, 16, census, &frames).expect("builds");
        let bytes = segment.encode();
        assert_eq!(&bytes[..4], SEGMENT_MAGIC);
        assert_eq!(PageSegment::decode(&bytes).expect("decodes"), segment);
        assert_eq!(segment.commits(), 2);

        let mut truncated = bytes.clone();
        truncated.pop();
        assert!(PageSegment::decode(&truncated).is_err());
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(PageSegment::decode(&trailing).is_err());
        let mut wrong_version = bytes;
        wrong_version[4] = 9;
        assert!(matches!(
            PageSegment::decode(&wrong_version),
            Err(SegmentError::UnsupportedVersion(9))
        ));
    }

    /// **B3.** Applying a segment writes pages into the file, and the file is
    /// truncated to the size the commit left it at.
    #[test]
    fn applying_a_segment_writes_its_pages_and_sets_the_database_size() {
        let dir = tempfile::tempdir().expect("a directory");
        let file = dir.path().join("base");
        std::fs::write(&file, vec![0_u8; 16 * 6]).expect("writes");

        let frames = [frame(2, 0, 0xaa), frame(5, 3, 0xbb)];
        let segment =
            PageSegment::from_frames(generation(), 1, 16, Vec::new(), &frames).expect("builds");
        apply(&file, &segment).expect("applies");

        let after = std::fs::read(&file).expect("reads");
        assert_eq!(after.len(), 16 * 3, "truncated to three pages");
        assert_eq!(&after[16..32], &[0xaa; 16], "page 2 is at offset 16");
    }

    #[test]
    fn a_gap_in_the_txid_run_is_refused_rather_than_applied() {
        let dir = tempfile::tempdir().expect("a directory");
        let file = dir.path().join("base");
        std::fs::write(&file, vec![0_u8; 16 * 4]).expect("writes");
        let one = PageSegment::from_frames(generation(), 1, 16, Vec::new(), &[frame(1, 4, 1)])
            .expect("builds");
        let three = PageSegment::from_frames(generation(), 3, 16, Vec::new(), &[frame(1, 4, 3)])
            .expect("builds");
        assert_eq!(apply_all(&file, &[one.clone()], 1).expect("applies"), 1);
        let error = apply_all(&file, &[one, three], 1).expect_err("a gap is refused");
        assert!(matches!(error, SegmentError::OutOfOrder { .. }), "{error}");
    }
}
