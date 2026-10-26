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
//! A restore's DONE that names vaults which stayed with the old phone offers
//! `retry_label`: it asks the gateway again for those indices alone, from the
//! seed the restore stored, over the lists already drawn, never the grid again.

use std::fmt;

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;
use wire::words_enter_state::Phase;
use wire::{WordsEnterOrigin as Origin, WordsEnterPurpose as Purpose};

use super::door::{self, Judged, RestoredVaultAt, UnclaimedVaultAt, Verdict};
use super::enrollment::{Env, Job, Out, Progress, Refusal, Rekeyed, Restored, Runner};
use super::keeper::{Absent, Keeper, KeeperSlot};
use super::secrets::{VaultSecrets, WORDS};
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
    Refusal(Refusal),
    RekeyNone,
    StayedStill,
    PhotoUnread,
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
    /// DONE after a restore: every vault here, as the core answered it. Carries
    /// no secret.
    restored_at: Vec<RestoredVaultAt>,
    /// DONE after a restore: every vault that stayed, by seed and index.
    stayed_at: Vec<UnclaimedVaultAt>,
    restored: Vec<wire::RestoredVaultLine>,
    stayed: Vec<String>,
    /// A held-seed restore: the name of each vault on its own words it will
    /// also ask for (R-1047-E18).
    held_keys: Vec<String>,
    /// WORKING on a retry of what stayed, over DONE's lists.
    retrying: bool,
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
            started: false,
            finished: false,
            loading: false,
            cells: blank_cells(),
            endpoint: String::new(),
            camera: false,
            verdict: None,
            notice: Notice::None,
            offer_restore: false,
            restored_at: Vec::new(),
            stayed_at: Vec::new(),
            restored: Vec::new(),
            stayed: Vec::new(),
            held_keys: Vec::new(),
            retrying: false,
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
        let typed = self.cells.clone();
        if self.offer_restore {
            self.purpose = Purpose::Restore;
            self.work();
            return self.begin(Job::restore(typed, &self.endpoint), ctx);
        }
        if self.purpose == Purpose::RestoreHeld {
            self.work();
            return self.begin(Job::held(&self.endpoint), ctx);
        }
        if !self.valid() {
            return Vec::new();
        }
        self.work();
        if self.purpose == Purpose::Rekey {
            self.begin(Job::rekey(typed), ctx)
        } else {
            self.begin(Job::restore(typed, &self.endpoint), ctx)
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

    /// ASK AGAIN FOR WHAT STAYED (R-1047-R6): DONE with any vault that stayed,
    /// and no retry already running. The indices are the ones the core named;
    /// the vaults already here are not asked for.
    fn retry(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.phase != Phase::Done || self.stayed_at.is_empty() {
            return Vec::new();
        }
        self.phase = Phase::Working;
        self.retrying = true;
        self.notice = Notice::None;
        let stayed = self.stayed_at.clone();
        self.begin(Job::stayed(&stayed, &self.endpoint), ctx)
    }

    fn restored(&mut self, outcome: Restored) {
        if self.phase != Phase::Working {
            return;
        }
        if self.retrying {
            self.retried(outcome);
            return;
        }
        match outcome {
            // THE WORDS GO; the pairing code stays, for a retry of what stayed.
            Restored::Done {
                answer, missing, ..
            } => {
                let endpoint = std::mem::take(&mut self.endpoint);
                self.fresh(Phase::Done, Purpose::Restore, Origin::Unspecified);
                self.endpoint = endpoint;
                self.settled(answer.vaults, answer.unclaimed, &missing);
            }
            Restored::Unreachable => self.back(Notice::Unreachable),
            Restored::NothingHeld => self.back(Notice::NothingHeld),
            Restored::NotTaken => self.back(Notice::NotTaken),
            Restored::DidNotCheck => self.back(Notice::DidNotCheck),
            Restored::Refused(why) => self.back(Notice::Refusal(why)),
        }
    }

    /// A RETRY'S ANSWER. What came back joins the vaults already here; what did
    /// not still stayed. A refusal changes neither list and says why, and the
    /// retry is offered again.
    fn retried(&mut self, outcome: Restored) {
        self.phase = Phase::Done;
        self.retrying = false;
        self.notice = Notice::None;
        match outcome {
            Restored::Done { answer, .. } => {
                let back: Vec<(Option<String>, u32)> = answer
                    .vaults
                    .iter()
                    .map(|vault| (vault.own.clone(), vault.index))
                    .collect();
                let mut vaults: Vec<RestoredVaultAt> = std::mem::take(&mut self.restored_at)
                    .into_iter()
                    .filter(|vault| !back.contains(&(vault.own.clone(), vault.index)))
                    .collect();
                vaults.extend(answer.vaults);
                let stayed: Vec<UnclaimedVaultAt> = std::mem::take(&mut self.stayed_at)
                    .into_iter()
                    .filter(|vault| !back.contains(&(vault.own.clone(), vault.index)))
                    .collect();
                self.settled(vaults, stayed, &[]);
            }
            Restored::Unreachable => self.notice = Notice::Unreachable,
            _ => self.notice = Notice::StayedStill,
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
        self.restored_at.clear();
        self.stayed_at.clear();
        self.restored.clear();
        self.stayed.clear();
        self.held_keys.clear();
        self.retrying = false;
    }

    /// DONE after a restore: the vaults here and the ones that stayed.
    ///
    /// "VAULT N" IS ONE SEQUENCE over both, ordered by derivation index
    /// (R-1047-R5), so a vault that stayed is never given the number of one that
    /// came back. Never the index itself: a member made "Vault 1", not "index
    /// 0". The member's vaults come first; each vault on its own words
    /// (R-1047-E18) follows, its seed's vaults in index order: two vaults at
    /// index 0 under two seeds are two numbers, never one.
    fn settled(
        &mut self,
        restored: Vec<RestoredVaultAt>,
        stayed: Vec<UnclaimedVaultAt>,
        missing: &[String],
    ) {
        let order = |own: &Option<String>, index: u32| {
            (own.is_some(), own.clone().unwrap_or_default(), index)
        };
        let mut sequence: Vec<(bool, String, u32)> = restored
            .iter()
            .map(|vault| order(&vault.own, vault.index))
            .chain(stayed.iter().map(|vault| order(&vault.own, vault.index)))
            .collect();
        sequence.sort();
        sequence.dedup();
        let ordinal = |own: &Option<String>, index: u32| {
            sequence
                .iter()
                .position(|entry| *entry == order(own, index))
                .map_or(0, |at| at + 1)
        };
        let mut sorted = restored;
        sorted.sort_by_key(|vault| order(&vault.own, vault.index));
        self.restored = sorted
            .iter()
            .map(|vault| self.restored_line(ordinal(&vault.own, vault.index), vault))
            .collect();
        self.stayed = stayed
            .iter()
            .map(|vault| {
                fill(
                    &words::restored_stayed(self.locale),
                    &[("index", &ordinal(&vault.own, vault.index).to_string())],
                )
            })
            .chain(missing.iter().map(|name| {
                let name = if name.trim().is_empty() {
                    words::restore_held_own_unnamed(self.locale)
                } else {
                    name.clone()
                };
                fill(&words::restored_missing(self.locale), &[("name", &name)])
            }))
            .collect();
        self.restored_at = sorted;
        self.stayed_at = stayed;
    }

    fn restored_line(&self, number: usize, vault: &RestoredVaultAt) -> wire::RestoredVaultLine {
        let locale = self.locale;
        let index = number.to_string();
        let line = match vault.rows {
            1 => fill(&words::restored_line_one(locale), &[("index", &index)]),
            rows if rows > 0 => fill(
                &words::restored_line_many(locale),
                &[("index", &index), ("rows", &grouped(rows))],
            ),
            _ => fill(&words::restored_line_none(locale), &[("index", &index)]),
        };
        wire::RestoredVaultLine {
            line,
            safety_number: vault.safety_number.clone(),
            safety_label: if vault.safety_number.is_empty() {
                String::new()
            } else {
                words::restored_safety(locale)
            },
        }
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
            Some(K::Retry(_)) => self.retry(ctx),
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
            Notice::Refusal(Refusal::NotAPhrase) => words::not_a_phrase(locale),
            Notice::Refusal(Refusal::DifferentWords) => words::different_words(locale),
            Notice::Refusal(Refusal::StoreRefused) => words::keep_failed(locale),
            Notice::RekeyNone => words::rekey_none(locale),
            Notice::StayedStill => words::restore_stayed_still(locale),
            Notice::PhotoUnread => words::pair_photo_unread(locale),
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
        // A RETRY OF WHAT STAYED draws DONE's lists under its progress: the words
        // are gone, so no grid and no address box come back.
        let answered = done || self.retrying;
        if self.loading {
            return wire::WordsEnterState {
                phase: Phase::Working as i32,
                purpose: self.purpose as i32,
                ..wire::WordsEnterState::default()
            };
        }
        let grid = !held
            && !self.finished
            && !self.retrying
            && (phase == Phase::Entering || phase == Phase::Working);
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
        let title = if done && rekey {
            words::rekeyed_title(locale)
        // NOT "YOUR VAULTS ARE BACK" when one of them is not (R-1047-R5).
        } else if answered && !self.stayed.is_empty() {
            words::restored_some_title(locale)
        } else if done {
            words::restored_title(locale)
        } else if rekey {
            words::rekey_title(locale)
        } else if held {
            words::restore_held_title(locale)
        } else {
            words::restore_title(locale)
        };
        let body = if done && from_pairing {
            words::rekeyed_pair_body(locale)
        } else if done && rekey {
            words::rekeyed_body(locale)
        // WHAT BECOMES OF WHAT STAYED, and that it can be asked for again.
        } else if answered && !self.stayed.is_empty() {
            words::restored_stayed_body(locale)
        } else if done {
            String::new()
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
        let scans = self.restores() && !answered && entering;
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
            purpose: self.purpose as i32,
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
            endpoint_label: if self.restores() && !answered {
                words::endpoint_label(locale)
            } else {
                String::new()
            },
            endpoint: if self.restores() && !answered {
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
            restored: self.restored.clone(),
            stayed: self.stayed.clone(),
            retry_label: if done && !rekey && !self.stayed_at.is_empty() {
                words::restored_stayed_retry(locale)
            } else {
                String::new()
            },
            words_label: if held && entering {
                words::restore_held_words(locale)
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

/// 1204 as "1,204".
fn grouped(rows: i64) -> String {
    let digits = rows.unsigned_abs().to_string();
    let mut out = String::new();
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    if rows < 0 { format!("-{out}") } else { out }
}

impl Screen for Enter {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        self.locale = ctx.locale();
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
            Some(E::EffectResult(result)) => self.answered(&result, ctx),
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
