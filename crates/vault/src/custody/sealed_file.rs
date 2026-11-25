//! The Locker sealed file: `lkf1`, a file's bytes encrypted under the Locker key `K` BEFORE they
//! enter the blob store (#1214, I7).
//!
//! **THE FORMAT IS PERMANENT ONCE WRITTEN.** A byte of it changing would make every file a member
//! ever sealed unopenable, so `tests/vectors/lkf1.json` commits a sealed file, a file with its tail
//! cut off and a file with two chunks swapped, and `tests/locker_sealed_file.rs` holds this module
//! to them.
//!
//! ```text
//! file   = header chunk+
//! header = "lkf1" ‖ plaintext_chunk_size (u32, big-endian)              8 bytes
//! chunk  = nonce (12 random bytes) ‖ AES-256-GCM(plaintext chunk) ‖ tag (16)
//! AAD    = header ‖ field id ‖ 0x1F ‖ key id ‖ chunk index (u64, big-endian) ‖ final flag
//!          final flag: 0x01 on the last chunk, 0x00 before it
//! ```
//!
//! Every chunk but the last holds exactly `plaintext_chunk_size` bytes of plaintext; the last
//! holds 0 (an empty file, which is one chunk) up to that many, so a file whose length is a
//! multiple of the chunk size ends on a full chunk, never on an empty one. The nonce is fresh and
//! random for every chunk of every file: **the same file sealed twice has two different hashes**,
//! so the blob store never dedupes a sealed file against another, and a hash says nothing about
//! the bytes inside.
//!
//! The index and the final flag are in each chunk's authenticated data, which is what makes the
//! file whole as well as every chunk genuine: two chunks swapped, one dropped from the middle, and
//! a tail cut off (the new last chunk was sealed as "not final") each fail to open. The field id
//! and key id bind the file to the field that holds it and to the generation it was sealed under,
//! as an `lk1:` cell is bound to its row.
//!
//! **A file is never sealed or opened as one piece.** [`SealReader`] and [`OpenReader`] are
//! `Read` adapters that hold at most two chunks, so a store's `put_stream` writes a sealed file
//! straight from the plaintext source and an open streams plaintext out; no plaintext copy is
//! ever written to disk by this module, and a caller that wants none either passes the reader to
//! the store and the plaintext sink to the screen. An open that fails part-way has already handed
//! back the plaintext of the chunks before the bad one: the caller discards what it received.

use std::io::{self, Read, Write};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};

use super::locker_key::LOCKER_KEY_BYTES;

/// The first four bytes of every sealed file.
pub const MAGIC: [u8; 4] = *b"lkf1";

/// The header: the magic and the plaintext chunk size.
pub const HEADER_BYTES: usize = 8;

/// The plaintext chunk size a file is sealed with unless the caller says otherwise.
pub const DEFAULT_CHUNK_BYTES: u32 = 64 * 1024;

/// The largest plaintext chunk a header may name: a hostile header cannot ask a reader for a
/// gigabyte buffer.
pub const MAX_CHUNK_BYTES: u32 = 16 * 1024 * 1024;

const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
/// What a chunk adds to its plaintext.
pub const CHUNK_OVERHEAD: usize = NONCE_BYTES + TAG_BYTES;

/// Why a sealed file did not seal or open.
#[derive(Debug, thiserror::Error)]
pub enum SealedFileError {
    #[error("the Locker key is {0} bytes, expected {LOCKER_KEY_BYTES}")]
    KeyLength(usize),
    #[error("these bytes are not a sealed Locker file")]
    NotASealedFile,
    #[error("a sealed file's chunk size is 1 to {MAX_CHUNK_BYTES} bytes, not {0}")]
    ChunkSize(u32),
    /// A file with no chunk, or a chunk too short to hold a nonce and a tag.
    #[error("the sealed file is cut short")]
    Truncated,
    /// Tampering, a tail cut at a chunk boundary, chunks out of order, the wrong field, the wrong
    /// key generation or the wrong key: one answer for each, as an `lk1:` cell gives.
    #[error("the sealed file does not open under this key for this field")]
    DoesNotOpen,
    #[error("reading or writing the file: {0}")]
    Io(#[source] io::Error),
}

impl From<io::Error> for SealedFileError {
    fn from(error: io::Error) -> Self {
        // A reader's own error round-trips: `OpenReader` reports a `SealedFileError` as an
        // `io::Error`, and getting it back out must not wrap it twice.
        match error.downcast::<Self>() {
            Ok(inner) => inner,
            Err(error) => Self::Io(error),
        }
    }
}

fn into_io(error: SealedFileError) -> io::Error {
    match error {
        SealedFileError::Io(error) => error,
        other => io::Error::new(io::ErrorKind::InvalidData, other),
    }
}

fn cipher_for(key: &[u8]) -> Result<Aes256Gcm, SealedFileError> {
    if key.len() != LOCKER_KEY_BYTES {
        return Err(SealedFileError::KeyLength(key.len()));
    }
    Aes256Gcm::new_from_slice(key).map_err(|_| SealedFileError::KeyLength(key.len()))
}

/// The header for a chunk size.
///
/// # Errors
/// [`SealedFileError::ChunkSize`] for 0 or more than [`MAX_CHUNK_BYTES`].
pub fn header_for(chunk_bytes: u32) -> Result<[u8; HEADER_BYTES], SealedFileError> {
    if chunk_bytes == 0 || chunk_bytes > MAX_CHUNK_BYTES {
        return Err(SealedFileError::ChunkSize(chunk_bytes));
    }
    let mut header = [0_u8; HEADER_BYTES];
    header[..4].copy_from_slice(&MAGIC);
    header[4..].copy_from_slice(&chunk_bytes.to_be_bytes());
    Ok(header)
}

/// The plaintext chunk size a header names, or `None` when it is not a sealed-file header.
#[must_use]
pub fn chunk_size_of(header: &[u8]) -> Option<u32> {
    let header: &[u8; HEADER_BYTES] = header.get(..HEADER_BYTES)?.try_into().ok()?;
    if header[..4] != MAGIC {
        return None;
    }
    let size = u32::from_be_bytes(header[4..].try_into().ok()?);
    (1..=MAX_CHUNK_BYTES).contains(&size).then_some(size)
}

/// Whether a stored file of `total_bytes` whose first bytes are `head` is shaped like a sealed
/// file: a good header, then whole chunks and one last chunk that holds at least a nonce and a
/// tag. A cheap check made before the vault takes a file for a field; it proves nothing about
/// the key, which only the core holds.
#[must_use]
pub fn is_shaped_like_one(head: &[u8], total_bytes: u64) -> bool {
    let Some(chunk) = chunk_size_of(head) else {
        return false;
    };
    let Some(body) = total_bytes.checked_sub(HEADER_BYTES as u64) else {
        return false;
    };
    let whole = u64::from(chunk) + CHUNK_OVERHEAD as u64;
    let last = match body % whole {
        0 => whole,
        rest => rest,
    };
    body >= CHUNK_OVERHEAD as u64 && last >= CHUNK_OVERHEAD as u64
}

/// The bytes a file of `plain_bytes` seals to under `chunk_bytes`.
#[must_use]
pub fn sealed_len(plain_bytes: u64, chunk_bytes: u32) -> u64 {
    let chunk = u64::from(chunk_bytes.max(1));
    let chunks = plain_bytes.div_ceil(chunk).max(1);
    HEADER_BYTES as u64 + plain_bytes + chunks * CHUNK_OVERHEAD as u64
}

fn chunk_aad(
    header: &[u8; HEADER_BYTES],
    field_id: &str,
    key_id: &str,
    index: u64,
    last: bool,
) -> Vec<u8> {
    let mut aad = Vec::with_capacity(HEADER_BYTES + field_id.len() + key_id.len() + 10);
    aad.extend_from_slice(header);
    aad.extend_from_slice(field_id.as_bytes());
    aad.push(0x1F);
    aad.extend_from_slice(key_id.as_bytes());
    aad.extend_from_slice(&index.to_be_bytes());
    aad.push(u8::from(last));
    aad
}

/// Read until `buf` is full or the source ends; returns how many bytes it holds.
fn read_full(source: &mut impl Read, buf: &mut Vec<u8>, want: usize) -> io::Result<()> {
    buf.clear();
    buf.resize(want, 0);
    let mut filled = 0;
    while filled < want {
        match source.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    buf.truncate(filled);
    Ok(())
}

type NonceSource = Box<dyn FnMut() -> [u8; NONCE_BYTES] + Send>;

/// A `Read` over a file's SEALED bytes, made from a `Read` over its plaintext.
pub struct SealReader<R> {
    plain: R,
    cipher: Aes256Gcm,
    header: [u8; HEADER_BYTES],
    field_id: String,
    key_id: String,
    chunk: usize,
    nonces: NonceSource,
    index: u64,
    /// The next plaintext chunk, already read, so the chunk before it knows whether it is last.
    pending: Option<Vec<u8>>,
    out: Vec<u8>,
    out_at: usize,
    started: bool,
}

impl<R: Read> SealReader<R> {
    /// Seal `plain` for the field `field_id`, under generation `key_id`, in chunks of
    /// [`DEFAULT_CHUNK_BYTES`].
    ///
    /// # Errors
    /// [`SealedFileError::KeyLength`].
    pub fn new(
        plain: R,
        key: &[u8],
        key_id: &str,
        field_id: &str,
    ) -> Result<Self, SealedFileError> {
        Self::with_chunk(plain, key, key_id, field_id, DEFAULT_CHUNK_BYTES)
    }

    /// [`Self::new`] with a chunk size of the caller's.
    ///
    /// # Errors
    /// [`SealedFileError::KeyLength`] or [`SealedFileError::ChunkSize`].
    pub fn with_chunk(
        plain: R,
        key: &[u8],
        key_id: &str,
        field_id: &str,
        chunk_bytes: u32,
    ) -> Result<Self, SealedFileError> {
        Self::with_nonces(plain, key, key_id, field_id, chunk_bytes, || {
            super::random_bytes::<NONCE_BYTES>()
        })
    }

    /// [`Self::with_chunk`] with the nonces from `nonces`. **Only for committing a test vector:**
    /// a nonce that is ever repeated under one key breaks the cipher, so a product caller uses
    /// [`Self::new`] and its fresh random nonce per chunk.
    ///
    /// # Errors
    /// [`SealedFileError::KeyLength`] or [`SealedFileError::ChunkSize`].
    pub fn with_nonces(
        plain: R,
        key: &[u8],
        key_id: &str,
        field_id: &str,
        chunk_bytes: u32,
        nonces: impl FnMut() -> [u8; NONCE_BYTES] + Send + 'static,
    ) -> Result<Self, SealedFileError> {
        Ok(Self {
            plain,
            cipher: cipher_for(key)?,
            header: header_for(chunk_bytes)?,
            field_id: field_id.to_owned(),
            key_id: key_id.to_owned(),
            chunk: chunk_bytes as usize,
            nonces: Box::new(nonces),
            index: 0,
            pending: None,
            out: Vec::new(),
            out_at: 0,
            started: false,
        })
    }

    /// The next sealed chunk into `out`; `false` when the file is done.
    fn refill(&mut self) -> Result<bool, SealedFileError> {
        if !self.started {
            self.started = true;
            self.out.clear();
            self.out.extend_from_slice(&self.header);
            let mut first = Vec::new();
            read_full(&mut self.plain, &mut first, self.chunk)?;
            self.pending = Some(first);
            self.out_at = 0;
            return Ok(true);
        }
        let Some(current) = self.pending.take() else {
            return Ok(false);
        };
        let mut next = Vec::new();
        read_full(&mut self.plain, &mut next, self.chunk)?;
        let last = next.is_empty();
        let nonce = (self.nonces)();
        let aad = chunk_aad(&self.header, &self.field_id, &self.key_id, self.index, last);
        let sealed = self
            .cipher
            .encrypt(
                (&nonce).into(),
                Payload {
                    msg: &current,
                    aad: &aad,
                },
            )
            .map_err(|_| SealedFileError::DoesNotOpen)?;
        self.out.clear();
        self.out.extend_from_slice(&nonce);
        self.out.extend_from_slice(&sealed);
        self.out_at = 0;
        self.index += 1;
        if !last {
            self.pending = Some(next);
        }
        Ok(true)
    }
}

impl<R: Read> Read for SealReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        while self.out_at >= self.out.len() {
            if !self.refill().map_err(into_io)? {
                return Ok(0);
            }
        }
        let n = buf.len().min(self.out.len() - self.out_at);
        buf[..n].copy_from_slice(&self.out[self.out_at..self.out_at + n]);
        self.out_at += n;
        Ok(n)
    }
}

/// A `Read` over a file's PLAINTEXT, made from a `Read` over its sealed bytes.
pub struct OpenReader<R> {
    sealed: R,
    cipher: Aes256Gcm,
    header: Option<[u8; HEADER_BYTES]>,
    field_id: String,
    key_id: String,
    whole: usize,
    index: u64,
    pending: Option<Vec<u8>>,
    out: Vec<u8>,
    out_at: usize,
    started: bool,
    finished: bool,
}

impl<R: Read> OpenReader<R> {
    /// Open `sealed`, a file sealed for `field_id` under generation `key_id`.
    ///
    /// # Errors
    /// [`SealedFileError::KeyLength`].
    pub fn new(
        sealed: R,
        key: &[u8],
        key_id: &str,
        field_id: &str,
    ) -> Result<Self, SealedFileError> {
        Ok(Self {
            sealed,
            cipher: cipher_for(key)?,
            header: None,
            field_id: field_id.to_owned(),
            key_id: key_id.to_owned(),
            whole: 0,
            index: 0,
            pending: None,
            out: Vec::new(),
            out_at: 0,
            started: false,
            finished: false,
        })
    }

    fn refill(&mut self) -> Result<bool, SealedFileError> {
        if self.finished {
            return Ok(false);
        }
        if !self.started {
            self.started = true;
            let mut head = Vec::new();
            read_full(&mut self.sealed, &mut head, HEADER_BYTES)?;
            if head.len() < HEADER_BYTES {
                return Err(SealedFileError::NotASealedFile);
            }
            let chunk = chunk_size_of(&head).ok_or(SealedFileError::NotASealedFile)?;
            self.header = Some(head[..].try_into().map_err(|_| SealedFileError::Truncated)?);
            self.whole = chunk as usize + CHUNK_OVERHEAD;
            let mut first = Vec::new();
            read_full(&mut self.sealed, &mut first, self.whole)?;
            self.pending = Some(first);
        }
        let current = self.pending.take().ok_or(SealedFileError::Truncated)?;
        if current.len() < CHUNK_OVERHEAD {
            return Err(SealedFileError::Truncated);
        }
        // A chunk that did not fill is the last one the file holds; a full one is last only when
        // nothing follows it.
        let mut next = Vec::new();
        if current.len() == self.whole {
            read_full(&mut self.sealed, &mut next, self.whole)?;
        }
        let last = next.is_empty();
        let header = self.header.ok_or(SealedFileError::Truncated)?;
        let aad = chunk_aad(&header, &self.field_id, &self.key_id, self.index, last);
        let nonce: [u8; NONCE_BYTES] = current[..NONCE_BYTES]
            .try_into()
            .map_err(|_| SealedFileError::Truncated)?;
        let plain = self
            .cipher
            .decrypt(
                (&nonce).into(),
                Payload {
                    msg: &current[NONCE_BYTES..],
                    aad: &aad,
                },
            )
            .map_err(|_| SealedFileError::DoesNotOpen)?;
        self.out = plain;
        self.out_at = 0;
        self.index += 1;
        if last {
            self.finished = true;
        } else {
            self.pending = Some(next);
        }
        Ok(true)
    }
}

impl<R: Read> Read for OpenReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        while self.out_at >= self.out.len() {
            if !self.refill().map_err(into_io)? {
                return Ok(0);
            }
        }
        let n = buf.len().min(self.out.len() - self.out_at);
        buf[..n].copy_from_slice(&self.out[self.out_at..self.out_at + n]);
        self.out_at += n;
        Ok(n)
    }
}

/// Seal `plain` into `out`, streaming; returns the sealed length.
///
/// # Errors
/// [`SealedFileError`].
pub fn seal_stream(
    plain: impl Read,
    out: &mut impl Write,
    key: &[u8],
    key_id: &str,
    field_id: &str,
) -> Result<u64, SealedFileError> {
    let mut reader = SealReader::new(plain, key, key_id, field_id)?;
    Ok(io::copy(&mut reader, out)?)
}

/// Open `sealed` into `out`, streaming; returns the plaintext length. On an error `out` holds the
/// plaintext of the chunks before the bad one, and the caller throws it away.
///
/// # Errors
/// [`SealedFileError`].
pub fn open_stream(
    sealed: impl Read,
    out: &mut impl Write,
    key: &[u8],
    key_id: &str,
    field_id: &str,
) -> Result<u64, SealedFileError> {
    let mut reader = OpenReader::new(sealed, key, key_id, field_id)?;
    Ok(io::copy(&mut reader, out)?)
}

/// Seal a small file held in memory (a test, a few kilobytes of key). A real file goes through
/// [`SealReader`].
///
/// # Errors
/// [`SealedFileError`].
pub fn seal_bytes(
    plain: &[u8],
    key: &[u8],
    key_id: &str,
    field_id: &str,
) -> Result<Vec<u8>, SealedFileError> {
    let mut out = Vec::with_capacity(usize::try_from(sealed_len(
        plain.len() as u64,
        DEFAULT_CHUNK_BYTES,
    ))?);
    seal_stream(plain, &mut out, key, key_id, field_id)?;
    Ok(out)
}

/// Open a small sealed file held in memory.
///
/// # Errors
/// [`SealedFileError`].
pub fn open_bytes(
    sealed: &[u8],
    key: &[u8],
    key_id: &str,
    field_id: &str,
) -> Result<Vec<u8>, SealedFileError> {
    let mut out = Vec::new();
    open_stream(sealed, &mut out, key, key_id, field_id)?;
    Ok(out)
}

impl From<std::num::TryFromIntError> for SealedFileError {
    fn from(_: std::num::TryFromIntError) -> Self {
        Self::Io(io::Error::other("a file too large to hold in memory"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7; 32];

    fn sealed_with_chunk(plain: &[u8], chunk: u32) -> Vec<u8> {
        let mut out = Vec::new();
        let mut reader = SealReader::with_chunk(plain, &KEY, "k-1", "f-1", chunk).expect("seals");
        io::copy(&mut reader, &mut out).expect("copies");
        out
    }

    #[test]
    fn a_file_opens_to_what_was_sealed_at_every_length_around_a_chunk() {
        for len in [0_usize, 1, 15, 16, 17, 31, 32, 33, 160] {
            let plain: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let sealed = sealed_with_chunk(&plain, 16);
            assert_eq!(
                u64::try_from(sealed.len()).unwrap(),
                sealed_len(len as u64, 16),
                "{len}"
            );
            assert!(is_shaped_like_one(&sealed, sealed.len() as u64), "{len}");
            let mut opened = Vec::new();
            open_stream(&sealed[..], &mut opened, &KEY, "k-1", "f-1").expect("opens");
            assert_eq!(opened, plain, "{len}");
        }
    }

    #[test]
    fn a_wrong_field_key_id_or_key_does_not_open() {
        let sealed = sealed_with_chunk(b"the passport scan", 16);
        for (key, key_id, field) in [
            (&KEY, "k-2", "f-1"),
            (&KEY, "k-1", "f-2"),
            (&[8_u8; 32], "k-1", "f-1"),
        ] {
            assert!(matches!(
                open_bytes(&sealed, key, key_id, field),
                Err(SealedFileError::DoesNotOpen)
            ));
        }
    }

    #[test]
    fn the_same_file_sealed_twice_is_two_files() {
        let one = seal_bytes(b"the same bytes", &KEY, "k-1", "f-1").unwrap();
        let two = seal_bytes(b"the same bytes", &KEY, "k-1", "f-1").unwrap();
        assert_ne!(one, two);
    }

    #[test]
    fn a_file_with_a_tail_cut_off_two_chunks_swapped_or_garbage_after_it_does_not_open() {
        let plain: Vec<u8> = (0..70_u8).collect();
        let sealed = sealed_with_chunk(&plain, 16);
        let whole = 16 + CHUNK_OVERHEAD;
        // Five chunks: 16, 16, 16, 16, 6.
        assert_eq!(sealed.len(), HEADER_BYTES + 4 * whole + 6 + CHUNK_OVERHEAD);
        // The last chunk dropped: the new last was sealed as "not final".
        assert!(open_bytes(&sealed[..HEADER_BYTES + 4 * whole], &KEY, "k-1", "f-1").is_err());
        // Cut mid-chunk.
        assert!(open_bytes(&sealed[..sealed.len() - 3], &KEY, "k-1", "f-1").is_err());
        // Only the header.
        assert!(open_bytes(&sealed[..HEADER_BYTES], &KEY, "k-1", "f-1").is_err());
        // Two chunks swapped.
        let mut swapped = sealed.clone();
        let (a, b) = (HEADER_BYTES, HEADER_BYTES + whole);
        let first = swapped[a..a + whole].to_vec();
        let second = swapped[b..b + whole].to_vec();
        swapped[a..a + whole].copy_from_slice(&second);
        swapped[b..b + whole].copy_from_slice(&first);
        assert!(open_bytes(&swapped, &KEY, "k-1", "f-1").is_err());
        // A chunk sealed on the end of it.
        let mut longer = sealed.clone();
        longer.extend_from_slice(&sealed[HEADER_BYTES..HEADER_BYTES + whole]);
        assert!(open_bytes(&longer, &KEY, "k-1", "f-1").is_err());
    }

    #[test]
    fn what_is_not_a_sealed_file_is_refused_by_its_header_and_its_shape() {
        assert!(matches!(
            open_bytes(b"lkf2....", &KEY, "k", "f"),
            Err(SealedFileError::NotASealedFile)
        ));
        assert!(matches!(
            open_bytes(b"lkf1", &KEY, "k", "f"),
            Err(SealedFileError::NotASealedFile)
        ));
        assert!(chunk_size_of(b"lkf1\0\0\0\0").is_none());
        assert!(chunk_size_of(&[b'l', b'k', b'f', b'1', 0xFF, 0xFF, 0xFF, 0xFF]).is_none());
        assert!(!is_shaped_like_one(b"lkf1\0\0\0\x10", 8));
        assert!(!is_shaped_like_one(b"lkf1\0\0\0\x10", 8 + 27));
        assert!(is_shaped_like_one(b"lkf1\0\0\0\x10", 8 + 28));
    }
}
