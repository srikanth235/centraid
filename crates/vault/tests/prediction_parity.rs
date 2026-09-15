//! A SEAT'S PREDICTION IS THE GATEWAY'S PAGE (#1025 S7, item 4).
//!
//! A seat shows a member their own write the instant they make it, by running
//! the command against its own replica, taking the row images the handler
//! produced and applying them ([`Vault::predict`],
//! `centraid_seat::pending::apply_prediction`). The gateway then runs the same
//! command for real and sends the page it logged. **Those two pages have to be
//! the same page**, or a member watches their edit change under them when the
//! answer lands — which is the flicker every optimistic-write design that
//! DESCRIBES a write instead of running it eventually produces.
//!
//! This suite is that property, over every command fixture in
//! `contracts/apps/*/commands.json` — the scripted command sets the v0 export
//! generated, which are the closest thing this repository has to "every command
//! a member runs, with real inputs".
//!
//! ## How it is checked, and why it is the same vault twice
//!
//! For each command: `predict` it, then `execute` it, on ONE vault. The
//! prediction rolls back, so the execution starts from exactly the state the
//! prediction saw — which is the property's own precondition and is not
//! arranged, it is what `dry_run` is.
//!
//! ## THE GATEWAY-MINTED FIELDS, ENUMERATED
//!
//! The two runs cannot agree on everything and must not be asked to. A handler
//! mints ids from the vault's id sequence and stamps times from its clock, and
//! the prediction consumed the earlier draws — so an id, a `row_version` and a
//! timestamp differ BY CONSTRUCTION. Those are [`GATEWAY_MINTED`] and they are
//! named rather than detected.
//!
//! **The list is asserted to be tight**, which is the half that matters: the
//! suite collects every column that actually differed across every fixture and
//! refuses one that is not in the list. A prediction that got a real value
//! wrong fails here, and an exemption nobody needs any more shows up as a name
//! in the list with nothing behind it.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::value::Value as CellValue;
use centraid_vault::{Command, CommandStatus};
use serde_json::Value;

/// COLUMNS THE GATEWAY MINTS, which a prediction cannot match and must not try.
///
/// Every one of these is drawn from the vault's own id sequence or its clock,
/// and the prediction drew first. A seat shows the member an id that is not the
/// one the gateway will commit — which is exactly why the answering commit
/// REPLACES the predicted row rather than merging into it, and why the journal
/// keeps the prior image rather than a diff.
/// THE GATEWAY'S ACCOUNT OF AN EXECUTION, which a seat does not predict.
///
/// The product's own list (`centraid_vault::audit::TRAIL_TABLES`) and not a
/// second copy: a table added there and not here would be a divergence this
/// suite quietly allowed.
use centraid_vault::audit::TRAIL_TABLES as AUDIT_TABLES;

const GATEWAY_MINTED: [&str; 12] = [
    // The vault's id sequence.
    "invocation_id",
    "receipt_id",
    "revision_id",
    "occurrence_id",
    "derivative_id",
    "link_id",
    // The vault's clock.
    "created_at",
    "updated_at",
    "committed_at",
    "occurred_at",
    // The row's own version counter, minted by the trigger the snapshot drops.
    "row_version",
    // A MINTED ID WEARING ANOTHER NAME. `core_concept.notation` is the id of
    // the thing the concept stands for — a notebook's own id is the notation of
    // the folder concept that files it — so it is drawn from the same sequence
    // and differs for the same reason, and the `_id` suffix rule below cannot
    // see it.
    "notation",
];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .to_path_buf()
}

/// One fixture command, with its `$from` references already resolved.
struct Scripted {
    name: String,
    input: Value,
}

/// Resolve the fixture's `{"$from": "<index>.<key>"}` references against the
/// outputs of the commands already run.
///
/// The fixtures are a CHAIN — a note is filed into the notebook the command
/// before it created — so the references are the whole of what makes them
/// runnable. An unresolvable reference drops the command rather than running it
/// with a placeholder id, because a command that ran against an id nothing
/// minted is not a command a member could make.
fn resolve(input: &Value, outputs: &[BTreeMap<String, Value>]) -> Option<Value> {
    match input {
        Value::Object(fields) => {
            if let Some(Value::String(reference)) = fields.get("$from")
                && fields.len() == 1
            {
                let (index, key) = reference.split_once('.')?;
                let index: usize = index.parse().ok()?;
                return outputs.get(index)?.get(key).cloned();
            }
            let mut resolved = serde_json::Map::new();
            for (key, value) in fields {
                resolved.insert(key.clone(), resolve(value, outputs)?);
            }
            Some(Value::Object(resolved))
        }
        Value::Array(items) => items
            .iter()
            .map(|item| resolve(item, outputs))
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        other => Some(other.clone()),
    }
}

fn fixtures(app: &str) -> Vec<Scripted> {
    let path = root()
        .join("contracts")
        .join("apps")
        .join(app)
        .join("commands.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let parsed: Vec<Value> = serde_json::from_str(&text).expect("the fixture is JSON");
    parsed
        .into_iter()
        .filter_map(|entry| {
            Some(Scripted {
                name: entry.get("command")?.as_str()?.to_owned(),
                input: entry.get("input").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

/// A command's answer as a flat map, for the next fixture's `$from`.
fn outputs_of(output: &Value) -> BTreeMap<String, Value> {
    output
        .as_object()
        .map(|fields| {
            fields
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// One row of a page with its minted columns masked, for a set comparison.
type Masked = (String, String, Vec<(String, String)>);

/// One page, POSITIONALLY: the rows in the order the commit carried them.
///
/// Not keyed by primary key, and that is the point: the keys are minted ids and
/// the two runs drew different ones, so a map keyed by them would never line up
/// and a map keyed only by `(table, column)` would collapse two inserts into
/// one and compare the wrong rows against each other.
///
/// Both sides come out of the same changeset decode in the same order, because
/// they are the same handler over the same starting state.
type Page = Vec<(String, String, centraid_vault::RowImage)>;

fn page_of<'row>(
    rows: impl IntoIterator<Item = (&'row str, &'row str, Option<&'row centraid_vault::RowImage>)>,
) -> Page {
    let mut page: Page = rows
        .into_iter()
        .map(|(table, op, image)| {
            (
                table.to_owned(),
                op.to_owned(),
                image.cloned().unwrap_or_default(),
            )
        })
        .collect();
    // GROUPED BY `(table, op)`, STABLY.
    //
    // The changeset decode groups by table and does not fix the order of an
    // insert against a delete WITHIN one — `core.move_document` retags a
    // document and the two runs decoded its `core_tag` delete and insert the
    // other way round. That order carries no meaning: the applier writes each
    // row by its own primary key and they are different rows.
    //
    // Stable, so the order WITHIN a group is still the changeset's and two
    // inserts on one table are still compared against the right partners.
    page.sort_by(|left, right| (&left.0, &left.1).cmp(&(&right.0, &right.1)));
    page
}

/// Every string value anywhere in a command's input.
///
/// What makes "this id was MINTED" checkable rather than a name on a list: an
/// id the member named is in the input and must match exactly, and an id the
/// handler drew from the vault's sequence is not.
fn strings_in(input: &Value, into: &mut BTreeSet<String>) {
    match input {
        Value::String(text) => {
            into.insert(text.clone());
        }
        Value::Array(items) => items.iter().for_each(|item| strings_in(item, into)),
        Value::Object(fields) => fields.values().for_each(|value| strings_in(value, into)),
        _ => {}
    }
}

/// THE PROPERTY, over every command fixture this repository has.
#[test]
fn a_predicted_page_is_the_page_the_gateway_logs() {
    let scratch =
        common::Scratch::founded_with_blobs("prediction-parity").expect("a vault is founded");
    let registry = Registry::with_system_commands().expect("the registry builds");
    registry
        .install(&scratch.vault)
        .expect("the registry's record installs");
    let principal = Principal::owner("dev_parity");

    let mut differing: BTreeSet<String> = BTreeSet::new();
    let mut audited: BTreeSet<String> = BTreeSet::new();
    let mut compared = 0usize;

    for app in [
        "notes", "tasks", "agenda", "people", "tally", "docs", "photos", "locker",
    ] {
        let mut outputs: Vec<BTreeMap<String, Value>> = Vec::new();
        for scripted in fixtures(app) {
            let Some(input) = resolve(&scripted.input, &outputs) else {
                // A reference to a command that did not run. The chain is a
                // chain; a broken link ends this app's run rather than
                // inventing an id.
                break;
            };
            let command = Command::new(scripted.name.clone(), input);
            // WHERE THE LOG STANDS NOW, so the page the execution writes can be
            // read back by position rather than guessed at by recency.
            let before = scratch
                .vault
                .read(centraid_vault::converge::position)
                .expect("the log position reads");

            // THE PREDICTION FIRST, and it rolls back — so the execution below
            // starts from exactly the state the prediction saw.
            let predicted = scratch.vault.predict(&registry, &principal, &command);
            let executed = scratch.vault.execute(&registry, &principal, &command);

            match (predicted, &executed) {
                // A COMMAND THE GATEWAY REFUSES IS ONE THE SEAT DOES NOT SHOW.
                // The fixtures deliberately include refusals; both sides
                // answering "no" is the property for those.
                (Err(_), Ok(outcome)) if outcome.status == CommandStatus::Failed => {}
                (Err(_), Err(_)) => {}
                (Ok(_), Ok(outcome)) if outcome.status == CommandStatus::Failed => {
                    panic!(
                        "`{}` predicted a page and the gateway refused it",
                        scripted.name
                    );
                }
                (Err(error), Ok(_)) => {
                    panic!(
                        "`{}` ran on the gateway and a seat could not predict it: {error}",
                        scripted.name
                    );
                }
                (Ok(_), Err(error)) => {
                    panic!("`{}` would not run at all: {error}", scripted.name);
                }
                (Ok(prediction), Ok(outcome)) => {
                    let predicted_page = page_of(
                        prediction
                            .rows
                            .iter()
                            .map(|row| (row.table.as_str(), row.op.as_str(), row.row.as_ref())),
                    );
                    let Some(commit_seq) = outcome.commit_seq else {
                        // A COMMAND THAT WROTE NOTHING. The prediction must have
                        // written nothing either, which the shape check below
                        // says on an empty page.
                        assert!(
                            prediction.rows.is_empty(),
                            "`{}` predicted rows for a command that committed none",
                            scripted.name
                        );
                        outputs.push(outputs_of(&outcome.output));
                        continue;
                    };
                    let logged = centraid_vault::log::door::read_log_page(
                        &scratch.vault,
                        &centraid_vault::Cursor {
                            epoch: before.0.clone(),
                            seq: before.2,
                        },
                        10_000,
                    )
                    .expect("the log reads");
                    let logged_page = page_of(
                        logged
                            .rows
                            .iter()
                            .filter(|row| !row.local && row.commit_seq == commit_seq)
                            .map(|row| (row.table.as_str(), row.op.as_str(), row.row.as_ref())),
                    );

                    // THE AUDIT TRAIL IS THE GATEWAY'S, BY NAME.
                    //
                    // These tables ARE replicated — a seat holds its vault's
                    // account of what happened — but they are the GATEWAY'S
                    // account of an EXECUTION, and on a seat that execution has
                    // not happened. A prediction that wrote them would put a
                    // fabricated invocation and receipt in the replica, with
                    // ids the gateway never minted and nothing to replace them:
                    // the answering commit inserts its OWN invocation row, so
                    // the predicted one would simply stay, for ever.
                    let logged_rows: Page = logged_page
                        .into_iter()
                        .filter(|(table, _, _)| {
                            if AUDIT_TABLES.contains(&table.as_str()) {
                                audited.insert(table.clone());
                                return false;
                            }
                            true
                        })
                        .collect();

                    // THE SHAPE IS EXACT, IN BOTH DIRECTIONS AND IN ORDER. A
                    // prediction that touched a table the gateway did not — or
                    // missed one it did — is a member looking at a row nothing
                    // will ever replace.
                    let shape = |page: &Page| -> Vec<(String, String, Vec<String>)> {
                        page.iter()
                            .map(|(table, op, image)| {
                                (
                                    table.clone(),
                                    op.clone(),
                                    image.keys().cloned().collect::<Vec<_>>(),
                                )
                            })
                            .collect()
                    };
                    assert_eq!(
                        shape(&predicted_page),
                        shape(&logged_rows),
                        "`{}` predicted a different SHAPE of page",
                        scripted.name
                    );

                    // THE ROWS, MASKED AND COMPARED AS A SET.
                    //
                    // Not positionally within a group: the two runs minted
                    // different ids, so a table's changeset decodes them in a
                    // different order and a positional zip would compare a note
                    // against its neighbour and report every column as wrong.
                    //
                    // WHAT IS MASKED IS ENUMERATED, and in two ways. The
                    // clock's and the trigger's columns are named
                    // ([`GATEWAY_MINTED`]). An ID is masked only when the
                    // member did not name it: an id anywhere in the command's
                    // input must match exactly, and one drawn from the vault's
                    // sequence cannot, because the prediction drew first.
                    let mut named = BTreeSet::new();
                    strings_in(&command.input, &mut named);
                    let mask = |image: &centraid_vault::RowImage| -> Vec<(String, String)> {
                        image
                            .iter()
                            .map(|(column, value)| {
                                let minted = GATEWAY_MINTED.contains(&column.as_str())
                                    || (column.ends_with("_id")
                                        && matches!(
                                            value,
                                            CellValue::Text(text) if !named.contains(text)
                                        ));
                                (
                                    column.clone(),
                                    if minted {
                                        "<minted>".to_owned()
                                    } else {
                                        format!("{value:?}")
                                    },
                                )
                            })
                            .collect()
                    };
                    let masked = |page: &Page| -> BTreeSet<Masked> {
                        page.iter()
                            .map(|(table, op, image)| (table.clone(), op.clone(), mask(image)))
                            .collect()
                    };
                    let predicted_set = masked(&predicted_page);
                    let logged_set = masked(&logged_rows);
                    for row in logged_set.symmetric_difference(&predicted_set) {
                        differing.insert(format!("{}.{} {:?}", row.0, row.1, row.2));
                    }
                    compared += 1;
                }
            }
            // THE CHAIN'S OWN OUTPUTS, so the next fixture's `$from` resolves
            // against the ids this command actually minted.
            outputs.push(match &executed {
                Ok(outcome) => outputs_of(&outcome.output),
                Err(_) => BTreeMap::new(),
            });
        }
    }

    // THE CORPUS ACTUALLY RAN. 98 fixture commands at the time of writing, and
    // the floor is most of them: a `$from` chain that broke early would leave
    // this suite green over three commands and say nothing about the rest.
    assert!(
        compared >= 90,
        "only {compared} fixture commands were compared; the corpus did not load"
    );
    // THE LIST IS TIGHT, WHICH IS THE HALF THAT MATTERS. A column that differed
    // and is not enumerated is a prediction that got a real value wrong.
    // AND THE AUDIT LIST IS TIGHT TOO. A name in it that no fixture ever
    // produced is an exemption nobody is looking at.
    let seen: BTreeSet<String> = AUDIT_TABLES.iter().map(|name| (*name).to_owned()).collect();
    assert_eq!(
        audited, seen,
        "the audit-table exemption names something no fixture produced"
    );
    let allowed: BTreeSet<String> = GATEWAY_MINTED
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    let unexpected: Vec<&String> = differing.difference(&allowed).collect();
    assert!(
        unexpected.is_empty(),
        "a prediction differed from the gateway's page on columns nobody enumerated: {unexpected:?}"
    );
}
