//! WHAT THE INDEX FILE IS OWED, AND THAT PAYING IT LEAVES IT EXACTLY WHERE A REBUILD WOULD (#1214,
//! A15). A commit writes the queue (`search_owed`) in `vault.db`, in its own transaction; the index
//! file is written right after it and only then is the queue cleared, so a kill anywhere between
//! loses nothing; the idle pass writes the rest in bounded pieces; and a purge leaves nothing of the
//! entity in the file, while its number is never given to another.

mod common;

use std::io::{BufRead as _, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};

use centraid_vault::commands::Registry;
use centraid_vault::stage::{self, Stage};
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use common::index::{assert_equals_a_rebuild, drain, dump, dump_file, index_path};
use serde_json::{Value, json};

const AT: &str = "2020-01-01T00:00:00.000Z";

fn go(vault: &Vault, registry: &Registry, name: &str, input: Value) -> Value {
    let outcome = vault
        .execute(
            registry,
            &Principal::owner("phone"),
            &Command::new(name, input),
        )
        .expect("runs");
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
    outcome.output
}

/// How many rows of the live `search` table a word matches.
fn hits(vault: &Vault, table: &str, word: &str) -> i64 {
    vault
        .read(|c| {
            Ok(c.query_row(
                &format!("SELECT count(*) FROM {table} WHERE {table} MATCH ?1"),
                [word],
                |row| row.get(0),
            )?)
        })
        .expect("counts")
}

/// Change a note's words as a command's body would: through the commit guard, so the history and
/// the queue see it.
fn edit(vault: &Vault, id: &str, body: &str) {
    vault
        .commit(|tx| {
            tx.set_producer("test.edit");
            tx.connection().execute(
                "UPDATE note SET body = ?2 WHERE id = ?1",
                rusqlite::params![id, body],
            )?;
            Ok(())
        })
        .expect("edits");
}

fn list(vault: &Vault, registry: &Registry, title: &str) -> String {
    let id = vault.ids().next();
    go(
        vault,
        registry,
        "container.create",
        json!({"id": id, "kind": "list", "title": title}),
    );
    id
}

fn owed_rows(vault: &Vault) -> i64 {
    vault
        .read(|c| Ok(c.query_row("SELECT count(*) FROM search_owed", [], |r| r.get(0))?))
        .expect("counts")
}

#[test]
fn a_commit_is_searchable_when_it_returns_and_owes_nothing() {
    let scratch = common::Scratch::founded("owed-now").expect("a vault");
    let vault = &scratch.vault;
    common::insert_note_with(vault, "Quokka diary", "met a marmoset today").expect("a note");
    assert_eq!(
        hits(vault, "search", "marmoset"),
        1,
        "its own write is read"
    );
    assert_eq!(hits(vault, "search", "quokka"), 1, "and its title");
    assert_eq!(
        owed_rows(vault),
        0,
        "the commit's own pass cleared its rows"
    );
    assert_equals_a_rebuild(scratch.dir(), "after one note");
}

#[test]
fn a_label_of_many_members_leaves_the_rest_owed_and_draining_it_equals_a_rebuild() {
    let scratch = common::Scratch::founded("owed").expect("a vault");
    let vault = &scratch.vault;
    let registry = Registry::with_system_commands().expect("a registry");
    let members = 230_usize;
    let club = list(vault, &registry, "Zebrafish Club");
    let people: Vec<String> = (0..members).map(|_| vault.ids().next()).collect();
    vault
        .commit(|tx| {
            for (n, id) in people.iter().enumerate() {
                common::add_person(tx, id, &format!("Person {n}"), AT)?;
            }
            Ok(())
        })
        .expect("people");
    for id in &people {
        go(
            vault,
            &registry,
            "edge.add",
            json!({"from": club, "rel": "contains", "to": id}),
        );
    }
    assert!(
        !vault.index_owed().expect("asks"),
        "a small label owes nothing"
    );
    assert_eq!(hits(vault, "search", "zebrafish"), members as i64);

    // Trashing the list takes its words from every member; only a piece lands in the commit.
    go(vault, &registry, "entity.trash", json!({"id": club}));
    assert!(
        vault.index_owed().expect("asks"),
        "the rest of the members are owed"
    );
    let behind = dump(scratch.dir());
    let steps = drain(vault);
    assert!(steps > 1, "the owed rows took {steps} batches");
    assert!(!vault.index_owed().expect("asks"));
    assert_ne!(
        behind,
        dump(scratch.dir()),
        "the index was behind until the batches ran"
    );
    assert_eq!(hits(vault, "search", "zebrafish"), 0);
    assert_equals_a_rebuild(scratch.dir(), "drained after the label was trashed");

    // Restoring brings the words back the same way.
    go(vault, &registry, "entity.restore", json!({"id": club}));
    assert!(vault.index_owed().expect("asks"));
    drain(vault);
    assert_eq!(hits(vault, "search", "zebrafish"), members as i64);
    assert_equals_a_rebuild(scratch.dir(), "drained after the label was restored");
}

#[test]
fn after_any_run_of_creates_edits_renames_trashes_restores_and_purges_the_index_is_a_rebuilds() {
    let scratch = common::Scratch::founded("script").expect("a vault");
    let vault = &scratch.vault;
    let registry = Registry::with_system_commands().expect("a registry");
    let check = |when: &str| {
        drain(vault);
        assert_equals_a_rebuild(scratch.dir(), when);
    };

    let a = common::insert_note_with(vault, "Apple pie", "apples and bananas").expect("a note");
    let b = common::insert_note_with(vault, "Cherry notes", "cherries").expect("a note");
    check("after two notes");

    let pantry = list(vault, &registry, "Pantry");
    let cook = vault.ids().next();
    vault
        .commit(|tx| common::add_person(tx, &cook, "Ada Cook", AT))
        .expect("a person");
    go(
        vault,
        &registry,
        "edge.add",
        json!({"from": pantry, "rel": "contains", "to": cook}),
    );
    check("after a list holds a person");
    assert_eq!(hits(vault, "search", "pantry"), 1, "found by its list");

    edit(vault, &a, "apples and dates");
    check("after an edit dropped a word");
    assert_eq!(
        hits(vault, "search_past", "bananas"),
        1,
        "found in the past"
    );
    assert_eq!(hits(vault, "search", "bananas"), 0, "and not now");

    go(
        vault,
        &registry,
        "entity.retitle",
        json!({"id": pantry, "title": "Larder"}),
    );
    check("after the label was renamed");
    assert_eq!(hits(vault, "search", "pantry"), 0);
    assert_eq!(hits(vault, "search", "larder"), 1);

    go(vault, &registry, "entity.trash", json!({"id": b}));
    check("after a note was trashed");
    assert_eq!(hits(vault, "search", "cherries"), 0);
    go(vault, &registry, "entity.restore", json!({"id": b}));
    check("after it was restored");
    assert_eq!(hits(vault, "search", "cherries"), 1);

    edit(vault, &b, "cherries and figs");
    edit(vault, &b, "figs only");
    check("after more edits");

    go(vault, &registry, "entity.trash", json!({"id": b}));
    go(vault, &registry, "entity.purge", json!({"id": b}));
    check("after a purge");
    assert_eq!(hits(vault, "search", "figs"), 0);
    assert_eq!(
        hits(vault, "search_past", "cherries"),
        0,
        "the past went too"
    );

    // Trashing the holder takes what it holds, and a restore brings it back.
    go(vault, &registry, "entity.trash", json!({"id": pantry}));
    check("after a holder was trashed");
    go(vault, &registry, "entity.restore", json!({"id": pantry}));
    check("after a holder was restored");
}

#[test]
fn a_purge_removes_every_row_of_the_entity_and_its_number_is_never_given_again() {
    let scratch = common::Scratch::founded("purge").expect("a vault");
    let vault = &scratch.vault;
    let registry = Registry::with_system_commands().expect("a registry");
    let id = common::insert_note_with(vault, "Wombat plans", "burrows").expect("a note");
    edit(vault, &id, "tunnels");
    let n: i64 = vault
        .read(|c| Ok(c.query_row("SELECT n FROM entity WHERE id = ?1", [&id], |r| r.get(0))?))
        .expect("its number");
    assert_eq!(hits(vault, "search", "wombat"), 1);
    assert_eq!(hits(vault, "search_past", "burrows"), 1);
    // A point of its own, written as a photo's would be: raw rows, the geo writer is the queue's.
    vault
        .commit(|tx| {
            tx.connection().execute(
                "INSERT INTO ix.geo (n, min_lon, max_lon, min_lat, max_lat) VALUES (?1, 1, 1, 2, 2)",
                [n],
            )?;
            Ok(())
        })
        .expect("a stray point");

    go(vault, &registry, "entity.trash", json!({"id": id}));
    go(vault, &registry, "entity.purge", json!({"id": id}));
    assert_eq!(
        owed_rows(vault),
        0,
        "the pass that followed the purge cleared its row"
    );
    assert_eq!(hits(vault, "search", "wombat"), 0);
    assert_eq!(hits(vault, "search_past", "burrows"), 0);
    let left: i64 = vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT (SELECT count(*) FROM search_past WHERE rowid BETWEEN ?1 AND ?2)
                      + (SELECT count(*) FROM geo WHERE n = ?3)",
                rusqlite::params![n << 24, (n << 24) | 0xff_ffff, n],
                |r| r.get(0),
            )?)
        })
        .expect("counts");
    assert_eq!(left, 0, "no past row and no point is left under its number");
    let words = common::index::words_file(&index_path(scratch.dir()));
    assert!(
        !words.contains("wombat") && !words.contains("burrows"),
        "its words left the list: {words:?}"
    );
    assert_equals_a_rebuild(scratch.dir(), "after a purge");

    // The next entity takes a number nobody had.
    let next = common::insert_note_with(vault, "Quokka plans", "selfies").expect("a note");
    let next_n: i64 = vault
        .read(|c| Ok(c.query_row("SELECT n FROM entity WHERE id = ?1", [&next], |r| r.get(0))?))
        .expect("its number");
    assert!(next_n > n, "{next_n} was given after {n}, never reused");
    assert_eq!(
        hits(vault, "search", "wombat"),
        0,
        "nothing of the purged one is under the new"
    );
    assert_equals_a_rebuild(scratch.dir(), "after a note followed a purge");
}

// ---- A kill between the vault's commit and the index file's write loses nothing --------------------

const STAGE: &str = "CENTRAID_INDEX_STAGE";
const DIR: &str = "CENTRAID_INDEX_DIR";
const WORD: &str = "marmoset";

fn pause_at_the_named_stage(stage: Stage) -> std::io::Result<()> {
    let (name, wanted) = match stage {
        Stage::Committed => ("committed", "committed"),
        Stage::IndexWritten => ("index-written", "index-written"),
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
    common::insert_note_with(&vault, "Kill me", &format!("{WORD} body")).expect("commits");
}

fn killed_at(stage: &str) -> PathBuf {
    let dir = centraid_ontology::scratch::scratch_dir().join(format!("index-kill-{stage}"));
    std::fs::create_dir_all(&dir).expect("a directory");
    let vault = Vault::create(dir.join("vault.db")).expect("founds");
    vault.found("Home", "Ada").expect("founds");
    vault.finish().expect("closes");
    let exe = std::env::current_exe().expect("the test binary");
    let mut child = Process::new(exe)
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

fn word_in_file(dir: &Path) -> bool {
    dump_file(&index_path(dir))
        .iter()
        .any(|line| line.starts_with(&format!("search|{WORD}|")))
}

#[test]
fn a_kill_between_the_vault_commit_and_the_index_write_loses_nothing() {
    let dir = killed_at("committed");
    assert!(
        !word_in_file(&dir),
        "the index file was never written: the process died first"
    );
    let vault = Vault::open(dir.join("vault.db")).expect("a killed process opens clean");
    assert!(vault.index_owed().expect("asks"), "the commit owes its row");
    assert_eq!(
        hits(&vault, "search", WORD),
        0,
        "and a reader sees the file as it was"
    );
    drain(&vault);
    assert_eq!(
        hits(&vault, "search", WORD),
        1,
        "the idle pass wrote what the kill lost"
    );
    assert!(!vault.index_owed().expect("asks"));
    vault.finish().expect("closes");
    assert_equals_a_rebuild(&dir, "after the pass that followed a kill");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_kill_after_the_index_write_and_before_the_queue_is_cleared_writes_it_again_to_the_same_rows() {
    let dir = killed_at("index-written");
    assert!(
        word_in_file(&dir),
        "the index file had the row when the process died"
    );
    let vault = Vault::open(dir.join("vault.db")).expect("a killed process opens clean");
    assert!(
        vault.index_owed().expect("asks"),
        "the queue was not cleared"
    );
    drain(&vault);
    assert_eq!(hits(&vault, "search", WORD), 1, "written once, not twice");
    assert!(!vault.index_owed().expect("asks"));
    vault.finish().expect("closes");
    assert_equals_a_rebuild(&dir, "after the queue was paid twice");
    let _ = std::fs::remove_dir_all(&dir);
}
