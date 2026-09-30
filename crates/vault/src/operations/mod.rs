//! THE DOMAIN OPERATION LAYER (#996 wave 0c; rulings R21, R23, R25).
//!
//! One invariant boundary: every writer — a typed command, an importer, Atlas
//! and the seat's local apply — reaches a canonical table through the
//! operations declared here, so **the same invalid mutation meets the same
//! named condition with the same words whichever door it arrives at**.
//!
//! Two operations live here today, both `schedule`'s, and both are the lane
//! Schedule slice of #1020:
//!
//! | Module | What it owns |
//! |---|---|
//! | [`task_write`] | the five questions every `schedule_task` writer asks of the row AS IT WILL BE (ONT-26, ONT-31) |
//! | [`task_lifecycle`] | complete / reopen / cancel, the series identity and the recurrence rollover (ONT-27) |
//!
//! They are the vault's, not `crates/apps/tasks`': People's task commands, the
//! extension's `capture:task` frame and automations all reach them by name.

pub mod task_lifecycle;
pub mod task_write;

pub use task_lifecycle::{
    SUCCESSOR_INHERITS_SERIES_LINKS_SQL, TaskLifecycle, TaskLifecycleResult, cancel, complete,
    reopen,
};
pub use task_write::{
    MAX_HIERARCHY_DEPTH, Stated, TASK_WRITE_CONDITIONS, TaskImage, TaskRefusal, TaskWriteDraft,
    assert_task_write, task_image,
};
