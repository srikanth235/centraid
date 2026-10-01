//! `search` and the pre-grounding block (SPEC §4, §6.1): one name index.
//!
//! Ranking is retrieval, not interpretation: the vault's FTS door
//! (`crates/search`, prefix phrases over each domain's label and indexed
//! text) plus a whole-word / prefix / one-edit match over every model row's
//! name, so kinds the FTS door does not index (groups, albums, locker items)
//! are found the same way.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::meta::{Kind, PREGROUND_CAP, lookup_shown};
use crate::render;
use crate::session::{Outcome, ResultSet, Session, words};
use crate::world::Key;

/// The FTS domains and the model kind each answers for.
const FTS: &[(&str, Kind)] = &[
    ("core.party", Kind::Person),
    ("knowledge.note", Kind::Note),
    ("core.event", Kind::Event),
    ("schedule.task", Kind::Task),
    ("core.document", Kind::Document),
];

/// Words a message token must not be matched on.
const STOPWORDS: &[&str] = &[
    "the",
    "and",
    "for",
    "with",
    "what",
    "whats",
    "who",
    "when",
    "where",
    "which",
    "how",
    "have",
    "has",
    "had",
    "did",
    "does",
    "can",
    "could",
    "would",
    "should",
    "will",
    "are",
    "was",
    "were",
    "you",
    "your",
    "our",
    "his",
    "her",
    "their",
    "them",
    "they",
    "this",
    "that",
    "these",
    "those",
    "from",
    "into",
    "about",
    "any",
    "all",
    "some",
    "been",
    "not",
    "but",
    "out",
    "get",
    "got",
    "please",
    "show",
    "tell",
    "list",
    "find",
    "give",
    "make",
    "add",
    "put",
    "set",
    "move",
    "mark",
    "last",
    "next",
    "today",
    "tomorrow",
    "yesterday",
    "week",
    "month",
    "year",
    "there",
    "here",
    "just",
    "also",
    "then",
    "than",
    "too",
    "very",
    "much",
    "many",
    "more",
    "most",
    "one",
    "two",
];

/// The request's verb, in the forms people type it: never a name to
/// pre-ground ("star it" is not about "Starlight Theatre"). The metadata's
/// own verb names (split on `_`) are added by `is_verb_word`.
const VERB_FORMS: &[&str] = &[
    "stars",
    "starred",
    "starring",
    "unstarred",
    "deleted",
    "deleting",
    "deletes",
    "completed",
    "completing",
    "completes",
    "done",
    "finish",
    "finished",
    "cancelled",
    "canceled",
    "cancelling",
    "canceling",
    "cancels",
    "restored",
    "restoring",
    "restores",
    "logged",
    "logging",
    "logs",
    "reopened",
    "reopening",
    "rescheduled",
    "rescheduling",
    "postpone",
    "postponed",
    "push",
    "pushed",
    "move",
    "moved",
    "created",
    "creating",
    "new",
    "edited",
    "editing",
    "change",
    "changed",
    "update",
    "updated",
    "rename",
    "renamed",
    "added",
    "adding",
    "removed",
    "removing",
    "settled",
    "settling",
    "pay",
    "paid",
    "revealed",
    "revealing",
    "undone",
    "trash",
    "trashed",
    "pin",
    "pinned",
    "unpin",
    "archive",
    "archived",
    "mark",
    "marked",
    "open",
    "opened",
    "remind",
    "save",
    "saved",
];

/// Whether a message token is a verb word rather than a name.
fn is_verb_word(token: &str) -> bool {
    VERB_FORMS.contains(&token)
        || crate::meta::VERBS
            .iter()
            .any(|verb| verb.name.split('_').any(|part| part == token))
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut current = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            current.push(
                (previous[j] + cost)
                    .min(previous[j + 1] + 1)
                    .min(current[j] + 1),
            );
        }
        previous = current;
    }
    previous[b.len()]
}

/// 3 exact, 2 prefix, 1 near spelling, 0 none.
#[must_use]
pub fn word_score(query: &str, word: &str) -> u32 {
    if query == word {
        3
    } else if query.len() >= 2 && word.starts_with(query) {
        2
    } else {
        let limit = if query.len() >= 7 { 2 } else { 1 };
        if query.len() >= 4 && edit_distance(query, word) <= limit {
            1
        } else {
            0
        }
    }
}

/// The fields a name search also reads: what people call a person.
const ALSO_NAMED: &[&str] = &["nickname", "role"];

/// The words a row answers to: its name, plus its nickname and role.
fn row_words(row: &crate::world::Row) -> Vec<String> {
    let mut out = words(&row.name);
    for field in ALSO_NAMED {
        if let Some(crate::world::Val::Text(text)) = row.field(field) {
            out.extend(words(text));
        }
    }
    out
}

/// Every row the text reaches, live and trashed, best first; at the same
/// score a live row comes before a trashed one.
fn ranked(session: &Session, text: &str, kinds: &[Kind]) -> Vec<(Key, u32)> {
    let query = words(text);
    if query.is_empty() {
        return Vec::new();
    }
    let mut scores: BTreeMap<Key, u32> = BTreeMap::new();
    for row in session.world.rows.values() {
        if !kinds.contains(&row.kind) {
            continue;
        }
        let name = row_words(row);
        let mut total = 0;
        let mut matched = 0;
        for word in &query {
            let best = name
                .iter()
                .map(|have| word_score(word, have))
                .max()
                .unwrap_or(0);
            if best > 0 {
                matched += 1;
            }
            total += best;
        }
        if matched * 2 >= query.len() && total > 0 {
            scores.insert(row.key(), total);
        }
    }
    for (entity, kind) in FTS {
        if !kinds.contains(kind) {
            continue;
        }
        let Ok(targets) = session.handle.search(entity, text, 50) else {
            continue;
        };
        for target in targets {
            let key = (*kind, target.id.clone());
            if session.world.row(&key).is_some() {
                *scores.entry(key).or_insert(0) += 1;
            }
        }
    }
    let mut out: Vec<(Key, u32)> = scores.into_iter().collect();
    let trashed = |key: &Key| session.world.row(key).is_some_and(|row| row.trashed);
    out.sort_by(|(a, x), (b, y)| {
        y.cmp(x)
            .then_with(|| trashed(a).cmp(&trashed(b)))
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| {
                let name = |key: &Key| {
                    session
                        .world
                        .rows
                        .get(key)
                        .map(|row| row.name.to_lowercase())
                };
                name(a).cmp(&name(b))
            })
            .then_with(|| a.1.cmp(&b.1))
    });
    out
}

/// The `search` tool.
pub fn search(session: &mut Session, args: &Map<String, Value>) -> Result<Outcome, String> {
    let text = match args.get("text") {
        Some(Value::String(text)) if !text.trim().is_empty() => text.trim().to_owned(),
        _ => return Err("error: search needs text.".to_owned()),
    };
    let kinds = match args.get("kind") {
        None | Some(Value::Null) => Kind::ALL.to_vec(),
        Some(Value::String(kind)) => {
            let mut out = Vec::new();
            for part in kind
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
            {
                if part.eq_ignore_ascii_case("any") {
                    out = Kind::ALL.to_vec();
                    break;
                }
                let parsed = Kind::parse(part).ok_or_else(|| {
                    format!(
                        "error: no kind \"{part}\". kinds: any, {}.",
                        crate::whr::kind_names()
                    )
                })?;
                out.push(parsed);
            }
            out
        }
        Some(other) => return Err(format!("error: kind is text, not {other}.")),
    };
    let hits = ranked(session, &text, &kinds);
    let mut outcome = Outcome::text("");
    if hits.is_empty() {
        let message = format!(
            "0 rows match \"{text}\" by name, nickname or role, live or trashed. Try other words, or find with where on a field."
        );
        outcome.effect.insert("recovery".to_owned(), json!("empty"));
        session.push_obs(
            true,
            None,
            message.clone(),
            message,
            Vec::new(),
            &mut outcome,
        );
        outcome.effect.insert("rows".to_owned(), json!([]));
        return Ok(outcome);
    }
    let keys: Vec<Key> = hits.iter().map(|(key, _)| key.clone()).collect();
    let mut found_kinds: Vec<Kind> = Vec::new();
    for key in &keys {
        if !found_kinds.contains(&key.0) {
            found_kinds.push(key.0);
        }
    }
    found_kinds.sort();
    session.results.push(ResultSet {
        kinds: found_kinds.clone(),
        keys: keys.clone(),
        value: None,
    });
    let handle = session.results.len();
    let rows: Vec<_> = keys
        .iter()
        .filter_map(|key| session.world.row(key).cloned())
        .collect();
    let refs: Vec<_> = rows.iter().collect();
    let summary = format!(
        "search \"{text}\": {}",
        render::count_phrase(&found_kinds, &refs)
    );
    let cap = lookup_shown(rows.len());
    let header = format!("@{handle} · {summary} (showing {})", rows.len().min(cap));
    let mut lines = Vec::new();
    for (position, row) in rows.iter().take(cap).enumerate() {
        let number = session.number(&row.key());
        let mut numbers = vec![number];
        let mut line = render::row_line(number, Some(position + 1), row, session.today());
        let mut parts = Vec::new();
        for (_, others) in session.world.neighbours(&row.key()) {
            for other in others {
                if parts.len() >= 3 {
                    break;
                }
                let Some(other_row) = session.world.row(&other).cloned() else {
                    continue;
                };
                if other_row.trashed {
                    continue;
                }
                let n = session.number(&other);
                numbers.push(n);
                parts.push(format!("{} #{n} \"{}\"", other.0.name(), other_row.name));
            }
        }
        line.push_str(&render::links_inline(&parts));
        lines.push((numbers, line));
    }
    if rows.len() > cap {
        lines.push((
            Vec::new(),
            format!(
                "… {} more in @{handle} (narrow with kind or a fuller text)",
                rows.len() - cap
            ),
        ));
    }
    session.push_obs(true, Some(handle), summary, header, lines, &mut outcome);
    outcome
        .effect
        .insert("rows".to_owned(), session.keys_json(&keys));
    outcome
        .effect
        .insert("result".to_owned(), json!(format!("@{handle}")));
    Ok(outcome)
}

/// The pre-grounding block for one user message, or `None` when no token
/// reaches a row (SPEC §6.1).
pub fn preground(session: &mut Session, message: &str) -> Option<String> {
    let mut tally: BTreeMap<Key, (usize, u32)> = BTreeMap::new();
    let mut seen = Vec::new();
    for token in words(message) {
        if token.len() < 3
            || STOPWORDS.contains(&token.as_str())
            || is_verb_word(&token)
            || seen.contains(&token)
        {
            continue;
        }
        seen.push(token.clone());
        // THE SAME INDEX `search` USES: the vault's FTS door answers for its
        // domains, and the name index for the kinds it does not cover.
        let mut candidates: Vec<Key> = Vec::new();
        for (entity, kind) in FTS {
            if let Ok(targets) = session.handle.search(entity, &token, 50) {
                candidates.extend(targets.into_iter().map(|target| (*kind, target.id)));
            }
        }
        candidates.extend(
            session
                .world
                .rows
                .values()
                .filter(|row| !FTS.iter().any(|(_, kind)| *kind == row.kind))
                .map(|row| row.key()),
        );
        candidates.sort();
        candidates.dedup();
        for key in candidates {
            let Some(row) = session.world.row(&key) else {
                continue;
            };
            if row.trashed {
                continue;
            }
            let best = words(&row.name)
                .iter()
                .map(|word| word_score(&token, word))
                .max()
                .unwrap_or(0);
            // THE THRESHOLD: an exact or prefix hit on a NAME word. A body
            // match or a near spelling is `search`'s to offer, not the
            // prompt's.
            if best >= 2 {
                let slot = tally.entry(key).or_insert((0, 0));
                slot.0 += 1;
                slot.1 += best;
            }
        }
    }
    if tally.is_empty() {
        return None;
    }
    let mut ranked: Vec<(Key, (usize, u32))> = tally.into_iter().collect();
    ranked.sort_by(|(a, x), (b, y)| {
        y.cmp(x).then_with(|| a.0.cmp(&b.0)).then_with(|| {
            let name = |key: &Key| {
                session
                    .world
                    .rows
                    .get(key)
                    .map(|row| row.name.to_lowercase())
            };
            name(a).cmp(&name(b))
        })
    });
    let mut parts = Vec::new();
    for (key, _) in ranked.into_iter().take(PREGROUND_CAP) {
        let number = session.number(&key);
        session.preground.insert(number);
        parts.push(render::named(&session.world, number, &key));
    }
    Some(format!("vault: {}", parts.join(" · ")))
}
