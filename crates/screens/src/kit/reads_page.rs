//! THE KIT'S ONE "WHAT <APP> MAY READ" PAGE (owner, 2026-11-19), the app a [`ReadsSpec`]: Notes' `notes.reads`,
//! Docs' `docs.reads`, Money's `money.reads` and People's `people.reads` are this machine over their own
//! spec, opened from the app's More sheet by a row with the Shield glyph, as Calendar, Reminders
//! and Health open theirs.
//!
//! It says what the app may read of the vault, as the kinds a member knows (the manifest's read
//! scopes with the vault's plumbing left out), and what it writes. It reads nothing and writes
//! nothing itself, so it has no loading, failure or gate: the page is its words.

use centraid_api_proto::core_v1 as wire;

use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, reads as words};

/// A sentence in a locale.
pub type Words = fn(Locale) -> String;

/// ONE APP'S READS, as the parameter the one page takes.
pub struct ReadsSpec {
    /// `notes`: the app, and the prefix of the screen name `notes.reads`.
    pub app: &'static str,
    /// The app's name ("Notes"): the title says what it may read and the back control names it.
    pub name: Words,
    /// What the app reads, as kinds: "notes, notebooks, people, ...".
    pub reads: Words,
    /// What the app writes.
    pub writes: Words,
}

/// The registry factory for `spec`'s screen.
#[must_use]
pub fn build(spec: &'static ReadsSpec) -> Option<Box<dyn Screen>> {
    Some(Box::new(Reads { spec }))
}

/// `<app>.reads` as the route a More row carries.
#[must_use]
pub fn route(screen: &str) -> wire::Route {
    wire::Route {
        screen: screen.to_owned(),
        sheet: false,
        args: Some(wire::route::Args::Reads(wire::ReadsRoute {})),
    }
}

/// The page's title: "What Notes may read". The More row says the same.
#[must_use]
pub fn title(locale: Locale, name: &str) -> String {
    fill(&words::title(locale), &[("app", name)])
}

struct Reads {
    spec: &'static ReadsSpec,
}

impl Screen for Reads {
    fn update(&mut self, _event: wire::ScreenEvent, _ctx: &Ctx) -> Vec<wire::Effect> {
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let name = (self.spec.name)(locale);
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Reads(wire::ReadsView {
                app_id: self.spec.app.to_owned(),
                title: title(locale, &name),
                back_label: name,
                facts: vec![
                    wire::ReadsFact {
                        label: words::label_reads(locale),
                        detail: (self.spec.reads)(locale),
                    },
                    wire::ReadsFact {
                        label: words::label_writes(locale),
                        detail: (self.spec.writes)(locale),
                    },
                ],
            })),
            ..wire::ViewState::default()
        }
    }
}
