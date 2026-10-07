//! A CONSENT DENIAL, as an app's payload carries it — one type for every app.
//!
//! Every v0 app query wraps its body and answers `{…empty, vaultDenied:
//! {code, message}}` rather than throwing. A denial is a value in the payload,
//! never a [`crate::KitError`]. `revoked_at` comes from the HOST, because a
//! revoked app cannot read the consent tables to date its own revocation — so
//! it is an `Option` no app crate fills in.
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
