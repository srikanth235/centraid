//! `centraid-sealed/3`: the one format every object a gateway stores wears
//! ([#1209](https://github.com/srikanth235/centraid/issues/1209), spec §2).
//!
//! Every stored object (a vault range, a tree node, a thumbnail chunk, an
//! original chunk) is **one sealed chunk** of at most [`CHUNK_BYTES`] of
//! plaintext. There are no parts, no salt and no streaming sealer: a file is
//! cut into chunks by the caller and each chunk is sealed on its own.
//!
//! ```text
//! name   = blake3_keyed(K_name, "obj3" ‖ c ‖ p)                       32 bytes
//! body   = zstd(p) if strictly shorter, else p;  flags bit0 = compressed
//! nonce  = blake3_keyed(K_nonce, name)[0..24]
//! aad    = "CSB3" ‖ u8(3) ‖ flags ‖ c ‖ name
//! object = "CSB3" ‖ u8(3) ‖ flags ‖ c ‖ nonce ‖ XChaCha20-Poly1305(K_obj, nonce, aad, body)
//! digest = blake3(object)                                            32 bytes
//! ```
//!
//! `p` is the chunk's plaintext and `c` its [`Class`] byte.
//!
//! ## SEALING IS DETERMINISTIC
//!
//! The same plaintext and class under the same vault's keys give the same
//! name, object and digest, so a chunk is rebuilt from its source rather than
//! kept, and a resend is byte-identical. The nonce is derived from the name,
//! and the name is a keyed hash of the whole plaintext, so one nonce is never
//! used for two different plaintexts; the same plaintext under the same nonce
//! is the same object, which is the point. What a gateway learns is equality
//! of chunks within one vault, which the keyed name already reveals, plus the
//! sealed length.
//!
//! ## EVERY CONSTANT HERE IS A FORMAT DECISION
//!
//! The four `derive_key` contexts, the `"obj3"` name preimage, the header
//! fields and order, the AAD, the nonce derivation, the 4 MiB chunk, the flag
//! bit and zstd level 3. `contracts/crypto/sealed3-vectors.json` pins them
//! (`tests/sealed3_vectors.rs`).
//!
//! ## WHAT OPENING REFUSES
//!
//! [`open`] runs the strict procedure and any failure is [`SealedError::Damaged`]
//! in one of its named forms: a length other than the reference's, a digest
//! that is not the object's, a bad magic or version, an unknown flag, a class
//! other than the one asked for, a name in the header's AAD other than the
//! one asked for, a nonce other than the derived one, a failed tag, a
//! decompression past [`CHUNK_BYTES`], a body flagged compressed that is not
//! shorter than the plaintext, and a plaintext whose recomputed name is not
//! the one the object was asked for.

use std::fmt;
use std::str::FromStr;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};

/// The format's name, as a vector file spells it.
pub const FORMAT_NAME: &str = "centraid-sealed/3";

/// The four bytes every object starts with.
pub const MAGIC: [u8; 4] = *b"CSB3";

/// The version byte after the magic.
pub const VERSION: u8 = 3;

/// The clear header: magic, version, flags, class.
pub const HEADER_BYTES: usize = 4 + 1 + 1 + 1;

/// XChaCha20's nonce.
pub const NONCE_BYTES: usize = 24;

/// Poly1305's tag.
pub const TAG_BYTES: usize = 16;

/// What sealing adds to a chunk's body: header, nonce and tag.
pub const OVERHEAD_BYTES: usize = HEADER_BYTES + NONCE_BYTES + TAG_BYTES;

/// **R2: a chunk is at most 4 MiB of plaintext.**
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// The largest sealed object a 4 MiB chunk makes (the gateway's cap).
pub const MAX_OBJECT_BYTES: usize = CHUNK_BYTES + OVERHEAD_BYTES;

/// Flag bit 0: the body is zstd.
pub const FLAG_ZSTD: u8 = 0b0000_0001;

/// zstd level; the crate is pinned exactly so output never drifts.
pub const ZSTD_LEVEL: i32 = 3;

const ROOT_CONTEXT: &str = "centraid backup v2 root";
const NAME_CONTEXT: &str = "centraid backup v2 name";
const OBJECT_CONTEXT: &str = "centraid backup v3 object";
const NONCE_CONTEXT: &str = "centraid backup v3 nonce";
const NAME_PREIMAGE: &[u8; 4] = b"obj3";

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
    /// `K_obj = derive_key("centraid backup v3 object", K_backup)` and
    /// `K_nonce = derive_key("centraid backup v3 nonce", K_backup)`.
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

/// An object's name: `blake3_keyed(K_name, "obj3" ‖ c ‖ p)`.
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
    pub object: Vec<u8>,
}

impl fmt::Debug for Sealed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Sealed")
            .field("name", &self.name)
            .field("class", &self.class)
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

/// `name = blake3_keyed(K_name, "obj3" ‖ c ‖ p)`.
#[must_use]
pub fn name_of(keys: &BackupKeys, class: Class, plaintext: &[u8]) -> Name {
    let mut hasher = blake3::Hasher::new_keyed(keys.k_name());
    hasher.update(NAME_PREIMAGE);
    hasher.update(&[class.byte()]);
    hasher.update(plaintext);
    Name(*hasher.finalize().as_bytes())
}

fn nonce_of(keys: &BackupKeys, name: &Name) -> [u8; NONCE_BYTES] {
    let full = blake3::keyed_hash(keys.k_nonce(), name.as_bytes());
    let mut nonce = [0_u8; NONCE_BYTES];
    nonce.copy_from_slice(&full.as_bytes()[..NONCE_BYTES]);
    nonce
}

fn aad_of(flags: u8, class: u8, name: &Name) -> [u8; 39] {
    let mut aad = [0_u8; 39];
    aad[..4].copy_from_slice(&MAGIC);
    aad[4] = VERSION;
    aad[5] = flags;
    aad[6] = class;
    aad[7..].copy_from_slice(name.as_bytes());
    aad
}

/// Frame `body` as an object under `name`, `flags` and `class`: the part of
/// sealing after the body is chosen. Public to the crate's tests only.
fn frame(
    keys: &BackupKeys,
    name: &Name,
    flags: u8,
    class: u8,
    body: &[u8],
) -> Result<Vec<u8>, SealedError> {
    let nonce = nonce_of(keys, name);
    let cipher = XChaCha20Poly1305::new(&Key::from(*keys.k_obj()));
    let aad = aad_of(flags, class, name);
    let sealed = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: body,
                aad: &aad,
            },
        )
        .map_err(|_| SealedError::Seal)?;
    let mut object = Vec::with_capacity(HEADER_BYTES + NONCE_BYTES + sealed.len());
    object.extend_from_slice(&MAGIC);
    object.push(VERSION);
    object.push(flags);
    object.push(class);
    object.extend_from_slice(&nonce);
    object.extend_from_slice(&sealed);
    Ok(object)
}

/// Seal one chunk.
///
/// # Errors
/// [`SealedError::TooLarge`] past [`CHUNK_BYTES`].
pub fn seal(keys: &BackupKeys, class: Class, plaintext: &[u8]) -> Result<Sealed, SealedError> {
    if plaintext.len() > CHUNK_BYTES {
        return Err(SealedError::TooLarge(plaintext.len()));
    }
    let name = name_of(keys, class, plaintext);
    let compressed = zstd::bulk::compress(plaintext, ZSTD_LEVEL).map_err(|_| SealedError::Seal)?;
    let (flags, body): (u8, &[u8]) = if compressed.len() < plaintext.len() {
        (FLAG_ZSTD, &compressed)
    } else {
        (0, plaintext)
    };
    let object = frame(keys, &name, flags, class.byte(), body)?;
    Ok(Sealed {
        name,
        digest: Digest::of(&object),
        class,
        object,
    })
}

/// Open an object **strictly**: the reference's length and digest, the
/// header, the class, the derived nonce, the tag over the AAD naming `name`,
/// a bounded decompression, and a recomputed name that equals `name`.
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
    if object.len() < OVERHEAD_BYTES || object.len() > MAX_OBJECT_BYTES {
        return Err(SealedError::Damaged("its length cannot be an object"));
    }
    if object[..4] != MAGIC {
        return Err(SealedError::Damaged("the magic is wrong"));
    }
    if object[4] != VERSION {
        return Err(SealedError::Damaged("the version is not 3"));
    }
    let flags = object[5];
    if flags & !FLAG_ZSTD != 0 {
        return Err(SealedError::Damaged("it sets an unknown flag"));
    }
    if object[6] != class.byte() {
        return Err(SealedError::Damaged("its class is not the one asked for"));
    }
    let nonce = &object[HEADER_BYTES..HEADER_BYTES + NONCE_BYTES];
    if nonce != nonce_of(keys, name) {
        return Err(SealedError::Damaged("its nonce is not the derived one"));
    }
    let cipher = XChaCha20Poly1305::new(&Key::from(*keys.k_obj()));
    let aad = aad_of(flags, object[6], name);
    let body = cipher
        .decrypt(
            &XNonce::from(
                <[u8; NONCE_BYTES]>::try_from(nonce)
                    .map_err(|_| SealedError::Damaged("its nonce is cut short"))?,
            ),
            Payload {
                msg: &object[HEADER_BYTES + NONCE_BYTES..],
                aad: &aad,
            },
        )
        .map_err(|_| SealedError::Damaged("it does not open"))?;
    let plaintext = if flags & FLAG_ZSTD == 0 {
        body
    } else {
        let plain = zstd::bulk::decompress(&body, CHUNK_BYTES)
            .map_err(|_| SealedError::Damaged("its body does not decompress within a chunk"))?;
        if body.len() >= plain.len() {
            return Err(SealedError::Damaged(
                "it is flagged compressed but is not shorter",
            ));
        }
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

    #[test]
    fn the_same_plaintext_gives_the_same_object_and_another_class_does_not() {
        let plain = compressible(5000);
        let one = seal(&keys(), Class::Records, &plain).expect("seals");
        let two = seal(&keys(), Class::Records, &plain).expect("seals");
        assert_eq!(one, two);
        assert!(one.object.len() < plain.len(), "compressible bytes shrink");
        assert_eq!(one.object[5] & FLAG_ZSTD, FLAG_ZSTD);
        let other = seal(&keys(), Class::Originals, &plain).expect("seals");
        assert_ne!(one.name, other.name);
        assert_ne!(one.digest, other.digest);
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
            let sealed = seal(&keys(), Class::Thumbnails, &plain).expect("seals");
            assert_eq!(
                open(&keys(), &sealed.reference(), &sealed.object).unwrap(),
                plain
            );
            assert!(sealed.object.len() <= MAX_OBJECT_BYTES);
        }
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

        // Header fields, with the reference's digest recomputed so only the layer under test fails.
        let retarget = |mutate: &dyn Fn(&mut Vec<u8>)| {
            let mut object = sealed.object.clone();
            mutate(&mut object);
            let mut reference = reference;
            reference.digest = Digest::of(&object);
            damaged(open(&keys(), &reference, &object))
        };
        assert!(retarget(&|o| o[0] = b'X').contains("magic"));
        assert!(retarget(&|o| o[4] = 2).contains("version"));
        assert!(retarget(&|o| o[5] |= 0b10).contains("unknown flag"));
        assert!(
            retarget(&|o| o[5] ^= FLAG_ZSTD).contains("open"),
            "the flag is in the AAD"
        );
        assert!(retarget(&|o| o[6] = Class::Originals.byte()).contains("class"));
        assert!(retarget(&|o| o[HEADER_BYTES] ^= 1).contains("nonce"));

        // The name: another name asked for.
        let mut other = reference;
        other.name = Name::from_bytes([9; 32]);
        assert!(damaged(open(&keys(), &other, &sealed.object)).contains("nonce"));

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
            .contains("nonce")
        );
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
