//! THE CHAT (#1135, lane I): the on-device assistant as a Rust screen.
//!
//! `chat.home` is a tab, not an app. A question goes to the core's assistant plane
//! (`assist.proto`), the model routes it to one read and phrases one line, and the answer is
//! that line **and the rows it found**, which the apps' own tiles draw. This module is the
//! decisions: what each phase shows, what a tap does in each, how a streamed event and the
//! call's own answer (the same fact twice) settle a turn once. The turn itself is the core's;
//! the screen never re-implements a decision the assistant makes.
//!
//! ## Two kinds of call
//!
//! A BOUNDED assistant call (status, start, suggest, cancel, clear, confirm, dismiss,
//! documents) is made inline through `Ctx::assist`. The two that block for seconds, loading the
//! model and sending a turn, run from `Ctx::off_thread` on the core's pool, off the runtime lock,
//! and come back as `OffThreadDone`; the shell carries none of it. While a turn runs the core
//! routes each of its stream events here as `ScreenEvent.assist` ([`Screen::hears_assist`]).
//!
//! ## The phases are the model's, not the thread's
//!
//! `CHECKING → NEEDS_MODEL → DOWNLOADING → LOADING → READY`, with `UNAVAILABLE` for a build
//! that cannot run a model. The thread exists only in `READY`. The download is a step on the
//! way, drawn from `model_step`; the shell owns the transfer and reports progress as events.
//!
//! ## A turn settles ONCE
//!
//! The core tells a turn's end twice (a terminal event and the answer to the `send` call) and
//! which comes first is not promised. Both carry the turn id this screen minted, and a turn is
//! settled only while it is the running one.
//!
//! ## A write the model proposes is a card, and a tap makes it (#1088)
//!
//! The core never writes on the model's say-so: the turn ends in an answer carrying the write
//! it PARKED. It is drawn as a confirm card under the answer; Confirm asks the core to run it
//! (once), Cancel drops it. A card that seals a secret while Locker is shut asks the OS owner
//! check and opens the Locker session, then confirms again; nothing the model wrote reaches the
//! vault before the tap.
//!
//! Dropped with the Kotlin architecture: the `opening` interlude (a stored thread and its
//! session are read in the same update, so there is no half-opened chat to draw), the
//! `ChatFlow` lock and effect runner, the `ChatSlots.unlockLocker` hook (the unlock is an effect
//! and a session step here), and the shell's own copy of the model asset.

mod asset;
mod attach;
mod drawer;
mod model;
mod turn;
mod view;
mod when;

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as S;

use crate::registry::Registry;
use crate::screen::{Ctx, Screen};

use model::Chat;

/// The screen's registered name.
pub const HOME: &str = "chat.home";

/// A search's Ask opened as a page of its own: the same chat, with the question waiting.
pub const ASK: &str = "chat.ask";

/// The tab the chat is the root of.
pub const TAB: &str = "chat";

/// The chat's screen.
#[must_use]
pub fn registry() -> Registry {
    Registry::default().with(HOME, build).with(ASK, build_ask)
}

fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    matches!(route.args, Some(wire::route::Args::Chat(_))).then(|| {
        let chat: Box<dyn Screen> = Box::new(Chat::default());
        chat
    })
}

/// `chat.ask`: a chat in the asked scope with the question waiting; the shell's `opened` event
/// (it carries the models directory) starts it, and the question is put once the chat is ready.
fn build_ask(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::Ask(ask)) = &route.args else {
        return None;
    };
    Some(Box::new(Chat::asking(&scope_of(&ask.scope), &ask.question)))
}

/// The routes the chat hands to a shell.
pub mod routes {
    use super::{HOME, wire};

    /// A search's Ask as a page: `question` put to a chat in `scope`.
    #[must_use]
    pub fn ask(question: &str, scope: &str) -> wire::Route {
        wire::Route {
            screen: super::ASK.to_owned(),
            args: Some(wire::route::Args::Ask(wire::ShellAskRoute {
                question: question.to_owned(),
                scope: scope.to_owned(),
            })),
        }
    }

    /// The Chat tab's root.
    #[must_use]
    pub fn home() -> wire::Route {
        wire::Route {
            screen: HOME.to_owned(),
            args: Some(wire::route::Args::Chat(wire::ChatRoute {})),
        }
    }
}

/// THE APPS A CHAT CAN BE SCOPED TO, in the order the composer's menu lists them: every app a
/// member opens, Locker and Health included (the assistant's `App::ALL`). A chat scoped to
/// Agenda covers its tasks (#1128).
#[must_use]
pub fn scopable_apps() -> Vec<&'static str> {
    centraid_assist::App::ALL.iter().map(|app| app.id()).collect()
}

/// THE SCOPE A VISIT TO `app` GIVES A CHAT: the app it opens in, when that is a scope, else every
/// app (empty).
#[must_use]
pub fn scope_of(app: &str) -> String {
    centraid_assist::App::from_id(app)
        .map(|app| app.id().to_owned())
        .unwrap_or_default()
}

impl Screen for Chat {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(S::Chat(chat)) => match chat.kind {
                Some(kind) => self.on_event(kind, ctx),
                None => Vec::new(),
            },
            Some(S::Assist(heard)) => self.on_stream(&heard, ctx),
            Some(S::OffThreadDone(done)) => self.job_done(&done.tag, &done.bytes, ctx),
            Some(S::EffectResult(result)) => self.on_effect(result, ctx),
            Some(S::DataChanged(_)) => self.on_data_changed(ctx),
            Some(S::EnvironmentChanged(_)) => Vec::new(),
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        self.render(ctx)
    }

    fn hears_assist(&self) -> bool {
        true
    }
}
