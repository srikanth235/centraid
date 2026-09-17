//! WASM-CLEAN BY CONSTRUCTION, as a scan (#1029 §3).
//!
//! W4c compiles this crate to `wasm32-unknown-unknown` for a Cloudflare Worker.
//! `cargo check --target wasm32-unknown-unknown` proves the crate *compiles*
//! there, and that is the exit item — but it is not enough on its own, and that
//! is the point of this file:
//!
//! - **`SystemTime::now()` compiles for that target and panics when called.** A
//!   rule that reached for it would pass every test here and die in production,
//!   in a Worker somebody is paying for, with a trace nobody can read.
//! - `std::thread`, `std::fs`, `std::net` and `std::process` mostly do not
//!   compile there, so the check would catch them — but only once somebody runs
//!   it, and the whole reason this is held now rather than in W4c is that a
//!   retrofit is a rewrite.
//!
//! So the scan and the target check answer different halves, and both are
//! cheap. A CLAIM NAMES ITS GREP, and this file is the grep.

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
        "an ambient clock. It COMPILES for wasm32-unknown-unknown and PANICS \
         when called, so this is the one that would survive every test and die \
         in a Worker. Time is an input: take a `ServerTime`",
    ),
    (
        "Instant::now",
        "an ambient clock, same reason — and a monotonic one is not available \
         in a Worker at all",
    ),
    (
        "std::thread",
        "a Worker isolate is single-threaded and wasm32-unknown-unknown has no \
         thread support. A rule that spawned would not link",
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
        "configuration is an argument, not an ambient variable a Worker does \
         not have",
    ),
    (
        "rand::",
        "ambient randomness. Anything random — an entry id, a capability id — \
         is passed in by the adapter, which has the platform's generator",
    ),
    (
        "OsRng",
        "ambient randomness, same reason, and `getrandom` needs a backend a \
         Worker supplies rather than one this crate assumes",
    ),
    (
        "tokio",
        "a runtime. The ports are `async fn` with no `Send` bound precisely so \
         that a Worker's own scheduler can drive them",
    ),
    (
        "rusqlite",
        "the SQL is `contracts/gateway/schema.sql` and the adapters apply it. \
         A Durable Object's SQLite is not this one",
    ),
];

/// A gateway-mode discriminator, which this crate does not have and is not
/// going to.
///
/// The repository already carries this rule for v0's `packages/server/`
/// (`.governance/.../gateway-engine-mode-agnostic`): *the "same code, three
/// hosts" property breaks the moment the engine starts checking which host it
/// is living in.* The subject moved to this crate with #1029 and the reasoning
/// did not change — "one protocol, two deployments" is the same promise.
const MODE_DISCRIMINATORS: [&str; 6] = [
    "GatewayMode",
    "gateway_mode",
    "is_hosted",
    "is_standalone",
    "is_cloudflare",
    "deployment_mode",
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
        "`crates/gateway-core` compiles to wasm32-unknown-unknown for a \
         Cloudflare Worker (#1029 §3). These lines would break that, or would \
         compile and then panic there:\n{}",
        findings.join("\n")
    );
}

#[test]
fn no_rule_branches_on_which_deployment_it_is_running_in() {
    let mut findings = Vec::new();
    for path in sources() {
        let text = fs::read_to_string(&path).expect("a source file reads");
        let file = path
            .strip_prefix(source_root())
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        for (number, line) in text.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for needle in MODE_DISCRIMINATORS {
                if line.contains(needle) {
                    findings.push(format!("{file}:{}: `{needle}`", number + 1));
                }
            }
        }
    }
    assert!(
        findings.is_empty(),
        "one protocol, two deployments (#1029 §3): a rule that knows which \
         adapter it is inside is a rule that will differ between them. What \
         genuinely differs goes behind `ByteStore`, `StateStore` or \
         `ChecksumMode`:\n{}",
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
    let sample = "if self.gateway_mode == Hosted {";
    assert!(
        MODE_DISCRIMINATORS
            .iter()
            .any(|needle| sample.contains(needle))
    );
}
