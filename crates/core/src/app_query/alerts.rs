//! THE ALERT INDEX'S READ (#1188, A5): which items the notification service loads.
//!
//! The service wants the next few firings of the whole vault. It used to read every task with a
//! lead time and every event of a window, and refused (and kept a stale set) when the vault was
//! larger than a ceiling. The writer now keeps an `alert` row per lead time
//! ([`centraid_vault::alerts`]); this reads the first rows of it and names the items they belong
//! to, and the two loaders read only those. The count of rows read is bounded by construction,
//! whatever the vault holds.

use centraid_vault::Vault;
use centraid_vault::alerts as index;
use centraid_vault::time::FireZone;

use crate::error::Result;

/// More rows than firings asked for: a floating row can be an hour behind the member's now (a
/// phone in another zone than the vault's), and the service's own filter drops those.
const SPARE: usize = 64;

/// The ids of the items that fire next, soonest first, each once, at most `count + SPARE` rows
/// deep. Moves a repeating item's row on first when its firing has passed.
pub(crate) fn names(vault: &Vault, zone: &FireZone, now: &str, count: u32) -> Result<Vec<String>> {
    let now_ms = index::now_ms(now);
    vault.advance_alerts()?;
    let fixed = index::Timing::Fixed.key_of(now_ms);
    let floating = index::Timing::Floating.key_of(
        centraid_vault::time::zone::wall_epoch(zone.zoned_parts(now_ms)) - index::FLOATING_SLACK_MS,
    );
    let mut rows = vault
        .read(|connection| index::next(connection, &fixed, &floating, count as usize + SPARE))?;
    // What fired and is still the item's (a task until it is resolved; an event until it ends; the newest 64): it may
    // be on the screen. The index drops the rest.
    let recent = vault.read(|connection| {
        index::recent(
            connection,
            ("0000", &fixed),
            (
                "0000",
                &index::Timing::Floating.key_of(centraid_vault::time::zone::wall_epoch(
                    zone.zoned_parts(now_ms),
                )),
            ),
            SPARE,
        )
    })?;
    rows.extend(recent);
    let mut seen = std::collections::BTreeSet::new();
    Ok(rows
        .into_iter()
        .filter(|row| seen.insert(row.entity_id.clone()))
        .map(|row| row.entity_id)
        .collect())
}
