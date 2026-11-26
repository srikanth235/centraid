//! ONE-SHOT: the conversion of the light boards to `var(--token)` (#1214, lane T1).
//!
//! Reads every light board, replaces each colour with the role token whose
//! (light, dark) pair it is (the dark side is what the old `[mockups.dark]`
//! table gave it in that position, so a dark twin renders as before), deletes
//! HTML comments, corrects retired words, and reports what it did. Deleted once
//! it has run.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;

pub const TOKENS: &str = "design/tokens.toml";
pub const MOCKUPS: &str = "design/mockups";
const CANVAS: &str = "canvas.json";

/// Elements with no end tag.
const VOID: &[&str] = &[
    "br", "hr", "img", "input", "meta", "link", "base", "col", "wbr", "source", "area", "embed",
    "track", "param",
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

// ---------------------------------------------------------------------------
// The recorder: which role token a colour pair becomes
// ---------------------------------------------------------------------------

/// A light value and the dark value it takes where it sits.
pub type Pair = (String, String);

pub struct Recorder {
    names: RefCell<BTreeMap<Pair, String>>,
    taken: RefCell<BTreeSet<String>>,
    role_light: BTreeMap<String, String>,
    pub added: RefCell<BTreeMap<String, Pair>>,
    pub uses: RefCell<BTreeMap<Pair, usize>>,
    pub kept: RefCell<BTreeMap<String, usize>>,
    table: HashSet<String>,
}

fn kind_word(role: Role) -> &'static str {
    match role {
        Role::Text => "text",
        Role::Ink => "ink",
        Role::Fill => "fill",
        Role::Line => "line",
        Role::Shadow => "shadow",
    }
}

impl Recorder {
    pub fn new(existing: &[crate::design_boards::CssRole], table: HashSet<String>) -> Self {
        let mut names = BTreeMap::new();
        let mut taken = BTreeSet::new();
        let mut role_light = BTreeMap::new();
        for role in existing {
            names
                .entry((hex_key(&role.light), norm_value(&role.dark)))
                .or_insert_with(|| role.name.clone());
            role_light
                .entry(hex_key(&role.light))
                .or_insert_with(|| role.name.clone());
            taken.insert(role.name.clone());
        }
        Self {
            names: RefCell::new(names),
            taken: RefCell::new(taken),
            role_light,
            added: RefCell::default(),
            uses: RefCell::default(),
            kept: RefCell::default(),
            table,
        }
    }

    fn add(&self, base: String, pair: &Pair) -> String {
        let mut name = base.clone();
        let mut n = 2;
        while self.taken.borrow().contains(&name) {
            name = format!("{base}-{n}");
            n += 1;
        }
        self.taken.borrow_mut().insert(name.clone());
        self.names.borrow_mut().insert(pair.clone(), name.clone());
        self.added.borrow_mut().insert(name.clone(), pair.clone());
        name
    }

    /// A role fixed by hand (the icon hairline).
    fn force(&self, name: &str, light: &str, dark: &str) -> String {
        let pair = (light.to_owned(), dark.to_owned());
        if let Some(have) = self.names.borrow().get(&pair) {
            return have.clone();
        }
        self.add(name.to_owned(), &pair)
    }

    fn name_for(&self, light: &str, dark: &str, role: Role) -> Option<String> {
        let pair = (light.to_owned(), dark.to_owned());
        *self.uses.borrow_mut().entry(pair.clone()).or_default() += 1;
        if light == "#FFFFFF" && dark == "#FFFFFF" {
            let name = if role == Role::Fill {
                "paper"
            } else {
                "on-fill"
            };
            if !self.taken.borrow().contains(name) {
                self.taken.borrow_mut().insert(name.to_owned());
                self.added
                    .borrow_mut()
                    .insert(name.to_owned(), pair.clone());
            }
            return Some(name.to_owned());
        }
        if let Some(name) = self.names.borrow().get(&pair) {
            return Some(name.clone());
        }
        if light == "#FFFFFF" && dark == "#1C1B19" {
            return Some(self.add("icon-ground".to_owned(), &pair));
        }
        if let Some(args) = light.strip_prefix("rgba(") {
            let parts: Vec<&str> = args.trim_end_matches(')').split(',').collect();
            let alpha = parts.get(3).and_then(|a| a.parse::<f64>().ok())?;
            let percent = (alpha * 100.0).round();
            let base = match parts.first().copied() {
                Some("255") => format!("glass-{percent}"),
                Some("0") if role == Role::Shadow => format!("shadow-{percent}"),
                Some("0") => format!("scrim-{percent}"),
                _ => {
                    let hex: String = parts[..3]
                        .iter()
                        .filter_map(|p| p.parse::<u8>().ok())
                        .map(|c| format!("{c:02x}"))
                        .collect();
                    format!("rgba-{hex}-{percent}")
                }
            };
            return Some(self.add(base, &pair));
        }
        if light == dark {
            if let Some(role_name) = self.role_light.get(light) {
                return Some(self.add(format!("fixed-{role_name}"), &pair));
            }
            if self.table.contains(light) || role != Role::Fill {
                return Some(self.add(
                    format!(
                        "fixed-{}",
                        light.trim_start_matches('#').to_ascii_lowercase()
                    ),
                    &pair,
                ));
            }
            *self.kept.borrow_mut().entry(light.to_owned()).or_default() += 1;
            return None;
        }
        Some(self.add(
            format!(
                "{}-{}",
                kind_word(role),
                light.trim_start_matches('#').to_ascii_lowercase()
            ),
            &pair,
        ))
    }
}

fn norm_value(value: &str) -> String {
    if value.starts_with('#') {
        hex_key(value)
    } else {
        value.chars().filter(|c| !c.is_whitespace()).collect()
    }
}

fn norm_token(token: &Token<'_>) -> String {
    match token {
        Token::Hex(hex) => hex_key(hex),
        Token::Rgba(args) => format!(
            "rgba({})",
            args.iter().map(|a| a.trim()).collect::<Vec<_>>().join(",")
        ),
    }
}

/// The context one start tag maps its colours in.
struct Scope<'a> {
    map: &'a DarkMap,
    rec: &'a Recorder,
    tag: &'a str,
    paper: bool,
    icon: Option<Icon>,
    keep_fill: bool,
    hairline: bool,
    keep: Cell<bool>,
}

impl Scope<'_> {
    fn dark_of(&self, token: &Token<'_>, role: Role, attr: &str) -> Result<Option<String>> {
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

    fn map_colour(&self, token: &Token<'_>, role: Role, attr: &str) -> Result<Option<String>> {
        let light = norm_token(token);
        if self.hairline {
            let dark = "rgba(228,224,216,0)";
            return Ok(Some(format!(
                "var(--{})",
                self.rec.force("icon-hairline", &light, dark)
            )));
        }
        let dark = self
            .dark_of(token, role, attr)?
            .map_or_else(|| light.clone(), |d| norm_value(&d));
        match self.rec.name_for(&light, &dark, role) {
            Some(name) => Ok(Some(format!("var(--{name})"))),
            None => {
                self.keep.set(true);
                Ok(None)
            }
        }
    }

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
            let value = &style[vs..ve];
            out.push_str(&style[at..vs]);
            if colour_tokens(value).is_empty() {
                out.push_str(value);
            } else {
                let role = role_of_property(&name)
                    .ok_or_else(|| anyhow!("a colour in unclassified CSS property `{name}`"))?;
                out.push_str(&self.map_value(value, role, &name)?);
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

struct Rewritten {
    text: String,
    self_closed: bool,
    icon: Option<Icon>,
    paper: bool,
}

fn rewrite_start_tag(
    map: &DarkMap,
    rec: &Recorder,
    tag: &str,
    name: &str,
    parent: Option<&Frame>,
) -> Result<Rewritten> {
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
    let hairline = icon == Some(Icon::Tile) && name == "rect" && get("fill") == Some("none");

    let scope = Scope {
        map,
        rec,
        tag: name,
        paper,
        icon,
        keep_fill: knob || tile,
        hairline,
        keep: Cell::new(false),
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
            _ => None,
        };
        if let Some(mapped) = mapped.filter(|m| m != value) {
            edits.push((start, end, mapped));
        }
    }
    if scope.keep.get() && get("data-keep").is_none() {
        edits.push((1 + name.len(), 1 + name.len(), " data-keep".to_owned()));
    }
    let mut text = tag.to_string();
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    for (start, end, replacement) in edits {
        text.replace_range(start..end, &replacement);
    }
    Ok(Rewritten {
        self_closed: text.ends_with("/>"),
        text,
        icon,
        paper,
    })
}

/// Words the rulings retired, corrected as the boards are converted.
const WORDS: &[(&str, &str)] = &[
    (
        "Show: All photos or Favorites",
        "Show: All photos or Starred",
    ),
    ("aria-label=\"Favorite\"", "aria-label=\"Star\""),
    ("Photo, favorite", "Photo, starred"),
];

pub fn convert_board(html: &str, map: &DarkMap, rec: &Recorder) -> Result<String> {
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
            let line_start = out.rfind('\n').map_or(0, |i| i + 1);
            let alone = out[line_start..].trim().is_empty()
                && rest[end..]
                    .trim_start_matches([' ', '\t'])
                    .starts_with('\n');
            at += end;
            if alone {
                out.truncate(line_start);
                at += html[at..].find('\n').map_or(0, |i| i + 1);
            }
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
            .collect();
        let lower = name.to_ascii_lowercase();
        at = end;
        let rewritten = rewrite_start_tag(map, rec, tag, &name, stack.last())?;
        out.push_str(&rewritten.text);
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
            let body = &html[at..body_end];
            if !colour_tokens(body).is_empty() {
                bail!("a colour inside a <{lower}> block");
            }
            out.push_str(body);
            at = body_end;
        }
    }
    for (from, to) in WORDS {
        out = out.replace(from, to);
    }
    Ok(out)
}

fn light_boards(dir: &Path) -> Result<Vec<String>> {
    let text =
        std::fs::read_to_string(dir.join(CANVAS)).with_context(|| format!("read {CANVAS}"))?;
    let canvas: serde_json::Value = serde_json::from_str(&text).context("parse canvas.json")?;
    let boards = canvas["boards"]
        .as_object()
        .ok_or_else(|| anyhow!("canvas.json has no `boards`"))?;
    let mut names: Vec<String> = boards
        .iter()
        .filter(|(name, board)| board["page"] == "light" && dir.join(name).exists())
        .map(|(name, _)| name.clone())
        .collect();
    names.sort();
    Ok(names)
}

/// Convert every light board. With `apply`, write the boards and the new roles.
pub fn run(root: &Path, apply: bool) -> Result<()> {
    let tokens = centraid_design::tokens::Tokens::load(root).context("tokens")?;
    let roles = crate::design_boards::css_roles(&tokens);
    let map = DarkMap::load(root)?;
    let table = map
        .section
        .colors
        .iter()
        .map(|c| hex_key(&c.light))
        .collect();
    let rec = Recorder::new(&roles, table);
    let dir = root.join(MOCKUPS);
    let mut results = Vec::new();
    for light in light_boards(&dir)? {
        let html = std::fs::read_to_string(dir.join(&light))?;
        let text = convert_board(&html, &map, &rec).with_context(|| format!("convert {light}"))?;
        results.push((light, text));
    }
    let keeps: usize = results
        .iter()
        .map(|(_, t)| t.matches(" data-keep").count())
        .sum();
    eprintln!("boards: {}", results.len());
    eprintln!("pairs used: {}", rec.uses.borrow().len());
    eprintln!("roles added: {}", rec.added.borrow().len());
    eprintln!("data-keep elements: {keeps}");
    eprintln!("kept colours (no role):");
    for (hex, n) in rec.kept.borrow().iter() {
        eprintln!("  {hex} x{n}");
    }
    eprintln!("added roles:");
    for (name, (l, d)) in rec.added.borrow().iter() {
        eprintln!("  {name} = {l} -> {d}");
    }
    if apply {
        for (light, text) in &results {
            std::fs::write(dir.join(light), text)?;
        }
        let mut block = String::from("[board]\n");
        for (name, (light, dark)) in rec.added.borrow().iter() {
            block.push_str(&format!(
                "{name} = {{ light = \"{light}\", dark = \"{dark}\" }}\n"
            ));
        }
        let path = root.join(TOKENS);
        let text = std::fs::read_to_string(&path)?;
        let marker = "# design/mockups from the light";
        let at = text.find(marker).ok_or_else(|| anyhow!("no marker"))?;
        let mut text = text;
        text.insert_str(at, &format!("{block}\n"));
        std::fs::write(path, text)?;
    }
    let _ = (HashMap::<u8, u8>::new(), HashSet::<u8>::new());
    Ok(())
}

/// Link `./tokens.css` in every light board's `<helmet>`.
pub fn add_links(root: &Path) -> Result<usize> {
    let dir = root.join(MOCKUPS);
    let mut done = 0;
    for light in light_boards(&dir)? {
        let path = dir.join(&light);
        let text = std::fs::read_to_string(&path)?;
        if text.contains("./tokens.css") {
            continue;
        }
        let at = text
            .find("<helmet>")
            .ok_or_else(|| anyhow!("{light}: no <helmet>"))?
            + "<helmet>".len();
        let mut text = text;
        text.insert_str(at, "\n<link rel=\"stylesheet\" href=\"./tokens.css\">");
        std::fs::write(&path, text)?;
        done += 1;
    }
    Ok(done)
}

// ---------------------------------------------------------------------------
// The rulings: retired words, the Invites tab, "What … may read" rows
// ---------------------------------------------------------------------------

struct Elem {
    start: usize,
    open_end: usize,
    end: usize,
    parent: Option<usize>,
}

fn elements(html: &str) -> Vec<Elem> {
    let mut out: Vec<Elem> = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut at = 0;
    while at < html.len() {
        let Some(lt) = html[at..].find('<') else {
            break;
        };
        at += lt;
        let rest = &html[at..];
        if rest.starts_with("<!--") {
            at += rest.find("-->").map_or(rest.len(), |e| e + 3);
            continue;
        }
        if rest.starts_with("<!") || rest.starts_with("<?") {
            at += rest.find('>').map_or(rest.len(), |e| e + 1);
            continue;
        }
        let Some(end) = tag_end(html, at) else { break };
        if let Some(closing) = rest.strip_prefix("</") {
            let name = closing
                .split(['>', ' '])
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if let Some(pos) = stack.iter().rposition(|(_, n)| *n == name) {
                let (index, _) = stack[pos].clone();
                out[index].end = end;
                stack.truncate(pos);
            }
            at = end;
            continue;
        }
        let name: String = html[at + 1..end]
            .chars()
            .take_while(|c| !c.is_whitespace() && !matches!(c, '/' | '>'))
            .collect::<String>()
            .to_ascii_lowercase();
        let self_closed = html[at..end].ends_with("/>");
        let void = VOID.contains(&name.as_str());
        let parent = stack.last().map(|(i, _)| *i);
        out.push(Elem {
            start: at,
            open_end: end,
            end: if void || self_closed { end } else { html.len() },
            parent,
        });
        if !void && !self_closed {
            stack.push((out.len() - 1, name.clone()));
        }
        at = end;
        if matches!(name.as_str(), "script" | "style") {
            let close = format!("</{name}>");
            at = html[at..].find(&close).map_or(html.len(), |e| at + e);
        }
    }
    out
}

/// Remove the nearest ancestor of the first `needle` whose start tag satisfies `row`.
/// Returns whether anything was removed.
fn remove_row(html: &mut String, needle: &str, row: impl Fn(&str) -> bool) -> Result<bool> {
    let Some(index) = html.find(needle) else {
        return Ok(false);
    };
    let elems = elements(html);
    let mut best: Option<usize> = None;
    for (i, e) in elems.iter().enumerate() {
        if e.open_end <= index && index < e.end && best.is_none_or(|b| e.start >= elems[b].start) {
            best = Some(i);
        }
    }
    let mut cur = best.ok_or_else(|| anyhow!("{needle}: no element holds it"))?;
    while !row(&html[elems[cur].start..elems[cur].open_end]) {
        cur = elems[cur]
            .parent
            .ok_or_else(|| anyhow!("{needle}: no row found above it"))?;
    }
    let (mut start, mut end) = (elems[cur].start, elems[cur].end);
    let line_start = html[..start].rfind('\n').map_or(0, |i| i + 1);
    if html[line_start..start].trim().is_empty()
        && html[end..]
            .trim_start_matches([' ', '\t'])
            .starts_with('\n')
    {
        start = line_start;
        end += html[end..].find('\n').map_or(0, |i| i + 1);
    }
    html.replace_range(start..end, "");
    Ok(true)
}

const FLAG: &str = "M5 21V4h11l-2 4 2 4H5";
const STAR: &str = "M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z";

const SHARED: &[(&str, &str)] = &[
    ("Office NAS", "Office Mac"),
    ("Parents’ NAS", "Parents’ Mac"),
    ("Saved elsewhere · 24 words", "Saved elsewhere"),
    ("Not saved yet · 24 words", "Not saved yet"),
    (">Flagged<", ">Starred<"),
    ("Flagged only", "Starred only"),
    ("aria-label=\"Flagged\"", "aria-label=\"Starred\""),
    ("aria-label=\"Flag\"", "aria-label=\"Star\""),
    ("1 flagged", "1 starred"),
    ("Flag · Delete", "Star · Delete"),
    (">Retry<", ">Try again<"),
    ("Your originals as one archive", "Your files as one archive"),
    ("214 originals", "214 photos"),
    ("Keep originals on this phone", "Keep photos on this phone"),
    (
        "Photos library, originals still coming back",
        "Photos library, still coming back",
    ),
    ("thumbnails download", "photo previews download"),
    (">Square<", ">1 : 1<"),
    ("Cropped to Square", "Cropped to 1 : 1"),
    ("NEVER THE SEED", "NEVER THE SECRET"),
    (">Photograph<", ">Photo<"),
    (">Agenda<", ">Calendar<"),
    ("Agenda, 2 results", "Calendar, 2 results"),
    ("Agenda · 2 more", "Calendar · 2 more"),
    ("Centraid · Agenda", "Centraid · Reminders"),
];

/// Apply the rulings to every light board. Returns the boards it changed.
pub fn fix(root: &Path) -> Result<Vec<String>> {
    let dir = root.join(MOCKUPS);
    let mut changed = Vec::new();
    for name in light_boards(&dir)? {
        let path = dir.join(&name);
        let original = std::fs::read_to_string(&path)?;
        let mut text = original.clone();
        for (from, to) in SHARED {
            text = text.replace(from, to);
        }
        text = text.replace(FLAG, STAR);
        if let Some(at) = text.find("<title>Agenda ") {
            let from = at + "<title>".len();
            let rest = &text[from + "Agenda ".len()..];
            let mut chars = rest.chars();
            let first = chars
                .next()
                .map_or(String::new(), |c| c.to_uppercase().collect());
            let tail: String = chars.collect();
            text.replace_range(
                from..from + "Agenda ".len() + rest.len(),
                &format!("{first}{tail}"),
            );
        }
        if name == "ImportReminders.dc.html" {
            text = text.replace(">Agenda</h1>", ">Reminders</h1>");
        }
        while text.contains(">Invites<") || text.contains("Invites<span") {
            if !remove_row(&mut text, "Invites", |tag| {
                tag.contains("flex-direction: column")
            })? {
                break;
            }
        }
        while remove_row(&mut text, "may read", |tag| {
            tag.contains("border-bottom") || tag.starts_with("<a ") || tag.starts_with("<button")
        })? {}
        if text != original {
            std::fs::write(&path, &text)?;
            changed.push(name);
        }
    }
    Ok(changed)
}
