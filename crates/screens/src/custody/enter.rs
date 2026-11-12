//! TYPE THE 24 WORDS BACK (`words.enter`; #1047 E1, R-1047-E3/E5).
//!
//! One grid, three purposes:
//!
//! * **Restore**: a fresh install, or a phone told to restore first. The words
//!   bring every vault back from the gateway whose pairing code is pasted (or
//!   scanned) beside them. The control waits for both (#1080 A23).
//! * **Rekey**: Locker's "needs your 24 words" wall, or pairing's NEEDS_WORDS.
//!   The words go back to this phone's own vaults, which reopen keyed. The
//!   origin names which door, and the body explains the words in that door's
//!   terms (#1047 F5). When no vault here has an index to key, the screen
//!   offers the restore instead, keeping what was typed and drawing the pairing
//!   code's field.
//! * **Restore from the held seed**: the phone already holds a seed the
//!   synchronised keychain carried here: no grid, only the gateway's pairing
//!   code, and the restore runs from that seed once it is pasted (Q-1047-18).
//!   `words_label` leaves it for the grid, for a member whose keychain key is
//!   not the one their backup was sealed with. **A restore opened while a seed
//!   is held restores from it**: asking for 24 words the member need not have
//!   kept would hide the restore that needs none.
//!
//! Every cell is judged by the CORE as it is typed (`PhraseRequest.check`, a
//! fast door): a list word or not, suggestions for a prefix, and the phrase's
//! verdict, in order: count, an unknown word, the checksum. The primary control
//! opens only on a VALID verdict for exactly what is on screen: the verdict is
//! computed with each edit, so it can never be for other words. The words are
//! dropped the moment a restore or a re-key succeeds, and on leaving.
//!

use std::fmt;

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;
use wire::words_enter_state::Phase;
use wire::{WordsEnterOrigin as Origin, WordsEnterPurpose as Purpose};

use super::door::{self, Judged, Verdict};
use super::enrollment::{Env, Job, Out, Progress, Refusal, Rekeyed, Restored, Runner};
use super::keeper::{Absent, Keeper, KeeperSlot};
use super::secrets::{VaultSecrets, WORDS};
use crate::kit::owner::{Answer, Leaving, NoPasscode, OwnerGate};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, custody as words, fill};

#[must_use]
pub fn build(
    secrets: &VaultSecrets,
    keeper: &KeeperSlot,
    route: &wire::Route,
) -> Option<Box<dyn Screen>> {
    let (purpose, origin) = match &route.args {
        Some(wire::route::Args::WordsEnter(args)) => (
            Purpose::try_from(args.purpose).unwrap_or(Purpose::Unspecified),
            Origin::try_from(args.origin).unwrap_or(Origin::Unspecified),
        ),
        _ => (Purpose::Unspecified, Origin::Unspecified),
    };
    Some(Box::new(Enter::new(
        secrets.clone(),
        keeper.clone(),
        purpose,
        origin,
    )))
}

/// A sentence the screen says about what just happened, kept as the fact so it
/// is worded in the viewer's locale when drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Notice {
    /// The phrase's own verdict, when the words on screen have one worth saying.
    None,
    Unreachable,
    NothingHeld,
    NotTaken,
    DidNotCheck,
    CantOpen,
    NewerBuild,
    Refusal(Refusal),
    RekeyNone,
    PhotoUnread,
    /// The owner check's own sentence (`Enter::owner_line`).
    Owner,
}

/// `words.enter`'s machine. **Redacted**: `cells` are the member's words.
pub struct Enter {
    secrets: VaultSecrets,
    keeper: KeeperSlot,
    runner: Runner,
    phase: Phase,
    purpose: Purpose,
    origin: Origin,
    /// The locale of the last event, for sentences made when an answer lands.
    locale: Locale,
    /// The platform of the last event ("ios", "android"), for where a held key came from.
    platform: String,
    started: bool,
    finished: bool,
    /// The seed question is still being read: nothing is drawn yet.
    loading: bool,
    cells: Vec<String>,
    endpoint: String,
    /// Whether the shell can scan with a camera.
    camera: bool,
    verdict: Option<Verdict>,
    notice: Notice,
    /// A re-key found nothing to key; the primary control restores instead.
    offer_restore: bool,
    /// A held-seed restore: the name of each vault on its own words it will
    /// also ask for (R-1047-E18).
    held_keys: Vec<String>,
    /// The owner check a restore asks first; a brand-new phone may have no
    /// passcode, so it warns and goes ahead.
    gate: OwnerGate,
    /// What the check was raised for.
    going: Option<Go>,
    /// The sentence the check left for the notice line.
    owner_line: String,
}

/// The restore that waits on the owner check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Go {
    /// A re-key found nothing to key: restore with the typed words.
    Offered,
    /// A held-seed restore.
    Held,
    /// The words on screen, restored.
    Typed,
}

impl fmt::Debug for Enter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Enter(phase={:?}, purpose={:?}, <redacted>)",
            self.phase, self.purpose
        )
    }
}

fn blank_cells() -> Vec<String> {
    vec![String::new(); WORDS]
}

impl Enter {
    fn new(secrets: VaultSecrets, keeper: KeeperSlot, purpose: Purpose, origin: Origin) -> Self {
        Self {
            secrets,
            keeper,
            runner: Runner::default(),
            phase: Phase::Entering,
            purpose: if purpose == Purpose::Unspecified {
                Purpose::Restore
            } else {
                purpose
            },
            origin,
            locale: Locale::En,
            platform: String::new(),
            started: false,
            finished: false,
            loading: false,
            cells: blank_cells(),
            endpoint: String::new(),
            camera: false,
            verdict: None,
            notice: Notice::None,
            offer_restore: false,
            held_keys: Vec::new(),
            gate: OwnerGate::default(),
            going: None,
            owner_line: String::new(),
        }
    }

    /// Whether any word is held. For the tests; never the words.
    #[must_use]
    pub fn holds_words(&self) -> bool {
        self.cells.iter().any(|cell| !cell.is_empty())
    }

    /// Whether the primary control restores: every purpose but a re-key, and a
    /// re-key that found nothing to key and offers the restore instead. Such a
    /// control needs the gateway's pairing code (#1080 A23).
    fn restores(&self) -> bool {
        self.purpose != Purpose::Rekey || self.offer_restore
    }

    /// The core called exactly these words a phrase.
    fn valid(&self) -> bool {
        self.verdict
            .as_ref()
            .is_some_and(|verdict| verdict.verdict == Judged::Valid)
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
            Some(progress) => self.progressed(progress),
            None => Vec::new(),
        }
    }

    fn off_thread(&mut self, done: &wire::OffThreadDone, ctx: &Ctx) -> Vec<wire::Effect> {
        let keeper = self.keeper.get();
        let absent = Absent;
        let keeper: &dyn Keeper = keeper.as_deref().unwrap_or(&absent);
        let env = Env {
            ctx,
            secrets: &self.secrets,
            keeper,
        };
        match self.runner.off_thread(done, &env) {
            Some(progress) => self.progressed(progress),
            None => Vec::new(),
        }
    }

    fn progressed(&mut self, progress: Progress) -> Vec<wire::Effect> {
        if let Some(out) = progress.out {
            // A late answer to a screen that was left changes nothing.
            if !self.finished {
                self.job_done(out);
            }
        }
        progress.effects
    }

    fn job_done(&mut self, out: Out) {
        match out {
            Out::Done => self.opened(),
            Out::Restored(outcome) => self.restored(outcome),
            Out::Rekeyed(outcome) => self.rekeyed(outcome),
            _ => {}
        }
    }

    /// A RESTORE OPENED WHILE A SEED IS HELD RESTORES FROM IT. iCloud Keychain,
    /// or Block Store inside Android's setup wizard, may have put the key on
    /// this phone before the app first ran. A vault on its own words the
    /// keychain carried counts as held too (R-1047-E18).
    fn opened(&mut self) {
        if !self.loading {
            return;
        }
        self.loading = false;
        let owned = self.secrets.own_seeds();
        if self.secrets.seed().is_some() || !owned.is_empty() {
            self.purpose = Purpose::RestoreHeld;
        }
        if self.purpose == Purpose::RestoreHeld {
            self.held_keys = owned.into_iter().map(|entry| entry.label).collect();
        }
    }

    /// A CELL TYPED, AND THE WORDS THAT RAN ON. Typing "abandon ability" into
    /// cell 3 fills 3 and 4: the space is how a member moves to the next word,
    /// and a grid that swallowed it would make them tap 24 boxes. Nothing here
    /// reads the clipboard; this is what the keyboard sent.
    fn spread(&mut self, position: u32, text: &str) {
        let at = position as usize;
        if !(1..=WORDS).contains(&at) {
            return;
        }
        let parts: Vec<&str> = text.split([' ', '\n', '\t']).collect();
        if parts.len() <= 1 {
            self.cells[at - 1] = text.to_owned();
            return;
        }
        let mut at = at - 1;
        for (index, part) in parts.iter().enumerate() {
            if at >= WORDS {
                return;
            }
            if part.is_empty() && index > 0 {
                continue;
            }
            self.cells[at] = (*part).to_owned();
            at += 1;
        }
    }

    fn edited(&mut self, ctx: &Ctx) {
        self.notice = Notice::None;
        self.offer_restore = false;
        self.verdict = door::check(ctx, &self.cells);
    }

    fn entering(&self) -> bool {
        self.phase == Phase::Entering && !self.loading
    }

    fn primary(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.phase == Phase::Done {
            self.close();
            return Vec::new();
        }
        if !self.entering() {
            return Vec::new();
        }
        // A RESTORE NAMES ITS GATEWAY (#1080 A23): the core refuses one with no
        // pairing code, and that refusal would read as "could not reach your
        // backup device". The control is disabled; a stray tap does nothing.
        if self.restores() && self.endpoint.trim().is_empty() {
            return Vec::new();
        }
        if self.gate.asking() {
            return Vec::new();
        }
        let go = if self.offer_restore {
            Go::Offered
        } else if self.purpose == Purpose::RestoreHeld {
            Go::Held
        } else if !self.valid() {
            return Vec::new();
        } else if self.purpose == Purpose::Rekey {
            // A re-key restores nothing: no owner check.
            self.work();
            return self.begin(Job::rekey(self.cells.clone()), ctx);
        } else {
            Go::Typed
        };
        // A RESTORE ASKS THE OWNER CHECK BEFORE IT STARTS (not on open).
        self.going = Some(go);
        self.notice = Notice::None;
        self.gate.begin(ctx.locale(), Leaving::Restore)
    }

    /// The restore the check was raised for, now that the phone said so.
    fn start(&mut self, go: Go, ctx: &Ctx) -> Vec<wire::Effect> {
        let typed = self.cells.clone();
        match go {
            Go::Offered => {
                self.purpose = Purpose::Restore;
                self.work();
                self.begin(Job::restore(typed, &self.endpoint), ctx)
            }
            Go::Held => {
                self.work();
                self.begin(Job::held(&self.endpoint), ctx)
            }
            Go::Typed => {
                self.work();
                self.begin(Job::restore(typed, &self.endpoint), ctx)
            }
        }
    }

    /// The owner check's answer.
    fn checked(&mut self, checked: &wire::OwnerChecked, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(go) = self.going.take() else {
            return Vec::new();
        };
        match self.gate.answer(ctx.locale(), NoPasscode::Warn, checked) {
            Some(Answer::Passed) => self.start(go, ctx),
            Some(Answer::PassedUnprotected(warning)) => {
                let effects = self.start(go, ctx);
                self.owner_line = warning;
                self.notice = Notice::Owner;
                effects
            }
            Some(Answer::Refused(sentence)) => {
                self.owner_line = sentence;
                self.notice = Notice::Owner;
                Vec::new()
            }
            Some(Answer::Cancelled) | None => Vec::new(),
        }
    }

    fn work(&mut self) {
        self.phase = Phase::Working;
        self.offer_restore = false;
        self.notice = Notice::None;
    }

    /// Leave, and drop every word.
    fn close(&mut self) {
        self.cells = blank_cells();
        self.verdict = None;
        self.finished = true;
    }

    /// A RESTORE'S ANSWER. Success leaves nothing to say here: the core brings
    /// the restored vault to the front and closes every screen, so the words go
    /// and the screen finishes. A refusal goes back to the grid with its reason.
    fn restored(&mut self, outcome: Restored) {
        if self.phase != Phase::Working {
            return;
        }
        match outcome {
            Restored::Done { .. } => {
                self.fresh(Phase::Entering, Purpose::Restore, Origin::Unspecified);
                self.close();
            }
            Restored::Unreachable => self.back(Notice::Unreachable),
            Restored::NothingHeld => self.back(Notice::NothingHeld),
            Restored::NotTaken => self.back(Notice::NotTaken),
            Restored::DidNotCheck => self.back(Notice::DidNotCheck),
            Restored::CantOpen => self.back(Notice::CantOpen),
            Restored::NewerBuild => self.back(Notice::NewerBuild),
            Restored::Refused(why) => self.back(Notice::Refusal(why)),
        }
    }

    fn rekeyed(&mut self, outcome: Rekeyed) {
        if self.phase != Phase::Working {
            return;
        }
        match outcome {
            Rekeyed::Done(_) => {
                let origin = self.origin;
                self.fresh(Phase::Done, Purpose::Rekey, origin);
            }
            // THE WORDS ARE KEPT ON SCREEN and the restore is offered: the
            // member typed 24 good words, and making them type them again to
            // reach the gateway would be a wall of our own making.
            Rekeyed::NoneToKey => {
                self.phase = Phase::Entering;
                self.notice = Notice::RekeyNone;
                self.offer_restore = true;
            }
            Rekeyed::Refused(why) => self.back(Notice::Refusal(why)),
        }
    }

    fn back(&mut self, notice: Notice) {
        self.phase = Phase::Entering;
        self.notice = notice;
    }

    /// Start the model over in `phase`: no words, no verdict, no lists.
    fn fresh(&mut self, phase: Phase, purpose: Purpose, origin: Origin) {
        self.phase = phase;
        self.purpose = purpose;
        self.origin = origin;
        self.cells = blank_cells();
        self.endpoint.clear();
        self.camera = false;
        self.verdict = None;
        self.notice = Notice::None;
        self.offer_restore = false;
        self.held_keys.clear();
    }

    fn event(&mut self, event: wire::WordsEnterEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::words_enter_event::Kind as K;
        let entering = self.entering();
        // A HELD-SEED RESTORE HAS NO GRID: a typed word has nowhere to land.
        let typing = entering && self.purpose != Purpose::RestoreHeld;
        match event.kind {
            Some(K::Typed(typed)) if typing => {
                self.spread(typed.position, &typed.text);
                self.edited(ctx);
                Vec::new()
            }
            Some(K::Picked(picked)) if typing => {
                let at = picked.position as usize;
                if (1..=WORDS).contains(&at) {
                    self.cells[at - 1] = picked.word;
                    self.edited(ctx);
                }
                Vec::new()
            }
            Some(K::Endpoint(endpoint)) if entering => {
                self.endpoint = endpoint.text;
                Vec::new()
            }
            // A SCAN FILLS THE CODE'S FIELD as a paste would; the restore still
            // waits for the primary, because the words may not be in yet.
            Some(K::Scanned(scanned)) if entering && self.restores() => {
                self.endpoint = scanned.payload;
                self.notice = Notice::None;
                Vec::new()
            }
            // A PHOTO WITH NO SQUARE keeps what was typed and says what to do.
            Some(K::Unread(_)) if entering && self.restores() => {
                self.notice = Notice::PhotoUnread;
                Vec::new()
            }
            Some(K::Capability(capability)) => {
                self.camera = capability.camera;
                Vec::new()
            }
            Some(K::Primary(_)) => self.primary(ctx),
            Some(K::Secondary(_) | K::Dismissed(_)) => {
                self.close();
                Vec::new()
            }
            // THE KEYCHAIN'S KEY IS NOT THE BACKUP'S: draw the grid, keep the code.
            Some(K::UseWords(_)) if entering && self.purpose == Purpose::RestoreHeld => {
                self.purpose = Purpose::Restore;
                self.notice = Notice::None;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// The verdict sentence, when the words on screen have one worth saying.
    fn verdict_notice(&self) -> String {
        let locale = self.locale;
        let Some(verdict) = &self.verdict else {
            return String::new();
        };
        let filled = self
            .cells
            .iter()
            .filter(|cell| !cell.trim().is_empty())
            .count();
        match verdict.verdict {
            Judged::Valid => String::new(),
            Judged::Incomplete => match filled {
                0 => String::new(),
                1 => words::count_one(locale),
                n => fill(&words::count_many(locale), &[("n", &n.to_string())]),
            },
            Judged::UnknownWord => fill(
                &words::unknown_word(locale),
                &[("n", &verdict.first_unknown.to_string())],
            ),
            Judged::BadChecksum => words::bad_checksum(locale),
            Judged::TooMany => words::count_too_many(locale),
        }
    }

    fn notice_text(&self) -> String {
        let locale = self.locale;
        match self.notice {
            Notice::None => String::new(),
            Notice::Unreachable => words::restore_unreachable(locale),
            Notice::NothingHeld => words::restore_nothing_held(locale),
            Notice::NotTaken => words::restore_not_taken(locale),
            Notice::DidNotCheck => words::restore_did_not_check(locale),
            Notice::CantOpen => words::restore_cant_open(locale),
            Notice::NewerBuild => words::restore_newer_build(locale),
            Notice::Refusal(Refusal::NotAPhrase) => words::not_a_phrase(locale),
            Notice::Refusal(Refusal::DifferentWords) => words::different_words(locale),
            Notice::Refusal(Refusal::StoreRefused) => words::keep_failed(locale),
            Notice::RekeyNone => words::rekey_none(locale),
            Notice::PhotoUnread => words::pair_photo_unread(locale),
            Notice::Owner => self.owner_line.clone(),
        }
    }

    /// Every word the screen says, for the phase.
    fn render(&self) -> wire::WordsEnterState {
        let locale = self.locale;
        let phase = self.phase;
        let rekey = self.purpose == Purpose::Rekey;
        // WHICH DOOR opened the re-key; an unnamed one is Locker's, the first.
        let from_pairing = rekey && self.origin == Origin::Pairing;
        let held = self.purpose == Purpose::RestoreHeld;
        let done = phase == Phase::Done;
        if self.loading {
            return wire::WordsEnterState {
                phase: Phase::Working as i32,
                ..wire::WordsEnterState::default()
            };
        }
        let grid = !held && !self.finished && (phase == Phase::Entering || phase == Phase::Working);
        let cells = if grid {
            self.cells
                .iter()
                .enumerate()
                .map(|(at, typed)| {
                    let judged = self
                        .verdict
                        .as_ref()
                        .and_then(|verdict| verdict.cells.get(at));
                    let prompt = fill(&words::word_prompt(locale), &[("n", &(at + 1).to_string())]);
                    wire::WordEntry {
                        position: u32::try_from(at + 1).unwrap_or(u32::MAX),
                        prompt: prompt.clone(),
                        typed: typed.clone(),
                        mark: if typed.trim().is_empty() {
                            wire::word_entry::Mark::Empty
                        } else if judged.is_some_and(|cell| cell.known) {
                            wire::word_entry::Mark::Known
                        } else {
                            wire::word_entry::Mark::Unknown
                        } as i32,
                        suggestions: if typed.trim().is_empty() {
                            Vec::new()
                        } else {
                            judged
                                .map(|cell| cell.suggestions.clone())
                                .unwrap_or_default()
                        },
                        accessibility_label: prompt,
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        // DONE IS A RE-KEY'S: a restore finishes the screen instead.
        let title = if done {
            words::rekeyed_title(locale)
        } else if rekey {
            words::rekey_title(locale)
        } else if held {
            words::restore_held_title(locale)
        } else {
            words::restore_title(locale)
        };
        let body = if done && from_pairing {
            words::rekeyed_pair_body(locale)
        } else if done {
            words::rekeyed_body(locale)
        } else if from_pairing {
            words::rekey_pair_body(locale)
        } else if rekey {
            words::rekey_body(locale)
        } else if held {
            words::restore_held_body(locale)
        } else {
            words::restore_body(locale)
        };
        let entering = phase == Phase::Entering;
        let primary = match phase {
            Phase::Entering if self.offer_restore => words::rekey_none_action(locale),
            Phase::Entering if rekey => words::rekey_primary(locale),
            Phase::Entering => words::restore_primary(locale),
            Phase::Done => words::done(locale),
            _ => String::new(),
        };
        // THE SCAN IS DRAWN WHEREVER THE CODE'S FIELD IS, and only while entering.
        let scans = self.restores() && !done && entering;
        let notice = if self.notice == Notice::None {
            if entering && !held {
                self.verdict_notice()
            } else {
                String::new()
            }
        } else {
            self.notice_text()
        };
        wire::WordsEnterState {
            phase: phase as i32,
            origin: if rekey {
                self.origin as i32
            } else {
                Origin::Unspecified as i32
            },
            // NOTHING SECRET IS ON A HELD-SEED RESTORE: no word, no seed.
            secure: grid,
            title: title.clone(),
            body,
            cells,
            // THE CODE'S FIELD IS DRAWN WHEREVER THE PRIMARY RESTORES (#1080
            // A23): every restore, and the re-key that offers one instead.
            endpoint_label: if self.restores() && !done {
                words::endpoint_label(locale)
            } else {
                String::new()
            },
            endpoint_placeholder: if self.restores() && !done {
                crate::strings::pairing::paste_label(locale)
            } else {
                String::new()
            },
            endpoint: if self.restores() && !done {
                self.endpoint.clone()
            } else {
                String::new()
            },
            scan_label: if scans {
                words::pair_scan(locale)
            } else {
                String::new()
            },
            scan_camera: scans && self.camera,
            photo_label: if scans && self.camera {
                words::pair_photo(locale)
            } else {
                String::new()
            },
            primary_enabled: match phase {
                Phase::Entering if self.restores() && self.endpoint.trim().is_empty() => false,
                Phase::Entering => held || self.offer_restore || self.valid(),
                Phase::Done => true,
                _ => false,
            },
            primary_label: primary,
            secondary_label: if entering {
                words::cancel(locale)
            } else {
                String::new()
            },
            progress: if phase == Phase::Working {
                if rekey {
                    words::rekeying(locale)
                } else {
                    words::restoring(locale)
                }
            } else {
                String::new()
            },
            words_label: if held && entering {
                words::restore_held_words(locale)
            } else {
                String::new()
            },
            held_found: if held && entering {
                words::restore_held_found(locale)
            } else {
                String::new()
            },
            held_place: if held && entering {
                super::held_place(locale, &self.platform)
            } else {
                String::new()
            },
            held_keys_label: if held && entering && !self.held_keys.is_empty() {
                words::restore_held_own_label(locale)
            } else {
                String::new()
            },
            held_keys: if held && entering {
                self.held_keys
                    .iter()
                    .map(|name| {
                        if name.trim().is_empty() {
                            words::restore_held_own_unnamed(locale)
                        } else {
                            name.clone()
                        }
                    })
                    .collect()
            } else {
                Vec::new()
            },
            accessibility_label: [title.as_str(), notice.as_str()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(". "),
            notice,
            finished: self.finished,
        }
    }
}

impl Screen for Enter {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        self.locale = ctx.locale();
        self.platform = ctx.platform().to_owned();
        if self.finished {
            return Vec::new();
        }
        match event.kind {
            Some(E::Appeared(_)) if !self.started => {
                self.started = true;
                if self.purpose == Purpose::Rekey {
                    return Vec::new();
                }
                // WHICH SEEDS THE KEYCHAIN CARRIED decides the grid: read the
                // stores before drawing it.
                self.loading = true;
                self.begin(Job::reload(), ctx)
            }
            Some(E::EffectResult(result)) => {
                use wire::effect_result::Outcome as O;
                if self.gate.asking() {
                    let checked = match &result.outcome {
                        Some(O::OwnerChecked(checked)) => Some(*checked),
                        // The prompt itself errored: the same as not recognised.
                        Some(O::Failed(_)) => Some(wire::OwnerChecked {
                            outcome: wire::owner_checked::Outcome::Failed as i32,
                            ..Default::default()
                        }),
                        _ => None,
                    };
                    if let Some(checked) = checked {
                        return self.checked(&checked, ctx);
                    }
                }
                self.answered(&result, ctx)
            }
            Some(E::Left(_)) => {
                self.going = None;
                self.gate.cancel()
            }
            Some(E::OffThreadDone(done)) => self.off_thread(&done, ctx),
            Some(E::WordsEnter(event)) => self.event(event, ctx),
            _ => Vec::new(),
        }
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::WordsEnter(self.render())),
            ..wire::ViewState::default()
        }
    }
}
