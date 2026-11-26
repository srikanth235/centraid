//! THE HOME TAB'S ROOT: a page with nothing on it, until the shell frame fills it.

use centraid_api_proto::core_v1 as wire;

use crate::screen::{Ctx, Screen};

struct Home;

/// The registry factory.
#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Home))
}

impl Screen for Home {
    fn update(&mut self, _event: wire::ScreenEvent, _ctx: &Ctx) -> Vec<wire::Effect> {
        Vec::new()
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}
