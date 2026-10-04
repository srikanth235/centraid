//! `centraid-sealed/2` — the one format every object a gateway stores wears
//! ([#1080](https://github.com/srikanth235/centraid/issues/1080)).
//!
//! A file — a 4 MiB range of the vault, a snapshot manifest, an original, a
//! thumbnail — is identified by `h`, the BLAKE3 of its whole plaintext, and is
//! uploaded as **parts** of at most 64 MiB of plaintext each. Part `i` is
//! stored under `name(h, i)`, a keyed hash only the vault's key reaches, so the
//! vault's own content hashes plus the 24 words are the whole index: nothing
//! about a part is written down anywhere for a phone to find it or know it is
//! already held.
//!
//! ```text
//! header (30, clear)  "CSB2" ‖ u8 2 ‖ flags u8 (bit 0: zstd) ‖ part_index u32be
//!                     ‖ part_len u32be ‖ salt (16, random)
//! chunk × n           nonce (24, random) ‖ u32be(ciphertext_len) ‖ ciphertext ‖ tag (16)
//!                     aad = header ‖ u32be(chunk_index) ‖ u8(is_last)
//! key                 derive_key("centraid backup v2 object", K_backup ‖ salt)
//! name(h, i)          hex(keyed_hash(K_name, h ‖ u32be(i)))
//! ```
//!
//! ## ONE PASS, SO THE PART CARRIES NOTHING ABOUT ITS FILE (#1080 A8)
//!
//! A phone must not read its camera roll twice, so a file is hashed and sealed
//! in the same stream ([`FileSealer`]). That decides the format: the key comes
//! from a random salt rather than from the name, because the name needs `h` and
//! `h` is known only when the stream ends; and the header holds no `h` and no
//! file length, because it is written before either is known. A gateway
//! therefore sees a salt, a part index, a part length and ciphertext — nothing
//! it could match against a file it already has. The file's identity is checked
//! where it is known: [`assemble`] and [`Assembler`] against the `h` the caller
//! fetched the names by, [`open_whole`] against the name itself.
//!
//! `part_len` is in every chunk's AAD and is written first, so a part whose
//! length the sealer did not know is re-sealed from its own temp file once its
//! length is known: a local rewrite of one part, never a second read of the
//! source.
//!
//! **One read holds every part until the last byte**, because no part has a
//! name before `h` does. A file larger than the room a phone gives its spool
//! is therefore hashed on its first read and sealed on later ones, a window of
//! parts at a time, under the names that first read made known
//! ([`WindowSealer`], R-1080-C39): one more read per window, instead of a file
//! that never backs up.
//!
//! ## EVERY CONSTANT HERE IS A FORMAT DECISION
//!
//! The three `derive_key` contexts and their key material, the name preimage
//! `h ‖ u32be(i)`, the header's fields and order, the chunk AAD, the 4 MiB
//! chunk, the 64 MiB part, the flag bit and zstd level 3 are the format
//! (`crates/media/README.md`). So is the framing: `ciphertext_len` counts the
//! ciphertext without its tag, every chunk but the last is full, and only an
//! empty part ends in an empty chunk (R-1080-B3). Changing any of it makes every
//! part already stored unopenable or unfindable.
//! `contracts/crypto/sealed-vectors.json` pins them (`tests/sealed_vectors.rs`).
//!
//! ## WHAT OPENING REFUSES
//!
//! A bad magic or version, an unknown flag, a `part_len` past 64 MiB, a chunk
//! that fails its tag (which an edited header field or salt also produces), a
//! missing final chunk, bytes after the final chunk, a non-final chunk shorter
//! than 4 MiB, and a payload that opens to a length other than `part_len`.

use std::collections::{BTreeSet, VecDeque};
use std::fmt;
use std::fs::File;
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use chacha20poly1305::aead::{AeadInOut, KeyInit};
use chacha20poly1305::{Key, Tag, XChaCha20Poly1305, XNonce};

/// The format's name, for messages and fixtures.
pub const FORMAT_NAME: &str = "centraid-sealed/2";

/// The four bytes every part starts with.
pub const MAGIC: [u8; 4] = *b"CSB2";

/// The format version.
pub const VERSION: u8 = 2;

/// The random salt a part's key derives from.
pub const SALT_BYTES: usize = 16;

/// The clear header: magic, version, flags, part index, part length, salt.
pub const HEADER_BYTES: usize = 4 + 1 + 1 + 4 + 4 + SALT_BYTES;

/// XChaCha20-Poly1305's nonce: 24 random bytes, so no counter is ever kept.
pub const NONCE_BYTES: usize = 24;

/// Poly1305's tag.
pub const TAG_BYTES: usize = 16;

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
const OBJECT_CONTEXT: &str = "centraid backup v2 object";

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

    /// `K_backup`, which every part's key derives from.
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

/// `h`: the BLAKE3 of a whole file's plaintext. Never leaves the phone.
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

/// A part's key: `derive_key("centraid backup v2 object", K_backup ‖ salt)`.
#[must_use]
pub fn part_key(keys: &BackupKeys, salt: &[u8; SALT_BYTES]) -> [u8; 32] {
    let mut material = [0_u8; 32 + SALT_BYTES];
    material[..32].copy_from_slice(&keys.k_backup);
    material[32..].copy_from_slice(salt);
    blake3::derive_key(OBJECT_CONTEXT, &material)
}

/// The decoded header of one part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    /// Whether the payload is zstd of the part's plaintext.
    pub compressed: bool,
    pub part_index: u32,
    /// The part's plaintext length, at most [`PART_BYTES`].
    pub part_len: u32,
    /// The random salt the part's key derives from.
    pub salt: [u8; SALT_BYTES],
}

impl Header {
    /// The 30 bytes, in #1080 A8's order.
    #[must_use]
    pub fn encode(&self) -> [u8; HEADER_BYTES] {
        let mut out = [0_u8; HEADER_BYTES];
        out[..4].copy_from_slice(&MAGIC);
        out[4] = VERSION;
        out[5] = if self.compressed { FLAG_ZSTD } else { 0 };
        out[6..10].copy_from_slice(&self.part_index.to_be_bytes());
        out[10..14].copy_from_slice(&self.part_len.to_be_bytes());
        out[14..].copy_from_slice(&self.salt);
        out
    }

    /// Read the 30 bytes back, refusing a header this version did not write.
    ///
    /// # Errors
    /// A bad magic or version, an unknown flag, or a `part_len` past 64 MiB.
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
        let part_len = u32::from_be_bytes([bytes[10], bytes[11], bytes[12], bytes[13]]);
        if u64::from(part_len) > PART_BYTES {
            return Err(SealedError::BadHeader {
                reason: "part_len is past 64 MiB",
            });
        }
        let mut salt = [0_u8; SALT_BYTES];
        salt.copy_from_slice(&bytes[14..]);
        Ok(Self {
            compressed: flags & FLAG_ZSTD != 0,
            part_index: u32::from_be_bytes([bytes[6], bytes[7], bytes[8], bytes[9]]),
            part_len,
            salt,
        })
    }
}

/// What sealing and opening refuse.
#[derive(Debug, thiserror::Error)]
pub enum SealedError {
    #[error("not a centraid-sealed/2 part: the magic is wrong")]
    BadMagic,
    #[error("centraid-sealed/2 cannot read version {0}")]
    BadVersion(u8),
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

/// `N` bytes from the operating system: the one source of every nonce and
/// every salt.
fn random<const N: usize>() -> Result<[u8; N], SealedError> {
    use rand::TryRngCore as _;

    let mut bytes = [0_u8; N];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|error| SealedError::Entropy(error.to_string()))?;
    Ok(bytes)
}

fn cipher_for(keys: &BackupKeys, salt: &[u8; SALT_BYTES]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(&Key::from(part_key(keys, salt)))
}

/// A chunk's AAD: `header ‖ u32be(chunk_index) ‖ u8(is_last)`.
fn chunk_aad(header: &[u8; HEADER_BYTES], index: u32, last: bool) -> [u8; HEADER_BYTES + 5] {
    let mut aad = [0_u8; HEADER_BYTES + 5];
    aad[..HEADER_BYTES].copy_from_slice(header);
    aad[HEADER_BYTES..HEADER_BYTES + 4].copy_from_slice(&index.to_be_bytes());
    aad[HEADER_BYTES + 4] = u8::from(last);
    aad
}

// ─── sealing one part ───────────────────────────────────────────────────────

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
        let nonce = random::<NONCE_BYTES>()?;
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
pub struct PartSeal {
    pub header: Header,
    /// BLAKE3 of the sealed bytes: the `Content-Digest` a `PUT` carries.
    pub digest: Digest,
    /// The sealed length: the `Content-Length` a `PUT` carries.
    pub len: u64,
}

/// Seals one part as its plaintext streams in, holding at most one chunk of
/// payload in memory. The header, `part_len` included, goes out first.
pub struct PartSealer<W: Write> {
    stage: Stage<W>,
    header: Header,
    fed: u64,
}

impl<W: Write> PartSealer<W> {
    /// Begin sealing part `part_index`, of exactly `part_len` plaintext bytes,
    /// into `out`, under a fresh salt.
    ///
    /// # Errors
    /// [`SealedError::BadHeader`] for a part past 64 MiB; otherwise entropy,
    /// zstd or `out` refused.
    pub fn new(
        keys: &BackupKeys,
        part_index: u32,
        part_len: u64,
        compress: bool,
        out: W,
    ) -> Result<Self, SealedError> {
        let part_len = u32::try_from(part_len)
            .ok()
            .filter(|len| u64::from(*len) <= PART_BYTES)
            .ok_or(SealedError::BadHeader {
                reason: "part_len is past 64 MiB",
            })?;
        let header = Header {
            compressed: compress,
            part_index,
            part_len,
            salt: random::<SALT_BYTES>()?,
        };
        Self::under(keys, header, out)
    }

    fn under(keys: &BackupKeys, header: Header, out: W) -> Result<Self, SealedError> {
        let encoded = header.encode();
        let mut out = Counted {
            inner: out,
            hasher: blake3::Hasher::new(),
            written: 0,
        };
        out.write_all(&encoded)?;
        let capacity = usize::try_from(header.part_len)
            .unwrap_or(CHUNK_BYTES)
            .min(CHUNK_BYTES);
        let chunker = Chunker {
            out,
            cipher: cipher_for(keys, &header.salt),
            header: encoded,
            buffer: Vec::with_capacity(capacity),
            index: 0,
        };
        // NO PLEDGED SIZE: a frame without a content size is still "zstd of
        // the part's plaintext", and a part `FileSealer` re-seals has, by
        // definition, a length its first frame did not know.
        let stage = if header.compressed {
            Stage::Zstd(zstd::stream::write::Encoder::new(chunker, ZSTD_LEVEL)?)
        } else {
            Stage::Plain(chunker)
        };
        Ok(Self {
            stage,
            header,
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
        if after > u64::from(self.header.part_len) {
            return Err(SealedError::PartLenMismatch {
                declared: u64::from(self.header.part_len),
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
    pub fn finish(self) -> Result<(W, PartSeal), SealedError> {
        if self.fed != u64::from(self.header.part_len) {
            return Err(SealedError::PartLenMismatch {
                declared: u64::from(self.header.part_len),
                actual: self.fed,
            });
        }
        let chunker = match self.stage {
            Stage::Plain(chunker) => chunker,
            Stage::Zstd(encoder) => encoder.finish().map_err(from_io)?,
        };
        let mut counted = chunker.finish()?;
        counted.flush()?;
        Ok((
            counted.inner,
            PartSeal {
                header: self.header,
                digest: Digest(*counted.hasher.finalize().as_bytes()),
                len: counted.written,
            },
        ))
    }
}

impl<W: Write> Write for PartSealer<W> {
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
/// Whatever [`PartSealer`] refuses.
pub fn seal_part(
    keys: &BackupKeys,
    part_index: u32,
    part_plaintext: &[u8],
    compress: bool,
) -> Result<Vec<u8>, SealedError> {
    let mut sealer = PartSealer::new(
        keys,
        part_index,
        part_plaintext.len() as u64,
        compress,
        Vec::new(),
    )?;
    sealer.update(part_plaintext)?;
    Ok(sealer.finish()?.0)
}

/// A file held in memory, sealed: `h` and each part's name and bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedFile {
    pub h: PlaintextHash,
    pub parts: Vec<(Name, Vec<u8>)>,
}

/// Seal a whole file held in memory, one part per entry, in part order.
///
/// # Errors
/// Whatever [`seal_part`] refuses.
pub fn seal_file(
    keys: &BackupKeys,
    plaintext: &[u8],
    compress: bool,
) -> Result<SealedFile, SealedError> {
    let h = PlaintextHash::of(plaintext);
    let file_len = plaintext.len() as u64;
    let mut parts = Vec::new();
    for index in 0..part_count(file_len) {
        let start =
            usize::try_from(u64::from(index) * PART_BYTES).map_err(|_| SealedError::Seal)?;
        let end = start
            .saturating_add(usize::try_from(PART_BYTES).map_err(|_| SealedError::Seal)?)
            .min(plaintext.len());
        let sealed = seal_part(keys, index, &plaintext[start..end], compress)?;
        parts.push((name(keys, &h, index), sealed));
    }
    Ok(SealedFile { h, parts })
}

// ─── sealing a file in one pass ─────────────────────────────────────────────

/// One part [`FileSealer`] wrote, named once the whole file was hashed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePart {
    pub name: Name,
    pub part_index: u32,
    /// The part's plaintext length.
    pub part_len: u64,
    pub digest: Digest,
    /// The sealed length.
    pub len: u64,
    /// The temp file the part was sealed to; the caller renames it.
    pub path: PathBuf,
}

/// A file sealed in one pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileSeal {
    pub h: PlaintextHash,
    pub len: u64,
    pub parts: Vec<FilePart>,
}

struct OpenPart {
    index: u32,
    path: PathBuf,
    fed: u64,
    sealer: PartSealer<BufWriter<File>>,
}

/// Hashes a file and seals it into parts **in the same stream**, so a source
/// is read once (#1080 A8). Each part goes to a temp path the caller supplies
/// by part index; [`FileSealer::finish`] returns `h`, so every part's name, and
/// the caller renames the temp files. Dropped unfinished, it removes them.
///
/// A part's length is in its header, which is written first. The sealer plans
/// each part's length from `declared_len` — a full 64 MiB when nothing was
/// declared — and a part that ends at another length is re-sealed from its own
/// temp file: a local rewrite of one part, never a second read of the source.
/// A correct declaration therefore costs nothing extra.
pub struct FileSealer<F: FnMut(u32) -> PathBuf> {
    keys: BackupKeys,
    compress: bool,
    declared_len: Option<u64>,
    temp_path: F,
    hasher: blake3::Hasher,
    len: u64,
    current: Option<OpenPart>,
    done: Vec<(PathBuf, PartSeal)>,
    finished: bool,
}

impl<F: FnMut(u32) -> PathBuf> FileSealer<F> {
    /// Begin a file whose parts go to `temp_path(part_index)`.
    #[must_use]
    pub fn new(keys: &BackupKeys, compress: bool, declared_len: Option<u64>, temp_path: F) -> Self {
        Self {
            keys: keys.clone(),
            compress,
            declared_len,
            temp_path,
            hasher: blake3::Hasher::new(),
            len: 0,
            current: None,
            done: Vec::new(),
            finished: false,
        }
    }

    /// The plaintext bytes fed so far.
    #[must_use]
    pub const fn len(&self) -> u64 {
        self.len
    }

    /// Whether nothing has been fed yet.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The length part `index` is planned at: the declaration's, or a full
    /// part when nothing was declared or the declaration ran out.
    fn planned_len(&self, index: u32) -> u64 {
        self.declared_len
            .and_then(|declared| part_len(declared, index).ok())
            .unwrap_or(PART_BYTES)
    }

    fn start_part(&mut self) -> Result<(), SealedError> {
        let index = u32::try_from(self.done.len()).map_err(|_| SealedError::BadHeader {
            reason: "the file is longer than u32::MAX parts",
        })?;
        let path = (self.temp_path)(index);
        let sealer = PartSealer::new(
            &self.keys,
            index,
            self.planned_len(index),
            self.compress,
            BufWriter::new(File::create(&path)?),
        )?;
        self.current = Some(OpenPart {
            index,
            path,
            fed: 0,
            sealer,
        });
        Ok(())
    }

    /// Feed the next bytes of the file.
    ///
    /// # Errors
    /// The filesystem, zstd or the cipher refused.
    pub fn update(&mut self, mut data: &[u8]) -> Result<(), SealedError> {
        self.hasher.update(data);
        while !data.is_empty() {
            if self
                .current
                .as_ref()
                .is_some_and(|part| part.fed == PART_BYTES)
            {
                self.close_part()?;
            }
            if self.current.is_none() {
                self.start_part()?;
            }
            let part = self.current.as_mut().ok_or(SealedError::Seal)?;
            let room = usize::try_from(PART_BYTES - part.fed).unwrap_or(usize::MAX);
            let take = room.min(data.len());
            let piece = &data[..take];
            if part.fed + take as u64 > u64::from(part.sealer.header.part_len) {
                // The declaration was short: this part outgrows its header,
                // so it is sealed again at its real length when it closes.
                part.sealer.overrun(piece)?;
            } else {
                part.sealer.update(piece)?;
            }
            part.fed += take as u64;
            self.len += take as u64;
            data = &data[take..];
        }
        Ok(())
    }

    /// Close the open part, re-sealing it if it did not end at the length
    /// its header was written with.
    fn close_part(&mut self) -> Result<(), SealedError> {
        let Some(part) = self.current.take() else {
            return Ok(());
        };
        let path = part.path.clone();
        let index = part.index;
        let fed = part.fed;
        let (writer, seal) = part.sealer.finish_at(fed)?;
        let file = writer.into_inner().map_err(|error| error.into_error())?;
        file.sync_all()?;
        drop(file);
        let seal = if u64::from(seal.header.part_len) == fed {
            seal
        } else {
            reseal(&self.keys, &path, index, fed, self.compress)?
        };
        self.done.push((path, seal));
        Ok(())
    }

    /// Seal the last part and name every part.
    ///
    /// # Errors
    /// The filesystem, zstd or the cipher refused.
    pub fn finish(mut self) -> Result<FileSeal, SealedError> {
        if self.current.is_none() && self.done.is_empty() {
            // An empty file is one empty part.
            self.start_part()?;
        }
        self.close_part()?;
        let h = PlaintextHash(*self.hasher.finalize().as_bytes());
        let parts = self
            .done
            .iter()
            .map(|(path, seal)| FilePart {
                name: name(&self.keys, &h, seal.header.part_index),
                part_index: seal.header.part_index,
                part_len: u64::from(seal.header.part_len),
                digest: seal.digest,
                len: seal.len,
                path: path.clone(),
            })
            .collect();
        self.finished = true;
        Ok(FileSeal {
            h,
            len: self.len,
            parts,
        })
    }
}

impl<F: FnMut(u32) -> PathBuf> Drop for FileSealer<F> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        // An abandoned file: its temp parts are all there is to undo, and a
        // failure to remove one is the caller's sweep to make.
        if let Some(part) = self.current.take() {
            drop(part.sealer);
            let _ = std::fs::remove_file(&part.path);
        }
        for (path, _) in &self.done {
            let _ = std::fs::remove_file(path);
        }
    }
}

// ─── sealing a window of a file whose hash is known ─────────────────────────

/// Seals **chosen parts of a file whose hash and length are already known**,
/// as the whole file streams through (#1080, R-1080-C39). Every part's name is
/// known before the first byte, so the parts that fit the spool now are
/// sealed from one read and the rest from later ones: a library item larger
/// than the spool backs up a window at a time instead of never. The bytes
/// outside the window only pass by.
///
/// Nothing it wrote is a part until [`WindowSealer::finish`] is shown the
/// hash and length of what actually streamed, and they are the file's: a
/// library item edited between two reads would otherwise put two versions'
/// bytes under one file's names, and only a restore would find out. Dropped
/// unfinished, or finished with another file's hash, it removes its temp
/// files.
pub struct WindowSealer<F: FnMut(u32) -> PathBuf> {
    keys: BackupKeys,
    compress: bool,
    h: PlaintextHash,
    file_len: u64,
    /// The window's parts not yet begun, ascending.
    window: VecDeque<u32>,
    temp_path: F,
    /// The stream's bytes so far, inside the window or not.
    fed: u64,
    current: Option<OpenPart>,
    done: Vec<(PathBuf, PartSeal)>,
    finished: bool,
}

impl<F: FnMut(u32) -> PathBuf> WindowSealer<F> {
    /// Begin streaming the `file_len`-byte file `h`, sealing the parts in
    /// `window` to `temp_path(part_index)`.
    ///
    /// # Errors
    /// [`SealedError::PartIndexOutOfRange`] for a part the file does not have,
    /// and [`SealedError::BadHeader`] for a file past [`MAX_FILE_BYTES`].
    pub fn new(
        keys: &BackupKeys,
        compress: bool,
        h: PlaintextHash,
        file_len: u64,
        window: impl IntoIterator<Item = u32>,
        temp_path: F,
    ) -> Result<Self, SealedError> {
        let window: BTreeSet<u32> = window.into_iter().collect();
        for index in &window {
            part_len(file_len, *index)?;
        }
        Ok(Self {
            keys: keys.clone(),
            compress,
            h,
            file_len,
            window: window.into_iter().collect(),
            temp_path,
            fed: 0,
            current: None,
            done: Vec::new(),
            finished: false,
        })
    }

    /// Feed the next bytes of the stream.
    ///
    /// # Errors
    /// [`SealedError::HashMismatch`] for a stream longer than the file, which
    /// is therefore not the file; otherwise the filesystem, zstd or the cipher
    /// refused. Either way nothing it sealed will be kept.
    pub fn update(&mut self, mut data: &[u8]) -> Result<(), SealedError> {
        if self.fed.saturating_add(data.len() as u64) > self.file_len {
            return Err(SealedError::HashMismatch);
        }
        while !data.is_empty() {
            let index =
                u32::try_from(self.fed / PART_BYTES).map_err(|_| SealedError::BadHeader {
                    reason: "the file is longer than u32::MAX parts",
                })?;
            let start = u64::from(index) * PART_BYTES;
            let end = start + part_len(self.file_len, index)?;
            if self.current.is_none() && self.fed == start && self.window.front() == Some(&index) {
                self.window.pop_front();
                self.start_part(index)?;
            }
            let take =
                usize::try_from((end - self.fed).min(data.len() as u64)).unwrap_or(data.len());
            if let Some(part) = self.current.as_mut() {
                part.sealer.update(&data[..take])?;
                part.fed += take as u64;
            }
            self.fed += take as u64;
            data = &data[take..];
            if self.fed == end {
                self.close_part()?;
            }
        }
        Ok(())
    }

    fn start_part(&mut self, index: u32) -> Result<(), SealedError> {
        let path = (self.temp_path)(index);
        let sealer = PartSealer::new(
            &self.keys,
            index,
            part_len(self.file_len, index)?,
            self.compress,
            BufWriter::new(File::create(&path)?),
        )?;
        self.current = Some(OpenPart {
            index,
            path,
            fed: 0,
            sealer,
        });
        Ok(())
    }

    /// Close the open part: every part here is sealed at the length its
    /// header was written with, so none is ever re-sealed.
    fn close_part(&mut self) -> Result<(), SealedError> {
        let Some(part) = self.current.take() else {
            return Ok(());
        };
        let (writer, seal) = part.sealer.finish()?;
        let file = writer.into_inner().map_err(|error| error.into_error())?;
        file.sync_all()?;
        drop(file);
        self.done.push((part.path, seal));
        Ok(())
    }

    /// Keep the window, if what streamed was the file. `streamed` and
    /// `streamed_len` are the hash and length of the whole stream, which the
    /// caller measured; `None`, with no temp file left, when they are another
    /// file's or a part of the window never streamed whole.
    ///
    /// # Errors
    /// The filesystem, zstd or the cipher refused the empty part of an empty
    /// file.
    pub fn finish(
        mut self,
        streamed: &PlaintextHash,
        streamed_len: u64,
    ) -> Result<Option<FileSeal>, SealedError> {
        if *streamed != self.h || streamed_len != self.file_len || self.fed != self.file_len {
            return Ok(None);
        }
        if self.file_len == 0 && self.window.front() == Some(&0) {
            // An empty file is one empty part, and no byte arrived to begin it.
            self.window.pop_front();
            self.start_part(0)?;
            self.close_part()?;
        }
        if self.current.is_some() || !self.window.is_empty() {
            return Ok(None);
        }
        let parts = self
            .done
            .iter()
            .map(|(path, seal)| FilePart {
                name: name(&self.keys, &self.h, seal.header.part_index),
                part_index: seal.header.part_index,
                part_len: u64::from(seal.header.part_len),
                digest: seal.digest,
                len: seal.len,
                path: path.clone(),
            })
            .collect();
        self.finished = true;
        Ok(Some(FileSeal {
            h: self.h,
            len: self.file_len,
            parts,
        }))
    }
}

impl<F: FnMut(u32) -> PathBuf> Drop for WindowSealer<F> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        // A window not kept: its temp parts are all there is to undo, and a
        // failure to remove one is the spool's sweep to make.
        if let Some(part) = self.current.take() {
            drop(part.sealer);
            let _ = std::fs::remove_file(&part.path);
        }
        for (path, _) in &self.done {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl<W: Write> PartSealer<W> {
    /// Accept bytes past the planned `part_len`, for a part [`FileSealer`]
    /// will re-seal at its real length. The chunks written carry the planned
    /// header and are never handed to anybody as they stand.
    fn overrun(&mut self, data: &[u8]) -> Result<(), SealedError> {
        match &mut self.stage {
            Stage::Plain(chunker) => chunker.push(data)?,
            Stage::Zstd(encoder) => encoder.write_all(data).map_err(from_io)?,
        }
        self.fed = self.fed.saturating_add(data.len() as u64);
        Ok(())
    }

    /// Finish a part that may not have reached its planned length: the result
    /// is well-formed only when it did, which the caller checks.
    fn finish_at(self, fed: u64) -> Result<(W, PartSeal), SealedError> {
        let chunker = match self.stage {
            Stage::Plain(chunker) => chunker,
            Stage::Zstd(encoder) => encoder.finish().map_err(from_io)?,
        };
        let mut counted = chunker.finish()?;
        counted.flush()?;
        debug_assert_eq!(self.fed, fed, "the file sealer counts what it fed");
        Ok((
            counted.inner,
            PartSeal {
                header: self.header,
                digest: Digest(*counted.hasher.finalize().as_bytes()),
                len: counted.written,
            },
        ))
    }
}

/// Seal the part at `path` again at its real length, `actual`, from its own
/// ciphertext, and put the result where it was.
fn reseal(
    keys: &BackupKeys,
    path: &Path,
    index: u32,
    actual: u64,
    compress: bool,
) -> Result<PartSeal, SealedError> {
    let mut staged = path.as_os_str().to_owned();
    staged.push(".reseal");
    let staged = PathBuf::from(staged);
    let mut reader = io::BufReader::new(File::open(path)?);
    let (header, header_bytes) = read_header(&mut reader)?;
    let cipher = cipher_for(keys, &header.salt);
    let sealer = PartSealer::new(
        keys,
        index,
        actual,
        compress,
        BufWriter::new(File::create(&staged)?),
    )?;
    let mut sink = SealerSink(sealer);
    let mut payload = Payload::new(header.compressed, PART_BYTES, &mut sink)?;
    open_chunks(&cipher, &header_bytes, &mut reader, |chunk| {
        payload.take(chunk)
    })?;
    let carried = payload.finish()?;
    if carried != actual {
        return Err(SealedError::PartLenMismatch {
            declared: actual,
            actual: carried,
        });
    }
    let (writer, seal) = sink.0.finish()?;
    let file = writer.into_inner().map_err(|error| error.into_error())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&staged, path)?;
    Ok(seal)
}

/// Lets a [`PartSealer`] stand where a writer is expected.
struct SealerSink<W: Write>(PartSealer<W>);

impl<W: Write> Write for SealerSink<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.update(buf).map_err(into_io)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
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

fn read_header(reader: &mut impl Read) -> Result<(Header, [u8; HEADER_BYTES]), SealedError> {
    let mut bytes = [0_u8; HEADER_BYTES];
    read_exact_or(reader, &mut bytes, "the header")?;
    Ok((Header::decode(&bytes)?, bytes))
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

/// Open every chunk after the header, in order, handing each one's payload to
/// `take`.
fn open_chunks(
    cipher: &XChaCha20Poly1305,
    header_bytes: &[u8; HEADER_BYTES],
    reader: &mut impl Read,
    mut take: impl FnMut(&[u8]) -> Result<(), SealedError>,
) -> Result<(), SealedError> {
    let mut buffer = Vec::new();
    let mut index = 0_u32;
    let mut frame = match read_next(reader)? {
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
        read_exact_or(reader, &mut buffer, "a chunk's ciphertext")?;
        let mut tag = [0_u8; TAG_BYTES];
        read_exact_or(reader, &mut tag, "a chunk's tag")?;
        let next = read_next(reader)?;
        let last = matches!(next, Next::End);

        let opened = |buffer: &mut Vec<u8>, last: bool| {
            cipher
                .decrypt_inout_detached(
                    &XNonce::from(nonce),
                    &chunk_aad(header_bytes, index, last),
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
        take(&buffer)?;
        match next {
            Next::End => return Ok(()),
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
}

/// Where opened payload goes: counted against a limit, then handed on.
struct Bounded<W> {
    inner: W,
    limit: u64,
    count: u64,
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
        self.count = after;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// A payload being opened: decompressed when flagged, bounded by `limit`.
enum Payload<W: Write> {
    Plain(Bounded<W>),
    Zstd(zstd::stream::write::Decoder<'static, Bounded<W>>),
}

impl<W: Write> Payload<W> {
    fn new(compressed: bool, limit: u64, inner: W) -> Result<Self, SealedError> {
        let bounded = Bounded {
            inner,
            limit,
            count: 0,
        };
        Ok(if compressed {
            Self::Zstd(zstd::stream::write::Decoder::new(bounded)?)
        } else {
            Self::Plain(bounded)
        })
    }

    fn take(&mut self, chunk: &[u8]) -> Result<(), SealedError> {
        match self {
            Self::Plain(bounded) => bounded.write_all(chunk).map_err(from_io),
            Self::Zstd(decoder) => decoder.write_all(chunk).map_err(from_io),
        }
    }

    /// Flush, and answer how many plaintext bytes came out.
    fn finish(self) -> Result<u64, SealedError> {
        let mut bounded = match self {
            Self::Plain(bounded) => bounded,
            Self::Zstd(mut decoder) => {
                decoder.flush().map_err(from_io)?;
                decoder.into_inner()
            }
        };
        bounded.flush()?;
        Ok(bounded.count)
    }
}

/// Open one part, streaming its plaintext into `sink` and holding at most one
/// chunk in memory. Only `K_backup` and the part's own header are needed.
///
/// **What reaches `sink` is unverified until this returns `Ok`**, and even
/// then it is only "a part this vault sealed": which file it belongs to is
/// checked against `h` by [`Assembler`], or against its name by
/// [`open_whole`]. A caller writing to a file writes a temporary one and
/// renames when that check passes.
///
/// # Errors
/// Every refusal in this module's header.
pub fn open_part_to<R: Read, W: Write>(
    keys: &BackupKeys,
    mut reader: R,
    sink: &mut W,
) -> Result<Header, SealedError> {
    let (header, header_bytes) = read_header(&mut reader)?;
    let cipher = cipher_for(keys, &header.salt);
    let declared = u64::from(header.part_len);
    let mut payload = Payload::new(header.compressed, declared, sink)?;
    open_chunks(&cipher, &header_bytes, &mut reader, |chunk| {
        payload.take(chunk)
    })?;
    let actual = payload.finish()?;
    if actual != declared {
        return Err(SealedError::PartLenMismatch { declared, actual });
    }
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
pub fn open_part(keys: &BackupKeys, sealed: &[u8]) -> Result<Opened, SealedError> {
    let mut plaintext = Vec::new();
    let header = open_part_to(keys, sealed, &mut plaintext)?;
    Ok(Opened { header, plaintext })
}

/// Open a one-part file fetched by `name`, and check it is the file that name
/// was derived for: `name(blake3(plaintext), 0)` must be `name`. Ranges and
/// manifests are opened this way, because nothing else carries their `h`.
///
/// # Errors
/// [`SealedError::NameMismatch`] for any other part — part 0 of a longer file
/// included — and every refusal of [`open_part`].
pub fn open_whole(keys: &BackupKeys, name: &Name, sealed: &[u8]) -> Result<Vec<u8>, SealedError> {
    let opened = open_part(keys, sealed)?;
    if opened.header.part_index != 0
        || self::name(keys, &PlaintextHash::of(&opened.plaintext), 0) != *name
    {
        return Err(SealedError::NameMismatch);
    }
    Ok(opened.plaintext)
}

/// Join opened parts, given in part order, into the file `h` names.
///
/// # Errors
/// [`SealedError::Assembly`] for parts out of order or not cut at 64 MiB, and
/// [`SealedError::HashMismatch`] when the result is not the file `h` names —
/// which a missing or substituted part also produces.
pub fn assemble(parts: Vec<Opened>, h: &PlaintextHash) -> Result<Vec<u8>, SealedError> {
    let count = parts.len();
    if count == 0 {
        return Err(SealedError::Assembly {
            reason: "there are no parts",
        });
    }
    let mut out = Vec::with_capacity(parts.iter().map(|part| part.plaintext.len()).sum());
    for (position, part) in parts.into_iter().enumerate() {
        if u64::from(part.header.part_index) != position as u64 {
            return Err(SealedError::Assembly {
                reason: "the parts are out of order",
            });
        }
        if position + 1 < count && u64::from(part.header.part_len) != PART_BYTES {
            return Err(SealedError::Assembly {
                reason: "a part before the last is not 64 MiB",
            });
        }
        out.extend_from_slice(&part.plaintext);
    }
    if PlaintextHash::of(&out) != *h {
        return Err(SealedError::HashMismatch);
    }
    Ok(out)
}

/// A file opened part by part into one sink and checked against `h` at the
/// end, holding at most one chunk in memory.
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
    /// [`SealedError::Assembly`] when every part is already in, or the part
    /// is not the next one at its length; otherwise whatever
    /// [`open_part_to`] refuses.
    pub fn part<R: Read, W: Write>(
        &mut self,
        keys: &BackupKeys,
        reader: R,
        sink: &mut W,
    ) -> Result<(), SealedError> {
        if self.next >= part_count(self.file_len) {
            return Err(SealedError::Assembly {
                reason: "every part is already in",
            });
        }
        let expected = part_len(self.file_len, self.next)?;
        let mut tee = Tee {
            inner: sink,
            hasher: &mut self.hasher,
        };
        let header = open_part_to(keys, reader, &mut tee)?;
        if header.part_index != self.next || u64::from(header.part_len) != expected {
            return Err(SealedError::Assembly {
                reason: "the part is not the next one at its length",
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

    /// A compressible stream, for the tests about part boundaries: it keeps
    /// the AEAD's work small in an unoptimised build.
    fn pattern(len: usize) -> Vec<u8> {
        let mut out = b"a long video, frame after frame. ".repeat(len / 33 + 1);
        out.truncate(len);
        out
    }

    fn sealed(plaintext: &[u8], compress: bool) -> Vec<u8> {
        seal_part(&keys(), 0, plaintext, compress).expect("seals")
    }

    fn opened(sealed: &[u8]) -> Result<Vec<u8>, SealedError> {
        open_part(&keys(), sealed).map(|opened| opened.plaintext)
    }

    /// **A FILE AT A PART'S EDGE** (#1080, the sweep's B5): a byte under a
    /// part is one part, exactly a part is one part of every byte — never a
    /// second, empty one — a byte over is a full part and a part of one
    /// byte, and an empty file is one empty part. The names follow the parts.
    #[test]
    fn a_file_at_a_parts_edge_has_the_parts_it_should() {
        let h = PlaintextHash::of(b"a film at the edge");
        for (len, parts) in [
            (0, vec![0]),
            (PART_BYTES - 1, vec![PART_BYTES - 1]),
            (PART_BYTES, vec![PART_BYTES]),
            (PART_BYTES + 1, vec![PART_BYTES, 1]),
            (2 * PART_BYTES, vec![PART_BYTES, PART_BYTES]),
        ] {
            let count = part_count(len);
            assert_eq!(count as usize, parts.len(), "{len} bytes");
            let lengths: Vec<u64> = (0..count)
                .map(|index| part_len(len, index).expect("a part"))
                .collect();
            assert_eq!(lengths, parts, "{len} bytes");
            assert!(
                part_len(len, count).is_err(),
                "{len} bytes has no part {count}"
            );
            assert_eq!(names_of(&keys(), &h, len).len(), parts.len());
        }
    }

    #[test]
    fn keys_names_and_part_keys_are_derived_and_distinct() {
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
        assert_ne!(part_key(&keys, &[1; 16]), part_key(&keys, &[2; 16]));
        assert_ne!(part_key(&keys, &[1; 16]), part_key(&other, &[1; 16]));

        let text = first.to_string();
        assert_eq!(text.len(), 64);
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
    fn small_empty_and_compressed_parts_round_trip_with_the_keys_alone() {
        let compressible = b"core_content_item rows, page after page. ".repeat(4_000);
        for (plaintext, compress) in [
            (Vec::new(), false),
            (Vec::new(), true),
            (b"a short body".to_vec(), false),
            (compressible.clone(), true),
            (compressible, false),
        ] {
            let opened = open_part(&keys(), &sealed(&plaintext, compress)).expect("opens");
            assert_eq!(opened.plaintext, plaintext);
            assert_eq!(opened.header.compressed, compress);
            assert_eq!(u64::from(opened.header.part_len), plaintext.len() as u64);
        }
        let packed = sealed(&b"0123456789".repeat(100_000), true);
        assert!(packed.len() < 100_000, "{} bytes", packed.len());
    }

    /// Exactly one full chunk is ONE chunk, marked last; one byte more is two.
    #[test]
    fn chunk_boundaries_frame_canonically() {
        let chunk = (CHUNK_FRAME_BYTES + TAG_BYTES) as u64;
        for (len, chunks) in [
            (0_usize, 1_u64),
            (1, 1),
            (CHUNK_BYTES, 1),
            (CHUNK_BYTES + 1, 2),
            (2 * CHUNK_BYTES + 5, 3),
        ] {
            let plaintext = noise(len, 1);
            let bytes = sealed(&plaintext, false);
            assert_eq!(
                bytes.len() as u64,
                HEADER_BYTES as u64 + chunks * chunk + len as u64,
                "{len} bytes seal to {chunks} chunk(s)"
            );
            assert_eq!(opened(&bytes).expect("opens"), plaintext);
        }
    }

    /// A reader that hands back 4,093 bytes at a time, a prime, so reads end
    /// inside frames, nonces and tags.
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
    fn a_part_streamed_in_odd_pieces_opens_from_an_odd_reader() {
        let keys = keys();
        for compress in [false, true] {
            let plaintext = noise(2 * CHUNK_BYTES + 12_345, 2);
            let mut sealer =
                PartSealer::new(&keys, 3, plaintext.len() as u64, compress, Vec::new())
                    .expect("begins");
            for piece in plaintext.chunks(1_000_003) {
                sealer.write_all(piece).expect("streams");
            }
            let (bytes, seal) = sealer.finish().expect("finishes");
            assert_eq!(seal.digest, Digest::of(&bytes));
            assert_eq!(seal.len, bytes.len() as u64);
            assert_eq!(seal.header.part_index, 3);

            let mut back = Vec::new();
            let header = open_part_to(&keys, Trickle(&bytes), &mut back).expect("opens");
            assert_eq!(header, seal.header);
            assert_eq!(back, plaintext);
        }
    }

    /// The same plaintext has one NAME and seals to different BYTES every
    /// time: names dedupe, salts and nonces never repeat.
    #[test]
    fn the_same_plaintext_has_one_name_and_two_ciphertexts() {
        let keys = keys();
        let first = seal_file(&keys, b"the same photograph", false).expect("seals");
        let second = seal_file(&keys, b"the same photograph", false).expect("seals");
        assert_eq!(first.parts[0].0, second.parts[0].0);
        assert_ne!(first.parts[0].1, second.parts[0].1);
        assert_ne!(
            first.parts[0].1[14..30],
            second.parts[0].1[14..30],
            "two salts"
        );
        assert_eq!(
            opened(&second.parts[0].1).expect("opens"),
            b"the same photograph"
        );
    }

    /// **Red first for the blindness half of #1080 ruling 3.** A gateway
    /// holds the sealed bytes; neither the plaintext nor `h` is readable in
    /// them. The last assertion shows the scan finds `h` where it is printed,
    /// so it is not vacuous.
    #[test]
    fn the_sealed_bytes_carry_neither_the_plaintext_nor_its_hash() {
        let plaintext = b"locker_key and access_device_secret, in the clear".repeat(64);
        let h = PlaintextHash::of(&plaintext);
        for compress in [false, true] {
            let bytes = sealed(&plaintext, compress);
            assert!(
                !bytes.windows(32).any(|window| window == h.as_bytes()),
                "h is printed on the outside of the part"
            );
            assert!(!bytes.windows(16).any(|window| window == &plaintext[..16]));
        }
        let mut printed = sealed(&plaintext, false);
        printed.extend_from_slice(h.as_bytes());
        assert!(printed.windows(32).any(|window| window == h.as_bytes()));
    }

    fn flipped(bytes: &[u8], at: usize, bit: u8) -> Vec<u8> {
        let mut out = bytes.to_vec();
        out[at] ^= bit;
        out
    }

    /// One flipped bit anywhere refuses: the clear header is authenticated as
    /// every chunk's AAD, and the salt is the key.
    #[test]
    fn a_flipped_byte_in_any_field_refuses() {
        let plaintext = noise(CHUNK_BYTES + 100, 3);
        let bytes = sealed(&plaintext, false);
        let first_chunk = HEADER_BYTES;
        let second_chunk = first_chunk + CHUNK_FRAME_BYTES + CHUNK_BYTES + TAG_BYTES;
        assert!(matches!(
            opened(&flipped(&bytes, 0, 1)),
            Err(SealedError::BadMagic)
        ));
        assert!(matches!(
            opened(&flipped(&bytes, 4, 1)),
            Err(SealedError::BadVersion(3))
        ));
        assert!(matches!(
            opened(&flipped(&bytes, 5, 0b10)),
            Err(SealedError::UnknownFlags(2))
        ));
        for (field, at, bit) in [
            ("the compressed flag", 5, 1),
            ("part_index", 9, 1),
            ("part_len", 13, 1),
            ("the salt", 20, 1),
            ("a chunk nonce", first_chunk + 5, 1),
            (
                "a chunk's ciphertext",
                first_chunk + CHUNK_FRAME_BYTES + 1_000,
                1,
            ),
            ("a chunk's tag", second_chunk - 2, 1),
        ] {
            let outcome = opened(&flipped(&bytes, at, bit));
            assert!(
                matches!(outcome, Err(SealedError::ChunkOpen { index: 0 })),
                "{field}: {outcome:?}"
            );
        }
        let outcome = opened(&flipped(&bytes, second_chunk + CHUNK_FRAME_BYTES + 50, 1));
        assert!(
            matches!(outcome, Err(SealedError::ChunkOpen { index: 1 })),
            "{outcome:?}"
        );
        assert!(matches!(
            opened(&flipped(&bytes, 10, 0x80)),
            Err(SealedError::BadHeader { .. })
        ));
        // The length field: a larger length runs the frame into the next
        // chunk, a smaller one leaves bytes over; either way it is refused.
        assert!(opened(&flipped(&bytes, first_chunk + NONCE_BYTES + 3, 1)).is_err());
    }

    #[test]
    fn a_part_under_another_vaults_keys_does_not_open() {
        let bytes = sealed(b"one file", false);
        let foreign = BackupKeys::from_root(&[0x99; 32]);
        assert!(matches!(
            open_part(&foreign, &bytes),
            Err(SealedError::ChunkOpen { index: 0 })
        ));
    }

    #[test]
    fn a_missing_final_chunk_and_a_trailing_byte_are_named() {
        let bytes = sealed(&noise(2 * CHUNK_BYTES + 10, 4), false);
        let full_chunk = CHUNK_FRAME_BYTES + CHUNK_BYTES + TAG_BYTES;
        let two_chunks = HEADER_BYTES + 2 * full_chunk;
        assert!(matches!(
            opened(&bytes[..two_chunks]),
            Err(SealedError::MissingFinalChunk)
        ));
        assert!(matches!(
            opened(&bytes[..HEADER_BYTES]),
            Err(SealedError::MissingFinalChunk)
        ));
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(matches!(opened(&trailing), Err(SealedError::TrailingBytes)));
        let mut doubled = bytes.clone();
        doubled.extend_from_slice(&bytes[two_chunks..]);
        assert!(matches!(opened(&doubled), Err(SealedError::TrailingBytes)));
        assert!(matches!(
            opened(&bytes[..bytes.len() - 3]),
            Err(SealedError::Truncated { .. })
        ));
        assert!(matches!(
            opened(&bytes[..3]),
            Err(SealedError::Truncated { .. })
        ));
    }

    #[test]
    fn a_part_sealer_fed_the_wrong_length_refuses() {
        let keys = keys();
        let mut short = PartSealer::new(&keys, 0, 10, false, Vec::new()).expect("begins");
        short.update(b"nine byte").expect("feeds");
        assert!(matches!(
            short.finish(),
            Err(SealedError::PartLenMismatch {
                declared: 10,
                actual: 9
            })
        ));
        let mut long = PartSealer::new(&keys, 0, 10, false, Vec::new()).expect("begins");
        assert!(matches!(
            long.update(b"eleven byte"),
            Err(SealedError::PartLenMismatch {
                declared: 10,
                actual: 11
            })
        ));
        assert!(matches!(
            PartSealer::new(&keys, 0, PART_BYTES + 1, false, Vec::new()),
            Err(SealedError::BadHeader { .. })
        ));
    }

    #[test]
    fn the_header_is_thirty_bytes_in_a8s_order() {
        let header = Header {
            compressed: true,
            part_index: 0x0102_0304,
            part_len: 0x0506_0708,
            salt: [0xab; SALT_BYTES],
        };
        let encoded = header.encode();
        assert_eq!(HEADER_BYTES, 30);
        assert_eq!(&encoded[..6], b"CSB2\x02\x01");
        assert_eq!(&encoded[6..14], &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(&encoded[14..], &[0xab; SALT_BYTES]);
        let mut legal = header;
        legal.part_len = 7;
        assert_eq!(Header::decode(&legal.encode()).expect("decodes"), legal);
        assert!(matches!(
            Header::decode(&encoded),
            Err(SealedError::BadHeader { .. })
        ));
    }

    /// `open_whole` binds a one-part file to the name it was fetched by.
    #[test]
    fn a_whole_file_opens_only_under_its_own_name() {
        let keys = keys();
        let file = seal_file(&keys, b"a manifest", true).expect("seals");
        let (name, bytes) = &file.parts[0];
        assert_eq!(
            open_whole(&keys, name, bytes).expect("opens"),
            b"a manifest"
        );
        let other = seal_file(&keys, b"another manifest", true).expect("seals");
        assert!(matches!(
            open_whole(&keys, &other.parts[0].0, bytes),
            Err(SealedError::NameMismatch)
        ));
    }

    #[test]
    fn a_many_part_file_assembles_in_order_and_only_against_its_hash() {
        let keys = keys();
        let plaintext = pattern(usize::try_from(PART_BYTES).expect("fits") + 7);
        let file = seal_file(&keys, &plaintext, true).expect("seals");
        assert_eq!(file.parts.len(), 2);
        let parts: Vec<Opened> = file
            .parts
            .iter()
            .map(|(_, bytes)| open_part(&keys, bytes).expect("opens"))
            .collect();
        assert_eq!(parts[1].header.part_len, 7);
        // Part 0 of a longer file is not a whole file under its own name.
        assert!(matches!(
            open_whole(&keys, &file.parts[0].0, &file.parts[0].1),
            Err(SealedError::NameMismatch)
        ));

        let headers_only = |order: &[usize]| -> Vec<Opened> {
            order
                .iter()
                .map(|&index| Opened {
                    header: parts[index].header,
                    plaintext: Vec::new(),
                })
                .collect()
        };
        assert!(matches!(
            assemble(headers_only(&[1, 0]), &file.h),
            Err(SealedError::Assembly { .. })
        ));
        assert!(matches!(
            assemble(headers_only(&[0, 1]), &file.h),
            Err(SealedError::HashMismatch)
        ));
        assert!(matches!(
            assemble(parts.clone(), &PlaintextHash::of(b"another file")),
            Err(SealedError::HashMismatch)
        ));
        assert_eq!(assemble(parts, &file.h).expect("assembles"), plaintext);

        let mut assembler = Assembler::new(file.h, plaintext.len() as u64);
        for (name, bytes) in &file.parts {
            assert_eq!(assembler.next_name(&keys), Some(*name));
            assembler
                .part(&keys, bytes.as_slice(), &mut io::sink())
                .expect("opens");
        }
        assert_eq!(assembler.next_name(&keys), None);
        assembler.finish().expect("the whole is the file");

        // The tail where the head belongs is refused by its index.
        let mut wrong = Assembler::new(file.h, plaintext.len() as u64);
        assert!(matches!(
            wrong.part(&keys, file.parts[1].1.as_slice(), &mut io::sink()),
            Err(SealedError::Assembly { .. })
        ));
    }

    fn one_pass(dir: &Path, plaintext: &[u8], declared: Option<u64>, compress: bool) -> FileSeal {
        let mut sealer = FileSealer::new(&keys(), compress, declared, |index| {
            dir.join(format!("part-{index}.tmp"))
        });
        for piece in plaintext.chunks(3_000_017) {
            sealer.update(piece).expect("seals as it hashes");
        }
        sealer.finish().expect("finishes")
    }

    fn reassembled(seal: &FileSeal) -> Vec<u8> {
        let mut out = Vec::new();
        let mut assembler = Assembler::new(seal.h, seal.len);
        for part in &seal.parts {
            assert_eq!(assembler.next_name(&keys()), Some(part.name));
            let bytes = std::fs::read(&part.path).expect("the temp part is there");
            assert_eq!(Digest::of(&bytes), part.digest);
            assert_eq!(bytes.len() as u64, part.len);
            assembler
                .part(&keys(), bytes.as_slice(), &mut out)
                .expect("opens");
        }
        assembler.finish().expect("the whole is the file");
        out
    }

    /// **#1080 A8: one pass.** The file is hashed and sealed in the same
    /// stream, whether its length was declared right, wrong or not at all;
    /// the names come out at the end and every part opens and assembles.
    #[test]
    fn a_file_is_sealed_in_one_pass_whatever_its_declared_length() {
        let dir = tempfile::tempdir().expect("a directory");
        let plaintext = pattern(usize::try_from(PART_BYTES).expect("fits") + 1_234);
        let len = plaintext.len() as u64;
        for declared in [Some(len), None, Some(10), Some(len * 3)] {
            let seal = one_pass(dir.path(), &plaintext, declared, true);
            assert_eq!(seal.h, PlaintextHash::of(&plaintext), "{declared:?}");
            assert_eq!(seal.len, len);
            let names: Vec<Name> = seal.parts.iter().map(|part| part.name).collect();
            assert_eq!(names, names_of(&keys(), &seal.h, len), "{declared:?}");
            assert_eq!(seal.parts[1].part_len, 1_234);
            assert_eq!(reassembled(&seal), plaintext, "{declared:?}");
        }
        let empty = one_pass(dir.path(), b"", None, false);
        assert_eq!(empty.parts.len(), 1);
        assert_eq!(empty.parts[0].part_len, 0);
        assert!(reassembled(&empty).is_empty());
        let small = one_pass(dir.path(), b"a photograph", Some(12), false);
        assert_eq!(reassembled(&small), b"a photograph");
    }

    #[test]
    fn an_abandoned_file_leaves_no_temp_part_behind() {
        let dir = tempfile::tempdir().expect("a directory");
        {
            let mut sealer = FileSealer::new(&keys(), false, None, |index| {
                dir.path().join(format!("part-{index}.tmp"))
            });
            sealer.update(&noise(1_000, 6)).expect("seals");
            assert!(dir.path().join("part-0.tmp").exists());
        }
        assert_eq!(std::fs::read_dir(dir.path()).expect("lists").count(), 0);
    }

    fn windowed(
        dir: &Path,
        streamed: &[u8],
        h: PlaintextHash,
        len: u64,
        window: &[u32],
    ) -> Option<FileSeal> {
        // COMPRESSED, as `one_pass` is: `pattern` then keeps the AEAD's work
        // small in an unoptimised build.
        let mut sealer =
            WindowSealer::new(&keys(), true, h, len, window.iter().copied(), |index| {
                dir.join(format!("window-{index}.tmp"))
            })
            .expect("a window of the file");
        for piece in streamed.chunks(3_000_017) {
            sealer.update(piece).expect("seals what is in the window");
        }
        sealer
            .finish(&PlaintextHash::of(streamed), streamed.len() as u64)
            .expect("finishes")
    }

    /// **R-1080-C39: a file larger than the spool backs up a window at a
    /// time.** The parts of two windows, sealed from two reads under the names
    /// the file's hash gave before either began, are the parts one pass makes:
    /// they open and assemble into the file.
    #[test]
    fn windows_of_a_known_file_are_its_parts_under_its_names() {
        let dir = tempfile::tempdir().expect("a directory");
        let plaintext = pattern(usize::try_from(2 * PART_BYTES).expect("fits") + 4_321);
        let h = PlaintextHash::of(&plaintext);
        let len = plaintext.len() as u64;
        // THE MIDDLE ALONE: the stream passes the head and the tail by.
        let middle = windowed(dir.path(), &plaintext, h, len, &[1]).expect("the file's bytes");
        assert_eq!(middle.parts.len(), 1);
        assert_eq!(middle.parts[0].part_index, 1);
        // THE REST, from another read, in any order asked.
        let rest = windowed(dir.path(), &plaintext, h, len, &[2, 0]).expect("the file's bytes");
        let mut parts: Vec<FilePart> = middle.parts.into_iter().chain(rest.parts).collect();
        parts.sort_by_key(|part| part.part_index);
        let names: Vec<Name> = parts.iter().map(|part| part.name).collect();
        assert_eq!(names, names_of(&keys(), &h, len));
        assert_eq!(parts[2].part_len, 4_321);
        assert_eq!(reassembled(&FileSeal { h, len, parts }), plaintext);
        // AN EMPTY FILE is one empty part, sealed though no byte streamed.
        let nothing = PlaintextHash::of(b"");
        let empty = windowed(dir.path(), b"", nothing, 0, &[0]).expect("the empty file");
        assert_eq!(empty.parts.len(), 1);
        assert!(reassembled(&empty).is_empty());
    }

    /// **A FILE EDITED BETWEEN TWO READS KEEPS NOTHING**: its window was
    /// sealed from bytes that are not the file its names are derived from.
    #[test]
    fn a_window_streamed_from_another_file_keeps_nothing() {
        let dir = tempfile::tempdir().expect("a directory");
        let plaintext = noise(300_000, 9);
        let h = PlaintextHash::of(&plaintext);
        let len = plaintext.len() as u64;
        let mut edited = plaintext.clone();
        edited[150_000] ^= 1;
        assert!(windowed(dir.path(), &edited, h, len, &[0]).is_none());
        // A SHORTER STREAM is not the file either; a longer one is refused as
        // it arrives, and one abandoned part-way keeps nothing.
        assert!(windowed(dir.path(), &plaintext[..299_999], h, len, &[0]).is_none());
        let mut sealer = WindowSealer::new(&keys(), false, h, len, [0], |index| {
            dir.path().join(format!("abandoned-{index}.tmp"))
        })
        .expect("a window");
        sealer.update(&plaintext[..1_000]).expect("seals");
        assert!(dir.path().join("abandoned-0.tmp").exists());
        assert!(matches!(
            sealer.update(&noise(len as usize, 3)),
            Err(SealedError::HashMismatch)
        ));
        drop(sealer);
        assert_eq!(
            std::fs::read_dir(dir.path()).expect("lists").count(),
            0,
            "no temp part is left behind"
        );
        // A PART THE FILE DOES NOT HAVE is refused before a byte streams.
        assert!(matches!(
            WindowSealer::new(&keys(), false, h, len, [1], |_| dir.path().join("x")),
            Err(SealedError::PartIndexOutOfRange {
                index: 1,
                count: 1,
                ..
            })
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
