//! THE EVAL FIXTURE, RUN THROUGH THE REAL CORE.
//!
//! Every case in `contracts/assist/eval-cases.json` is asked of a sample vault
//! over the wire — `Request::Assist`, a session, a send — with an oracle model
//! that emits the call the case expects. The oracle is the point: what is
//! proven here is the **plane**. The grammar-accepted call is parsed, the
//! registry runs it through the query path a screen uses, the rows come back as
//! cards of the right app, the events arrive in order, and a refusal is the
//! refusal. Whether a real model picks the call is `assist-eval`'s question.
//!
//! The cases state what the sample vault holds ("Maya Alvarez" owes, "Rotate
//! the tires" is overdue). A change to `crates/core/src/sample.rs` that removes
//! a row a case names fails here, by case id, and the fixture is edited in the
//! same change.

mod common;

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use centraid_assist::eval::{EvalFile, Expect};
use centraid_assist::model::{Control, GenerateRequest, Generation, Model, ModelError};
use centraid_assist::testing::OracleModel;
use centraid_assist::tool::tool;
use centraid_assist::{App, TOOLS};
use centraid_core::api_proto as wire;

/// The oracle, remembering every prompt it was shown.
struct Spy {
    inner: OracleModel,
    prompts: Mutex<Vec<String>>,
}

impl Model for Spy {
    fn generate(
        &self,
        request: &GenerateRequest<'_>,
        on_token: &mut dyn FnMut(&str) -> Control,
    ) -> Result<Generation, ModelError> {
        self.prompts.lock().unwrap().push(request.prompt.to_owned());
        self.inner.generate(request, on_token)
    }
}

fn fixture() -> EvalFile {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/assist/eval-cases.json"
    );
    EvalFile::parse(&std::fs::read_to_string(path).expect("the eval fixture is there"))
        .expect("the eval fixture is valid")
}

/// Every prompt the plane has shown the oracle since `from`.
fn since(spy: &Spy, from: usize) -> Vec<String> {
    spy.prompts.lock().unwrap()[from..].to_vec()
}

#[test]
fn every_case_runs_through_the_core_and_draws_what_it_expects() {
    let file = fixture();
    let mut routes = file.oracle_routes().expect("routes");
    // The earlier turns of a follow-up are asked for real, so the oracle must
    // know them too.
    for case in &file.cases {
        for entry in &case.history {
            if let Some(call) = &entry.call {
                let json = match call.to_call().expect("a valid call") {
                    Some(call) => call.to_json(),
                    None => r#"{"tool":"none"}"#.to_owned(),
                };
                routes.push((centraid_assist::prompt::question(&entry.user), json));
            }
        }
    }
    let spy = Arc::new(Spy {
        inner: OracleModel::new(routes),
        prompts: Mutex::new(Vec::new()),
    });
    let sample = common::sample();
    sample.install(Arc::clone(&spy) as Arc<dyn Model>);

    let mut tools_run = BTreeSet::new();
    let mut turn = 0u64;
    for case in &file.cases {
        let scope = case.scope.clone().unwrap_or_default();
        let session = sample.start(&scope);
        // Earlier turns, asked for real, through the same session.
        for entry in &case.history {
            turn += 1;
            sample.send(session, turn, &entry.user);
        }
        let before = spy.prompts.lock().unwrap().len();
        sample.drain_assist_events();
        turn += 1;
        let sent = sample.send(session, turn, &case.question);
        let events = sample.drain_assist_events();
        let id = &case.id;

        assert_eq!(
            (sent.session_id, sent.turn_id),
            (session, turn),
            "{id}: the ids are echoed"
        );
        assert!(
            events
                .iter()
                .all(|event| (event.session_id, event.turn_id) == (session, turn)),
            "{id}"
        );

        match (&case.expect, sent.outcome.as_ref().expect("an outcome")) {
            // NO TOOL FITS IS A FREE-CHAT REPLY: it reads nothing and draws no
            // cards, and it is an answer, not a refusal.
            (Expect::Call(call), wire::assist_sent::Outcome::Answered(answer))
                if call.tool == "none" =>
            {
                assert!(!answer.text.is_empty(), "{id}");
                assert!(answer.cards.is_empty(), "{id}: free chat draws no cards");
                assert!(!events.iter().any(|event| matches!(
                    event.kind,
                    Some(wire::assist_event::Kind::Activity(_))
                )));
            }
            (Expect::Answer { .. }, wire::assist_sent::Outcome::Answered(answer)) => {
                assert!(!answer.text.is_empty(), "{id}");
                assert!(
                    answer.cards.is_empty(),
                    "{id}: a direct answer draws no cards"
                );
            }
            (Expect::Call(call), wire::assist_sent::Outcome::Answered(answer)) => {
                let spec = tool(&call.tool).expect("a registered tool");
                tools_run.insert(spec.name);
                assert!(!answer.text.is_empty(), "{id}");
                for card in &answer.cards {
                    assert_eq!(
                        card.app,
                        spec.app.id(),
                        "{id}: every card belongs to the tool's app"
                    );
                    assert!(
                        !card.id.is_empty() && !card.title.is_empty() && !card.entity.is_empty(),
                        "{id}"
                    );
                }
                if let Some(wanted) = &case.cards {
                    if let Some(min) = wanted.min {
                        assert!(
                            answer.cards.len() >= min.min(6),
                            "{id}: {} cards, wanted {min}",
                            answer.cards.len()
                        );
                    }
                    if let Some(max) = wanted.max {
                        assert!(
                            answer.cards.len() <= max,
                            "{id}: {} cards, wanted at most {max}",
                            answer.cards.len()
                        );
                    }
                    for title in &wanted.titles {
                        assert!(
                            answer.cards.iter().any(|card| card
                                .title
                                .to_lowercase()
                                .contains(&title.to_lowercase())),
                            "{id}: no card is titled like {title:?}; got {:?}",
                            answer
                                .cards
                                .iter()
                                .map(|card| &card.title)
                                .collect::<Vec<_>>()
                        );
                    }
                }
                // The stream: the activity, the cards (when there are any), the
                // sentence, then the answer — and the answer is the response.
                let kinds: Vec<&str> = events
                    .iter()
                    .map(|event| match event.kind.as_ref().expect("a kind") {
                        wire::assist_event::Kind::Activity(_) => "activity",
                        wire::assist_event::Kind::Cards(_) => "cards",
                        wire::assist_event::Kind::Token(_) => "token",
                        wire::assist_event::Kind::Answer(_) => "answer",
                        wire::assist_event::Kind::Failed(_) => "failed",
                        wire::assist_event::Kind::Reading(_) => "reading",
                    })
                    .collect();
                assert_eq!(kinds.first(), Some(&"activity"), "{id}: {kinds:?}");
                assert_eq!(kinds.last(), Some(&"answer"), "{id}: {kinds:?}");
                assert_eq!(
                    kinds.contains(&"cards"),
                    !answer.cards.is_empty(),
                    "{id}: cards are streamed exactly when there are some"
                );
                assert!(
                    kinds.iter().position(|k| *k == "activity")
                        < kinds.iter().position(|k| *k == "token")
                );
                let Some(wire::assist_event::Kind::Activity(activity)) = events[0].kind.as_ref()
                else {
                    unreachable!()
                };
                assert_eq!(
                    (activity.app.as_str(), activity.tool.as_str()),
                    (spec.app.id(), spec.name),
                    "{id}"
                );
                let Some(wire::assist_event::Kind::Answer(streamed)) =
                    events.last().and_then(|event| event.kind.as_ref())
                else {
                    unreachable!()
                };
                assert_eq!(
                    streamed, answer,
                    "{id}: the terminal event and the response are one fact"
                );
            }
            (expected, got) => panic!("{id}: expected {expected:?}, got {got:?}"),
        }

        // A follow-up's prompt carries the turns before it, and only the last two.
        let shown = since(&spy, before);
        assert!(
            shown[0].ends_with(centraid_assist::prompt::ASSISTANT_TURN),
            "{id}"
        );
        // A `none` turn in the history was answered by free chat, so it is a
        // turn that said something and rides in the prompt like any other.
        for entry in case.history.iter().rev().take(2) {
            assert!(
                shown[0].contains(&centraid_assist::prompt::question(&entry.user)),
                "{id}: history is in the prompt"
            );
        }
        // A scoped chat lists its own app's tools first.
        if let Some(app) = App::from_id(&scope) {
            let own = TOOLS.iter().find(|spec| spec.app == app).unwrap().name;
            let other = TOOLS.iter().find(|spec| spec.app != app).unwrap().name;
            assert!(
                shown[0].find(&format!("- {own}")).unwrap()
                    < shown[0].find(&format!("- {other}")).unwrap_or(usize::MAX),
                "{id}"
            );
        }
    }

    // The fixture covers the whole registry; a tool with no case is a tool nobody
    // has shown can run against a vault.
    let registered: BTreeSet<&str> = TOOLS.iter().map(|spec| spec.name).collect();
    assert_eq!(
        tools_run, registered,
        "a tool has no eval case, or a case names a tool that is gone"
    );
    assert!(file.cases.len() >= 50);
}

#[test]
fn the_tool_a_case_names_answers_with_the_headline_the_oracle_says() {
    // The oracle phrases a read as its headline, so the sentence is the
    // executor's own words — which is what a fallback line would say too.
    let sample = common::sample();
    let oracle = OracleModel::new([
        (
            "Who owes me money?".to_owned(),
            r#"{"tool":"tally.balances","args":{}}"#.to_owned(),
        ),
        (
            "What did we spend last month?".to_owned(),
            r#"{"tool":"tally.spending","args":{"month":"last"}}"#.to_owned(),
        ),
        (
            "What tasks are overdue?".to_owned(),
            r#"{"tool":"tasks.list","args":{"view":"overdue"}}"#.to_owned(),
        ),
        (
            "Do I have any PDFs?".to_owned(),
            r#"{"tool":"docs.list","args":{"type":"pdf"}}"#.to_owned(),
        ),
    ]);
    sample.install(Arc::new(oracle));
    let session = sample.start("");
    let say = |turn: u64, text: &str| match sample.send(session, turn, text).outcome {
        Some(wire::assist_sent::Outcome::Answered(answer)) => answer.text,
        other => panic!("{text}: {other:?}"),
    };
    assert_eq!(say(1, "Who owes me money?"), "3 friends with a balance");
    assert_eq!(say(2, "What tasks are overdue?"), "1 task overdue");
    assert_eq!(say(3, "Do I have any PDFs?"), "No documents recent");
    assert!(say(4, "What did we spend last month?").starts_with("Spending in "));
}
