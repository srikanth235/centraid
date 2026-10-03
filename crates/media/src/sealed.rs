//! `centraid-sealed/2` — the one format every object a gateway stores wears
//! ([#1080](https://github.com/srikanth235/centraid/issues/1080)).
//!
//! A file — a 4 MiB range of the vault, a snapshot manifest, an original, a
//! thumbnail — is identified by `h`, the BLAKE3 of its whole plaintext, and is
//! uploaded as **parts** of at most 64 MiB of plaintext each. A part is named
//! and keyed from the vault's backup key and `(h, part_index)` alone, so the
//! vault's own content hashes plus the 24 words are the whole index: nothing
//! about a part has to be written down anywhere for a phone to find it, open
//! it or know it is already held.
//!
//! ```text
//! preamble    (clear, 5)  "CSB2" ‖ u8 2
//! header box  (98)        nonce (24) ‖ XChaCha20-Poly1305(header, aad = preamble) ‖ tag (16)
//! chunk × n               nonce (24) ‖ u32be(ciphertext_len) ‖ ciphertext ‖ tag (16)
//!                         aad = header ‖ u32be(chunk_index) ‖ u8(is_last)
//!
//! header (58) = "CSB2" ‖ u8 2 ‖ flags u8 (bit 0: zstd) ‖ part_index u32be
//!             ‖ plaintext_hash h (32) ‖ file_len u64be ‖ part_len u64be
//! ```
//!
//! ## EVERY CONSTANT HERE IS A FORMAT DECISION
//!
//! The three `derive_key` contexts, the name preimage `h ‖ u32be(i)`, the
//! header's field order, the two AAD layouts, the 4 MiB chunk, the 64 MiB part,
//! the flag bit and zstd level 3 are the format (`crates/media/README.md`).
//! So is the framing: `ciphertext_len` counts the ciphertext without its tag,
//! every chunk but the last is full, and only an empty part ends in an empty
//! chunk (R-1080-B3), so one payload has one sealed shape. Changing any of it
//! makes every part already stored unopenable or unfindable.
//! `contracts/crypto/sealed-vectors.json` pins them (`tests/sealed_vectors.rs`).
//!
//! ## THE HEADER TRAVELS SEALED (R-1080-B1)
//!
//! The header carries `h`, and `h` in the clear is a confirmable commitment to
//! the content: a gateway holding a known file could hash it and find it among
//! its objects, which is exactly what ruling 3 of #1080 says a gateway cannot
//! do. So the 58 header bytes are the AAD of every chunk exactly as #1080 lays
//! them out, and they reach the gateway inside their own AEAD box under the
//! part's key. Only the 5-byte preamble is readable, which says what the file
//! is and nothing about what it holds.
//!
//! ## WHAT A GATEWAY CAN AND CANNOT LEARN
//!
//! It holds the part's name (a keyed hash), its sealed bytes and their digest.
//! The sealed length reveals the payload length within a chunk's framing —
//! there is no padding, by #1080's design — and nothing else.
//!
//! ## WHAT OPENING REFUSES
//!
//! A bad preamble, a header box that does not open under the name's key, a
//! header whose `(h, part_index)` do not derive the name it was fetched by, a
//! chunk that fails its tag, a missing final chunk, bytes after the final
//! chunk, a non-final chunk shorter than 4 MiB, a part whose payload opens to a
//! length other than `part_len`, and a `part_index` beyond the file's part
//! count. A one-part file is also checked against `h`; a many-part file is
//! checked by [`assemble`] or [`Assembler`].
//!
//! Sealing needs `h` before the first byte, because `h` is in the AAD of every
//! chunk and in the name: a caller hashes a file, then seals it.

use std::fmt;
use std::io::{self, Read, Write};
use std::str::FromStr;

use chacha20poly1305::aead::{AeadInOut, KeyInit};
use chacha20poly1305::{Key, Tag, XChaCha20Poly1305, XNonce};

/// The format's name, for messages and fixtures.
pub const FORMAT_NAME: &str = "centraid-sealed/2";

/// The four bytes every part starts with.
pub const MAGIC: [u8; 4] = *b"CSB2";

/// The format version, in the preamble and again inside the header.
pub const VERSION: u8 = 2;

/// The clear preamble: [`MAGIC`] ‖ [`VERSION`]. It is the header box's AAD.
pub const PREAMBLE: [u8; 5] = [MAGIC[0], MAGIC[1], MAGIC[2], MAGIC[3], VERSION];

/// The header, exactly as #1080 lays it out.
pub const HEADER_BYTES: usize = 58;

/// XChaCha20-Poly1305's nonce: 24 random bytes, so no counter is ever kept.
pub const NONCE_BYTES: usize = 24;

/// Poly1305's tag.
pub const TAG_BYTES: usize = 16;

/// The sealed header: nonce ‖ the header's ciphertext ‖ tag.
pub const HEADER_BOX_BYTES: usize = NONCE_BYTES + HEADER_BYTES + TAG_BYTES;

/// Payload bytes per chunk. Every chunk but the last carries exactly this many.
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// A chunk's framing before its ciphertext: the nonce and the length.
pub const CHUNK_FRAME_BYTES: usize = NONCE_BYTES + 4;

/// Plaintext bytes per part.
pub const PART_BYTES: u64 = 64 * 1024 * 1024;

/// The largest file this format can name: `u32::MAX` parts.
pub const MAX_FILE_BYTES: u64 = u32::MAX as u64 * PART_BYTES;

/// Header flag bit 0: the payload is zstd of the part's plaintext.
pub const FLAG_ZSTD: u8 = 0b0000_0001;

/// The zstd level a compressed payload is written at.
pub const ZSTD_LEVEL: i32 = 3;

const ROOT_CONTEXT: &str = "centraid backup v2 root";
const NAME_CONTEXT: &str = "centraid backup v2 name";
const OBJECT_CONTEXT_PREFIX: &str = "centraid backup v2 object ";

/// Everything sealing and naming needs, derived from a vault's root key.
#[derive(Clone)]
pub struct BackupKeys {
    k_backup: [u8; 32],
    k_name: [u8; 32],
}

impl BackupKeys {
    /// `K_backup = derive_key("centraid backup v2 root", root_key)` and
    /// `K_name = derive_key("centraid backup v2 name", K_backup)`.
    #[must_use]
    pub fn from_root(root_key: &[u8; 32]) -> Self {
        let k_backup = blake3::derive_key(ROOT_CONTEXT, root_key);
        let k_name = blake3::derive_key(NAME_CONTEXT, &k_backup);
        Self { k_backup, k_name }
    }

    /// `K_backup`, the key every object key derives from.
    #[must_use]
    pub const fn k_backup(&self) -> &[u8; 32] {
        &self.k_backup
    }

    /// `K_name`, the MAC key every name is computed under.
    #[must_use]
    pub const fn k_name(&self) -> &[u8; 32] {
        &self.k_name
    }
}

impl fmt::Debug for BackupKeys {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BackupKeys(<redacted>)")
    }
}

/// Parse 64 lowercase hex characters, and nothing else, into 32 bytes.
///
/// Lowercase only: a name is a path segment on the gateway and a key in its
/// index, so one value must have one spelling.
fn parse_hex32(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64
        || !text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    let mut out = [0_u8; 32];
    hex::decode_to_slice(text, &mut out).ok()?;
    Some(out)
}

macro_rules! hex32 {
    ($type:ident, $what:literal) => {
        impl $type {
            /// The raw bytes.
            #[must_use]
            pub const fn as_bytes(&self) -> &[u8; 32] {
                &self.0
            }

            /// Adopt raw bytes.
            #[must_use]
            pub const fn from_bytes(bytes: [u8; 32]) -> Self {
                Self(bytes)
            }

            /// 64 lowercase hex characters.
            #[must_use]
            pub fn to_hex(&self) -> String {
                hex::encode(self.0)
            }

            /// Parse 64 lowercase hex characters.
            ///
            /// # Errors
            /// [`SealedError::NotHex`] for anything else.
            pub fn from_hex(text: &str) -> Result<Self, SealedError> {
                parse_hex32(text)
                    .map(Self)
                    .ok_or(SealedError::NotHex { what: $what })
            }
        }

        impl fmt::Display for $type {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.to_hex())
            }
        }

        impl fmt::Debug for $type {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(formatter, "{}({})", stringify!($type), self.to_hex())
            }
        }

        impl FromStr for $type {
            type Err = SealedError;

            fn from_str(text: &str) -> Result<Self, Self::Err> {
                Self::from_hex(text)
            }
        }

        impl serde::Serialize for $type {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.to_hex())
            }
        }

        impl<'de> serde::Deserialize<'de> for $type {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = <String as serde::Deserialize>::deserialize(deserializer)?;
                Self::from_hex(&text).map_err(serde::de::Error::custom)
            }
        }
    };
}

/// An object's name: `hex(keyed_hash(K_name, h ‖ u32be(i)))`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Name([u8; 32]);
hex32!(Name, "an object name");

/// `h`: the BLAKE3 of a whole file's plaintext. Never leaves the phone in the
/// clear.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PlaintextHash([u8; 32]);
hex32!(PlaintextHash, "a plaintext hash");

impl PlaintextHash {
    /// The BLAKE3 of `bytes`.
    #[must_use]
    pub fn of(bytes: &[u8]) -> Self {
        Self(*blake3::hash(bytes).as_bytes())
    }
}

/// The transport digest: BLAKE3 of a part's sealed bytes, which the gateway
/// verifies on `PUT` and stores.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Digest([u8; 32]);
hex32!(Digest, "a digest");

impl Digest {
    /// The prefix of the `Content-Digest` header's value.
    pub const HEADER_PREFIX: &'static str = "blake3=";

    /// The BLAKE3 of `sealed`.
    #[must_use]
    pub fn of(sealed: &[u8]) -> Self {
        Self(*blake3::hash(sealed).as_bytes())
    }

    /// `blake3=<64 lowercase hex>`, the `Content-Digest` header's value.
    #[must_use]
    pub fn header_value(&self) -> String {
        format!("{}{}", Self::HEADER_PREFIX, self.to_hex())
    }

    /// Read a `Content-Digest` header's value back.
    ///
    /// # Errors
    /// [`SealedError::NotHex`] when the value is not `blake3=` and 64
    /// lowercase hex characters.
    pub fn from_header_value(value: &str) -> Result<Self, SealedError> {
        value
            .strip_prefix(Self::HEADER_PREFIX)
            .ok_or(SealedError::NotHex {
                what: "a blake3 content digest",
            })
            .and_then(Self::from_hex)
    }
}

/// How many parts a file of `len` bytes is uploaded as: at least one.
///
/// Saturates at `u32::MAX` past [`MAX_FILE_BYTES`], which [`part_len`]
/// refuses.
#[must_use]
pub fn part_count(len: u64) -> u32 {
    u32::try_from(len.div_ceil(PART_BYTES).max(1)).unwrap_or(u32::MAX)
}

/// The plaintext length of part `part_index` of a `file_len`-byte file.
///
/// # Errors
/// [`SealedError::PartIndexOutOfRange`] for an index the file does not have,
/// and [`SealedError::BadHeader`] for a file past [`MAX_FILE_BYTES`].
pub fn part_len(file_len: u64, part_index: u32) -> Result<u64, SealedError> {
    if file_len > MAX_FILE_BYTES {
        return Err(SealedError::BadHeader {
            reason: "the file is longer than u32::MAX parts",
        });
    }
    let count = part_count(file_len);
    if part_index >= count {
        return Err(SealedError::PartIndexOutOfRange {
            index: part_index,
            count,
            file_len,
        });
    }
    let start = u64::from(part_index) * PART_BYTES;
    Ok((file_len - start).min(PART_BYTES))
}

/// `name(h, i) = hex(keyed_hash(K_name, h ‖ u32be(i)))`.
#[must_use]
pub fn name(keys: &BackupKeys, h: &PlaintextHash, part_index: u32) -> Name {
    let mut preimage = [0_u8; 36];
    preimage[..32].copy_from_slice(&h.0);
    preimage[32..].copy_from_slice(&part_index.to_be_bytes());
    Name(*blake3::keyed_hash(&keys.k_name, &preimage).as_bytes())
}

/// Every name a `len`-byte file with hash `h` is stored under, in part order.
#[must_use]
pub fn names_of(keys: &BackupKeys, h: &PlaintextHash, len: u64) -> Vec<Name> {
    (0..part_count(len))
        .map(|index| name(keys, h, index))
        .collect()
}

/// `key(name) = derive_key("centraid backup v2 object " ‖ name, K_backup)`,
/// with the name spelled as its 64 lowercase hex characters.
#[must_use]
pub fn object_key(keys: &BackupKeys, name: &Name) -> [u8; 32] {
    blake3::derive_key(&format!("{OBJECT_CONTEXT_PREFIX}{name}"), &keys.k_backup)
}

/// The decoded header of one part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    /// Whether the payload is zstd of the part's plaintext.
    pub compressed: bool,
    pub part_index: u32,
    /// `h` of the whole file this part belongs to.
    pub plaintext_hash: PlaintextHash,
    pub file_len: u64,
    pub part_len: u64,
}

impl Header {
    /// A header for part `part_index` of a `file_len`-byte file.
    ///
    /// # Errors
    /// Whatever [`part_len`] refuses.
    pub fn for_part(
        h: PlaintextHash,
        file_len: u64,
        part_index: u32,
        compressed: bool,
    ) -> Result<Self, SealedError> {
        Ok(Self {
            compressed,
            part_index,
            plaintext_hash: h,
            file_len,
            part_len: part_len(file_len, part_index)?,
        })
    }

    /// The 58 bytes, in #1080's order.
    #[must_use]
    pub fn encode(&self) -> [u8; HEADER_BYTES] {
        let mut out = [0_u8; HEADER_BYTES];
        out[..5].copy_from_slice(&PREAMBLE);
        out[5] = if self.compressed { FLAG_ZSTD } else { 0 };
        out[6..10].copy_from_slice(&self.part_index.to_be_bytes());
        out[10..42].copy_from_slice(&self.plaintext_hash.0);
        out[42..50].copy_from_slice(&self.file_len.to_be_bytes());
        out[50..58].copy_from_slice(&self.part_len.to_be_bytes());
        out
    }

    /// Read the 58 bytes back, refusing a header this version did not write.
    ///
    /// # Errors
    /// A bad magic or version, an unknown flag, a `part_index` the file does
    /// not have, or a `part_len` that is not that part's length.
    pub fn decode(bytes: &[u8; HEADER_BYTES]) -> Result<Self, SealedError> {
        if bytes[..4] != MAGIC {
            return Err(SealedError::BadMagic);
        }
        if bytes[4] != VERSION {
            return Err(SealedError::BadVersion(bytes[4]));
        }
        let flags = bytes[5];
        if flags & !FLAG_ZSTD != 0 {
            return Err(SealedError::UnknownFlags(flags));
        }
        let part_index = u32::from_be_bytes([bytes[6], bytes[7], bytes[8], bytes[9]]);
        let mut h = [0_u8; 32];
        h.copy_from_slice(&bytes[10..42]);
        let file_len = u64::from_be_bytes(be8(&bytes[42..50]));
        let declared = u64::from_be_bytes(be8(&bytes[50..58]));
        let header = Self::for_part(
            PlaintextHash(h),
            file_len,
            part_index,
            flags & FLAG_ZSTD != 0,
        )?;
        if header.part_len != declared {
            return Err(SealedError::BadHeader {
                reason: "part_len is not the length this part of the file has",
            });
        }
        Ok(header)
    }
}

fn be8(slice: &[u8]) -> [u8; 8] {
    let mut out = [0_u8; 8];
    out.copy_from_slice(slice);
    out
}

/// What sealing and opening refuse.
#[derive(Debug, thiserror::Error)]
pub enum SealedError {
    #[error("not a centraid-sealed/2 part: the magic is wrong")]
    BadMagic,
    #[error("centraid-sealed/2 cannot read version {0}")]
    BadVersion(u8),
    #[error("the header does not open under this name's key")]
    HeaderOpen,
    #[error("the header sets flags this version does not define: {0:#04x}")]
    UnknownFlags(u8),
    #[error("the header is inconsistent: {reason}")]
    BadHeader { reason: &'static str },
    #[error("part {index} is past the {count} parts of a {file_len}-byte file")]
    PartIndexOutOfRange {
        index: u32,
        count: u32,
        file_len: u64,
    },
    #[error("the part is not the one its name was derived for")]
    NameMismatch,
    #[error("chunk {index} does not open")]
    ChunkOpen { index: u32 },
    #[error("chunk {index} is framed as {len} bytes, which that chunk cannot be")]
    BadChunkLength { index: u32, len: usize },
    #[error("the part ends without its final chunk")]
    MissingFinalChunk,
    #[error("bytes follow the final chunk")]
    TrailingBytes,
    #[error("the part is cut short inside {what}")]
    Truncated { what: &'static str },
    #[error("the header declares {declared} plaintext bytes and the part carried {actual}")]
    PartLenMismatch { declared: u64, actual: u64 },
    #[error("the plaintext is not the file its hash names")]
    HashMismatch,
    #[error("these parts do not assemble one file: {reason}")]
    Assembly { reason: &'static str },
    #[error("{what} is not 64 lowercase hex characters")]
    NotHex { what: &'static str },
    #[error("the operating system refused entropy: {0}")]
    Entropy(String),
    #[error("the cipher refused to seal")]
    Seal,
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// A sealing failure inside a writer zstd drives, carried as an `io::Error`
/// and unwrapped again by [`from_io`].
fn into_io(error: SealedError) -> io::Error {
    io::Error::other(error)
}

fn from_io(error: io::Error) -> SealedError {
    match error.downcast::<SealedError>() {
        Ok(sealed) => sealed,
        Err(error) => SealedError::Io(error),
    }
}

/// 24 bytes from the operating system: the one source of every nonce.
fn random_nonce() -> Result<[u8; NONCE_BYTES], SealedError> {
    use rand::TryRngCore as _;

    let mut bytes = [0_u8; NONCE_BYTES];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|error| SealedError::Entropy(error.to_string()))?;
    Ok(bytes)
}

fn cipher_for(keys: &BackupKeys, name: &Name) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(&Key::from(object_key(keys, name)))
}

/// A chunk's AAD: `header ‖ u32be(chunk_index) ‖ u8(is_last)`.
fn chunk_aad(header: &[u8; HEADER_BYTES], index: u32, last: bool) -> [u8; HEADER_BYTES + 5] {
    let mut aad = [0_u8; HEADER_BYTES + 5];
    aad[..HEADER_BYTES].copy_from_slice(header);
    aad[HEADER_BYTES..HEADER_BYTES + 4].copy_from_slice(&index.to_be_bytes());
    aad[HEADER_BYTES + 4] = u8::from(last);
    aad
}

// ─── sealing ────────────────────────────────────────────────────────────────

/// A writer that hashes and counts what passes through it.
struct Counted<W> {
    inner: W,
    hasher: blake3::Hasher,
    written: u64,
}

impl<W: Write> Write for Counted<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.hasher.update(&buf[..written]);
        self.written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Cuts the payload into chunks and seals each one. It holds one chunk back,
/// because whether a chunk is the last is only known when more bytes arrive or
/// the part ends.
struct Chunker<W> {
    out: Counted<W>,
    cipher: XChaCha20Poly1305,
    header: [u8; HEADER_BYTES],
    buffer: Vec<u8>,
    index: u32,
}

impl<W: Write> Chunker<W> {
    fn push(&mut self, mut data: &[u8]) -> Result<(), SealedError> {
        while !data.is_empty() {
            if self.buffer.len() == CHUNK_BYTES {
                self.seal_chunk(false)?;
            }
            let take = (CHUNK_BYTES - self.buffer.len()).min(data.len());
            self.buffer.extend_from_slice(&data[..take]);
            data = &data[take..];
        }
        Ok(())
    }

    fn seal_chunk(&mut self, last: bool) -> Result<(), SealedError> {
        let nonce = random_nonce()?;
        let length = u32::try_from(self.buffer.len()).map_err(|_| SealedError::Seal)?;
        let tag = self
            .cipher
            .encrypt_inout_detached(
                &XNonce::from(nonce),
                &chunk_aad(&self.header, self.index, last),
                self.buffer.as_mut_slice().into(),
            )
            .map_err(|_| SealedError::Seal)?;
        self.out.write_all(&nonce)?;
        self.out.write_all(&length.to_be_bytes())?;
        self.out.write_all(&self.buffer)?;
        self.out.write_all(tag.as_slice())?;
        self.buffer.clear();
        self.index = self.index.checked_add(1).ok_or(SealedError::Seal)?;
        Ok(())
    }

    fn finish(mut self) -> Result<Counted<W>, SealedError> {
        self.seal_chunk(true)?;
        Ok(self.out)
    }
}

impl<W: Write> Write for Chunker<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.push(buf).map_err(into_io)?;
        Ok(buf.len())
    }

    /// Deliberately holds the pending chunk back: flushing it would decide
    /// `is_last` before the part has ended.
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

enum Stage<W: Write> {
    Plain(Chunker<W>),
    Zstd(zstd::stream::write::Encoder<'static, Chunker<W>>),
}

/// What sealing one part produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SealedPart {
    pub name: Name,
    /// BLAKE3 of the sealed bytes: the `Content-Digest` a `PUT` carries.
    pub digest: Digest,
    /// The sealed length: the `Content-Length` a `PUT` carries.
    pub len: u64,
}

/// Seals one part as its plaintext streams in, holding at most one chunk of
/// payload in memory. The header goes out first, so `h` and the file's length
/// are known before the first byte.
pub struct Sealer<W: Write> {
    stage: Stage<W>,
    name: Name,
    part_len: u64,
    fed: u64,
}

impl<W: Write> Sealer<W> {
    /// Begin sealing part `part_index` of the `file_len`-byte file `h` into
    /// `out`.
    ///
    /// # Errors
    /// [`SealedError::PartIndexOutOfRange`] for a part the file does not have;
    /// otherwise entropy, the cipher or `out` refused.
    pub fn new(
        keys: &BackupKeys,
        h: &PlaintextHash,
        file_len: u64,
        part_index: u32,
        compress: bool,
        out: W,
    ) -> Result<Self, SealedError> {
        let header = Header::for_part(*h, file_len, part_index, compress)?;
        Self::under(keys, name(keys, h, part_index), &header, out)
    }

    /// Seal `header` under `name`'s key. Private so that a part is only ever
    /// sealed under the name its own `(h, part_index)` derive.
    fn under(keys: &BackupKeys, name: Name, header: &Header, out: W) -> Result<Self, SealedError> {
        let encoded = header.encode();
        let cipher = cipher_for(keys, &name);
        let mut out = Counted {
            inner: out,
            hasher: blake3::Hasher::new(),
            written: 0,
        };
        out.write_all(&PREAMBLE)?;
        let nonce = random_nonce()?;
        let mut boxed = encoded;
        let tag = cipher
            .encrypt_inout_detached(&XNonce::from(nonce), &PREAMBLE, boxed.as_mut_slice().into())
            .map_err(|_| SealedError::Seal)?;
        out.write_all(&nonce)?;
        out.write_all(&boxed)?;
        out.write_all(tag.as_slice())?;

        let capacity = usize::try_from(header.part_len)
            .unwrap_or(CHUNK_BYTES)
            .min(CHUNK_BYTES);
        let chunker = Chunker {
            out,
            cipher,
            header: encoded,
            buffer: Vec::with_capacity(capacity),
            index: 0,
        };
        let stage = if header.compressed {
            let mut encoder = zstd::stream::write::Encoder::new(chunker, ZSTD_LEVEL)?;
            encoder.set_pledged_src_size(Some(header.part_len))?;
            Stage::Zstd(encoder)
        } else {
            Stage::Plain(chunker)
        };
        Ok(Self {
            stage,
            name,
            part_len: header.part_len,
            fed: 0,
        })
    }

    /// Feed the next bytes of the part's plaintext.
    ///
    /// # Errors
    /// [`SealedError::PartLenMismatch`] when the part would grow past its
    /// declared length; otherwise the cipher, zstd or `out` refused.
    pub fn update(&mut self, data: &[u8]) -> Result<(), SealedError> {
        let after = self.fed.saturating_add(data.len() as u64);
        if after > self.part_len {
            return Err(SealedError::PartLenMismatch {
                declared: self.part_len,
                actual: after,
            });
        }
        match &mut self.stage {
            Stage::Plain(chunker) => chunker.push(data)?,
            Stage::Zstd(encoder) => encoder.write_all(data).map_err(from_io)?,
        }
        self.fed = after;
        Ok(())
    }

    /// Seal the final chunk and hand `out` back.
    ///
    /// # Errors
    /// [`SealedError::PartLenMismatch`] when fewer bytes arrived than the part
    /// holds; otherwise the cipher, zstd or `out` refused.
    pub fn finish(self) -> Result<(W, SealedPart), SealedError> {
        if self.fed != self.part_len {
            return Err(SealedError::PartLenMismatch {
                declared: self.part_len,
                actual: self.fed,
            });
        }
        let chunker = match self.stage {
            Stage::Plain(chunker) => chunker,
            Stage::Zstd(encoder) => encoder.finish().map_err(from_io)?,
        };
        let mut counted = chunker.finish()?;
        counted.flush()?;
        let digest = Digest(*counted.hasher.finalize().as_bytes());
        Ok((
            counted.inner,
            SealedPart {
                name: self.name,
                digest,
                len: counted.written,
            },
        ))
    }
}

impl<W: Write> Write for Sealer<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.update(buf).map_err(into_io)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Seal one part held in memory.
///
/// # Errors
/// Whatever [`Sealer`] refuses — including a `part_plaintext` whose length is
/// not the part's.
pub fn seal_part(
    keys: &BackupKeys,
    h: &PlaintextHash,
    file_len: u64,
    part_index: u32,
    part_plaintext: &[u8],
    compress: bool,
) -> Result<Vec<u8>, SealedError> {
    let mut sealer = Sealer::new(keys, h, file_len, part_index, compress, Vec::new())?;
    sealer.update(part_plaintext)?;
    Ok(sealer.finish()?.0)
}

/// Seal a whole file held in memory, one part per entry, in part order.
///
/// # Errors
/// Whatever [`seal_part`] refuses.
pub fn seal_file(
    keys: &BackupKeys,
    plaintext: &[u8],
    compress: bool,
) -> Result<Vec<(Name, Vec<u8>)>, SealedError> {
    let h = PlaintextHash::of(plaintext);
    let file_len = plaintext.len() as u64;
    let mut parts = Vec::new();
    for index in 0..part_count(file_len) {
        let start =
            usize::try_from(u64::from(index) * PART_BYTES).map_err(|_| SealedError::Seal)?;
        let end = start
            .saturating_add(usize::try_from(PART_BYTES).map_err(|_| SealedError::Seal)?)
            .min(plaintext.len());
        let sealed = seal_part(keys, &h, file_len, index, &plaintext[start..end], compress)?;
        parts.push((name(keys, &h, index), sealed));
    }
    Ok(parts)
}

// ─── opening ────────────────────────────────────────────────────────────────

/// Read exactly `buf.len()` bytes, naming what was cut short.
fn read_exact_or(
    reader: &mut impl Read,
    buf: &mut [u8],
    what: &'static str,
) -> Result<(), SealedError> {
    reader.read_exact(buf).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            SealedError::Truncated { what }
        } else {
            SealedError::Io(error)
        }
    })
}

/// What follows a chunk: nothing, another chunk's frame, or a fragment.
enum Next {
    End,
    Frame([u8; CHUNK_FRAME_BYTES]),
    Fragment,
}

fn read_next(reader: &mut impl Read) -> Result<Next, SealedError> {
    let mut frame = [0_u8; CHUNK_FRAME_BYTES];
    let mut filled = 0;
    while filled < CHUNK_FRAME_BYTES {
        match reader.read(&mut frame[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(SealedError::Io(error)),
        }
    }
    Ok(match filled {
        0 => Next::End,
        CHUNK_FRAME_BYTES => Next::Frame(frame),
        _ => Next::Fragment,
    })
}

/// Where opened payload goes: counted against `part_len`, hashed when the
/// part is a whole file, then handed to the caller's sink.
struct Bounded<W> {
    inner: W,
    limit: u64,
    count: u64,
    hasher: Option<blake3::Hasher>,
}

impl<W: Write> Write for Bounded<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let after = self.count.saturating_add(buf.len() as u64);
        if after > self.limit {
            return Err(into_io(SealedError::PartLenMismatch {
                declared: self.limit,
                actual: after,
            }));
        }
        self.inner.write_all(buf)?;
        if let Some(hasher) = &mut self.hasher {
            hasher.update(buf);
        }
        self.count = after;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

enum Payload<W: Write> {
    Plain(Bounded<W>),
    Zstd(zstd::stream::write::Decoder<'static, Bounded<W>>),
}

impl<W: Write> Payload<W> {
    fn take(&mut self, chunk: &[u8]) -> Result<(), SealedError> {
        match self {
            Self::Plain(bounded) => bounded.write_all(chunk).map_err(from_io),
            Self::Zstd(decoder) => decoder.write_all(chunk).map_err(from_io),
        }
    }

    fn finish(self, header: &Header) -> Result<(), SealedError> {
        let mut bounded = match self {
            Self::Plain(bounded) => bounded,
            Self::Zstd(mut decoder) => {
                decoder.flush().map_err(from_io)?;
                decoder.into_inner()
            }
        };
        bounded.flush()?;
        if bounded.count != header.part_len {
            return Err(SealedError::PartLenMismatch {
                declared: header.part_len,
                actual: bounded.count,
            });
        }
        if let Some(hasher) = bounded.hasher
            && *hasher.finalize().as_bytes() != header.plaintext_hash.0
        {
            return Err(SealedError::HashMismatch);
        }
        Ok(())
    }
}

/// Open one part fetched by `name`, streaming its plaintext into `sink` and
/// holding at most one chunk in memory.
///
/// **What reaches `sink` is unverified until this returns `Ok`**: a tag is
/// checked per chunk, but a missing final chunk, a short payload or (for a
/// one-part file) a wrong `h` is only known at the end. A caller writing to a
/// file writes to a temporary one and renames on success.
///
/// # Errors
/// Every refusal in this module's header.
pub fn open_part_to<R: Read, W: Write>(
    keys: &BackupKeys,
    name: &Name,
    mut reader: R,
    sink: &mut W,
) -> Result<Header, SealedError> {
    let mut preamble = [0_u8; PREAMBLE.len()];
    read_exact_or(&mut reader, &mut preamble, "the preamble")?;
    if preamble[..4] != MAGIC {
        return Err(SealedError::BadMagic);
    }
    if preamble[4] != VERSION {
        return Err(SealedError::BadVersion(preamble[4]));
    }

    let mut boxed = [0_u8; HEADER_BOX_BYTES];
    read_exact_or(&mut reader, &mut boxed, "the header")?;
    let cipher = cipher_for(keys, name);
    let mut header_bytes = [0_u8; HEADER_BYTES];
    header_bytes.copy_from_slice(&boxed[NONCE_BYTES..NONCE_BYTES + HEADER_BYTES]);
    let mut nonce = [0_u8; NONCE_BYTES];
    nonce.copy_from_slice(&boxed[..NONCE_BYTES]);
    let mut tag = [0_u8; TAG_BYTES];
    tag.copy_from_slice(&boxed[NONCE_BYTES + HEADER_BYTES..]);
    cipher
        .decrypt_inout_detached(
            &XNonce::from(nonce),
            &preamble,
            header_bytes.as_mut_slice().into(),
            &Tag::from(tag),
        )
        .map_err(|_| SealedError::HeaderOpen)?;
    let header = Header::decode(&header_bytes)?;
    if self::name(keys, &header.plaintext_hash, header.part_index) != *name {
        return Err(SealedError::NameMismatch);
    }

    let whole_file = part_count(header.file_len) == 1;
    let bounded = Bounded {
        inner: sink,
        limit: header.part_len,
        count: 0,
        hasher: whole_file.then(blake3::Hasher::new),
    };
    let mut payload = if header.compressed {
        Payload::Zstd(zstd::stream::write::Decoder::new(bounded)?)
    } else {
        Payload::Plain(bounded)
    };

    let mut buffer = Vec::new();
    let mut index = 0_u32;
    let mut frame = match read_next(&mut reader)? {
        Next::Frame(frame) => frame,
        Next::End => return Err(SealedError::MissingFinalChunk),
        Next::Fragment => {
            return Err(SealedError::Truncated {
                what: "the first chunk's frame",
            });
        }
    };
    loop {
        let mut nonce = [0_u8; NONCE_BYTES];
        nonce.copy_from_slice(&frame[..NONCE_BYTES]);
        let len = u32::from_be_bytes([
            frame[NONCE_BYTES],
            frame[NONCE_BYTES + 1],
            frame[NONCE_BYTES + 2],
            frame[NONCE_BYTES + 3],
        ]) as usize;
        if len > CHUNK_BYTES {
            return Err(SealedError::BadChunkLength { index, len });
        }
        buffer.resize(len, 0);
        read_exact_or(&mut reader, &mut buffer, "a chunk's ciphertext")?;
        let mut tag = [0_u8; TAG_BYTES];
        read_exact_or(&mut reader, &mut tag, "a chunk's tag")?;
        let next = read_next(&mut reader)?;
        let last = matches!(next, Next::End);

        let opened = |buffer: &mut Vec<u8>, last: bool| {
            cipher
                .decrypt_inout_detached(
                    &XNonce::from(nonce),
                    &chunk_aad(&header_bytes, index, last),
                    buffer.as_mut_slice().into(),
                    &Tag::from(tag),
                )
                .is_ok()
        };
        if !opened(&mut buffer, last) {
            // DIAGNOSIS ONLY. A failed tag leaves the buffer untouched, so
            // the opposite `is_last` can be tried to say WHY the part is
            // refused; nothing on this path accepts the chunk.
            return Err(if opened(&mut buffer, !last) {
                if last {
                    SealedError::MissingFinalChunk
                } else {
                    SealedError::TrailingBytes
                }
            } else {
                SealedError::ChunkOpen { index }
            });
        }
        // CANONICAL FRAMING: every chunk but the last is full, and only an
        // empty part ends in an empty chunk.
        if (!last && len != CHUNK_BYTES) || (last && len == 0 && index > 0) {
            return Err(SealedError::BadChunkLength { index, len });
        }
        payload.take(&buffer)?;
        match next {
            Next::End => break,
            Next::Frame(following) => frame = following,
            Next::Fragment => {
                return Err(SealedError::Truncated {
                    what: "a chunk's frame",
                });
            }
        }
        index = index
            .checked_add(1)
            .ok_or(SealedError::BadChunkLength { index, len })?;
    }
    payload.finish(&header)?;
    Ok(header)
}

/// One part, opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub header: Header,
    pub plaintext: Vec<u8>,
}

/// Open one part held in memory.
///
/// # Errors
/// Every refusal in this module's header.
pub fn open_part(keys: &BackupKeys, name: &Name, sealed: &[u8]) -> Result<Opened, SealedError> {
    let mut plaintext = Vec::new();
    let header = open_part_to(keys, name, sealed, &mut plaintext)?;
    Ok(Opened { header, plaintext })
}

/// Join opened parts, given in part order, into the file and check it is the
/// file `h` names.
///
/// # Errors
/// [`SealedError::Assembly`] for parts of different files, out of order or
/// not all of the file; [`SealedError::HashMismatch`] when the result is not
/// the file `h` names.
pub fn assemble(parts: Vec<Opened>) -> Result<Vec<u8>, SealedError> {
    let first = parts.first().ok_or(SealedError::Assembly {
        reason: "there are no parts",
    })?;
    let (h, file_len) = (first.header.plaintext_hash, first.header.file_len);
    if parts.len() as u64 != u64::from(part_count(file_len)) {
        return Err(SealedError::Assembly {
            reason: "the parts are not all of the file",
        });
    }
    let mut out = Vec::with_capacity(parts.iter().map(|part| part.plaintext.len()).sum());
    for (position, part) in parts.into_iter().enumerate() {
        if part.header.plaintext_hash != h || part.header.file_len != file_len {
            return Err(SealedError::Assembly {
                reason: "a part belongs to another file",
            });
        }
        if u64::from(part.header.part_index) != position as u64 {
            return Err(SealedError::Assembly {
                reason: "the parts are out of order",
            });
        }
        out.extend_from_slice(&part.plaintext);
    }
    if PlaintextHash::of(&out) != h {
        return Err(SealedError::HashMismatch);
    }
    Ok(out)
}

/// A many-part file, opened part by part into one sink and checked against `h`
/// at the end, holding at most one chunk in memory.
pub struct Assembler {
    h: PlaintextHash,
    file_len: u64,
    next: u32,
    hasher: blake3::Hasher,
}

/// Tees what is written into a hasher.
struct Tee<'a, W> {
    inner: &'a mut W,
    hasher: &'a mut blake3::Hasher,
}

impl<W: Write> Write for Tee<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.hasher.update(&buf[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl Assembler {
    /// Assemble the `file_len`-byte file `h`.
    #[must_use]
    pub fn new(h: PlaintextHash, file_len: u64) -> Self {
        Self {
            h,
            file_len,
            next: 0,
            hasher: blake3::Hasher::new(),
        }
    }

    /// The name of the part to fetch next, or `None` once every part is in.
    #[must_use]
    pub fn next_name(&self, keys: &BackupKeys) -> Option<Name> {
        (self.next < part_count(self.file_len)).then(|| name(keys, &self.h, self.next))
    }

    /// Open the next part from `reader` into `sink`.
    ///
    /// # Errors
    /// [`SealedError::Assembly`] when every part is already in or the part is
    /// another file's; otherwise whatever [`open_part_to`] refuses.
    pub fn part<R: Read, W: Write>(
        &mut self,
        keys: &BackupKeys,
        reader: R,
        sink: &mut W,
    ) -> Result<(), SealedError> {
        let expected = self.next_name(keys).ok_or(SealedError::Assembly {
            reason: "every part is already in",
        })?;
        let mut tee = Tee {
            inner: sink,
            hasher: &mut self.hasher,
        };
        let header = open_part_to(keys, &expected, reader, &mut tee)?;
        if header.file_len != self.file_len {
            return Err(SealedError::Assembly {
                reason: "a part belongs to another file",
            });
        }
        self.next += 1;
        Ok(())
    }

    /// Check every part is in and the whole is the file `h` names.
    ///
    /// # Errors
    /// [`SealedError::Assembly`] for a missing part, and
    /// [`SealedError::HashMismatch`] for a wrong whole.
    pub fn finish(self) -> Result<(), SealedError> {
        if self.next != part_count(self.file_len) {
            return Err(SealedError::Assembly {
                reason: "the parts are not all of the file",
            });
        }
        if *self.hasher.finalize().as_bytes() != self.h.0 {
            return Err(SealedError::HashMismatch);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: [u8; 32] = [0x11; 32];

    fn keys() -> BackupKeys {
        BackupKeys::from_root(&ROOT)
    }

    /// A deterministic, incompressible byte stream: BLAKE3's XOF over a seed.
    fn noise(len: usize, seed: u8) -> Vec<u8> {
        let mut out = vec![0_u8; len];
        blake3::Hasher::new()
            .update(&[seed])
            .finalize_xof()
            .fill(&mut out);
        out
    }

    fn seal_whole(plaintext: &[u8], compress: bool) -> (Name, Vec<u8>) {
        let mut parts = seal_file(&keys(), plaintext, compress).expect("seals");
        assert_eq!(parts.len(), 1, "a one-part file");
        parts.remove(0)
    }

    fn open_whole(name: &Name, sealed: &[u8]) -> Result<Vec<u8>, SealedError> {
        open_part(&keys(), name, sealed).map(|opened| opened.plaintext)
    }

    #[test]
    fn keys_names_and_object_keys_are_derived_and_distinct() {
        let keys = keys();
        assert_ne!(keys.k_backup(), keys.k_name(), "two keys, two contexts");
        let other = BackupKeys::from_root(&[0x12; 32]);
        assert_ne!(keys.k_backup(), other.k_backup());

        let h = PlaintextHash::of(b"a photograph");
        let first = name(&keys, &h, 0);
        assert_eq!(first, name(&keys, &h, 0), "a name is a function of (h, i)");
        assert_ne!(
            first,
            name(&keys, &h, 1),
            "the part index is in the preimage"
        );
        assert_ne!(first, name(&other, &h, 0), "the vault's key is in the name");
        assert_ne!(
            object_key(&keys, &first),
            object_key(&keys, &name(&keys, &h, 1))
        );

        let text = first.to_string();
        assert_eq!(text.len(), 64);
        assert!(
            text.bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        );
        assert_eq!(text.parse::<Name>().expect("parses"), first);
        assert!(text.to_uppercase().parse::<Name>().is_err(), "one spelling");
        assert!(text[..63].parse::<Name>().is_err());
        assert_eq!(format!("{keys:?}"), "BackupKeys(<redacted>)");
    }

    #[test]
    fn a_file_is_cut_into_64_mib_parts_and_never_into_none() {
        let mib = 1024 * 1024;
        for (len, parts) in [
            (0, 1),
            (1, 1),
            (64 * mib - 1, 1),
            (64 * mib, 1),
            (64 * mib + 1, 2),
            (128 * mib, 2),
            (128 * mib + 7, 3),
        ] {
            assert_eq!(part_count(len), parts, "{len} bytes");
        }
        assert_eq!(part_len(0, 0).expect("an empty file has one part"), 0);
        assert_eq!(part_len(64 * mib + 9, 1).expect("the tail"), 9);
        assert_eq!(part_len(64 * mib + 9, 0).expect("a full part"), 64 * mib);
        assert!(matches!(
            part_len(10, 1),
            Err(SealedError::PartIndexOutOfRange {
                index: 1,
                count: 1,
                file_len: 10
            })
        ));
        assert_eq!(
            names_of(&keys(), &PlaintextHash::of(b"x"), 128 * mib + 7).len(),
            3
        );
    }

    #[test]
    fn small_empty_and_compressed_parts_round_trip() {
        let compressible = b"core_content_item rows, page after page. ".repeat(4_000);
        for (plaintext, compress) in [
            (Vec::new(), false),
            (Vec::new(), true),
            (b"a short body".to_vec(), false),
            (compressible.clone(), true),
            (compressible, false),
        ] {
            let (name, sealed) = seal_whole(&plaintext, compress);
            let opened = open_part(&keys(), &name, &sealed).expect("opens");
            assert_eq!(opened.plaintext, plaintext);
            assert_eq!(opened.header.compressed, compress);
            assert_eq!(opened.header.part_len, plaintext.len() as u64);
            assert_eq!(opened.header.plaintext_hash, PlaintextHash::of(&plaintext));
        }
    }

    #[test]
    fn compression_is_the_callers_flag_and_shrinks_what_it_should() {
        let compressible = b"0123456789".repeat(100_000);
        let (_, plain) = seal_whole(&compressible, false);
        let (_, packed) = seal_whole(&compressible, true);
        assert!(
            plain.len() > compressible.len(),
            "uncompressed carries every byte"
        );
        assert!(
            packed.len() < compressible.len() / 10,
            "{} bytes",
            packed.len()
        );
    }

    /// Chunk boundaries: exactly one full chunk is ONE chunk, marked last; one
    /// byte more is two.
    #[test]
    fn chunk_boundaries_frame_canonically() {
        let overhead = (PREAMBLE.len() + HEADER_BOX_BYTES) as u64;
        let chunk = (CHUNK_FRAME_BYTES + TAG_BYTES) as u64;
        for (len, chunks) in [
            (0_usize, 1_u64),
            (1, 1),
            (CHUNK_BYTES, 1),
            (CHUNK_BYTES + 1, 2),
            (2 * CHUNK_BYTES + 5, 3),
        ] {
            let plaintext = noise(len, 1);
            let (name, sealed) = seal_whole(&plaintext, false);
            assert_eq!(
                sealed.len() as u64,
                overhead + chunks * chunk + len as u64,
                "{len} bytes seal to {chunks} chunk(s)"
            );
            assert_eq!(open_whole(&name, &sealed).expect("opens"), plaintext);
        }
    }

    /// A reader that hands back 4,093 bytes at a time, a prime, so reads end
    /// inside frames, nonces and tags: framing must not depend on how the
    /// transport happens to split the stream.
    struct Trickle<'a>(&'a [u8]);

    impl Read for Trickle<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let take = buf.len().min(4_093).min(self.0.len());
            buf[..take].copy_from_slice(&self.0[..take]);
            self.0 = &self.0[take..];
            Ok(take)
        }
    }

    #[test]
    fn streaming_in_odd_pieces_seals_what_one_shot_seals() {
        let keys = keys();
        for compress in [false, true] {
            let plaintext = noise(2 * CHUNK_BYTES + 12_345, 2);
            let h = PlaintextHash::of(&plaintext);
            let mut sealer =
                Sealer::new(&keys, &h, plaintext.len() as u64, 0, compress, Vec::new())
                    .expect("begins");
            for piece in plaintext.chunks(1_000_003) {
                sealer.write_all(piece).expect("streams");
            }
            let (sealed, part) = sealer.finish().expect("finishes");
            assert_eq!(part.name, name(&keys, &h, 0));
            assert_eq!(part.digest, Digest::of(&sealed));
            assert_eq!(part.len, sealed.len() as u64);

            let mut opened = Vec::new();
            let header =
                open_part_to(&keys, &part.name, Trickle(&sealed), &mut opened).expect("opens");
            assert_eq!(header.part_len, plaintext.len() as u64);
            assert_eq!(opened, plaintext);
        }
    }

    /// The same plaintext seals to the same NAME every time and to different
    /// BYTES every time: names dedupe, nonces never repeat.
    #[test]
    fn the_same_plaintext_seals_to_one_name_and_two_ciphertexts() {
        let (first_name, first) = seal_whole(b"the same photograph", false);
        let (second_name, second) = seal_whole(b"the same photograph", false);
        assert_eq!(first_name, second_name);
        assert_ne!(first, second, "random nonces");
        assert_ne!(Digest::of(&first), Digest::of(&second));
        assert_eq!(
            open_whole(&first_name, &second).expect("opens"),
            b"the same photograph"
        );
    }

    /// **R-1080-B1, red first.** A gateway holds the sealed bytes; neither the
    /// plaintext nor `h` may be readable in them. With the header written in
    /// the clear, the `h` scan finds it — the last assertion proves the scan
    /// is not vacuous.
    #[test]
    fn the_sealed_bytes_carry_neither_the_plaintext_nor_its_hash() {
        let plaintext = b"locker_key and access_device_secret, in the clear".repeat(64);
        let h = PlaintextHash::of(&plaintext);
        for compress in [false, true] {
            let (_, sealed) = seal_whole(&plaintext, compress);
            assert!(
                !sealed.windows(32).any(|window| window == h.as_bytes()),
                "h is printed on the outside of the part"
            );
            assert!(!sealed.windows(16).any(|window| window == &plaintext[..16]));
            assert_eq!(&sealed[..5], &PREAMBLE, "only the preamble is clear");
        }
        let mut clear = PREAMBLE.to_vec();
        clear.extend_from_slice(&Header::for_part(h, 1, 0, false).expect("a header").encode());
        assert!(
            clear.windows(32).any(|window| window == h.as_bytes()),
            "the scan finds h when the header is clear"
        );
    }

    fn flipped(sealed: &[u8], at: usize) -> Vec<u8> {
        let mut out = sealed.to_vec();
        out[at] ^= 0x01;
        out
    }

    /// One flipped bit anywhere refuses, and the refusal says where.
    #[test]
    fn a_flipped_byte_in_any_field_refuses() {
        let plaintext = noise(CHUNK_BYTES + 100, 3);
        let (name, sealed) = seal_whole(&plaintext, false);
        let header_box = PREAMBLE.len();
        let first_chunk = header_box + HEADER_BOX_BYTES;
        let second_chunk = first_chunk + CHUNK_FRAME_BYTES + CHUNK_BYTES + TAG_BYTES;
        let header_cases = [
            header_box,
            header_box + NONCE_BYTES + 20,
            header_box + NONCE_BYTES + HEADER_BYTES + 3,
        ];
        for at in header_cases {
            let outcome = open_whole(&name, &flipped(&sealed, at));
            assert!(
                matches!(outcome, Err(SealedError::HeaderOpen)),
                "{at}: {outcome:?}"
            );
        }
        let first_chunk_cases = [
            first_chunk + 5,
            first_chunk + CHUNK_FRAME_BYTES + 1_000,
            second_chunk - 2,
        ];
        for at in first_chunk_cases {
            let outcome = open_whole(&name, &flipped(&sealed, at));
            assert!(
                matches!(outcome, Err(SealedError::ChunkOpen { index: 0 })),
                "{at}: {outcome:?}"
            );
        }
        let outcome = open_whole(
            &name,
            &flipped(&sealed, second_chunk + CHUNK_FRAME_BYTES + 50),
        );
        assert!(
            matches!(outcome, Err(SealedError::ChunkOpen { index: 1 })),
            "{outcome:?}"
        );
        assert!(matches!(
            open_whole(&name, &flipped(&sealed, 0)),
            Err(SealedError::BadMagic)
        ));
        assert!(matches!(
            open_whole(&name, &flipped(&sealed, 4)),
            Err(SealedError::BadVersion(3))
        ));
        // The length field: a larger length runs the frame into the next
        // chunk, a smaller one leaves bytes over; either way it is refused.
        let length_at = first_chunk + NONCE_BYTES + 3;
        assert!(open_whole(&name, &flipped(&sealed, length_at)).is_err());
    }

    #[test]
    fn a_part_opened_under_another_names_key_does_not_open() {
        let (_, sealed) = seal_whole(b"one file", false);
        let (other, _) = seal_whole(b"another file", false);
        assert!(matches!(
            open_whole(&other, &sealed),
            Err(SealedError::HeaderOpen)
        ));
        let foreign = BackupKeys::from_root(&[0x99; 32]);
        let name = name(&keys(), &PlaintextHash::of(b"one file"), 0);
        assert!(matches!(
            open_part(&foreign, &name, &sealed),
            Err(SealedError::HeaderOpen)
        ));
    }

    /// **Red first for the name binding.** A part sealed under one name's key
    /// but carrying another file's header opens its header box and is then
    /// refused, because its `(h, i)` do not derive the name it was fetched by.
    #[test]
    fn a_header_that_does_not_derive_its_name_is_refused() {
        let keys = keys();
        let posing = name(
            &keys,
            &PlaintextHash::of(b"what the gateway was asked for"),
            0,
        );
        let header =
            Header::for_part(PlaintextHash::of(b"something else"), 14, 0, false).expect("a header");
        let mut sealer = Sealer::under(&keys, posing, &header, Vec::new()).expect("begins");
        sealer.update(b"something else").expect("feeds");
        let (sealed, _) = sealer.finish().expect("seals");
        assert!(matches!(
            open_part(&keys, &posing, &sealed),
            Err(SealedError::NameMismatch)
        ));
    }

    #[test]
    fn a_missing_final_chunk_and_a_trailing_byte_are_named() {
        let plaintext = noise(2 * CHUNK_BYTES + 10, 4);
        let (name, sealed) = seal_whole(&plaintext, false);
        let full_chunk = CHUNK_FRAME_BYTES + CHUNK_BYTES + TAG_BYTES;
        let two_chunks = PREAMBLE.len() + HEADER_BOX_BYTES + 2 * full_chunk;
        assert!(matches!(
            open_whole(&name, &sealed[..two_chunks]),
            Err(SealedError::MissingFinalChunk)
        ));
        assert!(matches!(
            open_whole(&name, &sealed[..PREAMBLE.len() + HEADER_BOX_BYTES]),
            Err(SealedError::MissingFinalChunk)
        ));
        let mut trailing = sealed.clone();
        trailing.push(0);
        assert!(matches!(
            open_whole(&name, &trailing),
            Err(SealedError::TrailingBytes)
        ));
        let mut doubled = sealed.clone();
        doubled.extend_from_slice(&sealed[two_chunks..]);
        assert!(matches!(
            open_whole(&name, &doubled),
            Err(SealedError::TrailingBytes)
        ));
        assert!(matches!(
            open_whole(&name, &sealed[..sealed.len() - 3]),
            Err(SealedError::Truncated { .. })
        ));
        assert!(matches!(
            open_whole(&name, &sealed[..3]),
            Err(SealedError::Truncated { .. })
        ));
    }

    #[test]
    fn a_sealer_fed_the_wrong_length_refuses() {
        let keys = keys();
        let h = PlaintextHash::of(b"ten bytes!");
        let mut short = Sealer::new(&keys, &h, 10, 0, false, Vec::new()).expect("begins");
        short.update(b"nine byte").expect("feeds");
        assert!(matches!(
            short.finish(),
            Err(SealedError::PartLenMismatch {
                declared: 10,
                actual: 9
            })
        ));
        let mut long = Sealer::new(&keys, &h, 10, 0, false, Vec::new()).expect("begins");
        assert!(matches!(
            long.update(b"eleven byte"),
            Err(SealedError::PartLenMismatch {
                declared: 10,
                actual: 11
            })
        ));
        assert!(matches!(
            Sealer::new(&keys, &h, 10, 1, false, Vec::new()),
            Err(SealedError::PartIndexOutOfRange { .. })
        ));
    }

    #[test]
    fn a_header_this_version_did_not_write_is_refused() {
        let header = Header::for_part(PlaintextHash::of(b"x"), 1, 0, true).expect("a header");
        let encoded = header.encode();
        assert_eq!(Header::decode(&encoded).expect("decodes"), header);
        let mut flags = encoded;
        flags[5] = 0b10;
        assert!(matches!(
            Header::decode(&flags),
            Err(SealedError::UnknownFlags(2))
        ));
        let mut index = encoded;
        index[9] = 1;
        assert!(matches!(
            Header::decode(&index),
            Err(SealedError::PartIndexOutOfRange { .. })
        ));
        let mut length = encoded;
        length[57] = 2;
        assert!(matches!(
            Header::decode(&length),
            Err(SealedError::BadHeader { .. })
        ));
    }

    /// Compressed on purpose: the part boundary is what is under test, and a
    /// compressible file keeps the AEAD's work small in an unoptimised build.
    #[test]
    fn a_many_part_file_assembles_in_order_and_only_in_order() {
        let keys = keys();
        let mut plaintext = b"a long video, frame after frame. ".repeat(2_100_000);
        plaintext.truncate(usize::try_from(PART_BYTES).expect("fits") + 7);
        plaintext[0] = b'A';
        let parts = seal_file(&keys, &plaintext, true).expect("seals");
        assert_eq!(parts.len(), 2);
        let opened: Vec<Opened> = parts
            .iter()
            .map(|(name, sealed)| open_part(&keys, name, sealed).expect("opens"))
            .collect();
        assert_eq!(opened[1].header.part_len, 7);
        // The order and completeness checks read headers only, so they are
        // asked with the real headers and no plaintext.
        let headers_only = |order: &[usize]| -> Vec<Opened> {
            order
                .iter()
                .map(|&index| Opened {
                    header: opened[index].header,
                    plaintext: Vec::new(),
                })
                .collect()
        };
        assert!(matches!(
            assemble(headers_only(&[1, 0])),
            Err(SealedError::Assembly { .. })
        ));
        assert!(matches!(
            assemble(headers_only(&[0])),
            Err(SealedError::Assembly { .. })
        ));
        assert!(matches!(
            assemble(headers_only(&[0, 1])),
            Err(SealedError::HashMismatch)
        ));
        assert_eq!(assemble(opened).expect("assembles"), plaintext);

        // Streamed into a sink that keeps nothing: `finish` checks the whole
        // against `h`, which is the claim.
        let mut assembler = Assembler::new(PlaintextHash::of(&plaintext), plaintext.len() as u64);
        for (name, sealed) in &parts {
            assert_eq!(assembler.next_name(&keys), Some(*name));
            assembler
                .part(&keys, sealed.as_slice(), &mut io::sink())
                .expect("opens");
        }
        assert_eq!(assembler.next_name(&keys), None);
        assembler.finish().expect("the whole is the file");

        let mut wrong = Assembler::new(PlaintextHash::of(b"another file"), plaintext.len() as u64);
        assert!(
            wrong.next_name(&keys) != Some(parts[0].0),
            "another file's names are not these"
        );
        assert!(matches!(
            wrong.part(&keys, parts[0].1.as_slice(), &mut io::sink()),
            Err(SealedError::HeaderOpen)
        ));
    }

    #[test]
    fn the_digest_is_spelled_as_the_content_digest_header() {
        let digest = Digest::of(b"sealed bytes");
        let value = digest.header_value();
        assert!(value.starts_with("blake3="));
        assert_eq!(value.len(), 7 + 64);
        assert_eq!(Digest::from_header_value(&value).expect("parses"), digest);
        assert!(Digest::from_header_value(&value[7..]).is_err());
        assert!(Digest::from_header_value(&format!("other={}", digest.to_hex())).is_err());
    }

    #[test]
    fn names_travel_in_json_as_their_hex() {
        let name = name(&keys(), &PlaintextHash::of(b"x"), 0);
        let json = serde_json::to_string(&name).expect("serialises");
        assert_eq!(json, format!("\"{name}\""));
        assert_eq!(serde_json::from_str::<Name>(&json).expect("parses"), name);
        assert!(serde_json::from_str::<Name>("\"ABC\"").is_err());
    }
}
