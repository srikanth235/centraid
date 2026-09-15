//! THE DEV SEEDER REFUSES A FILE THAT IS ALREADY A VAULT (#1025 S5).
//!
//! `seed-demo-vault` deletes `<dir>/<file>` and its `-wal`, `-shm` and
//! `.bytes` siblings before it founds, because a demo seeded on top of a
//! previous run has counts nobody can predict. Pointed at a gateway's own
//! vault directory — which is one `--file vault.db` away — that deleted the
//! vault a gateway was serving and founded a new one under a new `vault_id` in
//! a directory still named after the old one. It printed `CENTRAID_SEEDED` and
//! looked like a success; a seat then bootstrapped off it and drew the founding
//! state while `MAX(seq)` in the log had gone 1101 → 146.
//!
//! This is the guard, tested through the shipped binary rather than through the
//! function: the refusal has to happen before the removal, and "before" is a
//! property of `main`, not of a helper.

use std::process::Command;

/// Run the seeder and hand back `(status code, stderr)`.
fn seed(dir: &std::path::Path, file: &str, extra: &[&str]) -> (Option<i32>, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_seed-demo-vault"))
        .arg(dir)
        .arg("--file")
        .arg(file)
        // The smallest scenario there is: this test is about the guard, not
        // about the corpus, and seeding seven apps to assert one refusal would
        // put photograph bytes in the way of a unit of behaviour.
        .args(["--only", "tasks"])
        .args(extra)
        .output()
        .expect("the seeder binary runs");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// Found a vault at `path` and answer its id.
fn found(path: &std::path::Path) -> String {
    let vault = centraid_vault::Vault::create(path).expect("a vault is founded");
    vault.found("Someone's Vault", "Owner").expect("founded");
    let id = vault
        .vault_id()
        .expect("it reads")
        .expect("a founded vault has an id");
    vault.close().expect("it closes");
    id
}

#[test]
fn the_seeder_refuses_a_file_that_already_holds_a_vault_and_names_it() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let path = dir.path().join("vault.db");
    let vault_id = found(&path);

    let (code, complaint) = seed(dir.path(), "vault.db", &[]);
    assert_eq!(code, Some(2), "the seeder did not refuse: {complaint}");
    // BY NAME. The id is what tells a caller which vault they were about to
    // lose; the path is what tells them how they got there.
    assert!(
        complaint.contains(&vault_id),
        "the refusal did not name the vault it found: {complaint}"
    );
    assert!(
        complaint.contains("vault.db"),
        "the refusal did not name the file: {complaint}"
    );
    assert!(
        complaint.contains("--force"),
        "the refusal offered no way past: {complaint}"
    );

    // AND THE VAULT IS STILL THERE, whole, with the id it had. This is the
    // assertion the defect would have failed: the removal runs before the
    // founding, so a guard that fired too late would leave no file at all.
    let vault = centraid_vault::Vault::open(&path).expect("the vault is still a vault");
    assert_eq!(
        vault.vault_id().expect("reads"),
        Some(vault_id),
        "the refused run changed the vault's identity anyway"
    );
    vault.close().expect("it closes");
}

/// A FILE THAT IS NOT A VAULT IS NOT A REFUSAL. An empty file left by an
/// aborted run — and a path that does not exist at all — is exactly what this
/// tool is for, and a guard that refused those would have made the seeder
/// unusable rather than safe.
#[test]
fn the_seeder_still_seeds_an_empty_directory_and_a_file_that_is_not_a_vault() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let (code, complaint) = seed(dir.path(), "demo.db", &[]);
    assert_eq!(code, Some(0), "a fresh directory was refused: {complaint}");

    let leftover = dir.path().join("aborted.db");
    std::fs::write(&leftover, b"not a database").expect("written");
    let (code, complaint) = seed(dir.path(), "aborted.db", &[]);
    assert_eq!(
        code,
        Some(0),
        "a file that is not a vault was refused: {complaint}"
    );
}

/// `--force` IS THE WAY PAST, and it says so on the way through: a caller who
/// meant it gets a line naming what they overwrote.
#[test]
fn force_overwrites_a_vault_and_says_which_one() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let path = dir.path().join("vault.db");
    let vault_id = found(&path);

    let (code, said) = seed(dir.path(), "vault.db", &["--force"]);
    assert_eq!(code, Some(0), "--force was refused anyway: {said}");
    assert!(
        said.contains(&vault_id),
        "--force overwrote a vault without naming it: {said}"
    );
    // A NEW VAULT, which is what `--force` asked for. The old id is gone and
    // the caller was told so before it went.
    let vault = centraid_vault::Vault::open(&path).expect("the seeded vault opens");
    assert_ne!(
        vault.vault_id().expect("reads"),
        Some(vault_id),
        "--force left the old vault in place, so it did nothing"
    );
    vault.close().expect("it closes");
}
