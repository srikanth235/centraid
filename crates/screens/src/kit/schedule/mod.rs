//! WHAT CALENDAR AND REMINDERS SHARE (round 10 of #1173, the split of Agenda): the pieces both apps
//! draw with and neither owns. A reminder is a row on a Calendar day as well as on a Reminders page,
//! a repeat rule is spoken one way whoever holds it, and the attachments page and the style sheet
//! serve an event and a task alike.
//!
//! Nothing here names an app's module: an app's screens import from here and the two never import
//! each other (`screens-per-app-layout`).

pub mod attachments;
pub mod natural;
pub mod ops;
pub mod repeat;
pub mod rows;
pub mod rule_words;
pub mod style;
