//! **One handler, one execution boundary** (#1020, D-1020-AU4).
//!
//! `docs/recognition-automations.md:57`–`:63` states the boundary in five
//! steps, and the port keeps them as five: a handler (1) selects a bounded
//! batch, (2) reads source material with `ctx.content`, (3) runs its model,
//! (4) persists through a typed `ctx.invoke`, and (5) advances its cursor and
//! stamps `enrich_derivation` with the model that produced the result.
//!
//! And the negative, which is the load-bearing half: *there is no enrichment
//! HTTP service, gateway model client, reserved `centraid://enrichment/*`
//! fetch, `ctx.enrich` or `ctx.infer`; `ctx.fetch` remains connector-only;
//! **apps do not call models**.* An app sees the policy mirror and writes a
//! priority hint, and that is all.
//!
//! ## Provenance is a tier, and it is two constants
//!
//! [`SYSTEM_AUTOMATION_IDS`] and [`BUNDLED_OPTIONAL_AUTOMATION_IDS`] are v0's
//! (`packages/server/src/enrich/system-recognition.ts`), and the difference
//! between the tiers is **where the code came from**, never what it asked for:
//!
//! - **system** — first-party recognition the photos and documents pipelines
//!   *are*; armed from the release catalogue every boot, no `enabled` flag
//!   read, and routed to the `system` lane. A manifest's own `sandbox.lane` is
//!   **not consulted at all** for one of these, which is why
//!   [`crate::manifest::SandboxLane`] cannot spell `system`.
//! - **bundled-optional** — shipped in the release, off until the member turns
//!   it on, today's lanes unchanged.
//! - **external** — code-store, the floor. Not in this file at all.
//!
//! Every id in either list is **reserved against code-store apps**, so a
//! member app can never take one of these names and inherit its tier.
//!
//! ## Two caps, because two different things are being waited on
//!
//! [`ENRICH_TARGET_MAX_FAILURES`] (3) is for a failure that will not become a
//! success by being retried; [`NOT_READY_MAX_TICKS`] (12) is for a display rung
//! that genuinely takes minutes to land. A failure the recipe knows is
//! **permanent** declines on the first count without waiting for either.
//!
//! And the third answer beside "derived" and "skipped" is **counted**: under
//! the cap the walk PARKS on the target, at the cap the target is DECLINED and
//! the cursor advances past it. Both are [`Disposition`] values, and
//! [`TargetLedger`] is the pure arithmetic over `enrich_target_failure`.
//!
//! ## Models are behind a trait, and no weights are fetched here
//!
//! [`Model`] is the seam. Real inference — YuNet, ArcFace, CLIP, PP-OCRv5,
//! Whisper — is `ort` sessions, and each one is an **owner hand-off with its
//! exact command** rather than a stub that reads green: see this lane's receipt
//! and `crates/automations/README.md`. The tests drive [`FakeModel`] through
//! the same handler code the real sessions will run.
//!
//! Weights come from `centraid_media::models`, which **verifies from disk and
//! opens no connection** unless handed a fetcher; [`NoNetwork`] is the fetcher
//! a test uses to prove a host with no network is REPORTED and never throws.

pub mod recipes;

/// First-party system automations: always on, `system` sandbox lane.
pub const SYSTEM_AUTOMATION_IDS: [&str; 3] = ["faces", "photo-ocr", "doc-text-extractor"];

/// Bundled with the release, off until the member turns them on.
pub const BUNDLED_OPTIONAL_AUTOMATION_IDS: [&str; 4] =
    ["embed-image", "embed-text", "transcript", "place-names"];

/// A failure that will not become a success by being retried.
pub const ENRICH_TARGET_MAX_FAILURES: u32 = 3;

/// A display rung that genuinely takes minutes to land.
pub const NOT_READY_MAX_TICKS: u32 = 12;

/// Where a recipe's code came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    /// Shipped with the release, first-party, armed unconditionally.
    System,
    /// Shipped with the release, off until the member turns it on.
    BundledOptional,
    /// A code-store app. The floor.
    External,
}

impl Provenance {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::BundledOptional => "bundled-optional",
            Self::External => "external",
        }
    }

    /// The sandbox lane the PARENT routes this recipe to.
    ///
    /// `docs/recognition-automations.md:17`: *lane routing is keyed to
    /// provenance, never to a declaration* — the parent decides at fire time
    /// from the id, and a system automation's own `sandbox.lane` field is not
    /// consulted at all.
    #[must_use]
    pub const fn lane(self, declared: Option<crate::manifest::SandboxLane>) -> &'static str {
        match self {
            // "grants nothing the gateway process does not already have" — the
            // honest description of first-party release code running in-thread,
            // and why this was a ROUTING change rather than a widening.
            Self::System => "system",
            Self::BundledOptional | Self::External => match declared {
                Some(lane) => lane.as_str(),
                // FAIL CLOSED: an absent block is the floor.
                None => "automation-handler",
            },
        }
    }

    /// Is a member's `enabled` bit consulted for this tier?
    ///
    /// **"Armed" is what the SCHEDULER does, not what a stored bit says**
    /// (`docs/system-signals.md`): a system recipe is armed on every boot
    /// whatever its `enabled` column reads. Counting it off is how health and
    /// the scheduler came to disagree about what was running.
    #[must_use]
    pub const fn reads_enabled_flag(self) -> bool {
        !matches!(self, Self::System)
    }
}

/// The tier of a recipe id.
///
/// **Keyed on the constants and nothing else.** A manifest field that could
/// widen this would be a manifest that could grant itself the gateway's trust.
#[must_use]
pub fn provenance(id: &str) -> Provenance {
    if SYSTEM_AUTOMATION_IDS.contains(&id) {
        return Provenance::System;
    }
    if BUNDLED_OPTIONAL_AUTOMATION_IDS.contains(&id) {
        return Provenance::BundledOptional;
    }
    Provenance::External
}

/// The `<id>/<id>` ref form, which is how a fire names a bundled recipe.
#[must_use]
pub fn provenance_of_ref(automation_ref: &str) -> Provenance {
    match automation_ref.split_once('/') {
        Some((app, id)) if app == id => provenance(id),
        _ => Provenance::External,
    }
}

/// Every id the release manages, either tier. The **reservation** set.
#[must_use]
pub fn reserved_ids() -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = SYSTEM_AUTOMATION_IDS
        .iter()
        .chain(BUNDLED_OPTIONAL_AUTOMATION_IDS.iter())
        .copied()
        .collect();
    ids.sort_unstable();
    ids
}

/// The capture surface enters the exact same recipe as background photo OCR.
pub const SYSTEM_CAPTURE_OCR_REF: &str = "photo-ocr/photo-ocr";

/// What a walk decided about one target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disposition {
    /// Derived. The stamp is written and the failure record cleared.
    Derived,
    /// **PARKED**: the watermark stays in front of this target, because
    /// nothing else would come back for an unstamped asset — the prior-stamp
    /// sweep only revisits assets that already carry a stamp, so advancing
    /// would drop it from every future tick.
    Parked { counted: u32, reason: &'static str },
    /// **DECLINED**: the cap is reached, the cursor advances past it, and the
    /// enrichment probe lists it.
    Declined { reason: String, failures: u32 },
    /// **SKIPPED**: the rung is never coming — an original this build's raster
    /// codec declined. The cursor ADVANCES, because parking behind it would
    /// freeze the watermark for good.
    Skipped { reason: &'static str },
}

/// Why a target could not be derived now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetProblem {
    /// A rung still in flight. Patient: twelve ticks.
    NotReady,
    /// The codec declined this original, durably. **Not patient**: parking
    /// behind a rung that is never coming freezes the watermark.
    Unsupported,
    /// A failure that retrying might fix.
    Transient(String),
    /// A failure retrying will not fix — content past the extractor's byte
    /// ceiling. **Declines on the first count.**
    Permanent(String),
    /// D-1020-AU3-3, adopting `recognition-placement.md` §3: the device that
    /// holds the asset is not reachable. **Parked by the ABSENCE of a lease,
    /// and counted nowhere** — a phone in a drawer for a month is not a
    /// failure, and counting it would decline a member's photographs for being
    /// on a phone they did not bring.
    AwaitingHolder,
}

/// One `enrich_target_failure` row, as this module reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TargetRecord {
    pub failures: u32,
    pub not_ready_ticks: u32,
    pub declined: bool,
}

/// The pure arithmetic over `enrich_target_failure`.
///
/// Separated from the store so the caps are testable without a database and,
/// more importantly, so the two caps are visibly two.
#[derive(Debug, Clone, Copy)]
pub struct TargetLedger {
    pub max_failures: u32,
    pub max_not_ready_ticks: u32,
}

impl Default for TargetLedger {
    fn default() -> Self {
        Self {
            max_failures: ENRICH_TARGET_MAX_FAILURES,
            max_not_ready_ticks: NOT_READY_MAX_TICKS,
        }
    }
}

impl TargetLedger {
    /// What this problem does to this target, given what is already recorded.
    ///
    /// Returns the disposition and the row to write. `None` for the row means
    /// **write nothing** — which is the whole of the `AwaitingHolder` ruling.
    #[must_use]
    pub fn count(
        self,
        problem: &TargetProblem,
        record: TargetRecord,
    ) -> (Disposition, Option<TargetRecord>) {
        match problem {
            TargetProblem::AwaitingHolder => (
                Disposition::Parked {
                    counted: 0,
                    reason: "awaiting-holder",
                },
                // NO ROW. The target is parked by the absence of a lease.
                None,
            ),
            TargetProblem::Unsupported => (
                Disposition::Skipped {
                    reason: "no preview this codec can produce",
                },
                // NO STAMP AND NO COUNT: the recipe never looked at the
                // photograph, so a `{count: 0}` faces stamp would claim it did.
                None,
            ),
            TargetProblem::NotReady => {
                let ticks = record.not_ready_ticks + 1;
                if ticks >= self.max_not_ready_ticks {
                    (
                        Disposition::Declined {
                            reason: "not-ready".to_owned(),
                            failures: record.failures,
                        },
                        Some(TargetRecord {
                            not_ready_ticks: ticks,
                            declined: true,
                            ..record
                        }),
                    )
                } else {
                    (
                        Disposition::Parked {
                            counted: ticks,
                            reason: "not-ready",
                        },
                        Some(TargetRecord {
                            not_ready_ticks: ticks,
                            ..record
                        }),
                    )
                }
            }
            // A PERMANENT FAILURE DECLINES ON THE FIRST COUNT.
            TargetProblem::Permanent(detail) => (
                Disposition::Declined {
                    reason: detail.clone(),
                    failures: record.failures + 1,
                },
                Some(TargetRecord {
                    failures: record.failures + 1,
                    declined: true,
                    ..record
                }),
            ),
            TargetProblem::Transient(detail) => {
                let failures = record.failures + 1;
                if failures >= self.max_failures {
                    (
                        Disposition::Declined {
                            reason: detail.clone(),
                            failures,
                        },
                        Some(TargetRecord {
                            failures,
                            declined: true,
                            ..record
                        }),
                    )
                } else {
                    (
                        Disposition::Parked {
                            counted: failures,
                            reason: "failed",
                        },
                        Some(TargetRecord { failures, ..record }),
                    )
                }
            }
        }
    }

    /// **Stamping a derivation clears the record**, so a transient failure
    /// leaves nothing behind.
    #[must_use]
    pub const fn derived(self) -> (Disposition, Option<TargetRecord>) {
        (Disposition::Derived, None)
    }
}

impl Disposition {
    /// Does the cursor advance past this target?
    #[must_use]
    pub const fn advances_cursor(&self) -> bool {
        match self {
            Self::Derived | Self::Declined { .. } | Self::Skipped { .. } => true,
            Self::Parked { .. } => false,
        }
    }
}

/// Why a `ctx` call could not be served. Typed, so a handler does not have to
/// read a sentence to decide what to do.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CtxError {
    /// A rail that does not exist in this release, and what it belongs to.
    #[error("{what} is not available in this release: {because}")]
    NotAvailable {
        what: &'static str,
        because: &'static str,
    },
    #[error("{0}")]
    Refused(String),
}

/// **A model, behind a trait.**
///
/// One method, because a handler's step 3 is one thing: bytes in, a typed
/// result out. The weights, the session, the provider and the arena are the
/// implementation's business; the handler's business is the batch, the gate,
/// the command and the stamp.
pub trait Model {
    /// The id stamped into `enrich_derivation.model`, `<name>@<version>`.
    fn id(&self) -> &str;
    /// Run inference over one input.
    fn infer(&self, input: &ModelInput) -> Result<ModelOutput, String>;
}

/// What a model is handed.
#[derive(Debug, Clone, PartialEq)]
pub enum ModelInput {
    /// Preview or original bytes.
    Bytes(Vec<u8>),
    /// Vault text.
    Text(String),
    /// A coordinate. `place-names` reads **no media bytes at all**.
    Coordinate { latitude: f64, longitude: f64 },
}

/// What a model produced. Deliberately narrow: every variant maps to exactly
/// one result command ([`recipes`]).
#[derive(Debug, Clone, PartialEq)]
pub enum ModelOutput {
    /// A vector, with its dimension. Face embeddings are compared only within
    /// one `enrich_embedding.model`, so 128-d and 512-d rows never meet.
    Embedding { dim: u32, vector: Vec<u8> },
    /// Extracted or transcribed text.
    Text(String),
    /// Face boxes, each with its own embedding.
    Faces(Vec<FaceRegion>),
    /// A settlement name.
    PlaceName(String),
}

/// One detected face.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub dim: u32,
    pub vector: Vec<u8>,
}

/// A model that answers from a script. **Not a stub that reads green**: it
/// drives the same handler code a real `ort` session will, and every
/// `Err(String)` it can return is a case the handler is tested against.
#[derive(Debug, Clone)]
pub struct FakeModel {
    id: String,
    answer: Result<ModelOutput, String>,
}

impl FakeModel {
    #[must_use]
    pub fn answering(id: impl Into<String>, output: ModelOutput) -> Self {
        Self {
            id: id.into(),
            answer: Ok(output),
        }
    }

    #[must_use]
    pub fn failing(id: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            answer: Err(error.into()),
        }
    }
}

impl Model for FakeModel {
    fn id(&self) -> &str {
        &self.id
    }

    fn infer(&self, _input: &ModelInput) -> Result<ModelOutput, String> {
        self.answer.clone()
    }
}

/// A weights fetcher that refuses every request, for a host with no network.
///
/// It drives `centraid_media::models::ensure`'s whole body except the socket,
/// which is how the "reported, never thrown" property is proved here rather
/// than asserted in a comment.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoNetwork;

impl centraid_media::models::Fetch for NoNetwork {
    fn get(&self, url: &str) -> Result<Vec<u8>, String> {
        Err(format!(
            "{url}: this host has no outbound network, so no weights can be fetched"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::SandboxLane;

    #[test]
    fn the_three_tiers_are_two_constants_and_a_default() {
        assert_eq!(SYSTEM_AUTOMATION_IDS.len(), 3);
        assert_eq!(BUNDLED_OPTIONAL_AUTOMATION_IDS.len(), 4);
        assert_eq!(reserved_ids().len(), 7);
        for id in SYSTEM_AUTOMATION_IDS {
            assert_eq!(provenance(id), Provenance::System, "{id}");
        }
        for id in BUNDLED_OPTIONAL_AUTOMATION_IDS {
            assert_eq!(provenance(id), Provenance::BundledOptional, "{id}");
        }
        assert_eq!(provenance("my-app"), Provenance::External);
        // The two lists are DISJOINT: an id in both would have two tiers.
        for id in SYSTEM_AUTOMATION_IDS {
            assert!(!BUNDLED_OPTIONAL_AUTOMATION_IDS.contains(&id), "{id}");
        }
        let mut reserved = reserved_ids();
        let count = reserved.len();
        reserved.dedup();
        assert_eq!(reserved.len(), count);
    }

    /// LANE ROUTING IS KEYED TO PROVENANCE, NEVER TO A DECLARATION.
    #[test]
    fn a_system_recipes_own_sandbox_declaration_is_not_consulted() {
        assert_eq!(
            Provenance::System.lane(Some(SandboxLane::MediaTranscode)),
            "system",
            "a system recipe's own declaration is not consulted at all"
        );
        assert_eq!(Provenance::System.lane(None), "system");
        assert_eq!(
            Provenance::BundledOptional.lane(Some(SandboxLane::ModelRuntime)),
            "model-runtime"
        );
        // FAIL CLOSED: an absent block is the floor, for both other tiers.
        assert_eq!(Provenance::BundledOptional.lane(None), "automation-handler");
        assert_eq!(Provenance::External.lane(None), "automation-handler");
    }

    /// "Armed" is what the scheduler does, not what a stored bit says.
    #[test]
    fn a_system_recipe_reads_no_enabled_flag() {
        assert!(!Provenance::System.reads_enabled_flag());
        assert!(Provenance::BundledOptional.reads_enabled_flag());
        assert!(Provenance::External.reads_enabled_flag());
    }

    #[test]
    fn a_ref_is_a_tier_only_when_the_app_and_the_recipe_are_the_same_id() {
        assert_eq!(provenance_of_ref("faces/faces"), Provenance::System);
        assert_eq!(
            provenance_of_ref(SYSTEM_CAPTURE_OCR_REF),
            Provenance::System
        );
        // A member app that named its automation `faces` does NOT inherit the
        // tier: the reservation set is what keeps the id from being taken at
        // all, and this is the second line of defence.
        assert_eq!(provenance_of_ref("my-app/faces"), Provenance::External);
        assert_eq!(provenance_of_ref("faces"), Provenance::External);
    }

    /// TWO CAPS, BECAUSE TWO DIFFERENT WAITS.
    #[test]
    fn the_two_caps_are_two() {
        let ledger = TargetLedger::default();
        assert_eq!(ledger.max_failures, 3);
        assert_eq!(ledger.max_not_ready_ticks, 12);
        // A transient failure parks twice, then declines on the third.
        let mut record = TargetRecord::default();
        for expected in 1..ENRICH_TARGET_MAX_FAILURES {
            let (disposition, next) =
                ledger.count(&TargetProblem::Transient("boom".to_owned()), record);
            assert_eq!(
                disposition,
                Disposition::Parked {
                    counted: expected,
                    reason: "failed"
                }
            );
            assert!(!disposition.advances_cursor());
            record = next.expect("a row");
        }
        let (declined, row) = ledger.count(&TargetProblem::Transient("boom".to_owned()), record);
        assert_eq!(
            declined,
            Disposition::Declined {
                reason: "boom".to_owned(),
                failures: 3
            }
        );
        assert!(declined.advances_cursor(), "the walk moves past it");
        assert!(row.expect("a row").declined);
        // A not-ready target waits twelve, on its OWN counter.
        let mut ready = TargetRecord::default();
        for _ in 1..NOT_READY_MAX_TICKS {
            let (disposition, next) = ledger.count(&TargetProblem::NotReady, ready);
            assert!(matches!(disposition, Disposition::Parked { .. }));
            ready = next.expect("a row");
        }
        assert_eq!(ready.not_ready_ticks, NOT_READY_MAX_TICKS - 1);
        assert_eq!(ready.failures, 0, "the two counters are independent");
        let (declined, _) = ledger.count(&TargetProblem::NotReady, ready);
        assert!(matches!(declined, Disposition::Declined { .. }));
    }

    #[test]
    fn a_permanent_failure_declines_on_the_first_count() {
        let ledger = TargetLedger::default();
        let (disposition, row) = ledger.count(
            &TargetProblem::Permanent("past the extractor's byte ceiling".to_owned()),
            TargetRecord::default(),
        );
        assert_eq!(
            disposition,
            Disposition::Declined {
                reason: "past the extractor's byte ceiling".to_owned(),
                failures: 1
            }
        );
        assert!(row.expect("a row").declined);
    }

    /// D-1020-AU3-3: THE TEST THAT A PARKED TARGET WRITES NOTHING.
    #[test]
    fn an_unreachable_holder_writes_no_row_at_all() {
        let ledger = TargetLedger::default();
        let (disposition, row) =
            ledger.count(&TargetProblem::AwaitingHolder, TargetRecord::default());
        assert_eq!(
            disposition,
            Disposition::Parked {
                counted: 0,
                reason: "awaiting-holder"
            }
        );
        assert_eq!(
            row, None,
            "counting a phone in a drawer would decline a member's photographs for being on a \
             phone they did not bring"
        );
        // And it never accumulates, however many ticks pass.
        let mut record = TargetRecord::default();
        for _ in 0..100 {
            let (_, next) = ledger.count(&TargetProblem::AwaitingHolder, record);
            record = next.unwrap_or(record);
        }
        assert_eq!(record, TargetRecord::default());
    }

    /// PENDING AND UNSUPPORTED ARE DIFFERENT ANSWERS, and only one parks.
    #[test]
    fn an_unsupported_original_is_skipped_and_the_cursor_advances() {
        let ledger = TargetLedger::default();
        let (disposition, row) = ledger.count(&TargetProblem::Unsupported, TargetRecord::default());
        assert_eq!(
            disposition,
            Disposition::Skipped {
                reason: "no preview this codec can produce"
            }
        );
        assert!(
            disposition.advances_cursor(),
            "parking behind a rung that is never coming freezes the watermark for good"
        );
        assert_eq!(row, None, "and no stamp claims the recipe looked at it");
        // Pending keeps parking.
        let (pending, _) = ledger.count(&TargetProblem::NotReady, TargetRecord::default());
        assert!(!pending.advances_cursor());
    }

    #[test]
    fn stamping_a_derivation_clears_the_record() {
        let (disposition, row) = TargetLedger::default().derived();
        assert_eq!(disposition, Disposition::Derived);
        assert_eq!(row, None, "a transient failure leaves nothing behind");
        assert!(disposition.advances_cursor());
    }

    #[test]
    fn a_fake_model_drives_the_same_seam_a_real_session_will() {
        let model = FakeModel::answering(
            "clip-vit-b-32@1",
            ModelOutput::Embedding {
                dim: 512,
                vector: vec![0; 8],
            },
        );
        assert_eq!(model.id(), "clip-vit-b-32@1");
        assert!(matches!(
            model.infer(&ModelInput::Text("a dog".to_owned())),
            Ok(ModelOutput::Embedding { dim: 512, .. })
        ));
        let broken = FakeModel::failing("yunet-arcface@1", "the session would not load");
        assert_eq!(
            broken.infer(&ModelInput::Bytes(vec![1, 2, 3])),
            Err("the session would not load".to_owned())
        );
    }
}
