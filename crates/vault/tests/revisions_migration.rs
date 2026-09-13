//! THE ONE-GRAPH MIGRATION, PROPOSED AND PROVEN (#1020, D-1020-N2).
//!
//! `contracts/migrations/002_revisions.sql` is a PROPOSAL: `LADDER` in
//! `crates/vault/src/migrations.rs` still ends at rung one, and appending the
//! rung is the root's per-slot migration. This suite is what makes the proposal
//! reviewable rather than plausible — it applies the file to a real founded
//! vault and answers four questions:
//!
//! 1. **Does it accept everything the product writes?** Every one of the nine
//!    `knowledge.*` commands runs after it, including the restore that appends a
//!    third occurrence.
//! 2. **Does each guard refuse the row it is for?** A self-parent, a foreign
//!    parent, a re-pointed parent, and a `revises` link — each asserted by its
//!    own sentence, so a guard that stopped working fails here and not in a
//!    count.
//! 3. **Does the backfill check refuse a file that already carries a cycle?**
//!    The migration must not silently leave a malformed chain behind, because
//!    dropping the row would be deciding which of two histories a member keeps.
//! 4. **Is the reader still needed?** Yes, and the last test says why: the
//!    ladder is forward-only, so a vault written by an older binary reaches this
//!    build with rows the guards were added after.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Vault};
use serde_json::{Value, json};

/// The proposal, read from `contracts/` rather than embedded: it is not on the
/// ladder, so nothing compiles it in yet.
fn proposal() -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/migrations/002_revisions.sql");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is not readable: {error}", path.display()))
}

struct Proposed {
    scratch: common::Scratch,
    registry: Registry,
    principal: Principal,
}

impl Proposed {
    /// A founded vault with the registry installed. `migrate` says whether the
    /// proposal has been applied, so a test can seed a malformed row FIRST and
    /// watch the migration refuse.
    fn open(seed: &str, migrate: bool) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the registry's record installs");
        let proposed = Self {
            scratch,
            registry,
            principal: Principal::owner("phone"),
        };
        if migrate {
            proposed.migrate().expect("the proposal applies");
        }
        proposed
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    /// Apply the proposal the way a rung is applied: one transaction, all of it.
    fn migrate(&self) -> Result<(), String> {
        let sql = proposal();
        self.vault()
            .commit(|tx| {
                tx.set_producer("migration.002_revisions");
                tx.connection().execute_batch(&sql)?;
                Ok(())
            })
            .map(drop)
            .map_err(|error| error.to_string())
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

/// THE MIGRATION ACCEPTS EVERYTHING THE PRODUCT WRITES. Nine commands, after
/// the rung, including the restore that appends a third occurrence.
#[test]
fn every_knowledge_command_still_runs_after_the_rung() {
    let vault = Proposed::open("revisions-accepts", true);
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
    let vault = Proposed::open("revisions-guards", true);
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
    let vault = Proposed::open("revisions-cycle", true);
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
    let vault = Proposed::open("revisions-link", true);
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

/// **THE BACKFILL CHECK REFUSES A FILE THAT ALREADY CARRIES A CYCLE**, rather
/// than leaving it behind. Dropping the row would be deciding which of two
/// histories a member keeps.
#[test]
fn the_migration_refuses_a_vault_that_already_holds_a_malformed_chain() {
    let vault = Proposed::open("revisions-backfill", false);
    let note = vault.note("Cabin", "Book it.");
    // A→B→A, written BEFORE the rung — which is what a vault from an older
    // binary can reach and the whole reason the reader's refusal stays.
    vault
        .revision("rev-cycle-a", &note, "rev-cycle-b")
        .expect_err("the parent does not exist yet");
    vault
        .revision("rev-cycle-a", &note, "")
        .expect("a parentless occurrence lands");
    vault
        .revision("rev-cycle-b", &note, "rev-cycle-a")
        .expect("a child lands");
    vault
        .direct(
            "UPDATE core_entity_revision SET parent_revision_id = 'rev-cycle-b'
              WHERE revision_id = 'rev-cycle-a'",
            &[],
        )
        .expect("before the rung, nothing stops the loop");

    let refusal = vault.migrate().expect_err("the rung refuses the file");
    assert!(
        refusal.contains("CHECK") || refusal.contains("constraint"),
        "{refusal}"
    );
    // AND THE FILE IS UNTOUCHED: the rung's own transaction rolled back, so the
    // guard table is not left behind.
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'migration_002_guard'",
            &[],
        ),
        0
    );
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM sqlite_master
              WHERE name = 'core_entity_revision_no_self_parent'",
            &[],
        ),
        0,
        "no guard landed, so the file is exactly as it was"
    );
}

/// THE RUNG IS NOT ON THE LADDER, and that is deliberate: appending it is the
/// root's per-slot migration (the Notes lane brief). A test that asserted
/// otherwise would be this lane landing a model change on its own.
#[test]
fn the_proposal_is_not_on_the_ladder_yet() {
    let names: Vec<&str> = centraid_vault::migrations::LADDER
        .iter()
        .map(|rung| rung.name)
        .collect();
    assert_eq!(names, ["baseline"]);
    assert!(
        proposal().contains("NOT ON THE LADDER YET"),
        "the file says so too"
    );
}
