//! The words People says: no sharing plane (#1029 amendment), so no People word
//! says gateway, linked or share. Ports `PeopleSpec`'s word law over the
//! source of every People string, `src/strings/people.rs` (#1135).

use std::path::Path;

/// Every string literal on a non-comment line of a catalogue file.
fn literals(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in source.lines() {
        if line.trim_start().starts_with("//") {
            continue;
        }
        let mut rest = line;
        while let Some(open) = rest.find('"') {
            let after = &rest[open + 1..];
            let mut end = None;
            let mut escaped = false;
            for (at, char) in after.char_indices() {
                match char {
                    '\\' if !escaped => escaped = true,
                    '"' if !escaped => {
                        end = Some(at);
                        break;
                    }
                    _ => escaped = false,
                }
            }
            let Some(end) = end else { break };
            out.push(after[..end].to_owned());
            rest = &after[end + 1..];
        }
    }
    out
}

#[test]
fn no_people_word_says_gateway_linked_or_share() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/strings/people.rs");
    let source = std::fs::read_to_string(&path).expect("src/strings/people.rs");
    let words = literals(&source);
    assert!(words.len() > 50, "the catalogue was read");
    for word in words {
        let lower = word.to_lowercase();
        for banned in ["gateway", "linked", "share"] {
            assert!(!lower.contains(banned), "{word:?} says {banned}");
        }
    }
}
