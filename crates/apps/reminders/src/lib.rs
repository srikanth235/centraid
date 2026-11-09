//! # Reminders — tasks and lists
//!
//! Agenda became two apps (#1173, round 10): Calendar owns events and invites, and this crate owns
//! tasks and their containers (lists, projects, sections, areas). A task is a vault entity kind;
//! the reads are [`task`], the natural-language dates a quick add understands are [`nl_date`], and
//! the writes are [`commands`]. Reminders never touches an event: Calendar shows a reminder on its
//! day, read-only, and opens it here.
//!
//! The doctrine of the reads is [`task`]'s own header. **No data of its own**: the app reads and
//! writes the personal vault, and `cargo xtask rules`' `sql-confinement` keeps SQL out of this crate.

pub mod attachments;
pub mod commands;
pub mod manifest;
pub mod nl_date;
pub mod task;

pub use attachments::{ATTACHMENTS_PAGE_MAX, AttachmentRow, AttachmentsData, load_attachments};
pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use manifest::{APP_ID, manifest};

/// A read refusal, as the payload carries it: the kit's one type, shared by every app.
pub use centraid_apps_kit::{Denial, Reading, denial_of};
