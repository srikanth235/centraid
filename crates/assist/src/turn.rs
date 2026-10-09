//! THE SHARED VOCABULARY OF A TURN, and the attached turn.
//!
//! The native plane (`native_turn`) answers every question about the vault: the model drives the
//! runtime one call per message and the member reads cards and a line the runtime composes. What
//! is here is what that loop and the path beside it share:
//!
//! ```text
//! question + attachment ──► attached (one streamed answer over it, no tools)
//! ```
//!
//! The path beside the loop is off in the shipped build (R-1088-19): the core refuses a request
//! that carries an attachment ([`crate::attach`] and `centraid_core::assist::attach::OFFERED`).
//! There is no free reply any more either: a model's decline `out_of_scope` is the runtime's
//! canned sentence, with no second generation.
//!
//! **Every way out is typed.** A turn ends as [`Answered`] or as a [`Refusal`], and the sink has
//! seen the matching [`Event`] by then, so a shell that only watches events and one that only
//! reads the return value draw the same thing.

use crate::app::App;
use crate::attach::{ATTACH_MAX_TOKENS, Attachments, Notice, attach_prompt};
use crate::model::{Cancel, Control, Finish, GenerateRequest, ImageInput, Model, ModelError};
use crate::prompt::{Budget, END_OF_TURN, Recorded, Turn, question};
use crate::result::Card;

/// Why a turn did not answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    /// The turn had no question to answer. Stored threads and the wire keep the word
    /// (`NO_TOOL_FITS`): the routed plane said it when no tool fit.
    #[error("no tool fits")]
    NoToolFits,
    /// The vault could not answer.
    #[error("the read failed: {0}")]
    QueryFailed(String),
    /// The model's output was not usable. Nothing produces it now; the wire and stored
    /// threads keep the word (`UNPARSABLE`).
    #[error("the model's output was not usable: {0}")]
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
    /// A step is looking in an app: "Looking in Tally".
    Activity { app: App, tool: &'static str },
    /// The rows the turn found, to draw while the line is written.
    Cards(Vec<Card>),
    /// The model is reading an attachment: "Reading the photo".
    Reading(Reading),
    /// A piece of the words being generated (an attachment's answer).
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

/// One conversation as an attachment's prompt sees it: in memory, the last turns only.
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

    /// A chat reopened from its stored turns: the history an attachment follow-up reads,
    /// and the last question a Retry asks again.
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

/// What a turn over an attachment needs besides its session.
pub struct Plane<'a> {
    pub model: &'a dyn Model,
    pub budget: Budget,
}

impl Plane<'_> {
    /// Run one turn over `attachments`, calling `sink` with each [`Event`] as it happens: the
    /// reading, the streamed words, then the answer. The photograph or the document is read over
    /// the question by one unconstrained generation ([`crate::attach`]).
    ///
    /// # Errors
    /// A [`Refusal`], which the sink has already been told as [`Event::Failed`].
    pub fn run_attached_turn(
        &self,
        session: &mut Session,
        text: &str,
        attachments: &Attachments,
        cancel: &Cancel,
        sink: &mut dyn FnMut(Event),
    ) -> Result<Answered, Refusal> {
        let result = self.turn(session, text, attachments, cancel, sink);
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
        attachments: &Attachments,
        cancel: &Cancel,
        sink: &mut dyn FnMut(Event),
    ) -> Result<Answered, Refusal> {
        let user = question(text);
        if user.is_empty() {
            return Err(Refusal::NoToolFits);
        }
        session.last_user = Some(user.clone());
        session.last_recorded_user = Some(user.clone());
        session.last_attachments = Some(attachments.clone());
        self.attached(session, &user, attachments, cancel, sink)
    }

    /// A TURN OVER AN ATTACHMENT: one streamed answer, no tools.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attach::{ImageData, TextDoc};
    use crate::model::MEDIA_MARKER;
    use crate::testing::ScriptedModel;

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
        let plane = Plane {
            model,
            budget: Budget::DEFAULT,
        };
        let mut events = Vec::new();
        let result =
            plane.run_attached_turn(session, text, attachments, &Cancel::new(), &mut |event| {
                events.push(event)
            });
        (result, events)
    }

    #[test]
    fn a_photo_turn_streams_one_answer_over_the_image() {
        let model = ScriptedModel::new(["A river bends past a stand of pines."]).seeing();
        let mut session = Session::new(Some(App::Tally));
        let (result, events) =
            run_attached(&model, &mut session, "What is in this photo?", &photo());

        let answered = result.expect("the turn answers");
        assert_eq!(answered.text, "A river bends past a stand of pines.");
        assert!(answered.cards.is_empty() && answered.notices.is_empty());

        // ONE generation: no tools, no grammar.
        let requests = model.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.grammar, None);
        assert_eq!(request.images, vec![(64, 32)]);
        assert_eq!(request.prompt.matches(MEDIA_MARKER).count(), 1);
        assert!(
            !request.prompt.contains("<tools>"),
            "the runtime's prompt is not used"
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
    fn an_empty_question_is_a_typed_refusal_and_asks_nothing() {
        let model = ScriptedModel::new(["never said"]).seeing();
        let mut session = Session::new(None);
        let (result, _) = run_attached(&model, &mut session, "  \n ", &photo());
        assert_eq!(result.unwrap_err(), Refusal::NoToolFits);
        assert!(model.requests().is_empty());
    }

    #[test]
    fn the_history_keeps_a_marker_and_the_words_never_the_bytes() {
        let model = ScriptedModel::new(["A river."]).seeing();
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

        // A second attachment turn after it sees the marker and the earlier answer, and carries
        // no image of the first.
        let follow = ScriptedModel::new(["It is on the left."]);
        let (said, _) = run_attached(&follow, &mut session, "And the list?", &packing_list(1));
        assert_eq!(said.unwrap().text, "It is on the left.");
        let requests = follow.requests();
        assert!(
            requests[0]
                .prompt
                .contains("[Photo: Truckee river bend] What is in this photo?")
        );
        assert!(requests[0].prompt.contains("A river."));
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

        // A new chat forgets it.
        session.clear();
        assert!(session.last_attachments().is_none());
    }

    #[test]
    fn a_question_noted_for_retry_forgets_the_attachment() {
        let model = ScriptedModel::new(["A river."]).seeing();
        let mut session = Session::new(None);
        run_attached(&model, &mut session, "What is in this photo?", &photo())
            .0
            .unwrap();
        assert!(session.last_attachments().is_some());
        session.note_question("  hi  ");
        assert!(session.last_attachments().is_none());
        assert_eq!(session.prepare_regenerate().as_deref(), Some("hi"));
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
    fn an_engine_failure_is_a_typed_refusal() {
        let mut session = Session::new(None);
        let (result, events) = run_attached(
            &ScriptedModel::empty(),
            &mut session,
            "hi",
            &packing_list(1),
        );
        assert!(matches!(result, Err(Refusal::ModelFailed(_))));
        assert!(matches!(
            events.last(),
            Some(Event::Failed(Refusal::ModelFailed(_)))
        ));
    }

    #[test]
    fn regenerate_after_a_failed_turn_keeps_the_history_and_returns_the_question() {
        let mut session = Session::new(None);
        run_attached(
            &ScriptedModel::empty(),
            &mut session,
            "what is due?",
            &packing_list(1),
        )
        .0
        .unwrap_err();
        assert_eq!(
            session.prepare_regenerate().as_deref(),
            Some("what is due?")
        );
        assert_eq!(Session::new(None).prepare_regenerate(), None);
    }

    /// A chat reopened from the vault keeps what an attachment follow-up reads (R-CHAT-1).
    #[test]
    fn a_restored_session_keeps_only_the_last_two_turns_in_a_prompt() {
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
        let mut restored =
            Session::restore(Some(App::Tasks), history, Some("question 6".to_owned()));
        assert_eq!(restored.scope(), Some(App::Tasks));
        let model = ScriptedModel::new(["ok."]);
        run_attached(&model, &mut restored, "And the list?", &packing_list(1))
            .0
            .unwrap();
        let prompt = &model.prompts()[0];
        assert!(!prompt.contains("question 4"), "no prompt growth: {prompt}");
        assert!(prompt.contains("question 5") && prompt.contains("question 6"));
        assert!(
            prompt.contains("answer 6"),
            "a stored read's words are shown"
        );
        assert!(!prompt.contains("tasks.list"), "and its call is not");
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
    fn clear_starts_a_new_chat_and_keeps_the_scope() {
        let mut session = Session::restore(
            Some(App::Tally),
            vec![Turn {
                user: "hi".to_owned(),
                record: Recorded::Answer("Hi.".to_owned()),
            }],
            Some("hi".to_owned()),
        );
        session.clear();
        assert!(session.history().is_empty());
        assert_eq!(session.scope(), Some(App::Tally));
        assert_eq!(session.prepare_regenerate(), None);
    }
}
