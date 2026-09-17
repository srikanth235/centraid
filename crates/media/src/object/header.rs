//! The typed header of `centraid-object/1` — and the field the superseded
//! frame format had that this one does not (#1029 §4).
//!
//! ## THE PLAINTEXT HASH IS NOT IN THE HEADER
//!
//! The v0-derived frame format this replaces put the 32-byte BLAKE3 of the
//! plaintext in bytes 5..37 of every object, in the clear (Reference A). That is a plaintext commitment printed on the outside
//! of the envelope: anyone holding the bytes can confirm a guess at the content,
//! and a store full of them is a store full of confirmable guesses. It is also
//! what let the address double as a nonce input (B9).
//!
//! An object's **name is the BLAKE3 of its own ciphertext**, computed by the
//! reader from bytes it already has, so nothing about the plaintext has to be
//! written down to address it. The plaintext hash still exists — the phone
//! deduplicates on it and verifies a read-back against it — but it lives inside
//! the vault, which is itself encrypted, and never on the object.
//!
//! ## WHAT THE HEADER DOES CARRY, AND WHY EACH FIELD IS AUTHENTICATED
//!
//! The whole encoded header is the associated data of **every** body chunk, so
//! none of it can be edited without breaking every tag: a `segment` cannot be
//! re-labelled a `blob`, the dictionary id cannot be swapped for one that
//! decompresses to something else, and the compressed flag cannot be cleared.
//!
//! | Bytes | Field |
//! | --- | --- |
//! | 0..4 | magic `CNOB` |
//! | 4 | format version, `1` |
//! | 5 | [`Kind`] |
//! | 6 | [`Role`] |
//! | 7 | flags — bit 0 is "zstd, against the dictionary named below" |
//! | 8..24 | the object salt: 16 random bytes, drawn per object |
//! | 24..56 | dictionary id: BLAKE3 of the dictionary bytes, all-zero when uncompressed |
//! | 56..58 | wrapped-key length, big-endian; `0` when the key lives in the vault |
//! | 58.. | the wrapped key |
//!
//! ## THE SALT, AND THE TRANSPLANT IT REFUSES THAT KIND AND ROLE DO NOT
//!
//! `kind` and `role` in the key-wrap AAD stop a header moving between objects of
//! DIFFERENT kinds. They do nothing about two objects of the same kind — two
//! thumbnails, say — and a `blob` or `thumbnail` header carries no wrapped key
//! at all, so without the salt two same-kind file-key objects have byte-identical
//! headers and therefore identical chunk AAD. Their bodies swap cleanly whenever
//! they share a key.
//!
//! §4 does give every blob its own fresh file key, which would also defeat that
//! swap — but then the property rests on a caller's key discipline rather than on
//! the format. The salt makes it the format's: **16 random bytes per object**
//! mean no two objects ever have the same header, so no body opens under another
//! object's header even under one key. `tests/object.rs` swaps two same-kind
//! items out of one pack and asserts the refusal.

use super::{ObjectError, ObjectResult};

/// `CeNtraid OBject`. Four bytes, so a directory listing shows what a file is.
pub const HEADER_MAGIC: &[u8; 4] = b"CNOB";

/// `centraid-object/1`. The version is in the AAD of every chunk, so a v2
/// reader cannot be walked backwards into v1's rules by an edited byte.
pub const FORMAT_VERSION: u8 = 1;

/// The format's own name, folded into the key-wrap AAD.
pub const FORMAT_NAME: &str = "centraid-object/1";

/// Everything before the wrapped key.
pub const HEADER_FIXED_BYTES: usize = 58;

/// The object salt: 16 random bytes that make every header unique.
pub const SALT_BYTES: usize = 16;

/// Bit 0 of the flags byte.
const FLAG_COMPRESSED: u8 = 0b0000_0001;

/// What the object is. One enum for every object the vault ever writes — that
/// is the whole point of "one format for every object".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Kind {
    /// A 4 MiB page range of the page-identical base snapshot.
    Base = 1,
    /// A commit-bounded page segment out of the spool.
    Segment = 2,
    /// A generation manifest.
    Manifest = 3,
    /// An original, under its own file key.
    Blob = 4,
    /// A generated thumbnail, under its own file key.
    Thumbnail = 5,
    /// Many small objects in one, addressable by range.
    Pack = 6,
}

impl Kind {
    /// Read a kind back off the wire.
    ///
    /// # Errors
    /// [`ObjectError::UnknownKind`] when the byte names no kind this version
    /// defines.
    pub const fn from_byte(byte: u8) -> Result<Self, ObjectError> {
        Ok(match byte {
            1 => Self::Base,
            2 => Self::Segment,
            3 => Self::Manifest,
            4 => Self::Blob,
            5 => Self::Thumbnail,
            6 => Self::Pack,
            other => return Err(ObjectError::UnknownKind(other)),
        })
    }

    /// The spelling bound into the key-wrap AAD. Stable forever: changing one
    /// of these strings makes every object of that kind unopenable.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Segment => "segment",
            Self::Manifest => "manifest",
            Self::Blob => "blob",
            Self::Thumbnail => "thumbnail",
            Self::Pack => "pack",
        }
    }

    /// Whether this kind's plaintext is zstd'd before it is padded and sealed.
    ///
    /// `base`, `segment` and `manifest` are database pages and JSON — a one-row
    /// edit's segment is mostly page structure the dictionary already knows.
    /// Photos and thumbnails are already-compressed codecs and a pack is a
    /// concatenation of sealed items, so both would only grow (#1029 §4).
    #[must_use]
    pub const fn compresses(self) -> bool {
        matches!(self, Self::Base | Self::Segment | Self::Manifest)
    }
}

/// What part of the object the key opens.
///
/// `kind` alone is not enough — see `centraid-identity`'s `sealed_box`, whose
/// AAD carries the same pair for the same reason: without the role, a
/// "photo/thumbnail" wrap opens a "photo/original".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Role {
    /// The object is the whole thing it names.
    Whole = 1,
    /// A camera original.
    Original = 2,
    /// A generated derivative.
    Thumbnail = 3,
    /// A pack's trailing item table.
    ItemTable = 4,
}

impl Role {
    /// Read a role back off the wire.
    ///
    /// # Errors
    /// [`ObjectError::UnknownRole`] when the byte names no role this version
    /// defines.
    pub const fn from_byte(byte: u8) -> Result<Self, ObjectError> {
        Ok(match byte {
            1 => Self::Whole,
            2 => Self::Original,
            3 => Self::Thumbnail,
            4 => Self::ItemTable,
            other => return Err(ObjectError::UnknownRole(other)),
        })
    }

    /// The spelling bound into the key-wrap AAD. As stable as [`Kind::as_str`].
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Whole => "whole",
            Self::Original => "original",
            Self::Thumbnail => "thumbnail",
            Self::ItemTable => "item-table",
        }
    }
}

/// The decoded header. Its encoding is the AAD of every chunk of the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    /// What the object is.
    pub kind: Kind,
    /// What the key opens.
    pub role: Role,
    /// Whether the body is zstd'd against [`Header::dictionary_id`].
    pub compressed: bool,
    /// 16 random bytes, drawn once per object. See the module header: this is
    /// what makes two same-kind objects' headers — and therefore their chunk
    /// AAD — different even when they share a key.
    pub salt: [u8; SALT_BYTES],
    /// BLAKE3 of the zstd dictionary the body was compressed against, all-zero
    /// when `compressed` is false. **BLAKE3 and not SHA-256**: a dictionary id
    /// is a name this repository defines, so ONE HASH binds it.
    pub dictionary_id: [u8; 32],
    /// The AEAD-wrapped content key, empty when the key lives in the vault's
    /// blob-custody row instead.
    pub wrapped_key: Vec<u8>,
}

impl Header {
    /// The bytes that prefix the object and authenticate every chunk.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_FIXED_BYTES + self.wrapped_key.len());
        out.extend_from_slice(HEADER_MAGIC);
        out.push(FORMAT_VERSION);
        out.push(self.kind as u8);
        out.push(self.role as u8);
        out.push(if self.compressed { FLAG_COMPRESSED } else { 0 });
        out.extend_from_slice(&self.salt);
        out.extend_from_slice(&self.dictionary_id);
        // A wrapped key is a nonce plus 32 bytes plus a tag; `u16` covers it
        // with room to spare, and refusing anything longer is one less way for
        // a header to claim the body.
        let length = u16::try_from(self.wrapped_key.len()).unwrap_or(u16::MAX);
        out.extend_from_slice(&length.to_be_bytes());
        out.extend_from_slice(&self.wrapped_key);
        out
    }

    /// Decode a header off the front of an object, returning it and the offset
    /// the body starts at.
    ///
    /// Every refusal here happens **before** any key is touched: the magic, the
    /// version, the two enums, the reserved flag bits and the declared wrap
    /// length are all checked against bytes an attacker controls, so a malformed
    /// object costs a comparison rather than a decryption.
    ///
    /// # Errors
    /// [`ObjectError::Malformed`], [`ObjectError::UnsupportedVersion`],
    /// [`ObjectError::UnknownKind`] or [`ObjectError::UnknownRole`].
    pub fn decode(bytes: &[u8]) -> ObjectResult<(Self, usize)> {
        if bytes.len() < HEADER_FIXED_BYTES {
            return Err(ObjectError::Malformed {
                reason: "shorter than a header",
            });
        }
        if &bytes[..4] != HEADER_MAGIC {
            return Err(ObjectError::Malformed {
                reason: "not a centraid-object",
            });
        }
        if bytes[4] != FORMAT_VERSION {
            return Err(ObjectError::UnsupportedVersion(bytes[4]));
        }
        let kind = Kind::from_byte(bytes[5])?;
        let role = Role::from_byte(bytes[6])?;
        let flags = bytes[7];
        if flags & !FLAG_COMPRESSED != 0 {
            // Reserved bits are refused rather than ignored: a reader that
            // ignores them opens an object a later version meant it not to.
            return Err(ObjectError::Malformed {
                reason: "reserved header flag bits are set",
            });
        }
        let compressed = flags & FLAG_COMPRESSED != 0;
        let mut salt = [0_u8; SALT_BYTES];
        salt.copy_from_slice(&bytes[8..8 + SALT_BYTES]);
        let mut dictionary_id = [0_u8; 32];
        dictionary_id.copy_from_slice(&bytes[8 + SALT_BYTES..40 + SALT_BYTES]);
        if !compressed && dictionary_id != [0_u8; 32] {
            return Err(ObjectError::Malformed {
                reason: "an uncompressed object names a dictionary",
            });
        }
        if compressed && dictionary_id == [0_u8; 32] {
            return Err(ObjectError::Malformed {
                reason: "a compressed object names no dictionary",
            });
        }
        let wrap_len = usize::from(u16::from_be_bytes([
            bytes[HEADER_FIXED_BYTES - 2],
            bytes[HEADER_FIXED_BYTES - 1],
        ]));
        let body_at = HEADER_FIXED_BYTES + wrap_len;
        if bytes.len() < body_at {
            return Err(ObjectError::Malformed {
                reason: "the wrapped key runs past the object",
            });
        }
        Ok((
            Self {
                kind,
                role,
                compressed,
                salt,
                dictionary_id,
                wrapped_key: bytes[HEADER_FIXED_BYTES..body_at].to_vec(),
            },
            body_at,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> Header {
        Header {
            kind: Kind::Segment,
            role: Role::Whole,
            compressed: true,
            salt: [7_u8; SALT_BYTES],
            dictionary_id: [9_u8; 32],
            wrapped_key: vec![1, 2, 3, 4],
        }
    }

    #[test]
    fn a_header_round_trips_and_reports_where_the_body_starts() {
        let encoded = header().encode();
        let (decoded, body_at) = Header::decode(&encoded).expect("decodes");
        assert_eq!(decoded, header());
        assert_eq!(body_at, HEADER_FIXED_BYTES + 4);
        assert_eq!(encoded.len(), body_at);
    }

    /// THE REGRESSION THAT NAMES THE DEFECT: a `centraid-object/1` header is
    /// 58 bytes plus a wrap, and there is nowhere in it for a plaintext hash.
    #[test]
    fn no_field_of_the_header_is_a_plaintext_commitment() {
        let plain = b"the quick brown fox";
        let digest = blake3::hash(plain);
        let encoded = header().encode();
        assert!(
            !encoded
                .windows(32)
                .any(|window| window == digest.as_bytes()),
            "the header carries the plaintext hash — that is the defect this format \
             exists to close"
        );
    }

    #[test]
    fn a_damaged_header_is_refused_before_any_key_is_touched() {
        let good = header().encode();
        for (index, reason) in [(0, "magic"), (4, "version"), (5, "kind"), (6, "role")] {
            let mut bad = good.clone();
            bad[index] ^= 0xff;
            assert!(Header::decode(&bad).is_err(), "{reason} was accepted");
        }
        let mut reserved = good.clone();
        reserved[7] |= 0b1000_0000;
        assert!(
            Header::decode(&reserved).is_err(),
            "a reserved bit was ignored"
        );

        let mut lying = good.clone();
        lying[HEADER_FIXED_BYTES - 2] = 0xff;
        assert!(
            Header::decode(&lying).is_err(),
            "an overlong wrap was accepted"
        );

        assert!(Header::decode(&good[..HEADER_FIXED_BYTES - 1]).is_err());
    }

    /// An uncompressed object naming a dictionary, or a compressed one naming
    /// none, is a header somebody edited.
    #[test]
    fn the_compressed_flag_and_the_dictionary_id_have_to_agree() {
        let mut orphan = header();
        orphan.compressed = false;
        assert!(Header::decode(&orphan.encode()).is_err());

        let mut nameless = header();
        nameless.dictionary_id = [0_u8; 32];
        assert!(Header::decode(&nameless.encode()).is_err());
    }

    #[test]
    fn every_kind_and_role_round_trips_through_its_byte() {
        for kind in [
            Kind::Base,
            Kind::Segment,
            Kind::Manifest,
            Kind::Blob,
            Kind::Thumbnail,
            Kind::Pack,
        ] {
            assert_eq!(Kind::from_byte(kind as u8), Ok(kind));
            assert!(!kind.as_str().is_empty());
        }
        for role in [
            Role::Whole,
            Role::Original,
            Role::Thumbnail,
            Role::ItemTable,
        ] {
            assert_eq!(Role::from_byte(role as u8), Ok(role));
        }
        assert_eq!(Kind::from_byte(0), Err(ObjectError::UnknownKind(0)));
        assert_eq!(Role::from_byte(9), Err(ObjectError::UnknownRole(9)));
    }

    /// Only the three database-shaped kinds compress. If this list ever grows a
    /// photo, the size-class leak the module header bounds grows with it.
    #[test]
    fn only_base_segment_and_manifest_compress() {
        assert!(Kind::Base.compresses());
        assert!(Kind::Segment.compresses());
        assert!(Kind::Manifest.compresses());
        assert!(!Kind::Blob.compresses());
        assert!(!Kind::Thumbnail.compresses());
        assert!(!Kind::Pack.compresses());
    }
}
