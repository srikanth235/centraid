//! # `rank` — world-agnostic ranked search over a vault's rendered rows
//!
//! [`Ranker::new`] indexes the rows `show (things)` yields ([`VaultRow`]);
//! [`Ranker::search`] answers one raw request with the top hits, each carrying
//! its inline links, ranked against the request and capped.
//!
//! The ranker's knowledge of the vault is `onto.json`, derived at build time by
//! `build.rs` from the ontology (`derived.json`, `terminals.json`, the app
//! manifests and [`crate::exec::EDGES`]):
//!
//! * kind words / kind intent: kind names, entity names, app names + taglines,
//!   the discriminator enum values (locker type, channel kind, party kind);
//! * links: FK columns, join tables read back as `"<suffix>:<id>"` keys, reader
//!   fields (id lists, title lists), each with a role (belongs / party /
//!   member) and weight;
//! * fields: column shapes (money, date, enum, flag, integer) that render facts
//!   as words.
//!
//! Unknown fields fall back to the same naming conventions (`*_id`, `*_ids`,
//! `*_minor`, `*_at`). The only hand tables are everyday English ([`SYN`],
//! [`PHRASES`]) the ontology cannot give.
//!
//! Three channels, all additive into one score per row:
//!
//! 1. lexical — BM25 over each row's own text (label, facts as words, kind
//!    words) plus a link-weighted match on its neighbours' names;
//! 2. temporal — a date window parsed from the request;
//! 3. session — kind intent, whole-kind listing for small kinds, and anaphora
//!    over the last two answers (their rows, their links, their names).
//!
//! This is a port of the Python prototype `ranker.py` and is held to it turn
//! for turn (`rank-eval --dump`): orderings and float sums follow the
//! prototype's, so a tie breaks the same way in both.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;

use centraid_evalsuite::VaultRow;
use indexmap::IndexMap;
use regex::Regex;

use crate::parse::calendar::{civil_from_days, days_from_civil};

/// Hits taken before whole-kind listing (the prototype's `K`).
pub const DEFAULT_K: usize = 6;
/// Words about the bin itself, not about which row: "the deleted funnel photo".
const TRASH_WORDS: [&str; 10] = [
    "delete", "deleted", "trash", "trashed", "bin", "binned", "remove", "removed", "restore",
    "undelete",
];

/// A named kind with at most this many live rows is listed whole.
const LISTABLE_MAX: usize = 30;
/// Inline links shown per hit (per linked kind), ranked against the query.
const MAX_INLINE: usize = 8;

const STOP: &str = "a an the of to in on for my me i is are was were it its what whats who whos
when how much many do does did have has got any anything and or with that this those these
them there their her his she he about at by from be am just can could please show tell find
list give all some so if not no we our us you your pull up bring out again want need would
should will let get see look which where";

const NUM: [(&str, u32); 15] = [
    ("one", 1),
    ("two", 2),
    ("three", 3),
    ("four", 4),
    ("five", 5),
    ("six", 6),
    ("seven", 7),
    ("eight", 8),
    ("nine", 9),
    ("ten", 10),
    ("twenty", 20),
    ("thirty", 30),
    ("forty", 40),
    ("fifty", 50),
    ("sixty", 60),
];

/// Everyday phrasings rewritten to one word before tokenizing, in order.
pub const PHRASES: &[(&str, &str)] = &[
    (r"\bto[- ]?dos?\b", "task"),
    (r"\bsign[- ]?ins?\b", "login"),
    (r"\blog[- ]?ins?\b", "login"),
    (r"\bpass ?codes?\b", "password"),
    (r"\bwi[- ]?fi\b", "wifi"),
    (r"\bbehind schedule\b", "overdue"),
    (r"\bpast due\b", "overdue"),
    (r"\brunning late\b", "overdue"),
    (r"\bslipped\b", "overdue"),
    (r"\bfallen behind\b", "overdue"),
    (r"\btick(?:ed)? off\b", "completed"),
    (r"\b(?:my|the) (?:to-?do )?list\b", "task"),
    (r"\bstill (?:on|to)\b", "open"),
    (r"\bcrossed off\b", "completed"),
    (r"\bgot done\b", "completed"),
    (r"\bnot (yet )?done\b", "open"),
    (r"\bstill to do\b", "open"),
    (r"\bguest list\b", "attendee"),
    (
        r"\bwho(?:'s| is| was| are) (?:coming|going|invited|attending)\b",
        "attendee",
    ),
    (r"\bphone numbers?\b", "number"),
    (r"\bcheck[- ]in\b", "checkin"),
    (r"\bcheck[- ]out\b", "checkout"),
    (r"\bname days?\b", "nameday"),
    (
        r"\b(?:owes?|owed|owing|in debt|indebted)(?: to)? me\b",
        "receivable owe",
    ),
    (
        r"\bi owe\b|\bi(?:'m| am) (?:owing|in debt)\b|\bowed? by me\b",
        "payable owe",
    ),
    (r"\bmoved in\b", "movedin"),
];

/// Everyday word -> ontology words (kind intent words, subkinds, fact words)
/// it means, with a weight.
pub const SYN: &[(&str, &[(&str, f64)])] = &[
    (
        "diary",
        &[("event", 0.8), ("calendar", 0.8), ("journal", 0.5)],
    ),
    ("jotted", &[("note", 0.8)]),
    ("wrote", &[("note", 0.8)]),
    ("write", &[("note", 0.8)]),
    ("writeup", &[("note", 0.8)]),
    ("memo", &[("note", 0.8)]),
    ("entry", &[("note", 0.8)]),
    ("entrie", &[("note", 0.8)]),
    ("advice", &[("note", 0.8)]),
    ("said", &[("note", 0.8)]),
    ("appointment", &[("event", 0.8)]),
    ("seeing", &[("event", 0.8)]),
    ("meet", &[("event", 0.8)]),
    ("visit", &[("event", 0.8)]),
    ("appt", &[("event", 0.8)]),
    ("meeting", &[("event", 0.8)]),
    ("plan", &[("event", 0.8)]),
    ("booked", &[("event", 0.8)]),
    ("booking", &[("event", 0.8)]),
    ("schedule", &[("event", 0.8)]),
    ("happening", &[("event", 0.8)]),
    ("engagement", &[("event", 0.8)]),
    ("job", &[("task", 0.8)]),
    ("chore", &[("task", 0.8)]),
    ("errand", &[("task", 0.8)]),
    ("reminder", &[("task", 0.8)]),
    ("todo", &[("task", 0.8)]),
    ("action", &[("task", 0.8)]),
    ("work", &[("task", 0.5)]),
    ("paper", &[("document", 0.8)]),
    ("paperwork", &[("document", 0.8)]),
    ("file", &[("document", 0.8)]),
    ("filed", &[("document", 0.8)]),
    ("certificate", &[("document", 0.8)]),
    ("scan", &[("document", 0.8)]),
    ("pdf", &[("document", 0.8)]),
    ("statement", &[("document", 0.8)]),
    ("receipt", &[("document", 0.8), ("expense", 0.8)]),
    ("credential", &[("login", 0.8)]),
    ("account", &[("login", 0.8)]),
    ("pin", &[("login", 0.8), ("card", 0.8)]),
    ("network", &[("wifi", 0.8)]),
    ("photograph", &[("photo", 0.8)]),
    ("pic", &[("photo", 0.8)]),
    ("picture", &[("photo", 0.8)]),
    ("snap", &[("photo", 0.8)]),
    ("shot", &[("photo", 0.8)]),
    ("image", &[("photo", 0.8)]),
    ("selfie", &[("photo", 0.8)]),
    ("snapshot", &[("photo", 0.8)]),
    ("collection", &[("album", 0.8)]),
    ("location", &[("place", 0.8)]),
    ("venue", &[("place", 0.8)]),
    ("spot", &[("place", 0.8)]),
    ("people", &[("person", 0.8)]),
    ("contact", &[("person", 0.8)]),
    ("friend", &[("person", 0.8)]),
    ("relative", &[("person", 0.8)]),
    ("family", &[("person", 0.8)]),
    ("guy", &[("person", 0.8)]),
    ("number", &[("phone", 0.8)]),
    ("mobile", &[("phone", 0.8)]),
    ("cell", &[("phone", 0.8)]),
    ("phone", &[("phone", 0.8)]),
    ("email", &[("email", 0.8)]),
    ("birthday", &[("date", 0.8)]),
    ("bday", &[("birthday", 0.8), ("date", 0.8)]),
    ("anniversary", &[("date", 0.8)]),
    ("nameday", &[("date", 0.8)]),
    ("spent", &[("expense", 0.8)]),
    ("spend", &[("expense", 0.8)]),
    ("spending", &[("expense", 0.8)]),
    ("cost", &[("expense", 0.8)]),
    ("paid", &[("expense", 0.8)]),
    ("bought", &[("expense", 0.8)]),
    ("purchase", &[("expense", 0.8)]),
    ("bill", &[("expense", 0.8)]),
    ("itemise", &[("expense", 0.8)]),
    ("itemize", &[("expense", 0.8)]),
    ("itemised", &[("expense", 0.8)]),
    ("itemized", &[("expense", 0.8)]),
    ("breakdown", &[("expense", 0.8)]),
    ("outgoing", &[("expense", 0.8)]),
    ("charge", &[("expense", 0.8)]),
    ("owe", &[("owe", 0.8)]),
    ("owed", &[("owe", 0.8)]),
    ("owing", &[("owe", 0.8)]),
    ("debt", &[("owe", 0.8)]),
    ("lent", &[("owe", 0.8)]),
    ("borrowed", &[("owe", 0.8)]),
    ("fronted", &[("owe", 0.8)]),
    ("iou", &[("owe", 0.8)]),
    ("balance", &[("owe", 0.8)]),
    ("finished", &[("completed", 0.8)]),
    ("done", &[("completed", 0.8)]),
    ("complete", &[("completed", 0.8)]),
    ("ticked", &[("completed", 0.8)]),
    ("closed", &[("completed", 0.8)]),
    ("outstanding", &[("open", 0.8)]),
    ("pending", &[("open", 0.8)]),
    ("remaining", &[("open", 0.8)]),
    ("unfinished", &[("open", 0.8)]),
    ("incomplete", &[("open", 0.8)]),
    ("left", &[("open", 0.8)]),
    ("late", &[("overdue", 0.8)]),
    ("behind", &[("overdue", 0.8)]),
    ("overdue", &[("task", 0.8), ("open", 0.8)]),
    ("favourite", &[("favorite", 0.8)]),
    ("best", &[("favorite", 0.8)]),
    ("loved", &[("favorite", 0.8)]),
    ("pinned", &[("starred", 0.8)]),
    ("flagged", &[("starred", 0.8)]),
    ("important", &[("starred", 0.8)]),
    ("deleted", &[("trashed", 0.8)]),
    ("bin", &[("trashed", 0.8)]),
    ("binned", &[("trashed", 0.8)]),
    ("removed", &[("trashed", 0.8)]),
    ("guest", &[("attendee", 0.8)]),
    ("invitee", &[("attendee", 0.8)]),
    ("invited", &[("attendee", 0.8)]),
    ("attendee", &[("person", 0.8)]),
    ("subtask", &[("subtask", 0.8)]),
    ("step", &[("subtask", 0.8)]),
    ("constituent", &[("subtask", 0.8)]),
    ("changed", &[("changed", 0.8)]),
    ("updated", &[("changed", 0.8)]),
    ("rotated", &[("changed", 0.8)]),
];

const WEEKDAYS: [&str; 7] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];
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
const STAY_START: [&str; 7] = [
    "arrival",
    "arrive",
    "checkin",
    "check-in",
    "check in",
    "depart for",
    "flight out",
];
const STAY_END: [&str; 7] = [
    "departure",
    "depart",
    "checkout",
    "check-out",
    "check out",
    "leave",
    "flight home",
];

const W_BELONGS: f64 = 0.8;
const W_BACK: f64 = 0.25;
const W_COHORT: f64 = 0.2;
/// A word of a row's long text (a note's body), against one of its name.
const W_BODY: f64 = 0.5;

fn role_weight(role: &str) -> f64 {
    match role {
        "belongs" => W_BELONGS,
        "party" => 0.4,
        "member" => 0.3,
        "back" => W_BACK,
        _ => W_COHORT,
    }
}

// ---------------------------------------------------------------- regexes

struct Res {
    num: Regex,
    phrases: Vec<(Regex, String)>,
    word: Regex,
    anaphora: Regex,
    other: Regex,
    same_day: Regex,
    prep: Regex,
    elliptic: Regex,
    stay_q: Regex,
    stay_strip: Regex,
    today: Regex,
    next_week: Regex,
    last_week: Regex,
    weekend: Regex,
    this_week: Regex,
    fortnight: Regex,
    last_month: Regex,
    ahead: Regex,
    recent: Regex,
    next: Regex,
    rolling: Regex,
    not_kind: Regex,
    container: Regex,
    ordinal: Regex,
    months: Vec<Regex>,
    weekdays: Vec<Regex>,
}

fn re(s: &str) -> Regex {
    Regex::new(s).expect("rank regex")
}

fn res() -> &'static Res {
    static R: OnceLock<Res> = OnceLock::new();
    R.get_or_init(|| {
        let names: Vec<&str> = NUM.iter().map(|(n, _)| *n).collect();
        Res {
            num: re(&format!(
                r"\b({})(?:[ -](one|two|three|four|five|six|seven|eight|nine))?\b",
                names.join("|")
            )),
            phrases: PHRASES
                .iter()
                .map(|(p, r)| (re(p), format!(" {r} ")))
                .collect(),
            word: re("[a-z0-9]+"),
            anaphora: re(
                r"\b(them|those|these|ones|it|its|that|her|him|she|he|they|their|his|same|else|there)\b",
            ),
            other: re(r"\b(other|another|different)\b"),
            same_day: re(r"\b(that|same) (day|date|evening|morning)\b"),
            prep: re(r"\b(for|about|from|of|in|at|on|with|to|behind|under)\b"),
            elliptic: re(r"^\s*(and|what about|how about)\b"),
            stay_q: re(r"\b(while|during|when)\b|\bat the\b|\bon the trip\b|\baway\b"),
            stay_strip: re(r"check[- ]?(in|out)|arrival|arrive|departure|depart|leave"),
            today: re(r"\b(today|tonight|this morning|this afternoon|this evening)\b"),
            next_week: re(r"\bnext week\b"),
            last_week: re(r"\blast week\b"),
            weekend: re(r"\b(this )?weekend\b"),
            this_week: re(
                r"\bthis week\b|\brest of the week\b|\bnext (few|couple of) days\b|\bcoming days\b",
            ),
            fortnight: re(r"\bfortnight\b|\bnext two weeks\b"),
            last_month: re(r"\blast month\b"),
            ahead: re(r"\b(this|next) month\b|\bcoming up\b|\bupcoming\b|\bsoon\b|\bnext\b"),
            recent: re(r"\brecent(ly)?\b|\blately\b|\bpast few\b"),
            next: re(r"\bnext\b"),
            rolling: re(
                r"\b(?:next|coming|following) (\d+|few|couple(?: of)?) (day|week|month)s?\b",
            ),
            not_kind: re(r"\bnot (?:the |my |any |those |these )?([a-z]+)"),
            container: re(
                r"\bwho(?:'s| is| are|s)? in\b|\bwhat(?:'s| is|s)? (?:in|inside)\b|\bmembers? of\b|\bcontents? of\b",
            ),
            ordinal: re(r"\b(\d{1,2})(st|nd|rd|th)\b"),
            months: MONTHS.iter().map(|m| re(&format!(r"\b{m}\b"))).collect(),
            weekdays: WEEKDAYS.iter().map(|d| re(&format!(r"\b{d}\b"))).collect(),
        }
    })
}

// ---------------------------------------------------------------- words

fn stop() -> &'static HashSet<&'static str> {
    static S: OnceLock<HashSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| STOP.split_whitespace().collect())
}

fn syn(t: &str) -> &'static [(&'static str, f64)] {
    static M: OnceLock<HashMap<&'static str, &'static [(&'static str, f64)]>> = OnceLock::new();
    M.get_or_init(|| SYN.iter().copied().collect())
        .get(t)
        .copied()
        .unwrap_or(&[])
}

fn numwords(s: &str) -> String {
    let n = |w: &str| NUM.iter().find(|(x, _)| *x == w).map_or(0, |(_, v)| *v);
    res()
        .num
        .replace_all(s, |c: &regex::Captures<'_>| {
            let a = n(&c[1]);
            let b = c.get(2).map_or(0, |m| n(m.as_str()));
            (a + if a >= 20 && b < 10 { b } else { 0 }).to_string()
        })
        .into_owned()
}

fn stem(w: &str) -> String {
    if w.len() > 4 && w.ends_with("ies") {
        return format!("{}y", &w[..w.len() - 3]);
    }
    if w.len() > 3 && w.ends_with('s') && !w.ends_with("ss") {
        return w[..w.len() - 1].to_owned();
    }
    w.to_owned()
}

/// Lower-cased, number words as digits, `'s` dropped, [`PHRASES`] rewritten.
#[must_use]
pub fn normalize(s: &str) -> String {
    let mut s = numwords(&s.to_lowercase()).replace("'s", "");
    for (p, r) in &res().phrases {
        s = p.replace_all(&s, r.as_str()).into_owned();
    }
    s
}

/// The request's words: stemmed, stop words dropped.
#[must_use]
pub fn tokens(s: &str, phrases: bool) -> Vec<String> {
    let s = if phrases {
        normalize(s)
    } else {
        numwords(&s.to_lowercase()).replace("'s", "")
    };
    res()
        .word
        .find_iter(&s)
        .map(|m| m.as_str())
        .filter(|w| !stop().contains(w))
        .map(stem)
        .collect()
}

type Q = IndexMap<String, f64>;

fn bump(q: &mut Q, t: &str, w: f64) {
    match q.get_mut(t) {
        Some(x) => *x = x.max(w),
        None => {
            q.insert(t.to_owned(), w.max(0.0));
        }
    }
}

/// Query tokens -> {token: weight}: the word itself at 1, its concepts at
/// their weight.
fn expand(toks: &[String]) -> Q {
    let mut q = Q::new();
    for t in toks {
        bump(&mut q, t, 1.0);
        for (c, w) in syn(t) {
            bump(&mut q, c, *w);
        }
    }
    q
}

fn ids(v: Option<&String>) -> Vec<String> {
    v.map(|s| {
        s.split('\x1f')
            .filter(|x| !x.is_empty())
            .map(str::to_owned)
            .collect()
    })
    .unwrap_or_default()
}

fn titles(v: Option<&String>) -> Vec<String> {
    v.map(|s| {
        s.split(['\x1f', ','])
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(str::to_owned)
            .collect()
    })
    .unwrap_or_default()
}

/// Python's `'%g'` of a float.
fn fmt_g(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    let e = format!("{x:.5e}");
    let (mant, exp) = e.split_once('e').expect("exp");
    let exp: i32 = exp.parse().expect("exp");
    if !(-4..6).contains(&exp) {
        let mant = if mant.contains('.') {
            mant.trim_end_matches('0').trim_end_matches('.')
        } else {
            mant
        };
        let sign = if exp < 0 { '-' } else { '+' };
        return format!("{mant}e{sign}{:02}", exp.abs());
    }
    let prec = usize::try_from(5 - exp).unwrap_or(0);
    let s = format!("{x:.prec$}");
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        s
    }
}

// ---------------------------------------------------------------- dates

/// A day, as days from the civil epoch.
type Day = i64;

fn ymd(y: i64, m: u32, d: u32) -> Option<Day> {
    if !(1..=12).contains(&m) || d == 0 {
        return None;
    }
    let z = days_from_civil(y, m, d);
    (civil_from_days(z) == (y, m, d)).then_some(z)
}

/// `date.fromisoformat(s[:10])`, for the `YYYY-MM-DD` shape.
fn iso_day(s: &str) -> Option<Day> {
    let s: String = s.chars().take(10).collect();
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| {
        s.get(r)
            .filter(|x| x.bytes().all(|c| c.is_ascii_digit()))
            .and_then(|x| x.parse::<i64>().ok())
    };
    let (y, m, d) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    ymd(y, u32::try_from(m).ok()?, u32::try_from(d).ok()?)
}

/// `d` moved `n` calendar months on, the day clamped to the month's last.
fn months_ahead(d: Day, n: i64) -> Day {
    let (y, m, day) = civil_from_days(d);
    let at = y * 12 + i64::from(m) - 1 + n;
    let (y, m) = (
        at.div_euclid(12),
        u32::try_from(at.rem_euclid(12) + 1).unwrap_or(1),
    );
    (1..=day).rev().find_map(|day| ymd(y, m, day)).unwrap_or(d)
}

/// Monday = 0.
fn weekday(d: Day) -> i64 {
    (d + 3).rem_euclid(7)
}

#[derive(Clone, Debug)]
struct Window {
    start: Day,
    end: Day,
    /// A stay's head word ("cabin"), when the window is a stay.
    head: Option<String>,
}

impl Window {
    fn span(start: Day, end: Day) -> Self {
        Self {
            start,
            end,
            head: None,
        }
    }
    fn holds(&self, d: Day) -> bool {
        self.start <= d && d <= self.end
    }
}

// ---------------------------------------------------------------- ontology

struct OLink {
    field: String,
    how: String,
    to: String,
    role: String,
}

struct Onto {
    /// (entity, door) -> the door's kind words; (entity, "") -> kind names.
    kind_words: HashMap<(String, String), String>,
    /// word -> (entity, strength)
    kind_intent: HashMap<String, (String, f64)>,
    links: HashMap<String, Vec<OLink>>,
    /// entity -> column -> shape
    fields: HashMap<String, HashMap<String, String>>,
    cohorts: HashSet<(String, String)>,
}

fn onto() -> &'static Onto {
    static O: OnceLock<Onto> = OnceLock::new();
    O.get_or_init(|| {
        let v: serde_json::Value =
            serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/onto.json")))
                .expect("onto.json");
        let strs = |x: &serde_json::Value| -> Vec<String> {
            x.as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect()
        };
        let empty = serde_json::Map::new();
        let kinds = v["kinds"].as_object().unwrap_or(&empty);
        let mut kind_words = HashMap::new();
        for (e, k) in kinds {
            for (door, ws) in k["byDoor"].as_object().unwrap_or(&empty) {
                kind_words.insert((e.clone(), door.clone()), strs(ws).join(" "));
            }
            kind_words.insert((e.clone(), String::new()), strs(&k["names"]).join(" "));
        }
        let mut kind_intent: HashMap<String, (String, f64)> = HashMap::new();
        for (e, k) in kinds {
            for w in strs(&k["subkinds"]) {
                kind_intent.entry(w).or_insert((e.clone(), 0.8));
            }
        }
        for (e, k) in kinds {
            for w in strs(&k["intent"]) {
                kind_intent.insert(w, (e.clone(), 1.0));
            }
        }
        let mut links: HashMap<String, Vec<OLink>> = HashMap::new();
        for l in v["links"].as_array().into_iter().flatten() {
            let s = |k: &str| l[k].as_str().unwrap_or("").to_owned();
            links.entry(s("from")).or_default().push(OLink {
                field: s("field"),
                how: s("how"),
                to: s("to"),
                role: s("role"),
            });
        }
        let mut fields: HashMap<String, HashMap<String, String>> = HashMap::new();
        for (e, cols) in v["fields"].as_object().unwrap_or(&empty) {
            let f = fields.entry(e.clone()).or_default();
            for (c, x) in cols.as_object().unwrap_or(&empty) {
                f.insert(c.clone(), x["shape"].as_str().unwrap_or("").to_owned());
            }
        }
        let cohorts = v["cohorts"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| {
                (
                    c["entity"].as_str().unwrap_or("").to_owned(),
                    c["field"].as_str().unwrap_or("").to_owned(),
                )
            })
            .collect();
        Onto {
            kind_words,
            kind_intent,
            links,
            fields,
            cohorts,
        }
    })
}

fn shape(ent: &str, field: &str) -> String {
    if let Some(s) = onto().fields.get(ent).and_then(|f| f.get(field)) {
        return s.clone();
    }
    let s = if field.ends_with("_minor") {
        "money"
    } else if field.ends_with("_at") || field.ends_with("_on") {
        "date"
    } else if field.ends_with("_ids") {
        "ids"
    } else if field.ends_with("_id") {
        "ref"
    } else {
        "text"
    };
    s.to_owned()
}

/// (field, how, target entity, role) for each linking field on a row: the
/// generated ontology links first, then the naming convention for fields it
/// does not know.
fn link_specs(
    ent: &str,
    extra: &BTreeMap<String, String>,
) -> Vec<(String, String, String, String)> {
    let o = onto();
    let mut known: IndexMap<String, (String, String, String, String)> = IndexMap::new();
    for l in o.links.get(ent).into_iter().flatten() {
        if l.how == "prefix" {
            for f in extra.keys() {
                if f.starts_with(&l.field) {
                    known.entry(f.clone()).or_insert_with(|| {
                        (f.clone(), "prefix".into(), l.to.clone(), l.role.clone())
                    });
                }
            }
        } else if extra.contains_key(&l.field) {
            known
                .entry(l.field.clone())
                .or_insert_with(|| (l.field.clone(), l.how.clone(), l.to.clone(), l.role.clone()));
        }
    }
    for f in extra.keys() {
        if known.contains_key(f) {
            continue;
        }
        let sh = shape(ent, f);
        if sh == "ref" || sh == "ids" {
            let ws: Vec<&str> = f.split('_').collect();
            let ws = &ws[..ws.len() - 1];
            let to = ws
                .iter()
                .rev()
                .find_map(|w| o.kind_intent.get(*w).map(|(e, _)| e.clone()));
            if let Some(to) = to {
                let how = if sh == "ref" { "id" } else { "ids" };
                let role = if to == "core.party" {
                    "party"
                } else {
                    "belongs"
                };
                known.insert(f.clone(), (f.clone(), how.into(), to, role.into()));
            }
        }
    }
    known.into_values().collect()
}

// ---------------------------------------------------------------- the ranker

/// A row's identity in the pool: (entity, id, app).
type Key = (String, String, String);

struct Doc {
    own: HashMap<String, usize>,
    nb: HashMap<String, f64>,
    len: usize,
}

/// One search hit: the row, and its inline links ranked against the request.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub row: VaultRow,
    /// Linked rows shown with the hit, best first: at most eight of each linked
    /// kind (sixteen of a kind the request names), plus — when two hits belong
    /// to one container — that container's other members of the hits' kind.
    pub links: Vec<VaultRow>,
    /// Linked rows past the per-kind cap: not on screen, only counted
    /// (`… 3 more`), so a list that was cut reads as cut.
    pub more: Vec<VaultRow>,
}

/// Every row id a set of hits puts on screen: the hits and their links.
#[must_use]
pub fn view_ids(hits: &[Hit]) -> BTreeSet<String> {
    hits.iter()
        .flat_map(|h| std::iter::once(&h.row).chain(&h.links))
        .map(|r| r.id.clone())
        .collect()
}

/// Ranked search over one vault's rows.
pub struct Ranker {
    today: Day,
    k: usize,
    pool: Vec<VaultRow>,
    at: HashMap<Key, usize>,
    byid: HashMap<String, Vec<usize>>,
    bykind: HashMap<String, Vec<usize>>,
    /// id -> neighbour id -> weight. The inner map is ordered so every walk
    /// over a row's links (inline links, shared containers) comes out the same
    /// on every run; a hash map's order changed which row got which `#n`.
    links: HashMap<String, BTreeMap<String, f64>>,
    docs: Vec<Doc>,
    df: HashMap<String, usize>,
    n: usize,
    avg: f64,
    /// head word -> (start, end), in the prototype's insertion order
    stays: IndexMap<String, (Day, Day)>,
}

/// The per-search state the link ranking reads.
struct Search {
    q: Q,
    kinds: IndexMap<String, f64>,
    win: Option<Window>,
    overdue: bool,
    /// The day(s) the person's request names when the query itself names
    /// none (`search "dinner"` for "who am I having dinner with on tuesday?").
    asked: Option<(Window, bool)>,
}

/// What a row that matches the query gains for falling on the day the
/// person's request names (the query's own window adds 6.0 to every row).
const W_ASKED_DAY: f64 = 6.0;

fn key(r: &VaultRow) -> Key {
    (r.entity.clone(), r.id.clone(), r.app.clone())
}

impl Ranker {
    /// Index `rows` (the rows `show (things)` yields; the same row answered by
    /// two readers is merged, the first reader's facts winning). `today` is
    /// `YYYY-MM-DD`.
    ///
    /// # Panics
    ///
    /// `today` is not a `YYYY-MM-DD` date.
    #[must_use]
    pub fn new(rows: &[VaultRow], today: &str) -> Self {
        let today = iso_day(today).expect("today is YYYY-MM-DD");
        let mut pool: Vec<VaultRow> = Vec::new();
        let mut at: HashMap<Key, usize> = HashMap::new();
        for r in rows {
            let k = key(r);
            if let Some(&p) = at.get(&k) {
                for (a, b) in &r.extra {
                    if !b.is_empty() && pool[p].extra.get(a).is_none_or(String::is_empty) {
                        pool[p].extra.insert(a.clone(), b.clone());
                    }
                }
                continue;
            }
            at.insert(k, pool.len());
            pool.push(r.clone());
        }
        let mut byid: HashMap<String, Vec<usize>> = HashMap::new();
        let mut bykind: HashMap<String, Vec<usize>> = HashMap::new();
        for (x, r) in pool.iter().enumerate() {
            byid.entry(r.id.clone()).or_default().push(x);
            bykind.entry(r.entity.clone()).or_default().push(x);
        }
        let mut me = Self {
            today,
            k: DEFAULT_K,
            pool,
            at,
            byid,
            bykind,
            links: HashMap::new(),
            docs: Vec::new(),
            df: HashMap::new(),
            n: 0,
            avg: 0.0,
            stays: IndexMap::new(),
        };
        me.build_links();
        me.build_index();
        me.stays = me.stays();
        me
    }

    /// The same ranker with `k` hits before whole-kind listing.
    #[must_use]
    pub fn with_k(mut self, k: usize) -> Self {
        self.k = k;
        self
    }

    /// Every row indexed, after merging.
    #[must_use]
    pub fn pool(&self) -> &[VaultRow] {
        &self.pool
    }

    /// The label of the first row with this id.
    #[must_use]
    pub fn name(&self, id: &str) -> Option<&str> {
        self.byid.get(id).map(|v| self.pool[v[0]].label.as_str())
    }

    fn first(&self, id: &str) -> &VaultRow {
        &self.pool[self.byid[id][0]]
    }

    fn links_of(&self, id: &str) -> Option<&BTreeMap<String, f64>> {
        self.links.get(id)
    }

    fn link_iter(&self, id: &str) -> impl Iterator<Item = (&String, f64)> {
        self.links_of(id)
            .into_iter()
            .flatten()
            .map(|(n, w)| (n, *w))
    }

    fn build_links(&mut self) {
        let mut by_label: HashMap<&str, HashMap<&str, &str>> = HashMap::new();
        for r in &self.pool {
            by_label
                .entry(&r.entity)
                .or_default()
                .entry(&r.label)
                .or_insert(&r.id);
        }
        let mut fwd: HashMap<String, HashMap<String, f64>> = HashMap::new();
        let mut cohort: IndexMap<(String, String, String), Vec<String>> = IndexMap::new();
        let cohorts = &onto().cohorts;
        for r in &self.pool {
            let e = &r.extra;
            for (f, how, to, role) in link_specs(&r.entity, e) {
                let targets: Vec<String> = if how == "prefix" {
                    vec![f.split_once(':').map_or("", |x| x.1).to_owned()]
                } else if how == "titles" {
                    titles(e.get(&f))
                        .iter()
                        .filter_map(|t| {
                            by_label
                                .get(to.as_str())
                                .and_then(|m| m.get(t.as_str()))
                                .map(|x| (*x).to_owned())
                        })
                        .collect()
                } else {
                    ids(e.get(&f))
                };
                let w = role_weight(&role);
                for i in targets {
                    if !i.is_empty() && self.byid.contains_key(&i) && i != r.id {
                        let m = fwd.entry(r.id.clone()).or_default();
                        let x = m.entry(i).or_insert(0.0);
                        *x = x.max(w);
                    }
                }
            }
            for (f, v) in e {
                if cohorts.contains(&(r.entity.clone(), f.clone())) && !v.is_empty() {
                    cohort
                        .entry((r.entity.clone(), f.clone(), v.clone()))
                        .or_default()
                        .push(r.id.clone());
                }
            }
        }
        for members in cohort.values() {
            if members.len() < 15 {
                for i in members {
                    for j in members {
                        if i != j {
                            let x = fwd
                                .entry(i.clone())
                                .or_default()
                                .entry(j.clone())
                                .or_insert(0.0);
                            *x = x.max(W_COHORT);
                        }
                    }
                }
            }
        }
        let mut links: HashMap<String, BTreeMap<String, f64>> = HashMap::new();
        for (i, out) in &fwd {
            for (n, w) in out {
                let x = links
                    .entry(i.clone())
                    .or_default()
                    .entry(n.clone())
                    .or_insert(0.0);
                *x = x.max(*w);
                // the way back (a container seeing its members) is weak
                let x = links
                    .entry(n.clone())
                    .or_default()
                    .entry(i.clone())
                    .or_insert(0.0);
                *x = x.max(W_BACK);
            }
        }
        self.links = links;
    }

    fn date(&self, r: &VaultRow) -> Option<Day> {
        if let Some(md) = r.extra.get("month_day").filter(|s| !s.is_empty()) {
            let mut it = md.split('-').map(|x| x.parse::<u32>().ok());
            let (m, d) = (it.next().flatten()?, it.next().flatten()?);
            let y = civil_from_days(self.today).0;
            let x = ymd(y, m, d)?;
            return if x >= self.today {
                Some(x)
            } else {
                ymd(y + 1, m, d)
            };
        }
        r.date
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(iso_day)
    }

    /// All dates a row answers to: its own date, plus when it was completed.
    /// An overdue window only matches rows still open.
    fn dates(&self, r: &VaultRow, overdue: bool) -> Vec<Day> {
        let e = &r.extra;
        if overdue {
            match e.get("status") {
                None => return vec![],
                Some(s) if s == "completed" || s == "cancelled" => return vec![],
                _ => {}
            }
        }
        let mut out = vec![self.date(r)];
        if let Some(c) = e.get("completed_at").filter(|c| !c.is_empty())
            && !overdue
        {
            out.push(iso_day(c));
        }
        out.into_iter().flatten().collect()
    }

    fn in_window(&self, r: &VaultRow, win: &Window, overdue: bool) -> bool {
        self.dates(r, overdue).into_iter().any(|x| win.holds(x))
    }

    // ------------------------------------------------------------ facts as words

    fn rel(&self, d: Day) -> String {
        let n = d - self.today;
        match n {
            0 => return "today".into(),
            1 => return "tomorrow".into(),
            -1 => return "yesterday".into(),
            _ => {}
        }
        let dir = if n > 0 { "ahead" } else { "ago" };
        if n.abs() < 7 {
            return format!("days {dir}");
        }
        if n.abs() < 45 {
            return format!("weeks {dir}");
        }
        let unit = if n.abs() < 365 { "months" } else { "years" };
        format!("{unit} {dir}")
    }

    fn fact_words(&self, r: &VaultRow) -> String {
        let (ent, e) = (r.entity.as_str(), &r.extra);
        let o = onto();
        let mut w: Vec<String> = Vec::new();
        let linked: HashSet<String> = link_specs(ent, e).into_iter().map(|x| x.0).collect();
        for (f, v) in e {
            if v.is_empty() || f.contains(':') || linked.contains(f) {
                continue; // a link's value is the neighbour's name: the link channel carries it
            }
            let sh = shape(ent, f);
            let name = f.replace("_minor", "").replace('_', " ");
            if sh == "money" {
                let Ok(amt) = v.parse::<i64>() else { continue };
                if amt > 0 {
                    #[allow(clippy::cast_precision_loss)]
                    let x = amt as f64 / 100.0;
                    w.push(format!("{name} ${} money", fmt_g(x)));
                    if f.ends_with("_to_me_minor") {
                        w.push("receivable".into());
                    } else if f.ends_with("_to_them_minor") {
                        w.push("payable".into());
                    }
                }
            } else if sh == "flag" || v == "true" || v == "false" {
                if v == "true" || v == "1" {
                    w.push(name);
                }
            } else if sh == "enum" {
                w.push(v.replace(['-', '_'], " "));
            } else if sh == "integer" && f.ends_with("_min") {
                w.push(format!("{v} minute"));
            } else if sh == "date" {
                let day = if f == "month_day" { None } else { iso_day(v) };
                if f.ends_with("_at")
                    && f != "created_at"
                    && f != "completed_at"
                    && let Some(d) = day
                {
                    w.push(format!("{name} {}", self.rel(d)));
                }
            } else if (sh == "ref" || sh == "ids") && f.ends_with("_ids") {
                w.push(f.split('_').next().unwrap_or("").to_owned());
            } else if sh == "text"
                && v.chars().count() < 60
                && !v.starts_with("lk1:")
                && !v.starts_with("http")
            {
                if o.cohorts.contains(&(ent.to_owned(), f.clone())) {
                    w.push(format!("{name} {v}"));
                } else {
                    w.push(v.clone());
                }
            }
        }
        // a stamp that never moved from the row's creation: "<x> never changed"
        if let Some(created) = e.get("created_at").filter(|c| !c.is_empty()) {
            for (f, v) in e {
                if let Some(stem) = f.strip_suffix("_set_at")
                    && v == created
                {
                    w.push(format!("{} never changed original", stem.replace('_', " ")));
                }
            }
        }
        let fields = o.fields.get(ent);
        let has = |c: &str| fields.is_some_and(|f| f.contains_key(c));
        if ent == "schedule.task" || (has("status") && has("completed_at")) {
            if let Some(s) = e.get("status").filter(|s| !s.is_empty())
                && s != "completed"
                && s != "cancelled"
            {
                w.push("open".into());
            }
            if r.date.as_deref().is_none_or(str::is_empty) {
                w.push("no deadline undated".into());
            }
            if e.get("parent_task_id").is_some_and(|x| !x.is_empty()) {
                w.push("subtask".into());
            }
        }
        let owes = e.iter().any(|(f, v)| {
            shape(ent, f) == "money" && f.starts_with("owed") && v.parse::<i64>().unwrap_or(0) > 0
        });
        if owes {
            w.push("owe balance".into());
        }
        if e.get("trashed").is_some_and(|x| x == "true") || !r.live {
            w.push("trashed".into());
        }
        w.join(" ")
    }

    fn build_index(&mut self) {
        let o = onto();
        let mut docs = Vec::with_capacity(self.pool.len());
        for r in &self.pool {
            let kw = o
                .kind_words
                .get(&(r.entity.clone(), r.app.clone()))
                .or_else(|| o.kind_words.get(&(r.entity.clone(), String::new())))
                .map_or("", String::as_str);
            let own = format!("{} {} {}", r.label, self.fact_words(r), kw);
            let mut ot = tokens(&own, true);
            let base: HashSet<String> = ot.iter().cloned().collect();
            let add: Vec<String> = ot
                .iter()
                .flat_map(|t| syn(t).iter().map(|(c, _)| *c))
                .filter(|c| !base.contains(*c))
                .map(str::to_owned)
                .collect();
            ot.extend(add);
            let mut nb: HashMap<String, f64> = HashMap::new();
            for (i, w) in self.link_iter(&r.id) {
                let toks: HashSet<String> = tokens(self.name(i).unwrap_or(""), false)
                    .into_iter()
                    .collect();
                for t in toks {
                    let x = nb.entry(t).or_insert(0.0);
                    *x = x.max(w);
                }
            }
            // A row's long text (a note's body, a document's preview) is not
            // its name, but what it says: its words match at half strength,
            // through the same channel a neighbour's name does.
            for (f, v) in &r.extra {
                if v.chars().count() >= 60
                    && shape(&r.entity, f) == "text"
                    && !v.starts_with("lk1:")
                    && !v.starts_with("http")
                {
                    for t in tokens(v, true) {
                        if !base.contains(&t) {
                            let x = nb.entry(t).or_insert(0.0);
                            *x = x.max(W_BODY);
                        }
                    }
                }
            }
            let mut own: HashMap<String, usize> = HashMap::new();
            for t in &ot {
                *own.entry(t.clone()).or_default() += 1;
            }
            docs.push(Doc {
                own,
                nb,
                len: ot.len(),
            });
        }
        let mut df: HashMap<String, usize> = HashMap::new();
        for d in &docs {
            let set: HashSet<&String> = d.own.keys().chain(d.nb.keys()).collect();
            for t in set {
                *df.entry(t.clone()).or_default() += 1;
            }
        }
        self.n = docs.len();
        let total: usize = docs.iter().map(|d| d.len).sum();
        #[allow(clippy::cast_precision_loss)]
        {
            self.avg = total as f64 / self.n.max(1) as f64;
        }
        self.docs = docs;
        self.df = df;
    }

    #[allow(clippy::cast_precision_loss)]
    fn idf(&self, t: &str) -> f64 {
        let df = self.df.get(t).copied().unwrap_or(0) as f64;
        (1.0 + (self.n as f64 - df + 0.5) / (df + 0.5)).ln()
    }

    #[allow(clippy::cast_precision_loss)]
    fn lexical(&self, q: &Q, doc: &Doc) -> f64 {
        let mut s = 0.0;
        for (t, w) in q {
            if let Some(&tf) = doc.own.get(t) {
                let tf = tf as f64;
                s += w * self.idf(t) * tf * 2.2
                    / (tf + 1.2 * (0.25 + 0.75 * doc.len as f64 / self.avg));
            } else if let Some(nb) = doc.nb.get(t) {
                s += nb * w * self.idf(t);
            }
        }
        s
    }

    // ------------------------------------------------------------ time

    /// head word -> (start, end) from an arrival/departure or
    /// check-in/check-out event pair.
    fn stays(&self) -> IndexMap<String, (Day, Day)> {
        let mut starts: IndexMap<String, Vec<Day>> = IndexMap::new();
        let mut ends: HashMap<String, Vec<Day>> = HashMap::new();
        for &x in self.bykind.get("core.event").into_iter().flatten() {
            let r = &self.pool[x];
            let lab = r.label.to_lowercase();
            let Some(d) = self.date(r) else { continue };
            let head = tokens(&res().stay_strip.replace_all(&lab, " "), false);
            if STAY_START.iter().any(|s| lab.contains(s)) {
                for h in head {
                    starts.entry(h).or_default().push(d);
                }
            } else if STAY_END.iter().any(|s| lab.contains(s)) {
                for h in head {
                    ends.entry(h).or_default().push(d);
                }
            }
        }
        let mut out = IndexMap::new();
        for (h, ss) in &starts {
            for &s in ss {
                let later = ends
                    .get(h)
                    .into_iter()
                    .flatten()
                    .copied()
                    .filter(|&e| s <= e && e <= s + 30)
                    .min();
                if let Some(e) = later {
                    out.insert(h.clone(), (s, e));
                }
            }
        }
        out
    }

    #[allow(clippy::too_many_lines)]
    fn window(&self, query: &str) -> Option<Window> {
        let q = query.to_lowercase();
        let rx = res();
        let t = self.today;
        let mon = t - weekday(t);
        let qt: HashSet<String> = tokens(&q, true).into_iter().collect();
        if rx.stay_q.is_match(&q) {
            for (h, (s, e)) in &self.stays {
                if qt.contains(h) {
                    return Some(Window {
                        start: *s,
                        end: *e,
                        head: Some(h.clone()),
                    });
                }
            }
        }
        let span = |a, b| Some(Window::span(a, b));
        if qt.contains("overdue") {
            return span(days_from_civil(2000, 1, 1), t - 1);
        }
        if q.contains("tomorrow") {
            return span(t + 1, t + 1);
        }
        if q.contains("yesterday") {
            return span(t - 1, t - 1);
        }
        if rx.today.is_match(&q) {
            return span(t, t);
        }
        if rx.next_week.is_match(&q) {
            return span(mon + 7, mon + 13);
        }
        if rx.last_week.is_match(&q) {
            return span(mon - 7, mon - 1);
        }
        if rx.weekend.is_match(&q) {
            return span(mon + 5, mon + 6);
        }
        if rx.this_week.is_match(&q) {
            return span(mon, mon + 6);
        }
        if rx.fortnight.is_match(&q) {
            return span(t, t + 14);
        }
        // "the next couple of months", "the coming 3 weeks": a rolling window
        // from today, the same one the set language's `next N months` names
        if let Some(c) = rx.rolling.captures(&numwords(&q)) {
            let n: i64 = match &c[1] {
                "few" => 3,
                x if x.starts_with("couple") => 2,
                x => x.parse().unwrap_or(1),
            };
            let end = match &c[2] {
                "day" => t + n,
                "week" => t + 7 * n,
                _ => months_ahead(t, n),
            };
            return span(t, end);
        }
        let (ty, tm, _) = civil_from_days(t);
        if rx.last_month.is_match(&q) {
            let first = days_from_civil(ty, tm, 1);
            let (py, pm, _) = civil_from_days(first - 1);
            return span(days_from_civil(py, pm, 1), first - 1);
        }
        if rx.ahead.is_match(&q) {
            return span(t, t + 62);
        }
        if rx.recent.is_match(&q) {
            return span(t - 30, t);
        }
        for (i, m) in rx.months.iter().enumerate() {
            if m.is_match(&q) {
                let month = u32::try_from(i + 1).unwrap_or(1);
                let mut y = if month <= tm { ty } else { ty - 1 };
                if rx.next.is_match(&q) {
                    y = ty + i64::from(month <= tm);
                }
                let end = days_from_civil(y + i64::from(i == 11), month % 12 + 1, 1) - 1;
                return span(days_from_civil(y, month, 1), end);
            }
        }
        if let Some(c) = rx.ordinal.captures(&q)
            && let Ok(d) = c[1].parse::<u32>()
            && (1..=31).contains(&d)
            && let Some(x) = ymd(ty, tm, d)
        {
            return span(x, x);
        }
        for (i, d) in rx.weekdays.iter().enumerate() {
            if d.is_match(&q) {
                let mut x = mon + i64::try_from(i).unwrap_or(0);
                if q.contains("last") {
                    if x >= t {
                        x -= 7;
                    }
                } else if x < t {
                    x += 7;
                }
                return span(x, x);
            }
        }
        None
    }

    /// The days the rows of an answer fall on — else, when none of them is
    /// dated, the days of the rows they link to ("that day" after a person).
    fn answer_days(&self, ids: &[&String]) -> Vec<Day> {
        let dates_of = |i: &str| -> Vec<Day> {
            self.byid
                .get(i)
                .into_iter()
                .flatten()
                .filter_map(|&x| self.date(&self.pool[x]))
                .collect()
        };
        let ds: Vec<Day> = ids.iter().flat_map(|i| dates_of(i)).collect();
        if !ds.is_empty() {
            return ds;
        }
        ids.iter()
            .flat_map(|i| {
                self.link_iter(i)
                    .map(|(n, _)| n.clone())
                    .collect::<Vec<_>>()
            })
            .flat_map(|n| dates_of(&n))
            .collect()
    }

    /// A window PHRASE a set expression names (`during next couple of
    /// months`, `during may`, `during that day`, `during while at the cabin`)
    /// as the first and last day it covers, `YYYY-MM-DD`, resolved exactly as
    /// [`Self::search`] resolves the same words — so search and the set
    /// language agree on what a phrase means. `last_answers` is as for
    /// [`Self::search`]; "that day" is the day(s) of the newest answer.
    #[must_use]
    pub fn resolve_window(
        &self,
        phrase: &str,
        last_answers: &[Vec<String>],
    ) -> Option<(String, String)> {
        let day = |d: Day| {
            let (y, m, d) = civil_from_days(d);
            format!("{y:04}-{m:02}-{d:02}")
        };
        let p = phrase.to_lowercase();
        if res().same_day.is_match(&p) {
            let prev: Vec<&String> = last_answers.first().into_iter().flatten().collect();
            let ds = self.answer_days(&prev);
            let (lo, hi) = (ds.iter().min()?, ds.iter().max()?);
            return Some((day(*lo), day(*hi)));
        }
        let w = self.window(&format!("during {p}"))?;
        Some((day(w.start), day(w.end)))
    }

    // ------------------------------------------------------------ search

    /// Answer one raw request.
    ///
    /// * `context` — the session's earlier requests, oldest first;
    /// * `last_answers` — the last answers' row ids, newest first (only the
    ///   first two are read).
    ///
    /// Returns the top hits in rank order (the top `k`, widened to a whole
    /// small kind the request names), each with its inline links.
    #[must_use]
    pub fn search<S: AsRef<str>>(
        &self,
        query: &str,
        context: &[S],
        last_answers: &[Vec<String>],
    ) -> Vec<Hit> {
        self.search_for(query, None, context, last_answers)
    }

    /// **A DAY THE PERSON NAMED RANKS, WHATEVER THE QUERY SAYS.** As
    /// [`Self::search`], for a query written for the person's request
    /// `asked` (the tool loop's `search "dinner"` for "who am I having
    /// dinner with on tuesday?"). When the query names no day of its own,
    /// the request's day or window — read by the same resolver as
    /// [`Self::resolve_window`] — lifts the rows that match the query AND
    /// fall on it, so a dated row is not cut from the screen behind older
    /// namesakes. A row that matches none of the query's words gains
    /// nothing: the day orders what the query found, it finds nothing.
    #[must_use]
    #[allow(clippy::too_many_lines)]
    pub fn search_for<S: AsRef<str>>(
        &self,
        query: &str,
        asked: Option<&str>,
        context: &[S],
        last_answers: &[Vec<String>],
    ) -> Vec<Hit> {
        let o = onto();
        let rx = res();
        let answers: Vec<&Vec<String>> = last_answers.iter().take(2).collect();
        let qtoks = tokens(query, true);
        let mut q = expand(&qtoks);
        for (back_i, c) in context.iter().rev().enumerate() {
            let decay = 0.6_f64.powf(f64::from(u32::try_from(back_i).unwrap_or(u32::MAX)));
            for (t, w) in expand(&tokens(c.as_ref(), true)) {
                bump(&mut q, &t, 0.4 * w * decay);
            }
        }
        let mut win = self.window(query);
        let overdue = qtoks.iter().any(|t| t == "overdue");
        let ql = query.to_lowercase();
        let mut anaph = rx.anaphora.is_match(&ql);
        // "the other one": the referent is NOT the last answer ("what else" still is)
        let other = rx.other.is_match(&ql);
        // anaphora reaches the last two answers: their rows, their links, their names
        let mut near: HashMap<&str, f64> = HashMap::new();
        for (ai, ans) in answers.iter().enumerate() {
            let decay = if ai == 0 { 1.0 } else { 0.6 };
            for i in ans.iter() {
                let x = near.entry(i).or_insert(0.0);
                *x = x.max(3.0 * decay);
                for (n, w) in self.link_iter(i) {
                    let x = near.entry(n).or_insert(0.0);
                    *x = x.max(3.0 * decay * 1.0_f64.min(w + 0.4));
                }
            }
        }
        if other {
            for i in answers.first().into_iter().flat_map(|a| a.iter()) {
                near.insert(i, -3.0);
            }
        }
        let prev_flat: Vec<&String> = answers.first().into_iter().flat_map(|a| a.iter()).collect();
        if let Some(h) = win.as_ref().and_then(|w| w.head.clone()) {
            q.insert(h, 0.3);
        }
        // "that day": the day an earlier request named, else the days the
        // last answer falls on (which then reads as a day, not a referent)
        let same_day = |text: &str| -> Option<(Window, bool)> {
            if !rx.same_day.is_match(text) {
                return None;
            }
            if let Some(e) = context.iter().rev().find_map(|c| self.window(c.as_ref())) {
                return Some((Window::span(e.start, e.end), false));
            }
            let ds = self.answer_days(&prev_flat);
            let (lo, hi) = (ds.iter().min().copied()?, ds.iter().max().copied()?);
            Some((Window::span(lo, hi), true))
        };
        if win.is_none()
            && let Some((w, by_answer)) = same_day(&ql)
        {
            win = Some(w);
            anaph &= !by_answer;
        }
        let asked = asked.map(str::to_lowercase).filter(|a| *a != ql);
        let asked_win = match &asked {
            Some(a) if win.is_none() => self
                .window(a)
                .map(|w| Window::span(w.start, w.end))
                .or_else(|| same_day(a).map(|(w, _)| w)),
            _ => None,
        };
        let asked_overdue = asked
            .as_deref()
            .is_some_and(|a| tokens(a, false).iter().any(|t| t == "overdue"));
        if anaph && !other {
            for (ai, ans) in answers.iter().enumerate() {
                let w = 0.5 * if ai == 0 { 1.0 } else { 0.6 };
                for i in ans.iter() {
                    for t in tokens(self.name(i).unwrap_or(""), false) {
                        bump(&mut q, &t, w);
                    }
                }
            }
        }
        // the kind a request names is its head noun: a kind named only after the
        // first preposition ("the login FOR the cabin place") qualifies it, at half
        // strength
        let is_kind = |t: &str, w: f64| w >= 0.8 && o.kind_intent.contains_key(t);
        let qn = normalize(query);
        let head: Option<Q> = rx
            .prep
            .find(&qn)
            .map(|m| expand(&tokens(&qn[..m.start()], false)));
        let head_named = match &head {
            Some(h) => h.iter().any(|(t, w)| is_kind(t, *w)),
            None => q.iter().any(|(t, w)| is_kind(t, *w)),
        };
        // an elliptical follow-up ("and the cottage?") that names no kind asks for
        // the kind the previous request named
        if let Some(last) = context.last()
            && !head_named
            && rx.elliptic.is_match(&ql)
            && !q.iter().any(|(t, w)| is_kind(t, *w))
        {
            for (t, w) in expand(&tokens(last.as_ref(), true)) {
                if is_kind(&t, w) {
                    bump(&mut q, &t, w);
                }
            }
        }
        // "the appointment, not the tasks": a kind the person rules out names
        // no kind, and its rows go behind every other row
        let mut demoted: HashSet<String> = HashSet::new();
        let current = context.last().map(|c| c.as_ref().to_owned());
        for text in std::iter::once(query.to_owned()).chain(current) {
            let text = normalize(&text);
            for c in rx.not_kind.captures_iter(&text) {
                for (t, w) in expand(&[stem(&c[1])]) {
                    if let Some((e, _)) = o.kind_intent.get(&t).filter(|_| w >= 0.8) {
                        demoted.insert(e.clone());
                    }
                }
            }
        }
        if !demoted.is_empty() {
            q.retain(|t, _| {
                !o.kind_intent
                    .get(t)
                    .is_some_and(|(e, _)| demoted.contains(e))
            });
        }
        let mut kinds: IndexMap<String, f64> = IndexMap::new();
        for (t, w) in &q {
            if *w >= 0.8
                && let Some((e, s)) = o.kind_intent.get(t)
                && !demoted.contains(e)
            {
                let mut s = *s;
                if head_named && head.as_ref().is_some_and(|h| !h.contains_key(t)) {
                    s *= 0.5;
                }
                let x = kinds.entry(e.clone()).or_insert(0.0);
                *x = x.max(s * w);
            }
        }
        // a word that names a kind, itself or through its everyday synonyms, is a kind word
        let naming = |t: &str| {
            o.kind_intent.contains_key(t)
                || syn(t)
                    .iter()
                    .any(|(c, w)| *w >= 0.8 && o.kind_intent.contains_key(*c))
        };
        let qc: Q = q
            .iter()
            .filter(|(t, _)| !naming(t))
            .map(|(t, w)| (t.clone(), *w))
            .collect();
        let qk: Q = q
            .iter()
            .filter(|(t, _)| naming(t))
            .map(|(t, w)| (t.clone(), *w))
            .collect();

        let total = |x: usize| -> f64 {
            let r = &self.pool[x];
            let doc = &self.docs[x];
            let lex = self.lexical(&qc, doc);
            let lex_k = self.lexical(&qk, doc);
            let mut s = lex;
            if let Some(w) = &win
                && self.in_window(r, w, overdue)
            {
                s += 6.0;
            }
            if let Some(w) = &asked_win
                && lex + lex_k > 0.0
                && self.in_window(r, w, asked_overdue)
            {
                s += W_ASKED_DAY;
            }
            s += lex_k;
            if let Some(&k) = kinds.get(&r.entity) {
                s += lex * 0.6 * k + k;
                if lex > 0.0 {
                    // a named kind with any content or link match: strongly preferred
                    s += 2.0 * k;
                }
            }
            if anaph {
                s += near.get(r.id.as_str()).copied().unwrap_or(0.0);
            }
            s
        };
        let mut scored: Vec<(f64, usize)> = (0..self.pool.len()).map(|x| (total(x), x)).collect();
        let keys: Vec<Key> = self.pool.iter().map(key).collect();
        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| keys[b.1].cmp(&keys[a.1]))
        });
        let Some(&(best, _)) = scored.first() else {
            return vec![];
        };
        let content = qtoks.iter().any(|t| {
            !o.kind_intent.contains_key(t)
                && syn(t).is_empty()
                && self.df.get(t).copied().unwrap_or(0) > 0
                && !["have", "got", "kept", "saved", "made"].contains(&t.as_str())
        });
        let k = self.k;
        let mut top: Vec<usize> = scored
            .iter()
            .take(12)
            .filter(|(s, _)| *s > 0.0 && *s >= 0.55 * best)
            .map(|(_, x)| *x)
            .take(k.max(3))
            .collect();
        if top.len() < k {
            top = scored
                .iter()
                .take(k)
                .filter(|(s, _)| *s > 0.0)
                .map(|(_, x)| *x)
                .collect();
        }
        for (ent, &kw) in &kinds {
            let rows: Vec<usize> = self
                .bykind
                .get(ent)
                .into_iter()
                .flatten()
                .copied()
                .filter(|&x| self.pool[x].live)
                .collect();
            if kw >= 0.8 && rows.len() <= LISTABLE_MAX && !content {
                let seen: HashSet<usize> = top.iter().copied().collect();
                top.extend(rows.into_iter().filter(|x| !seen.contains(x)));
            }
        }
        // THE KIND THE REQUEST NAMES LEADS. Of the rows found, those of a
        // strongly named kind that also match the request's content, dates or
        // referents come first, in rank order ("the APPOINTMENT" puts the
        // event before the task that mentions one; "Priya from my CONTACTS"
        // does not put a stranger's phone number first); a ruled-out kind
        // ("not the tasks") goes last.
        let tier = |x: usize| -> u8 {
            let r = &self.pool[x];
            if demoted.contains(&r.entity) {
                return 2;
            }
            let named = kinds.get(&r.entity).is_some_and(|k| *k >= 0.8);
            let matched = self.lexical(&qc, &self.docs[x]) > 0.0
                || win.as_ref().is_some_and(|w| self.in_window(r, w, overdue))
                || (anaph && near.get(r.id.as_str()).is_some_and(|n| *n > 0.0));
            u8::from(!(named && matched))
        };
        top.sort_by_key(|&x| tier(x));
        let st = Search {
            q,
            kinds,
            win,
            overdue,
            asked: asked_win.map(|w| (w, asked_overdue)),
        };
        // A CONTAINER QUESTION ("who's in the Tahoe Trip group", "what's in
        // the album") is answered by the container's members, so they are
        // hits, right behind the container: its people for "who", the rows
        // that belong to it for "what".
        if rx.container.is_match(&ql)
            && let Some(&c) = top.first()
        {
            let who = ql.contains("who");
            let cid = self.pool[c].id.clone();
            let mut members: Vec<(f64, usize)> = Vec::new();
            for (n, w) in self.link_iter(&cid) {
                for &x in self.byid.get(n).into_iter().flatten() {
                    let r = &self.pool[x];
                    let party = r.entity == "core.party";
                    let belongs =
                        (w - W_BACK).abs() < 1e-9 || (w - role_weight("member")).abs() < 1e-9;
                    if r.live && if who { party } else { belongs && !party } {
                        members.push((self.link_score(n, 0.0, &st), x));
                        break;
                    }
                }
            }
            members.sort_by(|a, b| {
                b.0.partial_cmp(&a.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| keys[a.1].cmp(&keys[b.1]))
            });
            let add: Vec<usize> = members
                .into_iter()
                .map(|(_, x)| x)
                .take(2 * MAX_INLINE)
                .collect();
            top.retain(|x| !add.contains(x));
            top.splice(1..1, add);
        }
        let mut hits: Vec<Hit> = top
            .iter()
            .map(|&x| {
                let (shown, cut) = self.inline(&self.pool[x].id, &st);
                Hit {
                    row: self.pool[x].clone(),
                    links: shown.into_iter().map(|n| self.first(&n).clone()).collect(),
                    more: cut.into_iter().map(|n| self.first(&n).clone()).collect(),
                }
            })
            .collect();
        // hits that share a container they belong to (two expenses of one group):
        // the container's other members of the hits' kind are on screen too
        let mut boxes: IndexMap<(String, String), Vec<usize>> = IndexMap::new();
        for (h, &x) in top.iter().take(k).enumerate() {
            let r = &self.pool[x];
            for (n, w) in self.link_iter(&r.id) {
                if w >= W_BELONGS && self.first(n).entity != r.entity {
                    boxes
                        .entry((n.clone(), r.entity.clone()))
                        .or_default()
                        .push(h);
                }
            }
        }
        for ((n, ent), holders) in boxes {
            if holders.len() < 2 {
                continue;
            }
            let mut mem: Vec<(f64, &String)> = self
                .link_iter(&n)
                .filter(|(m, _)| self.byid[*m].iter().any(|&x| self.pool[x].entity == ent))
                .map(|(m, _)| (self.link_score(m, 0.0, &st), m))
                .collect();
            mem.sort_by(|a, b| {
                b.0.partial_cmp(&a.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.1.cmp(a.1))
            });
            let h = &mut hits[holders[0]];
            for (at, (_, m)) in mem.into_iter().enumerate() {
                if h.row.id == *m || h.links.iter().any(|l| l.id == *m) {
                    continue;
                }
                if at < MAX_INLINE {
                    h.links.push(self.first(m).clone());
                    h.more.retain(|l| l.id != *m);
                } else if !h.more.iter().any(|l| l.id == *m) {
                    h.more.push(self.first(m).clone());
                }
            }
        }
        hits
    }

    fn link_score(&self, n: &str, w: f64, st: &Search) -> f64 {
        let mut best = 0.0_f64;
        for &x in self.byid.get(n).into_iter().flatten() {
            let r = &self.pool[x];
            let mut sc = self.lexical(&st.q, &self.docs[x]) + w;
            if let Some(k) = st.kinds.get(&r.entity) {
                sc += 2.0 * k;
            }
            if st
                .win
                .as_ref()
                .is_some_and(|win| self.in_window(r, win, st.overdue))
                || st
                    .asked
                    .as_ref()
                    .is_some_and(|(win, overdue)| self.in_window(r, win, *overdue))
            {
                sc += 3.0;
            }
            best = best.max(sc);
        }
        best
    }

    /// A hit's inline links, best first: at most [`MAX_INLINE`] of each linked
    /// kind (twice that of a kind the request names); and the ones cut.
    fn inline(&self, i: &str, st: &Search) -> (Vec<String>, Vec<String>) {
        let mut scored: Vec<(f64, &String)> = self
            .link_iter(i)
            .map(|(n, w)| (self.link_score(n, w, st), n))
            .collect();
        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.1.cmp(a.1))
        });
        if scored.len() <= MAX_INLINE {
            return (
                scored.into_iter().map(|(_, n)| n.clone()).collect(),
                Vec::new(),
            );
        }
        let mut per: HashMap<&str, usize> = HashMap::new();
        let (mut out, mut cut) = (Vec::new(), Vec::new());
        for (_, n) in scored {
            let ent = self.first(n).entity.as_str();
            let cap = MAX_INLINE * if st.kinds.contains_key(ent) { 2 } else { 1 };
            let c = per.entry(ent).or_default();
            if *c < cap {
                *c += 1;
                out.push(n.clone());
            } else {
                cut.push(n.clone());
            }
        }
        (out, cut)
    }

    /// **A TRASHED ROW THE REQUEST NAMES IS SHOWN AS TRASHED.** The index holds
    /// live rows only, so "delete the funnel photo" with the funnel photo
    /// already in the bin used to find the nearest LIVE photo, and a write
    /// went to a row nobody named. Of `trashed`, the rows whose label carries
    /// every content word of `query` (a word naming no kind), of a kind the
    /// query names when it names one; at most three, in the given order.
    #[must_use]
    pub fn trashed_matches<'a>(&self, query: &str, trashed: &'a [VaultRow]) -> Vec<&'a VaultRow> {
        let o = onto();
        let naming = |t: &str| {
            o.kind_intent.contains_key(t)
                || syn(t)
                    .iter()
                    .any(|(c, w)| *w >= 0.8 && o.kind_intent.contains_key(*c))
        };
        let words = tokens(query, false);
        let content: BTreeSet<&str> = words
            .iter()
            .map(String::as_str)
            .filter(|t| !naming(t) && !TRASH_WORDS.contains(t))
            .collect();
        if content.is_empty() {
            return Vec::new();
        }
        let named: BTreeSet<&str> = words
            .iter()
            .filter_map(|t| o.kind_intent.get(t.as_str()))
            .filter(|(_, strength)| *strength >= 0.8)
            .map(|(entity, _)| entity.as_str())
            .collect();
        trashed
            .iter()
            .filter(|row| named.is_empty() || named.contains(row.entity.as_str()))
            .filter(|row| {
                let label: BTreeSet<String> = tokens(&row.label, false).into_iter().collect();
                content.iter().all(|t| label.contains(*t))
            })
            .take(3)
            .collect()
    }

    /// Is a row of `entity` known by its NAME — a person, or a container
    /// other rows belong to (a group, an album, a notebook)? Those are the
    /// rows a bare name can leave ambiguous.
    #[must_use]
    pub fn goes_by_name(entity: &str) -> bool {
        entity == "core.party"
            || onto()
                .links
                .values()
                .flatten()
                .any(|l| l.role == "belongs" && l.to == entity)
    }

    /// The rows linked to the row `id`, one reading per neighbour.
    #[must_use]
    pub fn linked(&self, id: &str) -> Vec<&VaultRow> {
        self.link_iter(id).map(|(n, _)| self.first(n)).collect()
    }

    /// Does `row` fall inside the date window `request` names? `None` when the
    /// request names no window.
    #[must_use]
    pub fn within(&self, request: &str, row: &VaultRow) -> Option<bool> {
        let w = self.window(request)?;
        Some(self.in_window(row, &w, false))
    }

    /// The row indexed under (entity, id, app), if any.
    #[must_use]
    pub fn row(&self, entity: &str, id: &str, app: &str) -> Option<&VaultRow> {
        self.at
            .get(&(entity.to_owned(), id.to_owned(), app.to_owned()))
            .map(|&x| &self.pool[x])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g_format_matches_python() {
        assert_eq!(fmt_g(12.5), "12.5");
        assert_eq!(fmt_g(1234.0), "1234");
        assert_eq!(fmt_g(123_456.78), "123457");
        assert_eq!(fmt_g(1_000_000.0), "1e+06");
        assert_eq!(fmt_g(0.01), "0.01");
        assert_eq!(fmt_g(0.000_01), "1e-05");
    }

    #[test]
    fn number_words_and_phrases() {
        assert_eq!(numwords("twenty-one days"), "21 days");
        assert_eq!(numwords("sixty"), "60");
        assert_eq!(numwords("two one"), "2");
        assert_eq!(
            tokens("What's on my to-do list?", true),
            vec!["task".to_owned()]
        );
    }

    #[test]
    fn onto_is_derived() {
        let o = onto();
        assert_eq!(
            o.kind_intent.get("event").map(|x| x.0.as_str()),
            Some("core.event")
        );
        assert!(!o.links.is_empty());
    }

    fn row(id: &str, entity: &str, label: &str, date: Option<&str>) -> VaultRow {
        VaultRow {
            id: id.into(),
            entity: entity.into(),
            app: "agenda".into(),
            label: label.into(),
            date: date.map(Into::into),
            live: true,
            extra: BTreeMap::new(),
        }
    }

    #[test]
    fn a_named_label_ranks_first() {
        let rows = vec![
            row("a", "core.event", "Dentist cleaning", Some("2026-06-17")),
            row("b", "core.event", "Dinner with Neha", Some("2026-06-18")),
        ];
        let r = Ranker::new(&rows, "2026-06-15");
        let hits = r.search::<&str>("when is the dentist?", &[], &[]);
        assert_eq!(hits[0].row.id, "a");
        let hits = r.search::<&str>("anything on thursday", &[], &[]);
        assert_eq!(hits[0].row.id, "b");
    }

    #[test]
    fn window_phrases_resolve_as_search_reads_them() {
        let rows = vec![
            row("in", "core.event", "Cabin check-in", Some("2026-06-20")),
            row("out", "core.event", "Cabin check-out", Some("2026-06-23")),
            row("d", "core.event", "Dentist cleaning", Some("2026-06-17")),
        ];
        let r = Ranker::new(&rows, "2026-06-15");
        let at = |p: &str, last: &[Vec<String>]| r.resolve_window(p, last);
        let span = |a: &str, b: &str| Some((a.to_owned(), b.to_owned()));
        assert_eq!(
            at("next couple of months", &[]),
            span("2026-06-15", "2026-08-15")
        );
        assert_eq!(
            at("the next 3 weeks", &[]),
            span("2026-06-15", "2026-07-06")
        );
        assert_eq!(at("may", &[]), span("2026-05-01", "2026-05-31"));
        assert_eq!(
            at("while at the cabin", &[]),
            span("2026-06-20", "2026-06-23")
        );
        assert_eq!(
            at("that day", &[vec!["d".to_owned()]]),
            span("2026-06-17", "2026-06-17")
        );
        assert_eq!(at("that day", &[]), None);
        assert_eq!(at("the tahoe trip", &[]), None);
    }

    #[test]
    fn the_named_kind_leads_and_a_ruled_out_kind_trails() {
        let rows = vec![
            row(
                "t",
                "schedule.task",
                "Book dentist appointment",
                Some("2026-06-17"),
            ),
            row("e", "core.event", "Dentist cleaning", Some("2026-06-17")),
        ];
        let r = Ranker::new(&rows, "2026-06-15");
        let hits = r.search::<&str>("the dentist appointment", &[], &[]);
        assert_eq!(hits[0].row.id, "e");
        let hits = r.search(
            "the dentist, not the tasks",
            &["the dentist, not the tasks"],
            &[],
        );
        assert_eq!(hits.last().map(|h| h.row.id.as_str()), Some("t"));
    }

    #[test]
    fn a_cut_link_list_is_counted_and_a_named_trashed_row_found() {
        let mut rows = vec![row("g", "tally.group", "Tahoe Trip", None)];
        for i in 0..11 {
            let mut x = row(
                &format!("e{i}"),
                "tally.expense",
                &format!("Cost {i}"),
                None,
            );
            x.extra.insert("group_id".into(), "g".into());
            rows.push(x);
        }
        let r = Ranker::new(&rows, "2026-06-15");
        let hits = r.search::<&str>("tahoe trip", &[], &[]);
        let group = hits
            .iter()
            .find(|h| h.row.id == "g")
            .expect("the group is a hit");
        assert_eq!(group.links.len() + group.more.len(), 11);
        assert!(!group.more.is_empty());
        let mut binned = row(
            "f",
            "core.content_item",
            "Funnel close-up",
            Some("2026-06-01"),
        );
        binned.live = false;
        let trashed = vec![binned, row("x", "core.document", "Invoice", None)];
        let found = r.trashed_matches("delete the funnel photo", &trashed);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "f");
        assert!(r.trashed_matches("the invoice photo", &trashed).is_empty());
        assert!(r.trashed_matches("photos", &trashed).is_empty());
    }

    #[test]
    fn links_come_back_in_one_order() {
        let mut rows = vec![row("g", "tally.group", "Tahoe Trip", None)];
        for (i, name) in ["Neha", "Marco", "Ana", "Bo", "Ike"].iter().enumerate() {
            let mut x = row(
                &format!("e{i}"),
                "tally.expense",
                &format!("{name} paid"),
                None,
            );
            x.extra.insert("group_id".into(), "g".into());
            rows.push(x);
        }
        let a = Ranker::new(&rows, "2026-06-15").search::<&str>("tahoe trip", &[], &[]);
        for _ in 0..5 {
            let b = Ranker::new(&rows, "2026-06-15").search::<&str>("tahoe trip", &[], &[]);
            assert_eq!(a, b);
        }
    }
}
