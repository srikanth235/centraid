//! A read refusal, as an app's payload carries it — one type for every app.
//!
//! Door failures are values in the payload; bounded-read and validation errors
//! remain [`crate::KitError`] values. `revoked_at` is retained in the payload
//! shape and stays absent for personal-vault reads.
//!
//! One type rather than one per app so the core answers every app's denial
//! through one `settle`, with no field-for-field conversion between copies.

use crate::KitError;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Denial {
    pub code: Option<String>,
    pub message: Option<String>,
    pub revoked_at: Option<String>,
}

impl Denial {
    /// The denial a door failure lowers to. The kit's error text is the
    /// `message`; `code` stays absent because the kit does not mint one and an
    /// invented code is a code a surface would switch on.
    #[must_use]
    pub fn from_door(error: &KitError) -> Self {
        Self {
            code: None,
            message: Some(error.to_string()),
            revoked_at: None,
        }
    }
}
