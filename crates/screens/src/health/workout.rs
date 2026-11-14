//! ONE WORKOUT (#1129): its kind, when, and every figure the store measured —
//! distance, time, pace, energy, heart rate, climb, each only when there is one —
//! and who recorded it. Splits are not here (R-1129-9): they would be a live store
//! read with route samples, a later wave.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::health_workout_event::Kind as W;
use wire::screen_event::Kind as E;

use super::figures;
use super::{Metric, Store, Units, denied, kinds};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::attachments::Attachments;
use crate::kit::civil;
use crate::kit::earlier;
use crate::kit::follow::{self, Source};
use crate::kit::links::{self, Kind, Links, Outcome};
use crate::kit::quantity::Quantity;
use crate::kit::read::{self, Page};
use crate::kit::share::{self, Share};
use crate::kit::trash;
use crate::kit::undo::Undo;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, health as words, links as link_label, shared};

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
        page: Page::loading(),
        gone: false,
        differences: follow::Phone::default(),
        earlier: earlier::Foot::default(),
        undo: Undo::default(),
        share: Share::default(),
        // A workout may link to another workout; the picker leaves this one out (`for_entity`).
        links: Links::new(&Kind::ALL).for_entity(&args.activity_id),
        linked: None,
        linked_unread: false,
        attachments: Attachments::of("health", &args.activity_id),
    }))
}

struct WorkoutPage {
    activity_id: String,
    parent: String,
    /// The read. A workout no longer in the vault is [`Page::Failed`] with `gone` set: a final
    /// failure in its own words, never ready data and never an empty page.
    page: Page<wire::HealthWorkout>,
    gone: bool,
    /// Where the store's figures differ from the member's (#1183), read with the page.
    differences: follow::Phone,
    /// The entry to the workout's earlier versions, read with the page (#1185).
    earlier: earlier::Foot,
    /// The status line and what its Undo reverses (the kit's one door).
    undo: Undo,
    /// The workout handed to the OS share sheet as a spreadsheet file (#1185).
    share: Share,
    /// THE "Linked to" SECTION'S PICKER (#1185): what the workout can link to, any item but a
    /// Locker one.
    links: Links,
    /// What the workout is linked to, either end (`links::read_linked`). `None` until read, and
    /// while a read did not land.
    linked: Option<Vec<wire::LinkedItem>>,
    /// The read of `linked` was refused or failed: the status line says so, no empty section.
    linked_unread: bool,
    /// The photos and files on the workout (#1185): the kit's section, read with the page.
    attachments: Attachments,
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
        let (label, value) = match column {
            "distance_m" => (
                words::figure_distance(locale),
                Quantity::distance_m(stated).words(locale, units),
            ),
            "moving_s" => (
                words::figure_time(locale),
                figures::stopwatch(stated.round() as i64),
            ),
            "energy_kcal" => (
                words::figure_energy(locale),
                figures::measure(Metric::Energy, stated).words(locale, units),
            ),
            "heart_bpm" => (
                words::figure_heart(locale),
                format!("{} {}", stated.round(), words::unit_bpm(locale)),
            ),
            _ => (
                words::figure_elevation(locale),
                Quantity::climb_m(stated).words(locale, units),
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
            .page
            .data()
            .and_then(|answer| answer.workout.as_ref())
            .is_none()
        {
            return;
        }
        let Some(settled) = follow::take(ctx, &self.activity_id, taken) else {
            return;
        };
        // Taking the store's figure has no inverse: it says nothing and offers nothing.
        self.undo.clear();
        if !settled.committed {
            self.undo.refuse(settled.refusal);
        }
        self.reload(ctx);
    }

    /// MOVE TO TRASH (#1185): it asks nothing, because Undo and the trash restore it for 30 days. A
    /// workout a health store states goes like any other and stays in the trash when the store reads
    /// it again. The page stays, reads the workout as gone, and keeps the status line.
    fn trash_workout(&mut self, ctx: &Ctx) {
        let Some(row) = self.page.data().and_then(|answer| answer.workout.as_ref()) else {
            return;
        };
        let title = figures::title(
            ctx.locale(),
            &row.kind_key,
            &civil::clock_for(ctx.locale(), &row.local_start, ctx.hour_cycle()),
        );
        let key = kit_act::key(&["delete-workout", &self.activity_id], kit_act::fresh());
        self.undo.act(
            ctx,
            act::health::DeleteWorkout {
                workout_id: self.activity_id.clone(),
            },
            &key,
            |locale| trash::moved_to_trash(locale, &title),
        );
        self.reload(ctx);
    }

    fn reload(&mut self, ctx: &Ctx) {
        let reading = read::read(
            ctx,
            load::health::Workout {
                activity_id: self.activity_id.clone(),
            },
            |answer| match answer {
                Answer::HealthWorkout(workout) => Some(workout),
                _ => None,
            },
        );
        // A refresh never blanks the page shown: a failed one keeps it under a note.
        let held = std::mem::replace(&mut self.page, Page::loading());
        self.page = held.after(reading, ctx.locale(), |answer| answer.workout.is_none());
        // A read that succeeded and found no workout: it is gone, which is a failure, not an
        // empty place.
        self.gone = matches!(self.page, Page::Empty);
        if self.gone {
            self.page = Page::Failed;
        }
        self.differences = match self.page.data() {
            Some(answer) if answer.workout.is_some() => follow::read(ctx, &self.activity_id),
            _ => follow::Phone::default(),
        };
        self.earlier = match self.page.data() {
            Some(answer) if answer.workout.is_some() => {
                let title = answer.workout.as_ref().map_or_else(String::new, |row| {
                    figures::title(
                        ctx.locale(),
                        &row.kind_key,
                        &civil::clock_for(ctx.locale(), &row.local_start, ctx.hour_cycle()),
                    )
                });
                earlier::foot(ctx, super::EARLIER, &self.activity_id, &title)
            }
            _ => earlier::Foot::default(),
        };
        self.read_linked(ctx);
        if self
            .page
            .data()
            .is_some_and(|answer| answer.workout.is_some())
        {
            self.attachments.reload(ctx);
        }
    }

    /// What the workout is linked to, in both directions. A refused or failed read is said on the
    /// status line and never drawn as an empty section; a workout that is gone has none.
    fn read_linked(&mut self, ctx: &Ctx) {
        if self
            .page
            .data()
            .is_none_or(|answer| answer.workout.is_none())
        {
            self.linked = None;
            self.linked_unread = false;
            self.links.close();
            return;
        }
        match links::read_linked(ctx, &self.activity_id) {
            read::Reading::Data(items) => {
                self.linked = Some(items);
                self.linked_unread = false;
            }
            read::Reading::Denied(_) | read::Reading::Failed => {
                self.linked = None;
                self.linked_unread = true;
                self.links.close();
            }
        }
        self.links.reload(ctx);
    }

    fn linked_ids(&self) -> Vec<String> {
        self.linked.as_deref().map(links::ids).unwrap_or_default()
    }

    /// One tap in the "Linked to" section or its picker, written through the kit's door (Undo
    /// when the core can take it back); the page is read again.
    fn link_workout(&mut self, ctx: &Ctx, event: &wire::LinkEvent) {
        let linked = self.linked_ids();
        let id = self.activity_id.clone();
        let (request, said): (wire::ActRequest, fn(Locale) -> String) =
            match self.links.update(event, &linked, ctx) {
                Outcome::Moved => return,
                Outcome::Add { id: to, .. } => (
                    act::health::Link {
                        from: id.clone(),
                        rel: act::health::LinkRel::Links,
                        to,
                        ..Default::default()
                    }
                    .into(),
                    words::workout_link_added,
                ),
                Outcome::Remove { id: to } => (
                    act::health::Unlink {
                        from: id.clone(),
                        rel: act::health::UnlinkRel::Links,
                        to,
                        ..Default::default()
                    }
                    .into(),
                    words::workout_link_removed,
                ),
            };
        let key = kit_act::key(&[&request.action.clone(), &id], kit_act::fresh());
        self.undo.act(ctx, request, &key, said);
        self.reload(ctx);
    }

    fn data(&self, ctx: &Ctx, answer: &wire::HealthWorkout) -> wire::HealthWorkoutData {
        let (locale, units, cycle) = (ctx.locale(), ctx.units(), ctx.hour_cycle());
        // A workout that is gone is a failed page, so a ready one always holds its row.
        let Some(row) = &answer.workout else {
            return wire::HealthWorkoutData::default();
        };
        let start = &row.local_start;
        let figure =
            |label: String, value: String, unit: String| wire::HealthFigure { label, value, unit };
        let seconds = (row.length_sec > 0).then_some(row.length_sec);
        let mut figures_ = Vec::new();
        if let Some(metres) = row.distance_m.filter(|metres| *metres > 0.0) {
            let (n, u) = Quantity::distance_m(metres).figure(locale, units);
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
            && let Some(pace) = Quantity::pace(seconds, metres)
        {
            let (n, u) = pace.figure(locale, units);
            figures_.push(figure(words::figure_pace(locale), n, u));
        }
        if let Some(kcal) = row.energy_kcal {
            let (n, u) = figures::measure(Metric::Energy, kcal).figure(locale, units);
            figures_.push(figure(words::figure_energy(locale), n, u));
        }
        if let Some(bpm) = row.avg_hr_bpm {
            figures_.push(figure(
                words::figure_heart(locale),
                bpm.to_string(),
                words::unit_bpm(locale),
            ));
        }
        if let Some(metres) = row.elevation_gain_m {
            let (n, u) = Quantity::climb_m(metres).figure(locale, units);
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
            trash_label: shared::trash_move(locale),
            share_label: share::label(locale),
            attachments: Some(self.attachments.view(locale, units)),
            links: self.linked.as_ref().map(|linked| {
                self.links.section(
                    locale,
                    link_label::section_linked(locale),
                    links::rows(locale, linked),
                    words::workout_links_empty(locale),
                )
            }),
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
                Some(W::StatusActed(_)) => {
                    if self.undo.acted(ctx) {
                        self.reload(ctx);
                    }
                }
                Some(W::Link(link)) => self.link_workout(ctx, &link),
                Some(W::Attachment(attachment)) => return self.attachments.event(ctx, attachment),
                Some(W::ShareRequested(_)) => {
                    if self
                        .page
                        .data()
                        .is_some_and(|answer| answer.workout.is_some())
                    {
                        return self.share.tap(ctx.locale());
                    }
                }
                None => {}
            },
            // THE SHELL'S ANSWER to the owner check or the share sheet.
            Some(E::EffectResult(result)) => {
                // A pending pick owns its replies, even while an earlier share's sentence remains.
                if let Some(outcome) = &result.outcome
                    && let Some(effects) = self.attachments.result(ctx, outcome)
                {
                    return effects;
                }
                let id = self.activity_id.clone();
                return self.share.result(ctx, &result, |ctx| {
                    super::export::workouts_file(ctx, Some(&id))
                });
            }
            Some(E::StatusActed(_)) => {
                if self.undo.acted(ctx) {
                    self.reload(ctx);
                }
            }
            Some(E::Left(_)) => {
                self.undo.clear();
                return self.share.left();
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::health_workout_state::Content;
        let locale = ctx.locale();
        let content = self
            .page
            .data()
            .map(|answer| Content::Data(Box::new(self.data(ctx, answer))));
        let mut page = self.page.wire(
            locale,
            |denial| denied(locale, denial),
            wire::EmptyState::default,
        );
        // A workout that is gone says so in its own words and offers no Retry.
        if self.gone && matches!(page.state, Some(wire::page_state::State::Failed(_))) {
            page.state = Some(wire::page_state::State::Failed(read::gone(
                words::workout_gone(locale),
                String::new(),
            )));
        }
        let title = self
            .page
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
                    content,
                    page: Some(page),
                    chrome: Some(wire::HealthPageChrome {
                        title,
                        back_label: if self.parent.is_empty() {
                            words::app_title(locale)
                        } else {
                            self.parent.clone()
                        },
                        retry: words::retry(locale),
                    }),
                    status: self
                        .undo
                        .status()
                        .or_else(|| {
                            self.differences
                                .status(locale, Source::Store(&Store::of(ctx).name(locale)))
                        })
                        .or_else(|| self.share.status())
                        .or_else(|| self.earlier.status(locale))
                        .or_else(|| {
                            self.linked_unread.then(|| wire::StatusLine {
                                sentence: words::workout_links_unread(locale),
                                action_label: String::new(),
                                refused: false,
                            })
                        }),
                    earlier: self.earlier.entry.clone(),
                    origin: self.earlier.origin.clone(),
                    link_picker: (self.linked.is_some() && self.links.is_open())
                        .then(|| self.links.picker(locale, &self.linked_ids())),
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

#[cfg(test)]
#[path = "workout_link_tests.rs"]
mod link_tests;
