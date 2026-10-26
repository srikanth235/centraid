//! `act(app, action, input)`: THE ONE WRITE (#1135).
//!
//! A shell, the chat and the training harness name an app's action and state
//! its input by name. This module is the core's half of `action.proto`'s
//! `ActRequest`, and it is where four rules that every surface used to carry for
//! itself are carried once:
//!
//! | Rule | Where |
//! |---|---|
//! | The same `invoke_key` runs once | the commit records the key in the vault's journal; a second delivery, after a restart too, answers `replayed` and runs nothing |
//! | A frozen (moved) vault writes nothing | [`moved_epoch`], checked before anything runs |
//! | A refusal names the check that failed | [`wire::ActRefusal`]: `vault_moved`, `input_schema`, or the vault's own predicate |
//! | An executed act can be taken back | [`inverse`], the action and input that reverse it |
//!
//! # THE ORDER
//!
//! 1. the app and the action must be in the catalogue (a caller's mistake is an
//!    `InvalidRequest`, not a refusal: nothing a member did);
//! 2. a key already run answers `replayed` — before the frozen check, because
//!    replaying a write that landed is not a write. The vault holds the key
//!    (`journal.invoke_key`, written in the commit it names), so the memory is as
//!    durable as the write and no second copy of it lives here;
//! 3. a frozen vault refuses `vault_moved`;
//! 4. the input is decoded by the manifest's schema and validated against it;
//! 5. [`crate::api::command`] runs the command, the one write path the chat's
//!    confirmed card and [`crate::Handle::command`] take too: a Locker secret
//!    is sealed under the open session there, the change feed is told after the
//!    commit there.
//!
//! Only an executed act is remembered. A refused one may be asked again, because
//! what refused it may have changed (a Locker that was shut, a vault restored).
//! The replayed answer names the run (`invocation_id`) and carries no output and no
//! inverse: the journal keeps evidence, not answers, so a caller that needs more
//! than "it landed" reads it again.

mod inverse;

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::commands::{CommandStatus, Registry};
use centraid_vault::{Principal, Vault};
use serde_json::{Map, Value};

use crate::catalog;
use crate::error::{CoreError, Result};
use crate::events::ChangeFeed;
use crate::phone::Plane;

/// What an act runs against. Borrowed from the handle for one call.
pub(crate) struct Ctx<'a> {
    pub vault: &'a Vault,
    pub locker: &'a crate::locker::phone::Cell,
    pub registry: &'a Registry,
    pub owner: &'a Principal,
    pub changes: &'a ChangeFeed,
    pub plane: &'a Plane,
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

    let asked = asked_digest(request, &entry.sealed);
    if let Some(earlier) = ctx.vault.recall_key(&request.invoke_key)? {
        return replayed(&request.invoke_key, &earlier, &asked);
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

    let input = mint_declared_ids(ctx, &entry.minted, input);
    let command_request = crate::api::Invocation {
        name: command.to_owned(),
        input: serde_json::to_vec(&input).map_err(|error| CoreError::Invariant {
            context: format!("a decoded input is not JSON: {error}"),
        })?,
        invoke_key: request.invoke_key.clone(),
    };
    let mark = centraid_vault::journal::KeyMark {
        key: &request.invoke_key,
        asked: &asked,
    };
    let outcome = match crate::api::command(
        ctx.vault,
        ctx.locker,
        ctx.registry,
        ctx.owner,
        &command_request,
        ctx.changes,
        Some(&mark),
    ) {
        Ok(outcome) => outcome,
        // The command's own schema is stricter than the manifest's: its
        // refusal is the member's to hear, not a crash.
        Err(CoreError::Vault(centraid_vault::VaultError::InvalidInput { detail, .. })) => {
            return Ok(refused_check("command_input", detail));
        }
        Err(other) => return Err(other),
    };

    // Two deliveries that raced for the write lock: the loser was answered inside the commit.
    if outcome.replayed {
        let earlier =
            ctx.vault
                .recall_key(&request.invoke_key)?
                .ok_or_else(|| CoreError::Invariant {
                    context: "the vault answered a key as replayed and holds no run for it"
                        .to_owned(),
                })?;
        return replayed(&request.invoke_key, &earlier, &asked);
    }
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
    Ok(answer)
}

/// THE IDS A MANIFEST SAYS THE CORE MINTS (`"x-minted": true` on an input property).
///
/// Most create commands mint their row's id themselves. Locker's cannot: a
/// secret is sealed against the id of the row it will sit in (`AAD = rowId ‖
/// keyId`), so `locker.add_item` requires `item_id` up front. An action whose
/// manifest marks that property minted gets one here, from the vault's own id
/// source and before sealing, when the caller states none; a caller that states
/// one keeps it.
fn mint_declared_ids(ctx: &Ctx<'_>, minted: &[String], mut input: Value) -> Value {
    if let Value::Object(object) = &mut input {
        for property in minted {
            object
                .entry(property.clone())
                .or_insert_with(|| Value::String(ctx.vault.ids().next()));
        }
    }
    input
}

/// The answer to a key the vault already holds a run for: the run it named, or
/// a refusal when the key was used for a different act.
fn replayed(
    key: &str,
    earlier: &centraid_vault::journal::Recalled,
    asked: &str,
) -> Result<wire::ActResponse> {
    if earlier.asked != asked {
        return Err(CoreError::InvalidRequest {
            detail: format!(
                "invoke_key `{key}` already ran a different act; a new act needs a new key"
            ),
        });
    }
    Ok(wire::ActResponse {
        status: wire::ActStatus::Executed as i32,
        invocation_id: earlier.seq.to_string(),
        replayed: true,
        ..wire::ActResponse::default()
    })
}

/// A write no manifest action names yet (the `unbacked` rows of `contracts/assist/verbs.json`):
/// the bare command, run the way an act is, under the same key. The answer is an act's.
///
/// # Errors
/// The vault's own failures.
pub(crate) fn command_keyed(
    ctx: &Ctx<'_>,
    command: &str,
    key: &str,
    input: &Value,
) -> Result<wire::ActResponse> {
    let asked = blake3::hash(format!("{command}\u{1f}{}", canonical_text(input)).as_bytes())
        .to_hex()
        .to_string();
    if let Some(earlier) = ctx.vault.recall_key(key)? {
        return replayed(key, &earlier, &asked);
    }
    if let Some(epoch) = moved_epoch(ctx.plane)? {
        return Ok(refused(vault_moved(epoch), MOVED_SENTENCE.to_owned()));
    }
    let request = crate::api::Invocation {
        name: command.to_owned(),
        input: serde_json::to_vec(input).map_err(|error| CoreError::Invariant {
            context: format!("an input is not JSON: {error}"),
        })?,
        invoke_key: key.to_owned(),
    };
    let mark = centraid_vault::journal::KeyMark { key, asked: &asked };
    let outcome = match crate::api::command(
        ctx.vault,
        ctx.locker,
        ctx.registry,
        ctx.owner,
        &request,
        ctx.changes,
        Some(&mark),
    ) {
        Ok(outcome) => outcome,
        Err(CoreError::Vault(centraid_vault::VaultError::InvalidInput { detail, .. })) => {
            return Ok(refused_check("command_input", detail));
        }
        Err(other) => return Err(other),
    };
    if outcome.replayed {
        let earlier = ctx
            .vault
            .recall_key(key)?
            .ok_or_else(|| CoreError::Invariant {
                context: "the vault answered a key as replayed and holds no run for it".to_owned(),
            })?;
        return replayed(key, &earlier, &asked);
    }
    Ok(match outcome.status {
        CommandStatus::Executed => wire::ActResponse {
            status: wire::ActStatus::Executed as i32,
            output: serde_json::to_vec(&outcome.output).map_err(|error| CoreError::Invariant {
                context: format!("a handler's own output is not JSON: {error}"),
            })?,
            invocation_id: outcome.invocation_id,
            tables: sorted(outcome.tables),
            ..wire::ActResponse::default()
        },
        CommandStatus::Failed => wire::ActResponse {
            invocation_id: outcome.invocation_id,
            ..refused(
                wire::ActRefusal {
                    check: outcome
                        .predicate
                        .clone()
                        .unwrap_or_else(|| "command_refused".to_owned()),
                    detail: outcome.reason.clone().unwrap_or_default(),
                },
                outcome.reason.unwrap_or_default(),
            )
        },
    })
}

/// A JSON value as text with its object keys in order, so two spellings of one input digest alike.
fn canonical_text(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let sorted: BTreeMap<_, _> = object.iter().collect();
            let inner: Vec<String> = sorted
                .into_iter()
                .map(|(name, value)| format!("{name:?}:{}", canonical_text(value)))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        Value::Array(items) => {
            let inner: Vec<String> = items.iter().map(canonical_text).collect();
            format!("[{}]", inner.join(","))
        }
        other => other.to_string(),
    }
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

/// What was asked, as a digest: the app, the action and the input in key order,
/// without the sealed fields, whose values never leave the request (a digest of a
/// short secret is one a guess can check).
fn asked_digest(request: &wire::ActRequest, sealed: &[String]) -> String {
    let kept: BTreeMap<_, _> = request
        .input
        .iter()
        .filter(|(name, _)| !sealed.contains(name))
        .collect();
    let canonical = format!("{}\u{1f}{}\u{1f}{kept:?}", request.app, request.action);
    blake3::hash(canonical.as_bytes()).to_hex().to_string()
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
pub(crate) fn input_to_wire(
    input: &Map<String, Value>,
) -> std::collections::HashMap<String, wire::Value> {
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
