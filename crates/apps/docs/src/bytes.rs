//! BYTES RIDE THE DOOR, NEVER THE PAYLOAD (D-1020-DC4).
//!
//! Docs is the app most coupled to the media-delivery ruling (#1020 `:110`,
//! census §A3). v0 reaches three shell verbs — `window.centraid.blobText`,
//! `blobUrl` and `stageBlob` (`docs/blob-text.ts:14`, `docs/upload.ts`) — which
//! on desktop become wave 3's `centraid://` protocol handler and on mobile a
//! materialised private-container path.
//!
//! ## What this module is, and what it deliberately is not
//!
//! It is the three REQUESTS as data, plus the one rule that must hold on every
//! surface. It holds **no buffer, no filesystem and no socket**: an app crate
//! that could read a byte is an app crate that could read a byte it was not
//! granted, and the door is the place the grant is checked. [`ByteDoor`] is the
//! seam, exactly as [`centraid_apps_kit::PageDoor`] is for reads.
//!
//! ## The three verbs, and why each is bounded
//!
//! | Verb | Request | The bound, and why |
//! |---|---|---|
//! | `blobText` | [`ByteRequest::ReadText`] | A quick-look of a text body. Bounded by [`MAX_QUICK_LOOK_BYTES`], because a quick-look is a GLANCE: a 60 MiB log file pasted into a popover is not a preview, and the inline text ceiling a command enforces is 64 KiB anyway |
//! | `blobUrl` | [`ByteRequest::Url`] | A URL, never bytes. The door answers a `centraid://` URL the surface hands to an `<img>`, a `<video>` or a viewer, so range requests and caching are the platform's and this crate never buffers a document |
//! | `stageBlob` | [`ByteRequest::Stage`] | An upload, answered with a [`StagedBlob`] — a sha and a size — which is what `core.add_document`'s `staged_sha` takes. The bytes go to `crates/media`'s store through the door; the command that claims them does pure row work |
//!
//! ## THE NEVER-INLINE RULE, and it is not this lane's to soften
//!
//! [`NEVER_INLINE`] is lane F's list, verbatim
//! (`crates/centraid/src/cmd/seat/blob.rs:48`, from v0's
//! `packages/server/src/routes/blob-read-route.ts:23`-`:27`, issue #865). Blob
//! bytes can be attacker-authored — an imported attachment, a **shared
//! document**, which is precisely Docs' case — so a stored `text/html` served
//! inline is a stored XSS against the shell. In a desktop seat the shell origin
//! is the app itself, which makes it worse rather than better.
//!
//! Docs is where that matters most and where it is easiest to get wrong: the
//! quick-look popover renders a text body, and `text/html` IS `text/*`. So
//! [`ByteRequest::read_text`] refuses those three types at the request, before
//! a door is even asked — and [`may_serve_inline`] is the same predicate for a
//! surface deciding whether to embed or to download.

use crate::{Denial, Reading};

/// Media types a browser executes in the origin of whatever page embeds them.
///
/// Lane F's `INLINE_EXECUTABLE_MEDIA_TYPES`, carried unchanged. A Docs lane
/// that added a fourth type would be widening a security rule from an app
/// crate, which is not where that decision lives.
pub const NEVER_INLINE: [&str; 3] = ["text/html", "application/xhtml+xml", "image/svg+xml"];

/// How much text a quick-look may pull through the door.
///
/// 64 KiB, the same number `core.edit_document` enforces on an inline body
/// (`packages/vault/src/commands/inline-body-guard.ts:13`), so the popover can
/// show the whole of anything the app itself could have written and says so
/// rather than truncating silently.
pub const MAX_QUICK_LOOK_BYTES: usize = 64 * 1024;

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
    !NEVER_INLINE.contains(&base_media_type(media_type).as_str())
}

/// A refusal the door never had to be asked about.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ByteRefusal {
    #[error(
        "{media_type} is executed by a browser in the page's own origin, so these bytes are \
         offered as a download and never rendered inline"
    )]
    NeverInline { media_type: String },
    #[error(
        "a quick look is a glance: {byte_size} bytes is over the {MAX_QUICK_LOOK_BYTES}-byte \
         preview window — open the document instead"
    )]
    TooLargeToGlance { byte_size: usize },
}

/// What a surface asks the byte door for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ByteRequest {
    /// `blobText` — the decoded text of a content item, bounded.
    ReadText {
        content_id: String,
        /// The window the caller will render. Never more than
        /// [`MAX_QUICK_LOOK_BYTES`].
        limit: usize,
    },
    /// `blobUrl` — a `centraid://` URL, and whether the surface may embed it.
    Url {
        content_id: String,
        /// What THIS document reads the bytes as, from the representation
        /// index. The door needs it to answer `inline`.
        media_type: Option<String>,
    },
    /// `stageBlob` — bytes on their way in, answered with a sha to claim.
    Stage {
        /// The declared type. The staging band sniffs the bytes itself; this is
        /// what the upload SAID, which is what `core.add_document` then puts on
        /// the document's own representation (#996 R20(b)).
        media_type: String,
        byte_size: usize,
        /// The uploaded filename, when there was one.
        original_name: Option<String>,
    },
}

impl ByteRequest {
    /// A bounded quick-look of a text body, refusing the three executable types
    /// **before the door is asked**.
    pub fn read_text(
        content_id: &str,
        media_type: &str,
        byte_size: usize,
    ) -> Result<Self, ByteRefusal> {
        if !may_serve_inline(media_type) {
            return Err(ByteRefusal::NeverInline {
                media_type: base_media_type(media_type),
            });
        }
        if byte_size > MAX_QUICK_LOOK_BYTES {
            return Err(ByteRefusal::TooLargeToGlance { byte_size });
        }
        Ok(Self::ReadText {
            content_id: content_id.to_owned(),
            limit: MAX_QUICK_LOOK_BYTES,
        })
    }

    /// A URL for a viewer. Never refuses: a `text/html` document is still
    /// downloadable, and [`ServedUrl::inline`] is what says it may not be
    /// embedded.
    #[must_use]
    pub fn url(content_id: &str, media_type: Option<&str>) -> Self {
        Self::Url {
            content_id: content_id.to_owned(),
            media_type: media_type.map(str::to_owned),
        }
    }

    /// The content id this request is about, where it has one.
    #[must_use]
    pub fn content_id(&self) -> Option<&str> {
        match self {
            Self::ReadText { content_id, .. } | Self::Url { content_id, .. } => Some(content_id),
            Self::Stage { .. } => None,
        }
    }
}

/// The answer to [`ByteRequest::Url`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServedUrl {
    /// `centraid://…` on desktop; a materialised container path on mobile.
    pub url: String,
    /// Whether a surface may EMBED this rather than only offer it.
    pub inline: bool,
}

impl ServedUrl {
    /// A URL, with the never-inline rule applied to the media type the document
    /// reads its bytes as.
    #[must_use]
    pub fn of(url: &str, media_type: Option<&str>) -> Self {
        Self {
            url: url.to_owned(),
            // NO TYPE IS NOT PERMISSION. A document whose representation this
            // vault cannot read is offered, never embedded: the whole reason
            // the list exists is that the bytes may be authored by someone else.
            inline: media_type.is_some_and(may_serve_inline),
        }
    }
}

/// Bytes that landed, as `core.add_document`'s `staged_sha` takes them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedBlob {
    /// 64 lowercase hex characters. The sha of the RAW DECODED bytes — never of
    /// a `data:` URI — which is also what fixed v0's old dedup hole (the same
    /// bytes under two declared mime types were two rows).
    pub sha256: String,
    pub byte_size: usize,
    pub media_type: String,
}

impl StagedBlob {
    /// Whether this sha has the shape a claim will accept.
    ///
    /// `core.add_document`'s input schema pins `minLength: 64, maxLength: 64`
    /// and `core_content_item.sha256`'s own CHECK pins the alphabet; a surface
    /// that hands the command a truncated sha gets a schema refusal, and this
    /// is how it can say so first.
    #[must_use]
    pub fn sha_is_well_formed(&self) -> bool {
        self.sha256.len() == 64
            && self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }
}

/// THE ONE DOOR BYTES RIDE.
///
/// The implementations are the seat's `centraid://` handler over
/// `crates/media`'s store, and a test double. An app crate holds this trait and
/// nothing that holds a file.
pub trait ByteDoor {
    /// The decoded text of a content item, bounded by the request.
    fn read_text(&self, request: &ByteRequest) -> Reading<String>;
    /// A URL a surface can hand to a viewer.
    fn url(&self, request: &ByteRequest) -> Reading<ServedUrl>;
    /// Bytes in. The door writes them; this answers what to claim.
    fn stage(&self, request: &ByteRequest, bytes: &[u8]) -> Reading<StagedBlob>;
}

/// The door is not there — a thin seat with no gateway, a shell with no handler.
///
/// A [`Reading::Denied`] rather than an `Err`, because "we cannot reach the
/// bytes" is a state a viewer renders and not a screen that fails.
#[must_use]
pub fn door_unavailable(detail: &str) -> Denial {
    Denial {
        code: Some("BYTE_DOOR_UNAVAILABLE".to_owned()),
        message: Some(detail.to_owned()),
        revoked_at: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #865, AND IT IS DOCS' CASE IN PARTICULAR: a shared document's bytes are
    /// authored by someone else, and three media types are executed by a
    /// browser in the embedding page's origin.
    #[test]
    fn the_three_executable_types_never_ride_a_quick_look() {
        for media_type in NEVER_INLINE {
            assert!(!may_serve_inline(media_type), "{media_type}");
            let refused = ByteRequest::read_text("c1", media_type, 10)
                .expect_err("a quick look of executable bytes is refused at the request");
            assert!(matches!(refused, ByteRefusal::NeverInline { .. }));
            // And a parameter on the type does not smuggle it through.
            assert!(!may_serve_inline(&format!("{media_type}; charset=utf-8")));
            assert!(!may_serve_inline(&media_type.to_ascii_uppercase()));
        }
        // A plain text body is fine, and so is a PDF in a viewer.
        assert!(may_serve_inline("text/plain"));
        assert!(may_serve_inline("application/pdf"));
        assert!(ByteRequest::read_text("c1", "text/plain; charset=utf-8", 10).is_ok());
    }

    /// NO TYPE IS NOT PERMISSION: a document whose representation this vault
    /// cannot read is offered as a download, never embedded.
    #[test]
    fn an_unknown_media_type_is_not_embeddable() {
        assert!(!ServedUrl::of("centraid://blob/c1", None).inline);
        assert!(ServedUrl::of("centraid://blob/c1", Some("image/png")).inline);
        assert!(!ServedUrl::of("centraid://blob/c1", Some("image/svg+xml")).inline);
    }

    /// A QUICK LOOK IS A GLANCE, and the bound is the one a command enforces.
    #[test]
    fn a_quick_look_is_bounded_by_the_inline_body_budget() {
        assert_eq!(MAX_QUICK_LOOK_BYTES, 64 * 1024);
        let request = ByteRequest::read_text("c1", "text/plain", 1_000).expect("a small body");
        assert_eq!(
            request,
            ByteRequest::ReadText {
                content_id: "c1".to_owned(),
                limit: MAX_QUICK_LOOK_BYTES,
            }
        );
        let refused = ByteRequest::read_text("c1", "text/plain", MAX_QUICK_LOOK_BYTES + 1)
            .expect_err("over the glance");
        assert!(matches!(refused, ByteRefusal::TooLargeToGlance { .. }));
        assert!(refused.to_string().contains("open the document instead"));
    }

    #[test]
    fn a_staged_sha_has_the_shape_a_claim_accepts() {
        let good = StagedBlob {
            sha256: "ab".repeat(32),
            byte_size: 12,
            media_type: "application/pdf".to_owned(),
        };
        assert!(good.sha_is_well_formed());
        for bad in [
            "",
            "AB".repeat(32).as_str(),
            "ab".repeat(31).as_str(),
            "zz".repeat(32).as_str(),
        ] {
            let blob = StagedBlob {
                sha256: bad.to_owned(),
                ..good.clone()
            };
            assert!(!blob.sha_is_well_formed(), "{bad} should not pass");
        }
    }

    #[test]
    fn a_url_request_carries_the_documents_own_reading_of_the_bytes() {
        let request = ByteRequest::url("c1", Some("application/pdf"));
        assert_eq!(request.content_id(), Some("c1"));
        let staging = ByteRequest::Stage {
            media_type: "application/pdf".to_owned(),
            byte_size: 9,
            original_name: None,
        };
        assert_eq!(staging.content_id(), None, "staged bytes have no id yet");
    }
}
