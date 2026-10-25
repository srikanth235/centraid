//! THE HEALTH STORE → HEALTH (#1129, #1135): one way, store → vault (R-1127-1,
//! R-1129-7). A pass reads the window the vault implies (R-1129-4), sends the day
//! totals that changed (`record-days`, R-1129-3) and follows the workouts
//! (`follow-workouts`).
//!
//! The store is read by the shell (HealthKit, Health Connect), which performs a
//! [`wire::HealthRead`] effect and answers a [`wire::HealthSnapshot`]. Everything
//! else is decided here: what is sent, how a workout is identified and kinded,
//! when a read may judge a workout gone, and when a pass runs.
//!
//! ## A workout's identity
//!
//! Its source id is `local:<store id>` on this device: the store's id means
//! something on this phone only (R-1127-10), so the vault matches a workout a new
//! phone sends by its kind and its start to the minute, and relinks the row it
//! already holds rather than adding a second one (R-1129-15). One origin per
//! store: `store:apple-health` labelled "Apple Health", `store:health-connect`
//! labelled "Health Connect".
//!
//! ## Who decides what a pass leaves behind
//!
//! The vault. A workout gone from a complete read keeps its row and loses its
//! source (R-1129-14), only for workouts dated inside the window the pass read
//! (`since`), and a pass never deletes one. There is no fingerprint here, no link
//! and nothing to detach: this states what the store holds and the vault merges
//! it.
//!
//! ## The phone's habit
//!
//! Whether THIS device went through Connect, and the types the member chose, are
//! a keychain habit ([`DEVICE_KEY`]), never a vault row: HealthKit hides a read
//! grant, so the only way to know the member chose is to have kept it (R-1129-6).
//! **A pass never asks the OS for permission and never runs before this device
//! connected** (R-1127-15). A vault restored onto a new phone is connected there
//! once.

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use serde_json::{Value, json};
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

use super::{Metric, Store, kinds};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::civil;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::strings::{fill, health as words};

/// The keychain key that holds this device's Health habit: `1|steps,workouts`
/// when connected, `0|...` after Stop (the choices are kept, so Connect opens on
/// them).
pub const DEVICE_KEY: &str = "health_device";

/// The most values one `record-days` carries (the command's own ceiling is 4,000).
pub const BATCH: usize = 2_000;

const SECOND_MS: i64 = 1_000;
const DAY_MS: i64 = 86_400_000;

/// One day's total as the store states it.
#[derive(Clone, Debug, PartialEq)]
pub struct DayTotal {
    pub day: String,
    pub metric: String,
    pub value: f64,
}

/// THE WINDOW A PASS READS (R-1129-4), derived from what the vault holds and
/// never stored.
#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub today: String,
    pub totals_from: String,
    pub workouts_from: String,
    /// The instant `workouts_from` begins on this phone, epoch milliseconds.
    pub workouts_since_ms: i64,
    /// Every day the vault holds from `totals_from` on.
    pub held: Vec<DayTotal>,
}

/// The window the next pass reads, as the core placed it in the device's zone out
/// of what the vault holds now. `None` when the vault would not say.
pub fn window(ctx: &Ctx) -> Option<Window> {
    let Reading::Data(view) = read::read(ctx, load::health::FollowView {}, |answer| match answer {
        Answer::HealthFollowView(view) => Some(view),
        _ => None,
    }) else {
        return None;
    };
    let held = view
        .days
        .iter()
        .filter_map(|day| {
            Some(DayTotal {
                day: day.day.clone(),
                metric: Metric::of_wire(day.metric)?.key().to_owned(),
                value: day.value,
            })
        })
        .collect();
    Some(Window {
        workouts_since_ms: epoch_ms_of(&view.workouts_since)?,
        today: view.today,
        totals_from: view.totals_from,
        workouts_from: view.workouts_from,
        held,
    })
}

/// Epoch milliseconds of an RFC 3339 instant (`2026-10-15T07:10:00.5Z`,
/// `…+02:00`), or `None` for one the vault would refuse.
#[must_use]
pub fn epoch_ms_of(instant: &str) -> Option<i64> {
    let instant = instant.trim();
    let (date, rest) = instant.split_once(['T', 't'])?;
    let day = civil::epoch_day_of(date)?;
    let (clock, offset_ms) = if let Some(clock) = rest.strip_suffix(['Z', 'z']) {
        (clock, 0)
    } else {
        let at = rest.rfind(['+', '-'])?;
        let (clock, offset) = rest.split_at(at);
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        let (hours, minutes) = offset[1..].split_once(':')?;
        (
            clock,
            sign * (hours.parse::<i64>().ok()? * 60 + minutes.parse::<i64>().ok()?) * 60_000,
        )
    };
    let mut parts = clock.splitn(3, ':');
    let hours: i64 = parts.next()?.parse().ok()?;
    let minutes: i64 = parts.next()?.parse().ok()?;
    let seconds = parts.next()?;
    let (whole, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    let whole: i64 = whole.parse().ok()?;
    let millis: i64 = format!("{fraction:0<3}")[..3].parse().ok()?;
    if !(0..24).contains(&hours) || !(0..60).contains(&minutes) || !(0..61).contains(&whole) {
        return None;
    }
    Some(day * DAY_MS + ((hours * 60 + minutes) * 60 + whole) * SECOND_MS + millis - offset_ms)
}

/// `YYYY-MM-DDTHH:MM:SS.sssZ` for `epoch_ms`: the form the vault holds an instant in.
#[must_use]
pub fn instant_of(epoch_ms: i64) -> String {
    let day = epoch_ms.div_euclid(DAY_MS);
    let within = epoch_ms.rem_euclid(DAY_MS);
    let (seconds, millis) = (within / SECOND_MS, within % SECOND_MS);
    format!(
        "{}T{:02}:{:02}:{:02}.{millis:03}Z",
        civil::civil_day_of(day),
        seconds / 3_600,
        (seconds / 60) % 60,
        seconds % 60
    )
}

/// A REAL IN ITS ONE CANONICAL TEXT FORM: rounded to three places, trailing
/// zeros and a bare point dropped (`5234.567`, `5234.5`, `5234`). Three decimals
/// of a metre, a kilocalorie or a metre of climb is below anything a store
/// measures.
#[must_use]
pub fn number(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    #[allow(clippy::cast_possible_truncation)]
    let scaled = (value.abs() * 1_000.0 + 0.5).floor() as i64;
    let (whole, fraction) = (scaled / 1_000, scaled % 1_000);
    let mut text = if fraction == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{fraction:03}")
            .trim_end_matches('0')
            .to_owned()
    };
    if value < 0.0 && scaled != 0 {
        text.insert(0, '-');
    }
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

/// THE PURE HALF OF A DAYS PASS: the store's totals against the vault's, in; the
/// changed set, out. Days bypass `phone_link` (R-1129-3): the store gives a day no
/// identity, so the window re-read is what corrects a late watch upload, and a day
/// is never deleted.
///
/// - **Only what changed is sent.** A value the vault holds bit for bit is not
///   sent again, so a second pass over the same store sends nothing (R-1088-12).
/// - **The zero rule.** A SUM metric the store now reports nothing for, on a day
///   the vault holds a non-zero value, is sent as 0: a deleted sample corrects the
///   day. **Only for a metric the store answered at all in this read** (RP-K-3):
///   HealthKit hides a revoked read, so a type the member turned off reads as
///   nothing on every day, and zeroing a week for it would turn a permission into
///   a deletion. A LAST or AVERAGE metric is never cleared.
/// - Only days inside the window, real calendar days, known metrics and finite,
///   non-negative values are sent; a day the store states twice keeps its last
///   statement, since `record-days` refuses a batch naming one (day, metric)
///   twice (RP-R-5).
#[must_use]
pub fn changes(read: &[DayTotal], held: &[DayTotal], from: &str, today: &str) -> Vec<DayTotal> {
    let in_window = |day: &str| civil::epoch_day_of(day).is_some() && day >= from && day <= today;
    let mut stated: Vec<((String, String), f64)> = Vec::new();
    for total in read {
        if !in_window(&total.day)
            || Metric::of_key(&total.metric).is_none()
            || !total.value.is_finite()
            || total.value < 0.0
        {
            continue;
        }
        let key = (total.day.clone(), total.metric.clone());
        match stated.iter_mut().find(|(known, _)| *known == key) {
            Some((_, value)) => *value = total.value,
            None => stated.push((key, total.value)),
        }
    }
    let vault: BTreeMap<(&str, &str), f64> = held
        .iter()
        .map(|total| ((total.day.as_str(), total.metric.as_str()), total.value))
        .collect();
    let mut out = Vec::new();
    for ((day, metric), value) in &stated {
        let was = vault.get(&(day.as_str(), metric.as_str()));
        if was.is_none_or(|was| was.to_bits() != value.to_bits()) {
            out.push(DayTotal {
                day: day.clone(),
                metric: metric.clone(),
                value: *value,
            });
        }
    }
    let answered: Vec<&str> = stated
        .iter()
        .map(|((_, metric), _)| metric.as_str())
        .collect();
    for ((day, metric), was) in &vault {
        let Some(known) = Metric::of_key(metric) else {
            continue;
        };
        if !known.sum() || !answered.contains(metric) || !in_window(day) {
            continue;
        }
        let stated_here = stated
            .iter()
            .any(|((d, m), _)| d.as_str() == *day && m.as_str() == *metric);
        if !stated_here && *was != 0.0 {
            out.push(DayTotal {
                day: (*day).to_owned(),
                metric: (*metric).to_owned(),
                value: 0.0,
            });
        }
    }
    out.sort_by(|a, b| {
        (&a.day, Metric::of_key(&a.metric).map(|m| m as usize))
            .cmp(&(&b.day, Metric::of_key(&b.metric).map(|m| m as usize)))
    });
    out
}

/// Whitespace runs (and no-break spaces) become one space; the ends go.
fn squash(value: &str) -> String {
    value
        .split(|c: char| c.is_whitespace() || c == '\u{a0}')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// ONE WORKOUT AS THE RECORD THE VAULT FOLLOWS, or `None` for one it should not
/// be told of: no id, no kind, an end before its start or a start before the
/// window.
#[must_use]
pub fn record(
    workout: &wire::HealthPhoneWorkout,
    device: &str,
    window_start_ms: i64,
) -> Option<Value> {
    let started = epoch_ms_of(&workout.started_at)?;
    let ended = epoch_ms_of(&workout.ended_at)?;
    let id = workout.id.trim();
    if id.is_empty()
        || workout.kind.trim().is_empty()
        || ended < started
        || started < window_start_ms
    {
        return None;
    }
    let mut measures = serde_json::Map::new();
    if let Some(by) = workout
        .recorded_by
        .as_deref()
        .map(squash)
        .filter(|by| !by.is_empty())
    {
        measures.insert("recorded_by".to_owned(), json!(by));
    }
    if let Some(moving) = workout.moving_sec.filter(|moving| *moving > 0) {
        measures.insert("moving_s".to_owned(), json!(moving));
    }
    let real = |value: Option<f64>| value.filter(|v| v.is_finite() && *v >= 0.0).map(number);
    if let Some(value) = real(workout.distance_m) {
        measures.insert("distance_m".to_owned(), value);
    }
    if let Some(value) = real(workout.energy_kcal) {
        measures.insert("energy_kcal".to_owned(), value);
    }
    if let Some(bpm) = workout.avg_hr_bpm.filter(|bpm| *bpm > 0) {
        measures.insert("heart_bpm".to_owned(), json!(bpm));
    }
    if let Some(value) = real(workout.elevation_gain_m) {
        measures.insert("climb_m".to_owned(), value);
    }
    Some(json!({
        "external_id": format!("local:{id}"),
        "device_id": device,
        "fields": {
            "kind": kinds::key(&workout.kind),
            "starts": instant_of(started),
            "ends": instant_of(ended),
            "workout": measures,
        },
    }))
}

/// A store's origin as `follow-workouts` takes it.
fn origin(locale: crate::strings::Locale, store: Store, device: &str) -> Option<Value> {
    Some(json!({
        "ref": store.origin()?,
        "label": store.name(locale),
        "device_id": device,
    }))
}

/// `follow-workouts`' input for a read: the store's origin and the workouts it
/// holds. **Complete only when the read says so, it found at least one workout,
/// and the member chose workouts and the OS allowed them** (R-1129-5): otherwise
/// nothing is judged gone. A store no longer on the phone sends no workouts and is
/// not complete.
#[must_use]
pub fn follow_input(
    locale: crate::strings::Locale,
    snapshot: &wire::HealthSnapshot,
    window: &Window,
    chosen: &[String],
    device: &str,
) -> Option<(Value, Vec<Value>, bool)> {
    let store = Store::of_snapshot(snapshot);
    let origin = origin(locale, store, device)?;
    let records: Vec<Value> = if snapshot.store_present {
        let mut seen = Vec::new();
        snapshot
            .workouts
            .iter()
            .filter(|workout| {
                let id = workout.id.trim().to_owned();
                let fresh = !seen.contains(&id);
                seen.push(id);
                fresh
            })
            .filter_map(|workout| record(workout, device, window.workouts_since_ms))
            .collect()
    } else {
        Vec::new()
    };
    let allowed = chosen.iter().any(|key| key == Metric::WORKOUTS)
        && !snapshot.refused.iter().any(|key| key == Metric::WORKOUTS);
    let complete =
        snapshot.store_present && snapshot.workouts_complete && allowed && !records.is_empty();
    Some((origin, records, complete))
}

/// What one pass did. `read` is false when the vault refused the follow and
/// nothing past the days was done.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub days: usize,
    pub added: u64,
    pub updated: u64,
    pub forgotten: u64,
    pub refused: usize,
    pub read: bool,
}

fn count(output: &Value, name: &str) -> u64 {
    output.get(name).and_then(Value::as_u64).unwrap_or(0)
}

fn key(name: &str, part: &str) -> String {
    kit_act::key(&[name, part], kit_act::fresh())
}

/// ONE PASS over `snapshot` for `window`: the days that changed, then the
/// workouts. A store no longer on the phone sends no days (there is nothing to
/// read them from) and no workouts.
pub fn run(
    ctx: &Ctx,
    snapshot: &wire::HealthSnapshot,
    window: &Window,
    chosen: &[String],
    device: &str,
) -> Outcome {
    let mut outcome = Outcome::default();
    if snapshot.store_present {
        let read: Vec<DayTotal> = snapshot
            .days
            .iter()
            .map(|day| DayTotal {
                day: day.day.clone(),
                metric: day.metric.clone(),
                value: day.value,
            })
            .collect();
        for batch in changes(&read, &window.held, &window.totals_from, &window.today).chunks(BATCH)
        {
            let days: Vec<Value> = batch
                .iter()
                .map(
                    |total| json!({"day": total.day, "metric": total.metric, "value": total.value}),
                )
                .collect();
            let request = act::health::RecordDays {
                days: Value::Array(days).to_string(),
                person_id: None,
            };
            if kit_act::act(ctx, request, &key("record-days", &window.today)).committed {
                outcome.days += batch.len();
            } else {
                outcome.refused += batch.len();
            }
        }
    }
    let Some((origin, records, complete)) =
        follow_input(ctx.locale(), snapshot, window, chosen, device)
    else {
        outcome.refused += 1;
        return outcome;
    };
    let request = act::health::FollowWorkouts {
        origin: origin.to_string(),
        records: Value::Array(records).to_string(),
        complete: Some(complete),
        since: Some(instant_of(window.workouts_since_ms)),
    };
    let settled = kit_act::act(ctx, request, &key("follow-workouts", &window.today));
    if !settled.committed {
        outcome.refused += 1;
        return outcome;
    }
    let output: Value = serde_json::from_slice(&settled.output).unwrap_or(Value::Null);
    outcome.read = true;
    outcome.added = count(&output, "added") + count(&output, "matched");
    outcome.updated = count(&output, "updated");
    outcome.forgotten = count(&output, "forgotten");
    outcome.refused += usize::try_from(count(&output, "refused")).unwrap_or(0);
    outcome
}

/// CONNECT: the store's origin is written at once (a follow of no workouts) —
/// that is what makes Health followed (R-1127-14) — and the first pass runs (a
/// year of days, 90 days of workouts, R-1129-4). `None` when the vault refused the
/// origin.
pub fn connect(
    ctx: &Ctx,
    snapshot: &wire::HealthSnapshot,
    window: &Window,
    chosen: &[String],
    device: &str,
) -> Option<Outcome> {
    let origin = origin(ctx.locale(), Store::of_snapshot(snapshot), device)?;
    let request = act::health::FollowWorkouts {
        origin: origin.to_string(),
        records: "[]".to_owned(),
        complete: None,
        since: None,
    };
    if !kit_act::act(ctx, request, &key("follow-workouts", "origin")).committed {
        return None;
    }
    Some(run(ctx, snapshot, window, chosen, device))
}

/// STOP READING: every health origin is forgotten (`stop-following`). **Every
/// day and every workout stays**, an ordinary row from now on. `false` when the
/// vault refused part of it (the rest is done, and stopping again finishes it).
pub fn stop(ctx: &Ctx) -> bool {
    let mut clean = true;
    for store in Store::BOTH {
        let Some(origin) = store.origin() else {
            continue;
        };
        let request = act::health::StopFollowing {
            system: act::health::StopFollowingSystem::Health,
            r#ref: origin.to_owned(),
        };
        clean = kit_act::act(ctx, request, &key("stop-following", origin)).committed && clean;
    }
    clean
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/// What this phone remembers: whether it went through Connect, and the types the
/// member chose.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Device {
    /// The keychain has answered.
    pub loaded: bool,
    pub connected: bool,
    pub chosen: Vec<String>,
}

impl Device {
    fn decode(value: &[u8]) -> Self {
        let text = String::from_utf8_lossy(value);
        let (flag, keys) = text.split_once('|').unwrap_or(("0", ""));
        Self {
            loaded: true,
            connected: flag == "1",
            chosen: keys
                .split(',')
                .filter(|key| !key.is_empty())
                .map(str::to_owned)
                .collect(),
        }
    }

    fn encode(connected: bool, chosen: &[String]) -> Vec<u8> {
        format!("{}|{}", u8::from(connected), chosen.join(",")).into_bytes()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Purpose {
    /// The member's Connect tap: the OS may ask for permission.
    Connect(Vec<String>),
    /// A following pass: silent, and never asks.
    Pass,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Waiting {
    Nothing,
    /// The keychain's answer to "did this device connect?".
    Device,
    Read(Purpose),
}

/// THE CONNECT AND THE FOLLOW, as one component a screen hosts. The host sends it
/// the events it does not know ([`Self::on_event`]) and returns the effects it
/// hands back.
pub struct HealthFollow {
    waiting: Waiting,
    device: Device,
    window: Option<Window>,
    /// A pass runs as soon as the device says it connected.
    auto: bool,
    /// The chosen types the OS refused, as the last read said.
    refused: Vec<String>,
    /// Which store the last read named, when it named one.
    store: Option<Store>,
    outcome: Option<Outcome>,
    /// A failure's sentence, for Connect's status line.
    failure: Option<String>,
    /// Connect ran to the end.
    connected_now: bool,
}

impl HealthFollow {
    /// A flow that follows on its own once the device has said it connected.
    #[must_use]
    pub fn following() -> Self {
        Self::new(true)
    }

    /// A flow that only connects, when asked.
    #[must_use]
    pub fn connecting() -> Self {
        Self::new(false)
    }

    fn new(auto: bool) -> Self {
        Self {
            waiting: Waiting::Nothing,
            device: Device::default(),
            window: None,
            auto,
            refused: Vec::new(),
            store: None,
            outcome: None,
            failure: None,
            connected_now: false,
        }
    }

    /// The host came up: learn what this phone remembers. Asked once.
    pub fn attach(&mut self) -> Vec<wire::Effect> {
        if self.device.loaded || self.waiting != Waiting::Nothing {
            return Vec::new();
        }
        self.waiting = Waiting::Device;
        vec![keychain(wire::keychain_op::Op::Get, Vec::new())]
    }

    /// Read what this phone remembers again: another screen (Connect) may have
    /// kept a new habit. Asked only when nothing is out.
    pub fn recheck_device(&mut self) -> Vec<wire::Effect> {
        if self.waiting != Waiting::Nothing {
            return Vec::new();
        }
        self.waiting = Waiting::Device;
        vec![keychain(wire::keychain_op::Op::Get, Vec::new())]
    }

    #[must_use]
    pub fn device(&self) -> &Device {
        &self.device
    }

    /// The chosen types the OS refused, as the last read said.
    #[must_use]
    pub fn refused(&self) -> &[String] {
        &self.refused
    }

    /// How the last pass ended.
    #[must_use]
    pub fn outcome(&self) -> Option<&Outcome> {
        self.outcome.as_ref()
    }

    /// The sentence Connect shows when it did not connect.
    #[must_use]
    pub fn failure(&self) -> Option<&str> {
        self.failure.as_deref()
    }

    /// The member changed a switch: the last failure's sentence goes.
    pub fn clear_failure(&mut self) {
        self.failure = None;
    }

    /// Connect ran to the end: the store is followed and the first read ran.
    #[must_use]
    pub fn connected_now(&self) -> bool {
        self.connected_now
    }

    /// Whether Connect's read is out (the OS is asking, or the first read runs).
    #[must_use]
    pub fn working(&self) -> bool {
        matches!(self.waiting, Waiting::Read(Purpose::Connect(_)))
    }

    /// Follow now, when this device connected and nothing is out. A pass never
    /// asks the OS for permission.
    pub fn request(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.waiting != Waiting::Nothing || !self.device.connected {
            return Vec::new();
        }
        let chosen = self.device.chosen.clone();
        self.start_read(ctx, Purpose::Pass, &chosen, false)
    }

    /// The member tapped Connect with `chosen` types on.
    pub fn connect(&mut self, ctx: &Ctx, chosen: Vec<String>) -> Vec<wire::Effect> {
        if self.waiting != Waiting::Nothing {
            return Vec::new();
        }
        self.failure = None;
        let keys = chosen.clone();
        let effects = self.start_read(ctx, Purpose::Connect(chosen), &keys, true);
        if effects.is_empty() {
            self.failure = Some(self.connect_failed(ctx));
        }
        effects
    }

    /// The member confirmed Stop: the store's origin is retired, every day and
    /// workout stays, and this phone forgets it connected (it keeps the choice).
    /// `None` when the vault refused part of it: the host says so.
    pub fn stop(&mut self, ctx: &Ctx) -> Option<Vec<wire::Effect>> {
        if !stop(ctx) {
            return None;
        }
        self.device.connected = false;
        self.refused.clear();
        Some(vec![keychain(
            wire::keychain_op::Op::Set,
            Device::encode(false, &self.device.chosen),
        )])
    }

    fn start_read(
        &mut self,
        ctx: &Ctx,
        purpose: Purpose,
        chosen: &[String],
        ask: bool,
    ) -> Vec<wire::Effect> {
        let Some(window) = window(ctx) else {
            return Vec::new();
        };
        let read = wire::HealthRead {
            chosen: chosen.to_vec(),
            ask_permission: ask,
            totals_from: window.totals_from.clone(),
            today: window.today.clone(),
            workouts_since_ms: window.workouts_since_ms,
        };
        self.window = Some(window);
        self.waiting = Waiting::Read(purpose);
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::HealthRead(read)),
        }]
    }

    /// Offer the host's event. `Some(effects)` when it was this flow's (the answer
    /// to an effect it asked); `None` otherwise.
    pub fn on_event(&mut self, event: &E, ctx: &Ctx) -> Option<Vec<wire::Effect>> {
        let E::EffectResult(result) = event else {
            return None;
        };
        use wire::effect_result::Outcome as O;
        match (self.waiting.clone(), &result.outcome) {
            (Waiting::Device, Some(O::Keychain(value))) => {
                self.waiting = Waiting::Nothing;
                self.device = if value.found {
                    Device::decode(&value.value)
                } else {
                    Device {
                        loaded: true,
                        ..Device::default()
                    }
                };
                Some(if self.auto {
                    self.request(ctx)
                } else {
                    Vec::new()
                })
            }
            (Waiting::Device, Some(O::Failed(_))) => {
                self.waiting = Waiting::Nothing;
                self.device.loaded = true;
                Some(Vec::new())
            }
            (Waiting::Read(purpose), Some(O::Health(snapshot))) => {
                Some(self.read_ended(ctx, &purpose, snapshot))
            }
            (Waiting::Read(purpose), Some(O::Failed(_))) => {
                self.waiting = Waiting::Nothing;
                if matches!(purpose, Purpose::Connect(_)) {
                    self.failure = Some(self.connect_failed(ctx));
                }
                Some(Vec::new())
            }
            _ => None,
        }
    }

    fn connect_failed(&self, ctx: &Ctx) -> String {
        let store = self.store.unwrap_or_else(|| Store::of(ctx));
        fill(
            &words::connect_failed(ctx.locale()),
            &[("store", &store.name(ctx.locale()))],
        )
    }

    fn read_ended(
        &mut self,
        ctx: &Ctx,
        purpose: &Purpose,
        snapshot: &wire::HealthSnapshot,
    ) -> Vec<wire::Effect> {
        self.waiting = Waiting::Nothing;
        self.store = Some(Store::of_snapshot(snapshot));
        let Some(window) = self.window.take() else {
            return Vec::new();
        };
        let locale = ctx.locale();
        match purpose {
            Purpose::Pass => {
                self.refused.clone_from(&snapshot.refused);
                let chosen = self.device.chosen.clone();
                self.outcome = Some(run(ctx, snapshot, &window, &chosen, &snapshot.device_id));
                Vec::new()
            }
            Purpose::Connect(chosen) => {
                if !snapshot.store_present {
                    self.failure = Some(if snapshot.installable {
                        words::connect_install(locale)
                    } else {
                        words::connect_unavailable(locale)
                    });
                    return Vec::new();
                }
                match connect(ctx, snapshot, &window, chosen, &snapshot.device_id) {
                    Some(outcome) => {
                        self.refused.clone_from(&snapshot.refused);
                        self.outcome = Some(outcome);
                        self.device = Device {
                            loaded: true,
                            connected: true,
                            chosen: chosen.clone(),
                        };
                        self.connected_now = true;
                        vec![keychain(
                            wire::keychain_op::Op::Set,
                            Device::encode(true, chosen),
                        )]
                    }
                    None => {
                        self.failure = Some(self.connect_failed(ctx));
                        Vec::new()
                    }
                }
            }
        }
    }
}

fn keychain(op: wire::keychain_op::Op, value: Vec<u8>) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::Keychain(wire::KeychainOp {
            op: op as i32,
            key: DEVICE_KEY.to_owned(),
            value,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: &str = "2026-10-20";

    fn total(day: &str, metric: &str, value: f64) -> DayTotal {
        DayTotal {
            day: day.to_owned(),
            metric: metric.to_owned(),
            value,
        }
    }

    fn changed(read: &[DayTotal], held: &[DayTotal]) -> Vec<DayTotal> {
        changes(read, held, "2026-10-13", TODAY)
    }

    #[test]
    fn only_what_changed_is_sent_a_value_the_vault_holds_bit_for_bit_is_not() {
        let held = [
            total("2026-10-18", "steps", 8_412.0),
            total("2026-10-19", "steps", 6_100.0),
        ];
        let read = [
            total("2026-10-18", "steps", 8_412.0),
            total("2026-10-19", "steps", 6_350.0),
            total("2026-10-20", "steps", 1_200.0),
        ];
        assert_eq!(
            changed(&read, &held),
            [
                total("2026-10-19", "steps", 6_350.0),
                total("2026-10-20", "steps", 1_200.0)
            ]
        );
    }

    #[test]
    fn a_second_pass_over_the_same_store_sends_nothing() {
        let read = [
            total("2026-10-19", "steps", 6_350.0),
            total("2026-10-19", "weight_kg", 71.4),
            total("2026-10-20", "sleep_min", 432.0),
        ];
        assert!(changed(&read, &read).is_empty());
    }

    #[test]
    fn a_sum_the_store_now_reports_nothing_for_where_the_vault_holds_one_is_sent_as_zero() {
        let held = [
            total("2026-10-17", "steps", 900.0),
            total("2026-10-18", "steps", 8_000.0),
            total("2026-10-16", "steps", 0.0),
        ];
        let read = [total("2026-10-18", "steps", 8_000.0)];
        assert_eq!(changed(&read, &held), [total("2026-10-17", "steps", 0.0)]);
    }

    #[test]
    fn a_metric_the_store_answered_nothing_for_at_all_is_never_zeroed() {
        // A revoked type is not a deletion (RP-K-3).
        let held = [
            total("2026-10-17", "steps", 900.0),
            total("2026-10-17", "sleep_min", 420.0),
        ];
        let read = [total("2026-10-18", "sleep_min", 400.0)];
        assert_eq!(
            changed(&read, &held),
            [
                total("2026-10-17", "sleep_min", 0.0),
                total("2026-10-18", "sleep_min", 400.0)
            ]
        );
    }

    #[test]
    fn a_last_value_or_average_metric_is_never_cleared() {
        let held = [
            total("2026-10-17", "weight_kg", 71.4),
            total("2026-10-17", "resting_hr_bpm", 58.0),
        ];
        let read = [
            total("2026-10-18", "weight_kg", 71.2),
            total("2026-10-18", "resting_hr_bpm", 57.0),
        ];
        assert_eq!(
            changed(&read, &held),
            [
                total("2026-10-18", "resting_hr_bpm", 57.0),
                total("2026-10-18", "weight_kg", 71.2)
            ]
        );
    }

    #[test]
    fn nothing_outside_the_window_no_unknown_metric_no_bad_value_and_a_day_stated_twice_keeps_its_last()
     {
        let read = [
            total("2026-10-01", "steps", 10.0),
            total("2026-10-21", "steps", 10.0),
            total("2026-02-30", "steps", 10.0),
            total("2026-10-19", "heart_rate", 60.0),
            total("2026-10-19", "steps", -1.0),
            total("2026-10-19", "exercise_min", f64::NAN),
            total("2026-10-19", "active_energy_kcal", 300.0),
            total("2026-10-19", "active_energy_kcal", 310.0),
        ];
        // A zero is only ever sent for a day inside the window, too.
        let held = [total("2026-10-01", "active_energy_kcal", 200.0)];
        assert_eq!(
            changed(&read, &held),
            [total("2026-10-19", "active_energy_kcal", 310.0)]
        );
    }

    #[test]
    fn instants_round_trip_and_offsets_are_honoured() {
        assert_eq!(epoch_ms_of("2026-10-15T07:10:00Z"), Some(1_792_048_200_000));
        assert_eq!(
            instant_of(epoch_ms_of("2026-10-15T07:40:00.5Z").unwrap()),
            "2026-10-15T07:40:00.500Z"
        );
        assert_eq!(
            epoch_ms_of("2026-10-15T09:10:00+02:00"),
            epoch_ms_of("2026-10-15T07:10:00Z")
        );
        assert_eq!(epoch_ms_of("not a time"), None);
        assert_eq!(epoch_ms_of("2026-02-30T00:00:00Z"), None);
    }

    #[test]
    fn numbers_are_canonical_integers_as_integers_reals_to_three_places() {
        assert_eq!(number(5_234.0).to_string(), "5234");
        assert_eq!(number(5_234.5).to_string(), "5234.5");
        assert_eq!(number(5_234.567_1).to_string(), "5234.567");
        assert_eq!(number(5_234.567_000_000_1).to_string(), "5234.567");
        assert_eq!(number(0.0004).to_string(), "0");
    }

    fn run_of(minute: i64, kind: &str, id: &str) -> wire::HealthPhoneWorkout {
        wire::HealthPhoneWorkout {
            id: id.to_owned(),
            kind: kind.to_owned(),
            started_at: format!("2026-10-15T07:{:02}:00Z", 10 + minute),
            ended_at: format!("2026-10-15T07:{:02}:00.5Z", 40 + minute),
            moving_sec: Some(1_800),
            distance_m: Some(5_234.567_1),
            energy_kcal: Some(338.0),
            avg_hr_bpm: Some(148),
            elevation_gain_m: Some(0.0),
            recorded_by: Some("  Apple   Watch ".to_owned()),
        }
    }

    fn since() -> i64 {
        epoch_ms_of("2026-10-13T00:00:00Z").unwrap()
    }

    #[test]
    fn a_workout_is_one_record_the_stores_id_on_this_device_the_vaults_kind_key_the_figures_as_stated()
     {
        let record = record(&run_of(0, "running", "run-0"), "device-a", since()).unwrap();
        assert_eq!(
            record,
            json!({
                "external_id": "local:run-0",
                "device_id": "device-a",
                "fields": {
                    "kind": "run",
                    "starts": "2026-10-15T07:10:00.000Z",
                    "ends": "2026-10-15T07:40:00.500Z",
                    "workout": {
                        "recorded_by": "Apple Watch",
                        "moving_s": 1800,
                        "distance_m": 5234.567,
                        "energy_kcal": 338,
                        "heart_bpm": 148,
                        "climb_m": 0,
                    },
                },
            })
        );
        // A word the table does not name rides as itself, for the vault to mint.
        let pilates = super::record(&run_of(0, "pilates", "p"), "d", since()).unwrap();
        assert_eq!(pilates["fields"]["kind"], "pilates");
    }

    #[test]
    fn a_workout_the_vault_should_not_be_told_of_is_left_out() {
        let mut after_end = run_of(3, "running", "run-3");
        after_end.ended_at = "2026-10-15T07:00:00Z".to_owned();
        let mut before_window = run_of(4, "running", "run-4");
        before_window.started_at = "2026-10-10T07:00:00Z".to_owned();
        before_window.ended_at = "2026-10-10T08:00:00Z".to_owned();
        for workout in [
            run_of(1, "running", " "),
            run_of(2, " ", "run-2"),
            after_end,
            before_window,
        ] {
            assert!(record(&workout, "d", since()).is_none(), "{workout:?}");
        }
    }

    fn snapshot(workouts: Vec<wire::HealthPhoneWorkout>) -> wire::HealthSnapshot {
        wire::HealthSnapshot {
            store: wire::health_snapshot::Store::AppleHealth as i32,
            store_present: true,
            workouts,
            workouts_complete: true,
            ..Default::default()
        }
    }

    fn window_of() -> Window {
        Window {
            today: TODAY.to_owned(),
            totals_from: "2026-10-13".to_owned(),
            workouts_from: "2026-10-13".to_owned(),
            workouts_since_ms: since(),
            held: Vec::new(),
        }
    }

    fn input(snapshot: &wire::HealthSnapshot, chosen: &[&str]) -> (Value, Vec<Value>, bool) {
        let chosen: Vec<String> = chosen.iter().map(|key| (*key).to_owned()).collect();
        follow_input(
            crate::strings::Locale::En,
            snapshot,
            &window_of(),
            &chosen,
            "device-a",
        )
        .unwrap()
    }

    #[test]
    fn the_stores_origin_is_one_per_store_and_a_workout_seen_twice_is_one_record() {
        let (origin, records, _) = input(
            &snapshot(vec![
                run_of(0, "running", "run-0"),
                run_of(5, "running", "run-0"),
            ]),
            &["steps", "workouts"],
        );
        assert_eq!(
            origin,
            json!({"ref": "store:apple-health", "label": "Apple Health", "device_id": "device-a"})
        );
        assert_eq!(records.len(), 1);
    }

    #[test]
    fn a_read_is_complete_only_when_it_says_so_found_a_workout_and_the_member_chose_workouts_and_the_os_allowed_them()
     {
        let one = snapshot(vec![run_of(0, "running", "run-0")]);
        assert!(input(&one, &["steps", "workouts"]).2);
        let mut incomplete = one.clone();
        incomplete.workouts_complete = false;
        assert!(!input(&incomplete, &["steps", "workouts"]).2);
        assert!(!input(&snapshot(Vec::new()), &["steps", "workouts"]).2);
        assert!(!input(&one, &["steps"]).2);
        let mut refused = one;
        refused.refused = vec!["workouts".to_owned()];
        assert!(!input(&refused, &["steps", "workouts"]).2);
    }

    #[test]
    fn a_store_no_longer_on_the_phone_sends_no_workouts_and_judges_none_gone() {
        let mut gone = snapshot(vec![run_of(0, "running", "run-0")]);
        gone.store_present = false;
        let (_, records, complete) = input(&gone, &["workouts"]);
        assert!(records.is_empty());
        assert!(!complete);
    }

    #[test]
    fn the_phones_habit_round_trips() {
        let chosen = vec!["steps".to_owned(), "workouts".to_owned()];
        let device = Device::decode(&Device::encode(true, &chosen));
        assert_eq!(
            device,
            Device {
                loaded: true,
                connected: true,
                chosen: chosen.clone()
            }
        );
        let stopped = Device::decode(&Device::encode(false, &chosen));
        assert!(!stopped.connected);
        assert_eq!(stopped.chosen, chosen);
        assert_eq!(Device::decode(b"").chosen, Vec::<String>::new());
    }
}
