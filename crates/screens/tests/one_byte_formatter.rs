//! THERE IS ONE BYTE FORMATTER (#1185): `kit::quantity` says every size a member reads (the
//! vault's rounded phrase, or the rounded-down one for what is backed up). A screen that builds
//! its own `"{} MB"` is a second formatter that will drift from it: the first one (Backup's) was
//! folded in, so this finds the next one before a member does.

use std::fs;
use std::path::{Path, PathBuf};

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// The source lines that build a size by hand: a format string ending a byte unit word.
fn hand_made_sizes(text: &str) -> Vec<String> {
    let code = text.split("#[cfg(test)]").next().unwrap_or(text);
    code.lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("//"))
        .filter(|line| line.contains("format!("))
        .filter(|line| {
            [
                " KB\"", " MB\"", " GB\"", " TB\"", " bytes\"", " KiB\"", " MiB\"", " GiB\"",
            ]
            .iter()
            .any(|unit| line.contains(unit))
        })
        .map(str::to_owned)
        .collect()
}

#[test]
fn no_screen_builds_a_size_by_hand() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&root, &mut files);
    assert!(files.len() > 100, "the scan found no screens");
    let mut found = Vec::new();
    for path in files {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let is_the_formatter = path.ends_with("kit/quantity.rs");
        if is_the_formatter || name == "tests.rs" || path.to_string_lossy().contains("/tests/") {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap_or_default();
        for line in hand_made_sizes(&text) {
            found.push(format!("{}: {line}", path.display()));
        }
    }
    assert!(
        found.is_empty(),
        "a size is worded by `kit::quantity::Quantity`, not by hand:\n{}",
        found.join("\n")
    );
}

#[test]
fn the_scan_catches_a_second_formatter() {
    let fixture = "fn size(n: u64) -> String {\n    format!(\"{} MB\", n / 1_000_000)\n}\n";
    assert_eq!(hand_made_sizes(fixture).len(), 1);
    let comment = "// format!(\"{} MB\") is what this used to be\n";
    assert!(hand_made_sizes(comment).is_empty());
    let unit_tests = "fn a() {}\n#[cfg(test)]\nmod t { fn b() { format!(\"{} MB\", 1); } }\n";
    assert!(hand_made_sizes(unit_tests).is_empty());
}
