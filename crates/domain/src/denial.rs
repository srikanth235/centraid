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

/// THE THREE STATES OF A READ, once, for every surface in this app.
///
/// `Option<T>` collapses two of the three (census §A seam 5): "not asked yet"
/// and "asked and refused" both become `None`, and the failure mode is an
/// empty list where the honest answer is *unknown*. On a calendar that failure has
/// a name: **a day with no birthday and a day whose party plane was refused
/// look identical** on a calendar grid, and only one of them is worth asking
/// the owner about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reading<T> {
    /// The read has not happened yet. A surface renders a skeleton.
    Loading,
    /// The vault refused, or the door was not there. A surface renders the ask.
    Denied(Denial),
    /// The answer.
    Data(T),
}

impl<T> Reading<T> {
    /// The data, when there is data. **Not** a default.
    pub const fn data(&self) -> Option<&T> {
        match self {
            Self::Data(value) => Some(value),
            Self::Loading | Self::Denied(_) => None,
        }
    }

    /// Whether this reading is a refusal a surface should offer to fix.
    pub const fn denied(&self) -> bool {
        matches!(self, Self::Denied(_))
    }

    /// `true` where the fact is KNOWN, whatever it turned out to be.
    pub const fn known(&self) -> bool {
        matches!(self, Self::Data(_))
    }
}

/// A door error, as the payload's denial.
#[must_use]
pub fn denial_of(message: String) -> Denial {
    Denial {
        code: None,
        message: Some(message),
        revoked_at: None,
    }
}
