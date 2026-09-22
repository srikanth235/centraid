//! # Null and crippled candidates — measuring instruments, not systems
//!
//! The reference scores 129/129. That proves every case is REACHABLE. It does
//! not prove the suite has **discriminating power**: a suite where a system
//! that does nothing intelligent also scores well is not measuring anything.
//!
//! Everything here exists to be scored badly, on purpose. Two groups:
//!
//! * **Degenerate floors** — `AlwaysClarify`, `AlwaysRefuse`, `Empty`,
//!   `EverythingOfEntity`, `Stateless`, `NeverClarify`, `IgnoresSoftDelete`.
//!   What a candidate buys for free. Every turn one of these passes is a turn
//!   the suite cannot score.
//! * **Architecturally crippled** — `SearchOnly` (may call only
//!   [`crate::Context::search`]) and `BoardOnly` (may call only [`crate::Context::open`]).
//!   These are NOT strawmen: each is the best thing buildable from a bag of
//!   keywords under its restriction, and the gap between them estimates what
//!   fraction of real requests are content-anchored versus filter-only.
//!
//! ## What these are not
//!
//! None of them understands language. The shared core is a stopword filter and
//! a keyword-overlap count, plus — for the board door only — a handful of
//! literal temporal phrases. There is no attempt at a product-shaped
//! resolution here and there must not be: an instrument that tried to be right
//! would stop measuring how much a suite rewards being wrong.
//!
//! ## The one asymmetry worth naming up front
//!
//! [`crate::Context::search`] returns rows with `date: None`. A search-only system
//! therefore cannot filter by time AT ALL — not because this file crippled it
//! further, but because the FTS door carries no date. That is the measurement,
//! not a handicap added to it.

use std::collections::BTreeSet;

use crate::reference::Reference;
use crate::{App, Candidate, CandidateRuntime, Context, Expected, Plan, Session, VaultRow};
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// Shared vocabulary machinery. Deliberately dumb.
// ---------------------------------------------------------------------------

const STOPWORDS: &[&str] = &[
    "the",
    "and",
    "for",
    "are",
    "was",
    "were",
    "you",
    "your",
    "our",
    "his",
    "her",
    "its",
    "with",
    "that",
    "this",
    "those",
    "these",
    "what",
    "whats",
    "when",
    "whens",
    "where",
    "which",
    "who",
    "how",
    "why",
    "did",
    "does",
    "do",
    "done",
    "can",
    "cant",
    "could",
    "would",
    "should",
    "have",
    "has",
    "had",
    "get",
    "got",
    "got",
    "put",
    "any",
    "anything",
    "something",
    "some",
    "all",
    "one",
    "ones",
    "two",
    "there",
    "here",
    "about",
    "from",
    "into",
    "onto",
    "off",
    "out",
    "over",
    "under",
    "again",
    "just",
    "only",
    "also",
    "not",
    "no",
    "yes",
    "but",
    "than",
    "then",
    "too",
    "very",
    "much",
    "many",
    "more",
    "most",
    "less",
    "few",
    "own",
    "same",
    "such",
    "both",
    "each",
    "other",
    "another",
    "been",
    "being",
    "will",
    "wont",
    "need",
    "needs",
    "want",
    "wants",
    "like",
    "make",
    "made",
    "take",
    "took",
    "give",
    "show",
    "tell",
    "say",
    "said",
    "know",
    "think",
    "see",
    "look",
    "find",
    "please",
    "actually",
    "really",
    "still",
    "yet",
    "ever",
    "never",
    "always",
    "okay",
    "ok",
    "well",
    "now",
    "thing",
    "things",
    "stuff",
    "one",
    "me",
    "my",
    "mine",
    "i",
    "im",
    "ive",
    "a",
    "an",
    "of",
    "in",
    "on",
    "at",
    "to",
    "is",
    "it",
    "be",
    "by",
    "as",
    "or",
    "if",
    "so",
    "up",
    "we",
    "us",
    "he",
    "she",
    "they",
    "them",
    "their",
];

/// Words that only ever mean "the thing we were just talking about".
const DEICTIC: &[&str] = &[
    "it", "that", "those", "them", "she", "he", "her", "him", "they", "there", "first", "second",
    "third", "last", "other", "same", "one",
];

fn words(request: &str) -> Vec<String> {
    request
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .map(|word| word.trim_matches('\'').to_owned())
        .filter(|word| !word.is_empty())
        .collect()
}

/// The words a keyword system would actually look things up by.
fn content_words(request: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    words(request)
        .into_iter()
        .filter(|word| word.len() >= 3)
        .filter(|word| !STOPWORDS.contains(&word.as_str()))
        .filter(|word| seen.insert(word.clone()))
        .collect()
}

/// True when the request leans on the conversation rather than on any noun.
fn is_deictic(request: &str) -> bool {
    let all = words(request);
    let deictic = all.iter().any(|word| DEICTIC.contains(&word.as_str()));
    deictic && content_words(request).len() <= 1
}

/// How many distinct request words this row's visible text contains.
/// A bare id, which must never be keyword-matchable.
///
/// `Context::search` now carries a photograph's original `content_id` in
/// `extra`. A 36-character hex id contains plenty of three-letter substrings
/// ("cab", "bed", "ace"), so folding one into the haystack would score rows by
/// coincidence. It is excluded, not because ids are uninteresting, but because
/// a match against one is never a match a member meant.
fn looks_like_an_id(value: &str) -> bool {
    value.len() == 36 && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn score_row(row: &VaultRow, needles: &[String]) -> usize {
    let mut hay = row.label.to_lowercase();
    for value in row.extra.values() {
        if looks_like_an_id(value) {
            continue;
        }
        hay.push(' ');
        hay.push_str(&value.to_lowercase());
    }
    needles
        .iter()
        .filter(|needle| hay.contains(needle.as_str()))
        .count()
}

/// The rows that matched the most request words. Empty when nothing matched.
///
/// **This is a max-score CUT, and that is why it may only ever be applied to
/// ONE door's pool.** Applied to a merged pool it is not a union: a board row
/// that scores higher raises the bar and silently deletes a row only the
/// search door found. That defect made `KeywordBoth` score *below* the union
/// of its own doors and invalidated a headline; see [`Doors::Both`].
fn best_matches(rows: Vec<VaultRow>, needles: &[String]) -> Vec<VaultRow> {
    let mut scored: Vec<(usize, VaultRow)> = rows
        .into_iter()
        .map(|row| (score_row(&row, needles), row))
        .filter(|(score, _)| *score > 0)
        .collect();
    let best = scored.iter().map(|(score, _)| *score).max().unwrap_or(0);
    scored.retain(|(score, _)| *score == best);
    scored.into_iter().map(|(_, row)| row).collect()
}

fn dedup(rows: Vec<VaultRow>) -> Vec<VaultRow> {
    let mut seen = BTreeSet::new();
    rows.into_iter()
        .filter(|row| seen.insert(row.id.clone()))
        .collect()
}

fn ids(rows: &[VaultRow]) -> Vec<String> {
    rows.iter().map(|row| row.id.clone()).collect()
}

/// The seven FTS domains. Locker is absent on purpose — that absence is the
/// product constraint `SearchOnly` exists to price.
const DOMAINS: &[&str] = &[
    "knowledge.note",
    "core.party",
    "core.event",
    "schedule.task",
    "tally.expense",
    "core.content_item",
    "core.document",
];

/// Every hit for every content word, across every domain.
fn search_all(ctx: &Context<'_>, needles: &[String]) -> Vec<VaultRow> {
    let mut found = Vec::new();
    for domain in DOMAINS {
        for needle in needles {
            if let Ok(rows) = ctx.search(domain, needle, 25) {
                found.extend(rows);
            }
        }
    }
    dedup(found)
}

/// Every row of every board.
fn board_all(ctx: &Context<'_>) -> Vec<VaultRow> {
    let mut found = Vec::new();
    for app in App::all() {
        if let Ok(rows) = ctx.open(app) {
            found.extend(rows);
        }
    }
    dedup(found)
}

/// The app a bag of words most plausibly names.
fn plausible_app(request: &str) -> App {
    const HINTS: &[(App, &[&str])] = &[
        (
            App::Photos,
            &[
                "photo", "photos", "picture", "pictures", "album", "frame", "shot",
            ],
        ),
        (
            App::Tally,
            &[
                "spend", "spent", "spending", "cost", "expense", "expenses", "owe", "owed", "paid",
                "pay", "settle", "balance", "split", "money", "budget",
            ],
        ),
        (
            App::Tasks,
            &[
                "task", "tasks", "todo", "due", "overdue", "finish", "deadline", "chore", "errand",
            ],
        ),
        (App::Notes, &["note", "notes", "wrote", "jot", "shortlist"]),
        (
            App::Locker,
            &[
                "password",
                "passwords",
                "login",
                "logins",
                "secret",
                "credential",
                "locker",
                "rotate",
                "rotated",
                "pin",
            ],
        ),
        (
            App::Docs,
            &[
                "document",
                "documents",
                "doc",
                "docs",
                "agreement",
                "contract",
                "pdf",
                "permit",
                "receipt",
                "policy",
            ],
        ),
        (
            App::People,
            &[
                "call", "called", "text", "contact", "birthday", "phone", "email", "person",
                "people", "friend",
            ],
        ),
        (
            App::Agenda,
            &[
                "event",
                "events",
                "calendar",
                "meeting",
                "appointment",
                "schedule",
                "booked",
            ],
        ),
    ];
    let bag = words(request);
    let mut best = (0_usize, App::Agenda);
    for (app, hints) in HINTS {
        let hits = bag
            .iter()
            .filter(|word| hints.contains(&word.as_str()))
            .count();
        if hits > best.0 {
            best = (hits, *app);
        }
    }
    best.1
}

// ---------------------------------------------------------------------------
// Dates, for the board door only.
// ---------------------------------------------------------------------------

/// Days since an arbitrary epoch, for a `YYYY-MM-DD`.
fn day_number(date: &str) -> i64 {
    let year: i64 = date[0..4].parse().unwrap_or(2000);
    let month: i64 = date[5..7].parse().unwrap_or(1);
    let day: i64 = date[8..10].parse().unwrap_or(1);
    let adjusted_year = if month <= 2 { year - 1 } else { year };
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn from_day_number(mut days: i64) -> String {
    days += 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = month_index + if month_index < 10 { 3 } else { -9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}")
}

/// 0 = Monday.
fn weekday(date: &str) -> i64 {
    (day_number(date) + 3).rem_euclid(7)
}

/// The literal window a handful of stock phrases name. Nothing clever: a real
/// temporal parser is a system, and this file does not build systems.
fn window(request: &str, today: &str) -> Option<(String, String)> {
    let text = request.to_lowercase();
    let now = day_number(today);
    let weekday_now = weekday(today);
    let monday = now - weekday_now;
    let names = [
        ("monday", 0_i64),
        ("tuesday", 1),
        ("wednesday", 2),
        ("thursday", 3),
        ("friday", 4),
        ("saturday", 5),
        ("sunday", 6),
    ];
    let day = |offset: i64| {
        let text = from_day_number(offset);
        Some((text.clone(), text))
    };
    if text.contains("next week") {
        return Some((from_day_number(monday + 7), from_day_number(monday + 13)));
    }
    if text.contains("this week") || text.contains("rest of the week") {
        return Some((today.to_owned(), from_day_number(monday + 6)));
    }
    if text.contains("weekend") {
        return Some((from_day_number(monday + 5), from_day_number(monday + 6)));
    }
    if text.contains("tomorrow") {
        return day(now + 1);
    }
    if text.contains("yesterday") {
        return day(now - 1);
    }
    if text.contains("today") || text.contains("rest of the day") || text.contains("tonight") {
        return day(now);
    }
    if text.contains("overdue") {
        return Some(("1970-01-01".to_owned(), from_day_number(now - 1)));
    }
    if text.contains("next month") {
        return Some((from_day_number(now + 1), from_day_number(now + 45)));
    }
    for (name, index) in names {
        if text.contains(name) {
            let mut target = monday + index;
            if target < now {
                target += 7;
            }
            return day(target);
        }
    }
    None
}

fn in_window(row: &VaultRow, from: &str, to: &str) -> bool {
    row.date
        .as_deref()
        .is_some_and(|date| &date[..10] >= from && &date[..10] <= to)
}

// ---------------------------------------------------------------------------
// The degenerate floors.
// ---------------------------------------------------------------------------

/// A candidate that answers the same thing to everything.
struct Fixed(Plan);

impl Candidate for Fixed {
    fn turn(&mut self, _request: &str, _ctx: &mut Context<'_>) -> Plan {
        self.0.clone()
    }
}

/// Declines every single turn with one reason.
pub struct AlwaysDecline(pub &'static str, &'static str);

impl AlwaysDecline {
    #[must_use]
    pub const fn clarify() -> Self {
        Self("clarify", "AlwaysClarify")
    }
    #[must_use]
    pub const fn refuse() -> Self {
        Self("refuse", "AlwaysRefuse")
    }
}

impl CandidateRuntime for AlwaysDecline {
    fn name(&self) -> &str {
        self.1
    }
    fn session(&self, _session: &Session) -> Box<dyn Candidate> {
        Box::new(Fixed(Plan::Declined {
            reason: self.0.to_owned(),
        }))
    }
}

/// Answers "nothing" to every turn.
pub struct Empty;

impl CandidateRuntime for Empty {
    fn name(&self) -> &str {
        "Empty"
    }
    fn session(&self, _session: &Session) -> Box<dyn Candidate> {
        Box::new(Fixed(Plan::Ids(Vec::new())))
    }
}

/// Returns every live row of the app the request most plausibly names.
///
/// The "return the whole table" floor. A case it passes is a case with only
/// one plausible row in its app.
pub struct EverythingOfEntity;

struct EverythingSession;

impl Candidate for EverythingSession {
    fn turn(&mut self, request: &str, ctx: &mut Context<'_>) -> Plan {
        let app = plausible_app(request);
        let rows: Vec<VaultRow> = ctx
            .open(app)
            .unwrap_or_default()
            .into_iter()
            .filter(|row| row.live)
            .collect();
        Plan::Ids(ids(&rows))
    }
}

impl CandidateRuntime for EverythingOfEntity {
    fn name(&self) -> &str {
        "EverythingOfEntity"
    }
    fn session(&self, _session: &Session) -> Box<dyn Candidate> {
        Box::new(EverythingSession)
    }
}

// ---------------------------------------------------------------------------
// The keyword core the informative candidates share.
// ---------------------------------------------------------------------------

/// Which doors a keyword candidate is allowed to touch.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Doors {
    /// Both — and **by construction the UNION of the other two**.
    ///
    /// It has to be computed as a union of two independently-run pipelines
    /// rather than as one pipeline over a merged pool, because the max-score
    /// cut in [`best_matches`] is not monotone: pooling the doors first let a
    /// high-scoring board row evict a row only the FTS door could reach, so
    /// `Both` returned strictly less than `Search` on at least one turn. A
    /// "both doors" column that is not an upper bound on either door cannot
    /// support any claim about what a door contributes, which is the entire
    /// reason this variant exists.
    Both,
    /// `Context::search` only.
    Search,
    /// `Context::open` only.
    Board,
}

/// Knobs that turn the core into one particular defect.
#[derive(Clone, Copy)]
pub struct Flaw {
    /// Ignore `Context::history()` entirely.
    pub stateless: bool,
    /// Never decline; always commit to the first guess.
    pub never_decline: bool,
    /// Keep trashed rows in the answer.
    pub keep_trashed: bool,
}

impl Flaw {
    const NONE: Self = Self {
        stateless: false,
        never_decline: false,
        keep_trashed: false,
    };
}

/// A keyword-overlap candidate, restricted and flawed to order.
pub struct Keyword {
    name: &'static str,
    doors: Doors,
    flaw: Flaw,
}

impl Keyword {
    #[must_use]
    pub const fn new(name: &'static str, doors: Doors, flaw: Flaw) -> Self {
        Self { name, doors, flaw }
    }
    /// Ignores the conversation.
    #[must_use]
    pub const fn stateless() -> Self {
        Self::new(
            "Stateless",
            Doors::Both,
            Flaw {
                stateless: true,
                ..Flaw::NONE
            },
        )
    }
    /// Always commits, never asks.
    #[must_use]
    pub const fn never_clarify() -> Self {
        Self::new(
            "NeverClarify",
            Doors::Both,
            Flaw {
                never_decline: true,
                ..Flaw::NONE
            },
        )
    }
    /// Reasonable, but keeps trashed rows.
    #[must_use]
    pub const fn ignores_soft_delete() -> Self {
        Self::new(
            "IgnoresSoftDelete",
            Doors::Both,
            Flaw {
                keep_trashed: true,
                ..Flaw::NONE
            },
        )
    }
    /// The best system buildable out of the FTS door alone.
    #[must_use]
    pub const fn search_only() -> Self {
        Self::new("SearchOnly", Doors::Search, Flaw::NONE)
    }
    /// The best system buildable out of the app boards alone.
    #[must_use]
    pub const fn board_only() -> Self {
        Self::new("BoardOnly", Doors::Board, Flaw::NONE)
    }
    /// Both doors, no extra defect — the ceiling of keyword overlap itself.
    #[must_use]
    pub const fn both() -> Self {
        Self::new("KeywordBoth", Doors::Both, Flaw::NONE)
    }
}

impl CandidateRuntime for Keyword {
    fn name(&self) -> &str {
        self.name
    }
    fn session(&self, _session: &Session) -> Box<dyn Candidate> {
        Box::new(KeywordSession {
            doors: self.doors,
            flaw: self.flaw,
            held: Vec::new(),
        })
    }
}

struct KeywordSession {
    doors: Doors,
    flaw: Flaw,
    /// The ids the last answer named — the only conversation state there is.
    held: Vec<String>,
}

impl KeywordSession {
    fn keep(&self, rows: Vec<VaultRow>) -> Vec<VaultRow> {
        if self.flaw.keep_trashed {
            rows
        } else {
            rows.into_iter().filter(|row| row.live).collect()
        }
    }

    fn give_up(&self, request: &str, ctx: &Context<'_>) -> Plan {
        if self.flaw.never_decline {
            // COMMIT TO SOMETHING. The whole point of this defect is that it
            // would rather be confidently wrong than ask.
            let app = plausible_app(request);
            let rows = self.keep(ctx.open(app).unwrap_or_default());
            Plan::Ids(ids(&rows))
        } else {
            Plan::Declined {
                reason: "clarify".to_owned(),
            }
        }
    }
}

impl KeywordSession {
    /// ONE door's whole answer, end to end.
    ///
    /// The max-score cut lives here, inside a single door's pool, and never
    /// spans two — see [`Doors::Both`].
    fn through(
        &self,
        door: Doors,
        request: &str,
        needles: &[String],
        ctx: &Context<'_>,
    ) -> Vec<VaultRow> {
        // The board door can filter by time; the FTS door returns rows with no
        // date at all, so a search-only system structurally cannot.
        if door == Doors::Board
            && let Some((from, to)) = window(request, ctx.today())
        {
            {
                let rows: Vec<VaultRow> = self
                    .keep(board_all(ctx))
                    .into_iter()
                    .filter(|row| in_window(row, &from, &to))
                    .collect();
                if !rows.is_empty() {
                    return rows;
                }
            }
        }
        if needles.is_empty() {
            return Vec::new();
        }
        let pool = match door {
            Doors::Search => search_all(ctx, needles),
            _ => board_all(ctx),
        };
        best_matches(self.keep(pool), needles)
    }
}

impl Candidate for KeywordSession {
    fn turn(&mut self, request: &str, ctx: &mut Context<'_>) -> Plan {
        let needles = content_words(request);

        // The conversation, where this candidate has one: a request that is
        // all pronoun repeats the last answer. Crude, and that is the point —
        // `Stateless` differs from the rest by exactly this block.
        if !self.flaw.stateless
            && is_deictic(request)
            && let Some(last) = ctx.history().last()
            && let Plan::Ids(previous) = &last.plan
            && !previous.is_empty()
        {
            self.held.clone_from(previous);
            return Plan::Ids(previous.clone());
        }

        let rows = match self.doors {
            Doors::Search | Doors::Board => self.through(self.doors, request, &needles, ctx),
            // THE UNION, and nothing but. Each door answers on its own and the
            // two answers are concatenated, so `Both` cannot return less than
            // either door alone.
            Doors::Both => {
                let mut rows = self.through(Doors::Board, request, &needles, ctx);
                rows.extend(self.through(Doors::Search, request, &needles, ctx));
                dedup(rows)
            }
        };

        if rows.is_empty() {
            return self.give_up(request, ctx);
        }
        self.held = ids(&rows);
        Plan::Ids(self.held.clone())
    }
}

// ---------------------------------------------------------------------------
// The WRITING instruments (DEFECT #16).
// ---------------------------------------------------------------------------
//
// Every instrument above this line answers rows or declines, so for two
// releases nothing in this file ever executed a command — and a write turn was
// therefore scored against a floor of ZERO candidates. The suite's write half
// had never been shown to tell good from bad at all.
//
// These three are the three ways a write goes wrong, and each must score 0 on
// every write turn in the suite AND in the blind set:
//
// * it did not happen (`ClaimsWroteDoesNothing`);
// * it happened to the wrong row (`WrongRowWriter`);
// * it happened, and so did four other things (`CollateralDamage`).
//
// The first is what a candidate that narrates looks like. The second is the
// failure the three Nehas and the two "Book the Tahoe cabin" rows exist to
// price. The third is the one a predicate alone structurally cannot see, and
// the reason the changed-row set is scored beside it.

/// **SAYS IT WROTE. WRITES NOTHING.**
///
/// The honest name for a runtime that returns a confident sentence and
/// touches no row. It answers [`Plan::Wrote`] to every turn and never calls
/// [`crate::Context::write`], so any write turn it passes is a turn satisfied by the
/// SEEDED WORLD rather than by the candidate — DEFECT #4's shape, as a
/// standing instrument rather than a one-off audit.
pub struct ClaimsWroteDoesNothing;

impl CandidateRuntime for ClaimsWroteDoesNothing {
    fn name(&self) -> &str {
        "ClaimsWroteDoesNothing"
    }
    fn session(&self, _session: &Session) -> Box<dyn Candidate> {
        Box::new(Fixed(Plan::Wrote))
    }
}

/// **THE RIGHT COMMAND. THE WRONG ROW.**
///
/// It knows exactly which command the outcome needs — it reads the case's own
/// predicate — and aims it at the highest keyword-scoring OTHER live row of
/// the same table. That makes it strictly harder to catch than a random
/// writer: on "log that I called Neha", the row it picks is the other Neha.
///
/// A turn this passes is a turn whose predicate does not actually check WHICH
/// row moved.
pub struct WrongRowWriter;

struct WrongRowSession {
    wants: Vec<Expected>,
    turn: usize,
}

/// The first write a turn expects, as `(predicate, args)`.
fn first_write(expected: &Expected) -> Option<(&str, &serde_json::Map<String, Value>)> {
    match expected {
        Expected::Write { predicate, args } => Some((predicate.as_str(), args)),
        Expected::WriteSet { writes, .. } => writes
            .first()
            .map(|write| (write.predicate.as_str(), &write.args)),
        _ => None,
    }
}

fn arg<'a>(args: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// The best keyword match among the live rows of `entity` on `app`'s board
/// that is NOT `avoid`.
fn other_row(
    ctx: &Context<'_>,
    app: App,
    entity: &str,
    avoid: Option<&str>,
    needles: &[String],
) -> Option<VaultRow> {
    let mut rows: Vec<VaultRow> = ctx
        .open(app)
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.live && row.entity == entity)
        .filter(|row| Some(row.id.as_str()) != avoid)
        .collect();
    rows.sort_by_key(|row| std::cmp::Reverse(score_row(row, needles)));
    rows.into_iter().next()
}

impl WrongRowSession {
    /// The command the outcome needs, aimed one row to the left.
    #[expect(
        clippy::too_many_lines,
        reason = "one arm per write predicate — the table IS the instrument"
    )]
    fn misfire(
        request: &str,
        expected: &Expected,
        ctx: &Context<'_>,
    ) -> Option<(&'static str, Value)> {
        let (predicate, args) = first_write(expected)?;
        let needles = content_words(request);
        let me = ctx.me().to_owned();
        let today = ctx.today().to_owned();

        // `(app, entity, the row the case names)` — the table the right
        // command would have touched, and the row it must NOT touch.
        let aimed = |ctx: &Context<'_>, app: App, entity: &str, key: &str| {
            other_row(ctx, app, entity, arg(args, key), &needles)
        };

        let (command, body) = match predicate {
            "task_completed" => {
                let row = aimed(ctx, App::Tasks, "schedule.task", "id")?;
                (
                    "schedule.set_task_status",
                    json!({ "task_id": row.id, "status": "completed" }),
                )
            }
            "task_rescheduled" => {
                let row = aimed(ctx, App::Tasks, "schedule.task", "id")?;
                (
                    "schedule.edit_task",
                    json!({ "task_id": row.id, "due_at": args.get("to") }),
                )
            }
            "task_trashed" => {
                let row = aimed(ctx, App::Tasks, "schedule.task", "id")?;
                ("schedule.trash_task", json!({ "task_id": row.id }))
            }
            "event_rescheduled" | "event_cancelled" => {
                let row = aimed(ctx, App::Agenda, "core.event", "id")?;
                let start = row.date.clone().unwrap_or_default();
                (
                    "schedule.reschedule_event",
                    json!({ "event_id": row.id, "dtstart": start }),
                )
            }
            "document_trashed" => {
                let row = aimed(ctx, App::Docs, "core.document", "id")?;
                ("core.trash_document", json!({ "document_id": row.id }))
            }
            "document_starred" => {
                let row = aimed(ctx, App::Docs, "core.document", "id")?;
                ("core.star_document", json!({ "document_id": row.id }))
            }
            "photo_added_to_album" => {
                let row = aimed(ctx, App::Photos, "core.content_item", "id")?;
                (
                    "media.add_to_album",
                    json!({ "album_id": arg(args, "album_id"), "asset_id": row.id }),
                )
            }
            "locker_field_revealed" => {
                let row = aimed(ctx, App::Locker, "locker.item", "id")?;
                (
                    "locker.reveal_receipt",
                    json!({
                        "object_type": "locker.item",
                        "item_id": row.id,
                        "columns": ["password"],
                    }),
                )
            }
            "interaction_logged" | "no_interaction_logged" => {
                let row = aimed(ctx, App::People, "core.party", "party_id")?;
                (
                    "people.log_interaction",
                    json!({ "party_id": row.id, "kind": "call" }),
                )
            }
            "debt_settled" => {
                // SOMEBODY ELSE'S IOU, through the People board's own
                // `owed_to_them` — the same door the reference reads it from.
                let row = other_row(
                    ctx,
                    App::People,
                    "core.party",
                    arg(args, "party_id"),
                    &needles,
                )
                .filter(|row| row.extra.contains_key("owed_to_them"))?;
                let debt = row
                    .extra
                    .get("owed_to_them")?
                    .split('\u{1f}')
                    .next()?
                    .to_owned();
                ("people.settle_debt", json!({ "debt_id": debt }))
            }
            "settled_up" => {
                let row = other_row(
                    ctx,
                    App::Tally,
                    "core.party",
                    arg(args, "party_id"),
                    &needles,
                )
                .filter(|row| row.id != me)?;
                (
                    "tally.settle_up",
                    json!({
                        "from_party": row.id,
                        "to_party": me,
                        "amount_minor": args.get("amount_minor"),
                        "group_id": arg(args, "group_id"),
                        "paid_on": today,
                    }),
                )
            }
            // A CREATION HAS NO ROW TO AIM AT, so the wrong subject is the
            // wrong WORDS: the same command, labelled after the best-matching
            // other row of the table it would have landed in.
            "task_created" => {
                let row = other_row(ctx, App::Tasks, "schedule.task", None, &needles)?;
                ("schedule.add_task", json!({ "title": row.label }))
            }
            "note_created" => {
                let row = other_row(ctx, App::Notes, "knowledge.note", None, &needles)?;
                (
                    "knowledge.create_note",
                    json!({ "title": row.label, "body_text": row.label }),
                )
            }
            "event_created" => {
                let row = other_row(ctx, App::Agenda, "core.event", None, &needles)?;
                (
                    "schedule.propose_event",
                    json!({
                        "summary": row.label,
                        "dtstart": args.get("dtstart"),
                    }),
                )
            }
            "locker_item_created" => {
                let row = other_row(ctx, App::Locker, "locker.item", None, &needles)?;
                (
                    "locker.add_item",
                    json!({ "title": row.label, "item_type": "note" }),
                )
            }
            "expense_added" => {
                let row = other_row(ctx, App::Tally, "tally.expense", None, &needles)?;
                (
                    "tally.add_expense",
                    json!({
                        "group_id": arg(args, "group_id"),
                        "description": row.label,
                        "amount_minor": args.get("amount_minor"),
                        "paid_by": me,
                        "category": "general",
                        "spent_on": today,
                        "splits": [{ "party_id": me, "share_minor": args.get("amount_minor") }],
                    }),
                )
            }
            _ => return None,
        };
        Some((command, body))
    }
}

impl Candidate for WrongRowSession {
    fn turn(&mut self, request: &str, ctx: &mut Context<'_>) -> Plan {
        let index = self.turn;
        self.turn += 1;
        let Some(expected) = self.wants.get(index).cloned() else {
            return Plan::Ids(Vec::new());
        };
        // NOT A WRITE TURN. This instrument measures writes and nothing else,
        // so it answers an empty read rather than pretending to retrieve.
        if first_write(&expected).is_none() {
            return Plan::Ids(Vec::new());
        }
        if let Some((command, body)) = Self::misfire(request, &expected, ctx) {
            let _ = ctx.write(command, body);
        }
        // AND IT STILL CLAIMS THE WRITE, whether the vault took it or not:
        // an instrument that reported its own misfire would be measuring its
        // own honesty rather than the suite's discrimination.
        Plan::Wrote
    }
}

impl CandidateRuntime for WrongRowWriter {
    fn name(&self) -> &str {
        "WrongRowWriter"
    }
    fn session(&self, session: &Session) -> Box<dyn Candidate> {
        Box::new(WrongRowSession {
            wants: session
                .turns
                .iter()
                .map(|turn| turn.expected.clone())
                .collect(),
            turn: 0,
        })
    }
}

/// **THE RIGHT WRITE, AND THREE OTHERS NOBODY ASKED FOR.**
///
/// It delegates the turn to the hand-written reference — so the predicate the
/// case names holds EXACTLY — and then trashes three unrelated notes. A turn
/// it passes is a turn whose score cannot tell a correct write from a correct
/// write plus arbitrary damage, which is the difference between a product a
/// member can be handed and one that cannot.
pub struct CollateralDamage;

/// How many bystanders it takes down. Three rather than one, so a scorer that
/// happened to look at a single neighbouring row would still miss two.
const BYSTANDERS: usize = 3;

struct CollateralSession {
    inner: Box<dyn Candidate>,
    wants: Vec<Expected>,
    turn: usize,
}

impl Candidate for CollateralSession {
    fn turn(&mut self, request: &str, ctx: &mut Context<'_>) -> Plan {
        let index = self.turn;
        self.turn += 1;
        // THE BYSTANDERS ARE CHOSEN BEFORE THE TURN, not after: a note the
        // reference creates on this very turn is not a bystander, and trashing
        // it would make the instrument fail the PREDICATE instead of the
        // licence — which would prove nothing about the changed-row set.
        let victims: Vec<String> = ctx
            .open(App::Notes)
            .unwrap_or_default()
            .into_iter()
            .filter(|row| row.live && row.entity == "knowledge.note")
            .take(BYSTANDERS)
            .map(|row| row.id)
            .collect();
        let plan = self.inner.turn(request, ctx);
        // ONLY ON A WRITE TURN. Damaging a read turn would be caught by the
        // read half of the same check, and this instrument exists to measure
        // the WRITE half: it must be indistinguishable from the reference
        // everywhere else.
        if self
            .wants
            .get(index)
            .is_none_or(|expected| first_write(expected).is_none())
        {
            return plan;
        }
        // Notes, because no write predicate in the suite licenses a change to
        // an EXISTING note: `note_created` licenses a NEW row and nothing
        // else, so these three trashings are unlicensed under every
        // expectation, including that one.
        for victim in victims {
            let _ = ctx.write("knowledge.delete_note", json!({ "note_id": victim }));
        }
        plan
    }
}

impl CandidateRuntime for CollateralDamage {
    fn name(&self) -> &str {
        "CollateralDamage"
    }
    fn session(&self, session: &Session) -> Box<dyn Candidate> {
        Box::new(CollateralSession {
            inner: Reference.session(session),
            wants: session
                .turns
                .iter()
                .map(|turn| turn.expected.clone())
                .collect(),
            turn: 0,
        })
    }
}

// ---------------------------------------------------------------------------
// The roster.
// ---------------------------------------------------------------------------

/// Every instrument, in the order a report should print them.
#[must_use]
pub fn roster() -> Vec<Box<dyn CandidateRuntime>> {
    vec![
        Box::new(AlwaysDecline::clarify()),
        Box::new(AlwaysDecline::refuse()),
        Box::new(Empty),
        Box::new(EverythingOfEntity),
        Box::new(Keyword::stateless()),
        Box::new(Keyword::never_clarify()),
        Box::new(Keyword::ignores_soft_delete()),
        Box::new(Keyword::search_only()),
        Box::new(Keyword::board_only()),
        Box::new(Keyword::both()),
        // THE WRITING INSTRUMENTS. Everything above them answers rows; these
        // three are the only things in this file that execute a command, and
        // without them the suite's write half had no floor at all.
        Box::new(ClaimsWroteDoesNothing),
        Box::new(WrongRowWriter),
        Box::new(CollateralDamage),
    ]
}
