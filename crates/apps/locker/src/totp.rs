//! TOTP — RFC 6238, split so the hash is not in an app crate (D-1020-L6).
//!
//! v0 computed this twice: once in the vault command `locker.totp_code`
//! (`createHmac("sha1", …)`) and once in the app for the live countdown
//! (`crypto.subtle`). Both unsealed the seed and emitted six digits; neither
//! logged the seed or the code.
//!
//! The command plane cannot unseal, so `locker.totp_code` only writes the
//! receipt, and the seed is opened where `K` is — the phone's core
//! (`crates/core::locker::phone`, Q-1047-16), which injects HMAC-SHA-1 and
//! proves the whole chain against RFC 6238 Appendix B. What stays here is
//! everything about RFC 6238 **except the HMAC**: base32, the counter, the
//! dynamic truncation, the remaining-seconds arithmetic, and reading what a
//! member pastes ([`seed_of`]: a bare base32 secret or an `otpauth://totp/`
//! URI). A hash in an app crate is a hash whose collision behaviour nobody
//! owns (this crate's own rule), so the primitive is the caller's.
//!
//! ## The two v0 spellings that differ, and which one this is
//!
//! `locker.ts`'s decoder strips `[\s=-]` and **throws** on a non-base32
//! character; `totp.ts`'s strips `=` and whitespace, refuses a hyphen, and
//! answers `null`. This port takes the **union of what they accept** (spaces,
//! `=` padding and hyphens, all ignored) and the **stricter of the two
//! answers** (`None`, never a panic): an authenticator app that prints its
//! secret in hyphenated groups is a real thing, and a member pasting one
//! should not get a six-digit code computed from a seed the decoder silently
//! mangled. The divergence is in the receipt as a finding against `totp.ts`,
//! which today refuses a hyphenated seed the vault accepts — so the app's live
//! countdown shows nothing while the command answers.

/// RFC 6238's step, and v0's.
const PERIOD_SECONDS: u64 = 30;

/// Six digits.
const DIGITS: u32 = 6;

const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Decode a base32 seed. `None` for anything that is not one.
///
/// Whitespace, `=` padding and `-` grouping are ignored; case is folded. A
/// seed whose bits do not fill a byte contributes no trailing partial byte,
/// which is RFC 4648 and both v0 spellings.
#[must_use]
pub fn base32_decode(seed: &str) -> Option<Vec<u8>> {
    let mut bits = 0_u32;
    let mut value = 0_u32;
    let mut out = Vec::new();
    let mut seen = false;
    for character in seed.chars() {
        if character.is_whitespace() || character == '=' || character == '-' {
            continue;
        }
        let upper = character.to_ascii_uppercase();
        let index = ALPHABET.iter().position(|known| *known == upper as u8)?;
        seen = true;
        value = (value << 5) | u32::try_from(index).ok()?;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((value >> bits) & 0xff).ok()?);
        }
    }
    if !seen || out.is_empty() {
        return None;
    }
    Some(out)
}

/// The counter for an instant: `floor(epoch_ms / 1000 / 30)`, big-endian.
#[must_use]
fn step_at(epoch_ms: i64) -> u64 {
    let seconds = epoch_ms.div_euclid(1_000).max(0);
    u64::try_from(seconds).unwrap_or(0) / PERIOD_SECONDS
}

/// The eight bytes a step is HMAC'd as.
#[must_use]
fn counter_bytes(step: u64) -> [u8; 8] {
    step.to_be_bytes()
}

/// RFC 6238's DYNAMIC TRUNCATION — the part a port gets wrong.
///
/// The offset is the **low nibble of the last byte**, the four bytes from there
/// are read big-endian with the top bit of the first masked off, and the code
/// is that number modulo `10^digits`, zero-padded. `None` when the digest is
/// too short to contain an offset plus four bytes, which no HMAC-SHA-1 digest
/// is — the check is here so a caller that passes a truncated digest gets a
/// refusal rather than a panic.
#[must_use]
fn truncate(digest: &[u8]) -> Option<String> {
    let last = *digest.last()?;
    let offset = usize::from(last & 0x0f);
    let window = digest.get(offset..offset + 4)?;
    let binary = (u32::from(window[0] & 0x7f) << 24)
        | (u32::from(window[1]) << 16)
        | (u32::from(window[2]) << 8)
        | u32::from(window[3]);
    let modulus = 10_u32.pow(DIGITS);
    Some(format!(
        "{:0width$}",
        binary % modulus,
        width = DIGITS as usize
    ))
}

/// Seconds until this code rolls: `30 - (epoch_seconds % 30)`.
///
/// v0's arithmetic, including the fact that it is never `0` — at the instant a
/// step begins the answer is the full thirty, which is what a countdown ring
/// draws.
#[must_use]
fn remaining_seconds(epoch_ms: i64) -> u64 {
    let seconds = u64::try_from(epoch_ms.div_euclid(1_000).max(0)).unwrap_or(0);
    PERIOD_SECONDS - (seconds % PERIOD_SECONDS)
}

/// One code, and how long it has left.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Code {
    /// Six digits, as the command returns them.
    pub code: String,
    pub period: u64,
    pub remaining: u64,
}

/// Compute the code at an instant, given the HMAC the caller holds.
///
/// `hmac_sha1(key, message)` is injected. The seed is decoded here and the key
/// bytes are handed over once; nothing in this module keeps either.
pub fn code_at(
    seed: &str,
    epoch_ms: i64,
    hmac_sha1: impl FnOnce(&[u8], &[u8]) -> Vec<u8>,
) -> Option<Code> {
    let key = base32_decode(seed)?;
    let digest = hmac_sha1(&key, &counter_bytes(step_at(epoch_ms)));
    Some(Code {
        code: truncate(&digest)?,
        period: PERIOD_SECONDS,
        remaining: remaining_seconds(epoch_ms),
    })
}

/// Why what a member typed is not a one-time-code seed. Each is a sentence the
/// editor can say; none carries the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedRefusal {
    /// Neither base32 nor an `otpauth://totp/` URI with a base32 `secret`.
    NotASeed,
    /// An `otpauth://hotp/` URI: a counter-based code, which this phone does
    /// not keep a counter for.
    CounterBased,
    /// An `otpauth://` URI asking for something other than RFC 6238's
    /// default — SHA-1, six digits, thirty seconds. Codes computed with the
    /// default would be wrong codes, so the entry is refused rather than
    /// quietly mis-read.
    Unsupported,
}

impl SeedRefusal {
    /// The member's sentence.
    #[must_use]
    pub const fn sentence(self) -> &'static str {
        match self {
            Self::NotASeed => {
                "That is not a one-time-code setup key. Paste the key or the otpauth:// link the site showed."
            }
            Self::CounterBased => {
                "That link is for counter-based codes, which Locker does not make. Ask the site for a time-based code."
            }
            Self::Unsupported => {
                "That link asks for a code Locker does not make: only six digits every thirty seconds, with SHA-1."
            }
        }
    }
}

/// THE SEED A MEMBER ENTERED, READ ONCE AND STORED IN ONE SPELLING.
///
/// Accepts a bare base32 secret (spaces, `=` padding and `-` grouping ignored,
/// case folded — [`base32_decode`]'s union) or an `otpauth://totp/…?secret=…`
/// URI, whose `algorithm`, `digits` and `period` must be RFC 6238's defaults
/// when present. Answers the secret as upper-case base32 with no separators,
/// which is what is sealed; the label and the issuer in a URI are not kept —
/// the item already has a title.
///
/// # Errors
/// A [`SeedRefusal`] saying why; never the value.
pub fn seed_of(entry: &str) -> Result<String, SeedRefusal> {
    let entry = entry.trim();
    let secret = if entry.len() >= 10 && entry[..10].eq_ignore_ascii_case("otpauth://") {
        secret_of_uri(&entry[10..])?
    } else {
        entry.to_owned()
    };
    base32_decode(&secret).ok_or(SeedRefusal::NotASeed)?;
    Ok(secret
        .chars()
        .filter(|character| !(character.is_whitespace() || *character == '=' || *character == '-'))
        .map(|character| character.to_ascii_uppercase())
        .collect())
}

/// `totp/<label>?<query>` → the decoded `secret`, checking the parameters.
fn secret_of_uri(rest: &str) -> Result<String, SeedRefusal> {
    let (kind, after) = rest.split_once('/').ok_or(SeedRefusal::NotASeed)?;
    if kind.eq_ignore_ascii_case("hotp") {
        return Err(SeedRefusal::CounterBased);
    }
    if !kind.eq_ignore_ascii_case("totp") {
        return Err(SeedRefusal::NotASeed);
    }
    let query = after.split_once('?').map_or("", |(_, query)| query);
    let mut secret = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decoded(value).ok_or(SeedRefusal::NotASeed)?;
        match key.to_ascii_lowercase().as_str() {
            "secret" => secret = Some(value),
            "algorithm" if !value.eq_ignore_ascii_case("SHA1") => {
                return Err(SeedRefusal::Unsupported);
            }
            "digits" if value != DIGITS.to_string() => return Err(SeedRefusal::Unsupported),
            "period" if value != PERIOD_SECONDS.to_string() => {
                return Err(SeedRefusal::Unsupported);
            }
            _ => {}
        }
    }
    secret
        .filter(|secret| !secret.is_empty())
        .ok_or(SeedRefusal::NotASeed)
}

/// `%XX` decoding, and `None` for a malformed escape or a non-UTF-8 result.
fn percent_decoded(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = value.get(at + 1..at + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

// THE GROUPED SPELLING (`123 456`) is the item page's, drawn by the shared
// machine (`LockerItemMachine.codeRow`); v0's `grouped` here had no caller and
// is deleted (#1047 T2).

#[cfg(test)]
mod tests {
    use super::*;

    /// No HMAC-SHA-1 is available in this crate, so the vectors below use
    /// RFC 4226's published digests for the truncation and a *fixed* digest
    /// for the RFC 6238 shape. The real primitive is the core's, and
    /// `crates/core::locker::phone` proves the whole chain against RFC 6238
    /// Appendix B.
    #[test]
    fn base32_accepts_both_v0_spellings_and_refuses_a_non_seed() {
        // `JBSWY3DPEHPK3PXP` is the canonical `Hello!\xDE\xAD\xBE\xEF`.
        assert_eq!(
            base32_decode("JBSWY3DPEHPK3PXP"),
            Some(vec![
                0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef
            ])
        );
        // Whitespace, padding and hyphen grouping are all ignored, and the
        // three spellings decode to the same bytes.
        let plain = base32_decode("JBSWY3DPEHPK3PXP").expect("decodes");
        assert_eq!(base32_decode("jbswy3dp ehpk3pxp").as_ref(), Some(&plain));
        assert_eq!(base32_decode("JBSW-Y3DP-EHPK-3PXP").as_ref(), Some(&plain));
        assert_eq!(base32_decode("JBSWY3DPEHPK3PXP====").as_ref(), Some(&plain));
        // Not base32: `1`, `8`, `9` and `0` are not in the alphabet.
        assert_eq!(base32_decode("JBSWY3DP1"), None);
        assert_eq!(base32_decode(""), None);
        assert_eq!(base32_decode("   "), None);
        assert_eq!(base32_decode("===="), None);
    }

    /// THE DYNAMIC TRUNCATION, against RFC 4226's own worked example
    /// (appendix D): the HMAC-SHA-1 digest for counter 0 with the RFC's key
    /// truncates to `755224`.
    #[test]
    fn truncation_matches_rfc_4226s_worked_example() {
        let digest = [
            0xcc_u8, 0x93, 0xcf, 0x18, 0x50, 0x8d, 0x94, 0x93, 0x4c, 0x64, 0xb6, 0x5d, 0x8b, 0xa7,
            0x66, 0x7f, 0xb7, 0xcd, 0xe4, 0xb0,
        ];
        assert_eq!(truncate(&digest).as_deref(), Some("755224"));
        // Counter 1's digest from the same appendix → `287082`.
        let digest = [
            0x75_u8, 0xa4, 0x8a, 0x19, 0xd4, 0xcb, 0xe1, 0x00, 0x64, 0x4e, 0x8a, 0xc1, 0x39, 0x7e,
            0xea, 0x74, 0x7a, 0x2d, 0x33, 0xab,
        ];
        assert_eq!(truncate(&digest).as_deref(), Some("287082"));
        // Counter 2's digest from the same appendix → `359152`.
        let digest = [
            0x0b_u8, 0xac, 0xb7, 0xfa, 0x08, 0x2f, 0xef, 0x30, 0x78, 0x22, 0x11, 0x93, 0x8b, 0xc1,
            0xc5, 0xe7, 0x04, 0x16, 0xff, 0x44,
        ];
        assert_eq!(truncate(&digest).as_deref(), Some("359152"));
    }

    #[test]
    fn a_truncated_digest_is_refused_rather_than_panicking() {
        assert_eq!(truncate(&[]), None);
        // The offset nibble points past the end.
        assert_eq!(truncate(&[0x0f, 0x00, 0x0f]), None);
    }

    /// The step and the countdown, over the boundary where both change.
    #[test]
    fn the_step_and_the_countdown_agree_at_the_boundary() {
        assert_eq!(step_at(0), 0);
        assert_eq!(remaining_seconds(0), 30);
        assert_eq!(step_at(29_999), 0);
        assert_eq!(remaining_seconds(29_000), 1);
        assert_eq!(step_at(30_000), 1);
        assert_eq!(remaining_seconds(30_000), 30);
        // RFC 6238's own test time.
        assert_eq!(step_at(59_000), 1);
        // RFC 6238's own first test time, 1970-01-01T00:00:59Z, is step 1;
        // its second, 2005-03-18T01:58:29Z, is step 37,037,036.
        assert_eq!(step_at(1_111_111_109_000), 37_037_036);
    }

    #[test]
    fn the_counter_is_eight_bytes_big_endian() {
        assert_eq!(counter_bytes(1), [0, 0, 0, 0, 0, 0, 0, 1]);
        assert_eq!(
            counter_bytes(0x0102_0304_0506_0708),
            [1, 2, 3, 4, 5, 6, 7, 8]
        );
    }

    /// WHAT A MEMBER PASTES: a bare key in any of its spellings, or the
    /// `otpauth://` link a QR code carries — one stored spelling either way.
    #[test]
    fn a_seed_is_read_from_a_key_or_an_otpauth_link() {
        let canonical = Ok("JBSWY3DPEHPK3PXP".to_owned());
        assert_eq!(seed_of("JBSWY3DPEHPK3PXP"), canonical);
        assert_eq!(seed_of("  jbsw y3dp ehpk 3pxp  "), canonical);
        assert_eq!(seed_of("JBSW-Y3DP-EHPK-3PXP===="), canonical);
        assert_eq!(
            seed_of("otpauth://totp/Bank:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Bank"),
            canonical
        );
        assert_eq!(
            seed_of(
                "OTPAUTH://TOTP/Bank?issuer=Bank&secret=jbswy3dpehpk3pxp&algorithm=SHA1&digits=6&period=30"
            ),
            canonical
        );
        // Percent-encoded padding is still padding.
        assert_eq!(
            seed_of("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP%3D%3D"),
            canonical
        );
    }

    /// A link that asks for a different code is refused rather than
    /// mis-read, and a counter-based link says so.
    #[test]
    fn a_seed_that_would_make_wrong_codes_is_refused_with_its_reason() {
        assert_eq!(seed_of("not a seed!"), Err(SeedRefusal::NotASeed));
        assert_eq!(seed_of(""), Err(SeedRefusal::NotASeed));
        assert_eq!(
            seed_of("otpauth://totp/Bank?issuer=Bank"),
            Err(SeedRefusal::NotASeed)
        );
        assert_eq!(
            seed_of("otpauth://totp/Bank?secret=%ZZ"),
            Err(SeedRefusal::NotASeed)
        );
        assert_eq!(
            seed_of("otpauth://hotp/Bank?secret=JBSWY3DPEHPK3PXP&counter=1"),
            Err(SeedRefusal::CounterBased)
        );
        for asks in ["algorithm=SHA512", "digits=8", "period=60"] {
            assert_eq!(
                seed_of(&format!(
                    "otpauth://totp/Bank?secret=JBSWY3DPEHPK3PXP&{asks}"
                )),
                Err(SeedRefusal::Unsupported),
                "{asks}"
            );
        }
        // No sentence carries the value it refused.
        for refusal in [
            SeedRefusal::NotASeed,
            SeedRefusal::CounterBased,
            SeedRefusal::Unsupported,
        ] {
            assert!(!refusal.sentence().contains("JBSW"));
        }
    }

    #[test]
    fn code_at_refuses_a_seed_that_is_not_base32() {
        assert_eq!(code_at("not a seed!", 0, |_, _| vec![0; 20]), None);
    }

    #[test]
    fn code_at_threads_the_counter_through_the_injected_hmac() {
        let code = code_at("JBSWY3DPEHPK3PXP", 59_000, |key, message| {
            assert_eq!(key.len(), 10);
            assert_eq!(message, [0, 0, 0, 0, 0, 0, 0, 1]);
            vec![
                0x75, 0xa4, 0x8a, 0x19, 0xd4, 0xcb, 0xe1, 0x00, 0x64, 0x4e, 0x8a, 0xc1, 0x39, 0x7e,
                0xea, 0x74, 0x7a, 0x2d, 0x33, 0xab,
            ]
        })
        .expect("a code");
        assert_eq!(code.code, "287082");
        assert_eq!(code.period, 30);
        assert_eq!(code.remaining, 1);
    }
}
