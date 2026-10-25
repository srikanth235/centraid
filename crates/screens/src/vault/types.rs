//! What the shelf answers to the screens that found, restore and re-key.
//!
//! The shapes mirror `custody::keeper` (the words lane's seam), field for field,
//! so the real shelf is that seam's implementation without a translation.

use centraid_api_proto::core_v1 as wire;

/// A result and the secret writes the shell must perform because of it. The
/// shelf is synchronous and talks to nobody: whoever called it sends `writes`
/// in one batch and absorbs the answers.
#[derive(Debug)]
pub struct Effected<T> {
    pub value: T,
    pub writes: Vec<wire::SecretOp>,
}

impl<T> Effected<T> {
    #[must_use]
    pub fn new(value: T) -> Self {
        Self {
            value,
            writes: Vec::new(),
        }
    }
}

/// Why a vault was not founded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FoundRefusal {
    /// No core could be opened to found into (or the seed a vault on its own
    /// words is kept on is not on this phone).
    NoCore,
    /// The core refused the found.
    NotFounded,
    /// The file already holds a vault this phone holds.
    AlreadyHeld,
}

/// What founding came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Found {
    /// The vault exists and is in front. The name comes out of the vault.
    Made(String),
    Refused(FoundRefusal),
    /// The session is not open yet: try again in a moment.
    NoSession,
}

/// One vault a restore laid down: where, the index it was found at, and the
/// entry it was restored from when it is on its own words (R-1047-E18).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Restored {
    pub path: String,
    pub index: u32,
    pub own: Option<String>,
}

/// The vault in front.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Foreground {
    pub vault_id: String,
    pub name: String,
}
