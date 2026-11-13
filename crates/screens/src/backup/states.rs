//! WHAT A MEMBER READS OF THE NEW BACKUP (#1191, lane B, row B16): how each backup device stands
//! when it is not simply behind, the notes under its row, the rate a check reads at, and the ask a
//! restore makes when it cannot prove it holds the newest backup.
//!
//! Pure functions of a [`Destination`] and the clock: the screens draw what these return, and
//! `contracts/backup/states.json` pins every sentence for both shells. A device's footing is its
//! worst state ([`Destination::footing`]); the notes below are the things that do not change it
//! (a damaged piece being sent again, an old backup that cannot be read, deletes held for a week).

use super::line;
use super::reading::{Destination, Footing};
use crate::strings::{Locale, backup_check, backup_home, custody, fill};

/// How a device stands, for its row: its worst state in a few words.
#[must_use]
pub fn standing_words(locale: Locale, destination: &Destination) -> String {
    match destination.footing() {
        Footing::Current => backup_home::row_up_to_date(locale),
        Footing::Full => backup_home::row_full(locale),
        Footing::TooLarge => backup_home::row_too_large(locale),
        Footing::Refusing => backup_home::row_refusing(locale),
        Footing::RolledBack => backup_home::row_older(locale),
        Footing::Paused => backup_home::row_paused(locale),
        Footing::TooOld => backup_home::row_too_old(locale),
        Footing::Moved => backup_home::row_moved(locale),
        Footing::Behind => match destination.behind_files {
            0 => backup_home::row_catching_up(locale),
            1 => backup_home::row_behind_one(locale),
            n => fill(
                &backup_home::row_behind_many(locale),
                &[("n", &line::grouped(n))],
            ),
        },
    }
}

/// "3 old files go Friday 20 November": deletes this phone made on a device that it holds for a
/// week. The date is the earliest any of them goes, on the device's clock, in the member's zone.
/// A paused device is not counting: its row says the files are kept while it is paused and shows
/// no date. `None` with none held.
#[must_use]
pub fn held_words(locale: Locale, zone: &str, destination: &Destination) -> Option<String> {
    if destination.held_files == 0 {
        return None;
    }
    if destination.paused {
        return Some(fill(
            &backup_home::row_held_paused(locale, destination.held_files),
            &[("count", &line::grouped(destination.held_files))],
        ));
    }
    let at = destination.held_until_ms?;
    Some(fill(
        &backup_home::row_held(locale, destination.held_files),
        &[
            ("count", &line::grouped(destination.held_files)),
            ("date", &super::stale::since_day(locale, zone, at)),
        ],
    ))
}

/// The notes under a device's row, in the order a member should meet them: an old backup that
/// cannot be read, a piece found damaged and on its way again, deletes held for a week.
#[must_use]
pub fn notes(locale: Locale, zone: &str, destination: &Destination) -> Vec<String> {
    [
        destination
            .unreadable_backup
            .then(|| backup_home::row_unreadable(locale)),
        destination
            .damage_found
            .then(|| backup_home::row_damage_resent(locale)),
        held_words(locale, zone, destination),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Whether the row offers Undo: this phone has deletes held there, and the device is not one that
/// refuses writes (an undo is a signed write, so a paused or moved device cannot take it).
#[must_use]
pub fn can_undo(destination: &Destination) -> bool {
    destination.held_files > 0
        && destination.held_until_ms.is_some()
        && !matches!(destination.footing(), Footing::Paused | Footing::Moved)
}

/// What the last check read, in words, never "verified": "Each check reads 64 of 1,216 stored
/// pieces, chosen at random. Every piece gets read about once in 19 checks." `read` is the pieces
/// the last check actually read (fewer than the usual sample when the link was metered or the
/// budget ran out) and `stored` the pieces the newest backup holds. `None` before a check ran or
/// with nothing stored.
#[must_use]
pub fn rate_sentence(locale: Locale, read: u64, stored: u64) -> Option<String> {
    if read == 0 || stored == 0 {
        return None;
    }
    // EVERY PIECE EVERY TIME is said as that, not as "once in 1 checks".
    if read >= stored {
        return Some(fill(
            &backup_check::check_rate_all_body(locale),
            &[("n", &line::grouped(stored))],
        ));
    }
    let once_in = stored.div_ceil(read);
    Some(fill(
        &backup_check::check_rate_body(locale),
        &[
            ("s", &line::grouped(read)),
            ("n", &line::grouped(stored)),
            ("m", &line::grouped(once_in)),
        ],
    ))
}

/// The ask a restore makes before it claims anything, when it cannot prove it holds the newest
/// backup: one backup device, or one that listed another it could not reach. `date` is the
/// backup's own date, `label` the device that holds it.
#[must_use]
pub fn restore_ask(locale: Locale, date: &str, label: &str) -> String {
    fill(
        &custody::ask_body(locale),
        &[("date", date), ("label", label)],
    )
}
