//! **WHAT THE BYTES ARE**, which is not a property of the bytes (#996, ruling
//! R20(b), drift ONT-28).
//!
//! `core_content_item` carries no `media_type`: the same sha is `text/html`
//! under one document and `text/plain` under another, so what it IS lives in
//! `core_content_representation`, one row per `(owner_type, owner_id)`. Every
//! grid row still ships a `media_type` FIELD — a tile on a phone has to say
//! whether it is a photograph or a video before it can decide what to paint —
//! and this module is the only place that field is filled in, exactly as v0's
//! `packages/blueprints/apps/_shared/representation-reads.ts` is the only place
//! on its side.
//!
//! Three things the port keeps, because each one is a bug it would otherwise
//! reintroduce:
//!
//! 1. **The index is keyed on the OWNER, never on the content.** `media.asset`
//!    plus the asset id. A content-keyed lookup answers "whatever the oldest
//!    owner thought", which for two assets sharing one sha is the wrong one.
//! 2. **The set is bounded by the caller's own content ids and then walked to
//!    the END of that set** — not windowed again. v0 originally windowed it and
//!    a vault with enough representations silently answered short, so rows came
//!    back with no type rather than the wrong one; the read is bounded by
//!    construction here through [`ASSET_JOIN_BOUND`].
//! 3. **A denial is not an error.** The caller renders without a type. This
//!    module returns an empty index for a door that refuses, and the field is
//!    then `None` — which is what "we may not read that" looks like on a tile.
//!
//! WHY THIS LIVES IN PHOTOS AND NOT IN THE KIT. v0's copy is in `_shared/`
//! because six apps call it. On the Rust side Photos is the first app to need
//! it; a shared home is `crates/apps/kit`, which is another lane's file this
//! slot (census §Cross-lane). The receipt files the lift as an owner hand-off
//! for whichever lane ports the second caller — the fold and its statement are
//! written here to be moved, not to be copied.

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, in_list, read_pages};
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::statement::{PageOrder, PageQuery};

use crate::queries::ASSET_JOIN_BOUND;

/// The owner type every Photos asset's representation is keyed under.
pub const ASSET_OWNER_TYPE: &str = "media.asset";

/// `photos.shared.representations` — the media types of a bounded content set.
///
/// The keyset's second axis is `representation_id` and NOT `content_id`: one
/// sha read as two things by two owners is the row this table exists for, and a
/// cursor keyed on `content_id` would stall on it.
pub fn representations_statement(content_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("content_id", content_ids)?;
    Ok(PageQuery::new(
        "photos.shared.representations",
        "representation_id, content_id, owner_type, owner_id, media_type, created_at",
        "core_content_representation",
        PageOrder::asc("created_at", "representation_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// THE FOLD: `asset_id` → media type, for the rows owned by `media.asset`.
///
/// A row whose media type is empty is skipped rather than stored as `""`: the
/// column is `NOT NULL`, so an empty string is a writer's bug and "no type" is
/// the honest reading of it.
#[must_use]
pub fn fold_media_types(rows: &[Row]) -> BTreeMap<String, String> {
    let mut by_owner = BTreeMap::new();
    for row in rows {
        let Some(media_type) = text_of(row, "media_type").filter(|text| !text.is_empty()) else {
            continue;
        };
        if text_of(row, "owner_type").as_deref() != Some(ASSET_OWNER_TYPE) {
            continue;
        }
        let Some(owner_id) = text_of(row, "owner_id") else {
            continue;
        };
        // FIRST WINS, and the read is oldest-first: the same deterministic
        // answer the vault's own resolver gives.
        by_owner.entry(owner_id).or_insert(media_type);
    }
    by_owner
}

/// Read and fold the media types of a bounded content set.
///
/// An empty set reads nothing — a statement with an empty `IN ()` is a refusal
/// in the kit's grammar, and asking for the types of no bytes is not an error.
pub fn read_media_types(
    door: &dyn PageDoor,
    content_ids: &[String],
) -> KitResult<BTreeMap<String, String>> {
    if content_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut ids: Vec<String> = content_ids.to_vec();
    ids.sort();
    ids.dedup();
    let rows = read_pages(door, &representations_statement(&ids)?, ASSET_JOIN_BOUND)?;
    Ok(fold_media_types(&rows))
}
