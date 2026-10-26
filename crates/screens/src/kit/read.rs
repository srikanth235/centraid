//! THE THREE STATES OF A READ, once. A failed read is not an empty list: a
//! screen holds a [`Reading`] and draws loading, a [`wire::Failure`], a
//! [`wire::Denied`] gate or data, and never conjures an empty `data` out of a
//! refusal.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::screen::Ctx;
use crate::strings::{Locale, shared};

/// What one `load` came to.
#[derive(Clone, Debug, PartialEq)]
pub enum Reading<T> {
    Data(T),
    /// The vault would not let the app read: a gate to draw, not a failure.
    Denied(wire::AppQueryDenial),
    /// The core refused, or answered with something else.
    Failed,
}

impl<T> Reading<T> {
    /// The data, when there is data.
    #[must_use]
    pub fn data(&self) -> Option<&T> {
        match self {
            Self::Data(data) => Some(data),
            _ => None,
        }
    }
}

/// Load `request` and take the answer `pick` recognises.
pub fn read<T>(
    ctx: &Ctx,
    request: impl Into<wire::LoadRequest>,
    pick: impl FnOnce(Answer) -> Option<T>,
) -> Reading<T> {
    let Ok(response) = ctx.load(request.into()) else {
        return Reading::Failed;
    };
    match response.answer.and_then(|answer| answer.answer) {
        Some(Answer::Denied(denial)) => Reading::Denied(denial),
        Some(answer) => pick(answer).map_or(Reading::Failed, Reading::Data),
        None => Reading::Failed,
    }
}

/// The failure a view draws for a read that did not come back: one sentence and
/// the one thing to do.
#[must_use]
pub fn failure(locale: Locale) -> wire::Failure {
    wire::Failure {
        sentence: shared::read_failed(locale),
        remedy: shared::kit_retry(locale),
    }
}

/// The failure for an answer that arrived short: some of the reads a screen
/// needs came back and some did not, and neither can be made up.
#[must_use]
pub fn incomplete(locale: Locale) -> wire::Failure {
    wire::Failure {
        sentence: shared::read_incomplete(locale),
        remedy: shared::kit_retry(locale),
    }
}
