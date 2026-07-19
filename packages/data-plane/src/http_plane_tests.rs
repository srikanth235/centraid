use axum::http::HeaderValue;
use image::{GenericImageView, Rgb, RgbImage, codecs::jpeg::JpegEncoder};

use super::{parse_range, render_preview};

#[test]
fn rejects_a_zero_length_suffix_range() {
    let value = HeaderValue::from_static("bytes=-0");
    assert_eq!(parse_range(Some(&value), 100), None);
}

#[test]
fn preview_applies_exif_orientation_before_resize() {
    let source = RgbImage::from_fn(2, 1, |x, _| {
        if x == 0 {
            Rgb([255, 0, 0])
        } else {
            Rgb([0, 0, 255])
        }
    });
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&source)
        .unwrap();

    // EXIF/TIFF little-endian orientation=6 (rotate 90° clockwise).
    let exif = [
        b'E', b'x', b'i', b'f', 0, 0, b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0,
        0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ];
    let segment_len = u16::try_from(exif.len() + 2).unwrap().to_be_bytes();
    let mut oriented = Vec::with_capacity(jpeg.len() + exif.len() + 4);
    oriented.extend_from_slice(&jpeg[..2]);
    oriented.extend_from_slice(&[0xff, 0xe1, segment_len[0], segment_len[1]]);
    oriented.extend_from_slice(&exif);
    oriented.extend_from_slice(&jpeg[2..]);

    let preview = image::load_from_memory(&render_preview(&oriented, 100).unwrap()).unwrap();
    assert_eq!(preview.dimensions(), (1, 2));
}
