//! "IN THIS BACKUP" (#1144): one row per app, what it holds, its size on this
//! phone, and whether it is backed up — biggest first.
//!
//! A pure function of [`Reading`], like the line. Its one rule is the line's:
//! **a row never says more than a gateway acknowledged.** "Backed up" needs a
//! snapshot a gateway acknowledged, every original of the app's confirmed and
//! no row of it written since; otherwise the row says what waits.

use centraid_api_proto::core_v1 as wire;

use super::claim::bytes;
use super::line::{grouped, of_bytes};
use super::reading::Reading;
use crate::shell::home::app_name;
use crate::strings::{Locale, backup as words, fill};

/// Every app's row, biggest first; an equal size keeps the catalogue's order.
/// Empty when the reading carries no per-app holdings.
#[must_use]
pub fn rows(locale: Locale, reading: &Reading) -> Vec<wire::BackupAppRow> {
    let mut apps: Vec<&wire::AppHolding> = reading.apps.iter().collect();
    apps.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    let acked = reading.last_ack_ms.is_some() && !reading.destinations.is_empty();
    apps.into_iter()
        .map(|app| row(locale, app, acked))
        .collect()
}

fn row(locale: Locale, app: &wire::AppHolding, acked: bool) -> wire::BackupAppRow {
    let name = app_name(locale, &app.app_id);
    let detail = detail(locale, app);
    let note = if app.left_out_items == 0 {
        String::new()
    } else {
        fill(
            &words::backup_app_left_out(locale, app.left_out_items),
            &[
                ("count", &grouped(app.left_out_items)),
                ("size", &bytes(app.left_out_bytes)),
            ],
        )
    };
    let (status, waiting) = if !acked {
        (words::backup_app_not_backed_up(locale), true)
    } else if app.waiting > 0 {
        (
            fill(
                &words::backup_app_waiting(locale),
                &[("count", &grouped(app.waiting))],
            ),
            true,
        )
    } else if app.edits_waiting > 0 {
        (
            fill(
                &words::backup_app_edits(locale, app.edits_waiting),
                &[("count", &grouped(app.edits_waiting))],
            ),
            true,
        )
    } else {
        (words::backup_app_backed_up(locale), false)
    };
    let accessibility_label = [name.as_str(), &detail, &note, &status]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(". ");
    wire::BackupAppRow {
        app_id: app.app_id.clone(),
        name,
        detail,
        note,
        status,
        waiting,
        accessibility_label,
    }
}

/// What the app holds, in its own unit: "312 notes", "731 days, 96 workouts".
fn what(locale: Locale, app: &wire::AppHolding) -> String {
    let counted = |words: String, count: u64| fill(&words, &[("count", &grouped(count))]);
    let n = app.items;
    match app.app_id.as_str() {
        "agenda" => counted(words::backup_app_agenda(locale, n), n),
        "docs" => counted(words::backup_app_docs(locale, n), n),
        "health" => fill(
            &words::backup_app_health(locale),
            &[
                (
                    "days",
                    &counted(words::backup_app_health_days(locale, n), n),
                ),
                (
                    "workouts",
                    &counted(
                        words::backup_app_health_workouts(locale, app.workouts),
                        app.workouts,
                    ),
                ),
            ],
        ),
        "locker" => counted(words::backup_app_locker(locale, n), n),
        "money" => counted(words::backup_app_money(locale, n), n),
        "notes" => counted(words::backup_app_notes(locale, n), n),
        "people" => counted(words::backup_app_people(locale, n), n),
        // WITH VIDEOS LEFT OUT the count is of photographs alone: the videos
        // are the row's note.
        "photos" if app.left_out_items > 0 => counted(words::backup_app_photos_only(locale, n), n),
        "photos" => counted(words::backup_app_photos(locale, n), n),
        // AN APP THIS SCREEN HAS NO UNIT FOR says its count bare.
        _ => grouped(n),
    }
}

/// "312 notes · 38 MB"; while an app's files are catching up, how far:
/// "1,203 of 1,240 photos and videos · 4.0 of 4.4 GB".
fn detail(locale: Locale, app: &wire::AppHolding) -> String {
    let what = what(locale, app);
    if app.waiting == 0 {
        return fill(
            &words::backup_app_detail(locale),
            &[("what", &what), ("size", &bytes(app.bytes))],
        );
    }
    let what = fill(
        &words::backup_app_of(locale),
        &[
            ("confirmed", &grouped(app.items_confirmed)),
            ("what", &what),
        ],
    );
    fill(
        &words::backup_app_detail(locale),
        &[
            ("what", &what),
            ("size", &of_bytes(locale, app.bytes_confirmed, app.bytes)),
        ],
    )
}
