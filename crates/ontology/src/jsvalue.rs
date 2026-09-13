//! The digest's value encoding, which is a JAVASCRIPT fact.
//!
//! v0 froze the golden corpus with `packages/vault/src/golden-snapshot.ts`,
//! whose per-value contribution is
//!
//! ```text
//! value === null ? "\0null" : `${typeof value}:${String(value)}`
//! ```
//!
//! Both halves are JS semantics over what `node:sqlite` hands back, so a Rust
//! port that wants the SAME 16 hex characters has to reproduce them exactly
//! rather than pick its own spelling:
//!
//! | SQLite storage class | `typeof` | `String(value)` |
//! | --- | --- | --- |
//! | NULL | — | the whole contribution is `"\0null"` |
//! | INTEGER | `number` | `Number.prototype.toString`, so `5` not `5.0` |
//! | REAL | `number` | the same — `1.0` prints as `"1"` |
//! | TEXT | `string` | the text itself |
//! | BLOB | `object` | a `Uint8Array`, whose `toString` joins the bytes with `,` |
//!
//! INTEGER and REAL are ONE case, because `node:sqlite` returns both as JS
//! numbers: a digest cannot tell `1` from `1.0`, and the type prefix that makes
//! the affinity part of the digest says `number` for both.
//!
//! The #929 corpus exercises only TEXT, NULL and integral numbers (43 numeric
//! cells, none fractional, none outside the 2^53 safe range, and no BLOB cell
//! at all — see the receipt). So the fractional and exponential branches of
//! [`js_number_to_string`] and the BLOB branch of [`encode_value`] are held by
//! hand-written tables of real JS output in this module's tests, not by the
//! corpus.

use rusqlite::types::ValueRef;

/// The largest integer a JS number represents exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// `String(value)` for a JS number, per ECMAScript `Number::toString`.
///
/// Rust's own `{}` never uses exponent notation and JS does past `1e21`, so the
/// two disagree on real values at both ends of the range. `{:e}` gives the
/// SHORTEST round-tripping digits and a decimal exponent, which is exactly the
/// `(s, k, n)` triple the spec's step 5 is written in terms of: with mantissa
/// `d1.d2…dk × 10^e`, the digits are `s`, their count is `k`, and `n = e + 1`.
pub fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value.is_sign_positive() {
            "Infinity".to_owned()
        } else {
            "-Infinity".to_owned()
        };
    }
    // `String(-0)` is "0": the sign of zero is not part of the decimal form.
    if value == 0.0 {
        return "0".to_owned();
    }

    let sign = if value < 0.0 { "-" } else { "" };
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("Rust's LowerExp for f64 always emits an exponent");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = i64::try_from(digits.len()).expect("a shortest-round-trip mantissa is under 20 digits");
    let n = exponent
        .parse::<i64>()
        .expect("Rust's LowerExp for f64 emits a decimal exponent")
        + 1;

    let body = if k <= n && n <= 21 {
        // Every digit, then n-k zeros: 1e2 -> "100".
        let zeros = usize::try_from(n - k).expect("n - k is non-negative here");
        format!("{digits}{}", "0".repeat(zeros))
    } else if 0 < n && n <= 21 {
        // A decimal point after n digits: 1.5e0 -> "1.5".
        let split = usize::try_from(n).expect("n is positive here");
        format!("{}.{}", &digits[..split], &digits[split..])
    } else if -6 < n && n <= 0 {
        // "0.", then -n zeros, then the digits: 1e-3 -> "0.001".
        let zeros = usize::try_from(-n).expect("-n is non-negative here");
        format!("0.{}{digits}", "0".repeat(zeros))
    } else {
        // Exponential, with an explicit sign on the exponent as JS writes it.
        let e = n - 1;
        let esign = if e > 0 { "+" } else { "-" };
        let magnitude = e.abs();
        if k == 1 {
            format!("{digits}e{esign}{magnitude}")
        } else {
            format!("{}.{}e{esign}{magnitude}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// `String(value)` for what `node:sqlite` hands back for a BLOB: a
/// `Uint8Array`, whose `toString` is `Array.prototype.join(",")` over the
/// bytes. An empty blob is therefore the empty string.
fn js_bytes_to_string(bytes: &[u8]) -> String {
    let mut out = String::new();
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&byte.to_string());
    }
    out
}

/// One cell's contribution to a row digest, byte for byte as v0 wrote it.
///
/// The `"\0"` separator the TypeScript appends after every value is the
/// caller's job (see `snapshot::digest_values`), so this function returns only
/// the value part.
pub fn encode_value(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "\0null".to_owned(),
        ValueRef::Integer(int) => {
            // A JS number is a double. Inside the safe range the integer's own
            // decimal form and the double's agree, and outside it the double is
            // what `node:sqlite` would have handed the freezer, so the f64 path
            // is the faithful one in both cases.
            if int.abs() <= MAX_SAFE_INTEGER {
                format!("number:{int}")
            } else {
                #[expect(
                    clippy::cast_precision_loss,
                    reason = "the precision loss IS the JS behaviour being reproduced"
                )]
                let as_double = int as f64;
                format!("number:{}", js_number_to_string(as_double))
            }
        }
        ValueRef::Real(real) => format!("number:{}", js_number_to_string(real)),
        ValueRef::Text(text) => format!("string:{}", String::from_utf8_lossy(text)),
        ValueRef::Blob(bytes) => format!("object:{}", js_bytes_to_string(bytes)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every expectation below is what `String(x)` prints in a JS engine. The
    /// corpus has no fractional or out-of-range numeric cell, so this table is
    /// the only thing holding the formatter to Node's output; extend it rather
    /// than loosening a comparison if a future corpus disagrees.
    #[test]
    fn js_number_formatting_matches_javascript() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.0, "-1"),
            (5.0, "5"),
            (100.0, "100"),
            (1.5, "1.5"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (0.5, "0.5"),
            (1.0 / 3.0, "0.3333333333333333"),
            (0.000_001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e-21, "1e-21"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e22, "1.5e+22"),
            (1e-6, "0.000001"),
            (123_456_789.123, "123456789.123"),
            (9_007_199_254_740_992.0, "9007199254740992"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (f64::NAN, "NaN"),
        ];
        let findings: Vec<String> = cases
            .iter()
            .filter_map(|&(value, expected)| {
                let actual = js_number_to_string(value);
                (actual != expected)
                    .then(|| format!("{value:?}: got {actual}, JS prints {expected}"))
            })
            .collect();
        assert_eq!(findings.join("\n"), "");
    }

    #[test]
    fn a_real_and_an_integer_of_the_same_value_digest_alike() {
        // `node:sqlite` hands both back as the JS number 1, so the digest
        // cannot tell them apart and neither may this port.
        assert_eq!(
            encode_value(ValueRef::Integer(1)),
            encode_value(ValueRef::Real(1.0))
        );
    }

    #[test]
    fn blob_encoding_is_uint8array_tostring() {
        // `String(new Uint8Array([1, 2, 255]))` is "1,2,255"; the empty array
        // stringifies to "".
        assert_eq!(encode_value(ValueRef::Blob(&[1, 2, 255])), "object:1,2,255");
        assert_eq!(encode_value(ValueRef::Blob(&[])), "object:");
    }

    #[test]
    fn text_and_null_encodings() {
        assert_eq!(encode_value(ValueRef::Text(b"hi")), "string:hi");
        assert_eq!(encode_value(ValueRef::Null), "\0null");
    }
}
