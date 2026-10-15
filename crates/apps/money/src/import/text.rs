//! Bytes to text: UTF-8, with a byte-order mark dropped; anything that is not
//! UTF-8 is windows-1252.

/// windows-1252 for 0x80..=0x9F; 0x81, 0x8D, 0x8F, 0x90 and 0x9D are undefined
/// and map to the C1 control of the same value, as browsers read them.
const CP1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{81}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{8D}', '\u{017D}', '\u{8F}',
    '\u{90}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{9D}', '\u{017E}', '\u{0178}',
];

/// Which decoder read the bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Windows1252,
}

/// Decodes `bytes`: UTF-8 (BOM dropped) when valid, else windows-1252.
#[must_use]
pub fn decode(bytes: &[u8]) -> (String, Encoding) {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_owned(), Encoding::Utf8),
        Err(_) => (decode_windows_1252(bytes), Encoding::Windows1252),
    }
}

/// windows-1252, byte for byte.
#[must_use]
pub fn decode_windows_1252(bytes: &[u8]) -> String {
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
    fn a_bom_is_dropped_and_utf8_is_kept() {
        let (text, encoding) = decode(b"\xEF\xBB\xBFCaf\xC3\xA9");
        assert_eq!((text.as_str(), encoding), ("Café", Encoding::Utf8));
    }

    #[test]
    fn windows_1252_reads_accents_and_the_euro_and_smart_quotes() {
        let (text, encoding) = decode(b"Caf\xE9 \x80 \x93x\x94");
        assert_eq!(encoding, Encoding::Windows1252);
        assert_eq!(text, "Café € \u{201C}x\u{201D}");
    }
}
