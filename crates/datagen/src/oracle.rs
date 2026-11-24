//! PART 4, RUNTIME ORACLE, AMBIGUITY RESOLVER, SELECTIVE READER GATING & CURRENCY CHECK.
//!
//! 1. **Runtime oracle**: replays every kept example on the current `centraid-assist` runtime;
//!    gold IS the runtime output (`turn_effect`); errors and wrong shapes are dropped and counted.
//! 2. **Ambiguity resolver**: for cached phrasings whose world neighbourhood changed, asks the
//!    runtime resolver (`Session::user` + `find`) whether the reference still uniquely picks the
//!    intended row/set.
//! 3. **Selective LLM reader**: runs ONLY on brand-new phrasings and cases the runtime resolver
//!    could not settle.
//! 4. **Currency message check**: enforces valid currency forms (`INR`: `₹`, `Rs`, `Rs.`, `INR`,
//!    `rupee`, `lakh`, `crore`; others: `$`, `€`, `£`, `AED`, `S$`) and rejects mismatched currencies.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::Result;
use centraid_assist::native::Flags;
use centraid_assist_eval::effect::{Ending, turn_effect};
use centraid_nativetools::{dates, vaultio};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::catalog::Catalog;
use crate::fixture_world::FixtureTarget;
use crate::intent::{Intent, Outcome, Selector, Target, TurnIntent, VerbArg};
use crate::intents::IntentSpec;
use crate::phrasing_cache::{CachedVariant, ReaderCheck};
use crate::plan::{CLOCK, WorldRun, call_xml, is_placeholder, placeholder, tools_mode};
use crate::world::World;

/// Safety check (`safety.md`): no sealed placeholder or datagen marker may ever reach prompts,
/// tool results, or training records.
///
/// # Errors
///
/// If a sealed placeholder is detected.
pub fn check_no_sealed(text: &str) -> Result<(), String> {
    if text.contains("placeholder:") || is_placeholder(text) || text.contains("⟨m3:") {
        return Err("sealed or datagen placeholder detected in text".to_owned());
    }
    Ok(())
}

/// Currency message check for money turns.
///
/// Enforces allowed currency forms:
/// - `INR`: `₹`, `Rs`, `Rs.`, `INR`, `rupee`, `rupees`, `lakh`, `lakhs`, `crore`, `crores`
/// - `USD`: `$`, `USD`, `dollar`, `dollars`
/// - `EUR`: `€`, `EUR`, `euro`, `euros`
/// - `GBP`: `£`, `GBP`, `pound`, `pounds`
/// - `AED`: `AED`, `dirham`, `dirhams`
/// - `SGD`: `S$`, `SGD`, `singapore dollar`
///
/// Rejects messages that omit any currency marker or mention a conflicting foreign currency.
///
/// # Errors
///
/// Returns a plain diagnostic if the message violates the expected currency.
pub fn check_currency_message(message: &str, expected_currency: &str) -> Result<(), String> {
    let lower = message.to_lowercase();
    let has_inr = message.contains('₹')
        || contains_word(&lower, "inr")
        || contains_word(&lower, "rs")
        || lower.contains("rs.")
        || contains_word(&lower, "rupee")
        || contains_word(&lower, "rupees")
        || contains_word(&lower, "lakh")
        || contains_word(&lower, "lakhs")
        || contains_word(&lower, "crore")
        || contains_word(&lower, "crores");
    let has_sgd = message.contains("S$")
        || message.contains("s$")
        || contains_word(&lower, "sgd")
        || lower.contains("singapore dollar");
    let has_usd = (message.contains('$') && !has_sgd)
        || contains_word(&lower, "usd")
        || contains_word(&lower, "dollar")
        || contains_word(&lower, "dollars");
    let has_eur = message.contains('€')
        || contains_word(&lower, "eur")
        || contains_word(&lower, "euro")
        || contains_word(&lower, "euros");
    let has_gbp = message.contains('£')
        || contains_word(&lower, "gbp")
        || contains_word(&lower, "pound")
        || contains_word(&lower, "pounds");
    let has_aed = contains_word(&lower, "aed")
        || contains_word(&lower, "dirham")
        || contains_word(&lower, "dirhams");

    let (ok, others) = match expected_currency {
        "INR" => (has_inr, has_usd || has_eur || has_gbp || has_aed || has_sgd),
        "USD" => (has_usd, has_inr || has_eur || has_gbp || has_aed || has_sgd),
        "EUR" => (has_eur, has_inr || has_usd || has_gbp || has_aed || has_sgd),
        "GBP" => (has_gbp, has_inr || has_usd || has_eur || has_aed || has_sgd),
        "AED" => (has_aed, has_inr || has_usd || has_eur || has_gbp || has_sgd),
        "SGD" => (has_sgd, has_inr || has_usd || has_eur || has_gbp || has_aed),
        other => return Err(format!("unsupported currency `{other}`")),
    };

    if others {
        return Err(format!(
            "message mentions a currency conflicting with expected `{expected_currency}`: {message}"
        ));
    }
    if !ok {
        return Err(format!(
            "money message lacks an accepted `{expected_currency}` currency form: {message}"
        ));
    }
    Ok(())
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    let mut start = 0;
    while let Some(idx) = haystack[start..].find(needle) {
        let abs = start + idx;
        let end = abs + needle.len();
        let left_ok = abs == 0
            || !haystack[..abs]
                .chars()
                .next_back()
                .is_some_and(char::is_alphanumeric);
        let right_ok = end == haystack.len()
            || !haystack[end..]
                .chars()
                .next()
                .is_some_and(char::is_alphanumeric);
        if left_ok && right_ok {
            return true;
        }
        start = abs + needle.len();
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AmbiguityVerdict {
    Unique,
    Ambiguous(usize),
    Unresolved(String),
}

/// Ask the runtime resolver whether `message` on `world` still uniquely identifies `target`.
///
/// # Errors
///
/// If seeding the world fails.
pub fn check_ambiguity_resolver(
    world: &World,
    catalog: &Catalog,
    target: &FixtureTarget,
    message: &str,
    scratch: &Path,
) -> Result<AmbiguityVerdict> {
    let run = WorldRun::seed(world, catalog, scratch)?;
    let _ = run;
    let base = scratch.join(format!("{}.vault", world.id()));
    let probe = scratch.join(format!("{}-ambig.vault", world.id()));
    vaultio::copy_vault(&base, &probe).map_err(anyhow::Error::msg)?;
    let today_at = format!("{}T{CLOCK}", world.today);
    let now = dates::parse_now(&today_at).map_err(anyhow::Error::msg)?;
    let flags = Flags {
        tools: tools_mode(),
        ..Flags::default()
    };
    let mut live =
        vaultio::open_session(&probe, now, &world.persona.me, flags).map_err(anyhow::Error::msg)?;
    let said = live.user(message);
    if said.get("ended").is_some_and(Value::is_object) {
        return Ok(AmbiguityVerdict::Unresolved(
            "runtime ended turn as retraction".to_owned(),
        ));
    }
    let find_call = call_xml(
        "find",
        &Map::from_iter([
            ("kind".to_owned(), json!(target.kind)),
            ("name".to_owned(), json!(target.name)),
        ]),
    );
    let resp = live.call_text(&find_call);
    let rows = resp["effect"]["rows"].as_array().map_or(0, Vec::len);
    match rows {
        1 => Ok(AmbiguityVerdict::Unique),
        0 => Ok(AmbiguityVerdict::Unresolved(format!(
            "resolver found 0 rows for `{}` (`{}`)",
            target.name, target.kind
        ))),
        n => Ok(AmbiguityVerdict::Ambiguous(n)),
    }
}

/// Selective LLM reader gate: returns `true` ONLY for new phrasings (`Pending`) or cases where
/// the world neighbourhood changed and the runtime resolver could not uniquely settle ambiguity.
#[must_use]
pub fn needs_reader_check(
    variant: &CachedVariant,
    current_neighbourhood_hash: &str,
    resolver_verdict: Option<&AmbiguityVerdict>,
) -> bool {
    if variant.reader_check == ReaderCheck::Pending {
        return true;
    }
    if variant.world_neighbourhood_hash != current_neighbourhood_hash {
        return !matches!(resolver_verdict, Some(AmbiguityVerdict::Unique));
    }
    false
}

#[derive(Debug, Clone)]
pub struct OracleResult {
    pub session_record: Value,
    pub drop_reason: Option<String>,
}

/// Replay a planned [`IntentSpec`] with real `messages` on the current runtime.
///
/// Target (`gold`) is recorded directly from the runtime's `turn_effect` so a kept example is
/// always aligned with the current runtime. Returns `Ok(Err(drop_reason))` if the runtime
/// refuses or returns an unexpected ending/shape.
///
/// # Errors
///
/// Only if seeding the vault itself fails.
#[allow(clippy::too_many_lines)]
pub fn replay_intent(
    spec: &IntentSpec,
    catalog: &Catalog,
    messages: &[String],
    scratch: &Path,
) -> Result<std::result::Result<Value, String>> {
    for msg in messages {
        if let Err(e) = check_no_sealed(msg) {
            return Ok(Err(e));
        }
    }
    let base = scratch.join(format!("{}.vault", spec.world.id()));
    if !base.exists() {
        std::fs::create_dir_all(scratch)?;
    }
    let report = spec.world.seed_into(&base)?;
    let mut ids_to_keys = BTreeMap::new();
    for (key, row) in report.as_object().into_iter().flatten() {
        if let Some(id) = row["id"].as_str() {
            ids_to_keys.insert(id.to_owned(), key.clone());
        }
    }
    let vault = scratch.join(format!("{}-oracle.vault", spec.world.id()));
    vaultio::copy_vault(&base, &vault).map_err(anyhow::Error::msg)?;
    let today_at = format!("{}T{CLOCK}", spec.world.today);
    let now = dates::parse_now(&today_at).map_err(anyhow::Error::msg)?;
    let flags = Flags {
        tools: tools_mode(),
        ..Flags::default()
    };
    let mut live = vaultio::open_session(&vault, now, &spec.world.persona.me, flags)
        .map_err(anyhow::Error::msg)?;

    let mut created: Vec<String> = Vec::new();
    let mut turn_handles: Vec<Option<String>> = Vec::new();
    let mut out_turns = Vec::new();

    for (t_idx, turn) in spec.scenario.turns.iter().enumerate() {
        let user_msg = messages
            .get(t_idx)
            .cloned()
            .unwrap_or_else(|| placeholder(&spec.scenario.id, t_idx));
        let said = live.user(&user_msg);
        if said.get("ended").is_some_and(Value::is_object) {
            return Ok(Err(format!(
                "turn {t_idx}: runtime ended turn as retraction"
            )));
        }
        let steps = build_reference_steps(turn, &spec.target, &turn_handles, t_idx, catalog);
        let mut responses = Vec::new();
        let mut step_handles: Vec<Option<String>> = Vec::new();
        let mut ref_calls = Vec::new();
        let mut last_handle: Option<String> = None;

        for step in &steps {
            let mut resolved_args = Map::new();
            for (k, v) in &step.args {
                let rv = resolve_step_markers(v, &step_handles, &turn_handles);
                resolved_args.insert((*k).to_owned(), Value::String(rv));
            }
            let xml = call_xml(step.tool, &resolved_args);
            let resp = live.call_text(&xml);
            let obs_text = resp["text"].as_str().unwrap_or_default();
            if let Err(e) = check_no_sealed(obs_text) {
                return Ok(Err(format!("turn {t_idx}: {e}")));
            }
            let failed = resp["effect"].get("error").is_some();
            if failed != step.bad {
                let err_line = obs_text.lines().next().unwrap_or("error");
                return Ok(Err(format!(
                    "turn {t_idx}: tool `{}` (bad={}) {}",
                    step.tool, step.bad, err_line
                )));
            }
            let handle = resp["effect"]["answer"]["result"]
                .as_str()
                .or_else(|| resp["effect"]["result"].as_str())
                .map(str::to_owned);
            if handle.is_some() {
                last_handle.clone_from(&handle);
            }
            step_handles.push(handle);
            let mut call_obj = json!({"tool": step.tool, "args": resolved_args});
            if step.bad {
                call_obj["bad"] = json!(true);
            }
            ref_calls.push(call_obj);
            responses.push(resp);
        }

        let effect = turn_effect(&responses);
        for r in &effect.diff.rows {
            if r.change == "created" && !created.contains(&r.id) {
                created.push(r.id.clone());
            }
        }
        if matches!(
            effect.ending,
            Ending::Error | Ending::None | Ending::Cap | Ending::Loop
        ) {
            return Ok(Err(format!(
                "turn {t_idx}: invalid runtime ending {}",
                effect.ending.word()
            )));
        }

        let key_of = |id: &str| -> std::result::Result<String, String> {
            if let Some(k) = ids_to_keys.get(id) {
                return Ok(k.clone());
            }
            if let Some(pos) = created.iter().position(|c| c == id) {
                return Ok(format!("+{}", pos + 1));
            }
            Err(format!("unkeyed world row id `{id}`"))
        };
        let gold = match effect_to_gold(&effect, &key_of, turn) {
            Ok(g) => g,
            Err(e) => return Ok(Err(format!("turn {t_idx}: {e}"))),
        };
        turn_handles.push(last_handle);

        let mut turn_json = json!({
            "user": user_msg,
            "gold": [gold],
            "ref": ref_calls,
            "tags": [
                format!("outcome:{}", turn.outcome.word()),
                format!("reference:{}", turn.reference.word()),
            ],
            "outcome": turn.outcome.word(),
            "apps": turn.apps,
            "slice": if turn.slice.is_empty() { spec.slice.clone() } else { turn.slice.clone() },
        });
        if let Some(app) = turn.apps.first() {
            turn_json["app"] = json!(app);
        }
        if let Some(field) = &turn.field {
            turn_json["field"] = json!(field);
        }
        if !turn.fields.is_empty() {
            turn_json["fields"] = json!(turn.fields);
        }
        if let Some(curr) = &turn.currency {
            turn_json["currency"] = json!(curr);
        }
        out_turns.push(turn_json);
    }

    let apps: BTreeSet<String> = spec
        .scenario
        .turns
        .iter()
        .flat_map(|t| t.apps.iter().cloned())
        .collect();
    let app = spec
        .scenario
        .turns
        .iter()
        .find_map(|t| t.apps.first().cloned())
        .unwrap_or_else(|| "-".to_owned());

    let record = json!({
        "id": spec.scenario.id,
        "world": spec.world.id(),
        "today": spec.world.today,
        "me": spec.world.persona.me,
        "split": spec.split.name(),
        "tags": spec.scenario.tags,
        "turns": out_turns,
        "scenario": spec.scenario,
        "meta": {
            "app": app,
            "apps": apps.into_iter().collect::<Vec<_>>(),
            "outcome": spec.signature.outcome,
            "field": spec.scenario.turns.first().and_then(|t| t.field.clone()),
            "currency": spec.signature.currency,
            "slice": spec.slice,
            "cells": spec.covered_cells,
            "span": spec.scenario.span.word(),
            "meaning_key": spec.meaning_key,
        }
    });

    Ok(Ok(record))
}

struct OracleStep {
    tool: &'static str,
    args: Vec<(&'static str, String)>,
    bad: bool,
}

fn build_selector_args(
    sel: &Selector,
    turn_handles: &[Option<String>],
) -> Vec<(&'static str, String)> {
    let mut args = vec![("kind", sel.kind.clone())];
    if let Some(name) = &sel.name {
        args.push(("name", name.clone()));
    }
    if !sel.filters.is_empty() {
        let clauses: Vec<String> = sel.filters.iter().map(|f| f.clause()).collect();
        args.push(("where", clauses.join(" and ")));
    }
    if let Some(period) = &sel.period {
        args.push(("when", period.when()));
    }
    if let Some(turn) = sel.within
        && turn_handles.get(turn).and_then(|h| h.as_ref()).is_some()
    {
        args.push(("within", format!("§t{turn}")));
    }
    if let Some((field, desc)) = &sel.order {
        args.push((
            "order",
            format!("{field} {}", if *desc { "desc" } else { "asc" }),
        ));
    }
    if let Some(limit) = sel.limit {
        args.push(("limit", limit.to_string()));
    }
    if sel.trashed {
        args.push(("trashed", "true".to_owned()));
    }
    if let Some(text) = &sel.text {
        args.push(("text", text.clone()));
    }
    args
}

#[allow(clippy::too_many_lines)]
fn build_reference_steps(
    turn: &TurnIntent,
    target: &FixtureTarget,
    turn_handles: &[Option<String>],
    t_idx: usize,
    catalog: &Catalog,
) -> Vec<OracleStep> {
    let mut steps = Vec::new();
    match &turn.intent {
        Intent::Read { sel } => {
            if sel.open_row {
                steps.push(OracleStep {
                    tool: "find",
                    args: vec![("kind", sel.kind.clone()), ("name", target.name.clone())],
                    bad: false,
                });
                steps.push(OracleStep {
                    tool: "find",
                    args: vec![("rows", "§s0".to_owned())],
                    bad: false,
                });
                steps.push(OracleStep {
                    tool: "answer",
                    args: vec![("rows", "§s1".to_owned())],
                    bad: false,
                });
            } else {
                let mut args = build_selector_args(sel, turn_handles);
                if sel.within.is_some() && !args.iter().any(|(k, _)| *k == "within") {
                    args.push(("name", target.name.clone()));
                }
                steps.push(OracleStep {
                    tool: "find",
                    args,
                    bad: false,
                });
                steps.push(OracleStep {
                    tool: "answer",
                    args: vec![("rows", "§s0".to_owned())],
                    bad: false,
                });
            }
        }
        Intent::Count { sel } => {
            let mut args = build_selector_args(sel, turn_handles);
            args.push(("op", "count".to_owned()));
            steps.push(OracleStep {
                tool: "compute",
                args,
                bad: false,
            });
            steps.push(OracleStep {
                tool: "answer",
                args: vec![("value", "§s0".to_owned())],
                bad: false,
            });
        }
        Intent::Measure { measure } => {
            let mut args = build_selector_args(&measure.sel, turn_handles);
            args.push(("op", measure.op.clone()));
            args.push(("field", measure.field.clone()));
            if let Some(g) = &measure.group {
                args.push(("group", g.clone()));
            }
            steps.push(OracleStep {
                tool: "compute",
                args,
                bad: false,
            });
            steps.push(OracleStep {
                tool: "answer",
                args: vec![("value", "§s0".to_owned())],
                bad: false,
            });
        }
        Intent::Compare { a, b } => {
            let mut args_a = build_selector_args(&a.sel, turn_handles);
            args_a.push(("op", a.op.clone()));
            args_a.push(("field", a.field.clone()));
            let mut args_b = build_selector_args(&b.sel, turn_handles);
            args_b.push(("op", b.op.clone()));
            args_b.push(("field", b.field.clone()));
            steps.push(OracleStep {
                tool: "compute",
                args: args_a,
                bad: false,
            });
            steps.push(OracleStep {
                tool: "compute",
                args: args_b,
                bad: false,
            });
            steps.push(OracleStep {
                tool: "compute",
                args: vec![("op", "compare".to_owned()), ("rows", "§s0,§s1".to_owned())],
                bad: false,
            });
            steps.push(OracleStep {
                tool: "answer",
                args: vec![("value", "§s2".to_owned())],
                bad: false,
            });
        }
        Intent::Create { kind, fields } => {
            let lines: Vec<String> = fields
                .iter()
                .map(|c| format!("{}: {}", c.field, c.value.render()))
                .collect();
            steps.push(OracleStep {
                tool: "create",
                args: vec![("kind", kind.clone()), ("args", lines.join("\n"))],
                bad: false,
            });
        }
        Intent::Edit {
            target: tgt,
            changes,
        } => {
            let rows_arg = match tgt {
                Target::Name {
                    kind,
                    name,
                    trashed,
                    ..
                } => {
                    let mut f_args = vec![("kind", kind.clone()), ("name", name.clone())];
                    if *trashed {
                        f_args.push(("trashed", "true".to_owned()));
                    }
                    steps.push(OracleStep {
                        tool: "find",
                        args: f_args,
                        bad: false,
                    });
                    format!("§s{}", steps.len() - 1)
                }
                Target::Select { sel } => {
                    steps.push(OracleStep {
                        tool: "find",
                        args: build_selector_args(sel, turn_handles),
                        bad: false,
                    });
                    format!("§s{}", steps.len() - 1)
                }
                Target::Turn { turn: prev, .. } => {
                    if *prev < t_idx {
                        format!("§t{prev}")
                    } else {
                        "@1".to_owned()
                    }
                }
            };
            let lines: Vec<String> = changes
                .iter()
                .map(|c| format!("{}: {}", c.field, c.value.render()))
                .collect();
            steps.push(OracleStep {
                tool: "edit",
                args: vec![("rows", rows_arg), ("args", lines.join("\n"))],
                bad: false,
            });
        }
        Intent::Write {
            target: tgt,
            verb,
            arg,
        } => {
            if verb == "undo" {
                steps.push(OracleStep {
                    tool: "do",
                    args: vec![("verb", "undo".to_owned())],
                    bad: false,
                });
                return steps;
            }
            let rowless = matches!(
                verb.as_str(),
                "export" | "import" | "follow" | "unfollow" | "empty_trash" | "apply" | "configure"
            );
            let mut do_args = vec![("verb", verb.clone())];
            if rowless {
                let kind_name = match tgt {
                    Target::Select { sel } => sel.kind.clone(),
                    Target::Name { kind, .. } => kind.clone(),
                    Target::Turn { kind, .. } => kind.clone(),
                };
                do_args.push(("kind", kind_name));
            } else {
                let rows_arg = match tgt {
                    Target::Name {
                        kind,
                        name,
                        trashed,
                        ..
                    } => {
                        let mut f_args = vec![("kind", kind.clone()), ("name", name.clone())];
                        if *trashed {
                            f_args.push(("trashed", "true".to_owned()));
                        }
                        steps.push(OracleStep {
                            tool: "find",
                            args: f_args,
                            bad: false,
                        });
                        format!("§s{}", steps.len() - 1)
                    }
                    Target::Select { sel } => {
                        steps.push(OracleStep {
                            tool: "find",
                            args: build_selector_args(sel, turn_handles),
                            bad: false,
                        });
                        format!("§s{}", steps.len() - 1)
                    }
                    Target::Turn { turn: prev, .. } => format!("§t{prev}"),
                };
                do_args.push(("rows", rows_arg));
            }
            match arg {
                VerbArg::None => {}
                VerbArg::When(w) => do_args.push(("args", format!("to: {w}"))),
                VerbArg::Choice(c) => {
                    let key = if verb == "reveal" {
                        "field"
                    } else if verb == "respond" {
                        "answer"
                    } else {
                        "kind"
                    };
                    do_args.push(("args", format!("{key}: {c}")));
                }
                VerbArg::Label(l) => {
                    let key = if verb == "categorize" {
                        "category"
                    } else {
                        "label"
                    };
                    do_args.push(("args", format!("{key}: {l}")));
                }
                VerbArg::MultiArgs(pairs) => {
                    let lines: Vec<String> =
                        pairs.iter().map(|(k, v)| format!("{k}: {v}")).collect();
                    do_args.push(("args", lines.join("\n")));
                }
                VerbArg::Container(link) => {
                    let at = steps.len();
                    steps.push(OracleStep {
                        tool: "find",
                        args: vec![("kind", link.kind.clone()), ("name", link.name.clone())],
                        bad: false,
                    });
                    let key = match verb.as_str() {
                        "remove_from" | "detach" => "from",
                        "merge" => "into",
                        _ => "to",
                    };
                    do_args.push(("args", format!("{key}: §s{at}")));
                }
            }
            steps.push(OracleStep {
                tool: "do",
                args: do_args,
                bad: false,
            });
        }
        Intent::Recall { turn: prev, value } => {
            let arg = if *value { "value" } else { "rows" };
            steps.push(OracleStep {
                tool: "answer",
                args: vec![(arg, format!("§t{prev}"))],
                bad: false,
            });
        }
        Intent::Ask { kind, name, .. } => {
            steps.push(OracleStep {
                tool: "find",
                args: vec![("kind", kind.clone()), ("name", name.clone())],
                bad: false,
            });
            steps.push(OracleStep {
                tool: "ask",
                args: vec![
                    ("question", format!("Which {kind} do you mean?")),
                    ("options", "§s0".to_owned()),
                ],
                bad: false,
            });
        }
        Intent::Decline { reason } => {
            if reason == "not_found" {
                steps.push(OracleStep {
                    tool: "find",
                    args: vec![
                        ("kind", "person".to_owned()),
                        ("name", crate::plan::NOT_FOUND_NAME.to_owned()),
                    ],
                    bad: false,
                });
            }
            steps.push(OracleStep {
                tool: "decline",
                args: vec![("reason", reason.clone())],
                bad: false,
            });
        }
    }

    if turn.outcome == Outcome::Repair
        && let Some(first) = steps.first()
        && let Some(mistake) = crate::mistakes::pick(
            &crate::mistakes::for_read(catalog, &target.kind, first.tool == "compute"),
            &format!("{:?}", turn.intent),
        )
    {
        let mut shifted = Vec::with_capacity(steps.len() + 1);
        shifted.push(OracleStep {
            tool: mistake.tool,
            args: mistake.args.clone(),
            bad: true,
        });
        for mut s in steps {
            for (_, v) in &mut s.args {
                *v = shift_step_markers(v, 1);
            }
            shifted.push(s);
        }
        return shifted;
    }

    steps
}

fn shift_step_markers(text: &str, by: usize) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find("§s") {
        out.push_str(&rest[..at]);
        let tail = &rest[at + "§s".len()..];
        let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
        if let Ok(n) = digits.parse::<usize>() {
            out.push_str(&format!("§s{}", n + by));
        } else {
            out.push_str("§s");
        }
        rest = &tail[digits.len()..];
    }
    out.push_str(rest);
    out
}

fn resolve_step_markers(
    text: &str,
    step_handles: &[Option<String>],
    turn_handles: &[Option<String>],
) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find('§') {
        out.push_str(&rest[..at]);
        let tail = &rest[at + '§'.len_utf8()..];
        let kind = tail.chars().next().unwrap_or('s');
        let digits: String = tail[kind.len_utf8()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let n: usize = digits.parse().unwrap_or(0);
        let value = match kind {
            's' => step_handles.get(n).cloned().flatten(),
            _ => turn_handles.get(n).cloned().flatten(),
        }
        .unwrap_or_else(|| "@0".to_owned());
        out.push_str(&value);
        rest = &tail[kind.len_utf8() + digits.len()..];
    }
    out.push_str(rest);
    out
}

fn effect_to_gold(
    effect: &centraid_assist_eval::effect::Effect,
    key: &dyn Fn(&str) -> std::result::Result<String, String>,
    turn: &TurnIntent,
) -> std::result::Result<Value, String> {
    let mut accept = Map::new();
    match effect.ending {
        Ending::Rows => {
            accept.insert("type".into(), json!("rows"));
            let rows: Vec<String> = effect
                .rows
                .iter()
                .map(|id| key(id))
                .collect::<std::result::Result<Vec<_>, _>>()?;
            accept.insert("rows".into(), json!(rows));
            if matches!(&turn.intent, Intent::Read { sel } if sel.order.is_some()) {
                accept.insert("order".into(), json!(true));
            }
        }
        Ending::Value => {
            accept.insert("type".into(), json!("value"));
            if let Some(groups) = effect.value["groups"].as_array() {
                let mut map = Map::new();
                for g in groups {
                    let k = g["key"]
                        .as_str()
                        .map_or_else(|| g["key"].to_string(), str::to_owned);
                    map.insert(k, g["values"].clone());
                }
                accept.insert("groups".into(), Value::Object(map));
            } else {
                accept.insert("values".into(), effect.value["values"].clone());
            }
        }
        Ending::Ask => {
            accept.insert("type".into(), json!("ask"));
            let c: Vec<String> = effect
                .options
                .iter()
                .map(|id| key(id))
                .collect::<std::result::Result<Vec<_>, _>>()?;
            accept.insert("candidates".into(), json!(c));
        }
        Ending::Decline => {
            accept.insert("type".into(), json!("decline"));
            accept.insert(
                "reasons".into(),
                json!([effect.reason.clone().unwrap_or_default()]),
            );
        }
        Ending::Act => {
            accept.insert("type".into(), json!("diff"));
        }
        other => return Err(format!("turn ended in {}", other.word())),
    }
    if !effect.diff.rows.is_empty() || !effect.diff.links.is_empty() {
        let mut rows = Vec::new();
        for r in &effect.diff.rows {
            let mut fields = Map::new();
            for (name, (_, new)) in &r.fields {
                if new.is_null() && r.change == "created" {
                    continue;
                }
                let v = if let Some(amount) = new.get("amount") {
                    amount.clone()
                } else {
                    new.clone()
                };
                fields.insert(name.clone(), v);
            }
            let mut row = Map::new();
            if r.change == "created" {
                row.insert("new".into(), json!(r.kind));
            } else {
                row.insert("key".into(), json!(key(&r.id)?));
                row.insert("change".into(), json!(r.change));
            }
            row.insert("fields".into(), Value::Object(fields));
            rows.push(Value::Object(row));
        }
        let mut links = Vec::new();
        for l in &effect.diff.links {
            let side = |id: &str| -> std::result::Result<String, String> {
                if effect
                    .diff
                    .rows
                    .iter()
                    .any(|r| r.change == "created" && r.id == id)
                {
                    Ok("new".to_owned())
                } else {
                    key(id)
                }
            };
            links.push(json!({"change": l.change, "from": side(&l.from)?, "to": side(&l.to)?}));
        }
        accept.insert("diff".into(), json!({"rows": rows, "links": links}));
    }
    Ok(Value::Object(accept))
}
