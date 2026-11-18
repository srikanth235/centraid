//! THE STARTER ROWS: what a member's first vault holds the moment it is
//! founded with `FOUND_CONTENT_STARTERS`.
//!
//! Onboarding's goal is time to the member's OWN data, so
//! these are ORDINARY ROWS OF THE MEMBER'S, with no mark and nothing to clean
//! up: a vault they just made is not a blank wall, and every row here is one
//! they edit, complete or delete like any other. There is no sample data: the
//! Tahoe scenario ([`crate::example`]) seeds dev fixtures and tests only, and no
//! found writes it.
//!
//! **STARTER ROWS EXIST ONLY IN NOTES** (owner, 2026-11-17): the one app with no
//! import. Calendar, Reminders, People, Photos, Money and Health offer to import
//! what the phone already holds, and Docs offers its add, so none of them is
//! seeded: a starter reminder would be a row of the member's that the phone's own
//! import then sits beside. Each note teaches one real gesture (trash it from the
//! list, link with `[[`), and the pair are not the member's: Home stays on day
//! zero until the member adds or imports something of their own.
//!
//! **THE ROWS ARE DATA**, declared once in [`NOTES`], so a test reads the same
//! consts [`write`] writes and changing the content never has to change the test.
//!
//! **BEST-EFFORT BY DESIGN.** A refused starter is a warning, never a failure:
//! an empty vault is still a vault, and refusing the found over a teaching row
//! would cost the member the vault they asked for.

use centraid_vault::commands::Registry;
use centraid_vault::{Principal, Vault};
use serde_json::json;

use crate::example::{Report, Seeder};

/// The starter notes, in the order they are written: `(title, body)`, each a
/// plain-text `note.create`.
pub const NOTES: &[(&str, &str)] = &[
    ("This note is yours", "Change it, or move it to trash."),
    ("Link with [[", "Type [[ in a note to link to another one."),
];

/// WRITE EVERY STARTER ROW into a founded vault through the command plane, and
/// report what was refused. The caller warns on a refusal and carries on; see
/// the module header.
#[must_use]
pub fn write(vault: &Vault, registry: &Registry, principal: &Principal) -> Report {
    let mut seeder = Seeder {
        vault,
        registry,
        principal,
        report: Report::default(),
    };
    for (title, body) in NOTES {
        seeder.run(
            "note.create",
            json!({ "title": title, "body": body, "format": "plain" }),
        );
    }
    seeder.report
}
