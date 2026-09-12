//! **The enrichment gate** — the decision half (#1020, D-1020-AU3).
//!
//! ## The name, first
//!
//! Census §C4 settles a question the brief inherited: *"there is no `Resource
//! mode` in the v0 tree"*. Greps across `packages/server/src/automation/**`
//! and `packages/core/src` find nothing, and `docs/recognition-automations.md`
//! does not use the word. What exists in that position is **this**: the
//! enrichment tier/lane gate. It is named here so a later reader does not go
//! looking for a mode that never existed.
//!
//! ## The rule, and the one place assuming is dangerous
//!
//! `enrich-gate.ts:1`–`:39`. Tiers are `off | device | gateway`, lanes are
//! `device | gateway`, and the gate is `rank(lane) ≤ rank(tier)`.
//!
//! **An omitted lane reads as `gateway`, because assuming cheaper assumes
//! consent.** A manifest is harness-writable: a recipe that forgot to declare
//! its lane and was read as `device` would run a model turn under a member's
//! "keep it on my gateway" answer. The default is therefore the one that gets
//! REFUSED under a narrow tier, never the one that slips through — and
//! [`crate::manifest::EnrichLane::default`] is where that is written down.
//!
//! ## Egress is a property of the HARNESS, never of the issuing machine (#567)
//!
//! `device` does not mean "runs on the phone" — that is the thing v1 open
//! question 9 wants and v0 does not have. Today a `device` decision is
//! `{allowed: true, seal_model_turns: true}`: **the fire runs, and
//! `ctx.delegate` is refused.** Every harness in this runtime routes to a
//! third-party provider, so a model turn is egress whoever asked for it.
//!
//! ## Consent is for egress, and a system recipe has a FLOOR not a ceiling
//!
//! `docs/recognition-automations.md` *Consent is for egress*: on-device work
//! over a member's own bytes on their own gateway needs no consent, so an
//! **unreadable or unwritten** policy no longer refuses a SYSTEM fire — it
//! resolves to device and runs with model turns sealed. Every ceiling above
//! that is untouched: an explicit `off` still refuses, a rule that switches
//! the capability off still refuses. For any other automation an unreadable
//! policy is a REFUSAL, because an unreadable policy is not an answer to
//! anything.
//!
//! ## The third execution site is a PROPOSAL, integrated here as vocabulary
//!
//! `contracts/apps/photos/recognition-placement.md` is Photos' open-question-9
//! proposal, and D-1020-AU3-1…4 below adopt its gateway half. The one sentence
//! that shapes all of it: *the `device` tier already means something, and the
//! third execution site has to be a new word with its own rung.* So
//! [`Tier::OnDevice`] is a FOURTH value and `device` is read forward as
//! [`Tier::SealedGateway`] — never re-meant.

use crate::manifest::{EnrichDomain, EnrichLane};

/// The member's answer, per domain, as `enrich_policy.tier` stores it.
///
/// **Four values, not three** (D-1020-AU3-1, adopting
/// `recognition-placement.md` §1 option (b)). Re-meaning `device` would change
/// what a member consented to without asking; splitting the axis into
/// `tier × site` gives four combinations of which one (`off × holder`) is
/// nonsense and makes every gate learn a second comparison. A fourth rung
/// keeps the gate as `rank(lane) ≤ rank(tier)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    Off,
    /// **New in v1.** On the device that holds the asset, else nothing. The
    /// NARROWEST egress, which is why it ranks below [`Self::SealedGateway`] —
    /// not because it is least capable.
    OnDevice,
    /// v0's `device`, read forward: the gateway's deterministic engine with
    /// model turns sealed.
    SealedGateway,
    Gateway,
}

impl Tier {
    #[must_use]
    pub const fn rank(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::OnDevice => 1,
            Self::SealedGateway => 2,
            Self::Gateway => 3,
        }
    }

    /// What is WRITTEN to `enrich_policy.tier`. `on-device` is the only new
    /// spelling; the other three are v0's, so a v0 gateway reading a v1 vault
    /// still understands three of the four.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::OnDevice => "on-device",
            Self::SealedGateway => "device",
            Self::Gateway => "gateway",
        }
    }

    /// Read a stored value FORWARD. `device` is `SealedGateway`; `local` and
    /// `model` are the pre-#712 names the DDL still permits.
    ///
    /// The port **reads these forward and never writes them back** — the same
    /// stance `crates/apps/photos::enrichment` takes.
    #[must_use]
    pub fn read_forward(stored: &str) -> Option<Self> {
        match stored {
            "off" => Some(Self::Off),
            "on-device" => Some(Self::OnDevice),
            // v0's `device`, and the pre-#712 `local`.
            "device" | "local" => Some(Self::SealedGateway),
            "gateway" | "model" => Some(Self::Gateway),
            _ => None,
        }
    }
}

const fn lane_rank(lane: EnrichLane) -> u8 {
    match lane {
        // A `device`-lane enricher asks for deterministic work only, which is
        // satisfied by every rung above `off`.
        EnrichLane::Device => 1,
        // A `gateway`-lane enricher asks for a model turn through the harness
        // registry, which is provider egress.
        EnrichLane::Gateway => 3,
    }
}

/// What the gate was asked.
#[derive(Debug, Clone)]
pub struct GateInput<'a> {
    pub automation_ref: &'a str,
    pub domain: EnrichDomain,
    pub capability: &'a str,
    pub lane: EnrichLane,
    /// `None` is a REFUSAL, never a default — except for a system automation,
    /// where an unwritten policy is not an answer to anything.
    pub tier: Option<Tier>,
    /// First-party provenance ([`crate::handler::provenance`]).
    pub system: bool,
    /// The resolved policy's own switch for this capability, when a policy was
    /// readable. `None` = no rule decides it, so the tier alone governs.
    pub capability_enabled: Option<bool>,
    /// The engine profile the policy points this capability at, for the
    /// refusal's sentence.
    pub profile_id: Option<&'a str>,
}

/// What the gate answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    Allowed {
        /// True under every rung below `gateway`: **fire runs, `ctx.delegate`
        /// refused.**
        seal_model_turns: bool,
        /// True under [`Tier::OnDevice`]: the work is offered to the device
        /// that holds the asset, and a holder that is offline PARKS the target
        /// rather than failing it (D-1020-AU3-3).
        holder_site: bool,
    },
    /// The SENTENCE a member reads. A refusal that said "denied" would make
    /// the caller invent the reason.
    Refused(String),
}

impl GateDecision {
    #[must_use]
    pub const fn allowed(&self) -> bool {
        matches!(self, Self::Allowed { .. })
    }
}

/// Decide one enricher's fire.
#[must_use]
pub fn decide(input: &GateInput<'_>) -> GateDecision {
    let who = format!(
        "{} (enrichment \"{}\", domain \"{}\")",
        input.automation_ref,
        input.capability,
        input.domain.as_str()
    );
    // A SYSTEM automation with no readable tier is not refused: first-party
    // on-device work over the member's own bytes needs no consent. Read as the
    // sealed-gateway rung so every remaining check still runs exactly as it
    // does for any other automation.
    let tier = match (input.tier, input.system) {
        (Some(tier), _) => tier,
        (None, true) => Tier::SealedGateway,
        (None, false) => {
            return GateDecision::Refused(format!(
                "{who} refused: this vault's enrichment policy for \"{}\" could not be read, and \
                 an unreadable policy is a refusal, not a default.",
                input.domain.as_str()
            ));
        }
    };
    // Before the rank check, so the refusal names the SWITCH and not a tier.
    if input.capability_enabled == Some(false) && tier != Tier::Off {
        return GateDecision::Refused(format!(
            "{who} refused: this vault's enrichment policy has \"{}\" switched off at the scope \
             that decides it.",
            input.capability
        ));
    }
    if lane_rank(input.lane) > tier.rank() {
        // `off` is the member's own answer and refuses every tier, system
        // included.
        if tier == Tier::Off {
            return GateDecision::Refused(format!(
                "{who} refused: enrichment is switched off for \"{}\" in this vault's privacy \
                 settings.",
                input.domain.as_str()
            ));
        }
        // Below `off`, a system automation is not refused for wanting the
        // gateway lane: it runs with model turns sealed, which is the
        // on-device half of its work — the half that needed no consent.
        if input.system {
            return GateDecision::Allowed {
                seal_model_turns: true,
                holder_site: tier == Tier::OnDevice,
            };
        }
        return GateDecision::Refused(format!(
            "{who} refused: enrichment for \"{}\" is set to \"{}\", and this enricher needs the \
             \"{}\" lane — a model turn through the harness registry, which every harness in this \
             runtime routes to a third-party provider, so the run would leave this member's trust \
             domain. Set the tier to \"gateway\" to allow that, or use the device lane.",
            input.domain.as_str(),
            tier.as_str(),
            input.lane.as_str()
        ));
    }
    // A policy that names a profile this gateway does not carry is a refusal
    // rather than a silent substitution: the member chose that engine.
    if let Some(profile) = input.profile_id
        && profile.is_empty()
    {
        return GateDecision::Refused(format!(
            "{who} refused: this vault's enrichment policy points \"{}\" at an engine profile this \
             gateway does not carry.",
            input.capability
        ));
    }
    GateDecision::Allowed {
        seal_model_turns: tier != Tier::Gateway,
        holder_site: tier == Tier::OnDevice,
    }
}

/// The sentence `ctx.delegate` refuses with under a sealed rung.
#[must_use]
pub fn sealed_model_turn_reason(automation_ref: &str, domain: EnrichDomain) -> String {
    format!(
        "{automation_ref}: ctx.delegate is refused — enrichment for \"{}\" is set to \"device\" in \
         this vault, and a model turn in this runtime always routes to a third-party provider.",
        domain.as_str()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(lane: EnrichLane, tier: Option<Tier>) -> GateInput<'a> {
        GateInput {
            automation_ref: "faces/faces",
            domain: EnrichDomain::Photos,
            capability: "faces",
            lane,
            tier,
            system: false,
            capability_enabled: None,
            profile_id: None,
        }
    }

    #[test]
    fn the_gate_is_rank_lane_at_most_rank_tier() {
        // device lane under every rung above off.
        for tier in [Tier::OnDevice, Tier::SealedGateway, Tier::Gateway] {
            assert!(
                decide(&input(EnrichLane::Device, Some(tier))).allowed(),
                "{tier:?}"
            );
        }
        assert!(!decide(&input(EnrichLane::Device, Some(Tier::Off))).allowed());
        // gateway lane only at the gateway rung.
        assert!(decide(&input(EnrichLane::Gateway, Some(Tier::Gateway))).allowed());
        for tier in [Tier::Off, Tier::OnDevice, Tier::SealedGateway] {
            assert!(
                !decide(&input(EnrichLane::Gateway, Some(tier))).allowed(),
                "{tier:?}"
            );
        }
    }

    /// THE `device` DECISION: fire runs, `ctx.delegate` refused.
    #[test]
    fn a_sealed_rung_runs_the_fire_and_seals_the_model_turns() {
        assert_eq!(
            decide(&input(EnrichLane::Device, Some(Tier::SealedGateway))),
            GateDecision::Allowed {
                seal_model_turns: true,
                holder_site: false,
            }
        );
        assert_eq!(
            decide(&input(EnrichLane::Device, Some(Tier::Gateway))),
            GateDecision::Allowed {
                seal_model_turns: false,
                holder_site: false,
            }
        );
        let reason = sealed_model_turn_reason("faces/faces", EnrichDomain::Photos);
        assert!(reason.contains("ctx.delegate is refused"), "{reason}");
    }

    /// D-1020-AU3-1: the fourth rung, and `device` READ FORWARD rather than
    /// re-meant.
    #[test]
    fn the_new_rung_is_a_new_word_and_device_still_means_what_it_meant() {
        assert_eq!(Tier::read_forward("device"), Some(Tier::SealedGateway));
        assert_eq!(Tier::read_forward("on-device"), Some(Tier::OnDevice));
        assert_eq!(Tier::read_forward("local"), Some(Tier::SealedGateway));
        assert_eq!(Tier::read_forward("model"), Some(Tier::Gateway));
        assert_eq!(Tier::read_forward("off"), Some(Tier::Off));
        assert_eq!(Tier::read_forward("holder"), None);
        // The ranking, and the reason it is not a capability ordering.
        assert!(Tier::OnDevice.rank() < Tier::SealedGateway.rank());
        assert!(Tier::SealedGateway.rank() < Tier::Gateway.rank());
        // The stored spelling of the three v0 values is unchanged, so a v0
        // gateway reading a v1 vault still understands them.
        assert_eq!(Tier::SealedGateway.as_str(), "device");
        assert_eq!(Tier::Gateway.as_str(), "gateway");
        assert_eq!(Tier::Off.as_str(), "off");
        // And the new one is offered to the holder site.
        assert_eq!(
            decide(&input(EnrichLane::Device, Some(Tier::OnDevice))),
            GateDecision::Allowed {
                seal_model_turns: true,
                holder_site: true,
            }
        );
    }

    /// AN OMITTED LANE READS AS GATEWAY, so the default is the one that gets
    /// refused.
    #[test]
    fn an_omitted_lane_is_the_one_a_narrow_tier_refuses() {
        assert_eq!(EnrichLane::default(), EnrichLane::Gateway);
        let decision = decide(&input(EnrichLane::default(), Some(Tier::SealedGateway)));
        assert!(
            !decision.allowed(),
            "assuming the cheaper lane would be assuming consent"
        );
    }

    #[test]
    fn an_unreadable_policy_refuses_unless_the_recipe_is_first_party() {
        let refused = decide(&input(EnrichLane::Device, None));
        match &refused {
            GateDecision::Refused(reason) => {
                assert!(reason.contains("not a default"), "{reason}");
            }
            other => panic!("{other:?}"),
        }
        let mut system = input(EnrichLane::Device, None);
        system.system = true;
        assert_eq!(
            decide(&system),
            GateDecision::Allowed {
                seal_model_turns: true,
                holder_site: false,
            },
            "a system recipe gets a FLOOR, and an unwritten policy is not an answer"
        );
    }

    /// A system recipe gets a floor, not a ceiling: `off` still refuses it,
    /// and so does a rule that switches the capability off.
    #[test]
    fn off_refuses_every_tier_including_a_system_recipe() {
        let mut system = input(EnrichLane::Gateway, Some(Tier::Off));
        system.system = true;
        match decide(&system) {
            GateDecision::Refused(reason) => {
                assert!(reason.contains("switched off"), "{reason}");
            }
            other => panic!("{other:?}"),
        }
        let mut switched = input(EnrichLane::Device, Some(Tier::Gateway));
        switched.system = true;
        switched.capability_enabled = Some(false);
        match decide(&switched) {
            GateDecision::Refused(reason) => {
                assert!(
                    reason.contains("the scope that decides it"),
                    "the refusal names the SWITCH, not a tier: {reason}"
                );
            }
            other => panic!("{other:?}"),
        }
    }

    /// A system recipe wanting the gateway lane under a sealed tier runs the
    /// on-device half rather than refusing.
    #[test]
    fn a_system_recipe_below_the_gateway_rung_runs_sealed_rather_than_refusing() {
        let mut system = input(EnrichLane::Gateway, Some(Tier::SealedGateway));
        system.system = true;
        assert_eq!(
            decide(&system),
            GateDecision::Allowed {
                seal_model_turns: true,
                holder_site: false,
            }
        );
    }

    #[test]
    fn every_refusal_is_a_sentence_and_names_the_automation() {
        let cases = [
            input(EnrichLane::Device, None),
            input(EnrichLane::Device, Some(Tier::Off)),
            input(EnrichLane::Gateway, Some(Tier::SealedGateway)),
        ];
        for case in cases {
            match decide(&case) {
                GateDecision::Refused(reason) => {
                    assert!(reason.starts_with("faces/faces"), "{reason}");
                    assert!(reason.ends_with('.'), "{reason}");
                    assert!(reason.len() > 60, "a refusal is a sentence: {reason}");
                }
                other => panic!("{other:?}"),
            }
        }
    }
}
