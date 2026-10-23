//! THE GENERATOR (#1047): a string without an item (the handoff's Generate
//! tab). It reads nothing and writes nothing; "Put it on an item" hands the
//! candidate to the editor through [`super::handoff`].
//!
//! Randomness is the operating system's CSPRNG, mapped to characters by
//! REJECTION SAMPLING — a byte at or above the largest multiple of the
//! alphabet's size is discarded — so no character is likelier than another.
//!
//! Look-alikes (0 O o 1 l I | ` ' ") are never in an alphabet: a password a
//! member may one day read aloud or type from paper must not hinge on a glyph.
//! Characters or a PIN; words wait for a word list this layer does not carry.

use centraid_api_proto::core_v1 as wire;

use crate::strings::{Locale, fill, locker as words};

pub(super) const MIN_LENGTH: u32 = 8;
pub(super) const MAX_LENGTH: u32 = 40;
pub(super) const DEFAULT_LENGTH: u32 = 20;
const PIN_MIN: u32 = 4;
const PIN_MAX: u32 = 12;
const PIN_DEFAULT: u32 = 6;

const LETTERS: &str = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS: &str = "23456789";
const SYMBOLS: &str = "!#$%&*+-=?@^_~";
const PIN_DIGITS: &str = "0123456789";

/// Where randomness comes from. A test injects a fixed stream.
pub type Entropy = Box<dyn Fn(usize) -> Vec<u8> + Send>;

/// The operating system's CSPRNG.
#[must_use]
pub fn system_entropy() -> Entropy {
    Box::new(|count| {
        use rand::TryRngCore as _;
        let mut bytes = vec![0_u8; count];
        // A system with no entropy yields no bytes, and `generate` then keeps
        // the last output rather than pad one with something predictable.
        if rand::rngs::OsRng.try_fill_bytes(&mut bytes).is_err() {
            bytes.clear();
        }
        bytes
    })
}

/// The alphabet for these options.
fn alphabet(pin: bool, digits: bool, symbols: bool) -> String {
    if pin {
        return PIN_DIGITS.to_owned();
    }
    let mut alphabet = LETTERS.to_owned();
    if digits {
        alphabet.push_str(DIGITS);
    }
    if symbols {
        alphabet.push_str(SYMBOLS);
    }
    alphabet
}

/// `length` characters from `alphabet`, or `None` when `entropy` ran out first.
fn draw(entropy: &[u8], alphabet: &str, length: usize) -> Option<String> {
    let characters: Vec<char> = alphabet.chars().collect();
    let size = characters.len();
    let ceiling = 256 - (256 % size);
    let mut out = String::with_capacity(length);
    for byte in entropy {
        if out.chars().count() == length {
            break;
        }
        let value = usize::from(*byte);
        if value < ceiling {
            out.push(characters[value % size]);
        }
    }
    (out.chars().count() == length).then_some(out)
}

/// Bits of strength of a random string of `length` over an alphabet of `size`.
fn bits(size: usize, length: u32) -> u32 {
    if size < 2 {
        return 0;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let bits = (f64::from(length) * (size as f64).log2()).round() as u32;
    bits
}

/// A TYPED password's rough strength — the shape of `watchtower`'s
/// `strength_score` (length and character classes), never a claim about a
/// breach.
#[must_use]
pub(crate) fn typed_bits(password: &str) -> u32 {
    if password.is_empty() {
        return 0;
    }
    let mut pool = 0;
    if password.chars().any(char::is_lowercase) {
        pool += 26;
    }
    if password.chars().any(char::is_uppercase) {
        pool += 26;
    }
    if password.chars().any(|character| character.is_ascii_digit()) {
        pool += 10;
    }
    if password
        .chars()
        .any(|character| !character.is_alphanumeric())
    {
        pool += 20;
    }
    bits(
        pool,
        u32::try_from(password.chars().count()).unwrap_or(u32::MAX),
    )
}

/// "Strong · about 95 bits".
#[must_use]
pub(crate) fn strength(locale: Locale, bits: u32) -> String {
    let label = match bits {
        0..=39 => words::strength_weak(locale),
        40..=59 => words::strength_fair(locale),
        60..=79 => words::strength_strong(locale),
        _ => words::strength_very_strong(locale),
    };
    fill(
        &words::strength(locale),
        &[("label", &label), ("bits", &bits.to_string())],
    )
}

/// A fresh password for the editor's Generate: twenty characters, digits and
/// symbols in.
pub(crate) fn password(entropy: &Entropy) -> Option<String> {
    draw(
        &entropy(128),
        &alphabet(false, true, true),
        DEFAULT_LENGTH as usize,
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Characters,
    Pin,
}

/// The generator's whole state.
pub(super) struct Generator {
    kind: Kind,
    length: u32,
    digits: bool,
    symbols: bool,
    output: String,
    entropy: Entropy,
}

impl Generator {
    pub(super) fn new(entropy: Entropy) -> Self {
        let mut generator = Self {
            kind: Kind::Characters,
            length: DEFAULT_LENGTH,
            digits: true,
            symbols: true,
            output: String::new(),
            entropy,
        };
        generator.regenerate();
        generator
    }

    fn pin(&self) -> bool {
        self.kind == Kind::Pin
    }

    fn bounds(&self) -> (u32, u32) {
        if self.pin() {
            (PIN_MIN, PIN_MAX)
        } else {
            (MIN_LENGTH, MAX_LENGTH)
        }
    }

    /// The candidate on screen (the editor's, when the member puts it on an
    /// item). Empty after a relock.
    pub(super) fn output(&self) -> &str {
        &self.output
    }

    /// A RELOCK DROPS THE CANDIDATE, like anything a Locker screen held.
    pub(super) fn forget(&mut self) {
        self.output.clear();
    }

    /// An EXHAUSTED DRAW KEEPS THE LAST OUTPUT rather than padding a short one.
    pub(super) fn regenerate(&mut self) {
        let alphabet = alphabet(self.pin(), self.digits, self.symbols);
        let entropy = (self.entropy)(128);
        if let Some(drawn) = draw(&entropy, &alphabet, self.length as usize) {
            self.output = drawn;
        }
    }

    pub(super) fn pick_kind(&mut self, key: &str) {
        match key {
            "pin" => {
                self.kind = Kind::Pin;
                self.length = PIN_DEFAULT;
            }
            "characters" => {
                self.kind = Kind::Characters;
                self.length = DEFAULT_LENGTH;
            }
            _ => return,
        }
        self.regenerate();
    }

    pub(super) fn set_length(&mut self, length: u32) {
        let (min, max) = self.bounds();
        self.length = length.clamp(min, max);
        self.regenerate();
    }

    pub(super) fn toggle(&mut self, key: &str) {
        match key {
            "digits" => self.digits = !self.digits,
            "symbols" => self.symbols = !self.symbols,
            _ => return,
        }
        self.regenerate();
    }

    pub(super) fn view(&self, locale: Locale) -> wire::LockerGenerator {
        let pin = self.pin();
        let (min, max) = self.bounds();
        let size = alphabet(pin, self.digits, self.symbols).chars().count();
        wire::LockerGenerator {
            title: words::generator_title(locale),
            output: self.output.clone(),
            strength: if self.output.is_empty() {
                String::new()
            } else {
                strength(locale, bits(size, self.length))
            },
            kinds: vec![
                choice("characters", words::kind_characters(locale), !pin),
                choice("pin", words::kind_pin(locale), pin),
            ],
            kinds_label: words::kind(locale),
            length: self.length,
            length_min: min,
            length_max: max,
            length_label: fill(&words::length(locale), &[("n", &self.length.to_string())]),
            include: if pin {
                Vec::new()
            } else {
                vec![
                    choice("digits", words::include_digits(locale), self.digits),
                    choice("symbols", words::include_symbols(locale), self.symbols),
                ]
            },
            include_label: if pin {
                String::new()
            } else {
                words::include(locale)
            },
            lookalike_note: if pin {
                String::new()
            } else {
                words::lookalikes(locale)
            },
            regenerate_label: words::regenerate(locale),
            copy_label: words::copy(locale),
            use_label: if pin || self.output.is_empty() {
                String::new()
            } else {
                words::use_on_item(locale)
            },
            use_route: (!pin && !self.output.is_empty()).then(|| super::routes::add("login", true)),
            accessibility_label: words::generator_a11y(locale),
        }
    }
}

fn choice(key: &str, label: String, selected: bool) -> wire::LockerChoice {
    wire::LockerChoice {
        key: key.to_owned(),
        label,
        selected,
        detail: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejection_sampling_never_prefers_a_character() {
        // 250 of the 256 byte values map evenly over a 25-letter alphabet; the
        // six above are discarded, not folded onto the first six letters.
        let alphabet = "abcdefghijklmnopqrstuvwxy";
        let all: Vec<u8> = (0..=255).collect();
        let drawn = draw(&all, alphabet, 250).expect("enough bytes");
        let a = drawn.chars().filter(|c| *c == 'a').count();
        let y = drawn.chars().filter(|c| *c == 'y').count();
        assert_eq!(a, y, "{drawn}");
    }

    #[test]
    fn an_alphabet_never_holds_a_look_alike() {
        for look_alike in ['0', 'O', 'o', '1', 'l', 'I', '|', '`', '\'', '"'] {
            assert!(
                !alphabet(false, true, true).contains(look_alike),
                "{look_alike}"
            );
        }
    }

    #[test]
    fn a_short_stream_keeps_the_last_output() {
        let mut generator = Generator::new(Box::new(|_| (0..=255).collect()));
        let first = generator.output().to_owned();
        assert_eq!(first.chars().count(), DEFAULT_LENGTH as usize);
        generator.entropy = Box::new(|_| vec![1, 2]);
        generator.regenerate();
        assert_eq!(generator.output(), first);
    }

    #[test]
    fn a_pin_is_digits_and_its_length_is_clamped() {
        let mut generator = Generator::new(Box::new(|_| (0..=255).collect()));
        generator.pick_kind("pin");
        assert_eq!(generator.output().chars().count(), PIN_DEFAULT as usize);
        assert!(generator.output().chars().all(|c| c.is_ascii_digit()));
        generator.set_length(99);
        assert_eq!(generator.output().chars().count(), PIN_MAX as usize);
        assert_eq!(generator.view(Locale::En).use_label, "");
    }

    #[test]
    fn strength_is_worded_by_bits() {
        assert!(strength(Locale::En, 95).contains("95"));
        assert!(typed_bits("abc") < typed_bits("Abc123!?xyz"));
    }
}
