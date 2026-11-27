use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::{entity as entity_reads, health as reads};
use centraid_domain::read::Args;
use serde_json::{Map, Value, json};

use super::blocks::{self, Confirm, glyph};
use super::door::Door;
use super::first;
use super::form::{self, Explicit, Save};
use super::frame::{self, room};
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::selector::{Act, Handler};
use super::shell::UNITS_KEY;
use crate::strings::{Locale, fill, health as words, home as home_words, shared};

pub const HEALTH: &str = "health";
pub const WORKOUTS: &str = "health/workouts";
pub const NEW_WORKOUT: &str = "health/workouts/new";
pub const VITALS: &str = "health/vitals";
pub const NEW_READING: &str = "health/reading/new";
pub const KINDS: &str = "health/kinds";
pub const TRASH: &str = "health/trash";

const EN: Locale = Locale::En;
const MAX_TEXT: usize = 200;
const MAX_NOTES: usize = 4_000;

const SUMMARY_METRICS: [&str; 5] = [
    "steps",
    "sleep_min",
    "active_energy_kcal",
    "exercise_min",
    "resting_hr_bpm",
];

const VITAL_METRICS: [&str; 4] = ["weight_kg", "blood_pressure", "glucose_mmol", "body_temp_c"];

#[must_use]
pub fn registry() -> Registry {
    Registry::new()
        .exact(HEALTH, || Box::new(SummaryRoom::default()))
        .exact(WORKOUTS, || Box::new(WorkoutsRoom::default()))
        .exact(NEW_WORKOUT, || Box::new(WorkoutForm::new_workout()))
        .exact(VITALS, || Box::new(VitalsRoom::default()))
        .exact(NEW_READING, || Box::new(ReadingForm::new_reading()))
        .exact(KINDS, || Box::new(WorkoutKindsRoom))
        .exact(TRASH, || Box::new(HealthTrash::default()))
        .exact("health/trash/empty", || Box::new(EmptyTrashConfirm))
        .with(Box::new(|key| {
            if let Some(id) = key.strip_prefix("health/trash/purge/") {
                return Some(Box::new(PurgeConfirm { id: id.to_owned() }));
            }
            if let Some(rest) = key.strip_prefix("health/day/")
                && let Some(day) = rest.strip_suffix("/edit")
            {
                return Some(Box::new(DayFiguresForm::new(day.to_owned())));
            }
            if let Some(rest) = key.strip_prefix("health/workout/") {
                if let Some(id) = rest.strip_suffix("/edit") {
                    return Some(Box::new(WorkoutForm::edit_workout(id.to_owned())));
                }
                return Some(Box::new(WorkoutDetailRoom {
                    id: rest.to_owned(),
                }));
            }
            if let Some(rest) = key.strip_prefix("health/reading/")
                && let Some(id) = rest.strip_suffix("/edit")
            {
                return Some(Box::new(ReadingForm::edit_reading(id.to_owned())));
            }
            if let Some(rest) = key.strip_prefix("health/kind/") {
                if let Some(id) = rest.strip_suffix("/rename") {
                    return Some(Box::new(WorkoutKindRenameForm::new(id.to_owned())));
                }
                if let Some((from, into)) = rest.split_once("/merge/") {
                    return Some(Box::new(WorkoutKindMergeConfirm {
                        from: from.to_owned(),
                        into: into.to_owned(),
                    }));
                }
                if let Some(id) = rest.strip_suffix("/merge") {
                    return Some(Box::new(WorkoutKindMergePick { id: id.to_owned() }));
                }
            }
            None
        }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Units {
    Metric,
    Imperial,
}

fn member_units(door: &dyn Door) -> Units {
    let raw = door
        .device_get(UNITS_KEY)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.get("value").and_then(Value::as_str).map(str::to_owned));
    match raw.as_deref() {
        Some("imperial") => Units::Imperial,
        _ => Units::Metric,
    }
}

fn fmt_num(value: f64) -> String {
    let text = format!("{value:.1}");
    text.strip_suffix(".0").map_or(text.clone(), str::to_owned)
}

fn fmt_metric_value(
    units: Units,
    metric: &str,
    unit: &str,
    value: f64,
    value2: Option<f64>,
) -> String {
    if metric == "sleep_min" {
        let total = value.round().max(0.0) as i64;
        let h = total / 60;
        let m = total % 60;
        return if h > 0 && m > 0 {
            format!("{h} h {m} min")
        } else if h > 0 {
            format!("{h} h")
        } else {
            format!("{m} min")
        };
    }
    let (v, v2, label_unit) = match (units, unit) {
        (Units::Imperial, "kg") => (value * 2.204_622_621_8, None, "lb"),
        (Units::Imperial, "degC") => (value * 9.0 / 5.0 + 32.0, None, "°F"),
        (Units::Metric, "degC") => (value, None, "°C"),
        (_, other) => (value, value2, other),
    };
    let figure = v2.map_or_else(
        || fmt_num(v),
        |second| format!("{}/{}", fmt_num(v), fmt_num(second)),
    );
    match label_unit {
        "count" => format!("{figure} steps"),
        other => format!("{figure} {other}"),
    }
}

fn fmt_distance(units: Units, metres: f64) -> String {
    match units {
        Units::Metric if metres < 1_000.0 => format!("{} m", fmt_num(metres)),
        Units::Metric => format!("{} km", fmt_num(metres / 1_000.0)),
        Units::Imperial => format!("{} mi", fmt_num(metres / 1_609.344)),
    }
}

fn fmt_climb(units: Units, metres: f64) -> String {
    match units {
        Units::Metric => format!("{} m", fmt_num(metres)),
        Units::Imperial => format!("{} ft", fmt_num(metres * 3.280_839_9)),
    }
}

fn fmt_duration(seconds: i64) -> String {
    let mins = (seconds / 60).max(1);
    let h = mins / 60;
    let m = mins % 60;
    if h > 0 && m > 0 {
        format!("{h} h {m} min")
    } else if h > 0 {
        format!("{h} h")
    } else {
        format!("{m} min")
    }
}

fn metric_label(metric: &str) -> String {
    match metric {
        "steps" => words::metric_steps(EN),
        "sleep_min" => words::metric_sleep(EN),
        "active_energy_kcal" => words::metric_energy(EN),
        "exercise_min" => words::metric_exercise(EN),
        "resting_hr_bpm" => words::metric_resting_hr(EN),
        "lowest_hr_bpm" => words::metric_lowest_hr(EN),
        "highest_hr_bpm" => words::metric_highest_hr(EN),
        "weight_kg" => words::metric_weight(EN),
        "blood_pressure" => words::metric_bp(EN),
        "glucose_mmol" => words::metric_glucose(EN),
        "body_temp_c" => words::metric_temp(EN),
        other => other.to_owned(),
    }
}

fn epoch_ms_to_ymd(ms: i64) -> (i32, u32, u32) {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + i64::from(m <= 2);
    (year as i32, m as u32, d as u32)
}

fn day_from_ms(ms: i64) -> String {
    let (y, m, d) = epoch_ms_to_ymd(ms);
    format!("{y:04}-{m:02}-{d:02}")
}

fn shift_day(day: &str, delta_days: i64) -> String {
    let iso = format!("{day}T12:00:00.000Z");
    centraid_vault::time::recurrence::parse_instant_ms(&iso)
        .map(|ms| day_from_ms(ms + delta_days * 86_400_000))
        .unwrap_or_else(|| day.to_owned())
}

fn draft_key(door: &dyn Door) -> Option<String> {
    let vault = door.vault_id();
    if vault.is_empty() {
        None
    } else {
        Some(format!("draft.{vault}.workout"))
    }
}

fn owner_id(b: &mut Build<'_>) -> Result<String, super::door::Refused> {
    let info = b.run(&entity_reads::VAULT_INFO, &Args::new())?;
    Ok(info
        .rows
        .into_iter()
        .next()
        .map(|row| row.self_id)
        .unwrap_or_default())
}

fn health_band(b: &mut Build<'_>, active_tab: &str) -> wire::RoomBand {
    let follow_rows = super::follow::items(b, "health");
    let sel = &mut b.sel;
    let tabs = vec![
        frame::tab(
            sel,
            "tab/summary",
            &words::tab_summary(EN),
            "Heart",
            active_tab == HEALTH,
        ),
        frame::tab(
            sel,
            "tab/workouts",
            &words::tab_workouts(EN),
            "Activity",
            active_tab == WORKOUTS,
        ),
        frame::tab(
            sel,
            "tab/vitals",
            &words::tab_vitals(EN),
            "Pulse",
            active_tab == VITALS,
        ),
    ];
    let mut more_trash = blocks::menu_item(
        sel,
        "more/trash",
        &shared::trash_entry(EN),
        Handler::Open(TRASH.to_owned()),
    );
    more_trash.secondary = shared::trash_entry_meta(EN);
    let mut more_items = vec![
        blocks::menu_item(
            sel,
            "more/kinds",
            &words::more_workout_kinds(EN),
            Handler::Open(KINDS.to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/export",
            &words::more_export(EN),
            Handler::Tag("more:export".to_owned()),
        ),
        more_trash,
    ];
    more_items.splice(0..0, follow_rows);
    let more_menu = blocks::menu(
        "band/more/menu",
        vec![blocks::menu_section("", more_items)],
        sel,
    );
    let mut band = frame::band(tabs, Some(Handler::Tag("nav:home".to_owned())), None, sel);
    band.more_selector_id = sel.anchor("band/more");
    band.more = Some(more_menu);
    band
}

fn handle_band_nav(e: &mut Event<'_>, tag: &str) -> Option<Outcome> {
    if let Some(outcome) = super::follow::handle(e, tag) {
        return Some(outcome);
    }
    match tag {
        "nav:home" => Some(Outcome::replace(super::shell::HOME)),
        "tab:tab/summary" => Some(Outcome::replace(HEALTH)),
        "tab:tab/workouts" => Some(Outcome::replace(WORKOUTS)),
        "tab:tab/vitals" => Some(Outcome::replace(VITALS)),
        "more:export" => Some(Outcome::say(&words::export_note(EN))),
        _ => None,
    }
}

#[derive(Default)]
struct SummaryRoom {
    day: Option<String>,
    selected_metric: Option<String>,
    readout_point_id: String,
}

impl SummaryRoom {
    fn active_day(&mut self, now_ms: i64) -> String {
        self.day.get_or_insert_with(|| day_from_ms(now_ms)).clone()
    }

    fn metric(&self) -> &str {
        self.selected_metric.as_deref().unwrap_or("steps")
    }
}

impl RoomScreen for SummaryRoom {
    fn key(&self) -> String {
        HEALTH.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let day = self.active_day(b.door.now_ms());
        let units = member_units(b.door);
        let owner = match owner_id(b) {
            Ok(id) => id,
            Err(refused) => {
                return room(wire::RoomKind::AppPlace, HEALTH)
                    .title(&words::title(EN))
                    .band(health_band(b, HEALTH))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let totals = match b.run(
            &reads::DAY_TOTALS,
            &Args::new().text("person", &owner).day("day", &day),
        ) {
            Ok(ans) => ans.rows,
            Err(refused) => {
                return room(wire::RoomKind::AppPlace, HEALTH)
                    .title(&words::title(EN))
                    .band(health_band(b, HEALTH))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let metric = self.metric().to_owned();
        let from_day = shift_day(&day, -13);
        let trend = b
            .run(
                &reads::METRIC_TREND,
                &Args::new()
                    .text("metric", &metric)
                    .text("person", &owner)
                    .day("from_day", &from_day)
                    .day("to_day", &day),
            )
            .map(|a| a.rows)
            .unwrap_or_default();

        let mut blocks_out = Vec::new();
        let metric_options: Vec<wire::RoomOption> = SUMMARY_METRICS
            .iter()
            .map(|code| blocks::option(code, &metric_label(code), *code == metric))
            .collect();
        blocks_out.push(blocks::choice_block(blocks::choice(
            &mut b.sel,
            "choice/metric",
            &words::tab_summary(EN),
            wire::RoomChoiceStyle::Chips,
            false,
            metric_options,
            "metric:pick",
        )));

        let mut min_val = f64::INFINITY;
        let mut max_val = f64::NEG_INFINITY;
        for row in &trend {
            min_val = min_val.min(row.value);
            max_val = max_val.max(row.value);
        }
        let points: Vec<wire::RoomChartPoint> = trend
            .iter()
            .enumerate()
            .map(|(idx, row)| {
                let formatted = fmt_metric_value(units, &row.metric, &row.unit, row.value, None);
                wire::RoomChartPoint {
                    id: format!("day:{}", row.day),
                    x: idx as f64,
                    y: row.value,
                    y_low: if trend.len() >= 3 { min_val } else { 0.0 },
                    y_high: if trend.len() >= 3 { max_val } else { 0.0 },
                    x_label: row.day[5..].to_owned(),
                    y_label: formatted.clone(),
                    a11y_label: format!("{}: {formatted}", row.day),
                }
            })
            .collect();
        let y_ticks = if trend.is_empty() {
            Vec::new()
        } else {
            let unit = trend[0].unit.as_str();
            vec![
                wire::RoomChartTick {
                    at: min_val,
                    label: fmt_metric_value(units, &metric, unit, min_val, None),
                },
                wire::RoomChartTick {
                    at: max_val,
                    label: fmt_metric_value(units, &metric, unit, max_val, None),
                },
            ]
        };
        let chart_sel = blocks::canvas(&mut b.sel, "chart/summary", "chart:summary");
        let mlabel = metric_label(&metric);
        let series = if points.is_empty() {
            Vec::new()
        } else {
            vec![wire::RoomChartSeries {
                id: metric.clone(),
                label: mlabel.clone(),
                hue_key: "app.health".to_owned(),
                mark: wire::RoomChartMark::Line as i32,
                stack: String::new(),
                points: points.clone(),
            }]
        };
        blocks_out.push(blocks::chart(wire::RoomChart {
            selector_id: chart_sel,
            summary: fill(&words::summary_chart_summary(EN), &[("metric", &mlabel)]),
            series,
            x_ticks: points
                .iter()
                .map(|p| wire::RoomChartTick {
                    at: p.x,
                    label: p.x_label.clone(),
                })
                .collect(),
            y_ticks,
            rules: Vec::new(),
            readout_point_id: self.readout_point_id.clone(),
            empty_sentence: fill(&words::summary_chart_empty(EN), &[("metric", &mlabel)]),
        }));

        if totals.is_empty() && trend.is_empty() && !first::holds(b, "workout") {
            let (sentence, label) = if b.door.reminders_source() {
                (
                    home_words::first_open_health(EN),
                    home_words::tile_empty_health(EN),
                )
            } else {
                (
                    home_words::first_open_health_connect(EN),
                    home_words::tile_empty_health_connect(EN),
                )
            };
            let card = first::first_open(
                b,
                first::FirstOpen {
                    app: "health",
                    icon: "Heart",
                    hue: "app.health",
                    sentence,
                    action: Some((Handler::Tag(format!("{}health", first::IMPORT_TAG)), label)),
                    tail: first::Tail::None,
                    refused: None,
                },
            );
            blocks_out.push(card);
        } else {
            let mut rows = Vec::new();
            let mut says_fields = Vec::new();
            for row in &totals {
                let value_text = fmt_metric_value(units, &row.metric, &row.unit, row.value, None);
                rows.push(
                    blocks::still_row(
                        &mut b.sel,
                        &format!("total/{}", row.metric),
                        &metric_label(&row.metric),
                    )
                    .trailing(&value_text, wire::RoomTone::Neutral)
                    .into_block(),
                );
                if row.origin_id.is_some()
                    && let Some(stated) = row.stated
                    && (row.value - stated).abs() > f64::EPSILON
                {
                    let stated_text = fmt_metric_value(units, &row.metric, &row.unit, stated, None);
                    says_fields.push(blocks::says_field(
                        &mut b.sel,
                        &format!("says/clear/{}", row.metric),
                        &metric_label(&row.metric),
                        &stated_text,
                        &value_text,
                        Handler::Act(Act::new(
                            "measurement.clear",
                            json!({ "day": day, "metric": row.metric }),
                        )),
                    ));
                }
            }
            blocks_out.push(
                blocks::section(&mut b.sel, "section/totals", &words::summary_heading(EN))
                    .blocks(rows)
                    .into_block(),
            );
            if !says_fields.is_empty() {
                blocks_out.push(blocks::says(
                    wire::RoomSaysSource::Phone,
                    &words::phone_says(EN),
                    says_fields,
                    &words::take_phone_value(EN),
                ));
            }
        }

        room(wire::RoomKind::AppPlace, HEALTH)
            .title(&words::title(EN))
            .subtitle(&day)
            .key(
                &mut b.sel,
                "key/prev",
                wire::RoomKeyRole::Tool,
                "ChevronLeft",
                &words::prev_day(EN),
                Handler::Tag("day:prev".to_owned()),
            )
            .key(
                &mut b.sel,
                "key/edit",
                wire::RoomKeyRole::Add,
                "Edit",
                &words::summary_edit_action(EN),
                Handler::Open(format!("health/day/{day}/edit")),
            )
            .band(health_band(b, HEALTH))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if let Some(outcome) = handle_band_nav(e, tag) {
            return outcome;
        }
        match tag {
            "day:prev" => {
                let current = self.active_day(e.door.now_ms());
                self.day = Some(shift_day(&current, -1));
            }
            "day:next" => {
                let current = self.active_day(e.door.now_ms());
                self.day = Some(shift_day(&current, 1));
            }
            "metric:pick" => {
                if let Input::Option(code) = input {
                    self.selected_metric = Some(code.clone());
                    self.readout_point_id.clear();
                }
            }
            "chart:summary" => {
                if let Input::Canvas(wire::room_canvas_event::Kind::ChartScrub(scrub)) = input {
                    self.readout_point_id.clone_from(&scrub.point_id);
                }
            }
            _ => {}
        }
        Outcome::default()
    }
}

struct DayFiguresForm {
    day: String,
    loaded: bool,
    initial: Map<String, Value>,
    touched: BTreeSet<String>,
}

impl DayFiguresForm {
    fn new(day: String) -> Self {
        Self {
            day,
            loaded: false,
            initial: Map::new(),
            touched: BTreeSet::new(),
        }
    }
}

impl RoomScreen for DayFiguresForm {
    fn key(&self) -> String {
        format!("health/day/{}/edit", self.day)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.loaded {
            if let Ok(owner) = owner_id(b)
                && let Ok(ans) = b.run(
                    &reads::DAY_TOTALS,
                    &Args::new().text("person", &owner).day("day", &self.day),
                )
            {
                for row in ans.rows {
                    let s = fmt_num(row.value);
                    b.ui.fields.get_or(&row.metric, &s);
                    self.initial.insert(row.metric, Value::String(s));
                }
            }
            self.loaded = true;
        }
        let mut fields_out = Vec::new();
        for (idx, code) in SUMMARY_METRICS.iter().enumerate() {
            let mut f = form::text(
                &mut b.sel,
                &mut b.ui.fields,
                code,
                &metric_label(code),
                wire::RoomTextKind::Number,
                "",
                32,
            );
            if idx == 0 {
                f = f.focused();
            }
            fields_out.push(f.build());
        }
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("day:save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
                save_enabled: true,
                dirty: !self.touched.is_empty(),
                drafted: false,
            },
        );
        let form_block = form::form(fields_out, Vec::new(), Save::Explicit(save));
        room(wire::RoomKind::Editor, &self.key())
            .title(&words::day_figures_title(EN))
            .subtitle(&self.day)
            .ready(vec![form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if matches!(input, Input::Text(_)) {
            self.touched.insert(tag.to_owned());
            return Outcome::default();
        }
        if tag != "day:save" {
            return Outcome::default();
        }
        // S5/N3: submit ONLY metrics whose field changed so untouched figures never become overrides.
        let mut submitted = 0usize;
        for code in SUMMARY_METRICS {
            let current =
                e.ui.fields
                    .value(code)
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
            let initial = self
                .initial
                .get(code)
                .and_then(Value::as_str)
                .unwrap_or_default();
            if current == initial {
                continue;
            }
            if current.is_empty() {
                if let Err(refused) = e.door.act(&Act::new(
                    "measurement.clear",
                    json!({ "day": self.day, "metric": code }),
                )) {
                    return Outcome::refuse(&refused.0);
                }
                submitted += 1;
                continue;
            }
            let Ok(value) = current.parse::<f64>() else {
                return Outcome::refuse(&words::invalid_number(EN));
            };
            if value < 0.0 || !value.is_finite() {
                return Outcome::refuse(&words::invalid_number(EN));
            }
            if let Err(refused) = e.door.act(&Act::new(
                "measurement.log",
                json!({ "day": self.day, "metric": code, "value": value }),
            )) {
                return Outcome::refuse(&refused.0);
            }
            submitted += 1;
        }
        if submitted == 0 {
            return Outcome::say(&words::day_figures_nothing(EN));
        }
        Outcome::pop()
    }
}

#[derive(Default)]
struct WorkoutsRoom {
    loaded: usize,
}

impl WorkoutsRoom {
    fn page_size(&self) -> usize {
        if self.loaded == 0 { 50 } else { self.loaded }
    }
}

impl RoomScreen for WorkoutsRoom {
    fn key(&self) -> String {
        WORKOUTS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let units = member_units(b.door);
        let page = match b.reload(&reads::WORKOUTS, &Args::new(), self.page_size()) {
            Ok(ans) => ans,
            Err(refused) => {
                return room(wire::RoomKind::AppPlace, WORKOUTS)
                    .title(&words::workouts_title(EN))
                    .band(health_band(b, WORKOUTS))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let blocks_out = if page.rows.is_empty() {
            vec![blocks::empty(
                glyph("Activity", "app.health"),
                &words::workouts_empty_title(EN),
                &words::workouts_empty_body(EN),
                Some(blocks::action(
                    &mut b.sel,
                    "empty/log",
                    &words::workout_add(EN),
                    "Add",
                    Handler::Open(NEW_WORKOUT.to_owned()),
                )),
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = page
                .rows
                .iter()
                .map(|w| {
                    let title = if w.title.is_empty() {
                        w.type_title.as_str()
                    } else {
                        w.title.as_str()
                    };
                    let mut parts = vec![
                        w.type_title.clone(),
                        w.starts[..10.min(w.starts.len())].to_owned(),
                    ];
                    if let Some(secs) = w.moving_s {
                        parts.push(fmt_duration(secs));
                    }
                    if let Some(dist) = w.distance_m {
                        parts.push(fmt_distance(units, dist));
                    }
                    let id = &w.id;
                    let starred = w.starred_at.is_some();
                    let star_act = if starred {
                        Act::new(
                            "flag.clear/starred",
                            json!({ "flag": "starred", "ids": [id] }),
                        )
                    } else {
                        Act::new(
                            "flag.set/starred",
                            json!({ "flag": "starred", "ids": [id] }),
                        )
                    };
                    let mut trash_item = blocks::menu_item(
                        &mut b.sel,
                        &format!("row/{id}/menu/trash"),
                        &shared::trash_move(EN),
                        Handler::Act(Act::new("entity.trash", json!({ "ids": [id] }))),
                    );
                    trash_item.destructive = true;
                    let menu = blocks::menu(
                        &format!("row/{id}/menu"),
                        vec![blocks::menu_section(
                            "",
                            vec![
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("row/{id}/menu/open"),
                                    &shared::kit_open(EN),
                                    Handler::Open(format!("health/workout/{id}")),
                                ),
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("row/{id}/menu/edit"),
                                    &words::workout_menu_edit(EN),
                                    Handler::Open(format!("health/workout/{id}/edit")),
                                ),
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("row/{id}/menu/star"),
                                    &if starred {
                                        words::workout_menu_unstar(EN)
                                    } else {
                                        words::workout_menu_star(EN)
                                    },
                                    Handler::Act(star_act),
                                ),
                                trash_item,
                            ],
                        )],
                        &mut b.sel,
                    );
                    blocks::row(
                        &mut b.sel,
                        &format!("row/{id}"),
                        title,
                        Handler::Open(format!("health/workout/{id}")),
                    )
                    .meta(&parts.join(" · "))
                    .menu(menu)
                    .swipe(
                        &mut b.sel,
                        &format!("row/{id}/swipe"),
                        &shared::trash_move(EN),
                        Handler::Act(Act::new("entity.trash", json!({ "ids": [id] }))),
                    )
                    .into_block()
                })
                .collect();
            let mut section =
                blocks::section(&mut b.sel, "section/workouts", &words::workouts_title(EN))
                    .blocks(rows);
            if page.next.is_some() {
                section = section.next_page(&mut b.sel, "section/workouts/next");
            }
            vec![section.into_block()]
        };

        room(wire::RoomKind::AppPlace, WORKOUTS)
            .title(&words::workouts_title(EN))
            .key(
                &mut b.sel,
                "key/add",
                wire::RoomKeyRole::Add,
                "Add",
                &words::workout_add(EN),
                Handler::Open(NEW_WORKOUT.to_owned()),
            )
            .band(health_band(b, WORKOUTS))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if let Some(outcome) = handle_band_nav(e, tag) {
            return outcome;
        }
        if tag == "next_page" {
            self.loaded = self.page_size().saturating_add(50);
        }
        Outcome::default()
    }
}

struct WorkoutDetailRoom {
    id: String,
}

impl RoomScreen for WorkoutDetailRoom {
    fn key(&self) -> String {
        format!("health/workout/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let units = member_units(b.door);
        let detail = match b.run(&reads::WORKOUT_BY_ID, &Args::new().text("id", &self.id)) {
            Ok(ans) => match ans.rows.into_iter().next() {
                Some(row) => row,
                None => {
                    return room(wire::RoomKind::PushedPage, &self.key())
                        .title(&words::workouts_title(EN))
                        .back(&mut b.sel, &words::workouts_title(EN))
                        .failed(&mut b.sel, &shared::read_failed(EN), &shared::kit_retry(EN))
                        .build();
                }
            },
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::workouts_title(EN))
                    .back(&mut b.sel, &words::workouts_title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let type_title = b
            .run(
                &entity_reads::META_BY_ID,
                &Args::new().text("id", &detail.type_id),
            )
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|m| m.title)
            .unwrap_or_else(|| detail.type_id.clone());
        let title = if detail.title.is_empty() {
            type_title.as_str()
        } else {
            detail.title.as_str()
        };

        let mut facts = vec![
            blocks::fact(
                &words::workout_type_label(EN),
                &type_title,
                wire::RoomFactKind::Text,
            ),
            blocks::fact(
                &words::workout_starts_label(EN),
                &detail.starts,
                wire::RoomFactKind::Date,
            ),
        ];
        if let Some(secs) = detail.moving_s {
            facts.push(blocks::fact(
                &words::workout_duration_label(EN),
                &fmt_duration(secs),
                wire::RoomFactKind::Text,
            ));
        }
        if let Some(dist) = detail.distance_m {
            facts.push(blocks::fact(
                &words::workout_distance_label(EN),
                &fmt_distance(units, dist),
                wire::RoomFactKind::Text,
            ));
        }
        if let Some(kcal) = detail.energy_kcal {
            facts.push(blocks::fact(
                &words::workout_energy_label(EN),
                &format!("{} kcal", fmt_num(kcal)),
                wire::RoomFactKind::Text,
            ));
        }
        if let Some(bpm) = detail.heart_bpm {
            facts.push(blocks::fact(
                &words::workout_heart_label(EN),
                &format!("{bpm} bpm"),
                wire::RoomFactKind::Text,
            ));
        }
        if let Some(climb) = detail.climb_m {
            facts.push(blocks::fact(
                &words::workout_climb_label(EN),
                &fmt_climb(units, climb),
                wire::RoomFactKind::Text,
            ));
        }
        if let Some(by) = detail.recorded_by.as_deref() {
            facts.push(blocks::fact(
                &words::workout_recorded_by(EN),
                by,
                wire::RoomFactKind::Text,
            ));
        }

        let mut blocks_out = vec![
            blocks::hero(title)
                .noun(&type_title)
                .mark(blocks::glyph_mark("Activity", "app.health"))
                .block(),
            blocks::facts(facts),
        ];
        if let Some(notes) = detail.notes.as_deref().filter(|s| !s.is_empty()) {
            blocks_out.push(blocks::prose(notes));
        }

        if let Ok(diffs) = b.run(
            &entity_reads::PHONE_DIFFERENCES,
            &Args::new().text("id", &self.id),
        ) && let Some(src) = diffs.rows.first()
            && let Ok(stated_json) = serde_json::from_str::<Value>(&src.stated)
        {
            let mut says_fields = Vec::new();
            if let Some(stated_dist) = stated_json.get("distance_m").and_then(Value::as_f64)
                && detail
                    .distance_m
                    .is_some_and(|mine| (mine - stated_dist).abs() > 0.5)
            {
                says_fields.push(blocks::says_field(
                    &mut b.sel,
                    "says/distance",
                    &words::workout_distance_label(EN),
                    &fmt_distance(units, stated_dist),
                    &fmt_distance(units, detail.distance_m.unwrap_or_default()),
                    Handler::Act(Act::new(
                        "follow.take_stated",
                        json!({ "id": self.id, "fields": ["distance_m"] }),
                    )),
                ));
            }
            if !says_fields.is_empty() {
                blocks_out.push(blocks::says(
                    wire::RoomSaysSource::Phone,
                    &words::phone_says(EN),
                    says_fields,
                    &words::take_phone_value(EN),
                ));
            }
        }

        if let Ok(atts) = b.run(
            &entity_reads::ATTACHMENTS,
            &Args::new().text("id", &self.id),
        ) && !atts.rows.is_empty()
        {
            let rows = atts
                .rows
                .iter()
                .map(|a| {
                    blocks::still_row(&mut b.sel, &format!("att/{}", a.id), &a.title)
                        .meta(&a.kind)
                        .build()
                })
                .collect();
            blocks_out.push(blocks::attachments(
                &words::attachments_heading(EN),
                rows,
                None,
            ));
        }

        if let Ok(links) = b.run(&entity_reads::LINKED, &Args::new().text("id", &self.id))
            && !links.rows.is_empty()
        {
            let rows = links
                .rows
                .iter()
                .map(|other_id| {
                    let label = b
                        .run(&entity_reads::META_BY_ID, &Args::new().text("id", other_id))
                        .ok()
                        .and_then(|a| a.rows.into_iter().next())
                        .map(|m| m.title)
                        .unwrap_or_else(|| other_id.clone());
                    blocks::still_row(&mut b.sel, &format!("link/{other_id}"), &label).build()
                })
                .collect();
            blocks_out.push(blocks::linked(&words::linked_heading(EN), rows, None));
        }

        if let Ok(mentions) = b.run(
            &entity_reads::MENTIONED_IN,
            &Args::new().text("id", &self.id),
        ) && !mentions.rows.is_empty()
        {
            let rows = mentions
                .rows
                .iter()
                .map(|m| {
                    blocks::still_row(&mut b.sel, &format!("mention/{}", m.id), &m.title).build()
                })
                .collect();
            blocks_out.push(blocks::mentioned_in(&words::mentioned_heading(EN), rows));
        }

        if let Ok(rev) = b.run(
            &entity_reads::REVISION_HEAD,
            &Args::new().text("id", &self.id),
        ) && let Some(head) = rev.rows.first()
            && head.count > 0
        {
            blocks_out.push(blocks::earlier_versions(
                &mut b.sel,
                &words::earlier_versions_summary(EN),
                u32::try_from(head.count).unwrap_or(u32::MAX),
                Handler::Tag("earlier".to_owned()),
            ));
        }

        if let Some(label) = detail.arrived_label.as_deref() {
            let line = fill(&shared::origin_line(EN), &[("label", label)]);
            blocks_out.push(blocks::origin(&mut b.sel, &line, None));
        }

        let starred = detail.starred_at.is_some();
        let star_act = if starred {
            Act::new(
                "flag.clear/starred",
                json!({ "flag": "starred", "ids": [self.id] }),
            )
        } else {
            Act::new(
                "flag.set/starred",
                json!({ "flag": "starred", "ids": [self.id] }),
            )
        };
        let mut trash_item = blocks::menu_item(
            &mut b.sel,
            "menu/trash",
            &shared::trash_move(EN),
            Handler::Act(Act::new("entity.trash", json!({ "ids": [self.id] }))),
        );
        trash_item.destructive = true;
        let menu = blocks::menu(
            "header/menu",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/edit",
                        &words::workout_menu_edit(EN),
                        Handler::Open(format!("health/workout/{}/edit", self.id)),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/star",
                        &if starred {
                            words::workout_menu_unstar(EN)
                        } else {
                            words::workout_menu_star(EN)
                        },
                        Handler::Act(star_act),
                    ),
                    trash_item,
                ],
            )],
            &mut b.sel,
        );

        room(wire::RoomKind::PushedPage, &self.key())
            .title(title)
            .back(&mut b.sel, &words::workouts_title(EN))
            .menu_key(&mut b.sel, "key/menu", &words::workout_details(EN), menu)
            .ready(blocks_out)
            .build()
    }
}

struct WorkoutForm {
    id: Option<String>,
    loaded: bool,
    drafted: bool,
    dirty: bool,
    expected_rev: Option<i64>,
    selected_type: String,
}

impl WorkoutForm {
    fn new_workout() -> Self {
        Self {
            id: None,
            loaded: false,
            drafted: false,
            dirty: false,
            expected_rev: None,
            selected_type: "run".to_owned(),
        }
    }

    fn edit_workout(id: String) -> Self {
        Self {
            id: Some(id),
            loaded: false,
            drafted: false,
            dirty: false,
            expected_rev: None,
            selected_type: "run".to_owned(),
        }
    }

    fn save_draft(&self, e: &Event<'_>) {
        if self.id.is_some() {
            return;
        }
        let Some(key) = draft_key(e.door) else {
            return;
        };
        let payload = json!({
            "v": 1,
            "kind": "workout",
            "fields": {
                "type": self.selected_type,
                "title": e.ui.fields.value("title").unwrap_or_default(),
                "starts": e.ui.fields.value("starts").unwrap_or_default(),
                "duration": e.ui.fields.value("duration").unwrap_or_default(),
                "distance": e.ui.fields.value("distance").unwrap_or_default(),
                "energy": e.ui.fields.value("energy").unwrap_or_default(),
                "heart": e.ui.fields.value("heart").unwrap_or_default(),
                "notes": e.ui.fields.value("notes").unwrap_or_default(),
            },
            "saved_at": e.door.now_ms(),
        });
        let _ = e.door.device_put(&key, &payload.to_string());
    }

    fn clear_draft(&self, door: &dyn Door) {
        if self.id.is_none()
            && let Some(key) = draft_key(door)
        {
            let _ = door.device_delete(&key);
        }
    }
}

impl RoomScreen for WorkoutForm {
    fn key(&self) -> String {
        match &self.id {
            Some(id) => format!("health/workout/{id}/edit"),
            None => NEW_WORKOUT.to_owned(),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let units = member_units(b.door);
        let kinds = b
            .run(&reads::WORKOUT_KINDS, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();

        if !self.loaded {
            if let Some(id) = &self.id {
                if let Ok(ans) = b.run(&reads::WORKOUT_BY_ID, &Args::new().text("id", id))
                    && let Some(w) = ans.rows.into_iter().next()
                {
                    if let Some(k) = kinds.iter().find(|k| k.id == w.type_id) {
                        self.selected_type.clone_from(&k.key);
                    }
                    b.ui.fields.get_or("title", &w.title);
                    b.ui.fields.get_or("starts", &w.starts);
                    let dur = w.moving_s.map(|s| (s / 60).to_string()).unwrap_or_default();
                    b.ui.fields.get_or("duration", &dur);
                    let dist = w
                        .distance_m
                        .map(|m| match units {
                            Units::Metric => fmt_num(m / 1_000.0),
                            Units::Imperial => fmt_num(m / 1_609.344),
                        })
                        .unwrap_or_default();
                    b.ui.fields.get_or("distance", &dist);
                    let kcal = w.energy_kcal.map(fmt_num).unwrap_or_default();
                    b.ui.fields.get_or("energy", &kcal);
                    let hr = w.heart_bpm.map(|v| v.to_string()).unwrap_or_default();
                    b.ui.fields.get_or("heart", &hr);
                    b.ui.fields
                        .get_or("notes", w.notes.as_deref().unwrap_or_default());
                }
                if let Ok(rev) = b.run(&entity_reads::REVISION_HEAD, &Args::new().text("id", id))
                    && let Some(head) = rev.rows.first()
                {
                    self.expected_rev = Some(head.seq);
                }
            } else if let Some(key) = draft_key(b.door)
                && let Some(raw) = b.door.device_get(&key)
                && let Ok(parsed) = serde_json::from_str::<Value>(&raw)
                && let Some(fields) = parsed.get("fields").and_then(Value::as_object)
            {
                if let Some(t) = fields.get("type").and_then(Value::as_str) {
                    self.selected_type = t.to_owned();
                }
                for name in [
                    "title", "starts", "duration", "distance", "energy", "heart", "notes",
                ] {
                    if let Some(v) = fields.get(name).and_then(Value::as_str) {
                        b.ui.fields.get_or(name, v);
                    }
                }
                self.drafted = true;
            } else {
                let default_start = format!("{}T07:00:00.000Z", day_from_ms(b.door.now_ms()));
                b.ui.fields.get_or("starts", &default_start);
            }
            self.loaded = true;
        }

        let type_options: Vec<wire::RoomOption> = kinds
            .iter()
            .map(|k| blocks::option(&k.key, &k.title, k.key == self.selected_type))
            .collect();
        let type_choice = blocks::choice_block(blocks::choice(
            &mut b.sel,
            "choice/type",
            &words::workout_type_label(EN),
            wire::RoomChoiceStyle::Menu,
            false,
            type_options,
            "workout:type",
        ));

        let dist_label = match units {
            Units::Metric => format!("{} (km)", words::workout_distance_label(EN)),
            Units::Imperial => format!("{} (mi)", words::workout_distance_label(EN)),
        };

        let form_fields = vec![
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "title",
                &words::workout_title_label(EN),
                wire::RoomTextKind::Line,
                "",
                MAX_TEXT,
            )
            .focused()
            .build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "starts",
                &words::workout_starts_label(EN),
                wire::RoomTextKind::Line,
                "",
                64,
            )
            .build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "duration",
                &words::workout_duration_label(EN),
                wire::RoomTextKind::Number,
                "",
                16,
            )
            .build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "distance",
                &dist_label,
                wire::RoomTextKind::Number,
                "",
                16,
            )
            .build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "energy",
                &words::workout_energy_label(EN),
                wire::RoomTextKind::Number,
                "",
                16,
            )
            .build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "heart",
                &words::workout_heart_label(EN),
                wire::RoomTextKind::Number,
                "",
                16,
            )
            .build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "notes",
                &words::workout_notes_label(EN),
                wire::RoomTextKind::Paragraph,
                "",
                MAX_NOTES,
            )
            .build(),
        ];

        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("workout:save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("workout:cancel".to_owned()),
                save_enabled: true,
                dirty: self.dirty,
                drafted: self.drafted,
            },
        );
        let form_block = form::form(form_fields, Vec::new(), Save::Explicit(save));

        let title = if self.id.is_some() {
            words::workout_edit(EN)
        } else {
            words::workout_add(EN)
        };
        room(wire::RoomKind::Editor, &self.key())
            .title(&title)
            .ready(vec![type_choice, form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if tag == "workout:type" {
            if let Input::Option(key) = input {
                self.selected_type = key.clone();
                self.dirty = true;
                self.save_draft(e);
            }
            return Outcome::default();
        }
        if matches!(input, Input::Text(_)) {
            self.dirty = true;
            self.save_draft(e);
            return Outcome::default();
        }
        if tag == "workout:cancel" {
            self.clear_draft(e.door);
            return Outcome::pop();
        }
        if tag != "workout:save" {
            return Outcome::default();
        }
        let units = member_units(e.door);
        let starts =
            e.ui.fields
                .value("starts")
                .unwrap_or_default()
                .trim()
                .to_owned();
        if starts.is_empty() {
            return Outcome::refuse(&words::workout_starts_required(EN));
        }
        let mut obj = Map::new();
        obj.insert("type".to_owned(), Value::String(self.selected_type.clone()));
        obj.insert("starts".to_owned(), Value::String(starts));

        let title =
            e.ui.fields
                .value("title")
                .unwrap_or_default()
                .trim()
                .to_owned();
        if !title.is_empty() {
            obj.insert("title".to_owned(), Value::String(title));
        }
        let dur_str =
            e.ui.fields
                .value("duration")
                .unwrap_or_default()
                .trim()
                .to_owned();
        if !dur_str.is_empty() {
            let Ok(mins) = dur_str.parse::<i64>() else {
                return Outcome::refuse(&words::invalid_number(EN));
            };
            if mins > 0 {
                obj.insert("moving_s".to_owned(), json!(mins * 60));
            }
        }
        let dist_str =
            e.ui.fields
                .value("distance")
                .unwrap_or_default()
                .trim()
                .to_owned();
        if !dist_str.is_empty() {
            let Ok(v) = dist_str.parse::<f64>() else {
                return Outcome::refuse(&words::invalid_number(EN));
            };
            let metres = match units {
                Units::Metric => v * 1_000.0,
                Units::Imperial => v * 1_609.344,
            };
            obj.insert("distance_m".to_owned(), json!(metres));
        }
        let energy_str =
            e.ui.fields
                .value("energy")
                .unwrap_or_default()
                .trim()
                .to_owned();
        if !energy_str.is_empty() {
            let Ok(v) = energy_str.parse::<f64>() else {
                return Outcome::refuse(&words::invalid_number(EN));
            };
            obj.insert("energy_kcal".to_owned(), json!(v));
        }
        let hr_str =
            e.ui.fields
                .value("heart")
                .unwrap_or_default()
                .trim()
                .to_owned();
        if !hr_str.is_empty() {
            let Ok(v) = hr_str.parse::<i64>() else {
                return Outcome::refuse(&words::invalid_number(EN));
            };
            obj.insert("heart_bpm".to_owned(), json!(v));
        }
        let notes =
            e.ui.fields
                .value("notes")
                .unwrap_or_default()
                .trim()
                .to_owned();
        if !notes.is_empty() {
            obj.insert("notes".to_owned(), Value::String(notes));
        }

        let act = if let Some(id) = &self.id {
            obj.insert("id".to_owned(), Value::String(id.clone()));
            if let Some(rev) = self.expected_rev {
                obj.insert("expected_rev".to_owned(), json!(rev));
            }
            Act::new("workout.edit", Value::Object(obj))
        } else {
            Act::new("workout.log", Value::Object(obj))
        };
        match e.door.act(&act) {
            Ok(_) => {
                self.clear_draft(e.door);
                Outcome::pop()
            }
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

#[derive(Default)]
struct VitalsRoom {
    selected_metric: Option<String>,
    loaded: usize,
    readout_point_id: String,
}

impl VitalsRoom {
    fn metric(&self) -> &str {
        self.selected_metric.as_deref().unwrap_or("weight_kg")
    }

    fn page_size(&self) -> usize {
        if self.loaded == 0 { 50 } else { self.loaded }
    }
}

impl RoomScreen for VitalsRoom {
    fn key(&self) -> String {
        VITALS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let units = member_units(b.door);
        let owner = match owner_id(b) {
            Ok(id) => id,
            Err(refused) => {
                return room(wire::RoomKind::AppPlace, VITALS)
                    .title(&words::vitals_title(EN))
                    .band(health_band(b, VITALS))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let metric = self.metric().to_owned();
        let page = match b.reload(
            &reads::READINGS_BY_METRIC,
            &Args::new().text("person", &owner).text("metric", &metric),
            self.page_size(),
        ) {
            Ok(ans) => ans,
            Err(refused) => {
                return room(wire::RoomKind::AppPlace, VITALS)
                    .title(&words::vitals_title(EN))
                    .band(health_band(b, VITALS))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let mut blocks_out = Vec::new();
        let metric_options: Vec<wire::RoomOption> = VITAL_METRICS
            .iter()
            .map(|code| blocks::option(code, &metric_label(code), *code == metric))
            .collect();
        blocks_out.push(blocks::choice_block(blocks::choice(
            &mut b.sel,
            "choice/vital",
            &words::vitals_title(EN),
            wire::RoomChoiceStyle::Segmented,
            false,
            metric_options,
            "vital:pick",
        )));

        let points: Vec<wire::RoomChartPoint> = page
            .rows
            .iter()
            .rev()
            .enumerate()
            .map(|(idx, r)| {
                let formatted = fmt_metric_value(units, &r.metric, &r.unit, r.value, r.value2);
                wire::RoomChartPoint {
                    id: format!("reading:{}", r.id),
                    x: idx as f64,
                    y: r.value,
                    y_low: r.value2.unwrap_or(0.0),
                    y_high: if r.value2.is_some() { r.value } else { 0.0 },
                    x_label: r.at[5..10.min(r.at.len())].to_owned(),
                    y_label: formatted.clone(),
                    a11y_label: format!("{}: {formatted}", &r.at[..10.min(r.at.len())]),
                }
            })
            .collect();
        let chart_sel = blocks::canvas(&mut b.sel, "chart/vitals", "chart:vitals");
        let mlabel = metric_label(&metric);
        let series = if points.is_empty() {
            Vec::new()
        } else {
            vec![wire::RoomChartSeries {
                id: metric.clone(),
                label: mlabel.clone(),
                hue_key: "app.health".to_owned(),
                mark: wire::RoomChartMark::Point as i32,
                stack: String::new(),
                points: points.clone(),
            }]
        };
        blocks_out.push(blocks::chart(wire::RoomChart {
            selector_id: chart_sel,
            summary: fill(&words::vitals_chart_summary(EN), &[("metric", &mlabel)]),
            series,
            x_ticks: points
                .iter()
                .map(|p| wire::RoomChartTick {
                    at: p.x,
                    label: p.x_label.clone(),
                })
                .collect(),
            y_ticks: Vec::new(),
            rules: Vec::new(),
            readout_point_id: self.readout_point_id.clone(),
            empty_sentence: fill(&words::vitals_chart_empty(EN), &[("metric", &mlabel)]),
        }));

        if page.rows.is_empty() {
            blocks_out.push(blocks::empty(
                glyph("Pulse", "app.health"),
                &words::vitals_empty_title(EN),
                &words::vitals_empty_body(EN),
                Some(blocks::action(
                    &mut b.sel,
                    "empty/reading",
                    &words::reading_add(EN),
                    "Add",
                    Handler::Open(NEW_READING.to_owned()),
                )),
            ));
        } else {
            let rows: Vec<wire::RoomBlock> = page
                .rows
                .iter()
                .map(|r| {
                    let formatted = fmt_metric_value(units, &r.metric, &r.unit, r.value, r.value2);
                    let meta = match r.context.as_deref() {
                        Some(ctx) => format!("{} · {ctx}", &r.at[..10.min(r.at.len())]),
                        None => r.at[..10.min(r.at.len())].to_owned(),
                    };
                    blocks::row(
                        &mut b.sel,
                        &format!("reading/{}", r.id),
                        &formatted,
                        Handler::Open(format!("health/reading/{}/edit", r.id)),
                    )
                    .meta(&meta)
                    .swipe(
                        &mut b.sel,
                        &format!("reading/{}/swipe", r.id),
                        &shared::trash_move(EN),
                        Handler::Act(Act::new("entity.trash", json!({ "ids": [r.id] }))),
                    )
                    .into_block()
                })
                .collect();
            let mut section = blocks::section(&mut b.sel, "section/readings", &mlabel).blocks(rows);
            if page.next.is_some() {
                section = section.next_page(&mut b.sel, "section/readings/next");
            }
            blocks_out.push(section.into_block());
        }

        room(wire::RoomKind::AppPlace, VITALS)
            .title(&words::vitals_title(EN))
            .key(
                &mut b.sel,
                "key/add",
                wire::RoomKeyRole::Add,
                "Add",
                &words::reading_add(EN),
                Handler::Open(NEW_READING.to_owned()),
            )
            .band(health_band(b, VITALS))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if let Some(outcome) = handle_band_nav(e, tag) {
            return outcome;
        }
        match tag {
            "vital:pick" => {
                if let Input::Option(code) = input {
                    self.selected_metric = Some(code.clone());
                    self.loaded = 0;
                    self.readout_point_id.clear();
                }
            }
            "chart:vitals" => {
                if let Input::Canvas(wire::room_canvas_event::Kind::ChartScrub(scrub)) = input {
                    self.readout_point_id.clone_from(&scrub.point_id);
                }
            }
            "next_page" => {
                self.loaded = self.page_size().saturating_add(50);
            }
            _ => {}
        }
        Outcome::default()
    }
}

struct ReadingForm {
    id: Option<String>,
    metric: String,
    loaded: bool,
    dirty: bool,
    expected_rev: Option<i64>,
}

impl ReadingForm {
    fn new_reading() -> Self {
        Self {
            id: None,
            metric: "weight_kg".to_owned(),
            loaded: false,
            dirty: false,
            expected_rev: None,
        }
    }

    fn edit_reading(id: String) -> Self {
        Self {
            id: Some(id),
            metric: "weight_kg".to_owned(),
            loaded: false,
            dirty: false,
            expected_rev: None,
        }
    }
}

impl RoomScreen for ReadingForm {
    fn key(&self) -> String {
        match &self.id {
            Some(id) => format!("health/reading/{id}/edit"),
            None => NEW_READING.to_owned(),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let units = member_units(b.door);
        if !self.loaded {
            if let Some(id) = &self.id {
                if let Ok(ans) = b.run(&reads::READING_BY_ID, &Args::new().text("id", id))
                    && let Some(r) = ans.rows.into_iter().next()
                {
                    self.metric = r.metric.clone();
                    let display_val = match (units, r.unit.as_str()) {
                        (Units::Imperial, "kg") => r.value * 2.204_622_621_8,
                        (Units::Imperial, "degC") => r.value * 9.0 / 5.0 + 32.0,
                        _ => r.value,
                    };
                    b.ui.fields.get_or("value", &fmt_num(display_val));
                    if let Some(v2) = r.value2 {
                        b.ui.fields.get_or("value2", &fmt_num(v2));
                    }
                    b.ui.fields.get_or("at", &r.at);
                    b.ui.fields
                        .get_or("context", r.context.as_deref().unwrap_or_default());
                }
                if let Ok(rev) = b.run(&entity_reads::REVISION_HEAD, &Args::new().text("id", id))
                    && let Some(head) = rev.rows.first()
                {
                    self.expected_rev = Some(head.seq);
                }
            } else {
                let now_iso = centraid_vault::clock::format_iso_ms(b.door.now_ms());
                b.ui.fields.get_or("at", &now_iso);
            }
            self.loaded = true;
        }

        let mut blocks_out = Vec::new();
        if self.id.is_none() {
            let options: Vec<wire::RoomOption> = VITAL_METRICS
                .iter()
                .map(|code| blocks::option(code, &metric_label(code), *code == self.metric))
                .collect();
            blocks_out.push(blocks::choice_block(blocks::choice(
                &mut b.sel,
                "choice/metric",
                &words::reading_metric_label(EN),
                wire::RoomChoiceStyle::Segmented,
                false,
                options,
                "reading:metric",
            )));
        }

        let mut form_fields = vec![
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "value",
                &words::reading_value_label(EN),
                wire::RoomTextKind::Number,
                "",
                32,
            )
            .focused()
            .build(),
        ];
        if self.metric == "blood_pressure" {
            form_fields.push(
                form::text(
                    &mut b.sel,
                    &mut b.ui.fields,
                    "value2",
                    &words::reading_value2_label(EN),
                    wire::RoomTextKind::Number,
                    "",
                    32,
                )
                .build(),
            );
        }
        form_fields.push(
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "at",
                &words::reading_at_label(EN),
                wire::RoomTextKind::Line,
                "",
                64,
            )
            .build(),
        );
        form_fields.push(
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "context",
                &words::reading_context_label(EN),
                wire::RoomTextKind::Line,
                "",
                120,
            )
            .build(),
        );

        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("reading:save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
                save_enabled: true,
                dirty: self.dirty,
                drafted: false,
            },
        );
        blocks_out.push(form::form(form_fields, Vec::new(), Save::Explicit(save)));

        let title = if self.id.is_some() {
            words::reading_edit(EN)
        } else {
            words::reading_add(EN)
        };
        room(wire::RoomKind::Editor, &self.key())
            .title(&title)
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if tag == "reading:metric" {
            if let Input::Option(code) = input {
                self.metric = code.clone();
                self.dirty = true;
            }
            return Outcome::default();
        }
        if matches!(input, Input::Text(_)) {
            self.dirty = true;
            return Outcome::default();
        }
        if tag != "reading:save" {
            return Outcome::default();
        }
        let units = member_units(e.door);
        let raw_val =
            e.ui.fields
                .value("value")
                .unwrap_or_default()
                .trim()
                .to_owned();
        let Ok(parsed_val) = raw_val.parse::<f64>() else {
            return Outcome::refuse(&words::invalid_number(EN));
        };
        let stored_val = match (units, self.metric.as_str()) {
            (Units::Imperial, "weight_kg") => parsed_val / 2.204_622_621_8,
            (Units::Imperial, "body_temp_c") => (parsed_val - 32.0) * 5.0 / 9.0,
            _ => parsed_val,
        };
        let at =
            e.ui.fields
                .value("at")
                .unwrap_or_default()
                .trim()
                .to_owned();
        let mut obj = Map::new();
        obj.insert("at".to_owned(), Value::String(at));
        obj.insert("value".to_owned(), json!(stored_val));
        if self.metric == "blood_pressure" {
            let raw_v2 =
                e.ui.fields
                    .value("value2")
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
            let Ok(v2) = raw_v2.parse::<f64>() else {
                return Outcome::refuse(&words::reading_bp_needs_both(EN));
            };
            obj.insert("value2".to_owned(), json!(v2));
        }
        let ctx =
            e.ui.fields
                .value("context")
                .unwrap_or_default()
                .trim()
                .to_owned();
        if !ctx.is_empty() {
            obj.insert("context".to_owned(), Value::String(ctx));
        }
        let act = if let Some(id) = &self.id {
            obj.insert("id".to_owned(), Value::String(id.clone()));
            if let Some(rev) = self.expected_rev {
                obj.insert("expected_rev".to_owned(), json!(rev));
            }
            Act::new("reading.edit", Value::Object(obj))
        } else {
            obj.insert("metric".to_owned(), Value::String(self.metric.clone()));
            Act::new("reading.add", Value::Object(obj))
        };
        match e.door.act(&act) {
            Ok(_) => Outcome::pop(),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

struct WorkoutKindsRoom;

impl RoomScreen for WorkoutKindsRoom {
    fn key(&self) -> String {
        KINDS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let kinds = match b.run(&reads::WORKOUT_KINDS, &Args::new()) {
            Ok(ans) => ans.rows,
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, KINDS)
                    .title(&words::kinds_title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let blocks_out = if kinds.is_empty() {
            vec![blocks::empty(
                glyph("Activity", "app.health"),
                &words::kinds_empty_title(EN),
                &words::kinds_empty_body(EN),
                None,
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = kinds
                .iter()
                .map(|k| {
                    let count = b
                        .run(
                            &reads::WORKOUT_COUNT_BY_TYPE,
                            &Args::new().text("type_id", &k.id),
                        )
                        .ok()
                        .and_then(|a| a.rows.into_iter().next())
                        .unwrap_or(0);
                    let meta = words::kind_workouts(EN, u64::try_from(count).unwrap_or(0));
                    let menu = blocks::menu(
                        &format!("kind/{}/menu", k.id),
                        vec![blocks::menu_section(
                            "",
                            vec![
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("kind/{}/rename", k.id),
                                    &words::kind_rename(EN),
                                    Handler::Open(format!("health/kind/{}/rename", k.id)),
                                ),
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("kind/{}/merge", k.id),
                                    &words::kind_merge(EN),
                                    Handler::Open(format!("health/kind/{}/merge", k.id)),
                                ),
                            ],
                        )],
                        &mut b.sel,
                    );
                    blocks::row(
                        &mut b.sel,
                        &format!("kind/{}", k.id),
                        &k.title,
                        Handler::Open(format!("health/kind/{}/rename", k.id)),
                    )
                    .meta(&meta)
                    .menu(menu)
                    .into_block()
                })
                .collect();
            vec![
                blocks::section(&mut b.sel, "section/kinds", &words::kinds_title(EN))
                    .blocks(rows)
                    .into_block(),
            ]
        };

        room(wire::RoomKind::PushedPage, KINDS)
            .title(&words::kinds_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }
}

struct WorkoutKindRenameForm {
    id: String,
    loaded: bool,
}

impl WorkoutKindRenameForm {
    fn new(id: String) -> Self {
        Self { id, loaded: false }
    }
}

impl RoomScreen for WorkoutKindRenameForm {
    fn key(&self) -> String {
        format!("health/kind/{}/rename", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.loaded {
            if let Ok(ans) = b.run(&entity_reads::META_BY_ID, &Args::new().text("id", &self.id))
                && let Some(meta) = ans.rows.into_iter().next()
            {
                b.ui.fields.get_or("name", &meta.title);
            }
            self.loaded = true;
        }
        let field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "name",
            &words::kind_name_label(EN),
            wire::RoomTextKind::Line,
            "",
            40,
        )
        .focused()
        .build();
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("kind:rename".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
                save_enabled: true,
                dirty: true,
                drafted: false,
            },
        );
        let form_block = form::form(vec![field], Vec::new(), Save::Explicit(save));
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::kind_rename_title(EN))
            .ready(vec![form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag != "kind:rename" {
            return Outcome::default();
        }
        let name =
            e.ui.fields
                .value("name")
                .unwrap_or_default()
                .trim()
                .to_owned();
        if name.is_empty() {
            return Outcome::refuse(&shared::write_refused(EN));
        }
        match e.door.act(&Act::new(
            "entity.retitle",
            json!({ "id": self.id, "title": name }),
        )) {
            Ok(_) => Outcome::pop(),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

struct WorkoutKindMergePick {
    id: String,
}

impl RoomScreen for WorkoutKindMergePick {
    fn key(&self) -> String {
        format!("health/kind/{}/merge", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let kinds = b
            .run(&reads::WORKOUT_KINDS, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        let rows: Vec<wire::RoomBlock> = kinds
            .iter()
            .filter(|k| k.id != self.id)
            .map(|k| {
                blocks::row(
                    &mut b.sel,
                    &format!("target/{}", k.id),
                    &k.title,
                    Handler::Open(format!("health/kind/{}/merge/{}", self.id, k.id)),
                )
                .into_block()
            })
            .collect();
        room(wire::RoomKind::PushedPage, &self.key())
            .title(&words::kind_merge_pick_title(EN))
            .back(&mut b.sel, &words::kinds_title(EN))
            .ready(vec![
                blocks::section(
                    &mut b.sel,
                    "section/targets",
                    &words::kind_merge_pick_title(EN),
                )
                .blocks(rows)
                .into_block(),
            ])
            .build()
    }
}

struct WorkoutKindMergeConfirm {
    from: String,
    into: String,
}

impl RoomScreen for WorkoutKindMergeConfirm {
    fn key(&self) -> String {
        format!("health/kind/{}/merge/{}", self.from, self.into)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let from_title = b
            .run(
                &entity_reads::META_BY_ID,
                &Args::new().text("id", &self.from),
            )
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|m| m.title)
            .unwrap_or_else(|| self.from.clone());
        let into_title = b
            .run(
                &entity_reads::META_BY_ID,
                &Args::new().text("id", &self.into),
            )
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|m| m.title)
            .unwrap_or_else(|| self.into.clone());
        let body = fill(
            &words::kind_merge_body(EN),
            &[("from", &from_title), ("into", &into_title)],
        );
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::kind_merge_title(EN),
                body: &body,
                warning: "",
                confirm_label: &words::kind_merge_confirm(EN),
                confirm: Handler::Tag("kind:merge".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::kind_merge_title(EN))
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag != "kind:merge" {
            return Outcome::default();
        }
        match e.door.act(&Act::new(
            "concept.merge",
            json!({ "from": self.from, "into": self.into }),
        )) {
            Ok(_) => Outcome::replace(KINDS),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

#[derive(Default)]
struct HealthTrash {
    loaded: usize,
}

impl HealthTrash {
    fn page_size(&self) -> usize {
        if self.loaded == 0 { 50 } else { self.loaded }
    }
}

impl RoomScreen for HealthTrash {
    fn key(&self) -> String {
        TRASH.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let page = match b.reload(&reads::TRASH, &Args::new(), self.page_size()) {
            Ok(ans) => ans,
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, TRASH)
                    .title(&shared::trash_title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let count = page.rows.len() as u64;
        let heading = if count == 0 {
            shared::trash_title(EN)
        } else {
            shared::trash_count(EN, count)
        };
        let blocks_out = if page.rows.is_empty() {
            vec![blocks::empty(
                glyph("Trash", ""),
                &shared::trash_empty_headline(EN),
                &shared::trash_empty_state_body(EN),
                None,
            )]
        } else {
            let rows: Vec<wire::RoomTrashRow> = page
                .rows
                .iter()
                .map(|item| {
                    let title = if item.title.is_empty() {
                        shared::trash_untitled(EN)
                    } else {
                        item.title.clone()
                    };
                    let meta = format!(
                        "{} {} · {} {}",
                        shared::trash_deleted(EN),
                        &item.deleted_at[..10.min(item.deleted_at.len())],
                        shared::trash_erased(EN),
                        &item.purge_at[..10.min(item.purge_at.len())],
                    );
                    blocks::trash_row(
                        &mut b.sel,
                        &format!("trash/{}", item.id),
                        &title,
                        &meta,
                        Handler::Act(Act::new("entity.restore", json!({ "ids": [item.id] }))),
                        Handler::Open(format!("health/trash/purge/{}", item.id)),
                    )
                })
                .collect();
            let empty_action = Some(blocks::destructive(
                &mut b.sel,
                "trash/empty",
                &shared::trash_empty_action(EN),
                "Trash",
                Handler::Open("health/trash/empty".to_owned()),
            ));
            let mut trash =
                blocks::trash(&heading, &shared::trash_entry_meta(EN), rows, empty_action);
            if page.next.is_some() {
                trash.next_page_selector_id = b
                    .sel
                    .on("trash/next", Handler::NextPage("trash".to_owned()));
            }
            vec![blocks::trash_block(trash)]
        };
        room(wire::RoomKind::PushedPage, TRASH)
            .title(&heading)
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, _: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "next_page" {
            self.loaded = self.page_size().saturating_add(50);
        }
        Outcome::default()
    }
}

struct PurgeConfirm {
    id: String,
}

impl RoomScreen for PurgeConfirm {
    fn key(&self) -> String {
        format!("health/trash/purge/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let title = fill(
            &shared::trash_purge_title(EN),
            &[("noun", &shared::trash_noun_workout(EN))],
        );
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &title,
                body: &words::trash_purge_body(EN),
                warning: "",
                confirm_label: &shared::trash_purge(EN),
                confirm: Handler::Tag("purge:confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&title)
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag != "purge:confirm" {
            return Outcome::default();
        }
        match e
            .door
            .act(&Act::new("entity.purge", json!({ "id": self.id })))
        {
            Ok(_) => Outcome::pop(),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

struct EmptyTrashConfirm;

impl RoomScreen for EmptyTrashConfirm {
    fn key(&self) -> String {
        "health/trash/empty".to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &shared::trash_empty_title(EN),
                body: &shared::trash_empty_body(EN),
                warning: "",
                confirm_label: &shared::trash_empty_action(EN),
                confirm: Handler::Tag("empty:confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&shared::trash_empty_title(EN))
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag != "empty:confirm" {
            return Outcome::default();
        }
        match e.door.act(&Act::new(
            "entity.empty_trash",
            json!({ "kinds": ["workout", "reading"] }),
        )) {
            Ok(_) => Outcome::pop(),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}
