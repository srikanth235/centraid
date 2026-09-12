//! The spine, end to end: every signal has a call site, the weights half is
//! wired, and a trigger loop is impossible by construction (#1020, lane
//! automations).
//!
//! These are the claims the lane's exit criterion makes that no unit test can
//! make alone, because each one is about the crate as a whole rather than about
//! one module.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use centraid_automations::fire::cursor::{
    CursorElement, CursorEngine, CursorRead, CursorStore, Delivery, FireCursor, FireInput,
    Registration, StoredCursor,
};
use centraid_automations::handler::{NoNetwork, TargetLedger, TargetProblem, TargetRecord};
use centraid_automations::manifest::{Backfill, Trigger};
use centraid_automations::signals::{Recording, Signal};
use centraid_automations::{fire, manifest, watch};

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
}

struct AlwaysFails;

impl FireCursor for AlwaysFails {
    fn fire(&self, _input: &FireInput<'_>) -> Delivery {
        Delivery::Failed("the handler threw".to_owned())
    }
}

/// EVERY SIGNAL VARIANT HAS A CALL SITE IN THE CRATE.
///
/// The value of this test is not that five signals exist — it is that none of
/// them is a value nothing ever raises. A refusal with no call site is exactly
/// the log line D-1020-AU7 exists to replace.
#[test]
fn every_signal_variant_is_raised_by_the_spine() {
    let signals = Recording::new();

    // 1. ZoneUnset — a cron trigger with no zone anywhere.
    let unzoned = [Trigger::Cron {
        expr: "0 7 * * *".to_owned(),
        tz: None,
        backfill: Backfill::Latest,
    }];
    let registrations = fire::register("digest/digest", &unzoned, None, &signals);
    assert!(
        registrations.is_empty(),
        "a schedule with no zone is not registered — it is refused and said so"
    );

    // 2. RecipePaused — a paused registration.
    let store = MemoryStore::default();
    let engine = CursorEngine::new(&store, &AlwaysFails, &signals).with_max_attempts(1);
    let entity = watch::Watchable::resolve("core.document").expect("life data");
    let registration = Registration {
        automation_ref: "reconcile/reconcile".to_owned(),
        trigger_index: 0,
        trigger: Trigger::Data {
            entities: vec![entity],
            every: None,
        },
        cron_schedules: Vec::new(),
    };
    engine.tick(&registration, 1_000, true, |_| CursorRead::default());

    // 3. ElementDeadLettered — one attempt, one failure, one cap.
    engine.tick(&registration, 2_000, false, |_| CursorRead {
        elements: vec![CursorElement {
            position: "msg-9".to_owned(),
            occurred_at: 1_900,
            payload: None,
            position_json: Some("\"msg-9\"".to_owned()),
        }],
        position_json: Some("\"msg-9\"".to_owned()),
        ..CursorRead::default()
    });

    // 4. TargetDeclined — a permanent failure declines on the first count.
    let (disposition, _) = TargetLedger::default().count(
        &TargetProblem::Permanent("past the extractor's byte ceiling".to_owned()),
        TargetRecord::default(),
    );
    fire::record_target(
        "photo-ocr",
        "media.asset",
        "asset-7",
        &disposition,
        &signals,
    );

    // 5. CapabilityUnavailable — a host with no network.
    let lock = centraid_media::models::Lock::parse(
        r#"{"schemaVersion":1,"files":[{"model":"yunet-arcface@1","path":"faces/yunet.onnx",
            "capabilities":["faces"],"bytes":4,"sha256":"1111111111111111111111111111111111111111111111111111111111111111",
            "license":"MIT","url":"https://example.test/yunet.onnx"}]}"#,
    )
    .expect("a lock");
    let runtime = tempfile::tempdir().expect("a directory");
    let armed = fire::arm_capability(&lock, runtime.path(), "faces", Some(&NoNetwork), &signals);
    assert!(!armed, "an unfetchable capability is not armed");

    let raised: BTreeSet<&str> = signals.codes().into_iter().collect();
    assert_eq!(
        raised,
        BTreeSet::from([
            "automation.zone-unset",
            "automation.recipe-paused",
            "automation.element-dead-lettered",
            "enrichment.target-declined",
            "enrichment.capability-unavailable",
        ]),
        "every signal the crate can raise is raised by a call site in it"
    );
    // And the one that must PUSH does.
    assert!(signals.raised().iter().any(|signal| matches!(
        signal,
        Signal::ZoneUnset { expr, .. } if expr == "0 7 * * *"
    )));
}

/// THE `NoNetwork` FETCHER: a host with no network is REPORTED and never
/// throws, and nothing partial is left behind.
#[test]
fn a_host_with_no_network_boots_with_the_capability_unavailable() {
    let signals = Recording::new();
    let lock = centraid_media::models::Lock::parse(
        r#"{"schemaVersion":1,"files":[
            {"model":"clip-vit-b-32@1","path":"clip/visual.onnx","capabilities":["embed-image"],
             "bytes":12,"sha256":"2222222222222222222222222222222222222222222222222222222222222222",
             "license":"MIT","url":"https://example.test/visual.onnx"},
            {"model":"yunet-arcface@1","path":"faces/yunet.onnx","capabilities":["faces"],
             "bytes":4,"sha256":"3333333333333333333333333333333333333333333333333333333333333333",
             "license":"MIT","url":"https://example.test/yunet.onnx"}]}"#,
    )
    .expect("a lock");
    let runtime = tempfile::tempdir().expect("a directory");
    assert!(!fire::arm_capability(
        &lock,
        runtime.path(),
        "faces",
        Some(&NoNetwork),
        &signals
    ));
    assert_eq!(signals.codes(), ["enrichment.capability-unavailable"]);
    // NOTHING OUTSIDE THE REQUESTED CAPABILITY WAS TOUCHED: CLIP's 600 MB is
    // not read to provision a 0.2 MB detector.
    assert!(
        !runtime.path().join("models/clip/visual.onnx").exists(),
        "provisioning one capability must leave every other file alone"
    );
    // And no partial file survives the refusal.
    let mut leftovers = Vec::new();
    if let Ok(entries) = std::fs::read_dir(runtime.path().join("models/faces")) {
        for entry in entries.flatten() {
            leftovers.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

/// A TRIGGER LOOP IS IMPOSSIBLE BY CONSTRUCTION: the tables a fire writes
/// cannot be reached from any trigger, at any spelling, through the manifest
/// door.
#[test]
fn nothing_a_fire_writes_can_be_watched() {
    // The physical tables this crate's own store code writes.
    let written_by_a_fire = [
        "automation_state",
        "automation_trigger_cursor",
        "trigger_ingress",
        "enrich_derivation",
        "enrich_embedding",
        "enrich_target_failure",
        "enrich_request",
        "conversations",
        "turns",
        "items",
        "outbox_item",
    ];
    for table in written_by_a_fire {
        // The bare physical name.
        assert!(
            watch::Watchable::resolve(table).is_err(),
            "{table} must not be watchable"
        );
        // The logical spelling, for the ones that have one.
        let logical = table.replacen('_', ".", 1);
        assert!(
            watch::Watchable::resolve(&logical).is_err(),
            "{logical} must not be watchable"
        );
        // And through the manifest, which is the door an author uses.
        for shape in [
            format!(r#"[{{"kind":"data","entities":["{logical}"]}}]"#),
            format!(r#"[{{"kind":"condition","entity":"{logical}"}}]"#),
        ] {
            // A legal manifest in every other respect, so the refusal can
            // only be the watch guard: the vault block a condition or data
            // trigger needs is present, and so is the provenance.
            let text = format!(
                r#"{{"name":"Loop","prompt":"loop","triggers":{shape},
                   "vault":{{"scopes":[{{"schema":"core","verbs":"read"}}]}},
                   "generated":{{"by":"builder","at":"2026-01-01T00:00:00.000Z"}}}}"#
            );
            let error = manifest::parse(&text)
                .expect_err("a trigger over a table a fire writes is refused");
            assert_eq!(
                error.code,
                manifest::ManifestErrorCode::DeniedWatch,
                "{logical}: {error:?}"
            );
        }
    }
}

/// The whole scheduled-run journey, in the vault's zone, on a UTC host.
#[test]
fn a_scheduled_run_fires_at_the_members_local_time_on_a_utc_vps() {
    struct Records(RefCell<Vec<i64>>);
    impl FireCursor for Records {
        fn fire(&self, input: &FireInput<'_>) -> Delivery {
            self.0.borrow_mut().push(input.element.occurred_at);
            Delivery::Fired
        }
    }
    let signals = Recording::new();
    let store = MemoryStore::default();
    let fires = Records(RefCell::new(Vec::new()));
    let engine = CursorEngine::new(&store, &fires, &signals);
    let triggers = [Trigger::Cron {
        expr: "0 7 * * *".to_owned(),
        tz: None,
        backfill: Backfill::Latest,
    }];
    // The vault's zone, not the host's. The host here is UTC.
    let registrations = fire::register("digest/digest", &triggers, Some("Asia/Kolkata"), &signals);
    assert_eq!(registrations.len(), 1);
    let zone = centraid_automations::cron::FireZone::named("Asia/Kolkata").expect("bundled");

    // Tick every minute across a day, starting from a bootstrap.
    let start = 1_772_985_600_000; // 2026-03-08T16:00:00Z
    for minute in 0..(30 * 60) {
        let at = start + minute * centraid_automations::cron::MINUTE_MS;
        engine.tick(&registrations[0], at, false, |_| CursorRead::default());
    }
    let fired = fires.0.borrow().clone();
    assert_eq!(fired.len(), 1, "once a day: {fired:?}");
    assert_eq!(
        zone.wall_clock(fired[0]).hour,
        7,
        "seven in the morning where the member is"
    );
    // The same instant read on the host's clock is not seven.
    let utc = centraid_automations::cron::FireZone::named("UTC").expect("bundled");
    assert_ne!(utc.wall_clock(fired[0]).hour, 7);
    assert!(signals.codes().is_empty(), "a healthy schedule is quiet");
}

/// The enrichment gate, over the whole tier × lane grid, with the two
/// provenance answers.
#[test]
fn the_gate_grid_is_complete_and_every_refusal_is_a_sentence() {
    use centraid_automations::fire::enrich_gate::{GateDecision, GateInput, Tier, decide};
    use centraid_automations::manifest::{EnrichDomain, EnrichLane};

    let tiers = [
        Tier::Off,
        Tier::OnDevice,
        Tier::SealedGateway,
        Tier::Gateway,
    ];
    let mut allowed = 0;
    let mut refused = 0;
    for tier in tiers {
        for lane in [EnrichLane::Device, EnrichLane::Gateway] {
            for system in [false, true] {
                let decision = decide(&GateInput {
                    automation_ref: "faces/faces",
                    domain: EnrichDomain::Photos,
                    capability: "faces",
                    lane,
                    tier: Some(tier),
                    system,
                    capability_enabled: None,
                    profile_id: None,
                });
                match decision {
                    GateDecision::Allowed { .. } => allowed += 1,
                    GateDecision::Refused(reason) => {
                        refused += 1;
                        assert!(reason.contains("faces/faces"), "{reason}");
                        assert!(reason.ends_with('.'), "{reason}");
                    }
                }
            }
        }
    }
    assert_eq!(
        allowed + refused,
        16,
        "the grid is 4 tiers x 2 lanes x 2 tiers"
    );
    // The six refusals, named: `off` refuses all four of its cells (system
    // included — an explicit answer is an answer), and the gateway LANE is
    // refused under `on-device` and under `device` for a non-system recipe.
    // A system recipe below the gateway rung runs SEALED instead, which is the
    // floor-not-ceiling rule.
    assert_eq!(refused, 6);
    assert_eq!(allowed, 10);
}
