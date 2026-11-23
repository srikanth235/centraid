//! THE APP ICON, FROM `design/tokens.toml` (#1173), by `cargo xtask design`.
//!
//! The board is `design/mockups/CourtyardIcon.dc.html`: four interlocking
//! rounded rooms in a 3×3 courtyard around an open square heart, on a tile.
//! The geometry is the board's, on a 120 grid centred on (60, 60):
//!
//! * an 84×84 courtyard spanning `[18..102]` (`ios_mark_share = 0.70` scales it
//!   about the centre when changed);
//! * four 54×24 rounded rooms (`rx = 8`), each a 90° clockwise turn of the top
//!   room, separated by 6-unit gaps around an open 24×24 square heart
//!   (`[48..72]`);
//! * the gaps and the heart are genuine empty space, never painted in a tile
//!   colour, so the mark is see-through and sits on any surface (the same thing
//!   `CentraidMark` draws in Swift and Kotlin).
//!
//! The colours are `[brand]` (teal top, violet right, gold bottom, rose left)
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
//! * `mobile/iosApp/Resources/AppIcon.icon`: the layered Icon Composer icon iOS 26
//!   draws with Liquid Glass (#1173): a cool-white ground (a navy-to-black one in
//!   dark), the four rooms as flat brand-colour SVG layers in two diagonal depth
//!   groups (teal and gold in front of violet and rose), glass on, layer-colour
//!   shadows. The system adds the frosted tile, lit rim, specular and the shadows
//!   between layers; the artwork is flat colour only. Xcode's `actool` also writes
//!   the pre-iOS-26 fallback from it, and the flat appiconset above is what an OS
//!   without Liquid Glass shows. Same geometry as the PNGs (`ios_mark_share`).
//! * Android, all vector, no raster: an adaptive icon (`mipmap-anydpi-v26`) with
//!   a foreground drawable, a background colour and a `monochrome` layer for
//!   themed icons, and a vector fallback for API 24 and 25 (`mipmap-anydpi`),
//!   the app's `minSdk`, which have no adaptive icons.
//!
//! The PNGs are rasterised here by supersampling the same rounded-rectangle
//! containment test the SVG paths describe, and written with the `png` crate
//! (already in the lock, via `image`), so the gate needs no system tool.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use anyhow::{Context, Result};
use centraid_design::tokens::Tokens;

const GRID: f64 = 120.0;
const CENTRE: f64 = 60.0;
const MARK_SPAN: f64 = 84.0;
const HALF_SPAN: f64 = MARK_SPAN / 2.0;
const CELL: f64 = 24.0;
const GAP: f64 = 6.0;
const ROOM_LONG: f64 = 2.0 * CELL + GAP;
const ROOM_SHORT: f64 = CELL;
const ROOM_RADIUS: f64 = 8.0;
const TILE_RADIUS: f64 = 27.0;
const ICON_PX: u32 = 1024;
/// Supersampling per axis for the PNGs: 4 x 4 samples a pixel.
const SAMPLES: u32 = 4;

const SVG_DIR: &str = "design/icon";
const APPICON_SET: &str = "mobile/iosApp/Resources/Assets.xcassets/AppIcon.appiconset";
const ICON_BUNDLE: &str = "mobile/iosApp/Resources/AppIcon.icon";
const ANDROID_RES: &str = "mobile/androidApp/src/main/res";

/// The directories whose every file this module writes.
pub const OWNED: [&str; 3] = [SVG_DIR, APPICON_SET, ICON_BUNDLE];

/// The four rooms, clockwise from the top, with the `[brand]` key of each and
/// its quarter turns clockwise from the top room.
const ROOMS: [(&str, u32); 4] = [("teal", 0), ("violet", 1), ("gold", 2), ("rose", 3)];

/// Axis-aligned bounds `(x0, y0, x1, y1)` of a room, in grid units about the
/// centre `(0, 0)` with y down.
fn room_bounds(turns: u32) -> (f64, f64, f64, f64) {
    // Top room: [-42..12] x [-42..-18] (54 wide, 24 tall).
    let top = [
        (-HALF_SPAN, -HALF_SPAN),
        (-HALF_SPAN + ROOM_LONG, -HALF_SPAN + ROOM_SHORT),
    ];
    let rotated = top.map(|point| turn(point, turns));
    let x0 = rotated[0].0.min(rotated[1].0);
    let y0 = rotated[0].1.min(rotated[1].1);
    let x1 = rotated[0].0.max(rotated[1].0);
    let y1 = rotated[0].1.max(rotated[1].1);
    (x0, y0, x1, y1)
}

/// Turn a point `turns` quarter turns clockwise on the screen (y down).
fn turn((x, y): (f64, f64), turns: u32) -> (f64, f64) {
    (0..turns).fold((x, y), |(x, y), _| (-y, x))
}

/// Whether `(x, y)` lies inside the rounded rectangle `[x0..x1] x [y0..y1]` of corner radius `r`.
fn in_rounded_rect(x: f64, y: f64, (x0, y0, x1, y1): (f64, f64, f64, f64), r: f64) -> bool {
    if x < x0 || x > x1 || y < y0 || y > y1 {
        return false;
    }
    let dx = (x0 + r - x).max(0.0).max(x - (x1 - r));
    let dy = (y0 + r - y).max(0.0).max(y - (y1 - r));
    dx * dx + dy * dy <= r * r
}

/// Which room holds the point `(u, v)` about the centre, if any.
fn room_at(u: f64, v: f64) -> Option<usize> {
    ROOMS
        .iter()
        .position(|(_, turns)| in_rounded_rect(u, v, room_bounds(*turns), ROOM_RADIUS))
}

// --- Colours ---------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Variant {
    Light,
    Dark,
    Tinted,
}

/// A tile and its four room colours, in [`ROOMS`] order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Palette {
    pub tile: String,
    pub rooms: [String; 4],
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
            brand(tokens, ROOMS[0].0)?,
            brand(tokens, ROOMS[1].0)?,
            brand(tokens, ROOMS[2].0)?,
            brand(tokens, ROOMS[3].0)?,
        ])
    };
    Ok(match variant {
        Variant::Light => Palette {
            tile: icon.light_tile.clone(),
            rooms: brands()?,
        },
        Variant::Dark => Palette {
            tile: icon.dark_tile.clone(),
            rooms: brands()?,
        },
        Variant::Tinted => Palette {
            tile: icon.tinted_tile.clone(),
            // ONE GREY: the system recolours by luminance, and the gaps keep the rooms apart.
            rooms: [
                icon.tinted_mark.clone(),
                icon.tinted_mark.clone(),
                icon.tinted_mark.clone(),
                icon.tinted_mark.clone(),
            ],
        },
    })
}

/// How much the iOS icon's mark is scaled relative to its canonical 84-unit span.
fn ios_scale(tokens: &Tokens) -> f64 {
    tokens.icon.ios_mark_share * GRID / MARK_SPAN
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

/// A room's rounded rectangle as SVG / Android VectorDrawable path data,
/// mapped `grid -> offset + scale * grid`.
fn path_data(turns: u32, offset: f64, scale: f64) -> String {
    let (x0, y0, x1, y1) = room_bounds(turns);
    let left = offset + (CENTRE + x0) * scale;
    let top = offset + (CENTRE + y0) * scale;
    let right = offset + (CENTRE + x1) * scale;
    let bottom = offset + (CENTRE + y1) * scale;
    let r = ROOM_RADIUS * scale;
    let rs = num(r);
    format!(
        "M{} {} H{} A{rs} {rs} 0 0 1 {} {} V{} A{rs} {rs} 0 0 1 {} {} H{} A{rs} {rs} 0 0 1 {} {} V{} A{rs} {rs} 0 0 1 {} {} Z",
        num(left + r),
        num(top),
        num(right - r),
        num(right),
        num(top + r),
        num(bottom - r),
        num(right - r),
        num(bottom),
        num(left + r),
        num(left),
        num(bottom - r),
        num(top + r),
        num(left + r),
        num(top),
    )
}

/// A room as an SVG `<rect>` element, mapped `grid -> offset + scale * grid`.
fn rect_svg(turns: u32, offset: f64, scale: f64, colour: &str) -> String {
    let (x0, y0, x1, y1) = room_bounds(turns);
    let x = offset + (CENTRE + x0) * scale;
    let y = offset + (CENTRE + y0) * scale;
    let w = (x1 - x0) * scale;
    let h = (y1 - y0) * scale;
    let r = ROOM_RADIUS * scale;
    format!(
        "  <rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"{colour}\"/>",
        num(x),
        num(y),
        num(w),
        num(h),
        num(r),
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
/// the four see-through rooms, scaled about the centre by `scale`.
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
    let offset = CENTRE * (1.0 - scale);
    for ((_, turns), colour) in ROOMS.iter().zip(&palette.rooms) {
        let _ = writeln!(out, "{}", rect_svg(*turns, offset, scale, colour));
    }
    out.push_str("</svg>\n");
    out
}

/// The bare mark, cropped to its own extent with a 4-unit margin (`14 14 92 92`).
fn mark_svg(palette: &Palette) -> String {
    let mut out = svg_open("14 14 92 92", Some(1024));
    for ((_, turns), colour) in ROOMS.iter().zip(&palette.rooms) {
        let _ = writeln!(out, "{}", rect_svg(*turns, 0.0, 1.0, colour));
    }
    out.push_str("</svg>\n");
    out
}

/// A vector drawable of `viewport` units holding the rooms mapped by `offset`
/// and `scale`, each in its own colour.
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
    for ((_, turns), colour) in ROOMS.iter().zip(colours) {
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

/// The adaptive icon: a 108dp canvas, with the courtyard's rounded outer
/// corners inscribed cleanly inside the 66dp circular SAFE ZONE (radius 33dp)
/// centred at (54, 54). The furthest point on the rounded square lies at
/// `(HALF_SPAN - ROOM_RADIUS) * sqrt(2) + ROOM_RADIUS` from the centre.
const ADAPTIVE_SAFE_RADIUS_DP: f64 = 33.0;
const ADAPTIVE_CANVAS_DP: f64 = 108.0;
const CORNER_REACH: f64 = (HALF_SPAN - ROOM_RADIUS) * std::f64::consts::SQRT_2 + ROOM_RADIUS;
const ADAPTIVE_SCALE: f64 = ADAPTIVE_SAFE_RADIUS_DP / CORNER_REACH;
const ADAPTIVE_OFFSET: f64 = ADAPTIVE_CANVAS_DP / 2.0 - CENTRE * ADAPTIVE_SCALE;
const LEGACY_ROUND_SCALE: f64 = 0.88;

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
    let (tile, scale) = if round {
        (
            "M60,0 A60,60 0 1 1 60,120 A60,60 0 1 1 60,0 Z".to_owned(),
            LEGACY_ROUND_SCALE,
        )
    } else {
        let r = num(TILE_RADIUS);
        (
            format!(
                "M{r},0 H{} A{r},{r} 0 0 1 120,{r} V{} A{r},{r} 0 0 1 {},120 H{r} A{r},{r} 0 0 1 0,{} V{r} A{r},{r} 0 0 1 {r},0 Z",
                num(GRID - TILE_RADIUS),
                num(GRID - TILE_RADIUS),
                num(GRID - TILE_RADIUS),
                num(GRID - TILE_RADIUS),
            ),
            1.0,
        )
    };
    vector_xml(
        120,
        &fill_path(&palette.tile, &tile),
        CENTRE * (1.0 - scale),
        scale,
        &palette.rooms,
    )
}

// --- The layered iOS 26 icon ----------------------------------------------

/// The canvas of a layer, in px: the 1024 square the PNGs use.
const LAYER_PX: f64 = 1024.0;

/// `#RRGGBB` as Icon Composer's `srgb:r,g,b,a` colour.
fn srgb(hex: &str) -> Result<String> {
    let [r, g, b] = rgb(hex)?;
    let part = |value: u8| format!("{:.5}", f64::from(value) / 255.0);
    Ok(format!("srgb:{},{},{},1.00000", part(r), part(g), part(b)))
}

/// One room's layer: a 1024 canvas with the room in its flat colour, scaled
/// about the centre by `grown`.
fn layer_svg(turns: u32, colour: &str, grown: f64) -> String {
    let scale = grown * LAYER_PX / GRID;
    let offset = LAYER_PX / 2.0 - CENTRE * scale;
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1024\" height=\"1024\" viewBox=\"0 0 1024 1024\">\n{}\n</svg>\n",
        rect_svg(turns, offset, scale, colour)
    )
}

/// `icon.json`: the ground (light, with a dark specialization) and two diagonal
/// depth groups (`teal-gold` forward, `violet-rose` behind).
fn icon_json(tokens: &Tokens) -> Result<String> {
    let gradient = |top: &str, bottom: &str| -> Result<String> {
        Ok(format!(
            "{{\n    \"linear-gradient\" : [\n      \"{}\",\n      \"{}\"\n    ]\n  }}",
            srgb(top)?,
            srgb(bottom)?
        ))
    };
    let icon = &tokens.icon;
    let group = |keys: [&str; 2]| {
        let layers = keys
            .iter()
            .map(|key| {
                format!(
                    "        {{\n          \"glass\" : true,\n          \"image-name\" : \"{key}.svg\",\n          \"name\" : \"{key}\"\n        }}"
                )
            })
            .collect::<Vec<_>>()
            .join(",\n");
        format!(
            "    {{\n      \"name\" : \"{}\",\n      \"layers\" : [\n{layers}\n      ],\n      \"shadow\" : {{\n        \"kind\" : \"layer-color\",\n        \"opacity\" : 0.35\n      }}\n    }}",
            keys.join("-")
        )
    };
    Ok(format!(
        "{{\n  \"fill\" : {},\n  \"fill-specializations\" : [\n    {{\n      \"appearance\" : \"dark\",\n      \"value\" : {}\n    }}\n  ],\n  \"groups\" : [\n{},\n{}\n  ],\n  \"supported-platforms\" : {{\n    \"squares\" : \"shared\"\n  }}\n}}\n",
        gradient(&icon.light_tile, &icon.light_tile_bottom)?,
        gradient(&icon.dark_ground_top, &icon.dark_ground_bottom)?,
        group(["teal", "gold"]),
        group(["violet", "rose"]),
    ))
}

// --- The PNGs --------------------------------------------------------------

/// The colour of one sample at a grid point, tile when the point is on no room.
fn sample(palette: &[[u8; 3]; 5], scale: f64, x: f64, y: f64) -> [u8; 3] {
    match room_at((x - CENTRE) / scale, (y - CENTRE) / scale) {
        Some(at) => palette[at + 1],
        None => palette[0],
    }
}

/// An opaque, full-bleed square of `size` pixels in `palette`: the tile fills the
/// canvas (iOS masks it) and the mark sits on the 120 grid scaled about the centre by `scale`.
pub fn render(palette: &Palette, scale: f64, size: u32) -> Result<Vec<u8>> {
    let mut colours = [[0u8; 3]; 5];
    colours[0] = rgb(&palette.tile)?;
    for (slot, hex) in colours[1..].iter_mut().zip(&palette.rooms) {
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
        rooms: std::array::from_fn(|_| tokens.icon.themed_glyph.clone()),
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
        tile_svg(&themed, None, LEGACY_ROUND_SCALE),
    );
    text(format!("{SVG_DIR}/centraid-mark.svg"), mark_svg(&light));

    text(format!("{ICON_BUNDLE}/icon.json"), icon_json(tokens)?);
    for (key, turns) in ROOMS {
        text(
            format!("{ICON_BUNDLE}/Assets/{key}.svg"),
            layer_svg(turns, &brand(tokens, key)?, grown),
        );
    }

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
        vector_xml(108, "", ADAPTIVE_OFFSET, ADAPTIVE_SCALE, &light.rooms),
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
    fn the_four_rooms_frame_an_open_square_heart_with_equal_gaps() {
        // Four rooms around an open 24x24 square heart ([-12..12] x [-12..12]),
        // separated by 6-unit gaps.
        assert_eq!(room_bounds(0), (-42.0, -42.0, 12.0, -18.0));
        assert_eq!(room_bounds(1), (18.0, -42.0, 42.0, 12.0));
        assert_eq!(room_bounds(2), (-12.0, 18.0, 42.0, 42.0));
        assert_eq!(room_bounds(3), (-42.0, -12.0, -18.0, 42.0));
        // Each room is 54 x 24 (or 24 x 54), and adjacent gaps are 6 units wide.
        let top = room_bounds(0);
        let right = room_bounds(1);
        let bottom = room_bounds(2);
        let left = room_bounds(3);
        assert!((right.0 - top.2 - GAP).abs() < 1e-9);
        assert!((bottom.1 - right.3 - GAP).abs() < 1e-9);
        assert!((bottom.0 - left.2 - GAP).abs() < 1e-9);
        assert!((left.1 - top.3 - GAP).abs() < 1e-9);
        // Sample inside each room, in the open heart, in every gap and outside.
        assert_eq!(room_at(-15.0, -30.0), Some(0)); // top (teal)
        assert_eq!(room_at(30.0, -15.0), Some(1)); // right (violet)
        assert_eq!(room_at(15.0, 30.0), Some(2)); // bottom (gold)
        assert_eq!(room_at(-30.0, 15.0), Some(3)); // left (rose)
        for (u, v) in [
            (0.0, 0.0),
            (10.0, -10.0),
            (15.0, -30.0),
            (30.0, 15.0),
            (-15.0, 30.0),
            (-30.0, -15.0),
            (45.0, 0.0),
        ] {
            assert_eq!(room_at(u, v), None, "({u}, {v})");
        }
    }

    #[test]
    fn the_rooms_wear_the_brand_colours_and_the_tiles_the_icon_colours() {
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
        for key in ["teal", "violet", "gold", "rose"] {
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

        let grown = ios_scale(&tokens);
        for (name, tile) in [
            ("AppIcon-Light.png", &tokens.icon.light_tile),
            ("AppIcon-Dark.png", &tokens.icon.dark_tile),
        ] {
            let (size, pixels) = decode(&files[&format!("{APPICON_SET}/{name}")]);
            assert_eq!(size, ICON_PX);
            for (key, (u, v)) in [
                ("teal", (-15.0, -30.0)),
                ("violet", (30.0, -15.0)),
                ("gold", (15.0, 30.0)),
                ("rose", (-30.0, 15.0)),
            ] {
                assert_eq!(
                    pixel(&pixels, size, CENTRE + u * grown, CENTRE + v * grown),
                    tokens.brand[key],
                    "{name} {key}"
                );
            }
            for (u, v) in [(0.0, 0.0), (15.0, -30.0), (-30.0, -15.0), (45.0, 0.0)] {
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
        let tokens = tokens();
        for (name, tile) in [
            ("AppIcon-Light.png", &tokens.icon.light_tile),
            ("AppIcon-Dark.png", &tokens.icon.dark_tile),
            ("AppIcon-Tinted.png", &tokens.icon.tinted_tile),
        ] {
            let (size, pixels) = decode(&emitted()[&format!("{APPICON_SET}/{name}")]);
            let tile = rgb(tile).unwrap_or_default();
            // Sample across the middle row (which crosses both left and right vertical rooms).
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
        let (_, pixels) = decode(&files[&format!("{APPICON_SET}/AppIcon-Tinted.png")]);
        assert!(
            pixels
                .chunks(3)
                .all(|rgb| rgb[0] == rgb[1] && rgb[1] == rgb[2]),
            "a tinted pixel is not neutral"
        );
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
        for hex in tokens.brand.values() {
            assert!(!layer.contains(hex.as_str()));
        }
    }

    #[test]
    fn the_android_mark_stays_inside_the_66dp_circular_safe_zone() {
        // The furthest point of the rounded outer corners lies exactly on the
        // 33dp safe circle centred at (54, 54).
        assert!((CORNER_REACH * ADAPTIVE_SCALE - ADAPTIVE_SAFE_RADIUS_DP).abs() < 1e-9);
        assert!((CENTRE * ADAPTIVE_SCALE + ADAPTIVE_OFFSET - 54.0).abs() < 1e-9);
        let half_dp = HALF_SPAN * ADAPTIVE_SCALE;
        let corner_r = ROOM_RADIUS * ADAPTIVE_SCALE;
        assert!(((half_dp - corner_r) * std::f64::consts::SQRT_2 + corner_r - 33.0).abs() < 1e-9);
        // Every path coordinate stays strictly inside [21..87] (the 66dp circle's bounding box).
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
        let r_rounded = (ROOM_RADIUS * ADAPTIVE_SCALE * 1000.0).round() / 1000.0;
        assert!(
            numbers.iter().all(|n| (21.0..=87.0).contains(n)
                || (*n - r_rounded).abs() < 1e-3
                || [0.0, 1.0].contains(n)),
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
            "mobile/iosApp/Resources/AppIcon.icon/icon.json",
            "mobile/iosApp/Resources/AppIcon.icon/Assets/teal.svg",
            "mobile/iosApp/Resources/AppIcon.icon/Assets/violet.svg",
            "mobile/iosApp/Resources/AppIcon.icon/Assets/gold.svg",
            "mobile/iosApp/Resources/AppIcon.icon/Assets/rose.svg",
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
