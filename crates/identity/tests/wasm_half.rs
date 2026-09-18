//! THE WASM-CLEAN HALF IS A LINE, AND THIS IS THE GREP THAT HOLDS IT
//! (#1029 §3, W4C-1).
//!
//! A Cloudflare Worker must decode and verify a
//! [`centraid_identity::DeviceCertificate`] — a fixed 104-byte layout — and must
//! not carry a DNS client, a URL parser or a random generator. `Cargo.toml`
//! draws that line with two default-on features, `discovery` and `mint`, and
//! `cargo check -p centraid-identity --no-default-features --target
//! wasm32-unknown-unknown` is the proof that it holds *today*.
//!
//! This file is why it keeps holding. The check above runs in the gate on one
//! profile; a module added next month that reaches for `pkarr` from
//! `certificate.rs` would be caught there and nowhere near the line that caused
//! it. Here the failure names the file.
//!
//! **What it cannot catch** is a reach spelled through a re-export or a macro,
//! and the `--target wasm32-unknown-unknown` check is what catches that. Two
//! mechanisms, one claim — the cheap one loud and local, the dear one complete.

use std::path::{Path, PathBuf};

/// The modules that compile to `wasm32-unknown-unknown` with no features on.
/// `discovery.rs` and `record.rs` are deliberately absent: they are the half
/// this split exists to leave behind.
const WASM_HALF: [&str; 6] = [
    "account.rs",
    "certificate.rs",
    "derive.rs",
    "phrase.rs",
    "safety_number.rs",
    "sealed_box.rs",
];

/// What the wasm half may not reach for, and what each one would drag in.
const FORBIDDEN: [(&str, &str); 4] = [
    ("pkarr", "a signed-DNS client that binds sockets"),
    (
        "url::",
        "a URL parser the certificate layout has no use for",
    ),
    (
        "base64",
        "the record encoding, which lives on the discovery half",
    ),
    (
        "rand::",
        "operating-system entropy, which `wasm32-unknown-unknown` has no \
         backend for unless one is named in RUSTFLAGS",
    ),
];

fn source_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// Lines outside `#[cfg(feature = "mint")]` items, with comments dropped.
///
/// A comment naming one of these is explaining why it is absent, which is the
/// opposite of a finding; a `mint`-gated item is the entropy half and is
/// allowed to name `rand`, which is what the feature is for.
fn judged_lines(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut gated = false;
    let mut gate_indent = 0;
    for (number, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        if trimmed.starts_with("//") {
            continue;
        }
        if trimmed.starts_with("#[cfg(feature = \"mint\")]") {
            gated = true;
            gate_indent = indent;
            continue;
        }
        if gated {
            // The gated item ends at the first line back at or above its own
            // indentation that closes it — a `}` at the gate's indentation.
            if trimmed == "}" && indent <= gate_indent {
                gated = false;
            }
            continue;
        }
        out.push((number + 1, trimmed.to_owned()));
    }
    out
}

/// THE WASM HALF NAMES NOTHING THE DISCOVERY HALF OWNS.
#[test]
fn the_wasm_clean_modules_reach_for_no_socket_no_url_and_no_entropy() {
    let mut findings = Vec::new();
    for module in WASM_HALF {
        let path = source_root().join(module);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{module} reads: {error}"));
        for (number, line) in judged_lines(&text) {
            for (needle, why) in FORBIDDEN {
                if line.contains(needle) {
                    findings.push(format!("{module}:{number}: `{needle}` — {why}"));
                }
            }
        }
    }
    assert!(
        findings.is_empty(),
        "these lines put something on the wasm-clean half of this crate that a \
         Cloudflare Worker cannot carry (#1029 §3). Either it belongs on the \
         `discovery` half with `record.rs` and `discovery.rs`, or it belongs \
         behind the `mint` feature:\n{}",
        findings.join("\n")
    );
}

/// THE HALF IS THE WHOLE CRATE MINUS TWO MODULES, AND NOBODY ADDED A THIRD
/// QUIETLY.
///
/// The test above is satisfied by a crate whose modules were all renamed. This
/// one notices a new module, which is the moment to decide which half it is on
/// rather than discovering the answer from a wasm build six weeks later.
#[test]
fn every_module_in_this_crate_is_on_one_declared_half_or_the_other() {
    let mut modules: Vec<String> = std::fs::read_dir(source_root())
        .expect("the source tree reads")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".rs") && name != "lib.rs")
        .collect();
    modules.sort();

    let mut declared: Vec<String> = WASM_HALF.iter().map(|name| (*name).to_owned()).collect();
    declared.push("discovery.rs".to_owned());
    declared.push("record.rs".to_owned());
    declared.sort();

    assert_eq!(
        modules, declared,
        "a module here is on neither declared half. The wasm-clean half is \
         `WASM_HALF` in this file and compiles with `--no-default-features`; \
         the discovery half is `discovery.rs` and `record.rs`, behind the \
         `discovery` feature. Put the new one on one of them"
    );
}
