//! THE REPLAY LOOP (`eval/run.py` `run_session`, with `--model gguf`'s step): each session on a private copy of its
//! world's vault, turn by turn, one model message per step until the runtime ends the turn.
//!
//! The prompt is the phone's (`native_turn::log::Log`, the renderer the training data is made with) and the message
//! is the phone's (`native::step::decode_step`, greedy, trace v4, the phone's limits), so what is scored here is what
//! the phone decodes. The model sits behind [`Stepper`], so a test, or a generator checking its own output, needs no
//! weights. Greedy only: the Python driver's resample on a repeated call is a no-op for a greedy backend, so it is not
//! ported.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::time::Instant;

use centraid_assist::model::{Cancel, Model};
use centraid_assist::native::Flags;
use centraid_assist::native::meta::{Kind, STEP_CAP};
use centraid_assist::native::step::{StepOptions, decode_step};
use centraid_assist::native::think::TraceMode;
use centraid_assist::native_turn::cards::app_of;
use centraid_assist::native_turn::log::Log;
use centraid_nativetools::{dates, seed, vaultio};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::EvalError;
use crate::args::{ArgClass, ArgVerdict, bucket, judge_args, turn_constraints};
use crate::effect::{effect_rows, turn_effect};
use crate::gold::{Accept, Session, Turn};
use crate::judge::{Ids, judge_turn};
use crate::source::EvalSource;

/// One message the model wrote.
#[derive(Debug, Clone)]
pub struct StepOut {
    /// From `<think>\n` to the end of the call.
    pub text: String,
    /// The think hit its limit and `</think>` was written for the model.
    pub think_cut: bool,
}

/// The model, as the loop needs it: a rendered prompt in, one message out.
pub trait Stepper {
    /// # Errors
    /// The engine's words when it fails; the session stops there.
    fn step(&self, prompt: &str, dates: Option<&str>) -> Result<StepOut, String>;
}

/// The phone's step over any [`Model`]: `decode_step` with `TraceMode::V4` and the phone's [`StepOptions`], exactly
/// what `assist-step` serves.
pub struct ModelStepper<'a> {
    pub model: &'a dyn Model,
    pub options: StepOptions,
}

impl<'a> ModelStepper<'a> {
    #[must_use]
    pub fn new(model: &'a dyn Model) -> Self {
        Self {
            model,
            options: StepOptions::default(),
        }
    }
}

impl Stepper for ModelStepper<'_> {
    fn step(&self, prompt: &str, dates: Option<&str>) -> Result<StepOut, String> {
        decode_step(
            self.model,
            prompt,
            dates,
            TraceMode::V4,
            self.options,
            &Cancel::new(),
        )
        .map(|out| StepOut {
            text: out.text,
            think_cut: out.info.think_cut,
        })
        .map_err(|error| error.to_string())
    }
}

/// A model that declines everything (`out_of_scope`): the floor, and a way to run the whole rig without weights.
pub struct DeclineStepper;

impl Stepper for DeclineStepper {
    fn step(&self, _prompt: &str, _dates: Option<&str>) -> Result<StepOut, String> {
        Ok(StepOut {
            text: "<think>\nintent: decline\n</think>\n\n<tool_call>\n<function=decline>\n<parameter=reason>\nout_of_scope\n</parameter>\n</function>\n</tool_call>".to_owned(),
            think_cut: false,
        })
    }
}

/// What one turn came to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnResult {
    pub user: String,
    pub pass: bool,
    pub problems: Vec<String>,
    pub wrong_write: bool,
    pub gold_type: String,
    /// How the turn ended (`rows`, `value`, `act`, `ask`, `decline`, `cap`, `loop`, `error`, `none`).
    pub ending: String,
    pub tool_ok: bool,
    /// Constraints on the reference call ([`crate::args::turn_constraints`]).
    pub constraints: usize,
    /// The apps the turn is in (by the kinds of its reference calls and gold rows).
    pub apps: Vec<String>,
    pub args: BTreeMap<String, String>,
    pub tags: Vec<String>,
    pub steps: usize,
    pub think_cut: usize,
    /// The calls the runtime read out of the model's messages.
    pub calls: Vec<Value>,
    pub run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResult {
    pub id: String,
    pub world: String,
    pub tags: Vec<String>,
    pub blocked: bool,
    pub turns: Vec<TurnResult>,
    /// Set when the engine failed: the turns after it were not run.
    pub error: Option<String>,
    pub ms: u64,
}

impl SessionResult {
    #[must_use]
    pub fn pass(&self) -> bool {
        self.turns.iter().all(|t| t.pass)
    }
}

struct SeededWorld {
    vault: PathBuf,
    /// World key → vault id.
    ids: BTreeMap<String, String>,
    /// World key → kind name.
    kinds: BTreeMap<String, String>,
}

/// Runs sessions of a source through a stepper.
pub struct Runner<'a> {
    source: &'a dyn EvalSource,
    stepper: &'a dyn Stepper,
    scratch: tempfile::TempDir,
    worlds: HashMap<String, SeededWorld>,
    copies: usize,
}

fn first_call(text: &str) -> &str {
    const END: &str = "</tool_call>";
    text.find(END).map_or(text, |at| &text[..at + END.len()])
}

fn runtime(message: impl std::fmt::Display) -> EvalError {
    EvalError::Runtime(message.to_string())
}

/// The apps of a turn: the kinds its reference calls name, and the kinds of the rows its gold names.
fn apps_of(turn: &Turn, kinds: &BTreeMap<String, String>) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut add = |kind: Option<Kind>| {
        if let Some(app) = kind.and_then(app_of)
            && !found.iter().any(|f| f == app.id())
        {
            found.push(app.id().to_owned());
        }
    };
    for call in turn.reference.iter().filter(|c| !c.bad) {
        if let Some(Value::String(list)) = call.args.get("kind") {
            list.split(',').for_each(|k| add(Kind::parse(k)));
        }
    }
    let key_kind = |key: &String| kinds.get(key).and_then(|k| Kind::parse(k));
    for Accept {
        rows,
        candidates,
        diff,
        ..
    } in &turn.gold
    {
        rows.iter().chain(candidates).for_each(|k| add(key_kind(k)));
        diff.rows
            .iter()
            .filter_map(|r| r.key.as_ref())
            .for_each(|k| add(key_kind(k)));
        diff.rows
            .iter()
            .filter_map(|r| r.new.as_deref())
            .for_each(|k| add(Kind::parse(k)));
    }
    found.sort_unstable();
    found
}

impl<'a> Runner<'a> {
    /// # Errors
    /// [`EvalError::Runtime`] when no scratch directory can be made.
    pub fn new(source: &'a dyn EvalSource, stepper: &'a dyn Stepper) -> Result<Self, EvalError> {
        Ok(Self {
            source,
            stepper,
            scratch: tempfile::tempdir().map_err(runtime)?,
            worlds: HashMap::new(),
            copies: 0,
        })
    }

    /// Seed a world once; every session copies the result.
    fn world(&mut self, name: &str) -> Result<&SeededWorld, EvalError> {
        if !self.worlds.contains_key(name) {
            let description = self.source.world(name)?;
            let vault = self.scratch.path().join(format!("{name}.vault"));
            let (keys, _dropped) = seed::seed_report(&description, &vault)
                .map_err(|error| EvalError::Data(format!("seeding world {name}: {error}")))?;
            let mut ids = BTreeMap::new();
            let mut kinds = BTreeMap::new();
            for (key, row) in keys.as_object().into_iter().flatten() {
                ids.insert(
                    key.clone(),
                    row["id"].as_str().unwrap_or_default().to_owned(),
                );
                kinds.insert(
                    key.clone(),
                    row["kind"].as_str().unwrap_or_default().to_owned(),
                );
            }
            self.worlds
                .insert(name.to_owned(), SeededWorld { vault, ids, kinds });
        }
        Ok(&self.worlds[name])
    }

    /// Run one session.
    ///
    /// # Errors
    /// [`EvalError`] for bad data (a world that will not seed, gold that names no row); a failing engine is not one:
    /// it ends the session with [`SessionResult::error`].
    pub fn run_session(&mut self, session: &Session) -> Result<SessionResult, EvalError> {
        let started = Instant::now();
        let (base, keys, kinds) = {
            let world = self.world(&session.world)?;
            (world.vault.clone(), world.ids.clone(), world.kinds.clone())
        };
        self.copies += 1;
        let vault = self
            .scratch
            .path()
            .join(format!("session-{}.vault", self.copies));
        vaultio::copy_vault(&base, &vault).map_err(runtime)?;
        let now = dates::parse_now(&session.today).map_err(runtime)?;
        let mut live =
            vaultio::open_session(&vault, now, &session.me, Flags::default()).map_err(runtime)?;
        let prompt = live.prompt();
        let system = prompt["rendered"]
            .as_str()
            .ok_or_else(|| runtime("the runtime's system turn is not text"))?;
        let mut log = Log::new(system.to_owned());
        let mut ids = Ids::new(keys.clone());
        let mut shown: HashMap<String, u64> = HashMap::new(); // vault id → the runtime's #n
        let mut turns = Vec::new();
        let mut error = None;
        for turn in &session.turns {
            let constraints = turn_constraints(turn);
            let apps = apps_of(turn, &kinds);
            if error.is_some() {
                turns.push(not_run(turn, constraints, apps));
                continue;
            }
            let user = live.user(&turn.user);
            log.compact(&user["compacted"]);
            log.user(&turn.user, user["block"].as_str());
            let dates_line = user["dates"].as_str();
            let mut responses: Vec<Value> = Vec::new();
            let mut calls: Vec<Value> = Vec::new();
            let mut think_cut = 0;
            // A RETRACTION ENDS THE TURN IN THE RUNTIME, before any call: no message is asked of the model
            let ended = user.get("ended").filter(|v| v.is_object());
            if let Some(ended) = ended {
                responses.push(ended.clone());
            }
            for _ in 0..(if ended.is_some() { 0 } else { STEP_CAP + 2 }) {
                let prompt = log.prompt().map_err(runtime)?;
                let out = match self.stepper.step(&prompt, dates_line) {
                    Ok(out) => out,
                    Err(message) => {
                        error = Some(message);
                        break;
                    }
                };
                think_cut += usize::from(out.think_cut);
                let sent = first_call(&out.text);
                let response = live.call_text(sent);
                for (id, n) in effect_rows(&response["effect"]) {
                    shown.insert(id, n);
                }
                if response["call"].is_object() {
                    calls.push(response["call"].clone());
                }
                log.assistant(sent);
                log.tool(
                    response["obs"]
                        .as_u64()
                        .and_then(|n| usize::try_from(n).ok()),
                    response["text"].as_str().unwrap_or_default(),
                );
                let ends = response["ends_turn"].as_bool().unwrap_or(false);
                responses.push(response);
                if ends {
                    break;
                }
            }
            if let Some(message) = &error {
                let mut result = not_run(turn, constraints, apps);
                result.problems = vec![format!("engine failed: {message}")];
                turns.push(result);
                continue;
            }
            let effect = turn_effect(&responses);
            let created: Vec<String> = effect
                .diff
                .rows
                .iter()
                .filter(|row| row.change == "created")
                .map(|row| row.id.clone())
                .collect();
            let verdict = judge_turn(turn, effect, &ids)?;
            ids.created.extend(created);
            let handle = |key: &str| {
                let id = keys.get(key)?;
                shown.get(id).map(|n| format!("#{n}"))
            };
            // A turn that passes by effect got every argument it carries right, however it looked first; only a
            // failed turn needs the call comparison, which says which argument to blame.
            let args = judge_args(turn, &calls, &handle)
                .into_iter()
                .map(|(class, v)| {
                    let v = if verdict.pass && v != ArgVerdict::Absent {
                        ArgVerdict::Right
                    } else {
                        v
                    };
                    (class.word().to_owned(), verdict_word(v).to_owned())
                })
                .collect();
            turns.push(TurnResult {
                user: turn.user.clone(),
                pass: verdict.pass,
                problems: verdict.problems,
                wrong_write: verdict.wrong_write,
                gold_type: verdict.gold_type.word().to_owned(),
                ending: verdict.effect.ending.word().to_owned(),
                // a write that landed and then looped still chose the right act
                tool_ok: verdict.pass || verdict.tool_ok,
                constraints,
                apps,
                args,
                tags: turn.tags.clone(),
                steps: verdict.effect.steps,
                think_cut,
                calls,
                run: true,
            });
        }
        drop(live);
        for suffix in ["", "-wal", "-shm"] {
            let mut file = vault.as_os_str().to_os_string();
            file.push(suffix);
            let _ = std::fs::remove_file(file); // best effort: the scratch directory goes with the runner
        }
        Ok(SessionResult {
            id: session.id.clone(),
            world: session.world.clone(),
            tags: session.tags.clone(),
            blocked: session.is_blocked(),
            turns,
            error,
            ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }
}

fn verdict_word(verdict: ArgVerdict) -> &'static str {
    match verdict {
        ArgVerdict::Absent => "absent",
        ArgVerdict::Unscorable => "unscorable",
        ArgVerdict::Right => "right",
        ArgVerdict::Wrong => "wrong",
    }
}

fn not_run(turn: &Turn, constraints: usize, apps: Vec<String>) -> TurnResult {
    TurnResult {
        user: turn.user.clone(),
        pass: false,
        problems: vec!["not run".to_owned()],
        wrong_write: false,
        gold_type: turn
            .gold
            .first()
            .map_or("rows", |a| a.kind.word())
            .to_owned(),
        ending: "none".to_owned(),
        tool_ok: false,
        constraints,
        apps,
        args: ArgClass::ALL
            .iter()
            .map(|c| (c.word().to_owned(), "absent".to_owned()))
            .collect(),
        tags: turn.tags.clone(),
        steps: 0,
        think_cut: 0,
        calls: Vec::new(),
        run: false,
    }
}

/// The label of a turn's constraint count, for callers that group results.
#[must_use]
pub fn constraint_label(turn: &TurnResult) -> &'static str {
    bucket(turn.constraints)
}
