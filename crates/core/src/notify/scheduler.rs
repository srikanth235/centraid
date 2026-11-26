//! THE SCHEDULER (app-plane §9): one service over `reminder` and `snooze`. It keeps what a shell
//! last said (its platform cap, its zone, what the OS permits and holds), what other producers
//! want held (the backup's stale notices) and the set it last handed over, and answers each
//! refresh with the whole desired set, or nothing when the set has not moved.
//!
//! The set is declarative: `all` is everything that should be pending. A delivered banner leaves
//! only when its id is named in `cancel_delivered_ids`: its item was trashed, purged, finished or
//! moved while the banner's moment was still inside the keep window. Time passing never does it.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, PoisonError};

use centraid_api_proto::core_v1 as wire;
use centraid_vault::alerts::KEEP_PAST_MS;
use centraid_vault::rusqlite::Connection;
use centraid_vault::time::recurrence::parse_instant_ms;

use super::desired::{self, DEFAULT_PENDING_CAP, Desired, Extra, Inputs, Words};
use crate::error::Result;

/// The tables whose commits can move the set.
const WATCHED: [&str; 8] = [
    "reminder",
    "snooze",
    "task",
    "event",
    "person_date",
    "locker_item_field",
    "entity",
    "vault",
];

/// Whether a commit that wrote `table` can move the set.
#[must_use]
pub fn watches(table: &str) -> bool {
    WATCHED.contains(&table)
}

#[derive(Default)]
struct State {
    cap: usize,
    zone: String,
    locale: String,
    permission: Option<wire::NotificationPermission>,
    asking: bool,
    details: bool,
    offers: BTreeMap<String, Offer>,
    delivered: BTreeSet<String>,
    known: BTreeMap<String, i64>,
    last: Option<Pushed>,
}

#[derive(Clone)]
struct Pushed {
    all: Vec<wire::PendingNotification>,
    live: Vec<String>,
    cancel: Vec<String>,
    ask: bool,
}

/// What one producer wants held and which of its delivered notices are still wanted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Offer {
    pub notices: Vec<Extra>,
    pub wanted: Vec<String>,
}

pub struct Scheduler {
    state: Mutex<State>,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl Scheduler {
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                cap: DEFAULT_PENDING_CAP,
                zone: "UTC".to_owned(),
                details: true,
                ..State::default()
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A shell opened: its cap, its zone, its locale. The next set is whole again.
    pub fn launched(&self, launched: &wire::NotifyLaunched) {
        let mut state = self.lock();
        if launched.pending_cap > 0 {
            state.cap = launched.pending_cap as usize;
        }
        if !launched.zone.is_empty() {
            state.zone.clone_from(&launched.zone);
        }
        state.locale.clone_from(&launched.locale);
        state.last = None;
    }

    /// The member's zone, as the phone last said it.
    #[must_use]
    pub fn zone(&self) -> String {
        self.lock().zone.clone()
    }

    /// Show details on or off (the Settings row): a banner says only that one is due when off.
    pub fn set_details(&self, shown: bool) {
        self.lock().details = shown;
    }

    /// A producer's word: its notices, and which of its delivered ones are still wanted. An empty
    /// offer withdraws it.
    pub fn offer(&self, producer: &str, offer: Offer) -> bool {
        let mut state = self.lock();
        if offer == Offer::default() {
            state.offers.remove(producer).is_some()
        } else {
            state.offers.insert(producer.to_owned(), offer.clone()) != Some(offer)
        }
    }

    /// The member said "Allow notifications": the next set asks the OS, once.
    pub fn ask_permission(&self) {
        self.lock().asking = true;
    }

    /// What the OS said after it applied a set.
    pub fn scheduled(&self, scheduled: &wire::NotificationsScheduled) {
        let mut state = self.lock();
        state.permission = wire::NotificationPermission::try_from(scheduled.permission).ok();
        if state.permission == Some(wire::NotificationPermission::Granted) {
            state.asking = false;
        }
        state.delivered = scheduled
            .delivered
            .iter()
            .map(|each| each.notification_id.clone())
            .collect();
    }

    /// The set as it should be now. `None` when it is what the shell was last given.
    ///
    /// # Errors
    /// The vault's refusal to read the alert index.
    pub fn refresh(
        &self,
        connection: &Connection,
        now_ms: i64,
        words: &dyn Words,
    ) -> Result<Option<wire::ScheduleNotifications>> {
        let mut state = self.lock();
        let extras: Vec<Extra> = {
            let mut all: Vec<Extra> = state
                .offers
                .values()
                .flat_map(|offer| offer.notices.clone())
                .collect();
            all.sort_by(|a, b| (a.fire_at_ms, &a.id).cmp(&(b.fire_at_ms, &b.id)));
            all.dedup_by(|a, b| a.id == b.id);
            all
        };
        let wanted_by_producers: BTreeSet<String> = state
            .offers
            .values()
            .flat_map(|offer| offer.wanted.clone())
            .collect();
        let Desired { all, live } = desired::desired(
            connection,
            &Inputs {
                now_ms,
                zone: &state.zone,
                cap: state.cap,
                details: state.details,
                words,
                extras: &extras,
            },
        )?;
        let wanted: BTreeSet<&str> = all
            .iter()
            .map(|each| each.notification_id.as_str())
            .chain(live.iter().map(String::as_str))
            .chain(wanted_by_producers.iter().map(String::as_str))
            .collect();
        let inside_keep = |id: &str, fire: Option<i64>| {
            let fire = fire.or_else(|| desired::fire_key_of(id).and_then(parse_instant_ms));
            fire.is_none_or(|fire| fire > now_ms - KEEP_PAST_MS)
        };
        let mut cancel: BTreeSet<String> = BTreeSet::new();
        for (id, fire) in &state.known {
            if !wanted.contains(id.as_str()) && inside_keep(id, Some(*fire)) {
                cancel.insert(id.clone());
            }
        }
        for id in &state.delivered {
            if id.starts_with("alert|") && !wanted.contains(id.as_str()) && inside_keep(id, None) {
                cancel.insert(id.clone());
            }
        }
        let mut known: BTreeMap<String, i64> = all
            .iter()
            .map(|each| (each.notification_id.clone(), each.fire_at_ms))
            .collect();
        for id in &live {
            let fire = desired::fire_key_of(id)
                .and_then(parse_instant_ms)
                .unwrap_or(now_ms);
            known.entry(id.clone()).or_insert(fire);
        }
        state.known = known;
        let ask = state.asking && !all.is_empty();
        let pushed = Pushed {
            all,
            live,
            cancel: cancel.into_iter().collect(),
            ask,
        };
        let same = state.last.as_ref().is_some_and(|last| {
            last.all == pushed.all && last.live == pushed.live && last.ask == pushed.ask
        });
        if same && pushed.cancel.is_empty() {
            return Ok(None);
        }
        let schedule = wire::ScheduleNotifications {
            all: pushed.all.clone(),
            categories: desired::categories(words),
            ask_permission: pushed.ask,
            channel_name: words.channel_name(),
            live_ids: pushed.live.clone(),
            backup_channel_name: words.backup_channel_name(),
            completed_answers: Vec::new(),
            retain_delivered: true,
            cancel_delivered_ids: pushed.cancel.clone(),
        };
        state.last = Some(pushed);
        Ok(Some(schedule))
    }
}
