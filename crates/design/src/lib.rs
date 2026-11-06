//! Rust-owned identity decisions. Shells receive token keys and finished initials.
//! Visual values live in design/tokens.toml and are compiled by cargo xtask design.

/// Persisted identity keys. Their order is stable across releases; current
/// palette roles are resolved with [`hue_role_key`].
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

/// The shared eight-colour list palette. The native shells look these keys up;
/// they never hash ids or choose a colour themselves.
#[must_use]
pub fn list_hue_key(id: &str) -> &'static str {
    const KEYS: [&str; 8] = [
        "listBlue",
        "listYellow",
        "listViolet",
        "listPetrol",
        "listNavy",
        "listGraphite",
        "listRaspberry",
        "listOrchid",
    ];
    KEYS[(identity_hash(id.trim()) % KEYS.len() as u64) as usize]
}

/// Avatar fills support white initials at 4.5:1 in both schemes. The lighter
/// list palette is reserved for markers and is never an initials background.
#[must_use]
pub fn identity_fill_key(id: &str) -> &'static str {
    const KEYS: [&str; 8] = [
        "agendaFill",
        "notesFill",
        "peopleFill",
        "docsFill",
        "moneyFill",
        "lockerFill",
        "healthFill",
        "photosFill",
    ];
    KEYS[(identity_hash(id.trim()) % KEYS.len() as u64) as usize]
}

/// Resolve persisted hue keys to today's palette. Old vaults retain their keys
/// while red/green/amber cease to be list colours (#1173).
#[must_use]
pub fn hue_role_key(key: &str) -> &'static str {
    match key {
        "slate" | "blue" | "listBlue" => "listBlue",
        "ochre" | "yellow" | "listYellow" => "listYellow",
        "violet" | "listViolet" => "listViolet",
        "forest" | "teal" | "petrol" | "listPetrol" => "listPetrol",
        "indigo" | "navy" | "listNavy" => "listNavy",
        "olive" | "graphite" | "listGraphite" => "listGraphite",
        "amber" | "raspberry" | "listRaspberry" => "listRaspberry",
        "rose" | "orchid" | "listOrchid" => "listOrchid",
        _ => "listGraphite",
    }
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

/// Stable import buckets for persisted hue keys. Their visual roles come from
/// [`hue_role_key`], so a bucket never defines a second colour palette.
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
    if a.hypot(c) < GREY_CHROMA {
        return None;
    }
    let hue = c.atan2(a).to_degrees().rem_euclid(360.0);
    let apart = |wheel: f64| {
        let gap = (hue - wheel).abs();
        gap.min(360.0 - gap)
    };
    WHEEL_HUES
        .iter()
        .min_by(|left, right| apart(left.1).total_cmp(&apart(right.1)))
        .map(|(key, _)| *key)
}

/// Initials from the first and last words, preserving whole Unicode characters.
/// This is computed once in Rust, never by a shell.
#[must_use]
pub fn identity_initials(name: &str) -> String {
    let mut words = name.split_whitespace();
    let Some(first) = words.next() else {
        return "?".to_owned();
    };
    let initial = |word: &str| {
        word.chars()
            .next()
            .map(|c| c.to_uppercase().to_string())
            .unwrap_or_default()
    };
    let mut initials = initial(first);
    if let Some(last) = words.next_back() {
        initials.push_str(&initial(last));
    }
    initials
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
    fn imported_red_is_raspberry_and_list_colours_never_use_state_roles() {
        let red = hue_key_of_hex("#FF3B30").expect("red has a hue");
        assert_eq!(hue_role_key(red), "listRaspberry");
        let keys: std::collections::BTreeSet<_> =
            (0..256).map(|id| list_hue_key(&id.to_string())).collect();
        assert_eq!(keys.len(), 8);
        assert!(keys.iter().all(|key| key.starts_with("list")));
        assert_eq!(list_hue_key("same"), list_hue_key(" same "));
    }

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
    fn initials_preserve_unicode_and_an_empty_name_is_not_an_empty_avatar() {
        assert_eq!(identity_initials(""), "?");
        assert_eq!(identity_initials("   "), "?");
        assert_eq!(identity_initials("You"), "Y");
        assert_eq!(identity_initials("🙂 Smith"), "🙂S");
        assert_eq!(identity_initials("𐐨 Test"), "𐐀T");
        assert_eq!(identity_initials("Ana Díaz"), "AD");
        assert_eq!(identity_initials("  Priya   Raman  "), "PR");
        // Three parts take the FIRST and the LAST, never the middle.
        assert_eq!(identity_initials("a b c"), "AC");
    }
}
