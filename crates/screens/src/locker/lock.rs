//! THE WALL AS A PAGE (`locker.lock`): what a caller outside Locker pushes when
//! it needs the key — chat's confirm card that seals a typed secret. It asks the
//! owner check on appearing and sets `finished` once the Locker is open, so the
//! shell pops it; the caller then reads the session, not this page. A member who
//! cancels is left on the wall with its button and the way back.

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;

use super::wall::{Change, Wall};
use crate::screen::{Ctx, Screen};
use crate::strings::locker as words;

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Lock {
        wall: Wall::default(),
        finished: false,
    }))
}

struct Lock {
    wall: Wall,
    finished: bool,
}

impl Lock {
    fn walled(&mut self, step: super::wall::Step) -> Vec<wire::Effect> {
        match step.change {
            Change::Opened => self.finished = true,
            Change::Closed => self.finished = false,
            Change::None => {}
        }
        step.effects
    }
}

impl Screen for Lock {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            // ASKING IS THE POINT OF THE PAGE: the check is raised at once.
            Some(E::Appeared(_)) => {
                let step = self.wall.appeared(ctx, true);
                self.walled(step)
            }
            Some(E::LockerWall(wall)) => {
                let step = self.wall.event(ctx, wall);
                self.walled(step)
            }
            Some(E::Lifecycle(lifecycle)) => {
                let step = self.wall.lifecycle(ctx, lifecycle.foreground);
                self.walled(step)
            }
            Some(E::EffectResult(result)) => {
                let step = self.wall.answered(ctx, &result);
                self.walled(step)
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        wire::ViewState {
            kind: Some(wire::view_state::Kind::LockerLock(wire::LockerLockState {
                wall: self.wall.view(locale),
                secure: self.wall.is_open(),
                finished: self.finished,
                open: self.wall.is_open(),
                close_label: words::close(locale),
            })),
            ..wire::ViewState::default()
        }
    }
}
