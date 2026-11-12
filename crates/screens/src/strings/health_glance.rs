//! Health outside the app (#1185): the words of the Health widget's snapshot and the static names
//! the platform needs at COMPILE time (the widget's gallery name and description).
//!
//! The static words (`widget_*`) are exported to both shells by `cargo xtask design`
//! (`GlanceWords.swift`, `glance_strings.xml`), because a manifest cannot call into Rust. A static
//! row therefore stays one line and `plain`. The rest travel inside the snapshot document and are
//! finished here, in the device's locale. A figure's own words (its label, its unit) are
//! `strings/health.rs` and `strings/quantity.rs`, said by `kit::quantity` in the member's units.

catalog! {
    plain empty = ("Connect Health to see today", "Connect Health to see today");
    plain nothing = ("Nothing yet today", "Nothing yet today");
    plain slept = ("Slept {duration}", "Slept {duration}");
    plain stale = ("Not updated today", "Not updated today");
    plain stale_hint = ("Open Centraid to refresh", "Open Centraid to refresh");
    plain steps_caption = ("steps today", "steps today");
    plain title = ("Health", "Health");
    plain unavailable = ("Open Centraid to see Health", "Open Centraid to see Health");
    plain widget_description = ("Today's steps, sleep and activity.", "Today's steps, sleep and activity.");
    plain widget_name = ("Health", "Health");
}
