//! # `DegradedReference` — the instrument that proves the suite RANKS
//!
//! **The gap this closes (review item B14).** Everything ever run against this
//! corpus scored either ~100% (the hand-written reference, which is the answer
//! key) or ~6% (the degenerate instruments, which understand nothing). A
//! measuring device that has only ever read *full* and *empty* has not been
//! shown to have a scale: nothing established that a runtime which is right
//! four times in five lands between them, still less that it lands ABOVE one
//! which is right one time in two.
//!
//! So this is a candidate with a dial. At probability `p` it answers a turn
//! with the reference's outcome; the rest of the time it falls back to the
//! best instrument that understands nothing in particular — keyword overlap
//! across both doors, which is the strongest thing in `nulls` that is not the
//! reference wearing a defect. Sweep `p` and the score has to move with it, or
//! the suite does not rank.
//!
//! ## Why it is deterministic, and how
//!
//! A coin flipped from the system clock would make the table unreproducible
//! and the monotonicity claim unfalsifiable. The choice is a hash of
//! `(seed, session id, turn index)` folded into `0.0..1.0` — so the SAME turns
//! are degraded on every run of a given `p` and seed, and a run can be
//! repeated by anybody.
//!
//! It is also a NESTED sweep by construction: the hash of a turn does not
//! depend on `p`, so every turn the instrument gets right at `p = 0.5` it also
//! gets right at `p = 0.7` and at `p = 0.9`. The scores are therefore
//! comparable across the row rather than being three independent samples, and
//! a non-monotone column would be a defect in the SCORE, not in the sampling.
//!
//! ## What it must never be
//!
//! **Not a scoring aid, and never part of a verdict.** It is a probe pointed
//! at the harness, exactly like `nulls`: the thing under test here is the
//! evaluation, not the candidate.

use crate::{Candidate, CandidateRuntime, Context, Plan, Session};

/// A runtime that is the reference with probability `p`, and the best
/// degenerate instrument otherwise.
pub struct DegradedReference<'runtime> {
    name: String,
    correct: &'runtime dyn CandidateRuntime,
    fallback: &'runtime dyn CandidateRuntime,
    /// In `0.0..=1.0`.
    p: f64,
    seed: u64,
}

impl<'runtime> DegradedReference<'runtime> {
    /// Right with probability `p`, and the fallback the rest of the time.
    #[must_use]
    pub fn new(
        correct: &'runtime dyn CandidateRuntime,
        fallback: &'runtime dyn CandidateRuntime,
        p: f64,
        seed: u64,
    ) -> Self {
        Self {
            name: format!("Degraded(p={p:.2})"),
            correct,
            fallback,
            p,
            seed,
        }
    }
}

impl CandidateRuntime for DegradedReference<'_> {
    fn name(&self) -> &str {
        &self.name
    }
    fn session(&self, session: &Session) -> Box<dyn Candidate> {
        Box::new(DegradedSession {
            correct: self.correct.session(session),
            fallback: self.fallback.session(session),
            id: session.id.clone(),
            turn: 0,
            p: self.p,
            seed: self.seed,
        })
    }
}

struct DegradedSession {
    correct: Box<dyn Candidate>,
    fallback: Box<dyn Candidate>,
    id: String,
    turn: usize,
    p: f64,
    seed: u64,
}

impl Candidate for DegradedSession {
    fn turn(&mut self, request: &str, ctx: &mut Context<'_>) -> Plan {
        let draw = uniform(self.seed, &self.id, self.turn);
        self.turn += 1;
        // **EXACTLY ONE OF THE TWO RUNS.** Asking both would double every
        // door call and — on a write turn — execute the command twice, which
        // would make the cost columns and the changed-row set describe a
        // candidate nobody is scoring.
        if draw < self.p {
            self.correct.turn(request, ctx)
        } else {
            self.fallback.turn(request, ctx)
        }
    }
}

/// A deterministic draw in `0.0..1.0` from a turn's identity.
///
/// FNV-1a, spelled out rather than pulled in: the property wanted is that the
/// same turn draws the same number on every machine and every run, which a
/// two-line hash gives and a dependency would only dress up.
fn uniform(seed: u64, session: &str, turn: usize) -> f64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |byte: u8| {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    };
    for byte in seed.to_le_bytes() {
        eat(byte);
    }
    for byte in session.as_bytes() {
        eat(*byte);
    }
    for byte in (turn as u64).to_le_bytes() {
        eat(byte);
    }
    #[expect(
        clippy::cast_precision_loss,
        reason = "a draw in 0..1 from the top 53 bits of a hash"
    )]
    let value = (hash >> 11) as f64 / (1u64 << 53) as f64;
    value
}
