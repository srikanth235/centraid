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

/// Every full path one `use` tree names: `std::{fs, io as i}` is
/// `std::fs` and `std::io`. An alias is dropped, because the path it hides is
/// the reach; a glob keeps its `*`.
fn expand(prefix: &str, tree: &str, into: &mut Vec<String>) {
    let tree = tree.trim();
    if let Some(open) = tree.find('{') {
        let close = tree.rfind('}').unwrap_or(tree.len());
        let base = format!("{prefix}{}", tree[..open].trim());
        let inner = &tree[open + 1..close];
        let (mut depth, mut start) = (0_i32, 0);
        let mut parts = Vec::new();
        for (index, character) in inner.char_indices() {
            match character {
                '{' => depth += 1,
                '}' => depth -= 1,
                ',' if depth == 0 => {
                    parts.push(&inner[start..index]);
                    start = index + 1;
                }
                _ => {}
            }
        }
        parts.push(&inner[start..]);
        for part in parts.into_iter().filter(|part| !part.trim().is_empty()) {
            expand(&base, part, into);
        }
        return;
    }
    let path = tree.split(" as ").next().unwrap_or(tree).trim();
    let path = if path == "self" {
        prefix.trim_end_matches("::").to_string()
    } else {
        format!("{prefix}{path}")
    };
    into.push(path);
}

/// What in `text` is a reach the rules may not make, as `(line, what, why)`.
/// A `use` is read whole (it may span lines, group paths in braces, or alias
/// them), then each path it names is judged as if written in full.
fn reaches(text: &str) -> Vec<(usize, String, &'static str)> {
    let mut found = Vec::new();
    let mut pending: Option<(usize, String)> = None;
    for (index, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        // A comment that names a reach explains its absence.
        if trimmed.starts_with("//") {
            continue;
        }
        if let Some((_, statement)) = pending.as_mut() {
            statement.push(' ');
            statement.push_str(trimmed);
        } else if let Some(rest) = trimmed
            .strip_prefix("use ")
            .or_else(|| trimmed.strip_prefix("pub use "))
            .or_else(|| trimmed.strip_prefix("pub(crate) use "))
        {
            pending = Some((index + 1, rest.to_string()));
        } else {
            for (needle, reason) in FORBIDDEN {
                if line.contains(needle) {
                    found.push((index + 1, (*needle).to_string(), *reason));
                }
            }
            continue;
        }
        let complete = pending
            .as_ref()
            .is_some_and(|(_, statement)| statement.contains(';'));
        if complete {
            let (first, statement) = pending.take().unwrap_or_default();
            let tree = statement.split(';').next().unwrap_or_default();
            let mut paths = Vec::new();
            expand("", tree, &mut paths);
            for path in paths {
                let full = format!("{}::", path.trim_start_matches("::"));
                if path.trim_start_matches("::") == "std" || full == "std::*::" {
                    found.push((
                        first,
                        path.clone(),
                        "`std` itself is not imported: name what is used, so the scan can judge it",
                    ));
                }
                for (needle, reason) in FORBIDDEN {
                    if full.contains(needle) {
                        found.push((first, path.clone(), *reason));
                    }
                }
            }
        }
    }
    found
}

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
        for (number, what, reason) in reaches(&text) {
            findings.push(format!("{}:{number}: `{what}` — {reason}", path.display()));
        }
    }
    assert!(
        findings.is_empty(),
        "the rules are a pure state machine (#1080):\n{}",
        findings.join("\n")
    );
}

/// The scan has to be able to find something, or it always passes: written
/// out in full, grouped in braces, aliased, spread over lines, or the whole
/// of `std` imported under another name.
#[test]
fn the_scan_would_catch_a_real_reach() {
    for sample in [
        "let now = std::time::SystemTime::now();",
        "let file = std::fs::read(path);",
        "tokio::spawn(work);",
        "use std::fs;",
        "use std::{fs, io};",
        "use std::{io, fs::File};",
        "use std::{\n    io,\n    fs as files,\n};",
        "use std::fs as f;",
        "use std::{thread as t};",
        "use std::{env::{self, var}};",
        "use std as s;",
        "use std::net::{TcpStream as Tcp};",
        "pub(crate) use rand::{Rng, rngs::OsRng};",
        "use rand;",
        "use tokio::{sync::Mutex};",
    ] {
        assert!(!reaches(sample).is_empty(), "{sample} would pass the scan");
    }
}

/// And it must not cry wolf at what a rule may use.
#[test]
fn the_scan_lets_a_pure_import_through() {
    for sample in [
        "use std::collections::{BTreeMap, BTreeSet};",
        "use std::{cmp, fmt::Debug};",
        "// use std::fs;",
        "use crate::rules::ids::{Digest, Name};",
    ] {
        assert!(reaches(sample).is_empty(), "{sample} was refused");
    }
}
