//! THE PLACES FACET, and it stays inside Photos (D-1020-P5).
//!
//! There is no `crates/apps/places`. Places is not an app: it is a facet of the
//! library — `core_place` joined into the library and search reads, a shelf
//! that groups by it, and the phrase logic that keeps a location a **phrase**
//! rather than a coordinate. The gazetteer's writer is the automations lane's
//! `place-names` recipe through `media.set_place_gazetteer`, which carries **no
//! media bytes at all** (`docs/recognition-automations.md:69`); the member's
//! own name for a place is written by `media.name_place`, and a rename never
//! touches the derived address.
//!
//! ## A location is a phrase before it is a pin
//!
//! `place-phrase.ts:1-3` states the rule and the reason: in `"shared"` context
//! the relative rung is **skipped**, because "5.2 km NW of Home" hands a
//! stranger a bearing to the member's house. The four rungs, in order:
//!
//! 1. the member's own name for the place;
//! 2. `near <gazetteer name>`;
//! 3. a relative phrase against a named anchor — **private context only**;
//! 4. "A place with no name yet".
//!
//! **The text is never coordinate-shaped, for any input.** A name that reads
//! as `"37.7955, -122.3937"` is refused at rung 1 by [`printable_name`], which
//! is why a gazetteer that wrote digits into `name` cannot leak them through
//! the phrase.

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, read_pages};
use centraid_apps_kit::row::{Cell, Row, text_of};
use centraid_apps_kit::statement::{PageOrder, PageQuery};

/// Must stay byte-identical to `shared-copy.ts`'s `PLACE_UNNAMED`.
pub const PLACE_NO_NAME: &str = "A place with no name yet";

/// One `core_place` row, as the shelf and the grid read it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PlaceRow {
    pub place_id: String,
    pub name: String,
    /// `None`, never 0°,0° — the Gulf of Guinea is not "no location".
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub kind: Option<String>,
    /// The gazetteer's derived name, read out of `address_json`. `None` for a
    /// malformed blob: one bad address must not take the whole shelf down.
    pub gazetteer: Option<String>,
}

impl Eq for PlaceRow {}

impl PlaceRow {
    #[must_use]
    pub fn of(row: &Row) -> Option<Self> {
        let real = |column: &str| -> Option<f64> {
            match row.get(column) {
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
            place_id: text_of(row, "place_id")?,
            name: text_of(row, "name")?,
            lat: real("geo_lat"),
            lng: real("geo_lng"),
            kind: text_of(row, "kind"),
            gazetteer: gazetteer_name_from(text_of(row, "address_json").as_deref()),
        })
    }

    /// Whether this place is the member's home — the anchor a relative phrase
    /// prefers inside a town's span.
    #[must_use]
    pub fn is_home(&self) -> bool {
        self.kind.as_deref() == Some("home")
    }
}

/// `photos.shared.places` — the gazetteer is owner-shaped and small, so it is a
/// walk with a stated ceiling rather than a window nobody chose.
#[must_use]
pub fn places_statement() -> PageQuery {
    PageQuery::new(
        "photos.shared.places",
        "place_id, name, geo_lat, geo_lng, kind, address_json",
        "core_place",
        PageOrder::asc("place_id", "place_id"),
    )
}

/// Read the place list.
pub fn read_places(door: &dyn PageDoor) -> KitResult<Vec<PlaceRow>> {
    Ok(
        read_pages(door, &places_statement(), crate::queries::ASSET_JOIN_BOUND)?
            .iter()
            .filter_map(PlaceRow::of)
            .collect(),
    )
}

/// `core_place.address_json` → `{ gazetteer: { name } }`.
///
/// `{ none: true }` is a RESULT, not a name — the gazetteer looked and found
/// nothing, which is different from never having looked. Malformed shapes fall
/// through to `None` and never throw (`place-phrase.ts:196-216`).
#[must_use]
pub fn gazetteer_name_from(address_json: Option<&str>) -> Option<String> {
    let text = address_json?;
    if text.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(text).ok()?;
    let name = parsed.get("gazetteer")?.get("name")?.as_str()?.trim();
    (!name.is_empty()).then(|| name.to_owned())
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

/// Private or shared. **The distinction is load-bearing**: see the module note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PhraseContext {
    #[default]
    Private,
    Shared,
}

/// A named anchor a relative phrase can be measured from.
#[derive(Debug, Clone, PartialEq)]
pub struct NamedPlace {
    pub key: String,
    pub name: String,
    pub lat: f64,
    pub lng: f64,
    pub is_home: bool,
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
                    is_home: place.is_home(),
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

/// How far from home a coordinate is, as a band.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeBand {
    AtHome,
    AroundTown,
    Away,
}

/// "At home", not "same place": deliberately looser than the vault's own
/// place-identity radius (`place-phrase.ts:108`).
pub const AT_HOME_KM: f64 = 0.5;
pub const AROUND_TOWN_KM: f64 = 25.0;
const AT_ANCHOR_KM: f64 = 0.1;
/// Home outranks a nearer anchor inside a town's span; beyond it nearest wins.
const HOME_ANCHOR_KM: f64 = 25.0;
/// Past this a bearing is trivia, not a location.
const RELATIVE_MAX_KM: f64 = 250.0;

#[must_use]
pub fn home_band(km: f64) -> Option<HomeBand> {
    if !km.is_finite() {
        return None;
    }
    Some(if km <= AT_HOME_KM {
        HomeBand::AtHome
    } else if km <= AROUND_TOWN_KM {
        HomeBand::AroundTown
    } else {
        HomeBand::Away
    })
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

/// The relative rung. The `"shared"` suppression lives in [`place_phrase`], not
/// here, so there is exactly one place that decides it.
#[must_use]
pub fn relative_phrase(lat: f64, lng: f64, anchors: &[NamedPlace]) -> Option<String> {
    if !(lat.is_finite() && lng.is_finite()) {
        return None;
    }
    let mut nearest: Option<(&NamedPlace, f64)> = None;
    let mut home: Option<(&NamedPlace, f64)> = None;
    for place in anchors {
        if printable_name(Some(&place.name)).is_none() {
            continue;
        }
        let km = distance_km(lat, lng, place.lat, place.lng);
        if !km.is_finite() {
            continue;
        }
        if nearest.is_none_or(|(_, held)| km < held) {
            nearest = Some((place, km));
        }
        if place.is_home && home.is_none_or(|(_, held)| km < held) {
            home = Some((place, km));
        }
    }
    let (anchor, km) = match home {
        Some((place, km)) if km <= HOME_ANCHOR_KM => (place, km),
        _ => nearest?,
    };
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
    pub context: PhraseContext,
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
    if input.context == PhraseContext::Private
        && let (Some(lat), Some(lng)) = (input.lat, input.lng)
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

// ---------------------------------------------------------------------------
// Sharing a place: `share-place.ts`.
// ---------------------------------------------------------------------------

/// How much of a place a copy carries. `None` is the default; silence reads as
/// safety and this is what makes it explicit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SharePrecision {
    #[default]
    None,
    Name,
    Exact,
}

/// The one phrase allowed off-device: hard-wires the shared context.
#[must_use]
pub fn shared_place_phrase(input: &PhraseInput<'_>) -> PlacePhrase {
    place_phrase(&PhraseInput {
        context: PhraseContext::Shared,
        ..input.clone()
    })
}

/// The name a share may carry, or `None` when there is none to carry.
#[must_use]
pub fn share_place_name(input: &PhraseInput<'_>) -> Option<String> {
    let phrase = shared_place_phrase(input);
    (phrase.source != PlacePhraseSource::None).then_some(phrase.text)
}

/// **`name` strips too**: words are no licence for the fix underneath.
#[must_use]
pub const fn share_place_strips_location(precision: SharePrecision) -> bool {
    !matches!(precision, SharePrecision::Exact)
}

/// Stated every time, `None` included.
#[must_use]
pub fn share_place_receipt(precision: SharePrecision, input: &PhraseInput<'_>) -> String {
    match precision {
        SharePrecision::Exact => "Sent with the exact location.".to_owned(),
        SharePrecision::Name => match share_place_name(input) {
            Some(name) => format!("Sent with the place name only — {name}."),
            None => "Sent with no location.".to_owned(),
        },
        SharePrecision::None => "Sent with no location.".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: f64 = 37.4419;
    const HOME_LNG: f64 = -122.143;

    fn anchors() -> Vec<NamedPlace> {
        vec![
            NamedPlace {
                key: "p-home".to_owned(),
                name: "Home".to_owned(),
                lat: HOME,
                lng: HOME_LNG,
                is_home: true,
            },
            NamedPlace {
                key: "p-embarcadero".to_owned(),
                name: "Embarcadero".to_owned(),
                lat: 37.7955,
                lng: -122.3937,
                is_home: false,
            },
        ]
    }

    /// THE RULE THIS FACET EXISTS FOR. A shared phrase never carries a bearing
    /// to the member's home.
    #[test]
    fn a_shared_phrase_skips_the_relative_rung() {
        let anchors = anchors();
        let input = PhraseInput {
            lat: Some(38.9186),
            lng: Some(-120.0836),
            anchors: &anchors,
            ..PhraseInput::default()
        };
        let private = place_phrase(&input);
        assert_eq!(private.source, PlacePhraseSource::Relative);
        let shared = shared_place_phrase(&input);
        assert_eq!(shared.source, PlacePhraseSource::None);
        assert_eq!(shared.text, PLACE_NO_NAME);
        assert_eq!(share_place_name(&input), None);
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
    fn home_outranks_a_nearer_anchor_inside_a_towns_span() {
        let anchors = anchors();
        // A point nearer the Embarcadero than Home, but inside the 25 km span.
        let phrase = relative_phrase(37.60, -122.25, &anchors).expect("a phrase");
        assert!(
            phrase.ends_with("of Home"),
            "home is the anchor inside a town: {phrase}"
        );
        // Tahoe is 200 km out: nearest wins and it is still under the cap.
        let far = relative_phrase(38.9186, -120.0836, &anchors).expect("a phrase");
        assert!(far.contains(" of "), "{far}");
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
            relative_phrase(HOME, HOME_LNG, &anchors).as_deref(),
            Some("At Home")
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
        assert_eq!(home_band(f64::NAN), None);
        assert_eq!(compass_point(f64::NAN), None);
    }

    #[test]
    fn the_gazetteer_reads_a_name_and_never_a_result() {
        assert_eq!(
            gazetteer_name_from(Some(r#"{"gazetteer":{"name":"Truckee"}}"#)).as_deref(),
            Some("Truckee")
        );
        assert_eq!(
            gazetteer_name_from(Some(r#"{"gazetteer":{"none":true}}"#)),
            None
        );
        assert_eq!(gazetteer_name_from(Some("{not json")), None);
        assert_eq!(gazetteer_name_from(Some("")), None);
        assert_eq!(gazetteer_name_from(None), None);
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
    fn a_name_only_share_still_strips_the_location_from_the_file() {
        assert!(share_place_strips_location(SharePrecision::Name));
        assert!(share_place_strips_location(SharePrecision::None));
        assert!(!share_place_strips_location(SharePrecision::Exact));
        let input = PhraseInput {
            place_name: Some("Sand Harbor"),
            ..PhraseInput::default()
        };
        assert_eq!(
            share_place_receipt(SharePrecision::Name, &input),
            "Sent with the place name only — Sand Harbor."
        );
        assert_eq!(
            share_place_receipt(SharePrecision::None, &input),
            "Sent with no location."
        );
    }

    #[test]
    fn anchors_need_both_a_name_and_a_coordinate() {
        let places = vec![
            PlaceRow {
                place_id: "p-1".to_owned(),
                name: "Home".to_owned(),
                lat: Some(HOME),
                lng: Some(HOME_LNG),
                kind: Some("home".to_owned()),
                gazetteer: None,
            },
            PlaceRow {
                place_id: "p-2".to_owned(),
                name: "Unlocated".to_owned(),
                lat: None,
                lng: None,
                kind: None,
                gazetteer: None,
            },
        ];
        let anchors = NamedPlace::anchors(&places);
        assert_eq!(anchors.len(), 1);
        assert!(anchors[0].is_home);
    }

    #[test]
    fn the_statement_selects_the_columns_the_row_reader_asks_for() {
        let query = places_statement();
        for column in [
            "place_id",
            "name",
            "geo_lat",
            "geo_lng",
            "kind",
            "address_json",
        ] {
            assert!(query.select.contains(column), "{column} is not selected");
        }
        assert_eq!(query.r#where, None);
    }
}
