//! **WHAT THE BYTES ARE**, which is not a property of the bytes (#996, ruling
//! R20(b), drift ONT-28).
//!
//! `core_content_item` carries no `media_type`: the same sha is `text/html`
//! under one document and `text/plain` under another, so what it IS lives in
//! `core_content_representation`, one row per `(owner_type, owner_id)`. Every
//! grid row and every drive row still ships a `media_type` FIELD — a tile on a
//! phone has to say whether it is a photograph, a video or a PDF before it can
//! decide what to paint — and this module is the only place that field is
//! filled in, exactly as v0's
//! `packages/blueprints/apps/_shared/representation-reads.ts` is the only place
//! on its side.
//!
//! Three things the port keeps, because each one is a bug it would otherwise
//! reintroduce:
//!
//! 1. **The index is keyed on the OWNER, never on the content.** A
//!    content-keyed lookup answers "whatever the oldest owner thought", which
//!    for two documents sharing one sha is the wrong one — and two documents
//!    sharing one sha is the case `core.document` exists to allow (#352).
//!    [`RepresentationIndex::by_content`] is the deliberate fallback for a
//!    surface addressing bytes with no owner in hand, and it takes the OLDEST
//!    reading of them, which is the same deterministic answer the vault's own
//!    resolver gives.
//! 2. **The set is bounded by the caller's own content ids and then walked to
//!    the END of that set** — not windowed again. v0 originally windowed it and
//!    a vault with enough representations silently answered short, so rows came
//!    back with no type rather than the wrong one.
//! 3. **A denial is not an error.** The caller renders without a type. A door
//!    that refuses yields [`RepresentationIndex::default`], and the field is
//!    then `None` — which is what "we may not read that" looks like on a tile.
//!
//! ## Why it is here and not in an app crate
//!
//! Lane Photos wrote this fold in `crates/apps/photos/src/representations.rs`
//! and filed the lift as an owner hand-off "for whichever lane ports the second
//! caller". **Docs is that second caller** (#1020 wave 4 slot 4b), and a
//! second copy is how the two answers drift — so the fold moved here, where v0
//! keeps its own copy, under `contracts/handoff/docs/kit.patch`. Photos'
//! module survives as a thin, owner-typed re-export so nothing it exports
//! changed name.
//!
//! The narrowing the lift undid, and why it mattered: Photos' copy folded to
//! `owner_id -> media_type` for the one owner type `media.asset` and dropped
//! the content index entirely. Docs' `history` query reads
//! `representations.byContent` for a SUPERSEDED version — a version whose
//! bytes the document no longer reads — and a fold with no content index
//! cannot answer it at all.

use std::collections::BTreeMap;

use crate::error::KitResult;
use crate::reads::{FanOutBound, PageDoor, in_list, read_pages};
use crate::row::{Row, text_of};
use crate::statement::{PageOrder, PageQuery};

/// The PHYSICAL table, because a page is plain SQL over the seat's own copy of
/// `vault.db` and over the gateway's file (W4-D2) — the same statement on both.
pub const REPRESENTATION_TABLE: &str = "core_content_representation";

/// `_shared/representations` — v0's own statement name, kept so a plan
/// snapshot taken on either side names the same read.
pub const REPRESENTATION_STATEMENT: &str = "_shared/representations";

/// One read, two indexes.
///
/// `Default` is the EMPTY index, which is what a denied door yields: the caller
/// renders without a type rather than failing the screen.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RepresentationIndex {
    /// `(owner_type, owner_id)` → media type. The right answer wherever the
    /// caller knows the owner — a document, a note, an asset, an attachment.
    pub by_owner: BTreeMap<(String, String), String>,
    /// content id → the OLDEST owner's media type. The fallback for a surface
    /// addressing bytes with no owner in hand.
    pub by_content: BTreeMap<String, String>,
}

impl RepresentationIndex {
    /// The media type this owner reads its bytes as.
    #[must_use]
    pub fn owner(&self, owner_type: &str, owner_id: &str) -> Option<&str> {
        self.by_owner
            .get(&(owner_type.to_owned(), owner_id.to_owned()))
            .map(String::as_str)
    }

    /// The oldest reading of these bytes, for a caller with no owner in hand.
    #[must_use]
    pub fn content(&self, content_id: &str) -> Option<&str> {
        self.by_content.get(content_id).map(String::as_str)
    }
}

/// The statement: the media types of a bounded content set.
///
/// The keyset's second axis is `representation_id` and NOT `content_id`: one
/// sha read as two things by two owners is the row this table exists for, and a
/// cursor keyed on `content_id` would stall on it. `created_at` is `NOT NULL`
/// on this table, so the walk is continuable (the kit's door refuses a
/// continued page over a nullable sort key).
pub fn representations_statement(content_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("content_id", content_ids)?;
    Ok(PageQuery::new(
        REPRESENTATION_STATEMENT,
        "representation_id, content_id, owner_type, owner_id, media_type, created_at",
        REPRESENTATION_TABLE,
        PageOrder::asc("created_at", "representation_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// THE FOLD, over rows the read above returned in oldest-first order.
///
/// A row whose media type is empty is skipped rather than stored as `""`: the
/// column is `NOT NULL`, so an empty string is a writer's bug and "no type" is
/// the honest reading of it.
#[must_use]
pub fn fold_representations(rows: &[Row]) -> RepresentationIndex {
    let mut index = RepresentationIndex::default();
    for row in rows {
        let Some(media_type) = text_of(row, "media_type").filter(|text| !text.is_empty()) else {
            continue;
        };
        if let (Some(owner_type), Some(owner_id)) =
            (text_of(row, "owner_type"), text_of(row, "owner_id"))
        {
            index
                .by_owner
                .insert((owner_type, owner_id), media_type.clone());
        }
        if let Some(content_id) = text_of(row, "content_id") {
            // FIRST WINS, and the read is oldest-first: the same deterministic
            // answer the vault's own resolver gives.
            index.by_content.entry(content_id).or_insert(media_type);
        }
    }
    index
}

/// Read and fold the representations of a bounded content set.
///
/// An empty set reads nothing — a statement with an empty `IN ()` is a refusal
/// in the kit's grammar, and asking for the types of no bytes is not an error.
/// A door that refuses answers with the empty index, because a denial here is
/// a missing FIELD and not a failed screen.
pub fn read_representations(
    door: &dyn PageDoor,
    content_ids: &[String],
    bound: FanOutBound,
) -> KitResult<RepresentationIndex> {
    if content_ids.is_empty() {
        return Ok(RepresentationIndex::default());
    }
    let mut ids: Vec<String> = content_ids.to_vec();
    ids.sort();
    ids.dedup();
    let rows = read_pages(door, &representations_statement(&ids)?, bound)?;
    Ok(fold_representations(&rows))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::Cell;

    fn row(pairs: &[(&str, &str)]) -> Row {
        let mut row = Row::default();
        for (column, value) in pairs {
            row.insert((*column).to_owned(), Cell::Text((*value).to_owned()));
        }
        row
    }

    /// THE BUG THE OWNER KEY EXISTS TO PREVENT (#996 R20(b), #352). Two
    /// documents over one sha, read as two different things. A content-keyed
    /// fold answers `text/plain` for both.
    #[test]
    fn two_owners_over_one_sha_keep_their_own_readings() {
        let index = fold_representations(&[
            row(&[
                ("representation_id", "r1"),
                ("content_id", "c1"),
                ("owner_type", "core.document"),
                ("owner_id", "d1"),
                ("media_type", "text/plain"),
            ]),
            row(&[
                ("representation_id", "r2"),
                ("content_id", "c1"),
                ("owner_type", "core.document"),
                ("owner_id", "d2"),
                ("media_type", "text/html"),
            ]),
        ]);
        assert_eq!(index.owner("core.document", "d1"), Some("text/plain"));
        assert_eq!(index.owner("core.document", "d2"), Some("text/html"));
        // And the content fallback takes the OLDEST, deterministically.
        assert_eq!(index.content("c1"), Some("text/plain"));
    }

    #[test]
    fn an_empty_media_type_is_absence_and_not_an_empty_string() {
        let index = fold_representations(&[row(&[
            ("representation_id", "r1"),
            ("content_id", "c1"),
            ("owner_type", "media.asset"),
            ("owner_id", "a1"),
            ("media_type", ""),
        ])]);
        assert!(index.by_owner.is_empty());
        assert!(index.by_content.is_empty());
    }

    #[test]
    fn no_content_ids_is_not_a_read() {
        assert!(matches!(
            representations_statement(&[]),
            Err(crate::error::KitError::EmptyInList { .. })
        ));
    }
}
