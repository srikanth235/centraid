//! PHOTOS' ARM OF THE APP QUERY (#1097, R-1097-25..27, #1135): the screens' reads
//! (`photos.shelf`, `photos.photo`, `photos.albums`, `photos.places`), Photos' own
//! search and `photos.duplicates`.
//!
//! **WHAT MOVED HERE.** Photos' search was Kotlin `LIKE` over the caption. Its text
//! leg is now the photograph (`photo`: its caption, its place's name and
//! locality, the text recognised in the picture, in rank order) and its album leg
//! is the album container; its STRUCTURED legs (the places, no location, the
//! labels) are `centraid_apps_photos::search`, run here and folded with the text
//! legs into one answer with the counts above the grid and the grid itself.
//!
//! **THE PHOTOGRAPHS ARE LIVE ONES.** A hit is a live photograph
//! (`centraid_apps_kit::rules::Standing`: not trashed, not archived, not folded
//! under an edit), and an archived one is no hit (Photos' own shelf does not show
//! one). Home's search keeps the archived ones because it opens a photograph and
//! does not draw a grid; the difference is R-1097-25's and is held by
//! `centraid_apps_photos::queries::load_search_term`.
//!
//! **DUPLICATES ARE CLUSTERED HERE, AT READ.** The app reads the perceptual
//! hashes; the one clustering is `centraid_media::duplicates::cluster`, handed to
//! it, so there is exactly one and nothing is stored.
//!
//! **THE CORRECTION IS ASKED FOR, AND ONE ANSWER DECIDES IT.** A typo is corrected
//! only when EVERY leg is empty: the text, the albums, the places, no location and
//! the labels. The request carries `correct` when the surface allows it; the core
//! then corrects over the vocabularies of the photograph domain and the album
//! container, runs every leg at the corrected words and reports the words only if
//! they found something. Places and labels are not corrected: the vault holds no
//! vocabulary of them in the index (a place is arithmetic on a coordinate and a
//! gazetteer name inside a JSON column, a label a concept the page door reads), but
//! they ARE searched at the corrected words.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::Denial;
use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::rules::Standing;
use centraid_apps_photos as photos;
use centraid_apps_photos::cells::PhotoCell;
use centraid_apps_photos::places::{PlaceCard, PlacePhrase, PlacePhraseSource};
use centraid_apps_photos::queries::PHOTO_KIND;
use centraid_apps_photos::search::{HitKind, Named, Structured};
use centraid_search::{Principal, Search, Target};
use centraid_vault::Vault;

use super::{RecordingSearch, VaultDoor, corrected_search, filled, filled_targets, named, settle};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// The app a Photos album opens in.
const APP: &str = "photos";

/// What the core's legs answer for one term: the text, the albums and the
/// structured legs.
type Found = (photos::queries::SearchData, Vec<Target>, Structured);

fn now_ms(now: &str) -> Result<i64> {
    centraid_vault::time::recurrence::parse_instant_ms(now).ok_or_else(|| CoreError::Invariant {
        context: format!("the vault clock did not read as an instant: {now}"),
    })
}

pub(crate) fn search(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::PhotosSearchRequest,
) -> Result<Answer> {
    if asked.limit == 0 {
        // REQUIRED AND VALIDATED, not defaulted: proto3 cannot say "required".
        return Err(CoreError::InvalidRequest {
            detail: "a photos search carries no limit; a default is how an unbounded read \
                     gets written by accident"
                .to_owned(),
        });
    }
    let limit = usize::try_from(asked.limit).unwrap_or(usize::MAX);
    let now_ms = now_ms(now)?;
    let loaded = vault.read(|connection| {
        let index = match centraid_search::SqliteDoor::open(connection, vault.words()) {
            Ok(index) => index,
            Err(error) => {
                return Ok(Err(CoreError::Invariant {
                    context: format!("the search index will not open: {error}"),
                }));
            }
        };
        let search = RecordingSearch {
            inner: &index,
            door,
        };
        Ok(Ok(answer(
            door,
            &search,
            &asked.term,
            limit,
            asked.correct,
            now_ms,
        )))
    })??;
    settle(door, loaded, |(search, corrected)| {
        Answer::PhotosSearch(search_to_wire(search, corrected))
    })
}

/// What a search says, before it is wire.
struct Searched {
    ranked: Vec<String>,
    albums: Vec<Target>,
    hits: photos::search::SearchHits,
    resting: photos::search::Resting,
}

fn search_to_wire(searched: Searched, corrected: String) -> wire::PhotosSearch {
    wire::PhotosSearch {
        asset_ids: searched.ranked,
        albums: searched.albums.into_iter().map(named::to_wire).collect(),
        corrected,
        cells: searched.hits.cells.iter().map(cell).collect(),
        total_hits: u32::try_from(searched.hits.total).unwrap_or(u32::MAX),
        truncated: searched.hits.truncated,
        top_hits: searched
            .hits
            .top_hits
            .into_iter()
            .map(|hit| wire::PhotosTopHit {
                kind: match hit.kind {
                    HitKind::Place => wire::photos_top_hit::Kind::Place,
                    HitKind::Unplaced => wire::photos_top_hit::Kind::Unplaced,
                    HitKind::Album => wire::photos_top_hit::Kind::Album,
                } as i32,
                id: hit.id,
                label: hit.label,
                count: count(hit.count),
            })
            .collect(),
        labels: searched.hits.labels.into_iter().map(named_wire).collect(),
        resting_places: searched
            .resting
            .places
            .into_iter()
            .map(named_wire)
            .collect(),
        resting_labels: searched
            .resting
            .labels
            .into_iter()
            .map(named_wire)
            .collect(),
    }
}

fn named_wire(named: Named) -> wire::PhotosNamed {
    wire::PhotosNamed {
        id: named.id,
        label: named.label,
    }
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn tag(tag: &photos::queries::PhotoTag) -> wire::PhotosTag {
    wire::PhotosTag {
        tag_id: tag.tag_id.clone(),
        label: tag.label.clone(),
    }
}

fn place(row: &photos::places::PlaceRow) -> wire::PhotosPlace {
    wire::PhotosPlace {
        place_id: row.place_id.clone(),
        name: row.name.clone(),
        lat: row.lat,
        lng: row.lng,
        gazetteer: row.gazetteer.clone(),
        time_zone: row.time_zone.clone(),
    }
}

/// One photograph as a grid draws it.
fn cell(cell: &PhotoCell) -> wire::PhotosCell {
    wire::PhotosCell {
        photo_id: cell.photo_id.clone(),
        content_id: cell.content_id.clone(),
        media_type: cell.media_type.clone(),
        form: cell.form.clone(),
        title: cell.title.clone(),
        taken_at: cell.taken_at.clone(),
        offset_min: cell.offset_min,
        burst: cell.burst.clone(),
        edited_from: cell.edited_from.clone(),
        place_id: cell.place_id.clone(),
        width: cell.width,
        height: cell.height,
        duration_s: cell.duration_s,
        created_at: cell.created_at.clone(),
        deleted_at: cell.deleted_at.clone(),
        purge_at: cell.purge_at.clone(),
        purge_in_days: cell.purge_in_days,
        favorite: cell.favorite,
        archived: cell.archived,
        byte_size: cell.byte_size,
        album_ids: cell.album_ids.clone(),
        thumbnail_path: cell.thumbnail_path.clone(),
        original_held: cell.original_held,
        live: cell.live,
        live_movie_id: cell.live_movie_id.clone(),
        live_content_id: cell.live_content_id.clone(),
        live_of: cell.live_of.clone(),
    }
}

fn phrase_source(source: PlacePhraseSource) -> wire::PhotosPhraseSource {
    match source {
        PlacePhraseSource::Member => wire::PhotosPhraseSource::Member,
        PlacePhraseSource::Gazetteer => wire::PhotosPhraseSource::Gazetteer,
        PlacePhraseSource::Relative => wire::PhotosPhraseSource::Relative,
        PlacePhraseSource::None => wire::PhotosPhraseSource::None,
    }
}

fn place_card(
    row: &photos::places::PlaceRow,
    name: Option<String>,
    phrase: &PlacePhrase,
    count_in: usize,
    cover: Option<&PhotoCell>,
    exact_location: Option<String>,
) -> wire::PhotosPlaceCard {
    wire::PhotosPlaceCard {
        place: Some(place(row)),
        name,
        phrase: phrase.text.clone(),
        phrase_source: phrase_source(phrase.source) as i32,
        count: count(count_in),
        cover: cover.map(self::cell),
        exact_location,
    }
}

fn card(card: &PlaceCard) -> wire::PhotosPlaceCard {
    place_card(
        &card.place,
        card.name.clone(),
        &card.phrase,
        card.count,
        card.cover.as_ref(),
        None,
    )
}

fn cursor(cursor: &photos::shelf::ShelfCursor) -> wire::PhotosCursor {
    wire::PhotosCursor {
        sort_key: cursor.sort_key.clone(),
        id: cursor.id.clone(),
    }
}

/// `photos.shelf`: one page of one shelf.
pub(crate) fn shelf(
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::PhotosShelfRequest,
) -> Result<Answer> {
    use photos::shelf::{Shelf, ShelfInput};
    use wire::PhotosShelfView as V;

    if asked.limit == 0 {
        return Err(CoreError::InvalidRequest {
            detail: "a photos shelf carries no limit; a default is how an unbounded read \
                     gets written by accident"
                .to_owned(),
        });
    }
    let id = (!asked.id.is_empty()).then_some(asked.id.as_str());
    let which = match V::try_from(asked.view).unwrap_or(V::Unspecified) {
        V::Unspecified => None,
        V::Live => Some(Shelf::Live),
        V::Favorites => Some(Shelf::Favorites),
        V::Videos => Some(Shelf::Videos),
        V::Archive => Some(Shelf::Archive),
        V::Trash => Some(Shelf::Trash),
        V::Unplaced => Some(Shelf::Unplaced),
        V::Album => id.map(|id| Shelf::Album(id.to_owned())),
        V::Place => id.map(|id| Shelf::Place(id.to_owned())),
    }
    .ok_or_else(|| CoreError::InvalidRequest {
        detail: "a photos shelf names a view, and an album or a place names its id".to_owned(),
    })?;
    let input = ShelfInput {
        shelf: which,
        limit: usize::try_from(asked.limit).unwrap_or(usize::MAX),
        after: asked
            .after
            .as_ref()
            .map(|after| photos::shelf::ShelfCursor {
                sort_key: after.sort_key.clone(),
                id: after.id.clone(),
            }),
    };
    let loaded = photos::shelf::load_shelf(door, &input, now_ms(now)?).map(|data| (data, None));
    settle(door, loaded, |data| {
        Answer::PhotosShelf(Box::new(wire::PhotosShelf {
            cells: data.cells.iter().map(cell).collect(),
            next: data.next.as_ref().map(cursor),
            total: data.total.map(count),
            album: data.album.map(|head| wire::PhotosAlbumHead {
                album_id: head.album_id,
                title: head.title,
                deleted_at: head.deleted_at,
                purge_at: head.purge_at,
                purge_in_days: head.purge_in_days,
            }),
            place: data.place.as_ref().map(card),
        }))
    })
}

/// `photos.photo`: everything one photograph's screens show.
pub(crate) fn photo(
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::PhotosPhotoRequest,
) -> Result<Answer> {
    let loaded = photos::detail::load_photo(door, &asked.id, now_ms(now)?).map(|data| (data, None));
    settle(door, loaded, |detail| {
        Answer::PhotosPhoto(Box::new(wire::PhotosPhoto {
            photo: detail.map(|detail| wire::PhotosPhotoDetail {
                cell: Some(cell(&detail.cell)),
                trashed: detail.trashed,
                albums: detail
                    .albums
                    .into_iter()
                    .map(|album| wire::PhotosAlbumRef {
                        album_id: album.album_id,
                        title: album.title,
                    })
                    .collect(),
                tags: detail.tags.iter().map(tag).collect(),
                place: detail.place.map(|held| {
                    place_card(
                        &held.place,
                        held.name,
                        &held.phrase,
                        0,
                        None,
                        held.exact_location,
                    )
                }),
                edits: detail.edits,
            }),
        }))
    })
}

fn tile(tile: &photos::overview::ShelfTile) -> wire::PhotosShelfTile {
    wire::PhotosShelfTile {
        count: count(tile.count),
        cover: tile.cover.as_ref().map(cell),
    }
}

/// The one clustering, `centraid_media::duplicates::cluster`, over the fingerprints
/// Photos hands it.
fn clustering(prints: &[photos::Fingerprint]) -> std::collections::BTreeMap<String, String> {
    use centraid_media::duplicates::{DUPLICATE_HAMMING_THRESHOLD, Fingerprint, cluster};

    let rows: Vec<Fingerprint> = prints
        .iter()
        .map(|print| Fingerprint {
            asset_id: print.photo_id.clone(),
            phash: print.phash.clone(),
            cluster_id: None,
        })
        .collect();
    cluster(&rows, DUPLICATE_HAMMING_THRESHOLD)
}

/// `photos.albums`: the collections overview.
pub(crate) fn albums(door: &VaultDoor<'_>, now: &str) -> Result<Answer> {
    let now_ms = now_ms(now)?;
    let loaded = photos::overview::load_albums(door, now_ms)
        .and_then(|data| {
            let duplicates = photos::duplicate_cluster_count(door, clustering)?;
            Ok((data, duplicates))
        })
        .map(|data| (data, None));
    settle(door, loaded, |(data, duplicates)| {
        Answer::PhotosAlbums(Box::new(wire::PhotosAlbums {
            albums: data
                .albums
                .iter()
                .map(|album| wire::PhotosAlbumCard {
                    album_id: album.album_id.clone(),
                    title: album.title.clone(),
                    count: count(album.count),
                    cover: album.cover.as_ref().map(cell),
                })
                .collect(),
            trashed_albums: data
                .trashed_albums
                .into_iter()
                .map(|album| wire::PhotosTrashedAlbum {
                    album_id: album.album_id,
                    title: album.title,
                    deleted_at: album.deleted_at,
                    purge_at: album.purge_at,
                    purge_in_days: album.purge_in_days,
                })
                .collect(),
            live: Some(tile(&data.live)),
            favorites: Some(tile(&data.favorites)),
            videos: Some(tile(&data.videos)),
            archive: Some(tile(&data.archive)),
            trash: Some(tile(&data.trash)),
            places: count(data.places),
            unplaced: count(data.unplaced),
            duplicate_clusters: count(duplicates),
        }))
    })
}

/// `photos.places`: every place with its live count, cover and phrase.
pub(crate) fn places(door: &VaultDoor<'_>, now: &str) -> Result<Answer> {
    let loaded = photos::places::load_places(door, now_ms(now)?).map(|data| (data, None));
    settle(door, loaded, |data| {
        Answer::PhotosPlaces(wire::PhotosPlaces {
            places: data.places.iter().map(card).collect(),
            unplaced: count(data.unplaced),
        })
    })
}

/// The search, at the exact term and, when the surface allows it and nothing was
/// found, at the corrected words; the structured legs and the grid after.
fn answer(
    door: &VaultDoor<'_>,
    search: &dyn Search,
    term: &str,
    limit: usize,
    may_correct: bool,
    now_ms: i64,
) -> KitResult<((Searched, String), Option<Denial>)> {
    let standing = Standing::read(door)?;
    if term.trim().is_empty() {
        let resting = photos::search::resting(door, &standing)?;
        return Ok((
            (
                Searched {
                    ranked: Vec::new(),
                    albums: Vec::new(),
                    hits: photos::search::SearchHits::default(),
                    resting,
                },
                String::new(),
            ),
            None,
        ));
    }
    let found = if may_correct {
        corrected_search(
            search,
            &[PHOTO_KIND, "album"],
            term,
            |(data, albums, structured): &Found| {
                data.photo_ids.len() + albums.len() + structured.found()
            },
            |(exact, exact_albums, exact_legs), (again, again_albums, again_legs)| {
                (
                    photos::queries::SearchData {
                        photo_ids: filled(exact.photo_ids, again.photo_ids, limit, Clone::clone),
                    },
                    filled_targets(exact_albums, again_albums, limit.min(named::CONTAINER_ROWS)),
                    exact_legs.filled(again_legs),
                )
            },
            |term| run(door, &standing, search, term, limit),
        )?
    } else {
        let (exact, denial) = run(door, &standing, search, term, limit)?;
        ((exact, String::new()), denial)
    };
    let ((found, corrected), denial) = found;
    if let Some(denial) = denial {
        return Ok((
            (
                Searched {
                    ranked: Vec::new(),
                    albums: Vec::new(),
                    hits: photos::search::SearchHits::default(),
                    resting: photos::search::Resting::default(),
                },
                corrected,
            ),
            Some(denial),
        ));
    }
    let (data, albums, structured) = found;
    let names: Vec<Named> = albums
        .iter()
        .map(|target| Named {
            id: target.id.clone(),
            label: target.title.clone(),
        })
        .collect();
    let hits = photos::search::assemble(
        door,
        &standing,
        now_ms,
        limit,
        &data.photo_ids,
        &names,
        &structured,
    )?;
    Ok((
        (
            Searched {
                ranked: data.photo_ids,
                albums,
                hits,
                resting: photos::search::Resting::default(),
            },
            corrected,
        ),
        None,
    ))
}

/// Every leg at one term: the photographs, the albums, then the places, no
/// location and the labels. A denial answers for the whole search.
fn run(
    door: &VaultDoor<'_>,
    standing: &Standing,
    search: &dyn Search,
    term: &str,
    limit: usize,
) -> KitResult<(Found, Option<Denial>)> {
    let (data, denial) =
        photos::queries::load_search_term(door, standing, search, &Principal::Owner, term, limit)?;
    if denial.is_some() {
        return Ok(((data, Vec::new(), Structured::default()), denial));
    }
    let (albums, denial) = named::of_app(search, APP, term, limit.min(named::CONTAINER_ROWS));
    let structured = photos::search::structured_legs(door, standing, term)?;
    Ok(((data, albums, structured), denial))
}

/// `photos.duplicates`: the live library's near-duplicate clusters.
pub(crate) fn duplicates(door: &VaultDoor<'_>, now: &str) -> Result<Answer> {
    let loaded =
        photos::duplicate_clusters(door, now_ms(now)?, clustering).map(|clusters| (clusters, None));
    settle(door, loaded, |clusters| {
        Answer::PhotosDuplicates(wire::PhotosDuplicates {
            clusters: clusters
                .into_iter()
                .map(|cluster| wire::PhotosDuplicateCluster {
                    key: cluster.key,
                    photo_ids: {
                        let mut ids: Vec<String> = cluster
                            .photos
                            .into_iter()
                            .map(|photo| photo.photo_id)
                            .collect();
                        ids.sort_unstable();
                        ids
                    },
                    members: cluster.cells.iter().map(cell).collect(),
                })
                .collect(),
        })
    })
}
