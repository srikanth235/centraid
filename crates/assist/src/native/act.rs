//! The writes `create`, `edit` and `do` (SPEC §4.2): every write through the vault's typed commands, the
//! call-only ambiguity check (§3.3), already-so writes, and `undo`.
//!
//! Two things end a turn here that the model would otherwise have to settle,
//! and the runtime composes both itself (D-1044-10, SPEC §4.6):
//!
//! - THE CAP. A write on more than `ROW_CAP` rows is never run outright,
//!   whatever the trace's `scope` and the call's `more` say: the turn ends in an
//!   ask with the count (`this would delete 734 tasks; delete all of them?`),
//!   and the same write, sent in the turn right after a yes, goes through.
//! - A REFUSAL OF THE VAULT to restore or to delete. A delete it refuses because the row still
//!   holds others (a folder with documents, a notebook with notebooks) ends in an ask
//!   that names what the person can do. Every other refusal (a call the
//!   command's schema rejects, a check this file does not name, any other
//!   verb) stays an `error:` for the model to repair.
//!
//! With `Flags::compose` the same hands-off rule reaches the selector and the refusals the
//! person can lift (`compose.rs`, SPEC §4.8): a selector that fits several rows or none ends in
//! the ask or the decline the runtime writes, a verb that does not apply to the kind and a row
//! in the trash end in a decline, and a cancelled event to move and a clash of time end in an ask
//! over the rows involved. Two things the person's words settle
//! before that: a selector that fits several rows takes every one of them when the message (or
//! the trace) says all, and a name that reached nothing goes to the one near spelling of its
//! kind (`Targets::decided`, said in the reply and the effect by `Session::say_decided`).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use crate::native::dates::{self, Stamp};
use crate::native::door::{Call, Ran};
use crate::native::member::MemberAction;
use crate::native::meta::{self, ActionSpec, Kind, ROW_CAP, Verb, Via};
use crate::native::park::{FieldChange, LinkChange, RowChange};
use crate::native::render;
use crate::native::session::{
    Inverse, Outcome, ResultSet, Selector, Session, arg_bool, arg_str, canonical_json,
};
use crate::native::whr;
use crate::native::world::{Key, Row, SEALED, Val, World};

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

/// Which container a kind goes into with `add_to`.
#[must_use]
pub fn container_of(_kind: Kind) -> Option<Kind> {
    None
}

/// The refusal for a verb no action serves on a kind.
fn not_applicable(verb: Verb, kind: Kind) -> String {
    format!(
        "error: {} does not apply to {}.",
        verb.spec().name,
        kind.name()
    )
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
    act: Call,
    input: Value,
}

impl Step {
    /// A step that runs `action` on `input`.
    fn of(action: &ActionSpec, input: Value) -> Self {
        Self {
            act: action.call(),
            input,
        }
    }
}

/// The input an action takes: the row it acts on under the action's own id property, the values
/// chat stated under the names chat says them (`name` for a `title`), and the properties that can
/// only take one value (`flag`, `rel`) filled in.
fn input_of(action: &ActionSpec, id: &str, stated: &[(&str, Value)]) -> Value {
    let mut input = Map::new();
    input.insert(action.id_param.to_owned(), json!(id));
    for (name, value) in stated {
        let property = action.property_named(name).unwrap_or(name);
        input.insert(property.to_owned(), value.clone());
    }
    for (property, fixed) in action.consts.iter().chain(action.defaults) {
        if let Ok(value) = serde_json::from_str::<Value>(fixed) {
            input.entry((*property).to_owned()).or_insert(value);
        }
    }
    Value::Object(input)
}

/// What one target will do.
enum Plan {
    Already(String),
    Run {
        steps: Vec<Step>,
        inverse: Vec<Step>,
    },
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

/// The verbs `do` runs: every verb but `create` and `edit`, which are tools of their own.
#[must_use]
pub(crate) fn do_verbs() -> Vec<&'static str> {
    meta::VERBS
        .iter()
        .map(|spec| spec.name)
        .filter(|name| !matches!(*name, "create" | "edit"))
        .collect()
}

impl Session {
    /// A write: `create`, `edit` or `do` (#1166). The verb is the tool's own for `create` and
    /// `edit`, the `verb` argument for `do`.
    pub(crate) fn act(&mut self, tool: &str, args: &Map<String, Value>) -> Result<Outcome, String> {
        let mut decided = None;
        let outcome = self.act_run(tool, args, &mut decided)?;
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
        tool: &str,
        args: &Map<String, Value>,
        decided: &mut Option<Decided>,
    ) -> Result<Outcome, String> {
        let verb_text = meta::write_verb(tool, args).unwrap_or_default().to_owned();
        let verb = Verb::parse(&verb_text).ok_or_else(|| {
            format!(
                "error: no verb \"{verb_text}\". verbs: {}.",
                do_verbs().join(", ")
            )
        })?;
        if tool == "do" && matches!(verb, Verb::Create | Verb::Edit) {
            return Err(format!(
                "error: {} is a tool of its own; send {}(…), not do(verb={}).",
                verb.spec().name,
                verb.spec().name,
                verb.spec().name
            ));
        }
        let more = arg_bool(args, "more")?.unwrap_or(false);
        let extra = act_args(args.get("args"))?;
        if tool == "do" && extra.len() > 1 {
            return Err(format!(
                "error: do takes at most one argument; {} got {}: {}.",
                verb.spec().name,
                extra.len(),
                extra.keys().cloned().collect::<Vec<_>>().join(", ")
            ));
        }
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
            // A WRITE ON THE RESULT OF A FIND BY NAME that holds several rows is the by-name write
            // the one safety check (SPEC §3.3) is for: the eight tools' writes carry no selector, so
            // the check is made where the rows come from
            if !self.lenient()
                && keys.len() > 1
                && let Some(handle) = args
                    .get("rows")
                    .map(crate::native::session::handle_list)
                    .and_then(|parts| match parts.as_slice() {
                        [only] => only.strip_prefix('@')?.parse::<usize>().ok(),
                        _ => None,
                    })
                    .filter(|handle| self.result_named.contains(handle))
            {
                let what = self.result_whats.get(&handle).cloned().unwrap_or_default();
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
            let guess_ok = !matches!(verb, Verb::Delete | Verb::RemoveFrom | Verb::Reveal)
                && self.said_every_row().is_none();
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
        let mut live: Vec<Key> = keys.to_vec();
        live.sort_by_key(|key| {
            let days = self
                .world
                .row(key)
                .and_then(|row| row.date)
                .map(|stamp| (stamp.date - today).get_days().unsigned_abs());
            (days.is_none(), days)
        });
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

    /// WHETHER THE VERB CAN CHANGE EACH ROW as it stands (SPEC §14.1): the
    /// verb would leave the row different. `complete` an open task, `restore`
    /// a trashed row, `delete` a live one, `star` an unstarred row, `unstar`
    /// a starred one, and for every other verb the
    /// write's own already-so test: `cancel` an event not cancelled, `add_to`
    /// a row that is not a member, `reopen` a task not open, an `edit` that
    /// changes a field (the pin of a pinned note is no change), `reveal` an item that has the field asked for.
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
                Verb::Restore => yes(row.trashed),
                Verb::Delete => yes(!row.trashed),
                Verb::Star => yes(!row.starred()),
                Verb::Unstar => yes(row.starred()),
                _ => {
                    // Planning names rows (`named`), which would put them in
                    // the conversation's focus: the filter leaves no trace.
                    let acted = self.acted.clone();
                    let planned = self.plan(verb, &row, extra);
                    self.acted = acted;
                    match planned {
                        Ok(Plan::Run { .. }) => Fit::Yes,
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
        let kept: Vec<Key> = self
            .fits(verb, keys, extra)
            .into_iter()
            .filter_map(|(key, fit)| (fit != Fit::No).then_some(key))
            .collect();
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
        let not_undoable = Vec::new();
        let notes = Vec::new();
        let mut failure = None;
        let mut touched: Vec<Key> = Vec::new();
        let offered: Vec<MemberAction> = Vec::new();
        let offered_rows: Vec<Key> = Vec::new();
        for (key, plan) in plans {
            match plan {
                Plan::Already(state) => {
                    let name = self.named(&key);
                    already_lines.push(format!("already: {name} {state}"));
                    already_keys.push(key.clone());
                    already.push(json!({"kind": key.0.name(), "id": key.1, "n": self.numbers.get(&key), "state": state}));
                }
                Plan::Run { steps, inverse } => {
                    let mut outputs = Vec::new();
                    for step in steps {
                        let ran = self.write_step(&step.act, &step.input)?;
                        if !ran.ok {
                            // NOTHING HAS LANDED YET, so the runtime can end the
                            // turn itself (D-1044-10): an ask when the person can still
                            // act on it (`Session::refusal`).
                            if touched.is_empty()
                                && outputs.is_empty()
                                && let Some(ended) =
                                    self.refusal(verb, &key, (step.act.command, &step.input), &ran)
                            {
                                return Ok(ended);
                            }
                            let name = self.named(&key);
                            let reason = ran.reason.unwrap_or_default();
                            failure = Some(format!(
                                "error: {} {name} was refused: {reason}",
                                verb.spec().name
                            ));
                            break;
                        }
                        outputs.push(ran.output);
                    }
                    if failure.is_some() {
                        break;
                    }
                    touched.push(key.clone());
                    for step in inverse {
                        inverses.push(Inverse {
                            act: step.act,
                            input: step.input,
                            key: key.clone(),
                        });
                    }
                }
            }
        }
        if let Some(created) = &created {
            touched.push(created.clone());
        }
        self.settle()?;
        let diff = self.diff_since(&before);
        let mut lines = Vec::new();
        let mut shown_lines: Vec<(Key, usize, String)> = Vec::new();
        let mut shown_changes: Vec<RowChange> = Vec::new();
        self.mark_acted(&touched);
        self.mark_acted(&already_keys);
        for (shown, key) in touched.iter().enumerate() {
            let n = self.number(key);
            self.acted.insert(n);
            if verb != Verb::Reveal && shown < ROW_CAP && !offered_rows.contains(key) {
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
        if !offered.is_empty() {
            // THE TURN ENDS IN THE MEMBER'S CARD (#1135): what was offered, never a value.
            outcome.effect.insert(
                "member_actions".to_owned(),
                Value::Array(
                    offered
                        .iter()
                        .map(crate::native::member::MemberAction::to_json)
                        .collect(),
                ),
            );
            outcome.ends_turn = true;
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

    /// What changed since `before`.
    pub(crate) fn diff_since(&self, before: &World) -> Diff {
        diff(before, &self.world)
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
                if let Some(names) = self.sealed_moves.get(&key.1) {
                    for name in names {
                        let line = format!("{name} changed (sealed)");
                        if !parts.contains(&line) {
                            parts.push(line);
                        }
                    }
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
        let fields: Vec<FieldChange> = match (old, new) {
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
            date_label,
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
        // THE ONE LOOKUP: the manifest action chat runs for this verb on this kind
        let action = verb
            .action(kind)
            .ok_or_else(|| not_applicable(verb, kind))?;
        let target = || json!({ action.id_param: id.clone() });
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
        let run = |steps: Vec<Step>, inverse: Vec<Step>| Plan::Run { steps, inverse };
        Ok(match verb {
            Verb::Delete | Verb::Restore => {
                check_args(&[])?;
                if verb == Verb::Delete && row.trashed {
                    return Ok(Plan::Already("is in the trash".to_owned()));
                }
                if verb == Verb::Restore && !row.trashed {
                    return Ok(Plan::Already("is not in the trash".to_owned()));
                }
                // EVERY KIND COMES BACK THE SAME WAY: a trashed row, and what went to the trash
                // with it, is restored by the action the manifest names as the delete's inverse
                // (the vault's own `entity.restore`, a Locker item's by its own); the album,
                // notebook or folder a delete takes out of the model included.
                let back = action.inverse.ok_or_else(|| not_applicable(verb, kind))?;
                let input = json!({ back.id_param: id });
                run(
                    vec![Step::of(action, target())],
                    vec![Step {
                        act: back.call(),
                        input,
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
                let back = action.inverse.ok_or_else(|| not_applicable(verb, kind))?;
                // a flag is named by the verb
                let input = json!({"id": id, "flag": verb.spec().flag.unwrap_or("starred")});
                run(
                    vec![Step::of(action, input.clone())],
                    vec![Step {
                        act: back.call(),
                        input,
                    }],
                )
            }
            // A VERB NO BESPOKE PLANNER OWNS is the catalog's: its action runs with the args chat
            // stated, and the action the manifest names as its inverse takes it back.
            Verb::Tag | Verb::Untag | Verb::Archive | Verb::Unarchive => {
                self.plan_catalog(verb, row, args, action)?
            }
            Verb::Create | Verb::Undo => unreachable!("handled by the caller"),
            Verb::Complete
            | Verb::Reopen
            | Verb::Cancel
            | Verb::AddTo
            | Verb::RemoveFrom
            | Verb::Log
            | Verb::Unlink
            | Verb::Reveal
            | Verb::Reschedule
            | Verb::Edit
            | Verb::Link
            | Verb::Merge
            | Verb::Purge
            | Verb::Import
            | Verb::Duplicate
            | Verb::Attach
            | Verb::Detach
            | Verb::Respond
            | Verb::Categorize
            | Verb::Apply => return Err(not_applicable(verb, kind)),
        })
    }

    /// A verb the catalog backs and no bespoke planner owns (`tag`, `archive`): the manifest
    /// action runs with each arg chat stated under a name the action's input says it by (`label`),
    /// the properties that can only take one value filled in, and the manifest's inverse takes it
    /// back with the same input.
    fn plan_catalog(
        &self,
        verb: Verb,
        row: &Row,
        args: &Map<String, Value>,
        action: &'static ActionSpec,
    ) -> Result<Plan, String> {
        let names = action.chat_names();
        let mut stated: Vec<(&str, Value)> = Vec::new();
        for (key, value) in args {
            if action.property_named(key).is_none() {
                return Err(format!(
                    "error: {} takes {}; not \"{key}\".",
                    verb.spec().name,
                    if names.is_empty() {
                        "no args".to_owned()
                    } else {
                        format!("args {}", names.join(", "))
                    }
                ));
            }
            stated.push((key.as_str(), json!(text_of(value).trim())));
        }
        for required in action.required {
            let said = stated
                .iter()
                .any(|(name, _)| action.property_named(name) == Some(*required));
            let filled = *required == action.id_param
                || said
                || (*required == "flag" && verb.spec().flag.is_some())
                || action.minted.contains(required)
                || action
                    .consts
                    .iter()
                    .chain(action.defaults)
                    .any(|(p, _)| p == required);
            if !filled {
                let name = action
                    .aliases
                    .iter()
                    .find(|(property, _)| property == required)
                    .and_then(|(_, names)| names.first().copied())
                    .unwrap_or(required);
                return Err(format!("error: {} needs {name}: <text>.", verb.spec().name));
            }
        }
        let mut input = input_of(action, &row.id, &stated);
        if let (Some(flag), true) = (verb.spec().flag, action.takes("flag")) {
            input["flag"] = json!(flag);
        }
        let back = action
            .inverse
            .ok_or_else(|| not_applicable(verb, row.kind))?;
        Ok(Plan::Run {
            steps: vec![Step::of(action, input.clone())],
            inverse: vec![Step {
                act: back.call(),
                input,
            }],
        })
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

    // -----------------------------------------------------------------
    // create
    // -----------------------------------------------------------------

    fn create(&mut self, kind: Option<&str>, args: &Map<String, Value>) -> Result<Outcome, String> {
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
        // THE ONE LOOKUP: the action that creates this kind, and the names its input says things as
        let action = Verb::Create
            .action(kind)
            .ok_or_else(|| not_applicable(Verb::Create, kind))?;
        let allowed = meta::create_args(kind);
        // an arg under another spelling of a field is that field (`due` is a task's `date`)
        let mut spelled = args.clone();
        for key in args.keys() {
            if let Some(field) = meta::create_arg_canonical(kind, key)
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
        let mint = || self.door.mint_id();
        let input = input_of(action, &mint(), &[("name", json!(name))]);
        let id_out = action.id_param;
        let before = self.world.clone();
        let ran = self.write_step(&action.call(), &input)?;
        if !ran.ok {
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
        let inverse = match Verb::Delete.action(kind) {
            Some(delete) => vec![Inverse {
                act: delete.call(),
                input: json!({ delete.id_param: id }),
                key: key.clone(),
            }],
            None => Vec::new(),
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
        let outcome = self.execute(Verb::Create, Vec::new(), Some(key.clone()))?;
        self.record(inverse, not_undoable);
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
            let ran = self.write_step(&inverse.act, &inverse.input)?;
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
        let diff = self.diff_since(&before);
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
    /// - A `delete` the vault refuses because the row still holds others (a
    ///   folder with documents, a notebook with notebooks) ends in an ask that names what the person can do
    ///   (`refusal_question`).
    ///
    /// With `Flags::compose` the refusals a confirmation or a choice can lift end in an ask
    /// over the rows involved (`refusal_question`): a cancelled event to reschedule
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
        (command, _): (&str, &Value),
        ran: &Ran,
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
        let (question, options) = self.refusal_question(key, command, predicate)?;
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
        let mut outcome = {
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
        predicate: &str,
    ) -> Option<(String, Vec<Key>)> {
        let row_name = self
            .world
            .row(key)
            .map(|row| row.name.clone())
            .unwrap_or_default();
        Some(match (command, predicate) {
            ("event.edit", "event_exists_not_cancelled") => (
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

/// `field old → new` for one row.
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
                text: format!("{name} changed (sealed)"),
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
