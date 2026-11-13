//! THE REVEAL CONTROLLER, ONE FOR EVERY SCREEN THAT SHOWS A SEALED VALUE (#1188).
//!
//! Locker's item page and chat's card both reveal through this piece, so the rules are
//! stated once: the core stamps the item as used before the value exists; the value lives in
//! [`Secrets`] for the core's window with a countdown and is gone on Conceal, on the timer, on a
//! relock and on leave; **Copy** is a reveal whose value goes to the clipboard and never onto the
//! screen; a one-time-code seed is never revealed, only the code it makes now (followed once when
//! it rolls while shown); a passkey's key has no verb. The caller owns the wall, the words a
//! refusal is said in and which item the keys name.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;

use super::shared::{self, Opened, Refused};
use super::wall::CLIPBOARD_LIFE;
use crate::kit::secret::Secrets;
use crate::screen::Ctx;
use crate::strings::{Locale, fill, locker as words};

/// The product's reveal window, in seconds (`REVEAL_WINDOW_MS`).
const REVEAL_SECONDS: u32 = 30;

pub(super) const DOTS: &str = "••••••••••";
const CODE_MASK: &str = "••• •••";
/// The timer a shown value counts down on.
pub(crate) const TICK: &str = "tick";

/// A revealed value's life: what the screen counts down.
struct Shown {
    column: String,
    seconds_left: u32,
    /// A one-time code: its step, and whether the roll is followed once.
    code: Option<Code>,
}

struct Code {
    period: u32,
    follow: bool,
}

/// What a reveal, a copy or a code came to.
pub(crate) enum Outcome {
    /// The value is on screen; these effects raise the shield.
    Shown(Vec<wire::Effect>),
    /// The value went to the clipboard, sensitive and with a deadline; never to the screen.
    Copied(Vec<wire::Effect>),
    /// Idle ended the session under the screen: the wall is the answer.
    Locked,
    /// Any other refusal, in the member's words.
    Refused(String),
}

pub(crate) struct Reveal {
    secrets: Secrets,
    shown: Option<Shown>,
}

impl Reveal {
    /// `view_shielded`: the screen's own view already shields capture while it is open
    /// (Locker's whole-page `secure` flag), so no shield effect is sent.
    #[must_use]
    pub(crate) fn new(view_shielded: bool) -> Self {
        Self {
            secrets: if view_shielded {
                Secrets::view_shielded()
            } else {
                Secrets::default()
            },
            shown: None,
        }
    }

    /// The plaintext on screen under `key`, if it still is.
    #[must_use]
    pub(crate) fn value(&self, key: &str) -> Option<&str> {
        self.secrets.value(key)
    }

    /// Whether `key` shows a one-time code now.
    #[must_use]
    pub(crate) fn shows_code(&self, key: &str) -> bool {
        self.shown_code(key).is_some()
    }

    /// The column a value is shown for, if any is.
    #[must_use]
    pub(crate) fn column(&self) -> Option<&str> {
        self.shown.as_ref().map(|shown| shown.column.as_str())
    }

    fn shown_code(&self, key: &str) -> Option<&Shown> {
        self.shown
            .as_ref()
            .filter(|shown| shown.column == key && shown.code.is_some())
    }

    /// Reveal (or, with `copy`, copy) one sealed cell, or a custom field's value (`field:<id>`).
    pub(crate) fn reveal(&mut self, ctx: &Ctx, item_id: &str, key: &str, copy: bool) -> Outcome {
        let field_id = key.strip_prefix(super::item::FIELD).unwrap_or("");
        match shared::reveal(ctx, item_id, key, field_id, copy, 0) {
            Err(Refused::Locked) => Outcome::Locked,
            Err(Refused::Said(sentence)) => Outcome::Refused(sentence),
            Ok(Opened { value, .. }) if copy => {
                Outcome::Copied(self.secrets.copy(ctx, &value, CLIPBOARD_LIFE))
            }
            Ok(Opened { value, life }) => {
                let mut effects = self.hide_all(ctx);
                let seconds = u32::try_from(life.as_secs())
                    .unwrap_or(REVEAL_SECONDS)
                    .clamp(1, REVEAL_SECONDS);
                effects.extend(self.secrets.show(
                    ctx,
                    key,
                    &value,
                    Duration::from_secs(u64::from(seconds)),
                ));
                self.shown = Some(Shown {
                    column: key.to_owned(),
                    seconds_left: seconds,
                    code: None,
                });
                ctx.start_timer(TICK, Duration::from_secs(1));
                Outcome::Shown(effects)
            }
        }
    }

    /// The code the seed makes now: shown with its life, or copied.
    pub(crate) fn code(
        &mut self,
        ctx: &Ctx,
        item_id: &str,
        key: &str,
        copy: bool,
        follow: bool,
    ) -> Outcome {
        let field_id = key.strip_prefix(super::item::FIELD).unwrap_or("");
        match shared::totp(ctx, item_id, field_id, copy) {
            Err(Refused::Locked) => Outcome::Locked,
            Err(Refused::Said(sentence)) => Outcome::Refused(sentence),
            Ok(code) if copy => Outcome::Copied(self.secrets.copy(
                ctx,
                &code.code,
                Duration::from_secs(u64::from(code.remaining)),
            )),
            Ok(code) => {
                let mut effects = self.hide_all(ctx);
                // The kit's own hide is the safety net a second past the roll, after the tick
                // that follows it.
                effects.extend(self.secrets.show(
                    ctx,
                    key,
                    &code.code,
                    Duration::from_secs(u64::from(code.remaining) + 1),
                ));
                self.shown = Some(Shown {
                    column: key.to_owned(),
                    seconds_left: code.remaining,
                    code: Some(Code {
                        period: code.period,
                        follow,
                    }),
                });
                ctx.start_timer(TICK, Duration::from_secs(1));
                Outcome::Shown(effects)
            }
        }
    }

    /// A SHOWN VALUE COPIES WITHOUT A SECOND STAMP: it is already revealed, and the item already
    /// says it was used. A shown code lives on the clipboard only as long as it is good.
    pub(crate) fn copy_shown(&mut self, ctx: &Ctx, key: &str) -> Option<Vec<wire::Effect>> {
        let value = self.secrets.value(key)?.to_owned();
        let life = if self.shows_code(key) {
            let left = self.shown.as_ref().map_or(1, |shown| shown.seconds_left);
            Duration::from_secs(u64::from(left.max(1)))
        } else {
            CLIPBOARD_LIFE
        };
        Some(self.secrets.copy(ctx, &value, life))
    }

    /// Hide `key` now.
    pub(crate) fn conceal(&mut self, ctx: &Ctx, key: &str) -> Vec<wire::Effect> {
        self.shown = None;
        ctx.cancel_timer(TICK);
        self.secrets.hide(ctx, key)
    }

    /// Hide everything now (a relock, a leave of the thread).
    pub(crate) fn hide_all(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.shown = None;
        ctx.cancel_timer(TICK);
        self.secrets.hide_all(ctx)
    }

    /// A RELOCK IS A WIPE: nothing shown, nothing left on the clipboard.
    pub(crate) fn wipe(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let mut effects = self.hide_all(ctx);
        effects.extend(self.secrets.clear_clip(ctx));
        effects
    }

    /// LEAVING CONCEALS: the screen's effects are dropped with it, so only memory is emptied.
    pub(crate) fn leave(&mut self, ctx: &Ctx) {
        ctx.cancel_timer(TICK);
        self.secrets.conceal();
        self.shown = None;
    }

    /// The shell answered an effect (a failed copy leaves nothing to clear).
    pub(crate) fn answered(&mut self, ctx: &Ctx, result: &wire::EffectResult) {
        self.secrets.answered(ctx, result);
    }

    /// A timer other than the tick fired. Effects when it was this controller's.
    pub(crate) fn fired(&mut self, timer: &str) -> Vec<wire::Effect> {
        let effects = self.secrets.fired(timer);
        if self.shown.as_ref().is_some_and(|shown| {
            self.secrets.value(&shown.column).is_none() && shown.code.is_none()
        }) {
            self.shown = None;
        }
        effects
    }

    /// One second of a shown value's life; at zero it is concealed — or, for a code shown first,
    /// the next code is asked for once. `item_id` is the item the shown key belongs to.
    pub(crate) fn tick(&mut self, ctx: &Ctx, item_id: &str) -> Vec<wire::Effect> {
        let Some(shown) = &mut self.shown else {
            return Vec::new();
        };
        if self.secrets.value(&shown.column).is_none() {
            self.shown = None;
            return Vec::new();
        }
        shown.seconds_left = shown.seconds_left.saturating_sub(1);
        if shown.seconds_left > 0 {
            ctx.start_timer(TICK, Duration::from_secs(1));
            return Vec::new();
        }
        let follow = shown.code.as_ref().is_some_and(|code| code.follow);
        let column = shown.column.clone();
        self.shown = None;
        let mut effects = self.secrets.hide(ctx, &column);
        if follow && let Outcome::Shown(next) = self.code(ctx, item_id, &column, false, false) {
            effects.extend(next);
        }
        effects
    }

    /// A SEALED VALUE'S ROW — an item cell, or a custom field: the mask with Reveal and Copy (and
    /// `more`, a field's Edit), revealed with Copy and Conceal and its countdown.
    pub(crate) fn sealed_row(
        &self,
        locale: Locale,
        key: &str,
        label: String,
        more: &[wire::LockerVerb],
    ) -> wire::LockerFieldRow {
        if let (Some(value), Some(shown)) = (
            self.secrets.value(key),
            self.shown.as_ref().filter(|shown| shown.column == key),
        ) {
            return wire::LockerFieldRow {
                key: key.to_owned(),
                label: label.clone(),
                value: value.to_owned(),
                sealed: true,
                revealed: true,
                note: fill(
                    &words::revealed_note(locale),
                    &[("seconds", &shown.seconds_left.to_string())],
                ),
                verbs: vec![
                    verb("copy", words::copy(locale)),
                    verb("conceal", words::conceal(locale)),
                ],
                accessibility_label: format!("{label}, {}", words::revealed(locale)),
                monospace: true,
                ..wire::LockerFieldRow::default()
            };
        }
        let mut verbs = vec![
            verb("reveal", words::reveal(locale)),
            verb("copy", words::copy(locale)),
        ];
        verbs.extend(more.iter().cloned());
        wire::LockerFieldRow {
            key: key.to_owned(),
            label: label.clone(),
            sealed: true,
            mask: DOTS.to_owned(),
            note: words::sealed_note(locale),
            verbs,
            accessibility_label: format!("{label}, {}", words::sealed(locale)),
            monospace: true,
            ..wire::LockerFieldRow::default()
        }
    }

    /// A ONE-TIME CODE'S ROW: the code, grouped, with its seconds and a countdown while shown; a
    /// mask with Show code and Copy code otherwise.
    pub(crate) fn code_row(
        &self,
        locale: Locale,
        key: &str,
        label: String,
        more: &[wire::LockerVerb],
    ) -> wire::LockerFieldRow {
        if let (Some(code), Some(shown)) = (self.secrets.value(key), self.shown_code(key)) {
            let grouped = if code.chars().count() == 6 {
                format!(
                    "{} {}",
                    code.chars().take(3).collect::<String>(),
                    code.chars().skip(3).collect::<String>()
                )
            } else {
                code.to_owned()
            };
            return wire::LockerFieldRow {
                key: key.to_owned(),
                label: label.clone(),
                value: grouped.clone(),
                sealed: true,
                revealed: true,
                note: fill(
                    &words::code_note(locale),
                    &[("seconds", &shown.seconds_left.to_string())],
                ),
                verbs: vec![
                    verb("copy_code", words::copy(locale)),
                    verb("conceal", words::conceal(locale)),
                ],
                accessibility_label: format!("{label}, {grouped}"),
                monospace: true,
                countdown: Some(wire::LockerCountdown {
                    seconds_left: shown.seconds_left,
                    period: shown.code.as_ref().map_or(0, |code| code.period),
                }),
                ..wire::LockerFieldRow::default()
            };
        }
        let mut verbs = vec![
            verb("code", words::show_code(locale)),
            verb("copy_code", words::copy_code(locale)),
        ];
        verbs.extend(more.iter().cloned());
        wire::LockerFieldRow {
            key: key.to_owned(),
            label: label.clone(),
            sealed: true,
            mask: CODE_MASK.to_owned(),
            note: words::otp_note(locale),
            verbs,
            accessibility_label: format!("{label}, {}", words::sealed(locale)),
            monospace: true,
            ..wire::LockerFieldRow::default()
        }
    }
}

pub(super) fn verb(key: &str, label: String) -> wire::LockerVerb {
    wire::LockerVerb {
        key: key.to_owned(),
        label,
        // THE VERIFICATION CODE'S COPY is the card's one pill, as the board draws it.
        pill: key == "copy_code",
    }
}
