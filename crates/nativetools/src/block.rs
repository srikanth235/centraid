//! THE TURN BLOCK'S DETERMINISTIC PARTS (SPEC §6.1, #1044 phase 6): the model
//! judges, the harness composes. Everything here is a rule over the session's
//! state and the message, with no model in it:
//!
//! - the `focus:` line's result sets: the newest rows set in the one-set form,
//!   then the last `FOCUS_SETS` of the conversation under `earlier:`, a count
//!   or value among them, each naming the container its rows share
//!   (`sets_parts`);
//! - the rows a write acted on in the last `ACTED_TURNS` turns that no other
//!   part of the line names (`acted_part`), which are also the written rows
//!   the focus pick may count (`named_written`);
//! - the options of an ask with what tells them apart (`asked_part`), and the
//!   `answer:` line that says which option the next message's words fit
//!   (`answer_line`);
//! - the `picks:` line that says which rows an ordinal of the message counts to in the list
//!   the block shows (`picks_line`);
//! - the rows the `vault:` line adds to the ones the message names: the
//!   container the message points at by its kind word (`container_hit`), the
//!   person's own row, last and only when no one else is in play (`me_hit`),
//!   and the cut of a name more than `COPIES_SHOWN` rows share (`same_name`).
//!
//! The line never mints a number except in `number_containers`, which the turn
//! runs once before it renders; `focus_line` only reads.

use std::collections::{BTreeMap, BTreeSet};

use crate::meta::{Kind, LOOKUP_CAP, ROW_CAP, Via};
use crate::render;
use crate::search::{can_name, fold, spellings_of};
use crate::session::Session;
use crate::world::{Key, Val, World};

/// Result sets the focus line holds, newest first.
pub(crate) const FOCUS_SETS: usize = 3;

/// Rows the focus line's result sets show in all; a set that does not fit is
/// cut with `+n more`.
pub(crate) const FOCUS_ROWS: usize = ROW_CAP;

/// Turns a written row stays named in the focus line's `acted` part, counted
/// from the turn that wrote it: written at turn 4, it is there at 5, 6 and 7.
/// The pick (`Session::focus`) reaches one turn back, the line three: a person
/// says "undo that" or "and the priority" a turn or two after the write, and
/// the line is what the model reads again.
pub(crate) const ACTED_TURNS: usize = 3;

/// Copies of a name a run shows before the rest are counted: the trained model
/// reads the candidates of an ask and of a pick off the line, so a run is cut
/// only when it is long (`+144 more` made it invent names).
const COPIES_SHOWN: usize = 6;

/// What a `compute` or `answer` with an op keeps beside its rows.
#[derive(Debug, Clone)]
pub(crate) struct SetNote {
    /// The value as the focus line says it, the op word first: `counted 10 documents`.
    pub text: String,
    /// The container the selector named, when it named one.
    pub container: Vec<Key>,
    /// The rows are what the value is about (a balance): the line lists them.
    pub list_rows: bool,
}

/// One result set of the focus line.
pub(crate) struct FocusSet {
    pub handle: usize,
    /// The rows still in the vault, in the set's order.
    pub keys: Vec<Key>,
    pub note: Option<SetNote>,
    /// The container every row shares.
    pub container: Vec<Key>,
}

/// The containers each of `keys` sits in, in one pass over the edges: a list's
/// tasks, a task's subtasks, a notebook's notes, a folder's documents, an
/// album's photos. A group is not one (a person is in several).
fn containers_for(world: &World, keys: &[Key]) -> BTreeMap<Key, Vec<Key>> {
    let wanted: BTreeSet<&Key> = keys.iter().collect();
    let mut out: BTreeMap<Key, Vec<Key>> = BTreeMap::new();
    for edge in &world.edges {
        if edge.via == Via::Membership || !wanted.contains(&edge.to) {
            continue;
        }
        let Some(link) = edge.from.0.holds() else {
            continue;
        };
        if link.via != edge.via
            || link.kind != edge.to.0
            || world.row(&edge.from).is_none_or(|row| row.trashed)
        {
            continue;
        }
        let held = out.entry(edge.to.clone()).or_default();
        if !held.contains(&edge.from) {
            held.push(edge.from.clone());
        }
    }
    out
}

/// The containers every one of `keys` sits in (at most two), in the first
/// row's order. Empty when a row sits in none, or when no row is given.
pub(crate) fn shared_container(world: &World, keys: &[Key]) -> Vec<Key> {
    let held = containers_for(world, keys);
    let mut shared: Option<Vec<Key>> = None;
    for key in keys {
        let mine = held.get(key).cloned().unwrap_or_default();
        shared = Some(match shared {
            None => mine,
            Some(so_far) => so_far.into_iter().filter(|c| mine.contains(c)).collect(),
        });
        if shared.as_ref().is_some_and(Vec::is_empty) {
            return Vec::new();
        }
    }
    let mut shared = shared.unwrap_or_default();
    shared.truncate(2);
    shared
}

/// The container rows a selector names with `linked_to`.
pub(crate) fn named_containers(world: &World, linked: &[Key]) -> Vec<Key> {
    linked
        .iter()
        .filter(|key| {
            key.0 != Kind::Group
                && key.0.spec().container
                && world.row(key).is_some_and(|row| !row.trashed)
        })
        .cloned()
        .collect()
}

/// The value of an op, as the focus line says it inside its brackets
/// (`SetNote::text`), the op word first so it cannot be read as a row set:
/// `counted 10 documents`, `summed 300.00 EUR amount over 2 expenses`,
/// `counted by status completed 1; open 4 over 5 tasks`, `balance 12.00 EUR`.
pub(crate) fn value_text(
    op: &str,
    field: Option<&str>,
    group: Option<&str>,
    value: &str,
    over: &str,
) -> String {
    let word = match op {
        "count" => "counted",
        "sum" => "summed",
        other => other,
    };
    let value = value.replace(" · ", "; ");
    let how = match group {
        Some(group) => format!("{word} by {group}"),
        None => word.to_owned(),
    };
    match (op, field, group) {
        ("count", _, None) => format!("{how} {over}"),
        ("balance", ..) => format!("{how} {value}"),
        (_, Some(field), _) => format!("{how} {value} {field} over {over}"),
        _ => format!("{how} {value} over {over}"),
    }
}

/// The result sets the focus line holds, newest first: the last
/// `FOCUS_SETS` that have something to show. A value counts as one (it keeps
/// its rows, `within: @n` reaches them); a set whose rows are all gone does not.
pub(crate) fn focus_sets(session: &Session) -> Vec<FocusSet> {
    let mut out: Vec<FocusSet> = Vec::new();
    for (index, set) in session.results.iter().enumerate().rev() {
        if out.len() == FOCUS_SETS {
            break;
        }
        let handle = index + 1;
        let note = session.result_notes.get(&handle).cloned();
        if set.value.is_some() && note.is_none() {
            continue;
        }
        let keys: Vec<Key> = set
            .keys
            .iter()
            .filter(|key| session.world.row(key).is_some())
            .cloned()
            .collect();
        let numbered = keys.iter().any(|key| session.numbers.contains_key(key));
        if note.is_none() && !numbered {
            continue;
        }
        let container = match &note {
            Some(note) if !note.container.is_empty() => note.container.clone(),
            _ => shared_container(&session.world, &keys),
        };
        out.push(FocusSet {
            handle,
            keys,
            note,
            container,
        });
    }
    out
}

/// Number the containers the focus sets name, so the line can say `in #8
/// album "Wedding"` and the call can use `#8`. The turn runs it once before it
/// renders the block; a container is a row the model has not been shown yet.
pub(crate) fn number_containers(session: &mut Session) {
    let containers: Vec<Key> = focus_sets(session)
        .into_iter()
        .flat_map(|set| set.container)
        .collect();
    for key in containers {
        session.number(&key);
    }
}

/// ` in #8 album "Wedding"`, or nothing when the container is not numbered.
fn container_text(session: &Session, container: &[Key]) -> Option<String> {
    let shown: Vec<String> = container
        .iter()
        .filter_map(|key| {
            let number = session.numbers.get(key).copied()?;
            Some(render::short(number, session.world.row(key)?))
        })
        .collect();
    (!shown.is_empty()).then(|| format!("in {}", shown.join(", ")))
}

/// The focus line's result parts. The newest set that holds rows leads, in
/// the one-set form the model's habit of pointing at the last result reads:
/// `@4: #8 task "A", #9 task "B" · in #2 list "Home"`. Every other set goes
/// after it under one `earlier:`, newest first: a set of rows as `@2: #30
/// task "X"`, a count or value in brackets with its word first and its handle
/// without a colon, so it is never read as rows: `@3 (counted 10 documents in
/// #39 folder "Taxes")`, `@3 (balance 70.00 USD over #12 person "Ray Ochoa")`.
/// At most `FOCUS_ROWS` rows in all, newest sets first; a set that does not
/// fit is cut with `+n more`.
pub(crate) fn sets_parts(session: &Session) -> SetsParts {
    let sets = focus_sets(session);
    let mut named: BTreeSet<usize> = BTreeSet::new();
    let lead = sets.iter().position(|set| set.note.is_none());
    let mut budget = FOCUS_ROWS;
    let mut lead_part: Option<String> = None;
    let mut earlier: Vec<String> = Vec::new();
    // the lead takes its rows first, then the other sets, newest first
    let order = lead
        .into_iter()
        .chain((0..sets.len()).filter(|i| Some(*i) != lead));
    let mut rendered: BTreeMap<usize, String> = BTreeMap::new();
    for index in order {
        let set = &sets[index];
        let numbered: Vec<usize> = set
            .keys
            .iter()
            .filter_map(|key| session.numbers.get(key).copied())
            .collect();
        let lists_rows = set.note.as_ref().is_none_or(|note| note.list_rows);
        let take = if lists_rows {
            numbered.len().min(budget)
        } else {
            0
        };
        let live = crate::prompt::live_numbers(session, &numbered[..take]);
        named.extend(live.iter().copied());
        let rows = crate::prompt::named_rows(session, &live);
        budget -= rows.len();
        let hidden = if lists_rows {
            set.keys.len().saturating_sub(rows.len())
        } else {
            0
        };
        let container = container_text(session, &set.container);
        let part = match &set.note {
            None => {
                let mut part = format!("@{}: ", set.handle);
                if rows.is_empty() {
                    part.push_str(&format!("+{hidden} more"));
                } else {
                    part.push_str(&rows.join(", "));
                    if hidden > 0 {
                        part.push_str(&format!(" +{hidden} more"));
                    }
                }
                if let Some(container) = container {
                    part.push_str(&format!(" · {container}"));
                }
                part
            }
            Some(note) => {
                let mut part = format!("@{} ({}", set.handle, note.text);
                if note.list_rows && !rows.is_empty() {
                    part.push_str(&format!(" over {}", rows.join(", ")));
                    if hidden > 0 {
                        part.push_str(&format!(" +{hidden} more"));
                    }
                }
                if let Some(container) = container {
                    part.push_str(&format!(" {container}"));
                }
                part.push(')');
                part
            }
        };
        rendered.insert(index, part);
    }
    for (index, part) in rendered {
        if Some(index) == lead {
            lead_part = Some(part);
        } else {
            earlier.push(part);
        }
    }
    // `rendered` is in set order, which is newest first
    let mut parts: Vec<String> = lead_part.into_iter().collect();
    if !earlier.is_empty() {
        parts.push(format!("earlier: {}", earlier.join(", ")));
    }
    SetsParts { parts, rows: named }
}

/// What the result sets of the focus line rendered: the parts, and the rows
/// they name. A container the line names after a set (`in #8 album "Wedding"`)
/// is not one of those rows: it is how the rows are grouped, not a row of the
/// set.
pub(crate) struct SetsParts {
    pub parts: Vec<String>,
    pub rows: BTreeSet<usize>,
}

/// The rows a write acted on (a change, an already-so answer, an undo) in the
/// last `ACTED_TURNS` turns before this one that the vault still holds, each
/// once, in the order the writes first touched them (a call's rows in the
/// order it names them, an undo's in the reverse of the write's). The turn the
/// person is writing in has no say: the line is the one rendered when the turn
/// began, and `{"focus": i}` counts its rows.
pub(crate) fn acted_rows(session: &Session) -> Vec<usize> {
    let mut rows: Vec<usize> = Vec::new();
    for mark in &session.marks {
        if mark.written
            && mark.turn < session.turn
            && mark.turn + ACTED_TURNS >= session.turn
            && !rows.contains(&mark.number)
        {
            rows.push(mark.number);
        }
    }
    crate::prompt::live_numbers(session, &rows)
}

/// The written rows the focus line can name: the last `LOOKUP_CAP` of
/// `acted_rows`. A row of them is on the line, in its `acted` part or in the
/// set or `created` part that names it (the rows `acted_part` leaves out are
/// the ones another part names); the pick counts no written row outside them.
pub(crate) fn named_written(session: &Session) -> BTreeSet<usize> {
    let rows = acted_rows(session);
    rows[rows.len().saturating_sub(LOOKUP_CAP)..]
        .iter()
        .copied()
        .collect()
}

/// THE ROWS A WRITE ACTED ON, `acted #12 task "Pay rent", #13 event "Dentist"`:
/// a row a write reached by a selector or off the `vault:` line came from no
/// result set, so without this part nothing is in focus after the write and a
/// follow-up ("undo that", "and the priority", "make it friday") has nothing
/// to point at. The rows of `acted_rows` that no other part names (`named`: the
/// rows of the result sets and of `created`), the last `LOOKUP_CAP` of them
/// with `+N earlier` for the rest, as `created`; outside the `FOCUS_ROWS`
/// budget of the sets.
pub(crate) fn acted_part(session: &Session, named: &BTreeSet<usize>) -> Option<String> {
    let rows: Vec<usize> = acted_rows(session)
        .into_iter()
        .filter(|number| !named.contains(number))
        .collect();
    if rows.is_empty() {
        return None;
    }
    let hidden = rows.len().saturating_sub(LOOKUP_CAP);
    let mut part = format!(
        "acted {}",
        crate::prompt::named_rows(session, &rows[hidden..]).join(", ")
    );
    if hidden > 0 {
        part.push_str(&format!(" +{hidden} earlier"));
    }
    Some(part)
}

/// The groups a person is in, by name.
fn groups_of(world: &World, key: &Key) -> Vec<String> {
    world
        .neighbours(key)
        .get(&Kind::Group)
        .into_iter()
        .flatten()
        .filter_map(|group| world.row(group))
        .map(|row| row.name.clone())
        .collect()
}

fn text_field(world: &World, key: &Key, name: &str) -> Option<String> {
    match world.row(key)?.field(name)? {
        Val::Text(text) if !text.is_empty() => Some(text.clone()),
        Val::Enum(text) => Some((*text).to_owned()),
        _ => None,
    }
}

/// What tells an option of an ask apart from the rows that share its name: a
/// person's role, nickname and groups; an event's or task's date and
/// container; a locker item's type and username; a note's, document's or
/// photo's container.
fn facets(world: &World, key: &Key) -> Vec<String> {
    let Some(row) = world.row(key) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    let container = |out: &mut Vec<String>| {
        let names: Vec<String> = containers_of(world, key)
            .iter()
            .filter_map(|c| world.row(c).map(|row| row.name.clone()))
            .collect();
        if !names.is_empty() {
            out.push(names.join(", "));
        }
    };
    match row.kind {
        Kind::Person => {
            out.extend(text_field(world, key, "role"));
            out.extend(text_field(world, key, "nickname"));
            let groups = groups_of(world, key);
            if !groups.is_empty() {
                out.push(groups.join(", "));
            }
        }
        Kind::Event => out.extend(row.date.map(|stamp| stamp.show())),
        Kind::Task => {
            out.extend(row.date.map(|stamp| stamp.show()));
            container(&mut out);
        }
        Kind::LockerItem => {
            out.extend(text_field(world, key, "type"));
            out.extend(text_field(world, key, "username"));
        }
        Kind::Document | Kind::Photo | Kind::Note => container(&mut out),
        _ => {}
    }
    out
}

/// Every container of one row (a photo can be in two albums).
fn containers_of(world: &World, key: &Key) -> Vec<Key> {
    containers_for(world, std::slice::from_ref(key))
        .remove(key)
        .unwrap_or_default()
}

/// `#21 person "Dan Kowalski" (neighbor · Big Dan · Block Party)`.
fn option_text(session: &Session, number: usize, key: &Key) -> String {
    let line = render::named(&session.world, number, key);
    let facets = facets(&session.world, key);
    if facets.is_empty() {
        line
    } else {
        format!("{line} ({})", facets.join(" · "))
    }
}

/// The options of the `ask` that ended the previous turn, with what tells them
/// apart, at most `ROW_CAP` (`+N more`). Only for the one turn that answers.
pub(crate) fn asked_part(session: &Session) -> Option<String> {
    let (turn, options) = &session.last_ask;
    if turn + 1 != session.turn {
        return None;
    }
    let rows: Vec<String> = options
        .iter()
        .filter_map(|number| {
            let key = session.by_number.get(number.wrapping_sub(1))?;
            session.world.row(key)?;
            Some(option_text(session, *number, key))
        })
        .collect();
    if rows.is_empty() {
        return None;
    }
    let shown = rows.len().min(ROW_CAP);
    let mut part = format!("asked: {}", rows[..shown].join(" · "));
    if rows.len() > shown {
        part.push_str(&format!(" +{} more", rows.len() - shown));
    }
    Some(part)
}

/// The words of a text with the text each came from, folded.
fn words_of(text: &str) -> Vec<(String, String)> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| (fold(word), word.to_lowercase()))
        .filter(|(folded, _)| !folded.is_empty())
        .collect()
}

/// The words an option answers to: its name, nickname, role and groups; for
/// the rest the same facets that tell the options apart.
fn answers_to(world: &World, key: &Key) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    if let Some(row) = world.row(key) {
        out.extend(spellings_of(&row.name));
    }
    for facet in facets(world, key) {
        out.extend(spellings_of(&facet));
    }
    out
}

/// Whether a message word is a word of `have`, or the start of one (three
/// letters or more).
fn says(word: &str, have: &BTreeSet<String>) -> bool {
    have.iter()
        .any(|name| name == word || (word.chars().count() >= 3 && name.starts_with(word)))
}

/// `answer: "the neighbor" → #21`: after an ask, the one option the new
/// message's words fit. A word that fits two options tells them apart no
/// better than the name did, so it counts for neither; when the words left
/// fit more than one option, or none, there is no line. The model still
/// writes the call; the line says which row the words are about.
pub(crate) fn answer_line(session: &Session) -> Option<String> {
    let (turn, options) = &session.last_ask;
    if turn + 1 != session.turn {
        return None;
    }
    let options: Vec<(usize, &Key)> = options
        .iter()
        .filter_map(|number| {
            let key = session.by_number.get(number.wrapping_sub(1))?;
            session.world.row(key)?;
            Some((*number, key))
        })
        .collect();
    let answers: Vec<BTreeSet<String>> = options
        .iter()
        .map(|(_, key)| answers_to(&session.world, key))
        .collect();
    let words = words_of(&session.message);
    let fitting = |word: &str| -> Vec<usize> {
        (0..options.len())
            .filter(|index| says(word, &answers[*index]))
            .collect()
    };
    let mut named: BTreeSet<usize> = BTreeSet::new();
    for (folded, _) in &words {
        if !can_name(folded) {
            continue;
        }
        if let [only] = fitting(folded).as_slice() {
            named.insert(*only);
        }
    }
    let named: Vec<usize> = named.into_iter().collect();
    let [only] = named[..] else {
        return None;
    };
    let (number, _) = options[only];
    // The words quoted: from the first to the last word that fits the option
    // (a shared one such as `dan` too), with the article before and the "one"
    // after.
    let spoken: Vec<usize> = words
        .iter()
        .enumerate()
        .filter(|(_, (folded, _))| can_name(folded) && says(folded, &answers[only]))
        .map(|(position, _)| position)
        .collect();
    let first = *spoken.first()?;
    let last = *spoken.last()?;
    let mut from = first;
    let mut to = last;
    if from > 0 && ["the", "that", "this", "a"].contains(&words[from - 1].0.as_str()) {
        from -= 1;
    }
    if words.get(to + 1).is_some_and(|(folded, _)| folded == "one") {
        to += 1;
    }
    let quoted: Vec<&str> = words[from..=to]
        .iter()
        .map(|(_, said)| said.as_str())
        .collect();
    Some(format!("answer: \"{}\" → #{number}", quoted.join(" ")))
}

/// The ordinal words of a pick: "first" to "tenth", by position.
const ORDINALS: [&str; 10] = [
    "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
];

/// The words that count: "two" to "ten".
const COUNTS: [&str; 9] = [
    "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
];

/// The nouns a pick may name its rows with: "the second task", "the last event".
const ROW_NOUNS: [&str; 17] = [
    "task", "event", "person", "contact", "note", "document", "photo", "album", "folder", "list",
    "notebook", "group", "debt", "expense", "item", "row", "entry",
];

/// What follows a count that makes it a stretch of time and not rows: "the last two weeks".
const TIME_UNITS: [&str; 14] = [
    "day", "days", "week", "weeks", "month", "months", "year", "years", "hour", "hours", "minute",
    "minutes", "night", "nights",
];

/// Picks one `picks:` line holds at most.
const PICKS_SHOWN: usize = 3;

/// The position an ordinal word names: `first`, `3rd`.
fn ordinal_position(word: &str) -> Option<usize> {
    if let Some(at) = ORDINALS.iter().position(|ordinal| *ordinal == word) {
        return Some(at + 1);
    }
    let digits = word
        .strip_suffix("st")
        .or_else(|| word.strip_suffix("nd"))
        .or_else(|| word.strip_suffix("rd"))
        .or_else(|| word.strip_suffix("th"))?;
    let at: usize = digits.parse().ok()?;
    (1..=10).contains(&at).then_some(at)
}

/// How many rows a count word or figure names: `two`, `3`.
fn count_of(word: &str) -> Option<usize> {
    COUNTS
        .iter()
        .position(|count| *count == word)
        .map(|at| at + 2)
        .or_else(|| word.parse().ok().filter(|at| (2..=99).contains(at)))
}

/// What a phrase of the message asks of the list.
#[derive(PartialEq, Eq)]
enum Ask {
    /// `count` rows from the one-based `position`, counting from the start.
    FromStart { position: usize, count: usize },
    /// The last `count` rows.
    FromEnd { count: usize },
    /// The one of two rows the last write did not touch.
    Other,
}

/// The ordinal phrases of a message that name rows of a list ("the last two", "the third one",
/// "the first task", "the other one"), in message order, with the words as said. An ordinal
/// alone, or one that dates something ("the first of may", "the first two weeks", "last night"),
/// names no rows.
fn ordinal_asks(message: &str) -> Vec<(String, Ask)> {
    let words = words_of(message);
    let word = |at: usize| words.get(at).map(|(folded, _)| folded.as_str());
    let mut out = Vec::new();
    for at in 0..words.len() {
        let Some(head) = word(at) else { continue };
        let (ask, used) = match (head, word(at + 1)) {
            ("other", Some("one")) => (Ask::Other, 1),
            ("last", Some("one")) => (Ask::FromEnd { count: 1 }, 1),
            ("last", Some(noun)) if ROW_NOUNS.contains(&noun) => (Ask::FromEnd { count: 1 }, 1),
            ("last", Some(count)) | ("first", Some(count))
                if count_of(count).is_some()
                    && !word(at + 2).is_some_and(|unit| TIME_UNITS.contains(&unit)) =>
            {
                let count = count_of(count).unwrap_or(2);
                if head == "last" {
                    (Ask::FromEnd { count }, 1)
                } else {
                    (Ask::FromStart { position: 1, count }, 1)
                }
            }
            (ordinal, Some(next)) if (next == "one" || ROW_NOUNS.contains(&next)) => {
                match ordinal_position(ordinal) {
                    Some(position) => (Ask::FromStart { position, count: 1 }, 1),
                    None => continue,
                }
            }
            _ => continue,
        };
        let start = if at > 0 && word(at - 1) == Some("the") {
            at - 1
        } else {
            at
        };
        let said: Vec<&str> = words[start..=at + used]
            .iter()
            .map(|(_, said)| said.as_str())
            .collect();
        out.push((said.join(" "), ask));
    }
    out
}

/// The list an ordinal of the message is over, in the order the block shows it, and how many of
/// its rows the block cut: the options of the ask that ended the previous turn, else the newest
/// result set of rows the `focus:` line shows at least two rows of (the line's row budget goes
/// to its lead set first, as `sets_parts` spends it).
fn pick_list(session: &Session) -> Option<(Vec<usize>, usize)> {
    let (turn, options) = &session.last_ask;
    let (list, hidden) = if turn + 1 == session.turn && !options.is_empty() {
        let live = crate::prompt::live_numbers(session, options);
        let hidden = live.len().saturating_sub(ROW_CAP);
        (live.into_iter().take(ROW_CAP).collect::<Vec<_>>(), hidden)
    } else {
        let sets = focus_sets(session);
        let lead = sets.iter().position(|set| set.note.is_none());
        let mut budget = FOCUS_ROWS;
        let mut shown: BTreeMap<usize, (Vec<usize>, usize)> = BTreeMap::new();
        for index in lead
            .into_iter()
            .chain((0..sets.len()).filter(|i| Some(*i) != lead))
        {
            let set = &sets[index];
            if set.note.as_ref().is_some_and(|note| !note.list_rows) {
                continue;
            }
            let numbered: Vec<usize> = set
                .keys
                .iter()
                .filter_map(|key| session.numbers.get(key).copied())
                .collect();
            let take = numbered.len().min(budget);
            let live = crate::prompt::live_numbers(session, &numbered[..take]);
            budget -= live.len();
            let hidden = set.keys.len().saturating_sub(live.len());
            if set.note.is_none() {
                shown.insert(index, (live, hidden));
            }
        }
        shown.into_values().find(|(rows, _)| rows.len() >= 2)?
    };
    (list.len() >= 2).then_some((list, hidden))
}

/// `picks: the last two = #34, #35`, the rows an ordinal of the message names in the list the
/// block shows, so the model copies the numbers instead of counting (SPEC §6.1). Only when the
/// message holds such a phrase and a list is in focus: "the last" of a list the block cut is
/// not named, nor an ordinal past the end, and "the other one" only of two rows of which the
/// previous write touched one. `None` when nothing is named.
pub(crate) fn picks_line(session: &Session, message: &str) -> Option<String> {
    let asks = ordinal_asks(message);
    if asks.is_empty() {
        return None;
    }
    let (list, hidden) = pick_list(session)?;
    let touched = acted_rows(session);
    let parts: Vec<String> = asks
        .into_iter()
        .filter_map(|(said, ask)| {
            let rows: &[usize] = match ask {
                Ask::FromStart { position, count } => {
                    list.get(position - 1..position - 1 + count)?
                }
                Ask::FromEnd { count } => {
                    if hidden > 0 {
                        return None;
                    }
                    list.get(list.len().checked_sub(count)?..)?
                }
                Ask::Other => {
                    let [first, second] = list[..] else {
                        return None;
                    };
                    match (touched.contains(&first), touched.contains(&second)) {
                        (true, false) => &list[1..],
                        (false, true) => &list[..1],
                        _ => return None,
                    }
                }
            };
            let numbers: Vec<String> = rows.iter().map(|number| format!("#{number}")).collect();
            Some(format!("{said} = {}", numbers.join(", ")))
        })
        .take(PICKS_SHOWN)
        .collect();
    (!parts.is_empty()).then(|| format!("picks: {}", parts.join(" · ")))
}

/// The container kind a message points at with its kind word and a
/// determiner (`that album`, `the folder`, `the list`).
fn container_kind_said(message: &str) -> Option<Kind> {
    let words = words_of(message);
    words.windows(2).find_map(|pair| {
        if !["that", "the", "this", "same", "those", "these", "its"].contains(&pair[0].0.as_str()) {
            return None;
        }
        match pair[1].0.as_str() {
            "album" | "albums" => Some(Kind::Album),
            "folder" | "folders" => Some(Kind::Folder),
            "list" | "lists" => Some(Kind::List),
            "notebook" | "notebooks" => Some(Kind::Notebook),
            _ => None,
        }
    })
}

/// A container the message mentions by its kind word ("that album", "the
/// folder", "the list"), grounded to the container of the focus rows: the
/// newest focus set whose rows share a container of that kind.
pub(crate) fn container_hit(session: &Session, message: &str) -> Option<Key> {
    let kind = container_kind_said(message)?;
    focus_sets(session)
        .into_iter()
        .flat_map(|set| set.container)
        .find(|key| key.0 == kind)
}

/// Whether the message or the conversation is about someone other than the
/// person: a pronoun for them (`with him`, `her balance with me`), or a person
/// in the focus sets, the options of the last ask or what was created.
pub(crate) fn other_person_in_play(session: &Session, message: &str) -> bool {
    const PRONOUNS: &[&str] = &[
        "him", "her", "he", "she", "them", "they", "his", "hers", "their", "theirs",
    ];
    let me = session.world.me_key();
    let said = words_of(message)
        .iter()
        .any(|(folded, _)| PRONOUNS.contains(&folded.as_str()));
    let numbered = |numbers: &[usize]| {
        numbers
            .iter()
            .filter_map(|number| session.by_number.get(number.wrapping_sub(1)))
            .any(|key| key.0 == Kind::Person && *key != me)
    };
    let asked = (session.last_ask.0 + 1 == session.turn) && numbered(&session.last_ask.1);
    said || asked
        || numbered(&session.created)
        || focus_sets(session)
            .iter()
            .flat_map(|set| set.keys.iter())
            .any(|key| key.0 == Kind::Person && *key != me)
}

/// The person's own row, when the message says my, me, I or mine with a
/// balance, debt or group sense ("my balance", "what do i owe", "where do i
/// stand") and no one else is in play (`other_person_in_play`; `other` is
/// whether the message names a person): addressable as `linked_to: #n`. With a
/// group named (`group_named`) the money words of a group alone are enough
/// ("money-wise", "up or down", "fronted", "paid", "spent", "put in", "out of
/// pocket"): a group's balance is the person's own. It goes last in the
/// `vault:` line. With someone else in play it is left out, whole: "her
/// balance with me" is about her, and the row was picked as the target.
pub(crate) fn me_hit(
    session: &Session,
    message: &str,
    other: bool,
    group_named: bool,
) -> Option<Key> {
    const FIRST_PERSON: &[&str] = &["my", "me", "i", "mine", "myself"];
    const SENSE: &[&str] = &[
        "balance", "balances", "owe", "owes", "owed", "debt", "debts", "stand", "standing",
        "position", "net", "tab", "group", "groups", "share",
    ];
    // what a group's money is called when no one says "my": single words, then word runs
    const GROUP_MONEY: &[&str] = &["moneywise", "fronted", "front", "paid", "spent", "spend"];
    const GROUP_MONEY_RUNS: &[&[&str]] = &[
        &["money", "wise"],
        &["up", "or", "down"],
        &["put", "in"],
        &["out", "of", "pocket"],
    ];
    let words: Vec<String> = words_of(message)
        .into_iter()
        .map(|(folded, _)| folded)
        .collect();
    let said = |list: &[&str]| words.iter().any(|word| list.contains(&word.as_str()));
    let said_run = |run: &[&str]| {
        words
            .windows(run.len())
            .any(|window| window.iter().zip(run).all(|(word, want)| word == want))
    };
    let money =
        group_named && (said(GROUP_MONEY) || GROUP_MONEY_RUNS.iter().any(|run| said_run(run)));
    let key = session.world.me_key();
    (((said(FIRST_PERSON) && said(SENSE)) || money)
        && !other
        && !other_person_in_play(session, message)
        && session.world.row(&key).is_some_and(|r| !r.trashed))
    .then_some(key)
}

/// Rows the conversation has touched: the rows of the focus sets, the options
/// of the last ask, what was created or acted on, and what the previous turn
/// opened or marked.
pub(crate) fn touched(session: &Session) -> BTreeSet<Key> {
    let mut numbers: BTreeSet<usize> = session.focus(false, true);
    numbers.extend(session.created.iter().copied());
    numbers.extend(session.acted.iter().copied());
    numbers.extend(session.last_ask.1.iter().copied());
    let mut out: BTreeSet<Key> = numbers
        .into_iter()
        .filter_map(|number| session.by_number.get(number.wrapping_sub(1)).cloned())
        .collect();
    for set in focus_sets(session) {
        out.extend(set.keys);
    }
    out
}

/// The cut of a name many rows share: of more than `COPIES_SHOWN` rows with one kind and
/// name ("Dentist" ×19), the rows the conversation touched and, to fill the
/// shown ones, the nearest to today; the rest are counted. Returns the rows to leave out
/// and, keyed by the last row kept of each run, how many were left out.
pub(crate) struct Copies {
    pub hide: BTreeSet<Key>,
    pub more: BTreeMap<Key, (usize, String)>,
}

pub(crate) fn same_name(session: &Session, keys: &[Key]) -> Copies {
    let mut runs: BTreeMap<(Kind, String), Vec<&Key>> = BTreeMap::new();
    for key in keys {
        if let Some(row) = session.world.row(key) {
            runs.entry((key.0, fold(&row.name))).or_default().push(key);
        }
    }
    let mut copies = Copies {
        hide: BTreeSet::new(),
        more: BTreeMap::new(),
    };
    if runs.values().all(|run| run.len() <= COPIES_SHOWN) {
        return copies;
    }
    let touched = touched(session);
    let today = session.today();
    for (_, run) in runs {
        if run.len() <= COPIES_SHOWN {
            continue;
        }
        let distance = |key: &Key| {
            session
                .world
                .row(key)
                .and_then(|row| row.date)
                .map(|stamp| (stamp.date - today).get_days().unsigned_abs())
        };
        let mut order = run.clone();
        order.sort_by(|a, b| {
            touched
                .contains(*b)
                .cmp(&touched.contains(*a))
                .then_with(|| match (distance(a), distance(b)) {
                    (Some(x), Some(y)) => x.cmp(&y),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                })
                .then_with(|| a.cmp(b))
        });
        let kept = order
            .iter()
            .filter(|key| touched.contains(**key))
            .count()
            .max(COPIES_SHOWN);
        let shown: BTreeSet<&Key> = order.iter().take(kept).copied().collect();
        let hidden = run.len() - shown.len();
        if hidden == 0 {
            continue;
        }
        let name = session
            .world
            .row(run[0])
            .map(|row| row.name.clone())
            .unwrap_or_default();
        if let Some(last) = run.iter().rev().find(|key| shown.contains(**key)) {
            copies.more.insert((*last).clone(), (hidden, name));
        }
        copies.hide.extend(
            run.iter()
                .filter(|key| !shown.contains(**key))
                .map(|key| (*key).clone()),
        );
    }
    copies
}
