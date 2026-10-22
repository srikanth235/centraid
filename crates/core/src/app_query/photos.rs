//! PHOTOS' ARM OF THE APP QUERY (#1097, R-1097-25..27, #1135): `photos.search`,
//! the text and album legs of Photos' own search asked of the full-text door, and
//! `photos.duplicates`, the near-duplicate clusters.
//!
//! **WHAT MOVED HERE.** Photos' search was Kotlin `LIKE` over the caption. Its text
//! leg is now the photograph (`photo`: its caption, its place's name and
//! locality, the text recognised in the picture, in rank order) and its album leg
//! is the album container. The shell keeps the STRUCTURED legs (the places, the
//! labels) and folds them with this answer.
//!
//! **THE PHOTOGRAPHS ARE LIVE ONES.** A hit is a live photograph, and an archived
//! one is no hit (Photos' own shelf does not show one). Home's search keeps the
//! archived ones because it opens a photograph and does not draw a grid; the
//! difference is R-1097-25's and is held by
//! `centraid_apps_photos::queries::load_search_term`.
//!
//! **DUPLICATES ARE CLUSTERED HERE, AT READ.** The app reads the perceptual
//! hashes; the one clustering is `centraid_media::duplicates::cluster`, handed to
//! it, so there is exactly one and nothing is stored.
//!
//! **THE CORRECTION IS THE SHELL'S TO ASK FOR.** The core cannot see the shell's
//! structured legs, and a typo is corrected only when EVERY leg is empty. So the
//! request carries `correct` only when the shell's legs found nothing for the
//! term as typed; the core corrects over the vocabularies of the photograph
//! domain and the album container, runs its legs at the corrected words and
//! answers them with the words. The core does NOT drop a correction its own legs
//! found nothing at, because the shell's legs may find something at those words
//! (a mistyped place's name finds no caption); the shell keeps the correction
//! only if the whole answer is not empty. Places and labels are not corrected:
//! the vault holds no vocabulary of them in the index (a place is arithmetic on
//! a coordinate and a gazetteer name inside a JSON column, a label a concept the
//! shell reads through the page door).

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::Denial;
use centraid_apps_kit::error::KitResult;
use centraid_apps_photos as photos;
use centraid_apps_photos::queries::PHOTO_KIND;
use centraid_search::{Principal, Search};
use centraid_vault::Vault;

use super::{RecordingSearch, VaultDoor, corrected_search, filled, filled_targets, named, settle};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// The app a Photos album opens in.
const APP: &str = "photos";

/// What the core's legs answer for one term.
type Found = (photos::queries::SearchData, Vec<centraid_search::Target>);

pub(crate) fn search(
    vault: &Vault,
    door: &VaultDoor<'_>,
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
        Ok(Ok(answer(door, &search, &asked.term, limit, asked.correct)))
    })??;
    settle(door, loaded, |((data, albums), corrected)| {
        Answer::PhotosSearch(wire::PhotosSearch {
            asset_ids: data.photo_ids,
            albums: albums.into_iter().map(named::to_wire).collect(),
            corrected,
        })
    })
}

/// The exact term; and, when the shell allows it and the core's legs found a
/// thin answer and nothing was denied, the corrected words' rows after it.
fn answer(
    door: &VaultDoor<'_>,
    search: &dyn Search,
    term: &str,
    limit: usize,
    may_correct: bool,
) -> KitResult<((Found, String), Option<Denial>)> {
    if !may_correct {
        let (exact, denial) = run(door, search, term, limit)?;
        return Ok(((exact, String::new()), denial));
    }
    corrected_search(
        search,
        &[PHOTO_KIND, "album"],
        term,
        |(data, albums): &Found| data.photo_ids.len() + albums.len(),
        |(exact, exact_albums), (again, again_albums)| {
            (
                photos::queries::SearchData {
                    photo_ids: filled(exact.photo_ids, again.photo_ids, limit, Clone::clone),
                },
                filled_targets(exact_albums, again_albums, limit.min(named::CONTAINER_ROWS)),
            )
        },
        |term| run(door, search, term, limit),
    )
}

/// Both legs at one term: the photographs, then the albums. A denial answers for
/// the whole search.
fn run(
    door: &VaultDoor<'_>,
    search: &dyn Search,
    term: &str,
    limit: usize,
) -> KitResult<(Found, Option<Denial>)> {
    let (data, denial) =
        photos::queries::load_search_term(door, search, &Principal::Owner, term, limit)?;
    if denial.is_some() {
        return Ok(((data, Vec::new()), denial));
    }
    let (albums, denial) = named::of_app(search, APP, term, limit.min(named::CONTAINER_ROWS));
    Ok(((data, albums), denial))
}

/// `photos.duplicates`: the live library's near-duplicate clusters.
pub(crate) fn duplicates(door: &VaultDoor<'_>) -> Result<Answer> {
    use centraid_media::duplicates::{DUPLICATE_HAMMING_THRESHOLD, Fingerprint, cluster};

    let loaded = photos::duplicate_clusters(door, |prints| {
        let rows: Vec<Fingerprint> = prints
            .iter()
            .map(|print| Fingerprint {
                asset_id: print.photo_id.clone(),
                phash: print.phash.clone(),
                cluster_id: None,
            })
            .collect();
        cluster(&rows, DUPLICATE_HAMMING_THRESHOLD)
    })
    .map(|clusters| (clusters, None));
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
                })
                .collect(),
        })
    })
}
