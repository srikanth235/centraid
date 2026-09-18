//! The ontology's commitments, held against the frozen corpus.
//!
//! `docs/vault-ontology.md` § *Commitments the code enforces* is the list: each
//! row is a design commitment, its mechanism, and the test that goes red when
//! it breaks. A commitment with no row there is a wish; a row with no test here
//! is v0's to hold until `crates/vault` exists.
//!
//! One `#[test]` per row that a FILE-LEVEL check can hold. Rows whose mechanism
//! is the command pipeline — a receipt committing with the mutation it
//! describes, the archive pass proving custody before it prunes, a reveal
//! writing its receipt, an export re-sealing under the target's key, the purge
//! behaviour per deletion role, the scripted reader scenarios, `lint:vault-sql`
//! and the published-page comparison — are NOT here and are not silently
//! dropped: they stay with v0's oracle and are listed in the receipt.
//!
//! The subject is the corpus opened WITHOUT migrating, because that is all this
//! crate can do in wave 1. Where the pre-migration file differs from what v0's
//! baseline builds today, the difference is declared with its reason rather
//! than skipped.

use std::collections::BTreeSet;

use centraid_ontology::Vault;
use centraid_ontology::golden::open_golden;
use centraid_ontology::registries::{sealed_physical_columns, v0_registries};

/// `replica_change` is the retired per-app change log (#1014, R-1014-1). v0's
/// rung ten DROPs it, so it is in the pre-migration corpus and in no registry.
const RETIRED_IN_CORPUS: &[&str] = &["replica_change"];

fn golden_vault() -> (centraid_ontology::golden::InflatedGolden, Vault) {
    let golden = open_golden().expect("the corpus inflates");
    let vault = Vault::open(golden.db_path()).expect("the corpus opens");
    (golden, vault)
}

/// Does `haystack` mention `word` as a whole identifier?
fn mentions_word(haystack: &str, word: &str) -> bool {
    let boundary = |c: char| !(c.is_ascii_alphanumeric() || c == '_');
    let mut from = 0;
    while let Some(found) = haystack[from..].find(word) {
        let start = from + found;
        let end = start + word.len();
        let before_ok = start == 0 || haystack[..start].chars().next_back().is_some_and(boundary);
        let after_ok =
            end == haystack.len() || haystack[end..].chars().next().is_some_and(boundary);
        if before_ok && after_ok {
            return true;
        }
        from = end;
    }
    false
}

/// `(name, NOT NULL)` for every column of a table, straight from the engine —
/// the DDL's own line breaks are not a thing a test should have to parse.
fn columns_of(vault: &Vault, table: &str) -> Vec<(String, bool)> {
    let mut statement = vault
        .connection()
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .expect("table_info prepares");
    statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>("name")?,
                row.get::<_, i64>("notnull")? != 0,
            ))
        })
        .expect("table_info runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("table_info rows")
}

fn column_names(vault: &Vault, table: &str) -> Vec<String> {
    columns_of(vault, table)
        .into_iter()
        .map(|(name, _)| name)
        .collect()
}

fn table_sql(vault: &Vault, table: &str) -> Option<String> {
    vault
        .schema_objects()
        .expect("the schema reads")
        .into_iter()
        .find(|object| object.kind == "table" && object.name == table)
        .map(|object| object.sql)
}

#[test]
fn every_physical_table_is_a_registered_entity_a_local_table_or_a_private_one() {
    // "Every physical table is either a registered entity or a declared local
    // one, with a written reason" — v0 holds this with `lifecycle.test.ts`
    // against a FRESH vault. Held here against the frozen file, which is the
    // stricter subject: a table a rung later dropped is still in it.
    let (_golden, vault) = golden_vault();
    let registries = v0_registries();
    let mut accounted: BTreeSet<&str> = BTreeSet::new();
    accounted.extend(
        registries
            .entities
            .iter()
            .map(|entity| entity.table.as_str()),
    );
    accounted.extend(
        registries
            .local_tables
            .iter()
            .map(|entry| entry.table.as_str()),
    );
    accounted.extend(
        registries
            .private_tables
            .iter()
            .map(|entry| entry.table.as_str()),
    );
    accounted.extend(registries.audit_band.tables.iter().map(String::as_str));
    accounted.extend(RETIRED_IN_CORPUS.iter().copied());

    let findings: Vec<String> = vault
        .base_tables()
        .expect("the tables read")
        .into_iter()
        .filter(|table| !accounted.contains(table.as_str()))
        .map(|table| format!("`{table}` is in the file and in no registry"))
        .collect();
    assert_eq!(findings.join("\n"), "");
}

#[test]
fn every_ontology_entity_table_carries_its_membership_triggers() {
    // "Every entity row has an id unique across the model": the `core_entity`
    // supertype, planted by a `<table>_entity_insert` BEFORE INSERT trigger and
    // a `<table>_entity_delete` beside it (v0 `schema/entity.ts`).
    //
    // Only the ONTOLOGY packs, and only non-projections: a machinery-band row
    // is plumbing rather than an entity in its own right, and a projection is
    // part of its parent's row, so neither gets a supertype row.
    let (_golden, vault) = golden_vault();
    let registries = v0_registries();
    let packs: BTreeSet<&str> = registries
        .ontology_packs
        .iter()
        .map(String::as_str)
        .collect();
    let triggers: BTreeSet<String> = vault
        .schema_objects()
        .expect("the schema reads")
        .into_iter()
        .filter(|object| object.kind == "trigger")
        .map(|object| object.name)
        .collect();
    let tables: BTreeSet<String> = vault
        .base_tables()
        .expect("the tables read")
        .into_iter()
        .collect();

    let mut checked = 0usize;
    let mut findings: Vec<String> = Vec::new();
    for entity in &registries.entities {
        let Some((pack, _)) = entity.logical.split_once('.') else {
            continue;
        };
        if !packs.contains(pack) || entity.projection_of.is_some() {
            continue;
        }
        if !tables.contains(&entity.table) {
            findings.push(format!(
                "`{}` is registered and not in the file",
                entity.table
            ));
            continue;
        }
        checked += 1;
        for suffix in ["_entity_insert", "_entity_delete"] {
            let name = format!("{}{suffix}", entity.table);
            if !triggers.contains(&name) {
                findings.push(format!("`{}` has no `{name}` trigger", entity.table));
            }
        }
    }
    assert_eq!(findings.join("\n"), "");
    // Not a vacuous pass: the ontology packs are most of the model.
    assert!(checked > 50, "only {checked} entity tables were checked");
}

#[test]
fn the_audit_band_refuses_an_update_and_a_delete() {
    // "Evidence cannot be rewritten": the band's triggers RAISE, so the refusal
    // is the engine's and not a convention. Asserted by EXECUTING both, not by
    // reading the DDL — a trigger that exists and does not fire is the failure
    // mode a DDL check cannot see.
    let (_golden, vault) = golden_vault();
    let db = vault.connection();
    db.execute_batch(
        "INSERT INTO access_provenance
           (prov_id, entity_type, entity_id, prov_activity, agent_kind, agent_id, occurred_at)
         VALUES
           ('prov-commitment-probe', 'core.party', 'party-probe', 'probe', 'owner', 'owner', '2026-01-01T00:00:00.000Z')",
    )
    .expect("an audit row can be APPENDED");

    let update = db.execute(
        "UPDATE access_provenance SET prov_activity = 'rewritten' WHERE prov_id = 'prov-commitment-probe'",
        [],
    );
    let delete = db.execute(
        "DELETE FROM access_provenance WHERE prov_id = 'prov-commitment-probe'",
        [],
    );

    let findings: Vec<String> = [("UPDATE", update), ("DELETE", delete)]
        .into_iter()
        .filter_map(|(verb, outcome)| match outcome {
            Ok(rows) => Some(format!(
                "{verb} on access_provenance succeeded, changing {rows} row(s)"
            )),
            Err(error) => {
                let message = error.to_string();
                (!message.contains("append-only"))
                    .then(|| format!("{verb} failed for the wrong reason: {message}"))
            }
        })
        .collect();
    assert_eq!(findings.join("\n"), "");

    // And the register agrees with the file: every write-once table declares
    // both triggers.
    let triggers: BTreeSet<String> = vault
        .schema_objects()
        .expect("the schema reads")
        .into_iter()
        .filter(|object| object.kind == "trigger")
        .map(|object| object.name)
        .collect();
    let missing: Vec<String> = v0_registries()
        .audit_band
        .append_only_tables
        .iter()
        .flat_map(|table| {
            ["_append_only_u", "_append_only_d"]
                .into_iter()
                .map(move |suffix| format!("{table}{suffix}"))
        })
        .filter(|name| !triggers.contains(name))
        .map(|name| format!("`{name}` is declared write-once and has no trigger"))
        .collect();
    assert_eq!(missing.join("\n"), "");
}

#[test]
fn no_sealed_column_appears_in_any_fts_ddl() {
    // "Secrets are ciphertext at rest, NEVER INDEXED": the FTS DDL gate refuses
    // a sealed column. An index is a plaintext copy, so a sealed column that
    // reached one would undo the sealing without changing a single cell.
    let (_golden, vault) = golden_vault();
    let sealed = sealed_physical_columns();
    assert!(!sealed.is_empty(), "the sealed register is empty");
    let fts_objects: Vec<centraid_ontology::SchemaObject> = vault
        .schema_objects()
        .expect("the schema reads")
        .into_iter()
        .filter(|object| object.name.starts_with("fts_") || object.sql.contains("fts_"))
        .collect();
    assert!(
        !fts_objects.is_empty(),
        "the corpus has no FTS objects to check"
    );

    let findings: Vec<String> = fts_objects
        .iter()
        .flat_map(|object| {
            sealed.iter().filter_map(move |(table, column)| {
                let touches_table = mentions_word(&object.sql, &format!("fts_{table}"))
                    || mentions_word(&object.sql, table);
                (touches_table && mentions_word(&object.sql, column)).then(|| {
                    format!(
                        "{} {} mentions sealed column {table}.{column}",
                        object.kind, object.name
                    )
                })
            })
        })
        .collect();
    assert_eq!(findings.join("\n"), "");
}

#[test]
fn every_replicated_mutable_entity_table_carries_row_version() {
    // "A member's edit is refused when the row moved under it": `row_version`
    // on the row, bumped in the same trigger as `updated_at`. Private tables
    // are excluded — a gateway-only row has no seat to disagree with.
    let (_golden, vault) = golden_vault();
    let registries = v0_registries();
    let private: BTreeSet<&str> = registries
        .private_tables
        .iter()
        .map(|entry| entry.table.as_str())
        .collect();
    let tables: BTreeSet<String> = vault
        .base_tables()
        .expect("the tables read")
        .into_iter()
        .collect();

    let mut checked = 0usize;
    let findings: Vec<String> = registries
        .entities
        .iter()
        .filter(|entity| matches!(entity.lifecycle.as_str(), "mutable" | "trash"))
        .filter(|entity| !private.contains(entity.table.as_str()) && tables.contains(&entity.table))
        .filter_map(|entity| {
            checked += 1;
            (!column_names(&vault, &entity.table).contains(&"row_version".to_owned())).then(|| {
                format!(
                    "`{}` is replicated and {} and has no row_version",
                    entity.table, entity.lifecycle
                )
            })
        })
        .collect();
    assert_eq!(findings.join("\n"), "");
    assert!(checked > 40, "only {checked} tables were checked");
}

#[test]
fn money_states_its_currency() {
    // "Money states its currency": `currency` on the three tally tables that
    // hold an amount, NOT NULL, so an amount without one is unrepresentable.
    let (_golden, vault) = golden_vault();
    let findings: Vec<String> = ["tally_group", "tally_expense", "tally_settlement"]
        .into_iter()
        .filter_map(|table| {
            let currency = columns_of(&vault, table)
                .into_iter()
                .find(|(name, _)| name == "currency");
            match currency {
                None => Some(format!("`{table}` has no `currency` column")),
                Some((_, notnull)) => {
                    (!notnull).then(|| format!("`{table}`'s `currency` is nullable"))
                }
            }
        })
        .collect();
    assert_eq!(findings.join("\n"), "");
}

#[test]
fn every_trash_entity_carries_the_reversible_delete_pair() {
    // "Delete is a reversible trash with a grace window": `deleted_at` and
    // `purge_at`, with the CHECK that makes purge_at-without-deleted_at
    // unrepresentable — a purge stamp on a live row is a row the sweep would
    // delete without the member ever having asked.
    let (_golden, vault) = golden_vault();
    let tables: BTreeSet<String> = vault
        .base_tables()
        .expect("the tables read")
        .into_iter()
        .collect();
    let mut checked = 0usize;
    let findings: Vec<String> = v0_registries()
        .entities
        .iter()
        .filter(|entity| entity.lifecycle == "trash" && tables.contains(&entity.table))
        .filter_map(|entity| {
            checked += 1;
            let columns = column_names(&vault, &entity.table);
            let missing: Vec<&str> = ["deleted_at", "purge_at"]
                .into_iter()
                .filter(|column| !columns.iter().any(|name| name == column))
                .collect();
            if !missing.is_empty() {
                return Some(format!(
                    "`{}` is trash and lacks {}",
                    entity.table,
                    missing.join(", ")
                ));
            }
            let sql = table_sql(&vault, &entity.table).unwrap_or_default();
            let guarded = sql.lines().any(|line| {
                line.contains("CHECK")
                    && mentions_word(line, "purge_at")
                    && mentions_word(line, "deleted_at")
            });
            (!guarded).then(|| {
                format!(
                    "`{}` is trash and has no CHECK tying purge_at to deleted_at",
                    entity.table
                )
            })
        })
        .collect();
    assert_eq!(findings.join("\n"), "");
    assert_eq!(checked, 13, "the registry declares 13 trash entities");
}

#[test]
fn the_declared_bands_and_packs_partition_the_registry() {
    // `ONTOLOGY_PACKS` versus `MACHINERY_BANDS` — explicit, so a new schema
    // fails loud rather than mis-shelving. Every registered entity's schema is
    // in exactly one of the two lists.
    let registries = v0_registries();
    let packs: BTreeSet<&str> = registries
        .ontology_packs
        .iter()
        .map(String::as_str)
        .collect();
    let bands: BTreeSet<&str> = registries
        .machinery_bands
        .iter()
        .map(String::as_str)
        .collect();
    let findings: Vec<String> = registries
        .entities
        .iter()
        .filter_map(|entity| {
            let schema = entity.logical.split('.').next().unwrap_or_default();
            let in_pack = packs.contains(schema);
            let in_band = bands.contains(schema);
            (in_pack == in_band).then(|| {
                format!(
                    "`{}`: schema `{schema}` is {} classified",
                    entity.logical,
                    if in_pack { "doubly" } else { "not" }
                )
            })
        })
        .collect();
    assert_eq!(findings.join("\n"), "");
}

#[test]
fn no_replicated_table_references_a_private_one_by_name() {
    // #996 R3's one property: a seat's copy satisfies its own foreign keys. The
    // full claim needs the replica allow-list, which is `crates/seat`'s; what a
    // file-level check can hold is the half that is visible in the DDL — no
    // table outside the private list declares a REFERENCES onto one.
    let (_golden, vault) = golden_vault();
    let private: BTreeSet<&str> = v0_registries()
        .private_tables
        .iter()
        .map(|entry| entry.table.as_str())
        .collect();
    let findings: Vec<String> = vault
        .schema_objects()
        .expect("the schema reads")
        .into_iter()
        .filter(|object| object.kind == "table" && !private.contains(object.name.as_str()))
        .flat_map(|object| {
            private
                .iter()
                .filter(|parent| {
                    object.sql.split("REFERENCES").skip(1).any(|tail| {
                        tail.trim_start()
                            .split(['(', ' ', '\n'])
                            .next()
                            .is_some_and(|name| name == **parent)
                    })
                })
                .map(|parent| format!("`{}` REFERENCES the private table `{parent}`", object.name))
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(findings.join("\n"), "");
}
