//! WHERE A READ OF THE PHONE'S STORE GOT TO (#1183): a cursor lives in the vault, on the store's
//! `origin` row, and moves in the same transaction as the records it covers.
//!
//! A phone's store (the camera roll, the health store) is read from a position the platform
//! mints: a Photos change token, a HealthKit anchor, a Health Connect changes token. The vault
//! keeps it in `origin.cursor` beside `origin.device_id`, the install that
//! wrote it. **A cursor is the word of one phone**: a platform's token means something on the
//! device that minted it only, so a read from another device is told nothing ([`read`] answers
//! none) and does a complete read; the first batch it commits takes the origin over.
//!
//! Every command that brings in records for such a store takes its cursor with them
//! (`photo.add`'s `roll_cursor` and `roll_device`; a follow's `origin.cursor`) and calls
//! [`advance`] before it does anything else, so the records and the cursor are one commit: a batch
//! the vault refuses leaves the cursor where it was. `follow.advance_cursor` moves a cursor that
//! no record rides with (an asset with nothing to bring in, the end of a page).
//!
//! **What the file holds about a cursor, the database refuses too** (`origin`'s checks and key): only
//! an origin that names a device holds one, a retired origin holds none, and only a system that
//! names a device may (the key from `origin.bound` to `origin_system.on_device`). The commands
//! say the same in a sentence.

use rusqlite::{Connection, OptionalExtension};

use super::CommandCtx;
use super::follow::system_row;
use crate::error::{Result, VaultError};

/// The camera roll's one origin: its `ref` and its label.
pub const CAMERA_ROLL_REF: &str = "Camera roll";

/// The cursor `origin` (`system`, `reference`) holds for `device`, or `None`: no cursor, no such
/// origin, or a cursor another device wrote (a complete read then).
///
/// # Errors
///
/// A read the file refuses.
pub fn read(
    connection: &Connection,
    system: &str,
    reference: &str,
    device: &str,
) -> Result<Option<String>> {
    let row: Option<(Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT device_id, cursor FROM origin
              WHERE system = ?1 AND ref = ?2 AND retired_at IS NULL",
            [system, reference],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row
        .and_then(|(held, cursor)| {
            (!device.is_empty() && held.as_deref() == Some(device)).then_some(cursor)
        })
        .flatten()
        .filter(|cursor| !cursor.is_empty()))
}

/// Move the cursor of origin (`system`, `reference`) to `cursor`, as read by `device`: the origin
/// is founded when none is yet (its label is its `ref`), and names `device` as the one whose word
/// the cursor is.
///
/// # Errors
///
/// A write the file refuses.
pub fn advance(
    ctx: &CommandCtx<'_, '_>,
    system: &str,
    reference: &str,
    device: &str,
    cursor: &str,
) -> Result<()> {
    let connection = ctx.connection();
    let invalid = |name: &str, detail: &str| VaultError::InvalidInput {
        name: name.to_owned(),
        detail: detail.to_owned(),
    };
    if device.trim().is_empty() {
        return Err(invalid(
            "device_id",
            "a cursor is the word of the install that read it",
        ));
    }
    match system_row(connection, system)? {
        None => return Err(invalid("system", "that is not a store this vault follows")),
        Some(row) if !row.on_device => {
            return Err(invalid(
                "system",
                "a cursor is a phone store's, with the install that read it",
            ));
        }
        Some(_) => {}
    }
    // A RETIRED ORIGIN HOLDS NO CURSOR: Stop cleared it, and a stray batch still in flight must not
    // write one back, or the store followed again would resume from a position nobody read to.
    let retired: bool = connection
        .query_row(
            "SELECT 1 FROM origin WHERE system = ?1 AND ref = ?2 AND retired_at IS NOT NULL",
            [system, reference],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if retired {
        return Ok(());
    }
    let changed = connection.execute(
        "UPDATE origin SET device_id = ?3, cursor = ?4
          WHERE system = ?1 AND ref = ?2",
        rusqlite::params![system, reference, device, cursor],
    )?;
    if changed == 0 {
        connection.execute(
            "INSERT INTO origin (id, system, ref, label, device_id, cursor, created_at)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)",
            rusqlite::params![ctx.next_id(), system, reference, device, cursor, ctx.now],
        )?;
    }
    Ok(())
}

/// Move the cursor of the origin `origin` to `cursor`, in the commit that brings in the records it
/// covers. The origin's device is already the install that read (a pass names it when it finds or
/// makes the origin).
///
/// # Errors
///
/// A write the file refuses (an origin with no device holds no cursor).
pub(crate) fn move_to(connection: &rusqlite::Connection, origin: &str, cursor: &str) -> Result<()> {
    connection.execute(
        "UPDATE origin SET cursor = ?2 WHERE id = ?1",
        [origin, cursor],
    )?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct AdvanceCursorInput {
    system: String,
    #[serde(rename = "ref")]
    reference: String,
    device_id: String,
    cursor: String,
}

/// `follow.advance_cursor`: [`advance`] as a command, for a position no record rides with.
pub(crate) fn advance_cursor(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: AdvanceCursorInput = ctx.parse_input()?;
    advance(
        ctx,
        &input.system,
        &input.reference,
        &input.device_id,
        &input.cursor,
    )?;
    Ok(serde_json::json!({}))
}

pub(crate) const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["system", "ref", "device_id", "cursor"],
  "additionalProperties": false,
  "properties": {
    "system": { "type": "string", "minLength": 1 },
    "ref": { "type": "string", "minLength": 1 },
    "device_id": { "type": "string", "minLength": 1 },
    "cursor": { "type": "string", "minLength": 1, "maxLength": 4096 }
  }
}"#;
