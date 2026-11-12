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
//! A WRITE OF SEVERAL THINGS is one line with one Undo: [`Undo::act_all`] runs a set of requests,
//! [`Undo::act_joining`] adds a write to the line already said. Undo runs every inverse, last to
//! first (see [`Undo::act_all`] for what happens when one fails).
//!
//! A SAVE THAT CLOSES ITS PAGE (an editor, a sheet) writes through [`Undo::act_handing_down`] (or
//! calls [`Undo::hand_down`] after a write that said its line): the line and its Undo leave with
//! the page and are drawn by the page beneath. That page calls [`Undo::take_handed`] where it
//! handles `Appeared` / `DataChanged` / `EnvironmentChanged` (the runtime sends it a
//! `DataChanged` with no tables when the page above it is popped), draws `status:
//! self.undo.status()` and takes the kit's `StatusActed` as any adopter does. The runtime holds
//! the line for the pop of the page that handed it and for nothing else: any navigation that is
//! not a pop drops it, and a screen that does not take it when the pop is told loses it, so it
//! never reaches an unrelated screen later.
//!
//! A write whose Undo is offered elsewhere (a [`crate::kit::trash`] restore closure, an editor's own
//! text undo) carries a `// undo-exempt: <reason>` comment on the call, which the rule reads.

use centraid_api_proto::core_v1 as wire;

use super::act::{self as kit_act, Settled};
use crate::screen::Ctx;
use crate::strings::{Locale, shared};

/// One write's inverse, and the app it goes to.
#[derive(Clone, Debug)]
struct Step {
    app: String,
    inverse: wire::ActInverse,
}

/// What Undo sends: the inverse of every write the line says, in the order the writes were made.
/// A line of one write has one step. [`Undo::acted`] runs them last to first, so ONE tap takes
/// back the whole set.
#[derive(Clone, Debug)]
struct Offer {
    steps: Vec<Step>,
}

impl Offer {
    fn of(app: String, inverse: wire::ActInverse) -> Self {
        Self {
            steps: vec![Step { app, inverse }],
        }
    }
}

/// The status line a screen holds beside its answers, and what its Undo reverses.
#[derive(Clone, Debug, Default)]
pub struct Undo {
    offer: Option<Offer>,
    line: Option<wire::StatusLine>,
}

/// A status line and its Undo, left by a page that closed for the page beneath it.
#[derive(Clone, Debug)]
pub struct Handed {
    offer: Option<Offer>,
    line: wire::StatusLine,
    /// The page closes AND the shell opens another straight after (a save that lands on what it
    /// made): the line waits through the pop and goes to the page the shell pushes next.
    onward: bool,
}

impl Handed {
    /// Whether the line goes to the page pushed after the pop, not the page the pop reveals.
    pub(crate) fn onward(&self) -> bool {
        self.onward
    }

    pub(crate) fn mark_onward(&mut self) {
        self.onward = true;
    }
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
        self.offer
            .as_ref()
            .and_then(|offer| offer.steps.last())
            .map(|step| &step.inverse)
    }

    /// THE PAGE IS ABOUT TO CLOSE: leave the line it said, with its Undo, for the page beneath
    /// (drawn there after [`Self::take_handed`]). A refused line is not handed down: the page
    /// does not close on a refusal. This page keeps its own copy for the frames before the shell
    /// pops it, and nothing it does afterwards reaches the page beneath.
    pub fn hand_down(&mut self, ctx: &Ctx) {
        if let Some(line) = self.line.clone().filter(|line| !line.refused) {
            ctx.hand_down(Handed {
                offer: self.offer.clone(),
                line,
                onward: false,
            });
        }
    }

    /// THE PAGE CLOSES FOR ANOTHER THE SHELL OPENS NEXT (a Photos editor save lands on the new
    /// photograph): like [`Self::hand_down`], but the line waits through the pop and is drawn on
    /// the page the member lands on (taken there with [`Self::take_handed`]). Any other
    /// navigation drops it, so it never reaches a page the member did not land on.
    pub fn hand_onward(&mut self, ctx: &Ctx) {
        self.hand_down(ctx);
        ctx.mark_handed_onward();
    }

    /// THE PAGE ABOVE CLOSED: take the line it handed down, if the runtime kept one for this
    /// screen. Given once. Returns whether there was one.
    pub fn take_handed(&mut self, ctx: &Ctx) -> bool {
        let Some(handed) = ctx.take_handed() else {
            return false;
        };
        self.offer = handed.offer;
        self.line = Some(handed.line);
        true
    }

    /// Say the line again in other words, keeping what is on offer: a sentence that needs the
    /// answer's numbers ("Work and 42 events moved to trash") is worded once the write has
    /// answered, and its Undo stays.
    pub fn reword(&mut self, sentence: String) {
        if let Some(line) = &mut self.line {
            line.sentence = sentence;
        }
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

    /// [`Self::act`] for a save that closes its page: on commit the line (and its Undo) is handed
    /// to the page beneath ([`Self::hand_down`]).
    pub fn act_handing_down(
        &mut self,
        ctx: &Ctx,
        request: impl Into<wire::ActRequest>,
        invoke_key: &str,
        said: impl FnOnce(Locale) -> String,
    ) -> Settled {
        let settled = self.act(ctx, request, invoke_key, said);
        if settled.committed {
            self.hand_down(ctx);
        }
        settled
    }

    /// [`Self::act_handing_down`] for a save whose page closes for one the shell opens next.
    pub fn act_handing_onward(
        &mut self,
        ctx: &Ctx,
        request: impl Into<wire::ActRequest>,
        invoke_key: &str,
        said: impl FnOnce(Locale) -> String,
    ) -> Settled {
        let settled = self.act(ctx, request, invoke_key, said);
        if settled.committed {
            self.hand_onward(ctx);
        }
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

    /// A write with no sentence of its own (a step inside a gesture whose own line says it): success clears the line, a refusal
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

    /// A write that is PART OF the line already said (a locker item's tags beside the item):
    /// success keeps the line and adds this write's inverse to its Undo, so one tap takes back
    /// the whole set. A write the core knows no inverse for takes the Undo away entirely (a
    /// half-undo would leave the set torn); a refusal is the refused line, and what the set
    /// already did stays on offer. With no line yet it is [`Self::act`] with no sentence: the
    /// caller says one first.
    pub fn act_joining(
        &mut self,
        ctx: &Ctx,
        request: impl Into<wire::ActRequest>,
        invoke_key: &str,
    ) -> Settled {
        let request = request.into();
        let app = request.app.clone();
        let settled = kit_act::act(ctx, request, invoke_key);
        if !settled.committed {
            self.refuse_keeping_offer(ctx, settled.refusal.clone());
            return settled;
        }
        match (settled.inverse.clone(), &mut self.offer) {
            (Some(inverse), Some(offer)) => offer.steps.push(Step { app, inverse }),
            _ => self.withdraw(),
        }
        settled
    }

    /// THE DOOR FOR A WRITE OF SEVERAL THINGS (a batch of photos): every request runs in order
    /// under its own key, and the line says `said` once with ONE Undo that takes all of them back.
    ///
    /// * The core has no batch or atomic act, so the writes are separate commits. Undo runs each
    ///   inverse, last to first, under a fresh key ([`Self::acted`]); if one of them fails
    ///   partway, the line is a plain refusal naming how many were not undone, and the ones that
    ///   did succeed stay undone.
    /// * Every request is tried (a photograph the vault refuses does not hold back the others).
    ///   The first refusal is the line, and the writes that did commit keep their Undo (the verb
    ///   stays on the refused line).
    /// * A write the core has no inverse for leaves the whole set with no Undo. That action must
    ///   be confirmed first instead; the door does not invent the confirm.
    ///
    /// Returns one answer per request that ran.
    pub fn act_all(
        &mut self,
        ctx: &Ctx,
        requests: impl IntoIterator<Item = (wire::ActRequest, String)>,
        said: impl FnOnce(Locale) -> String,
    ) -> Vec<Settled> {
        let mut steps = Vec::new();
        let mut inverse_missing = false;
        let mut answers = Vec::new();
        let mut refusal = None;
        for (request, key) in requests {
            let app = request.app.clone();
            let settled = kit_act::act(ctx, request, &key);
            if settled.committed {
                match settled.inverse.clone() {
                    Some(inverse) => steps.push(Step { app, inverse }),
                    None => inverse_missing = true,
                }
            } else if refusal.is_none() {
                refusal = Some(settled.refusal.clone());
            }
            answers.push(settled);
        }
        let offer = (!steps.is_empty() && !inverse_missing).then_some(Offer { steps });
        if let Some(sentence) = refusal {
            self.offer = offer;
            self.refuse_keeping_offer(ctx, sentence);
        } else if answers.is_empty() {
            self.clear();
        } else {
            self.offer = offer;
            self.line = Some(wire::StatusLine {
                sentence: said(ctx.locale()),
                action_label: if self.offer.is_some() {
                    shared::undo_label(ctx.locale())
                } else {
                    String::new()
                },
                refused: false,
            });
        }
        answers
    }

    /// A refused line that still offers what is on offer (the writes before the refusal).
    pub(crate) fn refuse_keeping_offer(&mut self, ctx: &Ctx, sentence: String) {
        let kept = self.offer.take();
        self.refuse(sentence);
        if let (Some(kept), Some(line)) = (kept, &mut self.line) {
            line.action_label = shared::undo_label(ctx.locale());
            self.offer = Some(kept);
        }
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
        self.offer = inverse.map(|inverse| Offer::of(app, inverse));
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

    /// THE STATUS LINE'S VERB WAS TAPPED: run the stored inverse under a fresh key, or, for a line
    /// of several writes, every inverse from the last write to the first (each under its own fresh
    /// key). Returns whether anything committed (the screen then loads again). Either way nothing
    /// is on offer afterwards.
    ///
    /// When some inverses fail the line is a plain refusal naming how many were not undone
    /// ([`shared::undo_partial`]); the ones that succeeded stay undone. For a line of one write the
    /// refusal is the core's plain sentence when it gave one, else ours.
    pub fn acted(&mut self, ctx: &Ctx) -> bool {
        let Some(offer) = self.offer.take() else {
            return false;
        };
        let locale = ctx.locale();
        let total = offer.steps.len();
        let (mut undone, mut failed) = (0_usize, 0_usize);
        let mut last_refusal = String::new();
        for step in offer.steps.into_iter().rev() {
            let request = wire::ActRequest {
                app: step.app,
                action: step.inverse.action,
                input: step.inverse.input,
                invoke_key: String::new(),
                autosave: false,
            };
            let key = kit_act::key(&["undo", &request.action], kit_act::fresh());
            let settled = kit_act::act(ctx, request, &key);
            if settled.committed {
                undone += 1;
            } else {
                failed += 1;
                last_refusal = settled.refusal;
            }
        }
        if failed == 0 {
            self.line = Some(plain(shared::undone(locale)));
        } else if total == 1 {
            // The core's plain sentence when it gave one, else ours.
            let gave = last_refusal != shared::write_refused(locale);
            self.refuse(if gave {
                last_refusal
            } else {
                shared::undo_stale(locale)
            });
        } else {
            self.refuse(shared::undo_partial(locale, failed as u64));
        }
        undone > 0
    }
}
