//! The owner check, once. Anything that leaves the phone in the clear, and a
//! restore from words, asks the phone whether the member is its owner first
//! (#1185). A screen holds an [`OwnerGate`], raises it at the member's tap,
//! and does the guarded thing only on [`Answer::Passed`] or
//! [`Answer::PassedUnprotected`]. Opening a screen never asks, and an import is
//! not checked. Locker's own wall (`locker/wall.rs`) stays its own machine:
//! it also counts failed unlocks and holds the session.

use centraid_api_proto::core_v1 as wire;

use crate::strings::{Locale, shared};

/// What the gate is guarding, which picks the prompt's words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Leaving {
    Export,
    Share,
    Restore,
    Reveal,
}

/// What a phone with no passcode means (D15): Locker refuses; the rest warn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoPasscode {
    Refuse,
    Warn,
}

/// The phone's answer, in what the screen does next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    /// The member is the owner: go ahead.
    Passed,
    /// No passcode on this phone and the policy is Warn: go ahead, and show this sentence.
    PassedUnprotected(String),
    /// The phone refused (not recognised, locked out, or no passcode under Refuse): show this sentence, do nothing.
    Refused(String),
    /// The member dismissed the prompt: do nothing, say nothing.
    Cancelled,
}

/// One owner check in flight, or none.
#[derive(Debug, Default)]
pub struct OwnerGate {
    asking: bool,
}

impl OwnerGate {
    /// Whether a prompt is up.
    #[must_use]
    pub fn asking(&self) -> bool {
        self.asking
    }

    /// Raise the prompt: one `OwnerCheck{ask:true,..}` effect with the kit's
    /// words for `leaving`.
    pub fn begin(&mut self, locale: Locale, leaving: Leaving) -> Vec<wire::Effect> {
        self.asking = true;
        let reason = match leaving {
            Leaving::Export => shared::owner_reason_export(locale),
            Leaving::Share => shared::owner_reason_share(locale),
            Leaving::Restore => shared::owner_reason_restore(locale),
            Leaving::Reveal => shared::owner_reason_reveal(locale),
        };
        vec![effect(wire::OwnerCheck {
            ask: true,
            reason,
            title: shared::owner_title(locale),
            subtitle: String::new(),
            cancel: false,
        })]
    }

    /// The shell's answer. `None` when this gate was not asking (the result is
    /// someone else's).
    pub fn answer(
        &mut self,
        locale: Locale,
        policy: NoPasscode,
        checked: &wire::OwnerChecked,
    ) -> Option<Answer> {
        use wire::owner_checked::Outcome as O;
        if !self.asking {
            return None;
        }
        self.asking = false;
        let outcome = O::try_from(checked.outcome).unwrap_or(O::Unspecified);
        Some(match outcome {
            O::Succeeded => Answer::Passed,
            O::Cancelled => Answer::Cancelled,
            O::LockedOut => Answer::Refused(shared::owner_locked_out(locale)),
            O::Unavailable => match policy {
                NoPasscode::Refuse => Answer::Refused(shared::owner_no_passcode(locale)),
                NoPasscode::Warn => Answer::PassedUnprotected(shared::owner_unprotected(locale)),
            },
            O::Failed | O::NotAsked | O::Unspecified => {
                Answer::Refused(shared::owner_not_confirmed(locale))
            }
        })
    }

    /// Take the prompt down (the member left the screen): the
    /// `OwnerCheck{cancel:true}` effect when one is up, else nothing.
    pub fn cancel(&mut self) -> Vec<wire::Effect> {
        if !std::mem::take(&mut self.asking) {
            return Vec::new();
        }
        vec![effect(wire::OwnerCheck {
            cancel: true,
            ..Default::default()
        })]
    }
}

fn effect(check: wire::OwnerCheck) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::OwnerCheck(check)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire::owner_checked::Outcome as O;

    fn checked(outcome: O) -> wire::OwnerChecked {
        wire::OwnerChecked {
            outcome: outcome as i32,
            ..Default::default()
        }
    }

    fn asked(leaving: Leaving, policy: NoPasscode, outcome: O) -> Answer {
        let mut gate = OwnerGate::default();
        let _ = gate.begin(Locale::En, leaving);
        gate.answer(Locale::En, policy, &checked(outcome))
            .expect("asking")
    }

    #[test]
    fn begin_raises_one_ask_and_cancel_takes_it_down_once() {
        let mut gate = OwnerGate::default();
        assert!(!gate.asking());
        assert!(gate.cancel().is_empty());
        let effects = gate.begin(Locale::En, Leaving::Share);
        assert!(gate.asking());
        assert_eq!(effects.len(), 1);
        let Some(wire::effect::Kind::OwnerCheck(check)) = &effects[0].kind else {
            panic!("not an owner check");
        };
        assert!(check.ask && !check.cancel);
        assert_eq!(check.reason, shared::owner_reason_share(Locale::En));
        assert_eq!(check.title, shared::owner_title(Locale::En));
        let down = gate.cancel();
        assert!(!gate.asking());
        let Some(wire::effect::Kind::OwnerCheck(check)) = &down[0].kind else {
            panic!("not an owner check");
        };
        assert!(check.cancel && !check.ask);
        assert!(gate.cancel().is_empty());
    }

    #[test]
    fn each_leaving_has_its_own_words() {
        let reasons: Vec<String> = [
            Leaving::Export,
            Leaving::Share,
            Leaving::Restore,
            Leaving::Reveal,
        ]
        .into_iter()
        .map(|l| {
            let Some(wire::effect::Kind::OwnerCheck(c)) =
                OwnerGate::default().begin(Locale::En, l).remove(0).kind
            else {
                panic!("not an owner check");
            };
            c.reason
        })
        .collect();
        for (i, a) in reasons.iter().enumerate() {
            assert!(!a.is_empty());
            for b in &reasons[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn every_outcome_under_every_policy() {
        for policy in [NoPasscode::Refuse, NoPasscode::Warn] {
            assert_eq!(asked(Leaving::Export, policy, O::Succeeded), Answer::Passed);
            assert_eq!(
                asked(Leaving::Export, policy, O::Cancelled),
                Answer::Cancelled
            );
            for refused in [O::Failed, O::LockedOut, O::NotAsked, O::Unspecified] {
                assert!(matches!(
                    asked(Leaving::Export, policy, refused),
                    Answer::Refused(s) if !s.is_empty()
                ));
            }
        }
        assert!(matches!(
            asked(Leaving::Export, NoPasscode::Refuse, O::Unavailable),
            Answer::Refused(s) if s == shared::owner_no_passcode(Locale::En)
        ));
        assert_eq!(
            asked(Leaving::Share, NoPasscode::Warn, O::Unavailable),
            Answer::PassedUnprotected(shared::owner_unprotected(Locale::En))
        );
    }

    #[test]
    fn an_answer_is_taken_once_and_only_while_asking() {
        let mut gate = OwnerGate::default();
        assert!(
            gate.answer(Locale::En, NoPasscode::Warn, &checked(O::Succeeded))
                .is_none()
        );
        let _ = gate.begin(Locale::En, Leaving::Export);
        assert!(
            gate.answer(Locale::En, NoPasscode::Warn, &checked(O::Succeeded))
                .is_some()
        );
        assert!(!gate.asking());
        assert!(
            gate.answer(Locale::En, NoPasscode::Warn, &checked(O::Succeeded))
                .is_none()
        );
    }
}
