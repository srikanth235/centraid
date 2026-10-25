//! THE ORDER THE 24 WORDS ARE KEPT IN (#1047 E1, R-1047-E1...E5), as sagas.
//!
//! Each flow below has one order that is right and several that lose a member's
//! vaults. A flow is a [`Job`]: a state machine that asks the shell for one
//! thing at a time ([`Ask`]: a secret batch, the synchronised-store probe, or
//! a restore) and takes the answer ([`Reply`]) as input. The shell keeps bytes;
//! every decision is here. A [`Runner`] drives one job for a screen and folds
//! each secret answer into the shared cache before the job reads it.
//!
//! * **Making a vault** ([`Job::keep`], then [`Job::make`]): the words are
//!   minted, shown once, THEN their seed is stored and settled, THEN the vault
//!   is founded at the next index, keyed from its first commit. A crash between
//!   the store and the found leaves a phone that makes its vault from the same
//!   words next time.
//! * **Restoring** ([`Job::restore`]): the words are judged and seeded BEFORE
//!   the gateway is dialled; a phone already holding different words for vaults
//!   it keys treats them as a vault on its own words; the seed is stored only
//!   once the gateway brought something back; then each vault is held at the
//!   index the restore found it at.
//! * **Re-keying** ([`Job::rekey`], Locker's wall): the words are seeded,
//!   checked against any seed already here, stored, and every vault with a
//!   recorded index is reopened keyed. No gateway, and no index is ever guessed.
//! * **Restoring from the seed this phone already holds** ([`Job::held`],
//!   Q-1047-18): a seed that arrived through the synchronised keychain restores
//!   exactly what its words would. Nothing new is stored; the seed is settled
//!   once the gateway brought something back.
//! * **Asking again for what stayed** ([`Job::stayed`], R-1047-R6): the vaults
//!   a restore named as staying with the old phone, by index, from the seed
//!   that restore stored. The vaults already here are never laid down again.
//! * **A vault on its own words** ([`Job::keep_own`], then [`Job::make`] with
//!   its entry, R-1047-E18): the seed is kept under an entry of its own, never
//!   the member's slot, before the vault is founded on it at index 0.
//!
//! **The words are kept beside the seed** (Q-1047-19): whenever this phone
//! stores a seed from words it keeps the words device-only too, so Settings can
//! show them again. A job holds the words only until it is done.
//!
//! **Every job begins by reading the shell's stores again**: the cache is only
//! what the shell last said, and the shelf may have recorded an index since.

use std::fmt;

use centraid_api_proto::core_v1 as wire;

use super::door::{self, RestoreAnswer, RestoreRefusal, Source, UnclaimedVaultAt};
use super::keeper::{Found, Keeper, Restored as HeldAt};
use super::secrets::{self, OwnSeedWrite, SeedWrite, VaultSecrets, WORDS};
use crate::screen::Ctx;
use crate::strings::custody as words;

/// Why words were not kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    NotAPhrase,
    DifferentWords,
    StoreRefused,
}

/// What this phone holds before the make-vault flow starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    /// No seed: mint the words.
    NoSeed,
    /// A seed this phone may make vaults from: no words, the next index.
    Settled,
    /// A seed that arrived from elsewhere, with no record of its indices:
    /// restore first.
    Unsettled,
}

/// What assessing a phone found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Assessed {
    pub standing: Standing,
    /// The platform's sentence about where the key is kept.
    pub custody: String,
    /// Whether the synchronised store will take the key.
    pub synchronizing: bool,
    /// Whether a vault is already on the phone.
    pub holds_a_vault: bool,
}

/// What a restore came to.
#[derive(Clone, PartialEq, Eq)]
pub enum Restored {
    Done {
        answer: RestoreAnswer,
        added: usize,
        /// Vaults on their own words (R-1047-E18) whose key came back and for
        /// which the backup device held nothing, by name.
        missing: Vec<String>,
    },
    Unreachable,
    /// The gateway answered and holds nothing for these words. Nothing stored.
    NothingHeld,
    /// The gateway would not grant this phone the vault. Nothing stored.
    NotTaken,
    /// What the gateway sent did not pass this phone's check (#1047 R3).
    DidNotCheck,
    Refused(Refusal),
}

impl fmt::Debug for Restored {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Done { added, missing, .. } => {
                write!(f, "Done(added={added}, missing={})", missing.len())
            }
            Self::Unreachable => f.write_str("Unreachable"),
            Self::NothingHeld => f.write_str("NothingHeld"),
            Self::NotTaken => f.write_str("NotTaken"),
            Self::DidNotCheck => f.write_str("DidNotCheck"),
            Self::Refused(why) => write!(f, "Refused({why:?})"),
        }
    }
}

/// What a re-key came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rekeyed {
    Done(usize),
    /// No vault on this phone has an index recorded: only a restore can key them.
    NoneToKey,
    Refused(Refusal),
}

/// What a finished job answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Out {
    Assessed(Assessed),
    Kept(Option<Refusal>),
    OwnKept(Result<String, Refusal>),
    Made(Found),
    Restored(Restored),
    Rekeyed(Rekeyed),
    /// A job with no answer (a reload, a write) is finished.
    Done,
}

/// The one thing a job asks the shell for next.
pub enum Ask {
    Secrets(Vec<wire::SecretOp>),
    Probe,
    Restore(wire::RestoreRequest),
}

/// The shell's answer to an [`Ask`].
pub enum Reply {
    Secrets(Vec<wire::SecretAnswer>),
    Probe(wire::SyncedSecretsStatus),
    Restored(Result<RestoreAnswer, RestoreRefusal>),
}

enum Step<T> {
    Ask(Ask),
    Done(T),
}

/// What a job reads while it decides.
pub struct Env<'a, 'b> {
    pub ctx: &'a Ctx<'b>,
    pub secrets: &'a VaultSecrets,
    pub keeper: &'a dyn Keeper,
}

fn secrets_of(reply: Option<Reply>) -> Vec<wire::SecretAnswer> {
    match reply {
        Some(Reply::Secrets(answers)) => answers,
        _ => Vec::new(),
    }
}

/// The 24 words as the machinery wants them: trimmed and lowercased. `None`
/// when they are not 24 lowercase list-shaped words (the words write is then
/// skipped, as a refused write is: it costs only the Settings screen).
fn clean_words(typed: &[String]) -> Option<Vec<String>> {
    let cleaned: Vec<String> = typed.iter().map(|w| w.trim().to_lowercase()).collect();
    (cleaned.len() == WORDS
        && cleaned
            .iter()
            .all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase())))
    .then_some(cleaned)
}

fn stopped(because: RestoreRefusal) -> Restored {
    match because {
        RestoreRefusal::Unreachable => Restored::Unreachable,
        RestoreRefusal::NotTaken => Restored::NotTaken,
        RestoreRefusal::DidNotCheck => Restored::DidNotCheck,
    }
}

/// A DIFFERENT SEED IS ALREADY HERE AND THIS PHONE'S VAULTS OPEN WITH IT.
/// Replacing it would reopen them under keys they were never sealed with.
fn conflicts(secrets: &VaultSecrets, seed: &str) -> bool {
    secrets
        .seed()
        .is_some_and(|held| held != seed && secrets.any_vault_index())
}

fn held_at(answer: &RestoreAnswer) -> Vec<HeldAt> {
    answer
        .vaults
        .iter()
        .map(|vault| HeldAt {
            path: vault.path.clone(),
            index: vault.index,
            own: vault.own.clone(),
        })
        .collect()
}

/// Hold what a restore brought back, then ask for the stores again: the shelf
/// recorded each vault's index.
fn adopt(env: &Env, answer: &RestoreAnswer, added: &mut usize) -> Ask {
    let adopted = env.keeper.adopt_restored(&held_at(answer));
    *added += adopted.value;
    let mut ops = adopted.writes;
    ops.extend(VaultSecrets::load_ops());
    Ask::Secrets(ops)
}

// ---------------------------------------------------------------------------
// Storing a seed
// ---------------------------------------------------------------------------

/// STORE A SEED AND SETTLE IT: the synchronised write (falling back to this
/// phone when the platform will not take it), the read-back, then the words
/// beside it, the claim of a saved copy, and the settling.
struct Store {
    seed: String,
    words: Vec<String>,
    sync: bool,
    saved: bool,
    write: Option<SeedWrite>,
    stage: StoreStage,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StoreStage {
    Start,
    First,
    Second,
    Final,
}

impl Store {
    fn new(seed: String, words: Vec<String>, sync: bool, saved: bool) -> Self {
        Self {
            seed,
            words,
            sync,
            saved,
            write: None,
            stage: StoreStage::Start,
        }
    }

    fn step(&mut self, env: &Env, reply: Option<Reply>) -> Step<Result<(), Refusal>> {
        let mut reply = reply;
        loop {
            match self.stage {
                StoreStage::Start => {
                    let write = VaultSecrets::remember_seed(&self.seed, self.sync);
                    let first = write.first();
                    self.write = Some(write);
                    self.stage = StoreStage::First;
                    return Step::Ask(Ask::Secrets(first));
                }
                StoreStage::First => {
                    let answers = secrets_of(reply.take());
                    let second = self
                        .write
                        .as_ref()
                        .map(|write| write.second(&answers))
                        .unwrap_or_default();
                    self.stage = StoreStage::Second;
                    if !second.is_empty() {
                        return Step::Ask(Ask::Secrets(second));
                    }
                }
                StoreStage::Second => {
                    // `remember_seed` answers whether the platform SYNCHRONISES,
                    // not whether it stored: the cache holds what the platform
                    // said, and that is what says the seed is there.
                    if env.secrets.seed().as_deref() != Some(self.seed.as_str()) {
                        return Step::Done(Err(Refusal::StoreRefused));
                    }
                    // THE WORDS AFTER THE SEED (Q-1047-19): a phone that kept
                    // the seed and not the words still opens every vault; one
                    // that kept words for a seed it does not hold would show
                    // words that open nothing.
                    let mut ops = Vec::new();
                    if let Some(words) = clean_words(&self.words) {
                        ops.push(VaultSecrets::remember_words(&words));
                    }
                    if self.saved {
                        ops.push(VaultSecrets::mark_words_saved());
                    }
                    ops.push(VaultSecrets::settle_seed());
                    self.stage = StoreStage::Final;
                    return Step::Ask(Ask::Secrets(ops));
                }
                StoreStage::Final => return Step::Done(Ok(())),
            }
        }
    }
}

/// KEEP FRESH WORDS FOR ONE VAULT, before it is founded (R-1047-E18): the seed
/// under an entry of its own, and the words beside it, device-only.
struct KeepOwn {
    words: Vec<String>,
    label: String,
    sync: bool,
    id: String,
    seed: String,
    write: Option<OwnSeedWrite>,
    stage: OwnStage,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OwnStage {
    Start,
    First,
    Second,
    Forgetting,
    Words,
}

impl KeepOwn {
    fn new(words: Vec<String>, label: String, sync: bool) -> Self {
        Self {
            words,
            label,
            sync,
            id: String::new(),
            seed: String::new(),
            write: None,
            stage: OwnStage::Start,
        }
    }

    fn step(&mut self, env: &Env, reply: Option<Reply>) -> Step<Result<String, Refusal>> {
        let mut reply = reply;
        loop {
            match self.stage {
                OwnStage::Start => {
                    let Some(seed) = door::seed(env.ctx, &self.words) else {
                        return Step::Done(Err(Refusal::NotAPhrase));
                    };
                    self.id = VaultSecrets::fresh_entry_id();
                    let write =
                        env.secrets
                            .keep_own_seed(&self.id, &seed, &self.label, self.sync);
                    self.seed = seed;
                    let first = write.first();
                    self.write = Some(write);
                    self.stage = OwnStage::First;
                    if !first.is_empty() {
                        return Step::Ask(Ask::Secrets(first));
                    }
                }
                OwnStage::First => {
                    let answers = secrets_of(reply.take());
                    let second = self
                        .write
                        .as_ref()
                        .map(|write| write.second(&answers))
                        .unwrap_or_default();
                    self.stage = OwnStage::Second;
                    if !second.is_empty() {
                        return Step::Ask(Ask::Secrets(second));
                    }
                }
                OwnStage::Second => {
                    if env.secrets.own_seed(&self.id).as_deref() != Some(self.seed.as_str()) {
                        self.stage = OwnStage::Forgetting;
                        return Step::Ask(Ask::Secrets(env.secrets.forget_own_seed(&self.id)));
                    }
                    self.stage = OwnStage::Words;
                    if let Some(words) = clean_words(&self.words) {
                        return Step::Ask(Ask::Secrets(vec![VaultSecrets::remember_own_words(
                            &self.id, &words,
                        )]));
                    }
                }
                OwnStage::Forgetting => return Step::Done(Err(Refusal::StoreRefused)),
                OwnStage::Words => return Step::Done(Ok(self.id.clone())),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The jobs
// ---------------------------------------------------------------------------

/// One flow, and where it has got to. **Redacted**: a job holds the member's
/// words until it is done.
pub struct Job(Flow);

impl fmt::Debug for Job {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Job(<redacted>)")
    }
}

enum Flow {
    Assess(Assess),
    Keep(Keep),
    KeepOwn(KeepOwnJob),
    Make(Make),
    Restore(Box<RestoreJob>),
    Held(Held),
    Stayed(Stayed),
    Rekey(RekeyJob),
    Reload(bool),
    Write(Option<Vec<wire::SecretOp>>),
}

impl Job {
    /// Read what this phone holds: the seed, the platform's custody sentence
    /// and whether a vault is here.
    #[must_use]
    pub fn assess() -> Self {
        Self(Flow::Assess(Assess::default()))
    }

    /// Store `words`' seed and settle it, after the member saw them (`shown`)
    /// or while the keychain keeps them without being shown.
    #[must_use]
    pub fn keep(words: Vec<String>, sync: bool, shown: bool) -> Self {
        Self(Flow::Keep(Keep {
            words,
            sync,
            shown,
            store: None,
        }))
    }

    /// Keep fresh words for one vault under an entry of its own.
    #[must_use]
    pub fn keep_own(words: Vec<String>, label: &str) -> Self {
        Self(Flow::KeepOwn(KeepOwnJob {
            inner: KeepOwn::new(words, label.to_owned(), true),
        }))
    }

    /// Found a vault at the next index, or on entry `own`'s seed; the seed is
    /// already stored. A vault on its own key is recorded as STILL TO BE FILED
    /// in the main vault's Locker (R-ONBOARD-10): the core seals a Locker
    /// secret only while that Locker is unlocked, so `filing` files it on the
    /// member's next unlock there.
    #[must_use]
    pub fn make(own: Option<String>, name: Option<&str>) -> Self {
        let name = name
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned);
        Self(Flow::Make(Make {
            own,
            name,
            found: None,
        }))
    }

    /// Bring this member's vaults back from `words`.
    #[must_use]
    pub fn restore(words: Vec<String>, payload: &str) -> Self {
        Self(Flow::Restore(Box::new(RestoreJob {
            words,
            payload: payload.trim().to_owned(),
            stage: RestoreStage::Start,
            seed: String::new(),
            as_own: false,
            answer: RestoreAnswer::default(),
            store: None,
            own: None,
            added: 0,
        })))
    }

    /// Bring them back from the seed already here, and each vault on its own
    /// words the keychain carried.
    #[must_use]
    pub fn held(payload: &str) -> Self {
        Self(Flow::Held(Held {
            payload: payload.trim().to_owned(),
            stage: HeldStage::Start,
            targets: Vec::new(),
            at: 0,
            answers: Vec::new(),
            missing: Vec::new(),
            refusal: None,
            added: 0,
        }))
    }

    /// Ask again for the vaults a restore named as staying.
    #[must_use]
    pub fn stayed(stayed: &[UnclaimedVaultAt], payload: &str) -> Self {
        // ONE ASK PER SEED: the member's indices under the member's seed, a
        // vault on its own words under its entry's (R-1047-E18). In the order
        // each first appeared.
        let mut groups: Vec<(Option<String>, Vec<u32>)> = Vec::new();
        for vault in stayed {
            match groups.iter_mut().find(|(own, _)| *own == vault.own) {
                Some((_, indices)) => indices.push(vault.index),
                None => groups.push((vault.own.clone(), vec![vault.index])),
            }
        }
        Self(Flow::Stayed(Stayed {
            payload: payload.trim().to_owned(),
            stage: StayedStage::Start,
            groups,
            at: 0,
            answers: Vec::new(),
            refusal: None,
            added: 0,
        }))
    }

    /// Hand the words back to this phone's vaults.
    #[must_use]
    pub fn rekey(words: Vec<String>) -> Self {
        Self(Flow::Rekey(RekeyJob {
            words,
            stage: RekeyStage::Start,
            store: None,
        }))
    }

    /// Read the shell's stores into the cache and finish.
    #[must_use]
    pub fn reload() -> Self {
        Self(Flow::Reload(false))
    }

    /// Perform `ops` and finish.
    #[must_use]
    pub fn write(ops: Vec<wire::SecretOp>) -> Self {
        Self(Flow::Write(Some(ops)))
    }

    fn step(&mut self, env: &Env, reply: Option<Reply>) -> Step<Out> {
        match &mut self.0 {
            Flow::Assess(job) => job.step(env, reply),
            Flow::Keep(job) => job.step(env, reply),
            Flow::KeepOwn(job) => job.step(env, reply),
            Flow::Make(job) => job.step(env, reply),
            Flow::Restore(job) => job.step(env, reply),
            Flow::Held(job) => job.step(env, reply),
            Flow::Stayed(job) => job.step(env, reply),
            Flow::Rekey(job) => job.step(env, reply),
            Flow::Reload(asked) => {
                if *asked {
                    Step::Done(Out::Done)
                } else {
                    *asked = true;
                    Step::Ask(Ask::Secrets(VaultSecrets::load_ops()))
                }
            }
            Flow::Write(ops) => match ops.take() {
                Some(ops) => Step::Ask(Ask::Secrets(ops)),
                None => Step::Done(Out::Done),
            },
        }
    }
}

#[derive(Default)]
struct Assess {
    stage: u8,
}

impl Assess {
    fn step(&mut self, env: &Env, reply: Option<Reply>) -> Step<Out> {
        match self.stage {
            0 => {
                self.stage = 1;
                Step::Ask(Ask::Secrets(VaultSecrets::load_ops()))
            }
            1 => {
                self.stage = 2;
                Step::Ask(Ask::Probe)
            }
            _ => {
                let status = match reply {
                    Some(Reply::Probe(status)) => Some(status),
                    _ => None,
                };
                let standing = if env.secrets.seed().is_none() {
                    Standing::NoSeed
                } else if env.secrets.seed_settled() {
                    Standing::Settled
                } else {
                    Standing::Unsettled
                };
                Step::Done(Out::Assessed(Assessed {
                    standing,
                    custody: super::custody_sentence(
                        env.ctx.locale(),
                        env.ctx.platform(),
                        status.as_ref(),
                    ),
                    synchronizing: status.as_ref().is_some_and(|s| s.synchronizing),
                    holds_a_vault: env.keeper.holds_a_vault(),
                }))
            }
        }
    }
}

struct Keep {
    words: Vec<String>,
    sync: bool,
    shown: bool,
    store: Option<Store>,
}

impl Keep {
    fn step(&mut self, env: &Env, reply: Option<Reply>) -> Step<Out> {
        if self.store.is_none() {
            let words: Vec<String> = self.words.iter().map(|w| w.trim().to_lowercase()).collect();
            let Some(seed) = door::seed(env.ctx, &words) else {
                return Step::Done(Out::Kept(Some(Refusal::NotAPhrase)));
            };
            self.store = Some(Store::new(seed, words, self.sync, self.shown));
        }
        let Some(store) = self.store.as_mut() else {
            return Step::Done(Out::Kept(Some(Refusal::StoreRefused)));
        };
        match store.step(env, reply) {
            Step::Ask(ask) => Step::Ask(ask),
            Step::Done(Ok(())) => Step::Done(Out::Kept(None)),
            Step::Done(Err(why)) => Step::Done(Out::Kept(Some(why))),
        }
    }
}

struct KeepOwnJob {
    inner: KeepOwn,
}

impl KeepOwnJob {
    fn step(&mut self, env: &Env, reply: Option<Reply>) -> Step<Out> {
        match self.inner.step(env, reply) {
            Step::Ask(ask) => Step::Ask(ask),
            Step::Done(result) => Step::Done(Out::OwnKept(result)),
        }
    }
}

struct Make {
    own: Option<String>,
    name: Option<String>,
    found: Option<Found>,
}

impl Make {
    fn step(&mut self, env: &Env, _reply: Option<Reply>) -> Step<Out> {
        if let Some(found) = self.found.take() {
            return Step::Done(Out::Made(found));
        }
        let name = self
            .name
            .clone()
            .unwrap_or_else(|| words::default_vault_name(env.ctx.locale()));
        let done = env.keeper.found(self.own.as_deref(), &name);
        let mut ops = done.writes;
        if let (Some(own), Found::Made(vault_name)) = (&self.own, &done.value) {
            ops.push(env.secrets.add_pending_filing(own, vault_name));
        }
        // The shelf recorded the vault's index: read the stores again.
        ops.extend(VaultSecrets::load_ops());
        self.found = Some(done.value);
        Step::Ask(Ask::Secrets(ops))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RestoreStage {
    Start,
    Loaded,
    Asked,
    Storing,
    KeepingOwn,
    Adopted,
}

struct RestoreJob {
    words: Vec<String>,
    payload: String,
    stage: RestoreStage,
    seed: String,
    as_own: bool,
    answer: RestoreAnswer,
    store: Option<Store>,
    own: Option<KeepOwn>,
    added: usize,
}

impl RestoreJob {
    fn step(&mut self, env: &Env, reply: Option<Reply>) -> Step<Out> {
        let mut reply = reply;
        loop {
            match self.stage {
                RestoreStage::Start => {
                    self.stage = RestoreStage::Loaded;
                    return Step::Ask(Ask::Secrets(VaultSecrets::load_ops()));
                }
                RestoreStage::Loaded => {
                    self.words = self.words.iter().map(|w| w.trim().to_lowercase()).collect();
                    let Some(seed) = door::seed(env.ctx, &self.words) else {
                        return done(Restored::Refused(Refusal::NotAPhrase));
                    };
                    // WORDS THAT ARE NOT THE MEMBER'S, on a phone whose vaults
                    // open with the member's, are a vault on its own words
                    // (R-1047-E18), or one the keychain already holds an entry
                    // for.
                    self.as_own =
                        conflicts(env.secrets, &seed) || env.secrets.own_seed_matching(&seed).is_some();
                    let Some(request) =
                        door::restore_request(&Source::Words(self.words.clone()), &self.payload)
                    else {
                        return done(Restored::Unreachable);
                    };
                    self.seed = seed;
                    self.stage = RestoreStage::Asked;
                    return Step::Ask(Ask::Restore(request));
                }
                RestoreStage::Asked => {
                    let answer = match reply.take() {
                        Some(Reply::Restored(Ok(answer))) => answer,
                        Some(Reply::Restored(Err(why))) => return done(stopped(why)),
                        _ => return done(Restored::Unreachable),
                    };
                    if answer.vaults.is_empty() {
                        return done(Restored::NothingHeld);
                    }
                    self.answer = answer;
                    if self.as_own {
                        if let Some(id) = env.secrets.own_seed_matching(&self.seed) {
                            return self.adopted_as(env, &id);
                        }
                        self.own = Some(KeepOwn::new(self.words.clone(), String::new(), true));
                        self.stage = RestoreStage::KeepingOwn;
                    } else {
                        self.store = Some(Store::new(
                            self.seed.clone(),
                            self.words.clone(),
                            true,
                            true,
                        ));
                        self.stage = RestoreStage::Storing;
                    }
                }
                RestoreStage::KeepingOwn => {
                    let Some(own) = self.own.as_mut() else {
                        return done(Restored::Refused(Refusal::StoreRefused));
                    };
                    match own.step(env, reply.take()) {
                        Step::Ask(ask) => return Step::Ask(ask),
                        Step::Done(Ok(id)) => return self.adopted_as(env, &id),
                        Step::Done(Err(why)) => return done(Restored::Refused(why)),
                    }
                }
                RestoreStage::Storing => {
                    let Some(store) = self.store.as_mut() else {
                        return done(Restored::Refused(Refusal::StoreRefused));
                    };
                    match store.step(env, reply.take()) {
                        Step::Ask(ask) => return Step::Ask(ask),
                        Step::Done(Err(why)) => return done(Restored::Refused(why)),
                        Step::Done(Ok(())) => {
                            let ask = adopt(env, &self.answer, &mut self.added);
                            self.stage = RestoreStage::Adopted;
                            return Step::Ask(ask);
                        }
                    }
                }
                RestoreStage::Adopted => {
                    return done(Restored::Done {
                        answer: self.answer.clone(),
                        added: self.added,
                        missing: Vec::new(),
                    });
                }
            }
        }
    }

    /// The vaults came back on entry `id`'s seed: tag and hold them.
    fn adopted_as(&mut self, env: &Env, id: &str) -> Step<Out> {
        self.answer = self.answer.tagged_own(id);
        let ask = adopt(env, &self.answer, &mut self.added);
        self.stage = RestoreStage::Adopted;
        Step::Ask(ask)
    }
}

fn done(restored: Restored) -> Step<Out> {
    Step::Done(Out::Restored(restored))
}

struct Target {
    seed: String,
    /// The entry and its label, for a vault on its own words.
    own: Option<(String, String)>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HeldStage {
    Start,
    Loaded,
    Asked,
    Settled,
    Adopted,
}

struct Held {
    payload: String,
    stage: HeldStage,
    targets: Vec<Target>,
    at: usize,
    answers: Vec<RestoreAnswer>,
    missing: Vec<String>,
    refusal: Option<Restored>,
    added: usize,
}

impl Held {
    fn step(&mut self, env: &Env, reply: Option<Reply>) -> Step<Out> {
        let mut reply = reply;
        loop {
            match self.stage {
                HeldStage::Start => {
                    self.stage = HeldStage::Loaded;
                    return Step::Ask(Ask::Secrets(VaultSecrets::load_ops()));
                }
                HeldStage::Loaded => {
                    // EVERY SEED THE KEYCHAIN CARRIED (R-1047-E18): the member's,
                    // and each vault kept on its own words, asked in turn. One
                    // that answered with nothing, or was refused, does not stop
                    // the others.
                    if let Some(seed) = env.secrets.seed() {
                        self.targets.push(Target { seed, own: None });
                    }
                    for entry in env.secrets.own_seeds() {
                        self.targets.push(Target {
                            seed: entry.seed_hex.clone(),
                            own: Some((entry.id.clone(), entry.label.clone())),
                        });
                    }
                    if self.targets.is_empty() {
                        return done(Restored::Refused(Refusal::NotAPhrase));
                    }
                    self.stage = HeldStage::Adopted;
                }
                // Between targets: ask the next, or finish.
                HeldStage::Adopted => {
                    let Some(target) = self.targets.get(self.at) else {
                        return self.finish();
                    };
                    let request =
                        door::restore_request(&Source::Seed(target.seed.clone()), &self.payload);
                    let Some(request) = request else {
                        self.refuse_target(Restored::Unreachable);
                        self.at += 1;
                        continue;
                    };
                    self.stage = HeldStage::Asked;
                    return Step::Ask(Ask::Restore(request));
                }
                HeldStage::Asked => {
                    let result = match reply.take() {
                        Some(Reply::Restored(result)) => result,
                        _ => Err(RestoreRefusal::Unreachable),
                    };
                    match result {
                        Ok(answer) if !answer.vaults.is_empty() => {
                            let own = self.targets[self.at].own.clone();
                            match own {
                                None => {
                                    // The seed is SETTLED once the gateway brought
                                    // something back: the restore is what records
                                    // the indices the words spent.
                                    self.stage = HeldStage::Settled;
                                    self.answers.push(answer);
                                    return Step::Ask(Ask::Secrets(vec![
                                        VaultSecrets::settle_seed(),
                                    ]));
                                }
                                Some((id, _)) => {
                                    let tagged = answer.tagged_own(&id);
                                    let ask = adopt(env, &tagged, &mut self.added);
                                    self.answers.push(tagged);
                                    self.at += 1;
                                    self.stage = HeldStage::Adopted;
                                    return Step::Ask(ask);
                                }
                            }
                        }
                        Ok(_) => {
                            if let Some((_, label)) = &self.targets[self.at].own {
                                self.missing.push(label.clone());
                            }
                        }
                        Err(why) => self.refuse_target(stopped(why)),
                    }
                    self.at += 1;
                    self.stage = HeldStage::Adopted;
                }
                HeldStage::Settled => {
                    let answer = self.answers.last().cloned().unwrap_or_default();
                    let ask = adopt(env, &answer, &mut self.added);
                    self.at += 1;
                    self.stage = HeldStage::Adopted;
                    return Step::Ask(ask);
                }
            }
        }
    }

    fn refuse_target(&mut self, refusal: Restored) {
        if self.refusal.is_none() {
            self.refusal = Some(refusal);
        }
        if let Some((_, label)) = self.targets.get(self.at).and_then(|t| t.own.as_ref()) {
            self.missing.push(label.clone());
        }
    }

    fn finish(&mut self) -> Step<Out> {
        if self.answers.is_empty() {
            return done(self.refusal.take().unwrap_or(Restored::NothingHeld));
        }
        done(Restored::Done {
            answer: RestoreAnswer::merged(std::mem::take(&mut self.answers)),
            added: self.added,
            missing: std::mem::take(&mut self.missing),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StayedStage {
    Start,
    Loaded,
    Asked,
}

struct Stayed {
    payload: String,
    stage: StayedStage,
    groups: Vec<(Option<String>, Vec<u32>)>,
    at: usize,
    answers: Vec<RestoreAnswer>,
    refusal: Option<Restored>,
    added: usize,
}

impl Stayed {
    fn step(&mut self, env: &Env, reply: Option<Reply>) -> Step<Out> {
        let mut reply = reply;
        loop {
            match self.stage {
                StayedStage::Start => {
                    self.stage = StayedStage::Loaded;
                    return Step::Ask(Ask::Secrets(VaultSecrets::load_ops()));
                }
                StayedStage::Loaded => {
                    let Some((own, indices)) = self.groups.get(self.at).cloned() else {
                        return self.finish();
                    };
                    let seed = match &own {
                        Some(id) => env.secrets.own_seed(id),
                        None => env.secrets.seed(),
                    };
                    let request = seed.and_then(|seed| {
                        door::restore_request(&Source::Stayed(seed, indices), &self.payload)
                    });
                    let Some(request) = request else {
                        self.refusal
                            .get_or_insert(Restored::Refused(Refusal::NotAPhrase));
                        self.at += 1;
                        continue;
                    };
                    self.stage = StayedStage::Asked;
                    return Step::Ask(Ask::Restore(request));
                }
                StayedStage::Asked => {
                    let result = match reply.take() {
                        Some(Reply::Restored(result)) => result,
                        _ => Err(RestoreRefusal::Unreachable),
                    };
                    let own = self.groups[self.at].0.clone();
                    self.at += 1;
                    self.stage = StayedStage::Loaded;
                    match result {
                        Ok(answer) if !answer.vaults.is_empty() => {
                            let tagged = match &own {
                                Some(id) => answer.tagged_own(id),
                                None => answer,
                            };
                            let ask = adopt(env, &tagged, &mut self.added);
                            self.answers.push(tagged);
                            return Step::Ask(ask);
                        }
                        Ok(_) => {}
                        Err(why) => {
                            self.refusal.get_or_insert(stopped(why));
                        }
                    }
                }
            }
        }
    }

    fn finish(&mut self) -> Step<Out> {
        if self.answers.is_empty() {
            return done(self.refusal.take().unwrap_or(Restored::NothingHeld));
        }
        done(Restored::Done {
            answer: RestoreAnswer::merged(std::mem::take(&mut self.answers)),
            added: self.added,
            missing: Vec::new(),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RekeyStage {
    Start,
    Loaded,
    Storing,
}

struct RekeyJob {
    words: Vec<String>,
    stage: RekeyStage,
    store: Option<Store>,
}

impl RekeyJob {
    fn step(&mut self, env: &Env, reply: Option<Reply>) -> Step<Out> {
        let mut reply = reply;
        loop {
            match self.stage {
                RekeyStage::Start => {
                    self.stage = RekeyStage::Loaded;
                    return Step::Ask(Ask::Secrets(VaultSecrets::load_ops()));
                }
                RekeyStage::Loaded => {
                    let words: Vec<String> =
                        self.words.iter().map(|w| w.trim().to_lowercase()).collect();
                    let Some(seed) = door::seed(env.ctx, &words) else {
                        return rekeyed(Rekeyed::Refused(Refusal::NotAPhrase));
                    };
                    if conflicts(env.secrets, &seed) {
                        return rekeyed(Rekeyed::Refused(Refusal::DifferentWords));
                    }
                    // NOTHING IS STORED FOR A PHONE WITH NO INDEX: an unkeyed
                    // vault with no recorded index was never sealed under any
                    // index this phone knows, and a guessed one could be the
                    // gateway's copy of another vault.
                    if env.keeper.indexed_holdings() == 0 {
                        return rekeyed(Rekeyed::NoneToKey);
                    }
                    self.store = Some(Store::new(seed, words, true, true));
                    self.stage = RekeyStage::Storing;
                }
                RekeyStage::Storing => {
                    let Some(store) = self.store.as_mut() else {
                        return rekeyed(Rekeyed::Refused(Refusal::StoreRefused));
                    };
                    match store.step(env, reply.take()) {
                        Step::Ask(ask) => return Step::Ask(ask),
                        Step::Done(Err(why)) => return rekeyed(Rekeyed::Refused(why)),
                        Step::Done(Ok(())) => {
                            return rekeyed(Rekeyed::Done(env.keeper.rekey()));
                        }
                    }
                }
            }
        }
    }
}

fn rekeyed(outcome: Rekeyed) -> Step<Out> {
    Step::Done(Out::Rekeyed(outcome))
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/// What a runner step did: the effects to send, and the job's answer once it
/// has one.
#[derive(Default)]
pub struct Progress {
    pub effects: Vec<wire::Effect>,
    pub out: Option<Out>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Awaiting {
    Nothing,
    Secrets,
    Probe,
    /// A restore is out on a worker thread.
    Restore,
}

/// Drives one [`Job`] at a time for a screen.
pub struct Runner {
    job: Option<Job>,
    sent: Vec<wire::SecretOp>,
    awaiting: Awaiting,
}

impl Default for Runner {
    fn default() -> Self {
        Self {
            job: None,
            sent: Vec::new(),
            awaiting: Awaiting::Nothing,
        }
    }
}

impl Runner {
    /// Whether a job is out.
    #[must_use]
    pub fn busy(&self) -> bool {
        self.job.is_some()
    }

    /// Start `job`. A job already running is replaced: its answer is no longer
    /// wanted.
    pub fn begin(&mut self, job: Job, env: &Env) -> Progress {
        self.job = Some(job);
        self.awaiting = Awaiting::Nothing;
        self.sent.clear();
        self.drive(env, None)
    }

    /// Take the shell's answer to the effect the job is waiting on. `None` when
    /// `result` answers something else.
    pub fn answered(&mut self, result: &wire::EffectResult, env: &Env) -> Option<Progress> {
        use wire::effect_result::Outcome;
        let reply = match (self.awaiting, result.outcome.as_ref()) {
            (Awaiting::Secrets, Some(Outcome::Secrets(batch))) => {
                env.secrets.absorb(&self.sent, &batch.answers);
                Reply::Secrets(batch.answers.clone())
            }
            // A shell that failed the batch answers nothing: the job reads the
            // cache as it was and refuses what it cannot confirm.
            (Awaiting::Secrets, Some(Outcome::Failed(_))) => Reply::Secrets(Vec::new()),
            (Awaiting::Probe, Some(Outcome::SyncedStatus(status))) => Reply::Probe(*status),
            (Awaiting::Probe, Some(Outcome::Failed(_))) => {
                Reply::Probe(wire::SyncedSecretsStatus::default())
            }
            _ => return None,
        };
        self.awaiting = Awaiting::Nothing;
        Some(self.drive(env, Some(reply)))
    }

    /// Take a restore's answer from the worker thread. `None` when no restore is
    /// out.
    pub fn off_thread(&mut self, done: &wire::OffThreadDone, env: &Env) -> Option<Progress> {
        if self.awaiting != Awaiting::Restore || done.tag != door::RESTORE {
            return None;
        }
        self.awaiting = Awaiting::Nothing;
        Some(self.drive(env, Some(Reply::Restored(door::restored(done)))))
    }

    fn drive(&mut self, env: &Env, reply: Option<Reply>) -> Progress {
        let mut reply = reply;
        let mut progress = Progress::default();
        loop {
            let Some(job) = self.job.as_mut() else {
                return progress;
            };
            match job.step(env, reply.take()) {
                Step::Done(out) => {
                    self.job = None;
                    progress.out = Some(out);
                    return progress;
                }
                Step::Ask(Ask::Secrets(ops)) => {
                    if ops.is_empty() {
                        reply = Some(Reply::Secrets(Vec::new()));
                        continue;
                    }
                    progress.effects.push(secrets::effect(ops.clone()));
                    self.sent = ops;
                    self.awaiting = Awaiting::Secrets;
                    return progress;
                }
                Step::Ask(Ask::Probe) => {
                    progress.effects.push(wire::Effect {
                        kind: Some(wire::effect::Kind::SyncedProbe(wire::SyncedSecretsProbe {})),
                    });
                    self.awaiting = Awaiting::Probe;
                    return progress;
                }
                Step::Ask(Ask::Restore(request)) => {
                    door::send_restore(env.ctx, request);
                    self.awaiting = Awaiting::Restore;
                    return progress;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
