//! `act` (SPEC §4.2): every write through the vault's typed commands, the
//! call-only ambiguity check (§3.3), already-so writes, and `undo`.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use crate::dates::{self, Stamp};
use crate::meta::{self, FieldType, Kind, Verb, Via};
use crate::render;
use crate::session::{Inverse, Outcome, Session, arg_bool, arg_str};
use crate::whr;
use crate::world::{Key, Row, SEALED, Val, World, minor_of};

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
            for line in trimmed.lines().flat_map(split_semis) {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let (key, value) = line.split_once(':').ok_or_else(|| {
                    format!("error: could not read the args line \"{line}\"; args are \"field: value\" lines.")
                })?;
                let value = value.trim();
                let parsed = if value.starts_with(['{', '[', '"']) || value.parse::<f64>().is_ok() {
                    serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_owned()))
                } else {
                    Value::String(value.to_owned())
                };
                map.insert(key.trim().to_lowercase(), parsed);
            }
            Ok(map)
        }
        Some(other) => Err(format!(
            "error: args are \"field: value\" lines, not {other}."
        )),
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
                    .all(|c| c.is_ascii_alphabetic() || c == '_' || c == ' ')
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

impl Session {
    pub(crate) fn act(&mut self, args: &Map<String, Value>) -> Result<Outcome, String> {
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
                let targets = match self.targets(verb, args, &extra)? {
                    Ok(targets) => targets,
                    Err(outcome) => return Ok(outcome),
                };
                self.write(verb, &targets, &extra)?
            }
        };
        outcome
            .effect
            .insert("verb".to_owned(), json!(verb.spec().name));
        // AN ALREADY-SO WRITE ENDS NOTHING (SPEC §4.2): the vault did not
        // change, and the model answers with the state the runtime reported.
        let wrote = outcome.effect.get("diff").is_some_and(|diff| {
            diff["rows"].as_array().is_some_and(|rows| !rows.is_empty())
                || diff["links"]
                    .as_array()
                    .is_some_and(|links| !links.is_empty())
        }) || verb == Verb::Reveal;
        if !wrote && outcome.effect.contains_key("already") {
            outcome.ends_turn = false;
            return Ok(outcome);
        }
        Ok(finish(outcome, more))
    }

    /// The rows an act applies to, or the observation that stops it.
    fn targets(
        &mut self,
        verb: Verb,
        args: &Map<String, Value>,
        extra: &Map<String, Value>,
    ) -> Result<Result<Vec<Key>, Outcome>, String> {
        if let Some(keys) = self.rows_arg(
            args,
            "error: act takes rows or a selector, not both; narrow with within=@n.",
        )? {
            // A BULK WRITE THE MESSAGE DID NOT ASK FOR: more rows than a
            // result shows, with no "all"/"every" in the person's words, is
            // a slip (a whole-vault find fed to a cancel), not a request. When
            // the call carries a v2 trace, its `scope` decides instead of the
            // words (`Session::bulk_allowed`).
            if keys.len() > meta::ROW_CAP && !self.bulk_allowed() {
                return Err(self.bulk_refusal(keys.len(), meta::ROW_CAP));
            }
            return Ok(Ok(keys));
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
        let keys = self.select(&selector);
        if keys.is_empty() {
            let mut outcome = Outcome::text("");
            self.empty(&selector, &mut outcome);
            outcome.text.push_str("\nnothing was done.");
            return Ok(Err(outcome));
        }
        if keys.len() > 1
            && let Some((key, why)) = self.narrow(verb, &keys, extra)
        {
            self.pending_notes.push(why);
            return Ok(Ok(vec![key]));
        }
        if keys.len() > 1 {
            // THE ONE SAFETY CHECK (SPEC §3.3), on the call alone.
            let mut lines = Vec::new();
            let mut names = Vec::new();
            for key in keys.iter().take(meta::ROW_CAP) {
                let n = self.number(key);
                let short = render::named(&self.world, n, key);
                lines.push((vec![n], short.clone()));
                names.push(short);
            }
            let more = keys.len().saturating_sub(meta::ROW_CAP);
            let what = selector
                .name
                .as_ref()
                .map_or_else(|| "the selector".to_owned(), |name| format!("\"{name}\""));
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
            return Ok(Err(outcome));
        }
        Ok(Ok(keys))
    }

    /// A name that fits several rows is settled only by what the person's
    /// words and the conversation already fix, each step used only if it
    /// leaves rows:
    ///
    /// 1. the one date the message states ("cancel the swim class on
    ///    saturday"), for verbs that act on a row where it stands (a bare
    ///    weekday only for `cancel`, which looks ahead);
    /// 2. FOCUS: the rows the previous turn and this turn have acted on,
    ///    opened, or answered in a short list (`Session::focus`: at most
    ///    `FOCUS_RESULT_MAX` rows; a longer list names a row only because it
    ///    met a condition); exactly one candidate in it is the row the person
    ///    is still talking about.
    ///
    /// The row is returned only when exactly one candidate is left; two or
    /// more stay `ambiguous:` with the full list (SPEC §3.3). What a verb
    /// would change is deliberately NOT a step: "already completed" rows are
    /// as often the row meant as not, and the authored gold asks there.
    fn narrow(
        &mut self,
        verb: Verb,
        keys: &[Key],
        extra: &Map<String, Value>,
    ) -> Option<(Key, String)> {
        let mut cands: Vec<Key> = keys.to_vec();
        let mut why: Vec<String> = Vec::new();
        let _ = extra;
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
            let focus = self.focus();
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
                return Err(format!(
                    "error: {} does not apply to {}. {} applies to: {}.",
                    verb.spec().name,
                    key.0.plural(),
                    verb.spec().name,
                    kinds.join(", ")
                ));
            }
            let row = self.row_of(key)?;
            if row.trashed && !matches!(verb, Verb::Restore | Verb::Delete) {
                let name = self.named(key);
                return Err(format!(
                    "error: {name} is in the trash; restore it first. Nothing was done."
                ));
            }
            let plan = self.plan(verb, &row, args)?;
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
        let mut already_lines = Vec::new();
        let mut inverses = Vec::new();
        let mut not_undoable = Vec::new();
        let mut notes = Vec::new();
        let mut failure = None;
        let mut touched: Vec<Key> = Vec::new();
        let mut revealed = None;
        for (key, plan) in plans {
            match plan {
                Plan::Already(state) => {
                    let name = self.named(&key);
                    already_lines.push(format!("already: {name} {state}"));
                    already.push(json!({"kind": key.0.name(), "id": key.1, "n": self.numbers.get(&key), "state": state}));
                }
                Plan::Run {
                    steps,
                    inverse,
                    not_undoable: undoable_note,
                    note,
                } => {
                    let mut outputs = Vec::new();
                    for step in steps {
                        let ran = self.handle.step(step.command, step.input)?;
                        if !ran.ok {
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
        if let Some(created) = &created {
            touched.push(created.clone());
        }
        self.world = World::load(&self.handle)?;
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
                            {"amount": crate::world::units(old, &currency), "unit": currency},
                            {"amount": crate::world::units(new, &currency), "unit": currency},
                        ],
                    }),
                ));
            }
        }
        let mut lines = Vec::new();
        for key in &touched {
            let n = self.number(key);
            self.acted.insert(n);
            if verb != Verb::Reveal {
                lines.push(self.change_line(verb, &before, key, n));
            }
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
    fn change_line(&mut self, verb: Verb, before: &World, key: &Key, n: usize) -> String {
        let after = self.world.row(key).cloned();
        let old = before.row(key).cloned();
        let today = self.today();
        match (&old, &after) {
            (None, Some(row)) => format!("created: {}", render::row_line(n, None, row, today)),
            (Some(row), None) => format!("{}: {} (gone)", verb.spec().done, render::short(n, row)),
            (Some(old), Some(new)) => {
                let mut parts = row_changes(old, new, today)
                    .into_iter()
                    .map(|(_, text)| text)
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

    fn diff_json(&mut self, diff: &Diff) -> Value {
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
                let status = row.field("status").cloned();
                let old = match &status {
                    Some(Val::Enum(value)) => *value,
                    _ => "open",
                };
                let (want, vault) = if verb == Verb::Complete {
                    ("completed", "completed")
                } else {
                    ("open", "needs-action")
                };
                if old == want {
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
        let value = args
            .get(slot)
            .ok_or_else(|| format!("error: {} needs {slot}: #n.", verb.spec().name))?;
        let containers = self.resolve_rows(value)?;
        let [container] = containers.as_slice() else {
            return Err(format!("error: {slot} is exactly one #n."));
        };
        let expected = container_of(row.kind).unwrap_or(Kind::Group);
        if container.0 != expected {
            return Err(format!(
                "error: a {} goes into a {}, and {} is a {}.",
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
        Ok(match row.kind {
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
        })
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
        let group = args
            .get("group")
            .ok_or("error: settle_up needs group: #n.")?;
        let groups = self.resolve_rows(group)?;
        let [group] = groups.as_slice() else {
            return Err("error: group is exactly one #n.".to_owned());
        };
        if group.0 != Kind::Group {
            let name = self.named(group);
            return Err(format!(
                "error: group: names a group, and {name} is not one."
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
                let number = text_of(value)
                    .trim()
                    .parse::<f64>()
                    .map_err(|_| "error: amount is a number in currency units.".to_owned())?;
                Some(minor_of(number, &currency))
            }
            None => None,
        };
        if owes == 0 && amount.is_none() {
            let name = self.named(group);
            return Ok(Plan::Already(format!(
                "is settled up in {name} (balance {})",
                crate::world::money(0, &currency)
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
                "settlement: {} paid {}",
                crate::world::money(amount, &currency),
                if owes >= 0 { "to you" } else { "by you" }
            )),
        })
    }

    fn plan_reveal(&mut self, row: &Row, args: &Map<String, Value>) -> Result<Plan, String> {
        for key in args.keys() {
            if key != "field" {
                return Err(format!("error: reveal takes field: …, not \"{key}\"."));
            }
        }
        let names: Vec<&str> = meta::REVEAL_FIELDS.iter().map(|(name, _)| *name).collect();
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
        let column = meta::REVEAL_FIELDS
            .iter()
            .find(|(name, _)| *name == lookup)
            .map(|(_, column)| *column)
            .ok_or_else(|| format!("error: reveal takes field: {}.", names.join(" · ")))?;
        let key = row.key();
        let Some(sealed) = row.extra.get(column).cloned() else {
            let name = self.named(&key);
            let has: Vec<&str> = meta::REVEAL_FIELDS
                .iter()
                .filter(|(_, column)| row.extra.contains_key(column))
                .map(|(name, _)| *name)
                .collect();
            return Err(format!(
                "error: {name} has no {field}. It holds: {}.",
                if has.is_empty() {
                    "no secrets".to_owned()
                } else {
                    has.join(", ")
                }
            ));
        };
        let key_id = row.extra.get("key_id").cloned().unwrap_or_default();
        let vault_id = self
            .handle
            .vault
            .vault_id()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let custody = centraid_vault::custody::MemberKeyCustody::on_seat(
            &crate::vaultio::seat_dir(&self.handle.path),
            vault_id,
        );
        let secret = custody
            .load(&key_id)
            .map_err(|error| error.to_string())
            .and_then(|bytes| {
                centraid_vault::custody::locker_key::decrypt_under_locker_key(
                    &bytes, &key_id, &row.id, &sealed,
                )
                .map_err(|error| error.to_string())
            })
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
        let expr = dates::parse(to).map_err(|why| dates::rejection(&why))?;
        let resolved =
            dates::evaluate(&expr, self.now, row.date).map_err(|why| dates::rejection(&why))?;
        if resolved.is_open() {
            return Err(format!(
                "error: reschedule needs a day, an instant or a closed span; {} is open-ended.",
                resolved.echo()
            ));
        }
        match row.kind {
            Kind::Task => {
                let point = resolved.point().ok_or_else(|| {
                    format!(
                        "error: a task is due at one day or instant; {} is a range.",
                        resolved.echo()
                    )
                })?;
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
                    note: None,
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
                    note: None,
                })
            }
            other => Err(format!(
                "error: reschedule does not apply to {}. reschedule applies to: task, event.",
                other.plural()
            )),
        }
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
                    "error: {} have no field \"{field}\". {} editable fields: {}.",
                    kind.plural(),
                    kind.name(),
                    editable(kind)
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
                    let on = matches!(text_of(value).to_lowercase().as_str(), "yes" | "true" | "1");
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
                let new_end = start
                    .checked_add(jiff::Span::new().minutes(minutes))
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
                let (key_id, sealed) = self.handle.seal(&row.id, &text_of(&value))?;
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
        let mut allowed: Vec<&str> = vec!["name"];
        allowed.extend(
            spec.fields
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
            _ => {}
        }
        for key in args.keys() {
            if !allowed.contains(&key.as_str()) {
                return Err(format!(
                    "error: create {} args take {}; not \"{key}\".",
                    kind.name(),
                    allowed.join(", ")
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
                let expr = dates::parse(value).map_err(|why| dates::rejection(&why))?;
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
        let mint = || centraid_vault::Ids::next(self.handle.vault.ids());
        let (command, input, id_out): (&'static str, Value, &'static str) = match kind {
            Kind::Person => {
                let mut input =
                    json!({"display_name": name, "cadence_days": number("cadence")?.unwrap_or(0)});
                for field in ["role", "nickname"] {
                    if let Some(value) = text(field) {
                        input[field] = json!(value);
                    }
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
                        (
                            at,
                            at.checked_add(jiff::Span::new().minutes(minutes))
                                .unwrap_or(at),
                        )
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
                ("schedule.propose_event", input, "event_id")
            }
            Kind::Task => {
                let mut input = json!({"task_id": mint(), "title": name});
                if let Some(resolved) = date {
                    let point = resolved.point().ok_or_else(|| {
                        format!(
                            "error: a task is due at one day or instant; {} is a range.",
                            resolved.echo()
                        )
                    })?;
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
                let amount = args
                    .get("amount")
                    .map(text_of)
                    .and_then(|value| {
                        value
                            .trim()
                            .trim_start_matches(['$', '€', '£'])
                            .parse::<f64>()
                            .ok()
                    })
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
                        let (key_id, sealed) = self.handle.seal(&item_id, &value)?;
                        input["content"] = json!(sealed);
                        input["key_id"] = json!(key_id);
                    } else {
                        input[column] = json!(value);
                    }
                }
                ("locker.add_item", input, "item_id")
            }
            Kind::Photo => unreachable!("photos are not created by a call"),
        };
        let before = self.world.clone();
        let ran = self.handle.step(command, input)?;
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
        // Follow-ups that the create command itself does not take.
        let mut follow = Vec::new();
        if let Some(list) = list {
            follow.push((
                "schedule.organize_task",
                json!({"task_id": id, "project_id": list.1, "sort_order": 0}),
            ));
        }
        for (command, input) in follow {
            self.handle.clock.tick();
            if let Err(error) = self.handle.must(command, input) {
                // Take the half-made row back out, so no later diff finds it.
                if let Some(delete) = Verb::Delete.command(kind) {
                    self.handle.clock.tick();
                    let _ = self.handle.step(delete, json!({ id_param(kind): id }));
                }
                self.world = World::load(&self.handle)?;
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

    fn undo(&mut self) -> Result<Outcome, String> {
        let previous = self.turn.saturating_sub(1);
        let entry = self
            .writes
            .iter()
            .position(|(turn, _, _)| *turn == previous && previous > 0)
            .filter(|_| !self.undone.contains(&previous));
        let Some(index) = entry else {
            return Err("error: nothing to undo".to_owned());
        };
        let (_, inverses, notes) = self.writes[index].clone();
        self.undone.insert(previous);
        let before = self.world.clone();
        let mut lines = Vec::new();
        let mut touched: Vec<Key> = Vec::new();
        for inverse in inverses.iter().rev() {
            let ran = self.handle.step(&inverse.command, inverse.input.clone())?;
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
        self.world = World::load(&self.handle)?;
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
                            {"amount": crate::world::units(old, &currency), "unit": currency},
                            {"amount": crate::world::units(new, &currency), "unit": currency},
                        ],
                    }),
                ));
            }
        }
        let mut out = Vec::new();
        for key in &touched {
            let n = self.number(key);
            self.acted.insert(n);
            out.push(self.change_line(Verb::Undo, &before, key, n));
        }
        out.extend(lines);
        out.extend(notes.iter().map(|note| format!("not undone: {note}")));
        if out.is_empty() {
            out.push("undone: nothing changed".to_owned());
        }
        let mut outcome = Outcome::text(out.join("\n"));
        let diff_json = self.diff_json(&diff);
        outcome.effect.insert("diff".to_owned(), diff_json);
        Ok(outcome)
    }
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
fn event_span(row: &Row) -> (jiff::civil::DateTime, jiff::civil::DateTime) {
    let start = row.date.map(Stamp::at).unwrap_or_default();
    let end = match (row.date.and_then(|stamp| stamp.time), row.field("duration")) {
        (_, Some(Val::Num(minutes))) => start
            .checked_add(jiff::Span::new().minutes(*minutes))
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

fn snapshot(row: &Row) -> BTreeMap<String, Value> {
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
fn row_changes(old: &Row, new: &Row, today: jiff::civil::Date) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if old.name != new.name {
        out.push((
            "name".to_owned(),
            format!("name \"{}\" → \"{}\"", old.name, new.name),
        ));
    }
    if old.date != new.date {
        let show = |stamp: Option<Stamp>| {
            stamp.map_or_else(|| "none".to_owned(), |stamp| render::when(stamp, today))
        };
        out.push((
            "date".to_owned(),
            format!("{} → {}", show(old.date), show(new.date)),
        ));
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
        out.push((
            field.name.to_owned(),
            format!("{} {} → {}", field.name, show(a), show(b)),
        ));
    }
    let (was, now) = (sealed_cells(old), sealed_cells(new));
    for (name, sealed) in &now {
        if was.get(name) != Some(sealed) {
            out.retain(|(field, _)| field != name);
            out.push((
                (*name).to_owned(),
                format!("{name} changed (sealed; reveal to show)"),
            ));
        }
    }
    if old.trashed != new.trashed {
        out.push((
            "trashed".to_owned(),
            if new.trashed {
                "moved to the trash"
            } else {
                "back from the trash"
            }
            .to_owned(),
        ));
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
