//! THE ONE DOOR FOR A WRITE THAT CAN BE TAKEN BACK (#1185). After every undoable action the status
//! line says what happened with "Undo", and tapping Undo runs the inverse the core answered with.
//! One implementation, so the wording and the behaviour are the same in every app.
//!
//! - **The line.** A committed act whose answer carries an inverse says `said` with the verb
//!   "Undo". An act with no inverse (it asked first, or it writes nothing) says its sentence with
//!   no verb. A refusal is a refused line: the core's sentence.
//! - **Undo.** [`Undo::acted`] runs the stored inverse under a fresh key. It says "Undone" and
//!   offers nothing more. The vault refuses an Undo whose record changed again since; that line is
//!   the core's plain sentence (or ours when it gave none), and nothing is lost.
//! - **One event for every screen.** The status line's verb is the kit's [`wire::StatusActed`]
//!   (arm `status_acted = 904` of `ScreenEvent.kind`); a screen needs no arm of its own.
//!
//! ADOPTING IT IN A SCREEN (five lines):
//!
//! 1. Hold `undo: Undo` (`Undo::default()`).
//! 2. Write through it: `let settled = self.undo.act(ctx, request, &key, |l| words::pinned(l));`
//!    then react to `settled.committed` (reload, navigate). Never call `kit::act::act` from an
//!    app's own folder: the `promises` rule (C) lists the file.
//! 3. Take the event: `Some(E::StatusActed(_)) => if self.undo.acted(ctx) { self.reload(ctx) }`.
//! 4. Draw it: `status: self.undo.status()`.
//! 5. On `Left` (and where a newer, non-undoable line replaces this one) `self.undo.clear()`.
//!
//! A write whose Undo is offered elsewhere (a [`crate::kit::trash`] restore closure, an editor's own
//! text undo) carries a `// undo-exempt: <reason>` comment on the call, which the rule reads.

use centraid_api_proto::core_v1 as wire;

use super::act::{self as kit_act, Settled};
use crate::screen::Ctx;
use crate::strings::{Locale, shared};

/// What Undo sends, and to which app.
#[derive(Clone, Debug)]
struct Offer {
    app: String,
    inverse: wire::ActInverse,
}

/// The status line a screen holds beside its answers, and what its Undo reverses.
#[derive(Clone, Debug, Default)]
pub struct Undo {
    offer: Option<Offer>,
    line: Option<wire::StatusLine>,
}

fn plain(sentence: String) -> wire::StatusLine {
    wire::StatusLine {
        sentence,
        action_label: String::new(),
        refused: false,
    }
}

impl Undo {
    /// The line to draw, if any.
    #[must_use]
    pub fn status(&self) -> Option<wire::StatusLine> {
        self.line.clone()
    }

    /// Whether Undo is on offer.
    #[must_use]
    pub fn can_undo(&self) -> bool {
        self.offer.is_some()
    }

    /// What the next Undo would send, for a screen that counts on it.
    #[must_use]
    pub fn offered(&self) -> Option<&wire::ActInverse> {
        self.offer.as_ref().map(|offer| &offer.inverse)
    }

    /// Drop the line and the offer (a screen left, or a newer line replaces this one).
    pub fn clear(&mut self) {
        self.offer = None;
        self.line = None;
    }

    /// Say a sentence with no verb; nothing is on offer after it.
    pub fn say(&mut self, sentence: String) {
        self.offer = None;
        self.line = Some(plain(sentence));
    }

    /// Say a refusal's sentence; nothing is on offer after it.
    pub fn refuse(&mut self, sentence: String) {
        self.offer = None;
        self.line = Some(wire::StatusLine {
            sentence,
            action_label: String::new(),
            refused: true,
        });
    }

    /// Keep the sentence and take the verb away: for the one act whose inverse is unsafe here (a
    /// repeating task's completion already opened its next one).
    pub fn withdraw(&mut self) {
        self.offer = None;
        if let Some(line) = &mut self.line {
            line.action_label.clear();
        }
    }

    /// THE DOOR: submit `request` under `invoke_key`. On commit the line says `said` and, when the
    /// core answered with an inverse, offers Undo; on refusal it is the refused line.
    pub fn act(
        &mut self,
        ctx: &Ctx,
        request: impl Into<wire::ActRequest>,
        invoke_key: &str,
        said: impl FnOnce(Locale) -> String,
    ) -> Settled {
        let request = request.into();
        let app = request.app.clone();
        let settled = kit_act::act(ctx, request, invoke_key);
        self.settle(ctx, &settled, app, settled.inverse.clone(), Some(said));
        settled
    }

    /// [`Self::act`] for a write the core knows no inverse for: `revert` is the same command
    /// carrying the old values, and Undo sends it.
    pub fn act_reverting(
        &mut self,
        ctx: &Ctx,
        request: impl Into<wire::ActRequest>,
        revert: impl Into<wire::ActRequest>,
        invoke_key: &str,
        said: impl FnOnce(Locale) -> String,
    ) -> Settled {
        let revert = revert.into();
        let inverse = wire::ActInverse {
            action: revert.action,
            input: revert.input,
        };
        let settled = kit_act::act(ctx, request, invoke_key);
        self.settle(ctx, &settled, revert.app, Some(inverse), Some(said));
        settled
    }

    /// A write with no sentence of its own (a drag to reorder): success clears the line, a refusal
    /// says it.
    pub fn act_quietly(
        &mut self,
        ctx: &Ctx,
        request: impl Into<wire::ActRequest>,
        invoke_key: &str,
    ) -> Settled {
        let request = request.into();
        let app = request.app.clone();
        let settled = kit_act::act(ctx, request, invoke_key);
        self.settle::<fn(Locale) -> String>(ctx, &settled, app, None, None);
        settled
    }

    /// A write that follows another the line already says (a new task's tags): success leaves the
    /// line and its Undo as they are, a refusal says it.
    pub fn act_also(
        &mut self,
        ctx: &Ctx,
        request: impl Into<wire::ActRequest>,
        invoke_key: &str,
    ) -> Settled {
        let settled = kit_act::act(ctx, request, invoke_key);
        if !settled.committed {
            self.refuse(settled.refusal.clone());
        }
        settled
    }

    fn settle<F: FnOnce(Locale) -> String>(
        &mut self,
        ctx: &Ctx,
        settled: &Settled,
        app: String,
        inverse: Option<wire::ActInverse>,
        said: Option<F>,
    ) {
        if !settled.committed {
            self.refuse(settled.refusal.clone());
            return;
        }
        let Some(said) = said else {
            self.clear();
            return;
        };
        let locale = ctx.locale();
        self.offer = inverse.map(|inverse| Offer { app, inverse });
        self.line = Some(wire::StatusLine {
            sentence: said(locale),
            action_label: if self.offer.is_some() {
                shared::undo_label(locale)
            } else {
                String::new()
            },
            refused: false,
        });
    }

    /// THE STATUS LINE'S VERB WAS TAPPED: run the stored inverse under a fresh key. Returns whether
    /// it committed (the screen then loads again). Either way nothing is on offer afterwards.
    pub fn acted(&mut self, ctx: &Ctx) -> bool {
        let Some(offer) = self.offer.take() else {
            return false;
        };
        let request = wire::ActRequest {
            app: offer.app,
            action: offer.inverse.action,
            input: offer.inverse.input,
            invoke_key: String::new(),
        };
        let key = kit_act::key(&["undo", &request.action], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        let locale = ctx.locale();
        if settled.committed {
            self.line = Some(plain(shared::undone(locale)));
        } else {
            // The core's plain sentence when it gave one, else ours.
            let gave = settled.refusal != shared::write_refused(locale);
            self.refuse(if gave {
                settled.refusal
            } else {
                shared::undo_stale(locale)
            });
        }
        settled.committed
    }
}
