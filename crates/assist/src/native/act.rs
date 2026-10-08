//! `act` (SPEC §4.2): every write through the vault's typed commands, the
//! call-only ambiguity check (§3.3), already-so writes, and `undo`.
//!
//! Two things end a turn here that the model would otherwise have to settle,
//! and the runtime composes both itself (D-1044-10, SPEC §4.6):
//!
//! - THE CAP. A write on more than `ROW_CAP` rows is never run outright,
//!   whatever the trace's `scope` and the call's `more` say: the turn ends in an
//!   ask with the count (`this would delete 734 tasks; delete all of them?`),
//!   and the same write, sent in the turn right after a yes, goes through.
//! - A REFUSAL OF THE VAULT to restore or to delete. A restore the vault will
//!   not make because the row's window has run out ends in `decline not_found`;
//!   a delete it refuses because the row still holds others (a folder with
//!   documents, a group with expenses, a notebook with notebooks) ends in an ask
//!   that names what the person can do. Every other refusal (a call the
//!   command's schema rejects, a check this file does not name, any other
//!   verb) stays an `error:` for the model to repair.
//!
//! With `Flags::compose` the same hands-off rule reaches the selector and the refusals the
//! person can lift (`compose.rs`, SPEC §4.8): a selector that fits several rows or none ends in
//! the ask or the decline the runtime writes, a verb that does not apply to the kind and a row
//! in the trash end in a decline, and a member with a balance, a cancelled event to move and a
//! clash of time end in an ask over the rows involved. Two things the person's words settle
//! before that: a selector that fits several rows takes every one of them when the message (or
//! the trace) says all, and a name that reached nothing goes to the one near spelling of its
//! kind (`Targets::decided`, said in the reply and the effect by `Session::say_decided`).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use crate::native::dates::{self, Stamp};
use crate::native::door::Ran;
use crate::native::meta::{self, FieldType, Kind, ROW_CAP, Verb, Via};
use crate::native::park::{FieldChange, LinkChange, RowChange};
use crate::native::render;
use crate::native::session::{
    Inverse, Outcome, ResultSet, Selector, Session, arg_bool, arg_str, canonical_json,
};
use crate::native::whr;
use crate::native::world::{Key, Row, SEALED, Val, World, minor_of};

/// A write over `ROW_CAP` rows that the runtime asked about (`Session::bulk_ask`).
/// The person's yes in the turn right after the ask lets that same write through
/// (`Session::confirmed`): the same verb, the same rows, the same `args`.
#[derive(Debug, Clone)]
pub(crate) struct PendingBulk {
    /// The turn the ask ended.
    pub turn: usize,
    pub verb: Verb,
    pub keys: BTreeSet<Key>,
    /// The call's `args`, as canonical JSON.
    pub args: String,
}

/// The args a `create` of `kind` takes: `name`, the kind's creatable fields, and the
/// references and secrets its command carries.
pub(crate) fn create_allowed(kind: Kind) -> Vec<&'static str> {
    let mut allowed: Vec<&str> = vec!["name"];
    allowed.extend(
        kind.spec()
            .fields
            .iter()
            .filter(|field| field.create)
            .map(|field| field.name),
    );
    match kind {
        Kind::Task => allowed.extend(["date", "parent", "list"]),
        Kind::Event => allowed.push("date"),
        Kind::Note => allowed.push("notebook"),
        Kind::Document => allowed.extend(["folder", "text"]),
        Kind::Debt => allowed.push("person"),
        Kind::LockerItem => allowed.extend(["password", "code", "card_number", "cvv"]),
        _ => {}
    }
    allowed
}

/// The field a create arg is another spelling of: the kind's own word for its date (`due` for a
/// task, `start` for an event) is `date`. The one resolver of a create's arg names: `create`
/// reads args through it, and so does the normaliser (`normalize.rs`) before it decides an arg
/// is one the kind does not take.
pub(crate) fn create_arg_alias(kind: Kind, key: &str) -> Option<&'static str> {
    kind.spec()
        .date
        .filter(|date| date.label == key)
        .map(|_| "date")
}

/// The input key that names a row of each kind in its commands.
#[must_use]
pub fn id_param(kind: Kind) -> &'static str {
    match kind {
        Kind::Person => "party_id",
        Kind::Group => "group_id",
        Kind::Event => "event_id",
        Kind::Task => "task_id",
        Kind::Note => "note_id",
        Kind::Document => "document_id",
        Kind::Photo => "asset_id",
        Kind::Album => "album_id",
        Kind::Debt => "debt_id",
        Kind::LockerItem => "item_id",
        Kind::Notebook => "notebook_id",
        Kind::Folder => "folder_id",
        Kind::List => "project_id",
    }
}

/// Which container a kind goes into with `add_to`.
#[must_use]
pub fn container_of(kind: Kind) -> Option<Kind> {
    Some(match kind {
        Kind::Person => Kind::Group,
        Kind::Photo => Kind::Album,
        Kind::Note => Kind::Notebook,
        Kind::Document => Kind::Folder,
        Kind::Task => Kind::List,
        _ => return None,
    })
}

/// `args` as the model writes it: an object, or `field: value` lines whose
/// values are JSON when they parse as JSON and text otherwise.
pub fn act_args(value: Option<&Value>) -> Result<Map<String, Value>, String> {
    match value {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.starts_with('{')
                && let Ok(Value::Object(map)) = serde_json::from_str(trimmed)
            {
                return Ok(map);
            }
            let mut map = Map::new();
            for (key, raw) in arg_lines(trimmed)? {
                map.insert(key, arg_value(&raw));
            }
            Ok(map)
        }
        Some(other) => Err(format!(
            "error: args are \"field: value\" lines, not {other}."
        )),
    }
}

/// The `(field, value text)` pairs of `field: value` lines, in the order written.
pub(crate) fn arg_lines(text: &str) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for line in text.lines().flat_map(split_semis) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (key, value) = line.split_once(':').ok_or_else(|| {
            format!(
                "error: could not read the args line \"{line}\"; args are \"field: value\" lines."
            )
        })?;
        out.push((key.trim().to_lowercase(), value.trim().to_owned()));
    }
    Ok(out)
}

/// The value a line's text stands for: JSON when it parses as JSON, else text.
pub(crate) fn arg_value(value: &str) -> Value {
    if value.starts_with(['{', '[', '"']) || value.parse::<f64>().is_ok() {
        serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_owned()))
    } else {
        Value::String(value.to_owned())
    }
}

/// `a: 1; b: 2` on one line reads as two lines, but only where the `;` is
/// followed by another `field:` — a `;` inside a value (`washer; o-ring`) or a
/// JSON value stays in the value.
fn split_semis(line: &str) -> Vec<String> {
    if line.contains('{') {
        return vec![line.to_owned()];
    }
    let starts_field = |rest: &str| {
        let rest = rest.trim_start();
        rest.split_once(':').is_some_and(|(key, _)| {
            let key = key.trim_end();
            !key.is_empty()
                && key
                    .chars()
                    .all(|c| c.is_ascii_alphabetic() || c == '_' || c == ' ' || c == '+')
                && key.split_whitespace().count() <= 2
        })
    };
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut pieces = line.split(';').peekable();
    while let Some(piece) = pieces.next() {
        current.push_str(piece);
        match pieces.peek() {
            Some(next) if starts_field(next) => out.push(std::mem::take(&mut current)),
            Some(_) => current.push(';'),
            None => {}
        }
    }
    out.push(current);
    out
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// One planned write.
struct Step {
    command: &'static str,
    input: Value,
}

/// What one target will do.
enum Plan {
    Already(String),
    Run {
        steps: Vec<Step>,
        inverse: Vec<Step>,
        not_undoable: Option<String>,
        note: Option<String>,
    },
}

/// How `complete` and `reopen` stand to a task's status: the ONE applicability the plan and the
/// candidate filter share (SPEC §14.1, nt12 B3). `Already`: the status is what the verb sets.
/// `Passed`: a cancelled task completes when it is the only row the name fits, and gives way to
/// an open one when the name fits both (`fits` says no, the plan still runs it). `Changes`: the
/// verb leaves the row different and it is a candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stand {
    Changes,
    Passed,
    Already,
}

fn task_stand(verb: Verb, status: &str) -> Stand {
    match (verb, status) {
        (Verb::Complete, "completed") | (Verb::Reopen, "open") => Stand::Already,
        (Verb::Complete, "cancelled") => Stand::Passed,
        _ => Stand::Changes,
    }
}

/// A task's status as the model reads it; a row without one is open.
fn status_of(value: Option<&Val>) -> &'static str {
    match value {
        Some(Val::Enum(status)) => status,
        _ => "open",
    }
}

/// Whether a verb can change a row as it stands (`Session::fits`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fit {
    Yes,
    No,
    /// The call cannot be planned (a bad argument): the write says why.
    Unknown,
}

/// What the runtime decided about the rows of a write by selector (SPEC §4.8), for the effect and
/// the reply of the write that follows.
enum Decided {
    /// The selector fits several rows, and the person (or the trace) said all of them (SPEC §4.8).
    EveryFit,
    /// The name reached nothing of the kind, and the one row of another kind it reaches as it is
    /// said (`resolve`, tiers 1 to 3) is the target (SPEC §4.8).
    OtherKind { name: String, kind: Kind, key: Key },
}

/// The rows an act applies to, and what the runtime decided to get there.
struct Targets {
    keys: Vec<Key>,
    decided: Option<Decided>,
    /// A selector (not `rows=`) that reached exactly one row by itself: no narrowing, no near
    /// spelling, no other-kind fallback picked it.
    by_selector: bool,
}

impl Targets {
    fn of(keys: Vec<Key>) -> Self {
        Self {
            keys,
            decided: None,
            by_selector: false,
        }
    }
}

/// Words that are not part of naming a row: articles, prepositions, the
/// commands themselves.
const UNNAMING: [&str; 52] = [
    "the", "a", "an", "to", "on", "in", "at", "for", "of", "and", "my", "with", "from", "by", "is",
    "be", "as", "up", "off", "out", "do", "did", "i", "me", "we", "you", "was", "just", "please",
    "now", "all", "s", "tick", "star", "unstar", "cancel", "delete", "restore", "complete",
    "reopen", "move", "push", "add", "put", "file", "remove", "take", "mark", "log", "settle",
    "reveal", "undo",
];

/// Words by which a person points at a row instead of naming it, or says
/// which of several: the pick is theirs, not a guess.
const PICKED: [&str; 38] = [
    "it", "them", "that", "this", "those", "these", "he", "she", "her", "him", "his", "they",
    "one", "ones", "too", "also", "same", "again", "both", "other", "another", "first", "second",
    "third", "last", "latest", "previous", "next", "earlier", "later", "open", "done", "finished",
    "paid", "old", "new", "oldest", "newest",
];

/// The personal pronouns of `PICKED`: they refer to a row only when one is in focus.
const PRONOUNS: [&str; 8] = ["it", "them", "he", "she", "her", "him", "his", "they"];

/// Nouns that a number follows as part of a name or a rank ("priority one", "level one", "step
/// one", "day one"): the "one" after them is a number, not a row.
const NUMBER_NOUNS: [&str; 20] = [
    "priority", "level", "step", "day", "number", "grade", "chapter", "page", "week", "phase",
    "round", "part", "version", "tier", "stage", "rank", "item", "episode", "season", "class",
];

/// Whether the word at `at` settles which row the person means: a pick word of `PICKED`, except
/// "one" and "ones" after a number noun, where they are a number.
fn picks_by_word(words: &[String], at: usize) -> bool {
    let word = words[at].as_str();
    if !PICKED.contains(&word) {
        return false;
    }
    if matches!(word, "one" | "ones") {
        return !at
            .checked_sub(1)
            .is_some_and(|before| NUMBER_NOUNS.contains(&words[before].as_str()));
    }
    true
}

/// A weekday in the plural ("dress fitting, saturdays"): it names the row by
/// the day it is on, as "saturday's" does.
fn plural_weekday(word: &str) -> bool {
    word.strip_suffix('s')
        .is_some_and(|day| crate::native::ground::weekday_of(day).is_some())
}

impl Session {
    pub(crate) fn act(&mut self, args: &Map<String, Value>) -> Result<Outcome, String> {
        let mut decided = None;
        let outcome = self.act_run(args, &mut decided)?;
        Ok(self.say_decided(outcome, decided))
    }

    /// What the runtime decided about the rows of the write is said in its reply and its effect:
    /// `compose` for audit, unless the turn ended in an outcome the runtime composed (a refusal
    /// at the row), which keeps its own. A write that ran on a row the runtime chose says so in a
    /// note: a row of another kind leads the reply, the rows of a write on every row follow the
    /// write's lines (`pending_notes`).
    fn say_decided(&mut self, mut outcome: Outcome, decided: Option<Decided>) -> Outcome {
        // The note only reads true of a write that ran: a refusal composed at the row names the
        // row itself.
        let ran = outcome.effect.contains_key("diff")
            && !outcome.effect.contains_key("error")
            && !outcome.effect.contains_key("refusal");
        let (family, action) = match decided {
            None => return outcome,
            Some(Decided::EveryFit) => ("ambiguous_write", "apply_all"),
            Some(Decided::OtherKind { name, kind, key }) => {
                if ran {
                    let n = self.number(&key);
                    let named = render::named(&self.world, n, &key);
                    outcome.text = format!(
                        "note: no {} called \"{name}\"; applied to {named}\n{}",
                        kind.name(),
                        outcome.text
                    );
                }
                ("unmatched_write", "apply_other_kind")
            }
        };
        if outcome.effect.contains_key("compose") {
            outcome
        } else {
            crate::native::compose::marked(outcome, family, action)
        }
    }

    fn act_run(
        &mut self,
        args: &Map<String, Value>,
        decided: &mut Option<Decided>,
    ) -> Result<Outcome, String> {
        let verb_text = match args.get("verb") {
            Some(Value::String(text)) => text.clone(),
            _ => String::new(),
        };
        let verb = Verb::parse(&verb_text).ok_or_else(|| {
            let names: Vec<&str> = meta::VERBS.iter().map(|spec| spec.name).collect();
            format!(
                "error: no verb \"{verb_text}\". verbs: {}.",
                names.join(", ")
            )
        })?;
        let more = arg_bool(args, "more")?.unwrap_or(false);
        let extra = act_args(args.get("args"))?;
        let (verb, extra, redirected) = self.redirect_verb(verb, args, extra);
        let mut logged: Vec<Key> = Vec::new();
        let mut outcome = match verb {
            Verb::Undo => {
                if args.contains_key("rows") || Self::has_selector(args) || !extra.is_empty() {
                    return Err("error: undo takes no rows, selector or args; it reverts the previous turn's writes.".to_owned());
                }
                self.undo()?
            }
            Verb::Create => {
                // CREATE'S KIND IS THE TOP-LEVEL `kind`; `args` carry the new
                // row's fields, `name` included. Each refusal names the
                // parameter at fault and where the value belongs.
                if args.get("rows").is_some_and(|value| !value.is_null()) {
                    return Err("error: create takes no rows parameter; a new row has none yet. Give kind=<kind> and args with its fields.".to_owned());
                }
                if let Some(param) = meta::SELECTOR_PARAMS.iter().find(|param| {
                    **param != "kind" && args.get(**param).is_some_and(|value| !value.is_null())
                }) {
                    return Err(format!(
                        "error: create takes no {param} parameter; the new row's fields go in args (name: …, field: …)."
                    ));
                }
                if extra.contains_key("kind") {
                    return Err("error: create takes kind as the top-level kind parameter, not inside args; args carry the fields only (name: …).".to_owned());
                }
                let kind = arg_str(args, "kind");
                self.create(kind.as_deref(), &extra)?
            }
            _ => {
                let (mut targets, how, by_selector) = match self.targets(verb, args, &extra)? {
                    Ok(found) => (found.keys, found.decided, found.by_selector),
                    Err(outcome) => return Ok(outcome),
                };
                if let Some(asked) =
                    self.ambiguous_pick(verb, &mut targets, args, &extra, by_selector)
                {
                    return Ok(asked);
                }
                *decided = how;
                if verb == Verb::Reschedule
                    && let [only] = targets.as_slice()
                    && let Some(planned) = self.plan_anew(only, &extra)?
                {
                    return Ok(planned);
                }
                let count = targets.len();
                if verb == Verb::Log {
                    logged.clone_from(&targets);
                }
                let mut written = self.write(verb, &targets, &extra)?;
                // Only a confirmed write reaches here over the cap (`targets`).
                if count > ROW_CAP && !written.effect.contains_key("tool") {
                    written.effect.insert(
                        "bulk".to_owned(),
                        json!({"count": count, "cap": ROW_CAP, "confirmed": true}),
                    );
                }
                written
            }
        };
        // what the redirect used is said when the write it made landed or was already so
        if let Some(note) = redirected
            && (outcome.effect.contains_key("diff") || outcome.effect.contains_key("already"))
        {
            self.pending_notes.push(note);
        }
        outcome
            .effect
            .insert("verb".to_owned(), json!(verb.spec().name));
        // A TURN THE RUNTIME ENDED BY ITSELF (a refusal composed in `execute`) is
        // not paged: `more` does not keep it open.
        if outcome.ends_turn && outcome.effect.contains_key("tool") {
            return Ok(outcome);
        }
        // AN ALREADY-SO WRITE ENDS NOTHING (SPEC §4.2): the vault did not
        // change, and the model answers with the state the runtime reported.
        let wrote = outcome.effect.get("diff").is_some_and(|diff| {
            diff["rows"].as_array().is_some_and(|rows| !rows.is_empty())
                || diff["links"]
                    .as_array()
                    .is_some_and(|links| !links.is_empty())
        }) || verb == Verb::Reveal;
        if !wrote && outcome.effect.contains_key("already") {
            // `undo` looks past a turn that changed nothing (`undo_entry`).
            self.noops.insert(self.turn);
            outcome.ends_turn = false;
            return Ok(outcome);
        }
        let mut outcome = finish(outcome, more);
        // A LOG THAT ENDS THE TURN ALSO ANSWERS THE ROW: the contact is
        // the whole of what was asked, and the person reads the row it was
        // logged on.
        if verb == Verb::Log && outcome.ends_turn && !outcome.effect.contains_key("error") {
            self.answer_logged(&logged, &mut outcome);
        }
        Ok(outcome)
    }

    /// THE VERB A CALL MEANS WHEN IT NAMES ANOTHER (nt12 R4): an `edit` of a date is the
    /// `reschedule` it names (`edit date: …` is `reschedule to: …`); an `edit` of `starred`,
    /// `status` or `completed` is `star` or `unstar`, `cancel`, `complete` or `reopen`; args on a
    /// verb that takes none are dropped. One `note:` line says what was used; a call it cannot
    /// read as one of these stays as it was, for the verb's own refusal.
    fn redirect_verb(
        &mut self,
        verb: Verb,
        args: &Map<String, Value>,
        extra: Map<String, Value>,
    ) -> (Verb, Map<String, Value>, Option<String>) {
        // a best-effort repair of a malformed call: off under `--no-normalize` (the replay of an
        // author's bad steps)
        if !self.flags.normalize {
            return (verb, extra, None);
        }
        if verb == Verb::Edit
            && let [(key, value)] = extra.iter().collect::<Vec<_>>().as_slice()
        {
            let kind = arg_str(args, "kind")
                .and_then(|kind| Kind::parse(kind.trim()))
                .or_else(|| {
                    let rows = self.resolve_rows(args.get("rows")?).ok()?;
                    rows.first().map(|key| key.0)
                });
            let field = if key.as_str() == "date" {
                Some("date")
            } else {
                kind.and_then(|kind| whr::resolve_field(kind, key))
            };
            // a date that is no readable expression keeps the edit's own refusal, which names the
            // reschedule and its `to`
            let field = field
                .filter(|field| *field != "date" || dates::parse(&dates::lenient(value).0).is_ok());
            let said = text_of(value).trim().trim_matches('"').to_lowercase();
            let redirected = match (field, kind) {
                (Some("date"), _) => Some((Verb::Reschedule, {
                    let mut to = Map::new();
                    to.insert("to".to_owned(), (*value).clone());
                    to
                })),
                (Some("starred"), _) => whr::parse_bool(&said)
                    .map(|on| (if on { Verb::Star } else { Verb::Unstar }, Map::new())),
                (Some("completed"), Some(Kind::Task)) => whr::parse_bool(&said)
                    .map(|on| (if on { Verb::Complete } else { Verb::Reopen }, Map::new())),
                (Some("status"), Some(Kind::Event)) if said == "cancelled" => {
                    Some((Verb::Cancel, Map::new()))
                }
                (Some("status"), Some(Kind::Task)) => match said.as_str() {
                    "completed" | "done" => Some((Verb::Complete, Map::new())),
                    "open" | "needs-action" | "needs_action" => Some((Verb::Reopen, Map::new())),
                    _ => None,
                },
                _ => None,
            };
            if let Some((to, left)) = redirected {
                let note = format!("note: used {} for the edit of {key}", to.spec().name);
                return (to, left, Some(note));
            }
        }
        if !matches!(verb, Verb::Undo | Verb::Create)
            && verb.spec().args.is_empty()
            && !extra.is_empty()
        {
            let dropped: Vec<String> = extra
                .iter()
                .map(|(key, value)| format!("{key}: {}", text_of(value)))
                .collect();
            let note = format!(
                "note: ignored args {} ({} takes none)",
                dropped.join("; "),
                verb.spec().name
            );
            return (verb, Map::new(), Some(note));
        }
        (verb, extra, None)
    }

    /// The logged rows as the answer of the turn: the effect an `answer
    /// rows: [#n]` makes, beside the diff, and the row's readout line under
    /// the change line (`render::row_line`, as `answer` prints it).
    fn answer_logged(&mut self, keys: &[Key], outcome: &mut Outcome) {
        if keys.is_empty() {
            return;
        }
        let mut kinds: Vec<Kind> = Vec::new();
        for key in keys {
            if !kinds.contains(&key.0) {
                kinds.push(key.0);
            }
        }
        self.results.push(ResultSet {
            kinds,
            keys: keys.to_vec(),
            value: None,
        });
        let handle = self.results.len();
        for (position, key) in keys.iter().take(ROW_CAP).enumerate() {
            let number = self.number(key);
            if let Some(row) = self.world.row(key) {
                outcome.text.push('\n');
                outcome.text.push_str(&render::row_line(
                    number,
                    Some(position + 1),
                    row,
                    self.today(),
                ));
            }
        }
        outcome.effect.insert(
            "answer".to_owned(),
            json!({"rows": self.keys_json(keys), "ordered": false, "result": format!("@{handle}")}),
        );
    }

    /// The rows an act applies to, or the observation that stops it.
    fn targets(
        &mut self,
        verb: Verb,
        args: &Map<String, Value>,
        extra: &Map<String, Value>,
    ) -> Result<Result<Targets, Outcome>, String> {
        if let Some(keys) = self.rows_arg(
            args,
            "error: act takes rows or a selector, not both; narrow with within=@n.",
        )? {
            // THE CAP HOLDS (SPEC §4.6). A write on more rows than a result
            // shows is never run outright: not when the slot trace says `scope:
            // all`, not when the message says "all" or "every", not under
            // `more`. The turn ends in the ask the runtime composes
            // (`bulk_ask`), and the same write, sent in the turn after the
            // person's yes, goes through (`confirmed`).
            if keys.len() > ROW_CAP && !self.confirmed(verb, &keys, extra) {
                // the ask the selector that made the handle ends in (nt11 R5)
                let what = args
                    .get("rows")
                    .map(crate::native::session::handle_list)
                    .and_then(|parts| match parts.as_slice() {
                        [only] => only.strip_prefix('@')?.parse::<usize>().ok(),
                        _ => None,
                    })
                    .and_then(|handle| self.result_whats.get(&handle).cloned())
                    .unwrap_or_else(|| "the selector".to_owned());
                return self.settle_rows(verb, keys, args, extra, &what);
            }
            return Ok(Ok(Targets::of(keys)));
        }
        if !Self::has_selector(args) {
            return Err("error: act needs rows=#n or a selector (kind, name, …).".to_owned());
        }
        let selector = self.selector(args)?;
        if selector.kinds.len() != 1 {
            return Err(
                "error: act needs exactly one kind; fields and verbs are per kind.".to_owned(),
            );
        }
        if let Some(outcome) = self.no_link(&selector) {
            return Ok(Err(outcome));
        }
        // A NAME IS RESOLVED IN TIERS (`resolve`; nt11 R3, nt12 R6): a write acts when exactly one
        // row reaches any of tiers 1 to 3 (several are the ask over all of them, even when one of
        // them is the name as it is said); a name only a typo reaches (tier 4) acts on the one
        // row of the stated kind it reaches, with `matched "<name>" for "<query>"` (not a delete, a
        // removal, money, a secret or a write on every row: those ask), and asks over several.
        let mut named = self.select_named(&selector);
        // a restore is of the trashed rows, whether or not the call says `trashed`: the trashed
        // rows the name reaches as it is said come before a live row it reaches less well
        if verb == Verb::Restore && !selector.trashed {
            let trashed = self.select_named(&Selector {
                trashed: true,
                ..selector.clone()
            });
            if named.keys.is_empty()
                || trashed.tier.is_some_and(|tier| {
                    tier < named.tier.unwrap_or(crate::native::resolve::Tier::Typo)
                })
            {
                named = trashed;
            }
        }
        let keys = if named.tier == Some(crate::native::resolve::Tier::Typo) {
            // the writes a guess must not make stay the ask: a delete or a removal (destructive),
            // money, a secret (egress), and a write the message says takes every row
            let guess_ok = !matches!(
                verb,
                Verb::Delete | Verb::RemoveFrom | Verb::SettleUp | Verb::SettleDebt | Verb::Reveal
            ) && self.said_every_row().is_none();
            match named.keys.as_slice() {
                [_] if self.flags.compose && guess_ok => {
                    self.pending_notes.extend(named.typo_line.take());
                    named.keys
                }
                _ => Vec::new(),
            }
        } else {
            named.keys
        };
        // A TEXT LITERAL THAT REACHED NO ROW, read by the tiers, acts when exactly one row
        // results (nt13 R2); several are the ask or the decline it was
        let mut keys = keys;
        if keys.is_empty()
            && let Some((_, found, notes)) = self.text_by_tiers(&selector)
            && found.len() == 1
        {
            self.pending_notes.extend(notes);
            keys = found;
        }
        if keys.is_empty() && self.flags.compose {
            // A NAME THAT REACHED NOTHING and names, as it is said, the one row of another kind is
            // that row (`unmatched_target`); anything else is the ask or the decline the runtime
            // composes.
            let name = selector.name.clone().unwrap_or_default();
            // THE STATED KIND RESTRICTS THE NAME (nt13 B1): a call that says where the row goes
            // is for the rows that container holds
            let into = self.destination_kind(verb, extra);
            if let Some(key) = self.unmatched_target(verb, &selector, into) {
                return Ok(Ok(Targets {
                    keys: vec![key.clone()],
                    decided: Some(Decided::OtherKind {
                        name,
                        kind: selector.kinds[0],
                        key,
                    }),
                    by_selector: false,
                }));
            }
            return Ok(Err(self.compose_unmatched_write(verb, &selector, into)));
        }
        if keys.is_empty() {
            let mut outcome = Outcome::text("");
            self.empty(&selector, &mut outcome);
            if !outcome.text.ends_with("nothing was done.") {
                outcome.text.push_str("\nnothing was done.");
            }
            return Ok(Err(outcome));
        }
        self.settle_rows(verb, keys, args, extra, &selector.what())
    }

    /// THE YES TO "PLAN A NEW ONE INSTEAD?" (nt13 R6): the runtime's last turn ended offering to
    /// plan a new event because the one the person moved was cancelled, and this turn's
    /// reschedule is of that same row. It is the create the offer meant: a new event with the old
    /// one's name, length, description and people, on the day the reschedule says (a day with no
    /// time keeps the old time), with `note: planned a new event (the old one is cancelled)`. The
    /// offer is used once, and only by the turn after it. `None` when any of that is not so: the
    /// reschedule is the refusal it was.
    fn plan_anew(
        &mut self,
        key: &Key,
        extra: &Map<String, Value>,
    ) -> Result<Option<Outcome>, String> {
        let offered = self
            .plan_offer
            .as_ref()
            .is_some_and(|(turn, row)| turn + 1 == self.turn && row == key);
        if !offered || !self.flags.normalize || key.0 != Kind::Event {
            return Ok(None);
        }
        let Some(row) = self.world.row(key).cloned() else {
            return Ok(None);
        };
        if row.field("status") != Some(&Val::Enum("cancelled")) {
            return Ok(None);
        }
        let (Some(to), true) = (extra.get("to"), extra.len() == 1) else {
            return Ok(None);
        };
        let expr = self.date_expr(to)?;
        let resolved =
            dates::evaluate(&expr, self.now, row.date).map_err(|why| dates::rejection(&why))?;
        if resolved.is_open() {
            return Ok(None);
        }
        let (resolved, _) = self.settle_by_the_row(&row, &expr, resolved);
        let mut args = Map::new();
        args.insert("name".to_owned(), json!(row.name));
        let mut date = to.clone();
        if !matches!(resolved, dates::Resolved::Between { .. }) {
            let Some(point) = resolved.point() else {
                return Ok(None);
            };
            let point = keep_time(point, row.date);
            date = match point.time {
                Some(time) => json!({"date": point.date.to_string(), "time": dates::clock(time)}),
                None => json!({"date": point.date.to_string()}),
            };
            if point.time.is_some() && row.date.is_some_and(|stamp| stamp.time.is_some()) {
                let (start, end) = event_span(&row);
                args.insert(
                    "duration".to_owned(),
                    json!(end.duration_since(start).as_mins().max(1)),
                );
            }
        }
        args.insert("date".to_owned(), date);
        if let Some(Val::Text(description)) = row.field("description") {
            args.insert("description".to_owned(), json!(description));
        }
        let attendees: Vec<String> = self
            .world
            .neighbours(key)
            .remove(&Kind::Person)
            .unwrap_or_default()
            .into_iter()
            .filter(|person| self.world.row(person).is_some_and(|row| !row.trashed))
            .map(|person| person.1)
            .collect();
        self.plan_offer = None;
        let mut outcome = self.create_with(Some("event"), &args, &attendees)?;
        if outcome.effect.contains_key("diff") {
            self.pending_notes
                .push("note: planned a new event (the old one is cancelled)".to_owned());
        }
        outcome.effect.insert("verb".to_owned(), json!("create"));
        Ok(Some(finish(outcome, false)))
    }

    /// The kind of the container a container verb puts its row in or takes it out of (`add_to
    /// to: #n`, `remove_from from: #n`), when the call names one row.
    fn destination_kind(&self, verb: Verb, extra: &Map<String, Value>) -> Option<Kind> {
        let slot = match verb {
            Verb::AddTo => "to",
            Verb::RemoveFrom => "from",
            _ => return None,
        };
        match self.resolve_rows(extra.get(slot)?).ok()?.as_slice() {
            [only] => Some(only.0),
            _ => None,
        }
    }

    /// WHAT A WRITE DOES WITH THE SEVERAL ROWS ITS SELECTOR (OR A RESULT HANDLE OVER THE CAP,
    /// nt11 R5) REACHED: the one row the person's words and the conversation single out
    /// (`narrow`); every row when the person or the trace says all (the cap holding); else the
    /// one safety check, the ask `Which one?` over the candidates (`--no-compose`: the
    /// `ambiguous:` reply). A write over a handle of more than `ROW_CAP` rows ends exactly as the
    /// same write by the selector that made it. `what` names the rows in the note.
    fn settle_rows(
        &mut self,
        verb: Verb,
        keys: Vec<Key>,
        args: &Map<String, Value>,
        extra: &Map<String, Value>,
        what: &str,
    ) -> Result<Result<Targets, Outcome>, String> {
        // A WRITE THE PERSON (OR THE TRACE) SAYS TAKES EVERY ROW is not narrowed to the one in
        // focus: "unstar all my cousins" is every cousin the selector fits (SPEC §3.3).
        let every = if self.flags.compose {
            self.said_every_row()
        } else {
            None
        };
        if keys.len() > 1
            && every.is_none()
            && let Some((key, why)) = self.narrow(verb, &keys, extra, true)
        {
            self.pending_notes.push(why);
            return Ok(Ok(Targets::of(vec![key])));
        }
        if keys.len() > 1 {
            // The cap holds for every row the person said (SPEC §4.6): over it the turn ends in
            // the runtime's ask, and the same write after a plain yes goes through, whatever the
            // words of that yes say about the rows.
            let over = keys.len() > ROW_CAP;
            if self.flags.compose && (every.is_some() || over) {
                let confirmed =
                    over && self.pending_bulk.is_some() && self.confirmed(verb, &keys, extra);
                if confirmed || (every.is_some() && !over) {
                    if let Some(by) = every {
                        self.pending_notes.push(format!(
                            "note: {} rows fit; the {by} says all, so the write took every one of them.",
                            keys.len()
                        ));
                    }
                    return Ok(Ok(Targets {
                        keys,
                        decided: Some(Decided::EveryFit),
                        by_selector: false,
                    }));
                }
                if every.is_some() {
                    return Ok(Err(self.bulk_ask(verb, &keys, args, extra)));
                }
            }
            // THE ONE SAFETY CHECK (SPEC §3.3), on the call alone.
            if self.flags.compose {
                // a `Which one?` over more than the cap remembers the write, as the cap's own ask
                // does: the person's plain yes ("all of them") in the next turn is that write
                if over {
                    self.pending_bulk = Some(PendingBulk {
                        turn: self.turn,
                        verb,
                        keys: keys.iter().cloned().collect(),
                        args: canonical_json(&Value::Object(extra.clone())),
                    });
                }
                return Ok(Err(self.compose_ambiguous_write(
                    verb,
                    what,
                    &keys,
                    extra,
                    |_| crate::native::compose::WHICH_ONE.to_owned(),
                )));
            }
            return Ok(Err(self.ambiguous_block(what, &keys)));
        }
        Ok(Ok(Targets {
            by_selector: true,
            ..Targets::of(keys)
        }))
    }

    /// A ROW PICKED BY NUMBER THAT THE PERSON'S WORDS DO NOT SINGLE OUT
    /// (SPEC §3.3, the pick path of the one safety check). `act rows=#n` names
    /// one row, but the person said "star pedro" and two people are Pedro: the
    /// model chose, and a guess at a write is the worst case. The runtime ends
    /// the turn as an `ask` with the rows the words fit.
    ///
    /// The words that name the row are the message's words (and the previous
    /// message's: a row named there and only pointed at now is still named)
    /// that are also words of its name (exactly, folded of accents, in another
    /// form, one letter off: "aadhar" for "Aadhaar", "9" for "9B"). The rows
    /// they fit are the live rows of that kind that have every one of them. It
    /// asks only when
    ///
    /// - the call is not already narrowed by its own `where`, `when` or
    ///   `linked_to`: the model has stated what singles the row out;
    /// - at least two of those rows are ones the verb applies to (SPEC §14.1:
    ///   a `complete` on a done task, a `star` on a starred row is not a
    ///   candidate). When exactly one is, it is the row meant: a pick of a row
    ///   the verb cannot change goes to it, with a note;
    /// - the picked row's whole name is not what the message states while
    ///   the others only extend it ("tb test" is not "TB test reading");
    /// - nothing in the message settles which: a date phrase or a plural
    ///   weekday for the row ("saturdays"), an ordinal or "one", "it", "the
    ///   other", a state ("open", "done"), or any other pick word of `PICKED`;
    ///   and
    /// - neither the date nor the focus of the previous turn (`narrow`: rows
    ///   acted on, offered by an `ask`, shown in a short list) leaves one, nor
    ///   does a longer list the previous turn showed that holds the picked
    ///   row and no other row the verb changes: there the model's pick is
    ///   borne out by what the person saw; and
    /// - no lookup of this turn that carried a `where`, a `when` or a
    ///   `linked_to` of its own (`Session::narrowed`) left the picked row, a
    ///   row the verb changes, and no other such row: the model has stated
    ///   what singles it out, as a call with a condition of its own does. A
    ///   lookup by the name alone bears out nothing.
    ///
    /// The ask is over the rows the verb can change (`ask_options`).
    fn ambiguous_pick(
        &mut self,
        verb: Verb,
        keys: &mut Vec<Key>,
        args: &Map<String, Value>,
        extra: &Map<String, Value>,
        by_selector: bool,
    ) -> Option<Outcome> {
        let [key] = keys.as_slice() else {
            return None;
        };
        if matches!(verb, Verb::Create | Verb::Undo) {
            return None;
        }
        if ["where", "when", "linked_to"]
            .iter()
            .any(|param| args.get(*param).is_some_and(|value| !value.is_null()))
        {
            return None;
        }
        let said = self.said();
        let message_words = crate::native::session::words(&self.message);
        // A PERSONAL PRONOUN POINTS AT A ROW IN FOCUS: with none of the picked row's kind there,
        // "it" at the end of a sentence ("star the wifi, i keep needing it") settles nothing.
        let referable = self.focus(false, true).iter().any(|number| {
            self.by_number
                .get(number.wrapping_sub(1))
                .is_some_and(|other| other.0 == key.0)
        });
        if message_words.iter().enumerate().any(|(at, word)| {
            (picks_by_word(&message_words, at) && (referable || !PRONOUNS.contains(&word.as_str())))
                || plural_weekday(word)
        }) || !said.settles_nothing()
        {
            return None;
        }
        // A BY-NAME ACT THAT REACHED ONE ROW BY THE PERSON'S OWN WORDS (SPEC §3.3 (c): a by-name
        // act takes none of these steps): every word of the call's `name` is a word the message
        // says, and the selector alone singled the row out. An over-specific name (a word the
        // person did not say) is still the check's case.
        if by_selector && let Some(name) = arg_str(args, "name") {
            let own: Vec<String> = crate::native::session::words(&name)
                .into_iter()
                .filter(|word| !UNNAMING.contains(&word.as_str()))
                .collect();
            if !own.is_empty()
                && own.iter().all(|word| {
                    message_words.iter().any(|said| {
                        crate::native::resolve::word_near(word, &crate::native::search::fold(said))
                    })
                })
            {
                return None;
            }
        }
        let row = self.world.row(key)?;
        let name_words = crate::native::search::spellings_of(&row.name);
        // A word that extends a name word of four letters or more ("renewal" for "Renew") names
        // it too: "put the passport renewal on it" fits "Renew passport" and not "Get passport photos".
        let names_it = |word: &String| {
            !UNNAMING.contains(&word.as_str())
                && name_words.iter().any(|name| {
                    crate::native::resolve::word_near(name, word)
                        || (name.chars().count() >= 4
                            && word.chars().count() > name.chars().count()
                            && word.starts_with(name.as_str()))
                })
        };
        // A message that names no word of the row ("the driver" answering an
        // ask) names nothing; the message before it only adds to a naming one.
        let now: Vec<String> = message_words
            .iter()
            .map(|word| crate::native::search::fold(word))
            .collect();
        if !now.iter().any(&names_it) {
            return None;
        }
        let mut spoken = now;
        for word in crate::native::session::words(&self.prev_message) {
            let word = crate::native::search::fold(&word);
            if !spoken.contains(&word) {
                spoken.push(word);
            }
        }
        let reference: Vec<String> = spoken
            .iter()
            .filter(|word| names_it(word))
            .cloned()
            .collect();
        let fits: Vec<Key> = self
            .world
            .of_kind(key.0)
            .filter(|other| !other.trashed)
            .filter(|other| {
                let have = crate::native::search::spellings_of(&other.name);
                reference.iter().all(|word| {
                    have.iter()
                        .any(|name| crate::native::resolve::word_near(name, word))
                })
            })
            .map(Row::key)
            .collect();
        if fits.len() < 2 || !fits.contains(key) {
            return None;
        }
        // THE WHOLE NAME, STATED: of the rows that fit, only the picked one is
        // named in full by the words ("tb test"; the others only extend it).
        let named_in_full: Vec<&Key> = fits
            .iter()
            .filter(|other| {
                let Some(row) = self.world.row(other) else {
                    return false;
                };
                // THE NAME OR, FOR A PERSON, THE NICKNAME: a message that states a row's whole
                // nickname ("big dan") singles that row out as its whole name does.
                let nickname = match row.field("nickname") {
                    Some(Val::Text(nickname)) => Some(nickname.as_str()),
                    _ => None,
                };
                std::iter::once(row.name.as_str())
                    .chain(nickname)
                    .any(|alias| {
                        // a word of the name spelled with its joiners or without (`Yun-ho`, `yunho`)
                        let words: Vec<_> = crate::native::search::spoken_tokens(alias)
                            .into_iter()
                            .filter(|token| {
                                token.single().is_none_or(|word| !UNNAMING.contains(&word))
                            })
                            .collect();
                        !words.is_empty()
                            && words.iter().all(|token| {
                                token.is_among(true, |name| {
                                    spoken
                                        .iter()
                                        .any(|word| crate::native::resolve::word_near(name, word))
                                })
                            })
                    })
            })
            .collect();
        if named_in_full == [key] {
            return None;
        }
        let changes: Vec<Key> = self
            .fits(verb, &fits, extra)
            .into_iter()
            .filter_map(|(other, fit)| (fit == Fit::Yes).then_some(other))
            .collect();
        if let [only] = changes.as_slice()
            && only != key
            && self.fits(verb, std::slice::from_ref(key), extra)[0].1 == Fit::No
        {
            // EXACTLY ONE CANDIDATE THE VERB APPLIES TO (R4): it is the row
            // meant, whichever the model picked.
            let n = self.number(only);
            let named = render::named(&self.world, n, only);
            self.pending_notes.push(format!(
                "note: {} rows fit; used {named} because it is the only one {} applies to.",
                fits.len(),
                verb.spec().name
            ));
            *keys = vec![only.clone()];
            return None;
        }
        if changes.len() < 2 || self.narrow(verb, &fits, extra, false).is_some() {
            return None;
        }
        // A PICK OF THE ONE ROW THAT IS NOT OVER: moving or calling off an
        // event that has ended, or a task that is done, is not what a person
        // means when another row of that name is still ahead.
        if matches!(verb, Verb::Reschedule | Verb::Cancel) {
            let ahead: Vec<&Key> = fits
                .iter()
                .filter(|other| self.world.row(other).is_some_and(|row| !self.is_over(row)))
                .collect();
            if ahead == [key] {
                return None;
            }
        }
        // A LOOKUP THE MODEL NARROWED ITSELF: a find of this turn with a `where`, a `when` or a
        // `linked_to` of its own whose result holds the picked row, a row the verb changes, and
        // no other such row. The model has stated what singles the row out, as a call that
        // carries one does; a lookup by the name alone (an over-specific name) bears out nothing.
        let own = changes.contains(key)
            && self.narrowed.iter().any(|(turn, handle)| {
                let result = &self.results[handle - 1].keys;
                *turn == self.turn
                    && result.contains(key)
                    && changes
                        .iter()
                        .all(|other| other == key || !result.contains(other))
            });
        if own {
            return None;
        }
        // A LONGER LIST THE PERSON SAW: the picked row is the one fit in it, of the rows the
        // verb changes.
        let seen = self.focus(false, true);
        let saw = |other: &Key| self.numbers.get(other).is_some_and(|n| seen.contains(n));
        if saw(key) && changes.iter().all(|other| other == key || !saw(other)) {
            return None;
        }
        let what = format!("\"{}\"", reference.join(" "));
        if self.flags.compose {
            return Some(
                self.compose_ambiguous_write(verb, &what, &fits, extra, |options| {
                    format!("which one of the {options} did you mean?")
                }),
            );
        }
        let question = format!("which one of the {} did you mean?", fits.len());
        let mut outcome = self.ambiguous_block(&what, &fits);
        outcome.ends_turn = true;
        outcome.effect.insert(
            "ask".to_owned(),
            json!({"question": question, "options": self.keys_json(&fits)}),
        );
        outcome.effect.insert("tool".to_owned(), json!("ask"));
        self.mark_offered(&fits);
        Some(outcome)
    }

    /// The `ambiguous:` observation: every candidate, nothing done. The reply
    /// lists the first `ROW_CAP` and counts the rest; those are the rows an
    /// `ask` after it offers (`Session::complete_options`), so they are the
    /// rows the person most likely means (`live_first`).
    pub(crate) fn ambiguous_block(&mut self, what: &str, keys: &[Key]) -> Outcome {
        let keys = self.live_first(keys);
        let mut lines = Vec::new();
        let mut names = Vec::new();
        for key in keys.iter().take(ROW_CAP) {
            let n = self.number(key);
            let short = render::named(&self.world, n, key);
            lines.push((vec![n], short.clone()));
            names.push(short);
        }
        let more = keys.len().saturating_sub(ROW_CAP);
        let mut text = format!("ambiguous: {what} fits {}", names.join(", "));
        if more > 0 {
            text.push_str(&format!(" and {more} more"));
        }
        text.push_str("; nothing was done.");
        let mut outcome = Outcome::text("");
        outcome
            .effect
            .insert("ambiguous".to_owned(), self.keys_json(&keys));
        let summary = format!("ambiguous: {what}; nothing was done");
        self.push_obs_with(true, None, summary, text, lines, &mut outcome, true);
        outcome
    }

    /// THE CANDIDATES OF AN AMBIGUITY IN THE ORDER THE REPLY LISTS THEM: the
    /// rows that are not over first (a task not done or cancelled, an event
    /// that has not ended, a row with no date), the nearest to today first, a
    /// row with no date after the dated ones; then the rows that are over, in
    /// the order the selector gave. A long list is cut at `ROW_CAP`, and the
    /// selector's order is oldest first: without this the twelve rows shown
    /// were the oldest completed tasks and the past events, and the row the
    /// person means sat past the cut.
    pub(crate) fn live_first(&self, keys: &[Key]) -> Vec<Key> {
        let today = self.today();
        let (mut live, over): (Vec<Key>, Vec<Key>) = keys
            .iter()
            .cloned()
            .partition(|key| self.world.row(key).is_some_and(|row| !self.is_over(row)));
        live.sort_by_key(|key| {
            let days = self
                .world
                .row(key)
                .and_then(|row| row.date)
                .map(|stamp| (stamp.date - today).get_days().unsigned_abs());
            (days.is_none(), days)
        });
        live.extend(over);
        live
    }

    /// A name that fits several rows is settled only by what the person's
    /// words and the conversation already fix, each step used only if it
    /// leaves rows:
    ///
    /// 0. APPLICABILITY (SPEC §14.1): rows the verb cannot change as they
    ///    stand drop out (`Session::fits`);
    ///
    /// 1. the one date the message states ("cancel the swim class on
    ///    saturday"), for verbs that act on a row where it stands (a bare
    ///    weekday only for `cancel`, which looks ahead);
    ///
    /// 2. FOCUS: the rows the previous turn and this turn have acted on,
    ///    opened, offered in an `ask`, or answered in a short list
    ///    (`Session::focus`: at most `FOCUS_RESULT_MAX` rows; a longer list
    ///    names a row only because it met a condition); exactly one candidate
    ///    in it is the row the person is still talking about.
    ///
    /// The row is returned only when exactly one candidate is left; two or
    /// more stay `ambiguous:` with the full list (SPEC §3.3).
    fn narrow(
        &mut self,
        verb: Verb,
        keys: &[Key],
        extra: &Map<String, Value>,
        own_turn: bool,
    ) -> Option<(Key, String)> {
        let mut cands: Vec<Key> = keys.to_vec();
        let mut why: Vec<String> = Vec::new();
        // 0. APPLICABILITY FIRST (SPEC §14.1): rows the verb cannot change are
        //    not candidates, so a name that fits one open and one done task is
        //    not ambiguous for "tick off". Used only if it leaves rows; two or
        //    more it leaves go on to the steps below.
        let live: Vec<Key> = self
            .fits(verb, &cands, extra)
            .into_iter()
            .filter_map(|(key, fit)| (fit != Fit::No).then_some(key))
            .collect();
        if !live.is_empty() && live.len() < cands.len() {
            cands = live;
            why.push(format!(
                "only that one is a row {} can change",
                verb.spec().name
            ));
        }
        if cands.len() > 1
            && !matches!(verb, Verb::Reschedule | Verb::Create)
            && let Some((day, text)) = self.said().only_day(verb == Verb::Cancel)
        {
            let on: Vec<Key> = cands
                .iter()
                .filter(|key| {
                    self.world
                        .row(key)
                        .and_then(|row| row.date)
                        .is_some_and(|stamp| stamp.date == day)
                })
                .cloned()
                .collect();
            if !on.is_empty() && on.len() < cands.len() {
                cands = on;
                why.push(format!("only that one is on \"{text}\" ({day})"));
            }
        }
        if cands.len() > 1 {
            let focus = self.focus(own_turn, false);
            let seen: Vec<Key> = cands
                .iter()
                .filter(|key| self.numbers.get(*key).is_some_and(|n| focus.contains(n)))
                .cloned()
                .collect();
            if !seen.is_empty() && seen.len() < cands.len() {
                cands = seen;
                why.push("it is the one this conversation was just on".to_owned());
            }
        }
        if cands.len() == 1 && !why.is_empty() {
            let key = cands.remove(0);
            let n = self.number(&key);
            let named = render::named(&self.world, n, &key);
            let what = format!(
                "note: {} rows fit; used {named} because {}.",
                keys.len(),
                why.join(", then ")
            );
            return Some((key, what));
        }
        None
    }

    /// Whether a row is over: an event that has ended, a task that is done or
    /// cancelled.
    fn is_over(&self, row: &Row) -> bool {
        match row.kind {
            Kind::Event => event_span(row).1 < self.now,
            Kind::Task => matches!(
                row.field("status"),
                Some(Val::Enum("completed" | "cancelled"))
            ),
            _ => false,
        }
    }

    /// WHETHER THE VERB CAN CHANGE EACH ROW as it stands (SPEC §14.1): the
    /// verb would leave the row different. `complete` an open task, `restore`
    /// a trashed row, `delete` a live one, `star` an unstarred row, `unstar`
    /// a starred one, `settle_debt` an open debt, and for every other verb the
    /// write's own already-so test: `cancel` an event not cancelled, `add_to`
    /// a row that is not a member, `reopen` a task not open, an `edit` that
    /// changes a field (the pin of a pinned note is no change), `settle_up` a
    /// person with a balance, `reveal` an item that has the field asked for.
    /// The one exception is `reschedule`: a row already at the time asked is
    /// still a candidate, since the person may be re-confirming it. A call
    /// that cannot be planned at all (a malformed argument) is `Unknown`: the
    /// write reports the error, so such a row is neither kept out nor counted.
    fn fits(&mut self, verb: Verb, keys: &[Key], extra: &Map<String, Value>) -> Vec<(Key, Fit)> {
        let mut out = Vec::new();
        for key in keys {
            let Some(row) = self.world.row(key).cloned() else {
                continue;
            };
            let yes = |applies: bool| if applies { Fit::Yes } else { Fit::No };
            let fit = match verb {
                Verb::Complete => {
                    yes(task_stand(verb, status_of(row.field("status"))) == Stand::Changes)
                }
                Verb::Restore => yes(row.trashed),
                Verb::Delete => yes(!row.trashed),
                Verb::Star => yes(!row.starred()),
                Verb::Unstar => yes(row.starred()),
                Verb::SettleDebt => yes(row.field("status") != Some(&Val::Enum("settled"))),
                _ => {
                    // Planning names rows (`named`), which would put them in
                    // the conversation's focus: the filter leaves no trace.
                    let acted = self.acted.clone();
                    let planned = self.plan(verb, &row, extra);
                    self.acted = acted;
                    match planned {
                        Ok(Plan::Run { .. }) => Fit::Yes,
                        // A reschedule to where the row already is stays a
                        // candidate: the person may be re-confirming it.
                        Ok(Plan::Already(_)) if verb == Verb::Reschedule => Fit::Yes,
                        Ok(Plan::Already(_)) => Fit::No,
                        Err(_) => Fit::Unknown,
                    }
                }
            };
            out.push((key.clone(), fit));
        }
        out
    }

    /// THE ROWS A "WHICH ONE?" OFFERS (SPEC §4.8): of the rows a name fits, the ones the verb can
    /// change as they stand (`fits`), so `unstar` is asked over the starred rows and `complete`
    /// over the open ones, and for `cancel` those that are not over too (an event that has ended
    /// is not what a person calls off). When that leaves none, every row stays and the write
    /// reports what it finds. The count is how many rows it left out.
    pub(crate) fn ask_options(
        &mut self,
        verb: Verb,
        keys: &[Key],
        extra: &Map<String, Value>,
    ) -> (Vec<Key>, usize) {
        let mut kept: Vec<Key> = self
            .fits(verb, keys, extra)
            .into_iter()
            .filter_map(|(key, fit)| (fit != Fit::No).then_some(key))
            .collect();
        if verb == Verb::Cancel {
            let ahead: Vec<Key> = kept
                .iter()
                .filter(|key| self.world.row(key).is_some_and(|row| !self.is_over(row)))
                .cloned()
                .collect();
            if !ahead.is_empty() {
                kept = ahead;
            }
        }
        if kept.is_empty() {
            return (keys.to_vec(), 0);
        }
        let left_out = keys.len() - kept.len();
        (kept, left_out)
    }

    fn row_of(&self, key: &Key) -> Result<Row, String> {
        self.world
            .row(key)
            .cloned()
            .ok_or_else(|| "error: that row no longer exists.".to_owned())
    }

    /// `#n "name"` for an observation. A row an observation names is a row
    /// the model may address next (`already:`, `is in the trash`, a refused
    /// write), and one compaction keeps: it joins `acted`.
    fn named(&mut self, key: &Key) -> String {
        let n = self.number(key);
        self.acted.insert(n);
        render::named(&self.world, n, key)
    }

    fn write(
        &mut self,
        verb: Verb,
        targets: &[Key],
        args: &Map<String, Value>,
    ) -> Result<Outcome, String> {
        let mut plans = Vec::new();
        for key in targets {
            if verb.command(key.0).is_none() {
                let kinds: Vec<&str> = verb.kinds().iter().map(|kind| kind.name()).collect();
                let mut refusal = format!(
                    "error: {} does not apply to {}. {} applies to: {}.",
                    verb.spec().name,
                    key.0.plural(),
                    verb.spec().name,
                    kinds.join(", ")
                );
                // A ROW OF THE RIGHT KIND THE WORDS FIT is a repair, not a decline: the model
                // picked the wrong kind (a document where the verb wants a person)
                let fits = self.did_you_mean(&verb.kinds(), key);
                refusal.push_str(&fits);
                if self.flags.compose && fits.is_empty() {
                    return Ok(self.compose_declined_write(
                        verb,
                        key,
                        &refusal,
                        "does_not_apply",
                        "out_of_scope",
                    ));
                }
                return Err(refusal);
            }
            let row = self.row_of(key)?;
            // ONE OCCURRENCE OF A REPEATING EVENT (`World::read_event_window`): the vault changes a
            // series, or an exception to it, and neither is a verb of this runtime yet
            if row.extra.contains_key("series") {
                let name = self.named(key);
                let refusal = format!(
                    "error: {name} is one occurrence of a repeating event; changing a single occurrence is not possible here. Nothing was done."
                );
                if self.flags.compose {
                    return Ok(self.compose_declined_write(
                        verb,
                        key,
                        &refusal,
                        "occurrence",
                        "out_of_scope",
                    ));
                }
                return Err(refusal);
            }
            if row.trashed && !matches!(verb, Verb::Restore | Verb::Delete) {
                let name = self.named(key);
                let refusal =
                    format!("error: {name} is in the trash; restore it first. Nothing was done.");
                if self.flags.compose {
                    return Ok(self.compose_declined_write(
                        verb,
                        key,
                        &refusal,
                        "trashed_target",
                        "not_found",
                    ));
                }
                return Err(refusal);
            }
            // A SECRET THE PERSON DID NOT ASK FOR (nt15 R1s): after a reveal of this item was
            // refused for a field, no other field of it is revealed in the turn unless the
            // person's words name it
            if verb == Verb::Reveal
                && let Some(guarded) = self.reveal_guard(&row, args)
            {
                return guarded;
            }
            let planned = self.plan(verb, &row, args);
            if verb == Verb::Reveal
                && let Err(refusal) = &planned
            {
                self.note_reveal_refusal(&row, args, refusal);
            }
            let plan = match planned {
                // A ROW FOR A CONTAINER OF ANOTHER KIND (a person into an event): nothing can
                // lift it. The sentence is the runtime's own, `plan_membership`'s.
                Err(refusal)
                    if self.flags.compose
                        && refusal.contains(" goes into a ")
                        && !refusal.contains(" Did you mean ") =>
                {
                    return Ok(self.compose_declined_write(
                        verb,
                        key,
                        &refusal,
                        "wrong_container",
                        "out_of_scope",
                    ));
                }
                other => other?,
            };
            plans.push((key.clone(), plan));
        }
        self.execute(verb, plans, None)
    }

    /// Run planned steps, re-read the world, and echo what changed.
    fn execute(
        &mut self,
        verb: Verb,
        plans: Vec<(Key, Plan)>,
        created: Option<Key>,
    ) -> Result<Outcome, String> {
        let before = self.world.clone();
        let mut already = Vec::new();
        let mut already_keys: Vec<Key> = Vec::new();
        let mut already_lines = Vec::new();
        let mut inverses = Vec::new();
        let mut not_undoable = Vec::new();
        let mut notes = Vec::new();
        let mut failure = None;
        let mut touched: Vec<Key> = Vec::new();
        let mut revealed = None;
        // A RESTORE OVER SEVERAL ROWS does not depend on their order: a row past the vault's
        // window is set aside and the others still come back; the set-aside rows are reported
        // (nt9, rule 6), or, when none came back, the first of them ends the turn as before.
        let several = plans.len() > 1;
        let mut set_aside: Vec<(Key, &'static str, Value, Ran, String)> = Vec::new();
        for (key, plan) in plans {
            match plan {
                Plan::Already(state) => {
                    let name = self.named(&key);
                    already_lines.push(format!("already: {name} {state}"));
                    already_keys.push(key.clone());
                    already.push(json!({"kind": key.0.name(), "id": key.1, "n": self.numbers.get(&key), "state": state}));
                }
                Plan::Run {
                    steps,
                    inverse,
                    not_undoable: undoable_note,
                    note,
                } => {
                    let mut outputs = Vec::new();
                    let mut lapsed_row = false;
                    for step in steps {
                        let ran = self.write_step(step.command, &step.input)?;
                        if !ran.ok {
                            if verb == Verb::Restore
                                && several
                                && outputs.is_empty()
                                && before.row(&key).is_some_and(|row| row.trashed)
                            {
                                let name = self.named(&key);
                                let reason = ran.reason.clone().unwrap_or_default();
                                let said = format!(
                                    "error: restore {name} was refused: it is in the trash but past the vault's restore window, so it cannot come back (vault: {reason})."
                                );
                                set_aside.push((
                                    key.clone(),
                                    step.command,
                                    step.input.clone(),
                                    ran,
                                    said,
                                ));
                                lapsed_row = true;
                                break;
                            }
                            // NOTHING HAS LANDED YET, so the runtime can end the
                            // turn itself (D-1044-10): a decline when nothing can
                            // lift the refusal, an ask when the person can still
                            // act on it (`Session::refusal`).
                            if touched.is_empty()
                                && outputs.is_empty()
                                && let Some(ended) = self.refusal(
                                    verb,
                                    &key,
                                    (step.command, &step.input),
                                    &ran,
                                    &before,
                                )
                            {
                                self.settling.clear();
                                return Ok(ended);
                            }
                            let name = self.named(&key);
                            let reason = ran.reason.unwrap_or_default();
                            // RETENTION: the row lists as trashed, so the only
                            // reason the vault refuses to bring it back is
                            // that its restore window has run out. Say that,
                            // so the model tells the person instead of
                            // retrying.
                            let lapsed = verb == Verb::Restore
                                && before.row(&key).is_some_and(|row| row.trashed);
                            failure = Some(if lapsed {
                                format!(
                                    "error: restore {name} was refused: it is in the trash but past the vault's restore window, so it cannot come back (vault: {reason})."
                                )
                            } else {
                                format!("error: {} {name} was refused: {reason}", verb.spec().name)
                            });
                            break;
                        }
                        outputs.push(ran.output);
                    }
                    if lapsed_row {
                        continue;
                    }
                    if failure.is_some() {
                        break;
                    }
                    touched.push(key.clone());
                    if verb == Verb::Delete
                        && key.0 == Kind::Album
                        && let Some(revision) = outputs
                            .first()
                            .and_then(|output| output.get("revision_id"))
                            .and_then(Value::as_str)
                    {
                        inverses.push(Inverse {
                            command: "media.restore_album".to_owned(),
                            input: json!({"album_id": key.1, "revision_id": revision}),
                            key: key.clone(),
                        });
                    }
                    for step in inverse {
                        inverses.push(Inverse {
                            command: step.command.to_owned(),
                            input: step.input,
                            key: key.clone(),
                        });
                    }
                    if let Some(reason) = undoable_note {
                        let name = self.named(&key);
                        not_undoable.push(format!("{name}: {reason}"));
                    }
                    if let Some(note) = note {
                        if verb == Verb::Reveal {
                            // every row a multi-row reveal showed, not just the last
                            revealed = Some(match revealed {
                                Some(prev) => format!("{prev}\n{note}"),
                                None => note.clone(),
                            });
                        }
                        notes.push(note);
                    }
                }
            }
        }
        if touched.is_empty()
            && failure.is_none()
            && let Some((key, command, input, ran, _)) = set_aside.first()
            && let Some(ended) = self.refusal(verb, key, (command, input), ran, &before)
        {
            self.settling.clear();
            return Ok(ended);
        }
        if !set_aside.is_empty() {
            let mut said: Vec<String> = set_aside.into_iter().map(|(.., said)| said).collect();
            said.extend(failure);
            failure = Some(said.join("\n"));
        }
        if let Some(created) = &created {
            touched.push(created.clone());
        }
        self.settle()?;
        let mut diff = diff(&before, &self.world);
        // A SETTLEMENT MOVES A BALANCE, not a row field: the diff carries the
        // person's balance in the settled group (positive = they owe me),
        // before and after, as a `balance` field on the person.
        for (person, group, currency) in std::mem::take(&mut self.settling) {
            let owes = |world: &World| {
                let data = world.tally.balance_data();
                centraid_apps_tally::balance::group_pair_nets(&data, &group)
                    .get(&person.1)
                    .and_then(|row| row.get(&world.me))
                    .copied()
                    .unwrap_or(0)
            };
            let (old, new) = (owes(&before), owes(&self.world));
            if old != new {
                diff.rows.push((
                    person,
                    "updated",
                    json!({
                        "balance": [
                            {"amount": crate::native::world::units(old, &currency), "unit": currency},
                            {"amount": crate::native::world::units(new, &currency), "unit": currency},
                        ],
                    }),
                ));
            }
        }
        let mut lines = Vec::new();
        let mut shown_lines: Vec<(Key, usize, String)> = Vec::new();
        let mut shown_changes: Vec<RowChange> = Vec::new();
        self.mark_acted(&touched);
        self.mark_acted(&already_keys);
        for (shown, key) in touched.iter().enumerate() {
            let n = self.number(key);
            self.acted.insert(n);
            if verb != Verb::Reveal && shown < ROW_CAP {
                let line = self.change_line(verb, &before, key, n);
                shown_lines.push((key.clone(), n, line.clone()));
                shown_changes.extend(self.row_change(verb, &before, key));
                lines.push(line);
            }
        }
        if verb != Verb::Reveal && touched.len() > ROW_CAP {
            // A CONFIRMED BULK WRITE echoes the first `ROW_CAP` rows; the
            // effect lists every one.
            lines.push(format!(
                "… {} more changed (the effect lists every row)",
                touched.len() - ROW_CAP
            ));
        }
        lines.extend(notes.iter().cloned());
        lines.extend(already_lines);
        if let Some(failure) = &failure {
            lines.push(failure.clone());
        }
        if !inverses.is_empty() || !not_undoable.is_empty() {
            self.record(inverses, not_undoable);
        }
        let mut outcome = Outcome::text(lines.join("\n"));
        let diff_json = self.diff_json(&diff);
        outcome.effect.insert("diff".to_owned(), diff_json);
        if !already.is_empty() {
            outcome
                .effect
                .insert("already".to_owned(), Value::Array(already));
        }
        if let Some(failure) = failure {
            outcome.effect.insert("error".to_owned(), json!(failure));
        }
        if let Some(created) = created {
            outcome
                .effect
                .insert("created".to_owned(), self.keys_json(&[created]));
        }
        if verb == Verb::Reveal {
            outcome
                .effect
                .insert("revealed".to_owned(), json!(revealed));
        }
        let more = if verb == Verb::Reveal {
            0
        } else {
            touched.len().saturating_sub(ROW_CAP)
        };
        self.park_call(verb, shown_lines, shown_changes, more);
        Ok(outcome)
    }

    fn record(&mut self, inverses: Vec<Inverse>, not_undoable: Vec<String>) {
        match self.writes.last_mut() {
            Some((turn, list, notes)) if *turn == self.turn => {
                list.extend(inverses);
                notes.extend(not_undoable);
            }
            _ => self.writes.push((self.turn, inverses, not_undoable)),
        }
    }

    /// `created: #31 task "Call plumber" · …` / `completed: #12 … · status open → completed`.
    pub(crate) fn change_line(
        &mut self,
        verb: Verb,
        before: &World,
        key: &Key,
        n: usize,
    ) -> String {
        let after = self.world.row(key).cloned();
        let old = before.row(key).cloned();
        let today = self.today();
        match (&old, &after) {
            (None, Some(row)) => format!("created: {}", render::row_line(n, None, row, today)),
            (Some(row), None) => format!("{}: {} (gone)", verb.spec().done, render::short(n, row)),
            (Some(old), Some(new)) => {
                let mut parts = row_changes(old, new, today)
                    .into_iter()
                    .map(|moved| moved.text)
                    .collect::<Vec<_>>();
                for edge in edge_changes(before, &self.world, key) {
                    let (added, other) = edge;
                    let m = self.number(&other);
                    let name = render::named(&self.world, m, &other);
                    parts.push(if added {
                        format!("now in {name}")
                    } else {
                        format!("no longer in {name}")
                    });
                }
                // a restore shows the text of the row it brings back (nt15 R2a)
                if verb == Verb::Restore {
                    parts.extend(render::text_facts(new));
                }
                let mut line = format!("{}: {}", verb.spec().done, render::short(n, new));
                if parts.is_empty() {
                    line.push_str(" · no field changed");
                } else {
                    for part in parts {
                        line.push_str(" · ");
                        line.push_str(&part);
                    }
                }
                line
            }
            (None, None) => format!("#{n}"),
        }
    }

    /// The facts behind [`Self::change_line`]: the row's kind and title, the fields that moved
    /// (or its starting values, when the call created it) and the links it gained or lost. What a
    /// confirm card says in words; `None` for a row the world does not hold.
    pub(crate) fn row_change(&self, verb: Verb, before: &World, key: &Key) -> Option<RowChange> {
        let today = self.today();
        let new = self.world.row(key);
        let old = before.row(key);
        // THE ROW AS THE MEMBER KNEW IT: a rename is "Change person \"Ray\": name \"Ray\" → …"
        let (row, created) = match (old, new) {
            (None, Some(row)) => (row, true),
            (Some(row), _) => (row, false),
            (None, None) => return None,
        };
        let date_label = row.kind.spec().date.map_or("date", |date| date.label);
        let fields = match (old, new) {
            (Some(old), Some(new)) => row_changes(old, new, today)
                .into_iter()
                .filter(|moved| moved.from.is_some() || moved.to.is_some())
                .map(|moved| FieldChange {
                    field: if moved.field == "date" {
                        date_label.to_owned()
                    } else {
                        moved.field
                    },
                    from: moved.from,
                    to: moved.to,
                })
                .collect(),
            (None, Some(new)) => {
                let mut starting: Vec<FieldChange> = new
                    .date
                    .map(|stamp| FieldChange {
                        field: date_label.to_owned(),
                        from: None,
                        to: Some(render::card_when(stamp, today)),
                    })
                    .into_iter()
                    .collect();
                // a flag that starts off (`starred no`) says nothing the row's being new does not
                starting.extend(new.kind.spec().fields.iter().filter_map(|field| {
                    new.field(field.name)
                        .filter(|value| **value != Val::Bool(false))
                        .map(|value| FieldChange {
                            field: field.name.to_owned(),
                            from: None,
                            to: Some(value.show(Some(field))),
                        })
                }));
                starting
            }
            _ => Vec::new(),
        };
        let links = match (old, new) {
            (Some(_), Some(_)) => edge_changes(before, &self.world, key)
                .into_iter()
                .filter_map(|(added, other)| {
                    let other = self.world.row(&other).or_else(|| before.row(&other))?;
                    Some(LinkChange {
                        added,
                        kind: other.kind.name(),
                        title: other.name.clone(),
                    })
                })
                .collect(),
            _ => Vec::new(),
        };
        Some(RowChange {
            verb: verb.spec().name,
            kind: row.kind.name(),
            title: row.name.clone(),
            created,
            fields,
            links,
        })
    }

    pub(crate) fn diff_json(&mut self, diff: &Diff) -> Value {
        let rows: Vec<Value> = diff
            .rows
            .iter()
            .map(|(key, change, fields)| {
                json!({
                    "kind": key.0.name(),
                    "id": key.1,
                    "n": self.numbers.get(key),
                    "change": change,
                    "fields": fields,
                })
            })
            .collect();
        let links: Vec<Value> = diff
            .links
            .iter()
            .map(|(added, from, to)| {
                json!({
                    "change": if *added { "added" } else { "removed" },
                    "from": {"kind": from.0.name(), "id": from.1},
                    "to": {"kind": to.0.name(), "id": to.1},
                })
            })
            .collect();
        json!({"rows": rows, "links": links})
    }

    /// Plan one verb on one row.
    fn plan(&mut self, verb: Verb, row: &Row, args: &Map<String, Value>) -> Result<Plan, String> {
        let kind = row.kind;
        let id = row.id.clone();
        let target = || json!({ id_param(kind): id.clone() });
        let command = verb.command(kind).unwrap_or_default();
        let check_args = |allowed: &[&str]| -> Result<(), String> {
            for key in args.keys() {
                if !allowed.contains(&key.as_str()) {
                    return Err(format!(
                        "error: {} takes {}; not \"{key}\".",
                        verb.spec().name,
                        if allowed.is_empty() {
                            "no args".to_owned()
                        } else {
                            format!("args {}", allowed.join(", "))
                        }
                    ));
                }
            }
            Ok(())
        };
        let run = |steps: Vec<Step>, inverse: Vec<Step>| Plan::Run {
            steps,
            inverse,
            not_undoable: None,
            note: None,
        };
        Ok(match verb {
            Verb::Complete | Verb::Reopen => {
                check_args(&[])?;
                let old = status_of(row.field("status"));
                let (want, vault) = if verb == Verb::Complete {
                    ("completed", "completed")
                } else {
                    ("open", "needs-action")
                };
                if task_stand(verb, old) == Stand::Already {
                    let when = row
                        .field("completed")
                        .map(|value| format!(" ({})", value.show(None)))
                        .unwrap_or_default();
                    return Ok(Plan::Already(format!("is {want}{when}")));
                }
                let old_vault = Kind::Task
                    .spec()
                    .field("status")
                    .and_then(|field| field.vault_value(old))
                    .unwrap_or("needs-action");
                run(
                    vec![Step {
                        command,
                        input: json!({"task_id": id, "status": vault}),
                    }],
                    vec![Step {
                        command,
                        input: json!({"task_id": id, "status": old_vault}),
                    }],
                )
            }
            Verb::Cancel => {
                check_args(&[])?;
                if row.field("status") == Some(&Val::Enum("cancelled")) {
                    return Ok(Plan::Already("is cancelled".to_owned()));
                }
                Plan::Run {
                    steps: vec![Step {
                        command,
                        input: target(),
                    }],
                    inverse: Vec::new(),
                    not_undoable: Some(
                        "the vault has no command that un-cancels an event".to_owned(),
                    ),
                    note: None,
                }
            }
            Verb::Delete => {
                check_args(&[])?;
                if row.trashed {
                    return Ok(Plan::Already("is in the trash".to_owned()));
                }
                let restore = Verb::Restore.command(kind);
                match (restore, kind) {
                    (Some(restore), _) => {
                        // THE VAULT TAKES A TRASHED PHOTO OUT OF ITS ALBUMS, and
                        // its restore does not put it back, so the undo re-adds
                        // each album after the restore (inverses run last first).
                        let mut inverse: Vec<Step> = if kind == Kind::Photo {
                            self.world
                                .neighbours(&row.key())
                                .remove(&Kind::Album)
                                .unwrap_or_default()
                                .into_iter()
                                .map(|album| Step {
                                    command: "media.add_to_album",
                                    input: json!({"album_id": album.1, "asset_id": id}),
                                })
                                .collect()
                        } else {
                            Vec::new()
                        };
                        inverse.push(Step {
                            command: restore,
                            input: target(),
                        });
                        run(
                            vec![Step {
                                command,
                                input: target(),
                            }],
                            inverse,
                        )
                    }
                    (None, Kind::Album) => run(
                        vec![Step {
                            command,
                            input: target(),
                        }],
                        Vec::new(),
                    ),
                    (None, _) => Plan::Run {
                        steps: vec![Step {
                            command,
                            input: target(),
                        }],
                        inverse: Vec::new(),
                        not_undoable: Some(format!("a deleted {} is gone for good", kind.name())),
                        note: None,
                    },
                }
            }
            Verb::Restore => {
                check_args(&[])?;
                if !row.trashed {
                    return Ok(Plan::Already("is not in the trash".to_owned()));
                }
                let delete = Verb::Delete.command(kind).unwrap_or_default();
                run(
                    vec![Step {
                        command,
                        input: target(),
                    }],
                    vec![Step {
                        command: delete,
                        input: target(),
                    }],
                )
            }
            Verb::Star | Verb::Unstar => {
                check_args(&[])?;
                let want = verb == Verb::Star;
                if row.starred() == want {
                    return Ok(Plan::Already(
                        if want { "is starred" } else { "is not starred" }.to_owned(),
                    ));
                }
                let other = if want { Verb::Unstar } else { Verb::Star };
                let input = |on: bool| {
                    if kind == Kind::Photo {
                        json!({"asset_id": id, "favorite": i64::from(on)})
                    } else {
                        target()
                    }
                };
                run(
                    vec![Step {
                        command,
                        input: input(want),
                    }],
                    vec![Step {
                        command: other.command(kind).unwrap_or_default(),
                        input: input(!want),
                    }],
                )
            }
            Verb::AddTo | Verb::RemoveFrom => self.plan_membership(verb, row, args)?,
            Verb::Log => {
                check_args(&["kind"])?;
                let log = args
                    .get("kind")
                    .map(text_of)
                    .unwrap_or_default()
                    .to_lowercase();
                if !meta::LOG_KINDS.contains(&log.as_str()) {
                    return Err(format!(
                        "error: log takes kind: {}.",
                        meta::LOG_KINDS.join(" · ")
                    ));
                }
                Plan::Run {
                    steps: vec![Step {
                        command,
                        input: json!({"party_id": id, "kind": log}),
                    }],
                    inverse: Vec::new(),
                    not_undoable: Some("a logged interaction stays in the journal".to_owned()),
                    note: None,
                }
            }
            Verb::SettleDebt => {
                check_args(&[])?;
                if row.field("status") == Some(&Val::Enum("settled")) {
                    return Ok(Plan::Already("is settled".to_owned()));
                }
                Plan::Run {
                    steps: vec![Step {
                        command,
                        input: json!({"debt_id": id}),
                    }],
                    inverse: Vec::new(),
                    not_undoable: Some("the vault has no command that unsettles a debt".to_owned()),
                    note: None,
                }
            }
            Verb::SettleUp => self.plan_settle_up(row, args)?,
            Verb::Reveal => self.plan_reveal(row, args)?,
            Verb::Reschedule => self.plan_reschedule(row, args)?,
            Verb::Edit => self.plan_edit(row, args)?,
            Verb::Create | Verb::Undo => unreachable!("handled by the caller"),
        })
    }

    fn plan_membership(
        &mut self,
        verb: Verb,
        row: &Row,
        args: &Map<String, Value>,
    ) -> Result<Plan, String> {
        let slot = if verb == Verb::AddTo { "to" } else { "from" };
        for key in args.keys() {
            if key != slot {
                return Err(format!(
                    "error: {} takes {slot}: #n, not \"{key}\".",
                    verb.spec().name
                ));
            }
        }
        // NO `from`: the one container of that kind the row is in (nt12 R4)
        let mut by_default = false;
        let containers = match args.get(slot) {
            Some(value) => self.resolve_rows(value)?,
            None if verb == Verb::RemoveFrom && self.flags.normalize => {
                let expected = container_of(row.kind).unwrap_or(Kind::Group);
                let inside = self
                    .world
                    .neighbours(&row.key())
                    .remove(&expected)
                    .unwrap_or_default();
                let [only] = inside.as_slice() else {
                    return Err(format!("error: {} needs {slot}: #n.", verb.spec().name));
                };
                by_default = true;
                vec![only.clone()]
            }
            None => return Err(format!("error: {} needs {slot}: #n.", verb.spec().name)),
        };
        let [container] = containers.as_slice() else {
            return Err(format!("error: {slot} is exactly one #n."));
        };
        let expected = container_of(row.kind).unwrap_or(Kind::Group);
        // A DESTINATION OF A KIND THAT CANNOT HOLD THE ROW whose name is the name of exactly one
        // container that can (nt13 R4) is that container: the Send of "Did you mean" would change
        // only the destination to the same-named container, which is no guess
        let mut redirected: Option<String> = None;
        let mut container = container.clone();
        if container.0 != expected
            && self.flags.normalize
            && let Some(name) = self.world.row(&container).map(|row| row.name.clone())
        {
            let found = self.resolve_name(&name, &[expected], false, None);
            if matches!(
                found.tier,
                Some(crate::native::resolve::Tier::Equal | crate::native::resolve::Tier::Words)
            ) && let [only] = found.matches.as_slice()
            {
                container = only.clone();
                let n = self.number(&container);
                redirected = Some(format!(
                    "note: used {}",
                    render::named(&self.world, n, &container)
                ));
            }
        }
        let container = &container;
        if container.0 != expected {
            let fits = self.did_you_mean(&[expected], container);
            return Err(format!(
                "error: a {} goes into a {}, and {} is a {}.{fits}",
                row.kind.name(),
                expected.name(),
                self.named(container),
                container.0.name()
            ));
        }
        let key = row.key();
        let inside = self.world.linked(&key, container);
        let name = self.named(container);
        if verb == Verb::AddTo && inside {
            return Ok(Plan::Already(format!("is already in {name}")));
        }
        if verb == Verb::RemoveFrom && !inside {
            return Ok(Plan::Already(format!("is not in {name}")));
        }
        let id = row.id.clone();
        let cid = container.1.clone();
        // Where a one-place kind (note, document, task) sits now, for undo.
        let current = self
            .world
            .neighbours(&key)
            .get(&expected)
            .and_then(|keys| keys.first().cloned());
        let place = |at: Option<&Key>| -> Step {
            match row.kind {
                Kind::Note => Step {
                    command: "knowledge.move_note",
                    input: match at {
                        Some(at) => json!({"note_id": id, "notebook_id": at.1}),
                        None => json!({"note_id": id}),
                    },
                },
                Kind::Document => Step {
                    command: "core.move_document",
                    input: match at {
                        Some(at) => json!({"document_id": id, "folder_id": at.1}),
                        None => json!({"document_id": id}),
                    },
                },
                _ => Step {
                    command: "schedule.organize_task",
                    input: match at {
                        Some(at) => json!({"task_id": id, "project_id": at.1, "sort_order": 0}),
                        None => json!({"task_id": id, "clear_project": true, "sort_order": 0}),
                    },
                },
            }
        };
        let pair = |command: &'static str| -> Step {
            let input = match row.kind {
                Kind::Person => json!({"group_id": cid, "party_id": id}),
                _ => json!({"album_id": cid, "asset_id": id}),
            };
            Step { command, input }
        };
        let mut planned = match row.kind {
            Kind::Person | Kind::Photo => {
                let (add, remove) = if row.kind == Kind::Person {
                    ("tally.add_group_member", "tally.remove_group_member")
                } else {
                    ("media.add_to_album", "media.remove_from_album")
                };
                if verb == Verb::AddTo {
                    Plan::Run {
                        steps: vec![pair(add)],
                        inverse: vec![pair(remove)],
                        not_undoable: None,
                        note: None,
                    }
                } else {
                    Plan::Run {
                        steps: vec![pair(remove)],
                        inverse: vec![pair(add)],
                        not_undoable: None,
                        note: None,
                    }
                }
            }
            _ => {
                let to = if verb == Verb::AddTo {
                    Some(container)
                } else {
                    None
                };
                Plan::Run {
                    steps: vec![place(to)],
                    inverse: vec![place(current.as_ref())],
                    not_undoable: None,
                    note: None,
                }
            }
        };
        if let Some(said) = redirected
            && let Plan::Run { note, .. } = &mut planned
        {
            *note = Some(said);
        }
        if by_default && let Plan::Run { note, .. } = &mut planned {
            *note = Some(format!(
                "note: used {slot} {name} (the only {} it is in)",
                expected.name()
            ));
        }
        Ok(planned)
    }

    /// ` Did you mean #7 task "Lease review"?`: the live rows of `kinds` (the kinds the verb, the
    /// container or the slot wants) that the name of `wrong`, a row of another kind, reaches by
    /// a word, at most three; nothing when none. A refusal for a wrong-kind row ends in it, so
    /// the model can send the right row instead (SPEC §5).
    fn did_you_mean(&mut self, kinds: &[Kind], wrong: &Key) -> String {
        let Some(name) = self.world.row(wrong).map(|row| row.name.clone()) else {
            return String::new();
        };
        let fits: Vec<Key> = crate::native::search::name_reach(self, &name, kinds)
            .into_iter()
            .filter(|key| key != wrong && self.world.row(key).is_some_and(|row| !row.trashed))
            .take(3)
            .collect();
        if fits.is_empty() {
            return String::new();
        }
        let named: Vec<String> = fits
            .iter()
            .map(|key| {
                let n = self.number(key);
                render::named(&self.world, n, key)
            })
            .collect();
        format!(" Did you mean {}?", named.join(" or "))
    }

    fn plan_settle_up(&mut self, row: &Row, args: &Map<String, Value>) -> Result<Plan, String> {
        for key in args.keys() {
            if key != "group" && key != "amount" {
                return Err(format!(
                    "error: settle_up takes group: #n and amount: N, not \"{key}\"."
                ));
            }
        }
        if row.id == self.world.me {
            return Err("error: settle_up is with someone else, not you.".to_owned());
        }
        // NO GROUP: the one group in which this person and you have a balance (nt12 R4)
        let mut by_default: Option<Key> = None;
        let groups = match args.get("group") {
            Some(group) => self.resolve_rows(group)?,
            None if self.flags.normalize => {
                let held = self.groups_holding_balance(row);
                let [only] = held.as_slice() else {
                    return Err("error: settle_up needs group: #n.".to_owned());
                };
                by_default = Some(only.clone());
                held
            }
            None => return Err("error: settle_up needs group: #n.".to_owned()),
        };
        let [group] = groups.as_slice() else {
            return Err("error: group is exactly one #n.".to_owned());
        };
        if group.0 != Kind::Group {
            let name = self.named(group);
            let fits = self.did_you_mean(&[Kind::Group], group);
            return Err(format!(
                "error: group: names a group, and {name} is not one.{fits}"
            ));
        }
        let currency = self
            .world
            .row(group)
            .and_then(|row| row.extra.get("currency").cloned())
            .unwrap_or_else(|| self.world.currency.clone());
        let data = self.world.tally.balance_data();
        let pair = centraid_apps_tally::balance::group_pair_nets(&data, &group.1);
        let me = self.world.me.clone();
        let owes = pair
            .get(&row.id)
            .and_then(|row| row.get(&me))
            .copied()
            .unwrap_or(0);
        let amount = match args.get("amount") {
            Some(value) => {
                let given = text_of(value);
                whr::symbol_conflict(&given, &currency)?;
                let number = whr::parse_amount(&given)
                    .ok_or_else(|| "error: amount is a number in currency units.".to_owned())?;
                Some(minor_of(number, &currency))
            }
            None => None,
        };
        if owes == 0 && amount.is_none() {
            let name = self.named(group);
            return Ok(Plan::Already(format!(
                "is settled up in {name} (balance {})",
                crate::native::world::money(0, &currency)
            )));
        }
        let (from, to) = if owes >= 0 {
            (row.id.clone(), me)
        } else {
            (me, row.id.clone())
        };
        let amount = amount.unwrap_or(owes.abs());
        if amount <= 0 {
            return Err("error: amount is more than zero.".to_owned());
        }
        self.settling
            .push((row.key(), group.1.clone(), currency.clone()));
        Ok(Plan::Run {
            steps: vec![Step {
                command: "tally.settle_up",
                input: json!({
                    "from_party": from,
                    "to_party": to,
                    "amount_minor": amount,
                    "currency": currency,
                    "group_id": group.1,
                    "paid_on": self.today().to_string(),
                }),
            }],
            inverse: Vec::new(),
            not_undoable: Some("a settlement is real cash and stays recorded".to_owned()),
            note: Some(format!(
                "settlement: {} paid {}{}",
                crate::native::world::money(amount, &currency),
                if owes >= 0 { "to you" } else { "by you" },
                by_default.map_or_else(String::new, |key| format!(
                    "\nnote: used group {} (the only group with a balance between you and {})",
                    self.named(&key),
                    row.name
                ))
            )),
        })
    }

    /// The groups in which `person` and you have a balance.
    fn groups_holding_balance(&self, person: &Row) -> Vec<Key> {
        let data = self.world.tally.balance_data();
        let me = self.world.me.clone();
        self.world
            .rows
            .values()
            .filter(|group| group.kind == Kind::Group && !group.trashed)
            .filter(|group| {
                centraid_apps_tally::balance::group_pair_nets(&data, &group.id)
                    .get(&person.id)
                    .and_then(|owed| owed.get(&me))
                    .is_some_and(|net| *net != 0)
            })
            .map(Row::key)
            .collect()
    }

    /// Whether the person's message names the secret `field` (`password`, `code`, `notes`): by
    /// its own name or one of the other names the runtime reads for it (`meta::reveal_names`).
    pub(crate) fn message_names_secret(&self, field: &str) -> bool {
        let field = if field == "notes" { "content" } else { field };
        let said = format!(
            " {} ",
            crate::native::search::fold_words(&self.message).join(" ")
        );
        meta::reveal_names(field).iter().any(|name| {
            let folded = crate::native::search::fold_words(name).join(" ");
            said.contains(&format!(" {folded} ")) || said.contains(&format!(" {folded}s "))
        })
    }

    /// A reveal refused for a field the item lacks or the runtime does not know is remembered
    /// for the turn (`reveal_guard`).
    fn note_reveal_refusal(&mut self, row: &Row, args: &Map<String, Value>, refusal: &str) {
        let field_refusal = refusal.starts_with("error: reveal takes field: one of")
            || (refusal.contains(" has no ") && refusal.contains(" It holds: "));
        let asked = args
            .get("field")
            .map(text_of)
            .unwrap_or_default()
            .trim()
            .trim_matches('"')
            .to_lowercase();
        if field_refusal && !asked.is_empty() {
            self.reveal_refused.push((self.turn, row.key(), asked));
        }
    }

    /// THE SMALLEST RULE THAT MAKES "ASKED FOR X, REVEALED Y" IMPOSSIBLE (nt15 R1s): once a
    /// reveal of an item was refused in this turn for a field it does not keep (or the runtime
    /// does not know: `2fa` on a login with no code, `pin`) and the person's message asked for
    /// that field (`asked_by_message`), a reveal of a DIFFERENT secret of that item is not made
    /// unless the message names it, by its own name or one the runtime reads for it
    /// (`message_names_secret`). A field the message never named was the model's guess, and the
    /// repair to what the item holds goes through. The turn ends in an ask that lists what the
    /// item holds (`Which one do you want: password or code?`), or, with `--no-compose`, in an
    /// error that names the field asked for first. A reveal the message names, and a repeat of
    /// the field refused, are as they were.
    fn reveal_guard(
        &mut self,
        row: &Row,
        args: &Map<String, Value>,
    ) -> Option<Result<Outcome, String>> {
        let asked = args
            .get("field")
            .map(text_of)?
            .trim()
            .trim_matches('"')
            .to_lowercase();
        let is_note = row.field("type") == Some(&Val::Enum("note"));
        let lookup = if asked == "notes" && is_note {
            "content"
        } else {
            asked.as_str()
        };
        // only a secret the item really keeps can be the one revealed instead
        let (_, column) = meta::REVEAL_FIELDS
            .iter()
            .find(|(name, _)| *name == lookup)?;
        row.extra.get(*column)?;
        let key = row.key();
        let first = self
            .reveal_refused
            .iter()
            .find(|(turn, at, said)| *turn == self.turn && *at == key && *said != asked)?
            .2
            .clone();
        if self.message_names_secret(&asked) || !self.asked_by_message(&first) {
            return None;
        }
        let name = self.named(&key);
        let held = Self::held_secrets(row);
        if !self.flags.compose {
            return Some(Err(format!(
                "error: {first} was asked for first, and {name} does not keep it; {asked} is another secret, so it is not revealed. {name} holds: {}.",
                held.join(", ")
            )));
        }
        let question = match held.as_slice() {
            [only] => format!("Do you want the {only}?"),
            _ => format!("Which one do you want: {}?", held.join(" or ")),
        };
        let lead =
            format!("not revealed: {first} was asked for first, and {name} does not keep it");
        let mut outcome = self.ends_in_ask(
            Some(lead),
            &question,
            std::slice::from_ref(&key),
            "the runtime ended the turn: another secret than the one asked for is not revealed",
        );
        outcome.effect.insert(
            "reveal_guard".to_owned(),
            json!({"asked": first, "not_revealed": asked}),
        );
        Some(Ok(crate::native::compose::marked(
            outcome,
            "reveal_other_field",
            "ask_fields",
        )))
    }

    /// The secrets a locker item holds, by the field names `reveal` takes (`content` is also
    /// read as `notes` on a note item).
    fn held_secrets(row: &Row) -> Vec<&'static str> {
        meta::REVEAL_FIELDS
            .iter()
            .filter(|(_, column)| row.extra.contains_key(column))
            .map(|(name, _)| *name)
            .collect()
    }

    /// Whether the person's message asks for `field` as a secret: it names it by its own name or
    /// a synonym (`message_names_secret`), or says the word the call used (`pin`). A field the
    /// message does not name was the model's guess, and a repair of it is no secret the person
    /// ruled out (`reveal_guard`).
    fn asked_by_message(&self, field: &str) -> bool {
        let field = field.trim().trim_matches('"').to_lowercase();
        let said = format!(
            " {} ",
            crate::native::search::fold_words(&self.message).join(" ")
        );
        let own = crate::native::search::fold_words(&field).join(" ");
        let meant = meta::REVEAL_FIELDS
            .iter()
            .find(|(name, _)| *name == field)
            .map(|(name, _)| *name)
            .or_else(|| meta::reveal_synonym(&field));
        said.contains(&format!(" {own} "))
            || meant.is_some_and(|meant| self.message_names_secret(meant))
    }

    fn plan_reveal(&mut self, row: &Row, args: &Map<String, Value>) -> Result<Plan, String> {
        for key in args.keys() {
            if key != "field" {
                return Err(format!("error: reveal takes field: …, not \"{key}\"."));
            }
        }
        let field = args
            .get("field")
            .map(text_of)
            .unwrap_or_default()
            .to_lowercase();
        // A note item's notes are its sealed content.
        let is_note = row.field("type") == Some(&Val::Enum("note"));
        let lookup = if field == "notes" && is_note {
            "content"
        } else {
            field.as_str()
        };
        let Some(column) = meta::REVEAL_FIELDS
            .iter()
            .find(|(name, _)| *name == lookup)
            .map(|(_, column)| *column)
        else {
            // nt15 R1d: the fields THIS ROW holds, not a generic list
            let held = Self::held_secrets(row);
            let item = match row.field("type") {
                Some(Val::Enum(kind)) => (*kind).replace('_', " "),
                _ => "item".to_owned(),
            };
            let shown = field.trim().trim_matches('"');
            return Err(format!(
                "error: reveal takes field: one of this {item}'s secrets, not \"{shown}\". this {item} {}.",
                if held.is_empty() {
                    "holds no secrets".to_owned()
                } else {
                    format!("holds: {}", held.join(", "))
                }
            ));
        };
        let key = row.key();
        let Some(sealed) = row.extra.get(column).cloned() else {
            let name = self.named(&key);
            let has = Self::held_secrets(row);
            return Err(format!(
                "error: {name} has no {field}. It holds: {}.{}",
                if has.is_empty() {
                    "no secrets".to_owned()
                } else {
                    has.join(", ")
                },
                // the one it holds is offered to send only when the person's words name it: a
                // secret they did not ask for is never the suggestion (nt15 R1s)
                match has.as_slice() {
                    [only] if self.message_names_secret(only) || !self.asked_by_message(&field) => {
                        format!(" Send reveal field: {only}.")
                    }
                    _ => String::new(),
                }
            ));
        };
        let key_id = row.extra.get("key_id").cloned().unwrap_or_default();
        let secret = self
            .door
            .unseal(&key_id, &row.id, &sealed)
            .map_err(|error| format!("error: this seat cannot open the secret: {error}"))?;
        let name = self.named(&key);
        Ok(Plan::Run {
            steps: vec![Step {
                command: "locker.reveal_receipt",
                input: json!({
                    "object_type": "locker.item",
                    "item_id": row.id,
                    "columns": [column],
                    "kind": "reveal",
                    "allowed": true,
                }),
            }],
            inverse: Vec::new(),
            not_undoable: None,
            note: Some(format!("revealed: {name} · {field}: {secret}")),
        })
    }

    fn plan_reschedule(&mut self, row: &Row, args: &Map<String, Value>) -> Result<Plan, String> {
        for key in args.keys() {
            if key != "to" {
                return Err(format!(
                    "error: reschedule takes to: <date expression>, not \"{key}\"."
                ));
            }
        }
        let to = args
            .get("to")
            .ok_or_else(|| dates::rejection("reschedule needs to: <date expression>"))?;
        let expr = self.date_expr(to)?;
        let resolved =
            dates::evaluate(&expr, self.now, row.date).map_err(|why| dates::rejection(&why))?;
        if resolved.is_open() {
            return Err(format!(
                "error: reschedule needs a day, an instant or a closed span; {} is open-ended.",
                resolved.echo()
            ));
        }
        let (resolved, said) = self.settle_by_the_row(row, &expr, resolved);
        let said = (!said.is_empty()).then(|| said.join("\n"));
        match row.kind {
            Kind::Task => {
                let (point, started) = match resolved.point() {
                    Some(point) => (point, None),
                    None => self
                        .first_day_of(resolved)
                        .map(|(point, note)| (point, Some(note)))
                        .ok_or_else(|| {
                            format!(
                                "error: a task is due at one day or instant; {} is a range.",
                                resolved.echo()
                            )
                        })?,
                };
                let said = match (said, started) {
                    (Some(said), Some(note)) => Some(format!("{said}\n{note}")),
                    (said, note) => said.or(note),
                };
                let point = keep_time(point, row.date);
                if row.date == Some(point) {
                    return Ok(Plan::Already(format!("is already due {}", point.show())));
                }
                let inverse = match row.date {
                    Some(old) => json!({"task_id": row.id, "due_at": old.vault()}),
                    None => json!({"task_id": row.id, "clear_due": true}),
                };
                Ok(Plan::Run {
                    steps: vec![Step {
                        command: "schedule.edit_task",
                        input: json!({"task_id": row.id, "due_at": point.vault()}),
                    }],
                    inverse: vec![Step {
                        command: "schedule.edit_task",
                        input: inverse,
                    }],
                    not_undoable: None,
                    note: said,
                })
            }
            Kind::Event => {
                let (old_start, old_end) = event_span(row);
                let (start, end) = match resolved {
                    dates::Resolved::Between { from, to } => (from, to),
                    other => {
                        let point = other.point().ok_or_else(|| {
                            format!(
                                "error: an event moves to one day, one instant or a from/to span; {} is a range.",
                                other.echo()
                            )
                        })?;
                        let point = keep_time(point, row.date);
                        let start = point.at();
                        let length = old_end.duration_since(old_start);
                        (start, start.checked_add(length).unwrap_or(start))
                    }
                };
                if start == old_start && end == old_end {
                    return Ok(Plan::Already(format!(
                        "is already at {}",
                        row.date.map(Stamp::show).unwrap_or_default()
                    )));
                }
                let spell = |at: jiff::civil::DateTime| {
                    format!("{}T{}:00", at.date(), dates::clock(at.time()))
                };
                Ok(Plan::Run {
                    steps: vec![Step {
                        command: "schedule.reschedule_event",
                        input: json!({"event_id": row.id, "dtstart": spell(start), "dtend": spell(end)}),
                    }],
                    inverse: vec![Step {
                        command: "schedule.reschedule_event",
                        input: json!({"event_id": row.id, "dtstart": spell(old_start), "dtend": spell(old_end)}),
                    }],
                    not_undoable: None,
                    note: said,
                })
            }
            other => Err(format!(
                "error: reschedule does not apply to {}. reschedule applies to: task, event.",
                other.plural()
            )),
        }
    }

    /// WHAT THE ROW SETTLES OF A RESCHEDULE'S CLOCK (SPEC §14.1, "time only" and "at N"):
    /// the message names a time and no day, so the row keeps its day (a call that is not
    /// anchored on the row and puts another day, the model's today, is moved back to the row's);
    /// and a bare hour from 1 to 8 of a row that is at an afternoon or evening time is the
    /// afternoon or evening reading (19:00 and "to 8" is 20:00) when the call wrote the early one;
    /// every other time a call states stays. A day the message states otherwise is the call's own.
    fn settle_by_the_row(
        &self,
        row: &Row,
        expr: &dates::Expr,
        resolved: dates::Resolved,
    ) -> (dates::Resolved, Vec<String>) {
        let (Some(stamp), dates::Resolved::At(mut at)) = (row.date, resolved) else {
            return (resolved, Vec::new());
        };
        // "SAME TIME" keeps the row's time: the call states another one, the message states none
        if let Some(clock) = stamp.time
            && at.time() != clock
            && !dates::uses_row(expr)
            && self.said_same_time()
        {
            at = at.date().to_datetime(clock);
            return (
                dates::Resolved::At(at),
                vec![format!(
                    "date: \"same time\" keeps the row's time ({}).",
                    dates::clock(clock)
                )],
            );
        }
        let Some(words) = self.time_words() else {
            return (resolved, Vec::new());
        };
        let mut notes = Vec::new();
        if words.day_less && !dates::uses_row(expr) && at.date() != stamp.date {
            at = stamp.date.to_datetime(at.time());
            notes.push(format!(
                "date: \"{}\" names no day; kept the row's day ({}).",
                words.phrase, stamp.date
            ));
        }
        // an hour from 1 to 8 reads as the afternoon or evening (SPEC at_n); the call wrote the
        // early reading for a row that is in the afternoon or evening: the row's clock decides
        if let (Some((am, pm)), Some(clock)) = (words.bare, stamp.time)
            && clock.hour() >= 12
            && crate::native::phrases::at_hour(am.hour(), None, Some(clock)).0 == pm.hour()
            && at.time() == am
        {
            at = at.date().to_datetime(pm);
            notes.push(format!(
                "date: \"{}\" is {} or {}; the row is at {}; used {} (the row's own time decides: an hour from 1 to 8 is the afternoon or evening).",
                words.phrase,
                dates::clock(pm),
                dates::clock(am),
                dates::clock(clock),
                dates::clock(pm),
            ));
        }
        (dates::Resolved::At(at), notes)
    }

    /// nt14 N5: a task's due date given as a closed range (a month, a week) is the range's first
    /// day, with `note: read 2026-10-01..2026-10-31 as its first day, Thu 2026-10-01`. Off under
    /// `--no-normalize`; events and every other kind keep the refusal of a range.
    fn first_day_of(&self, resolved: dates::Resolved) -> Option<(dates::Stamp, String)> {
        if !self.flags.normalize {
            return None;
        }
        let day = resolved.first_day()?;
        let note = format!(
            "note: read {} as its first day, {}",
            resolved.echo(),
            day.show()
        );
        Some((day, note))
    }

    /// `body+: text` and `description+: text` of an `edit`: the field's new value is the text it
    /// has with `text` added at the end (`appended`), so an add never overwrites text the model
    /// did not see. Any other field takes no `+`.
    fn append_args(row: &Row, args: &Map<String, Value>) -> Result<Map<String, Value>, String> {
        if !args.keys().any(|key| key.ends_with('+')) {
            return Ok(args.clone());
        }
        let kind = row.kind;
        let mut out = Map::new();
        for (key, value) in args {
            let Some(base) = key.strip_suffix('+').map(str::trim) else {
                out.insert(key.clone(), value.clone());
                continue;
            };
            let holds_text = matches!(base, "body" | "description")
                && kind
                    .spec()
                    .field(base)
                    .is_some_and(|field| field.edit.is_some());
            if !holds_text {
                return Err(format!(
                    "error: only a body or a description takes +: (text added to the end); {} editable fields: {}.",
                    kind.name(),
                    editable(kind)
                ));
            }
            if args.contains_key(base) {
                return Err(format!(
                    "error: {base} and {base}+ in one edit; {base}+: adds, {base}: replaces."
                ));
            }
            let added = text_of(value);
            if added.trim().is_empty() {
                return Err(format!("error: {base}+ needs the text to add."));
            }
            let have = match row.field(base) {
                Some(Val::Text(text)) => text.as_str(),
                _ => "",
            };
            out.insert(base.to_owned(), json!(appended(have, &added)));
        }
        Ok(out)
    }

    fn plan_edit(&mut self, row: &Row, args: &Map<String, Value>) -> Result<Plan, String> {
        let kind = row.kind;
        let spec = kind.spec();
        if args.is_empty() {
            return Err(format!(
                "error: edit needs field: value lines. {} editable fields: {}.",
                kind.name(),
                editable(kind)
            ));
        }
        // THE APPEND FORM (nt15 R2b): `body+: oat milk` adds to the text the row has
        let appended = Self::append_args(row, args)?;
        let args = &appended;
        let id_key = id_param(kind);
        // command → (input, inverse input)
        let mut forward: BTreeMap<&'static str, Map<String, Value>> = BTreeMap::new();
        let mut backward: BTreeMap<&'static str, Map<String, Value>> = BTreeMap::new();
        let mut changed = false;
        let mut not_undoable = None;
        for (field, value) in args {
            let field = field.as_str();
            if field == "name" {
                let name = text_of(value);
                if name.trim().is_empty() {
                    return Err("error: name cannot be empty.".to_owned());
                }
                let (command, param) = rename(kind);
                changed |= name != row.name;
                forward
                    .entry(command)
                    .or_default()
                    .insert(param.to_owned(), json!(name));
                backward
                    .entry(command)
                    .or_default()
                    .insert(param.to_owned(), json!(row.name));
                continue;
            }
            if field == "date" {
                return Err(
                    "error: a date changes with reschedule (to: <date expression>), not edit."
                        .to_owned(),
                );
            }
            let Some(spec_field) = spec.field(field) else {
                return Err(format!(
                    "error: {} have no field \"{field}\". {} editable fields: {}.{}",
                    kind.plural(),
                    kind.name(),
                    editable(kind),
                    whr::field_fix(kind, field, whr::FieldUse::Edit)
                ));
            };
            let Some(command) = spec_field.edit else {
                let hint = match (kind, field) {
                    (_, "starred") => "use star or unstar".to_owned(),
                    (Kind::Event, "status") => "use cancel".to_owned(),
                    (Kind::Task, "completed") => "use complete or reopen".to_owned(),
                    _ => format!("{} editable fields: {}", kind.name(), editable(kind)),
                };
                return Err(format!("error: {field} cannot be edited; {hint}."));
            };
            let old = row.field(field).cloned();
            let (new_json, new_val) = match spec_field.ty {
                FieldType::Text => {
                    let text = text_of(value);
                    (
                        json!(text),
                        (!text.is_empty()).then(|| Val::Text(text.clone())),
                    )
                }
                FieldType::Number => {
                    let number = whr::number_arg(spec_field, &text_of(value))?;
                    (json!(number), Some(Val::Num(number)))
                }
                FieldType::Bool => {
                    let given = text_of(value);
                    let on =
                        whr::parse_bool(&given).ok_or_else(|| whr::bool_error(field, &given))?;
                    (json!(i64::from(on)), Some(Val::Bool(on)))
                }
                FieldType::Enum => {
                    let model = whr::enum_value(kind, field, &text_of(value))?;
                    let vault = spec_field.vault_value(model).unwrap_or(model);
                    (json!(vault), Some(Val::Enum(model)))
                }
                FieldType::Money | FieldType::Date => {
                    return Err(format!("error: {field} cannot be edited."));
                }
            };
            let normalised_old = match &old {
                Some(Val::Bool(false)) if spec_field.ty == FieldType::Bool => {
                    Some(Val::Bool(false))
                }
                other => other.clone(),
            };
            if new_val != normalised_old {
                changed = true;
            }
            let (param, old_json) = match (kind, field) {
                (Kind::Person, "cadence") => (
                    "cadence_days",
                    old.as_ref().map(Val::json).unwrap_or(json!(0)),
                ),
                (Kind::Task, "status") => (
                    "status",
                    json!(match &old {
                        Some(Val::Enum(model)) =>
                            spec_field.vault_value(model).unwrap_or("needs-action"),
                        _ => "needs-action",
                    }),
                ),
                (Kind::Task, "effort") => {
                    ("effort_min", old.as_ref().map_or(Value::Null, Val::json))
                }
                (Kind::Task, "priority") => ("priority", old.as_ref().map_or(json!(0), Val::json)),
                (Kind::Note, "body") => ("body_text", old.as_ref().map_or(Value::Null, Val::json)),
                (Kind::Note, "pinned") => {
                    ("pinned", json!(i64::from(old == Some(Val::Bool(true)))))
                }
                (Kind::Event, "duration") => ("dtend", Value::Null),
                (_, name) => (name, old.as_ref().map_or(json!(""), Val::json)),
            };
            if kind == Kind::Event && field == "duration" {
                let (start, end) = event_span(row);
                let minutes = new_json.as_i64().unwrap_or(60).max(1);
                let new_end = jiff::Span::new()
                    .try_minutes(minutes)
                    .and_then(|span| start.checked_add(span))
                    .map_err(|_| "error: that duration is out of range.".to_owned())?;
                let spell = |at: jiff::civil::DateTime| {
                    format!("{}T{}:00", at.date(), dates::clock(at.time()))
                };
                forward
                    .entry(command)
                    .or_default()
                    .insert("dtend".to_owned(), json!(spell(new_end)));
                backward
                    .entry(command)
                    .or_default()
                    .insert("dtend".to_owned(), json!(spell(end)));
                continue;
            }
            forward
                .entry(command)
                .or_default()
                .insert(param.to_owned(), new_json);
            let clear = match (kind, field) {
                (Kind::Task | Kind::Event, "description") if old.is_none() => {
                    Some("clear_description")
                }
                _ => None,
            };
            match (clear, old_json) {
                (Some(flag), _) => {
                    backward
                        .entry(command)
                        .or_default()
                        .insert(flag.to_owned(), json!(true));
                }
                (None, Value::Null) => {
                    not_undoable = Some(format!(
                        "{field} had no value before, and the vault cannot clear it"
                    ));
                }
                (None, old_json) => {
                    backward
                        .entry(command)
                        .or_default()
                        .insert(param.to_owned(), old_json);
                }
            }
        }
        if kind == Kind::LockerItem {
            self.locker_draft(row, &mut forward, &mut backward)?;
        }
        if !changed {
            return Ok(Plan::Already("already has those values".to_owned()));
        }
        let finish = |map: BTreeMap<&'static str, Map<String, Value>>| -> Vec<Step> {
            map.into_iter()
                .filter(|(_, input)| !input.is_empty())
                .map(|(command, mut input)| {
                    input.insert(id_key.to_owned(), json!(row.id));
                    // `save_project` is an upsert that writes every column it
                    // is given and nulls the rest, so a rename carries the
                    // current area along and an area edit the current name.
                    if command == "schedule.save_project" {
                        if !input.contains_key("name") {
                            input.insert("name".to_owned(), json!(row.name));
                        }
                        if !input.contains_key("area")
                            && let Some(area) = row.field("area")
                        {
                            input.insert("area".to_owned(), area.json());
                        }
                    }
                    Step {
                        command,
                        input: Value::Object(input),
                    }
                })
                .collect()
        };
        Ok(Plan::Run {
            steps: finish(forward),
            inverse: finish(backward),
            not_undoable,
            note: None,
        })
    }

    /// A LOCKER EDIT SENDS THE WHOLE DRAFT. `locker.edit_item` rewrites every
    /// column of the item's type and nulls the ones the input leaves out, so
    /// an edit of one field sends every other one back as it is: plain
    /// columns with their current value, sealed ones as the vault's
    /// placeholder ("leave this secret alone"). The model's `username`, `url`
    /// and `notes` go to the column the type keeps them in (a note's notes
    /// are its sealed `content`), and a type that keeps no such column is an
    /// error, never a silent no-op. The inverse is a whole draft too.
    fn locker_draft(
        &self,
        row: &Row,
        forward: &mut BTreeMap<&'static str, Map<String, Value>>,
        backward: &mut BTreeMap<&'static str, Map<String, Value>>,
    ) -> Result<(), String> {
        const COMMAND: &str = "locker.edit_item";
        let Some(input) = forward.get_mut(COMMAND) else {
            return Ok(());
        };
        let back = backward.entry(COMMAND).or_default();
        let item_type = match row.field("type") {
            Some(Val::Enum(item_type)) => *item_type,
            _ => "login",
        };
        for field in ["username", "url", "notes"] {
            let Some(value) = input.remove(field) else {
                continue;
            };
            let column = meta::locker_column(item_type, field).ok_or_else(|| {
                format!(
                    "error: a {item_type} item keeps no {field}; {field} is kept on {} items.",
                    meta::locker_types_holding(field).join(", ")
                )
            })?;
            if column == "content" {
                back.remove(field);
                let (key_id, sealed) = self.door.seal(&row.id, &text_of(&value))?;
                input.insert("content".to_owned(), json!(sealed));
                input.insert("key_id".to_owned(), json!(key_id));
                match (row.extra.get("content"), row.extra.get("key_id")) {
                    (Some(old), Some(old_key)) => {
                        back.insert("content".to_owned(), json!(old));
                        back.insert("key_id".to_owned(), json!(old_key));
                    }
                    _ => {
                        back.insert("content".to_owned(), json!(""));
                    }
                }
            } else {
                input.insert(column.to_owned(), value);
            }
        }
        for map in [input, back] {
            for column in centraid_vault::commands::locker::ALL_FIELDS {
                if map.contains_key(column) {
                    continue;
                }
                if centraid_vault::commands::locker::SEALED_ITEM_CELLS.contains(&column) {
                    map.insert(
                        column.to_owned(),
                        json!(centraid_vault::commands::locker::SEALED_PLACEHOLDER),
                    );
                    continue;
                }
                let current = if ["username", "url", "notes"].contains(&column) {
                    match row.field(column) {
                        Some(Val::Text(text))
                            if meta::locker_column(item_type, column) == Some(column) =>
                        {
                            Some(text.clone())
                        }
                        _ => None,
                    }
                } else {
                    row.extra.get(column).cloned()
                };
                if let Some(current) = current {
                    map.insert(column.to_owned(), json!(current));
                }
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------
    // create
    // -----------------------------------------------------------------

    fn create(&mut self, kind: Option<&str>, args: &Map<String, Value>) -> Result<Outcome, String> {
        self.create_with(kind, args, &[])
    }

    /// `create`, with the people a new event is for (their vault ids; only an event takes them).
    fn create_with(
        &mut self,
        kind: Option<&str>,
        args: &Map<String, Value>,
        attendees: &[String],
    ) -> Result<Outcome, String> {
        let kind_text = kind.unwrap_or_default().trim().to_owned();
        let creatable: Vec<&str> = Verb::Create
            .kinds()
            .iter()
            .map(|kind| kind.name())
            .collect();
        let kind = Kind::parse(&kind_text)
            .filter(|kind| Verb::Create.command(*kind).is_some())
            .ok_or_else(|| {
                format!(
                    "error: create needs the kind parameter set to one of {}.",
                    creatable.join(", ")
                )
            })?;
        let spec = kind.spec();
        let allowed = create_allowed(kind);
        // an arg under another spelling of a field is that field (`create_arg_alias`)
        let mut spelled = args.clone();
        for key in args.keys() {
            if let Some(field) = create_arg_alias(kind, key)
                && !spelled.contains_key(field)
                && let Some(value) = spelled.remove(key)
            {
                spelled.insert(field.to_owned(), value);
            }
        }
        let args = &spelled;
        for key in args.keys() {
            if !allowed.contains(&key.as_str()) {
                return Err(format!(
                    "error: create {} args take {}; not \"{key}\".{}",
                    kind.name(),
                    allowed.join(", "),
                    whr::field_fix(kind, key, whr::FieldUse::Create)
                ));
            }
        }
        let name = args
            .get("name")
            .map(text_of)
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| format!("error: create {} needs name: … in args.", kind.name()))?;
        let text = |key: &str| args.get(key).map(text_of).filter(|value| !value.is_empty());
        let number = |key: &str| -> Result<Option<i64>, String> {
            match args.get(key) {
                None => Ok(None),
                Some(value) => match kind.spec().field(key) {
                    Some(field) => whr::number_arg(field, &text_of(value)).map(Some),
                    None => text_of(value)
                        .split_whitespace()
                        .next()
                        .unwrap_or_default()
                        .parse::<f64>()
                        .map(|n| Some(n.round() as i64))
                        .map_err(|_| format!("error: {key} is a number.")),
                },
            }
        };
        let one_row = |session: &Self, key: &str, want: Kind| -> Result<Option<Key>, String> {
            let Some(value) = args.get(key) else {
                return Ok(None);
            };
            let rows = session.resolve_rows(value)?;
            match rows.as_slice() {
                [row] if row.0 == want => Ok(Some(row.clone())),
                _ => Err(format!("error: {key}: is one {} #n.", want.name())),
            }
        };
        let date = match args.get("date") {
            Some(value) => {
                let expr = self.date_expr(value)?;
                let resolved =
                    dates::evaluate(&expr, self.now, None).map_err(|why| dates::rejection(&why))?;
                if resolved.is_open() {
                    return Err(format!(
                        "error: a new row's date is a day, an instant or a closed span; {} is open-ended.",
                        resolved.echo()
                    ));
                }
                Some(resolved)
            }
            None => None,
        };
        // EVERY REFERENCE RESOLVES BEFORE THE FIRST WRITE: a bad `list: #n`
        // must refuse the whole create, not leave the row behind it.
        let list = if kind == Kind::Task {
            one_row(self, "list", Kind::List)?
        } else {
            None
        };
        let mint = || self.door.mint_id();
        let (command, input, id_out): (&'static str, Value, &'static str) = match kind {
            Kind::Person => {
                let mut input =
                    json!({"display_name": name, "cadence_days": number("cadence")?.unwrap_or(0)});
                for field in ["role", "nickname"] {
                    if let Some(value) = text(field) {
                        input[field] = json!(value);
                    }
                }
                // A PARKED PERSON KEEPS THE ID IT WAS SHOWN WITH: the vault honours a seat-minted
                // party id (#922 G2), so the confirm writes the row the card named. A run lets the
                // vault mint it, as every harness run always has.
                if self.flags.writes != crate::native::park::Writes::Run {
                    input["party_id"] = json!(mint());
                }
                ("people.add_person", input, "party_id")
            }
            Kind::Group => {
                let mut input =
                    json!({"group_id": mint(), "name": name, "icon": "group", "member_ids": []});
                if let Some(currency) = text("currency") {
                    input["currency"] = json!(currency.to_uppercase());
                }
                ("tally.create_group", input, "group_id")
            }
            Kind::Event => {
                let resolved = date.ok_or("error: create event needs date: <date expression>.")?;
                let spell = |at: jiff::civil::DateTime| {
                    format!("{}T{}:00", at.date(), dates::clock(at.time()))
                };
                let (start, end) = match resolved {
                    dates::Resolved::Between { from, to } => (from, to),
                    dates::Resolved::At(at) => {
                        let minutes = number("duration")?.unwrap_or(60).max(1);
                        let end = jiff::Span::new()
                            .try_minutes(minutes)
                            .and_then(|span| at.checked_add(span))
                            .map_err(|_| "error: that duration is out of range.".to_owned())?;
                        (at, end)
                    }
                    dates::Resolved::Days { from, to } => (
                        from.to_datetime(jiff::civil::Time::midnight()),
                        to.tomorrow()
                            .unwrap_or(to)
                            .to_datetime(jiff::civil::Time::midnight()),
                    ),
                };
                let mut input = json!({
                    "event_id": mint(),
                    "summary": name,
                    "dtstart": spell(start),
                    "dtend": spell(end),
                    "calendar_id": self.world.calendar,
                });
                if let Some(description) = text("description") {
                    input["description"] = json!(description);
                }
                if !attendees.is_empty() {
                    input["attendee_party_ids"] = json!(attendees);
                }
                ("schedule.propose_event", input, "event_id")
            }
            Kind::Task => {
                let mut input = json!({"task_id": mint(), "title": name});
                if let Some(resolved) = date {
                    let point = match resolved.point() {
                        Some(point) => point,
                        None => {
                            let (point, note) = self.first_day_of(resolved).ok_or_else(|| {
                                format!(
                                    "error: a task is due at one day or instant; {} is a range.",
                                    resolved.echo()
                                )
                            })?;
                            self.pending_notes.push(note);
                            point
                        }
                    };
                    input["due_at"] = json!(point.vault());
                }
                if let Some(effort) = number("effort")? {
                    input["effort_min"] = json!(effort.max(1));
                }
                if let Some(priority) = number("priority")? {
                    input["priority"] = json!(priority.clamp(0, 9));
                }
                if let Some(description) = text("description") {
                    input["description"] = json!(description);
                }
                if let Some(parent) = one_row(self, "parent", Kind::Task)? {
                    input["parent_task_id"] = json!(parent.1);
                }
                ("schedule.add_task", input, "task_id")
            }
            Kind::Note => {
                let body = text("body").unwrap_or_else(|| name.clone());
                let mut input = json!({"note_id": mint(), "title": name, "body_text": body});
                if let Some(notebook) = one_row(self, "notebook", Kind::Notebook)? {
                    input["notebook_id"] = json!(notebook.1);
                }
                ("knowledge.create_note", input, "note_id")
            }
            Kind::Document => {
                let body = text("text").unwrap_or_else(|| name.clone());
                let mut input = json!({
                    "document_id": mint(),
                    "title": name,
                    "data_uri": format!("data:text/plain,{}", percent(&body)),
                });
                if let Some(folder) = one_row(self, "folder", Kind::Folder)? {
                    input["folder_id"] = json!(folder.1);
                }
                ("core.add_document", input, "document_id")
            }
            Kind::Album => (
                "media.create_album",
                json!({"album_id": mint(), "title": name}),
                "album_id",
            ),
            Kind::Notebook => (
                "knowledge.create_notebook",
                json!({"notebook_id": mint(), "name": name}),
                "notebook_id",
            ),
            Kind::Folder => (
                "core.create_folder",
                json!({"folder_id": mint(), "name": name}),
                "folder_id",
            ),
            Kind::List => {
                let mut input = json!({"project_id": mint(), "name": name});
                if let Some(area) = text("area") {
                    input["area"] = json!(area);
                }
                ("schedule.save_project", input, "project_id")
            }
            Kind::Debt => {
                let person = one_row(self, "person", Kind::Person)?
                    .ok_or("error: create debt needs person: #n.")?;
                let given = args.get("amount").map(text_of).unwrap_or_default();
                whr::symbol_conflict(&given, &self.world.currency)?;
                let amount = whr::parse_amount(&given)
                    .ok_or("error: create debt needs amount: N (currency units).")?;
                let direction = whr::enum_value(
                    Kind::Debt,
                    "direction",
                    &text("direction")
                        .ok_or("error: create debt needs direction: owes_me or i_owe.")?,
                )?;
                let vault_direction = spec
                    .field("direction")
                    .and_then(|field| field.vault_value(direction))
                    .unwrap_or("owed");
                (
                    "people.add_debt",
                    json!({
                        "party_id": person.1,
                        "direction": vault_direction,
                        "amount_minor": minor_of(amount, &self.world.currency).max(1),
                        "reason": name,
                    }),
                    "debt_id",
                )
            }
            Kind::LockerItem => {
                let kind_value = match text("type") {
                    Some(value) => whr::enum_value(Kind::LockerItem, "type", &value)?,
                    None => "login",
                };
                let item_id = mint();
                let mut input = json!({"item_id": item_id, "type": kind_value, "title": name});
                for field in ["username", "url", "notes"] {
                    let Some(value) = text(field) else {
                        continue;
                    };
                    let column = meta::locker_column(kind_value, field).ok_or_else(|| {
                        format!(
                            "error: a {kind_value} item keeps no {field}; {field} is kept on {} items.",
                            meta::locker_types_holding(field).join(", ")
                        )
                    })?;
                    if column == "content" {
                        let (key_id, sealed) = self.door.seal(&item_id, &value)?;
                        input["content"] = json!(sealed);
                        input["key_id"] = json!(key_id);
                    } else {
                        input[column] = json!(value);
                    }
                }
                // A SECRET IS SEALED ON THE WAY IN, like a note's content: the vault
                // takes ciphertext only.
                for (field, _) in meta::REVEAL_FIELDS {
                    let Some(value) = text(field).filter(|_| *field != "content") else {
                        continue;
                    };
                    // `normalize.rs` already left out what the type cannot keep
                    let Some(column) = meta::locker_secret_column(kind_value, field) else {
                        continue;
                    };
                    let (key_id, sealed) = self.door.seal(&item_id, &value)?;
                    input[column] = json!(sealed);
                    input["key_id"] = json!(key_id);
                    if column == "password" {
                        input["password_rotated"] = json!(true);
                    }
                }
                ("locker.add_item", input, "item_id")
            }
            Kind::Photo => unreachable!("photos are not created by a call"),
        };
        let before = self.world.clone();
        let ran = self.write_step(command, &input)?;
        if !ran.ok {
            // A NEW EVENT THAT CLASHES WITH ANOTHER is a refusal the person can lift by
            // choosing another time (`compose_busy_conflict`).
            if self.flags.compose
                && ran.predicate.as_deref() == Some("no_busy_conflict")
                && let Some(asked) =
                    self.compose_busy_conflict(&input, ran.reason.as_deref().unwrap_or_default())
            {
                return Ok(asked);
            }
            return Err(format!(
                "error: create {} was refused: {}",
                kind.name(),
                ran.reason.unwrap_or_default()
            ));
        }
        let id = ran
            .output
            .get(id_out)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let key = (kind, id.clone());
        // Follow-ups that the create command itself does not take.
        let mut follow = Vec::new();
        if let Some(list) = list {
            follow.push((
                "schedule.organize_task",
                json!({"task_id": id, "project_id": list.1, "sort_order": 0}),
            ));
        }
        for (command, input) in follow {
            if let Err(error) = self.write_must(command, input) {
                // Take the half-made row back out, so no later diff finds it.
                if let Some(delete) = Verb::Delete.command(kind) {
                    self.door.advance();
                    let _ = self.write_step(delete, &json!({ id_param(kind): id }));
                }
                self.settle()?;
                return Err(error);
            }
        }
        let inverse = match (kind, Verb::Delete.command(kind)) {
            (_, Some(delete)) => vec![Inverse {
                command: delete.to_owned(),
                input: json!({ id_param(kind): id }),
                key: key.clone(),
            }],
            _ => Vec::new(),
        };
        let not_undoable = if inverse.is_empty() {
            vec![format!(
                "a new {} cannot be deleted by a command",
                kind.name()
            )]
        } else {
            Vec::new()
        };
        self.world = before;
        let mut outcome = self.execute(Verb::Create, Vec::new(), Some(key.clone()))?;
        self.record(inverse, not_undoable);
        if let Some(date) = date {
            outcome.text.push_str(&format!(" · when: {}", date.echo()));
        }
        Ok(outcome)
    }

    // -----------------------------------------------------------------
    // undo
    // -----------------------------------------------------------------

    /// THE WRITES `undo` REVERTS (SPEC §4.2), as an index into `writes`: the previous turn's,
    /// when it wrote something, and otherwise those of the last turn that did, looking back only
    /// over turns whose writes were all already-so (`already: …`, nothing changed). Such a turn
    /// neither pushes onto the undo memory nor clears it: `restore`, `restore` again, `undo`
    /// undoes the first restore. A turn that read, asked, declined or undid something between
    /// ends it, as before, and so does a turn already undone.
    fn undo_entry(&self) -> Option<usize> {
        let entry = |turn: usize| self.writes.iter().position(|(at, _, _)| *at == turn);
        let mut turn = self.turn.checked_sub(1)?;
        while turn > 0 && self.noops.contains(&turn) && entry(turn).is_none() {
            turn -= 1;
        }
        entry(turn).filter(|_| turn > 0 && !self.undone.contains(&turn))
    }

    fn undo(&mut self) -> Result<Outcome, String> {
        let Some(index) = self.undo_entry() else {
            return Err("error: nothing to undo".to_owned());
        };
        let previous = self.writes[index].0;
        let (_, inverses, notes) = self.writes[index].clone();
        self.undone.insert(previous);
        let before = self.world.clone();
        let mut lines = Vec::new();
        let mut touched: Vec<Key> = Vec::new();
        for inverse in inverses.iter().rev() {
            let ran = self.write_step(&inverse.command, &inverse.input)?;
            if !ran.ok {
                let name = self.named(&inverse.key);
                lines.push(format!(
                    "not undone: {name}: {}",
                    ran.reason.unwrap_or_default()
                ));
            } else if !touched.contains(&inverse.key) {
                touched.push(inverse.key.clone());
            }
        }
        self.settle()?;
        let mut diff = diff(&before, &self.world);
        // A SETTLEMENT MOVES A BALANCE, not a row field: the diff carries the
        // person's balance in the settled group (positive = they owe me),
        // before and after, as a `balance` field on the person.
        for (person, group, currency) in std::mem::take(&mut self.settling) {
            let owes = |world: &World| {
                let data = world.tally.balance_data();
                centraid_apps_tally::balance::group_pair_nets(&data, &group)
                    .get(&person.1)
                    .and_then(|row| row.get(&world.me))
                    .copied()
                    .unwrap_or(0)
            };
            let (old, new) = (owes(&before), owes(&self.world));
            if old != new {
                diff.rows.push((
                    person,
                    "updated",
                    json!({
                        "balance": [
                            {"amount": crate::native::world::units(old, &currency), "unit": currency},
                            {"amount": crate::native::world::units(new, &currency), "unit": currency},
                        ],
                    }),
                ));
            }
        }
        self.mark_acted(&touched);
        let mut out = Vec::new();
        let mut shown_lines: Vec<(Key, usize, String)> = Vec::new();
        let mut shown_changes: Vec<RowChange> = Vec::new();
        for (shown, key) in touched.iter().enumerate() {
            let n = self.number(key);
            self.acted.insert(n);
            if shown < ROW_CAP {
                let line = self.change_line(Verb::Undo, &before, key, n);
                shown_lines.push((key.clone(), n, line.clone()));
                shown_changes.extend(self.row_change(Verb::Undo, &before, key));
                out.push(line);
            }
        }
        if touched.len() > ROW_CAP {
            // THE UNDO OF A CONFIRMED BULK WRITE echoes its first `ROW_CAP` rows
            // too; the effect lists every one.
            out.push(format!(
                "… {} more changed (the effect lists every row)",
                touched.len() - ROW_CAP
            ));
        }
        out.extend(lines);
        out.extend(notes.iter().map(|note| format!("not undone: {note}")));
        if out.is_empty() {
            out.push("undone: nothing changed".to_owned());
        }
        let mut outcome = Outcome::text(out.join("\n"));
        let diff_json = self.diff_json(&diff);
        outcome.effect.insert("diff".to_owned(), diff_json);
        let more = touched.len().saturating_sub(ROW_CAP);
        self.park_call(Verb::Undo, shown_lines, shown_changes, more);
        Ok(outcome)
    }
}

// ---------------------------------------------------------------------
// The turns the runtime ends itself: the cap and the vault's refusals
// ---------------------------------------------------------------------

/// A verb as a question names it: `delete`, `complete`, `change`.
fn verb_phrase(verb: Verb) -> &'static str {
    match verb {
        Verb::Edit => "change",
        Verb::AddTo => "add",
        Verb::RemoveFrom => "remove",
        Verb::Log => "log a contact with",
        Verb::SettleUp | Verb::SettleDebt => "settle",
        other => other.spec().name,
    }
}

/// Words that answer the runtime's yes-or-no question with a yes ("all of
/// them" answers `delete all of them?` too).
const YES: [&str; 38] = [
    "yes",
    "yeah",
    "yea",
    "yep",
    "yup",
    "ya",
    "yah",
    "sure",
    "ok",
    "okay",
    "k",
    "y",
    "confirm",
    "confirmed",
    "proceed",
    "go",
    "ahead",
    "do",
    "please",
    "absolutely",
    "definitely",
    "certainly",
    "agreed",
    "alright",
    "fine",
    "correct",
    "right",
    "affirmative",
    "si",
    "sim",
    "oui",
    "ja",
    "all",
    "every",
    "everything",
    "each",
    "whole",
    "entire",
];

/// Words that hold a yes back: a no, a narrowing ("just the done ones"), an
/// addition ("and the events too"). A message that has one is not a plain yes.
const WITHHOLD: [&str; 31] = [
    "no", "nope", "nah", "not", "never", "dont", "cant", "wont", "stop", "wait", "hold", "cancel",
    "abort", "undo", "only", "just", "except", "but", "instead", "rather", "keep", "leave",
    "unless", "without", "also", "plus", "too", "nothing", "none", "skip", "rest",
];

/// The longest message that counts as a plain yes, in words.
const YES_WORDS: usize = 10;

/// Whether the message answers an ask with a plain yes: short, with a word of
/// `YES`, and without a contraction of "not" or a word of `WITHHOLD`. The
/// person's yes is what lets a write over the cap through, so the runtime
/// reads it, and reads it narrowly: a message it does not take for a yes only
/// gets the question asked again.
fn says_yes(message: &str) -> bool {
    let lower = message.to_lowercase();
    if lower.contains("n't") || lower.contains("n\u{2019}t") {
        return false;
    }
    let words = crate::native::session::words(message);
    !words.is_empty()
        && words.len() <= YES_WORDS
        && words.iter().any(|word| YES.contains(&word.as_str()))
        && !words.iter().any(|word| WITHHOLD.contains(&word.as_str()))
}

impl Session {
    /// WHETHER THIS WRITE IS THE ONE THE RUNTIME ASKED ABOUT and the person
    /// answered with a yes: the ask of `bulk_ask` ended the previous turn, the
    /// call has the same verb, the same rows and the same `args`, and the
    /// message is a plain yes (`says_yes`). A confirmation is used once.
    pub(crate) fn confirmed(
        &mut self,
        verb: Verb,
        keys: &[Key],
        extra: &Map<String, Value>,
    ) -> bool {
        let Some(pending) = &self.pending_bulk else {
            return false;
        };
        let same = pending.turn + 1 == self.turn
            && pending.verb == verb
            && pending.keys == keys.iter().cloned().collect::<BTreeSet<Key>>()
            && pending.args == canonical_json(&Value::Object(extra.clone()));
        if !same || !says_yes(&self.message) {
            return false;
        }
        self.pending_bulk = None;
        self.pending_notes.push(format!(
            "note: confirmed, the {} rows the runtime asked about.",
            keys.len()
        ));
        true
    }

    /// THE CAP HOLDS (SPEC §4.6): the turn ends in the ask the runtime composes
    /// for a write on more than `ROW_CAP` rows, with the count and the rows the
    /// call named in its effect. Nothing is written. The write is remembered
    /// (`PendingBulk`) so that the same call, sent in the turn after the
    /// person's yes, goes through (`confirmed`).
    pub(crate) fn bulk_ask(
        &mut self,
        verb: Verb,
        keys: &[Key],
        args: &Map<String, Value>,
        extra: &Map<String, Value>,
    ) -> Outcome {
        let rows: Vec<&Row> = keys.iter().filter_map(|key| self.world.row(key)).collect();
        let mut kinds: Vec<Kind> = Vec::new();
        for key in keys {
            if !kinds.contains(&key.0) {
                kinds.push(key.0);
            }
        }
        let what = render::count_phrase(&kinds, &rows);
        let phrase = verb_phrase(verb);
        let destination = self.destination(verb, extra);
        let question = format!("this would {phrase} {what}{destination}; {phrase} all of them?");
        let selector = args
            .get("rows")
            .map(|value| crate::native::session::handle_list(value).join(", "))
            .unwrap_or_default();
        let kind_names = kinds
            .iter()
            .map(|kind| kind.name())
            .collect::<Vec<_>>()
            .join(",");
        self.pending_bulk = Some(PendingBulk {
            turn: self.turn,
            verb,
            keys: keys.iter().cloned().collect(),
            args: canonical_json(&Value::Object(extra.clone())),
        });
        let note = format!(
            "the runtime ended the turn: {} rows is over the cap of {ROW_CAP} and nothing was done; after a yes, send the same write again",
            keys.len()
        );
        let mut outcome = self.ends_in_ask(None, &question, &[], &note);
        if let Some(Value::Object(ask)) = outcome.effect.get_mut("ask") {
            ask.insert("count".to_owned(), json!(keys.len()));
            ask.insert("verb".to_owned(), json!(verb.spec().name));
            ask.insert("kind".to_owned(), json!(kind_names));
            ask.insert("selector".to_owned(), json!(selector));
        }
        outcome.effect.insert(
            "bulk".to_owned(),
            json!({
                "count": keys.len(),
                "cap": ROW_CAP,
                "verb": verb.spec().name,
                "kind": kind_names,
                "rows": selector,
                "confirmed": false,
            }),
        );
        outcome
            .effect
            .insert("verb".to_owned(), json!(verb.spec().name));
        outcome
    }

    /// ` to the Summer album` for an `add_to`, ` from the …` for a `remove_from`:
    /// where the rows of a bulk write go.
    fn destination(&self, verb: Verb, extra: &Map<String, Value>) -> String {
        let slot = match verb {
            Verb::AddTo => "to",
            Verb::RemoveFrom => "from",
            _ => return String::new(),
        };
        let Some(value) = extra.get(slot) else {
            return String::new();
        };
        match self.resolve_rows(value).as_deref() {
            Ok([key]) => self.world.row(key).map_or_else(String::new, |row| {
                format!(" {slot} the {} {}", row.name, key.0.name())
            }),
            _ => String::new(),
        }
    }

    /// WHAT THE RUNTIME DOES WITH A REFUSAL OF THE VAULT (D-1044-10), told by
    /// the id of the check that failed and by what the person can still do,
    /// never by the vault's sentence. It reads the refusals of a `restore` and of
    /// a `delete`, and only when the refused step is the first that landed
    /// anything, so the turn can end without a half-made write.
    ///
    /// - A `restore` of a row the vault lists as trashed and will not bring
    ///   back has run past its window: nothing can lift that, so the turn
    ///   ends in `decline not_found`.
    /// - A `delete` the vault refuses because the row still holds others (a
    ///   folder with documents, a group with expenses, a notebook with
    ///   notebooks) ends in an ask that names what the person can do
    ///   (`refusal_question`).
    ///
    /// With `Flags::compose` the refusals a confirmation or a choice can lift end in an ask
    /// over the rows involved (`refusal_question`): a member removed from a group with an
    /// unsettled balance (`member_off_ledger`), a cancelled event to reschedule
    /// (`event_exists_not_cancelled`). A new event that clashes in time is `create`'s
    /// (`Session::compose_busy_conflict`).
    ///
    /// `None` leaves the refusal an `error:` for the model: an input the
    /// command's schema rejects, a caller it does not allow, a check this
    /// file does not name, any other verb.
    fn refusal(
        &mut self,
        verb: Verb,
        key: &Key,
        (command, input): (&str, &Value),
        ran: &Ran,
        before: &World,
    ) -> Option<Outcome> {
        let predicate = ran.predicate.as_deref().unwrap_or_default();
        let lifted = self.flags.compose
            && matches!(
                (verb, predicate),
                (Verb::RemoveFrom, "member_off_ledger")
                    | (Verb::Reschedule, "event_exists_not_cancelled")
            );
        if !(matches!(verb, Verb::Restore | Verb::Delete) || lifted)
            || matches!(predicate, "" | "schema" | "authority")
        {
            return None;
        }
        let restore_lapsed =
            verb == Verb::Restore && before.row(key).is_some_and(|row| row.trashed);
        let question = if restore_lapsed {
            None
        } else {
            Some(self.refusal_question(key, command, input, predicate)?)
        };
        let reason = ran.reason.clone().unwrap_or_default();
        let said = reason.trim_end_matches('.').to_owned();
        let name = self.named(key);
        let facts = json!({
            "verb": verb.spec().name,
            "kind": key.0.name(),
            "id": key.1,
            "n": self.numbers.get(key),
            "command": command,
            "predicate": predicate,
            "reason": reason,
        });
        let mut outcome = if let Some((question, options)) = question {
            let lead = format!("refused: {} {name}: {said}.", verb.spec().name);
            let mut asked = self.ends_in_ask(
                Some(lead),
                &question,
                &options,
                "the runtime ended the turn and nothing was done",
            );
            if verb == Verb::Reschedule && predicate == "event_exists_not_cancelled" {
                self.plan_offer = Some((self.turn, key.clone()));
            }
            asked
                .effect
                .insert("refusal".to_owned(), with_outcome(facts, "ask"));
            crate::native::compose::marked(asked, "refused_write", "ask_options")
        } else {
            let lead = format!(
                "refused: restore {name}: it is in the trash but past the vault's restore window, so it cannot come back (vault: {said})."
            );
            let mut declined = self.ends_in_decline(
                Some(lead),
                "not_found",
                "the runtime ended the turn: a row past its restore window cannot be brought back",
            );
            declined
                .effect
                .insert("refusal".to_owned(), with_outcome(facts, "decline"));
            crate::native::compose::marked(declined, "refused_write", "decline")
        };
        outcome
            .effect
            .insert("verb".to_owned(), json!(verb.spec().name));
        Some(outcome)
    }

    /// The question a `delete` the vault refused becomes, and the rows it is
    /// about (at most `ROW_CAP`), by the command and the check that refused.
    fn refusal_question(
        &mut self,
        key: &Key,
        command: &str,
        input: &Value,
        predicate: &str,
    ) -> Option<(String, Vec<Key>)> {
        let row_name = self
            .world
            .row(key)
            .map(|row| row.name.clone())
            .unwrap_or_default();
        Some(match (command, predicate) {
            ("core.delete_folder", "folder_is_empty") => {
                let held = self
                    .world
                    .neighbours(key)
                    .remove(&Kind::Document)
                    .unwrap_or_default();
                let in_trash = |held: &Key| self.world.row(held).is_some_and(|row| row.trashed);
                let mut live: Vec<Key> = held
                    .iter()
                    .filter(|held| !in_trash(held))
                    .cloned()
                    .collect();
                let trashed: Vec<Key> =
                    held.iter().filter(|held| in_trash(held)).cloned().collect();
                let holds = match (live.len(), trashed.len()) {
                    (0, 0) => "other folders".to_owned(),
                    (live, 0) => Kind::Document.count(live),
                    (0, trashed) => format!("{} in the trash", Kind::Document.count(trashed)),
                    (live, trashed) => format!(
                        "{} and {} in the trash",
                        Kind::Document.count(live),
                        Kind::Document.count(trashed)
                    ),
                };
                let them = if held.len() == 1 { "it" } else { "them" };
                live.extend(trashed);
                live.truncate(ROW_CAP);
                (
                    format!(
                        "the {row_name} folder still holds {holds}; take {them} out first, then delete the folder?"
                    ),
                    live,
                )
            }
            ("knowledge.delete_notebook", "notebook_has_no_children") => (
                format!(
                    "the {row_name} notebook still holds other notebooks, so it cannot be deleted; keep it?"
                ),
                Vec::new(),
            ),
            ("tally.delete_group", "group_empty") => (
                format!(
                    "the {row_name} group still has expenses, so it cannot be deleted; keep it, or rename it instead?"
                ),
                Vec::new(),
            ),
            // THE PERSON AND THE GROUP they are in the way of: settling up lifts the refusal.
            ("tally.remove_group_member", "member_off_ledger") => {
                let group: Key = (Kind::Group, input.get("group_id")?.as_str()?.to_owned());
                let group_name = self.world.row(&group)?.name.clone();
                (
                    format!(
                        "{row_name} still has an unsettled balance in the {group_name} group; settle up first?"
                    ),
                    vec![key.clone(), group],
                )
            }
            ("schedule.reschedule_event", "event_exists_not_cancelled") => (
                format!(
                    "the {row_name} event was cancelled, so it cannot be moved; plan a new one instead?"
                ),
                vec![key.clone()],
            ),
            _ => return None,
        })
    }
}

/// `facts` with the outcome the runtime gave the refusal.
fn with_outcome(mut facts: Value, outcome: &str) -> Value {
    facts["outcome"] = json!(outcome);
    facts
}

fn finish(mut outcome: Outcome, more: bool) -> Outcome {
    let failed = outcome.effect.contains_key("error") && outcome.text.starts_with("error");
    outcome.ends_turn = !more && !failed;
    outcome
}

/// A day with no time keeps the row's time (`move it to friday`).
fn keep_time(point: Stamp, row: Option<Stamp>) -> Stamp {
    match (point.time, row.and_then(|row| row.time)) {
        (None, Some(time)) => Stamp {
            date: point.date,
            time: Some(time),
        },
        _ => point,
    }
}

/// An event's start and end as the vault holds them.
pub(crate) fn event_span(row: &Row) -> (jiff::civil::DateTime, jiff::civil::DateTime) {
    let start = row.date.map(Stamp::at).unwrap_or_default();
    let end = match (row.date.and_then(|stamp| stamp.time), row.field("duration")) {
        (_, Some(Val::Num(minutes))) => jiff::Span::new()
            .try_minutes(*minutes)
            .and_then(|span| start.checked_add(span))
            .unwrap_or(start),
        (None, _) => start
            .checked_add(jiff::Span::new().days(1))
            .unwrap_or(start),
        _ => start,
    };
    (start, end)
}

fn rename(kind: Kind) -> (&'static str, &'static str) {
    match kind {
        Kind::Person => ("people.edit_person", "display_name"),
        Kind::Group => ("tally.rename_group", "name"),
        Kind::Event => ("schedule.edit_event", "summary"),
        Kind::Task => ("schedule.edit_task", "title"),
        Kind::Note => ("knowledge.edit_note", "title"),
        Kind::Document => ("core.rename_document", "title"),
        Kind::Photo => ("media.update_asset", "title"),
        Kind::Album => ("media.rename_album", "title"),
        Kind::LockerItem => ("locker.edit_item", "title"),
        Kind::Notebook => ("knowledge.rename_notebook", "name"),
        Kind::Folder => ("core.rename_folder", "name"),
        Kind::List => ("schedule.save_project", "name"),
        Kind::Debt => ("", ""),
    }
}

/// `have` with `added` at its end, joined as `have` is written (nt15 R2b): a body of lines gets
/// a new line (with the bullet its lines carry, `- `, `* ` or `• `); a body that ends a sentence
/// gets a space; one with `; ` and no `, ` keeps `; `; any other (a list, a phrase) gets `, `. A
/// text that is empty is just the new text.
#[must_use]
pub fn appended(have: &str, added: &str) -> String {
    let added = added.trim();
    let have = have.trim_end().trim_end_matches([',', ';']).trim_end();
    if have.is_empty() {
        return added.to_owned();
    }
    if have.contains('\n') {
        let lines: Vec<&str> = have
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        let bullet = ["- ", "* ", "• "].into_iter().find(|bullet| {
            lines
                .iter()
                .all(|line| line.trim_start().starts_with(bullet))
        });
        return match bullet {
            Some(bullet) if !added.starts_with(bullet) => format!("{have}\n{bullet}{added}"),
            _ => format!("{have}\n{added}"),
        };
    }
    let separator = if have.ends_with(['.', '!', '?']) {
        " "
    } else if have.contains("; ") && !have.contains(", ") {
        "; "
    } else {
        ", "
    };
    format!("{have}{separator}{added}")
}

fn editable(kind: Kind) -> String {
    let mut names = Vec::new();
    if kind != Kind::Debt {
        names.push("name");
    }
    names.extend(
        kind.spec()
            .fields
            .iter()
            .filter(|field| field.edit.is_some())
            .map(|field| field.name),
    );
    names.join(", ")
}

fn percent(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// What changed between two reads of the world.
pub(crate) struct Diff {
    /// `(row, change, {field: [before, after]})`.
    pub rows: Vec<(Key, &'static str, Value)>,
    /// `(added, from, to)`.
    pub links: Vec<(bool, Key, Key)>,
}

pub(crate) fn snapshot(row: &Row) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    out.insert("name".to_owned(), json!(row.name));
    out.insert(
        "date".to_owned(),
        row.date.map_or(Value::Null, |stamp| json!(stamp.vault())),
    );
    for (name, value) in &row.fields {
        out.insert((*name).to_owned(), value.json());
    }
    out.insert("trashed".to_owned(), json!(row.trashed));
    out
}

/// A locker row's sealed cells by the name the model uses (a note's
/// `content` is its `notes`), with their ciphertext. A diff reports a sealed
/// cell as `"sealed"` and a change to it as a changed ciphertext, never the
/// value.
fn sealed_cells(row: &Row) -> BTreeMap<&'static str, &String> {
    let is_note = row.field("type") == Some(&Val::Enum("note"));
    meta::REVEAL_FIELDS
        .iter()
        .filter_map(|(name, column)| {
            let name = if *column == "content" && is_note {
                "notes"
            } else {
                name
            };
            row.extra.get(column).map(|sealed| (name, sealed))
        })
        .collect()
}

pub(crate) fn diff(before: &World, after: &World) -> Diff {
    let mut rows = Vec::new();
    let keys: BTreeSet<&Key> = before.rows.keys().chain(after.rows.keys()).collect();
    for key in keys {
        match (before.row(key), after.row(key)) {
            (None, Some(row)) => {
                let mut fields: Map<String, Value> = snapshot(row)
                    .into_iter()
                    .map(|(name, value)| (name, json!([Value::Null, value])))
                    .collect();
                for name in sealed_cells(row).keys() {
                    fields.insert((*name).to_owned(), json!([Value::Null, SEALED]));
                }
                rows.push((key.clone(), "created", Value::Object(fields)));
            }
            (Some(row), None) => {
                let fields: Map<String, Value> = snapshot(row)
                    .into_iter()
                    .map(|(name, value)| (name, json!([value, Value::Null])))
                    .collect();
                rows.push((key.clone(), "removed", Value::Object(fields)));
            }
            (Some(old), Some(new)) => {
                let (a, b) = (snapshot(old), snapshot(new));
                let names: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
                let mut fields = Map::new();
                for name in names {
                    let x = a.get(name).cloned().unwrap_or(Value::Null);
                    let y = b.get(name).cloned().unwrap_or(Value::Null);
                    if x != y {
                        fields.insert(name.clone(), json!([x, y]));
                    }
                }
                let (was, now) = (sealed_cells(old), sealed_cells(new));
                let names: BTreeSet<&&str> = was.keys().chain(now.keys()).collect();
                for name in names {
                    if was.get(*name) != now.get(*name) {
                        let show =
                            |cell: Option<&&String>| cell.map_or(Value::Null, |_| json!(SEALED));
                        fields.insert(
                            (*name).to_owned(),
                            json!([show(was.get(*name)), show(now.get(*name))]),
                        );
                    }
                }
                if !fields.is_empty() {
                    let change = match (old.trashed, new.trashed) {
                        (false, true) => "trashed",
                        (true, false) => "restored",
                        _ => "updated",
                    };
                    rows.push((key.clone(), change, Value::Object(fields)));
                }
            }
            (None, None) => {}
        }
    }
    let edge_set = |world: &World| -> BTreeSet<(Key, Key, Via)> {
        world
            .edges
            .iter()
            .map(|edge| (edge.from.clone(), edge.to.clone(), edge.via))
            .collect()
    };
    let (a, b) = (edge_set(before), edge_set(after));
    let mut links = Vec::new();
    for (from, to, _) in b.difference(&a) {
        links.push((true, from.clone(), to.clone()));
    }
    for (from, to, _) in a.difference(&b) {
        links.push((false, from.clone(), to.clone()));
    }
    Diff { rows, links }
}

/// `field old → new` for one row.
/// A field a write moved, as the model's change line spells it and as the facts it is made of.
pub(crate) struct FieldMove {
    pub field: String,
    /// The value before and after, spelled for display (`"text"` quoted, a date in the person's
    /// words); `None` when the row had none. Both `None` for a change that is not a value (a
    /// sealed cell, the trash).
    pub from: Option<String>,
    pub to: Option<String>,
    /// The model's change line for it: `name "a" → "b"`, `status open → done`.
    pub text: String,
}

fn row_changes(old: &Row, new: &Row, today: jiff::civil::Date) -> Vec<FieldMove> {
    let mut out = Vec::new();
    if old.name != new.name {
        out.push(FieldMove {
            field: "name".to_owned(),
            from: Some(format!("\"{}\"", old.name)),
            to: Some(format!("\"{}\"", new.name)),
            text: format!("name \"{}\" → \"{}\"", old.name, new.name),
        });
    }
    if old.date != new.date {
        let show = |stamp: Option<Stamp>| {
            stamp.map_or_else(|| "none".to_owned(), |stamp| render::when(stamp, today))
        };
        out.push(FieldMove {
            field: "date".to_owned(),
            from: old.date.map(|stamp| render::card_when(stamp, today)),
            to: new.date.map(|stamp| render::card_when(stamp, today)),
            text: format!("{} → {}", show(old.date), show(new.date)),
        });
    }
    let spec = new.kind.spec();
    for field in spec.fields {
        let (a, b) = (old.field(field.name), new.field(field.name));
        if a == b {
            continue;
        }
        let show = |value: Option<&Val>| {
            value.map_or_else(|| "none".to_owned(), |value| value.show(Some(field)))
        };
        out.push(FieldMove {
            field: field.name.to_owned(),
            from: a.map(|value| value.show(Some(field))),
            to: b.map(|value| value.show(Some(field))),
            text: format!("{} {} → {}", field.name, show(a), show(b)),
        });
    }
    let (was, now) = (sealed_cells(old), sealed_cells(new));
    for (name, sealed) in &now {
        if was.get(name) != Some(sealed) {
            out.retain(|moved| moved.field != *name);
            out.push(FieldMove {
                field: (*name).to_owned(),
                from: None,
                to: None,
                text: format!("{name} changed (sealed; reveal to show)"),
            });
        }
    }
    if old.trashed != new.trashed {
        out.push(FieldMove {
            field: "trashed".to_owned(),
            from: None,
            to: None,
            text: if new.trashed {
                "moved to the trash"
            } else {
                "back from the trash"
            }
            .to_owned(),
        });
    }
    out
}

/// Links of `key` gained (`true`) or lost (`false`).
fn edge_changes(before: &World, after: &World, key: &Key) -> Vec<(bool, Key)> {
    let others = |world: &World| -> BTreeSet<Key> {
        world
            .edges
            .iter()
            .filter_map(|edge| {
                if edge.to == *key && edge.via != Via::About {
                    Some(edge.from.clone())
                } else {
                    None
                }
            })
            .collect()
    };
    let (a, b) = (others(before), others(after));
    let mut out: Vec<(bool, Key)> = b.difference(&a).map(|key| (true, key.clone())).collect();
    out.extend(a.difference(&b).map(|key| (false, key.clone())));
    out
}

#[cfg(test)]
mod tests {
    use super::says_yes;

    #[test]
    fn a_plain_yes_is_a_yes() {
        for message in [
            "yes",
            "Yes.",
            "yes please",
            "yeah go ahead",
            "ok do it",
            "okay",
            "sure",
            "yep!",
            "all of them",
            "yes, delete them all",
            "go ahead",
            "confirmed",
            "Sí, adelante todo",
        ] {
            assert!(says_yes(message), "{message}");
        }
    }

    #[test]
    fn a_no_a_narrowing_or_an_addition_is_not_a_yes() {
        for message in [
            "",
            "no",
            "nope, wait",
            "yes but only the done ones",
            "fine just the ones i already finished, keep the open",
            "yes keep the open ones",
            "yes and the events too",
            "yes, also the notes",
            "don't",
            "no don\u{2019}t do it",
            "do not delete them",
            "never mind",
            "stop",
            "cancel that",
            "what is left on the list",
            "delete them",
            "yes it is fine to delete them all but first tell me what is on the list again please",
        ] {
            assert!(!says_yes(message), "{message}");
        }
    }
}
