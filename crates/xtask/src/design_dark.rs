//! `cargo xtask design-dark`: THE DARK MOCKUPS, GENERATED FROM THE LIGHT ONES (#1173).
//!
//! `design/mockups/` holds one light screen per `X.dc.html` and its dark twin
//! `XDark.dc.html`. The twin is never edited: this module writes it from the
//! light screen and the `[mockups.dark]` section of `design/tokens.toml`, and
//! `--check` fails when a committed twin is not what the generator would write.
//! It replaces `make_dark.py`, which lived outside the repository.
//!
//! # What changes
//!
//! * Every literal colour in an inline `style`, and in an SVG `fill`, `stroke`
//!   or `stop-color`, is swapped for its dark value. Nothing else about the
//!   markup moves, except the serialiser's habits the committed twins carry:
//!   an empty SVG shape is written `<path .../>`, `<br>` is `<br/>`, an empty
//!   boolean attribute is bare (`disabled`), a link to another screen points at
//!   that screen's dark twin, and the `<title>` ends in ` (dark)`.
//! * The dark value depends on the ROLE the colour plays, not on the hex alone:
//!   `#1C1B19` is `#F2EFEA` as text and `#3A3733` as a fill. The role comes from
//!   the CSS property (`color` is text, `background` a fill, `border` and
//!   `outline` a line, `box-shadow` a shadow) or the SVG attribute (`fill` and
//!   `stroke` are ink, which falls back to the text value). A role an entry
//!   does not list keeps the light value.
//! * Three pieces of context keep a colour where the role alone would move it,
//!   each described by a rule in the TOML: a document PAGE (a white sheet with a
//!   small radius and a real height) is content, so it and everything inside it
//!   stay light, except chrome laid over it with `position: absolute`; the iOS
//!   switch THUMB (a 26 px white absolute circle) stays white; an app TILE (a
//!   square, centred flex box filled with the ink colour, holding a white glyph)
//!   keeps its fill. A Centraid brand icon swaps its white for the dark ground,
//!   and the 120-wide tile form also drops its hairline and keeps its quarter
//!   colours.
//! * A light colour the table neither maps nor lists under `keep` is an error:
//!   a new colour in a light screen forces a decision about its dark value.
//!
//! The scanner is deliberately not an HTML parser. The boards are written by a
//! design tool in one regular shape, so a tag scanner with an element stack is
//! enough, and the bytes between tags are copied untouched.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;

/// The shared token file, relative to the repository root.
pub const TOKENS: &str = "design/tokens.toml";

/// The mockups directory, relative to the repository root.
pub const MOCKUPS: &str = "design/mockups";

/// The canvas that says which boards are light screens.
const CANVAS: &str = "canvas.json";

/// SVG shapes the serialiser writes self-closed when they hold nothing.
const SHAPES: &[&str] = &[
    "path", "circle", "rect", "line", "polyline", "polygon", "ellipse",
];

/// Elements with no end tag.
const VOID: &[&str] = &[
    "br", "hr", "img", "input", "meta", "link", "base", "col", "wbr", "source", "area", "embed",
    "track", "param",
];

/// Void elements the serialiser writes with a slash. The head's `<meta>` and
/// `<link>` stay bare in the committed twins.
const SLASHED_VOID: &[&str] = &["br"];

/// Boolean attributes the serialiser writes bare.
const BOOLEAN_ATTRS: &[&str] = &[
    "disabled",
    "checked",
    "hidden",
    "readonly",
    "required",
    "selected",
    "autofocus",
];

/// Where a colour sits, which decides which of an entry's dark values applies.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Role {
    /// CSS `color`.
    Text,
    /// SVG `fill` and `stroke`: the text value unless the entry says otherwise.
    Ink,
    /// CSS `background*`, gradient stops, SVG `stop-color`.
    Fill,
    /// CSS `border*` and `outline*`.
    Line,
    /// CSS `box-shadow` and `text-shadow`.
    Shadow,
}

/// One light colour and the dark value it takes in each role. A role left out
/// keeps the light value.
#[derive(Debug, Deserialize)]
struct ColorEntry {
    light: String,
    text: Option<String>,
    ink: Option<String>,
    fill: Option<String>,
    line: Option<String>,
    shadow: Option<String>,
}

/// A white document page: content, so it and its children stay light.
#[derive(Debug, Deserialize)]
struct PaperRule {
    background: String,
    min_height: f64,
    max_radius: f64,
}

/// An iOS switch thumb: an absolutely positioned `size` px circle, white in
/// both modes.
#[derive(Debug, Deserialize)]
struct KnobRule {
    background: String,
    size: f64,
}

/// A fill that is kept when the element is a square flex tile.
#[derive(Debug, Deserialize)]
struct SolidRule {
    background: String,
}

/// Translucent white (glass) becomes translucent dark, never less opaque than
/// `min_alpha`.
#[derive(Debug, Deserialize)]
struct GlassRule {
    from: [u8; 3],
    to: [u8; 3],
    min_alpha: String,
}

/// Black shadows and scrims get a floor on their alpha, because a dark surface
/// needs a heavier shadow to read.
#[derive(Debug, Deserialize)]
struct ShadeRule {
    min_alpha: String,
}

/// The Centraid brand icon: white becomes the dark ground.
#[derive(Debug, Deserialize)]
struct IconRule {
    white: String,
    ground: String,
    tile_view_box: String,
}

#[derive(Debug, Deserialize)]
struct DarkSection {
    title_suffix: String,
    colors: Vec<ColorEntry>,
    keep: Vec<String>,
    paper: PaperRule,
    knob: KnobRule,
    tile: SolidRule,
    glass: GlassRule,
    shade: ShadeRule,
    icon: IconRule,
}

#[derive(Debug, Deserialize)]
struct Mockups {
    dark: DarkSection,
}

#[derive(Debug, Deserialize)]
struct TokensFile {
    mockups: Mockups,
}

/// The `[mockups.dark]` table, parsed and indexed.
#[derive(Debug)]
pub struct DarkMap {
    section: DarkSection,
    colors: HashMap<String, usize>,
    keep: HashSet<String>,
    /// The boards that have a dark twin. When set, a link to a screen outside
    /// it is left alone; when `None`, every link to a `.dc.html` is rewritten.
    twins: Option<BTreeSet<String>>,
}

fn hex_key(raw: &str) -> String {
    raw.to_ascii_uppercase()
}

fn valid_hex(raw: &str) -> bool {
    let digits = raw.strip_prefix('#').unwrap_or("");
    matches!(digits.len(), 3 | 4 | 6 | 8) && digits.bytes().all(|b| b.is_ascii_hexdigit())
}

impl DarkMap {
    /// Parse the TOML text of `design/tokens.toml`.
    ///
    /// # Errors
    /// Invalid TOML, a missing `[mockups.dark]` section, a value that is not a
    /// hex colour, or a light colour listed twice.
    pub fn parse(text: &str) -> Result<Self> {
        let file: TokensFile = toml::from_str(text).context("parse design/tokens.toml")?;
        let section = file.mockups.dark;
        let mut colors = HashMap::new();
        let check = |what: &str, value: &str| -> Result<()> {
            if valid_hex(value) {
                Ok(())
            } else {
                bail!("[mockups.dark] {what}: {value:?} is not a hex colour")
            }
        };
        for (index, entry) in section.colors.iter().enumerate() {
            check("colors.light", &entry.light)?;
            for (role, value) in [
                ("text", &entry.text),
                ("ink", &entry.ink),
                ("fill", &entry.fill),
                ("line", &entry.line),
                ("shadow", &entry.shadow),
            ] {
                if let Some(value) = value {
                    check(&format!("colors {} {role}", entry.light), value)?;
                }
            }
            if colors.insert(hex_key(&entry.light), index).is_some() {
                bail!("[mockups.dark] colors: {} is listed twice", entry.light);
            }
        }
        let mut keep = HashSet::new();
        for value in &section.keep {
            check("keep", value)?;
            keep.insert(hex_key(value));
        }
        for (what, value) in [
            ("paper.background", &section.paper.background),
            ("knob.background", &section.knob.background),
            ("tile.background", &section.tile.background),
            ("icon.white", &section.icon.white),
            ("icon.ground", &section.icon.ground),
        ] {
            check(what, value)?;
        }
        Ok(Self {
            section,
            colors,
            keep,
            twins: None,
        })
    }

    /// Read `design/tokens.toml` under `root`.
    ///
    /// # Errors
    /// An unreadable file, or [`DarkMap::parse`] failing.
    pub fn load(root: &Path) -> Result<Self> {
        let path = root.join(TOKENS);
        let text = std::fs::read_to_string(&path).with_context(|| format!("read {TOKENS}"))?;
        Self::parse(&text)
    }

    /// Limit link rewriting to the boards that have a dark twin.
    #[must_use]
    pub fn with_twins(mut self, twins: BTreeSet<String>) -> Self {
        self.twins = Some(twins);
        self
    }

    fn entry(&self, hex: &str) -> Option<&ColorEntry> {
        self.colors
            .get(&hex_key(hex))
            .map(|&index| &self.section.colors[index])
    }

    /// The dark value of `hex` in `role`, or the light value kept.
    fn map_hex(&self, hex: &str, role: Role) -> Result<String> {
        let key = hex_key(hex);
        let Some(entry) = self.entry(&key) else {
            if self.keep.contains(&key) {
                return Ok(hex.to_string());
            }
            bail!("{hex} is neither mapped nor kept in [mockups.dark]");
        };
        let value = match role {
            Role::Text => entry.text.as_ref(),
            Role::Ink => entry.ink.as_ref().or(entry.text.as_ref()),
            Role::Fill => entry.fill.as_ref(),
            Role::Line => entry.line.as_ref(),
            Role::Shadow => entry.shadow.as_ref(),
        };
        Ok(value.map_or_else(|| hex.to_string(), |v| v.to_ascii_uppercase()))
    }

    /// Glass and shade: the `rgba()` forms. Anything else keeps its value.
    fn map_rgba(&self, args: &[&str]) -> Option<String> {
        let [r, g, b, a] = args else { return None };
        let rgb = [
            r.trim().parse::<u8>().ok()?,
            g.trim().parse::<u8>().ok()?,
            b.trim().parse::<u8>().ok()?,
        ];
        let alpha = a.trim();
        let value: f64 = alpha.parse().ok()?;
        let glass = &self.section.glass;
        if rgb == glass.from {
            let floor: f64 = glass.min_alpha.parse().ok()?;
            let alpha = if value < floor {
                glass.min_alpha.as_str()
            } else {
                alpha
            };
            let [tr, tg, tb] = glass.to;
            return Some(format!("rgba({tr},{tg},{tb},{alpha})"));
        }
        if rgb == [0, 0, 0] {
            let floor: f64 = self.section.shade.min_alpha.parse().ok()?;
            let alpha = if value < floor {
                self.section.shade.min_alpha.as_str()
            } else {
                alpha
            };
            return Some(format!("rgba(0,0,0,{alpha})"));
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Colour tokens inside a value
// ---------------------------------------------------------------------------

/// A colour found in a value: where it is and what it is.
#[derive(Debug, Eq, PartialEq)]
enum Token<'a> {
    Hex(&'a str),
    Rgba(Vec<&'a str>),
}

/// Every `#hex` and `rgb(a)()` in `value`, as byte ranges.
fn colour_tokens(value: &str) -> Vec<(usize, usize, Token<'_>)> {
    let bytes = value.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let at_word_start = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        if bytes[i] == b'#' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_hexdigit() {
                j += 1;
            }
            let ends_word = j >= bytes.len() || !bytes[j].is_ascii_alphanumeric();
            if matches!(j - i - 1, 3 | 4 | 6 | 8) && ends_word {
                found.push((i, j, Token::Hex(&value[i..j])));
            }
            i = j.max(i + 1);
            continue;
        }
        if at_word_start
            && (value[i..].starts_with("rgba(") || value[i..].starts_with("rgb("))
            && let Some(close) = value[i..].find(')')
        {
            let open = value[i..].find('(').unwrap_or(0) + i + 1;
            let args: Vec<&str> = value[open..i + close].split(',').collect();
            found.push((i, i + close + 1, Token::Rgba(args)));
            i += close + 1;
            continue;
        }
        i += 1;
    }
    found
}

// ---------------------------------------------------------------------------
// Element facts and scope
// ---------------------------------------------------------------------------

/// What an element's own inline style says about what it is.
#[derive(Debug, Default)]
struct Facts {
    /// Every `background` hex, in order: a later one can override the first
    /// (a page given a cream wash after its white).
    backgrounds: Vec<String>,
    background: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    radius: Option<f64>,
    absolute: bool,
    centred: bool,
}

fn px(value: &str) -> Option<f64> {
    value.trim().strip_suffix("px")?.trim().parse().ok()
}

/// The declarations of a `style` value as `(property, value)` byte ranges,
/// splitting on `;` outside parentheses and quotes.
fn declarations(style: &str) -> Vec<(usize, usize, usize, usize)> {
    let bytes = style.as_bytes();
    let mut out = Vec::new();
    let (mut start, mut depth, mut quote) = (0usize, 0i32, None::<u8>);
    for i in 0..=bytes.len() {
        let end_of_decl = i == bytes.len() || (bytes[i] == b';' && depth == 0 && quote.is_none());
        if !end_of_decl {
            match (bytes[i], quote) {
                (q @ (b'"' | b'\''), None) => quote = Some(q),
                (q, Some(open)) if q == open => quote = None,
                (b'(', None) => depth += 1,
                (b')', None) => depth -= 1,
                _ => {}
            }
            continue;
        }
        if let Some(colon) = style[start..i].find(':') {
            out.push((start, start + colon, start + colon + 1, i));
        }
        start = i + 1;
    }
    out
}

fn facts_of(style: &str) -> Facts {
    let mut facts = Facts::default();
    for (ps, pe, vs, ve) in declarations(style) {
        let prop = style[ps..pe].trim().to_ascii_lowercase();
        let value = style[vs..ve].trim();
        match prop.as_str() {
            "background" | "background-color" => {
                if let Some((_, _, Token::Hex(hex))) = colour_tokens(value).into_iter().next() {
                    facts.background = Some(hex_key(hex));
                    facts.backgrounds.push(hex_key(hex));
                }
            }
            "width" => facts.width = px(value),
            "height" => facts.height = px(value),
            "border-radius" => {
                facts.radius = value.split_whitespace().next().and_then(px);
            }
            "position" => facts.absolute = value == "absolute",
            "justify-content" => facts.centred = value == "center",
            _ => {}
        }
    }
    facts
}

/// What the Centraid brand icon is doing in this subtree.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum Icon {
    /// The mark: quarters brighten like any ink, white becomes the ground.
    Mark,
    /// The 120-wide app-icon tile: quarters keep, hairline is dropped.
    Tile,
}

#[derive(Debug)]
struct Frame {
    name: String,
    /// Inside a document page: every colour stays.
    paper: bool,
    icon: Option<Icon>,
}

fn role_of_property(prop: &str) -> Option<Role> {
    match prop {
        "color" | "caret-color" | "accent-color" | "text-decoration-color" => Some(Role::Text),
        "fill" | "stroke" => Some(Role::Ink),
        "stop-color" | "flood-color" => Some(Role::Fill),
        "box-shadow" | "text-shadow" => Some(Role::Shadow),
        p if p.starts_with("background") => Some(Role::Fill),
        p if p.starts_with("border") || p.starts_with("outline") => Some(Role::Line),
        _ => None,
    }
}

/// The context one start tag maps its colours in.
struct Scope<'a> {
    map: &'a DarkMap,
    tag: &'a str,
    paper: bool,
    icon: Option<Icon>,
    /// This element's own `background` keeps its colour.
    keep_fill: bool,
}

impl Scope<'_> {
    fn map_colour(&self, token: &Token<'_>, role: Role, attr: &str) -> Result<Option<String>> {
        if self.paper {
            return Ok(None);
        }
        match token {
            Token::Rgba(args) => Ok(self.map.map_rgba(args)),
            Token::Hex(hex) => {
                let icon = &self.map.section.icon;
                if let Some(kind) = self.icon
                    && matches!(role, Role::Ink)
                {
                    if hex_key(hex) == hex_key(&icon.white) {
                        return Ok(Some(icon.ground.to_ascii_uppercase()));
                    }
                    if kind == Icon::Tile {
                        return Ok(None);
                    }
                }
                if matches!(role, Role::Fill) && self.keep_fill {
                    return Ok(None);
                }
                let mapped = self
                    .map
                    .map_hex(hex, role)
                    .with_context(|| format!("{attr} on <{}>", self.tag))?;
                Ok((mapped != *hex).then_some(mapped))
            }
        }
    }

    /// `value` with every colour in it mapped for `role`.
    fn map_value(&self, value: &str, role: Role, attr: &str) -> Result<String> {
        let mut out = String::with_capacity(value.len());
        let mut at = 0;
        for (start, end, token) in colour_tokens(value) {
            out.push_str(&value[at..start]);
            match self.map_colour(&token, role, attr)? {
                Some(mapped) => out.push_str(&mapped),
                None => out.push_str(&value[start..end]),
            }
            at = end;
        }
        out.push_str(&value[at..]);
        Ok(out)
    }

    fn map_style(&self, style: &str) -> Result<String> {
        let mut out = String::with_capacity(style.len());
        let mut at = 0;
        for (ps, pe, vs, ve) in declarations(style) {
            let name = style[ps..pe].trim().to_ascii_lowercase();
            let name = name.as_str();
            let value = &style[vs..ve];
            out.push_str(&style[at..vs]);
            if colour_tokens(value).is_empty() {
                out.push_str(value);
            } else {
                let role = role_of_property(name)
                    .ok_or_else(|| anyhow!("a colour in unclassified CSS property `{name}`"))?;
                out.push_str(&self.map_value(value, role, name)?);
            }
            at = ve;
        }
        out.push_str(&style[at..]);
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// The tag scanner
// ---------------------------------------------------------------------------

/// A parsed attribute: its name, and the byte range of its quoted value.
struct Attr<'a> {
    name: &'a str,
    /// The whole `name="value"` span.
    span: (usize, usize),
    /// The value without its quotes, when there is one.
    value: Option<(usize, usize)>,
}

fn parse_attrs(tag: &str, from: usize) -> Vec<Attr<'_>> {
    let bytes = tag.as_bytes();
    let mut attrs = Vec::new();
    let mut i = from;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == b'>' {
            break;
        }
        let name_start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && !matches!(bytes[i], b'=' | b'>' | b'/')
        {
            i += 1;
        }
        let name = &tag[name_start..i];
        let mut value = None;
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            if i < bytes.len() && matches!(bytes[i], b'"' | b'\'') {
                let quote = bytes[i];
                let value_start = i + 1;
                i = value_start;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                value = Some((value_start, i));
                i += 1;
            } else {
                let value_start = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                    i += 1;
                }
                value = Some((value_start, i));
            }
        }
        attrs.push(Attr {
            name,
            span: (name_start, i.min(bytes.len())),
            value,
        });
    }
    attrs
}

/// The end of the start tag that begins at `html[at]`, honouring quotes.
fn tag_end(html: &str, at: usize) -> Option<usize> {
    let bytes = html.as_bytes();
    let mut quote = None;
    for (offset, &byte) in bytes[at..].iter().enumerate() {
        match (byte, quote) {
            (q @ (b'"' | b'\''), None) => quote = Some(q),
            (q, Some(open)) if q == open => quote = None,
            (b'>', None) => return Some(at + offset + 1),
            _ => {}
        }
    }
    None
}

/// Rewrite a link to a screen so it points at that screen's dark twin.
fn dark_link(map: &DarkMap, href: &str) -> Option<String> {
    let name = href.strip_suffix(".dc.html")?;
    if name.ends_with("Dark") || name.contains('/') || name.contains(':') || name.is_empty() {
        return None;
    }
    if let Some(twins) = &map.twins
        && !twins.contains(href)
    {
        return None;
    }
    Some(format!("{name}Dark.dc.html"))
}

/// The result of rewriting one start tag.
struct Rewritten {
    text: String,
    self_closed: bool,
    icon: Option<Icon>,
    paper: bool,
}

fn rewrite_start_tag(
    map: &DarkMap,
    tag: &str,
    name: &str,
    parent: Option<&Frame>,
    swallow_end: bool,
) -> Result<Option<Rewritten>> {
    let attrs = parse_attrs(tag, 1 + name.len());
    let get = |wanted: &str| {
        attrs
            .iter()
            .find(|a| a.name == wanted)
            .and_then(|a| a.value.map(|(s, e)| &tag[s..e]))
    };

    let facts = get("style").map(facts_of).unwrap_or_default();
    let rules = &map.section;
    let paper_here = facts
        .backgrounds
        .contains(&hex_key(&rules.paper.background))
        && facts.height.is_some_and(|h| h >= rules.paper.min_height)
        && facts.radius.is_some_and(|r| r <= rules.paper.max_radius);
    // Chrome laid over a page (an absolutely positioned badge) is not content.
    let paper = !facts.absolute && (parent.is_some_and(|p| p.paper) || paper_here);
    let square = matches!((facts.width, facts.height), (Some(w), Some(h)) if (w - h).abs() < 0.01);
    let width = facts.width.unwrap_or(0.0);
    let knob = facts.background.as_deref() == Some(&hex_key(&rules.knob.background))
        && facts.absolute
        && square
        && (width - rules.knob.size).abs() < 0.01
        && facts.radius.is_some_and(|r| r * 2.0 >= width);
    let tile = facts.background.as_deref() == Some(&hex_key(&rules.tile.background))
        && square
        && facts.centred;

    let mut icon = parent.and_then(|p| p.icon);
    if name == "svg" && get("data-centraid-icon").is_some() {
        icon = Some(
            if get("viewBox") == Some(rules.icon.tile_view_box.as_str()) {
                Icon::Tile
            } else {
                Icon::Mark
            },
        );
    }
    if icon == Some(Icon::Tile) && name == "rect" && get("fill") == Some("none") {
        return Ok(None);
    }

    let scope = Scope {
        map,
        tag: name,
        paper,
        icon,
        keep_fill: knob || tile,
    };
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for attr in &attrs {
        let Some((start, end)) = attr.value else {
            continue;
        };
        let value = &tag[start..end];
        let mapped = match attr.name {
            "style" => Some(scope.map_style(value)?),
            "fill" | "stroke" => Some(scope.map_value(value, Role::Ink, attr.name)?),
            "stop-color" | "flood-color" => Some(scope.map_value(value, Role::Fill, attr.name)?),
            "color" => Some(scope.map_value(value, Role::Text, attr.name)?),
            "href" => dark_link(map, value),
            _ => None,
        };
        if let Some(mapped) = mapped.filter(|m| m != value) {
            edits.push((start, end, mapped));
        }
        if value.is_empty() && BOOLEAN_ATTRS.contains(&attr.name) {
            // `disabled=""` -> `disabled`
            edits.push((attr.span.0 + attr.name.len(), attr.span.1, String::new()));
        }
    }

    let mut text = tag.to_string();
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    for (start, end, replacement) in edits {
        text.replace_range(start..end, &replacement);
    }
    let already_closed = text.ends_with("/>");
    let mut self_closed = already_closed;
    let slash = SHAPES.contains(&name) && swallow_end || SLASHED_VOID.contains(&name);
    if !already_closed && slash {
        text.truncate(text.len() - 1);
        text.push_str("/>");
        self_closed = true;
    }
    Ok(Some(Rewritten {
        text,
        self_closed,
        icon,
        paper,
    }))
}

/// Generate the dark board for one light board.
///
/// # Errors
/// A colour the table neither maps nor keeps, a colour in a CSS property with
/// no role, or markup the scanner cannot read.
pub fn dark_board(light_html: &str, map: &DarkMap) -> Result<String> {
    let html = light_html;
    let mut out = String::with_capacity(html.len());
    let mut stack: Vec<Frame> = Vec::new();
    let mut at = 0;
    while at < html.len() {
        let Some(lt) = html[at..].find('<') else {
            out.push_str(&html[at..]);
            break;
        };
        out.push_str(&html[at..at + lt]);
        at += lt;
        let rest = &html[at..];
        if rest.starts_with("<!--") {
            let end = rest.find("-->").map_or(rest.len(), |e| e + 3);
            out.push_str(&rest[..end]);
            at += end;
            continue;
        }
        if rest.starts_with("<!") || rest.starts_with("<?") {
            let end = rest.find('>').map_or(rest.len(), |e| e + 1);
            out.push_str(&rest[..end]);
            at += end;
            continue;
        }
        if let Some(closing) = rest.strip_prefix("</") {
            let end = rest
                .find('>')
                .ok_or_else(|| anyhow!("an unterminated end tag"))?
                + 1;
            let name = closing
                .split(['>', ' '])
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if name == "title" {
                out.push_str(&map.section.title_suffix);
            }
            out.push_str(&rest[..end]);
            at += end;
            if let Some(pos) = stack.iter().rposition(|f| f.name == name) {
                stack.truncate(pos);
            }
            continue;
        }
        let end = tag_end(html, at).ok_or_else(|| anyhow!("an unterminated start tag"))?;
        let tag = &html[at..end];
        let name: String = tag[1..]
            .chars()
            .take_while(|c| !c.is_whitespace() && !matches!(c, '/' | '>'))
            .collect::<String>();
        let lower = name.to_ascii_lowercase();
        at = end;

        let empty_shape =
            SHAPES.contains(&lower.as_str()) && html[at..].starts_with(&format!("</{lower}>"));
        let rewritten = rewrite_start_tag(map, tag, &name, stack.last(), empty_shape)?;
        let Some(rewritten) = rewritten else {
            if empty_shape {
                at += lower.len() + 3;
            }
            continue;
        };
        out.push_str(&rewritten.text);
        if empty_shape {
            at += lower.len() + 3;
        }
        let void = VOID.contains(&lower.as_str());
        if !rewritten.self_closed && !void {
            stack.push(Frame {
                name: lower.clone(),
                paper: rewritten.paper,
                icon: rewritten.icon,
            });
        }
        if matches!(lower.as_str(), "script" | "style") && !rewritten.self_closed {
            let close = format!("</{lower}>");
            let body_end = html[at..].find(&close).map_or(html.len(), |e| at + e);
            out.push_str(&html[at..body_end]);
            at = body_end;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// The whole directory
// ---------------------------------------------------------------------------

/// What a run found.
#[derive(Debug, Default)]
pub struct Report {
    /// Light boards the canvas places on the light page.
    pub total: usize,
    /// Dark boards already byte-identical to the generated ones.
    pub identical: usize,
    /// Dark boards written (write mode) or that differ (check mode), each with
    /// the first difference.
    pub changed: Vec<(String, String)>,
}

/// The light boards in `canvas.json`: the names of the screens on the `light`
/// page.
fn light_boards(dir: &Path) -> Result<Vec<String>> {
    let text =
        std::fs::read_to_string(dir.join(CANVAS)).with_context(|| format!("read {CANVAS}"))?;
    let canvas: serde_json::Value = serde_json::from_str(&text).context("parse canvas.json")?;
    let boards = canvas["boards"]
        .as_object()
        .ok_or_else(|| anyhow!("canvas.json has no `boards`"))?;
    let mut names: Vec<String> = boards
        .iter()
        .filter(|(_, board)| board["page"] == "light")
        .map(|(name, _)| name.clone())
        .collect();
    names.sort();
    Ok(names)
}

fn dark_name(light: &str) -> String {
    light.replacen(".dc.html", "Dark.dc.html", 1)
}

/// The first line where two boards differ, with both lines shortened to the
/// stretch around the difference.
#[must_use]
pub fn first_difference(have: &str, want: &str) -> String {
    for (number, (a, b)) in have.lines().zip(want.lines()).enumerate() {
        if a != b {
            let common = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
            let from = (0..=common.saturating_sub(40))
                .rev()
                .find(|&i| a.is_char_boundary(i) && b.is_char_boundary(i))
                .unwrap_or(0);
            let clip = |s: &str| -> String { s[from..].chars().take(120).collect() };
            return format!(
                "line {}: committed `{}` / generated `{}`",
                number + 1,
                clip(a),
                clip(b)
            );
        }
    }
    format!(
        "committed has {} lines, generated has {}",
        have.lines().count(),
        want.lines().count()
    )
}

/// Write every dark board from its light one, or with `check` compare them.
///
/// # Errors
/// An unreadable tree, a board that cannot be converted, or (with `check`) any
/// dark board that is not what the generator writes.
pub fn generate_all(root: &Path, check: bool) -> Result<Report> {
    let dir = root.join(MOCKUPS);
    let lights = light_boards(&dir)?;
    let twins: BTreeSet<String> = lights.iter().cloned().collect();
    let map = DarkMap::load(root)?.with_twins(twins);
    let mut report = Report {
        total: lights.len(),
        ..Report::default()
    };
    for light in &lights {
        let html =
            std::fs::read_to_string(dir.join(light)).with_context(|| format!("read {light}"))?;
        let wanted = dark_board(&html, &map).with_context(|| format!("convert {light}"))?;
        let name = dark_name(light);
        let path = dir.join(&name);
        let have = std::fs::read_to_string(&path).unwrap_or_default();
        if have == wanted {
            report.identical += 1;
            continue;
        }
        report
            .changed
            .push((name, first_difference(&have, &wanted)));
        if !check {
            std::fs::write(&path, wanted).with_context(|| format!("write {}", path.display()))?;
        }
    }
    Ok(report)
}

/// The `cargo xtask design-dark` entry: write, or with `check` fail on drift.
///
/// # Errors
/// As [`generate_all`], plus a stale board under `--check`.
pub fn run(root: &Path, check: bool) -> Result<()> {
    let report = generate_all(root, check)?;
    if check && !report.changed.is_empty() {
        let mut message = format!(
            "{} of {} dark boards are not what the generator writes. Edit the light screen \
             (never a dark one) and run `cargo xtask design-dark`:",
            report.changed.len(),
            report.total
        );
        for (name, difference) in &report.changed {
            message.push_str(&format!("\n  {name}: {difference}"));
        }
        bail!(message);
    }
    println!(
        "design-dark: {} of {} dark boards {}",
        if check {
            report.identical
        } else {
            report.total
        },
        report.total,
        if check {
            "match"
        } else {
            "written or already current"
        }
    );
    Ok(())
}

#[cfg(test)]
#[path = "design_dark_tests.rs"]
mod tests;
