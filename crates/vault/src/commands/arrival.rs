//! How an item **arrived**: the one mechanism for "this did not come from typing".
//!
//! A command that can bring an item in from outside (a photo from the picker, a vCard, a
//! Markdown file, a Locker CSV, a scan or an upload) takes two optional inputs, `arrived_via`
//! (`"vcard"`) and `arrived_label` (`"contacts.vcf"`). The command calls [`record`] for each item
//! it adds, and this module writes the two columns of the `entity` row, **both or neither**
//! (A10): `arrived_via` (a key of the `arrival_via` lookup) and `arrived_label`. Nothing else: no
//! `origin`, no `source`. An item with no `arrived_via` was typed by the member; absence is the
//! signal, nothing says "typed".
//!
//! This is not following. A one-time arrival is a fact about one row, and a followed store (the
//! camera roll, the phone's contacts and calendars) is an `origin` with `source` rows the engine
//! in [`super::follow`] reads. A row that arrived once and is later stated by a followed store
//! keeps its arrival: the two are different questions.
//!
//! **A label is a file name or a device name, never content.** It is cut to the file's own
//! name (no folders) and a length, so nothing a member typed into a field can ride in it.

use super::CommandCtx;
use crate::error::{Result, VaultError};
use crate::model::Kind;

/// Each one-time arrival and the kind of item it brings in. `tests/lookups.rs` holds the names
/// equal to the rows of `arrival_via`.
pub const SYSTEMS: &[(&str, Kind)] = &[
    ("picker", Kind::Photo),
    ("vcard", Kind::Person),
    ("markdown", Kind::Note),
    ("csv", Kind::LockerItem),
    ("scan", Kind::Document),
    ("upload", Kind::Document),
];

/// The longest label kept, in characters.
const LABEL_MOST: usize = 200;

/// The schema of the two optional inputs that say how an item arrived (`arrived_via` and
/// `arrived_label`), spelled once for every command that takes them. They are two flat strings,
/// not an object, so the typed catalog the screens build requests from can name each one.
macro_rules! arrived_property {
    () => {
        r#""arrived_via": {
          "type": "string",
          "enum": ["picker", "vcard", "markdown", "csv", "scan", "upload"],
          "description": "How the item came in when the member did not type it. Omit it for a typed item."
        },
        "arrived_label": {
          "type": "string",
          "maxLength": 200,
          "description": "The file or device it came from: a name, never content. Required with arrived_via."
        }"#
    };
}
pub(crate) use arrived_property;

/// A label as it is kept: the file's own name, trimmed, cut to length.
fn label_of(raw: &str) -> String {
    let name = raw
        .rsplit(['/', '\\'])
        .find(|part| !part.trim().is_empty())
        .unwrap_or_default()
        .trim();
    name.chars().take(LABEL_MOST).collect()
}

/// Record that `id`, a `kind` the command has just added, arrived as the command's `arrived_via`
/// and `arrived_label` inputs say. Writes nothing when the input has neither (a typed item).
///
/// # Errors
///
/// One of the two without the other, a way in that does not bring in this kind of item, or a
/// label with no name in it.
pub fn record(ctx: &CommandCtx<'_, '_>, id: &str, kind: Kind) -> Result<()> {
    let text = |key: &str| {
        ctx.optional_str(key)
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let invalid = |name: &str, detail: String| VaultError::InvalidInput {
        name: name.to_owned(),
        detail,
    };
    let Some(via) = text("arrived_via") else {
        return if text("arrived_label").is_some() {
            Err(invalid(
                "arrived_label",
                "name how it came in (`arrived_via`) as well".to_owned(),
            ))
        } else {
            Ok(())
        };
    };
    if !SYSTEMS
        .iter()
        .any(|(name, brings)| *name == via && *brings == kind)
    {
        return Err(invalid(
            "arrived_via",
            format!("`{via}` does not bring in {}", kind.noun()),
        ));
    }
    let label = label_of(text("arrived_label").unwrap_or_default());
    if label.is_empty() {
        return Err(invalid(
            "arrived_label",
            "name the file or device it came from".to_owned(),
        ));
    }
    ctx.connection().execute(
        "UPDATE entity SET arrived_via = ?2, arrived_label = ?3 WHERE id = ?1",
        rusqlite::params![id, via, label],
    )?;
    Ok(())
}
