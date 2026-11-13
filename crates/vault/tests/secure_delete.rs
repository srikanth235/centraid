//! "Deleted for ever" erases from this phone (#1191, V14): after a purge and a TRUNCATE
//! checkpoint, the raw bytes of the vault file and its WAL hold none of what the item said, its
//! title, its body and the words the search index took from them included.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::json;

const TITLE: &str = "Zygomorphicquokka plans";
const BODY: &str = "The ostentatiouswombat arrives with a quixoticbandicoot at midnight";
// The index stores words lower-cased, so these are what the segments hold.
const WORDS: [&str; 5] = [
    "zygomorphicquokka",
    "ostentatiouswombat",
    "quixoticbandicoot",
    "arrives",
    "midnight",
];

fn run(scratch: &common::Scratch, name: &str, input: serde_json::Value) -> serde_json::Value {
    let registry = Registry::with_system_commands().expect("a registry");
    let outcome = scratch
        .vault
        .execute(
            &registry,
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

/// Everything on disk that is the vault: the file and its WAL, after the WAL is folded in.
fn raw_bytes(scratch: &common::Scratch) -> Vec<u8> {
    // Another connection folds the WAL in and truncates it, as the last close of a vault does.
    let other = rusqlite::Connection::open(scratch.vault.path()).expect("opens");
    other
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .expect("checkpoints");
    drop(other);
    let mut bytes = std::fs::read(scratch.vault.path()).expect("the file reads");
    let mut wal = scratch.vault.path().as_os_str().to_owned();
    wal.push("-wal");
    bytes.extend(std::fs::read(std::path::PathBuf::from(wal)).unwrap_or_default());
    bytes
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    let needle = needle.as_bytes();
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

#[test]
fn a_purged_item_leaves_no_trace_in_the_file_or_its_wal() {
    let scratch = common::Scratch::founded("secure-delete").expect("a vault");
    let note = run(
        &scratch,
        "note.create",
        json!({ "title": TITLE, "body": BODY }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    // A second item keeps the index non-empty, and shares a word: its copy must survive.
    run(
        &scratch,
        "note.create",
        json!({ "title": "Another", "body": "arrives later" }),
    );
    // Edit once, so an earlier version holds the text too.
    run(
        &scratch,
        "note.edit",
        json!({ "id": note, "body": format!("{BODY} and more") }),
    );

    // THE CONTROL: before the purge the scan finds all of it, so a pass below means something.
    let before = raw_bytes(&scratch);
    assert!(contains(&before, TITLE), "the scan can see the title");
    assert!(
        contains(&before, "quixoticbandicoot"),
        "the scan can see the body"
    );

    run(&scratch, "entity.trash", json!({ "id": note }));
    run(&scratch, "entity.purge", json!({ "id": note }));
    let after = raw_bytes(&scratch);
    for text in [
        TITLE,
        BODY,
        "Zygomorphicquokka",
        "quixoticbandicoot ",
        "and more",
    ] {
        assert!(!contains(&after, text), "the file still holds `{text}`");
    }
    for word in WORDS.iter().filter(|word| **word != "arrives") {
        assert!(
            !contains(&after, word),
            "the file still holds the indexed word `{word}`"
        );
    }
    // The word list dropped what only the purged item said, and kept what the other item holds.
    let words: Vec<String> = scratch
        .vault
        .read(|c| {
            let mut statement = c.prepare("SELECT word FROM search_word")?;
            Ok(statement
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?)
        })
        .expect("words");
    assert!(
        !words.iter().any(|w| WORDS[..3].contains(&w.as_str())),
        "{words:?}"
    );
    assert!(
        words.iter().any(|w| w == "arrives"),
        "a word another item holds stays"
    );
    assert!(contains(&after, "Another"), "the other item is untouched");
}
