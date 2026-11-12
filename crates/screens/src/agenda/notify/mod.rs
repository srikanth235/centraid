//! AGENDA'S NOTIFICATIONS (#1173): the view-less service `reminders.notify` that
//! decides which reminders the phone should hold and says it, whole, every time
//! the set changes.
//!
//! | Part | What it is |
//! |---|---|
//! | [`desired`] | THE SET: task reminders and event alerts, a pure function of what the core read |
//! | [`answer`] | WHAT A BUTTON DOES: done, snooze an hour, tomorrow, undo, open |
//! | [`service`] | THE SERVICE: when to read, when to speak, what it keeps between |
//!
//! Rust sends the WHOLE desired set (`wire::ScheduleNotifications`); a shell
//! diffs it against what the OS holds and reports back what the member pressed
//! (`NotificationAnswered`). Every word travels inside the set. A task or an
//! event with no moment (a date-only due, an all-day event) sounds at 09:00 that day wherever
//! the member is, and the item never gains that time (#1188, NA6).

pub mod answer;
pub mod desired;
pub mod service;

pub use desired::{CAP, Inputs, OS_PENDING_LIMIT, RECEIPTS, WINDOW_DAYS, categories, desired};
pub use service::{NAME, Sync, build, route, services};
