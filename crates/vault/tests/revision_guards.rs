//! THE REVISION GRAPH'S FOUR GUARDS (#1020, D-1020-N2).
//!
//! `core_entity_revision` is the ONLY history table (#916, ONT-revisions) and a
//! revision is an OCCURRENCE (#996, R20(a)). Both were reader-enforced, and the
//! schema still permitted a self-parent, a parent belonging to another object,
//! an UPDATE re-pointing a parent (the only way a cycle can be closed) and a
//! `revises` `core_link`. A founded vault now refuses all four, and this suite
//! answers three questions over one:
//!
//! 1. **Does it accept everything the product writes?** Every one of the nine
//!    `knowledge.*` commands runs, including the restore that appends a third
//!    occurrence.
//! 2. **Does each guard refuse the row it is for?** A self-parent, a foreign
//!    parent, a re-pointed parent, and a `revises` link — each asserted by its
//!    own sentence, so a guard that stopped working fails here and not in a
//!    count.
//! 3. **Is the ladder's head the guards' home?** A founded vault carries all four
//!    and refuses a file from a newer build.
//!
//! (The rung that added the guards also refused to run over a file that already
//! carried a cycle. That path is not proved here: the ladder was squashed into
//! one baseline on 2026-10-15, Q-1029-1, and no vault in the field predates the
//! guards. The reader's own refusal of a cycle stays.)

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Vault};
use serde_json::{Value, json};

struct Founded {
    scratch: common::Scratch,
    registry: Registry,
    principal: Principal,
}

impl Founded {
    /// A founded vault with the registry installed.
    fn open(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the registry's record installs");
        Self {
            scratch,
            registry,
            principal: Principal::owner("phone"),
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    fn run(&self, command: &str, input: Value) -> Value {
        let outcome = self
            .vault()
            .execute(
                &self.registry,
                &self.principal,
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("`{command}` errored: {error}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "`{command}` refused: {:?} / {:?}",
            outcome.predicate,
            outcome.reason
        );
        outcome.output
    }

    /// A direct write, the way an import or a replica apply reaches the table —
    /// which is exactly the caller no precondition asks.
    fn direct(&self, sql: &str, binds: &[&str]) -> Result<(), String> {
        let sql = sql.to_owned();
        let binds: Vec<String> = binds.iter().map(|bind| (*bind).to_owned()).collect();
        self.vault()
            .commit(|tx| {
                tx.set_producer("test.direct");
                let params: Vec<&dyn rusqlite::ToSql> = binds
                    .iter()
                    .map(|bind| bind as &dyn rusqlite::ToSql)
                    .collect();
                tx.connection().execute(&sql, params.as_slice())?;
                Ok(())
            })
            .map(drop)
            .map_err(|error| error.to_string())
    }

    fn count(&self, sql: &str, binds: &[&str]) -> i64 {
        self.vault()
            .read(|connection| {
                let params: Vec<&dyn rusqlite::ToSql> = binds
                    .iter()
                    .map(|bind| bind as &dyn rusqlite::ToSql)
                    .collect();
                Ok(connection.query_row(sql, params.as_slice(), |row| row.get(0))?)
            })
            .expect("the count reads")
    }

    fn note(&self, title: &str, body: &str) -> String {
        self.run(
            "knowledge.create_note",
            json!({ "title": title, "body_text": body, "format": "markdown" }),
        )["note_id"]
            .as_str()
            .expect("a note id")
            .to_owned()
    }

    /// A revision row, written directly. `parent` of `""` means NULL.
    fn revision(&self, revision_id: &str, note_id: &str, parent: &str) -> Result<(), String> {
        let now = self.vault().clock().now_text();
        let content_id: String = self
            .vault()
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT body_content_id FROM knowledge_note WHERE note_id = ?1",
                    [note_id],
                    |row| row.get(0),
                )?)
            })
            .expect("the note reads");
        if parent.is_empty() {
            return self.direct(
                "INSERT INTO core_entity_revision
                   (revision_id, entity_type, entity_id, operation, snapshot_json,
                    recorded_at, undo_until, undone_at, actor_party_id, invocation_id,
                    content_id, parent_revision_id, updated_at)
                 VALUES (?1, 'knowledge.note', ?2, 'revise', '{}', ?3, ?3, NULL, NULL, NULL,
                         ?4, NULL, ?3)",
                &[revision_id, note_id, &now, &content_id],
            );
        }
        self.direct(
            "INSERT INTO core_entity_revision
               (revision_id, entity_type, entity_id, operation, snapshot_json,
                recorded_at, undo_until, undone_at, actor_party_id, invocation_id,
                content_id, parent_revision_id, updated_at)
             VALUES (?1, 'knowledge.note', ?2, 'revise', '{}', ?3, ?3, NULL, NULL, NULL,
                     ?4, ?5, ?3)",
            &[revision_id, note_id, &now, &content_id, parent],
        )
    }
}

/// THE GUARDS ACCEPT EVERYTHING THE PRODUCT WRITES. Nine commands, under them,
/// including the restore that appends a third occurrence.
#[test]
fn every_knowledge_command_runs_under_the_guards() {
    let vault = Founded::open("revisions-accepts");
    let notebook =
        vault.run("knowledge.create_notebook", json!({ "name": "Travel" }))["notebook_id"]
            .as_str()
            .expect("a notebook id")
            .to_owned();
    let note = vault.run(
        "knowledge.create_note",
        json!({
            "title": "Cabin", "body_text": "Book the cabin.", "format": "markdown",
            "notebook_id": notebook,
        }),
    )["note_id"]
        .as_str()
        .expect("a note id")
        .to_owned();
    let first: String = vault
        .vault()
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT body_content_id FROM knowledge_note WHERE note_id = ?1",
                [&note],
                |row| row.get(0),
            )?)
        })
        .expect("a body");

    vault.run(
        "knowledge.edit_note",
        json!({ "note_id": note, "body_text": "Book the cabin. Ask about the dog." }),
    );
    vault.run(
        "knowledge.restore_note_version",
        json!({ "note_id": note, "content_id": first }),
    );
    vault.run(
        "knowledge.rename_notebook",
        json!({ "notebook_id": notebook, "name": "Trips" }),
    );
    vault.run("knowledge.move_note", json!({ "note_id": note }));
    vault.run(
        "knowledge.delete_notebook",
        json!({ "notebook_id": notebook }),
    );
    vault.run("knowledge.delete_note", json!({ "note_id": note }));
    vault.run("knowledge.restore_note", json!({ "note_id": note }));
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_entity_revision WHERE entity_id = ?1",
            &[&note],
        ),
        3,
        "three occurrences: create, edit, restore"
    );
}

/// **THE THREE REVISION GUARDS**, each refused by its own sentence.
#[test]
fn a_self_parent_a_foreign_parent_and_a_moved_parent_are_all_refused() {
    let vault = Founded::open("revisions-guards");
    let mine = vault.note("Mine", "My words.");
    let theirs = vault.note("Theirs", "Their words.");

    // (1) A revision that is its own ancestor.
    let refusal = vault
        .revision("rev-self", &mine, "rev-self")
        .expect_err("a self-parent is refused");
    assert!(refusal.contains("its own ancestor"), "{refusal}");

    // (2) A parent belonging to another object. The parent here is `theirs`'
    // real head, so the row is well-formed in every way except the one that
    // matters.
    let their_head: String = vault
        .vault()
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT current_revision_id FROM knowledge_note WHERE note_id = ?1",
                [&theirs],
                |row| row.get(0),
            )?)
        })
        .expect("a head");
    let refusal = vault
        .revision("rev-foreign", &mine, &their_head)
        .expect_err("a foreign parent is refused");
    assert!(refusal.contains("belongs to one object"), "{refusal}");

    // (3) A re-pointed parent. This is the row that makes a longer cycle
    // reachable at all.
    let my_head: String = vault
        .vault()
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT current_revision_id FROM knowledge_note WHERE note_id = ?1",
                [&mine],
                |row| row.get(0),
            )?)
        })
        .expect("a head");
    vault
        .revision("rev-second", &mine, &my_head)
        .expect("a well-formed second occurrence lands");
    let refusal = vault
        .direct(
            "UPDATE core_entity_revision SET parent_revision_id = ?1 WHERE revision_id = ?2",
            &["rev-second", &my_head],
        )
        .expect_err("a moved parent is refused");
    assert!(refusal.contains("immutable"), "{refusal}");
}

/// A CYCLE IS UNREACHABLE ONCE THE THREE GUARDS HOLD. Revisions are insert-only
/// and a fresh id cannot already sit in its own parent's chain, so the only way
/// to close A→B→A is the UPDATE the third guard refuses.
#[test]
fn the_cycle_the_reader_refuses_becomes_unwritable() {
    let vault = Founded::open("revisions-cycle");
    let note = vault.note("Cabin", "Book it.");
    let head: String = vault
        .vault()
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT current_revision_id FROM knowledge_note WHERE note_id = ?1",
                [&note],
                |row| row.get(0),
            )?)
        })
        .expect("a head");
    vault
        .revision("rev-b", &note, &head)
        .expect("a second occurrence lands");
    // Closing the loop needs the first row's parent moved to the second.
    assert!(
        vault
            .direct(
                "UPDATE core_entity_revision SET parent_revision_id = 'rev-b' WHERE revision_id = ?1",
                &[&head],
            )
            .is_err(),
        "the loop cannot be closed"
    );
    // And the two-step forward chain is intact.
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_entity_revision WHERE entity_id = ?1",
            &[&note],
        ),
        2
    );
}

/// THE SECOND HISTORY GRAPH'S EDGE IS UNWRITABLE — and the concept has to exist
/// for the guard to be doing anything, so the test seeds it first. In a vault
/// this build founded the concept is deliberately absent
/// (`crates/vault/src/bootstrap.rs`), which is what makes the trigger dormant
/// rather than redundant.
#[test]
fn a_revises_link_is_refused_once_the_concept_exists() {
    let vault = Founded::open("revisions-link");
    let one = vault.note("One", "First.");
    let two = vault.note("Two", "Second.");
    // The concept is not seeded by this build; a seeded vocabulary or an import
    // is what would bring it back.
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_concept WHERE notation = 'revises'",
            &[],
        ),
        0,
        "the concept is deliberately unseeded"
    );
    let scheme: String = vault
        .vault()
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT scheme_id FROM core_concept_scheme WHERE uri = 'urn:duaility:relations'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the relations scheme is seeded at found time");
    vault
        .direct(
            "INSERT INTO core_concept
               (concept_id, scheme_id, notation, pref_label, created_at, updated_at)
             VALUES ('concept-revises', ?1, 'revises', 'Revises', ?2, ?2)",
            &[&scheme, "2099-06-01T09:00:00.000Z"],
        )
        .expect("the concept can be seeded");

    let refusal = vault
        .direct(
            "INSERT INTO core_link
               (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                valid_from, valid_to, asserted_by, provenance_id, updated_at)
             VALUES ('link-revises', 'knowledge.note', ?1, 'knowledge.note', ?2,
                     'concept-revises', ?3, NULL, 'owner', NULL, ?3)",
            &[&one, &two, "2099-06-01T09:00:00.000Z"],
        )
        .expect_err("a revises edge is refused");
    assert!(refusal.contains("core_entity_revision"), "{refusal}");

    // Every OTHER relation still links. The guard is about one notation.
    vault
        .direct(
            "INSERT INTO core_link
               (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                valid_from, valid_to, asserted_by, provenance_id, updated_at)
             VALUES ('link-ok', 'knowledge.note', ?1, 'knowledge.note', ?2,
                     (SELECT concept_id FROM core_concept WHERE notation = 'references'),
                     ?3, NULL, 'owner', NULL, ?3)",
            &[&one, &two, "2099-06-01T09:00:00.000Z"],
        )
        .expect("a references edge still links");
}

/// A FOUNDED VAULT CARRIES ALL FOUR GUARDS AND REFUSES A FILE FROM A NEWER BUILD.
///
/// Two claims, because they are two different things: a founded vault comes up
/// already carrying every guard, so each test above describes what a member's
/// file IS rather than what it could be; and a file from a newer build is still
/// refused — the forward-only rule restated at the ladder's head, because "the
/// ladder grew" is exactly the change that would make a downgrade look
/// survivable.
#[test]
fn a_fresh_vault_carries_the_four_guards_and_refuses_a_file_from_the_future() {
    // Rung one is the baseline, and the guards live in it; a rung appended above it is the
    // ladder working.
    assert_eq!(centraid_vault::migrations::LADDER[0].name, "baseline");

    let fresh = Founded::open("ladder-guards");
    assert_eq!(
        fresh.vault().schema_version(),
        centraid_vault::migrations::head_version()
    );
    for guard in [
        "core_entity_revision_no_self_parent",
        "core_entity_revision_parent_is_same_object",
        "core_entity_revision_parent_is_immutable",
        "core_link_no_revises_edge",
    ] {
        assert_eq!(
            fresh.count(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                &[guard],
            ),
            1,
            "`{guard}` is missing from a freshly founded vault"
        );
    }

    let path = fresh.scratch.join("vault.db");
    let ahead = centraid_vault::migrations::head_version() + 1;
    let connection = rusqlite::Connection::open(&path).expect("the file reopens");
    connection
        .pragma_update(None, "user_version", ahead)
        .expect("the stamp writes");
    drop(connection);
    match Vault::open(&path) {
        Err(centraid_vault::VaultError::DowngradeRefused {
            found, expected, ..
        }) => {
            assert_eq!(found, ahead);
            assert_eq!(expected, centraid_vault::migrations::head_version());
        }
        other => panic!(
            "a newer file must be refused, not opened: {:?}",
            other.err()
        ),
    }
}
