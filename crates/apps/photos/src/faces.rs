//! The face plane: `faces` (one asset), `face-queue` (vault-wide) and
//! `people` (the roster). **The hardest handler in the tree, with its traps
//! ported as tests** (D-1020-P2).
//!
//! Four traps, each one a test below:
//!
//! 1. **Confidence is a MATCH COUNT, never a percentage.** The queue's number
//!    is "how many other photographs propose this same person", deduped by
//!    photograph — an integer. The region's own `confidence` column is a
//!    detector score in `[0,1]` and is a different fact with a different name
//!    here ([`FaceRegion::detector_confidence`]). v0's queue output calls its
//!    integer `matchCount` and never mixes them; a port that reused one field
//!    would print "1 %" for a face seen in one other photograph.
//! 2. **The filter is on `review_state`, not `confirmed_by_party_id`** (#712).
//!    Confirmed, rejected and dismissed all leave the queue for good, and a
//!    rejection does not DELETE the row — that would make "gone from this list"
//!    and "gone from the vault" the same thing, and the enricher would be free
//!    to propose the same stranger again.
//! 3. **"First seen" is the earliest `captured_at` among the matches**, because
//!    `media_face_region` has no `created_at` worth reading for this.
//!    **No proposal time is invented**: when no match has a capture time the
//!    answer is `None`, not the query's own clock.
//! 4. **Three windows, each a stated number that reports the size it reaches**:
//!    [`REGION_ROWS`] 4,000, [`PARTY_ROWS`] 500, [`QUEUE_LIMIT`] 60.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, in_list, read_pages, read_window};
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::queries::{ASSET_JOIN_BOUND, ContentRow, SourceUris, content_statement, src_of};

/// The review queue considers this many regions (`face-queue.ts:20`, and
/// `people.ts:50`'s `REGION_LIMIT` which must match it or the two disagree
/// about the backlog).
pub const REGION_ROWS: usize = 4_000;

/// The name picker offers this many people (`face-queue.ts:21`, `people.ts:14`).
pub const PARTY_ROWS: usize = 500;

/// One ordered page of the queue (`face-queue.ts:23`).
pub const QUEUE_LIMIT: usize = 60;

/// One photo shows this many faces (`faces.ts:2`).
pub const FACES_PER_PHOTO: usize = 50;

/// The picker in the lightbox offers this many names (`faces.ts:3`).
pub const NAME_PICKER_ROWS: usize = 200;

/// The proposal shelf shows this many groups (`people.ts:53`).
pub const PROPOSAL_LIMIT: usize = 60;

/// The four answers a region can carry. A CLOSED set: the column's own CHECK is
/// `('proposed','confirmed','rejected','dismissed')`, and a fifth value is a
/// vault the port does not know how to read rather than a state to guess at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReviewState {
    /// The enricher's candidate, unanswered.
    Proposed,
    /// The owner named the person. `confirmed_by_party_id` is NOT NULL, pinned
    /// by the table's own CHECK.
    Confirmed,
    /// Refused for good. The row survives carrying its answer.
    Rejected,
    /// Reviewed, and deliberately left unnamed — the answer that finishes a
    /// queue, and the one v0 could not express before #712.
    Dismissed,
}

impl ReviewState {
    /// The column's spelling, or `None` for anything else.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "proposed" => Some(Self::Proposed),
            "confirmed" => Some(Self::Confirmed),
            "rejected" => Some(Self::Rejected),
            "dismissed" => Some(Self::Dismissed),
            _ => None,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Proposed => "proposed",
            Self::Confirmed => "confirmed",
            Self::Rejected => "rejected",
            Self::Dismissed => "dismissed",
        }
    }
}

/// One `media_face_region` row, as every face surface reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceRegion {
    pub region_id: String,
    pub asset_id: String,
    /// Kept as the column's text. The port does not parse a bbox: it is handed
    /// to a renderer that knows what a box is, and a malformed one must reach
    /// the surface as malformed rather than as a silent `(0,0,0,0)`.
    pub bbox_json: Option<String>,
    /// The candidate (`proposed`) or the owner's word (`confirmed`). A rejected
    /// or dismissed region carries none — the table's CHECK says so.
    pub party_id: Option<String>,
    /// THE DETECTOR'S SCORE, in `[0,1]`. **Not** the queue's match count. Named
    /// apart on purpose; see the module note.
    pub detector_confidence: Option<f64>,
    pub confirmed_by_party_id: Option<String>,
    /// `None` when the door answered a value the column's CHECK forbids.
    pub review_state: Option<ReviewState>,
}

impl FaceRegion {
    /// Read one row. `region_id` and `asset_id` are NOT NULL in the schema, so
    /// a row missing either is a row this port refuses to invent.
    #[must_use]
    pub fn of(row: &Row) -> Option<Self> {
        Some(Self {
            region_id: text_of(row, "region_id")?,
            asset_id: text_of(row, "asset_id")?,
            bbox_json: text_of(row, "bbox_json"),
            party_id: text_of(row, "party_id"),
            detector_confidence: row.get("confidence").and_then(|cell| match cell {
                centraid_apps_kit::row::Cell::Real(value) => Some(*value),
                centraid_apps_kit::row::Cell::Integer(value) => {
                    // A door that stored an integer 0 or 1 in a REAL column.
                    #[expect(
                        clippy::cast_precision_loss,
                        reason = "a confidence is in [0,1]; the widening is exact for that range"
                    )]
                    Some(*value as f64)
                }
                _ => None,
            }),
            confirmed_by_party_id: text_of(row, "confirmed_by_party_id"),
            review_state: text_of(row, "review_state")
                .as_deref()
                .and_then(ReviewState::parse),
        })
    }

    /// Whether this region is still a question.
    #[must_use]
    pub fn pending(&self) -> bool {
        self.review_state == Some(ReviewState::Proposed)
    }
}

/// A person the picker can offer. Only `kind = 'person'` parties.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Person {
    pub party_id: String,
    pub name: Option<String>,
}

/// One entry of the review queue.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceQueueEntry {
    pub region_id: String,
    pub bbox_json: Option<String>,
    pub party_id: Option<String>,
    pub person_name: Option<String>,
    /// HOW MANY OTHER PHOTOGRAPHS PROPOSE THE SAME PERSON. An integer, and
    /// `0` when the region names no candidate.
    pub match_count: usize,
    /// The earliest `captured_at` among the matches. `None` when no match has
    /// one — **never the query's own clock**.
    pub first_seen_at: Option<String>,
    /// The source photograph, when it was inside the asset window.
    pub asset: Option<QueueAsset>,
}

/// The photograph a queue entry is on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueAsset {
    pub asset_id: String,
    pub uris: SourceUris,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// What `face-queue` answers.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FaceQueue {
    pub queue: Vec<FaceQueueEntry>,
    /// Every pending region, not just the page. The status line's number.
    pub unmatched_total: usize,
    pub confirmed_total: usize,
    pub rejected_total: usize,
    pub dismissed_total: usize,
    pub people: Vec<Person>,
    /// `true` when the vault holds more than [`REGION_ROWS`] regions, so a
    /// surface can say the backlog is longer than what was read rather than
    /// implying it read all of it.
    pub region_window_filled: bool,
}

// ---------------------------------------------------------------------------
// The statements.
// ---------------------------------------------------------------------------

/// `photos.faceQueue.regions` — every region, in region-id order.
#[must_use]
pub fn queue_regions_statement() -> PageQuery {
    PageQuery::new(
        "photos.faceQueue.regions",
        "region_id, asset_id, bbox_json, party_id, confidence, confirmed_by_party_id, \
         review_state, created_at",
        "media_face_region",
        PageOrder::asc("region_id", "region_id"),
    )
}

/// `photos.faceQueue.parties` — the name picker's roster.
///
/// **Ordered by `display_name`, which is v0's order and a `localeCompare` one
/// on the render side.** The statement's own ordering is SQLite's `BINARY`
/// collation; the fixture manifest marks the case `order: "set"` where the two
/// can disagree over non-ASCII names, exactly as D-1020-D3-6 requires.
#[must_use]
pub fn queue_parties_statement() -> PageQuery {
    PageQuery::new(
        "photos.faceQueue.parties",
        "party_id, display_name, kind",
        "core_party",
        PageOrder::asc("display_name", "party_id"),
    )
}

/// `photos.faces.regions` — one asset's faces.
#[must_use]
pub fn asset_regions_statement(asset_id: &str) -> PageQuery {
    PageQuery::new(
        "photos.faces.regions",
        "region_id, asset_id, bbox_json, party_id, confidence, confirmed_by_party_id, review_state",
        "media_face_region",
        PageOrder::asc("region_id", "region_id"),
    )
    .filter(
        "asset_id = ?",
        vec![PageBindValue::Text(asset_id.to_owned())],
    )
}

/// `photos.faces.parties` — the lightbox picker's roster.
#[must_use]
pub fn asset_parties_statement() -> PageQuery {
    PageQuery::new(
        "photos.faces.parties",
        "party_id, display_name, kind",
        "core_party",
        PageOrder::asc("display_name", "party_id"),
    )
}

/// `photos.people.clusters` — which unnamed regions the enricher grouped.
#[must_use]
pub fn clusters_statement() -> PageQuery {
    PageQuery::new(
        "photos.people.clusters",
        "region_id, cluster_id, computed_at",
        "media_face_cluster",
        PageOrder::asc("region_id", "region_id"),
    )
}

/// `photos.faceQueue.assets` — the photographs the page's regions are on.
pub fn queue_assets_statement(asset_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("asset_id", asset_ids)?;
    Ok(PageQuery::new(
        "photos.faceQueue.assets",
        "asset_id, content_id, kind, title, captured_at, width, height",
        "media_asset",
        PageOrder::asc("asset_id", "asset_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

// ---------------------------------------------------------------------------
// The folds.
// ---------------------------------------------------------------------------

/// Every person party, keyed by id.
#[must_use]
pub fn people_of(rows: &[Row]) -> Vec<Person> {
    rows.iter()
        .filter(|row| text_of(row, "kind").as_deref() == Some("person"))
        .filter_map(|row| {
            Some(Person {
                party_id: text_of(row, "party_id")?,
                name: text_of(row, "display_name"),
            })
        })
        .collect()
}

/// The photographs proposing each party, deduped BY PHOTOGRAPH.
///
/// Two faces of the same person in one frame are one photograph, which is why
/// this is a set of asset ids and not a region count.
#[must_use]
pub fn assets_by_party(regions: &[FaceRegion]) -> BTreeMap<String, BTreeSet<String>> {
    let mut map: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for region in regions {
        if let Some(party) = region.party_id.as_ref() {
            map.entry(party.clone())
                .or_default()
                .insert(region.asset_id.clone());
        }
    }
    map
}

/// THE MATCH COUNT. "How many OTHER photographs", so this region's own
/// photograph is excluded when it is in the set (`face-queue.ts:143-148`).
#[must_use]
pub fn match_count(region: &FaceRegion, by_party: &BTreeMap<String, BTreeSet<String>>) -> usize {
    let Some(party) = region.party_id.as_ref() else {
        return 0;
    };
    let Some(ids) = by_party.get(party) else {
        return 0;
    };
    if ids.contains(&region.asset_id) {
        ids.len() - 1
    } else {
        ids.len()
    }
}

/// FIRST SEEN: the earliest `captured_at` among the matching photographs, and
/// `None` when none of them has one (`face-queue.ts:149-160`).
#[must_use]
pub fn first_seen_at(
    region: &FaceRegion,
    by_party: &BTreeMap<String, BTreeSet<String>>,
    captured_at: &BTreeMap<String, Option<String>>,
) -> Option<String> {
    let ids: Vec<String> = region
        .party_id
        .as_ref()
        .and_then(|party| by_party.get(party))
        .map_or_else(
            || vec![region.asset_id.clone()],
            |set| set.iter().cloned().collect(),
        );
    ids.iter()
        .filter_map(|id| captured_at.get(id).cloned().flatten())
        .min()
}

/// The whole `face-queue` fold, given what the four statements returned.
#[must_use]
pub fn fold_face_queue(
    regions: &[FaceRegion],
    region_window_filled: bool,
    people: Vec<Person>,
    assets: &BTreeMap<String, QueueAssetFacts>,
    contents: &BTreeMap<String, ContentRow>,
) -> FaceQueue {
    let name_of: BTreeMap<&str, Option<&str>> = people
        .iter()
        .map(|person| (person.party_id.as_str(), person.name.as_deref()))
        .collect();
    let by_party = assets_by_party(regions);
    let captured_at: BTreeMap<String, Option<String>> = assets
        .iter()
        .map(|(id, facts)| (id.clone(), facts.captured_at.clone()))
        .collect();

    let mut pending: Vec<&FaceRegion> = regions.iter().filter(|r| r.pending()).collect();
    // The regions arrive in region-id order already; the sort is explicit
    // because the SLICE is what a member sees and it must not depend on the
    // door's ordering (`face-queue.ts:103-105`).
    pending.sort_by(|left, right| left.region_id.cmp(&right.region_id));
    let unmatched_total = pending.len();
    let count_of = |state: ReviewState| {
        regions
            .iter()
            .filter(|region| region.review_state == Some(state))
            .count()
    };

    let queue = pending
        .iter()
        .take(QUEUE_LIMIT)
        .map(|region| {
            let asset = assets.get(&region.asset_id).map(|facts| QueueAsset {
                asset_id: region.asset_id.clone(),
                uris: src_of(facts.content_id.as_deref().and_then(|id| contents.get(id))),
                width: facts.width,
                height: facts.height,
            });
            FaceQueueEntry {
                region_id: region.region_id.clone(),
                bbox_json: region.bbox_json.clone(),
                party_id: region.party_id.clone(),
                person_name: region
                    .party_id
                    .as_deref()
                    .and_then(|party| name_of.get(party).copied().flatten())
                    .map(str::to_owned),
                match_count: match_count(region, &by_party),
                first_seen_at: first_seen_at(region, &by_party, &captured_at),
                asset,
            }
        })
        .collect();

    FaceQueue {
        queue,
        unmatched_total,
        confirmed_total: count_of(ReviewState::Confirmed),
        rejected_total: count_of(ReviewState::Rejected),
        dismissed_total: count_of(ReviewState::Dismissed),
        people,
        region_window_filled,
    }
}

/// The asset facts the queue and the roster need off `media_asset`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct QueueAssetFacts {
    pub content_id: Option<String>,
    pub captured_at: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

impl QueueAssetFacts {
    #[must_use]
    pub fn of(row: &Row) -> Self {
        Self {
            content_id: text_of(row, "content_id"),
            captured_at: text_of(row, "captured_at"),
            width: row
                .get("width")
                .and_then(centraid_apps_kit::row::Cell::integer),
            height: row
                .get("height")
                .and_then(centraid_apps_kit::row::Cell::integer),
        }
    }
}

/// Read and fold `face-queue`.
pub fn face_queue(door: &dyn PageDoor) -> KitResult<FaceQueue> {
    let regions_window = read_window(door, &queue_regions_statement(), REGION_ROWS)?;
    let regions: Vec<FaceRegion> = regions_window
        .rows
        .iter()
        .filter_map(FaceRegion::of)
        .collect();
    let parties = read_window(door, &queue_parties_statement(), PARTY_ROWS)?;
    let people = people_of(&parties.rows);

    let mut page_asset_ids: Vec<String> = regions
        .iter()
        .filter(|region| region.pending())
        .map(|region| region.region_id.clone())
        .collect();
    page_asset_ids.sort();
    // The page is the first QUEUE_LIMIT pending regions, and only their
    // photographs are joined — the whole point of the slice.
    let mut pending: Vec<&FaceRegion> = regions.iter().filter(|r| r.pending()).collect();
    pending.sort_by(|left, right| left.region_id.cmp(&right.region_id));
    let mut asset_ids: Vec<String> = pending
        .iter()
        .take(QUEUE_LIMIT)
        .map(|region| region.asset_id.clone())
        .collect();
    asset_ids.sort();
    asset_ids.dedup();

    let (assets, contents) = if asset_ids.is_empty() {
        (BTreeMap::new(), BTreeMap::new())
    } else {
        let rows = read_pages(door, &queue_assets_statement(&asset_ids)?, ASSET_JOIN_BOUND)?;
        let assets: BTreeMap<String, QueueAssetFacts> = rows
            .iter()
            .filter_map(|row| Some((text_of(row, "asset_id")?, QueueAssetFacts::of(row))))
            .collect();
        let mut content_ids: Vec<String> = assets
            .values()
            .filter_map(|facts| facts.content_id.clone())
            .collect();
        content_ids.sort();
        content_ids.dedup();
        let contents = if content_ids.is_empty() {
            BTreeMap::new()
        } else {
            read_pages(
                door,
                &content_statement("photos.faceQueue.contents", &content_ids)?,
                ASSET_JOIN_BOUND,
            )?
            .iter()
            .filter_map(|row| Some((text_of(row, "content_id")?, ContentRow::of(row)?)))
            .collect()
        };
        (assets, contents)
    };

    Ok(fold_face_queue(
        &regions,
        regions_window.filled,
        people,
        &assets,
        &contents,
    ))
}

// ---------------------------------------------------------------------------
// `people` — the roster.
// ---------------------------------------------------------------------------

/// One grouping of regions: a confirmed person, a pending candidate, or an
/// unnamed cluster (`_shared/people-counts.ts:16`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaceCountGroup {
    pub id: String,
    pub region_ids: Vec<String>,
    /// DISTINCT PHOTOGRAPHS, in region order of first appearance.
    pub asset_ids: Vec<String>,
    pub cover_region_id: Option<String>,
}

/// The three collections `groupPeopleFaces` answers, plus the pending total.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PeopleFaceGroups {
    /// A person exists only after a confirmed answer.
    pub confirmed: Vec<ConfirmedGroup>,
    /// Candidates the enricher named but nobody answered.
    pub pending_by_party: Vec<FaceCountGroup>,
    /// Unanswered faces the enricher grouped but could not name.
    pub unnamed: Vec<FaceCountGroup>,
    pub pending_total: usize,
}

/// A confirmed group, and who confirmed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmedGroup {
    pub group: FaceCountGroup,
    /// Sorted, deduped. A non-person confirmer keeps its id and has no name;
    /// the view says "someone else".
    pub confirmer_ids: Vec<String>,
}

fn group_rows<F>(regions: &[&FaceRegion], id_of: F) -> Vec<FaceCountGroup>
where
    F: Fn(&FaceRegion) -> Option<String>,
{
    let mut groups: BTreeMap<String, Vec<&FaceRegion>> = BTreeMap::new();
    for region in regions {
        if let Some(id) = id_of(region) {
            groups.entry(id).or_default().push(region);
        }
    }
    groups
        .into_iter()
        .map(|(id, mut members)| {
            members.sort_by(|left, right| left.region_id.cmp(&right.region_id));
            let mut asset_ids: Vec<String> = Vec::new();
            for member in &members {
                if !asset_ids.contains(&member.asset_id) {
                    asset_ids.push(member.asset_id.clone());
                }
            }
            FaceCountGroup {
                cover_region_id: members.first().map(|region| region.region_id.clone()),
                region_ids: members
                    .iter()
                    .map(|region| region.region_id.clone())
                    .collect(),
                asset_ids,
                id,
            }
        })
        .collect()
}

/// `groupPeopleFaces`, ported (`_shared/people-counts.ts:68-108`).
///
/// **A person exists only after a confirmed answer**, and a proposal is
/// evidence rather than an identity — which is why the three collections stay
/// three and the proposal groups carry no name.
#[must_use]
pub fn group_people_faces(
    regions: &[FaceRegion],
    clusters: &BTreeMap<String, String>,
) -> PeopleFaceGroups {
    let confirmed_rows: Vec<&FaceRegion> = regions
        .iter()
        .filter(|region| {
            region.review_state == Some(ReviewState::Confirmed) && region.party_id.is_some()
        })
        .collect();
    let confirmed = group_rows(&confirmed_rows, |region| region.party_id.clone())
        .into_iter()
        .map(|group| {
            let mut confirmer_ids: Vec<String> = confirmed_rows
                .iter()
                .filter(|region| region.party_id.as_deref() == Some(group.id.as_str()))
                .filter_map(|region| region.confirmed_by_party_id.clone())
                .collect();
            confirmer_ids.sort();
            confirmer_ids.dedup();
            ConfirmedGroup {
                group,
                confirmer_ids,
            }
        })
        .collect();

    let proposed: Vec<&FaceRegion> = regions.iter().filter(|region| region.pending()).collect();
    let named: Vec<&FaceRegion> = proposed
        .iter()
        .copied()
        .filter(|region| region.party_id.is_some())
        .collect();
    let pending_by_party = group_rows(&named, |region| region.party_id.clone());
    let unnamed_rows: Vec<&FaceRegion> = proposed
        .iter()
        .copied()
        .filter(|region| region.party_id.is_none())
        .collect();
    let unnamed = group_rows(&unnamed_rows, |region| {
        clusters.get(&region.region_id).cloned()
    });

    PeopleFaceGroups {
        confirmed,
        pending_by_party,
        unnamed,
        pending_total: proposed.len(),
    }
}

/// One person on the People shelf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterPerson {
    pub party_id: String,
    pub name: Option<String>,
    pub count: usize,
    pub asset_ids: Vec<String>,
    pub confirmed_by: Vec<Person>,
}

/// One proposal card on the People shelf. **No `name` field**, by design.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterProposal {
    /// `party:<id>` or `cluster:<id>` — the key's prefix is what keeps a named
    /// candidate and an unnamed cluster from colliding on one id.
    pub cluster_key: String,
    pub party_id: Option<String>,
    pub count: usize,
    pub region_id: String,
}

/// What `people` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PeopleRoster {
    pub people: Vec<RosterPerson>,
    pub proposals: Vec<RosterProposal>,
    /// The same vault-wide pending count `face-queue` derives, so the shelf's
    /// pending note needs no second read.
    pub unmatched_total: usize,
}

/// The `people` fold.
#[must_use]
pub fn fold_people(
    regions: &[FaceRegion],
    clusters: &BTreeMap<String, String>,
    people: &[Person],
) -> PeopleRoster {
    let grouped = group_people_faces(regions, clusters);
    let name_of: BTreeMap<&str, Option<&str>> = people
        .iter()
        .map(|person| (person.party_id.as_str(), person.name.as_deref()))
        .collect();

    // `party:`/`cluster:` keys, ordered by the key — v0 sorts the entries
    // lexically and slices PROPOSAL_LIMIT off the front.
    let mut proposals: Vec<RosterProposal> = grouped
        .pending_by_party
        .iter()
        .filter_map(|group| {
            Some(RosterProposal {
                cluster_key: format!("party:{}", group.id),
                party_id: Some(group.id.clone()),
                count: group.asset_ids.len(),
                region_id: group.cover_region_id.clone()?,
            })
        })
        .chain(grouped.unnamed.iter().filter_map(|group| {
            Some(RosterProposal {
                cluster_key: format!("cluster:{}", group.id),
                party_id: None,
                count: group.asset_ids.len(),
                region_id: group.cover_region_id.clone()?,
            })
        }))
        .collect();
    proposals.sort_by(|left, right| left.cluster_key.cmp(&right.cluster_key));
    proposals.truncate(PROPOSAL_LIMIT);

    PeopleRoster {
        // A confirmed party the roster cannot name is dropped: v0 filters on
        // `nameOf.has(entry.id)`, and a person with no name is not a person a
        // shelf can show.
        people: grouped
            .confirmed
            .iter()
            .filter(|entry| name_of.contains_key(entry.group.id.as_str()))
            .map(|entry| RosterPerson {
                party_id: entry.group.id.clone(),
                name: name_of
                    .get(entry.group.id.as_str())
                    .copied()
                    .flatten()
                    .map(str::to_owned),
                count: entry.group.asset_ids.len(),
                asset_ids: entry.group.asset_ids.clone(),
                confirmed_by: entry
                    .confirmer_ids
                    .iter()
                    .map(|id| Person {
                        party_id: id.clone(),
                        name: name_of
                            .get(id.as_str())
                            .copied()
                            .flatten()
                            .map(str::to_owned),
                    })
                    .collect(),
            })
            .collect(),
        proposals,
        unmatched_total: grouped.pending_total,
    }
}

/// What `faces` answers for one asset.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AssetFaces {
    pub regions: Vec<AssetFace>,
    pub people: Vec<Person>,
}

/// One face on one photograph.
#[derive(Debug, Clone, PartialEq)]
pub struct AssetFace {
    pub region_id: String,
    pub bbox_json: Option<String>,
    pub party_id: Option<String>,
    pub person_name: Option<String>,
    /// The detector's score. See the module note on the two confidences.
    pub detector_confidence: Option<f64>,
    pub confirmed: bool,
}

/// The `faces` fold. ANSWERED REGIONS NEVER COME BACK: only `proposed` and
/// `confirmed` ride (`faces.ts:82-87`), so the lightbox's `N of M reviewed`
/// line counts what is actually left.
#[must_use]
pub fn fold_asset_faces(regions: &[FaceRegion], people: Vec<Person>) -> AssetFaces {
    let name_of: BTreeMap<&str, Option<&str>> = people
        .iter()
        .map(|person| (person.party_id.as_str(), person.name.as_deref()))
        .collect();
    AssetFaces {
        regions: regions
            .iter()
            .filter(|region| {
                matches!(
                    region.review_state,
                    Some(ReviewState::Proposed | ReviewState::Confirmed)
                )
            })
            .map(|region| AssetFace {
                region_id: region.region_id.clone(),
                bbox_json: region.bbox_json.clone(),
                party_id: region.party_id.clone(),
                person_name: region
                    .party_id
                    .as_deref()
                    .and_then(|party| name_of.get(party).copied().flatten())
                    .map(str::to_owned),
                detector_confidence: region.detector_confidence,
                confirmed: region.confirmed_by_party_id.is_some(),
            })
            .collect(),
        people,
    }
}

/// Read and fold `faces` for one asset.
pub fn asset_faces(door: &dyn PageDoor, asset_id: &str) -> KitResult<AssetFaces> {
    let regions = read_window(door, &asset_regions_statement(asset_id), FACES_PER_PHOTO)?;
    let parties = read_window(door, &asset_parties_statement(), NAME_PICKER_ROWS)?;
    let regions: Vec<FaceRegion> = regions.rows.iter().filter_map(FaceRegion::of).collect();
    Ok(fold_asset_faces(&regions, people_of(&parties.rows)))
}

/// Read and fold `people`.
pub fn people_roster(door: &dyn PageDoor) -> KitResult<PeopleRoster> {
    let regions = read_window(door, &queue_regions_statement(), REGION_ROWS)?;
    let regions: Vec<FaceRegion> = regions.rows.iter().filter_map(FaceRegion::of).collect();
    let parties = read_window(door, &queue_parties_statement(), PARTY_ROWS)?;
    let clusters = read_window(door, &clusters_statement(), REGION_ROWS)?;
    let clusters: BTreeMap<String, String> = clusters
        .rows
        .iter()
        .filter_map(|row| Some((text_of(row, "region_id")?, text_of(row, "cluster_id")?)))
        .collect();
    Ok(fold_people(&regions, &clusters, &people_of(&parties.rows)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::row::Cell;

    fn region(
        region_id: &str,
        asset_id: &str,
        party: Option<&str>,
        state: ReviewState,
    ) -> FaceRegion {
        FaceRegion {
            region_id: region_id.to_owned(),
            asset_id: asset_id.to_owned(),
            bbox_json: Some("{\"x\":0,\"y\":0,\"w\":1,\"h\":1}".to_owned()),
            party_id: party.map(str::to_owned),
            detector_confidence: Some(0.94),
            confirmed_by_party_id: (state == ReviewState::Confirmed).then(|| "party-me".to_owned()),
            review_state: Some(state),
        }
    }

    fn facts(content: &str, captured: Option<&str>) -> QueueAssetFacts {
        QueueAssetFacts {
            content_id: Some(content.to_owned()),
            captured_at: captured.map(str::to_owned),
            width: Some(270),
            height: Some(360),
        }
    }

    // -- TRAP 1 -------------------------------------------------------------

    /// THE MATCH COUNT IS A COUNT. Three photographs propose Ana; the entry on
    /// one of them says `2` — the OTHER two — and it is an integer, so there is
    /// no reading of it as 94 %.
    #[test]
    fn confidence_is_a_match_count_and_never_a_ratio() {
        let regions = vec![
            region("r-1", "a-1", Some("p-ana"), ReviewState::Proposed),
            region("r-2", "a-2", Some("p-ana"), ReviewState::Proposed),
            region("r-3", "a-3", Some("p-ana"), ReviewState::Proposed),
        ];
        let by_party = assets_by_party(&regions);
        assert_eq!(match_count(&regions[0], &by_party), 2);
        // The detector's score is a different field with a different type, and
        // it is still there.
        assert_eq!(regions[0].detector_confidence, Some(0.94));
        // `usize`, not a float: there is no `0.94` the queue could print.
        let count: usize = match_count(&regions[0], &by_party);
        assert_eq!(count, 2);
    }

    /// Two faces of one person in ONE frame is one photograph.
    #[test]
    fn the_match_count_dedupes_by_photograph_not_by_region() {
        let regions = vec![
            region("r-1", "a-1", Some("p-ana"), ReviewState::Proposed),
            region("r-2", "a-1", Some("p-ana"), ReviewState::Proposed),
        ];
        let by_party = assets_by_party(&regions);
        assert_eq!(match_count(&regions[0], &by_party), 0);
    }

    #[test]
    fn a_region_naming_nobody_has_no_matches() {
        let region = region("r-1", "a-1", None, ReviewState::Proposed);
        assert_eq!(
            match_count(&region, &assets_by_party(std::slice::from_ref(&region))),
            0
        );
    }

    // -- TRAP 2 -------------------------------------------------------------

    /// THE FILTER IS `review_state`. A confirmed region carries a
    /// `confirmed_by_party_id`; a REJECTED one does not, and filtering on the
    /// confirmer column would put it straight back in the queue.
    #[test]
    fn the_queue_filters_on_review_state_and_not_on_the_confirmer_column() {
        let regions = vec![
            region("r-1", "a-1", Some("p-ana"), ReviewState::Proposed),
            region("r-2", "a-2", Some("p-ana"), ReviewState::Confirmed),
            region("r-3", "a-3", None, ReviewState::Rejected),
            region("r-4", "a-4", None, ReviewState::Dismissed),
        ];
        let queue = fold_face_queue(
            &regions,
            false,
            Vec::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(queue.unmatched_total, 1);
        assert_eq!(
            queue
                .queue
                .iter()
                .map(|e| e.region_id.as_str())
                .collect::<Vec<_>>(),
            ["r-1"]
        );
        assert_eq!(queue.confirmed_total, 1);
        assert_eq!(queue.rejected_total, 1);
        assert_eq!(queue.dismissed_total, 1);
        // And the rejected row is STILL THERE — gone from the list is not gone
        // from the vault.
        assert_eq!(regions.len(), 4);
    }

    // -- TRAP 3 -------------------------------------------------------------

    /// FIRST SEEN IS A CAPTURE TIME OR NOTHING. No proposal time is invented.
    #[test]
    fn first_seen_is_none_when_no_matching_photograph_has_a_capture_time() {
        let regions = vec![
            region("r-1", "a-1", Some("p-ana"), ReviewState::Proposed),
            region("r-2", "a-2", Some("p-ana"), ReviewState::Proposed),
        ];
        let assets: BTreeMap<String, QueueAssetFacts> = [
            ("a-1".to_owned(), facts("c-1", None)),
            ("a-2".to_owned(), facts("c-2", None)),
        ]
        .into_iter()
        .collect();
        let queue = fold_face_queue(&regions, false, Vec::new(), &assets, &BTreeMap::new());
        assert_eq!(queue.queue[0].first_seen_at, None);
    }

    #[test]
    fn first_seen_is_the_earliest_capture_time_among_the_matches() {
        let regions = vec![
            region("r-1", "a-1", Some("p-ana"), ReviewState::Proposed),
            region("r-2", "a-2", Some("p-ana"), ReviewState::Proposed),
        ];
        let assets: BTreeMap<String, QueueAssetFacts> = [
            ("a-1".to_owned(), facts("c-1", Some("2026-03-02T10:00:00Z"))),
            ("a-2".to_owned(), facts("c-2", Some("2026-01-09T08:00:00Z"))),
        ]
        .into_iter()
        .collect();
        let queue = fold_face_queue(&regions, false, Vec::new(), &assets, &BTreeMap::new());
        assert_eq!(
            queue.queue[0].first_seen_at.as_deref(),
            Some("2026-01-09T08:00:00Z")
        );
    }

    // -- TRAP 4 -------------------------------------------------------------

    #[test]
    fn the_page_is_sixty_entries_and_the_total_is_the_whole_backlog() {
        let regions: Vec<FaceRegion> = (0..100)
            .map(|n| {
                region(
                    &format!("r-{n:03}"),
                    &format!("a-{n:03}"),
                    None,
                    ReviewState::Proposed,
                )
            })
            .collect();
        let queue = fold_face_queue(
            &regions,
            true,
            Vec::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(queue.queue.len(), QUEUE_LIMIT);
        assert_eq!(queue.unmatched_total, 100);
        assert!(
            queue.region_window_filled,
            "a backlog past REGION_ROWS must say so rather than implying it read all of it"
        );
        assert_eq!(REGION_ROWS, 4_000);
        assert_eq!(PARTY_ROWS, 500);
        assert_eq!(QUEUE_LIMIT, 60);
    }

    // -- the roster ---------------------------------------------------------

    #[test]
    fn a_person_exists_only_after_a_confirmed_answer() {
        let regions = vec![
            region("r-1", "a-1", Some("p-ana"), ReviewState::Confirmed),
            region("r-2", "a-2", Some("p-ana"), ReviewState::Confirmed),
            region("r-3", "a-3", Some("p-marco"), ReviewState::Proposed),
            region("r-4", "a-4", None, ReviewState::Proposed),
        ];
        let clusters: BTreeMap<String, String> =
            [("r-4".to_owned(), "r-4".to_owned())].into_iter().collect();
        let people = vec![
            Person {
                party_id: "p-ana".to_owned(),
                name: Some("Ana Ribeiro".to_owned()),
            },
            Person {
                party_id: "p-marco".to_owned(),
                name: Some("Marco Salas".to_owned()),
            },
        ];
        let roster = fold_people(&regions, &clusters, &people);
        assert_eq!(
            roster.people.len(),
            1,
            "only the confirmed party is a person"
        );
        assert_eq!(roster.people[0].party_id, "p-ana");
        assert_eq!(roster.people[0].count, 2);
        assert_eq!(roster.unmatched_total, 2);
        // A proposal carries no name, and a named candidate and an unnamed
        // cluster do not collide.
        let keys: Vec<&str> = roster
            .proposals
            .iter()
            .map(|p| p.cluster_key.as_str())
            .collect();
        assert_eq!(keys, ["cluster:r-4", "party:p-marco"]);
    }

    #[test]
    fn a_confirmed_region_names_its_confirmer_and_the_ids_are_deduped() {
        let regions = vec![
            region("r-1", "a-1", Some("p-ana"), ReviewState::Confirmed),
            region("r-2", "a-2", Some("p-ana"), ReviewState::Confirmed),
        ];
        let groups = group_people_faces(&regions, &BTreeMap::new());
        assert_eq!(groups.confirmed[0].confirmer_ids, ["party-me"]);
    }

    #[test]
    fn an_answered_region_never_rides_the_lightbox_list() {
        let regions = vec![
            region("r-1", "a-1", Some("p-ana"), ReviewState::Proposed),
            region("r-2", "a-1", Some("p-ana"), ReviewState::Confirmed),
            region("r-3", "a-1", None, ReviewState::Rejected),
            region("r-4", "a-1", None, ReviewState::Dismissed),
        ];
        let faces = fold_asset_faces(&regions, Vec::new());
        assert_eq!(faces.regions.len(), 2);
        assert!(faces.regions[1].confirmed);
    }

    // -- the row reader -----------------------------------------------------

    #[test]
    fn a_review_state_outside_the_checked_set_is_read_as_unknown_not_as_pending() {
        let mut row = Row::new();
        row.insert("region_id".to_owned(), Cell::Text("r-1".to_owned()));
        row.insert("asset_id".to_owned(), Cell::Text("a-1".to_owned()));
        row.insert("review_state".to_owned(), Cell::Text("triaged".to_owned()));
        let parsed = FaceRegion::of(&row).expect("the keys are there");
        assert_eq!(parsed.review_state, None);
        assert!(
            !parsed.pending(),
            "an unreadable state is not an invitation to review"
        );
    }

    #[test]
    fn a_row_with_no_region_id_is_refused_rather_than_invented() {
        let mut row = Row::new();
        row.insert("asset_id".to_owned(), Cell::Text("a-1".to_owned()));
        assert!(FaceRegion::of(&row).is_none());
    }
}
