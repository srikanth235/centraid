//! THE TURN LOOP: a question, at most one read, one sentence, some cards.
//!
//! ```text
//! question ──► route (model, grammar) ──┬─► none         ──► refusal: no tool fits
//!                                       ├─► answer       ──► the model's own line
//!                                       └─► tool call ──► read (the real query path)
//!                                                          │
//!                              cards ◄── rows ◄────────────┤
//!                              one sentence ◄── phrase (model, digest of the rows)
//! ```
//!
//! **One read per turn in v1.** A second read would need the model to plan, and
//! a 0.8B model is not asked to. A follow-up question is a new turn that sees
//! the last two.
//!
//! **Every way out is typed.** A turn ends as [`Answered`] or as a [`Refusal`],
//! and the sink has seen the matching [`Event`] by then, so a shell that only
//! watches events and one that only reads the return value draw the same thing.
//!
//! **The cards come before the sentence.** They are the answer; the sentence is
//! the model's gloss on them. Showing them as soon as the read returns makes
//! the screen useful while the second generation is still running.

use crate::attach::{ATTACH_MAX_TOKENS, Attachments, Notice, attach_prompt};
use crate::call::{Route, ToolCall, parse_route};
use crate::grammar::{PHRASE_GBNF, PHRASE_MAX, route_gbnf};
use crate::model::{Cancel, Control, Finish, GenerateRequest, ImageInput, Model, ModelError};
use crate::prompt::{
    Budget, END_OF_TURN, Recorded, Turn, chat_prompt, phrase_prompt, question, route_prompt,
};
use crate::result::{Card, ToolOutput};
use crate::tool::App;

/// Tokens the routing step may use: a call with a long text argument.
pub const ROUTE_MAX_TOKENS: u32 = 96;

/// Tokens the phrasing step may use: one short sentence.
pub const PHRASE_MAX_TOKENS: u32 = 64;

/// The longest free-chat reply, in tokens.
pub const CHAT_MAX_TOKENS: u32 = 256;

/// The device's state a read may need.
#[derive(Debug, Clone, Copy)]
pub struct ReadContext<'a> {
    /// The device's IANA zone. Civil words ("today") are read in it.
    pub tz: &'a str,
}

/// A read that could not answer. Its text is for logs and a Retry, not for the
/// member: the shell says its own sentence.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ReadError(pub String);

/// Runs a registered read against the vault, through the core's query path.
///
/// The one implementation that matters lives in `crates/core`; this crate holds
/// no connection and no SQL.
pub trait Reader {
    /// # Errors
    /// [`ReadError`] when the vault could not answer.
    fn read(&self, call: &ToolCall, context: &ReadContext<'_>) -> Result<ToolOutput, ReadError>;
}

/// Why a turn did not answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    /// The model said no tool fits.
    #[error("no tool fits")]
    NoToolFits,
    /// The read failed.
    #[error("the read failed: {0}")]
    QueryFailed(String),
    /// The model's output was not a route, despite the grammar.
    #[error("the model's output was not a route: {0}")]
    Unparsable(String),
    /// The member stopped it.
    #[error("cancelled")]
    Cancelled,
    /// There is no model to ask.
    #[error("there is no model loaded")]
    ModelAbsent,
    /// The engine failed.
    #[error("the model failed: {0}")]
    ModelFailed(String),
    /// A turn is already running on this session.
    #[error("a turn is already running")]
    Busy,
    /// A photo was attached and no vision projector is loaded.
    #[error("there is no vision projector loaded")]
    VisionAbsent,
    /// The attachment is a kind the chat does not read (a PDF, a Word file).
    #[error("that attachment is not a kind the chat reads")]
    AttachmentUnsupported,
    /// The attachment would not open: bytes that are not an image, a photo
    /// whose file is not on this phone, a document that is not text.
    #[error("the attachment would not open")]
    AttachmentUnreadable,
    /// The attachment is bigger than the chat will take.
    #[error("the attachment is too large")]
    AttachmentTooLarge,
}

/// What the model is reading before it answers: shown while a long prefill
/// runs, so the pause has a name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reading {
    Photo,
    Document,
}

/// What a running turn tells its watcher, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The read is starting: "Looking in Tally".
    Activity { app: App, tool: &'static str },
    /// The rows the read found, to draw while the sentence is written.
    Cards(Vec<Card>),
    /// The model is reading an attachment: "Reading the photo".
    Reading(Reading),
    /// A piece of the sentence.
    Token(String),
    /// The turn is done and this is its answer.
    Answer {
        text: String,
        cards: Vec<Card>,
        notices: Vec<Notice>,
    },
    /// The turn ended in a write that waits for the member's tap (native plane, R-1088-2). The
    /// `Answer` that follows says it in words; this is the card, which the core puts on the wire as
    /// `AssistPending`.
    Pending(crate::native_turn::PendingCard),
    /// The turn is over and did not answer.
    Failed(Refusal),
}

/// A finished, answering turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answered {
    pub text: String,
    pub cards: Vec<Card>,
    /// What the member is told beside the answer (a document was cut).
    pub notices: Vec<Notice>,
}

/// One conversation as the MODEL sees it: in memory, the last turns only.
///
/// Nothing here is written to the vault or to disk. What the member said and was
/// told is saved by `crates/core` (`chat.save_turn`, R-CHAT-1), and a stored
/// thread is read back into a session with [`Session::restore`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Session {
    scope: Option<App>,
    history: Vec<Turn>,
    last_user: Option<String>,
    /// The last turn's user line **as the history holds it**: the question, or
    /// the attachment marker and the question.
    last_recorded_user: Option<String>,
    /// The last turn's attachments, in memory until the next turn, a new chat
    /// or the end of the app, so that Retry asks the same question of the same
    /// attachment. See [`crate::attach`].
    last_attachments: Option<Attachments>,
}

impl Session {
    /// A chat, scoped to an app when opened from one.
    #[must_use]
    pub fn new(scope: Option<App>) -> Self {
        Self {
            scope,
            ..Self::default()
        }
    }

    #[must_use]
    pub const fn scope(&self) -> Option<App> {
        self.scope
    }

    /// The turns that answered, oldest first.
    #[must_use]
    pub fn history(&self) -> &[Turn] {
        &self.history
    }

    /// A chat reopened from its stored turns: the history a follow-up is routed
    /// with, and the last question a Retry asks again.
    ///
    /// Nothing is asked of the model here. The prompt still shows only the last
    /// [`prompt::HISTORY_TURNS`] turns, so a long thread costs the same as a
    /// short one; the stored history is as long as the caller read.
    #[must_use]
    pub fn restore(scope: Option<App>, history: Vec<Turn>, last_question: Option<String>) -> Self {
        Self {
            scope,
            last_recorded_user: history.last().map(|turn| turn.user.clone()),
            history,
            last_user: last_question,
            last_attachments: None,
        }
    }

    /// Start a new chat: the scope stays, the transcript goes.
    pub fn clear(&mut self) {
        self.history.clear();
        self.last_user = None;
        self.last_recorded_user = None;
        self.last_attachments = None;
    }

    /// Remember a question whose turn never reached the plane (its attachment
    /// would not open), so that Retry asks it again. The attachments are the
    /// retry's to carry: see [`Self::last_attachments`].
    pub fn note_question(&mut self, text: &str) {
        let user = question(text);
        self.last_user = Some(user.clone());
        self.last_recorded_user = Some(user);
        self.last_attachments = None;
    }

    /// The last turn's attachments, for a Retry.
    #[must_use]
    pub const fn last_attachments(&self) -> Option<&Attachments> {
        self.last_attachments.as_ref()
    }

    /// Take the last question back for a retry: drop its turn if it was
    /// recorded, and return the text to ask again. `None` before any question.
    pub fn prepare_regenerate(&mut self) -> Option<String> {
        let last = self.last_user.clone()?;
        let recorded = self.last_recorded_user.as_deref().unwrap_or(&last);
        if self
            .history
            .last()
            .is_some_and(|turn| turn.user == recorded)
        {
            self.history.pop();
        }
        Some(last)
    }
}

/// What a turn needs besides its session.
pub struct Plane<'a> {
    pub model: &'a dyn Model,
    pub reader: &'a dyn Reader,
    pub budget: Budget,
}

impl Plane<'_> {
    /// Run one turn, calling `sink` with each [`Event`] as it happens.
    ///
    /// # Errors
    /// A [`Refusal`], which the sink has already been told as [`Event::Failed`].
    pub fn run_turn(
        &self,
        session: &mut Session,
        text: &str,
        context: &ReadContext<'_>,
        cancel: &Cancel,
        sink: &mut dyn FnMut(Event),
    ) -> Result<Answered, Refusal> {
        self.run_attached_turn(session, text, None, context, cancel, sink)
    }

    /// [`Self::run_turn`] with attachments. A turn that carries one skips
    /// routing and answers over it ([`crate::attach`]).
    ///
    /// # Errors
    /// A [`Refusal`], which the sink has already been told as [`Event::Failed`].
    pub fn run_attached_turn(
        &self,
        session: &mut Session,
        text: &str,
        attachments: Option<&Attachments>,
        context: &ReadContext<'_>,
        cancel: &Cancel,
        sink: &mut dyn FnMut(Event),
    ) -> Result<Answered, Refusal> {
        let attachments = attachments.filter(|attached| !attached.is_empty());
        let result = self.turn(session, text, attachments, context, cancel, sink);
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
        session: &mut Session,
        text: &str,
        attachments: Option<&Attachments>,
        context: &ReadContext<'_>,
        cancel: &Cancel,
        sink: &mut dyn FnMut(Event),
    ) -> Result<Answered, Refusal> {
        let user = question(text);
        if user.is_empty() {
            return Err(Refusal::NoToolFits);
        }
        session.last_user = Some(user.clone());
        session.last_recorded_user = Some(user.clone());
        session.last_attachments = attachments.cloned();
        if let Some(attachments) = attachments {
            return self.attached(session, &user, attachments, cancel, sink);
        }

        let route = route_prompt(session.scope, &session.history, &user, self.budget);
        let grammar = route_gbnf(&route.tools);
        let generated = self.generate(
            &GenerateRequest {
                prompt: &route.text,
                grammar: Some(&grammar),
                max_tokens: ROUTE_MAX_TOKENS,
                stop: &[END_OF_TURN],
                temperature: 0.0,
                cancel,
                images: &[],
            },
            &mut |_| Control::Continue,
        )?;
        if generated.finish == Finish::Cancelled {
            return Err(Refusal::Cancelled);
        }
        let routed = parse_route(&generated.text, &route.tools)
            .map_err(|error| Refusal::Unparsable(error.to_string()))?;

        let call = match routed {
            Route::NoTool => return self.chat(session, user, cancel, sink),
            Route::Answer(line) => {
                session.history.push(Turn {
                    user,
                    record: Recorded::Answer(line.clone()),
                });
                return Ok(Answered {
                    text: line,
                    cards: Vec::new(),
                    notices: Vec::new(),
                });
            }
            Route::Tool(call) => call,
        };

        sink(Event::Activity {
            app: call.spec().app,
            tool: call.name(),
        });
        let output = self
            .reader
            .read(&call, context)
            .map_err(|error| Refusal::QueryFailed(error.0))?;
        if cancel.is_cancelled() {
            return Err(Refusal::Cancelled);
        }
        let cards = output.cards().to_vec();
        if !cards.is_empty() {
            sink(Event::Cards(cards.clone()));
        }

        let phrase = phrase_prompt(&route, &call, &output, self.budget);
        let phrased = self.generate(
            &GenerateRequest {
                prompt: &phrase.text,
                grammar: Some(PHRASE_GBNF),
                max_tokens: PHRASE_MAX_TOKENS,
                stop: &[END_OF_TURN, "\n"],
                temperature: 0.0,
                cancel,
                images: &[],
            },
            &mut |piece| {
                sink(Event::Token(piece.to_owned()));
                Control::Continue
            },
        )?;
        if phrased.finish == Finish::Cancelled {
            return Err(Refusal::Cancelled);
        }
        let line = sentence(&phrased.text, &output).unwrap_or_else(|| output.headline.clone());
        session.history.push(Turn {
            user,
            record: Recorded::Tool {
                call_json: call.to_json(),
                headline: output.headline.clone(),
                answer: line.clone(),
            },
        });
        Ok(Answered {
            text: line,
            cards,
            notices: Vec::new(),
        })
    }

    /// A TURN OVER AN ATTACHMENT: no route, one streamed answer.
    ///
    /// The prompt is [`attach_prompt`]'s; the pixels of an image travel beside
    /// it in the request and are dropped with it. What the history keeps is the
    /// marker line and the model's words ([`Recorded::Attachment`]).
    fn attached(
        &self,
        session: &mut Session,
        user: &str,
        attachments: &Attachments,
        cancel: &Cancel,
        sink: &mut dyn FnMut(Event),
    ) -> Result<Answered, Refusal> {
        if attachments.image.is_some() && !self.model.has_vision() {
            return Err(Refusal::VisionAbsent);
        }
        if attachments.image.is_some() {
            sink(Event::Reading(Reading::Photo));
        }
        if attachments.doc.is_some() {
            sink(Event::Reading(Reading::Document));
        }
        let prompt = attach_prompt(&session.history, attachments, user, self.budget);
        let images: Vec<ImageInput<'_>> = attachments
            .image
            .iter()
            .map(|image| ImageInput {
                width: image.width,
                height: image.height,
                rgb: &image.rgb,
            })
            .collect();
        let generated = self.generate(
            &GenerateRequest {
                prompt: &prompt.text,
                grammar: None,
                max_tokens: ATTACH_MAX_TOKENS,
                stop: &[END_OF_TURN],
                temperature: 0.0,
                cancel,
                images: &images,
            },
            &mut |piece| {
                sink(Event::Token(piece.to_owned()));
                Control::Continue
            },
        )?;
        if generated.finish == Finish::Cancelled {
            return Err(Refusal::Cancelled);
        }
        let text = generated.text.trim().to_owned();
        if text.is_empty() {
            return Err(Refusal::ModelFailed("the model said nothing".to_owned()));
        }
        session.last_recorded_user = Some(prompt.user_line.clone());
        session.history.push(Turn {
            user: prompt.user_line,
            record: Recorded::Attachment(text.clone()),
        });
        Ok(Answered {
            text,
            cards: Vec::new(),
            notices: prompt.notices,
        })
    }

    /// FREE CHAT: no tool fits, so the model talks — unconstrained, streamed,
    /// short — instead of the turn ending in a refusal.
    fn chat(
        &self,
        session: &mut Session,
        user: String,
        cancel: &Cancel,
        sink: &mut dyn FnMut(Event),
    ) -> Result<Answered, Refusal> {
        let prompt = chat_prompt(&session.history, &user);
        let generated = self.generate(
            &GenerateRequest {
                prompt: &prompt,
                grammar: None,
                max_tokens: CHAT_MAX_TOKENS,
                stop: &[END_OF_TURN],
                temperature: 0.0,
                cancel,
                images: &[],
            },
            &mut |piece| {
                sink(Event::Token(piece.to_owned()));
                Control::Continue
            },
        )?;
        if generated.finish == Finish::Cancelled {
            return Err(Refusal::Cancelled);
        }
        let text = generated.text.trim().to_owned();
        if text.is_empty() {
            session.history.push(Turn {
                user,
                record: Recorded::NoTool,
            });
            return Err(Refusal::NoToolFits);
        }
        session.history.push(Turn {
            user,
            record: Recorded::Answer(text.clone()),
        });
        Ok(Answered {
            text,
            cards: Vec::new(),
            notices: Vec::new(),
        })
    }

    fn generate(
        &self,
        request: &GenerateRequest<'_>,
        on_token: &mut dyn FnMut(&str) -> Control,
    ) -> Result<crate::model::Generation, Refusal> {
        self.model
            .generate(request, on_token)
            .map_err(|error| match error {
                ModelError::Load(detail) | ModelError::Generate(detail) => {
                    Refusal::ModelFailed(detail)
                }
                ModelError::NoVision => Refusal::VisionAbsent,
                other @ ModelError::ContextExceeded { .. } => {
                    Refusal::ModelFailed(other.to_string())
                }
            })
    }
}

/// Words that mean the model is talking about its own task, not to the
/// member: they are what a stock 0.8B says when it has no sentence ("I do not
/// have access to ... in the provided result", "The member has ..."). And the
/// words `DESIGN.md`'s Copy section bans everywhere, which a sentence shown in
/// the app is held to like any other string (the headline it falls back to is
/// authored copy and already is).
const MODEL_TALK: [&str; 21] = [
    "as an ai",
    "language model",
    "i cannot",
    "i can't",
    "i do not have",
    "i don't have",
    "i am sorry",
    "i'm sorry",
    "the result",
    "the member",
    "the user",
    "the data",
    "the assistant",
    "provided",
    "tool",
    "please",
    "successfully",
    "simply",
    "in order to",
    "you can",
    "we're sorry",
];

/// The model's phrasing as one usable line, or `None` when it is not usable —
/// and the read's own headline is said instead.
///
/// Not usable is: empty; a JSON object the grammar should have kept out;
/// talk about the model's own task ([`MODEL_TALK`]); or **a number the read
/// does not hold**. A small model asked to say 1240.50 sometimes says 2217.90,
/// and a wrong figure in the member's own money is worse than a plain headline,
/// so every number in the line must appear in the read (digits only: `1,240.50`
/// and `1240.50` are one number; "three" is not checked).
fn sentence(text: &str, output: &ToolOutput) -> Option<String> {
    let line: String = crate::call::normalize(text)
        .chars()
        .take(PHRASE_MAX)
        .collect();
    if line.is_empty() || line.starts_with('{') {
        return None;
    }
    let lower = line.to_lowercase();
    if MODEL_TALK.iter().any(|talk| lower.contains(talk)) {
        return None;
    }
    let held = digits_of(&output.digest(output.rows.len(), usize::MAX));
    numbers_in(&line)
        .iter()
        .all(|number| held.contains(number.as_str()))
        .then_some(line)
}

/// [`numbers_in`], for the prompt's own tests.
#[cfg(test)]
pub(crate) fn numbers_in_for_tests(line: &str) -> Vec<String> {
    numbers_in(line)
}

/// `text` with the thousands separators taken out, so `1,240.50` is `1240.50`.
fn digits_of(text: &str) -> String {
    text.replace(',', "")
}

/// The numbers a line says, as digits: runs of digits, with a `.` or `,` kept
/// only between two digits (`1,240.50` is one number; the full stop that ends a
/// sentence is not part of one).
fn numbers_in(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut numbers = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        if !chars[at].is_ascii_digit() {
            at += 1;
            continue;
        }
        let start = at;
        while at < chars.len()
            && (chars[at].is_ascii_digit()
                || (matches!(chars[at], '.' | ',')
                    && chars.get(at + 1).is_some_and(char::is_ascii_digit)))
        {
            at += 1;
        }
        numbers.push(chars[start..at].iter().filter(|c| **c != ',').collect());
    }
    numbers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{ScriptedModel, StaticReader};

    const CTX: ReadContext<'static> = ReadContext {
        tz: "America/Los_Angeles",
    };

    fn tasks_output() -> ToolOutput {
        ToolOutput::of_rows(
            "2 tasks due today",
            vec![
                Card::new(App::Tasks, "task", "t1", "Pick up the dry cleaning")
                    .subtitle("2026-10-01"),
                Card::new(App::Tasks, "task", "t2", "Rotate the tires").meta("overdue"),
            ],
        )
    }

    fn run(
        model: &ScriptedModel,
        reader: &StaticReader,
        session: &mut Session,
        text: &str,
    ) -> (Result<Answered, Refusal>, Vec<Event>) {
        let plane = Plane {
            model,
            reader,
            budget: Budget::DEFAULT,
        };
        let mut events = Vec::new();
        let result = plane.run_turn(session, text, &CTX, &Cancel::new(), &mut |event| {
            events.push(event)
        });
        (result, events)
    }

    #[test]
    fn a_read_turn_streams_activity_cards_tokens_then_the_answer() {
        let model = ScriptedModel::new([
            r#"{"tool":"tasks.list","args":{"view":"today"}}"#,
            "Two things are due today.",
        ]);
        let reader = StaticReader::new().with("tasks.list", tasks_output());
        let mut session = Session::new(None);
        let (result, events) = run(&model, &reader, &mut session, "What is due today?");

        let answered = result.expect("the turn answers");
        assert_eq!(answered.text, "Two things are due today.");
        assert_eq!(answered.cards.len(), 2);

        assert_eq!(
            events.first(),
            Some(&Event::Activity {
                app: App::Tasks,
                tool: "tasks.list"
            })
        );
        assert!(matches!(&events[1], Event::Cards(cards) if cards.len() == 2));
        let tokens: String = events
            .iter()
            .filter_map(|event| match event {
                Event::Token(piece) => Some(piece.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(tokens, "Two things are due today.");
        assert!(
            matches!(events.last(), Some(Event::Answer { text, .. }) if text == "Two things are due today.")
        );
    }

    #[test]
    fn exactly_one_read_runs_per_turn() {
        let model = ScriptedModel::new([r#"{"tool":"tasks.projects","args":{}}"#, "Done."]);
        let reader = StaticReader::new().with("tasks.projects", tasks_output());
        let _ = run(&model, &reader, &mut Session::new(None), "projects?");
        assert_eq!(reader.reads(), ["tasks.projects"]);
        assert_eq!(model.prompts().len(), 2, "one route, one phrase");
    }

    #[test]
    fn the_route_step_is_constrained_and_the_phrase_step_is_one_line() {
        let model = ScriptedModel::new([r#"{"tool":"people.reconnect","args":{}}"#, "Ana is due."]);
        let reader = StaticReader::new().with("people.reconnect", tasks_output());
        let _ = run(
            &model,
            &reader,
            &mut Session::new(None),
            "who should I call?",
        );
        let seen = model.requests();
        assert!(
            seen[0]
                .grammar
                .as_deref()
                .unwrap()
                .starts_with("root ::= call | none | answer")
        );
        assert_eq!(seen[0].max_tokens, ROUTE_MAX_TOKENS);
        assert_eq!(seen[1].grammar.as_deref(), Some(PHRASE_GBNF));
        assert_eq!(seen[1].max_tokens, PHRASE_MAX_TOKENS);
        assert!(seen[1].prompt.contains("Result:\n2 tasks due today"));
        assert!(seen.iter().all(|request| request.temperature == 0.0));
    }

    #[test]
    fn none_falls_through_to_a_free_chat_reply_streamed_without_a_grammar() {
        let model = ScriptedModel::new([r#"{"tool":"none"}"#, "Hello! Ask me about your tasks."]);
        let mut session = Session::new(None);
        let (result, events) = run(&model, &StaticReader::new(), &mut session, "hi");
        let answered = result.unwrap();
        assert_eq!(answered.text, "Hello! Ask me about your tasks.");
        assert!(answered.cards.is_empty());
        assert!(events.iter().any(|event| matches!(event, Event::Token(_))));
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, Event::Activity { .. }))
        );
        let requests = model.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1].grammar, None);
        assert!(requests[1].prompt.ends_with(crate::prompt::ASSISTANT_TURN));
        assert_eq!(
            session.history()[0].record,
            Recorded::Answer("Hello! Ask me about your tasks.".to_owned())
        );
    }

    #[test]
    fn an_empty_free_chat_reply_is_a_typed_refusal_and_is_remembered() {
        let model = ScriptedModel::new([r#"{"tool":"none"}"#, "  "]);
        let mut session = Session::new(None);
        let (result, events) = run(
            &model,
            &StaticReader::new(),
            &mut session,
            "what is the weather?",
        );
        assert_eq!(result, Err(Refusal::NoToolFits));
        assert_eq!(events.last(), Some(&Event::Failed(Refusal::NoToolFits)));
        assert_eq!(session.history()[0].record, Recorded::NoTool);
    }

    #[test]
    fn a_direct_answer_makes_no_read_and_shows_no_cards() {
        let model =
            ScriptedModel::new([r#"{"answer":"I can look in your tasks, notes and calendar."}"#]);
        let reader = StaticReader::new();
        let (result, _) = run(&model, &reader, &mut Session::new(None), "what can you do?");
        let answered = result.unwrap();
        assert_eq!(
            answered.text,
            "I can look in your tasks, notes and calendar."
        );
        assert!(answered.cards.is_empty());
        assert!(reader.reads().is_empty());
    }

    #[test]
    fn output_that_is_not_a_route_is_a_typed_refusal() {
        let model = ScriptedModel::new(["Sure, one moment"]);
        let (result, _) = run(&model, &StaticReader::new(), &mut Session::new(None), "hi");
        assert!(matches!(result, Err(Refusal::Unparsable(_))));
    }

    #[test]
    fn locker_said_by_an_engine_is_refused_as_not_a_route() {
        let model = ScriptedModel::new([r#"{"tool":"locker.items","args":{}}"#]);
        let (result, _) = run(
            &model,
            &StaticReader::new(),
            &mut Session::new(None),
            "my passwords",
        );
        assert!(matches!(result, Err(Refusal::Unparsable(_))));
    }

    #[test]
    fn a_failed_read_is_a_typed_refusal_and_is_not_remembered() {
        let model = ScriptedModel::new([r#"{"tool":"tally.balances","args":{}}"#]);
        let reader = StaticReader::new().failing("tally.balances", "the vault is closed");
        let mut session = Session::new(None);
        let (result, events) = run(&model, &reader, &mut session, "who owes me?");
        assert_eq!(
            result,
            Err(Refusal::QueryFailed("the vault is closed".to_owned()))
        );
        assert!(matches!(
            events.last(),
            Some(Event::Failed(Refusal::QueryFailed(_)))
        ));
        assert!(session.history().is_empty());
        assert_eq!(
            model.prompts().len(),
            1,
            "no phrase is asked for a read that failed"
        );
    }

    #[test]
    fn an_engine_failure_is_a_typed_refusal() {
        let model = ScriptedModel::empty();
        let (result, _) = run(&model, &StaticReader::new(), &mut Session::new(None), "hi");
        assert!(matches!(result, Err(Refusal::ModelFailed(_))));
    }

    #[test]
    fn cancelling_during_the_route_is_cancelled_with_no_read() {
        let model = ScriptedModel::new([r#"{"tool":"tasks.list","args":{}}"#]);
        let reader = StaticReader::new().with("tasks.list", tasks_output());
        let plane = Plane {
            model: &model,
            reader: &reader,
            budget: Budget::DEFAULT,
        };
        let cancel = Cancel::new();
        cancel.cancel();
        let mut events = Vec::new();
        let result = plane.run_turn(&mut Session::new(None), "tasks", &CTX, &cancel, &mut |e| {
            events.push(e)
        });
        assert_eq!(result, Err(Refusal::Cancelled));
        assert!(reader.reads().is_empty());
    }

    #[test]
    fn cancelling_mid_phrase_is_cancelled_after_the_cards_were_shown() {
        let model = ScriptedModel::new([
            r#"{"tool":"tasks.list","args":{}}"#,
            "A long sentence that never ends",
        ])
        .cancelling_during(1, 2);
        let reader = StaticReader::new().with("tasks.list", tasks_output());
        let (result, events) = run(&model, &reader, &mut Session::new(None), "tasks");
        assert_eq!(result, Err(Refusal::Cancelled));
        assert!(events.iter().any(|event| matches!(event, Event::Cards(_))));
        assert!(matches!(
            events.last(),
            Some(Event::Failed(Refusal::Cancelled))
        ));
    }

    #[test]
    fn an_unusable_phrase_falls_back_to_the_reads_headline() {
        for bad in ["", "   ", r#"{"tool":"none"}"#] {
            let model = ScriptedModel::new([r#"{"tool":"tasks.list","args":{}}"#, bad]);
            let reader = StaticReader::new().with("tasks.list", tasks_output());
            let (result, _) = run(&model, &reader, &mut Session::new(None), "tasks");
            assert_eq!(result.unwrap().text, "2 tasks due today", "{bad:?}");
        }
    }

    #[test]
    fn a_sentence_about_the_model_itself_or_a_number_the_read_lacks_falls_back_to_the_headline() {
        let money = || {
            let mut output = ToolOutput {
                headline: "Spending in 2026-09: 1240.50 USD".to_owned(),
                ..ToolOutput::default()
            };
            output.facts = vec!["Lodging: 640.00 USD".to_owned()];
            output
        };
        for (bad, why) in [
            (
                "You spent 2,217.90 USD last month.",
                "a figure the read does not hold",
            ),
            (
                "I do not have access to that in the provided result.",
                "talk about itself",
            ),
            (
                "The member spent 1240.50 USD.",
                "the member in the third person",
            ),
            ("The tool found 3 things.", "talk about its tools"),
            (
                "You can see 1240.50 USD below.",
                "a word the copy rules ban",
            ),
        ] {
            let model = ScriptedModel::new([r#"{"tool":"tally.spending","args":{}}"#, bad]);
            let reader = StaticReader::new().with("tally.spending", money());
            let (result, _) = run(&model, &reader, &mut Session::new(None), "spending?");
            assert_eq!(
                result.unwrap().text,
                "Spending in 2026-09: 1240.50 USD",
                "{why}: {bad}"
            );
        }
        // And the same figure said with a thousands separator is the same figure.
        for good in [
            "You spent 1,240.50 USD in September, 640.00 of it on lodging.",
            "You spent 1240.50 USD in September.",
            "Nothing was spent today.",
        ] {
            let model = ScriptedModel::new([r#"{"tool":"tally.spending","args":{}}"#, good]);
            let reader = StaticReader::new().with("tally.spending", money());
            let (result, _) = run(&model, &reader, &mut Session::new(None), "spending?");
            assert_eq!(result.unwrap().text, good);
        }
    }

    #[test]
    fn numbers_are_read_whole_and_a_full_stop_is_not_part_of_one() {
        assert_eq!(numbers_in("You have 3 tasks, 1 overdue."), ["3", "1"]);
        assert_eq!(numbers_in("Spent 1,240.50 USD."), ["1240.50"]);
        assert_eq!(
            numbers_in("On 2026-10-01 at 09:30."),
            ["2026", "10", "01", "09", "30"]
        );
        assert!(numbers_in("Nothing here.").is_empty());
    }

    #[test]
    fn the_next_turn_sees_the_last_two_and_not_the_third() {
        let reader = StaticReader::new().with("tasks.list", tasks_output());
        let model = ScriptedModel::new(
            ["{\"tool\":\"tasks.list\",\"args\":{}}", "one."]
                .into_iter()
                .chain(["{\"tool\":\"tasks.list\",\"args\":{}}", "two."])
                .chain(["{\"tool\":\"tasks.list\",\"args\":{}}", "three."])
                .chain(["{\"tool\":\"tasks.list\",\"args\":{}}", "four."]),
        );
        let mut session = Session::new(None);
        for question in ["first q", "second q", "third q", "fourth q"] {
            run(&model, &reader, &mut session, question).0.unwrap();
        }
        let last_route = &model.prompts()[6];
        assert!(!last_route.contains("first q"));
        assert!(last_route.contains("second q") && last_route.contains("third q"));
    }

    #[test]
    fn regenerate_drops_the_recorded_turn_and_returns_the_question() {
        let model = ScriptedModel::new([r#"{"tool":"tasks.list","args":{}}"#, "one."]);
        let reader = StaticReader::new().with("tasks.list", tasks_output());
        let mut session = Session::new(None);
        run(&model, &reader, &mut session, "what is due?")
            .0
            .unwrap();
        assert_eq!(session.history().len(), 1);
        assert_eq!(
            session.prepare_regenerate().as_deref(),
            Some("what is due?")
        );
        assert!(session.history().is_empty());
    }

    #[test]
    fn regenerate_after_a_failed_turn_keeps_the_history_and_returns_the_question() {
        let model = ScriptedModel::new(["nonsense"]);
        let mut session = Session::new(None);
        run(&model, &StaticReader::new(), &mut session, "what is due?")
            .0
            .unwrap_err();
        assert_eq!(
            session.prepare_regenerate().as_deref(),
            Some("what is due?")
        );
        assert_eq!(Session::new(None).prepare_regenerate(), None);
    }

    /// A chat reopened from the vault routes a follow-up as it would have been
    /// routed had the app never closed (R-CHAT-1): the stored record carries the
    /// read the assistant made, which the member's words do not.
    #[test]
    fn a_restored_session_routes_a_follow_up_with_the_stored_read_in_the_prompt() {
        let reader = StaticReader::new().with("tasks.list", tasks_output());
        let first =
            ScriptedModel::new([r#"{"tool":"tasks.list","args":{"view":"today"}}"#, "Two."]);
        let mut live = Session::new(Some(App::Tasks));
        run(&first, &reader, &mut live, "what is due today?")
            .0
            .unwrap();
        // The vault keeps the turn as text and hands it back.
        let stored: Vec<Turn> = live
            .history()
            .iter()
            .map(|turn| Turn::from_json(&turn.to_json()).expect("the record reads back"))
            .collect();
        assert_eq!(stored, live.history());

        let second = ScriptedModel::new([r#"{"tool":"tasks.list","args":{}}"#, "Three."]);
        let mut restored = Session::restore(
            Some(App::Tasks),
            stored,
            Some("what is due today?".to_owned()),
        );
        assert_eq!(restored.scope(), Some(App::Tasks));
        run(&second, &reader, &mut restored, "and tomorrow?")
            .0
            .unwrap();
        let route = &second.prompts()[0];
        assert!(route.contains("what is due today?"), "{route}");
        assert!(
            route.contains(r#""view":"today""#),
            "the stored call is in the prompt: {route}"
        );
        assert_eq!(restored.history().len(), 2);
    }

    #[test]
    fn a_restored_session_keeps_only_the_last_two_turns_in_the_prompt() {
        let reader = StaticReader::new().with("tasks.list", tasks_output());
        let history: Vec<Turn> = (1..=6)
            .map(|n| Turn {
                user: format!("question {n}"),
                record: Recorded::Tool {
                    call_json: r#"{"tool":"tasks.list","args":{}}"#.to_owned(),
                    headline: "2 tasks".to_owned(),
                    answer: format!("answer {n}"),
                },
            })
            .collect();
        let model = ScriptedModel::new([r#"{"tool":"tasks.list","args":{}}"#, "ok."]);
        let mut session = Session::restore(None, history, Some("question 6".to_owned()));
        run(&model, &reader, &mut session, "and now?").0.unwrap();
        let route = &model.prompts()[0];
        assert!(!route.contains("question 4"), "no prompt growth: {route}");
        assert!(route.contains("question 5") && route.contains("question 6"));
    }

    #[test]
    fn a_restored_session_can_ask_the_last_question_again() {
        let history = vec![Turn {
            user: "what is due?".to_owned(),
            record: Recorded::Answer("Nothing.".to_owned()),
        }];
        let mut session = Session::restore(None, history, Some("what is due?".to_owned()));
        assert_eq!(
            session.prepare_regenerate().as_deref(),
            Some("what is due?")
        );
        assert!(session.history().is_empty(), "the recorded turn is dropped");
    }

    #[test]
    fn a_record_this_build_cannot_read_is_no_history() {
        assert_eq!(Turn::from_json("not json"), None);
        assert_eq!(
            Turn::from_json(r#"{"user":"q","record":{"kind":"mystery"}}"#),
            None
        );
        assert_eq!(
            Turn::from_json(r#"{"user":"q","record":{"kind":"tool"}}"#),
            None
        );
        for record in [
            Recorded::NoTool,
            Recorded::Answer("a".to_owned()),
            Recorded::Attachment("a photo".to_owned()),
        ] {
            let turn = Turn {
                user: "q".to_owned(),
                record,
            };
            assert_eq!(Turn::from_json(&turn.to_json()), Some(turn));
        }
    }

    #[test]
    fn clear_starts_a_new_chat_and_keeps_the_scope() {
        let model = ScriptedModel::new([r#"{"answer":"Hi."}"#]);
        let mut session = Session::new(Some(App::Tally));
        run(&model, &StaticReader::new(), &mut session, "hi")
            .0
            .unwrap();
        session.clear();
        assert!(session.history().is_empty());
        assert_eq!(session.scope(), Some(App::Tally));
        assert_eq!(session.prepare_regenerate(), None);
    }

    #[test]
    fn a_scoped_session_lists_its_apps_tools_first_in_the_prompt() {
        let model = ScriptedModel::new([r#"{"answer":"Hi."}"#]);
        let mut session = Session::new(Some(App::Tally));
        run(&model, &StaticReader::new(), &mut session, "hi")
            .0
            .unwrap();
        let prompt = &model.prompts()[0];
        assert!(
            prompt.find("- tally.balances").unwrap() < prompt.find("- agenda.upcoming").unwrap()
        );
    }

    // ------------------------------------------------------------ attachments --

    use crate::attach::{Attachments, ImageData, Notice, TextDoc};
    use crate::model::MEDIA_MARKER;

    fn photo() -> Attachments {
        Attachments {
            image: Some(ImageData {
                width: 64,
                height: 32,
                rgb: vec![7; 64 * 32 * 3],
                label: "Truckee river bend".to_owned(),
            }),
            doc: None,
        }
    }

    fn packing_list(lines: usize) -> Attachments {
        Attachments {
            image: None,
            doc: Some(TextDoc {
                name: "Tahoe packing list".to_owned(),
                text: (0..lines).map(|n| format!("Item {n}: a thing\n")).collect(),
            }),
        }
    }

    fn run_attached(
        model: &ScriptedModel,
        session: &mut Session,
        text: &str,
        attachments: &Attachments,
    ) -> (Result<Answered, Refusal>, Vec<Event>) {
        let reader = StaticReader::new();
        let plane = Plane {
            model,
            reader: &reader,
            budget: Budget::DEFAULT,
        };
        let mut events = Vec::new();
        let result = plane.run_attached_turn(
            session,
            text,
            Some(attachments),
            &CTX,
            &Cancel::new(),
            &mut |event| events.push(event),
        );
        (result, events)
    }

    #[test]
    fn a_photo_turn_skips_routing_and_streams_one_answer_over_the_image() {
        let model = ScriptedModel::new(["A river bends past a stand of pines."]).seeing();
        let mut session = Session::new(Some(App::Tally));
        let (result, events) =
            run_attached(&model, &mut session, "What is in this photo?", &photo());

        let answered = result.expect("the turn answers");
        assert_eq!(answered.text, "A river bends past a stand of pines.");
        assert!(answered.cards.is_empty() && answered.notices.is_empty());

        // ONE generation: no route step, no phrase step, no grammar.
        let requests = model.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.grammar, None);
        assert_eq!(request.images, vec![(64, 32)]);
        assert_eq!(request.prompt.matches(MEDIA_MARKER).count(), 1);
        assert!(
            !request.prompt.contains("Tools:"),
            "the router's prompt is not used"
        );
        assert!(request.prompt.ends_with(crate::prompt::ASSISTANT_TURN));

        assert_eq!(events.first(), Some(&Event::Reading(Reading::Photo)));
        assert!(!events.iter().any(|e| matches!(e, Event::Activity { .. })));
        let streamed: String = events
            .iter()
            .filter_map(|event| match event {
                Event::Token(piece) => Some(piece.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(streamed, "A river bends past a stand of pines.");
        assert!(matches!(events.last(), Some(Event::Answer { notices, .. }) if notices.is_empty()));
    }

    #[test]
    fn a_photo_with_no_projector_is_a_typed_refusal_and_asks_nothing() {
        let model = ScriptedModel::new(["never said"]);
        let mut session = Session::new(None);
        let (result, events) = run_attached(&model, &mut session, "What is this?", &photo());
        assert_eq!(result.unwrap_err(), Refusal::VisionAbsent);
        assert!(model.requests().is_empty());
        assert!(matches!(
            events.last(),
            Some(Event::Failed(Refusal::VisionAbsent))
        ));
        assert!(
            session.history().is_empty(),
            "a refused turn is not remembered"
        );
    }

    #[test]
    fn a_document_turn_needs_no_projector_and_carries_the_text_not_an_image() {
        let model = ScriptedModel::new(["Bring the tent and the stove."]);
        let mut session = Session::new(None);
        let (result, events) = run_attached(
            &model,
            &mut session,
            "What should I not forget?",
            &packing_list(3),
        );
        result.expect("the turn answers");
        let request = &model.requests()[0];
        assert!(request.images.is_empty());
        assert!(request.prompt.contains("Item 2: a thing"));
        assert!(!request.prompt.contains(MEDIA_MARKER));
        assert_eq!(events.first(), Some(&Event::Reading(Reading::Document)));
    }

    #[test]
    fn a_cut_document_tells_the_member_on_the_answer() {
        let model = ScriptedModel::new(["The start of a very long list."]);
        let mut session = Session::new(None);
        let (result, events) =
            run_attached(&model, &mut session, "Summarise it", &packing_list(5000));
        let answered = result.expect("the turn answers");
        assert_eq!(answered.notices, vec![Notice::DocTruncated]);
        assert!(
            matches!(events.last(), Some(Event::Answer { notices, .. }) if notices == &vec![Notice::DocTruncated])
        );
        let prompt = &model.requests()[0].prompt;
        assert!(prompt.contains("the document goes on"));
        assert!(!prompt.contains("Item 4999"));
        assert!(crate::prompt::estimate_tokens(prompt) <= Budget::DEFAULT.attach_limit());
    }

    #[test]
    fn the_history_keeps_a_marker_and_the_words_never_the_bytes() {
        let model = ScriptedModel::new(["A river.", "It is on the left."]).seeing();
        let mut session = Session::new(None);
        run_attached(&model, &mut session, "What is in this photo?", &photo())
            .0
            .unwrap();
        let turn = &session.history()[0];
        assert_eq!(
            turn.user,
            "[Photo: Truckee river bend] What is in this photo?"
        );
        assert_eq!(turn.record, Recorded::Attachment("A river.".to_owned()));

        // A follow-up that does not attach again is a plain turn: it is
        // answered in free chat (the route says none), sees the marker and the
        // earlier answer, and carries no image.
        let follow = ScriptedModel::new([r#"{"tool":"none"}"#, "It is on the left."]);
        let reader = StaticReader::new();
        let plane = Plane {
            model: &follow,
            reader: &reader,
            budget: Budget::DEFAULT,
        };
        plane
            .run_turn(
                &mut session,
                "Where is it?",
                &CTX,
                &Cancel::new(),
                &mut |_| {},
            )
            .unwrap();
        let requests = follow.requests();
        assert!(
            !requests[0].prompt.contains("Truckee river bend"),
            "the router never sees an attachment turn"
        );
        assert!(
            requests[1]
                .prompt
                .contains("[Photo: Truckee river bend] What is in this photo?")
        );
        assert!(requests[1].prompt.contains("A river."));
        assert!(requests.iter().all(|r| r.images.is_empty()));
    }

    #[test]
    fn retry_asks_the_same_question_of_the_same_attachment() {
        let model = ScriptedModel::new(["First.", "Second."]).seeing();
        let mut session = Session::new(None);
        run_attached(&model, &mut session, "What is in this photo?", &photo())
            .0
            .unwrap();
        assert_eq!(session.history().len(), 1);

        let text = session
            .prepare_regenerate()
            .expect("a question to ask again");
        assert_eq!(text, "What is in this photo?");
        assert!(
            session.history().is_empty(),
            "the attachment turn is dropped"
        );
        let attachments = session.last_attachments().cloned().expect("kept for retry");
        let (result, _) = run_attached(&model, &mut session, &text, &attachments);
        assert_eq!(result.unwrap().text, "Second.");
        assert_eq!(session.history().len(), 1);

        // The next plain turn forgets it, and so does a new chat.
        session.clear();
        assert!(session.last_attachments().is_none());
    }

    #[test]
    fn a_plain_turn_after_an_attachment_turn_forgets_the_attachment() {
        let model = ScriptedModel::new(["A river."]).seeing();
        let mut session = Session::new(None);
        run_attached(&model, &mut session, "What is in this photo?", &photo())
            .0
            .unwrap();
        assert!(session.last_attachments().is_some());
        let next = ScriptedModel::new([r#"{"answer":"Hi."}"#]);
        run(&next, &StaticReader::new(), &mut session, "hi")
            .0
            .unwrap();
        assert!(session.last_attachments().is_none());
    }

    #[test]
    fn cancelling_an_attachment_turn_is_cancelled_and_is_not_remembered() {
        let model = ScriptedModel::new(["A long description of the river."])
            .seeing()
            .cancelling_during(0, 2);
        let mut session = Session::new(None);
        let (result, _) = run_attached(&model, &mut session, "Describe it", &photo());
        assert_eq!(result.unwrap_err(), Refusal::Cancelled);
        assert!(session.history().is_empty());
    }

    #[test]
    fn an_empty_attachment_set_is_a_plain_turn() {
        let model = ScriptedModel::new([r#"{"answer":"Hi."}"#]);
        let mut session = Session::new(None);
        let (result, _) = run_attached(&model, &mut session, "hi", &Attachments::default());
        assert_eq!(result.unwrap().text, "Hi.");
        assert!(model.requests()[0].grammar.is_some(), "it routed");
    }
}
