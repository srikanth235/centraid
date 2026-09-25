//! THE RULES ARE A PURE STATE MACHINE, as a scan (#1029 §3).
//!
//! `SystemTime::now()`, a thread, a file, a socket and an ambient RNG are all
//! things a rule could reach for, and none of them belongs in this crate: time
//! and randomness are **inputs** to the rules, never globals they take for
//! themselves, because a rule that reads a clock is a rule no test can pin and
//! no adapter can replay.
//!
//! THIS SCAN USED TO BE `wasm_clean.rs`, and its stated reason was that the
//! hosted adapter compiled this crate to `wasm32-unknown-unknown`, where
//! `SystemTime::now()` compiles and then panics. That adapter is struck from v0
//! (#1029, scope amendment 2026-09-21) and the `wasm32` target went with it. The property did not go with it: purity is
//! what makes `time::ServerTime` an argument and `conformance` a suite that can
//! run anywhere, and it is the same property W17 needs when the transport
//! changes underneath these rules. The deployment-discriminator half of the old
//! file DID go — one protocol with two deployments was its whole subject, and
//! there is one deployment.
//!
//! A CLAIM NAMES ITS GREP, and this file is the grep.

use std::fs;
use std::path::{Path, PathBuf};

fn source_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn sources() -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(&source_root(), &mut found);
    found.sort();
    assert!(
        found.len() >= 10,
        "only {} source files were scanned, which is not this crate",
        found.len()
    );
    found
}

fn walk(dir: &Path, into: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("the source tree reads").flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, into);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            into.push(path);
        }
    }
}

/// What a rule must never reach for, and why each one is here.
const FORBIDDEN: &[(&str, &str)] = &[
    (
        "SystemTime::now",
        "an ambient clock. Time is an INPUT here — take a `ServerTime` — so a \
         rule can be replayed, pinned by a test and driven by any adapter. This \
         is also the reach that used to compile for wasm32 and panic at run \
         time, which is how it got onto the list",
    ),
    ("Instant::now", "an ambient clock, same reason"),
    (
        "std::thread",
        "a rule decides; it does not run work. Concurrency is the adapter's",
    ),
    (
        "std::fs",
        "there is no filesystem. Bytes are behind `ByteStore`",
    ),
    (
        "std::net",
        "there are no sockets here. The gateway is reached through its adapter",
    ),
    (
        "std::process",
        "nothing in a rule shells out, on any target",
    ),
    (
        "std::env",
        "configuration is an argument, not an ambient variable",
    ),
    (
        "rand::",
        "ambient randomness. Anything random — an entry id, a capability id — \
         is passed in by the adapter, which has the platform's generator",
    ),
    (
        "OsRng",
        "ambient randomness, same reason: the adapter has the platform's \
         generator and this crate does not assume one",
    ),
    (
        "tokio",
        "a runtime. The ports are `async fn` with no `Send` bound precisely so \
         that the adapter's own scheduler drives them",
    ),
    (
        "rusqlite",
        "the SQL is `contracts/gateway/schema.sql` and the adapter applies it",
    ),
];

#[test]
fn no_rule_reaches_for_a_thread_a_file_an_ambient_clock_or_ambient_randomness() {
    let mut findings = Vec::new();
    for path in sources() {
        let text = fs::read_to_string(&path).expect("a source file reads");
        let file = path
            .strip_prefix(source_root())
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        for (number, line) in text.lines().enumerate() {
            let trimmed = line.trim_start();
            // A doc comment or a plain comment that NAMES one of these is
            // explaining why it is absent, which is the opposite of a finding —
            // and most of them do, at length.
            if trimmed.starts_with("//") {
                continue;
            }
            for (needle, reason) in FORBIDDEN {
                if line.contains(needle) {
                    findings.push(format!("{file}:{}: `{needle}` — {reason}", number + 1));
                }
            }
        }
    }
    assert!(
        findings.is_empty(),
        "`crates/gateway-core` is a pure state machine (#1029 §3): time and \
         randomness are inputs to the rules, never globals they reach for. \
         These lines break that:\n{}",
        findings.join("\n")
    );
}

/// The scan has to be able to find something, or it is a test that always
/// passes.
#[test]
fn the_scan_would_catch_a_real_reach() {
    let sample = "let now = std::time::SystemTime::now();";
    assert!(
        FORBIDDEN.iter().any(|(needle, _)| sample.contains(needle)),
        "the forbidden list no longer matches the reach it exists to catch"
    );
}
