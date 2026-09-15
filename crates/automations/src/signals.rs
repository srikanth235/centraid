//! System signals: what a member is told, and the door they leave through
//! (#1020, D-1020-AU7).
//!
//! ## Why a value and not a log line
//!
//! `docs/system-signals.md` describes a four-layer ladder — ambient, glance,
//! push, drill-down — and one rule that decides everything else: *"a pushed
//! card states cause, consequence, and exactly one action"*. A refusal that
//! exists only in `tracing::warn!` satisfies none of that: nobody is reading
//! the gateway's log at 07:00, and the automation that did not fire looks
//! exactly like a quiet morning.
//!
//! So every refusal the fire spine can reach is a [`Signal`] — a value with a
//! [`Tone`], a cause, a consequence and one action — handed to a
//! [`SignalSink`]. The crate logs nothing instead of signalling; a test over
//! the spine ([`crate::fire`]) asserts that each variant has a call site.
//!
//! ## Where the wire form lives, and why it is a hand-off
//!
//! `centraid.core.v1`'s `Event` oneof carries three kinds today (`change`,
//! `health`, `connectivity`) and none of them is a signal: `HealthEvent` is a
//! queue sample, `ConnectivityEvent` is a transport state. A fourth arm is the
//! right wire shape and `crates/api-proto` is a SHARED file this lane does not
//! own (census §Cross-lane), so it ships as
//! `contracts/handoff/automations/api-proto.patch` with its demonstrated red
//! rather than as an edit made from inside one lane.
//!
//! That is why [`SignalSink`] is a trait and not a `fn(Event)`. The seam is
//! here; the wire arm arrives at a checkpoint; nothing in between is a log
//! line pretending to be a signal.

use std::sync::Mutex;

/// How loudly a signal presents. `docs/system-signals.md`: *"Signal tone is
/// exactly `quiet`, `attention`, or `urgent`."*
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    /// Recessive. A fact, in its destination.
    Quiet,
    /// A human decision or action is required.
    Attention,
    /// Loss is imminent or has happened.
    Urgent,
}

impl Tone {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Quiet => "quiet",
            Self::Attention => "attention",
            Self::Urgent => "urgent",
        }
    }
}

/// The signals the automations plane raises.
///
/// Each variant is one of the four the lane's brief names, and each carries
/// what the card needs rather than a formatted string — so the shell can
/// render it in the member's own words and a test can assert on the fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    /// A cron trigger could not be scheduled because neither it nor the vault
    /// names a time zone. **The signal that replaces v0's tier 3**: v0 fell
    /// back to the host clock and said nothing, which on a UTC VPS is a
    /// schedule in the wrong hours with no evidence anywhere.
    ZoneUnset {
        automation_ref: String,
        expr: String,
    },
    /// A registration was skipped because the owner's background pause covers
    /// it. Quiet, and a SIGNAL rather than silence because *paused is not
    /// disabled* (`docs/recognition-automations.md:25`) and a member looking at
    /// a recipe that is not moving is owed the difference.
    RecipePaused { automation_ref: String },
    /// A target reached [`crate::handler::ENRICH_TARGET_MAX_FAILURES`] and the
    /// cursor advanced past it. The poison itself, which
    /// `docs/system-signals.md`'s enrichment probe lists per capability.
    TargetDeclined {
        capability: String,
        target_type: String,
        target_id: String,
        reason: String,
        failures: u32,
    },
    /// A capability's weights are not on disk and could not be fetched, so its
    /// automation stays unavailable until the next boot. **Reported, never
    /// thrown** (`docs/recognition-automations.md:81`).
    CapabilityUnavailable { capability: String, reason: String },
    /// An element was tried [`crate::fire::TRIGGER_MAX_ATTEMPTS`] times and
    /// given up on. The durable record is the cursor row; this is how it
    /// reaches a member.
    ElementDeadLettered {
        automation_ref: String,
        position: String,
        attempts: u32,
        error: String,
    },
}

impl Signal {
    #[must_use]
    pub const fn tone(&self) -> Tone {
        match self {
            // A schedule that cannot be set is a decision only the member can
            // make, so it pushes.
            Self::ZoneUnset { .. } => Tone::Attention,
            Self::RecipePaused { .. } => Tone::Quiet,
            // Both of these are "some of your library was given up on", which
            // is a fact in its destination rather than a push: the walk
            // continues and nothing is lost.
            Self::TargetDeclined { .. } | Self::CapabilityUnavailable { .. } => Tone::Quiet,
            Self::ElementDeadLettered { .. } => Tone::Attention,
        }
    }

    /// A stable code a shell switches on. Never the sentence.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::ZoneUnset { .. } => "automation.zone-unset",
            Self::RecipePaused { .. } => "automation.recipe-paused",
            Self::TargetDeclined { .. } => "enrichment.target-declined",
            Self::CapabilityUnavailable { .. } => "enrichment.capability-unavailable",
            Self::ElementDeadLettered { .. } => "automation.element-dead-lettered",
        }
    }

    /// The one action the card carries, as the destination's route id
    /// (`docs/system-signals.md` Destinations). One, never two.
    #[must_use]
    pub const fn action_route(&self) -> &'static str {
        match self {
            // Settings is where a zone is written from, which is why the
            // refusal is worth pushing at all.
            Self::ZoneUnset { .. } => "settings",
            Self::RecipePaused { .. } | Self::ElementDeadLettered { .. } => "autos",
            Self::TargetDeclined { .. } | Self::CapabilityUnavailable { .. } => "gateway",
        }
    }
}

/// Where a signal goes. The host's, because the shell's transport is the
/// host's.
pub trait SignalSink {
    fn raise(&self, signal: Signal);
}

/// A sink that drops everything.
///
/// Named, so a caller that genuinely has nowhere to send signals says so.
/// **Not the default anywhere**: `fire` takes the sink, so a host that forgot
/// to wire one does not compile.
#[derive(Debug, Clone, Copy, Default)]
pub struct Discard;

impl SignalSink for Discard {
    fn raise(&self, _signal: Signal) {}
}

/// A sink that remembers, for tests and for `centraid automations`'s own
/// report.
#[derive(Debug, Default)]
pub struct Recording(Mutex<Vec<Signal>>);

impl Recording {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Everything raised so far, in order.
    #[must_use]
    pub fn raised(&self) -> Vec<Signal> {
        self.0.lock().map(|inner| inner.clone()).unwrap_or_default()
    }

    /// Just the codes, which is what most assertions are about.
    #[must_use]
    pub fn codes(&self) -> Vec<&'static str> {
        self.raised().iter().map(Signal::code).collect()
    }
}

impl SignalSink for Recording {
    fn raise(&self, signal: Signal) {
        if let Ok(mut inner) = self.0.lock() {
            inner.push(signal);
        }
    }
}

impl<T: SignalSink + ?Sized> SignalSink for &T {
    fn raise(&self, signal: Signal) {
        (**self).raise(signal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_signal_carries_a_code_a_tone_and_exactly_one_action() {
        let signals = [
            Signal::ZoneUnset {
                automation_ref: "digest/digest".to_owned(),
                expr: "0 7 * * *".to_owned(),
            },
            Signal::RecipePaused {
                automation_ref: "faces/faces".to_owned(),
            },
            Signal::TargetDeclined {
                capability: "faces".to_owned(),
                target_type: "media.asset".to_owned(),
                target_id: "asset-1".to_owned(),
                reason: "failed".to_owned(),
                failures: 3,
            },
            Signal::CapabilityUnavailable {
                capability: "embed-image".to_owned(),
                reason: "the upstream could not be reached".to_owned(),
            },
            Signal::ElementDeadLettered {
                automation_ref: "poll/poll".to_owned(),
                position: "msg-9".to_owned(),
                attempts: 5,
                error: "timed out".to_owned(),
            },
        ];
        let mut codes: Vec<&str> = signals.iter().map(Signal::code).collect();
        let count = codes.len();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), count, "one code per signal");
        for signal in &signals {
            assert!(signal.code().contains('.'), "{}", signal.code());
            assert!(!signal.action_route().is_empty());
            assert!(matches!(
                signal.tone(),
                Tone::Quiet | Tone::Attention | Tone::Urgent
            ));
        }
    }

    /// The one that must PUSH, because it is the one only a member can fix.
    #[test]
    fn an_unset_zone_asks_a_member_and_points_at_settings() {
        let signal = Signal::ZoneUnset {
            automation_ref: "digest/digest".to_owned(),
            expr: "0 7 * * *".to_owned(),
        };
        assert_eq!(signal.tone(), Tone::Attention);
        assert_eq!(signal.action_route(), "settings");
    }

    #[test]
    fn a_recording_sink_keeps_order() {
        let sink = Recording::new();
        sink.raise(Signal::RecipePaused {
            automation_ref: "a".to_owned(),
        });
        sink.raise(Signal::RecipePaused {
            automation_ref: "b".to_owned(),
        });
        assert_eq!(sink.raised().len(), 2);
        assert_eq!(sink.codes(), ["automation.recipe-paused"; 2]);
        Discard.raise(Signal::RecipePaused {
            automation_ref: "c".to_owned(),
        });
    }
}
