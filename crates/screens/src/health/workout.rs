//! ONE WORKOUT (#1129): its kind, when, and every figure the store measured —
//! distance, time, pace, energy, heart rate, climb, each only when there is one —
//! and who recorded it. Splits are not here (R-1129-9): they would be a live store
//! read with route samples, a later wave.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::health_workout_event::Kind as W;
use wire::screen_event::Kind as E;

use super::figures;
use super::{Metric, Phase, Store, Units, denied, kinds};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::civil;
use crate::kit::follow::{self, Source};
use crate::kit::read;
use crate::kit::trash;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, health as words, shared};

/// The kinds a pace means something for.
const PACED: [&str; 3] = [kinds::RUN, kinds::WALK, kinds::HIKE];

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::HealthWorkout(args)) = &route.args else {
        return None;
    };
    if args.activity_id.is_empty() {
        return None;
    }
    Some(Box::new(WorkoutPage {
        activity_id: args.activity_id.clone(),
        parent: args.parent.clone(),
        phase: Phase::Loading,
        differences: follow::Phone::default(),
        status: None,
        undo: None,
    }))
}

struct WorkoutPage {
    activity_id: String,
    parent: String,
    phase: Phase<wire::HealthWorkout>,
    /// Where the store's figures differ from the member's (#1183), read with the page.
    differences: follow::Phone,
    status: Option<wire::StatusLine>,
    /// What the status line's Undo does: put the workout back in the trash, or back in the list.
    undo: Option<Undo>,
}

/// The workout the status line's Undo reverses, and which way.
struct Undo {
    activity_id: String,
    title: String,
    /// The workout is in the trash now, so Undo restores it.
    restore: bool,
}

/// The measure columns a line can name, in the order the page draws their figures.
const FIGURES: [&str; 5] = [
    "distance_m",
    "moving_s",
    "energy_kcal",
    "heart_bpm",
    "climb_m",
];

/// The lines under the figures: one per figure the member changed ("Apple Health says 5.0 km")
/// or cleared ("Apple Health still has 148 bpm"), each worded as the page words that figure.
/// `recorded_by` is the foot's sentence, not a figure, and the kind, title and times are not
/// something the page offers to change, so they have no line.
fn phone_says(
    locale: Locale,
    units: Units,
    store: &str,
    found: &[follow::Difference],
) -> Vec<wire::PhoneSays> {
    let Some(workout) = follow::of(found, "workout") else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    for column in FIGURES {
        let Some(item) = workout.items.iter().find(|item| item.key == column) else {
            continue;
        };
        let Some(stated) = item.stated.as_ref().and_then(serde_json::Value::as_f64) else {
            continue;
        };
        let join = |(n, u): (String, String)| {
            if u.is_empty() { n } else { format!("{n} {u}") }
        };
        let (label, value) = match column {
            "distance_m" => (
                words::figure_distance(locale),
                join(figures::distance(locale, stated, units)),
            ),
            "moving_s" => (
                words::figure_time(locale),
                figures::stopwatch(stated.round() as i64),
            ),
            "energy_kcal" => (
                words::figure_energy(locale),
                join(figures::figure(locale, Metric::Energy, stated, units)),
            ),
            "heart_bpm" => (
                words::figure_heart(locale),
                format!("{} {}", stated.round(), words::unit_bpm(locale)),
            ),
            _ => (
                words::figure_elevation(locale),
                join(figures::climb(locale, stated, units)),
            ),
        };
        let (noun, source) = (label.to_lowercase(), Source::Store(store));
        lines.push(if item.held.is_none() {
            follow::still_has(locale, source, &value, &noun, "workout", Some(column))
        } else {
            follow::says(locale, source, &value, &noun, "workout", Some(column))
        });
    }
    lines
}

impl WorkoutPage {
    /// The action under a line: take the store's figure, then read again so the line goes. A
    /// refusal is the status line, over the workout as it still is.
    fn take_store(&mut self, ctx: &Ctx, taken: &wire::PhoneSaysTaken) {
        if self
            .phase
            .data()
            .and_then(|answer| answer.workout.as_ref())
            .is_none()
        {
            return;
        }
        let Some(settled) = follow::take(ctx, &self.activity_id, taken) else {
            return;
        };
        self.status = (!settled.committed).then(|| wire::StatusLine {
            sentence: settled.refusal,
            action_label: String::new(),
            refused: true,
        });
        self.reload(ctx);
    }

    /// MOVE TO TRASH (#1185): it asks nothing, because Undo and the trash restore it for 30 days. A
    /// workout a health store states goes like any other and stays in the trash when the store reads
    /// it again. The page stays, reads the workout as gone, and keeps the status line.
    fn trash_workout(&mut self, ctx: &Ctx) {
        let Some(row) = self.phase.data().and_then(|answer| answer.workout.as_ref()) else {
            return;
        };
        let title = figures::title(
            ctx.locale(),
            &row.kind_key,
            &civil::clock_for(ctx.locale(), &row.local_start, ctx.hour_cycle()),
        );
        self.trash_or_restore(ctx, self.activity_id.clone(), title, false);
    }

    /// The status line's Undo: reverse the last move.
    fn undone(&mut self, ctx: &Ctx) {
        let has_undo = self
            .status
            .as_ref()
            .is_some_and(|status| !status.action_label.is_empty());
        let Some(undo) = self.undo.take().filter(|_| has_undo) else {
            return;
        };
        self.trash_or_restore(ctx, undo.activity_id, undo.title, undo.restore);
    }

    fn trash_or_restore(&mut self, ctx: &Ctx, activity_id: String, title: String, restore: bool) {
        let locale = ctx.locale();
        self.status = None;
        self.undo = None;
        let settled = if restore {
            let key = kit_act::key(&["restore-workout", &activity_id], kit_act::fresh());
            kit_act::act(
                ctx,
                act::health::RestoreWorkout {
                    workout_id: activity_id.clone(),
                },
                &key,
            )
        } else {
            let key = kit_act::key(&["delete-workout", &activity_id], kit_act::fresh());
            kit_act::act(
                ctx,
                act::health::DeleteWorkout {
                    workout_id: activity_id.clone(),
                },
                &key,
            )
        };
        self.status = Some(if settled.committed {
            wire::StatusLine {
                sentence: if restore {
                    trash::restored(locale, &title)
                } else {
                    trash::moved_to_trash(locale, &title)
                },
                action_label: shared::trash_undo(locale),
                refused: false,
            }
        } else {
            wire::StatusLine {
                sentence: settled.refusal,
                action_label: String::new(),
                refused: true,
            }
        });
        if settled.committed {
            self.undo = Some(Undo {
                activity_id,
                title,
                restore: !restore,
            });
        }
        self.reload(ctx);
    }

    fn reload(&mut self, ctx: &Ctx) {
        self.phase = Phase::of(read::read(
            ctx,
            load::health::Workout {
                activity_id: self.activity_id.clone(),
            },
            |answer| match answer {
                Answer::HealthWorkout(workout) => Some(workout),
                _ => None,
            },
        ));
        self.differences = match &self.phase {
            Phase::Ready(answer) if answer.workout.is_some() => {
                follow::read(ctx, &self.activity_id)
            }
            _ => follow::Phone::default(),
        };
    }

    fn data(&self, ctx: &Ctx, answer: &wire::HealthWorkout) -> wire::HealthWorkoutData {
        let (locale, units, cycle) = (ctx.locale(), Units::of(ctx), ctx.hour_cycle());
        let Some(row) = &answer.workout else {
            return wire::HealthWorkoutData {
                gone: Some(wire::EmptyState {
                    headline: words::workout_gone(locale),
                    ..Default::default()
                }),
                ..Default::default()
            };
        };
        let start = &row.local_start;
        let figure =
            |label: String, value: String, unit: String| wire::HealthFigure { label, value, unit };
        let seconds = (row.length_sec > 0).then_some(row.length_sec);
        let mut figures_ = Vec::new();
        if let Some(metres) = row.distance_m.filter(|metres| *metres > 0.0) {
            let (n, u) = figures::distance(locale, metres, units);
            figures_.push(figure(words::figure_distance(locale), n, u));
        }
        if let Some(seconds) = seconds {
            figures_.push(figure(
                words::figure_time(locale),
                figures::stopwatch(seconds),
                String::new(),
            ));
        }
        if PACED.contains(&row.kind_key.as_str())
            && let (Some(seconds), Some(metres)) = (seconds, row.distance_m)
            && let Some((n, u)) = figures::pace(locale, seconds, metres, units)
        {
            figures_.push(figure(words::figure_pace(locale), n, u));
        }
        if let Some(kcal) = row.energy_kcal {
            figures_.push(figure(
                words::figure_energy(locale),
                figures::figure(locale, Metric::Energy, kcal, units).0,
                words::unit_kcal(locale),
            ));
        }
        if let Some(bpm) = row.avg_hr_bpm {
            figures_.push(figure(
                words::figure_heart(locale),
                bpm.to_string(),
                words::unit_bpm(locale),
            ));
        }
        if let Some(metres) = row.elevation_gain_m {
            let (n, u) = figures::climb(locale, metres, units);
            figures_.push(figure(words::figure_elevation(locale), n, u));
        }
        let store = Store::of(ctx).name(locale);
        let foot = [
            match row
                .recorded_by
                .as_deref()
                .filter(|by| !by.trim().is_empty())
            {
                Some(recorder) => fill(
                    &words::workout_foot_by(locale),
                    &[("recorder", recorder), ("store", &store)],
                ),
                None => fill(&words::workout_foot(locale), &[("store", &store)]),
            },
            fill(&words::workout_samples(locale), &[("store", &store)]),
        ]
        .join(" ");
        wire::HealthWorkoutData {
            kind_label: figures::kind_word(locale, &row.kind_key),
            kind_icon_key: figures::kind_icon(&row.kind_key).to_owned(),
            title: figures::title(
                locale,
                &row.kind_key,
                &civil::clock_for(locale, start, cycle),
            ),
            when_label: if start.is_empty() {
                String::new()
            } else {
                fill(
                    &words::workout_when(locale),
                    &[
                        (
                            "day",
                            &civil::day_month(locale, start.get(..10).unwrap_or_default()),
                        ),
                        ("start", &civil::clock_for(locale, start, cycle)),
                        ("end", &civil::clock_for(locale, &row.local_end, cycle)),
                    ],
                )
            },
            figures: figures_,
            foot,
            gone: None,
            trash_label: shared::trash_move(locale),
            figures_phone_says: phone_says(
                locale,
                units,
                &Store::of(ctx).name(locale),
                &self.differences,
            ),
        }
    }
}

impl Screen for WorkoutPage {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::PhoneSaysTaken(taken)) => self.take_store(ctx, &taken),
            Some(E::HealthWorkout(event)) => match event.kind {
                Some(W::Refreshed(_)) => self.reload(ctx),
                Some(W::Trash(_)) => self.trash_workout(ctx),
                Some(W::StatusActed(_)) => self.undone(ctx),
                None => {}
            },
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::health_workout_state::Content;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => Content::Denied(denied(locale, denial)),
            Phase::Ready(answer) => Content::Data(Box::new(self.data(ctx, answer))),
        };
        let title = self
            .phase
            .data()
            .and_then(|answer| answer.workout.as_ref())
            .map_or_else(
                || words::band_workouts(locale),
                |row| figures::kind_word(locale, &row.kind_key),
            );
        wire::ViewState {
            kind: Some(wire::view_state::Kind::HealthWorkout(
                wire::HealthWorkoutState {
                    activity_id: self.activity_id.clone(),
                    content: Some(content),
                    chrome: Some(wire::HealthPageChrome {
                        title,
                        back_label: if self.parent.is_empty() {
                            words::app_title(locale)
                        } else {
                            self.parent.clone()
                        },
                        retry: words::retry(locale),
                    }),
                    status: self.status.clone().or_else(|| {
                        self.differences
                            .status(locale, Source::Store(&Store::of(ctx).name(locale)))
                    }),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}

#[cfg(test)]
mod tests {
    //! The lines for a figure the member cleared: no command clears a followed workout's figure (the
    //! store would state it again), so the differences are built here, as the vault reports them.

    use serde_json::json;

    use super::*;

    fn item(key: &str, stated: Option<f64>, held: Option<f64>) -> follow::Item {
        follow::Item {
            key: key.to_owned(),
            stated: stated.map(|n| json!(n)),
            held: held.map(|n| json!(n)),
        }
    }

    fn workout(items: Vec<follow::Item>) -> Vec<follow::Difference> {
        vec![follow::Difference {
            field: "workout".to_owned(),
            stated: json!({}),
            held: json!({}),
            items,
        }]
    }

    #[test]
    fn a_cleared_figure_is_still_the_stores_a_changed_one_is_its_word_and_an_added_one_has_no_line()
    {
        let found = workout(vec![
            item("climb_m", None, Some(40.0)),
            item("distance_m", Some(5_000.0), Some(4_000.0)),
            item("heart_bpm", Some(148.0), None),
            item("moving_s", Some(1_864.0), None),
            item("energy_kcal", Some(338.0), Some(300.0)),
        ]);
        let lines = phone_says(Locale::En, Units::Metric, "Apple Health", &found);
        let shown: Vec<(&str, &str)> = lines
            .iter()
            .map(|l| (l.lead.as_str(), l.action_label.as_str()))
            .collect();
        assert_eq!(
            shown,
            [
                ("Apple Health says 5.0 km", "Use Apple Health’s"),
                ("Apple Health still has 31:04", "Add back"),
                ("Apple Health says 338 kcal", "Use Apple Health’s"),
                ("Apple Health still has 148 bpm", "Add back"),
            ],
            "in the page's order; the climb the member added has none"
        );
        assert_eq!(
            lines[3].accessibility_label,
            "Add back the average heart rate 148 bpm from Apple Health"
        );
        let take = lines[3].take.clone().expect("take");
        assert_eq!(
            (take.field.as_str(), take.item_key.as_deref()),
            ("workout", Some("heart_bpm"))
        );
    }

    #[test]
    fn nothing_that_differs_is_no_line_and_distances_follow_the_members_units() {
        assert!(phone_says(Locale::En, Units::Metric, "Apple Health", &[]).is_empty());
        let found = workout(vec![item("distance_m", Some(5_000.0), Some(4_000.0))]);
        let lines = phone_says(Locale::En, Units::Imperial, "Health Connect", &found);
        assert_eq!(lines[0].lead, "Health Connect says 3.1 mi");
    }
}
