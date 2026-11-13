//! A commit is all or nothing across a real process kill (#1191, V17/V18). A child opens a vault,
//! starts one large commit (enough rows that SQLite spills WAL frames before it commits), and a
//! stage hook parks it either just before `COMMIT` or just after. The parent kills it there with
//! SIGKILL, opens the vault, and checks the write is absent (killed before) or whole (killed
//! after), and that the file passes its quick check, which `open` runs.

use std::io::{BufRead as _, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use centraid_vault::Vault;
use centraid_vault::stage::{self, Stage};

const STAGE: &str = "CENTRAID_COMMIT_STAGE";
const DIR: &str = "CENTRAID_COMMIT_DIR";
const ROWS: i64 = 6_000;

fn pause_at_the_named_stage(stage: Stage) -> std::io::Result<()> {
    let (name, wanted) = match stage {
        Stage::BeforeCommit => ("before-commit", "before-commit"),
        Stage::Committed => ("committed", "committed"),
        _ => return Ok(()),
    };
    if std::env::var(STAGE).as_deref() == Ok(wanted) {
        println!("STAGE {name}");
        loop {
            std::thread::park();
        }
    }
    Ok(())
}

#[test]
fn child_commits_and_stops() {
    let (Some(_), Some(dir)) = (
        std::env::var_os(STAGE),
        std::env::var_os(DIR).map(PathBuf::from),
    ) else {
        return;
    };
    let vault = Vault::open(dir.join("vault.db")).expect("opens");
    stage::set_hook(Some(pause_at_the_named_stage));
    vault
        .commit(|tx| {
            tx.connection().execute_batch(&format!(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {ROWS})
                 INSERT INTO entity (id, kind, title, created_at, updated_at)
                 SELECT 'big-' || i, 'note', 'T' || i, '2026-03-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z' FROM n;
                 INSERT INTO note (id, body)
                 SELECT id, printf('%02000d', rowid) FROM entity WHERE id LIKE 'big-%';"
            ))?;
            Ok(())
        })
        .expect("commits");
}

fn killed_at(stage: &str) -> PathBuf {
    let dir = centraid_ontology::scratch::scratch_dir().join(format!("commit-kill-{stage}"));
    std::fs::create_dir_all(&dir).expect("a directory");
    let vault = Vault::create(dir.join("vault.db")).expect("founds");
    vault.found("Home", "Ada").expect("founds");
    vault.finish().expect("closes");
    let exe = std::env::current_exe().expect("the test binary");
    let mut child = Command::new(exe)
        .args([
            "--exact",
            "child_commits_and_stops",
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
    let reached = BufReader::new(child.stdout.take().expect("a pipe"))
        .lines()
        .map_while(Result::ok)
        .any(|line| line.contains(&marker));
    assert!(reached, "the child never reached `{stage}`");
    child.kill().expect("SIGKILL");
    child.wait().expect("reaped");
    dir
}

fn notes(dir: &std::path::Path) -> i64 {
    let vault = Vault::open(dir.join("vault.db")).expect("a killed commit opens clean");
    let count = vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM entity WHERE id LIKE 'big-%'",
                [],
                |r| r.get(0),
            )?)
        })
        .expect("counts");
    vault.finish().expect("closes");
    count
}

#[test]
fn a_process_killed_mid_commit_loses_the_commit_and_opens_clean() {
    let dir = killed_at("before-commit");
    assert!(
        std::fs::read_dir(&dir).expect("lists").any(|e| e
            .expect("an entry")
            .file_name()
            .to_string_lossy()
            .ends_with("-wal")),
        "the kill left a WAL beside the vault, which the open must recover"
    );
    assert_eq!(notes(&dir), 0, "the write that never committed is absent");
    let _ = std::fs::remove_dir_all(&dir);

    let dir = killed_at("committed");
    assert_eq!(
        notes(&dir),
        ROWS,
        "a commit that returned is whole after the kill"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
