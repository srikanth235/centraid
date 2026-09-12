//! The v1 schema authority: open a vault file, know its shape, verify it.
//!
//! First crate of the v1 tree
//! ([#1020](https://github.com/srikanth235/centraid/issues/1020)). This commit
//! is the workspace's foundation and carries only the two version constants
//! everything else compares against; the file reading, the golden-corpus
//! digest port, the doctor and the commitments arrive with the fixtures under
//! `contracts/` that they are held to.

#![forbid(unsafe_code)]

/// The ontology CONTRACT version — a property of the file and of a command
/// contract, never a per-row stamp (v0 `schema/migrate.ts`, ruling ONT-04).
pub const ONTOLOGY_VERSION: &str = "1.0";

/// The file SHAPE this build understands, `PRAGMA user_version`. It is the
/// number the #929 golden corpus carries, because opening that corpus is wave
/// 1's checkpoint and this crate ports no migration rungs.
pub const EXPECTED_USER_VERSION: i64 = 7;

#[cfg(test)]
mod tests {
    #[test]
    fn the_version_constants_are_the_ones_the_corpus_carries() {
        assert_eq!(super::ONTOLOGY_VERSION, "1.0");
        assert_eq!(super::EXPECTED_USER_VERSION, 7);
    }
}
