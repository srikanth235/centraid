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
use super::{apps, line, routes};
use crate::custody::secrets::{self, SeedWrite, VaultSecrets};
use crate::kit::read::{Reading, failure};
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
    /// What this phone keeps: the first answer has come (or the shell could not
    /// give it), so the controls are drawn from it and not from defaults.
    settled: bool,
    rule: TransferRule,
    include_videos: bool,
    /// The platform took a background window; `None` before it says.
    registered: Option<bool>,
    /// The platform's reading of its synchronised store; `None` before it says.
    synced: Option<wire::SyncedSecretsStatus>,
    backing_up_now: bool,
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
            settled: false,
            rule: TransferRule::default(),
            include_videos: true,
            registered: None,
            synced: None,
            backing_up_now: false,
            notice: Notice::None,
            in_flight: None,
            waiting: VecDeque::new(),
        }
    }

    // ---- reading ----------------------------------------------------------

    fn read(&mut self, ctx: &Ctx) {
        match reading::load(ctx) {
            Reading::Data(standing) => {
                self.standing = Some(standing);
                self.failed = false;
            }
            // A REFRESH THAT FAILS KEEPS WHAT WAS READ; a first read that fails
            // is a failure, never an empty reading.
            _ => self.failed = self.standing.is_none(),
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
        !self.backing_up_now && !self.destinations().is_empty() && !self.frozen()
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
                self.settled = true;
            }
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
        self.read(ctx);
        let mut effects = self.run(Job::Load);
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

    fn back_up_now(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if !self.can_back_up_now() {
            return Vec::new();
        }
        self.backing_up_now = true;
        self.notice = Notice::None;
        ctx.start_timer(PROGRESS_TIMER, PROGRESS_EVERY);
        ctx.vault_async(
            doors::PASS,
            doors::pass_request(self.rule, self.include_videos),
        );
        Vec::new()
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
            Some(B::SetKeySync(set)) => self.set_key_sync(set.on, ctx),
            Some(B::Retry(_)) => self.open(ctx),
            None => Vec::new(),
        }
    }

    /// An off-thread job came back.
    fn job_done(&mut self, done: &wire::OffThreadDone, ctx: &Ctx) {
        let Some(done) = doors::done(&done.tag, &done.bytes) else {
            return;
        };
        match done {
            // A RUN THAT ENDED IS RE-READ: what it moved is the line's to say.
            Done::Pass => {
                self.backing_up_now = false;
                ctx.cancel_timer(PROGRESS_TIMER);
            }
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
        // WHAT IT HOLDS, as this phone recorded its acknowledgements (#1144).
        let held = if destination.held_bytes == 0 {
            String::new()
        } else {
            fill(
                &words::backup_held(locale),
                &[("size", &bytes(destination.held_bytes))],
            )
        };
        let accessibility_label = [label.as_str(), &held, &detail]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(". ");
        wire::BackupDestinationRow {
            gateway_id: destination.gateway_id.clone(),
            accessibility_label,
            label,
            detail,
            pair_again: destination.pair_again,
            held,
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
        let app_rows = self
            .reading()
            .map(|reading| apps::rows(locale, reading))
            .unwrap_or_default();
        wire::BackupHomeData {
            title: words::backup_title(locale),
            apps_heading: if app_rows.is_empty() {
                String::new()
            } else {
                words::backup_apps_heading(locale)
            },
            apps: app_rows,
            line: Some(line::line(locale, self.reading(), frozen, now)),
            devices_heading: if destinations.is_empty() {
                String::new()
            } else {
                words::backup_devices_heading(locale)
            },
            destinations: destinations
                .iter()
                .map(|destination| self.destination_row(locale, destination))
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
            rule_label: words::backup_rule_heading(locale),
            rule_choices: self.rule_choices(locale),
            include_videos: self.include_videos,
            include_videos_label: words::backup_include_videos(locale),
            back_up_now_label,
            back_up_now_enabled: self.can_back_up_now(),
            backing_up_now: self.backing_up_now,
            progress: self.progress(locale),
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
        }
    }
}

impl Screen for Backup {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => self.open(ctx),
            Some(E::BackupHome(event)) => self.on_event(event, ctx),
            // The ledger or the vault's files moved, or a run that goes on is due
            // another look: read again.
            Some(E::DataChanged(_)) => {
                self.read(ctx);
                Vec::new()
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
            Some(E::EffectResult(result)) => self.on_result(result, ctx),
            Some(E::OffThreadDone(done)) => {
                self.job_done(&done, ctx);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let body = if self.failed {
            wire::backup_home_state::Body::Failure(failure(ctx.locale()))
        } else if self.standing.is_none() || !self.settled {
            wire::backup_home_state::Body::Loading(wire::Loading { first_load: true })
        } else {
            wire::backup_home_state::Body::Data(Box::new(self.data(ctx)))
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::BackupHome(wire::BackupHomeState {
                body: Some(body),
            })),
            ..Default::default()
        }
    }
}
