//! `pair.laptop`: PAIR THIS PHONE'S VAULT WITH ONE OF THE MEMBER'S GATEWAYS
//! (#1080; #1047 E4), as a screen.
//!
//! The gateway prints a pairing payload (`centraid-gateway pair`): a square to
//! scan and the same text to paste, carrying its addresses, its certificate's
//! fingerprint and a one-use secret. The core connects with that pin, pairs, and
//! keeps the gateway as one more backup destination; the screen shows the
//! gateway's label and address and the pairing's safety number, and the
//! comparison is the member's (seam contract A7).
//!
//! **Only a KEYED vault can pair.** A pairing is signed for by the vault's
//! identity key, which only a core opened with the seed holds; an unkeyed vault
//! is sent to its words first ([`Phase::NeedsWords`] with a door to the re-key)
//! rather than refused by a core error a member cannot act on. A phone with no
//! vault is told to make one.

use centraid_api_proto::core_v1 as wire;
use wire::pair_laptop_state::Phase;

use super::door::{self, Answer, Refusal, Verdict};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, pairing as words, shared};

/// The tag the pairing's off-thread answer comes back under.
pub(super) const PAIR_TAG: &str = "pair";

/// What the shell is told once a pairing landed, so the Backup screen reads the
/// new destination at once.
pub const ANNOUNCE_PAIRED: &str = "backup.destinations";

/// What the shell is told when the member asks for the words: it opens the
/// words screen for a re-key in this screen's place.
pub const ANNOUNCE_REKEY: &str = "pair.rekey";

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Laptop::default()))
}

/// The pairing code's secret is spent on first use, and the code is still never
/// printed: this type has no `Debug`.
struct Laptop {
    phase: Phase,
    payload: String,
    answer: Option<Answer>,
    notice: String,
    /// NEEDS_WORDS because the vault opened without its words, so re-key is the
    /// way on.
    rekey: bool,
    /// FAILED, AND NO ATTEMPT WOULD CHANGE IT: the gateway answered
    /// `VAULT_MOVED`. The screen draws the sentence and Done, with no field, no
    /// scan and no Try again.
    barred: bool,
    finished: bool,
}

impl Default for Laptop {
    fn default() -> Self {
        Self {
            phase: Phase::Unspecified,
            payload: String::new(),
            answer: None,
            notice: String::new(),
            rekey: false,
            barred: false,
            finished: false,
        }
    }
}

/// THE TEXT, AS THE CORE WILL READ IT. Trimmed, and the terminal's own `pair`
/// label dropped when the member pasted the whole printed line. Nothing else:
/// the ticket's shape is the core's to judge (`centraid_identity::ticket`), and
/// a second parser here would disagree with it the day either changed.
#[must_use]
pub fn ticket_of(payload: &str) -> String {
    let trimmed = payload.trim();
    let label = "pair";
    match trimmed.strip_prefix(label) {
        Some(rest) if rest.chars().next().is_some_and(char::is_whitespace) => {
            rest.trim().to_owned()
        }
        _ => trimmed.to_owned(),
    }
}

/// Whether the foreground vault can pair.
enum Readiness {
    Ready,
    NeedsWords,
    NoVault,
}

impl Laptop {
    fn readiness(ctx: &Ctx) -> Readiness {
        // The core's one statement of "this core holds the vault's keys" rides
        // every session answer; no vault at all is a refusal.
        match ctx.locker(&wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::State(
                wire::LockerStateAsk {},
            )),
        }) {
            Ok(answer) if answer.keyed => Readiness::Ready,
            Ok(_) => Readiness::NeedsWords,
            Err(_) => Readiness::NoVault,
        }
    }

    /// The field is drawn, and so typing, scanning and Primary mean something.
    /// A BARRED REFUSAL HAS NO FIELD TO TYPE IN OR SCAN INTO.
    fn waiting(&self) -> bool {
        matches!(self.phase, Phase::Waiting | Phase::Failed) && !self.barred
    }

    fn assess(&mut self, ctx: &Ctx) {
        if self.phase != Phase::Unspecified {
            return;
        }
        let locale = ctx.locale();
        match Self::readiness(ctx) {
            Readiness::Ready => self.phase = Phase::Waiting,
            Readiness::NeedsWords => {
                self.phase = Phase::NeedsWords;
                self.notice = words::needs_words(locale);
                self.rekey = true;
            }
            Readiness::NoVault => {
                self.phase = Phase::NeedsWords;
                self.notice = words::no_vault(locale);
            }
        }
    }

    fn pair(&mut self, ctx: &Ctx) {
        let locale = ctx.locale();
        let ticket = ticket_of(&self.payload);
        if ticket.is_empty() {
            self.phase = Phase::Waiting;
            self.notice = words::empty(locale);
            return;
        }
        self.phase = Phase::Pairing;
        self.notice.clear();
        door::pair(ctx, &ticket);
    }

    fn answered(&mut self, locale: Locale, verdict: Verdict) -> Vec<wire::Effect> {
        if self.phase != Phase::Pairing {
            return Vec::new();
        }
        match verdict {
            // EACH REFUSAL ITS OWN SENTENCE (#1047 E5): a code the gateway did
            // not take wants a new code, not a gateway woken up.
            Verdict::Refused(because) => {
                self.phase = Phase::Failed;
                self.notice = match because {
                    Refusal::Unreachable => words::unreachable(locale),
                    Refusal::NotACode => words::not_a_code(locale),
                    Refusal::NotTaken => words::not_taken(locale),
                    Refusal::Moved => words::moved(locale),
                };
                // A MOVED VAULT IS THE ONE REFUSAL NO SECOND ATTEMPT CHANGES:
                // another phone holds the writer epoch, so the same pairing, or
                // a fresh code, is answered the same way. The screen says so
                // and offers nothing to retry.
                self.barred = because == Refusal::Moved;
                Vec::new()
            }
            // A PAIRING WITH NOTHING TO COMPARE IS NOT ONE A MEMBER CAN CHECK,
            // so it is refused rather than shown: the core answers an empty
            // safety number when it could not make one.
            Verdict::Paired(answer) => {
                if answer.safety_number.trim().is_empty() {
                    self.phase = Phase::Failed;
                    self.notice = words::nothing_to_compare(locale);
                    Vec::new()
                } else {
                    self.phase = Phase::Paired;
                    self.payload.clear();
                    self.answer = Some(answer);
                    self.notice.clear();
                    vec![announce(ANNOUNCE_PAIRED)]
                }
            }
        }
    }

    fn primary(&mut self, ctx: &Ctx) {
        match self.phase {
            // A BARRED REFUSAL'S ONE KEY IS DONE: pairing again would be
            // refused the same way, so there is nothing to send.
            Phase::Waiting | Phase::Failed => {
                if self.barred {
                    self.finished = true;
                } else {
                    self.pair(ctx);
                }
            }
            Phase::Paired | Phase::NeedsWords => self.finished = true,
            _ => {}
        }
    }

    fn typed(&mut self, text: String) {
        if self.waiting() {
            self.phase = Phase::Waiting;
            self.payload = text;
            self.notice.clear();
        }
    }

    fn scanned(&mut self, ctx: &Ctx, text: String) {
        if !self.waiting() {
            return;
        }
        if text.trim().is_empty() {
            // A PHOTO WITH NO SQUARE spends nothing: the field keeps what was
            // typed and the sentence says what to do instead.
            self.phase = Phase::Waiting;
            self.notice = words::photo_unread(ctx.locale());
        } else {
            // A SCAN IS A DELIBERATE ACT: it pairs at once.
            self.payload = text;
            self.pair(ctx);
        }
    }
}

fn announce(topic: &str) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::Announce(wire::Announce {
            topic: topic.to_owned(),
        })),
    }
}

impl Screen for Laptop {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::pair_laptop_event::Kind as P;
        use wire::screen_event::Kind as E;
        if self.finished {
            return Vec::new();
        }
        match event.kind {
            Some(E::Appeared(_)) => self.assess(ctx),
            Some(E::PairLaptop(event)) => match event.kind {
                Some(P::Typed(typed)) => self.typed(typed.text),
                // `ScanTapped` is an intent: the shell reads a code, and the
                // machine moves only on what comes back.
                Some(P::Scan(_)) if self.waiting() => {
                    return vec![wire::Effect {
                        kind: Some(wire::effect::Kind::ScanCode(wire::ScanCode {
                            photo_label: words::photo(ctx.locale()),
                        })),
                    }];
                }
                Some(P::Primary(_)) => self.primary(ctx),
                Some(P::Secondary(_)) if self.phase != Phase::Pairing => self.finished = true,
                // `WordsTapped` IS AN INTENT: the shell opens the words screen
                // for a re-key in this screen's place, so the pairing is done.
                // It is heard only where the door was drawn.
                Some(P::Words(_)) if self.phase == Phase::NeedsWords && self.rekey => {
                    self.finished = true;
                    return vec![announce(ANNOUNCE_REKEY)];
                }
                _ => {}
            },
            Some(E::EffectResult(result)) => {
                if let Some(wire::effect_result::Outcome::CodeScanned(code)) = result.outcome {
                    self.scanned(ctx, code.text);
                }
                // A scan the member backed out of, or the camera refused, is
                // nothing to say: the paste field is still there.
            }
            Some(E::OffThreadDone(done)) if done.tag == PAIR_TAG => {
                return self.answered(ctx.locale(), door::verdict(&done));
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::PairLaptop(self.state(ctx.locale()))),
            ..wire::ViewState::default()
        }
    }
}

impl Laptop {
    fn state(&self, locale: Locale) -> wire::PairLaptopState {
        let phase = self.phase;
        let title = match phase {
            Phase::Paired => words::paired_title(locale),
            Phase::Failed => words::failed_title(locale),
            // "Your words come first" only where words ARE the way out (the
            // re-key door); no vault keeps the screen's own title over its one
            // sentence.
            Phase::NeedsWords if self.rekey => words::needs_words_title(locale),
            _ => words::title(locale),
        };
        let barred = self.barred && phase == Phase::Failed;
        let body = match phase {
            // A BARRED REFUSAL IS ITS NOTICE ALONE: the instruction to paste a
            // code would be asking for what cannot work.
            Phase::Failed if barred => String::new(),
            Phase::Failed | Phase::Waiting | Phase::Pairing => words::ask(locale),
            Phase::Paired => self
                .answer
                .as_ref()
                .map_or_else(String::new, |answer| paired_line(locale, answer)),
            _ => String::new(),
        };
        let entering = matches!(phase, Phase::Waiting | Phase::Failed) && !barred;
        let primary = match phase {
            Phase::Waiting => words::primary(locale),
            // THE ACTION THAT CAN SUCCEED, OR NONE (#1080 receipt, "for the
            // owner"): Try again under a refusal no retry changes is a key that
            // does nothing, so a barred refusal closes instead.
            Phase::Failed if barred => shared::kit_done(locale),
            Phase::Failed => shared::kit_retry(locale),
            Phase::Paired | Phase::NeedsWords => shared::kit_done(locale),
            _ => String::new(),
        };
        let accessibility_label = [title.as_str(), self.notice.as_str()]
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(". ");
        wire::PairLaptopState {
            phase: phase as i32,
            title,
            body,
            payload: if entering {
                self.payload.clone()
            } else {
                String::new()
            },
            payload_label: if entering {
                words::paste_label(locale)
            } else {
                String::new()
            },
            // ONE SCAN, ON EVERY PHONE: the camera, which offers a photo too;
            // without one (the simulator), the photo picker.
            scan_label: if entering {
                words::scan(locale)
            } else {
                String::new()
            },
            // THE WAY OUT OF NEEDS_WORDS: a vault that opened without its words
            // gets them back through re-key. A phone with no vault has no words
            // to enter, so no door.
            words_label: if phase == Phase::NeedsWords && self.rekey {
                words::words_action(locale)
            } else {
                String::new()
            },
            notice: self.notice.clone(),
            primary_enabled: if entering {
                !ticket_of(&self.payload).is_empty()
            } else {
                !primary.is_empty()
            },
            primary_label: primary,
            secondary_label: if entering {
                shared::kit_cancel(locale)
            } else {
                String::new()
            },
            progress: if phase == Phase::Pairing {
                words::pairing(locale)
            } else {
                String::new()
            },
            safety_number: match (&phase, &self.answer) {
                (Phase::Paired, Some(answer)) => answer.safety_number.clone(),
                _ => String::new(),
            },
            accessibility_label,
            finished: self.finished,
        }
    }
}

/// **THE COMPARISON IS THE MEMBER'S** (#1029 §5, #1080 A7). A safety number a
/// member is shown but never asked to compare is decoration. The sentence says
/// what to do with it and what it means, and it says the second half plainly:
/// matching numbers mean nobody is in the middle.
fn paired_line(locale: Locale, answer: &Answer) -> String {
    let who = if answer.label.trim().is_empty() {
        words::paired_who(locale)
    } else {
        answer.label.clone()
    };
    let place = if answer.address.trim().is_empty() {
        who.clone()
    } else {
        fill(
            &words::paired_at(locale),
            &[("who", &who), ("address", &answer.address)],
        )
    };
    fill(
        &words::paired_line(locale),
        &[("where", &place), ("who", &who)],
    )
}
