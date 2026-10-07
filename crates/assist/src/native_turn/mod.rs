//! THE NATIVE TURN LOOP (#1088): the phone runs the runtime the fine-tuning loop trains.
//!
//! [`Plane`](crate::turn::Plane) routes a question to one of eighteen reads and phrases one sentence.
//! This is the other plane: the model drives [`native::Session`](crate::native::Session), eight flat
//! tools over a vault, one call per message, up to [`STEP_CAP`] messages per question. The order is
//! the driver loop's (`experiments/toolchat/native/eval/run.py`, `train/hf_backend.py`), in Rust:
//!
//! ```text
//! user(text) ──► block + compacted observations ──► log
//! ┌─► prompt = log.prompt() ──► decode_step (think guard, rendered call, one call) ──► message
//! │        Activity("Looking in Tasks")                                                  │
//! │        call_text(message) ──► {text, ends_turn, effect, obs}  ──► log (message + observation)
//! └──────── until ends_turn, STEP_CAP, a cancel between steps, or the engine failing
//! effect ──► cards (the kind table) + a line composed from the copy (never a second generation)
//! ```
//!
//! # WHAT THE MEMBER READS IS THE RUNTIME'S (R-1088-10)
//!
//! The model writes calls and the question of an `ask`. The answer line is composed from the final
//! effect by [`conclude`]: a count, a value, a decline reason, the question. The sentences are the
//! chat's copy ([`words`]). The rows are [`cards`]: the chat's existing `Card`, mapped from the
//! thirteen kinds into the seven apps.
//!
//! # WRITES
//!
//! A write parks behind a confirm card (R-1088-2), and parking is the session's, not this loop's.
//! Until it lands a call to `act` is not run: the loop gives the session the typed decline
//! `out_of_scope` in its place and says [`Say::WritesOff`](words::Say). The door's own `run` refuses
//! too, so a path around this loop writes nothing either.
//!
//! # A CHAT'S SESSION
//!
//! A [`NativeChat`] is one chat's session and its conversation, in memory (R-1088-10): never
//! stored, never replayed. A reopened thread starts a fresh one. Its picture of the vault is read
//! when it opens, so the caller decides when a picture is too old to keep
//! ([`NativeChat::is_stale`]).

pub mod cards;
pub mod log;
pub mod words;

use serde_json::{Value, json};

use crate::attach::Notice;
use crate::model::{Cancel, Model, ModelError};
use crate::native::door::Door;
use crate::native::meta::{Kind, STEP_CAP, TOOLS};
use crate::native::parse::parse_call;
use crate::native::step::{StepOptions, decode_step};
use crate::native::think::TraceMode;
use crate::native::world::Key;
use crate::native::{Flags, Session};
use crate::result::{CARD_CAP, Card};
use crate::tool::App;
use crate::turn::{Answered, Event, ReadContext, Refusal};
use log::Log;
use words::{Say, say, say_with};

/// The longest user message the loop hands the runtime, in characters. A guard on the prompt's
/// size, not a product limit: the trained messages are a sentence.
pub const MESSAGE_MAX: usize = 800;

/// What happens to a call to `act`. Parking is the other value, and arrives with the session's
/// park mode (R-1088-2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Writes {
    /// The call is not run; the turn ends in `decline out_of_scope`, said as [`Say::WritesOff`].
    #[default]
    Refused,
}

/// One chat's native session and the conversation the model reads.
pub struct NativeChat {
    session: Session,
    log: Log,
    opened_on: jiff::civil::Date,
}

/// The civil date and time of an instant in an IANA zone; UTC when the zone is empty or unknown.
fn civil_at(now_ms: i64, tz: &str) -> jiff::civil::DateTime {
    let zone = jiff::tz::TimeZone::get(tz.trim()).unwrap_or(jiff::tz::TimeZone::UTC);
    jiff::Timestamp::from_millisecond(now_ms)
        .unwrap_or_default()
        .to_zoned(zone)
        .datetime()
}

impl NativeChat {
    /// A session over `door`, for a member whose zone is `tz`. The Locker is off (R-1088-3): the
    /// session reads no Locker row and declines a call that names one. "Today" is the day it is in
    /// `tz` by the door's clock.
    ///
    /// # Errors
    /// The door's words, when the vault would not load into a world.
    pub fn open(door: Box<dyn Door>, tz: &str) -> Result<Self, String> {
        let now = civil_at(door.now_ms(), tz);
        let flags = Flags {
            locker: false,
            ..Flags::default()
        };
        let mut session = Session::with_door(door, now, "", flags)?;
        let prompt = session.prompt();
        let system = prompt["rendered"]
            .as_str()
            .ok_or_else(|| "the runtime's system turn is not text".to_owned())?
            .to_owned();
        Ok(Self {
            session,
            log: Log::new(system),
            opened_on: now.date(),
        })
    }

    /// Whether the day has turned since this session opened. Its `today` is fixed at open, so a
    /// chat that crosses midnight must start over rather than answer "today" for yesterday.
    #[must_use]
    pub fn is_stale(&self, tz: &str) -> bool {
        civil_at(self.session.door.now_ms(), tz).date() != self.opened_on
    }

    /// The conversation as the model reads it, ready for the next message.
    ///
    /// # Errors
    /// The renderer's refusal.
    pub fn prompt(&self) -> Result<String, String> {
        self.log.prompt()
    }
}

/// What a native turn needs besides its chat.
pub struct NativePlane<'a> {
    pub model: &'a dyn Model,
    pub options: StepOptions,
    pub writes: Writes,
}

impl<'a> NativePlane<'a> {
    /// The plane over `model`, with the decode options the model was trained under.
    #[must_use]
    pub fn new(model: &'a dyn Model) -> Self {
        Self {
            model,
            options: StepOptions::default(),
            writes: Writes::Refused,
        }
    }

    /// Run one turn, calling `sink` with each [`Event`] as it happens: an `Activity` per looking
    /// step, the `Cards` when the turn ends with rows, then the `Answer` (or `Failed`).
    ///
    /// # Errors
    /// A [`Refusal`], which the sink has already been told as [`Event::Failed`].
    pub fn run_turn(
        &self,
        chat: &mut NativeChat,
        text: &str,
        _context: &ReadContext<'_>,
        cancel: &Cancel,
        sink: &mut dyn FnMut(Event),
    ) -> Result<Answered, Refusal> {
        let result = self.turn(chat, text, cancel, sink);
        match &result {
            Ok(answered) => sink(Event::Answer {
                text: answered.text.clone(),
                cards: answered.cards.clone(),
                notices: answered.notices.clone(),
            }),
            Err(refusal) => sink(Event::Failed(refusal.clone())),
        }
        result
    }

    fn turn(
        &self,
        chat: &mut NativeChat,
        text: &str,
        cancel: &Cancel,
        sink: &mut dyn FnMut(Event),
    ) -> Result<Answered, Refusal> {
        let message: String = text.trim().chars().take(MESSAGE_MAX).collect();
        let user = chat.session.user(&message);
        chat.log.compact(&user["compacted"]);
        chat.log.user(&message, user["block"].as_str());
        let dates = user["dates"].as_str();

        // A RETRACTION ENDS THE TURN IN THE RUNTIME, before any call (`decline never_mind`): no
        // message is asked of the model and the log holds only the user turn.
        let mut last = user.get("ended").cloned();
        let mut writes_off = false;
        let mut step = 0;
        while last.is_none() && step < STEP_CAP + 2 {
            step += 1;
            if cancel.is_cancelled() {
                return Err(Refusal::Cancelled);
            }
            let prompt = chat.log.prompt().map_err(Refusal::ModelFailed)?;
            let written = decode_step(
                self.model,
                &prompt,
                dates,
                TraceMode::V4,
                self.options,
                cancel,
            )
            .map_err(failed)?;
            if written.info.cancelled || cancel.is_cancelled() {
                return Err(Refusal::Cancelled);
            }
            let sent = first_call(&written.text);
            let call = parse_call(sent).ok();
            if let Some((app, tool)) = call.as_ref().and_then(|call| activity_of(chat, call)) {
                sink(Event::Activity { app, tool });
            }
            let writing = call.as_ref().is_some_and(|call| call["tool"] == "act");
            let reply = if writing {
                match self.writes {
                    Writes::Refused => {
                        // The typed decline stands in for the write, and the session knows it
                        // as its own turn's end: nothing was run, nothing is half-done.
                        writes_off = true;
                        chat.session
                            .call("decline", &json!({"reason": "out_of_scope"}))
                    }
                }
            } else {
                chat.session.call_text(sent)
            };
            chat.log.assistant(sent);
            chat.log.tool(
                usize_of(&reply["obs"]),
                reply["text"].as_str().unwrap_or_default(),
            );
            if reply["ends_turn"].as_bool().unwrap_or(false) {
                last = Some(reply);
            }
        }
        let Some(reply) = last else {
            return Ok(Answered {
                text: say(Say::Cap),
                cards: Vec::new(),
                notices: Vec::new(),
            });
        };
        let concluded = conclude(&chat.session, &reply, writes_off)?;
        if !concluded.cards.is_empty() {
            sink(Event::Cards(concluded.cards.clone()));
        }
        Ok(concluded)
    }
}

fn failed(error: ModelError) -> Refusal {
    Refusal::ModelFailed(error.to_string())
}

fn usize_of(value: &Value) -> Option<usize> {
    value.as_u64().and_then(|n| usize::try_from(n).ok())
}

/// The model's message up to its first call: one call per message (`eval/lib.py first_call`).
fn first_call(text: &str) -> &str {
    let close = crate::native::identity::MODEL.tool_call_close;
    text.find(close)
        .map_or(text, |at| &text[..at + close.len()])
}

/// The activity a call announces: the app it looks in and the tool it uses. Only a call that
/// reads or writes rows of a known app announces anything; `ask`, `decline` and an `answer` of a
/// value do not.
fn activity_of(chat: &NativeChat, call: &Value) -> Option<(App, &'static str)> {
    let name = call["tool"].as_str()?;
    let tool = TOOLS.iter().copied().find(|known| *known == name)?;
    if matches!(tool, "ask" | "decline") {
        return None;
    }
    let args = call["args"].as_object()?;
    let by_kind = args
        .get("kind")
        .and_then(Value::as_str)
        .and_then(|kinds| kinds.split(',').find_map(Kind::parse))
        .and_then(cards::app_of);
    let by_handle = || {
        ["rows", "row", "within", "linked_to"]
            .iter()
            .filter_map(|key| args.get(*key))
            .flat_map(handles_of)
            .find_map(|handle| kind_of_handle(&chat.session, &handle))
            .and_then(cards::app_of)
    };
    by_kind.or_else(by_handle).map(|app| (app, tool))
}

/// The `#n` and `@n` a call argument names.
fn handles_of(value: &Value) -> Vec<String> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(","),
        _ => String::new(),
    };
    text.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|part| part.starts_with('#') || part.starts_with('@'))
        .map(str::to_owned)
        .collect()
}

/// The kind of the first row a handle names in this session.
fn kind_of_handle(session: &Session, handle: &str) -> Option<Kind> {
    let number: usize = handle.get(1..)?.parse().ok()?;
    if handle.starts_with('#') {
        return session
            .by_number
            .get(number.checked_sub(1)?)
            .map(|key| key.0);
    }
    session
        .results
        .get(number.checked_sub(1)?)
        .and_then(|set| set.kinds.first().copied())
}

// ---------------------------------------------------------------------------
// The end of a turn: cards and a composed line.
// ---------------------------------------------------------------------------

/// The cards of `[{kind, id, n}]` rows the effect names, in order. A row the world no longer holds,
/// or a kind that is never drawn, is left out.
fn cards_of(session: &Session, rows: &Value) -> (Vec<Card>, usize) {
    let today = session.today();
    let keys: Vec<Key> = rows
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some((
                Kind::parse(row["kind"].as_str()?)?,
                row["id"].as_str()?.to_owned(),
            ))
        })
        .collect();
    let cards: Vec<Card> = keys
        .iter()
        .filter_map(|key| session.world.row(key))
        .filter_map(|row| cards::card_of(row, today))
        .collect();
    let total = cards.len();
    (cards.into_iter().take(CARD_CAP).collect(), total)
}

/// How many of each kind: `2 tasks, 1 event`.
fn count_of(session: &Session, rows: &Value) -> String {
    let mut counts: Vec<(Kind, usize)> = Vec::new();
    for row in rows.as_array().into_iter().flatten() {
        let Some(kind) = row["kind"].as_str().and_then(Kind::parse) else {
            continue;
        };
        if session
            .world
            .row(&(kind, row["id"].as_str().unwrap_or_default().to_owned()))
            .is_none()
        {
            continue;
        }
        match counts.iter_mut().find(|(known, _)| *known == kind) {
            Some((_, n)) => *n += 1,
            None => counts.push((kind, 1)),
        }
    }
    counts
        .iter()
        .map(|(kind, n)| kind.count(*n))
        .collect::<Vec<_>>()
        .join(", ")
}

fn found(session: &Session, rows: &Value) -> Answered {
    let (cards, total) = cards_of(session, rows);
    if total == 0 {
        return Answered {
            text: say(Say::Nothing),
            cards,
            notices: Vec::new(),
        };
    }
    let what = count_of(session, rows);
    let text = if total > cards.len() {
        say_with(
            Say::FoundSome,
            &[("what", &what), ("shown", &cards.len().to_string())],
        )
    } else {
        say_with(Say::Found, &[("what", &what)])
    };
    Answered {
        text,
        cards,
        notices: Vec::<Notice>::new(),
    }
}

/// `42.00 USD`, or `12` for a bare number.
fn amount_text(value: &Value) -> String {
    let amount = value["amount"].as_f64().unwrap_or_default();
    match value["unit"].as_str() {
        Some(unit) => {
            crate::native::world::money(crate::native::world::minor_of(amount, unit), unit)
        }
        None if amount.fract() == 0.0 => format!("{amount:.0}"),
        None => amount.to_string(),
    }
}

fn amounts_text(values: &Value) -> String {
    let parts: Vec<String> = values
        .as_array()
        .into_iter()
        .flatten()
        .map(amount_text)
        .collect();
    if parts.is_empty() {
        "0".to_owned()
    } else {
        parts.join(" + ")
    }
}

/// The line a value is said as.
fn value_line(session: &Session, value: &Value, result: Option<usize>) -> String {
    let op = value["op"].as_str().unwrap_or_default();
    let field = value["field"].as_str().unwrap_or_default();
    let body = if value["groups"].is_array() {
        value["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|group| {
                format!(
                    "{}: {}",
                    group["key"].as_str().unwrap_or_default(),
                    amounts_text(&group["values"])
                )
            })
            .collect::<Vec<_>>()
            .join("; ")
    } else {
        amounts_text(&value["values"])
    };
    match op {
        "count" => {
            let n = value["values"][0]["amount"].as_f64().unwrap_or_default() as usize;
            let kinds = result
                .and_then(|handle| session.results.get(handle.checked_sub(1)?))
                .map(|set| set.kinds.clone())
                .unwrap_or_default();
            let what = match kinds.as_slice() {
                [kind] => kind.count(n),
                _ => format!("{n} rows"),
            };
            say_with(Say::Count, &[("what", &what)])
        }
        "sum" => say_with(Say::Total, &[("field", field), ("value", &body)]),
        "min" => say_with(Say::Lowest, &[("field", field), ("value", &body)]),
        "max" => say_with(Say::Highest, &[("field", field), ("value", &body)]),
        "balance" => balance_line(session, value, &body),
        _ => body,
    }
}

fn balance_line(session: &Session, value: &Value, body: &str) -> String {
    let signs: Vec<f64> = value["values"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v["amount"].as_f64())
        .collect();
    let person = (value["of"]["kind"] == "person")
        .then(|| {
            session
                .world
                .row(&(Kind::Person, value["of"]["id"].as_str()?.to_owned()))
                .map(|row| row.name.clone())
        })
        .flatten();
    let Some(name) = person else {
        return say_with(Say::Balance, &[("value", body)]);
    };
    if signs.iter().all(|amount| *amount == 0.0) {
        say_with(Say::BalanceEven, &[("name", &name)])
    } else if signs.iter().all(|amount| *amount >= 0.0) {
        say_with(Say::BalanceOwed, &[("name", &name), ("value", body)])
    } else if signs.iter().all(|amount| *amount <= 0.0) {
        let owed: Vec<Value> = value["values"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| {
                let mut v = v.clone();
                v["amount"] = json!(v["amount"].as_f64().unwrap_or_default().abs());
                v
            })
            .collect();
        say_with(
            Say::BalanceOwing,
            &[
                ("name", &name),
                ("value", &amounts_text(&Value::Array(owed))),
            ],
        )
    } else {
        say_with(Say::Balance, &[("value", body)])
    }
}

/// The turn's end, as the member reads it: the cards of its rows and a line composed from its
/// effect.
fn conclude(session: &Session, reply: &Value, writes_off: bool) -> Result<Answered, Refusal> {
    let effect = &reply["effect"];
    let said = |text: String| Answered {
        text,
        cards: Vec::new(),
        notices: Vec::new(),
    };
    if writes_off {
        return Ok(said(say(Say::WritesOff)));
    }
    if let Some(reason) = effect["decline"]["reason"].as_str() {
        return Ok(said(say(Say::of_decline(reason))));
    }
    if let Some(question) = effect["ask"]["question"].as_str() {
        let (cards, _) = cards_of(session, &effect["ask"]["options"]);
        return Ok(Answered {
            text: question.trim().to_owned(),
            cards,
            notices: Vec::new(),
        });
    }
    if effect["value"].is_object() {
        let result = effect["result"]
            .as_str()
            .and_then(|handle| handle.strip_prefix('@'))
            .and_then(|n| n.parse().ok());
        return Ok(said(value_line(session, &effect["value"], result)));
    }
    if effect["answer"]["rows"].is_array() {
        return Ok(found(session, &effect["answer"]["rows"]));
    }
    if effect["cap"].as_bool().unwrap_or(false) {
        return Ok(said(say(Say::Cap)));
    }
    // A write that landed, an `already`, a `created`: nothing in this plane produces one while
    // writes are refused, so reaching here is a runtime that ended a turn in a way this loop does
    // not know how to say, and a typed failure is better than a guess.
    Err(Refusal::QueryFailed(format!(
        "a turn ended without an answer: {}",
        reply["text"].as_str().unwrap_or_default()
    )))
}
