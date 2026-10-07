//! THE TRACE GUARD (`experiments/toolchat/native/CONTRACT_V3.md` §2 to §4).
//!
//! A slot-trace `<think>` block is a fixed-order list of slots the model writes before its call:
//!
//! ```text
//! intent: write "cancel it"
//! verb: cancel
//! scope: one
//! refer: it "it" -> @3
//! target: "night shift"
//! ```
//!
//! The runtime reads three of them, the ones a call can contradict: `intent`, `scope` and
//! `refer`. A call that contradicts its own trace is answered with an error observation (a step
//! that counts, like a repeated call) and does nothing:
//!
//! - `intent: write` with an `answer` call, or `act` under any other intent;
//! - `scope: one` with a write that names several rows;
//! - `refer ... -> @k` (or `#n`) with rows that are not the referent's (`both` must be all of it).
//!
//! WHERE THE TRACE COMES FROM. `call_text` already receives the model's whole message, think
//! block included; `parse::parse_call` ignores everything before `<tool_call>`. Nothing new is
//! asked of the model or the driver: [`think_of`] takes the think text from the same message. A
//! harness that sends `call` (tool and args as JSON) may pass it as the optional `"think"` field.
//!
//! WHEN IT APPLIES. Only when the think parses as a slot trace ([`parse`]): an `intent:` line of the
//! exact form `intent: <read|count|write|ask|decline>` with an optional quoted phrase. The old
//! line (`saw: … · intent: write star · plan: act`) never matches, so old-format gold replays
//! untouched. A malformed `scope` or `refer` line is ignored, never punished.
//!
//! The cap on a write's rows does not read the trace: a write on more than `ROW_CAP` rows ends in
//! the runtime's own ask whatever `scope` says (`act.rs`, `Session::bulk_ask`).

use std::collections::BTreeSet;

use serde_json::Value;

use crate::native::identity::MODEL;
use crate::native::session::Session;
use crate::native::world::Key;

/// What the call is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    Read,
    Count,
    Write,
    Ask,
    Decline,
}

impl Intent {
    fn parse(word: &str) -> Option<Self> {
        Some(match word {
            "read" => Self::Read,
            "count" => Self::Count,
            "write" => Self::Write,
            "ask" => Self::Ask,
            "decline" => Self::Decline,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Count => "count",
            Self::Write => "write",
            Self::Ask => "ask",
            Self::Decline => "decline",
        }
    }
}

/// How many of the rows a write takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    One,
    Some,
    All,
}

impl Scope {
    fn parse(word: &str) -> Option<Self> {
        Some(match word {
            "one" => Self::One,
            "some" => Self::Some,
            "all" => Self::All,
            _ => return None,
        })
    }
}

/// How the message points back at rows an earlier turn showed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferKind {
    It,
    Both,
    That,
    Nth,
}

/// `refer: <kind> "<phrase>" -> <handles>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refer {
    pub kind: ReferKind,
    /// `@k` and `#n` handles, as written.
    pub handles: Vec<String>,
}

/// The slots the guard reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trace {
    pub intent: Intent,
    pub scope: Option<Scope>,
    pub refer: Option<Refer>,
}

/// The think text of a raw model message: what precedes its `<tool_call>`, inside `<think>`.
/// `None` when the message holds no call.
#[must_use]
pub fn think_of(message: &str) -> Option<&str> {
    let head = &message[..message.find(MODEL.tool_call_open)?];
    let head = head
        .rsplit_once(MODEL.think_close)
        .map_or(head, |(inside, _)| inside);
    let head = head.trim_start();
    let head = head
        .strip_prefix(MODEL.think_open.trim_end())
        .unwrap_or(head);
    Some(head.trim())
}

/// `word` then an optional ` "quoted phrase"` and nothing else.
fn word_and_quote(rest: &str) -> Option<&str> {
    let (word, tail) = rest.split_once(' ').unwrap_or((rest, ""));
    if tail.is_empty() || (tail.len() >= 2 && tail.starts_with('"') && tail.ends_with('"')) {
        Some(word)
    } else {
        None
    }
}

fn handle(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some('#' | '@'))
        && !text[1..].is_empty()
        && text[1..].chars().all(|c| c.is_ascii_digit())
}

fn parse_refer(rest: &str) -> Option<Refer> {
    let (head, handles) = rest.rsplit_once(" -> ")?;
    let handles: Vec<String> = handles.split(", ").map(str::to_owned).collect();
    if handles.is_empty() || !handles.iter().all(|h| handle(h)) {
        return None;
    }
    let kind = match word_and_quote(head)? {
        "it" => ReferKind::It,
        "both" => ReferKind::Both,
        "that" => ReferKind::That,
        "nth" => ReferKind::Nth,
        _ => return None,
    };
    Some(Refer { kind, handles })
}

/// The trace in a think block, when it is a slot trace (it has a well-formed `intent:` line).
#[must_use]
pub fn parse(think: &str) -> Option<Trace> {
    let mut intent = None;
    let mut scope = None;
    let mut refer = None;
    for line in think.lines() {
        let line = line.trim_end();
        if intent.is_none()
            && let Some(rest) = line.strip_prefix("intent: ")
        {
            intent = word_and_quote(rest).and_then(Intent::parse);
        } else if scope.is_none()
            && let Some(rest) = line.strip_prefix("scope: ")
        {
            scope = word_and_quote(rest).and_then(Scope::parse);
        } else if refer.is_none()
            && let Some(rest) = line.strip_prefix("refer: ")
        {
            refer = parse_refer(rest);
        }
    }
    Some(Trace {
        intent: intent?,
        scope,
        refer,
    })
}

fn contradiction(why: &str) -> String {
    format!(
        "error: the trace contradicts the call: {why}. Nothing was done; write the trace that matches the call, or the call that matches the trace."
    )
}

impl Session {
    /// `#n` of each key, for an error line.
    fn numbers_of(&self, keys: &BTreeSet<Key>) -> String {
        let list: Vec<String> = keys
            .iter()
            .map(|key| {
                self.numbers
                    .get(key)
                    .map_or_else(|| "?".to_owned(), |n| format!("#{n}"))
            })
            .collect();
        list.join(", ")
    }

    /// The rows a call's row-naming parameter (`rows`, `row`, `within`, `linked_to`, the first
    /// that is set) stands for, with its name. `None` when the call names none or they do not
    /// resolve (the call's own error says why).
    fn called_rows(
        &self,
        args: &serde_json::Map<String, Value>,
    ) -> Option<(&'static str, BTreeSet<Key>)> {
        for key in ["rows", "row", "within", "linked_to"] {
            if let Some(value) = args.get(key).filter(|value| !value.is_null()) {
                let keys = self.resolve_rows(value).ok()?;
                return Some((key, keys.into_iter().collect()));
            }
        }
        None
    }

    /// The rows a `refer` points at; `None` when a handle does not resolve or holds no rows.
    fn referent(&self, refer: &Refer) -> Option<BTreeSet<Key>> {
        let mut out = BTreeSet::new();
        for handle in &refer.handles {
            if handle.starts_with('@') {
                let n = self.resolve_result(handle).ok()?;
                out.extend(self.results[n - 1].keys.iter().cloned());
            } else {
                out.insert(self.resolve_row(handle).ok()?);
            }
        }
        (!out.is_empty()).then_some(out)
    }

    /// The error observation for a call that contradicts its own trace.
    pub(crate) fn trace_guard(&self, tool: &str, args: &Value, trace: &Trace) -> Option<String> {
        match (trace.intent, tool) {
            (Intent::Write, "answer") => {
                return Some(contradiction("intent is write, the call is an answer"));
            }
            (Intent::Write, "act") => {}
            (intent, "act") => {
                return Some(contradiction(&format!(
                    "intent is {}, the call is a write (act)",
                    intent.name()
                )));
            }
            _ => {}
        }
        let args = args.as_object()?;
        if tool == "act"
            && trace.scope == Some(Scope::One)
            && let Some(rows) = args.get("rows").filter(|value| !value.is_null())
            && let Ok(keys) = self.resolve_rows(rows)
            && keys.len() > 1
        {
            return Some(contradiction(&format!(
                "scope is one, the write names {} rows",
                keys.len()
            )));
        }
        if let Some(refer) = &trace.refer
            && let Some((param, have)) = self.called_rows(args)
            && let Some(want) = self.referent(refer)
        {
            let exact = refer.kind == ReferKind::Both;
            if !have.is_subset(&want) || (exact && have != want) {
                return Some(contradiction(&format!(
                    "refer points at {} ({}), {param} is {}",
                    refer.handles.join(", "),
                    self.numbers_of(&want),
                    self.numbers_of(&have)
                )));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_think_is_what_precedes_the_call_inside_think() {
        let text = "<think>\nintent: read \"what\"\n</think>\n\n<tool_call>\n<function=answer>\n</function>\n</tool_call>";
        assert_eq!(think_of(text), Some("intent: read \"what\""));
        // the generation prompt already opened the block: no opening tag
        let text = "intent: count\n</think>\n\n<tool_call>\n</tool_call>";
        assert_eq!(think_of(text), Some("intent: count"));
        assert_eq!(think_of("no call here"), None);
        // no think block at all
        assert_eq!(think_of("<tool_call>\n</tool_call>"), Some(""));
    }

    #[test]
    fn a_slot_trace_parses_and_the_old_line_does_not() {
        let trace = parse("intent: write \"cancel it\"\nverb: cancel\nscope: one\nrefer: it \"it\" -> @3\ntarget: \"night shift\"")
            .expect("a slot trace");
        assert_eq!(trace.intent, Intent::Write);
        assert_eq!(trace.scope, Some(Scope::One));
        assert_eq!(
            trace.refer,
            Some(Refer {
                kind: ReferKind::It,
                handles: vec!["@3".to_owned()]
            })
        );
        let trace =
            parse("retry: rejected\nintent: read\nrefer: both -> #7, #9").expect("bare forms");
        assert_eq!(trace.intent, Intent::Read);
        assert_eq!(trace.refer.expect("refer").handles, ["#7", "#9"]);
        // the old single-line trace is never a slot trace, whatever words it shares
        for old in [
            "saw: #34 Buy euros · plan: search",
            "intent: read · kind: group · cond: linked_to · plan: answer",
            "last: #35 Oluwaseun · intent: write star · kind: photo · plan: act",
            "intent: needs a choice · plan: ask",
            "intent: decline (never_mind) · plan: decline",
            "",
        ] {
            assert_eq!(parse(old), None, "{old}");
        }
        // a malformed slot is ignored, the intent still counts
        let trace =
            parse("intent: write\nscope: several\nrefer: it -> nowhere").expect("intent only");
        assert_eq!((trace.scope, trace.refer), (None, None));
    }
}
