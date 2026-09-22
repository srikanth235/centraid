//! # `textref` — the second reference, which reads the WORDS
//!
//! [`crate::reference`] is a position oracle: it is told which session and
//! which turn it is answering and resolves that turn through the doors. That
//! proves every case is *reachable*. It cannot prove that a case's expected
//! answer is the answer to the case's own **sentence**, because it never
//! reads the sentence — and a corpus whose only oracle is blind to its own
//! prose can hold a question that asks one thing and expects another for as
//! long as nobody reads it aloud. It held two: `s64` asked what had been
//! ticked off "this week" and expected two rows finished the *previous*
//! Saturday, and `s41` asked what could be "got done in about forty five
//! minutes" while expecting only the task whose estimate *is* forty-five.
//!
//! So this is a second `Candidate` with one deliberate disability:
//!
//! > **It is never told which session or which turn it is answering.**
//!
//! It gets `(request, ctx)` and its own per-session memory of what it last
//! answered — exactly what a shipped runtime gets — and it resolves the turn
//! from the words, through the same doors and the same
//! [`crate::reference::calendar`] convention the position oracle uses. It is
//! hand-written rules and nothing else: no model, no training, no lookup of
//! the expectation.
//!
//! ## What its number means, and what it does not
//!
//! **It is not trying to reach 129/129, and a high score here would be a
//! smell rather than a result.** Its value is DISAGREEMENT: a turn where a
//! plain reading of the sentence lands somewhere the case does not is a turn
//! somebody has to adjudicate — either the case is wrong, or this file is.
//! Every disagreement in `suite.json` and `blind.json` has been adjudicated
//! by hand and the ruling recorded in `DEFECTS.md`.
//!
//! Three outcomes are therefore distinguished, and `run-textref` reports them
//! apart:
//!
//! | outcome | meaning |
//! | --- | --- |
//! | **agreed** | the rules reached the expected outcome |
//! | **disagreed** | the rules reached a DIFFERENT outcome — adjudicate it |
//! | **abstained** | the rules do not implement this shape of sentence at all |
//!
//! An abstention is not evidence about the case. Writes are abstained from
//! wholesale: an outcome-scored write needs a target, a field and a value,
//! and pinning all three from the sentence alone is a parser this file has no
//! business growing — the position oracle already proves writes reachable.
//!
//! `crate::tests` asserts the agreement count never falls below where this
//! landed, so the number is a **ratchet**: a case reworded into agreeing with
//! its own words cannot later be reworded back out of it in silence.

use std::collections::BTreeSet;

use crate::{App, Candidate, CandidateRuntime, Context, Plan, Session, VaultRow};

use super::calendar::{self, Window};
use super::{between, board, extra_is, ids};

/// The decline reason this file answers when it has no rule for a sentence.
///
/// It matches no expectation, so an abstention always *fails* the turn — it
/// is never quietly paid. `run-textref` tells it apart from a real
/// disagreement by this exact string.
pub const ABSTAIN: &str = "abstain";

/// The text-only reference runtime.
pub struct TextReference;

impl CandidateRuntime for TextReference {
    fn name(&self) -> &str {
        "textref (text-only rules)"
    }

    fn session(&self, _session: &Session) -> Box<dyn Candidate> {
        // NOTHING FROM THE SESSION. Not its id, not its category, not its
        // turns — the argument is taken and dropped, which is the whole
        // discipline of this file made structural rather than promised.
        Box::new(TextSession { held: Vec::new() })
    }
}

/// One conversation's memory: the rows the last answer named.
///
/// The same one thing the position oracle remembers, and for the same reason:
/// "just the weekend ones" and "what about Emerald Bay?" are about THOSE
/// rows. It is memory of its own answers, never of the corpus.
struct TextSession {
    held: Vec<VaultRow>,
}

impl TextSession {
    /// The one entity the last answer was made of, if it was made of one.
    fn held_entity(&self) -> Option<&'static str> {
        let entities: BTreeSet<&str> = self.held.iter().map(|row| row.entity.as_str()).collect();
        let only = entities.into_iter().collect::<Vec<_>>();
        let [only] = only[..] else { return None };
        ENTITY_WORDS
            .iter()
            .find_map(|(_, entity)| (*entity == only).then_some(*entity))
    }
}

// ---------------------------------------------------------------------------
// The vocabulary. Small, closed, and readable — it is the artifact.
// ---------------------------------------------------------------------------

/// The member withdrew. Nothing is the correct outcome.
const ABANDONED: &[&str] = &[
    "never mind",
    "nevermind",
    "forget it",
    "forget that",
    "don't worry",
    "dont worry",
    "no worries",
    "leave it",
    "drop it",
    "skip it",
    "ignore that",
    "not important",
    "doesn't matter",
    "actually nothing",
];

/// The member asked for something that is not the assistant's to do.
///
/// Sending, publishing and paying reach OUTSIDE the vault; a bulk destruction
/// reaches too far inside it. Both are refusals rather than questions.
const REFUSED: &[&str] = &[
    "delete everything",
    // NOT "delete all my <thing>": a bulk delete SCOPED to something the
    // member names is an ordinary instruction, and where the scope is
    // ambiguous the correct outcome is a question, not a refusal. Ruled
    // against this file on `s36` ("delete all my dentist stuff").
    "wipe",
    "empty the trash",
    "email ",
    "send ",
    "text ",
    "message ",
    "post ",
    "share ",
    "upload",
    "publish",
    "pay the",
    "transfer",
    "call them",
    "book me",
    "order ",
    // REACHING OUTSIDE THE VAULT. A website, the weather and a booking are
    // not rows a member owns, and a vault assistant that answered them would
    // be answering from somewhere this harness cannot score.
    "website",
    "weather",
    "online",
    "the internet",
];

/// A sentence that asks for a CHANGE. Abstained from — see the module note.
const WRITES: &[&str] = &[
    "log that",
    "add ",
    "make a note",
    "make an",
    "create ",
    "put a",
    "put the",
    "save ",
    "star ",
    "trash ",
    "cancel ",
    "move ",
    "push ",
    "reschedule",
    "mark ",
    "tick off",
    "settle ",
    "rename ",
    "file ",
    "remind me",
    "set ",
    "pay it",
    "pay off",
    "show me the password",
    "reveal",
    "bin the",
    "close it",
    "close out",
];

/// A word that names ONE app, and the app it names.
///
/// Deliberately not exhaustive and deliberately not clever. Where a word
/// names two apps ("dentist" names seven rows in seven apps) it is not here,
/// and the sentence resolves by search instead.
const APP_WORDS: &[(&str, App)] = &[
    ("calendar", App::Agenda),
    ("agenda", App::Agenda),
    ("appointment", App::Agenda),
    ("event", App::Agenda),
    ("meeting", App::Agenda),
    ("task", App::Tasks),
    ("tasks", App::Tasks),
    ("overdue", App::Tasks),
    ("due", App::Tasks),
    ("to-do", App::Tasks),
    ("todo", App::Tasks),
    ("ticked", App::Tasks),
    ("tick", App::Tasks),
    ("note", App::Notes),
    ("notes", App::Notes),
    ("notebook", App::Notes),
    ("journal", App::People),
    ("birthday", App::People),
    ("birthdays", App::People),
    ("anniversary", App::People),
    ("photo", App::Photos),
    ("photos", App::Photos),
    ("picture", App::Photos),
    ("pictures", App::Photos),
    ("album", App::Photos),
    ("document", App::Docs),
    ("documents", App::Docs),
    ("doc", App::Docs),
    ("docs", App::Docs),
    ("password", App::Locker),
    ("login", App::Locker),
    ("locker", App::Locker),
    ("passwords", App::Locker),
    ("logins", App::Locker),
    ("expense", App::Tally),
    ("expenses", App::Tally),
    ("spent", App::Tally),
    ("spend", App::Tally),
    ("owe", App::Tally),
    ("owes", App::Tally),
    ("cost", App::Tally),
];

/// **A SENTENCE THIS FILE HAS NO GRAMMAR FOR.**
///
/// A weekday, a day-of-month ordinal, an open-ended "so far", a bare
/// anaphor — each names something these rules cannot resolve, and answering
/// anyway would fill the disagreement ledger with noise that no adjudication
/// can act on. Abstaining says so.
const UNPARSED: &[&str] = &[
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "so far",
    "the first",
    "the second",
    "the third",
    "the other",
    "the 17th",
    "the 20th",
    "for that",
    "in there",
    "about that",
    "that one",
    "the one",
    "used to",
];

/// **HOW MANY ROWS AN ANSWER MAY NAME AND STILL BE ONE.**
///
/// A rules engine that hands back sixty rows has not resolved the sentence;
/// it has matched a common word. Above this, it abstains — an answer nobody
/// would defend is not a disagreement anybody can rule on.
const CONFIDENT_MAX: usize = 8;

/// Words that carry no subject: question words, articles, the app words above
/// and every phrase in the calendar table. Stripping them is what leaves a
/// needle.
const STOPWORDS: &[&str] = &[
    "a",
    "about",
    "after",
    "all",
    "am",
    "an",
    "and",
    "any",
    "anything",
    "are",
    "around",
    "as",
    "at",
    "back",
    "be",
    "been",
    "before",
    "both",
    "but",
    "by",
    "can",
    "did",
    "do",
    "does",
    "doing",
    "done",
    "for",
    "from",
    "get",
    "give",
    "got",
    "had",
    "has",
    "have",
    "having",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "just",
    "many",
    "me",
    "much",
    "my",
    "no",
    "not",
    "of",
    "off",
    "on",
    "one",
    "ones",
    "only",
    "or",
    "other",
    "our",
    "out",
    "over",
    "said",
    "say",
    "says",
    "see",
    "she",
    "show",
    "so",
    "some",
    "still",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "thing",
    "things",
    "this",
    "those",
    "to",
    "up",
    "us",
    "was",
    "we",
    "were",
    "what",
    "whats",
    "when",
    "where",
    "which",
    "while",
    "who",
    "whose",
    "why",
    "will",
    "with",
    "would",
    "you",
    "your",
    "long",
    "time",
    "again",
    "too",
    "left",
    // CALENDAR NOUNS. They are part of the temporal phrase, not the subject:
    // "just the weekend ones" narrows a held answer BY DATE, and treating
    // "weekend" as a label needle asked for rows whose titles say "weekend".
    "week",
    "weeks",
    "weekend",
    "month",
    "months",
    "day",
    "days",
    "year",
    "years",
    "morning",
    "afternoon",
    "evening",
    "night",
];

/// The entity an app word pins, where it pins one.
///
/// "photos" is both an app and a KIND of row, and the Photos board carries
/// places and albums beside the frames. Asking for photographs and being
/// handed the place they were taken is not a near miss — it is a different
/// answer.
const ENTITY_WORDS: &[(&str, &str)] = &[
    ("photo", "core.content_item"),
    ("photos", "core.content_item"),
    ("picture", "core.content_item"),
    ("pictures", "core.content_item"),
    ("album", "media.album"),
    ("note", "knowledge.note"),
    ("notes", "knowledge.note"),
    ("document", "core.document"),
    ("documents", "core.document"),
    ("doc", "core.document"),
    ("docs", "core.document"),
    ("task", "schedule.task"),
    ("tasks", "schedule.task"),
    ("event", "core.event"),
    ("appointment", "core.event"),
    ("meeting", "core.event"),
    // A BIRTHDAY IS NOT A PERSON. The People board carries the roster, the
    // journal and the reminder rows together, so "any birthdays this month"
    // without this answers with whatever else People wrote that month —
    // which on this world is a journal entry. Ruled against this file on
    // `s84`.
    ("birthday", "people.important_date"),
    ("birthdays", "people.important_date"),
    ("anniversary", "people.important_date"),
];

/// The entity this sentence pins, or nothing.
fn entity_of(request: &str) -> Option<&'static str> {
    let mut found: BTreeSet<&'static str> = BTreeSet::new();
    for (word, entity) in ENTITY_WORDS {
        if contains_word(request, word) {
            found.insert(entity);
        }
    }
    (found.len() == 1).then(|| found.into_iter().next().unwrap_or("core.event"))
}

// ---------------------------------------------------------------------------
// Reading the sentence.
// ---------------------------------------------------------------------------

fn declined(reason: &str) -> Plan {
    Plan::Declined {
        reason: reason.to_owned(),
    }
}

fn abstain() -> Plan {
    declined(ABSTAIN)
}

/// The window the sentence denotes, under the published convention.
///
/// Longest phrase first, so "this weekend" is found before "this week".
/// A bare "weekend" or "the week" is resolved by TENSE, which this does read
/// — past-tense auxiliaries and past-tense verbs push it backwards.
#[must_use]
pub fn window_of(request: &str, today: &str) -> Option<Window> {
    for phrase in calendar::phrases() {
        if request.contains(phrase) {
            return calendar::phrase(today, phrase);
        }
    }
    if request.contains("weekend") {
        return Some(if is_past_tense(request) {
            calendar::last_weekend(today)
        } else {
            calendar::this_weekend(today)
        });
    }
    if request.contains(" week") {
        return Some(if is_past_tense(request) {
            calendar::last_week(today)
        } else {
            calendar::this_week(today)
        });
    }
    None
}

/// Does the sentence look backwards?
///
/// Crude on purpose: "did I", "have I", "was", "were" and a handful of past
/// participles. It is the only grammar in this file, and it exists because
/// "what's on at the weekend" and "what did I write at the weekend" denote
/// different weekends — a fact no lookup table of phrases can hold.
fn is_past_tense(request: &str) -> bool {
    [
        "did i", "have i", "had i", "was ", "were ", "wrote", "written", "ticked", "finished",
        "spent", "went", "took", "logged", "last ",
    ]
    .iter()
    .any(|marker| request.contains(marker))
}

/// The one app this sentence names, or nothing when it names none or several.
fn app_of(request: &str) -> Option<App> {
    let mut found: BTreeSet<App> = BTreeSet::new();
    for (word, app) in APP_WORDS {
        if contains_word(request, word) {
            found.insert(*app);
        }
    }
    (found.len() == 1).then(|| found.into_iter().next().unwrap_or(App::Notes))
}

/// `request` contains `word` as a whole word.
fn contains_word(request: &str, word: &str) -> bool {
    request
        .split(|character: char| !character.is_alphanumeric() && character != '-')
        .any(|token| token == word)
}

/// The subject words: what is left after the question words, the app words
/// and the calendar's own phrases are taken out.
///
/// PROPER NOUNS ARE KEPT AS PHRASES. "Emerald Bay" is one needle and not two,
/// because "bay" alone matches nothing a member meant.
fn needles(request: &str) -> Vec<String> {
    let mut stripped = request.to_lowercase();
    for phrase in calendar::phrases() {
        stripped = stripped.replace(phrase, " ");
    }
    let mut found: Vec<String> = Vec::new();

    // Adjacent capitalised words of the ORIGINAL sentence, joined. Sentence
    // position is not a signal here — every request in this corpus is
    // lower-case except where the member named something.
    let mut run: Vec<&str> = Vec::new();
    for token in request.split_whitespace() {
        let word = token.trim_matches(|character: char| !character.is_alphanumeric());
        let capital = word
            .chars()
            .next()
            .is_some_and(|character| character.is_uppercase());
        if capital && word.len() > 1 {
            run.push(word);
        } else {
            if !run.is_empty() {
                found.push(run.join(" ").to_lowercase());
                run.clear();
            }
        }
    }
    if !run.is_empty() {
        found.push(run.join(" ").to_lowercase());
    }

    for token in stripped.split(|character: char| !character.is_alphanumeric() && character != '-')
    {
        if token.len() < 3 {
            continue;
        }
        if STOPWORDS.contains(&token) {
            continue;
        }
        if APP_WORDS.iter().any(|(word, _)| *word == token) {
            continue;
        }
        if found.iter().any(|phrase| phrase.contains(token)) {
            continue;
        }
        found.push(token.to_owned());
    }
    found
}

// ---------------------------------------------------------------------------
// Resolving.
// ---------------------------------------------------------------------------

impl TextSession {
    fn answer(&mut self, rows: Vec<VaultRow>) -> Plan {
        let mut rows = rows;
        rows.sort_by(|left, right| left.id.cmp(&right.id));
        rows.dedup_by(|left, right| left.id == right.id);
        let answered = ids(&rows);
        self.held = rows;
        Plan::Ids(answered)
    }

    /// A follow-up that narrows what was just answered.
    ///
    /// "just the weekend ones", "only the ones from may", "what about the
    /// notes" — the subject is THOSE rows, and re-searching the vault would
    /// answer a question the member did not ask.
    fn narrow(&mut self, request: &str, ctx: &Context<'_>) -> Option<Plan> {
        let narrowing = [
            "just the",
            "only the",
            "just ",
            "only ",
            "which of those",
            "of those",
        ]
        .iter()
        .any(|marker| request.starts_with(marker) || request.contains("of those"));
        if !narrowing || self.held.is_empty() {
            return None;
        }
        let held = self.held.clone();
        let window = window_of(request, ctx.today());
        let needles = needles(request);
        let kept: Vec<VaultRow> = held
            .into_iter()
            .filter(|row| {
                window
                    .as_ref()
                    .is_none_or(|window| row.date.as_deref().is_some_and(|date| window.holds(date)))
            })
            .filter(|row| {
                needles.is_empty()
                    || needles
                        .iter()
                        .any(|needle| row.label.to_lowercase().contains(needle))
            })
            .collect();
        Some(self.answer(kept))
    }

    /// Every live row of the vault that carries **all** of this sentence's
    /// needles.
    ///
    /// Conjunction, not union. "the dentist pre-authorisation" is one thing,
    /// and answering with everything that says *either* word hands back nine
    /// rows in seven apps — which reads as ambiguity when the sentence was
    /// perfectly specific. Ruled against this file on `s04`, `s25`, `s34`,
    /// `s44`, `s56` and `s60`, every one of which the corpus was right about.
    fn matching(
        ctx: &Context<'_>,
        app: Option<App>,
        entity: Option<&str>,
        needles: &[String],
    ) -> Vec<VaultRow> {
        let apps: Vec<App> = app.map_or_else(|| App::all().to_vec(), |app| vec![app]);
        let mut rows = Vec::new();
        for app in apps {
            rows.extend(board(ctx, app).into_iter().filter(|row| {
                row.live
                    && entity.is_none_or(|wanted| row.entity == wanted)
                    && needles
                        .iter()
                        .all(|needle| row.label.to_lowercase().contains(needle))
            }));
        }
        rows.sort_by(|left, right| left.id.cmp(&right.id));
        rows.dedup_by(|left, right| left.id == right.id);
        rows
    }
}

impl Candidate for TextSession {
    fn turn(&mut self, request: &str, ctx: &mut Context<'_>) -> Plan {
        let lower = request.to_lowercase();

        // 1. THE MEMBER WITHDREW. Checked first: "ugh, never mind" contains
        //    no subject, and every later rule would invent one.
        if ABANDONED.iter().any(|marker| lower.contains(marker)) {
            return declined("none");
        }
        // 2. A CHANGE, checked BEFORE the refusals: "add a task to pay the
        //    copay" is a task, not a payment, and reading the refusal list
        //    first turned every write whose object happened to be a bill into
        //    a refusal. Ruled against this file on `s44`.
        if WRITES.iter().any(|marker| lower.contains(marker)) {
            return abstain();
        }
        // 3. OUTSIDE THE VAULT, or too far inside it.
        if REFUSED.iter().any(|marker| lower.contains(marker)) {
            return declined("refuse");
        }
        // 4. A follow-up about what was just answered.
        if let Some(plan) = self.narrow(&lower, ctx) {
            return plan;
        }

        // 5. NO GRAMMAR FOR THIS SENTENCE. Said out loud rather than guessed
        //    at: an answer these rules cannot defend is not a disagreement
        //    anybody can rule on.
        if UNPARSED.iter().any(|marker| lower.contains(marker)) {
            return abstain();
        }

        let window = window_of(&lower, ctx.today());
        let app = app_of(&lower);
        // A FOLLOW-UP INHERITS THE SUBJECT KIND. "what about Emerald Bay?"
        // after a question about notes is a question about notes; searching
        // the whole vault answers a question the member did not ask twice.
        let inherited = (lower.starts_with("what about") || lower.starts_with("and "))
            .then(|| self.held_entity())
            .flatten();
        let entity = entity_of(&lower).or(inherited);
        let needles = needles(request);
        let counting = lower.contains("how many");
        let summing =
            lower.contains("how much") || lower.contains("what has") && lower.contains("cost");

        // 6. A WINDOW AND AN APP AND NO SUBJECT — "what's on my calendar this
        //    week", "what's due this week", "what did I tick off last week".
        //    The shape this file exists for.
        if needles.is_empty() {
            let (Some(app), Some(window)) = (app, window) else {
                return abstain();
            };
            let rows = self.rows_in_window(ctx, app, &window, &lower, entity);
            if summing {
                return Plan::Value(super::total_minor(&rows));
            }
            if counting {
                #[expect(clippy::cast_precision_loss, reason = "a count of rows")]
                let count = rows.len() as f64;
                return Plan::Value(count);
            }
            if rows.len() > CONFIDENT_MAX {
                return abstain();
            }
            return self.answer(rows);
        }

        // 7. A SUBJECT. Search every app it could be in, then apply the
        //    window if the sentence carried one.
        let mut rows = Self::matching(ctx, app, entity, &needles);
        if let Some(window) = &window {
            rows.retain(|row| row.date.as_deref().is_some_and(|date| window.holds(date)));
        }
        if rows.is_empty() || rows.len() > CONFIDENT_MAX {
            // A common word matched half the vault. That is the rules failing
            // to resolve a sentence, not the case being wrong.
            return abstain();
        }
        // 8. ONE NOUN REACHING SEVERAL APPS IS A QUESTION, not an answer.
        //    "my dentist thing" is an event, two tasks, two notes, a
        //    document, an expense and a sealed login; answering any one of
        //    them is guessing which the member meant.
        //
        //    Unless the member asked for the spread: "what do I have about
        //    Emerald Bay" wants all of it, and clarifying there would be
        //    asking a question whose answer was already given.
        let broad = [
            "what do i have",
            "anything about",
            "everything about",
            "all my",
        ]
        .iter()
        .any(|marker| lower.contains(marker));
        let apps: BTreeSet<&str> = rows.iter().map(|row| row.app.as_str()).collect();
        if app.is_none() && !broad && apps.len() > 2 {
            return declined("clarify");
        }
        if counting {
            #[expect(clippy::cast_precision_loss, reason = "a count of rows")]
            let count = rows.len() as f64;
            return Plan::Value(count);
        }
        if summing {
            // A SUM OVER NOTHING IS NOT A SUM. Answering zero would be this
            // file claiming to have read a balance it never found.
            if !rows.iter().any(|row| row.entity == "tally.expense") {
                return abstain();
            }
            return Plan::Value(super::total_minor(&rows));
        }
        self.answer(rows)
    }
}

impl TextSession {
    /// The rows of one app inside one window, under the reading its own board
    /// asks for.
    ///
    /// Tasks are the only app where the window can mean two different stamps:
    /// "due this week" is `due_at` and "ticked off last week" is
    /// `completed_at`. That is a property of the sentence, so the sentence
    /// decides.
    fn rows_in_window(
        &self,
        ctx: &Context<'_>,
        app: App,
        window: &Window,
        request: &str,
        entity: Option<&str>,
    ) -> Vec<VaultRow> {
        let completion = ["ticked", "tick off", "finished", "completed", "got done"]
            .iter()
            .any(|marker| request.contains(marker));
        if app == App::Tasks && completion {
            return board(ctx, App::Tasks)
                .into_iter()
                .filter(|row| row.live && extra_is(row, "status", "completed"))
                .filter(|row| {
                    row.extra
                        .get("completed_at")
                        .is_some_and(|stamp| window.holds(stamp))
                })
                .collect();
        }
        let rows: Vec<VaultRow> = between(ctx, app, &window.from, &window.to)
            .into_iter()
            .filter(|row| entity.is_none_or(|wanted| row.entity == wanted))
            .collect();
        if app == App::Tasks {
            // An open board question is about OPEN rows: a task finished last
            // month is not "due this week" however its due date reads.
            return rows
                .into_iter()
                .filter(|row| !extra_is(row, "status", "completed"))
                .collect();
        }
        rows
    }
}
