//! A LIST ROW'S PREVIEW AND CHECKLIST TALLY — never the whole body (#404).
//!
//! v0 inlines these two derivations into `library.ts`, `search.ts` and
//! `journal.ts` because "a query handler is a standalone module" and the
//! blueprint dispatcher resolves one file per query. The port has no such
//! constraint, so it has ONE copy: three copies of a regular expression is how
//! the shelf and the search results start disagreeing about what a note says.
//!
//! ## The body, out of the row that holds it
//!
//! `note-body.ts:1`-`:28` is a bug report as much as a module. A canonical note
//! body is an inline `data:` URI; six places decoded one and four called `atob`
//! bare — and `atob` yields BYTES, so reading them as characters mangles every
//! multi-byte one. *"An em dash in a note came back as two mojibake glyphs on
//! the library shelf and correctly in the editor, from the same row."*
//! [`decode_note_body`] decodes UTF-8 properly, and keeps v0's own two
//! sentences apart:
//!
//! * `(external content)` — not a `data:` URI at all. It lives somewhere this
//!   list cannot follow, and **nothing is wrong**.
//! * `(unreadable content)` — it IS inline and the decode failed. A row that
//!   should have had words does not, and saying "external" would hide a defect
//!   behind a normal-sounding phrase.
//!
//! Only Notes' `history` query drew that line before #883 B4; the other four
//! said "external" for both. The line is kept, because it is the honest one.

/// Not a `data:` URI. Nothing is wrong.
pub const EXTERNAL_CONTENT: &str = "(external content)";
/// An inline body whose decode failed. Something IS wrong.
pub const UNREADABLE_CONTENT: &str = "(unreadable content)";

/// How many lines of a body reach a list row (`library.ts:80`).
pub const PREVIEW_LINES: usize = 6;
/// How many characters of those lines reach it (`library.ts:96`).
pub const PREVIEW_CHARS: usize = 200;

/// A note's words, out of the content row's URI.
///
/// `None` on the input means an absent content row, which is `(external
/// content)` — v0 passes `undefined` through `String(uri ?? "")` and lands on
/// the same sentence.
#[must_use]
pub fn decode_note_body(uri: Option<&str>) -> String {
    let Some(uri) = uri else {
        return EXTERNAL_CONTENT.to_owned();
    };
    if !uri.starts_with("data:") {
        return EXTERNAL_CONTENT.to_owned();
    }
    decode_data_uri(uri).unwrap_or_else(|| UNREADABLE_CONTENT.to_owned())
}

/// `_shared/format-kit.ts`'s ruled decoder, ported.
fn decode_data_uri(uri: &str) -> Option<String> {
    let comma = uri.find(',')?;
    let meta = &uri[..comma];
    let payload = &uri[comma + 1..];
    if meta.contains(";base64") {
        String::from_utf8(base64_decode(payload)?).ok()
    } else {
        percent_decode_utf8(payload)
    }
}

fn base64_decode(payload: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in payload.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let value = ALPHABET.iter().position(|candidate| *candidate == byte)?;
        buffer = (buffer << 6) | u32::try_from(value).ok()?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((buffer >> bits) & 0xff).ok()?);
        }
    }
    Some(out)
}

/// `decodeURIComponent`, which is percent-decoding over UTF-8 bytes. A
/// percent-escape that is not valid UTF-8 is a FAILED decode, not a lossy one —
/// `String::from_utf8_lossy` would invent a replacement character and call it
/// the member's note.
fn percent_decode_utf8(payload: &str) -> Option<String> {
    let bytes = payload.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = payload.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A checklist line, as the preview renders it and the tally counts it.
///
/// v0's regular expression is `/^\s*[-*] \[(?<mark> |x|X)\]\s?(?<text>.*)$/u`:
/// leading whitespace, a `-` or `*`, **one** space, a bracketed mark, then at
/// most one space before the text. The single spaces are load-bearing — `- [x]`
/// with two spaces after the bracket keeps the second one in the text, which is
/// what the shelf shows.
struct Checkline<'line> {
    done: bool,
    text: &'line str,
}

fn check_line(line: &str) -> Option<Checkline<'_>> {
    let rest = line.trim_start_matches([' ', '\t', '\r', '\u{000b}', '\u{000c}']);
    let rest = rest.strip_prefix('-').or_else(|| rest.strip_prefix('*'))?;
    let rest = rest.strip_prefix(' ')?;
    let rest = rest.strip_prefix('[')?;
    let mut characters = rest.chars();
    let mark = characters.next()?;
    if !matches!(mark, ' ' | 'x' | 'X') {
        return None;
    }
    let rest = characters.as_str().strip_prefix(']')?;
    let text = rest.strip_prefix(' ').unwrap_or(rest);
    Some(Checkline {
        done: mark == 'x' || mark == 'X',
        text,
    })
}

/// A list item that is not a checklist line: `- `, `* ` or `1. `.
fn list_item(line: &str) -> Option<&str> {
    let rest = line.trim_start_matches([' ', '\t', '\r', '\u{000b}', '\u{000c}']);
    if let Some(text) = rest.strip_prefix("- ").or_else(|| rest.strip_prefix("* ")) {
        return Some(text);
    }
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    rest.get(digits.len()..)?.strip_prefix(". ")
}

/// A heading, `#` to `###`, followed by whitespace. Headings DROP from a
/// preview — the title already carries them.
fn is_heading(line: &str) -> bool {
    let hashes = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    (1..=3).contains(&hashes) && line.chars().nth(hashes).is_some_and(char::is_whitespace)
}

/// The six-line, 200-character preview a list row carries.
///
/// Checklist lines keep their box (`☐`/`☑`), list items become bullets,
/// headings drop, blank lines drop, and the bold/italic/code markers are
/// stripped so a shelf does not show asterisks.
#[must_use]
pub fn preview_of(body: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in body.split('\n') {
        if lines.len() >= PREVIEW_LINES {
            break;
        }
        if let Some(check) = check_line(line) {
            lines.push(format!(
                "{} {}",
                if check.done { '☑' } else { '☐' },
                check.text
            ));
            continue;
        }
        if is_heading(line) {
            continue;
        }
        if let Some(text) = list_item(line) {
            lines.push(format!("• {text}"));
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        lines.push(line.to_owned());
    }
    let text = strip_inline_marks(&lines.join("\n"));
    // **CHARACTERS, NOT BYTES.** v0 slices a JS string, whose unit is a UTF-16
    // code unit; a byte slice here would split a multi-byte character and panic
    // — on exactly the em dash `note-body.ts` was written about.
    text.chars().take(PREVIEW_CHARS).collect()
}

/// `**bold**`, `*italic*` and `` `code` `` lose their markers.
///
/// v0's three `replaceAll`s over lazy groups, in order and with the same
/// non-empty-inner rule: `**` around nothing is not bold, so `****` survives
/// verbatim.
fn strip_inline_marks(text: &str) -> String {
    let once = strip_paired(text, "**");
    let twice = strip_paired(&once, "*");
    strip_paired(&twice, "`")
}

fn strip_paired(text: &str, marker: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find(marker) {
        let after = &rest[open + marker.len()..];
        // Lazy: the first close after at least one character.
        let inner_end = after
            .char_indices()
            .skip(1)
            .find_map(|(index, _)| after[index..].starts_with(marker).then_some(index));
        let Some(inner_end) = inner_end else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..open]);
        out.push_str(&after[..inner_end]);
        rest = &after[inner_end + marker.len()..];
    }
    out.push_str(rest);
    out
}

/// How many checklist lines a body has, and how many are done.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
pub struct CheckTally {
    pub total: usize,
    pub done: usize,
}

/// The checklist tally of a body.
#[must_use]
pub fn check_of(body: &str) -> CheckTally {
    let mut tally = CheckTally::default();
    for line in body.split('\n') {
        if let Some(check) = check_line(line) {
            tally.total += 1;
            if check.done {
                tally.done += 1;
            }
        }
    }
    tally
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_or_non_data_uri_is_external_and_a_broken_one_is_unreadable() {
        assert_eq!(decode_note_body(None), EXTERNAL_CONTENT);
        assert_eq!(decode_note_body(Some("blob:sha256/aa")), EXTERNAL_CONTENT);
        assert_eq!(
            decode_note_body(Some("data:text/plain")),
            UNREADABLE_CONTENT
        );
        assert_eq!(
            decode_note_body(Some("data:text/plain;base64,!!!!")),
            UNREADABLE_CONTENT
        );
    }

    /// THE BUG `note-body.ts` WAS WRITTEN ABOUT: bytes read as characters
    /// mangle every multi-byte one.
    #[test]
    fn a_multi_byte_character_survives_both_encodings() {
        let percent = "data:text/markdown;charset=utf-8,Rent%20%E2%80%94%20due";
        assert_eq!(decode_note_body(Some(percent)), "Rent — due");
        let base64 = "data:text/markdown;base64,UmVudCDigJQgZHVl";
        assert_eq!(decode_note_body(Some(base64)), "Rent — due");
    }

    #[test]
    fn a_percent_escape_that_is_not_utf8_is_unreadable_rather_than_lossy() {
        // `%80` alone is a continuation byte with no lead. v0's
        // `decodeURIComponent` throws here and the catch answers null.
        assert_eq!(
            decode_note_body(Some("data:text/plain,%80")),
            UNREADABLE_CONTENT
        );
    }

    #[test]
    fn a_preview_is_six_lines_of_two_hundred_characters() {
        let body = (0..20)
            .map(|index| format!("line {index}"))
            .collect::<Vec<String>>()
            .join("\n");
        let preview = preview_of(&body);
        assert_eq!(preview.split('\n').count(), PREVIEW_LINES);
        let long = "x".repeat(500);
        assert_eq!(preview_of(&long).chars().count(), PREVIEW_CHARS);
    }

    /// The slice is over CHARACTERS. A byte slice would panic here.
    #[test]
    fn a_preview_over_the_ceiling_does_not_split_a_character() {
        let body = "—".repeat(400);
        let preview = preview_of(&body);
        assert_eq!(preview.chars().count(), PREVIEW_CHARS);
        assert!(preview.chars().all(|character| character == '—'));
    }

    #[test]
    fn headings_drop_lists_become_bullets_and_checklists_keep_their_box() {
        let body = "## Stays\n- South Lake\n- [ ] Book it\n- [x] Pay deposit\n\n1. Pack";
        assert_eq!(
            preview_of(body),
            "• South Lake\n☐ Book it\n☑ Pay deposit\n• Pack"
        );
    }

    #[test]
    fn the_tally_counts_every_checklist_line_and_the_done_ones() {
        let body = "- [ ] a\n- [x] b\n- [X] c\n- not a check\n  - [ ] indented";
        assert_eq!(check_of(body), CheckTally { total: 4, done: 2 });
        assert_eq!(check_of("no checklist here"), CheckTally::default());
    }

    /// The three `replaceAll`s, IN ORDER, over lazy groups.
    ///
    /// `****` is the case that pins the order: `**` around nothing is not bold,
    /// so the first pass leaves it alone — and the SECOND pass then reads
    /// `*`,`*`,`*` as an italic and answers `**`. Checked against v0's own
    /// regular expressions rather than reasoned about.
    #[test]
    fn inline_markers_are_stripped_in_v0s_own_order() {
        assert_eq!(
            preview_of("**Do not** skip the *coffee*"),
            "Do not skip the coffee"
        );
        assert_eq!(preview_of("run `bun test`"), "run bun test");
        assert_eq!(preview_of("****"), "**");
        assert_eq!(preview_of("**a**b*c*"), "abc");
        assert_eq!(preview_of("*a**b*"), "ab");
    }

    /// A checklist mark that is not one of the three is not a checklist line —
    /// `- [o]` is a list item whose text is `[o] maybe`.
    #[test]
    fn an_unknown_mark_is_not_a_checklist_line() {
        assert_eq!(check_of("- [o] maybe"), CheckTally::default());
        assert_eq!(preview_of("- [o] maybe"), "• [o] maybe");
    }
}
