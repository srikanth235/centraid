//! "IN THIS BACKUP" (#1209, §6.6): one row per class, what it holds and whether it is backed up.
//!
//! Three rows, always in this order: Records (the vault's own pages), Photo previews (the small
//! versions that make the library browsable) and Photos and files (the originals). A pure
//! function of [`Reading`], like the line. Its one rule is the line's: **a row never says more
//! than a backup device acknowledged.** A class is "Backed up" when every paired device holds all
//! of it, "{k} of {n} devices" when only some do, and "Waiting" when none does. What waits says
//! why (the core's reasons, per class) or, with several devices and only some behind, which
//! device it waits for, by the name the member gave it.

use centraid_api_proto::core_v1 as wire;
use wire::BackupClass as Class;

use super::claim::bytes;
use super::line::{device_name, grouped};
use super::reading::{ClassRow, Destination, Reading};
use crate::strings::{Locale, backup as words, backup_home as words_home, fill};

/// The rows, or none while nothing is paired, the vault moved or the core named no classes.
#[must_use]
pub fn rows(locale: Locale, reading: &Reading, now_ms: i64) -> Vec<wire::BackupAppRow> {
    if reading.classes.is_empty() {
        return Vec::new();
    }
    let fed: Vec<&Destination> = reading
        .destinations
        .iter()
        .filter(|device| !device.moved)
        .collect();
    if fed.is_empty() {
        return Vec::new();
    }
    [Class::Records, Class::Thumbnails, Class::Originals]
        .into_iter()
        .map(|class| row(locale, reading, &fed, class, now_ms))
        .collect()
}

/// What one device holds of a class: its own row, absent when the core sent none.
fn theirs(device: &Destination, class: Class) -> Option<&ClassRow> {
    device.classes.iter().find(|row| row.class == class as i32)
}

fn row(
    locale: Locale,
    reading: &Reading,
    fed: &[&Destination],
    class: Class,
    now_ms: i64,
) -> wire::BackupAppRow {
    let media = class != Class::Records;
    let aggregate = reading.class(class).cloned().unwrap_or_default();
    // A device holds a class whole when the core says so; none of them says it of a class it
    // has never been fed.
    let holders: Vec<&&Destination> = fed
        .iter()
        .filter(|device| theirs(device, class).is_some_and(|row| row.backed_up))
        .collect();
    let all = holders.len() == fed.len();
    let (name, icon_key, key) = match class {
        Class::Records => (words::backup_class_records(locale), "FileText", "records"),
        Class::Thumbnails => (words::backup_class_previews(locale), "Grid", "previews"),
        _ => (words::backup_class_originals(locale), "Image", "originals"),
    };
    let held_names = || {
        holders
            .iter()
            .map(|device| device_name(locale, device))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let detail = if !media {
        match reading.last_ack_ms {
            Some(at) if !holders.is_empty() => fill(
                &words::backup_dest_acked(locale),
                &[("when", &super::line::ago(locale, at, now_ms))],
            ),
            _ => words::backup_dest_acked_never(locale),
        }
    } else if aggregate.total == 0 {
        String::new()
    } else if all {
        let what = counted(locale, class, aggregate.total);
        match class {
            Class::Originals if reading.total_bytes > 0 => fill(
                &words::backup_class_detail(locale),
                &[("what", &what), ("size", &bytes(reading.total_bytes))],
            ),
            _ => what,
        }
    } else if !holders.is_empty() {
        fill(
            &words::backup_class_all_on(locale),
            &[("count", &grouped(aggregate.total)), ("names", &held_names())],
        )
    } else {
        // NO DEVICE HOLDS IT WHOLE: the most any holds.
        let best = fed
            .iter()
            .filter_map(|device| theirs(device, class))
            .map(|row| row.held)
            .max()
            .unwrap_or(0);
        let template = if class == Class::Thumbnails {
            words::backup_class_previews_part(locale)
        } else {
            words::backup_class_originals_part(locale)
        };
        fill(
            &template,
            &[
                ("held", &grouped(best.min(aggregate.total))),
                ("total", &grouped(aggregate.total)),
            ],
        )
    };
    let mut notes = if media && !all {
        waiting_notes(locale, fed, class, &aggregate)
    } else {
        Vec::new()
    };
    if class == Class::Originals && reading.left_out_items > 0 {
        notes.push(if reading.left_out_bytes == 0 {
            fill(
                &words::backup_class_left_out_count(locale, reading.left_out_items),
                &[("count", &grouped(reading.left_out_items))],
            )
        } else {
            fill(
                &words::backup_class_left_out(locale, reading.left_out_items),
                &[
                    ("count", &grouped(reading.left_out_items)),
                    ("size", &bytes(reading.left_out_bytes)),
                ],
            )
        });
    }
    let (status, waiting) = if all {
        (words::backup_class_backed_up(locale), false)
    } else if holders.is_empty() {
        (words::backup_class_waiting(locale), true)
    } else {
        (
            fill(
                &words::backup_class_some(locale),
                &[
                    ("held", &holders.len().to_string()),
                    ("total", &fed.len().to_string()),
                ],
            ),
            true,
        )
    };
    let note = notes.join("\n");
    let accessibility_label = [name.as_str(), &detail, &note, &status]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(". ");
    wire::BackupAppRow {
        app_id: key.to_owned(),
        name,
        detail,
        note,
        status,
        waiting,
        accessibility_label,
        icon_key: icon_key.to_owned(),
    }
}

/// "1,240 photos", "1,282 photos and files".
fn counted(locale: Locale, class: Class, count: u64) -> String {
    let template = if class == Class::Thumbnails {
        words::backup_class_previews_count(locale, count)
    } else {
        words::backup_class_originals_count(locale, count)
    };
    fill(&template, &[("count", &grouped(count))])
}

/// What waits in a class: with several devices and some already holding it, one line per device
/// that does not ("184 waiting for Office NAS"); otherwise the core's reasons.
fn waiting_notes(
    locale: Locale,
    fed: &[&Destination],
    class: Class,
    aggregate: &ClassRow,
) -> Vec<String> {
    let behind: Vec<(&Destination, u64)> = fed
        .iter()
        .filter_map(|device| {
            let row = theirs(device, class)?;
            let owed = aggregate.total.saturating_sub(row.held);
            (!row.backed_up && owed > 0).then_some((*device, owed))
        })
        .collect();
    if fed.len() > 1 && !behind.is_empty() && behind.len() < fed.len() {
        return behind
            .into_iter()
            .map(|(device, owed)| {
                fill(
                    &words_home::device_waiting(locale),
                    &[
                        ("count", &grouped(owed)),
                        ("name", &device_name(locale, device)),
                    ],
                )
            })
            .collect();
    }
    let mut reasons: Vec<&(i32, u64)> = aggregate.waiting.iter().filter(|(_, count)| *count > 0).collect();
    reasons.sort_by_key(|(reason, _)| super::line::reason_rank(*reason));
    reasons
        .into_iter()
        .map(|(reason, count)| {
            fill(
                &super::line::row_words(locale, *reason),
                &[("count", &grouped(*count))],
            )
        })
        .collect()
}
