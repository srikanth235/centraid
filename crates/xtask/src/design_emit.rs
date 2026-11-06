//! `cargo xtask design`: EVERY DESIGN ARTIFACT, FROM `design/tokens.toml` (#1173).
//!
//! ```text
//! design/tokens.toml ─┐
//! design/icons.toml  ─┤                      mobile/iosApp/Design/{Theme,Catalog,Words,DesignScale}.swift
//! design/fonts/*     ─┼─ cargo xtask design ─ mobile/iosApp/Resources/{Assets.xcassets/Colors,Fonts}
//! design/site/*.css  ─┤                      mobile/androidApp/.../design/{Tokens,Catalog,Words}.kt
//! crates/screens/    ─┘                      mobile/androidApp/src/main/res/{values,values-night,font}
//!   src/strings/*.rs                         scripts/{docs,home}-site/public/assets/{centraid-tokens.css,fonts}
//! ```
//!
//! This replaces the TypeScript emitters (`contracts/tools/export-native-*.ts`,
//! `scripts/site-tokens.mjs`) that read `packages/design`. The output is
//! generated already formatted, so no formatter runs after it, and it is
//! deterministic, so [`check`] can regenerate into memory and name every file
//! that differs from the committed one. The gate's `design` step is that check.
//!
//! WHAT THE CONSUMERS HOLD STILL. The generated Swift and Kotlin API names and
//! the 55 colour role strings are what about 1500 call sites use, so the legacy
//! tables (`Theme`, `Tokens`, `Catalog`) are reproduced exactly, and the
//! redesign's values (apps, states, shell, lists, surfaces, text, type scale)
//! arrive beside them as asset-catalogue colour sets, Android resources and a
//! small Swift scale file. Phase 4's screen PRs move the shells onto those.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use centraid_design::tokens::{Accent, NativeColor, Tokens, native_color};

use crate::design_words;

const KOTLIN_DIR: &str = "mobile/androidApp/src/main/kotlin/dev/centraid/android/design";
const SWIFT_DIR: &str = "mobile/iosApp/Design";
const IOS_FONTS: &str = "mobile/iosApp/Resources/Fonts";
const ANDROID_FONTS: &str = "mobile/androidApp/src/main/res/font";
const ANDROID_RES: &str = "mobile/androidApp/src/main/res";
const IOS_COLORS: &str = "mobile/iosApp/Resources/Assets.xcassets";
const FONT_SOURCE: &str = "design/fonts";
const SITE_SOURCE: &str = "design/site/tokens.css";
const SITE_ASSETS: [&str; 2] = [
    "scripts/home-site/public/assets",
    "scripts/docs-site/public/assets",
];
const SITE_SHEET: &str = "centraid-tokens.css";

/// What a run produces: every file by repository-relative path, and the
/// directories whose contents are entirely this command's.
pub struct Emitted {
    pub files: BTreeMap<String, Vec<u8>>,
    /// Directories where a file this run did not produce is drift.
    pub owned: Vec<String>,
}

// --- JavaScript-shaped number formatting ----------------------------------
//
// The committed tables were written by a JavaScript emitter, so the numbers
// keep its spelling: `27` and not `27.0`, `0.26` and not `0.2600000000000000`.

fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        format!("{value}")
    }
}

/// `Math.round`: half rounds up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `JSON.stringify` of a string, for the effect entries.
fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn byte_hex(part: f64) -> String {
    let clamped = part.clamp(0.0, 255.0);
    format!("{:02X}", js_round(clamped) as u8)
}

fn kotlin_color(value: &str) -> Result<String> {
    let NativeColor {
        red,
        green,
        blue,
        alpha,
    } = native_color(value).with_context(|| format!("not a colour: {value}"))?;
    Ok(format!(
        "0x{}{}{}{}L",
        byte_hex(alpha * 255.0),
        byte_hex(f64::from(red)),
        byte_hex(f64::from(green)),
        byte_hex(f64::from(blue))
    ))
}

fn swift_color(value: &str) -> Result<String> {
    let NativeColor {
        red,
        green,
        blue,
        alpha,
    } = native_color(value).with_context(|| format!("not a colour: {value}"))?;
    let part = |channel: f64| format!("{channel:.6}");
    Ok(format!(
        "Color(.sRGB, red: {}, green: {}, blue: {}, opacity: {})",
        part(f64::from(red) / 255.0),
        part(f64::from(green) / 255.0),
        part(f64::from(blue) / 255.0),
        part(alpha)
    ))
}

// --- the faces -------------------------------------------------------------

/// The PostScript name, out of the font itself.
///
/// An OpenType `name` table is a run of records keyed by (platform, encoding,
/// language, nameID); nameID 6 is the PostScript name. Both platform 3
/// (Windows, UTF-16BE) and platform 1 (Macintosh, MacRoman) records are
/// accepted, the Windows one winning when both are present. `UIFont(name:)`
/// matches a PostScript name and returns nil, silently, for anything else, so
/// the name is read from the bytes and never guessed from the file name.
pub fn postscript_name(bytes: &[u8], file: &str) -> Result<String> {
    let u16_at = |at: usize| -> Result<usize> {
        let pair = bytes.get(at..at + 2).context("truncated font")?;
        Ok(usize::from(u16::from_be_bytes([pair[0], pair[1]])))
    };
    let u32_at = |at: usize| -> Result<usize> {
        let quad = bytes.get(at..at + 4).context("truncated font")?;
        Ok(u32::from_be_bytes([quad[0], quad[1], quad[2], quad[3]]) as usize)
    };
    let tables = u16_at(4)?;
    let mut name_offset = None;
    for index in 0..tables {
        let record = 12 + 16 * index;
        if bytes.get(record..record + 4) == Some(b"name".as_slice()) {
            name_offset = Some(u32_at(record + 8)?);
        }
    }
    let name_offset = name_offset.with_context(|| format!("no name table: {file}"))?;
    let count = u16_at(name_offset + 2)?;
    let strings = u16_at(name_offset + 4)?;
    let mut found: Option<String> = None;
    for index in 0..count {
        let record = name_offset + 6 + 12 * index;
        let platform = u16_at(record)?;
        if u16_at(record + 6)? != 6 {
            continue;
        }
        let length = u16_at(record + 8)?;
        let offset = name_offset + strings + u16_at(record + 10)?;
        let slice = bytes
            .get(offset..offset + length)
            .context("truncated font")?;
        if platform == 3 {
            let units: Vec<u16> = slice
                .chunks_exact(2)
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                .collect();
            return Ok(String::from_utf16_lossy(&units));
        }
        found.get_or_insert_with(|| slice.iter().map(|&byte| char::from(byte)).collect());
    }
    found.with_context(|| format!("no PostScript name: {file}"))
}

/// Each family's faces, in table order.
type FaceFamilies = Vec<(String, Vec<ResolvedFace>)>;

struct ResolvedFace {
    weight: u32,
    file: String,
    android_resource: String,
    postscript: String,
}

fn resolve_faces(
    tokens: &Tokens,
    root: &Path,
) -> Result<(FaceFamilies, BTreeMap<String, Vec<u8>>)> {
    let mut families = Vec::new();
    let mut files = BTreeMap::new();
    for (family, faces) in &tokens.native.faces {
        let mut resolved = Vec::new();
        for face in faces {
            let path = root.join(FONT_SOURCE).join(&face.file);
            // A byte copy and nothing else: a re-emit that rewrote, subset or
            // re-timestamped the file would red a clean tree.
            let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            resolved.push(ResolvedFace {
                weight: face.weight,
                file: face.file.clone(),
                android_resource: face.android_resource.clone(),
                postscript: postscript_name(&bytes, &face.file)?,
            });
            files.insert(format!("{IOS_FONTS}/{}", face.file), bytes.clone());
            files.insert(
                format!("{ANDROID_FONTS}/{}.ttf", face.android_resource),
                bytes,
            );
        }
        families.push((family.clone(), resolved));
    }
    Ok((families, files))
}

// --- Theme.swift and Tokens.kt ---------------------------------------------

fn theme_header() -> String {
    [
        "// GENERATED by `cargo xtask design` from `design/tokens.toml`. Do not edit.",
        "//",
        "// The native lowering of the design tokens (#1020, D-1020-E6; #1173). A",
        "// hand-edited copy of this table is a lowering with no drift gate, which is",
        "// what the gate's `design` step (`cargo xtask design --check`) exists to",
        "// prevent.",
        "//",
        "// THE FACE TABLE BELOW IS EMITTED TOO, and so are the .ttf files it names:",
        "// `design/fonts` is the one source and this emitter copies them into both",
        "// app trees. A face added or renamed there moves through here.",
        "//",
        "// THE TYPE SIZES HERE ARE THE TOUCH STEP: the phone's value, already summed,",
        "// as `[native.type.*]` in `design/tokens.toml`. Change a value THERE.",
        "",
    ]
    .join("\n")
}

fn sorted_names<V>(map: &BTreeMap<String, V>) -> Vec<&String> {
    map.keys().collect()
}

/// The colour roles, split into real colours and CSS effects, each sorted.
fn split_roles(tokens: &Tokens) -> (Vec<String>, Vec<String>) {
    let mut colors = Vec::new();
    let mut effects = Vec::new();
    for (role, value) in &tokens.native.colors.light {
        if native_color(value).is_some() {
            colors.push(role.clone());
        } else {
            effects.push(role.clone());
        }
    }
    (colors, effects)
}

fn tokens_kt(tokens: &Tokens, faces: &[(String, Vec<ResolvedFace>)]) -> Result<String> {
    let (color_names, effect_names) = split_roles(tokens);
    let mut lines: Vec<String> = vec![theme_header(), "package dev.centraid.design".into()];
    lines.extend(
        [
            "",
            "/** One scheme's concrete, ready-to-render values. */",
            "public data class NativeTheme(",
            "    public val scheme: String,",
            "    public val colors: Map<String, Long>,",
            "    /**",
            "     * Role values that are NOT colours: CSS `box-shadow` strings. A shadow API",
            "     * is a design decision, not an emitter's.",
            "     */",
            "    public val effects: Map<String, String>,",
            "    public val spacing: Map<String, Int>,",
            "    public val radii: Map<String, Int>,",
            "    public val type: Map<String, NativeTypeStyle>,",
            ")",
            "",
            "public data class NativeTypeStyle(",
            "    public val family: String,",
            "    public val fontSize: Double,",
            "    public val lineHeight: Double,",
            "    public val weight: Int,",
            ")",
            "",
            "/** Every colour role the contract names. The list is asserted, not assumed. */",
            "public val NATIVE_COLOR_ROLES: List<String> = listOf(",
        ]
        .map(str::to_owned),
    );
    lines.extend(color_names.iter().map(|name| format!("    \"{name}\",")));
    lines.extend(
        [
            ")",
            "",
            "/** The role entries that are not colours. See `NativeTheme.effects`. */",
            "public val NATIVE_EFFECT_ROLES: List<String> = listOf(",
        ]
        .map(str::to_owned),
    );
    lines.extend(effect_names.iter().map(|name| format!("    \"{name}\",")));
    lines.extend(
        [
            ")",
            "",
            "/**",
            " * THE FACES BEHIND THE FAMILY NAMES, AS ANDROID RESOURCE NAMES.",
            " *",
            " * `NativeTypeStyle.family` is a word — `sans` — and Compose needs a",
            " * `FontFamily` built from `R.font.*`. Kotlin cannot turn a string into an",
            " * `R` id without reflection, so this table does NOT replace the `R.font`",
            " * references in the shell: it is what a test compares them against, so a",
            " * face renamed in `design/fonts` reds here instead of falling back",
            " * to Roboto on a device. `code` is absent because it is the platform's own",
            " * monospace and ships no file.",
            " *",
            " * THE 400 KEY RESOLVES TO A 470 FACE ON PURPOSE. It is a LOWERING and not a",
            " * third weight: the key is the ramp's 400, the file is `instrument_sans_book`",
            " * (`usWeightClass` 470), and the touch step this table already carries is why.",
            " * Web and desktop draw a true 400 and are untouched.",
            " */",
            "public val NATIVE_TYPE_FACES: Map<String, Map<Int, String>> = mapOf(",
        ]
        .map(str::to_owned),
    );
    for (family, faces) in faces {
        let entries: Vec<String> = faces
            .iter()
            .map(|face| format!("{} to \"{}\"", face.weight, face.android_resource))
            .collect();
        lines.push(format!(
            "    \"{family}\" to mapOf({}),",
            entries.join(", ")
        ));
    }
    lines.extend([
        ")".to_owned(),
        String::new(),
        "public object CentraidTokens {".to_owned(),
    ]);

    for (scheme, colors) in [
        ("light", &tokens.native.colors.light),
        ("dark", &tokens.native.colors.dark),
    ] {
        lines.push(format!(
            "    public val {scheme}: NativeTheme = NativeTheme("
        ));
        lines.push(format!("        scheme = \"{scheme}\","));
        lines.push("        colors = mapOf(".into());
        for name in &color_names {
            let value = colors
                .get(name)
                .with_context(|| format!("native theme is missing {name}"))?;
            lines.push(format!(
                "            \"{name}\" to {},",
                kotlin_color(value)?
            ));
        }
        lines.push("        ),".into());
        lines.push("        effects = mapOf(".into());
        for name in &effect_names {
            let value = colors
                .get(name)
                .with_context(|| format!("native theme is missing {name}"))?;
            lines.push(format!("            \"{name}\" to {},", json_string(value)));
        }
        lines.push("        ),".into());
        lines.push("        spacing = mapOf(".into());
        for name in sorted_names(&tokens.native.spacing) {
            lines.push(format!(
                "            \"{name}\" to {},",
                js_number(js_round(tokens.native.spacing[name]))
            ));
        }
        lines.push("        ),".into());
        lines.push("        radii = mapOf(".into());
        for name in sorted_names(&tokens.native.radii) {
            lines.push(format!(
                "            \"{name}\" to {},",
                js_number(js_round(tokens.native.radii[name]))
            ));
        }
        lines.push("        ),".into());
        lines.push("        type = mapOf(".into());
        for (name, style) in &tokens.native.types {
            lines.push(format!(
                "            \"{name}\" to NativeTypeStyle(family = \"{}\", fontSize = {:.1}, lineHeight = {:.1}, weight = {}),",
                style.family, style.font_size, style.line_height, style.weight
            ));
        }
        lines.push("        ),".into());
        lines.push("    )".into());
        lines.push(String::new());
    }
    lines.push("}".into());
    lines.push(String::new());
    Ok(lines.join("\n"))
}

fn theme_swift(tokens: &Tokens, faces: &[(String, Vec<ResolvedFace>)]) -> Result<String> {
    let (color_names, effect_names) = split_roles(tokens);
    let mut lines: Vec<String> = vec![theme_header(), "import SwiftUI".into()];
    lines.extend(
        [
            "",
            "public struct CentraidTypeStyle: Sendable {",
            "    public let family: String",
            "    public let fontSize: CGFloat",
            "    public let lineHeight: CGFloat",
            "    public let weight: Int",
            "}",
            "",
            "public struct CentraidTheme: Sendable {",
            "    public let scheme: String",
            "    public let colors: [String: Color]",
            "    /// See `NativeTheme.effects` in the Kotlin table: CSS box-shadow strings.",
            "    public let effects: [String: String]",
            "    public let spacing: [String: CGFloat]",
            "    public let radii: [String: CGFloat]",
            "    public let type: [String: CentraidTypeStyle]",
            "}",
            "",
            "/// Every colour role the contract names. The list is asserted, not assumed.",
            "public let centraidColorRoles: [String] = [",
        ]
        .map(str::to_owned),
    );
    lines.extend(color_names.iter().map(|name| format!("    \"{name}\",")));
    lines.extend(
        [
            "]",
            "",
            "/// THE FACES BEHIND THE FAMILY NAMES, AS POSTSCRIPT NAMES.",
            "///",
            "/// `UIFont(name:size:)` matches a PostScript name and nothing else, and it",
            "/// returns nil rather than complaining. These strings are read out of the",
            "/// TTF's own `name` table by the emitter, so they cannot drift from the",
            "/// bytes in `Resources/Fonts`. `code` is absent: it is the system monospace",
            "/// and ships no file.",
            "///",
            "/// THE 400 KEY RESOLVES TO `InstrumentSans-Book` ON PURPOSE. It is a",
            "/// LOWERING and not a third weight: the key is the ramp's 400, the face is",
            "/// the derived 470 instance, and the touch step plus CoreText's grayscale",
            "/// antialiasing is why.",
            "/// Web and desktop draw a true 400 and are untouched.",
            "public let centraidTypeFaces: [String: [Int: String]] = [",
        ]
        .map(str::to_owned),
    );
    for (family, faces) in faces {
        let entries: Vec<String> = faces
            .iter()
            .map(|face| format!("{}: \"{}\"", face.weight, face.postscript))
            .collect();
        lines.push(format!("    \"{family}\": [{}],", entries.join(", ")));
    }
    lines.extend(
        [
            "]",
            "",
            "/// The files `UIAppFonts` in `project.yml` must name, one for one.",
            "public let centraidFontFiles: [String] = [",
        ]
        .map(str::to_owned),
    );
    for (_, faces) in faces {
        lines.extend(faces.iter().map(|face| format!("    \"{}\",", face.file)));
    }
    lines.extend([
        "]".to_owned(),
        String::new(),
        "public enum CentraidTokens {".to_owned(),
    ]);

    for (scheme, colors) in [
        ("light", &tokens.native.colors.light),
        ("dark", &tokens.native.colors.dark),
    ] {
        lines.push(format!("    public static let {scheme} = CentraidTheme("));
        lines.push(format!("        scheme: \"{scheme}\","));
        lines.push("        colors: [".into());
        for name in &color_names {
            let value = colors
                .get(name)
                .with_context(|| format!("native theme is missing {name}"))?;
            lines.push(format!("            \"{name}\": {},", swift_color(value)?));
        }
        lines.push("        ],".into());
        lines.push("        effects: [".into());
        for name in &effect_names {
            let value = colors
                .get(name)
                .with_context(|| format!("native theme is missing {name}"))?;
            lines.push(format!("            \"{name}\": {},", json_string(value)));
        }
        lines.push("        ],".into());
        lines.push("        spacing: [".into());
        for name in sorted_names(&tokens.native.spacing) {
            lines.push(format!(
                "            \"{name}\": {},",
                js_number(js_round(tokens.native.spacing[name]))
            ));
        }
        lines.push("        ],".into());
        lines.push("        radii: [".into());
        for name in sorted_names(&tokens.native.radii) {
            lines.push(format!(
                "            \"{name}\": {},",
                js_number(js_round(tokens.native.radii[name]))
            ));
        }
        lines.push("        ],".into());
        lines.push("        type: [".into());
        for (name, style) in &tokens.native.types {
            lines.push(format!(
                "            \"{name}\": CentraidTypeStyle(family: \"{}\", fontSize: {}, lineHeight: {}, weight: {}),",
                style.family,
                js_number(style.font_size),
                js_number(style.line_height),
                style.weight
            ));
        }
        lines.push("        ],".into());
        lines.push("    )".into());
        lines.push(String::new());
    }
    lines.push("}".into());
    lines.push(String::new());
    Ok(lines.join("\n"))
}

// --- Catalog.swift and Catalog.kt -------------------------------------------

fn catalog_header() -> String {
    [
        "// GENERATED by `cargo xtask design` from `design/tokens.toml` and",
        "// `design/icons.toml`. Do not edit.",
        "//",
        "// The app catalogue, the resolved identity marks and the shared icon",
        "// silhouettes (#1020, wave A; #1173). A hand-edited copy of this table is a",
        "// lowering with no drift gate, which is what the gate's `design` step",
        "// (`cargo xtask design --check`) exists to prevent.",
        "",
    ]
    .join("\n")
}

/// `appMarkViewBox` to `APP_MARK_VIEW_BOX`.
fn screaming_snake(name: &str) -> String {
    let mut out = String::new();
    let mut previous: Option<char> = None;
    for c in name.chars() {
        if c.is_ascii_uppercase()
            && previous.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit())
        {
            out.push('_');
        }
        out.push(c.to_ascii_uppercase());
        previous = Some(c);
    }
    out
}

fn catalog_kt(tokens: &Tokens) -> Result<String> {
    let apps = &tokens.native.app;
    let mut kotlin: Vec<String> = vec![catalog_header(), "package dev.centraid.design".into()];
    kotlin.extend(
        [
            "",
            "/** One first-party app's launcher identity. */",
            "public data class NativeApp(",
            "    public val id: String,",
            "    public val name: String,",
            "    public val desc: String,",
            "    public val iconKey: String,",
            "    public val colorKey: String,",
            ")",
            "",
            "/**",
            " * An app's icon chip, already composited.",
            " *",
            " * `chipBackground` is [hue] over the page at the scheme's tint share and",
            " * `markColor` is the hue's solved text rung, both carried in",
            " * `design/tokens.toml` as `[[native.app]]`, because a blend computed twice",
            " * is two blends. The chip is the ONLY place an app's hue appears on Home: the",
            " * springboard itself takes no identity hue.",
            " */",
            "public data class NativeAppMark(",
            "    public val hue: Long,",
            "    public val chipBackground: Long,",
            "    public val markColor: Long,",
            ")",
            "",
            "/** One `<path>` of a silhouette: SVG path data in a 24x24 viewBox. */",
            "public data class NativeIconPath(",
            "    public val d: String,",
            "    /** Filled with the mark colour rather than stroked. */",
            "    public val filled: Boolean,",
            "    /** The knockout rule the silhouette contract specifies. */",
            "    public val evenOdd: Boolean,",
            ")",
            "",
            "public object CentraidCatalog {",
            "    /**",
            "     * The first-party apps, in CATALOGUE order.",
            "     *",
            "     * This is the all-apps listing's order and says nothing about the grid",
            "     * — `SpringboardPolicy.SPRINGBOARD_ORDER` owns that.",
            "     */",
            "    public val apps: List<NativeApp> = listOf(",
        ]
        .map(str::to_owned),
    );
    for app in apps {
        kotlin.push(format!(
            "        NativeApp(id = {}, name = {}, desc = {}, iconKey = {}, colorKey = {}),",
            quote(&app.id),
            quote(&app.name),
            quote(&app.desc),
            quote(&app.icon_key),
            quote(&app.color_key)
        ));
    }
    kotlin.extend(
        [
            "    )",
            "",
            "    /** By id, for the header that names one app. */",
            "    public val byId: Map<String, NativeApp> = apps.associateBy { it.id }",
            "",
        ]
        .map(str::to_owned),
    );
    for scheme in ["light", "dark"] {
        kotlin.push(format!(
            "    public val {scheme}Marks: Map<String, NativeAppMark> = mapOf("
        ));
        for app in apps {
            let (hue, chip, mark) = marks(app, scheme);
            kotlin.push(format!(
                "        {} to NativeAppMark(hue = {}, chipBackground = {}, markColor = {}),",
                quote(&app.id),
                kotlin_color(hue)?,
                kotlin_color(chip)?,
                kotlin_color(mark)?
            ));
        }
        kotlin.push("    )".into());
        kotlin.push(String::new());
    }
    kotlin.extend(
        [
            "    /**",
            "     * Lucide-style silhouettes as raw SVG path data, viewBox 24x24.",
            "     *",
            "     * ONE ordered list per icon, drawn in order. Compose reads these with",
            "     * `PathParser`, which speaks SVG path data directly; the iOS side has",
            "     * its own parser beside its renderer. Neither shell ships a second",
            "     * icon set, because two silhouettes for one concept is two products.",
            "     */",
            "    public val icons: Map<String, List<NativeIconPath>> = mapOf(",
        ]
        .map(str::to_owned),
    );
    for (name, paths) in &tokens.icons {
        kotlin.push(format!("        {} to listOf(", quote(name)));
        for path in paths {
            kotlin.push(format!(
                "            NativeIconPath(d = {}, filled = {}, evenOdd = {}),",
                quote(&path.d),
                path.filled,
                path.even_odd
            ));
        }
        kotlin.push("        ),".into());
    }
    kotlin.extend(
        [
            "    )",
            "}",
            "",
            "/** Geometry both shells need that the token table does not carry. */",
            "public object CentraidGeometry {",
        ]
        .map(str::to_owned),
    );
    for (name, value) in &tokens.native.geometry {
        let constant = screaming_snake(name);
        if value.fract() == 0.0 {
            kotlin.push(format!(
                "    public const val {constant}: Int = {}",
                js_number(*value)
            ));
        } else {
            kotlin.push(format!(
                "    public const val {constant}: Double = {}",
                js_number(*value)
            ));
        }
    }
    kotlin.push("}".into());
    kotlin.push(String::new());
    Ok(kotlin.join("\n"))
}

fn marks<'a>(
    app: &'a centraid_design::tokens::NativeApp,
    scheme: &str,
) -> (&'a str, &'a str, &'a str) {
    if scheme == "light" {
        (&app.light_hue, &app.light_chip, &app.light_mark)
    } else {
        (&app.dark_hue, &app.dark_chip, &app.dark_mark)
    }
}

fn catalog_swift(tokens: &Tokens) -> Result<String> {
    let apps = &tokens.native.app;
    // The marks are opaque hex, and the Swift literal is the Theme.swift one.
    let mut swift: Vec<String> = vec![catalog_header(), "import SwiftUI".into()];
    swift.extend(
        [
            "",
            "/// One first-party app's launcher identity.",
            "///",
            "/// `…Meta`, not `CentraidApp`: the shell's `@main` entry point is a SwiftUI",
            "/// `App` named `CentraidApp`, and the two would collide.",
            "public struct CentraidAppMeta: Sendable {",
            "    public let id: String",
            "    public let name: String",
            "    public let desc: String",
            "    public let iconKey: String",
            "    public let colorKey: String",
            "}",
            "",
            "/// An app's icon chip, already composited. See the Kotlin table.",
            "public struct CentraidAppMark: Sendable {",
            "    public let hue: Color",
            "    public let chipBackground: Color",
            "    public let markColor: Color",
            "}",
            "",
            "/// One `<path>` of a silhouette: SVG path data in a 24x24 viewBox.",
            "public struct CentraidIconPath: Sendable {",
            "    public let d: String",
            "    public let filled: Bool",
            "    public let evenOdd: Bool",
            "}",
            "",
            "public enum CentraidCatalog {",
            "    /// The first-party apps, in CATALOGUE order — the all-apps",
            "    /// listing's order, which says nothing about the grid.",
            "    public static let apps: [CentraidAppMeta] = [",
        ]
        .map(str::to_owned),
    );
    for app in apps {
        swift.push(format!(
            "        CentraidAppMeta(id: {}, name: {}, desc: {}, iconKey: {}, colorKey: {}),",
            quote(&app.id),
            quote(&app.name),
            quote(&app.desc),
            quote(&app.icon_key),
            quote(&app.color_key)
        ));
    }
    swift.extend(
        [
            "    ]",
            "",
            "    /// By id, for the header that names one app.",
            "    public static let byID: [String: CentraidAppMeta] = Dictionary(",
            "        uniqueKeysWithValues: apps.map { ($0.id, $0) })",
            "",
        ]
        .map(str::to_owned),
    );
    for scheme in ["light", "dark"] {
        swift.push(format!(
            "    public static let {scheme}Marks: [String: CentraidAppMark] = ["
        ));
        for app in apps {
            let (hue, chip, mark) = marks(app, scheme);
            swift.push(format!(
                "        {}: CentraidAppMark(hue: {}, chipBackground: {}, markColor: {}),",
                quote(&app.id),
                swift_color(hue)?,
                swift_color(chip)?,
                swift_color(mark)?
            ));
        }
        swift.push("    ]".into());
        swift.push(String::new());
    }
    swift.extend(
        [
            "    /// Lucide-style silhouettes as raw SVG path data, viewBox 24x24.",
            "    ///",
            "    /// ONE ordered list per icon, drawn in order. See the Kotlin table:",
            "    /// neither shell ships a second icon set.",
            "    public static let icons: [String: [CentraidIconPath]] = [",
        ]
        .map(str::to_owned),
    );
    for (name, paths) in &tokens.icons {
        swift.push(format!("        {}: [", quote(name)));
        for path in paths {
            swift.push(format!(
                "            CentraidIconPath(d: {}, filled: {}, evenOdd: {}),",
                quote(&path.d),
                path.filled,
                path.even_odd
            ));
        }
        swift.push("        ],".into());
    }
    swift.extend(
        [
            "    ]",
            "}",
            "",
            "/// Geometry both shells need that the token table does not carry.",
            "public enum CentraidGeometry {",
        ]
        .map(str::to_owned),
    );
    for (name, value) in &tokens.native.geometry {
        swift.push(format!(
            "    public static let {name}: CGFloat = {}",
            js_number(*value)
        ));
    }
    swift.push("}".into());
    swift.push(String::new());
    Ok(swift.join("\n"))
}

// --- the redesign's colours: asset catalogue and Android resources -------------

/// One named colour with its two appearances.
struct ColorAsset {
    /// `app_agenda`; the iOS name is `CentraidAppAgenda`, the Android one
    /// `centraid_app_agenda`.
    snake: String,
    light: String,
    dark: String,
}

impl ColorAsset {
    fn ios_name(&self) -> String {
        let mut out = String::from("Centraid");
        for part in self.snake.split('_') {
            let mut chars = part.chars();
            if let Some(first) = chars.next() {
                out.push(first.to_ascii_uppercase());
                out.push_str(chars.as_str());
            }
        }
        out
    }

    fn android_name(&self) -> String {
        format!("centraid_{}", self.snake)
    }
}

fn accent_assets(out: &mut Vec<ColorAsset>, prefix: &str, id: &str, accent: &Accent, tile: bool) {
    let base = if id.is_empty() {
        prefix.to_owned()
    } else {
        format!("{prefix}_{id}")
    };
    out.push(ColorAsset {
        snake: base.clone(),
        light: accent.light.clone(),
        dark: accent.dark_fill.clone(),
    });
    out.push(ColorAsset {
        snake: format!("{base}_text"),
        light: accent.light.clone(),
        dark: accent.dark_text.clone(),
    });
    if let (Some(tint), Some(dark_tint)) = (&accent.tint, &accent.dark_tint) {
        out.push(ColorAsset {
            snake: format!("{base}_tint"),
            light: tint.clone(),
            dark: dark_tint.clone(),
        });
    }
    if tile {
        out.push(ColorAsset {
            snake: format!("{base}_tile"),
            light: accent.tile.clone().unwrap_or_else(|| accent.light.clone()),
            dark: accent
                .tile
                .clone()
                .unwrap_or_else(|| accent.dark_fill.clone()),
        });
    }
}

/// Every redesign colour as an asset, in a fixed order.
///
/// Every surface has both schemes, so every surface is a two-appearance asset.
fn color_assets(tokens: &Tokens) -> Vec<ColorAsset> {
    let mut out = Vec::new();
    let (ls, ds) = (&tokens.surface.light, &tokens.surface.dark);
    for (name, light, dark) in [
        ("page", &ls.page, &ds.page),
        ("plain_page", &ls.plain_page, &ds.plain_page),
        ("card", &ls.card, &ds.card),
        ("sheet", &ls.sheet, &ds.sheet),
        ("sheet_card", &ls.sheet_card, &ds.sheet_card),
        ("fill", &ls.fill, &ds.fill),
        ("line", &ls.line, &ds.line),
        ("border", &ls.border, &ds.border),
    ] {
        out.push(ColorAsset {
            snake: format!("surface_{name}"),
            light: light.clone(),
            dark: dark.clone(),
        });
    }
    let (lt, dt) = (&tokens.text.light, &tokens.text.dark);
    for (name, light, dark) in [
        ("ink", &lt.ink, &dt.ink),
        ("body", &lt.body, &dt.body),
        ("meta", &lt.meta, &dt.meta),
    ] {
        out.push(ColorAsset {
            snake: format!("text_{name}"),
            light: light.clone(),
            dark: dark.clone(),
        });
    }
    accent_assets(&mut out, "shell", "", &tokens.shell, false);
    for (id, accent) in &tokens.app {
        accent_assets(&mut out, "app", id, accent, true);
    }
    for (id, accent) in &tokens.state {
        accent_assets(&mut out, "state", id, accent, false);
    }
    for (id, value) in &tokens.list {
        out.push(ColorAsset {
            snake: format!("list_{id}"),
            light: value.clone(),
            dark: value.clone(),
        });
    }
    out
}

fn rgb(hex: &str) -> Result<(u8, u8, u8)> {
    let color = centraid_design::tokens::Rgb::parse_hex(hex)
        .with_context(|| format!("not a #RRGGBB colour: {hex}"))?;
    Ok((color.r, color.g, color.b))
}

/// Xcode's own JSON spelling, so a person opening the catalogue in Xcode and
/// saving does not produce a diff.
fn colorset_json(asset: &ColorAsset) -> Result<String> {
    let entry = |hex: &str, dark: bool| -> Result<String> {
        let (r, g, b) = rgb(hex)?;
        let appearances = if dark {
            "      \"appearances\" : [\n        {\n          \"appearance\" : \"luminosity\",\n          \"value\" : \"dark\"\n        }\n      ],\n"
        } else {
            ""
        };
        Ok(format!(
            "    {{\n{appearances}      \"color\" : {{\n        \"color-space\" : \"srgb\",\n        \"components\" : {{\n          \"alpha\" : \"1.000\",\n          \"blue\" : \"0x{b:02X}\",\n          \"green\" : \"0x{g:02X}\",\n          \"red\" : \"0x{r:02X}\"\n        }}\n      }},\n      \"idiom\" : \"universal\"\n    }}"
        ))
    };
    Ok(format!(
        "{{\n  \"colors\" : [\n{},\n{}\n  ],\n  \"info\" : {{\n    \"author\" : \"xcode\",\n    \"version\" : 1\n  }}\n}}\n",
        entry(&asset.light, false)?,
        entry(&asset.dark, true)?
    ))
}

const XCASSETS_INFO: &str =
    "{\n  \"info\" : {\n    \"author\" : \"xcode\",\n    \"version\" : 1\n  }\n}\n";

fn colors_xml(assets: &[ColorAsset], night: bool) -> Result<String> {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n");
    out.push_str(
        "<!--\n  GENERATED by `cargo xtask design` from `design/tokens.toml`. Do not edit.\n\n",
    );
    if night {
        out.push_str("  The dark values: only the colours whose dark value differs from the one in\n  `values/colors.xml`. Android falls back to the default for the rest.\n");
    } else {
        out.push_str("  Every redesign colour, light. A value that exists in one scheme only keeps\n  that scheme in its name (`..._light`, `..._dark`). `values-night/colors.xml`\n  holds the dark values.\n");
    }
    out.push_str("-->\n<resources>\n");
    for asset in assets {
        let value = if night {
            if asset.light.eq_ignore_ascii_case(&asset.dark) {
                continue;
            }
            &asset.dark
        } else {
            &asset.light
        };
        let (r, g, b) = rgb(value)?;
        let _ = writeln!(
            out,
            "    <color name=\"{}\">#{r:02X}{g:02X}{b:02X}</color>",
            asset.android_name()
        );
    }
    out.push_str("</resources>\n");
    Ok(out)
}

fn camel(snake: &str) -> String {
    let mut out = String::new();
    for (index, part) in snake.split('_').enumerate() {
        if index == 0 {
            out.push_str(part);
        } else {
            let mut chars = part.chars();
            if let Some(first) = chars.next() {
                out.push(first.to_ascii_uppercase());
                out.push_str(chars.as_str());
            }
        }
    }
    out
}

fn dimens_xml(tokens: &Tokens) -> String {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n");
    out.push_str("<!--\n  GENERATED by `cargo xtask design` from `design/tokens.toml`. Do not edit.\n\n  The redesign's type scale (sp), weights and radii (dp).\n-->\n<resources>\n");
    for (name, step) in &tokens.scale {
        let _ = writeln!(
            out,
            "    <dimen name=\"centraid_text_{name}\">{}sp</dimen>",
            step.size
        );
    }
    let _ = writeln!(
        out,
        "    <dimen name=\"centraid_radius_card\">{}dp</dimen>",
        tokens.radius.card
    );
    for (name, step) in &tokens.scale {
        let _ = writeln!(
            out,
            "    <integer name=\"centraid_weight_{name}\">{}</integer>",
            step.weight
        );
    }
    out.push_str("</resources>\n");
    out
}

fn design_scale_swift(tokens: &Tokens, assets: &[ColorAsset]) -> String {
    let mut out = String::new();
    out.push_str(
        "// GENERATED by `cargo xtask design` from `design/tokens.toml`. Do not edit.\n//\n",
    );
    out.push_str(
        "// The redesign's type scale and radii (#1173), in points, and the names of its\n",
    );
    out.push_str("// colour sets in `Resources/Assets.xcassets`. Light and dark are built into\n");
    out.push_str("// each set, so `Color(CentraidAsset.appAgenda)` follows the appearance.\n\n");
    out.push_str("import CoreGraphics\n\n");
    out.push_str("public enum CentraidScale {\n");
    for (name, step) in &tokens.scale {
        let _ = writeln!(
            out,
            "    public static let {name}Size: CGFloat = {}",
            step.size
        );
        let _ = writeln!(out, "    public static let {name}Weight = {}", step.weight);
        let _ = writeln!(out, "    public static let {name}Caps = {}", step.caps);
    }
    let _ = writeln!(
        out,
        "    public static let cardRadius: CGFloat = {}",
        tokens.radius.card
    );
    out.push_str("}\n\npublic enum CentraidAsset {\n");
    for asset in assets {
        let _ = writeln!(
            out,
            "    public static let {} = \"{}\"",
            camel(&asset.snake),
            asset.ios_name()
        );
    }
    out.push_str("}\n");
    out
}

// --- the sites ----------------------------------------------------------------

fn site_sheet(body: &str) -> String {
    let mut out = String::new();
    out.push_str("/* Centraid — the product design system, lowered onto the public site.\n");
    out.push_str(" *\n");
    out.push_str(" * GENERATED by `cargo xtask design` from design/site/tokens.css and\n");
    out.push_str(" * design/fonts. Do not edit by hand: the gate's `design` step fails on any\n");
    out.push_str(" * drift, and `cargo xtask design` is the only sanctioned way to change it.\n");
    out.push_str(" *\n");
    out.push_str(" * The home page and the docs share this file so neither can grow a palette,\n");
    out.push_str(" * a face, or a type scale the product does not have.\n");
    out.push_str(" */\n\n");
    out.push_str(body);
    out
}

// --- the run --------------------------------------------------------------------

/// Generate every artifact into memory.
pub fn emit(root: &Path) -> Result<Emitted> {
    let tokens = Tokens::load(root).context("design/tokens.toml")?;
    let (faces, font_files) = resolve_faces(&tokens, root)?;
    let mut files: BTreeMap<String, Vec<u8>> = font_files;
    let mut put = |path: String, text: String| {
        files.insert(path, text.into_bytes());
    };

    put(
        format!("{SWIFT_DIR}/Theme.swift"),
        theme_swift(&tokens, &faces)?,
    );
    put(
        format!("{KOTLIN_DIR}/Tokens.kt"),
        tokens_kt(&tokens, &faces)?,
    );
    put(
        format!("{SWIFT_DIR}/Catalog.swift"),
        catalog_swift(&tokens)?,
    );
    put(format!("{KOTLIN_DIR}/Catalog.kt"), catalog_kt(&tokens)?);

    // The kit's words, from the Rust catalogue's source text.
    let read = |relative: &str| {
        std::fs::read_to_string(root.join(relative)).with_context(|| format!("read {relative}"))
    };
    let mut others = BTreeMap::new();
    for (module, file) in design_words::OTHER_SOURCES {
        others.insert(module.to_owned(), read(file)?);
    }
    let words = design_words::resolve(&read(design_words::WORDS_SOURCE)?, &others)?;
    put(
        format!("{KOTLIN_DIR}/Words.kt"),
        design_words::kotlin(&words),
    );
    put(
        format!("{SWIFT_DIR}/Words.swift"),
        design_words::swift(&words),
    );

    // The redesign's colours, scale and radii.
    let assets = color_assets(&tokens);
    put(
        format!("{SWIFT_DIR}/DesignScale.swift"),
        design_scale_swift(&tokens, &assets),
    );
    put(
        format!("{IOS_COLORS}/Contents.json"),
        XCASSETS_INFO.to_owned(),
    );
    put(
        format!("{IOS_COLORS}/Colors/Contents.json"),
        XCASSETS_INFO.to_owned(),
    );
    for asset in &assets {
        put(
            format!(
                "{IOS_COLORS}/Colors/{}.colorset/Contents.json",
                asset.ios_name()
            ),
            colorset_json(asset)?,
        );
    }
    put(
        format!("{ANDROID_RES}/values/colors.xml"),
        colors_xml(&assets, false)?,
    );
    put(
        format!("{ANDROID_RES}/values-night/colors.xml"),
        colors_xml(&assets, true)?,
    );
    put(
        format!("{ANDROID_RES}/values/dimens.xml"),
        dimens_xml(&tokens),
    );

    // The sites: the sheet and the woff2 faces beside it.
    let body = read(SITE_SOURCE)?;
    let sheet = site_sheet(&body);
    let mut woff2 = BTreeMap::new();
    let fonts_dir = root.join(FONT_SOURCE);
    for entry in
        std::fs::read_dir(&fonts_dir).with_context(|| format!("read {}", fonts_dir.display()))?
    {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "woff2") {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .context("a font file name")?
                .to_owned();
            woff2.insert(name, std::fs::read(&path)?);
        }
    }
    if woff2.is_empty() {
        bail!("{FONT_SOURCE} holds no .woff2 face for the sites");
    }
    for dir in SITE_ASSETS {
        files.insert(format!("{dir}/{SITE_SHEET}"), sheet.clone().into_bytes());
        for (name, bytes) in &woff2 {
            files.insert(format!("{dir}/fonts/{name}"), bytes.clone());
        }
    }

    let mut owned = vec![
        IOS_FONTS.to_owned(),
        ANDROID_FONTS.to_owned(),
        format!("{IOS_COLORS}/Colors"),
    ];
    owned.extend(SITE_ASSETS.iter().map(|dir| format!("{dir}/fonts")));
    Ok(Emitted { files, owned })
}

fn list_files(root: &Path, dir: &str) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, out);
            } else if let Ok(relative) = path.strip_prefix(base) {
                out.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, &root.join(dir), &mut out);
    out.sort();
    out
}

/// Write every artifact, removing a file in an owned directory that is no
/// longer emitted. Returns how many files were written.
pub fn write(root: &Path) -> Result<usize> {
    let emitted = emit(root)?;
    for dir in &emitted.owned {
        for existing in list_files(root, dir) {
            if !emitted.files.contains_key(&existing) {
                std::fs::remove_file(root.join(&existing))
                    .with_context(|| format!("remove {existing}"))?;
            }
        }
    }
    for (relative, bytes) in &emitted.files {
        let path: PathBuf = root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Skip an identical file so a no-op run touches nothing.
        if std::fs::read(&path).is_ok_and(|have| &have == bytes) {
            continue;
        }
        std::fs::write(&path, bytes).with_context(|| format!("write {relative}"))?;
    }
    Ok(emitted.files.len())
}

/// Name every file of `emitted` that differs from the committed one: changed,
/// missing, or present in an owned directory without being emitted. Empty means
/// the tree is current.
#[must_use]
pub fn compare(emitted: &Emitted, root: &Path) -> Vec<String> {
    let mut drift = Vec::new();
    for (relative, bytes) in &emitted.files {
        match std::fs::read(root.join(relative)) {
            Ok(have) if &have == bytes => {}
            Ok(_) => drift.push(format!("{relative}: differs from the generator")),
            Err(_) => drift.push(format!("{relative}: missing")),
        }
    }
    let mut stray = BTreeSet::new();
    for dir in &emitted.owned {
        for existing in list_files(root, dir) {
            if !emitted.files.contains_key(&existing) {
                stray.insert(existing);
            }
        }
    }
    drift.extend(
        stray
            .into_iter()
            .map(|file| format!("{file}: not emitted by `cargo xtask design`")),
    );
    drift
}

/// Regenerate into memory and [`compare`] with the tree.
pub fn check(root: &Path) -> Result<Vec<String>> {
    Ok(compare(&emit(root)?, root))
}

/// The `cargo xtask design [--check]` entry.
pub fn run(root: &Path, check_only: bool) -> Result<()> {
    if check_only {
        let drift = check(root)?;
        if drift.is_empty() {
            return Ok(());
        }
        bail!(
            "{} generated design file(s) are stale:\n  {}\nRun `cargo xtask design` and commit the result.",
            drift.len(),
            drift.join("\n  ")
        );
    }
    let count = write(root)?;
    eprintln!("design: {count} files from design/tokens.toml");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    /// The committed artifacts are what the generator emits now. This is the
    /// same comparison as the gate's `design` step, run as a test so a token
    /// edit that forgets to regenerate is red in `cargo test -p xtask` too.
    #[test]
    fn the_committed_design_artifacts_are_current() {
        let drift = check(&root()).expect("the generator runs");
        assert!(drift.is_empty(), "stale:\n{}", drift.join("\n"));
    }

    #[test]
    fn numbers_keep_their_javascript_spelling() {
        assert_eq!(js_number(27.0), "27");
        assert_eq!(js_number(0.26), "0.26");
        assert_eq!(js_number(1.75), "1.75");
        assert_eq!(js_round(76.5), 77.0);
        assert_eq!(screaming_snake("appMarkViewBox"), "APP_MARK_VIEW_BOX");
        assert_eq!(screaming_snake("durationOne"), "DURATION_ONE");
    }

    #[test]
    fn a_colour_lowers_to_the_same_channels_in_both_languages() {
        assert_eq!(
            kotlin_color("rgba(20,20,20,.08)").expect("rgba"),
            "0x14141414L"
        );
        assert_eq!(kotlin_color("#00707e").expect("hex"), "0xFF00707EL");
        assert_eq!(
            swift_color("#00707e").expect("hex"),
            "Color(.sRGB, red: 0.000000, green: 0.439216, blue: 0.494118, opacity: 1.000000)"
        );
        assert!(kotlin_color("0 1px 2px rgba(0,0,0,.1)").is_err());
    }

    #[test]
    fn asset_names_are_prefixed_and_cased_for_each_platform() {
        let asset = ColorAsset {
            snake: "app_agenda_text".into(),
            light: "#266FC4".into(),
            dark: "#569EF7".into(),
        };
        assert_eq!(asset.ios_name(), "CentraidAppAgendaText");
        assert_eq!(asset.android_name(), "centraid_app_agenda_text");
        assert_eq!(camel(&asset.snake), "appAgendaText");
    }

    #[test]
    fn a_colour_set_carries_light_then_dark_in_xcodes_spelling() {
        let asset = ColorAsset {
            snake: "app_agenda".into(),
            light: "#266FC4".into(),
            dark: "#3077CD".into(),
        };
        let json = colorset_json(&asset).expect("json");
        assert!(json.contains("\"red\" : \"0x26\""), "{json}");
        assert!(json.contains("\"value\" : \"dark\""), "{json}");
        let dark = json.find("\"value\" : \"dark\"").expect("dark entry");
        assert!(json[dark..].contains("\"red\" : \"0x30\""), "{json}");
    }
}
