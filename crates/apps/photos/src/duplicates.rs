//! `duplicates` — **a read over a cluster id a sweep computed** (D-1020-P3).
//!
//! The similarity signal is the sweep's, never an exact-sha group plus a
//! "same dimensions, same byte size" fingerprint, which is coincidence-prone:
//!
//! - `media_asset_phash` is a registered logical entity an app with
//!   `{schema: "media", verbs: "read"}` reads directly;
//! - `cluster_id` is recomputed WHOLESALE every run as union-find over phash
//!   Hamming distance ≤ 6 with the group's lowest `asset_id` as its
//!   deterministic id. **That clustering lives in
//!   `centraid_media::duplicates`** — not here, and not in the query.
//!
//! So this module reads `WHERE cluster_id IS NOT NULL`, groups, joins, and
//! stops. Two rules the fold keeps:
//!
//! 1. **Only LIVE assets ride a cluster card.** A trashed member of an old
//!    cluster is not something to offer trashing again.
//! 2. **A cluster left with fewer than two live members is dropped entirely.**
//!    A "duplicate" with one member is a photograph.

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::{MAX_PAGE_ROWS, PageRequest};
use centraid_apps_kit::reads::{PageDoor, in_list, read_pages};
use centraid_apps_kit::row::text_of;
use centraid_apps_kit::statement::{PageOrder, PageQuery};

use crate::queries::{
    ASSET_JOIN_BOUND, AssetRow, ContentRow, SourceUris, content_statement, src_of,
};

/// How many clustered fingerprints the review surface considers
/// (`duplicates.ts:26`).
pub const CLUSTER_ROWS: usize = 4_000;

/// One asset on a cluster card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateAsset {
    pub asset_id: String,
    pub content_id: String,
    pub kind: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub byte_size: Option<i64>,
    pub media_type: Option<String>,
    pub title: Option<String>,
    pub taken_at: Option<String>,
    pub uris: SourceUris,
}

/// One near-duplicate cluster.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateCluster {
    /// The cluster id the sweep stamped — the group's lowest `asset_id`.
    pub key: String,
    /// `"phash"`. A second tier would be a second signal, and there is one.
    pub tier: &'static str,
    pub assets: Vec<DuplicateAsset>,
}

/// `photos.duplicates.phashes`.
#[must_use]
pub fn phash_statement() -> PageQuery {
    PageQuery::new(
        "photos.duplicates.phashes",
        "asset_id, phash, cluster_id, computed_at",
        "media_asset_phash",
        PageOrder::asc("cluster_id", "asset_id"),
    )
    .filter("cluster_id IS NOT NULL", Vec::new())
}

/// `photos.duplicates.assets` — only the clustered ids, and only the live ones.
pub fn assets_statement(asset_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("asset_id", asset_ids)?;
    Ok(PageQuery::new(
        "photos.duplicates.assets",
        "asset_id, content_id, kind, title, captured_at, width, height, deleted_at",
        "media_asset",
        PageOrder::asc("asset_id", "asset_id"),
    )
    .filter(
        &format!("{} AND deleted_at IS NULL", fragment.sql),
        fragment.bind,
    ))
}

/// THE FOLD. Pure over what the three statements returned.
#[must_use]
pub fn fold_clusters(
    cluster_of: &[(String, String)],
    assets: &BTreeMap<String, AssetRow>,
    contents: &BTreeMap<String, ContentRow>,
    media_types: &BTreeMap<String, String>,
) -> Vec<DuplicateCluster> {
    // Insertion order is the statement's order, which is cluster id then asset
    // id — so the members of a card are in a stable order without a second sort.
    let mut by_cluster: Vec<(String, Vec<String>)> = Vec::new();
    for (cluster_id, asset_id) in cluster_of {
        match by_cluster.last_mut() {
            Some((held, members)) if held == cluster_id => members.push(asset_id.clone()),
            _ => by_cluster.push((cluster_id.clone(), vec![asset_id.clone()])),
        }
    }

    let mut clusters: Vec<DuplicateCluster> = by_cluster
        .into_iter()
        .filter_map(|(key, member_ids)| {
            let members: Vec<DuplicateAsset> = member_ids
                .iter()
                .filter_map(|asset_id| {
                    let asset = assets.get(asset_id)?;
                    let content = contents.get(&asset.content_id)?;
                    // Released bytes are not a duplicate to review.
                    if content.deleted_at.is_some() {
                        return None;
                    }
                    Some(DuplicateAsset {
                        asset_id: asset.asset_id.clone(),
                        content_id: asset.content_id.clone(),
                        kind: asset.kind.clone(),
                        width: asset.width,
                        height: asset.height,
                        byte_size: content.byte_size,
                        media_type: media_types.get(asset_id).cloned(),
                        title: asset.title.clone(),
                        taken_at: asset
                            .captured_at
                            .clone()
                            .or_else(|| content.created_at.clone()),
                        uris: src_of(Some(content)),
                    })
                })
                .collect();
            // A cluster of one is a photograph.
            (members.len() >= 2).then_some(DuplicateCluster {
                key,
                tier: "phash",
                assets: members,
            })
        })
        .collect();
    // Biggest cluster first, ties broken by the cluster id so the order is
    // total — v0's `sort` by length alone is not stable across engines and the
    // card order is what a member's eye follows.
    clusters.sort_by(|left, right| {
        right
            .assets
            .len()
            .cmp(&left.assets.len())
            .then_with(|| left.key.cmp(&right.key))
    });
    clusters
}

/// Read and fold `duplicates`.
pub fn duplicate_clusters(door: &dyn PageDoor) -> KitResult<Vec<DuplicateCluster>> {
    // ONE PAGE: `cluster_id` is nullable, so a continued page over it is
    // refused by the kit's door (D-1020-P11, and see `queries::read_one_page`).
    // v0 asks for its 4,000 fingerprints as one page and the clamp gives it
    // 500; the port asks for the same page and does not pretend otherwise.
    let phashes = door.page(
        &phash_statement(),
        &PageRequest::first(CLUSTER_ROWS.min(MAX_PAGE_ROWS)),
    )?;
    let cluster_of: Vec<(String, String)> = phashes
        .rows
        .iter()
        .filter_map(|row| Some((text_of(row, "cluster_id")?, text_of(row, "asset_id")?)))
        .collect();
    if cluster_of.is_empty() {
        return Ok(Vec::new());
    }
    let mut asset_ids: Vec<String> = cluster_of.iter().map(|(_, id)| id.clone()).collect();
    asset_ids.sort();
    asset_ids.dedup();

    let assets: BTreeMap<String, AssetRow> =
        read_pages(door, &assets_statement(&asset_ids)?, ASSET_JOIN_BOUND)?
            .iter()
            .filter_map(|row| Some((text_of(row, "asset_id")?, AssetRow::of(row)?)))
            .collect();
    let mut content_ids: Vec<String> = assets
        .values()
        .map(|asset| asset.content_id.clone())
        .filter(|id| !id.is_empty())
        .collect();
    content_ids.sort();
    content_ids.dedup();
    let contents: BTreeMap<String, ContentRow> = if content_ids.is_empty() {
        BTreeMap::new()
    } else {
        read_pages(
            door,
            &content_statement("photos.duplicates.contents", &content_ids)?,
            ASSET_JOIN_BOUND,
        )?
        .iter()
        .filter_map(|row| Some((text_of(row, "content_id")?, ContentRow::of(row)?)))
        .collect()
    };
    // The media type is the OWNER's representation, not the bytes' (R20(b)):
    // a cluster card says "photo" or "video" per asset, and two assets sharing
    // one sha can read as two different things.
    let media_types = crate::representations::read_media_types(door, &content_ids)?;
    Ok(fold_clusters(&cluster_of, &assets, &contents, &media_types))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(id: &str) -> AssetRow {
        AssetRow {
            asset_id: id.to_owned(),
            content_id: format!("c-{id}"),
            kind: Some("photo".to_owned()),
            title: None,
            captured_at: Some("2026-01-01T00:00:00.000Z".to_owned()),
            tz_offset_min: None,
            capture_group_id: None,
            place_id: None,
            width: Some(360),
            height: Some(240),
            source_asset_id: None,
            archived_at: None,
            deleted_at: None,
            purge_at: None,
            created_at: None,
        }
    }

    fn content(id: &str) -> ContentRow {
        ContentRow {
            content_id: format!("c-{id}"),
            content_uri: Some("blob:sha".to_owned()),
            byte_size: Some(1_000),
            created_at: None,
            deleted_at: None,
            purge_at: None,
        }
    }

    fn world(ids: &[&str]) -> (BTreeMap<String, AssetRow>, BTreeMap<String, ContentRow>) {
        (
            ids.iter().map(|id| ((*id).to_owned(), asset(id))).collect(),
            ids.iter()
                .map(|id| (format!("c-{id}"), content(id)))
                .collect(),
        )
    }

    #[test]
    fn a_cluster_of_one_live_member_is_dropped() {
        let (assets, contents) = world(&["a-1"]);
        let cluster_of = vec![
            ("a-1".to_owned(), "a-1".to_owned()),
            // `a-2` is trashed and therefore absent from the live asset read.
            ("a-1".to_owned(), "a-2".to_owned()),
        ];
        assert!(fold_clusters(&cluster_of, &assets, &contents, &BTreeMap::new()).is_empty());
    }

    #[test]
    fn cards_arrive_biggest_first_with_a_total_order() {
        let (assets, contents) = world(&["a-1", "a-2", "a-3", "b-1", "b-2"]);
        let cluster_of = vec![
            ("a-1".to_owned(), "a-1".to_owned()),
            ("a-1".to_owned(), "a-2".to_owned()),
            ("a-1".to_owned(), "a-3".to_owned()),
            ("b-1".to_owned(), "b-1".to_owned()),
            ("b-1".to_owned(), "b-2".to_owned()),
        ];
        let clusters = fold_clusters(&cluster_of, &assets, &contents, &BTreeMap::new());
        assert_eq!(
            clusters.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(),
            ["a-1", "b-1"]
        );
        assert_eq!(clusters[0].assets.len(), 3);
        assert!(clusters.iter().all(|cluster| cluster.tier == "phash"));
    }

    #[test]
    fn a_member_whose_bytes_were_released_leaves_the_card() {
        let (assets, mut contents) = world(&["a-1", "a-2"]);
        contents.get_mut("c-a-2").expect("present").deleted_at =
            Some("2026-02-01T00:00:00.000Z".to_owned());
        let cluster_of = vec![
            ("a-1".to_owned(), "a-1".to_owned()),
            ("a-1".to_owned(), "a-2".to_owned()),
        ];
        assert!(fold_clusters(&cluster_of, &assets, &contents, &BTreeMap::new()).is_empty());
    }

    /// The query READS. A port that recomputed here would be a second
    /// clustering, and the two would drift silently at the Hamming threshold.
    #[test]
    fn the_statement_only_reads_the_cluster_column() {
        let query = phash_statement();
        assert_eq!(query.r#where.as_deref(), Some("cluster_id IS NOT NULL"));
        assert_eq!(query.order.sort_column, "cluster_id");
        assert_eq!(query.order.pk_column, "asset_id");
        assert!(query.select.contains("phash"));
        assert_eq!(CLUSTER_ROWS, 4_000);
    }
}
