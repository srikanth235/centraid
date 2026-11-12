//! NOTES THAT LEAVE AND ENTER AS MARKDOWN (#1173, item 14): the parse of a Markdown or
//! text file, the Obsidian dialect included, and the archive an export writes.
//!
//! Pure functions. The commands that use them (`note.import`, `note.export`) own what
//! reaches the vault.
//!
//! - **A file is a note.** Its title is its file name without the extension (an Obsidian
//!   vault's convention) unless front matter says `title:`; its folder, if it had one
//!   below the picked root, is its notebook (the top folder only); its words are the file
//!   without the front matter.
//! - **`[[links]]` become links.** The note command already compiles `[[Title]]` into a
//!   `links` edge; the parse only has to normalise Obsidian's `[[Title|alias]]` and
//!   `[[Title#Heading]]` to `[[Title]]`, because the vault resolves a title and nothing
//!   narrower.
//! - **`#tags` become tags.** An inline `#tag` outside code (not a heading: a `#` followed
//!   by a space is one), and front matter `tags:` in any of its three spellings. The
//!   `#tag` stays in the words, as Obsidian keeps it.
//! - **Export keeps `[[…]]` as written** and writes one `.md` file per note into a stored
//!   (uncompressed) archive, in a folder per notebook, so a vault round-trips.

use std::collections::BTreeSet;

use crate::portable::zip::ZipWriter;

/// One file as the shell read it: a path relative to the picked folder (or just a name)
/// and its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFile {
    pub path: String,
    pub text: String,
}

/// A file read as a note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub notebook: Option<String>,
}

const EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];
/// The longest a tag label may be (the vault's own ceiling for a label).
const TAG_MAX: usize = 60;

/// Whether the path names a file this import reads.
#[must_use]
pub fn is_readable(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    !name.starts_with('.')
        && name
            .rsplit_once('.')
            .is_some_and(|(_, ext)| EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext)))
}

/// Read one file as a note; none for a file this import does not read or one with no
/// words and no name.
#[must_use]
pub fn parse(file: &SourceFile) -> Option<Parsed> {
    if !is_readable(&file.path) {
        return None;
    }
    let (front, rest) = split_front_matter(&file.text);
    let mut parts: Vec<&str> = file
        .path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let name = parts.pop()?;
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem).trim();
    let notebook = parts.first().map(|folder| (*folder).trim().to_owned());
    let notebook = notebook.filter(|folder| !folder.is_empty() && !folder.starts_with('.'));
    let mut title = stem.to_owned();
    let mut tags: Vec<String> = Vec::new();
    if let Some(front) = front {
        if let Some(named) = front_value(front, "title").filter(|named| !named.is_empty()) {
            title = named;
        }
        tags.extend(front_tags(front));
    }
    let body = normalise_links(rest.trim_matches(['\r', '\n']));
    tags.extend(inline_tags(&body));
    let mut seen = BTreeSet::new();
    tags.retain(|tag| seen.insert(tag.to_lowercase()));
    if title.is_empty() && body.trim().is_empty() {
        return None;
    }
    if title.is_empty() {
        title = body.lines().next().unwrap_or_default().trim().to_owned();
    }
    Some(Parsed {
        title: title.chars().take(1000).collect(),
        body,
        tags,
        notebook,
    })
}

/// `---` … `---` at the very top, if there is one.
fn split_front_matter(text: &str) -> (Option<&str>, &str) {
    let trimmed = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = trimmed
        .strip_prefix("---\n")
        .or_else(|| trimmed.strip_prefix("---\r\n"))
    else {
        return (None, trimmed);
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return (Some(&rest[..offset]), &rest[offset + line.len()..]);
        }
        offset += line.len();
    }
    (None, trimmed)
}

fn unquote(value: &str) -> &str {
    let value = value.trim();
    value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
        .unwrap_or(value)
}

fn front_value(front: &str, key: &str) -> Option<String> {
    front.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        (name.trim().eq_ignore_ascii_case(key)).then(|| unquote(value).to_owned())
    })
}

/// `tags: [a, b]`, `tags: a, b` and a list of `- a` lines under `tags:`.
fn front_tags(front: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_list = false;
    for line in front.lines() {
        if let Some((name, value)) = line.split_once(':')
            && !line.starts_with(' ')
            && !line.starts_with('-')
        {
            in_list = false;
            if name.trim().eq_ignore_ascii_case("tags") || name.trim().eq_ignore_ascii_case("tag") {
                let value = value.trim().trim_start_matches('[').trim_end_matches(']');
                if value.is_empty() {
                    in_list = true;
                } else {
                    out.extend(value.split(',').map(|tag| clean_tag(unquote(tag))));
                }
            }
        } else if in_list && let Some(item) = line.trim().strip_prefix('-') {
            out.push(clean_tag(unquote(item)));
        }
    }
    out.into_iter().filter(|tag| !tag.is_empty()).collect()
}

fn clean_tag(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('#')
        .chars()
        .take(TAG_MAX)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// Every `#tag` outside a fenced block and an inline code span.
fn inline_tags(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fenced = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let mut in_code = false;
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '`' {
                in_code = !in_code;
            } else if c == '#'
                && !in_code
                && (i == 0 || chars[i - 1].is_whitespace() || matches!(chars[i - 1], '(' | ','))
                && chars
                    .get(i + 1)
                    .is_some_and(|n| n.is_alphabetic() || *n == '_')
            {
                let mut j = i + 1;
                while j < chars.len() && is_tag_char(chars[j]) {
                    j += 1;
                }
                let tag: String = chars[i + 1..j].iter().collect();
                let tag = tag.trim_end_matches(['/', '-']).to_owned();
                if !tag.is_empty() {
                    out.push(clean_tag(&tag));
                }
                i = j;
                continue;
            }
            i += 1;
        }
    }
    out
}

/// `[[Title|alias]]` and `[[Title#Heading]]` to `[[Title]]`; `![[embed]]` to `[[embed]]`.
fn normalise_links(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(open) = rest.find("[[") {
        let embed = rest[..open].ends_with('!');
        out.push_str(&rest[..open - usize::from(embed)]);
        let after = &rest[open + 2..];
        let Some(close) = after.find("]]") else {
            out.push_str(&rest[open - usize::from(embed)..]);
            return out;
        };
        let inner = &after[..close];
        if inner.contains('\n') || inner.contains("[[") {
            out.push_str("[[");
            rest = after;
            continue;
        }
        let target = inner.split(['|', '#']).next().unwrap_or(inner).trim();
        if target.is_empty() {
            out.push_str(&rest[open..open + 2 + close + 2]);
        } else {
            out.push_str("[[");
            out.push_str(target);
            out.push_str("]]");
        }
        rest = &after[close + 2..];
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------
// The export archive
// ---------------------------------------------------------------------------

/// The most bytes a stem keeps: file systems cap a name at 255 bytes, and a member's own
/// extension and a duplicate's ` 2` have to fit after it.
const STEM_BYTES: usize = 200;

/// The most characters a stem keeps.
const STEM_CHARS: usize = 120;

/// Names a file may not have on Windows, whatever its extension (`CON.txt` is as reserved as `CON`).
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A control character, or an invisible one that reorders or hides text (the bidirectional marks,
/// the zero-width spaces, the byte-order mark).
fn is_unprintable(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
        )
}

/// `text` cut to at most `chars` characters and `bytes` bytes, never inside a character.
fn cut(text: &str, chars: usize, bytes: usize) -> &str {
    let mut end = 0;
    for (count, (at, c)) in text.char_indices().enumerate() {
        if count == chars || at + c.len_utf8() > bytes {
            break;
        }
        end = at + c.len_utf8();
    }
    &text[..end]
}

/// A name with every character a platform refuses made safe, uncut: separators, reserved
/// characters and control characters are `-`, the ends lose spaces and dots (Windows drops
/// them), and a reserved device name (`CON`, `NUL`, `COM1`, ...) gets a `_` after its base.
fn cleaned(title: &str) -> String {
    let swapped: String = title
        .chars()
        .map(|c| {
            if is_unprintable(c)
                || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = swapped.trim().trim_matches('.').trim();
    let (base, rest) = trimmed.split_once('.').unwrap_or((trimmed, ""));
    if RESERVED
        .iter()
        .any(|name| base.trim_end().eq_ignore_ascii_case(name))
    {
        let rest = if rest.is_empty() {
            String::new()
        } else {
            format!(".{rest}")
        };
        return format!("{base}_{rest}");
    }
    trimmed.to_owned()
}

/// A name safe as a file name on every platform: no separators or reserved characters, no control
/// characters, no reserved device name, no leading or trailing dot or space, and short enough for
/// any file system. `Untitled` when nothing is left.
#[must_use]
pub fn file_stem(title: &str) -> String {
    let whole = cleaned(title);
    let kept = cut(&whole, STEM_CHARS, STEM_BYTES).trim_end_matches(['.', ' ']);
    if kept.is_empty() {
        "Untitled".to_owned()
    } else {
        kept.to_owned()
    }
}

/// A document's file name: [`file_stem`]'s rules, with its extension kept when the name has to be
/// cut (`<long name>.pdf` stays a PDF).
#[must_use]
pub fn file_name(title: &str) -> String {
    let whole = cleaned(title);
    let (stem, extension) = match whole.rsplit_once('.') {
        Some((stem, extension))
            if !stem.trim().is_empty()
                && (1..=12).contains(&extension.chars().count())
                && extension.chars().all(char::is_alphanumeric) =>
        {
            (stem, format!(".{extension}"))
        }
        _ => (whole.as_str(), String::new()),
    };
    let room = STEM_BYTES.saturating_sub(extension.len());
    let stem = cut(stem, STEM_CHARS, room).trim_end_matches(['.', ' ']);
    if stem.is_empty() {
        format!("Untitled{extension}")
    } else {
        format!("{stem}{extension}")
    }
}

/// One entry of the archive.
pub struct Entry {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// A ZIP archive of `entries`, stored (not compressed): every reader opens it. A small archive
/// built in memory through the shared streaming writer ([`crate::portable::zip`]), which a large
/// export uses to write a file instead. Names are UTF-8 (general purpose flag bit 11).
#[must_use]
pub fn zip(entries: &[Entry]) -> Vec<u8> {
    let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for entry in entries {
        // A `Vec` sink and an in-memory reader of the declared length cannot fail.
        let _ = writer.add(
            &entry.path,
            entry.bytes.len() as u64,
            entry.bytes.as_slice(),
        );
    }
    writer
        .finish()
        .map(std::io::Cursor::into_inner)
        .unwrap_or_default()
}

/// The text of one exported note: its title as a heading when its words do not start with
/// one, and its tags as a front-matter list, so a re-import finds them again. Links stay
/// as written.
#[must_use]
pub fn markdown_of(title: &str, body: &str, tags: &[String]) -> String {
    let mut out = String::new();
    if !tags.is_empty() {
        out.push_str("---\ntags: [");
        out.push_str(&tags.join(", "));
        out.push_str("]\n---\n\n");
    }
    out.push_str(body.trim_end());
    out.push('\n');
    let _ = title;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, text: &str) -> SourceFile {
        SourceFile {
            path: path.to_owned(),
            text: text.to_owned(),
        }
    }

    #[test]
    fn an_obsidian_file_is_a_note_with_its_links_and_tags() {
        let parsed = parse(&file(
            "Travel/Paris trip.md",
            "---\ntags: [trip, france]\n---\n# Paris\nSee [[Hotel|the hotel]] and [[Plan#Day 1]] #food #trip\n```\n#not-a-tag\n```\nUse `#code` not.\n",
        ))
        .expect("a note");
        assert_eq!(parsed.title, "Paris trip");
        assert_eq!(parsed.notebook.as_deref(), Some("Travel"));
        assert_eq!(parsed.tags, ["trip", "france", "food"]);
        assert!(parsed.body.starts_with("# Paris"));
        assert!(parsed.body.contains("[[Hotel]]") && parsed.body.contains("[[Plan]]"));
        assert!(!parsed.body.contains("---"));
    }

    #[test]
    fn a_heading_is_not_a_tag_and_a_front_matter_list_is_read() {
        let parsed = parse(&file(
            "n.md",
            "---\ntitle: \"Named\"\ntags:\n  - a\n  - b\n---\n# Heading\n## Two\nissue #12 stays text? #a1\n",
        ))
        .expect("a note");
        assert_eq!(parsed.title, "Named");
        assert_eq!(parsed.tags, ["a", "b", "a1"]);
        assert_eq!(parsed.notebook, None);
    }

    #[test]
    fn other_files_are_not_read() {
        assert!(parse(&file("image.png", "x")).is_none());
        assert!(parse(&file(".hidden.md", "x")).is_none());
        assert!(parse(&file("plain.TXT", "words")).is_some());
    }

    #[test]
    fn the_archive_is_a_valid_stored_zip() {
        let bytes = zip(&[
            Entry {
                path: "A.md".to_owned(),
                bytes: b"hello".to_vec(),
            },
            Entry {
                path: "Trip/B.md".to_owned(),
                bytes: b"[[A]]".to_vec(),
            },
        ]);
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        // End of central directory: two entries.
        let end = bytes.len() - 22;
        assert_eq!(&bytes[end..end + 4], b"PK\x05\x06");
        assert_eq!(u16::from_le_bytes([bytes[end + 10], bytes[end + 11]]), 2);
        // The first entry's CRC is the CRC of "hello".
        let mut crc = flate2::Crc::new();
        crc.update(b"hello");
        assert_eq!(
            u32::from_le_bytes([bytes[14], bytes[15], bytes[16], bytes[17]]),
            crc.sum()
        );
        assert!(bytes.windows(5).any(|w| w == b"hello"));
        assert_eq!(file_stem("a/b: c?"), "a-b- c-");
        assert_eq!(file_stem("  "), "Untitled");
    }

    #[test]
    fn a_stem_has_no_separator_control_character_or_reserved_name() {
        assert_eq!(file_stem("a/b\\c"), "a-b-c");
        assert_eq!(file_stem("tab\there\u{7}\u{202E}x"), "tab-here--x");
        assert_eq!(file_stem("../../etc/passwd"), "-..-etc-passwd");
        assert_eq!(file_stem(".."), "Untitled");
        assert_eq!(file_stem("report. "), "report");
        for reserved in ["CON", "nul", "Aux", "com1", "LPT9"] {
            assert_eq!(file_stem(reserved), format!("{reserved}_"));
        }
        assert_eq!(file_stem("CON.txt"), "CON_.txt");
        assert_eq!(file_stem("Console"), "Console");
        assert_eq!(file_stem("COM10"), "COM10");
        // Cut by characters and by bytes, never inside a character, never ending in a dot.
        assert_eq!(file_stem(&"a".repeat(300)).chars().count(), STEM_CHARS);
        let wide = file_stem(&"日".repeat(300));
        assert!(wide.len() <= STEM_BYTES && wide.chars().all(|c| c == '日'));
        assert_eq!(
            file_stem(&format!("{}. x", "a".repeat(119))),
            "a".repeat(119)
        );
    }

    #[test]
    fn a_document_name_keeps_its_extension_when_it_is_cut() {
        assert_eq!(file_name("Receipt.pdf"), "Receipt.pdf");
        assert_eq!(file_name("a/b.pdf"), "a-b.pdf");
        assert_eq!(file_name("NUL.pdf"), "NUL_.pdf");
        assert_eq!(file_name(".pdf"), "pdf");
        let long = file_name(&format!("{}.pdf", "x".repeat(400)));
        assert!(
            long.ends_with(".pdf") && long.chars().count() <= STEM_CHARS + 4,
            "{long}"
        );
        let wide = file_name(&format!("{}.jpeg", "日".repeat(300)));
        assert!(
            wide.ends_with(".jpeg") && wide.len() <= STEM_BYTES,
            "{}",
            wide.len()
        );
        assert_eq!(file_name("  "), "Untitled");
    }
}
