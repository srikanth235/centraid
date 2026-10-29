//! THE LOCK WALL (#1047, D-5), as every Locker screen's own piece.
//!
//! D-5 rules the gesture: the phone's owner check (biometric, the device
//! passcode as fallback), a relock the instant Centraid leaves the foreground,
//! no Locker passphrase. The SESSION is the core's (`LockerSessionRequest`);
//! this piece owns the five phases of the wall and every word on it, and asks
//! the shell for the one thing it cannot do — the OS prompt — as the generic
//! `OwnerCheck` effect.
//!
//! **The OS saying yes is not the Locker opening.** A passed check moves to
//! UNLOCKING and asks the core to open its session; only the core's answer opens
//! the screen. A core that could not load `K` leaves the member at FAILED with
//! its sentence, never at an open Locker that then refuses every reveal.
//!
//! **Every screen carries a wall and consults the same session**, so there is no
//! process-wide gate object to bind: Home asks on entering, any other screen
//! shows the wall with its button when the session ended under it, and a screen
//! that finds the session already open (another screen unlocked it) simply
//! opens.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;

use crate::kit::civil;
use crate::screen::Ctx;
use crate::strings::{Locale, fill, locker as words};

/// Which phase the wall is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Locked,
    /// The owner check is up, or the core is opening the session.
    Unlocking,
    Unavailable,
    Failed,
    Open,
}

/// What a wall step did to the screen under it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Change {
    #[default]
    None,
    /// The session just opened: read what the screen shows.
    Opened,
    /// The session just ended: forget everything the screen held.
    Closed,
}

/// A wall step's result: what the shell is asked to do, and what changed.
#[derive(Default)]
pub struct Step {
    pub effects: Vec<wire::Effect>,
    pub change: Change,
}

impl Step {
    fn change(change: Change) -> Self {
        Self {
            effects: Vec::new(),
            change,
        }
    }

    fn ask(effects: Vec<wire::Effect>) -> Self {
        Self {
            effects,
            change: Change::None,
        }
    }
}

/// The wall of one screen.
pub struct Wall {
    phase: Phase,
    /// A passcode is set on this phone. Assumed until the shell says otherwise.
    available: bool,
    /// The core holds this vault's keys, so an unlock can succeed.
    keyed: bool,
    biometry: wire::Biometry,
    /// The sentence a FAILED or LOCKED wall says.
    notice: String,
    /// An owner check is out and its answer is awaited.
    asking: bool,
    /// A probe (no prompt) is out.
    probing: bool,
    /// The unlocks the phone refused, as the core last answered them (#1146):
    /// the locked wall says them, and after an unlock they are what that unlock
    /// cleared, which the Locker's home says once.
    failed: Failed,
}

/// The refused unlocks one session answer carried.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Failed {
    count: u32,
    day: String,
    time: String,
}

impl Failed {
    fn of(answer: &wire::LockerSessionResponse) -> Self {
        Self {
            count: answer.failed_unlocks,
            day: answer.failed_unlock_local_day.clone(),
            time: answer.failed_unlock_local_time.clone(),
        }
    }
}

/// Whether an owner check's outcome is the phone REFUSING the member: not
/// recognised, or locked out after too many tries. A dismissal is not one, and
/// neither is a phone with no passcode (#1146).
#[must_use]
pub fn is_refusal(outcome: wire::owner_checked::Outcome) -> bool {
    use wire::owner_checked::Outcome as O;
    matches!(outcome, O::Failed | O::LockedOut)
}

/// Tell the core the phone refused an unlock, so it counts and dates it. The
/// core never sees the OS prompt, so this report is the only way it learns of a
/// failure. `None` when the core would not take it; the member's wall is no
/// worse for that.
pub fn report_refusal(ctx: &Ctx) -> Option<wire::LockerSessionResponse> {
    Wall::session(
        ctx,
        wire::locker_session_request::Step::UnlockFailed(wire::LockerUnlockFailed {
            tz: ctx.zone().to_owned(),
        }),
    )
    .ok()
}

impl Default for Wall {
    fn default() -> Self {
        Self {
            phase: Phase::Locked,
            available: true,
            keyed: true,
            biometry: wire::Biometry::Unspecified,
            notice: String::new(),
            asking: false,
            probing: false,
            failed: Failed::default(),
        }
    }
}

fn effect(kind: wire::effect::Kind) -> wire::Effect {
    wire::Effect { kind: Some(kind) }
}

impl Wall {
    /// The Locker is open: this screen may read and show.
    #[must_use]
    pub fn is_open(&self) -> bool {
        self.phase == Phase::Open
    }

    fn session(
        ctx: &Ctx,
        step: wire::locker_session_request::Step,
    ) -> Result<wire::LockerSessionResponse, String> {
        ctx.locker(&wire::LockerSessionRequest { step: Some(step) })
            .map_err(|error| error.sentence())
    }

    fn state(ctx: &Ctx) -> Option<wire::LockerSessionResponse> {
        Self::session(
            ctx,
            wire::locker_session_request::Step::State(wire::LockerStateAsk {
                tz: ctx.zone().to_owned(),
            }),
        )
        .ok()
    }

    fn open_state(answer: &wire::LockerSessionResponse) -> bool {
        answer.state == wire::LockerSessionState::Unlocked as i32
    }

    /// Remember the refused unlocks a LOCKED answer carries. An open answer
    /// carries none (an unlock cleared them), and what that unlock cleared is
    /// kept for the home to say.
    fn see_failures(&mut self, answer: &wire::LockerSessionResponse) {
        if !Self::open_state(answer) {
            self.failed = Failed::of(answer);
        }
    }

    /// "3 failed unlocks · last 12 Oct 14:05" — what the phone refused since the
    /// last unlock it allowed, or what the unlock just now cleared; `None` when
    /// it refused none (#1146).
    #[must_use]
    pub fn failures_line(&self, locale: Locale) -> Option<String> {
        (self.failed.count > 0).then(|| {
            let day = if self.failed.day.len() >= 10 {
                civil::day_month(locale, &self.failed.day)
            } else {
                String::new()
            };
            let when = [day, self.failed.time.clone()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            fill(
                &words::lock_failed_unlocks(locale, u64::from(self.failed.count)),
                &[("when", &when)],
            )
        })
    }

    /// The screen came into view. `enter` is the member opening Locker (its
    /// tile): a locked wall raises the owner check at once, so opening Locker IS
    /// the ask. Any other screen reads the session and, when it is locked,
    /// probes what the phone can do and waits for a tap.
    pub fn appeared(&mut self, ctx: &Ctx, enter: bool) -> Step {
        let Some(answer) = Self::state(ctx) else {
            return Step::ask(Vec::new());
        };
        self.keyed = answer.keyed;
        self.see_failures(&answer);
        if Self::open_state(&answer) {
            let changed = self.phase != Phase::Open;
            self.phase = Phase::Open;
            return Step::change(if changed {
                Change::Opened
            } else {
                Change::None
            });
        }
        if !self.keyed {
            self.phase = Phase::Unavailable;
            return Step::ask(Vec::new());
        }
        if enter {
            return self.ask(ctx);
        }
        self.phase = Phase::Locked;
        self.probing = true;
        Step::ask(vec![self.check(false, ctx.locale())])
    }

    /// Re-read the session. A locked screen does this on any event: another
    /// screen may have opened the Locker since, and an open one finds out here
    /// that idle ended its session.
    pub fn recheck(&mut self, ctx: &Ctx) -> Step {
        let Some(answer) = Self::state(ctx) else {
            return Step::ask(Vec::new());
        };
        self.keyed = answer.keyed;
        self.see_failures(&answer);
        match (self.phase, Self::open_state(&answer)) {
            (Phase::Open, true) | (Phase::Unlocking, _) => Step::default(),
            (Phase::Open, false) => self.lock(words::lock_expired(ctx.locale())),
            (_, true) => {
                self.phase = Phase::Open;
                Step::change(Change::Opened)
            }
            (_, false) => Step::default(),
        }
    }

    /// An event for the wall itself.
    pub fn event(&mut self, ctx: &Ctx, event: wire::LockerWallEvent) -> Step {
        use wire::locker_wall_event::Kind as W;
        match event.kind {
            Some(W::Unlock(_)) => match self.phase {
                Phase::Locked | Phase::Failed | Phase::Unavailable => {
                    // Another screen may already have opened it: no prompt then.
                    let step = self.recheck(ctx);
                    if step.change == Change::Opened {
                        step
                    } else {
                        self.ask(ctx)
                    }
                }
                _ => Step::default(),
            },
            Some(W::Lock(_)) => {
                let _ = Self::session(
                    ctx,
                    wire::locker_session_request::Step::Relock(wire::LockerRelock {}),
                );
                // THE MEMBER LOCKED: no notice, the wall is the answer.
                let was_open = self.phase == Phase::Open;
                self.asking = false;
                if self.phase != Phase::Unavailable {
                    self.phase = Phase::Locked;
                }
                self.notice.clear();
                Step::change(if was_open {
                    Change::Closed
                } else {
                    Change::None
                })
            }
            None => Step::default(),
        }
    }

    /// Raise the owner check now.
    fn ask(&mut self, ctx: &Ctx) -> Step {
        if !self.keyed || !self.available {
            self.phase = Phase::Unavailable;
            return Step::default();
        }
        self.asking = true;
        self.phase = Phase::Unlocking;
        Step::ask(vec![self.check(true, ctx.locale())])
    }

    fn check(&self, ask: bool, locale: Locale) -> wire::Effect {
        effect(wire::effect::Kind::OwnerCheck(wire::OwnerCheck {
            ask,
            reason: words::prompt_reason(locale),
            title: words::prompt_title(locale),
            subtitle: words::prompt_subtitle(locale),
        }))
    }

    /// The shell answered an effect. `Step::default()` when it was not ours.
    pub fn answered(&mut self, ctx: &Ctx, result: &wire::EffectResult) -> Step {
        let checked = match &result.outcome {
            Some(wire::effect_result::Outcome::OwnerChecked(checked)) => *checked,
            Some(wire::effect_result::Outcome::Failed(_)) if self.asking => {
                // A shell that cannot raise the check leaves the wall to try again.
                self.asking = false;
                self.phase = Phase::Failed;
                self.notice = words::lock_failed_passcode(ctx.locale());
                return Step::default();
            }
            _ => return Step::default(),
        };
        self.available = checked.available;
        self.biometry = wire::Biometry::try_from(checked.biometry).unwrap_or_default();
        let outcome = wire::owner_checked::Outcome::try_from(checked.outcome).unwrap_or_default();
        if self.probing && outcome == wire::owner_checked::Outcome::NotAsked {
            self.probing = false;
            if !self.available && self.phase == Phase::Locked {
                self.phase = Phase::Unavailable;
            }
            return Step::default();
        }
        // AN ANSWER NOBODY IS ASKING FOR is a late one — the app went to the
        // background under the prompt.
        if !self.asking {
            return Step::default();
        }
        self.asking = false;
        if is_refusal(outcome)
            && let Some(answer) = report_refusal(ctx)
        {
            self.failed = Failed::of(&answer);
        }
        use wire::owner_checked::Outcome as O;
        match outcome {
            O::Succeeded => self.unlock(ctx),
            O::Cancelled => {
                self.phase = Phase::Locked;
                Step::default()
            }
            O::Unavailable => {
                self.available = false;
                self.phase = Phase::Unavailable;
                Step::default()
            }
            O::LockedOut => {
                self.phase = Phase::Failed;
                self.notice = words::lock_locked_out(ctx.locale());
                Step::default()
            }
            _ => {
                self.phase = Phase::Failed;
                self.notice = self.failed_sentence(ctx.locale());
                Step::default()
            }
        }
    }

    /// The passed check asks the core to open its session.
    fn unlock(&mut self, ctx: &Ctx) -> Step {
        match Self::session(
            ctx,
            wire::locker_session_request::Step::Unlock(wire::LockerUnlock {
                tz: ctx.zone().to_owned(),
            }),
        ) {
            Ok(answer) if Self::open_state(&answer) => {
                self.phase = Phase::Open;
                self.notice.clear();
                // WHAT THIS UNLOCK CLEARED (#1146): the refused ones, told once.
                self.failed = Failed::of(&answer);
                Step {
                    // AN UNLOCK IS WHEN A VAULT'S OWN KEY CAN BE FILED
                    // (R-ONBOARD-10): the core seals a Locker secret only while
                    // the session is open, so the shell is told.
                    effects: vec![effect(wire::effect::Kind::Announce(wire::Announce {
                        topic: "locker.unlocked".to_owned(),
                    }))],
                    change: Change::Opened,
                }
            }
            Ok(_) => {
                self.phase = Phase::Failed;
                self.notice = words::lock_did_not_open(ctx.locale());
                Step::default()
            }
            Err(sentence) => {
                self.phase = Phase::Failed;
                self.notice = sentence;
                Step::default()
            }
        }
    }

    /// The app left or returned to the foreground. Leaving relocks at once (the
    /// core already did; this closes the screen) and drops a prompt that was
    /// up; returning re-reads the session, which idle may have ended.
    pub fn lifecycle(&mut self, ctx: &Ctx, foreground: bool) -> Step {
        if foreground {
            return match self.phase {
                Phase::Open => self.recheck(ctx),
                // A re-key may have landed while away: the core now holds the
                // keys, and "Enter your recovery key" becomes "Unlock with …".
                Phase::Unavailable if !self.keyed => {
                    if let Some(answer) = Self::state(ctx) {
                        self.keyed = answer.keyed;
                        if self.keyed {
                            self.phase = Phase::Locked;
                        }
                    }
                    Step::default()
                }
                _ => Step::default(),
            };
        }
        self.asking = false;
        self.probing = false;
        let was_open = self.phase == Phase::Open;
        if self.phase != Phase::Unavailable {
            self.phase = Phase::Locked;
        }
        Step::change(if was_open {
            Change::Closed
        } else {
            Change::None
        })
    }

    /// A reveal (or any session step) answered LOCKED: idle ended the session
    /// under this screen.
    pub fn expired(&mut self, ctx: &Ctx) -> Change {
        if self.phase == Phase::Open {
            return self.lock(words::lock_expired(ctx.locale())).change;
        }
        Change::None
    }

    fn lock(&mut self, notice: String) -> Step {
        self.asking = false;
        self.phase = Phase::Locked;
        self.notice = notice;
        Step::change(Change::Closed)
    }

    // --- words ---------------------------------------------------------------

    /// "your face", "your fingerprint", "your passcode" — never a brand a
    /// platform owns.
    fn method(&self, locale: Locale) -> String {
        match self.biometry {
            wire::Biometry::Face => words::method_face(locale),
            wire::Biometry::Fingerprint | wire::Biometry::Touch => {
                words::method_fingerprint(locale)
            }
            wire::Biometry::Optic => words::method_optic(locale),
            _ => words::method_passcode(locale),
        }
    }

    fn failed_sentence(&self, locale: Locale) -> String {
        match self.biometry {
            wire::Biometry::Passcode | wire::Biometry::Unspecified => {
                words::lock_failed_passcode(locale)
            }
            _ => words::lock_failed(locale),
        }
    }

    /// The wall to draw, or `None` while the Locker is open.
    #[must_use]
    pub fn view(&self, locale: Locale) -> Option<wire::LockerWall> {
        use wire::locker_wall::Phase as P;
        let phase = match self.phase {
            Phase::Open => return None,
            Phase::Locked => P::Locked,
            Phase::Unlocking => P::Unlocking,
            Phase::Unavailable => P::Unavailable,
            Phase::Failed => P::Failed,
        };
        let method = self.method(locale);
        let unavailable = self.phase == Phase::Unavailable;
        let title = match self.phase {
            Phase::Unavailable if self.keyed => words::lock_unavailable_title(locale),
            Phase::Unavailable => words::lock_no_words_title(locale),
            Phase::Unlocking => words::lock_unlocking_title(locale),
            _ => words::lock_title(locale),
        };
        let body = if unavailable {
            if self.keyed {
                words::lock_unavailable_body(locale)
            } else {
                words::lock_no_words_body(locale)
            }
        } else {
            format!(
                "{} {method}{}",
                words::lock_body_lead(locale),
                words::lock_body_tail(locale)
            )
        };
        let notice = if unavailable {
            if self.keyed {
                words::lock_unavailable_notice(locale)
            } else {
                words::lock_no_words_notice(locale)
            }
        } else if matches!(self.phase, Phase::Locked | Phase::Failed) {
            [Some(self.notice.clone()), self.failures_line(locale)]
                .into_iter()
                .flatten()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            String::new()
        };
        let unlock_label = match self.phase {
            Phase::Locked => format!("{} {method}", words::unlock_with(locale)),
            Phase::Failed => words::unlock_again(locale),
            _ => String::new(),
        };
        let accessibility_label = [title.as_str(), notice.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(". ");
        Some(wire::LockerWall {
            phase: phase as i32,
            title,
            body,
            unlock_label,
            notice,
            words_label: if unavailable && !self.keyed {
                words::lock_no_words_action(locale)
            } else {
                String::new()
            },
            accessibility_label,
            words_route: (unavailable && !self.keyed)
                .then(crate::custody::routes::rekey_for_locker),
        })
    }
}

/// How long a copied secret stays on the clipboard.
pub const CLIPBOARD_LIFE: Duration = Duration::from_secs(30);
