//! The chat through the door a shell uses: a real core over the scenario, a scripted model in the
//! slot, and a "shell" that performs the `AssistCall` effects the way SwiftUI and Compose do
//! (a blocking `Request::assist` off the UI thread, its answer sent back as an effect result).

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_assist::model::Model;
use centraid_assist::testing::ScriptedModel;
use centraid_screens::testing::Driver;
use centraid_screens::{Registry, Runtime, chat, photos};
use wire::chat_event::Kind as C;
use wire::screen_event::Kind as S;

/// One model step, as the free decoder reads it: a think that states no whole call, so the call
/// is the model's own.
pub fn step(think: &str, tool: &str, args: &[(&str, &str)]) -> [String; 2] {
    let params: String = args
        .iter()
        .map(|(key, value)| format!("<parameter={key}>\n{value}\n</parameter>\n"))
        .collect();
    [
        think.to_owned(),
        format!("\n\n<tool_call>\n<function={tool}>\n{params}</function>\n"),
    ]
}

pub fn script(steps: &[[String; 2]]) -> Arc<ScriptedModel> {
    Arc::new(ScriptedModel::new(steps.iter().flatten().cloned()))
}

/// Look at the tasks, then answer with them: twelve tasks, six drawn.
pub fn read_tasks() -> [[String; 2]; 2] {
    [
        step("plan: look", "find", &[("kind", "task")]),
        step("plan: answer", "answer", &[("rows", "@1")]),
    ]
}

pub const FOUND_TASKS: &str = "Found 12 tasks. Showing 6.";
pub const DRY_CLEANING: &str = "Pick up the dry cleaning";

pub fn complete_dry_cleaning() -> Vec<[String; 2]> {
    vec![
        step(
            "plan: look",
            "find",
            &[("kind", "task"), ("name", "dry cleaning")],
        ),
        step(
            "plan: write",
            "act",
            &[("verb", "complete"), ("rows", "@1")],
        ),
    ]
}

pub struct Chat {
    pub driver: Driver,
    pub id: u64,
}

pub fn registry() -> Registry {
    chat::registry().merge(photos::registry())
}

pub fn runtime() -> Runtime {
    Runtime::new(
        registry(),
        vec![(chat::TAB.to_owned(), chat::routes::home())],
    )
}

impl Chat {
    /// A chat tab over the scenario with `model` already in the slot (`None`: no model).
    pub fn with(model: Option<Arc<dyn Model>>) -> Self {
        Self::on(Driver::with_runtime(runtime()), model)
    }

    /// The same over a core that holds the vault's keys, so Locker can be unlocked.
    pub fn keyed(model: Arc<dyn Model>) -> Self {
        let mut chat = Self::on(Driver::keyed(runtime()), Some(model));
        chat.open("");
        chat
    }

    fn on(mut driver: Driver, model: Option<Arc<dyn Model>>) -> Self {
        if let Some(model) = model {
            driver.handle.assist().host().install(model);
        }
        driver.start();
        let id = driver.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
        Self { driver, id }
    }

    pub fn ready(model: Arc<dyn Model>) -> Self {
        let mut chat = Self::with(Some(model));
        chat.open("");
        chat
    }

    pub fn event(&mut self, kind: C) -> wire::ScreenUpdate {
        self.driver
            .send(self.id, S::Chat(wire::ChatEvent { kind: Some(kind) }))
    }

    /// The tab appears, scoped to `app`; the shell's own bookkeeping (a models directory) rides
    /// along.
    pub fn open(&mut self, app: &str) {
        self.event(C::Opened(wire::chat_event::Opened {
            app: app.to_owned(),
            vault_name: "Sample".to_owned(),
            models_dir: "/nowhere/models".to_owned(),
            ..wire::chat_event::Opened::default()
        }));
        self.perform();
    }

    pub fn choose_scope(&mut self, app: &str) {
        self.event(C::Opened(wire::chat_event::Opened {
            app: app.to_owned(),
            scope_chosen: true,
            ..wire::chat_event::Opened::default()
        }));
        self.perform();
    }

    pub fn state(&self) -> &wire::ChatState {
        match &self.driver.view(self.id).kind {
            Some(wire::view_state::Kind::Chat(state)) => state,
            other => panic!("not a chat: {other:?}"),
        }
    }

    pub fn say(&mut self, text: &str) {
        self.event(C::Sent(wire::chat_event::Sent {
            text: text.to_owned(),
        }));
        self.perform();
    }

    /// Let the core's jobs and stream finish, as the shell's event thread would: pump until the
    /// chat is neither loading nor streaming and a last pump brings nothing.
    pub fn perform(&mut self) {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            self.driver.pump(Duration::from_millis(40));
            let state = self.state();
            let busy = state.phase() == wire::chat_state::Phase::Loading || state.streaming;
            if !busy && self.driver.pump(Duration::from_millis(40)) == 0 {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the chat never settled"
            );
        }
    }

    /// The effects of kind `pick` the screen has asked for and nobody answered.
    pub fn asked<T>(&self, pick: impl Fn(&wire::effect::Kind) -> Option<T>) -> Vec<T> {
        self.driver
            .effects
            .iter()
            .filter_map(|request| request.effect.as_ref()?.kind.as_ref().and_then(&pick))
            .collect()
    }

    pub fn last_text(&self) -> String {
        self.state()
            .messages
            .last()
            .map(|m| m.text.clone())
            .unwrap_or_default()
    }

    pub fn thread_titles(&self) -> Vec<String> {
        self.state()
            .threads
            .iter()
            .map(|t| t.title.clone())
            .collect()
    }
}
