//! A SESSION: the turn loop, the session-wide `#n` / `@n` numbering, the
//! selector, the read tools, compaction and the step rules (SPEC §3, §4, §6).

use std::collections::{BTreeMap, BTreeSet};

use jiff::civil::DateTime;
use serde_json::{Map, Value, json};

use crate::native::dates::{self, Resolved};
use crate::native::door::Door;
use crate::native::meta::{self, FieldType, Kind, ROW_CAP, STEP_CAP};
use crate::native::render;
use crate::native::resolve::{Resolution, Tier};
use crate::native::whr::{self, Cond};
use crate::native::world::{Key, Row, Val, World};

/// Which ablated parts of the prompt are on (SPEC §6.0.4, §6.1).
#[derive(Debug, Clone, Copy)]
pub struct Flags {
    /// The vault directory of the system prompt.
    pub directory: bool,
    /// The block of every user turn: the `vault:`, `focus:` and `dates:` lines.
    pub preground: bool,
    pub tools: crate::native::prompt::ToolsMode,
    /// Which conventions of `crate::native::ground` run.
    pub defaults: crate::native::ground::Defaults,
    /// Whether a malformed call is repaired before it runs (`crate::native::normalize`). A best-effort
    /// help for the model's calls: the reference runs that make the gold turn it off, so what a
    /// reference states is what runs.
    pub normalize: bool,
    /// Whether the runtime composes the asks and declines the model never has to write
    /// (`crate::native::compose`, SPEC §4.8): a write whose selector fits several rows or none, an
    /// `answer` whose name reaches no row, a refusal of the vault or of the verb, and what it
    /// decides without ending the turn: a `find` that missed is a plain miss with a hint, a
    /// write the person says takes every row takes them, and a write by a name that reached
    /// nothing goes to the one near spelling of its kind. Off, those calls get the observations
    /// the model used to answer (`ambiguous:`, `0 … called …`, `error: … was refused`), for
    /// comparison runs (`--no-compose`). `undo` is not behind it.
    pub compose: bool,
}

impl Default for Flags {
    fn default() -> Self {
        Self {
            directory: true,
            preground: true,
            tools: crate::native::prompt::ToolsMode::Sig,
            defaults: crate::native::ground::Defaults::default(),
            normalize: true,
            compose: true,
        }
    }
}

/// What one call produced.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub text: String,
    pub ends_turn: bool,
    pub effect: Map<String, Value>,
}

impl Outcome {
    pub(crate) fn error(text: impl Into<String>) -> Self {
        let text = text.into();
        let mut effect = Map::new();
        effect.insert("error".to_owned(), json!(text));
        Self {
            text,
            ends_turn: false,
            effect,
        }
    }

    pub(crate) fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ends_turn: false,
            effect: Map::new(),
        }
    }
}

/// One observation as the transcript holds it.
#[derive(Debug, Clone)]
pub(crate) struct Obs {
    pub turn: usize,
    pub seq: usize,
    /// A result block (`find`, `search`, `answer` rows, `open`): compacted.
    pub result: bool,
    pub handle: Option<usize>,
    pub summary: String,
    pub header: String,
    /// Lines, each tagged with the `#n` it shows.
    pub lines: Vec<(Vec<usize>, String)>,
    pub compacted: Option<BTreeSet<usize>>,
    /// A trailing note (the step cap) that is not part of the block.
    pub note: Option<String>,
    /// The header already names the rows (a recovery or `ambiguous:` line);
    /// the tagged lines render only once the block is compacted.
    pub inline: bool,
}

impl Obs {
    pub(crate) fn render(&self) -> String {
        let mut out = String::new();
        match &self.compacted {
            None => {
                out.push_str(&self.header);
                for (_, line) in &self.lines {
                    if line.is_empty() || self.inline {
                        continue;
                    }
                    out.push('\n');
                    out.push_str(line);
                }
            }
            Some(kept) => {
                let kept_names: Vec<String> = kept.iter().map(|n| format!("#{n}")).collect();
                let note = if kept_names.is_empty() {
                    "compacted".to_owned()
                } else {
                    format!("compacted; {} kept", kept_names.join(", "))
                };
                match self.handle {
                    Some(handle) => {
                        out.push_str(&format!("@{handle} · {} ({note})", self.summary));
                    }
                    None => out.push_str(&format!("{} ({note})", self.summary)),
                }
                for (numbers, line) in &self.lines {
                    if !line.is_empty() && numbers.iter().any(|n| kept.contains(n)) {
                        out.push('\n');
                        out.push_str(line);
                    }
                }
            }
        }
        if let Some(note) = &self.note {
            out.push('\n');
            out.push_str(note);
        }
        out
    }

    /// The `#n` this observation still shows.
    pub(crate) fn visible(&self) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        let lead = if self.compacted.is_none() {
            &self.header
        } else {
            &self.summary
        };
        if self.handle.is_none()
            && let Some(first) = lead_number(lead)
        {
            out.push(first);
        }
        for (numbers, _) in &self.lines {
            let shown = self
                .compacted
                .as_ref()
                .is_none_or(|kept| numbers.iter().any(|n| kept.contains(n)));
            if shown {
                out.extend(numbers.iter().copied());
            }
        }
        out
    }
}

/// The longest result (`find`, `search`, `answer`) whose rows are in focus
/// (`Session::focus`). A short list is on screen as a whole ("what's on
/// tomorrow" then "push training to 7"); a longer one is a search result, not
/// a subject. Four is the largest that keeps the held-out sessions' score:
/// three loses a turn (a four-task "this week" list, then "tick the gas
/// bill").
/// How many fixes one call may take in a step (`Session::dispatch`).
const FIX_CAP: usize = 3;
const FOCUS_RESULT_MAX: usize = 4;

/// Rows a rejected or empty step restates (`Session::restate`).
const RESTATE_ROWS: usize = 5;

/// Characters of the first call's reply the first repeat hint quotes.
pub const REPEAT_ECHO: usize = 160;

/// The same for a reply that is an `error:`: its last sentence is the call to send instead
/// (SPEC §5), so the quote keeps the whole line.
pub const REPEAT_ECHO_ERROR: usize = 400;

/// The second consecutive repeat's observation. A third ends the turn.
pub const REPEAT_NUDGE: &str = "error: repeated call again. Do not send it a third time: change a parameter the reply above points to, use another tool, or answer or decline with what you have.";

/// The first repeat's observation: what the identical call returned before.
/// Trainers see the same string, it is the runtime's own observation.
#[must_use]
pub fn repeat_hint(returned: &str) -> String {
    format!(
        "error: repeated call. You already made this exact call and it returned: {returned} Answer from that result, or change the call."
    )
}

/// nt10 G1: the reply to the first identical resend after an `error:`: the fix the error
/// ended in, or the error's own text when it ended in none.
#[must_use]
pub fn same_call_hint(error: &str) -> String {
    let body = error.strip_prefix("error:").unwrap_or(error).trim();
    let fix = fix_sentence(body).unwrap_or(body);
    format!("error: that is the same call again. {fix}")
}

/// The last sentence of an error when it is a fix: it comes after the sentence that says
/// what is wrong, and it tells what to send or use (`For that use date.`, `Did you mean
/// #7 task "Review lease"?`, `Send reveal field: password.`).
fn fix_sentence(body: &str) -> Option<&str> {
    const LEADS: [&str; 22] = [
        "For that use",
        "Use ",
        "Send ",
        "Did you mean",
        "Give ",
        "Name ",
        "Narrow ",
        "Try ",
        "Pass ",
        "A group's money is",
        "A date changes",
        "Call ",
        "Say ",
        "Ask ",
        "Put ",
        "Add ",
        "Drop ",
        "Write ",
        "Filter ",
        "Restore ",
        "Order by",
        "Set ",
    ];
    let bytes = body.as_bytes();
    let mut starts = vec![0];
    for (i, window) in bytes.windows(3).enumerate() {
        if matches!(window[0], b'.' | b'?') && window[1] == b' ' && window[2].is_ascii_uppercase() {
            starts.push(i + 2);
        }
    }
    let last = *starts.last()?;
    if starts.len() < 2 {
        return None;
    }
    let sentence = &body[last..];
    LEADS
        .iter()
        .any(|lead| sentence.starts_with(lead))
        .then_some(sentence)
}

/// The first line of `text`, at most `max` characters (`…` when cut), ending
/// in a full stop so a sentence can follow it.
fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    let mut out: String = line.chars().take(max).collect();
    if line.chars().count() > max {
        out.push('…');
    }
    if !out.ends_with(['.', '…', '?', '!']) {
        out.push('.');
    }
    out
}

/// Whether the runtime refused a call as invalid: an `error:` that changed
/// nothing (a schema, a cardinality, an unknown row), which the same call
/// sent again cannot change. A write that landed in part is not one. Two
/// replies that are not `error:`s refuse just as surely: a link the metadata
/// does not have (`no_link`) and a write that matched no row.
fn is_invalid(tool: &str, outcome: &Outcome) -> bool {
    let recovery = outcome.effect.get("recovery").and_then(Value::as_str);
    (outcome.effect.contains_key("error") && !outcome.effect.contains_key("diff"))
        || recovery == Some("no_link")
        || (tool == "act" && recovery == Some("empty"))
}

/// The call the runtime last refused as invalid, as it ran (grounded), and
/// what it said (`error:` text, or the reply of a `no_link` or an empty act):
/// what the typed fail-soft of an identical re-send works from.
#[derive(Debug, Clone)]
pub(crate) struct Rejected {
    pub tool: String,
    pub args: Map<String, Value>,
    pub text: String,
}

/// The `#n` a line opens with (`open`'s row line).
fn lead_number(text: &str) -> Option<usize> {
    text.strip_prefix('#')
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|n| n.parse().ok())
}

/// A result handle's content.
#[derive(Debug, Clone)]
pub(crate) struct ResultSet {
    pub kinds: Vec<Kind>,
    pub keys: Vec<Key>,
    pub value: Option<Value>,
}

/// One inverse write, recorded for `undo`.
#[derive(Debug, Clone)]
pub(crate) struct Inverse {
    pub command: String,
    pub input: Value,
    pub key: Key,
}

/// A row a turn left in focus.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Mark {
    pub turn: usize,
    /// The row's `#n`.
    pub number: usize,
    /// A write acted on it (a change, an already-so answer, an undo), as opposed to an `ask`
    /// offering it as an option. The `focus:` line names a written row in its `acted` part for
    /// `ACTED_TURNS` turns (`crate::native::block::acted_part`).
    pub written: bool,
}

/// The whole session.
pub struct Session {
    pub(crate) door: Box<dyn Door>,
    pub(crate) world: World,
    pub(crate) now: DateTime,
    pub(crate) me_name: String,
    pub(crate) flags: Flags,
    pub(crate) numbers: BTreeMap<Key, usize>,
    pub(crate) by_number: Vec<Key>,
    pub(crate) results: Vec<ResultSet>,
    /// What a value's result handle says about it (`crate::native::block::SetNote`),
    /// by handle: the focus line's `@2: 10 documents (counted) in #39 …`.
    pub(crate) result_notes: BTreeMap<usize, crate::native::block::SetNote>,
    /// What each result handle's selector called its rows (`Selector::what`), for the ask a write
    /// over the handle ends in (nt11 R5).
    pub(crate) result_whats: BTreeMap<usize, String>,
    pub(crate) observations: Vec<Obs>,
    pub(crate) references: Vec<(usize, BTreeSet<usize>)>,
    pub(crate) directory: Vec<usize>,
    pub(crate) preground: BTreeSet<usize>,
    pub(crate) turn: usize,
    pub(crate) steps: usize,
    pub(crate) seq: usize,
    pub(crate) last_call: Option<String>,
    /// What the last dispatched call returned (first line), for the repeat hint.
    pub(crate) last_text: String,
    /// Consecutive repeats of `last_call` this turn (see `REPEAT_HINT`).
    pub(crate) repeats: usize,
    pub(crate) turn_over: bool,
    /// `(turn, inverses, not undoable)`.
    pub(crate) writes: Vec<(usize, Vec<Inverse>, Vec<String>)>,
    pub(crate) undone: BTreeSet<usize>,
    /// The turns that held an already-so write (`already: …`, nothing changed): `undo` looks
    /// past them to the last turn that wrote something (`Session::undo_entry`).
    pub(crate) noops: BTreeSet<usize>,
    /// `#n` of every row an `act` created or changed: addressable for the
    /// rest of the conversation, whatever compaction does.
    pub(crate) acted: BTreeSet<usize>,
    /// Every row a turn left in focus, in the order it did: acted on (a
    /// change, an already-so answer, an undo) or offered as an option of its
    /// `ask`. What the next turn's words are about (`Session::focus`), and,
    /// for the written ones, the `focus:` line's `acted` part.
    pub(crate) marks: Vec<Mark>,
    /// `(person, group id, currency)` of the settlements the running `act`
    /// planned, so its diff can carry the balance they moved.
    pub(crate) settling: Vec<(Key, String, String)>,
    /// The current user message, for grounding dates (`crate::native::ground`).
    pub(crate) message: String,
    /// The user message before it: a row the person named there and only
    /// points at now ("what's the card number then") is still named
    /// (`ambiguous_pick`).
    pub(crate) prev_message: String,
    /// Notes the runtime adds under the observation of the running call: a
    /// date it repaired, a row it resolved from context.
    pub(crate) pending_notes: Vec<String>,
    /// A line that ends the next reply, after every other note (nt12 R5: `only the first call ran`).
    closing_note: Option<String>,
    /// Reads of this turn that came back empty by name and left the turn open
    /// (`compose_find_miss`): the second miss of an `answer` is its answer.
    pub(crate) read_misses: usize,
    /// The slots of the running call's slot trace, when it carries one
    /// (`crate::native::trace`): the trace guard reads them, and so does the write that may take
    /// every row (`Session::said_every_row`). The cap on a write's rows does not read them.
    pub(crate) trace: Option<crate::native::trace::Trace>,
    /// `#n` of every row an `act` created this session, in order: the focus
    /// line's `created` (`crate::native::prompt::focus_line`).
    pub(crate) created: Vec<usize>,
    /// The turn the last `ask` ended and the `#n` of its options: the focus
    /// line's `asked`, for the one turn that answers it.
    pub(crate) last_ask: (usize, Vec<usize>),
    /// The step of the last `ambiguous:` reply and the `#n` it lists, in its
    /// order: an `ask` in the very next step completes its options from them
    /// (`Session::complete_options`).
    pub(crate) ambiguity: Option<(usize, Vec<usize>)>,
    /// `(turn, @n)` of every `find` whose selector carried a `where`, a `when` or a `linked_to`
    /// of its own: the model has stated what singles the rows out, so a row of that result it
    /// then picks by `#n` is not a guess (`Session::ambiguous_pick`).
    pub(crate) narrowed: Vec<(usize, usize)>,
    /// `results.len()` when each user message arrived: the results of turn `n` start at
    /// `turn_starts[n - 1]` (nt10 G2, a narrowing that lost its `within`).
    pub(crate) turn_starts: Vec<usize>,
    /// The step that sent `last_call` and whether the runtime refused it as
    /// invalid (an `error:` that changed nothing): a repeat of such a call
    /// ends the turn (`repeat_outcome`).
    pub(crate) last_step: usize,
    pub(crate) last_invalid: bool,
    /// The refused call itself, for `last_invalid` (`Session::invalid_failsoft`).
    pub(crate) last_rejected: Option<Rejected>,
    /// What the compile step repaired in the call it last returned: reported by the step
    /// that runs that call (`normalize.rs`).
    pub(crate) compiled: Option<crate::native::normalize::Carry>,
    /// The write over `ROW_CAP` rows the last turn ended asking about: the
    /// same write, sent after the person's yes, goes through
    /// (`Session::confirmed`).
    pub(crate) pending_bulk: Option<crate::native::act::PendingBulk>,
    /// The cancelled event the last turn ended offering to plan anew (`plan a new one instead?`):
    /// the turn it was offered in and the row. A reschedule of that row in the turn after is the
    /// person's yes (`Session::plan_anew`, nt13 R6).
    pub(crate) plan_offer: Option<(usize, Key)>,
    /// `(turn, item, field as asked)` of every reveal this session refused for a field the item
    /// does not keep or the runtime does not know: a later reveal of ANOTHER secret of that item
    /// in the same turn is not made silently (`Session::reveal_guard`, nt15 R1s).
    pub(crate) reveal_refused: Vec<(usize, Key, String)>,
}

impl Selector {
    /// What an ask over the rows of the selector calls them: its name, quoted, or `the selector`.
    pub(crate) fn what(&self) -> String {
        self.name
            .as_ref()
            .map_or_else(|| "the selector".to_owned(), |name| format!("\"{name}\""))
    }
}

/// The rows a selector reaches and how its name reached them.
#[derive(Debug, Clone, Default)]
pub(crate) struct Named {
    /// The rows the selector reaches.
    pub(crate) keys: Vec<Key>,
    /// The tier its `name` reached them at; none without a name or a match.
    pub(crate) tier: Option<Tier>,
    /// `matched "Farrukh Kasimov" for "Farukh"`, when the tier is a typo's.
    pub(crate) typo_line: Option<String>,
}

/// A parsed selector.
#[derive(Debug, Clone, Default)]
pub(crate) struct Selector {
    pub kinds: Vec<Kind>,
    pub name: Option<String>,
    pub conds: Vec<Cond>,
    /// The text of each `where` clause, one per `conds` entry (nt10 G3 names a clause by it).
    pub cond_text: Vec<String>,
    pub when: Option<Resolved>,
    pub linked_to: Vec<Key>,
    pub within: Option<usize>,
    pub exclude: BTreeSet<Key>,
    pub order: Option<(String, bool)>,
    pub limit: Option<usize>,
    pub trashed: bool,
}

/// Lowercase alphanumeric words, accents folded (`crate::native::search::fold`).
#[must_use]
pub fn words(text: &str) -> Vec<String> {
    crate::native::search::fold_words(text)
}

pub(crate) fn arg_str(args: &Map<String, Value>, key: &str) -> Option<String> {
    match args.get(key)? {
        Value::String(text) => Some(text.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

pub(crate) fn arg_bool(args: &Map<String, Value>, key: &str) -> Result<Option<bool>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(Value::String(text)) => whr::parse_bool(text)
            .map(Some)
            .ok_or_else(|| whr::bool_error(key, text)),
        Some(Value::Number(number)) => match number.as_i64() {
            Some(1) => Ok(Some(true)),
            Some(0) => Ok(Some(false)),
            _ => Err(whr::bool_error(key, &number.to_string())),
        },
        Some(other) => Err(whr::bool_error(key, &other.to_string())),
    }
}

fn arg_int(args: &Map<String, Value>, key: &str) -> Result<Option<i64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("error: {key} is a whole number.")),
        Some(Value::String(text)) => text
            .trim()
            .parse()
            .map(Some)
            .map_err(|_| format!("error: {key} is a whole number, not \"{text}\".")),
        Some(other) => Err(format!("error: {key} is a whole number, not {other}.")),
    }
}

/// Split a handle list: `"#3, @2"` or `["#3","@2"]`.
pub(crate) fn handle_list(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().flat_map(handle_list).collect(),
        Value::String(text) => text
            .split([',', ' '])
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect(),
        Value::Number(number) => vec![format!("#{number}")],
        _ => Vec::new(),
    }
}

/// `#12`: a row handle.
pub(crate) fn is_row_handle(part: &str) -> bool {
    part.strip_prefix('#')
        .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
}

pub(crate) fn tool_params(tool: &str) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = match tool {
        "search" => vec!["text", "kind"],
        "find" => Vec::new(),
        "open" => vec!["row"],
        "compute" => vec!["op", "field", "group", "rows"],
        "act" => vec!["verb", "rows", "args", "more"],
        "answer" => vec!["rows", "op", "field", "value"],
        "ask" => vec!["question", "options"],
        "decline" => vec!["reason"],
        _ => return Vec::new(),
    };
    if matches!(tool, "find" | "compute" | "act" | "answer") {
        out.extend(meta::SELECTOR_PARAMS);
    }
    out
}

impl Session {
    /// Open a session over a vault, reached only through `door` (the runtime holds no path and
    /// no connection). `now` is the person's today. The harness opens a vault FILE through
    /// `centraid_nativetools::vaultio::open_session`; the phone passes the core's door.
    pub fn with_door(
        door: Box<dyn Door>,
        now: DateTime,
        me: &str,
        flags: Flags,
    ) -> Result<Self, String> {
        let world = World::load(&*door)?;
        let me_name = if me.is_empty() {
            world
                .row(&world.me_key())
                .map(|row| row.name.clone())
                .unwrap_or_default()
        } else {
            me.to_owned()
        };
        let mut session = Self {
            door,
            world,
            now,
            me_name,
            flags,
            numbers: BTreeMap::new(),
            by_number: Vec::new(),
            results: Vec::new(),
            result_notes: BTreeMap::new(),
            result_whats: BTreeMap::new(),
            observations: Vec::new(),
            references: Vec::new(),
            directory: Vec::new(),
            preground: BTreeSet::new(),
            turn: 0,
            steps: 0,
            seq: 0,
            last_call: None,
            last_text: String::new(),
            repeats: 0,
            turn_over: true,
            writes: Vec::new(),
            undone: BTreeSet::new(),
            noops: BTreeSet::new(),
            acted: BTreeSet::new(),
            marks: Vec::new(),
            settling: Vec::new(),
            message: String::new(),
            prev_message: String::new(),
            pending_notes: Vec::new(),
            closing_note: None,
            read_misses: 0,
            trace: None,
            created: Vec::new(),
            last_ask: (0, Vec::new()),
            narrowed: Vec::new(),
            turn_starts: Vec::new(),
            ambiguity: None,
            last_step: 0,
            last_invalid: false,
            last_rejected: None,
            compiled: None,
            pending_bulk: None,
            plan_offer: None,
            reveal_refused: Vec::new(),
        };
        if flags.directory {
            session.number_directory();
        }
        Ok(session)
    }

    #[must_use]
    pub fn today(&self) -> jiff::civil::Date {
        self.now.date()
    }

    /// The `#n` of a row, minting one on first sight.
    pub(crate) fn number(&mut self, key: &Key) -> usize {
        if let Some(number) = self.numbers.get(key) {
            return *number;
        }
        self.by_number.push(key.clone());
        let number = self.by_number.len();
        self.numbers.insert(key.clone(), number);
        number
    }

    /// Containers, most recently used first, capped (SPEC §6.0.4).
    pub(crate) fn directory_rows(&self) -> Vec<(Kind, Vec<Key>, usize)> {
        let mut out = Vec::new();
        for kind in Kind::ALL {
            if !kind.spec().container {
                continue;
            }
            let mut rows: Vec<&Row> = self
                .world
                .of_kind(kind)
                .filter(|row| !row.trashed)
                .collect();
            // MOST RECENT FIRST, by creation: several vault commands stamp a
            // container's `updated_at` from the host's wall clock rather than
            // the injected one, so `updated_at` would make the prompt
            // nondeterministic.
            rows.sort_by(|a, b| {
                b.created
                    .cmp(&a.created)
                    .then_with(|| a.name.cmp(&b.name))
                    .then_with(|| a.id.cmp(&b.id))
            });
            let total = rows.len();
            let shown: Vec<Key> = rows
                .iter()
                .take(meta::DIRECTORY_CAP)
                .map(|row| row.key())
                .collect();
            out.push((kind, shown, total));
        }
        out
    }

    fn number_directory(&mut self) {
        for (_, keys, _) in self.directory_rows() {
            for key in keys {
                let number = self.number(&key);
                self.directory.push(number);
            }
        }
    }

    /// Resolve `#n` to a row. Numbers are session-stable, so a row shown in an
    /// earlier, since-compacted result still names exactly one row: it is
    /// accepted. Val runs showed the rejection only ever ended in a loop (4
    /// of 4 turns that hit it failed); the generator still never emits a
    /// compacted `#n` (SPEC §3), so gold is unchanged.
    pub(crate) fn resolve_row(&self, handle: &str) -> Result<Key, String> {
        let number: usize = handle
            .trim()
            .strip_prefix('#')
            .and_then(|n| n.parse().ok())
            .ok_or_else(|| format!("error: \"{handle}\" is not a row; rows are #n."))?;
        let key = self
            .by_number
            .get(number.wrapping_sub(1))
            .ok_or_else(|| format!("error: #{number} was never shown."))?;
        if !self.world.rows.contains_key(key) {
            return Err(format!("error: #{number} no longer exists in the vault."));
        }
        Ok(key.clone())
    }

    /// Resolve `@n`.
    pub(crate) fn resolve_result(&self, handle: &str) -> Result<usize, String> {
        let number: usize = handle
            .trim()
            .strip_prefix('@')
            .and_then(|n| n.parse().ok())
            .ok_or_else(|| {
                // nt15 R1b: a list of rows (`#43, #44`) is `rows`, not a result
                let rows = handle_list(&Value::String(handle.to_owned()));
                let repair = if !rows.is_empty() && rows.iter().all(|part| is_row_handle(part)) {
                    format!(" These are rows: use rows: {}.", rows.join(", "))
                } else {
                    String::new()
                };
                format!("error: \"{handle}\" is not a result; results are @n.{repair}")
            })?;
        if number == 0 || number > self.results.len() {
            return Err(format!(
                "error: @{number} was never issued; issued results: {}.",
                self.issued()
            ));
        }
        Ok(number)
    }

    fn issued(&self) -> String {
        if self.results.is_empty() {
            "none yet".to_owned()
        } else {
            (1..=self.results.len())
                .map(|n| format!("@{n}"))
                .collect::<Vec<_>>()
                .join(", ")
        }
    }

    /// A mixed `#n` / `@n` list → rows, in order, deduplicated.
    pub(crate) fn resolve_rows(&self, value: &Value) -> Result<Vec<Key>, String> {
        let mut out: Vec<Key> = Vec::new();
        let parts = handle_list(value);
        if parts.is_empty() {
            return Err(
                "error: rows is a list of #n and @n, like \"#3, #4\" or \"@2\".".to_owned(),
            );
        }
        for part in parts {
            let keys = if part.starts_with('@') {
                self.results[self.resolve_result(&part)? - 1].keys.clone()
            } else {
                vec![self.resolve_row(&part)?]
            };
            for key in keys {
                if !out.contains(&key) {
                    out.push(key);
                }
            }
        }
        Ok(out)
    }

    /// A rows list that names a VALUE (`@n` of a count, a sum, a balance) is an error, never
    /// the rows the value was computed over and never another result's rows: a value keeps
    /// its rows for `within` and `exclude` (SPEC §3.3), and `rows` takes rows. Read at every
    /// place a call hands over rows to work on (`rows`, an ask's `options`).
    pub(crate) fn reject_values(&self, value: &Value) -> Result<(), String> {
        for part in handle_list(value) {
            if part.starts_with('@') {
                let number = self.resolve_result(&part)?;
                if self.results[number - 1].value.is_some() {
                    return Err(format!("error: @{number} is a value, not rows."));
                }
            }
        }
        Ok(())
    }

    /// `rows`, with at most a `kind` beside it. The kind is a check on the
    /// rows, not a filter: a row of another kind is an error, never dropped.
    pub(crate) fn rows_arg(
        &self,
        args: &Map<String, Value>,
        both: &str,
    ) -> Result<Option<Vec<Key>>, String> {
        let Some(rows) = args.get("rows").filter(|value| !value.is_null()) else {
            return Ok(None);
        };
        let others = meta::SELECTOR_PARAMS.iter().any(|param| {
            *param != "kind" && args.get(*param).is_some_and(|value| !value.is_null())
        });
        if others {
            return Err(both.to_owned());
        }
        self.reject_values(rows)?;
        let keys = self.resolve_rows(rows)?;
        if let Some(text) = arg_str(args, "kind") {
            let kinds = self.parse_kinds(&text, false)?;
            for key in &keys {
                if !kinds.contains(&key.0) {
                    let number = self.numbers.get(key).copied().unwrap_or_default();
                    let name = key.0.name();
                    let article = if name.starts_with(['a', 'e', 'i', 'o', 'u']) {
                        "an"
                    } else {
                        "a"
                    };
                    return Err(format!(
                        "error: #{number} is {article} {name}, and kind says {}.",
                        kinds
                            .iter()
                            .map(|kind| kind.name())
                            .collect::<Vec<_>>()
                            .join(" or ")
                    ));
                }
            }
        }
        Ok(Some(keys))
    }

    pub(crate) fn parse_kinds(&self, text: &str, any: bool) -> Result<Vec<Kind>, String> {
        let mut kinds = Vec::new();
        for part in text
            .split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
        {
            if part.eq_ignore_ascii_case("any") {
                if any {
                    return Ok(Kind::ALL.to_vec());
                }
                return Err(
                    "error: kind=any is only for search; name one kind or a comma list.".to_owned(),
                );
            }
            let kind = Kind::parse(part).ok_or_else(|| {
                format!("error: no kind \"{part}\". kinds: {}.", whr::kind_names())
            })?;
            if !kinds.contains(&kind) {
                kinds.push(kind);
            }
        }
        if kinds.is_empty() {
            return Err(format!(
                "error: kind is empty. kinds: {}.",
                whr::kind_names()
            ));
        }
        Ok(kinds)
    }

    /// Read the selector parameters of a call.
    pub(crate) fn selector(&self, args: &Map<String, Value>) -> Result<Selector, String> {
        let mut selector = Selector::default();
        if let Some(within) = arg_str(args, "within") {
            selector.within = Some(self.resolve_result(&within)?);
        }
        selector.kinds = match arg_str(args, "kind") {
            Some(text) => self.parse_kinds(&text, false)?,
            None => match selector.within {
                Some(handle) => self.results[handle - 1].kinds.clone(),
                // A TRASH READ THAT NAMES NO KIND reads every kind that has a trash.
                None if arg_bool(args, "trashed")?.unwrap_or(false) => Kind::ALL
                    .iter()
                    .copied()
                    .filter(|kind| kind.spec().trash)
                    .collect(),
                None => {
                    return Err(format!(
                        "error: a selector needs kind (or within=@n). kinds: {}.",
                        whr::kind_names()
                    ));
                }
            },
        };
        if selector.kinds.is_empty() {
            return Err("error: that result holds no rows to select from.".to_owned());
        }
        let multi = selector.kinds.len() > 1;
        for key in args.keys() {
            if multi
                && meta::SELECTOR_PARAMS.contains(&key.as_str())
                && !meta::MULTI_KIND_PARAMS.contains(&key.as_str())
            {
                return Err(format!(
                    "error: {key} needs exactly one kind (fields are per kind). A multi-kind selector takes {}.",
                    meta::MULTI_KIND_PARAMS.join(", ")
                ));
            }
        }
        selector.name = arg_str(args, "name")
            .map(|name| name.trim().trim_matches('"').to_owned())
            .filter(|name| !name.is_empty());
        if let Some(text) = arg_str(args, "where") {
            selector.conds = whr::parse(selector.kinds[0], &text)?;
            whr::settle_currencies(&mut selector.conds, &self.vault_currencies())?;
            let clauses = whr::split_and(text.trim());
            if clauses.len() == selector.conds.len() {
                selector.cond_text = clauses;
            }
        }
        if let Some(value) = args.get("when").filter(|value| !value.is_null()) {
            // (a `when` written leniently is read in `normalize`, which says so)
            let expr = dates::parse(value).map_err(|why| dates::rejection(&why))?;
            if dates::uses_row(&expr) {
                return Err(dates::rejection(
                    "anchor row is legal only inside act; a filter reads from today",
                ));
            }
            let resolved =
                dates::evaluate(&expr, self.now, None).map_err(|why| dates::rejection(&why))?;
            if let Some(kind) = selector
                .kinds
                .iter()
                .find(|kind| kind.spec().date.is_none())
            {
                return Err(format!(
                    "error: {} have no date, so when cannot filter them. Dated kinds: {}.",
                    kind.plural(),
                    Kind::ALL
                        .iter()
                        .filter(|kind| kind.spec().date.is_some())
                        .map(|kind| kind.name())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            selector.when = Some(resolved);
        }
        if let Some(value) = args.get("linked_to").filter(|value| !value.is_null()) {
            selector.linked_to = self.resolve_rows(value)?;
        }
        if let Some(value) = args.get("exclude").filter(|value| !value.is_null()) {
            selector.exclude = self.resolve_rows(value)?.into_iter().collect();
        }
        if let Some(text) = arg_str(args, "order") {
            let mut parts = text.split_whitespace();
            let field = parts.next().unwrap_or_default().to_lowercase();
            let direction = parts.next().unwrap_or("asc").to_lowercase();
            if direction != "asc" && direction != "desc" {
                return Err(format!(
                    "error: order is \"field asc\" or \"field desc\", not \"{text}\"."
                ));
            }
            let kind = selector.kinds[0];
            let valid = field == "name"
                || (field == "date" && kind.spec().date.is_some())
                || kind.spec().field(&field).is_some();
            if !valid {
                return Err(format!(
                    "error: cannot order {} by \"{field}\". order fields: name, {}.{}",
                    kind.plural(),
                    whr::field_list(kind),
                    whr::field_fix(kind, &field, whr::FieldUse::Where)
                ));
            }
            selector.order = Some((field, direction == "desc"));
        }
        if let Some(limit) = arg_int(args, "limit")? {
            if limit < 1 {
                return Err("error: limit is a positive whole number.".to_owned());
            }
            selector.limit = Some(usize::try_from(limit).unwrap_or(usize::MAX));
        }
        selector.trashed = arg_bool(args, "trashed")?.unwrap_or(false);
        Ok(selector)
    }

    /// A date expression as the model wrote it, read with the lexical leniency of
    /// `dates::lenient` (a note per form read) and then strictly (`dates::parse`; a refusal quotes
    /// the example of the key that failed).
    pub(crate) fn date_expr(&mut self, value: &Value) -> Result<dates::Expr, String> {
        let (fixed, notes) = if self.flags.normalize {
            dates::lenient(value)
        } else {
            (value.clone(), Vec::new())
        };
        let expr = dates::parse(&fixed).map_err(|why| dates::rejection(&why))?;
        self.pending_notes.extend(notes);
        Ok(expr)
    }

    /// The currencies the vault holds: its base currency, its groups' and its debts' (what a
    /// currency symbol in an amount is settled against, `whr::settle_currencies`).
    pub(crate) fn vault_currencies(&self) -> Vec<String> {
        let mut codes = vec![self.world.currency.clone()];
        for row in self.world.rows.values() {
            if let Some(code) = row.extra.get("currency") {
                codes.push(code.clone());
            }
            if let Some(crate::native::world::Val::Money(_, code)) = row.field("amount") {
                codes.push(code.clone());
            }
        }
        codes.sort();
        codes.dedup();
        codes
    }

    /// Whether any selector parameter was given.
    pub(crate) fn has_selector(args: &Map<String, Value>) -> bool {
        meta::SELECTOR_PARAMS
            .iter()
            .any(|param| args.get(*param).is_some_and(|value| !value.is_null()))
    }

    /// THE ROWS A READ TAKES (nt11 R2): the rows of the best tier its `name` reaches, with
    /// `matched "Farrukh Kasimov" for "Farukh"` under the reply when that tier is a typo's, and
    /// the contains reading of a free-text `=` (`read_as_contains`) when nothing was reached.
    pub(crate) fn select_read(&mut self, selector: &mut Selector) -> Vec<Key> {
        let mut named = self.select_named(selector);
        // THE TRASH DATE IS NOT KEPT (nt11 R6): a row's `date` is the day it was for, not the day
        // it was deleted, so a `when` on a read of trashed rows ("what did I delete last week")
        // answered nothing for the wrong reason. A `when` that reaches no trashed row is dropped,
        // and the note says so. One that reaches rows stays: it is the row's own date, as in "the
        // pay rent from october" (a false positive of dropping it outright, T31-023).
        if selector.trashed
            && let Some(when) = selector.when
            && named.keys.is_empty()
        {
            selector.when = None;
            let widened = self.select_named(selector);
            if widened.keys.is_empty() {
                selector.when = Some(when);
            } else {
                self.pending_notes.push(format!(
                    "the trash date is not kept; showing all trashed {}",
                    render::plural_list(&selector.kinds)
                ));
                named = widened;
            }
        }
        let mut keys = named.keys;
        if let Some(line) = named.typo_line
            && !keys.is_empty()
        {
            self.pending_notes.push(line);
        }
        self.read_as_contains(selector, &mut keys);
        if keys.is_empty()
            && let Some((widened, found, notes)) = self.text_by_tiers(selector)
        {
            self.pending_notes.extend(notes);
            *selector = widened;
            keys = found;
        }
        if keys.is_empty()
            && let Some((widened, found, note)) = self.part_of_day_reading(selector)
        {
            self.pending_notes.push(note);
            *selector = widened;
            keys = found;
        }
        keys
    }

    /// AN EXACT TIME ON ROWS DATED BY A RECORD'S TIMESTAMP, READ AS THE PART OF THE DAY AROUND IT
    /// (nt14 N9; a read that reached nothing, off with `--no-normalize`): `19:00` on notes is the
    /// evening, 17:00 to 23:59 (morning 05:00 to 11:59, afternoon 12:00 to 16:59), since a person
    /// says "last night" and the model writes the hour. Rows with a time of their own (events,
    /// tasks) are exact, and the small hours are no part of the day here. The widened selector,
    /// the rows it reaches (not empty) and `note: read 19:00 as the evening`.
    fn part_of_day_reading(&self, selector: &Selector) -> Option<(Selector, Vec<Key>, String)> {
        if !self.flags.normalize
            || selector
                .kinds
                .iter()
                .any(|kind| matches!(kind, Kind::Event | Kind::Task))
        {
            return None;
        }
        let when = selector.when?;
        let Resolved::At(at) = when else {
            return None;
        };
        let (part, span) = when.part_of_day()?;
        let widened = Selector {
            when: Some(span),
            ..selector.clone()
        };
        let rows = self.select(&widened);
        let note = format!(
            "note: read {} as the {part}",
            crate::native::dates::clock(at.time())
        );
        (!rows.is_empty()).then_some((widened, rows, note))
    }

    /// A NAME AND A DAY THAT FIT NO ROW, WHILE THE NAME FITS ROWS OF THE KIND (nt14 N1: "is the
    /// dentist still on the 6th?"): the answer is the rows the name reaches, with the day they
    /// are on, `note: none Tue 2026-10-06; Dentist is on Fri 2026-10-02`. `find` and `answer`
    /// only (a count of what is on a day is its own question); never without a name; off with
    /// `--no-normalize`. Narrowed (N1b, nt15) to a `when` of ONE day (a range or an open window
    /// that reaches nothing stays empty) and to the rows dated today or later (an undated row
    /// stays; a past row is never offered).
    pub(crate) fn name_without_when(
        &mut self,
        selector: &mut Selector,
        keys: Vec<Key>,
    ) -> Vec<Key> {
        if !keys.is_empty() || !self.flags.normalize {
            return keys;
        }
        let (Some(when), Some(_)) = (selector.when, selector.name.as_ref()) else {
            return keys;
        };
        // N1b: ONE DAY only ("still on the 6th?"). A range ("any vet visits next week") and an
        // open window ("the next swim lesson") that reach no row are an empty read, never the
        // rows of the name from some other week
        let (from, to) = when.ends();
        if when.is_open() || from.date() != to.date() {
            return keys;
        }
        let widened = Selector {
            when: None,
            ..selector.clone()
        };
        // ... and the rows ahead only: a row dated today or later (an undated row may stay),
        // never one that is past
        let today = self.today();
        let rows: Vec<Key> = self
            .select(&widened)
            .into_iter()
            .filter(|key| {
                self.world
                    .row(key)
                    .is_some_and(|row| row.date.is_none_or(|date| date.date >= today))
            })
            .collect();
        if rows.is_empty() {
            return keys;
        }
        let mut on: Vec<String> = rows
            .iter()
            .filter_map(|key| self.world.row(key))
            .take(ROW_CAP)
            .map(|row| match row.date {
                Some(date) => format!("{} is on {}", row.name, date.show()),
                None => format!("{} has no date", row.name),
            })
            .collect();
        if rows.len() > ROW_CAP {
            on.push(format!("and {} more", rows.len() - ROW_CAP));
        }
        self.pending_notes
            .push(format!("note: none {}; {}", when.echo(), on.join(", ")));
        *selector = widened;
        rows
    }

    /// A TEXT LITERAL THAT REACHED NO ROW, READ BY THE RESOLVER'S TIERS (nt13 R2): `F = "lit"` or
    /// `F contains "lit"` on a text field is re-run with the values the field has that the
    /// literal reads (`text_reading`: the same ignoring case, hyphen and space; one word a typo;
    /// every word of the value inside the literal), the best reading of each condition alone and
    /// the other conditions unchanged. The widened selector, the rows it reaches (not empty) and
    /// `note: read role "mother in law" as "Mother-in-law"` for each condition read; `None` when
    /// nothing is read, nothing is reached or the session does not normalise.
    pub(crate) fn text_by_tiers(
        &self,
        selector: &Selector,
    ) -> Option<(Selector, Vec<Key>, Vec<String>)> {
        if !self.flags.normalize {
            return None;
        }
        let mut notes: Vec<String> = Vec::new();
        let conds: Vec<whr::Cond> = selector
            .conds
            .iter()
            .map(|cond| {
                let (field, literal) = match cond {
                    whr::Cond::Text {
                        field,
                        op: whr::Op::Eq,
                        value,
                    } => (*field, value),
                    whr::Cond::Contains { field, text } => (*field, text),
                    other => return other.clone(),
                };
                let mut best: Option<u8> = None;
                let mut values: Vec<String> = Vec::new();
                for row in self.world.rows.values() {
                    if !selector.kinds.contains(&row.kind) || row.trashed != selector.trashed {
                        continue;
                    }
                    let Some(Val::Text(value)) = row.field(field) else {
                        continue;
                    };
                    let Some(rank) = crate::native::resolve::text_reading(literal, value) else {
                        continue;
                    };
                    if best.is_none_or(|have| rank < have) {
                        best = Some(rank);
                        values.clear();
                    }
                    if best == Some(rank) && !values.contains(value) {
                        values.push(value.clone());
                    }
                }
                if values.is_empty() {
                    return cond.clone();
                }
                values.sort();
                let shown: Vec<String> =
                    values.iter().map(|value| format!("\"{value}\"")).collect();
                notes.push(format!(
                    "note: read {field} \"{literal}\" as {}",
                    shown.join(" or ")
                ));
                whr::Cond::In { field, values }
            })
            .collect();
        if notes.is_empty() {
            return None;
        }
        let widened = Selector {
            conds,
            ..selector.clone()
        };
        let rows = self.select(&widened);
        (!rows.is_empty()).then_some((widened, rows, notes))
    }

    /// `=` WITH A PLAIN WORD ON A FREE-TEXT FIELD (`description = tent`, `role = design`) READS AS
    /// CONTAINS when equality reaches no row and contains reaches some (SPEC §3.3): the person
    /// says a word of the text, never its whole. The selector and the rows are the contains
    /// reading's, with the note `note: read as contains: description contains "tent"`.
    pub(crate) fn read_as_contains(&mut self, selector: &mut Selector, keys: &mut Vec<Key>) {
        const FREE_TEXT: [&str; 4] = ["description", "body", "met", "role"];
        if !keys.is_empty() {
            return;
        }
        let plain = |value: &str| {
            !value.is_empty()
                && value
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '\'')
        };
        let mut said: Vec<String> = Vec::new();
        let conds: Vec<whr::Cond> = selector
            .conds
            .iter()
            .map(|cond| match cond {
                whr::Cond::Text {
                    field,
                    op: whr::Op::Eq,
                    value,
                } if FREE_TEXT.contains(field) && plain(value) => {
                    said.push(format!("{field} contains \"{value}\""));
                    whr::Cond::Contains {
                        field,
                        text: value.clone(),
                    }
                }
                other => other.clone(),
            })
            .collect();
        if said.is_empty() {
            return;
        }
        let widened = Selector {
            conds,
            ..selector.clone()
        };
        let rows = self.select(&widened);
        if rows.is_empty() {
            return;
        }
        self.pending_notes
            .push(format!("note: read as contains: {}", said.join(" and ")));
        *selector = widened;
        *keys = rows;
    }

    /// Evaluate a selector: exactly the rows the constraint selects.
    pub(crate) fn select(&self, selector: &Selector) -> Vec<Key> {
        self.select_named(selector).keys
    }

    /// `select`, and how the selector's `name` reached its rows (`resolve`, nt11 R2): among the
    /// rows every other condition lets through, the rows the name reaches at tiers 1 to 3, or,
    /// when it reaches none, at tier 4. A read takes them as they are, and one that is a typo's
    /// (`Tier::Typo`) says so. A write takes the same rows (nt12 R6): it acts when exactly one row
    /// is reached, and asks `Which one?` over all of them otherwise.
    pub(crate) fn select_named(&self, selector: &Selector) -> Named {
        self.select_tiered(selector)
    }

    fn select_tiered(&self, selector: &Selector) -> Named {
        let candidates: Vec<Key> = match selector.within {
            Some(handle) => self.results[handle - 1].keys.clone(),
            None => {
                let mut rows: Vec<&Row> = self
                    .world
                    .rows
                    .values()
                    .filter(|row| selector.kinds.contains(&row.kind))
                    .collect();
                rows.sort_by(|a, b| default_order(a, b, &selector.kinds));
                rows.iter().map(|row| row.key()).collect()
            }
        };
        let mut out: Vec<Key> = candidates
            .into_iter()
            .filter(|key| {
                let Some(row) = self.world.row(key) else {
                    return false;
                };
                selector.kinds.contains(&row.kind)
                    // THE ROWS OF A RESULT STAY WHAT THEY WERE: `within=@n` over trashed rows keeps
                    // them (the narrowing fragment states no `trashed` of its own); only an
                    // explicit `trashed` still asks for the trashed ones among them.
                    && (if selector.within.is_some() && !selector.trashed {
                        true
                    } else {
                        row.trashed == selector.trashed
                    })
                    && !selector.exclude.contains(key)
                    && whr::matches(&self.world, row, &selector.conds)
                    && selector
                        .when
                        .is_none_or(|when| row.date.is_some_and(|stamp| when.contains(stamp)))
                    && selector
                        .linked_to
                        .iter()
                        .all(|target| self.world.linked(key, target))
            })
            .collect();
        let mut named = Resolution::<Key> {
            tier: None,
            matches: Vec::new(),
            reached_all: Vec::new(),
            named: Vec::new(),
        };
        if let Some(name) = &selector.name {
            named = crate::native::resolve::resolve_rows(
                name,
                out.iter().filter_map(|key| self.world.row(key)),
                self.flags.normalize,
            );
            // A NAME A TRASHED ROW HAS BETTER THAN ANY LIVE ROW (as it is said or in other
            // words, while the live rows only contain it or are a typo of it) is that row's: the
            // recovery names it (`Session::empty`) and nothing live is taken in its place.
            if !selector.trashed
                && named.tier.is_some_and(|tier| tier >= Tier::Contains)
                && self
                    .resolve_name(name, &selector.kinds, true, None)
                    .tier
                    .is_some_and(|tier| tier <= Tier::Words)
            {
                named = Resolution {
                    tier: None,
                    matches: Vec::new(),
                    reached_all: Vec::new(),
                    named: Vec::new(),
                };
            }
            let keep: BTreeSet<&Key> = named.reached_all.iter().collect();
            out.retain(|key| keep.contains(key));
        }
        if let Some((field, desc)) = &selector.order {
            out.sort_by(|a, b| {
                let (Some(a), Some(b)) = (self.world.row(a), self.world.row(b)) else {
                    return std::cmp::Ordering::Equal;
                };
                let ordering = order_value(a, field).cmp(&order_value(b, field));
                // Rows without the field sort last either way.
                let missing = order_value(a, field)
                    .is_none()
                    .cmp(&order_value(b, field).is_none());
                missing
                    .then(if *desc { ordering.reverse() } else { ordering })
                    .then_with(|| a.name.cmp(&b.name))
            });
        }
        if let Some(limit) = selector.limit {
            out.truncate(limit);
        }
        Named {
            keys: out,
            tier: named.tier,
            typo_line: selector
                .name
                .as_ref()
                .and_then(|name| named.typo_line(name)),
        }
    }

    /// WHICH ROWS OF A `linked_to` ARE LINKS FOR THE KIND (nt15 R1c), when the call names several:
    /// ` #31 person is a valid link for photos; #26 photo and #33 event are not.` A sentence with
    /// a leading space, or nothing for a call that names one row.
    fn link_verdict(&mut self, selector: &Selector, kind: Kind) -> String {
        if selector.linked_to.len() < 2 {
            return String::new();
        }
        let (mut valid, mut invalid): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
        for key in selector.linked_to.clone() {
            let said = format!("#{} {}", self.number(&key), key.0.name());
            if kind.spec().link_to(key.0).is_some() {
                valid.push(said);
            } else {
                invalid.push(said);
            }
        }
        let list = |items: &[String]| match items {
            [only] => only.clone(),
            [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
            [] => String::new(),
        };
        let are = |items: &[String]| if items.len() == 1 { "is" } else { "are" };
        if valid.is_empty() {
            let (a, noun) = if invalid.len() == 1 {
                ("a ", "link")
            } else {
                ("", "links")
            };
            format!(
                " {} {} not {a}valid {noun} for {}.",
                list(&invalid),
                are(&invalid),
                kind.plural()
            )
        } else {
            let (a, noun) = if valid.len() == 1 {
                ("a ", "link")
            } else {
                ("", "links")
            };
            format!(
                " {} {} {a}valid {noun} for {}; {} {} not.",
                list(&valid),
                are(&valid),
                kind.plural(),
                list(&invalid),
                are(&invalid)
            )
        }
    }

    /// A link the metadata does not have: the dead-end observation with the
    /// rows whose name mentions the target (SPEC §5 "No link").
    pub(crate) fn no_link(&mut self, selector: &Selector) -> Option<Outcome> {
        for target in &selector.linked_to {
            for kind in &selector.kinds {
                if kind.spec().link_to(target.0).is_some() {
                    continue;
                }
                let target_name = self.world.row(target).map(|row| row.name.clone())?;
                // THE SUGGESTIONS STAY INSIDE THE NARROWING: with within=@n
                // only that result's rows are offered, never the whole vault.
                let scope: Option<BTreeSet<Key>> = selector
                    .within
                    .map(|handle| self.results[handle - 1].keys.iter().cloned().collect());
                let mentions: Vec<Key> = self
                    .world
                    .of_kind(*kind)
                    .filter(|row| !row.trashed)
                    .filter(|row| {
                        scope
                            .as_ref()
                            .is_none_or(|scope| scope.contains(&row.key()))
                    })
                    .filter(|row| {
                        let have = words(&row.name);
                        words(&target_name).iter().any(|word| have.contains(word))
                    })
                    .map(Row::key)
                    .take(ROW_CAP)
                    .collect();
                // (a task's notes are its description only for the generic reading: a call that
                // names a note row has no use of the sentence, nt15 R1a)
                let fix = self.link_call(*kind, selector).unwrap_or_else(|| {
                    if matches!(*kind, Kind::Task | Kind::Event) && target.0 == Kind::Note {
                        String::new()
                    } else {
                        whr::link_fix(*kind, target.0)
                    }
                });
                let mut text = format!(
                    "{} are not linked to {}.{fix}{}",
                    kind.plural(),
                    target.0.plural(),
                    self.link_verdict(selector, *kind),
                );
                let mut lines = Vec::new();
                let capital = capitalise(kind.plural());
                if mentions.is_empty() {
                    text.push_str(&format!(
                        " No {} {}mentions \"{target_name}\". {} links: {}.",
                        kind.name(),
                        selector
                            .within
                            .map_or_else(String::new, |handle| format!("in @{handle} ")),
                        kind.name(),
                        whr::link_names(*kind)
                    ));
                } else {
                    let numbers: Vec<String> = mentions
                        .iter()
                        .map(|key| {
                            let number = self.number(key);
                            lines
                                .push((vec![number], render::short(number, &self.world.rows[key])));
                            format!("#{number}")
                        })
                        .collect();
                    text.push_str(&format!(
                        " {capital} {}whose name mentions \"{target_name}\": {}",
                        selector
                            .within
                            .map_or_else(String::new, |handle| format!("in @{handle} ")),
                        numbers.join(", ")
                    ));
                }
                let mut outcome = Outcome::text(text.clone());
                outcome
                    .effect
                    .insert("recovery".to_owned(), json!("no_link"));
                let summary = format!("{} are not linked to {}", kind.plural(), target.0.plural());
                self.push_obs_with(true, None, summary, text, lines, &mut outcome, true);
                return Some(outcome);
            }
        }
        None
    }

    /// Record an observation and render it into the outcome.
    pub(crate) fn push_obs(
        &mut self,
        result: bool,
        handle: Option<usize>,
        summary: String,
        header: String,
        lines: Vec<(Vec<usize>, String)>,
        outcome: &mut Outcome,
    ) {
        self.push_obs_with(result, handle, summary, header, lines, outcome, false);
    }

    /// The same, for a block whose header already names its rows.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn push_obs_with(
        &mut self,
        result: bool,
        handle: Option<usize>,
        summary: String,
        header: String,
        lines: Vec<(Vec<usize>, String)>,
        outcome: &mut Outcome,
        inline: bool,
    ) {
        let obs = Obs {
            turn: self.turn,
            seq: self.seq,
            result,
            handle,
            summary,
            header,
            lines,
            compacted: None,
            note: None,
            inline,
        };
        outcome.text = obs.render();
        self.observations.push(obs);
    }

    /// Issue a result handle over rows and render its block.
    pub(crate) fn issue(
        &mut self,
        kinds: &[Kind],
        keys: Vec<Key>,
        when: Option<Resolved>,
        lead: Option<String>,
        cap: usize,
        outcome: &mut Outcome,
    ) -> usize {
        self.results.push(ResultSet {
            kinds: kinds.to_vec(),
            keys: keys.clone(),
            value: None,
        });
        let handle = self.results.len();
        let rows: Vec<Row> = keys
            .iter()
            .filter_map(|key| self.world.row(key).cloned())
            .collect();
        let row_refs: Vec<&Row> = rows.iter().collect();
        let summary = render::count_phrase(kinds, &row_refs);
        let mut header = format!("@{handle} · {summary} (showing {})", rows.len().min(cap));
        if let Some(lead) = lead {
            header = format!("{lead}\n{header}");
        }
        if kinds.len() == 1 {
            header.push_str(&format!("   {}", render::card_hint(kinds[0])));
        }
        if let Some(when) = when {
            header.push_str(&format!(" · when: {}", when.echo()));
        }
        let mut lines = Vec::new();
        for (position, row) in rows.iter().take(cap).enumerate() {
            let number = self.number(&row.key());
            lines.push((
                vec![number],
                render::row_line(number, Some(position + 1), row, self.today()),
            ));
        }
        if rows.len() > cap {
            lines.push((
                Vec::new(),
                format!(
                    "… {} more in @{handle} (narrow with name, when, where, order or limit)",
                    rows.len() - cap
                ),
            ));
        }
        self.push_obs(true, Some(handle), summary, header, lines, outcome);
        handle
    }

    /// WHETHER AN EMPTY RESULT IS A DEAD END (SPEC §8.5): the `name` by
    /// itself — kind and name, no other condition — reaches no row (live, or
    /// trashed for a trashed read). A missing link is the other dead end and
    /// is `no_link`'s. Anything else that selects nothing — a name narrowed
    /// to zero by when/where/within/exclude, a linked row with no linked rows
    /// of the kind — is a valid empty answer.
    pub(crate) fn dead_end(&self, selector: &Selector) -> bool {
        selector.name.is_some()
            && self
                .select(&Selector {
                    kinds: selector.kinds.clone(),
                    name: selector.name.clone(),
                    trashed: selector.trashed,
                    ..Selector::default()
                })
                .is_empty()
    }

    /// `0 tasks match (when: …)`: an empty result that is not a dead end.
    pub(crate) fn none_text(&self, selector: &Selector) -> String {
        let mut text = format!("0 {}", render::plural_list(&selector.kinds));
        if let Some(name) = &selector.name {
            text.push_str(&format!(" called \"{name}\""));
        }
        text.push_str(" match");
        if let Some(when) = selector.when {
            text.push_str(&format!(" (when: {})", when.echo()));
        }
        text
    }

    /// The recovery observation for a selector that matched nothing.
    pub(crate) fn empty(&mut self, selector: &Selector, outcome: &mut Outcome) {
        let plural = render::plural_list(&selector.kinds);
        let mut lines = Vec::new();
        let text = if let Some(name) = &selector.name {
            let trashed: Vec<Key> = if selector.trashed {
                Vec::new()
            } else {
                self.resolve_name(name, &selector.kinds, true, None)
                    .reached()
                    .iter()
                    .take(ROW_CAP)
                    .cloned()
                    .collect()
            };
            if trashed.is_empty() {
                let other_kinds: Vec<Kind> = Kind::ALL
                    .iter()
                    .copied()
                    .filter(|kind| !selector.kinds.contains(kind))
                    .collect();
                let others: Vec<Key> = self
                    .resolve_name(name, &other_kinds, false, None)
                    .reached()
                    .iter()
                    .take(ROW_CAP)
                    .cloned()
                    .collect();
                let mut text = format!("0 {plural} called \"{name}\"");
                if selector.when.is_some()
                    || !selector.conds.is_empty()
                    || !selector.linked_to.is_empty()
                {
                    text.push_str(" with those constraints");
                }
                if others.is_empty() {
                    text.push_str(&format!(
                        ". Nothing else is called \"{name}\"; search finds near spellings."
                    ));
                } else {
                    let names: Vec<String> = others
                        .iter()
                        .map(|key| {
                            let number = self.number(key);
                            let short = render::short(number, &self.world.rows[key]);
                            lines
                                .push((vec![number], render::short(number, &self.world.rows[key])));
                            short
                        })
                        .collect();
                    text.push_str(&format!(
                        ". Other kinds called \"{name}\": {}",
                        names.join(", ")
                    ));
                }
                text
            } else {
                let kind_name = selector
                    .kinds
                    .iter()
                    .map(|kind| kind.name())
                    .collect::<Vec<_>>()
                    .join(" or ");
                let names: Vec<String> = trashed
                    .iter()
                    .map(|key| {
                        let number = self.number(key);
                        let short = render::short(number, &self.world.rows[key]);
                        lines.push((vec![number], short.clone()));
                        format!("{short} · trashed")
                    })
                    .collect();
                format!(
                    "no live {kind_name} called \"{name}\"; trashed: {}",
                    names.join(", ")
                )
            }
        } else {
            let live = self
                .world
                .rows
                .values()
                .filter(|row| selector.kinds.contains(&row.kind) && row.trashed == selector.trashed)
                .count();
            let mut text = format!("0 {plural} match");
            if let Some(when) = selector.when {
                text.push_str(&format!(" (when: {})", when.echo()));
            }
            text.push_str(&format!(
                ". There are {live} {} {plural} in all.",
                if selector.trashed { "trashed" } else { "live" }
            ));
            text
        };
        outcome.effect.insert("recovery".to_owned(), json!("empty"));
        let summary = text.split(['.', ';']).next().unwrap_or_default().to_owned();
        self.push_obs_with(true, None, summary, text, lines, outcome, true);
    }

    // -----------------------------------------------------------------
    // The turn loop.
    // -----------------------------------------------------------------

    /// A new user message: compaction first, then the turn's block (SPEC
    /// §6.1): the pre-grounded `vault:` line (`preground`), the `focus:` line,
    /// the `answer:` line (`crate::native::block::answer_line`), the `dates:` line and the `picks:` line
    /// (`crate::native::block::picks_line`), joined as `block`, which is what precedes the message in the user turn. A message that takes the request back
    /// (`phrases::is_retraction`) also carries `ended`, the turn's own end.
    pub fn user(&mut self, message: &str) -> Value {
        self.turn += 1;
        self.turn_starts.push(self.results.len());
        self.steps = 0;
        self.last_call = None;
        self.last_text.clear();
        self.repeats = 0;
        self.read_misses = 0;
        self.ambiguity = None;
        self.turn_over = false;
        self.prev_message = std::mem::replace(&mut self.message, message.to_owned());
        self.pending_notes.clear();
        // An ask about a bulk write is answered by the very next message.
        if self
            .pending_bulk
            .as_ref()
            .is_some_and(|pending| pending.turn + 1 < self.turn)
        {
            self.pending_bulk = None;
        }
        let mut compacted = Vec::new();
        for index in 0..self.observations.len() {
            let obs = &self.observations[index];
            // THE PREVIOUS TURN STAYS WHOLE: a follow-up ("the second one",
            // "put it on that list") picks from it. Only turns before it
            // compact.
            if !obs.result || obs.compacted.is_some() || obs.turn + 1 >= self.turn {
                continue;
            }
            let seq = obs.seq;
            let kept: BTreeSet<usize> = self
                .references
                .iter()
                .filter(|(at, _)| *at > seq)
                .flat_map(|(_, numbers)| numbers.iter().copied())
                .chain(self.acted.iter().copied())
                .filter(|number| {
                    self.observations[index]
                        .lines
                        .iter()
                        .any(|(numbers, _)| numbers.contains(number))
                })
                .collect();
            self.observations[index].compacted = Some(kept);
            compacted.push(json!({"obs": index, "text": self.observations[index].render()}));
        }
        let (preground, focus, answer, dates, picks) = if self.flags.preground {
            // The containers of the focus rows are numbered first, so the
            // `vault:` and `focus:` lines can name them (`#8 album "Wedding"`).
            crate::native::block::number_containers(self);
            (
                crate::native::search::preground(self, message),
                crate::native::prompt::focus_line(self),
                crate::native::block::answer_line(self),
                self.dates_line(message),
                crate::native::block::picks_line(self, message),
            )
        } else {
            (None, None, None, None, None)
        };
        let block =
            crate::native::prompt::user_block(&[&preground, &focus, &answer, &dates, &picks]);
        // A RETRACTION ENDS THE TURN BEFORE ANY CALL: the runtime makes the
        // `decline never_mind` itself, so the model never has to learn it. The
        // reply carries it as `ended`, and a call after it is refused as a call
        // after the turn ended.
        let ended = crate::native::phrases::is_retraction(message)
            .then(|| self.step("decline", &json!({"reason": "never_mind"}), None, None));
        let mut out = json!({
            "turn": self.turn,
            "preground": preground,
            "focus": focus,
            "answer": answer,
            "dates": dates,
            "picks": picks,
            "block": block,
            "compacted": compacted,
        });
        if let Some(ended) = ended {
            out["ended"] = ended;
        }
        out
    }

    /// One model call.
    pub fn call(&mut self, tool: &str, args: &Value) -> Value {
        self.step(tool, args, None, None)
    }

    /// One model call with the think block written before it. A slot trace in it
    /// (`crate::native::trace::parse`) is enforced; any other think is ignored, so
    /// old-format calls behave exactly as `call`.
    pub fn call_traced(&mut self, tool: &str, args: &Value, think: Option<&str>) -> Value {
        self.step(tool, args, None, think)
    }

    /// A model message as the model wrote it: its call is read (`parse::parse_call`) and sent
    /// with the think block in front of it. A message with more than one call runs the first and
    /// its reply ends with `note: only the first call ran` (nt12 R5); one that holds no readable
    /// call is `call_unreadable`. The response carries the call it read as `call`.
    pub fn call_text(&mut self, text: &str) -> Value {
        match crate::native::parse::parse_call(text) {
            Ok(call) => {
                let tool = call["tool"].as_str().unwrap_or_default().to_owned();
                if call["extra_calls"].as_u64().unwrap_or(0) > 0 {
                    self.closing_note = Some(crate::native::parse::ONLY_FIRST.to_owned());
                }
                let mut response =
                    self.call_traced(&tool, &call["args"], crate::native::trace::think_of(text));
                response["call"] = call;
                response
            }
            Err(message) => self.call_unreadable(&message),
        }
    }

    /// A model message that held no readable call: a counted step whose
    /// observation is the parse error (SPEC §5).
    pub fn call_unreadable(&mut self, message: &str) -> Value {
        self.step("", &Value::Null, Some(message.to_owned()), None)
    }

    fn step(
        &mut self,
        tool: &str,
        args: &Value,
        unreadable: Option<String>,
        think: Option<&str>,
    ) -> Value {
        if self.turn == 0 {
            self.user("");
        }
        if self.turn_over {
            return json!({
                "text": "error: the turn has ended; the next call belongs to a new user message.",
                "ends_turn": true,
                "effect": {"error": "turn over"},
            });
        }
        self.steps += 1;
        self.seq += 1;
        let canonical = format!("{tool} {}", canonical_json(args));
        let before = self.observations.len();
        let mut guarded = false;
        let mut outcome = if let Some(message) = unreadable {
            Outcome::error(message)
        } else if self.last_call.as_deref() == Some(canonical.as_str()) {
            self.repeat_outcome()
        } else {
            self.repeats = 0;
            self.trace = think.and_then(crate::native::trace::parse);
            let outcome = if let Some(trace) = &self.trace
                && let Some(refusal) = self.trace_guard(tool, args, trace)
            {
                // A CALL THAT CONTRADICTS ITS OWN TRACE is refused like a repeat:
                // an error observation, nothing run. It does not count as the
                // last call, so the same call under a corrected trace goes through.
                guarded = true;
                let mut refused = Outcome::error(refusal);
                refused.effect.insert("trace_guard".to_owned(), json!(true));
                refused
            } else {
                // A MALFORMED CALL IS REPAIRED BEFORE ITS FIRST SEND (`normalize.rs`), then
                // the dates are grounded; each repair is a note and a `normalized` entry.
                let mut repaired = self.normalize(tool, args, None);
                self.carry_over(tool, args, &mut repaired);
                let (grounded, notes) = self.ground(tool, &repaired.args);
                repaired.notes.extend(notes);
                self.pending_notes = repaired.notes;
                let mut outcome = self.dispatch(tool, &grounded);
                if !repaired.entries.is_empty() {
                    outcome
                        .effect
                        .insert("normalized".to_owned(), Value::Array(repaired.entries));
                }
                self.last_text = first_line(
                    &outcome.text,
                    if outcome.text.starts_with("error:") {
                        REPEAT_ECHO_ERROR
                    } else {
                        REPEAT_ECHO
                    },
                );
                self.last_step = self.steps;
                self.last_invalid = is_invalid(tool, &outcome);
                self.last_rejected = match grounded.as_object() {
                    Some(args) if self.last_invalid => Some(Rejected {
                        tool: tool.to_owned(),
                        args: args.clone(),
                        text: outcome
                            .effect
                            .get("error")
                            .and_then(Value::as_str)
                            .map_or_else(|| outcome.text.clone(), str::to_owned),
                    }),
                    _ => None,
                };
                outcome
            };
            self.trace = None;
            outcome
        };
        // an `answer` that came back empty and left the turn open is no call to refuse when sent
        // again: its second send is the answer (`compose_unmatched_read`)
        let reopened = outcome
            .effect
            .get("compose")
            .is_some_and(|facts| facts["action"] == "answer_miss");
        self.last_call = if guarded || reopened {
            None
        } else {
            Some(canonical)
        };
        self.references.push((self.seq, referenced(args)));
        let mut trailing: Vec<String> = std::mem::take(&mut self.pending_notes);
        if !trailing.is_empty() {
            outcome.text.push('\n');
            outcome.text.push_str(&trailing.join("\n"));
        }
        let mut cap_note = None;
        if !outcome.ends_turn && self.steps >= STEP_CAP {
            // THE CAP ENDS IN AN ASK that says what is unclear, unless a write
            // landed this turn (an ask would then read as "nothing was done").
            if let Some(ask) = self.failsoft_ask("cap") {
                outcome.text.push('\n');
                outcome.text.push_str(&ask.text);
                trailing.push(ask.text.clone());
                cap_note = Some(ask.text);
                outcome.effect.extend(ask.effect);
            } else {
                let note = format!("error: step cap ({STEP_CAP}) reached; the turn ends.");
                outcome.text.push('\n');
                outcome.text.push_str(&note);
                trailing.push(note.clone());
                cap_note = Some(note);
                outcome.effect.insert("cap".to_owned(), json!(true));
            }
            outcome.ends_turn = true;
        }
        // A STEP THAT WAS REJECTED OR CAME BACK EMPTY restates the rows the
        // model can still use, so its next call re-anchors on them. The line
        // is not part of the block: it never reaches compaction.
        if !outcome.ends_turn
            && let Some(line) = self.restate(tool, &outcome)
        {
            outcome.text.push('\n');
            outcome.text.push_str(&line);
        }
        if let Some(note) = self.closing_note.take() {
            outcome.text.push('\n');
            outcome.text.push_str(&note);
            trailing.push(note);
        }
        if outcome.ends_turn {
            self.turn_over = true;
        }
        let index = if self.observations.len() > before {
            self.observations.len() - 1
        } else {
            // Every call leaves an observation, so the transcript and the
            // compaction indices line up call for call.
            self.observations.push(Obs {
                turn: self.turn,
                seq: self.seq,
                result: false,
                handle: None,
                summary: String::new(),
                header: outcome.text.clone(),
                lines: Vec::new(),
                compacted: None,
                note: None,
                inline: false,
            });
            self.observations.len() - 1
        };
        if (cap_note.is_some() || !trailing.is_empty())
            && self.observations[index].header != outcome.text
        {
            self.observations[index].note = Some(trailing.join("\n"));
        }
        outcome
            .effect
            .entry("tool".to_owned())
            .or_insert_with(|| json!(tool));
        self.record_effects(&outcome);
        json!({
            "text": outcome.text,
            "ends_turn": outcome.ends_turn,
            "effect": Value::Object(outcome.effect),
            "obs": index,
            "step": self.steps,
        })
    }

    /// What a finished step leaves behind for the focus line and the next
    /// step: the rows it created, the options of the ask it ended in, the
    /// candidates of the `ambiguous:` reply it was.
    fn record_effects(&mut self, outcome: &Outcome) {
        let numbers = |rows: &Value, cap: usize| -> Vec<usize> {
            rows.as_array()
                .into_iter()
                .flatten()
                .take(cap)
                .filter_map(|row| row["n"].as_u64())
                .filter_map(|n| usize::try_from(n).ok())
                .collect()
        };
        if let Some(created) = outcome.effect.get("created") {
            self.created.extend(numbers(created, usize::MAX));
        }
        if let Some(options) = outcome.effect.get("ask").map(|ask| &ask["options"]) {
            self.last_ask = (self.turn, numbers(options, usize::MAX));
        }
        // THE REPLY LISTS ITS FIRST `ROW_CAP` CANDIDATES (`ambiguous_block`); a
        // later one may carry a number from an earlier result without being
        // on the list, and an ask does not offer what the reply did not show.
        if !outcome.ends_turn
            && let Some(candidates) = outcome.effect.get("ambiguous")
        {
            self.ambiguity = Some((self.seq, numbers(candidates, ROW_CAP)));
        }
    }

    /// The `#n` the model can still use, in the order `restate` offers them:
    /// this turn's blocks first, the newest of them first, then the turn's
    /// pre-grounded rows, then the previous turn's. Not deduplicated.
    fn usable_order(&self) -> Vec<usize> {
        let shown = |obs: &&Obs| obs.compacted.is_none() && obs.turn + 1 >= self.turn;
        let mut blocks: Vec<&Obs> = self.observations.iter().filter(shown).collect();
        // This turn's blocks first, the newest of them first; then the previous turn's.
        blocks.sort_by_key(|obs| (obs.turn != self.turn, std::cmp::Reverse(obs.seq)));
        let pre: Vec<usize> = self.preground.iter().copied().collect();
        let mut order: Vec<usize> = Vec::new();
        for obs in blocks.iter().filter(|obs| obs.turn == self.turn) {
            order.extend(obs.visible());
        }
        order.extend(pre);
        for obs in blocks.iter().filter(|obs| obs.turn != self.turn) {
            order.extend(obs.visible());
        }
        order
    }

    /// `usable_order` without repeats or numbers that are not rows.
    pub(crate) fn usable_rows(&self) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        for number in self.usable_order() {
            if number > 0 && number <= self.by_number.len() && !out.contains(&number) {
                out.push(number);
            }
        }
        out
    }

    /// `rows you can still use: #9 task "Pay rent", …` after a step that was
    /// rejected (an `error:`) or empty (a find or search with no rows, an act
    /// that matched none) and names no row itself: this turn's rows, newest
    /// block first, then the turn's pre-grounded rows, then the previous turn's.
    /// At most `RESTATE_ROWS` rows.
    fn restate(&self, tool: &str, outcome: &Outcome) -> Option<String> {
        // A repeated call has its own escalation (`repeat_outcome`); a trace
        // refusal is the trace's to fix, not a row's.
        if outcome.effect.contains_key("repeat") || outcome.effect.contains_key("trace_guard") {
            return None;
        }
        // Only a rejection about rows or handles ("#99 was never shown", "open
        // takes exactly one row"): a bad verb or field is not a lost anchor.
        let lower = outcome.text.to_lowercase();
        let rejected = outcome.effect.contains_key("error")
            && ["#", "@", "row", "shown"]
                .iter()
                .any(|word| lower.contains(word));
        let empty = (matches!(tool, "find" | "search")
            && outcome
                .effect
                .get("rows")
                .is_some_and(|rows| rows.as_array().is_some_and(Vec::is_empty)))
            || (outcome.text.contains("nothing was done.")
                && !outcome.text.starts_with("ambiguous"));
        if !(rejected || empty) {
            return None;
        }
        let mut numbers: Vec<usize> = Vec::new();
        let order = self.usable_order();
        // A step that already names a row the model can use (a recovery, a
        // refusal about "#10") has said what to use next.
        let names = |number: usize| {
            outcome
                .text
                .match_indices(&format!("#{number}"))
                .any(|(at, found)| {
                    !outcome.text[at + found.len()..].starts_with(|c: char| c.is_ascii_digit())
                })
        };
        if order.iter().any(|number| names(*number)) {
            return None;
        }
        for number in order {
            if numbers.len() == RESTATE_ROWS {
                break;
            }
            if numbers.contains(&number) || number == 0 || number > self.by_number.len() {
                continue;
            }
            numbers.push(number);
        }
        if numbers.is_empty() {
            return None;
        }
        let rows: Vec<String> = numbers
            .iter()
            .map(|number| render::named(&self.world, *number, &self.by_number[number - 1]))
            .collect();
        Some(format!("rows you can still use: {}", rows.join(", ")))
    }

    /// CONVERSATIONAL FOCUS: the `#n` of every row the previous turn and this
    /// turn have opened, acted on, offered as an option of an `ask`, or found
    /// as the whole of a result of at most `FOCUS_RESULT_MAX` rows. A by-name
    /// act that fits several rows may take the one of them that is in focus,
    /// when exactly one is. Two kinds of block do not count: an `ambiguous:`
    /// block, which lists every candidate, and a longer list, where a row is
    /// there because it met a condition and the person is not thereby talking
    /// about it ("who's weekly" lists seven people; "rosa phoned" is not about
    /// the one Rosa among them).
    ///
    /// With `own_turn` false this turn's own observations do not count: the
    /// rows the model has looked up itself in this turn are not what the
    /// person was talking about. With `any_size` a longer list counts too
    /// (the pick path, where the model has named the row and the list only
    /// has to bear it out).
    ///
    /// The runtime counts no row the model was not shown. A row the previous
    /// turn wrote counts when the `focus:` line names it (`named_written`: its
    /// `acted` part, or a set or `created` part that names it); a turn that
    /// wrote more rows than the `acted` part names leaves the earlier ones out
    /// of the count as it does out of the line. A row this turn wrote counts
    /// (the model read its observation), and so does an option of an `ask`
    /// (the `asked:` part).
    pub(crate) fn focus(&self, own_turn: bool, any_size: bool) -> BTreeSet<usize> {
        let in_reach = |turn: usize| turn + 1 >= self.turn && (own_turn || turn < self.turn);
        let named = crate::native::block::named_written(self);
        self.observations
            .iter()
            .filter(|obs| in_reach(obs.turn) && !obs.header.starts_with("ambiguous"))
            .filter(|obs| {
                any_size
                    || obs.handle.is_none_or(|handle| {
                        self.results
                            .get(handle - 1)
                            .is_some_and(|set| set.keys.len() <= FOCUS_RESULT_MAX)
                    })
            })
            .flat_map(Obs::visible)
            .chain(
                self.marks
                    .iter()
                    .filter(|mark| {
                        in_reach(mark.turn)
                            && (!mark.written
                                || mark.turn == self.turn
                                || named.contains(&mark.number))
                    })
                    .map(|mark| mark.number),
            )
            .collect()
    }

    /// Whether the message names a person other than the user or says a pronoun for them
    /// (a person only in focus does not count: nt14).
    pub(crate) fn names_a_person_or_pronoun(&self) -> bool {
        crate::native::search::message_names_a_person(self, &self.message)
            || crate::native::block::says_a_pronoun_for_them(&self.message)
    }

    /// Whether the turn is about a person other than the user: the message says one's name, or
    /// a pronoun for them, or one is in focus (`block::other_person_in_play`).
    pub(crate) fn names_someone_else(&self) -> bool {
        crate::native::search::message_names_a_person(self, &self.message)
            || crate::native::block::other_person_in_play(self, &self.message)
    }

    /// Rows this turn offered as options of an `ask`: in focus next turn
    /// (the `asked:` part of the line).
    pub(crate) fn mark_offered(&mut self, keys: &[Key]) {
        self.mark(keys, false);
    }

    /// Rows this turn's write acted on, a change, an already-so answer or an
    /// undo: in focus next turn, and named by the `acted` part of the line for
    /// `ACTED_TURNS` turns unless a set or `created` part names them.
    pub(crate) fn mark_acted(&mut self, keys: &[Key]) {
        self.mark(keys, true);
    }

    fn mark(&mut self, keys: &[Key], written: bool) {
        for key in keys {
            let number = self.number(key);
            self.marks.push(Mark {
                turn: self.turn,
                number,
                written,
            });
        }
    }

    /// The typed end of a turn that ran out of steps (`cap`) or repeated
    /// itself (`loop`): `asked: "…"` with the rows the turn saw as options, the
    /// thing that kept failing quoted. `None` when a write landed this turn.
    fn failsoft_ask(&mut self, why: &str) -> Option<Outcome> {
        if self.writes.iter().any(|(turn, _, _)| *turn == self.turn) {
            return None;
        }
        let failing = self
            .observations
            .iter()
            .rev()
            .filter(|obs| obs.turn == self.turn)
            .map(|obs| first_line(&obs.header, REPEAT_ECHO))
            .find(|line| {
                !line.starts_with("error: repeated call")
                    && (line.starts_with("error:")
                        || line.starts_with("0 ")
                        || line.starts_with("no live ")
                        || line.starts_with("ambiguous:"))
            });
        let question = match (why, failing) {
            ("cap", Some(line)) => {
                format!(
                    "I could not settle this in {STEP_CAP} steps; the last thing that failed: {line} Which did you mean?"
                )
            }
            ("cap", None) => {
                format!("I could not settle this in {STEP_CAP} steps. Which of these did you mean?")
            }
            (_, Some(line)) => format!("I could not settle this: {line} Which did you mean?"),
            (_, None) => "I could not settle this. Which of these did you mean?".to_owned(),
        };
        let mut numbers: Vec<usize> = Vec::new();
        let mut blocks: Vec<&Obs> = self
            .observations
            .iter()
            .filter(|obs| obs.turn == self.turn && obs.compacted.is_none())
            .collect();
        blocks.sort_by_key(|obs| std::cmp::Reverse(obs.seq));
        let candidates = blocks
            .iter()
            .flat_map(|obs| obs.visible())
            .chain(self.preground.iter().copied());
        for number in candidates {
            if numbers.len() < ROW_CAP
                && number > 0
                && number <= self.by_number.len()
                && !numbers.contains(&number)
            {
                numbers.push(number);
            }
        }
        let keys: Vec<Key> = numbers
            .iter()
            .map(|number| self.by_number[number - 1].clone())
            .collect();
        self.mark_offered(&keys);
        let mut text = format!("asked: \"{question}\"");
        if !keys.is_empty() {
            let names: Vec<String> = keys
                .iter()
                .zip(&numbers)
                .map(|(key, number)| render::named(&self.world, *number, key))
                .collect();
            text.push_str(&format!(" · options: {}", names.join(", ")));
        }
        let mut outcome = Outcome::text(text);
        outcome.ends_turn = true;
        outcome.effect.insert(
            "ask".to_owned(),
            json!({"question": question, "options": self.keys_json(&keys)}),
        );
        outcome.effect.insert("tool".to_owned(), json!("ask"));
        outcome.effect.insert("failsoft".to_owned(), json!(why));
        Some(outcome)
    }

    /// A TURN THE RUNTIME ENDS IN AN ASK IT COMPOSES ITSELF: a write over the
    /// cap that needs a yes (`act.rs`, `bulk_ask`) and a refusal of the vault
    /// the person can still act on (`Session::refusal`). The reply is the
    /// refusal `lead`, when there is one, then `asked: "…"` with the rows it is
    /// about (`options`, at most `ROW_CAP`) and a `note` that says the runtime
    /// ended the turn. Like the ask the model writes, its options are in focus
    /// for the next turn. The effect is an `ask`; the caller adds the facts that
    /// explain it (`bulk`, `refusal`).
    pub(crate) fn ends_in_ask(
        &mut self,
        lead: Option<String>,
        question: &str,
        options: &[Key],
        note: &str,
    ) -> Outcome {
        let shown: Vec<Key> = options.iter().take(ROW_CAP).cloned().collect();
        self.mark_offered(&shown);
        let mut text = lead.map(|lead| format!("{lead}\n")).unwrap_or_default();
        text.push_str(&format!("asked: \"{question}\""));
        if !shown.is_empty() {
            let names: Vec<String> = shown
                .iter()
                .map(|key| {
                    let n = self.number(key);
                    render::named(&self.world, n, key)
                })
                .collect();
            text.push_str(&format!(" · options: {}", names.join(", ")));
            if options.len() > shown.len() {
                text.push_str(&format!(" and {} more", options.len() - shown.len()));
            }
        }
        text.push_str(&format!(" · {note}"));
        let mut outcome = Outcome::text(text);
        outcome.ends_turn = true;
        outcome.effect.insert(
            "ask".to_owned(),
            json!({"question": question, "options": self.keys_json(&shown)}),
        );
        outcome.effect.insert("tool".to_owned(), json!("ask"));
        outcome.effect.insert("composed".to_owned(), json!(true));
        outcome
    }

    /// The same for a decline: `declined: not_found`, with the refusal `lead`
    /// before it and a `note` that says the runtime ended the turn.
    pub(crate) fn ends_in_decline(
        &mut self,
        lead: Option<String>,
        reason: &str,
        note: &str,
    ) -> Outcome {
        let mut text = lead.map(|lead| format!("{lead}\n")).unwrap_or_default();
        text.push_str(&format!("declined: {reason} · {note}"));
        let mut outcome = Outcome::text(text);
        outcome.ends_turn = true;
        outcome
            .effect
            .insert("decline".to_owned(), json!({"reason": reason}));
        outcome.effect.insert("tool".to_owned(), json!("decline"));
        outcome.effect.insert("composed".to_owned(), json!(true));
        outcome
    }

    /// The observation of an identical call sent again right after itself.
    /// The call is not run again (a write would land twice). Escalation, one
    /// rung per consecutive repeat: a hint that names what the first call
    /// returned; a second nudge; then the turn ends as a `loop`. A call the
    /// runtime refused as invalid skips the rungs: nothing changes between
    /// two identical calls, so the first repeat ends the turn, and the reply
    /// names the step that repeated and the step it repeated.
    fn repeat_outcome(&mut self) -> Outcome {
        self.repeats += 1;
        let invalid = self.last_invalid;
        // nt10 G1: the first identical resend after an `error:` is one hint rung, not the end
        let error_reply = invalid && self.last_text.starts_with("error:");
        let mut outcome = match self.repeats {
            1 if error_reply => Outcome::error(same_call_hint(&self.last_text)),
            1 if !invalid => Outcome::error(repeat_hint(&self.last_text)),
            2 if !invalid => Outcome::error(REPEAT_NUDGE),
            _ => {
                let mut ended = Outcome::error(if invalid {
                    format!(
                        "error: repeated call at step {}: step {} sent the same call and the runtime refused it as invalid.",
                        self.steps, self.last_step
                    )
                } else {
                    "error: repeated call".to_owned()
                });
                ended.ends_turn = true;
                // A CALL REFUSED AS INVALID AND SENT AGAIN IS "NO FIX KNOWN": the
                // runtime ends the turn in the typed outcome its error family
                // names (`invalid_failsoft`), never the generic ask. Any other
                // loop ends in an ask naming the call that kept failing. Both
                // stay a loop when a write landed this turn.
                let typed = if invalid {
                    self.invalid_failsoft()
                } else {
                    None
                };
                if let Some(typed) = typed {
                    ended.text.push('\n');
                    ended.text.push_str(&typed.text);
                    ended.effect.remove("error");
                    ended.effect.extend(typed.effect);
                } else if let Some(ask) = self.failsoft_ask("loop") {
                    ended.text.push('\n');
                    ended.text.push_str(&ask.text);
                    ended.effect.extend(ask.effect);
                } else {
                    ended.effect.insert("loop".to_owned(), json!(true));
                }
                if invalid {
                    ended.effect.insert(
                        "invalid_repeat".to_owned(),
                        json!({"step": self.steps, "of": self.last_step}),
                    );
                }
                ended
            }
        };
        outcome
            .effect
            .insert("repeat".to_owned(), json!(self.repeats));
        outcome
    }

    /// How many repeats the session has already answered if `tool args`
    /// would be one more; `None` when it would not be a repeat. The driver
    /// asks before sending, to resample a repeat instead of spending it.
    #[must_use]
    pub fn peek_repeat(&self, tool: &str, args: &Value) -> Option<usize> {
        let canonical = format!("{tool} {}", canonical_json(args));
        (!self.turn_over && self.last_call.as_deref() == Some(canonical.as_str()))
            .then_some(self.repeats)
    }

    /// The tool a call names, run once.
    fn run_tool(&mut self, tool: &str, args: &Map<String, Value>) -> Result<Outcome, String> {
        match tool {
            "search" => crate::native::search::search(self, args),
            "find" => self.find(args),
            "open" => self.open_row(args),
            "compute" => self.compute(args, false),
            "act" => self.act(args),
            "answer" => self.answer(args),
            "ask" => self.ask(args),
            "decline" => self.decline(args),
            _ => unreachable!("checked above"),
        }
    }

    fn dispatch(&mut self, tool: &str, args: &Value) -> Outcome {
        let Some(args) = args.as_object() else {
            return Outcome::error(format!(
                "error: could not read the call; args are an object. tools: {}.",
                meta::TOOLS.join(", ")
            ));
        };
        if !meta::TOOLS.contains(&tool) {
            return Outcome::error(format!(
                "error: could not read the call; no tool \"{tool}\". tools: {}.",
                meta::TOOLS.join(", ")
            ));
        }
        let allowed = tool_params(tool);
        for key in args.keys() {
            if !allowed.contains(&key.as_str()) {
                return Outcome::error(format!(
                    "error: {tool} has no parameter \"{key}\". {tool} parameters: {}.",
                    allowed.join(", ")
                ));
            }
        }
        // A CALL THE RUNTIME CAN FIX WITHOUT A GUESS RUNS FIXED (nt12 R1, R2): the corrected call
        // is run in the same step and the reply carries one `note:` line for what was used. A
        // fix that fails too is the first error, with the call to send (`error_with_call`). Like
        // every best-effort repair of a malformed call it is off under `--no-normalize`, the
        // replay of an author's bad steps.
        let mut current = args.clone();
        let mut notes: Vec<String> = Vec::new();
        let mut first_error: Option<String> = None;
        loop {
            match self.run_tool(tool, &current) {
                Ok(outcome) => {
                    self.pending_notes.extend(notes);
                    return outcome;
                }
                Err(error) => {
                    let fix = if self.flags.normalize && notes.len() < FIX_CAP {
                        self.decidable_fix(tool, &current, &error)
                            .filter(|fix| fix.args != current)
                    } else {
                        None
                    };
                    let first = first_error.get_or_insert_with(|| error.clone()).clone();
                    let Some(fix) = fix else {
                        let shown = if notes.is_empty() { &current } else { args };
                        let error = if notes.is_empty() { error } else { first };
                        let error = self.error_with_call(tool, shown, error);
                        return Outcome::error(error);
                    };
                    notes.push(fix.note);
                    current = fix.args;
                }
            }
        }
    }

    fn find(&mut self, args: &Map<String, Value>) -> Result<Outcome, String> {
        // (nt15 R1b: a find has no `rows`; the repair its error names is `answer`'s)
        let selector = self
            .selector(args)
            .map_err(|error| error.replace(" use rows: ", " find takes no rows; answer rows: "))?;
        if let Some(outcome) = self.no_link(&selector) {
            return Ok(outcome);
        }
        let mut selector = selector;
        let keys = self.select_read(&mut selector);
        let keys = self.name_without_when(&mut selector, keys);
        let mut outcome = Outcome::text("");
        // A FIND IS A LOOKUP (SPEC §4.8): a name that reaches nothing is a miss the turn goes
        // on from, never an answer; `answer` is where the near spellings become the answer.
        if keys.is_empty() && self.flags.compose && self.dead_end(&selector) {
            return Ok(self.compose_find_miss(&selector, "find_miss"));
        }
        if keys.is_empty() && self.dead_end(&selector) {
            self.empty(&selector, &mut outcome);
        } else if keys.is_empty() {
            let text = self.none_text(&selector);
            // nt10 G3: two conditions or more, and one of them hid rows
            let hint = self.empty_read_hint(&selector);
            let lines = hint
                .as_ref()
                .map(|(_, numbers)| vec![(numbers.clone(), String::new())])
                .unwrap_or_default();
            self.push_obs(true, None, text.clone(), text, lines, &mut outcome);
            if let Some((line, _)) = hint {
                self.pending_notes.push(line);
                self.read_misses += 1;
                outcome = crate::native::compose::marked(outcome, "unmatched_read", "find_miss");
            }
        } else {
            let handle = self.issue(
                &selector.kinds,
                keys.clone(),
                selector.when,
                None,
                meta::lookup_shown(keys.len()),
                &mut outcome,
            );
            self.result_whats.insert(handle, selector.what());
            if !selector.conds.is_empty()
                || selector.when.is_some()
                || !selector.linked_to.is_empty()
            {
                self.narrowed.push((self.turn, handle));
            }
            outcome
                .effect
                .insert("result".to_owned(), json!(format!("@{handle}")));
        }
        outcome
            .effect
            .insert("rows".to_owned(), self.keys_json(&keys));
        Ok(outcome)
    }

    /// `[{kind, id, n}]` for the scorer.
    pub(crate) fn keys_json(&self, keys: &[Key]) -> Value {
        Value::Array(
            keys.iter()
                .map(|key| {
                    json!({
                        "kind": key.0.name(),
                        "id": key.1,
                        "n": self.numbers.get(key),
                    })
                })
                .collect(),
        )
    }

    fn open_row(&mut self, args: &Map<String, Value>) -> Result<Outcome, String> {
        let handle = arg_str(args, "row").ok_or("error: open needs row=#n.")?;
        if handle.contains(',') || handle.starts_with('@') {
            return Err("error: open takes exactly one row, #n.".to_owned());
        }
        let key = self.resolve_row(&handle)?;
        let row = self.world.rows[&key].clone();
        let number = self.number(&key);
        let header = render::row_line(number, None, &row, self.today());
        let mut lines: Vec<(Vec<usize>, String)> = Vec::new();
        if let Some(Val::Text(body)) = row.field("body") {
            let short: String = body.chars().take(600).collect();
            lines.push((Vec::new(), format!("body: \"{short}\"")));
        }
        if row.kind == Kind::Event
            && let (Some(start), Some(Val::Num(minutes))) = (row.date, row.field("duration"))
            && let Ok(end) = jiff::Span::new()
                .try_minutes(*minutes)
                .and_then(|span| start.at().checked_add(span))
        {
            lines.push((
                Vec::new(),
                format!(
                    "ends {} {}",
                    dates::day_label(end.date()),
                    dates::clock(end.time())
                ),
            ));
        }
        if row.kind == Kind::LockerItem {
            let sealed: Vec<&str> = meta::REVEAL_FIELDS
                .iter()
                .filter(|(_, column)| row.extra.contains_key(column))
                .map(|(name, _)| *name)
                .collect();
            if !sealed.is_empty() {
                lines.push((
                    Vec::new(),
                    format!("sealed: {} (reveal to show)", sealed.join(", ")),
                ));
            }
        }
        let parent = self.world.parent_of(&key);
        if let Some(parent) = &parent {
            let n = self.number(parent);
            lines.push((
                vec![n],
                format!("parent: {}", render::named(&self.world, n, parent)),
            ));
        }
        if key == self.world.me_key() {
            lines.push((Vec::new(), "this is you (me)".to_owned()));
        }
        lines.push((
            Vec::new(),
            format!("created {}", row.created.get(..10).unwrap_or(&row.created)),
        ));
        let neighbours = self.world.neighbours(&key);
        for link in key.0.spec().links {
            let keys: Vec<Key> = neighbours
                .get(&link.kind)
                .into_iter()
                .flatten()
                .filter(|other| parent.as_ref() != Some(*other))
                .filter(|other| self.world.row(other).is_some_and(|row| !row.trashed))
                .cloned()
                .collect();
            let mut numbers = Vec::new();
            let mut names = Vec::new();
            for other in keys.iter().take(meta::OPEN_LINK_CAP) {
                let n = self.number(other);
                numbers.push(n);
                names.push(format!("#{n} \"{}\"", self.world.rows[other].name));
            }
            let mut line = format!("{} ({})", link.label, keys.len());
            if !names.is_empty() {
                line.push_str(&format!(": {}", names.join(", ")));
            }
            let more = keys.len().saturating_sub(meta::OPEN_LINK_CAP);
            if more > 0 {
                line.push_str(&format!(" +{more} more"));
            }
            lines.push((numbers, line));
        }
        let mut outcome = Outcome::text("");
        let summary = render::short(number, &row);
        self.push_obs(true, None, summary, header, lines, &mut outcome);
        outcome
            .effect
            .insert("rows".to_owned(), self.keys_json(&[key]));
        Ok(outcome)
    }

    fn ask(&mut self, args: &Map<String, Value>) -> Result<Outcome, String> {
        let question = arg_str(args, "question").ok_or("error: ask needs question.")?;
        let mut options = match args.get("options").filter(|value| !value.is_null()) {
            Some(value) => {
                self.reject_values(value)?;
                self.resolve_rows(value)?
            }
            None => Vec::new(),
        };
        let completed = self.complete_options(&mut options);
        Ok(self.ask_with(&question, &options, completed))
    }

    /// The turn ends in this ask: the question, its options (in focus next turn), and whether
    /// the runtime completed them from the candidates of an `ambiguous:` reply.
    pub(crate) fn ask_with(&mut self, question: &str, options: &[Key], completed: bool) -> Outcome {
        self.mark_offered(options);
        let mut text = format!("asked: \"{question}\"");
        if !options.is_empty() {
            let names: Vec<String> = options
                .iter()
                .map(|key| {
                    let n = self.number(key);
                    render::named(&self.world, n, key)
                })
                .collect();
            text.push_str(&format!(" · options: {}", names.join(", ")));
        }
        if completed {
            text.push_str(" · options completed from the candidates");
        }
        let mut outcome = Outcome::text(text);
        outcome.ends_turn = true;
        let mut ask = json!({"question": question, "options": self.keys_json(options)});
        if completed {
            ask["completed"] = json!(true);
        }
        outcome.effect.insert("ask".to_owned(), ask);
        outcome
    }

    /// The candidates the last `ambiguous:` reply of this turn listed, in its order.
    pub(crate) fn ambiguity_candidates(&self) -> Vec<Key> {
        self.ambiguity
            .iter()
            .flat_map(|(_, listed)| listed)
            .filter_map(|number| self.by_number.get(number.wrapping_sub(1)).cloned())
            .collect()
    }

    /// AN ASK LISTS EVERY CANDIDATE OF THE AMBIGUITY (D-1044-9): when the
    /// step right after an `ambiguous:` reply asks and its options are some
    /// of the rows that reply listed (none at all counts), the options become
    /// all of them, in the reply's order; the reply lists at most `ROW_CAP`.
    /// The model decides to ask; the runtime's own list says what to choose
    /// from. An ask of any other options is left as it is. Returns whether
    /// the options were completed.
    fn complete_options(&self, options: &mut Vec<Key>) -> bool {
        let Some((step, listed)) = &self.ambiguity else {
            return false;
        };
        if step + 1 != self.seq {
            return false;
        }
        let candidates: Vec<Key> = listed
            .iter()
            .filter_map(|number| self.by_number.get(number.wrapping_sub(1)).cloned())
            .collect();
        if options.len() >= candidates.len() || !options.iter().all(|key| candidates.contains(key))
        {
            return false;
        }
        *options = candidates;
        true
    }

    fn decline(&mut self, args: &Map<String, Value>) -> Result<Outcome, String> {
        let reason = arg_str(args, "reason").unwrap_or_default();
        if !meta::DECLINE_REASONS.contains(&reason.as_str()) {
            return Err(format!(
                "error: decline reason is one of {}.",
                meta::DECLINE_REASONS.join(", ")
            ));
        }
        let mut outcome = Outcome::text(format!("declined: {reason}"));
        outcome.ends_turn = true;
        outcome
            .effect
            .insert("decline".to_owned(), json!({"reason": reason}));
        Ok(outcome)
    }

    pub(crate) fn answer(&mut self, args: &Map<String, Value>) -> Result<Outcome, String> {
        if let Some(value) = arg_str(args, "value") {
            if args.len() > 1 {
                return Err("error: answer value=@n stands alone.".to_owned());
            }
            let handle = self.resolve_result(&value)?;
            let value = self.results[handle - 1].value.clone().ok_or_else(|| {
                format!("error: @{handle} holds rows, not a value; answer rows=@{handle}.")
            })?;
            let mut outcome = Outcome::text(format!("answered: @{handle}"));
            outcome.ends_turn = true;
            outcome.effect.insert("value".to_owned(), value);
            return Ok(outcome);
        }
        if args.contains_key("op") {
            let mut outcome = self.compute(args, true)?;
            // A RECOVERY IS NOT AN ANSWER: the model gets the observation and
            // another step, as `find` would.
            let opened = outcome
                .effect
                .get("compose")
                .is_some_and(|facts| facts["action"] == "answer_miss");
            outcome.ends_turn = !(outcome.effect.contains_key("recovery") || opened);
            return Ok(outcome);
        }
        let mut outcome = Outcome::text("");
        let mut what: Option<String> = None;
        let (kinds, keys, when, ordered) = if let Some(keys) = self.rows_arg(
            args,
            "error: answer takes rows or a selector, not both; narrow with within=@n.",
        )? {
            let mut kinds: Vec<Kind> = Vec::new();
            for key in &keys {
                if !kinds.contains(&key.0) {
                    kinds.push(key.0);
                }
            }
            (kinds, keys, None, false)
        } else {
            let selector = self.selector(args)?;
            if let Some(outcome) = self.no_link(&selector) {
                return Ok(outcome);
            }
            let mut selector = selector;
            let keys = self.select_read(&mut selector);
            let keys = self.name_without_when(&mut selector, keys);
            if keys.is_empty() {
                // A DEAD END (SPEC §8.5; `dead_end`) is a recovery and the
                // turn goes on. Any other empty result is the answer
                // ("nothing is due"), and the turn ends.
                if self.dead_end(&selector) {
                    if self.flags.compose {
                        return Ok(self.compose_unmatched_read(&selector));
                    }
                    self.empty(&selector, &mut outcome);
                    return Ok(outcome);
                }
                let text = format!("answered: {}", self.none_text(&selector));
                let mut outcome = Outcome::text("");
                // nt10 G3: the first empty answer that has a row to name is a lookup that came
                // back empty (the F1 open rule): the turn stays open once
                let hint = if self.flags.compose && self.read_misses == 0 {
                    self.empty_read_hint(&selector)
                } else {
                    None
                };
                let lines = hint
                    .as_ref()
                    .map(|(_, numbers)| vec![(numbers.clone(), String::new())])
                    .unwrap_or_default();
                self.push_obs(false, None, text.clone(), text, lines, &mut outcome);
                if let Some((line, _)) = hint {
                    self.pending_notes.push(line);
                    self.read_misses += 1;
                    outcome.effect.insert("rows".to_owned(), json!([]));
                    return Ok(crate::native::compose::marked(
                        outcome,
                        "unmatched_read",
                        "answer_miss",
                    ));
                }
                outcome.ends_turn = true;
                outcome
                    .effect
                    .insert("answer".to_owned(), json!({"rows": []}));
                return Ok(outcome);
            }
            what = Some(selector.what());
            (
                selector.kinds.clone(),
                keys,
                selector.when,
                selector.order.is_some(),
            )
        };
        let handle = self.issue(
            &kinds,
            keys.clone(),
            when,
            Some("answered:".to_owned()),
            ROW_CAP,
            &mut outcome,
        );
        if let Some(what) = what {
            self.result_whats.insert(handle, what);
        }
        outcome.ends_turn = true;
        outcome.effect.insert(
            "answer".to_owned(),
            json!({"rows": self.keys_json(&keys), "ordered": ordered, "result": format!("@{handle}")}),
        );
        Ok(outcome)
    }

    /// `compute` and `answer op=…` (SPEC §4.3).
    fn compute(&mut self, args: &Map<String, Value>, answering: bool) -> Result<Outcome, String> {
        let op = arg_str(args, "op")
            .ok_or_else(|| format!("error: compute needs op: {}.", meta::OPS.join(", ")))?;
        if !meta::OPS.contains(&op.as_str()) {
            return Err(format!(
                "error: no op \"{op}\". ops: {}.",
                meta::OPS.join(", ")
            ));
        }
        let (kinds, keys, selector) = if let Some(keys) = self.rows_arg(
            args,
            "error: take rows or a selector, not both; narrow with within=@n.",
        )? {
            let mut kinds: Vec<Kind> = Vec::new();
            for key in &keys {
                if !kinds.contains(&key.0) {
                    kinds.push(key.0);
                }
            }
            (kinds, keys, None)
        } else {
            let selector = self.selector(args)?;
            if let Some(outcome) = self.no_link(&selector) {
                return Ok(outcome);
            }
            let mut selector = selector;
            let keys = self.select_read(&mut selector);
            (selector.kinds.clone(), keys, Some(selector))
        };
        let field = arg_str(args, "field");
        let group = arg_str(args, "group");
        if op != "count" && kinds.len() > 1 {
            return Err(format!(
                "error: {op} needs exactly one kind; fields are per kind."
            ));
        }
        let kind = kinds.first().copied().unwrap_or(Kind::Task);
        let rows: Vec<Row> = keys
            .iter()
            .filter_map(|key| self.world.row(key).cloned())
            .collect();
        let (text_value, machine) = if op == "balance" {
            if group.is_some() {
                return Err("error: balance takes no group.".to_owned());
            }
            let linked = selector
                .as_ref()
                .map(|s| s.linked_to.clone())
                .unwrap_or_default();
            // A BALANCE IS OF ONE ROW, chosen as every name read chooses (nt13 B2): `House` is
            // the group called House, not also `Beach House 2026`; several rows on the winning
            // tier are still the error
            let chosen = match selector.as_ref().and_then(|s| s.name.as_ref()) {
                Some(name) if keys.len() > 1 => {
                    let best = crate::native::resolve::resolve_rows(
                        name,
                        keys.iter().filter_map(|key| self.world.row(key)),
                        self.flags.normalize,
                    );
                    if best.matches.is_empty() {
                        keys.clone()
                    } else {
                        best.matches
                    }
                }
                _ => keys.clone(),
            };
            crate::native::values::balance(self, kind, &chosen, &linked)?
        } else {
            if op == "count" && field.is_some() {
                return Err("error: count takes no field.".to_owned());
            }
            if op != "count" {
                let Some(field) = field.as_deref() else {
                    return Err(format!(
                        "error: {op} needs field. {} number fields: {}.",
                        kind.name(),
                        numeric_fields(kind)
                    ));
                };
                match kind.spec().field(field).map(|f| f.ty) {
                    Some(FieldType::Number | FieldType::Money) => {}
                    Some(_) => {
                        return Err(format!(
                            "error: {op} needs a number field; {field} is not. {} number fields: {}.",
                            kind.name(),
                            numeric_fields(kind)
                        ));
                    }
                    None => return Err(whr::no_field(kind, field)),
                }
            }
            if let Some(group) = group.as_deref()
                && kind.spec().field(group).is_none()
            {
                return Err(whr::no_field(kind, group));
            }
            crate::native::values::fold(&op, field.as_deref(), group.as_deref(), &rows, &self.world)
        };
        // A VALUE KEEPS ITS ROWS: the rows it was computed over, so
        // `within: @n` and `exclude: @n` reach them next turn. A balance also
        // keeps the person it was about, which a group's balance has only as
        // `linked_to`.
        let mut kept_kinds = kinds.clone();
        let mut kept_keys = keys.clone();
        if op == "balance" {
            for key in selector.iter().flat_map(|s| s.linked_to.iter()) {
                if key.0 == Kind::Person && !kept_keys.contains(key) {
                    kept_keys.push(key.clone());
                    if !kept_kinds.contains(&Kind::Person) {
                        kept_kinds.push(Kind::Person);
                    }
                }
            }
        }
        self.results.push(ResultSet {
            kinds: kept_kinds,
            keys: kept_keys,
            value: Some(machine.clone()),
        });
        let handle = self.results.len();
        let counted = render::count_phrase(&kinds, &rows.iter().collect::<Vec<_>>());
        self.result_notes.insert(
            handle,
            crate::native::block::SetNote {
                text: crate::native::block::value_text(
                    &op,
                    field.as_deref(),
                    group.as_deref(),
                    &text_value.0,
                    &counted,
                ),
                container: selector
                    .as_ref()
                    .map(|s| crate::native::block::named_containers(&self.world, &s.linked_to))
                    .unwrap_or_default(),
                list_rows: op == "balance",
            },
        );
        let over = match &selector {
            Some(selector) if selector.within.is_some() => {
                format!("@{}", selector.within.unwrap_or_default())
            }
            _ => render::count_phrase(&kinds, &rows.iter().collect::<Vec<_>>()),
        };
        let what = match (&field, op.as_str()) {
            (_, "count") if over.starts_with('@') => {
                format!("count of {over}, {} rows", rows.len())
            }
            (_, "count") => format!("count of {over}"),
            (_, "balance") => text_value.1.clone(),
            (Some(field), _) if over.starts_with('@') => {
                format!("{op} of {field} over {over}, {} rows", rows.len())
            }
            (Some(field), _) => format!("{op} of {field} over {over}"),
            (None, _) => op.clone(),
        };
        let mut header = if group.is_some() {
            format!(
                "@{handle} · {what} by {}: {}",
                group.clone().unwrap_or_default(),
                text_value.0
            )
        } else {
            format!("@{handle} = {} ({what})", text_value.0)
        };
        if let Some(when) = selector.as_ref().and_then(|selector| selector.when) {
            header.push_str(&format!(" · when: {}", when.echo()));
        }
        if answering {
            header = format!("answered: {header}");
        }
        let mut outcome = Outcome::text("");
        self.push_obs(
            false,
            Some(handle),
            header.clone(),
            header,
            Vec::new(),
            &mut outcome,
        );
        outcome.effect.insert("value".to_owned(), machine);
        outcome
            .effect
            .insert("result".to_owned(), json!(format!("@{handle}")));
        // nt10 G3: a count of nothing under two conditions or more names the one that hid rows
        if op == "count"
            && rows.is_empty()
            && self.flags.compose
            && let Some(selector) = &selector
            && let Some((line, _)) = {
                let open = !answering || self.read_misses == 0;
                if open {
                    self.empty_read_hint(selector)
                } else {
                    None
                }
            }
        {
            self.pending_notes.push(line);
            self.read_misses += 1;
            if answering {
                outcome = crate::native::compose::marked(outcome, "unmatched_read", "answer_miss");
            }
        }
        Ok(outcome)
    }

    /// The system prompt pieces (SPEC §6.0).
    pub fn prompt(&mut self) -> Value {
        crate::native::prompt::prompt(self)
    }
}

fn numeric_fields(kind: Kind) -> String {
    let names: Vec<&str> = kind
        .spec()
        .fields
        .iter()
        .filter(|field| matches!(field.ty, FieldType::Number | FieldType::Money))
        .map(|field| field.name)
        .collect();
    if names.is_empty() {
        "none".to_owned()
    } else {
        names.join(", ")
    }
}

fn capitalise(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn default_order(a: &Row, b: &Row, kinds: &[Kind]) -> std::cmp::Ordering {
    let kind_rank = |row: &Row| kinds.iter().position(|kind| *kind == row.kind);
    kind_rank(a)
        .cmp(&kind_rank(b))
        .then_with(|| match (a.date, b.date) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        })
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.id.cmp(&b.id))
}

fn order_value(row: &Row, field: &str) -> Option<Val> {
    match field {
        "name" => Some(Val::Text(row.name.to_lowercase())),
        "date" => row.date.map(Val::Date),
        _ => row.field(field).cloned(),
    }
}

/// Every `#n` a call's arguments name.
fn referenced(args: &Value) -> BTreeSet<usize> {
    let mut out = BTreeSet::new();
    let mut walk = vec![args];
    while let Some(value) = walk.pop() {
        match value {
            Value::String(text) => {
                for part in text.split(|c: char| c == ',' || c.is_whitespace() || c == '"') {
                    if let Some(n) = part.strip_prefix('#').and_then(|n| n.parse().ok()) {
                        out.insert(n);
                    }
                }
            }
            Value::Array(items) => walk.extend(items),
            Value::Object(map) => walk.extend(map.values()),
            _ => {}
        }
    }
    out
}

/// Keys sorted, so two spellings of one call compare equal.
#[must_use]
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|key| format!("{}:{}", json!(key), canonical_json(&map[*key])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod echo_tests {
    use super::*;

    #[test]
    fn a_repeat_after_an_error_quotes_the_fix_the_error_ends_in() {
        let error = format!(
            "error: tasks have no field \"notes\". task editable fields: {}. For that use description.",
            "name, status, effort, priority, description, and a long list of more fields to push it past the plain echo"
        );
        assert!(error.len() > REPEAT_ECHO && error.len() < REPEAT_ECHO_ERROR);
        let echoed = first_line(&error, REPEAT_ECHO_ERROR);
        assert!(repeat_hint(&echoed).contains("For that use description."));
        // a reply that is no error is still cut at the plain length
        assert!(first_line(&error[6..], REPEAT_ECHO).ends_with('…'));
    }
}
