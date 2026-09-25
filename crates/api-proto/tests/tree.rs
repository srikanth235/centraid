//! The proto tree and `build.rs`'s list agree, and the two packages stay two.
//!
//! `build.rs` names every file rather than globbing, so a `.proto` added to the
//! tree and not to the list would generate nothing and be discovered by a
//! missing type at some later call site. This test is the shorter path to that
//! answer.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn proto_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("proto")
}

fn every_proto(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("read the proto tree").flatten() {
        let path = entry.path();
        if path.is_dir() {
            every_proto(&path, out);
        } else if path.extension().is_some_and(|found| found == "proto") {
            out.push(path);
        }
    }
}

fn relative_protos() -> BTreeSet<String> {
    let root = proto_root();
    let mut found = Vec::new();
    every_proto(&root, &mut found);
    found
        .into_iter()
        .map(|path| {
            path.strip_prefix(root.parent().expect("a crate dir"))
                .expect("under the crate")
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect()
}

/// Read `build.rs`'s `PROTOS` list back out of its own source. Reading the
/// source is deliberate: the alternative is a third copy of the list in a
/// shared constant, and a third copy is a third thing to forget.
fn listed_protos() -> BTreeSet<String> {
    let source = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("build.rs"))
        .expect("read build.rs");
    let (_, after) = source
        .split_once("const PROTOS")
        .expect("build.rs declares PROTOS");
    let (block, _) = after.split_once("];").expect("the list closes");
    block
        .split('"')
        .filter(|piece| piece.ends_with(".proto"))
        .map(str::to_owned)
        .collect()
}

#[test]
fn every_proto_in_the_tree_is_compiled() {
    let on_disk = relative_protos();
    let listed = listed_protos();
    assert_eq!(
        on_disk, listed,
        "build.rs's PROTOS list and proto/ disagree — a file in one and not the other either \
         generates nothing or names a file that is gone (#1020)"
    );
}

/// Two packages, and exactly two. A third would need its own `buf breaking`
/// promise in `buf.yaml`, and one added without it would inherit whichever
/// module's config matched first.
#[test]
fn there_are_exactly_two_packages_and_each_file_declares_its_own() {
    let root = proto_root();
    let mut files = Vec::new();
    every_proto(&root, &mut files);
    let mut packages = BTreeSet::new();
    for file in &files {
        let source = fs::read_to_string(file).expect("read a proto");
        let declared = source
            .lines()
            .find_map(|line| line.trim().strip_prefix("package ")?.strip_suffix(';'))
            .unwrap_or_else(|| panic!("{} declares no package", file.display()))
            .to_owned();
        // The package must match the directory, which is what `buf lint`'s
        // STANDARD rules require and what makes the per-module config in
        // buf.yaml address the right files.
        let expected = file
            .parent()
            .expect("a parent")
            .strip_prefix(&root)
            .expect("under proto/")
            .to_string_lossy()
            .replace(['/', '\\'], ".");
        assert_eq!(
            declared,
            expected,
            "{} declares `{declared}` but lives in `{expected}`",
            file.display()
        );
        packages.insert(declared);
    }
    assert_eq!(
        packages.into_iter().collect::<Vec<_>>(),
        ["centraid.core.v1", "centraid.screen.v1"]
    );
}
