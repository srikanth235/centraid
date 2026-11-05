//! One inline remedy for the device notification service; writes keep priority.
use crate::{
    Ctx,
    strings::{Locale, task},
};
use centraid_api_proto::core_v1 as wire;

pub const DENIED: &str = "agenda.notifications.denied";
pub const FAILED: &str = "agenda.notifications.failed";
pub const READY: &str = "agenda.notifications.ready";
pub const RETRY: &str = "agenda.notifications.retry";

#[derive(Clone, Copy, Default)]
pub struct Status {
    denied: bool,
    failed: bool,
}
impl Status {
    pub fn hear(&mut self, topic: &str) {
        match topic {
            DENIED => {
                self.denied = true;
                self.failed = false;
            }
            FAILED => {
                self.failed = true;
                self.denied = false;
            }
            READY => {
                self.failed = false;
                self.denied = false;
            }
            _ => {}
        }
    }
    pub fn active(&self) -> bool {
        self.denied || self.failed
    }
    pub fn view(&self, locale: Locale) -> Option<wire::StatusLine> {
        self.active().then(|| wire::StatusLine {
            sentence: if self.denied {
                task::notification_denied(locale)
            } else {
                task::notification_failed(locale)
            },
            action_label: if self.denied {
                task::notification_settings(locale)
            } else {
                crate::strings::shared::kit_retry(locale)
            },
            refused: true,
        })
    }
    pub fn act(&self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.denied {
            vec![wire::Effect {
                kind: Some(wire::effect::Kind::VaultCommand(wire::VaultCommand {
                    kind: Some(wire::vault_command::Kind::Open(
                        wire::home_status::Destination::Notifications as i32,
                    )),
                })),
            }]
        } else if self.failed {
            ctx.post(
                crate::notifications::NAME,
                wire::ScreenEvent {
                    kind: Some(wire::screen_event::Kind::Announced(wire::Announced {
                        topic: RETRY.into(),
                    })),
                },
            );
            Vec::new()
        } else {
            Vec::new()
        }
    }
}
