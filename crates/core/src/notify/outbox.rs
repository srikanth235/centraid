//! THE OUTBOX REPLAY (app-plane §9, D7): a shell writes a button press to its outbox before it
//! dismisses the banner and sends it again, with the same id and key, until the core says it is
//! settled. Done is `task.complete`; Snooze is `alert.snooze` an hour from the press. Both
//! commands are idempotent, and a press already run under its id is reported as such and not run
//! again, so a replay after a crash changes nothing.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::clock::format_iso_ms;
use serde_json::{Value, json};

use crate::device::store::{Checked, DeviceStore};

pub const SNOOZE_MS: i64 = 60 * 60 * 1000;
const LEDGER_KEY: &str = "notify.applied";
const LEDGER_MOST: usize = 200;

/// What running one command came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ran {
    Done,
    /// The vault declined, in its own sentence: the item is gone or no longer open.
    Declined(String),
}

pub trait Runner {
    /// # Errors
    /// A failure that is not the vault's refusal; the press stays for the next launch.
    fn run(&self, name: &str, input: &Value, invoke_key: &str) -> Result<Ran, String>;
}

/// The ids of the presses already run.
pub trait Ledger {
    fn has(&self, id: &str) -> bool;
    fn keep(&self, id: &str);
}

#[derive(Default)]
pub struct MemoryLedger(std::sync::Mutex<Vec<String>>);

impl Ledger for MemoryLedger {
    fn has(&self, id: &str) -> bool {
        self.0
            .lock()
            .is_ok_and(|ids| ids.iter().any(|seen| seen == id))
    }

    fn keep(&self, id: &str) {
        if let Ok(mut ids) = self.0.lock() {
            ids.push(id.to_owned());
        }
    }
}

/// The ledger on the device store (`notify.applied`, v1), the last 200 ids.
pub struct DeviceLedger<'a, S: DeviceStore>(pub &'a Checked<S>);

impl<S: DeviceStore> DeviceLedger<'_, S> {
    fn ids(&self) -> Vec<String> {
        self.0
            .get(LEDGER_KEY)
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| {
                value.get("ids").and_then(Value::as_array).map(|ids| {
                    ids.iter()
                        .filter_map(|id| id.as_str().map(str::to_owned))
                        .collect()
                })
            })
            .unwrap_or_default()
    }
}

impl<S: DeviceStore> Ledger for DeviceLedger<'_, S> {
    fn has(&self, id: &str) -> bool {
        self.ids().iter().any(|seen| seen == id)
    }

    fn keep(&self, id: &str) {
        let mut ids = self.ids();
        ids.push(id.to_owned());
        let from = ids.len().saturating_sub(LEDGER_MOST);
        let _ = self.0.put(
            LEDGER_KEY,
            &json!({ "v": 1, "ids": &ids[from..] }).to_string(),
        );
    }
}

fn result(
    press: &wire::NotifyPress,
    outcome: wire::NotifyPressOutcome,
    sentence: &str,
) -> wire::NotifyPressResult {
    wire::NotifyPressResult {
        id: press.id.clone(),
        outcome: outcome as i32,
        sentence: sentence.to_owned(),
    }
}

/// Run each press once.
pub fn replay(
    presses: &[wire::NotifyPress],
    now_ms: i64,
    runner: &dyn Runner,
    ledger: &dyn Ledger,
) -> Vec<wire::NotifyPressResult> {
    use wire::NotifyPressOutcome as O;
    presses
        .iter()
        .map(|press| {
            if ledger.has(&press.id) {
                return result(press, O::Already, "");
            }
            let key = if press.key.is_empty() {
                &press.id
            } else {
                &press.key
            };
            let ran = match wire::NotificationVerb::try_from(press.verb) {
                Ok(wire::NotificationVerb::Done) => {
                    runner.run("task.complete", &json!({ "id": press.entity_id }), key)
                }
                Ok(wire::NotificationVerb::SnoozeHour) => {
                    let until = press.at_ms + SNOOZE_MS;
                    if until <= now_ms {
                        ledger.keep(&press.id);
                        return result(press, O::Expired, "");
                    }
                    let mut input =
                        json!({ "entity_id": press.entity_id, "until": format_iso_ms(until) });
                    if !press.date_id.is_empty() {
                        input["date_id"] = json!(press.date_id);
                    }
                    if !press.field_id.is_empty() {
                        input["field_id"] = json!(press.field_id);
                    }
                    runner.run("alert.snooze", &input, key)
                }
                Ok(wire::NotificationVerb::Open) => Ok(Ran::Done),
                _ => Ok(Ran::Declined("That button does nothing.".to_owned())),
            };
            match ran {
                Ok(Ran::Done) => {
                    ledger.keep(&press.id);
                    result(press, O::Applied, "")
                }
                Ok(Ran::Declined(sentence)) => {
                    ledger.keep(&press.id);
                    result(press, O::Expired, &sentence)
                }
                Err(sentence) => result(press, O::Refused, &sentence),
            }
        })
        .collect()
}
