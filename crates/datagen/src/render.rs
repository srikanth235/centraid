//! STAGE 6, RENDER: a whole session as the phone renders it, tokenized, with the loss weights of every token.
//!
//! A session is run on a private copy of its world's vault, the way the phone runs one. For each turn the runtime reads
//! the member's message (`Session::user`: the block of `vault:`, `focus:`, `dates:`, `nums:` lines, and the earlier
//! observations it compacts), then each reference call is written as the model writes it: the think derived from the call
//! ([`crate::trace`]), the call text the runtime's compiler gives back for that think, and the observation the runtime
//! answers with. Those go into `centraid_assist::native_turn::log::Log`, the conversation the phone feeds its model, and
//! [`Log::transcript`] renders it with `transcript.rs`: the system turn and catalog, every user turn with its block, every
//! assistant message with its thinking kept, every observation. Nothing here writes a byte of the prompt format.
//!
//! # The loss mask
//!
//! Per-token float weights, from the trained span of each assistant message (from just after `<think>\n` through
//! `<|im_end|>`):
//!
//! * `0.0` the system turn and catalog, every user turn and its block, every tool result, the assistant header, and every
//!   token of a step the runtime was *expected to refuse* (the first half of an error-then-repair turn: the model is
//!   not taught to make the mistake, only to recover from it).
//! * `1.0` every other token of an assistant message, intermediate steps included: the think, `</think>`, the call and
//!   `<|im_end|>`.
//! * [`DECISION_WEIGHT`] (a flag) on the deciding tokens inside those: see [`decisions`].

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context, Result, bail};
use centraid_assist::native::identity::MODEL;
use centraid_assist::native::think::RowText;
use centraid_assist::native::transcript::call_text_of;
use centraid_assist::native_turn::log::Log;
use serde::Serialize;
use serde_json::{Value, json};

use crate::bpe::Bpe;
use crate::catalog::Catalog;
use crate::grid::cell_of;
use crate::intent::{Intent, Scenario, Span, TurnIntent};
use crate::labels;
use crate::plan::WorldRun;
use crate::trace::{self, RefCall, Setting, show_rows};
use crate::world::World;

/// The weight of a deciding token (the op, the filters, the dates, the row and value handles, the numbers), against 1.0
/// for any other token of an assistant message.
pub const DECISION_WEIGHT: f32 = 2.0;

// ---------------------------------------------------------------------------------------------
// the tokenizer
// ---------------------------------------------------------------------------------------------

pub use crate::bpe::Tokens;

/// The chat model's tokenizer read from its `tokenizer.json` ([`Bpe`]), and the BLAKE3 of that file (the data version records
/// it).
pub struct Tokenizer {
    inner: Bpe,
    pub hash: String,
}

impl Tokenizer {
    /// # Errors
    ///
    /// If the file cannot be read or is not a tokenizer of the shape [`Bpe`] reads.
    pub fn open(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).with_context(|| path.display().to_string())?;
        let text = std::str::from_utf8(&bytes).with_context(|| path.display().to_string())?;
        let inner = Bpe::from_json(text).with_context(|| path.display().to_string())?;
        Ok(Self {
            inner,
            hash: blake3::hash(&bytes).to_hex().to_string(),
        })
    }

    /// A tokenizer built in memory (a test's): its `tokenizer.json` text.
    ///
    /// # Errors
    ///
    /// If the text is not a tokenizer of the shape [`Bpe`] reads.
    pub fn from_json(text: &str) -> Result<Self> {
        Ok(Self {
            inner: Bpe::from_json(text)?,
            hash: blake3::hash(text.as_bytes()).to_hex().to_string(),
        })
    }

    /// The ids of `text` and the byte range of `text` each one covers. Special tokens written in the text (`<|im_start|>`,
    /// `<think>`) are the tokens themselves, and none is added.
    ///
    /// # Errors
    ///
    /// If the tokenizer fails.
    pub fn encode(&self, text: &str) -> Result<Tokens> {
        self.inner.encode(text)
    }

    /// The text of `ids`, special tokens kept.
    ///
    /// # Errors
    ///
    /// If the tokenizer fails.
    pub fn decode(&self, ids: &[u32]) -> Result<String> {
        self.inner.decode(ids)
    }
}

/// A byte-level tokenizer with no merges, one token a byte, the special strings of the prompt format as single tokens: what
/// a test, or a dry run without the model's `tokenizer.json`, tokenizes with. The ids mean nothing to any model.
///
/// # Errors
///
/// If the tokenizer cannot be built.
pub fn byte_level_tokenizer() -> Result<Tokenizer> {
    Tokenizer::from_json(&byte_level_tokenizer_json())
}

/// The `tokenizer.json` of [`byte_level_tokenizer`]: Qwen3.5's normalizer and pre-tokenizer, no merges.
#[must_use]
pub fn byte_level_tokenizer_json() -> String {
    let mut alphabet: Vec<char> = crate::bpe::byte_chars().to_vec();
    alphabet.sort_unstable();
    let vocab: serde_json::Map<String, Value> = alphabet
        .iter()
        .enumerate()
        .map(|(i, c)| (c.to_string(), json!(i)))
        .collect();
    let specials = [
        MODEL.im_start,
        MODEL.im_end,
        MODEL.think_open.trim_end(),
        MODEL.think_close,
        MODEL.tool_call_open,
        MODEL.tool_call_close,
        MODEL.tool_response_open,
        MODEL.tool_response_close,
        MODEL.tools_open,
        MODEL.tools_close,
    ];
    let added: Vec<Value> = specials
        .iter()
        .enumerate()
        .map(|(i, text)| {
            json!({"id": alphabet.len() + i, "content": text, "single_word": false, "lstrip": false,
                   "rstrip": false, "normalized": false, "special": true})
        })
        .collect();
    let byte_level = json!({"type": "ByteLevel", "add_prefix_space": false, "trim_offsets": false, "use_regex": false});
    let split = json!({"type": "Split", "pattern": {"Regex": QWEN_SPLIT}, "behavior": "Isolated", "invert": false});
    let tokenizer = json!({
        "version": "1.0", "truncation": null, "padding": null, "added_tokens": added,
        "normalizer": {"type": "NFC"},
        "pre_tokenizer": {"type": "Sequence", "pretokenizers": [split, byte_level]},
        "post_processor": null, "decoder": byte_level,
        "model": {"type": "BPE", "dropout": null, "unk_token": null, "continuing_subword_prefix": "",
                  "end_of_word_suffix": "", "fuse_unk": false, "byte_fallback": false, "ignore_merges": false,
                  "vocab": vocab, "merges": []},
    });
    tokenizer.to_string()
}

/// The `Split` regex of Qwen3.5's `tokenizer.json`.
const QWEN_SPLIT: &str = r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}| ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+";

// ---------------------------------------------------------------------------------------------
// the deciding tokens
// ---------------------------------------------------------------------------------------------

/// Think slots whose whole value decides the call.
const THINK_WHOLE: [&str; 20] = [
    "via",
    "verb",
    "kind",
    "op",
    "field",
    "group",
    "trashed",
    "where",
    "linked_to",
    "within",
    "exclude",
    "order",
    "limit",
    "more",
    "rows",
    "row",
    "value",
    "options",
    "reason",
    "time",
];

/// Call parameters whose value decides the call (`name`, `text` and `question` are words the member said or the runtime
/// composes: the model copies them, it does not decide them).
const CALL_WHOLE: [&str; 17] = [
    "verb",
    "kind",
    "op",
    "field",
    "group",
    "trashed",
    "where",
    "when",
    "linked_to",
    "within",
    "exclude",
    "order",
    "limit",
    "more",
    "rows",
    "value",
    "options",
];

/// The byte ranges of `body`, one assistant message's trained text (`think`, `</think>`, the call, `<|im_end|>`), that
/// decide the call, as the contract of M4 names them: the intent word, the verb and tool, the filters, the dates, the row
/// and value handles, the numbers.
///
/// * In the think: the value of `via`, `verb`, `kind`, `op`, `field`, `group`, `trashed`, `where`, `linked_to`, `within`,
///   `exclude`, `order`, `limit`, `more`, `rows`, `value`, `options`, `reason` and `time`; the intent word (not its quoted
///   phrase); the row number of `pick` (not its reason); the date after `=` in `when` (not the phrase or source before it);
///   the value after each `=` in `set`.
/// * In the call: the value of the parameters of [`CALL_WHOLE`], the values of the `args` lines, and the value of every
///   field a `create` or `edit` carries as a parameter of its own (not a `name`).
///
/// Not decisions: `name`, `text` and `question`, the phrases, the `retry` line, the labels, the tool name and the
/// scaffolding tokens.
#[must_use]
pub fn decisions(body: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let split = body.find(MODEL.think_close).unwrap_or(body.len());
    // the think: `label: value` lines
    let mut at = 0;
    for line in body[..split].split_inclusive('\n') {
        let line_text = line.trim_end_matches('\n');
        if let Some((label, value)) = line_text.split_once(": ") {
            let start = at + label.len() + 2;
            let end = at + line_text.len();
            match label {
                "intent" => {
                    let word = value.split(' ').next().unwrap_or_default();
                    out.push((start, start + word.len()));
                }
                "pick" => {
                    let number = value.split(' ').next().unwrap_or_default();
                    out.push((start, start + number.len()));
                }
                "when" => {
                    if let Some(found) = value.rfind(" = ") {
                        out.push((start + found + 3, end));
                    } else {
                        out.push((start, end));
                    }
                }
                "set" => {
                    let mut from = 0;
                    for part in value.split(" · ") {
                        if let Some(found) = part.find(" = ") {
                            let begin = from + found + 3;
                            let skip = usize::from(part[found + 3..].starts_with('~'));
                            out.push((start + begin + skip, start + from + part.len()));
                        }
                        from += part.len() + " · ".len();
                    }
                }
                other if THINK_WHOLE.contains(&other) => out.push((start, end)),
                _ => {}
            }
        }
        at += line.len();
    }
    // the call: `<parameter=NAME>\nVALUE\n</parameter>` blocks
    let tool = body[split..]
        .find(MODEL.function_open)
        .map(|found| {
            let rest = &body[split + found + MODEL.function_open.len()..];
            rest.split('>').next().unwrap_or_default().to_owned()
        })
        .unwrap_or_default();
    let own: &[&str] = match tool.as_str() {
        "create" => &["kind", "args", "more"],
        "edit" => &["rows", "args", "more"],
        _ => &[],
    };
    let mut from = split;
    while let Some(found) = body[from..].find(MODEL.parameter_open) {
        let name_at = from + found + MODEL.parameter_open.len();
        let Some(name_end) = body[name_at..].find(">\n") else {
            break;
        };
        let name = &body[name_at..name_at + name_end];
        let value_at = name_at + name_end + 2;
        let Some(value_end) = body[value_at..].find(&format!("\n{}", MODEL.parameter_close)) else {
            break;
        };
        let value = &body[value_at..value_at + value_end];
        if name == "args" {
            let mut line_at = value_at;
            for line in value.split('\n') {
                if let Some(found) = line.find(": ") {
                    out.push((line_at + found + 2, line_at + line.len()));
                }
                line_at += line.len() + 1;
            }
        } else if CALL_WHOLE.contains(&name)
            || (matches!(tool.as_str(), "create" | "edit")
                && !own.contains(&name)
                && !matches!(name, "name" | "text" | "question"))
        {
            out.push((value_at, value_at + value_end));
        }
        from = value_at + value_end;
    }
    out.retain(|(start, end)| end > start);
    out.sort_unstable();
    out
}

/// The weight of each token. `spans` are the trained byte ranges of the assistant messages, `masked` says which of them the
/// model is not taught (a call it is expected to be refused), `offsets` the byte range each token covers.
///
/// A token is trained when it lies wholly inside a span; it is a decision token when it also overlaps a decision range of
/// that span.
#[must_use]
pub fn weights(
    text: &str,
    spans: &[(usize, usize)],
    masked: &[bool],
    offsets: &[(usize, usize)],
    decision: f32,
) -> Vec<f32> {
    let marks: Vec<Vec<(usize, usize)>> = spans
        .iter()
        .map(|(start, end)| {
            decisions(&text[*start..*end])
                .into_iter()
                .map(|(a, b)| (start + a, start + b))
                .collect()
        })
        .collect();
    let mut out = vec![0.0; offsets.len()];
    let mut span = 0;
    for (i, (start, end)) in offsets.iter().enumerate() {
        while span < spans.len() && spans[span].1 <= *start {
            span += 1;
        }
        let Some((from, to)) = spans.get(span) else {
            break;
        };
        if *start < *from || *end > *to || masked.get(span).copied().unwrap_or(false) {
            continue;
        }
        out[i] = if marks[span].iter().any(|(a, b)| *start < *b && *a < *end) {
            decision
        } else {
            1.0
        };
    }
    out
}

// ---------------------------------------------------------------------------------------------
// one session
// ---------------------------------------------------------------------------------------------

/// What a session is, for the mix.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Features {
    pub id: String,
    pub split: String,
    pub world: String,
    /// The app of the first turn that names one.
    pub app: String,
    /// Every app any turn touches, sorted.
    pub apps: Vec<String>,
    /// The grid cell of each turn.
    pub cells: Vec<String>,
    pub turns: usize,
    pub across: bool,
    /// `pair:<id>` on a minimal pair's two sessions.
    pub pair: Option<String>,
    /// The BLAKE3 of the normalised user texts and the gold, hex.
    pub key: String,
    pub tokens: usize,
    /// Per turn: how it ends (`done`, `empty`, `ask`, `decline`, `repair`).
    pub outcomes: Vec<String>,
    /// Per turn: `read`, `write`, `recall`, or `""` for a decline.
    pub actions: Vec<String>,
    /// Per turn: how it points at a row (`name`, `filters`, `pronoun`, `nickname`), or `""`.
    pub refs: Vec<String>,
    /// Per turn: it asks for what the vault cannot do.
    pub impossible: Vec<bool>,
    /// The kinds any turn touches, sorted.
    pub kinds: Vec<String>,
    /// The combinations (`labels::combos`) any turn is an instance of, sorted.
    pub combos: Vec<String>,
    /// The combinations of `combos` that are reserved for test; filled by the mix.
    pub reserved: Vec<String>,
    /// The style the messages were written in, and the writer's model (tags of the record).
    pub style: String,
    pub writer: String,
}

/// What rendering one session counted.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Counts {
    pub steps: usize,
    /// Steps whose think the compiler read back as the reference call (every step of a rendered session).
    pub roundtrips: usize,
    pub dates_ref: usize,
    pub dates_literal: usize,
    pub nums_ref: usize,
    pub tokens: usize,
    pub tokens_zero: usize,
    pub tokens_one: usize,
    pub tokens_decision: usize,
    /// Steps the model is not taught (an expected refusal).
    pub masked_steps: usize,
}

impl Counts {
    pub fn add(&mut self, other: &Self) {
        self.steps += other.steps;
        self.roundtrips += other.roundtrips;
        self.dates_ref += other.dates_ref;
        self.dates_literal += other.dates_literal;
        self.nums_ref += other.nums_ref;
        self.tokens += other.tokens;
        self.tokens_zero += other.tokens_zero;
        self.tokens_one += other.tokens_one;
        self.tokens_decision += other.tokens_decision;
        self.masked_steps += other.masked_steps;
    }
}

/// A rendered session.
pub struct Done {
    /// The record as a JSON line (no trailing newline).
    pub line: String,
    pub features: Features,
    pub counts: Counts,
    /// The session lost its last turns to a step that did not round-trip.
    pub truncated: bool,
}

/// Why a turn could not be rendered.
#[derive(Debug, Clone)]
pub struct Refused {
    /// 0-based turn.
    pub turn: usize,
    pub reason: String,
    pub detail: String,
}

fn intent_word(turn: &TurnIntent, call: &RefCall) -> &'static str {
    match call.tool.as_str() {
        "ask" => return "ask",
        "decline" => return "decline",
        "create" | "edit" | "do" => return "write",
        _ => {}
    }
    match &turn.intent {
        Intent::Read { .. } => "read",
        Intent::Count { .. } | Intent::Measure { .. } | Intent::Compare { .. } => "count",
        Intent::Write { .. } | Intent::Edit { .. } | Intent::Create { .. } => "write",
        Intent::Recall { value, .. } => {
            if *value {
                "count"
            } else {
                "read"
            }
        }
        Intent::Ask { verb, .. } => {
            if verb.is_some() {
                "write"
            } else {
                "read"
            }
        }
        Intent::Decline { .. } => "read",
    }
}

/// The text of the session as the phone renders it, and the byte range of every assistant message's trained text.
struct Transcript {
    text: String,
    spans: Vec<(usize, usize)>,
    masked: Vec<bool>,
    counts: Counts,
    /// `(turn, call, when)` of the calls whose period is written as the days it covers.
    rewrites: Vec<(usize, usize, String)>,
}

fn transcript(
    run: &mut WorldRun<'_>,
    scenario: &Scenario,
    turns: &[Value],
    record_today: &str,
    upto: usize,
) -> Result<Transcript, Refused> {
    let refuse = |turn: usize, reason: &str, detail: String| Refused {
        turn,
        reason: reason.to_owned(),
        detail,
    };
    let mut live = run
        .open()
        .map_err(|error| refuse(0, "open", error.to_string()))?;
    let prompt = live.session.prompt();
    let system = prompt["rendered"]
        .as_str()
        .ok_or_else(|| refuse(0, "open", "no system turn".to_owned()))?
        .to_owned();
    let today: jiff::civil::Date = record_today
        .get(..10)
        .and_then(|day| day.parse().ok())
        .ok_or_else(|| refuse(0, "open", "the session has no `today`".to_owned()))?;
    let mut log = Log::new(system);
    let mut counts = Counts::default();
    let mut masked: Vec<bool> = Vec::new();
    let mut rows: BTreeMap<String, RowText> = BTreeMap::new();
    let mut earlier: Vec<Value> = Vec::new();
    let mut seen = String::new();
    let mut rewrites: Vec<(usize, usize, String)> = Vec::new();
    for (t, turn) in turns.iter().enumerate().take(upto) {
        let intent = scenario
            .turns
            .get(t)
            .ok_or_else(|| refuse(t, "scenario", "a turn the scenario lacks".to_owned()))?;
        let message = turn["user"].as_str().unwrap_or_default();
        let said = live.session.user(message);
        if said.get("ended").is_some_and(Value::is_object) {
            return Err(refuse(
                t,
                "retraction",
                "the runtime ends the turn on the message".to_owned(),
            ));
        }
        let block = said["block"].as_str().unwrap_or_default().to_owned();
        log.compact(&said["compacted"]);
        log.user(message, said["block"].as_str());
        show_rows(&mut rows, &block);
        seen.push_str(&block);
        seen.push('\n');
        let calls: Vec<RefCall> = turn["ref"]
            .as_array()
            .map(|calls| calls.iter().filter_map(RefCall::of).collect())
            .unwrap_or_default();
        if calls.is_empty() {
            return Err(refuse(
                t,
                "no_calls",
                "a turn with no reference call".to_owned(),
            ));
        }
        let mut retry = false;
        let mut ended = false;
        let mut turn_kind: Option<String> = None;
        for (k, call) in calls.iter().enumerate() {
            let setting = Setting {
                message,
                today,
                intent: intent_word(intent, call),
                block: &block,
                rows: &rows,
                earlier_dates: &earlier,
                seen: &seen,
                turn_kind: turn_kind.as_deref(),
                retry,
            };
            let traced = trace::trace(call, &setting).map_err(|failure| {
                let word = failure.word();
                refuse(
                    t,
                    word,
                    format!("{} {}: {}", call.tool, call_summary(call), failure.detail()),
                )
            })?;
            if let Some(when) = &traced.when {
                rewrites.push((t, k, when.clone()));
            }
            counts.steps += 1;
            counts.roundtrips += 1;
            counts.dates_ref += usize::from(traced.sourcing.dates_ref);
            counts.dates_literal += usize::from(traced.sourcing.dates_literal);
            counts.nums_ref += usize::from(traced.sourcing.nums_ref);
            let said_text = format!(
                "{}{}\n{}\n\n{}",
                MODEL.think_open,
                traced.think,
                MODEL.think_close,
                call_text_of(&traced.call)
            );
            let reply = live.session.call_text(&said_text);
            let failed = reply["effect"].get("error").is_some();
            if failed != call.bad {
                return Err(refuse(
                    t,
                    "diverged",
                    format!(
                        "{} was {} by the runtime: {}",
                        call.tool,
                        if failed { "refused" } else { "accepted" },
                        reply["text"]
                            .as_str()
                            .unwrap_or_default()
                            .lines()
                            .next()
                            .unwrap_or_default()
                    ),
                ));
            }
            let text = reply["text"].as_str().unwrap_or_default();
            log.assistant(&said_text);
            log.tool(
                reply["obs"].as_u64().and_then(|n| usize::try_from(n).ok()),
                text,
            );
            show_rows(&mut rows, text);
            seen.push_str(text);
            seen.push('\n');
            let when = traced.when.clone().or_else(|| {
                call.args
                    .iter()
                    .find(|(key, _)| key == "when")
                    .map(|(_, when)| when.clone())
            });
            if let Some(expr) = when.and_then(|when| serde_json::from_str::<Value>(&when).ok()) {
                earlier.push(expr);
            }
            if matches!(call.tool.as_str(), "find" | "compute")
                && let Some((_, kind)) = call.args.iter().find(|(key, _)| key == "kind")
            {
                turn_kind = Some(kind.clone());
            }
            masked.push(call.bad);
            counts.masked_steps += usize::from(call.bad);
            retry = call.bad;
            ended = reply["ends_turn"].as_bool().unwrap_or(false);
        }
        if !ended {
            return Err(refuse(
                t,
                "unfinished",
                "the turn's last call did not end it".to_owned(),
            ));
        }
    }
    let rendered = log
        .transcript()
        .map_err(|error| refuse(0, "transcript", error))?;
    let spans = rendered.byte_spans();
    Ok(Transcript {
        text: rendered.text,
        spans,
        masked,
        counts,
        rewrites,
    })
}

fn call_summary(call: &RefCall) -> String {
    call.args
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Normalised text for the duplicate key: lower case, letters and digits, single spaces.
#[must_use]
pub fn normalise(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            out.extend(ch.to_lowercase());
        } else if !out.ends_with(' ') && !out.is_empty() {
            out.push(' ');
        }
    }
    out.trim_end().to_owned()
}

fn features_of(
    record: &Value,
    scenario: &Scenario,
    kept: usize,
    split: &str,
    tokens: usize,
) -> Features {
    let apps: std::collections::BTreeSet<String> = scenario
        .turns
        .iter()
        .take(kept)
        .flat_map(|turn| turn.apps.iter().cloned())
        .collect();
    let app = scenario
        .turns
        .iter()
        .take(kept)
        .find_map(|turn| turn.apps.first().cloned())
        .unwrap_or_else(|| "-".to_owned());
    let kept_turns = || scenario.turns.iter().take(kept);
    let tag_value = |prefix: &str| {
        record["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .find_map(|tag| tag.strip_prefix(prefix))
            .unwrap_or_default()
            .to_owned()
    };
    let mut hasher = blake3::Hasher::new();
    for turn in record["turns"].as_array().into_iter().flatten().take(kept) {
        hasher.update(normalise(turn["user"].as_str().unwrap_or_default()).as_bytes());
        hasher.update(b"\n");
        hasher.update(turn["gold"].to_string().as_bytes());
        hasher.update(b"\n");
    }
    let pair = record["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find(|tag| tag.starts_with("pair:"))
        .map(str::to_owned);
    Features {
        id: record["id"].as_str().unwrap_or_default().to_owned(),
        split: split.to_owned(),
        world: record["world"].as_str().unwrap_or_default().to_owned(),
        app,
        apps: apps.into_iter().collect(),
        cells: scenario
            .turns
            .iter()
            .take(kept)
            .map(|turn| cell_of(turn).to_string())
            .collect(),
        turns: kept,
        across: scenario.span == Span::Across,
        pair,
        key: hasher.finalize().to_hex().to_string(),
        tokens,
        outcomes: kept_turns()
            .map(|t| labels::outcome(t).to_owned())
            .collect(),
        actions: kept_turns().map(|t| labels::action(t).to_owned()).collect(),
        refs: kept_turns()
            .map(|t| labels::reference(t).to_owned())
            .collect(),
        impossible: kept_turns().map(labels::impossible).collect(),
        kinds: kept_turns()
            .flat_map(labels::kinds)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        combos: kept_turns()
            .flat_map(labels::combos)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        reserved: Vec::new(),
        style: tag_value("style:"),
        writer: tag_value("writer:"),
    }
}

/// The record of a session the renderer kept: the `assist_eval` session shape (`id`, `world`, `today`, `me`, `tags`,
/// `turns[{user, gold, ref, tags}]`, which `assist-eval` loads unchanged), the facts the mix and the slices read
/// (`meta`), and the `render` the trainer reads.
///
/// # Errors
///
/// If the session cannot be rendered (see [`Refused`]) at all, not even as a shorter session.
#[allow(clippy::too_many_arguments)]
pub fn session(
    run: &mut WorldRun<'_>,
    record: &Value,
    split: &str,
    tokenizer: &Tokenizer,
    decision: f32,
) -> Result<(Done, Option<Refused>), Refused> {
    let scenario: Scenario =
        serde_json::from_value(record["scenario"].clone()).map_err(|error| Refused {
            turn: 0,
            reason: "scenario".to_owned(),
            detail: error.to_string(),
        })?;
    let turns: Vec<Value> = record["turns"].as_array().cloned().unwrap_or_default();
    let mut upto = turns.len();
    let mut first: Option<Refused> = None;
    loop {
        match transcript(
            run,
            &scenario,
            &turns,
            record["today"].as_str().unwrap_or_default(),
            upto,
        ) {
            Ok(rendered) => {
                let done = finish(
                    record, &scenario, &rendered, upto, split, tokenizer, decision,
                )
                .map_err(|error| Refused {
                    turn: 0,
                    reason: "tokenize".to_owned(),
                    detail: error.to_string(),
                })?;
                return Ok((
                    Done {
                        truncated: upto < turns.len(),
                        ..done
                    },
                    first,
                ));
            }
            Err(refused) => {
                let turn = refused.turn;
                if first.is_none() {
                    first = Some(refused.clone());
                }
                if turn == 0 || turn >= upto {
                    return Err(refused);
                }
                upto = turn;
            }
        }
    }
}

fn finish(
    record: &Value,
    scenario: &Scenario,
    rendered: &Transcript,
    kept: usize,
    split: &str,
    tokenizer: &Tokenizer,
    decision: f32,
) -> Result<Done> {
    let (ids, offsets) = tokenizer.encode(&rendered.text)?;
    let w = weights(
        &rendered.text,
        &rendered.spans,
        &rendered.masked,
        &offsets,
        decision,
    );
    if w.len() != ids.len() {
        bail!("{} weights for {} tokens", w.len(), ids.len());
    }
    let mut counts = rendered.counts.clone();
    counts.tokens = ids.len();
    for weight in &w {
        if *weight == 0.0 {
            counts.tokens_zero += 1;
        } else if (*weight - 1.0).abs() < f32::EPSILON {
            counts.tokens_one += 1;
        } else {
            counts.tokens_decision += 1;
        }
    }
    let features = features_of(record, scenario, kept, split, ids.len());
    let mut out = record.clone();
    if let Some(object) = out.as_object_mut() {
        object.remove("scenario");
    }
    for (t, k, when) in &rendered.rewrites {
        if *t < kept
            && let Some(args) = out["turns"][*t]["ref"][*k]["args"].as_object_mut()
        {
            args.insert("when".to_owned(), Value::String(when.clone()));
        }
    }
    if let Some(list) = out["turns"].as_array_mut() {
        list.truncate(kept);
    }
    if kept < record["turns"].as_array().map_or(0, Vec::len) {
        let mut tags: Vec<Value> = out["tags"].as_array().cloned().unwrap_or_default();
        tags.push(json!("truncated"));
        out["tags"] = Value::Array(tags);
    }
    out["meta"] = json!({
        "app": features.app,
        "apps": features.apps,
        "cells": features.cells,
        "span": scenario.span.word(),
    });
    let mut line = serde_json::to_string(&out)?;
    line.pop(); // the closing brace: `render` goes in before it
    line.push_str(",\"render\":{\"input_ids\":[");
    for (i, id) in ids.iter().enumerate() {
        if i > 0 {
            line.push(',');
        }
        line.push_str(&id.to_string());
    }
    line.push_str("],\"weights\":[");
    for (i, weight) in w.iter().enumerate() {
        if i > 0 {
            line.push(',');
        }
        line.push_str(&format!("{weight:?}"));
    }
    line.push_str("],\"text\":");
    line.push_str(&serde_json::to_string(&rendered.text)?);
    line.push_str("}}");
    Ok(Done {
        line,
        features,
        counts,
        truncated: false,
    })
}

/// A record's tokens decoded run by run, the mask drawn on them: text with weight 0 as it is (a run longer than `keep`
/// characters is cut in the middle), weight 1 inside `[[ ]]`, and a deciding token inside `{{ }}` (with its weight when it is
/// not the default).
///
/// # Errors
///
/// If the tokenizer cannot decode a run.
pub fn visualise(
    tokenizer: &Tokenizer,
    ids: &[u32],
    weights: &[f32],
    keep: usize,
) -> Result<String> {
    let mut out = String::new();
    let mut at = 0;
    while at < ids.len() {
        let weight = weights[at];
        let mut end = at + 1;
        while end < ids.len() && (weights[end] - weight).abs() < f32::EPSILON {
            end += 1;
        }
        let text = tokenizer.decode(&ids[at..end])?;
        if weight == 0.0 {
            let chars: Vec<char> = text.chars().collect();
            if chars.len() > keep * 2 {
                out.extend(&chars[..keep]);
                out.push_str(&format!(
                    " …({} chars of context)… ",
                    chars.len() - keep * 2
                ));
                out.extend(&chars[chars.len() - keep..]);
            } else {
                out.push_str(&text);
            }
        } else if (weight - 1.0).abs() < f32::EPSILON {
            out.push_str(&format!("[[{text}]]"));
        } else {
            out.push_str(&format!("{{{{{text}}}}}"));
        }
        at = end;
    }
    Ok(out)
}

/// A rendered session, and the first turn that would not render (the session is then a shorter one), or why it did not.
pub type Outcome = Result<(Done, Option<Refused>), Refused>;

/// Render every session of one world, in order, on one vault seeded once.
///
/// # Errors
///
/// If the world cannot be seeded.
pub fn world(
    doc: &Value,
    catalog: &Catalog,
    records: &[(String, Value)],
    tokenizer: &Tokenizer,
    decision: f32,
    scratch: &Path,
) -> Result<Vec<(String, Outcome)>> {
    let world = World::from_doc(doc)?;
    let mut run = WorldRun::seed(&world, catalog, scratch)?;
    Ok(records
        .iter()
        .map(|(split, record)| {
            (
                record["id"].as_str().unwrap_or_default().to_owned(),
                session(&mut run, record, split, tokenizer, decision),
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = "intent: write \"rename it\"\nverb: edit\npick: #30 (created)\nname: Pay\nset: name = Pay rent · date = ~week+1 wd5\ntime: 9:30\n</think>\n\n<tool_call>\n<function=edit>\n<parameter=rows>\n#30\n</parameter>\n<parameter=name>\nPay rent\n</parameter>\n<parameter=date>\n{\"unit\":\"week\",\"rel\":1}\n</parameter>\n</function>\n</tool_call><|im_end|>";

    fn spans(body: &str) -> Vec<&str> {
        decisions(body)
            .into_iter()
            .map(|(a, b)| &body[a..b])
            .collect()
    }

    #[test]
    fn the_deciding_text_of_a_step_is_the_intent_word_the_handles_the_dates_and_the_values() {
        assert_eq!(
            spans(BODY),
            [
                "write",
                "edit",
                "#30",
                "Pay rent",
                "week+1 wd5",
                "9:30",
                "#30",
                "{\"unit\":\"week\",\"rel\":1}",
            ],
        );
    }

    #[test]
    fn a_name_a_phrase_a_reason_and_the_scaffolding_decide_nothing() {
        let body = "retry: rejected\nintent: read \"what is due\"\nvia: find\nkind: task\nname: Pay\nwhen: \"last week\" = dates[0]\n</think>\n\n<tool_call>\n<function=find>\n<parameter=kind>\ntask\n</parameter>\n<parameter=name>\nPay\n</parameter>\n</function>\n</tool_call><|im_end|>";
        let marked = spans(body);
        assert_eq!(marked, ["read", "find", "task", "dates[0]", "task"]);
        assert!(!marked.contains(&"Pay"));
    }

    #[test]
    fn weights_are_zero_outside_a_span_one_inside_and_more_on_a_decision() {
        let tokenizer = byte_level_tokenizer().unwrap();
        let text = format!(
            "{}user\nwhat is due{}\n{}assistant\n{}{BODY}\n",
            MODEL.im_start, MODEL.im_end, MODEL.im_start, MODEL.think_open
        );
        let start = text.find(BODY).unwrap();
        let spans = [(start, start + BODY.len())];
        let (ids, offsets) = tokenizer.encode(&text).unwrap();
        let w = weights(&text, &spans, &[false], &offsets, 2.0);
        assert_eq!(w.len(), ids.len());
        for (i, (a, b)) in offsets.iter().enumerate() {
            if *b <= start || *a >= start + BODY.len() {
                assert_eq!(w[i], 0.0, "{:?} is context", &text[*a..*b]);
            } else {
                assert!(w[i] >= 1.0, "{:?} is trained", &text[*a..*b]);
            }
        }
        // the op word is a decision, its label is not
        let at = |needle: &str| {
            let from = text.find(needle).unwrap();
            offsets
                .iter()
                .position(|(a, b)| *a <= from && from < *b)
                .unwrap()
        };
        assert_eq!(w[at("edit\npick")], 2.0);
        assert_eq!(w[at("verb:")], 1.0);
        // the tag that closes the message is trained, the newline after it is not
        let last = text.rfind("<|im_end|>").unwrap();
        let closing = offsets
            .iter()
            .position(|(a, b)| *a == last && *b > last)
            .unwrap();
        assert_eq!(w[closing], 1.0);
        // a masked span (a call the runtime is expected to refuse) teaches nothing
        let none = weights(&text, &spans, &[true], &offsets, 2.0);
        assert!(none.iter().all(|w| *w == 0.0));
    }

    #[test]
    fn offsets_are_bytes_so_a_multibyte_character_cuts_nowhere() {
        let tokenizer = byte_level_tokenizer().unwrap();
        let text = "set: name = Pay · date = ~day+1 — é";
        let (ids, offsets) = tokenizer.encode(text).unwrap();
        assert_eq!(ids.len(), offsets.len());
        // the bytes of one character are separate tokens that share the character's range
        let mut end = 0;
        for (a, b) in &offsets {
            assert!(text.is_char_boundary(*a) && text.is_char_boundary(*b));
            assert!(*a <= end, "no gap");
            end = end.max(*b);
        }
        assert_eq!(end, text.len());
        assert!(
            text.len() > text.chars().count(),
            "the text holds multibyte characters"
        );
        assert_eq!(tokenizer.decode(&ids).unwrap(), text);
    }

    #[test]
    fn a_normalised_text_ignores_case_punctuation_and_spacing() {
        assert_eq!(normalise("Show me  the Tasks!"), "show me the tasks");
        assert_eq!(normalise(" a-b,c "), "a b c");
    }
}
