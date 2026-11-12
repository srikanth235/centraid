//! THE GOLD A SESSION CARRIES: the retired `eval/gold.py`'s authoring vocabulary, as the frozen sets serialise it.
//!
//! Gold is an effect written in world keys (`"night_0319"`, `"+1"` for the first row the session created).
//! A turn lists every acceptable effect; it passes when its effect matches any of them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// One session of a set: one JSON object per line of `sets/val.jsonl`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Session {
    pub id: String,
    pub world: String,
    pub today: String,
    pub me: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// A logged runtime issue that makes the correct effect unreachable today (`runtime_issues.md`).
    #[serde(default)]
    pub blocked: Option<Value>,
    /// The split the session belongs to (`train`, `val`, `test`, `noise`), when its source says: a data version's
    /// split file, a set named for its split, or the record itself. `None` when nothing does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split: Option<String>,
    pub turns: Vec<Turn>,
}

/// The splits no training record may be cut from (the held-out data and its noisy copy).
pub const HELD_OUT: [&str; 3] = ["val", "test", "noise"];

impl Session {
    /// Whether the session is from a split that is held out (`val`, `test`, `noise`).
    #[must_use]
    pub fn is_held_out(&self) -> bool {
        self.split
            .as_deref()
            .is_some_and(|split| HELD_OUT.iter().any(|h| h.eq_ignore_ascii_case(split)))
    }

    #[must_use]
    pub fn is_blocked(&self) -> bool {
        match &self.blocked {
            None | Some(Value::Null | Value::Bool(false)) => false,
            Some(Value::String(text)) => !text.is_empty(),
            Some(_) => true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Turn {
    pub user: String,
    pub gold: Vec<Accept>,
    /// The reference calls: how an author would have the model say it. Counted for constraints, never replayed.
    #[serde(default, rename = "ref")]
    pub reference: Vec<RefCall>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RefCall {
    pub tool: String,
    #[serde(default)]
    pub args: Map<String, Value>,
    /// A call the runtime is expected to refuse (a repair trajectory): not a reading of the message.
    #[serde(default)]
    pub bad: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AcceptKind {
    Rows,
    Value,
    Diff,
    Ask,
    Decline,
}

impl AcceptKind {
    #[must_use]
    pub fn word(self) -> &'static str {
        match self {
            Self::Rows => "rows",
            Self::Value => "value",
            Self::Diff => "diff",
            Self::Ask => "ask",
            Self::Decline => "decline",
        }
    }
}

/// One acceptable effect of a turn.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Accept {
    #[serde(rename = "type")]
    pub kind: AcceptKind,
    /// `rows`: the exact set of world keys the turn ends on.
    #[serde(default)]
    pub rows: Vec<String>,
    /// `rows`: the order matters.
    #[serde(default)]
    pub order: bool,
    /// `value`: the amounts (a count has no unit).
    #[serde(default)]
    pub values: Vec<Money>,
    /// `value`: one amount list per group.
    #[serde(default)]
    pub groups: Option<BTreeMap<String, Vec<Money>>>,
    /// `ask`: rows the options must cover.
    #[serde(default)]
    pub candidates: Vec<String>,
    /// `decline`: any of these reasons.
    #[serde(default)]
    pub reasons: Vec<String>,
    /// The vault change the turn must make, beside whatever it ends on.
    #[serde(default)]
    pub diff: Diff,
    /// `diff`: rows the write must have found already so.
    #[serde(default)]
    pub already: Vec<String>,
    /// `diff`: secrets the turn must have revealed.
    #[serde(default)]
    pub reveal: Vec<Reveal>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Money {
    pub amount: f64,
    #[serde(default)]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Diff {
    #[serde(default)]
    pub rows: Vec<RowSpec>,
    #[serde(default)]
    pub links: Vec<LinkSpec>,
}

/// A row the turn changes: an existing one by `key`, or a new one of kind `new`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RowSpec {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub new: Option<String>,
    #[serde(default)]
    pub change: Option<String>,
    /// Field → value, or a matcher (`{"any": true}`, `{"oneof": […]}`, `{"has": […]}`, `{"prefix": …}`).
    #[serde(default)]
    pub fields: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LinkSpec {
    pub change: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Reveal {
    pub key: String,
    pub contains: String,
}
