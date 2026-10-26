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

use super::line::{self, STALE_MS};
use super::reading::Reading;
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
}

/// A Backup screen over a scripted core and a shell with two stores.
struct Page {
    fake: Fake,
    env: Environment,
    screen: Box<dyn Screen>,
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
            screen: home::build(&routes::home(), &VaultSecrets::new()).expect("the screen builds"),
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
    assert_eq!(line.records_as_of_ms, 0);
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
fn every_gateway_refusing_this_phones_token_reads_pair_again_never_all_backed_up() {
    // THE LEDGER STILL SAYS EVERYTHING IS ACKNOWLEDGED: nothing waits, so no row
    // can say otherwise; the mark on the gateway does.
    let mut refused = steady();
    refused.destinations[0].pair_again = true;
    let line = lined(&refused, false);
    assert!(line.pair_again);
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
    assert!(!line.pair_again);
    assert_eq!(line.sentence, "Backed up 2 minutes ago.");
    assert_eq!(line.tone, Tone::Attention as i32);

    // A MOVED VAULT STILL SAYS SO ABOVE EVERYTHING.
    assert!(lined(&refused, true).frozen);
}

#[test]
fn everything_acknowledged_is_backed_up_quietly_at_the_gateways_time() {
    let line = lined(&steady(), false);
    assert_eq!(line.sentence, "Backed up 2 minutes ago.");
    assert_eq!(line.detail, "All 1,240 photos and files");
    assert_eq!(line.records_as_of_ms, NOW - 2 * MINUTE);
    assert_eq!((line.confirmed, line.total), (1_240, 1_240));
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
    assert!(line.unpaired);
    assert_eq!(line.sentence, words::backup_line_unpaired(EN));
    assert_eq!(line.tone, Tone::Attention as i32);
}

#[test]
fn a_moved_vault_says_so_above_everything_else() {
    let line = lined(&steady(), true);
    assert!(line.frozen);
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
    assert_eq!(say(S::Deadline, 2_000_000), "Still backing up. 2 MB to go.");
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
fn bytes_are_decimal_whole_units() {
    assert_eq!(claim::bytes(999), "999 bytes");
    assert_eq!(claim::bytes(12_345), "12 KB");
    assert_eq!(claim::bytes(340_000_000), "340 MB");
    assert_eq!(claim::bytes(2_999_999_999), "2 GB");
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
        page.state().body,
        Some(wire::backup_home_state::Body::Loading(_))
    ));
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
        "Home laptop. 192.168.1.20:7443 · Reached 2 minutes ago"
    );
    assert_eq!(data.devices_heading, words::backup_devices_heading(EN));
    assert_eq!(
        data.add_destination_label,
        words::backup_add_destination(EN)
    );
    assert_eq!(data.add_destination, Some(routes::add_destination()));
    assert_eq!(data.forget_label, words::backup_forget(EN));
    assert_eq!(data.rule_label, words::backup_rule_heading(EN));
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
    assert_eq!(
        data.destinations
            .iter()
            .map(|row| row.pair_again)
            .collect::<Vec<_>>(),
        vec![true, false]
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
    assert!(!data.line.as_ref().expect("line").pair_again);
    let all = Page::open(status(vec![refused])).data();
    let all_line = all.line.expect("line");
    assert!(all_line.pair_again);
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
        ..both()
    });
    running.say(tap.clone());
    // ONE PASS ASKED FOR, under its own tag, off the runtime's lock.
    assert_eq!(running.jobs, vec![doors::PASS.to_owned()]);
    let data = running.data();
    assert!(data.backing_up_now && !data.back_up_now_enabled);
    assert_eq!(data.progress, "Backing up — 7 of 10 photos and files");
    // A SECOND PRESS STARTS NOTHING HERE: the run is already going.
    running.say(tap.clone());
    assert_eq!(running.jobs.len(), 1);
    // NOTHING LEFT TO COUNT is said plainly, never "all 10" while it runs.
    let mut whole = Page::open(both());
    whole.say(tap);
    assert_eq!(whole.data().progress, words::backup_now_running(EN));
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
    let reads = page.reads();
    page.set_status(both());
    page.answer_job(None);
    assert_eq!(page.reads(), reads + 1);
    let data = page.data();
    assert!(!data.backing_up_now);
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
    let Some(wire::backup_home_state::Body::Failure(failure)) = page.state().body else {
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
    // A refresh that fails keeps the last reading.
    *page.fake.status.borrow_mut() = None;
    page.send(E::DataChanged(wire::DataChanged { tables: vec![] }));
    assert_eq!(page.data().destinations.len(), 2);
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
    assert!(words::backup_forgotten_not_revoked(EN).contains("centraid-gateway pairings revoke"));

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

// ---- what the doors are asked ---------------------------------------------

#[test]
fn a_pass_is_asked_for_under_the_rule_and_videos_bit_the_screen_shows_by_the_members_own_tap() {
    use super::rule::TransferRule;
    use centraid_core::screens::VaultRequest;
    let drain = |rule, include| match doors::pass_request(rule, include) {
        VaultRequest::Drain(drain) => drain,
        other => panic!("not a pass: {other:?}"),
    };
    let wifi = drain(TransferRule::WifiOnly, true);
    // THE MEMBER'S OWN TAP and a snapshot now: `asked` is set by nothing else.
    assert!(wifi.asked && wifi.wants_snapshot);
    assert_eq!(wifi.rule, wire::TransferRule::WifiOnly as i32);
    assert!(!wifi.exclude_videos, "videos are included by default");
    // THE LINK IS NOT THE SCREEN'S TO KNOW: the conservative reading, no deadline.
    assert!(wifi.metered && !wifi.charging);
    assert_eq!(wifi.deadline_ms, 0);
    let manual = drain(TransferRule::Manual, false);
    assert_eq!(manual.rule, wire::TransferRule::Manual as i32);
    assert!(
        manual.exclude_videos,
        "include videos off is exclude_videos on"
    );
    assert_eq!(
        drain(TransferRule::WifiAndCellularPhotos, true).rule,
        wire::TransferRule::WifiAndCellularPhotos as i32
    );
}

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
    assert_eq!(doors::done(doors::PASS, &[]), Some(doors::Done::Pass));
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
