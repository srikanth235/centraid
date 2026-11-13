//! CHECK MY BACKUP (#1188, B6, ruling 18): `backup.check`, a page pushed from Backup's Recovery
//! section. It opens each backup device's backup in a spare copy and reads a sample of its files,
//! so the member learns that a backup restores while there is still time to mend it.
//!
//! **The core does the work** (`phone::check`); this page asks for it, shows how far it has got
//! (a determinate bar from the core's own counts, polled while it runs), and says the result per
//! device in the approved words ([`crate::strings::backup_check`]). The member's transfer rule and
//! the link are the pass conductor's, the same ones "Back up now" runs under, so a check never
//! spends a plan the rule keeps files off. A result is a sentence per device and one line at the
//! foot; **a device that was not checked is never drawn as a pass**.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::VaultRequest;
use centraid_vault::time::FireZone;
use prost::Message;
use wire::device_check::{NotRun, Verdict};
use wire::screen_event::Kind as E;

use super::line;
use super::rule::{self, CheckKind, KeptCheck};
use crate::custody::secrets::{self, VaultSecrets};
use crate::passes::rule::Rules;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, backup_check as words, fill};

/// The route name.
pub const NAME: &str = "backup.check";

pub(super) const JOB: &str = "backup.check.run";
const POLL: &str = "backup.check.poll";
const POLL_EVERY: Duration = Duration::from_secs(1);

#[must_use]
pub fn build(_route: &wire::Route, secrets: &VaultSecrets) -> Option<Box<dyn Screen>> {
    Some(Box::new(Check::new(secrets.clone())))
}

/// What the last check found, and when this phone finished it.
struct Done {
    devices: Vec<wire::DeviceCheck>,
    at_ms: i64,
}

/// `backup.check`'s machine.
pub struct Check {
    secrets: VaultSecrets,
    running: bool,
    progress: Option<wire::CheckProgress>,
    done: Option<Done>,
    /// The core could not do the check (or answered nothing): said as a failure with Retry, never
    /// as "Not checked".
    failed: bool,
    /// What the last check that opened a backup found, kept in the device store so the page and
    /// Backup's row still say it after the page closes.
    kept: Option<KeptCheck>,
    /// Whether a backup device is paired; unknown until the page has asked.
    paired: Option<bool>,
}

#[cfg(test)]
impl Check {
    /// The page as it stands after a check (or before one), for the tests.
    pub(super) fn resting(paired: bool, found: Option<(Vec<wire::DeviceCheck>, i64)>) -> Self {
        let mut page = Self::new(VaultSecrets::new());
        page.paired = Some(paired);
        page.done = found.map(|(devices, at_ms)| Done { devices, at_ms });
        page
    }

    pub(super) fn running(progress: wire::CheckProgress) -> Self {
        let mut page = Self::new(VaultSecrets::new());
        page.paired = Some(true);
        page.running = true;
        page.progress = Some(progress);
        page
    }

    pub(super) fn kept(mut self, kept: Option<KeptCheck>) -> Self {
        self.kept = kept;
        self
    }

    pub(super) fn failed(mut self) -> Self {
        self.failed = true;
        self
    }

    pub(super) fn drawn(&self, ctx: &Ctx) -> wire::BackupCheckState {
        self.state(ctx)
    }
}

impl Check {
    fn new(secrets: VaultSecrets) -> Self {
        Self {
            secrets,
            running: false,
            progress: None,
            done: None,
            failed: false,
            kept: None,
            paired: None,
        }
    }

    pub(super) fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|since| i64::try_from(since.as_millis()).ok())
            .unwrap_or_default()
    }

    fn open(&mut self, ctx: &Ctx) {
        self.paired = super::reading::load(ctx)
            .data()
            .map(|standing| !standing.reading.destinations.is_empty());
    }

    /// Ask the core. The rule is the member's and the link is the platform's, as the conductor
    /// holds them.
    fn start(&mut self, ctx: &Ctx) {
        if self.running || self.paired != Some(true) {
            return;
        }
        let rules = Rules::read(&self.secrets);
        let facts = self.secrets.conductor().facts();
        self.running = true;
        self.failed = false;
        self.progress = None;
        ctx.vault_async(
            JOB,
            VaultRequest::CheckBackup(wire::CheckBackupRequest {
                rule: rules.rule.wire() as i32,
                metered: facts.link.metered.unwrap_or(true),
                exclude_videos: !rules.include_videos,
                ..Default::default()
            }),
        );
        ctx.start_timer(POLL, POLL_EVERY);
    }

    fn stop(&mut self, ctx: &Ctx) {
        if self.running {
            ctx.vault_async(
                "backup.check.stop",
                VaultRequest::CheckBackup(wire::CheckBackupRequest {
                    stop: true,
                    ..Default::default()
                }),
            );
        }
    }

    fn poll(&mut self, ctx: &Ctx) {
        if !self.running {
            return;
        }
        if let Ok(wire::Response {
            kind: Some(wire::response::Kind::CheckBackup(answer)),
        }) = ctx.vault(VaultRequest::CheckBackup(wire::CheckBackupRequest {
            progress_only: true,
            ..Default::default()
        })) {
            self.progress = answer.progress;
        }
        ctx.start_timer(POLL, POLL_EVERY);
    }

    /// The core answered, or did not. Returns the effect that keeps a real verdict.
    fn finished(&mut self, bytes: &[u8], ctx: &Ctx) -> Vec<wire::Effect> {
        self.running = false;
        self.progress = None;
        ctx.cancel_timer(POLL);
        let answer = wire::VaultCalled::decode(bytes)
            .ok()
            .filter(|called| called.error.is_none())
            .and_then(|called| wire::Response::decode(called.response.as_slice()).ok())
            .and_then(|response| match response.kind {
                Some(wire::response::Kind::CheckBackup(answer)) => Some(answer),
                _ => None,
            });
        // NO ANSWER (the core refused, or was gone) IS A FAILURE the page says in a sentence with
        // Retry: it is neither a pass nor "Not checked", because the member asked and it did not
        // happen.
        let Some(answer) = answer else {
            self.failed = true;
            self.done = None;
            return Vec::new();
        };
        self.failed = false;
        let at_ms = Self::now_ms();
        self.done = Some(Done {
            devices: answer.devices,
            at_ms,
        });
        // A VERDICT IS KEPT only when a backup was actually opened: a device that did not answer
        // says nothing about whether a backup restores, so it must not replace what was found.
        match self.verdict() {
            Some(kind) => {
                let kept = KeptCheck { kind, at_ms };
                self.kept = Some(kept);
                vec![secrets::effect(vec![rule::write_check(kept)])]
            }
            None => Vec::new(),
        }
    }

    /// What the check on screen found: `None` when no backup was opened.
    fn verdict(&self) -> Option<CheckKind> {
        let done = self.done.as_ref()?;
        let found =
            |d: &wire::DeviceCheck| Verdict::try_from(d.verdict).unwrap_or(Verdict::Unspecified);
        done.devices
            .iter()
            .any(|d| !matches!(found(d), Verdict::NotRun | Verdict::Unspecified))
            .then(|| {
                if self.owes() {
                    CheckKind::Problem
                } else {
                    CheckKind::Opens
                }
            })
    }

    /// The page's foot for a verdict kept earlier, before anything was checked on this visit.
    fn kept_foot(&self, locale: Locale) -> Option<String> {
        let kept = self.kept?;
        let when = line::ago(locale, kept.at_ms, Self::now_ms()).to_lowercase();
        let sentence = match kept.kind {
            CheckKind::Opens => words::check_foot_done(locale),
            CheckKind::Problem => words::check_foot_problem(locale),
        };
        Some(fill(&sentence, &[("when", &when)]))
    }

    /// `Tuesday 10 November, 21:40`, in the member's zone.
    fn when(ctx: &Ctx, ms: i64) -> String {
        let locale = ctx.locale();
        let zone = FireZone::named(ctx.zone())
            .or_else(|_| FireZone::named("UTC"))
            .ok();
        let Some(zone) = zone else {
            return String::new();
        };
        let wall = zone.wall_clock(ms);
        let day = format!("{:04}-{:02}-{:02}", wall.year, wall.month, wall.day);
        let stamp = format!("{day}T{:02}:{:02}", wall.hour, wall.minute);
        format!(
            "{}, {}",
            crate::kit::schedule::rule_words::long_day(locale, &day),
            crate::kit::civil::clock_for(locale, &stamp, ctx.hour_cycle())
        )
    }

    fn held(locale: Locale, device: &wire::DeviceCheck) -> String {
        let opened = device.files_opened.to_string();
        if device.files_held == 1 {
            fill(&words::check_held_one(locale), &[("opened", &opened)])
        } else {
            fill(
                &words::check_held_many(locale),
                &[
                    ("held", &line::grouped(device.files_held)),
                    ("opened", &opened),
                ],
            )
        }
    }

    fn row(ctx: &Ctx, device: &wire::DeviceCheck) -> wire::BackupCheckRow {
        let locale = ctx.locale();
        let when = Self::when(ctx, device.snapshot_ms);
        let said = |text: String| fill(&text, &[("when", &when)]);
        let verdict = Verdict::try_from(device.verdict).unwrap_or(Verdict::Unspecified);
        let (line, detail, tone) = match verdict {
            Verdict::Opens => (
                said(words::check_opens(locale)),
                Self::held(locale, device),
                wire::BackupCheckTone::Ok,
            ),
            Verdict::WontOpen => (
                said(words::check_wont_open(locale)),
                if device.older_snapshot_ms > 0 {
                    fill(
                        &words::check_older_opens(locale),
                        &[("when", &Self::when(ctx, device.older_snapshot_ms))],
                    )
                } else {
                    String::new()
                },
                wire::BackupCheckTone::Bad,
            ),
            Verdict::MissingFiles => (
                if device.files_missing == 1 {
                    said(words::check_missing_one(locale))
                } else {
                    fill(
                        &said(words::check_missing_many(locale)),
                        &[("n", &line::grouped(device.files_missing))],
                    )
                },
                Self::held(locale, device),
                wire::BackupCheckTone::Bad,
            ),
            Verdict::DamagedFile => (
                said(words::check_damaged(locale)),
                Self::held(locale, device),
                wire::BackupCheckTone::Bad,
            ),
            Verdict::NotRun | Verdict::Unspecified => (
                words::check_not_run(locale),
                match NotRun::try_from(device.not_run).unwrap_or(NotRun::Unspecified) {
                    NotRun::WaitingForWifi => words::check_wifi(locale),
                    NotRun::NeedsSpace => words::check_space(locale),
                    NotRun::Stopped => words::check_stopped(locale),
                    NotRun::BackupRunning => words::check_pass_running(locale),
                    NotRun::NoBackupYet => words::check_nothing_yet(locale),
                    NotRun::DidNotAnswer | NotRun::Unspecified => words::check_no_answer(locale),
                },
                wire::BackupCheckTone::NotRun,
            ),
        };
        wire::BackupCheckRow {
            gateway_id: device.gateway_id.clone(),
            name: device.label.clone(),
            line,
            detail,
            tone: tone as i32,
        }
    }

    /// Something the next pass should send again.
    fn owes(&self) -> bool {
        self.done.as_ref().is_some_and(|done| {
            done.devices.iter().any(|d| {
                matches!(
                    Verdict::try_from(d.verdict),
                    Ok(Verdict::MissingFiles | Verdict::DamagedFile | Verdict::WontOpen)
                )
            })
        })
    }

    /// The line at the foot, as the kit's status line carries it.
    fn foot(sentence: String) -> Option<wire::StatusLine> {
        Some(wire::StatusLine {
            sentence,
            ..Default::default()
        })
    }

    fn state(&self, ctx: &Ctx) -> wire::BackupCheckState {
        let locale = ctx.locale();
        let mut state = wire::BackupCheckState {
            title: words::check_title(locale),
            back_label: words::check_back(locale),
            intro: words::check_intro(locale),
            ..Default::default()
        };
        if self.running {
            let progress = self.progress.clone().unwrap_or_default();
            state.heading = words::check_heading_running(locale);
            state.running = true;
            #[allow(clippy::cast_precision_loss)]
            {
                state.fraction = if progress.total == 0 {
                    0.0
                } else {
                    (progress.done as f32 / progress.total as f32).clamp(0.0, 1.0)
                };
            }
            state.rows.push(wire::BackupCheckRow {
                gateway_id: progress.gateway_id.clone(),
                name: progress.label.clone(),
                line: String::new(),
                detail: fill(
                    &words::check_parts(locale),
                    &[
                        ("done", &progress.done.to_string()),
                        ("total", &progress.total.to_string()),
                    ],
                ),
                tone: wire::BackupCheckTone::Running as i32,
            });
            state.status = Self::foot(fill(
                &words::check_running_foot(locale),
                &[("name", &progress.label)],
            ));
            state.action_label = words::check_stop(locale);
            state.action = wire::BackupCheckAction::Stop as i32;
            return state;
        }
        if self.failed {
            state.status = Self::foot(words::check_failed(locale));
            state.action_label = words::check_retry(locale);
            state.action = wire::BackupCheckAction::Check as i32;
            return state;
        }
        match (&self.done, self.paired) {
            (Some(done), _) => {
                state.heading = words::check_heading_result(locale);
                state.rows = done.devices.iter().map(|d| Self::row(ctx, d)).collect();
                let any_checked = done
                    .devices
                    .iter()
                    .any(|d| Verdict::try_from(d.verdict).is_ok_and(|v| v != Verdict::NotRun));
                state.status = Self::foot(if any_checked {
                    fill(
                        &words::check_foot_done(locale),
                        &[(
                            "when",
                            &line::ago(locale, done.at_ms, Self::now_ms()).to_lowercase(),
                        )],
                    )
                } else {
                    words::check_foot_nothing(locale)
                });
                state.action_label = words::check_again(locale);
                state.action = wire::BackupCheckAction::Check as i32;
                if self.owes() {
                    state.back_up_now_label = crate::strings::backup::backup_now(locale);
                }
            }
            (None, Some(false)) => {
                state.status = Self::foot(words::check_foot_unpaired(locale));
                state.action = wire::BackupCheckAction::None as i32;
            }
            (None, _) => {
                state.status = Self::foot(
                    self.kept_foot(locale)
                        .unwrap_or_else(|| words::check_foot_never(locale)),
                );
                state.action_label = if self.kept.is_some() {
                    words::check_again(locale)
                } else {
                    words::check_start(locale)
                };
                state.action = wire::BackupCheckAction::Check as i32;
            }
        }
        state
    }
}

impl Screen for Check {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                self.open(ctx);
                return vec![secrets::effect(vec![rule::read_check()])];
            }
            Some(E::EffectResult(result)) => {
                if let Some(wire::effect_result::Outcome::Secrets(batched)) = result.outcome {
                    // A VERDICT THIS VISIT ALREADY MADE is newer than what the store held.
                    if self.done.is_none() {
                        self.kept = rule::kept_check(batched.answers.first());
                    }
                }
            }
            Some(E::BackupCheck(event)) => match event.kind {
                Some(wire::backup_check_event::Kind::Start(_)) => self.start(ctx),
                Some(wire::backup_check_event::Kind::Stop(_)) => self.stop(ctx),
                Some(wire::backup_check_event::Kind::BackUpNow(_)) => {
                    self.secrets
                        .conductor()
                        .ask(ctx, wire::pass_asked::Ask::BackUpNow);
                }
                None => {}
            },
            Some(E::TimerFired(fired)) if fired.timer == POLL => self.poll(ctx),
            Some(E::OffThreadDone(done)) if done.tag == JOB => {
                return self.finished(&done.bytes, ctx);
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::BackupCheck(self.state(ctx))),
            ..Default::default()
        }
    }
}
