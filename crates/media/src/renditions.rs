//! The two derived renditions a gateway makes of an image (#1025 S3,
//! D-1025-S7-50).
//!
//! ## The defect this exists for
//!
//! The tier ladder in `centraid_blobs::plan` — every thumbnail, then every
//! preview, then originals — was real, and **nothing in the product ever
//! produced a thumbnail**. `core_content_derivative` held `thumb`, `preview`
//! and `poster` in the DDL; the seat's `needed_blobs` asked for them first; the
//! page read's `held_thumbnail` fell back through `thumb` → `poster` →
//! original. Every one of those layers was correct and every one of them was
//! reading an empty table, so "thumbnails always" fetched nothing on a real
//! roll of multi-megabyte originals and a freshly paired phone showed an empty
//! grid until an unmetered window moved whole originals. The demo seeder hid it
//! by shipping originals that are already 360 px.
//!
//! ## What this module is, and is not
//!
//! It is **pure**: bytes in, bytes out. No store, no database, no filesystem.
//! The caller — `centraid_vault`'s mint path, which is the gateway's commit
//! path and the only writer — puts the bytes in the CAS and writes the rows.
//!
//! The two renditions, and why these numbers:
//!
//! | variant   | long edge | format |
//! |-----------|-----------|--------|
//! | `thumb`   | 360 px    | JPEG q80 |
//! | `preview` | 2048 px   | JPEG q80 |
//!
//! `thumb` is a grid cell and 360 px is v0's own number (`docs/photos/`), which
//! covers a 3× 120 pt cell. `preview` is a full-screen view on a phone or a
//! laptop without the original's weight.
//!
//! **JPEG and not WebP.** The ruling allowed WebP "if a dependency already in
//! the workspace supports it". The `image` crate decodes WebP and, since 0.25,
//! **has no WebP encoder at all** — so WebP would cost a second dependency.
//! JPEG is the free option and it is the one taken; there is nothing here for a
//! future WebP pass to unpick beyond the two `image::ImageFormat` values.
//!
//! **Orientation is applied before scaling.** A camera writes the sensor's
//! pixels and an EXIF tag saying which way up they were, and a thumbnail that
//! ignores the tag is sideways — the first thing a member notices and the
//! easiest thing to leave broken, because a 4:3 image rotated to 3:4 still
//! *looks* like a thumbnail in a test that only checks the file decodes.
//!
//! **Metadata does not survive.** A derivative is re-encoded from decoded
//! pixels, so EXIF, XMP and ICC are gone by construction rather than by a strip
//! pass that could be forgotten. That is a privacy property and not a size one:
//! `thumb` is the rendition that travels first, over any link, to any admitted
//! device, and a thumbnail carrying the GPS coordinates of a member's home is
//! worse than no thumbnail.
//!
//! **A file that will not decode produces nothing.** [`renditions_of`] returns
//! an empty vector, never an error the commit could fail on. The original is
//! still committed, `held_thumbnail` still falls back to it, and the caller
//! logs. An unsupported format is not a broken vault.

use image::{ImageDecoder, ImageReader, imageops::FilterType};

/// The long edge of a `thumb`, in pixels.
pub const THUMB_EDGE: u32 = 360;
/// The long edge of a `preview`, in pixels.
pub const PREVIEW_EDGE: u32 = 2048;
/// The JPEG quality every derivative is written at.
pub const JPEG_QUALITY: u8 = 80;
/// The media type every derivative carries.
pub const DERIVATIVE_MEDIA_TYPE: &str = "image/jpeg";

/// One derived rendition, ready for the CAS and a row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendition {
    /// The `core_content_derivative.variant`: `thumb` or `preview`.
    pub variant: &'static str,
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Whether this media type is one the gateway derives from.
///
/// **A declared type and not a sniff.** The door that took these bytes already
/// decided what they are, and a deriver that disagreed with the row would be a
/// second opinion stored nowhere. `image/svg+xml` is excluded by name: it is a
/// document a renderer executes, this crate has no rasteriser for it, and
/// `content_urls` already refuses to call it embeddable (D-1025-S7-20).
#[must_use]
pub fn is_derivable(media_type: &str) -> bool {
    let base = media_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    matches!(
        base.as_str(),
        "image/jpeg" | "image/jpg" | "image/png" | "image/gif" | "image/webp"
    )
}

/// The renditions to store for these bytes, largest tier last.
///
/// Empty when the bytes do not decode, when the media type is not derivable, or
/// when the image is degenerate (a zero dimension). **Never an error**: see the
/// module note — a thumbnail that could not be made must not cost the member
/// the original.
///
/// A rendition is produced even when the source is already smaller than the
/// tier's edge. It is then a re-encode at the source's own size, which is
/// honest: the tier exists so a seat can fetch a grid before it fetches a roll,
/// and a `thumb` row that is missing because the original happened to be small
/// makes the planner's first tier depend on the camera.
#[must_use]
pub fn renditions_of(bytes: &[u8], media_type: &str) -> Vec<Rendition> {
    if !is_derivable(media_type) {
        return Vec::new();
    }
    let Some(source) = decode_upright(bytes) else {
        return Vec::new();
    };
    let (width, height) = (source.width(), source.height());
    if width == 0 || height == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(2);
    for (variant, edge) in [("thumb", THUMB_EDGE), ("preview", PREVIEW_EDGE)] {
        // `thumbnail_exact`-style aspect preservation: `resize` fits INSIDE the
        // box, so a 4000x3000 original at 360 is 360x270 and a portrait one is
        // 270x360. Lanczos3 because the grid is the product and a box filter
        // shows on a 3× display.
        let scaled = if width.max(height) <= edge {
            source.clone()
        } else {
            source.resize(edge, edge, FilterType::Lanczos3)
        };
        let Some(encoded) = encode_jpeg(&scaled) else {
            // An encoder that refuses one tier must not cost the other.
            continue;
        };
        out.push(Rendition {
            variant,
            bytes: encoded,
            width: scaled.width(),
            height: scaled.height(),
        });
    }
    out
}

/// Decode, then turn the pixels the way the camera held it.
///
/// The orientation tag is read from the DECODER, before the pixels are taken:
/// `image` exposes it per format (EXIF for JPEG, eXIf for PNG/WebP) and
/// `DynamicImage::apply_orientation` is the transform. A decoder with no
/// opinion means `NoTransforms`, which is the correct reading for a format that
/// has no orientation concept.
fn decode_upright(bytes: &[u8]) -> Option<image::DynamicImage> {
    let reader = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut decoded = image::DynamicImage::from_decoder(decoder).ok()?;
    decoded.apply_orientation(orientation);
    Some(decoded)
}

/// JPEG at [`JPEG_QUALITY`], from RGB8.
///
/// **RGB8 and not RGBA.** JPEG has no alpha, and the encoder's own answer to an
/// RGBA input is an error rather than a flatten — which would mean a PNG with a
/// transparent corner silently has no thumbnail. Flattening onto the decoded
/// colour is this module's decision to make, and `to_rgb8` makes it.
fn encode_jpeg(image: &image::DynamicImage) -> Option<Vec<u8>> {
    let rgb = image.to_rgb8();
    let mut out = Vec::new();
    let encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::Cursor::new(&mut out), JPEG_QUALITY);
    image::DynamicImage::ImageRgb8(rgb)
        .write_with_encoder(encoder)
        .ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_media_type_that_is_not_an_image_derives_nothing() {
        assert!(!is_derivable("video/mp4"));
        assert!(!is_derivable("image/svg+xml"));
        assert!(!is_derivable("application/pdf"));
        assert!(is_derivable("image/jpeg"));
        assert!(is_derivable("IMAGE/PNG; charset=binary"));
    }

    #[test]
    fn bytes_that_do_not_decode_derive_nothing_and_do_not_error() {
        assert!(renditions_of(b"not an image at all", "image/jpeg").is_empty());
    }
}
