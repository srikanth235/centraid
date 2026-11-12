//! THE ONE SITE THAT UNESCAPES. The model reads vault text with its special tokens broken by a
//! zero-width space, and may echo a name back that way; the turn undoes the break on the model's own
//! words, once, before the call is parsed, shown and run. Anything else that hands text the model
//! wrote to the parser or the write path would store the break in the member's vault, so this fails
//! when a second caller appears, and when the one site stops unescaping first (#1188).

use std::path::{Path, PathBuf};

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path
                .file_name()
                .is_some_and(|n| n == "tests" || n == "target")
            {
                continue;
            }
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// The non-test text of a source file: everything before its `#[cfg(test)]` module.
fn product(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap();
    match text.find("#[cfg(test)]") {
        Some(at) => text[..at].to_owned(),
        None => text,
    }
}

fn callers(needle: &str) -> Vec<String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    for krate in ["assist", "core", "screens", "nativetools", "vault"] {
        sources(&root.join(krate).join("src"), &mut files);
    }
    let mut found: Vec<String> = files
        .iter()
        .filter(|path| product(path).contains(needle))
        .map(|path| {
            path.strip_prefix(&root)
                .unwrap()
                .components()
                .collect::<PathBuf>()
                .display()
                .to_string()
        })
        .collect();
    found.sort();
    found
}

#[test]
fn only_the_turn_hands_model_text_to_the_parser_and_the_write_path() {
    // `parse_call(` is defined in `native/parse.rs`, read by the session's `call_text`, and by the
    // developer tool that replays a stored line; `.call_text(` is what runs the call.
    for (needle, allowed) in [
        (
            "parse_call(",
            &[
                "assist/src/native/parse.rs",
                // the session's `call_text`, which the guarded callers below are the only users of
                "assist/src/native/session.rs",
                "assist/src/native_turn/mod.rs",
                "nativetools/src/bin/nativetools.rs",
            ][..],
        ),
        (
            ".call_text(",
            &[
                "assist/src/native_turn/mod.rs",
                "nativetools/src/bin/nativetools.rs",
            ][..],
        ),
    ] {
        let found = callers(needle);
        let unexpected: Vec<&String> = found
            .iter()
            .filter(|f| !allowed.contains(&f.as_str()))
            .collect();
        assert!(
            unexpected.is_empty(),
            "{needle} is reached from {unexpected:?}: model text must go through the turn's one unescape site"
        );
    }
}

#[test]
fn the_turn_unescapes_the_models_words_before_it_parses_or_runs_them() {
    let turn = product(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src/native_turn/mod.rs"));
    // replayed text (the log, a stored transcript) is not the model's words and is run as it is
    let wrote = turn
        .find("let model_wrote = lookup.len() == 0;")
        .expect("the turn marks what the model wrote");
    let unescape = turn
        .find("crate::escape::unescape(&sent)")
        .expect("the turn unescapes the model's call");
    let parse = turn
        .find("parse_call(&run)")
        .expect("the turn parses the unescaped call");
    let call = turn
        .find("call_text(&run)")
        .expect("the turn runs the unescaped call");
    assert!(wrote < unescape && unescape < parse && parse < call);
    assert!(
        !turn.contains("parse_call(&sent)") && !turn.contains("call_text(&sent)"),
        "the call that runs is never the raw line the model wrote"
    );
    assert_eq!(
        turn.matches("crate::escape::unescape(").count(),
        1,
        "one site undoes the break"
    );
}
