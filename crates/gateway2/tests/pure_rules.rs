//! THE RULES ARE A PURE STATE MACHINE, AS A SCAN (#1080).
//!
//! `src/rules` takes time and randomness as arguments and reaches for no
//! thread, file, socket, process, environment, runtime or database. A rule
//! that read a clock is a rule no test can pin and no adapter can replay; a
//! rule that opened a file is a rule the in-memory reference could not run.
//! `--no-default-features` proves the dependency list compiles alone; this
//! proves the source does not reach around it. A claim names its grep, and
//! this file is the grep.

use std::fs;
use std::path::{Path, PathBuf};

fn rules_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/rules")
}

fn sources(dir: &Path, into: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("the rules read").flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, into);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            into.push(path);
        }
    }
}

/// What a rule must never reach for, and why.
const FORBIDDEN: &[(&str, &str)] = &[
    ("SystemTime", "an ambient clock: take `now_ms`"),
    ("Instant::now", "an ambient clock: take `now_ms`"),
    ("std::thread", "a rule decides; it does not run work"),
    (
        "std::fs",
        "there is no filesystem in the rules: bytes are the adapter's",
    ),
    ("std::net", "there are no sockets in the rules"),
    ("std::process", "nothing in a rule shells out"),
    ("std::env", "configuration is an argument"),
    (
        "rand::",
        "ambient randomness: a token or a secret is an argument",
    ),
    ("OsRng", "ambient randomness"),
    ("getrandom", "ambient randomness"),
    (
        "tokio",
        "a runtime: the adapter's scheduler drives the rules",
    ),
    ("rusqlite", "the state is behind `State`"),
    ("axum", "the server is an adapter over the rules"),
    ("hyper", "the client is an adapter over the rules"),
    ("rustls", "TLS is the adapter's"),
];

#[test]
fn no_rule_reaches_for_a_clock_a_file_a_socket_or_randomness() {
    let mut files = Vec::new();
    sources(&rules_root(), &mut files);
    assert!(
        files.len() >= 10,
        "only {} rule files were scanned, which is not the rules",
        files.len()
    );
    let mut findings = Vec::new();
    for path in files {
        let text = fs::read_to_string(&path).expect("a rule file reads");
        for (number, line) in text.lines().enumerate() {
            // A comment that names a reach explains its absence.
            if line.trim_start().starts_with("//") {
                continue;
            }
            for (needle, reason) in FORBIDDEN {
                if line.contains(needle) {
                    findings.push(format!(
                        "{}:{}: `{needle}` — {reason}",
                        path.display(),
                        number + 1
                    ));
                }
            }
        }
    }
    assert!(
        findings.is_empty(),
        "the rules are a pure state machine (#1080):\n{}",
        findings.join("\n")
    );
}

/// The scan has to be able to find something, or it always passes.
#[test]
fn the_scan_would_catch_a_real_reach() {
    for sample in [
        "let now = std::time::SystemTime::now();",
        "let file = std::fs::read(path);",
        "tokio::spawn(work);",
    ] {
        assert!(
            FORBIDDEN.iter().any(|(needle, _)| sample.contains(needle)),
            "{sample} would pass the scan"
        );
    }
}
