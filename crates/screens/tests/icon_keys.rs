//! EVERY ICON KEY A SCREEN NAMES IS ONE THE EMITTED SET HOLDS (#1020 wave A, #1135).
//!
//! Both shells draw `CentraidCatalog.icons[key] ?? []`, so a key the set lacks
//! is a blank mark and nothing fails. The keys are Rust's now — a row's
//! `icon_key`, a trash spec's glyph, a kind's mark — so this reads the screens'
//! source the way `CatalogSpec` once read the Kotlin policies: every quoted
//! PascalCase or lower-case word on a line that speaks of an icon, outside
//! comments and `#[cfg(test)]` modules, and every literal a `fn …icon…`
//! returns, must be a key of `design/native-catalog.json`.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn catalogue() -> BTreeSet<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../design/native-catalog.json");
    let json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("design/native-catalog.json"))
            .expect("the catalogue is JSON");
    json["icons"]
        .as_object()
        .expect("the catalogue has icons")
        .keys()
        .cloned()
        .collect()
}

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("readable").flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// A word that could be an icon key: letters and digits only.
fn word(literal: &str) -> bool {
    !literal.is_empty() && literal.chars().all(|char| char.is_ascii_alphanumeric())
}

/// `(line, key)` for every key-like literal the file names as an icon.
fn named(source: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut in_icon_fn = false;
    let mut depth = 0i32;
    let mut fn_depth = 0i32;
    for (index, raw) in source.lines().enumerate() {
        if raw.trim_start().starts_with("#[cfg(test)]") {
            break;
        }
        let line = raw.find("//").map_or(raw, |at| &raw[..at]);
        if line.contains("fn ") && line.to_lowercase().contains("icon") {
            in_icon_fn = true;
            fn_depth = depth;
        }
        let speaks = in_icon_fn || line.to_lowercase().contains("icon");
        if speaks {
            // A match arm's key is its pattern; the mark is what it returns.
            let returned = line.rsplit_once("=>").map_or(line, |(_, value)| value);
            for literal in returned.split('"').skip(1).step_by(2) {
                if word(literal) {
                    out.push((index + 1, literal.to_owned()));
                }
            }
        }
        depth += line.matches('{').count() as i32 - line.matches('}').count() as i32;
        if in_icon_fn && depth <= fn_depth && line.contains('}') {
            in_icon_fn = false;
        }
    }
    out
}

#[test]
fn every_icon_key_a_screen_names_resolves() {
    let icons = catalogue();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&root, &mut files);
    files.sort();
    let mut seen = 0usize;
    let mut missing = Vec::new();
    for file in &files {
        let rel = file
            .strip_prefix(&root)
            .unwrap_or(file)
            .display()
            .to_string();
        // The strings catalogue holds words, not keys.
        if rel.starts_with("strings") {
            continue;
        }
        for (line, key) in named(&fs::read_to_string(file).expect("readable")) {
            seen += 1;
            if !icons.contains(&key) {
                missing.push(format!("src/{rel}:{line}: \"{key}\""));
            }
        }
    }
    // A scan over nothing passes forever: the band's three marks alone are here.
    assert!(seen >= 20, "the scan saw {seen} icon key(s)");
    assert!(
        missing.is_empty(),
        "icon keys the emitted set does not hold (a blank mark on both shells):\n{}",
        missing.join("\n")
    );
}

#[test]
fn the_scan_reads_an_icon_function_and_skips_tests_and_comments() {
    let source = "\
fn kind_icon(key: &str) -> &'static str {
    match key {
        \"run\" => \"Activity\",
        _ => \"Gym\",
    }
}
fn label() -> &'static str { \"Not an icon\" }
const SPEC: Spec = Spec { icon_key: \"CheckSquare\" }; // \"Ghost\" icon in a comment
#[cfg(test)]
mod tests { fn icon() { let _ = \"strength\"; } }
";
    let keys: Vec<String> = named(source).into_iter().map(|(_, key)| key).collect();
    assert_eq!(keys, ["Activity", "Gym", "CheckSquare"]);
}
