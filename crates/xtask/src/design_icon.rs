//! THE APP ICON, FROM `design/tokens.toml` (#1173), by `cargo xtask design`.
//!
//! The board is `design/mockups/QuartersIcon.dc.html`: a squared circle of four
//! quarters around an open square heart, on a tile. The geometry is the board's,
//! on a 120 grid centred on (60, 60):
//!
//! * a circle of radius 34, cut on the diagonals by 5-unit gaps;
//! * an open square heart, 21.2 on a side with a 2-unit round-joined edge, whose
//!   corners sit on the cuts;
//! * the cuts and the heart are NOT drawn in a tile colour: each quarter is one
//!   polygon with the cuts and the heart already taken out, so the mark is
//!   see-through and sits on any surface (the same thing `CentraidMark` draws in
//!   Swift and Kotlin by erasing).
//!
//! The colours are `[brand]` (teal top, orange right, blue bottom, pink left)
//! and `[icon]` (the tiles, the tinted greys, the themed glyph).
//!
//! WHAT IS EMITTED
//!
//! * `design/icon/*.svg`: the masters (light with its hairline, dark, tinted,
//!   themed, and the bare mark).
//! * `mobile/iosApp/Resources/Assets.xcassets/AppIcon.appiconset`: the 1024
//!   universal icon in iOS 26's three appearances (any, dark, tinted). These are
//!   opaque full-bleed squares: the system draws the mask and the edge, so the
//!   white tile's hairline is a master-SVG detail only.
//! * Android, all vector, no raster: an adaptive icon (`mipmap-anydpi-v26`) with
//!   a foreground drawable, a background colour and a `monochrome` layer for
//!   themed icons, and a vector fallback for API 24 and 25 (`mipmap-anydpi`),
//!   the app's `minSdk`, which have no adaptive icons.
//!
//! The PNGs are rasterised here by supersampling the same shape test the
//! polygons describe, and written with the `png` crate (already in the lock, via
//! `image`), so the gate needs no system tool.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use anyhow::{Context, Result};
use centraid_design::tokens::Tokens;

const GRID: f64 = 120.0;
const CENTRE: f64 = 60.0;
const RADIUS: f64 = 34.0;
const CUT_WIDTH: f64 = 5.0;
const HEART_SIDE: f64 = 21.2;
const HEART_STROKE: f64 = 2.0;
const TILE_RADIUS: f64 = 27.0;
const ICON_PX: u32 = 1024;
/// Supersampling per axis for the PNGs: 4 x 4 samples a pixel.
const SAMPLES: u32 = 4;

const SVG_DIR: &str = "design/icon";
const APPICON_SET: &str = "mobile/iosApp/Resources/Assets.xcassets/AppIcon.appiconset";
const ANDROID_RES: &str = "mobile/androidApp/src/main/res";

/// The directories whose every file this module writes.
pub const OWNED: [&str; 2] = [SVG_DIR, APPICON_SET];

/// The four quarters, in the board's drawing order, with the `[brand]` key of
/// each and its quarter turns clockwise from the right-hand quarter.
const QUARTERS: [(&str, u32); 4] = [("orange", 0), ("blue", 1), ("pink", 2), ("teal", 3)];

/// Half of a cut, measured along an axis: a cut 5 wide on a diagonal is 2.5 either
/// side of it, which is `2.5 * sqrt(2)` along a horizontal or vertical line.
fn cut_offset() -> f64 {
    CUT_WIDTH / 2.0 * std::f64::consts::SQRT_2
}

/// How far the heart reaches from the centre: half its side, plus half its edge.
fn heart_reach() -> f64 {
    HEART_SIDE / 2.0 + HEART_STROKE / 2.0
}

/// The right-hand quarter's four corners in grid units about the centre, y down:
/// the two on the heart, and the two where the cuts meet the circle. Between the
/// last two the edge is the circle's arc.
fn right_quarter() -> [(f64, f64); 4] {
    let d = cut_offset();
    let h = heart_reach();
    // Where the line v = u - d meets u^2 + v^2 = r^2.
    let u = (d + (2.0 * RADIUS * RADIUS - d * d).sqrt()) / 2.0;
    [(h, -(h - d)), (u, -(u - d)), (u, u - d), (h, h - d)]
}

/// Turn a point `turns` quarter turns clockwise on the screen (y down).
fn turn((x, y): (f64, f64), turns: u32) -> (f64, f64) {
    (0..turns).fold((x, y), |(x, y), _| (-y, x))
}

/// A quarter's corners about the centre, in grid units.
fn quarter(turns: u32) -> [(f64, f64); 4] {
    right_quarter().map(|point| turn(point, turns))
}

/// Which quarter holds the point `(u, v)` about the centre, if any: inside the
/// circle, outside the cuts, outside the heart. The same shape as [`quarter`].
fn quarter_at(u: f64, v: f64) -> Option<usize> {
    if u * u + v * v > RADIUS * RADIUS
        || (u.abs() - v.abs()).abs() < cut_offset()
        || u.abs().max(v.abs()) < heart_reach()
    {
        return None;
    }
    let turns = if u.abs() > v.abs() {
        if u > 0.0 { 0 } else { 2 }
    } else if v > 0.0 {
        1
    } else {
        3
    };
    QUARTERS.iter().position(|(_, quarter)| *quarter == turns)
}

// --- Colours ---------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Variant {
    Light,
    Dark,
    Tinted,
}

/// A tile and its four quarter colours, in [`QUARTERS`] order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Palette {
    pub tile: String,
    pub quarters: [String; 4],
}

fn brand(tokens: &Tokens, key: &str) -> Result<String> {
    tokens
        .brand
        .get(key)
        .cloned()
        .with_context(|| format!("[brand] has no {key}"))
}

/// The palette of an iOS appearance.
pub fn palette(tokens: &Tokens, variant: Variant) -> Result<Palette> {
    let icon = &tokens.icon;
    let brands = || -> Result<[String; 4]> {
        Ok([
            brand(tokens, QUARTERS[0].0)?,
            brand(tokens, QUARTERS[1].0)?,
            brand(tokens, QUARTERS[2].0)?,
            brand(tokens, QUARTERS[3].0)?,
        ])
    };
    Ok(match variant {
        Variant::Light => Palette {
            tile: icon.light_tile.clone(),
            quarters: brands()?,
        },
        Variant::Dark => Palette {
            tile: icon.dark_tile.clone(),
            quarters: brands()?,
        },
        Variant::Tinted => Palette {
            tile: icon.tinted_tile.clone(),
            // ONE GREY: the system recolours by luminance, and the cuts keep the quarters apart.
            quarters: [
                icon.tinted_mark.clone(),
                icon.tinted_mark.clone(),
                icon.tinted_mark.clone(),
                icon.tinted_mark.clone(),
            ],
        },
    })
}

/// How much the iOS icon's mark is grown: its disc (a circle of radius [`RADIUS`]) to
/// `ios_mark_share` of the tile.
fn ios_scale(tokens: &Tokens) -> f64 {
    tokens.icon.ios_mark_share * GRID / (2.0 * RADIUS)
}

fn rgb(hex: &str) -> Result<[u8; 3]> {
    let digits = hex.strip_prefix('#').unwrap_or(hex);
    anyhow::ensure!(digits.len() == 6, "{hex} is not #RRGGBB");
    let byte = |at: usize| {
        u8::from_str_radix(&digits[at..at + 2], 16).with_context(|| format!("{hex} is not hex"))
    };
    Ok([byte(0)?, byte(2)?, byte(4)?])
}

// --- SVG and Android paths ---------------------------------------------------

fn num(value: f64) -> String {
    let text = format!("{value:.3}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text.is_empty() || text == "-0" {
        "0".to_owned()
    } else {
        text.to_owned()
    }
}

/// A quarter's outline as SVG path data, mapped `grid -> offset + scale * grid`.
fn path_data(turns: u32, offset: f64, scale: f64) -> String {
    let at = |(x, y): (f64, f64)| {
        format!(
            "{} {}",
            num(offset + (CENTRE + x) * scale),
            num(offset + (CENTRE + y) * scale)
        )
    };
    let [a, b, c, d] = quarter(turns);
    let r = num(RADIUS * scale);
    format!(
        "M{} L{} A{r} {r} 0 0 1 {} L{} Z",
        at(a),
        at(b),
        at(c),
        at(d)
    )
}

fn svg_open(view_box: &str, size: Option<u32>) -> String {
    let dimensions = size.map_or(String::new(), |px| {
        format!(" width=\"{px}\" height=\"{px}\"")
    });
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\"{dimensions} viewBox=\"{view_box}\" role=\"img\" aria-label=\"Centraid\">\n"
    )
}

/// One master SVG: the tile (rounded, 27 radius), the hairline when given, and
/// the four see-through quarters, grown about the centre by `scale`.
fn tile_svg(palette: &Palette, edge: Option<&str>, scale: f64) -> String {
    let mut out = svg_open("0 0 120 120", Some(1024));
    let _ = writeln!(
        out,
        "  <rect width=\"120\" height=\"120\" rx=\"{}\" fill=\"{}\"/>",
        num(TILE_RADIUS),
        palette.tile
    );
    if let Some(edge) = edge {
        let _ = writeln!(
            out,
            "  <rect x=\".75\" y=\".75\" width=\"118.5\" height=\"118.5\" rx=\"{}\" fill=\"none\" stroke=\"{edge}\" stroke-width=\"1.5\"/>",
            num(TILE_RADIUS - 0.5)
        );
    }
    for ((_, turns), colour) in QUARTERS.iter().zip(&palette.quarters) {
        let _ = writeln!(
            out,
            "  <path d=\"{}\" fill=\"{colour}\"/>",
            path_data(*turns, CENTRE * (1.0 - scale), scale)
        );
    }
    out.push_str("</svg>\n");
    out
}

/// The bare mark, cropped to its own extent (the viewBox `22 22 76 76`).
fn mark_svg(palette: &Palette) -> String {
    let mut out = svg_open("22 22 76 76", Some(1024));
    for ((_, turns), colour) in QUARTERS.iter().zip(&palette.quarters) {
        let _ = writeln!(
            out,
            "  <path d=\"{}\" fill=\"{colour}\"/>",
            path_data(*turns, 0.0, 1.0)
        );
    }
    out.push_str("</svg>\n");
    out
}

/// A vector drawable of `viewport` units holding the quarters mapped by
/// `offset` and `scale`, each in its own colour.
fn vector_xml(
    viewport: u32,
    leading: &str,
    offset: f64,
    scale: f64,
    colours: &[String; 4],
) -> String {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n");
    out.push_str(GENERATED_XML);
    let _ = writeln!(
        out,
        "<vector xmlns:android=\"http://schemas.android.com/apk/res/android\"\n    android:width=\"{viewport}dp\"\n    android:height=\"{viewport}dp\"\n    android:viewportWidth=\"{viewport}\"\n    android:viewportHeight=\"{viewport}\">"
    );
    out.push_str(leading);
    for ((_, turns), colour) in QUARTERS.iter().zip(colours) {
        let _ = writeln!(
            out,
            "    <path\n        android:fillColor=\"{colour}\"\n        android:pathData=\"{}\" />",
            path_data(*turns, offset, scale)
        );
    }
    out.push_str("</vector>\n");
    out
}

const GENERATED_XML: &str = "<!-- Generated by `cargo xtask design` from design/tokens.toml ([brand], [icon]). Do not edit. -->\n";

fn fill_path(colour: &str, data: &str) -> String {
    format!(
        "    <path\n        android:fillColor=\"{colour}\"\n        android:pathData=\"{data}\" />\n"
    )
}

/// The adaptive icon: a 108dp canvas, the mark sized to the 66dp SAFE ZONE at its centre. The
/// system masks the outer 18dp on every side as it likes (a circle, a squircle), and never clips
/// the 66dp circle, so the mark's disc (a circle of radius [`RADIUS`] on the board's grid) is
/// drawn exactly that wide, centred on (54, 54).
const ADAPTIVE_SAFE_DP: f64 = 66.0;
const ADAPTIVE_CANVAS_DP: f64 = 108.0;
const ADAPTIVE_SCALE: f64 = ADAPTIVE_SAFE_DP / (2.0 * RADIUS);
const ADAPTIVE_OFFSET: f64 = ADAPTIVE_CANVAS_DP / 2.0 - CENTRE * ADAPTIVE_SCALE;

fn adaptive_xml() -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{GENERATED_XML}<adaptive-icon xmlns:android=\"http://schemas.android.com/apk/res/android\">\n    <background android:drawable=\"@color/ic_launcher_background\" />\n    <foreground android:drawable=\"@drawable/ic_launcher_foreground\" />\n    <monochrome android:drawable=\"@drawable/ic_launcher_monochrome\" />\n</adaptive-icon>\n"
    )
}

fn background_xml(tile: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{GENERATED_XML}<resources>\n    <color name=\"ic_launcher_background\">{tile}</color>\n</resources>\n"
    )
}

/// The icon for API 24 and 25, which have no adaptive icons: the whole tile as
/// one vector, rounded or, for the round icon, a circle.
fn legacy_xml(palette: &Palette, round: bool) -> String {
    let tile = if round {
        "M60,0 A60,60 0 1 1 60,120 A60,60 0 1 1 60,0 Z".to_owned()
    } else {
        let r = num(TILE_RADIUS);
        format!(
            "M{r},0 H{} A{r},{r} 0 0 1 120,{r} V{} A{r},{r} 0 0 1 {},120 H{r} A{r},{r} 0 0 1 0,{} V{r} A{r},{r} 0 0 1 {r},0 Z",
            num(GRID - TILE_RADIUS),
            num(GRID - TILE_RADIUS),
            num(GRID - TILE_RADIUS),
            num(GRID - TILE_RADIUS),
        )
    };
    vector_xml(
        120,
        &fill_path(&palette.tile, &tile),
        0.0,
        1.0,
        &palette.quarters,
    )
}

// --- The PNGs --------------------------------------------------------------

/// The colour of one sample at a grid point, tile when the point is on no quarter.
fn sample(palette: &[[u8; 3]; 5], scale: f64, x: f64, y: f64) -> [u8; 3] {
    match quarter_at((x - CENTRE) / scale, (y - CENTRE) / scale) {
        Some(at) => palette[at + 1],
        None => palette[0],
    }
}

/// An opaque, full-bleed square of `size` pixels in `palette`: the tile fills the
/// canvas (iOS masks it) and the mark sits on the 120 grid grown about the centre by `scale`.
pub fn render(palette: &Palette, scale: f64, size: u32) -> Result<Vec<u8>> {
    let mut colours = [[0u8; 3]; 5];
    colours[0] = rgb(&palette.tile)?;
    for (slot, hex) in colours[1..].iter_mut().zip(&palette.quarters) {
        *slot = rgb(hex)?;
    }
    let step = GRID / f64::from(size);
    let mut pixels = Vec::with_capacity((size * size * 3) as usize);
    for row in 0..size {
        for column in 0..size {
            // Every feature is many pixels wide, so a pixel whose four corners
            // agree is flat: skip the supersampling there (most of the canvas).
            let (left, top) = (f64::from(column) * step, f64::from(row) * step);
            let corners = [
                sample(&colours, scale, left, top),
                sample(&colours, scale, left + step, top),
                sample(&colours, scale, left, top + step),
                sample(&colours, scale, left + step, top + step),
            ];
            if corners.iter().all(|corner| *corner == corners[0]) {
                pixels.extend_from_slice(&corners[0]);
                continue;
            }
            let mut sum = [0u32; 3];
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let x = (f64::from(column) + (f64::from(sx) + 0.5) / f64::from(SAMPLES)) * step;
                    let y = (f64::from(row) + (f64::from(sy) + 0.5) / f64::from(SAMPLES)) * step;
                    let colour = sample(&colours, scale, x, y);
                    for (total, part) in sum.iter_mut().zip(colour) {
                        *total += u32::from(part);
                    }
                }
            }
            let count = SAMPLES * SAMPLES;
            for total in sum {
                // Rounded to nearest; at most 255.
                pixels.push(u8::try_from((total + count / 2) / count).unwrap_or(u8::MAX));
            }
        }
    }
    Ok(pixels)
}

/// Encode 8-bit RGB pixels as a PNG, deterministically.
fn encode_png(pixels: &[u8], size: u32) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, size, size);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::High);
        let mut writer = encoder.write_header().context("png header")?;
        writer.write_image_data(pixels).context("png data")?;
    }
    Ok(out)
}

fn appiconset_json() -> String {
    "{\n  \"images\" : [\n    {\n      \"filename\" : \"AppIcon-Light.png\",\n      \"idiom\" : \"universal\",\n      \"platform\" : \"ios\",\n      \"size\" : \"1024x1024\"\n    },\n    {\n      \"appearances\" : [\n        {\n          \"appearance\" : \"luminosity\",\n          \"value\" : \"dark\"\n        }\n      ],\n      \"filename\" : \"AppIcon-Dark.png\",\n      \"idiom\" : \"universal\",\n      \"platform\" : \"ios\",\n      \"size\" : \"1024x1024\"\n    },\n    {\n      \"appearances\" : [\n        {\n          \"appearance\" : \"luminosity\",\n          \"value\" : \"tinted\"\n        }\n      ],\n      \"filename\" : \"AppIcon-Tinted.png\",\n      \"idiom\" : \"universal\",\n      \"platform\" : \"ios\",\n      \"size\" : \"1024x1024\"\n    }\n  ],\n  \"info\" : {\n    \"author\" : \"xcode\",\n    \"version\" : 1\n  }\n}\n".to_owned()
}

// --- Everything ------------------------------------------------------------

/// The icon's files by repository-relative path.
pub fn files(tokens: &Tokens) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut text = |path: String, body: String| {
        files.insert(path, body.into_bytes());
    };

    let light = palette(tokens, Variant::Light)?;
    let dark = palette(tokens, Variant::Dark)?;
    let tinted = palette(tokens, Variant::Tinted)?;
    let themed = Palette {
        tile: tokens.icon.themed_tile.clone(),
        quarters: std::array::from_fn(|_| tokens.icon.themed_glyph.clone()),
    };

    let grown = ios_scale(tokens);
    text(
        format!("{SVG_DIR}/centraid-light.svg"),
        tile_svg(&light, Some(&tokens.icon.light_edge), grown),
    );
    text(
        format!("{SVG_DIR}/centraid-dark.svg"),
        tile_svg(&dark, None, grown),
    );
    text(
        format!("{SVG_DIR}/centraid-tinted.svg"),
        tile_svg(&tinted, None, grown),
    );
    text(
        format!("{SVG_DIR}/centraid-themed.svg"),
        tile_svg(&themed, None, 1.0),
    );
    text(format!("{SVG_DIR}/centraid-mark.svg"), mark_svg(&light));

    text(format!("{APPICON_SET}/Contents.json"), appiconset_json());
    let mut png = |name: &str, palette: &Palette| -> Result<()> {
        let bytes = encode_png(&render(palette, grown, ICON_PX)?, ICON_PX)?;
        files.insert(format!("{APPICON_SET}/{name}"), bytes);
        Ok(())
    };
    png("AppIcon-Light.png", &light)?;
    png("AppIcon-Dark.png", &dark)?;
    png("AppIcon-Tinted.png", &tinted)?;

    let mut text = |path: String, body: String| {
        files.insert(path, body.into_bytes());
    };
    text(
        format!("{ANDROID_RES}/drawable/ic_launcher_foreground.xml"),
        vector_xml(108, "", ADAPTIVE_OFFSET, ADAPTIVE_SCALE, &light.quarters),
    );
    text(
        format!("{ANDROID_RES}/drawable/ic_launcher_monochrome.xml"),
        vector_xml(
            108,
            "",
            ADAPTIVE_OFFSET,
            ADAPTIVE_SCALE,
            &std::array::from_fn(|_| tokens.icon.themed_glyph.clone()),
        ),
    );
    text(
        format!("{ANDROID_RES}/values/ic_launcher_background.xml"),
        background_xml(&light.tile),
    );
    for name in ["ic_launcher", "ic_launcher_round"] {
        text(
            format!("{ANDROID_RES}/mipmap-anydpi-v26/{name}.xml"),
            adaptive_xml(),
        );
        text(
            format!("{ANDROID_RES}/mipmap-anydpi/{name}.xml"),
            legacy_xml(&light, name.ends_with("round")),
        );
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn tokens() -> Tokens {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        Tokens::load(&root).unwrap_or_else(|error| panic!("{error}"))
    }

    /// The emitted files, made once: rasterising three 1024 squares is the cost.
    fn emitted() -> &'static BTreeMap<String, Vec<u8>> {
        static FILES: std::sync::OnceLock<BTreeMap<String, Vec<u8>>> = std::sync::OnceLock::new();
        FILES.get_or_init(|| files(&tokens()).unwrap_or_else(|error| panic!("{error}")))
    }

    /// Decode an emitted PNG to its size and RGB bytes.
    fn decode(bytes: &[u8]) -> (u32, Vec<u8>) {
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap_or_else(|error| panic!("{error}"));
        let mut buffer = vec![0; reader.output_buffer_size().unwrap_or(0)];
        let info = reader
            .next_frame(&mut buffer)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(info.color_type, png::ColorType::Rgb);
        assert_eq!(info.bit_depth, png::BitDepth::Eight);
        buffer.truncate(info.buffer_size());
        (info.width, buffer)
    }

    fn pixel(pixels: &[u8], size: u32, x: f64, y: f64) -> String {
        // x and y in grid units.
        let scale = f64::from(size) / GRID;
        let at = ((y * scale) as usize * size as usize + (x * scale) as usize) * 3;
        format!(
            "#{:02X}{:02X}{:02X}",
            pixels[at],
            pixels[at + 1],
            pixels[at + 2]
        )
    }

    #[test]
    fn the_heart_corners_sit_on_the_cuts() {
        // The heart's corners, (+-10.6, +-10.6), are on the diagonals, which are
        // the cuts' middle lines.
        let half = HEART_SIDE / 2.0;
        for (sx, sy) in [(1.0, 1.0), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0)] {
            let (u, v) = (sx * half, sy * half);
            assert!((u.abs() - v.abs()).abs() < 1e-9, "({u}, {v}) is off a cut");
            // ...and the heart's rounded corner stays inside the cut's width.
            let reach = half * std::f64::consts::SQRT_2 + HEART_STROKE / 2.0;
            let across = (u.abs() - v.abs()).abs() / std::f64::consts::SQRT_2;
            assert!(across <= CUT_WIDTH / 2.0, "the corner leaves the cut");
            assert!(reach < RADIUS, "the heart reaches the rim");
        }
        // The quarter's inner corners are where the heart's edge meets a cut's
        // edge: on the line v = u - d, at u = the heart's reach.
        let d = cut_offset();
        let [inner_top, _, _, inner_bottom] = right_quarter();
        for (u, v) in [inner_top, inner_bottom] {
            assert!((u - heart_reach()).abs() < 1e-9);
            assert!(
                (v.abs() - (u - d)).abs() < 1e-9,
                "({u}, {v}) is off the cut"
            );
        }
        // The outer corners are on the circle.
        let [_, outer_top, outer_bottom, _] = right_quarter();
        for (u, v) in [outer_top, outer_bottom] {
            assert!((u.hypot(v) - RADIUS).abs() < 1e-9);
            assert!((v.abs() - (u - d)).abs() < 1e-9);
        }
    }

    #[test]
    fn there_are_four_quarters_turned_a_quarter_apart() {
        let spots = [(20.0, 0.0), (0.0, 20.0), (-20.0, 0.0), (0.0, -20.0)];
        let held: Vec<_> = spots.iter().map(|(u, v)| quarter_at(*u, *v)).collect();
        // Right, bottom, left, top: four different quarters.
        assert_eq!(held, vec![Some(0), Some(1), Some(2), Some(3)]);
        // Each is the first turned by 90 degrees.
        let first = quarter(0);
        for turns in 1..4 {
            let next = quarter(turns);
            for (a, b) in first.iter().zip(next) {
                let (x, y) = turn(*a, turns);
                assert!((x - b.0).abs() < 1e-9 && (y - b.1).abs() < 1e-9);
            }
        }
        // The cuts, the heart and the outside are no quarter.
        for (u, v) in [
            (20.0, 20.0),
            (-20.0, 20.0),
            (0.0, 0.0),
            (5.0, -5.0),
            (40.0, 0.0),
        ] {
            assert_eq!(quarter_at(u, v), None, "({u}, {v})");
        }
    }

    #[test]
    fn the_quarters_wear_the_brand_colours_and_the_tiles_the_icon_colours() {
        let tokens = tokens();
        let files = emitted();
        let text = |path: &str| {
            String::from_utf8(
                files
                    .get(path)
                    .unwrap_or_else(|| panic!("{path} is not emitted"))
                    .clone(),
            )
            .unwrap_or_else(|error| panic!("{error}"))
        };
        let light = text("design/icon/centraid-light.svg");
        for key in ["teal", "orange", "blue", "pink"] {
            let hex = &tokens.brand[key];
            assert!(light.contains(&format!("fill=\"{hex}\"")), "{key} {hex}");
            let foreground = text(&format!(
                "{ANDROID_RES}/drawable/ic_launcher_foreground.xml"
            ));
            assert!(foreground.contains(&format!("\"{hex}\"")), "{key} {hex}");
        }
        assert!(light.contains(&tokens.icon.light_tile));
        assert!(light.contains(&tokens.icon.light_edge));
        assert!(text("design/icon/centraid-dark.svg").contains(&tokens.icon.dark_tile));
        assert!(
            text(&format!("{ANDROID_RES}/values/ic_launcher_background.xml"))
                .contains(&tokens.icon.light_tile)
        );

        // The PNGs hold those colours at the quarters' middles and the tile in the
        // heart, the cuts and the corners.
        let grown = ios_scale(&tokens);
        for (name, tile) in [
            ("AppIcon-Light.png", &tokens.icon.light_tile),
            ("AppIcon-Dark.png", &tokens.icon.dark_tile),
        ] {
            let (size, pixels) = decode(&files[&format!("{APPICON_SET}/{name}")]);
            assert_eq!(size, ICON_PX);
            for (key, (u, v)) in [
                ("orange", (20.0, 0.0)),
                ("blue", (0.0, 20.0)),
                ("pink", (-20.0, 0.0)),
                ("teal", (0.0, -20.0)),
            ] {
                assert_eq!(
                    pixel(&pixels, size, CENTRE + u * grown, CENTRE + v * grown),
                    tokens.brand[key],
                    "{name} {key}"
                );
            }
            for (u, v) in [(0.0, 0.0), (20.0, 20.0), (-50.0, -50.0), (0.0, 40.0)] {
                assert_eq!(
                    pixel(&pixels, size, CENTRE + u * grown, CENTRE + v * grown),
                    *tile,
                    "{name} tile at ({u}, {v})"
                );
            }
        }
    }

    #[test]
    fn the_ios_mark_spans_its_share_of_the_tile() {
        // The disc runs from the tile's left edge by (1 - share) / 2 to the same on the right:
        // measure the widest row of non-tile pixels in each appearance.
        let tokens = tokens();
        for (name, tile) in [
            ("AppIcon-Light.png", &tokens.icon.light_tile),
            ("AppIcon-Dark.png", &tokens.icon.dark_tile),
            ("AppIcon-Tinted.png", &tokens.icon.tinted_tile),
        ] {
            let (size, pixels) = decode(&emitted()[&format!("{APPICON_SET}/{name}")]);
            let tile = rgb(tile).unwrap_or_default();
            let middle = size as usize / 2;
            let row = &pixels[middle * size as usize * 3..(middle + 1) * size as usize * 3];
            let marked: Vec<usize> = row
                .chunks(3)
                .enumerate()
                .filter(|(_, rgb)| [rgb[0], rgb[1], rgb[2]] != tile)
                .map(|(column, _)| column)
                .collect();
            let span = (marked[marked.len() - 1] - marked[0] + 1) as f64 / f64::from(size);
            assert!(
                (span - tokens.icon.ios_mark_share).abs() < 0.01,
                "{name}: the mark spans {span} of the tile, not {}",
                tokens.icon.ios_mark_share
            );
        }
    }

    #[test]
    fn the_tinted_icons_are_neutral_and_the_themed_layer_is_one_colour() {
        let tokens = tokens();
        let files = emitted();
        // iOS tinted: the system recolours it, so every pixel is a grey.
        let (_, pixels) = decode(&files[&format!("{APPICON_SET}/AppIcon-Tinted.png")]);
        assert!(
            pixels
                .chunks(3)
                .all(|rgb| rgb[0] == rgb[1] && rgb[1] == rgb[2]),
            "a tinted pixel is not neutral"
        );
        // IT IS ONE GREY, as iOS expects: the mark's pixels are the tile or the mark and no third
        // value (the cuts between the quarters, not four greys, keep them apart).
        let (tile, mark) = (
            rgb(&tokens.icon.tinted_tile).unwrap_or_default(),
            rgb(&tokens.icon.tinted_mark).unwrap_or_default(),
        );
        let distinct: std::collections::BTreeSet<[u8; 3]> = pixels
            .chunks(3)
            .map(|rgb| [rgb[0], rgb[1], rgb[2]])
            .collect();
        assert!(distinct.contains(&mark) && distinct.contains(&tile));
        let flat = pixels
            .chunks(3)
            .filter(|rgb| [rgb[0], rgb[1], rgb[2]] == mark || [rgb[0], rgb[1], rgb[2]] == tile)
            .count();
        assert!(
            flat * 100 >= pixels.len() / 3 * 95,
            "the tinted icon is two flat greys; only edge pixels blend"
        );
        // Android monochrome: one fill colour on every path.
        let layer = String::from_utf8(
            files[&format!("{ANDROID_RES}/drawable/ic_launcher_monochrome.xml")].clone(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        let fills: Vec<&str> = layer
            .lines()
            .filter_map(|line| line.trim().strip_prefix("android:fillColor=\""))
            .collect();
        assert_eq!(fills.len(), 4);
        assert!(fills.iter().all(|fill| *fill == fills[0]));
        assert!(fills[0].starts_with(&tokens.icon.themed_glyph));
        // The brand colours appear nowhere in it.
        for hex in tokens.brand.values() {
            assert!(!layer.contains(hex.as_str()));
        }
    }

    #[test]
    fn the_android_mark_fills_the_adaptive_safe_zone_and_no_more() {
        // The mark's disc is 66dp across, centred on the 108dp canvas's centre.
        assert!((2.0 * RADIUS * ADAPTIVE_SCALE - 66.0).abs() < 1e-9);
        assert!((CENTRE * ADAPTIVE_SCALE + ADAPTIVE_OFFSET - 54.0).abs() < 1e-9);
        // Every coordinate of the foreground sits inside the safe circle's bounding box
        // (21..87), and its arcs have the safe circle's radius, 33dp.
        let layer = String::from_utf8(
            emitted()[&format!("{ANDROID_RES}/drawable/ic_launcher_foreground.xml")].clone(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        let numbers: Vec<f64> = layer
            .lines()
            .filter_map(|line| line.trim().strip_prefix("android:pathData=\""))
            .flat_map(|data| {
                data.trim_end_matches(['"', ' ', '/', '>'])
                    .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
                    .filter_map(|n| n.parse::<f64>().ok())
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(
            numbers.contains(&33.0),
            "no arc has the safe circle's radius"
        );
        assert!(
            numbers
                .iter()
                .all(|n| (20.9..=87.1).contains(n) || [0.0, 1.0, 33.0].contains(n)),
            "the mark leaves the 66dp safe zone: {numbers:?}"
        );
    }

    #[test]
    fn every_icon_file_is_emitted() {
        let files = emitted();
        let names: Vec<&str> = files.keys().map(String::as_str).collect();
        for want in [
            "design/icon/centraid-light.svg",
            "design/icon/centraid-dark.svg",
            "design/icon/centraid-tinted.svg",
            "design/icon/centraid-themed.svg",
            "design/icon/centraid-mark.svg",
            "mobile/iosApp/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json",
            "mobile/iosApp/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-Light.png",
            "mobile/iosApp/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-Dark.png",
            "mobile/iosApp/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-Tinted.png",
            "mobile/androidApp/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
            "mobile/androidApp/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml",
            "mobile/androidApp/src/main/res/mipmap-anydpi/ic_launcher.xml",
            "mobile/androidApp/src/main/res/mipmap-anydpi/ic_launcher_round.xml",
            "mobile/androidApp/src/main/res/drawable/ic_launcher_foreground.xml",
            "mobile/androidApp/src/main/res/drawable/ic_launcher_monochrome.xml",
            "mobile/androidApp/src/main/res/values/ic_launcher_background.xml",
        ] {
            assert!(names.contains(&want), "{want} is not emitted");
        }
    }
}
