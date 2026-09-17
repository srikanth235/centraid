//! `centraid-object/1` — the one format every object wears (#1029 §4).
//!
//! One format replaces the v0-derived frame seal, the WAL-segment seal and the
//! manifest seal. A base page range, a spool segment, a manifest, an original, a
//! thumbnail and a pack are all the same bytes in the same shape, differing only
//! by the [`Kind`] in the header.
//!
//! ```text
//! ┌──────────────────────── header (plaintext, AAD of every chunk) ────────────┐
//! │ CNOB │1│kind│role│flags│ salt (16) │ dictionary id (32) │ wrap len │ wrap │
//! └───────────────────────────────────────────────────────────────────────────┘
//! ┌──────────────────────── body: a chunked AEAD stream ──────────────────────┐
//! │ nonce(24) │ len(4) │ ciphertext ‖ tag │  … repeated, 4 MiB of plaintext …  │
//! └───────────────────────────────────────────────────────────────────────────┘
//! ```
//!
//! ## THE FOUR THINGS THIS FORMAT EXISTS TO FIX
//!
//! **1. The header does not carry the plaintext hash.** The format this replaces
//! wrote it in the clear at bytes 5..37 of every object — a confirmable
//! commitment to the content, on the outside of the envelope. Here the object's
//! **name is the BLAKE3 of its own ciphertext** ([`ObjectName::of`]), which a
//! reader computes from bytes it already holds. See [`header`] for the long form.
//!
//! **2. Every nonce is random (B9).** The format this replaces derived its
//! AES-GCM nonce from a keyed MAC over the object's ADDRESS, which is safe only
//! if one address always maps to one set of bytes — and it did not, so the old
//! stack had nonce reuse under a single key. Here each nonce is 24 bytes from
//! [`rand::rngs::OsRng`] at seal time and written down beside its chunk. An
//! object is sealed **once** and the same ciphertext is re-sent on every retry,
//! so a retry is a re-upload and never a re-seal. `tests/object.rs` asserts no
//! nonce repeats across retries **or across process restarts**.
//!
//! **3. A header cannot be transplanted.** The key wrap's AAD carries kind and
//! role — the same construction `centraid_identity::sealed_box` uses, with the
//! same length-prefixed encoding, so `kind = "ab", role = "c"` is not
//! `kind = "a", role = "bc"` — and every header additionally carries 16 random
//! bytes of [`SALT_BYTES`] salt, so two objects of the SAME kind and role do not
//! share a header either. [`header`] says why the second half is needed.
//!
//! **4. Sizes are bounded, not exact.** The plaintext of a compressing kind is
//! zstd'd against a **trained dictionary named in the header** ([`dict`]) and
//! then padded with **Padmé** ([`pad`]), which bounds the compression size-class
//! leak and does not remove it. [`pad`]'s header says exactly what that means.
//!
//! ## THE CAP, AND WHAT A BIGGER INPUT BECOMES
//!
//! Every object is at most [`MAX_OBJECT_BYTES`] (F6), so there is one upload
//! path and no multipart: resumability comes from the **list**, not from the
//! transport. [`seal_list`] splits a larger input into parts of at most
//! [`MAX_PLAINTEXT_BYTES`], each an ordinary object of the caller's own kind,
//! and returns the ordered [`ObjectList`] of their names. **The vault is the
//! index**: that ordered list is recorded there, exactly as a pack's
//! `(object, offset, length)` rows are ([`pack`]) — the same machinery, so there
//! are no separate index files and no index that grows with the backup in
//! memory.
//!
//! ## WHAT THIS MODULE DOES NOT DO
//!
//! It moves bytes. It does not decide when to capture, what a generation is,
//! when to repack or what a share may reference — those are §2, §3 and W8. The
//! one place it names a policy it does not own is [`pack::LiveShareIndex`],
//! which is a seam, not an implementation.

pub mod dict;
pub mod header;
pub mod pack;
pub mod pad;

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305};

pub use dict::Dictionary;
pub use header::{FORMAT_NAME, FORMAT_VERSION, HEADER_MAGIC, Header, Kind, Role, SALT_BYTES};

/// Every object is at most 16 MiB (F6).
pub const MAX_OBJECT_BYTES: usize = 16 * 1024 * 1024;

/// The most plaintext one object carries.
///
/// The headroom between this and [`MAX_OBJECT_BYTES`] is not a guess: zstd can
/// **expand** incompressible input by about `len/128 + 64` bytes, Padmé can add
/// up to ~12%, and the chunk framing adds 44 bytes per 4 MiB. 14 MiB of
/// incompressible bytes therefore seals to under 15 MiB, and
/// `tests/object.rs::the_cap_holds_for_the_worst_case_input` proves it with
/// random bytes rather than arithmetic.
pub const MAX_PLAINTEXT_BYTES: usize = 14 * 1024 * 1024;

/// The STREAM chunk, in plaintext bytes (#1029 §4).
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// XChaCha20-Poly1305's nonce. 24 bytes is what makes "draw it at random" a
/// design rather than a hope: the collision probability over every object a
/// phone will ever write is negligible without any counter to keep.
pub const NONCE_BYTES: usize = 24;

/// Poly1305's tag.
pub const TAG_BYTES: usize = 16;

/// A content key, and the key-wrap key derived from the vault root.
pub const KEY_BYTES: usize = 32;

/// `plaintext_len ‖ payload_len`, the two big-endian `u64`s Padmé pads around.
const FRAME_PREFIX_BYTES: usize = 16;

/// The result of anything in this module.
pub type ObjectResult<T> = Result<T, ObjectError>;

/// What sealing and opening refuse.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ObjectError {
    /// The bytes are not a well-formed object, and this says which part.
    #[error("not a centraid-object: {reason}")]
    Malformed {
        /// What was wrong with the bytes.
        reason: &'static str,
    },
    /// A format version this reader does not implement.
    #[error("centraid-object version {0} is not this reader's")]
    UnsupportedVersion(u8),
    /// The kind byte names no kind.
    #[error("byte {0} names no object kind")]
    UnknownKind(u8),
    /// The role byte names no role.
    #[error("byte {0} names no object role")]
    UnknownRole(u8),
    /// The key, the associated data or the tag. **Deliberately one variant**:
    /// telling a caller which half of its guess was wrong is telling an
    /// attacker which half to keep — the same reasoning as
    /// `centraid_identity::sealed_box::SealError::Open`.
    #[error("this object does not open with this key and this header")]
    Open,
    /// The AEAD refused to seal.
    #[error("sealing failed")]
    Seal,
    /// The operating system would not give entropy. **Never a fallback**: a
    /// predictable nonce is the defect this format exists to close, so this is
    /// an error and not a quieter generator.
    #[error("the operating system would not give entropy for a nonce: {0}")]
    Entropy(String),
    /// The object would exceed [`MAX_OBJECT_BYTES`], or the plaintext
    /// [`MAX_PLAINTEXT_BYTES`]. Use [`seal_list`].
    #[error("an object holds at most {MAX_OBJECT_BYTES} bytes and this one needs {0}")]
    TooLarge(usize),
    /// A compressing kind was handed no dictionary.
    #[error("a compressing kind must be sealed against a trained dictionary")]
    DictionaryRequired,
    /// The dictionary supplied is not the one the header names.
    #[error("this object was sealed against dictionary {expected} and {given} was supplied")]
    DictionaryMismatch {
        /// The id in the header, hex.
        expected: String,
        /// The id of the dictionary the caller passed, hex.
        given: String,
    },
    /// A dictionary with no bytes.
    #[error("a dictionary with no bytes is not a dictionary")]
    EmptyDictionary,
    /// zstd could not train.
    #[error("zstd dictionary training failed: {0}")]
    DictionaryTraining(String),
    /// zstd could not compress or decompress.
    #[error("zstd failed: {0}")]
    Compression(String),
    /// A read-back disagreed with what was sealed — storage corruption, caught
    /// before the bytes reach the backup (F11).
    #[error("this object read back from disk is not the object that was sealed")]
    ReadBackMismatch,
    /// The pack is referenced by a live share (F8).
    #[error("this pack is referenced by a live share and is never repacked")]
    PackIsShared,
    /// The pack's trailer or item table does not describe these bytes.
    #[error("the pack's item table does not describe these bytes: {reason}")]
    PackTable {
        /// What was wrong.
        reason: &'static str,
    },
}

/// An object's name: the **BLAKE3 of its ciphertext bytes**.
///
/// Not of its plaintext. A name that is a plaintext hash is a commitment
/// anybody holding the store can test guesses against; a name that is a
/// ciphertext hash is derivable by every party that has the bytes and by no
/// party that does not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ObjectName([u8; 32]);

impl ObjectName {
    /// Name a sealed object.
    #[must_use]
    pub fn of(sealed: &[u8]) -> Self {
        Self(*blake3::hash(sealed).as_bytes())
    }

    /// Adopt a name read back out of a pack's item table.
    #[must_use]
    pub const fn from_raw(name: [u8; 32]) -> Self {
        Self(name)
    }

    /// The raw name.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// The name as it is written down.
    #[must_use]
    pub fn hex(&self) -> String {
        hex::encode(self.0)
    }
}

/// Where the key that opens this object lives.
///
/// The two arms are §4's two cases and there is no third: `base`, `segment`,
/// `manifest` and a pack's item table carry a [`Custody::Wrapped`] key, and a
/// `blob` or `thumbnail` carries none because its file key is a row in the
/// vault's blob custody — which is what lets one uploaded photo be shared with
/// ten people by handing out that key.
#[derive(Debug, Clone, Copy)]
pub enum Custody<'a> {
    /// Wrap the object key into the header under the vault root key.
    Wrapped(&'a [u8; KEY_BYTES]),
    /// The object key is the file key, held in the vault. The header carries no
    /// wrap at all.
    FileKey(&'a [u8; KEY_BYTES]),
}

/// What to seal, and how.
#[derive(Debug, Clone, Copy)]
pub struct SealOptions<'a> {
    /// What the object is.
    pub kind: Kind,
    /// What the key opens.
    pub role: Role,
    /// The trained dictionary, required for a [`Kind::compresses`] kind and
    /// ignored for the rest.
    pub dictionary: Option<&'a Dictionary>,
}

/// A sealed object, its name, and the plaintext hash the vault keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    /// The bytes to write and upload.
    pub bytes: Vec<u8>,
    /// BLAKE3 of [`Sealed::bytes`].
    pub name: ObjectName,
    /// BLAKE3 of the plaintext. **This never goes into the object** — it is
    /// what the phone deduplicates on and what [`verify_read_back`] checks, and
    /// it lives in the vault, which is itself encrypted.
    pub plaintext_hash: [u8; 32],
}

/// Seal one object.
///
/// # Errors
/// [`ObjectError::TooLarge`] past [`MAX_PLAINTEXT_BYTES`] — use [`seal_list`];
/// [`ObjectError::DictionaryRequired`] for a compressing kind with no
/// dictionary; [`ObjectError::Entropy`] when the operating system will not give
/// a nonce; [`ObjectError::Seal`] or [`ObjectError::Compression`] otherwise.
pub fn seal(
    custody: Custody<'_>,
    options: &SealOptions<'_>,
    plaintext: &[u8],
) -> ObjectResult<Sealed> {
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(ObjectError::TooLarge(plaintext.len()));
    }

    let compress = options.kind.compresses();
    let dictionary = match (compress, options.dictionary) {
        (true, None) => return Err(ObjectError::DictionaryRequired),
        (true, Some(dictionary)) => Some(dictionary),
        (false, _) => None,
    };
    let payload = match dictionary {
        Some(dictionary) => dictionary.compress(plaintext)?,
        None => plaintext.to_vec(),
    };

    let (content_key, wrapped_key) = match custody {
        Custody::Wrapped(root) => {
            let content_key = random_bytes::<KEY_BYTES>()?;
            let wrapped = wrap_key(root, options.kind, options.role, &content_key)?;
            (content_key, wrapped)
        }
        Custody::FileKey(file_key) => (*file_key, Vec::new()),
    };

    let header = Header {
        kind: options.kind,
        role: options.role,
        compressed: dictionary.is_some(),
        salt: random_bytes::<{ header::SALT_BYTES }>()?,
        dictionary_id: dictionary.map_or([0_u8; 32], |dictionary| *dictionary.id()),
        wrapped_key,
    };
    let header_bytes = header.encode();

    let mut bytes = header_bytes.clone();
    seal_body(
        &content_key,
        &header_bytes,
        &pad_frame(plaintext.len(), &payload),
        &mut bytes,
    )?;
    if bytes.len() > MAX_OBJECT_BYTES {
        return Err(ObjectError::TooLarge(bytes.len()));
    }

    Ok(Sealed {
        name: ObjectName::of(&bytes),
        plaintext_hash: *blake3::hash(plaintext).as_bytes(),
        bytes,
    })
}

/// Open one object.
///
/// `dictionary` is required exactly when the header says the body is
/// compressed, and its id must be the one the header names.
///
/// # Errors
/// [`ObjectError::Open`] for the key, the associated data or any tag;
/// [`ObjectError::DictionaryMismatch`] or [`ObjectError::DictionaryRequired`]
/// for the dictionary; [`ObjectError::Malformed`] for the framing.
pub fn open(
    custody: Custody<'_>,
    sealed: &[u8],
    dictionary: Option<&Dictionary>,
) -> ObjectResult<Vec<u8>> {
    let (header, body_at) = Header::decode(sealed)?;
    let header_bytes = &sealed[..body_at];

    let content_key = match custody {
        Custody::Wrapped(root) => unwrap_key(root, header.kind, header.role, &header.wrapped_key)?,
        Custody::FileKey(file_key) => {
            if !header.wrapped_key.is_empty() {
                // A file-key object that carries a wrap is a header from some
                // other object, glued on.
                return Err(ObjectError::Open);
            }
            *file_key
        }
    };

    let padded = open_body(&content_key, header_bytes, &sealed[body_at..])?;
    let (plaintext_len, payload) = unpad_frame(&padded)?;

    if !header.compressed {
        if payload.len() != plaintext_len {
            return Err(ObjectError::Malformed {
                reason: "an uncompressed payload disagrees with its declared length",
            });
        }
        return Ok(payload.to_vec());
    }

    let dictionary = dictionary.ok_or(ObjectError::DictionaryRequired)?;
    if dictionary.id() != &header.dictionary_id {
        return Err(ObjectError::DictionaryMismatch {
            expected: hex::encode(header.dictionary_id),
            given: hex::encode(dictionary.id()),
        });
    }
    let plain = dictionary.decompress(payload, plaintext_len)?;
    if plain.len() != plaintext_len {
        return Err(ObjectError::Malformed {
            reason: "the decompressed payload disagrees with its declared length",
        });
    }
    Ok(plain)
}

/// **Verify before upload (F11).** Read the sealed object back from disk and
/// check it against what was sealed, before it goes anywhere.
///
/// Both halves matter. The name catches a byte the filesystem dropped or
/// reordered; opening and re-hashing catches the case where the corruption
/// happened *before* the write, between the plaintext and the buffer — which a
/// name over the same corrupted buffer would happily confirm.
///
/// # Errors
/// [`ObjectError::ReadBackMismatch`], or whatever [`open`] refused.
pub fn verify_read_back(
    custody: Custody<'_>,
    sealed: &Sealed,
    from_disk: &[u8],
    dictionary: Option<&Dictionary>,
) -> ObjectResult<()> {
    if ObjectName::of(from_disk) != sealed.name {
        return Err(ObjectError::ReadBackMismatch);
    }
    let plain = open(custody, from_disk, dictionary)?;
    if blake3::hash(&plain).as_bytes() != &sealed.plaintext_hash {
        return Err(ObjectError::ReadBackMismatch);
    }
    Ok(())
}

/// The ordered parts an oversized input became.
///
/// The vault records this, exactly as it records a pack's
/// `(object, offset, length)` rows. There is no index object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectList {
    /// The parts, in order. Order is the whole of the structure.
    pub parts: Vec<ObjectName>,
    /// The plaintext length the parts reassemble to.
    pub plaintext_bytes: u64,
}

/// Seal an input of any size as a list of objects (F6).
///
/// Every part is an ordinary object of the caller's own kind — §4's "an
/// original larger than 16 MiB is a list of `blob` objects" — so nothing
/// downstream has a second format to read. An input that already fits produces
/// a one-part list, so a caller never branches on size.
///
/// # Errors
/// Whatever [`seal`] refused for a part.
pub fn seal_list(
    custody: Custody<'_>,
    options: &SealOptions<'_>,
    plaintext: &[u8],
) -> ObjectResult<(Vec<Sealed>, ObjectList)> {
    let mut sealed = Vec::new();
    let mut parts = Vec::new();
    // `chunks` on an empty slice yields nothing, and an empty input is still
    // one (empty) object rather than a list of none.
    for part in plaintext
        .chunks(MAX_PLAINTEXT_BYTES)
        .chain(std::iter::once(&plaintext[..0]).take(usize::from(plaintext.is_empty())))
    {
        let one = seal(custody, options, part)?;
        parts.push(one.name);
        sealed.push(one);
    }
    Ok((
        sealed,
        ObjectList {
            parts,
            plaintext_bytes: plaintext.len() as u64,
        },
    ))
}

/// Reassemble what [`seal_list`] split, checking each part against the list.
///
/// # Errors
/// [`ObjectError::Malformed`] when the bytes handed over are not the listed
/// parts in the listed order; otherwise whatever [`open`] refused.
pub fn open_list(
    custody: Custody<'_>,
    list: &ObjectList,
    parts: &[&[u8]],
    dictionary: Option<&Dictionary>,
) -> ObjectResult<Vec<u8>> {
    if parts.len() != list.parts.len() {
        return Err(ObjectError::Malformed {
            reason: "the parts handed over are not the parts the list names",
        });
    }
    let mut out = Vec::new();
    for (bytes, name) in parts.iter().zip(&list.parts) {
        if &ObjectName::of(bytes) != name {
            return Err(ObjectError::Malformed {
                reason: "a part is not the object the list names, or is out of order",
            });
        }
        out.extend_from_slice(&open(custody, bytes, dictionary)?);
    }
    if out.len() as u64 != list.plaintext_bytes {
        return Err(ObjectError::Malformed {
            reason: "the reassembled parts are not the length the list claims",
        });
    }
    Ok(out)
}

// ------------------------------------------------------------- internals ----

/// `N` bytes from the operating system. The one source of every nonce and every
/// content key in this format (B9).
pub(crate) fn random_bytes<const N: usize>() -> ObjectResult<[u8; N]> {
    use rand::TryRngCore as _;

    let mut bytes = [0_u8; N];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|error| ObjectError::Entropy(error.to_string()))?;
    Ok(bytes)
}

/// The key-wrap AAD: the format's name, the kind and the role, each
/// length-prefixed.
///
/// Length-prefixed rather than delimited, for the reason
/// `centraid_identity::sealed_box` gives: a delimiter can appear inside a kind
/// or a role and a length cannot, so `kind = "ab", role = "c"` and
/// `kind = "a", role = "bc"` are different associated data.
fn wrap_aad(kind: Kind, role: Role) -> Vec<u8> {
    let mut out = Vec::new();
    for field in [FORMAT_NAME, kind.as_str(), role.as_str()] {
        let bytes = field.as_bytes();
        out.extend_from_slice(&u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

/// The wrap key, derived from the vault root so the root itself is never an
/// AEAD key. **`blake3::derive_key`** — ONE HASH, and the context string is the
/// domain separator.
fn wrap_key_from_root(root: &[u8; KEY_BYTES]) -> [u8; KEY_BYTES] {
    blake3::derive_key("centraid-object/1 vault-root key wrap", root)
}

fn wrap_key(
    root: &[u8; KEY_BYTES],
    kind: Kind,
    role: Role,
    content_key: &[u8; KEY_BYTES],
) -> ObjectResult<Vec<u8>> {
    let nonce = random_bytes::<NONCE_BYTES>()?;
    let cipher = XChaCha20Poly1305::new_from_slice(&wrap_key_from_root(root))
        .map_err(|_| ObjectError::Seal)?;
    let body = cipher
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: content_key,
                aad: &wrap_aad(kind, role),
            },
        )
        .map_err(|_| ObjectError::Seal)?;
    let mut out = Vec::with_capacity(NONCE_BYTES + body.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&body);
    Ok(out)
}

fn unwrap_key(
    root: &[u8; KEY_BYTES],
    kind: Kind,
    role: Role,
    wrapped: &[u8],
) -> ObjectResult<[u8; KEY_BYTES]> {
    if wrapped.len() != NONCE_BYTES + KEY_BYTES + TAG_BYTES {
        return Err(ObjectError::Malformed {
            reason: "the wrapped key is not a nonce, a key and a tag",
        });
    }
    let nonce: [u8; NONCE_BYTES] =
        wrapped[..NONCE_BYTES]
            .try_into()
            .map_err(|_| ObjectError::Malformed {
                reason: "the wrapped key has no nonce",
            })?;
    let cipher = XChaCha20Poly1305::new_from_slice(&wrap_key_from_root(root))
        .map_err(|_| ObjectError::Open)?;
    let plain = cipher
        .decrypt(
            (&nonce).into(),
            Payload {
                msg: &wrapped[NONCE_BYTES..],
                aad: &wrap_aad(kind, role),
            },
        )
        .map_err(|_| ObjectError::Open)?;
    plain.try_into().map_err(|_| ObjectError::Open)
}

/// `plaintext_len ‖ payload_len ‖ payload ‖ 0x00…`, padded to its Padmé bucket.
///
/// Both lengths go **inside** the encryption. Putting the plaintext length in
/// the header would hand back everything Padmé just bought.
fn pad_frame(plaintext_len: usize, payload: &[u8]) -> Vec<u8> {
    let unpadded = FRAME_PREFIX_BYTES + payload.len();
    let padded = pad::padme(unpadded as u64) as usize;
    let mut out = Vec::with_capacity(padded);
    out.extend_from_slice(&(plaintext_len as u64).to_be_bytes());
    out.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    out.extend_from_slice(payload);
    out.resize(padded, 0);
    out
}

/// Read the frame back, refusing padding that is not zeros.
///
/// The padding is inside the AEAD, so nobody can change it without breaking a
/// tag — but the sealer is the only writer and it writes zeros, so a non-zero
/// byte means either a bug here or a covert channel somebody added. Refusing is
/// cheap and leaves neither possibility open.
fn unpad_frame(padded: &[u8]) -> ObjectResult<(usize, &[u8])> {
    if padded.len() < FRAME_PREFIX_BYTES {
        return Err(ObjectError::Malformed {
            reason: "the padded frame is shorter than its own length prefix",
        });
    }
    let plaintext_len =
        u64::from_be_bytes(padded[..8].try_into().map_err(|_| ObjectError::Malformed {
            reason: "frame prefix",
        })?);
    let payload_len =
        u64::from_be_bytes(
            padded[8..16]
                .try_into()
                .map_err(|_| ObjectError::Malformed {
                    reason: "frame prefix",
                })?,
        );
    let payload_len = usize::try_from(payload_len).map_err(|_| ObjectError::Malformed {
        reason: "the payload length does not fit this machine",
    })?;
    let plaintext_len = usize::try_from(plaintext_len).map_err(|_| ObjectError::Malformed {
        reason: "the plaintext length does not fit this machine",
    })?;
    let end = FRAME_PREFIX_BYTES
        .checked_add(payload_len)
        .ok_or(ObjectError::Malformed {
            reason: "the payload length overflows the frame",
        })?;
    if end > padded.len() {
        return Err(ObjectError::Malformed {
            reason: "the payload runs past the padded frame",
        });
    }
    if pad::padme(end as u64) as usize != padded.len() {
        return Err(ObjectError::Malformed {
            reason: "the frame is not padded to its Padmé bucket",
        });
    }
    if padded[end..].iter().any(|byte| *byte != 0) {
        return Err(ObjectError::Malformed {
            reason: "the padding is not zeros",
        });
    }
    Ok((plaintext_len, &padded[FRAME_PREFIX_BYTES..end]))
}

/// The chunk AAD: the whole header, then the index, then whether this is the
/// last chunk.
///
/// The index is what refuses a reordering and the final flag is what refuses a
/// truncation — a reader decides `final` from "are there bytes after this
/// chunk", so cutting the tail makes the new last chunk open with `final = 1`
/// against a tag computed with `final = 0`.
fn chunk_aad(header_bytes: &[u8], index: u32, final_chunk: bool) -> Vec<u8> {
    let mut aad = Vec::with_capacity(header_bytes.len() + 5);
    aad.extend_from_slice(header_bytes);
    aad.extend_from_slice(&index.to_be_bytes());
    aad.push(u8::from(final_chunk));
    aad
}

fn seal_body(
    content_key: &[u8; KEY_BYTES],
    header_bytes: &[u8],
    padded: &[u8],
    into: &mut Vec<u8>,
) -> ObjectResult<()> {
    let cipher = XChaCha20Poly1305::new_from_slice(content_key).map_err(|_| ObjectError::Seal)?;
    let chunk_count = padded.len().div_ceil(CHUNK_BYTES).max(1);
    for index in 0..chunk_count {
        let start = index * CHUNK_BYTES;
        let chunk = &padded[start.min(padded.len())..((start + CHUNK_BYTES).min(padded.len()))];
        let nonce = random_bytes::<NONCE_BYTES>()?;
        let index32 = u32::try_from(index).map_err(|_| ObjectError::Seal)?;
        let body = cipher
            .encrypt(
                (&nonce).into(),
                Payload {
                    msg: chunk,
                    aad: &chunk_aad(header_bytes, index32, index + 1 == chunk_count),
                },
            )
            .map_err(|_| ObjectError::Seal)?;
        into.extend_from_slice(&nonce);
        into.extend_from_slice(
            &u32::try_from(body.len())
                .map_err(|_| ObjectError::Seal)?
                .to_be_bytes(),
        );
        into.extend_from_slice(&body);
    }
    Ok(())
}

fn open_body(
    content_key: &[u8; KEY_BYTES],
    header_bytes: &[u8],
    body: &[u8],
) -> ObjectResult<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new_from_slice(content_key).map_err(|_| ObjectError::Open)?;
    let mut out = Vec::new();
    let mut at = 0_usize;
    let mut index = 0_u32;
    while at < body.len() {
        let framed = at
            .checked_add(NONCE_BYTES + 4)
            .ok_or(ObjectError::Malformed {
                reason: "chunk framing",
            })?;
        if framed > body.len() {
            return Err(ObjectError::Malformed {
                reason: "a chunk header runs past the object",
            });
        }
        let nonce: [u8; NONCE_BYTES] =
            body[at..at + NONCE_BYTES]
                .try_into()
                .map_err(|_| ObjectError::Malformed {
                    reason: "chunk nonce",
                })?;
        let length =
            u32::from_be_bytes(body[at + NONCE_BYTES..framed].try_into().map_err(|_| {
                ObjectError::Malformed {
                    reason: "chunk length",
                }
            })?) as usize;
        if length < TAG_BYTES || length > CHUNK_BYTES + TAG_BYTES {
            return Err(ObjectError::Malformed {
                reason: "a chunk claims a length no chunk can have",
            });
        }
        let end = framed.checked_add(length).ok_or(ObjectError::Malformed {
            reason: "chunk framing",
        })?;
        if end > body.len() {
            return Err(ObjectError::Malformed {
                reason: "a chunk runs past the object",
            });
        }
        let plain = cipher
            .decrypt(
                (&nonce).into(),
                Payload {
                    msg: &body[framed..end],
                    aad: &chunk_aad(header_bytes, index, end == body.len()),
                },
            )
            .map_err(|_| ObjectError::Open)?;
        out.extend_from_slice(&plain);
        at = end;
        index = index.checked_add(1).ok_or(ObjectError::Open)?;
    }
    if index == 0 {
        return Err(ObjectError::Malformed {
            reason: "an object has at least one chunk",
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: [u8; 32] = [3_u8; 32];

    fn dictionary() -> Dictionary {
        let owned: Vec<Vec<u8>> = (0..64_u32)
            .map(|row| format!("core_content_item|content_id={row}|byte_size={row}|").into_bytes())
            .collect();
        let refs: Vec<&[u8]> = owned.iter().map(Vec::as_slice).collect();
        Dictionary::train(&refs, 4 * 1024).expect("trains")
    }

    #[test]
    fn a_blob_round_trips_under_its_own_file_key() {
        let file_key = [11_u8; 32];
        let options = SealOptions {
            kind: Kind::Blob,
            role: Role::Original,
            dictionary: None,
        };
        let sealed = seal(Custody::FileKey(&file_key), &options, b"a photograph").expect("seals");
        assert!(sealed.bytes.len() > 42, "a header and a body");
        assert_eq!(
            open(Custody::FileKey(&file_key), &sealed.bytes, None).expect("opens"),
            b"a photograph"
        );
    }

    #[test]
    fn a_segment_round_trips_compressed_against_its_dictionary() {
        let dictionary = dictionary();
        let plain = "core_content_item|content_id=7|byte_size=7|"
            .repeat(400)
            .into_bytes();
        let options = SealOptions {
            kind: Kind::Segment,
            role: Role::Whole,
            dictionary: Some(&dictionary),
        };
        let sealed = seal(Custody::Wrapped(&ROOT), &options, &plain).expect("seals");
        assert!(
            sealed.bytes.len() < plain.len(),
            "the dictionary bought nothing: {} vs {}",
            sealed.bytes.len(),
            plain.len()
        );
        assert_eq!(
            open(Custody::Wrapped(&ROOT), &sealed.bytes, Some(&dictionary)).expect("opens"),
            plain
        );
    }

    #[test]
    fn a_compressing_kind_without_a_dictionary_is_refused() {
        let options = SealOptions {
            kind: Kind::Manifest,
            role: Role::Whole,
            dictionary: None,
        };
        assert_eq!(
            seal(Custody::Wrapped(&ROOT), &options, b"{}"),
            Err(ObjectError::DictionaryRequired)
        );
    }

    #[test]
    fn the_wrong_dictionary_is_named_rather_than_guessed_at() {
        let dictionary = dictionary();
        let other = Dictionary::from_bytes(b"not the trained one".to_vec()).expect("adopts");
        let options = SealOptions {
            kind: Kind::Manifest,
            role: Role::Whole,
            dictionary: Some(&dictionary),
        };
        let sealed = seal(Custody::Wrapped(&ROOT), &options, b"{\"a\":1}").expect("seals");
        assert!(matches!(
            open(Custody::Wrapped(&ROOT), &sealed.bytes, Some(&other)),
            Err(ObjectError::DictionaryMismatch { .. })
        ));
        assert_eq!(
            open(Custody::Wrapped(&ROOT), &sealed.bytes, None),
            Err(ObjectError::DictionaryRequired)
        );
    }

    #[test]
    fn an_empty_object_is_one_final_chunk_and_round_trips() {
        let options = SealOptions {
            kind: Kind::Blob,
            role: Role::Original,
            dictionary: None,
        };
        let key = [5_u8; 32];
        let sealed = seal(Custody::FileKey(&key), &options, b"").expect("seals");
        assert_eq!(
            open(Custody::FileKey(&key), &sealed.bytes, None).expect("opens"),
            b""
        );
    }

    #[test]
    fn a_read_back_that_lost_a_byte_is_caught_before_upload() {
        let key = [6_u8; 32];
        let options = SealOptions {
            kind: Kind::Thumbnail,
            role: Role::Thumbnail,
            dictionary: None,
        };
        let sealed = seal(Custody::FileKey(&key), &options, b"a thumbnail").expect("seals");
        verify_read_back(Custody::FileKey(&key), &sealed, &sealed.bytes, None).expect("verifies");

        let mut damaged = sealed.bytes.clone();
        let last = damaged.len() - 1;
        damaged[last] ^= 1;
        assert_eq!(
            verify_read_back(Custody::FileKey(&key), &sealed, &damaged, None),
            Err(ObjectError::ReadBackMismatch)
        );
    }

    #[test]
    fn a_padded_frame_round_trips_and_refuses_non_zero_padding() {
        let framed = pad_frame(5, b"hello");
        assert_eq!(unpad_frame(&framed).expect("unpads"), (5, &b"hello"[..]));
        // A payload that genuinely lands mid-bucket, so there IS padding to
        // tamper with — asserted, because a payload sitting exactly on a bucket
        // boundary would make this test pass by having nothing to check.
        let mut tampered = pad_frame(21, b"hello there, padding!");
        assert!(
            tampered.len() > FRAME_PREFIX_BYTES + 21,
            "no padding to tamper with"
        );
        let last = tampered.len() - 1;
        tampered[last] = 1;
        assert!(matches!(
            unpad_frame(&tampered),
            Err(ObjectError::Malformed { .. })
        ));
    }

    #[test]
    fn a_plaintext_past_the_cap_is_refused_rather_than_split_silently() {
        let key = [8_u8; 32];
        let options = SealOptions {
            kind: Kind::Blob,
            role: Role::Original,
            dictionary: None,
        };
        let oversized = vec![0_u8; MAX_PLAINTEXT_BYTES + 1];
        assert_eq!(
            seal(Custody::FileKey(&key), &options, &oversized),
            Err(ObjectError::TooLarge(MAX_PLAINTEXT_BYTES + 1))
        );
    }
}
