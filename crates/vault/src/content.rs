//! WHERE A CONTENT ITEM'S BYTES ARE, AND WHAT THIS READER READS THEM AS
//! (#1020, D-1020-DC1).
//!
//! The write half of the byte door is [`crate::file::Vault::with_blobs`]: a
//! command spills anything that is not `text/*` into the local store and the
//! row keeps `blob:blake3-<hex>`. This is the read half, and it exists because
//! a row naming bytes is not a photograph a member can see.
//!
//! ## ONE STORE, AND THE PATH IS THE STORE'S TO GIVE (#1025 S3, D-1025-S3-1)
//!
//! This used to compose the answer itself — `Vault::blobs_root_for(path).join(sha)`
//! — which was correct for the flat CAS it was written against and wrong the
//! moment a device had a second store. A seat FETCHED bytes into iroh's store
//! and this reader looked for them in a directory nothing wrote, so a synced
//! photograph could not be displayed. The path now comes from
//! [`crate::backup::store::BlobStore::path_of`], so there is one store and it
//! is the one that answers where its own bytes are.
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
/// **BLAKE3, superseding v0's SHA-256 (#1020, D-1020-B2).** The hash function is
/// IN the value, so the value says which function named these bytes rather than
/// leaving a reader to assume.
///
/// **It is the ONLY form** (#1025 S3, D-1025-S3-3). `blob:sha256-` and the
/// "stored by an older version of Centraid" sentence beside it are gone: v1 has
/// no released predecessor, so no vault a member holds was ever written that
/// way, and a refusal branch with no producer is a sentence nobody can reach.
pub const BLOB_URI_PREFIX: &str = "blob:blake3-";

/// THE HASH THAT NAMES A MEMBER'S BYTES (#1020, D-1020-B2).
///
/// One function, because `core_content_item.content_hash` is UNIQUE and is the dedupe
/// key for every owner of those bytes: a mint that hashed one way and a media
/// import that hashed another would file the same photograph as two items, and
/// the column's own constraint would not catch it.
///
/// **Why not SHA-256.** SHA-256 is all-or-nothing — the only way to know a stream
/// of bytes is the file it claims to be is to receive every one of them. On a
/// phone that means a thirty-second window which moved 60% of a video produces
/// nothing that may be kept, and a large file never crosses at all. BLAKE3 is a
/// Merkle tree, so with bao every 16 KiB chunk group is verified as it arrives
/// and an interrupted transfer leaves proven bytes behind. That property is
/// what `crates/blobs` is built on and it is not reachable from SHA-256.
///
/// **The column's SHAPE does not move, and its NAME did** (#1025 S4,
/// D-1025-S4-7). Both hashes are 32 bytes and render as 64 lowercase hex, so
/// `CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')`
/// holds unchanged over either — but the column was called `sha256`, which is a
/// comment that lies and cannot be linted, so it is `content_hash`.
///
/// **It IS the backup plane's digest too** (#1025 S4, D-1025-S4-1).
/// `backup::store::digest` used to be SHA-256, on the reasoning that an
/// artefact's identity is sealed across two languages and re-keying is not
/// housekeeping (D-1020-R1). There is one language now and no released
/// predecessor whose artefacts v1 can restore, so that clause was protecting
/// nothing. Two names for one hash is how a store ends up verifying a member's
/// bytes with the wrong one.
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
    /// Record bytes this device now HOLDS, so the command that names them can
    /// promote them (#1025 S3).
    ///
    /// THE THIRD PRODUCER OF `blob_staging`, and the first one in v1. The other
    /// two are v0's upload door and the extension's capture; this is a gateway
    /// that has just PULLED a seat's blob over the connection the seat opened,
    /// before executing the intent that names it. The bytes are already in this
    /// vault's content store and verified against their own name by bao; what
    /// the staging row adds is the two facts the store cannot answer — the
    /// media type the seat read, and the size it declared.
    ///
    /// The media type is why this exists at all. `promote_staged_blob` falls
    /// back to `application/octet-stream` without a row, and a photograph
    /// promoted as `application/octet-stream` is a photograph the grid will not
    /// embed. There is no sniffer on the gateway and inventing one would be a
    /// second opinion about bytes the seat already read.
    ///
    /// Idempotent: a hash already staged, or already minted into a content
    /// item, is left exactly as it is. A pull that is retried after a window
    /// closed must not stage the same bytes twice, and a `blob_staging` row
    /// over bytes a content row already owns would be promoted a second time.
    pub fn stage_bytes(&self, staged: &[crate::intents::NeededBytes]) -> Result<usize> {
        if staged.is_empty() {
            return Ok(0);
        }
        let now = self.clock().now_text();
        let mut ids = Vec::with_capacity(staged.len());
        for _ in staged {
            ids.push(self.ids().next());
        }
        let mut written = 0usize;
        self.commit(|tx| {
            // A PRODUCER NAME, because every commit has one and "the gateway
            // pulled these" is the honest answer to who wrote the row.
            tx.set_producer("seat.blob_pull");
            for (need, staging_id) in staged.iter().zip(&ids) {
                let held: i64 = tx.connection().query_row(
                    "SELECT (EXISTS(SELECT 1 FROM blob_staging
                                     WHERE content_hash = ?1 AND variant IS NULL)
                             OR EXISTS(SELECT 1 FROM core_content_item WHERE content_hash = ?1))",
                    [&need.hash],
                    |row| row.get(0),
                )?;
                if held == 1 {
                    continue;
                }
                tx.connection().execute(
                    "INSERT INTO blob_staging
                       (staging_id, content_hash, media_type, byte_size, original_name,
                        meta_json, staged_by, held_by_batch, variant, variant_of,
                        inline_content, staged_at, held_by_intent)
                     VALUES (?1, ?2, ?3, ?4, NULL, '{}', NULL, NULL, NULL, NULL, NULL, ?5, NULL)",
                    rusqlite::params![
                        staging_id,
                        need.hash,
                        need.media_type,
                        need.byte_size.max(0),
                        now
                    ],
                )?;
                written += 1;
            }
            Ok(())
        })?;
        Ok(written)
    }

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
        match blobs.path_of(sha) {
            Ok(Some(path)) => Ok(ContentLocation {
                content_id: content_id.to_owned(),
                path: Some(path),
                media_type,
                byte_size,
                embeddable,
                absent_reason: String::new(),
            }),
            // A ROW WITHOUT ITS BYTES IS THE NORMAL SEAT STATE, not a fault:
            // rows replicate first and bytes follow. It is also the answer for
            // a blob this device holds PART of, which is the same thing to a
            // member. The sentence is the one they can act on and it never
            // names the sha.
            Ok(None) => Ok(absent("This file has not reached this device yet.")),
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
