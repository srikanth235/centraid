//! # Composable vault tools — a multi-step candidate's action space
//!
//! A turn is a LOOP, not one line: the model makes a call, reads what came
//! back, and makes the next, the way a coding agent runs `grep` and then
//! opens the file it found. Every call is one line:
//!
//! ```text
//! search "cabin"                      rows of every kind whose name matches
//! show <set>                          the canonical set language, one level deep by habit
//! count of <set> | sum F of <set> …   a number
//! get #3                              one row, every fact the reader gave it
//! verb{…} on #3                       a write — the turn ends on it
//! answer <set> | answer <value>       the turn's answer — the turn ends on it
//! ask "<question>"                    hand the turn back to the person with a
//!                                     question — when the vault cannot decide it
//! done                                stop without answering (after `ambiguous: …`,
//!                                     the runtime asks the person)
//! refuse | nothing                    as in the canonical language
//! ```
//!
//! **The answer is named, never implied.** A read turn ends on `answer X`,
//! which runs X and commits exactly its rows or number; a `show` only looks.
//! `done` commits nothing of its own: it closes the turn with what the runtime
//! is holding open — a question back after `ambiguous: …`, `nothing` after a
//! write found only trashed rows — and otherwise with no answer at all.
//!
//! **`ask` is the model's own question.** It ends the turn as a clarify, with
//! the words the person will read, and nothing in the vault changes. A judged
//! stop rather than a lazy one: a bare `done` with nothing pending stays an
//! empty turn, so a question has to be written to count as one.
//!
//! **Rows come back numbered** (`#1`, `#2`, …) and a later call names them by
//! number, so a title is spelled at most once — in `search` — and every other
//! step copies a number it has seen. The numbering is per SESSION, so turn 4
//! can still say `#3`: a pronoun is a row still in view, not a rule.
//!
//! **Every date a call resolved is echoed back** as a weekday and an absolute
//! day, so a later step copies it instead of computing it.
//!
//! **A window phrase is the runtime's.** `during next couple of months`,
//! `during may`, `during that day`, `during while at the cabin` resolve to the
//! days ranked search would read from the same words, and the result says what
//! each phrase became.
//!
//! **A name the person did not pin is a question.** A write, or an answer
//! about one row, aimed at a person or container whose name as the person put
//! it fits several live rows comes back `ambiguous: …` with the candidates,
//! even when the call named its row by `#n`.
//!
//! The executor underneath is [`crate::exec`], unchanged: `#n` is one more
//! [`Ref`](crate::canon::Ref) and everything else is the canonical language.

use std::collections::{BTreeMap, BTreeSet};

use centraid_evalsuite::{Context, Plan, VaultRow};

use crate::canon::{self, Turn};
use crate::exec::{State, Stop, execute, execute_or_stop};
use crate::rank::{self, Ranker};

/// Rows shown per result; the rest are counted, and still numbered.
const SHOWN: usize = 12;

/// One session's tool state: the executor's memory plus the row numbering.
#[derive(Default)]
pub struct ToolSession {
    pub state: State,
    next: u32,
    /// What the runtime holds open for `done`: the question back after an
    /// ambiguity, `nothing` after a write found only trashed rows. It lasts
    /// the whole turn — looking around afterwards does not settle it; only
    /// an `answer` or a write ends the turn another way.
    pending: Option<Plan>,
    /// `search` goes through the [`Ranker`] instead of `things called`.
    ranked: bool,
    /// The ranked index over `show (things)`, built on the first ranked
    /// search and dropped after every write.
    ranker: Option<Ranker>,
    /// The binned rows, read with the ranked index (and dropped with it):
    /// the ones a search names are shown, marked trashed.
    trashed: Vec<VaultRow>,
    /// The session's requests, oldest first (ranked mode reads them).
    requests: Vec<String>,
    /// The first row number this turn handed out: a lower `#n` was shown in
    /// an earlier turn, so it is something the conversation already holds.
    turn_first: u32,
}

/// What one call did.
pub struct Step {
    /// The text the model reads next.
    pub obs: String,
    /// `Some` when the call ended the turn, with the turn's answer.
    pub end: Option<Plan>,
}

impl ToolSession {
    /// A new turn: nothing is answered yet.
    pub fn begin_turn(&mut self) {
        self.pending = None;
        self.turn_first = self.next + 1;
    }

    /// Turn ranked search on (`--search ranked`) or off (the default).
    pub fn set_ranked(&mut self, ranked: bool) {
        self.ranked = ranked;
    }

    /// The person's words for the turn about to run; ranked `search` reads
    /// every request so far as context.
    pub fn note_request(&mut self, request: &str) {
        self.requests.push(request.to_owned());
    }

    /// The turn closes without an `answer` (`done`, or the loop's budget):
    /// what the runtime holds open, else no answer.
    pub fn finish(&mut self) -> Plan {
        self.pending.take().unwrap_or(Plan::Declined {
            reason: "none".to_owned(),
        })
    }

    /// Run one call.
    pub fn call(&mut self, line: &str, ctx: &mut Context<'_>) -> Step {
        let line = line.trim();
        if line == "done" {
            return Step {
                obs: String::new(),
                end: Some(self.finish()),
            };
        }
        if let Some(rest) = line.strip_prefix("get ") {
            return self.get(rest.trim(), ctx);
        }
        if line == "answer" || line.starts_with("answer ") {
            return self.answer(line["answer".len()..].trim(), ctx);
        }
        if line == "ask" || line.starts_with("ask ") {
            let question = line["ask".len()..].trim().trim_matches('"').trim();
            if question.is_empty() {
                return self.error("ask takes the question to put to the person");
            }
            self.pending = None;
            return Step {
                obs: format!("asked: {question}"),
                end: Some(Plan::Declined {
                    reason: "clarify".to_owned(),
                }),
            };
        }
        if self.ranked
            && let Some(text) = line.strip_prefix("search ")
        {
            return self.ranked_search(text.trim().trim_matches('"').trim(), ctx);
        }
        let canonical = match line.strip_prefix("search ") {
            Some(text) => format!("show (things called {})", text.trim()),
            None => line.to_owned(),
        };
        let (tree, said) = match canon::parse_for_execution(&canonical, ctx.today()) {
            Ok(tree) => (tree, None),
            Err(complaint) => match self.phrase_windows(&canonical, ctx) {
                Some((line, said)) => match canon::parse_for_execution(&line, ctx.today()) {
                    Ok(tree) => (tree, Some(said)),
                    Err(_) => return self.error(&format!("does not parse: {complaint}")),
                },
                None => return self.error(&format!("does not parse: {complaint}")),
            },
        };
        let step = self.run(tree, false, ctx);
        echo_windows(step, said)
    }

    /// **A WINDOW PHRASE IS THE RUNTIME'S TO RESOLVE.** `during next couple of
    /// months`, `during may`, `during that day`, `during while at the cabin`:
    /// words the canonical windows do not spell, resolved here to the days
    /// they cover — by the same [`Ranker::resolve_window`] ranked search
    /// reads a request's dates with, so a search and a set expression agree.
    /// Returns the line with each such phrase replaced by its day range, and
    /// what each phrase was read as; `None` when no phrase needed it.
    fn phrase_windows(&mut self, line: &str, ctx: &mut Context<'_>) -> Option<(String, String)> {
        let mut out = String::new();
        let mut said = Vec::new();
        let mut rest = line;
        let mut changed = false;
        while let Some(at) = find_during(rest) {
            let (head, tail) = rest.split_at(at + "during ".len());
            out.push_str(head);
            let end = phrase_end(tail);
            let phrase = tail[..end].trim();
            let words = phrase.trim_matches('"').trim();
            let canonical = phrase.starts_with('(')
                || canon::parse_for_execution(
                    &format!("show (things during {phrase})"),
                    ctx.today(),
                )
                .is_ok();
            if canonical || words.is_empty() {
                out.push_str(&tail[..end]);
            } else {
                self.ensure_ranker(ctx);
                let last = self.last_answers();
                let (from, to) = self.ranker.as_ref()?.resolve_window(words, &last)?;
                let range = if from == to {
                    from.clone()
                } else {
                    format!("{from}..{to}")
                };
                let segment = &tail[..end];
                out.push_str(&range);
                out.push_str(&segment[segment.trim_end().len()..]);
                said.push(format!(
                    "\"{words}\" = {}",
                    if from == to {
                        date_text(&from)
                    } else {
                        format!("{}..{}", date_text(&from), date_text(&to))
                    }
                ));
                changed = true;
            }
            rest = &tail[end..];
        }
        out.push_str(rest);
        changed.then(|| (out, format!("({})", said.join("; "))))
    }

    /// Ranked `search`: the top hits, numbered, each followed by its inline
    /// links grouped by kind and numbered too. The hits become `them`.
    /// The ranked index over `show (things)`, built on first use and dropped
    /// after every write. Search reads it, and so do window phrases and the
    /// namesake check: one reading of the vault for all three.
    fn ensure_ranker(&mut self, ctx: &mut Context<'_>) {
        if self.ranker.is_none() {
            // A scratch state: nothing is numbered and `them` does not move.
            let mut scratch = State::default();
            if let Ok(tree) = canon::parse_for_execution("show (things)", ctx.today()) {
                let _ = execute(&tree, &mut scratch, ctx);
            }
            let rows = scratch.answers.last().cloned().unwrap_or_default();
            self.ranker = Some(Ranker::new(&rows, ctx.today()));
            let mut scratch = State::default();
            self.trashed = canon::parse_for_execution(
                "show (things) that (deleted_at is not null)",
                ctx.today(),
            )
            .ok()
            .and_then(|tree| {
                let _ = execute(&tree, &mut scratch, ctx);
                scratch.answers.last().cloned()
            })
            .unwrap_or_default();
        }
    }

    /// The session's answers, newest first, as row ids.
    fn last_answers(&self) -> Vec<Vec<String>> {
        self.state
            .answers
            .iter()
            .rev()
            .map(|rows| rows.iter().map(|row| row.id.clone()).collect())
            .collect()
    }

    fn ranked_search(&mut self, query: &str, ctx: &mut Context<'_>) -> Step {
        self.ensure_ranker(ctx);
        let last = self.last_answers();
        let hits = self
            .ranker
            .as_ref()
            .map(|ranker| {
                // the turn's request: a day it names ranks what the query finds
                let asked = self.requests.last().map(String::as_str);
                ranker.search_for(query, asked, &self.requests, &last)
            })
            .unwrap_or_default();
        if hits.is_empty() {
            return Step {
                obs: "no rows".to_owned(),
                end: None,
            };
        }
        let mut lines = Vec::new();
        for hit in &hits {
            let n = self.handle(&hit.row);
            lines.push(row_line(
                n,
                &hit.row,
                &read_facts(&hit.row, ctx),
                ctx.today(),
            ));
            let mut groups: Vec<(String, Vec<String>)> = Vec::new();
            for link in &hit.links {
                let n = self.handle(link);
                let item = format!("#{n} \"{}\"", link.label);
                let word = kinds_of(link);
                match groups.iter_mut().find(|(w, _)| *w == word) {
                    Some((_, items)) => items.push(item),
                    None => groups.push((word, vec![item])),
                }
            }
            // **A CUT LIST SAYS IT WAS CUT.** Links past the per-kind cap are
            // counted, so "the group's expenses" walks the link (`expenses of
            // (#1)`) instead of copying the eight handles on screen.
            let mut cut: Vec<(String, usize)> = Vec::new();
            for link in &hit.more {
                let word = kinds_of(link);
                match cut.iter_mut().find(|(w, _)| *w == word) {
                    Some((_, count)) => *count += 1,
                    None => cut.push((word, 1)),
                }
            }
            for (word, mut items) in groups {
                if let Some((_, count)) = cut.iter().find(|(w, _)| *w == word) {
                    items.push(format!("… {count} more"));
                }
                lines.push(format!("   {word}: {}", items.join(", ")));
            }
        }
        // Trashed rows the request names, after the live hits: a write aimed
        // at one ends `nothing` instead of landing on the nearest live row.
        let trashed: Vec<VaultRow> = self
            .ranker
            .as_ref()
            .map(|ranker| {
                ranker
                    .trashed_matches(query, &self.trashed)
                    .into_iter()
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        for row in &trashed {
            let n = self.handle(row);
            lines.push(row_line(n, row, &read_facts(row, ctx), ctx.today()));
        }
        self.state
            .answers
            .push(hits.iter().map(|hit| hit.row.clone()).collect());
        Step {
            obs: lines.join("\n"),
            end: None,
        }
    }

    /// The row's number: the one it was shown under, else the next one.
    fn handle(&mut self, row: &VaultRow) -> u32 {
        let known = self
            .state
            .handles
            .iter()
            .find(|(_, held)| held.id == row.id && held.entity == row.entity)
            .map(|(n, _)| *n);
        let n = known.unwrap_or_else(|| {
            self.next += 1;
            self.next
        });
        self.state.handles.insert(n, row.clone());
        n
    }

    /// `answer X`: X is a set (`answer #2, #5`, `answer (tasks during friday)`)
    /// or a value (`answer count of (them)`); anything else is an error.
    fn answer(&mut self, expr: &str, ctx: &mut Context<'_>) -> Step {
        let parse = |expr: &str, today: &str| match canon::parse_for_execution(
            &format!("show {expr}"),
            today,
        ) {
            Ok(tree) => Ok(tree),
            Err(as_set) => match canon::parse_for_execution(expr, today) {
                Ok(tree @ Turn::Value(_)) => Ok(tree),
                _ => Err(as_set),
            },
        };
        let (tree, said) = match parse(expr, ctx.today()) {
            Ok(tree) => (tree, None),
            Err(as_set) => {
                let resolved = self
                    .phrase_windows(expr, ctx)
                    .and_then(|(line, said)| parse(&line, ctx.today()).ok().map(|t| (t, said)));
                match resolved {
                    Some((tree, said)) => (tree, Some(said)),
                    None => {
                        return self.error(&format!(
                            "does not parse: answer takes a set or a value: {as_set}"
                        ));
                    }
                }
            }
        };
        let step = self.run(tree, true, ctx);
        echo_windows(step, said)
    }

    /// Execute one parsed call. A read ends the turn only when `answering`.
    fn run(&mut self, mut tree: Turn, answering: bool, ctx: &mut Context<'_>) -> Step {
        complete_is_a_status(&mut tree);
        let writing = matches!(tree, Turn::Cmd(_) | Turn::Seq(_));
        if (writing || answering)
            && let Some(why) = self.namesakes(&tree, writing, ctx)
        {
            self.pending = Some(Stop::Clarify(None).plan());
            return Step {
                obs: why,
                end: None,
            };
        }
        let wrote_before = ctx.cost().writes();
        let plan = match execute_or_stop(&tree, &mut self.state, ctx) {
            Ok(plan) => plan,
            Err(Stop::Unhandled(why)) => return self.error(&why),
            // **AN AMBIGUITY IS A RESULT, NOT THE END OF THE TURN.** The
            // runtime could not tell which row a name meant; the model reads
            // that and either names the row by `#n` or says `done`, which
            // hands the question to the person. A call that already wrote
            // cannot be retried without writing twice, so it still ends here.
            Err(stop @ Stop::Clarify(_)) if ctx.cost().writes() == wrote_before => {
                let Stop::Clarify(why) = &stop else {
                    unreachable!()
                };
                let obs = match why {
                    Some(why) if why.starts_with("ambiguous") => why.clone(),
                    Some(why) => format!(
                        "ambiguous: {}; the vault cannot say, so find the rows another way, \
                         or say done to ask",
                        entity_words(why)
                    ),
                    None => "ambiguous: that could mean more than one row; name the one \
                             meant by #n, or say done to ask"
                        .to_owned(),
                };
                self.pending = Some(stop.plan());
                return Step { obs, end: None };
            }
            // A write whose only target is in the trash: nothing was done,
            // and the turn stays open — the trashed rows come back numbered,
            // so a restore can name one, and `nothing` is the other answer.
            Err(Stop::Trashed(rows)) if ctx.cost().writes() == wrote_before => {
                let obs = format!("no live rows; in the trash:\n{}", self.number(&rows, ctx));
                self.pending = Some(Stop::Nothing.plan());
                return Step { obs, end: None };
            }
            Err(stop) => stop.plan(),
        };
        match (&tree, plan) {
            (Turn::Show(_) | Turn::Same(..), Plan::Ids(ids)) => {
                let rows = self.state.answers.last().cloned().unwrap_or_default();
                // `Same` answers the SHARED ids, not the rows it remembered.
                let rows = if rows.len() == ids.len() {
                    rows
                } else {
                    rows.into_iter()
                        .filter(|row| ids.contains(&row.id))
                        .collect()
                };
                let obs = self.number(&rows, ctx);
                let mut seen = std::collections::BTreeSet::new();
                let ids = ids
                    .into_iter()
                    .filter(|id| seen.insert(id.clone()))
                    .collect();
                Step {
                    obs,
                    end: answering.then_some(Plan::Ids(ids)),
                }
            }
            (Turn::Value(_), Plan::Value(value)) => Step {
                obs: format!("= {}", number_text(value)),
                end: answering.then_some(Plan::Value(value)),
            },
            // The rows a write touched come back numbered, so a later "no,
            // put her back" can point at the row the write went by name to.
            (Turn::Cmd(_) | Turn::Seq(_), Plan::Wrote) => {
                self.ranker = None;
                let touched = self
                    .state
                    .last_write
                    .as_ref()
                    .map(|write| write.rows.clone())
                    .unwrap_or_default();
                let mut obs = format!("ok: {}", tree.to_canonical());
                if !touched.is_empty() {
                    obs.push('\n');
                    obs.push_str(&self.number(&touched, ctx));
                }
                Step {
                    obs,
                    end: Some(Plan::Wrote),
                }
            }
            (_, plan @ Plan::Declined { .. }) => Step {
                obs: match &plan {
                    // A restore the vault refused is past its grace window:
                    // say so, rather than a bare `refuse` the model reads as
                    // a policy line.
                    Plan::Declined { reason } if reason == "refuse" && restores(&tree) => {
                        "refuse: that row's trash grace window has run out; \
                         it can no longer be restored"
                            .to_owned()
                    }
                    Plan::Declined { reason } => reason.clone(),
                    _ => String::new(),
                },
                end: Some(plan),
            },
            (_, plan) => Step {
                obs: String::new(),
                end: Some(plan),
            },
        }
    }

    /// **A NAME THE PERSON DID NOT PIN IS A QUESTION, WHATEVER `#n` SAYS.**
    ///
    /// A write, or an answer about one row, aimed at a named row (a person, a
    /// group, an album — a row with no date to tell it apart) whose name, as
    /// the person put it, fits several live rows of that kind: "add Marco"
    /// with three Marcos, "the group" with six groups, "settle up with her"
    /// where the her was a Neha and there are three. The model's `#n` picked
    /// one; the person did not, so the runtime says `ambiguous: …` with the
    /// candidates and holds a question open, exactly as an ambiguous name
    /// does. Once the person's own words fit one row ("Marco Ferreira", the
    /// group's name, a date only one of them falls on) nothing fires.
    fn namesakes(&mut self, tree: &Turn, writing: bool, ctx: &mut Context<'_>) -> Option<String> {
        let mut handles = Vec::new();
        let plural = collect_handles(tree, &mut handles);
        if plural && !writing {
            return None; // an answer naming several shown rows is a list
        }
        let request = self.requests.last()?.to_lowercase();
        // "the OTHER Neha": the person picked relative to what was shown.
        if regex::Regex::new(r"\b(other|another|different)\b")
            .ok()?
            .is_match(&request)
        {
            return None;
        }
        // What earlier turns put on screen, by id: a name or a "the group"
        // with an antecedent there means that row.
        let held: BTreeMap<String, u32> = self
            .state
            .handles
            .iter()
            .filter(|(n, _)| **n < self.turn_first)
            .map(|(n, row)| (row.id.clone(), *n))
            .collect();
        // The other rows this call names: an ANSWER relating two named rows
        // ("what Marco owes me for the trip") is about the Marco of the trip.
        let others: Vec<String> = handles
            .iter()
            .filter_map(|n| self.state.handles.get(n).map(|row| row.id.clone()))
            .collect();
        let heard: BTreeSet<String> = rank::tokens(&request, false).into_iter().collect();
        self.ensure_ranker(ctx);
        let ranker = self.ranker.as_ref()?;
        let words =
            |label: &str| -> BTreeSet<String> { rank::tokens(label, false).into_iter().collect() };
        // Every live row of `entity` whose name holds all of `said`, one per id.
        // Narrowed by what the person already gave: a date the request names,
        // a row an earlier turn showed, and — for a read — a row the call
        // relates it to. (A write cannot pick its row by the link it would
        // make: "add Marco to the group" is not about the Marco already in it.)
        let fitting = |entity: &str, said: &BTreeSet<String>| -> Vec<&VaultRow> {
            let mut seen = BTreeSet::new();
            let mut rows: Vec<&VaultRow> = ranker
                .pool()
                .iter()
                .filter(|row| row.entity == entity && row.live)
                .filter(|row| said.is_empty() || said.is_subset(&words(&row.label)))
                .filter(|row| ranker.within(&request, row) != Some(false))
                .filter(|row| seen.insert(row.id.clone()))
                .collect();
            let shown: Vec<&VaultRow> = rows
                .iter()
                .copied()
                .filter(|row| held.contains_key(&row.id))
                .collect();
            if !shown.is_empty() {
                rows = shown;
            }
            if !writing {
                let related: Vec<&VaultRow> = rows
                    .iter()
                    .copied()
                    .filter(|row| {
                        ranker
                            .linked(&row.id)
                            .iter()
                            .any(|linked| others.contains(&linked.id))
                    })
                    .collect();
                if !related.is_empty() {
                    rows = related;
                }
            }
            rows
        };
        let say = |rows: &[&VaultRow], name: &str| -> String {
            let list: Vec<String> = rows
                .iter()
                .take(SHOWN)
                .map(|row| format!("{} \"{}\"", kind_of(row), row.label))
                .collect();
            format!(
                "ambiguous: {} rows fit \"{name}\": {}; the person has not said which, \
                 so say done to ask",
                rows.len(),
                list.join(", ")
            )
        };
        let pronoun = regex::Regex::new(r"\b(her|him|his|she|he)\b").ok()?;
        let identity = regex::Regex::new(r"\b(which|who(?:'s| is)) [a-z]").ok()?;
        for n in &handles {
            let row = self.state.handles.get(n)?.clone();
            if row.date.is_some() || !row.live {
                continue;
            }
            let by_name = Ranker::goes_by_name(&row.entity);
            let said: BTreeSet<String> = words(&row.label).intersection(&heard).cloned().collect();
            if by_name && !said.is_empty() {
                let rows = fitting(&row.entity, &said);
                if rows.len() > 1 {
                    let name: Vec<&str> = said.iter().map(String::as_str).collect();
                    return Some(say(&rows, &name.join(" ")));
                }
                continue;
            }
            // "the group": the kind named with the definite article and no
            // name at all — every live row of that kind is a candidate.
            let kinds = canon::kinds();
            let named_kind = kinds
                .iter()
                .filter(|(_, (entity, _))| *entity == row.entity)
                .map(|(kind, _)| kind.strip_suffix('s').unwrap_or(kind))
                .find(|kind| {
                    regex::Regex::new(&format!(r"\bthe (?:\w+ )?{kind}\b"))
                        .is_ok_and(|re| re.is_match(&request))
                });
            if let Some(kind) = named_kind.filter(|_| by_name && said.is_empty()) {
                let rows = fitting(&row.entity, &BTreeSet::new());
                if rows.len() > 1 {
                    return Some(say(&rows, &format!("the {kind}")));
                }
                continue;
            }
            // "settle up with HER": the person meant by the pronoun is the one
            // an earlier request named — by as much of the name as it gave.
            if writing && pronoun.is_match(&request) {
                let people: Vec<VaultRow> = if row.entity == "core.party" {
                    vec![row.clone()]
                } else {
                    ranker
                        .linked(&row.id)
                        .into_iter()
                        .filter(|linked| linked.entity == "core.party")
                        .cloned()
                        .collect()
                };
                for person in &people {
                    let earlier = self.requests.iter().rev().skip(1).find_map(|asked| {
                        let asked: BTreeSet<String> =
                            rank::tokens(asked, false).into_iter().collect();
                        let said: BTreeSet<String> =
                            words(&person.label).intersection(&asked).cloned().collect();
                        (!said.is_empty()).then_some(said)
                    });
                    if let Some(said) = earlier {
                        let rows = fitting("core.party", &said);
                        if rows.len() > 1 {
                            let name: Vec<&str> = said.iter().map(String::as_str).collect();
                            return Some(say(&rows, &name.join(" ")));
                        }
                    }
                }
            }
        }
        // "which Neha is that?": a question about WHO a name is, answered
        // while the name still fits several people.
        if !writing && !handles.is_empty() && identity.is_match(&request) {
            let people: BTreeSet<String> = ranker
                .pool()
                .iter()
                .filter(|row| row.entity == "core.party" && row.live)
                .flat_map(|row| words(&row.label))
                .collect();
            let said: BTreeSet<String> = heard.intersection(&people).cloned().collect();
            if !said.is_empty() {
                let rows = fitting("core.party", &said);
                if rows.len() > 1 {
                    let name: Vec<&str> = said.iter().map(String::as_str).collect();
                    return Some(say(&rows, &name.join(" ")));
                }
            }
        }
        None
    }

    fn error(&self, why: &str) -> Step {
        Step {
            obs: format!("error: {why}"),
            end: None,
        }
    }

    fn get(&self, handle: &str, ctx: &Context<'_>) -> Step {
        let row = handle
            .strip_prefix('#')
            .and_then(|n| n.parse::<u32>().ok())
            .and_then(|n| self.state.handles.get(&n).map(|row| (n, row)));
        let Some((n, row)) = row else {
            return self.error(&format!("no row was shown as {handle}"));
        };
        let mut out = row_line(n, row, &read_facts(row, ctx), ctx.today());
        for (key, value) in &row.extra {
            if !value.is_empty() && !looks_like_id(value) {
                out.push_str(&format!("\n  {key}: {}", clip(value, 80)));
            }
        }
        Step {
            obs: out,
            end: None,
        }
    }

    /// Number `rows`, remember each under its number, and render them.
    fn number(&mut self, rows: &[VaultRow], ctx: &Context<'_>) -> String {
        if rows.is_empty() {
            return "no rows".to_owned();
        }
        // One row, one line: a party that is also a group member comes back
        // from two readers under one id, and two lines saying `#1` would make
        // the number ambiguous.
        // Where one result holds the same row from two readers, the People
        // reading stands for it (a contact is more than a group member).
        let people: BTreeMap<(&str, &str), &VaultRow> = rows
            .iter()
            .filter(|row| row.app == "people")
            .map(|row| ((row.entity.as_str(), row.id.as_str()), row))
            .collect();
        let mut seen = std::collections::BTreeSet::new();
        let rows: Vec<&VaultRow> = rows
            .iter()
            .filter(|row| seen.insert((row.entity.clone(), row.id.clone())))
            .map(|row| {
                people
                    .get(&(row.entity.as_str(), row.id.as_str()))
                    .copied()
                    .unwrap_or(row)
            })
            .collect();
        let mut lines = Vec::new();
        for (at, row) in rows.iter().copied().enumerate() {
            // A row already numbered keeps its number: `#3` never changes
            // meaning inside a session. The number keeps its row, but the row
            // is the LATEST reading of it: a person first shown as a group
            // member and later as a contact walks as a contact.
            let n = self.handle(row);
            if at < SHOWN {
                lines.push(row_line(n, row, &read_facts(row, ctx), ctx.today()));
            }
        }
        if rows.len() > SHOWN {
            lines.push(format!("… {} rows in all", rows.len()));
        }
        lines.join("\n")
    }
}

/// `complete{} on #3` → `schedule.set_task_status{status: "completed"}`.
///
/// The verb class `complete` resolves to `people.complete_task`, which the
/// executor has no body for, so every task completion through the class
/// failed; the task app's own status command is what a completion is.
fn complete_is_a_status(tree: &mut Turn) {
    let fix = |cmd: &mut canon::Cmd| {
        if cmd.verb == "complete" {
            cmd.verb = "schedule.set_task_status".to_owned();
            cmd.is_class = false;
            if !cmd.args.iter().any(|(key, _)| key == "status") {
                cmd.args.push((
                    "status".to_owned(),
                    canon::ArgVal::Lit(canon::Lit {
                        ty: "string".to_owned(),
                        value: "completed".to_owned(),
                    }),
                ));
            }
        }
    };
    match tree {
        Turn::Cmd(cmd) => fix(cmd),
        Turn::Seq(cmds) => cmds.iter_mut().for_each(fix),
        _ => {}
    }
}

/// The step's result, headed by what each window phrase was read as.
fn echo_windows(mut step: Step, said: Option<String>) -> Step {
    if let Some(said) = said {
        step.obs = format!("{said}\n{}", step.obs);
    }
    step
}

/// Where the next `during ` keyword starts, outside a quoted literal.
fn find_during(text: &str) -> Option<usize> {
    let mut quoted = false;
    let bytes = text.as_bytes();
    for (at, ch) in text.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        } else if !quoted
            && text[at..].starts_with("during ")
            && (at == 0 || !bytes[at - 1].is_ascii_alphanumeric())
        {
            return Some(at);
        }
    }
    None
}

/// How far a window phrase after `during ` runs: to the `)` that closes the
/// set it sits in, or the next set-language keyword, or the end.
fn phrase_end(tail: &str) -> usize {
    let mut depth = 0i32;
    let mut quoted = false;
    for (at, ch) in tail.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => {
                if depth == 0 {
                    return at;
                }
                depth -= 1;
            }
            ' ' if !quoted && depth == 0 => {
                let next = &tail[at + 1..];
                if [
                    "ordered ", "and ", "or ", "except ", "that ", "called ", "on ",
                ]
                .iter()
                .any(|word| next.starts_with(word))
                {
                    return at;
                }
            }
            _ => {}
        }
    }
    tail.len()
}

/// Every row a call names by a single `#n`, into `out`; `true` when the
/// call's own answer is several shown rows (`answer #2, #5`).
fn collect_handles(tree: &Turn, out: &mut Vec<u32>) -> bool {
    fn set(s: &canon::Set, out: &mut Vec<u32>) {
        use canon::Set;
        match s {
            Set::Ref(canon::Ref::Handles(ns)) if ns.len() == 1 => out.push(ns[0]),
            Set::Ref(_) | Set::Kind(_) => {}
            Set::Walk { from: inner, .. }
            | Set::Called { set: inner, .. }
            | Set::Order { set: inner, .. }
            | Set::First { set: inner, .. }
            | Set::During { set: inner, .. } => set(inner, out),
            Set::Filter {
                set: inner,
                pred: p,
            } => {
                set(inner, out);
                pred(p, out);
            }
            Set::Union(a, b) | Set::Except(a, b) => {
                set(a, out);
                set(b, out);
            }
        }
    }
    fn pred(p: &canon::Pred, out: &mut Vec<u32>) {
        use canon::Pred;
        match p {
            Pred::And(a, b) | Pred::Or(a, b) => {
                pred(a, out);
                pred(b, out);
            }
            Pred::Not(inner) => pred(inner, out),
            Pred::Member(s) => set(s, out),
            Pred::Cmp {
                rhs: canon::Operand::SetArg(s),
                ..
            } => set(s, out),
            _ => {}
        }
    }
    fn value(v: &canon::Value, out: &mut Vec<u32>) {
        match v {
            canon::Value::Agg { set: s, .. } | canon::Value::Project { set: s, .. } => set(s, out),
            canon::Value::Balance { of, within } => {
                set(of, out);
                set(within, out);
            }
        }
    }
    fn cmd(c: &canon::Cmd, out: &mut Vec<u32>) {
        for (_, arg) in &c.args {
            match arg {
                canon::ArgVal::SetArg(s) => set(s, out),
                canon::ArgVal::Value(v) => value(v, out),
                canon::ArgVal::Lit(_) => {}
            }
        }
        if let Some(on) = &c.on {
            set(on, out);
        }
    }
    match tree {
        Turn::Show(canon::Set::Ref(canon::Ref::Handles(ns))) if ns.len() > 1 => return true,
        Turn::Show(s) => set(s, out),
        Turn::Same(a, b) => {
            set(a, out);
            set(b, out);
        }
        Turn::Value(v) => value(v, out),
        Turn::Cmd(c) => cmd(c, out),
        Turn::Seq(cs) => cs.iter().for_each(|c| cmd(c, out)),
        Turn::Nothing | Turn::Refuse(_) | Turn::Clarify(_) => {}
    }
    false
}

/// Is this write a restore (or an undo)?
fn restores(tree: &Turn) -> bool {
    let restoring = |cmd: &canon::Cmd| cmd.verb.contains("restore") || cmd.verb.contains("undo");
    match tree {
        Turn::Cmd(cmd) => restoring(cmd),
        Turn::Seq(cmds) => cmds.iter().any(restoring),
        _ => false,
    }
}

/// `#3 event "Dentist — cleaning" Wed 2026-06-17 10:00 · status=…`
/// Facts a result line needs that the reader's row does not carry: a phone
/// number's value, a debt's amount and who it is with, an expense's payer.
/// Read through the same `field` door the executor filters with, so what a
/// line shows is what a `that (…)` can test.
fn read_facts(row: &VaultRow, ctx: &Context<'_>) -> Vec<String> {
    let columns: &[&str] = match row.entity.as_str() {
        "social.contact_channel" => &["value"],
        "tally.obligation" => &[
            "amount_minor",
            "direction",
            "owed_to_me",
            "owed_to_them",
            "counterparty_party_id",
            "settled_at",
        ],
        "tally.expense" => &["amount_minor", "paid_by"],
        "core.activity" => &["kind"],
        "core.party" => &["owed_to_me_minor", "owed_to_them_minor"],
        "schedule.task" => &["effort_min"],
        "core.content_item" => &["people_party_ids"],
        _ => &[],
    };
    let mut out = Vec::new();
    for column in columns {
        if FACTS.contains(column) {
            continue; // already on the line
        }
        let value = match row.extra.get(*column) {
            Some(value) => value.clone(),
            None => match ctx.field(&row.entity, &row.id, column) {
                Ok(Some(value)) => value,
                _ => continue,
            },
        };
        if value.is_empty() || value == "null" || value == "0" {
            continue;
        }
        // Several people, one fact: every id named, in order.
        if value.contains('\u{1f}') || *column == "people_party_ids" {
            let names: Vec<String> = value
                .split('\u{1f}')
                .filter_map(|id| ctx.field("core.party", id, "display_name").ok().flatten())
                .filter(|name| !name.is_empty())
                .collect();
            if !names.is_empty() {
                let key = column.trim_end_matches("_party_ids");
                out.push(format!("{key}={}", clip(&names.join(", "), 60)));
            }
            continue;
        }
        let shown = if looks_like_id(&value) {
            match ctx.field("core.party", &value, "display_name") {
                Ok(Some(name)) if !name.is_empty() => name,
                _ => continue,
            }
        } else {
            value
        };
        let key = column.trim_end_matches("_party_id");
        out.push(format!("{key}={}", clip(&shown, 40)));
    }
    if row.entity == "tally.group" && row.live {
        out.extend(group_balances(row, ctx));
    }
    // **A TRASHED ROW PAST ITS GRACE WINDOW IS NOT RESTORABLE**: the vault
    // refuses the restore, so the line says so before the model tries.
    if !row.live
        && let Ok(Some(purge)) = ctx.field(&row.entity, &row.id, "purge_at")
        && !purge.is_empty()
        && purge.as_str() <= ctx.now()
    {
        out.push("restorable=no".to_owned());
    }
    out
}

/// **A GROUP SHOWS WHO OWES WHAT.** "Settle up with everyone who owes me"
/// picks members by the sign of their balance in the group — the same
/// `balance of (x) in (group)` the settlement pays — so the group's line
/// carries it: `owes_me=Viggo 900, Cecily 1200 i_owe=Reuben 2100` (minor
/// units; the owner and settled members are left out).
fn group_balances(row: &VaultRow, ctx: &Context<'_>) -> Vec<String> {
    let members: Vec<&str> = row
        .extra
        .get("member_party_ids")
        .map(|ids| ids.split('\u{1f}').filter(|id| !id.is_empty()).collect())
        .unwrap_or_default();
    if members.is_empty() {
        return Vec::new();
    }
    let Ok(board) = ctx.open(centraid_evalsuite::App::Tally) else {
        return Vec::new();
    };
    let (mut owe_me, mut i_owe) = (Vec::new(), Vec::new());
    for member in members {
        if member == ctx.me() {
            continue;
        }
        let balance = crate::exec::group_balance(&board, member, &row.id).round();
        if balance == 0.0 {
            continue;
        }
        let name = match ctx.field("core.party", member, "display_name") {
            Ok(Some(name)) if !name.is_empty() => name,
            _ => continue,
        };
        let entry = format!("{name} {}", number_text(balance.abs()));
        if balance > 0.0 {
            owe_me.push(entry);
        } else {
            i_owe.push(entry);
        }
    }
    let mut out = Vec::new();
    if !owe_me.is_empty() {
        out.push(format!("owes_me={}", owe_me.join(", ")));
    }
    if !i_owe.is_empty() {
        out.push(format!("i_owe={}", i_owe.join(", ")));
    }
    out
}

fn row_line(n: u32, row: &VaultRow, more: &[String], today: &str) -> String {
    let mut out = format!("#{n} {} \"{}\"", kind_of(row), row.label);
    if let Some(date) = &row.date {
        out.push(' ');
        out.push_str(&date_text(date));
        if let Some(word) = day_word(date, today) {
            out.push_str(&format!(" ({word})"));
        }
    }
    let facts: Vec<String> = FACTS
        .iter()
        .filter_map(|key| {
            row.extra
                .get(*key)
                .filter(|value| !value.is_empty() && !looks_like_id(value))
                .map(|value| format!("{key}={}", clip(&value.replace('\u{1f}', ", "), 40)))
        })
        .chain(more.iter().cloned())
        .collect();
    if !facts.is_empty() {
        out.push_str(" · ");
        out.push_str(&facts.join(" "));
    }
    if !row.live {
        out.push_str(" · trashed");
    }
    out
}

/// The reader-computed facts worth a glance on a result line; `get` shows all.
const FACTS: [&str; 14] = [
    "status",
    "direction",
    "owed_to_me",
    "owed_to_them",
    "owed_to_me_minor",
    "owed_to_them_minor",
    "amount_minor",
    "folder",
    "notebooks",
    "album_titles",
    "type",
    "role",
    "kind",
    "favorite",
];

/// `no link from core.party to photos` as `no link from party to photos`.
fn entity_words(text: &str) -> String {
    let mut out = text.to_owned();
    for (_, (entity, _)) in crate::canon::kinds().iter() {
        if out.contains(entity) {
            // A party is named as People names it, not as a group member.
            let row = VaultRow {
                id: String::new(),
                entity: (*entity).to_owned(),
                app: "people".to_owned(),
                label: String::new(),
                date: None,
                live: true,
                extra: BTreeMap::new(),
            };
            out = out.replace(entity, &kind_of(&row));
        }
    }
    out
}

/// The plural kind word for a row, as `show (parties)` spells it.
fn kinds_of(row: &VaultRow) -> String {
    let kinds = crate::canon::kinds();
    let exact = kinds
        .iter()
        .find(|(_, (entity, door))| *entity == row.entity && *door == row.app);
    let loose = kinds.iter().find(|(_, (entity, _))| *entity == row.entity);
    match exact.or(loose) {
        Some((kind, _)) => (*kind).to_owned(),
        None => row.entity.clone(),
    }
}

/// The canonical kind word for a row: the kind whose entity AND door match,
/// else the first whose entity does.
fn kind_of(row: &VaultRow) -> String {
    let kinds = crate::canon::kinds();
    let singular = |kind: &str| -> String {
        match kind {
            "parties" => "party".to_owned(),
            "activities" => "activity".to_owned(),
            "things" => "thing".to_owned(),
            "contact channels" => "contact channel".to_owned(),
            "important dates" => "important date".to_owned(),
            "locker items" => "locker item".to_owned(),
            "journal notes" => "journal note".to_owned(),
            other => other.strip_suffix('s').unwrap_or(other).to_owned(),
        }
    };
    let exact = kinds
        .iter()
        .find(|(_, (entity, door))| *entity == row.entity && *door == row.app);
    let loose = kinds.iter().find(|(_, (entity, _))| *entity == row.entity);
    match exact.or(loose) {
        Some((kind, _)) => singular(kind),
        None => row.entity.clone(),
    }
}

/// `2026-06-17T10:00:00.000Z` as `Wed 2026-06-17 10:00`; a bare day keeps no
/// time; anything else is printed as it came.
fn date_text(raw: &str) -> String {
    let day = raw.get(..10).unwrap_or(raw);
    let Some(weekday) = weekday(day) else {
        return raw.to_owned();
    };
    let time = raw
        .get(11..16)
        .filter(|time| *time != "00:00" && raw.as_bytes().get(10) == Some(&b'T'));
    match time {
        Some(time) => format!("{weekday} {day} {time}"),
        None => format!("{weekday} {day}"),
    }
}

/// **A DATE CARRIES ITS DAY WORD.** A row a week either side of today says
/// what the person would call its day — `(today)`, `(tomorrow)`,
/// `(yesterday)`, `(this Friday)` for the coming six days (the bare weekday
/// the set language reads as the next one), `(last Monday)` for the past six
/// — so "dinner on friday" is a lookup on the screen, not day arithmetic.
fn day_word(raw: &str, today: &str) -> Option<String> {
    use centraid_evalsuite::reference::calendar;
    let day = raw.get(..10)?;
    weekday(day)?;
    weekday(today.get(..10)?)?;
    let today = &today[..10];
    let delta = (-6..=6).find(|k| calendar::shift(today, *k) == day)?;
    let long = || match weekday(day) {
        Some("Mon") => "Monday",
        Some("Tue") => "Tuesday",
        Some("Wed") => "Wednesday",
        Some("Thu") => "Thursday",
        Some("Fri") => "Friday",
        Some("Sat") => "Saturday",
        _ => "Sunday",
    };
    Some(match delta {
        0 => "today".to_owned(),
        1 => "tomorrow".to_owned(),
        -1 => "yesterday".to_owned(),
        2.. => format!("this {}", long()),
        _ => format!("last {}", long()),
    })
}

fn weekday(day: &str) -> Option<&'static str> {
    let mut parts = day.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let date: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&date) {
        return None;
    }
    // Sakamoto's method; 0 = Sunday.
    const T: [i64; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let y = if month < 3 { year - 1 } else { year };
    let at = (y + y / 4 - y / 100 + y / 400 + T[(month - 1) as usize] + date).rem_euclid(7);
    Some(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][at as usize])
}

fn number_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value:.2}")
    }
}

fn looks_like_id(value: &str) -> bool {
    let hex = value.chars().filter(char::is_ascii_hexdigit).count();
    value.len() >= 32 && hex * 10 >= value.len() * 7
}

fn clip(value: &str, at: usize) -> String {
    if value.chars().count() <= at {
        value.to_owned()
    } else {
        let head: String = value.chars().take(at).collect();
        format!("{head}…")
    }
}

/// Today as the system line says it: `Monday 2026-06-15`.
#[must_use]
pub fn today_line(today: &str) -> String {
    let long = match weekday(today) {
        Some("Mon") => "Monday",
        Some("Tue") => "Tuesday",
        Some("Wed") => "Wednesday",
        Some("Thu") => "Thursday",
        Some("Fri") => "Friday",
        Some("Sat") => "Saturday",
        Some("Sun") => "Sunday",
        _ => "",
    };
    format!("today: {long} {today}")
}

/// Every `#n` a session has shown, for a driver that constrains the next call
/// to numbers that exist.
#[must_use]
pub fn shown(session: &ToolSession) -> BTreeMap<u32, String> {
    session
        .state
        .handles
        .iter()
        .map(|(n, row)| (*n, row.label.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::day_word;

    #[test]
    fn a_date_near_today_carries_its_day_word() {
        let today = "2026-06-17"; // a Wednesday
        let word = |day: &str| day_word(day, today);
        assert_eq!(word("2026-06-17T10:00:00Z").as_deref(), Some("today"));
        assert_eq!(word("2026-06-18").as_deref(), Some("tomorrow"));
        assert_eq!(word("2026-06-16").as_deref(), Some("yesterday"));
        assert_eq!(word("2026-06-19").as_deref(), Some("this Friday"));
        assert_eq!(word("2026-06-23").as_deref(), Some("this Tuesday"));
        assert_eq!(word("2026-06-15").as_deref(), Some("last Monday"));
        assert_eq!(word("2026-06-11").as_deref(), Some("last Thursday"));
        assert_eq!(word("2026-06-24"), None);
        assert_eq!(word("2026-06-10"), None);
        assert_eq!(word("someday"), None);
    }
}
