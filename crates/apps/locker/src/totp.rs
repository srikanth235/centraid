//! TOTP — RFC 6238, split so the hash is not in an app crate (D-1020-L6).
//!
//! v0 computes this twice: once in the vault command `locker.totp_code`
//! (`createHmac("sha1", …)`, `packages/vault/src/commands/locker.ts`) and once
//! in the app for the live countdown (`crypto.subtle`,
//! `packages/blueprints/apps/locker/totp.ts`). Both unseal the seed and emit
//! six digits; neither logs the seed or the code.
//!
//! After wave 4 the gateway cannot unseal, so the command's half moves to the
//! seat. What stays here is everything about RFC 6238 **except the HMAC**:
//! base32, the counter, the dynamic truncation and the remaining-seconds
//! arithmetic. A hash in an app crate is a hash whose collision behaviour
//! nobody owns (this crate's own rule), so the primitive is injected —
//! `crates/seat::locker` passes HMAC-SHA-1 — and the part ports actually get
//! wrong is the part that is under test here, against RFC 6238's own published
//! vectors.
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
pub const PERIOD_SECONDS: u64 = 30;

/// Six digits.
pub const DIGITS: u32 = 6;

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
pub fn step_at(epoch_ms: i64) -> u64 {
    let seconds = epoch_ms.div_euclid(1_000).max(0);
    u64::try_from(seconds).unwrap_or(0) / PERIOD_SECONDS
}

/// The eight bytes a step is HMAC'd as.
#[must_use]
pub fn counter_bytes(step: u64) -> [u8; 8] {
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
pub fn truncate(digest: &[u8]) -> Option<String> {
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
pub fn remaining_seconds(epoch_ms: i64) -> u64 {
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

/// The app's grouped spelling: `123 456`, as the pane shows it.
///
/// Kept apart from [`Code::code`] because the **command's** output is six
/// digits and the **pane's** is six digits with a space, and v0 has both — the
/// app's `computeTotp` returns `code.slice(0,3) + " " + code.slice(3)`. A port
/// that grouped in the command would change a command's output shape.
#[must_use]
pub fn grouped(code: &str) -> String {
    if code.len() != DIGITS as usize {
        return code.to_owned();
    }
    format!("{} {}", &code[..3], &code[3..])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231's HMAC-SHA-1 is not available here, so the vectors below use a
    /// digest the test computes itself for the truncation, and a *fixed*
    /// digest for the RFC 6238 shape. The real primitive is wired and tested in
    /// `crates/seat::locker`.
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

    #[test]
    fn the_pane_groups_and_the_command_does_not() {
        assert_eq!(grouped("123456"), "123 456");
        assert_eq!(grouped("012345"), "012 345");
        // Anything that is not six digits passes through rather than being
        // sliced into nonsense.
        assert_eq!(grouped("12345"), "12345");
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
