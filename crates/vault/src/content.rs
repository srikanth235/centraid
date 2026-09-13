//! WHERE A CONTENT ITEM'S BYTES ARE, AND WHAT THIS READER READS THEM AS
//! (#1020, D-1020-DC1).
//!
//! The write half of the byte door is [`crate::file::Vault::with_blobs`]: a
//! command spills anything that is not `text/*` into the local store and the
//! row keeps `blob:blake3-<hex>`. This is the read half, and it exists because
//! a row naming bytes is not a photograph a member can see.
//!
//! ## It answers a LOCATION, never the bytes
//!
//! A grid asks for a screenful and every cell is a file the platform can open
//! directly — `UIImage(contentsOfFile:)`, a Compose painter, an `<img>`. Bytes
//! crossing the ABI would be the core buffering a photograph so a view could
//! buffer it again, and it would put range requests and caching on the wrong
//! side of the boundary. `centraid.screen.v1.PhotoCell.thumbnail_path` has
//! always said the answer is a path; this is what fills it.
//!
//! ## The media type is the REPRESENTATION's, never the byte row's
//!
//! #996 ruling R20(b): the same sha pinned to two rows carries two readings,
//! and the reading is what decides whether a surface may embed the bytes. So
//! the caller names the OWNER — `media.asset` and an asset id — and the type
//! comes from that owner's representation. A caller with no owner to offer gets
//! no type, and therefore no permission to embed: **no type is not permission**,
//! which is `ServedUrl::of`'s rule in `crates/apps/docs/src/bytes.rs` and the
//! reason it is phrased that way round.

use crate::error::Result;
use crate::file::Vault;

/// `content_uri` scheme for CAS-backed bytes.
///
/// **BLAKE3, superseding v0's sha256 (#1020, D-1020-B2).** The hash function is
/// IN the value, so a vault written before the byte plane is refusable rather
/// than silently verified against the wrong function — see
/// [`SUPERSEDED_URI_PREFIX`].
pub const BLOB_URI_PREFIX: &str = "blob:blake3-";

/// v0's prefix. Present so a reader can tell "an older vault" from "not a blob
/// URI at all", which are different answers to a member and different actions
/// for an owner.
pub const SUPERSEDED_URI_PREFIX: &str = "blob:sha256-";

/// THE HASH THAT NAMES A MEMBER'S BYTES (#1020, D-1020-B2).
///
/// One function, because `core_content_item.sha256` is UNIQUE and is the dedupe
/// key for every owner of those bytes: a mint that hashed one way and a media
/// import that hashed another would file the same photograph as two items, and
/// the column's own constraint would not catch it.
///
/// **Why not sha256.** sha256 is all-or-nothing — the only way to know a stream
/// of bytes is the file it claims to be is to receive every one of them. On a
/// phone that means a thirty-second window which moved 60% of a video produces
/// nothing that may be kept, and a large file never crosses at all. BLAKE3 is a
/// Merkle tree, so with bao every 16 KiB chunk group is verified as it arrives
/// and an interrupted transfer leaves proven bytes behind. That property is
/// what `crates/blobs` is built on and it is not reachable from sha256.
///
/// **The column does not move.** Both hashes are 32 bytes and render as 64
/// lowercase hex, so `CHECK (length(sha256) = 64 AND sha256 NOT GLOB
/// '*[^0-9a-f]*')` holds unchanged. The column's NAME is now historical; its
/// meaning is this function.
///
/// **Not the BACKUP plane's digest.** `backup::store::digest` stays sha256:
/// `contracts/golden/format-golden.json` seals the backup format across two
/// languages, and changing an artefact's identity is a re-keying event and not
/// housekeeping (D-1020-R1).
#[must_use]
pub fn content_digest(bytes: &[u8]) -> String {
    hex::encode(blake3::hash(bytes).as_bytes())
}

/// Media types a browser executes in the origin of whatever page embeds them.
///
/// Lane F's `INLINE_EXECUTABLE_MEDIA_TYPES`, carried unchanged from
/// `crates/centraid/src/cmd/seat/blob.rs` and v0's `blob-read-route.ts:23`.
/// **A list that grew here would be a security rule widened from a helper.**
pub const NEVER_INLINE: [&str; 3] = ["text/html", "application/xhtml+xml", "image/svg+xml"];

/// Where one content item's bytes are, and how this reader reads them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentLocation {
    pub content_id: String,
    /// The file, when this device holds the bytes. `None` is a real answer.
    pub path: Option<std::path::PathBuf>,
    /// What the named owner reads these bytes as. Empty when it has no
    /// representation, which is also when [`Self::embeddable`] is false.
    pub media_type: String,
    pub byte_size: i64,
    /// Whether a surface may EMBED this rather than only offer it.
    pub embeddable: bool,
    /// A member-facing sentence, set only when `path` is absent.
    pub absent_reason: String,
}

/// The media type with its parameters stripped and lowercased.
///
/// `text/html; charset=utf-8` is `text/html`, and a comparison that missed the
/// parameter would let the one type this list exists for through.
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
    !media_type.is_empty() && !NEVER_INLINE.contains(&base_media_type(media_type).as_str())
}

impl Vault {
    /// Locate one content item's bytes for the owner that is reading them.
    ///
    /// Never an `Err` for "the bytes are not here" — that is a state a grid
    /// draws, with a sentence, and a failed read would take a whole screenful
    /// down over one missing cell. `Err` is reserved for the vault itself being
    /// unreadable.
    pub fn content_location(
        &self,
        content_id: &str,
        owner_type: &str,
        owner_id: &str,
    ) -> Result<ContentLocation> {
        let row: Option<(Option<String>, Option<i64>)> = self.read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT content_uri, byte_size FROM core_content_item
                      WHERE content_id = ?1 AND deleted_at IS NULL",
                    [content_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok())
        })?;
        // THE OWNER'S OWN READING. Looked up even when the bytes turn out to be
        // absent, so an absent answer still says what it WOULD have been — a
        // grid that only learns the type once the bytes arrive cannot decide
        // whether to draw a cell or a download.
        let media_type: String = self
            .read(|connection| {
                Ok(connection
                    .query_row(
                        "SELECT media_type FROM core_content_representation
                          WHERE content_id = ?1 AND owner_type = ?2 AND owner_id = ?3",
                        rusqlite::params![content_id, owner_type, owner_id],
                        |row| row.get(0),
                    )
                    .ok())
            })?
            .unwrap_or_default();
        let embeddable = may_serve_inline(&media_type);
        let absent = |reason: &str| ContentLocation {
            content_id: content_id.to_owned(),
            path: None,
            media_type: media_type.clone(),
            byte_size: 0,
            embeddable,
            absent_reason: reason.to_owned(),
        };

        let Some((Some(uri), byte_size)) = row else {
            // No row, or a row with no URI at all. "Not in this vault" rather
            // than "not on this device": a seat that is missing the ROW is a
            // different problem from one missing the bytes, and telling a
            // member to wait for a sync that will never mention it is worse
            // than saying nothing.
            return Ok(absent("Centraid does not have this item."));
        };
        let byte_size = byte_size.unwrap_or_default();

        if uri.starts_with(SUPERSEDED_URI_PREFIX) {
            // A VAULT FROM BEFORE THE BYTE PLANE. Named apart from "not a blob
            // URI" because the remedy is an owner's, not a member's, and
            // because verifying a sha256 name against blake3 bytes would be a
            // silent mismatch on every file.
            return Ok(absent(
                "This file was stored by an older version of Centraid and needs to be re-imported.",
            ));
        }
        let Some(sha) = uri.strip_prefix(BLOB_URI_PREFIX) else {
            // TEXT LIVES IN THE ROW, by design: the search index decodes it
            // in-transaction and cannot do I/O. There is no file, and there
            // never will be — `content.read_text` is the door for these, and it
            // is the arm this request is deliberately not.
            return Ok(absent(
                "These bytes are stored in the item itself, not as a file.",
            ));
        };
        let Some(blobs) = self.blobs() else {
            return Ok(absent("This copy of Centraid has no file store."));
        };
        match blobs.has(sha) {
            Ok(true) => Ok(ContentLocation {
                content_id: content_id.to_owned(),
                path: Some(Vault::blobs_root_for(self.path()).join(sha)),
                media_type,
                byte_size,
                embeddable,
                absent_reason: String::new(),
            }),
            // A ROW WITHOUT ITS BYTES IS THE NORMAL SEAT STATE, not a fault:
            // rows replicate first and bytes follow. The sentence is the one a
            // member can act on, and it never names the sha.
            Ok(false) => Ok(absent("This file has not reached this device yet.")),
            Err(error) => {
                // The store itself is unhappy — a corrupt blob, a permission.
                // Logged with its detail and reported without it, because a
                // store's words are not a member's.
                tracing::warn!("the content store could not answer for {content_id}: {error}");
                Ok(absent("Centraid could not open this file."))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_executable_types_are_never_inline() {
        for media_type in NEVER_INLINE {
            assert!(!may_serve_inline(media_type), "{media_type}");
            // AND WITH A PARAMETER. `text/html; charset=utf-8` is the form a
            // real representation carries, and a comparison that missed it
            // would let through the one type the list exists for.
            assert!(
                !may_serve_inline(&format!("{media_type}; charset=utf-8")),
                "{media_type} with a parameter"
            );
        }
    }

    #[test]
    fn no_type_is_not_permission() {
        // A content item whose representation this vault cannot read is
        // offered, never embedded: the whole reason the list exists is that the
        // bytes may be authored by someone else.
        assert!(!may_serve_inline(""));
    }

    #[test]
    fn an_ordinary_image_is_embeddable() {
        assert!(may_serve_inline("image/png"));
        assert!(may_serve_inline("image/jpeg"));
        assert!(may_serve_inline("video/mp4"));
    }
}
