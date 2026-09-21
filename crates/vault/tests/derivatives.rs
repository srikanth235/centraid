//! THE GATEWAY MAKES THE TIERS (#1025 S3, D-1025-S7-50).
//!
//! The defect these tests pin: `core_content_derivative` was in the DDL, the
//! planner's tier ladder was real, `needed_blobs` asked for derivatives first
//! and `held_thumbnail` fell back through them — and nothing in the product
//! ever wrote one. So "thumbnails always" fetched nothing, and a freshly paired
//! phone looking at a roll of multi-megabyte originals saw an empty grid until
//! an unmetered window. Every test below is a sentence from the ruling.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::{Command, CommandStatus, Registry};

fn registry() -> Registry {
    Registry::with_system_commands().expect("the system commands register")
}

/// A JPEG of `width`x`height`, with an EXIF APP1 segment declaring
/// `orientation`.
///
/// Built rather than checked in: the file that matters is 4000x3000 and the tag
/// that matters is two bytes inside it, so a fixture in the tree would be a
/// megabyte nobody could read. The TIFF block is the minimum a decoder accepts
/// — little-endian header, one IFD entry (tag 0x0112, SHORT, value), no next
/// IFD.
fn jpeg_with_orientation(width: u32, height: u32, orientation: u16) -> Vec<u8> {
    let mut canvas = image::RgbImage::new(width, height);
    // Not flat: a solid colour survives every wrong rotation, so an assertion
    // about orientation could pass on a broken decode. A gradient cannot.
    for (x, y, pixel) in canvas.enumerate_pixels_mut() {
        *pixel = image::Rgb([
            (x * 255 / width.max(1)) as u8,
            (y * 255 / height.max(1)) as u8,
            64,
        ]);
    }
    let mut plain = Vec::new();
    image::DynamicImage::ImageRgb8(canvas)
        .write_to(
            &mut std::io::Cursor::new(&mut plain),
            image::ImageFormat::Jpeg,
        )
        .expect("the fixture encodes");

    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&42u16.to_le_bytes());
    tiff.extend_from_slice(&8u32.to_le_bytes());
    tiff.extend_from_slice(&1u16.to_le_bytes());
    tiff.extend_from_slice(&0x0112u16.to_le_bytes());
    tiff.extend_from_slice(&3u16.to_le_bytes());
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&orientation.to_le_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0u32.to_le_bytes());

    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(&tiff);
    let mut out = Vec::with_capacity(plain.len() + payload.len() + 4);
    out.extend_from_slice(&plain[..2]); // SOI
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(
        &u16::try_from(payload.len() + 2)
            .expect("a small segment")
            .to_be_bytes(),
    );
    out.extend_from_slice(&payload);
    out.extend_from_slice(&plain[2..]);
    out
}

fn data_uri(media_type: &str, bytes: &[u8]) -> String {
    use base64::Engine as _;
    format!(
        "data:{media_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new(seed: &str) -> Self {
        let scratch = common::Scratch::founded_with_blobs(seed).expect("a vault with a store");
        let registry = registry();
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        Self { scratch, registry }
    }

    /// THE GATEWAY'S OWN DOOR: the bytes are already in this device's store and
    /// staged, and the command names them by sha.
    ///
    /// This is the path a seat's upload takes — the gateway PULLS the blob over
    /// the symmetric loop, stages what it read, then executes the intent. It is
    /// also the only door a real photograph fits through: the inline `data:`
    /// door refuses anything over 360 000 base64 characters, which a 12 MP
    /// original is several times over.
    fn add_staged_asset(
        &self,
        media_type: &str,
        bytes: &[u8],
    ) -> centraid_vault::commands::CommandOutcome {
        let hash = self
            .scratch
            .vault
            .blobs()
            .expect("a store")
            .put(bytes)
            .expect("the bytes store");
        self.scratch
            .vault
            .stage_bytes(&[centraid_vault::content::NeededBytes {
                hash: hash.clone(),
                byte_size: i64::try_from(bytes.len()).expect("a small blob"),
                media_type: media_type.to_owned(),
            }])
            .expect("the staging row lands");
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(
                    "media.add_asset",
                    serde_json::json!({ "staged_sha": hash, "kind": "photo" }),
                ),
            )
            .expect("the command runs")
    }

    fn add_asset(
        &self,
        media_type: &str,
        bytes: &[u8],
    ) -> centraid_vault::commands::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(
                    "media.add_asset",
                    serde_json::json!({
                        "data_uri": data_uri(media_type, bytes),
                        "kind": "photo",
                    }),
                ),
            )
            .expect("the command runs")
    }

    fn blob_bytes(&self, hash: &str) -> Option<Vec<u8>> {
        self.scratch.vault.blobs()?.get(hash).ok()
    }

    /// `(variant, content_hash, media_type, byte_size)` for the binary tiers.
    fn tiers(&self) -> Vec<(String, String, String, i64)> {
        self.scratch
            .vault
            .read(|connection| {
                let mut statement = connection.prepare(
                    "SELECT variant, content_hash, media_type, byte_size
                       FROM core_content_derivative
                      WHERE variant IN ('thumb','preview','poster')
                      ORDER BY variant",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("the rows read")
    }
}

/// THE CASE THE RULING NAMES: a landscape original shot with the camera turned,
/// which EXIF calls orientation 6.
///
/// 4000x3000 pixels of sensor, a tag saying "rotate 90° clockwise", so the
/// upright image is 3000x4000 — portrait. The thumbnail must therefore be
/// 270x360 and the preview 1536x2048. A deriver that ignored the tag produces
/// 360x270 and 2048x1536, which still decode, still look like thumbnails in a
/// size assertion, and are sideways in the grid — which is the first thing a
/// member notices.
#[test]
fn an_exif_rotated_original_derives_upright_tiers_with_no_metadata() {
    let world = World::new("derive-exif");
    let bytes = jpeg_with_orientation(4000, 3000, 6);
    let outcome = world.add_staged_asset("image/jpeg", &bytes);
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{:?}",
        outcome.reason
    );

    let tiers = world.tiers();
    assert_eq!(
        tiers.len(),
        2,
        "one image commits one thumb and one preview: {tiers:?}"
    );
    let by_variant: std::collections::BTreeMap<_, _> = tiers
        .iter()
        .map(|(variant, hash, media_type, size)| {
            (variant.as_str(), (hash.clone(), media_type.clone(), *size))
        })
        .collect();

    for (variant, expected) in [("thumb", (270u32, 360u32)), ("preview", (1536, 2048))] {
        let (hash, media_type, byte_size) = by_variant
            .get(variant)
            .unwrap_or_else(|| panic!("a `{variant}` row"))
            .clone();
        assert_eq!(media_type, "image/jpeg", "`{variant}` is JPEG");
        assert_eq!(hash.len(), 64, "`{variant}` names a blake3 hash");
        let stored = world
            .blob_bytes(&hash)
            .unwrap_or_else(|| panic!("the `{variant}` blob is in the store"));
        assert_eq!(
            i64::try_from(stored.len()).expect("a small blob"),
            byte_size,
            "`{variant}`'s row says what the store holds"
        );
        let decoded = image::load_from_memory(&stored).expect("the derivative decodes");
        assert_eq!(
            (decoded.width(), decoded.height()),
            expected,
            "`{variant}` is upright: the tag said rotate, so the long edge is the height"
        );
        // METADATA DOES NOT SURVIVE. A re-encode from decoded pixels carries no
        // APP1, which is the privacy property: a thumbnail is the rendition
        // that travels first, to every admitted device, and one carrying the
        // GPS of a member's home is worse than no thumbnail.
        assert!(
            !contains_exif(&stored),
            "`{variant}` carries an EXIF segment"
        );
    }
}

/// Every APP1 marker in a JPEG, checked for the EXIF identifier. A `find` over
/// the raw bytes would hit `Exif` inside compressed scan data by chance.
fn contains_exif(jpeg: &[u8]) -> bool {
    let mut at = 2;
    while at + 4 <= jpeg.len() && jpeg[at] == 0xFF {
        let marker = jpeg[at + 1];
        if marker == 0xDA {
            return false; // start of scan: no more metadata segments
        }
        let length = usize::from(u16::from_be_bytes([jpeg[at + 2], jpeg[at + 3]]));
        if marker == 0xE1 && jpeg[at + 4..].starts_with(b"Exif\0\0") {
            return true;
        }
        at += 2 + length;
    }
    false
}

/// A PNG derives too, and both tiers come out JPEG.
///
/// The source format is not the derivative's format: the tier exists to be
/// small and to be one thing every renderer draws.
#[test]
fn a_png_original_derives_jpeg_tiers() {
    let world = World::new("derive-png");
    let mut canvas = image::RgbaImage::new(900, 600);
    for (x, y, pixel) in canvas.enumerate_pixels_mut() {
        // A transparent corner, deliberately: JPEG has no alpha, and an encoder
        // handed RGBA errors rather than flattening — which would mean a PNG
        // with transparency silently had no thumbnail.
        pixel.0 = [
            (x % 256) as u8,
            (y % 256) as u8,
            128,
            if x < 50 { 0 } else { 255 },
        ];
    }
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .expect("the fixture encodes");

    let outcome = world.add_asset("image/png", &png);
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{:?}",
        outcome.reason
    );

    let tiers = world.tiers();
    assert_eq!(tiers.len(), 2, "{tiers:?}");
    for (variant, hash, media_type, _) in &tiers {
        assert_eq!(media_type, "image/jpeg", "`{variant}`");
        let stored = world.blob_bytes(hash).expect("the blob is stored");
        let decoded = image::load_from_memory(&stored).expect("the derivative decodes");
        // 900x600 is under the preview edge, so the preview is a re-encode at
        // the source's own size; the thumb fits inside 360.
        let expected = if variant == "thumb" {
            (360, 240)
        } else {
            (900, 600)
        };
        assert_eq!((decoded.width(), decoded.height()), expected, "`{variant}`");
    }
}

/// AN UNDECODABLE ORIGINAL COSTS THE MEMBER NOTHING.
///
/// The commit succeeds, the original is in the library and in the store, and
/// there are no derivative rows — so `held_thumbnail`'s fallback to the
/// original's own hash is what draws the cell. Never fail the commit of a
/// photograph because a thumbnail failed.
#[test]
fn an_original_that_does_not_decode_commits_with_no_derivative_rows() {
    let world = World::new("derive-corrupt");
    // A real JPEG header over bytes that are not a JPEG.
    let mut corrupt = vec![0xFF, 0xD8, 0xFF, 0xE0];
    corrupt.extend_from_slice(b"this is not a photograph, it is a sentence");
    let outcome = world.add_asset("image/jpeg", &corrupt);
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "the original commits anyway: {:?}",
        outcome.reason
    );
    assert!(
        world.tiers().is_empty(),
        "no tiers for bytes that do not decode"
    );

    let originals: i64 = world
        .scratch
        .vault
        .read(|connection| {
            Ok(
                connection.query_row("SELECT COUNT(*) FROM core_content_item", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .expect("the count reads");
    assert_eq!(originals, 1, "the original is in the library");
}

/// A VIDEO GETS NO POSTER, and that is the recorded deferral (D-1025-S7-52).
///
/// A frame extractor is a native dependency this gateway does not carry.
/// `needed_blobs` and `held_thumbnail` already handle a missing poster.
#[test]
fn a_video_original_derives_nothing_in_this_build() {
    let world = World::new("derive-video");
    let outcome = world.add_asset("video/mp4", b"\0\0\0\x18ftypmp42not-really-a-video");
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{:?}",
        outcome.reason
    );
    assert!(world.tiers().is_empty());
}

/// THE BACKFILL IS IDEMPOTENT.
///
/// Two items are committed with their tiers, the tiers are deleted to stand for
/// a vault founded before this slice, and the sweep restores them. Run again,
/// it considers nothing and derives nothing — which is what makes it safe at
/// every gateway start.
#[test]
fn the_backfill_sweep_derives_once_and_then_nothing() {
    let world = World::new("derive-backfill");
    for size in [(800u32, 600u32), (640, 480)] {
        let bytes = jpeg_with_orientation(size.0, size.1, 1);
        let outcome = world.add_asset("image/jpeg", &bytes);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{:?}",
            outcome.reason
        );
    }
    assert_eq!(world.tiers().len(), 4, "two items, two tiers each");

    // A VAULT FOUNDED BEFORE THIS SLICE: rows and originals, no tiers.
    world
        .scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.fixture");
            tx.connection().execute(
                "DELETE FROM core_content_derivative WHERE variant IN ('thumb','preview')",
                [],
            )?;
            Ok(())
        })
        .expect("the tiers are removed");
    assert!(world.tiers().is_empty());

    let sweep = |world: &World| -> serde_json::Value {
        let outcome = world
            .scratch
            .vault
            .execute(
                &world.registry,
                &Principal::owner("this-gateway"),
                &Command::new("media.derive_missing", serde_json::json!({ "limit": 100 })),
            )
            .expect("the sweep runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{:?}",
            outcome.reason
        );
        outcome.output
    };

    let first = sweep(&world);
    assert_eq!(first["considered"], 2);
    assert_eq!(first["derived"], 2);
    assert_eq!(world.tiers().len(), 4, "the tiers are back");

    let second = sweep(&world);
    assert_eq!(second["considered"], 0, "a swept vault selects nothing");
    assert_eq!(second["derived"], 0);
    assert_eq!(world.tiers().len(), 4, "and writes nothing");
}

/// The same bytes committed twice derive once. `UNIQUE (content_id, variant)`
/// is the rule; the cheap existence check is what keeps the decode from
/// running at all.
#[test]
fn a_second_commit_of_known_bytes_re_derives_nothing() {
    let world = World::new("derive-dedupe");
    let bytes = jpeg_with_orientation(1200, 900, 1);
    world.add_asset("image/jpeg", &bytes);
    let before = world.tiers();
    world.add_asset("image/jpeg", &bytes);
    assert_eq!(
        before,
        world.tiers(),
        "the tiers are the ones already there"
    );
}
