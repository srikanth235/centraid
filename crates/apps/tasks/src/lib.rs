//! # Tasks — two queries, thirteen actions, and one promotion rule
//!
//! 8,005 lines of v0 TypeScript, **2 queries**, 11 actions, 22 scopes — the
//! smallest surface of any app (#1020, wave 4 census §A7). Its doctrine, from
//! the board's own header:
//!
//! - **THE BOARD IS A BOUNDED WINDOW, NEVER A WHOLE-TABLE PULL** (#262):
//!   newest open tasks by `created_at`, caller-sized, plus the 50 most recently
//!   closed as the logbook.
//! - **`truncated` IS THE OPEN PAGE'S OWN CURSOR** — it exists or it does not
//!   (#996 R8). `rows.length >= window` cannot tell a window that filled
//!   exactly from one that ran out, and the manifest states the rule as a
//!   contract: this is the one place in the tree where it does.
//! - **AN UNFINISHED CHILD OF A CLOSED PARENT IS PROMOTED** onto the open board
//!   ([`board::nest_task_families`]): completing the parent must not hide
//!   remaining work, and the logbook parent then keeps only its closed children
//!   so no row is drawn twice.
//! - **NO MODULE-LEVEL CEILING.** The caller's `limit` (20…500) is the only
//!   bound. **A port that adds one is adding a refusal v0 does not have**
//!   (census §A7), so this crate declares none and a test says so.
//! - **COMPLETION IS ONE OPERATION** and it is the vault's
//!   ([`centraid_vault::operations::task_lifecycle`]), not this app's: People,
//!   automations and an import complete the same row through the same code, and
//!   the recurrence rollover is part of it (#996 R21, ONT-27).
//! - **A REPEATING TASK NEVER STACKS**: unactioned periods collapse into a
//!   count and a next due date, both from the one engine
//!   ([`centraid_vault::time::recurrence::collapse_missed`]), so no surface
//!   ever sees an RRULE string or re-counts a missed period for itself (#834).
//! - **NO DATA OF ITS OWN** — revoke the grant and the app goes dark.
//! - **THE PHONE READS IT IN THE CORE** (#1046): `crates/core`'s `app_query`
//!   runs [`load_board`], [`load_task`] and [`load_search_term`] and answers
//!   `tasks.proto`. Every civil reading a screen draws — a due's local day and
//!   time, overdue, today, the reminder's wall clock, each place's groups — is
//!   [`local`] and [`views`], in the zone the device states.
//!
//! ## What this crate is allowed to contain, and what stops the rest
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate |
//! | A second recurrence engine, or a second summariser | [`queries`] calls `centraid_vault::time`; there is no cadence grammar here |
//! | A module-level ceiling | [`board::BOARD_MIN`]/[`board::BOARD_MAX`] are the MANIFEST's declared window and nothing else bounds a read |
//! | A write from a query | [`queries`] holds statements and a [`centraid_apps_kit::PageDoor`] |
//! | An invocation with no `invoke_key` | the field is required on [`commands::Invocation`] (D-1020-D3-5) |
//! | A denial turned into an error | [`Denial`] is a value every query answers beside its payload |

pub mod board;
pub mod commands;
pub mod local;
pub mod manifest;
pub mod queries;
pub mod views;

pub use board::{
    BOARD_DEFAULT, BOARD_MAX, BOARD_MIN, Families, FamilyRow, LOGBOOK_ROWS, by_urgency,
    is_open_board_root, is_open_status, nest_task_families,
};
pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use manifest::{APP_ID, manifest};
pub use queries::{
    BoardData, SearchData, TaskDetailData, TaskRow, load_board, load_search, load_search_term,
    load_task,
};

/// A CONSENT DENIAL, as the payload carries it: the kit's one type, shared by
/// every app so the core settles all of them through one door.
pub use centraid_apps_kit::Denial;

/// A door error, as the payload's denial.
#[must_use]
pub fn denial_of(message: String) -> Denial {
    Denial {
        code: None,
        message: Some(message),
        revoked_at: None,
    }
}
