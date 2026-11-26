//! WHAT A ROOM MAY ASK OF THE CORE: run one catalogue action, take it back, and the time. A room
//! never opens the vault itself; the core hands the runtime this door.

use super::selector::Act;

/// An action that ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Done {
    /// The status line's sentence ("Note moved to trash").
    pub sentence: String,
    /// Whether the status line offers Undo.
    pub undo: bool,
}

/// An action the core refused, in the core's own sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

pub trait Door: Send + Sync {
    /// Run `act` as one commit.
    ///
    /// # Errors
    /// The core's sentence for a refusal.
    fn act(&self, act: &Act) -> Result<Done, Refused>;

    /// Take back the last action the status line offered Undo for.
    ///
    /// # Errors
    /// The core's sentence, when the record changed again.
    fn undo(&self) -> Result<Done, Refused>;

    fn now_ms(&self) -> i64;
}
