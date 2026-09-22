//! # `centraid-candidates` — candidate runtimes for the assistant eval harness
//!
//! Everything here is scored through [`centraid_evalsuite`]'s own interface —
//! [`Candidate`](centraid_evalsuite::Candidate),
//! [`CandidateRuntime`](centraid_evalsuite::CandidateRuntime),
//! [`Plan`](centraid_evalsuite::Plan) and
//! [`Context`](centraid_evalsuite::Context) — and reaches the vault through no
//! other door. There is no SQL in this crate and there is no session-id
//! matching in the executor.
//!
//! * [`canon`] — the canonical grammar as Rust types, with a parser and a
//!   serializer.
//! * [`exec`] — the executor: a canonical tree plus per-session state becomes a
//!   `Plan`.
//! * [`model`] — `ModelCanonical`, the same executor handed a TRAINED MODEL's
//!   own canonical strings out of a file. A real candidate, not a ceiling.
//! * [`oracle`] — `OracleCanonical`, the executor's CEILING TEST: it is handed
//!   the gold canonical and measures how much of the meaning space the executor
//!   can actually execute. It is not a shipping candidate.

pub mod canon;
pub mod exec;
// Lane J: the JOIN — the tier-D parser wired to the executor. The first
// shipping-shaped candidate; `oracle` remains the ceiling it is measured against.
pub mod joined;
pub mod map;
// Lane TRAINING: a fine-tuned seq2seq model's own canonicals, same executor.
pub mod model;
// Lane P: the tier-D, no-model paraphrase parser (text -> canonical STRING).
pub mod oracle;
pub mod parse;

#[cfg(test)]
mod tests;

use std::path::PathBuf;

/// Where a corpus file lives.
#[must_use]
pub fn corpus_path(corpus: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("evalsuite")
        .join(format!("{corpus}.json"))
}

/// Run [`oracle::OracleCanonical`] over one corpus.
///
/// `holdout.json` is the SECOND scenario's world; the other two are the first.
///
/// # Errors
///
/// The corpus, the world or the map does not read, or the handles do not
/// resolve against the world.
pub fn oracle_report(corpus: &str) -> Result<centraid_evalsuite::Report, String> {
    let path = corpus_path(corpus);
    let mut suite = centraid_evalsuite::Suite::read(&path)?;
    let template = if corpus == "holdout" {
        centraid_evalsuite::WorldTemplate::build_scenario(centraid_evalworld::Scenario::Second)?
    } else {
        centraid_evalsuite::WorldTemplate::build()?
    };
    suite.resolve(&template.inventory)?;
    let runtime = oracle::OracleCanonical::new(corpus, &map::default_path())?;
    centraid_evalsuite::run(&suite, &template, &runtime)
}

/// Run [`model::ModelCanonical`] over one corpus, from a model-output JSONL.
///
/// # Errors
///
/// The corpus, the world or the output file does not read, or the handles do
/// not resolve against the world.
pub fn model_report(
    corpus: &str,
    outputs: &std::path::Path,
) -> Result<centraid_evalsuite::Report, String> {
    let path = corpus_path(corpus);
    let mut suite = centraid_evalsuite::Suite::read(&path)?;
    let template = if corpus == "holdout" {
        centraid_evalsuite::WorldTemplate::build_scenario(centraid_evalworld::Scenario::Second)?
    } else {
        centraid_evalsuite::WorldTemplate::build()?
    };
    suite.resolve(&template.inventory)?;
    let runtime = model::ModelCanonical::new(corpus, outputs)?;
    centraid_evalsuite::run(&suite, &template, &runtime)
}
