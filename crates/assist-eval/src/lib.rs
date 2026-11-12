//! THE EVAL RUNNER of the on-device chat model (#1166, stage 10).
//!
//! A held-out set is replayed turn by turn through the phone's own step path: a [`run::Stepper`] writes the
//! model's message for the prompt `centraid_assist::native_turn::log::Log` renders (the phone's
//! `decode_step`, over any `Model`), the runtime (`centraid_assist::native::Session`) executes it over a private
//! copy of the world's vault, and the turn is judged by its EFFECT, never by call text (SPEC §10). This is
//! the retired Python rig (`eval/{run,score,metrics,slices}.py`, #1171) in Rust, plus what #1166 asks of stage 10:
//! tool accuracy, accuracy per argument (rows, date, filters, amount) and fail rate by constraint count.
//!
//! | module | is |
//! | --- | --- |
//! | [`source`] | [`source::EvalSource`]: where sessions and worlds come from (today the frozen JSONL set) |
//! | [`tally`] | takes the removed Tally app out of the held-out worlds as they are read |
//! | [`gold`] | the gold a session carries |
//! | [`effect`] | a turn's effect, from the runtime's responses (`lib.py` `turn_effect`) |
//! | [`judge`] | the scorer (`score.py` `judge_turn`) |
//! | [`args`] | constraint count and per-argument agreement (new in Rust) |
//! | [`run`] | the replay loop |
//! | [`replay`] | the reference calls replayed through the runner and judge: the precondition of a scoring run |
//! | [`compare`] | two reports paired by session: won, lost, z |
//! | [`report`] | the JSON report and the text summary |
//! | [`rollout`] | k sampled decodes per session, rollout reports and their comparison, RFT records and DPO pairs (#1171, M7) |

#![forbid(unsafe_code)]

pub mod args;
pub mod compare;
pub mod effect;
pub mod gold;
pub mod judge;
pub mod replay;
pub mod report;
pub mod rollout;
pub mod run;
pub mod source;
pub mod tally;

/// Why an eval could not run or score. A model that writes a bad call is not an error: that is a failed turn.
#[derive(Debug, thiserror::Error)]
pub enum EvalError {
    #[error("{path}: {message}")]
    Read { path: String, message: String },
    #[error("{what}: {message}")]
    Json { what: String, message: String },
    /// The world, the set or the gold is wrong, which no model can be blamed for.
    #[error("bad eval data: {0}")]
    Data(String),
    #[error("runtime: {0}")]
    Runtime(String),
}
