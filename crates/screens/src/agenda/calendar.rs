//! CALENDAR → AGENDA, IMPORTED AND FOLLOWED (docs/decisions.md, "Onboarding
//! without sample data", R-ONBOARD-4; #1127; #1135).
//!
//! The phone is read by the shell (iOS EventKit, Android `CalendarContract`),
//! which performs a [`wire::CalendarRead`] effect and answers a
//! [`wire::CalendarSnapshot`]: every occurrence in a window, as the OS holds it.
//! Everything else is decided here: what to send, how it maps, what the status
//! line says, when a following pass runs.
//!
//! ## The vault does the merge
//!
//! One `follow-calendar` per calendar carries that calendar's records and the
//! vault merges: a field the member never changed follows the phone, one they
//! changed stands, an event the vault does not know is matched by title and
//! start to one of the member's own before one is added, and one gone from a
//! complete read goes to the trash if the member never edited it. The phone
//! sends records; it keeps no fingerprint and no link.
//!
//! **A repeating series is ONE record**, its rule kept, so it goes on repeating
//! past the window and editing "all events" edits all of them. The phone shows
//! only the occurrences in a window and has no rule engine, so the record states
//! what it SEES (`overrides`: the days it showed as the rule has them, and the
//! ones the member moved, over the window) and the vault, which expands the rule,
//! works out which days were skipped. **A rule the vault cannot expand** is kept
//! as the phone wrote it and the event is flagged, so it shows at its anchor.
//!
//! **The one loss**: an occurrence the member moved from inside the window to
//! outside it is not in the phone's answer at all, so it reads as cancelled and
//! becomes a skip. The phone's read cannot tell the two apart.
//!
//! ## Following ([`CalendarFollow`])
//!
//! A screen that lives as long as Agenda does (its home) hosts one
//! [`CalendarFollow`]. The member's Import tap asks the OS for permission and
//! imports; from then on this device FOLLOWS: a [`wire::PhoneWatch`] makes the
//! shell report each change of the calendar store, bursts are coalesced (the
//! first change arms a two-second timer, the ones before it fires join it, and
//! changes during a pass queue exactly one more), and a pass reads the calendars
//! only if the OS already allows it. **A pass never asks the OS for permission
//! and never runs before this device imported.**
//!
//! "This device imported" is a per-device habit kept in the keychain
//! ([`IMPORTED_KEY`]), not a fact read back from the vault: the OS permission a
//! pass needs is per device too, and a vault restored onto a new phone must be
//! imported from there once.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use serde_json::{Value, json};
use wire::screen_event::Kind as E;

use crate::catalog::act;
use crate::kit::act as kit_act;
use crate::kit::civil;
use crate::screen::Ctx;
use crate::strings::{Locale, agenda as words, agenda_calendar as calendar_words, fill};

/// THE WINDOW READ: a week back, so the day-one Agenda has its recent past, and
/// two months on.
pub const DAYS_BACK: u32 = 7;
pub const DAYS_ON: u32 = 62;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const DAY: usize = 10;

/// The origin of an event that names no calendar: this phone's own.
pub const DEFAULT_ORIGIN: &str = "local:this-phone";

/// The keychain key that says this device imported its calendar.
pub const IMPORTED_KEY: &str = "agenda_calendar_imported";
const IMPORTED_VALUE: &[u8] = b"1";

/// Triggers within this long of the first are one pass.
pub const SETTLE: Duration = Duration::from_secs(2);
/// A read that has not answered in two minutes is abandoned, so one stuck read
/// cannot hold the follow for good.
pub const READ_TIMEOUT: Duration = Duration::from_secs(120);
const SETTLE_TIMER: &str = "calendar-settle";
const READ_TIMER: &str = "calendar-read";

pub type PhoneEvent = wire::PhoneCalendarEvent;

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/// A calendar as the member knows it: the origin and its label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OriginRef {
    pub id: String,
    pub label: String,
}

/// Whitespace runs (and no-break spaces) become one space; the ends go.
#[must_use]
pub fn squash(value: &str) -> String {
    value
        .split(|c: char| c.is_whitespace() || c == '\u{a0}')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// A CALENDAR AS THE MEMBER KNOWS IT. The origin is `calendar:<key>` (R-1127-10),
/// labelled "{source}: {calendar}" ("iCloud: Home", "Gmail: Work"); a calendar
/// named for its source, or a source with no name, is just the one that says
/// something.
#[must_use]
pub fn origin_of(locale: Locale, calendar: &wire::PhoneCalendar) -> OriginRef {
    let (source, title) = (squash(&calendar.source_title), squash(&calendar.title));
    let label = if source.is_empty() && title.is_empty() {
        words::import_origin_this_phone(locale)
    } else if source.is_empty() {
        title
    } else if title.is_empty() || title == source {
        source
    } else {
        format!("{source}: {title}")
    };
    OriginRef {
        id: format!("calendar:{}", calendar.key),
        label,
    }
}

/// The origin an event belongs to.
fn event_origin(event: &PhoneEvent) -> String {
    if event.calendar_key.is_empty() {
        DEFAULT_ORIGIN.to_owned()
    } else {
        format!("calendar:{}", event.calendar_key)
    }
}

/// An id the engine accepts: it names its kind and something after it.
#[must_use]
pub fn is_valid_id(id: &str) -> bool {
    kind_of(id).is_some()
        && id
            .split_once(':')
            .is_some_and(|(_, rest)| !rest.trim().is_empty())
}

/// An id that survives a new phone, so the same record is re-found there
/// without matching.
#[must_use]
pub fn is_portable_id(id: &str) -> bool {
    matches!(kind_of(id), Some("uid" | "lookup"))
}

fn kind_of(id: &str) -> Option<&str> {
    let (prefix, rest) = id.split_once(':')?;
    (!prefix.is_empty() && !rest.is_empty() && prefix.chars().all(|c| c.is_ascii_lowercase()))
        .then_some(prefix)
}

/// THE RULE AS THE VAULT TAKES IT, or empty for none. The `RRULE:` prefix goes,
/// and a part that only restates the anchor goes with it (a yearly rule's
/// `BYMONTHDAY` on the first occurrence's own day and its `BYMONTH` on its own
/// month, a `WKST` that moves no day) because EventKit and Google write those
/// out and the vault, which steps from the anchor, refuses them. **A monthly
/// rule's `BYMONTHDAY` and positional `BYDAY` stay** (#1119): the vault expands
/// them, and dropping a `BYMONTHDAY=31` would turn "the 31st" into "the last
/// day" in the short months. Any other part stays too, and a rule the vault
/// cannot honour is refused there.
#[must_use]
pub fn rule(rrule: &str, start: &str) -> String {
    let text = rrule.trim();
    let text = text
        .strip_prefix("RRULE:")
        .unwrap_or(text)
        .trim()
        .trim_end_matches(';');
    if text.is_empty() || start.len() < DAY {
        return String::new();
    }
    let parts: Vec<&str> = text
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let Some(freq) = parts.iter().find_map(|part| part.strip_prefix("FREQ=")) else {
        return String::new();
    };
    let day = start.get(8..10).unwrap_or_default().trim_start_matches('0');
    let month = start.get(5..7).unwrap_or_default().trim_start_matches('0');
    // `WKST` only moves a WEEKLY rule's `BYDAY` days when it steps more than one
    // week; anywhere else it changes nothing, and iOS writes it on every rule of
    // a Monday-first phone.
    let interval: i64 = parts
        .iter()
        .find_map(|part| part.strip_prefix("INTERVAL="))
        .and_then(|n| n.parse().ok())
        .unwrap_or(1);
    let week_start_matters =
        freq == "WEEKLY" && interval > 1 && parts.iter().any(|part| part.starts_with("BYDAY="));
    parts
        .iter()
        .filter(|part| {
            let restates_anchor = freq == "YEARLY"
                && (**part == format!("BYMONTHDAY={day}") || **part == format!("BYMONTH={month}"));
            let idle_week_start = !week_start_matters && part.starts_with("WKST=");
            !(restates_anchor || idle_week_start)
        })
        .copied()
        .collect::<Vec<_>>()
        .join(";")
}

/// One series to import: its own event, its rule, and its occurrences in the window.
#[derive(Clone, Debug)]
pub struct Series {
    pub id: String,
    pub event: PhoneEvent,
    pub rrule: String,
    pub occurrences: Vec<PhoneEvent>,
}

/// What a read becomes: the series it holds, and every other event once.
#[derive(Clone, Debug, Default)]
pub struct Plan {
    pub series: Vec<Series>,
    pub singles: Vec<PhoneEvent>,
}

fn tidy(event: &PhoneEvent) -> PhoneEvent {
    PhoneEvent {
        title: event.title.trim().to_owned(),
        notes: event.notes.trim().to_owned(),
        series: None,
        original_start: String::new(),
        moved: false,
        ..event.clone()
    }
}

/// FOLD A READ. Occurrences sharing a series id become one [`Series`], whose own
/// event takes its title, notes and availability from an occurrence the member
/// did not move; everything else is a single.
#[must_use]
pub fn plan(events: &[PhoneEvent]) -> Plan {
    let mut grouped: Vec<(String, Vec<&PhoneEvent>)> = Vec::new();
    let mut singles = Vec::new();
    for event in events {
        let belongs = event
            .series
            .as_ref()
            .filter(|series| {
                !rule(&series.rrule, &series.start).is_empty()
                    && !series.start.is_empty()
                    && !series.end.is_empty()
            })
            .map(|series| series.id.clone());
        match belongs {
            None => singles.push(event),
            Some(id) => match grouped.iter_mut().find(|(known, _)| *known == id) {
                Some((_, occurrences)) => occurrences.push(event),
                None => grouped.push((id, vec![event])),
            },
        }
    }
    let series = grouped
        .into_iter()
        .filter_map(|(_, occurrences)| {
            let pattern = occurrences
                .iter()
                .find(|event| !event.moved)
                .or(occurrences.first())?;
            let own = pattern.series.as_ref()?;
            let title = pattern.title.trim();
            if title.is_empty() {
                return None;
            }
            Some(Series {
                id: own.id.clone(),
                event: PhoneEvent {
                    title: title.to_owned(),
                    notes: pattern.notes.trim().to_owned(),
                    start: own.start.clone(),
                    end: own.end.clone(),
                    series: None,
                    original_start: String::new(),
                    moved: false,
                    ..(*pattern).clone()
                },
                rrule: rule(&own.rrule, &own.start),
                occurrences: occurrences.into_iter().cloned().collect(),
            })
        })
        .collect();
    let singles = singles
        .into_iter()
        .map(tidy)
        .filter(|event| !event.title.is_empty() && !event.start.is_empty() && !event.end.is_empty())
        .collect();
    Plan { series, singles }
}

/// The window the vault holds the phone's word against: a day's margin each
/// side, as UTC instants.
fn observed(now_ms: i64) -> (String, String) {
    let from = (now_ms - i64::from(DAYS_BACK) * DAY_MS).div_euclid(DAY_MS) + 1;
    let to = (now_ms + i64::from(DAYS_ON) * DAY_MS).div_euclid(DAY_MS) - 1;
    (
        format!("{}T00:00:00Z", civil::civil_day_of(from)),
        format!("{}T00:00:00Z", civil::civil_day_of(to)),
    )
}

/// The key an occurrence is matched on: the series-local wall clock to the
/// second, or the day for an all-day series (the shape of the vault's
/// `original_start`).
fn key(start: &str, all_day: bool) -> String {
    start
        .get(..if all_day { DAY } else { 19 })
        .unwrap_or(start)
        .to_owned()
}

/// An event's zone (its own, else the device's), or `None` for an all-day one or
/// none at all.
fn zone_of(event: &PhoneEvent, device_zone: &str) -> Option<String> {
    if event.all_day {
        return None;
    }
    Some(if event.tz.is_empty() {
        device_zone
    } else {
        &event.tz
    })
    .filter(|zone| !zone.is_empty())
    .map(str::to_owned)
}

/// WHAT THE PHONE SAYS OF A SERIES' DAYS, over the window it read: the days it
/// showed as the rule has them (`shown`, by the series-local wall clock) and each
/// it moved (`moved`, with its own times and words). A day the rule produces in
/// the window that is neither is one the member cancelled there; the vault works
/// that out, because the phone has no rule engine.
fn overrides(series: &Series, now_ms: i64) -> Value {
    let all_day = series.event.all_day;
    let (from, to) = observed(now_ms);
    let key_of = |occurrence: &PhoneEvent| {
        key(
            if occurrence.original_start.is_empty() {
                &occurrence.start
            } else {
                &occurrence.original_start
            },
            all_day,
        )
    };
    let day_or_time = |value: &str| {
        if all_day {
            value.get(..DAY).unwrap_or(value).to_owned()
        } else {
            value.to_owned()
        }
    };
    let mut shown: Vec<String> = Vec::new();
    for occurrence in series
        .occurrences
        .iter()
        .filter(|occurrence| !occurrence.moved)
    {
        let shown_key = key_of(occurrence);
        if !shown.contains(&shown_key) {
            shown.push(shown_key);
        }
    }
    let moved: Vec<Value> = series
        .occurrences
        .iter()
        .filter(|occurrence| occurrence.moved)
        .map(|day| {
            json!({
                "original_start": key_of(day),
                "starts": day_or_time(&day.start),
                "ends": day_or_time(&day.end),
                "title": day.title.trim(),
                "description": day.notes.trim(),
            })
        })
        .collect();
    json!({ "from": from, "to": to, "shown": shown, "moved": moved })
}

/// THE FIELDS A PHONE OWNS OF AN EVENT: its words, when it is (a wall clock and
/// its zone, which the vault resolves to the instant, or a floating time, or
/// days), its rule, whether it blocks its time, and for a series what the phone
/// shows of its days.
fn fields(
    event: &PhoneEvent,
    rrule: &str,
    series: Option<&Series>,
    now_ms: i64,
    device_zone: &str,
) -> Value {
    let mut fields = serde_json::Map::new();
    fields.insert("title".into(), json!(event.title));
    fields.insert(
        "description".into(),
        if event.notes.is_empty() {
            Value::Null
        } else {
            json!(event.notes)
        },
    );
    if event.all_day {
        fields.insert(
            "starts".into(),
            json!(event.start.get(..DAY).unwrap_or(&event.start)),
        );
        fields.insert(
            "ends".into(),
            json!(event.end.get(..DAY).unwrap_or(&event.end)),
        );
        fields.insert("timing".into(), json!("all-day"));
        fields.insert("zone".into(), Value::Null);
    } else {
        fields.insert("starts".into(), json!(event.start));
        fields.insert("ends".into(), json!(event.end));
        let zone = zone_of(event, device_zone);
        fields.insert(
            "timing".into(),
            json!(if zone.is_some() { "zoned" } else { "floating" }),
        );
        fields.insert("zone".into(), zone.map_or(Value::Null, Value::from));
    }
    fields.insert(
        "rule".into(),
        if rrule.is_empty() {
            Value::Null
        } else {
            json!(rrule)
        },
    );
    fields.insert("busy".into(), json!(!event.free));
    if let Some(series) = series {
        fields.insert("overrides".into(), overrides(series, now_ms));
    }
    Value::Object(fields)
}

/// ONE EVENT, as `follow-calendar` is told of it: an external id, and the fields
/// the phone owns.
#[derive(Clone, Debug)]
pub struct EventRecord {
    pub phone_id: String,
    pub origin: String,
    pub fields: Value,
}

/// WHAT ONE READ OF THE CALENDARS SENDS: the events, one record each, in the
/// calendars they were read in, and every calendar present (even one with no
/// event in it).
#[derive(Clone, Debug)]
pub struct Batch {
    /// False for a read that may have missed events: the vault then trashes nothing.
    pub complete: bool,
    pub origins: Vec<OriginRef>,
    pub records: Vec<EventRecord>,
}

/// A READ OF THE CALENDARS AS A BATCH. A repeating series is ONE record keyed by
/// its id, and every other event one record keyed by its own; an id that names no
/// kind skips the event.
#[must_use]
pub fn batch(locale: Locale, snapshot: &wire::CalendarSnapshot) -> Batch {
    let plan = plan(&snapshot.events);
    let mut records: Vec<EventRecord> = Vec::new();
    let mut keep = |id: &str, event: &PhoneEvent, rrule: &str, series: Option<&Series>| {
        if !is_valid_id(id)
            || event.title.is_empty()
            || event.start.is_empty()
            || event.end.is_empty()
        {
            return;
        }
        if records.iter().all(|record| record.phone_id != id) {
            records.push(EventRecord {
                phone_id: id.to_owned(),
                origin: event_origin(event),
                fields: fields(event, rrule, series, snapshot.now_ms, &snapshot.device_zone),
            });
        }
    };
    for event in &plan.singles {
        keep(&event.phone_id, event, "", None);
    }
    for series in &plan.series {
        keep(&series.id, &series.event, &series.rrule, Some(series));
    }
    let named: Vec<OriginRef> = snapshot
        .calendars
        .iter()
        .map(|calendar| origin_of(locale, calendar))
        .collect();
    let mut present: Vec<OriginRef> = Vec::new();
    let ids = named
        .iter()
        .map(|origin| origin.id.clone())
        .chain(records.iter().map(|record| record.origin.clone()));
    for id in ids {
        if present.iter().any(|origin| origin.id == id) {
            continue;
        }
        let label = named
            .iter()
            .find(|origin| origin.id == id)
            .map(|origin| origin.label.clone())
            .unwrap_or_else(|| {
                if id == DEFAULT_ORIGIN {
                    words::import_origin_this_phone(locale)
                } else {
                    id.clone()
                }
            });
        present.push(OriginRef { id, label });
    }
    Batch {
        complete: snapshot.complete,
        origins: present,
        records,
    }
}

/// The `follow-calendar` request for one calendar: its records, and whether the
/// read was complete.
#[must_use]
pub fn follow_request(
    origin: &OriginRef,
    records: &[&EventRecord],
    complete: bool,
    device: &str,
) -> act::agenda::FollowCalendar {
    let records: Vec<Value> = records
        .iter()
        .map(|record| {
            json!({
                "external_id": record.phone_id,
                // A phone id that means something on this phone only is kept under the phone (R-1127-10).
                "device_id": if is_portable_id(&record.phone_id) { Value::Null } else { json!(device) },
                "fields": record.fields,
            })
        })
        .collect();
    act::agenda::FollowCalendar {
        origin: json!({ "ref": origin.id, "label": origin.label, "device_id": device }).to_string(),
        records: Value::Array(records).to_string(),
        complete: Some(complete),
        since: None,
    }
}

/// What one pass did. `add_account` is the R-1127-8 condition: the phone
/// returned no calendars at all.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub added: u32,
    pub refused: u32,
    pub updated: u32,
    pub trashed: u32,
    pub add_account: bool,
}

/// The one sentence an import ends on.
#[must_use]
pub fn sentence(locale: Locale, outcome: &Outcome) -> String {
    if outcome.add_account {
        words::import_calendar_add_account(locale)
    } else if outcome.added == 0 && outcome.refused == 0 {
        words::import_calendar_none(locale)
    } else if outcome.added == 0 {
        words::import_calendar_failed(locale)
    } else if outcome.added == 1 {
        words::import_calendar_one(locale)
    } else {
        fill(
            &words::import_calendar_done(locale),
            &[("count", &outcome.added.to_string())],
        )
    }
}

/// A count of the command's output: `"added": 3`.
fn count(output: &Value, name: &str) -> u32 {
    output
        .get(name)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Purpose {
    /// The member's tap: the OS may ask for permission, and a sentence says how it went.
    Import,
    /// A following pass: silent, and never asks.
    Follow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Waiting {
    Nothing,
    /// The keychain's answer to "did this device import?".
    Flag,
    Read(Purpose),
}

/// When a following pass runs. Pure: the timers are the runtime's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Gate {
    Idle,
    /// A trigger armed the settle timer; later ones join it.
    Armed,
    /// A pass is out; `queued` is a trigger that arrived during it.
    Running {
        queued: bool,
    },
}

/// THE IMPORT AND THE FOLLOW, as one component a long-lived screen hosts. The
/// host sends it the events it does not know ([`Self::on_event`]), draws its
/// [`Self::status`] on the status line, and returns the effects it hands back.
pub struct CalendarFollow {
    waiting: Waiting,
    gate: Gate,
    /// This device imported its calendar: a pass may run.
    followed: bool,
    watching: bool,
    /// An Import tapped while a read was out.
    import_queued: bool,
    status: Option<wire::StatusLine>,
    outcome: Option<Outcome>,
}

impl Default for CalendarFollow {
    fn default() -> Self {
        Self::new()
    }
}

impl CalendarFollow {
    #[must_use]
    pub fn new() -> Self {
        Self {
            waiting: Waiting::Nothing,
            gate: Gate::Idle,
            followed: false,
            watching: false,
            import_queued: false,
            status: None,
            outcome: None,
        }
    }

    /// The host came up: learn whether this device follows. Asked once.
    pub fn attach(&mut self) -> Vec<wire::Effect> {
        if self.followed || self.waiting != Waiting::Nothing {
            return Vec::new();
        }
        self.waiting = Waiting::Flag;
        vec![keychain(wire::keychain_op::Op::Get, Vec::new())]
    }

    /// The member tapped Import. ONE IMPORT AT A TIME: a second tap while one
    /// runs would write every event twice, so it is nothing. A tap during a
    /// following pass (or before the device has said whether it follows) waits
    /// for it.
    pub fn import(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.waiting == Waiting::Read(Purpose::Import) {
            return Vec::new();
        }
        if self.waiting != Waiting::Nothing {
            self.import_queued = true;
            return Vec::new();
        }
        self.start_read(ctx, Purpose::Import)
    }

    /// The phone may have changed (or the app came forward): follow soon.
    pub fn request(&mut self, ctx: &Ctx) {
        if !self.followed {
            return;
        }
        match self.gate {
            Gate::Idle => {
                self.gate = Gate::Armed;
                ctx.start_timer(SETTLE_TIMER, SETTLE);
            }
            Gate::Armed => {}
            Gate::Running { .. } => self.gate = Gate::Running { queued: true },
        }
    }

    /// The status line this flow wants drawn: the running sentence, then the
    /// outcome's. A following pass says nothing.
    #[must_use]
    pub fn status(&self) -> Option<&wire::StatusLine> {
        self.status.as_ref()
    }

    /// How the last import ended, for a caller that chains it (a made vault's
    /// summary).
    #[must_use]
    pub fn outcome(&self) -> Option<&Outcome> {
        self.outcome.as_ref()
    }

    /// Whether this device follows the calendar.
    #[must_use]
    pub fn followed(&self) -> bool {
        self.followed
    }

    /// Offer the host's event. `Some(effects)` when it was this flow's (a
    /// timer it started, or the answer to an effect it asked); `None` otherwise.
    pub fn on_event(&mut self, event: &E, ctx: &Ctx) -> Option<Vec<wire::Effect>> {
        match event {
            E::TimerFired(fired) if fired.timer == SETTLE_TIMER => Some(self.settled(ctx)),
            E::TimerFired(fired) if fired.timer == READ_TIMER => Some(self.read_ended(ctx, None)),
            E::EffectResult(result) => self.on_result(result, ctx),
            _ => None,
        }
    }

    fn on_result(&mut self, result: &wire::EffectResult, ctx: &Ctx) -> Option<Vec<wire::Effect>> {
        use wire::effect_result::Outcome as O;
        match (&self.waiting, &result.outcome) {
            (_, Some(O::PhoneChanged(changed)))
                if changed.source == wire::ImportSource::Calendar as i32 =>
            {
                self.request(ctx);
                Some(Vec::new())
            }
            (Waiting::Flag, Some(O::Keychain(value))) => {
                self.waiting = Waiting::Nothing;
                self.followed = value.found && value.value == IMPORTED_VALUE;
                Some(self.begin_following(ctx))
            }
            (Waiting::Flag, Some(O::Failed(_))) => {
                self.waiting = Waiting::Nothing;
                Some(Vec::new())
            }
            (Waiting::Read(_), Some(O::Calendar(snapshot))) => {
                Some(self.read_ended(ctx, Some(snapshot)))
            }
            (Waiting::Read(_), Some(O::Failed(failed))) => {
                let denied = failed.denied;
                Some(self.read_failed(ctx, denied))
            }
            _ => None,
        }
    }

    /// Watch the store and follow once, now that this device follows.
    fn begin_following(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if !self.followed || self.watching {
            return Vec::new();
        }
        self.watching = true;
        self.request(ctx);
        vec![watch(true)]
    }

    /// The settle timer fired: start the pass.
    fn settled(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.gate != Gate::Armed {
            return Vec::new();
        }
        if !self.followed {
            self.gate = Gate::Idle;
            return Vec::new();
        }
        if self.waiting != Waiting::Nothing {
            // An import is out: the pass waits the settle time again.
            ctx.start_timer(SETTLE_TIMER, SETTLE);
            return Vec::new();
        }
        self.gate = Gate::Running { queued: false };
        self.start_read(ctx, Purpose::Follow)
    }

    fn start_read(&mut self, ctx: &Ctx, purpose: Purpose) -> Vec<wire::Effect> {
        self.waiting = Waiting::Read(purpose);
        match purpose {
            Purpose::Import => {
                self.outcome = None;
                self.status = Some(plain(calendar_words::import_calendar_running(ctx.locale())));
            }
            // Only a read with no dialog can go unanswered.
            Purpose::Follow => ctx.start_timer(READ_TIMER, READ_TIMEOUT),
        }
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::CalendarRead(wire::CalendarRead {
                ask_permission: purpose == Purpose::Import,
                days_back: DAYS_BACK,
                days_on: DAYS_ON,
            })),
        }]
    }

    fn read_failed(&mut self, ctx: &Ctx, denied: bool) -> Vec<wire::Effect> {
        let Waiting::Read(purpose) = self.waiting else {
            return Vec::new();
        };
        if purpose == Purpose::Import {
            let locale = ctx.locale();
            self.status = Some(plain(if denied {
                calendar_words::import_calendar_denied(locale)
            } else {
                words::import_calendar_failed(locale)
            }));
        }
        self.finish(ctx)
    }

    /// A read came back (`Some`) or timed out (`None`).
    fn read_ended(
        &mut self,
        ctx: &Ctx,
        snapshot: Option<&wire::CalendarSnapshot>,
    ) -> Vec<wire::Effect> {
        let Waiting::Read(purpose) = self.waiting else {
            return Vec::new();
        };
        let Some(snapshot) = snapshot else {
            return self.read_failed(ctx, false);
        };
        let (outcome, told) = self.run(ctx, snapshot);
        let mut effects = Vec::new();
        if purpose == Purpose::Import {
            self.status = Some(plain(sentence(ctx.locale(), &outcome)));
            self.outcome = Some(outcome);
            // THIS DEVICE FOLLOWS FROM NOW ON, once the vault took a calendar.
            if told && !self.followed {
                self.followed = true;
                effects.push(keychain(
                    wire::keychain_op::Op::Set,
                    IMPORTED_VALUE.to_vec(),
                ));
            }
        }
        effects.extend(self.finish(ctx));
        if self.followed && !self.watching {
            effects.extend(self.begin_following(ctx));
        }
        effects
    }

    /// One `follow-calendar` per calendar. `told` is whether the vault took any.
    fn run(&mut self, ctx: &Ctx, snapshot: &wire::CalendarSnapshot) -> (Outcome, bool) {
        let batch = batch(ctx.locale(), snapshot);
        let mut outcome = Outcome {
            add_account: batch.complete && batch.records.is_empty() && batch.origins.is_empty(),
            ..Outcome::default()
        };
        let mut told = false;
        for origin in &batch.origins {
            let records: Vec<&EventRecord> = batch
                .records
                .iter()
                .filter(|record| record.origin == origin.id)
                .collect();
            let request = follow_request(origin, &records, batch.complete, &snapshot.device_id);
            let key = kit_act::key(
                &["follow-calendar", &origin.id, &snapshot.now_ms.to_string()],
                kit_act::fresh(),
            );
            let settled = kit_act::act(ctx, request, &key);
            if !settled.committed {
                outcome.refused += u32::try_from(records.len()).unwrap_or(u32::MAX);
                continue;
            }
            told = true;
            let output: Value = serde_json::from_slice(&settled.output).unwrap_or(Value::Null);
            outcome.added += count(&output, "added") + count(&output, "matched");
            outcome.refused += count(&output, "refused");
            outcome.updated += count(&output, "updated");
            outcome.trashed += count(&output, "trashed");
        }
        (outcome, told)
    }

    /// A read is over, however it ended: the next thing waiting goes.
    fn finish(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        ctx.cancel_timer(READ_TIMER);
        self.waiting = Waiting::Nothing;
        if self.import_queued {
            self.import_queued = false;
            return self.start_read(ctx, Purpose::Import);
        }
        match self.gate {
            // Triggers arrived during the pass: one more, at once.
            Gate::Running { queued: true } => {
                self.gate = Gate::Running { queued: false };
                self.start_read(ctx, Purpose::Follow)
            }
            Gate::Running { queued: false } => {
                self.gate = Gate::Idle;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }
}

fn plain(sentence: String) -> wire::StatusLine {
    wire::StatusLine {
        sentence,
        action_label: String::new(),
        refused: false,
    }
}

fn keychain(op: wire::keychain_op::Op, value: Vec<u8>) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::Keychain(wire::KeychainOp {
            op: op as i32,
            key: IMPORTED_KEY.to_owned(),
            value,
        })),
    }
}

fn watch(on: bool) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::PhoneWatch(wire::PhoneWatch {
            source: wire::ImportSource::Calendar as i32,
            on,
        })),
    }
}
