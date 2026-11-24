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
use crate::native::member::{ActionKind, MemberAction};
use crate::native::meta::{self, ActionSpec, FieldType, Kind, ROW_CAP, Verb, Via};
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

/// An irreversible write (`purge`, `empty_trash`, `merge`, `unfollow`, `delete` on a rule)
/// that the runtime asked confirmation for before running (`Session::confirm_ask`).
#[derive(Debug, Clone)]
pub(crate) struct PendingConfirm {
    pub turn: usize,
    pub verb: Verb,
    pub kind: Option<Kind>,
    pub keys: BTreeSet<Key>,
    pub args: String,
}

/// Which container a kind goes into with `add_to`.
#[must_use]
pub fn container_of(kind: Kind) -> Option<Kind> {
    Some(match kind {
        Kind::Photo => Kind::Album,
        Kind::Note => Kind::Notebook,
        Kind::Document => Kind::Folder,
        Kind::Task => Kind::List,
        Kind::Person => Kind::PeopleList,
        _ => return None,
    })
}

fn split_verb_qualifier(raw: &str) -> Option<(Verb, Option<String>)> {
    if let Some(verb) = Verb::parse(raw) {
        return Some((verb, None));
    }
    let (base, qual) = raw.split_once(':')?;
    let verb = Verb::parse(base.trim())?;
    let qual = qual.trim().to_lowercase();
    (!qual.is_empty()).then_some((verb, Some(qual)))
}

fn handoff_action(action: &'static ActionSpec, item_id: &str) -> MemberAction {
    MemberAction {
        kind: ActionKind::Handoff,
        item_id: item_id.to_owned(),
        column: format!(
            "{}/{}/{}",
            action.app,
            action.kind.spec().entity,
            action.action
        ),
    }
}

fn handoff_member_kind(verb: Verb, kind: Kind) -> Kind {
    match (verb, kind) {
        (Verb::Export | Verb::Import | Verb::Follow, Kind::Album) => Kind::Photo,
        (Verb::Export | Verb::Import | Verb::Follow, Kind::Notebook) => Kind::Note,
        (Verb::Export | Verb::Import | Verb::Follow, Kind::Folder) => Kind::Document,
        (Verb::Export | Verb::Import | Verb::Follow, Kind::List) => Kind::Task,
        (Verb::Export | Verb::Import | Verb::Follow, Kind::Calendar) => Kind::Event,
        (Verb::Export | Verb::Import, Kind::Account) => Kind::Transaction,
        (Verb::Export | Verb::Import | Verb::Follow, Kind::PeopleList) => Kind::Person,
        (Verb::Configure, Kind::LockerItem) => Kind::LockerPasskey,
        _ => kind,
    }
}

fn is_confirm_required(verb: Verb, kind: Kind) -> bool {
    matches!(
        verb,
        Verb::Purge | Verb::EmptyTrash | Verb::Merge | Verb::Unfollow
    ) || (verb == Verb::Delete && kind == Kind::Rule)
}

fn allow_multi_arg_do(verb: Verb, qualifier: Option<&str>, extra: &Map<String, Value>) -> bool {
    matches!(
        verb,
        Verb::Recolor
            | Verb::Unfollow
            | Verb::EmptyTrash
            | Verb::Export
            | Verb::Import
            | Verb::Follow
            | Verb::EditMedia
            | Verb::Configure
            | Verb::Link
            | Verb::Unlink
    ) || (verb == Verb::Log && (extra.contains_key("balance") || extra.contains_key("day")))
        || (verb == Verb::Tag && extra.contains_key("color"))
        || (verb == Verb::Edit && qualifier.is_some())
        || (verb == Verb::Reschedule
            && (qualifier == Some("occurrence")
                || extra.contains_key("occurrence")
                || extra.contains_key("original_start")
                || extra.contains_key("scope")
                || extra.contains_key("action")))
}

/// The refusal for a verb no action serves on a kind.
fn not_applicable(verb: Verb, kind: Kind) -> String {
    format!(
        "error: {} does not apply to {}.",
        verb.spec().name,
        kind.name()
    )
}

/// The refusal for a membership verb on a kind that is in no container.
fn not_container_verb(verb: Verb, row: &Row) -> String {
    not_applicable(verb, row.kind)
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

fn val_str(value: &Val) -> Option<&str> {
    match value {
        Val::Text(s) => Some(s.as_str()),
        Val::Enum(s) => Some(*s),
        _ => None,
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

    /// A step no manifest action names yet: the bare vault command.
    fn bare(command: &'static str, input: Value) -> Self {
        Self {
            act: Call::bare(command),
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
        not_undoable: Option<String>,
        note: Option<String>,
    },
    /// A secret action only the member completes (#1135): nothing runs, the turn ends in a card.
    Offer {
        actions: Vec<MemberAction>,
        note: String,
    },
    /// A write the runtime itself will not make, with the id and the sentence of the check that
    /// says so, exactly as a refusal of the vault is read (`Session::refusal`): the rule is the
    /// assistant's, the product is the same (a cancelled event is not moved: plan a new one).
    Refused {
        command: &'static str,
        input: Value,
        predicate: &'static str,
        reason: String,
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

/// The verbs `do` runs: every verb but `create` and `edit`, which are tools of their own.
#[must_use]
pub(crate) fn do_verbs() -> Vec<&'static str> {
    meta::VERBS
        .iter()
        .map(|spec| spec.name)
        .filter(|name| !matches!(*name, "create" | "edit"))
        .collect()
}

type TxnSnapshot = (String, i64, Option<String>, String);

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
        let (verb, qualifier) = split_verb_qualifier(&verb_text).ok_or_else(|| {
            format!(
                "error: no verb \"{verb_text}\". verbs: {}.",
                do_verbs().join(", ")
            )
        })?;
        if tool == "do" && matches!(verb, Verb::Create | Verb::Edit) && qualifier.is_none() {
            return Err(format!(
                "error: {} is a tool of its own; send {}(…), not do(verb={}).",
                verb.spec().name,
                verb.spec().name,
                verb.spec().name
            ));
        }
        let more = arg_bool(args, "more")?.unwrap_or(false);
        let mut extra = act_args(args.get("args"))?;
        if verb == Verb::Recolor
            && extra.len() == 1
            && let Some(raw_label) = extra.get("label").map(text_of)
            && let Some((lbl, col)) = raw_label
                .split_once(", color:")
                .or_else(|| raw_label.split_once(",color:"))
        {
            extra.insert("label".to_owned(), json!(lbl.trim()));
            extra.insert("color".to_owned(), json!(col.trim()));
        }
        if tool == "do"
            && extra.len() > 1
            && !allow_multi_arg_do(verb, qualifier.as_deref(), &extra)
        {
            return Err(format!(
                "error: do takes at most one argument; {} got {}: {}.",
                verb.spec().name,
                extra.len(),
                extra.keys().cloned().collect::<Vec<_>>().join(", ")
            ));
        }
        let (verb, extra, redirected) = self.redirect_verb(verb, args, extra);
        let mut logged: Vec<Key> = Vec::new();
        let has_rows_param = args.get("rows").is_some_and(|v| !v.is_null());
        let has_row_selector = meta::SELECTOR_PARAMS
            .iter()
            .any(|p| *p != "kind" && args.get(*p).is_some_and(|v| !v.is_null()));
        let rowless = !has_rows_param && !has_row_selector;
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
                self.create_qualified(kind.as_deref(), qualifier.as_deref(), &extra, &[])?
            }
            Verb::EmptyTrash if rowless => self.run_empty_trash(args, &extra)?,
            Verb::Recolor if rowless => self.run_recolor(&extra)?,
            Verb::Unfollow if rowless => self.run_unfollow(args, &extra)?,
            Verb::Apply if rowless => self.run_apply_rules(&extra)?,
            Verb::Export | Verb::Import | Verb::Follow | Verb::Configure if rowless => {
                self.run_handoff_app(verb, args, &extra)?
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
                    && qualifier.is_none()
                    && !extra.contains_key("occurrence")
                    && !extra.contains_key("original_start")
                    && !extra.contains_key("scope")
                    && !extra.contains_key("action")
                    && let [only] = targets.as_slice()
                    && let Some(planned) = self.plan_anew(only, &extra)?
                {
                    return Ok(planned);
                }
                let count = targets.len();
                if verb == Verb::Log {
                    logged.clone_from(&targets);
                }
                let mut written =
                    self.write_qualified(verb, qualifier.as_deref(), &targets, &extra)?;
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
        // A TURN THE RUNTIME ENDED BY ITSELF (a refusal composed in `execute`, or a member action) is
        // not paged: `more` does not keep it open.
        if outcome.ends_turn
            && (outcome.effect.contains_key("tool")
                || outcome.effect.contains_key("member_actions"))
        {
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
                (Some("date"), kind)
                    if kind.is_none_or(|k| Verb::Reschedule.command(k).is_some()) =>
                {
                    Some((Verb::Reschedule, {
                        let mut to = Map::new();
                        to.insert("to".to_owned(), (*value).clone());
                        to
                    }))
                }
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
        if !matches!(
            verb,
            Verb::Undo
                | Verb::Create
                | Verb::Unlink
                | Verb::Apply
                | Verb::EmptyTrash
                | Verb::Export
                | Verb::Import
                | Verb::Follow
                | Verb::EditMedia
                | Verb::Configure
        ) && verb.spec().args.is_empty()
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
        // a restore or purge is of the trashed rows, whether or not the call says `trashed`: the trashed
        // rows the name reaches as it is said come before a live row it reaches less well
        if matches!(verb, Verb::Restore | Verb::Purge) && !selector.trashed {
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
            // the writes a guess must not make stay the ask: a delete, purge or a removal (destructive),
            // money, a secret (egress), and a write the message says takes every row
            let guess_ok = !matches!(
                verb,
                Verb::Delete | Verb::Purge | Verb::RemoveFrom | Verb::Reveal
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
                Verb::Complete => {
                    yes(task_stand(verb, status_of(row.field("status"))) == Stand::Changes)
                }
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
                        Ok(Plan::Run { .. } | Plan::Offer { .. } | Plan::Refused { .. }) => {
                            Fit::Yes
                        }
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

    fn write_qualified(
        &mut self,
        verb: Verb,
        qualifier: Option<&str>,
        targets: &[Key],
        args: &Map<String, Value>,
    ) -> Result<Outcome, String> {
        let mut plans = Vec::new();
        for key in targets {
            let effective_kind = handoff_member_kind(verb, key.0);
            let has_command = meta::lookup(verb, effective_kind, qualifier).is_some()
                || verb.command(effective_kind).is_some()
                || (verb == Verb::Edit
                    && matches!(key.0, Kind::Rule | Kind::LockerField | Kind::ContactPoint));
            if !has_command {
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
            let occurrence_edit = verb == Verb::Reschedule
                && (qualifier == Some("occurrence")
                    || args.contains_key("occurrence")
                    || args.contains_key("original_start")
                    || args.contains_key("scope")
                    || args.contains_key("action"));
            // ONE OCCURRENCE OF A REPEATING EVENT (`World::read_event_window`): the vault changes a
            // series, or an exception to it; `reschedule:occurrence` edits one occurrence, while
            // other direct edits on an occurrence are refused.
            if row.extra.contains_key("series") && !occurrence_edit {
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
            // WHAT THE HEALTH STORE STATES is the store's: the turn ends in its sentence (the
            // vault says the same words, but only after a tap on a card that could not land)
            if (verb == Verb::Edit || (verb == Verb::Delete && row.kind == Kind::DailyFigure))
                && let Some(sentence) = self.store_states(&row)
            {
                let refusal = format!("error: {sentence} Nothing was done.");
                if self.flags.compose {
                    return Ok(self.compose_declined_write(
                        verb,
                        key,
                        &refusal,
                        "store_states",
                        "out_of_scope",
                    ));
                }
                return Err(refusal);
            }
            if row.trashed
                && !matches!(
                    verb,
                    Verb::Restore | Verb::Delete | Verb::Purge | Verb::EmptyTrash
                )
            {
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
            let planned = self.plan_qualified(verb, qualifier, &row, args);
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
        if targets.iter().any(|key| is_confirm_required(verb, key.0))
            && plans
                .iter()
                .any(|(_, plan)| matches!(plan, Plan::Run { .. }))
            && !self.confirmed_action(verb, None, targets, args)
        {
            return Ok(self.confirm_ask(verb, None, targets, args));
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
        let mut offered: Vec<MemberAction> = Vec::new();
        let mut offered_rows: Vec<Key> = Vec::new();
        for (key, plan) in plans {
            match plan {
                Plan::Refused {
                    command,
                    input,
                    predicate,
                    reason,
                } => {
                    let ran = Ran {
                        ok: false,
                        output: Value::Null,
                        reason: Some(reason.to_owned()),
                        predicate: Some(predicate.to_owned()),
                        inverse: None,
                    };
                    if touched.is_empty()
                        && let Some(ended) = self.refusal(verb, &key, (command, &input), &ran)
                    {
                        return Ok(ended);
                    }
                    let name = self.named(&key);
                    failure = Some(format!(
                        "error: {} {name} was refused: {reason}",
                        verb.spec().name
                    ));
                    break;
                }
                Plan::Offer { actions, note } => {
                    touched.push(key.clone());
                    offered_rows.push(key.clone());
                    offered.extend(actions);
                    notes.push(note);
                }
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
                    let mut extra_keys = Vec::new();
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
                        if step.act.command == "locker.duplicate_item"
                            && let Some(new_id) =
                                step.input.get("new_item_id").and_then(Value::as_str)
                        {
                            extra_keys.push((Kind::LockerItem, new_id.to_owned()));
                        }
                        outputs.push(ran.output);
                    }
                    if failure.is_some() {
                        break;
                    }
                    touched.push(key.clone());
                    for extra_key in extra_keys {
                        if !touched.contains(&extra_key) {
                            touched.push(extra_key);
                        }
                    }
                    for step in inverse {
                        inverses.push(Inverse {
                            act: step.act,
                            input: step.input,
                            key: key.clone(),
                        });
                    }
                    if let Some(reason) = undoable_note {
                        let name = self.named(&key);
                        not_undoable.push(format!("{name}: {reason}"));
                    }
                    if let Some(note) = note {
                        notes.push(note);
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

    /// What changed since `before`, a typed secret included: the world holds a sealed cell as a
    /// presence bit, so the sealed fields a call set (`sealed_moves`) are added by name, never by
    /// value (#1135).
    pub(crate) fn diff_since(&self, before: &World) -> Diff {
        let mut changed = diff(before, &self.world);
        for (item, names) in &self.sealed_moves {
            let key = (Kind::LockerItem, item.clone());
            let was = before.row(&key).map(sealed_cells).unwrap_or_default();
            let mut fields = Map::new();
            for name in names {
                let from = if was.contains_key(name) {
                    json!(SEALED)
                } else {
                    Value::Null
                };
                fields.insert((*name).to_owned(), json!([from, SEALED]));
            }
            match changed.rows.iter_mut().find(|(row, ..)| *row == key) {
                Some((_, _, existing)) => {
                    if let Some(existing) = existing.as_object_mut() {
                        existing.extend(fields);
                    }
                }
                None if self.world.row(&key).is_some() => {
                    changed.rows.push((key, "updated", Value::Object(fields)));
                }
                None => {}
            }
        }
        changed
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
        let mut fields: Vec<FieldChange> = match (old, new) {
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
        // A SECRET THE MEMBER TYPED shows on the card masked: the world holds only its presence.
        if key.0 == Kind::LockerItem {
            for step in &self.park.steps {
                if !matches!(step.act.command, "locker.add_item" | "locker.edit_item")
                    || step.input["item_id"].as_str() != Some(key.1.as_str())
                {
                    continue;
                }
                for (name, column) in meta::REVEAL_FIELDS {
                    if crate::native::member::typed_secrets(
                        &json!({ *column: step.input[*column].clone() }),
                    )
                    .is_empty()
                    {
                        continue;
                    }
                    let name = if *column == "content" { "notes" } else { *name };
                    fields.retain(|change| change.field != name);
                    fields.push(FieldChange {
                        field: name.to_owned(),
                        from: None,
                        to: Some("••••".to_owned()),
                    });
                }
            }
        }
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
        self.plan_qualified(verb, None, row, args)
    }

    /// Plan one verb (optionally qualified, e.g. `edit:content`, `reschedule:occurrence`) on one row.
    fn plan_qualified(
        &mut self,
        verb: Verb,
        qualifier: Option<&str>,
        row: &Row,
        args: &Map<String, Value>,
    ) -> Result<Plan, String> {
        let kind = row.kind;
        let id = row.id.clone();
        let effective_kind = handoff_member_kind(verb, kind);
        let qualified_action = qualifier
            .and_then(|q| meta::lookup(verb, effective_kind, Some(q)))
            .or_else(|| {
                (verb == Verb::Edit && kind == Kind::Document && args.contains_key("content"))
                    .then(|| meta::lookup(Verb::Edit, Kind::Document, Some("content")))
                    .flatten()
            });
        let action_opt = qualified_action.or_else(|| verb.action(effective_kind));
        if let Some(handoff) = action_opt.filter(|spec| spec.is_handoff()) {
            let item_id = if matches!(
                handoff.action,
                "replace" | "edit-photo" | "set-passkey" | "save-import-profile"
            ) {
                id.as_str()
            } else {
                ""
            };
            let name = self.named(&(kind, id.clone()));
            return Ok(Plan::Offer {
                actions: vec![handoff_action(handoff, item_id)],
                note: format!("offered to the member: {} {name}", verb.spec().name),
            });
        }
        // Edit on sidecar kinds (Rule, LockerField, ContactPoint) may not have a single manifest `Verb::Edit` lookup without qualifier.
        if verb == Verb::Edit && matches!(kind, Kind::Rule | Kind::LockerField | Kind::ContactPoint)
        {
            return self.plan_edit_qualified(qualifier, row, args);
        }
        // THE ONE LOOKUP: the manifest action chat runs for this verb on this kind
        let action = action_opt.ok_or_else(|| not_applicable(verb, kind))?;
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
                let want = if verb == Verb::Complete {
                    "completed"
                } else {
                    "open"
                };
                if task_stand(verb, old) == Stand::Already {
                    let when = row
                        .field("completed")
                        .map(|value| format!(" ({})", value.show(None)))
                        .unwrap_or_default();
                    return Ok(Plan::Already(format!("is {want}{when}")));
                }
                // closing, reopening and cancelling are three actions; the undo is the action of
                // the status the row had
                let back = Kind::Task
                    .spec()
                    .field("status")
                    .and_then(|field| field.vault_value(old))
                    .and_then(meta::task_status_verb)
                    .and_then(|verb| verb.action(Kind::Task))
                    .unwrap_or(action);
                run(
                    vec![Step::of(action, target())],
                    vec![Step::of(back, json!({ back.id_param: id }))],
                )
            }
            Verb::Cancel => {
                check_args(&[])?;
                if row.field("status") == Some(&Val::Enum("cancelled")) {
                    return Ok(Plan::Already("is cancelled".to_owned()));
                }
                // an edit of the status puts the event back as it was
                let old = Kind::Event
                    .spec()
                    .field("status")
                    .and_then(|field| {
                        row.field("status").and_then(|value| match value {
                            Val::Enum(model) => field.vault_value(model),
                            _ => None,
                        })
                    })
                    .unwrap_or("confirmed");
                let edit = Verb::Edit
                    .action(Kind::Event)
                    .ok_or_else(|| not_applicable(Verb::Edit, Kind::Event))?;
                run(
                    vec![Step::of(action, target())],
                    vec![Step::of(
                        edit,
                        input_of(edit, &id, &[("status", json!(old))]),
                    )],
                )
            }
            Verb::Delete | Verb::Restore => {
                check_args(&[])?;
                if verb == Verb::Delete && row.trashed {
                    return Ok(Plan::Already("is in the trash".to_owned()));
                }
                if verb == Verb::Restore && !row.trashed {
                    return Ok(Plan::Already("is not in the trash".to_owned()));
                }
                if verb == Verb::Delete {
                    match kind {
                        Kind::Rule => {
                            return Ok(Plan::Run {
                                steps: vec![Step {
                                    act: Call::bare("rule.delete"),
                                    input: json!({ "id": id }),
                                }],
                                inverse: Vec::new(),
                                not_undoable: Some("a deleted rule cannot be restored".to_owned()),
                                note: None,
                            });
                        }
                        Kind::LockerField => {
                            let item_id = row
                                .extra
                                .get("item_id")
                                .cloned()
                                .ok_or("error: locker field is missing its item id")?;
                            let can_restore = row
                                .field("field_kind")
                                .and_then(val_str)
                                .is_some_and(|fk| !matches!(fk, "sealed" | "otp"));
                            let inverse = if can_restore {
                                let mut back_input = json!({
                                    "item_id": item_id,
                                    "field_id": id,
                                    "section": row.field("section").and_then(val_str).unwrap_or("custom"),
                                    "label": row.name,
                                    "kind": row.field("field_kind").and_then(val_str).unwrap_or("text"),
                                });
                                if let Some(val) = row.field("value").and_then(val_str) {
                                    back_input["value"] = json!(val);
                                }
                                vec![Step {
                                    act: Call::bare("locker.set_field"),
                                    input: back_input,
                                }]
                            } else {
                                Vec::new()
                            };
                            return Ok(Plan::Run {
                                steps: vec![Step {
                                    act: Call::bare("locker.remove_field"),
                                    input: json!({ "item_id": item_id, "field_id": id }),
                                }],
                                not_undoable: inverse.is_empty().then(|| {
                                    "a removed sealed locker field cannot be restored".to_owned()
                                }),
                                inverse,
                                note: None,
                            });
                        }
                        Kind::LockerPasskey => {
                            return Ok(Plan::Run {
                                steps: vec![Step {
                                    act: Call::bare("locker.clear_passkey"),
                                    input: json!({ "item_id": id }),
                                }],
                                inverse: Vec::new(),
                                not_undoable: Some(
                                    "a cleared passkey cannot be restored".to_owned(),
                                ),
                                note: None,
                            });
                        }
                        Kind::ContactPoint => {
                            let person_id = row
                                .extra
                                .get("person_id")
                                .cloned()
                                .or_else(|| {
                                    row.field("person_id").and_then(val_str).map(str::to_owned)
                                })
                                .ok_or("error: contact point is missing its person id")?;
                            let channel = row.field("channel").and_then(val_str).unwrap_or("phone");
                            let inverse = vec![Step {
                                act: Call::bare("person.save_contact_point"),
                                input: json!({
                                    "id": person_id,
                                    "point_id": id,
                                    "kind": channel,
                                    "value": row.name,
                                    "label": row.field("label").and_then(val_str),
                                    "preferred": matches!(row.field("preferred"), Some(Val::Bool(true))),
                                }),
                            }];
                            return Ok(Plan::Run {
                                steps: vec![Step {
                                    act: Call::bare("person.remove_contact_point"),
                                    input: json!({ "point_id": id }),
                                }],
                                inverse,
                                not_undoable: None,
                                note: None,
                            });
                        }
                        _ => {}
                    }
                }
                if let Some(back) = action.inverse {
                    let mut input = json!({ back.id_param: id });
                    if kind == Kind::DailyFigure && verb == Verb::Delete {
                        input["value"] = json!(self.figure_value(row)?);
                    }
                    run(
                        vec![Step::of(action, target())],
                        vec![Step {
                            act: back.call(),
                            input,
                        }],
                    )
                } else {
                    Plan::Run {
                        steps: vec![Step::of(action, target())],
                        inverse: Vec::new(),
                        not_undoable: Some(format!("{} cannot be undone", verb.spec().name)),
                        note: None,
                    }
                }
            }
            Verb::Purge => {
                check_args(&[])?;
                Plan::Run {
                    steps: vec![Step::of(action, target())],
                    inverse: Vec::new(),
                    not_undoable: Some("a purge cannot be undone".to_owned()),
                    note: None,
                }
            }
            Verb::EmptyTrash => {
                check_args(&["due_only"])?;
                let mut input = json!({ "kind": kind.spec().entity });
                if kind == Kind::Workout {
                    input["kind"] = json!("activity");
                    input["having"] = json!("workout");
                }
                if let Some(due_only) = args.get("due_only").and_then(Value::as_bool) {
                    input["due_only"] = json!(due_only);
                }
                Plan::Run {
                    steps: vec![Step {
                        act: Call::bare("entity.empty_trash"),
                        input,
                    }],
                    inverse: Vec::new(),
                    not_undoable: Some("emptying the trash cannot be undone".to_owned()),
                    note: None,
                }
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
            Verb::AddTo | Verb::RemoveFrom => self.plan_membership(verb, row, args)?,
            // A VERB NO BESPOKE PLANNER OWNS is the catalog's: its action runs with the args chat
            // stated, and the action the manifest names as its inverse takes it back.
            Verb::Tag | Verb::Untag | Verb::Archive | Verb::Unarchive => {
                self.plan_catalog(verb, row, args, action)?
            }
            Verb::Recolor => {
                check_args(&["label", "color"])?;
                let label = args
                    .get("label")
                    .map(text_of)
                    .filter(|s| !s.is_empty())
                    .ok_or("error: recolor needs label and color.")?;
                let color = args
                    .get("color")
                    .map(text_of)
                    .filter(|s| !s.is_empty())
                    .ok_or("error: recolor needs color.")?
                    .to_lowercase();
                Plan::Run {
                    steps: vec![Step {
                        act: Call::bare("tag.color"),
                        input: json!({ "label": label, "color": color }),
                    }],
                    inverse: Vec::new(),
                    not_undoable: Some("tag color change stays until recolored again".to_owned()),
                    note: None,
                }
            }
            Verb::Log => {
                if kind == Kind::Account {
                    check_args(&["balance", "day"])?;
                    let currency = row
                        .field("currency")
                        .and_then(val_str)
                        .unwrap_or(&self.world.currency);
                    let raw_balance = args
                        .get("balance")
                        .ok_or("error: log on an account needs balance: <amount>.")?;
                    let minor = parse_money_in_currency(&text_of(raw_balance), currency)?;
                    let day = match args.get("day") {
                        Some(val) => {
                            let expr = self.date_expr(val)?;
                            let resolved = dates::evaluate(&expr, self.now, None)
                                .map_err(|why| dates::rejection(&why))?;
                            let pt = resolved
                                .point()
                                .ok_or("error: checkpoint day must be a single date.")?;
                            pt.date.to_string()
                        }
                        None => self.now.date().to_string(),
                    };
                    Plan::Run {
                        steps: vec![Step {
                            act: Call::bare("checkpoint.record"),
                            input: json!({
                                "account_id": id,
                                "day": day,
                                "balance_minor": minor,
                            }),
                        }],
                        inverse: Vec::new(),
                        not_undoable: Some("a balance checkpoint stays in the vault".to_owned()),
                        note: None,
                    }
                } else {
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
                        steps: vec![Step::of(
                            action,
                            input_of(action, &id, &[("kind", json!(log))]),
                        )],
                        inverse: Vec::new(),
                        not_undoable: Some("a logged interaction stays in the vault".to_owned()),
                        note: None,
                    }
                }
            }
            Verb::Respond => self.plan_respond(row, args)?,
            Verb::Categorize => self.plan_categorize(row, args)?,
            Verb::Link | Verb::Attach => self.plan_link(verb, row, args)?,
            Verb::Unlink | Verb::Detach => self.plan_unlink(verb, row, args, action)?,
            Verb::Apply => {
                check_args(&["overwrite"])?;
                let mut input = json!({ "id": id });
                if let Some(overwrite) = args.get("overwrite").and_then(Value::as_bool) {
                    input["overwrite"] = json!(overwrite);
                }
                Plan::Run {
                    steps: vec![Step::of(action, input)],
                    inverse: Vec::new(),
                    not_undoable: Some(
                        "applying a rule updates matching transactions in the vault".to_owned(),
                    ),
                    note: None,
                }
            }
            Verb::Merge => self.plan_merge(row, args)?,
            Verb::Duplicate => {
                check_args(&[])?;
                let new_id = self.door.mint_id();
                let inverse = Step {
                    act: Call::bare("locker.trash_item"),
                    input: json!({ "item_id": new_id }),
                };
                run(
                    vec![Step::of(
                        action,
                        json!({ "item_id": id, "new_item_id": new_id }),
                    )],
                    vec![inverse],
                )
            }
            Verb::Unfollow => self.plan_unfollow(row, args)?,
            Verb::RestoreVersion => self.plan_restore_version(row, args, action)?,
            Verb::Reveal => self.plan_reveal(row, args)?,
            Verb::Reschedule => {
                if qualifier == Some("occurrence")
                    || args.contains_key("occurrence")
                    || args.contains_key("original_start")
                    || args.contains_key("scope")
                    || args.contains_key("action")
                {
                    self.plan_reschedule_occurrence(row, args)?
                } else {
                    self.plan_reschedule(row, args)?
                }
            }
            Verb::Edit => self.plan_edit_qualified(qualifier, row, args)?,
            Verb::Export | Verb::Import | Verb::Follow | Verb::EditMedia | Verb::Configure => {
                unreachable!("handoff verbs return Offer above")
            }
            Verb::Create | Verb::Undo => unreachable!("handled by the caller"),
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
            not_undoable: None,
            note: None,
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
                let expected =
                    container_of(row.kind).ok_or_else(|| not_container_verb(verb, row))?;
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
        let expected = container_of(row.kind).ok_or_else(|| not_container_verb(verb, row))?;
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
        // Where a one-place kind (note, document, task) sits now, for undo.
        let current = self
            .world
            .neighbours(&key)
            .get(&expected)
            .and_then(|keys| keys.first().cloned());
        // WHERE THE ROW GOES is the one lookup's: the action that serves `add_to` on this kind says
        // the property that names the container under the word chat says it by (`to`, or `from`
        // for a removal)
        let member = |verb: Verb, at: Option<&Key>| -> Result<Step, String> {
            let action = verb
                .action(row.kind)
                .ok_or_else(|| not_container_verb(verb, row))?;
            let slot = if verb == Verb::AddTo { "to" } else { "from" };
            Ok(Step::of(
                action,
                input_of(action, &id, &[(slot, json!(at.map(|at| at.1.clone())))]),
            ))
        };
        let place = |at: Option<&Key>| member(Verb::AddTo, at);
        // a photograph is in an album by an ordered `contains` edge, and there are as many as it
        // is in albums
        let pair = |verb: Verb| member(verb, Some(container));
        let mut planned = match row.kind {
            Kind::Photo => {
                let (add, remove) = (Verb::AddTo, Verb::RemoveFrom);
                if verb == Verb::AddTo {
                    Plan::Run {
                        steps: vec![pair(add)?],
                        inverse: vec![pair(remove)?],
                        not_undoable: None,
                        note: None,
                    }
                } else {
                    Plan::Run {
                        steps: vec![pair(remove)?],
                        inverse: vec![pair(add)?],
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
                    steps: vec![place(to)?],
                    inverse: vec![place(current.as_ref())?],
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
        if !row.extra.contains_key(column) {
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
        }
        let name = self.named(&key);
        let (kind, note) = if column == "otp_seed" {
            (
                ActionKind::Code,
                format!("offered to the member: show the code of {name}"),
            )
        } else {
            (
                ActionKind::Reveal,
                format!(
                    "offered to the member: reveal {} of {name}",
                    if column == "content" {
                        "notes"
                    } else {
                        field.as_str()
                    }
                ),
            )
        };
        Ok(Plan::Offer {
            actions: vec![MemberAction {
                kind,
                item_id: row.id.clone(),
                column: column.to_owned(),
            }],
            note,
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
                // `due: null` clears a due date, so the undo of a first date is the same command
                let action = Verb::Reschedule
                    .action(Kind::Task)
                    .ok_or_else(|| not_applicable(Verb::Reschedule, Kind::Task))?;
                let inverse = input_of(
                    action,
                    &row.id,
                    &[("date", json!(row.date.map(Stamp::vault)))],
                );
                Ok(Plan::Run {
                    steps: vec![Step::of(
                        action,
                        input_of(action, &row.id, &[("date", json!(point.vault()))]),
                    )],
                    inverse: vec![Step::of(action, inverse)],
                    not_undoable: None,
                    note: said,
                })
            }
            Kind::Event => {
                // A CANCELLED EVENT IS NOT MOVED: the person is asked whether to plan a new one
                let action = Verb::Reschedule
                    .action(Kind::Event)
                    .ok_or_else(|| not_applicable(Verb::Reschedule, Kind::Event))?;
                if row.field("status") == Some(&Val::Enum("cancelled")) {
                    return Ok(Plan::Refused {
                        command: action.command,
                        input: json!({"id": row.id}),
                        predicate: "event_exists_not_cancelled",
                        reason: "That event is not here to change.".to_owned(),
                    });
                }
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
                let times = |start, end| {
                    let mut input = event_times(row, start, end);
                    input["id"] = json!(row.id);
                    input
                };
                Ok(Plan::Run {
                    steps: vec![Step::of(action, times(start, end))],
                    inverse: vec![Step::of(action, times(old_start, old_end))],
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

    fn resolve_one_target(&mut self, value: &Value, expected: Option<Kind>) -> Result<Key, String> {
        if let Ok(keys) = self.resolve_rows(value) {
            match keys.as_slice() {
                [only] => {
                    if let Some(ek) = expected
                        && only.0 != ek
                    {
                        return Err(format!(
                            "error: expected a {}, got {}.",
                            ek.name(),
                            only.0.name()
                        ));
                    }
                    return Ok(only.clone());
                }
                [] => {}
                many => {
                    return Err(format!(
                        "error: expected one target row, matched {}.",
                        many.len()
                    ));
                }
            }
        }
        let query = text_of(value);
        if query.is_empty() {
            return Err("error: empty target.".to_owned());
        }
        let q_lower = query.to_lowercase();
        let q_norm = q_lower.replace(['.', '_', '-'], " ");
        let kinds: Vec<Kind> = expected
            .map(|k| vec![k])
            .unwrap_or_else(|| Kind::ALL.to_vec());
        let exact: Vec<Key> = self
            .world
            .rows
            .iter()
            .filter(|((k, id), row)| {
                !row.trashed
                    && kinds.contains(k)
                    && (row.name.eq_ignore_ascii_case(&query)
                        || id.eq_ignore_ascii_case(&query)
                        || row
                            .name
                            .to_lowercase()
                            .replace('&', "")
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ")
                            == q_norm)
            })
            .map(|(k, _)| k.clone())
            .collect();
        if let [only] = exact.as_slice() {
            return Ok(only.clone());
        }
        if exact.len() > 1 {
            return Err(format!("error: ambiguous target \"{query}\"."));
        }
        let reaches = crate::native::search::name_reach(self, &q_norm, &kinds);
        let live: Vec<Key> = reaches
            .into_iter()
            .filter(|k| self.world.row(k).is_some_and(|r| !r.trashed))
            .collect();
        match live.as_slice() {
            [only] => Ok(only.clone()),
            [] => Err(format!("error: no match for \"{query}\".")),
            _ => Err(format!("error: multiple matches for \"{query}\".")),
        }
    }

    fn follow_system_of(kind: Kind) -> Option<&'static str> {
        match kind {
            Kind::Person => Some("contacts"),
            Kind::Event | Kind::Calendar => Some("calendar"),
            Kind::Task | Kind::List => Some("phone_reminders"),
            Kind::Workout | Kind::DailyFigure => Some("health"),
            Kind::Document | Kind::Folder => Some("files"),
            _ => None,
        }
    }

    fn resolve_follow_ref(&self, system: &str, entity_id: Option<&str>) -> Result<String, String> {
        fn cell_str<'a>(row: &'a centraid_apps_kit::row::Row, col: &str) -> Option<&'a str> {
            match row.get(col) {
                Some(centraid_apps_kit::row::Cell::Text(s)) => Some(s.as_str()),
                _ => None,
            }
        }
        if let Some(eid) = entity_id {
            let sources = self.door.table_where(
                "source",
                "id, entity_id, origin_id",
                "id",
                "id",
                "entity_id = ?",
                &[eid.to_owned()],
            )?;
            for src in sources {
                if let Some(oid) = cell_str(&src, "origin_id") {
                    let origins = self.door.table_where(
                        "origin",
                        "id, system, ref, retired_at",
                        "id",
                        "id",
                        "id = ? AND retired_at IS NULL",
                        &[oid.to_owned()],
                    )?;
                    if let Some(orig) = origins.first()
                        && cell_str(orig, "system") == Some(system)
                        && let Some(r) = cell_str(orig, "ref")
                    {
                        return Ok(r.to_owned());
                    }
                }
            }
        }
        let origins = self.door.table_where(
            "origin",
            "id, system, ref",
            "id",
            "id",
            "system = ? AND retired_at IS NULL",
            &[system.to_owned()],
        )?;
        match origins.as_slice() {
            [only] => cell_str(only, "ref")
                .map(str::to_owned)
                .ok_or_else(|| "error: origin is missing its ref.".to_owned()),
            [] => Err(format!("error: nothing is currently followed in {system}.")),
            _ => Err(format!(
                "error: multiple {system} sources are followed; pass ref: <source ref>."
            )),
        }
    }

    fn plan_respond(&mut self, row: &Row, args: &Map<String, Value>) -> Result<Plan, String> {
        for key in args.keys() {
            if !matches!(key.as_str(), "answer" | "state" | "person" | "who" | "row") {
                return Err(format!(
                    "error: respond takes answer (accepted | declined | tentative); not \"{key}\"."
                ));
            }
        }
        let raw_answer = args
            .get("answer")
            .or_else(|| args.get("state"))
            .map(text_of)
            .ok_or("error: respond needs answer: accepted | declined | tentative.")?
            .to_lowercase();
        let state = match raw_answer.as_str() {
            "accepted" | "accept" | "yes" | "going" => "accepted",
            "declined" | "decline" | "no" => "declined",
            "tentative" | "maybe" => "tentative",
            other => {
                return Err(format!(
                    "error: respond answer must be accepted, declined or tentative; not \"{other}\"."
                ));
            }
        };
        let person_id = if let Some(who) = args
            .get("person")
            .or_else(|| args.get("who"))
            .or_else(|| args.get("row"))
        {
            self.resolve_one_target(who, Some(Kind::Person))?.1
        } else {
            let attendees = self
                .world
                .neighbours(&(Kind::Event, row.id.clone()))
                .remove(&Kind::Person)
                .unwrap_or_default();
            if !self.world.me.is_empty() && attendees.iter().any(|k| k.1 == self.world.me) {
                self.world.me.clone()
            } else {
                attendees
                    .into_iter()
                    .next()
                    .map(|k| k.1)
                    .unwrap_or_else(|| self.world.me.clone())
            }
        };
        Ok(Plan::Run {
            steps: vec![Step {
                act: Call::bare("event.respond"),
                input: json!({
                    "id": row.id,
                    "person_id": person_id,
                    "state": state,
                }),
            }],
            inverse: Vec::new(),
            not_undoable: Some("an RSVP response stays until changed again".to_owned()),
            note: None,
        })
    }

    fn plan_categorize(&mut self, row: &Row, args: &Map<String, Value>) -> Result<Plan, String> {
        for key in args.keys() {
            if !matches!(key.as_str(), "category" | "to") {
                return Err(format!(
                    "error: categorize takes category: <category>; not \"{key}\"."
                ));
            }
        }
        let val = args
            .get("category")
            .or_else(|| args.get("to"))
            .ok_or("error: categorize needs category: <category>.")?;
        let text = text_of(val);
        let category_id: Option<String> = if val.is_null()
            || matches!(
                text.to_lowercase().as_str(),
                "null" | "none" | "uncategorized"
            ) {
            None
        } else {
            Some(self.resolve_one_target(val, Some(Kind::Category))?.1)
        };
        let prev_cat_id: Option<String> =
            row.field("category").and_then(val_str).and_then(|title| {
                self.world
                    .rows
                    .iter()
                    .find(|((k, _), r)| *k == Kind::Category && !r.trashed && r.name == title)
                    .map(|((_, id), _)| id.clone())
            });
        Ok(Plan::Run {
            steps: vec![Step {
                act: Call::bare("txn.categorize"),
                input: json!({
                    "ids": [row.id],
                    "category_id": category_id,
                }),
            }],
            inverse: vec![Step {
                act: Call::bare("txn.categorize"),
                input: json!({
                    "ids": [row.id],
                    "category_id": prev_cat_id,
                }),
            }],
            not_undoable: None,
            note: None,
        })
    }

    fn plan_link(
        &mut self,
        verb: Verb,
        row: &Row,
        args: &Map<String, Value>,
    ) -> Result<Plan, String> {
        for key in args.keys() {
            if !matches!(
                key.as_str(),
                "to" | "with"
                    | "row"
                    | "target"
                    | "rel"
                    | "relation"
                    | "kind"
                    | "name"
                    | "pet"
                    | "related"
                    | "label"
            ) {
                return Err(format!(
                    "error: {} does not take arg \"{key}\".",
                    verb.spec().name
                ));
            }
        }
        if row.kind == Kind::Transaction && verb == Verb::Link {
            let target_val = args
                .get("to")
                .or_else(|| args.get("with"))
                .or_else(|| args.get("row"))
                .or_else(|| args.get("target"))
                .ok_or("error: link on a transaction needs to: <transaction>.")?;
            let partner = self.resolve_one_target(target_val, Some(Kind::Transaction))?;
            return Ok(Plan::Run {
                steps: vec![Step {
                    act: Call::bare("txn.link_transfer"),
                    input: json!({ "id": row.id, "other_id": partner.1 }),
                }],
                inverse: vec![Step {
                    act: Call::bare("txn.unlink_transfer"),
                    input: json!({ "id": row.id }),
                }],
                not_undoable: None,
                note: None,
            });
        }
        if row.kind == Kind::Person
            && verb == Verb::Link
            && (args.contains_key("relation")
                || args.contains_key("kind")
                || args.contains_key("pet"))
        {
            let rel_kind = args
                .get("relation")
                .or_else(|| args.get("kind"))
                .map(text_of)
                .filter(|s| !s.is_empty())
                .ok_or("error: relationship needs relation/kind.")?;
            let related_val = args
                .get("to")
                .or_else(|| args.get("with"))
                .or_else(|| args.get("related"))
                .or_else(|| args.get("row"));
            let related = match related_val {
                Some(v) => Some(self.resolve_one_target(v, Some(Kind::Person))?),
                None => None,
            };
            let name = args
                .get("name")
                .map(text_of)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    related
                        .as_ref()
                        .and_then(|k| self.world.row(k))
                        .map(|r| r.name.clone())
                })
                .ok_or("error: relationship needs name or related person.")?;
            let mut input = json!({
                "id": row.id,
                "name": name,
                "kind": rel_kind,
            });
            if let Some(pet) = args.get("pet").map(text_of).filter(|s| !s.is_empty()) {
                input["pet"] = json!(pet);
            }
            if let Some(rel_key) = related {
                input["related_id"] = json!(rel_key.1);
            }
            return Ok(Plan::Run {
                steps: vec![Step {
                    act: Call::bare("person.add_relationship"),
                    input,
                }],
                inverse: Vec::new(),
                not_undoable: Some("a recorded relationship stays in the vault".to_owned()),
                note: None,
            });
        }
        let target_val = args
            .get("to")
            .or_else(|| args.get("with"))
            .or_else(|| args.get("row"))
            .or_else(|| args.get("target"))
            .ok_or_else(|| format!("error: {} needs to: <row>.", verb.spec().name))?;
        let other = self.resolve_one_target(target_val, None)?;
        let default_rel = if verb == Verb::Attach {
            "attached"
        } else if row.kind == Kind::Event && other.0 == Kind::Person {
            "attendee"
        } else if (row.kind == Kind::Photo && other.0 == Kind::Person)
            || (row.kind == Kind::Person && other.0 == Kind::Photo)
        {
            "depicts"
        } else if args.contains_key("label") || args.contains_key("relation") {
            "related"
        } else {
            "links"
        };
        let rel = args
            .get("rel")
            .map(text_of)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| default_rel.to_owned());
        let (from_id, to_id) = if (rel == "attached"
            && matches!(row.kind, Kind::Document | Kind::Photo)
            && !matches!(other.0, Kind::Document | Kind::Photo))
            || (rel == "depicts" && row.kind == Kind::Person && other.0 == Kind::Photo)
            || (rel == "links" && other.0 == Kind::LockerItem && row.kind != Kind::LockerItem)
        {
            (other.1.clone(), row.id.clone())
        } else {
            (row.id.clone(), other.1.clone())
        };
        let mut add_input = json!({ "from": from_id, "rel": rel, "to": to_id });
        let mut rm_input = json!({ "from": from_id, "rel": rel, "to": to_id });
        if let Some(label) = args
            .get("label")
            .or_else(|| args.get("relation"))
            .map(text_of)
            .filter(|s| !s.is_empty())
        {
            add_input["label"] = json!(label);
            rm_input["label"] = json!(label);
        }
        Ok(Plan::Run {
            steps: vec![Step {
                act: Call::bare("edge.add"),
                input: add_input,
            }],
            inverse: vec![Step {
                act: Call::bare("edge.remove"),
                input: rm_input,
            }],
            not_undoable: None,
            note: None,
        })
    }

    fn plan_unlink(
        &mut self,
        verb: Verb,
        row: &Row,
        args: &Map<String, Value>,
        action: &'static ActionSpec,
    ) -> Result<Plan, String> {
        if row.kind == Kind::Transaction && verb == Verb::Unlink && args.is_empty() {
            let Some(Val::Text(partner)) = row.field("transfer") else {
                return Ok(Plan::Already("is not part of a transfer".to_owned()));
            };
            let back = action
                .inverse
                .ok_or_else(|| not_applicable(verb, row.kind))?;
            return Ok(Plan::Run {
                steps: vec![Step::of(action, json!({ action.id_param: row.id }))],
                inverse: vec![Step {
                    act: back.call(),
                    input: json!({ back.id_param: row.id, "other_id": partner }),
                }],
                not_undoable: None,
                note: None,
            });
        }
        for key in args.keys() {
            if !matches!(
                key.as_str(),
                "to" | "from" | "with" | "row" | "target" | "rel" | "label"
            ) {
                return Err(format!(
                    "error: {} does not take arg \"{key}\".",
                    verb.spec().name
                ));
            }
        }
        let target_val = args
            .get("to")
            .or_else(|| args.get("from"))
            .or_else(|| args.get("with"))
            .or_else(|| args.get("row"))
            .or_else(|| args.get("target"))
            .ok_or_else(|| format!("error: {} needs to: <row>.", verb.spec().name))?;
        let other = self.resolve_one_target(target_val, None)?;
        let default_rel = if verb == Verb::Detach {
            "attached"
        } else if row.kind == Kind::Event && other.0 == Kind::Person {
            "attendee"
        } else if (row.kind == Kind::Photo && other.0 == Kind::Person)
            || (row.kind == Kind::Person && other.0 == Kind::Photo)
        {
            "depicts"
        } else if args.contains_key("label") {
            "related"
        } else {
            "links"
        };
        let rel = args
            .get("rel")
            .map(text_of)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| default_rel.to_owned());
        let (from_id, to_id) = if (rel == "attached"
            && matches!(row.kind, Kind::Document | Kind::Photo)
            && !matches!(other.0, Kind::Document | Kind::Photo))
            || (rel == "depicts" && row.kind == Kind::Person && other.0 == Kind::Photo)
            || (rel == "links" && other.0 == Kind::LockerItem && row.kind != Kind::LockerItem)
        {
            (other.1.clone(), row.id.clone())
        } else {
            (row.id.clone(), other.1.clone())
        };
        let mut rm_input = json!({ "from": from_id, "rel": rel, "to": to_id });
        let mut add_input = json!({ "from": from_id, "rel": rel, "to": to_id });
        if let Some(label) = args.get("label").map(text_of).filter(|s| !s.is_empty()) {
            rm_input["label"] = json!(label);
            add_input["label"] = json!(label);
        }
        Ok(Plan::Run {
            steps: vec![Step {
                act: Call::bare("edge.remove"),
                input: rm_input,
            }],
            inverse: vec![Step {
                act: Call::bare("edge.add"),
                input: add_input,
            }],
            not_undoable: None,
            note: None,
        })
    }

    fn plan_merge(&mut self, row: &Row, args: &Map<String, Value>) -> Result<Plan, String> {
        for key in args.keys() {
            if !matches!(key.as_str(), "into" | "to") {
                return Err(format!(
                    "error: merge takes into: <{}>; not \"{key}\".",
                    row.kind.name()
                ));
            }
        }
        let target_val = args
            .get("into")
            .or_else(|| args.get("to"))
            .ok_or_else(|| format!("error: merge needs into: <{}>.", row.kind.name()))?;
        let into = self.resolve_one_target(target_val, Some(row.kind))?;
        if into.1 == row.id {
            return Err("error: cannot merge a row into itself.".to_owned());
        }
        let (command, input) = match row.kind {
            Kind::Category => (
                "category.merge",
                json!({ "from_id": row.id, "into_id": into.1 }),
            ),
            Kind::Person => ("person.merge", json!({ "from": row.id, "into": into.1 })),
            other => return Err(not_applicable(Verb::Merge, other)),
        };
        Ok(Plan::Run {
            steps: vec![Step {
                act: Call::bare(command),
                input,
            }],
            inverse: Vec::new(),
            not_undoable: Some("a merge cannot be undone".to_owned()),
            note: None,
        })
    }

    fn plan_unfollow(&mut self, row: &Row, args: &Map<String, Value>) -> Result<Plan, String> {
        for key in args.keys() {
            if !matches!(key.as_str(), "system" | "ref") {
                return Err(format!(
                    "error: unfollow takes optional system and ref; not \"{key}\"."
                ));
            }
        }
        let system = args
            .get("system")
            .map(text_of)
            .filter(|s| !s.is_empty())
            .or_else(|| Self::follow_system_of(row.kind).map(str::to_owned))
            .ok_or_else(|| not_applicable(Verb::Unfollow, row.kind))?;
        let reference = match args.get("ref").map(text_of).filter(|s| !s.is_empty()) {
            Some(r) => r,
            None => self.resolve_follow_ref(&system, Some(&row.id))?,
        };
        Ok(Plan::Run {
            steps: vec![Step {
                act: Call::bare("follow.stop"),
                input: json!({ "system": system, "ref": reference }),
            }],
            inverse: Vec::new(),
            not_undoable: Some(
                "unfollowing stops sync; re-follow from the app to resume".to_owned(),
            ),
            note: None,
        })
    }

    fn plan_restore_version(
        &mut self,
        row: &Row,
        args: &Map<String, Value>,
        action: &'static ActionSpec,
    ) -> Result<Plan, String> {
        for key in args.keys() {
            if !matches!(key.as_str(), "version" | "seq") {
                return Err(format!(
                    "error: restore_version takes version: <number>; not \"{key}\"."
                ));
            }
        }
        let raw_seq = args
            .get("seq")
            .or_else(|| args.get("version"))
            .ok_or("error: restore_version needs version: <number>.")?;
        let seq = raw_seq
            .as_i64()
            .or_else(|| text_of(raw_seq).trim().parse::<i64>().ok())
            .filter(|n| *n >= 1)
            .ok_or("error: restore_version version must be a positive integer.")?;
        Ok(Plan::Run {
            steps: vec![Step::of(action, json!({ "id": row.id, "seq": seq }))],
            inverse: Vec::new(),
            not_undoable: Some("a version restore appends a new state in history".to_owned()),
            note: None,
        })
    }

    fn plan_reschedule_occurrence(
        &mut self,
        row: &Row,
        args: &Map<String, Value>,
    ) -> Result<Plan, String> {
        if row.kind != Kind::Event {
            return Err(format!(
                "error: reschedule:occurrence only applies to events, not {}.",
                row.kind.plural()
            ));
        }
        for key in args.keys() {
            if !matches!(
                key.as_str(),
                "to" | "occurrence"
                    | "original_start"
                    | "scope"
                    | "action"
                    | "name"
                    | "description"
                    | "url"
                    | "place"
            ) {
                return Err(format!(
                    "error: reschedule:occurrence does not take \"{key}\"."
                ));
            }
        }
        let original_start = args
            .get("original_start")
            .or_else(|| args.get("occurrence"))
            .map(text_of)
            .filter(|s| !s.is_empty())
            .or_else(|| row.date.map(|d| d.vault()))
            .ok_or("error: reschedule:occurrence needs original_start or occurrence date.")?;
        let scope = args
            .get("scope")
            .map(text_of)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "single".to_owned());
        let occ_action = args
            .get("action")
            .map(text_of)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "override".to_owned());
        let mut input = json!({
            "id": row.id,
            "original_start": original_start,
            "scope": scope,
            "action": occ_action,
        });
        if let Some(to) = args.get("to") {
            let expr = self.date_expr(to)?;
            let resolved =
                dates::evaluate(&expr, self.now, row.date).map_err(|why| dates::rejection(&why))?;
            let vault_at = |dt: jiff::civil::DateTime| {
                Stamp {
                    date: dt.date(),
                    time: Some(dt.time()),
                }
                .vault()
            };
            if let Some(pt) = resolved.point() {
                let pt = keep_time(pt, row.date);
                input["starts"] = json!(pt.vault());
                if let Some(time) = pt.time {
                    let (old_s, old_e) = event_span(row);
                    let len = old_e.duration_since(old_s);
                    let end = pt.at().checked_add(len).unwrap_or_else(|_| pt.at());
                    input["ends"] = json!(vault_at(end));
                    let _ = time;
                }
            } else if let dates::Resolved::Between { from, to } = resolved {
                input["starts"] = json!(vault_at(from));
                input["ends"] = json!(vault_at(to));
            }
        }
        if let Some(name) = args.get("name").map(text_of).filter(|s| !s.is_empty()) {
            input["title"] = json!(name);
        }
        if let Some(desc) = args.get("description") {
            input["description"] = desc.clone();
        }
        if let Some(url) = args.get("url") {
            input["url"] = url.clone();
        }
        Ok(Plan::Run {
            steps: vec![Step {
                act: Call::bare("event.edit_occurrence"),
                input,
            }],
            inverse: Vec::new(),
            not_undoable: Some("occurrence edits stay in the vault until changed again".to_owned()),
            note: None,
        })
    }

    fn run_empty_trash(
        &mut self,
        args: &Map<String, Value>,
        extra: &Map<String, Value>,
    ) -> Result<Outcome, String> {
        for key in extra.keys() {
            if !matches!(key.as_str(), "kind" | "due_only") {
                return Err(format!(
                    "error: empty_trash takes optional kind and due_only; not \"{key}\"."
                ));
            }
        }
        let kind_str = arg_str(args, "kind").or_else(|| extra.get("kind").map(text_of));
        let parsed_kind = kind_str
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| Kind::parse(s).ok_or_else(|| format!("error: unknown kind \"{s}\".")))
            .transpose()?;
        if !self.confirmed_action(Verb::EmptyTrash, parsed_kind, &[], extra) {
            return Ok(self.confirm_ask(Verb::EmptyTrash, parsed_kind, &[], extra));
        }
        let mut input = Map::new();
        if let Some(k) = parsed_kind {
            if k == Kind::Workout {
                input.insert("kind".to_owned(), json!("activity"));
                input.insert("having".to_owned(), json!("workout"));
            } else {
                input.insert("kind".to_owned(), json!(k.spec().entity));
            }
        }
        if let Some(due_only) = extra.get("due_only").and_then(Value::as_bool) {
            input.insert("due_only".to_owned(), json!(due_only));
        }
        let before = self.world.clone();
        let ran = self.write_step(&Call::bare("entity.empty_trash"), &Value::Object(input))?;
        if !ran.ok {
            return Err(format!(
                "error: empty_trash was refused: {}",
                ran.reason.unwrap_or_default()
            ));
        }
        self.settle()?;
        let diff = self.diff_since(&before);
        let purged = ran
            .output
            .get("purged")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.record(
            Vec::new(),
            vec!["emptying the trash permanently purges rows".to_owned()],
        );
        let mut outcome = Outcome::text(format!("emptied trash ({purged} purged)"));
        outcome
            .effect
            .insert("diff".to_owned(), self.diff_json(&diff));
        Ok(outcome)
    }

    fn run_recolor(&mut self, extra: &Map<String, Value>) -> Result<Outcome, String> {
        for key in extra.keys() {
            if !matches!(key.as_str(), "label" | "color") {
                return Err(format!(
                    "error: recolor takes label and color; not \"{key}\"."
                ));
            }
        }
        let label = extra
            .get("label")
            .map(text_of)
            .filter(|s| !s.is_empty())
            .ok_or("error: recolor needs label: <tag>, color: <color>.")?;
        let color = extra
            .get("color")
            .map(text_of)
            .filter(|s| !s.is_empty())
            .ok_or("error: recolor needs color: <color>.")?
            .to_lowercase();
        let before = self.world.clone();
        let ran = self.write_step(
            &Call::bare("tag.color"),
            &json!({ "label": label, "color": color }),
        )?;
        if !ran.ok {
            return Err(format!(
                "error: recolor was refused: {}",
                ran.reason.unwrap_or_default()
            ));
        }
        self.settle()?;
        let diff = self.diff_since(&before);
        self.record(
            Vec::new(),
            vec!["tag color stays until recolored again".to_owned()],
        );
        let mut outcome = Outcome::text(format!("recolored tag \"{label}\" to {color}"));
        outcome
            .effect
            .insert("diff".to_owned(), self.diff_json(&diff));
        Ok(outcome)
    }

    fn run_unfollow(
        &mut self,
        args: &Map<String, Value>,
        extra: &Map<String, Value>,
    ) -> Result<Outcome, String> {
        for key in extra.keys() {
            if !matches!(key.as_str(), "system" | "ref" | "kind") {
                return Err(format!(
                    "error: unfollow takes system/kind and optional ref; not \"{key}\"."
                ));
            }
        }
        let kind_str = arg_str(args, "kind").or_else(|| extra.get("kind").map(text_of));
        let parsed_kind = kind_str
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(Kind::parse);
        let system = extra
            .get("system")
            .map(text_of)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                kind_str
                    .as_deref()
                    .and_then(|s| match s.to_lowercase().as_str() {
                        "contacts" | "person" => Some("contacts".to_owned()),
                        "calendar" | "event" => Some("calendar".to_owned()),
                        "phone_reminders" | "reminders" | "task" | "list" => {
                            Some("phone_reminders".to_owned())
                        }
                        "health" | "workout" | "daily_figure" | "daily figure" => {
                            Some("health".to_owned())
                        }
                        "files" | "docs" | "document" | "folder" => Some("files".to_owned()),
                        _ => parsed_kind
                            .and_then(Self::follow_system_of)
                            .map(str::to_owned),
                    })
            })
            .ok_or("error: unfollow needs a row, kind or system.")?;
        let reference = match extra.get("ref").map(text_of).filter(|s| !s.is_empty()) {
            Some(r) => r,
            None => self.resolve_follow_ref(&system, None)?,
        };
        if !self.confirmed_action(Verb::Unfollow, parsed_kind, &[], extra) {
            return Ok(self.confirm_ask(Verb::Unfollow, parsed_kind, &[], extra));
        }
        let before = self.world.clone();
        let ran = self.write_step(
            &Call::bare("follow.stop"),
            &json!({ "system": system, "ref": reference }),
        )?;
        if !ran.ok {
            return Err(format!(
                "error: unfollow was refused: {}",
                ran.reason.unwrap_or_default()
            ));
        }
        self.settle()?;
        let diff = self.diff_since(&before);
        self.record(
            Vec::new(),
            vec!["unfollowing stops sync; re-follow from the app to resume".to_owned()],
        );
        let mut outcome = Outcome::text(format!("stopped following {system} ({reference})"));
        outcome
            .effect
            .insert("diff".to_owned(), self.diff_json(&diff));
        Ok(outcome)
    }

    fn run_apply_rules(&mut self, extra: &Map<String, Value>) -> Result<Outcome, String> {
        for key in extra.keys() {
            if !matches!(key.as_str(), "overwrite") {
                return Err(format!(
                    "error: apply takes optional overwrite: true|false; not \"{key}\"."
                ));
            }
        }
        let mut input = Map::new();
        if let Some(overwrite) = extra.get("overwrite").and_then(Value::as_bool) {
            input.insert("overwrite".to_owned(), json!(overwrite));
        }
        let before = self.world.clone();
        let ran = self.write_step(&Call::bare("rule.apply"), &Value::Object(input))?;
        if !ran.ok {
            return Err(format!(
                "error: apply was refused: {}",
                ran.reason.unwrap_or_default()
            ));
        }
        self.settle()?;
        let diff = self.diff_since(&before);
        self.record(
            Vec::new(),
            vec!["applying rules updates matching transactions directly".to_owned()],
        );
        let matched = ran
            .output
            .get("matched")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let recategorised = ran
            .output
            .get("recategorised")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let mut outcome = Outcome::text(format!(
            "applied rules ({matched} matched, {recategorised} categorized)"
        ));
        outcome
            .effect
            .insert("diff".to_owned(), self.diff_json(&diff));
        Ok(outcome)
    }

    fn run_handoff_app(
        &mut self,
        verb: Verb,
        args: &Map<String, Value>,
        extra: &Map<String, Value>,
    ) -> Result<Outcome, String> {
        let kind_str = arg_str(args, "kind").or_else(|| extra.get("kind").map(text_of));
        let app_str = extra.get("app").map(text_of);
        let target_kind = if let Some(ks) = kind_str.as_deref().filter(|s| !s.is_empty()) {
            let k = Kind::parse(ks).ok_or_else(|| format!("error: unknown kind \"{ks}\"."))?;
            let mapped = handoff_member_kind(verb, k);
            if verb == Verb::Export && mapped == Kind::DailyFigure {
                Kind::Workout
            } else {
                mapped
            }
        } else if let Some(app) = app_str.as_deref().filter(|s| !s.is_empty()) {
            match app.to_lowercase().as_str() {
                "calendar" => Kind::Event,
                "docs" | "documents" => Kind::Document,
                "health" => Kind::Workout,
                "locker" => {
                    if verb == Verb::Configure {
                        Kind::LockerPasskey
                    } else {
                        Kind::LockerItem
                    }
                }
                "money" => {
                    if verb == Verb::Configure {
                        Kind::Account
                    } else {
                        Kind::Transaction
                    }
                }
                "notes" => Kind::Note,
                "people" => Kind::Person,
                "photos" => Kind::Photo,
                "reminders" | "tasks" => Kind::Task,
                other => return Err(format!("error: unknown app \"{other}\".")),
            }
        } else {
            return Err(format!(
                "error: {} requires kind or rows.",
                verb.spec().name
            ));
        };
        let action = meta::lookup(verb, target_kind, None)
            .filter(|s| s.is_handoff())
            .ok_or_else(|| not_applicable(verb, target_kind))?;
        let card = handoff_action(action, "");
        let mut outcome = Outcome::text(format!(
            "offered to the member: {} {}",
            verb.spec().name,
            target_kind.name()
        ));
        outcome.effect.insert(
            "member_actions".to_owned(),
            Value::Array(vec![card.to_json()]),
        );
        outcome.ends_turn = true;
        Ok(outcome)
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
            let holds_text =
                matches!(base, "body" | "description") && meta::edit_action(kind, base).is_some();
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

    /// A number the vault keeps in `column` of the one row `predicate` names, to the digit: the
    /// world shows a Health figure whole, and an undo that put the world's number back would write
    /// one the member never stated. `None` for a null cell; an error when the door cannot say.
    fn exact_number(
        &self,
        table: &str,
        column: &str,
        (sort, pk): (&str, &str),
        predicate: &str,
        binds: &[String],
    ) -> Result<Option<f64>, String> {
        // the paged read orders by its sort and key columns, so it projects them with the figure
        let columns = if sort == pk {
            format!("{pk}, {column}")
        } else {
            format!("{sort}, {pk}, {column}")
        };
        let rows = self
            .door
            .table_where(table, &columns, sort, pk, predicate, binds)
            .map_err(|why| format!("error: could not read the {table} first: {why}"))?;
        Ok(rows.first().and_then(|found| match found.get(column) {
            Some(centraid_apps_kit::row::Cell::Real(value)) => Some(*value),
            Some(centraid_apps_kit::row::Cell::Integer(value)) => Some(*value as f64),
            _ => None,
        }))
    }

    /// The value a daily figure holds, as the vault keeps it.
    fn figure_value(&self, row: &Row) -> Result<f64, String> {
        let (day, metric) = row.id.split_once(':').unwrap_or_default();
        self.exact_number(
            "measurement",
            "value",
            ("day", "metric"),
            "person_id = ? AND day = ? AND metric = ?",
            &[self.world.me.clone(), day.to_owned(), metric.to_owned()],
        )?
        .ok_or_else(|| "error: could not read the figure first: it is not there.".to_owned())
    }

    /// A workout's figure as the vault keeps it (`Null` when it holds none).
    fn workout_figure(&self, row: &Row, column: &str) -> Result<Value, String> {
        Ok(
            match self.exact_number(
                "workout",
                column,
                ("id", "id"),
                "id = ?",
                std::slice::from_ref(&row.id),
            )? {
                Some(value) if value.fract() == 0.0 => json!(value as i64),
                Some(value) => json!(value),
                None => Value::Null,
            },
        )
    }

    /// What the health store states, if `row` is one of it: a workout the store follows, or a
    /// daily figure while a store is followed (figures carry no source of their own). The words
    /// are the vault's.
    fn store_states(&self, row: &Row) -> Option<String> {
        match row.kind {
            Kind::Workout => row.extra.get("followed_by").map(|store| {
                format!("This workout comes from {store}; change it there, not here.")
            }),
            Kind::DailyFigure => self.world.health_store.as_ref().map(|store| {
                format!("These figures come from {store}; change them there, not here.")
            }),
            _ => None,
        }
    }

    /// Exact `activity.ends` ISO string (`None` when unset or row absent).
    fn workout_ends_iso(&self, id: &str) -> Result<Option<String>, String> {
        let rows = self
            .door
            .table_where(
                "activity",
                "id, ends",
                "id",
                "id",
                "id = ?",
                std::slice::from_ref(&id.to_owned()),
            )
            .map_err(|why| format!("error: could not read the activity first: {why}"))?;
        Ok(rows.first().and_then(|found| match found.get("ends") {
            Some(centraid_apps_kit::row::Cell::Text(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        }))
    }

    /// Exact `(posted_on, amount_minor, category_id, status)` of a `txn` row from the vault.
    fn txn_snapshot(&self, id: &str) -> Result<Option<TxnSnapshot>, String> {
        let rows = self
            .door
            .table_where(
                "txn",
                "id, posted_on, amount_minor, category_id, status",
                "id",
                "id",
                "id = ?",
                std::slice::from_ref(&id.to_owned()),
            )
            .map_err(|why| format!("error: could not read the txn first: {why}"))?;
        let Some(found) = rows.first() else {
            return Ok(None);
        };
        let text_col = |col: &str| match found.get(col) {
            Some(centraid_apps_kit::row::Cell::Text(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        };
        let posted_on = text_col("posted_on").unwrap_or_default();
        let amount_minor = match found.get("amount_minor") {
            Some(centraid_apps_kit::row::Cell::Integer(n)) => *n,
            _ => 0,
        };
        let category_id = text_col("category_id");
        let status = text_col("status").unwrap_or_else(|| "posted".to_owned());
        Ok(Some((posted_on, amount_minor, category_id, status)))
    }

    /// The bank's account number stored on `origin` for an account (`None` when unset).
    fn account_external_ref(&self, id: &str) -> Result<Option<String>, String> {
        let rows = self
            .door
            .table_where(
                "origin",
                "id, ref",
                "id",
                "id",
                "system = 'statement' AND fills = ?",
                std::slice::from_ref(&id.to_owned()),
            )
            .map_err(|why| format!("error: could not read the account origin first: {why}"))?;
        Ok(rows.first().and_then(|found| match found.get("ref") {
            Some(centraid_apps_kit::row::Cell::Text(s)) if !s.is_empty() && s != id => {
                Some(s.clone())
            }
            _ => None,
        }))
    }

    /// Resolve a category name/key/id for `txn.edit`, covering both member categories and
    /// baseline stock categories (`category:*`). `None`/`"null"`/`"uncategorized"` clears it.
    fn resolve_category_id(&self, raw: &str) -> Result<Option<String>, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty()
            || trimmed.eq_ignore_ascii_case("null")
            || trimmed.eq_ignore_ascii_case("none")
            || trimmed.eq_ignore_ascii_case("uncategorized")
        {
            return Ok(None);
        }
        for row in self.world.of_kind(Kind::Category) {
            if row.id == trimmed
                || row
                    .extra
                    .get("key")
                    .is_some_and(|key| key.eq_ignore_ascii_case(trimmed))
                || row.name.eq_ignore_ascii_case(trimmed)
            {
                if row.extra.contains_key("archived") {
                    return Err(format!("error: category \"{}\" is archived.", row.name));
                }
                return Ok(Some(row.id.clone()));
            }
        }
        let entities = self
            .door
            .table_where(
                "entity",
                "id, kind, title, deleted_at",
                "id",
                "id",
                "kind = 'category' AND deleted_at IS NULL",
                &[],
            )
            .map_err(|why| format!("error: could not read categories: {why}"))?;
        let mut matched_id: Option<String> = None;
        let mut live_ids = BTreeSet::new();
        for ent in &entities {
            let Some(centraid_apps_kit::row::Cell::Text(id)) = ent.get("id") else {
                continue;
            };
            live_ids.insert(id.clone());
            let title = match ent.get("title") {
                Some(centraid_apps_kit::row::Cell::Text(t)) => t.as_str(),
                _ => "",
            };
            if id == trimmed || title.eq_ignore_ascii_case(trimmed) {
                matched_id = Some(id.clone());
                break;
            }
        }
        if matched_id.is_none() {
            let concepts = self
                .door
                .table("concept", "id, key", "id", "id")
                .map_err(|why| format!("error: could not read category keys: {why}"))?;
            for concept in concepts {
                let (
                    Some(centraid_apps_kit::row::Cell::Text(id)),
                    Some(centraid_apps_kit::row::Cell::Text(key)),
                ) = (concept.get("id"), concept.get("key"))
                else {
                    continue;
                };
                if live_ids.contains(id) && key.eq_ignore_ascii_case(trimmed) {
                    matched_id = Some(id.clone());
                    break;
                }
            }
        }
        let Some(id) = matched_id else {
            return Err(format!("error: no category called \"{trimmed}\"."));
        };
        let archived = self
            .door
            .table_where(
                "edge",
                "from_id, to_id",
                "from_id",
                "to_id",
                "rel = 'tagged' AND to_id = ? AND from_id = ?",
                &[
                    centraid_vault::model::Flag::Archived.id().to_owned(),
                    id.clone(),
                ],
            )
            .map_err(|why| format!("error: could not check category flags: {why}"))?;
        if !archived.is_empty() {
            return Err(format!("error: category \"{trimmed}\" is archived."));
        }
        Ok(Some(id))
    }

    /// Resolve a date expression to a single `YYYY-MM-DD` calendar day.
    fn resolve_date_day(&mut self, value: &Value) -> Result<String, String> {
        let expr = self.date_expr(value)?;
        let resolved =
            dates::evaluate(&expr, self.now, None).map_err(|why| dates::rejection(&why))?;
        if resolved.is_open() {
            return Err(format!(
                "error: expected a single day, not open-ended {}.",
                resolved.echo()
            ));
        }
        match resolved {
            dates::Resolved::At(at) => Ok(at.date().to_string()),
            dates::Resolved::Days { from, to } if from == to => Ok(from.to_string()),
            other => Err(format!(
                "error: expected a single day, not {}.",
                other.echo()
            )),
        }
    }

    /// Resolve a workout's `ends` expression: time-only forms (`"08:30"`, `"8:30am"`,
    /// `{"time": "08:30"}`) resolve against `start_date`; full date expressions evaluate
    /// against `self.now` and `anchor`.
    fn resolve_workout_end(
        &mut self,
        value: &Value,
        start_date: jiff::civil::Date,
        anchor: Option<Stamp>,
    ) -> Result<jiff::civil::DateTime, String> {
        let parsed_json;
        let inspect = match value {
            Value::String(text) if text.trim_start().starts_with('{') => {
                if let Ok(obj) = serde_json::from_str::<Value>(text) {
                    parsed_json = obj;
                    &parsed_json
                } else {
                    value
                }
            }
            other => other,
        };
        let candidate = match inspect {
            Value::Object(obj) if obj.len() == 1 && obj.contains_key("time") => {
                let mut patched = obj.clone();
                patched.insert("date".to_owned(), json!(start_date.to_string()));
                Some(Value::Object(patched))
            }
            Value::String(text) if Stamp::parse(text.trim()).is_none() => {
                Some(json!({"date": start_date.to_string(), "time": text.trim()}))
            }
            _ => None,
        };
        let resolved = if let Some(patched) = candidate {
            let expr = self.date_expr(&patched)?;
            dates::evaluate(&expr, self.now, anchor).map_err(|why| dates::rejection(&why))?
        } else {
            let expr = self.date_expr(value)?;
            dates::evaluate(&expr, self.now, anchor).map_err(|why| dates::rejection(&why))?
        };
        if resolved.is_open() {
            return Err(format!(
                "error: ends needs an instant; {} is open-ended.",
                resolved.echo()
            ));
        }
        match resolved {
            dates::Resolved::At(at) => Ok(at),
            dates::Resolved::Days { from, to } if from == to => Ok(from.at(0, 0, 0, 0)),
            other => Err(format!(
                "error: ends needs a single time or day, not {}.",
                other.echo()
            )),
        }
    }

    /// Parse a money value in `currency`, refusing conflicting symbols or currency codes.
    fn plan_edit_txn(
        &mut self,
        row: &Row,
        args: &Map<String, Value>,
        calls: &mut BTreeMap<&'static str, &'static ActionSpec>,
        forward: &mut BTreeMap<&'static str, Map<String, Value>>,
        backward: &mut BTreeMap<&'static str, Map<String, Value>>,
        changed: &mut bool,
    ) -> Result<(), String> {
        let action = Verb::Edit
            .action(Kind::Transaction)
            .ok_or_else(|| not_applicable(Verb::Edit, Kind::Transaction))?;
        let command = action.command;
        note_call(calls, action);
        let snap = self.txn_snapshot(&row.id)?;
        let (txn_currency, old_minor) = match row.field("amount") {
            Some(Val::Money(minor, cur)) => (cur.clone(), *minor),
            _ => (
                row.extra
                    .get("currency")
                    .cloned()
                    .unwrap_or_else(|| self.world.currency.clone()),
                snap.as_ref().map_or(0, |t| t.1),
            ),
        };
        for (field, value) in args {
            match field.as_str() {
                "name" => {
                    let name = text_of(value);
                    if name.trim().is_empty() {
                        return Err("error: name cannot be empty.".to_owned());
                    }
                    *changed |= name != row.name;
                    forward
                        .entry(command)
                        .or_default()
                        .insert("title".to_owned(), json!(name));
                    backward
                        .entry(command)
                        .or_default()
                        .insert("title".to_owned(), json!(row.name));
                }
                "date" => {
                    let new_day = self.resolve_date_day(value)?;
                    let old_day = snap
                        .as_ref()
                        .map(|t| t.0.clone())
                        .or_else(|| row.date.map(|d| d.date.to_string()))
                        .unwrap_or_default();
                    *changed |= new_day != old_day;
                    forward
                        .entry(command)
                        .or_default()
                        .insert("posted_on".to_owned(), json!(new_day));
                    backward
                        .entry(command)
                        .or_default()
                        .insert("posted_on".to_owned(), json!(old_day));
                }
                "amount" => {
                    let new_minor = parse_money_in_currency(&text_of(value), &txn_currency)?;
                    *changed |= new_minor != old_minor;
                    forward
                        .entry(command)
                        .or_default()
                        .insert("amount_minor".to_owned(), json!(new_minor));
                    backward
                        .entry(command)
                        .or_default()
                        .insert("amount_minor".to_owned(), json!(old_minor));
                }
                "category" => {
                    let new_cat = self.resolve_category_id(&text_of(value))?;
                    let old_cat = snap.as_ref().and_then(|t| t.2.clone());
                    *changed |= new_cat != old_cat;
                    forward.entry(command).or_default().insert(
                        "category_id".to_owned(),
                        new_cat.map_or(Value::Null, |id| json!(id)),
                    );
                    backward.entry(command).or_default().insert(
                        "category_id".to_owned(),
                        old_cat.map_or(Value::Null, |id| json!(id)),
                    );
                }
                "status" => {
                    let raw = text_of(value);
                    let new_status = raw.trim().to_lowercase();
                    if !matches!(new_status.as_str(), "pending" | "posted" | "void") {
                        return Err(format!(
                            "error: transaction status is one of pending, posted, void, not \"{}\".",
                            raw.trim()
                        ));
                    }
                    let old_status =
                        snap.as_ref().map(|t| t.3.clone()).unwrap_or_else(|| {
                            match row.field("status") {
                                Some(Val::Enum(s)) => (*s).to_owned(),
                                _ => "posted".to_owned(),
                            }
                        });
                    *changed |= new_status != old_status;
                    forward
                        .entry(command)
                        .or_default()
                        .insert("status".to_owned(), json!(new_status));
                    backward
                        .entry(command)
                        .or_default()
                        .insert("status".to_owned(), json!(old_status));
                }
                other => {
                    return Err(format!(
                        "error: {other} cannot be edited on a transaction. transaction editable fields: name, date, amount, category, status."
                    ));
                }
            }
        }
        Ok(())
    }

    fn plan_account_opening(
        &mut self,
        row: &Row,
        args: &Map<String, Value>,
        apart: &mut Vec<Step>,
        apart_back: &mut Vec<Step>,
        changed: &mut bool,
    ) -> Result<(), String> {
        let opening_arg = args.get("opening");
        let opening_on_arg = args.get("opening_on");
        if opening_arg.is_none() && opening_on_arg.is_none() {
            return Ok(());
        }
        let currency = match row.field("currency") {
            Some(Val::Text(c)) => c.clone(),
            _ => match row.field("opening") {
                Some(Val::Money(_, c)) => c.clone(),
                _ => self.world.currency.clone(),
            },
        };
        let old_minor = match row.field("opening") {
            Some(Val::Money(m, _)) => *m,
            _ => 0,
        };
        let old_opening_on = row
            .extra
            .get("opening_on")
            .filter(|s| !s.is_empty())
            .cloned()
            .or_else(|| match row.field("opening_on") {
                Some(Val::Text(s)) if !s.is_empty() => Some(s.clone()),
                _ => None,
            });
        let new_minor = match opening_arg {
            Some(val) => parse_money_in_currency(&text_of(val), &currency)?,
            None => old_minor,
        };
        let new_opening_on = match opening_on_arg {
            Some(val) => {
                let raw = text_of(val);
                let trimmed = raw.trim();
                if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") {
                    None
                } else {
                    Some(self.resolve_date_day(val)?)
                }
            }
            None => old_opening_on.clone(),
        };
        if new_minor != 0 && new_opening_on.is_none() {
            return Err(
                "error: An opening balance needs the day it was true (opening_on: <date>)."
                    .to_owned(),
            );
        }
        if (new_minor, &new_opening_on) == (old_minor, &old_opening_on) {
            return Ok(());
        }
        *changed = true;
        let mut fwd = json!({"id": row.id, "opening_minor": new_minor});
        if let Some(day) = &new_opening_on {
            fwd["opening_on"] = json!(day);
        }
        let mut bwd = json!({"id": row.id, "opening_minor": old_minor});
        if let Some(day) = &old_opening_on {
            bwd["opening_on"] = json!(day);
        }
        apart.push(Step::bare("account.set_opening", fwd));
        apart_back.push(Step::bare("account.set_opening", bwd));
        Ok(())
    }

    fn plan_edit_budget(
        &self,
        row: &Row,
        args: &Map<String, Value>,
        apart: &mut Vec<Step>,
        apart_back: &mut Vec<Step>,
        changed: &mut bool,
    ) -> Result<(), String> {
        let Some((category_id, month)) = row.id.rsplit_once(':') else {
            return Err(format!("error: malformed budget id \"{}\".", row.id));
        };
        let currency = match row.field("currency") {
            Some(Val::Text(c)) => c.clone(),
            _ => match row.field("amount") {
                Some(Val::Money(_, c)) => c.clone(),
                _ => self.world.currency.clone(),
            },
        };
        let old_minor = match row.field("amount") {
            Some(Val::Money(m, _)) => *m,
            _ => 0,
        };
        let old_carry = match row.field("carry") {
            Some(Val::Bool(b)) => *b,
            _ => false,
        };
        for (field, value) in args {
            match field.as_str() {
                "amount" => {
                    let new_minor = parse_money_in_currency(&text_of(value), &currency)?;
                    if new_minor < 0 {
                        return Err("error: a budget amount cannot be negative.".to_owned());
                    }
                    *changed |= new_minor != old_minor;
                    apart.push(Step::bare(
                        "budget.set",
                        json!({
                            "month": month,
                            "category_id": category_id,
                            "amount_minor": new_minor,
                            "currency": currency,
                        }),
                    ));
                    apart_back.push(Step::bare(
                        "budget.set",
                        json!({
                            "month": month,
                            "category_id": category_id,
                            "amount_minor": old_minor,
                            "currency": currency,
                            "carry": old_carry,
                        }),
                    ));
                }
                "carry" => {
                    let given = text_of(value);
                    let new_carry =
                        whr::parse_bool(&given).ok_or_else(|| whr::bool_error("carry", &given))?;
                    *changed |= new_carry != old_carry;
                    apart.push(Step::bare(
                        "budget.set_carry",
                        json!({
                            "month": month,
                            "category_id": category_id,
                            "carry": new_carry,
                        }),
                    ));
                    apart_back.push(Step::bare(
                        "budget.set_carry",
                        json!({
                            "month": month,
                            "category_id": category_id,
                            "carry": old_carry,
                        }),
                    ));
                }
                other => {
                    return Err(format!(
                        "error: {other} cannot be edited on a budget. budget editable fields: amount, carry."
                    ));
                }
            }
        }
        Ok(())
    }

    fn plan_edit_rule(&mut self, row: &Row, args: &Map<String, Value>) -> Result<Plan, String> {
        if args.is_empty() {
            return Err(
                "error: edit on a rule needs field: value lines (match, text, category, display_name, min, max, account, position)."
                    .to_owned(),
            );
        }
        let mut forward = json!({ "id": row.id });
        let mut backward = json!({ "id": row.id });
        let mut changed = false;
        for (raw_key, value) in args {
            match raw_key.as_str() {
                "match" => {
                    let m = text_of(value).to_lowercase();
                    if !matches!(m.as_str(), "is" | "contains" | "matches") {
                        return Err("error: rule match must be is, contains or matches.".to_owned());
                    }
                    let old = row.field("match").and_then(val_str).unwrap_or("contains");
                    changed |= old != m;
                    forward["match"] = json!(m);
                    backward["match"] = json!(old);
                }
                "text" => {
                    let t = text_of(value);
                    if t.trim().is_empty() {
                        return Err("error: rule text cannot be empty.".to_owned());
                    }
                    let old = row.field("text").and_then(val_str).unwrap_or(&row.name);
                    changed |= old != t;
                    forward["text"] = json!(t);
                    backward["text"] = json!(old);
                }
                "display_name" | "name" => {
                    let d = text_of(value);
                    let new_v = if d.trim().is_empty()
                        || matches!(d.to_lowercase().as_str(), "null" | "none")
                    {
                        Value::Null
                    } else {
                        json!(d)
                    };
                    let old_v = row
                        .field("display_name")
                        .and_then(val_str)
                        .map_or(Value::Null, |s| json!(s));
                    changed |= old_v != new_v;
                    forward["display_name"] = new_v;
                    backward["display_name"] = old_v;
                }
                "min" | "max" => {
                    let new_v = if value.is_null()
                        || matches!(text_of(value).to_lowercase().as_str(), "null" | "none" | "")
                    {
                        Value::Null
                    } else {
                        let n = parse_money_in_currency(&text_of(value), &self.world.currency)?;
                        if n < 0 {
                            return Err(format!("error: rule {raw_key} must be >= 0."));
                        }
                        json!(n)
                    };
                    let old_v = match row.field(raw_key) {
                        Some(Val::Num(n)) => json!(*n),
                        _ => Value::Null,
                    };
                    changed |= old_v != new_v;
                    forward[raw_key] = new_v;
                    backward[raw_key] = old_v;
                }
                "category" | "category_id" => {
                    let cat_id = self.resolve_one_target(value, Some(Kind::Category))?.1;
                    let old_cat = row.field("category").and_then(val_str).and_then(|title| {
                        self.world
                            .rows
                            .iter()
                            .find(|((k, _), r)| {
                                *k == Kind::Category && !r.trashed && r.name == title
                            })
                            .map(|((_, id), _)| id.clone())
                    });
                    changed |= old_cat.as_deref() != Some(cat_id.as_str());
                    forward["category_id"] = json!(cat_id);
                    if let Some(old_id) = old_cat {
                        backward["category_id"] = json!(old_id);
                    }
                }
                "account" | "account_id" => {
                    let new_v = if value.is_null()
                        || matches!(text_of(value).to_lowercase().as_str(), "null" | "none" | "")
                    {
                        Value::Null
                    } else {
                        json!(self.resolve_one_target(value, Some(Kind::Account))?.1)
                    };
                    changed = true;
                    forward["account_id"] = new_v;
                }
                "position" => {
                    let pos = value
                        .as_f64()
                        .or_else(|| text_of(value).trim().parse::<f64>().ok())
                        .ok_or("error: position must be a number.")?;
                    forward["position"] = json!(pos);
                    if let Some(Val::Num(old_pos)) = row.field("position") {
                        backward["position"] = json!(*old_pos);
                    }
                    changed = true;
                }
                other => {
                    return Err(format!("error: rules have no editable field \"{other}\"."));
                }
            }
        }
        if !changed {
            return Ok(Plan::Already("already has those values".to_owned()));
        }
        Ok(Plan::Run {
            steps: vec![Step {
                act: Call::bare("rule.edit"),
                input: forward,
            }],
            inverse: vec![Step {
                act: Call::bare("rule.edit"),
                input: backward,
            }],
            not_undoable: None,
            note: None,
        })
    }

    fn plan_edit_locker_field(
        &mut self,
        row: &Row,
        args: &Map<String, Value>,
    ) -> Result<Plan, String> {
        let item_id = row
            .extra
            .get("item_id")
            .cloned()
            .ok_or("error: locker field is missing its item id.")?;
        let mut label = row.name.clone();
        let mut field_kind = row
            .field("field_kind")
            .and_then(val_str)
            .unwrap_or("text")
            .to_owned();
        let mut new_val = row.field("value").and_then(val_str).map(str::to_owned);
        let mut pos = match row.field("position") {
            Some(Val::Num(n)) => Some(*n),
            _ => None,
        };
        let mut changed = false;
        for (raw_key, value) in args {
            match raw_key.as_str() {
                "label" | "name" => {
                    let l = text_of(value);
                    if l.trim().is_empty() {
                        return Err("error: locker field label cannot be empty.".to_owned());
                    }
                    changed |= l != label;
                    label = l;
                }
                "field_kind" | "kind" | "type" => {
                    let k = text_of(value).to_lowercase();
                    if !matches!(k.as_str(), "text" | "sealed" | "url" | "date" | "otp") {
                        return Err(
                            "error: locker field kind must be text, sealed, url, date or otp."
                                .to_owned(),
                        );
                    }
                    changed |= k != field_kind;
                    field_kind = k;
                }
                "value" => {
                    let v = text_of(value);
                    changed |= new_val.as_deref() != Some(v.as_str());
                    new_val = Some(v);
                }
                "position" => {
                    let p = value
                        .as_i64()
                        .or_else(|| text_of(value).trim().parse::<i64>().ok())
                        .ok_or("error: position must be an integer.")?;
                    changed |= pos != Some(p);
                    pos = Some(p);
                }
                other => {
                    return Err(format!(
                        "error: locker fields have no editable field \"{other}\"."
                    ));
                }
            }
        }
        if !changed {
            return Ok(Plan::Already("already has those values".to_owned()));
        }
        let mut input = json!({
            "item_id": item_id,
            "field_id": row.id,
            "label": label,
            "kind": field_kind,
        });
        if let Some(v) = new_val {
            input["value"] = json!(v);
        }
        if let Some(p) = pos {
            input["position"] = json!(p);
        }
        let is_sealed = matches!(
            row.field("field_kind").and_then(val_str),
            Some("sealed" | "otp")
        );
        let inverse = if is_sealed {
            Vec::new()
        } else {
            let mut back = json!({
                "item_id": item_id,
                "field_id": row.id,
                "label": row.name,
                "kind": row.field("field_kind").and_then(val_str).unwrap_or("text"),
            });
            if let Some(old_v) = row.field("value").and_then(val_str) {
                back["value"] = json!(old_v);
            }
            vec![Step {
                act: Call::bare("locker.set_field"),
                input: back,
            }]
        };
        Ok(Plan::Run {
            steps: vec![Step {
                act: Call::bare("locker.set_field"),
                input,
            }],
            not_undoable: inverse
                .is_empty()
                .then(|| "a sealed locker field's earlier value cannot be restored".to_owned()),
            inverse,
            note: None,
        })
    }

    fn plan_edit_contact_point(
        &mut self,
        row: &Row,
        args: &Map<String, Value>,
    ) -> Result<Plan, String> {
        let person_id = row
            .extra
            .get("person_id")
            .cloned()
            .or_else(|| row.field("person_id").and_then(val_str).map(str::to_owned))
            .ok_or("error: contact point is missing its person id.")?;
        let mut channel = row
            .field("channel")
            .and_then(val_str)
            .unwrap_or("phone")
            .to_owned();
        let mut val = row.name.clone();
        let mut label = row.field("label").and_then(val_str).map(str::to_owned);
        let mut preferred = matches!(row.field("preferred"), Some(Val::Bool(true)));
        let mut changed = false;
        for (raw_key, v) in args {
            match raw_key.as_str() {
                "channel" | "kind" => {
                    let c = text_of(v).to_lowercase();
                    if !matches!(c.as_str(), "phone" | "email" | "address" | "url" | "handle") {
                        return Err("error: contact point channel must be phone, email, address, url or handle.".to_owned());
                    }
                    changed |= c != channel;
                    channel = c;
                }
                "value" | "name" => {
                    let s = text_of(v);
                    if s.trim().is_empty() {
                        return Err("error: contact point value cannot be empty.".to_owned());
                    }
                    changed |= s != val;
                    val = s;
                }
                "label" => {
                    let s = text_of(v);
                    let next = if v.is_null()
                        || s.trim().is_empty()
                        || matches!(s.to_lowercase().as_str(), "null" | "none")
                    {
                        None
                    } else {
                        Some(s)
                    };
                    changed |= next != label;
                    label = next;
                }
                "preferred" => {
                    let given = text_of(v);
                    let b = whr::parse_bool(&given)
                        .ok_or_else(|| whr::bool_error("preferred", &given))?;
                    changed |= b != preferred;
                    preferred = b;
                }
                other => {
                    return Err(format!(
                        "error: contact points have no editable field \"{other}\"."
                    ));
                }
            }
        }
        if !changed {
            return Ok(Plan::Already("already has those values".to_owned()));
        }
        let mk = |c: &str, v: &str, l: Option<&str>, p: bool| {
            json!({
                "id": person_id,
                "point_id": row.id,
                "kind": c,
                "value": v,
                "label": l,
                "preferred": p,
            })
        };
        Ok(Plan::Run {
            steps: vec![Step {
                act: Call::bare("person.save_contact_point"),
                input: mk(&channel, &val, label.as_deref(), preferred),
            }],
            inverse: vec![Step {
                act: Call::bare("person.save_contact_point"),
                input: mk(
                    row.field("channel").and_then(val_str).unwrap_or("phone"),
                    &row.name,
                    row.field("label").and_then(val_str),
                    matches!(row.field("preferred"), Some(Val::Bool(true))),
                ),
            }],
            not_undoable: None,
            note: None,
        })
    }

    fn plan_edit_qualified(
        &mut self,
        qualifier: Option<&str>,
        row: &Row,
        args: &Map<String, Value>,
    ) -> Result<Plan, String> {
        let kind = row.kind;
        if qualifier == Some("content") && kind == Kind::Document {
            let handoff = meta::lookup(Verb::Edit, Kind::Document, Some("content"))
                .ok_or_else(|| not_applicable(Verb::Edit, kind))?;
            let name = self.named(&(kind, row.id.clone()));
            return Ok(Plan::Offer {
                actions: vec![handoff_action(handoff, &row.id)],
                note: format!("offered to the member: replace the content of {name}"),
            });
        }
        if kind == Kind::Rule {
            return self.plan_edit_rule(row, args);
        }
        if kind == Kind::LockerField {
            return self.plan_edit_locker_field(row, args);
        }
        if kind == Kind::ContactPoint {
            return self.plan_edit_contact_point(row, args);
        }
        // WHAT THE HEALTH STORE STATES is not written here: a workout it follows, and the daily
        // figures while a store is followed. The vault refuses both in these words; the runtime
        // says them first, so no card parks for a write that cannot land.
        if let Some(sentence) = self.store_states(row) {
            let (command, predicate) = if row.kind == Kind::Workout {
                ("workout.edit", "a_workout_the_member_logged")
            } else {
                ("measurement.log", "a_figure_no_store_states")
            };
            return Ok(Plan::Refused {
                command,
                input: json!({"id": row.id}),
                predicate,
                reason: sentence,
            });
        }
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
        // command → (input, inverse input); the action that runs each command is the one the
        // fields edited through it name (`calls`), the one that edits the kind in general when
        // they share a command
        let mut forward: BTreeMap<&'static str, Map<String, Value>> = BTreeMap::new();
        let mut backward: BTreeMap<&'static str, Map<String, Value>> = BTreeMap::new();
        let mut calls: BTreeMap<&'static str, &'static ActionSpec> = BTreeMap::new();
        // the edits that are a command of their own, not a field of one: a task's status, a
        // note's pin, a list's area (steps, in order, and the steps that put each back)
        let mut apart: Vec<Step> = Vec::new();
        let mut apart_back: Vec<Step> = Vec::new();
        let mut changed = false;
        let mut not_undoable: Option<String> = None;
        let mut offers: Vec<MemberAction> = Vec::new();
        let mut typed_secrets: Vec<(&'static str, String)> = Vec::new();
        if kind == Kind::Transaction {
            self.plan_edit_txn(
                row,
                args,
                &mut calls,
                &mut forward,
                &mut backward,
                &mut changed,
            )?;
        } else if kind == Kind::Budget {
            self.plan_edit_budget(row, args, &mut apart, &mut apart_back, &mut changed)?;
        } else {
            if kind == Kind::Account {
                self.plan_account_opening(row, args, &mut apart, &mut apart_back, &mut changed)?;
            }
            for (raw_field, value) in args {
                let field = match (kind, raw_field.as_str()) {
                    (Kind::Workout, "end" | "end_time") => "ends",
                    (_, other) => other,
                };
                if kind == Kind::Account && matches!(field, "opening" | "opening_on") {
                    continue;
                }
                if (kind, field) == (Kind::Account, "external_ref") {
                    let action = Verb::Edit
                        .action(Kind::Account)
                        .ok_or_else(|| not_applicable(Verb::Edit, Kind::Account))?;
                    note_call(&mut calls, action);
                    let raw = text_of(value);
                    let trimmed = raw.trim();
                    let new_ref = (!trimmed.is_empty()).then(|| trimmed.to_owned());
                    let old_ref = self.account_external_ref(&row.id)?;
                    changed |= new_ref != old_ref;
                    forward.entry(action.command).or_default().insert(
                        "external_ref".to_owned(),
                        new_ref.as_ref().map_or(Value::Null, |r| json!(r)),
                    );
                    backward.entry(action.command).or_default().insert(
                        "external_ref".to_owned(),
                        old_ref.as_ref().map_or(Value::Null, |r| json!(r)),
                    );
                    continue;
                }
                if (kind, field) == (Kind::Workout, "ends") {
                    let action = meta::edit_action(kind, "ends")
                        .ok_or_else(|| not_applicable(Verb::Edit, kind))?;
                    note_call(&mut calls, action);
                    let zone = self.world.zone.clone();
                    let start_stamp = row
                        .date
                        .ok_or_else(|| "error: workout has no start time.".to_owned())?;
                    let start_civil = start_stamp.at();
                    let end_civil = self.resolve_workout_end(value, start_stamp.date, row.date)?;
                    if end_civil < start_civil {
                        return Err(
                            "error: a workout cannot end before it starts (ends is earlier than starts)."
                                .to_owned(),
                        );
                    }
                    let new_ends = crate::native::world::utc_instant(&zone, end_civil)
                        .ok_or_else(|| format!("error: {end_civil} is not a time in {zone}."))?;
                    let prior_ends = self.workout_ends_iso(&row.id)?;
                    if prior_ends.as_deref() != Some(new_ends.as_str()) {
                        changed = true;
                    }
                    forward
                        .entry(action.command)
                        .or_default()
                        .insert("ends".to_owned(), json!(new_ends));
                    if let Some(old_iso) = prior_ends {
                        backward
                            .entry(action.command)
                            .or_default()
                            .insert("ends".to_owned(), json!(old_iso));
                    } else {
                        not_undoable.get_or_insert_with(|| {
                            "this workout had no end time earlier, so undo cannot remove it"
                                .to_owned()
                        });
                    }
                    continue;
                }
                if field == "name" {
                    let name = text_of(value);
                    if name.trim().is_empty() {
                        return Err("error: name cannot be empty.".to_owned());
                    }
                    let action = meta::edit_action(kind, "name")
                        .ok_or_else(|| not_applicable(Verb::Edit, kind))?;
                    let (command, param) = (
                        action.command,
                        action.property_named("name").unwrap_or("title"),
                    );
                    note_call(&mut calls, action);
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
                // A SECRET OF A LOCKER ITEM (#1135): typed in chat, it is an ordinary edit whose value
                // the door seals when the card is confirmed; with no value it is the member's to type
                // in Locker (`edit_secret`).
                if kind == Kind::LockerItem
                    && meta::REVEAL_FIELDS
                        .iter()
                        .any(|(name, column)| *name == field && *column != "content")
                {
                    let item_type = match row.field("type") {
                        Some(Val::Enum(item_type)) => *item_type,
                        _ => "login",
                    };
                    let Some(column) = meta::locker_secret_column(item_type, field) else {
                        return Err(format!(
                            "error: a {item_type} item has no place for {field}; nothing was stored."
                        ));
                    };
                    let typed = text_of(value);
                    if typed.trim().is_empty() {
                        offers.push(MemberAction {
                            kind: ActionKind::EditSecret,
                            item_id: row.id.clone(),
                            column: column.to_owned(),
                        });
                    } else {
                        typed_secrets.push((column, typed));
                        changed = true;
                    }
                    continue;
                }
                if kind == Kind::Document && field == "content" {
                    let handoff = meta::lookup(Verb::Edit, Kind::Document, Some("content"))
                        .ok_or_else(|| not_applicable(Verb::Edit, kind))?;
                    offers.push(handoff_action(handoff, &row.id));
                    continue;
                }
                if kind == Kind::Document && matches!(field, "text" | "body_text" | "body") {
                    let action = Verb::Edit
                        .action(Kind::Document)
                        .ok_or_else(|| not_applicable(Verb::Edit, Kind::Document))?;
                    note_call(&mut calls, action);
                    let text = text_of(value);
                    let old_text = row.field("text").and_then(val_str).unwrap_or("");
                    changed |= old_text != text;
                    forward
                        .entry(action.command)
                        .or_default()
                        .insert("body_text".to_owned(), json!(text));
                    backward
                        .entry(action.command)
                        .or_default()
                        .insert("body_text".to_owned(), json!(old_text));
                    continue;
                }
                if matches!(kind, Kind::List | Kind::Calendar) && matches!(field, "color" | "icon")
                {
                    let action = meta::lookup(Verb::Edit, kind, Some("color"))
                        .ok_or_else(|| not_applicable(Verb::Edit, kind))?;
                    note_call(&mut calls, action);
                    let s = text_of(value);
                    let next_json = if value.is_null()
                        || s.trim().is_empty()
                        || matches!(s.to_lowercase().as_str(), "null" | "none")
                    {
                        Value::Null
                    } else {
                        json!(s.trim())
                    };
                    let old_json = row
                        .field(field)
                        .and_then(val_str)
                        .map_or(Value::Null, |v| json!(v));
                    changed |= old_json != next_json;
                    forward
                        .entry(action.command)
                        .or_default()
                        .insert(field.to_owned(), next_json);
                    backward
                        .entry(action.command)
                        .or_default()
                        .insert(field.to_owned(), old_json);
                    continue;
                }
                if kind == Kind::Album && field == "cover" {
                    let s = text_of(value);
                    let photo_id = if value.is_null()
                        || s.trim().is_empty()
                        || matches!(s.to_lowercase().as_str(), "null" | "none")
                    {
                        Value::Null
                    } else {
                        json!(self.resolve_one_target(value, Some(Kind::Photo))?.1)
                    };
                    apart.push(Step {
                        act: Call::bare("album.set_cover"),
                        input: json!({ "id": row.id, "photo_id": photo_id }),
                    });
                    not_undoable.get_or_insert_with(|| {
                        "an album cover change stays until set again".to_owned()
                    });
                    changed = true;
                    continue;
                }
                if kind == Kind::Photo && field == "place" {
                    let s = text_of(value);
                    let place_id = if value.is_null()
                        || s.trim().is_empty()
                        || matches!(s.to_lowercase().as_str(), "null" | "none")
                    {
                        Value::Null
                    } else {
                        json!(self.resolve_one_target(value, Some(Kind::Place))?.1)
                    };
                    apart.push(Step {
                        act: Call::bare("photo.set_place"),
                        input: json!({ "id": row.id, "place_id": place_id }),
                    });
                    not_undoable.get_or_insert_with(|| {
                        "a photo place change stays until set again".to_owned()
                    });
                    changed = true;
                    continue;
                }
                if kind == Kind::LockerItem && matches!(field, "addresses" | "urls") {
                    let addrs: Vec<Value> = if let Some(arr) = value.as_array() {
                        arr.iter()
                            .map(|v| {
                                if v.is_object() {
                                    v.clone()
                                } else {
                                    json!({ "url": text_of(v) })
                                }
                            })
                            .collect()
                    } else {
                        text_of(value)
                            .split([',', '\n'])
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|u| json!({ "url": u }))
                            .collect()
                    };
                    apart.push(Step {
                        act: Call::bare("locker.set_addresses"),
                        input: json!({ "item_id": row.id, "addresses": addrs }),
                    });
                    not_undoable
                        .get_or_insert_with(|| "locker addresses stay until set again".to_owned());
                    changed = true;
                    continue;
                }
                if kind == Kind::LockerItem && field == "note" {
                    let note_text = text_of(value);
                    apart.push(Step {
                        act: Call::bare("locker.set_memo"),
                        input: json!({ "item_id": row.id, "note": note_text }),
                    });
                    not_undoable
                        .get_or_insert_with(|| "locker note stays until set again".to_owned());
                    changed = true;
                    continue;
                }
                if kind == Kind::ImportantDate && field == "reminders" {
                    let mins: Vec<i64> =
                        if let Some(arr) = value.as_array() {
                            arr.iter().filter_map(Value::as_i64).collect()
                        } else {
                            let s = text_of(value);
                            if value.is_null()
                                || s.trim().is_empty()
                                || matches!(s.to_lowercase().as_str(), "null" | "none" | "off")
                            {
                                Vec::new()
                            } else {
                                s.split(',')
                                    .map(str::trim)
                                    .filter(|p| !p.is_empty())
                                    .map(|p| {
                                        p.parse::<i64>().map_err(|_| {
                                    format!("error: reminders takes integer minutes, not \"{p}\".")
                                })
                                    })
                                    .collect::<Result<Vec<_>, _>>()?
                            }
                        };
                    let old_mins: Vec<i64> = match row.field("reminders") {
                        Some(Val::Num(n)) => vec![*n],
                        _ => Vec::new(),
                    };
                    apart.push(Step {
                        act: Call::bare("event.edit"),
                        input: json!({ "id": row.id, "reminders": mins }),
                    });
                    apart_back.push(Step {
                        act: Call::bare("event.edit"),
                        input: json!({ "id": row.id, "reminders": old_mins }),
                    });
                    changed = true;
                    continue;
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
                let special = matches!(
                    (kind, field),
                    (Kind::Task, "status") | (Kind::Note, "pinned") | (Kind::List, "area")
                );
                // the action that edits this field: the one that names it (`edit:cadence`), else the one
                // whose input takes it. A task's status, a note's pin and a list's area are commands
                // of their own, planned below.
                let action = meta::edit_action(kind, field);
                if action.is_none() && !special {
                    let hint = match (kind, field) {
                        (_, "starred") => "use star or unstar".to_owned(),
                        (Kind::Event, "status") => "use cancel".to_owned(),
                        (Kind::Task, "completed") => "use complete or reopen".to_owned(),
                        _ => format!("{} editable fields: {}", kind.name(), editable(kind)),
                    };
                    return Err(format!("error: {field} cannot be edited; {hint}."));
                }
                let command = action.map_or("", |action| action.command);
                if let Some(action) = action {
                    note_call(&mut calls, action);
                }
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
                        let on = whr::parse_bool(&given)
                            .ok_or_else(|| whr::bool_error(field, &given))?;
                        (json!(on), Some(Val::Bool(on)))
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
                // a task's status is three commands, one for each word it can be put in
                if (kind, field) == (Kind::Task, "status") {
                    let old_vault = match &old {
                        Some(Val::Enum(model)) => spec_field.vault_value(model).unwrap_or("open"),
                        _ => "open",
                    };
                    let new_vault = new_json.as_str().unwrap_or("open");
                    let to_status = |vault: &str| -> Result<Step, String> {
                        let action = meta::task_status_verb(vault)
                            .and_then(|verb| verb.action(Kind::Task))
                            .or_else(|| Verb::Reopen.action(Kind::Task))
                            .ok_or_else(|| not_applicable(Verb::Edit, Kind::Task))?;
                        Ok(Step::of(action, json!({ action.id_param: row.id })))
                    };
                    apart.push(to_status(new_vault)?);
                    apart_back.push(to_status(old_vault)?);
                    continue;
                }
                // a note is pinned by a flag, which is set and cleared by two commands
                if (kind, field) == (Kind::Note, "pinned") {
                    let flag = |on: bool| -> Result<Step, String> {
                        let verb = if on { Verb::Star } else { Verb::Unstar };
                        let action = verb
                            .action(Kind::Note)
                            .ok_or_else(|| not_applicable(Verb::Star, Kind::Note))?;
                        Ok(Step::of(
                            action,
                            json!({ action.id_param: row.id, "flag": "pinned" }),
                        ))
                    };
                    apart.push(flag(new_val == Some(Val::Bool(true)))?);
                    apart_back.push(flag(old == Some(Val::Bool(true)))?);
                    continue;
                }
                // a list sits in an area, which is a container of its own: found by its title, or made
                if (kind, field) == (Kind::List, "area") {
                    let area = text_of(value);
                    let (steps, back) = self.plan_area(row, area.trim());
                    apart.extend(steps);
                    apart_back.extend(back);
                    continue;
                }
                if kind == Kind::Event && field == "duration" {
                    let (start, end) = event_span(row);
                    let minutes = new_json.as_i64().unwrap_or(60).max(1);
                    let new_end = jiff::Span::new()
                        .try_minutes(minutes)
                        .and_then(|span| start.checked_add(span))
                        .map_err(|_| "error: that duration is out of range.".to_owned())?;
                    let times = event_times(row, start, new_end);
                    let back = event_times(row, start, end);
                    for (map, times) in [(&mut forward, times), (&mut backward, back)] {
                        if let Some(ends) = times.get("ends") {
                            map.entry(command)
                                .or_default()
                                .insert("ends".to_owned(), ends.clone());
                        }
                    }
                    continue;
                }
                // the property each model field is edited under is the one the action's input says it
                // as (`cadence` is `cadence_days`, `effort` is `effort_min`); `null` clears a column
                // that can be
                let param = action
                    .and_then(|action| action.property_named(field))
                    .unwrap_or(field);
                let (new_json, old_json) = match (kind, field) {
                    // a cadence of none is no column value
                    (Kind::Person, "cadence") => (
                        if new_json == json!(0) {
                            Value::Null
                        } else {
                            new_json
                        },
                        old.as_ref().map_or(Value::Null, Val::json),
                    ),
                    (Kind::Task, "effort") => {
                        (new_json, old.as_ref().map_or(Value::Null, Val::json))
                    }
                    (Kind::Task, "priority") => {
                        (new_json, old.as_ref().map_or(json!(0), Val::json))
                    }
                    // a body is never null: no words is an empty body
                    (Kind::Note, "body") => (new_json, old.as_ref().map_or(json!(""), Val::json)),
                    (Kind::Person, "role" | "nickname" | "met")
                    | (Kind::Task | Kind::Event, "description") => (
                        if new_json == json!("") {
                            Value::Null
                        } else {
                            new_json
                        },
                        old.as_ref().map_or(Value::Null, Val::json),
                    ),
                    // a Health figure goes back as the vault held it, not as the world shows it
                    (Kind::DailyFigure, "value") => (new_json, json!(self.figure_value(row)?)),
                    (Kind::Workout, "moving" | "distance" | "energy" | "heart_rate" | "climb") => {
                        (new_json, self.workout_figure(row, param)?)
                    }
                    _ => (new_json, old.as_ref().map_or(json!(""), Val::json)),
                };
                forward
                    .entry(command)
                    .or_default()
                    .insert(param.to_owned(), new_json);
                backward
                    .entry(command)
                    .or_default()
                    .insert(param.to_owned(), old_json);
            }
        }
        if !offers.is_empty() {
            if changed || !forward.is_empty() || !apart.is_empty() {
                return Err(
                    "error: a secret the member types in Locker is its own call; send it alone."
                        .to_owned(),
                );
            }
            let name = self.named(&row.key());
            let fields: Vec<&str> = offers.iter().map(|offer| offer.column.as_str()).collect();
            return Ok(Plan::Offer {
                note: format!(
                    "offered to the member: set the {} of {name}",
                    fields.join(", ")
                ),
                actions: offers,
            });
        }
        if !typed_secrets.is_empty() {
            let edit = meta::edit_actions(kind)
                .into_iter()
                .next()
                .ok_or_else(|| not_applicable(Verb::Edit, kind))?;
            note_call(&mut calls, edit);
            let sent = forward.entry(edit.command).or_default();
            for (column, typed) in &typed_secrets {
                sent.insert((*column).to_owned(), json!(typed));
                backward.entry(edit.command).or_default().insert(
                    (*column).to_owned(),
                    json!(centraid_vault::commands::locker::SEALED_PLACEHOLDER),
                );
            }
            not_undoable.get_or_insert_with(|| {
                "the earlier secret is sealed, so an undo cannot restore it".to_owned()
            });
        }
        if kind == Kind::LockerItem {
            let edit = meta::edit_actions(kind)
                .into_iter()
                .next()
                .ok_or_else(|| not_applicable(Verb::Edit, kind))?;
            self.locker_draft(
                row,
                edit.command,
                &mut forward,
                &mut backward,
                &mut not_undoable,
            )?;
        }
        if !changed {
            return Ok(Plan::Already("already has those values".to_owned()));
        }
        let finish = |map: BTreeMap<&'static str, Map<String, Value>>| -> Vec<Step> {
            map.into_iter()
                .filter(|(_, input)| !input.is_empty())
                .filter_map(|(command, mut input)| {
                    let action = *calls.get(command)?;
                    input.insert(action.id_param.to_owned(), json!(row.id));
                    Some(Step::of(action, Value::Object(input)))
                })
                .collect()
        };
        let (mut steps, mut inverse) = (finish(forward), finish(backward));
        steps.extend(apart);
        // the undo runs the last step first, so the pieces that came last go back first
        inverse.extend(apart_back);
        Ok(Plan::Run {
            steps,
            inverse,
            not_undoable,
            note: None,
        })
    }

    /// A list's area, as steps: the list moves into the area of that name (found by its title,
    /// without regard to case), or into one made for it; an empty name takes it out of its area.
    /// The second list is the undo, in the order the steps were made.
    fn plan_area(&self, row: &Row, area: &str) -> (Vec<Step>, Vec<Step>) {
        self.plan_area_for(&row.id, row.extra.get("area_id").cloned(), area)
    }

    fn plan_area_for(
        &self,
        project: &str,
        old: Option<String>,
        area: &str,
    ) -> (Vec<Step>, Vec<Step>) {
        let put = |parent: Option<String>| {
            Step::bare("container.move", json!({"id": project, "parent": parent}))
        };
        let back = put(old);
        if area.is_empty() {
            return (vec![put(None)], vec![back]);
        }
        if let Some((id, _)) = self
            .world
            .areas
            .iter()
            .find(|(_, title)| title.eq_ignore_ascii_case(area))
        {
            return (vec![put(Some(id.clone()))], vec![back]);
        }
        let id = self.door.mint_id();
        (
            vec![
                Step::bare(
                    "container.create",
                    json!({"id": id, "kind": "area", "title": area}),
                ),
                put(Some(id.clone())),
            ],
            // the undo puts the list back, then lets the area made for it go
            vec![Step::bare("entity.purge", json!({"id": id})), back],
        )
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
        command: &'static str,
        forward: &mut BTreeMap<&'static str, Map<String, Value>>,
        backward: &mut BTreeMap<&'static str, Map<String, Value>>,
        not_undoable: &mut Option<String>,
    ) -> Result<(), String> {
        let Some(input) = forward.get_mut(command) else {
            return Ok(());
        };
        let back = backward.entry(command).or_default();
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
                // A NOTE ITEM'S NOTES ARE SEALED: the typed text goes to the door as it is and is
                // sealed when the write runs (#1135); the old notes are a presence bit here, so
                // the undo cannot put them back.
                back.remove(field);
                input.insert("content".to_owned(), json!(text_of(&value)));
                back.insert(
                    "content".to_owned(),
                    json!(centraid_vault::commands::locker::SEALED_PLACEHOLDER),
                );
                not_undoable.get_or_insert_with(|| {
                    "the earlier notes are sealed, so an undo cannot restore them".to_owned()
                });
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

    /// `create`, with the people a new event is for (their vault ids; only an event takes them).
    fn create_with(
        &mut self,
        kind: Option<&str>,
        args: &Map<String, Value>,
        attendees: &[String],
    ) -> Result<Outcome, String> {
        self.create_qualified(kind, None, args, attendees)
    }

    fn create_qualified(
        &mut self,
        kind: Option<&str>,
        qualifier: Option<&str>,
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
            .filter(|kind| {
                Verb::Create.command(*kind).is_some()
                    || matches!(
                        kind,
                        Kind::Calendar
                            | Kind::LockerField
                            | Kind::ContactPoint
                            | Kind::ImportantDate
                            | Kind::Gift
                            | Kind::PeopleList
                            | Kind::JournalEntry
                            | Kind::Place
                            | Kind::Section
                            | Kind::Rule
                            | Kind::Budget
                    )
            })
            .ok_or_else(|| {
                format!(
                    "error: create needs the kind parameter set to one of {}.",
                    creatable.join(", ")
                )
            })?;
        let action_opt = qualifier
            .and_then(|q| meta::lookup(Verb::Create, kind, Some(q)))
            .or_else(|| Verb::Create.action(kind));
        // THE ONE LOOKUP: the action that creates this kind, and the names its input says things as.
        // Sidecar/upsert kinds (`locker_field`, `contact_point`, `budget`) dispatch via explicit commands below.
        if action_opt.is_none()
            && !matches!(kind, Kind::LockerField | Kind::ContactPoint | Kind::Budget)
        {
            return Err(not_applicable(Verb::Create, kind));
        }
        let action = action_opt.unwrap_or(&meta::ACTIONS[0]);
        let mut allowed: Vec<&str> = meta::create_args(kind).to_vec();
        let extra_allowed: &[&str] = match kind {
            Kind::Task => &[
                "from_note",
                "note",
                "exact",
                "about",
                "person",
                "for",
                "text",
            ],
            Kind::Note => &["about", "person", "for", "text"],
            Kind::List | Kind::Calendar => &["color", "icon"],
            Kind::Section => &["list", "project", "parent", "position"],
            Kind::Place => &["address", "lat", "lon", "zone"],
            Kind::ImportantDate => &["person", "about", "for", "label", "date", "reminder_on"],
            Kind::Gift => &["person", "about", "for", "text"],
            Kind::JournalEntry => &["mood", "text", "body", "date"],
            Kind::Rule => &[
                "match",
                "text",
                "category",
                "category_id",
                "display_name",
                "min",
                "max",
                "account",
                "account_id",
                "position",
            ],
            Kind::Budget => &[
                "category",
                "category_id",
                "month",
                "amount",
                "budget",
                "currency",
                "carry",
            ],
            Kind::LockerField => &[
                "item",
                "row",
                "locker_item",
                "label",
                "kind",
                "field_kind",
                "type",
                "value",
                "section",
                "position",
            ],
            Kind::ContactPoint => &[
                "person",
                "about",
                "for",
                "row",
                "channel",
                "kind",
                "type",
                "value",
                "label",
                "preferred",
            ],
            _ => &[],
        };
        for extra in extra_allowed {
            if !allowed.contains(extra) {
                allowed.push(extra);
            }
        }
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
            .or_else(|| args.get("label"))
            .or_else(|| args.get("text"))
            .or_else(|| args.get("title"))
            .or_else(|| args.get("category"))
            .or_else(|| args.get("value"))
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
        // EVERY CREATE NAMES THE ID IT WILL HAVE: a parked card shows it, and the confirm writes
        // the row the card named (the vault honours an id the caller minted).
        // a list's area: a container found by its title, or one made after the list
        let mut step_call = action.call();
        let mut area_follow: Vec<Step> = Vec::new();
        let mut fallback_id: Option<String> = None;
        let mut custom_inverse: Option<Vec<Inverse>> = None;
        let (input, id_out): (Value, &'static str) = match kind {
            Kind::Person => {
                let mut input = json!({"id": mint(), "title": name});
                if let Some(cadence) = number("cadence")?.filter(|days| *days > 0) {
                    input["cadence_days"] = json!(cadence);
                }
                for field in ["role", "nickname"] {
                    if let Some(value) = text(field) {
                        input[field] = json!(value);
                    }
                }
                (input, action.id_param)
            }
            Kind::Event => {
                let resolved = date.ok_or("error: create event needs date: <date expression>.")?;
                let spell = |at: jiff::civil::DateTime| {
                    format!("{}T{}:00", at.date(), dates::clock(at.time()))
                };
                let (starts, ends, timing) = match resolved {
                    dates::Resolved::Between { from, to } => (spell(from), spell(to), "floating"),
                    dates::Resolved::At(at) => {
                        let minutes = number("duration")?.unwrap_or(60).max(1);
                        let end = jiff::Span::new()
                            .try_minutes(minutes)
                            .and_then(|span| at.checked_add(span))
                            .map_err(|_| "error: that duration is out of range.".to_owned())?;
                        (spell(at), spell(end), "floating")
                    }
                    // a day is a day: an all-day event, whose end is its LAST day
                    dates::Resolved::Days { from, to } => {
                        (from.to_string(), to.to_string(), "all-day")
                    }
                };
                // a PROPOSED event is tentative until the member says otherwise
                let mut input = json!({
                    "id": mint(),
                    "title": name,
                    "starts": starts,
                    "ends": ends,
                    "timing": timing,
                    "status": "tentative",
                });
                if let Some(description) = text("description") {
                    input["description"] = json!(description);
                }
                if !attendees.is_empty() {
                    input["attendees"] = json!(attendees);
                }
                (input, action.id_param)
            }
            Kind::Task => {
                if qualifier == Some("about") || args.contains_key("about") {
                    step_call = Call::bare("person.add_task");
                    let p_val = args
                        .get("about")
                        .or_else(|| args.get("person"))
                        .or_else(|| args.get("for"))
                        .ok_or("error: create:about task needs about: <person>.")?;
                    let person = self.resolve_one_target(p_val, Some(Kind::Person))?;
                    let task_text = text("text").unwrap_or_else(|| name.clone());
                    (json!({"id": person.1, "text": task_text}), "task_id")
                } else {
                    let tid = mint();
                    let mut input = json!({"id": tid, "title": name});
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
                        input["due"] = json!(point.vault());
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
                        input["parent_id"] = json!(parent.1);
                    }
                    // the list is a column of the task: no second command to file it
                    if let Some(list) = &list {
                        input["project_id"] = json!(list.1);
                    }
                    if let Some(note_val) = args.get("from_note").or_else(|| args.get("note")) {
                        let note_key = self.resolve_one_target(note_val, Some(Kind::Note))?;
                        area_follow.push(Step::bare(
                            "edge.add",
                            json!({"from": tid, "rel": "about", "to": note_key.1}),
                        ));
                    }
                    (input, action.id_param)
                }
            }
            Kind::Note => {
                if qualifier == Some("about") || args.contains_key("about") {
                    step_call = Call::bare("person.add_note");
                    let p_val = args
                        .get("about")
                        .or_else(|| args.get("person"))
                        .or_else(|| args.get("for"))
                        .ok_or("error: create:about note needs about: <person>.")?;
                    let person = self.resolve_one_target(p_val, Some(Kind::Person))?;
                    let note_text = text("text")
                        .or_else(|| text("body"))
                        .unwrap_or_else(|| name.clone());
                    (json!({"id": person.1, "text": note_text}), "note_id")
                } else {
                    let body = text("body").unwrap_or_else(|| name.clone());
                    let mut input = json!({"id": mint(), "title": name, "body": body});
                    if let Some(notebook) = one_row(self, "notebook", Kind::Notebook)? {
                        input["notebook_id"] = json!(notebook.1);
                    }
                    (input, action.id_param)
                }
            }
            Kind::Document => {
                let body = text("text").unwrap_or_else(|| name.clone());
                let mut input = json!({
                    "id": mint(),
                    "title": name,
                    "body_text": body,
                    "media_type": "text/plain",
                });
                if let Some(folder) = one_row(self, "folder", Kind::Folder)? {
                    input["folder_id"] = json!(folder.1);
                }
                (input, action.id_param)
            }
            Kind::List => {
                let id = mint();
                if let Some(area) = text("area") {
                    let (steps, _) = self.plan_area_for(&id, None, area.trim());
                    area_follow = steps;
                }
                let mut input = input_of(action, &id, &[("name", json!(name))]);
                if let Some(color) = text("color") {
                    input["color"] = json!(color);
                }
                if let Some(icon) = text("icon") {
                    input["icon"] = json!(icon);
                }
                (input, action.id_param)
            }
            Kind::Calendar => {
                step_call = Call::bare("container.create");
                let mut input = json!({"id": mint(), "kind": "calendar", "title": name});
                if let Some(color) = text("color") {
                    input["color"] = json!(color);
                }
                if let Some(icon) = text("icon") {
                    input["icon"] = json!(icon);
                }
                (input, "id")
            }
            Kind::PeopleList => {
                step_call = Call::bare("container.create");
                (json!({"id": mint(), "kind": "list", "title": name}), "id")
            }
            Kind::Section => {
                step_call = Call::bare("container.create");
                let mut input = json!({"id": mint(), "kind": "section", "title": name});
                if let Some(pval) = args
                    .get("list")
                    .or_else(|| args.get("project"))
                    .or_else(|| args.get("parent"))
                {
                    let parent = self.resolve_one_target(pval, Some(Kind::List))?;
                    input["parent"] = json!(parent.1);
                }
                if let Some(pos) = number("position")? {
                    input["position"] = json!(pos);
                }
                (input, "id")
            }
            Kind::Place => {
                step_call = Call::bare("place.add");
                let mut input = json!({"id": mint(), "title": name});
                if let Some(addr) = text("address") {
                    input["address"] = json!(addr);
                }
                for coord in ["lat", "lon"] {
                    if let Some(v) = args.get(coord) {
                        let n = v
                            .as_f64()
                            .or_else(|| text_of(v).trim().parse::<f64>().ok())
                            .ok_or_else(|| format!("error: {coord} must be a number."))?;
                        input[coord] = json!(n);
                    }
                }
                (input, "id")
            }
            Kind::ImportantDate => {
                step_call = Call::bare("person.add_date");
                let p_val = args
                    .get("person")
                    .or_else(|| args.get("about"))
                    .or_else(|| args.get("for"))
                    .ok_or("error: create important date needs person: <person>.")?;
                let person = self.resolve_one_target(p_val, Some(Kind::Person))?;
                let month_day = if let Some(resolved) = date {
                    let pt = resolved
                        .point()
                        .ok_or("error: date must be a single day.")?;
                    format!("{:02}-{:02}", pt.date.month(), pt.date.day())
                } else {
                    return Err(
                        "error: create important date needs date: <month and day>.".to_owned()
                    );
                };
                let label = text("label").unwrap_or_else(|| name.clone());
                let mut input = json!({"id": person.1, "label": label, "month_day": month_day});
                if let Some(v) = args.get("reminder_on") {
                    let b = whr::parse_bool(&text_of(v))
                        .ok_or_else(|| whr::bool_error("reminder_on", &text_of(v)))?;
                    input["reminder_on"] = json!(b);
                }
                (input, "date_id")
            }
            Kind::Gift => {
                step_call = Call::bare("person.add_gift");
                let p_val = args
                    .get("person")
                    .or_else(|| args.get("about"))
                    .or_else(|| args.get("for"))
                    .ok_or("error: create gift needs person: <person>.")?;
                let person = self.resolve_one_target(p_val, Some(Kind::Person))?;
                let gift_text = text("text").unwrap_or_else(|| name.clone());
                (json!({"id": person.1, "text": gift_text}), "task_id")
            }
            Kind::JournalEntry => {
                step_call = Call::bare("person.add_journal_entry");
                let mood = text("mood").unwrap_or_else(|| "neutral".to_owned());
                let body = text("text")
                    .or_else(|| text("body"))
                    .unwrap_or_else(|| name.clone());
                let mut input = json!({"mood": mood, "text": body});
                if let Some(resolved) = date {
                    let pt = resolved
                        .point()
                        .ok_or("error: journal entry date must be a single day.")?;
                    input["entry_date"] = json!(pt.date.to_string());
                }
                (input, "entry_id")
            }
            Kind::Rule => {
                step_call = Call::bare("rule.add");
                let rule_id = mint();
                let m = text("match")
                    .unwrap_or_else(|| "contains".to_owned())
                    .to_lowercase();
                if !matches!(m.as_str(), "is" | "contains" | "matches") {
                    return Err("error: rule match must be is, contains or matches.".to_owned());
                }
                let rule_text = text("text").unwrap_or_else(|| name.clone());
                let cat_val = args
                    .get("category")
                    .or_else(|| args.get("category_id"))
                    .ok_or("error: create rule needs category: <category>.")?;
                let cat_id = self.resolve_one_target(cat_val, Some(Kind::Category))?.1;
                let mut input = json!({
                    "id": rule_id,
                    "match": m,
                    "text": rule_text,
                    "category_id": cat_id,
                });
                if let Some(dn) = text("display_name") {
                    input["display_name"] = json!(dn);
                }
                for bound in ["min", "max"] {
                    if let Some(v) = args.get(bound) {
                        let minor = parse_money_in_currency(&text_of(v), &self.world.currency)?;
                        if minor < 0 {
                            return Err(format!("error: rule {bound} must be >= 0."));
                        }
                        input[bound] = json!(minor);
                    }
                }
                if let Some(acc) = args.get("account").or_else(|| args.get("account_id")) {
                    let acc_id = self.resolve_one_target(acc, Some(Kind::Account))?.1;
                    input["account_id"] = json!(acc_id);
                }
                if let Some(pos) = number("position")? {
                    input["position"] = json!(pos);
                }
                custom_inverse = Some(vec![Inverse {
                    act: Call::bare("rule.delete"),
                    input: json!({ "id": rule_id }),
                    key: (Kind::Rule, rule_id),
                }]);
                (input, "id")
            }
            Kind::Budget => {
                step_call = Call::bare("budget.set");
                let cat_id = match args.get("category").or_else(|| args.get("category_id")) {
                    Some(v) => self.resolve_one_target(v, Some(Kind::Category))?.1,
                    None => {
                        self.resolve_one_target(&json!(name), Some(Kind::Category))?
                            .1
                    }
                };
                let month = text("month").unwrap_or_else(|| {
                    format!(
                        "{:04}-{:02}",
                        self.now.date().year(),
                        self.now.date().month()
                    )
                });
                let currency = text("currency").unwrap_or_else(|| self.world.currency.clone());
                let amt_val = args
                    .get("amount")
                    .or_else(|| args.get("budget"))
                    .ok_or("error: create budget needs amount: <money>.")?;
                let minor = parse_money_in_currency(&text_of(amt_val), &currency)?;
                if minor < 0 {
                    return Err("error: budget amount must be >= 0.".to_owned());
                }
                let mut input = json!({
                    "month": month,
                    "category_id": cat_id,
                    "amount_minor": minor,
                    "currency": currency,
                });
                if let Some(v) = args.get("carry") {
                    let b = whr::parse_bool(&text_of(v))
                        .ok_or_else(|| whr::bool_error("carry", &text_of(v)))?;
                    input["carry"] = json!(b);
                }
                fallback_id = Some(format!("{cat_id}:{month}"));
                custom_inverse = Some(vec![Inverse {
                    act: Call::bare("budget.set"),
                    input: json!({
                        "month": month,
                        "category_id": cat_id,
                        "amount_minor": Value::Null,
                    }),
                    key: (Kind::Budget, format!("{cat_id}:{month}")),
                }]);
                (input, "id")
            }
            Kind::LockerField => {
                step_call = Call::bare("locker.set_field");
                let item_val = args
                    .get("item")
                    .or_else(|| args.get("row"))
                    .or_else(|| args.get("locker_item"))
                    .ok_or("error: create locker field needs item: <locker item>.")?;
                let item_id = self.resolve_one_target(item_val, Some(Kind::LockerItem))?.1;
                let field_id = self.door.mint_id();
                let label = text("label").unwrap_or_else(|| name.clone());
                let fk = text("field_kind")
                    .or_else(|| text("kind"))
                    .or_else(|| text("type"))
                    .unwrap_or_else(|| "text".to_owned())
                    .to_lowercase();
                let mut input = json!({
                    "item_id": item_id,
                    "field_id": field_id,
                    "label": label,
                    "kind": fk,
                });
                if let Some(v) = text("value") {
                    input["value"] = json!(v);
                }
                if let Some(s) = text("section") {
                    input["section"] = json!(s);
                }
                if let Some(pos) = number("position")? {
                    input["position"] = json!(pos);
                }
                custom_inverse = Some(vec![Inverse {
                    act: Call::bare("locker.remove_field"),
                    input: json!({ "item_id": item_id, "field_id": field_id }),
                    key: (Kind::LockerField, field_id),
                }]);
                (input, "field_id")
            }
            Kind::ContactPoint => {
                step_call = Call::bare("person.save_contact_point");
                let p_val = args
                    .get("person")
                    .or_else(|| args.get("about"))
                    .or_else(|| args.get("for"))
                    .or_else(|| args.get("row"))
                    .ok_or("error: create contact point needs person: <person>.")?;
                let person_id = self.resolve_one_target(p_val, Some(Kind::Person))?.1;
                let point_id = self.door.mint_id();
                let ch = text("channel")
                    .or_else(|| text("kind"))
                    .or_else(|| text("type"))
                    .unwrap_or_else(|| "phone".to_owned())
                    .to_lowercase();
                let val = text("value").unwrap_or_else(|| name.clone());
                let mut input = json!({
                    "id": person_id,
                    "point_id": point_id,
                    "kind": ch,
                    "value": val,
                });
                if let Some(lbl) = text("label") {
                    input["label"] = json!(lbl);
                }
                if let Some(v) = args.get("preferred") {
                    let b = whr::parse_bool(&text_of(v))
                        .ok_or_else(|| whr::bool_error("preferred", &text_of(v)))?;
                    input["preferred"] = json!(b);
                }
                custom_inverse = Some(vec![Inverse {
                    act: Call::bare("person.remove_contact_point"),
                    input: json!({ "point_id": point_id }),
                    key: (Kind::ContactPoint, point_id),
                }]);
                (input, "point_id")
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
                        // sealed by the door when the write runs (#1135)
                        input["content"] = json!(value);
                    } else {
                        input[column] = json!(value);
                    }
                }
                // A SECRET THE MEMBER TYPED goes to the door as typed and is sealed when the write
                // runs (#1135, the door's rule): the vault takes ciphertext only.
                for (field, _) in meta::REVEAL_FIELDS {
                    let Some(value) = text(field).filter(|_| *field != "content") else {
                        continue;
                    };
                    // `normalize.rs` already left out what the type cannot keep
                    let Some(column) = meta::locker_secret_column(kind_value, field) else {
                        continue;
                    };
                    input[column] = json!(value);
                }
                (input, action.id_param)
            }
            // AN ACCOUNT NAMES ITS TYPE (the vault has no default for what money it holds).
            Kind::Account => {
                let Some(kind_value) = text("type") else {
                    return Err(
                        "error: create account needs type: checking | savings | credit card | cash."
                            .to_owned(),
                    );
                };
                let kind_value = whr::enum_value(Kind::Account, "type", &kind_value)?;
                let currency = match text("currency") {
                    Some(cur) => {
                        let code = cur.trim().to_ascii_uppercase();
                        if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_alphabetic()) {
                            return Err(format!(
                                "error: currency must be a 3-letter ISO code like USD or INR, not \"{}\".",
                                cur.trim()
                            ));
                        }
                        code
                    }
                    None => self.world.currency.clone(),
                };
                let opening_minor = if let Some(val) = args.get("opening") {
                    Some(parse_money_in_currency(&text_of(val), &currency)?)
                } else {
                    None
                };
                let opening_on = match args.get("opening_on") {
                    Some(val) if !text_of(val).trim().is_empty() => {
                        Some(self.resolve_date_day(val)?)
                    }
                    _ => None,
                };
                if opening_minor.unwrap_or(0) != 0 && opening_on.is_none() {
                    return Err(
                        "error: An opening balance needs the day it was true (opening_on: <date>)."
                            .to_owned(),
                    );
                }
                let on_budget = match args.get("on_budget") {
                    Some(val) => {
                        let given = text_of(val);
                        Some(
                            whr::parse_bool(&given)
                                .ok_or_else(|| whr::bool_error("on_budget", &given))?,
                        )
                    }
                    None => None,
                };
                let mut input = json!({
                    "id": self.door.mint_id(),
                    "title": name,
                    "type": kind_value,
                    "currency": currency,
                });
                if let Some(opening_minor) = opening_minor {
                    input["opening_minor"] = json!(opening_minor);
                }
                if let Some(opening_on) = opening_on {
                    input["opening_on"] = json!(opening_on);
                }
                if let Some(on_budget) = on_budget {
                    input["on_budget"] = json!(on_budget);
                }
                if let Some(external_ref) = text("external_ref") {
                    input["external_ref"] = json!(external_ref.trim());
                }
                (input, action.id_param)
            }
            // A DAILY FIGURE THE MEMBER STATES: the metric (its name), the day and the value, while
            // no health store is followed (a store states them at each read)
            Kind::DailyFigure => {
                if let Some(store) = &self.world.health_store {
                    return Err(format!(
                        "error: These figures come from {store}; change them there, not here. Nothing was done."
                    ));
                }
                let day = match date.ok_or("error: create daily figure needs date: <a day>.")? {
                    dates::Resolved::At(at) => at.date(),
                    dates::Resolved::Days { from, to } if from == to => from,
                    other => {
                        return Err(format!(
                            "error: a daily figure is for one day; {} is more.",
                            other.echo()
                        ));
                    }
                };
                let metric = whr::enum_value(Kind::DailyFigure, "metric", &name)?;
                // a log is an upsert, and its undo clears the row: a day that already holds the
                // figure is changed with `edit`, which puts the old value back
                let held = self
                    .exact_number(
                        "measurement",
                        "value",
                        ("day", "metric"),
                        "person_id = ? AND day = ? AND metric = ?",
                        &[self.world.me.clone(), day.to_string(), metric.to_owned()],
                    )?
                    .is_some();
                if held {
                    return Err(format!(
                        "error: there is already a {metric} figure for {day}; change it with edit."
                    ));
                }
                let value = number("value")?
                    .ok_or("error: create daily figure needs value: <a number>.")?;
                (
                    json!({"day": day.to_string(), "metric": metric, "value": value}),
                    action.id_param,
                )
            }
            // A WORKOUT THE MEMBER LOGS: a title, when it started (and when it ended, for a span
            // or explicit `ends`) and the figures they state, in the units the kind shows
            Kind::Workout => {
                let resolved =
                    date.ok_or("error: create workout needs date: <date expression>.")?;
                // the time they say is on their clock; the vault keeps the instant it is
                let zone = self.world.zone.clone();
                let spell = |at: jiff::civil::DateTime| {
                    crate::native::world::utc_instant(&zone, at)
                        .ok_or_else(|| format!("error: {at} is not a time in {zone}."))
                };
                let (start_civil, span_end) = match resolved {
                    dates::Resolved::Between { from, to } => (from, Some(to)),
                    dates::Resolved::At(at) => (at, None),
                    // a day alone is that day's midnight, which is what the vault keeps of it
                    dates::Resolved::Days { from, .. } => (from.at(0, 0, 0, 0), None),
                };
                let end_civil = if let Some(ends_val) = args.get("ends") {
                    let anchor = Some(Stamp {
                        date: start_civil.date(),
                        time: Some(
                            jiff::civil::Time::new(start_civil.hour(), start_civil.minute(), 0, 0)
                                .unwrap_or(start_civil.time()),
                        ),
                    });
                    Some(self.resolve_workout_end(ends_val, start_civil.date(), anchor)?)
                } else {
                    span_end
                };
                if let Some(end) = end_civil
                    && end < start_civil
                {
                    return Err(
                        "error: a workout cannot end before it starts (ends is earlier than starts)."
                            .to_owned(),
                    );
                }
                let starts = spell(start_civil)?;
                let mut input = json!({"id": self.door.mint_id(), "title": name, "starts": starts});
                if let Some(end) = end_civil {
                    input["ends"] = json!(spell(end)?);
                }
                if let Some(word) = text("type") {
                    input["type"] = json!(word);
                }
                for (field, column) in [
                    ("moving", "moving_s"),
                    ("distance", "distance_m"),
                    ("energy", "energy_kcal"),
                    ("heart_rate", "heart_bpm"),
                    ("climb", "climb_m"),
                ] {
                    if let Some(figure) = number(field)? {
                        input[column] = json!(figure);
                    }
                }
                (input, action.id_param)
            }
            // A CATEGORY'S ID IS ITS NAME: the core derives it, so there is none to mint.
            Kind::Category => (json!({"title": name}), "id"),
            // ANY OTHER KIND the catalog creates is its create action's input as the manifest
            // says it: the name, the id the core would mint, what can only be one value and what
            // has a default. A container (an album, a notebook, a folder) is that and nothing more,
            // so a kind made live in chat needs only its manifest rows.
            _ => (
                input_of(action, &mint(), &[("name", json!(name))]),
                action.id_param,
            ),
        };
        let before = self.world.clone();
        let ran = self.write_step(&step_call, &input)?;
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
            .or_else(|| ran.output.get("id").and_then(Value::as_str))
            .map(str::to_owned)
            .or(fallback_id)
            .unwrap_or_default();
        let birthday_update = kind == Kind::ImportantDate && ran.output.get("date_id").is_none();
        let key = if birthday_update {
            (Kind::Person, id.clone())
        } else {
            (kind, id.clone())
        };
        // Follow-ups that the create command itself does not take.
        let follow = area_follow;
        for step in follow {
            if let Err(error) = self.write_must(&step.act, step.input) {
                // Take the half-made row back out, so no later diff finds it.
                if !birthday_update && let Some(delete) = Verb::Delete.action(kind) {
                    self.door.advance();
                    let _ = self.write_step(&delete.call(), &json!({ delete.id_param: id }));
                }
                self.settle()?;
                return Err(error);
            }
        }
        let inverse = if let Some(inv) = custom_inverse {
            inv
        } else if birthday_update {
            Vec::new()
        } else {
            match Verb::Delete.action(kind) {
                Some(delete) => vec![Inverse {
                    act: delete.call(),
                    input: json!({ delete.id_param: id }),
                    key: key.clone(),
                }],
                None => Vec::new(),
            }
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

/// Parse a user-entered money expression in `currency`, rejecting mismatched currency symbols
/// or trailing 3-letter ISO currency codes.
fn parse_money_in_currency(raw: &str, currency: &str) -> Result<i64, String> {
    whr::symbol_conflict(raw, currency)?;
    let (amount, code) = whr::parse_money_value(raw)?;
    if let Some(code) = code
        && code.len() == 3
        && code.bytes().all(|b| b.is_ascii_alphabetic())
        && code != currency
    {
        return Err(format!(
            "error: amounts are in {currency} here; \"{}\" names {code}. Write the number in {currency}.",
            raw.trim()
        ));
    }
    Ok(crate::native::world::minor_of(amount, currency))
}

/// A verb as a question names it: `delete`, `complete`, `change`.
fn verb_phrase(verb: Verb) -> &'static str {
    match verb {
        Verb::Edit => "change",
        Verb::AddTo => "add",
        Verb::RemoveFrom => "remove",
        Verb::Log => "log a contact with",
        Verb::EmptyTrash => "empty the trash for",
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
    /// Whether this irreversible write was already asked and confirmed in the previous turn.
    pub(crate) fn confirmed_action(
        &mut self,
        verb: Verb,
        kind: Option<Kind>,
        keys: &[Key],
        extra: &Map<String, Value>,
    ) -> bool {
        let Some(pending) = &self.pending_confirm else {
            return false;
        };
        let same = pending.turn + 1 == self.turn
            && pending.verb == verb
            && pending.kind == kind
            && pending.keys == keys.iter().cloned().collect::<BTreeSet<Key>>()
            && pending.args == canonical_json(&Value::Object(extra.clone()));
        if !same || !says_yes(&self.message) {
            return false;
        }
        self.pending_confirm = None;
        true
    }

    /// Ask the person before running an irreversible action (`purge`, `empty_trash`, `merge`,
    /// `unfollow`, or `delete` on a rule). Nothing is written until confirmed.
    pub(crate) fn confirm_ask(
        &mut self,
        verb: Verb,
        kind: Option<Kind>,
        keys: &[Key],
        extra: &Map<String, Value>,
    ) -> Outcome {
        let rows: Vec<&Row> = keys.iter().filter_map(|key| self.world.row(key)).collect();
        let mut kinds: Vec<Kind> = Vec::new();
        for key in keys {
            if !kinds.contains(&key.0) {
                kinds.push(key.0);
            }
        }
        let what = if !rows.is_empty() {
            render::count_phrase(&kinds, &rows)
        } else if let Some(k) = kind {
            k.plural().to_owned()
        } else {
            "these items".to_owned()
        };
        let phrase = verb_phrase(verb);
        let question = match verb {
            Verb::Purge => format!("this would permanently purge {what}; purge?"),
            Verb::EmptyTrash => {
                format!("this would permanently empty the trash for {what}; empty the trash?")
            }
            Verb::Merge => format!("this would permanently merge {what}; merge?"),
            Verb::Unfollow => format!("this would stop following {what}; unfollow?"),
            _ => format!("this would permanently {phrase} {what}; {phrase}?"),
        };
        self.pending_confirm = Some(PendingConfirm {
            turn: self.turn,
            verb,
            kind,
            keys: keys.iter().cloned().collect(),
            args: canonical_json(&Value::Object(extra.clone())),
        });
        let note = "the runtime ended the turn asking for confirmation; after a yes, send the same call again";
        let mut outcome = self.ends_in_ask(None, &question, &[], note);
        outcome.effect.insert(
            "confirm".to_owned(),
            json!({
                "verb": verb.spec().name,
                "confirmed": false,
            }),
        );
        outcome
            .effect
            .insert("verb".to_owned(), json!(verb.spec().name));
        outcome
    }

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

/// A span as `event.edit` and `event.propose` take it, under the row's own timing: a wall clock
/// (and the row's zone, when it is zoned) for a timed event, and for an all-day one the first day
/// and the LAST day, inclusive. The model's span ends where the next one could begin, so an
/// all-day end is the day before it.
pub(crate) fn event_times(
    row: &Row,
    start: jiff::civil::DateTime,
    end: jiff::civil::DateTime,
) -> Value {
    let wall = |at: jiff::civil::DateTime| format!("{}T{}:00", at.date(), dates::clock(at.time()));
    match row.extra.get("timing").map(String::as_str) {
        Some("all-day") => {
            let last = end
                .date()
                .yesterday()
                .ok()
                .filter(|day| *day >= start.date());
            json!({"starts": start.date().to_string(), "ends": last.unwrap_or(start.date()).to_string()})
        }
        Some("zoned") => {
            json!({"starts": wall(start), "ends": wall(end), "zone": row.extra.get("zone")})
        }
        _ => json!({"starts": wall(start), "ends": wall(end)}),
    }
}

/// Remember the action that runs a command: the one that edits the kind in general wins a command
/// it shares with the action of one field (`set-cadence` and `edit-person` both run `person.edit`),
/// because it takes every field the edit names.
fn note_call(calls: &mut BTreeMap<&'static str, &'static ActionSpec>, action: &'static ActionSpec) {
    match calls.get(action.command) {
        Some(held) if held.qualifier.is_none() || action.qualifier.is_some() => {}
        _ => {
            calls.insert(action.command, action);
        }
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

/// The fields an `edit` of `kind` takes, by the names chat says them under: what its edit actions'
/// inputs say them as (a date changes with `reschedule`, a secret with its own call), and the
/// three that are commands of their own.
fn editable(kind: Kind) -> String {
    let mut names: Vec<&str> = Vec::new();
    for action in meta::edit_actions(kind) {
        for name in action.chat_names() {
            if name != "date"
                && !meta::REVEAL_FIELDS
                    .iter()
                    .any(|(secret, _)| *secret == name)
                && !names.contains(&name)
            {
                names.push(name);
            }
        }
    }
    for special in [
        (Kind::Task, "status"),
        (Kind::Note, "pinned"),
        (Kind::List, "area"),
        (Kind::List, "icon"),
        (Kind::Calendar, "icon"),
        (Kind::Album, "cover"),
        (Kind::Photo, "place"),
        (Kind::LockerItem, "addresses"),
        (Kind::LockerItem, "note"),
        (Kind::Document, "content"),
        (Kind::Document, "body_text"),
        (Kind::ImportantDate, "reminders"),
    ] {
        if special.0 == kind && !names.contains(&special.1) {
            names.push(special.1);
        }
    }
    match kind {
        Kind::Rule => {
            return "match, text, category, display_name, min, max, account, position".to_owned();
        }
        Kind::LockerField => return "label, kind, value, position".to_owned(),
        Kind::ContactPoint => return "channel, value, label, preferred".to_owned(),
        _ => {}
    }
    names.join(", ")
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
