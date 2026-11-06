//! Device-only presentation preference, using the existing device store.
//! Absence pins every metric. Unknown stored keys are ignored across upgrades.
use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;

use super::Metric;
use crate::custody::secrets;

pub const KEY: &str = "health.summary.unpinned";

#[derive(Default)]
pub struct Pins {
    pub loaded: bool,
    hidden: BTreeSet<String>,
    saved: BTreeSet<String>,
    waiting: Option<Waiting>,
}

enum Waiting {
    Read,
    Write(BTreeSet<String>),
}

impl Pins {
    pub fn contains(&self, metric: Metric) -> bool {
        !self.hidden.contains(metric.key())
    }

    pub fn filtered(&self) -> bool {
        !self.hidden.is_empty()
    }

    pub fn attach(&mut self) -> Vec<wire::Effect> {
        if self.loaded || self.waiting.is_some() {
            return Vec::new();
        }
        self.waiting = Some(Waiting::Read);
        vec![effect(wire::secret_op::Op::Get, Vec::new())]
    }

    pub fn toggle(&mut self, key: &str) -> Vec<wire::Effect> {
        if !self.loaded || Metric::of_key(key).is_none() {
            return Vec::new();
        }
        if !self.hidden.remove(key) {
            self.hidden.insert(key.to_owned());
        }
        self.write()
    }

    pub fn reset(&mut self) -> Vec<wire::Effect> {
        if !self.loaded {
            return Vec::new();
        }
        self.hidden.clear();
        self.write()
    }

    fn write(&mut self) -> Vec<wire::Effect> {
        if self.waiting.is_some() || self.hidden == self.saved {
            return Vec::new();
        }
        self.waiting = Some(Waiting::Write(self.hidden.clone()));
        vec![effect(
            wire::secret_op::Op::Set,
            self.hidden
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join(",")
                .into_bytes(),
        )]
    }

    /// Returns whether a save failed. Changes made while writing are serialized.
    pub fn answered(&mut self, answers: &[wire::SecretAnswer]) -> (Vec<wire::Effect>, bool) {
        let Some(pending) = self.waiting.take() else {
            return (Vec::new(), false);
        };
        let answer = answers.first().filter(|answer| answer.ok);
        match pending {
            Waiting::Read => {
                self.loaded = true;
                self.hidden = answer
                    .filter(|answer| answer.found)
                    .map(|answer| {
                        String::from_utf8_lossy(&answer.value)
                            .split(',')
                            .filter(|key| Metric::of_key(key).is_some())
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                self.saved = self.hidden.clone();
            }
            Waiting::Write(written) if answer.is_some() => self.saved = written,
            Waiting::Write(_) => {
                self.hidden = self.saved.clone();
                return (Vec::new(), true);
            }
        }
        (self.write(), false)
    }
}

fn effect(op: wire::secret_op::Op, value: Vec<u8>) -> wire::Effect {
    secrets::effect(vec![wire::SecretOp {
        op: op as i32,
        store: wire::SecretStore::Device as i32,
        key: KEY.to_owned(),
        value,
    }])
}
