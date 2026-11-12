//! THE DEBUG-ONLY LOADERS CANNOT SHIP (#1188). The chat has two ways to be pointed at something a
//! member never chose: a scripted model (`CENTRAID_DEV_CHAT_SCRIPT`, and the file an Android debug
//! build is pushed) and a model named by repo and commit (`CENTRAID_DEV_MODEL`). Each exists only
//! under `debug_assertions`. A test that only runs under a release profile proves nothing in a
//! gate that has none, so the proof is made of what the gate does run:
//!
//! * the release build's linked outputs (the core's shared and static libraries and binaries; not
//!   the rlibs, whose metadata carries doc comments) hold none of the names, and the scan fails
//!   when it found no core library to look in;
//! * every place a name is read in source sits in a function gated on `debug_assertions`, with a
//!   release twin that looks at nothing.

use std::fs;
use std::path::{Path, PathBuf};

/// What a release build must not contain.
pub const NEEDLES: [&str; 4] = [
    "CENTRAID_DEV_CHAT_SCRIPT",
    "CENTRAID_DEV_MODEL",
    "centraid-dev-chat-script.json",
    "CENTRAID_DEV_MODEL_SHA256",
];

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// A linked output of a release build: a shared or static library, or an executable.
fn linked(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if name.starts_with('.')
        || name.ends_with(".d")
        || name.ends_with(".rlib")
        || name.ends_with(".rmeta")
    {
        return false;
    }
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("so" | "dylib" | "a" | "dll") | None
    )
}

/// The names found in the release outputs of `dir` (`target/release`), and the outputs looked at.
/// Errors name a directory that cannot be read.
pub fn scan_release(dir: &Path) -> std::io::Result<(Vec<String>, Vec<PathBuf>)> {
    let mut found = Vec::new();
    let mut looked = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if !path.is_file() || !linked(&path) {
            continue;
        }
        let bytes = fs::read(&path)?;
        for needle in NEEDLES {
            if contains(&bytes, needle.as_bytes()) {
                found.push(format!("{} holds `{needle}`", path.display()));
            }
        }
        looked.push(path);
    }
    Ok((found, looked))
}

/// The gate's verdict on a release directory: `Ok` with what it looked at, or why not.
pub fn release_verdict(dir: &Path) -> Result<String, String> {
    let (found, looked) = scan_release(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if !found.is_empty() {
        return Err(format!(
            "a debug-only loader reached a release build: {}",
            found.join("; ")
        ));
    }
    if !looked.iter().any(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains("centraid_core_ffi"))
    }) {
        return Err(format!(
            "no core library under {} to look in; the scan would prove nothing",
            dir.display()
        ));
    }
    Ok(format!(
        "{} release outputs hold none of the debug-only loader names",
        looked.len()
    ))
}

/// Where a name is read in source and the read is not inside a function gated on
/// `debug_assertions`.
pub fn source_gaps(root: &Path) -> Vec<String> {
    let mut gaps = Vec::new();
    let mut files = Vec::new();
    walk(&root.join("crates"), &mut files);
    for file in files {
        let Ok(text) = fs::read_to_string(&file) else {
            continue;
        };
        let lines: Vec<&str> = text.lines().collect();
        for (at, line) in lines.iter().enumerate() {
            // a read: the name as a string literal handed to the environment or a path
            if !NEEDLES.iter().any(|needle| {
                line.contains(&format!("\"{needle}\""))
                    || line.contains(&format!("\"/data/local/tmp/{needle}\""))
            }) {
                continue;
            }
            if line.trim_start().starts_with("//") || file.ends_with("dev_paths.rs") {
                continue;
            }
            // the nearest `fn` above, and the attributes right over it
            let Some(function) = (0..=at)
                .rev()
                .find(|n| lines[*n].trim_start().contains("fn "))
            else {
                continue;
            };
            let gated = (0..function)
                .rev()
                .take_while(|n| {
                    let line = lines[*n].trim_start();
                    line.starts_with("#[") || line.starts_with("///") || line.starts_with("//")
                })
                .any(|n| {
                    lines[n].contains("debug_assertions")
                        && !lines[n].contains("not(debug_assertions)")
                });
            if !gated {
                gaps.push(format!(
                    "{}:{}: reads a debug-only name outside a `debug_assertions` function",
                    file.display(),
                    at + 1
                ));
            }
        }
    }
    gaps
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let skip = path
            .file_name()
            .is_some_and(|name| name == "target" || name == "tests");
        if path.is_dir() && !skip {
            walk(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_read_of_a_debug_only_name_is_in_a_debug_assertions_function() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        assert_eq!(source_gaps(&root), Vec::<String>::new());
    }

    #[test]
    fn a_release_output_holding_a_name_is_caught_and_a_clean_one_passes() {
        let dir = crate::testing::fixture_dir("dev-paths");
        fs::write(
            dir.join("libcentraid_core_ffi.so"),
            b"xx CENTRAID_DEV_MODEL xx",
        )
        .unwrap();
        assert!(
            release_verdict(&dir)
                .unwrap_err()
                .contains("CENTRAID_DEV_MODEL")
        );
        fs::write(dir.join("libcentraid_core_ffi.so"), b"nothing here").unwrap();
        assert!(release_verdict(&dir).is_ok());
        // nothing to look in is a failure, not a pass
        fs::remove_file(dir.join("libcentraid_core_ffi.so")).unwrap();
        fs::write(dir.join("other"), b"x").unwrap();
        assert!(
            release_verdict(&dir)
                .unwrap_err()
                .contains("no core library")
        );
    }
}
