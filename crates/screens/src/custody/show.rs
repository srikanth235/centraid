//! SHOW THE RECOVERY KEY AGAIN, FROM THE BACKUP TAB (`words.show`; #1047 E4,
//! Q-1047-19).
//!
//! The words are kept in this phone's device-only store beside the seed. This
//! screen reads them only after the phone's own owner check passed (the generic
//! `OwnerCheck` effect, the posture Locker's unlock has, Q-1047-12) and holds
//! them only while PHASE_SHOW is up. Done, a dismissal, the app leaving the
//! foreground and leaving the screen all drop them. A phone whose seed arrived
//! through the synchronised keychain has no words, and says so rather than
//! showing an empty grid.
//!
//! **Whose words** follows the vault in front: one kept on its own words
//! (R-1047-E18) shows ITS words, by its name; any other shows the member's.

use std::fmt;

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;
use wire::words_show_state::Phase;

use super::enrollment::{Env, Job, Out, Progress, Runner};
use super::keeper::{Absent, Keeper, KeeperSlot};
use super::secrets::{VaultSecrets, WORDS};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, custody as words, fill};

#[must_use]
pub fn build(
    secrets: &VaultSecrets,
    keeper: &KeeperSlot,
    _route: &wire::Route,
) -> Option<Box<dyn Screen>> {
    Some(Box::new(Show::new(secrets.clone(), keeper.clone())))
}

/// `words.show`'s machine. **Redacted**: `words` are the member's words.
pub struct Show {
    secrets: VaultSecrets,
    keeper: KeeperSlot,
    runner: Runner,
    phase: Phase,
    started: bool,
    finished: bool,
    /// The owner check is up and its answer is awaited.
    asking: bool,
    /// The claim of a saved copy is being recorded; the screen closes once it is.
    saving: bool,
    words: Vec<String>,
    /// NONE_HERE: a seed is held (it came by sync), so the sentence says where
    /// the words are.
    seed_held: bool,
    /// The vault in front, when it is on its own words (R-1047-E18).
    own_name: Option<String>,
    /// A check failed: ASK is drawn with why, and a primary to try again.
    failed: bool,
}

impl fmt::Debug for Show {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Show(phase={:?}, <redacted>)", self.phase)
    }
}

fn effect(kind: wire::effect::Kind) -> wire::Effect {
    wire::Effect { kind: Some(kind) }
}

impl Show {
    fn new(secrets: VaultSecrets, keeper: KeeperSlot) -> Self {
        Self {
            secrets,
            keeper,
            runner: Runner::default(),
            phase: Phase::Ask,
            started: false,
            finished: false,
            asking: false,
            saving: false,
            words: Vec::new(),
            seed_held: false,
            own_name: None,
            failed: false,
        }
    }

    /// Whether the words are held right now. For the tests; never the words.
    #[must_use]
    pub fn holds_words(&self) -> bool {
        !self.words.is_empty()
    }

    /// The owner check, raised at once: "Show recovery key" was already the ask.
    fn ask(&mut self, locale: Locale) -> Vec<wire::Effect> {
        self.asking = true;
        self.failed = false;
        vec![effect(wire::effect::Kind::OwnerCheck(wire::OwnerCheck {
            ask: true,
            reason: words::show_again_reason(locale),
            title: words::show_again_reason(locale),
            subtitle: String::new(),
        }))]
    }

    fn begin(&mut self, job: Job, ctx: &Ctx) -> Vec<wire::Effect> {
        let keeper = self.keeper.get();
        let absent = Absent;
        let keeper: &dyn Keeper = keeper.as_deref().unwrap_or(&absent);
        let env = Env {
            ctx,
            secrets: &self.secrets,
            keeper,
        };
        let progress = self.runner.begin(job, &env);
        self.progressed(progress)
    }

    fn progressed(&mut self, progress: Progress) -> Vec<wire::Effect> {
        if matches!(progress.out, Some(Out::Done)) && !self.finished {
            if self.saving {
                // THE CLAIM IS RECORDED, so the Backup tab's re-read on close
                // sees it.
                self.close();
            } else {
                self.loaded();
            }
        }
        progress.effects
    }

    /// The stores are read: show what the vault in front keeps, or say there is
    /// nothing to show.
    fn loaded(&mut self) {
        if self.phase != Phase::Loading {
            return;
        }
        let front = self.keeper.get().and_then(|keeper| keeper.foreground());
        let own = front
            .as_ref()
            .and_then(|front| self.secrets.own_seed_of(&front.vault_id));
        let (words, seed_held, own_name) = match (own, front) {
            (Some(own), Some(front)) => (
                self.secrets.own_words(&own),
                self.secrets.own_seed(&own).is_some(),
                Some(front.name),
            ),
            _ => (self.secrets.words(), self.secrets.seed().is_some(), None),
        };
        self.own_name = own_name;
        match words {
            Some(words) if words.len() == WORDS => {
                self.phase = Phase::Show;
                self.words = words;
            }
            _ => {
                self.phase = Phase::NoneHere;
                self.seed_held = seed_held;
            }
        }
    }

    /// Leave, and drop the words.
    fn close(&mut self) {
        self.words.clear();
        self.finished = true;
    }

    fn checked(&mut self, result: &wire::EffectResult, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::effect_result::Outcome;
        use wire::owner_checked::Outcome as Checked;
        if !self.asking {
            return Vec::new();
        }
        let outcome = match &result.outcome {
            Some(Outcome::OwnerChecked(checked)) => {
                Checked::try_from(checked.outcome).unwrap_or(Checked::Failed)
            }
            Some(Outcome::Failed(_)) => Checked::Failed,
            _ => return Vec::new(),
        };
        self.asking = false;
        match outcome {
            // THE WORDS ARE READ ONLY AFTER THE PHONE SAID IT IS ITS OWNER.
            Checked::Succeeded => {
                self.phase = Phase::Loading;
                self.begin(Job::reload(), ctx)
            }
            // A CANCELLED CHECK IS A NO: there was no screen before it, so there
            // is none to go back to.
            Checked::Cancelled => {
                self.close();
                Vec::new()
            }
            // Any other failure draws ASK with why, and a primary to try again.
            _ => {
                self.failed = true;
                Vec::new()
            }
        }
    }

    fn event(&mut self, event: wire::WordsShowEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::words_show_event::Kind as K;
        match event.kind {
            Some(K::Dismissed(_) | K::Secondary(_)) => {
                self.close();
                Vec::new()
            }
            // "I'VE SAVED IT" ON THE MEMBER'S OWN KEY quiets the Backup tab's
            // warning (R-ONBOARD-10); a vault's own key is filed in Locker. The
            // words are dropped at once; the screen closes once the claim is
            // recorded.
            Some(K::Primary(_)) if self.phase == Phase::Show && self.own_name.is_none() => {
                self.words.clear();
                self.phase = Phase::Loading;
                self.saving = true;
                self.begin(Job::write(vec![VaultSecrets::mark_words_saved()]), ctx)
            }
            // ASK's primary, after a failed check: ask again.
            Some(K::Primary(_)) if self.phase == Phase::Ask && self.failed && !self.asking => {
                self.ask(ctx.locale())
            }
            Some(K::Primary(_)) if self.phase != Phase::Ask && self.phase != Phase::Loading => {
                self.close();
                Vec::new()
            }
            Some(K::SaveCopy(_)) if self.phase == Phase::Show => {
                vec![effect(wire::effect::Kind::Share(wire::Share {
                    text: self.words.join(" "),
                    url: String::new(),
                    subject: words::save_subject(ctx.locale()),
                }))]
            }
            _ => Vec::new(),
        }
    }

    fn render(&self, locale: Locale) -> wire::WordsShowState {
        let phase = self.phase;
        let show = phase == Phase::Show && !self.finished;
        // ASK BEFORE ANY FAILURE IS NOT A SCREEN: the owner check is up and
        // nothing is drawn until it answers.
        let check_now = phase == Phase::Ask && !self.failed;
        let own = self.own_name.as_deref();
        let name = own.unwrap_or_default();
        let title = match phase {
            Phase::NoneHere => words::show_again_none_title(locale),
            Phase::Ask if check_now => String::new(),
            Phase::Show if own.is_some() => fill(&words::show_own_title(locale), &[("name", name)]),
            _ => words::show_again_title(locale),
        };
        let body = match phase {
            Phase::Ask if check_now => String::new(),
            Phase::Ask => words::show_again_ask_body(locale),
            Phase::Show if own.is_some() => {
                fill(&words::show_again_own_body(locale), &[("name", name)])
            }
            Phase::Show => words::show_again_body(locale),
            Phase::NoneHere if own.is_some() => {
                fill(&words::show_again_own_none(locale), &[("name", name)])
            }
            Phase::NoneHere if self.seed_held => words::show_again_none_synced(locale),
            Phase::NoneHere => words::show_again_none(locale),
            _ => String::new(),
        };
        let primary = match phase {
            Phase::Ask if check_now => String::new(),
            Phase::Ask => words::show_again_primary(locale),
            Phase::Show if own.is_none() => words::show_again_saved(locale),
            Phase::Show | Phase::NoneHere => words::done(locale),
            _ => String::new(),
        };
        let notice = if self.failed && phase == Phase::Ask {
            words::show_again_verify_failed(locale)
        } else {
            String::new()
        };
        wire::WordsShowState {
            phase: phase as i32,
            secure: show,
            words: if show {
                self.words
                    .iter()
                    .enumerate()
                    .map(|(at, word)| wire::WordCell {
                        position: u32::try_from(at + 1).unwrap_or(u32::MAX),
                        word: word.clone(),
                        accessibility_label: fill(
                            &words::word_spoken(locale),
                            &[("n", &(at + 1).to_string()), ("word", word)],
                        ),
                    })
                    .collect()
            } else {
                Vec::new()
            },
            primary_label: primary,
            secondary_label: if phase == Phase::Ask && !check_now {
                words::cancel(locale)
            } else {
                String::new()
            },
            accessibility_label: if show {
                words::show_a11y(locale)
            } else {
                [title.as_str(), notice.as_str()]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(". ")
            },
            save_label: if show {
                words::save_label(locale)
            } else {
                String::new()
            },
            check_now,
            finished: self.finished,
            title,
            body,
            notice,
        }
    }
}

impl Screen for Show {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.finished {
            return Vec::new();
        }
        match event.kind {
            Some(E::Appeared(_)) if !self.started => {
                self.started = true;
                self.ask(ctx.locale())
            }
            Some(E::EffectResult(result)) => {
                if self.asking {
                    return self.checked(&result, ctx);
                }
                let keeper = self.keeper.get();
                let absent = Absent;
                let keeper: &dyn Keeper = keeper.as_deref().unwrap_or(&absent);
                let env = Env {
                    ctx,
                    secrets: &self.secrets,
                    keeper,
                };
                match self.runner.answered(&result, &env) {
                    Some(progress) => self.progressed(progress),
                    None => Vec::new(),
                }
            }
            // THE WORDS ARE DROPPED the moment the app leaves the foreground.
            Some(E::Lifecycle(lifecycle)) if !lifecycle.foreground => {
                self.close();
                Vec::new()
            }
            Some(E::Left(_)) => {
                self.words.clear();
                Vec::new()
            }
            Some(E::WordsShow(event)) => self.event(event, ctx),
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::WordsShow(self.render(ctx.locale()))),
            ..wire::ViewState::default()
        }
    }
}
