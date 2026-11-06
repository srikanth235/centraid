//! # `crates/design`: design values and computed identity, owned by Rust
//!
//! Two jobs, both pure data and arithmetic:
//!
//! 1. [`tokens`] is the model, parser and validation of `design/tokens.toml`
//!    and `design/icons.toml`, the one source of design values (#1173).
//!    `cargo xtask design` lowers them into the iOS asset catalogue and Swift
//!    tables, the Android resources and Kotlin tables, and the two sites' CSS.
//!    There is no TypeScript in that road.
//! 2. The identity functions below: a party's hue key from its id, its
//!    initials, and a figure's tone. The core computes them once and sends the
//!    shells a key; the shells only look it up. They were ported from
//!    the retired TypeScript design package (#1020), and the golden rows in this file's tests are
//!    that package's answers over a deliberately hostile corpus (non-ASCII
//!    names, an empty name, a one-emoji name, every shape of stored
//!    `avatar_color`), pinned as literals when the TypeScript oracle was
//!    retired.
//!
//! ## The one behaviour that looks like a bug and is reproduced on purpose
//!
//! `identityInitials` slices with `String.prototype.slice(0, 1)`, which cuts a
//! **UTF-16 code unit**. A name whose first character is outside the BMP
//! ("🙂 Smith") yields half a surrogate pair — a string Rust's `String` cannot
//! hold. So [`identity_initials_units`] is the primitive and returns code
//! units; [`identity_initials`] is the lossy convenience over it. The golden rows
//! compare units, so a port that "fixed" this would go red, and the receipt
//! carries the finding rather than this crate carrying a divergence.

pub mod tokens;

/// The ink brand (`#141414`).
///
/// The owner's own avatar is painted with it and never with a party hue: the
/// person wheel has eight places and the vault wheel's ninth is the ink brand,
/// so keying a person off it draws them as a black disc (#883, ruling
/// O-identity).
pub const BRAND: &str = "#141414";

/// The eight party hues, in the order the wheel indexes them
///. INK is not among them.
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
/// The wrap reads like the subtlety and is not one. `Math.imul` multiplies as
/// int32 and JS then ADDS the code point as a double, so the sum can exceed
/// `i32::MAX` — and v0 brings it back by subtracting 2³² when it does. But a
/// code point is NON-NEGATIVE, so the sum can only overflow upward and by at
/// most `0x10_FFFF`: one wrap, never two, and never below `i32::MIN`.
/// Subtracting 2³² exactly when it passes `i32::MAX` is therefore the
/// definition of `i32::wrapping_add`, and the two are the same function. This
/// comment said the opposite until `mobile/.../PartyHueWheelSpec.kt` was
/// written to falsify it and could not, so it also records what the corpus
/// does NOT show: the branch fires zero times across every row, because
/// landing within `0x10_FFFF` of `i32::MAX` is a one-in-four-thousand event
/// per character. The spelling below is kept because it is what the source
/// says, not because it changes an answer.
///
/// The absolute value is the guard that IS real: `Math.abs` of `i32::MIN`
/// answers 2 147 483 648, which no `i32` holds. It changes no hue either —
/// 2³¹ is divisible by eight — but it changes what this function returns.
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
/// This is the shape every surface that paints a party uses —
/// `partyHueValue(partyHueKey(pid)!)` — spelled once so no caller repeats the
/// non-null assertion v0 spells at each site.
#[must_use]
pub fn party_color(party_id: &str) -> String {
    party_hue_value(identity_hue_key(party_id))
}

/// The OKLCH hue angle of each wheel key (OKLCH, as the party wheel was drawn).
const WHEEL_HUES: [(&str, f64); 8] = [
    ("rose", 0.0),
    ("amber", 28.0),
    ("ochre", 70.0),
    ("forest", 150.0),
    ("teal", 210.0),
    ("slate", 255.0),
    ("indigo", 290.0),
    ("violet", 320.0),
];

/// Below this OKLab chroma a colour is a grey: it has no hue to name.
const GREY_CHROMA: f64 = 0.03;

/// The wheel hue closest to a phone's colour (`#RRGGBB`), by OKLCH hue angle: a phone paints its
/// calendars with any colour, and the vault stores the wheel's key, so the colour follows the
/// theme like every party's does. `None` for a grey, a black or white, and a spelling that is not
/// a hex colour: such a calendar takes its id's own hue.
#[must_use]
pub fn hue_key_of_hex(hex: &str) -> Option<&'static str> {
    let (_, hue) = oklch_of_hex(hex)?;
    let apart = |wheel: f64| {
        let gap = (hue - wheel).abs();
        gap.min(360.0 - gap)
    };
    WHEEL_HUES
        .iter()
        .min_by(|left, right| apart(left.1).total_cmp(&apart(right.1)))
        .map(|(key, _)| *key)
}

/// The OKLab chroma and OKLCH hue angle of `#RRGGBB`; `None` for a grey (no hue to name) and for a
/// spelling that is not a hex colour.
fn oklch_of_hex(hex: &str) -> Option<(f64, f64)> {
    let digits = hex.trim().strip_prefix('#')?;
    if digits.len() != 6 || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| -> Option<f64> {
        let value = f64::from(u8::from_str_radix(digits.get(at..at + 2)?, 16).ok()?) / 255.0;
        // sRGB to linear light.
        Some(if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        })
    };
    let (r, g, b) = (channel(0)?, channel(2)?, channel(4)?);
    let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).cbrt();
    let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).cbrt();
    let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).cbrt();
    let a = 1.977_998_495_1 * l - 2.428_592_205_0 * m + 0.450_593_709_9 * s;
    let c = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766_0 * s;
    let chroma = a.hypot(c);
    if chroma < GREY_CHROMA {
        return None;
    }
    Some((chroma, c.atan2(a).to_degrees().rem_euclid(360.0)))
}

/// The eight list colours (`[list]` in `design/tokens.toml`), with the OKLCH hue angle each is
/// nearest to. Graphite is the grey: it has no angle and takes every colour with no hue.
const LIST_KEYS: [&str; 8] = [
    "blue",
    "mustard",
    "violet",
    "petrol",
    "indigo",
    "graphite",
    "raspberry",
    "orchid",
];

/// Where a hue angle lands among the coloured list hues. Red (about 29) is nearer raspberry than
/// anything, and a green (about 145) sits between mustard and petrol, so the angles are placed to
/// send it to petrol: there are no red, amber or green lists (#1173).
const LIST_ANGLES: [(&str, f64); 7] = [
    ("raspberry", 5.0),
    ("mustard", 70.0),
    ("petrol", 205.0),
    ("blue", 250.0),
    ("indigo", 275.0),
    ("violet", 305.0),
    ("orchid", 340.0),
];

/// A list's colour key (`raspberry`, `blue` ...: the `[list]` names), from the list's id and what
/// it stored.
///
/// There is ONE palette of eight (#1173), so every spelling a list can hold lands on it:
/// - nothing stored: the id's own place on the palette, stable;
/// - a list key: itself;
/// - a wheel `var(--c-<hue>)`: its nearest list colour (rose raspberry, amber and ochre mustard,
///   forest and teal petrol, slate graphite);
/// - a `#RRGGBB` from an import: the list colour nearest by hue, a grey going to graphite. So an
///   imported red list is raspberry and a green one petrol, never red or green;
/// - anything else: the id's own place.
#[must_use]
pub fn list_color_key(list_id: &str, stored: Option<&str>) -> &'static str {
    let own = || LIST_KEYS[(identity_hash(list_id.trim()) % LIST_KEYS.len() as u64) as usize];
    let stored = stored.unwrap_or("").trim();
    if stored.is_empty() {
        return own();
    }
    if let Some(key) = LIST_KEYS.iter().find(|key| **key == stored) {
        return key;
    }
    if let Some(wheel) = stored
        .strip_prefix(HUE_VAR_OPEN)
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return match wheel {
            "rose" => "raspberry",
            "amber" | "ochre" => "mustard",
            "forest" | "teal" => "petrol",
            "slate" => "graphite",
            "indigo" => "indigo",
            "violet" => "violet",
            _ => own(),
        };
    }
    if stored.starts_with('#') {
        return match oklch_of_hex(stored) {
            None => "graphite",
            Some((_, hue)) => {
                let apart = |angle: f64| {
                    let gap = (hue - angle).abs();
                    gap.min(360.0 - gap)
                };
                LIST_ANGLES
                    .iter()
                    .min_by(|left, right| apart(left.1).total_cmp(&apart(right.1)))
                    .map_or("graphite", |(key, _)| key)
            }
        };
    }
    own()
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

/// How a figure leaf is painted.
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
    fn a_phone_colour_is_the_wheel_hue_nearest_its_own_and_a_grey_has_none() {
        // The OKLCH hue of each wheel key lands on itself.
        for (key, angle) in WHEEL_HUES {
            let l = 0.5_f64;
            let (a, b) = (
                0.09 * angle.to_radians().cos(),
                0.09 * angle.to_radians().sin(),
            );
            let (l_, m_, s_) = (
                (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3),
                (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3),
                (l - 0.089_484_177_5 * a - 1.291_485_548_0 * b).powi(3),
            );
            let linear = [
                4.076_741_662_1 * l_ - 3.307_711_591_3 * m_ + 0.230_969_929_2 * s_,
                -1.268_438_004_6 * l_ + 2.609_757_401_1 * m_ - 0.341_319_396_5 * s_,
                -0.004_196_086_3 * l_ - 0.703_418_614_7 * m_ + 1.707_614_701_0 * s_,
            ];
            let hex: String = linear
                .iter()
                .map(|v| {
                    let v = v.clamp(0.0, 1.0);
                    let v = if v <= 0.003_130_8 {
                        12.92 * v
                    } else {
                        1.055 * v.powf(1.0 / 2.4) - 0.055
                    };
                    format!("{:02x}", (v * 255.0).round() as u8)
                })
                .collect();
            assert_eq!(hue_key_of_hex(&format!("#{hex}")), Some(key), "#{hex}");
        }
        // The phones' own reds, blues and greens.
        assert_eq!(hue_key_of_hex("#FF3B30"), Some("amber"));
        assert_eq!(hue_key_of_hex("#007AFF"), Some("slate"));
        assert_eq!(hue_key_of_hex("#34C759"), Some("forest"));
        for grey in ["#000000", "#ffffff", "#808080", "#7f7f80"] {
            assert_eq!(hue_key_of_hex(grey), None, "{grey}");
        }
        for bad in ["", "red", "#12", "#ggg111", "123456"] {
            assert_eq!(hue_key_of_hex(bad), None, "{bad}");
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

    /// `partyHueKey` over the corpus the TypeScript oracle was run on, pinned
    /// as literals: the id's own hue when nothing is stored.
    #[test]
    fn a_party_with_nothing_stored_lands_on_the_hue_the_oracle_answered() {
        let rows = [
            ("id-0001", "forest"),
            ("id-0002", "teal"),
            ("id-0003", "slate"),
            ("id-0004", "indigo"),
            ("a", "amber"),
            ("z", "ochre"),
            ("A", "amber"),
            ("", "rose"),
            (" ", "rose"),
            ("  spaced  ", "ochre"),
            ("party:01JQ8ZQ0Y3K9WYD4V6N7M2B5XC", "forest"),
            ("0", "rose"),
            ("00000000-0000-0000-0000-000000000000", "rose"),
            ("ffffffff-ffff-ffff-ffff-ffffffffffff", "rose"),
            ("Ana", "teal"),
            ("Ana Díaz", "ochre"),
            ("李明", "rose"),
            ("Ω", "amber"),
            ("🙂", "ochre"),
            ("🙂🙂", "rose"),
            ("user@example.test", "slate"),
            (
                "a-very-long-party-identifier-that-keeps-going-and-going-0123456789",
                "amber",
            ),
            ("\u{a0}", "rose"),
            ("\t", "rose"),
        ];
        assert_eq!(rows.len(), 24);
        for (id, key) in rows {
            assert_eq!(identity_hue_key(id), key, "hue key for {id:?}");
            assert_eq!(
                party_hue_key(id, None),
                Some(key),
                "stored nothing, for {id:?}"
            );
            assert_eq!(
                party_color(id),
                format!("var(--c-{key})"),
                "value for {id:?}"
            );
        }
    }

    /// A stored `var(--c-<hue>)` wins over the id, whichever id it is.
    #[test]
    fn a_stored_wheel_hue_wins_over_the_id() {
        for id in ["id-0001", "", "\t"] {
            assert_eq!(party_hue_key(id, Some("var(--c-teal)")), Some("teal"));
            assert_eq!(party_hue_key(id, Some("var(--c-violet)")), Some("violet"));
            assert_eq!(party_hue_key(id, Some("var(--c-not-a-hue)")), None);
            assert_eq!(party_hue_key(id, Some("#8c4c61")), None);
            assert_eq!(party_hue_value("teal"), "var(--c-teal)");
        }
    }

    /// `identityInitials` over the oracle's names, as UTF-16 units, including
    /// the half surrogate that `slice(0, 1)` cuts on purpose.
    #[test]
    fn initials_are_the_units_the_oracle_answered_including_the_half_surrogate() {
        let rows: [(&str, &[u16]); 30] = [
            ("You", &[89]),
            ("Someone", &[83]),
            ("Friend", &[70]),
            ("Ana", &[65]),
            ("Ana Díaz", &[65, 68]),
            ("ana díaz", &[65, 68]),
            ("Bo", &[66]),
            ("Cleo", &[67]),
            ("Priya Raman", &[80, 82]),
            ("  Priya   Raman  ", &[80, 82]),
            ("María-José de la Cruz", &[77, 67]),
            ("Jean-Luc", &[74]),
            ("李 明", &[26446, 26126]),
            ("李明", &[26446]),
            ("Ω Ψ", &[937, 936]),
            ("🙂 Smith", &[55357, 83]),
            ("🙂", &[55357]),
            ("Smith 🙂", &[83, 55357]),
            ("", &[183]),
            (" ", &[183]),
            ("   ", &[183]),
            ("\t\n", &[183]),
            ("\u{a0}Ana\u{a0}", &[65]),
            ("d'Angelo", &[68]),
            ("van der Berg", &[86, 66]),
            ("O'Neill McTavish", &[79, 77]),
            ("x", &[88]),
            ("X y", &[88, 89]),
            ("a b c d", &[65, 68]),
            ("ANA", &[65]),
        ];
        for (name, units) in rows {
            assert_eq!(
                identity_initials_units(name),
                units,
                "initials for {name:?}"
            );
        }
        // The divergence stays visible: the emoji rows are half a surrogate.
        assert!(
            identity_initials_units("🙂 Smith")
                .iter()
                .any(|unit| (0xD800..0xE000).contains(unit))
        );
    }

    /// `figureTone` over the oracle's amounts: the sign says the rest.
    #[test]
    fn tones_are_the_ones_the_oracle_answered() {
        for net in [
            1_i64,
            2,
            99,
            100,
            1000,
            10001,
            4200,
            8333,
            2_147_483_647,
            5000,
            1333,
            8416,
            24000,
            3500,
            12,
        ] {
            assert_eq!(figure_tone(net), FigureTone::Owed, "{net}");
            assert_eq!(figure_tone(-net), FigureTone::Net, "-{net}");
        }
        assert_eq!(figure_tone(-2_147_483_648), FigureTone::Net);
        assert_eq!(figure_tone(0), FigureTone::Settled);
    }

    /// There are no red, amber or green lists: every spelling lands on the eight.
    #[test]
    fn a_list_colour_is_always_one_of_the_eight_and_red_becomes_raspberry() {
        for (stored, key) in [
            ("#FF3B30", "raspberry"),
            ("#D32F2F", "raspberry"),
            ("#34C759", "petrol"),
            ("#FF9500", "mustard"),
            ("#FFCC00", "mustard"),
            ("#007AFF", "blue"),
            ("#5856D6", "indigo"),
            ("#AF52DE", "violet"),
            ("#FF2D55", "raspberry"),
            ("#8E8E93", "graphite"),
            ("var(--c-rose)", "raspberry"),
            ("var(--c-forest)", "petrol"),
            ("var(--c-amber)", "mustard"),
            ("var(--c-slate)", "graphite"),
            ("orchid", "orchid"),
        ] {
            assert_eq!(list_color_key("any-id", Some(stored)), key, "{stored}");
        }
        for id in ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] {
            let key = list_color_key(id, None);
            assert!(LIST_KEYS.contains(&key));
            assert_eq!(list_color_key(id, Some("  ")), key, "stable by id");
            assert_eq!(list_color_key(id, Some("var(--c-not-a-hue)")), key);
        }
    }
}
