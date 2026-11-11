//! THE SHELLS WORD NO PERMISSION (#1185): a phone grant's ask and refusal are one voice, in Rust
//! (`kit::permission`), and a shell reports only the state (`EffectFailed.denied` / `restricted` /
//! `limited`, the camera roll's and notifications' enums). This scans the Swift and Kotlin sources for
//! the sentences of that voice, and fails on one that a shell wrote itself.

use std::fs;
use std::path::{Path, PathBuf};

/// The phrases of the voice: what an ask or a refusal says to a member.
const PHRASES: [&str; 9] = [
    "access is off",
    "turn it on in settings",
    "turn them on in settings",
    "does not allow",
    "needs access to your",
    "needs full access",
    "allow access in settings",
    "allow it in settings",
    "blocked on this phone",
];

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !matches!(name, "build" | ".build" | "Tests" | "test" | "androidTest") {
                sources(&path, out);
            }
        } else if path
            .extension()
            .is_some_and(|ext| ext == "swift" || ext == "kt")
        {
            out.push(path);
        }
    }
}

/// The string literals of a source line that say a phrase of the voice (comments are not wording).
fn worded(line: &str) -> Option<&'static str> {
    let code = line.split("//").next().unwrap_or("");
    let lower = code.to_lowercase();
    let quoted = lower.contains('"');
    quoted
        .then(|| {
            PHRASES
                .iter()
                .copied()
                .find(|phrase| lower.contains(phrase))
        })
        .flatten()
}

#[test]
fn no_shell_file_words_a_permission() {
    let mobile = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mobile");
    let mut files = Vec::new();
    sources(&mobile.join("iosApp"), &mut files);
    sources(&mobile.join("androidApp"), &mut files);
    assert!(files.len() > 100, "the scan found no shell sources");
    let mut found = Vec::new();
    for path in files {
        let text = fs::read_to_string(&path).unwrap_or_default();
        for (at, line) in text.lines().enumerate() {
            if let Some(phrase) = worded(line) {
                found.push(format!("{}:{}: says `{phrase}`", path.display(), at + 1));
            }
        }
    }
    assert!(
        found.is_empty(),
        "a shell words a permission; report the state and let `kit::permission` say it:\n{}",
        found.join("\n")
    );
}

#[test]
fn the_scan_catches_a_sentence_and_not_a_comment() {
    assert_eq!(
        worded(r#"let line = "Camera access is off. Turn it on in Settings.""#),
        Some("access is off")
    );
    assert_eq!(
        worded(r#"Text("This phone does not allow photos")"#),
        Some("does not allow")
    );
    assert_eq!(worded("// the grant is off: access is off"), None);
    assert_eq!(worded("let state = .restricted"), None);
}
