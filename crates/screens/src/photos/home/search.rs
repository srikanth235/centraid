//! SEARCH, the bar under the title (R-CHROME-2): three screens behind one of
//! them. A member who has typed nothing and a member whose query matched nothing
//! must not read the same words, so the content is which one is showing.
//!
//! The core answers `photos.search` whole: the live photographs any leg reaches
//! (the caption, the text in the picture, the place's name, the labels, the
//! albums), the places and albums the words name as doors above the grid, the
//! labels they name, and a typo's correction (asked for always; the core corrects
//! only when every leg found nothing as typed). An empty term answers the resting
//! vocabulary instead: the places and labels this vault can be searched for.
//!
//! Loads are synchronous, so there is no late answer to drop and no frame to keep
//! while refining: the answer for the term on screen is the only one there is.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use super::super::cells::{self, Link};
use super::super::routes;
use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::kit::search as ask;
use crate::screen::Ctx;
use crate::strings::{Locale, fill, photos as words, photos_home as sentences};

/// The best this many photographs by rank; the door clamps to 500.
const LIMIT: u32 = 500;

#[derive(Debug, Default)]
pub enum Content {
    #[default]
    Resting,
    Failed,
    Hits,
}

#[derive(Debug, Default)]
pub struct Search {
    pub term: String,
    pub content: Content,
    answer: Option<wire::PhotosSearch>,
    resting: Option<wire::PhotosSearch>,
}

impl Search {
    pub fn set_term(&mut self, term: &str) {
        self.term = term.to_owned();
    }

    pub fn close(&mut self) {
        *self = Self::default();
    }

    fn active(&self) -> bool {
        !self.term.trim().is_empty()
    }

    /// Read what the field shows: the vocabulary when it is empty, the hits for
    /// the term otherwise.
    pub fn read(&mut self, ctx: &Ctx) {
        let blank = !self.active();
        let reading = read::read(
            ctx,
            load::photos::Search {
                correct: Some(1),
                limit: LIMIT,
                term: Some(if blank {
                    String::new()
                } else {
                    self.term.trim().to_owned()
                }),
            },
            |answer| match answer {
                Answer::PhotosSearch(found) => Some(found),
                _ => None,
            },
        );
        match reading {
            Reading::Data(found) => {
                if blank {
                    self.resting = Some(found);
                    self.answer = None;
                    self.content = Content::Resting;
                } else {
                    self.answer = Some(found);
                    self.content = Content::Hits;
                }
            }
            Reading::Denied(_) | Reading::Failed => {
                self.answer = None;
                self.content = Content::Failed;
            }
        }
    }

    /// The cells the answer reaches, for the lightbox's neighbours.
    #[must_use]
    pub fn cells(&self) -> &[wire::PhotosCell] {
        self.answer.as_ref().map_or(&[], |found| &found.cells)
    }

    #[must_use]
    pub fn view(&self, locale: Locale, link: Link) -> wire::PhotosSearchView {
        let term = self.term.trim();
        let mut view = wire::PhotosSearchView {
            query: self.term.clone(),
            ..wire::PhotosSearchView::default()
        };
        view.content = Some(match (&self.content, &self.answer) {
            (Content::Failed, _) => {
                wire::photos_search_view::Content::Failure(read::failure(locale))
            }
            (_, Some(found)) if !term.is_empty() => {
                if !found.corrected.is_empty() {
                    view.corrected = ask::corrected(locale, &found.corrected);
                }
                view.ask = Some(ask::offer(locale, term, "photos"));
                wire::photos_search_view::Content::Hits(Box::new(hits(locale, link, term, found)))
            }
            _ => wire::photos_search_view::Content::Resting(self.resting_view(locale)),
        });
        view
    }

    fn resting_view(&self, locale: Locale) -> wire::PhotosSearchResting {
        let found = self.resting.as_ref();
        let word = |named: &wire::PhotosNamed, place: bool| wire::PhotosSearchWord {
            id: named.id.clone(),
            label: named.label.clone(),
            route: place
                .then(|| routes::shelf(wire::PhotosShelfKind::Place, &named.id, &named.label)),
        };
        wire::PhotosSearchResting {
            hint: words::photos_search_hint(locale),
            places_title: sentences::library_search_places(locale),
            labels_title: sentences::library_search_labels(locale),
            places: found
                .map(|f| f.resting_places.iter().map(|p| word(p, true)).collect())
                .unwrap_or_default(),
            labels: found
                .map(|f| f.resting_labels.iter().map(|l| word(l, false)).collect())
                .unwrap_or_default(),
        }
    }
}

fn hits(
    locale: Locale,
    link: Link,
    term: &str,
    found: &wire::PhotosSearch,
) -> wire::PhotosSearchHits {
    let tiles = cells::tiles(&found.cells, link, locale);
    let ids: Vec<String> = tiles.iter().map(|tile| tile.photo_id.clone()).collect();
    let doors: Vec<wire::PhotosSearchDoor> =
        found.top_hits.iter().map(|hit| door(locale, hit)).collect();
    let labels: Vec<wire::PhotosSearchWord> = found
        .labels
        .iter()
        .map(|label| wire::PhotosSearchWord {
            id: label.id.clone(),
            label: label.label.clone(),
            route: None,
        })
        .collect();
    let mut matched: Vec<String> = found
        .top_hits
        .iter()
        .filter(|hit| !hit.label.is_empty())
        .map(|hit| hit.label.clone())
        .collect();
    matched.extend(found.labels.iter().map(|label| label.label.clone()));
    let empty = (found.cells.is_empty() && found.top_hits.is_empty()).then(|| {
        let sentence = fill(
            &words::photos_search_no_match_query(locale),
            &[("query", term)],
        );
        wire::EmptyState {
            headline: words::photos_search_no_results(locale),
            body: format!("{sentence} {}", words::photos_search_no_match_scope(locale)),
            ..wire::EmptyState::default()
        }
    });
    wire::PhotosSearchHits {
        doors,
        count_label: cells::count_phrase(locale, found.total_hits, found.truncated),
        open: Some(routes::lightbox("", &ids, "")),
        tiles,
        empty,
        labels_title: sentences::library_search_labels(locale),
        labels,
        matched_label: if matched.is_empty() {
            String::new()
        } else {
            fill(
                &words::photos_search_matched(locale),
                &[("matches", &matched.join(", "))],
            )
        },
    }
}

fn door(locale: Locale, hit: &wire::PhotosTopHit) -> wire::PhotosSearchDoor {
    use wire::photos_top_hit::Kind;
    let kind = Kind::try_from(hit.kind).unwrap_or(Kind::Unspecified);
    let (label, kind_label, icon, route) = match kind {
        Kind::Album => (
            hit.label.clone(),
            words::photos_album(locale),
            "album",
            routes::shelf(wire::PhotosShelfKind::Album, &hit.id, &hit.label),
        ),
        Kind::Unplaced => (
            sentences::library_search_no_location(locale),
            words::photos_place(locale),
            "place",
            routes::shelf(wire::PhotosShelfKind::Unplaced, "", ""),
        ),
        _ => (
            hit.label.clone(),
            words::photos_place(locale),
            "place",
            routes::shelf(wire::PhotosShelfKind::Place, &hit.id, &hit.label),
        ),
    };
    let count_label = cells::count_phrase(locale, hit.count, false);
    wire::PhotosSearchDoor {
        accessibility_label: format!("{kind_label}, {label}, {count_label}"),
        label,
        kind_label,
        count_label,
        icon_key: icon.to_owned(),
        route: Some(route),
    }
}
