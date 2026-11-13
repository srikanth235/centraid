//! Founding is atomic (#1191, V17): a process really killed (SIGKILL) while it founds vaults
//! leaves, for each path it was at, either no file that can be founded over, or a vault that
//! opens. Never a file that is neither.
//!
//! The test binary runs itself as the child: `child_founds_vaults_until_killed` does nothing
//! unless `CENTRAID_FOUNDING_CHILD` names a directory, and then founds vault after vault in it.
//! The parent kills it after a different delay each round, so the kill lands in different
//! steps of the founding (the side file written, checkpointed, flushed, renamed).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use centraid_vault::Vault;

const CHILD: &str = "CENTRAID_FOUNDING_CHILD";

#[test]
fn child_founds_vaults_until_killed() {
    let Some(dir) = std::env::var_os(CHILD).map(PathBuf::from) else {
        return;
    };
    for index in 0..10_000 {
        let at = dir.join(format!("v{index:05}"));
        std::fs::create_dir_all(&at).expect("a directory");
        let vault = Vault::create(at.join("vault.db")).expect("founds");
        vault.found("Home", "Ada").expect("owner");
        vault.close().expect("closes");
    }
}

/// What a path may be after a kill: absent and foundable, or a vault that opens.
fn settled(at: &Path) {
    let vault_file = at.join("vault.db");
    if vault_file.exists() {
        let vault = Vault::open(&vault_file).unwrap_or_else(|error| {
            panic!("{} exists and does not open: {error}", vault_file.display())
        });
        vault.close().expect("closes");
    } else {
        let vault = Vault::create(&vault_file).unwrap_or_else(|error| {
            panic!(
                "{} is absent and cannot be founded: {error}",
                vault_file.display()
            )
        });
        vault.close().expect("closes");
    }
}

#[test]
fn a_process_killed_while_founding_leaves_a_vault_that_opens_or_nothing() {
    let exe = std::env::current_exe().expect("the test binary");
    let mut mid_founding = 0;
    for (round, delay_ms) in [0_u64, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]
        .into_iter()
        .enumerate()
    {
        let dir = centraid_ontology::scratch::scratch_dir().join(format!("kill-{round}"));
        std::fs::create_dir_all(&dir).expect("a directory");
        let mut child = Command::new(&exe)
            .args([
                "--exact",
                "child_founds_vaults_until_killed",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD, &dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the child starts");
        std::thread::sleep(Duration::from_millis(delay_ms * 4 + 150));
        child.kill().expect("SIGKILL");
        child.wait().expect("reaped");

        let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
            .expect("lists")
            .map(|entry| entry.expect("an entry").path())
            .collect();
        paths.sort();
        for at in &paths {
            if std::fs::read_dir(at).expect("lists").any(|entry| {
                entry
                    .expect("an entry")
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".founding")
            }) {
                mid_founding += 1;
            }
            settled(at);
        }
        assert!(
            !paths.is_empty(),
            "the child founded nothing in round {round}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    // Not asserted to be nonzero (the kill is wherever it lands), but reported: how many rounds
    // were cut in the middle of a founding, where the side file was left behind.
    eprintln!("rounds killed mid-founding: {mid_founding}");
}
