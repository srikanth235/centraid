//! The root every path-based rule scans is the CURRENT tree's (#1020 wave 3).
//!
//! `repo_root()` used to be `env!("CARGO_MANIFEST_DIR")`, evaluated when the
//! binary is compiled. Wave 3's lanes share one `CARGO_TARGET_DIR` because
//! disk is tight, so the cached `xtask` belonged to whichever worktree built it
//! last and `sql-confinement`, `no-listening-socket`, `abi-five-symbols` and
//! `ts-static` all scanned THAT worktree — reporting clean over a tree nobody
//! asked about. Lanes E and F each hit it independently (E finding 8, F
//! finding 1) and between them saw three different answers from one command in
//! one tree.
//!
//! This test is the shape of that bug: it runs the **already-compiled** binary
//! from a second checkout and asserts the root it reports is the second
//! checkout's, not the one it was compiled in. Before the fix it could not
//! pass, because the answer did not depend on the current directory at all.

use std::path::{Path, PathBuf};
use std::process::Command;

/// A second checkout of the same shape: the two marker files the root carries,
/// a `crates/xtask/src` to run from, and its own `git init` so the `git
/// rev-parse --show-toplevel` branch is the one under test.
fn second_checkout(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("xtask-second-{}-{label}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("crates/xtask/src")).expect("a second checkout");
    std::fs::write(dir.join("CONSTITUTION.md"), "a second checkout\n").expect("a constitution");
    std::fs::write(dir.join("Cargo.toml"), "[workspace]\nmembers = []\n").expect("a manifest");
    dir
}

fn git_init(dir: &Path) {
    let status = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(dir)
        .status()
        .expect("git is on PATH");
    assert!(status.success(), "git init in the second checkout");
}

fn reported_root(cwd: &Path) -> PathBuf {
    let output = Command::new(env!("CARGO_BIN_EXE_xtask"))
        .arg("repo-root")
        .current_dir(cwd)
        .output()
        .expect("the xtask binary runs");
    assert!(
        output.status.success(),
        "xtask repo-root: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    PathBuf::from(String::from_utf8(output.stdout).expect("utf-8").trim())
}

fn real(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[test]
fn the_binary_scans_the_checkout_it_runs_in_and_not_the_one_it_was_compiled_in() {
    let compiled_in = real(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
    );

    let checkout = second_checkout("git");
    git_init(&checkout);
    let from_a_subdirectory = reported_root(&checkout.join("crates/xtask/src"));
    assert_eq!(
        real(&from_a_subdirectory),
        real(&checkout),
        "the root must come from the current directory, through `git rev-parse --show-toplevel`"
    );
    assert_ne!(
        real(&from_a_subdirectory),
        compiled_in,
        "and must NOT be the tree this binary was compiled in — that is the bug (#1020)"
    );
    let _ = std::fs::remove_dir_all(&checkout);
}

/// The same answer with no `.git` at all: a tree exported as a tarball, or a
/// machine with no `git`. The walk-up branch carries it, and the fallback to
/// the baked path stays the third choice rather than the second.
#[test]
fn a_checkout_without_a_git_directory_is_still_found_by_walking_up() {
    let checkout = second_checkout("nogit");
    let reported = reported_root(&checkout.join("crates/xtask"));
    assert_eq!(real(&reported), real(&checkout));
    let _ = std::fs::remove_dir_all(&checkout);
}
