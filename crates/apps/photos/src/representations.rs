//! Photos' owner-typed view of the kit's representation fold.
//!
//! **The fold moved.** It was written here by lane Photos with the lift filed
//! as an owner hand-off "for whichever lane ports the second caller", because
//! `crates/apps/kit` was another lane's file that slot (census §Cross-lane).
//! Docs is that second caller (#1020 wave 4 slot 4b), so the fold now lives in
//! [`centraid_apps_kit::representations`] — where v0 keeps its own copy
//! (`packages/blueprints/apps/_shared/representation-reads.ts`) — and this
//! module is what is left: the owner type Photos keys on, and a fold narrowed
//! to it.
//!
//! Nothing this module exported changed name or meaning. What the lift ADDED is
//! the content index the kit now carries: Photos never needed it, and Docs'
//! `history` query cannot be written without it, because a superseded version
//! has no representation of its own.
//!
//! The doctrine — owner-keyed and never content-keyed, bounded by the caller's
//! own ids and walked to the end of them, a denial that is an absent field and
//! not a failed screen — is stated once, in the kit.

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::representations::{
    RepresentationIndex, fold_representations, read_representations,
};
use centraid_apps_kit::row::Row;

pub use centraid_apps_kit::representations::representations_statement;

use crate::queries::ASSET_JOIN_BOUND;

/// The owner type every Photos asset's representation is keyed under.
pub const ASSET_OWNER_TYPE: &str = "media.asset";

/// THE FOLD, narrowed to `media.asset`: `asset_id` → media type.
///
/// A row owned by anything else is skipped — a `core.document` over the same
/// sha is a different reading of the same bytes, and it is not this library's
/// answer.
#[must_use]
pub fn fold_media_types(rows: &[Row]) -> BTreeMap<String, String> {
    narrow(&fold_representations(rows))
}

/// The asset-owned half of a kit index.
fn narrow(index: &RepresentationIndex) -> BTreeMap<String, String> {
    index
        .by_owner
        .iter()
        .filter(|((owner_type, _), _)| owner_type == ASSET_OWNER_TYPE)
        .map(|((_, owner_id), media_type)| (owner_id.clone(), media_type.clone()))
        .collect()
}

/// Read and fold the media types of a bounded content set.
///
/// An empty set reads nothing, and a door that refuses answers with an empty
/// index: the caller renders a tile with no type rather than no tile.
pub fn read_media_types(
    door: &dyn PageDoor,
    content_ids: &[String],
) -> KitResult<BTreeMap<String, String>> {
    Ok(narrow(&read_representations(
        door,
        content_ids,
        ASSET_JOIN_BOUND,
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::row::Cell;

    /// The narrowing is the whole of what is left here, so it is what is
    /// tested: a document's reading of the same bytes is not an asset's.
    #[test]
    fn only_asset_owned_readings_reach_the_library() {
        let mut asset = Row::new();
        for (column, value) in [
            ("representation_id", "r1"),
            ("content_id", "c1"),
            ("owner_type", ASSET_OWNER_TYPE),
            ("owner_id", "a1"),
            ("media_type", "image/png"),
        ] {
            asset.insert(column.to_owned(), Cell::Text(value.to_owned()));
        }
        let mut document = Row::new();
        for (column, value) in [
            ("representation_id", "r2"),
            ("content_id", "c1"),
            ("owner_type", "core.document"),
            ("owner_id", "d1"),
            ("media_type", "application/pdf"),
        ] {
            document.insert(column.to_owned(), Cell::Text(value.to_owned()));
        }
        let folded = fold_media_types(&[asset, document]);
        assert_eq!(folded.get("a1").map(String::as_str), Some("image/png"));
        assert!(folded.get("d1").is_none());
    }
}
