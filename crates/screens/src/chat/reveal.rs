//! A SEALED VALUE SHOWN ON THE CHAT CARD (#1188, owner 2026-11-12).
//!
//! A request to see a Locker secret ends in a card with a Reveal. The member taps it, the phone
//! asks its owner check (the same wall Locker's own pages carry), and the value shows on the card.
//! **The model never sees it.** The core reads it through Locker's authorised reveal
//! ([`Reveal`], the one controller Locker's item page drives too), the screen holds it in memory
//! for the core's window and draws it on [`wire::ChatCard::reveal`]; it enters no prompt, no tool
//! result, no event the model can read back, no saved turn and no card snapshot (`Msg::cards`
//! never holds it; a reopened thread shows the card with Reveal again).
//!
//! It is dropped when Locker relocks, when Chat leaves the foreground, when the tab or the page
//! is left, when the thread changes (the turn the reveal was made in is over), after the
//! window, and when the item is gone. A cancelled owner check shows nothing and says nothing.

use centraid_api_proto::core_v1 as wire;
use centraid_assist::native::member::{ActionKind, MemberAction};

use super::model::Chat;
use crate::kit::read;
use crate::locker::reveal::{Outcome, Reveal, TICK};
use crate::locker::types::{self, SEED};
use crate::locker::wall::{Change, Step, Wall};
use crate::screen::Ctx;
use crate::strings::{Locale, chat as chat_words, fill, locker as words};

/// The card a value is shown on, and what it is of.
#[derive(Clone, PartialEq, Eq)]
struct Spot {
    message: u64,
    index: usize,
    item_id: String,
    column: String,
    code: bool,
    /// The chat turn it was made in; a thread that changed ends it.
    turn: u64,
}

/// What this screen holds of reveals. Nothing here is saved or sent.
pub(super) struct Reveals {
    wall: Wall,
    reveal: Reveal,
    /// The card showing a value now.
    active: Option<Spot>,
    /// A tap waiting for the owner check: the card and the verb.
    wanting: Option<(Spot, String)>,
    /// What a card says under its row: a refusal, a copy, the check's failure.
    said: Option<(u64, usize, String)>,
    /// Cards whose item turned out to be gone.
    gone: Vec<(u64, usize)>,
}

impl Default for Reveals {
    fn default() -> Self {
        Self {
            wall: Wall::default(),
            reveal: Reveal::new(false),
            active: None,
            wanting: None,
            said: None,
            gone: Vec::new(),
        }
    }
}

fn card_action(card: &wire::ChatCard) -> Option<MemberAction> {
    MemberAction::from_card(&card.id, &card.qualifier).filter(|action| {
        matches!(action.kind, ActionKind::Reveal | ActionKind::Code)
            && !action.item_id.is_empty()
            && !action.column.is_empty()
    })
}

/// Whether a card offers a reveal or a code on itself (so a tap on its body opens nothing).
pub(super) fn is_reveal_card(card: &wire::ChatCard) -> bool {
    card.app == "locker" && card.entity == "locker_item" && card_action(card).is_some()
}

impl Reveals {
    /// The card as the view draws it: its row, or the sentence that replaced it.
    pub(super) fn card(
        &self,
        card: &wire::ChatCard,
        message: u64,
        index: usize,
        locale: Locale,
    ) -> wire::ChatCard {
        let mut out = card.clone();
        let Some(action) = card_action(card).filter(|_| is_reveal_card(card)) else {
            return out;
        };
        if self.gone.contains(&(message, index)) {
            out.note = chat_words::card_gone(locale);
            return out;
        }
        let shown_here = self
            .active
            .as_ref()
            .is_some_and(|spot| spot.message == message && spot.index == index);
        // A card that is not showing is drawn by a controller that shows nothing, so two cards
        // of one column are never both open.
        let shut = Reveal::new(true);
        let controller = if shown_here { &self.reveal } else { &shut };
        out.reveal = Some(if action.kind == ActionKind::Code {
            controller.code_row(locale, SEED, words::verification_code(locale), &[])
        } else {
            controller.sealed_row(
                locale,
                &action.column,
                types::label(locale, &action.column),
                &[],
            )
        });
        if let Some((m, i, sentence)) = &self.said
            && *m == message
            && *i == index
        {
            out.note.clone_from(sentence);
        }
        out
    }
}

impl Chat {
    /// A verb on a card's sealed row was tapped.
    pub(super) fn reveal_verb(
        &mut self,
        message_id: u64,
        index: usize,
        key: &str,
        ctx: &Ctx,
    ) -> Vec<wire::Effect> {
        let Some(card) = self
            .messages
            .iter()
            .find(|message| message.id == message_id)
            .and_then(|message| message.cards.get(index))
            .filter(|card| is_reveal_card(card))
            .cloned()
        else {
            return Vec::new();
        };
        let Some(action) = card_action(&card) else {
            return Vec::new();
        };
        let code = action.kind == ActionKind::Code;
        let spot = Spot {
            message: message_id,
            index,
            item_id: action.item_id.clone(),
            column: if code {
                SEED.to_owned()
            } else {
                action.column.clone()
            },
            code,
            turn: self.turn,
        };
        let here = self.reveals.active.as_ref() == Some(&spot);
        self.reveals.said = None;
        match (key, code) {
            ("conceal", _) if here => {
                self.reveals.active = None;
                self.reveals.reveal.conceal(ctx, &spot.column)
            }
            ("copy" | "copy_code", _) if here => {
                let locale = ctx.locale();
                let effects = self
                    .reveals
                    .reveal
                    .copy_shown(ctx, &spot.column)
                    .unwrap_or_default();
                self.reveals.said = Some((
                    message_id,
                    index,
                    if code {
                        words::code_copied(locale)
                    } else {
                        copied_sentence(locale, &spot.column)
                    },
                ));
                effects
            }
            ("reveal" | "copy", false) | ("code" | "copy_code", true) => {
                self.reveal_asked(spot, key, ctx)
            }
            _ => Vec::new(),
        }
    }

    /// Reveal, copy or show a code: the item must be there, and the Locker open.
    fn reveal_asked(&mut self, spot: Spot, key: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        let mut effects = Vec::new();
        if !self.item_live(&spot.item_id, ctx) {
            if self
                .reveals
                .active
                .as_ref()
                .is_some_and(|a| a.item_id == spot.item_id)
            {
                effects.extend(self.drop_reveal(ctx));
            }
            self.reveals.gone.push((spot.message, spot.index));
            return effects;
        }
        // THE SESSION IS RE-READ: another page may have opened it, or idle may have ended it.
        let step = self.reveals.wall.recheck(ctx);
        effects.extend(self.reveal_stepped(step, ctx));
        if self.reveals.wall.is_open() {
            effects.extend(self.reveal_performed(&spot, key, ctx));
            return effects;
        }
        // THE OWNER CHECK, every time the wall is shut. A tap while one is up waits for it.
        self.reveals.wanting = Some((spot, key.to_owned()));
        let step = self.reveals.wall.event(
            ctx,
            wire::LockerWallEvent {
                kind: Some(wire::locker_wall_event::Kind::Unlock(
                    wire::locker_wall_event::UnlockTapped::default(),
                )),
            },
        );
        effects.extend(self.reveal_stepped(step, ctx));
        effects
    }

    /// What the wall did: an opened Locker carries out the waiting tap; a relock wipes.
    fn reveal_stepped(&mut self, step: Step, ctx: &Ctx) -> Vec<wire::Effect> {
        let mut effects = step.effects;
        match step.change {
            Change::Opened => {
                if let Some((spot, key)) = self.reveals.wanting.take() {
                    effects.extend(self.reveal_performed(&spot, &key, ctx));
                }
            }
            Change::Closed => {
                self.reveals.wanting = None;
                effects.extend(self.drop_reveal(ctx));
            }
            Change::None => {}
        }
        // A check that did not open the Locker leaves nothing waiting. A refusal is said on the
        // card; a cancel says nothing.
        if !self.reveals.wall.is_unlocking()
            && !self.reveals.wall.is_open()
            && let Some((spot, _)) = self.reveals.wanting.take()
        {
            let note = self.reveals.wall.card_note(ctx.locale());
            if !note.is_empty() {
                self.reveals.said = Some((spot.message, spot.index, note));
            }
        }
        effects
    }

    fn reveal_performed(&mut self, spot: &Spot, key: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        let copy = key == "copy" || key == "copy_code";
        let outcome = if spot.code {
            self.reveals
                .reveal
                .code(ctx, &spot.item_id, &spot.column, copy, !copy)
        } else {
            self.reveals
                .reveal
                .reveal(ctx, &spot.item_id, &spot.column, copy)
        };
        match outcome {
            Outcome::Shown(effects) => {
                self.reveals.active = Some(spot.clone());
                effects
            }
            Outcome::Copied(effects) => {
                self.reveals.said = Some((
                    spot.message,
                    spot.index,
                    if spot.code {
                        words::code_copied(locale)
                    } else {
                        copied_sentence(locale, &spot.column)
                    },
                ));
                effects
            }
            Outcome::Refused(sentence) => {
                self.reveals.said = Some((spot.message, spot.index, sentence));
                Vec::new()
            }
            // Idle ended the session under the card: it is shut again, and says so.
            Outcome::Locked => {
                let _ = self.reveals.wall.expired();
                self.reveals.said = Some((spot.message, spot.index, words::reveal_locked(locale)));
                self.drop_reveal(ctx)
            }
        }
    }

    /// Everything shown goes, and the clipboard a copy filled.
    pub(super) fn drop_reveal(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.reveals.active = None;
        self.reveals.reveal.wipe(ctx)
    }

    /// The shell answered an effect: an owner check this screen asked for, or a copy that failed.
    pub(super) fn reveal_answered(
        &mut self,
        result: &wire::EffectResult,
        ctx: &Ctx,
    ) -> Vec<wire::Effect> {
        self.reveals.reveal.answered(ctx, result);
        let step = self.reveals.wall.answered(ctx, result);
        self.reveal_stepped(step, ctx)
    }

    /// The app left or returned to the foreground: leaving relocks, so everything shown goes.
    pub(super) fn reveal_lifecycle(&mut self, foreground: bool, ctx: &Ctx) -> Vec<wire::Effect> {
        let step = self.reveals.wall.lifecycle(ctx, foreground);
        let mut effects = self.reveal_stepped(step, ctx);
        if !foreground {
            self.reveals.wanting = None;
            effects.extend(self.drop_reveal(ctx));
        }
        effects
    }

    /// The tab went out of view: nothing shown stays, and a prompt that was up comes down.
    pub(super) fn reveal_hidden(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let step = self.reveals.wall.hidden();
        self.reveals.wanting = None;
        let mut effects = step.effects;
        effects.extend(self.drop_reveal(ctx));
        effects
    }

    /// The page is being popped: its effects are dropped with it, so only memory is emptied and
    /// the prompt is withdrawn.
    pub(super) fn reveal_left(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let step = self.reveals.wall.left();
        self.reveals.wanting = None;
        self.reveals.active = None;
        self.reveals.reveal.leave(ctx);
        step.effects
    }

    /// A timer fired: the tick of a shown value, or the kit's own hide.
    pub(super) fn reveal_timer(&mut self, timer: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        let effects = if timer == TICK {
            let item = self
                .reveals
                .active
                .as_ref()
                .map(|spot| spot.item_id.clone())
                .unwrap_or_default();
            self.reveals.reveal.tick(ctx, &item)
        } else {
            self.reveals.reveal.fired(timer)
        };
        if self.reveals.reveal.column().is_none() {
            self.reveals.active = None;
        }
        effects
    }

    /// WHAT ENDS A REVEAL BY CONSTRUCTION, checked after every event: the thread it was shown in
    /// is no longer on screen, or its card is no longer that card. The item is read again only
    /// when the vault changed (`on_data_changed`).
    pub(super) fn reveal_sweep(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(spot) = self.reveals.active.clone() else {
            return Vec::new();
        };
        let same = spot.turn == self.turn
            && self
                .messages
                .iter()
                .find(|message| message.id == spot.message)
                .and_then(|message| message.cards.get(spot.index))
                .is_some_and(|card| {
                    card_action(card).is_some_and(|action| action.item_id == spot.item_id)
                });
        if same {
            Vec::new()
        } else {
            self.drop_reveal(ctx)
        }
    }

    /// The vault changed: a shown value of an item that is gone goes, and its card says so.
    pub(super) fn reveal_data_changed(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(spot) = self.reveals.active.clone() else {
            return Vec::new();
        };
        if self.item_live(&spot.item_id, ctx) {
            return Vec::new();
        }
        self.reveals.gone.push((spot.message, spot.index));
        self.drop_reveal(ctx)
    }

    /// Whether the Locker item a card names is still in the vault. True when the core would not
    /// say (the card is not called gone on a failed read).
    fn item_live(&self, item_id: &str, ctx: &Ctx) -> bool {
        let asked = crate::catalog::load::shell::ChatCard {
            app: "locker".to_owned(),
            entity: "locker_item".to_owned(),
            id: item_id.to_owned(),
        };
        read::read(ctx, asked, |answer| match answer {
            wire::app_query_response::Answer::ChatCard(live) => Some(live.exists),
            _ => None,
        })
        .data()
        .copied()
        .unwrap_or(true)
    }
}

fn copied_sentence(locale: Locale, column: &str) -> String {
    fill(
        &words::copied_secret(locale),
        &[("field", &types::label(locale, column))],
    )
}
