//! ROLLOUTS: stage 11 of the training-data pipeline (#1171, M7). Sample `k` decodes of a model over datagen sessions,
//! let the runtime check every turn against gold (the eval's judge, unchanged), and turn the results into the
//! records a second round of training reads.
//!
//! | module | is |
//! | --- | --- |
//! | this one | [`Sampling`], one [`Rollout`] (a session's result for one sample), [`run_rollouts`], and [`fake`], a scripted model |
//! | [`report`] | pass rates per grid cell, tag, constraint count and argument class; [`report::compare`] of two reports |
//! | [`records`] | RFT records (passing rollouts, weighted toward what the model still fails) and DPO pairs |
//!
//! A rollout is a whole session run free: the model's own calls make the history its later turns see, as on the phone.
//! A turn after a failed one is therefore downstream of the failure, and the reports count a rollout's turns only up
//! to and including its first failure (the eval's `clean_turn_pass`, for the same reason). The model sits behind
//! [`crate::run::Stepper`], so everything here is tested without weights; the engine behind the `engine` feature
//! decodes with `temperature` and `top_p` and a seed (`centraid-assist-llama`'s `sampling`).

pub mod fake;
pub mod records;
pub mod report;

use serde::{Deserialize, Serialize};

use crate::EvalError;
use crate::gold::Session;
use crate::run::{Runner, SessionResult};

/// How the decodes were sampled: what a report and a records file say about where their rollouts came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sampling {
    /// Decodes per session.
    pub k: usize,
    /// `0.0` is greedy (every sample is the same); a rollout wants `0.6` or so (Python's driver used 0.6).
    pub temperature: f32,
    pub top_p: f32,
    /// The engine's seed; one seed repeats a whole run.
    pub seed: u64,
    /// `off`, `handles` or `full` (`StepOptions::grammar`).
    pub grammar: String,
    /// `s2`, `sig`, `compact` or `full`.
    pub tools: String,
}

/// One session decoded once: the result for sample `sample`, `0..k`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rollout {
    pub sample: usize,
    #[serde(flatten)]
    pub result: SessionResult,
}

impl Rollout {
    /// The first turn that ran and failed, if any. A turn that did not run (after an engine error) is no failure.
    #[must_use]
    pub fn first_failure(&self) -> Option<usize> {
        self.result.turns.iter().position(|t| t.run && !t.pass)
    }

    /// The turns that count: up to and including the first failure.
    #[must_use]
    pub fn clean(&self) -> usize {
        self.first_failure()
            .map_or(self.result.turns.len(), |at| at + 1)
    }
}

/// Run `session` `k` times through the runner's stepper. Each sample is a fresh copy of the world's vault.
///
/// # Errors
/// [`EvalError`] for data no model can be blamed for (the world will not seed, gold names no row).
pub fn run_rollouts(
    runner: &mut Runner<'_>,
    session: &Session,
    k: usize,
) -> Result<Vec<Rollout>, EvalError> {
    (0..k)
        .map(|sample| {
            runner
                .run_session(session)
                .map(|result| Rollout { sample, result })
        })
        .collect()
}
