//! A rehearsal model: a writer and a reader that need no network, so a whole build runs offline.
//!
//! The writer puts the words a turn must say and a number that names the turn's brief into a short message. The reader
//! looks that number up in the intents it was built from and says the slots the intent carries. It is a stand-in for the
//! pipeline's plumbing, not for a model: what it writes is never real training data, and a version built with it is
//! marked as a rehearsal in the data it writes (the model names start with `rehearsal-`).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::brief::Briefer;
use crate::catalog::Catalog;
use crate::intent::Scenario;
use crate::llm::{Llm, json_of};
use crate::settings::Split;
use crate::source::SESSIONS;
use crate::verify::{self, Expected};

/// The prefix every rehearsal model's name carries.
pub const PREFIX: &str = "rehearsal-";

/// The marker a rehearsal writer puts in a message: a number that identifies the turn's brief, so the reader can look the
/// intent up again. (A digit run: the typo pass leaves it alone.)
fn marker(ask: &str, how: &str) -> String {
    let h = blake3::hash(format!("{ask}\n{how}").as_bytes());
    let mut n = [0_u8; 4];
    n.copy_from_slice(&h.as_bytes()[..4]);
    format!("q{}", u32::from_le_bytes(n))
}

/// A writer and reader in one: it answers a writer's prompt with messages and a reader's prompt with slots.
pub struct Rehearsal {
    name: String,
    expected: BTreeMap<String, Expected>,
    /// Every prompt it was given, for the tests that look for what must not be in one.
    pub prompts: Mutex<Vec<String>>,
}

impl Rehearsal {
    /// A rehearsal model called `rehearsal-<role>` that knows the intents of `input` (the output of `datagen intents`).
    ///
    /// # Errors
    ///
    /// If a session file cannot be read.
    pub fn new(role: &str, catalog: &Catalog, input: &Path) -> Result<Self> {
        let mut expected = BTreeMap::new();
        for split in Split::ALL {
            let path = input.join(split.name()).join(SESSIONS);
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                let record: Value = serde_json::from_str(line)?;
                let scenario: Scenario =
                    serde_json::from_value(record["scenario"].clone()).context("a scenario")?;
                let today = record["today"]
                    .as_str()
                    .and_then(|t| t.get(..10))
                    .context("a session with no `today`")?
                    .parse()?;
                let briefer = Briefer { catalog, today };
                for (i, turn) in scenario.turns.iter().enumerate() {
                    let b = briefer.turn(turn, i);
                    expected.insert(marker(&b.ask, &b.how), verify::expected(turn, today));
                }
            }
        }
        Ok(Self {
            name: format!("{PREFIX}{role}"),
            expected,
            prompts: Mutex::new(Vec::new()),
        })
    }
}

impl Llm for Rehearsal {
    fn model(&self) -> &str {
        &self.name
    }

    fn complete(&self, prompt: &str) -> Result<String> {
        self.prompts.lock().expect("lock").push(prompt.to_owned());
        let start = prompt.find("Sessions:\n").context("no sessions")? + "Sessions:\n".len();
        let sessions = json_of(&format!("{{\"s\": {}}}", &prompt[start..]))?;
        let mut out = Vec::new();
        let writing = prompt.starts_with("You write what a person types");
        for s in sessions["s"].as_array().context("sessions")? {
            if writing {
                let messages: Vec<String> = s["turns"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|t| {
                        let spans: Vec<&str> = t["say_verbatim"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .collect();
                        let m = marker(
                            t["ask"].as_str().unwrap_or_default(),
                            t["how"].as_str().unwrap_or_default(),
                        );
                        if spans.is_empty() {
                            format!("show those {m}")
                        } else {
                            format!("show {} {m}", spans.join(" and "))
                        }
                    })
                    .collect();
                out.push(json!({"id": s["id"], "messages": messages}));
            } else {
                let turns: Vec<Value> = s["messages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|m| {
                        let text = m.as_str().unwrap_or_default();
                        let want = text
                            .rfind('q')
                            .and_then(|at| self.expected.get(&text[at..]));
                        match want {
                            Some(want) => json!({
                                "act": want.act,
                                "kind": want.kind.clone().unwrap_or_else(|| "unknown".into()),
                                "from": want.period.map(|p| p.0.to_string()).unwrap_or_default(),
                                "to": want.period.map(|p| p.1.to_string()).unwrap_or_default(),
                                "numbers": want.numbers,
                                "leans_on": want.leans.map(|l| l.0 + 1),
                                "decline_reason": want.decline,
                                "filters": want.filters.iter()
                                    .map(|(f, v)| json!({"field": f, "value": v}))
                                    .collect::<Vec<_>>(),
                                "names": want.names,
                                "excluding": Vec::<String>::new(),
                            }),
                            None => json!({"act": "unknown", "kind": "unknown"}),
                        }
                    })
                    .collect();
                out.push(json!({"id": s["id"], "turns": turns}));
            }
        }
        Ok(json!({"sessions": out}).to_string())
    }
}
