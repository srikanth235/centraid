//! THE ASKS AND DECLINES THE RUNTIME COMPOSES (D-1044-11: the model judges, the harness
//! composes; SPEC §4.8).
//!
//! The model decides what the person wants and says it in the action: the `act` or the `find`
//! with the name. When that action cannot settle on its own, the turn does not go back to the
//! model to write the ask or the decline: it ends here, at the call, in the outcome the
//! situation names. Each rule is behind `Flags::compose`.
//!
//! - A WRITE WHOSE SELECTOR FITS SEVERAL ROWS ends in the ask `Which one?` with the candidates
//!   (`compose_ambiguous_write`), and so does the pick that the person's words do not single out
//!   (`Session::ambiguous_pick`). One thing the person's words settle first. When the message
//!   says all, every, each, both or everyone, or the trace says `scope: all`, the write takes every
//!   row the selector fits instead (`act.rs`, `Session::targets`; the cap holds). Rows that share
//!   one name (the instances of a recurring task or event) are the ask like any other: the
//!   runtime does not pick the next one, and the options are the rows the verb can change.
//! - A WRITE THAT MATCHES NOTHING is the ask or the decline (`compose_unmatched_write`): a name
//!   is resolved in tiers (`resolve`), and a write acts on a tier of 1 to 3 alone, on exactly one
//!   row. A name that only a typo reaches (tier 4), or that reaches several rows of another
//!   kind, is `Did you mean #n?` / `Which one?` over the candidates, never an act; the one row of
//!   another kind the name reaches as it is said (`unmatched_target`) is the row the write goes
//!   to, with a note that says so. For `delete`, `remove_from`, `settle_up`, `settle_debt` and
//!   `reveal` and when the person says all, the ask stays; no candidate is `decline not_found`.
//! - AN `answer` THAT REACHES NO ROW BY NAME answers the near spellings, or answers nothing
//!   (`compose_unmatched_read`). A name that fits several rows without fitting one exactly
//!   answers all of them. A read never gets an `ambiguous:` reply.
//! - A `find` THAT REACHES NO ROW BY NAME is a lookup that came back empty, never an answer
//!   (`compose_find_miss`): the turn stays open, the reply is the plain miss, and a one-line hint
//!   names the near spellings without issuing them.
//! - A REFUSAL ends in a decline when nothing can lift it (a verb that does not apply to the
//!   kind, a row to put in the wrong container, a row in the trash: `compose_declined_write`)
//!   and in an ask over the rows involved when a confirmation can (`act.rs`, `Session::refusal`).
//!
//! Every ending carries `composed: true` and `compose: {family, action}`, so a run can be
//! audited the way `failsoft` is, and the ask or the decline the model keeps is the one with no
//! options (an open question) or a policy reason. What the runtime decides without ending the
//! turn (a find that missed, a write on every row or on a row of another kind) carries `compose`
//! alone.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use crate::native::meta::{Kind, ROW_CAP, Verb};
use crate::native::render;
use crate::native::search;
use crate::native::session::{Outcome, Selector, Session};
use crate::native::world::Key;

/// What the runtime asks when a write fits several rows.
pub(crate) const WHICH_ONE: &str = "Which one?";

/// `outcome` with what the runtime did, for the effect.
pub(crate) fn marked(mut outcome: Outcome, family: &'static str, action: &'static str) -> Outcome {
    outcome.effect.insert(
        "compose".to_owned(),
        json!({"family": family, "action": action}),
    );
    outcome
}

/// The most rows an empty read's hint names (`Session::miss_hint`).
const HINT_ROWS: usize = 4;

/// Whether a selector says more than a kind and a name: a date, a condition or a link.
fn constrained(selector: &Selector) -> bool {
    selector.when.is_some() || !selector.conds.is_empty() || !selector.linked_to.is_empty()
}

/// Whether a row of `kind` may go where the call puts it: a call that says where (`add_to ...
/// to: #n`) has no use for a row of a kind that container cannot hold (nt13 B1), so such a row is
/// no other-kind target and no candidate of a name that reached nothing of the stated kind.
fn holds_in(into: Option<Kind>, kind: Kind) -> bool {
    into.is_none_or(|container| crate::native::act::container_of(kind) == Some(container))
}

impl Session {
    /// A WRITE THAT FITS SEVERAL ROWS ENDS IN THE ASK: the question (`question` says it from the
    /// number of options) with the rows the verb can change as options (`ask_options`; the note
    /// says how many it left out), the rows that are not over first and the nearest to today
    /// first (`live_first`), at most `ROW_CAP` of them. The effect keeps every option as
    /// `ambiguous`, the list the old `ambiguous:` reply had. Nothing was written.
    pub(crate) fn compose_ambiguous_write(
        &mut self,
        verb: Verb,
        what: &str,
        keys: &[Key],
        extra: &Map<String, Value>,
        question: impl Fn(usize) -> String,
    ) -> Outcome {
        let (options, left_out) = self.ask_options(verb, keys, extra);
        let options = self.live_first(&options);
        let mut note = format!(
            "the runtime ended the turn: {what} fits {} rows",
            keys.len()
        );
        if left_out > 0 {
            note.push_str(&format!(
                " ({left_out} left out: {} does not apply to them)",
                verb.spec().name
            ));
        }
        note.push_str(" and nothing was done");
        let mut outcome = self.ends_in_ask(None, &question(options.len()), &options, &note);
        outcome
            .effect
            .insert("ambiguous".to_owned(), self.keys_json(&options));
        if left_out > 0 {
            outcome
                .effect
                .insert("left_out".to_owned(), json!(left_out));
        }
        outcome
            .effect
            .insert("verb".to_owned(), json!(verb.spec().name));
        marked(outcome, "ambiguous_write", "ask_options")
    }

    /// A WRITE THAT MATCHES NO ROW: the runtime's own search for the name
    /// (`unmatched_candidates`). One candidate is `Did you mean #n?` with that row, several
    /// are the ask of `compose_ambiguous_write`, none is `decline not_found`. The caller takes
    /// the one row the name spells, or names under another kind, as the target first
    /// (`unmatched_target`), so this ask is for the rows it leaves: a near spelling of another
    /// kind, a partial fit, `delete`, `remove_from`, `settle_up`, `settle_debt`, `reveal`, and a
    /// write the person said takes every row.
    pub(crate) fn compose_unmatched_write(
        &mut self,
        verb: Verb,
        selector: &Selector,
        into: Option<Kind>,
    ) -> Outcome {
        let none = self.none_text(selector);
        let candidates = self.unmatched_candidates(verb, selector, into);
        let mut outcome = match candidates.as_slice() {
            [] => {
                let in_the_trash = verb != Verb::Restore
                    && selector.name.as_ref().is_some_and(|name| {
                        !self
                            .resolve_name(name, &selector.kinds, true, None)
                            .reached()
                            .is_empty()
                    });
                let why = if in_the_trash {
                    format!("{none}, and the row called that is in the trash")
                } else {
                    none
                };
                let note = format!("the runtime ended the turn: {why}; nothing was done");
                let declined = self.ends_in_decline(None, "not_found", &note);
                marked(declined, "unmatched_write", "decline:not_found")
            }
            [only] => {
                let number = self.number(only);
                let note = format!(
                    "the runtime ended the turn: {none}; nothing was done, and the search found one row"
                );
                let asked = self.ends_in_ask(
                    None,
                    &format!("Did you mean #{number}?"),
                    &candidates,
                    &note,
                );
                marked(asked, "unmatched_write", "ask_nearest")
            }
            _ => {
                let what = selector
                    .name
                    .as_ref()
                    .map_or_else(|| "the selector".to_owned(), |name| format!("\"{name}\""));
                let asked =
                    self.compose_ambiguous_write(verb, &what, &candidates, &Map::new(), |_| {
                        WHICH_ONE.to_owned()
                    });
                marked(asked, "unmatched_write", "ask_options")
            }
        };
        outcome
            .effect
            .insert("verb".to_owned(), json!(verb.spec().name));
        outcome
    }

    /// The rows a write that matched nothing may have meant: the first non-empty of the selector's
    /// own rows a typo reaches (`select_named`, tier 4, the selector's other conditions kept), the
    /// own rows that hold part of the name (`search::name_in_part`), the rows of any kind the name
    /// reaches at its best tier (`resolve`) and the rows of any kind that hold part of it. A selector with a
    /// `when`, `where` or `linked_to` has no search of its own for a write. A name that reaches a
    /// trashed row in full is that row's (nothing but a restore can write it), so there is no
    /// candidate. A candidate is a row the verb applies to, live for every verb but `restore`,
    /// whose rows are the trashed ones.
    fn unmatched_candidates(
        &self,
        verb: Verb,
        selector: &Selector,
        into: Option<Kind>,
    ) -> Vec<Key> {
        let Some(name) = &selector.name else {
            return Vec::new();
        };
        let restoring = verb == Verb::Restore;
        if !restoring
            && !self
                .resolve_name(name, &selector.kinds, true, None)
                .reached()
                .is_empty()
        {
            return Vec::new();
        }
        let keep = |keys: Vec<Key>| -> Vec<Key> {
            keys.into_iter()
                .filter(|key| {
                    verb.command(key.0).is_some()
                        && holds_in(into, key.0)
                        && self
                            .world
                            .row(key)
                            .is_some_and(|row| row.trashed == restoring)
                })
                .collect()
        };
        // a restore reads the trashed rows as a lookup of them does
        let trashed = restoring || selector.trashed;
        let own = keep(
            self.select_named(&Selector {
                trashed,
                ..selector.clone()
            })
            .keys,
        );
        if !own.is_empty() || constrained(selector) {
            return own;
        }
        let scope: Option<BTreeSet<Key>> = selector
            .within
            .and_then(|handle| self.results.get(handle.checked_sub(1)?))
            .map(|result| result.keys.iter().cloned().collect());
        // a write needs more than half the name's content words in a row (nt15 R4; reads keep
        // half), so a row that shares one of two is no candidate; off with `--no-normalize`
        let majority = self.flags.normalize;
        let in_part = |kinds: &[Kind]| {
            keep(search::name_in_part(
                self,
                name,
                kinds,
                scope.as_ref(),
                trashed,
                majority,
            ))
        };
        let own = in_part(&selector.kinds);
        if !own.is_empty() {
            return own;
        }
        let any = keep(
            self.resolve_name(name, &Kind::ALL, trashed, scope.as_ref())
                .matches,
        );
        if any.is_empty() {
            in_part(&Kind::ALL)
        } else {
            any
        }
    }

    /// THE ROW A WRITE BY A NAME THAT REACHED NOTHING IS APPLIED TO (SPEC §4.8): the one row of
    /// another kind the name reaches as it is said (`other_kind_target`; a typo is not that):
    /// `oil change` is the event called `Oil change` when no task is. The write goes to it, with a
    /// note that says so (`Decided::OtherKind`, `act.rs`).
    ///
    /// It stays an ask (`Did you mean #n?`, from `compose_unmatched_write`) when the verb is
    /// `delete` or `remove_from` (a destructive write on a row the person did not name exactly),
    /// `settle_up` or `settle_debt` (real money, nothing undoes it) or `reveal` (a secret), when
    /// the write may take several rows (the trace says `scope: all`, or the message says all: one
    /// near row is not the several the person means), and for a typo (nt11 R3: a name misspelled
    /// is asked over, never acted on).
    pub(crate) fn unmatched_target(
        &self,
        verb: Verb,
        selector: &Selector,
        into: Option<Kind>,
    ) -> Option<Key> {
        if matches!(
            verb,
            Verb::Delete | Verb::RemoveFrom | Verb::SettleUp | Verb::SettleDebt | Verb::Reveal
        ) || self.said_every_row().is_some()
        {
            return None;
        }
        let name = selector.name.as_ref()?;
        self.other_kind_target(verb, selector, name, into)
    }

    /// The one row of another kind a name reaches as it is said (`resolve`, tiers 1 to 3, the
    /// best tier of the other kinds): a row the verb applies to, live for every verb but
    /// `restore`. Not for a selector with a `when`, `where`, `linked_to` or `within`, and not when
    /// the name reaches a trashed row of its own kind (that row's, which only a restore writes).
    /// Two such rows are `Which one?`.
    fn other_kind_target(
        &self,
        verb: Verb,
        selector: &Selector,
        name: &str,
        into: Option<Kind>,
    ) -> Option<Key> {
        if constrained(selector) || selector.within.is_some() {
            return None;
        }
        let restoring = verb == Verb::Restore;
        if !restoring
            && !self
                .resolve_name(name, &selector.kinds, true, None)
                .reached()
                .is_empty()
        {
            return None;
        }
        let others: Vec<Kind> = Kind::ALL
            .iter()
            .copied()
            .filter(|kind| {
                !selector.kinds.contains(kind)
                    && verb.command(*kind).is_some()
                    && holds_in(into, *kind)
            })
            .collect();
        match self.resolve_name(name, &others, restoring, None).reached() {
            [only] => Some(only.clone()),
            _ => None,
        }
    }

    /// The rows a name that reached nothing most likely means, and whether they are reached as the
    /// name is said (`true`) or not: the best tier of the selector's own kinds, the rows of them
    /// that hold part of the name, then the same for any kind; live and trashed rows alike (live
    /// first), or the trashed ones alone for a lookup of trashed rows. `keep` lets the rows through that meet the rest of the selector.
    fn name_hits(
        &self,
        selector: &Selector,
        name: &str,
        keep: impl Fn(&Key) -> bool,
    ) -> (Vec<Key>, bool) {
        let scope: Option<BTreeSet<Key>> = selector
            .within
            .and_then(|handle| self.results.get(handle.checked_sub(1)?))
            .map(|result| result.keys.iter().cloned().collect());
        for kinds in [selector.kinds.as_slice(), Kind::ALL.as_slice()] {
            let reached = crate::native::resolve::resolve_rows(
                name,
                self.world.rows.values().filter(|row| {
                    kinds.contains(&row.kind)
                        && (!selector.trashed || row.trashed)
                        && scope
                            .as_ref()
                            .is_none_or(|scope| scope.contains(&row.key()))
                }),
                self.flags.normalize,
            );
            let mut keys: Vec<Key> = reached
                .matches
                .iter()
                .filter(|key| keep(key))
                .cloned()
                .collect();
            if !keys.is_empty() {
                // live before trashed, then by kind and name
                keys.sort_by_cached_key(|key| {
                    let row = self.world.row(key);
                    (
                        row.is_some_and(|row| row.trashed),
                        key.0,
                        row.map(|row| row.name.to_lowercase()),
                        key.1.clone(),
                    )
                });
                return (keys, !reached.is_typo());
            }
            let part: Vec<Key> =
                search::name_in_part(self, name, kinds, scope.as_ref(), selector.trashed, false)
                    .into_iter()
                    .filter(|key| keep(key))
                    .collect();
            if !part.is_empty() {
                return (part, false);
            }
        }
        (Vec::new(), false)
    }

    /// AN `answer` WHOSE NAME REACHES NO ROW ends in the answer the runtime composes
    /// (`dead_end`): the rows the name fits by word starts or by near spelling, with a note
    /// that says so, or the empty answer when there are none. A selector that also says when,
    /// where or linked-to keeps the rows that meet it. A `find` is a lookup and never ends the
    /// turn this way (`compose_find_miss`).
    pub(crate) fn compose_unmatched_read(&mut self, selector: &Selector) -> Outcome {
        let name = selector.name.clone().unwrap_or_default();
        let (found, by_words) = self.read_hits(selector);
        // A NAME THAT REACHES NO ROW OF THE KIND ASKED, or only rows of another kind, is a
        // lookup that came back empty, as a `find` of it is, when there are rows to name: the turn
        // stays open with the hint (`compose_find_miss`). With nothing to name, or the second such
        // miss of a turn (the hint was shown), it ends as it always did: the rows of another
        // kind the name nearly is, or nothing.
        let of_the_kind = found.iter().any(|key| selector.kinds.contains(&key.0));
        if !of_the_kind && self.read_misses == 0 {
            let (live, gone) = self.miss_rows(selector, &found);
            if !live.is_empty() || !gone.is_empty() || self.has_without(selector) {
                return self.compose_find_miss(selector, "answer_miss");
            }
        }
        if found.is_empty() {
            let text = format!("answered: {}", self.none_text(selector));
            let mut outcome = Outcome::text("");
            self.push_obs(false, None, text.clone(), text, Vec::new(), &mut outcome);
            outcome.ends_turn = true;
            outcome
                .effect
                .insert("answer".to_owned(), json!({"rows": []}));
            return self.composed_answer(outcome, "unmatched_read", "answer_empty");
        }
        let trashed_reached = self.resolve_name(&name, &Kind::ALL, true, None);
        let in_the_trash = found
            .iter()
            .all(|key| trashed_reached.reached().contains(key));
        let note = if by_words && found.len() > 1 {
            format!(
                "note: \"{name}\" fits {} rows; showing all of them",
                found.len()
            )
        } else if in_the_trash {
            format!("note: no live row called \"{name}\"; showing the trashed ones")
        } else {
            format!("note: no row called \"{name}\"; showing near spellings")
        };
        let mut kinds: Vec<Kind> = Vec::new();
        for key in &found {
            if !kinds.contains(&key.0) {
                kinds.push(key.0);
            }
        }
        self.pending_notes.push(note);
        let mut outcome = Outcome::text("");
        let handle = self.issue(
            &kinds,
            found.clone(),
            None,
            Some("answered:".to_owned()),
            ROW_CAP,
            &mut outcome,
        );
        outcome.ends_turn = true;
        outcome.effect.insert(
            "answer".to_owned(),
            json!({"rows": self.keys_json(&found), "ordered": false, "result": format!("@{handle}")}),
        );
        let action = if by_words && found.len() > 1 {
            "answer_all_fits"
        } else if in_the_trash {
            "answer_trashed"
        } else {
            "answer_near_spellings"
        };
        self.composed_answer(outcome, "unmatched_read", action)
    }

    /// The rows a read whose name reached nothing most likely means (`name_hits`), and whether
    /// they fit the name by word starts: a selector that also says when, where or linked-to
    /// keeps the rows that meet it.
    fn read_hits(&self, selector: &Selector) -> (Vec<Key>, bool) {
        let name = selector.name.clone().unwrap_or_default();
        let rest: Option<Vec<Key>> = constrained(selector).then(|| {
            self.select(&Selector {
                name: None,
                ..selector.clone()
            })
        });
        self.name_hits(selector, &name, |key| {
            rest.as_ref().is_none_or(|rest| rest.contains(key))
        })
    }

    /// A `find` (or an `answer`, see `compose_unmatched_read`) WHOSE NAME REACHES NO ROW IS A
    /// LOOKUP THAT CAME BACK EMPTY (SPEC §4.8): it never ends the turn and never answers rows it
    /// did not match. The reply is the plain miss, `answered: 0 events called "ski rentals"
    /// match`, with no result handle and no rows, and one hint line under it
    /// (`miss_hint`) that names what the name nearly was without issuing it: what the person
    /// meant is the model's next call (`search`, another kind, `answer`), and an `answer` is
    /// where the near spellings of its own kind become the answer.
    pub(crate) fn compose_find_miss(
        &mut self,
        selector: &Selector,
        action: &'static str,
    ) -> Outcome {
        let (found, _) = self.read_hits(selector);
        let text = format!("answered: {}", self.none_text(selector));
        let (hint, numbers) = self.miss_hint(selector, &found);
        // The rows the hint names are rows the model can use next: they are in the observation
        // (a line with no text of its own, the hint rides under the reply as its note), so a
        // trace `pick` of one is in the block and no re-anchor line follows a hint that already
        // names rows, like any other reply that names the rows to use (`Obs::visible`).
        let lines = if numbers.is_empty() {
            Vec::new()
        } else {
            vec![(numbers, String::new())]
        };
        let mut outcome = Outcome::text("");
        self.push_obs(false, None, text.clone(), text, lines, &mut outcome);
        if let Some(hint) = hint {
            self.pending_notes.push(hint);
        }
        self.read_misses += 1;
        outcome.effect.insert("rows".to_owned(), json!([]));
        marked(outcome, "unmatched_read", action)
    }

    /// The rows `miss_hint` can name, without numbering any: the live ones (the selector's own
    /// kinds first) and the trashed ones.
    pub(crate) fn miss_rows(&self, selector: &Selector, found: &[Key]) -> (Vec<Key>, Vec<Key>) {
        let name = selector.name.clone().unwrap_or_default();
        let wants_trash = selector.trashed;
        let trashed = |session: &Session, key: &Key| {
            !wants_trash && session.world.row(key).is_some_and(|row| row.trashed)
        };
        let mut live: Vec<Key> = found
            .iter()
            .filter(|key| !trashed(self, key))
            .cloned()
            .collect();
        let mut gone: Vec<Key> = found
            .iter()
            .filter(|key| trashed(self, key))
            .cloned()
            .collect();
        // the wider look: rows of other kinds that hold a word of the name, live or trashed
        let others: Vec<Kind> = Kind::ALL
            .iter()
            .copied()
            .filter(|kind| !selector.kinds.contains(kind))
            .collect();
        if !name.is_empty() && !selector.trashed {
            for key in search::name_reach(self, &name, &others) {
                if found.contains(&key) {
                    continue;
                }
                if trashed(self, &key) {
                    gone.push(key);
                } else {
                    live.push(key);
                }
            }
            for key in search::name_reach(self, &name, &selector.kinds) {
                if trashed(self, &key) && !found.contains(&key) && !gone.contains(&key) {
                    gone.push(key);
                }
            }
        }
        // the selector's own kinds first, the others after, each in the order found
        live.sort_by_key(|key| !selector.kinds.contains(&key.0));
        (live, gone)
    }

    /// THE HINT OF AN EMPTY READ: one line, `hint: …`, parts joined by ` · `, at most
    /// `HINT_ROWS` rows in all, each `#n kind "name"` and in this order: the rows of the
    /// selector's kind whose name is a near spelling or shares a word, then a row of another
    /// kind whose name holds a word (an album `Kyoto 2026` for "kyoto photos"), with the
    /// parameter that reaches it when the kind links to it (`linked_to: #9`); then a trashed row
    /// that matches (`in the trash: #12 …`); and, when the condition was the name alone, that
    /// a name matches only names. Nothing when there is nothing to name. The numbers are those
    /// of the rows named.
    pub(crate) fn miss_hint(
        &mut self,
        selector: &Selector,
        found: &[Key],
    ) -> (Option<String>, Vec<usize>) {
        let name = selector.name.clone().unwrap_or_default();
        let (live, gone) = self.miss_rows(selector, found);
        let mut budget = HINT_ROWS;
        let mut numbers: Vec<usize> = Vec::new();
        let mut parts: Vec<String> = Vec::new();
        let near: Vec<Key> = live.iter().take(budget).cloned().collect();
        budget -= near.len();
        // nt10 G4: a row of the selector's own kind is a near spelling; a row of another kind is
        // labelled apart, so it does not read as a match
        let (own, other): (Vec<Key>, Vec<Key>) = near
            .iter()
            .cloned()
            .partition(|key| selector.kinds.contains(&key.0));
        let mut shown_rows = |session: &mut Self, rows: &[Key]| -> Vec<String> {
            rows.iter()
                .map(|key| {
                    let n = session.number(key);
                    numbers.push(n);
                    let named = render::named(&session.world, n, key);
                    let reaches = !selector.kinds.contains(&key.0)
                        && selector
                            .kinds
                            .iter()
                            .any(|kind| kind.spec().link_to(key.0).is_some());
                    if reaches {
                        format!("{named} (linked_to: #{n})")
                    } else {
                        named
                    }
                })
                .collect()
        };
        if !own.is_empty() {
            let mut part = format!("near spellings: {}", shown_rows(self, &own).join(", "));
            if other.is_empty() && live.len() > near.len() {
                part.push_str(&format!(" and {} more", live.len() - near.len()));
            }
            parts.push(part);
        }
        if !other.is_empty() {
            let mut part = format!(
                "other kinds (only if the message means one): {}",
                shown_rows(self, &other).join(", ")
            );
            if live.len() > near.len() {
                part.push_str(&format!(" and {} more", live.len() - near.len()));
            }
            parts.push(part);
        }
        let in_trash: Vec<Key> = gone.iter().take(budget).cloned().collect();
        if !in_trash.is_empty() {
            let shown: Vec<String> = in_trash
                .iter()
                .map(|key| {
                    let n = self.number(key);
                    numbers.push(n);
                    render::named(&self.world, n, key)
                })
                .collect();
            parts.push(format!("in the trash: {}", shown.join(", ")));
        }
        // nt10 G3: the conditions whose removal gives rows
        parts.extend(self.without_parts(
            selector,
            budget.saturating_sub(in_trash.len()),
            &mut numbers,
        ));
        let name_only = !name.is_empty()
            && !constrained(selector)
            && selector.within.is_none()
            && selector
                .kinds
                .iter()
                .any(|kind| search::searches_bodies(*kind));
        if name_only {
            parts.push(
                "name matches only names; for words in a body or description use search".to_owned(),
            );
        }
        let hint = (!parts.is_empty()).then(|| format!("hint: {}", parts.join(" · ")));
        (hint, numbers)
    }

    /// `outcome` as the answer the runtime ended the turn with.
    fn composed_answer(
        &mut self,
        mut outcome: Outcome,
        family: &'static str,
        action: &'static str,
    ) -> Outcome {
        outcome.effect.insert("tool".to_owned(), json!("answer"));
        outcome.effect.insert("composed".to_owned(), json!(true));
        marked(outcome, family, action)
    }

    /// A WRITE THE RUNTIME REFUSES BEFORE ANYTHING RUNS, with a refusal nothing can lift: the
    /// verb does not apply to the kind (`out_of_scope`), the row goes into a container of
    /// another kind (`out_of_scope`), the row is in the trash (`not_found`). The reply is the
    /// refusal and the decline; the effect names the refusal like the vault's own
    /// (`refusal.predicate`: `does_not_apply`, `wrong_container`, `trashed_target`).
    pub(crate) fn compose_declined_write(
        &mut self,
        verb: Verb,
        key: &Key,
        refusal: &str,
        predicate: &'static str,
        reason: &str,
    ) -> Outcome {
        let said = refusal.strip_prefix("error: ").unwrap_or(refusal);
        let lead = format!("refused: {said}");
        let note = format!("the runtime ended the turn: {}", why(predicate));
        let mut outcome = self.ends_in_decline(Some(lead), reason, &note);
        let facts = json!({
            "verb": verb.spec().name,
            "kind": key.0.name(),
            "id": key.1,
            "n": self.numbers.get(key),
            "predicate": predicate,
            "reason": said,
            "outcome": "decline",
        });
        outcome.effect.insert("refusal".to_owned(), facts);
        outcome
            .effect
            .insert("verb".to_owned(), json!(verb.spec().name));
        marked(outcome, "refused_write", "decline")
    }

    /// A NEW EVENT THAT CLASHES WITH ANOTHER (the vault's `no_busy_conflict`) ends in the ask
    /// `that time clashes with …; pick another time?` over the events in the way: the refused
    /// row is not there yet, so they are all the options. A clash is a refusal a person can
    /// lift by choosing another time, unlike one the verb cannot do (`act.rs`,
    /// `Session::refusal` asks the same of the refusals that name an existing row).
    pub(crate) fn compose_busy_conflict(
        &mut self,
        input: &Value,
        refusal: &str,
    ) -> Option<Outcome> {
        let parse = |field: &str| -> Option<jiff::civil::DateTime> {
            input.get(field)?.as_str()?.parse().ok()
        };
        let (start, end) = (parse("dtstart")?, parse("dtend")?);
        let clashing: Vec<Key> = self
            .world
            .of_kind(Kind::Event)
            .filter(|row| {
                !row.trashed
                    && row.field("status") != Some(&crate::native::world::Val::Enum("cancelled"))
                    && {
                        let (from, to) = crate::native::act::event_span(row);
                        from < end && to > start
                    }
            })
            .map(crate::native::world::Row::key)
            .collect();
        let clashing = self.live_first(&clashing);
        let names: Vec<String> = clashing
            .iter()
            .take(2)
            .map(|key| {
                let name = self.world.row(key).map(|row| row.name.clone());
                format!("the {} event", name.unwrap_or_default())
            })
            .collect();
        let with = match clashing.len() {
            0 => "another event".to_owned(),
            1 | 2 => names.join(" and "),
            more => Kind::Event.count(more),
        };
        let said = refusal.trim_end_matches('.');
        let lead = format!("refused: create event: {said}.");
        let question = format!("that time clashes with {with}; pick another time?");
        let mut outcome = self.ends_in_ask(
            Some(lead),
            &question,
            &clashing,
            "the runtime ended the turn and nothing was done",
        );
        outcome.effect.insert(
            "refusal".to_owned(),
            json!({
                "verb": "create",
                "kind": "event",
                "command": "schedule.propose_event",
                "predicate": "no_busy_conflict",
                "reason": refusal,
                "outcome": "ask",
            }),
        );
        outcome.effect.insert("verb".to_owned(), json!("create"));
        Some(marked(outcome, "refused_write", "ask_options"))
    }
}

/// What a refusal of the runtime's own says in the note of its decline.
fn why(predicate: &str) -> &'static str {
    match predicate {
        "does_not_apply" => "that verb does not apply to that kind of row, nothing can lift that",
        "wrong_container" => "that row does not go into that kind of row, nothing can lift that",
        _ => "a row in the trash is not a target; only a restore can bring it back",
    }
}
