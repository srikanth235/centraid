//! THE MODEL'S FILES (the chat's download): every decision about which model file to use, what to
//! fetch, what to delete and when to load again. The transfer is the shell's; a shell reports the
//! phone's facts and what its transfers did, and is told the next step.
//!
//! The rules, each held by a test:
//!
//! - **Two models for a release.** The model before the current one still works: the chat uses it
//!   and offers the current one. A model older than that is not usable: the current one is needed.
//!   Once the current model is in use, the files beside it go (the model before it, an older one,
//!   an adapter the release does not name).
//! - **The adapter rides with the model.** One download, one size quoted (the model's and the
//!   adapter's), one bar. It is fetched after the model; when it does not arrive the model runs
//!   alone, silently. With the current model in use and the adapter missing, the adapter alone is
//!   offered, and never fetched until the member asks.
//! - **Nothing is fetched into a phone that cannot keep it or run it.** Not enough free space
//!   (counting both files), not enough memory (3.5 GB; 4 GB is sold), and an unknown amount is not
//!   "too little". On mobile data the member is asked first; Wi-Fi is the default.
//! - **A model never reloads under a running turn.** An adapter that lands during one loads when
//!   the chat opens again.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use centraid_api_proto::core_v1 as wire;

use super::asset::{self, Asset};

/// A phone reports a little under what it is sold as, so the line is drawn under 4 GB.
pub const MIN_MEMORY_BYTES: u64 = 3_500_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Network {
    #[default]
    Unknown,
    Wifi,
    Cellular,
    Offline,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    pub network: Network,
    pub free_bytes: u64,
    pub memory_bytes: u64,
}

impl Facts {
    #[must_use]
    pub fn of(facts: Option<&wire::AssistFacts>) -> Self {
        let Some(facts) = facts else {
            return Self::default();
        };
        Self {
            network: match wire::AssistNetwork::try_from(facts.network) {
                Ok(wire::AssistNetwork::Wifi) => Network::Wifi,
                Ok(wire::AssistNetwork::Cellular) => Network::Cellular,
                Ok(wire::AssistNetwork::Offline) => Network::Offline,
                _ => Network::Unknown,
            },
            free_bytes: facts.free_bytes,
            memory_bytes: facts.memory_bytes,
        }
    }

    /// An unknown amount is not "too little".
    #[must_use]
    pub fn too_little_space(&self, needed: u64) -> bool {
        self.free_bytes > 0 && self.free_bytes < needed
    }

    #[must_use]
    pub fn too_little_memory(&self) -> bool {
        self.memory_bytes > 0 && self.memory_bytes < MIN_MEMORY_BYTES
    }
}

/// What is offered above the composer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Offer {
    /// The current model, and its adapter in the same download.
    Model,
    /// The adapter alone.
    AdapterOnly,
}

impl Offer {
    /// The size the offer quotes.
    #[must_use]
    pub fn bytes(self) -> u64 {
        match self {
            Self::Model => asset::assistant_bytes(),
            Self::AdapterOnly => asset::adapter().map_or(0, |adapter| adapter.bytes),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stand {
    NeedsModel { update_needed: bool },
    UseCurrent,
    UsePrevious,
}

/// Where the files stand.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Standing {
    pub stand: Stand,
    pub offer: Option<Offer>,
    /// Files to delete: only once the current model is the one in use.
    pub delete: Vec<String>,
}

impl Standing {
    #[must_use]
    pub fn on_previous(&self) -> bool {
        self.stand == Stand::UsePrevious
    }

    /// The file to load, or none when a model is needed.
    #[must_use]
    pub fn model(&self) -> Option<Asset> {
        match self.stand {
            Stand::UseCurrent => Some(asset::model()),
            Stand::UsePrevious => asset::previous(),
            Stand::NeedsModel { .. } => None,
        }
    }
}

/// Where the files stand, from what is in the models directory: whether the current model is
/// there, the other model files beside it and the adapter files.
#[must_use]
pub fn standing(current_present: bool, others: &[String], adapters: &[String]) -> Standing {
    let keep = asset::adapter().map(|adapter| adapter.file_name);
    let stale_adapters = adapters
        .iter()
        .filter(|name| Some(name.as_str()) != keep)
        .cloned();
    if !current_present {
        let previous = asset::previous()
            .filter(|previous| others.iter().any(|name| name == previous.file_name));
        return match previous {
            Some(_) => Standing {
                stand: Stand::UsePrevious,
                offer: Some(Offer::Model),
                delete: Vec::new(),
            },
            None => Standing {
                stand: Stand::NeedsModel {
                    update_needed: !others.is_empty(),
                },
                offer: None,
                delete: Vec::new(),
            },
        };
    }
    let missing = asset::adapter()
        .is_some_and(|adapter| !adapters.iter().any(|name| name == adapter.file_name));
    Standing {
        stand: Stand::UseCurrent,
        offer: missing.then_some(Offer::AdapterOnly),
        delete: others.iter().cloned().chain(stale_adapters).collect(),
    }
}

/// What the member chose about mobile data this time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Data {
    Keep,
    Allow,
    WaitForWifi,
}

impl Data {
    #[must_use]
    pub fn of(choice: i32) -> Self {
        match wire::AssistMobileData::try_from(choice) {
            Ok(wire::AssistMobileData::Allow) => Self::Allow,
            Ok(wire::AssistMobileData::WaitForWifi) => Self::WaitForWifi,
            _ => Self::Keep,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    NoMemory,
    NoSpace {
        need: u64,
        free: u64,
    },
    AskMobileData,
    Fetch {
        files: Vec<Asset>,
        allow_mobile_data: bool,
        waits_for_wifi: bool,
    },
}

/// Whether to fetch `files` (counting `need` bytes) and how, from the phone's facts. `held` is what
/// the member chose before about mobile data. A first download on mobile data asks first.
#[must_use]
pub fn decide(
    facts: &Facts,
    files: Vec<Asset>,
    need: u64,
    data: Data,
    held: bool,
    first: bool,
) -> Verdict {
    if facts.too_little_memory() {
        return Verdict::NoMemory;
    }
    if facts.too_little_space(need) {
        return Verdict::NoSpace {
            need,
            free: facts.free_bytes,
        };
    }
    let allow = match data {
        Data::Allow => true,
        Data::WaitForWifi => false,
        Data::Keep => held,
    };
    if first && facts.network == Network::Cellular && !allow && data == Data::Keep {
        return Verdict::AskMobileData;
    }
    let waits = !allow && matches!(facts.network, Network::Cellular | Network::Offline);
    Verdict::Fetch {
        files,
        allow_mobile_data: allow,
        waits_for_wifi: waits,
    }
}

/// What a download step fetches, in order: the model, then its adapter when the release ships one
/// (an adapter alone when that is all that is offered).
#[must_use]
pub fn files_for(offer: Option<Offer>) -> Vec<Asset> {
    match offer {
        Some(Offer::AdapterOnly) => asset::adapter().into_iter().collect(),
        _ => vec![asset::model()],
    }
}

/// How far along the one bar the assistant's download is. The adapter's bytes follow the model's,
/// so the fraction runs over both; a vision transfer, or the adapter alone, runs over itself.
#[must_use]
pub fn fraction(
    done: u64,
    total: u64,
    vision: bool,
    adapter_fetching: bool,
    adapter_only: bool,
) -> Option<f32> {
    let (before, after) = if vision || adapter_fetching && adapter_only {
        (0, 0)
    } else if adapter_fetching {
        (asset::model().bytes, 0)
    } else {
        (0, asset::adapter().map_or(0, |adapter| adapter.bytes))
    };
    (total > 0).then(|| ((done + before) as f32 / (total + before + after) as f32).clamp(0.0, 1.0))
}

/// What the core remembers between a plan and a transfer's end.
#[derive(Default)]
pub struct State {
    cellular_ok: AtomicBool,
    adapter_fetching: AtomicBool,
    adapter_only: AtomicBool,
    reload_pending: AtomicBool,
    on_previous: AtomicBool,
    models_dir: Mutex<String>,
}

fn file_of(asset: Asset, allow: bool, waits: bool) -> wire::AssistFile {
    wire::AssistFile {
        url: asset.url.to_owned(),
        file_name: asset.file_name.to_owned(),
        sha256: asset.sha256.to_owned(),
        bytes: asset.bytes,
        allow_mobile_data: allow,
        waits_for_wifi: waits,
    }
}

impl State {
    pub fn set_dir(&self, dir: &str) {
        if !dir.is_empty() {
            *self
                .models_dir
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = dir.to_owned();
        }
    }

    /// An adapter landed: it loads with the model at once, unless a turn is running; then when the
    /// chat opens again.
    pub fn adapter_landed(&self, turn_running: bool) -> bool {
        if turn_running {
            self.reload_pending.store(true, Ordering::SeqCst);
            false
        } else {
            true
        }
    }

    /// The chat opened: whether a held-back reload happens now.
    pub fn take_reload(&self, turn_running: bool) -> bool {
        !turn_running && self.reload_pending.swap(false, Ordering::SeqCst)
    }

    pub fn set_on_previous(&self, on: bool) {
        self.on_previous.store(on, Ordering::SeqCst);
    }

    #[must_use]
    pub fn on_previous(&self) -> bool {
        self.on_previous.load(Ordering::SeqCst)
    }

    pub fn note_cellular(&self, allow: bool) {
        self.cellular_ok.store(allow, Ordering::SeqCst);
    }

    #[must_use]
    pub fn cellular_ok(&self) -> bool {
        self.cellular_ok.load(Ordering::SeqCst)
    }

    pub fn note_fetching(&self, adapter: bool, adapter_only: bool) {
        self.adapter_fetching.store(adapter, Ordering::SeqCst);
        self.adapter_only.store(adapter_only, Ordering::SeqCst);
    }

    pub fn take_adapter_fetching(&self) -> bool {
        self.adapter_fetching.swap(false, Ordering::SeqCst)
    }

    /// The plan for `intent`: where the files stand, and what to fetch.
    #[must_use]
    pub fn plan(
        &self,
        standing: &Standing,
        facts: &Facts,
        intent: wire::AssistIntent,
        data: Data,
        models_dir: &str,
    ) -> wire::AssistPlan {
        use wire::AssistIntent as I;
        self.set_dir(models_dir);
        self.set_on_previous(standing.on_previous());
        let mut plan = wire::AssistPlan {
            stand: match standing.stand {
                Stand::NeedsModel { .. } => wire::AssistStand::NeedsModel,
                Stand::UseCurrent => wire::AssistStand::UseCurrent,
                Stand::UsePrevious => wire::AssistStand::UsePrevious,
            } as i32,
            update_needed: matches!(
                standing.stand,
                Stand::NeedsModel {
                    update_needed: true
                }
            ),
            offer: match standing.offer {
                None => wire::AssistOffer::Unspecified,
                Some(Offer::Model) => wire::AssistOffer::Model,
                Some(Offer::AdapterOnly) => wire::AssistOffer::AdapterOnly,
            } as i32,
            offer_bytes: standing.offer.map_or(0, Offer::bytes),
            delete: standing.delete.clone(),
            load_path: standing
                .model()
                .map(|model| asset::path(models_dir, &model))
                .unwrap_or_default(),
            ..wire::AssistPlan::default()
        };
        let (files, need, first) = match intent {
            I::Download if matches!(standing.stand, Stand::NeedsModel { .. }) => {
                (files_for(None), asset::assistant_bytes(), true)
            }
            I::Update if standing.offer.is_some() => (
                files_for(standing.offer),
                standing.offer.map_or(0, Offer::bytes),
                false,
            ),
            _ => return plan,
        };
        match decide(facts, files, need, data, self.cellular_ok(), first) {
            Verdict::NoMemory => plan.refusal = wire::AssistPlanRefusal::NoMemory as i32,
            Verdict::NoSpace { need, free } => {
                plan.refusal = wire::AssistPlanRefusal::NoSpace as i32;
                plan.need_bytes = need;
                plan.free_bytes = free;
            }
            Verdict::AskMobileData => {
                plan.refusal = wire::AssistPlanRefusal::AskMobileData as i32;
            }
            Verdict::Fetch {
                files,
                allow_mobile_data,
                waits_for_wifi,
            } => {
                self.note_cellular(allow_mobile_data);
                let adapter_only =
                    standing.offer == Some(Offer::AdapterOnly) && intent == I::Update;
                self.note_fetching(adapter_only, adapter_only);
                plan.fetch = files
                    .into_iter()
                    .map(|file| file_of(file, allow_mobile_data, waits_for_wifi))
                    .collect();
            }
        }
        plan
    }

    /// A transfer ended.
    #[must_use]
    pub fn finished(
        &self,
        which: wire::AssistFinishedWhich,
        ok: bool,
        standing: impl Fn() -> Standing,
        facts: &Facts,
        models_dir: &str,
        turn_running: bool,
    ) -> wire::AssistPlan {
        use wire::AssistFinishedWhich as W;
        self.set_dir(models_dir);
        let was_adapter = self.take_adapter_fetching();
        let mut standing_now = standing();
        match which {
            W::Vision => wire::AssistPlan::default(),
            W::Adapter => {
                let now = self.adapter_landed(turn_running);
                self.plan_after(&mut standing_now, now && ok, models_dir)
            }
            _ if !ok => {
                // A model that did not arrive is a model to fetch again.
                self.plan(
                    &standing_now,
                    facts,
                    wire::AssistIntent::Status,
                    Data::Keep,
                    models_dir,
                )
            }
            _ => {
                // The model arrived. Its adapter is fetched next when the release ships one, none
                // is on the phone and there is room; otherwise the model loads as it is.
                let owed = !was_adapter
                    && asset::adapter().is_some_and(|adapter| {
                        standing_now.offer == Some(Offer::AdapterOnly)
                            && !facts.too_little_space(adapter.bytes)
                    });
                let mut plan = self.plan(
                    &standing_now,
                    facts,
                    wire::AssistIntent::Status,
                    Data::Keep,
                    models_dir,
                );
                if owed && let Some(adapter) = asset::adapter() {
                    self.note_fetching(true, false);
                    let allow = self.cellular_ok();
                    let waits =
                        !allow && matches!(facts.network, Network::Cellular | Network::Offline);
                    plan.fetch = vec![file_of(adapter, allow, waits)];
                    plan.load_path = String::new();
                }
                plan
            }
        }
    }

    fn plan_after(
        &self,
        standing: &mut Standing,
        reload_now: bool,
        models_dir: &str,
    ) -> wire::AssistPlan {
        let mut plan = self.plan(
            standing,
            &Facts::default(),
            wire::AssistIntent::Status,
            Data::Keep,
            models_dir,
        );
        plan.reload = reload_now;
        if !reload_now {
            plan.load_path = String::new();
        }
        plan
    }
}

#[cfg(test)]
mod tests {
    use centraid_assist::record::{Adapter, Entry, Record, held_for};

    use super::*;

    const ADAPTER_FILE: &str = "centraid-adapter-dddddddddddd.gguf";

    fn window_record() -> Record {
        let current = centraid_assist::record::record().current;
        let entry = |file: &str, sha: &str, bytes: u64| Entry {
            url: format!(
                "https://huggingface.co/x/y/resolve/{}/{file}",
                "a".repeat(40)
            ),
            file_name: file.to_owned(),
            sha256: sha.repeat(64),
            bytes,
            ..current.clone()
        };
        Record {
            adapter: None,
            current: entry("New-Q4_0.gguf", "b", 604_000_000),
            previous: Some(entry("Old-Q4_0.gguf", "c", 563_000_000)),
        }
    }

    fn adapter_record() -> Record {
        let mut record = window_record();
        record.adapter = Some(Adapter {
            url: format!(
                "https://huggingface.co/x/adapter/resolve/{}/a.gguf",
                "a".repeat(40)
            ),
            file_name: "a.gguf".to_owned(),
            sha256: "d".repeat(64),
            bytes: 40_000_000,
            base_sha256: record.current.sha256.clone(),
            tools_hash: record.current.tools_hash.clone(),
            prompt_hash: record.current.prompt_hash.clone(),
            score: None,
        });
        record
    }

    fn names(files: &[&str]) -> (bool, Vec<String>, Vec<String>) {
        let prefix = centraid_assist::record::LOCAL_PREFIX;
        let current = files.contains(&"New-Q4_0.gguf");
        let others = files
            .iter()
            .filter(|name| **name != "New-Q4_0.gguf" && !name.starts_with(prefix))
            .map(|name| (*name).to_owned())
            .collect();
        let adapters = files
            .iter()
            .filter(|name| name.starts_with(prefix))
            .map(|name| (*name).to_owned())
            .collect();
        (current, others, adapters)
    }

    fn stand(files: &[&str]) -> Standing {
        let (current, others, adapters) = names(files);
        standing(current, &others, &adapters)
    }

    #[test]
    fn the_offer_cases_in_the_shared_fixture_hold() {
        let text = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../contracts/assist/adapter-offer-cases.json"),
        )
        .unwrap();
        let all: serde_json::Value = serde_json::from_str(&text).unwrap();
        for case in all["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let files: Vec<&str> = case["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|file| file.as_str().unwrap())
                .collect();
            held_for(adapter_record(), || {
                let standing = stand(&files);
                assert_eq!(standing.offer.is_some(), case["row"], "{name}");
                if let Some(offer) = standing.offer {
                    let quote = case["row_size"].as_str().unwrap_or("40.0 MB");
                    let bytes = offer.bytes();
                    let text = if bytes >= 100_000_000 {
                        format!("{} MB", bytes / 1_000_000)
                    } else {
                        format!("{:.1} MB", bytes as f64 / 1_000_000.0)
                    };
                    assert_eq!(text, quote, "{name}");
                }
                let want: Vec<String> = case["deleted"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|file| file.as_str().unwrap().to_owned())
                    .collect();
                assert_eq!(standing.delete, want, "{name}");
            });
        }
    }

    #[test]
    fn the_model_before_the_current_one_keeps_working_and_nothing_is_deleted_yet() {
        held_for(window_record(), || {
            let standing = stand(&["Old-Q4_0.gguf"]);
            assert!(standing.on_previous());
            assert_eq!(standing.offer, Some(Offer::Model));
            assert_eq!(standing.model().unwrap().file_name, "Old-Q4_0.gguf");
            assert!(standing.delete.is_empty());
        });
    }

    #[test]
    fn once_the_current_model_is_in_use_the_old_files_beside_it_go() {
        held_for(window_record(), || {
            let standing = stand(&["New-Q4_0.gguf", "Old-Q4_0.gguf", "Ancient-Q4_0.gguf"]);
            assert_eq!(standing.stand, Stand::UseCurrent);
            assert_eq!(standing.offer, None);
            assert_eq!(standing.delete, ["Old-Q4_0.gguf", "Ancient-Q4_0.gguf"]);
        });
    }

    #[test]
    fn a_model_older_than_the_window_says_an_update_is_needed_and_is_not_deleted_yet() {
        held_for(window_record(), || {
            let standing = stand(&["Ancient-Q4_0.gguf"]);
            assert_eq!(
                standing.stand,
                Stand::NeedsModel {
                    update_needed: true
                }
            );
            assert!(standing.delete.is_empty());
            assert_eq!(
                stand(&[]).stand,
                Stand::NeedsModel {
                    update_needed: false
                }
            );
        });
    }

    #[test]
    fn an_adapter_alone_is_not_a_model_and_does_not_say_an_update_is_needed() {
        held_for(adapter_record(), || {
            assert_eq!(
                stand(&[ADAPTER_FILE]).stand,
                Stand::NeedsModel {
                    update_needed: false
                }
            );
        });
    }

    fn facts(network: Network, free: u64, memory: u64) -> Facts {
        Facts {
            network,
            free_bytes: free,
            memory_bytes: memory,
        }
    }

    #[test]
    fn the_quote_counts_the_adapter_so_a_phone_without_room_for_both_is_told_first() {
        held_for(adapter_record(), || {
            assert_eq!(asset::assistant_bytes(), 644_000_000);
            let state = State::default();
            let plan = state.plan(
                &stand(&[]),
                &facts(Network::Wifi, 620_000_000, 0),
                wire::AssistIntent::Download,
                Data::Keep,
                "/m",
            );
            assert_eq!(plan.refusal, wire::AssistPlanRefusal::NoSpace as i32);
            assert_eq!(
                (plan.need_bytes, plan.free_bytes),
                (644_000_000, 620_000_000)
            );
            assert!(
                plan.fetch.is_empty(),
                "nothing is fetched into a phone without room"
            );
        });
    }

    #[test]
    fn an_unknown_amount_of_space_or_memory_is_not_too_little() {
        held_for(window_record(), || {
            let state = State::default();
            let plan = state.plan(
                &stand(&[]),
                &facts(Network::Wifi, 0, 0),
                wire::AssistIntent::Download,
                Data::Keep,
                "/m",
            );
            assert_eq!(plan.refusal, 0);
            assert_eq!(plan.fetch.len(), 1);
        });
    }

    #[test]
    fn a_phone_with_too_little_memory_is_told_why_and_nothing_is_fetched() {
        held_for(window_record(), || {
            let plan = State::default().plan(
                &stand(&[]),
                &facts(Network::Wifi, 10_000_000_000, 3_000_000_000),
                wire::AssistIntent::Download,
                Data::Keep,
                "/m",
            );
            assert_eq!(plan.refusal, wire::AssistPlanRefusal::NoMemory as i32);
            assert!(plan.fetch.is_empty());
        });
    }

    #[test]
    fn on_mobile_data_the_member_is_asked_first_and_waiting_for_wifi_uses_none() {
        held_for(window_record(), || {
            let state = State::default();
            let cellular = facts(Network::Cellular, 0, 0);
            let asked = state.plan(
                &stand(&[]),
                &cellular,
                wire::AssistIntent::Download,
                Data::Keep,
                "/m",
            );
            assert_eq!(asked.refusal, wire::AssistPlanRefusal::AskMobileData as i32);
            assert!(asked.fetch.is_empty());

            let waits = state.plan(
                &stand(&[]),
                &cellular,
                wire::AssistIntent::Download,
                Data::WaitForWifi,
                "/m",
            );
            assert_eq!(waits.refusal, 0);
            assert!(!waits.fetch[0].allow_mobile_data && waits.fetch[0].waits_for_wifi);

            let spends = state.plan(
                &stand(&[]),
                &cellular,
                wire::AssistIntent::Download,
                Data::Allow,
                "/m",
            );
            assert!(spends.fetch[0].allow_mobile_data && !spends.fetch[0].waits_for_wifi);
            assert!(
                state.cellular_ok(),
                "the choice is kept for the next transfer"
            );
        });
    }

    #[test]
    fn wifi_is_the_default_and_the_download_carries_no_permission_for_mobile_data() {
        held_for(window_record(), || {
            let plan = State::default().plan(
                &stand(&[]),
                &facts(Network::Wifi, 0, 0),
                wire::AssistIntent::Download,
                Data::Keep,
                "/m",
            );
            let file = &plan.fetch[0];
            assert_eq!(file.file_name, "New-Q4_0.gguf");
            assert!(!file.allow_mobile_data && !file.waits_for_wifi);
            assert_eq!(file.sha256, "b".repeat(64));
        });
    }

    #[test]
    fn nothing_is_fetched_until_the_member_taps_and_then_only_the_adapter() {
        held_for(adapter_record(), || {
            let state = State::default();
            let standing = stand(&["New-Q4_0.gguf"]);
            let status = state.plan(
                &standing,
                &Facts::default(),
                wire::AssistIntent::Status,
                Data::Keep,
                "/m",
            );
            assert!(status.fetch.is_empty());
            assert_eq!(status.offer, wire::AssistOffer::AdapterOnly as i32);
            assert_eq!(status.offer_bytes, 40_000_000);
            let update = state.plan(
                &standing,
                &Facts::default(),
                wire::AssistIntent::Update,
                Data::Keep,
                "/m",
            );
            assert_eq!(update.fetch.len(), 1);
            assert_eq!(update.fetch[0].file_name, ADAPTER_FILE);
        });
    }

    #[test]
    fn the_adapter_rides_after_the_model_and_a_missing_adapter_is_not_an_error() {
        held_for(adapter_record(), || {
            let state = State::default();
            let first = state.plan(
                &stand(&[]),
                &Facts::default(),
                wire::AssistIntent::Download,
                Data::Keep,
                "/m",
            );
            assert_eq!(
                first
                    .fetch
                    .iter()
                    .map(|f| f.file_name.as_str())
                    .collect::<Vec<_>>(),
                ["New-Q4_0.gguf"]
            );

            let after_model = state.finished(
                wire::AssistFinishedWhich::Model,
                true,
                || stand(&["New-Q4_0.gguf"]),
                &Facts::default(),
                "/m",
                false,
            );
            assert_eq!(
                after_model.fetch[0].file_name, ADAPTER_FILE,
                "the adapter follows its model"
            );
            assert!(
                after_model.load_path.is_empty(),
                "the model loads once the adapter is in"
            );

            let adapter_failed = state.finished(
                wire::AssistFinishedWhich::Adapter,
                false,
                || stand(&["New-Q4_0.gguf"]),
                &Facts::default(),
                "/m",
                false,
            );
            assert!(adapter_failed.fetch.is_empty());
            assert_eq!(adapter_failed.refusal, 0, "the model runs alone");
        });
    }

    #[test]
    fn a_model_that_did_not_arrive_is_a_model_to_fetch_again() {
        held_for(window_record(), || {
            let state = State::default();
            let plan = state.finished(
                wire::AssistFinishedWhich::Model,
                false,
                || stand(&[]),
                &Facts::default(),
                "/m",
                false,
            );
            assert_eq!(plan.stand, wire::AssistStand::NeedsModel as i32);
            assert!(plan.load_path.is_empty());
        });
    }

    #[test]
    fn an_adapter_that_lands_under_a_running_turn_loads_when_the_chat_opens_again() {
        held_for(adapter_record(), || {
            let state = State::default();
            let during = state.finished(
                wire::AssistFinishedWhich::Adapter,
                true,
                || stand(&["New-Q4_0.gguf", ADAPTER_FILE]),
                &Facts::default(),
                "/m",
                true,
            );
            assert!(!during.reload, "nothing reloads under a running turn");
            assert!(
                !state.take_reload(true),
                "and the turn's end reloads nothing either"
            );
            assert!(
                state.take_reload(false),
                "the chat opening again loads, once"
            );
            assert!(!state.take_reload(false));
        });
    }

    #[test]
    fn an_adapter_that_lands_with_no_turn_running_loads_at_once() {
        held_for(adapter_record(), || {
            let plan = State::default().finished(
                wire::AssistFinishedWhich::Adapter,
                true,
                || stand(&["New-Q4_0.gguf", ADAPTER_FILE]),
                &Facts::default(),
                "/m",
                false,
            );
            assert!(plan.reload);
            assert_eq!(plan.load_path, "/m/New-Q4_0.gguf");
        });
    }

    #[test]
    fn one_bar_runs_over_the_model_and_its_adapter() {
        held_for(adapter_record(), || {
            let model = fraction(302_000_000, 604_000_000, false, false, false).unwrap();
            assert!((model - 302_000_000.0 / 644_000_000.0).abs() < 1e-6);
            let adapter = fraction(20_000_000, 40_000_000, false, true, false).unwrap();
            assert!((adapter - 624_000_000.0 / 644_000_000.0).abs() < 1e-6);
            let alone = fraction(20_000_000, 40_000_000, false, true, true).unwrap();
            assert!((alone - 0.5).abs() < 1e-6);
            assert_eq!(fraction(1, 0, false, false, false), None);
        });
    }
}
