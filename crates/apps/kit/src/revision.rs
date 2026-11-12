//! A RECORD'S REVISION, AS AN EDITOR READS IT (#1185): the number a save names (`expected_rev`) to
//! say which state of the record it was made from.
//!
//! It is the newest version the vault's history holds for the record (0 when no edit has ever
//! changed it), the same number a guarded edit answers as `rev` once it commits. An editor reads
//! it BEFORE the record, so a change that lands between the two reads makes the save refuse as
//! stale (the safe side) and never accept over a change the member did not see.

use crate::error::KitResult;
use crate::page::PageRequest;
use crate::reads::PageDoor;
use crate::row::integer_or_zero;
use crate::statement::{PageBindValue, PageOrder, PageQuery};

/// The statement behind [`head`]: the record's newest version, through the history's key.
#[must_use]
pub fn head_statement(entity_id: &str) -> PageQuery {
    PageQuery::new(
        "kit.revision.head",
        "entity_id, seq",
        "revision",
        PageOrder::desc("seq", "entity_id"),
    )
    .filter(
        "entity_id = ?",
        vec![PageBindValue::Text(entity_id.to_owned())],
    )
}

/// The record's revision: its newest version's number, 0 when it has none.
///
/// # Errors
///
/// The door's refusal, or the kit's own.
pub fn head(door: &dyn PageDoor, entity_id: &str) -> KitResult<i64> {
    let page = door.page(&head_statement(entity_id), &PageRequest::first(1))?;
    Ok(page
        .rows
        .first()
        .map_or(0, |row| integer_or_zero(row, "seq")))
}
