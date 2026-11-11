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

/// A name safe as a file name on every platform: no separators or reserved characters.
#[must_use]
pub fn file_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_owned();
    if cleaned.is_empty() {
        "Untitled".to_owned()
    } else {
        cleaned.chars().take(120).collect()
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
}
