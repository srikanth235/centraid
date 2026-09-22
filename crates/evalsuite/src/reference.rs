//! # THE REFERENCE — what a perfect system would do, written by hand
//!
//! The owner's method rule: *prove every case is reachable with a hand-written
//! reference sequence, 0 failures, before any model runs.* A case the
//! reference cannot pass is not a hard case — it is a case whose expected
//! answer no runtime could reach through the doors that exist, and finding
//! that out after a model run costs a whole corpus.
//!
//! So this is an ORACLE, deliberately. It is told which session and which turn
//! it is answering, and it resolves that turn through the same [`Context`] any
//! candidate gets. It is **not** an architecture and must never become one:
//! there is no language understanding here worth reusing, and a model
//! candidate shares nothing with it but the [`Candidate`] trait.
//!
//! ## The one rule every resolution obeys
//!
//! **Nothing is pasted in from `inventory.json`.** Every id below is FOUND —
//! by opening a board, asking the search plane, reading a field. An oracle
//! that hard-coded its answers would prove the answer was writable, not that
//! it was reachable, and reachability is the whole question.
//!
//! The one exception is an id the SUITE itself supplies as a write argument
//! (an album to add a photograph to, say): that is the case naming its own
//! subject, not the reference smuggling a lookup.
//!
//! ## An unrecognised turn
//!
//! Answers [`Plan::Declined`] with the reason `unhandled`, which matches no
//! expectation and therefore fails loudly. A silent pass on a turn nobody
//! wrote a resolution for is the one failure this file exists to prevent.

use std::collections::BTreeSet;

use serde_json::json;

use crate::{App, Candidate, CandidateRuntime, Context, Expected, Plan, Session, VaultRow};

/// THE TEXT-ONLY SECOND REFERENCE — a `Candidate` that never learns which
/// session or turn it is answering. Declared here rather than in `lib.rs`
/// only to keep this lane's edits out of a file another lane is rewriting;
/// it is an ordinary module of the crate and belongs beside `reference` in
/// `lib.rs` once that settles.
#[path = "textref.rs"]
pub mod textref;

// ---------------------------------------------------------------------------
// THE WEEK CONVENTION. One table, published in README.md.
// ---------------------------------------------------------------------------

/// **What a temporal phrase MEANS in this corpus.**
///
/// The reference used to answer `s01` ("this week") with the calendar week and
/// `s64` ("this week") with a trailing seven days. Both passed, because each
/// case had been written against whichever reading its author had in mind —
/// so the suite held two incompatible definitions of one phrase and nothing
/// said so. A corpus that scores a candidate on "this week" while holding two
/// answers to it is scoring the candidate on guessing the author.
///
/// So the convention is stated once, here, and everything that needs it reads
/// it from here: the position oracle in this file, the text-only reference in
/// `textref.rs`, and `validate-suite`'s temporal check. `validate-suite` is
/// otherwise standalone on purpose (its own parser, so it cannot agree with
/// the runtime by construction) and this is the one deliberate exception — a
/// check that re-implemented the convention would be checking a *different*
/// convention, which is the defect it exists to catch.
///
/// The one rule that resolves every case below:
///
/// > **A NAMED period is a CALENDAR period; a VAGUE one is a ROLLING window.**
///
/// "this week", "last week", "next week", "this month", "last month" name
/// boundaries a calendar draws, and they are taken from the calendar —
/// Monday-start weeks, because the world's `NOW` is a Monday morning and a
/// member's week starts where their calendar says it does. "recently",
/// "lately", "the last few days" name no boundary at all, and they are taken
/// as a rolling window ending today.
///
/// Both windows are INCLUSIVE of both ends and are compared on the date part
/// only (`YYYY-MM-DD`), because a row's salient stamp is a time and a window's
/// is a day.
pub mod calendar {
    /// An inclusive day window, `YYYY-MM-DD` at both ends.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Window {
        pub from: String,
        pub to: String,
    }

    impl Window {
        #[must_use]
        pub fn new(from: impl Into<String>, to: impl Into<String>) -> Self {
            Self {
                from: from.into(),
                to: to.into(),
            }
        }

        /// Does a stamp — a date or a whole instant — fall inside?
        #[must_use]
        pub fn holds(&self, stamp: &str) -> bool {
            stamp.len() >= 10 && stamp[..10] >= *self.from && stamp[..10] <= *self.to
        }
    }

    /// Days since 1970-01-01 for a `YYYY-MM-DD`. Howard Hinnant's `days_from_civil`.
    ///
    /// Written out rather than pulled in: the crate has no date dependency and
    /// a week convention that needed one would be a week convention nobody
    /// could read.
    fn days_from_civil(date: &str) -> i64 {
        let year: i64 = date[..4].parse().unwrap_or(1970);
        let month: i64 = date[5..7].parse().unwrap_or(1);
        let day: i64 = date[8..10].parse().unwrap_or(1);
        let year = year - i64::from(month <= 2);
        let era = if year >= 0 { year } else { year - 399 } / 400;
        let year_of_era = year - era * 400;
        let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        era * 146_097 + day_of_era - 719_468
    }

    /// `YYYY-MM-DD` for a day number. Hinnant's `civil_from_days`.
    fn civil_from_days(mut days: i64) -> String {
        days += 719_468;
        let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
        let day_of_era = days - era * 146_097;
        let year_of_era =
            (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let year = year_of_era + era * 400;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let month_prime = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
        let month = month_prime + if month_prime < 10 { 3 } else { -9 };
        let year = year + i64::from(month <= 2);
        format!("{year:04}-{month:02}-{day:02}")
    }

    /// `date` moved by `days`.
    #[must_use]
    pub fn shift(date: &str, days: i64) -> String {
        civil_from_days(days_from_civil(date) + days)
    }

    /// 0 for Monday … 6 for Sunday. **Monday-start**, which is the whole
    /// content of "this week" and is therefore stated rather than assumed.
    #[must_use]
    pub fn weekday(date: &str) -> i64 {
        (days_from_civil(date) + 3).rem_euclid(7)
    }

    /// The Monday of the calendar week `date` falls in.
    #[must_use]
    pub fn monday_of(date: &str) -> String {
        shift(date, -weekday(date))
    }

    /// Monday → Sunday of the week `today` is in.
    #[must_use]
    pub fn this_week(today: &str) -> Window {
        let monday = monday_of(today);
        Window::new(monday.clone(), shift(&monday, 6))
    }

    /// The whole calendar week before this one. **Not** the trailing seven days.
    #[must_use]
    pub fn last_week(today: &str) -> Window {
        let monday = shift(&monday_of(today), -7);
        Window::new(monday.clone(), shift(&monday, 6))
    }

    #[must_use]
    pub fn next_week(today: &str) -> Window {
        let monday = shift(&monday_of(today), 7);
        Window::new(monday.clone(), shift(&monday, 6))
    }

    /// Saturday and Sunday of the week `today` is in — the weekend AHEAD when
    /// today is a weekday.
    #[must_use]
    pub fn this_weekend(today: &str) -> Window {
        let monday = monday_of(today);
        Window::new(shift(&monday, 5), shift(&monday, 6))
    }

    /// The Saturday and Sunday most recently PAST.
    ///
    /// Tense is the whole difference between this and [`this_weekend`], and it
    /// is the reason a bare "the weekend" is not resolvable from the words
    /// alone: "what's on at the weekend" looks forward and "what did I write
    /// at the weekend" looks back. The corpus always supplies a tense; the
    /// validator, which does not parse one, accepts either window.
    #[must_use]
    pub fn last_weekend(today: &str) -> Window {
        let saturday = shift(&monday_of(today), -2);
        Window::new(saturday.clone(), shift(&saturday, 1))
    }

    /// The whole calendar month `today` is in.
    #[must_use]
    pub fn this_month(today: &str) -> Window {
        let first = format!("{}-01", &today[..7]);
        Window::new(first.clone(), shift(&months_ahead(&first, 1), -1))
    }

    #[must_use]
    pub fn last_month(today: &str) -> Window {
        let first = months_ahead(&format!("{}-01", &today[..7]), -1);
        Window::new(first.clone(), shift(&months_ahead(&first, 1), -1))
    }

    /// `today` … `today` + `months`, forward-looking and inclusive of today.
    ///
    /// "coming up in the next couple of months" is a question about the
    /// future, so it starts NOW and not at the first of the month.
    #[must_use]
    pub fn next_months(today: &str, months: i64) -> Window {
        Window::new(today.to_owned(), months_ahead(today, months))
    }

    /// The same day-of-month `months` away, clamped to the month's length.
    #[must_use]
    pub fn months_ahead(date: &str, months: i64) -> String {
        let year: i64 = date[..4].parse().unwrap_or(1970);
        let month: i64 = date[5..7].parse().unwrap_or(1);
        let day: i64 = date[8..10].parse().unwrap_or(1);
        let total = (year * 12 + month - 1) + months;
        let (year, month) = (total.div_euclid(12), total.rem_euclid(12) + 1);
        // 31 June is not a day. Clamp rather than roll over: "two months from
        // 31 December" is a question about February, not about March.
        let last = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(month - 1) as usize]
            + i64::from(month == 2 && (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)));
        format!("{year:04}-{month:02}-{:02}", day.min(last))
    }

    /// A ROLLING window: the seven days ending today, today included.
    ///
    /// "recently" names no calendar boundary, so it is not given one.
    #[must_use]
    pub fn recently(today: &str) -> Window {
        Window::new(shift(today, -6), today.to_owned())
    }

    /// One day, `days` from today. "in three days" is that day, not the three.
    #[must_use]
    pub fn in_days(today: &str, days: i64) -> Window {
        let day = shift(today, days);
        Window::new(day.clone(), day)
    }

    /// **THE PUBLISHED TABLE**, phrase → window. README.md quotes it.
    ///
    /// A phrase absent from here is one the corpus has no convention for, and
    /// the answer is `None` rather than a guess: a silently-invented window is
    /// how the two readings of "this week" survived in the first place. Bare
    /// "the weekend" and bare "the week" are deliberately absent — they are
    /// resolved by tense, which this table does not see.
    #[must_use]
    pub fn phrase(today: &str, phrase: &str) -> Option<Window> {
        Some(match phrase {
            "today" => in_days(today, 0),
            "tomorrow" => in_days(today, 1),
            "yesterday" => in_days(today, -1),
            "this morning" | "this afternoon" | "this evening" | "tonight" => in_days(today, 0),
            "this week" => this_week(today),
            "last week" => last_week(today),
            "next week" => next_week(today),
            "this weekend" => this_weekend(today),
            "last weekend" => last_weekend(today),
            "this month" => this_month(today),
            "last month" => last_month(today),
            "next month" => {
                let first = months_ahead(&format!("{}-01", &today[..7]), 1);
                Window::new(first.clone(), shift(&months_ahead(&first, 1), -1))
            }
            "recently" | "lately" | "the last few days" => recently(today),
            "the next couple of months" | "the next two months" => next_months(today, 2),
            _ => return None,
        })
    }

    /// Every phrase the table knows, longest first, so "this weekend" is found
    /// before "this week" and "next week" before "week".
    #[must_use]
    pub fn phrases() -> Vec<&'static str> {
        let mut all = vec![
            "the next couple of months",
            "the next two months",
            "the last few days",
            "this weekend",
            "last weekend",
            "this morning",
            "this afternoon",
            "this evening",
            "this month",
            "last month",
            "next month",
            "this week",
            "last week",
            "next week",
            "yesterday",
            "tomorrow",
            "tonight",
            "recently",
            "lately",
            "today",
        ];
        all.sort_by_key(|phrase| std::cmp::Reverse(phrase.len()));
        all
    }
}

/// The hand-written reference runtime.
pub struct Reference;

impl CandidateRuntime for Reference {
    fn name(&self) -> &str {
        "reference (hand-written)"
    }

    fn session(&self, session: &Session) -> Box<dyn Candidate> {
        Box::new(ReferenceSession {
            id: session.id.clone(),
            wants: session
                .turns
                .iter()
                .map(|turn| turn.expected.clone())
                .collect(),
            turn: 0,
            held: Vec::new(),
            aside: Vec::new(),
            undoable: None,
        })
    }
}

/// One conversation.
///
/// It remembers one thing, and it is the thing a MEMBER would expect to be
/// remembered: the rows the last answer named. "Just the weekend ones", "the
/// second one" and "settle it" are unanswerable without them.
struct ReferenceSession {
    id: String,
    /// WHAT EACH TURN OF THIS SESSION EXPECTS.
    ///
    /// The oracle is told which case it is answering — that is what an oracle
    /// is — so the words a write is supposed to carry come from the CASE and
    /// never from a literal in this file. A reference that spelled "Gas" in
    /// its own source went red the moment somebody renamed the expense in the
    /// suite, and the failure read as a scoring bug when it was a coupling
    /// one. Nothing here reads an `ids` answer: the ids are still found
    /// through the doors, because reachability is the whole question.
    wants: Vec<Expected>,
    turn: usize,
    held: Vec<VaultRow>,
    /// **WHAT THE LAST WRITE HANDED BACK THAT ONLY AN UNDO NEEDS.**
    ///
    /// The vault records a change before it makes one and names the recording
    /// in its result, so "scratch that" is answerable: `tally.undo_expense`
    /// and `people.undo_person` both take the revision the earlier turn
    /// minted. A session that did not remember it could only re-edit the row
    /// towards its old value, which is a second change and not a rollback.
    undoable: Option<String>,
    /// **THE THREAD THAT WAS PUT DOWN, NOT THE ONE JUST ANSWERED.**
    ///
    /// `held` is the previous answer, which is what "them" and "the second
    /// one" mean. It is not what "back to the money" means: a session that
    /// steps away for a turn and comes back has TWO live referents, and
    /// collapsing them into one made every resumption resolve to the detour.
    /// So a turn that expects to be returned to puts its rows here, and the
    /// detour is free to overwrite `held`.
    aside: Vec<VaultRow>,
}

// ---------------------------------------------------------------------------
// Reading helpers. Every one of them goes through a door.
// ---------------------------------------------------------------------------

fn board(ctx: &Context<'_>, app: App) -> Vec<VaultRow> {
    ctx.open(app).unwrap_or_default()
}

/// Live rows of `app`, of `entity` when one is named, whose label contains
/// `needle` case-insensitively.
fn like(ctx: &Context<'_>, app: App, entity: Option<&str>, needle: &str) -> Vec<VaultRow> {
    let needle = needle.to_lowercase();
    board(ctx, app)
        .into_iter()
        .filter(|row| row.live)
        .filter(|row| entity.is_none_or(|wanted| row.entity == wanted))
        .filter(|row| row.label.to_lowercase().contains(&needle))
        .collect()
}

/// The one live row of `app` whose label contains `needle`. `None` when there
/// is not exactly one — which is itself an answer, and the reason several
/// resolutions below clarify.
fn only(ctx: &Context<'_>, app: App, entity: Option<&str>, needle: &str) -> Option<VaultRow> {
    let mut found = like(ctx, app, entity, needle);
    (found.len() == 1).then(|| found.remove(0))
}

/// Live rows of `app` whose salient date falls inside `[from, to]` by day.
fn between(ctx: &Context<'_>, app: App, from: &str, to: &str) -> Vec<VaultRow> {
    board(ctx, app)
        .into_iter()
        .filter(|row| row.live)
        .filter(|row| {
            row.date
                .as_deref()
                .is_some_and(|date| &date[..10] >= from && &date[..10] <= to)
        })
        .collect()
}

fn extra_is(row: &VaultRow, key: &str, value: &str) -> bool {
    row.extra.get(key).map(String::as_str) == Some(value)
}

/// Sorted by the row's own date, which is what "the first one" and "the second
/// one" mean about a day's tasks.
fn by_date(mut rows: Vec<VaultRow>) -> Vec<VaultRow> {
    rows.sort_by(|left, right| left.date.cmp(&right.date));
    rows
}

fn ids(rows: &[VaultRow]) -> Vec<String> {
    rows.iter().map(|row| row.id.clone()).collect()
}

fn clarify() -> Plan {
    Plan::Declined {
        reason: "clarify".to_owned(),
    }
}

fn refuse() -> Plan {
    Plan::Declined {
        reason: "refuse".to_owned(),
    }
}

fn unhandled() -> Plan {
    Plan::Declined {
        reason: "unhandled".to_owned(),
    }
}

/// A day, `YYYY-MM-DD`, `offset` days from the world's Monday.
fn day(offset: i64) -> String {
    centraid_evalworld::day(offset)
}

/// A whole instant on that day.
fn at(offset: i64, hour: i64, minute: i64) -> String {
    centraid_evalworld::at(offset, hour, minute)
}

impl ReferenceSession {
    /// A string argument the case names for this turn's write.
    fn text_arg(&self, turn: usize, key: &str) -> Option<String> {
        self.write_args(turn)
            .into_iter()
            .find_map(|args| args.get(key).and_then(serde_json::Value::as_str))
            .map(str::to_owned)
    }

    /// A numeric argument the case names for this turn's write.
    fn number_arg(&self, turn: usize, key: &str) -> Option<i64> {
        self.write_args(turn)
            .into_iter()
            .find_map(|args| args.get(key).and_then(serde_json::Value::as_i64))
    }

    /// The argument maps of this turn's expected write, in the order the case
    /// lists them — one for a `write`, several for a `write_set`.
    fn write_args(&self, turn: usize) -> Vec<&serde_json::Map<String, serde_json::Value>> {
        match self.wants.get(turn) {
            Some(Expected::Write { args, .. }) => vec![args],
            Some(Expected::WriteSet { writes, .. }) => {
                writes.iter().map(|write| &write.args).collect()
            }
            _ => Vec::new(),
        }
    }

    /// Hold rows as the answer, so the next turn can say "those".
    fn answer(&mut self, rows: Vec<VaultRow>) -> Plan {
        let answered = ids(&rows);
        self.held = rows;
        Plan::Ids(answered)
    }

    /// A write whose result is kept, for the one thing a later turn may need
    /// from it: the id of the revision it recorded.
    fn wrote_undoably(
        &mut self,
        ctx: &mut Context<'_>,
        command: &str,
        body: serde_json::Value,
    ) -> Plan {
        match ctx.write(command, body) {
            Ok(result) => {
                self.undoable = result
                    .get("revision_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                Plan::Wrote
            }
            Err(why) => {
                if std::env::var_os("EVALSUITE_SHOW_REFUSALS").is_some() {
                    eprintln!("  refused: {command}: {why}");
                }
                unhandled()
            }
        }
    }

    /// A write, reported as a write or as a failure to reach the case at all.
    fn wrote(ctx: &mut Context<'_>, command: &str, body: serde_json::Value) -> Plan {
        match ctx.write(command, body) {
            Ok(_) => Plan::Wrote,
            // NOT a clarify: the vault refused a write the oracle believed was
            // right, and reporting that as a polite question would hide it.
            Err(why) => {
                if std::env::var_os("EVALSUITE_SHOW_REFUSALS").is_some() {
                    eprintln!("  refused: {command}: {why}");
                }
                unhandled()
            }
        }
    }
}

impl Candidate for ReferenceSession {
    #[expect(
        clippy::too_many_lines,
        reason = "one arm per hand-written resolution — the table IS the artifact, and splitting it would hide the list a reader came for"
    )]
    fn turn(&mut self, _request: &str, ctx: &mut Context<'_>) -> Plan {
        let turn = self.turn;
        self.turn += 1;
        let session = self.id.clone();
        match (session.as_str(), turn) {
            // s01 — "this week" is the world's own Monday-to-Sunday, and the
            // follow-up narrows the rows already answered rather than asking
            // again: "just the weekend ones" is about THOSE events.
            ("s01", 0) => {
                let week = calendar::this_week(ctx.today());
                let rows = between(ctx, App::Agenda, &week.from, &week.to);
                self.answer(rows)
            }
            ("s01", 1) => {
                // FUTURE TENSE — "just the weekend ones" of a week that is
                // still ahead is Saturday and Sunday of THIS week.
                let weekend = calendar::this_weekend(ctx.today());
                let rows: Vec<VaultRow> = self
                    .held
                    .iter()
                    .filter(|row| row.date.as_deref().is_some_and(|date| weekend.holds(date)))
                    .cloned()
                    .collect();
                self.answer(rows)
            }

            // s02 — overdue is due BEFORE now and not yet done. A completed
            // task with a past due date is not overdue, and the world seeds
            // one of those on purpose.
            ("s02", 0) => {
                let today = ctx.today().to_owned();
                let rows: Vec<VaultRow> = board(ctx, App::Tasks)
                    .into_iter()
                    .filter(|row| row.live && !extra_is(row, "status", "completed"))
                    .filter(|row| row.date.as_deref().is_some_and(|date| date[..10] < *today))
                    .collect();
                self.answer(rows)
            }
            ("s02", 1) => {
                let Some(task) = self.held.first().cloned() else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "schedule.edit_task",
                    json!({ "task_id": task.id, "due_at": at(4, 9, 0) }),
                )
            }

            // s03 — "my dentist thing" names an event AND two tasks on the
            // same day. The correct outcome is to ask; the answer to the
            // question is the calendar row.
            ("s03", 0) => {
                let events = like(ctx, App::Agenda, None, "dentist");
                let tasks = like(ctx, App::Tasks, None, "dentist");
                if events.is_empty() || tasks.is_empty() {
                    return unhandled();
                }
                clarify()
            }
            ("s03", 1) => {
                let rows = like(ctx, App::Agenda, None, "dentist");
                self.answer(rows)
            }

            // s04 — LOCKER, which `centraid_search` structurally cannot reach.
            // The only route is the app's own shelf, and that absence is the
            // finding the world seeds these rows to produce.
            ("s04", 0) => {
                let rows = like(ctx, App::Locker, None, "dentist portal");
                self.answer(rows)
            }
            // Revealing leaves a RECEIPT and nothing else. It is a write
            // because the record of who looked is the only durable outcome,
            // and it is append-only by trigger so it cannot be quietly undone.
            ("s04", 1) => {
                let Some(item) = self.held.first().cloned() else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "locker.reveal_receipt",
                    json!({
                        "object_type": "locker.item",
                        "item_id": item.id,
                        "columns": ["password"],
                        "kind": "reveal",
                        "allowed": true,
                    }),
                )
            }

            // s05 — the dinner is on the calendar; WHICH Neha it is with is
            // not, because the summary names no party. Three parties match.
            ("s05", 0) => {
                let rows = between(ctx, App::Agenda, &day(1), &day(1))
                    .into_iter()
                    .filter(|row| row.label.to_lowercase().contains("dinner"))
                    .collect();
                self.answer(rows)
            }
            ("s05", 1) => {
                let nehas = like(ctx, App::People, Some("core.party"), "neha");
                if nehas.len() < 2 {
                    return unhandled();
                }
                clarify()
            }

            // s06 — three hops through two apps, and the third answers NOTHING
            // on purpose: the only Emerald Bay document is trashed, so a
            // reader that forgets `deleted_at` answers with a row the member
            // deleted.
            ("s06", 0) => {
                let rows = like(ctx, App::Notes, Some("knowledge.note"),"tahoe");
                self.answer(rows)
            }
            ("s06", 1) => {
                let rows = like(ctx, App::Notes, Some("knowledge.note"),"emerald bay");
                self.answer(rows)
            }
            ("s06", 2) => {
                let rows = like(ctx, App::Docs, None, "emerald bay");
                self.answer(rows)
            }

            // s07 — sending a password to somebody is not a vault operation at
            // all, and the fact that the password is reachable does not make
            // it one.
            ("s07", 0) => refuse(),

            // s08 — a task and an event share the title EXACTLY. Ask; then do
            // each in turn as the member corrects themselves.
            ("s08", 0) => {
                let tasks = like(ctx, App::Tasks, None, "book the tahoe cabin");
                let events = like(ctx, App::Agenda, None, "book the tahoe cabin");
                if tasks.is_empty() || events.is_empty() {
                    return unhandled();
                }
                clarify()
            }
            ("s08", 1) => {
                let Some(event) = only(ctx, App::Agenda, None, "book the tahoe cabin") else {
                    return clarify();
                };
                // THE DURATION IS PRESERVED. A reschedule that silently made a
                // half-hour call an all-day affair would satisfy a predicate
                // about the start and still be wrong.
                let end = event.extra.get("dtend").cloned().unwrap_or_default();
                let start = event.date.clone().unwrap_or_default();
                Self::wrote(
                    ctx,
                    "schedule.reschedule_event",
                    json!({
                        "event_id": event.id,
                        "dtstart": format!("{}{}", day(4), &start[10..]),
                        "dtend": format!("{}{}", day(4), &end[10..]),
                    }),
                )
            }
            ("s08", 2) => {
                let Some(task) = only(ctx, App::Tasks, None, "book the tahoe cabin") else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "schedule.edit_task",
                    json!({ "task_id": task.id, "due_at": at(4, 9, 0) }),
                )
            }

            // s09 — the member abandons the question mid-session. The second
            // turn must NOT be answered as a narrowing of the first.
            // s09 — a SUM, not a list. "How much have we spent" has a number
            // for an answer, and a candidate that retrieves the four right
            // rows and adds them wrong has not answered it.
            ("s09", 0) => Plan::Value(total_minor(&trip_expenses(ctx))),
            // ...and then the member drops it. Nothing happens, and nothing
            // happening is the whole correct outcome.
            ("s09", 1) | ("s30", 2) | ("s76", 0) | ("s77", 1) => Plan::Declined {
                reason: "none".to_owned(),
            },
            ("s30", 1) => {
                let rows = like(ctx, App::Agenda, None, "morning run");
                self.answer(rows)
            }

            // s10 — "next week", and then "then", which means the same window
            // in a different app.
            ("s10", 0) => {
                let week = calendar::next_week(ctx.today());
                let rows = between(ctx, App::Agenda, &week.from, &week.to);
                self.answer(rows)
            }
            ("s10", 1) => {
                let week = calendar::next_week(ctx.today());
                let rows = between(ctx, App::Tasks, &week.from, &week.to)
                    .into_iter()
                    .filter(|row| !extra_is(row, "status", "completed"))
                    .collect();
                self.answer(rows)
            }

            ("s11", 0) => Self::wrote(
                ctx,
                "schedule.add_task",
                json!({
                    "title": self.text_arg(turn, "title"),
                    "due_at": at(3, 9, 0),
                }),
            ),

            // s12 — the birthday is a row of its own hanging off the party,
            // and the party is NOT the answer: "when" is a date.
            // s12 — two dozen birthdays in the world and several Anas among
            // them, so the full name the member gave is what narrows. Matching
            // "ana" alone was only ever right while there was one.
            ("s12", 0) => {
                let rows = like(
                    ctx,
                    App::People,
                    Some("people.important_date"),
                    "ana ferreira",
                );
                self.answer(rows)
            }

            // s13 — the debt itself resolves (only one Neha carries one), and
            // the PAYMENT still does not: a payment has to name the party, and
            // "her" names three.
            // "DO I OWE X ANYTHING" ASKS FOR THE DEBT. The obligation is what
            // the member wants to see; the party is only who it is owed to.
            // `s13`, `s14` and `b18` used to disagree about which of the two
            // the sentence means, and no candidate could satisfy all three.
            // The Neha disambiguation still holds — only one of the three
            // parties carries a debt, so the question resolves.
            ("s13", 0) => {
                let parties = like(ctx, App::People, Some("core.party"), "neha");
                let debts = debt_ids(&parties);
                self.held = parties;
                Plan::Ids(debts)
            }
            ("s13", 1) => {
                let nehas = like(ctx, App::People, Some("core.party"), "neha");
                if nehas.len() < 2 {
                    return unhandled();
                }
                clarify()
            }

            // s14 — named in full, so it resolves; then settled through the
            // open obligation People's own reader found.
            ("s14", 0) => {
                let parties = like(ctx, App::People, Some("core.party"), "neha rao");
                let debts = debt_ids(&parties);
                self.held = parties;
                Plan::Ids(debts)
            }

            // s15 — a PLACE, then an ALBUM. Two different ways of grouping the
            // same roll, and the world plants a place whose name is also an
            // event's summary so that "Emerald Bay" cannot be resolved by the
            // word alone.
            ("s15", 0) => {
                let photos = board(ctx, App::Photos);
                let Some(place) = photos
                    .iter()
                    .find(|row| row.entity == "core.place" && row.label == "Emerald Bay")
                    .map(|row| row.id.clone())
                else {
                    return unhandled();
                };
                let rows = photos
                    .into_iter()
                    .filter(|row| {
                        row.live
                            && row.entity == "core.content_item"
                            && extra_is(row, "place_id", &place)
                    })
                    .collect();
                self.answer(rows)
            }
            ("s15", 1) => {
                let Some(title) = self
                    .held
                    .first()
                    .and_then(|row| row.extra.get("album_titles"))
                    .and_then(|titles| titles.split('\u{1f}').next())
                    .map(str::to_owned)
                else {
                    return unhandled();
                };
                let rows = board(ctx, App::Photos)
                    .into_iter()
                    .filter(|row| row.entity == "media.album" && row.label == title)
                    .collect();
                self.answer(rows)
            }
            // "What ELSE is in there" — the album's other frames, and the one
            // already named is not one of them.
            ("s15", 2) => {
                let Some(album) = self.held.first().map(|row| row.label.clone()) else {
                    return unhandled();
                };
                let rows = in_album(ctx, &album)
                    .into_iter()
                    .filter(|row| !row.label.contains("Emerald Bay"))
                    .collect();
                self.answer(rows)
            }

            // s16 — the broad question, across every app that can hold an
            // answer. FIVE rows in five apps, and the sixth — a trashed
            // document — is not one of them.
            ("s16", 0) => {
                let rows = everything_about(ctx, "emerald bay");
                self.answer(rows)
            }

            ("s17", 0) => {
                let rows = like(ctx, App::Locker, None, "cabin wifi");
                self.answer(rows)
            }

            // s18 / s49 — ORDERED answers, and a follow-up that points into
            // the list by position. The order is the day's own: due time
            // ascending, which is how a member reads a Wednesday.
            ("s18", 0) => {
                let rows = by_date(like(ctx, App::Tasks, None, "dentist"));
                self.answer(rows)
            }
            ("s18", 1) => {
                let Some(task) = self.held.get(1).cloned() else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "schedule.set_task_status",
                    json!({ "task_id": task.id, "status": "completed" }),
                )
            }

            // s19 — three apps, one subject: the calendar, the drive and the
            // locker. The locker hop is the one no text index can make.
            ("s19", 0) => {
                let rows = like(ctx, App::Agenda, None, "check-in");
                self.answer(rows)
            }
            ("s19", 1) => {
                let rows = like(ctx, App::Docs, None, "rental agreement");
                self.answer(rows)
            }
            ("s19", 2) => {
                let rows = like(ctx, App::Locker, None, "cabin");
                let rows = rows
                    .into_iter()
                    .filter(|row| extra_is(row, "type", "login"))
                    .collect();
                self.answer(rows)
            }

            // s20 — booking on somebody's website is not something a vault
            // does. The refusal is not the end of the conversation, though:
            // the member asks for the thing that IS in scope.
            ("s20", 0) => refuse(),
            ("s20", 1) => {
                let title = self.text_arg(turn, "title");
                Self::wrote(ctx, "schedule.add_task", json!({ "title": title }))
            }

            // s21 — last month holds nothing, and answering nothing is a real
            // answer. A runtime that widened the window to find something
            // would be inventing a month.
            // s21 — last month is EMPTY, and zero is a real answer. A runtime
            // that widened the window until it found something would be
            // inventing a month.
            ("s21", 0) => {
                let month = calendar::last_month(ctx.today());
                Plan::Value(total_minor(&in_month(ctx, &month.from[..7])))
            }
            ("s21", 1) => {
                let month = calendar::this_month(ctx.today());
                Plan::Value(total_minor(&in_month(ctx, &month.from[..7])))
            }

            // s22 — two groups exist, so "the group" names neither.
            ("s22", 0) => {
                let groups: Vec<VaultRow> = board(ctx, App::Tally)
                    .into_iter()
                    .filter(|row| row.entity == "tally.group")
                    .collect();
                if groups.len() < 2 {
                    return unhandled();
                }
                clarify()
            }

            // s23 — three Marcos, one of them trashed. Even discounting the
            // trashed one there are two.
            ("s23", 0) => {
                let marcos = like(ctx, App::People, Some("core.party"), "marco");
                if marcos.len() < 2 {
                    return unhandled();
                }
                clarify()
            }

            // s24 — named in full. The trashed misspelling must not be the
            // answer, and it is the row a reader that forgets `deleted_at`
            // would offer.
            ("s24", 0) => {
                let rows = like(ctx, App::People, Some("core.party"), "marco ferreira");
                self.answer(rows)
            }

            ("s25", 0) => {
                let rows = like(ctx, App::Notes, Some("knowledge.note"),"what dr. rao said");
                self.answer(rows)
            }

            // s26 — a DAY, across apps: the calendar and the board together,
            // which is what a member means by "what's on".
            ("s26", 0) => {
                let rows = day_across_apps(ctx, &day(2));
                self.answer(rows)
            }

            // s45 — "while we're at the cabin" is a window the CALENDAR
            // defines: check-in to check-out. Three apps answer inside it, and
            // the birthday is the one no calendar-shaped read would find.
            ("s45", 0) => {
                let Some((from, to)) = cabin_window(ctx) else {
                    return unhandled();
                };
                let mut rows = between(ctx, App::Agenda, &from, &to);
                rows.extend(
                    between(ctx, App::Tasks, &from, &to)
                        .into_iter()
                        .filter(|row| !extra_is(row, "status", "completed")),
                );
                rows.extend(
                    board(ctx, App::People)
                        .into_iter()
                        .filter(|row| row.live && row.entity == "people.important_date")
                        .filter(|row| {
                            row.date
                                .as_deref()
                                .is_some_and(|date| date[..10] >= *from && date[..10] <= *to)
                        }),
                );
                self.answer(rows)
            }
            ("s26", 1) => {
                let Some(event) = self
                    .held
                    .iter()
                    .find(|row| row.entity == "core.event" && row.label.contains("cleaning"))
                    .cloned()
                else {
                    return clarify();
                };
                let start = event.date.clone().unwrap_or_default();
                let end = event.extra.get("dtend").cloned().unwrap_or_default();
                Self::wrote(
                    ctx,
                    "schedule.reschedule_event",
                    json!({
                        "event_id": event.id,
                        "dtstart": shift_an_hour(&start),
                        "dtend": shift_an_hour(&end),
                    }),
                )
            }

            // s27 — "what's LEFT" is the open children of the plan, not the
            // plan itself and not the child that is already done.
            ("s27", 0) => {
                let tasks = board(ctx, App::Tasks);
                let Some(parent) = tasks
                    .iter()
                    .find(|row| row.label == "Plan the Tahoe trip")
                    .map(|row| row.id.clone())
                else {
                    return unhandled();
                };
                let rows = tasks
                    .into_iter()
                    .filter(|row| row.live && extra_is(row, "parent_task_id", &parent))
                    .filter(|row| !extra_is(row, "status", "completed"))
                    .collect();
                self.answer(rows)
            }

            ("s28", 0) => Self::wrote(
                ctx,
                "knowledge.create_note",
                json!({
                    "title": self.text_arg(turn, "title"),
                    "body_text": "Before the drive up.",
                    "format": "plain",
                }),
            ),

            // s29 — "the trip" is a window AND a place: the roll also holds
            // two frames from home and one with no place at all, and both
            // kinds are the wrong answer.
            ("s29", 0) => {
                let rows = trip_photos(ctx);
                self.answer(rows)
            }
            ("s29", 1) => {
                let Some(photo) = self
                    .held
                    .iter()
                    .find(|row| row.label.contains("Ana"))
                    .cloned()
                else {
                    return clarify();
                };
                let Some(album) = board(ctx, App::Photos)
                    .into_iter()
                    .find(|row| row.entity == "media.album" && row.label == "Tahoe scouting")
                else {
                    return unhandled();
                };
                Self::wrote(
                    ctx,
                    "media.add_to_album",
                    json!({ "album_id": album.id, "asset_id": photo.id }),
                )
            }

            ("s30", 0) => {
                let rows = like(ctx, App::Docs, None, "renters insurance");
                self.answer(rows)
            }

            // s31 — the group's members are Tally's own parties, whose display
            // names are BARE FIRST NAMES that also belong to People rows. So
            // the follow-up cannot be answered: nothing links the Tally "Neha"
            // to either People Neha.
            ("s31", 0) => {
                let tally = board(ctx, App::Tally);
                let Some(members) = tally
                    .iter()
                    .find(|row| row.entity == "tally.group" && row.label.contains("Tahoe"))
                    .and_then(|row| row.extra.get("member_party_ids"))
                    .map(|ids| {
                        ids.split('\u{1f}')
                            .map(str::to_owned)
                            .collect::<BTreeSet<_>>()
                    })
                else {
                    return unhandled();
                };
                let me = ctx.me().to_owned();
                let rows = tally
                    .into_iter()
                    .filter(|row| row.entity == "core.party" && row.id != me)
                    .filter(|row| members.contains(&row.id))
                    .collect();
                self.answer(rows)
            }
            ("s31", 1) | ("s50", 2) | ("s58", 1) => clarify(),

            // s50 turn 1 — a DIFFERENT photograph's place. Two frames share
            // one coordinate and collapsed into a single place row, so this is
            // not the place the first turn answered.
            ("s50", 1) => {
                let photos = board(ctx, App::Photos);
                let Some(place) = photos
                    .iter()
                    .filter(|row| row.entity == "core.content_item")
                    .find(|row| row.label.to_lowercase().contains("dusk"))
                    .and_then(|row| row.extra.get("place_id"))
                    .cloned()
                else {
                    return unhandled();
                };
                let rows = photos
                    .into_iter()
                    .filter(|row| row.entity == "core.place" && row.id == place)
                    .collect();
                self.answer(rows)
            }

            ("s32", 0) => {
                let Some(group) = board(ctx, App::Tally)
                    .into_iter()
                    .find(|row| row.entity == "tally.group" && row.label.contains("Tahoe"))
                else {
                    return unhandled();
                };
                let me = ctx.me().to_owned();
                let today = ctx.today().to_owned();
                let description = self.text_arg(turn, "description");
                let amount = self.number_arg(turn, "amount_minor").unwrap_or_default();
                Self::wrote(
                    ctx,
                    "tally.add_expense",
                    json!({
                        "group_id": group.id,
                        "description": description,
                        "amount_minor": amount,
                        "paid_by": me,
                        "category": "transport",
                        "spent_on": today,
                        "splits": [{ "party_id": me, "share_minor": amount }],
                    }),
                )
            }

            // s33 — a Locker write. The id is minted by the CALLER, because a
            // secret is sealed against the row id and the party that encrypts
            // has to know it before the row exists.
            ("s33", 0) => {
                // THE SEAT MINTS THE ID AND SEALS THE CELL. `locker.add_item`
                // refuses plaintext by name — the gateway holds no key — so a
                // runtime that could not seal could not use the Locker at all.
                let item_id = ctx.mint();
                let (Ok(content), Ok(key_id)) = (ctx.seal(&item_id, "4417"), ctx.locker_key_id())
                else {
                    return unhandled();
                };
                Self::wrote(
                    ctx,
                    "locker.add_item",
                    json!({
                        "item_id": item_id,
                        "type": "note",
                        "title": self.text_arg(turn, "title"),
                        "content": content,
                        "key_id": key_id,
                    }),
                )
            }

            // s34 — a document and the task that produced it. The task is
            // COMPLETED and still the right answer: finished is not deleted.
            ("s34", 0) => {
                let rows = like(ctx, App::Docs, None, "packing list");
                self.answer(rows)
            }
            ("s34", 1) => {
                let rows = like(ctx, App::Tasks, None, "packing list");
                self.answer(rows)
            }

            // s35 — "is the cabin booked" has a task that says one thing and
            // an event that says another, and they are not the same claim.
            ("s35", 0) => {
                let tasks = like(ctx, App::Tasks, None, "book the tahoe cabin");
                let events = like(ctx, App::Agenda, None, "book the tahoe cabin");
                if tasks.is_empty() || events.is_empty() {
                    return unhandled();
                }
                clarify()
            }

            // s36 — eight rows in six apps say "dentist". A bulk delete over
            // that is a question, not an instruction.
            ("s36", 0) => {
                let reach = everything_about(ctx, "dentist");
                if reach.len() < 3 {
                    return unhandled();
                }
                clarify()
            }

            // s37 — the note about the old clinic IS ALREADY TRASHED, so
            // there is nothing to delete and nothing to ask about. A runtime
            // that deleted the live dentist note instead would be doing the
            // thing this case exists to catch.
            ("s37", 0) => {
                let live = like(ctx, App::Notes, Some("knowledge.note"),"old clinic");
                if !live.is_empty() {
                    return unhandled();
                }
                Plan::Declined {
                    reason: "none".to_owned(),
                }
            }

            ("s38", 0) => {
                let rows = like(ctx, App::Notes, Some("knowledge.note"),"chili");
                self.answer(rows)
            }
            // s39 — "the Priya I used to work with". Several parties are
            // called Priya; the one the member means is the one whose ROLE says
            // so, which is a field on the person and not a word in her name.
            ("s39", 0) => {
                let rows = like(ctx, App::People, Some("core.party"), "priya")
                    .into_iter()
                    .filter(|row| {
                        row.extra
                            .get("role")
                            .is_some_and(|role| role.to_lowercase().contains("colleague"))
                    })
                    .collect();
                self.answer(rows)
            }

            // s40 — a flag the app's own reader computes, not a column.
            ("s40", 0) => {
                let rows = board(ctx, App::Photos)
                    .into_iter()
                    .filter(|row| {
                        row.live
                            && row.entity == "core.content_item"
                            && extra_is(row, "favorite", "true")
                    })
                    .collect();
                self.answer(rows)
            }

            // s41 — "about forty five minutes" is the task's own estimate.
            ("s41", 0) => {
                let rows = board(ctx, App::Tasks)
                    .into_iter()
                    .filter(|row| row.live && !extra_is(row, "status", "completed"))
                    .filter(|row| {
                        row.extra
                            .get("effort_min")
                            .and_then(|value| value.parse::<i64>().ok())
                            .is_some_and(|effort| (30..=60).contains(&effort))
                    })
                    .collect();
                self.answer(rows)
            }

            ("s42", 0) => Self::wrote(
                ctx,
                "schedule.propose_event",
                json!({
                    "calendar_id": calendar(ctx),
                    "summary": self.text_arg(turn, "summary"),
                    "dtstart": at(4, 14, 0),
                    "dtend": at(4, 15, 0),
                }),
            ),

            // s43 — who PAID, inside one group. Both Tally friends are bare
            // first names that also belong to People rows, so the payer has to
            // be resolved inside the group and not in the roster.
            ("s43", 0) => {
                let rows = paid_by_in_trip(ctx, "Neha");
                self.answer(rows)
            }
            ("s43", 1) => {
                let rows = paid_by_in_trip(ctx, "Marco");
                self.answer(rows)
            }

            // s44 — a read that establishes a date, and a write that uses it:
            // "before then" is only resolvable from the turn before.
            ("s44", 0) => {
                let rows = like(ctx, App::Agenda, None, "dentist");
                self.answer(rows)
            }
            ("s44", 1) => {
                let Some(day) = self
                    .held
                    .first()
                    .and_then(|row| row.date.clone())
                    .map(|date| date[..10].to_owned())
                else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "schedule.add_task",
                    json!({
                        "title": self.text_arg(turn, "title"),
                        "due_at": format!("{day}T09:00:00.000Z"),
                    }),
                )
            }

            // s46 — a password that has never been rotated has NO
            // `password_set_at`. A card has no password at all and is not an
            // answer; the trashed login is not an answer either.
            ("s46", 0) => {
                let rows = board(ctx, App::Locker)
                    .into_iter()
                    .filter(|row| row.live)
                    .filter(|row| {
                        matches!(
                            row.extra.get("type").map(String::as_str),
                            Some("login" | "wifi")
                        )
                    })
                    // NEVER ROTATED: the password's own stamp still equals
                    // the row's creation. An item with no password at all has
                    // no stamp and is not an answer.
                    .filter(|row| {
                        row.extra.get("password_set_at").is_some()
                            && row.extra.get("password_set_at") == row.extra.get("created_at")
                    })
                    .collect();
                self.answer(rows)
            }

            // s47 — "export my whole locker to a plain file" is the one
            // request whose whole point is to leave the custody the locker
            // exists to provide.
            ("s47", 0) | ("s62", 0) | ("s57", 0) => refuse(),

            // s48 — a CORRECTION. Two writes, against two different parties,
            // and the second one does not undo the first: the member said the
            // call happened, they only got the person wrong.
            ("s48", 0) => log_call(ctx, "Neha Kulkarni"),
            ("s48", 1) => log_call(ctx, "Neha Rao"),

            ("s49", 0) => {
                let rows = by_date(
                    between(ctx, App::Tasks, &day(2), &day(2))
                        .into_iter()
                        .filter(|row| !extra_is(row, "status", "completed"))
                        .collect(),
                );
                self.answer(rows)
            }
            ("s49", 1) => {
                let Some(task) = self.held.first().cloned() else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "schedule.edit_task",
                    json!({ "task_id": task.id, "due_at": at(4, 9, 0) }),
                )
            }

            // s50 — the place a photograph collapsed into. The follow-up looks
            // like it has an answer (an event IS called "Emerald Bay") and does
            // not: nothing links that event to this place, so saying yes would
            // be inferring a link the vault does not hold.
            ("s50", 0) => {
                let photos = board(ctx, App::Photos);
                let Some(place) = photos
                    .iter()
                    .filter(|row| row.entity == "core.content_item")
                    .find(|row| row.label.contains("Emerald Bay"))
                    .and_then(|row| row.extra.get("place_id"))
                    .cloned()
                else {
                    return unhandled();
                };
                let rows = photos
                    .into_iter()
                    .filter(|row| row.entity == "core.place" && row.id == place)
                    .collect();
                self.answer(rows)
            }

            ("s51", 0) => {
                let rows = like(ctx, App::Docs, None, "cabin rental agreement");
                self.answer(rows)
            }
            ("s51", 1) | ("s38", 1) => {
                let rows = like(ctx, App::Notes, Some("knowledge.note"),"chili");
                self.answer(rows)
            }

            ("s52", 0) => {
                let Some(document) = only(ctx, App::Docs, None, "cabin rental agreement") else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "core.trash_document",
                    json!({ "document_id": document.id }),
                )
            }

            // s53 — who, then how much, then settled. The amount is on the
            // obligation and not on the party, so the middle turn is a second
            // read and not a restatement of the first.
            ("s53", 0) => {
                let rows = board(ctx, App::People)
                    .into_iter()
                    .filter(|row| row.live && row.extra.contains_key("owed_to_them"))
                    .collect();
                self.answer(rows)
            }
            ("s53", 1) => {
                let Some(amount) = self
                    .held
                    .first()
                    .and_then(|row| row.extra.get("owed_to_them"))
                    .and_then(|ids| ids.split('\u{1f}').next())
                    .and_then(|debt| {
                        ctx.field("tally.obligation", debt, "amount_minor")
                            .ok()
                            .flatten()
                    })
                    .and_then(|value| value.parse::<f64>().ok())
                else {
                    return unhandled();
                };
                Plan::Value(amount)
            }
            ("s53", 2) | ("s14", 1) => {
                let Some(debt) = self
                    .held
                    .first()
                    .and_then(|row| row.extra.get("owed_to_them"))
                    .and_then(|ids| ids.split('\u{1f}').next())
                    .map(str::to_owned)
                else {
                    return clarify();
                };
                Self::wrote(ctx, "people.settle_debt", json!({ "debt_id": debt }))
            }

            // s54 — "Marco" is three parties in People and one bare first name
            // in Tally, and adding the wrong one to a money group is not a
            // small mistake.
            ("s54", 0) => {
                let marcos = like(ctx, App::People, Some("core.party"), "marco");
                if marcos.len() < 2 {
                    return unhandled();
                }
                clarify()
            }

            ("s55", 0) => {
                let rows = like(ctx, App::Agenda, None, "check-out");
                self.answer(rows)
            }

            // s56 — the OTHER group, and then the document that belongs with
            // it. Two hops, and the first is the one the two-group world makes
            // a choice rather than a default.
            ("s56", 0) => {
                let tally = board(ctx, App::Tally);
                let Some(group) = tally
                    .iter()
                    .find(|row| row.entity == "tally.group" && row.label.contains("Clinic"))
                    .map(|row| row.id.clone())
                else {
                    return unhandled();
                };
                let rows = tally
                    .into_iter()
                    .filter(|row| {
                        row.entity == "tally.expense"
                            && row.live
                            && extra_is(row, "group_id", &group)
                    })
                    .collect();
                self.answer(rows)
            }
            ("s56", 1) => {
                let rows = like(ctx, App::Docs, None, "dentist");
                self.answer(rows)
            }

            ("s58", 0) => {
                let rows = between(ctx, App::Agenda, &day(1), &day(1));
                self.answer(rows)
            }

            // s59 — home is the OTHER cluster on the roll, and the follow-up
            // narrows it to a month that holds none of it.
            ("s59", 0) => {
                let rows = home_photos(ctx);
                self.answer(rows)
            }
            ("s59", 1) => {
                let may = previous_month(ctx.today());
                let rows: Vec<VaultRow> = self
                    .held
                    .iter()
                    .filter(|row| {
                        row.date
                            .as_deref()
                            .is_some_and(|date| date.starts_with(&may))
                    })
                    .cloned()
                    .collect();
                self.answer(rows)
            }

            ("s60", 0) => {
                let rows = like(ctx, App::Docs, None, "pre-authorisation");
                self.answer(rows)
            }
            ("s60", 1) => {
                let Some(document) = self.held.first().cloned() else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "core.star_document",
                    json!({ "document_id": document.id }),
                )
            }

            ("s61", 0) => {
                let rows = like(ctx, App::Notes, Some("knowledge.note"),"shortlist");
                self.answer(rows)
            }
            ("s61", 1) => {
                let title = self.text_arg(turn, "title");
                Self::wrote(ctx, "schedule.add_task", json!({ "title": title }))
            }

            // s63 — no deadline, and not already done. A completed task with
            // no due date is not something the member "has got".
            ("s63", 0) => {
                let rows = board(ctx, App::Tasks)
                    .into_iter()
                    .filter(|row| row.live && row.date.is_none())
                    .filter(|row| !extra_is(row, "status", "completed"))
                    .collect();
                self.answer(rows)
            }

            // s64 — finished, which is a status and not a trash state.
            // s64 — "this week", over a logbook two years deep. The window is
            // the whole case: `completed_at`, not `due_at`, because a task
            // finished today may have been due last month or never.
            // "LAST WEEK" IS THE CALENDAR WEEK BEFORE THIS ONE, not the
            // trailing seven days. This arm read `day(-7)..` and `s01` read
            // the calendar week, so one reference held two definitions of a
            // week — see [`calendar`].
            ("s64", 0) => {
                let week = calendar::last_week(ctx.today());
                let rows = board(ctx, App::Tasks)
                    .into_iter()
                    .filter(|row| row.live && extra_is(row, "status", "completed"))
                    .filter(|row| {
                        row.extra
                            .get("completed_at")
                            .is_some_and(|stamp| week.holds(stamp))
                    })
                    .collect();
                self.answer(rows)
            }

            // ----------------------------------------------------------------
            // Aggregates. A number, not a list — and the world is seeded so
            // that retrieving the right rows and adding them wrong is a
            // DIFFERENT answer from retrieving them and adding them right.
            // ----------------------------------------------------------------

            // s65 — the rows, then the total OF THOSE ROWS. The second turn
            // must not re-derive the set: "what's that come to" is about what
            // was just answered.
            ("s65", 0) => {
                let rows = trip_expenses(ctx);
                self.answer(rows)
            }
            ("s65", 1) => Plan::Value(total_minor(&self.held)),

            ("s66", 0) => Plan::Value(total_minor(&group_expenses(ctx, "Clinic"))),

            // s67 — what one member still owes, which is their share of what
            // they did not pay MINUS what they have already settled. Three
            // tables and a subtraction; a candidate that answered their share
            // alone would be out by the settlement the world seeds.
            ("s67", 0) => match owed_by(ctx, "Marco") {
                Some(amount) => Plan::Value(amount),
                None => unhandled(),
            },

            ("s68", 0) => {
                #[expect(
                    clippy::cast_precision_loss,
                    reason = "a count of photographs on one roll"
                )]
                let count = trip_photos(ctx).len() as f64;
                Plan::Value(count)
            }

            // s69 — the Locker's own shelf. `centraid_search` cannot count it,
            // because it cannot see it.
            ("s69", 0) => {
                #[expect(clippy::cast_precision_loss, reason = "a count of shelf items")]
                let count = board(ctx, App::Locker)
                    .into_iter()
                    .filter(|row| row.live)
                    .count() as f64;
                Plan::Value(count)
            }

            // s70 — a cadence, which is a field of the person and not a
            // derived statistic.
            ("s70", 0) => {
                let Some(days) = like(ctx, App::People, Some("core.party"), "ray")
                    .first()
                    .and_then(|row| row.extra.get("cadence_days"))
                    .and_then(|value| value.parse::<f64>().ok())
                else {
                    return unhandled();
                };
                Plan::Value(days)
            }

            // s71 — a COUNT of overdue tasks, and the completed one with a
            // past due date is not one of them.
            ("s71", 0) => {
                let today = ctx.today().to_owned();
                #[expect(clippy::cast_precision_loss, reason = "a count of tasks")]
                let count = board(ctx, App::Tasks)
                    .into_iter()
                    .filter(|row| row.live && !extra_is(row, "status", "completed"))
                    .filter(|row| row.date.as_deref().is_some_and(|date| date[..10] < *today))
                    .count() as f64;
                Plan::Value(count)
            }

            ("s83", 0) => match outstanding_debt(ctx) {
                Some(amount) => Plan::Value(amount),
                None => unhandled(),
            },

            // ----------------------------------------------------------------
            // Bulk writes. ONE instruction, SEVERAL outcomes — and half of a
            // bulk edit is worse than none of it, because the member believes
            // it finished.
            // ----------------------------------------------------------------
            ("s72", 0) => {
                let rows = by_date(like(ctx, App::Tasks, None, "dentist"));
                self.answer(rows)
            }
            ("s72", 1) => {
                let held = self.held.clone();
                for task in &held {
                    if let Plan::Declined { .. } = Self::wrote(
                        ctx,
                        "schedule.edit_task",
                        json!({ "task_id": task.id, "due_at": at(4, 9, 0) }),
                    ) {
                        return unhandled();
                    }
                }
                Plan::Wrote
            }

            ("s73", 0) => {
                let tasks = between(ctx, App::Tasks, &day(2), &day(2))
                    .into_iter()
                    .filter(|row| row.label.to_lowercase().contains("dentist"))
                    .collect::<Vec<_>>();
                if tasks.is_empty() {
                    return unhandled();
                }
                for task in &tasks {
                    if let Plan::Declined { .. } = Self::wrote(
                        ctx,
                        "schedule.set_task_status",
                        json!({ "task_id": task.id, "status": "completed" }),
                    ) {
                        return unhandled();
                    }
                }
                Plan::Wrote
            }

            // s74 — settle with everyone in the group. WHO is in it comes from
            // the group, not from the roster: the three members are bare first
            // names that also belong to People rows.
            ("s74", 0) => {
                let tally = board(ctx, App::Tally);
                let Some(group) = tally
                    .iter()
                    .find(|row| row.entity == "tally.group" && row.label.contains("Tahoe"))
                    .cloned()
                else {
                    return unhandled();
                };
                let me = ctx.me().to_owned();
                let members: Vec<String> = group
                    .extra
                    .get("member_party_ids")
                    .map(|ids| ids.split('\u{1f}').map(str::to_owned).collect())
                    .unwrap_or_default();
                let today = ctx.today().to_owned();
                // **EACH MEMBER'S OWN BALANCE, READ OFF THE CASE.** This
                // reference used to pay everybody 1 minor unit, which passed
                // only because `settled_up` did not read `amount_minor` —
                // and one of the three writes was satisfied by the seeded
                // Ana settlement without the reference paying her at all
                // (DEFECT #17). The amount is now per member, taken from the
                // write the case names for that member, so a renamed or
                // recomputed balance travels into the reference by itself.
                for member in members.iter().filter(|party| **party != me) {
                    let Some(amount) = self
                        .write_args(turn)
                        .into_iter()
                        .find(|args| {
                            args.get("party_id").and_then(serde_json::Value::as_str)
                                == Some(member.as_str())
                        })
                        .and_then(|args| {
                            args.get("amount_minor").and_then(serde_json::Value::as_i64)
                        })
                    else {
                        return unhandled();
                    };
                    if let Plan::Declined { .. } = Self::wrote(
                        ctx,
                        "tally.settle_up",
                        json!({
                            "from_party": member,
                            "to_party": me,
                            "amount_minor": amount,
                            "group_id": group.id,
                            "paid_on": today,
                        }),
                    ) {
                        return unhandled();
                    }
                }
                Plan::Wrote
            }

            // s75 — the task AND the event, which share a title exactly. The
            // member named both, so this is a bulk edit and not the ambiguity
            // s08 asks about.
            ("s75", 0) => {
                let (Some(task), Some(event)) = (
                    only(ctx, App::Tasks, None, "book the tahoe cabin"),
                    only(ctx, App::Agenda, None, "book the tahoe cabin"),
                ) else {
                    return clarify();
                };
                if let Plan::Declined { .. } = Self::wrote(
                    ctx,
                    "schedule.edit_task",
                    json!({ "task_id": task.id, "due_at": at(4, 9, 0) }),
                ) {
                    return unhandled();
                }
                let start = event.date.clone().unwrap_or_default();
                let end = event.extra.get("dtend").cloned().unwrap_or_default();
                Self::wrote(
                    ctx,
                    "schedule.reschedule_event",
                    json!({
                        "event_id": event.id,
                        "dtstart": format!("{}{}", day(4), &start[10..]),
                        "dtend": format!("{}{}", day(4), &end[10..]),
                    }),
                )
            }

            // s77 — a real question, and then the member drops it.
            ("s77", 0) => {
                let week = calendar::this_week(ctx.today());
                let rows = between(ctx, App::Agenda, &week.from, &week.to);
                self.answer(rows)
            }

            // s78 — the last touch is an ACTIVITY row, not a field of the
            // person. "When did I last hear from" is answered by the thing
            // that happened.
            ("s78", 0) => {
                let rows = last_touch(ctx, "Marco Ferreira");
                self.answer(rows)
            }

            // s79 — a phone number is a contact channel. Named in full, so it
            // resolves; s80 is the same question with the name that does not.
            ("s79", 0) => {
                let rows = board(ctx, App::People)
                    .into_iter()
                    .filter(|row| row.live && row.entity == "social.contact_channel")
                    .filter(|row| row.label.starts_with("Neha Kulkarni"))
                    .filter(|row| extra_is(row, "kind", "phone"))
                    .collect();
                self.answer(rows)
            }

            // s80 — SENDING A TEXT IS OUTSIDE THE VAULT. Both Nehas carry a
            // phone number, so the object is ambiguous too, but the ambiguity
            // is never reached: the assistant cannot send a message at all, and
            // a question about which Neha followed by a refusal either way is a
            // worse outcome for the member than the refusal alone. Owner
            // ruling, 2026-09-21 — the case used to expect `clarify`.
            //
            // The phone numbers are still read, so the refusal is not reached
            // by a resolution that failed: the vault CAN name who was meant and
            // still will not act.
            ("s80", 0) => {
                let reachable: Vec<VaultRow> = board(ctx, App::People)
                    .into_iter()
                    .filter(|row| row.live && row.entity == "social.contact_channel")
                    .filter(|row| row.label.to_lowercase().starts_with("neha"))
                    .filter(|row| extra_is(row, "kind", "phone"))
                    .collect();
                let people: BTreeSet<String> = reachable
                    .iter()
                    .filter_map(|row| row.extra.get("party_id").cloned())
                    .collect();
                if people.len() < 2 {
                    return unhandled();
                }
                refuse()
            }

            // s81 — the People journal is a NOTE, written by the app on the
            // member's behalf. A reader that only knew about notes the member
            // typed would miss it.
            // s81 — a STRICT weekend: the world's Monday is `day(0)`, so last
            // Saturday and Sunday are `day(-2)` and `day(-1)`. The journal
            // entry sits inside it, so a candidate that reads "last weekend"
            // as two days and one that reads it as the preceding week both
            // land on the same row and the phrase is no longer load-bearing.
            ("s81", 0) => {
                // PAST TENSE — "what did I write over the weekend" is the
                // weekend just gone, not the one ahead.
                let weekend = calendar::last_weekend(ctx.today());
                let rows = like(ctx, App::People, Some("knowledge.note"), "journal")
                    .into_iter()
                    .filter(|row| row.date.as_deref().is_some_and(|date| weekend.holds(date)))
                    .collect();
                self.answer(rows)
            }

            // s84 / s85 — the important-date shelf, which is not the calendar.
            // A `MM-DD` recurs, so "this month" and "the next couple of
            // months" are windows over the next occurrence.
            ("s84", 0) => {
                let month = calendar::this_month(ctx.today());
                let rows = important_dates(ctx)
                    .into_iter()
                    .filter(|row| row.date.as_deref().is_some_and(|date| month.holds(date)))
                    .filter(|row| row.label.starts_with("Birthday"))
                    .collect();
                self.answer(rows)
            }
            ("s85", 0) => {
                let ahead = calendar::next_months(ctx.today(), 2);
                let rows = important_dates(ctx)
                    .into_iter()
                    .filter(|row| row.date.as_deref().is_some_and(|date| ahead.holds(date)))
                    .collect();
                self.answer(rows)
            }
            ("s85", 1) => {
                let rows = self
                    .held
                    .iter()
                    .filter(|row| row.label.starts_with("Birthday"))
                    .cloned()
                    .collect();
                self.answer(rows)
            }

            // s82 — a day that holds an EVENT and a BIRTHDAY, and the birthday
            // is not on the calendar. Two apps, and the second is the one a
            // calendar-shaped answer would miss.
            ("s82", 0) => {
                let wanted = day(6);
                let mut rows = between(ctx, App::Agenda, &wanted, &wanted);
                rows.extend(
                    board(ctx, App::People)
                        .into_iter()
                        .filter(|row| row.live && row.entity == "people.important_date")
                        .filter(|row| {
                            row.date
                                .as_deref()
                                .is_some_and(|date| date[..10] == *wanted)
                        }),
                );
                self.answer(rows)
            }

            // -----------------------------------------------------------------
            // s86-s90 — THE UNDO SESSIONS. The corpus's other four `undo`
            // turns are WITHDRAWALS: nothing had been written, so nothing is
            // rolled back. These five take back a write that landed.
            // -----------------------------------------------------------------

            // s86 — the trash is part of the Tasks board, so the row is
            // findable; only `schedule.restore_task` makes it live again.
            ("s86", 0) => {
                let rows: Vec<VaultRow> = board(ctx, App::Tasks)
                    .into_iter()
                    .filter(|row| !row.live && row.label.to_lowercase().contains("library books"))
                    .collect();
                self.answer(rows)
            }
            ("s86", 1) => {
                let Some(task) = self.held.first().map(|row| row.id.clone()) else {
                    return clarify();
                };
                Self::wrote(ctx, "schedule.restore_task", json!({ "task_id": task }))
            }

            // s87 — THE UNDO THAT IS TOO LATE. The permit is in the trash and
            // its thirty days have run out, so `core.restore_document` refuses
            // it by name. The refusal is ASKED FOR rather than assumed: the
            // oracle calls the command and reports what the vault said, which
            // is the only way a case about a precondition can be evidence
            // about the precondition.
            ("s87", 0) => {
                let rows: Vec<VaultRow> = board(ctx, App::Docs)
                    .into_iter()
                    .filter(|row| {
                        !row.live || row.extra.get("trashed").map(String::as_str) == Some("true")
                    })
                    .filter(|row| row.label.to_lowercase().contains("permit"))
                    .collect();
                self.answer(rows)
            }
            ("s87", 1) => {
                let Some(document) = self.held.first().map(|row| row.id.clone()) else {
                    return clarify();
                };
                match ctx.write("core.restore_document", json!({ "document_id": document })) {
                    Ok(_) => unhandled(),
                    Err(_) => refuse(),
                }
            }

            // s88 — Photos hands back its own trash beside the grid, so the
            // frame is reachable; `media.restore_asset` is what un-deletes it.
            ("s88", 0) => {
                let rows: Vec<VaultRow> = board(ctx, App::Photos)
                    .into_iter()
                    .filter(|row| row.entity == "core.content_item" && !row.live)
                    .filter(|row| row.label.to_lowercase().contains("hallway"))
                    .collect();
                self.answer(rows)
            }
            ("s88", 1) => {
                let Some(asset) = self.held.first().map(|row| row.id.clone()) else {
                    return clarify();
                };
                Self::wrote(ctx, "media.restore_asset", json!({ "asset_id": asset }))
            }

            // s89 — the ONE true rollback in the corpus: Tally records the
            // expense as it was before the trash, and the undo puts that
            // recording back rather than editing towards it.
            ("s89", 0) => {
                let Some(expense) = only(ctx, App::Tally, Some("tally.expense"), "lift tickets")
                else {
                    return clarify();
                };
                self.held = vec![expense.clone()];
                self.wrote_undoably(
                    ctx,
                    "tally.delete_expense",
                    json!({ "expense_id": expense.id }),
                )
            }
            ("s89", 1) => {
                let (Some(expense), Some(revision)) = (
                    self.held.first().map(|row| row.id.clone()),
                    self.undoable.clone(),
                ) else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "tally.undo_expense",
                    json!({ "expense_id": expense, "revision_id": revision }),
                )
            }

            // s90 — the canonical party survives a trash and only the profile
            // is dated shut, so the undo is that profile coming back and not a
            // second Priya being created beside the first.
            ("s90", 0) => {
                let Some(person) = only(ctx, App::People, Some("core.party"), "priya raman") else {
                    return clarify();
                };
                self.held = vec![person.clone()];
                self.wrote_undoably(ctx, "people.trash_person", json!({ "party_id": person.id }))
            }
            ("s90", 1) => {
                let (Some(party), Some(revision)) = (
                    self.held.first().map(|row| row.id.clone()),
                    self.undoable.clone(),
                ) else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "people.undo_person",
                    json!({ "party_id": party, "revision_id": revision }),
                )
            }

            // ===================================================================
            // LANE C — the cross-app answers, and the deep conversations.
            //
            // Every arm below reaches its answer through a JOIN the vault
            // actually holds: an attendee row, an obligation's party, a place
            // id, an album's membership, a folder or notebook name. Nothing is
            // matched on a word that happens to appear in two apps, because a
            // shared word is what the corpus plants to be WRONG.
            // ===================================================================

            // s91 — the attendee list is the only row in this world that says
            // which Neha is coming to anything; the debts hang off the same
            // party ids, so the second turn is a set intersection and not a
            // second search.
            ("s91", 0) | ("s118", 0) => {
                let needle = if session == "s91" {
                    "emerald bay"
                } else {
                    "check-in"
                };
                let Some(event) = only(ctx, App::Agenda, Some("core.event"), needle) else {
                    return unhandled();
                };
                let guests = attendees(&event);
                let rows = parties_by_id(ctx, &guests);
                self.answer(rows)
            }
            ("s91", 1) => {
                let owed = owed_to_me_ids(&self.held);
                if owed.is_empty() {
                    return unhandled();
                }
                Plan::Ids(owed)
            }

            // s92 — a person, reached in Agenda through the attendee link.
            ("s92", 0) => {
                let Some(ana) = only(ctx, App::People, Some("core.party"), "ana ferreira") else {
                    return unhandled();
                };
                let rows: Vec<VaultRow> = board(ctx, App::Agenda)
                    .into_iter()
                    .filter(|row| row.live && attendees(row).iter().any(|id| *id == ana.id))
                    .collect();
                self.held = vec![ana];
                Plan::Ids(ids(&by_date(rows)))
            }
            ("s92", 1) => {
                let Some(amount) = self
                    .held
                    .first()
                    .and_then(|row| row.extra.get("owed_to_me"))
                    .and_then(|held| held.split('\u{1f}').next())
                    .and_then(|debt| {
                        ctx.field("tally.obligation", debt, "amount_minor")
                            .ok()
                            .flatten()
                    })
                    .and_then(|value| value.parse::<f64>().ok())
                else {
                    return unhandled();
                };
                Plan::Value(amount)
            }

            // s93 — ONE WORD, TWO FILING SYSTEMS. "Travel" is a Docs folder
            // and a Notes notebook, and they hold different rows.
            ("s93", 0) | ("s115", 1) | ("s108", 2) | ("s118", 3) => {
                let mut rows = in_folder(ctx, "Travel");
                if session == "s115" {
                    rows.retain(|row| !row.label.contains("packing"));
                }
                if session == "s118" {
                    rows.retain(|row| row.label.to_lowercase().contains("cabin"));
                }
                self.answer(rows)
            }
            ("s93", 1) | ("s105", 0) => {
                let notebook = if session == "s93" {
                    "Travel"
                } else {
                    "Recipes"
                };
                let rows = in_notebook(ctx, notebook);
                self.answer(rows)
            }

            // s94 — the same filing word asked of both apps at once. The
            // trashed clinic note is in that notebook and is not an answer.
            ("s94", 0) => {
                let mut rows = in_notebook(ctx, "Health");
                rows.extend(in_folder(ctx, "Health"));
                self.answer(rows)
            }

            // s95 — album membership, then the party a photograph's title
            // names. The album is the join; the title is only how the member
            // says which frame.
            ("s95", 0) | ("s112", 4) | ("s116", 0) | ("s118", 5) => {
                let album = match session.as_str() {
                    "s95" => "People of mine",
                    "s116" => "Around the house",
                    _ => "Tahoe scouting",
                };
                let mut rows = in_album(ctx, album);
                if session == "s112" {
                    // "what ELSE is in it" — the two answered two turns ago are
                    // out, and they are held ASIDE because the turn in between
                    // answered an album.
                    let already: BTreeSet<String> =
                        self.aside.iter().map(|row| row.id.clone()).collect();
                    rows.retain(|row| !already.contains(&row.id));
                }
                self.answer(rows)
            }
            ("s95", 1) => {
                let Some(frame) = self
                    .held
                    .iter()
                    .find(|row| row.label.to_lowercase().contains("workshop"))
                    .cloned()
                else {
                    return unhandled();
                };
                // The title names one of three Marcos; the ACTIVITY is the one
                // logged against the party whose full name the title carries.
                let who = frame
                    .label
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .to_lowercase();
                let rows: Vec<VaultRow> = board(ctx, App::People)
                    .into_iter()
                    .filter(|row| row.entity == "core.activity")
                    .filter(|row| row.label.to_lowercase().contains(&who))
                    .collect();
                self.answer(rows)
            }

            // s96 — a note, then the task that came out of it. Nothing but the
            // subject holds them together, which is what makes it a hop.
            ("s96", 0) => {
                let rows: Vec<VaultRow> =
                    like(ctx, App::Notes, Some("knowledge.note"), "shortlist");
                self.answer(rows)
            }
            ("s96", 1) => {
                let rows = like(ctx, App::Tasks, Some("schedule.task"), "compare cabins");
                self.answer(rows)
            }

            // s97 — the note names a place; the photographs are reached
            // through the PLACE ROW, not through a word in their titles.
            ("s97", 0) => {
                let rows = like(ctx, App::Notes, Some("knowledge.note"), "where to park");
                self.answer(rows)
            }
            ("s97", 1) | ("s112", 2) | ("s120", 1) => {
                let place_name = if session == "s112" {
                    "West shore ridge"
                } else {
                    "Emerald Bay"
                };
                let place = if session == "s112" {
                    self.held.first().map(|row| row.id.clone())
                } else {
                    place_named(ctx, place_name).map(|row| row.id)
                };
                let Some(place) = place else {
                    return unhandled();
                };
                let rows = photos_at(ctx, &place);
                if session == "s112" {
                    self.aside = rows.clone();
                }
                self.answer(rows)
            }

            // s98 — "Home" is a Docs folder AND a named place in Photos, and
            // neither is reachable from the other except by the word. That is
            // the finding, not a defect of the resolution.
            ("s98", 0) => {
                let rows = in_folder(ctx, "Home");
                self.answer(rows)
            }
            ("s98", 1) | ("s116", 1) => {
                let name = if session == "s98" {
                    "Home".to_owned()
                } else {
                    let Some(frame) = self.held.first().cloned() else {
                        return unhandled();
                    };
                    let Some(place_id) = frame.extra.get("place_id").cloned() else {
                        return unhandled();
                    };
                    let Some(row) = board(ctx, App::Photos)
                        .into_iter()
                        .find(|row| row.entity == "core.place" && row.id == place_id)
                    else {
                        return unhandled();
                    };
                    row.label
                };
                let Some(place) = place_named(ctx, &name) else {
                    return unhandled();
                };
                self.answer(vec![place])
            }

            // s99 — the ledger row, then the paperwork behind it.
            ("s99", 0) => {
                let rows = like(ctx, App::Tally, Some("tally.expense"), "cabin deposit");
                Plan::Value(total_minor(&rows))
            }
            ("s99", 1) | ("s100", 1) | ("s115", 0) => {
                let rows = match session.as_str() {
                    "s99" => like(ctx, App::Docs, Some("core.document"), "rental agreement"),
                    "s115" => like(ctx, App::Docs, Some("core.document"), "packing list"),
                    _ => in_folder(ctx, "Travel"),
                };
                self.answer(rows.into_iter().filter(|row| row.live).collect())
            }

            // s100 — a task, then the folder of documents that belongs to it.
            ("s100", 0) => {
                let rows = like(
                    ctx,
                    App::Tasks,
                    Some("schedule.task"),
                    "plan the tahoe trip",
                );
                self.answer(rows)
            }

            // s101 — a party, then a photograph whose title names her.
            ("s101", 0) => {
                let rows = like(ctx, App::People, Some("core.party"), "ana ferreira");
                self.answer(rows)
            }
            ("s101", 1) => {
                let Some(who) = self.held.first().map(|row| {
                    row.label
                        .split_whitespace()
                        .next()
                        .unwrap_or_default()
                        .to_lowercase()
                }) else {
                    return unhandled();
                };
                let rows: Vec<VaultRow> = board(ctx, App::Photos)
                    .into_iter()
                    .filter(|row| row.live && row.entity == "core.content_item")
                    .filter(|row| row.label.to_lowercase().contains(&who))
                    .collect();
                self.answer(rows)
            }

            // s102 — the shared title, read in each app in turn.
            ("s102", 0) => {
                let rows = like(ctx, App::Agenda, Some("core.event"), "book the tahoe cabin");
                self.answer(rows)
            }
            ("s102", 1) => {
                let rows = like(
                    ctx,
                    App::Tasks,
                    Some("schedule.task"),
                    "book the tahoe cabin",
                );
                self.answer(rows)
            }

            // s103 — a person by ROLE, then the app the index cannot reach.
            ("s103", 0) => {
                let rows: Vec<VaultRow> = board(ctx, App::People)
                    .into_iter()
                    .filter(|row| row.live && row.entity == "core.party")
                    .filter(|row| extra_is(row, "role", "Dentist"))
                    .collect();
                self.answer(rows)
            }
            ("s103", 1) => {
                let rows = like(ctx, App::Locker, Some("locker.item"), "dentist portal");
                self.answer(rows)
            }

            // s104 — ONE NOUN, SEVEN APPS, and the trashed clinic note is not
            // one of them. Every board, because no index reaches Locker.
            ("s104", 0) => {
                let mut rows: Vec<VaultRow> = Vec::new();
                for app in App::all() {
                    rows.extend(like(ctx, app, None, "dentist"));
                }
                rows.retain(|row| !row.label.contains("old clinic"));
                // THE DEBT IS AN EDGE, NOT A ROW. People's roster hands an
                // obligation back as an id hanging off the party; nothing puts
                // it on a board. Its own `reason` is the label that says
                // "dentist", so the walk is party -> obligation -> reason.
                let parties: Vec<VaultRow> = board(ctx, App::People)
                    .into_iter()
                    .filter(|row| row.entity == "core.party")
                    .collect();
                for debt in debt_ids(&parties) {
                    let reason = ctx
                        .field("tally.obligation", &debt, "reason")
                        .ok()
                        .flatten()
                        .unwrap_or_default();
                    if reason.to_lowercase().contains("dentist") {
                        rows.push(VaultRow {
                            id: debt,
                            entity: "tally.obligation".to_owned(),
                            app: App::People.id().to_owned(),
                            label: reason,
                            date: None,
                            live: true,
                            extra: std::collections::BTreeMap::new(),
                        });
                    }
                }
                self.answer(rows)
            }

            // s105 — the Notes library and the People journal are one TABLE
            // and two DOORS; `load_library` does not hand back a journal entry.
            ("s105", 1) => {
                let rows: Vec<VaultRow> = board(ctx, App::People)
                    .into_iter()
                    .filter(|row| row.live && row.entity == "knowledge.note")
                    .collect();
                self.answer(by_date(rows))
            }

            // s106 — the obligations, refined, summed, dropped for a turn and
            // picked up again by name.
            ("s106", 0) => {
                let rows: Vec<VaultRow> = board(ctx, App::People)
                    .into_iter()
                    .filter(|row| row.live && row.extra.contains_key("owed_to_me"))
                    .collect();
                self.answer(rows)
            }
            ("s106", 1) => {
                let mut kept: Vec<VaultRow> = Vec::new();
                for row in self.held.clone() {
                    if owed_to_me_total(ctx, &row) > 5_000.0 {
                        kept.push(row);
                    }
                }
                self.answer(kept)
            }
            ("s106", 2) => {
                let total: f64 = self.held.iter().map(|row| owed_to_me_total(ctx, row)).sum();
                Plan::Value(total)
            }
            ("s106", 3) | ("s119", 3) => {
                // A DETOUR, and the thread is not lost: `held` is left alone so
                // the turn after it can say "those two".
                let rows = if session == "s106" {
                    let tomorrow = calendar::in_days(ctx.today(), 1);
                    between(ctx, App::Agenda, &tomorrow.from, &tomorrow.to)
                } else {
                    self.aside.clone()
                };
                Plan::Ids(ids(&by_date(rows)))
            }
            ("s106", 4) => {
                let guests = cabin_guests(ctx);
                let rows: Vec<VaultRow> = self
                    .held
                    .iter()
                    .filter(|row| guests.contains(&row.id))
                    .cloned()
                    .collect();
                self.answer(rows)
            }
            ("s106", 5) | ("s117", 4) => {
                let Some(party) = self.held.first().map(|row| row.id.clone()) else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "people.log_interaction",
                    json!({ "party_id": party, "kind": "call" }),
                )
            }

            // s107 — an ordinal into the previous answer, a write, and a
            // CORRECTION that has to put one row back and move another.
            ("s107", 0) => {
                let Some(event) = only(ctx, App::Agenda, Some("core.event"), "cleaning") else {
                    return unhandled();
                };
                let rows = parties_by_id(ctx, &attendees(&event));
                self.aside = rows.clone();
                self.answer(rows)
            }
            ("s107", 1) | ("s107", 5) => {
                let wednesday = day(2);
                let mut rows: Vec<VaultRow> = Vec::new();
                rows.extend(between(ctx, App::Tasks, &wednesday, &wednesday));
                rows.extend(between(ctx, App::Agenda, &wednesday, &wednesday));
                rows.retain(|row| !extra_is(row, "status", "completed"));
                let rows = by_date(rows);
                self.answer(rows)
            }
            ("s107", 2) => {
                let Some(task) = self
                    .held
                    .iter()
                    .filter(|row| row.entity == "schedule.task")
                    .nth(1)
                    .cloned()
                else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "schedule.edit_task",
                    json!({ "task_id": task.id, "due_at": at(4, 14, 0) }),
                )
            }
            ("s107", 3) => {
                let tasks: Vec<VaultRow> = self
                    .held
                    .iter()
                    .filter(|row| row.entity == "schedule.task")
                    .cloned()
                    .collect();
                let (Some(moved), Some(meant)) = (tasks.get(1).cloned(), tasks.first().cloned())
                else {
                    return clarify();
                };
                // NOT BACK TO WEDNESDAY. A reschedule to the day the world
                // already seeded is true of a vault nobody touched, so the
                // correction moves the row a second time rather than undoing
                // the first — see the session's own note.
                if !matches!(
                    Self::wrote(
                        ctx,
                        "schedule.edit_task",
                        json!({ "task_id": moved.id, "due_at": at(3, 14, 0) }),
                    ),
                    Plan::Wrote
                ) {
                    return unhandled();
                }
                Self::wrote(
                    ctx,
                    "schedule.edit_task",
                    json!({ "task_id": meant.id, "due_at": at(4, 9, 0) }),
                )
            }
            ("s107", 4) | ("s110", 2) => {
                let who = if session == "s107" {
                    self.aside.first().map(|row| row.label.clone())
                } else {
                    self.held.first().map(|row| row.label.clone())
                };
                let Some(who) = who else {
                    return unhandled();
                };
                let rows: Vec<VaultRow> = board(ctx, App::People)
                    .into_iter()
                    .filter(|row| row.entity == "social.contact_channel")
                    .filter(|row| extra_is(row, "kind", "phone"))
                    .filter(|row| row.label.starts_with(&who))
                    .collect();
                self.answer(rows)
            }

            // s108 — BOTH SIDES OF THE GRACE WINDOW. One document comes back
            // and one cannot, and the second refusal is real behaviour.
            ("s108", 0) => {
                let window = calendar::recently(ctx.today());
                let rows: Vec<VaultRow> = board(ctx, App::Docs)
                    .into_iter()
                    .filter(|row| !row.live)
                    .filter(|row| row.date.as_deref().is_some_and(|date| window.holds(date)))
                    .collect();
                self.answer(rows)
            }
            ("s108", 1) => {
                let Some(document) = self.held.first().map(|row| row.id.clone()) else {
                    return clarify();
                };
                self.aside = self.held.clone();
                Self::wrote(
                    ctx,
                    "core.restore_document",
                    json!({ "document_id": document }),
                )
            }
            ("s108", 3) => {
                let Some(document) = self.aside.first().map(|row| row.id.clone()) else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "core.star_document",
                    json!({ "document_id": document }),
                )
            }
            ("s108", 4) => {
                let rows: Vec<VaultRow> = board(ctx, App::Docs)
                    .into_iter()
                    .filter(|row| {
                        !row.live || row.extra.get("trashed").map(String::as_str) == Some("true")
                    })
                    .filter(|row| row.label.to_lowercase().contains("permit"))
                    .collect();
                self.answer(rows)
            }
            ("s108", 5) => {
                let Some(document) = self.held.first().map(|row| row.id.clone()) else {
                    return clarify();
                };
                match ctx.write("core.restore_document", json!({ "document_id": document })) {
                    Ok(_) => unhandled(),
                    Err(_) => refuse(),
                }
            }

            // s109 — a write into an album, then a read that is only right if
            // it landed.
            ("s109", 0) => {
                let rows = like(ctx, App::Photos, Some("core.content_item"), "marco");
                self.answer(rows)
            }
            ("s109", 1) => {
                let Some(frame) = self.held.first().cloned() else {
                    return unhandled();
                };
                let titles: BTreeSet<String> = frame
                    .extra
                    .get("album_titles")
                    .map(|held| held.split('\u{1f}').map(str::to_owned).collect())
                    .unwrap_or_default();
                let rows: Vec<VaultRow> = board(ctx, App::Photos)
                    .into_iter()
                    .filter(|row| row.entity == "media.album" && titles.contains(&row.label))
                    .collect();
                self.answer(rows)
            }
            ("s109", 2) | ("s118", 2) => {
                let (album, needle) = if session == "s109" {
                    ("Rolls to sort", "trailhead")
                } else {
                    ("Tahoe scouting", "workshop")
                };
                let (Some(album), Some(frame)) = (
                    board(ctx, App::Photos)
                        .into_iter()
                        .find(|row| row.entity == "media.album" && row.label == album),
                    only(ctx, App::Photos, Some("core.content_item"), needle),
                ) else {
                    return unhandled();
                };
                self.aside = vec![album.clone()];
                Self::wrote(
                    ctx,
                    "media.add_to_album",
                    json!({ "album_id": album.id, "asset_id": frame.id }),
                )
            }
            ("s109", 3) => {
                let rows = in_album(ctx, "Rolls to sort");
                self.answer(rows)
            }
            ("s109", 4) | ("s114", 2) | ("s115", 3) => {
                let rows = like(ctx, App::Agenda, Some("core.event"), "check-in");
                self.answer(rows)
            }
            ("s109", 5) | ("s112", 3) => {
                let frame = if session == "s109" {
                    only(
                        ctx,
                        App::Photos,
                        Some("core.content_item"),
                        "emerald bay overlook",
                    )
                } else {
                    self.held.first().cloned()
                };
                let Some(frame) = frame else {
                    return unhandled();
                };
                let titles: BTreeSet<String> = frame
                    .extra
                    .get("album_titles")
                    .map(|held| held.split('\u{1f}').map(str::to_owned).collect())
                    .unwrap_or_default();
                let rows: Vec<VaultRow> = board(ctx, App::Photos)
                    .into_iter()
                    .filter(|row| row.entity == "media.album" && titles.contains(&row.label))
                    .collect();
                self.answer(rows)
            }

            // s110 — one person's rows across three apps, then a write against
            // the debt the first turn asked about.
            ("s110", 0) => {
                let rows: Vec<VaultRow> = board(ctx, App::People)
                    .into_iter()
                    .filter(|row| row.live && row.extra.contains_key("owed_to_them"))
                    .collect();
                let total: f64 = rows
                    .iter()
                    .flat_map(|row| {
                        row.extra
                            .get("owed_to_them")
                            .map(|held| held.split('\u{1f}'))
                            .into_iter()
                            .flatten()
                    })
                    .filter_map(|debt| {
                        ctx.field("tally.obligation", debt, "amount_minor")
                            .ok()
                            .flatten()
                    })
                    .filter_map(|value| value.parse::<f64>().ok())
                    .sum();
                self.aside = rows;
                Plan::Value(total)
            }
            ("s110", 1) => {
                let rows = self.aside.clone();
                self.answer(rows)
            }
            ("s110", 3) => {
                let Some(who) = self.aside.first().map(|row| row.label.clone()) else {
                    return unhandled();
                };
                let surname = who
                    .split_whitespace()
                    .last()
                    .unwrap_or_default()
                    .to_lowercase();
                let rows: Vec<VaultRow> = board(ctx, App::Agenda)
                    .into_iter()
                    .filter(|row| row.live)
                    .filter(|row| {
                        attendees(row)
                            .iter()
                            .any(|id| self.aside.iter().any(|party| party.id == *id))
                    })
                    .collect();
                let _ = surname;
                self.answer(rows)
            }
            ("s110", 4) => {
                let Some(debt) = self
                    .aside
                    .first()
                    .and_then(|row| row.extra.get("owed_to_them"))
                    .and_then(|held| held.split('\u{1f}').next())
                    .map(str::to_owned)
                else {
                    return clarify();
                };
                Self::wrote(ctx, "people.settle_debt", json!({ "debt_id": debt }))
            }

            // s111 — a two-step refine, an ordinal into what it left, a write,
            // and a read of what the write left behind.
            ("s111", 0) => {
                let rows: Vec<VaultRow> = board(ctx, App::Tasks)
                    .into_iter()
                    .filter(|row| row.live && !extra_is(row, "status", "completed"))
                    .collect();
                self.answer(rows)
            }
            ("s111", 1) => {
                let week = calendar::this_week(ctx.today());
                let rows: Vec<VaultRow> = self
                    .held
                    .iter()
                    .filter(|row| row.date.as_deref().is_some_and(|date| week.holds(date)))
                    .cloned()
                    .collect();
                self.answer(by_date(rows))
            }
            ("s111", 2) => {
                let rows: Vec<VaultRow> = self
                    .held
                    .iter()
                    .filter(|row| row.label.to_lowercase().contains("dentist"))
                    .cloned()
                    .collect();
                self.answer(by_date(rows))
            }
            ("s111", 3) => {
                let Some(task) = self.held.first().cloned() else {
                    return clarify();
                };
                self.aside = self.held.clone();
                Self::wrote(
                    ctx,
                    "schedule.set_task_status",
                    json!({ "task_id": task.id, "status": "completed" }),
                )
            }
            ("s111", 4) => {
                let named: BTreeSet<String> = self.aside.iter().map(|row| row.id.clone()).collect();
                let rows: Vec<VaultRow> = board(ctx, App::Tasks)
                    .into_iter()
                    .filter(|row| named.contains(&row.id))
                    .filter(|row| row.live && !extra_is(row, "status", "completed"))
                    .collect();
                self.answer(rows)
            }

            // s112 — the place table, narrowed by a COUNT over the rows that
            // point at it.
            ("s112", 0) => {
                let rows: Vec<VaultRow> = board(ctx, App::Photos)
                    .into_iter()
                    .filter(|row| row.live && row.entity == "core.place")
                    .collect();
                self.answer(rows)
            }
            ("s112", 1) => {
                let photos = board(ctx, App::Photos);
                let rows: Vec<VaultRow> = self
                    .held
                    .iter()
                    .filter(|place| {
                        photos
                            .iter()
                            .filter(|row| row.live && row.entity == "core.content_item")
                            .filter(|row| extra_is(row, "place_id", &place.id))
                            .count()
                            == 2
                    })
                    .cloned()
                    .collect();
                self.answer(rows)
            }

            // s113 — a write that trashes the wrong row, and a correction that
            // has to ROLL IT BACK and trash the right one.
            ("s113", 0) => {
                let me = ctx.me().to_owned();
                let rows: Vec<VaultRow> = group_expenses(ctx, "Tahoe")
                    .into_iter()
                    .filter(|row| extra_is(row, "paid_by", &me))
                    .collect();
                self.answer(rows)
            }
            ("s113", 1) => {
                let rows: Vec<VaultRow> = self
                    .held
                    .iter()
                    .filter(|row| {
                        row.extra
                            .get("amount_minor")
                            .and_then(|value| value.parse::<i64>().ok())
                            .is_some_and(|amount| amount > 10_000)
                    })
                    .cloned()
                    .collect();
                self.aside = self.held.clone();
                self.answer(rows)
            }
            ("s113", 2) => {
                let Some(expense) = self.held.first().cloned() else {
                    return clarify();
                };
                self.wrote_undoably(
                    ctx,
                    "tally.delete_expense",
                    json!({ "expense_id": expense.id }),
                )
            }
            ("s113", 3) => {
                let (Some(wrong), Some(revision)) =
                    (self.held.first().cloned(), self.undoable.clone())
                else {
                    return clarify();
                };
                let Some(meant) = self.aside.iter().find(|row| row.id != wrong.id).cloned() else {
                    return clarify();
                };
                if !matches!(
                    Self::wrote(
                        ctx,
                        "tally.undo_expense",
                        json!({ "expense_id": wrong.id, "revision_id": revision }),
                    ),
                    Plan::Wrote
                ) {
                    return unhandled();
                }
                Self::wrote(
                    ctx,
                    "tally.delete_expense",
                    json!({ "expense_id": meant.id }),
                )
            }
            ("s113", 4) => {
                let me = ctx.me().to_owned();
                let rows: Vec<VaultRow> = group_expenses(ctx, "Tahoe")
                    .into_iter()
                    .filter(|row| extra_is(row, "paid_by", &me))
                    .collect();
                self.answer(rows)
            }

            // s114 — two reveals with a detour between them.
            ("s114", 0) => {
                let rows: Vec<VaultRow> = board(ctx, App::Locker)
                    .into_iter()
                    .filter(|row| row.live && row.label.to_lowercase().contains("cabin"))
                    .collect();
                self.aside = rows.clone();
                self.answer(rows)
            }
            ("s114", 1) | ("s114", 3) => {
                let needle = if turn == 1 { "wifi" } else { "cabins" };
                let Some(item) = self
                    .aside
                    .iter()
                    .find(|row| row.label.to_lowercase().contains(needle))
                    .cloned()
                else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "locker.reveal_receipt",
                    json!({
                        "object_type": "locker.item",
                        "item_id": item.id,
                        "columns": ["password"],
                        "kind": "reveal",
                        "allowed": true,
                    }),
                )
            }
            ("s114", 4) => {
                let rows: Vec<VaultRow> = board(ctx, App::Locker)
                    .into_iter()
                    .filter(|row| row.live && row.label.to_lowercase().contains("cabin"))
                    .filter(|row| !row.label.to_lowercase().contains("cabins"))
                    .collect();
                self.answer(rows)
            }

            // s115 — a folder walked from one of its members, a star, a
            // detour, a trash, and the folder as the writes left it.
            ("s115", 2) => {
                let Some(document) = self.held.first().map(|row| row.id.clone()) else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "core.star_document",
                    json!({ "document_id": document }),
                )
            }
            ("s115", 4) => {
                let Some(document) =
                    only(ctx, App::Docs, Some("core.document"), "rental agreement")
                else {
                    return clarify();
                };
                Self::wrote(
                    ctx,
                    "core.trash_document",
                    json!({ "document_id": document.id }),
                )
            }
            ("s115", 5) => {
                let rows = in_folder(ctx, "Travel");
                self.answer(rows)
            }

            // s116 — an album, the place its frame was taken at, a document
            // about the same house, a detour and a write.
            ("s116", 2) => {
                let rows = like(ctx, App::Docs, Some("core.document"), "insurance");
                self.answer(rows)
            }
            ("s116", 3) => {
                let rows: Vec<VaultRow> = important_dates(ctx)
                    .into_iter()
                    .filter(|row| row.label.to_lowercase().contains("ray alvarez"))
                    .filter(|row| row.label.to_lowercase().contains("birthday"))
                    .collect();
                self.aside = rows.clone();
                Plan::Ids(ids(&rows))
            }
            ("s116", 4) => {
                let Some(title) = self.text_arg(turn, "title") else {
                    return unhandled();
                };
                Self::wrote(
                    ctx,
                    "knowledge.create_note",
                    json!({ "title": title, "body_text": "Test both of them.", "format": "plain" }),
                )
            }

            // s117 — two people in one conversation; the pronoun in the last
            // turn resolves to the SECOND, not to the one it opened on.
            ("s117", 0) => {
                let rows: Vec<VaultRow> = board(ctx, App::People)
                    .into_iter()
                    .filter(|row| row.entity == "core.activity")
                    .filter(|row| row.label.to_lowercase().contains("priya"))
                    .collect();
                self.aside = like(ctx, App::People, Some("core.party"), "priya raman");
                self.answer(rows)
            }
            ("s117", 1) => {
                let rows = self.aside.clone();
                let owed = owed_to_me_ids(&rows);
                if owed.is_empty() {
                    return unhandled();
                }
                self.held = rows;
                Plan::Ids(owed)
            }
            ("s117", 2) => {
                let Some(party) = self.held.first().cloned() else {
                    return unhandled();
                };
                Plan::Value(owed_to_me_total(ctx, &party))
            }
            ("s117", 3) => {
                let Some(party) = like(ctx, App::People, Some("core.party"), "ray alvarez")
                    .into_iter()
                    .next()
                else {
                    return unhandled();
                };
                let total = owed_to_me_total(ctx, &party);
                self.held = vec![party];
                Plan::Value(total)
            }

            // s118 — the trip thread, with a two-turn detour that does not
            // lose the album the third turn wrote into.
            ("s118", 1) => {
                let firsts: Vec<String> = self
                    .held
                    .iter()
                    .map(|row| {
                        row.label
                            .split_whitespace()
                            .next()
                            .unwrap_or_default()
                            .to_lowercase()
                    })
                    .collect();
                let rows: Vec<VaultRow> = board(ctx, App::Photos)
                    .into_iter()
                    .filter(|row| row.live && row.entity == "core.content_item")
                    .filter(|row| {
                        firsts
                            .iter()
                            .any(|first| row.label.to_lowercase().contains(first))
                    })
                    .collect();
                self.answer(rows)
            }
            ("s118", 4) | ("s120", 2) => {
                let rows = if session == "s118" {
                    like(ctx, App::Locker, Some("locker.item"), "emerald bay cabins")
                } else {
                    like(ctx, App::Agenda, Some("core.event"), "emerald bay")
                };
                self.answer(rows)
            }

            // s119 — two parties reached by SURNAME, narrowed by the row's own
            // label, followed into the calendar and back again.
            ("s119", 0) => {
                let family: Vec<String> = like(ctx, App::People, Some("core.party"), "ferreira")
                    .into_iter()
                    .filter(|row| row.live)
                    .map(|row| row.id)
                    .collect();
                let rows: Vec<VaultRow> = important_dates(ctx)
                    .into_iter()
                    .filter(|row| {
                        row.extra
                            .get("party_id")
                            .is_some_and(|party| family.contains(party))
                    })
                    .collect();
                self.answer(rows)
            }
            ("s119", 1) => {
                let rows: Vec<VaultRow> = self
                    .held
                    .iter()
                    .filter(|row| row.label.to_lowercase().contains("birthday"))
                    .cloned()
                    .collect();
                self.answer(rows)
            }
            ("s119", 2) | ("s120", 3) => {
                let event = if session == "s119" {
                    let Some(date) = self.held.first().and_then(|row| row.date.clone()) else {
                        return unhandled();
                    };
                    let day = date[..10].to_owned();
                    self.aside = between(ctx, App::Agenda, &day, &day);
                    self.aside.first().cloned()
                } else {
                    self.held.first().cloned()
                };
                let Some(event) = event else {
                    return unhandled();
                };
                let rows = parties_by_id(ctx, &attendees(&event));
                Plan::Ids(ids(&rows))
            }
            ("s119", 4) => {
                let rows: Vec<VaultRow> = important_dates(ctx)
                    .into_iter()
                    .filter(|row| row.label.to_lowercase().contains("ray alvarez"))
                    .filter(|row| row.label.to_lowercase().contains("birthday"))
                    .collect();
                self.answer(rows)
            }

            // s120 — one name across three apps, the guest list, and a write
            // that names the note the session opened on.
            ("s120", 0) => {
                let rows = like(ctx, App::Notes, Some("knowledge.note"), "emerald bay");
                self.aside = rows.clone();
                self.answer(rows)
            }
            ("s120", 4) => {
                let Some(title) = self.text_arg(turn, "title") else {
                    return unhandled();
                };
                Self::wrote(
                    ctx,
                    "schedule.add_task",
                    json!({ "title": title, "due_at": at(4, 9, 0) }),
                )
            }

            _ => unhandled(),
        }
    }
}

// ---------------------------------------------------------------------------
// The resolutions that more than one session needs.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE JOINS. Every one of them is an edge the vault actually holds — an
// attendee row, an obligation's party, a place id, an album's membership, a
// folder or a notebook. None of them matches a word across two apps, because
// a shared word is exactly what this world plants to be WRONG.
// ---------------------------------------------------------------------------

/// The parties invited to an event, by id.
fn attendees(event: &VaultRow) -> Vec<String> {
    event
        .extra
        .get("attendee_party_ids")
        .map(|held| held.split('\u{1f}').map(str::to_owned).collect())
        .unwrap_or_default()
}

/// The People rows those ids name, in the order the roster hands them back.
fn parties_by_id(ctx: &Context<'_>, wanted: &[String]) -> Vec<VaultRow> {
    board(ctx, App::People)
        .into_iter()
        .filter(|row| row.entity == "core.party" && row.live)
        .filter(|row| wanted.iter().any(|id| *id == row.id))
        .collect()
}

/// Who is coming to the cabin — the guest list of the check-in event.
fn cabin_guests(ctx: &Context<'_>) -> Vec<String> {
    board(ctx, App::Agenda)
        .into_iter()
        .find(|row| row.live && row.label.to_lowercase().contains("check-in"))
        .map(|event| attendees(&event))
        .unwrap_or_default()
}

/// The open obligations these parties owe the OWNER — the mirror of
/// [`debt_ids`], which reads the ones the owner owes them.
fn owed_to_me_ids(parties: &[VaultRow]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for party in parties.iter().filter(|row| row.live) {
        for id in party
            .extra
            .get("owed_to_me")
            .map(|held| held.split('\u{1f}'))
            .into_iter()
            .flatten()
        {
            if !id.is_empty() && !found.iter().any(|seen| seen == id) {
                found.push(id.to_owned());
            }
        }
    }
    found
}

/// What one party owes the owner, in minor units, read off the obligation
/// rows themselves rather than from any total the app computed.
fn owed_to_me_total(ctx: &Context<'_>, party: &VaultRow) -> f64 {
    party
        .extra
        .get("owed_to_me")
        .map(|held| held.split('\u{1f}'))
        .into_iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .filter_map(|id| {
            ctx.field("tally.obligation", id, "amount_minor")
                .ok()
                .flatten()
        })
        .filter_map(|value| value.parse::<f64>().ok())
        .sum()
}

/// The LIVE documents filed in one Docs folder.
fn in_folder(ctx: &Context<'_>, folder: &str) -> Vec<VaultRow> {
    board(ctx, App::Docs)
        .into_iter()
        .filter(|row| row.live && row.entity == "core.document")
        .filter(|row| extra_is(row, "folder", folder))
        .collect()
}

/// The live notes filed in one Notes notebook. A notebook and a folder may
/// share a NAME and hold different rows — the world seeds "Travel" and
/// "Health" as both, which is what a filed vault looks like.
fn in_notebook(ctx: &Context<'_>, notebook: &str) -> Vec<VaultRow> {
    board(ctx, App::Notes)
        .into_iter()
        .filter(|row| row.live && row.entity == "knowledge.note")
        .filter(|row| {
            row.extra
                .get("notebooks")
                .is_some_and(|held| held.split('\u{1f}').any(|name| name == notebook))
        })
        .collect()
}

/// The named place row, by its name.
fn place_named(ctx: &Context<'_>, name: &str) -> Option<VaultRow> {
    board(ctx, App::Photos)
        .into_iter()
        .find(|row| row.live && row.entity == "core.place" && row.label == name)
}

/// The live photographs whose PLACE is that row — the coordinate's own id,
/// never the word in a title.
fn photos_at(ctx: &Context<'_>, place_id: &str) -> Vec<VaultRow> {
    board(ctx, App::Photos)
        .into_iter()
        .filter(|row| row.live && row.entity == "core.content_item")
        .filter(|row| extra_is(row, "place_id", place_id))
        .collect()
}

/// Every live important date on the People shelf.
fn important_dates(ctx: &Context<'_>) -> Vec<VaultRow> {
    board(ctx, App::People)
        .into_iter()
        .filter(|row| row.live && row.entity == "people.important_date")
        .collect()
}

/// The trip window, as the CALENDAR defines it: check-in to check-out.
/// Discovered rather than constant — "while we're at the cabin" is a window
/// the member's own diary draws.
fn cabin_window(ctx: &Context<'_>) -> Option<(String, String)> {
    let events = board(ctx, App::Agenda);
    let day_of = |needle: &str| {
        events
            .iter()
            .find(|row| row.live && row.label.to_lowercase().contains(needle))
            .and_then(|row| row.date.clone())
            .map(|date| date[..10].to_owned())
    };
    Some((day_of("check-in")?, day_of("check-out")?))
}

/// The sum of a set of expenses, in minor units — read from each row's own
/// amount, never re-derived from a split.
fn total_minor(rows: &[VaultRow]) -> f64 {
    rows.iter()
        .filter(|row| row.entity == "tally.expense" && row.live)
        .filter_map(|row| row.extra.get("amount_minor"))
        .filter_map(|value| value.parse::<f64>().ok())
        .sum()
}

/// Every live expense spent in `month`, `YYYY-MM`.
fn in_month(ctx: &Context<'_>, month: &str) -> Vec<VaultRow> {
    board(ctx, App::Tally)
        .into_iter()
        .filter(|row| row.entity == "tally.expense" && row.live)
        .filter(|row| {
            row.date
                .as_deref()
                .is_some_and(|date| date.starts_with(month))
        })
        .collect()
}

/// Every live expense of the group whose name carries `needle`.
fn group_expenses(ctx: &Context<'_>, needle: &str) -> Vec<VaultRow> {
    let tally = board(ctx, App::Tally);
    let Some(group) = tally
        .iter()
        .find(|row| row.entity == "tally.group" && row.label.contains(needle))
        .map(|row| row.id.clone())
    else {
        return Vec::new();
    };
    tally
        .into_iter()
        .filter(|row| {
            row.entity == "tally.expense" && row.live && extra_is(row, "group_id", &group)
        })
        .collect()
}

/// What one trip member still owes the member: their share of everything they
/// did not pay for, less what they have already settled.
fn owed_by(ctx: &Context<'_>, name: &str) -> Option<f64> {
    let tally = board(ctx, App::Tally);
    let party = tally
        .iter()
        .find(|row| row.entity == "core.party" && row.label == name)
        .map(|row| row.id.clone())?;
    let key = format!("split:{party}");
    let mut owed = 0.0_f64;
    for expense in trip_expenses(ctx) {
        let share = expense
            .extra
            .get(&key)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or_default();
        let total = expense
            .extra
            .get("amount_minor")
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or_default();
        // A NET, not a gross. What they owe on everything somebody else paid
        // for, LESS what everybody else owes them on what they paid for. A
        // candidate that answered the gross would be out by exactly the one
        // expense this member covered.
        if extra_is(&expense, "paid_by", &party) {
            owed -= total - share;
        } else {
            owed += share;
        }
    }
    // LESS WHAT THEY HAVE ALREADY PAID BACK. The world seeds one settlement
    // precisely so that a candidate which stops at the share is wrong by it.
    for settlement in tally.iter().filter(|row| row.entity == "tally.settlement") {
        if extra_is(settlement, "from_party", &party) {
            owed -= settlement
                .extra
                .get("amount_minor")
                .and_then(|value| value.parse::<f64>().ok())
                .unwrap_or_default();
        }
    }
    Some(owed)
}

/// What is still outstanding across every open obligation.
fn outstanding_debt(ctx: &Context<'_>) -> Option<f64> {
    let mut total = 0.0_f64;
    let mut found = false;
    for person in board(ctx, App::People) {
        let Some(debts) = person.extra.get("owed_to_them") else {
            continue;
        };
        for debt in debts.split('\u{1f}') {
            let amount = ctx
                .field("tally.obligation", debt, "amount_minor")
                .ok()
                .flatten()
                .and_then(|value| value.parse::<f64>().ok())?;
            total += amount;
            found = true;
        }
    }
    found.then_some(total)
}

/// The most recent logged touch with one person.
fn last_touch(ctx: &Context<'_>, name: &str) -> Vec<VaultRow> {
    let people = board(ctx, App::People);
    let Some(party) = people
        .iter()
        .find(|row| row.entity == "core.party" && row.label == name)
        .map(|row| row.id.clone())
    else {
        return Vec::new();
    };
    let mut touches: Vec<VaultRow> = people
        .into_iter()
        .filter(|row| row.entity == "core.activity" && extra_is(row, "party_id", &party))
        .collect();
    touches.sort_by(|left, right| right.date.cmp(&left.date));
    touches.into_iter().take(1).collect()
}

/// The live expenses filed against the trip group.
fn trip_expenses(ctx: &Context<'_>) -> Vec<VaultRow> {
    let tally = board(ctx, App::Tally);
    let Some(group) = tally
        .iter()
        .find(|row| row.entity == "tally.group" && row.label.contains("Tahoe"))
        .map(|row| row.id.clone())
    else {
        return Vec::new();
    };
    tally
        .into_iter()
        .filter(|row| {
            row.entity == "tally.expense" && row.live && extra_is(row, "group_id", &group)
        })
        .collect()
}

/// The trip group's expenses one member paid for.
fn paid_by_in_trip(ctx: &Context<'_>, name: &str) -> Vec<VaultRow> {
    let tally = board(ctx, App::Tally);
    let Some(payer) = tally
        .iter()
        .find(|row| row.entity == "core.party" && row.label == name)
        .map(|row| row.id.clone())
    else {
        return Vec::new();
    };
    trip_expenses(ctx)
        .into_iter()
        .filter(|row| extra_is(row, "paid_by", &payer))
        .collect()
}

/// The photographs of one album, by the album's title.
fn in_album(ctx: &Context<'_>, title: &str) -> Vec<VaultRow> {
    board(ctx, App::Photos)
        .into_iter()
        .filter(|row| row.live && row.entity == "core.content_item")
        .filter(|row| {
            row.extra
                .get("album_titles")
                .is_some_and(|titles| titles.split('\u{1f}').any(|held| held == title))
        })
        .collect()
}

/// **WHEN THE TAHOE TRIP WAS, read out of the vault.**
///
/// "From the trip" used to compile to three hard-coded days, in the reference
/// and in nothing else: a candidate could only pass `s29` and `s68` by already
/// knowing the answer, which is not a window, it is the expectation written
/// twice. The trip is not an event, an album or a memory in this vault — but
/// the member kept two records of it, and both are dated. It ran from the
/// first thing spent on the **Tahoe Trip** group to the last frame filed in
/// the **Tahoe scouting** album.
///
/// Neither anchor would do on its own: the ledger stops two days before the
/// last photograph, and the album holds three of the four frames the question
/// answers. Their span holds all four — including "Ana at the trailhead",
/// which is in neither anchor, so the derivation genuinely reaches a row it
/// was not handed.
fn trip_window(ctx: &Context<'_>) -> Option<(String, String)> {
    let tally = board(ctx, App::Tally);
    let group = tally
        .iter()
        .find(|row| row.entity == "tally.group" && row.label.contains("Tahoe"))
        .map(|row| row.id.clone())?;
    let mut days: Vec<String> = tally
        .iter()
        .filter(|row| row.entity == "tally.expense" && extra_is(row, "group_id", &group))
        .filter_map(|row| row.date.as_deref().map(|date| date[..10].to_owned()))
        .collect();
    days.extend(
        in_album(ctx, "Tahoe scouting")
            .iter()
            .filter_map(|row| row.date.as_deref().map(|date| date[..10].to_owned())),
    );
    days.sort();
    Some((days.first()?.clone(), days.last()?.clone()))
}

/// **THE OPEN DEBTS THESE PARTIES CARRY** — the answer to "do I owe X
/// anything", which is the obligation and not the person.
///
/// People's own reader is the only one in the tree that reads Tally's
/// obligation table, and it hands a party its OPEN obligations back as
/// `owed_to_them`. A party that carries none contributes nothing, which is why
/// "Neha" resolves at all: exactly one of the three is owed anything.
fn debt_ids(parties: &[VaultRow]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for party in parties.iter().filter(|row| row.live) {
        for id in party
            .extra
            .get("owed_to_them")
            .map(|held| held.split('\u{1f}'))
            .into_iter()
            .flatten()
        {
            if !id.is_empty() && !found.iter().any(|seen| seen == id) {
                found.push(id.to_owned());
            }
        }
    }
    found
}

/// The frames from the scouting trip: they carry a place AND were taken during
/// the trip's own days. Both halves are needed — the roll holds two frames from
/// home with a place, and one with no place at all.
fn trip_photos(ctx: &Context<'_>) -> Vec<VaultRow> {
    let Some((from, to)) = trip_window(ctx) else {
        return Vec::new();
    };
    board(ctx, App::Photos)
        .into_iter()
        .filter(|row| row.live && row.entity == "core.content_item")
        .filter(|row| row.extra.contains_key("place_id"))
        .filter(|row| {
            row.date
                .as_deref()
                .is_some_and(|date| date[..10] >= *from && date[..10] <= *to)
        })
        .collect()
}

/// The frames from home — the same roll's other cluster, which is what makes
/// "from the trip" a filter rather than "all of them".
/// The frames taken at the place called "Home".
///
/// This used to be *every placed frame that is not on the trip*, which is not a
/// definition of home — it is an artefact of a world holding ten photographs,
/// and the first five-thousand-row build handed it four hundred extra rows.
/// Home is a place, the world names it, and a place row's id is what the
/// assets carry.
fn home_photos(ctx: &Context<'_>) -> Vec<VaultRow> {
    let board = board(ctx, App::Photos);
    let Some(home) = board
        .iter()
        .find(|row| row.entity == "core.place" && row.label == "Home")
        .map(|row| row.id.clone())
    else {
        return Vec::new();
    };
    board
        .into_iter()
        .filter(|row| row.live && row.entity == "core.content_item")
        .filter(|row| row.extra.get("place_id") == Some(&home))
        .collect()
}

/// One day, across the calendar and the board — what "what's on Wednesday"
/// means when the answer is three rows in two apps.
fn day_across_apps(ctx: &Context<'_>, day: &str) -> Vec<VaultRow> {
    let mut rows = between(ctx, App::Agenda, day, day);
    rows.extend(
        between(ctx, App::Tasks, day, day)
            .into_iter()
            .filter(|row| !extra_is(row, "status", "completed")),
    );
    rows
}

/// Every live row in the vault whose label carries `needle`, app by app.
///
/// Deliberately NOT the search plane alone: Locker is structurally absent from
/// it, and a place has no text index either, so an answer assembled only from
/// FTS would be missing two of the five rows this is asked about.
fn everything_about(ctx: &Context<'_>, needle: &str) -> Vec<VaultRow> {
    let mut rows = Vec::new();
    for app in App::all() {
        rows.extend(like(ctx, app, None, needle));
    }
    // A photograph's place is a row of Photos and so is the photograph; both
    // may match, and both are answers.
    rows.sort_by(|left, right| left.id.cmp(&right.id));
    rows.dedup_by(|left, right| left.id == right.id);
    rows
}

/// Log a call against the person named in full.
fn log_call(ctx: &mut Context<'_>, name: &str) -> Plan {
    let Some(party) = like(ctx, App::People, Some("core.party"), name)
        .into_iter()
        .find(|row| row.label == name)
    else {
        return clarify();
    };
    ReferenceSession::wrote(
        ctx,
        "people.log_interaction",
        json!({ "party_id": party.id, "kind": "call" }),
    )
}

/// The calendar `Vault::found` minted — discovered, never guessed: a vault
/// founded by an older build has none, and a guessed id writes into nothing.
fn calendar(ctx: &Context<'_>) -> String {
    board(ctx, App::Agenda)
        .into_iter()
        .find_map(|row| row.extra.get("calendar_id").cloned())
        .unwrap_or_default()
}

/// `YYYY-MM` of the month before the one `today` falls in.
fn previous_month(today: &str) -> String {
    let (year, month) = (
        today[..4].parse::<i32>().unwrap_or(0),
        today[5..7].parse::<i32>().unwrap_or(1),
    );
    if month == 1 {
        format!("{}-12", year - 1)
    } else {
        format!("{year}-{:02}", month - 1)
    }
}

/// The same wall-clock day, one hour later.
fn shift_an_hour(stamp: &str) -> String {
    let hour = stamp[11..13].parse::<i64>().unwrap_or(0);
    format!("{}T{:02}{}", &stamp[..10], hour + 1, &stamp[13..])
}
