//! The forward-only ladder, and the two rungs it holds.
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
//! ## One rung squashed on 2026-10-15, and rung two above it
//!
//! The ladder began as ONE rung. `001_baseline.sql` is the whole schema a new vault
//! is founded with and the rows that founding seeds, squashed from the fifteen
//! rungs that preceded it (Q-1029-1): nothing had shipped, so no vault needed
//! the climb, and a new vault had been founding the planes #1029 struck only to
//! drop them. The file is FROZEN like any rung — a vault in the field has
//! already run its text — and **the next schema change appends rung two**: a
//! `002_<name>.sql`, an `include_str!` constant and a [`Migration`] in
//! [`LADDER`]. It is never an edit to rung one. A rung two is proved the way a
//! climb is: found a vault, wind its file back to `user_version = 1` by undoing
//! the rung's own statements, write the rows the old shape let through, and
//! open it.
//!
//! Rung two, `002_phone_link.sql`, is that appended rung (#1127): the table that records which
//! phone record each followed person, event or document came from.
//!
//! The file is cut by `bin/export-baseline` ([`render_baseline`]), which founds
//! a vault from whatever ladder the build embeds and renders what it holds. With
//! one rung it reproduces the file byte for byte; once a rung is appended it
//! renders the squash of both, which is how a later squash is cut.
//!
//! ## Why the baseline lives under `contracts/`
//!
//! `contracts/migrations/001_baseline.sql` is BOTH the migration and the
//! fixture (D-1020-D1-13). The brief asks for migrations under
//! `crates/vault/src/migrations/` and stated as fixtures under
//! `contracts/migrations/`; two copies of a 6,000-line DDL file is two answers
//! to one question, and the one that drifted would drift silently. So there is
//! one file, it lives where the language-neutral fixtures live, and this module
//! reaches it with `include_str!` — compiled in, so a shipped binary carries
//! the schema it was built with and never looks for a repository path.

use centraid_ontology::SchemaObject;
use rusqlite::Connection;
use rusqlite::types::ValueRef;

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

/// The baseline: the vault's schema as one statement per block, in dependency
/// order, and the rows founding seeds. Rung one, and today the whole ladder.
pub const BASELINE_SQL: &str = include_str!("../../../contracts/migrations/001_baseline.sql");

/// Rung two: the phone link, which records which phone record each synced person, event or
/// document came from (#1127).
pub const PHONE_LINK_SQL: &str = include_str!("../../../contracts/migrations/002_phone_link.sql");

/// The ladder, in order. Rung one is the baseline.
///
/// A NEW RUNG IS APPENDED, NEVER INSERTED, and never edited once released: a
/// file in the field has already run the old text, so an edit changes what a
/// fresh file gets and nothing else, which is two schemas with one number.
pub const LADDER: &[Migration] = &[
    Migration {
        version: 1,
        name: "baseline",
        sql: BASELINE_SQL,
    },
    Migration {
        version: 2,
        name: "phone_link",
        sql: PHONE_LINK_SQL,
    },
];

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
    run_rungs(connection, LADDER, from)
}

/// [`run_from`] over any ladder, so the climb itself — its order, its
/// contiguity guard and its per-rung transaction — stays under test while the
/// real ladder holds one rung.
fn run_rungs(connection: &Connection, ladder: &[Migration], from: i64) -> Result<i64> {
    let mut at = from;
    for rung in ladder.iter().filter(|rung| rung.version > from) {
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
/// Verified against the baseline corpus: the derivation yields the 52 names v0's
/// own ladder seeded, less the eight `tally.*` kinds the planes struck took with
/// them (#1099) and plus `chat.thread` and `money.rule`, in both directions
/// (`tests/baseline.rs`). The baseline carries no `core_entity_kind` row of its
/// own for exactly this reason: this function is the registry's one writer.
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

/// The five tables FTS5 itself creates behind a `CREATE VIRTUAL TABLE … USING fts5`.
const FTS5_SHADOW_SUFFIXES: [&str; 5] = ["data", "idx", "content", "docsize", "config"];

/// The tables whose rows the baseline does not carry, because `seed_entity_kinds` derives them.
///
/// `core_entity_kind` is the registry of entity kinds, and D-1020-D1-15 makes the schema its one
/// source: a literal row here would be a second answer to a question the DDL already answers.
const DERIVED_TABLES: [&str; 1] = ["core_entity_kind"];

/// Render the baseline: the schema, and the rows that founding seeds, of a vault founded by THIS
/// BUILD'S ladder, as one executable rung. For `bin/export-baseline`.
///
/// The vault is founded exactly as [`crate::Vault::create`] founds it up to the registry — a
/// connection with foreign keys OFF and the ladder run from nothing, before `seed_entity_kinds`
/// — and its `sqlite_master` and its rows are read back. Ordered by DEPENDENCY, not by name:
/// tables (virtual tables included, in among them — an FTS5 table's own `CREATE VIRTUAL TABLE`
/// builds its shadow tables), then views, then indexes, then the rows, then triggers. The rows
/// come BEFORE the triggers, so no trigger fires over them: a row a trigger wrote when the
/// ladder ran (the `core_entity` row that an entity table's insert trigger writes) is read back
/// as a row and carried as one, and the trigger does not write it a second time.
///
/// What is left out, and why:
///
/// - **FTS shadow tables** (`<virtual table>_data`, `_idx`, `_content`, `_docsize`,
///   `_config`). `CREATE VIRTUAL TABLE` creates them; issuing their own DDL as well is an error,
///   and omitting them is not a loss — the snapshot pipeline KEEPS them for the same reason
///   (dropping the shadows saves 12 MB and then the 57 retained FTS sync triggers fail on the
///   seat's first write). **A virtual table is never a shadow table**: an `fts5vocab` table is
///   named `<index>_vocab`, begins with its index's name exactly as a shadow does, and is a
///   `CREATE VIRTUAL TABLE` of its own.
/// - **`sqlite_sequence`**. SQLite creates it itself for the first `AUTOINCREMENT` table and
///   refuses a hand-written `CREATE TABLE` for it.
/// - **`sqlite_autoindex_*`**. Implicit, created by the UNIQUE constraint that needs them, and
///   not nameable in DDL.
/// - **The rows of `DERIVED_TABLES`**, which `seed_entity_kinds` writes from the DDL.
///
/// A founded vault holding rows that an index would have to carry (a populated `_docsize`) is
/// refused rather than rendered: the rows come before the triggers, so the index would miss them.
pub fn render_baseline() -> Result<String> {
    let connection = Connection::open_in_memory()?;
    connection.pragma_update(None, "foreign_keys", "OFF")?;
    run_from(&connection, 0)?;
    render_founded(&connection)
}

/// The rendering half of [`render_baseline`], over a connection the ladder has just run on.
fn render_founded(connection: &Connection) -> Result<String> {
    use std::fmt::Write as _;

    let objects = centraid_ontology::schema_objects_of(connection)?;
    let virtual_tables: Vec<&str> = objects
        .iter()
        .filter(|object| object.kind == "table" && is_virtual(&object.sql))
        .map(|object| object.name.as_str())
        .collect();
    // A SHADOW TABLE IS A REAL TABLE named `<virtual table>_<suffix>`. ONLY TABLES: an FTS sync
    // trigger is named `fts_<table>_ai`, which starts with the virtual table's name and an
    // underscore exactly as a shadow table does — matching on the name alone silently dropped
    // all 57 of them, and a seat's first write then wrote nothing into the index (plane census
    // seam 8: a trigger is identified by its body, a shadow table by the fact that `CREATE
    // VIRTUAL TABLE` made it). And NO VIRTUAL TABLE: the `fts5vocab` tables are `<index>_vocab`,
    // and dropping them as shadows left a vault with no vocabulary at all.
    let is_shadow_table = |object: &SchemaObject| {
        object.kind == "table"
            && !is_virtual(&object.sql)
            && virtual_tables.iter().any(|virtual_table| {
                FTS5_SHADOW_SUFFIXES
                    .iter()
                    .any(|suffix| object.name == format!("{virtual_table}_{suffix}"))
            })
    };
    let leaves_out =
        |object: &SchemaObject| object.name.starts_with("sqlite_") || is_shadow_table(object);

    // THE ROWS AN INDEX WOULD HAVE TO CARRY: refused, not rendered.
    for virtual_table in &virtual_tables {
        let docsize = format!("{virtual_table}_docsize");
        if objects.iter().any(|object| object.name == docsize) {
            let indexed: i64 =
                connection.query_row(&format!("SELECT COUNT(*) FROM {docsize}"), [], |row| {
                    row.get(0)
                })?;
            if indexed > 0 {
                return Err(VaultError::Invariant {
                    context: format!(
                        "`{virtual_table}` indexes {indexed} row(s): the baseline puts its rows \
                         before its triggers, so the index would not hold them"
                    ),
                });
            }
        }
    }

    let mut out = String::from(BASELINE_HEADER);
    for (kind, plural) in [
        ("table", "tables"),
        ("view", "views"),
        ("index", "indexes"),
        ("trigger", "triggers"),
    ] {
        if kind == "trigger" {
            out.push_str(&render_rows(connection, &objects, &leaves_out)?);
        }
        let mut emitted = 0_usize;
        let mut block = String::new();
        for object in objects.iter().filter(|object| object.kind == kind) {
            if leaves_out(object) {
                continue;
            }
            writeln!(
                block,
                "\n-- {} {}\n{};",
                object.kind,
                object.name,
                object.sql.trim_end().trim_end_matches(';')
            )
            .expect("a string accepts writes");
            emitted += 1;
        }
        writeln!(out, "\n---- {plural} ({emitted})").expect("a string accepts writes");
        out.push_str(&block);
    }
    Ok(out)
}

/// The `---- rows` section: one `INSERT` per row of every table the baseline carries rows for,
/// in `rowid` order, after the schema and before the triggers.
fn render_rows(
    connection: &Connection,
    objects: &[SchemaObject],
    leaves_out: &dyn Fn(&SchemaObject) -> bool,
) -> Result<String> {
    use std::fmt::Write as _;

    let mut total = 0_usize;
    let mut body = String::new();
    for object in objects.iter().filter(|object| {
        object.kind == "table"
            && !is_virtual(&object.sql)
            && !leaves_out(object)
            && !DERIVED_TABLES.contains(&object.name.as_str())
    }) {
        let table = object.name.as_str();
        if !table
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(VaultError::Invariant {
                context: format!("table `{table}` is not a bare identifier"),
            });
        }
        // `table_info` leaves out generated columns, which are not insertable.
        let columns: Vec<String> = connection
            .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let order = if object.sql.to_ascii_uppercase().contains("WITHOUT ROWID") {
            columns.join(", ")
        } else {
            "rowid".to_owned()
        };
        let mut statement = connection.prepare(&format!(
            "SELECT {} FROM {table} ORDER BY {order}",
            columns.join(", ")
        ))?;
        let mut rows = statement.query([])?;
        let mut inserts = String::new();
        let mut count = 0_usize;
        while let Some(row) = rows.next()? {
            let values = (0..columns.len())
                .map(|index| sql_literal(row.get_ref(index)?, table))
                .collect::<Result<Vec<_>>>()?;
            writeln!(
                inserts,
                "INSERT INTO {table} ({}) VALUES ({});",
                columns.join(", "),
                values.join(", ")
            )
            .expect("a string accepts writes");
            count += 1;
        }
        if count > 0 {
            write!(body, "\n-- rows {table} ({count})\n{inserts}")
                .expect("a string accepts writes");
            total += count;
        }
    }
    let mut section = format!("\n---- rows ({total})\n");
    if total > 0 {
        section.push_str(
            "\n-- Deferred, so the order of the tables does not matter to a connection that\n\
             -- enforces foreign keys. The founding runs the ladder with them off.\n\
             PRAGMA defer_foreign_keys = ON;\n",
        );
    }
    section.push_str(&body);
    Ok(section)
}

/// One value as a SQL literal.
fn sql_literal(value: ValueRef<'_>, table: &str) -> Result<String> {
    Ok(match value {
        ValueRef::Null => "NULL".to_owned(),
        ValueRef::Integer(integer) => integer.to_string(),
        ValueRef::Real(real) if real.is_finite() => format!("{real:?}"),
        ValueRef::Real(real) => {
            return Err(VaultError::Invariant {
                context: format!("`{table}` holds {real}, which has no SQL literal"),
            });
        }
        ValueRef::Text(text) => format!(
            "'{}'",
            std::str::from_utf8(text)
                .map_err(|error| VaultError::Invariant {
                    context: format!("`{table}` holds text that is not UTF-8: {error}"),
                })?
                .replace('\'', "''")
        ),
        ValueRef::Blob(blob) => format!("X'{}'", hex::encode(blob)),
    })
}

/// The header the ladder-head DDL fixture carries, naming its own generator.
pub const LADDER_DDL_HEADER: &str = "\
-- GENERATED — do not edit. THE SCHEMA A NEW VAULT GETS: the `sqlite_master` of
-- a file founded at the ladder head, one statement per block.
--
--   cargo run -p centraid-vault --bin export-ladder-ddl \\
--     > contracts/schema/vault-ddl.sql
--
-- Not the corpus. `contracts/golden/issue-1020/vault-ddl.sql` describes the
-- frozen v0 file as it was, and the ladder is allowed to move this file away
-- from it — which is exactly what it did when it dropped the planes #1029
-- struck (the owner's ruling of 2026-09-21) and what the baseline's 2026-10-15
-- squash kept (Q-1029-1). Ordered by type then name, for READING; the runnable
-- ordering is `contracts/migrations/001_baseline.sql`.
--
-- Source: sqlite_master (type, name, tbl_name, sql) where sql is not null.
-- `sqlite_stat*` is excluded: it is the planner's own statistics, so it says
-- how much data a file holds and nothing about its shape.
-- `crates/vault/tests/ladder_ddl.rs` founds a vault and diffs this file
-- against its live schema on every run.
";

/// Render the ladder head's DDL: found a vault in a scratch directory and read
/// its `sqlite_master` back.
///
/// **Founded, not transcribed.** The question this fixture answers is "what
/// does a file this build writes actually look like", and the only honest way
/// to answer it is to write one. The scratch file is removed before returning;
/// it is opened a second time, through `centraid_ontology`, because the
/// renderer is the one the corpus's own description uses and two renderers
/// would be two answers to "what does this file look like".
pub fn render_ladder_ddl() -> Result<String> {
    use centraid_ontology::golden::scratch_dir;
    use centraid_ontology::{render_ddl_objects, schema_objects_of};

    let dir = scratch_dir();
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("vault.db");
    let rendered = (|| -> Result<String> {
        let vault = crate::Vault::create(&db_path)?;
        let objects = vault.read(|connection| Ok(schema_objects_of(connection)?))?;
        Ok(render_ddl_objects(&objects, LADDER_DDL_HEADER))
    })();
    let _ = std::fs::remove_dir_all(&dir);
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

/// The header the baseline carries, naming the command that cuts it.
pub const BASELINE_HEADER: &str = "\
-- RUNG ONE of the vault's ladder: the whole schema a new vault is founded with, and the rows
-- that founding seeds.
--
-- SQUASHED ON 2026-10-15 from the fifteen-rung ladder that came before it (Q-1029-1, #1029).
-- Nothing had shipped, so no vault needed the climb, and a new vault no longer founds the
-- planes #1029 struck only to drop them. The same squash renamed `agent_command` and
-- `agent_command_invocation`, the command registry and the invocation journal, to
-- `command_definition` and `command_invocation` (Q-1029-3): there is no agent left in v0.
--
-- AMENDED ON 2026-10-16, before any release (the owner's rulings on the baseline's names): the
-- other four `agent_*` tables, `agent_capability`, `agent_invocation_check`, `agent_evidence`
-- and `agent_explanation`, became `command_capability`, `command_invocation_check`,
-- `command_evidence` and `command_explanation`; `access_device` and `access_device_secret`,
-- which nothing has written since the gateway's allowlist left (#1080), went with the two
-- columns that named them, `core_content_item.origin_device_id` and
-- `media_asset.camera_device_id`; and Tally's value left the
-- `schedule_recurrence_exception.target_type` CHECK (#1099).
--
-- FROZEN LIKE ANY RUNG. A vault in the field has already run this text, so an edit here changes
-- what a new vault gets and nothing else, which is two schemas with one number. The next
-- schema change is `002_<name>.sql`, appended to `LADDER` in `crates/vault/src/migrations.rs`.
--
-- Cut with `export-baseline`, which founds a vault from the ladder the build embeds, with
-- foreign keys off and before `seed_entity_kinds`, and renders what it holds:
--
--   cargo run -p centraid-vault --bin export-baseline > contracts/migrations/001_baseline.sql
--
-- While this file is the whole ladder that command reproduces it byte for byte, so it is the
-- tool a later squash is cut with and not a regeneration gate: `tests/baseline.rs` proves that
-- the baseline it renders rebuilds the same vault. (The 2026-10-15 cut renamed the two tables
-- in the text it rendered.)
--
-- Ordered by DEPENDENCY (tables, views, indexes, rows, triggers), not by name, so it is
-- runnable; `contracts/schema/vault-ddl.sql` is the same schema ordered for READING and is
-- not. The rows come before the triggers so that no trigger fires over them. FTS shadow tables,
-- `sqlite_sequence` and `sqlite_autoindex_*` are omitted: SQLite creates each of them itself
-- and refuses the hand-written DDL. `core_entity_kind` has no rows here: the registry is
-- derived from this schema by `seed_entity_kinds` (D-1020-D1-15).
--
-- THIS FILE IS BOTH the migration `crates/vault` embeds and the fixture under `contracts/`
-- (D-1020-D1-13): one file, because two copies of a schema is two answers to one question.
";

#[cfg(test)]
mod tests {
    use super::*;

    /// A migration that fails mid-way ON PURPOSE: it succeeds twice and then fails, so the file
    /// it leaves is half-migrated if nothing rolls it back (#1020, D-1020-R7). It is not a rung
    /// of the ladder and the ladder never contains it.
    const FAILS_SQL: &str = include_str!("../../../contracts/migrations/999_fails.sql");

    /// A connection founded the way `Vault::create` founds one up to the registry: foreign
    /// keys off, the ladder run from nothing.
    fn founded() -> Connection {
        let connection = Connection::open_in_memory().expect("a connection opens");
        connection
            .pragma_update(None, "foreign_keys", "OFF")
            .expect("foreign keys go off");
        assert_eq!(
            run_from(&connection, 0).expect("the ladder runs"),
            head_version()
        );
        connection
    }

    /// [`founded`], stopped at rung one: the synthetic ladders below append their own rung two,
    /// and the real one's would be run first and move the version past it.
    fn founded_at_baseline() -> Connection {
        let connection = Connection::open_in_memory().expect("a connection opens");
        connection
            .pragma_update(None, "foreign_keys", "OFF")
            .expect("foreign keys go off");
        assert_eq!(
            run_rungs(&connection, &LADDER[..1], 0).expect("rung one runs"),
            1
        );
        connection
    }

    fn user_version(connection: &Connection) -> i64 {
        connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("the version reads")
    }

    fn count(connection: &Connection, sql: &str) -> i64 {
        connection
            .query_row(sql, [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{sql}: {error}"))
    }

    /// Everything a file holds that a squash must carry: every schema object, and every row of
    /// every real table but the registry `seed_entity_kinds` derives. One line each, sorted.
    fn dump(connection: &Connection) -> Vec<String> {
        let objects: Vec<(String, String, String, Option<String>)> = connection
            .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master")
            .expect("the schema reads")
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .expect("the schema reads")
            .collect::<rusqlite::Result<_>>()
            .expect("the schema reads");
        let mut lines = Vec::new();
        for (kind, name, table, sql) in &objects {
            lines.push(format!("{kind}|{name}|{table}|{sql:?}"));
            if kind != "table"
                || sql.as_deref().is_some_and(is_virtual)
                || DERIVED_TABLES.contains(&name.as_str())
            {
                continue;
            }
            let mut statement = connection
                .prepare(&format!("SELECT * FROM {name}"))
                .expect("the rows read");
            let width = statement.column_count();
            let mut rows = statement.query([]).expect("the rows read");
            while let Some(row) = rows.next().expect("a row reads") {
                let values: Vec<String> = (0..width)
                    .map(|index| format!("{:?}", row.get_ref(index).expect("a value reads")))
                    .collect();
                lines.push(format!("row|{name}|{}", values.join("|")));
            }
        }
        lines.sort();
        lines
    }

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
        // RUNG ONE IS THE BASELINE, whatever is appended above it.
        assert_eq!(LADDER[0].name, "baseline");
    }

    #[test]
    fn the_baseline_is_the_committed_fixture_and_is_not_a_stub() {
        // `include_str!` makes the path a compile-time fact; this holds the
        // CONTENT to being a real schema, so a truncated regeneration is red.
        assert!(BASELINE_SQL.starts_with("-- RUNG ONE"));
        let creates = BASELINE_SQL.matches("\nCREATE ").count();
        assert!(creates > 500, "only {creates} statements in the baseline");
        assert!(BASELINE_SQL.contains("CREATE TABLE core_party"));
        assert!(BASELINE_SQL.contains("CREATE VIRTUAL TABLE fts_knowledge_note"));
        // THE VOCABULARY TABLES ARE VIRTUAL TABLES OF THEIR OWN, not shadows of the index they
        // read: a renderer that took them for shadows left a vault with no vocabulary.
        assert!(BASELINE_SQL.contains("CREATE VIRTUAL TABLE fts_knowledge_note_vocab"));
        // The planes #1029 struck are not in the file a new vault is founded from.
        assert!(!BASELINE_SQL.contains("CREATE TABLE replica_log"));
        // The three SQLite builds for itself.
        assert!(!BASELINE_SQL.contains("CREATE TABLE sqlite_sequence"));
        // The statement, not the word: the header explains WHY autoindexes are
        // omitted, so a bare substring search finds its own documentation.
        assert!(!BASELINE_SQL.contains("CREATE UNIQUE INDEX sqlite_autoindex"));
        assert!(!BASELINE_SQL.contains("-- index sqlite_autoindex"));
        assert!(!BASELINE_SQL.contains("CREATE TABLE 'fts_knowledge_note_data'"));
        // THE ROWS FOUNDING SEEDS ride in the file, ahead of the triggers.
        let rows = BASELINE_SQL
            .find("\n---- rows (")
            .expect("the file has a rows section");
        let triggers = BASELINE_SQL
            .find("\n---- triggers (")
            .expect("the file has a triggers section");
        assert!(rows < triggers, "rows come before the triggers");
        assert!(BASELINE_SQL.contains("INSERT INTO core_concept_scheme"));
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

    #[test]
    fn a_rung_appended_above_the_baseline_climbs_once_and_in_order() {
        let connection = founded_at_baseline();
        let ladder = [
            Migration {
                version: 1,
                name: "baseline",
                sql: BASELINE_SQL,
            },
            Migration {
                version: 2,
                name: "scratch",
                sql: "CREATE TABLE rung_two_scratch (id TEXT PRIMARY KEY) STRICT;",
            },
        ];
        assert_eq!(
            run_rungs(&connection, &ladder, 1).expect("rung two runs"),
            2
        );
        assert_eq!(user_version(&connection), 2);
        assert_eq!(
            count(
                &connection,
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'rung_two_scratch'"
            ),
            1
        );
        // A file already at the head runs nothing: the rung would fail if it ran again.
        assert_eq!(run_rungs(&connection, &ladder, 2).expect("nothing runs"), 2);
    }

    #[test]
    fn a_gap_in_the_ladder_is_refused_before_the_rung_after_it_runs() {
        let connection = Connection::open_in_memory().expect("a connection opens");
        let ladder = [
            Migration {
                version: 1,
                name: "first",
                sql: "CREATE TABLE one (id TEXT PRIMARY KEY) STRICT;",
            },
            Migration {
                version: 3,
                name: "third",
                sql: "CREATE TABLE three (id TEXT PRIMARY KEY) STRICT;",
            },
        ];
        let error = run_rungs(&connection, &ladder, 0).expect_err("a gap is refused");
        assert!(
            error
                .to_string()
                .contains("a rung was inserted, not appended"),
            "{error}"
        );
        // Rung one ran and stays; the rung after the gap did not.
        assert_eq!(user_version(&connection), 1);
        assert_eq!(
            count(
                &connection,
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'three'"
            ),
            0
        );
    }

    #[test]
    fn a_rung_that_fails_midway_rolls_back_whole_and_leaves_the_version() {
        // `999_fails.sql` creates a table, writes a row, then fails: the file it would leave is
        // CHANGED, which is the case the pre-migration snapshot exists for. The rung's own
        // transaction is what undoes it here.
        let connection = founded_at_baseline();
        let ladder = [
            Migration {
                version: 1,
                name: "baseline",
                sql: BASELINE_SQL,
            },
            Migration {
                version: 2,
                name: "fails",
                sql: FAILS_SQL,
            },
        ];
        let error = run_rungs(&connection, &ladder, 1).expect_err("the rung fails");
        assert!(
            error.to_string().contains("NOT NULL constraint failed"),
            "{error}"
        );
        assert_eq!(user_version(&connection), 1, "the version did not move");
        assert_eq!(
            count(
                &connection,
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'drill_upgrade_scratch'"
            ),
            0,
            "the half-migrated table is gone"
        );
    }

    #[test]
    fn a_squash_rebuilds_the_vault_it_was_cut_from() {
        // THE CLAIM A SQUASH MAKES: replay the text `render_baseline` renders over a fresh file
        // and the schema and every row are the file the ladder founded. Whatever the ladder
        // holds today — one rung, or one rung and the ones a later squash is about to fold in.
        // (The two foundings run at different instants: a rung that seeds a row with a
        // wall-clock default would make them differ, so a seeded row carries a literal.)
        let founded = founded();
        let squash = render_baseline().expect("the baseline renders");
        let rebuilt = Connection::open_in_memory().expect("a connection opens");
        rebuilt
            .pragma_update(None, "foreign_keys", "OFF")
            .expect("foreign keys go off");
        rebuilt
            .execute_batch(&format!("BEGIN IMMEDIATE;\n{squash}\nCOMMIT;"))
            .expect("the squash runs");
        let (left, right) = (dump(&founded), dump(&rebuilt));
        assert_eq!(left.len(), right.len());
        let differing: Vec<&String> = left
            .iter()
            .zip(&right)
            .filter(|(a, b)| a != b)
            .map(|(a, _)| a)
            .collect();
        assert!(differing.is_empty(), "{differing:#?}");
        // NOT VACUOUS: objects of every kind, and the rows the ladder seeds.
        assert!(left.len() > 500, "only {} lines dumped", left.len());
        assert!(
            left.iter()
                .any(|line| line.starts_with("row|core_concept|"))
        );
        assert!(left.iter().any(|line| line.starts_with("row|core_entity|")));
    }

    #[test]
    fn a_virtual_table_is_not_a_shadow_table_and_a_value_survives_as_itself() {
        // The renderer's two decisions on a file small enough to read: the `fts5vocab` table
        // begins with its index's name exactly as a shadow table does and is NOT one, and every
        // kind of value comes back as a literal that means what it meant.
        let connection = Connection::open_in_memory().expect("a connection opens");
        connection
            .execute_batch(
                "CREATE VIRTUAL TABLE fts_t USING fts5(a);
                 CREATE VIRTUAL TABLE fts_t_vocab USING fts5vocab(fts_t, 'row');
                 CREATE TABLE plain (n INTEGER, r REAL, t TEXT, b BLOB, z TEXT);
                 INSERT INTO plain VALUES (7, 1.5, 'it''s', X'00ff', NULL);",
            )
            .expect("the file is built");
        let text = render_founded(&connection).expect("it renders");
        assert!(text.contains("CREATE VIRTUAL TABLE fts_t_vocab"), "{text}");
        assert!(text.contains("CREATE VIRTUAL TABLE fts_t USING"), "{text}");
        assert!(!text.contains("fts_t_data"), "a shadow table was rendered");
        assert!(
            text.contains(
                "INSERT INTO plain (n, r, t, b, z) VALUES (7, 1.5, 'it''s', X'00ff', NULL);"
            ),
            "{text}"
        );
        // And it replays.
        let replay = Connection::open_in_memory().expect("a connection opens");
        replay.execute_batch(&text).expect("the text runs");
        assert_eq!(
            count(
                &replay,
                "SELECT COUNT(*) FROM plain WHERE t = 'it''s' AND b = X'00ff'"
            ),
            1
        );
    }

    #[test]
    fn a_vault_holding_indexed_rows_is_refused_rather_than_rendered_unindexed() {
        // The rows come before the triggers, so an index that already holds a row could not be
        // refilled by the replay: the renderer says so instead of writing a baseline that lies.
        let connection = Connection::open_in_memory().expect("a connection opens");
        connection
            .execute_batch(
                "CREATE VIRTUAL TABLE fts_t USING fts5(a);
                 INSERT INTO fts_t (a) VALUES ('indexed');",
            )
            .expect("the file is built");
        let error = render_founded(&connection).expect_err("indexed rows are refused");
        assert!(error.to_string().contains("indexes 1 row(s)"), "{error}");
    }
}
