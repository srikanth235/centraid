//! The hand-written paraphrase parser: member text -> canonical tree.
//!
//! Tier D means NO MODEL. Everything here is a rule over the lexicon, and the
//! rules are ordered so that the cheapest, most certain reading wins first:
//! withdrawal, then refusal, then a typed write, then a value, then a list.
//! When no rule fires the answer is `Unparsed` — an abstention, never a guess
//! (GRAMMAR.md's clarify rules exist because a guessed canonical is the one
//! failure a member cannot see).

use super::calendar;
use super::lexicon::{Norm, WriteVerb, lexicon, normalise};
use super::tree::{ArgVal, Canonical, Operand, Pred, Set, Turn, Unparsed, Value, Window};

/// The five moves of GRAMMAR.md §3, plus `switch` as the corpus labels it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Move {
    New,
    Substitute,
    Refine,
    Act,
    Undo,
    Switch,
}

impl Move {
    pub fn name(self) -> &'static str {
        match self {
            Move::New => "new",
            Move::Substitute => "substitute",
            Move::Refine => "refine",
            Move::Act => "act",
            Move::Undo => "undo",
            Move::Switch => "switch",
        }
    }
}

/// What the session holds between turns: the previous canonical, the one
/// before it (for `the earlier one`), and the subject kind a follow-up
/// inherits when it names no noun of its own.
#[derive(Default, Debug, Clone)]
pub struct ParseState {
    pub history: Vec<Turn>,
    pub last_kind: Option<String>,
    pub last_label: Option<String>,
    pub last_window: Option<Window>,
    pub parked: Option<Turn>,
    /// How many rows the session is holding from the last answer, when the
    /// caller knows. A write with no subject of its own inherits it, and the
    /// REF it inherits follows the it/them convention. `None` when the parser
    /// is being scored on its own, where `it` is the honest default.
    pub held_rows: Option<usize>,
}

impl ParseState {
    pub fn previous(&self) -> Option<&Turn> {
        self.history.last()
    }

    /// The canonical two turns back — what `the earlier one` resolves to.
    pub fn before_previous(&self) -> Option<&Turn> {
        if self.history.len() >= 2 {
            self.history.get(self.history.len() - 2)
        } else {
            None
        }
    }

    pub fn record(&mut self, turn: Turn) {
        if let Some(set) = turn.held_set()
            && let Some(window) = window_of(set)
        {
            self.last_window = Some(window);
        }
        if let Some(set) = turn.held_set() {
            if let Some(kind) = set.head_kind() {
                self.last_kind = Some(kind.to_string());
            }
            if let Some(label) = first_label(set) {
                self.last_label = Some(label);
            }
        }
        self.history.push(turn);
    }
}

fn window_of(set: &Set) -> Option<Window> {
    match set {
        Set::During(_, window) => Some(window.clone()),
        Set::Filter(inner, Pred::During(_, window)) => {
            window_of(inner).or_else(|| Some(window.clone()))
        }
        Set::Called(inner, _)
        | Set::Filter(inner, _)
        | Set::Order { set: inner, .. }
        | Set::First(_, inner)
        | Set::Walk { from: inner, .. } => window_of(inner),
        Set::Union(l, _) | Set::Except(l, _) => window_of(l),
        _ => None,
    }
}

fn first_label(set: &Set) -> Option<String> {
    match set {
        Set::Called(_, lit) => Some(lit.clone()),
        Set::Walk { from, .. } => first_label(from),
        Set::Filter(inner, _)
        | Set::During(inner, _)
        | Set::Order { set: inner, .. }
        | Set::First(_, inner) => first_label(inner),
        Set::Union(l, _) | Set::Except(l, _) => first_label(l),
        _ => None,
    }
}

pub struct Parser;

impl Parser {
    pub fn new() -> Self {
        Parser
    }

    /// Parse one turn against the session state. The state is NOT mutated —
    /// `run` does that, so a caller can re-parse a turn.
    pub fn parse(&self, request: &str, state: &ParseState) -> Result<(Turn, Move), Unparsed> {
        let mut norm = normalise(request);
        let mut mv = strip_discourse(&mut norm, state);

        if is_undo(&norm) {
            return Ok((Turn::Nothing, Move::Undo));
        }
        if let Some(reason) = refusal(&norm) {
            return Ok((Turn::Refuse(reason), mv));
        }
        if norm.tokens.is_empty() {
            return Err(Unparsed::new("empty after normalisation"));
        }

        // A short follow-up that only swaps a noun or a name EDITS the
        // previous canonical rather than re-parsing (GRAMMAR.md §3).
        // A fragment that CARRIES A WRITE VERB is not one of those: "star it",
        // "flag it", "settle that" name an ACT, and reading them as a swapped
        // noun is how a write turned into a board dump.
        if mv != Move::Switch
            && write_probe(&norm).is_none()
            && let Some(turn) = substitute(&mut norm.clone(), state)
        {
            return Ok((turn, Move::Substitute));
        }

        if let Some((turn, hint)) = command(&mut norm, state) {
            if let Turn::Cmd {
                on: Some(Set::Ref(_)),
                ..
            } = &turn
                && state.previous().is_none()
            {
                return Err(Unparsed::new("a write with no anchor in the session"));
            }
            if mv == Move::New {
                mv = hint;
            }
            return Ok((turn, mv));
        }
        if let Some((turn, hint)) = value_turn(&mut norm, state) {
            if mv == Move::New {
                mv = hint;
            }
            return Ok((turn, mv));
        }
        if let Some(set) = build_set(&mut norm, state, true) {
            // ABSTAIN rather than point. A bare `Ref` is the parser saying it
            // found no meaning at all, and a `Ref` with nothing behind it in
            // the session is R-C5's case: there is nothing for it to resolve.
            if let Set::Ref(name) = &set {
                if state.previous().is_none() {
                    return Err(Unparsed::new(format!(
                        "`{name}` with nothing in the session to resolve it"
                    )));
                }
                let content = norm.tokens.iter().filter(|t| !t.consumed).count();
                if content >= 3 {
                    return Err(Unparsed::new(format!(
                        "fell through to `{name}` with {content} words unread"
                    )));
                }
            }
            if mv == Move::New && uses_context(&set) {
                mv = Move::Refine;
            }
            return Ok((Turn::Show(set), mv));
        }
        Err(Unparsed::new(format!("no rule matched: {}", norm.text)))
    }

    /// Parse and thread the state, the way a session runs.
    pub fn run(&self, request: &str, state: &mut ParseState) -> Result<Canonical, Unparsed> {
        match self.parse(request, state) {
            Ok((turn, _)) => {
                let canonical = Canonical::from(&turn);
                state.record(turn);
                Ok(canonical)
            }
            Err(error) => Err(error),
        }
    }
}

impl Default for Parser {
    fn default() -> Self {
        Parser::new()
    }
}

fn uses_context(set: &Set) -> bool {
    match set {
        Set::Ref(_) => true,
        Set::Walk { from, .. } => uses_context(from),
        Set::Called(inner, _)
        | Set::Filter(inner, _)
        | Set::During(inner, _)
        | Set::Order { set: inner, .. }
        | Set::First(_, inner) => uses_context(inner),
        Set::Union(l, r) | Set::Except(l, r) => uses_context(l) || uses_context(r),
        Set::Kind(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Discourse: the words before the request proper.
// ---------------------------------------------------------------------------

const OPENERS: &[&str] = &[
    "hang on",
    "hold on",
    "wait",
    "actually",
    "no",
    "ugh",
    "fine",
    "right",
    "hmm",
    "oh",
    "and",
    "but",
    "then",
    "also",
    "scratch that",
    "just",
];

fn strip_discourse(norm: &mut Norm, _state: &ParseState) -> Move {
    let mut mv = Move::New;
    // "back to the money —" / "back to the photos" re-opens a parked thread.
    if norm.text.starts_with("back to") {
        let cut = norm
            .tokens
            .iter()
            .position(|t| t.lower == "—" || t.lower == "-")
            .map(|at| at + 1)
            .unwrap_or_else(|| 4.min(norm.tokens.len()));
        norm.tokens.drain(0..cut.min(norm.tokens.len()));
        rebuild(norm);
        return Move::Refine;
    }
    loop {
        let mut cut = 0usize;
        for opener in OPENERS {
            let words: Vec<&str> = opener.split_whitespace().collect();
            if norm.tokens.len() > words.len()
                && (0..words.len()).all(|k| norm.tokens[k].lower == words[k])
            {
                cut = words.len();
                if *opener == "hang on" || *opener == "hold on" || *opener == "wait" {
                    mv = Move::Switch;
                }
                break;
            }
        }
        if cut == 0 {
            break;
        }
        norm.tokens.drain(0..cut);
    }
    rebuild(norm);
    mv
}

fn rebuild(norm: &mut Norm) {
    norm.text = norm
        .tokens
        .iter()
        .map(|t| t.lower.as_str())
        .collect::<Vec<_>>()
        .join(" ");
}

fn is_undo(norm: &Norm) -> bool {
    let lex = lexicon();
    // "put it back" is a RESTORE, not a withdrawal.
    if norm.has("put it back") || norm.has("put them back") || norm.has("put her back") {
        return false;
    }
    lex.undo.iter().any(|phrase| norm.has(phrase))
}

fn refusal(norm: &Norm) -> Option<String> {
    let lex = lexicon();
    for (reason, clauses) in &lex.refuse {
        for clause in clauses {
            let verbs = &clause[0];
            let objects = &clause[1];
            let verb_ok = verbs.is_empty() || verbs.split('|').any(|v| norm.has(v));
            let object_ok = objects.split('|').any(|o| norm.has(o));
            if verb_ok && object_ok {
                return Some(reason.clone());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Kinds, windows, literals.
// ---------------------------------------------------------------------------

fn detect_kind(norm: &mut Norm) -> Option<String> {
    detect_kind_kept(norm, &mut None)
}

/// As `detect_kind`, but reporting the surface it declined to consume. A
/// LABEL_KEEPING noun ("packing list", "rental agreement") is part of the row's
/// NAME, so the whole surface — stop words and all — is the literal, and
/// `label_span` must not be allowed to shave the generic half off it.
fn detect_kind_kept(norm: &mut Norm, kept: &mut Option<String>) -> Option<String> {
    let lex = lexicon();
    const LABEL_KEEPING: &[&str] = &[
        "policy",
        "agreement",
        "permit",
        "packing list",
        "recipe",
        "shortlist",
        "plan",
        "booking",
    ];
    let mut best: Option<(usize, usize, String)> = None; // (words, start, kind)
    for (kind, surfaces) in &lex.kinds {
        if kind == "things" {
            continue;
        }
        for surface in surfaces {
            if let Some((start, end)) = norm.locate(surface)
                && norm.tokens[start..end].iter().all(|t| !t.consumed)
            {
                let words = end - start;
                if best
                    .as_ref()
                    .map(|(w, s, _)| words > *w || (words == *w && start < *s))
                    .unwrap_or(true)
                {
                    best = Some((words, start, kind.clone()));
                }
            }
        }
    }
    if let Some((words, start, kind)) = best {
        let surface = norm.tokens[start..start + words]
            .iter()
            .map(|t| t.lower.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        if LABEL_KEEPING.contains(&surface.as_str()) {
            if surface.split_whitespace().count() > 1 {
                *kept = Some(surface);
            }
        } else {
            norm.consume((start, start + words));
        }
        return Some(kind);
    }
    // No board was named. A handful of words still pin one, and the rest is
    // `things` — the top kind (GRAMMAR.md R-T1).
    if norm.has("overdue")
        || norm.has("due")
        || norm.has("deadline")
        || norm.has("behind schedule")
        || norm.has("undated")
        || norm.has("still on my list")
        || norm.has("what is left")
        || norm.has("on my list")
        || norm.has("tick")
        || norm.has("ticked")
    {
        return Some("tasks".to_string());
    }
    // A folder is a Docs column: "what's filed in Travel" names no board
    // because the FOLDER is the board it names.
    if norm.has("filed in") || norm.has("filed under") || norm.has("in the folder") {
        return Some("documents".to_string());
    }
    if norm.has("owe") || norm.has("owes") || norm.has("owed") {
        return Some(
            if norm.text.starts_with("who") {
                "parties"
            } else {
                "obligations"
            }
            .to_string(),
        );
    }
    if norm.text.starts_with("who") {
        return Some("parties".to_string());
    }
    // GRAMMAR.md 5 C3: "what's on <weekday>" is the board, the diary AND the
    // birthday that is on neither -- which is R-T2, and R-T2's Kind is
    // `things`. Only a question about a TIME is the diary alone.
    if norm.has("what is on") && !norm.has("what time") {
        return Some("things".to_string());
    }
    if norm.has("what time")
        || norm.has("check in")
        || norm.has("check out")
        || norm.has("check-in")
        || norm.has("check-out")
    {
        return Some("events".to_string());
    }
    if norm.has("anything")
        || norm.has("everything")
        || norm.has("stuff")
        || norm.has("thing")
        || norm.has("things")
        || norm.has("what do i have")
        || norm.has("what have i got")
        || norm.has("what is happening")
        || norm.has("is happening")
    {
        for word in ["thing", "things", "stuff"] {
            norm.consume_phrase(word);
        }
        return Some("things".to_string());
    }
    None
}

fn detect_window(norm: &mut Norm) -> Option<Window> {
    detect_window_in(norm, None)
}

fn detect_window_in(norm: &mut Norm, state: Option<&ParseState>) -> Option<Window> {
    let lex = lexicon();
    if let Some(state) = state
        && (norm.has("then") || norm.has("that day") || norm.has("that week"))
        && state.last_window.is_some()
    {
        for phrase in ["then", "that day", "that week"] {
            norm.consume_phrase(phrase);
        }
        return state.last_window.clone();
    }
    let mut best: Option<(usize, usize, Window)> = None;
    for (canonical, surfaces) in &lex.windows {
        for surface in surfaces {
            if let Some((start, end)) = norm.locate(surface)
                && norm.tokens[start..end].iter().all(|t| !t.consumed)
            {
                let words = end - start;
                if best.as_ref().map(|(w, _, _)| words > *w).unwrap_or(true) {
                    best = Some((words, start, Window::Phrase(canonical.clone())));
                }
            }
        }
    }
    // "in the next couple of months" / "in the next 2 months"
    if norm.has("next couple of months") {
        if let Some(span) = norm.locate("next couple of months") {
            norm.consume(span);
        }
        return Some(Window::Rolling(2, "months".to_string()));
    }
    if let Some((words, start, window)) = best {
        norm.consume((start, start + words));
        return Some(window);
    }
    // A weekday name, or a day-of-month ordinal: resolved case by case, the
    // way README.md says they must be.
    for index in 0..norm.tokens.len() {
        if norm.tokens[index].consumed {
            continue;
        }
        let word = norm.tokens[index].lower.clone();
        if let Some(target) = lex.weekdays.get(&word) {
            norm.consume((index, index + 1));
            let days = calendar::next_weekday(*target);
            let today = calendar::today_days();
            return Some(match days - today {
                0 => Window::Phrase("today".into()),
                1 => Window::Phrase("tomorrow".into()),
                _ => Window::Date(calendar::iso(days)),
            });
        }
        if let Some(day) = ordinal_day(&word) {
            norm.consume((index, index + 1));
            return Some(Window::Date(calendar::iso(calendar::next_day_of_month(
                day,
            ))));
        }
        if let Some(month) = bare_month(&word) {
            norm.consume((index, index + 1));
            return Some(Window::Date(format!("2026-{month:02}")));
        }
    }
    None
}

fn ordinal_day(word: &str) -> Option<u32> {
    let digits: String = word.chars().take_while(|c| c.is_ascii_digit()).collect();
    let suffix = &word[digits.len()..];
    if digits.is_empty() || !matches!(suffix, "st" | "nd" | "rd" | "th") {
        return None;
    }
    digits.parse::<u32>().ok().filter(|d| (1..=31).contains(d))
}

fn bare_month(word: &str) -> Option<u32> {
    const MONTHS: [&str; 12] = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ];
    MONTHS
        .iter()
        .position(|m| *m == word)
        .map(|at| at as u32 + 1)
}

/// The member's own span, with their own capitalisation: the longest run of
/// words no rule has claimed. Resolution is the executor's job.
fn label_span(norm: &Norm) -> Option<String> {
    let lex = lexicon();
    let mut runs: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for (index, token) in norm.tokens.iter().enumerate() {
        // "that's" / "isn't" leave a bare `s` / `t` behind when the trimmer
        // splits on the apostrophe. A contraction's residue is never part of
        // the member's name for a row.
        const RESIDUE: &[&str] = &["s", "t", "re", "ve", "ll", "m", "d", "n"];
        let is_stop = token.consumed
            || lex.stopwords.contains(&token.lower)
            || RESIDUE.contains(&token.lower.as_str())
            || token.lower.chars().all(|c| !c.is_alphanumeric());
        if is_stop {
            if !current.is_empty() {
                runs.push(std::mem::take(&mut current));
            }
        } else {
            current.push(index);
        }
    }
    if !current.is_empty() {
        runs.push(current);
    }
    if runs.is_empty() {
        return None;
    }
    // A capitalised run is a name and beats a longer lower-case one.
    let capitalised: Vec<&Vec<usize>> = runs
        .iter()
        .filter(|run| run.iter().all(|i| norm.tokens[*i].capitalised))
        .collect();
    let chosen = if !capitalised.is_empty() {
        capitalised.into_iter().max_by_key(|run| run.len()).unwrap()
    } else {
        runs.iter().max_by_key(|run| run.len()).unwrap()
    };
    let words: Vec<String> = chosen
        .iter()
        .map(|i| norm.tokens[*i].original.trim_matches('"').to_string())
        .collect();
    let joined = words.join(" ");
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

/// A span the member QUOTED is a literal already — single or double quotes,
/// because a phone keyboard offers both.
fn quoted_literal(norm: &mut Norm) -> Option<String> {
    let raw = norm.raw.clone();
    let mut found: Option<String> = None;
    for mark in ['"', '\''] {
        let parts: Vec<&str> = raw.split(mark).collect();
        if parts.len() >= 3 && !parts[1].trim().is_empty() && parts[1].contains(' ') {
            found = Some(parts[1].trim().to_string());
            break;
        }
    }
    let literal = found?;
    let words: Vec<String> = literal
        .to_lowercase()
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_string())
        .collect();
    for token in &mut norm.tokens {
        if words.contains(&token.lower) {
            token.consumed = true;
        }
    }
    Some(literal)
}

fn consume_label(norm: &mut Norm, label: &str) {
    let lower = label.to_lowercase();
    if let Some(span) = norm.locate(&lower) {
        norm.consume(span);
    }
}

fn quoted_span(norm: &Norm) -> Option<String> {
    let raw = &norm.raw;
    let mut parts = raw.split('"');
    parts.next()?;
    parts
        .next()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

// ---------------------------------------------------------------------------
// Predicates.
// ---------------------------------------------------------------------------

fn money_minor(norm: &Norm) -> Option<i64> {
    let lex = lexicon();
    let mut value: Option<i64> = None;
    for (index, token) in norm.tokens.iter().enumerate() {
        if token.consumed {
            continue;
        }
        let number = token
            .lower
            .parse::<i64>()
            .ok()
            .or_else(|| lex.numbers.get(&token.lower).copied());
        let Some(number) = number else { continue };
        // "forty five", "a hundred"
        let mut total = number;
        if let Some(next) = norm.tokens.get(index + 1)
            && let Some(unit) = lex.numbers.get(&next.lower)
            && total >= 20
            && *unit < 10
        {
            total += unit;
        }
        if value.is_none() {
            value = Some(total);
        }
    }
    value
}

fn status_open() -> Pred {
    Pred::Cmp(
        "status".into(),
        "!=".into(),
        Operand::Lit("\"completed\"".into()),
    )
}

fn and(left: Option<Pred>, right: Pred) -> Pred {
    match left {
        Some(pred) => Pred::And(Box::new(pred), Box::new(right)),
        None => right,
    }
}

/// Everything a predicate can be said with, read off the remaining words.
fn predicates(norm: &mut Norm, kind: &str, window: &mut Option<Window>) -> Option<Pred> {
    let mut pred: Option<Pred> = None;

    if norm.consume_phrase("favorite") || norm.consume_phrase("favorites") {
        pred = Some(and(
            pred,
            Pred::Cmp("favorite".into(), "=".into(), Operand::Lit("true".into())),
        ));
    }
    if norm.has("deleted")
        || norm.has("binned")
        || norm.has("in the bin")
        || norm.has("did i bin")
        || norm.has("did i delete")
        || norm.has("trashed")
    {
        let field = "deleted_at".to_string();
        let clause = match window.take() {
            Some(w) => Pred::During(field, w),
            None => Pred::Is {
                field,
                what: "null".into(),
                negated: true,
            },
        };
        pred = Some(and(pred, clause));
    }
    if kind == "locker items" {
        let named_in_full = label_span(norm)
            .map(|label| label.split_whitespace().count() >= 2)
            .unwrap_or(false);
        if named_in_full {
            // the title says which shelf it is on
        } else if norm.consume_phrase("login") || norm.has("logins") {
            pred = Some(and(
                pred,
                Pred::Cmp("type".into(), "=".into(), Operand::Lit("\"login\"".into())),
            ));
        } else if norm.has("wifi") {
            pred = Some(and(
                pred,
                Pred::Cmp("type".into(), "=".into(), Operand::Lit("\"wifi\"".into())),
            ));
        }
        if norm.has("never rotated") || norm.has("not rotated") || norm.has("never changed") {
            pred = Some(and(
                pred,
                Pred::Cmp(
                    "password_set_at".into(),
                    "=".into(),
                    Operand::Field("created_at".into()),
                ),
            ));
        }
    }
    if kind == "contact channels" {
        pred = Some(and(
            pred,
            Pred::Cmp("kind".into(), "=".into(), Operand::Lit("\"phone\"".into())),
        ));
    }
    if kind == "important dates" && (norm.has("birthday") || norm.has("birthdays")) {
        pred = Some(and(pred, Pred::Contains("label".into(), "Birthday".into())));
    }
    if kind == "obligations"
        && (norm.has("in debt to me") || norm.has("owes me") || norm.has("owe me"))
    {
        pred = Some(and(
            pred,
            Pred::Is {
                field: "to_party".into(),
                what: "me".into(),
                negated: false,
            },
        ));
    }
    if kind == "expenses" && (norm.has("my own share") || norm.has("my share")) {
        pred = Some(and(
            pred,
            Pred::Cmp("paid_by".into(), "=".into(), Operand::Lit("me".into())),
        ));
    }
    if kind == "obligations"
        && (norm.has("still")
            || norm.has("outstanding")
            || norm.has("open")
            || norm.has("anything")
            || norm.has("owe")
            || norm.has("owes"))
    {
        pred = Some(and(
            pred,
            Pred::Is {
                field: "settled_at".into(),
                what: "null".into(),
                negated: false,
            },
        ));
    }
    if kind == "parties" {
        if norm.has("owes me") || norm.has("owe me") {
            pred = Some(and(
                pred,
                Pred::Is {
                    field: "owed_to_me".into(),
                    what: "null".into(),
                    negated: true,
                },
            ));
        } else if norm.has("i owe") || norm.has("do i owe") {
            pred = Some(and(
                pred,
                Pred::Is {
                    field: "owed_to_them".into(),
                    what: "null".into(),
                    negated: true,
                },
            ));
        }
    }
    if kind == "expenses" && (norm.has("i paid") || norm.has("i pay") || norm.has("did i pay")) {
        pred = Some(and(
            pred,
            Pred::Cmp("paid_by".into(), "=".into(), Operand::Lit("me".into())),
        ));
    }
    if (norm.has("more than") || norm.has("over") || norm.has("above"))
        && let Some(amount) = money_minor(norm)
        && (norm.has("dollar") || norm.has("dollars") || norm.has("quid") || norm.has("pounds"))
    {
        pred = Some(and(
            pred,
            Pred::Cmp(
                "amount_minor".into(),
                ">".into(),
                Operand::Lit((amount * 100).to_string()),
            ),
        ));
    }
    if (norm.has("minute") || norm.has("minutes"))
        && let Some(centre) = money_minor(norm)
    {
        pred = Some(and(pred, Pred::Band("effort_min".into(), centre as f64)));
    }
    if kind == "documents" && (norm.has("starred") || norm.has("flagged") || norm.has("pinned")) {
        pred = Some(and(
            pred,
            Pred::Cmp("starred".into(), "=".into(), Operand::Lit("true".into())),
        ));
    }
    if kind == "documents"
        && (norm.has("folder") || norm.has("filed in") || norm.has("filed under"))
        && let Some(name) = label_span(norm)
    {
        consume_label(norm, &name);
        pred = Some(and(
            pred,
            Pred::Cmp(
                "folder".into(),
                "=".into(),
                Operand::Lit(super::tree::quote(&name)),
            ),
        ));
    }
    if kind == "notes"
        && (norm.has("notebook") || norm.has("notebooks"))
        && let Some(name) = label_span(norm)
    {
        consume_label(norm, &name);
        pred = Some(and(pred, Pred::Contains("notebooks".into(), name)));
    }
    if kind == "photos"
        && (norm.has("album") || norm.has("filed under") || norm.has("filed in"))
        && let Some(name) = label_span(norm)
    {
        consume_label(norm, &name);
        pred = Some(and(pred, Pred::Contains("album_titles".into(), name)));
    }
    if kind == "tasks" {
        let completed = norm.has("ticked off")
            || norm.has("did i tick off")
            || norm.has("finished")
            || norm.has("completed")
            || (norm.has("tick off") && norm.text.starts_with("what"));
        if completed {
            pred = Some(and(
                pred,
                Pred::Cmp(
                    "status".into(),
                    "=".into(),
                    Operand::Lit("\"completed\"".into()),
                ),
            ));
            if let Some(w) = window.take() {
                pred = Some(and(pred, Pred::During("completed_at".into(), w)));
            }
        } else {
            if norm.has("no deadline")
                || norm.has("no due date")
                || norm.has("without a deadline")
                || norm.has("undated")
                || norm.has("no date")
            {
                pred = Some(and(
                    pred,
                    Pred::Is {
                        field: "due_at".into(),
                        what: "null".into(),
                        negated: false,
                    },
                ));
            }
            if let Some(w) = window.take() {
                pred = Some(and(pred, Pred::During("due_at".into(), w)));
            }
            let open_word = lexicon().open_task_words.iter().any(|word| norm.has(word));
            let labelled = label_span(norm)
                .map(|l| !label_is_noise(&l))
                .unwrap_or(false);
            if open_word || !labelled {
                pred = Some(and(pred, status_open()));
            }
        }
    }
    pred
}

// ---------------------------------------------------------------------------
// Sets.
// ---------------------------------------------------------------------------

const REF_ORDINALS: &[(&str, i64)] = &[
    ("first", 1),
    ("1st", 1),
    ("second", 2),
    ("2nd", 2),
    ("third", 3),
    ("3rd", 3),
    ("fourth", 4),
    ("4th", 4),
];

fn ordinal_ref(norm: &mut Norm) -> Option<Set> {
    for (word, number) in REF_ORDINALS {
        if let Some((start, end)) = norm.locate(word)
            && norm.tokens[start..end].iter().all(|t| !t.consumed)
        {
            let suffix = match number {
                1 => "st",
                2 => "nd",
                3 => "rd",
                _ => "th",
            };
            norm.consume((start, end));
            return Some(Set::Ref(format!("the {number}{suffix} one")));
        }
    }
    if norm.consume_phrase("the other one") || norm.consume_phrase("the other") {
        return Some(Set::Ref("the other one".into()));
    }
    if norm.consume_phrase("the earlier one") {
        return Some(Set::Ref("the earlier one".into()));
    }
    None
}

fn pronoun(norm: &Norm) -> Option<&'static str> {
    for word in ["them", "those", "these", "they"] {
        if norm.has(word) {
            return Some("them");
        }
    }
    for word in ["it", "that", "there", "this", "her", "him", "she", "he"] {
        if norm.has(word) {
            return Some("it");
        }
    }
    None
}

/// Whole-sentence readings: a phrase whose meaning the ontology fixes, which
/// no amount of word-by-word assembly reaches. Each is a SENTENCE FRAME, not a
/// corpus row: "when did I last hear from X" is the interaction board in
/// recency order whoever X is.
fn idiom(norm: &mut Norm, state: &ParseState) -> Option<Set> {
    let text = norm.text.clone();
    let last_contact = text.contains("last hear from")
        || text.contains("last heard from")
        || text.contains("last speak to")
        || text.contains("last spoke to")
        || text.contains("last talked to")
        || text.contains("last contact");
    if last_contact {
        let mut scratch = norm.clone();
        for phrase in [
            "when did i",
            "last hear from",
            "last heard from",
            "last speak to",
            "last spoke to",
            "last talked to",
            "last contact with",
            "did i",
        ] {
            scratch.consume_phrase(phrase);
        }
        let who = match label_span(&scratch) {
            Some(name) if !label_is_noise(&name) => {
                Set::Called(Box::new(Set::Kind("parties".into())), name)
            }
            _ => match state.last_label.clone() {
                Some(name) => Set::Called(Box::new(Set::Kind("parties".into())), name),
                None => Set::Ref("it".into()),
            },
        };
        return Some(Set::First(
            1,
            Box::new(Set::Order {
                set: Box::new(Set::Walk {
                    kind: "activities".into(),
                    from: Box::new(who),
                }),
                field: "started_at".into(),
                desc: true,
            }),
        ));
    }
    // "where was the X photo taken" reads the PLACE board off a photograph.
    if (text.starts_with("where was") || text.starts_with("where were"))
        && (text.contains("photo")
            || text.contains("picture")
            || text.contains("shot")
            || text.contains("taken"))
    {
        let mut scratch = norm.clone();
        for phrase in [
            "where was",
            "where were",
            "the",
            "photo",
            "photos",
            "picture",
            "shot",
            "taken",
            "one",
        ] {
            scratch.consume_phrase(phrase);
        }
        let inner = match label_span(&scratch) {
            Some(name) if !label_is_noise(&name) => {
                Set::Called(Box::new(Set::Kind("photos".into())), name)
            }
            _ => Set::Ref(pronoun(norm).unwrap_or("it").to_string()),
        };
        return Some(Set::Walk {
            kind: "places".into(),
            from: Box::new(inner),
        });
    }
    // "the last thing I wrote in my journal" is the journal in recency order.
    if text.contains("last thing i wrote") || text.contains("last journal") {
        return Some(Set::First(
            1,
            Box::new(Set::Order {
                set: Box::new(Set::Kind("journal notes".into())),
                field: "created_at".into(),
                desc: true,
            }),
        ));
    }
    // "what do I know about X" is the note library, whatever else holds X.
    if text.starts_with("what do i know about") {
        let mut scratch = norm.clone();
        scratch.consume_phrase("what do i know about");
        let label = label_span(&scratch)?;
        return Some(Set::Called(Box::new(Set::Kind("notes".into())), label));
    }
    None
}

/// "who is my dentist" is the role column, and the role is whatever noun the
/// member used — the CHECK values are the vault's, not this parser's.
fn role_question(norm: &mut Norm) -> Option<Set> {
    let text = norm.text.clone();
    if !(text.starts_with("who is my") || text.starts_with("who are my")) {
        return None;
    }
    for phrase in ["who is my", "who are my"] {
        norm.consume_phrase(phrase);
    }
    let role = label_span(norm)?;
    if label_is_noise(&role) {
        return None;
    }
    Some(Set::Filter(
        Box::new(Set::Kind("parties".into())),
        Pred::Cmp(
            "role".into(),
            "=".into(),
            Operand::Lit(super::tree::quote(&capitalise(&role))),
        ),
    ))
}

/// "which Marco was my roommate in Portland" — the NAME picks the rows and the
/// description is a role, which is a column the People reader hands back.
fn which_person(norm: &mut Norm) -> Option<Set> {
    let text = norm.text.clone();
    if !text.starts_with("which ") {
        return None;
    }
    // "which documents have I starred" — the capitalised `I` is the member
    // speaking, not a party the vault could resolve.
    let name_at = norm
        .tokens
        .iter()
        .position(|t| t.capitalised && !t.consumed && t.lower != "which" && t.lower != "i")?;
    let name = norm.tokens[name_at].original.clone();
    norm.consume((0, name_at + 1));
    for phrase in ["is my", "was my", "is the", "was the", "is", "was"] {
        norm.consume_phrase(phrase);
    }
    let role = label_span(norm)?;
    if label_is_noise(&role) {
        return None;
    }
    let role = role.split_whitespace().next()?.to_string();
    Some(Set::Filter(
        Box::new(Set::Called(Box::new(Set::Kind("parties".into())), name)),
        Pred::Contains("role".into(), role),
    ))
}

/// The tally roster of a group, which is not the People board.
fn roster(norm: &mut Norm) -> Option<Set> {
    let text = norm.text.clone();
    if !(text.starts_with("who is in")
        || text.starts_with("who are in")
        || text.starts_with("who is on"))
        || !text.contains("group")
    {
        return None;
    }
    for phrase in ["who is in", "who are in", "who is on", "the", "group"] {
        norm.consume_phrase(phrase);
    }
    let label = label_span(norm)?;
    Some(Set::Filter(
        Box::new(Set::Walk {
            kind: "members".into(),
            from: Box::new(Set::Called(Box::new(Set::Kind("groups".into())), label)),
        }),
        Pred::Is {
            field: "party_id".into(),
            what: "me".into(),
            negated: true,
        },
    ))
}

/// A stay has two diary rows and the grammar names them: GRAMMAR.md 2.6's
/// anchored window is `from (dtstart of (events called "check-in")) to
/// (dtstart of (events called "check-out"))`. So a member asking when they
/// check in is asking for THAT row, whatever place they say it about — the
/// place is where the stay is, not what the row is called.
fn arrival_row(norm: &mut Norm) -> Option<Set> {
    let inbound = norm.has("check in") || norm.has("check-in") || norm.has("checking in");
    let outbound = norm.has("check out") || norm.has("check-out") || norm.has("checking out");
    if !inbound && !outbound {
        return None;
    }
    for phrase in [
        "check in",
        "check-in",
        "checking in",
        "check out",
        "check-out",
        "checking out",
    ] {
        norm.consume_phrase(phrase);
    }
    let label = if inbound { "check-in" } else { "check-out" };
    Some(Set::Called(
        Box::new(Set::Kind("events".into())),
        label.to_string(),
    ))
}

/// The set the turn is about.
fn build_set(norm: &mut Norm, state: &ParseState, allow_ref: bool) -> Option<Set> {
    if let Some(set) = ordinal_ref(norm) {
        return Some(set);
    }
    if let Some(set) = roster(norm) {
        return Some(set);
    }
    if let Some(set) = role_question(norm) {
        return Some(set);
    }
    if let Some(set) = which_person(norm) {
        return Some(set);
    }
    if let Some(set) = idiom(norm, state) {
        return Some(set);
    }
    if let Some(set) = arrival_row(norm) {
        return Some(set);
    }
    let mut window = detect_window_in(norm, Some(state));
    let before: Vec<bool> = norm.tokens.iter().map(|t| t.consumed).collect();
    let mut kept_surface: Option<String> = None;
    let kind = detect_kind_kept(norm, &mut kept_surface);
    let kind_span: Vec<usize> = norm
        .tokens
        .iter()
        .enumerate()
        .filter(|(index, token)| token.consumed && !before[*index])
        .map(|(index, _)| index)
        .collect();

    let kind = match kind {
        Some(kind) => Some(kind),
        None => match label_span(norm) {
            Some(label) if !label_is_noise(&label) => {
                let capitalised = label
                    .chars()
                    .next()
                    .map(char::is_uppercase)
                    .unwrap_or(false);
                Some(if capitalised && label.split_whitespace().count() >= 2 {
                    "parties".to_string()
                } else {
                    "things".to_string()
                })
            }
            _ => None,
        },
    };
    let kind = match kind {
        Some(kind) => Some(kind),
        // "this week?" — a fragment that is nothing but a period, with no
        // session behind it, is the diary.
        None if window.is_some() && state.previous().is_none() => Some("events".into()),
        other => other,
    };
    let Some(kind) = kind else {
        if !allow_ref {
            return None;
        }
        // No noun: the subject is the one the previous turn established.
        let reference = pronoun(norm).unwrap_or(if allow_ref { "them" } else { "it" });
        let mut set = Set::Ref(reference.to_string());
        let inherited = state.last_kind.clone().unwrap_or_else(|| "things".into());
        if let Some(w) = window.take() {
            let field = lexicon()
                .kind_of_field
                .get(&inherited)
                .cloned()
                .unwrap_or_else(|| "created_at".into());
            set = Set::Filter(Box::new(set), Pred::During(field, w));
        }
        let mut scratch = norm.clone();
        if let Some(pred) = predicates(&mut scratch, &inherited, &mut window)
            && pred != status_open()
        {
            set = Set::Filter(Box::new(set), pred);
        }
        return Some(set);
    };

    let mut pred_scratch = norm.clone();
    let pred = predicates(&mut pred_scratch, &kind, &mut window);
    *norm = pred_scratch;

    // A link walk: the noun of another board sits behind `of`, `for`, `from`,
    // `in`, or a possessive.
    let mut base = Set::Kind(kind.clone());
    if let Some(from) = walk_source(norm, state, &kind) {
        base = Set::Walk {
            kind: kind.clone(),
            from: Box::new(from),
        };
    }

    if let Some(literal) = quoted_literal(norm)
        && !matches!(base, Set::Walk { .. })
    {
        base = Set::Called(Box::new(base), literal);
        if let Some(pred) = pred {
            base = Set::Filter(Box::new(base), pred);
        }
        if let Some(w) = window {
            base = Set::During(Box::new(base), w);
        }
        return Some(base);
    }
    if !matches!(base, Set::Walk { .. })
        && let Some(surface) = kept_surface.clone()
        && label_span(norm)
            .map(|found| found.split_whitespace().count() <= surface.split_whitespace().count())
            .unwrap_or(true)
    {
        base = Set::Called(Box::new(base), surface);
    } else if !matches!(base, Set::Walk { .. }) {
        match label_span(norm) {
            Some(label) if !label_is_noise(&label) => {
                base = Set::Called(Box::new(base), extend_label(norm, &label, &kind_span));
            }
            // The member pointed instead of naming: the label the previous
            // turn established is the one they mean (DEFECTS.md, `s06`/t2).
            _ => {
                if pronoun(norm).is_some()
                    && let Some(previous) = state.last_label.clone()
                {
                    base = Set::Called(Box::new(base), previous);
                }
            }
        }
    }
    if let Some(pred) = pred {
        base = Set::Filter(Box::new(base), pred);
    }
    if kind == "tasks"
        && matches!(window, Some(Window::Date(_)))
        && !matches!(base, Set::Called(_, _))
    {
        let field = "due_at".to_string();
        if let Some(w) = window.take() {
            base = Set::Filter(Box::new(base), Pred::During(field.clone(), w));
        }
        base = Set::Order {
            set: Box::new(base),
            field,
            desc: false,
        };
    }
    if kind == "tasks" && matches!(base, Set::Called(_, _)) {
        base = Set::Order {
            set: Box::new(base),
            field: "due_at".into(),
            desc: false,
        };
    }
    if let Some(w) = window {
        base = match kind.as_str() {
            "events" | "things" | "journal notes" => Set::During(Box::new(base), w),
            _ => {
                let field = lexicon()
                    .kind_of_field
                    .get(&kind)
                    .cloned()
                    .unwrap_or_else(|| "created_at".into());
                Set::Filter(Box::new(base), Pred::During(field, w))
            }
        };
    }
    if norm.has("ordered by") {
        // never said in English; ordering is inferred below
    }
    Some(base)
}

/// A capitalised name keeps the board noun that sits inside it: "the Emerald
/// Bay permit" is one document title, not the permit board filtered by a bay.
fn extend_label(norm: &Norm, label: &str, kind_span: &[usize]) -> String {
    let all_capitalised = label
        .split_whitespace()
        .all(|word| word.chars().next().map(char::is_uppercase).unwrap_or(false));
    if !all_capitalised {
        return label.to_string();
    }
    let Some(end) = norm.locate(&label.to_lowercase()).map(|(_, end)| end) else {
        return label.to_string();
    };
    if kind_span.contains(&end) {
        return format!("{label} {}", norm.tokens[end].original);
    }
    label.to_string()
}

fn label_is_noise(label: &str) -> bool {
    let lower = label.to_lowercase();
    // A two-letter leftover is a function word the stop list missed, not a
    // name the vault could resolve.
    if lower.split_whitespace().count() == 1 && lower.chars().count() <= 2 {
        return true;
    }
    matches!(
        lower.as_str(),
        "" | "got"
            | "have"
            | "thing"
            | "things"
            | "stuff"
            | "one"
            | "ones"
            | "left"
            | "still"
            | "coming"
            | "owe"
            | "owes"
            | "much"
            | "many"
            | "come"
            | "altogether"
            | "now"
            | "again"
            | "back"
            | "money"
            | "owe money"
            | "actual"
            | "into"
            | "big thing"
            | "next couple"
            | "write"
            | "wrote"
            | "supposed"
            | "call"
            | "happening"
            | "scheduled"
            | "busy"
            | "planned"
            | "going"
            | "behind"
            | "finished"
            | "flagged"
            | "undated"
            | "marked as"
            | "running total"
            // Words that talk ABOUT the request rather than about a row.
            // A single one of them as the whole literal is the parser having
            // found nothing, and `called "name"` over a board is a board dump
            // dressed as an answer.
            | "marked"
            | "filed"
            | "stored"
            | "saved"
            | "tagged"
            | "listed"
            | "list"
            | "order"
            | "ordered"
            | "sorted"
            | "falling"
            | "holds"
            | "hold"
            | "rest"
            | "bring"
            | "assemble"
            | "summarise"
            | "summarize"
            | "erase"
            | "name"
            | "names"
            | "anywhere"
            | "somewhere"
            | "title"
            | "titled"
            | "called"
            | "spelling"
            | "word"
            | "words"
            | "say"
            | "says"
            | "said"
            | "share"
            | "everyone"
            | "anyone"
            | "count"
    )
}

/// `Kind of Set` — the walk. Returns the INNER set when the sentence names one.
fn walk_source(norm: &mut Norm, state: &ParseState, kind: &str) -> Option<Set> {
    let lex = lexicon();
    // "<Name>'s birthday", "Ana Ferreira's birthday"
    if let Some(index) = norm
        .tokens
        .iter()
        .position(|t| !t.consumed && (t.lower.ends_with("'s") || t.original.ends_with("'s")))
    {
        let owner = norm.tokens[index]
            .original
            .trim_end_matches("'s")
            .trim_end_matches("’s")
            .to_string();
        if norm.tokens[index].capitalised && !owner.is_empty() {
            let mut names = vec![owner];
            // a capitalised word before it is part of the name
            let mut back = index;
            while back > 0 && norm.tokens[back - 1].capitalised && !norm.tokens[back - 1].consumed {
                names.insert(0, norm.tokens[back - 1].original.clone());
                back -= 1;
            }
            norm.consume((back, index + 1));
            return Some(Set::Called(
                Box::new(Set::Kind("parties".into())),
                names.join(" "),
            ));
        }
    }
    // "who's coming to X", "who is in X", "photos from X", "expenses in the X group"
    let owner_kind = match kind {
        "parties" => {
            if norm.has("coming to") || norm.has("in the diary") || norm.has("at the") {
                Some("events")
            } else {
                None
            }
        }
        "events" if norm.has("with") => Some("parties"),
        "photos" if norm.has("from") || norm.has("taken") || norm.has("at the") => Some("places"),
        "places" if norm.has("where") => Some("photos"),
        "albums" => Some("photos"),
        "expenses" | "members" | "settlements"
            if norm.has("group")
                || norm.has("trip")
                || norm.has("on the")
                || norm.has("for the")
                || norm.has("weekend") =>
        {
            Some("groups")
        }
        "obligations" => Some("parties"),
        "important dates" | "contact channels" | "profiles" | "activities" => Some("parties"),
        _ => None,
    }?;
    let mut inner = norm.clone();
    // The inner board's own noun, if the member said it.
    for surface in lex.kinds.get(owner_kind).into_iter().flatten() {
        if let Some(span) = inner.locate(surface) {
            inner.consume(span);
            if let Some(span) = norm.locate(surface) {
                norm.consume(span);
            }
        }
    }
    let Some(label) = label_span(norm) else {
        // "what album is that in?" — the source is the previous answer.
        return pronoun(norm).map(|p| Set::Ref(p.to_string()));
    };
    if label_is_noise(&label) {
        // "the trip group" with nothing else said: the previous subject.
        let _ = state;
        return None;
    }
    if let Some(span) = norm.locate(&label.to_lowercase()) {
        norm.consume(span);
    }
    Some(Set::Called(Box::new(Set::Kind(owner_kind.into())), label))
}

// ---------------------------------------------------------------------------
// Values.
// ---------------------------------------------------------------------------

fn value_turn(norm: &mut Norm, state: &ParseState) -> Option<(Turn, Move)> {
    let text = norm.text.clone();
    // "when is my dentist thing" projects a date off a row the member did not
    // say the board of; "is the cabin booked" projects its status.
    if text.starts_with("when is") || text.starts_with("when do") || text.starts_with("what time") {
        let mut scratch = norm.clone();
        for phrase in ["when is", "when do", "what time", "my", "the"] {
            scratch.consume_phrase(phrase);
        }
        if scratch.has("thing") || scratch.has("things") {
            for phrase in ["thing", "things"] {
                scratch.consume_phrase(phrase);
            }
            if let Some(label) = label_span(&scratch)
                && !label_is_noise(&label)
            {
                return Some((
                    Turn::Value(Value::Project {
                        field: "dtstart".into(),
                        set: Box::new(Set::Called(Box::new(Set::Kind("things".into())), label)),
                    }),
                    Move::New,
                ));
            }
        }
    }
    if (text.starts_with("is the") || text.starts_with("is my") || text.starts_with("has the"))
        && (text.ends_with("booked")
            || text.ends_with("done")
            || text.ends_with("sorted")
            || text.ends_with("finished"))
    {
        let mut scratch = norm.clone();
        for phrase in [
            "is the", "is my", "has the", "booked", "done", "sorted", "finished", "been",
        ] {
            scratch.consume_phrase(phrase);
        }
        let label = label_span(&scratch)?;
        return Some((
            Turn::Value(Value::Project {
                field: "status".into(),
                set: Box::new(Set::Called(Box::new(Set::Kind("things".into())), label)),
            }),
            Move::New,
        ));
    }
    // "what did I spend on X" is a fold, not a list.
    if text.starts_with("what did i spend")
        || text.starts_with("what did we spend")
        || text.starts_with("what have we spent")
        || text.starts_with("what have i spent")
        || text.contains("cost us")
        || text.contains("cost me")
        || text.starts_with("what did it come to")
    {
        let mut scratch = norm.clone();
        for phrase in [
            "what did i spend",
            "what did we spend",
            "what have we spent",
            "what have i spent",
            "cost us",
            "cost me",
            "what has",
        ] {
            scratch.consume_phrase(phrase);
        }
        let set = moneyed(build_set(&mut scratch, state, true)?);
        return Some((
            Turn::Value(Value::Fold {
                agg: "sum".into(),
                field: "amount_minor".into(),
                set: Box::new(set),
            }),
            Move::New,
        ));
    }
    let counting = norm.has("how many")
        || norm.has("how much")
        || text.starts_with("count ")
        || text.starts_with("how long");
    let totalling = norm.has("come to")
        || norm.has("altogether")
        || norm.has("in total")
        || norm.has("running total")
        || norm.has("total")
        || norm.has("add up to")
        || norm.has("what is that");
    let asking_amount = norm.has("how much");

    // `balance of (member) in (group)` — the one aggregate the app owns.
    if asking_amount
        && (norm.has("owe me") || norm.has("owes me"))
        && (norm.has("group") || norm.has("for the trip"))
    {
        let mut scratch = norm.clone();
        let who = label_span(&scratch)?;
        scratch.tokens.iter_mut().for_each(|t| t.consumed = true);
        return Some((
            Turn::Value(Value::Balance {
                of: Box::new(Set::Called(Box::new(Set::Kind("members".into())), who)),
                in_group: Box::new(match state.last_label.clone() {
                    Some(name) => Set::Called(Box::new(Set::Kind("groups".into())), name),
                    None => Set::Kind("groups".into()),
                }),
            }),
            Move::New,
        ));
    }

    if norm.has("how often") {
        let mut scratch = norm.clone();
        let who = label_span(&scratch);
        let _ = &mut scratch;
        let set = match who {
            Some(name) if !label_is_noise(&name) => Set::Walk {
                kind: "profiles".into(),
                from: Box::new(Set::Called(Box::new(Set::Kind("parties".into())), name)),
            },
            _ => Set::Kind("profiles".into()),
        };
        return Some((
            Turn::Value(Value::Project {
                field: "cadence_days".into(),
                set: Box::new(set),
            }),
            Move::New,
        ));
    }

    if !counting && !totalling {
        return None;
    }

    // "how much?" on its own is a fold over what the last turn answered.
    let bare = norm.tokens.len() <= 3;
    if bare || totalling {
        let set = if bare {
            let held = Set::Ref(pronoun(norm).unwrap_or("it").to_string());
            match state.last_kind.as_deref() {
                Some("parties") | Some("members") => Set::Walk {
                    kind: "obligations".into(),
                    from: Box::new(held),
                },
                _ => held,
            }
        } else {
            let mut scratch = norm.clone();
            for phrase in ["come to", "altogether", "in total", "total", "what is that"] {
                scratch.consume_phrase(phrase);
            }
            build_set(&mut scratch, state, true)?
        };
        let field = fold_field(state);
        return Some((
            Turn::Value(Value::Fold {
                agg: "sum".into(),
                field,
                set: Box::new(set),
            }),
            Move::Act,
        ));
    }

    let counting_rows = norm.has("how many") || text.starts_with("count ");
    let set = build_set(norm, state, true)?;
    let moneyed = matches!(
        set.head_kind(),
        Some("expenses") | Some("obligations") | Some("settlements") | Some("groups")
    );
    let counting_rows = counting_rows || !moneyed;
    let turn = if counting_rows {
        Turn::Value(Value::Count(Box::new(set)))
    } else {
        Turn::Value(Value::Fold {
            agg: "sum".into(),
            field: "amount_minor".into(),
            set: Box::new(set),
        })
    };
    Some((turn, Move::New))
}

/// A turn that asks what something COST is over the money boards. Where the
/// noun assembly landed on some other board — a member says "the trip", and a
/// trip is a group, a place and a set of pictures — the fold is re-based on
/// the expenses that board reaches, because `amount_minor` lives nowhere else.
fn moneyed(set: Set) -> Set {
    if matches!(
        set.head_kind(),
        Some("expenses") | Some("obligations") | Some("settlements")
    ) {
        return set;
    }
    match first_label(&set) {
        Some(label) => Set::Walk {
            kind: "expenses".into(),
            from: Box::new(Set::Called(Box::new(Set::Kind("groups".into())), label)),
        },
        None => Set::Kind("expenses".into()),
    }
}

fn fold_field(state: &ParseState) -> String {
    match state.last_kind.as_deref() {
        Some("tasks") => "effort_min".into(),
        _ => "amount_minor".into(),
    }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE VERB TABLE. `lexicon.json`'s `write_verbs` is the one place a write is
// recognised; every arm below is a CONSTRUCTOR for a row of it, never a second
// place a surface form is spelled.
// ---------------------------------------------------------------------------

/// The longest surface in the table that this sentence contains, with its
/// guards satisfied. Ties go to the earlier row, which is why the table is
/// ordered most-specific-first.
fn write_probe(norm: &Norm) -> Option<&'static WriteVerb> {
    let lex = lexicon();
    let mut best: Option<(usize, usize, &'static WriteVerb)> = None; // (words, -index)
    for (index, entry) in lex.write_verbs.iter().enumerate() {
        if entry.bars.iter().any(|bar| norm.has(bar)) {
            continue;
        }
        if !entry.needs.is_empty()
            && !entry.needs.iter().any(|need| {
                if need == "#money" {
                    money_amount(norm).is_some_and(|value| value > 0)
                } else {
                    norm.has(need)
                }
            })
        {
            continue;
        }
        let Some(words) = entry
            .surfaces
            .iter()
            .filter(|surface| norm.has(surface))
            .map(|surface| surface.split_whitespace().count())
            .max()
        else {
            continue;
        };
        if best
            .as_ref()
            .map(|(w, i, _)| words > *w || (words == *w && index < *i))
            .unwrap_or(true)
        {
            best = Some((words, index, entry));
        }
    }
    best.map(|(_, _, entry)| entry)
}

/// Every word the matched row spends, so what is left is the member's own span.
fn spend_surfaces(scratch: &mut Norm, entry: &WriteVerb) {
    let mut surfaces: Vec<&String> = entry.surfaces.iter().collect();
    surfaces.sort_by_key(|s| std::cmp::Reverse(s.split_whitespace().count()));
    for surface in surfaces {
        scratch.consume_phrase(surface);
    }
}

/// The anchor of a write that named no set of its own.
///
/// GRAMMAR.md 3: a write with no subject of its own inherits the one the
/// session is holding, and the REF follows the it/them convention — one row is
/// `it`, several are `them`. The member's own pronoun wins when they used one,
/// because that is them saying which they mean.
fn bare_anchor(norm: &Norm, state: &ParseState) -> Set {
    if let Some(word) = pronoun(norm) {
        return Set::Ref(word.to_string());
    }
    match state.held_rows {
        Some(count) if count > 1 => Set::Ref("them".into()),
        _ => Set::Ref("it".into()),
    }
}

/// The anchor a write names, or the one the session holds.
fn write_anchor(scratch: &mut Norm, norm: &Norm, state: &ParseState) -> Set {
    if let Some(set) = ordinal_ref(&mut scratch.clone()) {
        return set;
    }
    if let Some(set) = build_set(scratch, state, false)
        && !matches!(set, Set::Ref(_))
    {
        return set;
    }
    bare_anchor(norm, state)
}

/// The span the member left after the verb spent its own words: a NAME for the
/// row, when it is not noise.
fn residual_label(scratch: &Norm) -> Option<String> {
    match label_span(scratch) {
        Some(label) if !label_is_noise(&label) => Some(label),
        _ => None,
    }
}

/// `called "X"` / `titled "X"` / `under "X"` — the member naming a new row.
fn given_name(norm: &Norm) -> Option<String> {
    if let Some(quoted) = quoted_any(norm) {
        return Some(quoted);
    }
    for lead in ["called", "titled", "named", "under", "for"] {
        if let Some((_, end)) = norm.locate(lead) {
            let words: Vec<String> = norm.tokens[end..]
                .iter()
                .take_while(|t| !t.consumed && t.lower.chars().any(char::is_alphanumeric))
                .map(|t| {
                    t.original
                        .trim_matches(|c: char| c == '"' || c == '\'')
                        .to_string()
                })
                .collect();
            if !words.is_empty() {
                return Some(words.join(" "));
            }
        }
    }
    None
}

/// A quoted span of any length — `'Firewood'` as readily as `'Cabin checklist'`.
fn quoted_any(norm: &Norm) -> Option<String> {
    for mark in ['"', '\'', '\u{2018}', '\u{201c}'] {
        let close = match mark {
            '\u{2018}' => '\u{2019}',
            '\u{201c}' => '\u{201d}',
            other => other,
        };
        if let Some(open_at) = norm.raw.find(mark)
            && let Some(rest) = norm.raw.get(open_at + mark.len_utf8()..)
            && let Some(shut) = rest.find(close)
        {
            let inner = rest[..shut].trim();
            // An apostrophe inside a word is not a quotation mark.
            if !inner.is_empty() && inner.chars().next().is_some_and(|c| !c.is_whitespace()) {
                let plausible =
                    mark != '\'' || open_at == 0 || norm.raw.as_bytes()[open_at - 1] == b' ';
                if plausible {
                    return Some(inner.to_string());
                }
            }
        }
    }
    None
}

fn command(norm: &mut Norm, state: &ParseState) -> Option<(Turn, Move)> {
    let text = norm.text.clone();
    let entry = write_probe(norm)?;

    // "did I bin the library books task?" asks a question about the bin; it
    // does not ask for one. A leading interrogative rules out every write but
    // a DISCLOSURE, which is the one act a member does phrase as a question.
    if !entry.question_ok {
        for opener in [
            "did i",
            "have i",
            "do i",
            "is there",
            "was there",
            "what",
            "who",
            "when",
            "where",
            "which",
            "how",
            "am i",
            "are there",
            "is the",
            "is my",
            "i am looking",
        ] {
            if text.starts_with(opener) {
                return None;
            }
        }
    }

    let mut scratch = norm.clone();
    spend_surfaces(&mut scratch, entry);

    match entry.verb.as_str() {
        // -- disclosure ------------------------------------------------------
        "locker.reveal_receipt" => {
            for phrase in [
                "password", "passcode", "code", "login", "for the", "too", "that",
            ] {
                scratch.consume_phrase(phrase);
            }
            let anchor = match residual_label(&scratch) {
                Some(label) => Set::Called(Box::new(Set::Kind("locker items".into())), label),
                None => bare_anchor(norm, state),
            };
            Some((
                Turn::Cmd {
                    verb: "locker.reveal_receipt".into(),
                    args: vec![("columns".into(), ArgVal::Lit("\"password\"".into()))],
                    on: Some(anchor),
                },
                Move::Act,
            ))
        }

        "locker.add_item" => Some((locker_add(norm), Move::New)),

        // -- people ----------------------------------------------------------
        "people.log_interaction" => {
            let kind = if norm.has("messaged") || norm.has("texted") || norm.has("message") {
                "message"
            } else if norm.has("emailed") || norm.has("email") {
                "email"
            } else if norm.has("met") || norm.has("saw") {
                "meeting"
            } else {
                "call"
            };
            for phrase in [
                "called",
                "spoke to",
                "spoke",
                "talked to",
                "rang",
                "telephoned",
                "messaged",
                "texted",
                "emailed",
                "met",
                "saw",
                "about it",
                "about",
                "today",
                "this morning",
                "a telephone call with",
                "a call with",
                "an interaction with",
                "with",
                "i",
            ] {
                scratch.consume_phrase(phrase);
            }
            let anchor = match residual_label(&scratch) {
                Some(name) => Set::Called(Box::new(Set::Kind("parties".into())), name),
                None => bare_anchor(norm, state),
            };
            Some((
                Turn::Cmd {
                    verb: "people.log_interaction".into(),
                    args: vec![
                        ("kind".into(), ArgVal::Lit(super::tree::quote(kind))),
                        (
                            "since".into(),
                            ArgVal::Lit(calendar::iso(calendar::today_days())),
                        ),
                    ],
                    on: Some(anchor),
                },
                Move::New,
            ))
        }

        "people.trash_person" => {
            for phrase in [
                "from my contacts",
                "off my contacts",
                "my contacts",
                "contact list",
                "contacts",
                "we have lost touch",
                "from",
                "off",
            ] {
                scratch.consume_phrase(phrase);
            }
            let anchor = match residual_label(&scratch) {
                Some(name) => Set::Called(Box::new(Set::Kind("parties".into())), name),
                None => bare_anchor(norm, state),
            };
            Some((
                Turn::Cmd {
                    verb: "people.trash_person".into(),
                    args: vec![],
                    on: Some(anchor),
                },
                Move::New,
            ))
        }

        // -- money -----------------------------------------------------------
        "tally.settle_up" => {
            let group = Set::Called(
                Box::new(Set::Kind("groups".into())),
                state
                    .last_label
                    .clone()
                    .unwrap_or_else(|| "Tahoe Trip".into()),
            );
            Some((
                Turn::Cmd {
                    verb: "tally.settle_up".into(),
                    args: vec![
                        ("to_party".into(), ArgVal::Lit("me".into())),
                        ("group_id".into(), ArgVal::Set(group.clone())),
                        (
                            "amount_minor".into(),
                            ArgVal::Value(Value::Balance {
                                of: Box::new(Set::Ref("it".into())),
                                in_group: Box::new(group.clone()),
                            }),
                        ),
                    ],
                    on: Some(Set::Filter(
                        Box::new(Set::Walk {
                            kind: "members".into(),
                            from: Box::new(group),
                        }),
                        Pred::Is {
                            field: "party_id".into(),
                            what: "me".into(),
                            negated: true,
                        },
                    )),
                },
                Move::New,
            ))
        }

        "people.settle_debt" => {
            for phrase in ["balance", "with", "up", "off", "out", "it", "that"] {
                scratch.consume_phrase(phrase);
            }
            let inner = match residual_label(&scratch) {
                Some(name) => Set::Called(Box::new(Set::Kind("parties".into())), name),
                None => bare_anchor(norm, state),
            };
            Some((
                Turn::Cmd {
                    verb: "people.settle_debt".into(),
                    args: vec![],
                    on: Some(Set::Walk {
                        kind: "obligations".into(),
                        from: Box::new(inner),
                    }),
                },
                Move::Act,
            ))
        }

        "tally.add_expense" => Some((add_expense(norm, state), Move::New)),

        "tally.add_group_member" => {
            let group = group_name(&scratch)
                .or_else(|| state.last_label.clone())
                .unwrap_or_else(|| "Tahoe Trip".into());
            consume_label(&mut scratch, &group);
            for phrase in ["to the", "to", "group", "roster"] {
                scratch.consume_phrase(phrase);
            }
            let who = match residual_label(&scratch) {
                Some(name) => Set::Called(Box::new(Set::Kind("parties".into())), name),
                None => bare_anchor(norm, state),
            };
            Some((
                Turn::Cmd {
                    verb: "tally.add_group_member".into(),
                    args: vec![(
                        "group_id".into(),
                        ArgVal::Set(Set::Called(Box::new(Set::Kind("groups".into())), group)),
                    )],
                    on: Some(who),
                },
                Move::New,
            ))
        }

        // -- photos ----------------------------------------------------------
        "media.add_to_album" => {
            let album = album_name(&mut scratch);
            consume_label(&mut scratch, &album);
            for phrase in [
                "album", "albums", "roll", "rolls", "under", "in the", "into", "to the", "one",
            ] {
                scratch.consume_phrase(phrase);
            }
            let anchor = match residual_label(&scratch) {
                // Naming WHICH of them only makes sense over several, so the
                // referent this narrows is the plural one whatever pronoun
                // the sentence used about the picture's contents.
                Some(which) => Set::Filter(
                    Box::new(Set::Ref(
                        if state.held_rows == Some(1) {
                            "it"
                        } else {
                            "them"
                        }
                        .into(),
                    )),
                    Pred::Contains("label".into(), which),
                ),
                None => bare_anchor(norm, state),
            };
            Some((
                Turn::Cmd {
                    verb: "media.add_to_album".into(),
                    args: vec![(
                        "album_id".into(),
                        ArgVal::Set(Set::Called(Box::new(Set::Kind("albums".into())), album)),
                    )],
                    on: Some(anchor),
                },
                Move::Act,
            ))
        }

        // -- tasks and the diary ---------------------------------------------
        "schedule.set_task_status" => {
            for phrase in ["as", "off", "both of", "away", "its", "it", "that", "one"] {
                scratch.consume_phrase(phrase);
            }
            let anchor = write_anchor(&mut scratch, norm, state);
            Some((
                Turn::Cmd {
                    verb: "schedule.set_task_status".into(),
                    args: vec![("status".into(), ArgVal::Lit("\"completed\"".into()))],
                    on: Some(anchor),
                },
                Move::Act,
            ))
        }

        "core.star_document" => Some((
            Turn::Cmd {
                verb: "core.star_document".into(),
                args: vec![],
                on: Some(bare_anchor(norm, state)),
            },
            Move::Act,
        )),

        "schedule.cancel_event" => {
            for phrase in ["the", "off"] {
                scratch.consume_phrase(phrase);
            }
            let anchor = match residual_label(&scratch) {
                Some(label) => Set::Called(Box::new(Set::Kind("events".into())), label),
                None => bare_anchor(norm, state),
            };
            Some((
                Turn::Cmd {
                    verb: "schedule.cancel_event".into(),
                    args: vec![],
                    on: Some(anchor),
                },
                Move::New,
            ))
        }

        "schedule.propose_event" => Some((propose_event(norm), Move::New)),
        "schedule.add_task" => Some((add_task(norm, state), Move::New)),

        "knowledge.create_note" => {
            let title = match given_name(norm) {
                Some(name) => capitalise(&name),
                None => free_title(
                    norm,
                    &[
                        "make a note to",
                        "make a note",
                        "add a note to",
                        "add a note",
                        "create a note to",
                        "start me a note",
                        "start a note",
                        "jot down",
                        "note down",
                        "write a note to",
                        "write a note",
                        "open a note",
                    ],
                ),
            };
            Some((
                Turn::Cmd {
                    verb: "knowledge.create_note".into(),
                    args: vec![("title".into(), ArgVal::Lit(super::tree::quote(&title)))],
                    on: None,
                },
                Move::New,
            ))
        }

        "social.send_message" => {
            for phrase in [
                "a text to",
                "a text",
                "a message to",
                "a message",
                "to",
                "and",
                "tell her",
                "tell him",
                "tell them",
            ] {
                scratch.consume_phrase(phrase);
            }
            let who = match residual_label(&scratch) {
                Some(name) => Set::Called(Box::new(Set::Kind("parties".into())), name),
                None => bare_anchor(norm, state),
            };
            Some((
                Turn::Cmd {
                    verb: "social.send_message".into(),
                    args: vec![(
                        "body".into(),
                        ArgVal::Lit(super::tree::quote(&message_body(norm))),
                    )],
                    on: Some(Set::Filter(
                        Box::new(Set::Walk {
                            kind: "contact channels".into(),
                            from: Box::new(who),
                        }),
                        Pred::Cmp("kind".into(), "=".into(), Operand::Lit("\"phone\"".into())),
                    )),
                },
                Move::New,
            ))
        }

        // -- the two classes, and the undo of a bin ---------------------------
        "restore" => {
            for phrase in [
                "that went in the bin",
                "went in the bin",
                "in the bin",
                "by mistake",
                "as well",
                "the",
                "it",
                "that",
                "them",
                "back",
                "on the list",
                "on my list",
            ] {
                scratch.consume_phrase(phrase);
            }
            let named = residual_label(&scratch);
            let kind = named
                .as_ref()
                .and_then(|_| {
                    let mut probe = scratch.clone();
                    detect_kind(&mut probe)
                })
                .or_else(|| state.last_kind.clone())
                .unwrap_or_else(|| "documents".into());
            let verb = lexicon()
                .restore_by_kind
                .get(&kind)
                .cloned()
                .unwrap_or_else(|| "core.restore_document".into());
            let anchor = match named {
                Some(label) => Set::Filter(
                    Box::new(Set::Called(Box::new(Set::Kind(kind)), label)),
                    Pred::Is {
                        field: "deleted_at".into(),
                        what: "null".into(),
                        negated: true,
                    },
                ),
                None => bare_anchor(norm, state),
            };
            Some((
                Turn::Cmd {
                    verb,
                    args: vec![],
                    on: Some(anchor),
                },
                Move::Act,
            ))
        }

        "reschedule" => Some((reschedule(norm, state), Move::Act)),
        "delete" => Some((delete(norm, state), Move::New)),
        _ => None,
    }
}

/// What the member wants said: everything after `tell <someone>` / `say`.
fn message_body(norm: &Norm) -> String {
    for lead in ["tell her", "tell him", "tell them", "tell", "saying", "say"] {
        if let Some((_, end)) = norm.locate(lead) {
            let words: Vec<String> = norm.tokens[end..]
                .iter()
                .map(|t| t.original.clone())
                .collect();
            if !words.is_empty() {
                return capitalise(&words.join(" "));
            }
        }
    }
    String::new()
}

/// `put a haircut on friday at two` — a new diary entry at a stated time.
fn propose_event(norm: &mut Norm) -> Turn {
    let mut scratch = norm.clone();
    let window = detect_window(&mut scratch);
    let hour = clock_hour(norm);
    let summary = match given_name(norm) {
        Some(name) => name,
        None => {
            let mut body = norm.clone();
            for phrase in [
                "put a",
                "put an",
                "put",
                "book a",
                "book an",
                "book",
                "schedule a",
                "schedule",
                "pencil in a",
                "pencil in",
                "set up a",
                "set up",
                "arrange a",
                "arrange",
                "pop a",
                "pop",
                "on the calendar",
                "in the diary",
                "calendar",
                "diary",
                "for",
                "at",
                "on",
            ] {
                body.consume_phrase(phrase);
            }
            let _ = detect_window(&mut body);
            if let Some((start, _)) = body.locate("at") {
                body.consume((start, (start + 2).min(body.tokens.len())));
            }
            capitalise(&residual_label(&body).unwrap_or_else(|| "Event".into()))
        }
    };
    let date = match window {
        Some(Window::Date(date)) if date.len() == 10 => date,
        Some(Window::Phrase(phrase)) => match phrase.as_str() {
            "tomorrow" => calendar::iso(calendar::today_days() + 1),
            _ => calendar::iso(calendar::today_days()),
        },
        _ => calendar::iso(calendar::today_days()),
    };
    let start = hour.unwrap_or(9);
    Turn::Cmd {
        verb: "schedule.propose_event".into(),
        args: vec![
            (
                "summary".into(),
                ArgVal::Lit(super::tree::quote(&capitalise(&summary))),
            ),
            (
                "dtstart".into(),
                ArgVal::Lit(format!("{date}T{start:02}:00")),
            ),
            (
                "dtend".into(),
                ArgVal::Lit(format!("{date}T{:02}:00", start + 1)),
            ),
        ],
        on: None,
    }
}

/// `at two`, `at 10`, `at half past six` — the hour a member states for a diary
/// entry, read on the 24-hour clock the way a day is actually lived: a bare
/// small number after `at` is the afternoon unless they said `am`.
fn clock_hour(norm: &Norm) -> Option<u32> {
    let lex = lexicon();
    let (_, after) = norm.locate("at")?;
    let token = norm.tokens.get(after)?;
    let raw = token
        .lower
        .parse::<i64>()
        .ok()
        .or_else(|| lex.numbers.get(&token.lower).copied())?;
    if !(1..=23).contains(&raw) {
        return None;
    }
    let pm = norm.has("pm") || norm.has("in the afternoon") || norm.has("in the evening");
    let am = norm.has("am") || norm.has("in the morning");
    let hour = u32::try_from(raw).ok()?;
    // A bare small number after `at` is the afternoon unless they said so.
    let afternoon = hour < 12 && ((hour <= 6 && !am) || pm);
    Some(if afternoon { hour + 12 } else { hour })
}

/// `add forty two dollars of gas to the trip group, I paid` — money spent.
fn add_expense(norm: &mut Norm, state: &ParseState) -> Turn {
    let amount = money_amount(norm).unwrap_or(0);
    let description = match quoted_any(norm) {
        Some(name) => name,
        None => {
            let mut body = norm.clone();
            for token in &mut body.tokens {
                if token.lower.parse::<f64>().is_ok()
                    || lexicon().numbers.contains_key(&token.lower)
                    || token.original.contains('$')
                {
                    token.consumed = true;
                }
            }
            for phrase in [
                "add",
                "log",
                "record",
                "put",
                "charge",
                "bill",
                "stick",
                "spent",
                "dollars",
                "dollar",
                "quid",
                "pounds",
                "euros",
                "of",
                "for",
                "to the",
                "to",
                "group",
                "trip",
                "i paid",
                "paid by me",
                "paid it",
                "i paid it",
                "expense",
                "an",
                "a",
            ] {
                body.consume_phrase(phrase);
            }
            residual_label(&body).unwrap_or_else(|| "Expense".into())
        }
    };
    let group = {
        let mut body = norm.clone();
        consume_label(&mut body, &description);
        for phrase in [
            "add",
            "log",
            "record",
            "put",
            "charge",
            "of",
            "for",
            "i paid",
            "paid by me",
        ] {
            body.consume_phrase(phrase);
        }
        group_name(&body).or_else(|| state.last_label.clone())
    };
    let mut args = vec![
        (
            "description".into(),
            ArgVal::Lit(super::tree::quote(&capitalise(&description))),
        ),
        ("amount_minor".into(), ArgVal::Lit(amount.to_string())),
    ];
    if norm.has("i paid")
        || norm.has("paid by me")
        || norm.has("i paid it")
        || norm.text.ends_with("i paid")
    {
        args.push(("paid_by".into(), ArgVal::Lit("me".into())));
    }
    if let Some(name) = group {
        args.push((
            "group_id".into(),
            ArgVal::Set(Set::Called(Box::new(Set::Kind("groups".into())), name)),
        ));
    }
    Turn::Cmd {
        verb: "tally.add_expense".into(),
        args,
        on: None,
    }
}

/// The span a member puts immediately before `group` or `trip`.
fn group_name(norm: &Norm) -> Option<String> {
    for head in ["group", "trip", "weekend"] {
        if let Some((start, _)) = norm.locate(head) {
            let mut at = start;
            let mut words: Vec<String> = Vec::new();
            while at > 0 {
                let token = &norm.tokens[at - 1];
                if token.consumed
                    || lexicon().stopwords.contains(&token.lower)
                    || !token.lower.chars().any(char::is_alphanumeric)
                {
                    break;
                }
                words.insert(0, token.original.clone());
                at -= 1;
            }
            if !words.is_empty() {
                let name = words.join(" ");
                if !label_is_noise(&name) {
                    return Some(if head == "group" {
                        name
                    } else {
                        format!("{name} {head}")
                    });
                }
            }
        }
    }
    None
}

/// Money as the minor unit: `$42.50`, `42.50`, `forty two dollars`.
fn money_amount(norm: &Norm) -> Option<i64> {
    for token in &norm.tokens {
        let cleaned: String = token
            .original
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        if (token.original.contains('$') || cleaned.contains('.'))
            && let Ok(value) = cleaned.parse::<f64>()
            && value > 0.0
        {
            return Some((value * 100.0).round() as i64);
        }
    }
    money_minor(norm).map(|whole| whole * 100)
}

/// The album a member names: the span that sits immediately BEFORE the album
/// noun ("the Tahoe scouting album") or immediately after `under`/`into`
/// ("file that under Mendocino scouting"). Taking the longest capitalised run
/// instead picks the person in the picture over the album it goes in.
fn album_name(norm: &mut Norm) -> String {
    let lex = lexicon();
    for head in ["album", "albums", "roll", "rolls"] {
        if let Some((start, _)) = norm.locate(head) {
            let mut at = start;
            let mut words: Vec<String> = Vec::new();
            while at > 0 {
                let token = &norm.tokens[at - 1];
                if token.consumed
                    || lex.stopwords.contains(&token.lower)
                    || !token.lower.chars().any(char::is_alphanumeric)
                {
                    break;
                }
                words.insert(0, token.original.clone());
                at -= 1;
            }
            if !words.is_empty() {
                let name = words.join(" ");
                if !label_is_noise(&name) {
                    return name;
                }
            }
        }
    }
    for lead in ["under", "into", "in to"] {
        if let Some((_, end)) = norm.locate(lead) {
            let words: Vec<String> = norm.tokens[end..]
                .iter()
                .skip_while(|t| lex.stopwords.contains(&t.lower))
                .take_while(|t| {
                    !t.consumed
                        && !lex.stopwords.contains(&t.lower)
                        && t.lower.chars().any(char::is_alphanumeric)
                })
                .map(|t| t.original.clone())
                .collect();
            if !words.is_empty() {
                return words.join(" ");
            }
        }
    }
    let mut scratch = norm.clone();
    for phrase in [
        "add the", "put the", "add", "put", "file", "to the", "in the", "album", "one", "the",
    ] {
        scratch.consume_phrase(phrase);
    }
    residual_label(&scratch).unwrap_or_else(|| "Tahoe scouting".into())
}

/// The member's own words after the verb, with THEIR capitalisation kept: a
/// proper noun inside a title ("Call the Truckee place") is the one span the
/// vault can resolve, and lower-casing it destroys it.
fn free_title(norm: &Norm, prefixes: &[&str]) -> String {
    let mut body = original_text(norm);
    for prefix in prefixes {
        if body.to_lowercase().starts_with(prefix) {
            body = body[prefix.len()..].trim().to_string();
            break;
        }
    }
    // Cut a trailing temporal or purposive clause: it is not the title.
    for cut in [
        " before ", " after ", " when ", " while ", " on ", " by ", " due ",
    ] {
        if let Some(at) = body.to_lowercase().find(cut) {
            body = body[..at].to_string();
        }
    }
    capitalise(body.trim())
}

/// The sentence as the member typed it, token by token, with the reading's
/// contractions expanded but nothing lower-cased.
fn original_text(norm: &Norm) -> String {
    norm.tokens
        .iter()
        .map(|t| t.original.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

fn capitalise(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn add_task(norm: &mut Norm, state: &ParseState) -> Turn {
    let mut window_scratch = norm.clone();
    let window = detect_window(&mut window_scratch);
    let title = match given_name(norm) {
        Some(name) => capitalise(&name),
        None => free_title(
            norm,
            &[
                "add a task to",
                "add a task",
                "add task to",
                "make a task to",
                "create a task to",
                "remind me to",
                "add a to-do to",
                "just add a task to",
                "add a job to",
                "open an undated job titled",
                "open an undated job",
                "open a job titled",
                "start a task to",
            ],
        ),
    };
    let mut args = vec![("title".into(), ArgVal::Lit(super::tree::quote(&title)))];
    // "no date on it" is the member saying the field is empty ON PURPOSE,
    // which is a different canonical from not mentioning a date at all.
    if norm.has("no date") || norm.has("no deadline") || norm.has("no due date") {
        args.push(("due_at".into(), ArgVal::Lit("null".into())));
        return Turn::Cmd {
            verb: "schedule.add_task".into(),
            args,
            on: None,
        };
    }
    match window {
        Some(Window::Date(date)) if date.len() == 10 => {
            args.push(("due_at".into(), ArgVal::Lit(format!("{date}T09:00"))));
        }
        Some(Window::Phrase(phrase)) => {
            let days = match phrase.as_str() {
                "today" => Some(calendar::today_days()),
                "tomorrow" => Some(calendar::today_days() + 1),
                _ => None,
            };
            if let Some(days) = days {
                args.push((
                    "due_at".into(),
                    ArgVal::Lit(format!("{}T09:00", calendar::iso(days))),
                ));
            }
        }
        _ => {
            // "before then" anchors on the row the last turn answered.
            if norm.has("before then") || norm.has("before it") {
                let _ = state;
                args.push((
                    "due_at".into(),
                    ArgVal::Value(Value::Project {
                        field: "dtstart".into(),
                        set: Box::new(Set::Ref("it".into())),
                    }),
                ));
            }
        }
    }
    Turn::Cmd {
        verb: "schedule.add_task".into(),
        args,
        on: None,
    }
}

fn locker_add(norm: &mut Norm) -> Turn {
    let digits: Option<String> = norm
        .tokens
        .iter()
        .find(|t| t.lower.chars().all(|c| c.is_ascii_digit()) && t.lower.len() >= 3)
        .map(|t| t.lower.clone());
    let mut scratch = norm.clone();
    for phrase in [
        "save the",
        "save my",
        "store the",
        "keep the",
        "put the",
        "a new login called",
        "a new login",
        "a fresh sign-in under",
        "a fresh sign-in",
        "login",
        "sign-in",
        "called",
        "titled",
        "under",
        "in my locker",
        "to my locker",
        "locker",
    ] {
        scratch.consume_phrase(phrase);
    }
    if let Some(number) = &digits
        && let Some(span) = scratch.locate(number)
    {
        scratch.consume(span);
    }
    let kind = if norm.has("login") || norm.has("sign-in") || norm.has("sign in") {
        "login"
    } else if norm.has("wifi") {
        "wifi"
    } else {
        "note"
    };
    let title = match given_name(norm) {
        Some(name) => name,
        None => capitalise(&label_span(&scratch).unwrap_or_else(|| "Note".into())),
    };
    let mut args = vec![
        ("type".into(), ArgVal::Lit(super::tree::quote(kind))),
        ("title".into(), ArgVal::Lit(super::tree::quote(&title))),
    ];
    if let Some(number) = digits {
        args.push(("content".into(), ArgVal::Lit(super::tree::quote(&number))));
    }
    Turn::Cmd {
        verb: "locker.add_item".into(),
        args,
        on: None,
    }
}

fn reschedule(norm: &mut Norm, state: &ParseState) -> Turn {
    let mut args: Vec<(String, ArgVal)> = Vec::new();
    if norm.has("an hour later") || norm.has("one hour later") || norm.has("back an hour") {
        args.push(("by".into(), ArgVal::Lit("+1h".into())));
    } else {
        let mut scratch = norm.clone();
        if let Some(window) = detect_window(&mut scratch) {
            let to = match window {
                Window::Date(date) => date,
                Window::Phrase(phrase) => match phrase.as_str() {
                    "today" => calendar::iso(calendar::today_days()),
                    "tomorrow" => calendar::iso(calendar::today_days() + 1),
                    _ => calendar::iso(calendar::today_days()),
                },
                _ => calendar::iso(calendar::today_days()),
            };
            args.push(("to".into(), ArgVal::Lit(to)));
        }
    }
    let mut scratch = norm.clone();
    for phrase in [
        "reschedule",
        "move",
        "push",
        "shift",
        "bump",
        "to",
        "the",
        "an hour later",
        "later",
        "both",
    ] {
        scratch.consume_phrase(phrase);
    }
    let _ = detect_window(&mut scratch);
    let anchor = if let Some(set) = ordinal_ref(&mut scratch.clone()) {
        set
    } else {
        match build_set(&mut scratch, state, true) {
            Some(set) => set,
            None => Set::Ref(pronoun(norm).unwrap_or("it").to_string()),
        }
    };
    Turn::Cmd {
        verb: "reschedule".into(),
        args,
        on: Some(anchor),
    }
}

fn delete(norm: &mut Norm, state: &ParseState) -> Turn {
    let mut scratch = norm.clone();
    for phrase in ["delete", "bin", "trash", "get rid of", "chuck", "remove"] {
        scratch.consume_phrase(phrase);
    }
    let kind_scratch = scratch.clone();
    let anchor = build_set(&mut scratch, state, true)
        .unwrap_or_else(|| Set::Ref(pronoun(norm).unwrap_or("it").to_string()));
    let kind = anchor.head_kind().map(|k| k.to_string());
    let verb = match kind.as_deref() {
        Some("documents") => "core.trash_document",
        Some("notes") => "knowledge.delete_note",
        Some("expenses") => "tally.delete_expense",
        Some("parties") => "people.trash_person",
        Some("photos") => "media.delete_asset",
        Some("locker items") => "locker.trash_item",
        Some("tasks") => "schedule.delete_task",
        Some("events") => "schedule.delete_event",
        _ => "delete",
    };
    let _ = kind_scratch;
    Turn::Cmd {
        verb: verb.into(),
        args: vec![],
        on: Some(anchor),
    }
}

// ---------------------------------------------------------------------------
// The `substitute` move: EDIT the previous canonical.
// ---------------------------------------------------------------------------

fn substitute(norm: &mut Norm, state: &ParseState) -> Option<Turn> {
    let previous = state.previous()?;
    if matches!(previous, Turn::Nothing | Turn::Refuse(_)) {
        return None;
    }
    let text = norm.text.clone();
    let short = norm.tokens.len() <= 7;
    // A fragment of three words or fewer, with no verb of its own, is the
    // member naming a new subject for the SAME question ("emerald bay?").
    let fragment = norm.tokens.len() <= 3
        && previous.held_set().is_some()
        && first_label(previous.held_set().unwrap()).is_some();
    let looks_like = fragment
        || text.starts_with("what about")
        || text.starts_with("and ")
        || text.starts_with("the ")
        || text.starts_with("is there a")
        || text.starts_with("was there a")
        || text.starts_with("how about");
    if !short || !looks_like {
        return None;
    }
    // Any clause word means this is a refine, not a swap.
    if text.contains("just ") || text.contains("only ") || text.contains("of those") {
        return None;
    }
    let mut edited = previous.clone();
    let mut changed = false;

    let mut scratch = norm.clone();
    for phrase in [
        "what about",
        "how about",
        "and",
        "is there a",
        "was there a",
        "is there",
        "for it",
        "too",
        "as well",
        "one",
    ] {
        scratch.consume_phrase(phrase);
    }
    let new_kind = detect_kind(&mut scratch);
    if let Some(kind) = new_kind
        && Some(kind.as_str()) != previous.held_set().and_then(|s| s.head_kind())
        && let Turn::Show(set) = &mut edited
    {
        set_head_kind(set, &kind);
        changed = true;
    }
    if let Some(label) = label_span(&scratch)
        && !label_is_noise(&label)
        && let Some(set) = held_set_mut(&mut edited)
        && set.substitute_label(&label)
    {
        changed = true;
    }
    if changed { Some(edited) } else { None }
}

fn held_set_mut(turn: &mut Turn) -> Option<&mut Set> {
    match turn {
        Turn::Show(set) => Some(set),
        Turn::Value(Value::Count(set))
        | Turn::Value(Value::Fold { set, .. })
        | Turn::Value(Value::Project { set, .. }) => Some(set),
        Turn::Cmd { on: Some(set), .. } => Some(set),
        _ => None,
    }
}

fn set_head_kind(set: &mut Set, kind: &str) {
    match set {
        Set::Kind(name) => *name = kind.to_string(),
        Set::Walk { kind: name, .. } => *name = kind.to_string(),
        Set::Called(inner, _)
        | Set::Filter(inner, _)
        | Set::During(inner, _)
        | Set::Order { set: inner, .. }
        | Set::First(_, inner) => set_head_kind(inner, kind),
        Set::Union(l, _) | Set::Except(l, _) => set_head_kind(l, kind),
        Set::Ref(_) => {}
    }
}

/// Exposed for the quoted-literal rule and the tests.
pub fn quoted(request: &str) -> Option<String> {
    quoted_span(&normalise(request))
}
