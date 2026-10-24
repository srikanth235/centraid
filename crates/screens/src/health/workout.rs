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
use crate::catalog::load;
use crate::kit::civil;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{fill, health as words};

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
    }))
}

struct WorkoutPage {
    activity_id: String,
    parent: String,
    phase: Phase<wire::HealthWorkout>,
}

impl WorkoutPage {
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
    }

    fn data(&self, ctx: &Ctx, answer: &wire::HealthWorkout) -> wire::HealthWorkoutData {
        let (locale, units) = (ctx.locale(), Units::of(ctx));
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
        if PACED.contains(&row.kind_key.as_str()) {
            if let (Some(seconds), Some(metres)) = (seconds, row.distance_m) {
                if let Some((n, u)) = figures::pace(locale, seconds, metres, units) {
                    figures_.push(figure(words::figure_pace(locale), n, u));
                }
            }
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
            title: figures::title(locale, &row.kind_key, &civil::clock(start)),
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
                        ("start", &civil::clock(start)),
                        ("end", &civil::clock(&row.local_end)),
                    ],
                )
            },
            figures: figures_,
            foot,
            gone: None,
        }
    }
}

impl Screen for WorkoutPage {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::HealthWorkout(event)) => {
                if let Some(W::Refreshed(_)) = event.kind {
                    self.reload(ctx);
                }
            }
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
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
