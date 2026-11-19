//! BYTES A MEMBER'S FILE HOLDS, READ AS TEXT (#1202): UTF-8 when it is, else windows-1252.
//!
//! A vCard from an old phone, a Markdown note from a Windows editor: both are often Latin-1 or
//! windows-1252, and reading them lossily turns every accent into U+FFFD. Money's importer reads
//! its statements the same way (`centraid_apps_money::import::text`); this is the shared rule for
//! the files that reach the vault as text.

/// windows-1252 for 0x80..=0x9F; 0x81, 0x8D, 0x8F, 0x90 and 0x9D are undefined and map to the C1
/// control of the same value, as browsers read them.
const CP1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{81}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{8D}', '\u{017D}', '\u{8F}',
    '\u{90}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{9D}', '\u{017E}', '\u{0178}',
];

/// `bytes` as text: UTF-8 (a byte-order mark dropped) when valid, else windows-1252 byte for byte.
#[must_use]
pub fn text_of(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => windows_1252(bytes),
    }
}

/// `bytes` read as the named charset (a vCard's `CHARSET=` parameter, any case): the Latin-1
/// family as windows-1252, and anything else, UTF-8 included, as [`text_of`] reads it, so a name
/// that is not valid in the charset it claims is still readable.
#[must_use]
pub fn text_in(bytes: &[u8], charset: Option<&str>) -> String {
    let charset = charset.map(|name| name.trim().trim_matches('"').to_ascii_lowercase());
    match charset.as_deref() {
        Some(
            "iso-8859-1" | "iso8859-1" | "latin1" | "latin-1" | "windows-1252" | "cp1252"
            | "us-ascii",
        ) => windows_1252(bytes),
        _ => text_of(bytes),
    }
}

/// windows-1252, byte for byte.
#[must_use]
pub fn windows_1252(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&byte| match byte {
            0x80..=0x9F => CP1252_HIGH[usize::from(byte - 0x80)],
            other => char::from(other),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_is_kept_and_anything_else_is_windows_1252() {
        assert_eq!(text_of(b"\xEF\xBB\xBFCaf\xC3\xA9"), "Café");
        assert_eq!(
            text_of(b"Caf\xE9 \x80 \x93x\x94"),
            "Café € \u{201C}x\u{201D}"
        );
    }

    #[test]
    fn a_named_latin_charset_is_read_as_such_and_others_fall_back() {
        assert_eq!(text_in(b"\xC9milie", Some("ISO-8859-1")), "Émilie");
        assert_eq!(text_in(b"\xC3\x89milie", Some("utf-8")), "Émilie");
        assert_eq!(
            text_in(b"\xC9milie", Some("utf-8")),
            "Émilie",
            "invalid UTF-8 falls back"
        );
        assert_eq!(text_in(b"\xC3\x89milie", None), "Émilie");
    }
}
