//! TALLY, TAKEN OUT AT READ TIME (#1099, #1115). The app is gone from the runtime, but the held-out val and test
//! worlds still carry its `groups`, `expenses` and `debts`, and the seeder refuses a world with a section it does not
//! read. The frozen files are data-version artefacts and are not edited: [`WithoutTally`] strips the sections when a
//! world is read and leaves out the sessions that cannot be asked without them, and the report counts what it left
//! out. It goes when the held-out data is migrated; a source that is already clean passes through it unchanged.

use std::collections::HashSet;

use serde_json::Value;

use crate::EvalError;
use crate::gold::{Accept, Session};
use crate::source::{EvalSource, Exclusion};

/// The world sections Tally owned.
const SECTIONS: [&str; 3] = ["groups", "expenses", "debts"];
/// Kinds and verbs Tally owned, as a reference call states them.
const KINDS: [&str; 3] = ["group", "expense", "debt"];

/// Wraps a source and takes Tally out of what it gives.
pub struct WithoutTally<S> {
    inner: S,
}

impl<S: EvalSource> WithoutTally<S> {
    #[must_use]
    pub fn new(inner: S) -> Self {
        Self { inner }
    }

    /// The keys the Tally sections of a world defined.
    fn removed_keys(&self, world: &str) -> Result<HashSet<String>, EvalError> {
        let world = self.inner.world(world)?;
        Ok(SECTIONS
            .iter()
            .flat_map(|section| world[section].as_array().into_iter().flatten())
            .filter_map(|row| row["key"].as_str().map(str::to_owned))
            .collect())
    }
}

/// Every world key a session's gold names.
fn gold_keys(accept: &Accept) -> impl Iterator<Item = &str> {
    accept
        .rows
        .iter()
        .chain(&accept.candidates)
        .chain(&accept.already)
        .map(String::as_str)
        .chain(accept.reveal.iter().map(|r| r.key.as_str()))
        .chain(accept.diff.rows.iter().filter_map(|r| r.key.as_deref()))
        .chain(
            accept
                .diff
                .links
                .iter()
                .flat_map(|l| [l.from.as_str(), l.to.as_str()]),
        )
}

/// Why a session cannot be asked without Tally, if it cannot.
fn depends_on_tally(session: &Session, removed: &HashSet<String>) -> Option<String> {
    for turn in &session.turns {
        for accept in &turn.gold {
            if let Some(key) = gold_keys(accept).find(|k| removed.contains(*k)) {
                return Some(format!("gold names the Tally row {key}"));
            }
            if accept.diff.rows.iter().any(|r| {
                r.new
                    .as_deref()
                    .is_some_and(|kind| KINDS.contains(&kind.to_lowercase().as_str()))
            }) {
                return Some("gold creates a Tally row".to_owned());
            }
        }
        for call in turn.reference.iter().filter(|c| !c.bad) {
            let text = Value::Object(call.args.clone()).to_string().to_lowercase();
            if let Some(key) = removed.iter().find(|k| text.contains(&format!("${k}"))) {
                return Some(format!("a reference call names the Tally row {key}"));
            }
            let kind_or_verb = ["kind", "verb"]
                .iter()
                .filter_map(|name| call.args.get(*name).and_then(Value::as_str))
                .flat_map(|list| list.split(','))
                .map(|word| word.trim().to_lowercase())
                .find(|word| KINDS.contains(&word.as_str()) || word.starts_with("settle"));
            if let Some(word) = kind_or_verb {
                return Some(format!("a reference call uses the Tally {word}"));
            }
        }
    }
    None
}

impl<S: EvalSource> EvalSource for WithoutTally<S> {
    fn label(&self) -> String {
        self.inner.label()
    }

    fn sessions(&self) -> Result<Vec<Session>, EvalError> {
        let mut kept = Vec::new();
        for session in self.inner.sessions()? {
            let removed = self.removed_keys(&session.world)?;
            if depends_on_tally(&session, &removed).is_none() {
                kept.push(session);
            }
        }
        Ok(kept)
    }

    fn excluded(&self) -> Result<Vec<Exclusion>, EvalError> {
        let mut out = self.inner.excluded()?;
        for session in self.inner.sessions()? {
            let removed = self.removed_keys(&session.world)?;
            if let Some(reason) = depends_on_tally(&session, &removed) {
                out.push(Exclusion {
                    id: session.id,
                    reason,
                });
            }
        }
        Ok(out)
    }

    fn world(&self, name: &str) -> Result<Value, EvalError> {
        let mut world = self.inner.world(name)?;
        let removed = self.removed_keys(name)?;
        if let Some(object) = world.as_object_mut() {
            for section in SECTIONS {
                object.remove(section);
            }
            // a link to a row Tally defined has nothing to point at
            if let Some(Value::Array(links)) = object.get_mut("links") {
                links.retain(|link| {
                    ["from", "to"]
                        .iter()
                        .all(|end| link[end].as_str().is_none_or(|key| !removed.contains(key)))
                });
            }
        }
        Ok(world)
    }
}

/// Wraps a source and reads a task that is `in_progress` as `open`. The vault has had no `in_progress` since the
/// rebuild (#1135); `status = open` already covered both (D-1044-7), so a read or a `complete` keeps its meaning.
/// A session whose gold, reference calls or message speak of the status itself asks something that no longer
/// exists, and is left out and counted.
pub struct WithoutInProgress<S> {
    inner: S,
}

impl<S: EvalSource> WithoutInProgress<S> {
    #[must_use]
    pub fn new(inner: S) -> Self {
        Self { inner }
    }
}

fn mentions_in_progress(text: &str) -> bool {
    let text = text.to_lowercase();
    text.contains("in_progress") || text.contains("in progress") || text.contains("in-progress")
}

fn asks_about_in_progress(session: &Session) -> bool {
    session.turns.iter().any(|turn| {
        mentions_in_progress(&turn.user)
            || turn.reference.iter().any(|call| {
                !call.bad && mentions_in_progress(&Value::Object(call.args.clone()).to_string())
            })
            || turn.gold.iter().any(|accept| {
                accept
                    .diff
                    .rows
                    .iter()
                    .any(|row| mentions_in_progress(&Value::Object(row.fields.clone()).to_string()))
            })
    })
}

impl<S: EvalSource> EvalSource for WithoutInProgress<S> {
    fn label(&self) -> String {
        self.inner.label()
    }

    fn sessions(&self) -> Result<Vec<Session>, EvalError> {
        Ok(self
            .inner
            .sessions()?
            .into_iter()
            .filter(|s| !asks_about_in_progress(s))
            .collect())
    }

    fn excluded(&self) -> Result<Vec<Exclusion>, EvalError> {
        let mut out = self.inner.excluded()?;
        out.extend(
            self.inner
                .sessions()?
                .into_iter()
                .filter(asks_about_in_progress)
                .map(|s| Exclusion {
                    id: s.id,
                    reason: "asks about the in_progress status, which the vault no longer has"
                        .to_owned(),
                }),
        );
        Ok(out)
    }

    fn world(&self, name: &str) -> Result<Value, EvalError> {
        let mut world = self.inner.world(name)?;
        for task in world["tasks"].as_array_mut().into_iter().flatten() {
            if task["status"] == "in_progress" {
                task["status"] = Value::String("open".to_owned());
            }
        }
        Ok(world)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::source::MemorySource;

    fn session(id: &str, gold: Value, reference: Value) -> Session {
        serde_json::from_value(
            json!({"id": id, "world": "W", "today": "2026-03-12T18:20", "me": "Sam",
            "turns": [{"user": "q", "gold": gold, "ref": reference}]}),
        )
        .expect("session")
    }

    fn source() -> MemorySource {
        let world = json!({"me": "Sam", "people": [{"key": "neha", "name": "Neha"}],
            "groups": [{"key": "casa", "name": "Casa"}], "expenses": [{"group": "casa", "name": "Rent"}],
            "debts": [{"key": "acl", "person": "neha"}],
            "links": [{"from": "acl", "to": "neha"}, {"from": "neha", "to": "neha"}]});
        MemorySource {
            label: "t".to_owned(),
            sessions: vec![
                session(
                    "ok",
                    json!([{"type": "rows", "rows": ["neha"]}]),
                    json!([{"tool": "answer", "args": {"kind": "person"}}]),
                ),
                session(
                    "gold",
                    json!([{"type": "rows", "rows": ["acl"]}]),
                    json!([]),
                ),
                session(
                    "link",
                    json!([{"type": "diff", "diff": {"rows": [], "links": [{"change": "added", "from": "neha", "to": "casa"}]}}]),
                    json!([]),
                ),
                session(
                    "kind",
                    json!([{"type": "rows", "rows": []}]),
                    json!([{"tool": "answer", "args": {"kind": "debt"}}]),
                ),
                session(
                    "handle",
                    json!([{"type": "rows", "rows": []}]),
                    json!([{"tool": "act", "args": {"verb": "complete", "rows": "$acl"}}]),
                ),
                session(
                    "verb",
                    json!([{"type": "rows", "rows": []}]),
                    json!([{"tool": "act", "args": {"verb": "settle_up", "rows": "#1"}}]),
                ),
            ],
            worlds: [("W".to_owned(), world)].into_iter().collect(),
        }
    }

    #[test]
    fn the_sections_and_the_links_to_them_go_and_the_rest_stays() {
        let world = WithoutTally::new(source()).world("W").expect("world");
        for section in SECTIONS {
            assert!(world.get(section).is_none(), "{section}");
        }
        assert_eq!(world["people"][0]["key"], "neha");
        assert_eq!(world["links"].as_array().expect("links").len(), 1);
    }

    #[test]
    fn a_session_that_needs_tally_is_left_out_and_counted_with_its_reason() {
        let wrapped = WithoutTally::new(source());
        let kept: Vec<String> = wrapped
            .sessions()
            .expect("sessions")
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(kept, vec!["ok".to_owned()]);
        let excluded = wrapped.excluded().expect("excluded");
        let ids: Vec<&str> = excluded.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["gold", "link", "kind", "handle", "verb"]);
        assert!(excluded[0].reason.contains("acl"));
        assert!(excluded[4].reason.contains("settle_up"));
    }

    #[test]
    fn an_in_progress_task_reads_as_open_and_a_session_about_the_status_is_counted() {
        let mut inner = source();
        inner.worlds.get_mut("W").expect("world")["tasks"] =
            json!([{"key": "t", "name": "T", "status": "in_progress"}]);
        inner.sessions = vec![
            session(
                "plain",
                json!([{"type": "rows", "rows": ["t"]}]),
                json!([{"tool": "answer", "args": {"kind": "task"}}]),
            ),
            session(
                "status",
                json!([{"type": "rows", "rows": ["t"]}]),
                json!([{"tool": "answer", "args": {"kind": "task", "where": "status = in_progress"}}]),
            ),
            session("words", json!([{"type": "rows", "rows": []}]), json!([])),
            session(
                "tally",
                json!([{"type": "rows", "rows": ["acl"]}]),
                json!([]),
            ),
        ];
        inner.sessions[2].turns[0].user = "what is in progress".to_owned();
        let wrapped = WithoutInProgress::new(WithoutTally::new(inner));
        assert_eq!(
            wrapped.world("W").expect("world")["tasks"][0]["status"],
            "open"
        );
        let kept: Vec<String> = wrapped
            .sessions()
            .expect("sessions")
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(kept, vec!["plain".to_owned()]);
        let excluded: Vec<String> = wrapped
            .excluded()
            .expect("excluded")
            .into_iter()
            .map(|e| e.id)
            .collect();
        assert_eq!(
            excluded,
            vec!["tally", "status", "words"],
            "the inner source's exclusions are kept"
        );
    }

    #[test]
    fn a_source_without_tally_passes_through_unchanged() {
        let mut clean = source();
        if let Some(world) = clean.worlds.get_mut("W").and_then(Value::as_object_mut) {
            for section in SECTIONS {
                world.remove(section);
            }
        }
        clean.sessions.truncate(1);
        let wrapped = WithoutTally::new(clean);
        assert_eq!(wrapped.sessions().expect("sessions").len(), 1);
        assert!(wrapped.excluded().expect("excluded").is_empty());
    }
}
