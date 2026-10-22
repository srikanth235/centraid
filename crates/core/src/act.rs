//! `act(app, action, input)`: THE ONE WRITE (#1135).
//!
//! A shell, the chat and the training harness name an app's action and state
//! its input by name. This module is the core's half of `action.proto`'s
//! `ActRequest`, and it is where four rules that every surface used to carry for
//! itself are carried once:
//!
//! | Rule | Where |
//! |---|---|
//! | The same `invoke_key` runs once | [`Settled`]: a second tap answers the first's answer, `replayed` |
//! | A frozen (moved) vault writes nothing | [`moved_epoch`], checked before anything runs |
//! | A refusal names the check that failed | [`wire::ActRefusal`]: `vault_moved`, `input_schema`, or the vault's own predicate |
//! | An executed act can be taken back | [`inverse`], the action and input that reverse it |
//!
//! # THE ORDER
//!
//! 1. the app and the action must be in the catalogue (a caller's mistake is an
//!    `InvalidRequest`, not a refusal: nothing a member did);
//! 2. a key already run answers its answer — before the frozen check, because
//!    replaying a write that landed is not a write;
//! 3. a frozen vault refuses `vault_moved`;
//! 4. the input is decoded by the manifest's schema and validated against it;
//! 5. [`crate::api::command`] runs the command, the one write path a screen's
//!    `Command` request and the chat's confirmed card take too: a Locker secret
//!    is sealed under the open session there, the change feed is told after the
//!    commit there.
//!
//! Only an executed act is remembered. A refused one may be asked again, because
//! what refused it may have changed (a Locker that was shut, a vault restored).

mod inverse;

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Mutex, PoisonError};

use centraid_api_proto::core_v1 as wire;
use centraid_vault::commands::{CommandStatus, Registry};
use centraid_vault::{Principal, Vault};
use serde_json::{Map, Value};

use crate::catalog;
use crate::error::{CoreError, Result};
use crate::events::ChangeFeed;
use crate::phone::Plane;

/// How many executed keys the core remembers. A duplicate tap is a matter of
/// seconds; this is far more than a person can issue in that time and bounds
/// the memory.
const REMEMBERED: usize = 1024;

/// What the core remembers of an executed act: what was asked, and the answer.
struct Remembered {
    /// The canonical request, so a key reused for a different act is caught.
    asked: String,
    answer: wire::ActResponse,
}

/// The executed acts, by `invoke_key`, oldest forgotten first.
#[derive(Default)]
pub(crate) struct Settled {
    inner: Mutex<(BTreeMap<String, Remembered>, VecDeque<String>)>,
}

impl Settled {
    fn recall(&self, key: &str) -> Option<(String, wire::ActResponse)> {
        let held = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        held.0
            .get(key)
            .map(|found| (found.asked.clone(), found.answer.clone()))
    }

    fn remember(&self, key: &str, asked: String, answer: &wire::ActResponse) {
        let mut held = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let (by_key, order) = &mut *held;
        if by_key
            .insert(
                key.to_owned(),
                Remembered {
                    asked,
                    answer: answer.clone(),
                },
            )
            .is_none()
        {
            order.push_back(key.to_owned());
        }
        while order.len() > REMEMBERED {
            if let Some(oldest) = order.pop_front() {
                by_key.remove(&oldest);
            }
        }
    }
}

/// What an act runs against. Borrowed from the handle for one call.
pub(crate) struct Ctx<'a> {
    pub vault: &'a Vault,
    pub locker: &'a crate::locker::phone::Cell,
    pub registry: &'a Registry,
    pub owner: &'a Principal,
    pub changes: &'a ChangeFeed,
    pub plane: &'a Plane,
    pub settled: &'a Settled,
}

/// The writer epoch another phone holds this vault at, when this phone was
/// told so: the ledger remembers the refusal a pass heard, so a frozen vault
/// stays frozen across restarts. A phone that never paired has no ledger and is
/// never frozen — and asking does not make one.
///
/// # Errors
/// The ledger's refusal.
pub(crate) fn moved_epoch(plane: &Plane) -> Result<Option<u64>> {
    if !plane.ledger_path().exists() {
        return Ok(None);
    }
    Ok(crate::phone::moved(&plane.ledger()?)?.map(|(_, epoch)| epoch))
}

/// The refusal a frozen vault answers every write with.
pub(crate) fn vault_moved(epoch: u64) -> wire::ActRefusal {
    wire::ActRefusal {
        check: "vault_moved".to_owned(),
        detail: format!("this vault moved to another phone at epoch {epoch}"),
    }
}

/// The sentence a member reads for a frozen vault.
pub(crate) const MOVED_SENTENCE: &str =
    "This vault moved to another phone. Restore it from your 24 words to keep writing here.";

/// Run one action.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for an app, an action or a key the request
/// gets wrong; the vault's own failures.
pub(crate) fn act(ctx: &Ctx<'_>, request: &wire::ActRequest) -> Result<wire::ActResponse> {
    if request.invoke_key.is_empty() {
        return Err(CoreError::InvalidRequest {
            detail:
                "an act carries no invoke_key; a second tap could not be told from a second act"
                    .to_owned(),
        });
    }
    let app = catalog::app(&request.app).ok_or_else(|| CoreError::InvalidRequest {
        detail: format!("`{}` is not an app this core carries", request.app),
    })?;
    let entry =
        app.manifest()
            .action(&request.action)
            .ok_or_else(|| CoreError::InvalidRequest {
                detail: format!(
                    "app `{}` declares no action `{}`",
                    request.app, request.action
                ),
            })?;
    let command = app
        .command_of(&request.action)
        .ok_or_else(|| CoreError::Invariant {
            context: format!(
                "the manifest of `{}` declares `{}` and its action table does not",
                request.app, request.action
            ),
        })?;

    let asked = canonical(request);
    if let Some((earlier, answer)) = ctx.settled.recall(&request.invoke_key) {
        if earlier != asked {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "invoke_key `{}` already ran a different act; a new act needs a new key",
                    request.invoke_key
                ),
            });
        }
        return Ok(wire::ActResponse {
            replayed: true,
            ..answer
        });
    }

    if let Some(epoch) = moved_epoch(ctx.plane)? {
        return Ok(refused(vault_moved(epoch), MOVED_SENTENCE.to_owned()));
    }

    let input = match decode_input(&entry.input, &request.input) {
        Ok(input) => input,
        Err(detail) => return Ok(refused_check("input_decode", detail)),
    };
    if let Some(detail) = first_schema_error(&entry.input, &input)? {
        return Ok(refused_check("input_schema", detail));
    }

    let input = mint_missing_id(ctx, &entry.input, command, input);
    let command_request = wire::Command {
        name: command.to_owned(),
        input: serde_json::to_vec(&input).map_err(|error| CoreError::Invariant {
            context: format!("a decoded input is not JSON: {error}"),
        })?,
        invoke_key: request.invoke_key.clone(),
        ..wire::Command::default()
    };
    let outcome = match crate::api::command(
        ctx.vault,
        ctx.locker,
        ctx.registry,
        ctx.owner,
        &command_request,
        ctx.changes,
    ) {
        Ok(outcome) => outcome,
        // The command's own schema is stricter than the manifest's: its
        // refusal is the member's to hear, not a crash.
        Err(CoreError::Vault(centraid_vault::VaultError::InvalidInput { detail, .. })) => {
            return Ok(refused_check("command_input", detail));
        }
        Err(other) => return Err(other),
    };

    let Value::Object(input_object) = &input else {
        return Err(CoreError::Invariant {
            context: "a decoded input is always an object".to_owned(),
        });
    };
    let answer = match outcome.status {
        CommandStatus::Executed => {
            let inverse = inverse::of(&request.app, &request.action, input_object, &outcome.output)
                .map(|(action, input)| wire::ActInverse {
                    action: action.to_owned(),
                    input: input_to_wire(&input),
                });
            wire::ActResponse {
                status: wire::ActStatus::Executed as i32,
                output: serde_json::to_vec(&outcome.output).map_err(|error| {
                    CoreError::Invariant {
                        context: format!("a handler's own output is not JSON: {error}"),
                    }
                })?,
                invocation_id: outcome.invocation_id,
                inverse,
                tables: sorted(outcome.tables),
                ..wire::ActResponse::default()
            }
        }
        CommandStatus::Failed => wire::ActResponse {
            invocation_id: outcome.invocation_id,
            ..refused(
                wire::ActRefusal {
                    // THE FAILING CHECK, not only the sentence: the predicate
                    // the vault's own gate named.
                    check: outcome
                        .predicate
                        .clone()
                        .unwrap_or_else(|| "command_refused".to_owned()),
                    detail: outcome.reason.clone().unwrap_or_default(),
                },
                outcome.reason.unwrap_or_default(),
            )
        },
    };
    if answer.status == wire::ActStatus::Executed as i32 {
        ctx.settled.remember(&request.invoke_key, asked, &answer);
    }
    Ok(answer)
}

/// THE ID A COMMAND NEEDS BEFORE IT RUNS, when the caller has no way to state one.
///
/// Most create commands mint their row's id themselves. Locker's cannot: a
/// secret is sealed against the id of the row it will sit in (`AAD = rowId ‖
/// keyId`), so `locker.add_item` requires `item_id` up front. A manifest that does not let the
/// shell name that id (`additionalProperties: false`, no `item_id`) leaves the
/// core to mint it, from the vault's own id source, before sealing.
fn mint_missing_id(
    ctx: &Ctx<'_>,
    manifest_input: &Value,
    command: &str,
    mut input: Value,
) -> Value {
    let requires_item_id = ctx
        .registry
        .get(command)
        .and_then(|entry| {
            entry
                .schema()
                .get("required")
                .and_then(Value::as_array)
                .cloned()
        })
        .is_some_and(|required| required.iter().any(|name| name == "item_id"));
    let statable = manifest_input
        .get("properties")
        .and_then(|properties| properties.get("item_id"))
        .is_some();
    if requires_item_id
        && !statable
        && let Value::Object(object) = &mut input
    {
        object
            .entry("item_id")
            .or_insert_with(|| Value::String(ctx.vault.ids().next()));
    }
    input
}

fn sorted(mut tables: Vec<String>) -> Vec<String> {
    tables.sort();
    tables.dedup();
    tables
}

fn refused(refusal: wire::ActRefusal, reason: String) -> wire::ActResponse {
    wire::ActResponse {
        status: wire::ActStatus::Refused as i32,
        reason,
        refusal: Some(refusal),
        ..wire::ActResponse::default()
    }
}

fn refused_check(check: &str, detail: String) -> wire::ActResponse {
    refused(
        wire::ActRefusal {
            check: check.to_owned(),
            detail: detail.clone(),
        },
        detail,
    )
}

/// What was asked, in one canonical string: the app, the action and the input
/// in key order.
fn canonical(request: &wire::ActRequest) -> String {
    let sorted: BTreeMap<_, _> = request.input.iter().collect();
    format!("{}\u{1f}{}\u{1f}{sorted:?}", request.app, request.action)
}

/// The wire input as the command's JSON, typed by the manifest's schema.
///
/// A SQLite value carries no array, object or boolean, so the schema decides:
/// text for a property typed array or object is its JSON; 0 or 1 for one typed
/// boolean is a boolean. A property the schema does not name passes as the
/// scalar it is and is the schema validator's to refuse.
fn decode_input(
    schema: &Value,
    input: &std::collections::HashMap<String, wire::Value>,
) -> std::result::Result<Value, String> {
    let mut object = Map::new();
    for (name, value) in input {
        let kinds = kinds_of(schema, name);
        let decoded = match &value.kind {
            None | Some(wire::value::Kind::Null(_)) => Value::Null,
            Some(wire::value::Kind::Integer(number)) => {
                if kinds.contains(&"boolean")
                    && !kinds.contains(&"integer")
                    && !kinds.contains(&"number")
                {
                    Value::Bool(*number != 0)
                } else {
                    Value::from(*number)
                }
            }
            Some(wire::value::Kind::Real(number)) => serde_json::Number::from_f64(*number)
                .map(Value::Number)
                .ok_or_else(|| format!("`{name}` is not a finite number"))?,
            Some(wire::value::Kind::Blob(_)) => {
                return Err(format!("`{name}` is bytes, and an action takes none"));
            }
            Some(wire::value::Kind::Text(text)) => {
                let structured = kinds.contains(&"array") || kinds.contains(&"object");
                let untyped = kinds.is_empty() && (text.starts_with('{') || text.starts_with('['));
                if (structured && !kinds.contains(&"string")) || untyped {
                    serde_json::from_str(text).map_err(|error| {
                        format!("`{name}` is not the JSON its schema asks: {error}")
                    })?
                } else {
                    Value::String(text.clone())
                }
            }
        };
        object.insert(name.clone(), decoded);
    }
    Ok(Value::Object(object))
}

/// The JSON types a schema allows a property.
fn kinds_of<'a>(schema: &'a Value, name: &str) -> Vec<&'a str> {
    match schema
        .get("properties")
        .and_then(|props| props.get(name))
        .and_then(|prop| prop.get("type"))
    {
        Some(Value::String(kind)) => vec![kind.as_str()],
        Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

/// The first way `input` fails `schema`, as `<path>: <message>`.
fn first_schema_error(schema: &Value, input: &Value) -> Result<Option<String>> {
    let validator = jsonschema::validator_for(schema).map_err(|error| CoreError::Invariant {
        context: format!("a manifest's input schema does not compile: {error}"),
    })?;
    Ok(validator.iter_errors(input).next().map(|error| {
        let path = error.instance_path.to_string();
        format!("{}: {error}", if path.is_empty() { "/" } else { &path })
    }))
}

/// A JSON object as an act's wire input: the decode's inverse.
fn input_to_wire(input: &Map<String, Value>) -> std::collections::HashMap<String, wire::Value> {
    input
        .iter()
        .map(|(name, value)| {
            let kind = match value {
                Value::Null => wire::value::Kind::Null(wire::NullValue {}),
                Value::Bool(flag) => wire::value::Kind::Integer(i64::from(*flag)),
                Value::Number(number) => number.as_i64().map_or_else(
                    || wire::value::Kind::Real(number.as_f64().unwrap_or_default()),
                    wire::value::Kind::Integer,
                ),
                Value::String(text) => wire::value::Kind::Text(text.clone()),
                structured => wire::value::Kind::Text(structured.to_string()),
            };
            (name.clone(), wire::Value { kind: Some(kind) })
        })
        .collect()
}
