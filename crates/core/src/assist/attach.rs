//! ATTACHMENTS, RESOLVED: from what a shell names to what the plane reads.
//!
//! A shell attaches by NAME: an asset id from Photos, a document id from Docs,
//! or the bytes of a camera-roll item it picked itself. This module turns each
//! into the plane's [`Attachments`] and refuses, with a typed [`Refusal`], what
//! the chat does not read.
//!
//! * **A vault photograph** is read through the byte plane's own lookup
//!   ([`centraid_vault::Vault::attachment_photo`]): the 2048-pixel `preview`
//!   derivative first, the original only when it is not enormous, the
//!   thumbnail last. A photograph's bytes are a file the platform could open;
//!   the core opens it here, once, decodes it and drops it.
//! * **Raw image bytes** are decoded the same way and held to the same limits.
//! * **A document** is its current revision's decoded text, when it is
//!   `text/plain` or `text/markdown`.
//!
//! Every image ends as 8-bit RGB scaled to at most
//! [`IMAGE_MAX_EDGE`](centraid_assist::attach::IMAGE_MAX_EDGE) pixels on its long
//! edge (the model reads one token per 32x32 pixels, so that is the cost cap
//! on both time and context), with EXIF orientation applied and alpha flattened.
//! No image, decoded or not, is written anywhere or logged: the types here have
//! no `Debug` that prints pixels, and an error carries a reason, never bytes.
//!
//! **Locker is never an attachment**, structurally: the only ids read are
//! `media.asset` and `core.document`, and no Locker item is either.
//!
//! # OFF IN THE SHIPPED BUILD (R-1088-19)
//!
//! [`OFFERED`] is the one switch. The shipped model (S2) was fine-tuned on the tool format and
//! cannot describe a photograph or a document: given the projector's image it writes a tool call
//! and runs to the length cap. So the core refuses a request that carries an attachment with
//! [`Refusal::AttachmentUnsupported`], never loads the vision projector, and the shells do not
//! draw the attach control (`ChatMachine.ATTACHMENTS_OFFERED`, which flips with this). Everything
//! below stays, tested, for the model that can read them.

use centraid_api_proto::core_v1 as wire;
use centraid_assist::Refusal;
use centraid_assist::attach::{Attachments, IMAGE_MAX_EDGE, ImageData, TextDoc, label};
use centraid_vault::content::{DocumentSource, PhotoSource};
use image::imageops::FilterType;

use crate::error::{CoreError, Result};
use crate::handle::Handle;

/// WHETHER THE CHAT TAKES ATTACHMENTS AT ALL: `false`, because the shipped model cannot describe a
/// file (R-1088-19). While it is, a send that carries one is refused
/// [`Refusal::AttachmentUnsupported`] before anything is resolved or generated, and a load
/// attaches no vision projector. Every handle starts from it ([`super::Hub::attachments_offered`]).
/// Flip it together with the shells' `ChatMachine.ATTACHMENTS_OFFERED` when a model that reads
/// attachments ships.
pub const OFFERED: bool = false;

/// The most bytes of an image the chat will take from a shell or a file.
pub const IMAGE_BYTES_MAX: usize = 25 * 1024 * 1024;

/// The most pixels it will decode: a panorama is fine, a decompression bomb is
/// not. 100 megapixels is ~300 MB as RGB, so the decoder's own allocation limit
/// below is what actually bounds a hostile header.
const PIXELS_MAX: u64 = 100_000_000;

fn invalid(detail: impl Into<String>) -> CoreError {
    CoreError::InvalidRequest {
        detail: detail.into(),
    }
}

/// Decode `bytes` as an image and scale it for the model.
///
/// # Errors
/// [`Refusal::AttachmentTooLarge`] over [`IMAGE_BYTES_MAX`] or [`PIXELS_MAX`];
/// [`Refusal::AttachmentUnreadable`] when the bytes are not an image this
/// decoder reads.
pub fn decode_image(bytes: &[u8], caption: &str) -> std::result::Result<ImageData, Refusal> {
    if bytes.len() > IMAGE_BYTES_MAX {
        return Err(Refusal::AttachmentTooLarge);
    }
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| Refusal::AttachmentUnreadable)?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| Refusal::AttachmentUnreadable)?;
    let (width, height) = image::ImageDecoder::dimensions(&decoder);
    if width == 0 || height == 0 {
        return Err(Refusal::AttachmentUnreadable);
    }
    if u64::from(width) * u64::from(height) > PIXELS_MAX {
        return Err(Refusal::AttachmentTooLarge);
    }
    let orientation = image::ImageDecoder::orientation(&mut decoder)
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut decoded =
        image::DynamicImage::from_decoder(decoder).map_err(|_| Refusal::AttachmentUnreadable)?;
    decoded.apply_orientation(orientation);
    let scaled = if decoded.width().max(decoded.height()) > IMAGE_MAX_EDGE {
        decoded.resize(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, FilterType::Triangle)
    } else {
        decoded
    };
    let rgb = scaled.to_rgb8();
    Ok(ImageData {
        width: rgb.width(),
        height: rgb.height(),
        rgb: rgb.into_raw(),
        label: label(caption),
    })
}

/// One photograph from the vault.
fn vault_photo(handle: &Handle, asset_id: &str) -> Result<std::result::Result<ImageData, Refusal>> {
    let source = handle.with_vault(|vault| Ok(vault.attachment_photo(asset_id)?))?;
    Ok(match source {
        PhotoSource::Held { path, title, .. } => {
            let size = std::fs::metadata(&path).map(|meta| meta.len());
            match size {
                Err(_) => Err(Refusal::AttachmentUnreadable),
                Ok(size) if size > IMAGE_BYTES_MAX as u64 => Err(Refusal::AttachmentTooLarge),
                Ok(_) => std::fs::read(&path)
                    .map_err(|_| Refusal::AttachmentUnreadable)
                    .and_then(|bytes| decode_image(&bytes, title.as_deref().unwrap_or_default())),
            }
        }
        PhotoSource::NotAnImage => Err(Refusal::AttachmentUnsupported),
        PhotoSource::NotHeld | PhotoSource::Missing => Err(Refusal::AttachmentUnreadable),
    })
}

/// One document from the vault.
fn vault_doc(handle: &Handle, doc_id: &str) -> Result<std::result::Result<TextDoc, Refusal>> {
    let source = handle.with_vault(|vault| Ok(vault.attachment_document(doc_id)?))?;
    Ok(match source {
        DocumentSource::Text { title, text } => Ok(TextDoc { name: title, text }),
        DocumentSource::Unsupported { .. } => Err(Refusal::AttachmentUnsupported),
        DocumentSource::TooLarge => Err(Refusal::AttachmentTooLarge),
        DocumentSource::Missing => Err(Refusal::AttachmentUnreadable),
    })
}

/// What a request's attachments name, validated: at most one image and one
/// document, each naming something.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a request the shell should not have made.
pub fn validate(attachments: &[wire::AssistAttachment]) -> Result<()> {
    let mut images = 0;
    let mut docs = 0;
    for attachment in attachments {
        match &attachment.kind {
            Some(wire::assist_attachment::Kind::VaultPhoto(photo)) => {
                if photo.asset_id.is_empty() {
                    return Err(invalid("a vault photo names no asset"));
                }
                images += 1;
            }
            Some(wire::assist_attachment::Kind::ImageBytes(_)) => images += 1,
            Some(wire::assist_attachment::Kind::VaultDoc(doc)) => {
                if doc.doc_id.is_empty() {
                    return Err(invalid("a vault document names no document"));
                }
                docs += 1;
            }
            None => return Err(invalid("an attachment names no kind")),
        }
    }
    if images > 1 || docs > 1 {
        return Err(invalid(
            "a message takes at most one photo and one document",
        ));
    }
    Ok(())
}

/// Resolve a request's attachments.
///
/// The outer `Err` is the request's fault ([`validate`]) or an unreadable
/// vault; the inner one is a typed refusal the chat draws.
///
/// # Errors
/// As above.
pub fn resolve(
    handle: &Handle,
    attachments: &[wire::AssistAttachment],
) -> Result<std::result::Result<Attachments, Refusal>> {
    validate(attachments)?;
    let mut out = Attachments::default();
    for attachment in attachments {
        match &attachment.kind {
            Some(wire::assist_attachment::Kind::VaultPhoto(photo)) => {
                match vault_photo(handle, &photo.asset_id)? {
                    Ok(image) => out.image = Some(image),
                    Err(refusal) => return Ok(Err(refusal)),
                }
            }
            Some(wire::assist_attachment::Kind::ImageBytes(picked)) => {
                let mime = picked.mime.to_ascii_lowercase();
                if !mime.starts_with("image/") {
                    return Ok(Err(Refusal::AttachmentUnsupported));
                }
                match decode_image(&picked.content, "") {
                    Ok(image) => out.image = Some(image),
                    Err(refusal) => return Ok(Err(refusal)),
                }
            }
            Some(wire::assist_attachment::Kind::VaultDoc(doc)) => {
                match vault_doc(handle, &doc.doc_id)? {
                    Ok(text) => out.doc = Some(text),
                    Err(refusal) => return Ok(Err(refusal)),
                }
            }
            None => {}
        }
    }
    Ok(Ok(out))
}

/// Whether the request attaches an image, which is what needs a projector.
#[must_use]
pub fn carries_image(attachments: &[wire::AssistAttachment]) -> bool {
    attachments.iter().any(|attachment| {
        matches!(
            attachment.kind,
            Some(
                wire::assist_attachment::Kind::VaultPhoto(_)
                    | wire::assist_attachment::Kind::ImageBytes(_)
            )
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut canvas = image::RgbaImage::new(width, height);
        for (x, y, pixel) in canvas.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x % 251) as u8, (y % 251) as u8, 120, 255]);
        }
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(canvas)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .expect("the fixture encodes");
        out
    }

    #[test]
    fn a_large_image_is_scaled_to_the_models_edge_keeping_its_shape() {
        let decoded = decode_image(&png(2000, 1000), "A wide one").unwrap();
        assert_eq!((decoded.width, decoded.height), (448, 224));
        assert_eq!(decoded.rgb.len(), 448 * 224 * 3);
        assert_eq!(decoded.label, "A wide one");
        let tall = decode_image(&png(300, 1200), "").unwrap();
        assert_eq!((tall.width, tall.height), (112, 448));
    }

    #[test]
    fn a_small_image_is_not_blown_up_and_alpha_is_flattened() {
        let decoded = decode_image(&png(64, 48), "").unwrap();
        assert_eq!((decoded.width, decoded.height), (64, 48));
        assert_eq!(decoded.rgb.len(), 64 * 48 * 3);
    }

    #[test]
    fn bytes_that_are_not_an_image_are_unreadable() {
        assert_eq!(
            decode_image(b"%PDF-1.7 not a picture", "").unwrap_err(),
            Refusal::AttachmentUnreadable
        );
        assert_eq!(
            decode_image(b"", "").unwrap_err(),
            Refusal::AttachmentUnreadable
        );
        // A truncated PNG: a header with no pixels behind it.
        let mut cut = png(64, 64);
        cut.truncate(40);
        assert_eq!(
            decode_image(&cut, "").unwrap_err(),
            Refusal::AttachmentUnreadable
        );
    }

    #[test]
    fn an_image_over_the_byte_ceiling_is_too_large_before_it_is_decoded() {
        let huge = vec![0u8; IMAGE_BYTES_MAX + 1];
        assert_eq!(
            decode_image(&huge, "").unwrap_err(),
            Refusal::AttachmentTooLarge
        );
    }

    #[test]
    fn a_request_takes_one_photo_and_one_document_and_each_must_name_something() {
        use wire::assist_attachment::Kind;
        let photo = |id: &str| wire::AssistAttachment {
            kind: Some(Kind::VaultPhoto(wire::AssistVaultPhoto {
                asset_id: id.to_owned(),
            })),
            label: String::new(),
        };
        let doc = |id: &str| wire::AssistAttachment {
            kind: Some(Kind::VaultDoc(wire::AssistVaultDoc {
                doc_id: id.to_owned(),
            })),
            label: String::new(),
        };
        let bytes = wire::AssistAttachment {
            kind: Some(Kind::ImageBytes(wire::AssistImageBytes::default())),
            label: String::new(),
        };
        assert!(validate(&[]).is_ok());
        assert!(validate(&[photo("a"), doc("d")]).is_ok());
        assert!(validate(&[photo("a"), photo("b")]).is_err());
        assert!(validate(&[photo("a"), bytes]).is_err());
        assert!(validate(&[doc("d"), doc("e")]).is_err());
        assert!(validate(&[photo("")]).is_err());
        assert!(validate(&[doc("")]).is_err());
        assert!(validate(&[wire::AssistAttachment::default()]).is_err());
        assert!(carries_image(&[photo("a")]));
        assert!(!carries_image(&[doc("d")]));
    }
}
