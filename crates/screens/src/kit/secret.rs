//! A SECRET ON SCREEN OR ON THE CLIPBOARD, and what ends each (#1135).
//!
//! The one piece every screen that shows a sealed value uses — Locker's item
//! page and chat's card reveal (`chat/reveal.rs`). It owns four things so no screen
//! restates them:
//!
//! - **A shown value lives for a while.** [`Secrets::show`] keeps the plaintext
//!   in this struct (never in a log, never in `Debug`), starts an auto-hide
//!   timer, and raises the screenshot shield; the timer or [`Secrets::hide`]
//!   drops the value and, when it was the last one, the shield.
//! - **A copied value is sensitive and has a deadline.** [`Secrets::copy`] sends
//!   `ClipboardSet { sensitive, clear_after_ms, owner_vault_id }`. The OS owns the
//!   deadline; native expiry clears the item, while Rust sends
//!   `ClipboardClearOwned` for manual Lock or a vault switch. The shell persists
//!   only the owner vault, opaque marker, content digest and expiry metadata so
//!   a restarted app can clear only its own still-current item. The secret itself
//!   is never persisted by the shell.
//! - **A failed copy leaves nothing to clear.**
//! - **A Locker copy survives Back and app background, but not manual Lock.** A runtime-lifetime
//!   [`ClipboardBoard`] owns every copied Locker value (including a reveal in
//!   chat) in volatile, zeroizing memory until the original expiry or an
//!   explicit Lock. Back and background wipe screen state and forget the
//!   controller ticket; the runtime board's deadline remains. Controller
//!   cleanup is ticket-bound, while a manual Locker Lock always asks the shell to
//!   clear the latest copy owned by that vault, even after a process restart. The
//!   shell's ownership and generation check protects any unrelated or newer
//!   clipboard without reading it.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use centraid_api_proto::core_v1 as wire;
use zeroize::Zeroizing;

use crate::screen::Ctx;

const CLIP_TIMER: &str = "secret-clip";
const HIDE_TIMER: &str = "secret-hide:";

/// Runtime-lifetime ownership of Locker's latest copied secret.
///
/// The value is volatile and omitted from Debug. Its vault binding prevents an old owner from
/// clearing a different vault's clipboard, while the ticket makes late copy failures and timers
/// harmless after a newer copy replaced it.
#[derive(Clone, Default)]
pub(crate) struct ClipboardBoard(Arc<Mutex<ClipboardInner>>);

#[derive(Default)]
struct ClipboardInner {
    next_ticket: u64,
    owner: Option<OwnedClipboard>,
}

struct OwnedClipboard {
    vault: String,
    ticket: u64,
    expected: Zeroizing<String>,
    deadline: Instant,
}

impl std::fmt::Debug for ClipboardBoard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let held = self.lock();
        let owner = held.owner.as_ref();
        formatter
            .debug_struct("ClipboardBoard")
            .field("owned", &owner.is_some())
            .field("ticket", &owner.map(|owner| owner.ticket))
            .finish()
    }
}

impl ClipboardBoard {
    fn lock(&self) -> std::sync::MutexGuard<'_, ClipboardInner> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn set(&self, vault: &str, text: &str, deadline: Instant) -> u64 {
        let mut held = self.lock();
        held.next_ticket = held.next_ticket.wrapping_add(1).max(1);
        let ticket = held.next_ticket;
        held.owner = Some(OwnedClipboard {
            vault: vault.to_owned(),
            ticket,
            expected: Zeroizing::new(text.to_owned()),
            deadline,
        });
        ticket
    }

    pub(crate) fn deadline(&self) -> Option<(u64, Instant)> {
        self.lock()
            .owner
            .as_ref()
            .map(|owner| (owner.ticket, owner.deadline))
    }

    pub(crate) fn ticket_for(&self, vault: &str, text: &str) -> Option<u64> {
        self.lock().owner.as_ref().and_then(|owner| {
            (owner.vault == vault && owner.expected.as_str() == text).then_some(owner.ticket)
        })
    }

    pub(crate) fn clear(&self, vault: &str) -> Vec<wire::Effect> {
        let mut held = self.lock();
        if held
            .owner
            .as_ref()
            .is_some_and(|owner| owner.vault == vault)
        {
            held.owner.take();
            return vec![clipboard_clear_owned(vault)];
        }
        Vec::new()
    }

    pub(crate) fn failed(&self, vault: &str, ticket: u64) -> bool {
        let mut held = self.lock();
        if held
            .owner
            .as_ref()
            .is_some_and(|owner| owner.vault == vault && owner.ticket == ticket)
        {
            held.owner.take();
            return true;
        }
        false
    }

    pub(crate) fn expire(&self, ticket: u64, now: Instant) -> Vec<wire::Effect> {
        let mut held = self.lock();
        // Native clipboard expiry owns OS cleanup. This timer only releases the core's volatile
        // record, so a late wake can never clear a newer item with the same text.
        if held
            .owner
            .as_ref()
            .is_some_and(|owner| owner.ticket == ticket && owner.deadline <= now)
        {
            held.owner.take();
        }
        Vec::new()
    }
}

pub(crate) fn clipboard_clear_owned(vault_id: &str) -> wire::Effect {
    effect(wire::effect::Kind::ClipboardClearOwned(
        wire::ClipboardClearOwned {
            vault_id: vault_id.to_owned(),
        },
    ))
}

/// What a screen holds of secrets: the values it shows, and the text it put on
/// the clipboard.
#[derive(Default)]
pub struct Secrets {
    shown: BTreeMap<String, String>,
    shielded: bool,
    /// The shared board owns Locker copies; the screen keeps only a generation ticket.
    clipboard_ticket: Option<u64>,
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
            .field("copied", &self.clipboard_ticket.is_some())
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
        let vault = ctx.foreground_vault_id();
        self.clipboard_ticket = Some(ctx.clipboard().set(&vault, text, Instant::now() + after));
        ctx.start_timer(CLIP_TIMER, after);
        vec![effect(wire::effect::Kind::ClipboardSet(
            wire::ClipboardSet {
                text: text.to_owned(),
                sensitive: true,
                clear_after_ms: millis(after),
                owner_vault_id: vault,
            },
        ))]
    }

    /// Clear the latest Locker owner when the Locker itself locks, even if another
    /// reveal controller (or no screen) originally copied it.
    pub fn clear_clip_on_lock(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        ctx.cancel_timer(CLIP_TIMER);
        self.clipboard_ticket = None;
        let vault = ctx.foreground_vault_id();
        ctx.clipboard().clear(&vault);
        vec![clipboard_clear_owned(&vault)]
    }

    /// A timer of this screen fired. Copy expiry releases volatile ownership; native expiry
    /// clears the clipboard. Reveal expiry drops the shown value and its shield.
    pub fn fired(&mut self, timer: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        if timer == CLIP_TIMER {
            return self
                .clipboard_ticket
                .take()
                .map_or_else(Vec::new, |ticket| {
                    ctx.clipboard().expire(ticket, Instant::now())
                });
        }
        match timer.strip_prefix(HIDE_TIMER) {
            Some(key) => self.drop_value(key),
            None => Vec::new(),
        }
    }

    /// The shell answered an effect. A failure of the copy leaves nothing to
    /// clear (the answer does not say which effect, and a failed shield changes
    /// nothing a timer needs).
    pub fn answered(&mut self, _ctx: &Ctx, _result: &wire::EffectResult) {
        // Runtime routes a failed ClipboardSet by its effect id. An unrelated failure must
        // not release ownership of a copy that may still be on the OS clipboard.
    }

    /// Forget plaintext shown by this controller. For `Left`, its clipboard
    /// ticket is dropped while the runtime-owned deadline and shell lease remain.
    pub fn conceal(&mut self) {
        self.shown.clear();
        self.shielded = false;
        self.clipboard_ticket = None;
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

#[cfg(test)]
mod clipboard_tests {
    use super::{ClipboardBoard, wire};
    use std::time::{Duration, Instant};

    #[test]
    fn explicit_lock_clears_only_the_latest_copy_for_its_vault() {
        let board = ClipboardBoard::default();
        let deadline = Instant::now() + Duration::from_secs(30);
        board.set("vault-a", "first-secret", deadline);
        board.set("vault-a", "latest-secret", deadline);

        let effects = board.clear("vault-a");

        assert!(matches!(
            effects.first().and_then(|effect| effect.kind.as_ref()),
            Some(wire::effect::Kind::ClipboardClearOwned(clear))
                if clear.vault_id == "vault-a"
        ));
        assert!(board.deadline().is_none());
    }

    #[test]
    fn a_replaced_or_different_vault_owner_is_not_cleared_by_a_late_failure() {
        let board = ClipboardBoard::default();
        let deadline = Instant::now() + Duration::from_secs(30);
        let stale = board.set("vault-a", "old-secret", deadline);
        assert_eq!(board.clear("vault-a").len(), 1);
        let current = board.set("vault-a", "new-secret", deadline);
        assert_ne!(current, stale, "tickets are monotonic across owner removal");
        assert!(!board.failed("vault-a", stale));
        assert!(board.expire(stale, deadline).is_empty());
        assert_eq!(board.deadline().map(|(ticket, _)| ticket), Some(current));
        assert!(board.clear("vault-b").is_empty());
        let effects = board.clear("vault-a");
        let Some(wire::effect::Kind::ClipboardClearOwned(clear)) =
            effects.first().and_then(|effect| effect.kind.as_ref())
        else {
            panic!("the clear names its Locker vault owner");
        };
        assert_eq!(clear.vault_id, "vault-a");
    }

    #[test]
    fn failure_of_the_current_copy_releases_only_its_volatile_owner() {
        let board = ClipboardBoard::default();
        let deadline = Instant::now() + Duration::from_secs(30);
        let ticket = board.set("vault-a", "failed-secret", deadline);

        assert!(board.failed("vault-a", ticket));
        assert!(board.deadline().is_none());
        assert!(!board.failed("vault-a", ticket));
        assert!(board.expire(ticket, deadline).is_empty());
        assert!(board.deadline().is_none());
        assert!(!format!("{board:?}").contains("failed-secret"));
    }

    #[test]
    fn native_deadline_expires_after_the_screen_ticket_is_dropped_and_releases_only_volatile_owner()
    {
        let board = ClipboardBoard::default();
        let start = Instant::now();
        let deadline = start + Duration::from_secs(30);
        // After the screen is popped, its ticket remains with the runtime-owned timer; native
        // expiry owns the actual pasteboard cleanup.
        let ticket = board.set("vault-a", "popped-secret", deadline);

        assert!(board.expire(ticket, start).is_empty());
        assert!(board.expire(ticket, deadline).is_empty());
        assert!(board.deadline().is_none());
    }

    #[test]
    fn clipboard_debug_never_contains_the_secret() {
        let board = ClipboardBoard::default();
        board.set(
            "vault-a",
            "private-synthetic-value",
            Instant::now() + Duration::from_secs(30),
        );
        assert!(!format!("{board:?}").contains("private-synthetic-value"));
    }
}
