//! `centraid-sealed/4`: the one format every object a gateway stores wears
//! ([#1209](https://github.com/srikanth235/centraid/issues/1209),
//! [#1212](https://github.com/srikanth235/centraid/issues/1212), spec §2).
//!
//! Every stored object (a vault range, a tree node, a thumbnail chunk, an
//! original chunk) is **one sealed chunk** of at most [`CHUNK_BYTES`] of
//! plaintext. There are no parts, no salt and no streaming sealer: a file is
//! cut into chunks by the caller and each chunk is sealed on its own.
//!
//! ```text
//! name         = blake3_keyed(K_name, "obj4" ‖ c ‖ p)                            32 bytes
//! (body, flags)= if c == 1 && len(zstd_3(p)) < len(p) { (zstd_3(p), 0x01) }
//!                else                                 { (p,         0x00) }
//! inner_len    = 6 + len(body)
//! padded_len   = padme_len(inner_len)                                            64 ..= 6 + CHUNK_BYTES
//! padded_inner = flags (1) ‖ c (1) ‖ u32be(len(body)) (4) ‖ body ‖ 0x00 * (padded_len - inner_len)
//! aad          = "CSB4" ‖ u8(4) ‖ c ‖ name                                       38 bytes
//! nonce        = blake3_keyed(K_nonce, aad ‖ blake3(padded_inner))[0..24]        24 bytes
//! object       = "CSB4" ‖ u8(4) ‖ nonce ‖ XChaCha20-Poly1305(K_obj, nonce, aad, padded_inner)
//! digest       = blake3(object)                                                  32 bytes
//! ```
//!
//! `p` is the chunk's plaintext and `c` its [`Class`] byte.
//!
//! ## SEALING IS DETERMINISTIC, LENGTH-PADDED AND CLASS-AWARE
//!
//! The same plaintext and class under the same vault's keys give the same
//! name, object and digest, so a chunk is rebuilt from its source rather than
//! kept, and a resend is byte-identical. Neither `flags` nor `class` appears
//! in clear on the wire (`"CSB4" ‖ u8(4) ‖ nonce` is the entire 29-byte outer
//! header), and exact payload lengths are hidden inside Padmé buckets
//! ([`padme_len`], clamped at [`MAX_INNER_BYTES`] so a full 4 MiB chunk adds
//! zero padding bytes). Only [`Class::Records`] runs `zstd`; [`Class::Thumbnails`]
//! and [`Class::Originals`] are already entropy-coded media and never compress.
//! The nonce is derived from `aad ‖ blake3(padded_inner)` (SIV-style), so no
//! `(K_obj, nonce)` pair ever meets two inner frames.
//!
//! ## EVERY CONSTANT HERE IS A FORMAT DECISION
//!
//! The four `derive_key` contexts, the `"obj4"` name preimage, the outer and
//! inner header layouts, Padmé's floor and cap, the AAD, the nonce derivation,
//! the 4 MiB chunk, the flag bit and zstd level 3.
//! `contracts/crypto/sealed4-vectors.json` pins them (`tests/sealed4_vectors.rs`).
//!
//! ## WHAT OPENING REFUSES
//!
//! [`open`] runs the strict procedure and any failure is [`SealedError::Damaged`]
//! in one of its named forms: a length other than the reference's or outside
//! `[MIN_OBJECT_BYTES, MAX_OBJECT_BYTES]`, a digest that is not the object's, a
//! bad magic or version, a failed AEAD tag over the AAD naming `class` and
//! `name`, an unknown flag bit, an inner class other than the one asked for, a
//! compressed media class, a non-canonical Padmé length, any non-zero padding
//! byte, a nonce other than the one derived from `aad ‖ blake3(padded_inner)`,
//! a decompression past [`CHUNK_BYTES`], a body flagged compressed that is not
//! shorter than the plaintext, and a plaintext whose recomputed name is not
//! the one the object was asked for.

use std::fmt;
use std::str::FromStr;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use zeroize::Zeroize;

/// The format's name, as a vector file spells it.
pub const FORMAT_NAME: &str = "centraid-sealed/4";

/// The four bytes every object starts with.
pub const MAGIC: [u8; 4] = *b"CSB4";

/// The version byte after the magic.
pub const VERSION: u8 = 4;

/// The clear prefix before the nonce: magic and version (`flags` and `class`
/// live inside the encrypted inner header).
pub const HEADER_BYTES: usize = 4 + 1;

/// XChaCha20's nonce.
pub const NONCE_BYTES: usize = 24;

/// The clear wire header: magic, version and nonce (`29` bytes).
pub const OUTER_HEADER_BYTES: usize = HEADER_BYTES + NONCE_BYTES;

/// The encrypted inner header: `flags (1) ‖ class (1) ‖ u32be(body.len()) (4)`.
pub const INNER_HEADER_BYTES: usize = 1 + 1 + 4;

/// Poly1305's tag.
pub const TAG_BYTES: usize = 16;

/// **R2: a chunk is at most 4 MiB of plaintext.**
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// The largest unsealed inner frame (`6 + CHUNK_BYTES = 4,194,310` bytes).
pub const MAX_INNER_BYTES: usize = INNER_HEADER_BYTES + CHUNK_BYTES;

/// The smallest Padmé-padded inner frame (`64` bytes).
pub const MIN_INNER_BYTES: usize = 64;

/// What sealing adds at a full chunk: outer header, inner header and tag (`51` bytes).
pub const OVERHEAD_BYTES: usize = OUTER_HEADER_BYTES + INNER_HEADER_BYTES + TAG_BYTES;

/// The smallest valid sealed object (`29 + 64 + 16 = 109` bytes).
pub const MIN_OBJECT_BYTES: usize = OUTER_HEADER_BYTES + MIN_INNER_BYTES + TAG_BYTES;

/// The largest sealed object a 4 MiB chunk makes (`4,194,355` bytes, the gateway's cap).
pub const MAX_OBJECT_BYTES: usize = CHUNK_BYTES + OVERHEAD_BYTES;

/// Flag bit 0: the body is zstd (`Class::Records` only).
pub const FLAG_ZSTD: u8 = 0b0000_0001;

/// zstd level; the crate is pinned exactly so output never drifts.
pub const ZSTD_LEVEL: i32 = 3;

const ROOT_CONTEXT: &str = "centraid backup v2 root";
const NAME_CONTEXT: &str = "centraid backup v2 name";
const OBJECT_CONTEXT: &str = "centraid backup v4 object";
const NONCE_CONTEXT: &str = "centraid backup v4 nonce";
const NAME_PREIMAGE: &[u8; 4] = b"obj4";
const AAD_BYTES: usize = HEADER_BYTES + 1 + 32;

/// Padmé length padding in `[MIN_INNER_BYTES, MAX_INNER_BYTES]`.
#[must_use]
pub fn padme_len(len: usize) -> usize {
    if len <= MIN_INNER_BYTES {
        return MIN_INNER_BYTES;
    }
    let e = len.ilog2();
    let s = e.ilog2() + 1;
    let last_bits = e - s;
    let mask = (1_usize << last_bits) - 1;
    (len.saturating_add(mask) & !mask).min(MAX_INNER_BYTES)
}

/// Everything sealing and naming needs, derived from a vault's root key.
#[derive(Clone)]
pub struct BackupKeys {
    k_backup: [u8; 32],
    k_name: [u8; 32],
    k_obj: [u8; 32],
    k_nonce: [u8; 32],
}

impl BackupKeys {
    /// `K_backup = derive_key("centraid backup v2 root", root_key)`,
    /// `K_name = derive_key("centraid backup v2 name", K_backup)`,
    /// `K_obj = derive_key("centraid backup v4 object", K_backup)` and
    /// `K_nonce = derive_key("centraid backup v4 nonce", K_backup)`.
    #[must_use]
    pub fn from_root(root_key: &[u8; 32]) -> Self {
        let k_backup = blake3::derive_key(ROOT_CONTEXT, root_key);
        Self {
            k_backup,
            k_name: blake3::derive_key(NAME_CONTEXT, &k_backup),
            k_obj: blake3::derive_key(OBJECT_CONTEXT, &k_backup),
            k_nonce: blake3::derive_key(NONCE_CONTEXT, &k_backup),
        }
    }

    /// `K_backup`.
    #[must_use]
    pub const fn k_backup(&self) -> &[u8; 32] {
        &self.k_backup
    }

    /// `K_name`, the MAC key every name is computed under.
    #[must_use]
    pub const fn k_name(&self) -> &[u8; 32] {
        &self.k_name
    }

    /// `K_obj`, the AEAD key.
    #[must_use]
    pub const fn k_obj(&self) -> &[u8; 32] {
        &self.k_obj
    }

    /// `K_nonce`, the key nonces are derived under.
    #[must_use]
    pub const fn k_nonce(&self) -> &[u8; 32] {
        &self.k_nonce
    }
}

impl Drop for BackupKeys {
    fn drop(&mut self) {
        self.k_backup.zeroize();
        self.k_name.zeroize();
        self.k_obj.zeroize();
        self.k_nonce.zeroize();
    }
}

impl fmt::Debug for BackupKeys {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BackupKeys(<redacted>)")
    }
}

/// Parse 64 lowercase hex characters, and nothing else, into 32 bytes.
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

/// An object's name: `blake3_keyed(K_name, "obj4" ‖ c ‖ p)`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Name([u8; 32]);
hex32!(Name, "an object name");

/// `h`: the BLAKE3 of a whole file's plaintext (a content hash). Never leaves
/// the phone in the clear; it is a field of a sealed tree node.
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

/// The transport digest: BLAKE3 of an object's sealed bytes, which the
/// gateway verifies on arrival and stores.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Digest([u8; 32]);
hex32!(Digest, "a digest");

impl Digest {
    /// The BLAKE3 of `sealed`.
    #[must_use]
    pub fn of(sealed: &[u8]) -> Self {
        Self(*blake3::hash(sealed).as_bytes())
    }
}

/// What kind of bytes a chunk holds, which is also which phase of a backup
/// owes it (spec §3, R3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Class {
    /// Tree nodes, vault ranges, the directory: what opens the vault.
    Records,
    /// Derivative chunks: what makes the library browsable.
    Thumbnails,
    /// Original chunks.
    Originals,
}

impl Class {
    /// Every class, in restore order.
    pub const ALL: [Self; 3] = [Self::Records, Self::Thumbnails, Self::Originals];

    /// The class byte.
    #[must_use]
    pub const fn byte(self) -> u8 {
        match self {
            Self::Records => 1,
            Self::Thumbnails => 2,
            Self::Originals => 3,
        }
    }

    /// The class a byte names.
    #[must_use]
    pub const fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            1 => Some(Self::Records),
            2 => Some(Self::Thumbnails),
            3 => Some(Self::Originals),
            _ => None,
        }
    }
}

/// A reference to one stored object (spec §2):
/// `{name: 32, digest: 32, len: u32 (sealed length), class: u8}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Ref {
    pub name: Name,
    pub digest: Digest,
    /// The sealed object's length.
    pub len: u32,
    pub class: Class,
}

/// A ref's encoding: 32 + 32 + 4 + 1.
pub const REF_BYTES: usize = 69;

impl Ref {
    /// The 69-byte encoding.
    #[must_use]
    pub fn encode(&self) -> [u8; REF_BYTES] {
        let mut out = [0_u8; REF_BYTES];
        out[..32].copy_from_slice(self.name.as_bytes());
        out[32..64].copy_from_slice(self.digest.as_bytes());
        out[64..68].copy_from_slice(&self.len.to_be_bytes());
        out[68] = self.class.byte();
        out
    }

    /// Read a ref back.
    ///
    /// # Errors
    /// [`SealedError::BadRef`] for a wrong length or an unknown class.
    pub fn decode(bytes: &[u8]) -> Result<Self, SealedError> {
        let bytes: &[u8; REF_BYTES] = bytes.try_into().map_err(|_| SealedError::BadRef)?;
        let mut name = [0_u8; 32];
        name.copy_from_slice(&bytes[..32]);
        let mut digest = [0_u8; 32];
        digest.copy_from_slice(&bytes[32..64]);
        let mut len = [0_u8; 4];
        len.copy_from_slice(&bytes[64..68]);
        Ok(Self {
            name: Name(name),
            digest: Digest(digest),
            len: u32::from_be_bytes(len),
            class: Class::from_byte(bytes[68]).ok_or(SealedError::BadRef)?,
        })
    }
}

/// One sealed chunk.
#[derive(Clone, PartialEq, Eq)]
pub struct Sealed {
    pub name: Name,
    pub digest: Digest,
    pub class: Class,
    pub flags: u8,
    pub object: Vec<u8>,
}

impl fmt::Debug for Sealed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Sealed")
            .field("name", &self.name)
            .field("class", &self.class)
            .field("flags", &self.flags)
            .field("len", &self.object.len())
            .finish()
    }
}

impl Sealed {
    /// The reference to this object.
    #[must_use]
    pub fn reference(&self) -> Ref {
        Ref {
            name: self.name,
            digest: self.digest,
            len: u32::try_from(self.object.len()).unwrap_or(u32::MAX),
            class: self.class,
        }
    }
}

/// What sealing and opening refuse.
#[derive(Debug, thiserror::Error)]
pub enum SealedError {
    #[error("a chunk is at most {CHUNK_BYTES} bytes; this one is {0}")]
    TooLarge(usize),
    #[error("{what} is not 64 lowercase hex characters")]
    NotHex { what: &'static str },
    #[error("a reference is 69 bytes of a known class")]
    BadRef,
    /// **The one refusal of opening**, with the check that found it.
    #[error("the object is damaged: {0}")]
    Damaged(&'static str),
    #[error("the cipher refused to seal")]
    Seal,
}

/// `name = blake3_keyed(K_name, "obj4" ‖ c ‖ p)`.
#[must_use]
pub fn name_of(keys: &BackupKeys, class: Class, plaintext: &[u8]) -> Name {
    let mut hasher = blake3::Hasher::new_keyed(keys.k_name());
    hasher.update(NAME_PREIMAGE);
    hasher.update(&[class.byte()]);
    hasher.update(plaintext);
    Name(*hasher.finalize().as_bytes())
}

fn aad_of(class: u8, name: &Name) -> [u8; AAD_BYTES] {
    let mut aad = [0_u8; AAD_BYTES];
    aad[..4].copy_from_slice(&MAGIC);
    aad[4] = VERSION;
    aad[5] = class;
    aad[6..].copy_from_slice(name.as_bytes());
    aad
}

fn nonce_of(keys: &BackupKeys, aad: &[u8; AAD_BYTES], padded_inner: &[u8]) -> [u8; NONCE_BYTES] {
    let inner_hash = blake3::hash(padded_inner);
    let mut hasher = blake3::Hasher::new_keyed(keys.k_nonce());
    hasher.update(aad);
    hasher.update(inner_hash.as_bytes());
    let full = hasher.finalize();
    let mut nonce = [0_u8; NONCE_BYTES];
    nonce.copy_from_slice(&full.as_bytes()[..NONCE_BYTES]);
    nonce
}

fn build_padded_inner(
    flags: u8,
    inner_class: u8,
    body: &[u8],
    padded_len: usize,
) -> Result<Vec<u8>, SealedError> {
    let body_len = u32::try_from(body.len()).map_err(|_| SealedError::TooLarge(body.len()))?;
    let inner_len = INNER_HEADER_BYTES
        .checked_add(body.len())
        .ok_or(SealedError::TooLarge(body.len()))?;
    if padded_len < inner_len {
        return Err(SealedError::Seal);
    }
    let mut padded_inner = vec![0_u8; padded_len];
    padded_inner[0] = flags;
    padded_inner[1] = inner_class;
    padded_inner[2..INNER_HEADER_BYTES].copy_from_slice(&body_len.to_be_bytes());
    padded_inner[INNER_HEADER_BYTES..inner_len].copy_from_slice(body);
    Ok(padded_inner)
}

fn encrypt_inner_with_nonce(
    keys: &BackupKeys,
    aad: &[u8; AAD_BYTES],
    nonce: [u8; NONCE_BYTES],
    padded_inner: &[u8],
) -> Result<Vec<u8>, SealedError> {
    let cipher = XChaCha20Poly1305::new(&Key::from(*keys.k_obj()));
    let sealed = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: padded_inner,
                aad,
            },
        )
        .map_err(|_| SealedError::Seal)?;
    let mut object = Vec::with_capacity(OUTER_HEADER_BYTES + sealed.len());
    object.extend_from_slice(&MAGIC);
    object.push(VERSION);
    object.extend_from_slice(&nonce);
    object.extend_from_slice(&sealed);
    Ok(object)
}

/// Frame `body` as an object under `name`, `flags` and `class`: the part of
/// sealing after the body is chosen.
fn frame(
    keys: &BackupKeys,
    name: &Name,
    flags: u8,
    class: u8,
    body: &[u8],
) -> Result<Vec<u8>, SealedError> {
    let inner_len = INNER_HEADER_BYTES
        .checked_add(body.len())
        .ok_or(SealedError::TooLarge(body.len()))?;
    let padded_inner = build_padded_inner(flags, class, body, padme_len(inner_len))?;
    let aad = aad_of(class, name);
    let nonce = nonce_of(keys, &aad, &padded_inner);
    encrypt_inner_with_nonce(keys, &aad, nonce, &padded_inner)
}

/// Seal one chunk.
///
/// [`Class::Records`] uses `zstd` level 3 when strictly shorter than
/// `plaintext`; [`Class::Thumbnails`] and [`Class::Originals`] never run
/// `zstd`.
///
/// # Errors
/// [`SealedError::TooLarge`] past [`CHUNK_BYTES`].
pub fn seal(keys: &BackupKeys, class: Class, plaintext: &[u8]) -> Result<Sealed, SealedError> {
    if plaintext.len() > CHUNK_BYTES {
        return Err(SealedError::TooLarge(plaintext.len()));
    }
    let name = name_of(keys, class, plaintext);
    let compressed = match class {
        Class::Records => {
            let candidate =
                zstd::bulk::compress(plaintext, ZSTD_LEVEL).map_err(|_| SealedError::Seal)?;
            (candidate.len() < plaintext.len()).then_some(candidate)
        }
        Class::Thumbnails | Class::Originals => None,
    };
    let (flags, body): (u8, &[u8]) = match compressed.as_deref() {
        Some(shorter) => (FLAG_ZSTD, shorter),
        None => (0, plaintext),
    };
    let object = frame(keys, &name, flags, class.byte(), body)?;
    Ok(Sealed {
        name,
        digest: Digest::of(&object),
        class,
        flags,
        object,
    })
}

/// Open an object **strictly**: the reference's length and digest, the outer
/// bounds and header, the AEAD tag over the AAD naming `class` and `name`, the
/// inner flags and class, the uncompressed media rule, canonical Padmé length
/// and zero padding, the nonce derived from `aad ‖ blake3(padded_inner)`, a
/// bounded decompression, and a recomputed name that equals `name`.
///
/// `digest` and `len` are `None` only when opening an object known by name
/// alone (a head's root).
///
/// # Errors
/// [`SealedError::Damaged`] for any mismatch.
pub fn open_checked(
    keys: &BackupKeys,
    name: &Name,
    class: Class,
    digest: Option<&Digest>,
    len: Option<u32>,
    object: &[u8],
) -> Result<Vec<u8>, SealedError> {
    if let Some(len) = len
        && usize::try_from(len).ok() != Some(object.len())
    {
        return Err(SealedError::Damaged("its length is not the reference's"));
    }
    if let Some(digest) = digest
        && Digest::of(object) != *digest
    {
        return Err(SealedError::Damaged("its digest is not the reference's"));
    }
    if object.len() < MIN_OBJECT_BYTES || object.len() > MAX_OBJECT_BYTES {
        return Err(SealedError::Damaged("its length cannot be an object"));
    }
    if object[..4] != MAGIC {
        return Err(SealedError::Damaged("the magic is wrong"));
    }
    if object[4] != VERSION {
        return Err(SealedError::Damaged("the version is not 4"));
    }
    let nonce: [u8; NONCE_BYTES] = object[HEADER_BYTES..OUTER_HEADER_BYTES]
        .try_into()
        .map_err(|_| SealedError::Damaged("its nonce is cut short"))?;
    let aad = aad_of(class.byte(), name);
    let cipher = XChaCha20Poly1305::new(&Key::from(*keys.k_obj()));
    let padded_inner = cipher
        .decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &object[OUTER_HEADER_BYTES..],
                aad: &aad,
            },
        )
        .map_err(|_| SealedError::Damaged("it does not open"))?;
    if padded_inner.len() < MIN_INNER_BYTES || padded_inner.len() > MAX_INNER_BYTES {
        return Err(SealedError::Damaged("its inner length is out of bounds"));
    }
    let flags = padded_inner[0];
    let inner_class = padded_inner[1];
    let body_len_bytes: [u8; 4] = padded_inner[2..INNER_HEADER_BYTES]
        .try_into()
        .map_err(|_| SealedError::Damaged("its inner header is cut short"))?;
    let body_len = usize::try_from(u32::from_be_bytes(body_len_bytes))
        .map_err(|_| SealedError::Damaged("its body length overflows"))?;
    if flags & !FLAG_ZSTD != 0 {
        return Err(SealedError::Damaged("it sets an unknown flag"));
    }
    if inner_class != class.byte() {
        return Err(SealedError::Damaged("its class is not the one asked for"));
    }
    if class != Class::Records && (flags & FLAG_ZSTD != 0) {
        return Err(SealedError::Damaged("media classes are never compressed"));
    }
    let inner_len = INNER_HEADER_BYTES
        .checked_add(body_len)
        .ok_or(SealedError::Damaged("its body length overflows"))?;
    if body_len > CHUNK_BYTES || inner_len > padded_inner.len() {
        return Err(SealedError::Damaged("its body length cannot fit"));
    }
    if padded_inner.len() != padme_len(inner_len) {
        return Err(SealedError::Damaged("its padding length is not canonical"));
    }
    if !padded_inner[inner_len..].iter().all(|&byte| byte == 0) {
        return Err(SealedError::Damaged("its padding is not zero"));
    }
    if nonce != nonce_of(keys, &aad, &padded_inner) {
        return Err(SealedError::Damaged("its nonce is not the derived one"));
    }
    let body = &padded_inner[INNER_HEADER_BYTES..inner_len];
    let plaintext = if flags & FLAG_ZSTD == 0 {
        body.to_vec()
    } else {
        let mut plain = zstd::bulk::decompress(body, CHUNK_BYTES)
            .map_err(|_| SealedError::Damaged("its body does not decompress within a chunk"))?;
        if body.len() >= plain.len() {
            return Err(SealedError::Damaged(
                "it is flagged compressed but is not shorter",
            ));
        }
        plain.shrink_to_fit();
        plain
    };
    if plaintext.len() > CHUNK_BYTES {
        return Err(SealedError::Damaged("it is larger than a chunk"));
    }
    if name_of(keys, class, &plaintext) != *name {
        return Err(SealedError::Damaged("its plaintext is not the one named"));
    }
    Ok(plaintext)
}

/// [`open_checked`] against a reference.
///
/// # Errors
/// [`SealedError::Damaged`].
pub fn open(keys: &BackupKeys, reference: &Ref, object: &[u8]) -> Result<Vec<u8>, SealedError> {
    open_checked(
        keys,
        &reference.name,
        reference.class,
        Some(&reference.digest),
        Some(reference.len),
        object,
    )
}

/// Seal with chosen flags and body, for tests that forge an object whose
/// every layer is valid except the one under test.
#[cfg(test)]
#[doc(hidden)]
pub fn forge(
    keys: &BackupKeys,
    name: &Name,
    flags: u8,
    class: u8,
    body: &[u8],
) -> Result<Vec<u8>, SealedError> {
    frame(keys, name, flags, class, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> BackupKeys {
        BackupKeys::from_root(&[7; 32])
    }

    fn compressible(len: usize) -> Vec<u8> {
        b"SQLite format 3\0 rows, rows. "
            .iter()
            .copied()
            .cycle()
            .take(len)
            .collect()
    }

    fn incompressible(len: usize) -> Vec<u8> {
        let mut out = vec![0_u8; len];
        blake3::Hasher::new()
            .update(b"incompressible")
            .finalize_xof()
            .fill(&mut out);
        out
    }

    fn seal_raw_inner(
        keys: &BackupKeys,
        aad_class: u8,
        name: &Name,
        padded_inner: &[u8],
    ) -> Vec<u8> {
        let aad = aad_of(aad_class, name);
        let nonce = nonce_of(keys, &aad, padded_inner);
        encrypt_inner_with_nonce(keys, &aad, nonce, padded_inner).expect("encrypts")
    }

    #[test]
    fn constants_match_the_csb4_wire_budget() {
        assert_eq!(FORMAT_NAME, "centraid-sealed/4");
        assert_eq!(MAGIC, *b"CSB4");
        assert_eq!(VERSION, 4);
        assert_eq!(HEADER_BYTES, 5);
        assert_eq!(NONCE_BYTES, 24);
        assert_eq!(OUTER_HEADER_BYTES, 29);
        assert_eq!(INNER_HEADER_BYTES, 6);
        assert_eq!(TAG_BYTES, 16);
        assert_eq!(CHUNK_BYTES, 4_194_304);
        assert_eq!(MAX_INNER_BYTES, 4_194_310);
        assert_eq!(MIN_INNER_BYTES, 64);
        assert_eq!(OVERHEAD_BYTES, 51);
        assert_eq!(MIN_OBJECT_BYTES, 109);
        assert_eq!(MAX_OBJECT_BYTES, 4_194_355);
        assert_eq!(
            OUTER_HEADER_BYTES + MAX_INNER_BYTES + TAG_BYTES,
            MAX_OBJECT_BYTES
        );
    }

    #[test]
    fn padme_is_monotonic_idempotent_and_within_overhead_bounds() {
        assert_eq!(padme_len(0), MIN_INNER_BYTES);
        assert_eq!(padme_len(MIN_INNER_BYTES), MIN_INNER_BYTES);
        assert_eq!(padme_len(65), 72);
        // Inner frames of 73B (67B body) and 78B (72B body) share the 80B Padmé bucket.
        assert_eq!(padme_len(73), 80);
        assert_eq!(padme_len(78), 80);
        assert_eq!(padme_len(MAX_INNER_BYTES), MAX_INNER_BYTES);
        assert_eq!(padme_len(MAX_INNER_BYTES + 100), MAX_INNER_BYTES);

        let mut prev = MIN_INNER_BYTES;
        for len in 0..=MAX_INNER_BYTES {
            let padded = padme_len(len);
            assert!(padded >= len.max(MIN_INNER_BYTES), "underflow at {len}");
            assert!(padded <= MAX_INNER_BYTES, "overflow at {len}");
            assert!(padded >= prev, "non-monotonic at {len}: {padded} < {prev}");
            assert_eq!(padme_len(padded), padded, "not idempotent at {len}");
            if len > MIN_INNER_BYTES {
                let e = len.ilog2();
                let s = e.ilog2() + 1;
                assert!(
                    (padded - len) * (1_usize << s) < len,
                    "exceeded 1/2^{s} bound at {len}: {padded}"
                );
                // From 64 KiB ranges up to CHUNK_BYTES, s == 5 so Padmé adds < 1/32 (~3%).
                if len >= 65_536 {
                    assert!((padded - len) * 32 < len, "exceeded ~3% bound at {len}");
                }
            }
            prev = padded;
        }
    }

    #[test]
    fn the_same_plaintext_gives_the_same_object_and_only_records_compress() {
        let plain = compressible(5000);
        let one = seal(&keys(), Class::Records, &plain).expect("seals");
        let two = seal(&keys(), Class::Records, &plain).expect("seals");
        assert_eq!(one, two);
        assert!(one.object.len() < plain.len(), "records shrink");
        assert_eq!(one.flags, FLAG_ZSTD);
        assert_eq!(&one.object[..4], b"CSB4");
        assert_eq!(one.object[4], VERSION);

        let orig = seal(&keys(), Class::Originals, &plain).expect("seals");
        assert_eq!(orig.flags, 0, "originals never run zstd");
        assert!(orig.object.len() > plain.len());
        assert_ne!(one.name, orig.name);
        assert_ne!(one.digest, orig.digest);

        let thumb = seal(&keys(), Class::Thumbnails, &plain).expect("seals");
        assert_eq!(thumb.flags, 0, "thumbnails never run zstd");
        assert!(thumb.object.len() > plain.len());

        let elsewhere = seal(&BackupKeys::from_root(&[8; 32]), Class::Records, &plain).unwrap();
        assert_ne!(one.name, elsewhere.name, "names are per vault");
        assert_ne!(one.object, elsewhere.object);
    }

    #[test]
    fn a_chunk_opens_to_its_plaintext_whatever_its_size() {
        for plain in [
            Vec::new(),
            vec![1],
            compressible(100),
            incompressible(100),
            compressible(CHUNK_BYTES),
            incompressible(CHUNK_BYTES),
        ] {
            for class in Class::ALL {
                let sealed = seal(&keys(), class, &plain).expect("seals");
                assert_eq!(
                    open(&keys(), &sealed.reference(), &sealed.object).unwrap(),
                    plain
                );
                assert!(sealed.object.len() >= MIN_OBJECT_BYTES);
                assert!(sealed.object.len() <= MAX_OBJECT_BYTES);
            }
        }
        let full_media = seal(&keys(), Class::Originals, &incompressible(CHUNK_BYTES)).unwrap();
        assert_eq!(full_media.object.len(), MAX_OBJECT_BYTES);

        assert!(matches!(
            seal(&keys(), Class::Records, &vec![0; CHUNK_BYTES + 1]),
            Err(SealedError::TooLarge(_))
        ));
    }

    #[test]
    fn a_ref_round_trips() {
        let sealed = seal(&keys(), Class::Originals, b"photo").unwrap();
        let reference = sealed.reference();
        assert_eq!(Ref::decode(&reference.encode()).unwrap(), reference);
        assert!(Ref::decode(&reference.encode()[1..]).is_err());
        let mut bad = reference.encode();
        bad[68] = 9;
        assert!(Ref::decode(&bad).is_err());
    }

    fn damaged(result: Result<Vec<u8>, SealedError>) -> &'static str {
        match result {
            Err(SealedError::Damaged(why)) => why,
            other => panic!("expected damaged, got {other:?}"),
        }
    }

    #[test]
    fn every_tamper_opens_as_damaged() {
        let plain = compressible(3000);
        let sealed = seal(&keys(), Class::Records, &plain).unwrap();
        let reference = sealed.reference();

        // The digest: any flipped byte fails the reference's digest.
        let mut flipped = sealed.object.clone();
        *flipped.last_mut().unwrap() ^= 1;
        assert!(damaged(open(&keys(), &reference, &flipped)).contains("digest"));

        // A wrong recorded digest or length.
        let mut wrong = reference;
        wrong.digest = Digest::of(b"other");
        assert!(damaged(open(&keys(), &wrong, &sealed.object)).contains("digest"));
        let mut wrong = reference;
        wrong.len += 1;
        assert!(damaged(open(&keys(), &wrong, &sealed.object)).contains("length"));
        let cut = &sealed.object[..sealed.object.len() - 1];
        assert!(damaged(open(&keys(), &reference, cut)).contains("length"));

        // Outer size bounds on unreferenced opens.
        let too_short = vec![0_u8; MIN_OBJECT_BYTES - 1];
        assert!(
            damaged(open_checked(
                &keys(),
                &sealed.name,
                Class::Records,
                None,
                None,
                &too_short,
            ))
            .contains("cannot be an object")
        );
        let too_long = vec![0_u8; MAX_OBJECT_BYTES + 1];
        assert!(
            damaged(open_checked(
                &keys(),
                &sealed.name,
                Class::Records,
                None,
                None,
                &too_long,
            ))
            .contains("cannot be an object")
        );

        // Outer header fields, with the reference's digest recomputed so only the layer under test fails.
        let retarget = |mutate: &dyn Fn(&mut Vec<u8>)| {
            let mut object = sealed.object.clone();
            mutate(&mut object);
            let mut reference = reference;
            reference.digest = Digest::of(&object);
            damaged(open(&keys(), &reference, &object))
        };
        assert!(retarget(&|o| o[0] = b'X').contains("magic"));
        assert!(retarget(&|o| o[4] = 3).contains("version"));
        assert!(
            retarget(&|o| o[HEADER_BYTES] ^= 1).contains("open"),
            "a flipped outer nonce fails AEAD before the post-decrypt nonce check"
        );

        // Wrong Class fails AEAD because class is bound in AAD (not sent in the outer header).
        let mut wrong_class_ref = reference;
        wrong_class_ref.class = Class::Originals;
        assert!(
            damaged(open(&keys(), &wrong_class_ref, &sealed.object)).contains("open"),
            "class is bound in AAD"
        );

        // The name: another name asked for fails AEAD.
        let mut other = reference;
        other.name = Name::from_bytes([9; 32]);
        assert!(
            damaged(open(&keys(), &other, &sealed.object)).contains("open"),
            "the name is in the AAD"
        );

        // Unknown inner flag bit (valid AEAD and SIV nonce).
        let bad_flag = forge(&keys(), &sealed.name, 0b10, Class::Records.byte(), b"hi").unwrap();
        assert!(
            damaged(open_checked(
                &keys(),
                &sealed.name,
                Class::Records,
                None,
                None,
                &bad_flag,
            ))
            .contains("unknown flag")
        );

        // Inner class disagrees with AAD class.
        let mismatched_inner =
            build_padded_inner(0, Class::Originals.byte(), b"hi", MIN_INNER_BYTES).unwrap();
        let mismatched_obj = seal_raw_inner(
            &keys(),
            Class::Records.byte(),
            &sealed.name,
            &mismatched_inner,
        );
        assert!(
            damaged(open_checked(
                &keys(),
                &sealed.name,
                Class::Records,
                None,
                None,
                &mismatched_obj,
            ))
            .contains("class is not the one asked for")
        );

        // Declared body_len exceeds the decrypted inner frame.
        let mut bad_len_inner = vec![0_u8; MIN_INNER_BYTES];
        bad_len_inner[1] = Class::Records.byte();
        bad_len_inner[2..INNER_HEADER_BYTES].copy_from_slice(&100_u32.to_be_bytes());
        let bad_len_obj =
            seal_raw_inner(&keys(), Class::Records.byte(), &sealed.name, &bad_len_inner);
        assert!(
            damaged(open_checked(
                &keys(),
                &sealed.name,
                Class::Records,
                None,
                None,
                &bad_len_obj,
            ))
            .contains("body length cannot fit")
        );

        // A valid object for other plaintext, handed under this name.
        let forged = forge(&keys(), &sealed.name, 0, Class::Records.byte(), b"not it").unwrap();
        let mut wrong = reference;
        wrong.digest = Digest::of(&forged);
        wrong.len = u32::try_from(forged.len()).unwrap();
        assert!(damaged(open(&keys(), &wrong, &forged)).contains("not the one named"));

        // Another vault's keys.
        assert!(
            damaged(open(
                &BackupKeys::from_root(&[1; 32]),
                &reference,
                &sealed.object
            ))
            .contains("open")
        );
    }

    #[test]
    fn non_canonical_padding_length_is_refused() {
        let plain = b"ten bytes!";
        let name = name_of(&keys(), Class::Records, plain);
        // Canonical padme_len(6 + 10) is 64; pad to 72 (the next Padmé bucket) instead.
        let non_canonical = build_padded_inner(0, Class::Records.byte(), plain, 72).unwrap();
        let forged = seal_raw_inner(&keys(), Class::Records.byte(), &name, &non_canonical);
        let why = damaged(open_checked(
            &keys(),
            &name,
            Class::Records,
            Some(&Digest::of(&forged)),
            Some(u32::try_from(forged.len()).unwrap()),
            &forged,
        ));
        assert!(why.contains("padding length is not canonical"), "{why}");
    }

    #[test]
    fn non_zero_padding_byte_is_refused() {
        let plain = b"ten bytes!";
        let name = name_of(&keys(), Class::Records, plain);
        for dirty_index in [INNER_HEADER_BYTES + plain.len(), MIN_INNER_BYTES - 1] {
            let mut inner =
                build_padded_inner(0, Class::Records.byte(), plain, MIN_INNER_BYTES).unwrap();
            inner[dirty_index] = 1;
            let forged = seal_raw_inner(&keys(), Class::Records.byte(), &name, &inner);
            let why = damaged(open_checked(
                &keys(),
                &name,
                Class::Records,
                Some(&Digest::of(&forged)),
                Some(u32::try_from(forged.len()).unwrap()),
                &forged,
            ));
            assert!(why.contains("padding is not zero"), "{why}");
        }
    }

    #[test]
    fn compressed_media_classes_are_refused() {
        let plain = compressible(512);
        let compressed = zstd::bulk::compress(&plain, ZSTD_LEVEL).unwrap();
        assert!(compressed.len() < plain.len());
        for class in [Class::Thumbnails, Class::Originals] {
            let name = name_of(&keys(), class, &plain);
            let forged = forge(&keys(), &name, FLAG_ZSTD, class.byte(), &compressed).unwrap();
            let why = damaged(open_checked(
                &keys(),
                &name,
                class,
                Some(&Digest::of(&forged)),
                Some(u32::try_from(forged.len()).unwrap()),
                &forged,
            ));
            assert!(why.contains("media classes are never compressed"), "{why}");
        }
    }

    #[test]
    fn nonce_depends_on_padded_inner_and_aad() {
        let k = keys();
        let name = name_of(&k, Class::Records, b"same name");
        let aad_records = aad_of(Class::Records.byte(), &name);
        let aad_originals = aad_of(Class::Originals.byte(), &name);
        let inner_a =
            build_padded_inner(0, Class::Records.byte(), b"body A", MIN_INNER_BYTES).unwrap();
        let inner_b =
            build_padded_inner(0, Class::Records.byte(), b"body B", MIN_INNER_BYTES).unwrap();
        let inner_flagged =
            build_padded_inner(FLAG_ZSTD, Class::Records.byte(), b"body A", MIN_INNER_BYTES)
                .unwrap();

        let n_a = nonce_of(&k, &aad_records, &inner_a);
        let n_b = nonce_of(&k, &aad_records, &inner_b);
        let n_flagged = nonce_of(&k, &aad_records, &inner_flagged);
        let n_other_class = nonce_of(&k, &aad_originals, &inner_a);
        assert_ne!(
            n_a, n_b,
            "different bodies under the same name never share a nonce"
        );
        assert_ne!(n_a, n_flagged, "different inner flags never share a nonce");
        assert_ne!(
            n_a, n_other_class,
            "different AAD classes never share a nonce"
        );
    }

    #[test]
    fn a_valid_aead_object_with_a_non_derived_nonce_is_refused() {
        let k = keys();
        let plain = b"valid plaintext";
        let name = name_of(&k, Class::Records, plain);
        let aad = aad_of(Class::Records.byte(), &name);
        let padded_inner =
            build_padded_inner(0, Class::Records.byte(), plain, MIN_INNER_BYTES).unwrap();
        let mut wrong_nonce = nonce_of(&k, &aad, &padded_inner);
        wrong_nonce[0] ^= 1;

        // Encrypted with the wrong nonce so AEAD decrypt succeeds, then the
        // post-decrypt SIV nonce check must reject it.
        let forged = encrypt_inner_with_nonce(&k, &aad, wrong_nonce, &padded_inner).unwrap();
        let why = damaged(open_checked(
            &k,
            &name,
            Class::Records,
            Some(&Digest::of(&forged)),
            Some(u32::try_from(forged.len()).unwrap()),
            &forged,
        ));
        assert!(why.contains("nonce"), "{why}");
    }

    #[test]
    fn a_body_that_decompresses_past_a_chunk_is_refused() {
        let big = vec![0_u8; CHUNK_BYTES + 1000];
        let body = zstd::bulk::compress(&big, ZSTD_LEVEL).unwrap();
        let name = name_of(&keys(), Class::Records, &big);
        let object = forge(&keys(), &name, FLAG_ZSTD, Class::Records.byte(), &body).unwrap();
        let why = damaged(open_checked(
            &keys(),
            &name,
            Class::Records,
            None,
            None,
            &object,
        ));
        assert!(why.contains("decompress"), "{why}");
    }

    #[test]
    fn a_body_flagged_compressed_that_is_not_shorter_is_refused() {
        // zstd of incompressible data is longer; forcing the flag makes a non-canonical object.
        let plain = incompressible(64);
        let body = zstd::bulk::compress(&plain, ZSTD_LEVEL).unwrap();
        assert!(body.len() >= plain.len());
        let name = name_of(&keys(), Class::Records, &plain);
        let object = forge(&keys(), &name, FLAG_ZSTD, Class::Records.byte(), &body).unwrap();
        let why = damaged(open_checked(
            &keys(),
            &name,
            Class::Records,
            None,
            None,
            &object,
        ));
        assert!(why.contains("not shorter"), "{why}");
    }

    #[test]
    fn a_name_alone_opens_a_root() {
        let sealed = seal(&keys(), Class::Records, b"root").unwrap();
        assert_eq!(
            open_checked(
                &keys(),
                &sealed.name,
                Class::Records,
                None,
                None,
                &sealed.object
            )
            .unwrap(),
            b"root"
        );
    }
}
