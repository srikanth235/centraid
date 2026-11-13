//! `backup.home` — ONE HONEST LINE AND THREE CONTROLS (#1080; seam contract A11),
//! and where the recovery key is (R-ONBOARD-10).
//!
//! The line at the top is [`super::line`]'s, the value Home draws too. The three
//! controls are the member's transfer rule (one setting with one store, the
//! phone's), "Include videos", and "Back up now". Under them, the RECOVERY KEY:
//! where it is, read from the stores each time, a warning when it is on this
//! phone alone and the member has not said they saved a copy, and the controls to
//! show it and to move it into or out of the keychain. The destinations are the
//! gateways this vault backs up to; adding one is the pairing page's (a route in
//! the view), and forgetting one drops this phone's pairing and revokes its token
//! there, so it asks nothing first.
//!
//! ## What re-reads it
//!
//! The reading is the named query `shell.backup-status`. The core announces a
//! change to its `backup` pseudo-table after every door that moves the ledger (a
//! pass anywhere, a pairing, a forget) and the vault's `blob` table moves with the
//! content counts, so a pass this screen did not start moves the line here too. A
//! "Back up now" run that goes on is re-read every [`PROGRESS_EVERY`] so its count
//! moves as the gateway confirms: a pass over a big library runs for minutes, and
//! a count that stood at "0 of 47" while gigabytes reached the gateway would be a
//! screen not saying what it knew.

use std::collections::VecDeque;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;

use super::claim::bytes;
use super::doors::{self, Done};
use super::key::KeyCustody;
use super::reading::{self, Destination, Standing};
use super::rule::{self, TransferRule};
use super::{apps, line, routes, states};
use crate::custody::secrets::{self, SeedWrite, VaultSecrets};
use crate::kit::read::{Note, Page, Reading};
use crate::pairing::discovery::Rediscovery;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, backup as words, backup_home, fill};

/// How often a running "Back up now" is re-read: a status read dials nothing, so
/// it is cheap.
pub const PROGRESS_EVERY: Duration = Duration::from_secs(2);
const PROGRESS_TIMER: &str = PROGRESS_TIMER_NAME;

/// The name of the timer that re-reads a run that goes on.
pub const PROGRESS_TIMER_NAME: &str = "backup.progress";

/// The registry factory.
#[must_use]
pub fn build(_route: &wire::Route, secrets: &VaultSecrets) -> Option<Box<dyn Screen>> {
    Some(Box::new(Backup::new(secrets.clone())))
}

/// One batch of secret ops in flight, and what to do with its answers.
enum Job {
    /// Everything this phone keeps, then the rule and the videos bit.
    Load,
    Rule(TransferRule),
    Videos,
    /// The recovery-key prompt was answered: remember it.
    Prompt,
    /// The notification ask was dismissed with Not now: remember it.
    NotifyDismissed,
    /// What the last check found, read again after the check page closes.
    CheckKept,
    /// Moving the recovery key into the keychain, or out of it: the first batch,
    /// then (once it said whether the platform took it) the second.
    Seed {
        write: SeedWrite,
        on: bool,
        stage: Stage,
    },
}

enum Stage {
    First,
    Second,
}

/// What the last act did, or why it could not: one clause, never a toast.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum Notice {
    #[default]
    None,
    /// A sentence finished when it was made (a forget's outcome).
    Said(String),
    /// The keychain did not take the key where the member asked; the place is
    /// named at the draw, from what the platform says it is.
    KeyNotMoved,
}

struct Backup {
    secrets: VaultSecrets,
    /// The latest reading, kept across a refresh that fails.
    standing: Option<Standing>,
    /// The first read did not come back.
    failed: bool,
    /// A re-read failed over what is shown: the page says so in one sentence (#1185).
    refresh_failed: bool,
    /// What this phone keeps: the first answer has come (or the shell could not
    /// give it), so the controls are drawn from it and not from defaults.
    settled: bool,
    rule: TransferRule,
    include_videos: bool,
    /// The one-time recovery-key prompt was answered (read from the device store).
    key_prompt_answered: bool,
    notify_ask_dismissed: bool,
    /// What the last "Check my backup" found and when, from the device store; `None` before one.
    check_kept: Option<rule::KeptCheck>,
    /// The platform took a background window; `None` before it says.
    registered: Option<bool>,
    /// The platform's reading of its synchronised store; `None` before it says.
    synced: Option<wire::SyncedSecretsStatus>,
    backing_up_now: bool,
    /// The browse for a gateway that moved to another address (#1080): on while the core says
    /// items wait for a backup device that does not answer, and only while this page is in front.
    rediscovery: Rediscovery,
    /// The app is in front. A browse is foreground work.
    foreground: bool,
    /// A browse found the gateway and the core kept its new address: it is not browsed for again
    /// until this page opens anew (the next pass is what reaches it).
    found: bool,
    notice: Notice,
    /// Secret batches wait their turn: one in flight at a time, so an answer
    /// finds its job.
    in_flight: Option<(Job, Vec<wire::SecretOp>)>,
    waiting: VecDeque<Job>,
}

impl Backup {
    fn new(secrets: VaultSecrets) -> Self {
        Self {
            secrets,
            standing: None,
            failed: false,
            refresh_failed: false,
            settled: false,
            rule: TransferRule::default(),
            include_videos: true,
            key_prompt_answered: false,
            notify_ask_dismissed: false,
            check_kept: None,
            registered: None,
            synced: None,
            backing_up_now: false,
            rediscovery: Rediscovery::default(),
            foreground: true,
            found: false,
            notice: Notice::None,
            in_flight: None,
            waiting: VecDeque::new(),
        }
    }

    // ---- reading ----------------------------------------------------------

    fn read(&mut self, ctx: &Ctx) {
        self.run_over(ctx);
        match reading::load(ctx) {
            Reading::Data(standing) => {
                self.standing = Some(standing);
                self.failed = false;
                self.refresh_failed = false;
            }
            // A REFRESH THAT FAILS KEEPS WHAT WAS READ, under one sentence; a first read that fails
            // is a failure, never an empty reading.
            _ => {
                self.failed = self.standing.is_none();
                self.refresh_failed = self.standing.is_some();
            }
        }
    }

    fn reading(&self) -> Option<&reading::Reading> {
        self.standing.as_ref().map(|standing| &standing.reading)
    }

    fn destinations(&self) -> &[Destination] {
        self.reading()
            .map_or(&[], |reading| reading.destinations.as_slice())
    }

    fn frozen(&self) -> bool {
        self.reading().is_some_and(|reading| reading.frozen)
    }

    fn now_ms(&self) -> i64 {
        self.standing.as_ref().map_or(0, |standing| standing.now_ms)
    }

    /// Back up now needs a gateway to back up to, a vault that has not moved, and
    /// no run already going.
    fn can_back_up_now(&self) -> bool {
        !self.backing_up_now
            && !self.destinations().is_empty()
            && !self.frozen()
            && !self.reading().is_some_and(|reading| reading.damaged)
    }

    fn label_of(&self, locale: Locale, gateway_id: &str) -> String {
        self.destinations()
            .iter()
            .find(|destination| destination.gateway_id == gateway_id)
            .map(|destination| destination.label.trim())
            .filter(|label| !label.is_empty())
            .map_or_else(|| words::backup_unnamed(locale), str::to_owned)
    }

    fn key(&self, ctx: &Ctx) -> KeyCustody {
        KeyCustody::read(
            ctx.locale(),
            &self.secrets,
            ctx.platform(),
            self.synced.as_ref(),
        )
    }

    // ---- secret batches ---------------------------------------------------

    /// Send `job`'s batch now, or after the one in flight.
    fn run(&mut self, job: Job) -> Vec<wire::Effect> {
        if self.in_flight.is_some() {
            self.waiting.push_back(job);
            return Vec::new();
        }
        self.send(job)
    }

    fn send(&mut self, job: Job) -> Vec<wire::Effect> {
        let ops = match &job {
            Job::Load => {
                let mut ops = VaultSecrets::load_ops();
                ops.extend(rule::read_ops());
                ops
            }
            Job::Rule(rule) => vec![rule::write_rule(*rule)],
            Job::Videos => vec![rule::write_include_videos(self.include_videos)],
            Job::Prompt => vec![rule::write_key_prompt_answered()],
            Job::NotifyDismissed => vec![rule::write_notify_ask_dismissed()],
            Job::CheckKept => vec![rule::read_check()],
            Job::Seed { write, stage, .. } => match stage {
                Stage::First => write.first(),
                // The second batch is built from the first's answers, in `answered`.
                Stage::Second => Vec::new(),
            },
        };
        let effect = secrets::effect(ops.clone());
        self.in_flight = Some((job, ops));
        vec![effect]
    }

    fn next_job(&mut self) -> Vec<wire::Effect> {
        match self.waiting.pop_front() {
            Some(job) => self.send(job),
            None => Vec::new(),
        }
    }

    fn secrets_answered(&mut self, batched: &wire::SecretBatched, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some((job, ops)) = self.in_flight.take() else {
            return Vec::new();
        };
        let answers = &batched.answers;
        match job {
            Job::Load => {
                self.secrets.absorb(&ops, answers);
                // THE RULE AND THE VIDEOS BIT are the last two answers; a shell
                // that failed the batch gives the defaults, which are the
                // conservative ones.
                let (rule, include) = rule::from_answers(answers.get(2..).unwrap_or_default());
                self.rule = rule;
                self.include_videos = include;
                self.key_prompt_answered =
                    rule::key_prompt_answered(answers.get(2..).unwrap_or_default());
                self.notify_ask_dismissed =
                    rule::notify_ask_dismissed(answers.get(2..).unwrap_or_default());
                self.check_kept = rule::kept_check(answers.get(rule::CHECK_ANSWER + 2));
                self.settled = true;
            }
            Job::CheckKept => self.check_kept = rule::kept_check(answers.first()),
            Job::Prompt | Job::NotifyDismissed => {}
            Job::Rule(_) | Job::Videos => {
                // Written as the member set it; a store that refused leaves the
                // value on screen until the next load says what it holds.
                //
                // THE PASS SERVICE READS THE SAME CACHE, so it is folded in
                // before it is told. A rule that stuck is a new constraint on
                // every window the OS holds: the service asks for them again
                // and decides a pass, in this call, with no help from the
                // shell. "Include videos" is read at the next pass and needs no
                // ask.
                self.secrets.absorb(&ops, answers);
                if matches!(job, Job::Rule(_)) && answers.iter().all(|answer| answer.ok) {
                    self.secrets
                        .conductor()
                        .ask(ctx, wire::pass_asked::Ask::RuleChanged);
                }
            }
            Job::Seed {
                write,
                on,
                stage: Stage::First,
            } => {
                self.secrets.absorb(&ops, answers);
                let second = write.second(answers);
                if second.is_empty() {
                    self.key_moved(on);
                } else {
                    let effect = secrets::effect(second.clone());
                    self.in_flight = Some((
                        Job::Seed {
                            write,
                            on,
                            stage: Stage::Second,
                        },
                        second,
                    ));
                    return vec![effect];
                }
            }
            Job::Seed {
                on,
                stage: Stage::Second,
                ..
            } => {
                self.secrets.absorb(&ops, answers);
                self.key_moved(on);
            }
        }
        self.next_job()
    }

    /// The key was asked to move: say so only when it did not end up where it was
    /// asked to.
    fn key_moved(&mut self, on: bool) {
        self.notice = if self.secrets.seed_synced() == on {
            Notice::None
        } else {
            Notice::KeyNotMoved
        };
    }

    // ---- events -----------------------------------------------------------

    fn open(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.notice = Notice::None;
        self.foreground = true;
        self.found = false;
        self.read(ctx);
        let mut effects = self.run(Job::Load);
        effects.extend(self.rediscover());
        effects.push(wire::Effect {
            kind: Some(wire::effect::Kind::SyncedProbe(wire::SyncedSecretsProbe {})),
        });
        effects.push(wire::Effect {
            kind: Some(wire::effect::Kind::BackgroundProbe(
                wire::BackgroundProbe {},
            )),
        });
        effects
    }

    /// A PAIRED GATEWAY THAT DOES NOT ANSWER AT THE ADDRESS THE LEDGER KEPT is looked for on the
    /// local network. The core says so itself: items wait for `WaitReason::Gateway` (the last pass
    /// reached no paired gateway). The browse is on for exactly as long as that is true, this page
    /// is in front and the app is in the foreground; the matching, and the core's check that the
    /// machine at a new address is that gateway, are `pairing::discovery`'s.
    fn rediscover(&mut self) -> Vec<wire::Effect> {
        let lost = self.foreground
            && !self.found
            && !self.frozen()
            && !self.destinations().is_empty()
            && self
                .reading()
                .is_some_and(|reading| reading.waiting_for(wire::WaitReason::Gateway) > 0);
        if lost {
            self.rediscovery.start()
        } else {
            self.rediscovery.stop()
        }
    }

    fn back_up_now(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if !self.can_back_up_now() {
            return Vec::new();
        }
        self.backing_up_now = true;
        self.notice = Notice::None;
        ctx.start_timer(PROGRESS_TIMER, PROGRESS_EVERY);
        // THE PASS CONDUCTOR RUNS IT, as it runs every pass: the camera-roll walk first, the
        // long run the platform keeps alive (iOS's keep-awake and background session, Android's
        // foreground job), and the drain under the member's rule and the link the platform
        // reports, never a link this screen guessed.
        self.secrets
            .conductor()
            .ask(ctx, wire::pass_asked::Ask::BackUpNow);
        Vec::new()
    }

    /// The run is the conductor's: when it no longer holds a "Back up now" (it ended, however it
    /// ended), the screen stops drawing one and reads what the run moved.
    fn run_over(&mut self, ctx: &Ctx) {
        if self.backing_up_now && !self.secrets.conductor().back_up_now_going() {
            self.backing_up_now = false;
            ctx.cancel_timer(PROGRESS_TIMER);
        }
    }

    fn forget(&mut self, gateway_id: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        // ONLY A GATEWAY THE SCREEN IS DRAWING can be forgotten from it, and none
        // on a vault that moved.
        if self.frozen()
            || !self
                .destinations()
                .iter()
                .any(|destination| destination.gateway_id == gateway_id)
        {
            return Vec::new();
        }
        self.notice = Notice::None;
        ctx.vault_async(
            &doors::forget_tag(gateway_id),
            doors::forget_request(gateway_id),
        );
        Vec::new()
    }

    fn set_key_sync(&mut self, on: bool, ctx: &Ctx) -> Vec<wire::Effect> {
        let key = self.key(ctx);
        // ONLY A MOVE THE SCREEN OFFERS: a key held, a keychain to move it to, and
        // somewhere it is not already.
        if !key.held || key.place.is_empty() || on == key.synced {
            return Vec::new();
        }
        let Some(seed) = self.secrets.seed() else {
            return Vec::new();
        };
        self.notice = Notice::None;
        self.run(Job::Seed {
            write: VaultSecrets::remember_seed(&seed, on),
            on,
            stage: Stage::First,
        })
    }

    fn on_event(&mut self, event: wire::BackupHomeEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::backup_home_event::Kind as B;
        match event.kind {
            Some(B::BackUpNow(_)) => self.back_up_now(ctx),
            Some(B::SetIncludeVideos(set)) => {
                self.include_videos = set.include;
                self.notice = Notice::None;
                self.run(Job::Videos)
            }
            Some(B::RuleChosen(chosen)) => {
                let rule = TransferRule::of(Some(&chosen.stored));
                self.rule = rule;
                self.notice = Notice::None;
                self.run(Job::Rule(rule))
            }
            Some(B::ForgetDestination(forget)) => self.forget(&forget.gateway_id, ctx),
            // UNDO IS THE CORE'S: the row offers it only once the reading says the phone holds
            // deletes there (#1191), and the signed undo is the core's door, not built yet.
            Some(B::UndoHeld(_)) => Vec::new(),
            Some(B::SetKeySync(set)) => self.set_key_sync(set.on, ctx),
            Some(B::KeyPromptAnswered(_)) => {
                self.key_prompt_answered = true;
                self.run(Job::Prompt)
            }
            // ALLOW NOTIFICATIONS goes to the one notification service, which starts the system prompt
            // through the path the agenda's own reminders use.
            Some(B::NotifyAllow(_)) => {
                ctx.alerts().ask(ctx);
                Vec::new()
            }
            Some(B::NotifyNotNow(_)) => {
                self.notify_ask_dismissed = true;
                self.run(Job::NotifyDismissed)
            }
            Some(B::NotifyOpenSettings(_)) => vec![wire::Effect {
                kind: Some(wire::effect::Kind::CameraRoll(wire::CameraRoll {
                    action: wire::camera_roll::Action::OpenSettings as i32,
                })),
            }],
            Some(B::Retry(_)) => self.open(ctx),
            // RESTORE IS HOME'S: the same door the vault sheet opens, asked from here.
            Some(B::RestorePressed(_)) => {
                ctx.post(
                    crate::shell::HOME,
                    wire::ScreenEvent {
                        kind: Some(E::Home(wire::HomeEvent {
                            kind: Some(wire::home_event::Kind::Restore(
                                wire::home_event::RestorePressed {},
                            )),
                        })),
                    },
                );
                Vec::new()
            }
            None => Vec::new(),
        }
    }

    /// An off-thread job came back.
    fn job_done(&mut self, done: &wire::OffThreadDone, ctx: &Ctx) {
        let Some(done) = doors::done(&done.tag, &done.bytes) else {
            return;
        };
        match done {
            // WHETHER THE GATEWAY WILL REFUSE THIS PHONE NOW is said either way
            // (#1080): a token the gateway was not told about stays live there
            // until its operator revokes it.
            Done::Forgot {
                gateway_id,
                forgotten,
                revoked,
            } => {
                let locale = ctx.locale();
                let name = self.label_of(locale, &gateway_id);
                let sentence = if !forgotten {
                    words::backup_forget_failed(locale)
                } else if revoked {
                    words::backup_forgotten_revoked(locale)
                } else {
                    words::backup_forgotten_not_revoked(locale)
                };
                self.notice = Notice::Said(fill(&sentence, &[("name", &name)]));
            }
        }
        self.read(ctx);
    }

    fn on_result(&mut self, result: wire::EffectResult, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::effect_result::Outcome as O;
        match result.outcome {
            Some(O::Secrets(batched)) => self.secrets_answered(&batched, ctx),
            Some(O::SyncedStatus(status)) => {
                self.synced = Some(status);
                Vec::new()
            }
            Some(O::BackgroundStatus(status)) => {
                self.registered = Some(status.registered);
                Vec::new()
            }
            // A WINDOW OF THE BROWSE: what the local network advertised. Each sighting that is a
            // recorded gateway (by its id, not its address) is offered to the core, which dials
            // it with the pinned certificate and keeps only an address that answers as that gateway.
            Some(O::GatewaysSighted(sighted)) => {
                self.rediscovery.sighted(ctx, &sighted);
                Vec::new()
            }
            // A SHELL THAT COULD NOT GIVE THE PHONE'S SETTINGS gives the defaults, which
            // are the conservative ones: the page must not wait for ever on a store
            // that will not answer. (The batch answers short, and `absorb` takes that
            // as a failed batch and changes nothing.)
            Some(O::Failed(_)) if matches!(self.in_flight, Some((Job::Load, _))) => {
                self.secrets_answered(&wire::SecretBatched::default(), ctx)
            }
            // A probe the shell could not perform is an answer of "unknown": the
            // key line says it cannot tell, and no background notice is drawn.
            _ => Vec::new(),
        }
    }

    // ---- drawing ----------------------------------------------------------

    fn rule_choices(&self, locale: Locale) -> Vec<wire::BackupRuleChoice> {
        TransferRule::ALL
            .iter()
            .map(|rule| wire::BackupRuleChoice {
                stored: rule.stored().to_owned(),
                sentence: rule.sentence(locale),
                picked: *rule == self.rule,
            })
            .collect()
    }

    fn destination_row(
        &self,
        locale: Locale,
        zone: &str,
        destination: &Destination,
    ) -> wire::BackupDestinationRow {
        let label = if destination.label.trim().is_empty() {
            words::backup_unnamed(locale)
        } else {
            destination.label.clone()
        };
        let seen = destination.last_seen_ms.map_or_else(
            || words::backup_seen_never(locale),
            |at| {
                fill(
                    &words::backup_seen(locale),
                    &[("when", &line::ago(locale, at, self.now_ms()))],
                )
            },
        );
        // A GATEWAY THAT REFUSED THIS PHONE'S TOKEN says so where it says when it
        // was reached: the way back is to pair it again (#1080, F2).
        let detail = [
            destination.addrs.first().cloned(),
            Some(seen),
            destination
                .pair_again
                .then(|| words::backup_dest_pair_again(locale)),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
        // HOW IT STANDS LEADS, then what it holds (#1144): a row that said nothing would read as
        // health by absence, so every device says its state, "Up to date" included (#1188, NB1).
        let held = [
            Some(states::standing_words(locale, destination)),
            (destination.held_bytes != 0).then(|| {
                fill(
                    &words::backup_held(locale),
                    &[("size", &bytes(destination.held_bytes))],
                )
            }),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" \u{b7} ");
        // THE NOTES under it, a field of their own: an old backup that cannot be read, a piece
        // sent again, deletes held for a week (#1191, B16).
        let undo_label = if states::can_undo(destination) {
            backup_home::row_undo_action(locale)
        } else {
            String::new()
        };
        // WHEN THIS GATEWAY LAST ACKNOWLEDGED A BACKUP, apart from when it was reached: a device
        // can answer every hour and hold nothing newer than last week (#1188).
        let backed_up = destination.last_ack_ms.map_or_else(
            || words::backup_dest_acked_never(locale),
            |at| {
                fill(
                    &words::backup_dest_acked(locale),
                    &[("when", &line::ago(locale, at, self.now_ms()))],
                )
            },
        );
        let notes = states::notes(locale, zone, destination);
        let accessibility_label = [label.as_str(), &held, &backed_up, &detail]
            .into_iter()
            .chain(notes.iter().map(String::as_str))
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(". ");
        wire::BackupDestinationRow {
            gateway_id: destination.gateway_id.clone(),
            accessibility_label,
            label,
            detail,
            held,
            backed_up,
            notes,
            undo_label,
        }
    }

    /// "Backing up — 380 MB to go" while bytes are still to move (#1144);
    /// plain "Backing up…" when nothing is left to count.
    fn progress(&self, locale: Locale) -> String {
        if !self.backing_up_now {
            return String::new();
        }
        match self.reading() {
            Some(reading) if reading.pending_bytes > 0 => fill(
                &words::backup_progress(locale),
                &[("size", &bytes(reading.pending_bytes))],
            ),
            _ => words::backup_now_running(locale),
        }
    }

    /// How much of the backup a gateway has acknowledged, while a run is going and the
    /// phone can say what the whole is: `None` draws the spinner, never a bar stuck at zero.
    fn progress_fraction(&self) -> Option<f32> {
        if !self.backing_up_now {
            return None;
        }
        let reading = self.reading()?;
        if reading.total_bytes == 0 {
            return None;
        }
        let done = reading.confirmed_bytes.min(reading.total_bytes);
        // Whole thousandths, so the figure is the same on every phone.
        let thousandths = u128::from(done) * 1000 / u128::from(reading.total_bytes);
        Some(u16::try_from(thousandths).map_or(1.0, |t| f32::from(t) / 1000.0))
    }

    /// Where the backup stands, for the status card. Green ("up to date") is said only when the
    /// line's own reading finds nothing to warn of and nothing waiting: the card and the line are
    /// made from [`line::warns`], so one can never be calm beside the other's warning.
    fn condition(&self) -> wire::BackupCondition {
        use wire::BackupCondition as C;
        let now = self.now_ms();
        let Some(reading) = self.reading() else {
            return if self.frozen() { C::Moved } else { C::Unpaired };
        };
        if self.frozen() {
            C::Moved
        } else if self.destinations().is_empty() {
            C::Unpaired
        } else if self.backing_up_now {
            C::Running
        } else if line::unreached(reading, now) {
            C::NotReached
        } else if line::warns(reading, now, self.backing_up_now) {
            C::Attention
        } else if reading.unconfirmed() > 0 {
            C::CatchingUp
        } else {
            C::UpToDate
        }
    }

    fn data(&self, ctx: &Ctx) -> wire::BackupHomeData {
        let locale = ctx.locale();
        let frozen = self.frozen();
        let now = self.now_ms();
        let destinations = self.destinations();
        let stood = line::backlog_stood(self.reading(), frozen, now);
        let key = self.key(ctx);
        let add_label = if frozen {
            String::new()
        } else {
            words::backup_add_destination(locale)
        };
        let back_up_now_label = if destinations.is_empty() {
            String::new()
        } else {
            words::backup_now(locale)
        };
        // THE KEY SECTION: nothing at all on a phone holding no key. A synchronised
        // key is the platform's own sentence; on this phone alone, a plain
        // sentence once the member said they saved a copy and a warning until then.
        let (key_heading, key_line, key_warning, key_show_label, key_sync_label) =
            if self.settled && key.held {
                let warning = !key.synced && !key.saved;
                (
                    words::backup_key_heading(locale),
                    if key.synced {
                        key.sentence.clone()
                    } else if key.saved {
                        words::backup_key_phone_only_saved(locale)
                    } else {
                        words::backup_key_phone_only(locale)
                    },
                    warning,
                    if key.words_here {
                        words::backup_key_show(locale)
                    } else {
                        String::new()
                    },
                    if key.place.is_empty() {
                        String::new()
                    } else if key.synced {
                        fill(
                            &words::backup_key_sync_off(locale),
                            &[("place", &key.place)],
                        )
                    } else {
                        fill(&words::backup_key_sync_on(locale), &[("place", &key.place)])
                    },
                )
            } else {
                Default::default()
            };
        let notice = match &self.notice {
            Notice::None => String::new(),
            Notice::Said(sentence) => sentence.clone(),
            Notice::KeyNotMoved => fill(
                &words::backup_key_sync_failed(locale),
                &[("place", &key.place)],
            ),
        };
        let ink = if key_warning && !key_show_label.is_empty() {
            wire::BackupInk::ShowKey
        } else if destinations.is_empty() && !add_label.is_empty() {
            wire::BackupInk::AddDestination
        } else if !back_up_now_label.is_empty() {
            wire::BackupInk::BackUpNow
        } else {
            wire::BackupInk::None
        };
        let mut app_rows = self
            .reading()
            .map(|reading| apps::rows(locale, reading))
            .unwrap_or_default();
        // WHEN NO BACKUP DEVICE ANSWERS, what waits is its own list (the board's "Not backed
        // up yet"), and "In this backup" is what the device already holds.
        let condition = self.condition();
        let (waiting_apps, waiting_heading) = if condition == wire::BackupCondition::NotReached {
            let (waiting, held): (Vec<_>, Vec<_>) =
                app_rows.into_iter().partition(|row| row.waiting);
            app_rows = held;
            let heading = if waiting.is_empty() {
                String::new()
            } else {
                words::backup_not_backed_up_heading(locale)
            };
            (waiting, heading)
        } else {
            // A DEVICE BEHIND, FULL OR OLDER names what it still owes, per app, by its own name.
            let rows = self
                .reading()
                .map(|reading| apps::device_waiting(locale, reading))
                .unwrap_or_default();
            let heading = if rows.is_empty() {
                String::new()
            } else {
                words::backup_not_backed_up_heading(locale)
            };
            (rows, heading)
        };
        let (last_good, reason) = match (condition, self.reading()) {
            (wire::BackupCondition::NotReached, Some(reading)) => {
                let name = reading
                    .destinations
                    .iter()
                    .max_by_key(|d| d.last_seen_ms)
                    .map_or_else(
                        || words::backup_unnamed(locale),
                        |d| {
                            if d.label.trim().is_empty() {
                                words::backup_unnamed(locale)
                            } else {
                                d.label.clone()
                            }
                        },
                    );
                (
                    reading.last_ack_ms.map_or_else(String::new, |at| {
                        fill(
                            &words::backup_last_good(locale),
                            &[("when", &line::ago(locale, at, now))],
                        )
                    }),
                    fill(&words::backup_unreachable(locale), &[("name", &name)]),
                )
            }
            // ONE DEVICE BEHIND, FULL OR HOLDING AN OLDER BACKUP names its reason (#1188, NB1).
            (_, Some(reading)) if !frozen => (
                line::behind_last_good(locale, reading, now),
                line::behind_reason(locale, ctx.zone(), reading, now).unwrap_or_default(),
            ),
            // ANOTHER PHONE TOOK OVER: what the member can do about a takeover that was not theirs
            // (#1191, A). The person at the backup device has the last word.
            (_, Some(_)) => (String::new(), backup_home::device_moved_reason(locale)),
            _ => (String::new(), String::new()),
        };
        let key_summary = if key_heading.is_empty() {
            String::new()
        } else if key.synced {
            fill(
                &words::backup_key_summary_synced(locale),
                &[("place", &key.place)],
            )
        } else if key.saved {
            words::backup_key_summary_saved(locale)
        } else {
            words::backup_key_summary_phone(locale)
        };
        wire::BackupHomeData {
            title: words::backup_title(locale),
            apps_heading: if app_rows.is_empty() {
                String::new()
            } else {
                words::backup_apps_heading(locale)
            },
            apps: app_rows,
            line: Some(line::line(
                locale,
                self.reading(),
                frozen,
                self.backing_up_now,
                now,
            )),
            devices_heading: if destinations.is_empty() {
                String::new()
            } else {
                words::backup_devices_heading(locale)
            },
            destinations: destinations
                .iter()
                .map(|destination| self.destination_row(locale, ctx.zone(), destination))
                .collect(),
            add_destination: (!add_label.is_empty()).then(routes::add_destination),
            add_destination_label: add_label,
            // NOR FORGOTTEN FROM HERE: the core refuses it, because the gateway's
            // row is where the moved mark lives (#1080, the sweep).
            forget_label: if frozen {
                String::new()
            } else {
                words::backup_forget(locale)
            },
            rule_choices: self.rule_choices(locale),
            include_videos: self.include_videos,
            include_videos_label: words::backup_include_videos(locale),
            back_up_now_label,
            back_up_now_enabled: self.can_back_up_now(),
            progress: self.progress(locale),
            progress_known: self.progress_fraction().is_some(),
            progress_fraction: self.progress_fraction().unwrap_or_default(),
            battery_sentence: if stood {
                words::backup_battery(locale)
            } else {
                String::new()
            },
            battery_label: if stood {
                words::backup_battery_action(locale)
            } else {
                String::new()
            },
            notice,
            // THE PHONE WILL NOT WAKE CENTRAID, in the platform's own terms.
            background_notice: if self.registered == Some(false) {
                if ctx.platform() == "android" {
                    backup_home::background_off_android(locale)
                } else {
                    backup_home::background_off_ios(locale)
                }
            } else {
                String::new()
            },
            key_heading,
            key_line,
            key_warning,
            key_show: (!key_show_label.is_empty()).then(routes::show_key),
            key_show_label,
            key_synced: key.synced,
            key_sync_label,
            ink: ink as i32,
            condition: condition as i32,
            last_good,
            reason,
            waiting_heading,
            apps_waiting: waiting_apps,
            travel_heading: words::backup_travel_heading(locale),
            over_label: words::backup_over(locale),
            over_value: self.rule.short(locale),
            key_summary,
            restore_label: if frozen {
                String::new()
            } else {
                crate::strings::home::restore_first_action(locale)
            },
            // THE CHECK needs a device to open a backup on, and a vault still on this phone.
            check_label: if frozen || self.destinations().is_empty() {
                String::new()
            } else {
                crate::strings::backup_check::check_row(locale)
            },
            check_status: if frozen || self.destinations().is_empty() {
                String::new()
            } else {
                self.check_status(locale, now)
            },
            check_rate: self
                .reading()
                .and_then(|reading| reading.sample)
                .and_then(|(read, stored)| states::rate_sentence(locale, read, stored))
                .unwrap_or_default(),
            check_warning: self
                .check_kept
                .is_some_and(|kept| kept.kind == rule::CheckKind::Problem),
            posture: Self::posture(locale, ctx.platform()),
            check: Some(super::routes::check()),
            // ONCE, AFTER THE FIRST CONFIRMED BACKUP, while the key is nowhere but this phone.
            key_prompt: (!frozen
                && !self.key_prompt_answered
                && !key.saved
                && !key.synced
                && self.reading().is_some_and(|r| r.last_ack_ms.is_some()))
            .then(|| wire::BackupKeyPrompt {
                title: backup_home::key_prompt_title(locale),
                body: backup_home::key_prompt_body(locale),
                save_label: backup_home::key_prompt_save(locale),
                not_now_label: backup_home::key_prompt_not_now(locale),
                save: Some(super::routes::show_key()),
            }),
            notify_ask: self.notify_ask(ctx),
            notify_off: self.notify_off(ctx),
            notify_settings_label: if self.notify_refused(ctx) {
                backup_home::notify_open_settings(locale)
            } else {
                String::new()
            },
        }
    }

    /// "Checked 2 days ago", "Found a problem 2 days ago" or "Never checked", from the verdict
    /// this phone kept.
    fn check_status(&self, locale: Locale, now_ms: i64) -> String {
        use crate::strings::backup_check as check;
        let Some(kept) = self.check_kept else {
            return check::check_row_never(locale);
        };
        let when = line::ago(locale, kept.at_ms, now_ms).to_lowercase();
        let sentence = match kept.kind {
            rule::CheckKind::Opens => check::check_foot_done(locale),
            rule::CheckKind::Problem => check::check_foot_problem(locale),
        };
        fill(&sentence, &[("when", &when)])
    }

    /// HOW BACKUP RUNS on this platform, never as continuous: what the OS keeps going after the
    /// member leaves, and that a force-quit stops it until the next launch.
    fn posture(locale: Locale, platform: &str) -> String {
        if platform == "android" {
            [
                backup_home::pass_android_unmetered(locale),
                backup_home::pass_force_quit_android(locale),
            ]
        } else {
            [
                backup_home::pass_posture(locale),
                backup_home::pass_force_quit(locale),
            ]
        }
        .join(" ")
    }

    /// Whether the system said no to notifications: the one case the platform's Settings mends.
    fn notify_refused(&self, ctx: &Ctx) -> bool {
        !self.frozen()
            && !self.destinations().is_empty()
            && ctx.alerts().get().permission == Some(wire::NotificationPermission::Denied)
    }

    /// THE ASK, once a device is paired and the phone has not been asked or told "Not now": the
    /// explanation first, the system prompt only after "Allow notifications".
    fn notify_ask(&self, ctx: &Ctx) -> Option<wire::BackupNotifyAsk> {
        let locale = ctx.locale();
        let asked = ctx.alerts().get().permission == Some(wire::NotificationPermission::NotAsked);
        let first = self.destinations().first()?;
        (!self.frozen() && asked && !self.notify_ask_dismissed).then(|| wire::BackupNotifyAsk {
            title: fill(
                &backup_home::notify_ask_title(locale),
                &[("name", &line::device_name(locale, first))],
            ),
            body: backup_home::notify_ask_body(locale),
            allow_label: backup_home::notify_ask_allow(locale),
            not_now_label: backup_home::notify_ask_not_now(locale),
        })
    }

    /// What the phone says when backup alerts cannot arrive on time; empty while they can, and
    /// while the ask above is the thing on screen.
    fn notify_off(&self, ctx: &Ctx) -> String {
        let facts = ctx.alerts().get();
        if self.frozen()
            || self.destinations().is_empty()
            || facts.permission == Some(wire::NotificationPermission::NotAsked)
        {
            return String::new();
        }
        facts
            .line_for(ctx.locale(), crate::kit::permission::Channel::Backup)
            .unwrap_or_default()
    }
}

impl Screen for Backup {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => self.open(ctx),
            Some(E::BackupHome(event)) => self.on_event(event, ctx),
            // The ledger or the vault's files moved, or a run that goes on is due
            // another look: read again.
            Some(E::DataChanged(changed)) => {
                self.read(ctx);
                let mut effects = self.rediscover();
                // THE PAGE ABOVE WAS POPPED (a change with no tables): the check page may have
                // kept a new verdict, so the "Check my backup" row reads it again.
                if changed.tables.is_empty() && self.settled {
                    effects.extend(self.run(Job::CheckKept));
                }
                effects
            }
            Some(E::TimerFired(fired)) if fired.timer == PROGRESS_TIMER => {
                if self.backing_up_now {
                    self.read(ctx);
                    ctx.start_timer(PROGRESS_TIMER, PROGRESS_EVERY);
                }
                Vec::new()
            }
            // BACK IN THE FOREGROUND: the keychain or the background setting may
            // have been turned off meanwhile, and the key is read from the stores
            // each time.
            Some(E::Lifecycle(lifecycle)) if lifecycle.foreground => self.open(ctx),
            // A BROWSE IS FOREGROUND WORK: it ends with the app's front, and with this page.
            Some(E::Lifecycle(_)) => {
                self.foreground = false;
                self.rediscovery.stop()
            }
            Some(E::Left(_)) => self.rediscovery.stop(),
            Some(E::EffectResult(result)) => self.on_result(result, ctx),
            Some(E::OffThreadDone(done)) => {
                // THE CORE'S ANSWER TO AN OFFERED ADDRESS: a kept one ends the browse (the next
                // pass dials it); a refused one leaves the browse on for the next window.
                if self.rediscovery.heard(&done) {
                    if self.rediscovery.refreshed() > 0 && self.rediscovery.pending() == 0 {
                        self.found = true;
                        self.read(ctx);
                        return self.rediscover();
                    }
                    return Vec::new();
                }
                self.job_done(&done, ctx);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let ready = !self.failed && self.standing.is_some() && self.settled;
        let body = ready.then(|| wire::backup_home_state::Body::Data(Box::new(self.data(ctx))));
        // THE READ (#1185): the core's ledger has no gate, so it is loading, failed, or ready (with
        // the one sentence when a refresh failed over what is shown).
        let page = if self.failed {
            Page::<()>::Failed
        } else if ready {
            Page::Ready {
                data: (),
                note: self.refresh_failed.then(|| Note::refresh_failed(locale)),
            }
        } else {
            Page::loading()
        }
        .wire(
            locale,
            |_| wire::Denied::default(),
            wire::EmptyState::default,
        );
        wire::ViewState {
            kind: Some(wire::view_state::Kind::BackupHome(wire::BackupHomeState {
                body,
                page: Some(page),
            })),
            ..Default::default()
        }
    }
}
