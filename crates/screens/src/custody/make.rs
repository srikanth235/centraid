//! MAKE A VAULT, AND ITS 24 WORDS (`words.make`; #1047 E1, R-1047-E1/E2).
//!
//! The order is [`super::enrollment`]'s: what this phone already holds is read
//! first; a phone with no seed MINTS the words (the core's CSPRNG) and has the
//! core turn them into the seed that is stored and settled; the vault is
//! founded after that, keyed from its first commit.
//!
//! **THE KEY IS SHOWN ONLY WHERE NOTHING ELSE WILL HOLD IT (R-ONBOARD-10).** A
//! phone whose synchronised store takes the seed (iCloud Keychain, Google's
//! Block Store) keeps it there without a word to the member: the vault comes
//! back on their next phone the way their passwords do. Only a phone whose key
//! would stay on it alone SHOWS the words once on a secure screen and waits for
//! "I've saved it", and a vault on its own key always does. A phone whose seed
//! is its own makes the vault at the next index with no words at all. A phone
//! holding a seed that arrived from elsewhere is sent to restore first.
//!
//! **There is no framing screen.** The words are shown straight away, and the
//! screen itself says what they are for and offers to save a copy of them. A
//! phone that makes its vault from a seed it already holds shows no words.
//!
//! **The words live in the screen from the mint until the seed is kept**, and
//! in the drawn state only while [`wire::words_make_state::Phase::Show`] is up.
//! Cancelling, dismissing or keeping them drops them; nothing writes them.

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;
use wire::words_make_state::Phase;

use super::enrollment::{Assessed, Env, Job, Out, Progress, Refusal, Runner, Standing};
use super::keeper::{Absent, Found, FoundRefusal, Keeper, KeeperSlot};
use super::secrets::{VaultSecrets, WORDS};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, custody as words, fill};

/// What "Try again" does from FAILED.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Retry {
    None,
    Mint,
    Keep,
    Make,
}

#[must_use]
pub fn build(
    secrets: &VaultSecrets,
    keeper: &KeeperSlot,
    _route: &wire::Route,
) -> Option<Box<dyn Screen>> {
    Some(Box::new(Make::new(secrets.clone(), keeper.clone())))
}

/// `words.make`'s machine. **Redacted**: it holds the member's words from the
/// mint until the seed is kept.
pub struct Make {
    secrets: VaultSecrets,
    keeper: KeeperSlot,
    runner: Runner,
    phase: Phase,
    started: bool,
    finished: bool,
    phrase: Vec<String>,
    custody: String,
    /// The synchronised store will take the key, so it is kept without being
    /// shown (R-ONBOARD-10).
    quiet: bool,
    notice: String,
    retry: Retry,
    /// CHOOSE: keep this vault on its own words (R-1047-E18).
    own: bool,
    /// CHOOSE: the name typed for the vault.
    name: String,
    /// The entry this vault's own seed was kept under, once kept.
    own_id: Option<String>,
    made_line: String,
}

impl std::fmt::Debug for Make {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Make(phase={:?}, <redacted>)", self.phase)
    }
}

fn effect(kind: wire::effect::Kind) -> wire::Effect {
    wire::Effect { kind: Some(kind) }
}

impl Make {
    fn new(secrets: VaultSecrets, keeper: KeeperSlot) -> Self {
        Self {
            secrets,
            keeper,
            runner: Runner::default(),
            phase: Phase::Checking,
            started: false,
            finished: false,
            phrase: Vec::new(),
            custody: String::new(),
            quiet: false,
            notice: String::new(),
            retry: Retry::None,
            own: false,
            name: String::new(),
            own_id: None,
            made_line: String::new(),
        }
    }

    /// Whether the words are held right now. For the tests; never the words.
    #[must_use]
    pub fn holds_words(&self) -> bool {
        !self.phrase.is_empty()
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
        self.progressed(progress, ctx)
    }

    fn answered(&mut self, result: &wire::EffectResult, ctx: &Ctx) -> Vec<wire::Effect> {
        let keeper = self.keeper.get();
        let absent = Absent;
        let keeper: &dyn Keeper = keeper.as_deref().unwrap_or(&absent);
        let env = Env {
            ctx,
            secrets: &self.secrets,
            keeper,
        };
        match self.runner.answered(result, &env) {
            Some(progress) => self.progressed(progress, ctx),
            None => Vec::new(),
        }
    }

    fn progressed(&mut self, progress: Progress, ctx: &Ctx) -> Vec<wire::Effect> {
        let mut effects = progress.effects;
        if let Some(out) = progress.out {
            // A CLOSED FLOW HEARS NO ANSWER: one that arrives after the member
            // left changes nothing they can see.
            if !self.finished {
                effects.extend(self.job_done(out, ctx));
            }
        }
        effects
    }

    fn job_done(&mut self, out: Out, ctx: &Ctx) -> Vec<wire::Effect> {
        match out {
            Out::Assessed(assessed) => self.standing(assessed, ctx),
            Out::Kept(refusal) => self.kept(refusal, None, ctx),
            Out::OwnKept(Ok(id)) => self.kept(None, Some(id), ctx),
            Out::OwnKept(Err(why)) => self.kept(Some(why), None, ctx),
            Out::Made(found) => self.made(found, ctx.locale()),
            Out::Restored(_) | Out::Rekeyed(_) | Out::Done => Vec::new(),
        }
    }

    fn standing(&mut self, assessed: Assessed, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.phase != Phase::Checking {
            return Vec::new();
        }
        match assessed.standing {
            // NO WORDS YET: mint them now, and keep the custody sentence for the
            // show that follows.
            Standing::NoSeed => {
                self.custody = assessed.custody;
                self.quiet = assessed.synchronizing;
                self.mint(ctx)
            }
            // A SETTLED SEED AND NO VAULT ON THE PHONE: the app was deleted and
            // put back, and the keychain kept the key. This is the member's
            // FIRST vault here, so it asks nothing (no name, no own-words
            // choice, offered only for a further vault, R-ONBOARD-10 (4)) and
            // is made at the next index, as a quiet first make is.
            Standing::Settled if !assessed.holds_a_vault => {
                self.custody = assessed.custody;
                self.quiet = assessed.synchronizing;
                self.phase = Phase::Making;
                self.make(ctx)
            }
            // THE WORDS ALREADY ROOT THIS PHONE'S VAULTS: a name, and the choice
            // to keep this one on its own words (R-1047-E18); not ticked, the
            // next index with no words.
            Standing::Settled => {
                self.custody = assessed.custody;
                self.quiet = assessed.synchronizing;
                self.phase = Phase::Choose;
                Vec::new()
            }
            Standing::Unsettled => {
                self.phase = Phase::RestoreFirst;
                Vec::new()
            }
        }
    }

    fn mint(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.phase != Phase::Checking {
            return Vec::new();
        }
        let minted = super::door::mint(ctx).filter(|minted| minted.len() == WORDS);
        let Some(minted) = minted else {
            self.fail(words::mint_failed(ctx.locale()), Retry::Mint);
            return Vec::new();
        };
        // THE KEYCHAIN WILL HOLD IT: kept without being shown (R-ONBOARD-10). A
        // vault on its own key is always shown: its key is filed in the main
        // vault's Locker too, but that is a copy the member should know of.
        if self.quiet && !self.own {
            self.phase = Phase::Making;
            self.phrase.clone_from(&minted);
            return self.begin(Job::keep(minted, true, false), ctx);
        }
        self.phase = Phase::Show;
        self.phrase = minted;
        Vec::new()
    }

    fn kept(
        &mut self,
        refusal: Option<Refusal>,
        own: Option<String>,
        ctx: &Ctx,
    ) -> Vec<wire::Effect> {
        if self.phase != Phase::Making {
            return Vec::new();
        }
        let locale = ctx.locale();
        match refusal {
            // KEPT: the words are dropped here, and the vault is founded, on its
            // own entry when it has one.
            None => {
                self.phrase.clear();
                if own.is_some() {
                    self.own_id = own;
                }
                self.make(ctx)
            }
            Some(Refusal::DifferentWords) => {
                self.phrase.clear();
                self.fail(words::different_words(locale), Retry::None);
                Vec::new()
            }
            Some(Refusal::NotAPhrase) => {
                self.phrase.clear();
                self.fail(words::mint_failed(locale), Retry::Mint);
                Vec::new()
            }
            // The words are still held, so "Try again" keeps the same ones.
            Some(Refusal::StoreRefused) => {
                self.fail(words::keep_failed(locale), Retry::Keep);
                Vec::new()
            }
        }
    }

    fn make(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let name = self.name.trim().to_owned();
        self.begin(
            Job::make(self.own_id.clone(), (!name.is_empty()).then_some(name.as_str())),
            ctx,
        )
    }

    fn made(&mut self, found: Found, locale: Locale) -> Vec<wire::Effect> {
        if self.phase != Phase::Making {
            return Vec::new();
        }
        match found {
            // NO "VAULT READY" SCREEN: the sheet closes onto Home, and the
            // sentence it would have said rides on the closed view for Home's
            // status line to take.
            Found::Made(vault_name) => {
                self.made_line = fill(
                    &if self.own {
                        words::made_own_body(locale)
                    } else {
                        words::made_body(locale)
                    },
                    &[("name", &vault_name)],
                );
                self.phrase.clear();
                self.finished = true;
            }
            Found::Refused(why) => {
                let sentence = match why {
                    FoundRefusal::NoCore => words::found_no_core(locale),
                    FoundRefusal::NotFounded => words::found_not_founded(locale),
                    FoundRefusal::AlreadyHeld => words::found_already_held(locale),
                };
                self.fail(sentence, Retry::Make);
            }
            Found::NoSession => self.fail(words::still_opening(locale), Retry::Make),
        }
        Vec::new()
    }

    fn fail(&mut self, notice: String, retry: Retry) {
        self.phase = Phase::Failed;
        self.notice = notice;
        self.retry = retry;
    }

    /// Keep the shown words: as the member's seed, or as this vault's own.
    fn keep(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let phrase = self.phrase.clone();
        let job = if self.own {
            Job::keep_own(phrase, self.name.trim())
        } else {
            Job::keep(phrase, true, true)
        };
        self.begin(job, ctx)
    }

    fn primary(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        match self.phase {
            // "MAKE VAULT": on the member's words now, or, kept on its own,
            // after fresh words are minted and shown (R-1047-E18).
            Phase::Choose if !self.own => {
                self.phase = Phase::Making;
                self.make(ctx)
            }
            Phase::Choose if self.name.trim().is_empty() => Vec::new(),
            Phase::Choose => {
                self.phase = Phase::Checking;
                self.mint(ctx)
            }
            // "I HAVE SAVED THEM": the core turns the words into the seed and
            // keeps it.
            Phase::Show => {
                self.phase = Phase::Making;
                self.notice.clear();
                self.keep(ctx)
            }
            Phase::Failed => match self.retry {
                Retry::Mint => {
                    self.reset();
                    self.begin(Job::assess(), ctx)
                }
                Retry::Keep => {
                    self.phase = Phase::Making;
                    self.notice.clear();
                    self.keep(ctx)
                }
                Retry::Make => {
                    self.phase = Phase::Making;
                    self.notice.clear();
                    self.make(ctx)
                }
                Retry::None => self.leave(),
            },
            _ => Vec::new(),
        }
    }

    fn secondary(&mut self) -> Vec<wire::Effect> {
        match self.phase {
            Phase::Choose | Phase::Show | Phase::Failed | Phase::RestoreFirst => self.leave(),
            _ => Vec::new(),
        }
    }

    /// Open again from the top: what "Try again" after a refused mint does.
    fn reset(&mut self) {
        self.phase = Phase::Checking;
        self.phrase.clear();
        self.custody.clear();
        self.quiet = false;
        self.notice.clear();
        self.retry = Retry::None;
        self.own = false;
        self.name.clear();
        self.own_id = None;
    }

    /// CLOSE, and drop an entry kept for a vault that was never made: words the
    /// member wrote down for a found that did not happen key nothing.
    fn leave(&mut self) -> Vec<wire::Effect> {
        self.phrase.clear();
        self.finished = true;
        match self.own_id.take() {
            Some(id) => vec![super::secrets::effect(self.secrets.forget_own_seed(&id))],
            None => Vec::new(),
        }
    }

    fn event(&mut self, event: wire::WordsMakeEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::words_make_event::Kind as K;
        let choosing = self.phase == Phase::Choose;
        match event.kind {
            Some(K::Dismissed(_)) => self.leave(),
            Some(K::Own(own)) if choosing => {
                self.own = own.on;
                Vec::new()
            }
            Some(K::Name(name)) if choosing => {
                self.name = name.text;
                Vec::new()
            }
            Some(K::Primary(_)) => self.primary(ctx),
            Some(K::Secondary(_)) => self.secondary(),
            // `restore` IS AN INTENT: the restore screen opens in this one's place.
            Some(K::Restore(_)) if self.phase == Phase::RestoreFirst => {
                let open = effect(wire::effect::Kind::OpenRoute(wire::OpenRoute {
                    route: Some(super::routes::restore_held()),
                }));
                let mut effects = self.leave();
                effects.push(open);
                effects
            }
            // "SAVE A COPY": the words, as one line, to the platform's share sheet.
            Some(K::SaveCopy(_)) if self.phase == Phase::Show => {
                vec![effect(wire::effect::Kind::Share(wire::Share {
                    text: self.phrase.join(" "),
                    url: String::new(),
                    subject: words::save_subject(ctx.locale()),
                }))]
            }
            _ => Vec::new(),
        }
    }
}

impl Screen for Make {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.finished {
            return Vec::new();
        }
        match event.kind {
            Some(E::Appeared(_)) if !self.started => {
                self.started = true;
                self.phase = Phase::Checking;
                self.begin(Job::assess(), ctx)
            }
            Some(E::EffectResult(result)) => self.answered(&result, ctx),
            Some(E::WordsMake(event)) => self.event(event, ctx),
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::WordsMake(self.render(ctx.locale()))),
            ..wire::ViewState::default()
        }
    }
}

impl Make {
    /// Every word the screen says, for the phase.
    fn render(&self, locale: Locale) -> wire::WordsMakeState {
        let phase = self.phase;
        let show = phase == Phase::Show && !self.finished;
        let own_name = self.name.trim().to_owned();
        let name = [("name", own_name.as_str())];
        let title = match phase {
            Phase::Choose => words::choose_title(locale),
            Phase::Show if self.own => fill(&words::show_own_title(locale), &name),
            Phase::Show => words::show_title(locale),
            Phase::Failed => words::failed_title(locale),
            Phase::RestoreFirst => words::restore_first_title(locale),
            _ => words::making_title(locale),
        };
        let body = match phase {
            Phase::Choose if self.own => words::choose_own_body(locale),
            Phase::Choose => words::choose_body(locale),
            Phase::Show if self.own => fill(&words::show_own_body(locale), &name),
            Phase::Show => words::show_body(locale),
            Phase::RestoreFirst => words::restore_first_body(locale),
            Phase::Making | Phase::Checking => words::making_body(locale),
            Phase::Failed | Phase::Unspecified => String::new(),
        };
        let primary = match phase {
            Phase::Choose => words::choose_primary(locale),
            Phase::Show => words::show_primary(locale),
            Phase::Failed if self.retry == Retry::None => words::done(locale),
            Phase::Failed => words::try_again(locale),
            _ => String::new(),
        };
        let secondary = match phase {
            Phase::Choose | Phase::Show | Phase::RestoreFirst => words::cancel(locale),
            Phase::Failed if self.retry != Retry::None => words::cancel(locale),
            _ => String::new(),
        };
        let cells = if show {
            self.phrase
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
        };
        // A VAULT ON ITS OWN WORDS NEEDS A NAME: it is how a restore lists it.
        let enabled = !primary.is_empty() && !(phase == Phase::Choose && self.own && own_name.is_empty());
        let accessibility = if show {
            words::show_a11y(locale)
        } else {
            [title.as_str(), self.notice.as_str()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(". ")
        };
        wire::WordsMakeState {
            phase: phase as i32,
            secure: show,
            title,
            body,
            words: cells,
            primary_label: primary,
            primary_enabled: enabled,
            secondary_label: secondary,
            notice: self.notice.clone(),
            // NO CHECKBOX (R-ONBOARD-10): the words are shown only where the
            // keychain will not hold the key, and the platform's sentence says
            // so; keeping it off the keychain is the Backup tab's, after the
            // vault exists.
            custody: if show && !self.own {
                self.custody.clone()
            } else {
                String::new()
            },
            restore_label: if phase == Phase::RestoreFirst {
                words::restore_first_action(locale)
            } else {
                String::new()
            },
            accessibility_label: accessibility,
            save_label: if show { words::save_label(locale) } else { String::new() },
            own_label: if phase == Phase::Choose { words::own_label(locale) } else { String::new() },
            own_on: phase == Phase::Choose && self.own,
            name_label: if phase == Phase::Choose { words::name_label(locale) } else { String::new() },
            name: if phase == Phase::Choose { self.name.clone() } else { String::new() },
            finished: self.finished,
            made_line: if self.finished { self.made_line.clone() } else { String::new() },
        }
    }
}
