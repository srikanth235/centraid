//! THE WIDGET SNAPSHOT (app-plane §10, D6): what the Today widget draws, written to the device
//! store as `widget.today` (`{"v":1,…}`) on every commit that can change it. The widget extension
//! reads the file and draws it; it opens nothing, and a tap goes to `centraid://open/<kind>/<id>`.
//! A trash or a purge of an item changes the next snapshot at once.
//!
//! Today is the member's own day in their zone: events that start, or run through it, and tasks
//! due or scheduled on it. A repeating event is not expanded here (the calendar room does that).

use centraid_vault::rusqlite::Connection;
use centraid_vault::time::zone::FireZone;
use serde_json::{Value, json};

use super::open_url;
use crate::error::{CoreError, Result};

pub const KEY: &str = "widget.today";
pub const HEALTH_KEY: &str = "widget.health";
pub const MOST: usize = 3;

#[must_use]
pub fn watches_health(table: &str) -> bool {
    matches!(
        table,
        "measurement" | "workout" | "reading" | "entity" | "vault"
    )
}

/// The finished words the snapshot carries.
pub trait Words {
    fn title(&self) -> String;
    /// "Nothing today".
    fn empty(&self) -> String;
    /// "3 events · 2 tasks".
    fn counts(&self, events: u64, tasks: u64) -> String;
}

fn day_parts(zone: &FireZone, now_ms: i64) -> (String, i64, i64) {
    let wall = zone.zoned_parts(now_ms);
    let day = format!("{:04}-{:02}-{:02}", wall.year, wall.month, wall.day);
    let start = centraid_vault::time::zone::WallTime {
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
        ..wall
    };
    let from = centraid_vault::time::recurrence::parse_instant_ms(
        &zone.resolve_wall_time_forward(start).instant,
    )
    .unwrap_or(now_ms);
    (day, from, from + 86_400_000)
}

/// Today's snapshot, as the JSON the widget reads.
///
/// # Errors
/// The vault's refusal to read.
pub fn today(
    connection: &Connection,
    now_ms: i64,
    zone_name: &str,
    words: &dyn Words,
) -> Result<Value> {
    let zone = FireZone::named(zone_name)
        .or_else(|_| FireZone::named("UTC"))
        .map_err(|error| CoreError::Invariant {
            context: format!("no zone for the widget: {error:?}"),
        })?;
    let (day, from, to) = day_parts(&zone, now_ms);
    let from_text = centraid_vault::clock::format_iso_ms(from);
    let to_text = centraid_vault::clock::format_iso_ms(to);
    let floating_from = format!("{day}T00:00");
    let floating_to = format!("{day}T23:59");
    let held = centraid_domain::glance::today(
        connection,
        &centraid_domain::glance::Day {
            day: &day,
            from: &from_text,
            to: &to_text,
            floating_from: &floating_from,
            floating_to: &floating_to,
        },
    )
    .map_err(|error| CoreError::Invariant {
        context: format!("the widget's read failed: {error}"),
    })?;
    let (event_count, task_count) = (held.events.len() as u64, held.tasks.len() as u64);
    let mut lines: Vec<(&'static str, centraid_domain::glance::Item)> = held
        .events
        .into_iter()
        .map(|item| ("event", item))
        .chain(held.tasks.into_iter().map(|item| ("task", item)))
        .collect();
    lines.truncate(MOST);
    let summary = if lines.is_empty() {
        words.empty()
    } else {
        words.counts(event_count, task_count)
    };
    Ok(json!({
        "v": 1,
        "title": words.title(),
        "day": day,
        "summary": summary,
        "lines": lines
            .iter()
            .map(|(kind, item)| json!({
                "text": item.title,
                "url": open_url::link(kind, &item.id),
                "kind": kind,
            }))
            .collect::<Vec<_>>(),
    }))
}

fn format_number(value: f64) -> String {
    let rounded = format!("{value:.1}");
    rounded
        .strip_suffix(".0")
        .map_or(rounded.clone(), str::to_owned)
}

fn format_metric_figure(metric: &str, value: f64, unit: &str) -> String {
    match metric {
        "steps" => format!("{} steps", format_number(value)),
        "sleep_min" => {
            let total = value.round().max(0.0) as i64;
            let h = total / 60;
            let m = total % 60;
            if h > 0 && m > 0 {
                format!("{h} h {m} min sleep")
            } else if h > 0 {
                format!("{h} h sleep")
            } else {
                format!("{m} min sleep")
            }
        }
        "resting_hr_bpm" => format!("{} bpm resting", format_number(value)),
        "active_energy_kcal" => format!("{} kcal active", format_number(value)),
        "exercise_min" => format!("{} min exercise", format_number(value)),
        _ if unit == "count" => format_number(value),
        _ => format!("{} {unit}", format_number(value)),
    }
}

/// Health's glance snapshot, as the JSON the Health widget reads (`widget.health`, D6).
///
/// # Errors
/// The vault's refusal to read.
pub fn health(connection: &Connection, now_ms: i64, zone_name: &str) -> Result<Value> {
    use centraid_domain::apps::{entity, health as health_reads};
    use centraid_domain::read::{Args, door::run_on};

    let zone = FireZone::named(zone_name)
        .or_else(|_| FireZone::named("UTC"))
        .map_err(|error| CoreError::Invariant {
            context: format!("no zone for the widget: {error:?}"),
        })?;
    let (day, _, _) = day_parts(&zone, now_ms);
    let owner = run_on(connection, &entity::VAULT_INFO, &Args::new())
        .map_err(|error| CoreError::Invariant {
            context: format!("the health widget's vault read failed: {error}"),
        })?
        .rows
        .into_iter()
        .next()
        .map(|info| info.self_id)
        .unwrap_or_default();

    let totals = if owner.is_empty() {
        Vec::new()
    } else {
        run_on(
            connection,
            &health_reads::DAY_TOTALS,
            &Args::new().text("person", &owner).day("day", &day),
        )
        .map_err(|error| CoreError::Invariant {
            context: format!("the health widget's totals read failed: {error}"),
        })?
        .rows
    };

    let workouts = run_on(connection, &health_reads::WORKOUTS, &Args::new())
        .map_err(|error| CoreError::Invariant {
            context: format!("the health widget's workouts read failed: {error}"),
        })?
        .rows;
    let today_workouts: Vec<_> = workouts
        .into_iter()
        .filter(|w| w.starts.starts_with(&day))
        .take(MOST)
        .collect();

    let mut summary_parts = Vec::new();
    for code in ["steps", "sleep_min", "exercise_min", "resting_hr_bpm"] {
        if let Some(row) = totals.iter().find(|r| r.metric == code) {
            summary_parts.push(format_metric_figure(&row.metric, row.value, &row.unit));
        }
    }
    if !today_workouts.is_empty() {
        let count = today_workouts.len();
        summary_parts.push(if count == 1 {
            "1 workout".to_owned()
        } else {
            format!("{count} workouts")
        });
    }
    let summary = if summary_parts.is_empty() {
        "No health data today".to_owned()
    } else {
        summary_parts.join(" · ")
    };

    let lines: Vec<Value> = today_workouts
        .iter()
        .map(|w| {
            let label = if w.title.is_empty() {
                w.type_title.clone()
            } else {
                w.title.clone()
            };
            json!({
                "text": label,
                "url": open_url::link("workout", &w.id),
                "kind": "workout",
            })
        })
        .collect();

    let metrics: Vec<Value> = totals
        .iter()
        .map(|row| {
            json!({
                "metric": row.metric,
                "value": row.value,
                "unit": row.unit,
                "label": format_metric_figure(&row.metric, row.value, &row.unit),
            })
        })
        .collect();

    Ok(json!({
        "v": 1,
        "title": "Health",
        "day": day,
        "summary": summary,
        "metrics": metrics,
        "lines": lines,
    }))
}

/// Write the Health glance snapshot when it differs from what is kept. Returns whether it was written.
///
/// # Errors
/// The vault's refusal to read, or the store's to write.
pub fn refresh_health(
    connection: &Connection,
    store: &super::Checked<super::DirStore>,
    now_ms: i64,
    zone: &str,
) -> Result<bool> {
    let snapshot = health(connection, now_ms, zone)?.to_string();
    if store.get(HEALTH_KEY).ok().flatten().as_deref() == Some(snapshot.as_str()) {
        return Ok(false);
    }
    store
        .put(HEALTH_KEY, &snapshot)
        .map_err(|detail| CoreError::Unavailable { reason: detail })?;
    Ok(true)
}

/// Write the widget snapshots when they differ from what is kept. Returns whether any was written.
///
/// # Errors
/// The vault's refusal to read, or the store's to write.
pub fn refresh(
    connection: &Connection,
    store: &super::Checked<super::DirStore>,
    now_ms: i64,
    zone: &str,
    words: &dyn Words,
) -> Result<bool> {
    let mut wrote = false;
    let snapshot = today(connection, now_ms, zone, words)?.to_string();
    if store.get(KEY).ok().flatten().as_deref() != Some(snapshot.as_str()) {
        store
            .put(KEY, &snapshot)
            .map_err(|detail| CoreError::Unavailable { reason: detail })?;
        wrote = true;
    }
    if refresh_health(connection, store, now_ms, zone)? {
        wrote = true;
    }
    Ok(wrote)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::{Checked, DirStore};
    use centraid_vault::commands::Registry;
    use centraid_vault::{Command, CommandOutcome, Principal, Vault};

    fn commit(vault: &Vault, registry: &Registry, cmd: &str, input: Value) -> CommandOutcome {
        vault
            .execute(
                registry,
                &Principal::owner("phone"),
                &Command::new(cmd, input),
            )
            .expect("commit")
    }

    #[test]
    fn health_glance_writes_versioned_snapshot_and_clears_on_trash() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = Vault::create(dir.path().join("vault.db")).expect("vault");
        vault.found("Test", "Test Owner").expect("found");
        let registry = Registry::with_system_commands().expect("registry");
        let store = Checked::new(DirStore::open(dir.path().join("device")).expect("store"));
        let now_ms = 1_795_687_200_000; // 2026-11-27T10:00:00Z

        let wrote = vault
            .read(|c| Ok(refresh_health(c, &store, now_ms, "UTC")))
            .expect("read")
            .expect("refresh");
        assert!(wrote);
        let raw = store.get(HEALTH_KEY).expect("get").expect("present");
        let parsed: Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["v"], 1);
        assert_eq!(parsed["title"], "Health");
        assert_eq!(parsed["summary"], "No health data today");

        let day = parsed["day"].as_str().expect("day").to_owned();
        commit(
            &vault,
            &registry,
            "measurement.log",
            json!({ "day": day, "metric": "steps", "value": 8420 }),
        );
        let logged = commit(
            &vault,
            &registry,
            "workout.log",
            json!({
                "type": "run",
                "title": "Morning run",
                "starts": format!("{day}T07:00:00.000Z"),
                "moving_s": 1800
            }),
        );
        let workout_id = logged.output["id"].as_str().expect("id").to_owned();

        let wrote_again = vault
            .read(|c| Ok(refresh_health(c, &store, now_ms, "UTC")))
            .expect("read")
            .expect("refresh");
        assert!(wrote_again);
        let after: Value =
            serde_json::from_str(&store.get(HEALTH_KEY).expect("get").expect("present"))
                .expect("json");
        assert_eq!(after["v"], 1);
        assert!(
            after["summary"]
                .as_str()
                .expect("summary")
                .contains("8420 steps")
        );
        assert!(
            after["summary"]
                .as_str()
                .expect("summary")
                .contains("1 workout")
        );
        assert_eq!(
            after["lines"][0]["url"],
            format!("centraid://open/workout/{workout_id}")
        );

        commit(
            &vault,
            &registry,
            "entity.trash",
            json!({ "id": workout_id }),
        );
        vault
            .read(|c| Ok(refresh_health(c, &store, now_ms, "UTC")))
            .expect("read")
            .expect("refresh");
        let trashed: Value =
            serde_json::from_str(&store.get(HEALTH_KEY).expect("get").expect("present"))
                .expect("json");
        assert_eq!(trashed["lines"].as_array().expect("lines").len(), 0);
        assert!(watches_health("measurement"));
        assert!(watches_health("workout"));
        assert!(watches_health("reading"));
    }
}
