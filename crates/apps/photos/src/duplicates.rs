//! `duplicates` — **a read over the perceptual hashes the phone derived, clustered
//! at read** (D-1020-P3, #1135).
//!
//! The similarity signal is the hash's, never an exact-bytes group plus a "same
//! dimensions, same size" fingerprint, which is coincidence-prone. A photograph's
//! perceptual hash is a `phash` `derivative` of its blob; the clustering (union-find
//! over Hamming distance, the group's lowest photograph id as its id) lives in
//! `centraid_media::duplicates`, **not here and not in the query**, so there is
//! exactly one clustering: the caller hands this module the function and gets the
//! cards. Nothing is stored: a cluster is a projection of the hashes, recomputed
//! whenever it is asked for, so a trashed photograph or a new hash is in the next
//! answer without a sweep to run.
//!
//! Two rules the fold keeps:
//!
//! 1. **Only LIVE photographs ride a cluster card.** A trashed member of a cluster
//!    is not something to offer trashing again.
//! 2. **A cluster left with fewer than two live members is dropped entirely.** A
//!    "duplicate" with one member is a photograph.

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, Read, read_window};
use centraid_apps_kit::row::{Row, integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::queries::PHOTO_PAIR_BOUND;

/// How many fingerprints the review surface considers.
pub const CLUSTER_ROWS: usize = 4_000;

/// One photograph's perceptual hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    pub photo_id: String,
    pub phash: String,
}

/// One photograph on a cluster card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicatePhoto {
    pub photo_id: String,
    pub content_id: String,
    pub form: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub byte_size: Option<i64>,
    pub media_type: Option<String>,
    pub title: Option<String>,
    pub taken_at: Option<String>,
}

/// One near-duplicate cluster.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateCluster {
    /// The group's lowest photograph id.
    pub key: String,
    /// `"phash"`. A second tier would be a second signal, and there is one.
    pub tier: &'static str,
    pub photos: Vec<DuplicatePhoto>,
}

/// `photos.duplicates.phashes` — the perceptual hashes, by the blob they hash.
#[must_use]
pub fn phash_statement() -> PageQuery {
    PageQuery::new(
        "photos.duplicates.phashes",
        "blob, text",
        "derivative",
        PageOrder::asc("blob", "blob"),
    )
    .filter("variant = ?", vec![PageBindValue::Text("phash".to_owned())])
}

fn read_of(
    door: &dyn PageDoor,
    name: &'static str,
    table: &'static str,
    select: &'static str,
    column: &'static str,
    ids: &[String],
    extra: Option<(&str, Vec<PageBindValue>)>,
) -> KitResult<Vec<Row>> {
    Read {
        name,
        table,
        select,
        order: (column, column),
        column,
    }
    .within(PHOTO_PAIR_BOUND, door, ids, extra)
}

/// THE FOLD. Pure over the cluster each photograph is in and what is known of each.
#[must_use]
pub fn fold_clusters(
    cluster_of: &BTreeMap<String, String>,
    known: &BTreeMap<String, DuplicatePhoto>,
) -> Vec<DuplicateCluster> {
    let mut by_cluster: BTreeMap<&str, Vec<&DuplicatePhoto>> = BTreeMap::new();
    for (photo_id, cluster) in cluster_of {
        if let Some(photo) = known.get(photo_id) {
            by_cluster.entry(cluster.as_str()).or_default().push(photo);
        }
    }
    let mut clusters: Vec<DuplicateCluster> = by_cluster
        .into_iter()
        // A cluster of one is a photograph.
        .filter(|(_, members)| members.len() >= 2)
        .map(|(key, members)| DuplicateCluster {
            key: key.to_owned(),
            tier: "phash",
            photos: members.into_iter().cloned().collect(),
        })
        .collect();
    // Biggest cluster first, ties broken by the cluster id so the order is total.
    clusters.sort_by(|left, right| {
        right
            .photos
            .len()
            .cmp(&left.photos.len())
            .then_with(|| left.key.cmp(&right.key))
    });
    clusters
}

/// The hashes of the live photographs, in blob order, at most [`CLUSTER_ROWS`].
pub fn fingerprints(door: &dyn PageDoor) -> KitResult<Vec<Fingerprint>> {
    let hashes = read_window(door, &phash_statement(), CLUSTER_ROWS)?.rows;
    let by_blob: BTreeMap<String, String> = hashes
        .iter()
        .filter_map(|row| Some((text_of(row, "blob")?, text_of(row, "text")?)))
        .collect();
    let blobs: Vec<String> = by_blob.keys().cloned().collect();
    let photos = read_of(
        door,
        "photos.duplicates.photos",
        "photo",
        "id, blob",
        "blob",
        &blobs,
        None,
    )?;
    let ids: Vec<String> = photos.iter().filter_map(|row| text_of(row, "id")).collect();
    let live: Vec<String> = read_of(
        door,
        "photos.duplicates.live",
        "entity",
        "id",
        "id",
        &ids,
        Some(("deleted_at IS NULL", Vec::new())),
    )?
    .iter()
    .filter_map(|row| text_of(row, "id"))
    .collect();
    Ok(photos
        .iter()
        .filter_map(|row| {
            let id = text_of(row, "id")?;
            let phash = by_blob.get(&text_of(row, "blob")?)?.clone();
            live.contains(&id).then_some(Fingerprint {
                photo_id: id,
                phash,
            })
        })
        .collect())
}

/// Read and fold `duplicates`: `cluster` maps each fingerprinted photograph that is
/// in a group of two or more to its cluster id (`centraid_media::duplicates::cluster`).
pub fn duplicate_clusters(
    door: &dyn PageDoor,
    cluster: impl Fn(&[Fingerprint]) -> BTreeMap<String, String>,
) -> KitResult<Vec<DuplicateCluster>> {
    let prints = fingerprints(door)?;
    let cluster_of = cluster(&prints);
    if cluster_of.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = cluster_of.keys().cloned().collect();
    let photos = read_of(
        door,
        "photos.duplicates.rows",
        "photo",
        "id, blob, media_type, form, taken_at, width, height",
        "id",
        &ids,
        None,
    )?;
    let entities = read_of(
        door,
        "photos.duplicates.entities",
        "entity",
        "id, title, created_at",
        "id",
        &ids,
        None,
    )?;
    let hashes: Vec<String> = photos
        .iter()
        .filter_map(|row| text_of(row, "blob"))
        .collect();
    let sizes: BTreeMap<String, i64> = read_of(
        door,
        "photos.duplicates.blobs",
        "blob",
        "hash, size",
        "hash",
        &hashes,
        None,
    )?
    .iter()
    .filter_map(|row| Some((text_of(row, "hash")?, integer_or_zero(row, "size"))))
    .collect();
    let known: BTreeMap<String, DuplicatePhoto> = photos
        .iter()
        .filter_map(|row| {
            let id = text_of(row, "id")?;
            let entity = entities
                .iter()
                .find(|e| text_of(e, "id").as_deref() == Some(id.as_str()))?;
            let blob = text_of(row, "blob")?;
            Some((
                id.clone(),
                DuplicatePhoto {
                    photo_id: id,
                    byte_size: sizes.get(&blob).copied(),
                    content_id: blob,
                    form: text_of(row, "form"),
                    width: row.get("width").and_then(centraid_apps_kit::Cell::integer),
                    height: row.get("height").and_then(centraid_apps_kit::Cell::integer),
                    media_type: text_of(row, "media_type"),
                    title: text_of(entity, "title").filter(|title| !title.is_empty()),
                    taken_at: text_of(row, "taken_at").or_else(|| text_of(entity, "created_at")),
                },
            ))
        })
        .collect();
    Ok(fold_clusters(&cluster_of, &known))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn photo(id: &str) -> DuplicatePhoto {
        DuplicatePhoto {
            photo_id: id.to_owned(),
            content_id: format!("c-{id}"),
            form: Some("photo".to_owned()),
            width: Some(360),
            height: Some(240),
            byte_size: Some(1_000),
            media_type: Some("image/jpeg".to_owned()),
            title: None,
            taken_at: Some("2026-01-01T00:00:00.000Z".to_owned()),
        }
    }

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(photo, cluster)| ((*photo).to_owned(), (*cluster).to_owned()))
            .collect()
    }

    #[test]
    fn a_cluster_is_two_or_more_live_photographs_biggest_first() {
        let known: BTreeMap<String, DuplicatePhoto> = ["a", "b", "c", "d", "e"]
            .iter()
            .map(|id| ((*id).to_owned(), photo(id)))
            .collect();
        let clusters = fold_clusters(
            &map(&[("a", "a"), ("b", "a"), ("c", "c"), ("d", "c"), ("e", "c")]),
            &known,
        );
        assert_eq!(
            clusters
                .iter()
                .map(|c| (c.key.as_str(), c.photos.len()))
                .collect::<Vec<_>>(),
            [("c", 3), ("a", 2)]
        );
        // A member that is not live (not known) leaves a pair a single.
        let mut without = known.clone();
        without.remove("b");
        let clusters = fold_clusters(
            &map(&[("a", "a"), ("b", "a"), ("c", "c"), ("d", "c")]),
            &without,
        );
        assert_eq!(clusters.len(), 1, "a cluster of one is a photograph");
        assert_eq!(clusters[0].key, "c");
    }
}
