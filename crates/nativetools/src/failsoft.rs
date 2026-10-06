//! THE TYPED END OF AN INVALID REPEAT (D-1044-11: the model judges, the
//! harness composes).
//!
//! A call the runtime refused with an `error:` and the model sent again
//! unchanged is "no fix known": nothing else will change between two identical
//! calls, and the 33 families of first errors are too many for the model to
//! learn a recovery for each. The runtime ends the turn itself, in the outcome
//! the call's error family names, never in the generic "which did you mean?":
//!
//! - A READ (answer, find, search, compute) drops the constraint the error
//!   names and runs the corrected call as its own step, then ends the turn with
//!   that result; `note: ignored where "met < …" (met is text)` says what was
//!   left out. When nothing selective remains the answer would be the whole
//!   kind, so the turn declines `not_found` instead. A few families end in an
//!   ask (balance of nobody) or in the rows the reply already named.
//! - A WRITE never falls back silently to a row the model did not name. Rows
//!   plus a selector run on the rows; a reveal of a field that is not secret
//!   answers the row; any other refused write declines, `out_of_scope` when the
//!   verb cannot apply to the row and `not_found` otherwise.
//!
//! Every such ending carries `failsoft: {family, action}` so a run can be
//! audited, beside the `invalid_repeat` the repeat always had. A write that
//! landed this turn keeps the old ending (`loop`): an ask or a decline would
//! read as "nothing was done".

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use crate::meta::{self, Kind, ROW_CAP};
use crate::session::{Outcome, Rejected, ResultSet, Session, arg_str, handle_list};
use crate::whr;
use crate::world::Key;

/// Corrections one repeat may stack (a dropped kind that leaves a selector
/// without one is a second error to fix).
const MAX_FIXES: usize = 4;

/// Parameters a model invents for the order or the size of a readout. Leaving
/// one out changes how the rows are listed, not which: any other unknown
/// parameter may have been a filter, so a read left with nothing selective
/// declines instead.
const ORDERING: [&str; 9] = [
    "sort",
    "sort_by",
    "sortby",
    "order_by",
    "orderby",
    "direction",
    "reverse",
    "top",
    "max",
];

/// What the runtime did, for the effect.
struct Fix {
    family: &'static str,
    action: &'static str,
}

/// The next move of a read's fail-soft.
enum Next {
    /// The call, corrected in place; run it and end the turn with the result.
    Rerun { fix: Fix, note: String },
    /// The turn is over in this outcome (an ask, a decline).
    End { fix: Fix, outcome: Outcome },
}

/// The part of an `error:` that names what is wrong: no `error: ` lead, cut
/// at the first `;` or sentence end (`met is text`, `tasks have no field "x"`).
fn head(error: &str) -> String {
    let text = error.strip_prefix("error: ").unwrap_or(error).trim();
    let cut = [text.find(';'), text.find(". ")]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(text.len());
    text[..cut].trim_end_matches('.').to_owned()
}

/// Whether a read still says which rows it wants besides its kind: rows, a
/// name, a condition, a date, a link or a scope. A kind alone is the whole
/// kind, which is not what the person asked.
fn selective(tool: &str, args: &Map<String, Value>) -> bool {
    if tool == "search" {
        return true;
    }
    ["rows", "name", "where", "when", "linked_to", "within"]
        .iter()
        .any(|key| match args.get(*key) {
            None | Some(Value::Null) => false,
            Some(Value::String(text)) => !text.trim().is_empty(),
            Some(_) => true,
        })
}

impl Session {
    /// The typed ending of the call just refused and sent again, or `None`
    /// when a write landed this turn (it stays a `loop`).
    pub(crate) fn invalid_failsoft(&mut self) -> Option<Outcome> {
        if self.writes.iter().any(|(turn, _, _)| *turn == self.turn) {
            return None;
        }
        let rejected = self.last_rejected.clone()?;
        let (fix, mut outcome) = match rejected.tool.as_str() {
            "act" => self.failsoft_write(rejected),
            "answer" | "find" | "search" | "compute" => self.failsoft_read(rejected),
            "ask" => self.failsoft_ask_options(rejected),
            _ => {
                let why = head(&rejected.text);
                self.declined("other", "not_found", &why)
            }
        };
        outcome.effect.insert(
            "failsoft".to_owned(),
            json!({"family": fix.family, "action": fix.action}),
        );
        Some(outcome)
    }

    /// The turn ends in `decline <reason>`, saying why.
    fn declined(&mut self, family: &'static str, reason: &str, why: &str) -> (Fix, Outcome) {
        let action = if reason == "out_of_scope" {
            "decline:out_of_scope"
        } else {
            "decline:not_found"
        };
        let outcome =
            self.ends_in_decline(None, reason, &format!("the runtime ended the turn: {why}"));
        (Fix { family, action }, outcome)
    }

    /// The kind a read's selector starts from: `kind`, else the scope's.
    fn first_kind(&self, args: &Map<String, Value>) -> Option<Kind> {
        match arg_str(args, "kind") {
            Some(text) => text.split(',').find_map(|part| Kind::parse(part.trim())),
            None => {
                let within = arg_str(args, "within")?;
                let handle = self.resolve_result(&within).ok()?;
                self.results[handle - 1].kinds.first().copied()
            }
        }
    }

    // -----------------------------------------------------------------
    // Reads.
    // -----------------------------------------------------------------

    fn failsoft_read(&mut self, rejected: Rejected) -> (Fix, Outcome) {
        let Rejected {
            tool,
            mut args,
            text: mut error,
        } = rejected;
        let mut family: Option<&'static str> = None;
        for _ in 0..MAX_FIXES {
            let (fix, note) = match self.read_fix(&tool, &mut args, &error) {
                Next::End { fix, outcome } => {
                    return (
                        Fix {
                            family: family.unwrap_or(fix.family),
                            action: fix.action,
                        },
                        outcome,
                    );
                }
                Next::Rerun { fix, note } => (fix, note),
            };
            let family = *family.get_or_insert(fix.family);
            self.pending_notes.push(note);
            let ran = if tool == "search" {
                crate::search::search(self, &args).map(Self::search_as_answer)
            } else {
                self.answer(&args)
            };
            match ran {
                Ok(mut outcome) if outcome.ends_turn => {
                    outcome.effect.insert("tool".to_owned(), json!("answer"));
                    return (
                        Fix {
                            family,
                            action: fix.action,
                        },
                        outcome,
                    );
                }
                // A dead end, an empty search: nothing to answer with.
                Ok(outcome) => {
                    let why = head(&outcome.text);
                    return self.declined(family, "not_found", &why);
                }
                Err(next) => error = next,
            }
        }
        let why = head(&error);
        self.declined(family.unwrap_or("other"), "not_found", &why)
    }

    /// A search that found rows, as the answer it ends the turn with.
    fn search_as_answer(mut outcome: Outcome) -> Outcome {
        if outcome.effect.contains_key("recovery") {
            return outcome;
        }
        let rows = outcome.effect.remove("rows").unwrap_or_else(|| json!([]));
        let result = outcome.effect.get("result").cloned().unwrap_or(Value::Null);
        outcome.effect.insert(
            "answer".to_owned(),
            json!({"rows": rows, "ordered": false, "result": result}),
        );
        outcome.ends_turn = true;
        outcome
    }

    /// One correction of a read's `args` for `error`, or the turn's end.
    fn read_fix(&mut self, tool: &str, args: &mut Map<String, Value>, error: &str) -> Next {
        let reason = head(error);
        let rerun = |family: &'static str, action: &'static str, note: String| Next::Rerun {
            fix: Fix { family, action },
            note,
        };
        // A WHERE CLAUSE the parser refused: drop the clauses that fail.
        if let Some(text) = arg_str(args, "where")
            && let Some(kind) = self.first_kind(args)
            && whr::parse(kind, &text).err().as_deref() == Some(error)
        {
            let mut kept: Vec<String> = Vec::new();
            let mut dropped: Vec<(String, String)> = Vec::new();
            for part in whr::split_and(&text) {
                match whr::parse_cond(kind, &part) {
                    Ok(_) => kept.push(part),
                    Err(why) => dropped.push((part, head(&why))),
                }
            }
            if dropped.is_empty() {
                // a refusal of the whole `where` ("where has no \"or\"")
                kept.clear();
                dropped.push((text, reason));
            }
            let named: Vec<String> = dropped
                .iter()
                .map(|(clause, why)| format!("\"{clause}\" ({why})"))
                .collect();
            let note = format!("note: ignored where {}", named.join(", "));
            if kept.is_empty() {
                args.remove("where");
            } else {
                args.insert("where".to_owned(), json!(kept.join(" and ")));
            }
            if !selective(tool, args) {
                return self.nothing_left("where_clause", &note);
            }
            return rerun("where_clause", "drop_where_clause", note);
        }
        // A DATE EXPRESSION the evaluator could not read, or a kind without dates.
        if args.get("when").is_some_and(|value| !value.is_null())
            && (error.starts_with("error: could not read the date expression")
                || error.contains("so when cannot filter them"))
        {
            let value = arg_str(args, "when").unwrap_or_default();
            args.remove("when");
            let note = format!("note: ignored when {value} ({reason})");
            if !selective(tool, args) {
                return self.nothing_left("date_expression", &note);
            }
            return rerun("date_expression", "drop_when", note);
        }
        // A PARAMETER THE TOOL DOES NOT HAVE.
        if let Some(key) = error
            .split_once(" has no parameter \"")
            .and_then(|(_, rest)| rest.split('"').next())
            && args.remove(key).is_some()
        {
            let note = format!("note: ignored {key} ({reason})");
            if !ORDERING.contains(&key) && !selective(tool, args) {
                return self.nothing_left("unknown_param", &note);
            }
            return rerun("unknown_param", "drop_param", note);
        }
        // A KIND THAT IS NOT ONE (or `any` outside a search).
        if error.contains("no kind \"") || error.contains("kind=any is only for search") {
            let kind = arg_str(args, "kind").unwrap_or_default();
            if tool == "search" {
                args.insert("kind".to_owned(), json!("any"));
                let note = format!("note: ignored kind \"{kind}\" ({reason}); searched every kind");
                return rerun("no_kind", "kind_any", note);
            }
            args.remove("kind");
            let note = format!("note: ignored kind \"{kind}\" ({reason})");
            if !selective(tool, args) {
                return self.nothing_left("no_kind", &note);
            }
            return rerun("no_kind", "drop_kind", note);
        }
        // `value: "#3"` where a result `@n` is wanted: the row is what was meant.
        if error.contains("is not a result; results are @n")
            && let Some(value) = arg_str(args, "value").filter(|value| value.starts_with('#'))
        {
            args.clear();
            args.insert("rows".to_owned(), json!(value));
            let note = format!("note: read value {value} as rows {value}");
            return rerun("not_a_result", "answer_rows", note);
        }
        // A BALANCE OF NOBODY: ask which, among the rows still in reach.
        if let Some(rest) = error.strip_prefix("error: balance needs one ") {
            let kind = rest.split(';').next().unwrap_or_default().trim().to_owned();
            let options: Vec<Key> = self
                .usable_rows()
                .into_iter()
                .map(|number| self.by_number[number - 1].clone())
                .filter(|key| key.0.name() == kind)
                .take(ROW_CAP)
                .collect();
            if options.is_empty() {
                return self.nothing_left(
                    "balance_none",
                    &format!("no {kind} in reach for the balance"),
                );
            }
            let question = format!("balance needs one {kind}; which {kind} did you mean?");
            let outcome = self.ends_in_ask(
                None,
                &question,
                &options,
                "the runtime ended the turn: nothing in the call named the one",
            );
            return Next::End {
                fix: Fix {
                    family: "balance_none",
                    action: "ask_options",
                },
                outcome,
            };
        }
        // A BALANCE OF THE USER'S OWN ROW ("that is you"): the one other person in reach is
        // meant; with several, ask which; with none, nothing to say it of.
        if error.contains("that is you; balance is you versus someone else") {
            let me = self.world.me_key();
            let you = self.number(&me);
            let others: Vec<Key> = self
                .usable_rows()
                .into_iter()
                .map(|number| self.by_number[number - 1].clone())
                .filter(|key| key.0 == Kind::Person && *key != me)
                .collect();
            match others.as_slice() {
                [] => {
                    return self
                        .nothing_left("balance_you", "no other person in reach for the balance");
                }
                [only] => {
                    let number = self.number(only);
                    let named = crate::render::named(&self.world, number, only);
                    let op = args.get("op").cloned().unwrap_or_else(|| json!("balance"));
                    args.clear();
                    args.insert("op".to_owned(), op);
                    args.insert("rows".to_owned(), json!(format!("#{number}")));
                    let note = format!("note: balance: #{you} is you; used {named}");
                    return rerun("balance_you", "use_other_person", note);
                }
                _ => {
                    let options: Vec<Key> = others.into_iter().take(ROW_CAP).collect();
                    let outcome = self.ends_in_ask(
                        None,
                        "balance is you versus someone else; which person did you mean?",
                        &options,
                        "the runtime ended the turn: the call named you",
                    );
                    return Next::End {
                        fix: Fix {
                            family: "balance_you",
                            action: "ask_options",
                        },
                        outcome,
                    };
                }
            }
        }
        // A SELECTOR WITHOUT A KIND: the rows in reach, when they are all one kind.
        if error.contains("a selector needs kind") {
            let reach: Vec<usize> = self.usable_rows().into_iter().take(5).collect();
            let kinds: BTreeSet<Kind> = reach
                .iter()
                .map(|number| self.by_number[number - 1].0)
                .collect();
            let mut kinds = kinds.into_iter();
            if let (Some(kind), None) = (kinds.next(), kinds.next()) {
                args.insert("kind".to_owned(), json!(kind.name()));
                let note = format!(
                    "note: no kind given; the rows in reach are all {}",
                    kind.plural()
                );
                return rerun("selector_needs_kind", "set_kind", note);
            }
            return self.nothing_left("selector_needs_kind", "no kind to select from");
        }
        // ROWS AND A SELECTOR: the rows become the scope.
        if error.contains("rows or a selector, not both")
            && let Some(rows) = args.get("rows").filter(|value| !value.is_null()).cloned()
        {
            let Ok(keys) = self.resolve_rows(&rows) else {
                return self.nothing_left("rows_and_selector", &reason);
            };
            let parts = handle_list(&rows);
            let within = match parts.as_slice() {
                [only] if only.starts_with('@') => only.clone(),
                _ => {
                    let mut kinds: Vec<Kind> = Vec::new();
                    for key in &keys {
                        if !kinds.contains(&key.0) {
                            kinds.push(key.0);
                        }
                    }
                    self.results.push(ResultSet {
                        kinds,
                        keys,
                        value: None,
                    });
                    format!("@{}", self.results.len())
                }
            };
            args.remove("rows");
            args.insert("within".to_owned(), json!(within));
            let note = format!("note: rows became the scope (within={within})");
            return rerun("rows_and_selector", "rows_to_within", note);
        }
        // A LINK THE METADATA DOES NOT HAVE (the reply is a `no_link`, not an `error:`).
        if !error.starts_with("error:") && error.contains(" are not linked to ") {
            args.remove("linked_to");
            let note = format!("note: ignored linked_to ({reason})");
            if selective(tool, args) {
                return rerun("no_link", "drop_linked_to", note);
            }
            // the rows the reply named ("whose name mentions …: #3, #5")
            let named: Vec<String> = error
                .split_once("mentions")
                .map(|(_, rest)| {
                    rest.split(|c: char| !c.is_ascii_digit() && c != '#')
                        .filter(|part| part.starts_with('#') && part.len() > 1)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            if named.is_empty() {
                return self.nothing_left("no_link", &note);
            }
            args.clear();
            args.insert("rows".to_owned(), json!(named.join(", ")));
            return rerun(
                "no_link",
                "answer_named_rows",
                format!("note: answered the rows the reply named ({reason})"),
            );
        }
        // A PART OF A COMPUTE OR A READOUT that does not fit: leave it out.
        let loose: Option<&'static str> = if error.contains("count takes no field") {
            Some("field")
        } else if error.contains("balance takes no group") {
            Some("group")
        } else if error.contains("cannot order") {
            Some("order")
        } else if error.starts_with("error: limit is") {
            Some("limit")
        } else {
            None
        };
        if let Some(param) = loose
            && args.remove(param).is_some()
        {
            return rerun(
                "ignored_param",
                "drop_param",
                format!("note: ignored {param} ({reason})"),
            );
        }
        if let Some(field) = error
            .split_once(" have no field \"")
            .and_then(|(_, rest)| rest.split('"').next())
        {
            for param in ["group", "field"] {
                if arg_str(args, param).is_some_and(|value| value.eq_ignore_ascii_case(field)) {
                    args.remove(param);
                    return rerun(
                        "ignored_param",
                        "drop_param",
                        format!("note: ignored {param} ({reason})"),
                    );
                }
            }
        }
        self.nothing_left("other", &reason)
    }

    /// A read with nothing left to select by, or no fix: `decline not_found`.
    fn nothing_left(&mut self, family: &'static str, why: &str) -> Next {
        let (fix, outcome) = self.declined(family, "not_found", why);
        Next::End { fix, outcome }
    }

    // -----------------------------------------------------------------
    // Asks.
    // -----------------------------------------------------------------

    /// AN ASK WITH AN OPTION THE RUNTIME DOES NOT KNOW (`#80 was never shown`): the options
    /// that are rows stay, the others are left out, and the ask goes out. The candidates of
    /// this turn's `ambiguous:` reply complete the options as they do for any ask
    /// (`complete_options`), and stand in for them when none survives. An ask whose fault is
    /// not an option (no question) declines.
    fn failsoft_ask_options(&mut self, rejected: Rejected) -> (Fix, Outcome) {
        let Rejected { args, text, .. } = rejected;
        let question = arg_str(&args, "question").filter(|question| !question.trim().is_empty());
        let (Some(question), Some(options)) = (
            question,
            args.get("options").filter(|value| !value.is_null()),
        ) else {
            let why = head(&text);
            return self.declined("other", "not_found", &why);
        };
        let mut kept: Vec<Key> = Vec::new();
        let mut dropped: Vec<String> = Vec::new();
        for part in handle_list(options) {
            match self.resolve_rows(&Value::String(part.clone())) {
                Ok(keys) => {
                    for key in keys {
                        if !kept.contains(&key) {
                            kept.push(key);
                        }
                    }
                }
                Err(_) => dropped.push(part),
            }
        }
        if dropped.is_empty() {
            let why = head(&text);
            return self.declined("other", "not_found", &why);
        }
        let candidates = self.ambiguity_candidates();
        let (options, completed, action) = if kept.is_empty() && !candidates.is_empty() {
            (candidates, true, "ask_candidates")
        } else if !kept.is_empty()
            && kept.len() < candidates.len()
            && kept.iter().all(|key| candidates.contains(key))
        {
            (candidates, true, "complete_options")
        } else {
            (kept, false, "drop_options")
        };
        self.pending_notes.push(format!(
            "note: ignored option {} ({})",
            dropped.join(", "),
            head(&text)
        ));
        let outcome = self.ask_with(&question, &options, completed);
        (
            Fix {
                family: "ask_options",
                action,
            },
            outcome,
        )
    }

    // -----------------------------------------------------------------
    // Writes.
    // -----------------------------------------------------------------

    fn failsoft_write(&mut self, rejected: Rejected) -> (Fix, Outcome) {
        let Rejected { args, text, .. } = rejected;
        let why = head(&text);
        // ROWS AND A SELECTOR with rows named: the rows are what was meant.
        if text.contains("rows or a selector, not both")
            && args.get("rows").is_some_and(|value| !value.is_null())
        {
            let mut fixed = args.clone();
            for param in meta::SELECTOR_PARAMS {
                if *param != "kind" {
                    fixed.remove(*param);
                }
            }
            self.pending_notes
                .push("note: ignored the selector; the rows were named".to_owned());
            if let Ok(mut outcome) = self.act(&fixed) {
                let wrote =
                    outcome.effect.contains_key("diff") || outcome.effect.contains_key("already");
                // an `ambiguous:` reply is no end of the turn; the ask the runtime composed is
                let listed = outcome.effect.contains_key("ambiguous")
                    && !outcome.effect.contains_key("composed");
                if (outcome.ends_turn || wrote) && !listed {
                    outcome.ends_turn = true;
                    return (
                        Fix {
                            family: "rows_and_selector",
                            action: "drop_selector",
                        },
                        outcome,
                    );
                }
            }
            return self.declined("rows_and_selector", "not_found", &why);
        }
        // A REVEAL OF WHAT IS NOT SECRET: show the row instead.
        if text.starts_with("error: reveal takes field") {
            let mut shown = args.clone();
            for param in ["verb", "args", "more"] {
                shown.remove(param);
            }
            self.pending_notes
                .push(format!("note: answered the row instead ({why})"));
            if let Ok(mut outcome) = self.answer(&shown)
                && outcome.ends_turn
            {
                outcome.effect.insert("tool".to_owned(), json!("answer"));
                return (
                    Fix {
                        family: "reveal_field",
                        action: "answer_rows",
                    },
                    outcome,
                );
            }
            return self.declined("reveal_field", "not_found", &why);
        }
        // ANY OTHER REFUSED WRITE: no silent fallback that could write the wrong row.
        let lower = text.to_lowercase();
        if lower.contains(" does not apply to ") || lower.contains(" goes into a ") {
            return self.declined("write_does_not_apply", "out_of_scope", &why);
        }
        let family = if lower.contains("nothing was done") {
            "write_no_match"
        } else {
            "write_other"
        };
        self.declined(family, "not_found", &why)
    }
}
