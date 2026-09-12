//! The blob door: byte ranges over blobs that may still be arriving
//! (#1020, D-1020-F3).
//!
//! This is what `centraid://` answers. The range arithmetic and the
//! never-inline rules are ported from v0's `packages/server/src/routes/
//! blob-read-route.ts` and `blob-response.ts` — the gateway already had the
//! semantics; what is new here is the **partial** case.
//!
//! ## The layout of an arriving blob
//!
//! `FsBlobStore` (`crates/vault/src/backup/store.rs`) writes a blob to a
//! temporary name and renames it, so a reader sees the whole blob or no blob —
//! exactly right for a backup artefact and exactly wrong for a two-gigabyte
//! video the member wants to start watching. Beside that store, three names
//! describe one blob:
//!
//! | Name | Meaning |
//! |---|---|
//! | `<digest>` | complete. Its length IS the total, and the digest is the ETag. |
//! | `<digest>.partial` | the received **prefix**. Append-only while it grows. |
//! | `<digest>.total` | the declared total size, decimal ASCII. Written before the first byte. |
//! | `<digest>.type` | the declared media type, when no vault row carries one. |
//!
//! The prefix rule is the whole reason seeking works: a range inside the prefix
//! is answerable now, and a range past it is answerable **soon**, because the
//! only thing that ever happens to a `.partial` is that it gets longer.
//!
//! ## Why "never 416 for a known-total blob"
//!
//! A `416` means *that range does not exist*, and a media element that gets one
//! stops asking. For a blob whose total is declared and whose bytes are still
//! landing, "not yet" is the true answer and "never" is a lie that ends
//! playback permanently. So [`Served::NotYet`] exists as its own outcome and
//! the HTTP layer turns it into a retryable answer, never a `416`.

use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Media types a browser executes in the origin of whatever page embeds them.
///
/// Verbatim from v0 (`blob-read-route.ts:23`–`:27`, issue #865): blob bytes can
/// be attacker-authored — an imported attachment, a shared file — so a stored
/// `text/html` served inline is a stored XSS against the shell. In a desktop
/// seat the shell origin is the app itself, which makes it worse rather than
/// better, so the list is carried unchanged.
pub const INLINE_EXECUTABLE_MEDIA_TYPES: [&str; 3] =
    ["text/html", "application/xhtml+xml", "image/svg+xml"];

/// Browser media probes commonly send `bytes=0-`; bound each response window.
/// v0's `MAX_OPEN_RANGE_BYTES` (`blob-response.ts:5`).
pub const MAX_OPEN_RANGE_BYTES: u64 = 4 * 1024 * 1024;

/// The most raw bytes one socket frame may carry.
///
/// **This is a framing constraint, not a policy.** `crates/protocol`'s
/// `MAX_FRAME_BYTES` is 262,144 and the local channel base64-encodes bytes,
/// which costs a third; 128 KiB of blob becomes 174,764 characters and leaves
/// room for the JSON around it. A media element that asked for 4 MiB gets a
/// short `206` — which is legal, and is exactly how progressive playback works.
pub const MAX_CHUNK_BYTES: u64 = 128 * 1024;

/// The media type with its parameters stripped and lowercased.
#[must_use]
pub fn base_media_type(media_type: &str) -> String {
    media_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// Whether this media type may ever be served inline.
#[must_use]
pub fn may_serve_inline(media_type: &str) -> bool {
    let base = base_media_type(media_type);
    !INLINE_EXECUTABLE_MEDIA_TYPES.contains(&base.as_str())
}

/// One satisfiable range, inclusive at both ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

/// `bytes=<start>-<end?>` → one satisfiable range, else `None`.
///
/// A direct port of v0's `parseRange` (`blob-response.ts:8`–`:29`), including
/// the suffix form and the open-range clamp. Rewritten without a regex so the
/// binary carries no regex engine; the accepted grammar is asserted against the
/// same cases v0's own tests use.
#[must_use]
pub fn parse_range(header: &str, size: u64) -> Option<ByteRange> {
    let spec = header.strip_prefix("bytes=")?;
    // A multi-range request (`bytes=0-1,5-6`) is not a single satisfiable
    // range. v0's regex refuses it by construction; here it is refused
    // explicitly so the reason is readable.
    if spec.contains(',') {
        return None;
    }
    let (raw_start, raw_end) = spec.split_once('-')?;
    let digits = |text: &str| text.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(raw_start) || !digits(raw_end) {
        return None;
    }
    if raw_start.is_empty() && raw_end.is_empty() {
        return None;
    }
    let (start, end) = if raw_start.is_empty() {
        // Suffix form `bytes=-N`: the final N bytes.
        let suffix: u64 = raw_end.parse().ok()?;
        (size.saturating_sub(suffix), size.saturating_sub(1))
    } else {
        let start: u64 = raw_start.parse().ok()?;
        let end = if raw_end.is_empty() {
            size.saturating_sub(1)
                .min(start.saturating_add(MAX_OPEN_RANGE_BYTES - 1))
        } else {
            raw_end.parse().ok()?
        };
        (start, end)
    };
    if start > end || start >= size {
        return None;
    }
    Some(ByteRange {
        start,
        end: end.min(size.saturating_sub(1)),
    })
}

/// What a blob looks like right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobShape {
    /// The declared total, when it is known.
    pub total: Option<u64>,
    /// How many bytes of the prefix have arrived.
    pub received: u64,
    pub complete: bool,
    /// The declared media type, or `application/octet-stream`.
    pub media_type: String,
}

impl BlobShape {
    /// The size a `Range` header is parsed against.
    ///
    /// The **declared total** when there is one, even while the bytes are still
    /// arriving: parsing `bytes=0-` against the received prefix would answer a
    /// probe with a `Content-Range` whose total is smaller than the file, and a
    /// media element that read that total once never asks past it again.
    #[must_use]
    pub fn addressable(&self) -> u64 {
        self.total.unwrap_or(self.received)
    }

    #[must_use]
    pub fn inline(&self) -> bool {
        may_serve_inline(&self.media_type)
    }
}

/// The answer to one range read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Served {
    /// Bytes, `start..=end` inclusive. `end` is what was **served**, which for
    /// an arriving blob may be well short of what was asked for.
    Bytes {
        start: u64,
        end: u64,
        bytes: Vec<u8>,
    },
    /// The range is inside the declared total but those bytes have not landed
    /// yet. Retryable — never a `416` (see the module header).
    NotYet { received: u64, total: u64 },
    /// The range cannot be satisfied against a blob whose size is settled.
    /// This is the only `416`.
    Unsatisfiable { size: u64 },
}

/// Where one blob's four names live.
#[derive(Debug, Clone)]
pub struct BlobPaths {
    root: PathBuf,
}

impl BlobPaths {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// A digest is sixty-four lowercase hex characters, and this is the only
    /// place that is checked — every path below is built from a checked id, so
    /// `..` can never reach the join.
    fn checked(&self, digest: &str) -> Option<PathBuf> {
        if digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            Some(self.root.join(digest.to_ascii_lowercase()))
        } else {
            None
        }
    }

    fn sidecar(&self, digest: &str, extension: &str) -> Option<PathBuf> {
        let base = self.checked(digest)?;
        let name = base.file_name()?.to_str()?.to_owned();
        Some(base.with_file_name(format!("{name}.{extension}")))
    }

    /// Read what is known about one blob.
    ///
    /// `media_type_hint` comes from the vault when a representation row carries
    /// one; the `.type` sidecar answers for a blob that is arriving before any
    /// row describes it.
    pub fn shape(&self, digest: &str, media_type_hint: Option<&str>) -> io::Result<BlobShape> {
        let complete_path = self
            .checked(digest)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a blob digest"))?;
        let media_type = media_type_hint
            .map(str::to_owned)
            .or_else(|| {
                self.sidecar(digest, "type")
                    .and_then(|path| fs::read_to_string(path).ok())
                    .map(|text| text.trim().to_owned())
                    .filter(|text| !text.is_empty())
            })
            .unwrap_or_else(|| "application/octet-stream".to_owned());
        if let Ok(metadata) = fs::metadata(&complete_path) {
            return Ok(BlobShape {
                total: Some(metadata.len()),
                received: metadata.len(),
                complete: true,
                media_type,
            });
        }
        let partial = self
            .sidecar(digest, "partial")
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a blob digest"))?;
        let received = match fs::metadata(&partial) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("no blob {digest}"),
                ));
            }
            Err(error) => return Err(error),
        };
        let total = self
            .sidecar(digest, "total")
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|text| text.trim().parse::<u64>().ok());
        Ok(BlobShape {
            total,
            received,
            complete: false,
            media_type,
        })
    }

    /// Read `range` from a blob, waiting up to `wait` for bytes that have not
    /// arrived yet.
    ///
    /// The wait is a **poll of the file's length**, not a progress event: the
    /// writer is a separate process (`iroh-blobs` in the gateway, or the
    /// transfer this seat started), and a length that only ever grows is the
    /// one thing both ends already agree on without a channel between them. A
    /// bounded poll that reads the same number twice costs two `stat` calls.
    pub fn read_range(
        &self,
        digest: &str,
        range: ByteRange,
        media_type_hint: Option<&str>,
        wait: Duration,
    ) -> io::Result<Served> {
        let deadline = Instant::now() + wait;
        let mut shape = self.shape(digest, media_type_hint)?;
        loop {
            if let Some(served) = self.try_read(digest, range, &shape)? {
                return Ok(served);
            }
            if Instant::now() >= deadline {
                break;
            }
            // 25 ms: below a video frame at 30 fps, so a seek that lands just
            // ahead of the writer resolves inside one frame's budget, and
            // forty polls a second over one `stat` is not a cost worth tuning.
            std::thread::sleep(Duration::from_millis(25).min(
                deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1),
            ));
            shape = self.shape(digest, media_type_hint)?;
        }
        Ok(match shape.total {
            // A DECLARED TOTAL: "not yet", and the caller asks again.
            Some(total) if range.start < total => Served::NotYet {
                received: shape.received,
                total,
            },
            Some(total) => Served::Unsatisfiable { size: total },
            None => Served::Unsatisfiable {
                size: shape.received,
            },
        })
    }

    /// One attempt, no waiting. `None` means "nothing of that range has landed".
    fn try_read(
        &self,
        digest: &str,
        range: ByteRange,
        shape: &BlobShape,
    ) -> io::Result<Option<Served>> {
        if shape.received <= range.start {
            if shape.complete {
                return Ok(Some(Served::Unsatisfiable {
                    size: shape.received,
                }));
            }
            return Ok(None);
        }
        // CLAMP TO WHAT ARRIVED. Serving `start..=end` when only part of it is
        // there would read zeros off the end of the file, which for a video is
        // a corrupt frame rather than a short read.
        let end = range.end.min(shape.received - 1);
        let length = usize::try_from(end - range.start + 1)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "range too large"))?;
        let path = if shape.complete {
            self.checked(digest)
        } else {
            self.sidecar(digest, "partial")
        }
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a blob digest"))?;
        let mut file = fs::File::open(path)?;
        file.seek(SeekFrom::Start(range.start))?;
        let mut bytes = vec![0_u8; length];
        // `read_exact` and not `read`: the bytes are provably there — `end` was
        // clamped to a length this process just read — so a short read is a
        // real error and not a retry.
        file.read_exact(&mut bytes)?;
        Ok(Some(Served::Bytes {
            start: range.start,
            end,
            bytes,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn the_three_executable_types_are_never_inline_and_parameters_do_not_hide_them() {
        assert!(!may_serve_inline("text/html"));
        assert!(!may_serve_inline("TEXT/HTML; charset=utf-8"));
        assert!(!may_serve_inline("image/svg+xml"));
        assert!(!may_serve_inline(" application/xhtml+xml "));
        assert!(may_serve_inline("video/mp4"));
        assert!(may_serve_inline("image/png"));
        assert!(may_serve_inline("text/plain"));
        assert_eq!(base_media_type("Video/MP4; codecs=\"avc1\""), "video/mp4");
    }

    /// The cases v0's own range parser is pinned on, answer for answer.
    #[test]
    fn the_range_grammar_matches_v0() {
        let r = |start, end| Some(ByteRange { start, end });
        assert_eq!(parse_range("bytes=0-99", 1000), r(0, 99));
        assert_eq!(parse_range("bytes=100-", 1000), r(100, 999));
        // The open-range clamp: a probe that says `bytes=0-` gets a window.
        assert_eq!(
            parse_range("bytes=0-", 100 * 1024 * 1024),
            r(0, MAX_OPEN_RANGE_BYTES - 1)
        );
        // Suffix form.
        assert_eq!(parse_range("bytes=-10", 1000), r(990, 999));
        assert_eq!(parse_range("bytes=-5000", 1000), r(0, 999));
        // The end is clamped to the last byte.
        assert_eq!(parse_range("bytes=900-5000", 1000), r(900, 999));
        for bad in [
            "",
            "bytes=",
            "bytes=-",
            "bytes=abc-def",
            "bytes=10-5",
            "bytes=1000-1001", // start at or past the size
            "bytes=0-1,5-6",   // multi-range is not one satisfiable range
            "items=0-10",
            "0-10",
        ] {
            assert_eq!(parse_range(bad, 1000), None, "{bad:?} must not parse");
        }
    }

    fn arriving(dir: &std::path::Path, bytes: &[u8], total: u64) {
        fs::write(dir.join(format!("{DIGEST}.partial")), bytes).expect("a partial");
        fs::write(dir.join(format!("{DIGEST}.total")), total.to_string()).expect("a total");
    }

    #[test]
    fn a_complete_blob_reads_like_a_file() {
        let dir = tempfile::tempdir().expect("a temp dir");
        fs::write(dir.path().join(DIGEST), b"0123456789").expect("a blob");
        let paths = BlobPaths::new(dir.path());
        let shape = paths.shape(DIGEST, None).expect("a shape");
        assert_eq!(shape.total, Some(10));
        assert!(shape.complete);
        assert_eq!(shape.media_type, "application/octet-stream");
        assert_eq!(
            paths
                .read_range(DIGEST, ByteRange { start: 3, end: 5 }, None, Duration::ZERO)
                .expect("a read"),
            Served::Bytes {
                start: 3,
                end: 5,
                bytes: b"345".to_vec()
            }
        );
        // A settled size is the ONLY thing that produces an unsatisfiable range.
        assert_eq!(
            paths
                .read_range(
                    DIGEST,
                    ByteRange { start: 50, end: 60 },
                    None,
                    Duration::ZERO
                )
                .expect("a read"),
            Served::Unsatisfiable { size: 10 }
        );
    }

    /// THE EXIT CRITERION'S ARITHMETIC. A range inside the prefix is served; a
    /// range that straddles the prefix's end is served **short**; a range past
    /// it is `NotYet` and never unsatisfiable.
    #[test]
    fn an_arriving_blob_serves_its_prefix_and_says_not_yet_past_it() {
        let dir = tempfile::tempdir().expect("a temp dir");
        arriving(dir.path(), b"0123456789", 1_000);
        let paths = BlobPaths::new(dir.path());
        let shape = paths.shape(DIGEST, None).expect("a shape");
        assert_eq!(shape.total, Some(1_000));
        assert_eq!(shape.received, 10);
        assert!(!shape.complete);
        // The `Range` header is parsed against the DECLARED total, so a probe
        // learns the real length of the video and not the length so far.
        assert_eq!(shape.addressable(), 1_000);

        let read = |start, end| {
            paths
                .read_range(DIGEST, ByteRange { start, end }, None, Duration::ZERO)
                .expect("a read")
        };
        assert_eq!(
            read(0, 4),
            Served::Bytes {
                start: 0,
                end: 4,
                bytes: b"01234".to_vec()
            }
        );
        // SHORT, not zero-padded: `end` is what was served.
        assert_eq!(
            read(5, 999),
            Served::Bytes {
                start: 5,
                end: 9,
                bytes: b"56789".to_vec()
            }
        );
        assert_eq!(
            read(500, 999),
            Served::NotYet {
                received: 10,
                total: 1_000
            }
        );
        // Past the declared total IS unsatisfiable — the total is a promise.
        assert_eq!(read(1_000, 1_100), Served::Unsatisfiable { size: 1_000 });
    }

    /// The wait resolves a seek that landed just ahead of the writer.
    #[test]
    fn a_seek_past_the_prefix_waits_for_the_writer_rather_than_refusing() {
        let dir = tempfile::tempdir().expect("a temp dir");
        arriving(dir.path(), b"0123456789", 40);
        let paths = BlobPaths::new(dir.path());
        let partial = dir.path().join(format!("{DIGEST}.partial"));
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            let mut file = fs::OpenOptions::new()
                .append(true)
                .open(&partial)
                .expect("append");
            use std::io::Write;
            file.write_all(b"abcdefghijklmnopqrstuvwxyzcdef")
                .expect("write");
        });
        let served = paths
            .read_range(
                DIGEST,
                ByteRange { start: 20, end: 24 },
                None,
                Duration::from_secs(5),
            )
            .expect("a read");
        writer.join().expect("the writer finished");
        assert_eq!(
            served,
            Served::Bytes {
                start: 20,
                end: 24,
                bytes: b"klmno".to_vec()
            }
        );
    }

    #[test]
    fn a_declared_media_type_is_read_from_the_sidecar_and_the_vault_wins() {
        let dir = tempfile::tempdir().expect("a temp dir");
        arriving(dir.path(), b"0123456789", 10);
        fs::write(dir.path().join(format!("{DIGEST}.type")), "video/mp4\n").expect("a type");
        let paths = BlobPaths::new(dir.path());
        assert_eq!(
            paths.shape(DIGEST, None).expect("shape").media_type,
            "video/mp4"
        );
        assert!(paths.shape(DIGEST, None).expect("shape").inline());
        // A vault row is the authority when there is one.
        assert_eq!(
            paths
                .shape(DIGEST, Some("image/svg+xml"))
                .expect("shape")
                .media_type,
            "image/svg+xml"
        );
        assert!(
            !paths
                .shape(DIGEST, Some("image/svg+xml"))
                .expect("shape")
                .inline()
        );
    }

    #[test]
    fn anything_that_is_not_a_digest_never_reaches_a_path_join() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let paths = BlobPaths::new(dir.path());
        for bad in [
            "../../etc/passwd",
            "",
            "0123",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
        ] {
            let error = paths.shape(bad, None).expect_err("refused");
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{bad:?}");
        }
    }

    #[test]
    fn a_blob_nobody_has_is_not_found_rather_than_empty() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let paths = BlobPaths::new(dir.path());
        assert_eq!(
            paths.shape(DIGEST, None).expect_err("missing").kind(),
            io::ErrorKind::NotFound
        );
    }

    /// A blob arriving with no declared total: the prefix is all there is to
    /// address, and a range past it cannot be promised.
    #[test]
    fn an_undeclared_total_addresses_only_the_prefix() {
        let dir = tempfile::tempdir().expect("a temp dir");
        fs::write(dir.path().join(format!("{DIGEST}.partial")), b"0123").expect("a partial");
        let paths = BlobPaths::new(dir.path());
        let shape = paths.shape(DIGEST, None).expect("a shape");
        assert_eq!(shape.total, None);
        assert_eq!(shape.addressable(), 4);
        assert_eq!(
            paths
                .read_range(
                    DIGEST,
                    ByteRange { start: 10, end: 20 },
                    None,
                    Duration::ZERO
                )
                .expect("a read"),
            Served::Unsatisfiable { size: 4 }
        );
    }
}
