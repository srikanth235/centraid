//! # `crates/design` — ONE lowering of `packages/design`, not a second copy
//!
//! `packages/design` is the token source with two lowerings from one token set:
//! `toCss()` for the web and desktop, `toNativeTheme(scheme)` for native
//! (`packages/design/src/native.ts:213`). Wave 3's lane E emitted the native
//! lowering as data — `design/native-theme.json`, `mobile/.../Tokens.kt`,
//! `mobile/iosApp/Design/Theme.swift` — from one emitter with a drift gate
//! (`contracts/tools/export-native-theme.ts`, D-1020-E6).
//!
//! This crate is the Rust half of that same lowering, and it exists for a
//! blocked parity comparison: `contracts/apps/tally/queries.json` carries a
//! party's `color` from `partyHueValue(partyHueKey(id))`, its `initials` from
//! `identityInitials` and a figure's tone from `figureTone`, so the 29 Tally
//! cases could be committed and not compared (wave 2 lane D3's receipt,
//! D-1020-D3-9).
//!
//! ## What keeps it honest (#1020, D-1020-T1)
//!
//! | Risk | What stops it |
//! |---|---|
//! | A retyped hue wheel drifting from the TS one | the same emitter runs the REAL functions over a fixed corpus into `design/identity-corpus.json`; [`tests/corpus.rs`](../../tests/corpus.rs) asserts **every row** |
//! | A hand-maintained colour table | the theme is READ from `design/native-theme.json`; there is no colour literal in this crate but [`BRAND`], which the corpus asserts too |
//! | A role quietly dropped from the native theme | the emitter carries `colorRoleContract` as data and [`assert_native_color_role_contract`] re-asserts it in Rust over the emitted bytes |
//!
//! ## The one behaviour that looks like a bug and is reproduced on purpose
//!
//! `identityInitials` slices with `String.prototype.slice(0, 1)`, which cuts a
//! **UTF-16 code unit**. A name whose first character is outside the BMP
//! ("🙂 Smith") yields half a surrogate pair — a string Rust's `String` cannot
//! hold. So [`identity_initials_units`] is the primitive and returns code
//! units; [`identity_initials`] is the lossy convenience over it. The corpus
//! compares units, so a port that "fixed" this would go red, and the receipt
//! carries the finding rather than this crate carrying a divergence.

pub mod copy;

use std::collections::BTreeMap;

/// The ink brand (`packages/design/src/themes/shared.ts:18`).
///
/// The owner's own avatar is painted with it and never with a party hue: the
/// person wheel has eight places and the vault wheel's ninth is the ink brand,
/// so keying a person off it draws them as a black disc (#883, ruling
/// O-identity).
pub const BRAND: &str = "#141414";

/// The eight party hues, in the order the wheel indexes them
/// (`packages/design/src/identity.ts:47-56`). INK is not among them.
pub const IDENTITY_HUE_KEYS: [&str; 8] = [
    "rose", "amber", "ochre", "forest", "teal", "slate", "indigo", "violet",
];

/// `var(--c-` — halved in v0 so the design-token gate reads no CSS
/// (`identity.ts:64`). Kept whole here: Rust has no such gate, and splitting a
/// prefix to satisfy a scanner that does not run is cargo cult.
const HUE_VAR_OPEN: &str = "var(--c-";

/// v0's `identityHash`: `Math.imul(hash, 31) + codePoint`, wrapped to a signed
/// 32-bit range, then `Math.abs`.
///
/// The wrap is the whole subtlety. `Math.imul` multiplies as int32 and JS then
/// ADDS the code point as a double, so the sum can exceed `i32::MAX` — and v0
/// brings it back by subtracting 2³² when it does. An `i32::wrapping_add`
/// would wrap at a different place and give a different hue for a minority of
/// ids; the corpus is what proves this one agrees.
#[must_use]
pub fn identity_hash(value: &str) -> u64 {
    let mut hash: i32 = 0;
    for character in value.chars() {
        let next = i64::from(hash.wrapping_mul(31)) + i64::from(u32::from(character));
        hash = if next > i64::from(i32::MAX) {
            // Exactly v0's `next - 0x1_0000_0000`.
            (next - 0x1_0000_0000) as i32
        } else {
            next as i32
        };
    }
    i64::from(hash).unsigned_abs()
}

/// The hue an id lands on when nothing is stored (`identity.ts:58-61`).
#[must_use]
pub fn identity_hue_key(id: &str) -> &'static str {
    let index = (identity_hash(id.trim()) % IDENTITY_HUE_KEYS.len() as u64) as usize;
    IDENTITY_HUE_KEYS[index]
}

/// A hue key as the value a surface paints with (`identity.ts:68`).
#[must_use]
pub fn party_hue_value(key: &str) -> String {
    format!("{HUE_VAR_OPEN}{key})")
}

/// THE party hue (#883, ruling O-identity), from the id and whatever the row
/// stored (`identity.ts:74-85`).
///
/// `avatar_color` stores the KEY inside a `var()`, never a hex, so hues follow
/// the theme. Three answers, and the third is why this returns an `Option`
/// rather than a `&str`:
///
/// - nothing stored (absent, null, empty or whitespace) → the id's own hue;
/// - a stored `var(--c-<hue>)` naming one of the eight → that hue;
/// - anything else → `None`, a stored literal the wheel cannot name. v0's
///   callers spell that `partyHueValue(partyHueKey(id)!)` and would paint
///   `var(--c-null)`; a port that substituted a default would be inventing an
///   answer, so the `None` travels.
#[must_use]
pub fn party_hue_key(party_id: &str, avatar_color: Option<&str>) -> Option<&'static str> {
    let stored = avatar_color.unwrap_or("").trim();
    if stored.is_empty() {
        return Some(identity_hue_key(party_id));
    }
    if !stored.starts_with(HUE_VAR_OPEN) || !stored.ends_with(')') {
        return None;
    }
    let key = &stored[HUE_VAR_OPEN.len()..stored.len() - 1];
    IDENTITY_HUE_KEYS
        .iter()
        .find(|candidate| **candidate == key)
        .copied()
}

/// The colour a party is painted, for the common call: no stored colour.
///
/// This is the shape every Tally surface uses —
/// `partyHueValue(partyHueKey(pid)!)` — spelled once so no caller repeats the
/// non-null assertion v0 spells at each site.
#[must_use]
pub fn party_color(party_id: &str) -> String {
    party_hue_value(identity_hue_key(party_id))
}

/// `identityInitials`, in UTF-16 code units (`identity.ts:22-28`).
///
/// The units, not a `String`, because v0's `slice(0, 1)` can cut a surrogate
/// pair in half and the answer is then not valid UTF-8. See the crate doc.
#[must_use]
pub fn identity_initials_units(name: &str) -> Vec<u16> {
    // `split_whitespace` already skips leading and trailing runs, which is
    // what v0's `trim().split(/\s+/u).filter(Boolean)` amounts to.
    let parts: Vec<&str> = name.split_whitespace().collect();
    if parts.is_empty() {
        return "·".encode_utf16().collect();
    }
    let first_unit = |part: &str| -> Vec<u16> {
        // `slice(0, 1)` is ONE UTF-16 code unit, and `toUpperCase` runs after
        // the cut — so a half surrogate is upper-cased as itself.
        part.encode_utf16().take(1).collect()
    };
    let units: Vec<u16> = if parts.len() == 1 {
        first_unit(parts[0])
    } else {
        let last = parts[parts.len() - 1];
        let mut both = first_unit(parts[0]);
        both.extend(first_unit(last));
        both
    };
    upper_case_units(&units)
}

/// Upper-case the way `String.prototype.toUpperCase` does for the characters
/// an initial can be: whole code points map through Unicode's uppercase
/// mapping, and a lone surrogate has none, so it survives unchanged.
fn upper_case_units(units: &[u16]) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        let is_high = (0xD800..0xDC00).contains(&unit);
        let pair =
            is_high && index + 1 < units.len() && (0xDC00..0xE000).contains(&units[index + 1]);
        if pair {
            // A full pair is a code point; astral planes have no uppercase
            // mapping in any character an initial can be, so it is copied.
            out.push(units[index]);
            out.push(units[index + 1]);
            index += 2;
            continue;
        }
        if (0xD800..0xE000).contains(&unit) {
            // A LONE SURROGATE. `toUpperCase` leaves it alone; so do we.
            out.push(unit);
            index += 1;
            continue;
        }
        let character = char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER);
        // `to_uppercase` is the full Unicode mapping, which is what
        // `toUpperCase` uses too (so "ß" becomes "SS" on both sides).
        out.extend(character.to_uppercase().flat_map(|upper| {
            let mut buffer = [0u16; 2];
            upper.encode_utf16(&mut buffer).to_vec()
        }));
        index += 1;
    }
    out
}

/// `identityInitials` as text, for the callers whose input cannot be astral.
///
/// Lossy on purpose and only there: a lone surrogate becomes U+FFFD rather
/// than a panic, and the units function is the one a parity comparison uses.
#[must_use]
pub fn identity_initials(name: &str) -> String {
    String::from_utf16_lossy(&identity_initials_units(name))
}

/// How a figure leaf is painted (`packages/blueprints/apps/tally/format.ts:20`).
///
/// `Net` is the `--net` token — the owner owes; `Owed` is plain ink — the owner
/// is owed; `Settled` is the recessive rung. **Never a green**: a settled
/// balance is a fact, not a reward.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FigureTone {
    Net,
    Owed,
    Settled,
}

impl FigureTone {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Net => "net",
            Self::Owed => "owed",
            Self::Settled => "settled",
        }
    }
}

/// ONE SIGN CONVENTION FOR THE WHOLE APP: positive is owed TO the owner,
/// negative is owed BY them (`format.ts:37`).
///
/// The dead band is a single minor unit, and it is not a rounding tolerance: a
/// balance that rounds to nothing IS level, and a row reading "you owe £0.00"
/// in `--net` would be a warning about nothing.
#[must_use]
pub const fn figure_tone(net_minor: i64) -> FigureTone {
    if net_minor.unsigned_abs() < 1 {
        FigureTone::Settled
    } else if net_minor < 0 {
        FigureTone::Net
    } else {
        FigureTone::Owed
    }
}

// ---------------------------------------------------------------------------
// The emitted theme.
// ---------------------------------------------------------------------------

/// One scheme of the emitted native theme, as the bytes carry it.
#[derive(Debug, Clone)]
pub struct NativeTheme {
    pub scheme: String,
    /// Every `colors` entry, including the three that are CSS `box-shadow`
    /// strings rather than colours (the emitter's own finding).
    pub colors: BTreeMap<String, String>,
    pub spacing: BTreeMap<String, f64>,
    pub radii: BTreeMap<String, f64>,
}

/// The whole emitted table: the schemes plus the role contract, as data.
#[derive(Debug, Clone)]
pub struct NativeThemes {
    pub schemes: BTreeMap<String, NativeTheme>,
    /// Native field name → the CSS custom property it lowers.
    pub color_role_contract: BTreeMap<String, String>,
}

/// What a theme file can be wrong about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThemeError {
    /// The JSON is not the shape the emitter writes.
    Shape { detail: String },
    /// A role the contract names is not in a scheme's colours.
    MissingRole { scheme: String, field: String },
}

impl std::fmt::Display for ThemeError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Shape { detail } => write!(out, "the emitted theme is not readable: {detail}"),
            Self::MissingRole { scheme, field } => write!(
                out,
                "`{field}` is in the colour-role contract and missing from the `{scheme}` scheme"
            ),
        }
    }
}

impl std::error::Error for ThemeError {}

fn object<'a>(
    value: &'a serde_json::Value,
    at: &str,
) -> Result<&'a serde_json::Map<String, serde_json::Value>, ThemeError> {
    value
        .get(at)
        .and_then(serde_json::Value::as_object)
        .ok_or(ThemeError::Shape {
            detail: format!("`{at}` is not an object"),
        })
}

/// Read `design/native-theme.json`'s parsed JSON into [`NativeThemes`].
pub fn native_themes(value: &serde_json::Value) -> Result<NativeThemes, ThemeError> {
    let mut schemes: BTreeMap<String, NativeTheme> = BTreeMap::new();
    for (name, scheme) in object(value, "schemes")? {
        let strings = |at: &str| -> Result<BTreeMap<String, String>, ThemeError> {
            Ok(object(scheme, at)?
                .iter()
                .map(|(key, entry)| {
                    (
                        key.clone(),
                        entry
                            .as_str()
                            .map_or_else(|| entry.to_string(), str::to_owned),
                    )
                })
                .collect())
        };
        let numbers = |at: &str| -> Result<BTreeMap<String, f64>, ThemeError> {
            Ok(object(scheme, at)?
                .iter()
                .filter_map(|(key, entry)| Some((key.clone(), entry.as_f64()?)))
                .collect())
        };
        schemes.insert(
            name.clone(),
            NativeTheme {
                scheme: name.clone(),
                colors: strings("colors")?,
                spacing: numbers("spacing")?,
                radii: numbers("radii")?,
            },
        );
    }
    let color_role_contract = object(value, "colorRoleContract")?
        .iter()
        .map(|(field, css)| (field.clone(), css.as_str().unwrap_or_default().to_owned()))
        .collect();
    Ok(NativeThemes {
        schemes,
        color_role_contract,
    })
}

/// `assertNativeColorRoleContract`, re-asserted over the EMITTED table
/// (`packages/design/src/roles.ts:1022`).
///
/// The TypeScript assertion runs inside the emitter, over the same values. This
/// one runs over the committed bytes, which is the artifact a Rust surface
/// reads — and an emitter that started dropping a role would otherwise only be
/// caught by the side that no longer needs it.
pub fn assert_native_color_role_contract(themes: &NativeThemes) -> Result<(), ThemeError> {
    for (scheme, theme) in &themes.schemes {
        for field in themes.color_role_contract.keys() {
            if !theme.colors.contains_key(field) {
                return Err(ThemeError::MissingRole {
                    scheme: scheme.clone(),
                    field: field.clone(),
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dead_band_is_one_minor_unit_and_the_sign_says_the_rest() {
        assert_eq!(figure_tone(0), FigureTone::Settled);
        assert_eq!(figure_tone(1), FigureTone::Owed);
        assert_eq!(figure_tone(-1), FigureTone::Net);
        assert_eq!(figure_tone(i64::MIN), FigureTone::Net);
    }

    #[test]
    fn a_stored_colour_the_wheel_cannot_name_is_none_rather_than_a_default() {
        assert_eq!(party_hue_key("whoever", Some("#8c4c61")), None);
        assert_eq!(party_hue_key("whoever", Some("var(--c-not-a-hue)")), None);
        assert_eq!(
            party_hue_key("whoever", Some("var(--c-teal)")),
            Some("teal")
        );
        // Nothing stored, in all four spellings, is the id's own hue.
        let own = identity_hue_key("whoever");
        for stored in [None, Some(""), Some("   "), Some("\t")] {
            assert_eq!(party_hue_key("whoever", stored), Some(own));
        }
    }

    #[test]
    fn an_empty_name_is_the_interpunct_and_not_an_empty_avatar() {
        assert_eq!(identity_initials(""), "·");
        assert_eq!(identity_initials("   "), "·");
        assert_eq!(identity_initials("You"), "Y");
        assert_eq!(identity_initials("Ana Díaz"), "AD");
        assert_eq!(identity_initials("  Priya   Raman  "), "PR");
        // Three parts take the FIRST and the LAST, never the middle.
        assert_eq!(identity_initials("a b c"), "AC");
    }
}
