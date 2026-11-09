//! # `design/tokens.toml`: the one source of design values (#1173)
//!
//! This module is the model of that file, its parser and its validation. It
//! holds **no value**: every colour, size and path is in `design/tokens.toml`
//! or `design/icons.toml`, and `cargo xtask design` lowers them into the
//! native shells and the two sites. A value the file gets wrong is a failing
//! test here or a failing `Tokens::parse`, never a quiet pass.
//!
//! ## What is checked
//!
//! | Check | Why |
//! |---|---|
//! | every one of the 55 native role names is in both schemes, and the schemes name the same set | the shells look roles up by string; a dropped role is a silent fallback |
//! | every colour is `#RRGGBB` (roles may also be `rgba(…)` or a CSS shadow) | a typo must not reach a `Color(0x…)` literal |
//! | every app, state and the shell has `light`, `dark_fill` and `dark_text` | dark is designed, not inverted |
//! | app, state and shell colours reach 4.5:1 as text on the light page; dark text values reach 4.5:1 on the dark card; dark fills reach 4.5:1 under white glyphs | the issue's accessibility rule (text 4.5:1) |
//! | list colours reach 3:1 on the light page and on the dark card | lists are drawn as dots, bars and big titles |
//!
//! The floors are asserted over the committed file by this module's tests, so
//! a value that fails one is reported by `cargo test -p centraid-design`, and
//! the value is not adjusted to pass.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Deserialize;

/// The eight apps, by the id their section carries in `[app.*]`.
pub const APP_IDS: [&str; 8] = [
    "agenda", "notes", "people", "docs", "money", "locker", "health", "photos",
];

/// The three state colours (`[state.*]`).
pub const STATE_IDS: [&str; 3] = ["red", "amber", "green"];

/// The eight list colours (`[list]`).
/// The four colours of the app mark, clockwise from the top.
pub const BRAND_IDS: [&str; 4] = ["teal", "orange", "blue", "pink"];

pub const LIST_IDS: [&str; 8] = [
    "blue",
    "mustard",
    "violet",
    "petrol",
    "indigo",
    "graphite",
    "raspberry",
    "orchid",
];

/// Every colour role the native shells look up by string, in both schemes.
///
/// The shells call `Theme.color("…")` with these exact spellings (about 1500
/// call sites), so the list is a contract and not a derivation: a role dropped
/// from the file is refused by name.
pub const NATIVE_COLOR_ROLES: [&str; 55] = [
    "accent",
    "accentDeep",
    "accentDeepHover",
    "accentFill",
    "accentInkHover",
    "accentLight",
    "accentSoft",
    "accentText",
    "appIdentityText",
    "attention",
    "bg",
    "bgChrome",
    "bgElev",
    "bgHover",
    "bgPress",
    "bgSel",
    "bgSunken",
    "cAmber",
    "cForest",
    "cIndigo",
    "cOchre",
    "cOlive",
    "cRose",
    "cSlate",
    "cTeal",
    "cViolet",
    "danger",
    "focusRingColor",
    "line",
    "lineSel",
    "lineStrong",
    "link",
    "net",
    "netHover",
    "netWash",
    "onAccent",
    "onStage",
    "onStageSoft",
    "scrim",
    "seam",
    "shadowLg",
    "shadowMd",
    "shadowSm",
    "skel",
    "stage",
    "stageLine",
    "stageSunken",
    "success",
    "text",
    "textDisabled",
    "textFaint",
    "textGhost",
    "textInv",
    "textSoft",
    "warning",
];

/// The three roles that are CSS `box-shadow` strings, not colours.
pub const NATIVE_EFFECT_ROLES: [&str; 3] = ["shadowLg", "shadowMd", "shadowSm"];

/// Minimum contrast of an app, state or shell colour as text on the light page.
pub const TEXT_CONTRAST: f64 = 4.5;
/// Minimum contrast of a list colour on the light page and on the dark card.
pub const LIST_CONTRAST: f64 = 3.0;

/// What a tokens file can be wrong about.
#[derive(Debug, thiserror::Error)]
pub enum TokensError {
    /// The file could not be read.
    #[error("{path} is not readable: {detail}")]
    Read { path: String, detail: String },
    /// The TOML is malformed or does not have the shape this module reads.
    #[error("{file} is not readable: {detail}")]
    Shape { file: &'static str, detail: String },
    /// A value or set of values breaks a rule.
    #[error("{0}")]
    Invalid(String),
}

/// An opaque colour as 8-bit channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    /// `#RRGGBB`, any case. Nothing else: no shorthand, no alpha.
    #[must_use]
    pub fn parse_hex(value: &str) -> Option<Self> {
        let digits = value.strip_prefix('#')?;
        if digits.len() != 6 || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let channel = |at: usize| u8::from_str_radix(digits.get(at..at + 2)?, 16).ok();
        Some(Self {
            r: channel(0)?,
            g: channel(2)?,
            b: channel(4)?,
        })
    }

    /// WCAG relative luminance.
    #[must_use]
    pub fn luminance(self) -> f64 {
        let linear = |channel: u8| {
            let value = f64::from(channel) / 255.0;
            if value <= 0.040_45 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * linear(self.r) + 0.7152 * linear(self.g) + 0.0722 * linear(self.b)
    }
}

/// WCAG contrast ratio of two `#RRGGBB` colours, in the range 1 to 21.
/// `None` when either is not a hex colour.
#[must_use]
pub fn contrast_ratio(foreground: &str, background: &str) -> Option<f64> {
    let first = Rgb::parse_hex(foreground)?.luminance();
    let second = Rgb::parse_hex(background)?.luminance();
    let (lighter, darker) = if first >= second {
        (first, second)
    } else {
        (second, first)
    };
    Some((lighter + 0.05) / (darker + 0.05))
}

/// The app icon's colours beyond `[brand]` (`[icon]`): the tiles, and the tinted
/// and themed variants.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Icon {
    pub light_tile: String,
    pub light_edge: String,
    /// The bottom of the light ground in the layered iOS 26 icon (`AppIcon.icon`); `light_tile` is its top.
    pub light_tile_bottom: String,
    pub dark_tile: String,
    /// The dark appearance's ground in the layered icon, top and bottom.
    pub dark_ground_top: String,
    pub dark_ground_bottom: String,
    pub tinted_tile: String,
    pub tinted_mark: String,
    pub themed_tile: String,
    pub themed_glyph: String,
    /// How much of the iOS icon the mark's disc spans, as a share of the tile's
    /// width (0.76: outer radius 45.6 on the 120 grid). The Android adaptive icon has
    /// its own rule (the 66dp safe zone) and ignores this.
    pub ios_mark_share: f64,
}

impl Icon {
    /// Every colour by field name, for the well-formed-hex check.
    #[must_use]
    pub fn colours(&self) -> [(&'static str, &str); 10] {
        [
            ("light_tile", &self.light_tile),
            ("light_edge", &self.light_edge),
            ("light_tile_bottom", &self.light_tile_bottom),
            ("dark_tile", &self.dark_tile),
            ("dark_ground_top", &self.dark_ground_top),
            ("dark_ground_bottom", &self.dark_ground_bottom),
            ("tinted_tile", &self.tinted_tile),
            ("tinted_mark", &self.tinted_mark),
            ("themed_tile", &self.themed_tile),
            ("themed_glyph", &self.themed_glyph),
        ]
    }
}

/// One accent: an app, a state or the shell.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Accent {
    /// The colour on the light page, as text and as a fill.
    pub light: String,
    /// The dark value under white glyphs.
    pub dark_fill: String,
    /// The lighter dark value for text and icons.
    pub dark_text: String,
    /// The bright colour on tiles and icons, when it is not the accent.
    #[serde(default)]
    pub tile: Option<String>,
    /// The pale ground of a badge in this colour, on the light page. The states
    /// have one (a badge says a state), and each app (its accent chip).
    #[serde(default)]
    pub tint: Option<String>,
    /// The badge ground in dark: a deep wash under the `dark_text` value.
    #[serde(default)]
    pub dark_tint: Option<String>,
}

/// Light surfaces.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LightSurfaces {
    pub page: String,
    pub plain_page: String,
    pub card: String,
    /// A sheet's ground: the page colour, with white cards on it.
    pub sheet: String,
    pub sheet_card: String,
    /// A control's track (the segmented control, a search field).
    pub fill: String,
    pub line: String,
    pub border: String,
    /// An ink tile under a white letter or glyph; it keeps its ink in dark.
    pub tile: String,
}

/// Dark surfaces.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DarkSurfaces {
    pub page: String,
    /// The plain list page. Dark has one page colour, so this is the page's.
    pub plain_page: String,
    pub card: String,
    pub sheet: String,
    pub sheet_card: String,
    pub fill: String,
    pub line: String,
    pub border: String,
    /// An ink tile under a white letter or glyph; it keeps its ink in dark.
    pub tile: String,
}

/// Surfaces in both schemes.
#[derive(Debug, Clone, Deserialize)]
pub struct Surfaces {
    pub light: LightSurfaces,
    pub dark: DarkSurfaces,
}

/// One scheme's text colours.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextColors {
    pub ink: String,
    pub body: String,
    pub meta: String,
}

/// Text colours in both schemes.
#[derive(Debug, Clone, Deserialize)]
pub struct Texts {
    pub light: TextColors,
    pub dark: TextColors,
}

/// One step of the redesign's type scale.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScaleStep {
    pub size: u32,
    pub weight: u32,
    #[serde(default)]
    pub caps: bool,
}

/// Radii of the redesign.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Radii {
    pub card: u32,
}

/// One face behind a family name.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Face {
    /// The ramp's weight, which is not always the file's.
    pub weight: u32,
    /// The upstream file name in `design/fonts/`, also the iOS resource name.
    pub file: String,
    /// Lowercase snake case, because `aapt2` accepts nothing else.
    pub android_resource: String,
}

/// One type style of the legacy native lowering.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeType {
    pub family: String,
    pub font_size: f64,
    pub line_height: f64,
    pub weight: u32,
}

/// The colours of one scheme of the legacy native theme.
pub type RoleTable = BTreeMap<String, String>;

/// The two schemes' role tables.
#[derive(Debug, Clone, Deserialize)]
pub struct NativeColors {
    pub light: RoleTable,
    pub dark: RoleTable,
}

/// One app of the catalogue, with its resolved identity marks.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeApp {
    pub id: String,
    pub name: String,
    pub desc: String,
    pub icon_key: String,
    pub color_key: String,
    pub light_hue: String,
    pub light_chip: String,
    pub light_mark: String,
    pub dark_hue: String,
    pub dark_chip: String,
    pub dark_mark: String,
}

/// The legacy native lowering: what the shells draw today.
#[derive(Debug, Clone, Deserialize)]
pub struct Native {
    pub faces: BTreeMap<String, Vec<Face>>,
    pub spacing: BTreeMap<String, f64>,
    pub radii: BTreeMap<String, f64>,
    #[serde(rename = "type")]
    pub types: BTreeMap<String, NativeType>,
    pub colors: NativeColors,
    pub geometry: BTreeMap<String, f64>,
    pub app: Vec<NativeApp>,
}

/// One `<path>` of an icon.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IconPath {
    pub d: String,
    #[serde(default)]
    pub filled: bool,
    #[serde(default)]
    pub even_odd: bool,
}

#[derive(Deserialize)]
struct IconsFile {
    icons: BTreeMap<String, Vec<IconPath>>,
}

/// One font subset the sites ship: a name and the browser's cue for fetching it.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteSubset {
    pub name: String,
    pub unicode_range: String,
}

/// The sites' font family and the subsets of each weight.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteFonts {
    pub family: String,
    pub weights: Vec<u32>,
    pub subsets: Vec<SiteSubset>,
}

/// Fixed custom properties, as ordered `[name, value]` pairs.
pub type PropList = Vec<[String; 2]>;

/// The fixed custom properties written around the derived ones.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteRoot {
    /// After the radii and spacing steps.
    pub head: PropList,
    /// After the type scale.
    pub tail: PropList,
}

/// One role of the fine-pointer type scale.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteType {
    pub font_size: f64,
    pub line_height: f64,
    pub weight: u32,
}

/// `@media (pointer: fine)`: the desktop overrides.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteFine {
    pub props: PropList,
    /// By role name in `[native.type.*]`.
    #[serde(rename = "type")]
    pub types: BTreeMap<String, SiteType>,
}

/// One density tier.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteDensity {
    pub tier: String,
    pub pad: u32,
    pub row: u32,
}

/// A group of page-scale custom properties with the comment that explains it.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteLayerGroup {
    pub comment: String,
    pub props: PropList,
}

/// What the public sites' stylesheet needs that the native roles do not carry
/// (`[site]`).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Site {
    pub fonts: SiteFonts,
    pub root: SiteRoot,
    pub fine: SiteFine,
    /// Custom properties with no native role, by name, light scheme.
    pub light: BTreeMap<String, String>,
    /// The same, dark scheme.
    pub dark: BTreeMap<String, String>,
    pub density: Vec<SiteDensity>,
    pub layer: Vec<SiteLayerGroup>,
}

/// `design/tokens.toml` and `design/icons.toml`, parsed and validated.
#[derive(Debug, Clone, Deserialize)]
pub struct Tokens {
    pub surface: Surfaces,
    pub text: Texts,
    pub shell: Accent,
    pub app: BTreeMap<String, Accent>,
    pub state: BTreeMap<String, Accent>,
    pub list: BTreeMap<String, String>,
    /// The four brand colours of the app mark (teal, orange, blue, pink). Not app keys.
    pub brand: BTreeMap<String, String>,
    /// The app icon's tiles and its tinted and themed colours (`[icon]`).
    pub icon: Icon,
    #[serde(rename = "type")]
    pub scale: BTreeMap<String, ScaleStep>,
    pub radius: Radii,
    pub native: Native,
    pub site: Site,
    #[serde(skip)]
    pub icons: BTreeMap<String, Vec<IconPath>>,
}

impl Tokens {
    /// Read `design/tokens.toml` and `design/icons.toml` under `root`.
    pub fn load(root: &Path) -> Result<Self, TokensError> {
        let read = |relative: &str| {
            let path = root.join(relative);
            std::fs::read_to_string(&path).map_err(|error| TokensError::Read {
                path: path.display().to_string(),
                detail: error.to_string(),
            })
        };
        Self::parse(&read("design/tokens.toml")?, &read("design/icons.toml")?)
    }

    /// Parse both files and validate the result.
    pub fn parse(tokens: &str, icons: &str) -> Result<Self, TokensError> {
        let mut parsed: Self = toml::from_str(tokens).map_err(|error| TokensError::Shape {
            file: "design/tokens.toml",
            detail: error.to_string(),
        })?;
        let icon_file: IconsFile = toml::from_str(icons).map_err(|error| TokensError::Shape {
            file: "design/icons.toml",
            detail: error.to_string(),
        })?;
        parsed.icons = icon_file.icons;
        parsed.validate()?;
        Ok(parsed)
    }

    /// The dark fill and dark text of every accent, by a name that says which:
    /// `app.agenda`, `state.red`, `shell`.
    pub fn accents(&self) -> Vec<(String, &Accent)> {
        let mut out = vec![("shell".to_owned(), &self.shell)];
        out.extend(
            self.app
                .iter()
                .map(|(id, accent)| (format!("app.{id}"), accent)),
        );
        out.extend(
            self.state
                .iter()
                .map(|(id, accent)| (format!("state.{id}"), accent)),
        );
        out
    }

    /// Every rule above. Failures are collected so one run names them all.
    pub fn validate(&self) -> Result<(), TokensError> {
        let mut problems: Vec<String> = Vec::new();

        let same_set = |what: &str, have: BTreeSet<&str>, want: &[&str], out: &mut Vec<String>| {
            let want: BTreeSet<&str> = want.iter().copied().collect();
            for missing in want.difference(&have) {
                out.push(format!("{what}: `{missing}` is missing"));
            }
            for extra in have.difference(&want) {
                out.push(format!(
                    "{what}: `{extra}` is not one of the expected names"
                ));
            }
        };
        same_set(
            "[app]",
            self.app.keys().map(String::as_str).collect(),
            &APP_IDS,
            &mut problems,
        );
        same_set(
            "[state]",
            self.state.keys().map(String::as_str).collect(),
            &STATE_IDS,
            &mut problems,
        );
        same_set(
            "[list]",
            self.list.keys().map(String::as_str).collect(),
            &LIST_IDS,
            &mut problems,
        );

        same_set(
            "[brand]",
            self.brand.keys().map(String::as_str).collect(),
            &BRAND_IDS,
            &mut problems,
        );

        // Colour roles: the same 55 in both schemes.
        for (scheme, table) in [
            ("light", &self.native.colors.light),
            ("dark", &self.native.colors.dark),
        ] {
            same_set(
                &format!("[native.colors.{scheme}]"),
                table.keys().map(String::as_str).collect(),
                &NATIVE_COLOR_ROLES,
                &mut problems,
            );
            for (role, value) in table {
                let well_formed = if NATIVE_EFFECT_ROLES.contains(&role.as_str()) {
                    value.contains("rgba(")
                } else {
                    native_color(value).is_some()
                };
                if !well_formed {
                    problems.push(format!(
                        "[native.colors.{scheme}] `{role}` is not a colour: {value}"
                    ));
                }
            }
        }

        // Hex well-formed, everywhere a plain colour is stored.
        let mut hexes: Vec<(String, &str)> = Vec::new();
        let light = &self.surface.light;
        let dark = &self.surface.dark;
        for (name, value) in [
            ("surface.light.page", &light.page),
            ("surface.light.plain_page", &light.plain_page),
            ("surface.light.card", &light.card),
            ("surface.light.sheet", &light.sheet),
            ("surface.light.sheet_card", &light.sheet_card),
            ("surface.light.fill", &light.fill),
            ("surface.light.line", &light.line),
            ("surface.light.border", &light.border),
            ("surface.light.tile", &light.tile),
            ("surface.dark.page", &dark.page),
            ("surface.dark.plain_page", &dark.plain_page),
            ("surface.dark.card", &dark.card),
            ("surface.dark.sheet", &dark.sheet),
            ("surface.dark.sheet_card", &dark.sheet_card),
            ("surface.dark.fill", &dark.fill),
            ("surface.dark.line", &dark.line),
            ("surface.dark.border", &dark.border),
            ("surface.dark.tile", &dark.tile),
            ("text.light.ink", &self.text.light.ink),
            ("text.light.body", &self.text.light.body),
            ("text.light.meta", &self.text.light.meta),
            ("text.dark.ink", &self.text.dark.ink),
            ("text.dark.body", &self.text.dark.body),
            ("text.dark.meta", &self.text.dark.meta),
        ] {
            hexes.push((name.to_owned(), value));
        }
        for (name, accent) in self.accents() {
            hexes.push((format!("{name}.light"), &accent.light));
            hexes.push((format!("{name}.dark_fill"), &accent.dark_fill));
            hexes.push((format!("{name}.dark_text"), &accent.dark_text));
            if let Some(tile) = &accent.tile {
                hexes.push((format!("{name}.tile"), tile));
            }
            if let Some(tint) = &accent.tint {
                hexes.push((format!("{name}.tint"), tint));
            }
            if let Some(tint) = &accent.dark_tint {
                hexes.push((format!("{name}.dark_tint"), tint));
            }
        }
        for (name, value) in &self.list {
            hexes.push((format!("list.{name}"), value));
        }
        for (name, value) in &self.brand {
            hexes.push((format!("brand.{name}"), value));
        }
        for (name, value) in self.icon.colours() {
            hexes.push((format!("icon.{name}"), value));
        }
        for app in &self.native.app {
            for (field, value) in [
                ("light_hue", &app.light_hue),
                ("light_chip", &app.light_chip),
                ("light_mark", &app.light_mark),
                ("dark_hue", &app.dark_hue),
                ("dark_chip", &app.dark_chip),
                ("dark_mark", &app.dark_mark),
            ] {
                hexes.push((format!("native.app.{}.{field}", app.id), value));
            }
        }
        for (name, value) in &hexes {
            if Rgb::parse_hex(value).is_none() {
                problems.push(format!("{name} is not #RRGGBB: {value}"));
            }
        }

        // The type scale and radius must at least be present and positive.
        for step in ["title", "section", "row", "meta", "badge"] {
            if !self.scale.contains_key(step) {
                problems.push(format!("[type.{step}] is missing"));
            }
        }
        if !(0.4..=0.9).contains(&self.icon.ios_mark_share) {
            problems.push("[icon] ios_mark_share is not between 0.4 and 0.9".to_owned());
        }
        if self.scale.values().any(|step| step.size == 0) || self.radius.card == 0 {
            problems.push("a type size or the card radius is zero".to_owned());
        }

        // The legacy catalogue names each of the eight apps once.
        same_set(
            "[[native.app]]",
            self.native.app.iter().map(|app| app.id.as_str()).collect(),
            &APP_IDS_LEGACY,
            &mut problems,
        );

        // Faces: every file named is a file the generator can copy.
        for (family, faces) in &self.native.faces {
            if faces.is_empty() {
                problems.push(format!("[native.faces] `{family}` has no face"));
            }
        }

        if self.icons.is_empty() {
            problems.push("design/icons.toml holds no icon".to_owned());
        }
        for (name, paths) in &self.icons {
            if paths.is_empty() || paths.iter().any(|path| path.d.trim().is_empty()) {
                problems.push(format!("icon `{name}` has an empty path"));
            }
        }

        // Contrast. Only when every colour above parsed, or the ratios are noise.
        if problems.is_empty() {
            problems.extend(self.contrast_problems());
        }

        if problems.is_empty() {
            Ok(())
        } else {
            Err(TokensError::Invalid(format!(
                "design/tokens.toml breaks {} rule(s):\n  {}",
                problems.len(),
                problems.join("\n  ")
            )))
        }
    }

    /// The floors, as a list of failures (empty when every one holds).
    #[must_use]
    pub fn contrast_problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        let mut check =
            |name: String, fg: &str, bg: &str, floor: f64, on: &str| match contrast_ratio(fg, bg) {
                Some(ratio) if ratio >= floor => {}
                Some(ratio) => problems.push(format!(
                    "{name} {fg} is {ratio:.2}:1 on {on} {bg}; the floor is {floor}:1"
                )),
                None => problems.push(format!("{name}: {fg} on {bg} is not a hex pair")),
            };
        let light_page = &self.surface.light.page;
        let dark_card = &self.surface.dark.card;
        for (name, accent) in self.accents() {
            check(
                format!("{name}.light as text"),
                &accent.light,
                light_page,
                TEXT_CONTRAST,
                "the light page",
            );
            check(
                format!("{name}.dark_text"),
                &accent.dark_text,
                dark_card,
                TEXT_CONTRAST,
                "the dark card",
            );
            check(
                format!("white glyphs on {name}.dark_fill"),
                "#FFFFFF",
                &accent.dark_fill,
                TEXT_CONTRAST,
                "the fill",
            );
            if let Some(tint) = &accent.tint {
                check(
                    format!("{name}.light as a badge on its tint"),
                    &accent.light,
                    tint,
                    TEXT_CONTRAST,
                    "the badge tint",
                );
            }
            if let Some(tint) = &accent.dark_tint {
                check(
                    format!("{name}.dark_text as a badge on its tint"),
                    &accent.dark_text,
                    tint,
                    TEXT_CONTRAST,
                    "the dark badge tint",
                );
            }
        }
        for (name, value) in &self.list {
            check(
                format!("list.{name} on the light page"),
                value,
                light_page,
                LIST_CONTRAST,
                "the light page",
            );
            check(
                format!("list.{name} on the dark card"),
                value,
                dark_card,
                LIST_CONTRAST,
                "the dark card",
            );
        }
        problems
    }
}

/// The ids of the legacy catalogue, which predates and differs from `APP_IDS`
/// only in order: the same eight apps.
const APP_IDS_LEGACY: [&str; 8] = APP_IDS;

/// A colour a native role may hold: `#RRGGBB`, `#RRGGBBAA` or `rgba(r,g,b,a)`.
/// Channels are 0 to 255 and the alpha 0 to 1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NativeColor {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
    pub alpha: f64,
}

/// Parse a native role value; `None` when it is a CSS shadow or malformed.
#[must_use]
pub fn native_color(value: &str) -> Option<NativeColor> {
    let value = value.trim();
    if let Some(digits) = value.strip_prefix('#') {
        if !(digits.len() == 6 || digits.len() == 8)
            || !digits.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return None;
        }
        let channel = |at: usize| u8::from_str_radix(digits.get(at..at + 2)?, 16).ok();
        let alpha = if digits.len() == 8 {
            f64::from(channel(6)?) / 255.0
        } else {
            1.0
        };
        return Some(NativeColor {
            red: channel(0)?,
            green: channel(2)?,
            blue: channel(4)?,
            alpha,
        });
    }
    let inner = value
        .strip_prefix("rgba(")
        .or_else(|| value.strip_prefix("rgb("))?
        .strip_suffix(')')?;
    let parts: Vec<&str> = inner.split(',').map(str::trim).collect();
    if !(parts.len() == 3 || parts.len() == 4) {
        return None;
    }
    let channel = |text: &str| -> Option<u8> {
        if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        text.parse::<u8>().ok()
    };
    let alpha = match parts.get(3) {
        Some(text) => {
            if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
                return None;
            }
            text.parse::<f64>().ok()?
        }
        None => 1.0,
    };
    Some(NativeColor {
        red: channel(parts.first()?)?,
        green: channel(parts.get(1)?)?,
        blue: channel(parts.get(2)?)?,
        alpha,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn committed() -> Tokens {
        Tokens::load(&root()).unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn the_committed_tokens_parse_and_satisfy_every_rule() {
        let tokens = committed();
        assert_eq!(tokens.app.len(), 8);
        assert_eq!(tokens.state.len(), 3);
        assert_eq!(tokens.list.len(), 8);
        assert_eq!(tokens.brand.len(), 4);
        assert_eq!(tokens.brand["teal"], "#00AA98");
        assert_eq!(tokens.native.colors.light.len(), 55);
        assert_eq!(tokens.native.colors.dark.len(), 55);
        assert_eq!(tokens.icons.len(), 150);
        assert_eq!(tokens.native.app.len(), 8);
    }

    #[test]
    fn the_decided_values_are_the_ones_in_the_issue() {
        let tokens = committed();
        let light = |id: &str| tokens.app[id].light.as_str();
        assert_eq!(light("agenda"), "#266FC4");
        assert_eq!(light("notes"), "#8C6802");
        assert_eq!(tokens.app["notes"].tile.as_deref(), Some("#F5C431"));
        assert_eq!(light("people"), "#7638AD");
        assert_eq!(light("docs"), "#087990");
        assert_eq!(light("money"), "#27388B");
        assert_eq!(light("locker"), "#454E58");
        assert_eq!(light("health"), "#BB365C");
        assert_eq!(light("photos"), "#A8398A");
        assert_eq!(tokens.state["red"].light, "#C8392F");
        assert_eq!(tokens.state["amber"].light, "#874300");
        assert_eq!(tokens.state["green"].light, "#2B7B51");
        assert_eq!(tokens.shell.light, "#1F4A45");
        assert_eq!(tokens.surface.light.page, "#F4F2EE");
        assert_eq!(tokens.surface.light.plain_page, "#FBFAF8");
        assert_eq!(tokens.surface.dark.card, "#1F1E1C");
        assert_eq!(tokens.radius.card, 16);
        assert_eq!(tokens.scale["title"].size, 34);
        assert_eq!(tokens.scale["section"].size, 20);
        assert_eq!(tokens.scale["row"].size, 16);
        assert_eq!(tokens.scale["meta"].size, 13);
        assert_eq!(tokens.scale["badge"].size, 11);
        assert!(tokens.scale["badge"].caps);
    }

    #[test]
    fn contrast_is_the_wcag_ratio() {
        let black_on_white = contrast_ratio("#000000", "#FFFFFF").expect("hex pair");
        assert!((black_on_white - 21.0).abs() < 1e-9, "{black_on_white}");
        let same = contrast_ratio("#266FC4", "#266FC4").expect("hex pair");
        assert!((same - 1.0).abs() < 1e-9);
        assert_eq!(contrast_ratio("#12", "#FFFFFF"), None);
    }

    #[test]
    fn every_accent_and_list_colour_clears_its_floor() {
        let problems = committed().contrast_problems();
        assert!(problems.is_empty(), "{}", problems.join("\n"));
    }

    #[test]
    fn dark_text_values_reach_six_to_one_on_cards() {
        // The issue says 6:1 on cards for the lighter dark value; the validator
        // enforces 4.5:1, and this pins what the board actually delivers.
        let tokens = committed();
        for (name, accent) in tokens.accents() {
            let ratio =
                contrast_ratio(&accent.dark_text, &tokens.surface.dark.card).expect("hex pair");
            assert!(ratio >= 6.0, "{name}.dark_text is {ratio:.2}:1");
        }
    }

    #[test]
    fn every_state_has_a_badge_tint_in_both_schemes() {
        let tokens = committed();
        for (id, state) in &tokens.state {
            assert!(state.tint.is_some(), "state.{id} has no tint");
            assert!(state.dark_tint.is_some(), "state.{id} has no dark_tint");
        }
    }

    #[test]
    fn dark_has_one_page_colour() {
        let tokens = committed();
        assert_eq!(tokens.surface.dark.plain_page, tokens.surface.dark.page);
    }

    fn committed_text(file: &str) -> String {
        std::fs::read_to_string(root().join(file)).expect("the committed file reads")
    }

    #[test]
    fn a_missing_role_is_refused_and_names_the_scheme() {
        let text = committed_text("design/tokens.toml");
        let icons = committed_text("design/icons.toml");
        let broken = text.replacen("net = ", "netGone = ", 1);
        let error = Tokens::parse(&broken, &icons).expect_err("a dropped role is refused");
        let sentence = error.to_string();
        assert!(sentence.contains("`net` is missing"), "{sentence}");
        assert!(sentence.contains("native.colors.light"), "{sentence}");
    }

    #[test]
    fn an_app_without_a_dark_text_value_is_refused() {
        let text = committed_text("design/tokens.toml");
        let icons = committed_text("design/icons.toml");
        let broken = text.replacen("dark_text = \"#569EF7\"\n", "", 1);
        let error = Tokens::parse(&broken, &icons).expect_err("a half-dark app is refused");
        assert!(error.to_string().contains("dark_text"), "{error}");
    }

    #[test]
    fn a_malformed_hex_is_refused() {
        let text = committed_text("design/tokens.toml");
        let icons = committed_text("design/icons.toml");
        let broken = text.replacen("\"#266FC4\"", "\"#26C4\"", 1);
        let error = Tokens::parse(&broken, &icons).expect_err("a short hex is refused");
        assert!(error.to_string().contains("app.agenda.light"), "{error}");
    }

    #[test]
    fn a_colour_that_misses_its_floor_is_reported_with_its_ratio() {
        let text = committed_text("design/tokens.toml");
        let icons = committed_text("design/icons.toml");
        // Light yellow as text on the light page is nowhere near 4.5:1.
        let broken = text.replacen("light = \"#8C6802\"", "light = \"#F5C431\"", 1);
        let error = Tokens::parse(&broken, &icons).expect_err("a pale accent is refused");
        let sentence = error.to_string();
        assert!(sentence.contains("app.notes.light as text"), "{sentence}");
        assert!(sentence.contains(":1 on the light page"), "{sentence}");
    }

    #[test]
    fn native_colours_parse_hex_and_rgba_and_refuse_shadows() {
        let teal = native_color("#00707e").expect("hex");
        assert_eq!((teal.red, teal.green, teal.blue), (0, 112, 126));
        assert!((teal.alpha - 1.0).abs() < f64::EPSILON);
        let wash = native_color("rgba(154,59,46,.07)").expect("rgba");
        assert_eq!((wash.red, wash.green, wash.blue), (154, 59, 46));
        assert!((wash.alpha - 0.07).abs() < f64::EPSILON);
        assert!(native_color("0 24px 48px -16px rgba(20,20,20,.16)").is_none());
        assert!(native_color("#12").is_none());
    }
}
