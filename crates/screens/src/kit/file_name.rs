//! A FILE'S NAME AS A TITLE OR A LABEL (#1202): the member's words, made safe to show and to file.
//!
//! A platform hands over whatever name the file carries, and the name travels three ways: as a
//! document's title, as the `arrived_label` an origin keeps, and onto a status line. Three things
//! about a name are not the member's to spoof or to break:
//!
//! - **What is drawn.** A name with a right-to-left override (`invoice\u{202E}gpj.exe` reads as
//!   `invoiceexe.jpg`), a newline or any other control or invisible formatting character would be
//!   shown as the title in lists. They are dropped, and whitespace is collapsed to one space.
//! - **How long it is.** `document.add` caps `arrived_label` at 200 characters, and a refused write
//!   is retried with the identical request, so a name of 201 to 255 characters could never be
//!   filed. A longer name is cut to [`MAX_CHARS`], and a short extension is kept (`….pdf`), since
//!   it is the part that says what the file is.
//! - **Where it is cut.** Never inside a character a reader sees as one: a combining mark, a
//!   variation selector, an emoji modifier or a joined sequence stays with the character before it.
//!   (A full grapheme segmenter is a dependency this crate does not carry; these are the extenders
//!   a file name realistically holds.)

/// The longest label or title kept, in characters: `arrived_label`'s `maxLength`.
pub const MAX_CHARS: usize = 200;

/// The longest extension worth keeping when a name is cut: `.jpeg`, `.numbers`, `.mobileconfig`.
const MAX_EXTENSION_CHARS: usize = 12;

/// The name cleaned and fitted, or nothing when no visible character is left.
#[must_use]
pub fn label_of(name: &str) -> Option<String> {
    let clean = clean(name);
    (!clean.is_empty()).then(|| fit(&clean, MAX_CHARS))
}

/// The name without control and invisible formatting characters, whitespace collapsed and trimmed.
#[must_use]
pub fn clean(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut gap = false;
    for c in name.chars() {
        if c.is_control() || c.is_whitespace() {
            gap = !out.is_empty();
        } else if !is_invisible(c) {
            if gap {
                out.push(' ');
                gap = false;
            }
            out.push(c);
        }
    }
    out
}

/// Characters that draw nothing but change how the text around them is drawn or read: the bidi
/// controls, the zero-width and word-joining characters, the byte order mark and the like. The
/// zero-width joiner and non-joiner stay: scripts and emoji sequences are spelled with them.
fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}' | '\u{200E}' | '\u{200F}'
        | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}'
        | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}')
}

/// A character that belongs to the one before it.
fn extends(c: char) -> bool {
    matches!(c,
        '\u{0300}'..='\u{036F}' | '\u{1AB0}'..='\u{1AFF}' | '\u{1DC0}'..='\u{1DFF}'
        | '\u{20D0}'..='\u{20FF}' | '\u{FE00}'..='\u{FE0F}' | '\u{FE20}'..='\u{FE2F}'
        | '\u{200C}' | '\u{200D}' | '\u{1F3FB}'..='\u{1F3FF}' | '\u{E0020}'..='\u{E007F}'
        | '\u{E0100}'..='\u{E01EF}')
}

/// `text` cut to at most `max` characters, on a boundary: what is cut is never a part of the last
/// character kept.
fn cut(text: &str, max: usize) -> &str {
    let mut ends: Vec<usize> = text.char_indices().map(|(at, _)| at).collect();
    ends.push(text.len());
    let chars = ends.len() - 1;
    if chars <= max {
        return text;
    }
    let mut keep = max;
    // Step back while the character cut off would hang on the one kept, or the one kept is a
    // joiner with nothing after it.
    while keep > 0 {
        let next = text[ends[keep]..].chars().next();
        let last = text[ends[keep - 1]..ends[keep]].chars().next();
        if next.is_some_and(extends) || last == Some('\u{200D}') {
            keep -= 1;
        } else {
            break;
        }
    }
    &text[..ends[keep]]
}

/// `name` fitted to `max` characters: cut on a boundary, with an ellipsis, keeping a short
/// extension.
#[must_use]
pub fn fit(name: &str, max: usize) -> String {
    if name.chars().count() <= max {
        return name.to_owned();
    }
    if let Some((stem, extension)) = name.rsplit_once('.')
        && !stem.is_empty()
        && (1..=MAX_EXTENSION_CHARS).contains(&extension.chars().count())
        && extension.chars().all(char::is_alphanumeric)
    {
        // The ellipsis and the dot are two of the characters.
        let room = max.saturating_sub(extension.chars().count() + 2);
        if room > 0 {
            return format!("{}….{extension}", cut(stem, room).trim_end());
        }
    }
    let room = max.saturating_sub(1);
    format!("{}…", cut(name, room).trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_that_fits_is_kept_as_it_is() {
        assert_eq!(
            label_of(" Lease 2026.pdf ").as_deref(),
            Some("Lease 2026.pdf")
        );
        assert_eq!(label_of("  \n\t "), None);
        assert_eq!(label_of(""), None);
    }

    #[test]
    fn a_right_to_left_override_cannot_spoof_the_name() {
        assert_eq!(
            label_of("invoice\u{202E}gpj.exe").as_deref(),
            Some("invoicegpj.exe"),
            "the override is dropped, so the name reads as it is spelled"
        );
        assert_eq!(
            label_of("a\u{2066}b\u{2069}c\u{200E}\u{FEFF}d").as_deref(),
            Some("abcd")
        );
    }

    #[test]
    fn controls_and_newlines_become_one_space() {
        assert_eq!(
            label_of("Taxes\n2026\r\n\u{0007}final\t.pdf").as_deref(),
            Some("Taxes 2026 final .pdf")
        );
    }

    #[test]
    fn a_joiner_that_spells_a_character_stays() {
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}.png";
        assert_eq!(label_of(family).as_deref(), Some(family));
    }

    #[test]
    fn a_long_name_fits_the_limit_and_keeps_its_extension() {
        let name = format!("{}.pdf", "a".repeat(240));
        let label = label_of(&name).expect("a label");
        assert_eq!(label.chars().count(), MAX_CHARS);
        assert!(label.ends_with("….pdf"), "{label}");
    }

    #[test]
    fn a_long_name_with_no_extension_is_cut_with_an_ellipsis() {
        let label = label_of(&"b".repeat(255)).expect("a label");
        assert_eq!(label.chars().count(), MAX_CHARS);
        assert!(label.ends_with('…'));
    }

    #[test]
    fn a_cut_never_lands_inside_a_character_a_reader_sees_as_one() {
        // 'e' with a combining acute, 199 times over: a cut at 199 characters would leave a
        // dangling mark on the next one, so the whole pair goes.
        let name = "e\u{0301}".repeat(150);
        let label = fit(&name, 100);
        assert!(label.chars().count() <= 100);
        let body = label.trim_end_matches('…');
        assert!(
            body.chars().filter(|c| *c == 'e').count()
                == body.chars().filter(|c| *c == '\u{0301}').count()
        );
        assert!(!body.ends_with('e') || body.ends_with("e\u{0301}"));

        // A family emoji is one character: it is kept whole or not at all.
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        let name = format!("{}{family}{}", "x".repeat(97), "y".repeat(40));
        let label = fit(&name, 99 + 1);
        assert!(
            !label.contains('\u{1F468}') || label.contains(family),
            "{label}"
        );
        assert!(!label.ends_with('\u{200D}'));
    }

    #[test]
    fn the_cut_name_is_always_valid_utf8_and_within_the_limit() {
        for width in 1..30 {
            let name = format!("{}.txt", "é𝒳".repeat(width));
            let label = fit(&name, 10);
            assert!(label.chars().count() <= 10, "{label}");
        }
    }
}
