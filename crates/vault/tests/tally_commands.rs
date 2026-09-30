//! THE 23 `tally.*` COMMANDS, REPLAYED AGAINST v0's OWN LEDGER (#1020,
//! D-1020-T3c).
//!
//! `contracts/apps/tally/commands.json` is the ordered script the parity
//! fixture's ledger is built from — twenty invocations through v0's REAL typed
//! commands, with every id the run minted replaced by a reference to the step
//! that produced it. This suite replays that script through `crates/vault`,
//! resolving each reference against its OWN outputs, and then compares the rows
//! that came out with `rows.json`, v0's.
//!
//! ## What makes the comparison mean something
//!
//! **Ids are erased, values are not.** The two runs mint different ids by
//! construction (v0's are seed-derived per invocation, this vault's come from
//! `SeededIds`), and the fixture's own ids are canonical tokens. So every
//! id-shaped value and every host-clock instant is masked on BOTH sides and
//! everything else — amounts, currencies, dates, methods, flags, the row
//! versions — is compared exactly, per table, as a multiset. A port that wrote
//! the right rows with the wrong amounts fails; a port that wrote them with
//! different ids does not, because nothing in the product depends on which id.
//!
//! **Every step has to execute.** One does not, and the test names it: the
//! occurrence-scope exception, whose check needs the civil-time plane
//! (`crates/vault/src/commands/tally.rs`'s D-1020-T3b note). The list is
//! asserted exactly, so a second refusal is a failure rather than a quiet
//! skip — and the row that step would have written is asserted absent, so the
//! deferral's cost is in the test rather than in a comment.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, VaultError};
use serde_json::Value;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .to_path_buf()
}

fn fixture(name: &str) -> Value {
    let path = root().join("contracts/apps/tally").join(name);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is not readable: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

/// Is this value an identifier rather than a fact?
///
/// The two shapes that reach either side: the fixture's canonical `id-0007`
/// tokens, and a uuid. Deliberately narrow — a description that happened to
/// look like a uuid would be masked, and none does.
fn is_id(text: &str) -> bool {
    let canonical = text.len() == 7 && text.starts_with("id-");
    let uuid = text.len() == 36
        && text.as_bytes()[8] == b'-'
        && text
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-');
    canonical || uuid
}

/// Is this an instant neither side can agree on?
///
/// `updated_at` and its siblings come from SQLite's own clock in v0 — which no
/// injected clock reaches — so the fixture carries `<host-clock>` for them. On
/// this side they are the frozen clock's, which is a different instant and the
/// same non-fact.
fn is_instant(text: &str) -> bool {
    text == "<host-clock>"
        || (text.len() >= 20
            && text.as_bytes()[10] == b'T'
            && text.ends_with('Z')
            && text.as_bytes()[4] == b'-')
}

/// An id EMBEDDED in a composite string, masked in place.
///
/// `external_id` is `tally:settlement:<id>` — the whole point of it is that the
/// id is in there, so a run that got the shape right and the id different has
/// to compare equal. Only `:`-separated segments are considered, because that
/// is the one composite shape the vault writes.
fn masked_segments(text: &str) -> Option<String> {
    if !text.contains(':') {
        return None;
    }
    let mut touched = false;
    let masked: Vec<String> = text
        .split(':')
        .map(|segment| {
            if is_id(segment) {
                touched = true;
                "<id>".to_owned()
            } else {
                segment.to_owned()
            }
        })
        .collect();
    touched.then(|| masked.join(":"))
}

fn masked(value: &Value) -> Value {
    match value {
        Value::String(text) if is_id(text) => Value::String("<id>".to_owned()),
        Value::String(text) if is_instant(text) => Value::String("<instant>".to_owned()),
        Value::String(text) if masked_segments(text).is_some() => {
            Value::String(masked_segments(text).unwrap_or_default())
        }
        Value::Array(entries) => Value::Array(entries.iter().map(masked).collect()),
        Value::Object(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, entry)| (key.clone(), masked(entry)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// One table's rows out of `rows.json`, as `{column: value}` maps.
fn fixture_rows(rows: &Value, table: &str) -> Vec<BTreeMap<String, Value>> {
    let entry = rows
        .as_array()
        .expect("rows.json is a list of tables")
        .iter()
        .find(|entry| entry["table"] == table)
        .unwrap_or_else(|| panic!("{table} is not in rows.json"));
    let columns: Vec<String> = entry["columns"]
        .as_array()
        .expect("a column list")
        .iter()
        .map(|column| column.as_str().unwrap_or_default().to_owned())
        .collect();
    entry["rows"]
        .as_array()
        .expect("a row list")
        .iter()
        .map(|row| {
            columns
                .iter()
                .zip(row.as_array().expect("a row is a list").iter())
                .map(|(column, value)| (column.clone(), masked(value)))
                .collect()
        })
        .collect()
}

/// The same shape, read out of the replayed vault.
fn vault_rows(
    vault: &centraid_vault::Vault,
    table: &str,
    columns: &[String],
) -> Vec<BTreeMap<String, Value>> {
    vault
        .read(|connection| {
            let sql = format!(
                "SELECT {} FROM {table}",
                columns
                    .iter()
                    .map(|column| format!("\"{column}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map([], |row| {
                let mut out: BTreeMap<String, Value> = BTreeMap::new();
                for (index, column) in columns.iter().enumerate() {
                    let value: rusqlite::types::Value = row.get(index)?;
                    let json = match value {
                        rusqlite::types::Value::Null => Value::Null,
                        rusqlite::types::Value::Integer(number) => Value::from(number),
                        rusqlite::types::Value::Real(number) => Value::from(number),
                        rusqlite::types::Value::Text(text) => Value::String(text),
                        rusqlite::types::Value::Blob(_) => Value::Null,
                    };
                    out.insert(column.clone(), masked(&json));
                }
                Ok(out)
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
        })
        .expect("the replayed rows read")
}

/// A multiset, so two runs that wrote the same rows in a different order agree
/// and two that wrote different rows do not.
fn multiset(rows: Vec<BTreeMap<String, Value>>) -> BTreeMap<String, usize> {
    let mut out: BTreeMap<String, usize> = BTreeMap::new();
    for row in rows {
        *out.entry(serde_json::to_string(&row).unwrap_or_default())
            .or_default() += 1;
    }
    out
}

/// Resolve `{"$from": "3.expense_id"}` and `"$owner"` against what this run
/// produced.
fn resolve(value: &Value, owner: &str, outputs: &[Value]) -> Value {
    match value {
        Value::String(text) if text == "$owner" => Value::String(owner.to_owned()),
        Value::Object(entries) => {
            if let Some(reference) = entries.get("$from").and_then(Value::as_str)
                && entries.len() == 1
            {
                let (step, key) = reference
                    .split_once('.')
                    .unwrap_or_else(|| panic!("`{reference}` is not `<step>.<key>`"));
                let step: usize = step.parse().expect("a step index");
                return outputs
                    .get(step)
                    .and_then(|output| output.get(key))
                    .cloned()
                    .unwrap_or_else(|| panic!("step {step} produced no `{key}`"));
            }
            Value::Object(
                entries
                    .iter()
                    .map(|(key, entry)| (key.clone(), resolve(entry, owner, outputs)))
                    .collect(),
            )
        }
        Value::Array(entries) => Value::Array(
            entries
                .iter()
                .map(|entry| resolve(entry, owner, outputs))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The commands whose occurrence check needs the civil-time plane, and are
/// refused rather than faked (D-1020-T3b). Named here so a third refusal is a
/// failure and this list is the only place the deferral is spelled.
const DEFERRED: &[&str] = &["tally.edit_recurring_expense_occurrence"];

/// The tables the script writes, and which are compared row for row.
///
/// `core_entity_revision` is compared by its OPERATIONS rather than its rows:
/// a snapshot is JSON text, and comparing two JSON strings compares their key
/// order, which is not a fact about either ledger.
const COMPARED: &[&str] = &[
    "tally_friend",
    "tally_group",
    "tally_expense",
    "tally_expense_split",
    "tally_expense_payer",
    "tally_expense_line_item",
    "tally_expense_line_allocation",
    "tally_settlement",
    "tally_nudge",
    "tally_recurring_expense",
    "tally_recurring_expense_split",
    "social_circle",
    "social_circle_member",
    "core_account",
    "core_transaction",
];

#[test]
fn the_script_replays_and_writes_the_rows_v0_wrote() {
    let scratch = common::Scratch::founded("tally-replay").expect("a vault is founded");
    // THE FIXTURE'S VAULT IS IN GBP and `found` writes USD: the base currency
    // is a fact about the vault, not about the commands, so it is set here
    // rather than parameterised into the bootstrap.
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.base_currency");
            tx.connection()
                .execute("UPDATE core_vault SET base_currency = 'GBP'", [])?;
            Ok(())
        })
        .expect("the base currency is set");
    let owner =
        scratch
            .vault
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT self_party_id FROM core_vault LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .expect("the founded vault has an owner");
    let registry = Registry::with_system_commands().expect("the registry builds");
    registry
        .install(&scratch.vault)
        .expect("the record installs");
    let principal = Principal::owner("phone");

    let script = fixture("commands.json");
    let script = script.as_array().expect("commands.json is a list of steps");
    assert_eq!(script.len(), 20, "the fixture's own step count");

    let mut outputs: Vec<Value> = Vec::new();
    let mut deferred: Vec<&str> = Vec::new();
    for (index, step) in script.iter().enumerate() {
        let command = step["command"].as_str().expect("a command name");
        let input = resolve(&step["input"], &owner, &outputs);
        let outcome =
            scratch
                .vault
                .execute(&registry, &principal, &Command::new(command, input.clone()));
        match outcome {
            Ok(done) => {
                assert_eq!(
                    done.status,
                    CommandStatus::Executed,
                    "step {index} (`{command}`) refused: {:?} / {:?}",
                    done.predicate,
                    done.reason
                );
                // Every key v0's output carried has to be there, or a later
                // step's reference resolves to nothing.
                for key in step["output_keys"].as_array().into_iter().flatten() {
                    let key = key.as_str().unwrap_or_default();
                    assert!(
                        done.output.get(key).is_some(),
                        "step {index} (`{command}`) answered no `{key}`"
                    );
                }
                outputs.push(done.output);
            }
            Err(VaultError::NotImplemented { name }) => {
                assert!(
                    DEFERRED.iter().any(|entry| name.starts_with(entry)),
                    "step {index} (`{command}`) refused and is not a named deferral: {name}"
                );
                deferred.push(command);
                outputs.push(Value::Null);
            }
            Err(other) => panic!("step {index} (`{command}`): {other}"),
        }
    }
    assert_eq!(
        deferred,
        vec!["tally.edit_recurring_expense_occurrence"],
        "exactly one step is deferred, and it is the occurrence-scope exception"
    );

    // THE ROWS. Every compared table, as a masked multiset.
    let rows = fixture("rows.json");
    let mut differences: Vec<String> = Vec::new();
    for table in COMPARED {
        let expected = fixture_rows(&rows, table);
        let columns: Vec<String> = rows
            .as_array()
            .expect("tables")
            .iter()
            .find(|entry| entry["table"] == *table)
            .expect("the table is in the fixture")["columns"]
            .as_array()
            .expect("columns")
            .iter()
            .map(|column| column.as_str().unwrap_or_default().to_owned())
            .collect();
        let mine = vault_rows(&scratch.vault, table, &columns);
        let (expected, mine) = (multiset(expected), multiset(mine));
        if expected != mine {
            let missing: Vec<&String> = expected
                .keys()
                .filter(|row| !mine.contains_key(*row))
                .collect();
            let extra: Vec<&String> = mine
                .keys()
                .filter(|row| !expected.contains_key(*row))
                .collect();
            differences.push(format!(
                "{table}: {} row(s) v0 wrote and this did not:\n    {}\n  {} row(s) this wrote and v0 did not:\n    {}",
                missing.len(),
                missing
                    .iter()
                    .map(|row| row.as_str())
                    .collect::<Vec<_>>()
                    .join("\n    "),
                extra.len(),
                extra
                    .iter()
                    .map(|row| row.as_str())
                    .collect::<Vec<_>>()
                    .join("\n    "),
            ));
        }
    }
    assert!(
        differences.is_empty(),
        "{} table(s) disagree:\n{}",
        differences.len(),
        differences.join("\n")
    );

    // The revision plane, by what it recorded rather than by its snapshots.
    let operations: Vec<String> = scratch
        .vault
        .read(|connection| {
            let mut statement = connection.prepare(
                "SELECT operation FROM core_entity_revision
                  WHERE entity_type = 'tally.expense' ORDER BY operation",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
        })
        .expect("the revisions read");
    let v0_operations: Vec<String> = fixture_rows(&rows, "core_entity_revision")
        .iter()
        .filter(|row| row["entity_type"] == Value::String("tally.expense".to_owned()))
        .map(|row| row["operation"].as_str().unwrap_or_default().to_owned())
        .collect();
    let mut v0_operations = v0_operations;
    v0_operations.sort();
    assert_eq!(
        operations, v0_operations,
        "the same mutations were snapshotted, with the same operation names"
    );

    // THE DEFERRAL'S OWN COST, stated rather than hidden: v0's script wrote one
    // occurrence exception and this replay did not, because the command that
    // writes one needs the expander to know the occurrence exists.
    let exceptions: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM schedule_recurrence_exception",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the exception table reads");
    assert_eq!(exceptions, 0);
    assert_eq!(
        fixture_rows(&rows, "schedule_recurrence_exception").len(),
        1,
        "v0's script wrote one, and that is the gap the handoff names"
    );
}
