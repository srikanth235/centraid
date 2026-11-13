//! Founding is atomic (#1191, V17): a process really killed (SIGKILL) at each named stage of a
//! founding leaves either no vault at the path (and a path that can be founded again) or a vault
//! that opens whole, and no `.founding` side file survives the next open or founding.
//!
//! No timing is involved. The test binary runs itself as the child: `child_founds_and_stops` does
//! nothing unless `CENTRAID_FOUNDING_STAGE` names a stage, and then founds a vault with a stage
//! hook that prints a marker line and parks the thread when it reaches that stage. The parent reads
//! the marker and kills the child there, once per stage.

use std::io::{BufRead as _, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use centraid_vault::Vault;
use centraid_vault::stage::{self, Stage};

const STAGE: &str = "CENTRAID_FOUNDING_STAGE";
const DIR: &str = "CENTRAID_FOUNDING_DIR";

fn named(stage: Stage) -> &'static str {
    match stage {
        Stage::FoundingLaidDown => "laid-down",
        Stage::FoundingCheckpointed => "checkpointed",
        Stage::FoundingFlushed => "flushed",
        Stage::FoundingRenamed => "renamed",
        Stage::RungWritten => "rung-written",
    }
}

fn pause_at_the_named_stage(stage: Stage) -> std::io::Result<()> {
    if std::env::var(STAGE).as_deref() == Ok(named(stage)) {
        println!("STAGE {}", named(stage));
        loop {
            std::thread::park();
        }
    }
    Ok(())
}

#[test]
fn child_founds_and_stops() {
    let (Some(_), Some(dir)) = (
        std::env::var_os(STAGE),
        std::env::var_os(DIR).map(PathBuf::from),
    ) else {
        return;
    };
    stage::set_hook(Some(pause_at_the_named_stage));
    let vault = Vault::create(dir.join("vault.db")).expect("founds");
    vault.close().expect("closes");
}

fn side_files(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .expect("lists")
        .map(|entry| {
            entry
                .expect("an entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.contains(".founding"))
        .collect()
}

/// Kill a child founding at `stage`; the directory it was founding in.
fn killed_at(stage: &str) -> PathBuf {
    let dir = centraid_ontology::scratch::scratch_dir().join(format!("kill-{stage}"));
    std::fs::create_dir_all(&dir).expect("a directory");
    let exe = std::env::current_exe().expect("the test binary");
    let mut child = Command::new(exe)
        .args([
            "--exact",
            "child_founds_and_stops",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(STAGE, stage)
        .env(DIR, &dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the child starts");
    let marker = format!("STAGE {stage}");
    let lines = BufReader::new(child.stdout.take().expect("a pipe")).lines();
    let reached = lines
        .map_while(Result::ok)
        .any(|line| line.contains(&marker));
    assert!(reached, "the child never reached `{stage}`");
    child.kill().expect("SIGKILL");
    child.wait().expect("reaped");
    dir
}

#[test]
fn a_process_killed_mid_founding_leaves_a_vault_that_founds_again() {
    // Before the rename the vault is not there, only its side file; after it the vault is whole.
    for (stage, vault_exists) in [
        ("laid-down", false),
        ("checkpointed", false),
        ("flushed", false),
        ("renamed", true),
    ] {
        let dir = killed_at(stage);
        let vault_file = dir.join("vault.db");
        assert_eq!(
            vault_file.exists(),
            vault_exists,
            "at `{stage}` the vault file {} be there",
            if vault_exists { "should" } else { "should not" }
        );
        if vault_exists {
            let vault = Vault::open(&vault_file)
                .unwrap_or_else(|error| panic!("`{stage}`: the vault does not open: {error}"));
            vault.close().expect("closes");
        } else {
            assert!(
                !side_files(&dir).is_empty(),
                "at `{stage}` the kill left the side file the next founding removes"
            );
            // A path whose founding was killed founds again, and opens.
            let vault = Vault::create(&vault_file)
                .unwrap_or_else(|error| panic!("`{stage}`: cannot found again: {error}"));
            vault.close().expect("closes");
            Vault::open(&vault_file)
                .unwrap_or_else(|error| panic!("`{stage}`: the new vault does not open: {error}"))
                .close()
                .expect("closes");
        }
        assert!(
            side_files(&dir).is_empty(),
            "`{stage}`: a side file survived the next open or founding: {:?}",
            side_files(&dir)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

static ARRIVED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static RELEASE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn hold_the_founding(stage: Stage) -> std::io::Result<()> {
    use std::sync::atomic::Ordering::SeqCst;
    if stage == Stage::FoundingLaidDown {
        ARRIVED.store(true, SeqCst);
        while !RELEASE.load(SeqCst) {
            std::thread::yield_now();
        }
    }
    Ok(())
}

/// An `open` of a path that is being founded on another thread does not remove the founding's
/// side file: the founding still lands, and the vault opens.
#[test]
fn an_open_during_a_founding_leaves_its_side_file_alone() {
    use std::sync::atomic::Ordering::SeqCst;
    let dir = centraid_ontology::scratch::scratch_dir().join("open-during-founding");
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    let founding = {
        let path = path.clone();
        std::thread::spawn(move || {
            stage::set_hook(Some(hold_the_founding));
            Vault::create(&path).map(|vault| vault.close())
        })
    };
    while !ARRIVED.load(SeqCst) {
        std::thread::yield_now();
    }
    assert!(!side_files(&dir).is_empty(), "the founding has a side file");
    assert!(
        matches!(
            Vault::open(&path),
            Err(centraid_vault::VaultError::Missing { .. })
        ),
        "nothing is at the name yet"
    );
    assert!(
        !side_files(&dir).is_empty(),
        "the open removed the side file a founding was still building"
    );
    RELEASE.store(true, SeqCst);
    founding
        .join()
        .expect("the founding thread")
        .expect("the founding lands")
        .expect("closes");
    Vault::open(&path).expect("opens").close().expect("closes");
    let _ = std::fs::remove_dir_all(&dir);
}
