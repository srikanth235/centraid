//! What names a blob, and the URI a row carries (#1020, D-1020-B2).
//!
//! ## BLAKE3, and why the byte plane could not keep SHA-256
//!
//! `core_content_item.sha256` is SHA-256 over the whole file, and SHA-256 is
//! **all-or-nothing**: the only way to know a stream of bytes is the file it
//! claims to be is to receive every one of them and hash the lot. On a desktop
//! that is a detail. On a phone it is the whole problem — a 30-second window
//! that moves 60% of a video has produced nothing a device may keep, because
//! there is no way to say which 60% was genuine. The next window starts from
//! zero, and a large file is never transferred at all.
//!
//! BLAKE3 is a Merkle tree, so a verifier holds a hash for every subtree. With
//! bao that means **each 16 KiB chunk group is verified as it arrives**,
//! against the one root hash the row already carried. An interrupted transfer
//! leaves behind chunks that are already proven to belong to this file, from a
//! peer that could not have forged them. Resumption is then not a trust
//! decision at all: it is set subtraction over the ranges already held.
//!
//! That is the single property the mobile design rests on, and it is not
//! reachable from SHA-256 by any amount of careful engineering — it is a
//! property of the hash's shape.
//!
//! ## The column shape does not move
//!
//! A BLAKE3 hash is 32 bytes, and so is a SHA-256 hash. Both render as 64
//! lowercase hex characters, so
//! `CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')` on
//! `core_content_item` and the matching check on `core_content_derivative` hold
//! over BLAKE3 unchanged. What changes is the **meaning** of the column and the
//! URI prefix beside it, which is exactly why the prefix is spelled out in the
//! value rather than assumed: `blob:sha256-…` and `blob:blake3-…` are
//! distinguishable by eye and by [`ContentHash::parse_uri`], and a vault
//! carrying the old prefix is a vault this plane refuses rather than
//! misreads.
//!
//! v0-no-legacy applies: there is no dual-hashing path and no migration that
//! keeps both. The supersession is recorded, and a pre-existing `blob:sha256-`
//! row is a row whose bytes this plane will not move.

use std::fmt;

/// The URI scheme a content row carries for CAS-backed bytes on this plane.
///
/// The hash name is IN the prefix. See the module header: it is what makes a
/// v0 row refusable instead of silently mis-verified.
pub const BLOB_URI_PREFIX: &str = "blob:blake3-";

/// The superseded prefix. Present for ONE purpose — so
/// [`ContentHash::parse_uri`] can tell "this is an older hash" from "this is
/// not a blob URI at all", which are different answers to a member.
pub const SUPERSEDED_URI_PREFIX: &str = "blob:sha256-";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HashError {
    #[error("{0:?} is not a blob URI")]
    NotABlobUri(String),
    /// A `blob:sha256-` row. Named apart from a malformed one because the
    /// remedy differs: this vault predates the byte plane.
    #[error("{0:?} is a superseded sha256 blob URI; this plane addresses bytes by blake3")]
    SupersededHash(String),
    #[error("{0:?} is not 64 lowercase hex characters")]
    NotAHash(String),
}

/// A blob's name: the BLAKE3 root hash of its bytes.
///
/// `Copy`, because it is 32 bytes and it is passed everywhere. Ordering is over
/// the raw bytes so a want-list has a stable, hash-independent sort.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ContentHash([u8; 32]);

impl ContentHash {
    /// Hash bytes that are already in memory.
    ///
    /// For anything that came off a camera roll, prefer hashing the file as it
    /// is read — see [`crate::store::ByteStore::add_path`], which never holds a
    /// whole photograph, let alone a whole video.
    #[must_use]
    pub fn of(bytes: &[u8]) -> Self {
        Self(*blake3::hash(bytes).as_bytes())
    }

    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// The 64 lowercase hex characters that go in the column.
    #[must_use]
    pub fn to_hex(self) -> String {
        hex::encode(self.0)
    }

    /// The value a `content_uri` carries.
    #[must_use]
    pub fn to_uri(self) -> String {
        format!("{BLOB_URI_PREFIX}{}", self.to_hex())
    }

    /// Parse 64 lowercase hex characters. Uppercase is refused rather than
    /// folded: the column's own `GLOB` refuses it too, so accepting it here
    /// would produce a value that cannot be stored.
    pub fn parse_hex(hex_text: &str) -> Result<Self, HashError> {
        let mut bytes = [0u8; 32];
        if hex_text.len() != 64
            || !hex_text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || hex::decode_to_slice(hex_text, &mut bytes).is_err()
        {
            return Err(HashError::NotAHash(hex_text.to_owned()));
        }
        Ok(Self(bytes))
    }

    /// Parse a `content_uri`.
    pub fn parse_uri(uri: &str) -> Result<Self, HashError> {
        if let Some(rest) = uri.strip_prefix(BLOB_URI_PREFIX) {
            return Self::parse_hex(rest);
        }
        if uri.starts_with(SUPERSEDED_URI_PREFIX) {
            return Err(HashError::SupersededHash(uri.to_owned()));
        }
        Err(HashError::NotABlobUri(uri.to_owned()))
    }
}

impl fmt::Display for ContentHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.to_hex())
    }
}

/// `Debug` is the hex too, not a byte array. A hash in a log line that reads
/// `[184, 12, …]` is a hash nobody can grep for.
impl fmt::Debug for ContentHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "ContentHash({})", self.to_hex())
    }
}

/// The seam to iroh-blobs. Both sides are the BLAKE3 root hash and nothing
/// else, so this is a rename and never a conversion — which is the reason
/// [`ContentHash`] can exist at all without the cost of a second hash scheme.
impl From<ContentHash> for iroh_blobs::Hash {
    fn from(hash: ContentHash) -> Self {
        Self::from_bytes(hash.0)
    }
}

impl From<iroh_blobs::Hash> for ContentHash {
    fn from(hash: iroh_blobs::Hash) -> Self {
        Self(*hash.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The claim the whole schema decision rests on. If BLAKE3 rendered to any
    /// other width, `core_content_item`'s CHECK would have had to move and this
    /// lane would be a migration rather than a rewrite of one column's meaning.
    #[test]
    fn a_hash_is_sixty_four_lowercase_hex_characters_exactly_like_sha256() {
        let hex_text = ContentHash::of(b"a photograph").to_hex();
        assert_eq!(hex_text.len(), 64);
        assert!(
            hex_text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "{hex_text} would fail core_content_item's GLOB"
        );
    }

    #[test]
    fn a_uri_round_trips() {
        let hash = ContentHash::of(b"a photograph");
        assert_eq!(ContentHash::parse_uri(&hash.to_uri()).unwrap(), hash);
        assert!(hash.to_uri().starts_with("blob:blake3-"));
    }

    /// THE POINT OF PUTTING THE HASH NAME IN THE URI. A v0 row is refused with
    /// its own reason, so a reader can tell "older vault" from "corrupt value"
    /// — and neither is ever verified against the wrong function.
    #[test]
    fn a_sha256_uri_is_refused_as_superseded_not_as_garbage() {
        let old = format!("blob:sha256-{}", "ab".repeat(32));
        assert!(matches!(
            ContentHash::parse_uri(&old),
            Err(HashError::SupersededHash(_))
        ));
        assert!(matches!(
            ContentHash::parse_uri("https://example.invalid/x"),
            Err(HashError::NotABlobUri(_))
        ));
    }

    /// Uppercase hex is a value the column itself would refuse, so accepting it
    /// here would mint an unstorable hash.
    #[test]
    fn uppercase_hex_is_refused_rather_than_folded() {
        let upper = ContentHash::of(b"x").to_hex().to_ascii_uppercase();
        assert!(matches!(
            ContentHash::parse_hex(&upper),
            Err(HashError::NotAHash(_))
        ));
        assert!(matches!(
            ContentHash::parse_hex("short"),
            Err(HashError::NotAHash(_))
        ));
    }

    /// A rename, not a conversion. Asserted because the day it stops being true
    /// is the day every stored URI stops naming the blob iroh holds.
    #[test]
    fn the_iroh_seam_is_the_same_thirty_two_bytes() {
        let ours = ContentHash::of(b"a photograph");
        let theirs: iroh_blobs::Hash = ours.into();
        assert_eq!(theirs.as_bytes(), ours.as_bytes());
        assert_eq!(theirs.to_hex(), ours.to_hex());
        assert_eq!(ContentHash::from(theirs), ours);
    }
}
