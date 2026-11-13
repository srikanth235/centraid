//! THE ONE HONEST LINE, FROM THE CORE'S READING (#1080 ruling 7).
//!
//! A pure function of [`Reading`], so a test proves every sentence without a
//! core. Its one rule is the umbrella's UI invariant: **the line never says more
//! than a gateway acknowledged.** "Backed up" with no qualifier needs the
//! current records acknowledged AND every item confirmed; newer records lead
//! with the changes still waiting. Home draws the same value in
//! its lockup, so both read one set of words.

use centraid_api_proto::core_v1 as wire;
use wire::backup_line::Tone;

use super::claim::bytes;
use super::reading::{Footing, Reading};
use crate::strings::{Locale, backup as words, backup_home as words_home, fill};

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;

/// An acknowledgement older than this, or a gateway unreached as long, earns
/// attention.
pub const STALE_MS: i64 = 3 * DAY_MS;

/// How far ahead of this phone's clock an acknowledgement may read before it is not believed:
/// two clocks differ by seconds, not by hours (#1188, B11).
pub const CLOCK_TOLERANCE_MS: i64 = 5 * MINUTE_MS;

/// A day: one night shift missed is ordinary, a whole day without an
/// acknowledgement is not.
pub const BACKLOG_STOOD_MS: i64 = DAY_MS;

/// Every reason that can hold items, in the order the line lists them.
const REASONS: [wire::WaitReason; 13] = [
    wire::WaitReason::Wifi,
    wire::WaitReason::Charger,
    wire::WaitReason::Gateway,
    wire::WaitReason::Icloud,
    wire::WaitReason::Bytes,
    wire::WaitReason::Window,
    wire::WaitReason::Ask,
    wire::WaitReason::Untrusted,
    wire::WaitReason::Refused,
    wire::WaitReason::TooLarge,
    wire::WaitReason::RefusedOther,
    wire::WaitReason::PairAgain,
    wire::WaitReason::NoRoom,
];

/// No paired backup device has answered within [`STALE_MS`] (or none ever has). One predicate for
/// the line's attention and the page's "not reached".
#[must_use]
pub fn unreached(reading: &Reading, now_ms: i64) -> bool {
    !reading
        .destinations
        .iter()
        .any(|d| d.last_seen_ms.is_some_and(|at| now_ms - at <= STALE_MS))
}

/// THE OLDEST ITEM STILL UNCONFIRMED HAS WAITED LONGER THAN [`STALE_MS`] (#1188): a backlog of
/// originals warns however recent the records' acknowledgement was. While a pass runs the
/// backlog is being worked on, so it does not warn. A time ahead of this phone's clock by more
/// than [`CLOCK_TOLERANCE_MS`] is not believed (a clock set ahead and corrected) and counts as
/// stood, like an acknowledgement dated in the future.
#[must_use]
pub fn backlog_old(reading: &Reading, now_ms: i64, running: bool) -> bool {
    !running
        && reading.unconfirmed() > 0
        && reading
            .oldest_waiting_ms
            .is_some_and(|at| now_ms - at > STALE_MS || at - now_ms > CLOCK_TOLERANCE_MS)
}

/// WHETHER ANYTHING ABOUT THIS BACKUP IS OWED A LOOK: the one reading the line's tone and the
/// status card's condition are both made from, so the card can never be green beside a warning
/// line. A vault that moved and one with no device are the callers' own cases.
#[must_use]
pub fn warns(reading: &Reading, now_ms: i64, running: bool) -> bool {
    if reading.destinations.is_empty() || reading.destinations.iter().all(|d| d.pair_again) {
        return true;
    }
    let Some(acked) = reading.last_ack_ms else {
        return true;
    };
    // AN ACKNOWLEDGEMENT DATED IN THE FUTURE is a clock that was set ahead and corrected: it
    // says nothing of when the backup last ran, so it does not hold the stale warning off
    // until the real date catches up (#1188, B11).
    let from_the_future = acked - now_ms > CLOCK_TOLERANCE_MS;
    // A MACHINE THAT IS NOT THE GATEWAY answered at its address (#1080): the member is owed a
    // look, however recent the ack.
    reading.edits_waiting() > 0
        || now_ms - acked > STALE_MS
        || from_the_future
        || unreached(reading, now_ms)
        || reading.waiting_for(wire::WaitReason::Untrusted) > 0
        || reading.destinations.iter().any(|d| d.pair_again)
        || worst(reading).is_some()
        || backlog_old(reading, now_ms, running)
}

/// The line for one vault. `reading` `None` is "the core could not be asked" (a
/// resting vault): the line is empty and the view draws nothing. `running` is whether a pass is
/// going right now: "Backing up" is said only then. `now_ms` is this phone's clock, for
/// "2 minutes ago" only.
#[must_use]
pub fn line(
    locale: Locale,
    reading: Option<&Reading>,
    frozen: bool,
    running: bool,
    now_ms: i64,
) -> wire::BackupLine {
    if frozen {
        return finish(wire::BackupLine {
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
            waiting,
            sentence: words::backup_line_pair_again(locale),
            status: words::backup_status_pair_again(locale),
            detail: detail(locale, reading),
            tone: Tone::Attention as i32,
            ..Default::default()
        });
    }
    let detail = detail(locale, reading);
    let Some(acked) = reading.last_ack_ms else {
        return finish(wire::BackupLine {
            confirmed: reading.content_confirmed,
            waiting,
            sentence: words::backup_line_never(locale),
            status: words::backup_status_never(locale),
            detail,
            tone: Tone::Attention as i32,
            ..Default::default()
        });
    };
    let edits = reading.edits_waiting();
    let whole = reading.unconfirmed() == 0 && edits == 0;
    let when = ago(locale, acked, now_ms);
    let count = grouped(reading.unconfirmed());
    let stood = backlog_old(reading, now_ms, running);
    let changes = || {
        fill(
            &words::backup_line_changes(locale, edits),
            &[("count", &grouped(edits)), ("when", &when)],
        )
    };
    let sentence = if edits > 0 {
        changes()
    } else if whole {
        fill(&words::backup_line_done(locale), &[("when", &when)])
    } else if let Some(oldest) = reading
        .oldest_waiting_ms
        .filter(|at| stood && now_ms - *at > STALE_MS)
        .map(|at| ago(locale, at, now_ms))
    {
        fill(
            &words::backup_line_backlog(locale),
            &[("count", &count), ("when", &oldest)],
        )
    } else {
        fill(&words::backup_line_records(locale), &[("when", &when)])
    };
    // A pass is busy only while it runs; later edits must never look fully acknowledged.
    let status = if edits > 0 {
        changes()
    } else {
        let template = if whole {
            words::backup_status_done(locale)
        } else if running {
            words::backup_status_catching_up(locale)
        } else {
            words::backup_status_waiting(locale)
        };
        fill(&template, &[("when", &when), ("count", &count)])
    };
    let built = wire::BackupLine {
        confirmed: reading.content_confirmed,
        waiting,
        sentence,
        status,
        detail,
        tone: if warns(reading, now_ms, running) {
            Tone::Attention
        } else {
            Tone::Quiet
        } as i32,
        ..Default::default()
    };
    finish(name_the_one_behind(locale, reading, built))
}

/// The name the member gave a backup device, or the plain word for one with none.
#[must_use]
pub fn device_name(locale: Locale, destination: &super::reading::Destination) -> String {
    if destination.label.trim().is_empty() {
        words::backup_unnamed(locale)
    } else {
        destination.label.clone()
    }
}

/// The device furthest from current (rolled back, then full, then behind), if any is not current.
#[must_use]
pub fn worst(reading: &Reading) -> Option<&super::reading::Destination> {
    reading
        .destinations
        .iter()
        .filter(|d| d.footing() != Footing::Current)
        .max_by_key(|d| d.footing())
}

/// NB1: when one backup device is behind, full or holding an older backup, the card says so by
/// the name the member gave it, and says what the others hold. "Backed up" is never said while
/// any device owes anything.
fn name_the_one_behind(
    locale: Locale,
    reading: &Reading,
    mut line: wire::BackupLine,
) -> wire::BackupLine {
    let Some(worst) = worst(reading) else {
        return line;
    };
    let name = device_name(locale, worst);
    let title = match worst.footing() {
        Footing::RolledBack => words_home::device_older(locale),
        Footing::Full => words_home::device_full(locale),
        Footing::TooLarge => words_home::device_too_large(locale),
        Footing::Refusing => words_home::device_refusing(locale),
        _ => words_home::device_behind(locale),
    };
    // The headline and the status both name it; what the others hold is `last_good`.
    line.status = fill(&title, &[("name", &name)]);
    line.sentence = line.status.clone();
    line.tone = Tone::Attention as i32;
    line
}

/// "Backed up to Srikanth's Mac mini 10 minutes ago": what the devices that are current hold, under
/// the headline that names the one behind. Empty when none is behind or none is current.
#[must_use]
pub fn behind_last_good(locale: Locale, reading: &Reading, now_ms: i64) -> String {
    if worst(reading).is_none() {
        return String::new();
    }
    let current: Vec<&super::reading::Destination> = reading
        .destinations
        .iter()
        .filter(|d| d.footing() == Footing::Current)
        .collect();
    let Some(at) = current.iter().filter_map(|d| d.last_ack_ms).max() else {
        return String::new();
    };
    let others = current
        .iter()
        .map(|d| device_name(locale, d))
        .collect::<Vec<_>>()
        .join(", ");
    fill(
        &words_home::device_backed_up_to(locale),
        &[("others", &others), ("when", &ago(locale, at, now_ms))],
    )
}

/// The one sentence under the card for the device that is behind: why, in words a member can act
/// on. No sentence names a command.
#[must_use]
pub fn behind_reason(locale: Locale, zone: &str, reading: &Reading, now_ms: i64) -> Option<String> {
    let worst = worst(reading)?;
    let name = device_name(locale, worst);
    Some(match worst.footing() {
        Footing::RolledBack => words_home::device_older_reason(locale),
        Footing::Full => fill(&words_home::device_full_reason(locale), &[("name", &name)]),
        Footing::TooLarge => fill(
            &words_home::device_too_large_reason(locale),
            &[
                ("name", &name),
                ("limit", &super::claim::bytes(worst.refused_limit_bytes)),
            ],
        ),
        Footing::Refusing => fill(
            &words_home::device_refusing_reason(locale),
            &[("name", &name)],
        ),
        _ if worst.reach == wire::WaitReason::PairAgain as i32 => {
            words::backup_line_pair_again(locale)
        }
        _ if worst.reach == wire::WaitReason::Gateway as i32 => match worst.last_seen_ms {
            Some(at) => fill(
                &words_home::device_silent_since(locale),
                &[("name", &name), ("day", &since(locale, zone, at, now_ms))],
            ),
            None => fill(&words::backup_unreachable(locale), &[("name", &name)]),
        },
        _ => fill(&words_home::device_catching_up(locale), &[("name", &name)]),
    })
}

/// "Friday" within the week, else "Friday 30 October".
fn since(locale: Locale, zone: &str, at_ms: i64, now_ms: i64) -> String {
    let day = super::stale::since_day(locale, zone, at_ms);
    if now_ms - at_ms < 6 * DAY_MS {
        day.split(' ').next().unwrap_or_default().to_owned()
    } else {
        day
    }
}

/// THE LINE'S SECOND CLAUSE, IN BYTES (#1144): "All 5.0 GB from 8 apps is
/// backed up.", "4.6 of 5.0 GB from 8 apps is backed up.", and when the
/// member left videos out, what that left out: "8.4 GB of videos is left out."
/// Newer record edits take precedence: the shared byte pool cannot say how
/// many current bytes the previous snapshot covered, so name the edits waiting.
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
    // The shared vault-file byte pool has no per-edit precision. Name the known
    // record backlog instead of claiming all current records were acknowledged.
    let edits = reading.edits_waiting();
    let backed = if edits > 0 {
        fill(
            &words::backup_app_edits(locale, edits),
            &[("count", &grouped(edits))],
        )
    } else if reading.confirmed_bytes == 0 {
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
        R::TooLarge => words::backup_wait_too_large(locale),
        R::RefusedOther => words::backup_wait_refused_other(locale),
        R::PairAgain => words::backup_wait_pair_again(locale),
        R::NoRoom => words::backup_wait_no_room(locale),
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
        R::TooLarge => W::TooLarge,
        R::RefusedOther => W::RefusedOther,
        R::PairAgain => W::PairAgain,
        R::NoRoom => W::NoRoom,
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
    let behind =
        reading.unconfirmed() > 0 || reading.edits_waiting() > 0 || reading.pending_bytes > 0;
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
