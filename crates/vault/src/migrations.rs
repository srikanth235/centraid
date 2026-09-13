//! The forward-only ladder, and the baseline it starts from.
//!
//! ## Two axes, and v0's is not one of them (D-1020-D1-2)
//!
//! A v1 file carries `PRAGMA application_id = 0x43454E31` (`CEN1`) and
//! `PRAGMA user_version = <the ladder's length>`. The v0 rung number is
//! IRRELEVANT to a v1 file: there is no v0-artifact compatibility (#1020,
//! Scope/Out), so a v1 file's version axis starts at 1 and counts v1's own
//! migrations. `crates/ontology`'s 7..11 window is a different question — it is
//! about reading the two frozen v0 corpora, which are v0 files.
//!
//! ## Forward-only, and what happens at each end
//!
//! - A file BELOW the binary is migrated, in order, each rung in its own
//!   transaction, with a pre-migration snapshot taken FIRST (the one-snapshot
//!   rule: the same artifact serves backup, bootstrap and migration safety).
//! - A file ABOVE the binary is `DowngradeRefused`. Never guessed down: a
//!   newer rung may have moved data this binary does not know the shape of.
//!
//! ## Why the baseline lives under `contracts/`
//!
//! `contracts/migrations/001_baseline.sql` is BOTH the migration and the
//! fixture (D-1020-D1-13). The brief asks for migrations under
//! `crates/vault/src/migrations/` and stated as fixtures under
//! `contracts/migrations/`; two copies of a 7,000-line DDL file is two answers
//! to one question, and the one that drifted would drift silently. So there is
//! one file, it lives where the language-neutral fixtures live, and this module
//! reaches it with `include_str!` — compiled in, so a shipped binary carries
//! the schema it was built with and never looks for a repository path.

use std::path::Path;

use rusqlite::Connection;

use crate::error::{Result, VaultError};

/// `CEN1` as a big-endian four-byte tag: the `application_id` a v1 vault
/// carries, so `file` and a human can tell one from any other SQLite database.
pub const APPLICATION_ID: i64 = 0x4345_4e31;

/// One rung of the ladder.
pub struct Migration {
    /// The `user_version` a file carries once this rung has run.
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

/// The baseline: the v1 schema as one statement per line, in dependency order.
pub const BASELINE_SQL: &str = include_str!("../../../contracts/migrations/001_baseline.sql");

/// The ladder, in order. Rung one is the baseline.
///
/// A NEW RUNG IS APPENDED, NEVER INSERTED, and never edited once released: a
/// file in the field has already run the old text, so an edit changes what a
/// fresh file gets and nothing else, which is two schemas with one number.
pub const LADDER: &[Migration] = &[Migration {
    version: 1,
    name: "baseline",
    sql: BASELINE_SQL,
}];

/// The `user_version` a file this build wrote carries.
#[must_use]
pub fn head_version() -> i64 {
    LADDER.last().map_or(0, |rung| rung.version)
}

/// Run every rung above `from`, each in its own transaction.
///
/// Returns the version the file reached. The caller takes the pre-migration
/// snapshot before calling — it cannot be taken from in here, because
/// `VACUUM INTO` may not run inside a transaction and a snapshot taken
/// mid-ladder would be a copy of a half-migrated file.
pub fn run_from(connection: &Connection, from: i64) -> Result<i64> {
    let mut at = from;
    for rung in LADDER.iter().filter(|rung| rung.version > from) {
        if rung.version != at + 1 {
            return Err(VaultError::Invariant {
                context: format!(
                    "the ladder jumps from {at} to {} at `{}`: a rung was inserted, not appended",
                    rung.version, rung.name
                ),
            });
        }
        connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| VaultError::from_sqlite("opening a migration", error))?;
        let outcome = connection
            .execute_batch(rung.sql)
            .and_then(|()| connection.pragma_update(None, "user_version", rung.version));
        if let Err(error) = outcome {
            let _ = connection.execute_batch("ROLLBACK");
            return Err(VaultError::from_sqlite(
                &format!("migration {} `{}`", rung.version, rung.name),
                error,
            ));
        }
        connection
            .execute_batch("COMMIT")
            .map_err(|error| VaultError::from_sqlite("committing a migration", error))?;
        at = rung.version;
    }
    Ok(at)
}

/// Seed `core_entity_kind`, the registry `core_entity.entity_type` keys into.
///
/// **DERIVED FROM THE SCHEMA, not transcribed** (D-1020-D1-15). An entity kind
/// is exactly a logical name whose physical table declares
/// `FOREIGN KEY (<pk>) REFERENCES core_entity(entity_id)` — that is what makes
/// a row an entity in its own right rather than a child row of one. So the list
/// is read off the DDL the file was just founded from, and a new entity table
/// registers itself. A transcribed list would be a second answer to a question
/// the schema already answers, and the one that drifted would drift silently:
/// the symptom is an `entity_type` that fails its foreign key on the first
/// insert, months later, in one app.
///
/// Verified against the baseline corpus: the derivation yields the same 52
/// names v0's own ladder seeded, in both directions (`tests/baseline.rs`).
pub fn seed_entity_kinds(connection: &Connection) -> Result<usize> {
    let mut statement = connection.prepare(
        r"SELECT name, sql FROM sqlite_master
            WHERE type = 'table' AND sql IS NOT NULL
              AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
            ORDER BY name",
    )?;
    let tables: Vec<(String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut seeded = 0;
    for (name, sql) in tables {
        if !keys_into_core_entity(&sql) {
            continue;
        }
        // SQLite has no namespaces: the logical name is the physical one with
        // its FIRST underscore restored to a dot, which is the inverse of the
        // `${schema}_${kind}` the resolver derives.
        let Some((schema, kind)) = name.split_once('_') else {
            continue;
        };
        connection.execute(
            "INSERT OR IGNORE INTO core_entity_kind (kind) VALUES (?1)",
            [format!("{schema}.{kind}")],
        )?;
        seeded += 1;
    }
    Ok(seeded)
}

/// Does this table's DDL declare its primary key as a `core_entity` member?
///
/// Matched with SQL comments stripped, for the reason the snapshot's private-
/// table matcher strips them: the DDL in this schema carries long explanatory
/// comments, and one of them quoting the clause would register a child row as
/// an entity kind.
fn keys_into_core_entity(sql: &str) -> bool {
    let stripped = crate::snapshot::strip_sql_comments(sql).to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = stripped[from..].find("references core_entity") {
        let at = from + found + "references core_entity".len();
        let rest = stripped[at..].trim_start();
        // `references core_entity(entity_id)` and not
        // `references core_entity_revision(...)` or
        // `references core_entity(entity_type, entity_id)`, which is the
        // composite key a child row uses.
        if rest.starts_with("(entity_id)") || rest.starts_with("( entity_id )") {
            // And only when the referencing column is the table's own primary
            // key, which the `FOREIGN KEY (…)` form before it names.
            let head = &stripped[..from + found];
            if head.trim_end().ends_with(')') && head.contains("foreign key") {
                return true;
            }
        }
        from = at;
    }
    false
}

/// Render an executable baseline from a corpus, for `bin/export-baseline`.
///
/// Ordered by DEPENDENCY, not by name: tables (virtual tables included, in
/// among them — an FTS5 table's own `CREATE VIRTUAL TABLE` builds its shadow
/// tables), then views, then indexes, then triggers. What is left out, and why:
///
/// - **FTS shadow tables** (`<virtual table>_data`, `_idx`, `_content`,
///   `_docsize`, `_config`). `CREATE VIRTUAL TABLE` creates them; issuing their
///   own DDL as well is an error, and omitting them is not a loss — the
///   snapshot pipeline KEEPS them for the same reason (dropping the shadows
///   saves 12 MB and then the 57 retained FTS sync triggers fail on the seat's
///   first write).
/// - **`sqlite_sequence`**. SQLite creates it itself for the first
///   `AUTOINCREMENT` table and refuses a hand-written `CREATE TABLE` for it.
/// - **`sqlite_autoindex_*`**. Implicit, created by the UNIQUE constraint that
///   needs them, and not nameable in DDL.
pub fn render_baseline(corpus: &Path) -> Result<String> {
    use centraid_ontology::golden::{inflate, scratch_dir};
    use centraid_ontology::vault::Vault as OntologyVault;

    let scratch;
    let db_path;
    if corpus.extension().is_some_and(|ext| ext == "gz") {
        scratch = Some(scratch_dir());
        db_path = inflate(corpus, scratch.as_ref().expect("just set"))?;
    } else {
        scratch = None;
        db_path = corpus.to_path_buf();
    }
    let rendered = (|| -> Result<String> {
        let vault = OntologyVault::open(&db_path)?;
        let objects = vault.schema_objects()?;

        let virtual_tables: Vec<String> = objects
            .iter()
            .filter(|object| object.kind == "table" && is_virtual(&object.sql))
            .map(|object| object.name.clone())
            .collect();
        // ONLY TABLES. An FTS sync trigger is named `fts_<table>_ai`, which
        // starts with the virtual table's name and an underscore exactly as a
        // shadow table does — matching on the name alone silently dropped all
        // 57 of them, and a seat's first write then wrote nothing into the
        // index (plane census seam 8: a trigger is identified by its body, a
        // shadow table by the fact that `CREATE VIRTUAL TABLE` made it).
        let is_shadow_table = |kind: &str, name: &str| {
            kind == "table"
                && virtual_tables
                    .iter()
                    .any(|virtual_table| name.starts_with(&format!("{virtual_table}_")))
        };

        let mut out = String::from(BASELINE_HEADER);
        for (kind, plural) in [
            ("table", "tables"),
            ("view", "views"),
            ("index", "indexes"),
            ("trigger", "triggers"),
        ] {
            let mut emitted = 0_usize;
            let mut block = String::new();
            for object in objects.iter().filter(|object| object.kind == kind) {
                if object.name.starts_with("sqlite_") || is_shadow_table(kind, &object.name) {
                    continue;
                }
                block.push_str(&format!(
                    "\n-- {} {}\n{};\n",
                    object.kind,
                    object.name,
                    object.sql.trim_end().trim_end_matches(';')
                ));
                emitted += 1;
            }
            out.push_str(&format!("\n---- {plural} ({emitted})\n"));
            out.push_str(&block);
        }
        Ok(out)
    })();
    if let Some(dir) = scratch {
        let _ = std::fs::remove_dir_all(&dir);
    }
    rendered
}

/// Is this object a virtual table? Matched on the DDL rather than on a name
/// pattern, the same reason the snapshot pipeline matches FTS triggers by
/// BODY: a name convention is a convention and a `USING` clause is a fact.
fn is_virtual(sql: &str) -> bool {
    sql.trim_start()
        .get(..21)
        .is_some_and(|head| head.eq_ignore_ascii_case("CREATE VIRTUAL TABLE "))
}

/// The header the generated baseline carries, naming the command that made it.
pub const BASELINE_HEADER: &str = "\
-- GENERATED — do not edit. Rung one of the v1 ladder: the baseline schema.
--
--   cargo run -p centraid-vault --bin export-baseline -- \\
--     contracts/golden/issue-1020/vault.db.gz > contracts/migrations/001_baseline.sql
--
-- Ordered by DEPENDENCY (tables, views, indexes, triggers), not by name, so it
-- is runnable; `contracts/schema/vault-ddl.sql` is the same shape ordered for
-- READING and is not. FTS shadow tables, `sqlite_sequence` and
-- `sqlite_autoindex_*` are omitted: SQLite creates each of them itself and
-- refuses the hand-written DDL. `crates/vault/tests/baseline.rs` founds a
-- vault from this file and diffs its schema against the corpus (#1020).
--
-- THIS FILE IS BOTH the migration `crates/vault` embeds and the fixture under
-- `contracts/` (D-1020-D1-13): one file, because two copies of a schema is two
-- answers to one question.
";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ladder_is_contiguous_from_one() {
        let mut expected = 1;
        for rung in LADDER {
            assert_eq!(
                rung.version,
                expected,
                "rung `{}` is version {} and the ladder was at {}",
                rung.name,
                rung.version,
                expected - 1
            );
            assert!(!rung.sql.trim().is_empty(), "rung `{}` is empty", rung.name);
            expected += 1;
        }
        assert_eq!(head_version(), expected - 1);
    }

    #[test]
    fn the_baseline_is_the_committed_fixture_and_is_not_a_stub() {
        // `include_str!` makes the path a compile-time fact; this holds the
        // CONTENT to being a real schema, so a truncated regeneration is red.
        assert!(BASELINE_SQL.starts_with("-- GENERATED"));
        let creates = BASELINE_SQL.matches("\nCREATE ").count();
        assert!(creates > 500, "only {creates} statements in the baseline");
        assert!(BASELINE_SQL.contains("CREATE TABLE core_party"));
        assert!(BASELINE_SQL.contains("CREATE VIRTUAL TABLE fts_knowledge_note"));
        assert!(BASELINE_SQL.contains("CREATE TABLE replica_log"));
        // The three SQLite builds for itself.
        assert!(!BASELINE_SQL.contains("CREATE TABLE sqlite_sequence"));
        // The statement, not the word: the header explains WHY autoindexes are
        // omitted, so a bare substring search finds its own documentation.
        assert!(!BASELINE_SQL.contains("CREATE UNIQUE INDEX sqlite_autoindex"));
        assert!(!BASELINE_SQL.contains("-- index sqlite_autoindex"));
        assert!(!BASELINE_SQL.contains("CREATE TABLE 'fts_knowledge_note_data'"));
    }

    #[test]
    fn the_application_id_spells_cen1() {
        assert_eq!(APPLICATION_ID.to_be_bytes()[4..], *b"CEN1");
    }

    #[test]
    fn a_virtual_table_is_matched_on_its_using_clause() {
        assert!(is_virtual("CREATE VIRTUAL TABLE fts_x USING fts5(a)"));
        assert!(is_virtual("  create virtual table fts_x using fts5(a)"));
        assert!(!is_virtual("CREATE TABLE fts_x_data(id INTEGER)"));
        assert!(!is_virtual("CREATE TABLE x(a)"));
    }
}
