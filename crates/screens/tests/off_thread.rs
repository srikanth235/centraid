//! A slow vault door runs off the runtime's lock and answers the asking screen
//! like a timer; a service runs without a view or a tab (#1135, lane H2).

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::VaultRequest;
use centraid_screens::testing::Driver;
use centraid_screens::{Ctx, Registry, Runtime, Screen};
use prost::Message;
use wire::screen_event::Kind as E;

/// Starts a phrase mint off-thread on `Appeared` and shows what came back as
/// the counter view's title, so the test reads it through the door a shell uses.
struct Job {
    heard: String,
    request: VaultRequest,
}

impl Screen for Job {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => ctx.vault_async("mint", self.request.clone()),
            Some(E::OffThreadDone(done)) => {
                let called =
                    wire::VaultCalled::decode(done.bytes.as_slice()).expect("a VaultCalled");
                self.heard = match called.error {
                    Some(error) => format!("{}:refused:{:?}", done.tag, error.code()),
                    None => {
                        let response =
                            wire::Response::decode(called.response.as_slice()).expect("a Response");
                        match response.kind {
                            Some(wire::response::Kind::Phrase(wire::PhraseResponse {
                                answer: Some(wire::phrase_response::Answer::Minted(minted)),
                            })) => format!("{}:{}", done.tag, minted.words.len()),
                            other => format!("{}:other:{other:?}", done.tag),
                        }
                    }
                };
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Counter(wire::CounterView {
                title: self.heard.clone(),
                content: None,
            })),
            ..Default::default()
        }
    }
}

fn route(name: &str) -> wire::Route {
    wire::Route {
        screen: name.to_owned(),
        ..Default::default()
    }
}

fn driver(request: VaultRequest) -> Driver {
    Driver::with_runtime(Runtime::new(
        Registry::default().with("job", move |_| {
            Some(Box::new(Job {
                heard: String::new(),
                request: request.clone(),
            }) as Box<dyn Screen>)
        }),
        vec![("job".to_owned(), route("job"))],
    ))
}

#[test]
fn a_slow_door_answers_the_screen_that_asked_like_a_timer() {
    let mut driver = driver(VaultRequest::Phrase(wire::PhraseRequest {
        op: Some(wire::phrase_request::Op::Mint(wire::PhraseMint {})),
    }));
    driver.start();
    let id = driver.navigation.as_ref().unwrap().tabs[0].entries[0].instance;
    assert_eq!(driver.counter(id).title, "", "nothing has come back yet");
    assert!(
        driver.pump(Duration::from_secs(10)) >= 1,
        "the answer is pushed"
    );
    assert_eq!(driver.counter(id).title, "mint:24");
}

#[test]
fn a_refusal_comes_back_typed() {
    // A pairing code that is not one: the core refuses it before dialling.
    let mut driver = driver(VaultRequest::PairPhone(wire::PairRequest::default()));
    driver.start();
    let id = driver.navigation.as_ref().unwrap().tabs[0].entries[0].instance;
    driver.pump(Duration::from_secs(10));
    assert!(
        driver.counter(id).title.starts_with("mint:refused:"),
        "{}",
        driver.counter(id).title
    );
}

#[test]
fn a_service_has_no_view_no_tab_and_no_snapshot_row() {
    let runtime = Runtime::new(
        Registry::default().with("job", |_| None).with("svc", |_| {
            Some(Box::new(Job {
                heard: "never drawn".to_owned(),
                request: VaultRequest::Phrase(wire::PhraseRequest::default()),
            }) as Box<dyn Screen>)
        }),
        vec![],
    )
    .with_services(vec![route("svc")]);
    let mut driver = Driver::with_runtime(runtime);
    let update = driver.start();
    assert!(update.views.is_empty(), "a service draws nothing");
    assert!(driver.navigation.as_ref().is_none_or(|n| n.tabs.is_empty()));
    let snapshot = driver.call(wire::screen_request::Kind::Snapshot(
        wire::SnapshotRequest {},
    ));
    assert!(snapshot.views.is_empty());
}
