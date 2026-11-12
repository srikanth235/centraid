//! How an item **arrived**: the one mechanism for "this did not come from typing".
//!
//! A command that can bring an item in from outside (a photo from the camera roll or the
//! picker, a vCard, a Markdown file, a Locker CSV, a scan or an upload)
//! takes two optional inputs, `arrived_system` (`"vcard"`) and `arrived_label` (`"contacts.vcf"`). The
//! command calls [`record`] for each item it adds, and this module writes:
//!
//! - **one `origin`** per `(system, label)`: the second import of `contacts.vcf` reuses the
//!   first's row (its `ref` is the label), so the origin reads as "where from", once;
//! - **one `source`** per item, keyed by the item's own id, saying which origin it came from.
//!
//! An item with no `arrived_system` was typed by the member and has no `source` row: absence is the
//! signal, nothing says "typed". This is not following. These systems are one-shot arrivals
//! (nothing re-reads them, no phone's store is watched), so the source's `stated` is `{}`, the
//! engine in [`super::follow`] has no map for them, and its absence and merge passes never see
//! their rows (a followed system that later finds the same item takes the row over).
//!
//! **A label is a file name or a device name, never content.** It is cut to the file's own
//! name (no folders) and a length, so nothing a member typed into a field can ride in it.

use rusqlite::OptionalExtension;

use super::CommandCtx;
use crate::error::{Result, VaultError};
use crate::model::Kind;

/// Each arrival system and the kind of item it brings in. The `origin.system` and
/// `source.entity_kind` CHECKs in the baseline name exactly these.
pub const SYSTEMS: &[(&str, Kind)] = &[
    ("camera_roll", Kind::Photo),
    ("picker", Kind::Photo),
    ("vcard", Kind::Person),
    ("markdown", Kind::Note),
    ("csv", Kind::LockerItem),
    ("scan", Kind::Document),
    ("upload", Kind::Document),
];

/// The longest label kept, in characters.
const LABEL_MOST: usize = 200;

/// Whether a `source.system` is an arrival rather than a followed store.
#[must_use]
pub fn is_arrival(system: &str) -> bool {
    SYSTEMS.iter().any(|(name, _)| *name == system)
}

/// The schema of the two optional inputs that say how an item arrived (`arrived_system` and
/// `arrived_label`), spelled once for every command that takes them. They are two flat strings,
/// not an object, so the typed catalog the screens build requests from can name each one.
macro_rules! arrived_property {
    () => {
        r#""arrived_system": {
          "type": "string",
          "enum": ["camera_roll", "picker", "vcard", "markdown", "csv", "scan", "upload"],
          "description": "How the item came in when the member did not type it. Omit it for a typed item."
        },
        "arrived_label": {
          "type": "string",
          "maxLength": 200,
          "description": "The file or device it came from: a name, never content. Required with arrived_system."
        }"#
    };
}
pub(crate) use arrived_property;

/// A label as it is kept: the file's own name, trimmed, cut to length.
fn label_of(raw: &str) -> String {
    let name = raw
        .rsplit(['/', '\\'])
        .find(|part| !part.trim().is_empty())
        .unwrap_or(raw)
        .trim();
    name.chars().take(LABEL_MOST).collect()
}

/// Record that `id`, a `kind` the command has just added, arrived as the command's `arrived_system`
/// and `arrived_label` inputs say. Writes nothing when the input has none (a typed item), or when the item
/// already has a source (it arrived before).
///
/// # Errors
///
/// A system that does not bring in this kind of item, or a label with no name in it.
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
    let Some(system) = text("arrived_system") else {
        return if text("arrived_label").is_some() {
            Err(invalid(
                "arrived_label",
                "name how it came in (`arrived_system`) as well".to_owned(),
            ))
        } else {
            Ok(())
        };
    };
    if !SYSTEMS
        .iter()
        .any(|(name, brings)| *name == system && *brings == kind)
    {
        return Err(invalid(
            "arrived_system",
            format!("`{system}` does not bring in {}", kind.noun()),
        ));
    }
    let label = label_of(text("arrived_label").unwrap_or_default());
    if label.is_empty() {
        return Err(invalid(
            "arrived_label",
            "name the file or device it came from".to_owned(),
        ));
    }
    let connection = ctx.connection();
    let known: Option<String> = connection
        .query_row(
            "SELECT id FROM origin WHERE system = ?1 AND ref = ?2",
            [system, label.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    let origin = match known {
        Some(origin) => origin,
        None => {
            // The label is the ref: one origin per (system, label).
            let origin = ctx.next_id();
            connection.execute(
                "INSERT INTO origin (id, system, ref, label, created_at) VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![origin, system, label, ctx.now],
            )?;
            origin
        }
    };
    connection.execute(
        "INSERT INTO source (id, origin_id, system, external_id, entity_id, entity_kind, stated, seen_at)
         SELECT ?1, ?2, ?3, ?4, ?4, ?5, '{}', ?6
          WHERE NOT EXISTS (SELECT 1 FROM source WHERE entity_id = ?4)",
        rusqlite::params![ctx.next_id(), origin, system, id, kind.as_str(), ctx.now],
    )?;
    Ok(())
}

/// Where one entity came from: the system and label of its origin, whether a store the engine
/// follows or a one-shot arrival. `None` for an item typed by the member (it has no source).
///
/// # Errors
///
/// A read the file refuses.
pub fn origin_of(
    connection: &rusqlite::Connection,
    entity_id: &str,
) -> Result<Option<(String, String)>> {
    Ok(connection
        .query_row(
            "SELECT o.system, o.label FROM source s JOIN origin o ON o.id = s.origin_id
              WHERE s.entity_id = ?1 AND o.retired_at IS NULL",
            [entity_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}
