//! THE ACTION TABLE'S ROW, one type for all nine apps (#1135).
//!
//! Each app carries a Rust table that says which vault command each manifest
//! action invokes and whether the dispatching surface asks first. The row was
//! copied into every app crate; it is stated here once, and the core's
//! catalogue reads the tables through it.

/// Whether the **dispatching surface** asks before dispatching. The manifest's
/// `confirmation`, not the command definition's `confirm`: two gates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confirm {
    None,
    Required,
}

/// One row of an app's action table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionRow {
    pub action: &'static str,
    pub command: &'static str,
    pub confirm: Confirm,
}

/// A row the surface runs without asking.
#[must_use]
pub const fn act(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::None,
    }
}

/// A row the surface asks about first: what cannot be taken back or touches
/// many rows.
#[must_use]
pub const fn confirmed(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::Required,
    }
}

/// The row of `action` in `rows`.
#[must_use]
pub fn find<'a>(rows: &'a [ActionRow], action: &str) -> Option<&'a ActionRow> {
    rows.iter().find(|row| row.action == action)
}
