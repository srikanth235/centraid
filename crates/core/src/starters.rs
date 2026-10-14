//! THE STARTER ROWS: what a member's first vault holds the moment it is
//! founded with `FOUND_CONTENT_STARTERS`.
//!
//! Onboarding's goal is time to the member's OWN data (docs/decisions.md,
//! "Onboarding without sample data", `#onboarding-without-sample-data`), so
//! these are ORDINARY ROWS OF THE MEMBER'S, with no mark and nothing to clean
//! up: a vault they just made is not a blank wall, and every row here is one
//! they edit, complete or delete like any other. There is no sample data: the
//! Tahoe scenario ([`crate::example`]) seeds dev fixtures and tests only, and no
//! found writes it.
//!
//! **EACH ROW TEACHES ONE REAL GESTURE, AND IS FINISHED BY DOING IT** (R-ONBOARD-5):
//! a note that is trashed from the list's … menu (the one place a note is
//! trashed), a note that teaches `[[` links, a task completed by its circle and
//! one that teaches what opening a task gives. Only gestures both shells draw:
//! there is no swipe or long press in Notes or Tasks, so no row mentions one.
//! People, Agenda and
//! Docs get none because their day one offers an import.
//!
//! **THE TASKS ARE DUE TODAY, the member's today**: Tasks opens on Today, and a
//! starter that sat in the Inbox would leave Today saying there is nothing to
//! do. The day is read in the zone the found carried (`FoundRequest.tz`), UTC
//! when it carried none.
//!
//! **THE ROWS ARE DATA**, declared once in [`NOTES`] and [`TASKS`], so a test
//! reads the same consts [`write`] writes and changing the content never has to
//! change the test.
//!
//! **BEST-EFFORT BY DESIGN.** A refused starter is a warning, never a failure:
//! an empty vault is still a vault, and refusing the found over a teaching row
//! would cost the member the vault they asked for.

use centraid_vault::commands::Registry;
use centraid_vault::{Principal, Vault};
use serde_json::json;

use crate::example::{Report, Seeder};

/// The starter notes, in the order they are written: `(title, body)`, each a
/// plain-text `knowledge.create_note`.
pub const NOTES: &[(&str, &str)] = &[
    (
        "This note is yours",
        "It lives in your vault, on this phone. Edit it, or trash it: in the list, tap … beside it and choose Trash.",
    ),
    (
        "Link with [[",
        "Type [[ anywhere in a note to link a person, an event, a task or another note. Try it here, then trash this note.",
    ),
];

/// The starter tasks, in the order they are written, each a `schedule.add_task`
/// due on the member's today.
pub const TASKS: &[&str] = &[
    "Tap the circle to finish me",
    "Open me to add a date, a tag or a subtask",
];

/// THE MEMBER'S TODAY, `YYYY-MM-DD`, in the IANA zone `tz` at `now_ms`: UTC's
/// when `tz` is empty or not one the bundled database knows.
#[must_use]
pub fn local_today(tz: &str, now_ms: i64) -> String {
    let zone = centraid_vault::time::zone::FireZone::named(tz)
        .or_else(|_| centraid_vault::time::zone::FireZone::named("UTC"));
    match zone {
        Ok(zone) => {
            let wall = zone.zoned_parts(now_ms);
            format!("{:04}-{:02}-{:02}", wall.year, wall.month, wall.day)
        }
        Err(_) => crate::example::utc_day(now_ms),
    }
}

/// WRITE EVERY STARTER ROW into a founded vault through the command plane, and
/// report what was refused. The caller warns on a refusal and carries on; see
/// the module header.
#[must_use]
pub fn write(vault: &Vault, registry: &Registry, principal: &Principal, today: &str) -> Report {
    let mut seeder = Seeder {
        vault,
        registry,
        principal,
        report: Report::default(),
    };
    for (title, body) in NOTES {
        seeder.run(
            "knowledge.create_note",
            json!({ "title": title, "body_text": body, "format": "plain" }),
        );
    }
    for title in TASKS {
        seeder.run(
            "schedule.add_task",
            json!({ "title": title, "due_at": today }),
        );
    }
    seeder.report
}
