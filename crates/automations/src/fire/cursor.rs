//! One durable cursor engine for every trigger (#1020, D-1020-AU1).
//!
//! ## The write-ahead batch, and the two bugs it closes
//!
//! `cursor-engine.ts:1`–`:6`: *a write-ahead pending batch precedes firing,
//! each terminal turn is acknowledged, and position advances only when the
//! batch settles.* Two failures that shape:
//!
//! 1. **The committed position may never point past the last element the batch
//!    delivers.** A capped overflow stays durable for the next tick rather
//!    than becoming a gap.
//! 2. **A failure is COUNTED, not swallowed** (#1014, B1). An element used to
//!    be acknowledged the moment its fire RETURNED — and a handler failure
//!    returns, so a Gmail message whose handler hit a transient error was
//!    consumed and never seen again. Attempts are now counted per element and
//!    spaced by [`RETRY_BACKOFF_MS`]; at [`TRIGGER_MAX_ATTEMPTS`] the element is
//!    **dead-lettered** — recorded on the cursor row with its error, and only
//!    THEN acknowledged.
//! 3. **One failure does not stop the batch.** A failed element is left
//!    unacknowledged with its attempt counted, and delivery continues to the
//!    rest: the committed position still cannot pass it, so nothing is skipped,
//!    but a poisoned message no longer holds the nineteen after it hostage for
//!    the whole backoff.
//!
//! ## What this module is NOT
//!
//! It holds no timer and no task. v0's engine owns `setInterval` and a
//! dormancy notifier; here [`CursorEngine::tick`] is a function the host calls
//! with an instant, so the whole engine is testable without a clock and a
//! seat that is asleep simply does not call it. The host owns when; this owns
//! what.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::cron::floor_minute;
use crate::manifest::{Trigger, TriggerKind};
use crate::signals::{Signal, SignalSink};

use super::cron_cursor::{self, Schedule};

/// Attempts before an element is given up on (#1014, B1).
pub const TRIGGER_MAX_ATTEMPTS: u32 = 5;

/// Backoff between attempts, indexed by attempts already made. The last entry
/// is the ceiling.
pub const RETRY_BACKOFF_MS: [i64; 4] = [15_000, 60_000, 5 * 60_000, 15 * 60_000];

/// How many dead-lettered elements one cursor row keeps.
pub const DEAD_LETTER_KEEP: usize = 20;

/// How many elements one batch may deliver.
pub const DEFAULT_CATCH_UP_CAP: usize = 50;

#[must_use]
pub fn retry_delay_ms(attempts: u32) -> i64 {
    let index = usize::try_from(attempts.saturating_sub(1))
        .unwrap_or(usize::MAX)
        .min(RETRY_BACKOFF_MS.len() - 1);
    RETRY_BACKOFF_MS[index]
}

/// One element a source hands over.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct CursorElement {
    /// A stable source-native id, unique per DELIVERY OCCURRENCE — the run's
    /// idempotency key is derived from it, so a row that leaves and re-enters
    /// unchanged must not collide with the first fire.
    pub position: String,
    pub occurred_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    /// The position committed once THIS element is acknowledged, when the
    /// source has a per-element watermark. Enables safe truncation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_json: Option<String>,
}

/// What a source read produced.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CursorRead {
    /// Ordered, oldest first, never past the cap.
    pub elements: Vec<CursorElement>,
    /// The next source position; `None` preserves the current one.
    pub position_json: Option<String>,
    pub skipped: u32,
    pub window_from: Option<i64>,
    pub window_to: Option<i64>,
    pub gap_reason: Option<String>,
}

/// The `automation_trigger_cursor` row, as this engine reads and writes it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StoredCursor {
    pub source_kind: String,
    pub position_json: Option<String>,
    pub pending_json: Option<String>,
    pub window_from: Option<i64>,
    pub window_to: Option<i64>,
    pub skipped: u32,
    pub gap_reason: Option<String>,
    pub dead_letter_json: Option<String>,
    pub updated_at: i64,
}

/// Where a cursor row lives. The vault's, through
/// `centraid_vault::ledger::automation_cursor` — a trait here because this
/// crate holds no SQL (`sql-confinement`).
pub trait CursorStore {
    fn get(&self, automation_ref: &str, trigger_index: usize) -> Option<StoredCursor>;
    fn put(&self, automation_ref: &str, trigger_index: usize, cursor: &StoredCursor);
    /// Drop cursors outside the declared slot set. Retention follows the
    /// DECLARED slots, enabled or not: a disabled automation keeps its
    /// watermark, and an EMPTY desired set is a no-op rather than a wipe.
    fn retain(&self, _slots: &[(String, usize)]) {}
}

/// The write-ahead batch, as it is serialised into `pending_json`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct PendingBatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_position_json: Option<String>,
    pub elements: Vec<CursorElement>,
    pub acknowledged: Vec<String>,
    /// Failed deliveries per element position (#1014, B1).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attempts: BTreeMap<String, u32>,
    /// Epoch ms before which a failed element is not retried.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub retry_after: BTreeMap<String, i64>,
    #[serde(default)]
    pub skipped: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_from: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_to: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap_reason: Option<String>,
}

/// One element the engine gave up on, as it is stored and reported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeadLetter {
    pub position: String,
    pub occurred_at: i64,
    pub attempts: u32,
    pub error: String,
    pub dead_lettered_at: i64,
}

/// A cursor row's bounded tail, never throwing on a corrupt value: a dead
/// letter is a record, and a record that cannot be parsed must not stop a
/// delivery.
#[must_use]
pub fn read_dead_letters(raw: Option<&str>) -> Vec<DeadLetter> {
    raw.and_then(|json| serde_json::from_str::<Vec<DeadLetter>>(json).ok())
        .unwrap_or_default()
}

fn append_dead_letter(existing: Vec<DeadLetter>, entry: DeadLetter) -> Vec<DeadLetter> {
    let mut out: Vec<DeadLetter> = existing
        .into_iter()
        .filter(|prior| prior.position != entry.position)
        .collect();
    out.push(entry);
    let overflow = out.len().saturating_sub(DEAD_LETTER_KEEP);
    out.drain(..overflow);
    out
}

/// One `(automation, trigger index)` slot the engine drives.
#[derive(Debug, Clone)]
pub struct Registration {
    pub automation_ref: String,
    pub trigger_index: usize,
    pub trigger: Trigger,
    /// Every cron schedule this registration fires, zones resolved at
    /// registration time. **All cron triggers of one automation collapse into
    /// the first cron index's registration** (`registrationsFor`), so a fire
    /// is a fire and not one per expression.
    pub cron_schedules: Vec<Schedule>,
}

impl Registration {
    /// The cursor row's `source_kind`, which is also the identity check: a
    /// trigger edited in place at the same index does not inherit a position
    /// that means nothing to its replacement.
    #[must_use]
    pub fn identity(&self) -> String {
        self.trigger.cursor_identity()
    }
}

/// How one element's delivery ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    Fired,
    /// A sentence, counted against the element's attempts.
    Failed(String),
    /// The owner's background pause covers this ref. **Paused is not
    /// disabled**: nothing is consumed and nothing is acknowledged.
    Paused,
}

/// What the engine hands one element to.
pub trait FireCursor {
    fn fire(&self, input: &FireInput) -> Delivery;
}

/// One element's delivery context.
#[derive(Debug, Clone)]
pub struct FireInput<'a> {
    pub automation_ref: &'a str,
    pub trigger: &'a Trigger,
    pub trigger_index: usize,
    pub source_kind: TriggerKind,
    pub element: &'a CursorElement,
    /// 1 for the first delivery; the run id is keyed by it (#1014, B1).
    pub attempt: u32,
    pub skipped: u32,
    pub window_from: Option<i64>,
    pub window_to: Option<i64>,
    pub gap_reason: Option<&'a str>,
}

/// What one `tick` of one registration did. The engine's whole observable
/// result, so a host does not have to read the cursor row to know.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TickOutcome {
    pub fired: Vec<String>,
    pub failed: Vec<String>,
    pub dead_lettered: Vec<String>,
    pub deferred: Vec<String>,
    /// The pause short-circuit: no read, no element, no write.
    pub paused: bool,
    /// True while a batch still owes a delivery — so the position has NOT
    /// advanced.
    pub pending: bool,
}

/// The engine. Pure but for the store, the fire and the sink it is handed.
pub struct CursorEngine<'a, S: CursorStore, F: FireCursor, K: SignalSink> {
    store: &'a S,
    fire: &'a F,
    signals: &'a K,
    max_attempts: u32,
    catch_up_cap: usize,
}

impl<'a, S: CursorStore, F: FireCursor, K: SignalSink> CursorEngine<'a, S, F, K> {
    pub const fn new(store: &'a S, fire: &'a F, signals: &'a K) -> Self {
        Self {
            store,
            fire,
            signals,
            max_attempts: TRIGGER_MAX_ATTEMPTS,
            catch_up_cap: DEFAULT_CATCH_UP_CAP,
        }
    }

    #[must_use]
    pub const fn with_max_attempts(mut self, attempts: u32) -> Self {
        self.max_attempts = if attempts == 0 { 1 } else { attempts };
        self
    }

    #[must_use]
    pub const fn with_catch_up_cap(mut self, cap: usize) -> Self {
        self.catch_up_cap = if cap == 0 { 1 } else { cap };
        self
    }

    /// Is this registration due at `at`?
    ///
    /// A cron reader owns its whole window, so it is ALWAYS due — deciding
    /// otherwise on the current minute would defer a caught-up 09:00 by a day.
    /// Every other kind rides its own gate expression, matched in UTC because
    /// a polling interval is a rate and not a wall-clock appointment.
    #[must_use]
    pub fn is_due(registration: &Registration, at: i64) -> bool {
        match &registration.trigger {
            Trigger::Cron { .. } => true,
            Trigger::Webhook(_) => false,
            other => other.schedule_expr().is_some_and(|expr| {
                crate::cron::FireZone::named("UTC")
                    .is_ok_and(|utc| crate::cron::matches(expr, at, &utc))
            }),
        }
    }

    /// Drive one registration once. `read` supplies non-cron sources; cron is
    /// computed here.
    pub fn tick(
        &self,
        registration: &Registration,
        at: i64,
        paused: bool,
        read: impl FnOnce(Option<&StoredCursor>) -> CursorRead,
    ) -> TickOutcome {
        // PAUSED, NOT DISABLED (#528). Stopping here rather than at the fire is
        // the difference between a pause that costs nothing and one that reads
        // a cursor, consumes its element and throws the result away.
        if paused {
            self.signals.raise(Signal::RecipePaused {
                automation_ref: registration.automation_ref.clone(),
            });
            return TickOutcome {
                paused: true,
                ..TickOutcome::default()
            };
        }
        let identity = registration.identity();
        let stored = self
            .store
            .get(&registration.automation_ref, registration.trigger_index);
        // Trigger changed in place at the same index: the old position is
        // meaningless to its replacement.
        let cursor = stored
            .as_ref()
            .filter(|row| row.source_kind == identity)
            .cloned();
        let prior = cursor
            .as_ref()
            .and_then(|row| row.pending_json.as_deref())
            .and_then(|json| serde_json::from_str::<PendingBatch>(json).ok());

        // A WRITE-AHEAD BATCH IS AUTHORITATIVE UNTIL IT SETTLES: re-reading
        // could collapse cron to a newer due instant, or let retention drop
        // payloads before a restart delivers them.
        let result = match &prior {
            Some(pending) => CursorRead {
                elements: pending.elements.clone(),
                position_json: pending.target_position_json.clone(),
                skipped: pending.skipped,
                window_from: pending.window_from,
                window_to: pending.window_to,
                gap_reason: pending.gap_reason.clone(),
            },
            None => match &registration.trigger {
                Trigger::Cron { .. } => {
                    cron_cursor::read(&registration.cron_schedules, cursor.as_ref(), at)
                }
                _ => read(cursor.as_ref()),
            },
        };

        let mut elements = result.elements.clone();
        let overflowed = elements.len() > self.catch_up_cap;
        elements.truncate(self.catch_up_cap);
        // INVARIANT: the committed position may never point past the last
        // element this batch delivers; capped overflow stays durable for the
        // next tick, not a gap.
        let target_position_json = if overflowed {
            elements
                .last()
                .and_then(|element| element.position_json.clone())
                .or_else(|| cursor.as_ref().and_then(|row| row.position_json.clone()))
        } else {
            result
                .position_json
                .clone()
                .or_else(|| cursor.as_ref().and_then(|row| row.position_json.clone()))
        };

        let mut state = BatchState {
            acknowledged: prior
                .as_ref()
                .map(|pending| pending.acknowledged.iter().cloned().collect())
                .unwrap_or_default(),
            attempts: prior
                .as_ref()
                .map(|pending| pending.attempts.clone())
                .unwrap_or_default(),
            retry_after: prior
                .as_ref()
                .map(|pending| pending.retry_after.clone())
                .unwrap_or_default(),
            dead_letters: read_dead_letters(
                stored
                    .as_ref()
                    .and_then(|row| row.dead_letter_json.as_deref()),
            ),
            dead_letters_dirty: false,
        };

        let mut outcome = TickOutcome::default();
        if elements.is_empty() {
            // Only a real state change earns a write.
            let position_moved = target_position_json.is_some()
                && target_position_json
                    != cursor.as_ref().and_then(|row| row.position_json.clone());
            let identity_moved = stored
                .as_ref()
                .is_some_and(|row| row.source_kind != identity);
            let had_pending = stored
                .as_ref()
                .is_some_and(|row| row.pending_json.is_some());
            if position_moved || identity_moved || had_pending {
                self.write(
                    registration,
                    &identity,
                    at,
                    &result,
                    target_position_json.clone(),
                    cursor.as_ref(),
                    None,
                    &state,
                );
            }
            return outcome;
        }

        let pending_of = |state: &BatchState| PendingBatch {
            target_position_json: target_position_json.clone(),
            elements: elements.clone(),
            acknowledged: state.acknowledged.iter().cloned().collect(),
            attempts: state.attempts.clone(),
            retry_after: state.retry_after.clone(),
            skipped: result.skipped,
            window_from: result.window_from,
            window_to: result.window_to,
            gap_reason: result.gap_reason.clone(),
        };

        // DURABLE INTENT PRECEDES ANY SIDE EFFECT: the committed position stays
        // unchanged until every terminal turn is receipted.
        let batch = pending_of(&state);
        self.write(
            registration,
            &identity,
            at,
            &result,
            target_position_json.clone(),
            cursor.as_ref(),
            Some(&batch),
            &state,
        );

        for element in &elements {
            if state.acknowledged.contains(&element.position) {
                continue;
            }
            if state
                .retry_after
                .get(&element.position)
                .is_some_and(|until| at < *until)
            {
                outcome.deferred.push(element.position.clone());
                continue;
            }
            let attempt = state.attempts.get(&element.position).copied().unwrap_or(0) + 1;
            let input = FireInput {
                automation_ref: &registration.automation_ref,
                trigger: &registration.trigger,
                trigger_index: registration.trigger_index,
                source_kind: registration.trigger.kind(),
                element,
                attempt,
                skipped: result.skipped,
                window_from: result.window_from,
                window_to: result.window_to,
                gap_reason: result.gap_reason.as_deref(),
            };
            match self.fire.fire(&input) {
                Delivery::Fired => {
                    state.attempts.remove(&element.position);
                    state.retry_after.remove(&element.position);
                    state.acknowledged.insert(element.position.clone());
                    outcome.fired.push(element.position.clone());
                }
                Delivery::Paused => {
                    // A pause reached at the fire is the backstop for a fire
                    // that arrived by another road: nothing is acknowledged.
                    outcome.paused = true;
                    self.signals.raise(Signal::RecipePaused {
                        automation_ref: registration.automation_ref.clone(),
                    });
                    break;
                }
                Delivery::Failed(error) => {
                    if attempt >= self.max_attempts {
                        let entry = DeadLetter {
                            position: element.position.clone(),
                            occurred_at: element.occurred_at,
                            attempts: attempt,
                            error: error.clone(),
                            dead_lettered_at: at,
                        };
                        state.dead_letters =
                            append_dead_letter(std::mem::take(&mut state.dead_letters), entry);
                        state.dead_letters_dirty = true;
                        state.attempts.remove(&element.position);
                        state.retry_after.remove(&element.position);
                        // ACKNOWLEDGED ONLY HERE — after the element is
                        // durably recorded as given up on. That ordering is
                        // the whole difference from the silent ack it replaces.
                        state.acknowledged.insert(element.position.clone());
                        outcome.dead_lettered.push(element.position.clone());
                        self.signals.raise(Signal::ElementDeadLettered {
                            automation_ref: registration.automation_ref.clone(),
                            position: element.position.clone(),
                            attempts: attempt,
                            error,
                        });
                    } else {
                        state.attempts.insert(element.position.clone(), attempt);
                        state
                            .retry_after
                            .insert(element.position.clone(), at + retry_delay_ms(attempt));
                        outcome.failed.push(element.position.clone());
                    }
                }
            }
            let batch = pending_of(&state);
            self.write(
                registration,
                &identity,
                at,
                &result,
                target_position_json.clone(),
                cursor.as_ref(),
                Some(&batch),
                &state,
            );
        }

        // A batch with an element still owed stays PENDING: the next tick
        // re-reads it from the cursor row and retries once its backoff elapses.
        let owed = elements
            .iter()
            .any(|element| !state.acknowledged.contains(&element.position));
        outcome.pending = owed;
        let settled = pending_of(&state);
        self.write(
            registration,
            &identity,
            at,
            &result,
            target_position_json,
            cursor.as_ref(),
            owed.then_some(&settled),
            &state,
        );
        outcome
    }

    #[allow(clippy::too_many_arguments)]
    fn write(
        &self,
        registration: &Registration,
        identity: &str,
        at: i64,
        result: &CursorRead,
        target_position_json: Option<String>,
        cursor: Option<&StoredCursor>,
        pending: Option<&PendingBatch>,
        state: &BatchState,
    ) {
        let row = StoredCursor {
            source_kind: identity.to_owned(),
            // WHILE A BATCH IS PENDING the stored position is the OLD one.
            position_json: if pending.is_some() {
                cursor.and_then(|row| row.position_json.clone())
            } else {
                target_position_json
            },
            pending_json: pending
                .map(|batch| serde_json::to_string(batch).unwrap_or_else(|_| "null".to_owned())),
            window_from: result.window_from,
            window_to: result.window_to,
            skipped: result.skipped,
            gap_reason: result.gap_reason.clone(),
            dead_letter_json: if state.dead_letters_dirty {
                serde_json::to_string(&state.dead_letters).ok()
            } else {
                cursor.and_then(|row| row.dead_letter_json.clone())
            },
            updated_at: at,
        };
        self.store.put(
            &registration.automation_ref,
            registration.trigger_index,
            &row,
        );
    }
}

struct BatchState {
    acknowledged: BTreeSet<String>,
    attempts: BTreeMap<String, u32>,
    retry_after: BTreeMap<String, i64>,
    dead_letters: Vec<DeadLetter>,
    dead_letters_dirty: bool,
}

/// The registrations one automation contributes — one per trigger, EXCEPT cron:
/// all cron triggers collapse into the first cron index's registration.
///
/// A `ZoneUnset` refusal is per automation and not per trigger: a schedule
/// whose zone cannot be resolved contributes NO registration, and the caller
/// gets the refusal to signal.
pub fn registrations_for(
    automation_ref: &str,
    triggers: &[Trigger],
    vault_zone: Option<&str>,
) -> Result<Vec<Registration>, (String, crate::cron::ZoneUnset)> {
    let mut schedules = Vec::new();
    for trigger in triggers {
        if let Trigger::Cron { expr, tz, backfill } = trigger {
            let zone = crate::cron::FireZone::resolve(tz.as_deref(), vault_zone)
                .map_err(|error| (expr.clone(), error))?;
            schedules.push(Schedule {
                expr: expr.clone(),
                zone,
                backfill: *backfill,
            });
        }
    }
    let first_cron = triggers
        .iter()
        .position(|trigger| trigger.kind() == TriggerKind::Cron);
    Ok(triggers
        .iter()
        .enumerate()
        .filter_map(|(trigger_index, trigger)| {
            if trigger.kind() == TriggerKind::Cron {
                if Some(trigger_index) != first_cron {
                    return None;
                }
                return Some(Registration {
                    automation_ref: automation_ref.to_owned(),
                    trigger_index,
                    trigger: trigger.clone(),
                    cron_schedules: schedules.clone(),
                });
            }
            Some(Registration {
                automation_ref: automation_ref.to_owned(),
                trigger_index,
                trigger: trigger.clone(),
                cron_schedules: Vec::new(),
            })
        })
        .collect())
}

/// Every declared slot, enabled or not, for [`CursorStore::retain`].
#[must_use]
pub fn retention_slots(rows: &[(String, usize)]) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    for (automation_ref, trigger_count) in rows {
        for index in 0..*trigger_count {
            out.push((automation_ref.clone(), index));
        }
    }
    out
}

/// The minute a tick belongs to, so a host that calls twice inside one minute
/// does not read the same cron window twice.
#[must_use]
pub const fn tick_minute(at: i64) -> i64 {
    floor_minute(at)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::manifest::Backfill;
    use crate::signals::Recording;

    #[derive(Default)]
    struct MemoryStore(RefCell<BTreeMap<(String, usize), StoredCursor>>);

    impl CursorStore for MemoryStore {
        fn get(&self, automation_ref: &str, trigger_index: usize) -> Option<StoredCursor> {
            self.0
                .borrow()
                .get(&(automation_ref.to_owned(), trigger_index))
                .cloned()
        }

        fn put(&self, automation_ref: &str, trigger_index: usize, cursor: &StoredCursor) {
            self.0
                .borrow_mut()
                .insert((automation_ref.to_owned(), trigger_index), cursor.clone());
        }

        fn retain(&self, slots: &[(String, usize)]) {
            self.0
                .borrow_mut()
                .retain(|key, _| slots.contains(&(key.0.clone(), key.1)));
        }
    }

    /// Fails the first `fail_times` deliveries of every element, then succeeds.
    struct Flaky {
        fail_times: RefCell<BTreeMap<String, u32>>,
        budget: u32,
        calls: RefCell<Vec<(String, u32)>>,
    }

    impl Flaky {
        fn new(budget: u32) -> Self {
            Self {
                fail_times: RefCell::new(BTreeMap::new()),
                budget,
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl FireCursor for Flaky {
        fn fire(&self, input: &FireInput<'_>) -> Delivery {
            self.calls
                .borrow_mut()
                .push((input.element.position.clone(), input.attempt));
            let mut failures = self.fail_times.borrow_mut();
            let seen = failures.entry(input.element.position.clone()).or_insert(0);
            if *seen < self.budget {
                *seen += 1;
                return Delivery::Failed(format!("transient {}", *seen));
            }
            Delivery::Fired
        }
    }

    struct AlwaysFires;

    impl FireCursor for AlwaysFires {
        fn fire(&self, _input: &FireInput<'_>) -> Delivery {
            Delivery::Fired
        }
    }

    fn data_registration() -> Registration {
        let entity = crate::watch::Watchable::resolve("core.document").expect("life data");
        Registration {
            automation_ref: "reconcile/reconcile".to_owned(),
            trigger_index: 0,
            trigger: Trigger::Data {
                entities: vec![entity],
                every: None,
            },
            cron_schedules: Vec::new(),
        }
    }

    fn element(position: &str, at: i64) -> CursorElement {
        CursorElement {
            position: position.to_owned(),
            occurred_at: at,
            payload: None,
            position_json: Some(format!("\"{position}\"")),
        }
    }

    #[test]
    fn a_fired_batch_settles_and_the_position_advances() {
        let store = MemoryStore::default();
        let signals = Recording::new();
        let engine = CursorEngine::new(&store, &AlwaysFires, &signals);
        let registration = data_registration();
        let outcome = engine.tick(&registration, 1_000, false, |_| CursorRead {
            elements: vec![element("a", 900), element("b", 950)],
            position_json: Some("\"b\"".to_owned()),
            ..CursorRead::default()
        });
        assert_eq!(outcome.fired, ["a", "b"]);
        assert!(!outcome.pending);
        let row = store.get(&registration.automation_ref, 0).expect("a row");
        assert_eq!(row.position_json.as_deref(), Some("\"b\""));
        assert!(
            row.pending_json.is_none(),
            "a settled batch leaves no write-ahead record"
        );
    }

    /// THE #1014 B1 BUG. A transient failure is COUNTED, the position does NOT
    /// advance, and the element comes back.
    #[test]
    fn a_failed_element_is_counted_and_the_position_does_not_advance() {
        let store = MemoryStore::default();
        let signals = Recording::new();
        let fire = Flaky::new(1);
        let engine = CursorEngine::new(&store, &fire, &signals);
        let registration = data_registration();
        let read = || CursorRead {
            elements: vec![element("a", 900)],
            position_json: Some("\"a\"".to_owned()),
            ..CursorRead::default()
        };
        let first = engine.tick(&registration, 1_000, false, |_| read());
        assert_eq!(first.failed, ["a"]);
        assert!(first.pending, "the batch still owes a delivery");
        let row = store.get(&registration.automation_ref, 0).expect("a row");
        assert!(
            row.position_json.is_none(),
            "the committed position may not pass an unacknowledged element"
        );
        assert!(row.pending_json.is_some());
        // Inside the backoff: deferred, not retried.
        let deferred = engine.tick(&registration, 1_001, false, |_| read());
        assert_eq!(deferred.deferred, ["a"]);
        assert_eq!(fire.calls.borrow().len(), 1, "the backoff was honoured");
        // Past the backoff: retried, with attempt 2, and it settles.
        let retry = engine.tick(&registration, 1_000 + retry_delay_ms(1) + 1, false, |_| {
            read()
        });
        assert_eq!(retry.fired, ["a"]);
        assert_eq!(fire.calls.borrow()[1], ("a".to_owned(), 2));
        let row = store.get(&registration.automation_ref, 0).expect("a row");
        assert_eq!(row.position_json.as_deref(), Some("\"a\""));
    }

    /// ONE FAILURE DOES NOT STOP THE BATCH: a poisoned element does not hold
    /// the rest hostage.
    #[test]
    fn a_poisoned_element_does_not_hold_the_batch_behind_it() {
        struct OnlyBFails;
        impl FireCursor for OnlyBFails {
            fn fire(&self, input: &FireInput<'_>) -> Delivery {
                if input.element.position == "b" {
                    Delivery::Failed("poison".to_owned())
                } else {
                    Delivery::Fired
                }
            }
        }
        let store = MemoryStore::default();
        let signals = Recording::new();
        let engine = CursorEngine::new(&store, &OnlyBFails, &signals);
        let registration = data_registration();
        let outcome = engine.tick(&registration, 1_000, false, |_| CursorRead {
            elements: vec![element("a", 1), element("b", 2), element("c", 3)],
            position_json: Some("\"c\"".to_owned()),
            ..CursorRead::default()
        });
        assert_eq!(outcome.fired, ["a", "c"], "c is not held behind b");
        assert_eq!(outcome.failed, ["b"]);
        assert!(outcome.pending);
        let row = store.get(&registration.automation_ref, 0).expect("a row");
        assert!(row.position_json.is_none(), "nothing is skipped");
    }

    /// The dead letter, and the ORDERING that matters: recorded first, only
    /// then acknowledged.
    #[test]
    fn an_element_at_the_cap_is_recorded_before_it_is_acknowledged() {
        let store = MemoryStore::default();
        let signals = Recording::new();
        let fire = Flaky::new(99);
        let engine = CursorEngine::new(&store, &fire, &signals).with_max_attempts(2);
        let registration = data_registration();
        let read = || CursorRead {
            elements: vec![element("a", 900)],
            position_json: Some("\"a\"".to_owned()),
            ..CursorRead::default()
        };
        let mut at = 1_000;
        let first = engine.tick(&registration, at, false, |_| read());
        assert_eq!(first.failed, ["a"]);
        at += retry_delay_ms(1) + 1;
        let second = engine.tick(&registration, at, false, |_| read());
        assert_eq!(second.dead_lettered, ["a"]);
        assert!(!second.pending, "the batch may now settle past it");
        let row = store.get(&registration.automation_ref, 0).expect("a row");
        let letters = read_dead_letters(row.dead_letter_json.as_deref());
        assert_eq!(letters.len(), 1);
        assert_eq!(letters[0].position, "a");
        assert_eq!(letters[0].attempts, 2);
        assert_eq!(row.position_json.as_deref(), Some("\"a\""));
        assert_eq!(signals.codes(), ["automation.element-dead-lettered"]);
    }

    #[test]
    fn a_dead_letter_tail_is_bounded_and_replaces_by_position() {
        let mut letters = Vec::new();
        for index in 0..DEAD_LETTER_KEEP + 5 {
            letters = append_dead_letter(
                letters,
                DeadLetter {
                    position: format!("p{index}"),
                    occurred_at: 0,
                    attempts: 5,
                    error: "x".to_owned(),
                    dead_lettered_at: 0,
                },
            );
        }
        assert_eq!(letters.len(), DEAD_LETTER_KEEP);
        assert_eq!(letters[0].position, "p5", "the oldest fall off the front");
        let replaced = append_dead_letter(
            letters.clone(),
            DeadLetter {
                position: "p10".to_owned(),
                occurred_at: 0,
                attempts: 9,
                error: "again".to_owned(),
                dead_lettered_at: 1,
            },
        );
        assert_eq!(replaced.len(), DEAD_LETTER_KEEP);
        assert_eq!(
            replaced
                .iter()
                .filter(|entry| entry.position == "p10")
                .count(),
            1
        );
        assert_eq!(replaced.last().expect("newest").attempts, 9);
        assert!(read_dead_letters(Some("{not json")).is_empty());
        assert!(read_dead_letters(None).is_empty());
    }

    /// PAUSED IS NOT DISABLED: no read, no element, no write — and a signal.
    #[test]
    fn a_paused_registration_reads_nothing_at_all() {
        let store = MemoryStore::default();
        let signals = Recording::new();
        let engine = CursorEngine::new(&store, &AlwaysFires, &signals);
        let registration = data_registration();
        let mut read_calls = 0;
        let outcome = engine.tick(&registration, 1_000, true, |_| {
            read_calls += 1;
            CursorRead::default()
        });
        assert!(outcome.paused);
        assert_eq!(read_calls, 0, "a pause costs nothing");
        assert!(store.get(&registration.automation_ref, 0).is_none());
        assert_eq!(signals.codes(), ["automation.recipe-paused"]);
    }

    #[test]
    fn a_capped_overflow_stays_durable_rather_than_becoming_a_gap() {
        let store = MemoryStore::default();
        let signals = Recording::new();
        let engine = CursorEngine::new(&store, &AlwaysFires, &signals).with_catch_up_cap(2);
        let registration = data_registration();
        let outcome = engine.tick(&registration, 1_000, false, |_| CursorRead {
            elements: vec![element("a", 1), element("b", 2), element("c", 3)],
            position_json: Some("\"c\"".to_owned()),
            ..CursorRead::default()
        });
        assert_eq!(outcome.fired, ["a", "b"]);
        let row = store.get(&registration.automation_ref, 0).expect("a row");
        assert_eq!(
            row.position_json.as_deref(),
            Some("\"b\""),
            "the committed position is the last DELIVERED element, never the read's end"
        );
    }

    /// A restart mid-retry resumes the SAME count, because the batch is on the
    /// row rather than in memory.
    #[test]
    fn a_pending_batch_survives_a_restart_and_keeps_its_attempt_count() {
        let store = MemoryStore::default();
        let signals = Recording::new();
        let fire = Flaky::new(99);
        let registration = data_registration();
        {
            let engine = CursorEngine::new(&store, &fire, &signals).with_max_attempts(3);
            engine.tick(&registration, 1_000, false, |_| CursorRead {
                elements: vec![element("a", 1)],
                position_json: Some("\"a\"".to_owned()),
                ..CursorRead::default()
            });
        }
        // A FRESH engine over the same store, and a read that would produce
        // NOTHING: the pending batch is authoritative.
        let engine = CursorEngine::new(&store, &fire, &signals).with_max_attempts(3);
        let outcome = engine.tick(&registration, 1_000 + retry_delay_ms(1) + 1, false, |_| {
            CursorRead::default()
        });
        assert_eq!(outcome.failed, ["a"]);
        assert_eq!(
            fire.calls.borrow()[1].1,
            2,
            "attempt 2, not a fresh attempt 1"
        );
    }

    #[test]
    fn a_trigger_replaced_at_the_same_index_does_not_inherit_a_position() {
        let store = MemoryStore::default();
        store.put(
            "reconcile/reconcile",
            0,
            &StoredCursor {
                source_kind: "condition".to_owned(),
                position_json: Some("[\"hash\"]".to_owned()),
                ..StoredCursor::default()
            },
        );
        let signals = Recording::new();
        let engine = CursorEngine::new(&store, &AlwaysFires, &signals);
        let registration = data_registration();
        let mut seen: Option<Option<StoredCursor>> = None;
        engine.tick(&registration, 1_000, false, |cursor| {
            seen = Some(cursor.cloned());
            CursorRead::default()
        });
        assert_eq!(
            seen.expect("the read ran"),
            None,
            "a `data` reader must not be handed a `condition` position"
        );
    }

    #[test]
    fn cron_collapses_into_one_registration_and_an_unset_zone_refuses_the_lot() {
        let triggers = vec![
            Trigger::Cron {
                expr: "0 7 * * *".to_owned(),
                tz: None,
                backfill: Backfill::Latest,
            },
            Trigger::Cron {
                expr: "0 19 * * *".to_owned(),
                tz: None,
                backfill: Backfill::Each,
            },
            Trigger::Webhook(crate::manifest::WebhookState::Pending),
        ];
        let registrations =
            registrations_for("digest/digest", &triggers, Some("Asia/Kolkata")).expect("a zone");
        assert_eq!(
            registrations.len(),
            2,
            "two cron triggers, one registration"
        );
        assert_eq!(registrations[0].cron_schedules.len(), 2);
        assert_eq!(registrations[1].trigger_index, 2);
        // With no zone anywhere: refused, and the EXPRESSION is named so the
        // signal can say which schedule.
        let (expr, error) =
            registrations_for("digest/digest", &triggers, None).expect_err("no zone is a refusal");
        assert_eq!(expr, "0 7 * * *");
        assert_eq!(error, crate::cron::ZoneUnset::Missing);
    }

    #[test]
    fn retention_covers_declared_slots_and_an_empty_set_is_a_no_op() {
        let store = MemoryStore::default();
        store.put("a/a", 0, &StoredCursor::default());
        store.put("a/a", 1, &StoredCursor::default());
        store.put("b/b", 0, &StoredCursor::default());
        let slots = retention_slots(&[("a/a".to_owned(), 2)]);
        assert_eq!(slots.len(), 2);
        store.retain(&slots);
        assert!(store.get("a/a", 1).is_some());
        assert!(store.get("b/b", 0).is_none());
        // An empty desired set is a no-op at the CALLER, which is where v0
        // puts the guard; `retain(&[])` would wipe, so it is never called.
        assert!(retention_slots(&[]).is_empty());
    }

    #[test]
    fn a_cron_registration_is_always_due_and_a_webhook_never_ticks() {
        let cron = Registration {
            automation_ref: "a/a".to_owned(),
            trigger_index: 0,
            trigger: Trigger::Cron {
                expr: "0 7 * * *".to_owned(),
                tz: None,
                backfill: Backfill::Latest,
            },
            cron_schedules: Vec::new(),
        };
        assert!(CursorEngine::<MemoryStore, AlwaysFires, Recording>::is_due(
            &cron, 0
        ));
        let webhook = Registration {
            automation_ref: "a/a".to_owned(),
            trigger_index: 1,
            trigger: Trigger::Webhook(crate::manifest::WebhookState::Pending),
            cron_schedules: Vec::new(),
        };
        assert!(
            !CursorEngine::<MemoryStore, AlwaysFires, Recording>::is_due(&webhook, 0),
            "a doorbell is not reached by a tick"
        );
        // A data trigger rides its gate: the default is every minute.
        let data = data_registration();
        assert!(CursorEngine::<MemoryStore, AlwaysFires, Recording>::is_due(
            &data,
            1_767_225_600_000
        ));
        assert_eq!(tick_minute(1_767_225_659_999), 1_767_225_600_000);
    }
}
