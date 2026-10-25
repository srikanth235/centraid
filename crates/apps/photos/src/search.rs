//! `search`'s STRUCTURED LEGS and the answer they make with the text legs (#1135).
//!
//! The vault's full-text index answers two legs of Photos' search: the photographs
//! (a caption, a place's name and locality, the text recognised in the picture) and
//! the albums. Three legs are not text in the index and used to be folded by the
//! shell: **the places** a word names (a place's name or its gazetteer city), **no
//! location** (the member asked for the photographs that have none) and **the
//! labels** a word names that are on a live photograph. This module is those
//! legs, the counts that stand above the grid, and the grid itself: the live
//! photographs any leg reaches, dated newest first and then the undated.
//!
//! ## What counts
//!
//! * a photograph is a hit when it is **live** (`Standing::is_live`): the archive is
//!   not searched, and an edit's original is not offered beside the edit;
//! * a place's, an album's and the no-location bucket's count is the shelf it opens:
//!   a place's live photographs, an album's members that are not in the trash;
//! * of the places a word names, three stand above the grid, then the no-location
//!   bucket if asked for and not empty, then three albums.
//!
//! ## The resting state
//!
//! With nothing typed the search suggests what could be typed: the places that hold
//! a live photograph and the labels on one.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::MAX_PAGE_ROWS;
use centraid_apps_kit::reads::{PageDoor, Read, read_pages};
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::rules::{LIBRARY_WALK, Standing};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::cells::{CHUNK, PhotoCell, read_cells};
use crate::overview::Census;
use crate::places::{PlaceRow, printable_name, read_places};

/// How many of each kind stand above the grid.
pub const PER_KIND_CAP: usize = 3;
/// How many labels a word may name.
pub const LABEL_LIMIT: usize = 50;
/// How many suggestions the resting state offers of each kind.
pub const VOCABULARY_LIMIT: usize = 12;
/// The most hits one answer carries as cells.
pub const HIT_CEILING: usize = MAX_PAGE_ROWS;

/// A place, an album or a label by the name it was found under.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Named {
    pub id: String,
    pub label: String,
}

/// What the three structured legs found for a term.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Structured {
    /// The places the words name, by name (all of them; the answer caps).
    pub places: Vec<Named>,
    /// The member asked for the photographs that have no place.
    pub unplaced: bool,
    /// The labels the words name that are on a live photograph.
    pub labels: Vec<Named>,
    /// Each label's live photographs.
    pub tagged: BTreeMap<String, Vec<String>>,
}

impl Structured {
    /// Whether no leg found anything.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.places.is_empty() && !self.unplaced && self.labels.is_empty()
    }

    /// How many things the legs found, for "was this answer thin".
    #[must_use]
    pub fn found(&self) -> usize {
        self.places.len() + usize::from(self.unplaced) + self.labels.len()
    }

    /// This leg's findings, then the other's that this did not find. Order within
    /// each is kept; nothing found here is dropped.
    #[must_use]
    pub fn filled(mut self, again: Self) -> Self {
        for place in again.places {
            if !self.places.contains(&place) {
                self.places.push(place);
            }
        }
        self.unplaced |= again.unplaced;
        for label in again.labels {
            if !self.labels.contains(&label) {
                self.labels.push(label);
            }
        }
        self.tagged.extend(again.tagged);
        self
    }
}

const STOPWORDS: [&str; 12] = [
    "a", "an", "and", "at", "for", "from", "in", "of", "on", "the", "to", "with",
];

/// The words a query is matched by: lower-cased letters and digits, two or more of
/// them, no stopword, each once; a query with none is itself, lower-cased.
#[must_use]
pub fn tokens(query: &str) -> Vec<String> {
    let lowered = query.trim().to_lowercase();
    if lowered.is_empty() {
        return Vec::new();
    }
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    for character in lowered.chars().chain(std::iter::once(' ')) {
        if character.is_alphanumeric() {
            word.push(character);
        } else if !word.is_empty() {
            let finished = std::mem::take(&mut word);
            if finished.chars().count() >= 2
                && !STOPWORDS.contains(&finished.as_str())
                && !words.contains(&finished)
            {
                words.push(finished);
            }
        }
    }
    if words.is_empty() {
        vec![lowered]
    } else {
        words
    }
}

fn matches_any(text: &str, words: &[String]) -> bool {
    let lowered = text.to_lowercase();
    words.iter().any(|word| lowered.contains(word.as_str()))
}

const NO_LOCATION_TERMS: [&str; 3] = ["no location", "no place", "unlocated"];

/// Whether the member asked for the photographs that have no place: what they
/// typed is part of "no location" or contains it.
#[must_use]
pub fn no_location_asked(query: &str) -> bool {
    let asked = query.trim().to_lowercase();
    !asked.is_empty()
        && NO_LOCATION_TERMS
            .iter()
            .any(|term| term.contains(&asked) || asked.contains(term))
}

fn place_label(place: &PlaceRow) -> Option<String> {
    printable_name(Some(&place.name))
        .map(str::to_owned)
        .or_else(|| {
            place
                .gazetteer
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        })
}

fn matching_places(places: &[PlaceRow], words: &[String]) -> Vec<Named> {
    let mut matched: Vec<Named> = places
        .iter()
        .filter(|place| {
            printable_name(Some(&place.name)).is_some_and(|name| matches_any(name, words))
                || place
                    .gazetteer
                    .as_deref()
                    .is_some_and(|city| matches_any(city.trim(), words))
        })
        .filter_map(|place| {
            Some(Named {
                id: place.place_id.clone(),
                label: place_label(place)?,
            })
        })
        .collect();
    matched.sort_by(|left, right| {
        left.label
            .to_lowercase()
            .cmp(&right.label.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    matched
}

/// The live photographs among `ids`: those with a photograph row that the verdict
/// admits.
fn live_among(door: &dyn PageDoor, standing: &Standing, ids: &[String]) -> KitResult<Vec<String>> {
    let candidates: Vec<String> = ids
        .iter()
        .filter(|id| standing.is_live(id))
        .cloned()
        .collect();
    let mut out = Vec::new();
    for chunk in candidates.chunks(CHUNK) {
        let fragment = centraid_apps_kit::reads::in_list("id", chunk)?;
        out.extend(
            door.page(
                &PageQuery::new(
                    "photos.search.live",
                    "id, blob",
                    "photo",
                    PageOrder::asc("blob", "id"),
                )
                .filter(&fragment.sql, fragment.bind),
                &centraid_apps_kit::PageRequest::first(CHUNK),
            )?
            .rows
            .iter()
            .filter_map(|row| text_of(row, "id")),
        );
    }
    Ok(out)
}

/// Every label the member has made, by name: the vocabulary of tags.
fn tag_entities(door: &dyn PageDoor) -> KitResult<Vec<Named>> {
    Ok(read_pages(
        door,
        &PageQuery::new(
            "photos.search.tags",
            "id, title",
            "entity",
            PageOrder::asc("title", "id"),
        )
        .filter(
            "kind = ? AND deleted_at IS NULL",
            vec![PageBindValue::Text("tag".to_owned())],
        ),
        LIBRARY_WALK,
    )?
    .iter()
    .filter_map(|row| {
        let label = text_of(row, "title")?;
        let label = label.trim().to_owned();
        (!label.is_empty()).then(|| Named {
            id: text_of(row, "id").unwrap_or_default(),
            label,
        })
    })
    .collect())
}

/// The live photographs each of these tags is on.
fn tagged_live(
    door: &dyn PageDoor,
    standing: &Standing,
    concepts: &[String],
) -> KitResult<BTreeMap<String, Vec<String>>> {
    let edges = Read {
        name: "photos.search.tagged",
        table: "edge",
        select: "from_id, to_id",
        order: ("to_id", "from_id"),
        column: "to_id",
    }
    .among(
        LIBRARY_WALK,
        door,
        concepts,
        Some(("rel = ?", vec![PageBindValue::Text("tagged".to_owned())])),
    )?;
    let from: Vec<String> = edges
        .iter()
        .filter_map(|edge| text_of(edge, "from_id"))
        .collect();
    let live: BTreeSet<String> = live_among(door, standing, &from)?.into_iter().collect();
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in &edges {
        if let (Some(from), Some(to)) = (text_of(edge, "from_id"), text_of(edge, "to_id"))
            && live.contains(&from)
        {
            out.entry(to).or_default().push(from);
        }
    }
    Ok(out)
}

/// Run the structured legs for `term`.
///
/// # Errors
/// The door's refusal, or a walk past the library's bound.
pub fn structured_legs(
    door: &dyn PageDoor,
    standing: &Standing,
    term: &str,
) -> KitResult<Structured> {
    let words = tokens(term);
    if words.is_empty() {
        return Ok(Structured::default());
    }
    let places = matching_places(&read_places(door)?, &words);
    let named: Vec<Named> = tag_entities(door)?
        .into_iter()
        .filter(|tag| matches_any(&tag.label, &words))
        .collect();
    let ids: Vec<String> = named.iter().map(|tag| tag.id.clone()).collect();
    let tagged = tagged_live(door, standing, &ids)?;
    let mut labels: Vec<Named> = named
        .into_iter()
        .filter(|tag| tagged.contains_key(&tag.id))
        .collect();
    labels.truncate(LABEL_LIMIT);
    let kept: BTreeSet<&str> = labels.iter().map(|label| label.id.as_str()).collect();
    let tagged = tagged
        .into_iter()
        .filter(|(id, _)| kept.contains(id.as_str()))
        .collect();
    Ok(Structured {
        places,
        unplaced: no_location_asked(term),
        labels,
        tagged,
    })
}

/// What a top hit opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitKind {
    Place,
    Unplaced,
    Album,
}

/// A place, the no-location bucket or an album, with the size of the shelf it opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopHit {
    pub kind: HitKind,
    /// The place's or the album's id; empty for the no-location bucket.
    pub id: String,
    pub label: String,
    pub count: usize,
}

/// What a search answers beyond the ranked ids.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SearchHits {
    /// The live photographs any leg reaches: dated newest first, then the undated.
    pub cells: Vec<PhotoCell>,
    /// How many photographs the legs reach, exactly; `cells` holds the first
    /// `limit` of them.
    pub total: usize,
    pub truncated: bool,
    pub top_hits: Vec<TopHit>,
    pub labels: Vec<Named>,
}

fn members_of(door: &dyn PageDoor, albums: &[String]) -> KitResult<BTreeMap<String, Vec<String>>> {
    let edges = Read {
        name: "photos.search.members",
        table: "edge",
        select: "from_id, to_id",
        order: ("from_id", "to_id"),
        column: "from_id",
    }
    .among(
        LIBRARY_WALK,
        door,
        albums,
        Some(("rel = ?", vec![PageBindValue::Text("contains".to_owned())])),
    )?;
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in &edges {
        if let (Some(album), Some(photo)) = (text_of(edge, "from_id"), text_of(edge, "to_id")) {
            out.entry(album).or_default().push(photo);
        }
    }
    Ok(out)
}

fn photos_in_places(
    door: &dyn PageDoor,
    places: &[String],
) -> KitResult<BTreeMap<String, Vec<String>>> {
    let rows: Vec<Row> = Read {
        name: "photos.search.in_place",
        table: "photo",
        select: "id, place_id",
        order: ("place_id", "id"),
        column: "place_id",
    }
    .among(LIBRARY_WALK, door, places, None)?;
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in &rows {
        if let (Some(id), Some(place)) = (text_of(row, "id"), text_of(row, "place_id")) {
            out.entry(place).or_default().push(id);
        }
    }
    Ok(out)
}

fn unplaced_ids(door: &dyn PageDoor) -> KitResult<Vec<String>> {
    Ok(read_pages(
        door,
        &PageQuery::new(
            "photos.search.unplaced",
            "id, blob",
            "photo",
            PageOrder::asc("blob", "id"),
        )
        .filter("place_id IS NULL", Vec::new()),
        LIBRARY_WALK,
    )?
    .iter()
    .filter_map(|row| text_of(row, "id"))
    .collect())
}

/// Fold the legs into the answer: the counts above the grid and the grid.
///
/// `text_ids` are the full-text index's photographs in rank order; `albums` are its
/// albums. `limit` bounds the cells and is clamped to [`HIT_CEILING`].
///
/// # Errors
/// The door's refusal, or a walk past the library's bound.
pub fn assemble(
    door: &dyn PageDoor,
    standing: &Standing,
    now_ms: i64,
    limit: usize,
    text_ids: &[String],
    albums: &[Named],
    structured: &Structured,
) -> KitResult<SearchHits> {
    let place_ids: Vec<String> = structured
        .places
        .iter()
        .take(PER_KIND_CAP)
        .map(|place| place.id.clone())
        .collect();
    let in_place = photos_in_places(door, &place_ids)?;
    let live_in_place = |place: &str| -> Vec<String> {
        in_place
            .get(place)
            .into_iter()
            .flatten()
            .filter(|id| standing.is_live(id))
            .cloned()
            .collect()
    };
    let mut top_hits: Vec<TopHit> = structured
        .places
        .iter()
        .take(PER_KIND_CAP)
        .filter_map(|place| {
            let count = live_in_place(&place.id).len();
            (count > 0).then(|| TopHit {
                kind: HitKind::Place,
                id: place.id.clone(),
                label: place.label.clone(),
                count,
            })
        })
        .collect();
    let unplaced: Vec<String> = if structured.unplaced {
        unplaced_ids(door)?
            .into_iter()
            .filter(|id| standing.is_live(id))
            .collect()
    } else {
        Vec::new()
    };
    if structured.unplaced && !unplaced.is_empty() {
        top_hits.push(TopHit {
            kind: HitKind::Unplaced,
            id: String::new(),
            label: String::new(),
            count: unplaced.len(),
        });
    }
    top_hits.truncate(PER_KIND_CAP);
    let album_ids: Vec<String> = albums
        .iter()
        .take(PER_KIND_CAP)
        .map(|album| album.id.clone())
        .collect();
    let members = members_of(door, &album_ids)?;
    for album in albums.iter().take(PER_KIND_CAP) {
        top_hits.push(TopHit {
            kind: HitKind::Album,
            id: album.id.clone(),
            label: album.label.clone(),
            count: members
                .get(&album.id)
                .into_iter()
                .flatten()
                .filter(|id| standing.in_album_view(id))
                .count(),
        });
    }
    // The photographs the legs that stand above the grid reach, and the text's.
    let mut reached: BTreeSet<String> = text_ids.iter().cloned().collect();
    for hit in &top_hits {
        match hit.kind {
            HitKind::Place => reached.extend(live_in_place(&hit.id)),
            HitKind::Unplaced => reached.extend(unplaced.iter().cloned()),
            HitKind::Album => {
                reached.extend(members.get(&hit.id).into_iter().flatten().cloned());
            }
        }
    }
    for photos in structured.tagged.values() {
        reached.extend(photos.iter().cloned());
    }
    let reached: Vec<String> = reached.into_iter().collect();
    let live = live_among(door, standing, &reached)?;
    let mut cells = read_cells(door, standing, &live, now_ms)?;
    let mut ordered: Vec<PhotoCell> = live.iter().filter_map(|id| cells.remove(id)).collect();
    ordered.sort_by(crate::cells::timeline_order);
    let total = ordered.len();
    let limit = limit.clamp(1, HIT_CEILING);
    ordered.truncate(limit);
    Ok(SearchHits {
        cells: ordered,
        total,
        truncated: total > limit,
        top_hits,
        labels: structured.labels.clone(),
    })
}

/// What the search suggests with nothing typed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Resting {
    pub places: Vec<Named>,
    pub labels: Vec<Named>,
}

/// The places that hold a live photograph and the labels on one, by name.
///
/// # Errors
/// The door's refusal, or a walk past the library's bound.
pub fn resting(door: &dyn PageDoor, standing: &Standing) -> KitResult<Resting> {
    let census = Census::read(door, standing)?;
    let mut places: Vec<Named> = read_places(door)?
        .into_iter()
        .filter(|place| census.per_place.contains_key(&place.place_id))
        .filter_map(|place| {
            Some(Named {
                label: printable_name(Some(&place.name))?.to_owned(),
                id: place.place_id,
            })
        })
        .collect();
    places.sort_by(|left, right| {
        left.label
            .to_lowercase()
            .cmp(&right.label.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    places.truncate(VOCABULARY_LIMIT);
    let mut labels = Vec::new();
    for tag in tag_entities(door)? {
        if labels.len() >= VOCABULARY_LIMIT {
            break;
        }
        if !tagged_live(door, standing, std::slice::from_ref(&tag.id))?.is_empty() {
            labels.push(tag);
        }
    }
    Ok(Resting { places, labels })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_the_words_worth_matching() {
        assert_eq!(tokens("  The Beach at Pier-39 "), ["beach", "pier", "39"]);
        assert_eq!(tokens("a"), ["a"], "a query of nothing but noise is itself");
        assert_eq!(tokens("beach beach"), ["beach"]);
        assert!(tokens("   ").is_empty());
    }

    #[test]
    fn no_location_is_what_the_member_typed_a_part_of_or_containing() {
        assert!(no_location_asked("no loc"));
        assert!(no_location_asked("photos with no place"));
        assert!(no_location_asked("Unlocated"));
        assert!(!no_location_asked("paris"));
        assert!(!no_location_asked(" "));
    }
}
