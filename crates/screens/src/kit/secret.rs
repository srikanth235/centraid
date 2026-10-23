//! A SECRET ON SCREEN OR ON THE CLIPBOARD, and what ends each (#1135).
//!
//! The one piece every screen that shows a sealed value uses — Locker's item
//! page today, chat's inline reveal in wave 4. It owns four things so no screen
//! restates them:
//!
//! - **A shown value lives for a while.** [`Secrets::show`] keeps the plaintext
//!   in this struct (never in a log, never in `Debug`), starts an auto-hide
//!   timer, and raises the screenshot shield; the timer or [`Secrets::hide`]
//!   drops the value and, when it was the last one, the shield.
//! - **A copied value is sensitive and has a deadline.** [`Secrets::copy`] sends
//!   `ClipboardSet { sensitive, clear_after_ms }`. The Rust timer answers with a
//!   `ClipboardClear` naming the text it set (the shell clears only if the
//!   clipboard still holds it). The deadline rides the effect because a screen's
//!   timers die with the screen and with the process: a shell persists the
//!   deadline beside the clip and clears a stale clip on its next launch (the
//!   bug where a revealed secret outlived a killed Android app).
//! - **A failed copy leaves nothing to clear.**
//! - **A screen that is left drops everything it showed.** `Left` discards its
//!   effects, so the shield falls with the view and the clip with the shell's
//!   persisted deadline; [`Secrets::conceal`] empties the memory.

use std::collections::BTreeMap;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;

use crate::screen::Ctx;

const CLIP_TIMER: &str = "secret-clip";
const HIDE_TIMER: &str = "secret-hide:";

/// What a screen holds of secrets: the values it shows, and the text it put on
/// the clipboard.
#[derive(Default)]
pub struct Secrets {
    shown: BTreeMap<String, String>,
    shielded: bool,
    copied: Option<String>,
    /// The screen's own view already shields capture for as long as it is open
    /// (Locker's whole-app `secure` flag), so no shield effect is sent.
    view_shields: bool,
}

// A derived `Debug` would print the plaintext into a log line.
impl std::fmt::Debug for Secrets {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Secrets")
            .field("shown", &self.shown.keys().collect::<Vec<_>>())
            .field("copied", &self.copied.is_some())
            .finish()
    }
}

fn effect(kind: wire::effect::Kind) -> wire::Effect {
    wire::Effect { kind: Some(kind) }
}

fn shield(on: bool) -> wire::Effect {
    effect(wire::effect::Kind::ScreenshotShield(
        wire::ScreenshotShield { on },
    ))
}

fn millis(after: Duration) -> u64 {
    u64::try_from(after.as_millis()).unwrap_or(u64::MAX)
}

impl Secrets {
    /// Secrets for a screen whose view carries its own capture shield: values
    /// still auto-hide and copies still clear, but no `ScreenshotShield` effect
    /// is sent (two owners of one flag would fight).
    #[must_use]
    pub fn view_shielded() -> Self {
        Self {
            view_shields: true,
            ..Self::default()
        }
    }

    /// Show `value` under `key` for `after`, then hide it. Raises the shield
    /// when nothing was shown yet. Showing the same key again restarts its life.
    pub fn show(
        &mut self,
        ctx: &Ctx,
        key: &str,
        value: &str,
        after: Duration,
    ) -> Vec<wire::Effect> {
        self.shown.insert(key.to_owned(), value.to_owned());
        ctx.start_timer(&format!("{HIDE_TIMER}{key}"), after);
        if self.shielded || self.view_shields {
            Vec::new()
        } else {
            self.shielded = true;
            vec![shield(true)]
        }
    }

    /// The value shown under `key`, if it is still on screen.
    #[must_use]
    pub fn value(&self, key: &str) -> Option<&str> {
        self.shown.get(key).map(String::as_str)
    }

    /// Whether anything is on screen (the view's own shield flag).
    #[must_use]
    pub fn any_shown(&self) -> bool {
        !self.shown.is_empty()
    }

    /// Hide `key` now. The shield falls when it was the last.
    pub fn hide(&mut self, ctx: &Ctx, key: &str) -> Vec<wire::Effect> {
        ctx.cancel_timer(&format!("{HIDE_TIMER}{key}"));
        self.drop_value(key)
    }

    /// Hide everything now (a lock, a relock).
    pub fn hide_all(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        for key in self.shown.keys() {
            ctx.cancel_timer(&format!("{HIDE_TIMER}{key}"));
        }
        self.shown.clear();
        self.lower_shield()
    }

    /// Put `text` on the clipboard as a secret, to be gone in `after`.
    pub fn copy(&mut self, ctx: &Ctx, text: &str, after: Duration) -> Vec<wire::Effect> {
        self.copied = Some(text.to_owned());
        ctx.start_timer(CLIP_TIMER, after);
        vec![effect(wire::effect::Kind::ClipboardSet(
            wire::ClipboardSet {
                text: text.to_owned(),
                sensitive: true,
                clear_after_ms: millis(after),
            },
        ))]
    }

    /// Clear the clipboard now, if this screen put a secret there.
    pub fn clear_clip(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        ctx.cancel_timer(CLIP_TIMER);
        self.take_clear()
    }

    /// A timer of this screen fired. Effects when it was one of ours.
    pub fn fired(&mut self, timer: &str) -> Vec<wire::Effect> {
        if timer == CLIP_TIMER {
            return self.take_clear();
        }
        match timer.strip_prefix(HIDE_TIMER) {
            Some(key) => self.drop_value(key),
            None => Vec::new(),
        }
    }

    /// The shell answered an effect. A failure of the copy leaves nothing to
    /// clear (the answer does not say which effect, and a failed shield changes
    /// nothing a timer needs).
    pub fn answered(&mut self, ctx: &Ctx, result: &wire::EffectResult) {
        if matches!(
            result.outcome,
            Some(wire::effect_result::Outcome::Failed(_))
        ) && self.copied.take().is_some()
        {
            ctx.cancel_timer(CLIP_TIMER);
        }
    }

    /// Forget every plaintext this screen holds. For `Left`: its effects are
    /// dropped, so the shield falls with the view and the clip with the shell's
    /// persisted deadline.
    pub fn conceal(&mut self) {
        self.shown.clear();
        self.shielded = false;
    }

    fn take_clear(&mut self) -> Vec<wire::Effect> {
        match self.copied.take() {
            Some(expected_text) => vec![effect(wire::effect::Kind::ClipboardClear(
                wire::ClipboardClear { expected_text },
            ))],
            None => Vec::new(),
        }
    }

    fn drop_value(&mut self, key: &str) -> Vec<wire::Effect> {
        self.shown.remove(key);
        self.lower_shield()
    }

    fn lower_shield(&mut self) -> Vec<wire::Effect> {
        if self.shown.is_empty() && self.shielded {
            self.shielded = false;
            vec![shield(false)]
        } else {
            Vec::new()
        }
    }
}
