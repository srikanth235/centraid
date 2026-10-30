//! HEALTH'S HOME (#1129): Today · Trends · Workouts, and More as sheets. One
//! screen, the tab a parameter (the navigation model's first doctrine), so a tap
//! on the band swaps what is drawn and never a stack entry.
//!
//! - **Today** is the day's numbers against the member's own 30-day typical and
//!   usual range (R-1129-8: whole days, no "by now"), today's workouts, and a
//!   foot that names the store and no time (R-1129-13).
//! - **Trends** is every metric over 30 days, 90 days or a year against the equal
//!   period before.
//! - **Workouts** is every workout, newest first, a kind chip row, a page at a
//!   time.
//! - **More** holds "What Health may read" (which names a chosen type that read
//!   nothing or that the OS refused, R-1129-6), "Choose what to read" (Connect's
//!   page), and "Stop reading", behind a confirm.
//!
//! Nothing connected: every tab is the kit's empty state with one action,
//! Connect (R-ONBOARD-4). Every read asks `health.today` first, which says whether
//! a store is connected and which types have any data.
//!
//! THIS SCREEN HOSTS THE FOLLOW ([`HealthFollow`]): it lives as long as Health
//! does, so a pass runs when it appears and when the member pulls to refresh, on
//! a phone that connected. A pass never asks the OS for permission.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::health_home_event::Kind as H;
use wire::health_home_state::{Sheet, TrendRange};
use wire::screen_event::Kind as E;

use super::figures;
use super::follow::HealthFollow;
use super::{Metric, Phase, Store, Units, denied, routes};
use crate::catalog::load;
use crate::kit::civil;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, health as words, shared};

/// Workouts asked for per page, and the most one window holds (the core's page
/// ceiling).
pub const PAGE: u32 = 50;
pub const MAX_ROWS: u32 = 200;

const BAND_TODAY: &str = "today";
const BAND_TRENDS: &str = "trends";
const BAND_WORKOUTS: &str = "workouts";
const BAND_MORE: &str = "more";

const MORE_READS: &str = "reads";
const MORE_CHOOSE: &str = "choose";
const MORE_STOP: &str = "stop";

const RANGE_DAYS_30: &str = "days_30";
const RANGE_DAYS_90: &str = "days_90";
const RANGE_YEAR: &str = "year";

const WEEK_BACK: i64 = 6;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::HealthHome(args)) = &route.args else {
        return None;
    };
    let destination = match wire::HealthDestination::try_from(args.destination) {
        Ok(wire::HealthDestination::Trends) => wire::HealthDestination::Trends,
        Ok(wire::HealthDestination::Workouts) => wire::HealthDestination::Workouts,
        _ => wire::HealthDestination::Today,
    };
    Some(Box::new(Home {
        destination,
        trend_range: TrendRange::Days30,
        kind_concept_id: String::new(),
        workouts_shown: PAGE,
        sheet: Sheet::None,
        phase: Phase::Loading,
        follow: HealthFollow::following(),
        status: None,
        known_connected: false,
        recheck: false,
    }))
}

/// What the tab in view read.
#[derive(Clone, Debug)]
struct Loaded {
    today: wire::HealthToday,
    trends: Option<wire::HealthTrends>,
    workouts: Option<wire::HealthWorkouts>,
}

struct Home {
    destination: wire::HealthDestination,
    trend_range: TrendRange,
    kind_concept_id: String,
    workouts_shown: u32,
    sheet: Sheet,
    phase: Phase<Loaded>,
    follow: HealthFollow,
    status: Option<wire::StatusLine>,
    /// The vault followed a store the last time this read.
    known_connected: bool,
    /// The vault just became connected while this phone's habit says it is not
    /// (Connect kept a new one): read the habit again so a pass can run.
    recheck: bool,
}

impl Home {
    /// `health.today` always (connected, the types with data), then the tab's own
    /// query.
    fn reload(&mut self, ctx: &Ctx) {
        let reading = read::read(ctx, load::health::Today {}, |answer| match answer {
            Answer::HealthToday(today) => Some(today),
            _ => None,
        });
        let Some(today) = self.take(reading) else {
            return;
        };
        let mut loaded = Loaded {
            today,
            trends: None,
            workouts: None,
        };
        if loaded.today.connected {
            match self.destination {
                wire::HealthDestination::Trends => {
                    let reading = read::read(
                        ctx,
                        load::health::Trends {
                            range: match self.trend_range {
                                TrendRange::Days90 => load::health::TrendsRange::Days90,
                                TrendRange::Year => load::health::TrendsRange::Year,
                                _ => load::health::TrendsRange::Days30,
                            },
                        },
                        |answer| match answer {
                            Answer::HealthTrends(trends) => Some(trends),
                            _ => None,
                        },
                    );
                    let Some(trends) = self.take(reading) else {
                        return;
                    };
                    loaded.trends = Some(trends);
                }
                wire::HealthDestination::Workouts => {
                    let reading = read::read(
                        ctx,
                        load::health::Workouts {
                            limit: self.workouts_shown.clamp(1, MAX_ROWS),
                            after: None,
                            kind_concept_id: Some(self.kind_concept_id.clone())
                                .filter(|kind| !kind.is_empty()),
                        },
                        |answer| match answer {
                            Answer::HealthWorkouts(workouts) => Some(workouts),
                            _ => None,
                        },
                    );
                    let Some(workouts) = self.take(reading) else {
                        return;
                    };
                    loaded.workouts = Some(workouts);
                }
                _ => {}
            }
        }
        let connected = loaded.today.connected;
        let habit = self.follow.device();
        if connected && !self.known_connected && habit.loaded && !habit.connected {
            self.recheck = true;
        }
        self.known_connected = connected;
        self.phase = Phase::Ready(loaded);
    }

    /// The data of a read, else the phase that says why there is none.
    fn take<T>(&mut self, reading: read::Reading<T>) -> Option<T> {
        match reading {
            read::Reading::Data(data) => Some(data),
            read::Reading::Denied(denial) => {
                self.phase = Phase::Denied(denial);
                None
            }
            read::Reading::Failed => {
                self.phase = Phase::Failed;
                None
            }
        }
    }

    fn move_to(&mut self, ctx: &Ctx, to: wire::HealthDestination) {
        self.sheet = Sheet::None;
        if to == self.destination {
            return;
        }
        self.destination = to;
        self.reload(ctx);
    }

    fn band(&mut self, ctx: &Ctx, key: &str) {
        match key {
            BAND_TODAY => self.move_to(ctx, wire::HealthDestination::Today),
            BAND_TRENDS => self.move_to(ctx, wire::HealthDestination::Trends),
            BAND_WORKOUTS => self.move_to(ctx, wire::HealthDestination::Workouts),
            BAND_MORE => self.sheet = Sheet::More,
            _ => {}
        }
    }

    fn range(&mut self, ctx: &Ctx, key: &str) {
        let range = match key {
            RANGE_DAYS_30 => TrendRange::Days30,
            RANGE_DAYS_90 => TrendRange::Days90,
            RANGE_YEAR => TrendRange::Year,
            _ => return,
        };
        if range != self.trend_range {
            self.trend_range = range;
            self.reload(ctx);
        }
    }

    fn kind(&mut self, ctx: &Ctx, kind_concept_id: &str) {
        if kind_concept_id != self.kind_concept_id {
            self.kind_concept_id = kind_concept_id.to_owned();
            self.workouts_shown = PAGE;
            self.reload(ctx);
        }
    }

    fn show_more(&mut self, ctx: &Ctx) {
        let grown = (self.workouts_shown + PAGE).min(MAX_ROWS);
        if grown != self.workouts_shown {
            self.workouts_shown = grown;
            self.reload(ctx);
        }
    }

    fn more(&mut self, key: &str) {
        self.sheet = match key {
            MORE_READS => Sheet::Reads,
            MORE_STOP => Sheet::Stop,
            // `choose` is a route the shell pushes; the sheet goes.
            _ => Sheet::None,
        };
    }

    fn stop(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.sheet = Sheet::None;
        self.status = None;
        let effects = match self.follow.stop(ctx) {
            Some(effects) => effects,
            None => {
                self.status = Some(wire::StatusLine {
                    sentence: shared::write_refused(ctx.locale()),
                    action_label: String::new(),
                    refused: true,
                });
                Vec::new()
            }
        };
        self.reload(ctx);
        effects
    }

    // --- Today -------------------------------------------------------------

    fn today_data(&self, ctx: &Ctx, loaded: &Loaded) -> wire::HealthTodayData {
        let (locale, units) = (ctx.locale(), Units::of(ctx));
        let day = &loaded.today.today;
        let parent = words::app_title(locale);
        let lines: Vec<wire::HealthMetricLine> = Metric::ALL
            .into_iter()
            .map(|metric| {
                let answer = loaded
                    .today
                    .metrics
                    .iter()
                    .find(|answer| Metric::of_wire(answer.metric) == Some(metric));
                metric_line(
                    locale,
                    metric,
                    answer,
                    day,
                    units,
                    metric == Metric::Steps,
                    &parent,
                )
            })
            .collect();
        let workouts: Vec<wire::HealthWorkoutLine> = loaded
            .today
            .workouts
            .iter()
            .map(|row| figures::line(locale, row, day, units, &parent))
            .collect();
        let mut lines = lines.into_iter();
        wire::HealthTodayData {
            hero: lines.next(),
            metrics_heading: words::today_metrics_heading(locale),
            metrics: lines.collect(),
            workouts_heading: if workouts.is_empty() {
                String::new()
            } else {
                words::today_workouts_heading(locale)
            },
            workouts,
            foot: fill(
                &words::today_foot(locale),
                &[("store", &Store::of(ctx).name(locale))],
            ),
        }
    }

    // --- Trends ------------------------------------------------------------

    fn trends_data(&self, ctx: &Ctx, answer: &wire::HealthTrends) -> wire::HealthTrendsData {
        let (locale, units) = (ctx.locale(), Units::of(ctx));
        let parent = words::app_title(locale);
        let compare = match self.trend_range {
            TrendRange::Days90 => words::trends_compare_90(locale),
            TrendRange::Year => words::trends_compare_year(locale),
            _ => words::trends_compare_30(locale),
        };
        let rows: Vec<wire::HealthTrendRow> = answer
            .trends
            .iter()
            .filter_map(|trend| {
                let metric = Metric::of_wire(trend.metric)?;
                let average = trend.average?;
                let (number, unit) = figures::figure(locale, metric, average, units);
                let (delta, _) =
                    figures::delta(locale, metric, trend.change, trend.change_pct, units);
                let values: Vec<f64> = trend.buckets.iter().filter_map(|b| b.value).collect();
                let lo = values.iter().copied().reduce(f64::min).unwrap_or(average);
                let hi = values.iter().copied().reduce(f64::max).unwrap_or(average);
                let span = if hi - lo > 0.0 { hi - lo } else { 1.0 };
                let height = |value: f64| i32::try_from(figures::bp(value - lo, span)).unwrap_or(0);
                let name = figures::label(locale, metric);
                Some(wire::HealthTrendRow {
                    metric: metric.key().to_owned(),
                    value: number,
                    unit: per_unit(locale, metric, &unit),
                    points_bp: trend
                        .buckets
                        .iter()
                        .map(|bucket| bucket.value.map_or(-1, height))
                        .collect(),
                    average_bp: height(average.clamp(lo, hi)),
                    accessibility_label: if delta.is_empty() {
                        name.clone()
                    } else {
                        fill(
                            &words::trend_spoken(locale),
                            &[("label", &name), ("delta", &delta)],
                        )
                    },
                    label: name,
                    delta,
                    route: Some(routes::metric(metric.key(), &parent)),
                })
            })
            .collect();
        wire::HealthTrendsData {
            compare_line: compare,
            empty: rows.is_empty().then(|| wire::EmptyState {
                headline: words::trends_empty(locale),
                ..Default::default()
            }),
            rows,
        }
    }

    // --- Workouts ----------------------------------------------------------

    fn workouts_data(
        &self,
        ctx: &Ctx,
        answer: &wire::HealthWorkouts,
        today: &str,
    ) -> wire::HealthWorkoutsData {
        let (locale, units) = (ctx.locale(), Units::of(ctx));
        let parent = words::app_title(locale);
        let week = civil::plus_days(today, -WEEK_BACK).unwrap_or_else(|| today.to_owned());
        let mut sections: Vec<wire::HealthWorkoutSection> = Vec::new();
        for row in &answer.workouts {
            let day = row.local_start.get(..10).unwrap_or_default();
            let heading = if day >= week.as_str() {
                words::section_this_week(locale)
            } else {
                figures::month_heading(locale, day, today)
            };
            let line = figures::line(locale, row, today, units, &parent);
            match sections
                .iter_mut()
                .find(|section| section.heading == heading)
            {
                Some(section) => section.rows.push(line),
                None => sections.push(wire::HealthWorkoutSection {
                    heading,
                    rows: vec![line],
                }),
            }
        }
        let shown = u32::try_from(answer.workouts.len()).unwrap_or(u32::MAX);
        wire::HealthWorkoutsData {
            sections,
            more: answer.next.is_some() && shown < MAX_ROWS,
            empty: if !answer.workouts.is_empty() {
                None
            } else if self.kind_concept_id.is_empty() {
                Some(wire::EmptyState {
                    headline: words::workouts_empty(locale),
                    ..Default::default()
                })
            } else {
                Some(wire::EmptyState {
                    headline: words::workouts_kind_empty(locale),
                    ..Default::default()
                })
            },
        }
    }

    // --- Chrome ------------------------------------------------------------

    fn data(&self, ctx: &Ctx, loaded: &Loaded) -> wire::HealthHomeData {
        let locale = ctx.locale();
        let day = loaded.today.today.clone();
        let base = wire::HealthHomeData {
            day_label: civil::day_month(locale, &day),
            today: day.clone(),
            connect: Some(routes::connect(&words::app_title(locale))),
            ..Default::default()
        };
        if !loaded.today.connected {
            let store = Store::of(ctx).name(locale);
            return wire::HealthHomeData {
                empty: Some(wire::EmptyState {
                    headline: fill(&words::connect_empty(locale), &[("store", &store)]),
                    action_label: fill(&words::connect_action(locale), &[("store", &store)]),
                    ..Default::default()
                }),
                ..base
            };
        }
        match self.destination {
            wire::HealthDestination::Trends => wire::HealthHomeData {
                trends: loaded.trends.as_ref().map(|t| self.trends_data(ctx, t)),
                ..base
            },
            wire::HealthDestination::Workouts => wire::HealthHomeData {
                workouts: loaded
                    .workouts
                    .as_ref()
                    .map(|w| self.workouts_data(ctx, w, &day)),
                ..base
            },
            _ => wire::HealthHomeData {
                today_data: Some(self.today_data(ctx, loaded)),
                ..base
            },
        }
    }

    fn chips(&self, ctx: &Ctx, loaded: &Loaded) -> Vec<wire::HealthChip> {
        let locale = ctx.locale();
        let Some(workouts) = &loaded.workouts else {
            return Vec::new();
        };
        let mut chips = vec![wire::HealthChip {
            key: String::new(),
            label: words::kind_all(locale),
            active: self.kind_concept_id.is_empty(),
        }];
        chips.extend(workouts.kinds.iter().map(|kind| wire::HealthChip {
            key: kind.kind_concept_id.clone(),
            label: figures::kind_chip(locale, &kind.kind_key, &kind.kind_label),
            active: kind.kind_concept_id == self.kind_concept_id,
        }));
        chips
    }

    fn segments(&self, locale: Locale) -> Vec<wire::HealthChip> {
        [
            (
                RANGE_DAYS_30,
                TrendRange::Days30,
                words::range_days_30(locale),
            ),
            (
                RANGE_DAYS_90,
                TrendRange::Days90,
                words::range_days_90(locale),
            ),
            (RANGE_YEAR, TrendRange::Year, words::range_year(locale)),
        ]
        .into_iter()
        .map(|(key, range, label)| wire::HealthChip {
            key: key.to_owned(),
            label,
            active: self.trend_range == range,
        })
        .collect()
    }

    fn more_rows(&self, ctx: &Ctx, connected: bool) -> Vec<wire::HealthMoreRow> {
        let locale = ctx.locale();
        let neutral = wire::status_chip::Tone::Neutral as i32;
        let mut rows = vec![
            wire::HealthMoreRow {
                key: MORE_READS.to_owned(),
                label: words::more_reads(locale),
                icon_key: "Shield".to_owned(),
                tone: neutral,
                route: None,
            },
            wire::HealthMoreRow {
                key: MORE_CHOOSE.to_owned(),
                label: words::more_choose(locale),
                icon_key: "Sliders".to_owned(),
                tone: neutral,
                route: Some(routes::connect(&words::app_title(locale))),
            },
        ];
        if connected {
            rows.push(wire::HealthMoreRow {
                key: MORE_STOP.to_owned(),
                label: fill(
                    &words::more_stop(locale),
                    &[("store", &Store::of(ctx).name(locale))],
                ),
                icon_key: "Stop".to_owned(),
                tone: wire::status_chip::Tone::Net as i32,
                route: None,
            });
        }
        rows
    }

    /// "WHAT HEALTH MAY READ": what it reads, that it writes nothing to the store,
    /// then a line per chosen type the OS refused (Health Connect names them) or,
    /// where the OS cannot say (HealthKit), per chosen type that read nothing in
    /// the year (R-1129-6).
    fn reads_facts(&self, ctx: &Ctx, loaded: Option<&Loaded>) -> Vec<wire::HealthFact> {
        let locale = ctx.locale();
        let store = Store::of(ctx);
        let mut facts = vec![
            wire::HealthFact {
                label: words::reads_fact_reads(locale),
                detail: words::reads_fact_reads_value(locale),
            },
            wire::HealthFact {
                label: words::reads_fact_writes(locale),
                detail: fill(
                    &words::reads_fact_writes_value(locale),
                    &[("store", &store.name(locale))],
                ),
            },
        ];
        let Some(loaded) = loaded.filter(|loaded| loaded.today.connected) else {
            return facts;
        };
        let device = self.follow.device();
        let refused: Vec<Metric> = self
            .follow
            .refused()
            .iter()
            .filter_map(|key| Metric::of_key(key))
            .collect();
        for metric in &refused {
            facts.push(wire::HealthFact {
                label: words::reads_refused(locale),
                detail: fill(
                    &words::reads_refused_value(locale),
                    &[("type", &figures::label(locale, *metric))],
                ),
            });
        }
        if store == Store::AppleHealth {
            let with_data: Vec<Metric> = loaded
                .today
                .metrics_with_data
                .iter()
                .filter_map(|wire| Metric::of_wire(*wire))
                .collect();
            for metric in device
                .chosen
                .iter()
                .filter_map(|key| Metric::of_key(key))
                .filter(|metric| !with_data.contains(metric) && !refused.contains(metric))
            {
                facts.push(wire::HealthFact {
                    label: words::reads_nothing(locale),
                    detail: fill(
                        &words::reads_nothing_value(locale),
                        &[("type", &figures::label(locale, metric))],
                    ),
                });
            }
        }
        facts
    }

    fn band_tabs(&self, locale: Locale) -> Vec<wire::HealthBandTab> {
        let tab = |key: &str, label: String, icon: &str, current: bool| wire::HealthBandTab {
            key: key.to_owned(),
            label,
            icon_key: icon.to_owned(),
            current,
        };
        vec![
            tab(
                BAND_TODAY,
                words::band_today(locale),
                "Heart",
                self.destination == wire::HealthDestination::Today,
            ),
            tab(
                BAND_TRENDS,
                words::band_trends(locale),
                "BarChart2",
                self.destination == wire::HealthDestination::Trends,
            ),
            tab(
                BAND_WORKOUTS,
                words::band_workouts(locale),
                "Gym",
                self.destination == wire::HealthDestination::Workouts,
            ),
            tab(BAND_MORE, words::band_more(locale), "MoreHoriz", false),
        ]
    }
}

/// "a day", "kcal a day", "a night", or the unit alone for a reading that is not
/// a total.
pub(crate) fn per_unit(locale: Locale, metric: Metric, unit: &str) -> String {
    if metric == Metric::Sleep {
        words::per_night(locale)
    } else if !metric.sum() {
        unit.to_owned()
    } else if unit.is_empty() {
        words::per_day(locale)
    } else {
        fill(&words::per_day_unit(locale), &[("unit", unit)])
    }
}

/// One metric against the member's own typical (R-1129-8). The bar is drawing,
/// the figures the core's.
fn metric_line(
    locale: Locale,
    metric: Metric,
    answer: Option<&wire::HealthTodayMetric>,
    today: &str,
    units: Units,
    hero: bool,
    parent: &str,
) -> wire::HealthMetricLine {
    let value = answer.and_then(|answer| answer.value);
    let (number, unit) = value
        .map(|value| figures::figure(locale, metric, value, units))
        .unwrap_or_default();
    let when = match (value, answer.and_then(|answer| answer.day.as_deref())) {
        (None, _) => words::when_nothing(locale),
        _ if metric == Metric::Sleep => words::when_last_night(locale),
        (Some(_), Some(day)) if metric == Metric::Weight && day != today => {
            civil::relative_day(locale, day, today)
        }
        _ if metric.sum() => words::when_so_far(locale),
        _ => words::when_today(locale),
    };
    let typical = answer.and_then(|answer| answer.typical);
    let low = answer.and_then(|answer| answer.low);
    let high = answer.and_then(|answer| answer.high);
    let typical_words = match (typical, low, high) {
        (None, ..) => String::new(),
        (Some(_), Some(low), Some(high)) if metric == Metric::RestingHr => fill(
            &words::typical_range(locale),
            &[
                ("low", &figures::figure(locale, metric, low, units).0),
                ("high", &figures::figure(locale, metric, high, units).0),
            ],
        ),
        (Some(typical), ..) => fill(
            &words::typical(locale),
            &[("value", &figures::phrase(locale, metric, typical, units))],
        ),
    };
    let bar = match (low, high) {
        (Some(low), Some(high)) => {
            let scale = figures::scale_over(value.unwrap_or(0.0).max(high));
            Some(wire::HealthRangeBar {
                low_bp: figures::bp(low, scale),
                high_bp: figures::bp(high, scale),
                has_value: value.is_some(),
                value_bp: value.map_or(0, |value| figures::bp(value, scale)),
                start_label: if hero { "0".to_owned() } else { String::new() },
                middle_label: if hero {
                    words::hero_scale_middle(locale)
                } else {
                    String::new()
                },
                end_label: if hero {
                    figures::figure(locale, metric, scale, units).0
                } else {
                    String::new()
                },
            })
        }
        _ => None,
    };
    let label = figures::label(locale, metric);
    let figure_words = [number.as_str(), unit.as_str()]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    let accessibility_label = [
        label.as_str(),
        figure_words.as_str(),
        when.as_str(),
        typical_words.as_str(),
    ]
    .iter()
    .filter(|part| !part.is_empty())
    .copied()
    .collect::<Vec<_>>()
    .join(", ");
    wire::HealthMetricLine {
        metric: metric.key().to_owned(),
        label,
        value: number,
        unit,
        when_label: when,
        typical: typical_words,
        bar,
        accessibility_label,
        route: Some(routes::metric(metric.key(), parent)),
    }
}

impl Screen for Home {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let mut effects = Vec::new();
        match event.kind {
            Some(E::Appeared(_)) => {
                self.reload(ctx);
                effects.extend(self.follow.attach());
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::HealthHome(event)) => match event.kind {
                Some(H::Refreshed(_)) => {
                    self.reload(ctx);
                    effects.extend(self.follow.request(ctx));
                }
                Some(H::Band(band)) => self.band(ctx, &band.key),
                Some(H::Range(range)) => self.range(ctx, &range.key),
                Some(H::KindPicked(kind)) => self.kind(ctx, &kind.kind_concept_id),
                Some(H::ShowMore(_)) => self.show_more(ctx),
                Some(H::SheetClosed(_)) => self.sheet = Sheet::None,
                Some(H::More(more)) => self.more(&more.key),
                Some(H::Stop(_)) => effects.extend(self.stop(ctx)),
                None => {}
            },
            Some(other) => {
                if let Some(follow) = self.follow.on_event(&other, ctx) {
                    effects.extend(follow);
                    self.reload(ctx);
                }
            }
            None => {}
        }
        if std::mem::take(&mut self.recheck) {
            effects.extend(self.follow.recheck_device());
        }
        effects
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::health_home_state::Content;
        let locale = ctx.locale();
        let drawing = !matches!(self.phase, Phase::Denied(_));
        let loaded = self.phase.data();
        let connected = loaded.is_some_and(|loaded| loaded.today.connected);
        let store = Store::of(ctx).name(locale);
        let content = match &self.phase {
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => Content::Denied(denied(locale, denial)),
            Phase::Ready(loaded) => Content::Data(Box::new(self.data(ctx, loaded))),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::HealthHome(Box::new(
                wire::HealthHomeState {
                    destination: self.destination as i32,
                    content: Some(content),
                    sheet: self.sheet as i32,
                    band: if drawing {
                        self.band_tabs(locale)
                    } else {
                        Vec::new()
                    },
                    chrome: Some(wire::HealthHomeChrome {
                        title: words::app_title(locale),
                        retry: words::retry(locale),
                        home: words::home(locale),
                        more_title: words::more_title(locale),
                        reads_title: words::reads_title(locale),
                        close_label: words::close(locale),
                        stop_cancel: words::stop_cancel(locale),
                        show_more: words::show_more(locale),
                    }),
                    kind_concept_id: self.kind_concept_id.clone(),
                    chips: if drawing
                        && connected
                        && self.destination == wire::HealthDestination::Workouts
                    {
                        loaded
                            .map(|loaded| self.chips(ctx, loaded))
                            .unwrap_or_default()
                    } else {
                        Vec::new()
                    },
                    segments: if drawing
                        && connected
                        && self.destination == wire::HealthDestination::Trends
                    {
                        self.segments(locale)
                    } else {
                        Vec::new()
                    },
                    more_rows: self.more_rows(ctx, connected),
                    reads_facts: self.reads_facts(ctx, loaded),
                    stop: (self.sheet == Sheet::Stop).then(|| wire::Confirm {
                        title: fill(&words::stop_title(locale), &[("store", &store)]),
                        body: fill(&words::stop_body(locale), &[("store", &store)]),
                        confirm_label: words::stop_confirm(locale),
                        destructive: true,
                    }),
                    status: self.status.clone(),
                },
            ))),
            ..wire::ViewState::default()
        }
    }
}
