//! THE FOLLOWER (app-plane §16, D13): when the phone's own stores are read into the vault.
//!
//! A room's tap enrols a store, a shell's trigger (the app came forward, a watch fired, a window
//! opened) carries no data, and the shell answers a `store_read` with what the OS said and what it
//! read. This module holds every decision between them: whether this device enrolled the store,
//! whether the OS may be asked (only in the ask a member's tap made), that a refusal ends reading,
//! that one ask is in flight per store and later triggers queue exactly one more, and what a pass
//! leaves for the room to say. It has no clock and no thread; tests count asks and reads.
//!
//! The merge is the vault's: the shell's snapshot is the follow command's input, run as
//! `follow.<system>`. A cursor rides in `origin.cursor` and moves in the commit of the records it
//! covers; this device's id is set here, never by a shell.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, MutexGuard, PoisonError};

use centraid_api_proto::core_v1 as wire;
use serde_json::{Value, json};

use crate::error::{CoreError, Result};

/// A store the phone keeps that the vault follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Store {
    Contacts,
    Calendar,
    Reminders,
    Files,
    Health,
    CameraRoll,
}

/// The types Health follows until the member chooses others.
pub const HEALTH_TYPES: [&str; 7] = [
    "steps",
    "sleep_min",
    "active_energy_kcal",
    "exercise_min",
    "resting_hr_bpm",
    "weight_kg",
    "workouts",
];

/// The calendar window an ask places around the shell's clock.
pub const CALENDAR_DAYS_BACK: u32 = 7;
pub const CALENDAR_DAYS_ON: u32 = 62;
/// The Health window: a year of day totals and 90 days of workouts.
pub const HEALTH_DAYS_BACK: u32 = 365;
const DAY_MS: i64 = 86_400_000;
const WORKOUT_DAYS: i64 = 90;

impl Store {
    pub const ALL: [Store; 6] = [
        Store::Contacts,
        Store::Calendar,
        Store::Reminders,
        Store::Files,
        Store::Health,
        Store::CameraRoll,
    ];

    /// The wire's `system`, and the device key's suffix.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Store::Contacts => "contacts",
            Store::Calendar => "calendar",
            Store::Reminders => "reminders",
            Store::Files => "files",
            Store::Health => "health",
            Store::CameraRoll => "camera_roll",
        }
    }

    #[must_use]
    pub fn of_key(key: &str) -> Option<Store> {
        Store::ALL.into_iter().find(|store| store.key() == key)
    }

    /// The vault's `origin.system` for the store.
    #[must_use]
    pub const fn origin_system(self) -> &'static str {
        match self {
            Store::Reminders => "phone_reminders",
            other => other.key(),
        }
    }

    /// The vault command a pass runs (Health has a second, for its readings).
    #[must_use]
    pub const fn command(self) -> &'static str {
        match self {
            Store::Contacts => "follow.contacts",
            Store::Calendar => "follow.calendar",
            Store::Reminders => "follow.reminders",
            Store::Files => "follow.files",
            Store::Health => "follow.health",
            Store::CameraRoll => "follow.camera_roll",
        }
    }

    /// Whether the OS announces a change to the store while the app runs.
    #[must_use]
    pub const fn watched(self) -> bool {
        matches!(self, Store::Contacts | Store::Calendar | Store::Reminders)
    }

    /// The device key that says this device enrolled the store.
    #[must_use]
    pub fn habit_key(self) -> String {
        format!("follow.{}", self.key())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Report {
    blocked: Option<wire::FollowGrant>,
    read: Option<u32>,
    doubted: u32,
    incomplete: bool,
    refused: Vec<String>,
    background_refused: bool,
}

#[derive(Default)]
struct Inner {
    next: u64,
    current: BTreeMap<Store, u64>,
    queued: BTreeSet<Store>,
    watching: BTreeSet<Store>,
    reports: BTreeMap<Store, Report>,
}

/// The board the follower keeps in memory: asks in flight, watches, what the last pass said.
#[derive(Default)]
pub struct Follower(Mutex<Inner>);

impl Follower {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn refused(detail: impl Into<String>) -> CoreError {
    CoreError::InvalidRequest {
        detail: detail.into(),
    }
}

fn is_blocking(grant: wire::FollowGrant) -> bool {
    matches!(
        grant,
        wire::FollowGrant::Refused | wire::FollowGrant::Restricted | wire::FollowGrant::Unavailable
    )
}

impl crate::handle::HandleState {
    fn follow_enrolled(&self, store: Store) -> bool {
        self.device()
            .ok()
            .and_then(|device| device.get(&store.habit_key()).ok().flatten())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.get("on").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    fn follow_set_habit(&self, store: Store, on: bool) {
        let Ok(device) = self.device() else { return };
        if on {
            let value = json!({ "v": 1, "on": true, "chosen": HEALTH_TYPES });
            let _ = device.put(&store.habit_key(), &value.to_string());
        } else {
            let _ = device.delete(&store.habit_key());
        }
    }

    fn follow_install(&self) -> String {
        self.device()
            .ok()
            .and_then(|device| device.get("install-id").ok().flatten())
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| "this-phone".to_owned())
    }

    fn follow_push(&self, ask: wire::ShellEffect) {
        self.events().push(wire::Event {
            kind: Some(wire::event::Kind::Effect(ask)),
        });
    }

    fn follow_changed(&self) {
        self.events().push(wire::Event {
            kind: Some(wire::event::Kind::Change(wire::ChangeEvent {
                table: "follow".to_owned(),
                pk_set: Vec::new(),
            })),
        });
    }

    fn follow_cursor(&self, store: Store) -> String {
        if store != Store::Health {
            return String::new();
        }
        let install = self.follow_install();
        let Ok(reader) = self.reader_for_follow() else {
            return String::new();
        };
        let Ok(origins) = reader.run(
            &centraid_domain::apps::entity::FOLLOWED_STORES,
            &centraid_domain::read::Args::new().text("system", store.origin_system()),
        ) else {
            return String::new();
        };
        origins
            .rows
            .into_iter()
            .find(|row| {
                row.retired_at.is_none() && row.device_id.as_deref() == Some(install.as_str())
            })
            .and_then(|row| row.cursor)
            .unwrap_or_default()
    }

    fn reader_for_follow(&self) -> Result<centraid_domain::read::Reader> {
        centraid_domain::read::Reader::open(self.path()).map_err(|error| refused(error.to_string()))
    }

    fn follow_ask(&self, store: Store, ask_permission: bool) -> wire::ShellEffect {
        let id = {
            let mut inner = self.follower.lock();
            inner.next += 1;
            let id = inner.next;
            inner.current.insert(store, id);
            id
        };
        let mut read = wire::ShellStoreRead {
            system: store.key().to_owned(),
            ask_permission,
            ..Default::default()
        };
        match store {
            Store::Calendar => {
                read.days_back = CALENDAR_DAYS_BACK;
                read.days_on = CALENDAR_DAYS_ON;
            }
            Store::Health => {
                read.days_back = HEALTH_DAYS_BACK;
                read.chosen = HEALTH_TYPES.iter().map(|&t| t.to_owned()).collect();
                read.workouts_since_ms =
                    crate::rooms::RoomCtx::now_ms(self) - WORKOUT_DAYS * DAY_MS;
                read.cursor = self.follow_cursor(store);
                read.ask_background = ask_permission;
            }
            _ => {}
        }
        wire::ShellEffect {
            effect_id: id,
            kind: Some(wire::shell_effect::Kind::StoreRead(read)),
        }
    }

    fn follow_watch(&self, store: Store, on: bool) {
        if !store.watched() {
            return;
        }
        {
            let mut inner = self.follower.lock();
            let changed = if on {
                inner.watching.insert(store)
            } else {
                inner.watching.remove(&store)
            };
            if !changed {
                return;
            }
        }
        self.follow_push(wire::ShellEffect {
            effect_id: 0,
            kind: Some(wire::shell_effect::Kind::PhoneWatch(
                wire::ShellPhoneWatch {
                    system: store.key().to_owned(),
                    on,
                },
            )),
        });
    }

    fn follow_status(&self, store: Store) -> wire::FollowStatus {
        let enrolled = self.follow_enrolled(store);
        let inner = self.follower.lock();
        let report = inner.reports.get(&store).cloned().unwrap_or_default();
        wire::FollowStatus {
            enrolled,
            blocked: report
                .blocked
                .map_or(wire::FollowGrant::Unspecified, |grant| grant) as i32,
            read: report.read.is_some(),
            count: report.read.unwrap_or_default(),
            doubted: report.doubted,
            incomplete: report.incomplete,
            refused: report.refused,
            background_refused: report.background_refused,
            asking: inner.current.contains_key(&store),
        }
    }

    /// A shell's follow request: the member's tap, a trigger, the answer to an ask, a stop, or a
    /// room's question about where a store stands.
    pub(crate) fn follow_call(
        &self,
        request: &wire::FollowRequest,
    ) -> Result<wire::FollowResponse> {
        let verb =
            wire::FollowVerb::try_from(request.verb).unwrap_or(wire::FollowVerb::Unspecified);
        let store = |system: &str| {
            Store::of_key(system)
                .ok_or_else(|| refused(format!("`{system}` is not a followed store")))
        };
        match verb {
            wire::FollowVerb::Enrol => self.follow_enrol(store(&request.system)?),
            wire::FollowVerb::Trigger => {
                let stores: Vec<Store> = if request.system.is_empty() {
                    Store::ALL.to_vec()
                } else {
                    vec![store(&request.system)?]
                };
                Ok(self.follow_trigger(&stores))
            }
            wire::FollowVerb::Pass => self.follow_answer(store(&request.system)?, request),
            wire::FollowVerb::Stop => self.follow_stop(store(&request.system)?, request),
            wire::FollowVerb::Status => Ok(wire::FollowResponse {
                status: Some(self.follow_status(store(&request.system)?)),
                ..Default::default()
            }),
            wire::FollowVerb::Unspecified => {
                Err(refused("a follow request names a verb".to_owned()))
            }
        }
    }

    fn follow_enrol(&self, store: Store) -> Result<wire::FollowResponse> {
        {
            let mut inner = self.follower.lock();
            inner.queued.remove(&store);
            inner.reports.entry(store).or_default().blocked = None;
        }
        let ask = self.follow_ask(store, true);
        self.follow_push(ask);
        self.follow_changed();
        Ok(wire::FollowResponse {
            asked: 1,
            ..Default::default()
        })
    }

    fn follow_trigger(&self, stores: &[Store]) -> wire::FollowResponse {
        let mut asked = 0;
        for &store in stores {
            if !self.follow_enrolled(store) {
                continue;
            }
            let ask = {
                let mut inner = self.follower.lock();
                if inner
                    .reports
                    .get(&store)
                    .and_then(|report| report.blocked)
                    .is_some_and(is_blocking)
                {
                    continue;
                }
                if inner.current.contains_key(&store) && inner.queued.insert(store) {
                    continue;
                }
                inner.queued.remove(&store);
                drop(inner);
                self.follow_ask(store, false)
            };
            self.follow_watch(store, true);
            self.follow_push(ask);
            asked += 1;
        }
        wire::FollowResponse {
            asked,
            ..Default::default()
        }
    }

    fn follow_answer(
        &self,
        store: Store,
        request: &wire::FollowRequest,
    ) -> Result<wire::FollowResponse> {
        let current = self.follower.lock().current.get(&store).copied();
        if current != Some(request.ask_id) {
            return Ok(wire::FollowResponse {
                stale: true,
                output_json: "{}".to_owned(),
                ..Default::default()
            });
        }
        self.follower.lock().current.remove(&store);
        let grant = wire::FollowGrant::try_from(request.grant).unwrap_or_default();
        let mut response = wire::FollowResponse {
            output_json: "{}".to_owned(),
            ..Default::default()
        };
        match grant {
            wire::FollowGrant::Unspecified => {
                return Err(refused(
                    "a follow answer names what the phone said".to_owned(),
                ));
            }
            wire::FollowGrant::Cancelled => {}
            blocked if is_blocking(blocked) => {
                let mut inner = self.follower.lock();
                inner.queued.remove(&store);
                inner.reports.entry(store).or_default().blocked = Some(blocked);
            }
            granted => {
                self.follow_set_habit(store, true);
                self.follow_watch(store, true);
                self.follower
                    .lock()
                    .reports
                    .entry(store)
                    .or_default()
                    .blocked = None;
                self.follow_merge(store, request, granted, &mut response)?;
            }
        }
        let queued = self.follower.lock().queued.remove(&store);
        if queued && self.follow_enrolled(store) {
            let ask = self.follow_ask(store, false);
            self.follow_push(ask);
            response.asked = 1;
        }
        self.follow_changed();
        Ok(response)
    }

    fn follow_merge(
        &self,
        store: Store,
        request: &wire::FollowRequest,
        grant: wire::FollowGrant,
        response: &mut wire::FollowResponse,
    ) -> Result<()> {
        let snapshot = if request.input_json.is_empty() {
            Value::Null
        } else {
            serde_json::from_str::<Value>(&request.input_json)
                .map_err(|error| refused(format!("the snapshot is not JSON: {error}")))?
        };
        let mut passes: Vec<(&str, Value)> = Vec::new();
        if store == Store::Health {
            for (part, command) in [
                ("workouts", "follow.health"),
                ("readings", "follow.health_readings"),
            ] {
                if let Some(input) = snapshot.get(part) {
                    passes.push((command, input.clone()));
                }
            }
        } else if !snapshot.is_null() {
            passes.push((store.command(), snapshot));
        }
        let install = self.follow_install();
        let (mut count, mut doubted, mut incomplete) =
            (0u32, 0u32, grant == wire::FollowGrant::Limited);
        let mut outputs = Vec::new();
        for (command, mut input) in passes {
            if let Some(origin) = input.get_mut("origin").and_then(Value::as_object_mut)
                && origin.contains_key("cursor")
            {
                origin.insert("device_id".to_owned(), Value::String(install.clone()));
            }
            count += u32::try_from(
                input
                    .get("records")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len),
            )
            .unwrap_or(u32::MAX);
            incomplete |= input.get("complete").and_then(Value::as_bool) == Some(false);
            let key = if request.invoke_key.is_empty() {
                format!("follow:{}:{}:{command}", store.key(), request.ask_id)
            } else {
                request.invoke_key.clone()
            };
            let outcome = self.command(command, &input, &key)?;
            if outcome.status != centraid_vault::CommandStatus::Executed {
                response.declined = true;
                response.sentence = outcome.reason.unwrap_or_default();
                break;
            }
            doubted += u32::try_from(
                outcome
                    .output
                    .get("doubted")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
            .unwrap_or(u32::MAX);
            outputs.push(outcome.output);
        }
        response.output_json = match outputs.len() {
            1 => outputs.remove(0).to_string(),
            _ => Value::Array(outputs).to_string(),
        };
        let mut inner = self.follower.lock();
        let report = inner.reports.entry(store).or_default();
        if !response.declined {
            report.read = Some(count);
            report.doubted = doubted;
            report.incomplete = incomplete;
        }
        report.refused.clone_from(&request.refused);
        report.background_refused = request.background_refused;
        Ok(())
    }

    fn follow_stop(
        &self,
        store: Store,
        request: &wire::FollowRequest,
    ) -> Result<wire::FollowResponse> {
        let only: Option<String> = if request.input_json.is_empty() {
            None
        } else {
            serde_json::from_str::<Value>(&request.input_json)
                .map_err(|error| refused(format!("a stop names its origin as JSON: {error}")))?
                .get("ref")
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let reader = self.reader_for_follow()?;
        let origins = reader
            .run(
                &centraid_domain::apps::entity::FOLLOWED_STORES,
                &centraid_domain::read::Args::new().text("system", store.origin_system()),
            )
            .map_err(|error| refused(error.to_string()))?;
        let mut stopped = 0u32;
        let mut live_left = 0u32;
        for origin in origins.rows.iter().filter(|row| row.retired_at.is_none()) {
            if only.as_deref().is_some_and(|wanted| wanted != origin.r#ref) {
                live_left += 1;
                continue;
            }
            let key = format!("follow:stop:{}:{}", origin.system, origin.r#ref);
            let outcome = self.command(
                "follow.stop",
                &json!({ "system": origin.system, "ref": origin.r#ref }),
                &key,
            )?;
            if outcome.status != centraid_vault::CommandStatus::Executed {
                return Ok(wire::FollowResponse {
                    output_json: "{}".to_owned(),
                    declined: true,
                    sentence: outcome.reason.unwrap_or_default(),
                    ..Default::default()
                });
            }
            stopped += 1;
            if store == Store::Files {
                self.follow_push(wire::ShellEffect {
                    effect_id: 0,
                    kind: Some(wire::shell_effect::Kind::ReleaseGrant(
                        wire::ShellReleaseGrant {
                            r#ref: origin.r#ref.clone(),
                        },
                    )),
                });
            }
        }
        if live_left == 0 {
            self.follow_set_habit(store, false);
            self.follow_watch(store, false);
            let mut inner = self.follower.lock();
            inner.current.remove(&store);
            inner.queued.remove(&store);
            inner.reports.remove(&store);
        }
        self.follow_changed();
        Ok(wire::FollowResponse {
            output_json: json!({ "stopped": stopped }).to_string(),
            ..Default::default()
        })
    }
}
