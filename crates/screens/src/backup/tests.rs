//! The Backup screen and its line, ported from the Kotlin specs that pinned them
//! (`BackupScreenSpec`, `BackupStatusSpec`, the `BackupClaim` half of
//! `CustodyAndBackupClaimSpec`, the status parts of `CoreBackupDoorsSpec`).
//!
//! The screen is driven through its `Screen` interface over a scripted door: a
//! reading a test sets, the clock the core stamped on it, and a counter of how
//! many times it was read. What goes through the real core is
//! `crates/screens/tests/backup.rs`.

use std::cell::{Cell, RefCell};

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::ScreenCtx;
use centraid_core::{CoreError, Result};
use prost::Message;
use wire::backup_line::Tone;
use wire::screen_event::Kind as E;

use super::check::Check;
use super::line::{self, STALE_MS};
use super::reading::Reading;
use super::rule::TransferRule;
use super::{claim, doors, freeze, home, routes};
use crate::custody::secrets::{self, VaultSecrets};
use crate::screen::{Ctx, Environment, Screen, TimerOp};
use crate::strings::{Locale, backup as words, backup_home, fill};
use crate::testing::FakeShell;

const NOW: i64 = 1_790_000_000_000;
const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
const EN: Locale = Locale::En;
const SEED: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ---- readings ------------------------------------------------------------

fn gateway(id: &str, label: &str, addr: Option<&str>, seen: i64, ack: i64) -> wire::Destination {
    wire::Destination {
        gateway_id: id.to_owned(),
        label: label.to_owned(),
        addrs: addr.map(str::to_owned).into_iter().collect(),
        last_seen_ms: seen,
        last_ack_ms: ack,
        ..Default::default()
    }
}

fn home_laptop() -> wire::Destination {
    gateway(
        "gw-1",
        "Home laptop",
        Some("192.168.1.20:7443"),
        NOW - 2 * MINUTE,
        NOW,
    )
}

fn nas() -> wire::Destination {
    gateway("gw-2", "", None, 0, 0)
}

/// The screen spec's reading: ten items, acknowledged two minutes ago.
fn status(destinations: Vec<wire::Destination>) -> wire::BackupStatusResponse {
    wire::BackupStatusResponse {
        destinations,
        acked_at_ms: Some(NOW - 2 * MINUTE),
        last_snapshot_ms: Some(NOW - MINUTE),
        content_total: 10,
        content_confirmed: 10,
        ..Default::default()
    }
}

fn reading(status: &wire::BackupStatusResponse) -> Reading {
    Reading::from_wire(status)
}

fn waiting(rows: &[(wire::WaitReason, u64)]) -> Vec<wire::Waiting> {
    rows.iter()
        .map(|(reason, count)| wire::Waiting {
            reason: *reason as i32,
            count: *count,
        })
        .collect()
}

// ---- the scripted door ----------------------------------------------------

struct Fake {
    status: RefCell<Option<wire::BackupStatusResponse>>,
    reads: Cell<u32>,
}

impl ScreenCtx for Fake {
    fn load(&self, request: &wire::LoadRequest) -> Result<wire::LoadResponse> {
        assert_eq!(
            (request.app.as_str(), request.query.as_str()),
            ("shell", "backup-status")
        );
        self.reads.set(self.reads.get() + 1);
        match self.status.borrow().clone() {
            Some(status) => Ok(wire::LoadResponse {
                answer: Some(wire::AppQueryResponse {
                    answer: Some(wire::app_query_response::Answer::ShellBackupStatus(
                        wire::ShellBackupStatus {
                            status: Some(status),
                            now_ms: NOW,
                        },
                    )),
                }),
                tables: vec!["backup".to_owned(), "blob".to_owned()],
            }),
            None => Err(CoreError::Unavailable {
                reason: "no core".to_owned(),
            }),
        }
    }

    fn act(&self, _: &wire::ActRequest) -> Result<wire::ActResponse> {
        Err(CoreError::Unavailable {
            reason: "the backup screen writes nothing to the vault".to_owned(),
        })
    }

    fn push(&self, _: wire::ScreenUpdate) {}

    fn wake_after(&self, _: std::time::Duration) {}

    /// The device's ledger of paired gateways, which is what the reading names.
    fn vault(&self, request: centraid_core::screens::VaultRequest) -> Result<wire::Response> {
        use centraid_core::screens::VaultRequest;
        match request {
            VaultRequest::Pins(_) => Ok(wire::Response {
                kind: Some(wire::response::Kind::Pins(wire::PinsResponse {
                    destinations: self
                        .status
                        .borrow()
                        .as_ref()
                        .map(|status| status.destinations.clone())
                        .unwrap_or_default(),
                })),
            }),
            other => Err(CoreError::Unavailable {
                reason: format!("the scripted door answers no {other:?}"),
            }),
        }
    }
}

/// A Backup screen over a scripted core and a shell with two stores.
struct Page {
    fake: Fake,
    env: Environment,
    screen: Box<dyn Screen>,
    secrets: VaultSecrets,
    shell: FakeShell,
    /// Effects asked and not yet answered.
    effects: Vec<wire::Effect>,
    /// The tags of the off-thread jobs asked and not yet answered, oldest first.
    jobs: Vec<String>,
    /// Whether the platform took a background window.
    background: bool,
    timers: Vec<(String, bool)>,
}

impl Page {
    fn over(status: wire::BackupStatusResponse) -> Self {
        let secrets = VaultSecrets::new();
        let mut shell = FakeShell::default();
        shell
            .synced
            .insert(secrets::SEED_KEY.to_owned(), SEED.to_owned());
        shell.device.insert(
            secrets::LOCAL_WORDS.to_owned(),
            vec!["abandon"; 24].join(" "),
        );
        Self {
            fake: Fake {
                status: RefCell::new(Some(status)),
                reads: Cell::new(0),
            },
            env: Environment {
                platform: "ios".to_owned(),
                ..Environment::default()
            },
            screen: home::build(&routes::home(), &secrets).expect("the screen builds"),
            secrets,
            shell,
            effects: Vec::new(),
            jobs: Vec::new(),
            background: true,
            timers: Vec::new(),
        }
    }

    /// Opened and every answer the shell gives delivered.
    fn open(status: wire::BackupStatusResponse) -> Self {
        let mut page = Self::over(status);
        page.send(E::Appeared(wire::Appeared {}));
        page.serve();
        page
    }

    fn send(&mut self, event: E) {
        let ctx = Ctx::new(&self.fake, &self.env);
        let effects = self
            .screen
            .update(wire::ScreenEvent { kind: Some(event) }, &ctx);
        let done = ctx.finish();
        for op in done.timers {
            match op {
                TimerOp::Start(name, _) => self.timers.push((name, true)),
                TimerOp::Cancel(name) => self.timers.push((name, false)),
            }
        }
        self.jobs.extend(done.jobs.into_iter().map(|(tag, _)| tag));
        self.effects.extend(effects);
    }

    fn say(&mut self, kind: wire::backup_home_event::Kind) {
        self.send(E::BackupHome(wire::BackupHomeEvent { kind: Some(kind) }));
    }

    /// Answer the effects a shell answers itself; leave the calls.
    fn serve(&mut self) {
        while let Some(at) = self.effects.iter().position(|effect| {
            matches!(
                effect.kind,
                Some(
                    wire::effect::Kind::Secrets(_)
                        | wire::effect::Kind::SyncedProbe(_)
                        | wire::effect::Kind::BackgroundProbe(_)
                )
            )
        }) {
            let effect = self.effects.remove(at);
            let outcome = match effect.kind {
                Some(wire::effect::Kind::Secrets(batch)) => {
                    wire::effect_result::Outcome::Secrets(self.shell.batch(&batch))
                }
                Some(wire::effect::Kind::SyncedProbe(_)) => {
                    wire::effect_result::Outcome::SyncedStatus(wire::SyncedSecretsStatus {
                        synchronizing: self.shell.synchronizing,
                        restores_after_setup: self.shell.restores_after_setup,
                    })
                }
                _ => wire::effect_result::Outcome::BackgroundStatus(wire::BackgroundStatus {
                    registered: self.background,
                }),
            };
            self.send(E::EffectResult(wire::EffectResult {
                effect_id: 0,
                outcome: Some(outcome),
            }));
        }
    }

    /// Answer the oldest job with `response`: what the core answered, or nothing
    /// when it refused.
    fn answer_job(&mut self, response: Option<wire::response::Kind>) {
        let tag = self.jobs.remove(0);
        let called = wire::VaultCalled {
            response: response
                .map(|kind| wire::Response { kind: Some(kind) }.encode_to_vec())
                .unwrap_or_default(),
            error: None,
        };
        self.send(E::OffThreadDone(wire::OffThreadDone {
            tag,
            bytes: called.encode_to_vec(),
        }));
    }

    /// What the pass service does with the screen's ask: it takes it off the conductor's inbox.
    fn service_takes_the_ask(&self) -> Vec<wire::pass_asked::Ask> {
        self.secrets.conductor().take_asks()
    }

    fn state(&self) -> wire::BackupHomeState {
        let ctx = Ctx::new(&self.fake, &self.env);
        match self.screen.view(&ctx).kind {
            Some(wire::view_state::Kind::BackupHome(state)) => state,
            other => panic!("not the backup screen: {other:?}"),
        }
    }

    fn data(&self) -> wire::BackupHomeData {
        match self.state().body {
            Some(wire::backup_home_state::Body::Data(data)) => *data,
            other => panic!("the screen is not ready: {other:?}"),
        }
    }

    fn reads(&self) -> u32 {
        self.fake.reads.get()
    }

    fn set_status(&self, status: wire::BackupStatusResponse) {
        *self.fake.status.borrow_mut() = Some(status);
    }
}

// ============================================================================
// The line (BackupStatusSpec)
// ============================================================================

fn lined(status: &wire::BackupStatusResponse, frozen: bool) -> wire::BackupLine {
    line::line(EN, Some(&reading(status)), frozen, NOW)
}

fn steady() -> wire::BackupStatusResponse {
    wire::BackupStatusResponse {
        destinations: vec![gateway(
            "gw-1",
            "Home laptop",
            Some("192.168.1.20:7443"),
            NOW - MINUTE,
            NOW - 2 * MINUTE,
        )],
        acked_at_ms: Some(NOW - 2 * MINUTE),
        last_snapshot_ms: Some(NOW - 2 * MINUTE),
        content_total: 1_240,
        content_confirmed: 1_240,
        ..Default::default()
    }
}

#[test]
fn nothing_acknowledged_is_never_backed_up_whatever_else_the_reading_says() {
    let line = lined(
        &wire::BackupStatusResponse {
            acked_at_ms: None,
            ..steady()
        },
        false,
    );
    assert_eq!(line.sentence, words::backup_line_never(EN));
    assert!(!line.sentence.starts_with("Backed up"));
    assert_eq!(line.tone, Tone::Attention as i32);
}

#[test]
fn records_acknowledged_with_items_waiting_say_records_and_say_how_many() {
    let line = lined(
        &wire::BackupStatusResponse {
            content_confirmed: 1_203,
            waiting: waiting(&[(wire::WaitReason::Wifi, 30), (wire::WaitReason::Icloud, 7)]),
            ..steady()
        },
        false,
    );
    assert_eq!(line.sentence, "Records backed up 2 minutes ago.");
    assert_eq!(line.detail, "1,203 of 1,240 photos and files");
    assert_eq!(
        line.waiting
            .iter()
            .map(|row| row.reason)
            .collect::<Vec<_>>(),
        vec![
            wire::backup_waiting_row::Reason::Wifi as i32,
            wire::backup_waiting_row::Reason::Icloud as i32
        ]
    );
    assert_eq!(
        line.waiting
            .iter()
            .map(|row| row.sentence.as_str())
            .collect::<Vec<_>>(),
        vec!["30 waiting for Wi-Fi", "7 waiting in iCloud"]
    );
    assert_eq!(
        line.accessibility_label,
        "Records backed up 2 minutes ago. 1,203 of 1,240 photos and files. 30 waiting for Wi-Fi. 7 waiting in iCloud"
    );
}

#[test]
fn the_waits_a_member_acts_on_have_rows_of_their_own() {
    // The member's tap, and a machine that is not the gateway.
    let line = lined(
        &wire::BackupStatusResponse {
            content_confirmed: 1_203,
            waiting: waiting(&[(wire::WaitReason::Untrusted, 2), (wire::WaitReason::Ask, 4)]),
            ..steady()
        },
        false,
    );
    assert_eq!(
        line.waiting
            .iter()
            .map(|row| row.sentence.as_str())
            .collect::<Vec<_>>(),
        vec![
            "4 waiting. Tap Back up now.",
            "2 waiting. Wrong device answered."
        ]
    );
    // THE ROW'S NUMBERS ARE THE CORE'S, so a shell reading either sees one value.
    assert_eq!(
        wire::backup_waiting_row::Reason::Ask as i32,
        wire::WaitReason::Ask as i32
    );
    assert_eq!(
        wire::backup_waiting_row::Reason::Untrusted as i32,
        wire::WaitReason::Untrusted as i32
    );
    // AN IMPOSTOR AT THE GATEWAY'S ADDRESS earns a look, however recent the ack;
    // waiting for the member's tap does not.
    assert_eq!(line.tone, Tone::Attention as i32);
    let ask = lined(
        &wire::BackupStatusResponse {
            content_confirmed: 1_203,
            waiting: waiting(&[(wire::WaitReason::Ask, 4)]),
            ..steady()
        },
        false,
    );
    assert_eq!(ask.tone, Tone::Quiet as i32);
}

#[test]
fn a_gateway_that_refused_for_room_and_one_that_forgot_this_phone_have_rows_of_their_own() {
    let line = lined(
        &wire::BackupStatusResponse {
            content_confirmed: 1_200,
            waiting: waiting(&[
                (wire::WaitReason::Refused, 25),
                (wire::WaitReason::PairAgain, 15),
            ]),
            ..steady()
        },
        false,
    );
    assert_eq!(
        line.waiting
            .iter()
            .map(|row| row.sentence.as_str())
            .collect::<Vec<_>>(),
        vec![
            "25 waiting. Your backup device is full or refusing.",
            "15 waiting. Pair your backup device again."
        ]
    );
    assert_eq!(
        wire::backup_waiting_row::Reason::Refused as i32,
        wire::WaitReason::Refused as i32
    );
    assert_eq!(
        wire::backup_waiting_row::Reason::PairAgain as i32,
        wire::WaitReason::PairAgain as i32
    );
}

#[test]
fn a_phone_with_no_room_to_copy_its_vault_says_so_in_a_row_of_its_own() {
    let line = lined(
        &wire::BackupStatusResponse {
            content_confirmed: 1_200,
            waiting: waiting(&[(wire::WaitReason::NoRoom, 212)]),
            ..steady()
        },
        false,
    );
    assert_eq!(
        line.waiting
            .iter()
            .map(|row| row.sentence.as_str())
            .collect::<Vec<_>>(),
        vec!["212 waiting. This phone is too full to back up. Free some space."]
    );
    assert_eq!(
        wire::backup_waiting_row::Reason::NoRoom as i32,
        wire::WaitReason::NoRoom as i32
    );
}

#[test]
fn every_gateway_refusing_this_phones_token_reads_pair_again_never_all_backed_up() {
    // THE LEDGER STILL SAYS EVERYTHING IS ACKNOWLEDGED: nothing waits, so no row
    // can say otherwise; the mark on the gateway does.
    let mut refused = steady();
    refused.destinations[0].pair_again = true;
    let line = lined(&refused, false);
    assert_eq!(line.sentence, words::backup_line_pair_again(EN));
    assert_eq!(line.status, words::backup_status_pair_again(EN));
    assert!(!line.sentence.starts_with("Backed up"));
    assert!(!line.status.starts_with("Backed up"));
    assert_eq!(line.tone, Tone::Attention as i32);
    assert_eq!(line.detail, "All 1,240 photos and files");

    // ONE OF TWO REFUSING: the other carries the backup, so the line is the
    // ordinary one and only its tone earns a look.
    let mut half = refused.clone();
    half.destinations
        .push(gateway("gw-2", "NAS", None, NOW - MINUTE, NOW - MINUTE));
    let line = lined(&half, false);
    assert_eq!(line.sentence, "Backed up 2 minutes ago.");
    assert_eq!(line.tone, Tone::Attention as i32);

    // A MOVED VAULT STILL SAYS SO ABOVE EVERYTHING.
    assert_eq!(
        lined(&refused, true).sentence,
        words::backup_line_frozen(EN)
    );
}

#[test]
fn everything_acknowledged_is_backed_up_quietly_at_the_gateways_time() {
    let line = lined(&steady(), false);
    assert_eq!(line.sentence, "Backed up 2 minutes ago.");
    assert_eq!(line.detail, "All 1,240 photos and files");
    assert_eq!(line.confirmed, 1_240);
    assert_eq!(line.tone, Tone::Quiet as i32);
}

#[test]
fn no_gateway_paired_is_an_offer_to_pair_not_a_status() {
    let line = lined(
        &wire::BackupStatusResponse {
            destinations: Vec::new(),
            ..steady()
        },
        false,
    );
    assert_eq!(line.sentence, words::backup_line_unpaired(EN));
    assert_eq!(line.tone, Tone::Attention as i32);
}

#[test]
fn a_moved_vault_says_so_above_everything_else() {
    let line = lined(&steady(), true);
    assert_eq!(line.sentence, words::backup_line_frozen(EN));
    assert_eq!(line.tone, Tone::Urgent as i32);
}

#[test]
fn an_old_acknowledgement_or_a_gateway_unreached_for_days_earns_attention() {
    let old = wire::BackupStatusResponse {
        acked_at_ms: Some(NOW - 4 * DAY),
        ..steady()
    };
    assert_eq!(lined(&old, false).tone, Tone::Attention as i32);
    let mut unreached = steady();
    unreached.destinations[0].last_seen_ms = NOW - 5 * DAY;
    assert_eq!(lined(&unreached, false).tone, Tone::Attention as i32);
    unreached.destinations[0].last_seen_ms = 0;
    assert_eq!(lined(&unreached, false).tone, Tone::Attention as i32);
    assert_eq!(STALE_MS, 3 * DAY);
}

/// **B11.** A clock set a year ahead and corrected leaves an acknowledgement dated in the
/// future; it must not read as a recent, healthy backup.
#[test]
fn an_acknowledgement_dated_in_the_future_earns_attention() {
    let ahead = wire::BackupStatusResponse {
        acked_at_ms: Some(NOW + 300 * DAY),
        ..steady()
    };
    assert_eq!(lined(&ahead, false).tone, Tone::Attention as i32);
    // Two clocks a few minutes apart are not a clock that was set ahead.
    let close = wire::BackupStatusResponse {
        acked_at_ms: Some(NOW + MINUTE),
        ..steady()
    };
    assert_ne!(lined(&close, false).tone, Tone::Attention as i32);
}

#[test]
fn a_vault_the_core_could_not_be_asked_about_draws_no_line_at_all() {
    assert_eq!(
        line::line(EN, None, false, NOW),
        wire::BackupLine::default()
    );
}

#[test]
fn how_long_ago_is_elapsed_time_and_a_clock_ahead_of_ours_is_just_now() {
    let ago = |then: i64| line::ago(EN, then, NOW);
    assert_eq!(ago(NOW), "just now");
    assert_eq!(ago(NOW + 5 * MINUTE), "just now");
    assert_eq!(ago(NOW - MINUTE), "1 minute ago");
    assert_eq!(ago(NOW - 59 * MINUTE), "59 minutes ago");
    assert_eq!(ago(NOW - 60 * MINUTE), "1 hour ago");
    assert_eq!(ago(NOW - 5 * HOUR), "5 hours ago");
    assert_eq!(ago(NOW - DAY), "1 day ago");
    assert_eq!(ago(NOW - 3 * DAY), "3 days ago");
}

#[test]
fn counts_group_their_digits() {
    assert_eq!(line::grouped(0), "0");
    assert_eq!(line::grouped(999), "999");
    assert_eq!(line::grouped(1_000), "1,000");
    assert_eq!(line::grouped(1_234_567), "1,234,567");
}

#[test]
fn a_moved_vault_freezes_with_what_is_only_here_since_the_last_acknowledgement() {
    let held = reading(&steady());
    assert_eq!(freeze::for_reading(Some(&held), None), None);
    let partial = reading(&wire::BackupStatusResponse {
        content_confirmed: 1_200,
        ..steady()
    });
    let moved = freeze::for_reading(Some(&partial), Some(NOW)).expect("moved");
    assert_eq!(moved.unacked, 40);
    assert_eq!(moved.since_ms, NOW - 2 * MINUTE);
    // THE LEDGER ALONE IS ENOUGH: a vault the core remembers as moved freezes on
    // the next read, with no pass needed.
    let remembered = reading(&wire::BackupStatusResponse {
        frozen: true,
        ..steady()
    });
    assert_eq!(
        freeze::for_reading(Some(&remembered), None)
            .expect("moved")
            .unacked,
        0
    );
    // NOTHING EVER ACKNOWLEDGED: the move's own time dates it.
    let never = reading(&wire::BackupStatusResponse {
        acked_at_ms: None,
        ..steady()
    });
    assert_eq!(
        freeze::for_reading(Some(&never), Some(NOW))
            .expect("moved")
            .since_ms,
        NOW
    );
}

#[test]
fn the_status_reads_the_ledger_destinations_counts_and_why_the_rest_waits() {
    let wired = wire::BackupStatusResponse {
        destinations: vec![
            home_laptop(),
            wire::Destination {
                pair_again: true,
                ..nas()
            },
        ],
        acked_at_ms: Some(NOW - MINUTE),
        last_snapshot_ms: Some(NOW - 30_000),
        content_total: 12,
        content_confirmed: 9,
        pending_bytes: 4_096,
        spool_bytes: 2_048,
        waiting: waiting(&[
            (wire::WaitReason::Wifi, 2),
            (wire::WaitReason::Wifi, 1),
            (wire::WaitReason::Unspecified, 5),
            (wire::WaitReason::Charger, 0),
        ]),
        frozen: true,
        ..Default::default()
    };
    let read = reading(&wired);
    assert_eq!(read.unconfirmed(), 3);
    assert_eq!(read.last_ack_ms, Some(NOW - MINUTE));
    assert_eq!(read.last_snapshot_ms, Some(NOW - 30_000));
    // ZERO IS "NEVER" ON THE WIRE, and never a time.
    assert_eq!(read.destinations[1].last_seen_ms, None);
    assert_eq!(read.destinations[1].last_ack_ms, None);
    assert_eq!(read.destinations[0].last_ack_ms, Some(NOW));
    assert!(read.destinations[1].pair_again);
    // Reasons add up per reason; an unspecified one, and one with no items, are absent.
    assert_eq!(read.waiting_for(wire::WaitReason::Wifi), 3);
    assert_eq!(read.waiting.len(), 1);
    assert_eq!((read.pending_bytes, read.spool_bytes), (4_096, 2_048));
    assert!(read.frozen);
    // Nothing confirmed beyond the total is a count below zero, never a wrap.
    let over = Reading {
        content_confirmed: 20,
        ..read
    };
    assert_eq!(over.unconfirmed(), 0);
}

// ============================================================================
// What may be claimed (the BackupClaim half of CustodyAndBackupClaimSpec)
// ============================================================================

#[test]
fn nothing_is_backed_up_before_the_gateway_has_acknowledged_a_commit() {
    assert_eq!(claim::line(EN, None, 0, "just now"), "Not backed up yet.");
    assert!(!claim::is_backed_up(None, 0));
    // AND NOT EVEN WITH AN EMPTY SPOOL: "no changes waiting" is not the same
    // claim as "the gateway has it".
    assert!(!claim::line(EN, None, 0, "just now").contains("Backed up"));
}

#[test]
fn an_acknowledgement_with_changes_behind_it_leads_with_what_is_not_backed_up() {
    let line = claim::line(EN, Some(1_770_000_000_000), 3, "2 minutes ago");
    assert_eq!(line, "3 changes not backed up. Last backup 2 minutes ago.");
    assert!(!claim::is_backed_up(Some(1_770_000_000_000), 3));
}

#[test]
fn one_change_reads_as_one_because_a_member_counts() {
    assert_eq!(
        claim::line(EN, Some(1), 1, "an hour ago"),
        "1 change not backed up. Last backup an hour ago."
    );
}

#[test]
fn an_acknowledgement_with_an_empty_spool_is_the_only_thing_that_says_backed_up() {
    assert_eq!(
        claim::line(EN, Some(1_770_000_000_000), 0, "2 minutes ago"),
        "Records backed up 2 minutes ago."
    );
    assert!(claim::is_backed_up(Some(1_770_000_000_000), 0));
}

#[test]
fn a_frozen_vault_says_the_changes_are_only_here_and_never_that_they_are_lost() {
    let line = claim::frozen(EN, 4, "12 March");
    assert!(line.contains("Moved to another phone"));
    assert!(line.contains("4 changes since 12 March are only here"));
    assert!(!line.contains("lost") && !line.contains("deleted"));
    assert!(claim::frozen(EN, 0, "12 March").contains("Nothing unsent here"));
    assert!(claim::frozen(EN, 1, "12 March").contains("1 change since 12 March is only here"));
}

#[test]
fn a_pass_is_told_in_one_sentence_per_reason_and_a_deadline_is_not_an_error() {
    use wire::DrainStop as S;
    let say = |stopped, pending| claim::stopped_sentence(EN, stopped, pending);
    assert_eq!(
        say(S::Empty, 0),
        "Your backup device has everything that was ready."
    );
    assert_eq!(
        say(S::Deadline, 2_000_000),
        "Still backing up. 2.0 MB to go."
    );
    assert_eq!(
        say(S::Unreachable, 99),
        "Backup device didn't answer. Will try again."
    );
    assert_eq!(
        say(S::Untrusted, 99),
        "That isn't your backup device. Nothing was sent."
    );
    assert_eq!(say(S::Refused, 99), words::backup_refused(EN));
    // AN UNKNOWN STOP READS AS UNREACHABLE: "try again" is never a harmful remedy.
    assert_eq!(say(S::Unspecified, 0), say(S::Unreachable, 0));
    assert_eq!(
        claim::moved_sentence(EN),
        "Moved to another phone. This phone is read-only."
    );
    let all: Vec<String> = [
        S::Empty,
        S::Deadline,
        S::Unreachable,
        S::Untrusted,
        S::Refused,
    ]
    .into_iter()
    .map(|stopped| say(stopped, 99))
    .collect();
    for (at, sentence) in all.iter().enumerate() {
        assert!(!sentence.to_lowercase().contains("error"), "{sentence}");
        assert!(all.iter().skip(at + 1).all(|other| other != sentence));
    }
}

#[test]
fn bytes_are_decimal_and_rounded_down() {
    assert_eq!(claim::bytes(999), "999 bytes");
    assert_eq!(claim::bytes(12_345), "12 KB");
    assert_eq!(claim::bytes(12_345_678), "12.3 MB");
    // A TENTH BELOW 100 OF THE UNIT, WHOLE FROM THERE, rounded down: both sides of the line.
    assert_eq!(claim::bytes(99_999_999), "99.9 MB");
    assert_eq!(claim::bytes(100_000_000), "100 MB");
    assert_eq!(claim::bytes(340_000_000), "340 MB");
    // GIGABYTES UNDER A HUNDRED KEEP ONE DECIMAL, never rounded up (#1144).
    assert_eq!(claim::bytes(2_999_999_999), "2.9 GB");
    assert_eq!(claim::bytes(5_000_000_000), "5.0 GB");
    assert_eq!(claim::bytes(120_400_000_000), "120 GB");
}

#[test]
fn the_postures_a_member_is_told_about_uploading_are_honest() {
    let posture = backup_home::pass_posture(EN);
    assert!(posture.contains("keeps uploading"));
    assert!(!posture.contains("does not upload while the app is closed"));
    let force = backup_home::pass_force_quit(EN);
    assert!(force.contains("swipe Centraid away"));
    assert!(force.contains("cancels those uploads until you open it again"));
    assert!(force.contains("Low Power Mode pauses them"));
    assert!(backup_home::pass_android_unmetered(EN).contains("your setting"));
    assert_eq!(backup_home::pass_in_flight_title(EN), "Backing up");
}

// ============================================================================
// The screen (BackupScreenSpec)
// ============================================================================

fn both() -> wire::BackupStatusResponse {
    status(vec![home_laptop(), nas()])
}

#[test]
fn a_read_draws_the_line_the_gateways_and_the_controls_every_word_finished() {
    let mut page = Page::over(both());
    page.send(E::Appeared(wire::Appeared {}));
    // UNTIL THE PHONE'S OWN SETTINGS HAVE BEEN READ the screen is loading, never
    // the default rule flipping to the member's.
    assert!(matches!(
        page.state().page.and_then(|page| page.state),
        Some(wire::page_state::State::Loading(_))
    ));
    assert!(page.state().body.is_none());
    page.serve();
    page.shell.device.insert(
        super::rule::RULE_KEY.to_owned(),
        "wifi-and-cellular-photos".to_owned(),
    );
    let mut page = Page::over(both());
    page.shell.device.insert(
        super::rule::RULE_KEY.to_owned(),
        "wifi-and-cellular-photos".to_owned(),
    );
    page.send(E::Appeared(wire::Appeared {}));
    page.serve();
    let data = page.data();
    assert_eq!(data.title, words::backup_title(EN));
    // THE LINE IS HOME'S LINE, the same value and the same words.
    assert_eq!(
        data.line,
        Some(line::line(EN, Some(&reading(&both())), false, NOW))
    );
    assert_eq!(
        data.line.as_ref().expect("line").sentence,
        "Backed up 2 minutes ago."
    );
    assert_eq!(
        data.destinations
            .iter()
            .map(|row| row.gateway_id.as_str())
            .collect::<Vec<_>>(),
        vec!["gw-1", "gw-2"]
    );
    assert_eq!(
        data.destinations
            .iter()
            .map(|row| row.label.as_str())
            .collect::<Vec<_>>(),
        vec!["Home laptop", "Your backup device"]
    );
    assert_eq!(
        data.destinations
            .iter()
            .map(|row| row.detail.as_str())
            .collect::<Vec<_>>(),
        vec![
            "192.168.1.20:7443 · Reached 2 minutes ago",
            "Not reached yet"
        ]
    );
    assert_eq!(
        data.destinations[0].accessibility_label,
        "Home laptop. Up to date. 192.168.1.20:7443 · Reached 2 minutes ago"
    );
    assert_eq!(data.devices_heading, words::backup_devices_heading(EN));
    assert_eq!(
        data.add_destination_label,
        words::backup_add_destination(EN)
    );
    assert_eq!(data.add_destination, Some(routes::add_destination()));
    assert_eq!(data.forget_label, words::backup_forget(EN));
    assert_eq!(
        data.rule_choices
            .iter()
            .map(|choice| choice.stored.as_str())
            .collect::<Vec<_>>(),
        vec!["wifi-only", "wifi-and-cellular-photos", "manual"]
    );
    assert_eq!(
        data.rule_choices
            .iter()
            .map(|choice| choice.picked)
            .collect::<Vec<_>>(),
        vec![false, true, false]
    );
    assert_eq!(
        data.rule_choices[0].sentence,
        "Full-size photos and videos back up and download on Wi-Fi only."
    );
    assert!(data.include_videos);
    assert_eq!(data.include_videos_label, words::backup_include_videos(EN));
    assert_eq!(data.back_up_now_label, words::backup_now(EN));
    assert!(data.back_up_now_enabled);
    assert_eq!(
        (data.notice.as_str(), data.background_notice.as_str()),
        ("", "")
    );
}

#[test]
fn a_gateway_that_refused_this_phones_token_says_to_pair_it_again_where_it_says_when_it_was_reached()
 {
    let mut refused = home_laptop();
    refused.pair_again = true;
    let page = Page::open(status(vec![refused.clone(), nas()]));
    let data = page.data();
    assert!(
        !data.destinations[1]
            .detail
            .contains(&words::backup_dest_pair_again(EN))
    );
    assert_eq!(
        data.destinations[0].detail,
        format!(
            "192.168.1.20:7443 · Reached 2 minutes ago · {}",
            words::backup_dest_pair_again(EN)
        )
    );
    // ONE REFUSING OF TWO leaves the line the ordinary one; every gateway
    // refusing says pair again.
    assert_ne!(
        data.line.as_ref().expect("line").sentence,
        words::backup_line_pair_again(EN)
    );
    let all = Page::open(status(vec![refused])).data();
    let all_line = all.line.expect("line");
    assert_eq!(all_line.sentence, words::backup_line_pair_again(EN));
}

#[test]
fn battery_saving_is_mentioned_only_once_a_backlog_has_stood_a_day() {
    let behind = |ack: i64, confirmed: u64, pending: u64| wire::BackupStatusResponse {
        acked_at_ms: Some(ack),
        content_confirmed: confirmed,
        pending_bytes: pending,
        ..status(vec![home_laptop(), nas()])
    };
    // BEHIND AND UNACKNOWLEDGED FOR MORE THAN A DAY: worth a sentence, and the
    // shell decides whether the platform is actually holding it back.
    let stood = Page::open(behind(NOW - 25 * HOUR, 7, 0)).data();
    assert_eq!(stood.battery_sentence, words::backup_battery(EN));
    assert_eq!(stood.battery_label, words::backup_battery_action(EN));
    // Sealed bytes still waiting are a backlog too.
    assert_eq!(
        Page::open(behind(NOW - 25 * HOUR, 10, 4_096))
            .data()
            .battery_sentence,
        words::backup_battery(EN)
    );
    let none = |status: wire::BackupStatusResponse| {
        let data = Page::open(status).data();
        assert_eq!(
            (data.battery_sentence.as_str(), data.battery_label.as_str()),
            ("", "")
        );
    };
    // A FRESH ACKNOWLEDGEMENT, an old one with nothing behind it, a vault never
    // acknowledged, nothing paired, a frozen vault: none.
    none(behind(NOW - 23 * HOUR, 7, 0));
    none(behind(NOW - 25 * HOUR, 10, 0));
    none(wire::BackupStatusResponse {
        acked_at_ms: None,
        content_confirmed: 0,
        ..both()
    });
    none(wire::BackupStatusResponse {
        destinations: Vec::new(),
        ..behind(NOW - 25 * HOUR, 7, 0)
    });
    none(wire::BackupStatusResponse {
        frozen: true,
        ..behind(NOW - 25 * HOUR, 7, 0)
    });
}

#[test]
fn a_phone_that_will_not_wake_centraid_says_so_in_the_platforms_terms() {
    let mut page = Page::over(both());
    page.background = false;
    page.send(E::Appeared(wire::Appeared {}));
    page.serve();
    assert_eq!(
        page.data().background_notice,
        "Background App Refresh is off, so Centraid only catches up when you open it."
    );
    let mut android = Page::over(both());
    android.env.platform = "android".to_owned();
    android.background = false;
    android.send(E::Appeared(wire::Appeared {}));
    android.serve();
    assert_eq!(
        android.data().background_notice,
        "Centraid cannot catch up in the background on this phone."
    );
    assert_eq!(Page::open(both()).data().background_notice, "");
}

#[test]
fn a_vault_that_moved_offers_no_forget_no_add_and_a_forget_sent_anyway_asks_nothing() {
    // THE CORE REFUSES A FORGET: forgetting would drop the moved mark with the
    // gateway's row, and a later pairing would take the vault over with this
    // phone's older copy. And ON THE SIMULATOR the frozen old phone paired its
    // gateway from the add button, took the vault over with its stale copy, and
    // set the head over the newer phone's: a superseded phone comes back by
    // restoring. A button that can only fail is not drawn.
    let mut page = Page::open(wire::BackupStatusResponse {
        frozen: true,
        ..both()
    });
    let data = page.data();
    assert_eq!(data.forget_label, "");
    assert_eq!(data.add_destination_label, "");
    assert_eq!(data.add_destination, None);
    page.say(wire::backup_home_event::Kind::ForgetDestination(
        wire::backup_home_event::ForgetDestination {
            gateway_id: "gw-1".to_owned(),
        },
    ));
    assert!(page.jobs.is_empty());
    let live = Page::open(both()).data();
    assert_eq!(live.forget_label, words::backup_forget(EN));
    assert_eq!(
        live.add_destination_label,
        words::backup_add_destination(EN)
    );
}

#[test]
fn back_up_now_needs_a_gateway_a_vault_that_has_not_moved_and_no_run_already_going() {
    let tap = wire::backup_home_event::Kind::BackUpNow(wire::backup_home_event::BackUpNow {});
    // NO DEAD PRIMARY: nothing to back up to draws no "Back up now" at all.
    let mut unpaired = Page::open(status(Vec::new()));
    let data = unpaired.data();
    assert!(!data.back_up_now_enabled);
    assert_eq!(data.back_up_now_label, "");
    unpaired.say(tap.clone());
    assert!(unpaired.jobs.is_empty());

    let mut frozen = Page::open(wire::BackupStatusResponse {
        frozen: true,
        ..both()
    });
    assert!(!frozen.data().back_up_now_enabled);
    frozen.say(tap.clone());
    assert!(frozen.jobs.is_empty());

    let mut running = Page::open(wire::BackupStatusResponse {
        content_confirmed: 7,
        pending_bytes: 380_000_000,
        ..both()
    });
    running.say(tap.clone());
    // THE PASS IS THE CONDUCTOR'S: the screen asks it and runs no door of its own.
    assert!(running.jobs.is_empty());
    assert!(running.secrets.conductor().back_up_now_going());
    let data = running.data();
    assert!(!data.back_up_now_enabled);
    // BYTES TO GO, while bytes are to move (#1144).
    assert_eq!(data.progress, "Backing up — 380 MB to go");
    // NO BYTE TOTAL, NO BAR: the spinner stands in, never a bar stuck at zero.
    assert!(!data.progress_known);
    // A SECOND PRESS ASKS NOTHING MORE: the run is already going.
    running.say(tap.clone());
    assert!(running.jobs.is_empty());
    assert_eq!(
        running.service_takes_the_ask(),
        [wire::pass_asked::Ask::BackUpNow],
        "one ask for two presses"
    );
    // NOTHING LEFT TO MOVE is said plainly, never "0 bytes to go" while it runs.
    let mut whole = Page::open(both());
    whole.say(tap);
    assert_eq!(whole.data().progress, words::backup_now_running(EN));
}

#[test]
fn a_run_with_a_byte_total_draws_a_bar_of_what_a_gateway_has_acknowledged() {
    let tap = wire::backup_home_event::Kind::BackUpNow(wire::backup_home_event::BackUpNow {});
    let mut running = Page::open(wire::BackupStatusResponse {
        total_bytes: 5_000_000_000,
        confirmed_bytes: 4_600_000_000,
        pending_bytes: 412_000_000,
        ..both()
    });
    // NOT RUNNING: no bar, whatever the bytes say.
    let idle = running.data();
    assert!(!idle.progress_known && idle.progress_fraction == 0.0);
    running.say(tap.clone());
    let data = running.data();
    assert_eq!(data.progress, "Backing up — 412 MB to go");
    assert!(data.progress_known);
    assert!((data.progress_fraction - 0.92).abs() < 1e-6);

    // MORE ACKNOWLEDGED THAN COUNTED never overshoots the bar.
    let mut over = Page::open(wire::BackupStatusResponse {
        total_bytes: 1_000,
        confirmed_bytes: 2_000,
        ..both()
    });
    over.say(tap);
    assert_eq!(over.data().progress_fraction, 1.0);
}

#[test]
fn a_run_that_ends_is_re_read_because_what_it_moved_is_the_lines_to_say() {
    let mut page = Page::open(wire::BackupStatusResponse {
        content_confirmed: 7,
        ..both()
    });
    page.say(wire::backup_home_event::Kind::BackUpNow(
        wire::backup_home_event::BackUpNow {},
    ));
    assert!(
        page.timers
            .contains(&(super::home::PROGRESS_TIMER_NAME.to_owned(), true))
    );
    // THE SERVICE TAKES THE ASK and the run goes; the screen still draws it.
    assert_eq!(
        page.service_takes_the_ask(),
        [wire::pass_asked::Ask::BackUpNow]
    );
    assert!(!page.secrets.conductor().back_up_now_going());
    let reads = page.reads();
    page.set_status(both());
    // THE LEDGER MOVES when the run ends: the screen reads again and stops drawing a run.
    page.send(E::DataChanged(wire::DataChanged {
        tables: vec!["backup".to_owned()],
    }));
    assert_eq!(page.reads(), reads + 1);
    let data = page.data();
    assert_eq!(data.progress, "");
    assert_eq!(data.line.expect("line").detail, "All 10 photos and files");
    assert!(
        page.timers
            .contains(&(super::home::PROGRESS_TIMER_NAME.to_owned(), false))
    );
}

#[test]
fn a_run_that_is_going_is_re_read_as_it_goes_and_nothing_else_is() {
    let mut page = Page::open(both());
    // A TICK WITH NO RUN reads nothing and starts no timer.
    let reads = page.reads();
    let timers = page.timers.len();
    page.send(E::TimerFired(wire::TimerFired {
        timer: super::home::PROGRESS_TIMER_NAME.to_owned(),
    }));
    assert_eq!((page.reads(), page.timers.len()), (reads, timers));
    // A TICK WHILE ONE GOES reads once more and asks for the next.
    page.say(wire::backup_home_event::Kind::BackUpNow(
        wire::backup_home_event::BackUpNow {},
    ));
    let reads = page.reads();
    page.send(E::TimerFired(wire::TimerFired {
        timer: super::home::PROGRESS_TIMER_NAME.to_owned(),
    }));
    assert_eq!(page.reads(), reads + 1);
    assert_eq!(
        page.timers.last(),
        Some(&(super::home::PROGRESS_TIMER_NAME.to_owned(), true))
    );
    // ANOTHER TIMER is not this one.
    page.send(E::TimerFired(wire::TimerFired {
        timer: "other".to_owned(),
    }));
    assert_eq!(page.reads(), reads + 1);
}

#[test]
fn an_open_screen_re_reads_when_a_pass_it_did_not_start_moves_the_line() {
    // A VIDEO THE WALKER IMPORTED and a pass backed up while the screen stood
    // open: Home read "All 60" while this screen kept "All 59".
    let mut page = Page::open(wire::BackupStatusResponse {
        content_total: 59,
        content_confirmed: 59,
        ..both()
    });
    assert_eq!(
        page.data().line.expect("line").detail,
        "All 59 photos and files"
    );
    page.set_status(wire::BackupStatusResponse {
        content_total: 60,
        content_confirmed: 60,
        ..both()
    });
    let reads = page.reads();
    page.send(E::DataChanged(wire::DataChanged {
        tables: vec!["backup".to_owned()],
    }));
    assert_eq!(page.reads(), reads + 1);
    assert_eq!(
        page.data().line.expect("line").detail,
        "All 60 photos and files"
    );
}

#[test]
fn a_read_that_fails_is_a_failure_and_a_refresh_that_fails_keeps_what_was_read() {
    let page = Page::over(both());
    *page.fake.status.borrow_mut() = None;
    let mut page = page;
    page.send(E::Appeared(wire::Appeared {}));
    page.serve();
    let state = page.state();
    assert!(state.body.is_none());
    let Some(wire::page_state::State::Failed(failure)) = state.page.and_then(|page| page.state)
    else {
        panic!("a failed read is a failure");
    };
    assert!(!failure.sentence.is_empty() && !failure.remedy.is_empty());
    // Retry reads again.
    page.set_status(both());
    page.say(wire::backup_home_event::Kind::Retry(
        wire::backup_home_event::Retry {},
    ));
    page.serve();
    assert_eq!(page.data().destinations.len(), 2);
    // A refresh that fails keeps the last reading, under the one sentence.
    *page.fake.status.borrow_mut() = None;
    page.send(E::DataChanged(wire::DataChanged { tables: vec![] }));
    assert_eq!(page.data().destinations.len(), 2);
    let shown = page.state().page.expect("a page");
    assert!(shown.state.is_none(), "what was read stays");
    let note = shown.note.expect("a note over what is shown");
    assert_eq!(
        note.sentence,
        crate::strings::shared::read_refresh_failed(crate::strings::Locale::En)
    );
    // Reading again clears it.
    page.set_status(both());
    page.send(E::DataChanged(wire::DataChanged { tables: vec![] }));
    assert!(page.state().page.expect("a page").note.is_none());
}

#[test]
fn the_rule_and_the_videos_bit_are_written_as_the_member_set_them() {
    let mut page = Page::open(both());
    page.say(wire::backup_home_event::Kind::SetIncludeVideos(
        wire::backup_home_event::SetIncludeVideos { include: false },
    ));
    assert!(!page.data().include_videos);
    page.serve();
    // INCLUDED IS STORED AS ABSENCE, so the store holds a key only while the
    // member is spending less than the default.
    assert_eq!(
        page.shell
            .device
            .get(super::rule::INCLUDE_VIDEOS_KEY)
            .map(String::as_str),
        Some("excluded")
    );
    page.say(wire::backup_home_event::Kind::RuleChosen(
        wire::backup_home_event::RuleChosen {
            stored: "manual".to_owned(),
        },
    ));
    page.serve();
    assert_eq!(
        page.shell
            .device
            .get(super::rule::RULE_KEY)
            .map(String::as_str),
        Some("manual")
    );
    assert_eq!(
        page.data()
            .rule_choices
            .iter()
            .map(|choice| choice.picked)
            .collect::<Vec<_>>(),
        vec![false, false, true]
    );
    // AN UNKNOWN WORD IS THE DEFAULT, never a throw.
    page.say(wire::backup_home_event::Kind::RuleChosen(
        wire::backup_home_event::RuleChosen {
            stored: "everything".to_owned(),
        },
    ));
    assert!(page.data().rule_choices[0].picked);
}

#[test]
fn what_this_phone_kept_comes_back_when_the_screen_opens_again() {
    let mut page = Page::over(both());
    page.shell.device.insert(
        super::rule::INCLUDE_VIDEOS_KEY.to_owned(),
        "excluded".to_owned(),
    );
    page.shell
        .device
        .insert(super::rule::RULE_KEY.to_owned(), "manual".to_owned());
    page.send(E::Appeared(wire::Appeared {}));
    page.serve();
    let data = page.data();
    assert!(!data.include_videos);
    assert!(data.rule_choices[2].picked);
}

#[test]
fn forgetting_asks_nothing_reaches_only_a_gateway_the_screen_draws_and_says_whether_it_will_refuse_this_phone()
 {
    let forget = |id: &str| {
        wire::backup_home_event::Kind::ForgetDestination(
            wire::backup_home_event::ForgetDestination {
                gateway_id: id.to_owned(),
            },
        )
    };
    let asked = |page: &Page| page.jobs.clone();
    let mut page = Page::open(both());
    page.say(forget("gw-9"));
    assert!(asked(&page).is_empty());
    page.say(forget("gw-1"));
    assert_eq!(asked(&page), vec!["backup.forget:gw-1"]);
    let answer = |forgotten, revoked| {
        Some(wire::response::Kind::ForgetDestination(
            wire::ForgetDestinationResponse { forgotten, revoked },
        ))
    };
    page.set_status(status(vec![nas()]));
    let reads = page.reads();
    page.answer_job(answer(true, true));
    // RE-READ, and the gateway's refusal of this phone said.
    assert_eq!(page.reads(), reads + 1);
    assert_eq!(
        page.data().notice,
        "Forgot Home laptop. It now refuses this phone."
    );
    assert_eq!(page.data().destinations.len(), 1);

    // AN UNNAMED GATEWAY is "Your backup device", and NOT TOLD: the token stays
    // live there, so the member is told how to end it.
    let mut page = Page::open(both());
    page.say(forget("gw-2"));
    page.answer_job(answer(true, false));
    assert_eq!(
        page.data().notice,
        fill(
            &words::backup_forgotten_not_revoked(EN),
            &[("name", "Your backup device")]
        )
    );
    assert!(!words::backup_forgotten_not_revoked(EN).contains("centraid-gateway"));

    let mut page = Page::open(both());
    page.say(forget("gw-1"));
    page.answer_job(answer(false, false));
    assert_eq!(
        page.data().notice,
        "Couldn't forget Home laptop. Try again."
    );
    // No answer at all (no core, a refusal) is not forgotten.
    let mut page = Page::open(both());
    page.say(forget("gw-1"));
    page.answer_job(None);
    assert_eq!(
        page.data().notice,
        "Couldn't forget Home laptop. Try again."
    );
}

// ---- the recovery key ----------------------------------------------------

fn pair_of(page: &Page) -> (bool, String, bool, String, String, bool) {
    let data = page.data();
    (
        data.key_warning,
        data.key_line,
        data.key_synced,
        data.key_show_label,
        data.key_sync_label,
        !data.key_heading.is_empty(),
    )
}

#[test]
fn a_key_in_the_keychain_is_one_quiet_sentence_the_show_control_and_the_way_off_it() {
    let page = Page::open(both());
    let data = page.data();
    assert_eq!(data.key_heading, words::backup_key_heading(EN));
    assert_eq!(
        data.key_line,
        "Saved in iCloud Keychain. Sign in to iCloud on a new iPhone to restore your vaults."
    );
    assert!(!data.key_warning);
    assert_eq!(data.key_show_label, words::backup_key_show(EN));
    assert_eq!(data.key_show, Some(routes::show_key()));
    assert_eq!(data.key_sync_label, "Keep my key off iCloud Keychain");
    assert!(data.key_synced);
}

#[test]
fn a_key_on_this_phone_alone_is_a_warning_until_the_member_says_they_saved_a_copy() {
    let mut page = Page::over(both());
    page.shell.synced.remove(secrets::SEED_KEY);
    page.shell
        .device
        .insert(secrets::LOCAL_SEED.to_owned(), SEED.to_owned());
    page.send(E::Appeared(wire::Appeared {}));
    page.serve();
    let data = page.data();
    assert!(data.key_warning);
    assert_eq!(data.key_line, words::backup_key_phone_only(EN));
    assert_eq!(data.key_sync_label, "Save my key in iCloud Keychain");
    assert!(!data.key_synced);

    let mut saved = Page::over(both());
    saved.shell.synced.remove(secrets::SEED_KEY);
    saved
        .shell
        .device
        .insert(secrets::LOCAL_SEED.to_owned(), SEED.to_owned());
    saved
        .shell
        .device
        .insert(secrets::WORDS_SAVED.to_owned(), "1".to_owned());
    saved.send(E::Appeared(wire::Appeared {}));
    saved.serve();
    let data = saved.data();
    assert!(!data.key_warning);
    assert_eq!(data.key_line, words::backup_key_phone_only_saved(EN));

    // NO KEYCHAIN AT ALL: nothing to move it to, so no link.
    let mut none = Page::over(both());
    none.shell.synchronizing = false;
    none.shell.synced.remove(secrets::SEED_KEY);
    none.shell
        .device
        .insert(secrets::LOCAL_SEED.to_owned(), SEED.to_owned());
    none.send(E::Appeared(wire::Appeared {}));
    none.serve();
    assert_eq!(none.data().key_sync_label, "");

    // A KEY THAT CAME THROUGH THE KEYCHAIN has no words here to show.
    let mut through = Page::over(both());
    through.shell.device.remove(secrets::LOCAL_WORDS);
    through.send(E::Appeared(wire::Appeared {}));
    through.serve();
    let data = through.data();
    assert_eq!(data.key_show_label, "");
    assert_eq!(data.key_show, None);
}

#[test]
fn android_says_when_the_key_comes_back_and_what_a_member_who_skips_that_step_needs() {
    let mut page = Page::over(both());
    page.env.platform = "android".to_owned();
    page.send(E::Appeared(wire::Appeared {}));
    page.serve();
    let data = page.data();
    assert!(data.key_line.contains("while setting up a new one"));
    assert!(data.key_line.contains("you'll need your recovery key"));
    assert!(!data.key_line.contains("automatically"));
    assert_eq!(data.key_sync_label, "Keep my key off Google");
    // A member with iCloud Keychain switched off is on iOS and is in Android's place.
    let mut off = Page::over(both());
    off.shell.synchronizing = false;
    off.send(E::Appeared(wire::Appeared {}));
    off.serve();
    assert!(off.data().key_line.contains("only on this iPhone"));
}

#[test]
fn the_page_has_one_ink_button_and_the_screen_names_it() {
    use wire::BackupInk as I;
    let ink = |page: &Page| page.data().ink;
    let alone = |status: wire::BackupStatusResponse, words_here: bool| {
        let mut page = Page::over(status);
        page.shell.synced.remove(secrets::SEED_KEY);
        page.shell
            .device
            .insert(secrets::LOCAL_SEED.to_owned(), SEED.to_owned());
        if !words_here {
            page.shell.device.remove(secrets::LOCAL_WORDS);
        }
        page.send(E::Appeared(wire::Appeared {}));
        page.serve();
        page
    };
    // A KEY WARNING IS THE PAGE'S FIRST CONCERN, over adding a backup device and
    // over Back up now.
    assert_eq!(ink(&alone(status(Vec::new()), true)), I::ShowKey as i32);
    assert_eq!(ink(&alone(both(), true)), I::ShowKey as i32);
    // NO WORDS HERE, NO SHOW CONTROL: the warning has no button to promote.
    assert_eq!(ink(&alone(both(), false)), I::BackUpNow as i32);
    // WITHOUT A WARNING the page's act is adding a device, then Back up now.
    assert_eq!(
        ink(&Page::open(status(Vec::new()))),
        I::AddDestination as i32
    );
    assert_eq!(ink(&Page::open(both())), I::BackUpNow as i32);
    // A VAULT THAT MOVED AND PAIRS NO GATEWAY offers neither add nor Back up now.
    assert_eq!(
        ink(&Page::open(wire::BackupStatusResponse {
            frozen: true,
            ..status(Vec::new())
        })),
        I::None as i32
    );
    // A MOVED VAULT WITH A GATEWAY still draws Back up now, disabled, as the act.
    assert_eq!(
        ink(&Page::open(wire::BackupStatusResponse {
            frozen: true,
            ..both()
        })),
        I::BackUpNow as i32
    );
}

#[test]
fn a_phone_holding_no_key_draws_no_section_at_all() {
    let mut page = Page::over(both());
    page.shell.synced.clear();
    page.shell.device.remove(secrets::LOCAL_WORDS);
    page.send(E::Appeared(wire::Appeared {}));
    page.serve();
    let (warning, line, _, show, sync, heading) = pair_of(&page);
    assert!(!warning && !heading);
    assert_eq!((line.as_str(), show.as_str(), sync.as_str()), ("", "", ""));
}

#[test]
fn moving_the_key_asks_only_for_a_real_move_and_says_when_the_keychain_refused() {
    let set = |on: bool| {
        wire::backup_home_event::Kind::SetKeySync(wire::backup_home_event::SetKeySync { on })
    };
    // ALREADY THERE: nothing to do.
    let mut page = Page::open(both());
    page.say(set(true));
    assert!(page.effects.is_empty());
    // Off the keychain: the seed leaves the synchronised store and stays here.
    page.say(set(false));
    page.serve();
    assert!(!page.shell.synced.contains_key(secrets::SEED_KEY));
    assert_eq!(
        page.shell
            .device
            .get(secrets::LOCAL_SEED)
            .map(String::as_str),
        Some(SEED)
    );
    let data = page.data();
    assert!(!data.key_synced && data.notice.is_empty() && data.key_warning);
    assert_eq!(data.key_sync_label, "Save my key in iCloud Keychain");
    // And back in: the device copy goes, so there is one seed and not two.
    page.say(set(true));
    page.serve();
    assert_eq!(
        page.shell.synced.get(secrets::SEED_KEY).map(String::as_str),
        Some(SEED)
    );
    assert!(!page.shell.device.contains_key(secrets::LOCAL_SEED));
    assert!(page.data().key_synced);

    // A KEYCHAIN THAT REFUSES says so, and the key stays on this phone.
    let mut refusing = Page::open(both());
    refusing.say(set(false));
    refusing.serve();
    refusing.shell.synced_works = false;
    refusing.say(set(true));
    refusing.serve();
    let data = refusing.data();
    assert!(!data.key_synced);
    assert_eq!(data.notice, "Couldn't update iCloud Keychain. Try again.");
}

#[test]
fn a_foreground_return_reads_the_stores_again() {
    let mut page = Page::open(both());
    assert!(page.data().key_synced);
    // The keychain was turned off elsewhere meanwhile.
    page.shell.synced.remove(secrets::SEED_KEY);
    page.shell
        .device
        .insert(secrets::LOCAL_SEED.to_owned(), SEED.to_owned());
    page.send(E::Lifecycle(wire::AppLifecycle { foreground: true }));
    page.serve();
    assert!(!page.data().key_synced);
    // Going to the background reads nothing.
    let reads = page.reads();
    page.send(E::Lifecycle(wire::AppLifecycle { foreground: false }));
    assert_eq!(page.reads(), reads);
    assert!(page.effects.is_empty());
}

#[test]
fn nothing_the_screen_says_carries_the_words_themselves() {
    let page = Page::open(both());
    let encoded = page.data().encode_to_vec();
    let text = String::from_utf8_lossy(&encoded);
    assert!(!text.contains("abandon"));
    assert!(!text.contains(SEED));
}

// ---- a gateway that moved -------------------------------------------------

/// A reading in which the laptop's items wait for a backup device that does not answer.
fn lost() -> wire::BackupStatusResponse {
    wire::BackupStatusResponse {
        content_confirmed: 4,
        waiting: waiting(&[(wire::WaitReason::Gateway, 6)]),
        ..both()
    }
}

/// The `BrowseGateways` effects among `effects`, in order, as their `on`.
fn browses(effects: &[wire::Effect]) -> Vec<bool> {
    effects
        .iter()
        .filter_map(|effect| match &effect.kind {
            Some(wire::effect::Kind::BrowseGateways(browse)) => Some(browse.on),
            _ => None,
        })
        .collect()
}

fn sighted(gw: &str, addresses: &[&str]) -> E {
    E::EffectResult(wire::EffectResult {
        effect_id: 0,
        outcome: Some(wire::effect_result::Outcome::GatewaysSighted(
            wire::GatewaysSighted {
                sightings: vec![wire::GatewaySighting {
                    service_name: "centraid-gateway".to_owned(),
                    txt: [("gw".to_owned(), gw.to_owned())].into(),
                    addresses: addresses.iter().map(|a| (*a).to_owned()).collect(),
                }],
            },
        )),
    })
}

fn kept(refreshed: bool) -> Option<wire::response::Kind> {
    Some(wire::response::Kind::RefreshDestination(
        wire::RefreshDestinationResponse {
            refreshed,
            ..Default::default()
        },
    ))
}

#[test]
fn a_gateway_the_core_cannot_reach_is_browsed_for_and_one_that_answers_is_not() {
    // ITEMS WAIT FOR A BACKUP DEVICE that does not answer: the browse begins with the page.
    let page = Page::open(lost());
    assert_eq!(browses(&page.effects), [true]);
    // A gateway that answers, a vault with none paired and a vault that moved are not browsed for.
    for status in [
        both(),
        status(Vec::new()),
        wire::BackupStatusResponse {
            frozen: true,
            ..lost()
        },
    ] {
        assert!(browses(&Page::open(status).effects).is_empty());
    }
}

#[test]
fn rediscovery_matches_by_identity_asks_the_core_and_stops_on_a_kept_address() {
    let mut paired = lost();
    paired.destinations[0].gateway_id = "a1b2c3d4".to_owned();
    let mut page = Page::open(paired.clone());
    assert_eq!(browses(&page.effects), [true]);
    page.effects.clear();
    // A gateway of another identity, at an address: nothing is offered.
    page.send(sighted("ffffffff", &["192.168.1.99:7443"]));
    assert!(page.jobs.is_empty());
    // The paired one, by its id, at a new address (the recorded one is not offered again).
    page.send(sighted(
        "A1B2C3D4",
        &["192.168.1.20:7443", "192.168.1.77:7443"],
    ));
    assert_eq!(page.jobs, ["refresh:a1b2c3d4"]);
    // THE CORE REFUSED the address (nothing answered as that gateway): the browse goes on.
    page.answer_job(kept(false));
    assert!(browses(&page.effects).is_empty());
    // A later window finds it and the core keeps the address: the browse ends, once.
    page.send(sighted("a1b2c3d4", &["192.168.1.78:7443"]));
    assert_eq!(page.jobs, ["refresh:a1b2c3d4"]);
    page.answer_job(kept(true));
    assert_eq!(browses(&page.effects), [false]);
    // IT IS NOT BROWSED FOR AGAIN while the page stays open, though the pass has not reached it yet.
    page.effects.clear();
    page.send(E::DataChanged(wire::DataChanged {
        tables: vec!["backup".to_owned()],
    }));
    assert!(browses(&page.effects).is_empty());
    // A page opened anew looks again.
    page.send(E::Lifecycle(wire::AppLifecycle { foreground: true }));
    assert_eq!(browses(&page.effects), [true]);
}

#[test]
fn a_browse_ends_when_the_gateway_answers_the_app_leaves_the_front_or_the_page_is_left() {
    // THE PASS REACHED IT: the next read has nothing waiting for a gateway, and the browse ends.
    let mut page = Page::open(lost());
    page.effects.clear();
    page.set_status(both());
    page.send(E::DataChanged(wire::DataChanged {
        tables: vec!["backup".to_owned()],
    }));
    assert_eq!(browses(&page.effects), [false]);

    // THE APP LEAVES THE FRONT: a browse is foreground work, and comes back with the front.
    let mut page = Page::open(lost());
    page.effects.clear();
    page.send(E::Lifecycle(wire::AppLifecycle { foreground: false }));
    assert_eq!(browses(&page.effects), [false]);
    page.effects.clear();
    page.send(E::DataChanged(wire::DataChanged { tables: vec![] }));
    assert!(
        browses(&page.effects).is_empty(),
        "nothing browses in the background"
    );
    page.send(E::Lifecycle(wire::AppLifecycle { foreground: true }));
    assert_eq!(browses(&page.effects), [true]);

    // THE PAGE IS LEFT.
    let mut page = Page::open(lost());
    page.effects.clear();
    page.send(E::Left(wire::Left {}));
    assert_eq!(browses(&page.effects), [false]);
}

// ---- what the doors are asked ---------------------------------------------

#[test]
fn a_forget_names_the_gateway_and_its_answer_finds_it_by_tag() {
    use centraid_core::screens::VaultRequest;
    let VaultRequest::ForgetDestination(forget) = doors::forget_request("gw-7") else {
        panic!("a forget");
    };
    assert_eq!(forget.gateway_id, "gw-7");
    assert_eq!(doors::forget_tag("gw-7"), "backup.forget:gw-7");
    // A tag this screen did not ask is not its answer.
    assert_eq!(doors::done("other", &[]), None);
    // A refusal, or bytes that are not an answer, are not forgotten.
    let refused = wire::VaultCalled {
        response: Vec::new(),
        error: Some(centraid_api_proto::core_v1::Error::default()),
    };
    assert_eq!(
        doors::done("backup.forget:gw-7", &refused.encode_to_vec()),
        Some(doors::Done::Forgot {
            gateway_id: "gw-7".to_owned(),
            forgotten: false,
            revoked: false
        })
    );
    assert_eq!(
        doors::done("backup.forget:gw-7", b"\xff\xff"),
        Some(doors::Done::Forgot {
            gateway_id: "gw-7".to_owned(),
            forgotten: false,
            revoked: false
        })
    );
}

#[test]
fn a_shell_that_cannot_give_the_phones_settings_gives_the_defaults_and_the_page_still_opens() {
    let mut page = Page::over(both());
    page.send(E::Appeared(wire::Appeared {}));
    let at = page
        .effects
        .iter()
        .position(|effect| matches!(effect.kind, Some(wire::effect::Kind::Secrets(_))))
        .expect("the stores are asked for");
    page.effects.remove(at);
    page.send(E::EffectResult(wire::EffectResult {
        effect_id: 0,
        outcome: Some(wire::effect_result::Outcome::Failed(
            wire::EffectFailed::default(),
        )),
    }));
    let data = page.data();
    // THE CONSERVATIVE DEFAULTS: Wi-Fi only, videos included, and no key section
    // for a key nobody could read.
    assert!(data.rule_choices[0].picked);
    assert!(data.include_videos);
    assert_eq!(data.key_heading, "");
}

#[test]
fn the_screens_two_hand_offs_are_routes_the_shell_pushes() {
    assert_eq!(routes::home().screen, "backup.home");
    assert!(matches!(
        routes::home().args,
        Some(wire::route::Args::BackupHome(_))
    ));
    assert_eq!(routes::add_destination().screen, "pair.laptop");
    assert_eq!(routes::show_key().screen, "words.show");
}

// ---- every app's data, in bytes (#1144) ----------------------------------

const GB: u64 = 1_000_000_000;
const MB: u64 = 1_000_000;

fn holding(app: &str, items: u64, bytes: u64) -> wire::AppHolding {
    wire::AppHolding {
        app_id: app.to_owned(),
        items,
        items_confirmed: items,
        bytes,
        bytes_confirmed: bytes,
        ..Default::default()
    }
}

/// The design's backed-up phone: eight apps, 5.0 GB, all of it acknowledged.
fn eight_apps() -> Vec<wire::AppHolding> {
    vec![
        holding("calendar", 640, 6 * MB),
        holding("docs", 58, 412 * MB),
        wire::AppHolding {
            workouts: 96,
            ..holding("health", 731, 3 * MB)
        },
        holding("locker", 86, 96 * MB),
        holding("money", 3_412, 21 * MB),
        holding("notes", 312, 38 * MB),
        holding("people", 418, 14 * MB),
        holding("photos", 1_240, 4_410 * MB),
    ]
}

fn with_apps(apps: Vec<wire::AppHolding>) -> wire::BackupStatusResponse {
    let total_bytes = apps.iter().map(|app| app.bytes).sum();
    let confirmed_bytes = apps.iter().map(|app| app.bytes_confirmed).sum();
    wire::BackupStatusResponse {
        destinations: vec![wire::Destination {
            held_bytes: 5_100 * MB,
            ..home_laptop()
        }],
        apps,
        total_bytes,
        confirmed_bytes,
        ..status(Vec::new())
    }
}

#[test]
fn the_line_totals_every_app_in_bytes() {
    let backed = Page::open(with_apps(eight_apps())).data();
    let line = backed.line.expect("a line");
    assert_eq!(line.detail, "All 5.0 GB from 8 apps is backed up.");
    assert!(line.accessibility_label.contains("All 5.0 GB from 8 apps"));

    // CATCHING UP says how far, in one unit.
    let mut apps = eight_apps();
    apps[7].bytes_confirmed = 4_010 * MB;
    apps[7].items_confirmed = 1_203;
    apps[7].waiting = 37;
    let catching = Page::open(with_apps(apps)).data();
    assert_eq!(
        catching.line.expect("a line").detail,
        "4.6 of 5.0 GB from 8 apps is backed up."
    );

    // VIDEOS LEFT OUT are said apart, never read as missing.
    let mut apps = eight_apps();
    apps[7] = wire::AppHolding {
        left_out_items: 37,
        left_out_bytes: 8_400 * MB,
        ..holding("photos", 1_203, 4_000 * MB)
    };
    let left = Page::open(wire::BackupStatusResponse {
        left_out_items: 37,
        left_out_bytes: 8_400 * MB,
        ..with_apps(apps)
    })
    .data();
    assert_eq!(
        left.line.expect("a line").detail,
        "All 4.5 GB from 8 apps is backed up. 8.4 GB of videos is left out."
    );

    // NOTHING ACKNOWLEDGED YET says so, with what there is.
    let mut apps = eight_apps();
    for app in &mut apps {
        app.bytes_confirmed = 0;
    }
    let none = Page::open(wire::BackupStatusResponse {
        destinations: Vec::new(),
        ..with_apps(apps)
    })
    .data();
    assert_eq!(
        none.line.expect("a line").detail,
        "5.0 GB from 8 apps, none of it backed up yet."
    );

    // A READING WITH NO PER-APP ROWS keeps the counts.
    let bare = Page::open(both()).data();
    assert_eq!(bare.line.expect("a line").detail, "All 10 photos and files");
    assert!(bare.apps.is_empty() && bare.apps_heading.is_empty());
}

#[test]
fn in_this_backup_lists_every_app_biggest_first_with_what_it_holds() {
    let data = Page::open(with_apps(eight_apps())).data();
    assert_eq!(data.apps_heading, "In this backup");
    let drawn: Vec<(&str, &str, &str)> = data
        .apps
        .iter()
        .map(|row| (row.name.as_str(), row.detail.as_str(), row.status.as_str()))
        .collect();
    assert_eq!(
        drawn,
        [
            ("Photos", "1,240 photos and videos · 4.4 GB", "Backed up"),
            ("Docs", "58 documents · 412 MB", "Backed up"),
            ("Locker", "86 items · 96.0 MB", "Backed up"),
            ("Notes", "312 notes · 38.0 MB", "Backed up"),
            ("Money", "3,412 transactions · 21.0 MB", "Backed up"),
            ("People", "418 people · 14.0 MB", "Backed up"),
            ("Calendar", "640 events · 6.0 MB", "Backed up"),
            ("Health", "731 days, 96 workouts · 3.0 MB", "Backed up"),
        ]
    );
    assert!(
        data.apps
            .iter()
            .all(|row| !row.waiting && row.note.is_empty())
    );
    assert_eq!(
        data.apps[3].accessibility_label,
        "Notes. 312 notes · 38.0 MB. Backed up"
    );
    assert_eq!(data.apps[0].app_id, "photos");
    // EACH BACKUP DEVICE SAYS WHAT IT HOLDS.
    assert_eq!(
        data.destinations[0].held,
        "Up to date \u{b7} Holds 5.1 GB \u{b7} can't open it"
    );
    assert!(
        data.destinations[0]
            .accessibility_label
            .contains("Holds 5.1 GB \u{b7} can't open it")
    );
}

#[test]
fn a_row_says_what_waits_and_never_more_than_was_acknowledged() {
    let mut apps = eight_apps();
    apps[7] = wire::AppHolding {
        items_confirmed: 1_203,
        bytes_confirmed: 4_000 * MB,
        waiting: 37,
        ..holding("photos", 1_240, 4_400 * MB)
    };
    apps[1] = wire::AppHolding {
        items_confirmed: 56,
        bytes_confirmed: 400 * MB,
        waiting: 2,
        ..holding("docs", 58, 412 * MB)
    };
    apps[5].edits_waiting = 3;
    apps[0].edits_waiting = 1;
    let data = Page::open(with_apps(apps)).data();
    let row = |id: &str| {
        data.apps
            .iter()
            .find(|row| row.app_id == id)
            .expect("a row")
            .clone()
    };
    let photos = row("photos");
    assert_eq!(
        photos.detail,
        "1,203 of 1,240 photos and videos · 4.0 of 4.4 GB"
    );
    assert_eq!(
        (photos.status.as_str(), photos.waiting),
        ("37 waiting", true)
    );
    assert_eq!(row("docs").detail, "56 of 58 documents · 400 of 412 MB");
    let notes = row("notes");
    assert_eq!(
        (notes.status.as_str(), notes.waiting),
        ("3 edits waiting", true)
    );
    assert_eq!(row("calendar").status, "1 edit waiting");
    assert_eq!(row("money").status, "Backed up");

    // NEVER ACKNOWLEDGED: no row says "Backed up".
    let never = Page::open(wire::BackupStatusResponse {
        acked_at_ms: None,
        ..with_apps(eight_apps())
    })
    .data();
    assert!(
        never
            .apps
            .iter()
            .all(|row| row.status == "Not backed up" && row.waiting)
    );
}

#[test]
fn videos_left_out_are_the_photos_rows_note() {
    let mut apps = eight_apps();
    apps[7] = wire::AppHolding {
        left_out_items: 37,
        left_out_bytes: 8_400 * MB,
        ..holding("photos", 1_203, 4 * GB)
    };
    let data = Page::open(with_apps(apps)).data();
    let photos = &data.apps[0];
    assert_eq!(photos.detail, "1,203 photos · 4.0 GB");
    assert_eq!(photos.note, "37 videos, 8.4 GB, left out");
    assert_eq!(photos.status, "Backed up");
    assert_eq!(
        photos.accessibility_label,
        "Photos. 1,203 photos · 4.0 GB. 37 videos, 8.4 GB, left out. Backed up"
    );
}

// ---- THE SETTINGS-STYLE PAGE (#1173) ----

fn condition_of(status: wire::BackupStatusResponse) -> wire::BackupCondition {
    Page::open(status).data().condition()
}

#[test]
fn the_page_names_where_the_backup_stands_in_one_condition() {
    use wire::BackupCondition as C;
    assert_eq!(condition_of(both()), C::UpToDate);
    assert_eq!(condition_of(status(Vec::new())), C::Unpaired);
    assert_eq!(
        condition_of(wire::BackupStatusResponse {
            frozen: true,
            ..both()
        }),
        C::Moved
    );
    // A run that is going.
    let mut running = Page::open(both());
    running.say(wire::backup_home_event::Kind::BackUpNow(
        wire::backup_home_event::BackUpNow {},
    ));
    assert_eq!(running.data().condition(), C::Running);
    // Unreached is the line's own predicate: exactly STALE_MS ago still answers, one
    // millisecond more does not, and never having answered does not either.
    let seen = |at: i64| {
        let mut unreached = both();
        unreached.destinations[0].last_seen_ms = at;
        condition_of(unreached)
    };
    assert_eq!(seen(NOW - STALE_MS), C::UpToDate);
    assert_eq!(seen(NOW - STALE_MS - 1), C::NotReached);
    assert_eq!(seen(0), C::NotReached);
}

#[test]
fn a_backup_device_that_has_not_answered_says_when_it_last_did_and_what_to_check() {
    let mut unreached = with_apps(eight_apps());
    unreached.destinations = vec![gateway(
        "gw-1",
        "Srikanth's Mac mini",
        Some("192.168.1.20:7443"),
        NOW - 5 * DAY,
        NOW - 5 * DAY,
    )];
    unreached.acked_at_ms = Some(NOW - 5 * DAY);
    unreached.apps[7].waiting = 184;
    unreached.apps[1].waiting = 28;
    let data = Page::open(unreached).data();
    assert_eq!(data.condition(), wire::BackupCondition::NotReached);
    assert_eq!(data.last_good, "Last good backup 5 days ago");
    assert_eq!(
        data.reason,
        "Srikanth's Mac mini hasn't answered. Check it's awake and on the same network as this phone."
    );
    // What waits is its own list, and "In this backup" is what the device holds.
    assert_eq!(data.waiting_heading, "Not backed up yet");
    let waiting: Vec<&str> = data.apps_waiting.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(waiting, ["Photos", "Docs"]);
    assert!(data.apps_waiting.iter().all(|row| row.waiting));
    assert_eq!(data.apps.len(), 6);
    assert!(data.apps.iter().all(|row| !row.waiting));
    // A healthy page carries none of it.
    let calm = Page::open(with_apps(eight_apps())).data();
    assert_eq!(
        (
            calm.last_good.as_str(),
            calm.reason.as_str(),
            calm.waiting_heading.as_str()
        ),
        ("", "", "")
    );
    assert!(calm.apps_waiting.is_empty());
}

#[test]
fn what_travels_when_has_one_row_worth_the_rules_short_word_and_the_sentences_behind_it() {
    let mut page = Page::open(both());
    let data = page.data();
    assert_eq!(data.travel_heading, "What travels when");
    assert_eq!(data.over_label, "Back up over");
    assert_eq!(data.over_value, "Wi-Fi only");
    // The three short words are the rule's, one for each sentence a member can pick.
    let shorts: Vec<String> = TransferRule::ALL.iter().map(|r| r.short(EN)).collect();
    assert_eq!(shorts, ["Wi-Fi only", "Wi-Fi and cellular", "On tap"]);
    // Choosing moves the value, and what is picked is the one sentence.
    page.say(wire::backup_home_event::Kind::RuleChosen(
        wire::backup_home_event::RuleChosen {
            stored: "wifi-and-cellular-photos".into(),
        },
    ));
    let data = page.data();
    assert_eq!(data.over_value, "Wi-Fi and cellular");
    assert_eq!(data.rule_choices.iter().filter(|c| c.picked).count(), 1);
}

#[test]
fn recovery_has_a_summary_and_a_restore_row_and_a_moved_vault_has_no_restore() {
    let data = Page::open(both()).data();
    assert_eq!(data.restore_label, "Restore my vaults");
    assert_eq!(data.key_summary, "Saved in iCloud Keychain");
    let moved = Page::open(wire::BackupStatusResponse {
        frozen: true,
        ..both()
    })
    .data();
    assert_eq!(moved.restore_label, "");
}

// ---------------------------------------------------------------------------
// Check my backup (#1188, B6): the page says what the core found, in the approved words.
// ---------------------------------------------------------------------------

mod check_my_backup {
    use wire::device_check::{NotRun, Verdict};

    use super::*;

    /// Tuesday 10 November 2026, 21:40 UTC.
    const TUESDAY: i64 = 1_794_346_800_000;
    /// Sunday 8 November 2026, 21:40 UTC.
    const SUNDAY: i64 = TUESDAY - 2 * 86_400_000;

    fn device(label: &str, verdict: Verdict) -> wire::DeviceCheck {
        wire::DeviceCheck {
            gateway_id: format!("id-{label}"),
            label: label.to_owned(),
            verdict: verdict as i32,
            snapshot_ms: TUESDAY,
            ..Default::default()
        }
    }

    fn drawn(page: &Check) -> wire::BackupCheckState {
        let shell = Page::over(steady());
        let ctx = Ctx::new(&shell.fake, &shell.env);
        page.drawn(&ctx)
    }

    #[test]
    fn a_backup_that_opens_says_when_and_how_much_was_read() {
        let mut opens = device("Mac mini", Verdict::Opens);
        opens.files_held = 91_204;
        opens.files_opened = 40;
        let state = drawn(&Check::resting(true, Some((vec![opens], Check::now_ms()))));
        assert_eq!(state.rows[0].line, "Tuesday 10 November, 21:40 opens.");
        assert_eq!(
            state.rows[0].detail,
            "91,204 files held, 40 opened to check."
        );
        assert_eq!(state.rows[0].tone, wire::BackupCheckTone::Ok as i32);
        assert_eq!(state.status.unwrap().sentence, "Checked just now");
        assert_eq!(state.action, wire::BackupCheckAction::Check as i32);
        assert_eq!(state.action_label, "Check again");
        assert!(state.back_up_now_label.is_empty(), "nothing to send again");
    }

    #[test]
    fn a_failure_is_a_failure_and_offers_a_pass() {
        let mut wont = device("Office NAS", Verdict::WontOpen);
        wont.older_snapshot_ms = SUNDAY;
        let mut missing = device("Garage drive", Verdict::MissingFiles);
        missing.files_missing = 3;
        let damaged = device("Parents' NAS", Verdict::DamagedFile);
        let state = drawn(&Check::resting(
            true,
            Some((vec![wont, missing, damaged], NOW)),
        ));
        let lines: Vec<&str> = state.rows.iter().map(|r| r.line.as_str()).collect();
        assert_eq!(
            lines,
            [
                "Tuesday 10 November, 21:40 won't open.",
                "Tuesday 10 November, 21:40 is missing 3 files.",
                "Tuesday 10 November, 21:40 has a damaged file.",
            ]
        );
        assert_eq!(
            state.rows[0].detail,
            "Its backup from Sunday 8 November, 21:40 opens."
        );
        assert!(
            state
                .rows
                .iter()
                .all(|r| r.tone == wire::BackupCheckTone::Bad as i32)
        );
        assert_eq!(state.back_up_now_label, "Back up now");
    }

    #[test]
    fn a_device_that_was_not_checked_is_never_drawn_as_a_pass() {
        let reasons = [
            (NotRun::DidNotAnswer, "It didn't answer."),
            (NotRun::WaitingForWifi, "Waiting for Wi-Fi."),
            (NotRun::NeedsSpace, "This phone needs more free space."),
            (NotRun::Stopped, "It was stopped before it finished."),
        ];
        let devices: Vec<wire::DeviceCheck> = reasons
            .iter()
            .map(|(why, _)| {
                let mut d = device("Device", Verdict::NotRun);
                d.not_run = *why as i32;
                d
            })
            .collect();
        let state = drawn(&Check::resting(true, Some((devices, Check::now_ms()))));
        for (row, (_, said)) in state.rows.iter().zip(reasons) {
            assert_eq!(row.line, "Not checked.");
            assert_eq!(row.detail, said);
            assert_eq!(row.tone, wire::BackupCheckTone::NotRun as i32);
        }
        assert_eq!(state.status.unwrap().sentence, "Nothing was checked.");
        assert!(state.back_up_now_label.is_empty());
    }

    #[test]
    fn a_running_check_draws_a_determinate_bar_and_names_the_device() {
        let state = drawn(&Check::running(wire::CheckProgress {
            running: true,
            gateway_id: "id".to_owned(),
            label: "Office NAS".to_owned(),
            done: 112,
            total: 260,
        }));
        assert!(state.running);
        assert!((state.fraction - 112.0 / 260.0).abs() < 1e-6);
        assert_eq!(state.rows[0].detail, "112 of 260 parts");
        assert_eq!(state.status.unwrap().sentence, "Checking Office NAS");
        assert_eq!(state.action, wire::BackupCheckAction::Stop as i32);
        assert_eq!(state.heading, "Checking");
    }

    #[test]
    fn nothing_paired_offers_no_check() {
        let state = drawn(&Check::resting(false, None));
        assert_eq!(state.action, wire::BackupCheckAction::None as i32);
        assert_eq!(
            state.status.unwrap().sentence,
            "No backup device is paired."
        );
        assert_eq!(
            state.intro,
            "Opens each backup in a spare copy and reads a sample of its files. Your vault isn't touched."
        );
    }
}

// ---------------------------------------------------------------------------
// One backup device behind, full, or holding an older backup (#1188, NB1, B4): the card names
// it by the name the member gave it, and "backed up" is never said while a device owes anything.
// ---------------------------------------------------------------------------

mod one_device_behind {
    use super::*;

    fn office(change: impl FnOnce(&mut wire::Destination)) -> wire::BackupStatusResponse {
        let mut behind = gateway(
            "gw-2",
            "Office NAS",
            Some("192.168.1.30:7443"),
            NOW - 2 * 86_400_000,
            NOW - 2 * 86_400_000,
        );
        behind.held_bytes = 4_700 * MB;
        change(&mut behind);
        wire::BackupStatusResponse {
            destinations: vec![
                wire::Destination {
                    held_bytes: 5_100 * MB,
                    ..home_laptop()
                },
                behind,
            ],
            ..status(Vec::new())
        }
    }

    #[test]
    fn every_device_current_says_backed_up() {
        let data = Page::open(office(|_| {})).data();
        let line = data.line.expect("a line");
        assert_eq!(line.status, "Backed up 2 minutes ago");
        assert!(data.reason.is_empty());
    }

    /// **"UP TO DATE" IS SAID ONLY OF A DEVICE NOTHING WAITS FOR** (#1188, NB1): a phone too full to
    /// copy its vault leaves every device that lacks something with its count behind, state first,
    /// and no row reads "Up to date" while it does.
    #[test]
    fn no_room_with_items_waiting_never_yields_up_to_date_on_a_row_that_waits() {
        for lagging in [212_u64, 0] {
            let mut status = office(|d| {
                d.behind_files = lagging;
                d.records_behind = lagging == 0;
            });
            status.waiting = waiting(&[(wire::WaitReason::NoRoom, 212)]);
            let data = Page::open(status).data();
            let behind = &data.destinations[1].held;
            assert!(!behind.starts_with("Up to date"), "{behind}");
            if lagging > 0 {
                assert!(
                    behind.starts_with("212 files behind \u{b7} Holds"),
                    "{behind}"
                );
            } else {
                assert!(behind.starts_with("Catching up"), "{behind}");
            }
        }
    }

    #[test]
    fn a_silent_device_is_named_with_the_day_it_last_answered() {
        let data = Page::open(office(|d| {
            d.behind_files = 184;
            d.reach = wire::WaitReason::Gateway as i32;
            d.waiting_apps = vec![wire::DeviceWaiting {
                app_id: "photos".to_owned(),
                files: 184,
            }];
        }))
        .data();
        let line = data.line.expect("a line");
        assert_eq!(line.status, "Office NAS is behind");
        assert_eq!(line.sentence, "Office NAS is behind");
        assert_eq!(data.last_good, "Backed up to Home laptop just now");
        assert_eq!(line.tone, Tone::Attention as i32);
        assert!(
            data.reason.starts_with("Office NAS hasn't answered since "),
            "{}",
            data.reason
        );
        assert!(
            data.reason
                .ends_with("Check it's awake and on the same network as this phone.")
        );
        let row = &data.destinations[1];
        assert!(row.held.starts_with("184 files behind"), "{}", row.held);
        assert_eq!(data.apps_waiting.len(), 1, "{:?}", data.apps_waiting);
        assert_eq!(data.apps_waiting[0].status, "184 waiting for Office NAS");
        assert_eq!(data.waiting_heading, "Not backed up yet");
        assert!(
            data.destinations[0].held.starts_with("Up to date"),
            "{}",
            data.destinations[0].held
        );
    }

    #[test]
    fn a_full_device_says_so_in_its_card_and_its_row() {
        let data = Page::open(office(|d| {
            d.behind_files = 184;
            d.reach = wire::WaitReason::Refused as i32;
        }))
        .data();
        assert_eq!(data.line.expect("a line").status, "Office NAS is full");
        assert_eq!(
            data.reason,
            "Office NAS has no room left. Free some space on it, then back up again."
        );
        assert_eq!(
            data.destinations[1].held.split(" \u{b7} ").next(),
            Some("Full")
        );
    }

    #[test]
    fn a_device_holding_an_older_backup_is_a_plain_warning() {
        let data = Page::open(office(|d| d.rolled_back = true)).data();
        assert_eq!(
            data.line.expect("a line").status,
            "Office NAS has an older backup"
        );
        assert_eq!(
            data.reason,
            "It holds an older backup than this phone sent. Back up now to bring it up to date."
        );
        assert_eq!(
            data.destinations[1].held.split(" \u{b7} ").next(),
            Some("Older backup than this phone sent")
        );
    }
}

// ---------------------------------------------------------------------------
// The one-time recovery-key prompt after the first confirmed backup (#1188, NB5).
// ---------------------------------------------------------------------------

mod recovery_key_prompt {
    use super::*;

    fn key_only_here(status: wire::BackupStatusResponse) -> Page {
        let mut page = Page::over(status);
        page.shell.synced.clear();
        page.send(E::Appeared(wire::Appeared {}));
        page.serve();
        page
    }

    #[test]
    fn it_is_asked_once_after_the_first_confirmed_backup_and_never_again() {
        let mut page = key_only_here(steady());
        let prompt = page.data().key_prompt.expect("the prompt is due");
        assert_eq!(prompt.title, "Save your recovery key");
        assert_eq!(
            prompt.body,
            "Your first backup is done. Without the recovery key it can't be opened on a new phone."
        );
        assert_eq!(
            (prompt.save_label.as_str(), prompt.not_now_label.as_str()),
            ("Save recovery key", "Not now")
        );
        assert_eq!(prompt.save, Some(routes::show_key()));
        assert!(!prompt.body.to_lowercase().contains("words"));

        page.say(wire::backup_home_event::Kind::KeyPromptAnswered(
            wire::backup_home_event::KeyPromptAnswered {},
        ));
        page.serve();
        assert!(page.data().key_prompt.is_none());
        assert!(
            page.shell.device.contains_key(rule_key_prompt()),
            "remembered on this phone"
        );
        // A LATER OPEN READS IT BACK.
        page.send(E::Appeared(wire::Appeared {}));
        page.serve();
        assert!(page.data().key_prompt.is_none());
    }

    #[test]
    fn it_waits_for_a_confirmed_backup() {
        let mut never = steady();
        never.acked_at_ms = None;
        assert!(key_only_here(never).data().key_prompt.is_none());
    }

    #[test]
    fn it_is_not_asked_when_the_key_is_already_saved_somewhere() {
        let page = Page::open(steady());
        // The fake's key is in the synced store: nothing to ask.
        assert!(page.data().key_prompt.is_none());
    }

    fn rule_key_prompt() -> &'static str {
        super::super::rule::KEY_PROMPT_KEY
    }
}
