//! THE KIT'S FIXED WORDS, LOWERED NATIVELY (#1135, moved to Rust by #1173).
//!
//! Native views write no copy: every sentence a screen shows is a finished
//! string in its Rust `ViewState`. What is left is the handful of words the
//! native KIT itself draws with no view to carry them (a read state's retry
//! verb, a sheet's cancel, a pushed page's spoken back), which are parameters
//! of the kit composables and SwiftUI views, defaulting to these.
//!
//! Their one source is the Rust catalogue, `crates/screens/src/strings/shared.rs`
//! (and one word from `home.rs`). This module reads each file's `catalog!`
//! block, which is data: one `plain key = ("one", "other");` row per word. It
//! is a port of the TypeScript reader it replaced and keeps its strictness:
//! a row this reader cannot parse, an escape it does not lower, a word missing
//! from the catalogue, or a template without its slot is an error, because a
//! silent empty label is the failure this table exists to prevent.
//!
//! Reading the source text rather than depending on `centraid-screens` keeps
//! this tool's compile cost where it was: `screens` pulls in the whole core.

use std::collections::BTreeMap;

use anyhow::{Result, bail};

/// The Rust catalogue the words are read from.
pub const WORDS_SOURCE: &str = "crates/screens/src/strings/shared.rs";

/// A word the kit shares with one screen's own catalogue is read from there,
/// as `<module>::<key>`, rather than spelled twice in Rust.
pub const OTHER_SOURCES: [(&str, &str); 2] = [
    ("home", "crates/screens/src/strings/home.rs"),
    ("backup", "crates/screens/src/strings/backup.rs"),
];

/// Member name to the Rust key. Exactly the words a native kit view reads; a
/// word nothing native draws stays Rust's alone.
const CONSTANTS: [(&str, &str); 25] = [
    ("BACK", "back"),
    ("BAND_CURRENT", "home::band_current_spoken"),
    ("BAND_HOME", "kit_band_home"),
    ("BAND_MORE", "kit_band_more"),
    ("CANCEL", "kit_cancel"),
    ("CLOSE_SEARCH", "kit_close_search"),
    ("DELETE", "kit_delete"),
    ("DETAILS", "kit_details"),
    ("DISMISS", "kit_dismiss"),
    ("DONE", "kit_done"),
    ("FLAG", "kit_flag"),
    ("LOADING_MORE", "kit_loading_more"),
    ("OPEN", "kit_open"),
    ("OPENING", "kit_opening"),
    ("PENDING", "kit_pending"),
    ("RETRY", "kit_retry"),
    ("SAVE", "kit_save"),
    ("SEARCH", "kit_search"),
    ("SELECT", "kit_select"),
    ("SHOW_MORE", "kit_show_more"),
    ("UNFLAG", "kit_unflag"),
    // THE LAUNCH SCREEN FOR A DAMAGED VAULT (#1191): no core is open, so no Rust screen can carry
    // these words. They are the Backup screen's own sentences, said once.
    ("VAULT_DAMAGED_TITLE", "backup::backup_status_damaged"),
    ("VAULT_DAMAGED_LINE", "backup::backup_line_damaged"),
    ("VAULT_DAMAGED_SAFE", "backup::backup_detail_damaged"),
    ("VAULT_DAMAGED_RESTORE", "home::restore_first_action"),
];

/// The two templates the kit fills, each with its one slot.
const BACK_TO: (&str, &str) = ("back_to", "parent");
const SEARCH_CORRECTED: (&str, &str) = ("search_corrected", "corrected");

/// The words the two shells' `KitWords` carry.
#[derive(Debug, PartialEq, Eq)]
pub struct KitWords {
    /// `(member name, text)` in table order.
    pub constants: Vec<(String, String)>,
    pub back_to: String,
    pub search_corrected: String,
}

/// Undo a Rust string literal's escapes (the subset a catalogue row uses).
fn unescape_rust(body: &str, key: &str) -> Result<String> {
    let mut out = String::new();
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            Some('\'') => out.push('\''),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('u') => {
                if chars.next() != Some('{') {
                    bail!("design: {key} carries a malformed \\u escape");
                }
                let mut digits = String::new();
                loop {
                    match chars.next() {
                        Some('}') => break,
                        Some(d) if d.is_ascii_hexdigit() => digits.push(d),
                        _ => bail!("design: {key} carries a malformed \\u{{…}} escape"),
                    }
                }
                let Some(decoded) = u32::from_str_radix(&digits, 16)
                    .ok()
                    .and_then(char::from_u32)
                else {
                    bail!("design: {key} carries a \\u{{{digits}}} that is not a character");
                };
                out.push(decoded);
            }
            Some(other) => {
                bail!("design: {key} carries an escape (\\{other}) this reader does not lower")
            }
            None => bail!("design: {key} ends in a lone backslash"),
        }
    }
    Ok(out)
}

/// A quoted Rust string literal at the start of `text`: its raw body and the
/// rest of the text after the closing quote.
fn literal(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix('"')?;
    let mut escaped = false;
    for (at, c) in rest.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            return Some((&rest[..at], &rest[at + 1..]));
        }
    }
    None
}

/// `plain key = ("one", "other");` as `(kind, key, one)`.
fn row(line: &str) -> Option<(&str, &str, &str)> {
    let t = line.trim();
    let kind_end = t.find(char::is_whitespace)?;
    let kind = &t[..kind_end];
    if kind != "plain" && kind != "counted" {
        return None;
    }
    let t = t[kind_end..].trim_start();
    let key_end = t
        .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
        .unwrap_or(t.len());
    let key = &t[..key_end];
    if key.is_empty() {
        return None;
    }
    let t = t[key_end..].trim_start().strip_prefix('=')?.trim_start();
    let t = t.strip_prefix('(')?.trim_start();
    let (one, t) = literal(t)?;
    let t = t.trim_start().strip_prefix(',')?.trim_start();
    let (_other, t) = literal(t)?;
    let t = t.trim_start().strip_prefix(')')?.trim_start();
    let t = t.strip_prefix(';')?;
    if !t.trim().is_empty() {
        return None;
    }
    Some((kind, key, one))
}

/// Every `plain` row of a catalogue file, by key. `strict` makes a row it
/// cannot parse an error; a file read for one word skips a row split over
/// lines, and that word's lookup fails if it was that row.
pub fn read_catalog(source: &str, strict: bool) -> Result<BTreeMap<String, String>> {
    let mut words = BTreeMap::new();
    let mut inside = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if !inside {
            if trimmed
                .strip_prefix("catalog!")
                .is_some_and(|rest| rest.trim_start().starts_with('{'))
            {
                inside = true;
            }
            continue;
        }
        if trimmed == "}" {
            inside = false;
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }
        let Some((kind, key, one)) = row(line) else {
            if !strict {
                continue;
            }
            bail!("design: a catalogue row this reader cannot parse: {trimmed}");
        };
        if kind == "plain" {
            words.insert(key.to_owned(), unescape_rust(one, key)?);
        }
    }
    Ok(words)
}

pub(crate) fn lookup(words: &BTreeMap<String, String>, key: &str, source: &str) -> Result<String> {
    match words.get(key) {
        Some(text) if !text.is_empty() => Ok(text.clone()),
        _ => bail!("design: `{key}` is not a plain entry of {source}"),
    }
}

pub(crate) fn slotted(text: String, slot: &str, key: &str) -> Result<String> {
    if !text.contains(&format!("{{{slot}}}")) {
        bail!("design: `{key}` has no {{{slot}}} slot: {text}");
    }
    Ok(text)
}

/// Resolve the kit's words from the shared catalogue and the others.
pub fn resolve(shared: &str, others: &BTreeMap<String, String>) -> Result<KitWords> {
    let words = read_catalog(shared, true)?;
    let mut tables: BTreeMap<&str, BTreeMap<String, String>> = BTreeMap::new();
    for (module, _) in OTHER_SOURCES {
        let Some(source) = others.get(module) else {
            bail!("design: no catalogue named {module}");
        };
        tables.insert(module, read_catalog(source, false)?);
    }
    let mut constants = Vec::new();
    for (name, key) in CONSTANTS {
        let text = if let Some((module, own)) = key.split_once("::") {
            let Some(table) = tables.get(module) else {
                bail!("design: no catalogue named {module}");
            };
            lookup(table, own, WORDS_SOURCE)?
        } else {
            lookup(&words, key, WORDS_SOURCE)?
        };
        constants.push((name.to_owned(), text));
    }
    Ok(KitWords {
        constants,
        back_to: slotted(
            lookup(&words, BACK_TO.0, WORDS_SOURCE)?,
            BACK_TO.1,
            BACK_TO.0,
        )?,
        search_corrected: slotted(
            lookup(&words, SEARCH_CORRECTED.0, WORDS_SOURCE)?,
            SEARCH_CORRECTED.1,
            SEARCH_CORRECTED.0,
        )?,
    })
}

/// The Swift and Kotlin string quoting of a word.
pub(crate) fn quote(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// Kotlin also interpolates `$`.
pub(crate) fn kotlin_quote(value: &str) -> String {
    quote(value).replace('$', "\\$")
}

fn header() -> Vec<String> {
    [
        format!("// GENERATED by `cargo xtask design` from `{WORDS_SOURCE}`."),
        "// Do not edit: change the Rust catalogue.".to_owned(),
        "//".to_owned(),
        "// The words the native kit draws with no view to carry them (#1135). Every".to_owned(),
        "// kit view takes each word as a parameter defaulting to these, so a screen".to_owned(),
        "// whose view carries its own word passes it. The gate's `design` step".to_owned(),
        "// regenerates this file and fails on any difference.".to_owned(),
        String::new(),
    ]
    .to_vec()
}

/// `Words.kt`.
#[must_use]
pub fn kotlin(words: &KitWords) -> String {
    let mut lines = header();
    lines.extend([
        "package dev.centraid.design".to_owned(),
        String::new(),
        "public object KitWords {".to_owned(),
    ]);
    for (name, text) in &words.constants {
        lines.push(format!(
            "    public const val {name}: String = {}",
            kotlin_quote(text)
        ));
    }
    lines.extend([
        String::new(),
        "    /** A pushed page's back control, spoken: \"Back to People\"; \"Back\" with no parent. */"
            .to_owned(),
        "    public fun backTo(parent: String): String =".to_owned(),
        format!(
            "        if (parent.isBlank()) BACK else {}.replace(\"{{parent}}\", parent)",
            kotlin_quote(&words.back_to)
        ),
        String::new(),
        "    /** The line under a search field when the core corrected a typo; [corrected] is `SearchField.corrected`. */"
            .to_owned(),
        "    public fun searchCorrected(corrected: String): String =".to_owned(),
        format!(
            "        {}.replace(\"{{corrected}}\", corrected)",
            kotlin_quote(&words.search_corrected)
        ),
        "}".to_owned(),
        String::new(),
    ]);
    lines.join("\n")
}

/// `Words.swift`.
#[must_use]
pub fn swift(words: &KitWords) -> String {
    let mut lines = header();
    lines.extend([
        "import Foundation".to_owned(),
        String::new(),
        "public enum KitWords {".to_owned(),
    ]);
    for (name, text) in &words.constants {
        lines.push(format!("    public static let {name} = {}", quote(text)));
    }
    lines.extend([
        String::new(),
        "    /// A pushed page's back control, spoken: \"Back to People\"; \"Back\" with no parent."
            .to_owned(),
        "    public static func backTo(parent: String) -> String {".to_owned(),
        "        parent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty".to_owned(),
        format!(
            "            ? BACK : {}.replacingOccurrences(of: \"{{parent}}\", with: parent)",
            quote(&words.back_to)
        ),
        "    }".to_owned(),
        String::new(),
        "    /// The line under a search field when the core corrected a typo; `corrected` is `SearchField.corrected`."
            .to_owned(),
        "    public static func searchCorrected(corrected: String) -> String {".to_owned(),
        format!(
            "        {}.replacingOccurrences(of: \"{{corrected}}\", with: corrected)",
            quote(&words.search_corrected)
        ),
        "    }".to_owned(),
        "}".to_owned(),
        String::new(),
    ]);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn others(home: &str) -> BTreeMap<String, String> {
        // THE BACKUP CATALOGUE carries every word the constants read from it.
        let mut backup = String::from("catalog! {\n");
        for (_, key) in CONSTANTS {
            if let Some(key) = key.strip_prefix("backup::") {
                backup.push_str(&format!("    plain {key} = (\"w\", \"w\");\n"));
            }
        }
        backup.push_str("}\n");
        BTreeMap::from([
            ("home".to_owned(), home.to_owned()),
            ("backup".to_owned(), backup),
        ])
    }

    #[test]
    fn a_row_with_escapes_and_unicode_reads_back_as_its_text() {
        let source = "catalog! {\n    // a comment\n\n    plain a = (\"Quote \\\" and \\u{201c}\", \"x\");\n    counted n = (\"one\", \"many\");\n}\n";
        let words = read_catalog(source, true).expect("reads");
        assert_eq!(
            words.get("a").map(String::as_str),
            Some("Quote \" and \u{201c}")
        );
        assert!(!words.contains_key("n"), "only plain rows are words");
    }

    #[test]
    fn an_unparseable_row_is_an_error_when_strict_and_skipped_when_not() {
        let source = "catalog! {\n    plain a = (\"x\",\n        \"y\");\n}\n";
        assert!(read_catalog(source, true).is_err());
        assert!(read_catalog(source, false).expect("skips").is_empty());
    }

    #[test]
    fn an_unknown_escape_is_an_error() {
        let source = "catalog! {\n    plain a = (\"bad \\q\", \"x\");\n}\n";
        let error = read_catalog(source, true).expect_err("refused");
        assert!(error.to_string().contains("escape"), "{error}");
    }

    #[test]
    fn a_word_the_catalogue_lacks_is_named() {
        let error = resolve("catalog! {\n}\n", &others("catalog! {\n}\n")).expect_err("refused");
        assert!(error.to_string().contains("`back`"), "{error}");
    }

    #[test]
    fn a_template_without_its_slot_is_refused() {
        let mut shared = String::from("catalog! {\n");
        for (_, key) in CONSTANTS {
            if !key.contains("::") {
                shared.push_str(&format!("    plain {key} = (\"w\", \"w\");\n"));
            }
        }
        shared.push_str("    plain back_to = (\"Back\", \"Back\");\n");
        shared.push_str("    plain search_corrected = (\"{corrected}\", \"{corrected}\");\n}\n");
        let home = "catalog! {\n    plain band_current_spoken = (\"here\", \"here\");\n    plain restore_first_action = (\"Restore\", \"Restore\");\n}\n";
        let error = resolve(&shared, &others(home)).expect_err("no {parent}");
        assert!(error.to_string().contains("{parent}"), "{error}");
    }

    #[test]
    fn the_committed_catalogue_resolves_every_member() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let read = |file: &str| std::fs::read_to_string(root.join(file)).expect("reads");
        let others: BTreeMap<String, String> = OTHER_SOURCES
            .iter()
            .map(|(module, file)| ((*module).to_owned(), read(file)))
            .collect();
        let words = resolve(&read(WORDS_SOURCE), &others).expect("resolves");
        assert_eq!(words.constants.len(), CONSTANTS.len());
        assert!(words.back_to.contains("{parent}"));
    }
}
