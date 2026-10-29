//! THE ONE HONEST LINE, FROM THE CORE'S READING (#1080 ruling 7).
//!
//! A pure function of [`Reading`], so a test proves every sentence without a
//! core. Its one rule is the umbrella's UI invariant: **the line never says more
//! than a gateway acknowledged.** "Backed up" with no qualifier needs the
//! records acknowledged AND every item confirmed; records acknowledged with
//! items still waiting say so, and say how many. Home draws the same value in
//! its lockup, so both read one set of words.

use centraid_api_proto::core_v1 as wire;
use wire::backup_line::Tone;

use super::claim::bytes;
use super::reading::Reading;
use crate::strings::{Locale, backup as words, fill};

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;

/// An acknowledgement older than this, or a gateway unreached as long, earns
/// attention.
pub const STALE_MS: i64 = 3 * DAY_MS;

/// A day: one night shift missed is ordinary, a whole day without an
/// acknowledgement is not.
pub const BACKLOG_STOOD_MS: i64 = DAY_MS;

/// Every reason that can hold items, in the order the line lists them.
const REASONS: [wire::WaitReason; 10] = [
    wire::WaitReason::Wifi,
    wire::WaitReason::Charger,
    wire::WaitReason::Gateway,
    wire::WaitReason::Icloud,
    wire::WaitReason::Bytes,
    wire::WaitReason::Window,
    wire::WaitReason::Ask,
    wire::WaitReason::Untrusted,
    wire::WaitReason::Refused,
    wire::WaitReason::PairAgain,
];

/// The line for one vault. `reading` `None` is "the core could not be asked" (a
/// resting vault): the line is empty and the view draws nothing. `now_ms` is
/// this phone's clock, for "2 minutes ago" only.
#[must_use]
pub fn line(
    locale: Locale,
    reading: Option<&Reading>,
    frozen: bool,
    now_ms: i64,
) -> wire::BackupLine {
    if frozen {
        return finish(wire::BackupLine {
            frozen: true,
            sentence: words::backup_line_frozen(locale),
            status: words::backup_status_frozen(locale),
            tone: Tone::Urgent as i32,
            ..Default::default()
        });
    }
    let Some(reading) = reading else {
        return wire::BackupLine::default();
    };
    let waiting = waiting_rows(locale, reading);
    if reading.destinations.is_empty() {
        return finish(wire::BackupLine {
            unpaired: true,
            total: reading.content_total,
            detail: detail(locale, reading),
            sentence: words::backup_line_unpaired(locale),
            status: words::backup_status_unpaired(locale),
            tone: Tone::Attention as i32,
            ..Default::default()
        });
    }
    // EVERY GATEWAY REFUSED THIS PHONE'S TOKEN (#1080, the sweep's F2): the
    // ledger may still say "all acknowledged", but no gateway will take anything
    // now, so the line says to pair again rather than that everything is backed
    // up. One gateway among several refusing is not that: the others carry the
    // backup, and only the tone earns a look.
    if reading.destinations.iter().all(|d| d.pair_again) {
        return finish(wire::BackupLine {
            confirmed: reading.content_confirmed,
            total: reading.content_total,
            waiting,
            sentence: words::backup_line_pair_again(locale),
            status: words::backup_status_pair_again(locale),
            detail: detail(locale, reading),
            tone: Tone::Attention as i32,
            pair_again: true,
            ..Default::default()
        });
    }
    let detail = detail(locale, reading);
    let Some(acked) = reading.last_ack_ms else {
        return finish(wire::BackupLine {
            confirmed: reading.content_confirmed,
            total: reading.content_total,
            waiting,
            sentence: words::backup_line_never(locale),
            status: words::backup_status_never(locale),
            detail,
            tone: Tone::Attention as i32,
            ..Default::default()
        });
    };
    let whole = reading.unconfirmed() == 0;
    let when = ago(locale, acked, now_ms);
    let stale = now_ms - acked > STALE_MS
        || !reading
            .destinations
            .iter()
            .any(|d| d.last_seen_ms.is_some_and(|at| now_ms - at <= STALE_MS));
    // A MACHINE THAT IS NOT THE GATEWAY answered at its address (#1080): the
    // member is owed a look, however recent the ack.
    let attention = stale
        || reading.waiting_for(wire::WaitReason::Untrusted) > 0
        || reading.destinations.iter().any(|d| d.pair_again);
    finish(wire::BackupLine {
        records_as_of_ms: acked,
        confirmed: reading.content_confirmed,
        total: reading.content_total,
        waiting,
        sentence: fill(
            &if whole {
                words::backup_line_done(locale)
            } else {
                words::backup_line_records(locale)
            },
            &[("when", &when)],
        ),
        status: fill(
            &if whole {
                words::backup_status_done(locale)
            } else {
                words::backup_status_catching_up(locale)
            },
            &[("when", &when)],
        ),
        detail,
        tone: if attention {
            Tone::Attention
        } else {
            Tone::Quiet
        } as i32,
        ..Default::default()
    })
}

/// THE LINE'S SECOND CLAUSE, IN BYTES (#1144): "All 5.0 GB from 8 apps is
/// backed up.", "4.6 of 5.0 GB from 8 apps is backed up.", and when the
/// member left videos out, what that left out: "8.4 GB of videos is left out."
/// A reading with no per-app rows (a core that could not name its files) says
/// the counts instead ([`counts`]).
#[must_use]
pub fn detail(locale: Locale, reading: &Reading) -> String {
    if reading.apps.is_empty() {
        return counts(locale, reading);
    }
    let count = u64::try_from(reading.apps.len()).unwrap_or(u64::MAX);
    let apps = fill(
        &words::backup_apps(locale, count),
        &[("count", &grouped(count))],
    );
    let total = bytes(reading.total_bytes);
    let backed = if reading.confirmed_bytes == 0 {
        fill(
            &words::backup_bytes_none(locale),
            &[("total", &total), ("apps", &apps)],
        )
    } else if reading.confirmed_bytes >= reading.total_bytes {
        fill(
            &words::backup_bytes_all(locale),
            &[("total", &total), ("apps", &apps)],
        )
    } else {
        fill(
            &words::backup_bytes_some(locale),
            &[
                (
                    "part",
                    &of_bytes(locale, reading.confirmed_bytes, reading.total_bytes),
                ),
                ("apps", &apps),
            ],
        )
    };
    if reading.left_out_bytes == 0 {
        return backed;
    }
    let left = fill(
        &words::backup_bytes_left_out(locale),
        &[("size", &bytes(reading.left_out_bytes))],
    );
    format!("{backed} {left}")
}

/// "4.6 of 5.0 GB" when both are in one unit, "380 MB of 5.0 GB" when not.
#[must_use]
pub fn of_bytes(locale: Locale, part: u64, whole: u64) -> String {
    let (part, whole) = (bytes(part), bytes(whole));
    let unit = |said: &str| said.rsplit_once(' ').map(|(_, unit)| unit.to_owned());
    match (part.rsplit_once(' '), unit(&whole)) {
        (Some((number, part_unit)), Some(whole_unit)) if part_unit == whole_unit => fill(
            &words::backup_bytes_of(locale),
            &[("part", number), ("whole", &whole)],
        ),
        _ => fill(
            &words::backup_bytes_of(locale),
            &[("part", &part), ("whole", &whole)],
        ),
    }
}

/// "1,203 of 1,240 photos and files", "All 1,240 photos and files", or empty for
/// none.
#[must_use]
pub fn counts(locale: Locale, reading: &Reading) -> String {
    if reading.content_total == 0 {
        String::new()
    } else if reading.unconfirmed() == 0 {
        fill(
            &words::backup_line_all(locale),
            &[("total", &grouped(reading.content_total))],
        )
    } else {
        fill(
            &words::backup_line_count(locale),
            &[
                ("confirmed", &grouped(reading.content_confirmed)),
                ("total", &grouped(reading.content_total)),
            ],
        )
    }
}

/// A number with thousands separated by commas.
#[must_use]
pub fn grouped(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// One row per reason that holds items, in the order of [`REASONS`].
#[must_use]
pub fn waiting_rows(locale: Locale, reading: &Reading) -> Vec<wire::BackupWaitingRow> {
    REASONS
        .iter()
        .filter_map(|reason| {
            let count = reading.waiting_for(*reason);
            (count > 0).then(|| wire::BackupWaitingRow {
                reason: row_reason(*reason) as i32,
                count,
                sentence: fill(
                    &waiting_words(locale, *reason),
                    &[("count", &grouped(count))],
                ),
            })
        })
        .collect()
}

fn waiting_words(locale: Locale, reason: wire::WaitReason) -> String {
    use wire::WaitReason as R;
    match reason {
        R::Wifi | R::Unspecified => words::backup_wait_wifi(locale),
        R::Charger => words::backup_wait_charger(locale),
        R::Gateway => words::backup_wait_gateway(locale),
        R::Icloud => words::backup_wait_icloud(locale),
        R::Bytes => words::backup_wait_bytes(locale),
        R::Window => words::backup_wait_window(locale),
        R::Ask => words::backup_wait_ask(locale),
        R::Untrusted => words::backup_wait_untrusted(locale),
        R::Refused => words::backup_wait_refused(locale),
        R::PairAgain => words::backup_wait_pair_again(locale),
    }
}

/// The row's reason carries the core's own number, so a shell reading either
/// sees one value.
fn row_reason(reason: wire::WaitReason) -> wire::backup_waiting_row::Reason {
    use wire::WaitReason as R;
    use wire::backup_waiting_row::Reason as W;
    match reason {
        R::Unspecified => W::Unspecified,
        R::Wifi => W::Wifi,
        R::Charger => W::Charger,
        R::Gateway => W::Gateway,
        R::Icloud => W::Icloud,
        R::Bytes => W::Bytes,
        R::Window => W::Window,
        R::Ask => W::Ask,
        R::Untrusted => W::Untrusted,
        R::Refused => W::Refused,
        R::PairAgain => W::PairAgain,
    }
}

/// The accessibility label is the line read aloud: sentence, detail, then what
/// waits.
fn finish(mut line: wire::BackupLine) -> wire::BackupLine {
    let mut parts = vec![
        line.sentence.trim_end_matches('.').to_owned(),
        line.detail.clone(),
    ];
    parts.extend(line.waiting.iter().map(|row| row.sentence.clone()));
    line.accessibility_label = parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(". ");
    line
}

/// A BACKLOG THAT HAS STOOD FOR A DAY: something is still to move and no gateway
/// has acknowledged anything for [`BACKLOG_STOOD_MS`]. Only then is battery
/// saving worth a sentence; whether it APPLIES is the shell's to read
/// (Android's optimisation list), so the screen never says it is on. A vault
/// never acknowledged is not counted: its first pass runs in the foreground,
/// where battery saving holds nothing back.
#[must_use]
pub fn backlog_stood(reading: Option<&Reading>, frozen: bool, now_ms: i64) -> bool {
    let Some(reading) = reading else {
        return false;
    };
    if frozen || reading.destinations.is_empty() {
        return false;
    }
    let Some(acked) = reading.last_ack_ms else {
        return false;
    };
    let behind = reading.unconfirmed() > 0 || reading.pending_bytes > 0;
    behind && now_ms - acked >= BACKLOG_STOOD_MS
}

/// HOW LONG AGO, BY ELAPSED TIME ONLY. A day here is 24 hours (there is no
/// calendar in a reading). A `then_ms` ahead of `now_ms` — two clocks that
/// disagree — reads as "just now" rather than as a time in the future.
#[must_use]
pub fn ago(locale: Locale, then_ms: i64, now_ms: i64) -> String {
    let elapsed = (now_ms - then_ms).max(0);
    let minutes = elapsed / MINUTE_MS;
    let hours = elapsed / HOUR_MS;
    let days = elapsed / DAY_MS;
    let n = |value: i64| value.to_string();
    if minutes < 1 {
        words::backup_ago_now(locale)
    } else if minutes == 1 {
        words::backup_ago_minute(locale)
    } else if hours < 1 {
        fill(&words::backup_ago_minutes(locale), &[("n", &n(minutes))])
    } else if hours == 1 {
        words::backup_ago_hour(locale)
    } else if days < 1 {
        fill(&words::backup_ago_hours(locale), &[("n", &n(hours))])
    } else if days == 1 {
        words::backup_ago_day(locale)
    } else {
        fill(&words::backup_ago_days(locale), &[("n", &n(days))])
    }
}
