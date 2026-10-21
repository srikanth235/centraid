//! THE PLACES FACET, and it stays inside Photos (D-1020-P5).
//!
//! There is no `crates/apps/places`. Places is not an app: it is a facet of the
//! library — a `place` entity joined into the library and search reads, a shelf
//! that groups by it, and the phrase logic that keeps a location a **phrase**
//! rather than a coordinate. A place's name is the entity's title, so
//! `entity.retitle` names one; its `locality` is the offline gazetteer's nearest
//! city, written by `place.locate` alone, so a rename never touches it (#1135).
//!
//! ## A location is a phrase before it is a pin
//!
//! The three rungs, in order:
//!
//! 1. the member's own name for the place;
//! 2. `near <locality>`;
//! 3. a phrase relative to the nearest named place (`4 km NW of The cabin`);
//! 4. "A place with no name yet".
//!
//! A place has no kind (home, work, …): the model keeps what the code
//! interprets and nothing code reads needs one, so the relative rung measures
//! from the nearest named place and does not prefer a home (R-1135-5-3).
//!
//! **The text is never coordinate-shaped, for any input.** A name that reads as
//! `"37.7955, -122.3937"` is refused at rung 1 by [`printable_name`], which is why
//! a coordinate-labelled place (the title a photograph's coordinates found it
//! under, before anyone named it) cannot leak its digits through the phrase.

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{FanOutBound, PageDoor, Read, read_pages};
use centraid_apps_kit::row::{Cell, Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

/// Must stay byte-identical to `shared-copy.ts`'s `PLACE_UNNAMED`.
pub const PLACE_NO_NAME: &str = "A place with no name yet";

/// One place, as the shelf and the grid read it: its entity and its row.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PlaceRow {
    pub place_id: String,
    pub name: String,
    /// `None`, never 0°,0° — the Gulf of Guinea is not "no location".
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    /// The gazetteer's nearest city, or `None` when it has not looked or found
    /// nothing.
    pub gazetteer: Option<String>,
    pub time_zone: Option<String>,
}

impl Eq for PlaceRow {}

impl PlaceRow {
    /// A place's entity and its `place` row.
    #[must_use]
    pub fn of(entity: &Row, place: &Row) -> Option<Self> {
        let real = |column: &str| -> Option<f64> {
            match place.get(column) {
                Some(Cell::Real(value)) => Some(*value),
                #[expect(
                    clippy::cast_precision_loss,
                    reason = "a coordinate stored as an integer degree is exact in f64"
                )]
                Some(Cell::Integer(value)) => Some(*value as f64),
                _ => None,
            }
        };
        Some(Self {
            place_id: text_of(entity, "id")?,
            name: text_of(entity, "title")?,
            lat: real("lat"),
            lng: real("lon"),
            gazetteer: text_of(place, "locality").filter(|text| !text.trim().is_empty()),
            time_zone: text_of(place, "zone"),
        })
    }
}

/// `photos.shared.places` — the places are owner-shaped and small, so a walk with
/// a stated ceiling rather than a window nobody chose.
#[must_use]
pub fn places_statement() -> PageQuery {
    PageQuery::new(
        "photos.shared.places",
        "id, title",
        "entity",
        PageOrder::asc("id", "id"),
    )
    .filter(
        "kind = ? AND deleted_at IS NULL",
        vec![PageBindValue::Text("place".to_owned())],
    )
}

/// Every live place, with its row.
pub fn read_places(door: &dyn PageDoor) -> KitResult<Vec<PlaceRow>> {
    let entities = read_pages(door, &places_statement(), FanOutBound::new(500, 8))?;
    let ids: Vec<String> = entities
        .iter()
        .filter_map(|row| text_of(row, "id"))
        .collect();
    let rows = Read {
        name: "photos.shared.place_rows",
        table: "place",
        select: "id, lat, lon, locality, zone",
        order: ("id", "id"),
        column: "id",
    }
    .within(FanOutBound::new(500, 8), door, &ids, None)?;
    Ok(entities
        .iter()
        .filter_map(|entity| {
            let id = text_of(entity, "id")?;
            let place = rows
                .iter()
                .find(|row| text_of(row, "id").as_deref() == Some(id.as_str()))?;
            PlaceRow::of(entity, place)
        })
        .collect())
}

/// A name a phrase may print: non-empty, and **not coordinate-shaped**.
#[must_use]
pub fn printable_name(name: Option<&str>) -> Option<&str> {
    let text = name?.trim();
    if text.is_empty() || is_coordinate_label(text) {
        return None;
    }
    Some(text)
}

/// `/^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/`, without a regex engine.
#[must_use]
pub fn is_coordinate_label(text: &str) -> bool {
    let Some((left, right)) = text.split_once(',') else {
        return false;
    };
    signed_decimal(left) && signed_decimal(right.trim_start())
}

fn signed_decimal(text: &str) -> bool {
    let body = text.strip_prefix('-').unwrap_or(text);
    let Some((whole, fraction)) = body.split_once('.') else {
        return false;
    };
    (1..=3).contains(&whole.len())
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && !fraction.is_empty()
        && fraction.bytes().all(|byte| byte.is_ascii_digit())
}

/// Where a phrase came from, so a surface can say how sure it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlacePhraseSource {
    Member,
    Gazetteer,
    Relative,
    None,
}

/// A phrase and its provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacePhrase {
    pub text: String,
    pub source: PlacePhraseSource,
}

/// A named anchor a relative phrase can be measured from.
#[derive(Debug, Clone, PartialEq)]
pub struct NamedPlace {
    pub key: String,
    pub name: String,
    pub lat: f64,
    pub lng: f64,
}

impl NamedPlace {
    /// Every place row that has both a name and a coordinate.
    #[must_use]
    pub fn anchors(places: &[PlaceRow]) -> Vec<Self> {
        places
            .iter()
            .filter_map(|place| {
                Some(Self {
                    key: place.place_id.clone(),
                    name: printable_name(Some(&place.name))?.to_owned(),
                    lat: place.lat?,
                    lng: place.lng?,
                })
            })
            .collect()
    }
}

const EARTH_RADIUS_KM: f64 = 6_371.008_8;

/// Haversine, not the flat shortcut: phrases span hundreds of kilometres.
/// `NaN` for a non-finite input, **never 0** — zero would read as "here".
#[must_use]
pub fn distance_km(a_lat: f64, a_lng: f64, b_lat: f64, b_lng: f64) -> f64 {
    if !(a_lat.is_finite() && a_lng.is_finite() && b_lat.is_finite() && b_lng.is_finite()) {
        return f64::NAN;
    }
    let d_lat = (b_lat - a_lat).to_radians();
    let d_lng = (b_lng - a_lng).to_radians();
    let h = (d_lat / 2.0).sin().powi(2)
        + a_lat.to_radians().cos() * b_lat.to_radians().cos() * (d_lng / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_KM * h.sqrt().min(1.0).asin()
}

/// Initial bearing from `a` to `b`, in degrees clockwise from north.
#[must_use]
pub fn bearing_degrees(a_lat: f64, a_lng: f64, b_lat: f64, b_lng: f64) -> f64 {
    if !(a_lat.is_finite() && a_lng.is_finite() && b_lat.is_finite() && b_lng.is_finite()) {
        return f64::NAN;
    }
    let d_lng = (b_lng - a_lng).to_radians();
    let lat1 = a_lat.to_radians();
    let lat2 = b_lat.to_radians();
    let y = d_lng.sin() * lat2.cos();
    let x = lat1.cos() * lat2.sin() - lat1.sin() * lat2.cos() * d_lng.cos();
    (y.atan2(x).to_degrees() + 360.0) % 360.0
}

const COMPASS: [&str; 8] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/// The eight-point compass, or `None` for a bearing that is not a number.
#[must_use]
pub fn compass_point(bearing: f64) -> Option<&'static str> {
    if !bearing.is_finite() {
        return None;
    }
    let normalised = ((bearing % 360.0) + 360.0) % 360.0;
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the value is a rounded compass index in 0..=8 by construction"
    )]
    let index = ((normalised / 45.0).round() as usize) % 8;
    Some(COMPASS[index])
}

/// A distance a person would say out loud. 990 m rounds to 1000, and nobody
/// says that — so the metre rung stops below a kilometre.
#[must_use]
pub fn format_distance(km: f64) -> Option<String> {
    if !km.is_finite() || km < 0.0 {
        return None;
    }
    if km < 1.0 {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "km < 1 so the metre figure is at most 1000"
        )]
        let metres = ((km * 1000.0 / 50.0).round() as i64) * 50;
        if metres < 1000 {
            return Some(format!("{metres} m"));
        }
    }
    if km < 10.0 {
        return Some(format!("{km:.1} km"));
    }
    Some(format!("{} km", km.round()))
}

const AT_ANCHOR_KM: f64 = 0.1;
/// Past this a bearing is trivia, not a location.
const RELATIVE_MAX_KM: f64 = 250.0;

/// The relative rung: the nearest named place, its distance and its bearing.
#[must_use]
pub fn relative_phrase(lat: f64, lng: f64, anchors: &[NamedPlace]) -> Option<String> {
    if !(lat.is_finite() && lng.is_finite()) {
        return None;
    }
    let mut nearest: Option<(&NamedPlace, f64)> = None;
    for place in anchors {
        if printable_name(Some(&place.name)).is_none() {
            continue;
        }
        let km = distance_km(lat, lng, place.lat, place.lng);
        if km.is_finite() && nearest.is_none_or(|(_, held)| km < held) {
            nearest = Some((place, km));
        }
    }
    let (anchor, km) = nearest?;
    if km > RELATIVE_MAX_KM {
        return None;
    }
    let name = printable_name(Some(&anchor.name))?;
    if km <= AT_ANCHOR_KM {
        return Some(format!("At {name}"));
    }
    let distance = format_distance(km)?;
    let point = compass_point(bearing_degrees(anchor.lat, anchor.lng, lat, lng))?;
    Some(format!("{distance} {point} of {name}"))
}

/// What a phrase is built from.
#[derive(Debug, Clone, Default)]
pub struct PhraseInput<'a> {
    pub place_name: Option<&'a str>,
    pub gazetteer_name: Option<&'a str>,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub anchors: &'a [NamedPlace],
}

/// `placePhrase`, ported (`place-phrase.ts:169-192`). Total: it always answers.
#[must_use]
pub fn place_phrase(input: &PhraseInput<'_>) -> PlacePhrase {
    if let Some(member) = printable_name(input.place_name) {
        return PlacePhrase {
            text: member.to_owned(),
            source: PlacePhraseSource::Member,
        };
    }
    if let Some(gazetteer) = printable_name(input.gazetteer_name) {
        return PlacePhrase {
            text: format!("near {gazetteer}"),
            source: PlacePhraseSource::Gazetteer,
        };
    }
    if let (Some(lat), Some(lng)) = (input.lat, input.lng)
        && let Some(relative) = relative_phrase(lat, lng, input.anchors)
    {
        return PlacePhrase {
            text: relative,
            source: PlacePhraseSource::Relative,
        };
    }
    PlacePhrase {
        text: PLACE_NO_NAME.to_owned(),
        source: PlacePhraseSource::None,
    }
}

/// The ONE place digits are printed, behind an explicit member action.
#[must_use]
pub fn exact_location(lat: Option<f64>, lng: Option<f64>) -> Option<String> {
    let (lat, lng) = (lat?, lng?);
    (lat.is_finite() && lng.is_finite()).then(|| format!("{lat:.5}, {lng:.5}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CABIN: f64 = 37.4419;
    const CABIN_LNG: f64 = -122.143;

    fn anchors() -> Vec<NamedPlace> {
        vec![
            NamedPlace {
                key: "p-cabin".to_owned(),
                name: "The cabin".to_owned(),
                lat: CABIN,
                lng: CABIN_LNG,
            },
            NamedPlace {
                key: "p-embarcadero".to_owned(),
                name: "Embarcadero".to_owned(),
                lat: 37.7955,
                lng: -122.3937,
            },
        ]
    }

    #[test]
    fn the_member_name_outranks_the_gazetteer_and_the_gazetteer_the_bearing() {
        let anchors = anchors();
        let base = PhraseInput {
            gazetteer_name: Some("South Lake Tahoe"),
            lat: Some(38.9186),
            lng: Some(-120.0836),
            anchors: &anchors,
            ..PhraseInput::default()
        };
        assert_eq!(
            place_phrase(&PhraseInput {
                place_name: Some("Tallac trailhead"),
                ..base.clone()
            }),
            PlacePhrase {
                text: "Tallac trailhead".to_owned(),
                source: PlacePhraseSource::Member
            }
        );
        assert_eq!(place_phrase(&base).text, "near South Lake Tahoe".to_owned());
        let relative = place_phrase(&PhraseInput {
            gazetteer_name: None,
            ..base
        });
        assert_eq!(relative.source, PlacePhraseSource::Relative);
    }

    /// The text is never coordinate-shaped, for any input.
    #[test]
    fn a_coordinate_shaped_name_is_refused_at_every_rung() {
        assert!(is_coordinate_label("37.7955, -122.3937"));
        assert!(is_coordinate_label("-38.9,120.08"));
        assert!(!is_coordinate_label("Pier 39"));
        assert!(!is_coordinate_label("1234.5, 6.7"));
        let phrase = place_phrase(&PhraseInput {
            place_name: Some("37.7955, -122.3937"),
            gazetteer_name: Some("38.9,-120.0"),
            ..PhraseInput::default()
        });
        assert_eq!(phrase.source, PlacePhraseSource::None);
    }

    #[test]
    fn the_nearest_named_place_is_the_anchor() {
        let anchors = anchors();
        let phrase = relative_phrase(37.60, -122.25, &anchors).expect("a phrase");
        assert!(phrase.ends_with("of The cabin"), "{phrase}");
        let city = relative_phrase(37.80, -122.40, &anchors).expect("a phrase");
        assert!(city.ends_with("of Embarcadero"), "{city}");
    }

    #[test]
    fn a_bearing_past_the_cap_is_trivia_and_not_a_location() {
        let anchors = anchors();
        assert_eq!(relative_phrase(48.8566, 2.3522, &anchors), None);
    }

    #[test]
    fn at_the_anchor_is_a_sentence_and_not_a_zero_distance() {
        let anchors = anchors();
        assert_eq!(
            relative_phrase(CABIN, CABIN_LNG, &anchors).as_deref(),
            Some("At The cabin")
        );
    }

    #[test]
    fn distances_read_the_way_a_person_says_them() {
        assert_eq!(format_distance(0.02).as_deref(), Some("0 m"));
        assert_eq!(format_distance(0.4).as_deref(), Some("400 m"));
        assert_eq!(
            format_distance(0.99).as_deref(),
            Some("1.0 km"),
            "990 m rounds to 1000 and nobody says that"
        );
        assert_eq!(format_distance(3.148).as_deref(), Some("3.1 km"));
        assert_eq!(format_distance(41.6).as_deref(), Some("42 km"));
        assert_eq!(format_distance(f64::NAN), None);
    }

    #[test]
    fn a_non_finite_distance_is_not_a_zero() {
        assert!(distance_km(f64::NAN, 0.0, 0.0, 0.0).is_nan());
        assert_eq!(compass_point(f64::NAN), None);
    }

    #[test]
    fn the_exact_location_is_the_only_place_digits_are_printed() {
        assert_eq!(
            exact_location(Some(37.7955), Some(-122.3937)).as_deref(),
            Some("37.79550, -122.39370")
        );
        assert_eq!(exact_location(Some(37.0), None), None);
    }

    #[test]
    fn anchors_need_both_a_name_and_a_coordinate() {
        let places = vec![
            PlaceRow {
                place_id: "p-1".to_owned(),
                name: "The cabin".to_owned(),
                lat: Some(CABIN),
                lng: Some(CABIN_LNG),
                ..PlaceRow::default()
            },
            PlaceRow {
                place_id: "p-2".to_owned(),
                name: "Unlocated".to_owned(),
                ..PlaceRow::default()
            },
            PlaceRow {
                place_id: "p-3".to_owned(),
                name: "12.3400, 56.7800".to_owned(),
                lat: Some(12.34),
                lng: Some(56.78),
                ..PlaceRow::default()
            },
        ];
        let anchors = NamedPlace::anchors(&places);
        assert_eq!(anchors.len(), 1, "a coordinate is no name");
    }

    #[test]
    fn the_statement_names_what_the_row_reader_asks_for() {
        let query = places_statement();
        assert!(query.select.contains("id") && query.select.contains("title"));
        assert!(
            query
                .r#where
                .as_deref()
                .is_some_and(|text| text.contains("kind"))
        );
    }
}
